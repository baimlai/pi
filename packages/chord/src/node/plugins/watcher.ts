// The watcher and its marks (slice 7c §5, slice 12 §4): `fs.watch` on every directory of the plugin roots and the app's
// base code, `node_modules` and `.git` never watched (a directory appearing later gets its watch), marks what changed and
// never applies it. A changed file dirties every plugin whose facets used it (a copied contract every user), whose
// directory contains it or which is a single-file plugin of it; a changed `package.json` asks for an install (and for
// its metadata to be read again); a plugin directory, a facet file or a single-file plugin's file added or removed asks
// for discovery again; a file of base code asks the app to restart its hosts. The
// marks are a JSON watchable; each mark records the generation of its latest change (generations only increase), so a
// change during a build keeps its mark, however late an older build's rollout clears.

// 文件导读
// 所属模块：packages/chord/src/node/plugins 的文件监视层，对应 slice 7c §5 与 slice 12 §4。
// 职责边界：用 fs.watch 监视插件根、应用基础代码（base）以及根外链接进来的插件目录；把变化记录成“标记”
// （dirty/install/set/base），绝不在这里构建、发现、安装或加载插件。目录树里的 node_modules 与 .git 既不监视也不标记。
// 上游入口：Plugins 组件在构造时 new PluginWatcher(options, batch)，之后调用 know/used/mark/snapshot/applied/
// installed/added/close；外部通过 Source.watch 订阅 value（PluginsState 的 JSON 快照）。
// 下游依赖：node:fs 的 watch/lstatSync/readdirSync/realpathSync/existsSync、node:path、state 的 Source/Batch、
// build.ts 的 inside/BuiltFacet、discover.ts 的 Discovery/Plugin/FACET_EXTENSIONS/sameFiles、BACKGROUND_CONTEXT。
// 结果与错误流向：监视事件只更新标记；value 是纯 JSON；监视失败通过 options.failed 上报一次并停止全部监视，
// 此后应用按需构建；fs.watch 的异步错误也走同一条路径。文件系统错误在回调内被捕获；options.failed 是应用代码，其自身异常不由 watcher 捕获。
// 能力清单：
// - PluginsState：dirty/install/set/base 四个标记的 JSON 形状。
// - MarkSnapshot：一次构建开始时各插件的标记代号，供 applied 判断能否清除。
// - DiscoverySnapshot：一次发现开始时 set/manifest 的代号。
// - WatcherOptions：roots/base/kinds 与 failed 回调。
// - IGNORED：永不监视、永不标记的目录名集合。
// - PluginWatcher：继承 Source，负责监视、标记、快照、清除与发布。
// - owns(plugin, path)：判断路径是否属于某插件（目录内或单文件插件的文件）。
// - isDirectory(path)：不跟随链接、不抛错地判断目录。
// - real(dir)：解析真实路径，目录不存在时退回 resolve。
// 组合与顺序：constructor -> #watchTree（根与 base）-> know（发现结果与代号）-> used（每次构建后登记输入）-> 文件事件 mark
// -> #markPlugin 更新 dirty/install/set/base -> value 在微任务里合并发布；构建开始 snapshot，滚动完成 applied 清除
// 未再变化的标记；安装完成 installed，安装新插件后 added。
// 示例：const watcher = new PluginWatcher({ roots: [root], base: [base], kinds: ["worker"], failed: (error) => log(error) }, batch);
// watcher.know(await discoverPlugins([root], { kinds: ["worker"] }, context), watcher.discoverySnapshot());
// watcher.used([built]); watcher.mark(join(root, "notes", "worker.ts")); console.log(watcher.value); watcher.close();
// 真实签名如此；built 来自 buildFacet，batch 由宿主/状态层构造，mark 的路径是绝对路径。
// 相关测试：packages/chord/test/node/plugins/watcher.test.ts。
// 建议阅读顺序：PluginsState/MarkSnapshot/DiscoverySnapshot/WatcherOptions -> 字段与 constructor -> value/deliver ->
// know/used -> snapshot/applied/installed/added/mark -> #markPlugin/#isFacetFile -> #watchDirs/#changedIn/#unwatchDirs ->
// #failed/#changed -> owns/isDirectory/real。
import { type Dirent, existsSync, type FSWatcher, lstatSync, readdirSync, realpathSync, watch } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import { type Batch, Source } from "../../state/internal.ts";
import { type BuiltFacet, inside } from "./build.ts";
import { type Discovery, FACET_EXTENSIONS, type Plugin, sameFiles } from "./discover.ts";

/** The marks: plugins to rebuild, plugins to install, whether to discover again, whether base code changed. */
// watcher 对外发布的全部标记；它是可 JSON 序列化的普通对象，不是事件日志。各数组按名字排序，便于比较与测试。
export type PluginsState = {
	// 需要重建的插件名。任何使用过被改文件的插件、文件所在插件，以及单文件插件自身，都会进入这里。
	readonly dirty: readonly string[];
	// 需要重新安装依赖的插件名：其 package.json 变了，watcher 只负责请求，不执行 npm。
	readonly install: readonly string[];
	// 是否需要重新执行发现：插件目录/顶层 facet 文件/单文件插件文件增删，或 package.json 变化时置位。
	readonly set: boolean;
	// base 代码是否变化；应用据此重启宿主，watcher 不判断如何重启。
	readonly base: boolean;
};

/** The generation of each dirty plugin's latest change when a build started: what its rollout may clear. */
// 构建开始时每个待构建插件的 dirty 代号；代号 0 表示当时没有 dirty 标记。
// 这些值只在本进程内有意义，用于 applied 的“标记之后有没有新变化”比较，不是持久化版本号。
export type MarkSnapshot = { readonly plugins: ReadonlyMap<string, number> };

/** The generations of the latest change of the plugin set and of a `package.json` when a discovery started. */
// 发现开始时 set 与 manifest 的代号；know 发现二者都没变才清零，否则保留给下一轮。
export type DiscoverySnapshot = { readonly set: number; readonly manifest: number };

/** What the watcher watches and how it reports: the roots, the base code, the facet kinds, a failure to watch. */
// 构造 watcher 的输入。roots 是插件根目录，base 是应用基础代码目录，kinds 用来识别插件顶层 facet 文件名。
export type WatcherOptions = {
	// 插件根目录（绝对或相对路径均可，构造时会解析真实路径）；每个根的整棵目录树都会被监视。
	readonly roots: readonly string[];
	// 应用基础代码目录；其中任何变化只置 base 标记，不归属到某个插件。
	readonly base: readonly string[];
	// 应用声明的 facet kind 名；与 FACET_EXTENSIONS 组合判断顶层文件是否为 facet 文件。
	readonly kinds: readonly string[];
	/** The watcher cannot watch (the system's limit): reported once, after which the app builds on demand. */
	// 监视系统失败（如 inotify 上限）时的回调；只调用一次，之后 watcher 关闭所有监视，应用按需构建。
	readonly failed: (error: unknown) => void;
};

/** Directories never watched, and changes under them never marked. */
// 任何路径段命中这些目录名就忽略：既不为它们建立监视，也不把其中的变化计入标记。
const IGNORED = new Set(["node_modules", ".git"]);

/**
 * The watcher and the marks (`state`), a JSON watchable published at most once per microtask turn with changes. It
 * marks for the plugins of the last discovery (`know`) and the files their last builds read (`used`).
 */
// 插件监视器：维护目录监视与标记，并作为 Source 把标记作为 JSON 值发布。
// know 告诉它“上次发现了哪些插件”，used 告诉它“每个构建读了哪些文件”，这样文件事件才能归属到正确的插件。
// 标记只增不减，直到构建/发现/安装流程用 snapshot+applied 或 know 明确清除。
export class PluginWatcher extends Source {
	// 构造时的配置，包含失败回调；生命周期内不替换。
	readonly #options: WatcherOptions;
	// 插件根的真实路径；事件路径也按真实路径比较，避免符号链接造成前缀不一致。
	readonly #roots: readonly string[];
	// base 目录的真实路径；事件只与这些路径做 inside 判断。
	readonly #baseDirs: readonly string[];
	/** The trees it watches: the roots, the base code, and plugin directories linked from outside the roots. */
	// 当前要监视的树根：插件根、base、根外链接进来的插件目录。树之间的删除通过集合差集处理。
	readonly #trees = new Set<string>();
	/** Its watches, one per directory of its trees. */
	// 目录 -> FSWatcher。每个实际目录一个 watch，递归是手动完成的，不使用平台递归选项。
	readonly #watchers = new Map<string, FSWatcher>();
	/** A failure to watch was reported (once). */
	// 失败是否已经上报；置位后不再建立新监视，避免反复报错。
	#reported = false;
	/** The generation the next change gets: every mark records a newer one than any before it. */
	// 下一个标记代号，从 1 开始递增；0 保留给“无标记/快照时干净”。每次变化取一个唯一代号。
	#generation = 1;
	/** Each dirty plugin's latest change, by generation. */
	// 插件名 -> 最近一次变化代号。同一个插件连续变化时只保留最新代号。
	readonly #dirty = new Map<string, number>();
	// 待安装插件的名字集合；安装完成后由 installed 删除。
	readonly #install = new Set<string>();
	/** The latest change of the plugin set since the last discovery (0: none). */
	// 最近一次影响插件集合的变化代号（0 表示没有）；know 用快照比较后决定是否清零。
	#set = 0;
	/** The latest change of a known plugin's `package.json` since the last discovery (0: none). */
	// 最近一次已知插件 package.json 的变化代号（0 表示没有）；它要求重新发现并读取元数据。
	#manifest = 0;
	// base 代码自上次应用读取后是否变过；只能由应用重启后自行清除（watcher 没有清除方法）。
	#baseChanged = false;
	// 最近一次发现结果；文件事件用它把路径归属到插件。初始为空发现，允许构造后先 watch 再 know。
	#discovery: Discovery = { plugins: [], problems: [] };
	/** The files each built facet read (its inputs and copies), by plugin and kind. */
	// 每个已构建 facet 读过的文件：键由插件名与 facet 名拼接，值保留插件名和文件集合。
	// 复制出来的契约文件也算在内，所以一个契约变化会弄脏所有读过它的插件。
	readonly #used = new Map<string, { readonly plugin: string; readonly files: ReadonlySet<string> }>();
	// value 的惰性缓存；任一标记变化时置 undefined，下次读取再重建 JSON。
	#value: JsonValue | undefined;
	// 是否已排队一个微任务发布；把同一轮事件合并成一次 changed。
	#scheduled = false;

	// 构造监视器。
	// 输入：options 的 roots/base/kinds/failed，以及所属 Batch；输出：新实例。
	// 副作用：立即为每个根和 base 目录建立递归监视；不读取插件内容，也不调用发现。
	// 错误：单个目录不存在时 watch 抛 ENOENT，被 #watchDirs 安静跳过；其他同步错误交给 failed。
	// 例子：new PluginWatcher({ roots: ["/app/plugins"], base: ["/app/src"], kinds: ["server"], failed: report }, batch)。
	constructor(options: WatcherOptions, batch: Batch) {
		// Source 保存 batch 引用，后续 changed()/publish() 通过它排队。
		super(batch);
		this.#options = options;
		// Events name paths under the directories as watched: by their real paths, as discovery names plugins.
		// 真实路径化：discover 产出的插件目录同样经过 realpath，事件路径才能和这些前缀直接比较。
		this.#roots = options.roots.map(real);
		this.#baseDirs = options.base.map(real);
		// 根与 base 都是树根；#watchTree 会去重，重复目录不会重复监视。
		for (const dir of [...this.#roots, ...this.#baseDirs]) this.#watchTree(dir);
	}

	// 当前标记的 JSON 快照。
	// 返回：新的或缓存的对象；数组已排序。读取本身不触发发布，也不清除任何标记。
	// 例子：已 know 的插件 a 的文件被 mark 后，value.dirty 含 "a"；多次读取返回同一个缓存对象，直到下一次 #changed。
	get value(): JsonValue {
		// ??= 只在缓存为 undefined 时重建；#changed 会把缓存清空。
		this.#value ??= {
			dirty: [...this.#dirty.keys()].sort(),
			install: [...this.#install].sort(),
			set: this.#set > 0,
			base: this.#baseChanged,
		};
		return this.#value;
	}

	// 把当前快照作为一帧发布给 watch/subscriber；由 Batch 在本次批次投递时调用。
	// 输入：context 用于投递与错误上报；输出：无。ops 用整值替换 ["r", value]，因为标记不是增量语义。
	deliver(context: Context): void {
		const value = this.value;
		// false 表示没有文档退役；每次发布都给出完整 value，观察者无需重放历史。
		this.publish(value, [["r", value]], false, context);
	}

	/** Whether the next build discovers again: the plugin set or a plugin's `package.json` changed. */
	// 下一次构建是否需要重新发现：插件集合变了，或某个 package.json 变了。
	// 注意 base 变化不算发现，它要求应用重启宿主而不是重新发现插件。
	get needsDiscovery(): boolean {
		return this.#set > 0 || this.#manifest > 0;
	}

	/** What a discovery that starts now has seen. */
	// 取当前 set/manifest 代号，交给随后启动的发现；know 用同一对值判断发现期间有没有新变化。
	discoverySnapshot(): DiscoverySnapshot {
		return { set: this.#set, manifest: this.#manifest };
	}

	/** The plugins discovery found: marks are for them (a removed one's install clears); the changes it had seen clear. */
	// 接收一次发现结果，并清除它已经看到的标记。
	// 输入：discovery 是刚完成的发现；seen 是发现启动时取的 DiscoverySnapshot。
	// 输出：无；副作用是替换 #discovery、调整 dirty/install/used/trees，并触发 #changed。
	// 流程：先给“文件布局变化”的插件打 dirty，再删除已消失插件的 used 关联，然后按代号清 set/manifest，
	// 删除已消失插件的 install 标记，最后为根外插件建立独立树、移除不再需要的树。
	// 例子：watcher.know(await discoverPlugins([root], { kinds }, context), watcher.discoverySnapshot())；
	// 若发现期间又新增了目录，set 代号已变大，本方法不会清零它。
	know(discovery: Discovery, seen: DiscoverySnapshot): void {
		// A plugin whose files moved (a single file became a directory, a facet file came or went) is dirty.
		// 所有“文件集合移动”的插件共用这一个代号，表示它们都由同一次发现观察到。
		const generation = this.#generation++;
		for (const plugin of discovery.plugins) {
			// 按名字找上一次的同名插件；名字是插件身份，路径移动仍视为同一个插件。
			const before = this.#discovery.plugins.find(({ name }) => name === plugin.name);
			// sameFiles 比较真实目录、layout 与各 kind 的 facet 文件；变化意味着旧构建结果不再对应当前文件。
			if (before !== undefined && !sameFiles(before, plugin)) this.#dirty.set(plugin.name, generation);
		}
		// A plugin no longer discovered: what its builds read no longer dirties anything.
		// 已消失插件的 used 关联没有意义，删除以免文件变化继续把已不存在的插件名标脏。
		for (const [key, { plugin }] of this.#used) {
			if (!discovery.plugins.some(({ name }) => name === plugin)) this.#used.delete(key);
		}
		// 用最新发现替换旧结果；之后到达的文件事件按新插件集合归属。
		this.#discovery = discovery;
		// 代号相等说明发现期间没有新变化，可以清零；不相等则保留，让下一轮发现继续处理。
		if (this.#set === seen.set) this.#set = 0;
		if (this.#manifest === seen.manifest) this.#manifest = 0;
		// 已消失的插件不可能再安装依赖，清掉它的 install 标记。
		// A removed plugin has nothing to install (its directory went, its package.json with it).
		for (const name of this.#install)
			if (!discovery.plugins.some((plugin) => plugin.name === name)) this.#install.delete(name);
		// 目录插件若不在任何 root 内，通常是符号链接指向根外：为它单独建树监视。
		// A plugin directory linked from outside the roots: a tree of its own (a symlink is not followed).
		// 单文件插件的 dir 是根，不会进入这里；只处理 layout 为 directory 的插件。
		const linked = discovery.plugins.filter(
			({ dir, layout }) => layout === "directory" && !this.#roots.some((root) => inside(root, dir)),
		);
		// 为新出现的根外插件目录建立监视；已在 #trees 中时是幂等的。
		for (const { dir } of linked) this.#watchTree(dir);
		// 回收不再属于任何 root/base/链接插件的树，关闭其全部目录监视。
		for (const tree of this.#trees) {
			const kept =
				// 树被保留的条件：仍是根、仍是 base，或仍对应一个根外目录插件。
				this.#roots.includes(tree) || this.#baseDirs.includes(tree) || linked.some((each) => each.dir === tree);
			if (!kept) this.#unwatchTree(tree);
		}
		// 即使本次没有新增标记，也通知 Source 缓存失效；被观察时会得到一帧最新快照。
		this.#changed();
	}

	/** What `built` facets read: a later change of one of these files dirties their plugins. */
	// 登记一次构建读了哪些文件，供后续变化归属使用。
	// 输入：built 是本次构建结果数组；输出：无。
	// 规则：只有 kind 为 script 的结果有 inputs/copied；失败结果被跳过，因此同一 facet 的旧关联会保留到下次成功构建。
	// 例子：watcher.used([built]) 后，修改 built.inputs 中任一文件会让 built.plugin 进入 dirty。
	used(built: readonly BuiltFacet[]): void {
		for (const facet of built) {
			// 失败构建没有实际输入；不能把空集合写进去，否则会抹掉上一次成功构建的关联。
			if (facet.kind !== "script") continue;
			// inputs 是构建解析过的源文件，copied 是从其他插件复制进来的文件（例如契约）；两者变化都应重建。
			const files = new Set([...facet.inputs.map(({ file }) => file), ...facet.copied]);
			// 键包含 facet 名：同一插件的不同 kind 分别记录，互不覆盖。
			this.#used.set(`${facet.plugin}\u0000${facet.facet}`, { plugin: facet.plugin, files });
		}
	}

	/** The marks a build of `names` starts from: each one's latest change. */
	// 拍摄待构建插件的 dirty 代号。
	// 输入：names 是本次要构建的插件名；输出：MarkSnapshot（快照之后不再变化）。
	// 未标记的插件记为 0；applied 只在当前代号不大于快照值时清除，因此构建期间的新编辑不会被误清。
	snapshot(names: Iterable<string>): MarkSnapshot {
		const plugins = new Map<string, number>();
		// ?? 0：没有 dirty 记录表示拍摄时干净；代号始终 >= 1，所以 0 不会与真实标记冲突。
		for (const name of names) plugins.set(name, this.#dirty.get(name) ?? 0);
		return { plugins };
	}

	/** `names` were applied everywhere: their marks clear unless a change came after `snapshot`. */
	// 构建结果已经应用：清除快照之后没有再次变化的 dirty 标记。
	// 输入：names 已应用的插件，snapshot 是构建开始时拍的快照；输出：无。
	// 比较用 <=：当前代号等于快照值说明期间没变；大于则说明构建期间又改过，保留标记。
	// 注意：代号只增不减，所以不存在“回退”造成的误判。
	applied(names: Iterable<string>, snapshot: MarkSnapshot): void {
		for (const name of names) {
			// undefined 表示该插件当前没有标记，无需清除。
			const latest = this.#dirty.get(name);
			// 只有最新代号不超过快照值才删除；构建期间的新编辑会得到更大代号，因此保留。
			if (latest !== undefined && latest <= (snapshot.plugins.get(name) ?? 0)) this.#dirty.delete(name);
		}
		this.#changed();
	}

	/** Plugin `name`'s dependencies were installed: its install mark clears and it is dirty (its packages changed). */
	// 某插件的依赖安装完成：清 install 标记，并把插件标脏（node_modules 内容变了，构建输入可能变）。
	// 输入：插件名；输出：无；副作用是分配新代号并触发 #changed。
	installed(name: string): void {
		// 安装请求已经完成，不再需要 install 标记。
		this.#install.delete(name);
		// 用新代号标脏；不能复用旧代号，否则可能与构建快照比较时被错误清除。
		this.#dirty.set(name, this.#generation++);
		this.#changed();
	}

	/** Plugins were installed into a root: discovery runs at the next build (without waiting for the watch's events). */
	// 新插件已放入某个根：直接请求下一轮发现，不必等待文件系统事件。
	// 输入：无；输出：无。这里只置 set，不猜测插件名，发现会给出真实结果。
	added(): void {
		// 分配非零代号；discoverySnapshot 若在这之后取，就能看到它。
		this.#set = this.#generation++;
		this.#changed();
	}

	/** Marks what a change of the file or directory at `path` (absolute) asks for. */
	// 手动标记某个绝对路径的变化；主要供文件事件与测试调用。
	// 输入：path（绝对路径）；输出：无。
	// 流程：路径任一段是 node_modules/.git 就忽略；在 base 内只置 base；否则交给 #markPlugin 归属插件。
	// 注意：base 变化不消耗代号，插件变化才分配新代号；同一事件可能弄脏多个插件，但共用一个代号。
	mark(path: string): void {
		// 用分隔符拆段而不是 startsWith 字符串前缀，避免把 mynode_modules 误判为 node_modules。
		if (path.split(sep).some((part) => IGNORED.has(part))) return;
		// base 目录本身不算 inside（inside 不包含 dir 自身）；实际事件通常指向其子项。
		if (this.#baseDirs.some((dir) => inside(dir, path))) {
			this.#baseChanged = true;
		} else {
			// 传给 #markPlugin 的代号在本调用内唯一；里面所有被弄脏的插件共用它。
			this.#markPlugin(path, this.#generation++);
		}
		// 即使只是 base 变化也要让 value 缓存失效并通知依赖者。
		this.#changed();
	}

	/** Stops watching. */
	// 停止全部监视并清空树/目录表；对象仍可读取最后的标记。
	// 输入：无；输出：无。重复调用安全（表已空）；不会调用 options.failed。
	close(): void {
		// FSWatcher.close() 停止接收事件；之后清表，避免 close 后仍被误认为已监视。
		for (const watcher of this.#watchers.values()) watcher.close();
		this.#watchers.clear();
		this.#trees.clear();
	}

	/**
	 * A change under a root, at `generation`: in a plugin's directory, it dirties that plugin (and asks for an install
	 * and a new reading of its metadata for its `package.json`, for discovery for a facet file at its top); a single-file
	 * plugin's file dirties it (and asks for discovery when it is gone); elsewhere under a root (a directory or a
	 * single-file plugin's file added or removed, a directory that is no plugin yet), discovery; every plugin whose
	 * facets read the file is dirty too.
	 */
	// 把一个插件路径的变化翻译成标记。
	// 输入：path 绝对路径，generation 本次变化代号；输出：无。
	// 归属顺序：先找 owns 它的插件；找不到且在某 root 内 => set；单文件插件 => 删除时 set，始终 dirty；
	// package.json => install + manifest（安装完成后由 installed 标脏）；其他目录插件文件 => 必要时 set，始终 dirty。
	// 最后再检查所有 used 关联：读过该文件的每个插件都要 dirty（典型是复制出的契约）。
	#markPlugin(path: string, generation: number): void {
		// 一个路径最多归一个插件；单文件插件的 facets 值就是它自己的文件，目录插件按目录包含关系匹配。
		const plugin = this.#discovery.plugins.find((each) => owns(each, path));
		// 不属于任何已知插件：只有位于插件的某个根内才可能改变插件集合。
		if (plugin === undefined) {
			// inside 不包含根自身，所以根目录本身的事件不会置 set。
			if (this.#roots.some((root) => inside(root, path))) this.#set = generation;
			// 单文件插件：它的 facet 文件消失意味着该插件可能不再有这一 facet，甚至整个插件消失，必须重新发现；文件仍在则只需重建。
		} else if (plugin.layout === "file") {
			// existsSync 对文件/目录都返回 true；这里只处理“路径不存在”的单文件插件删除。
			if (!existsSync(path)) this.#set = generation;
			this.#dirty.set(plugin.name, generation);
		} else if (path === join(plugin.dir, "package.json")) {
			// package.json 变化分两步：先请求安装并记录 manifest 代号，发现会重新读取元数据并据此重新识别插件。
			this.#install.add(plugin.name);
			this.#manifest = generation;
		} else {
			// 目录本身变化，或插件顶层的合法 facet 文件发生变化（含增删），才需要重新发现；更深层文件只需重建。
			if (path === plugin.dir || (dirname(path) === plugin.dir && this.#isFacetFile(basename(path)))) {
				// facet 文件判断使用应用声明的 kinds；其他顶层文件（如 README）不触发发现。
				this.#set = generation;
			}
			this.#dirty.set(plugin.name, generation);
		}
		// 复制进其他插件构建的契约文件变化时，所有读取它的插件都要重建；可能包含当前插件自己。
		for (const { plugin: user, files } of this.#used.values()) if (files.has(path)) this.#dirty.set(user, generation);
	}

	/** Whether `file` (at a plugin's top) is named as a facet file of one of the app's kinds. */
	// 判断顶层文件名是否是某个 kind 的 facet 文件，例如 worker.ts/worker.tsx/worker.js/worker.mjs。
	// 只看文件名，不读盘；大小写敏感，和发现阶段的匹配规则一致。
	#isFacetFile(file: string): boolean {
		// 任一应用 kind 与任一允许扩展名组合命中即可；返回布尔值，不表示文件一定存在。
		return this.#options.kinds.some((kind) => FACET_EXTENSIONS.some((extension) => file === `${kind}${extension}`));
	}

	/** Watches the tree at `dir` (once): it and every directory under it but ignored ones; a missing one is skipped. */
	// 开始监视一棵树（根、base 或根外插件目录）；已在 #trees 中则立即返回。
	// 输入：目录路径；输出：无。目录不存在时 watch 会抛 ENOENT，由 #watchDirs 安静跳过；该树仍留在 #trees 中，不会自动重试。
	#watchTree(dir: string): void {
		// 去重：同一个目录可能既是根又被链接插件引用。
		if (this.#trees.has(dir)) return;
		this.#trees.add(dir);
		this.#watchDirs(dir);
	}

	/** Stops watching the tree at `dir`. */
	// 停止监视一棵树：先从集合移除，再关闭该目录及其下所有已建立的 watch。
	#unwatchTree(dir: string): void {
		// 先删树标记，避免后续 know 把同一目录当成仍在监视。
		this.#trees.delete(dir);
		this.#unwatchDirs(dir);
	}

	/** Watches `dir` and, walking down, every directory under it but ignored ones (each not watched yet). */
	// 为 dir 及其下每个真实子目录建立 watch。
	// 输入：目录路径；输出：无。已监视或已上报失败时直接返回。
	// 错误：同步 watch 抛 ENOENT（目录不存在）时忽略；其他错误调用 #failed；异步 'error' 事件也调用 #failed。
	// 副作用：写入 #watchers，并递归子目录；node_modules/.git 不进入；符号链接目录不会被当作目录跟随。
	#watchDirs(dir: string): void {
		// 已监视或失败后不再重复建立；#reported 为真时整个 watcher 已停止工作。
		if (this.#watchers.has(dir) || this.#reported) return;
		let watcher: FSWatcher;
		try {
			// 回调只关心路径；event 类型（rename/change）不区分，统一按路径重新判断。
			watcher = watch(dir, (_event, file) => {
				// 某些平台可能给出 null 文件名；没有路径就无法归属，直接忽略。
				if (file !== null) this.#changedIn(join(dir, file));
			});
		} catch (error) {
			// 目录在 watch 建立前就不存在是正常竞态；其他错误（权限、句柄耗尽等）视为监视失败。
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#failed(error);
			return;
		}
		// 运行中的 watch 也可能异步报错，例如底层句柄失效；同样走一次性失败上报。
		watcher.on("error", (error) => this.#failed(error));
		// 先登记再读目录：即使读完目录后立刻有事件，回调也能找到这个 watcher。
		this.#watchers.set(dir, watcher);
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
			// 读目录失败通常是目录刚被删除；父目录的事件会触发 #changedIn 并清理监视，这里安静返回。
		} catch {
			// Removed meanwhile: its parent's event says so.
			return;
		}
		// 只递归真实目录；Dirent.isDirectory() 对符号链接为 false，因此不会跟随链接形成环。
		for (const entry of entries) {
			if (entry.isDirectory() && !IGNORED.has(entry.name)) this.#watchDirs(join(dir, entry.name));
		}
	}

	/** An event for `path` in a watched directory: a new directory gets its watches, a removed one loses them; marked. */
	// 处理一个具体路径的事件：维护目录监视，再记录标记。
	// 输入：path 是事件给出的绝对路径；输出：无。
	// 流程：非忽略目录若是目录则补建监视；若它曾是已监视目录但现在不是目录（被删/被替换），关闭其监视；最后 mark。
	#changedIn(path: string): void {
		// 用 basename 判断忽略目录；路径中间的 node_modules 由 mark 的分段检查负责。
		const name = basename(path);
		if (!IGNORED.has(name)) {
			// 新目录出现：递归补建 watch，之后其中的文件事件才能被收到。
			if (isDirectory(path)) this.#watchDirs(path);
			// 已监视路径不再是目录：说明目录被删除或替换，关闭它及其子目录的 watch。
			else if (this.#watchers.has(path)) this.#unwatchDirs(path);
		}
		// 无论是否维护了监视都要记录标记；mark 内部会再次过滤忽略路径。
		this.mark(path);
	}

	/** Stops watching `dir` and the directories under it (it was removed, or its tree is not watched any more). */
	// 关闭 dir 自身及所有位于其下的 watch。
	// 输入：目录路径；输出：无。用于目录被删除或整棵树不再需要的情况。
	// 遍历 Map 时删除当前项在 JavaScript 中是安全的；inside 不包含 dir 自身，所以单独判断相等。
	#unwatchDirs(dir: string): void {
		for (const [watched, watcher] of this.#watchers) {
			// 只处理 dir 与它内部的目录，不能误关兄弟目录的监视。
			if (watched !== dir && !inside(dir, watched)) continue;
			watcher.close();
			this.#watchers.delete(watched);
		}
	}

	/** Watching failed: reported once; every watch stops (the app builds on demand). */
	// 监视系统失败：关闭全部监视，并且只上报一次。
	// 输入：error 是同步异常或 'error' 事件；输出：无。
	// 副作用：调用 options.failed（应用代码），此后 #watchDirs 因 #reported 不再建立监视；标记仍可由手动 mark 更新。
	#failed(error: unknown): void {
		// 先关闭，避免失败后仍不断收到事件；close 本身不触发 failed。
		this.close();
		// 已经上报过就只保持关闭状态，不重复打扰应用。
		if (this.#reported) return;
		this.#reported = true;
		// 交给应用的失败回调；watcher 不决定应用如何降级。
		this.#options.failed(error);
	}

	/** The marks changed: one publication per microtask turn while someone watches or derives from them. */
	// 标记变化后的统一通知：清 value 缓存，并在需要时排队一次批次变更。
	// 没有观察者（无 watch、无 subscriber、无 dependent）时只更新内部状态，不产生帧；之后打开 watch 会直接读到最新值。
	// 有观察者时用 queueMicrotask 合并同一轮多个 fs 事件，再在 BACKGROUND_CONTEXT 中调用 Source.changed()。
	#changed(): void {
		// 缓存失效；下一次读取 value 会重新排序并构造 JSON。
		this.#value = undefined;
		// 已排队则合并；无人观察则不必发布，但 dependents 非空时仍需调度 invalidate。
		if (this.#scheduled || (!this.watched && this.dependents.size === 0)) return;
		this.#scheduled = true;
		// 用一个微任务把同步的 fs 事件移出批次；batch.within 让 changed 归入当前批次。
		queueMicrotask(() => {
			this.#scheduled = false;
			// BACKGROUND_CONTEXT 表示这次变化没有请求上下文；之后的投递仍沿用 Source 的 watch/批次机制。
			this.batch.within(() => this.changed(), BACKGROUND_CONTEXT);
		});
	}
}

/** Whether `path` is `plugin`'s: in its directory, or one of a single-file plugin's files. */
// 判断 path 是否属于 plugin。
// 单文件插件：path 必须正好是它某个 kind 的 facet 文件；目录插件：dir 自身或 dir 内部。
// 输入均为绝对路径（构造时已 realpath）；不读盘，只做字符串/路径比较。
function owns(plugin: Plugin, path: string): boolean {
	// Object.values 取出各 kind 的文件路径；单文件插件没有自己的目录，不能用目录包含关系。
	if (plugin.layout === "file") return Object.values(plugin.facets).includes(path);
	// inside 不包含 dir 自身，所以目录本身的删除/重命名要单独用 === 命中。
	return plugin.dir === path || inside(plugin.dir, path);
}

/**
 * Whether `path` is a directory, never following a link (as the scan of a tree does not); one that cannot be read (gone,
 * a link loop, no access) is none: a watch callback must not throw.
 */
// 不跟随链接地判断 path 是否是目录。
// 输入：绝对路径；输出：布尔值。lstat 失败、路径不存在、链接环、权限不足都返回 false。
// 这里必须吞掉异常：它运行在 fs.watch 回调里，抛错会变成未捕获异常。
function isDirectory(path: string): boolean {
	try {
		// throwIfNoEntry: false 让“路径不存在”返回 undefined 而不是抛 ENOENT；?. 再安全取 isDirectory。
		return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
		// 链接环或权限错误等仍可能抛；监视回调选择把任何失败当作“不是目录”。
	} catch {
		return false;
	}
}

/** `dir` absolute and by its real path; as given (absolute) when it does not exist. */
// 解析目录的真实路径，用于让事件路径与发现结果使用同一套绝对路径。
// 输入：可能尚不存在的目录；输出：存在的真实路径，或 resolve 后的绝对路径。
// 不抛错：realpath 失败（目录不存在、无权限）时退回 resolve，避免构造 watcher 因根缺失而失败。
function real(dir: string): string {
	// realpathSync 会跟随符号链接；成功时得到文件系统当前的真实位置。
	try {
		return realpathSync(dir);
	} catch {
		// 失败路径只做词法绝对化；若之后目录才出现，解析结果可能与未来 realpath 不同。
		return resolve(dir);
	}
}
