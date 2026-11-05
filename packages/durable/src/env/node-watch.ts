// 文件导读
// 所属：packages/durable/src/env 的 Node 文件监视实现，是 NodeExecutionEnv.watch 的后端。
// 解决的问题：各平台的 fs.watch 都不可靠——macOS 在调用返回后的一小段时间可能丢事件；编辑器常用“写临时文件再
// rename”替换文件；目录可能被整体重命名或重建；Linux 的 recursive 支持因平台而异；Windows 打开目录会阻止父目录
// 重命名；网络/FUSE 文件系统可能根本不报告远端变化。这里不依赖事件细节：原生事件只触发去抖重扫，真正的变化由
// 快照差异和事件路径共同得出，新目录先装 watcher 再重扫，因此不依赖操作系统报告哪一类事件。
// 职责边界：只计算“哪些路径可能变了”并调用 onChange；不做资源加载、不跟随递归目标下的符号链接、不实现权限控制。
// 覆盖范围受 maxDirectories 限制：超出时 open 抛 FileError("invalid")，运行中增长则 watcher 以 failed 停止。
// 上下游：上游是 NodeExecutionEnv.watch（node.ts）→ NodeFileWatcher.open；下游是 fs.watch/lstat/statfs/readdir/
// readFile 与 crypto 哈希。结果 FileChange 传回宿主（例如 skills 资源加载器）触发重载。
// 能力清单：
// - NodeWatchOptions：强制 native/polling、轮询间隔、目录预算。
// - NodeFileWatcher：FileWatcher 实现；static open 建立覆盖，stop 停止，mode 报告可靠性。
// - 内部：#sync 重扫并装 watcher，#scan 生成快照，#diff 比较快照，#reconcileWatchers 增删 watcher，
//   #onEvent/#onLinkedFileEvent 处理原生事件，#switchToPolling 降级，anyUnreliable 检测不可靠文件系统。
// 组合顺序：open → 首次 scan + 装 watcher → 原生事件去抖 50ms → flush → sync(diff) → onChange({kind:"paths"})；
// polling 模式每 pollIntervalMs 做一次同样的比较；扫描无法继续时报 failed 并停止。
// 示例（真实签名，context 来自 @earendil-works/chord/context）：
//   const watcher = await NodeFileWatcher.open(
//     [{ path: "/work/skills", recursive: true, exclude: { hidden: true } }],
//     (path) => path,                  // 把目标路径解析成绝对路径
//     (change) => console.log(change), // { kind: "paths", paths: [...] } / overflow / failed
//     { pollIntervalMs: 1000 },
//   );
//   await watcher.stop(context);
// 建议阅读顺序：常量与 Entry/Snapshot 类型 → NodeFileWatcher 字段 → open/stop → #flush → #sync/#scan/#diff →
// #reconcileWatchers → 事件回调 → anyUnreliable。
import { createHash } from "node:crypto";
import { type FSWatcher, watch as fsWatch, type Stats } from "node:fs";
import { lstat, readdir, readFile, stat, statfs } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { type FileChange, FileError, type FileWatcher, type WatchTarget } from "./index.ts";

/** How `NodeExecutionEnv` watches. */
/** 监视器选项；都可由 NodeExecutionEnv 构造参数 watch 传入。 */
export interface NodeWatchOptions {
	/**
	 * Force a mode. By default `polling` is chosen on Windows, where native watchers keep directories open and so block
	 * renaming their parents, and for file systems that do not report remote changes.
	 */
	/** 强制选择模式；默认在 Windows 或不可靠文件系统上使用 polling，其余用 native。 */
	mode?: "native" | "polling";
	/** Interval between snapshots in `polling` mode; default 2000 ms. */
	/** polling 模式下两次快照的间隔（毫秒）；默认 2000。 */
	pollIntervalMs?: number;
	/** Most directories one watcher covers; default 10,000. */
	/** 一个 watcher 最多覆盖的目录数；默认 10 000，用于防止资源耗尽。 */
	maxDirectories?: number;
}

/** open 解析后的目标：绝对路径 + 递归标志 + 排除规则；names 用 Set 以便按名字 O(1) 过滤。 */
type ResolvedTarget = {
	readonly path: string;
	readonly recursive: boolean;
	readonly hidden: boolean;
	readonly names: ReadonlySet<string>;
};

/** 快照中一个路径的记录；目录和祖先只比较身份（kind/dev/ino），大小与时间被置 0。
 * hash 只在 polling 模式下对最近修改的小文件计算，用于识别“时间戳粒度内再次写入”。
 */
/** What a snapshot remembers of one path. Directories and ancestors are compared by identity only. */
type Entry = {
	readonly kind: "file" | "directory" | "symlink" | "other";
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly hash?: string;
};

/** 一次扫描的结果：绝对路径 → 该路径的记录。 */
type Snapshot = Map<string, Entry>;

/** 已安装的原生 watcher 及其安装对象的 dev/ino；路径被替换成另一个文件后必须重建 watcher。 */
/** A native watcher and the identity of what it was installed on: a path replaced by another file needs a new one. */
type Installed = { readonly watcher: FSWatcher; readonly dev: number; readonly ino: number };

/** 一次扫描的产物：快照，以及“目标是符号链接、链接到普通文件”的路径集合（这些文件需要单独监视）。 */
/** A scan: the snapshot, and targets that are symbolic links to files, whose files need their own watchers. */
type Scan = { readonly snapshot: Snapshot; readonly linkedFiles: ReadonlySet<string> };

/** 原生事件合并窗口：短时间内多个事件只触发一次重扫。 */
const DEBOUNCE_MS = 50;
/**
 * On macOS, `fs.watch` returns before libuv's FSEvents stream is live, and changes in between are never reported
 * (about 2% of changes made right after the call, none after 100 ms). A rescan this long after installing watchers
 * catches them.
 */
/** macOS 上安装 watcher 后再等这么久重扫一次，补上 FSEvents 流尚未生效期间漏掉的变化。 */
const FSEVENTS_SETTLE_MS = 500;
/** polling 模式默认间隔。 */
const DEFAULT_POLL_MS = 2000;
/** 默认目录预算。 */
const DEFAULT_MAX_DIRECTORIES = 10_000;
/** 共享的 overflow 变化对象；只读类型，消费者必须按不可变值对待。 */
/** The one `overflow` change; it carries nothing else. */
const OVERFLOW: FileChange = { kind: "overflow" };
/** polling 模式下对最近修改的小文件额外做内容哈希：文件系统时间戳粒度内的第二次写入可能不改变 size/mtime。 */
/** In polling mode, recently modified small files are also compared by content: a second write within the file system's
 * timestamp granularity can keep size and modification time. */
const HASH_MAX_BYTES = 256 * 1024;
const HASH_RECENT_MS = 5000;

/** Linux statfs 的 magic number：这些文件系统可能接受 watch 但不报告别处所做的变化。
 * 注释里的名字是常见来源；比较的是 f_type 数值，只在 Linux/Android 上使用。
 */
/** Linux `statfs` magic numbers of file systems that accept watches but do not report changes made elsewhere. */
const UNRELIABLE_FILE_SYSTEMS = new Set([
	0x6969, // NFS
	0x517b, // SMB
	0xff534d42, // CIFS
	0xfe534d42, // SMB2
	0x65735546, // FUSE (sshfs, Android shared storage)
	0x01021997, // 9P (WSL2 Windows drives)
	0x0bd00bd0, // Lustre
	0x47504653, // GPFS
	0x00c36400, // Ceph
	0x5346414f, // OpenAFS
	0x6b414653, // kAFS
	0x5dca2df5, // sdcardfs
]);

/** 内部信号：目录数超过预算；open 把它转成 FileError("invalid")，运行中则变成 failed 事件。 */
class BudgetExceeded extends Error {}

/** 类型谓词：把 unknown 收窄成带 code 的 Node 错误。
 * 运行时检查 instanceof Error && "code" in error；类型谓词只在编译期生效，code 的具体值仍需再判断。
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

/** 是否权限不足（EACCES/EPERM）；用于区分“目标不可读应报错”和“子目录跳过”。 */
function isDenied(error: unknown): boolean {
	return isNodeError(error) && (error.code === "EACCES" || error.code === "EPERM");
}

/** 把 fs.Stats 转成快照 Entry：归类 kind，目录不保留 size/mtime，哈希只在提供时加入。
 * 例：普通文件 5 字节 → { kind: "file", dev, ino, size: 5, mtimeMs, hash? }。
 */
function entryOf(stats: Stats, hash?: string): Entry {
	const kind = stats.isFile()
		? "file"
		: stats.isDirectory()
			? "directory"
			: stats.isSymbolicLink()
				? "symlink"
				: "other";
	return {
		kind,
		dev: stats.dev,
		ino: stats.ino,
		size: kind === "directory" ? 0 : stats.size,
		mtimeMs: kind === "directory" ? 0 : stats.mtimeMs,
		...(hash === undefined ? {} : { hash }),
	};
}

/** 判断两个快照记录是否完全相同：任一字段不同都算变化，包括 hash 从 undefined 变为字符串。 */
function sameEntry(a: Entry, b: Entry): boolean {
	return (
		a.kind === b.kind &&
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.size === b.size &&
		a.mtimeMs === b.mtimeMs &&
		a.hash === b.hash
	);
}

/** Ancestors of `path`, nearest first, up to the root. */
/** 返回 path 的祖先目录，最近的在前，直到文件系统根。
 * 例："/a/b" → ["/a", "/"]；根目录的 dirname 仍是自己，循环因此结束。
 */
function ancestorsOf(path: string): string[] {
	const result: string[] = [];
	for (let current = dirname(path); ; current = dirname(current)) {
		result.push(current);
		if (dirname(current) === current) return result;
	}
}

/** Whether `path` is `ancestor` or below it. */
/** path 是否等于 ancestor 或位于其下；用分隔符前缀判断，避免 "/a" 误匹配 "/ab"。
 * 根目录已经以分隔符结尾，所以不再追加，避免出现 "//"。
 */
function isWithin(path: string, ancestor: string): boolean {
	return path === ancestor || path.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep);
}

/** 单个条目名是否被目标排除：hidden 排除以 "." 开头的名字，names 精确匹配。 */
function excluded(target: ResolvedTarget, name: string): boolean {
	return (target.hidden && name.startsWith(".")) || target.names.has(name);
}

/** 基于快照的监视器：原生事件只触发去抖重扫，变化等于快照差异加上事件路径。
 * 被替换的文件、被重命名/重建的祖先、连同内容一起创建的目录都不依赖操作系统发送何种事件；
 * 新目录先安装 watcher 再重扫，所以 watcher 存在前写入的内容也能在下一次差异中看到。
 */
/**
 * Watches by snapshots: native events only trigger a debounced rescan, and changes are the difference between
 * snapshots plus the event paths. A replaced file, a renamed or recreated ancestor, or a directory created with its
 * contents therefore never depends on which events an operating system sends. New directories get their watchers
 * before they are scanned again, so nothing written into them before the watcher existed is missed.
 */
export class NodeFileWatcher implements FileWatcher {
	/** open 时解析好的目标，之后不再改变。 */
	readonly #targets: readonly ResolvedTarget[];
	/** 宿主回调；deliver 会吞掉它抛出的错误，避免一次异常终止监视。 */
	readonly #onChange: (change: FileChange) => void;
	/** polling 模式的快照间隔。 */
	readonly #pollIntervalMs: number;
	/** 目录预算。 */
	readonly #maxDirectories: number;
	/** 路径 → 已安装 watcher；键是安装时的路径，dev/ino 用来识别路径是否被替换。 */
	readonly #watchers = new Map<string, Installed>();
	/** 等待下次 flush 的事件路径；Set 去重，同一路径多次事件只保留一个。 */
	readonly #events = new Set<string>();
	/** 当前模式；资源不足时会从 native 降级为 polling，所以不是 readonly。 */
	#mode: "native" | "polling";
	/** 上一次成功扫描的快照，是 diff 的基准。 */
	#snapshot: Snapshot = new Map();
	/** 原生模式的去抖定时器，或 polling 模式的轮询定时器；两种模式不会同时使用。 */
	#timer: ReturnType<typeof setTimeout> | undefined;
	/** macOS 安装 watcher 后的补充重扫定时器。 */
	#settleTimer: ReturnType<typeof setTimeout> | undefined;
	/** 正在执行的 flush；用于单飞（single-flight）和 stop 时等待。 */
	#running: Promise<void> | undefined;
	/** flush 执行期间又收到事件时置位，循环会再扫一轮。 */
	#dirty = false;
	/** 终止标志；所有定时器和回调入口都先检查它。 */
	#stopped = false;

	/** 只由 static open 调用；这里只保存配置，不扫描也不装 watcher。 */
	private constructor(
		targets: readonly ResolvedTarget[],
		onChange: (change: FileChange) => void,
		mode: "native" | "polling",
		options: NodeWatchOptions,
	) {
		this.#targets = targets;
		this.#onChange = onChange;
		this.#mode = mode;
		this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
		this.#maxDirectories = options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
	}

	/** Establish coverage: watchers first, then the snapshot later changes are compared with. */
	/** 建立监视：解析目标、选择模式、首次扫描并安装 watcher；失败时关闭已装 watcher，目录超预算转成 FileError("invalid")，其他错误原样抛出。
	 * 返回时覆盖已经建立：之后宿主再加载资源，加载期间的变化不会漏掉。
	 * 例：await NodeFileWatcher.open([{ path: "AGENTS.md" }], (p) => resolve(p), onChange, {});
	 */
	static async open(
		targets: readonly WatchTarget[],
		resolvePath: (path: string) => string,
		onChange: (change: FileChange) => void,
		options: NodeWatchOptions,
	): Promise<NodeFileWatcher> {
		const resolved = targets.map((target) => ({
			path: resolvePath(target.path),
			recursive: target.recursive === true,
			hidden: target.exclude?.hidden === true,
			names: new Set(target.exclude?.names ?? []),
		}));
		// Windows refuses to rename a directory while another directory below it is open, and a native watcher keeps
		// every watched directory open: watching would break renames of their parents, so Windows polls.
		const mode =
			options.mode ??
			(process.platform === "win32" || (await anyUnreliable(resolved.map((target) => target.path)))
				? "polling"
				: "native");
		const watcher = new NodeFileWatcher(resolved, onChange, mode, options);
		try {
			await watcher.#sync(false);
		} catch (error) {
			watcher.#stop();
			if (error instanceof BudgetExceeded) throw new FileError("invalid", error.message);
			throw error;
		}
		watcher.#schedulePoll();
		return watcher;
	}

	/** 当前模式；可能在运行中因 watcher 资源不足降级为 polling。 */
	get mode(): "native" | "polling" {
		return this.#mode;
	}

	/** 停止监视：幂等；先标记停止并关闭资源，再等待正在进行的 flush 结束。
	 * 返回后不会再有新的 onChange 开始；context 在这里不参与取消。
	 */
	async stop(_context: Context): Promise<void> {
		if (this.#stopped) return;
		this.#stop();
		await this.#running;
	}

	/** 同步终止：置停止标志、清定时器、关闭所有原生 watcher；不等待 flush。 */
	#stop(): void {
		this.#stopped = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		clearTimeout(this.#settleTimer);
		this.#settleTimer = undefined;
		for (const { watcher } of this.#watchers.values()) watcher.close();
		this.#watchers.clear();
	}

	/** 投递变化；已停止时丢弃，回调抛错被吞掉（监视不能因宿主回调失败而停止）。 */
	#deliver(change: FileChange): void {
		if (this.#stopped) return;
		try {
			this.#onChange(change);
		} catch {
			// A throwing callback must not stop watching.
		}
	}

	/** polling 模式下安排下一次轮询；每轮无论 flush 成功与否都在 finally 中重新安排（已停止则不再安排）。 */
	#schedulePoll(): void {
		if (this.#stopped || this.#mode !== "polling") return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#flush().finally(() => this.#schedulePoll());
		}, this.#pollIntervalMs);
	}

	/** native 模式下把事件去抖：已有定时器时不再重复安排，50ms 后执行一次 flush。 */
	#scheduleFlush(): void {
		if (this.#stopped || this.#timer !== undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#flush();
		}, DEBOUNCE_MS);
	}

	/** macOS 专用：重置并安排安装 watcher 后的补充重扫。 */
	#scheduleSettle(): void {
		if (this.#stopped) return;
		clearTimeout(this.#settleTimer);
		this.#settleTimer = setTimeout(() => {
			this.#settleTimer = undefined;
			void this.#flush();
		}, FSEVENTS_SETTLE_MS);
	}

	/** 执行一次重扫并投递差异。单飞：已有 flush 时只置 dirty 并复用同一个 Promise。
	 * 循环处理“扫描期间又收到事件”的情况；扫描出错时投递 failed 并停止。
	 */
	#flush(): Promise<void> {
		if (this.#running !== undefined) {
			this.#dirty = true;
			return this.#running;
		}
		this.#running = (async () => {
			try {
				do {
					this.#dirty = false;
					const events = [...this.#events];
					this.#events.clear();
					const changed = await this.#sync(true);
					for (const path of events) changed.add(path);
					if (changed.size > 0) this.#deliver({ kind: "paths", paths: [...changed].sort() });
				} while (this.#dirty && !this.#stopped);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const fileError =
					error instanceof FileError
						? error
						: new FileError(isDenied(error) ? "permission_denied" : "invalid", message);
				this.#deliver({ kind: "failed", error: fileError });
				this.#stop();
			} finally {
				this.#running = undefined;
			}
		})();
		return this.#running;
	}

	/** Rescan, report differences, and install watchers for new directories, rescanning until none are new. */
	/** 重扫并协调 watcher，最多 10 轮：每轮扫描 → 比较 → 安装新目录的 watcher → 若新增则再扫一轮。
	 * report=false 用于 open 的第一次扫描（不向宿主报告启动前的变化）。返回本轮发现的差异路径。
	 */
	async #sync(report: boolean): Promise<Set<string>> {
		const changed = new Set<string>();
		for (let round = 0; round < 10 && !this.#stopped; round++) {
			const scan = await this.#scan();
			// Closed during the scan: installing watchers now would leak them.
			if (this.#stopped) break;
			const next = scan.snapshot;
			if (report) for (const path of this.#diff(this.#snapshot, next)) changed.add(path);
			this.#snapshot = next;
			if (this.#mode === "polling" || !this.#reconcileWatchers(scan)) break;
			if (process.platform === "darwin") this.#scheduleSettle();
			// Something written into a new directory before its watcher existed shows up in the next round.
			report = true;
		}
		return changed;
	}

	/** 比较两份快照：新增、字段变化、消失的路径都算变化；路径经 #reported 归一化后返回。 */
	#diff(previous: Snapshot, next: Snapshot): string[] {
		const changed: string[] = [];
		for (const [path, entry] of next) {
			const before = previous.get(path);
			if (before === undefined || !sameEntry(before, entry)) changed.push(this.#reported(path));
		}
		for (const path of previous.keys()) if (!next.has(path)) changed.push(this.#reported(path));
		return changed;
	}

	/** An ancestor that changed identity moved every target below it; report those targets. */
	/** 把变化的路径映射成对调用者有用的路径：目标范围内的路径原样报告；
	 * 若变化的是目标祖先（身份变了，可能移动了整个子树），则报告该目标路径。
	 */
	#reported(path: string): string {
		if (this.#targets.some((target) => isWithin(path, target.path))) return path;
		return this.#targets.find((target) => isWithin(target.path, path))?.path ?? path;
	}

	/** 扫描所有目标并生成快照；readdir/stat 失败按“目标必须可读、子项尽量跳过”的规则处理。
	 * 目录预算 counted 只计一次，但每个目标按自己的 recursion/exclude 独立遍历（traversed 按目标+目录去重）。
	 */
	async #scan(): Promise<Scan> {
		const snapshot: Snapshot = new Map();
		const linkedFiles = new Set<string>();
		// Directories are counted once, but traversed once per target: overlapping targets differ in recursion and
		// exclusions, and an entry recorded for one target must still be descended into for another.
		const counted = new Set<string>();
		const traversed = new Set<string>();
		/** Kinds of listed entries, not following links: a target that links to a directory is recorded by `stat`, but
		 * symbolic links below a recursive target are not followed. */
		const listed = new Map<string, Entry["kind"]>();
		const countDirectory = (path: string): void => {
			counted.add(path);
			if (counted.size > this.#maxDirectories) {
				throw new BudgetExceeded(`Watched paths exceed ${this.#maxDirectories} directories`);
			}
		};
		const record = async (path: string, stats: Stats): Promise<void> => {
			let hash: string | undefined;
			if (
				this.#mode === "polling" &&
				stats.isFile() &&
				stats.size <= HASH_MAX_BYTES &&
				Date.now() - stats.mtimeMs < HASH_RECENT_MS
			) {
				hash = await readFile(path).then(
					(content) => createHash("sha256").update(content).digest("hex"),
					() => undefined,
				);
			}
			snapshot.set(path, entryOf(stats, hash));
		};
		const scanDirectory = async (index: number, target: ResolvedTarget, directory: string): Promise<void> => {
			const key = `${index}\0${directory}`;
			if (traversed.has(key)) return;
			traversed.add(key);
			let names: string[];
			try {
				names = await readdir(directory);
			} catch (error) {
				// The watched directory itself must be readable; below it, unreadable directories are skipped.
				if (directory === target.path && isDenied(error)) throw error;
				if (isNodeError(error) && ["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(error.code ?? "")) return;
				throw error;
			}
			for (const name of names) {
				if (excluded(target, name)) continue;
				const path = `${directory.endsWith(sep) ? directory : directory + sep}${name}`;
				let kind = listed.get(path);
				if (kind === undefined) {
					const stats = await lstat(path).catch(() => undefined);
					if (stats === undefined) continue;
					kind = entryOf(stats).kind;
					listed.set(path, kind);
					// A target's own entry (following links) wins over its listing by another target.
					if (!snapshot.has(path)) await record(path, stats);
				}
				if (target.recursive && kind === "directory") {
					countDirectory(path);
					await scanDirectory(index, target, path);
				}
			}
		};
		for (const [index, target] of this.#targets.entries()) {
			for (const ancestor of ancestorsOf(target.path)) {
				if (snapshot.has(ancestor)) continue;
				const stats = await lstat(ancestor).catch(() => undefined);
				// Identity only: an ancestor's own timestamps change with every unrelated sibling.
				if (stats !== undefined) snapshot.set(ancestor, { ...entryOf(stats), size: 0, mtimeMs: 0 });
			}
			// The target itself may be a symbolic link to what is watched; follow it. A missing target is watched for its
			// creation; one that cannot be reached for lack of permission fails.
			let stats: Stats;
			try {
				stats = await stat(target.path);
			} catch (error) {
				if (isDenied(error)) throw error;
				continue;
			}
			await record(target.path, stats);
			if (stats.isFile() && (await lstat(target.path).catch(() => undefined))?.isSymbolicLink()) {
				linkedFiles.add(target.path);
			}
			if (stats.isDirectory()) {
				countDirectory(target.path);
				await scanDirectory(index, target, target.path);
			}
		}
		return { snapshot, linkedFiles };
	}

	/**
	 * Watch every existing ancestor of each target, each target directory, each target that is a symbolic link to a file
	 * (changes to that file are not events of the link's directory), and on Linux each directory below a recursive target
	 * (elsewhere one recursive watcher per target). Returns whether a watcher was added.
	 */
	/** 根据快照增删原生 watcher：目标祖先、目标目录、指向文件的符号链接都要覆盖；
	 * Linux/Android 上按目录逐个安装（不依赖平台的递归 watcher），所以递归目标下的每个目录各有一个 watcher。
	 * 返回是否新增了 watcher，供 #sync 决定是否再扫一轮。
	 */
	#reconcileWatchers({ snapshot, linkedFiles }: Scan): boolean {
		const wanted = new Map<string, boolean>();
		for (const path of linkedFiles) wanted.set(path, false);
		const perDirectory = process.platform === "linux" || process.platform === "android";
		for (const target of this.#targets) {
			for (const ancestor of ancestorsOf(target.path)) {
				if (snapshot.get(ancestor)?.kind === "directory" && !wanted.has(ancestor)) wanted.set(ancestor, false);
			}
			if (snapshot.get(target.path)?.kind !== "directory") continue;
			const recursiveRoot = target.recursive && !perDirectory;
			wanted.set(target.path, recursiveRoot);
			if (target.recursive && perDirectory) {
				for (const [path, entry] of snapshot) {
					if (entry.kind === "directory" && path !== target.path && isWithin(path, target.path)) {
						wanted.set(path, false);
					}
				}
			}
		}
		for (const [path, installed] of this.#watchers) {
			const entry = snapshot.get(path);
			// Gone, or replaced: a watcher follows the directory it was installed on, not the path.
			if (!wanted.has(path) || entry === undefined || entry.dev !== installed.dev || entry.ino !== installed.ino) {
				installed.watcher.close();
				this.#watchers.delete(path);
			}
		}
		let added = false;
		for (const [path, recursive] of wanted) {
			const entry = snapshot.get(path);
			if (this.#watchers.has(path) || entry === undefined) continue;
			const linked = linkedFiles.has(path);
			try {
				const watcher = fsWatch(path, { recursive, persistent: false }, (_event, filename) =>
					linked
						? this.#onLinkedFileEvent(path)
						: this.#onEvent(path, filename === null ? undefined : String(filename)),
				);
				// A watched directory that disappears or fails: rescan, which also replaces the watcher.
				watcher.on("error", () => {
					watcher.close();
					if (this.#watchers.get(path)?.watcher === watcher) this.#watchers.delete(path);
					this.#scheduleFlush();
				});
				this.#watchers.set(path, { watcher, dev: entry.dev, ino: entry.ino });
				added = true;
			} catch (error) {
				// Out of watches or unsupported: compare snapshots from now on, and say coverage was uncertain.
				if (isNodeError(error) && error.code !== "ENOENT" && error.code !== "EACCES" && error.code !== "EPERM") {
					this.#switchToPolling();
					return false;
				}
			}
		}
		return added;
	}

	/** 原生 watcher 资源不足时降级：关闭全部 watcher，先发 overflow 表示覆盖不确定，再启动轮询。 */
	#switchToPolling(): void {
		if (this.#mode === "polling") return;
		this.#mode = "polling";
		for (const { watcher } of this.#watchers.values()) watcher.close();
		this.#watchers.clear();
		this.#deliver(OVERFLOW);
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#schedulePoll();
	}

	/** 原生事件入口：拼出完整路径，过滤无关/被排除的条目，记录路径并安排去抖 flush。 */
	#onEvent(directory: string, filename: string | undefined): void {
		if (this.#stopped) return;
		const path =
			filename === undefined ? directory : `${directory.endsWith(sep) ? directory : directory + sep}${filename}`;
		// Events about unrelated siblings of an ancestor, or about excluded entries, are ignored.
		const relevant = this.#inScope(path);
		if (relevant) this.#events.add(this.#reported(path));
		if (relevant || filename === undefined) this.#scheduleFlush();
	}

	/** 目标符号链接指向的文件发生变化：报告目标本身（变化事件属于链接目录之外的另一个目录）。 */
	/** The file a target links to changed: report the target. */
	#onLinkedFileEvent(target: string): void {
		if (this.#stopped) return;
		this.#events.add(target);
		this.#scheduleFlush();
	}

	/** 路径是否落在某个目标的覆盖范围内：目标祖先、目标自身及其后代；
	 * 非递归目标只看直接子项，任一路径分量被排除则忽略。
	 */
	#inScope(path: string): boolean {
		for (const target of this.#targets) {
			if (isWithin(target.path, path)) return true;
			if (!isWithin(path, target.path) || path === target.path) continue;
			const components = relative(target.path, path).split(sep);
			if (!target.recursive && components.length > 1) continue;
			if (components.some((name) => excluded(target, name))) continue;
			return true;
		}
		return false;
	}
}

/** 路径或其最近的存在祖先是否位于不报告远端变化的文件系统；只在 Linux/Android 上检查 statfs。 */
/** Whether any path, or its nearest existing ancestor, is on a file system that does not report remote changes. */
async function anyUnreliable(paths: readonly string[]): Promise<boolean> {
	if (process.platform !== "linux" && process.platform !== "android") return false;
	for (const path of paths) {
		for (const candidate of [path, ...ancestorsOf(path)]) {
			const info = await statfs(candidate).catch(() => undefined);
			if (info === undefined) continue;
			if (UNRELIABLE_FILE_SYSTEMS.has(info.type)) return true;
			break;
		}
	}
	return false;
}
