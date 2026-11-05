// ChatGPT Codex Responses适配器：手写SSE/WebSocket传输与连接续传，复用Responses消息转换、工具流和用量处理。
// 只导入Node压缩模块的类型命名空间，不在启动时真正加载zlib。
import type * as NodeZlib from "node:zlib";
// 这一组全是OpenAI SDK类型；本文件手写HTTP/WebSocket，并未创建OpenAI SDK客户端。
import type {
	// Tool重命名为OpenAITool，避免与Pi工具声明混淆。
	Tool as OpenAITool,
	// 只借流式请求类型中的service_tier等字段约束。
	ResponseCreateParamsStreaming,
	// Responses输入条目数组，含消息、思考、工具调用与结果等。
	ResponseInput,
	// SDK流事件联合供共享处理器静态检查，不自动验证入站JSON。
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
// 把公共思考档位按模型声明能力钳制。
import { clampThinkingLevel } from "../models.ts";
// 在模块加载时登记会话资源清理，后面会用它关闭缓存WebSocket。
import { registerSessionResourceCleanup } from "../session-resources.ts";
// 下列仅导入类型，在编译后擦除，不产生实例。
import type {
	// API协议标识联合。
	Api,
	// 统一消息包含部分内容、用量、原因和诊断。
	AssistantMessage,
	// Model泛型关联本入口协议与模型元数据。
	Model,
	// 请求环境覆盖供Bun代理等局部读取，不是全局环境隔离。
	ProviderEnv,
	// 请求头字典允许null表达删除较早配置。
	ProviderHeaders,
	// 公共简化配置以reasoning表达思考请求。
	SimpleStreamOptions,
	// 泛型流函数签名。
	StreamFunction,
	// 共用信号、传输、钩子、采样和超时配置。
	StreamOptions,
	// 规范历史把system/工具变化放在messages中。
	TranscriptContext,
	// 统一使用量及本地费用对象。
	Usage,
} from "../types.ts";
// 合并用户取消和SSE头超时，清理行为与有效信号数量有关。
import { combineAbortSignals } from "../utils/abort-signals.ts";
// 诊断工具只构造/附加本地信息，不负责自动切传输。
import {
	// 给当前assistant追加诊断数组项。
	appendAssistantMessageDiagnostic,
	// 从未知异常构造诊断项。
	createAssistantMessageDiagnostic,
	// 任意抛出值转成诊断文字。
	formatThrownValue,
} from "../utils/diagnostics.ts";
// 统一提取/展示已知HTTP错误结构；不等于自动脱敏或保证绝不抛。
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
// 创建Pi异步事件通道，和网络字节/WS消息流分开。
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
// Headers转普通键值对象供钩子和WS构造器使用。
import { headersToRecord } from "../utils/headers.ts";
// 生成User-Agent及适用归因头，不代替认证。
import { getIdentityHeaders } from "../utils/identity.ts";
// 仅Bun WS分支用它按目标及环境挑HTTP/HTTPS代理。
import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.ts";
// 渲染一条system的正文和有效sections。
import { getSystemMessageText } from "../utils/text.ts";
// 轨迹辅助负责系统折叠、工具重放与旧上下文规范化。
import {
	// 取历史声明过的工具，供grammar属性映射，范围不只是当前最终活动工具。
	getDeclaredTools,
	// 只读取轨迹开头的system。
	getInitialSystemMessage,
	// 将旧顶层systemPrompt/tools等转换成规范轨迹。
	normalizeContext,
	// 按模型能力保留或折叠中途system。
	resolveTranscript,
	// 按工具增删能力决定顶层声明与历史增量声明如何分配。
	resolveTranscriptTools,
} from "../utils/transcript.ts";
// 无可用会话键时生成请求UUID，会推进进程序列并使用随机源。
import { uuidv7 } from "../utils/uuid.ts";
// 得到grammar工具名→承载字符串参数属性名映射，不执行工具。
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
// 把发给服务端的缓存/会话键截到最多64个Unicode码点，不保证截后唯一。
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
// Responses共享层复用历史/声明转换及内容块组装，本文件控制Codex认证和传输。
import {
	// Pi历史转Responses输入，含思考签名/工具id与按能力的增量声明。
	convertResponsesMessages,
	// 工具声明转function/custom grammar等Responses结构。
	convertResponsesTools,
	// 由中途system、additional_tools、tool_search能力选工具变更策略。
	getResponsesToolSupport,
	// 统一处理Responses事件的文字/思考/工具增量与终态用量，不自行发网络。
	processResponsesStream,
} from "./openai-responses-shared.ts";
// 简化选项转公共配置，并按上下文估算输出预算；本入口不一定把所有公共字段发给Codex。
import { buildBaseOptions } from "./simple-options.ts";

// ============================================================================
// Configuration
// ============================================================================

// 缺省Codex后端基础路径，最终再拼/codex/responses。
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
// JWT载荷中账号声明所在键；as const只保留字面量类型，不验证token签名。
const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;
// SSE默认不重试；下面两个WS特定恢复分支另有各一次机会。
const DEFAULT_MAX_RETRIES = 0;
// SSE本地指数退避起点1000毫秒。
const BASE_DELAY_MS = 1000;
// 只限制服务端Retry-After建议等待的缺省上限，不是整个请求总时限。
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
// WS缺省建连等待15000毫秒，和建连后的空闲超时分开。
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
// The Codex backend accepts zstd-compressed request bodies on the SSE responses
// endpoint (the same endpoint the official Codex client compresses against).
// SSE正文zstd压缩级别3；不是对会话上下文调用模型总结。
const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;
// 共享转换器据目标provider决定可保留的复合工具id风格，不是执行权限白名单。
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
// 关闭码1009补“消息太大”的可读说明，不在本地预先限制帧大小。
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
// 后端连接数限制错误码，开始前可特殊重连一次。
const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
// 续传引用丢失错误码，可清旧连接状态后特殊重试一次。
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";

// 响应状态运行时名单；未知字符串归undefined，后续共享映射有自己的兼容规则。
const CODEX_RESPONSE_STATUSES = new Set<CodexResponseStatus>([
	// 正常完成状态。
	"completed",
	// 不完整状态，须结合incomplete_details判断长度或错误。
	"incomplete",
	// 失败状态。
	"failed",
	// 后端取消状态，不等于本地signal已取消。
	"cancelled",
	// 排队状态属于本地允许名单，不能读作任务实际已完成。
	"queued",
	// 处理中状态同样允许进入共享映射，不证明已经结束计算。
	"in_progress",
]);

// ============================================================================
// Types
// ============================================================================

// 扩展公共配置的Codex原生选项，interface只作编译期契约。
export interface OpenAICodexResponsesOptions extends StreamOptions {
	// 原生effort包括none，公共简化reasoning则不含none/off这两个字符串输入。
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	// 摘要配置允许null；构建时??会把null/undefined回退auto，不承诺后端支持每个值。
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	// 索引访问复用安装SDK的service_tier类型，包括其允许的null等值。
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	// 文字详细程度仅三档，缺省构建为low。
	textVerbosity?: "low" | "medium" | "high";
	// 工具选择缺省auto，可禁用或要求调用工具，不指定单个工具名。
	toolChoice?: "auto" | "none" | "required";
}

// 本地允许的响应状态联合，与上面的运行时Set配合，不在类型层自动验证JSON。
type CodexResponseStatus = "completed" | "incomplete" | "failed" | "cancelled" | "queued" | "in_progress";

// 手写请求体，兼容Codex扩展与OpenAI Responses字段。
interface RequestBody {
	// 请求目标模型id。
	model: string;
	// 默认store:false；WS续传依赖连接状态，不要求store:true。
	store?: boolean;
	// SSE构建为stream:true，但payload钩子可修改，后面不会统一补回。
	stream?: boolean;
	// 顶层系统提示文字，和input中的中途更新分开。
	instructions?: string;
	// WS增量续传可引用上一响应id，完整上下文失败时会清掉缓存状态。
	previous_response_id?: string;
	// SDK输入数组可缺省，缓存比较时缺省视为空数组。
	input?: ResponseInput;
	// 请求级工具声明，不是工具执行回调。
	tools?: OpenAITool[];
	// 工具选择复用原生选项字段类型。
	tool_choice?: OpenAICodexResponsesOptions["toolChoice"];
	// 默认允许同轮多工具调用，不在此安排真实执行并发。
	parallel_tool_calls?: boolean;
	// 原生温度字段可省略。
	temperature?: number;
	// effort/summary用宽字符串兼容模型映射，不在此完整校验供应商接受值。
	reasoning?: { effort?: string; summary?: string };
	// 服务档位沿用SDK类型。
	service_tier?: ResponseCreateParamsStreaming["service_tier"];
	// 可选文字配置对象。
	text?: { verbosity?: string };
	// 请求额外输出字段列表，构建时要reasoning.encrypted_content。
	include?: string[];
	// 发送给后端的缓存键，不是本地WS Map的全部键。
	prompt_cache_key?: string;
	// 索引签名允许钩子附加任意字段，unknown不代表字段已经通过校验。
	[key: string]: unknown;
}

// 交叉类型把成功状态收窄成stop/length/toolUse；length不是完整回答保证。
type SuccessfulAssistantMessage = AssistantMessage & { stopReason: "stop" | "length" | "toolUse" };

/**
 * 检查本轮统一消息是否可交付，输入可变output，正常返回void并以asserts收窄TS类型，失败抛错，不修改消息。
 * 例pending报缺停止原因，error用已有错误文字，length可通过但只表示截断状态；不会证明回答内容完整、工具已执行或任务全部完成。
 */
// asserts断言函数在检查不抛后收窄output类型，真实运行只检查下面状态。
function assertSuccessfulOutput(output: AssistantMessage): asserts output is SuccessfulAssistantMessage {
	// pending表示从未得到有效停止语义，不允许当成功交给调用者。
	if (output.stopReason === "pending") {
		// 抛给外层统一错误流。
		throw new Error("Codex stream ended without a stop reason");
	}
	// 已明确error/aborted时不发done。
	if (output.stopReason === "error" || output.stopReason === "aborted") {
		// 有错误说明用它，否则固定未知错误文字；本函数不做重试。
		throw new Error(output.errorMessage || "An unknown error occurred");
	}
}

// ============================================================================
// Retry Helpers
// ============================================================================

/**
 * 按已知额度/账单文字识别终止限流，输入原错误字符串，返回布尔值，无网络/修改。
 * 例insufficient_quota命中；是大小写不敏感子串启发式，未命中不保证还有额度，也不直接阻止外层catch的其他重试路径。
 */
// 文本启发式识别“额度已耗尽”等终止限流，不查询真实账号余额。
function isTerminalRateLimitError(errorText: string): boolean {
	// 正则i忽略大小写，任一已知子串命中即true，不解析错误JSON码。
	return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
		// 参与匹配的原始错误正文。
		errorText,
	);
}

/**
 * 计算非2xx响应的内层可重试条件，输入状态和正文，返回boolean，无等待/请求。
 * 先排429硬额度，再接收几种瞬时状态或文字；例503可真，429加billing可假。外层catch还按独立规则重试，不能把false当作全函数绝不重试保证。
 */
// 判断HTTP状态/错误文字是否符合内层重试条件，不自动发请求。
function isRetryableError(status: number, errorText: string): boolean {
	// 429且像硬额度限制时先排除，避免按普通瞬时限流处理。
	if (status === 429 && isTerminalRateLimitError(errorText)) {
		// 返回false仅影响此处内层判断，外层catch还会单独按文字作决定。
		return false;
	}
	// 429/500/502/503/504内层一律可重试，其他状态还看正文。
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		// 返回true让调用点按预算等待后再请求。
		return true;
	}
	// 匹配若干瞬时故障文字；.?允许零或一个非换行字符，并非只匹配横线。
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

/**
 * 从HTTP头解析建议等待，返回非负毫秒或undefined，无I/O。
 * 优先retry-after-ms的有限数字，再标准Retry-After秒数，最后日期与本地时钟差；例"1.5"秒得到1500，负值归0，空毫秒头Number后也为0。
 * 无有效值交调用点用指数退避，函数本身不验证等待上限或启动定时器。
 */
// 读取标准Headers里的服务端建议等待时间，返回非负毫秒或undefined，无等待动作。
function getRetryAfterDelayMs(headers: Headers): number | undefined {
	// 优先自定义retry-after-ms，Headers名称不区分大小写。
	const retryAfterMs = headers.get("retry-after-ms");
	// 空字符串仍不是null，会在下面Number转换成0。
	if (retryAfterMs !== null) {
		// 数字文本转number，不是parseInt，允许小数/指数/空白等Number形式。
		const millis = Number(retryAfterMs);
		// 只采用有限数，Infinity/NaN继续试标准头。
		if (Number.isFinite(millis)) {
			// 负值归0，表示无需等待，而非返回缺失。
			return Math.max(0, millis);
		}
	}

	// 自定义毫秒头不可用才看Retry-After。
	const retryAfter = headers.get("retry-after");
	// 无标准头或空串时没有建议值。
	if (!retryAfter) {
		// 让调用者用本地退避策略。
		return undefined;
	}

	// 先按秒数解释，数值字符串无需日期解析。
	const seconds = Number(retryAfter);
	// 有限数字才乘1000，下面不另对乘积做有限性检查。
	if (Number.isFinite(seconds)) {
		// 秒转毫秒并至少0。
		return Math.max(0, seconds * 1000);
	}

	// 非数字再尝试HTTP日期解析，受Date.parse接受格式影响。
	const date = Date.parse(retryAfter);
	// 日期解析只检查不是NaN。
	if (!Number.isNaN(date)) {
		// 与当前本地时钟取差，过去日期归0，时钟误差也会影响等待。
		return Math.max(0, date - Date.now());
	}

	// 两个头都不能解析时返回缺失。
	return undefined;
}

// 专用错误子类使外层catch识别“服务端等待太久”，阻止按普通网络失败再次重试。
class RetryDelayExceededError extends Error {}

/**
 * 按配置检查服务器建议等待是否超上限，输入毫秒与选项，返回原值或抛RetryDelayExceededError，无等待副作用。
 * 例默认上限60000而建议90000时报错；显式上限<=0时不限制。只用于服务端建议值，不统一限制本地指数退避或整个请求耗时。
 */
// 按请求配置验证服务端建议等待值，返回原值或抛专用错误，不启动定时器。
function validateRetryDelayMs(delayMs: number, options?: StreamOptions): number {
	// 未给上限默认60000；显式0/负数会让下面的上限检查不生效。
	const maxRetryDelayMs = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	// 仅上限>0且建议等待更长才拒绝，不验证所有数值范围。
	if (maxRetryDelayMs > 0 && delayMs > maxRetryDelayMs) {
		// 抛专用错误让外层catch停止重试。
		throw new RetryDelayExceededError(
			// 显示秒数向上取整，保留原错误字符串。
			`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxRetryDelayMs / 1000)}s)`,
		);
	}
	// 合法范围直接返回毫秒，调用点再执行sleep。
	return delayMs;
}

/**
 * 按毫秒建立可取消的退避Promise，输入可选用户信号，无返回数据；会安装timer/abort监听。
 * 例1000ms到时resolve，先取消则clearTimeout并reject固定取消错误。此实现正常到时后不移除abort监听，Promise结算也不代表监听已回收。
 */
// 返回可被用户信号打断的退避Promise；会分配定时器和取消监听。
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	/**
	 * Promise执行器立即查看信号并安装定时器，resolve表示等完、reject表示取消，无独立返回数据。
	 * 例预先取消时立即拒绝且不创建timer，运行中取消由下方回调处理。
	 */
	// Promise执行器立即安装等待，resolve/reject决定Promise状态。
	return new Promise((resolve, reject) => {
		// 早已取消则不安装timer。
		if (signal?.aborted) {
			// 拒绝统一取消Error，不把原signal.reason直接作为异常。
			reject(new Error("Request was aborted"));
			// 避免继续创建定时器/监听。
			return;
		}
		// 到时resolve；本实现未在正常到时后移除下面abort监听。
		const timeout = setTimeout(resolve, ms);
		/**
		 * 取消回调清理等待timer并拒绝Promise，输入事件未使用，返回void。
		 * 例已正常resolve后再取消只会尝试重复reject，不能改变Promise既有结果；监听本身没有once配置。
		 */
		// 有信号则注册取消回调，没有once或主动清理，已结算Promise的后续reject不会改结果。
		signal?.addEventListener("abort", () => {
			// 取消时清除尚在等待的timer。
			clearTimeout(timeout);
			// 拒绝退避Promise，让外层结束重试。
			reject(new Error("Request was aborted"));
		});
	});
}

/**
 * 将可选超时值转成非负整数毫秒，输入number|undefined，返回number|undefined，无I/O。
 * 例1.9→1、0.5→0，NaN/Infinity/负数抛错；这里只规范数值，0在后续调用点意味着不安装相应超时。
 */
// 将超时配置规范成向下取整的非负毫秒，缺省保持undefined，无定时器。
function normalizeTimeoutMs(value: number | undefined): number | undefined {
	// undefined表示让调用点采用各自默认，不等于0。
	if (value === undefined) return undefined;
	// number类型仍可为NaN/Infinity/负数，所以配置边界真实检查这些情况。
	if (!Number.isFinite(value) || value < 0) {
		// 错误文案固定提timeoutMs，也用于websocketConnectTimeoutMs输入。
		throw new Error(`Invalid timeoutMs: ${String(value)}`);
	}
	// 向下取整，小于1的正数会变0；不同调用点把0作为禁用超时处理。
	return Math.floor(value);
}

// ============================================================================
// Request Compression
// ============================================================================

// 交叉类型给process添加可选getBuiltinModule签名，typeof这里取变量类型，不执行检查。
type ProcessWithBuiltinModule = typeof process & {
	// 限定此视图只获取node:zlib，返回模块类型；问号允许旧运行时缺该方法。
	getBuiltinModule?: (id: "node:zlib") => typeof NodeZlib;
};

/**
 * 尝试从当前Node/Bun的process.getBuiltinModule取zlib，返回模块或null，不在本文件静态导入其运行值。
 * 例浏览器直接null、旧Node缺方法也null；getBuiltinModule自身抛错不在此兜底，不等于保证所有环境都能压缩。
 */
// 按运行时能力延后取zlib对象，返回模块或null，不用静态运行值import。
function loadNodeZlib(): typeof NodeZlib | null {
	// 浏览器无process或未识别Node/Bun时不访问内建模块。
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
		// 表示压缩不可用，让SSE发送原JSON。
		return null;
	}
	// 可选调用getBuiltinModule；缺方法/空返回用null，方法本身若抛错此处没有catch。
	return (process as ProcessWithBuiltinModule).getBuiltinModule?.("node:zlib") ?? null;
}

// Returns the zstd-compressed body bytes, or null when compression is
// unavailable (browser/Vite builds). Callers fall back to sending the
// uncompressed JSON when this returns null.
/**
 * 把已序列化JSON尝试同步zstd压缩，返回拥有独立ArrayBuffer的Uint8Array或null，不改变请求对象、不发网络。
 * 先检查运行时模块/方法，再按级别3压缩并复制结果；例缺zstd能力或压缩失败返回null，调用方发送原JSON。
 * 只减少HTTP正文传输字节，不总结/删除模型上下文；模块获取在压缩try之外，其异常仍可向上抛。
 */
// 输入完整JSON字符串，尝试同步zstd压缩，返回独立字节数组或null，不请求模型。
function compressRequestBodyZstd(bodyJson: string): Uint8Array<ArrayBuffer> | null {
	// 取得本地zlib能力；此调用在下面压缩try之前。
	const zlib = loadNodeZlib();
	// 模块或zstd方法缺失即降级，不当作本轮生成错误。
	if (!zlib || typeof zlib.zstdCompressSync !== "function") {
		// 返回null让调用方保留原始JSON。
		return null;
	}
	// 只包真正压缩步骤与结果复制，失败可退回明文JSON。
	try {
		// 同步压缩消耗本地CPU，不包含模型上下文摘要机制。
		const compressed = zlib.zstdCompressSync(bodyJson, {
			// 计算属性名选择ZSTD压缩级别参数，采用模块常量而非硬编码数值键。
			params: { [zlib.constants.ZSTD_c_compressionLevel]: REQUEST_COMPRESSION_ZSTD_LEVEL },
		});
		// A copy owns a plain ArrayBuffer, which fetch accepts as a body under every lib.
		// Uint8Array复制Buffer内容，得到拥有普通ArrayBuffer的正文，便于不同fetch类型库接受。
		return new Uint8Array(compressed);
		// 压缩/复制异常被吞，回退无压缩而不自动重试压缩。
	} catch {
		// null不代表空正文，只是“使用原JSON”的信号。
		return null;
	}
}

// ============================================================================
// Main Stream Function
// ============================================================================

/**
 * 调用ChatGPT Codex Responses，同步返回Pi事件流；输入模型、完整历史与原生选项，token通过apiKey字段传入。
 * 先处理轨迹/grammar、账号claim、请求体与头，再尝试WS及其特殊恢复，必要时回退SSE+zstd/请求重试；两条传输最终都委托共享Responses处理器组装内容/用量。
 * 会联网、调用钩子、使用进程内连接/统计缓存并更新本轮共享消息，不执行模型请求的工具。例连续工具轮在显式auto/websocket-cached且历史前缀一致时可只发新增输入与previous_response_id。
 * 失败通常保留partial并发error；前置轨迹处理仍可同步抛错。配置为websocket也可能在开始前回退SSE，开始后通常不重放，但特定missing continuation分支按实际条件另有一次重试。
 */
// 泛型静态绑定本协议与原生配置；函数同步返回通道，网络任务在内部异步推进。
export const stream: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions> = (
	// 模型含后端基础URL、能力、价格，不在此发现/刷新模型目录。
	model: Model<"openai-codex-responses">,
	// 输入完整规范历史，不只是本轮最后一句。
	context: TranscriptContext,
	// 配置可整体省略，key仍要在内部检查。
	options?: OpenAICodexResponsesOptions,
	// 返回Pi事件流，调用者可for await并最终result()。
): AssistantMessageEventStream => {
	// 先建本地通道，不等HTTP/WS连接成功。
	const stream = new AssistantMessageEventStream();
	// 按兼容标志处理system；此同步调用在内部try之外，可以同步抛错。
	const normalizedContext = resolveTranscript(context, model.compat?.supportsMidConvoSystemMessages);

	/**
	 * 立即推进本轮异步任务，闭包读取模型/选项/通道，外层不返回该Promise。
	 * 成功通过状态断言后发done，失败通常保留已发布内容并发error；例SSE中途JSON坏了不会在请求重试循环中重放正文，错误格式化本身再次失败也没有第二层catch。
	 */
	// 立即执行async任务，Promise不作为外层返回值，通常通过事件通道交结果。
	(async () => {
		// 创建本轮共享可变输出，partial事件不自动复制快照。
		const output: AssistantMessage = {
			// 角色为assistant。
			role: "assistant",
			// 内容初始空，后面共享处理器逐块追加。
			content: [],
			// API为本入口协议，as只帮助TS，不转换字符串值。
			api: "openai-codex-responses" as Api,
			// 记录请求provider身份。
			provider: model.provider,
			// 记录请求模型id，不从远端model字段自动切换身份/目录价。
			model: model.id,
			// 统一使用量初始零。
			usage: {
				// 非缓存输入初始零。
				input: 0,
				// 输出初始零。
				output: 0,
				// 缓存读取初始零。
				cacheRead: 0,
				// 缓存写入初始零。
				cacheWrite: 0,
				// 总token初始零。
				totalTokens: 0,
				// 费用容器初始各项零，终态再按模型价格和tier调整。
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			// pending表示还没有可交付的最终停止状态。
			stopReason: "pending",
			// 使用本地毫秒起始时间，不是服务器响应时间。
			timestamp: Date.now(),
		};

		// 客户端逻辑、请求、钩子、流转换与成功断言失败进这一层catch。
		try {
			// 只取显式apiKey，这里实际期望可解析出账号claim的token，不在此登录/刷新OAuth。
			const apiKey = options?.apiKey;
			// 缺值/空串直接拒绝，纯空格非空但后续token解析会失败。
			if (!apiKey) {
				// 内部任务中抛错通常转失败流，与简化入口同步key检查不同。
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			// 解码token载荷里的账号id，不在此验证签名/有效期/账号权限。
			const accountId = extractAccountId(apiKey);
			// 建grammar工具名→参数属性映射，供请求/返回原始文本包装使用。
			const grammarToolInputProperties = createGrammarToolInputProperties(
				// 使用历史声明工具集合，而非只取本轮最终活跃工具；同名声明的收集策略由helper决定。
				getDeclaredTools(normalizedContext.messages),
				// 缺省不启用OpenAI grammar工具，不能仅因工具声明有grammar就发送custom协议。
				model.compat?.supportsOpenAIGrammarTools ?? false,
			);
			// cacheRetention精确none时不自动使用sessionId做缓存亲和/本地WS复用，显式钩子/头仍可另改。
			const cacheSessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
			// 发给后端的会话/缓存键按最多64码点截断；本地Map后面仍使用未截的cacheSessionId。
			const codexSessionId = clampOpenAIPromptCacheKey(cacheSessionId);
			// 构建请求体并留给钩子修改，let允许整体替换。
			let body = buildRequestBody(model, normalizedContext, options, codexSessionId, grammarToolInputProperties);
			// 等待可选payload钩子，它可修改引用、返回替换值或抛错。
			const nextBody = await options?.onPayload?.(body, model);
			// 非undefined才采用替换对象，undefined保留原地修改。
			if (nextBody !== undefined) {
				// as不做运行时校验，不强制重设store/stream/cache键等默认字段。
				body = nextBody as RequestBody;
			}
			// 有真值截后会话键则复用，否则生成UUID；即使最终只走SSE，此行也会计算。
			const websocketRequestId = codexSessionId || uuidv7();
			// Codex expects an originator on every request; it is not attribution.
			// originator默认pi，身份头后展开；模型/请求层仍可改originator，认证头稍后强制设置。
			const identityHeaders = { originator: "pi", ...getIdentityHeaders(model, options?.identity) };
			// 先创建SSE头，后面即使WS成功也已完成该头对象构建。
			const sseHeaders = buildSSEHeaders(
				// 默认originator/User-Agent/归因头。
				identityHeaders,
				// 模型默认头来源。
				model.headers,
				// 本次额外头，null可删除部分较早字段。
				options?.headers,
				// 账号claim交认证头构建，未在此核验真实归属。
				accountId,
				// 显式token作为Bearer。
				apiKey,
				// 截到64码点的会话键，用于SSE自动亲和头。
				codexSessionId,
			);
			// WS头另建一份，认证同源但beta/请求id和协议头策略不同。
			const websocketHeaders = buildWebSocketHeaders(
				// 共用身份默认头。
				identityHeaders,
				// 模型头继续参与WS构建。
				model.headers,
				// 本次WS附加头，与SSE来源顺序相同。
				options?.headers,
				// 账号claim值交WS认证头和本地账号分组。
				accountId,
				// 同一token用于WS握手Bearer。
				apiKey,
				// WS必须有请求标识，即使没有会话也用新UUID。
				websocketRequestId,
			);
			// 此时序列化一次完整body，供SSE正文/诊断字节数；WS还会单独序列化其可能的增量体。
			const bodyJson = JSON.stringify(body);
			// HTTP超时规范化；未给则SSE不主动设头超时，WS也不设读空闲超时。
			const httpTimeoutMs = normalizeTimeoutMs(options?.timeoutMs);
			// WS建连超时独立规范化；undefined让下层用15000，0禁用建连timer。
			const websocketConnectTimeoutMs = normalizeTimeoutMs(options?.websocketConnectTimeoutMs);
			// 传输选择缺省或假值时视作auto；下层续传开关另直接看原options.transport，省略与显式auto并不完全等价。
			const transport = options?.transport || "auto";
			// 一轮请求最终只发布一次start，跨恢复尝试也复用该标记。
			let startEmitted = false;
			// 非sse时才查原会话是否已记住WS失败；该回退Set按session而非账号划分。
			const websocketDisabledForSession = transport !== "sse" && isWebSocketSseFallbackActive(cacheSessionId);
			// 已记住回退就跳过WS，本轮直接走SSE。
			if (websocketDisabledForSession) {
				// 只累计回退次数/状态，不重新探测WS是否恢复。
				recordWebSocketSseFallback(cacheSessionId);
			}

			// 显式sse或会话已回退都不尝试WS；其他传输值可进入WS分支。
			if (transport !== "sse" && !websocketDisabledForSession) {
				// 标记本次WS尝试是否已收到经过映射的首事件，不等于已产出可见文字。
				let websocketStarted = false;
				// 连接数限制恢复独立最多一次，不消费SSE maxRetries预算。
				let retriedWebSocketConnectionLimit = false;
				// 缺续传引用恢复另有一次机会，与上一个标记分开。
				let retriedMissingWebSocketContinuation = false;
				// 正常通过return结束，失败按两个特殊条件continue或break/throw，不是无条件无限重试。
				while (true) {
					// 每次WS重试重置“本次开始”标记，整轮startEmitted和已有output不在此清空。
					websocketStarted = false;
					// 捕获连接、发送、流消费、成功断言中的错误。
					try {
						// 等本次WS处理完，可能复用连接/改用增量上下文。
						await processWebSocketStream(
							// 将基础HTTP地址解析成对应ws/wss URL，坏URL可抛错。
							resolveCodexWebSocketUrl(model.baseUrl),
							// 使用钩子后的body对象，可能被续传层缩成新增input。
							body,
							// 本轮WS握手头，新建连接时使用；复用连接不会重新握手改头。
							websocketHeaders,
							// 同一输出对象，在不同恢复尝试间不自动清空partial。
							output,
							// 同一Pi事件通道。
							stream,
							// 模型用于共享转换/计价，不用于WS账户验证。
							model,
							/**
							 * 首个经过Codex映射的事件触发的开始回调，输入无参数，返回void，更新本次/整轮标记并最多推一次start。
							 * 例先收到response.created就算本次开始，尚无可见文字也通常不再允许普通传输失败从头SSE回放；特殊续传错误恢复仍依其独立条件。
							 */
							// 首个映射后事件到来才调用此回调，网络open本身不触发Pi start。
							() => {
								// 标记当前尝试已开始，供普通传输失败决定是否还能SSE回退。
								websocketStarted = true;
								// 整轮还没发start才发布，避免两次特殊恢复重复start。
								if (!startEmitted) {
									// 先更新状态再发事件。
									startEmitted = true;
									// 发布共享output的start，首事件可能只是response.created或未支持的有type事件。
									stream.push({ type: "start", partial: output });
								}
							},
							// 将HTTP timeoutMs复用为WS等下一消息的空闲时限，不是整个WS调用总时长。
							httpTimeoutMs,
							// 建连等待上限独立传给下层。
							websocketConnectTimeoutMs,
							// 原始未截会话键用于本地连接/回退/统计，不是发送头的截断键。
							cacheSessionId,
							// 按解码账号claim分连接缓存，未按token/URL/header/模型再细分。
							accountId,
							// grammar映射交共享流处理器包装custom工具原始文本。
							grammarToolInputProperties,
							// 原生选项供信号、观察钩子、传输模式与代理读取。
							options,
						);

						// WS处理后再次检查本地取消。
						if (options?.signal?.aborted) {
							// 已取消则不发成功done。
							throw new Error("Request was aborted");
						}
						// 只允许统一stop/length/toolUse终态通过，失败转下面catch。
						assertSuccessfulOutput(output);
						// 发布最终成功事件。
						stream.push({
							// done标签，不意味着整个Agent任务结束。
							type: "done",
							// 断言已把原因收窄到可交付成功联合。
							reason: output.stopReason,
							// 传整条共享回复对象。
							message: output,
						});
						// 结束本地流。
						stream.end();
						// WS成功直接结束异步任务，不再执行下面SSE请求。
						return;
						// 失败分析特殊恢复/业务错误/传输回退。
					} catch (error) {
						// 读取捕获时用户是否取消，取消优先阻止恢复。
						const aborted = options?.signal?.aborted;
						// 仅本次WS未开始且错误码为连接数限制，才允许对应特例。
						const connectionLimitBeforeStart = !websocketStarted && isWebSocketConnectionLimitReachedError(error);
						// 缺previous_response错误只看专用类型/码，此变量本身不要求未开始。
						const previousResponseNotFound = isPreviousResponseNotFoundError(error);
						// 未取消且还没做过缺续传恢复时重试；这里没有!websocketStarted条件。
						if (!aborted && previousResponseNotFound && !retriedMissingWebSocketContinuation) {
							// 整轮记住已用掉这次恢复机会。
							retriedMissingWebSocketContinuation = true;
							// 下层失败已清连接续传并释放/关闭，下一轮按同一完整body再尝试；不在这里回滚已有output。
							continue;
						}
						// 连接数限制必须发生在开始前且没恢复过才特殊重连。
						if (!aborted && connectionLimitBeforeStart && !retriedWebSocketConnectionLimit) {
							// 标记这次特例已使用。
							retriedWebSocketConnectionLimit = true;
							// 继续WS while，不先写SSE回退诊断。
							continue;
						}
						// 已取消或业务/协议/观察钩子错误通常直接向上抛；开始前连接数限制除外可进入普通回退。
						if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeStart)) {
							// 不把这类错误都当网络失败重放。
							throw error;
						}
						// 给output附传输失败诊断，通常只影响本地消息的diagnostics字段。
						appendAssistantMessageDiagnostic(
							// 要修改的本轮消息。
							output,
							// 诊断记录错误文字与下列上下文，不自动清空/脱敏所有错误字段。
							createAssistantMessageDiagnostic("provider_transport_failure", error, {
								// 记录本轮归一化后的传输选择。
								configuredTransport: transport,
								// 开始前才声明拟回退sse，开始后不写该fallback字段。
								...(websocketStarted ? {} : { fallbackTransport: "sse" }),
								// 记录是否已发布当前尝试start，不是精确的正文事件数量。
								eventsEmitted: websocketStarted,
								// 记录失败相对start的阶段。
								phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
								// 按预先完整bodyJson的UTF-8字节数记录，不是WS增量体或zstd后字节数。
								requestBytes: new TextEncoder().encode(bodyJson).byteLength,
							}),
						);
						// 有原会话键才标记以后跳过WS并更新统计；无键只影响这轮。
						recordWebSocketFailure(cacheSessionId, error);
						// 普通传输失败发生在开始后则停止，不从头SSE重放。
						if (websocketStarted) {
							// 失败仍保留先前partial，交外层error事件。
							throw error;
						}
						// 开始前失败则记本轮SSE回退次数。
						recordWebSocketSseFallback(cacheSessionId);
						// 退出WS while，接着执行SSE分支；显式websocket也走这条回退路径。
						break;
					}
				}
			}

			// Compress the request body once for the SSE path. The Codex backend
			// decodes Content-Encoding: zstd; the WebSocket transport above sends the
			// uncompressed JSON frame, matching the official Codex client.
			// 只有真正进入SSE路径才压缩一次，后面的SSE重试复用同一正文。
			const compressedBody = compressRequestBodyZstd(bodyJson);
			// 字节数组即使很短也是真值；没有比较压缩后是否更小。
			if (compressedBody) {
				// 成功压缩时强制设置content-encoding:zstd，覆盖较早自定义值。
				sseHeaders.set("content-encoding", "zstd");
			}
			// null才用原JSON字串；未压缩时没有在此删除用户自定义content-encoding。
			const sseBody: Uint8Array<ArrayBuffer> | string = compressedBody ?? bodyJson;

			// Fetch with retry logic for rate limits and transient errors
			// 保存最后一次HTTP响应，跨请求尝试更新。
			let response: Response | undefined;
			// 保存catch格式化后的Error供最终失败回退。
			let lastError: Error | undefined;
			// 默认0，显式数值原样参与循环，没有独立整数/有限/非负检查。
			const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;

			// attempt=0是首次，<=表示正常整数预算N可请求N+1次；异常预算遵循原JS比较规则。
			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				// 每轮发起前查看用户取消。
				if (options?.signal?.aborted) {
					// 已取消立即离开，不继续压测后端。
					throw new Error("Request was aborted");
				}

				// 包含HTTP、响应钩子、错误正文和内层错误处理，所以下面catch不只接网络异常。
				try {
					// 每次HTTP尝试单独创建头超时信号。
					const headerTimeoutSignal =
						// 只有规范后值>0才建timer；undefined/0都不设头等待上限。
						httpTimeoutMs !== undefined && httpTimeoutMs > 0 ? AbortSignal.timeout(httpTimeoutMs) : undefined;
					// 合并用户与头超时；仅一个有效信号时helper直接复用原信号。
					const combinedSignal = combineAbortSignals([options?.signal, headerTimeoutSignal]);
					// 小try只围fetch阶段，区分头超时文字。
					try {
						// 本次fetch优先，否则全局fetch；WS路径不会因为设置fetch就自动改用它。
						response = await (options?.fetch ?? globalThis.fetch)(resolveCodexUrl(model.baseUrl), {
							// HTTP POST到Codex Responses地址。
							method: "POST",
							// 复用已构建的SSE头，认证/协议字段有自己的最后覆盖策略。
							headers: sseHeaders,
							// 发送预先压缩的字节或原JSON，不每次重建payload/执行钩子。
							body: sseBody,
							// 传合成信号；单来源头超时直接留给fetch，清理不保证其不再影响响应正文。
							signal: combinedSignal.signal,
						});
						// 发起请求失败时检查超时与用户取消状态。
					} catch (error) {
						// 头超时已触发且用户未取消时，用头超时说明覆盖原失败。
						if (headerTimeoutSignal?.aborted && !options?.signal?.aborted) {
							// 记录本次规范后的毫秒时限。
							throw new Error(`Codex SSE response headers timed out after ${httpTimeoutMs}ms`);
						}
						// 其他原错误向外层每轮catch传播。
						throw error;
						// 无论fetch成功失败都清理合并监听。
					} finally {
						// 双来源解除中转监听，单来源是空操作；不会撤销AbortSignal.timeout本身的定时。
						combinedSignal.cleanup();
					}
					// 每个HTTP响应（包括失败状态）先等待onResponse，钩子异常也会进当前请求重试catch。
					await options?.onResponse?.(
						// 只传状态和普通头字典，不把可消费Response本体交钩子。
						{ status: response.status, headers: headersToRecord(response.headers) },
						// 附请求模型身份。
						model,
					);

					// response.ok才离开请求重试循环，随后再处理body。
					if (response.ok) {
						// 不在此解码成功正文。
						break;
					}

					// 非2xx正文完整读入内存再分析，没有单独的错误体长度限制。
					const errorText = await response.text();
					// 有剩余预算且内层可重试，先走尊重Retry-After的路径。
					if (attempt < maxRetries && isRetryableError(response.status, errorText)) {
						// 解析毫秒、秒或日期建议时间。
						const retryAfterDelayMs = getRetryAfterDelayMs(response.headers);
						// 没建议用本地退避，有建议先查允许等待上限。
						const delayMs =
							// 只undefined表示无建议，建议0会使用0。
							retryAfterDelayMs === undefined
								? // **为幂运算，依尝试次数1s、2s、4s；这条不经过validateRetryDelayMs。
									BASE_DELAY_MS * 2 ** attempt
								: // 服务端建议超过上限抛专用Error，外层不会再把它当普通网络失败。
									validateRetryDelayMs(retryAfterDelayMs, options);

						// 退避可被用户取消，成功等完才继续请求。
						await sleep(delayMs, options?.signal);
						// 进入下一次HTTP尝试，复用body/headers。
						continue;
					}

					// Parse error for friendly message on final attempt or non-retryable error
					// 非内层可重试或预算已用完时，先重建可再次读取的本地Response供友好错误解析。
					const fakeResponse = new Response(errorText, {
						// 保留原HTTP状态。
						status: response.status,
						// 保留原状态文字，原headers不在此复制。
						statusText: response.statusText,
					});
					// 解析错误JSON与配额提示；新的Response.text会读取同一错误文本副本。
					const info = await parseErrorResponse(fakeResponse);
					// 优先友好提示；这个throw仍会被下面catch再次判断是否指数重试。
					throw new Error(info.friendlyMessage || info.message);
					// 每轮catch并非只处理网络错误，onResponse/解析/非重试HTTP抛错也会进来。
				} catch (error) {
					// 先识别标准Error的取消外形。
					if (error instanceof Error) {
						// 名为AbortError或精确取消文字时统一视作取消，不在此要求signal真已aborted。
						if (error.name === "AbortError" || error.message === "Request was aborted") {
							// 重抛固定取消Error，避开后面的普通重试。
							throw new Error("Request was aborted");
						}
					}
					// 未知抛出值用String包装成Error，String自身仍可能失败。
					lastError = error instanceof Error ? error : new Error(String(error));
					// Network errors are retryable
					// 只按剩余预算、专用等待错误和包含usage limit决定普通重试，不重新检查HTTP status。
					if (
						// 仍有尝试预算才可能重试。
						attempt < maxRetries &&
						// 超上限的服务端等待错误必须停止。
						!(lastError instanceof RetryDelayExceededError) &&
						// includes区分大小写，只排含小写usage limit的说明；内层硬额度识别false不等于必然阻止这里。
						!lastError.message.includes("usage limit")
					) {
						// 普通catch重试只用本地指数等待，不读响应头，也不统一受maxRetryDelayMs约束。
						const delayMs = BASE_DELAY_MS * 2 ** attempt;
						// 等待过程中取消会拒绝并向本轮外层任务传播。
						await sleep(delayMs, options?.signal);
						// 等完进入下一尝试。
						continue;
					}
					// 不符合重试条件则抛最后Error。
					throw lastError;
				}
			}

			// 循环可能因异常预算不执行/没成功响应，最后必须确认ok。
			if (!response?.ok) {
				// 有最后Error优先，否则固定请求失败说明。
				throw lastError ?? new Error("Failed after retries");
			}

			// 成功状态还要求有body流。
			if (!response.body) {
				// 缺正文直接失败，不生成假终态。
				throw new Error("No response body");
			}

			// 整轮尚未发start才在SSE处理前发布，特殊WS重试曾发过时不会重复。
			if (!startEmitted) {
				// 先设标记再推事件。
				startEmitted = true;
				// 此时拿到HTTP成功body，但还未消费模型正文。
				stream.push({ type: "start", partial: output });
			}
			// 将SSE解析/事件映射再委托共享Responses处理器；这步在请求重试循环之外。
			await processStream(response, output, stream, model, grammarToolInputProperties, options);

			// 正文处理完再看用户取消。
			if (options?.signal?.aborted) {
				// 取消时不发成功done；已收到内容继续保留在output。
				throw new Error("Request was aborted");
			}

			// 检查共享处理器得出的统一终态，不凭HTTP 200断定成功。
			assertSuccessfulOutput(output);
			// 成功done可为stop/length/toolUse，工具执行由上层继续。
			stream.push({ type: "done", reason: output.stopReason, message: output });
			// 结束本地事件通道。
			stream.end();
			// 全轮catch捕获构建/传输/解析等失败，除前置resolveTranscript外。
		} catch (error) {
			// 用户信号状态优先分类aborted，否则error，即使某错误名看似AbortError也未必变aborted。
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			// 提取格式化诊断文字；不在本文件自动脱敏，错误对象自己的转换仍可能再次失败。
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			// 发失败消息，之前输出/诊断不回滚。
			stream.push({ type: "error", reason: output.stopReason, error: output });
			// 关闭失败流；如果错误格式化再次抛错就到不了这里。
			stream.end();
		}
		// 调用闭包启动任务，外层不等待这个Promise。
	})();

	// 把Pi通道返回调用者。
	return stream;
};

/**
 * 将公共简化配置转换成Codex原生effort后调用stream，返回同一事件通道；输入模型/完整会话/公共选项。
 * 先同步要求token、构造基础配置，再钳制reasoning，off转undefined；例模型minimal映射low时，原生构建器发low。
 * 配置错误可同步抛，真正网络/资源缓存由stream负责；基础helper虽算maxTokens，本请求构建器没有独立发送max_output_tokens字段。
 */
// 简化入口把统一reasoning转换为原生reasoningEffort后启动stream。
export const streamSimple: StreamFunction<"openai-codex-responses", SimpleStreamOptions> = (
	// 模型类型静态限定本协议。
	model: Model<"openai-codex-responses">,
	// 完整会话，后面原生入口还按能力处理system。
	context: TranscriptContext,
	// 公共选项由buildBaseOptions只复制选定字段，不是把任意原生字段全部透传。
	options?: SimpleStreamOptions,
	// 入口本身同步，配置解析错误可直接抛。
): AssistantMessageEventStream => {
	// 读取显式token字段，不在这里调用登录/刷新。
	const apiKey = options?.apiKey;
	// 缺token检查在创建原生流之前。
	if (!apiKey) {
		// 直接同步抛错，不是一个error事件。
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	// 新建公共基础配置。
	const base = {
		// 合并公共采样配置并估算输出预算；该预算字段在下面Codex请求构建器没有自动映射成max_output_tokens。
		...buildBaseOptions(model, context, options, apiKey),
		// toolChoice单独复制，因为基础helper没有这个字段。
		toolChoice: options?.toolChoice,
		// satisfies是静态兼容检查，不改变对象运行值。
	} satisfies OpenAICodexResponsesOptions;
	// 只有请求reasoning时才按模型能力钳制，省略保持undefined。
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	// 钳制结果off转undefined，原生构建器再决定是否发送模型off映射。
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	// 调原生入口，真正网络/重试/流事件都由其负责。
	return stream(model, context, {
		// 先复制公共字段。
		...base,
		// 属性简写传计算后的原生effort，未传reasoningSummary等原生专属字段。
		reasoningEffort,
		// satisfies仍不提供runtime校验。
	} satisfies OpenAICodexResponsesOptions);
};

// ============================================================================
// Request Building
// ============================================================================

/**
 * 构造完整Codex Responses请求，输入模型、轨迹、原生配置、服务端缓存键和grammar映射，返回新对象，无网络。
 * 先按能力解析工具策略/历史，再把首system放instructions，设store:false/stream:true/低详细度/加密思考包含项，最后附温度/tier/工具/effort。
 * 例原生none且off:null会省略reasoning，其他档映射null则回退原档；普通工具默认strict:null，声明可要求strict:true。转换/grammar/schema/签名JSON等可抛错。
 * 没有独立展开samplingParams、maxTokens或metadata为请求字段；payload钩子后续可修改这些默认值，不能把构建结果当最终wire保证。
 */
// 构建完整Responses请求体，返回新对象，不发网络或执行工具。
function buildRequestBody(
	// 模型提供能力、id、思考映射。
	model: Model<"openai-codex-responses">,
	// 规范上下文包含系统/工具变更。
	context: TranscriptContext,
	// 配置参数必传位置，但类型允许undefined，不是?可选参数。
	options: OpenAICodexResponsesOptions | undefined,
	// 这里收到的是已截断的服务端缓存键，不是原始本地WS缓存键。
	cacheSessionId: string | undefined,
	// 可选默认参数仅在没显式传映射时重新计算，ReadonlyMap只限制编译期写入。
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		// grammar映射来自历史声明工具。
		getDeclaredTools(context.messages),
		// 兼容能力缺省false才不尝试grammar。
		model.compat?.supportsOpenAIGrammarTools ?? false,
	),
	// 返回本地宽松RequestBody，不是通过运行时schema检查的网络响应。
): RequestBody {
	// strict字段能力缺省true，工具约束是否启用还由共享转换器决定。
	const supportsStrictMode = model.compat?.supportsStrictMode ?? true;
	// grammar能力缺省false。
	const supportsOpenAIGrammarTools = model.compat?.supportsOpenAIGrammarTools ?? false;
	// 原位additional_tools声明能力缺省false。
	const supportsAdditionalTools = model.compat?.supportsAdditionalTools ?? false;
	// 客户端工具搜索补增能力缺省false。
	const supportsToolSearch = model.compat?.supportsToolSearch ?? false;
	// 按兼容组合计算顶层requestTools与历史tool变化，不只取最终工具数组。
	const transcriptTools = resolveTranscriptTools(
		// 输入原始规范轨迹，保留system变更位置。
		context.messages,
		// 共享策略优先changes，其次additions，最后none。
		getResponsesToolSupport({
			// 中途system能力和additional_tools同时支持才可用更完整变更策略。
			supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
			// 将additional能力交策略。
			supportsAdditionalTools,
			// tool_search能力在不能changes时仍可选只新增路径。
			supportsToolSearch,
		}),
	);
	// 转Responses历史，跨模型id/签名和工具变更由共享层处理。
	const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
		// 首条系统提示不塞input，改放下面顶层instructions；受能力允许的中途更新另有处理。
		includeSystemPrompt: false,
		// grammar工具属性映射用于旧调用/结果的自定义原始文本形状。
		grammarToolInputProperties,
		// 告知共享层是否保留中途system。
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		// 允许时插原位工具声明，但不自动给权限。
		supportsAdditionalTools,
		// 允许时合成工具搜索加载记录。
		supportsToolSearch,
		// 默认strict为null而非false，声明中的prefer/require仍可覆盖成true，能力关时可能省字段。
		toolOptions: { strict: null, supportsStrictMode, supportsOpenAIGrammarTools },
	});

	// 只读上下文首条system，不在此随便挑中途规则当顶层提示。
	const initialSystemMessage = getInitialSystemMessage(context.messages);
	// 将首条system正文/sections渲染，缺省空串。
	const instructions = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	// 新建请求体及嵌套文字配置。
	const body: RequestBody = {
		// 目标模型id原样发送。
		model: model.id,
		// 默认不请求后端存储；连接级续传不依赖把它改true，payload钩子仍可覆盖。
		store: false,
		// 默认流式SSE字段true；WS发送同一体时也保留此既有字段。
		stream: true,
		// 系统提示是假值空串时用固定英语缺省；有非空文字则原样保留，不trim。
		instructions: instructions || "You are a helpful assistant.",
		// 复用转换好的输入数组。
		input: messages,
		// 原生详细程度缺省low，使用||，未类型化空串也会回退。
		text: { verbosity: options?.textVerbosity || "low" },
		// 请求可回放的加密reasoning内容，不等于在这里做摘要/解密。
		include: ["reasoning.encrypted_content"],
		// 放截后会话键；undefined字段在JSON.stringify时省略。
		prompt_cache_key: cacheSessionId,
		// 工具选择缺省auto，null未类型化输入也会因??回退。
		tool_choice: options?.toolChoice ?? "auto",
		// 默认声明允许并行工具请求，不在此启动任何工具。
		parallel_tool_calls: true,
	};

	// 显式温度保留0，不验证模型是否支持。
	if (options?.temperature !== undefined) {
		// 原样设置温度。
		body.temperature = options.temperature;
	}

	// serviceTier只排undefined，SDK允许的null会写入请求。
	if (options?.serviceTier !== undefined) {
		// 原样发送service_tier，之后费用策略还可看响应tier。
		body.service_tier = options.serviceTier;
	}

	// 顶层策略确有工具才附tools，不把所有历史声明无条件全部重复发顶层。
	if (transcriptTools.requestTools.length > 0) {
		// 声明转换支持function/custom grammar，不执行工具。
		body.tools = convertResponsesTools(transcriptTools.requestTools, {
			// 此路径缺省strict:null，和其他Responses入口的false默认不同。
			strict: null,
			// 传模型支持strict字段的本地标志。
			supportsStrictMode,
			// 传grammar能力，若支持且配置非法转换器可抛错。
			supportsOpenAIGrammarTools,
		});
	}

	// 明确给原生effort时按模型映射转换，不要求model.reasoning在本分支为true。
	if (options?.reasoningEffort !== undefined) {
		// 根据none或非none分两种查表方式。
		const effort =
			// 原生none对应公共off映射，而不是查表none键。
			options.reasoningEffort === "none"
				? // off键完全undefined才保留原生none。
					model.thinkingLevelMap?.off === undefined
					? // 没off映射用none字符串。
						"none"
					: // off明确null保留null，后面省略整个reasoning。
						model.thinkingLevelMap.off
				: // 其他档映射null/undefined都会??回退原请求档位，和off分支对null的处理不同。
					(model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);
		// 只排null；映射普通字符串不再核验本模型是否接受。
		if (effort !== null) {
			// 创建原生reasoning配置。
			body.reasoning = {
				// 发送映射后effort。
				effort,
				// summary未给或给null都回退auto；off/on字符串原样保留。
				summary: options.reasoningSummary ?? "auto",
			};
		}
		// 没显式effort时仅reasoning模型且off映射不为null才发送默认关闭档；完全缺表也符合undefined!==null。
	} else if (model.reasoning && model.thinkingLevelMap?.off !== null) {
		// off映射有字符串用它，缺省用none；这条不附summary，不承诺所有模型真正不思考。
		body.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
	}

	// 返回完整body，onPayload之后还可修改，WS续传还可能换input/previous_response_id。
	return body;
}

/**
 * 按本地模型id/tier计算费用倍率，返回number，无网络/修改。
 * 例flex为0.5，priority且精确gpt-5.5为2.5，其他priority为2，未列tier为1；这是当前代码估价规则，不是实时价格查询。
 */
// 取得本地服务档位费用倍率，只读取模型id与tier，不查询动态价格。
function getServiceTierCostMultiplier(
	// Pick只需id，其余模型字段不用提供。
	model: Pick<Model<"openai-codex-responses">, "id">,
	// 复用SDK服务档位联合，允许null/undefined走默认。
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	// 返回number倍率。
): number {
	// 精确按tier分支，不把fast等其他SDK值都当priority。
	switch (serviceTier) {
		// flex分支。
		case "flex":
			// 费用乘0.5，不减少实际token数量。
			return 0.5;
		// priority分支。
		case "priority":
			// 模型id精确gpt-5.5时2.5倍，其他包括不同后缀id都2倍。
			return model.id === "gpt-5.5" ? 2.5 : 2;
		// 未列档位/null/undefined走默认价。
		default:
			// 返回1，表示不调整目录估价。
			return 1;
	}
}

/**
 * 对Usage.cost原地应用服务档位倍率，输入用量、选定tier与模型id，返回void，不改token数量。
 * 先算倍率，1直接返回，其余乘四项费用后重算总价；例输入价1/输出价2遇priority普通模型变2/4，总6。由共享终态处理先计算目录价再调用。
 */
// 原地给已算过的分项费用乘tier倍率，不改token计数。
function applyServiceTierPricing(
	// 可变Usage对象含当前cost。
	usage: Usage,
	// 计价策略选出的服务档位。
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	// 只需模型id区分priority倍率。
	model: Pick<Model<"openai-codex-responses">, "id">,
	// 没显式返回类型，TS据实现推断void，不返回新Usage。
) {
	// 按本地规则算倍率。
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	// 倍率1就直接保留现有费用，不重新合计。
	if (multiplier === 1) return;

	// *=原地更新输入费用。
	usage.cost.input *= multiplier;
	// 原地更新输出费用。
	usage.cost.output *= multiplier;
	// 缓存读费用同乘倍率。
	usage.cost.cacheRead *= multiplier;
	// 缓存写费用同乘倍率。
	usage.cost.cacheWrite *= multiplier;
	// 按调整后的四项重算total，不再把旧total乘一次。
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

/**
 * 选择本地计价所用tier，输入响应tier与原请求配置tier，返回某候选或undefined，无修改。
 * 例响应default但请求priority时仍用priority；其他情况响应非空值优先。这里的请求值来自options，不保证等于payload钩子改后的wire字段。
 */
// 结合响应/请求档位决定本地估价档位，不修改两者、不请求账单。
function resolveCodexServiceTier(
	// 终态响应报告的tier，可能缺省或null。
	responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	// 本轮请求配置tier，不一定等于payload钩子改后的wire值。
	requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	// 返回SDK tier联合或undefined，不生成保证真实收费的凭证。
): ResponseCreateParamsStreaming["service_tier"] | undefined {
	// 响应default但原选项请求flex/priority时，特殊保留客户端请求档位。
	if (responseServiceTier === "default" && (requestServiceTier === "flex" || requestServiceTier === "priority")) {
		// 不用default覆盖这两种已请求的计价模式。
		return requestServiceTier;
	}
	// 其余响应非空值优先，再回请求值；fast等没有上面特殊逻辑。
	return responseServiceTier ?? requestServiceTier;
}

/**
 * 从可选基础字符串得到Codex响应地址，返回字符串，无网络/输入修改。
 * 空白基础值用官方默认，再去末尾斜线并按/codex/responses或/codex后缀补路径；例https://proxy/codex变https://proxy/codex/responses。
 * 只做字串拼接，取非空值后没有trim/URL解析，不承诺query/hash等自定义形式都能正确拼成路径。
 */
// 生成Codex SSE地址，字符串拼接无网络，不是完整URL有效性检查。
function resolveCodexUrl(baseUrl?: string): string {
	// 有非空白基础URL才选它，但取用原字符串未trim；否则官方默认。
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	// 只去实际字符串末尾斜线；无m的$不忽略末尾LF，也不解析query/hash。
	const normalized = raw.replace(/\/+$/, "");
	// 已精确以/codex/responses结尾就原样用，避免重复追加。
	if (normalized.endsWith("/codex/responses")) return normalized;
	// 以/codex结尾只补/responses。
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	// 其他一律补/codex/responses；已有query/hash等会按字串拼接，不保证是预期URL路径。
	return `${normalized}/codex/responses`;
}

/**
 * 将Codex响应地址解析成WebSocket URL，返回标准序列化字符串，无网络。
 * 先复用SSE地址拼接，再https→wss/http→ws；例https://proxy/codex变wss://proxy/codex/responses。坏URL抛错，其他协议不主动改写/白名单限制。
 */
// 先生成Codex地址再转WebSocket协议，返回URL标准序列化字符串。
function resolveCodexWebSocketUrl(baseUrl?: string): string {
	// URL解析可抛错，后续WS捕获路径决定错误处理。
	const url = new URL(resolveCodexUrl(baseUrl));
	// https改wss，保持其余URL组件。
	if (url.protocol === "https:") url.protocol = "wss:";
	// http改ws；两条独立if，上一行wss不会再命中这里。
	if (url.protocol === "http:") url.protocol = "ws:";
	// 其他协议不主动拒绝/转换，由下游构造器处理。
	return url.toString();
}

// ============================================================================
// Response Processing
// ============================================================================

/**
 * 处理已取得HTTP响应的SSE内容，输入响应/共享输出/Pi通道/模型/grammar映射/配置，返回Promise<void>。
 * SSE字节解析→Codex事件观察与规范→共享Responses块/终态处理，并用Codex特定tier策略调整估价；不再发请求，异常向外层失败流传播。
 * 例response.done改事件名为response.completed，response.status仍决定length/error；原始观察钩子只在映射层执行一次。
 */
// 连接SSE解析、Codex事件兼容和共享Responses处理，返回Promise<void>，不再发HTTP。
async function processStream(
	// 已取得HTTP响应，正文会被解析器锁定消费。
	response: Response,
	// 本轮共享可变输出对象。
	output: AssistantMessage,
	// Pi事件通道，不是原始HTTP流。
	stream: AssistantMessageEventStream,
	// 模型用于共享层身份转换和目录计价。
	model: Model<"openai-codex-responses">,
	// grammar映射只读类型，不是运行时冻结。
	grammarToolInputProperties: ReadonlyMap<string, string>,
	// 原选项提供信号、观察钩子与计价tier。
	options?: OpenAICodexResponsesOptions,
	// 用事件/原地output传数据，无单独返回消息。
): Promise<void> {
	// 等共享处理完成，包括缺终态/未完成工具检查。
	await processResponsesStream(
		// 先把SSE解析事件经Codex映射，原始观察钩子在映射层等待一次，不在共享层重复注册。
		mapCodexEvents(parseSSE(response, options?.signal), output, model, options?.onProviderStreamEvent),
		// 共享处理器会原地追加内容、写用量/终态。
		output,
		// 共享处理器只发块事件，完整done/error由外层stream发。
		stream,
		// 模型目录价格是估价起点。
		model,
		// 给共享层专用选项，而不是整个原生配置无差别展开。
		{
			// 取原请求配置tier，不从payload钩子后的body反向同步。
			serviceTier: options?.serviceTier,
			// custom工具原始输入的JSON参数属性映射。
			grammarToolInputProperties,
			// 响应default时可保留请求flex/priority的特殊策略。
			resolveServiceTier: resolveCodexServiceTier,
			/**
			 * 计价回调接Usage与共享层选出的tier，闭包补当前model，原地调整费用后返回void；例gpt-5.5 priority使用2.5倍。
			 */
			// 计价回调闭包补入本模型id，使gpt-5.5的priority倍率区别其他模型。
			applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
		},
	);
}

// 错误子类表示后端业务失败，普通WS传输回退通常排除它。
class CodexApiError extends Error {
	// readonly限制TS中构造后重赋字段，不是#私有字段或运行时冻结。
	readonly code?: string;
	// 可选原始事件载荷，便于错误码/诊断使用，不保证已脱敏。
	readonly payload?: Record<string, unknown>;

	/**
	 * 创建本地Codex业务错误，输入说明/可选码与载荷原因，保存字段，无网络/输入修改。
	 * 例code=previous_response_not_found供外层特殊恢复，其他业务码通常不走普通SSE回退；readonly仅编译期限制字段重赋。
	 */
	// 构造业务错误，可选code/payload/cause均不做完整运行时验证。
	constructor(message: string, options?: { code?: string; payload?: Record<string, unknown>; cause?: unknown }) {
		// 初始化Error.message。
		super(message);
		// 设本地错误类别名。
		this.name = "CodexApiError";
		// 保存可选后端错误码。
		this.code = options?.code;
		// 保存原事件对象引用，不深复制。
		this.payload = options?.payload;
		// 记录原始原因供调用者查看，不自动抛第二次cause。
		this.cause = options?.cause;
	}
}

// 协议错误子类使WS逻辑将JSON/格式失败与普通传输断开区别开。
class CodexProtocolError extends Error {
	// 保存未知原载荷，readonly只在编译期限制重赋。
	readonly payload?: unknown;

	/**
	 * 创建协议错误并保存可选原载荷/cause，无网络/自动脱敏。
	 * 例坏SSE JSON保存该帧文本，使外层能区别普通传输断开；这不是运行时冻结或完整错误schema验证。
	 */
	// 构造协议错误，输入说明和可选载荷/cause。
	constructor(message: string, options?: { payload?: unknown; cause?: unknown }) {
		// 初始化说明。
		super(message);
		// 错误类别名。
		this.name = "CodexProtocolError";
		// 原载荷可为字符串/任意值，不在这里截断或脱敏。
		this.payload = options?.payload;
		// 保留cause。
		this.cause = options?.cause;
	}
}

// 专用观察钩子错误，避免把本地钩子失败当成网络问题重发。
class ProviderStreamEventCallbackError extends Error {
	/**
	 * 包装原始流观察钩子的失败，输入任意cause，输出Error实例并保留cause，无网络。
	 * 例钩子抛"observer failed"后外层识别此类，停止WS恢复/SSE重放，而不是把本地逻辑错误误认网络故障。
	 */
	// 输入任意抛出原因，不限定Error。
	constructor(cause: unknown) {
		// formatThrownValue生成说明，原对象另保存在cause。
		super(formatThrownValue(cause));
		// 标记此错误来自观察钩子。
		this.name = "ProviderStreamEventCallbackError";
		// 保留原始抛出值。
		this.cause = cause;
	}
}

/**
 * 按本地三个错误类判断是否应排除普通WS传输回退，输入unknown，返回boolean，无修改。
 * 例CodexProtocolError为true，普通Error为false；是本地分类，不是识别任意SDK/网络错误的完整根因分析。
 */
// 只按三个本地错误类识别“非普通传输错误”，不检查每个Error的真实根因。
function isCodexNonTransportError(error: unknown): boolean {
	// 任一instanceof成立即true。
	return (
		// 后端业务错误。
		error instanceof CodexApiError ||
		// 协议解析错误。
		error instanceof CodexProtocolError ||
		// 原始事件观察回调错误。
		error instanceof ProviderStreamEventCallbackError
	);
}

/**
 * 识别本地CodexApiError中的连接上限精确错误码，返回布尔值，无重连动作。
 * 例普通Error即使附同code也不通过；调用者还要检查是否已开始/取消/重试过。
 */
// 必须是本地CodexApiError且码匹配，长得像相同字段的普通对象不会触发该特例。
function isWebSocketConnectionLimitReachedError(error: unknown): boolean {
	// 返回连接数限制判断，不自己重连。
	return error instanceof CodexApiError && error.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}

/**
 * 识别本地业务错误的previous_response_not_found码，返回布尔值，无修改。
 * 不在此检查请求真的带previous_response_id或是否已开始，恢复次数/取消规则在主入口决定。
 */
// 识别续传引用丢失的业务错误，无修改。
function isPreviousResponseNotFoundError(error: unknown): boolean {
	// 同样要求本地错误类和精确code。
	return error instanceof CodexApiError && error.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE;
}

/**
 * 从事件顶层及error对象中提可用字符串code/message，返回新简要对象，无网络/修改。
 * 各字段顶层string优先，非string再用嵌套string；例顶层空message也会先被选中，后续构造错误时再用真值回退。不是完整入站schema校验。
 */
// 从未知值字典的顶层/嵌套error里提字符串错误字段，返回新简要对象。
function extractCodexEventError(event: Record<string, unknown>): { code?: string; message?: string } {
	// error真值且typeof object才作为嵌套视图；未排除数组，也不完整验证结构。
	const nested = event.error && typeof event.error === "object" ? (event.error as Record<string, unknown>) : undefined;
	// 返回code/message，可缺省，不改原事件。
	return {
		// 顶层code只要是string就优先，空串也阻止使用嵌套code。
		code: typeof event.code === "string" ? event.code : typeof nested?.code === "string" ? nested.code : undefined,
		// message按相同优先顺序挑候选。
		message:
			// 顶层message是string就采用。
			typeof event.message === "string"
				? // 保留顶层原字串，包括空串。
					event.message
				: // 顶层非字符串才看嵌套message。
					typeof nested?.message === "string"
					? // 嵌套字符串原样返回。
						nested.message
					: // 都不符合则undefined，不把任意对象强转成错误信息。
						undefined,
	};
}

/**
 * 把宽松Codex源事件转成共享Responses事件，异步yield，输入源/共享输出/模型/原始观察钩子。
 * 每条先等待观察钩子并包装其失败，再识别type；error/failed抛业务异常，done/completed/incomplete拷贝规范status、记录boolean end_turn后以completed事件名产出并结束源。
 * 例不完整status仍可映射length，未知status归undefined由共享层兼容成stop；其他有type事件仅断言转发，没有完整schema校验。会改output.endTurn、触发源清理，不发网络请求。
 */
// async生成器把Codex额外事件映射成共享处理器可消费的SDK事件，无网络。
async function* mapCodexEvents(
	// 源是SSE或WS解析后的宽松字典，静态类型不代表数据完整校验过。
	events: AsyncIterable<Record<string, unknown>>,
	// 可写endTurn的统一输出对象。
	output: AssistantMessage,
	// 模型身份交观察钩子。
	model: Model<"openai-codex-responses">,
	// 函数参数位置必传，但字段类型可undefined，表示无观察钩子。
	onProviderStreamEvent: StreamOptions["onProviderStreamEvent"] | undefined,
	// 异步yield SDK事件类型，不在运行时创建SDK客户端。
): AsyncGenerator<ResponseStreamEvent> {
	// 顺序消费源迭代器产出的事件；WS源自身的异步数据解码另有顺序边界。
	for await (const event of events) {
		// 专门包观察钩子异常。
		try {
			// 原始事件先给钩子，await完才按其当前字段转换；钩子可原地改事件。
			await onProviderStreamEvent?.(event, model);
			// 捕获钩子抛出值，不在此忽略。
		} catch (error) {
			// Keep callback failures out of Codex's WebSocket retry and SSE fallback path.
			// 包成本地特殊错误，避免常规WS恢复/SSE回退；本轮仍失败。
			throw new ProviderStreamEventCallbackError(error);
		}
		// 只有实际string type才用于路由；这一行不会验证根event本身非null。
		const type = typeof event.type === "string" ? event.type : undefined;
		// 缺type/空串事件被忽略，观察钩子仍已看过它。
		if (!type) continue;

		// Codex顶层error立即转业务异常，不交共享层当普通SDK error处理。
		if (type === "error") {
			// 挑选code/message，只有字符串形状才正常取出。
			const { code, message } = extractCodexEventError(event);
			// 优先真值message，再code，再整个事件JSON；序列化有异常仍可向外抛。
			throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, {
				// 附错误码供特殊恢复识别。
				code,
				// 保存原事件引用为payload。
				payload: event,
			});
		}

		// response.failed单独归业务错误。
		if (type === "response.failed") {
			// 断言仅允许TS读可选response.error，不为嵌套字段增加真实验证。
			const response = (event as { response?: { error?: { code?: string; message?: string } } }).response;
			// 取可选错误码，未在此运行时核验为string。
			const code = response?.error?.code;
			// 取可选错误说明。
			const message = response?.error?.message;
			// 以已有说明/固定后备抛CodexApiError；不在此做成功用量结算。
			throw new CodexApiError(message || "Codex response failed", { code, payload: event });
		}

		// 三种终态事件都转换为response.completed事件名，真实status仍在response中保留/规范。
		if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
			// 只声明所需status/end_turn字段视图，其他实际响应字段会被展开保留。
			const response = (event as { response?: { status?: unknown; end_turn?: unknown } }).response;
			// end_turn必须真实boolean才采纳，false同样有效。
			if (typeof response?.end_turn === "boolean") {
				// 原地写output.endTurn，供Agent层理解是否继续，不在此直接停止Agent。
				output.endTurn = response.end_turn;
			}
			// 新建响应顶层副本或保留缺省response。
			const normalizedResponse = response
				? // status仅保留六种已知值；未知变undefined，后续共享层缺status兼容为stop，不能说未知状态一定失败。
					{ ...response, status: normalizeCodexStatus(response.status) }
				: // 没response就原样传缺省值，共享层具体访问仍可报错。
					response;
			// 事件顶层也浅复制并改type；as不校验整个SDK事件形状。
			yield { ...event, type: "response.completed", response: normalizedResponse } as ResponseStreamEvent;
			// 产出首个终态后立即结束映射器，借for await清理底层源，不继续等网络EOF。
			return;
		}

		// 其他有type的事件原样yield，双重断言不证明它真在SDK联合里；共享层可能忽略未知事件。
		yield event as unknown as ResponseStreamEvent;
	}
}

/**
 * 将未知状态限制为本地六项联合，返回已知字符串或undefined，无修改。
 * 例completed保留、NEW_STATUS归undefined；并非未知状态一律报错，共享层缺省状态有兼容stop行为。
 */
// 对unknown状态做白名单规范，返回已知联合或undefined，无修改。
function normalizeCodexStatus(status: unknown): CodexResponseStatus | undefined {
	// 不是string直接undefined。
	if (typeof status !== "string") return undefined;
	// Set真实检查成员，as只协调TS；未知字符串同样undefined。
	return CODEX_RESPONSE_STATUSES.has(status as CodexResponseStatus) ? (status as CodexResponseStatus) : undefined;
}

// ============================================================================
// SSE Parsing
// ============================================================================

/**
 * 将HTTP正文按LF空行分帧并解析data JSON，异步yield宽松字典，输入Response与可选用户信号。
 * 增量UTF-8解码，EOF非空尾帧补两个LF，过滤非data行；例没有最后空行的终态仍可处理。只认LF LF边界，不完整支持CRLF/CR空行，[DONE]被忽略而不是终止标记。
 * 会锁/读/取消body，finally移监听/解锁；JSON语法错误转CodexProtocolError，合法JSON根形状不校验，无帧大小上限，真实终态由上层判断。
 */
// 自有SSE字节解析生成器，yield宽松JSON，不调用OpenAI SDK流解析。
async function* parseSSE(response: Response, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
	// 直接调用无body时生成器空结束；公开SSE路径更早会报缺body。
	if (!response.body) return;

	// getReader锁住正文流，finally负责取消/解锁。
	const reader = response.body.getReader();
	// 默认UTF-8解码器，逐字节块能续接跨块字符。
	const decoder = new TextDecoder();
	// 未凑齐事件的文字缓存，无单事件/总缓存硬上限。
	let buffer = "";
	/**
	 * 用户取消时调用reader.cancel帮助唤醒读取，返回void，取消Promise的失败被吞。
	 * 例正文一直不来时取消可让read结束，循环随后抛固定取消Error；不代表撤销远端计算。
	 */
	// 用户取消监听回调取消reader，帮助唤醒等待中的read。
	const onAbort = () => {
		/**
		 * catch回调忽略reader.cancel自身的拒绝，返回undefined，不让清理错误覆盖原用户取消/解析失败。
		 */
		// void忽略cancel Promise，catch吞取消清理自身的拒绝；循环还会独立检查signal。
		void reader.cancel().catch(() => {});
	};
	// 有信号才注册一次回调，已取消信号由循环前检查处理。
	signal?.addEventListener("abort", onAbort, { once: true });

	// 正常EOF、解析错误、映射器提前终态return都会走finally清理。
	try {
		// 持续读直到done，不因[DONE]文字本身直接退出。
		while (true) {
			// 读取前检查用户取消。
			if (signal?.aborted) {
				// 抛固定Error，而非原样抛signal.reason。
				throw new Error("Request was aborted");
			}
			// 读取下一字节块，done时value可缺省。
			const { done, value } = await reader.read();
			// 读取后再检查，防cancel导致done而误当正常EOF。
			if (signal?.aborted) {
				// 同样采用固定取消说明。
				throw new Error("Request was aborted");
			}
			// 普通块流式UTF-8解码，EOF decode()刷残余字节；坏编码默认替换不fatal。
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			// Treat EOF as terminating the residual SSE frame.
			// EOF有非空白残段就补两个LF让它进入同一帧处理，不要求服务端最后有空行。
			if (done && buffer.trim()) buffer += "\n\n";

			// 仅找LF LF分帧，不把CRLF CRLF/单CR空行整体规范化。
			let idx = buffer.indexOf("\n\n");
			// 一个网络块可能有多个事件，所以继续解析当前buffer。
			while (idx !== -1) {
				// 边界前作为本帧，可能包含多个data行。
				const chunk = buffer.slice(0, idx);
				// 去掉帧及恰两个LF分隔，余下保留等后续块。
				buffer = buffer.slice(idx + 2);

				// 从本帧收data行。
				const dataLines = chunk
					// 只按LF切行，行末CR可能被后面的trim去掉，但不因此支持CRLF空行分帧。
					.split("\n")
					/**
					 * filter回调只保留列0开头data:行，无修改；例event:与冒号注释都过滤。
					 */
					// 只认列0起精确data:，其他event/id/retry/注释行忽略。
					.filter((l) => l.startsWith("data:"))
					/**
					 * map回调删data:前缀并trim该行载荷两端，返回字符串，无修改；例data:  {...}
					 * 会去掉末CR，但不解决帧边界CRLF差异。
					 */
					// 每条data去前缀后trim两端，而不是只删一个开头空格。
					.map((l) => l.slice(5).trim());
				// 至少有一条data行才继续，空注释帧跳过。
				if (dataLines.length > 0) {
					// 多条data用LF连接后再trim整段。
					const data = dataLines.join("\n").trim();
					// 空载荷或精确[DONE]只被忽略，不立即return；终态依靠上层映射器。
					if (data && data !== "[DONE]") {
						// 尝试JSON解析，有限catch只负责转协议Error。
						try {
							// JSON.parse后直接断言字典，无根/嵌套shape校验；null等合法JSON可在后续映射访问时报错。
							yield JSON.parse(data) as Record<string, unknown>;
							// 解析失败转换成带cause的协议错误。
						} catch (cause) {
							// 说明包含JSON解析异常文字，原载荷另放payload，不在这里自动裁剪/脱敏。
							throw new CodexProtocolError(`Invalid Codex SSE JSON: ${formatThrownValue(cause)}`, {
								// 保留原异常。
								cause,
								// 保存这一帧拼出的data文字。
								payload: data,
							});
						}
					}
				}
				// 已处理一帧后，在剩余buffer继续查LF LF。
				idx = buffer.indexOf("\n\n");
			}

			// EOF时退出，之前残帧已经补终止LF处理。
			if (done) break;
		}
		// 移除监听并取消/释放reader，即使上层在终态提前关闭映射器。
	} finally {
		// 与注册时同一onAbort回调，未触发也会删除。
		signal?.removeEventListener("abort", onAbort);
		// 取消可能拒绝，独立try避免覆盖原解析错误。
		try {
			// 等reader.cancel结算，不表示后端计算一定停止/不计费。
			await reader.cancel();
			// 忽略取消清理失败。
		} catch {}
		// 不论cancel是否成功仍尝试releaseLock。
		try {
			// 解除读锁，后续资源行为仍由流实现决定。
			reader.releaseLock();
			// 忽略解锁清理异常。
		} catch {}
	}
}

// ============================================================================
// WebSocket Parsing
// ============================================================================

// WS专用beta标识字符串，和SSE的responses=experimental不同。
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
// 缓存连接释放为空闲后安排5分钟关闭timer，不是响应上下文TTL保证。
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
// 连接年龄55分钟只在后续获取时判断，不是定点强杀运行中请求。
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;

// 本适配器使用的四种事件名称字面量联合。
type WebSocketEventType = "open" | "message" | "error" | "close";
// 回调输入unknown来自运行时事件边界，返回void。
type WebSocketListener = (event: unknown) => void;

// 最小socket接口，类型本身不保证真实实现的握手头/事件顺序。
interface WebSocketLike {
	// 请求关闭可传码/原因，返回void不代表已经完成关闭握手。
	close(code?: number, reason?: string): void;
	// 本文件只发送JSON字符串帧。
	send(data: string): void;
	// 注册固定事件类型的监听。
	addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
	// 删除同一回调引用的监听。
	removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

// 本地续传基线，不是服务端存储响应正文的通用数据库。
interface CachedWebSocketContinuationState {
	// 保存完整上轮body引用（非深快照），下一轮做JSON字串比较。
	lastRequestBody: RequestBody;
	// 连接作用域内上一响应id，用于previous_response_id。
	lastResponseId: string;
	// 上次统一assistant重新转成的Responses输入项，不一定等于所有服务端原始output项。
	lastResponseItems: ResponseInput;
}

// 一条可复用连接及其本地状态。
interface CachedWebSocketConnection {
	// socket引用。
	socket: WebSocketLike;
	// busy只防已缓存连接同时复用；忙时另建一次性连接，不是在此排队等空闲。
	busy: boolean;
	// 本地创建毫秒时间供55分钟年龄判断。
	createdAt: number;
	// ReturnType跟随运行时setTimeout句柄类型，释放/获取时清理旧timer。
	idleTimer?: ReturnType<typeof setTimeout>;
	// 可选续传状态，仅在特定模式和响应id条件下建立。
	continuation?: CachedWebSocketContinuationState;
}

// 进程内调试计数接口，不是远端实际执行/计费的权威统计。
export interface OpenAICodexWebSocketDebugStats {
	// 进入WS处理的尝试计数，发送失败也可能已增加。
	requests: number;
	// 未复用缓存时计新增连接尝试，包含一次性忙连接。
	connectionsCreated: number;
	// 复用同session/account缓存连接的计数。
	connectionsReused: number;
	// 开了useCachedContext标记的尝试数，不代表实际只发送delta。
	cachedContextRequests: number;
	// 发送对象store精确true的尝试数，默认false但钩子可改。
	storeTrueRequests: number;
	// 请求没有真值previous_response_id时计full，不验证input是否真的完整。
	fullContextRequests: number;
	// 请求有真值previous_response_id时计delta，不验证该id真实存在。
	deltaRequests: number;
	// 最近一次实际选中请求体的input条目数，不是token量。
	lastInputItems: number;
	// 最近续传请求的input条目数，后续全量请求会设undefined。
	lastDeltaInputItems?: number;
	// 最近一次选中请求体的previous_response_id，非续传会清undefined。
	lastPreviousResponseId?: string;
	// 走普通WS失败记录路径的次数，不包括所有业务失败/特殊成功恢复。
	websocketFailures: number;
	// 记SSE回退的次数，已处回退状态时每轮也可能增加。
	sseFallbacks: number;
	// 当前会话回退标记的观察值。
	websocketFallbackActive?: boolean;
	// 最后WS失败的格式化文字，不自动带完整原始载荷。
	lastWebSocketError?: string;
}

// 原会话id→解码账号id→缓存连接，没再按URL/token/headers/模型分键，都是模块级强引用Map。
const websocketSessionCache = new Map<string, Map<string, CachedWebSocketConnection>>();
// 会话调试统计单独存Map，关连接不自动清统计。
const websocketDebugStats = new Map<string, OpenAICodexWebSocketDebugStats>();
// 会话级WS失败回退Set，不按账号分，也没有这里的自动TTL恢复。
const websocketSseFallbackSessions = new Set<string>();

/**
 * 读取或创建内部会话统计，输入原始sessionId，返回Map内可变对象，会按需写模块Map。
 * 例第一次创建requests=0，后续同键返回同一对象供累加；对外读取接口另做浅副本，不查询远端。
 */
// 取或新建会话统计对象，返回的是内部可变引用，不是对外快照。
function getOrCreateWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats {
	// 先查模块Map，let允许缺失时新建。
	let stats = websocketDebugStats.get(sessionId);
	// 没统计才初始化，不每次重置计数。
	if (!stats) {
		// 新建全零计数，下面可选字段先不出现。
		stats = {
			// WS尝试次数初始0。
			requests: 0,
			// 新连接次数初始0。
			connectionsCreated: 0,
			// 复用次数初始0。
			connectionsReused: 0,
			// 启用续传模式的请求次数初始0。
			cachedContextRequests: 0,
			// store:true请求数初始0。
			storeTrueRequests: 0,
			// 未带previous id的请求数初始0。
			fullContextRequests: 0,
			// 带previous id的请求数初始0。
			deltaRequests: 0,
			// 最近input数量先0。
			lastInputItems: 0,
			// 普通WS失败记录数先0。
			websocketFailures: 0,
			// SSE回退计数先0。
			sseFallbacks: 0,
		};
		// 把可变对象放模块Map，后续调用共用。
		websocketDebugStats.set(sessionId, stats);
	}
	// 返回内部同一stats引用供加计数。
	return stats;
}

/**
 * 读取一个会话的WS统计快照，返回浅副本或undefined，不创建计数、不发请求。
 * 例改返回值.requests不改变模块内记录；统计只覆盖本代码记账路径，不能当真实后端请求/收费证明。
 */
// 对外读取指定会话统计，返回浅副本或undefined，无网络/缓存创建。
export function getOpenAICodexWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats | undefined {
	// 只查已有统计，不因为读debug而创建会话条目。
	const stats = websocketDebugStats.get(sessionId);
	// 展开为新对象，当前字段都是标量；修改副本不改内部计数。
	return stats ? { ...stats } : undefined;
}

/**
 * 清指定真值会话或全部会话的debug统计和SSE回退标记，返回void，修改模块Map/Set。
 * 例reset("s1")让后续s1可再尝试WS，但不关闭既有socket、不清previous_response续传；空串与不传都清全部。
 */
// 清调试统计与回退标记，不关闭socket或清续传缓存。
export function resetOpenAICodexWebSocketDebugStats(sessionId?: string): void {
	// 真值sessionId只清一组；undefined/空串都走清全部。
	if (sessionId) {
		// 删除该会话统计。
		websocketDebugStats.delete(sessionId);
		// 同时取消该会话“以后跳过WS”的记忆，允许后续再尝试。
		websocketSseFallbackSessions.delete(sessionId);
		// 单会话清理后立即返回。
		return;
	}
	// 清全部统计Map。
	websocketDebugStats.clear();
	// 清全部SSE回退标记Set，不触及连接Map。
	websocketSseFallbackSessions.clear();
}

/**
 * 请求关闭连接Map登记的指定真值会话或所有缓存socket，清timer并删除Map引用，返回void，不等待关闭握手。
 * 例会话dispose通过注册清理调用它；只处理缓存Map中的连接，不保证覆盖所有未登记的一次性/忙时临时连接，也不清统计和SSE回退Set。
 */
// 请求关闭连接Map中已登记socket并删缓存，返回void，不等关闭握手。
export function closeOpenAICodexWebSocketSessions(sessionId?: string): void {
	/**
	 * 关闭一条登记缓存连接，输入entry，返回void，清空闲timer并发正常关闭请求。
	 * 例清理会话时避免旧空闲timer继续回调；close同步抛错被辅助函数吞，不等待远端确认。
	 */
	// 每条缓存连接的本地关闭回调。
	const closeEntry = (entry: CachedWebSocketConnection) => {
		// 有空闲timer就先clearTimeout，避免晚些重复到期动作。
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		// 吞同步close异常，使用正常关闭码/调试关闭原因。
		closeWebSocketSilently(entry.socket, 1000, "debug_close");
	};
	// 真值sessionId只处理该会话，空串/未传则清所有。
	if (sessionId) {
		// 遍历该会话账号表；没有表就空迭代，不报错。
		for (const entry of websocketSessionCache.get(sessionId)?.values() ?? []) closeEntry(entry);
		// 整个会话连接表从缓存删掉。
		websocketSessionCache.delete(sessionId);
		// 不再遍历其他会话。
		return;
	}
	// 清全部时先逐会话取账号Map。
	for (const accountEntries of websocketSessionCache.values()) {
		// 再逐连接清timer并请求关闭。
		for (const entry of accountEntries.values()) closeEntry(entry);
	}
	// 清所有连接Map引用，不在这里清debug/fallback Set，也不覆盖未登记的一次性连接。
	websocketSessionCache.clear();
}

// 模块加载即注册关闭缓存连接的回调；返回的注销函数这里未保存，会话dispose通过资源清理注册表调用关闭回调。
registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);

/**
 * 检查真值会话键是否在WS失败回退Set中，返回boolean，无修改；例无session时总false，不共享匿名失败记忆。
 */
// 查某个会话是否记住WS失败，无修改。
function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
	// 无真值id时返回false，不创建全局“无会话”回退状态。
	return sessionId ? websocketSseFallbackSessions.has(sessionId) : false;
}

/**
 * 记录一次会话SSE回退，输入可缺省原session键，返回void，按需创建统计并加次数/同步Set状态。
 * 例已经记住WS失败的下轮直接SSE仍加一次；该函数本身不把会话加入失败Set、不发网络。
 */
// 记录一次走SSE回退的统计，无返回数据，不发请求/不自己设置回退Set。
function recordWebSocketSseFallback(sessionId: string | undefined): void {
	// 无会话键直接无操作。
	if (!sessionId) return;
	// 有键取或新建统计记录。
	const stats = getOrCreateWebSocketDebugStats(sessionId);
	// 加SSE回退次数；已经处于fallback的后续轮也会走这个动作。
	stats.sseFallbacks++;
	// 从Set读取当前状态同步到统计，非此行直接设true。
	stats.websocketFallbackActive = isWebSocketSseFallbackActive(sessionId);
}

/**
 * 记录普通WS失败并激活该会话后续SSE回退，输入session与任意错误，返回void，改模块Set/统计。
 * 例s1连接失败后别的账号同s1也会读到回退状态；无session不存记录，没有自动TTL，到reset才清。
 */
// 记录普通WS失败，输入原会话键与任意异常，无网络；会改模块Set/统计。
function recordWebSocketFailure(sessionId: string | undefined, error: unknown): void {
	// 缺键不保存失败记忆。
	if (!sessionId) return;
	// 将会话放回退Set，后续非sse请求也可跳过WS，没有这里的自动过期恢复。
	websocketSseFallbackSessions.add(sessionId);

	// 取同一会话统计。
	const stats = getOrCreateWebSocketDebugStats(sessionId);
	// 增加普通WS失败次数。
	stats.websocketFailures++;
	// 把异常转文字保存，并不保存/验证完整远端状态。
	stats.lastWebSocketError = formatThrownValue(error);
	// 记录fallback已激活。
	stats.websocketFallbackActive = true;
}

// new构造签名类型，表示可用new创建WebSocketLike，不是函数实现。
type WebSocketConstructor = new (
	// 目标地址字符串。
	url: string,
	// 第二参数兼容协议列表或headers选项；实际运行时支持能力由构造器决定。
	protocols?: string | string[] | { headers?: Record<string, string> },
	// 返回最小socket接口。
) => WebSocketLike;

// 仅缓存某些运行时构造器包装，不是已经连好的socket；null表示尚无缓存。
let _cachedWebsocket: WebSocketConstructor | null = null;
/**
 * 取能构造WebSocketLike的运行值，输入可选请求env，返回构造器或null的Promise，不连接网络。
 * Bun创建补代理选项的子类，无env时可缓存该类；其他环境只检查globalThis.WebSocket是不是function再断言，未做完整接口/headers支持验证。
 * 例请求env指定代理时新建闭包类避免误用另一请求配置；代理解析错误在实际构造阶段仍可抛，后续主入口决定开始前回退。
 */
// 异步取可用WS构造器，可能返回null，不在此连接网络。
async function getWebSocketConstructor(env?: ProviderEnv): Promise<WebSocketConstructor | null> {
	// 没请求env且已有缓存才复用，env即使是空对象也会跳过缓存。
	if (!env && _cachedWebsocket) return _cachedWebsocket;

	// bun doesn't respect http proxy envs, ref: https://github.com/oven-sh/bun/issues/15489
	// TODO: remove this when bun supports proxy envs in websocket.
	// 只在识别Bun时使用下面补代理的子类，普通Node不走该分支。
	if (typeof process !== "undefined" && process.versions?.bun) {
		// 类表达式继承运行时全局WebSocket，构造时才决定代理，不是继承本地接口。
		const WebSocketWithProxy = class extends WebSocket {
			/**
			 * 构造Bun WS代理子类，输入URL/子协议或选项，补当前目标代理后调用super，产生真实连接副作用。
			 * 例wss目标按https代理规则选择HTTP/HTTPS代理；传入选项先浅复制，存在代理时覆盖proxy，不自行验证服务端可用性。
			 */
			// 参数允许URL或字符串与几种第二参数形式，后面转成Bun选项对象。
			constructor(url: string | URL, options?: string | string[] | Record<string, unknown>) {
				// 先准备普通选项字典，let可按输入分支替换。
				let _opts: Record<string, unknown> = {};
				// 合法联合中的字符串/数组视为子协议配置。
				if (Array.isArray(options) || typeof options === "string") {
					// 包成{protocols}而非把数组直接展开成数字键。
					_opts = { protocols: options };
					// 其他可选对象按普通选项处理。
				} else {
					// 浅复制调用者头等字段，undefined展开为空。
					_opts = { ...options };
				}

				// 按这次真实目标与捕获env求代理，可能因不支持的协议配置而抛错。
				const proxyUrl = resolveHttpProxyUrlForTarget(
					// 只把开头wss/ws改成https/http以复用代理规则，不改中间相同文字。
					url
						.toString()
						.replace(/^wss:/, "https:")
						.replace(/^ws:/, "http:"),
					// 传本次环境覆盖；helper仍可回退进程变量。
					env,
				);
				// super真正建Bun连接，有代理才后展开proxy字段；原有as any仅绕类型差异，不验证运行时接受。
				super(url, { ..._opts, ...(proxyUrl ? { proxy: proxyUrl.toString() } : {}) } as any);
			}
		};
		// 只有没传env时保存包装类，防复用捕获了另一请求配置的闭包。
		if (!env) {
			// 缓存类本身，后续new才建立连接。
			_cachedWebsocket = WebSocketWithProxy;
		}
		// 返回这个Bun子类。
		return WebSocketWithProxy;
	}

	// 其他运行时从globalThis读取unknown构造器，断言只允许TS看可选字段。
	const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
	// 不是function就表示本运行时没有可用WS，不尝试动态import其他实现。
	if (typeof ctor !== "function") return null;
	// 双重断言只是类型桥接，不验证constructible或第二参数真的支持headers。
	return ctor as unknown as WebSocketConstructor;
}

// 保存WS关闭码/原因的Error子类，不代表业务层成功或失败已完全判断。
class WebSocketCloseError extends Error {
	// 编译期readonly可选数字code，不是运行时冻结。
	readonly code?: number;
	// 远端关闭原因文字，可能缺省。
	readonly reason?: string;
	// wasClean只反映关闭事件标记，不等于生成响应完整。
	readonly wasClean?: boolean;

	/**
	 * 新建保存WS关闭元数据的Error，输入message/可选码原因与wasClean，无网络。
	 * 例码1009无原因时上层提取器可补message too big；wasClean只保留事件标记，不证明收到响应终态。
	 */
	// 构造关闭错误，输入说明和已筛过的可选关闭信息。
	constructor(message: string, options?: { code?: number; reason?: string; wasClean?: boolean }) {
		// 初始化Error.message。
		super(message);
		// 设本地类别名。
		this.name = "WebSocketCloseError";
		// 保存码。
		this.code = options?.code;
		// 保存非空原因（调用者筛选）。
		this.reason = options?.reason;
		// 保存是否干净关闭（若有真实boolean）。
		this.wasClean = options?.wasClean;
	}
}

/**
 * 读取最小socket接口之外的可选readyState，返回数字或undefined，无修改/网络。
 * 只检查typeof number，不验证标准状态范围；无字段让上层采用乐观复用策略，不做探活。
 */
// 运行时可选readyState在最小接口外，用unknown视图读取。
function getWebSocketReadyState(socket: WebSocketLike): number | undefined {
	// 断言不验证socket，但该扩展字段值下面真实判number。
	const readyState = (socket as { readyState?: unknown }).readyState;
	// 数字包括NaN也能返回；非数字统一undefined，不强制标准四个状态范围。
	return typeof readyState === "number" ? readyState : undefined;
}

/**
 * 判断socket本地状态是否允许复用，返回布尔值，无网络。
 * 例readyState=1通过、3不通过、缺字段也通过；不保证远端尚未断开或认证/端点与新请求完全一致。
 */
// 按readyState判断能否复用，返回boolean，不实际发探活请求。
function isWebSocketReusable(socket: WebSocketLike): boolean {
	// 取可选数字状态。
	const readyState = getWebSocketReadyState(socket);
	// If readyState is unavailable, assume the runtime keeps it open/reusable.
	// 没该能力也乐观当可复用，或恰1表示open；不能当远端连接必然健康的保证。
	return readyState === undefined || readyState === 1;
}

/**
 * 按Date.now与entry.createdAt计算是否达到55分钟，返回boolean，无关闭/修改。
 * 例56分钟前创建为true；只在获取缓存时用，不是运行中强制中断timer，系统时钟变化会影响结果。
 */
// 只计算连接年龄是否达到55分钟，不主动关闭。
function isWebSocketSessionExpired(entry: CachedWebSocketConnection): boolean {
	// 本地Date.now减创建时刻；时钟回拨/跳变影响这个判断，不用单调时钟。
	return Date.now() - entry.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
}

/**
 * 尝试socket.close并吞同步异常，输入可选关闭码/原因，返回void，无关闭完成Promise。
 * 例清理旧缓存失败也继续删本地引用；不能把“silently”理解为一定已关闭远端或可回滚生成。
 */
// 尝试同步close并吞其异常，返回void，不等关闭事件。
function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
	// 仅包调用close自身。
	try {
		// 传正常关闭默认码1000与原因done，调用者可覆盖。
		socket.close(code, reason);
		// 忽略同步关闭失败，之后仍可能删本地缓存引用。
	} catch {}
}

/**
 * 为缓存entry重新安排5分钟空闲关闭，输入会话/账号键及entry，返回void，会更新timer/删除到期缓存。
 * 先清旧timer，到期busy则跳过；不忙时close，只有Map槽仍等于此entry才删，避免误删替换连接。
 * 例一轮成功release keep:true后开始算空闲时间；这不是服务端previous_response_id的有效期保证。
 */
// 给一条缓存连接安排5分钟空闲关闭，输入会话/账号/条目，修改timer/缓存状态。
function scheduleSessionWebSocketExpiry(sessionId: string, accountId: string, entry: CachedWebSocketConnection): void {
	// 先看此条目是否已有timer。
	if (entry.idleTimer) {
		// 清旧timer，避免同条目重复排队关闭。
		clearTimeout(entry.idleTimer);
	}
	/**
	 * 空闲到期回调检查busy后请求关闭并按对象身份删Map，返回void。
	 * 若到期已busy则不主动关闭也不在此重排timer，后续release可重新安排；新entry占同键时不被旧回调删掉。
	 */
	// 保存新timer句柄，回调捕获同一entry/session/account。
	entry.idleTimer = setTimeout(() => {
		// 到期若busy就直接返回，不关闭运行中连接，也不在此回调自动重排timer。
		if (entry.busy) return;
		// 否则请求关闭这个条目的socket，关闭握手不等待。
		closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
		// 取当前会话表，可能已被其他清理替换/移除。
		const accountEntries = websocketSessionCache.get(sessionId);
		// 仅当前账号槽仍是同一entry才删除，避免删掉后来替换的新连接。
		if (accountEntries?.get(accountId) === entry) accountEntries.delete(accountId);
		// 当前账号表空了才删除外层会话键。
		if (accountEntries?.size === 0) websocketSessionCache.delete(sessionId);
		// 等待5分钟；记录的是空闲释放后的timer，不是lastRequestBody的有效期承诺。
	}, SESSION_WEBSOCKET_CACHE_TTL_MS);
}

/**
 * 新建WS并等待open，输入URL/标准头/用户信号/建连时限/env，返回socket Promise，不发送模型body。
 * 先取构造器和普通头，new后注册open/error/close/abort及timer，第一次结算清建连监听；例超时或取消会主动close再reject。
 * 仅普通error/close回调失败时不总主动close；Header字典删大写OpenAI-Beta对标准小写键通常无效，不能声称握手一定去掉beta。真实构造器可因接口/选项差异同步失败。
 */
// 新建WS并等待open，返回socket Promise或失败，不在这里解析模型消息。
async function connectWebSocket(
	// 已解析成WS协议的URL字符串。
	url: string,
	// 构建好的标准Headers。
	headers: Headers,
	// 用户取消可省略，建连时注册监听并补查已取消。
	signal?: AbortSignal,
	// 默认参数只在undefined时取15000，显式0让下面不安装timer。
	connectTimeoutMs = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
	// 供Bun代理构造器捕获的请求环境。
	env?: ProviderEnv,
	// open后返回最小socket，之后的消息读取由其他函数负责。
): Promise<WebSocketLike> {
	// 等构造器能力解析，不是等待网络连接。
	const WebSocketCtor = await getWebSocketConstructor(env);
	// 无构造器能力就立即拒绝。
	if (!WebSocketCtor) {
		// 这类普通Error可在开始前触发SSE回退。
		throw new Error("WebSocket transport is not available in this runtime");
	}

	// 标准Headers.entries生成名称通常小写的普通对象。
	const wsHeaders = headersToRecord(headers);
	// 按精确大写键试删；headersToRecord给小写openai-beta时这行通常不删掉它，不能声称真正移除beta。
	delete wsHeaders["OpenAI-Beta"];

	/**
	 * Promise执行器立即创建socket并接好建连监听，第一次open解析socket、失败拒绝，返回值由resolve/reject决定。
	 * 例构造器同步抛错时直接reject而不注册后续监听，后续消息解析是另一步。
	 */
	// Promise承载open/失败的第一次结算；执行器立即尝试new socket。
	return new Promise<WebSocketLike>((resolve, reject) => {
		// 标记避免多个事件重复结算和清理。
		let settled = false;
		// 建连timer句柄可缺省，ReturnType跨Node/Bun类型。
		let timeout: ReturnType<typeof setTimeout> | undefined;
		// socket延后赋值，构造器成功后才用下面回调接线。
		let socket: WebSocketLike;

		// 只捕获构造器同步抛错。
		try {
			// 真正new WebSocket，第二参数带握手headers；不同运行时是否接受由真实构造器决定。
			socket = new WebSocketCtor(url, { headers: wsHeaders });
			// 同步构造失败直接reject，不走下方尚未注册的事件回调。
		} catch (error) {
			// 非Error用String包装，转换本身仍可能抛。
			reject(error instanceof Error ? error : new Error(String(error)));
			// 不再注册监听/安装timer。
			return;
		}

		/**
		 * 清建连timer与四个阶段监听，返回void，不主动关成功socket。
		 * 例open后不再受旧建连timer影响；与随后parseWebSocket的消息/空闲监听是不同资源。
		 */
		// 清本阶段timer和open/error/close/abort监听，不关闭成功socket。
		const cleanup = () => {
			// 有timer才清理。
			if (timeout) {
				// 取消建连超时定时器。
				clearTimeout(timeout);
				// 清本地句柄，重复cleanup不再清同一个timer。
				timeout = undefined;
			}
			// 移除建连成功监听，不影响后续消息读取自己的监听。
			socket.removeEventListener("open", onOpen);
			// 移除建连错误监听。
			socket.removeEventListener("error", onError);
			// 移除建连关闭监听。
			socket.removeEventListener("close", onClose);
			// 移除用户取消监听，后续parseWebSocket会装自己的。
			signal?.removeEventListener("abort", onAbort);
		};
		/**
		 * 第一次失败时结算建连Promise，输入Error与可选closeReason，返回void，清监听并按需请求close。
		 * 例取消给aborted因此关连接，普通error不给原因则只清理/reject；重复失败事件由settled忽略。
		 */
		// 失败结算函数可选择发close；没有closeReason时只清监听/reject，不总是主动关闭socket。
		const fail = (error: Error, closeReason?: string) => {
			// 已结算则忽略后到事件。
			if (settled) return;
			// 在清理前标记，防同步重入重复拒绝。
			settled = true;
			// 清当前建连阶段资源。
			cleanup();
			// 给了真值closeReason才主动close。
			if (closeReason) {
				// 用1000关闭码和这次失败原因，不等待完成。
				closeWebSocketSilently(socket, 1000, closeReason);
			}
			// 用原Error拒绝建连Promise。
			reject(error);
		};
		/**
		 * open事件的首次成功回调，返回void，清建连timer/监听并resolve当前socket。
		 * 不发Pi start，也不保证后续响应成功；重复open或已经失败后再open直接忽略。
		 */
		// open事件回调只完成建连，不发Pi start或模型请求。
		const onOpen: WebSocketListener = () => {
			// 已经失败/完成则不重复处理。
			if (settled) return;
			// 先记结算。
			settled = true;
			// 去建连timer/监听。
			cleanup();
			// 成功交socket给调用者，仍未收模型消息。
			resolve(socket);
		};
		/**
		 * 错误事件回调把未知事件提成Error后交fail，无额外返回值；不提供closeReason，所以不在这里保证主动关闭。
		 */
		// error回调从未知运行时事件提说明。
		const onError: WebSocketListener = (event) => {
			// fail没有closeReason，所以本分支不保证主动socket.close。
			fail(extractWebSocketError(event));
		};
		/**
		 * 关闭事件回调提取码/原因并拒绝未完成建连，无额外返回值；例open之前close不能当成功连接。
		 */
		// close回调把关闭元数据转Error。
		const onClose: WebSocketListener = (event) => {
			// 同样走第一次失败结算。
			fail(extractWebSocketCloseError(event));
		};
		/**
		 * 用户取消的建连回调，以固定Error拒绝并请求aborted关闭，返回void；不用原signal.reason作为错误说明。
		 */
		// 用户取消的建连处理。
		const onAbort = () => {
			// 固定取消Error并主动请求aborted关闭。
			fail(new Error("Request was aborted"), "aborted");
		};

		// 注册open，不在构造前伪装已连接。
		socket.addEventListener("open", onOpen);
		// 注册error。
		socket.addEventListener("error", onError);
		// 注册close。
		socket.addEventListener("close", onClose);
		// 注册用户取消，未用once但cleanup会删除本阶段回调。
		signal?.addEventListener("abort", onAbort);

		// 只有时限>0才安装建连timer。
		if (connectTimeoutMs > 0) {
			/**
			 * 建连timer到期时经fail清资源/请求关闭并拒绝Promise，返回void；仅约束open等待，不是响应总时长。
			 */
			// 到时通过统一fail路径拒绝与清理。
			timeout = setTimeout(() => {
				// 建连超时也主动请求关闭，原因connect_timeout。
				fail(new Error(`WebSocket connect timeout after ${connectTimeoutMs}ms`), "connect_timeout");
				// 等配置毫秒，不是模型生成总时限。
			}, connectTimeoutMs);
		}
		// 接线后再查signal，覆盖调用前已取消的情形。
		if (signal?.aborted) {
			// 复用同一取消处理，不直接重复reject逻辑。
			onAbort();
		}
	});
}

/**
 * 为本次请求获取socket租用对象，输入URL/头/原会话与账号/信号时限env，返回socket、可选entry、复用标记与release函数。
 * 无session一次性；有session按账号找缓存，闲且未超龄/可用则标忙复用，忙时另建一次性，不可用/超龄则新建缓存。例两个并发轮不会共用已标busy的同一socket。
 * 会建/关网络、改Map/timer/busy；缓存键不含URL/token/headers，建连await期间也没有全局互斥，不能保证每个键永远只有一个活动连接。失败向上拒绝，调用方必须finally release。
 */
// 获取一个本次独占使用的socket，可能复用缓存或新建，返回带释放函数的租用对象。
async function acquireWebSocket(
	// 新连接目标；缓存复用时不重新比对URL。
	url: string,
	// 新握手头；缓存复用不更新现有连接头/token。
	headers: Headers,
	// 原会话键可缺省，缺省只用一次性连接。
	sessionId: string | undefined,
	// 账号claim分组键，静态string并不代表本函数核验过真实账号身份。
	accountId: string,
	// 用户信号用于建连，后续读流另注册监听。
	signal?: AbortSignal,
	// 可选连接时限，undefined交下层默认。
	connectTimeoutMs?: number,
	// 仅构造器需要的Bun代理环境。
	env?: ProviderEnv,
	// Promise解析出的结构里含socket和同步release函数。
): Promise<{
	// 本次使用的socket。
	socket: WebSocketLike;
	// 只有登记缓存的连接才有entry；一次性连接没有续传状态容器。
	entry?: CachedWebSocketConnection;
	// 表示是否实际选中了此前缓存对象，不表示网络一定健康。
	reused: boolean;
	// release默认keep缺省时关闭；keep:true且可复用才回空闲缓存。
	release: (options?: { keep?: boolean }) => void;
}> {
	// 无真值会话id时完全不登记连接Map。
	if (!sessionId) {
		// 每次新建连接并等待open。
		const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
		// 返回一次性租用对象。
		return {
			// 新连接引用。
			socket,
			// 没复用标志。
			reused: false,
			/**
			 * 无会话的一次性release回调忽略keep请求，返回void并请求close，不把连接登记到Map或安排空闲复用。
			 */
			// 释放总是关该socket，忽略keep选项，不放回缓存。
			release: () => closeWebSocketSilently(socket),
		};
	}

	// 先取该会话的账号连接表。
	let accountEntries = websocketSessionCache.get(sessionId);
	// 再按账号id找条目，不按endpoint/headers/token精细比较。
	const cached = accountEntries?.get(accountId);
	// 有已登记连接才进入复用分析。
	if (cached) {
		// 不论后面忙/过期/可复用，先撤掉已有空闲timer。
		if (cached.idleTimer) {
			// 清timer。
			clearTimeout(cached.idleTimer);
			// 同时清句柄，后续release再安排。
			cached.idleTimer = undefined;
		}
		// 只有不忙且年龄已到55分钟才关闭旧连接，忙连接不因年龄在此被强杀。
		if (!cached.busy && isWebSocketSessionExpired(cached)) {
			// 标明年龄限额关闭。
			closeWebSocketSilently(cached.socket, 1000, "connection_age_limit");
			// 删除该账号旧条目。
			accountEntries?.delete(accountId);
			// 表空就删除会话缓存引用，后面新连接时可重建。
			if (accountEntries?.size === 0) websocketSessionCache.delete(sessionId);
			// 非过期、非忙且本地可复用时采用旧socket。
		} else if (!cached.busy && isWebSocketReusable(cached.socket)) {
			// 标记本轮占用，后续同键并发请求不会复用这条忙连接。
			cached.busy = true;
			// 立即返回缓存租用，不再await建连。
			return {
				// 返回旧socket引用。
				socket: cached.socket,
				// 附缓存条目给续传层读写状态。
				entry: cached,
				// 告知统计为复用。
				reused: true,
				/**
				 * 释放复用缓存连接，输入可选keep，返回void；未明确keep或本地状态不可用就关闭/按对象身份删缓存。
				 * 例keep:true改busy:false并重排5分钟空闲timer；不等待关闭握手，也不自己清debug/fallback状态。
				 */
				// 缓存复用分支自己的release闭包，keep可省略默认关闭。
				release: ({ keep } = {}) => {
					// 没明确keep或socket当前不可复用时销毁缓存连接。
					if (!keep || !isWebSocketReusable(cached.socket)) {
						// 请求关闭旧socket。
						closeWebSocketSilently(cached.socket);
						// 重新查当前表，避免用旧表引用删后来替换项。
						const currentEntries = websocketSessionCache.get(sessionId);
						// 只有当前槽仍是cached对象才删除。
						if (currentEntries?.get(accountId) === cached) currentEntries.delete(accountId);
						// 清空表后的外层会话键。
						if (currentEntries?.size === 0) websocketSessionCache.delete(sessionId);
						// 销毁路径结束，不再标空闲。
						return;
					}
					// keep且可复用时改为空闲。
					cached.busy = false;
					// 重新安排5分钟空闲过期timer。
					scheduleSessionWebSocketExpiry(sessionId, accountId, cached);
				},
			};
		}
		// 原缓存忙时不排队等它，另开一次性连接。
		if (cached.busy) {
			// 等新连接，不覆盖正在忙的缓存entry。
			const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
			// 返回一次性租用对象，无entry。
			return {
				// 使用临时socket。
				socket,
				// 统计为新连接。
				reused: false,
				/**
				 * 缓存忙时借用的临时连接release，返回void，总请求关闭临时socket，不覆盖忙entry或参与续传缓存。
				 */
				// 释放临时连接时不缓存，keep选项不会改变这个分支。
				release: () => {
					// 直接请求关闭临时socket。
					closeWebSocketSilently(socket);
				},
			};
		}
		// 旧缓存不忙但不open/不可复用时清理。
		if (!isWebSocketReusable(cached.socket)) {
			// 请求关闭失效socket。
			closeWebSocketSilently(cached.socket);
			// 删除旧账号条目。
			accountEntries?.delete(accountId);
			// 清空表后删会话键。
			if (accountEntries?.size === 0) websocketSessionCache.delete(sessionId);
		}
	}

	// 没可用缓存时新建连接；await期间其他请求也可能建立自己的连接，不是全局互斥锁。
	const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
	// 建新缓存条目，busy:true、本地创建时间；没有一开始就填续传状态。
	const entry: CachedWebSocketConnection = { socket, busy: true, createdAt: Date.now() };
	// await回来后重新读Map，避免沿用建连之前的旧表。
	accountEntries = websocketSessionCache.get(sessionId);
	// 没会话账号表时才创建。
	if (!accountEntries) {
		// 新账号Map。
		accountEntries = new Map();
		// 登记新会话表。
		websocketSessionCache.set(sessionId, accountEntries);
	}
	// 把新entry写入账号槽；同键并发建连可覆盖较早写入，不是等待期间持有锁。
	accountEntries.set(accountId, entry);
	// 返回新缓存连接的租用对象。
	return {
		// 本次socket。
		socket,
		// 新缓存entry，可记录续传。
		entry,
		// 这次不是复用。
		reused: false,
		/**
		 * 释放新建缓存连接，输入可选keep，返回void，会改busy/安排空闲timer或关闭并删该entry。
		 * 例keep:true且readyState可复用时回空闲；关闭路径只删当前仍匹配对象的槽，不误删后来并发替换项。
		 */
		// 新建缓存分支的release，keep缺省false语义。
		release: ({ keep } = {}) => {
			// 没keep或本地状态不可复用就销毁。
			if (!keep || !isWebSocketReusable(entry.socket)) {
				// 请求关闭新socket。
				closeWebSocketSilently(entry.socket);
				// 有空闲timer时一并clear，避免销毁后再执行旧回调。
				if (entry.idleTimer) clearTimeout(entry.idleTimer);
				// 重新查当前Map而非捕获的旧账号表。
				const currentEntries = websocketSessionCache.get(sessionId);
				// 仅该槽仍是同entry才删，不误删并发替换项。
				if (currentEntries?.get(accountId) === entry) currentEntries.delete(accountId);
				// 空账号表移除会话键。
				if (currentEntries?.size === 0) websocketSessionCache.delete(sessionId);
				// 销毁路径结束。
				return;
			}
			// keep且可复用才标空闲。
			entry.busy = false;
			// 重新安排5分钟回收；这里不等待服务端确认续传状态仍存在。
			scheduleSessionWebSocketExpiry(sessionId, accountId, entry);
		},
	};
}

/**
 * 从未知WS错误事件提Error，优先顶层非空message，再嵌套Error，再嵌套message，最后固定后备，无网络/输入修改。
 * 例event.error为已有Error时保留原实例；这里只检查有限形状，未对文字作trim/脱敏或识别所有运行时错误类型。
 */
// 从unknown WS错误事件中提可用Error，返回原嵌套Error或新Error，无网络。
function extractWebSocketError(event: unknown): Error {
	// 只在事件为真值对象时读取其可能字段。
	if (event && typeof event === "object") {
		// 优先顶层message，in也会看原型链，字段值仍unknown。
		const message = "message" in event ? (event as { message?: unknown }).message : undefined;
		// 必须是长度>0字符串，纯空格未trim也会采纳。
		if (typeof message === "string" && message.length > 0) {
			// 以顶层说明创建新Error，不保留事件其他任意字段。
			return new Error(message);
		}

		// 顶层无有效文字再取嵌套error。
		const nestedError = "error" in event ? (event as { error?: unknown }).error : undefined;
		// 嵌套本身为Error且说明非空时直接复用该实例。
		if (nestedError instanceof Error && nestedError.message.length > 0) {
			// 保留这个Error的其他属性/栈，不新包装。
			return nestedError;
		}
		// 不是有效Error时再按对象message形状提取，未要求普通JSON对象。
		if (nestedError && typeof nestedError === "object" && "message" in nestedError) {
			// 用unknown视图读嵌套message。
			const nestedMessage = (nestedError as { message?: unknown }).message;
			// 同样要求非空字符串，不trim。
			if (typeof nestedMessage === "string" && nestedMessage.length > 0) {
				// 创建只带该说明的Error。
				return new Error(nestedMessage);
			}
		}
	}
	// 所有来源都无可用文字用固定通用说明。
	return new Error("WebSocket error");
}

/**
 * 把未知关闭事件转成带码/原因/wasClean的本地错误，返回Error，无网络。
 * 例code=1009无reason时说明补message too big，reason属性仍缺省；非对象返回普通关闭错误，干净关闭也不证明收到模型终态。
 */
// 从关闭事件提说明与元数据，返回Error，不判断一次生成业务是否完成。
function extractWebSocketCloseError(event: unknown): Error {
	// 未知事件先做真值对象边界检查。
	if (event && typeof event === "object") {
		// 有code字段才读，仍unknown。
		const code = "code" in event ? (event as { code?: unknown }).code : undefined;
		// 可选reason原值。
		const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
		// 可选wasClean原值。
		const wasClean = "wasClean" in event ? (event as { wasClean?: unknown }).wasClean : undefined;
		// 真实number码加进说明，不验证标准关闭码范围/有限性。
		const codeText = typeof code === "number" ? ` ${code}` : "";
		// 真正非空字符串原因才加入，纯空格也被当非空。
		let reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
		// 没原因文字且码1009时补可读错误解释。
		if (!reasonText && code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) {
			// 补message too big，不自行重发更小请求。
			reasonText = " message too big";
		}
		// 创建本地关闭Error，trim最后整体外层空白。
		return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
			// 保存数字码，否则undefined。
			code: typeof code === "number" ? code : undefined,
			// 保存原非空reason；补充的message too big不自动成为reason属性。
			reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
			// 仅真实boolean才保存wasClean。
			wasClean: typeof wasClean === "boolean" ? wasClean : undefined,
		});
	}
	// 不可读关闭事件用普通Error回退，不创建伪造code。
	return new Error("WebSocket closed");
}

/**
 * 将WS消息data解码成文字，输入unknown，返回Promise<string|null>，不发网络/修改输入。
 * 按字符串、ArrayBuffer、字节视图、带arrayBuffer方法对象处理；例DataView只解码它自己的偏移/长度，而非整个buffer。
 * Blob样分支只查键存在再断言方法，错误会拒绝；未知形式返回null。每条消息独立解码，不为并发异步Blob保证原始到达顺序。
 */
// 将不同WS data表示转成UTF-8文字，Promise返回字符串或null，无网络。
async function decodeWebSocketData(data: unknown): Promise<string | null> {
	// 字符串原样返回，包括空串；后续解析器会跳过空文本。
	if (typeof data === "string") return data;
	// ArrayBuffer分支覆盖整块字节。
	if (data instanceof ArrayBuffer) {
		// 新建解码器，不像SSE那样跨消息保留解码状态。
		return new TextDecoder().decode(new Uint8Array(data));
	}
	// 识别TypedArray/DataView等视图。
	if (ArrayBuffer.isView(data)) {
		// as让TS按ArrayBufferView访问三项字段，不复制底层buffer。
		const view = data as ArrayBufferView;
		// 只解码视图的byteOffset/byteLength范围，不误带前后缓冲字节。
		return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
	}
	// 类Blob对象只检查存在arrayBuffer键，没核验该值真是函数/返回真ArrayBuffer。
	if (data && typeof data === "object" && "arrayBuffer" in data) {
		// 断言约定方法签名，不增加运行时验证。
		const blobLike = data as { arrayBuffer: () => Promise<ArrayBuffer> };
		// 等异步取得字节；并发message回调各自await，没有统一串行解码队列。
		const arrayBuffer = await blobLike.arrayBuffer();
		// 新建解码器返回文字，坏UTF-8默认替换而非fatal。
		return new TextDecoder().decode(new Uint8Array(arrayBuffer));
	}
	// 不认识的data形式返回null，外层忽略而非抛类型错误。
	return null;
}

/**
 * 把WS回调变成异步事件源，输入socket/用户信号/可选空闲时限，yield解码JSON，不负责创建/最终保留连接。
 * 安装消息/错误/关闭/取消监听，消息各自异步解码入队，循环先排queue再看done/failed，空队列时挂可被事件唤醒的Promise与空闲timer。
 * 例收终态后可结束而不等close；没终态close报错，空闲超时主动请求close，用户取消回调只设失败由外层释放连接。
 * 有JSON语法解析但无完整schema检查，队列无硬上限；finally去监听并不取消已启动的异步解码任务，数据解码完成顺序可能不同于消息到达顺序。
 */
// 将WS回调事件变成异步JSON迭代器，连接本身由外层借用/释放。
async function* parseWebSocket(
	// 输入已打开的socket，最小接口无内建读取队列。
	socket: WebSocketLike,
	// 用户取消可省略。
	signal?: AbortSignal,
	// 空闲时限只在队列空且未done等待下一消息时安装，不是整个响应总时限。
	idleTimeoutMs?: number,
	// yield宽松字典；不完整校验SDK事件schema。
): AsyncGenerator<Record<string, unknown>> {
	// 缓存已解码JSON对象，未设队列长度上限。
	const queue: Record<string, unknown>[] = [];
	// 保存当前等待Promise的resolve，无等待时为null。
	let pending: (() => void) | null = null;
	// 标记来源已结束/失败，但队列内容仍先被消费。
	let done = false;
	// 保存待抛错误，可能在队列排空后才抛。
	let failed: Error | null = null;
	// 标记已见三种终态事件名之一，不证明response.status一定成功。
	let sawCompletion = false;

	/**
	 * 唤醒当前队列等待，输入无参数，返回void；先取resolve并清pending，再结算等待Promise。
	 * 例同批多个消息只有第一次需要唤醒，后续queue非空可直接消费，不为每条消息新建等候。
	 */
	// 唤醒当前等待消费者，无等待时无事可做。
	const wake = () => {
		// pending为空就不创建新Promise。
		if (!pending) return;
		// 保存当前resolve引用。
		const resolve = pending;
		// 先清引用避免重入多次唤醒同一等待。
		pending = null;
		// resolve唤醒读取循环；是否成功/失败由下面状态检查决定。
		resolve();
	};

	/**
	 * message事件回调为本条数据启动独立async解码任务，返回void，不等待其他消息任务。
	 * 例Blob解码较慢时后来的字符串可先入队；内部失败存CodexProtocolError并唤醒，不能说这是严格串行网络顺序转换。
	 */
	// 每个message回调独立启动异步解码，不等待前一message任务。
	const onMessage: WebSocketListener = (event) => {
		/**
		 * 本条message的异步任务读取data、解码/解析、识别终态并排队，Promise由void忽略，失败在内部转状态。
		 * 会改queue/done/failed/sawCompletion并wake；已移监听不会自动终止这项已开始任务。
		 */
		// void忽略任务Promise；内部try捕获解码/JSON/字段处理失败，但不统一排序Blob任务。
		void (async () => {
			// 先存可能的原文本，失败时作为诊断payload。
			let text: string | null = null;
			// 包住未知事件读取、异步字节转换、JSON解析与入队。
			try {
				// 真值对象且存在data键才处理，其他消息事件忽略。
				if (!event || typeof event !== "object" || !("data" in event)) return;
				// 等该条data解码，不代表所有message按到达顺序串行完成。
				text = await decodeWebSocketData((event as { data?: unknown }).data);
				// null/空字符串都忽略，不设置失败或完成。
				if (!text) return;
				// JSON语法解析后直接断言字典；根null会在下一行访问时报错并被转协议错误。
				const parsed = JSON.parse(text) as Record<string, unknown>;
				// type真实string才作为标签，其他取空串；其他字段仍未验证。
				const type = typeof parsed.type === "string" ? parsed.type : "";
				// 三种终态名让源结束，不包括response.failed/error，它们由映射层转业务异常。
				if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
					// 记录见终态，后续close可被视为源正常结束。
					sawCompletion = true;
					// 标done后仍会把本条终态入队，先交消费者再结束。
					done = true;
				}
				// 将该解码完成事件排队；并发异步解码的完成顺序可能不同于原message到达顺序。
				queue.push(parsed);
				// 唤醒正等队列的读取循环。
				wake();
				// 解码/JSON/属性访问等失败都进入协议错误路径。
			} catch (cause) {
				// 文案称Invalid JSON，实际也覆盖其他被此try捕获的解码/处理错误。
				failed = new CodexProtocolError(`Invalid Codex WebSocket JSON: ${formatThrownValue(cause)}`, {
					// 保留原cause。
					cause,
					// 保存解码出的文字（可能null），不在此截断/脱敏。
					payload: text,
				});
				// 令读取循环结束，但它仍优先处理已有queue。
				done = true;
				// 唤醒等待，避免一直挂起。
				wake();
			}
			// 立即执行该message异步任务，不返回给事件宿主等待。
		})();
	};

	/**
	 * 运行时error回调提取失败、标done并wake，无独立返回值，不在这里发SSE请求；普通传输错误由外层决定能否回退。
	 */
	// 普通error事件提Error，标结束并唤醒。
	const onError: WebSocketListener = (event) => {
		// 覆盖当前failed变量为运行时错误说明。
		failed = extractWebSocketError(event);
		// done不等于sawCompletion，因此通常后面会失败。
		done = true;
		// 唤醒当前等待。
		wake();
	};

	/**
	 * close回调已见终态时只标done并wake，否则保留旧失败或提关闭Error，再结束源。
	 * 例wasClean=true但没完成事件仍失败，已见完成也不在这里自动计算费用；返回void，不重建连接。
	 */
	// close事件按是否已见终态区分，不只看wasClean。
	const onClose: WebSocketListener = (event) => {
		// 已见终态则不因close本身再构造错误。
		if (sawCompletion) {
			// 保持done。
			done = true;
			// 唤醒以消费已排队终态。
			wake();
			// 不进入未完成关闭错误分支。
			return;
		}
		// 没终态且还没其他失败时才存关闭错误，避免覆盖已有失败。
		if (!failed) {
			// 提取码/原因/wasClean供上层说明。
			failed = extractWebSocketCloseError(event);
		}
		// 标结束。
		done = true;
		// 唤醒读取器，排空队列后抛失败。
		wake();
	};

	/**
	 * 用户取消回调保存固定取消Error、标done并唤醒，返回void，不在本回调直接close；后续循环/外层finally负责结束与释放。
	 */
	// 用户取消回调只改本生成器状态并唤醒，不在本回调里主动close。
	const onAbort = () => {
		// 固定取消Error，原reason不直接显示。
		failed = new Error("Request was aborted");
		// 标done。
		done = true;
		// 解除当前队列等待。
		wake();
	};

	// 注册模型消息监听。
	socket.addEventListener("message", onMessage);
	// 注册错误监听。
	socket.addEventListener("error", onError);
	// 注册关闭监听。
	socket.addEventListener("close", onClose);
	// 注册用户取消，finally删除；没有使用once。
	signal?.addEventListener("abort", onAbort);

	// 消费、提前关闭或失败都清本生成器自己的监听，不总在此关闭连接。
	try {
		// 循环从队列读事件，没队列再等待。
		while (true) {
			// 用户取消优先于继续吐已排队数据。
			if (signal?.aborted) {
				// 抛固定取消Error。
				throw new Error("Request was aborted");
			}
			// 有队列时先处理，即使done/failed已经被回调设置。
			if (queue.length > 0) {
				// shift取首项；!只让TS知道前面长度>0，没再创建检查。
				yield queue.shift()!;
				// yield后继续，直到队列排空。
				continue;
			}
			// 队列空且done才结束循环。
			if (done) break;
			// 每次等待各自有临时空闲timer。
			let timeout: ReturnType<typeof setTimeout> | undefined;
			/**
			 * 空队列时建立一次等待Promise，保存resolve给wake，并按正数idleTimeout安装拒绝timer。
			 * 它不直接返回事件；醒来后循环再读队列/失败状态，Promise的finally清本次timer。
			 */
			// Promise只表示“被唤醒有状态可读”或“等待超时”，不直接装载下一事件。
			await new Promise<void>((resolve, reject) => {
				// 保存resolve供wake调用，任一相关事件可唤醒。
				pending = resolve;
				// 已设且>0才安装空闲timer；undefined/0无此限制。
				if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
					/**
					 * 空闲timer回调记录传输错误、标结束、清pending、请求关闭并reject等待，返回void。
					 * 例50ms等不到下一消息可在首事件前触发SSE回退，开始后同类失败通常停止，不是整次响应固定50ms总期限。
					 */
					// 到时构造普通传输Error，不包装成业务/协议错误。
					timeout = setTimeout(() => {
						// 报具体空闲毫秒。
						const error = new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`);
						// 保存为failed。
						failed = error;
						// 标done。
						done = true;
						// 清pending，避免随后消息resolve已被拒绝的等待。
						pending = null;
						// 超时主动请求close，和用户取消回调只改状态不同。
						closeWebSocketSilently(socket, 1000, "idle_timeout");
						// reject让当前await直接失败，不等下一轮再读failed。
						reject(error);
						// 每次重新进入空队列等待都会重新计时。
					}, idleTimeoutMs);
				}
				/**
				 * 等待Promise无论唤醒或失败都清本轮空闲timer，返回void；不在这里移socket监听或取消已入队消息。
				 */
				// 等待无论resolve/reject都清这一轮timer。
			}).finally(() => {
				// 确有句柄才清。
				if (timeout) {
					// 避免下一消息已到后旧空闲timer继续触发。
					clearTimeout(timeout);
				}
			});
		}

		// 正常跳出循环且存过failed才在此抛；映射器提前return会直接走finally，不一定运行这里。
		if (failed) {
			// 把原失败Error交上层决定回退/停止。
			throw failed;
		}
		// 没错误但也没见完成事件，不把关闭当成功。
		if (!sawCompletion) {
			// 说明未见终态；接受的实际终态也包括done/incomplete，文案保持原样。
			throw new Error("WebSocket stream closed before response.completed");
		}
		// 解除本生成器监听，不负责成功连接的缓存保留决策。
	} finally {
		// 删除message监听；已启动的异步解码任务不因此自动取消。
		socket.removeEventListener("message", onMessage);
		// 删除error监听。
		socket.removeEventListener("error", onError);
		// 删除close监听。
		socket.removeEventListener("close", onClose);
		// 删除用户取消监听。
		signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * 浅复制请求体但去掉input/previous_response_id，输入body、输出其余字段对象，无外部修改。
 * 例两轮只新增用户消息时其余模型/工具/提示仍可比较；嵌套引用未深拷贝，JSON比较函数还会序列化它们。
 */
// 取请求体去掉input/previous_response_id后的浅副本，用于比较其余配置，不改原体。
function requestBodyWithoutInput(body: RequestBody): RequestBody {
	// 解构把两项收在未使用局部变量，...rest收剩余自有可枚举字段。
	const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
	// 返回新剩余对象，嵌套值仍可共用引用。
	return rest;
}

/**
 * 按JSON.stringify结果比较两个ResponseInput，返回boolean，无修改。
 * undefined与[]视同；例字段插入顺序不同可判不等，undefined对象属性可能被省略，不是通用深相等/语义比较，循环/BigInt等仍可抛错。
 */
// 比较两份输入的JSON序列化结果，返回boolean，不是完整深相等算法。
function responseInputsEqual(a: ResponseInput | undefined, b: ResponseInput | undefined): boolean {
	// 缺省与null（未类型化）都按[]处理；键顺序/JSON省略字段会影响比较，循环对象可抛。
	return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/**
 * 比较两请求除input/previous_response_id外的JSON表示，返回boolean，不发网络/修改输入。
 * 例同模型但tools/schema/指令改变通常会判不匹配，属性顺序也参与字串相等；异常序列化向上传递，不解析文本语义。
 */
// 比较请求中除input/previous id之外的JSON表示，无网络/修改。
function requestBodiesMatchExceptInput(a: RequestBody, b: RequestBody): boolean {
	// 两次先去字段再序列化；属性插入顺序不同也可能判不相等，不证明语义完全相同。
	return JSON.stringify(requestBodyWithoutInput(a)) === JSON.stringify(requestBodyWithoutInput(b));
}

/**
 * 计算本轮完整输入相对上次完整输入+上次本地重放回复的新增后缀，返回新数组或undefined，不改缓存。
 * 先确认其余请求JSON相等，再要求当前至少有基线长度且前缀JSON相等；例旧输入[用户A]+回复B，新输入[A,B,用户C]只回[C]。
 * 相等时可回空[]，历史压缩/规则工具变化/序列化差异会放弃delta；不验证服务端是否仍认识上一id，序列化可抛错。
 */
// 取可在旧WS连接上续传的新增输入，返回新后缀数组或undefined，无缓存修改。
function getCachedWebSocketInputDelta(
	// 本次完整body，未预先换成delta。
	body: RequestBody,
	// 上一次完整body、响应id与本地重放响应项构成基线。
	continuation: CachedWebSocketContinuationState,
	// undefined表示不满足续传条件，空数组是合法“没有新增输入”。
): ResponseInput | undefined {
	// 模型/工具/instructions等其余配置JSON不相同就不能用旧响应前缀。
	if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
		// 让调用方回全量请求并清续传状态。
		return undefined;
	}

	// 本次input缺省按空数组。
	const currentInput = body.input ?? [];
	// 基线=上次请求输入+上次assistant本地重放项，不等于把全部网络output事件照搬。
	const baseline = [...(continuation.lastRequestBody.input ?? []), ...continuation.lastResponseItems];
	// 本次条目数小于基线时，可能发生历史变化/压缩，不能当追加续传。
	if (currentInput.length < baseline.length) {
		// 返回缺失，交调用方回全量。
		return undefined;
	}

	// 复制本次前baseline.length项以比较前缀。
	const prefix = currentInput.slice(0, baseline.length);
	// 前缀JSON必须逐项/键顺序序列化一致，不是按topic或文本语义判断。
	if (!responseInputsEqual(prefix, baseline)) {
		// 不匹配放弃delta。
		return undefined;
	}

	// 返回去掉基线的后缀，空[]也有效；不删除调用者原input。
	return currentInput.slice(baseline.length);
}

/**
 * 为缓存entry选择续传请求，输入entry/完整body，返回原body或新顶层对象，并可能清entry.continuation。
 * 无基线直接全量；前缀不匹配或无上一id就清基线回全量，匹配则覆盖previous_response_id与新增input；例零新增[]也能续传。
 * 不发网络、不修改原完整input，续传引用真失效时要由上层业务错误恢复处理。
 */
// 为已租用缓存连接选择完整/续传请求，返回原body或新顶层body，并可能清entry.continuation。
function buildCachedWebSocketRequestBody(entry: CachedWebSocketConnection, body: RequestBody): RequestBody {
	// 取此连接上的续传基线，不从别的账号/会话找上一响应。
	const continuation = entry.continuation;
	// 从未记续传就不尝试按前缀裁剪。
	if (!continuation) {
		// 原对象原样返回，不额外克隆。
		return body;
	}

	// 按其余body配置与完整输入前缀算delta。
	const delta = getCachedWebSocketInputDelta(body, continuation);
	// undefined或无真值上一响应id就放弃；[]是真值，所以零新增也能续传。
	if (!delta || !continuation.lastResponseId) {
		// 清此连接续传状态，避免以后重复尝试不相容基线。
		entry.continuation = undefined;
		// 回本轮完整body，不在此重试网络。
		return body;
	}

	// 续传时建新顶层对象，不改原fullBody。
	return {
		// 先复制所有原字段。
		...body,
		// 覆盖上一响应id，属于连接状态引用，不依赖store:true。
		previous_response_id: continuation.lastResponseId,
		// 只发送新增条目；原body的完整input仍保留给后续基线。
		input: delta,
	};
}

/**
 * 在首个映射后的源事件交给共享处理器前调用onStart一次，异步转发原事件，不发网络。
 * 例response.created即可触发，不必等文字delta；空源不触发。回调或迭代错误向上传递，每次包装有独立started标记。
 */
// 包一层生成器，在首个源事件前执行onStart一次，无网络/内容改写。
async function* startWebSocketOutputOnFirstEvent(
	// 输入已经Codex映射后的SDK事件，映射层可先忽略某些原始消息。
	events: AsyncIterable<ResponseStreamEvent>,
	// 调用方提供开始回调，可能更新标记/发Pi start。
	onStart: () => void,
	// 返回转发相同事件的异步生成器。
): AsyncGenerator<ResponseStreamEvent> {
	// 每次调用该包装器有独立started状态，不等于整轮startEmitted。
	let started = false;
	// 依次消费映射事件。
	for await (const event of events) {
		// 只有首个yield事件前回调。
		if (!started) {
			// 先标已调用，避免该迭代后续重复。
			started = true;
			// 同步调用onStart；若回调抛错则中断并传播。
			onStart();
		}
		// 原事件引用继续交共享处理器，不额外复制。
		yield event;
	}
}

/**
 * 租用WS、选择完整/增量请求、发response.create并消费统一Responses流，输入连接/请求/输出/模型/回调及超时会话映射，返回Promise<void>。
 * 会建/复用网络、更新调试计数、改output和连接续传；发送/消费阶段try失败清续传、标不保留并重抛，finally release按标记归还或关闭。
 * 例显式websocket-cached且同前缀时发送previous_response_id+新增input，store默认仍false。省略transport只在主入口看作auto，下方原选项判断不自动开启delta。
 * 租用后的请求比较/统计在发送try之前，不应把该finally理解为覆盖每一步构建异常；成功缓存基线也不在这里先做外层assertSuccessfulOutput。
 */
// 租用连接、选择续传体、发送并消费WS响应，返回Promise<void>，本轮output在共享层更新。
async function processWebSocketStream(
	// 新建连接时使用的WS URL，复用时未重新比较。
	url: string,
	// payload钩子后的完整body，缓存续传还可能新建缩减版。
	body: RequestBody,
	// 握手头，新连接才发送。
	headers: Headers,
	// 共享可变回复。
	output: AssistantMessage,
	// Pi块事件输出通道。
	stream: AssistantMessageEventStream,
	// 模型用于共享层历史重放和目录计价。
	model: Model<"openai-codex-responses">,
	// 首个映射事件到来时触发，不是socket open回调。
	onStart: () => void,
	// 可选“队列空等下一消息”时限，与整体响应总时长不同。
	idleTimeoutMs: number | undefined,
	// 可选建连时限。
	websocketConnectTimeoutMs: number | undefined,
	// 本地原始会话缓存键，可能undefined。
	cacheSessionId: string | undefined,
	// 账号claim分连接表。
	accountId: string,
	// grammar名→原始文本承载属性映射。
	grammarToolInputProperties: ReadonlyMap<string, string>,
	// 原选项提供信号/transport/env与事件钩子。
	options?: OpenAICodexResponsesOptions,
	// 没单独返回assistant，靠output引用/通道表达。
): Promise<void> {
	// 等连接租用，解构socket、可选缓存entry、复用标记和release回调。
	const { socket, entry, reused, release } = await acquireWebSocket(
		// 传新连接URL。
		url,
		// 传新握手头。
		headers,
		// 原session键控制是否登记连接Map。
		cacheSessionId,
		// 账号键进一步分组。
		accountId,
		// 用户取消用于建连和后续流消费。
		options?.signal,
		// 建连超时传下层，undefined让其取默认。
		websocketConnectTimeoutMs,
		// 请求env供Bun代理选择。
		options?.env,
	);
	// 初始打算保留连接，发送/消费出错或结束时已取消再改false。
	let keepConnection = true;
	// 只有原options明确是auto或websocket-cached才续传；入口的缺省transport="auto"并没写回options，所以省略时不自动启用delta。
	const useCachedContext = options?.transport === "websocket-cached" || options?.transport === "auto";
	// ChatGPT Codex Responses rejects `store: true` ("Store must be set to false").
	// WebSocket continuation still works via connection-scoped previous_response_id state.
	// fullBody只是原body别名，并非深快照或强制store:false的重写。
	const fullBody = body;
	// 有续传模式且有登记entry才裁输入；临时/无会话连接始终用fullBody。
	const requestBody = useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, fullBody) : fullBody;
	// 有原session才创建/更新debug，没有会话就不保存此类统计。
	const stats = cacheSessionId ? getOrCreateWebSocketDebugStats(cacheSessionId) : undefined;
	// 下面只记录选中的本地请求形状，尚未执行socket.send。
	if (stats) {
		// 计一次WS处理尝试，后续send失败仍已增加。
		stats.requests++;
		// 复用租用对象则复用次数加一。
		if (reused) stats.connectionsReused++;
		// 其他计新连接，包括未登记临时连接。
		else stats.connectionsCreated++;
		// 开了续传模式就计数，不要求这次真的裁成delta。
		if (useCachedContext) stats.cachedContextRequests++;
		// store精确true才加计数，钩子可改默认false。
		if (requestBody.store === true) stats.storeTrueRequests++;
		// 记实际选中body的input条目数，缺省0。
		stats.lastInputItems = requestBody.input?.length ?? 0;
		// 真值previous id被统计为delta，不独立验证其来源/是否有效。
		if (requestBody.previous_response_id) {
			// 累加delta请求数。
			stats.deltaRequests++;
			// 记录这次delta输入项数。
			stats.lastDeltaInputItems = requestBody.input?.length ?? 0;
			// 记录所引用的上一响应id。
			stats.lastPreviousResponseId = requestBody.previous_response_id;
			// 没previous id则按full请求记账。
		} else {
			// 全量形状计数加一。
			stats.fullContextRequests++;
			// 清最近delta条目数，赋undefined而非delete。
			stats.lastDeltaInputItems = undefined;
			// 清最近previous id。
			stats.lastPreviousResponseId = undefined;
		}
	}
	// 这个try从真正发送开始，前面的续传比较/统计并不在此finally覆盖范围。
	try {
		// 序列化response.create帧；后展开requestBody可覆盖前面的type字段，既有表达式不强制恢复。
		socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
		// 等待共享Responses块/终态处理完，失败进入下面catch。
		await processResponsesStream(
			// 在首个映射事件前触发本轮开始回调。
			startWebSocketOutputOnFirstEvent(
				// 同一Codex事件映射器处理原始WS事件/钩子/特殊业务错误。
				mapCodexEvents(
					// WS回调源带用户取消与空闲读取时限，不是HTTP fetch。
					parseWebSocket(socket, options?.signal, idleTimeoutMs),
					// 映射可写共享output.endTurn。
					output,
					// 观察钩子的模型身份。
					model,
					// 原始观察钩子只由映射层执行一次。
					options?.onProviderStreamEvent,
				),
				// 传上层的start回调，不在本地重复发start。
				onStart,
			),
			// 共享输出对象用于累积内容/用量/停止原因。
			output,
			// 共享Pi事件通道。
			stream,
			// 模型目录价格与身份。
			model,
			// 只传共享流所需配置。
			{
				// tier取原options，不按钩子后requestBody.service_tier自动更新。
				serviceTier: options?.serviceTier,
				// grammar原始文本参数映射。
				grammarToolInputProperties,
				// Codex特有tier优先策略。
				resolveServiceTier: resolveCodexServiceTier,
				/**
				 * 计价回调接已算目录费用的Usage与选定tier，闭包补本模型id，原地乘倍率，返回void，不请求账单。
				 */
				// 回调闭包补入模型id，原地调整已算目录费用。
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
			},
		);
		// 消费后若用户已取消，不保留本连接。
		if (options?.signal?.aborted) {
			// 只设keep false，最终外层仍会报取消。
			keepConnection = false;
			// 开续传模式、有缓存entry且有真值output.responseId才记录下一轮基线；此处未先调用外层成功断言。
		} else if (useCachedContext && entry && output.responseId) {
			// 把这轮统一assistant重新转Responses输入，作为下一轮基线尾部。
			const responseItems = convertResponsesMessages(
				// 用本模型身份/能力处理重放。
				model,
				// 只含本轮output的旧Context先规范成TranscriptContext，可能由共享转换丢弃失败/取消回复。
				normalizeContext({ messages: [output] }),
				// 同一允许目标provider的复合工具id规则。
				CODEX_TOOL_CALL_PROVIDERS,
				// 本地重放不附首条system。
				{
					// 明确关闭首系统提示输入。
					includeSystemPrompt: false,
					// grammar调用继续用同一属性映射，避免custom原文被当普通JSON工具。
					grammarToolInputProperties,
				},
				/**
				 * 过滤本地重放时合成的function/custom调用结果，输入一个Responses输入项，返回是否保留。
				 * 例真正工具结果由下一轮会话提供，不能把本轮assistant单独转换产生的占位结果当作已执行返回；不在此删除原output中的工具调用。
				 */
				// 过滤转换器可能合成的函数/自定义工具结果，基线只保留本地回复输入项，不把合成结果当真实执行返回。
			).filter((item) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output");
			// 为此连接保存新的续传状态对象。
			entry.continuation = {
				// 保存完整body引用，没把本次裁过的delta体当完整基线，也不是深复制快照。
				lastRequestBody: fullBody,
				// 保存响应id供下一轮previous_response_id。
				lastResponseId: output.responseId,
				// 保存本地转换后的assistant项数组。
				lastResponseItems: responseItems,
			};
		}
		// 发送、消费、重放转换中抛错都清本连接续传并标关闭。
	} catch (error) {
		// 只对登记缓存的entry有状态可清，一次性连接没有它。
		if (entry) {
			// 赋undefined解除本地上一响应基线。
			entry.continuation = undefined;
		}
		// 失败不保留当前租用连接。
		keepConnection = false;
		// 原异常重抛，主入口再判特殊恢复/回退/失败。
		throw error;
		// 覆盖上述发送try的成功/异常，不代表之前所有构建步骤都在此范围内。
	} finally {
		// 调租用对象对应release，缓存keep时回空闲，一次性连接总关闭。
		release({ keep: keepConnection });
	}
}

// ============================================================================
// Error Handling
// ============================================================================

/**
 * 完整读HTTP失败正文，尝试从error JSON生成普通/友好提示，返回{message,friendlyMessage?}，不发新请求或修改账户。
 * 有error且码像额度限制或HTTP429时可加计划与重置分钟；例retryable服务端429也可能生成含usage limit的友好提示，影响外层catch的文字重试判断。
 * JSON/字段解释异常被吞并保留已有文本，response.text读取失败则拒绝；无错误体长度上限，也没有完整字段schema校验或自动脱敏。
 */
// 读取一个HTTP错误响应并生成普通/友好文字，Promise返回说明对象，不重试网络。
async function parseErrorResponse(response: Response): Promise<{ message: string; friendlyMessage?: string }> {
	// 完整读响应正文，没有在这里限制诊断长度。
	const raw = await response.text();
	// 先用真值原正文，再状态文字，再固定失败说明，保留空白正文的原真值行为。
	let message = raw || response.statusText || "Request failed";
	// 可选友好配额提示初始缺省。
	let friendlyMessage: string | undefined;

	// 只包JSON解析和字段解释；前面response.text()拒绝仍向上抛。
	try {
		// JSON解析后断言所需形状，没有完整runtime schema验证。
		const parsed = JSON.parse(raw) as {
			// 可选error字段包括码/类型/说明/计划/重置秒时间。
			error?: { code?: string; type?: string; message?: string; plan_type?: string; resets_at?: number };
		};
		// parsed可缺省（null），可选链取error。
		const err = parsed?.error;
		// 只在error真值存在时解释；HTTP429没有error对象也不在此凭空构造友好提示。
		if (err) {
			// code真值优先，再type，再空串，不真实验证候选是string。
			const code = err.code || err.type || "";
			// 已知额度码或status429触发“usage limit”提示，匹配忽略大小写；并非任何429都保证以后可重试。
			if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || response.status === 429) {
				// 有plan_type就调用toLowerCase拼计划名，坏字段类型可抛并由本try吞掉。
				const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
				// resets_at按真值判断，0视为没时间。
				const mins = err.resets_at
					? // 秒时间戳转毫秒再算分钟差，四舍五入并至少0，不是精确倒计时。
						Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
					: // 没真值reset就不写分钟候选。
						undefined;
				// mins为0也会显示Try again in ~0 min，不用真值跳过。
				const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
				// 友好提示只生成文字，不查询账户实际限额或安排自动恢复timer。
				friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
			}
			// 普通message优先error.message，再友好提示，再先前原正文；调用方另优先friendlyMessage。
			message = err.message || friendlyMessage || message;
		}
		// JSON/坏字段解释异常被吞，保留当时已写的说明变量，不把错误响应解析自身再抛出。
	} catch {}

	// 返回两个字段，不写日志/修改账户，friendlyMessage可为undefined。
	return { message, friendlyMessage };
}

// ============================================================================
// Auth & Headers
// ============================================================================

/**
 * 从三段token的第二段atob/JSON中提固定路径chatgpt_account_id，返回原claim或抛统一提取错误，不联网/刷新认证。
 * 例构造假载荷含acc_test也能被本地提取，不证明签名、有效期、实际权限或账号归属。静态返回string，但真实代码只查truthy，不验证claim类型。
 * 解析失败的原cause不保留；这不是JWT验证器，也没有在这里统一所有base64url/Unicode载荷形式。
 */
// 从token字符串载荷提账号claim，返回静态string但运行时只做下面真值检查。
function extractAccountId(token: string): string {
	// 格式、base64/JSON和claim缺失失败统一换同一错误文字。
	try {
		// 按点切token，不验证签名算法或token是否有效。
		const parts = token.split(".");
		// 必须恰三段，段内容没有在这里完整校验。
		if (parts.length !== 3) throw new Error("Invalid token");
		// 直接atob解第二段再JSON.parse；未自行统一base64url字母表/UTF-8文本解码，也不验签。
		const payload = JSON.parse(atob(parts[1]));
		// 只从固定claim路径取chatgpt_account_id，parsed由JSON.parse得到，未作完整对象/字段类型验证。
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		// 缺值/空串/0等假值拒绝；真值非string仍可通过，所以返回签名不是runtime字符串保证。
		if (!accountId) throw new Error("No account ID in token");
		// 返回原claim值，不转换为String或核验账号真实归属。
		return accountId;
		// 任一步解析/取值失败都收拢成相同说明，原cause不保留。
	} catch {
		// 交上层失败流处理，不触发登录/刷新。
		throw new Error("Failed to extract accountId from token");
	}
}

/**
 * 创建Codex共用认证头，输入默认、模型、请求头及账号/token，返回新Headers，无网络。
 * 先默认→模型→请求普通覆盖（null删除），再强制Bearer和chatgpt-account-id；例请求Authorization:"other"最终仍用token。
 * 所以“调用者头最后覆盖”仅适用于未被后续强制设置的字段，SSE/WS包装器还会补自己的协议/id；Headers非法输入可抛。
 */
// 构建SSE/WS共用Headers，默认→模型→请求覆盖后强制认证字段，返回新对象。
function buildBaseCodexHeaders(
	// 默认originator/身份头字典。
	defaultHeaders: Record<string, string>,
	// 模型头可缺省，这层静态只允许字符串。
	initHeaders: Record<string, string> | undefined,
	// 请求级头允许null删除，但下面认证字段仍会补回。
	additionalHeaders: ProviderHeaders | undefined,
	// 已解码账号id，具体真实性不由此函数验证。
	accountId: string,
	// token用于最终Bearer认证值，不从headers中反向解析。
	token: string,
	// 返回标准可变Headers，非法值可在标准API内抛错。
): Headers {
	// Defaults first so model and caller headers can override them, matching the other providers.
	// 以默认头初始化，标准Headers按大小写不敏感处理名称。
	const headers = new Headers(defaultHeaders);
	// 逐模型头覆盖，缺省用空对象。
	for (const [key, value] of Object.entries(initHeaders || {})) {
		// set替换已有同名头。
		headers.set(key, value);
	}
	// 请求头最后覆盖普通默认项，null可删除。
	for (const [key, value] of Object.entries(additionalHeaders || {})) {
		// 只把精确null当删除，空串仍会set。
		if (value === null) {
			// 标准Headers.delete忽略名称大小写。
			headers.delete(key);
			// 其他合法类型是字符串值。
		} else {
			// 请求值覆盖模型/default同名头。
			headers.set(key, value);
		}
	}
	// 认证Bearer最后强制写入，所以模型/请求头无法在此真正覆盖或删除Authorization。
	headers.set("Authorization", `Bearer ${token}`);
	// 账号头也最后强制设置，与token一起优先于普通覆盖层。
	headers.set("chatgpt-account-id", accountId);
	// 返回共同头；SSE/WS包装器还会再覆盖协议/请求id字段。
	return headers;
}

/**
 * 创建SSE请求头，输入三层普通头、账号/token和可选自动会话键，返回新Headers，无网络。
 * 先共同认证，再强制experimental beta/accept/content-type，有真值session则强制两个亲和id头；例无session只是不自动设置，不会删调用者原先显式配置的同名id。
 * 主入口已决定缓存none时不自动提供会话键，压缩成功后还会覆盖content-encoding:zstd；不由这里判断服务端实际命中缓存。
 */
// 在共同头上加SSE协议与可选会话亲和字段，返回新Headers，不发网络。
function buildSSEHeaders(
	// 默认身份头。
	defaultHeaders: Record<string, string>,
	// 模型头来源。
	initHeaders: Record<string, string> | undefined,
	// 请求头来源，null删除规则仍受后续强制字段影响。
	additionalHeaders: ProviderHeaders | undefined,
	// 账号id。
	accountId: string,
	// token。
	token: string,
	// 自动亲和id可省略，此处正常已由上层截到64码点。
	sessionId?: string,
	// 返回标准Headers供fetch使用。
): Headers {
	// 共同认证字段在这里已经最后补回。
	const headers = buildBaseCodexHeaders(defaultHeaders, initHeaders, additionalHeaders, accountId, token);
	// SSE强制experimental beta，覆盖调用者同名配置。
	headers.set("OpenAI-Beta", "responses=experimental");
	// 强制accept为SSE。
	headers.set("accept", "text/event-stream");
	// 强制JSON正文类型，即使之后zstd压缩仍是这个媒体类型。
	headers.set("content-type", "application/json");

	// 只有真值自动会话键才设置下面两项，不传时不会主动删较早显式配置的这两个头。
	if (sessionId) {
		// 会话亲和头。
		headers.set("session-id", sessionId);
		// 同值作客户端请求id，不为每次SSE重试另生成id。
		headers.set("x-client-request-id", sessionId);
	}

	// 返回完整SSE头，压缩成功还会在主入口加content-encoding。
	return headers;
}

/**
 * 创建WS握手头，输入普通三层头、账号/token和必需请求id，返回新Headers，无网络。
 * 先共同认证，删accept/content-type/旧beta，再设WS专用beta与两个请求id；例缓存none仍可用随机UUID作session-id，但不据此登记本地缓存。
 * 标准Headers名称不区分大小写，重复删两种拼写保留原行为；后续转普通字典的名称通常小写，不能把connect里删大写键误解成真正取消beta。
 */
// 构建WS握手头，认证共用但协议/请求id固定，不发网络。
function buildWebSocketHeaders(
	// 默认身份头。
	defaultHeaders: Record<string, string>,
	// 模型头来源。
	initHeaders: Record<string, string> | undefined,
	// 请求级可删除头来源。
	additionalHeaders: ProviderHeaders | undefined,
	// 账号id。
	accountId: string,
	// token。
	token: string,
	// 必需请求id，有会话时截后键，否则UUID；缓存none也仍有WS握手请求标识。
	requestId: string,
	// 返回标准Headers，键枚举通常被正规化为小写。
): Headers {
	// 先按共同优先级建认证/普通头。
	const headers = buildBaseCodexHeaders(defaultHeaders, initHeaders, additionalHeaders, accountId, token);
	// 删除SSE accept，WS不发送该正文协商头。
	headers.delete("accept");
	// 删除SSE JSON content-type。
	headers.delete("content-type");
	// 标准Headers删除beta时本就大小写不敏感。
	headers.delete("OpenAI-Beta");
	// 再用小写重复删除，保留原表达式，不赋予另一套独立头语义。
	headers.delete("openai-beta");
	// 强制设置WS专用beta版本，不沿用SSE experimental值。
	headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
	// 请求id强制覆盖更早配置值。
	headers.set("x-client-request-id", requestId);
	// 同id作为session-id；不代表一定启用本地会话缓存或delta续传。
	headers.set("session-id", requestId);
	// 返回WS握手头，connect层转普通对象不保证会删掉小写beta。
	return headers;
}
