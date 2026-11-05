// Data archives (slice 13 §4, decisions "The app kit, point 5" and "App kit naming and export"): one tar of the data a
// host created, `manifest.json` (the app, its API version, the kit's format version, the address), `store.archive` (the
// store's export archive, slice 6a, as JSONL: one consistent point, the export holding the commit queue while it reads)
// and `files/` (its finished files). A running worker packs its own open store; without one the server packs the
// directory under the worker's lock. Unpacking makes a new directory for an address that has none, refusing every path
// that would leave it.

// 所属：packages/chord/src/node/app，Chord app kit 的按地址数据归档模块（slice 13 §4）。
// 职责边界：把 host 目录的 store 导出、manifest 和已完成文件打包成 tar，并把归档解包到全新目录；不决定何时导出，也不停止 worker。
// 上游：app.ts 的 exportData/importData 调用；下游：store 的 encodeJsonl/decodeJsonl、tar.ts 的读写、layout.ts 的私有目录。
// 结果与错误：成功返回 void 或暂存路径；格式错误、超出限制、路径非法、accept 拒绝和 I/O 错误都抛出；失败时删除暂存目录。
// 能力清单：ARCHIVE_FORMAT 是格式版本；ArchiveManifest 描述应用/API/地址；packData 打包不运行的目录；packStore 打包已打开的 store；ImportLimits 限制导入；unpackData 解包到新目录；unpackEntries 逐条校验并写入；filesOf/pathsUnder 枚举文件；collect 限制 manifest 大小；exists 判断目录。
// 组合顺序：packData → openStore → packStore → encodeJsonl/stat → writeTar；unpackData → unpackEntries → readTar → importStore → rename。
// 示例：await packData(dir, { format: 1, app: 'acme', api: 'v1', address: { kind: 'doc', key: 'doc|1' } }, '/tmp/a.tar', ctx)。
// 建议阅读顺序：先看 ARCHIVE_FORMAT/ArchiveManifest/packData/packStore，再看 unpackData/unpackEntries，最后 filesOf/pathsUnder/collect。
import { createReadStream, createWriteStream, type Dirent } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Context } from "../../context/index.ts";
import { openNodeSqliteDatabase } from "../../sqlite/node.ts";
import { decodeJsonl, encodeJsonl, importStore, openStore, type Store, sqliteBackend } from "../../store/index.ts";
import { privateDirectory, privateStore } from "./layout.ts";
import { readTar, type TarEntry, writeTar } from "./tar.ts";

// 归档格式版本；manifest 中的 format 必须与导入方理解的一致。
/** The kit's archive format version. */
export const ARCHIVE_FORMAT = 1;

// ArchiveManifest 是归档自描述：应用名、API 版本、格式版本和地址的 kind/key；accept 回调据此决定是否接收。
/** What an archive says about itself. */
export type ArchiveManifest = {
	readonly format: number;
	readonly app: string;
	// address 只保存定位所需的 kind 和 key，params 由应用重新构造。
	readonly api: string;
	readonly address: { readonly kind: string; readonly key: string };
};

// host 目录中 SQLite 主文件的固定名称。
/** The store file of a host directory. */
const STORE = "store.sqlite";

// 打包一个不运行的 host 目录：dir 必须已存在，打开其 store，再委托 packStore。
// 输入 dir、manifest、目标 path 和上下文，返回 Promise；store 打开/关闭、打包和 I/O 错误向上传播。
// 例子：worker 已停止且锁已持有时，packData(workerDir, manifest, '/tmp/a.tar', ctx) 生成归档。
/**
 * Packs the host directory `dir` of a host that does not run (its worker's lock held: nothing writes it) into the
 * archive at `path`: `manifest`, its store's export and its files.
 */
export async function packData(dir: string, manifest: ArchiveManifest, path: string, context: Context): Promise<void> {
	// 没有数据目录说明该地址从未运行或已被清理，明确拒绝而不是生成空归档。
	if (!(await exists(dir))) throw new Error(`exportData: ${manifest.address.key} has no data`);
	// 打开 SQLite 主文件；packStore 读取 store 的导出一致点。
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(dir, STORE))), context);
	// try/finally 保证无论打包成败都关闭 store。
	try {
		// files 子目录与 store 同属 host 目录；manifest 由调用方提供。
		await packStore(store, join(dir, "files"), manifest, path, context);
	} finally {
		// 关闭顺序在打包完成后执行；关闭错误会覆盖打包错误。
		await store.close(context);
	}
}

// 把已打开的 store 和 files 目录打包到 path：先在目标旁建暂存目录，写 store 导出、manifest 和文件，最后 rename 发布。
// 输出文件 mode 0600；上传中的文件不在 files/ 顶层，因而不会被包含。store.export 在读取期间保持 commit 队列，得到一个一致点。
// 任何一步失败都会删除暂存目录；目标路径不会被部分写入。
/**
 * Packs the open `store` and the files directory `files` into the archive at `path` (mode 0600, staged beside it and
 * renamed): `manifest`, the store's export (one consistent point, written while the host runs on) and the finished
 * files (uploads under way left out).
 */
export async function packStore(
	store: Store,
	files: string,
	manifest: ArchiveManifest,
	path: string,
	context: Context,
): Promise<void> {
	// mkdtemp 在目标目录旁创建唯一暂存目录；同一文件系统上 rename 才是原子的。
	const staging = await mkdtemp(join(dirname(path), ".chord-export-"));
	// try/finally 负责清理暂存目录，成功 rename 后只剩空目录要删。
	try {
		// store 导出写到暂存目录，稍后作为 tar 的一个条目。
		const exported = join(staging, "store.archive");
		// encodeJsonl 逐块产出；pipeline 把背压和错误传播交给流，createWriteStream 以 0600 建文件。
		await pipeline(encodeJsonl(store.export(context)), createWriteStream(exported, { mode: 0o600 }));
		// manifest 序列化成 UTF-8 字节；它的长度用于 tar 头。
		const text = new TextEncoder().encode(JSON.stringify(manifest));
		// stat 取得导出文件的实际大小；store 可能包含多行 JSONL。
		const size = (await stat(exported)).size;
		// entries 是 tar 条目生成器；它只在 writeTar 拉取时读取文件。
		async function* entries(): AsyncGenerator<TarEntry> {
			// 第一条固定是 manifest.json，满足导入端必须先见 manifest 的规则。
			yield { path: "manifest.json", size: text.length, data: chunksOf(text) };
			// 第二条是 store.archive；createReadStream 延迟打开，避免同时占用描述符。
			yield { path: "store.archive", size, data: createReadStream(exported) };
			// yield* 把 files/ 下的条目直接接到生成器末尾。
			yield* filesOf(files);
		}
		// 最终 tar 也写在暂存目录，完成后才发布。
		const written = join(staging, "archive.tar");
		// writeTar 产出字节块，pipeline 负责写入与背压。
		await pipeline(writeTar(entries()), createWriteStream(written, { mode: 0o600 }));
		// rename 把完整归档原子地移动到 path；覆盖已有文件由操作系统决定，调用方负责选择目标。
		await rename(written, path);
	} finally {
		// 无论成功或失败都递归删除暂存目录；force 忽略已不存在。
		await rm(staging, { recursive: true, force: true });
	}
}

// 把一段字节包装成单块异步生成器；manifest 很小，不需要分块。
/** One chunk. */
async function* chunksOf(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
	// yield 一次；迭代结束后生成器自然结束。
	yield bytes;
}

// 枚举 files 目录下的普通文件，生成 tar 条目 files/<相对路径>；隐藏文件（包括 .uploads）被跳过。
// 每个文件在轮到它时才打开，一次只占一个描述符；大小取自打开后的句柄，文件在导出期间被删除时跳过。
// 已完成文件不再修改，因此用打开句柄读取整段是安全的。例子：files/sub/b 变成条目 files/sub/b。
/**
 * The files under `root` as entries `files/<relative path>` (hidden ones, uploads under way, left out), each opened only
 * when the archive comes to it (one descriptor at a time) and its size taken from the open file: a file deleted while a
 * running worker is exported is skipped, or read whole from its open handle (finished files never change; Opus L7).
 */
async function* filesOf(root: string): AsyncGenerator<TarEntry> {
	// pathsUnder 先递归收集并排序路径，避免 readdir 顺序影响归档。
	for (const path of await pathsUnder(root)) {
		// 打开文件；ENOENT 表示枚举后被删除，转为 undefined 跳过，其他错误继续抛。
		const handle = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			// 仅吞掉 ENOENT；权限等错误不能被掩盖。
			throw error;
		});
		// 被删除的文件没有条目。
		if (handle === undefined) continue;
		// 用已打开句柄的 stat 取得真实大小，避免路径被替换后元数据不一致。
		const info = await handle.stat();
		// 只打包普通文件；目录由路径遍历体现，符号链接等被跳过。
		if (!info.isFile()) {
			// 非普通文件关闭句柄，不产生条目。
			await handle.close();
			continue;
		}
		// relative 得到相对路径，再把系统分隔符统一成 /，保证 tar 路径跨平台。
		const inside = relative(root, path).split(sep).join("/");
		// 条目路径带 files/ 前缀，与导入端约定一致。
		yield {
			path: `files/${inside}`,
			size: info.size,
			// createReadStream 从打开句柄读取 0 到 size-1；空文件用 end: 0 表示零长度。
			data: handle.createReadStream({ start: 0, end: Math.max(0, info.size - 1) }),
		};
	}
}

// 递归收集 root 下的普通文件路径并排序；隐藏文件/目录跳过，目录在遍历期间消失时当作空。
/** The paths of the files under `root`, sorted, hidden ones left out (a directory gone meanwhile: none of it). */
// 结果数组由 walk 填充。
async function pathsUnder(root: string): Promise<string[]> {
	const paths: string[] = [];
	// walk 是递归闭包；没有显式返回路径，只把文件推入 paths。
	const walk = async (dir: string): Promise<void> => {
		let entries: Dirent[];
		try {
			// withFileTypes 避免额外 stat；按名称排序，保证归档稳定。
			entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
			// 目录不存在说明导出期间被删除，安静跳过；其他错误抛出。
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		// 逐个 Dirent 判断类型。
		for (const entry of entries) {
			// 隐藏项包括 .uploads，上传中的文件不会进入归档。
			if (entry.name.startsWith(".")) continue;
			const path = join(dir, entry.name);
			// 目录递归；符号链接不会被当作目录或文件。
			if (entry.isDirectory()) await walk(path);
			// 普通文件记录下来，稍后由 filesOf 打开。
			else if (entry.isFile()) paths.push(path);
		}
	};
	// 从 root 开始遍历。
	await walk(root);
	return paths;
}

// ImportLimits 限制解包后的总字节和条目数；缺省值由 unpackEntries 填入。
/** What an import takes at most: unpacked bytes (4 GiB by default) and entries (100,000 by default). */
export type ImportLimits = { readonly bytes?: number; readonly entries?: number };

// 把归档解包到新目录 dir：dir 已存在则拒绝，manifest 交给 accept 审核，store 从 JSONL 重建，files/ 恢复。
// 输入归档路径、目标目录、accept 回调、限制和上下文；返回 Promise。拒绝、校验失败、I/O 错误都会抛出。
// 全程在 dir 旁的暂存目录进行，成功才 rename；失败时删除暂存目录，目标目录不会出现半成品。
/**
 * Unpacks the archive at `archive` into the new host directory `dir` (refused when it exists): its manifest checked by
 * `accept` (a throw refuses it), the store made from `store.archive`, `files/` restored, within `limits`. Staged beside
 * `dir` (mode 0700, files 0600) and renamed into place at the end, so a refused or broken archive leaves nothing.
 */
export async function unpackData(
	archive: string,
	dir: string,
	accept: (manifest: ArchiveManifest) => void,
	limits: ImportLimits,
	context: Context,
): Promise<void> {
	// 地址只能导入一次；已有目录说明重复导入或目标被占用。
	if (await exists(dir)) throw new Error(`importData: ${dir} exists already (an address is imported once)`);
	// 父目录先设为 0700，暂存目录继承私有环境。
	await privateDirectory(dirname(dir));
	// 暂存目录与目标同父，保证最后 rename 在同一文件系统。
	const staging = await mkdtemp(join(dirname(dir), ".chord-import-"));
	// try/catch 负责失败清理。
	try {
		// 逐条解包；返回暂存目录中 store.archive 的路径。
		const storeArchive = await unpackEntries(archive, staging, accept, limits, context);
		// 先创建空数据库文件并设为 0600，再由 importStore 写入。
		await privateStore(join(staging, STORE));
		// 打开 SQLite 主文件；此时文件为空，importStore 会建立 schema。
		const backend = sqliteBackend(await openNodeSqliteDatabase(join(staging, STORE)));
		// decodeJsonl 把归档流转成导入操作；importStore 返回打开的新 store。
		const store = await importStore(backend, decodeJsonl(createReadStream(storeArchive)), context);
		// 导入提交后关闭 store，释放文件句柄，准备 rename 目录。
		await store.close(context);
		// store.archive 是中间产物，不留在最终 host 目录。
		await rm(storeArchive);
		// 原子发布整个暂存目录；目标不存在已在上方检查。
		await rename(staging, dir);
	} catch (error) {
		// 任何失败都删除暂存目录，不留半解包数据。
		await rm(staging, { recursive: true, force: true });
		// 把原始错误抛给调用方；清理错误如果发生会覆盖它。
		throw error;
	}
}

// 把 tar 条目写入暂存目录：先解析并审核 manifest，再写 store.archive 和 files/，其他路径一律拒绝。
// 字节数和条目数在写每个条目之前按头信息计数；context 的 abort 会在条目之间检查。
// 返回暂存的 store.archive 路径；格式错误、超限或 accept 抛错都会终止解包。
/**
 * Writes the entries of `archive` into `staging`: the manifest first (checked by `accept` before any data is written),
 * then `store.archive` and `files/…`, within `limits` (counted from the headers, before an entry is written). The path
 * of the staged `store.archive`.
 */
async function unpackEntries(
	archive: string,
	staging: string,
	accept: (manifest: ArchiveManifest) => void,
	limits: ImportLimits,
	context: Context,
): Promise<string> {
	// 默认最多解包 4 GiB；可用 limits 覆盖。
	const maxBytes = limits.bytes ?? 4 * 1024 ** 3;
	// 默认最多 100,000 个条目，防止大量小文件耗尽资源。
	const maxEntries = limits.entries ?? 100_000;
	// manifest 必须第一个出现；undefined 表示还没见到。
	let manifest: ArchiveManifest | undefined;
	// store.archive 必须存在，最后检查。
	let storeArchive: string | undefined;
	// 累计解包字节数，包括所有条目内容。
	let bytes = 0;
	// 累计条目数，目录也计数。
	let entries = 0;
	// readTar 逐条读取；它已经拒绝路径逃逸和危险类型。
	for await (const entry of readTar(createReadStream(archive))) {
		// 可选链让没有 abortSignal 的上下文也能工作；已取消时抛 AbortError。
		context.abortSignal?.throwIfAborted();
		// 前缀自增使检查发生在处理当前条目前；超过限制立即失败。
		if (++entries > maxEntries) throw new Error(`importData: the archive has more than ${maxEntries} entries`);
		// 目录只占 tar 空间，不写文件，但仍计入条目数；随后 continue。
		if (entry.kind === "directory") continue;
		// 文件内容计入字节预算；size 来自已验证的头。
		bytes += entry.size;
		// 字节预算在写入前检查，避免先写超限内容再回滚。
		if (bytes > maxBytes) throw new Error(`importData: the archive unpacks to more than ${maxBytes} bytes`);
		// manifest 必须第一条；否则可能是攻击者把其他路径伪装成 manifest。
		if (manifest === undefined && entry.path !== "manifest.json") {
			// 错误信息明确指出归档格式要求。
			throw new Error("importData: the archive does not start with manifest.json");
		}
		// manifest 是信任边界：解码最多 64 KiB 后 JSON.parse，再交给应用 accept 审核。
		if (entry.path === "manifest.json") {
			// A trust boundary: the archive's own description, checked by `accept`.
			// collect 限制 manifest 大小；JSON.parse 的异常直接传播。accept 抛错会拒绝整个归档。
			manifest = JSON.parse(new TextDecoder().decode(await collect(entry.data, 64 * 1024))) as ArchiveManifest;
			// accept 不返回结果，抛错即拒绝；manifest 赋值发生在成功之后。
			accept(manifest);
			// store.archive 写到暂存目录，路径固定。
		} else if (entry.path === "store.archive") {
			storeArchive = join(staging, "store.archive");
			// pipeline 写入 0600 文件；条目数据流必须在这里消费完，读取器才能前进。
			await pipeline(entry.data, createWriteStream(storeArchive, { mode: 0o600 }));
			// files/ 前缀内的路径按段拼接；readTar 已拒绝绝对路径和 ..，所以仍在暂存目录内。
		} else if (entry.path.startsWith("files/")) {
			// `readTar` refused absolute paths and `..`: `files/<path>` stays inside the staging directory.
			// split('/') 恢复层级，join 按系统规则拼接；展开传参避免把整段当文件名。
			const target = join(staging, ...entry.path.split("/"));
			// 按需创建父目录并保持 0700。
			await mkdir(dirname(target), { recursive: true, mode: 0o700 });
			// 文件以 0600 写入；同名条目会覆盖前一个，但归档格式本身未禁止重复。
			await pipeline(entry.data, createWriteStream(target, { mode: 0o600 }));
			// 其他顶层路径（plugins/ 等）不属于地址归档，拒绝。
		} else {
			// 错误带具体路径，便于判断归档来源。
			throw new Error(`importData: the archive holds ${entry.path}, which an address archive does not`);
		}
	}
	// 两个必需条目缺一不可；空归档或只有 manifest 的归档被拒绝。
	if (manifest === undefined || storeArchive === undefined) {
		throw new Error("importData: the archive has no manifest.json or store.archive");
		// 返回暂存路径，供 unpackData 建立 store。
	}
	return storeArchive;
}

// 读取 data 的全部字节，超过 limit 抛错；用于小文件 manifest。
/** The bytes of `data`, refused past `limit`. */
// collect 收集所有块后在内存中合并。
async function collect(data: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array> {
	// chunks 保存各段字节。
	const chunks: Uint8Array[] = [];
	// size 累计已读字节数。
	let size = 0;
	// for await 消费异步数据流。
	for await (const chunk of data) {
		// 每读一块先累加再检查，避免超过限制。
		size += chunk.length;
		// 固定错误消息，不包含攻击者可控内容。
		if (size > limit) throw new Error("importData: manifest.json is too large");
		// 未超限才保留该块。
		chunks.push(chunk);
	}
	// Buffer.concat 合并；返回类型是 Uint8Array。
	return Buffer.concat(chunks);
}

// exists 把 stat 的成功/失败转成布尔值；只用于目标目录检查。
/** Whether `path` exists. */
// then 的两个回调分别处理存在与异常。
async function exists(path: string): Promise<boolean> {
	// stat 成功即存在，忽略具体类型。
	return stat(path).then(
		// 任何异常都视为不存在；调用方随后会尝试创建目录并得到具体错误。
		() => true,
		() => false,
	);
}
