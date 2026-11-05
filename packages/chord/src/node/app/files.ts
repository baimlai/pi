// Files (slice 13 §4, decision "The app kit, point 5: plugins, files and export"): the kit's file storage, one `Files`
// object per host (`self.get(Files, {})`), its files in the host's directory (`files/`) and its index (id, name, mime,
// size, created) a watchable member kept in the store. Small files in one call (`put`), large ones in chunks (design
// §23 "Chunked transfers": `begin`, `append` at the stored offset, `uploaded` to resume after a drop, `finish`;
// unfinished uploads expire), reads by range, caps per host. Plugins never see a path.

// 所属：packages/chord/src/node/app，app kit 的每主机文件存储（slice 13 §4；decision 点 5）。
// 职责边界：维护文件索引、写文件、分块上传、范围读取、删除和容量上限；不暴露真实路径，不负责 HTTP 传输。
// 上游：app.ts/worker.ts 用 filesFacet 注册 Files 对象；下游：uploads.ts 管理句柄，documents 持久化索引，node:fs 写文件。
// 结果与错误：方法返回 id、字节、元数据或 null；单文件或总量超限抛 too_large，未知 id 抛 invalid，并发上传上限抛 unavailable/busy，I/O 错误向上传播。
// 能力清单：FileInfo/FilesCaps 是类型；Files 是本地契约；filesFacet 创建 facet；FilesIndex 是持久索引；MAX_PIECE/UPLOAD_IDLE_MS/SWEEP_MS 是限制；sweep 清理旧上传；tooLarge 构造错误。
// 组合顺序：filesFacet → host.serve → index/underway/room → list/put/begin/append/finish/read/remove；onLive 启动 sweep。
// 示例：const files = await ctx.get(Files, {}); const id = await files.put({ name: 'a.txt', mime: 'text/plain', bytes }, ctx)。
// 建议阅读顺序：先看 Files 契约与 FileInfo/FilesCaps，再看 filesFacet 的 room 和各方法，最后 sweep/tooLarge。
import { mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { arr, bytes, int, local, map, method, num, obj, str } from "../../contracts/index.ts";
import { ChordError, type Principal } from "../../data/index.ts";
import { invalid } from "../../data/internal.ts";
import { defineState } from "../../documents/index.ts";
import { type Ctx, defineFacet, type Facet } from "../../host/index.ts";
import { newToken } from "./secrets.ts";
import { Uploads } from "./uploads.ts";

// FileInfo 是 list 返回的只读元数据；id 由服务端生成，created 是毫秒时间戳。
/** A file as the index lists it. */
export type FileInfo = {
	readonly id: string;
	readonly name: string;
	readonly mime: string;
	readonly size: number;
	readonly created: number;
};

// FilesCaps 的两个可选字节上限；缺省值在 filesFacet 中填入，调用方不用知道默认常量。
/** The caps of one host's files (bytes). */
export type FilesCaps = {
	/** The largest file: 256 MiB by default. */
	readonly maxFile?: number;
	/** All files together: 4 GiB by default. */
	readonly maxTotal?: number;
};

// Entry 是索引里一项的运行时 schema：size 必须是整数，created 是数字；它不包含 id，因为 id 是映射的键。
/** One file's fields in the index. */
const Entry = obj({ name: str(), mime: str(), size: int(), created: num() });

// Files 是空参数的本地契约；每主机至多一个对象，方法参数和结果都由 schema 在调用边界校验。
/** The host's files (one per host): the index, small and chunked writes, ranged reads, removal. */
export const Files = local("chord.app.files", {
	version: 1,
	params: {},
	members: {
		// list 是状态成员（数组），随索引文档变化；id 从映射键补回。
		list: arr(obj({ id: str(), name: str(), mime: str(), size: int(), created: num() })),
		// put 接收名称、MIME 和字节数组，返回 id；单次最多 4 MiB，超过由实现抛 too_large。
		/** Stores a small file (at most 4 MiB) in one call; its id. */
		put: method(obj({ name: str(), mime: str(), bytes: bytes() }), str()),
		// begin 只拿名称和 MIME，返回上传 id；并发上传达到上限时返回 unavailable/busy。
		/** Starts a chunked upload; its upload id. `unavailable` (`busy`) while the host's cap of uploads are under way. */
		begin: method(obj({ name: str(), mime: str() }), str()),
		// append 接收上传 id、偏移和字节块；offset 必须等于当前已接受字节数，否则 invalid 的 details 给出正确值。
		/**
		 * Appends a chunk (at most 4 MiB; about 1 MiB is the usual size) to upload `upload` at `offset`, which must be
		 * the bytes stored so far (else `invalid`, its details `{ offset }` the stored one).
		 */
		append: method(obj({ upload: str(), offset: int({ min: 0 }), bytes: bytes() })),
		// uploaded 返回该上传已写入磁盘的字节数，断线后据此续传。
		/** The bytes stored so far of upload `upload`: where a writer resumes after a drop. */
		uploaded: method(str(), int()),
		// finish 结束上传并把它变成正式文件，返回新文件 id。
		/** Ends upload `upload`: the file it made, its id. */
		finish: method(str(), str()),
		// read 读取指定范围；到文件末尾会少返回，offset 或 length 越界不会自动截断 offset。
		/** `length` bytes of file `id` from `offset` (fewer at its end). */
		read: method(obj({ id: str(), offset: int({ min: 0 }), length: int({ min: 0 }) }), bytes()),
		// remove 删除文件；未知 id 视为已经删除，不报错。
		/** Removes file `id` (an unknown one: nothing). */
		remove: method(str()),
	},
});

// FilesIndex 是持久文档：files 映射 id 到 Entry；磁盘文件和索引需要一起维护。
/** The index document. */
// 文档版本与契约版本独立；persist 让索引在重启后保留。
const FilesIndex = defineState("chord.app.files", {
	// schema 决定运行时校验：map 的键是字符串，值必须符合 Entry。
	schema: obj({ files: map(Entry) }),
	version: 1,
	initial: () => ({ files: {} }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 50,
});

// 单次 put/append/read 的上限 4 MiB，远低于链路单个 part 的限制，避免一次调用撑爆内存。
/** The largest piece a call carries (a `put`, an `append`, a `read`): 4 MiB, well under a link's part limit. */
const MAX_PIECE = 4 * 1024 * 1024;

// 上传一小时没有写入就被过期扫描删除。
/** How long an upload may go unwritten before it expires: an hour. */
const UPLOAD_IDLE_MS = 60 * 60_000;

// 扫描间隔一分钟；与 UPLOAD_IDLE_MS 共同决定何时回收。
/** How often expired uploads are dropped: every minute. */
const SWEEP_MS = 60_000;

// 创建 Files 的 facet：输入文件目录 dir、容量 caps 和并发上传上限 uploads，返回 Facet<P>。
// 副作用在对象创建/使用后发生：建立上传目录、写文件、更新索引；这里只做常量计算和声明。
// 错误路径：超过单文件/总量上限抛 too_large，未知 id 抛 invalid，并发 begin 抛 unavailable/busy，文件 I/O 错误向上传播。
// 例子：filesFacet(join(hostDir, 'files'), { maxFile: 1000 }) 创建对象；插件按契约读写，看不到真实目录。
/**
 * The kit's facet serving `Files` with the host's files directory `dir` (`<host dir>/files`), `caps` and at most
 * `uploads` uploads under way (64 by default). Uploads under way live in `dir/.uploads/<run>/` (`Uploads`) and end with
 * the object (an unfinished one is dropped when the next one goes live).
 */
export function filesFacet<P extends Principal>(dir: string, caps: FilesCaps = {}, uploads = 64): Facet<P> {
	// 单文件默认 256 MiB；两个上层上限都可通过 options 覆盖。
	const maxFile = caps.maxFile ?? 256 * 1024 * 1024;
	// 总容量默认 4 GiB，统计已完成文件加进行中上传。
	const maxTotal = caps.maxTotal ?? 4 * 1024 * 1024 * 1024;
	// 上传临时目录固定在 files/.uploads 下；sweep 会清理其他运行留下的子目录。
	const uploadsDir = join(dir, ".uploads");
	// defineFacet 的 setup 在加载时执行；host 可用于读取其他对象（这里未使用）。
	return defineFacet<P>((host) =>
		// host.serve 注册 Files 对象工厂；函数体只在该对象被创建时执行一次。
		host.serve(Files, (_params, self) => {
			// 取得持久索引文档的状态句柄。
			const index = self.state(FilesIndex);
			// This run's uploads in their own directory: an upload left by an earlier run (its process ended) can never
			// finish and is dropped, while this run's may already have begun.
			// 每次进程运行生成独立的上传子目录；旧运行的上传无法续写，会被 sweep 删除，本次运行的上传可能已经开始。
			const run = join(uploadsDir, newToken(12));
			// Uploads 管理本运行的所有分块上传；上限就是 uploads 参数。
			const underway = new Uploads(run, uploads);
			// Uploads under way count against the total too: two of them cannot pass it together.
			// room 在真正写入前统一检查容量；adding 是本次新增字节，fileSize 是写入后的单文件大小。
			const room = (adding: number, fileSize: number): void => {
				// 单文件超限直接抛 too_large。
				if (fileSize > maxFile)
					// 消息包含实际值和上限，便于调用方调整。
					throw tooLarge(`a file of ${fileSize} bytes is larger than this host's cap (${maxFile})`);
				// reduce 汇总索引中所有已完成文件的大小；隐藏的上传目录不在索引中。
				const stored = Object.values(index.value.files).reduce((sum, file) => sum + file.size, 0);
				// 总量把已完成尺寸、进行中上传已接受字节和本次新增一起计算，避免两个上传各自通过检查后合计超限。
				if (stored + underway.size + adding > maxTotal) {
					// 总量超限同样抛 too_large。
					throw tooLarge(`this host's files would exceed their cap (${maxTotal} bytes)`);
				}
			};
			// 对象进入 live 状态后启动清理 routine；它随对象结束而停止。
			self.onLive((ctx) => sweep(uploadsDir, run, underway, ctx));
			// fileOf 把调用方 id 映射为元数据；内部仍以索引为准。
			const fileOf = (id: string): FileInfo | undefined =>
				// A trust boundary: `id` is the caller's (`Object.hasOwn`: no inherited member is a file).
				// Object.hasOwn 是信任边界：constructor、__proto__ 等继承键不算文件；展开语法把 id 和 Entry 合成 FileInfo。
				Object.hasOwn(index.value.files, id) ? { id, ...index.value.files[id]! } : undefined;
			// 返回对象实现契约的全部成员。
			return {
				// list 从索引派生；解构只取 Entry 字段，再补回映射键 id。
				list: self.derive([index], ([value]) =>
					Object.entries(value.files).map(([id, { name, mime, size, created }]) => ({
						id,
						name,
						mime,
						size,
						created,
					})),
				),
				// put 是同步写入小文件的快捷路径；先检查单次字节数上限。
				put: async ({ name, mime, bytes }, ctx) => {
					// 4 MiB 限制是每调用限制，与 maxFile 的单文件上限独立。
					if (bytes.length > MAX_PIECE)
						throw tooLarge(`put takes at most ${MAX_PIECE} bytes: use begin, append, finish`);
					// room 同时检查 maxFile 与 maxTotal；此时单文件大小就是本次字节数。
					room(bytes.length, bytes.length);
					// 文件 id 使用 12 字节随机值，避免调用方控制路径。
					const id = newToken(12);
					// 目录按需创建并设为 0700；recursive 允许并发调用重复创建。
					await mkdir(dir, { recursive: true, mode: 0o700 });
					// writeFile 以 0600 新建；默认会截断同名文件，但 id 随机，碰撞概率可忽略。
					await writeFile(join(dir, id), bytes, { mode: 0o600 });
					// 先写文件再改索引；如果索引提交失败，文件会留下但 list 看不到。
					await index.change((draft) => {
						draft.files[id] = { name, mime, size: bytes.length, created: Date.now() };
					}, ctx);
					return id;
				},
				// begin 直接把参数交给 Uploads，返回上传 id。
				begin: ({ name, mime }) => underway.begin(name, mime),
				// append 增加单次大小检查后转交 Uploads；room 回调让管理器在写入前检查总容量。
				append: async ({ upload, offset, bytes }) => {
					if (bytes.length > MAX_PIECE) throw tooLarge(`append takes at most ${MAX_PIECE} bytes`);
					// 返回 null 表示成功；appends 本身返回 void。
					await underway.append(upload, offset, bytes, room);
					return null;
				},
				// uploaded 直接转发，得到续传偏移。
				uploaded: (upload) => underway.uploaded(upload),
				// finish 先分配正式文件 id，再等待上传写入完成并移动到目标路径。
				finish: async (upload, ctx) => {
					// 正式 id 与上传 id 不同；上传 id 在 finish 后失效。
					const id = newToken(12);
					// 确保 files/ 目录存在且私有。
					await mkdir(dir, { recursive: true, mode: 0o700 });
					// underway.finish 等待在途写、关闭句柄并 rename；返回上传时记录的名称、MIME 和大小。
					const { name, mime, size } = await underway.finish(upload, join(dir, id));
					// 文件移动成功后才把索引项加入文档；索引提交失败时文件已存在但不会被列出。
					await index.change((draft) => {
						draft.files[id] = { name, mime, size, created: Date.now() };
					}, ctx);
					// 返回新文件 id。
					return id;
				},
				// read 按 id 查索引，未知文件在打开磁盘前就拒绝。
				read: async ({ id, offset, length }) => {
					const file = fileOf(id);
					// 未知 id 使用 invalid(args)，不泄露磁盘路径。
					if (file === undefined) throw invalid("args", `files: no file ${id}`);
					// 一次读取最多 4 MiB，避免内存无界。
					if (length > MAX_PIECE) throw tooLarge(`read takes at most ${MAX_PIECE} bytes`);
					// 以只读模式打开已完成文件；文件名就是随机 id。
					const handle = await open(join(dir, id), "r");
					// try/finally 保证句柄在任何返回路径都关闭。
					try {
						// buffer 长度取 length 与剩余字节的较小值；offset 超过文件大小时 max(0) 防止负数。
						const buffer = new Uint8Array(Math.max(0, Math.min(length, file.size - offset)));
						// FileHandle.read 从文件 offset 读取，返回实际读到的 bytesRead。
						const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
						// subarray 去掉缓冲区尾部未填满的部分。
						return buffer.subarray(0, bytesRead);
					} finally {
						// 关闭句柄；关闭失败会覆盖前面的返回值并抛错。
						await handle.close();
					}
				},
				// remove 先确认文件存在；未知 id 直接成功，实现幂等。
				remove: async (id, ctx) => {
					// 没有索引项就没有文件可删，返回 null。
					if (fileOf(id) === undefined) return null;
					// 先删索引项，避免删除文件后仍被列出。
					await index.change((draft) => {
						delete draft.files[id];
					}, ctx);
					// force 让已不存在的文件也不报错；删除失败会抛错，索引已经先删除。
					await rm(join(dir, id), { force: true });
					// 返回 null 表示成功。
					return null;
				},
			};
		}),
	);
}

// Files 对象的清理 routine：先删除其他运行遗留的上传目录，再每分钟丢弃闲置一小时的上传，对象结束时关闭所有上传。
// 输入上传根目录、本次 run 目录、Uploads 和上下文；返回 Promise，随对象 abort 结束。错误由 host 的 routine 处理。
/**
 * The files object's routine once live: drops the uploads earlier runs left (every directory under `uploadsDir` but
 * `run`), then every minute the uploads unwritten for an hour; when the object ends, every upload still under way.
 */
async function sweep(uploadsDir: string, run: string, uploads: Uploads, ctx: Ctx): Promise<void> {
	// readdir 读不到目录时返回空数组；递归删除其他 run，保留本次 run。
	for (const entry of await readdir(uploadsDir).catch(() => [])) {
		// 路径比较用 join 后的规范形式；recursive 处理 run 目录内的文件。
		if (join(uploadsDir, entry) !== run) await rm(join(uploadsDir, entry), { recursive: true, force: true });
	}
	// try/finally 保证 routine 被取消时执行上传清理。
	try {
		// 无限循环直到 sleep 因 abort 拒绝。
		for (;;) {
			// sleep 接受 abortSignal；对象结束时 Promise 拒绝，跳出循环。
			await sleep(SWEEP_MS, undefined, { signal: ctx.abortSignal });
			// 每轮扫描闲置上传并删除其文件。
			await uploads.expire(UPLOAD_IDLE_MS);
		}
	} finally {
		// 只有 abort 导致的结束才关闭上传；其他异常不在这里吞掉。
		if (ctx.abortSignal?.aborted === true) await uploads.close();
	}
}

// 构造容量拒绝错误；code 固定为 too_large，消息统一加 files: 前缀。
/** A cap refused a write. */
// 返回 ChordError 而不是直接抛，便于调用处 throw tooLarge(...)。
function tooLarge(message: string): ChordError {
	return new ChordError({ code: "too_large", message: `files: ${message}` });
}
