/**
 * 把 Pi 已规范的消息直接交给实现 pi-messages 协议的后端，再把后端 SSE 事件还原成统一回答流。
 * 例：用户问“读 a.txt”时，POST 发送整份 context；后端依次回 toolcall_start/delta/end，最后 done 决定完整结果。
 * 此层不把消息翻译成 OpenAI/Anthropic 格式，也不在本地执行工具；Radius 网关是使用该协议的一种后端。
 * 请求只发一次，没有本地 HTTP 重试或 timeoutMs 映射；错误一般变成 error 事件，result() 仍会完成为错误消息。
 * 远端 JSON 仅有局部运行检查，PiMessagesEvent 类型断言不是完整协议验证；不要把后端内容当作已通过工具参数 schema 校验。
 */
/**
 * pi-messages API implementation.
 *
 * Streams pi's own message protocol directly to a backend: the request is a
 * single POST of `{ model, context, options }` to `<baseUrl>/messages`, the
 * response is an SSE stream of serialized assistant-message events plus a
 * terminal `done`/`error` event. This is the wire protocol spoken by the
 * Radius gateway, but any backend implementing it can be used, e.g. via a
 * models.json custom provider with `"api": "pi-messages"`.
 */

// 这些都是编译期契约；导入类型不会创建模型、请求或运行时校验器。
import type {
	// 完整回答及增量事件的内部格式。
	AssistantMessage,
	AssistantMessageEvent,
	// 缓存保留偏好是字面量联合，JSON 附加信息用 Json* 类型表达。
	CacheRetention,
	JsonObject,
	JsonValue,
	// Model 的协议泛型把此适配器限定为 pi-messages。
	Model,
	// 请求级环境覆盖，只由实际读取它的配置项使用。
	ProviderEnv,
	// 简化入口与原生入口的参数/函数签名。
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	// 思考级别、工具调用和已经规范好的对话记录。
	ThinkingLevel,
	ToolCall,
	TranscriptContext,
} from "../types.ts";
// 诊断写进消息供上层查看；不在这些 helper 中写日志文件或做秘密脱敏。
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
// 统一流同时支持 for await 读事件，以及 result() 等最后一条回答。
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
// 请求头合并忽略名称大小写，后来源覆盖前来源，null 删除前面的同名头。
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
// 根据模型目标和应用配置生成 User-Agent/归因头，不把归因信息当认证。
import { getIdentityHeaders } from "../utils/identity.ts";
// 读取 scoped env→进程环境→特定 Bun 回退，本文件只用它读取旧缓存开关。
import { getProviderEnvValue } from "../utils/provider-env.ts";
// 每个流式工具调用单独保存参数原文与容错预览；它本身也提供 finish，但本适配器最终采用后端 toolCall。
import { ToolCallArgumentsStream } from "../utils/streaming-json.ts";
// 截断错误正文时尽量让短片段独立存储，而非长久保留整份大字符串。
import { ownedSlice } from "../utils/text.ts";

/** pi-messages 专属请求参数，继承通用认证/HTTP/钩子；字段被声明不代表本后端支持所有通用选项。 */
export interface PiMessagesOptions extends StreamOptions {
	// 思考级别原样交给后端，不在这里分配本地思考 token 预算。
	reasoning?: ThinkingLevel;
	// 可自动、禁止、要求工具，或指定函数名；这是请求声明，不执行工具。
	toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
	/** Ask the backend for debug metadata (e.g. routing response headers). */
	// 为 true 时 URL 增加 debug=1，不在这里保证后端一定返回调试信息。
	debug?: boolean;
}

// 索引访问类型复用回答里的用量与停止原因，避免另写一份容易偏离的结构。
type PiMessagesUsage = AssistantMessage["usage"];
type PiMessagesStopReason = AssistantMessage["stopReason"];

/** Impact summary of a server-side message rewrite (e.g. a gateway policy). */
/** 后端声明的消息改写影响摘要；例如某项网关策略缩短上下文。这里只记录，不据此在本地重新改写历史。 */
export type PiMessagesRewriteImpact = {
	// 策略标识与版本，不在此查策略注册表核验。
	policyId: string;
	policyVersion: number;
	// 后端报告是否发生改动。
	changed: boolean;
	// 数量变化是后端给的数字，本地不重新计 token/消息差值。
	tokenCountChange: number;
	messageCountChange: number;
	// 是否改过系统提示词；本消息不携带被修改后的全文。
	systemPromptChanged: boolean;
};

/** Serialized assistant-message event as sent by a pi-messages backend. */
/**
 * 后端事件的判别联合：type 决定其他字段；例如 text_delta 有 contentIndex/delta，done 有 reason/usage。
 * 这里只描述正常协议，JSON.parse 后的 as 不运行这些约束；下面仅明确检查 contentIndex 的类型、整数和范围。
 */
export type PiMessagesEvent =
	// start 表示回答开始，尚未要求产生内容块。
	| { type: "start" }
	// 每个内容块用数组下标定位，文本先建立空块，再追加片段，end 可用最终全文覆盖。
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string; contentSignature?: string }
	// 思考块有自己的开始/增量/结束，不自动变成给用户展示的正文。
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| {
			// 多行联合成员同样由这个字面量 type 区分。
			type: "thinking_end";
			contentIndex: number;
			content: string;
			// 可选签名和隐藏思考标记由后端发送，不在本地验签。
			contentSignature?: string;
			redacted?: boolean;
	  }
	// 工具开始给身份，delta 给参数文本，end 给后端整理好的完整 ToolCall。
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
	| {
			// 正常终止，Extract 从停止原因联合中只取这三项；不产生运行检查。
			type: "done";
			reason: Extract<PiMessagesStopReason, "stop" | "length" | "toolUse">;
			// 用量直接采用后端统计，包括费用，不按本地 model.cost 重算。
			usage: PiMessagesUsage;
			// 响应 ID、实际服务模型/思考级别与改写摘要均可缺省。
			responseId?: string;
			responseModel?: string;
			providerThinkingLevel?: string;
			rewrite?: PiMessagesRewriteImpact;
	  }
	| {
			// 后端显式终止失败，与客户端自己捕获的异常分开处理。
			type: "error";
			reason: Extract<PiMessagesStopReason, "aborted" | "error">;
			usage: PiMessagesUsage;
			// 服务端可不给 errorMessage；类型没有强制它存在。
			errorMessage?: string;
			// 错误也可能有服务响应标识及改写信息。
			responseId?: string;
			responseModel?: string;
			providerThinkingLevel?: string;
			rewrite?: PiMessagesRewriteImpact;
	  };

// 非 2xx JSON 的候选结构；message/code/details 来自远端，读取时仍需局部收窄。
type PiMessagesErrorBody = {
	// error 自身也可没有，解析 helper 会确认它是非数组对象才采用这份结构。
	error?: {
		message?: unknown;
		code?: unknown;
		details?: unknown;
		// 允许后端额外附字段，不在这里逐项验证其 JSON 值类型。
		[key: string]: unknown;
	};
};

/** HTTP 错误携带可展示说明、可选服务错误码及诊断原数据；例 401 的 code 可为 unauthorized，不主动脱敏或写磁盘。 */
export class PiMessagesResponseError extends Error {
	// ? 表示可缺省；该字段可被调用方重新赋值。
	code?: string;
	// readonly 只禁止通过 TS 重绑字段，不深冻结其中的对象。
	readonly diagnosticDetails: JsonObject;

	// 保存已有说明和详情；输入都由调用点构造，无网络/正文解析，结果是一个 Error 子类实例。
	constructor(message: string, code: string | undefined, diagnosticDetails: JsonObject) {
		// 先初始化标准 Error 的 message/stack，再设置自己的字段。
		super(message);
		// 显示错误类别名，不改变 instanceof 的继承链。
		this.name = "PiMessagesResponseError";
		// 保存可选后端错误码。
		this.code = code;
		// 保留诊断对象原引用，没有复制/递归校验字段。
		this.diagnosticDetails = diagnosticDetails;
	}
}

/** 尝试读 HTTP JSON 错误：解析→确认 error 对象外形→返回原结构，失败给 undefined。例 HTML 错误页不能采用 JSON 字段；不抛 JSON 解析错误。 */
function parsePiMessagesErrorBody(body: string): PiMessagesErrorBody | undefined {
	// 只包 JSON 解码和这里的字段读取/外形检查。
	try {
		// as 仅让 TS 看候选字段，实际内容仍可能不符合该结构。
		const parsed = JSON.parse(body) as PiMessagesErrorBody | null;
		// ?. 容许解析结果 null；下面再检查 error 外形。
		const error = parsed?.error;
		// 不验证 error 内每个字段，只要求它非 null 对象且不是数组。
		return parsed && typeof error === "object" && error !== null && !Array.isArray(error) ? parsed : undefined;
	} catch {
		// 不是可用 JSON 错误体时由调用方保留原正文。
		return undefined;
	}
}

/** 原始错误体诊断最多留前 8192 个 UTF-16 码元再加省略号；例超长代理错误页截短，短串原样返回，不保证脱敏。 */
function truncateDiagnosticString(value: string): string {
	// 本函数的展示上限，与模型 token 上限不同。
	const maxLength = 8192;
	// ownedSlice 尽量复制片段存储；省略号不计入前面的 8192。
	return value.length > maxLength ? `${ownedSlice(value, 0, maxLength)}…` : value;
}

/** 拼 HTTP 错误文字：状态码/状态文字→优先字符串 error.message 否则原 body→可选错误码。例 401 Unauthorized: expired (unauthorized)；此文字本身没有长度截断。 */
function formatPiMessagesResponseError(
	// Response 提供 status/statusText，这里不消费正文。
	response: Response,
	// 已经读完的正文字符串供 JSON 结构不可用时回退。
	body: string,
	// 上一 helper 认可的候选结构，内字段仍 unknown。
	errorBody: PiMessagesErrorBody | undefined,
): string {
	// 只有真正字符串才作为后端 message。
	const message = typeof errorBody?.error?.message === "string" ? errorBody.error.message : undefined;
	// 错误码也只采用字符串，不将数字自动转字符串。
	const code = typeof errorBody?.error?.code === "string" ? errorBody.error.code : undefined;
	// ?? 保留空 message，不因空字符串回退 body。
	const suffix = message ?? body;
	// code 为空字符串时不追加括号。
	const codeSuffix = code ? ` (${code})` : "";
	// 原样拼 statusText/正文/错误码，不清除敏感字段。
	return `${response.status} ${response.statusText}: ${suffix}${codeSuffix}`;
}

/** 将已读取的失败响应包装为 PiMessagesResponseError；例结构化 error 保存完整 error 字段，普通正文诊断才截断，便于上层定位网关失败。 */
function createPiMessagesResponseError(
	// 请求模型用于归因，不改模型目录。
	model: Model<"pi-messages">,
	// 实际请求 URL 也会写诊断，因此可能包括 debug 查询参数。
	url: URL,
	response: Response,
	body: string,
): PiMessagesResponseError {
	// 尝试把正文识别为 error 对象；失败仍保留正文回退。
	const errorBody = parsePiMessagesErrorBody(body);
	// 单独提取字符串码写 Error.code。
	const code = typeof errorBody?.error?.code === "string" ? errorBody.error.code : undefined;
	// 错误说明和诊断共享同一失败来源，但它们的长度策略不同。
	return new PiMessagesResponseError(formatPiMessagesResponseError(response, body, errorBody), code, {
		// 诊断详情协议版本，与模型版本不同。
		version: 1,
		// 请求供应商/模型身份。
		provider: model.provider,
		model: model.id,
		// URL 转字符串记录；不隐藏其中的查询字段。
		url: url.toString(),
		// 保存 HTTP 状态用于排查。
		status: response.status,
		statusText: response.statusText,
		// 可识别 JSON error 时保留其全部字段；as JsonValue 不递归验证结构。
		...(errorBody?.error === undefined ? {} : { error: errorBody.error as JsonValue }),
		// 只有非结构化错误才保存截短 body，不是所有诊断都被限为 8192。
		...(errorBody ? {} : { body: truncateDiagnosticString(body) }),
		// 本地生成诊断的毫秒时刻，不是服务端事件时间。
		timestampMs: Date.now(),
	});
}

/** 新建零用量，供未收到后端终止统计的消息使用；例连接前失败时各项为 0，不表示服务端绝对没有产生费用。每次返回独立对象。 */
function createEmptyUsage(): PiMessagesUsage {
	return {
		// 输入、输出、缓存读写各自的 token 计数尚未知，先置零。
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		// 总 token 同样先置零。
		totalTokens: 0,
		// 嵌套费用对象也新建，不复用可变共享实例。
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** 若后端给改写摘要就向回答追加一条诊断；例 policyId=shorten 的数量差值记录下来。修改 message.diagnostics，不修改对话历史或验证摘要真实性。 */
function appendRewriteDiagnostic(message: AssistantMessage, rewrite: PiMessagesRewriteImpact | undefined): void {
	// 缺摘要时不额外分配诊断。
	if (!rewrite) {
		return;
	}
	// helper 复制旧诊断数组并追加这一项，消息字段会被替换。
	appendAssistantMessageDiagnostic(message, {
		// 固定分类供上层识别。
		type: "pi_messages_rewrite",
		// 本地收到时刻，而非策略实际执行的服务端时刻。
		timestamp: Date.now(),
		// 只浅复制摘要字段，不执行策略。
		details: { ...rewrite },
	});
}

/**
 * 为一条回答创建有状态事件转换器，输入模型，返回“后端事件→Pi 事件”的闭包。
 * 先建立同一个 partial，再按下标建立/更新内容；done/error 把后端统计写入它并交给最终结果。
 * 例 text_start(0)→text_delta(0,"你")→text_end(0,"你好")，同一块从空串变“你”，最后以“你好”覆盖。
 * 修改 partial/工具参数 Map，不执行工具；仅检查下标，不核验全部事件字段、块类型或事件先后合法性。
 */
function createEventConverter(model: Model<"pi-messages">) {
	// partial 是整条回答共享的可变对象，中间事件里的 partial 指向它，不是每次深快照。
	const partial: AssistantMessage = {
		// 当前结果是 assistant，不把工具调用事件当 user/toolResult。
		role: "assistant",
		// 后端 contentIndex 对这个数组定位。
		content: [],
		// 请求的协议、供应商、模型身份不会被 responseModel 自动替换。
		api: model.api,
		provider: model.provider,
		model: model.id,
		// 收到 done/error 前尚无后端完整统计。
		usage: createEmptyUsage(),
		// pending 明确表示仍在生成，不能当正常 stop。
		stopReason: "pending",
		// 消息对象建立时的本地毫秒时间。
		timestamp: Date.now(),
	};
	// 每个工具块下标对应独立参数预览流；它不作为 content 的额外字段泄漏给上层。
	const toolArguments = new Map<number, ToolCallArgumentsStream>();

	// 返回闭包保存 partial/Map，随后每个后端事件按顺序调用它。
	return (event: PiMessagesEvent): AssistantMessageEvent => {
		// in 只看字段存在性（含继承），不是完整远端对象 schema 验证。
		if ("contentIndex" in event) {
			// The index comes from the wire and keys the content array: `__proto__` would reach Array.prototype, and a huge
			// index would make a sparse array of billions of holes. A start adds the next block; other events need one.
			// 刻意重新视为 unknown，因为 JSON 类型断言未验证真实下标。
			const index: unknown = event.contentIndex;
			// *_start 允许在现有位置重建块或追加下一块；其他事件最多指到现有最后一块。
			const limit = event.type.endsWith("_start") ? partial.content.length : partial.content.length - 1;
			// 必须真正整数且 0..limit，拒绝巨大稀疏下标、负数和字符串特殊键。
			if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > limit) {
				// 错误交外层 catch 变成新 error 消息；不会自动附上此前 partial。
				throw new Error(`Invalid contentIndex ${JSON.stringify(index)} in pi-messages ${event.type} event`);
			}
		}
		// type 是判别字段；TS 根据每个 case 收窄正常协议成员，但不运行字段值检查。
		switch (event.type) {
			case "done":
				// 原地写终止原因/后端用量/响应 ID，保留已累积内容。
				Object.assign(partial, {
					stopReason: event.reason,
					usage: event.usage,
					responseId: event.responseId,
				});
				// 后端给了实际服务模型才添加，未给不会把请求 model 清空。
				if (event.responseModel !== undefined) {
					partial.responseModel = event.responseModel;
				}
				// 同理保留后端实际思考级别，不用本地 reasoning 猜测。
				if (event.providerThinkingLevel !== undefined) {
					partial.providerThinkingLevel = event.providerThinkingLevel;
				}
				// 可选改写摘要成为诊断，不改 context。
				appendRewriteDiagnostic(partial, event.rewrite);
				// 正常终止用 message 字段，事件流据此完成 result()。
				return { type: "done", reason: event.reason, message: partial };
			case "error":
				// 后端显式错误继续使用同一个 partial，所以已生成文字/工具块仍保留。
				Object.assign(partial, {
					stopReason: event.reason,
					usage: event.usage,
					errorMessage: event.errorMessage,
					responseId: event.responseId,
				});
				// 错误也可带实际服务模型，用非 undefined 条件保留空字符串等明确值。
				if (event.responseModel !== undefined) {
					partial.responseModel = event.responseModel;
				}
				// 后端错误终止时的思考级别可照样记录。
				if (event.providerThinkingLevel !== undefined) {
					partial.providerThinkingLevel = event.providerThinkingLevel;
				}
				// 同一诊断 helper 适用于正常/错误终止。
				appendRewriteDiagnostic(partial, event.rewrite);
				// error 字段仍是完整 AssistantMessage，而不是一个 JS Error。
				return { type: "error", reason: event.reason, error: partial };
			case "start":
				// 回答对象已在工厂建立，这里无需重新置空；末尾统一补 partial 返回。
				break;
			case "text_start":
				// 在指定位置写新文本块；允许重写已有块，不额外要求单次 start。
				partial.content[event.contentIndex] = { type: "text", text: "" };
				break;
			case "text_delta":
				// as 只是声明该下标为文本结构，不运行块类型验证；+= 追加片段。
				(partial.content[event.contentIndex] as { text: string }).text += event.delta;
				break;
			case "text_end":
				// 以 end 的完整文本覆盖累计文本，签名原样保存；! 不添加存在性检查。
				Object.assign(partial.content[event.contentIndex]!, {
					text: event.content,
					textSignature: event.contentSignature,
				});
				break;
			case "thinking_start":
				// 思考块独立存 thinking 字段，不混进 text。
				partial.content[event.contentIndex] = { type: "thinking", thinking: "" };
				break;
			case "thinking_delta":
				// 逐片追加思考，同样依赖后端给出匹配的内容块类型。
				(partial.content[event.contentIndex] as { thinking: string }).thinking += event.delta;
				break;
			case "thinking_end":
				// 最终思考全文、签名、redacted 标记直接采用后端字段，不验签/解密。
				Object.assign(partial.content[event.contentIndex]!, {
					thinking: event.content,
					thinkingSignature: event.contentSignature,
					redacted: event.redacted,
				});
				break;
			case "toolcall_start":
				// 新建工具调用数据，不在此调本地工具函数。
				partial.content[event.contentIndex] = {
					type: "toolCall",
					// 身份/名字来自后端，空值或未知工具名不在这里过滤。
					id: event.id,
					name: event.toolName,
					// 参数先为空对象，delta 到来后才有预览。
					arguments: {},
				};
				// 为该位置建立独立增量解析器；重复 start 会替换该位置旧状态。
				toolArguments.set(event.contentIndex, new ToolCallArgumentsStream());
				break;
			case "toolcall_delta": {
				// case 的花括号建立局部作用域，避免 const args 与其他 case 冲突。
				const args = toolArguments.get(event.contentIndex);
				// 缺解析器则忽略这段参数；下标有效不等于已收到对应工具 start。
				if (args !== undefined)
					// append 给容错的稳定对象预览，尚不能代替最终工具 schema 校验。
					(partial.content[event.contentIndex] as ToolCall).arguments = args.append(event.delta);
				break;
			}
			case "toolcall_end":
				// 采用后端完整 ToolCall 覆盖已有块，不调用本地 args.finish() 校验累计文本。
				Object.assign(partial.content[event.contentIndex]!, event.toolCall);
				// 释放该调用的解析状态，完整调用数据仍在 content 里。
				toolArguments.delete(event.contentIndex);
				return {
					// 专门组装 end，确保 toolCall 指向合并后的内部对象。
					type: "toolcall_end",
					contentIndex: event.contentIndex,
					// as 不证明后端 toolCall 字段实际合法。
					toolCall: partial.content[event.contentIndex] as ToolCall,
					partial,
				};
		}

		// 非终止事件沿用后端字段并附同一 partial；as 不拦截未知 type 或多余字段。
		return { ...event, partial } as AssistantMessageEvent;
	};
}

/**
 * 把字节流按 SSE 空行切块，逐块产出 PiMessagesEvent；输入 ReadableStream，输出异步生成器。
 * TextDecoder 接续跨 chunk 的 UTF-8，CRLF 规范为 LF，读完后也尝试解析未以空行结尾的尾块。
 * 例两次读取分别为 data:{...} 与 \n\n，合并后才解析；JSON 错误会向上抛。
 * finally 只释放 reader 锁，不 reader.cancel()；提前遇终止事件退出不会在这里保证取消底层网络正文。
 */
async function* readPiMessagesEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<PiMessagesEvent> {
	// 默认 UTF-8 解码器保留未完整字节序列供下一次 decode。
	const decoder = new TextDecoder();
	// 获取专属 reader 会锁定此 stream，直到 finally 释放。
	const reader = stream.getReader();
	// 缓冲尚未被空行完整切出的文本，不设置独立大小上限。
	let buffer = "";

	// 确保读取/解析/消费者提前退出时都释放锁。
	try {
		while (true) {
			// 等待下一字节块；done 表示 EOF，不是协议 done 事件。
			const { done, value } = await reader.read();
			// EOF 时无参 decode 冲出尾字节，其余用 stream:true 允许多次拼接。
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			// 合并缓冲后再替换，跨字节块的 CR/LF 也可被识别；不把单独 CR 当分隔符。
			buffer = buffer.replace(/\r\n/g, "\n");

			// SSE 用两个 LF 分事件；一个 reader chunk 可能包含很多个事件。
			let split = buffer.indexOf("\n\n");
			while (split !== -1) {
				// 只把当前空行前的事件块交给 parser。
				const event = parsePiMessagesEvent(buffer.slice(0, split));
				// 没 data 或 [DONE] 被 parser 忽略；这里只按真值判断，不额外保证解析结果是对象。
				if (event) {
					yield event;
				}
				// 丢掉已消费块和两个 LF，保留后续数据。
				buffer = buffer.slice(split + 2);
				// 继续寻找本次已有缓冲中的下一事件。
				split = buffer.indexOf("\n\n");
			}

			// EOF 已解码/处理完当前缓冲后才结束读取循环。
			if (done) {
				break;
			}
		}

		// 允许最后一块没有空行收尾；纯空白不必解析。
		if (buffer.trim()) {
			const event = parsePiMessagesEvent(buffer);
			if (event) {
				yield event;
			}
		}
	} finally {
		// 解除 reader 的锁，既不消费剩余正文，也不主动取消它。
		reader.releaseLock();
	}
}

/** 从一块 SSE 取第一条以 data: 起头的行，去两端空白并 JSON.parse；例 data:[DONE] 被忽略，不是终止回答的 done 事件。不会拼接多条 data 行或验证完整事件 schema。 */
function parsePiMessagesEvent(raw: string): PiMessagesEvent | undefined {
	// 链式处理只选择一个 data 行，SSE 的 event/id/retry 字段在这里不采用。
	const data = raw
		// read helper 已处理 CRLF，这里按 LF 拆行。
		.split("\n")
		// 只认行首 data:，不接收前面带空格的该字段。
		.find((line) => line.startsWith("data:"))
		// 没找到就短路为 undefined；slice 去掉 data: 五个字符。
		?.slice(5)
		// data 正文两端空白清掉，内部 JSON 内容不另修复。
		.trim();

	// as 是编译期声称，不验证 type/usage/delta；坏 JSON 抛给上层，空串和 [DONE] 不产事件。
	return data && data !== "[DONE]" ? (JSON.parse(data) as PiMessagesEvent) : undefined;
}

/**
 * 把客户端异常变成新的终止错误消息，输入请求模型、任意抛出值、取消标记，返回统一 error 事件。
 * 例 HTTP 401 会附网关诊断；已取消则标 aborted 且不附这一 HTTP 诊断。
 * 与后端 error 事件不同，此处重新建 content=[]/零用量，不保留此前转换器里已收内容，也不据零用量保证未计费。
 */
function createErrorEvent(model: Model<"pi-messages">, error: unknown, aborted: boolean): AssistantMessageEvent {
	// 是否取消由调用方读取 signal 给出，不从错误 name 猜测。
	const reason = aborted ? "aborted" : "error";
	// 用新消息表示客户端这次失败，不拿 Error 对象直接充当回答。
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [],
		// 请求模型身份照常保留，用于显示失败来源。
		api: model.api,
		provider: model.provider,
		model: model.id,
		// 这一包装器未取得最终远端统计。
		usage: createEmptyUsage(),
		stopReason: reason,
		// 普通 Error 用 message，其他抛出值转字符串；String 自身异常没有额外 try 兜底。
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};

	// 只有未取消的本适配器 HTTP 错误附结构化详情，其他异常仅有上面的说明。
	if (!aborted && error instanceof PiMessagesResponseError) {
		appendAssistantMessageDiagnostic(
			assistantMessage,
			// 包含原错误 name/message/stack/code 及 diagnosticDetails，不主动脱敏。
			createAssistantMessageDiagnostic("pi_messages_response_failure", error, error.diagnosticDetails),
		);
	}

	// 流的 error 字段是一条 AssistantMessage，result() 依旧 resolve 这条消息。
	return { type: "error", reason, error: assistantMessage };
}

/** 选择传给后端的缓存偏好：显式值优先，否则只映射旧环境 PI_CACHE_RETENTION=long。例未设置时返回 undefined，由 JSON 序列化省略字段，交后端默认，不在这里补 short。 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention | undefined {
	// 正常联合成员 none/short/long 都是非空字符串，包括 none 也会被保留。
	if (cacheRetention) {
		return cacheRetention;
	}
	// Backend defaults apply when unset; only the legacy env opt-in is mapped.
	// 只认确切 long；环境其他值不转成请求缓存选项，取环境过程可能有 Bun 回退读取。
	return getProviderEnvValue("PI_CACHE_RETENTION", env) === "long" ? "long" : undefined;
}

/**
 * 原生 pi-messages 请求：立即返回流，同时启动异步 POST→HTTP 钩子→SSE 观察/转换→终止事件。
 * 输入已规范 context 与显式 apiKey，输出可迭代/可 result() 的流；例 text_delta 可边读，done 后 result() 给完整消息。
 * onPayload 可替换整个载荷，onResponse 也观察非 2xx，onProviderStreamEvent 在转换/下标检查之前运行。
 * 仅转发代码列出的请求选项；timeoutMs/maxRetries/samplingParams 不在这里生效。signal 交 fetch，任意回调不被强制中断。
 * 无终止事件的 EOF 也按错误处理；客户端异常的新 error 消息清空已有内容，后端显式 error 则保留 partial。
 */
export const stream: StreamFunction<"pi-messages", PiMessagesOptions> = (
	// 参数泛型限制正常 TS 调用为本协议模型，不是对运行对象做 schema 校验。
	model: Model<"pi-messages">,
	// system/tools 已在消息结构里，不读取旧顶层 systemPrompt/tools。
	context: TranscriptContext,
	// 可省略，但没有非空 apiKey 将在下面异步体内转成错误流。
	options?: PiMessagesOptions,
): AssistantMessageEventStream => {
	// 每次请求建立独立事件队列、最终结果 Promise 和计时器。
	const eventStream = new AssistantMessageEventStream();
	// 转换器也独立于其他请求，保存这一条回答的内容和工具参数流。
	const convertEvent = createEventConverter(model);

	// void 丢弃 Promise 返回值；IIFE 立即执行到首个 await，不等调用方开始迭代才启动。
	void (async () => {
		// 捕获请求/钩子/正文读取/转换异常，正常失败走统一 error 事件。
		try {
			// 直接入口不自行查进程 key/OAuth；Models 层可先解析好再传入。
			const apiKey = options?.apiKey;
			// 空字符串也视为没有凭证，在发请求前失败。
			if (!apiKey) {
				throw new Error(`No API key provided for provider "${model.provider}"`);
			}

			// 去末尾斜线再直接拼 /messages；URL 不合法会抛到 catch，不在这里清理任意 query/path 配置。
			const url = new URL(`${model.baseUrl.replace(/\/+$/u, "")}/messages`);
			// debug 采用查询参数，默认不添加；set 会替换已有同名值。
			if (options?.debug) {
				url.searchParams.set("debug", "1");
			}

			// unknown 允许 onPayload 换成其他值；初始载荷直接引用 context，不在这里复制/裁剪历史。
			let payload: unknown = {
				model: model.id,
				context,
				options: {
					// 只转发明确列出的生成参数，undefined 在 JSON 对象序列化时通常被省略。
					temperature: options?.temperature,
					maxTokens: options?.maxTokens,
					reasoning: options?.reasoning,
					// 显式缓存偏好优先，缺失时仅采用旧 long 环境开关。
					cacheRetention: resolveCacheRetention(options?.cacheRetention, options?.env),
					// 会话路由/工具选择原样给后端，不在本地落实工具调用。
					sessionId: options?.sessionId,
					toolChoice: options?.toolChoice,
				},
			};
			// 可同步/异步观察或替换载荷；它也可原地改 context 引用，不提供深不可变保护。
			const nextPayload = await options?.onPayload?.(payload, model);
			// 只有 undefined 表示保留，null 等明确值也可整体替换。
			if (nextPayload !== undefined) {
				payload = nextPayload;
			}

			// 使用请求注入 fetch，否则宿主全局 fetch；本适配器不套 retryProviderRequest。
			const response = await (options?.fetch ?? globalThis.fetch)(url, {
				method: "POST",
				// 合并顺序：身份默认→本协议认证/格式→请求头；没有直接读取 model.headers，Models 可预先合并。
				headers: providerHeadersToRecord(
					getIdentityHeaders(model, options?.identity),
					{
						// 将显式 key 作为 Bearer；后面的自定义头可覆盖或以 null 删除它。
						authorization: `Bearer ${apiKey}`,
						accept: "text/event-stream",
						"content-type": "application/json",
					},
					options?.headers,
				),
				// 整体 JSON 序列化，此过程仍可能因循环数据等失败；不做 schema 验证。
				body: JSON.stringify(payload),
				// 只传已有 signal，没有为 timeoutMs 新建倒计时。
				signal: options?.signal,
			});

			// 响应头到达后先通知，包括失败状态；回调拒绝也会阻止后面正文解析。
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

			// 非成功 HTTP 不按 SSE 解析，先读整个文本体再包装诊断。
			if (!response.ok) {
				const body = await response.text();
				throw createPiMessagesResponseError(model, url, response, body);
			}
			// 成功状态仍可能没有 body，需要明确生成错误结果。
			if (!response.body) {
				throw new Error(`${model.provider} response has no body`);
			}

			// for await 消费异步生成器，空行分隔后得到后端原始 JSON 事件。
			for await (const piEvent of readPiMessagesEvents(response.body)) {
				// 观察器先于转换器运行；契约应只读，不在此复制/冻结阻止修改。
				await options?.onProviderStreamEvent?.(piEvent, model);
				// 下标检查和 partial 更新都发生在观察之后。
				const event = convertEvent(piEvent);
				// done/error 的 push 自动结束事件流并完成结果，不另需 end()。
				eventStream.push(event);
				// 首个协议终止即停止消费；生成器 finally 释放锁但不主动取消剩余正文。
				if (event.type === "done" || event.type === "error") {
					return;
				}
			}

			// 单纯 HTTP EOF 或 [DONE] 都不替代协议终止，避免把不完整回答冒充成功。
			throw new Error(`${model.provider} stream ended without a terminal event`);
		} catch (error) {
			// 以此刻 signal.aborted 判取消；即使最初是其他异常，信号已取消也归 aborted。
			eventStream.push(createErrorEvent(model, error, options?.signal?.aborted ?? false));
		}
	})();

	// 对外同步返回流，异步体随后继续产生数据；不返回它的后台 Promise。
	return eventStream;
};

/**
 * 简化请求入口直接转给 stream，保留统一 reasoning/toolChoice，并兼容运行对象上的 debug 扩展。
 * 例 streamSimple(model,ctx,{apiKey:"test",reasoning:"high"}) 把 high 原样发后端；不在此按模型能力 clamp 思考级别。
 * 返回同一个内层流，无额外网络/重试/错误包装；as 读取 debug 不会验证运行时字段或把任意参数变成合法 PiMessagesOptions。
 */
export const streamSimple: StreamFunction<"pi-messages", SimpleStreamOptions> = (
	model: Model<"pi-messages">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	// SimpleStreamOptions 没声明 debug，以断言读可能来自扩展参数的该字段。
	const extra = options as PiMessagesOptions | undefined;
	// 新建外层选项对象，原 options 不重赋，嵌套值仍共享。
	return stream(model, context, {
		...options,
		// 显式拷贝这两个统一参数，不运行额外供应商转换。
		reasoning: options?.reasoning,
		toolChoice: options?.toolChoice,
		// debug 缺失时仍写 undefined，stream 的条件不会添加查询参数。
		debug: extra?.debug,
	});
};
