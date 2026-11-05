// 所属：packages/chord/src/node/http，Chord v2 HTTP 组件的响应翻译模块（slice 10 §2，设计 D5/R6）。
// 职责边界：只把路由返回的描述对象变成内部 Answer，并决定状态、头、body 与 Range；不写网络、不做准入/认证/路由。
// 上游入口：http.ts 的 #run 在路由链成功后调用 answerOf，传入已由 DefaultHeaders 填好的头和请求 Ctx。
// 下游依赖：AnswerHeaders（头校验与多行）、HttpResponse（描述类型）、Ctx.abortSignal（流封口）、node:http 的 STATUS_CODES。
// 结果与错误流向：正常返回 Answer 给 Node 监听器或 webResponse；非法头/无法 JSON 序列化同步抛出，由调用方回答 500；
// bytes 读取失败通过 failed 回调报告并在流上 error，连接随后被销毁。
// 能力清单：
// - HttpResponse：路由可返回的五类响应描述联合（json/html/bytes/redirect/error）；
// - Answer：组件内部的“状态 + 已校验头 + body”结果；
// - ResponseFailure：bytes 短读或读取抛错时使用的错误；
// - answerOf：把描述翻译成 Answer 的核心入口；
// - errorAnswer：生成状态码加标准 reason phrase 的错误响应；
// - webResponse：把 Answer 转成标准 Web Response。
// 组合关系：路由 -> answerOf ->（bytes 时）pulled 创建的 ReadableStream -> Node write/pump 或 webResponse；
// HEAD 与 204/205/304 在 whole 中统一去掉 body，Range 只在 bytesAnswer 中处理。
// 示例：const answer = answerOf({ kind: "json", value: { ok: true } }, request, defaults, ctx, report);
// 建议阅读顺序：先看 HttpResponse/Answer 了解数据形状，再看 answerOf 的分支，随后 whole、bytesAnswer、pulled，
// 最后看 rangeOf 与 disposition 的协议细节。
// Responses (slice 10 §2, D5, R6; decision "The HTTP component's security baseline" (4), (6)): routes return
// descriptions and the component turns them into an answer, a status, headers and a body: the default headers first,
// the response's own replacing same-named ones (validated: a CR or LF throws), `json`, `html`, `redirect`, `error`,
// and `bytes` read in 256 KiB pieces as the consumer pulls them (ranges 206/416, `HEAD`, an attachment unless inline,
// safe download names; without a `size`, until an empty read).

import { STATUS_CODES } from "node:http";
import type { Ctx } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import type { AnswerHeaders } from "./headers.ts";

// 响应描述是可辨识联合：所有分支共享可选 headers；kind 区分 body 的形状，编译器在 switch 中收窄。
// 这些对象由应用代码构造，组件只读取；没有运行时 schema 校验，错误字段类型要靠 TypeScript。
/**
 * A route's answer, as a description; `headers` replace same-named default ones (a route widens its own CSP); a list
 * sends one line per value (several `Set-Cookie`).
 */
// 路由自带的头会覆盖同名默认头（大小写无关）；值为数组时每个元素写一行，适合多个 Set-Cookie。
export type HttpResponse = {
	readonly headers?: Readonly<Record<string, string | readonly string[]>>;
} & ( // JSON 分支：value 交给 JSON.stringify；无法序列化（如 BigInt）时 answerOf 抛错并回答 500。
	| { readonly kind: "json"; readonly value: JsonValue; readonly status?: number }
	// HTML 分支：body 是完整字符串；Content-Type 固定 text/html，除非 headers 覆盖。
	| { readonly kind: "html"; readonly body: string; readonly status?: number }
	| {
			// bytes 分支：mime 必填；size 决定 Content-Length 和 Range，缺失时靠 read 返回空块表示结束。
			// read 由组件按 256 KiB 请求，返回少于请求长度在“无 size”时表示最后一块，在“有 size”时视为失败。
			readonly kind: "bytes";
			readonly mime: string;
			/** The length: `Content-Length` and ranges; without it, read until `read` returns an empty chunk. */
			readonly size?: number;
			/** `length` bytes from `offset` (fewer only at the end of a body without `size`), in the request's scope. */
			readonly read: (offset: number, length: number, ctx: Ctx) => Promise<Uint8Array>;
			/** The file name it is saved under. */
			// 下载名只影响 Content-Disposition，不改变内容；生成时同时给出 ASCII 回退和 UTF-8 形式。
			readonly download?: string;
			/** Shown in the browser instead of saved (an image, a video), with a `sandbox` CSP. */
			// inline 为 true 时浏览器尝试直接显示，并追加 sandbox CSP；类型只允许 true。
			readonly inline?: true;
			/** Whether a single range is answered 206 (with `size`). */
			// 只有 size 存在且 ranges 为 true 才解析 Range；多段 Range 会被忽略并返回完整 body。
			readonly ranges?: boolean;
	  }
	// 重定向：Location 来自 to，状态码限定 302/303/307，默认 302；body 为空。
	| { readonly kind: "redirect"; readonly to: string; readonly status?: 302 | 303 | 307 }
	// 错误：状态码必填，消息可选；消息会作为纯文本 body，缺省用标准 reason phrase。
	| { readonly kind: "error"; readonly status: number; readonly message?: string }
);

// 组件内部答案：状态、已校验的头和三种 body 形态之一（整段字符串、被拉取的流、无 body）。
// 整段字符串由 Node 一次写出；流由消费者逐块拉取；null 表示 HEAD 或无 body 状态。
/** What the component answers: a status, its headers, and a whole body, a pulled one, or none. */
export type Answer = {
	readonly status: number;
	readonly headers: AnswerHeaders;
	/** A whole body is its text (UTF-8): Node writes a string body in one write with the head. */
	readonly body: string | ReadableStream<Uint8Array> | null;
};

// 错误类型：bytes 读取抛出或短读时包装成 ResponseFailure，携带原因并以 response_failed 报告；
// 它不直接变成 HTTP 状态，连接会被销毁，因为响应头可能已经写出。
/** A `bytes` body that could not be read whole (a throwing or a short `read`). */
export class ResponseFailure extends Error {
	// 构造函数把 message 和可选 ErrorOptions（例如 cause）交给 Error；name 固定便于日志识别。
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ResponseFailure";
	}
}

// 函数用途：生成响应的 Answer。输入响应描述、请求（方法与头读取器）、已被默认头填充的 AnswerHeaders、
// 请求上下文和失败回调；返回 Answer。
// 副作用：原地修改 defaults（写入路由头和 Content-*）；bytes 分支会创建流，读取发生在之后。
// 错误路径：头非法或 JSON 无法序列化时同步抛错；bytes 读取失败通过 failed 报告并让流 error。
// 例子：answerOf({kind:"json", value:{a:1}}, request, defaults, ctx, report) => 200 + application/json。
/**
 * The answer to `request` for `response` over `defaults` (which it changes): throws when a header is invalid (a CR or
 * LF) or the value is no JSON. A `bytes` body that cannot be read whole is reported to `failed` (its stream errors).
 */
export function answerOf(
	response: HttpResponse,
	request: { readonly method: string; header(name: string): string | null },
	defaults: AnswerHeaders,
	ctx: Ctx,
	failed: (error: unknown) => void,
): Answer {
	// defaults 是组件刚生成的默认头对象，直接在其上设置响应头，避免额外合并结构。
	const headers = defaults;
	// for...in 遍历响应头对象自有可枚举键；! 断言索引存在，因为键来自同一个对象。
	// 头名/值仍由 AnswerHeaders.set 做运行时校验，非法 CR/LF 在此抛 TypeError。
	for (const name in response.headers) headers.set(name, response.headers[name]!);
	// HEAD 只发送头，不发送 body；各分支把 head 传下去以省略 body。
	const head = request.method === "HEAD";
	// switch 依据可辨识联合的 kind 收窄分支；TypeScript 能检查每个分支访问的字段。
	switch (response.kind) {
		case "json":
			// JSON.stringify 可能抛错（循环引用、BigInt），不在此捕获，由调用方回答 500。
			return whole(
				response.status ?? 200,
				headers,
				"application/json; charset=utf-8",
				JSON.stringify(response.value),
				head,
			);
		case "html":
			return whole(response.status ?? 200, headers, "text/html; charset=utf-8", response.body, head);
		case "redirect":
			// 重定向只设置 Location，body 为空；类型缺省由 whole 统一处理为 302。
			headers.set("Location", response.to);
			return whole(response.status ?? 302, headers, undefined, "", head);
		case "error":
			return errorAnswer(response.status, headers, response.message, head);
		case "bytes":
			return bytesAnswer(response, request, headers, ctx, failed);
	}
}

// 函数用途：构造错误响应的 Answer。输入状态、头、可选消息和是否 HEAD，输出纯文本 Answer。
// 消息缺省时使用 Node 的 STATUS_CODES 标准短语；未知状态退化为空串。
// 例子：errorAnswer(404, headers) => body "Not Found"、Content-Type text/plain; charset=utf-8。
/** The answer for an error `status` with its reason phrase (or `message`) as plain text. */
// head 默认 false，让内部调用可省略该参数；status 的范围由 whole 检查。
export function errorAnswer(status: number, headers: AnswerHeaders, message?: string, head = false): Answer {
	return whole(status, headers, "text/plain; charset=utf-8", message ?? STATUS_CODES[status] ?? "", head);
}

// 函数用途：把内部 Answer 转成 Web Response，供 fetch 处理器返回。输入 Answer，输出标准 Response。
// 副作用：创建新的 Headers 并逐行 append，重复头（Set-Cookie）保留多行；body 原样交给 Response。
// 类型断言是因为 DOM 类型不接受共享内存的 ArrayBuffer，而组件只产出普通 Uint8Array。
/** `answer` as a Web `Response`. */
export function webResponse(answer: Answer): Response {
	// Bodies are bytes over plain `ArrayBuffer`s (never shared memory); the DOM types ask for exactly that.
	// 新建 Headers 而不是复制 AnswerHeaders，因为 Web API 使用自己的头容器。
	const headers = new Headers();
	for (const [name, value] of answer.headers.lines()) headers.append(name, value);
	// ConstructorParameters<typeof Response>[0] 在编译期提取 Response 构造函数第一个参数类型；
	// as 只影响类型检查，运行时仍传 answer.body（字符串、流或 null）。
	return new Response(answer.body as ConstructorParameters<typeof Response>[0], { status: answer.status, headers });
}

// 函数用途：生成整段 body 的 Answer。输入状态、头、默认 Content-Type、文本和是否 HEAD。
// 错误路径：状态不在 200..599 抛 RangeError；204/205/304 删除 Content-Type/Length 并返回 null body。
// 副作用：可能设置 Content-Type 和 Content-Length；HEAD 时 body 为 null，但长度头仍保留。
// 例子：whole(200, headers, "application/json; charset=utf-8", "{}", false) => 长度 2、body "{}"。
/**
 * A whole body: `type` unless a header set one, and its length; none for `HEAD`, and neither for a status that
 * carries no body (204, 205, 304: Sol's recheck N8, `Response` threw on them).
 */
function whole(status: number, headers: AnswerHeaders, type: string | undefined, text: string, head: boolean): Answer {
	// 状态码范围检查是运行时校验，因为调用方可能传任意 number（例如应用错误状态）。
	if (status < 200 || status > 599) throw new RangeError(`response: status ${status}`);
	// 204/205/304 按 HTTP 语义不能有 body，也不能带 Content-Length；删除可能由默认头或路由设置的值。
	if (BODYLESS.has(status)) {
		headers.delete("Content-Type");
		headers.delete("Content-Length");
		return { status, headers, body: null };
	}
	// 只有调用方没有设置 Content-Type 时才补默认值；路由可覆盖为更具体的类型。
	if (type !== undefined && !headers.has("content-type")) headers.set("Content-Type", type);
	// Content-Length 按 UTF-8 字节数而非字符串长度计算；非 ASCII 字符占多字节。
	headers.set("Content-Length", String(Buffer.byteLength(text)));
	// HEAD 或空文本不传 body；空文本仍保留长度 0，Node 会正常结束响应。
	return { status, headers, body: head || text === "" ? null : text };
}

// 无 body 的状态集合，与 Fetch/HTTP 规范一致；这些状态即使路由返回文本也不能写出内容。
/** The statuses whose responses carry no body. */
const BODYLESS: ReadonlySet<number> = new Set([204, 205, 304]);

// bytes 每次 read 的最大块大小 256 KiB；即使请求范围很小，也最多读这么多。
/** One `read` of a `bytes` body: 256 KiB. */
const PIECE = 256 * 1024;

// 函数用途：生成 bytes 分支的 Answer。输入 bytes 描述、请求、头、上下文和失败回调，输出 Answer。
// 流程：设置 Content-Type/Disposition/内联 CSP -> 解析 Range -> 设置长度 -> HEAD/空 body 直接返回 -> 创建流。
// 错误路径：不可满足的 Range 返回 416，读取失败由 pulled 报告并让流 error。
// 例子：size=600000、Range: bytes=10-19 => 206、Content-Range: bytes 10-19/600000、body 为 10 字节流。
/** A `bytes` answer: its range or all of it, or until an empty read without a `size`. */
function bytesAnswer(
	response: Extract<HttpResponse, { readonly kind: "bytes" }>,
	request: { readonly method: string; header(name: string): string | null },
	headers: AnswerHeaders,
	ctx: Ctx,
	failed: (error: unknown) => void,
): Answer {
	// 路由未显式给 Content-Type 时使用 bytes.mime；已设置则尊重路由。
	if (!headers.has("content-type")) headers.set("Content-Type", response.mime);
	// 默认 attachment；inline 或 download 影响 disposition 的 kind 与文件名。
	headers.set("Content-Disposition", disposition(response));
	// 内联显示时追加 sandbox，禁止脚本/表单等能力；直接拼在现有 CSP 之后（缺省为空串，因此以 "; " 开头）。
	if (response.inline === true)
		headers.set("Content-Security-Policy", `${headers.get("content-security-policy") ?? ""}; sandbox`);
	// 解构 size；undefined 表示流式未知长度。
	const { size } = response;
	// start/length 描述要发送的区间，默认完整 body；status 默认 200。
	let start = 0;
	let length = size;
	let status = 200;
	// 只有已知长度且明确启用 ranges 时才处理 Range 头。
	if (size !== undefined && response.ranges === true) {
		// 告知客户端支持单段范围请求；多段会退回 200 完整 body。
		headers.set("Accept-Ranges", "bytes");
		// rangeOf 返回 undefined（无/非法/多段）、具体区间或 unsatisfiable。
		const range = rangeOf(request.header("range"), size);
		// 不可满足的 Range（起点越界、空文件或 bytes=-0）：416，Content-Range 用 */size 表示总长度，body 为空。
		if (range === "unsatisfiable") {
			headers.set("Content-Range", `bytes */${size}`);
			return whole(416, headers, undefined, "", true);
		}
		// 合法单段：更新区间与 206 状态，并写 Content-Range（结束位置含在区间内）。
		if (range !== undefined) {
			({ start, length } = range);
			status = 206;
			headers.set("Content-Range", `bytes ${start}-${start + range.length - 1}/${size}`);
		}
	}
	// 有长度时设置 Content-Length；分块流式（无 size）则不设置，由适配器使用 chunked。
	if (length !== undefined) headers.set("Content-Length", String(length));
	// HEAD 不创建流也不读取文件；长度为 0 时无需 body，直接结束。
	if (request.method === "HEAD" || length === 0) return { status, headers, body: null };
	// 其余情况创建拉取式流；实际读取由消费者（Node 写出或 Web Response 读取）驱动。
	return { status, headers, body: pulled(response, start, length, ctx, failed) };
}

// 函数用途：为 bytes 响应创建 ReadableStream。输入响应描述、起点、长度/未知、上下文和失败回调。
// 拉取模型：消费者每 read 一次，流调用一次 response.read，从而把网络背压传给文件读取。
// 取消/封口：作用域 abort 时流 error，不再开始新读取，晚到的块被丢弃；cancel 时移除监听器。
// 例子：length=600000 => 依次 read(0,262144)、read(262144,262144)、read(524288,75712)。
/**
 * The body of a `bytes` response from `start`, `length` bytes (`undefined`: until an empty read), read one piece per
 * pull, so the consumer's backpressure paces the reads; a `read` that throws or comes back short fails it. It follows
 * the request's scope: once sealed (a disconnect, `close`) the stream errors, no read starts, a late one is dropped
 * (Astra's recheck R2, Sol's N3: a held `Response` went on reading after the seal).
 */
function pulled(
	response: Extract<HttpResponse, { readonly kind: "bytes" }>,
	start: number,
	length: number | undefined,
	ctx: Ctx,
	failed: (error: unknown) => void,
): ReadableStream<Uint8Array> {
	// 无长度时用正无穷作为结束位置，读到空块才停止；有长度时结束位置固定。
	const end = length === undefined ? Number.POSITIVE_INFINITY : start + length;
	// 请求作用域的取消信号；没有信号的上下文（例如直接调用）不会主动封口。
	const signal = ctx.abortSignal;
	let offset = start;
	let sealed: (() => void) | undefined;
	// 创建流时提供 start/pull/cancel 三个回调；highWaterMark 0 让每次拉取都由消费者触发。
	return new ReadableStream<Uint8Array>(
		{
			start: (controller) => {
				// 没有信号就没有可注册的封口动作。
				if (signal === undefined) return;
				// Sealed before the stream exists (an abort while the route returned it): no event will come
				// (Sol's third recheck: the request never finished, `close` waited its whole bound).
				// 流创建前作用域已取消：直接 error，否则 abort 事件不会再来。
				if (signal.aborted) return controller.error(signal.reason);
				// sealed 保存错误函数，cancel/正常关闭时移除监听，避免泄漏。
				sealed = () => controller.error(signal.reason);
				signal.addEventListener("abort", sealed, { once: true });
			},
			// pull 在消费者请求数据时调用；async 允许等待文件读取。
			pull: async (controller) => {
				// 每次拉取前再次检查取消，封口后不再启动读取。
				if (signal?.aborted) return controller.error(signal.reason);
				// want 是本次希望读取的字节数：最多 256 KiB，且不超过剩余区间。
				const want = Math.min(PIECE, end - offset);
				let chunk: Uint8Array;
				try {
					// 把请求上下文传给 read，让文件句柄等资源跟随作用域。
					chunk = await response.read(offset, want, ctx);
					// 有明确长度时必须读满 want，短读说明文件变化或读取实现有问题，包装成 ResponseFailure。
					if (length !== undefined && chunk.byteLength !== want) {
						throw new ResponseFailure(
							`bytes: read ${chunk.byteLength} of ${want} bytes at ${offset} (size ${response.size})`,
						);
					}
					// 读取出错：如果是因为作用域封口导致的取消，不算响应失败。
				} catch (error) {
					// A read cut by the seal is no failure of the response.
					if (signal?.aborted) return;
					// 真正的读取错误先报告（组件可记日志），再让流 error，连接随后被销毁。
					failed(error);
					controller.error(error);
					return;
				}
				// 读取期间被取消：流已经 error，当前块丢弃，不 enqueue 也不 close。
				// Sealed while reading: the stream errored already, the late chunk is dropped.
				if (signal?.aborted) return;
				// 空块表示无长度流的结束；offset+len 达到 end 表示已知长度的最后一块。
				if (chunk.byteLength === 0 || offset + chunk.byteLength >= end) {
					if (chunk.byteLength > 0) controller.enqueue(chunk);
					// 正常结束前移除 abort 监听，避免之后的取消再次操作已关闭的流。
					if (sealed !== undefined) signal?.removeEventListener("abort", sealed);
					controller.close();
					return;
				}
				// 未结束则入队当前块并推进偏移；下一次 pull 才读下一块。
				controller.enqueue(chunk);
				offset += chunk.byteLength;
			},
			// 消费者取消（例如客户端断开）：只移除监听器；不主动取消底层 read，避免重置连接。
			cancel: () => {
				if (sealed !== undefined) signal?.removeEventListener("abort", sealed);
			},
		},
		// highWaterMark 0 表示流不预读；消费者不拉取就不会触发文件读取。
		{ highWaterMark: 0 },
	);
}

// 函数用途：解析单段 Range 头。输入头文本和资源总长度，输出区间、undefined（忽略）或 unsatisfiable。
// 规则：只接受 bytes=from-to 形式；两段都可省略但有意义限制；多段、格式错误、from>to 都按无 Range 处理。
// 例子："bytes=10-19" => {start:10,length:10}；"bytes=-3" => 最后 3 字节；"bytes=600000-" 且 size=600000 => unsatisfiable。
/**
 * The single range `header` asks for within `size` bytes; `undefined` for none, a malformed or a multi-range one (the
 * whole body); `unsatisfiable` for one starting at or past the end.
 */
function rangeOf(header: string | null, size: number): { start: number; length: number } | "unsatisfiable" | undefined {
	// 没有 Range 头：正常 200 完整 body。
	if (header === null) return undefined;
	// 正则要求整个头匹配；允许两侧空白由 trim 处理，多段（逗号）无法匹配。
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (match === null) return undefined;
	// 解构捕获两组数字；默认空串让后续判断不需要处理 undefined。
	const [, from = "", to = ""] = match;
	// 两边都空（"bytes=-"）不是有效范围，忽略。
	if (from === "" && to === "") return undefined;
	// 后缀范围：只给结束长度，从文件末尾倒数。
	if (from === "") {
		const suffix = Number(to);
		// 后缀 0 或空文件没有可满足的区间；后缀长度超过文件时截断为整个文件。
		if (suffix === 0 || size === 0) return "unsatisfiable";
		const length = Math.min(suffix, size);
		return { start: size - length, length };
	}
	// 起点范围：from 超过文件长度返回 unsatisfiable；等于长度也越界。
	const start = Number(from);
	if (start >= size) return "unsatisfiable";
	// 结束位置缺省为文件末尾；超过末尾截断到 size-1。
	const last = to === "" ? size - 1 : Math.min(Number(to), size - 1);
	// 结束早于起点（如 bytes=5-3）视为非法，忽略 Range。
	if (last < start) return undefined;
	return { start, length: last - start + 1 };
}

// 函数用途：生成 Content-Disposition。输入 bytes 响应的 download/inline 选项，输出头值。
// 规则：inline 或 attachment；无文件名时只输出 kind；有文件名时同时给 ASCII 回退和 RFC 5987 UTF-8 形式。
// 安全处理：删除控制字符和双向格式字符，ASCII 回退把非可见字符及引号/反斜杠替换为下划线。
// 例子：download='a"b.txt' => attachment; filename="a_b.txt"; filename*=UTF-8''a%22b.txt。
/**
 * `Content-Disposition`: `inline` or `attachment`, with the download name as an ASCII fallback and as UTF-8 (RFC 6266,
 * RFC 5987), its control and bidirectional formatting characters dropped (a name must read as it is).
 */
function disposition(response: { readonly download?: string; readonly inline?: true }): string {
	// inline 只由字面量 true 触发；其他情况一律 attachment。
	const kind = response.inline === true ? "inline" : "attachment";
	// 无文件名时返回裸 kind，浏览器使用 URL 最后一段作为默认名。
	if (response.download === undefined) return kind;
	// 删除 C0 控制符、DEL、阿拉伯字母标记、LRM/RLM、嵌入/覆盖/隔离字符；这些字符能伪装扩展名或破坏日志。
	const name = response.download.replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
	// ASCII 回退：非可见 ASCII、双引号和反斜杠替换成 _；RFC 6266 的 quoted-string 不能包含这些字符。
	const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
	// UTF-8 形式先用 encodeURIComponent；RFC 5987 还要求转义 ' ( ) *，它们不会被 encodeURIComponent 编码。
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	// 两种文件名同时出现：旧客户端读 filename，新客户端优先 filename*；编码声明为 UTF-8。
	return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
