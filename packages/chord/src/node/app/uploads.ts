// Chunked uploads of one `Files` object (slice 13 §4, design §23 "Chunked transfers"): each upload one file handle in
// the run's directory, written at positions. An append is accepted at the offset the accepted appends reached, so a
// writer may send several without waiting (the call window allows it): each write lands at its own position whatever
// order the thread pool completes them in. `uploaded`, `finish` and expiry wait for an upload's writes in flight; a
// failed write ends its upload.
// 所属：packages/chord/src/node/app，单个 Files 对象的分块上传管理器（slice 13 §4；design §23）。
// 职责边界：持有上传文件句柄、按 offset 接受写入、等待在途写、过期或结束时清理；不维护索引，不做容量策略。
// 上游：files.ts 的 begin/append/uploaded/finish/expire/close 调用；下游：node:fs/promises 的文件句柄。
// 结果与错误：begin 返回 id（超额抛 unavailable/busy）；append/uploaded/finish/expire/close 返回 void、字节数或 Finished；未知 id 或写失败抛 invalid。
// 能力清单：Upload/Finished 是类型；Uploads 类管理集合与 #underway/#discard/#end；failedUpload 构造错误。
// 组合顺序：begin → append（可并发）→ uploaded 续传 → finish（rename）或 expire/close（discard）。
// 示例：const upload = await files.begin({ name: 'big.bin', mime: 'application/octet-stream' }, ctx); await files.append({ upload, offset: 0, bytes }, ctx)。
// 建议阅读顺序：先看 Upload 字段与 begin/size，再看 append/uploaded/finish，最后 expire/close/#end。

import type { FileHandle } from "node:fs/promises";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { ChordError } from "../../data/index.ts";
import { invalid } from "../../data/internal.ts";
import { newToken } from "./secrets.ts";

// Upload 是内存中的上传记录；字段区分不变元数据、可变进度和异步写入集合。
/** An upload under way: its file, the bytes accepted, its writes in flight, its first failed write, its end. */
// name/mime 在 finish 时返回；size 是已接受字节数，touched 用于过期判断。
type Upload = {
	readonly name: string;
	readonly mime: string;
	// handle 是打开的文件，writes 保存尚未落地的 Promise，failed 表示有写失败。
	readonly handle: FileHandle;
	size: number;
	touched: number;
	// Set<Promise<unknown>> 只用于等待；写入本身在 append 中 await。
	readonly writes: Set<Promise<unknown>>;
	failed: boolean;
	// ended 是延迟创建的关闭 Promise，保证多个结束路径只关闭一次。
	ended: Promise<void> | undefined;
};

// Finished 是 finish 的结果；size 是上传总字节数，不包含 MIME 猜测。
/** A finished upload: its name, type and size, its bytes moved to the path `finish` was given. */
export type Finished = { readonly name: string; readonly mime: string; readonly size: number };

// 管理一个 Files 对象的上传集合：run 是本次运行专属目录，max 是同时进行上限。
// begin 超过上限抛 unavailable/busy；每个上传持有文件句柄直到结束，调用方必须 finish 或等待过期。
// 例子：new Uploads(run, 64) 后 begin 返回随机 id，append 用它定位文件。
/**
 * The uploads under way of one `Files` object, in the directory `run` (this object's own, made on first use), at most
 * `max` at once: each holds a file handle until it ends, so a caller beginning uploads without end would exhaust the
 * process's descriptors.
 */
// run/max 只读；Map 以随机 id 为键，插入顺序不用于淘汰。
export class Uploads {
	readonly #run: string;
	readonly #max: number;
	readonly #uploads = new Map<string, Upload>();

	// 保存目录与上限；这里不创建目录，begin 时才 mkdir。
	constructor(run: string, max: number) {
		this.#run = run;
		this.#max = max;
	}

	// 汇总所有进行中上传已接受的字节数，用于 Files 的总容量检查。
	/** The bytes accepted by every upload under way (they count against the host's cap). */
	get size(): number {
		// 从 0 开始累加。
		let size = 0;
		// 只统计仍在 Map 中的上传；已结束上传的文件不再计入总容量。
		for (const upload of this.#uploads.values()) size += upload.size;
		return size;
	}

	// 开始一个上传：输入文件名和 MIME，输出随机上传 id。超过并发上限抛 busy；目录或文件创建失败向上传播。
	// 创建 0700 目录和 0600 独占文件，保证其他本地用户不能读取半成品。
	/** A new upload of `name` and `mime`: its id; `unavailable` (`busy`) while `max` are under way. */
	async begin(name: string, mime: string): Promise<string> {
		// 先检查名额，再分配 id 和文件句柄。
		if (this.#uploads.size >= this.#max) {
			// ChordError 使用 unavailable 与 reason busy；消息说明如何恢复。
			throw new ChordError({
				code: "unavailable",
				reason: "busy",
				message: `files: ${this.#max} uploads are under way; finish one, or wait for an idle one to expire`,
			});
		}
		// 12 字节随机值编码成 16 个字符，用作文件名和调用方持有的上传 id。
		const id = newToken(12);
		// 目录已存在时 recursive 不报错；mode 只影响新建目录。
		await mkdir(this.#run, { recursive: true, mode: 0o700 });
		// wx 要求文件不存在且只创建一次，0o600 限制为当前用户读写。
		const handle = await open(join(this.#run, id), "wx", 0o600);
		// 记录上传的初始状态；size 从 0 开始，touched 供过期扫描使用。
		const upload: Upload = {
			name,
			mime,
			handle,
			size: 0,
			touched: Date.now(),
			writes: new Set(),
			failed: false,
			ended: undefined,
		};
		// 只有文件和记录都创建成功后才放进 Map，失败不会留下半个名额。
		this.#uploads.set(id, upload);
		// 返回 id 给调用方；服务端不保存其他句柄。
		return id;
	}

	// 按 offset 写入一块：id 必须存在且 offset 等于已接受字节数，否则 invalid(args) 并在 details 给出期望 offset。
	// room 先检查容量；接受后先增加 size 再启动写入，使下一个 append 可以立即用新 offset。
	// 写入失败会结束上传、删除文件并抛出原始错误；成功返回 void。
	/**
	 * Writes `bytes` at `offset` of upload `id`, which must be where the accepted appends reached (else `invalid`, its
	 * details the expected `{ offset }`); `room(adding, fileSize)` refuses what the caps do not allow, before anything
	 * is accepted. A failed write ends the upload.
	 */
	async append(
		id: string,
		offset: number,
		bytes: Uint8Array,
		room: (adding: number, fileSize: number) => void,
	): Promise<void> {
		// 先确认上传仍在进行中，否则得到统一 invalid。
		const upload = this.#underway(id);
		// 偏移必须精确接在已接受字节之后；不等待在途写完成，因此允许连续并发发送。
		if (offset !== upload.size) {
			// invalid 的 details 带上传当前 offset，调用方可据此续传。
			throw invalid("args", `files: upload ${id} is at offset ${upload.size}, not ${offset}`, {
				offset: upload.size,
			});
		}
		// 在上限检查通过前不改变任何状态；room 由 Files 提供，会计入其他上传。
		room(bytes.length, upload.size + bytes.length);
		// Accepted now, with no await before the write starts: the next append may follow at once, its write going to
		// its own position.
		// 先接受字节数，再启动异步写；这是并发 append 各自拿到正确位置的关键。
		upload.size += bytes.length;
		// 更新活跃时间，避免正在写的上传被过期扫描删除。
		upload.touched = Date.now();
		// FileHandle.write 从 buffer 的 0 位置写 bytes.length 字节到文件 offset。
		const write = upload.handle.write(bytes, 0, bytes.length, offset);
		// 把写 Promise 记入集合，finish/uploaded/expire 会等待它落地。
		upload.writes.add(write);
		// try/catch 包住 await，捕获底层 I/O 错误。
		try {
			await write;
			// 失败时先从集合移除，避免 #end 再次等待同一个失败的 Promise。
		} catch (error) {
			upload.writes.delete(write);
			// 只有第一次失败负责清理；后续并发失败直接抛错。
			if (!upload.failed) {
				// 标记失败，uploaded/finish 会据此拒绝。
				upload.failed = true;
				// 从 Map 移除，新的 append 找不到该 id。
				this.#uploads.delete(id);
				// 等待其余写并关闭句柄。
				await this.#end(upload);
				// force 让文件不存在也不报错；删除半成品。
				await rm(join(this.#run, id), { force: true });
			}
			// 把原始 I/O 错误交给调用方。
			throw error;
		}
		// 成功写完成后从集合移除，避免长期积累 Promise。
		upload.writes.delete(write);
	}

	// 等待在途写完成，返回已接受字节数；上传已结束或不存在时 invalid，写失败时也 invalid。
	/** The bytes of upload `id` written so far, once its writes in flight landed: where a writer resumes. */
	async uploaded(id: string): Promise<number> {
		// 先确认上传还在进行中。
		const upload = this.#underway(id);
		// allSettled 等所有写结束；单个失败不会让这里提前拒绝。
		await Promise.allSettled([...upload.writes]);
		// 写失败可能已从 Map 删除，因此要显式检查 failed。
		if (upload.failed) throw failedUpload(id);
		// 返回接受的总字节数；调用方据此续传。
		return upload.size;
	}

	// 结束上传并把它移动到 path：先从 Map 移除，等待写完成、检查失败，然后 rename。
	// 输入 id 与目标路径，返回 Finished；失败时抛错，文件可能已删除或未移动。例子：finish(id, target) 后目标出现且上传 id 失效。
	/** Ends upload `id` once its writes landed and moves its file to `path`; refused when a write of it failed. */
	async finish(id: string, path: string): Promise<Finished> {
		// 确认上传存在；已结束的上传不能再 finish。
		const upload = this.#underway(id);
		// Taken out first: an append arriving now finds no upload.
		// 先取出，之后到来的 append 会立刻得到 invalid。
		this.#uploads.delete(id);
		// 等待在途写并关闭文件句柄。
		await this.#end(upload);
		// 任何一次写失败都不能发布半成品。
		if (upload.failed) throw failedUpload(id);
		// 同一文件系统内 rename 是原子的；调用方已检查目标不存在。
		await rename(join(this.#run, id), path);
		// 返回元数据；size 是上传期间累计的字节数。
		return { name: upload.name, mime: upload.mime, size: upload.size };
	}

	// 丢弃闲置至少 idleMs 的上传；遍历中删除 Map 项是安全的，尚未访问的项仍会被处理。
	/** Drops the uploads unwritten for `idleMs`, once their writes landed. */
	async expire(idleMs: number): Promise<void> {
		// 用一次 now 作为整轮扫描的时间基准。
		const now = Date.now();
		// 用 for...of 迭代 Map 的 [id, upload] 项。
		for (const [id, upload] of this.#uploads) {
			// 达到闲置阈值就等待写完成、关闭并删除文件。
			if (now - upload.touched >= idleMs) await this.#discard(id, upload);
		}
	}

	// 对象结束时丢弃所有进行中上传；等待所有关闭完成。
	/** Drops every upload under way (their object ended). */
	async close(): Promise<void> {
		// 逐个处理；#discard 内部会删除 Map 项。
		for (const [id, upload] of this.#uploads) await this.#discard(id, upload);
	}

	// 查找进行中上传；没有时抛出 invalid，消息列出可能原因（完成、失败、过期或未知）。
	/** The upload `id` under way; else `invalid`. */
	#underway(id: string): Upload {
		const upload = this.#uploads.get(id);
		if (upload === undefined) throw invalid("args", `files: no upload ${id} (finished, failed, expired or unknown)`);
		return upload;
	}

	// 从 Map 取出、等待写入并关闭句柄、删除文件；三个步骤都完成后返回。
	/** Takes upload `id` out, closes its file once its writes landed and removes it. */
	async #discard(id: string, upload: Upload): Promise<void> {
		// 先删除，避免扫描或新请求再找到它。
		this.#uploads.delete(id);
		// 等待在途写并关闭句柄。
		await this.#end(upload);
		// force 忽略文件已不存在的错误。
		await rm(join(this.#run, id), { force: true });
	}

	// 为上传创建一次性的结束 Promise：等待所有已登记的写，再关闭句柄；??= 保证只执行一次。
	/** Closes `upload`'s file once its writes in flight landed; once, whoever ends it first. */
	#end(upload: Upload): Promise<void> {
		// allSettled 等待成功和失败；关闭结果作为 Promise 结果返回。
		upload.ended ??= Promise.allSettled([...upload.writes]).then(() => upload.handle.close());
		return upload.ended;
	}
}

// 构造写失败上传的 invalid 错误；调用方拿到上传 id 和固定解释。
/** The refusal of an upload one of whose writes failed. */
function failedUpload(id: string): Error {
	// 错误码是 invalid(args)，因为上传已不可继续。
	return invalid("args", `files: upload ${id} failed to write and was dropped`);
}
