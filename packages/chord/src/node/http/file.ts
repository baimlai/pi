// 所属：packages/chord/src/node/http，Chord v2 HTTP 组件的文件响应构造器（slice 10 §2，D5 补充点 1）。
// 职责边界：只负责路径校验、stat、MIME 推导和惰性读取；不负责路由、认证、Range 头解析或实际网络写出。
// 上游入口：路由处理函数调用 fileResponse(path, options) 并把它作为 HttpResponse 返回；组件随后交给 answerOf。
// 下游依赖：node:fs/promises 的 open/realpath/stat、node:path 的 basename/extname/sep、HttpFailure、
// response.ts 的 bytes 分支（按 256 KiB 调用 read）、Ctx.abortSignal（关闭句柄）。
// 结果与错误流向：返回 {kind:"bytes", mime, size, read, ...}；文件不存在/父路径非目录 -> HttpFailure(404)，
// 真实路径在 root 外 -> HttpFailure(403)，其他 stat 错误原样抛出。读取阶段的短读由 response.ts 报告。
// 能力清单：
// - FileResponseOptions：download/inline/root/ranges/mime 五个选项；
// - fileResponse：主入口，stat 文件并返回 bytes 响应描述；
// - inside：校验真实路径是否位于 root 下（内部函数）；
// - opened：打开文件并把关闭动作绑定到请求作用域（内部函数）；
// - MIME/mimeOf：扩展名到安全 MIME 的映射与查询。
// 组合关系：fileResponse 先做 root/realpath 与 stat，再返回惰性 read；response.ts 在消费者拉取时才调用 read，
// opened 在第一次 read 时打开句柄，作用域 abort 时关闭。
// 示例：const response = await fileResponse(resolve("public/logo.png"), {
//   root: resolve("public"), inline: true, mime: "image/png" });
// 建议阅读顺序：先看 FileResponseOptions 与 fileResponse 的返回形状，再看 inside 的边界检查，
// 随后 opened 的句柄生命周期，最后看 MIME 表与 mimeOf。
// File responses (slice 10 §2; decision "Slice 10 fix round, three small points" (1)): a file as a `bytes` response.
// `fileResponse` stats the file at once (with a `root`, its real path must lie inside it); the file handle is opened by
// the first `read` and closed when the request's scope seals (its signal aborts), so a response nobody writes (`HEAD`,
// a 416, a disconnect, a wrap that replaced it) opens nothing and leaks nothing.

import { type FileHandle, open, realpath, stat } from "node:fs/promises";
import { basename, extname, sep } from "node:path";
import type { Context } from "../../context/index.ts";
import { HttpFailure } from "./request.ts";
import type { HttpResponse } from "./response.ts";

/** What `fileResponse` takes besides the path. */
// 选项类型：所有字段只读，编译期检查；root 是运行时的文件系统边界，其余字段影响响应头和读取行为。
export type FileResponseOptions = {
	// 下载文件名；不提供时 disposition 仍标记 attachment，但不带文件名。
	/** Saved under this name. */
	readonly download?: string;
	// true 时 Content-Disposition 用 inline，并追加 sandbox CSP；只允许字面量 true，避免误传 false 产生歧义。
	/** Shown in the browser instead of saved (an image, a video), with a `sandbox` CSP. */
	readonly inline?: true;
	// 根目录边界：提供的路径会先对文件和 root 都做 realpath，再判断文件真实路径是否位于 root 真实路径之下。
	// 这能阻止符号链接指向根目录之外；不提供 root 时完全信任调用方给出的路径。
	/**
	 * The directory the file must lie in once its symbolic links are resolved: one outside it (a link out) is refused
	 * 403. Without it the path is trusted (a plugin's own file).
	 */
	readonly root?: string;
	// 只有提供 size 且 ranges 为 true 时才支持单段 Range；音频/视频拖动进度依赖它。
	/** Whether a single range is answered 206 (audio and video seek with it). */
	readonly ranges?: boolean;
	// 显式 MIME；缺省按扩展名查表，未知扩展名用 application/octet-stream。
	/** The type; by default from the extension (text, images, audio, video), else `application/octet-stream`. */
	readonly mime?: string;
};

// 函数用途：把给定路径变成 bytes 响应。输入路径和选项，输出 HttpResponse（异步，因为要先 stat）。
// 错误路径：文件不存在/父路径不是目录 -> HttpFailure(404)；root 校验失败 -> HttpFailure(403)；
// 其他 stat 错误（如权限）原样抛出，由组件报告为 500。
// 副作用：现在 stat 一次；文件内容不会被立即读取，句柄由第一次 read 打开并在请求作用域结束时关闭。
// 例子：await fileResponse("public/a.txt", {root:"public"}) => {kind:"bytes", mime:"text/plain; charset=utf-8", size:3, read}。
/**
 * The file at `path` as a `bytes` response; `HttpFailure` 404 for a missing one (anyone may ask for one: no failure
 * of the route, Fable's recheck N1), 403 for one outside `root`; throws what else `stat` throws.
 */
export async function fileResponse(given: string, options: FileResponseOptions = {}): Promise<HttpResponse> {
	// path 在 try 内赋值：root 校验可能抛 403，stat 可能抛 404/其他错误。
	let path: string;
	let size: number;
	try {
		// 有 root 时先解析真实路径并检查包含关系；没有则直接使用给定路径。
		path = options.root === undefined ? given : await inside(given, options.root);
		// 只取 size；文件类型、句柄和内容都留到后续处理。
		({ size } = await stat(path));
	} catch (error) {
		// 把 Node 错误码转成 HTTP 语义；ENOENT（不存在）和 ENOTDIR（父路径不是目录）都视为 404。
		const code = (error as NodeJS.ErrnoException).code;
		// 其他错误不伪装成 404，保留原始错误交给上层报告。
		if (code === "ENOENT" || code === "ENOTDIR") throw new HttpFailure(404, "no such file");
		throw error;
	}
	// 句柄 Promise 延迟创建：第一次 read 才打开文件；多个分块读取共享同一个 Promise。
	let handle: Promise<FileHandle> | undefined;
	// read 回调：输入偏移、期望长度和请求上下文，输出实际读到的字节（可能短于 length）。
	// ctx.abortSignal 在请求作用域结束时触发，opened() 注册的监听器会关闭句柄。
	const read = async (offset: number, length: number, context: Context): Promise<Uint8Array> => {
		// ??= 只在 handle 仍为 undefined 时调用 opened；并发读取不会打开两个句柄。
		handle ??= opened(path, context);
		const file = await handle;
		// Only the bytes read are handed out.
		// 分配未初始化缓冲区提高速度；不能把整个缓冲区返回，只返回 subarray 的实际读取部分。
		const buffer = Buffer.allocUnsafe(length);
		// file.read 从文件 offset 处读最多 length 字节；bytesRead 可能小于请求长度（文件末尾或并发截断）。
		const { bytesRead } = await file.read(buffer, 0, length, offset);
		// subarray 是共享底层 Buffer 的视图，不复制；bytesAnswer 会检查短读并把它当作失败。
		return buffer.subarray(0, bytesRead);
	};
	// 返回响应描述；条件展开（...）只在选项存在时添加对应字段，避免把 undefined 写进对象。
	// 这是 TypeScript/JavaScript 的对象展开语法；运行时生成新对象，不修改 options。
	return {
		kind: "bytes",
		// MIME 由调用方显式指定优先，否则按路径扩展名推导。
		mime: options.mime ?? mimeOf(path),
		size,
		read,
		...(options.download === undefined ? {} : { download: options.download }),
		...(options.inline === undefined ? {} : { inline: options.inline }),
		...(options.ranges === undefined ? {} : { ranges: options.ranges }),
	};
}

/** The real path of `path` when it lies inside `root`'s real path; `HttpFailure` 403 otherwise. */
// 函数用途：验证 path 的真实路径位于 root 的真实路径内。输入两个路径，输出文件的真实路径或抛 403。
// 例子：root=/srv/www，path=/srv/www/link -> link 指向 /etc/passwd 时，realpath 后不在 root 下，抛 403。
// 使用 Promise.all 并行解析两个 realpath；边界比较加上分隔符，防止 /srv/www2 被误认为在 /srv/www 内。
async function inside(path: string, root: string): Promise<string> {
	// real 是文件的真实路径，base 是 root 的真实路径；符号链接在这里被展开。
	const [real, base] = await Promise.all([realpath(path), realpath(root)]);
	// 完全相等或位于 base + 分隔符之下才允许；base 已以分隔符结尾时不重复添加。
	if (real !== base && !real.startsWith(base.endsWith(sep) ? base : base + sep)) {
		throw new HttpFailure(403, "the file lies outside its root");
	}
	return real;
}

/** Opens `path`, closed when `context` (the request's scope) aborts; at once when it aborted already. */
// 函数用途：打开文件并把关闭动作绑定到请求作用域的取消信号。输入路径和上下文，输出 FileHandle。
// 副作用：打开文件描述符；如果打开后发现信号已取消，立即关闭。没有 abortSignal 表示在请求作用域外读取，
// 无法保证关闭时机，因此直接抛错（属于编程错误，不是 HTTP 失败）。
// 例子：正常请求结束时 context.abortSignal 触发，close 回调执行 file.close()。
async function opened(path: string, context: Context): Promise<FileHandle> {
	// 以只读模式打开；这一步可能抛 ENOENT 等错误（stat 之后文件被删除），由调用方处理。
	const file = await open(path, "r");
	// close 忽略关闭错误：句柄可能已经关闭，清理路径不应再抛错；void 表示有意不等待结果。
	const close = (): void => void file.close().catch(() => {});
	const signal = context.abortSignal;
	if (signal === undefined) throw new Error(`fileResponse(${basename(path)}): read outside a request's scope`);
	// 已取消则同步关闭；否则注册一次性 abort 监听。
	if (signal.aborted) close();
	else signal.addEventListener("abort", close, { once: true });
	return file;
}

// 扩展名到 MIME 的白名单：只列出安全的文本、图片、音频和视频类型；HTML/SVG 不在其中，避免上传内容被当作脚本执行。
// 未知扩展名回退到 application/octet-stream，浏览器会下载而不是内联渲染。
const MIME: Readonly<Record<string, string>> = {
	".txt": "text/plain; charset=utf-8",
	".log": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".ogg": "audio/ogg",
	".opus": "audio/ogg",
	".wav": "audio/wav",
	".flac": "audio/flac",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
};

// 函数用途：按扩展名推导 MIME。输入路径，输出类型字符串，无 I/O、不抛错。
// extname 取最后一个点后的扩展名并转小写；表外类型统一二进制流。
/**
 * The type of `path` by its extension: text, images, audio and video only. Active types (HTML, SVG) never come from
 * here: a route serving one names it (`mime`).
 */
function mimeOf(path: string): string {
	return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}
