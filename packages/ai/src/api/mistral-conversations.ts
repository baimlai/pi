// Mistral 原生聊天适配器：手写 HTTP/SSE 传输、历史与工具 schema 转换，把生成过程组装为 Pi 统一事件流。
// 按本地模型价格估算费用，并把公共思考档位钳制到模型声明的能力。
import { calculateCost, clampThinkingLevel } from "../models.ts";
// import type 的整个分组只用于编译检查，不产生运行时对象。
import type {
	// 统一 assistant 输出含内容、用量和停止状态。
	AssistantMessage,
	// 多种会话角色组成的消息联合类型。
	Message,
	// Model 泛型关联模型与 API 协议。
	Model,
	// 简化请求通过公共 reasoning 表达思考，而不是 Mistral 原生字段。
	SimpleStreamOptions,
	// stop/length/toolUse/error 等统一停止状态。
	StopReason,
	// 关联 API、选项与事件流返回值的函数类型。
	StreamFunction,
	// 各 API 共用的请求头、钩子、信号和采样选项。
	StreamOptions,
	// 普通文字块类型。
	TextContent,
	// 思考文字块类型，不等于普通可见回答。
	ThinkingContent,
	// 工具声明包含参数 schema，不是一次工具执行。
	Tool,
	// 模型请求执行工具的数据块。
	ToolCall,
	// 系统规则与工具变更都在 messages 中的规范会话。
	TranscriptContext,
} from "../types.ts";
// 合并用户取消与请求头超时信号；具体清理行为取决于有效来源数量。
import { combineAbortSignals } from "../utils/abort-signals.ts";
// 截短错误正文的展示文字，不阻止之前完整读取 HTTP 错误正文。
import { truncateErrorText } from "../utils/error-body.ts";
// Pi 的事件通道与下面自有 SSE 异步生成器分开。
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
// 快速确定性短散列辅助，不保证无碰撞或密码学安全。
import { shortHash } from "../utils/hash.ts";
// 标准 Headers 转普通字典，供 onResponse 元数据钩子读取。
import { headersToRecord } from "../utils/headers.ts";
// 默认 User-Agent 和适用的供应商归因头。
import { getIdentityHeaders } from "../utils/identity.ts";
// 清除孤立 UTF-16 代理码元，保留合法成对字符。
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
// 每条工具调用独立累计 JSON 参数，预览容错，结束时完整解析。
import { ToolCallArgumentsStream } from "../utils/streaming-json.ts";
// 首条 system 渲染正文/sections，中途 system 可渲染为更新说明。
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
// 工具变更重放，以及按能力保留或折叠中途系统消息。
import { getCurrentTools, resolveTranscript } from "../utils/transcript.ts";
// 决定 JSON Schema 严格采样并取得相应参数副本，不执行实际工具实参验证。
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";
// 简化选项转公共配置，按上下文估算限制输出上限。
import { buildBaseOptions } from "./simple-options.ts";
// 修正跨模型历史、工具调用/结果配对和图片等，不发模型请求。
import { transformMessages } from "./transform-messages.ts";

// 候选工具 id 最多截到9个ASCII字母数字；散列结果本身不在此补足短长度。
const MISTRAL_TOOL_CALL_ID_LENGTH = 9;
// 错误展示最多保留4000个UTF-16代码单元的正文前缀，再加省略说明，不是网络读取上限。
const MAX_MISTRAL_ERROR_BODY_CHARS = 4000;

/**
 * Provider-specific options for the Mistral API.
 */
// 本地 effort 字符串联合；none 表示原生关闭档位，和公共 reasoning 的 off 是两套名称。
type MistralReasoningEffort = "none" | "low" | "medium" | "high" | "max";

// 继承公共流选项再增加 Mistral 原生字段；interface 不在运行时验证对象。
export interface MistralOptions extends StreamOptions {
	// 可自动/禁用/强制任意工具，也可用嵌套对象指定函数名；? 允许省略。
	toolChoice?: "auto" | "none" | "any" | "required" | { type: "function"; function: { name: string } };
	// 旧思考协议只允许字面量 reasoning，缺省则不主动发送 prompt_mode。
	promptMode?: "reasoning";
	// 原生 effort 可选，后面有映射表时采用此方式。
	reasoningEffort?: MistralReasoningEffort;
}

// 内容块的标签联合，内存字段先用驼峰，真正 HTTP 发送前再改下划线形式。
type MistralContentChunk =
	// 普通文字块只有 text 正文。
	| { type: "text"; text: string }
	// 图片是 image_url，imageUrl 内放数据 URL 等字符串。
	| { type: "image_url"; imageUrl: string }
	// 思考块内部是一个文字片段数组；Array<T> 与 T[] 都表示数组类型。
	| { type: "thinking"; thinking: Array<{ type: "text"; text: string }> };

// 发回历史的函数调用记录形状，arguments 在协议里是 JSON 字符串。
type MistralRequestToolCall = {
	// 工具 id 用于把随后 tool 结果关联回来。
	id: string;
	// 字面量 function 表明工具类型，不是 JS 函数值。
	type: "function";
	// 函数名与序列化后的参数同放在 function 属性里。
	function: { name: string; arguments: string };
	// 历史构建器本地固定 index=0；这里不据它安排真实工具执行。
	index: number;
};

// 内部待发送消息形状，部分字段可省略。
type MistralChatMessage = {
	// 四个角色都用 string 字面量约束，system/tool 不改成 user。
	role: "system" | "user" | "assistant" | "tool";
	// 内容可为直接字符串或结构化块数组，工具调用消息可没有 content。
	content?: string | MistralContentChunk[];
	// assistant 可附多项函数调用。
	toolCalls?: MistralRequestToolCall[];
	// tool 消息关联调用 id，发送时改成 tool_call_id。
	toolCallId?: string;
	// tool 消息可带工具名。
	name?: string;
	// assistant 历史显式 prefix:false，不把它当让模型续写的前缀。
	prefix?: boolean;
};

// 工具声明形状，不含实际 execute 回调。
type MistralFunctionTool = {
	// 协议工具类型为 function。
	type: "function";
	// 名称、说明、schema 与 strict 放进 function 对象。
	function: {
		// 工具原名。
		name: string;
		// 给模型的用途说明，保持原文。
		description: string;
		// schema 是未知字段字典；Record 不证明它在运行时是合法 JSON Schema。
		parameters: Record<string, unknown>;
		// 每个声明显式发送 strict 布尔值，非严格路径使用 false。
		strict: boolean;
	};
};

// 内存请求体类型；字段采用 SDK 风格驼峰，但本文件没有使用 Mistral SDK。
type MistralChatPayload = {
	// 索引签名允许钩子追加任意值，字段内容仍需真实服务端接受。
	[key: string]: unknown;
	// 目标模型 id。
	model: string;
	// 请求流式响应的开关；构建器初值 true，钩子可改，后面不强制恢复。
	stream: boolean;
	// 已转换的系统、用户、assistant、工具结果消息。
	messages: MistralChatMessage[];
	// 可选工具声明数组，不是工具执行列表。
	tools?: MistralFunctionTool[];
	// 可选采样温度，0 也可显式传入。
	temperature?: number;
	// 可选输出 token 上限，HTTP 发送时变 max_tokens。
	maxTokens?: number;
	// 索引访问取工具选择类型，Exclude 在编译期排除 undefined，不插运行时检查。
	toolChoice?: Exclude<MistralOptions["toolChoice"], undefined>;
	// 可选旧思考模式，发送前变 prompt_mode。
	promptMode?: "reasoning";
	// 可选新 effort 档位，发送前变 reasoning_effort。
	reasoningEffort?: MistralReasoningEffort;
	// 本地从 sessionId 推导的缓存键，发送前变 prompt_cache_key，不保证缓存命中。
	promptCacheKey?: string;
};

// SSE JSON 中的内容片段仅声明当前消费所需的宽松字段。
type MistralStreamContentChunk = {
	// type 为普通 string，因此未知类型可在消费时被忽略。
	type: string;
	// 文字片段可缺省，消费层回退空串。
	text?: string;
	// 思考可由多段文字组成，每段 text 也可缺省。
	thinking?: Array<{ text?: string }>;
};

// SSE 中一次工具调用的增量，不同事件可携带同一 index。
type MistralStreamToolCall = {
	// 调用 id 可缺省，后面按 index 派生回退值。
	id?: string;
	// 可选 index 是增量合并优先使用的键，0 不能被当成缺省。
	index?: number;
	// 静态声明 function 存在，但入站 JSON 没有完整校验这个结构。
	function: {
		// 以新调用首片的 name 建块，后续片段不会在消费器里补改名字。
		name: string;
		// 参数可为增量字符串或对象；对象会先 JSON.stringify 再追加，不代表替换累积全文。
		arguments: string | Record<string, unknown>;
	};
};

// 本地 SSE 生成器在解析 JSON 外再包一层 data，供消费函数统一取值。
type MistralCompletionEvent = {
	// data 保存解析后的响应对象，不是原始 SSE 文本。
	data: {
		// 响应 id 可缺省，保留流里首个真值。
		id?: string;
		// usage 可省略，存在时更新当前累计统计。
		usage?: {
			// 允许缓存统计等扩展字段，稍后在 unknown 边界挑选/检查。
			[key: string]: unknown;
			// 服务端输入 token 总数。
			prompt_tokens?: number;
			// 服务端输出 token 总数，本文件不另拆思考 token。
			completion_tokens?: number;
			// 服务端总 token 数，真值时直接采用。
			total_tokens?: number;
		};
		// 候选数组；解析只验证它是数组，不完整验证每项的 delta/字段。
		choices: Array<{
			// 停止原因可缺省或 null；当前消费器仅在真值时调用映射。
			finish_reason?: string | null;
			// 每个候选的增量数据。
			delta: {
				// 正文可为字符串、结构块数组或 null。
				content?: string | MistralStreamContentChunk[] | null;
				// 工具参数增量数组可缺省或 null。
				tool_calls?: MistralStreamToolCall[] | null;
			};
		}>;
	};
};

/**
 * Stream responses from the native Mistral Chat Completions endpoint.
 */
/**
 * 调用 Mistral 原生 Chat Completions，同步返回 Pi 事件流；输入模型、完整历史与原生选项。
 * 先按能力处理 system、转换历史/id、生成 payload/等待钩子，再手写 fetch/SSE 解析并消费正文、工具参数和用量，最后发布 done/error。
 * 会发网络、等待观察钩子并修改本轮消息，不执行工具；例两片 {"path": 与 "a"} 合到同一工具参数预览，流结束再完整解析。
 * 本文件无自动请求重试；内部错误通常转失败流，前置历史处理仍可同步抛错。请求头超时的清理有单信号分支，不能据原英语注释一概认为长响应正文绝不受超时影响。
 */
// 泛型把本入口静态绑定 Mistral 原生选项；网络由本文件 fetch 发出。
export const stream: StreamFunction<"mistral-conversations", MistralOptions> = (
	// 模型提供协议、端点、能力和计价元数据。
	model: Model<"mistral-conversations">,
	// 输入完整规范历史，不只是最后一条 query。
	context: TranscriptContext,
	// 原生请求选项可整体省略。
	options?: MistralOptions,
	// 箭头入口同步返回 Pi 流；内部任务异步推进。
): AssistantMessageEventStream => {
	// 建立统一事件通道，消费者不必先等 HTTP。
	const stream = new AssistantMessageEventStream();
	// supportsMidConvoSystemMessages 真值时保留中途 system，否则折叠；此同步过程在下方 try 之外。
	const normalizedContext = resolveTranscript(context, model.compat?.supportsMidConvoSystemMessages);

	/**
	 * 立即运行本轮异步工作，闭包使用外部模型/选项/通道，外层不返回该 Promise。
	 * 通常成功发 done、失败保留 partial 并发 error；例 JSON 解析失败不会自动重发已经发布的正文，错误格式化再次失败也没有第二层 catch。
	 */
	// 立即调用 async 闭包，Promise 不交给外层返回，通常通过流写终态。
	(async () => {
		// 建立本轮共享 output，各 partial 复用其可变引用。
		const output = createOutput(model);

		// 认证检查、历史转换、钩子、HTTP 和消费失败进入这一层 catch。
		try {
			// 只读显式 options.apiKey，不在本入口解析环境或凭证库，也不 trim。
			const apiKey = options?.apiKey;
			// 空串或缺值视为没 key；非空纯空白仍通过此检查。
			if (!apiKey) {
				// 这里的错误在内部任务里转失败流；简化入口另有同步 key 检查。
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			// 每次请求新建 id 映射闭包，跨模型历史规范化时检查并处理本批候选冲突。
			const normalizeMistralToolCallId = createMistralToolCallIdNormalizer();
			/**
			 * 为跨模型历史的工具调用规范化 id，输入共享转换器提供的原 id，返回本轮候选值，无网络。
			 * 共享转换器只在跨 provider/api/model 时调用，例同模型旧下划线 id 不会在这里统一清洗；调用后的结果 id 由共享转换同步替换。
			 */
			// 共享历史转换器只在来源 provider/api/model 不同的工具调用上使用本回调，不一律改同模型历史 id。
			const transformedMessages = transformMessages(normalizedContext.messages, model, (id) =>
				// 把 id 交本轮规范化闭包，回调结果也供后面的工具结果关联。
				normalizeMistralToolCallId(id),
			);

			// 用规范系统/当前工具与转换后的消息生成请求，let 允许随后替换 payload。
			let payload = buildChatPayload(model, normalizedContext, transformedMessages, options);
			// 等待可选正文钩子；可原地修改、返回替换对象或抛错终止。
			const nextPayload = await options?.onPayload?.(payload, model);
			// 返回非 undefined 才替换；undefined 保留原对象及钩子的原地修改。
			if (nextPayload !== undefined) {
				// as 只影响 TS，不验证或修复返回结构，也不强制把 stream 改回 true。
				payload = nextPayload as MistralChatPayload;
			}
			// 发一次原生 HTTP 请求并拿到 SSE 生成器；本文件不实现 maxRetries 重试循环。
			const mistralStream = await requestMistralStream(model, payload, apiKey, options);
			// HTTP 成功/有正文后才发 start；此时还没读到第一条 SSE 内容。
			stream.push({ type: "start", partial: output });
			// 等待全部消费/工具参数最终解析完成；原始事件观察钩子在消费器里逐次等待。
			await consumeChatStream(model, output, stream, mistralStream, options?.onProviderStreamEvent);

			// 消费结束后再确认用户取消，防止取消时把已有 finishReason 当成功。
			if (options?.signal?.aborted) {
				// 抛入外层失败路径，不表示远端副作用/费用已撤销。
				throw new Error("Request was aborted");
			}

			// 没有收到真值 finish_reason 时不把流结束当成功。
			if (output.stopReason === "pending") {
				// 即使已有文字/工具也失败；没有在此凭空补 stop。
				throw new Error("Mistral stream ended without a finish reason");
			}
			// error/aborted 终态不发送 done。
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				// 有具体 provider 错误说明则保留，否则采用固定兜底。
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			// 发统一成功终态，length/toolUse 仍可能需要上层继续处理。
			stream.push({ type: "done", reason: output.stopReason, message: output });
			// 关闭本地消息事件流。
			stream.end();
			// 捕获 try 内失败，之前已发布的部分内容不会回滚。
		} catch (error) {
			// 捕获时用户信号已取消则优先标 aborted，其他失败标 error。
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			// HTTP 错误可带截断正文/状态；格式化自身若因恶意对象等再抛错，没有第二层 catch。
			output.errorMessage = formatMistralError(error);
			// 发布失败消息，保留已知内容/用量，不主动补所有未结束块。
			stream.push({ type: "error", reason: output.stopReason, error: output });
			// 关闭失败通道，前面错误处理再次失败则到不了这里。
			stream.end();
		}
		// 立即执行闭包，外层不等待该 Promise。
	})();

	// 将通道交调用者，可 for await 读事件及 await result() 取最终消息。
	return stream;
};

/**
 * Maps provider-agnostic `SimpleStreamOptions` to Mistral options.
 */
/**
 * 将公共简化选项转 Mistral 原生思考配置，再调用 stream 返回事件流；输入模型/历史/公共选项。
 * 先同步要求 key、建公共配置、钳制请求档位，再选择映射表的 reasoningEffort 或无表模型的 promptMode。
 * 例映射 off="none" 且省略 reasoning 时发送 reasoning_effort:none；无表的思考模型请求 medium 则发送 prompt_mode:reasoning。
 * 不会验证任意映射字符串是否为原生五档；同步配置错误可直接抛，真正网络和消息事件交原生入口。
 */
// 简化入口将公共思考档位转换为 Mistral 原生配置，最后调用 stream。
export const streamSimple: StreamFunction<"mistral-conversations", SimpleStreamOptions> = (
	// 模型泛型维持 Mistral API 约束。
	model: Model<"mistral-conversations">,
	// 传完整规范会话，原生入口再按能力处理 system。
	context: TranscriptContext,
	// 公共配置不直接声明 Mistral promptMode/reasoningEffort。
	options?: SimpleStreamOptions,
	// 该入口本身同步；key/预算/档位解析异常可直接抛给调用者。
): AssistantMessageEventStream => {
	// 只取显式 key，没有自动从环境查找。
	const apiKey = options?.apiKey;
	// 在调用 stream 前先同步检查缺 key。
	if (!apiKey) {
		// 此时尚未创建本入口的生成流，所以不是 error 事件。
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	// 构造基础配置，不修改调用者选项。
	const base = {
		// 公共 helper 合并采样选项、按上下文估值钳制输出并透传指定字段。
		...buildBaseOptions(model, context, options, apiKey),
		// 单独保留公共 toolChoice，基础 helper 不自动复制它。
		toolChoice: options?.toolChoice,
		// satisfies 做编译期结构检查，不生成运行时验证。
	} satisfies MistralOptions;
	// 请求 reasoning 才按模型能力钳制；省略则保持 undefined，不在这行主动钳制 off。
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	// 钳制后的 off 转回 undefined，作为没有启用请求档位。
	const reasoning = clampedReasoning === "off" ? undefined : clampedReasoning;
	// Models with a thinking level map use `reasoning_effort`; other reasoning models use `prompt_mode`.
	// 仅 reasoning 模型读取映射表；空对象也是真值，会选择 effort 路径。
	const effortMap = model.reasoning ? model.thinkingLevelMap : undefined;
	// 有映射表和没有映射表用不同协议，不按模型名字猜。
	const reasoningEffort = effortMap
		? // 有表时再看是否请求了有效非 off 档位。
			reasoning
			? // 请求档位的映射 null/undefined 回退 high，其他字符串原样保留，不做原生档位白名单校验。
				(effortMap[reasoning] ?? "high")
			: // 未请求档位用表里 off；null/undefined 变 undefined，但字符串 none 可发送。
				(effortMap.off ?? undefined)
		: // 无表就不生成 effort，旧 promptMode 分支在下面决定。
			undefined;

	// 交原生入口发请求，本函数不直接解析 SSE。
	return stream(model, context, {
		// 先展开基础选项。
		...base,
		// 模型有 reasoning、没有映射表、并请求思考时才发送旧 promptMode:reasoning。
		promptMode: model.reasoning && !effortMap && reasoning ? "reasoning" : undefined,
		// 类型断言不证明映射字符串真属于原生五档，运行时仍按上面计算值传递。
		reasoningEffort: reasoningEffort as MistralReasoningEffort | undefined,
		// 仅检查最终静态配置兼容，不能保证远端模型接受。
	} satisfies MistralOptions);
};

/**
 * 为本轮新建空 assistant 输出，输入模型，返回独立顶层对象/内容数组/用量费用容器，无网络或输入修改。
 * 例 model.id="mistral-large-latest" 就作为回复身份记录，初态 pending，收到流后再累积内容与终态。
 */
// 初始化统一输出，纯对象构造，不调用模型/修改输入。
function createOutput(model: Model<"mistral-conversations">): AssistantMessage {
	// 返回新顶层对象及新内容/费用容器。
	return {
		// 角色为 assistant。
		role: "assistant",
		// 内容初始为空，后续增量追加。
		content: [],
		// 记录请求模型声明的 API。
		api: model.api,
		// 记录请求 provider。
		provider: model.provider,
		// 记录请求模型 id，不按响应 model 字段换身份/价格。
		model: model.id,
		// 用量初始全零。
		usage: {
			// 非缓存输入 token 初始零。
			input: 0,
			// 输出 token 初始零。
			output: 0,
			// 缓存读取初始零。
			cacheRead: 0,
			// 缓存写入本适配器保持零。
			cacheWrite: 0,
			// 总 token 初始零。
			totalTokens: 0,
			// 新费用对象等待 calculateCost 按使用量填入。
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		// pending 标明尚无有效结束原因。
		stopReason: "pending",
		// 本地毫秒时间，不是服务器创建时间。
		timestamp: Date.now(),
	};
}

/**
 * 创建本轮工具 id 规范化函数，返回闭包；闭包持有正反两张 Map，无全局/磁盘修改。
 * 首次按清理/散列生成候选，已分配则复用，候选属于另一真值原 id 时增加种子次数重试；例 a-b 与 ab 清理同名后可由碰撞流程区分。
 * 不设最大碰撞尝试或跨请求唯一保证；这个函数只是历史转换的回调，不负责给所有新响应统一验证 id。
 */
// 新建返回值为 (id:string)=>string 的闭包，每次调用工厂得到独立映射状态。
function createMistralToolCallIdNormalizer(): (id: string) => string {
	// 原始 id→已选候选，避免同一原 id 重算。
	const idMap = new Map<string, string>();
	// 候选→原始所有者，用于识别不同原 id 的本地候选碰撞。
	const reverseMap = new Map<string, string>();

	/**
	 * 为一个原 id 找本轮可复用且未被其他真值原 id 占用的候选，返回字符串，更新两张闭包 Map。
	 * 例同一个长 id 调两次复用第一次结果；不同 id 撞到候选则逐次换散列种子，未设固定重试上限。
	 */
	// 返回内部规范化函数，闭包持有两张 Map，不写全局缓存。
	return (id: string): string => {
		// 先查本轮原 id 是否已经分配过。
		const existing = idMap.get(id);
		// 真值缓存命中直接复用，使调用/结果稳定关联。
		if (existing) return existing;

		// 本次从第0个散列尝试开始。
		let attempt = 0;
		// 没有最大次数；碰撞就换种子继续，不能宣称固定次数内必成功。
		while (true) {
			// 从原 id 与尝试次数算一个候选。
			const candidate = deriveMistralToolCallId(id, attempt);
			// 看此候选是否已分配给其他原 id。
			const owner = reverseMap.get(candidate);
			// 没所有者或属于本 id 才接受；本闭包正常保存的原 id 也可能是空串，所以这里沿用原有真值规则。
			if (!owner || owner === id) {
				// 记录正向映射。
				idMap.set(id, candidate);
				// 同时记录反向归属，供下一个原 id 检查。
				reverseMap.set(candidate, id);
				// 返回本次可用候选。
				return candidate;
			}
			// 遇冲突递增次数，下一轮把次数加进散列种子。
			attempt++;
		}
	};
}

/**
 * 按原 id 和尝试次数计算候选 id，返回字符串，无修改/网络。
 * 先删非ASCII字母数字，首次恰9字符直接用，否则散列种子并最多取9字符；例 a-b-c123456 可清理成 abc123456。
 * 单函数不检测冲突/补足长度，冲突由外层规范化闭包处理；shortHash 是快速散列而非随机或密码学证明。
 */
// 从 id 与非负尝试数派生一个候选，纯计算；是否冲突由外层 Map 判断。
function deriveMistralToolCallId(id: string, attempt: number): string {
	// 移除一切非 ASCII 字母数字字符，不保留下划线/横线。
	const normalized = id.replace(/[^a-zA-Z0-9]/g, "");
	// 首次且清理后恰好9字符直接用清理结果；不同原名可冲突，外层再处理。
	if (attempt === 0 && normalized.length === MISTRAL_TOOL_CALL_ID_LENGTH) return normalized;
	// 清理结果非空就作为种子基底，否则回用原 id。
	const seedBase = normalized || id;
	// 首次直接用基底，碰撞尝试加冒号和数字改变种子。
	const seed = attempt === 0 ? seedBase : `${seedBase}:${attempt}`;
	// 生成确定性短散列，不是随机 id 或无碰撞保证。
	return (
		shortHash(seed)
			// 再筛 ASCII 字母数字，保留既有转换流程。
			.replace(/[^a-zA-Z0-9]/g, "")
			// 最多取前9个UTF-16码元，此处不补短结果。
			.slice(0, MISTRAL_TOOL_CALL_ID_LENGTH)
	);
}

/**
 * 把未知失败转换为可展示的 Mistral 错误文字，无 I/O；数字 statusCode 与非空字符串 body 优先，其次 Error.message，再 JSON/String 兜底。
 * 例 statusCode:403/body:" denied " 得到 Mistral API error (403): denied；正文超过4000代码单元会截前缀并附说明。
 * 不对消息作脱敏；异常对象自身的属性访问/转换仍可能抛错，不能把名字当作绝对不会失败的保证。
 */
// 将未知异常格式化成说明文字，不发网络、不写日志。
function formatMistralError(error: unknown): string {
	// 先区分 Error 实例与任意 throw 值。
	if (error instanceof Error) {
		// 交叉类型允许看可选 HTTP 字段；真实值仍按下两行检查。
		const httpError = error as Error & { statusCode?: unknown; body?: unknown };
		// 只接收 number 状态码，不判断是否整数/合法 HTTP 范围。
		const statusCode = typeof httpError.statusCode === "number" ? httpError.statusCode : undefined;
		// 字符串正文才 trim，两端空白被删，非字符串正文忽略。
		const bodyText = typeof httpError.body === "string" ? httpError.body.trim() : undefined;
		// 同时有数字状态和非空正文时，优先显示正文。
		if (statusCode !== undefined && bodyText) {
			// 截断正文后加供应商/状态前缀；仅限制诊断长度，前面网络层已完整读正文。
			return `Mistral API error (${statusCode}): ${truncateErrorText(bodyText, MAX_MISTRAL_ERROR_BODY_CHARS)}`;
		}
		// 没可用正文但有状态时显示 Error.message，不再尝试消费其他响应流。
		if (statusCode !== undefined) return `Mistral API error (${statusCode}): ${error.message}`;
		// 一般 Error 直接取 message。
		return error.message;
	}
	// 非 Error 走下面的 JSON/String 兜底。
	return safeJsonStringify(error);
}

/**
 * 将任意 throw 值转成文字，返回 JSON 字符串或 String 兜底，不修改输入。
 * 例循环对象 JSON 化失败后通常得到 [object Object]；undefined 得到 "undefined"。String 自身若抛错仍会向外传播，没有无限兜底。
 */
// 任意值优先转 JSON，失败回退 String，通常能返回文字；恶意自定义转换仍可抛错。
function safeJsonStringify(value: unknown): string {
	// 捕获 JSON.stringify 本身的异常，如循环引用/BigInt。
	try {
		// 尝试 JSON 化，字符串会带 JSON 引号。
		const serialized = JSON.stringify(value);
		// JSON 无返回值（如 undefined）则 String(value)，不让返回类型变成 undefined。
		return serialized === undefined ? String(value) : serialized;
		// 序列化失败才走这个兜底。
	} catch {
		// String 可能调用外部对象自己的转换逻辑，这里没有再次 catch。
		return String(value);
	}
}

/**
 * 发一次原生 HTTP 请求，输入模型基础地址、内存 payload、key 与选项，返回解析 SSE 的异步迭代器。
 * 流程为拼 URL/头→建立头超时与用户取消信号→fetch→清理中转监听→等待 onResponse→非2xx完整读正文报错/成功要求 body→返回生成器。
 * 例自定义 fetch 可返回内存 Response 测试整个流；本函数不执行 maxRetries 循环，也不强制钩子修改后的 stream:true。
 * 原超时信号不会被 cleanup 取消；无用户 signal 时 helper 直接把该信号交 fetch，所以不能保证长正文不受该超时影响。请求/钩子/正文错误向上拒绝。
 */
// 发单次 Mistral HTTP 并返回 SSE 异步迭代器，没有内部自动重试。
async function requestMistralStream(
	// 模型给完整基础 URL，不在这里选择默认官方地址。
	model: Model<"mistral-conversations">,
	// 内存驼峰 payload，发送前转 wire 下划线字段。
	payload: MistralChatPayload,
	// key 由公开入口做真值检查，头覆盖仍可替换/删除实际 authorization。
	apiKey: string,
	// 可选自定义 fetch、头、信号、超时与响应钩子。
	options?: MistralOptions,
	// Promise 先解析为可遍历对象，具体 SSE 读取在调用方 for await 时发生。
): Promise<AsyncIterable<MistralCompletionEvent>> {
	// 用绝对 URL 解析模型地址，不合法时立即抛错。
	const baseUrl = new URL(model.baseUrl);
	// pathname 去所有末尾斜线再补一个斜线，确保下方相对路径追加而非替换最后一段。
	baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/u, "")}/`;
	// 在基础路径后加 v1/chat/completions；若自定义基础路径已经有 v1，也不会在此去重。
	const url = new URL("v1/chat/completions", baseUrl);
	// 生成标准 Headers，支持大小写不敏感的显式覆盖与缓存亲和头策略。
	const headers = buildMistralHeaders(model, apiKey, options);
	// The timeout covers only the wait for response headers. Long streams (e.g. extended thinking)
	// must not be cut off by a fixed deadline; body stalls are left to the HTTP client idle timeout.
	// ?? 只在未给 timeoutMs 时用60000；显式0保留，负数/越界值可被 AbortSignal.timeout 拒绝。
	const timeoutMs = options?.timeoutMs ?? 60_000;
	// 创建仍会自行到期的信号；cleanup 不会取消这个超时信号本身的计时。
	const headerTimeoutSignal = AbortSignal.timeout(timeoutMs);
	// 两来源时建立中转控制器；只有头超时这一个来源时 helper 直接复用它，cleanup 是空操作。
	const combinedSignal = combineAbortSignals([options?.signal, headerTimeoutSignal]);
	// 先声明响应，真正赋值在 try 中的 fetch。
	let response: Response;
	// 捕获 fetch/序列化等阶段错误，把头等待超时换成更明确文字。
	try {
		// 优先本次 fetch，否则用当前全局 fetch；本适配器支持请求级自定义函数。
		response = await (options?.fetch ?? globalThis.fetch)(url, {
			// HTTP 方法为 POST。
			method: "POST",
			// 使用已合并的 Headers 对象。
			headers,
			// 先把已知驼峰键/消息结构转 HTTP 形状，再整体 JSON 化；这一步也可抛错。
			body: JSON.stringify(toMistralWirePayload(payload)),
			// 将合成信号交 fetch，用于等待请求头；无用户信号时它是原超时信号，响应正文可能仍受其后续取消影响。
			signal: combinedSignal.signal,
		});
		// 捕获发起请求阶段失败，不包括后面的 onResponse、错误正文或 SSE 消费。
	} catch (error) {
		// 头超时信号已触发且用户未取消时，用头超时错误覆盖原异常；不在此核验原失败真的由计时导致。
		if (headerTimeoutSignal.aborted && !options?.signal?.aborted) {
			// 输出具体等待时限，交外层失败流格式化。
			throw new Error(`Mistral response headers timed out after ${timeoutMs}ms`);
		}
		// 其余原异常重抛，保留用户取消等原因。
		throw error;
		// fetch 无论成功失败都执行清理动作。
	} finally {
		// 有两个来源时解除中转监听；单来源 helper 只是复用超时信号，无法据此保证长正文不再被超时取消。
		combinedSignal.cleanup();
	}

	// HTTP 一返回就等待 onResponse，含非2xx；传普通头字典而非可消费正文，钩子抛错会中止后续处理。
	await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

	// 非2xx 先取完整错误正文，不尝试把它当 SSE。
	if (!response.ok) {
		// response.text() 完整读取后才在格式化层截诊断，读取本身并没有4000字符上限。
		const body = await response.text();
		// 抛本地 HTTP 错误，保存状态、正文与 statusText 供外层展示。
		throw new MistralHttpError(response.status, body, response.statusText);
	}
	// 成功状态也要求正文流存在。
	if (!response.body) {
		// 没正文报错，不创建一个虚构的空成功流。
		throw new Error("Mistral response has no body");
	}

	// 返回生成器对象，此时未调用 getReader；消费时用用户信号监听取消，不把头超时信号作为显式读取参数。
	return readMistralEvents(response.body, options?.signal);
}

// 自定义 Error 子类保留 HTTP 原始信息供格式化，不代表服务端业务错误已有统一 schema。
class MistralHttpError extends Error {
	// 显式字段声明配合构造器赋值，使用可擦除 TS 语法，不是参数属性。
	statusCode: number;
	// 保存完整正文字符串，展示层稍后才截断。
	body: string;

	/**
	 * 新建保留原始状态和正文的 HTTP 错误，输入已读取的响应信息，无网络/文件副作用。
	 * 例状态403、statusText="Forbidden" 时 Error.message 先为 Forbidden，格式化函数随后可优先显示正文。
	 */
	// 构造器接状态、已读取正文和 HTTP 状态文字。
	constructor(statusCode: number, body: string, statusText: string) {
		// super 初始化 Error.message；空状态文字时采用带数字的回退。
		super(statusText || `Request failed with status ${statusCode}`);
		// 错误名标记为本地 MistralHttpError。
		this.name = "MistralHttpError";
		// 保存数字状态码，不在这里判断可重试性。
		this.statusCode = statusCode;
		// 保留原始正文，包括可能超出展示预算的部分。
		this.body = body;
	}
}

/**
 * 按身份/默认协议头→模型覆盖→请求覆盖创建 Headers，返回新对象，不发网络。
 * 有 sessionId 且缓存不是 none 时自动补 x-affinity，但任何来源显式出现该名称（包括 null）都阻止补回；例 null 可明确抑制自动亲和头。
 * 认证头也能被覆盖或删除，Headers 对非法名称/值可抛错；设置亲和头不是缓存命中/保密隔离保证。
 */
// 建新的标准 Headers，参数是模型/key/请求选项；后来的覆盖可影响认证与亲和头。
function buildMistralHeaders(model: Model<"mistral-conversations">, apiKey: string, options?: MistralOptions): Headers {
	// 初始化默认请求头，后面再应用两级覆盖。
	const headers = new Headers({
		// 身份头包含 User-Agent/适用归因，不是认证凭证。
		...getIdentityHeaders(model, options?.identity),
		// 接受 SSE 流响应。
		accept: "text/event-stream",
		// 默认使用 Bearer key，但模型/请求头可覆盖或删除它。
		authorization: `Bearer ${apiKey}`,
		// 请求正文按 JSON 发送。
		"content-type": "application/json",
	});
	// 模型头覆盖默认项，null 表示删除。
	applyMistralHeaderOverrides(headers, model.headers);
	// 本次请求头最后覆盖，名称由标准 Headers 忽略大小写处理。
	applyMistralHeaderOverrides(headers, options?.headers);

	// 先判断是否有人显式配置了 x-affinity，值为 null 也算显式意图。
	const hasExplicitAffinity =
		// 两层来源任一出现该名称都阻止自动补亲和头，避免覆盖用户显式删除。
		hasMistralHeaderOverride(model.headers, "x-affinity") || hasMistralHeaderOverride(options?.headers, "x-affinity");
	// 有缓存意图与非空 sessionId 且无人显式配置亲和头时才自动补。
	if (shouldUsePromptCaching(options) && !hasExplicitAffinity) {
		// 类型谓词已把 options/sessionId 收窄为存在；仅设置路由/亲和头，不保证服务端缓存命中。
		headers.set("x-affinity", options.sessionId);
	}

	// 返回可变 Headers 对象供 fetch 使用。
	return headers;
}

/**
 * 把一层可选头覆盖原地应用到 Headers，返回 void，无网络；例 {Authorization:null} 删除认证头。
 * 遍历字符串键，null 删除，其余 set；后调用者覆盖前层，非法头名称/值由标准 Headers 抛错。
 */
// 原地应用可选头字典，返回 void；null 删除，字符串设置。
function applyMistralHeaderOverrides(headers: Headers, overrides?: Record<string, string | null>): void {
	// 没给覆盖字典就直接结束，不改现有头。
	if (!overrides) return;
	// 遍历自有可枚举字符串键值，解构得到名称/值。
	for (const [name, value] of Object.entries(overrides)) {
		// null 精确表达删除；标准 Headers 按名字大小写不敏感删除。
		if (value === null) headers.delete(name);
		// 其他合法类型是 string，set 替换旧值；非法名称/值仍可被 Headers 拒绝。
		else headers.set(name, value);
	}
}

/**
 * 按大小写不敏感名称判断某层是否显式配置了头，输入可选字典和已小写目标，返回 boolean，无修改。
 * 例 {"X-Affinity":null} 对 x-affinity 为 true；只看键存在，不以 null/空串推断没有配置。
 */
// 判断某层是否出现指定名称，不修改输入；target 由调用方传小写。
function hasMistralHeaderOverride(overrides: Record<string, string | null> | undefined, target: string): boolean {
	/**
	 * some 回调只把一个候选头名转小写与 target 比较，返回布尔值，无修改；例 X-Affinity 命中 x-affinity。
	 */
	// !! 先转布尔并短路，some 忽略大小写比较键名，不看值，所以 null 也会命中。
	return !!overrides && Object.keys(overrides).some((name) => name.toLowerCase() === target);
}

/**
 * 将驼峰内存 payload 转为 HTTP wire 形状，返回新顶层/相关包装对象，不发网络、不改原顶层输入。
 * 先按固定表搬顶层键，再转每条消息，最后只处理 response_format 中 jsonSchema/schemaDefinition 两层；例 maxTokens→max_tokens，业务 schema 内 maxTokens 属性不改。
 * 不是任意 JSON 深转换/验证器；未知键和部分嵌套引用保留，钩子交入坏 messages 等结构仍可在转换时抛错。
 */
// 把内存请求浅复制并转换已知驼峰字段为 HTTP 下划线字段，不修改原顶层对象。
function toMistralWirePayload(payload: MistralChatPayload): Record<string, unknown> {
	// 展开复制自有可枚举字段，未知扩展字段也保留。
	const wirePayload: Record<string, unknown> = { ...payload };
	// 逐个解构内置重命名表，source 是内存名，target 是 wire 名。
	for (const [source, target] of [
		// topP 对应 top_p。
		["topP", "top_p"],
		// maxTokens 对应 max_tokens。
		["maxTokens", "max_tokens"],
		// randomSeed 对应 random_seed。
		["randomSeed", "random_seed"],
		// responseFormat 对应 response_format。
		["responseFormat", "response_format"],
		// toolChoice 对应 tool_choice。
		["toolChoice", "tool_choice"],
		// presencePenalty 对应 presence_penalty。
		["presencePenalty", "presence_penalty"],
		// frequencyPenalty 对应 frequency_penalty。
		["frequencyPenalty", "frequency_penalty"],
		// parallelToolCalls 对应 parallel_tool_calls。
		["parallelToolCalls", "parallel_tool_calls"],
		// reasoningEffort 对应 reasoning_effort。
		["reasoningEffort", "reasoning_effort"],
		// promptMode 对应 prompt_mode。
		["promptMode", "prompt_mode"],
		// promptCacheKey 对应 prompt_cache_key。
		["promptCacheKey", "prompt_cache_key"],
		// safePrompt 对应 safe_prompt。
		["safePrompt", "safe_prompt"],
		// as const 保留每对字段的字面量/只读元组类型，不运行时冻结数组。
	] as const) {
		// 有 source 才搬运；source 与 target 同时存在时 source 覆盖已有 target。
		remapMistralProperty(wirePayload, source, target);
	}
	/**
	 * map 回调把一条内存消息交给 wire 消息转换，返回新对象，原相对顺序不变；例 toolCalls 改为 tool_calls，不执行工具。
	 */
	// 每条消息转成新 wire 对象，结果数组也是新的；部分未改嵌套引用仍可能复用。
	wirePayload.messages = payload.messages.map((message) => toMistralWireMessage(message));

	// 查转换后的 response_format，不使用被删除的驼峰属性。
	const responseFormat = wirePayload.response_format;
	// 钩子可传未知结构，只有非null非数组 object 才处理其嵌套字段；不完整校验格式。
	if (isMistralRecord(responseFormat)) {
		// 为响应格式对象另做浅复制，避免原地删除调用者的 jsonSchema 字段。
		const wireResponseFormat = { ...responseFormat };
		// 只搬这一层已知 jsonSchema，不任意递归整个 schema 改键。
		remapMistralProperty(wireResponseFormat, "jsonSchema", "json_schema");
		// 取已搬到下划线名的 JSON schema 包装对象。
		const jsonSchema = wireResponseFormat.json_schema;
		// 同样要求它是非null非数组对象才继续。
		if (isMistralRecord(jsonSchema)) {
			// 复制 schema 包装层，实际 schema 定义内容仍按引用保留。
			const wireJsonSchema = { ...jsonSchema };
			// 包装层 schemaDefinition 变 schema；不会把业务 schema 里的同名属性一律改掉。
			remapMistralProperty(wireJsonSchema, "schemaDefinition", "schema");
			// 把新包装对象挂回新的响应格式对象。
			wireResponseFormat.json_schema = wireJsonSchema;
		}
		// 保存新的响应格式层到 wire payload。
		wirePayload.response_format = wireResponseFormat;
	}

	// 返回已转换请求，真正 JSON.stringify 在网络函数里执行。
	return wirePayload;
}

/**
 * 把一条消息浅复制后改 toolCalls/toolCallId，再按需要转换块数组，返回新消息，无外部顶层修改。
 * 例 assistant 函数调用字段变 tool_calls，字符串正文原样保留；不递归改参数 JSON 字符串或正文中的字段名。
 */
// 转单条历史消息的 wire 字段，返回新顶层对象，不修改输入。
function toMistralWireMessage(message: MistralChatMessage): Record<string, unknown> {
	// 消息浅复制，未处理的扩展字段保留。
	const wireMessage: Record<string, unknown> = { ...message };
	// assistant 的 toolCalls 改成 tool_calls；其中函数参数等不在这里再改。
	remapMistralProperty(wireMessage, "toolCalls", "tool_calls");
	// tool 结果的 toolCallId 改成 tool_call_id。
	remapMistralProperty(wireMessage, "toolCallId", "tool_call_id");
	// Array.isArray 分流合法的 string/块数组联合，只有数组才逐块转换。
	if (Array.isArray(message.content)) {
		/**
		 * map 回调转换一块内容的媒体字段，输入 chunk、输出新 wire 块，不改文本内部；例 imageUrl→image_url。
		 */
		// 每块转新对象，字符串消息正文原样复用。
		wireMessage.content = message.content.map((chunk) => toMistralWireContentChunk(chunk));
	}
	// 返回 wire 消息；并非在这里发送网络。
	return wireMessage;
}

/**
 * 把内容块浅复制后按固定媒体字段表改键，返回新对象，无网络或原块顶层修改。
 * 例 imageUrl 变 image_url；没有递归改 thinking 里的文字结构，也不因为字段表更广就验证支持所有媒体种类。
 */
// 内容块只把已知媒体键搬成 wire 字段，返回新对象，不递归改业务文本/思考数组。
function toMistralWireContentChunk(chunk: MistralContentChunk): Record<string, unknown> {
	// 顶层浅复制该块，其他字段保留。
	const wireChunk: Record<string, unknown> = { ...chunk };
	// 各对仍是内存名→wire名，支持的搬运表比本地静态联合当前列出的字段更多。
	for (const [source, target] of [
		// imageUrl 变 image_url。
		["imageUrl", "image_url"],
		// documentUrl 变 document_url。
		["documentUrl", "document_url"],
		// documentName 变 document_name。
		["documentName", "document_name"],
		// fileId 变 file_id。
		["fileId", "file_id"],
		// referenceIds 变 reference_ids。
		["referenceIds", "reference_ids"],
		// inputAudio 变 input_audio。
		["inputAudio", "input_audio"],
		// as const 只帮助 TS 将 source/target 视作字面量，不冻结运行对象。
	] as const) {
		// 原地修改的是上方新 wireChunk，不是原始 chunk。
		remapMistralProperty(wireChunk, source, target);
	}
	// 返回转换后的块，嵌套未改字段仍可共享。
	return wireChunk;
}

/**
 * 在传入字典上把 source 属性搬到 target，返回 void，会覆盖目标并删除旧键。
 * 例 {maxTokens:10,max_tokens:20} 变 {max_tokens:10}；source 存在且值 undefined 也会搬，最终 JSON 可能再省略该值。
 */
// 原地搬一个属性，source 不存在时无操作，返回 void。
function remapMistralProperty(record: Record<string, unknown>, source: string, target: string): void {
	// in 检查属性存在（也含原型链），不是按值是否真/非空判断；存在但值 undefined 也会搬。
	if (!(source in record)) return;
	// source 值覆盖 target，即使 target 本来有不同值。
	record[target] = record[source];
	// 删除旧字段，避免同一语义两套键并存。
	delete record[source];
}

/**
 * 有限识别 unknown 为非null非数组 object，返回类型谓词，无修改。
 * 例 {} 通过、[]/null 不通过，类实例可通过；不保证是普通JSON对象或符合某一协议 schema。
 */
// unknown 边界的有限对象判断，返回类型谓词，不证明其字段符合 Mistral 格式。
function isMistralRecord(value: unknown): value is Record<string, unknown> {
	// 非null且 typeof object、并排除数组；类实例仍可能通过。
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Symbol 作为本地结束哨兵，不与某个普通 JSON 对象意外相等。
const MISTRAL_STREAM_DONE = Symbol("mistral-stream-done");

/**
 * 将 Web 字节流增量解码/分事件，异步 yield {data}，输入正文与可选用户取消信号。
 * 每次读前后检查取消，缓存未完整事件，识别 CR/LF 空行、data 行 JSON 与 [DONE]；EOF 非空尾段也解析。例 UTF-8 字符跨字节块仍由 TextDecoder 续接。
 * 会锁定/读取/取消 body，finally 移除监听并释放锁；不是完整 SSE 实现，不校验所有候选字段，也没有正文大小/单事件长度上限。解析错误向调用者抛。
 */
// async function* 定义异步生成器，调用先得可迭代对象，执行读取要等 next/for await。
async function* readMistralEvents(
	// 输入 Web 字节流，Uint8Array 可能把一个 UTF-8 字符拆在多块里。
	body: ReadableStream<Uint8Array>,
	// 用户取消信号可缺省；不是前面的头超时合成信号。
	signal: AbortSignal | undefined,
	// yield 的元素是包装过的事件，函数本身没有最终内容返回值。
): AsyncGenerator<MistralCompletionEvent> {
	// 锁定流读取器，后面 finally 负责取消并释放锁。
	const reader = body.getReader();
	// 默认 TextDecoder 使用 UTF-8；stream:true 会保留未完整的多字节字符。
	const decoder = new TextDecoder();
	// 未形成完整事件的文字留在 buffer，跨网络 chunk 继续积累。
	let buffer = "";
	/**
	 * 用户取消时请求 reader.cancel，帮助唤醒尚未结算的 read，回调本身返回 void。
	 * 取消 Promise 的拒绝被吞，循环另检查 signal.reason；例等待无限正文时取消可让读取任务退出，不代表服务端计算已停止。
	 */
	// 取消监听回调主动 cancel reader，使正在等待的 read 也有机会结束。
	const onAbort = () => {
		/**
		 * 取消清理的失败回调不做额外处理、返回 undefined，避免另一个取消错误覆盖用户原始 reason。
		 */
		// void 忽略取消 Promise，catch 吞取消本身的拒绝；原用户取消在循环前后独立检查。
		void reader.cancel().catch(() => {});
	};
	// 信号存在才注册一次监听；若早已取消不会补触发回调，但下面首轮检查会抛。
	signal?.addEventListener("abort", onAbort, { once: true });

	// 循环正常结束、解析失败、用户取消或消费者提前关闭都走 finally。
	try {
		// 不预设字节块数量，读到 done 才离开。
		while (true) {
			// 读之前检查取消并原样抛 reason，reason 不保证是 Error。
			if (signal?.aborted) throw signal.reason;
			// 等待读取；done 为真可能没有 value，下面三元分支避免传错参数。
			const { done, value } = await reader.read();
			// 读取返回后再检查，避免 cancel 导致 done 后误当正常 EOF。
			if (signal?.aborted) throw signal.reason;
			// 普通块增量解码，EOF 用 decode() 刷出残余字节，再追加已有文字。
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

			// 查第一处事件边界，结果含起点/分隔符长度。
			let boundary = findMistralEventBoundary(buffer);
			// 当前 buffer 内可能有多条完整事件，因此继续循环而非每次只取一条。
			while (boundary) {
				// 取边界前的原始事件文字，不把空行分隔符交解析器。
				const event = parseMistralEvent(buffer.slice(0, boundary.index));
				// 移走已处理事件和边界文字，余下可能是半条事件。
				buffer = buffer.slice(boundary.index + boundary.length);
				// 遇 [DONE] 哨兵立即结束生成器，不继续读后续字节，finally 仍会执行。
				if (event === MISTRAL_STREAM_DONE) return;
				// 非空有效事件 yield 给消费器，空注释/无data事件跳过。
				if (event) yield event;
				// 用剩余 buffer 再找下一条边界。
				boundary = findMistralEventBoundary(buffer);
			}

			// 这次读到 EOF 才退出外层读取循环。
			if (done) break;
		}

		// EOF 还有非空白尾段时也解析，接受没有最后空行的事件。
		if (buffer.trim()) {
			// 尾段走同样 JSON/choices 检查，不因 EOF 免检。
			const event = parseMistralEvent(buffer);
			// 尾段为结束哨兵就不 yield，普通事件继续交上层。
			if (event !== MISTRAL_STREAM_DONE && event) yield event;
		}
		// 清理本次生成器取得的 reader 与监听器。
	} finally {
		// 删除同一 onAbort 回调，即使 once 未触发也不遗留监听。
		signal?.removeEventListener("abort", onAbort);
		// 取消流本身可能失败，清理阶段不让它覆盖原解析错误。
		try {
			// 等 reader.cancel 结算，释放上游正文资源；不代表服务端计算已回滚。
			await reader.cancel();
			// 忽略取消清理失败。
		} catch {}
		// 释放锁另设 try，取消失败也会继续尝试。
		try {
			// 解除 reader 对 body 的锁，供底层完成资源清理。
			reader.releaseLock();
			// 同样忽略解锁失败，不覆盖原异常。
		} catch {}
	}
}

/**
 * 找累计字符串中的第一处事件分隔，返回 {index,length} 或 undefined，无修改。
 * 支持正则列出的八种 CR/LF 组合；例 data 后两个 LF 给出边界，单个未形成空行的末尾 CR/LF 留给后续字节。
 * 按当前字符串匹配，不是完整 SSE 状态机，后续内容是否有效另由解析函数判断。
 */
// 从累计文字中找第一处空行样式边界，返回位置/长度或 undefined，无修改。
function findMistralEventBoundary(buffer: string): { index: number; length: number } | undefined {
	// 正则按所列八种 CR/LF 组合分隔；u 不等于启用多行，exec 返回首个匹配位置。
	const match = /\r\n\r\n|\r\n\r|\r\n\n|\r\r\n|\n\r\n|\r\r|\n\r|\n\n/u.exec(buffer);
	// 只排除 index 缺失，index=0 是合法边界；长度按实际匹配组合计算。
	return match?.index === undefined ? undefined : { index: match.index, length: match[0].length };
}

/**
 * 解析一段事件文字，返回包装后的 JSON、[DONE] Symbol 或 undefined，无网络/输入修改。
 * 先分行，仅取 data: 并拼接，再 trim；空段跳过，结束标记返回哨兵，其他 JSON.parse 后只检查根对象/choices数组。
 * 例 event:error 行本身被忽略，其 JSON 若没有 choices 仍会报 Invalid Mistral streaming event；候选内部结构不在此完整验证。
 */
// 解析一段 SSE 文字为事件/结束哨兵/空值，JSON 无效或缺 choices 数组会抛错。
function parseMistralEvent(raw: string): MistralCompletionEvent | typeof MISTRAL_STREAM_DONE | undefined {
	// 先从多行文本拼 SSE data 载荷，而不是拿整段直接 JSON.parse。
	const data = raw
		// 支持 CRLF、CR、LF 三种换行，CRLF 优先避免拆成两个。
		.split(/\r\n|\r|\n/u)
		/**
		 * 过滤回调仅判断一行是否以 data: 开头，返回 boolean，无修改；例冒号注释和 event: 行被过滤。
		 */
		// 只保留从列0开始的精确 data: 行；event/id/retry/注释行都忽略。
		.filter((line) => line.startsWith("data:"))
		/**
		 * 映射回调删去 data: 前缀和其后的全部开头空白，返回新字符串；例 data:  {...} 得 {...}，不是只删一个空格。
		 */
		// 去前5个字符 data: 并删其后的所有开头空白，不只是标准 SSE 的一个空格。
		.map((line) => line.slice(5).trimStart())
		// 多条 data 行用 LF 连接，符合本解析器的多行载荷策略。
		.join("\n")
		// 对拼好的整段再 trim，JSON 字符串内部的转义空白不受影响。
		.trim();
	// 没 data 或全空白就不产生事件。
	if (!data) return undefined;
	// 精确 [DONE] 转成 Symbol 哨兵，不当 JSON 解析。
	if (data === "[DONE]") return MISTRAL_STREAM_DONE;

	// JSON.parse 不带修复；结果先用 unknown 表示外部数据。
	const parsed: unknown = JSON.parse(data);
	// 只检查根非null非数组对象且 choices 是数组，不验证每个候选/delta/usage/工具参数。
	if (!isMistralRecord(parsed) || !Array.isArray(parsed.choices)) {
		// 有 JSON 但不符合这层有限形状就报协议错误，包括独立错误 JSON 事件。
		throw new Error("Invalid Mistral streaming event");
	}
	// 索引类型取 MistralCompletionEvent 的 data 形状，as 不再做运行时检查。
	return { data: parsed as MistralCompletionEvent["data"] };
}

/**
 * 生成内存 Mistral 请求体，输入模型、系统/工具上下文、已转换消息和原生选项，返回新对象，无网络。
 * 先设模型/stream/messages，再附最终工具、显式温度/输出上限、工具选择、思考与缓存键；例 sessionId:s1 且缓存非 none 时 promptCacheKey=s1。
 * 工具 strict 转换可抛错；本函数不展开通用 samplingParams、不实现重试/超时，钩子之后仍能改请求，真正 wire 改键由网络层做。
 */
// 构造内存驼峰请求体，不直接发网络，历史/工具转换异常向上传递。
function buildChatPayload(
	// 目标模型决定名字和是否能收图片。
	model: Model<"mistral-conversations">,
	// 规范化会话用于求最终活动工具，不是用转换后的消息倒推工具集合。
	context: TranscriptContext,
	// 共享转换器处理过的消息，包括可能的系统状态。
	messages: Message[],
	// 可选原生配置；没有默认对象也能通过 ?. 读取。
	options?: MistralOptions,
	// 返回内部 payload，wire 下划线转换在后面单独执行。
): MistralChatPayload {
	// 新建顶层请求体，不就地改历史。
	const payload: MistralChatPayload = {
		// 原样使用请求模型 id。
		model: model.id,
		// 默认要求流式；onPayload 仍能覆盖，本文件不会在替换后强制恢复。
		stream: true,
		// 按目标视觉能力转消息，工具结果错误会变文字前缀，不执行工具。
		messages: toChatMessages(messages, model.input.includes("image")),
	};

	// 按 system 增删重放工具，取本轮最后有效集合。
	const currentTools = getCurrentTools(context.messages);
	// 非空才附工具数组，每项可进行 strict schema 转换；没有这里的服务器限额自动降级重发。
	if (currentTools.length > 0) payload.tools = toFunctionTools(currentTools);
	// 只排除 undefined，temperature:0 原样保留。
	if (options?.temperature !== undefined) payload.temperature = options.temperature;
	// maxTokens:0 也保留；原生入口没有在此与模型/上下文上限再协调。
	if (options?.maxTokens !== undefined) payload.maxTokens = options.maxTokens;
	// 真值工具选择才设置，可在没有工具时仍发 toolChoice；映射只是形状转换。
	if (options?.toolChoice) payload.toolChoice = mapToolChoice(options.toolChoice);
	// 旧思考模式真值才发，不根据 model.reasoning 在这里再复核。
	if (options?.promptMode) payload.promptMode = options.promptMode;
	// 新 effort 真值才发，none 也是非空字符串；直接原生调用不自动做公共档位映射。
	if (options?.reasoningEffort) payload.reasoningEffort = options.reasoningEffort;
	// 缓存偏好不是 none 且 sessionId 真值时设置缓存键，未设置 env 控制/实际服务端缓存。
	if (shouldUsePromptCaching(options)) payload.promptCacheKey = options.sessionId;

	// 返回本次内存请求对象，正文钩子可改/替换。
	return payload;
}

/**
 * 判断是否自动请求提示缓存，输入可选选项，返回类型谓词，无修改。
 * 例 sessionId="s1" 且未设 cacheRetention 时为 true，none 时 false；只控制本地缓存键/自动亲和头，不保证服务端写入或命中缓存，也不设置 TTL。
 */
// 类型谓词在真分支把 options 与 sessionId 收窄为存在，不表示缓存已命中。
function shouldUsePromptCaching(options?: MistralOptions): options is MistralOptions & { sessionId: string } {
	// 短路判断只排除精确 none，再转 sessionId 为布尔；short/long 在本适配器这条路径没有 TTL 区别。
	return options?.cacheRetention !== "none" && !!options?.sessionId;
}

/**
 * 从多种历史用量字段名按优先级选一个缓存读取值，再转有限数字/按常规输入范围夹取，返回 number，不修改 usage。
 * 例 prompt_tokens_details.cached_tokens=3 且 promptTokens=10 得3；更高优先级字段是坏字符串时取0，不继续试后面的有效字段。
 * 这里只检查候选缓存值的有限数字类型，没完整验证根 usage 或 promptTokens，异常输入总数仍可影响结果。
 */
// 从使用量扩展字段里取缓存读取计数，返回数字，不修改 usage。
function getMistralCachedPromptTokens(usage: unknown, promptTokens: number): number {
	// as 只提供多个历史字段名的视图，不真实检查根是非null对象。
	const rawUsage = usage as {
		// 首选驼峰复数 promptTokensDetails.cachedTokens，内层允许 null。
		promptTokensDetails?: { cachedTokens?: unknown } | null;
		// 再看下划线复数形式。
		prompt_tokens_details?: { cached_tokens?: unknown } | null;
		// 再兼容单数 promptTokenDetails。
		promptTokenDetails?: { cachedTokens?: unknown } | null;
		// 然后单数下划线形式。
		prompt_token_details?: { cached_tokens?: unknown } | null;
		// 扁平驼峰缓存 token 字段。
		numCachedTokens?: unknown;
		// 扁平下划线缓存 token 字段。
		num_cached_tokens?: unknown;
	};
	// ?? 按下列优先级找第一个非null/undefined候选，0/错误类型也会阻止后面来源回退。
	const rawCachedTokens =
		// 第一来源：驼峰复数详情中的 cachedTokens。
		rawUsage.promptTokensDetails?.cachedTokens ??
		// 第二来源：下划线复数详情。
		rawUsage.prompt_tokens_details?.cached_tokens ??
		// 第三来源：驼峰单数详情。
		rawUsage.promptTokenDetails?.cachedTokens ??
		// 第四来源：下划线单数详情。
		rawUsage.prompt_token_details?.cached_tokens ??
		// 第五来源：扁平驼峰值。
		rawUsage.numCachedTokens ??
		// 第六来源：扁平下划线值。
		rawUsage.num_cached_tokens ??
		// 都空才用0。
		0;
	// 候选必须是真实有限 number，否则0；选中了错误类型时不继续试后面的字段。
	const cachedTokens = typeof rawCachedTokens === "number" && Number.isFinite(rawCachedTokens) ? rawCachedTokens : 0;
	// 正常非负 prompt 下夹在0到prompt内；promptTokens 自身未在此验证，负数/NaN 仍能影响结果。
	return Math.min(promptTokens, Math.max(0, cachedTokens));
}

/**
 * 消费 Mistral JSON 事件并组装共享 assistant/Pi 事件，输入模型、可变输出、事件通道、原始迭代器及观察钩子，返回 Promise<void>。
 * 每条先运行钩子、记响应id/用量，再取首候选的停止原因、文字/思考与工具增量；流结束发当前块end并对每个工具做完整参数解析。
 * 例同 index 的两段参数合并成同一工具调用，parser 保存在函数局部 Map，不随 partial 暴露；这里不执行工具或自行重试，迭代/钩子/消费错误向上抛。
 */
// 消费本地 SSE 事件并更新共享 output/发布 Pi 事件，返回 Promise<void>，不是再次发请求。
async function consumeChatStream(
	// 模型价格用于用量费用，协议身份不从流里另选模型。
	model: Model<"mistral-conversations">,
	// 同一轮可变消息，消费者的 partial 引用它。
	output: AssistantMessage,
	// Pi 事件通道，和下面原始事件迭代器不是同一个流。
	stream: AssistantMessageEventStream,
	// 原始事件由 readMistralEvents 包成 {data}。
	mistralStream: AsyncIterable<MistralCompletionEvent>,
	// 可选原始 chunk 观察钩子，先等待它再处理该 chunk。
	onProviderStreamEvent: StreamOptions["onProviderStreamEvent"],
	// 通过修改 output/推事件表达结果，返回值本身无内容。
): Promise<void> {
	// 当前打开的普通文字/思考块，工具出现时结束并置空。
	let currentBlock: TextContent | ThinkingContent | null = null;
	// 别名引用同一个内容数组，增加块会改变其长度。
	const blocks = output.content;
	/**
	 * 读取最新内容数组末项下标，无修改；例数组从1块增为2块，返回值从0变1，不固定最初空数组的-1。
	 */
	// 箭头闭包每次读最新末项下标，不固定初始化时的-1。
	const blockIndex = () => blocks.length - 1;
	// Stream state per Mistral tool call, kept off the content blocks so it never reaches partials.
	// Map 按数字 index 优先、否则调用 id 跟踪工具；解析器/原参数文本不放到公开 content 中。
	const toolCallsByKey = new Map<string | number, { contentIndex: number; arguments: ToolCallArgumentsStream }>();

	/**
	 * 为传入文字/思考块发布对应 end，返回 void；没块就跳过，不修改 currentBlock 引用。
	 * 调用方保证块是当前末项，例切到工具调用前先结束旧正文；这不是异步执行结束或清空内容的函数。
	 */
	// 可选参数类型取当前变量的联合，函数只发布 end，不自行清除 currentBlock。
	const finishCurrentBlock = (block?: typeof currentBlock) => {
		// 没传块或传 null 时无事可做。
		if (!block) return;
		// type 标签收窄为文字，可读 text。
		if (block.type === "text") {
			// 发布本块完整文字结束事件。
			stream.push({
				// text_end 只结束内容块，不是最终回答终态。
				type: "text_end",
				// 正常打开的文字/思考块是数组末项，所以用最新末项下标。
				contentIndex: blockIndex(),
				// 完整累计普通文字。
				content: block.text,
				// 同一部分消息引用。
				partial: output,
			});
			// 文字分支处理后退出，不继续思考分支。
			return;
		}
		// 另一合法类别为 thinking。
		if (block.type === "thinking") {
			// 发布思考块结束事件。
			stream.push({
				// thinking_end 标签。
				type: "thinking_end",
				// 最新内容块下标。
				contentIndex: blockIndex(),
				// 本块累计思考正文。
				content: block.thinking,
				// 仍使用共享 output。
				partial: output,
			});
		}
	};

	// 依次等待每个事件，迭代/钩子/消费异常向上抛，并触发生成器清理。
	for await (const event of mistralStream) {
		// 去掉本地包装层，得到解析出的服务端 JSON chunk。
		const chunk = event.data;
		// 观察钩子收到原始 JSON 引用，不是 {data} 包装；等待完才做此轮标准化。
		await onProviderStreamEvent?.(chunk, model);
		// Mistral's streamed CompletionChunk carries an id field. Keep the first non-empty one,
		// mirroring how OpenAI-style streaming exposes a stable response identifier per stream.
		// ||= 仅旧值是假值时采用新 id，保留首个真值响应标识。
		output.responseId ||= chunk.id;

		// usage 真值存在时更新用量，即使本 chunk 没有候选也先更新。
		if (chunk.usage) {
			// 输入总数取 prompt_tokens，缺省/0回退0，没有额外检查其有限性。
			const promptTokens = chunk.usage.prompt_tokens || 0;
			// 读取兼容的缓存计数字段，常规情况下夹到输入总数范围。
			const cachedPromptTokens = getMistralCachedPromptTokens(chunk.usage, promptTokens);

			// 对总输入减缓存读做 Math.max(0,...)；原统计未完整验证，坏值仍可能算出 NaN。
			output.usage.input = Math.max(0, promptTokens - cachedPromptTokens);
			// 输出直接采用 completion_tokens，不额外推导/计入 reasoning 分项。
			output.usage.output = chunk.usage.completion_tokens || 0;
			// 将缓存读取分开记录，便于单独计价。
			output.usage.cacheRead = cachedPromptTokens;
			// 不从该协议统计缓存写入，固定0。
			output.usage.cacheWrite = 0;
			// 先用服务端真值总数，否则按分项相加，不逐chunk累加。
			output.usage.totalTokens =
				// total_tokens=0 也会走回退，因为使用 || 而非 ??。
				chunk.usage.total_tokens ||
				// 回退合计含非缓存输入、输出、缓存读和缓存写，避免重复算缓存输入。
				output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
			// 按请求 model 本地价格原地更新费用，不查询真实账单。
			calculateCost(model, output.usage);
		}

		// 只处理首个候选，不遍历其他 choices。
		const choice = chunk.choices[0];
		// 没候选也不报错，跳过正文；前面可能已更新响应 id/用量。
		if (!choice) continue;

		// 只在真值 finish_reason 时映射；null/空串不调用 mapper，因此 mapper 的 null 分支不是当前流的默认终态。
		if (choice.finish_reason) {
			// 保存原始停止原因，便于统一状态之外诊断。
			output.rawStopReason = choice.finish_reason;
			// 将供应商字符串映射成统一原因和可选错误文字，未知原因会变 error 而非抛错。
			const stopReasonResult = mapChatStopReason(choice.finish_reason);
			// 赋新 stopReason；循环仍继续，可收后续正文/用量，不在此提前 break。
			output.stopReason = stopReasonResult.stopReason;
			// 只有本次映射给了真值错误文字才覆盖旧 errorMessage，成功停止不会主动清掉旧错误字段。
			if (stopReasonResult.errorMessage) {
				// 保留具体原因，例如 error 对应带 server error 的说明。
				output.errorMessage = stopReasonResult.errorMessage;
			}
		}

		// 取首候选增量；入站只有限校验过 choices，所以坏 delta 仍可能在下面访问时抛错。
		const delta = choice.delta;
		// null/undefined 正文跳过，空串仍进入但随后按内容过滤。
		if (delta.content !== null && delta.content !== undefined) {
			// 字符串先包装成单元素数组，结构数组直接迭代，不修改原数组。
			const contentItems = typeof delta.content === "string" ? [delta.content] : delta.content;
			// 按本次正文片段的原顺序处理文字/思考。
			for (const item of contentItems) {
				// 联合类型的直接字符串分支，不是 text 对象分支。
				if (typeof item === "string") {
					// 删除孤立代理码元后才写消息，可能把仅坏码元片段变为空。
					const textDelta = sanitizeSurrogates(item);
					// GLM models on Mistral send empty content deltas around thinking and tool calls.
					// Opening a block for them splits thinking into multiple blocks, which Mistral rejects on replay.
					// 空片段直接跳过，不结束当前思考/文字块；避免空文字把一个思考块拆成多块。
					if (!textDelta) continue;
					// 当前没块或类型不是 text 时才新开文字块。
					if (!currentBlock || currentBlock.type !== "text") {
						// 如有旧思考块，先发 end；没块时 helper 无操作。
						finishCurrentBlock(currentBlock);
						// 新文字块初始为空。
						currentBlock = { type: "text", text: "" };
						// 将同一块对象追加到共享 output。
						output.content.push(currentBlock);
						// 发布新文字块 start，消费者按当前末项索引定位。
						stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
					}
					// += 累积本段文字，连续同类片段合并到一个块。
					currentBlock.text += textDelta;
					// 发布这一片的增量，不重发累计全文作 delta。
					stream.push({
						// 统一文字增量标签。
						type: "text_delta",
						// 当前文字块的末项位置。
						contentIndex: blockIndex(),
						// 使用清理后的当前片段。
						delta: textDelta,
						// 共享可变 output 引用，不是不可变快照。
						partial: output,
					});
					// 此字符串片段处理完，跳过下面结构化内容分支。
					continue;
				}

				// 结构化片段标签为 thinking 时读其内部文字数组。
				if (item.type === "thinking") {
					// 没 thinking 数组用空数组，再把子片段拼为这一批思考增量。
					const deltaText = (item.thinking ?? [])
						/**
						 * map 回调取一个思考子片段的可选 text，返回字符串，缺省为空，不修改输入；例缺 text 不把 undefined 拼进正文。
						 */
						// 每个子片段 text 空缺回空串。
						.map((part) => part.text ?? "")
						/**
						 * filter 回调仅保留长度大于0的字符串，返回布尔值；纯空格长度非0仍保留，不负责trim。
						 */
						// 去掉空字符串，但不 trim 真实思考内容。
						.filter((text) => text.length > 0)
						// 直接相连无额外分隔符，保留供应商片段本身带的空格。
						.join("");
					// 合并后再清理孤立代理码元。
					const thinkingDelta = sanitizeSurrogates(deltaText);
					// 没有效思考文字就不创建/切换内容块。
					if (!thinkingDelta) continue;
					// 当前没块或不是 thinking 时切换。
					if (!currentBlock || currentBlock.type !== "thinking") {
						// 结束旧文字块，再准备新思考块。
						finishCurrentBlock(currentBlock);
						// 新思考块正文为空，不设置额外重放签名。
						currentBlock = { type: "thinking", thinking: "" };
						// 追加新思考对象。
						output.content.push(currentBlock);
						// 发送思考块开始事件。
						stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
					}
					// 把清理后的增量累加到该思考块。
					currentBlock.thinking += thinkingDelta;
					// 发布本批思考增量。
					stream.push({
						// thinking_delta 标签。
						type: "thinking_delta",
						// 本思考块在共享内容数组的位置。
						contentIndex: blockIndex(),
						// 仅当前这批思考文字。
						delta: thinkingDelta,
						// 共享 output 包含截至目前的所有内容。
						partial: output,
					});
					// 已处理思考，继续下一个 item，不再走 text 分支。
					continue;
				}

				// 结构化 text 与直接字符串路径相似；其他未知 type 到循环末尾直接忽略。
				if (item.type === "text") {
					// 缺 text 用空串，随后清理孤立代理码元。
					const textDelta = sanitizeSurrogates(item.text ?? "");
					// 没有效文字就跳过，保留旧块状态。
					if (!textDelta) continue;
					// 仅在没有文字块时新建，不为每个 Part 都开块。
					if (!currentBlock || currentBlock.type !== "text") {
						// 旧思考块（若有）先发 end。
						finishCurrentBlock(currentBlock);
						// 创建新的文字内容块。
						currentBlock = { type: "text", text: "" };
						// 按原顺序追加新块到输出。
						output.content.push(currentBlock);
						// 发文字 start，先有公开块再发事件。
						stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
					}
					// 累积本片段普通文字。
					currentBlock.text += textDelta;
					// 发布结构化文字片段的增量。
					stream.push({
						// text_delta 标签。
						type: "text_delta",
						// 当前末项下标。
						contentIndex: blockIndex(),
						// 清理后的当前文字增量。
						delta: textDelta,
						// 同一输出消息引用。
						partial: output,
					});
				}
			}
		}

		// 工具增量缺省/null用空数组，不在这里新建默认工具调用。
		const toolCalls = delta.tool_calls || [];
		// 同一 chunk 内可有多个工具片段，按顺序消费。
		for (const toolCall of toolCalls) {
			// 工具出现时先结束打开的文字/思考块。
			if (currentBlock) {
				// helper 只发 end，下一行负责清引用。
				finishCurrentBlock(currentBlock);
				// 置空后下一次文字即使同类也新建，不跨工具合并。
				currentBlock = null;
			}
			// 先为当前片段算候选调用 id，不等于最终一定覆盖旧工具块 id。
			const callId =
				// 真值且不是字面字符串 null 才信任为已提供 id；不检查字符/长度/历史唯一性。
				toolCall.id && toolCall.id !== "null"
					? // 接受服务器这一片的原始 id。
						toolCall.id
					: // 缺 id 时按 index（缺省0）生成确定候选，未调用带碰撞 Map 的历史规范化闭包。
						deriveMistralToolCallId(`toolcall:${toolCall.index ?? 0}`, 0);
			// 合并键优先 index，0 会保留；无 index 才按候选 id，同一逻辑调用混用键可能被当成新项。
			const key = toolCall.index ?? callId;
			// 查此键是否已有开放工具状态，let 允许下面首次创建后赋值。
			let open = toolCallsByKey.get(key);
			// 首次看到该键才建公开 ToolCall 与参数解析器。
			if (!open) {
				// 首片确定公开 id/name，后面片段即使提供不同/更完整名字也不在这里更新它们。
				output.content.push({ type: "toolCall", id: callId, name: toolCall.function.name, arguments: {} });
				// 保存公开块固定索引和独立参数流，避免随后追加其他块时索引串线。
				open = { contentIndex: output.content.length - 1, arguments: new ToolCallArgumentsStream() };
				// 登记键→状态，后续同键片段追加到同一解析器。
				toolCallsByKey.set(key, open);
				// 新调用首次出现才发 start，不在每个参数片段重复发。
				stream.push({ type: "toolcall_start", contentIndex: open.contentIndex, partial: output });
			}

			// 将该片参数统一成要追加的字符串。
			const argsDelta =
				// 已是字符串直接用，不把它当累计全文替换。
				typeof toolCall.function.arguments === "string"
					? // 保留供应商原参数片段，包括空串。
						toolCall.function.arguments
					: // 对象则 JSON 化，假值回 {}；如果连续给完整对象也会按追加处理，不自动 dedupe/replace。
						JSON.stringify(toolCall.function.arguments || {});
			// 断言只让 TS 读工具字段；append 更新原文和容错对象预览，未完成 JSON 的预览不等于最终参数有效。
			(output.content[open.contentIndex] as ToolCall).arguments = open.arguments.append(argsDelta);
			// 发布当前工具参数增量。
			stream.push({
				// toolcall_delta 标签。
				type: "toolcall_delta",
				// 使用创建时保存的固定工具索引，不是最新数组末项。
				contentIndex: open.contentIndex,
				// 原始参数片段文字，可能只是一部分 JSON。
				delta: argsDelta,
				// 共享消息中 arguments 已换成本次可见对象预览。
				partial: output,
			});
		}
	}

	// 原始迭代正常结束后收尾末文字/思考；中途抛错不会走这块。
	finishCurrentBlock(currentBlock);
	// 按 Map 首次插入顺序遍历所有工具，而不是按当前最后一片到达顺序。
	for (const open of toolCallsByKey.values()) {
		// 用保存索引取原公开工具块，as 不做运行时检查。
		const block = output.content[open.contentIndex] as ToolCall;
		// 对完整累计原文做最终解析，写 arguments/可能的 argumentsError；坏参数通常记录错误，不在此执行工具。
		Object.assign(block, open.arguments.finish());
		// 发每条工具的结束事件，即使它最终参数带 argumentsError。
		stream.push({
			// toolcall_end 只表示模型参数接收结束，不代表实际工具成功。
			type: "toolcall_end",
			// 工具自身固定索引。
			contentIndex: open.contentIndex,
			// 带完整工具块，含最终参数或参数错误。
			toolCall: block,
			// 同一 output 引用。
			partial: output,
		});
	}
}

/**
 * 将统一工具声明转 Mistral function 数组，输入工具列表，返回新对象，无执行/网络。
 * 每项按声明解析 strict，取严格副本或原 schema，递归复制去 symbol，再显式设 strict:true/false；例普通工具也发 strict:false。
 * 本地按 supportsStrict=true 解析不证明服务端一定接受；schema 克隆/转换/循环结构可抛错，无服务器 strict 降级重试。
 */
// 工具数组转原生 function 声明，返回新数组，不调用工具。
function toFunctionTools(tools: Tool[]): MistralFunctionTool[] {
	/**
	 * 逐项转换工具名、说明、参数和 strict，返回一个原生声明，不改原工具。
	 * 例 constrainedSampling 要求严格时先做严格 schema 转换，再移除非字符串枚举元数据；异常中断整个map。
	 */
	// 每工具独立解析 strict/转换参数，原声明不改。
	return tools.map((tool) => {
		// 此适配器向共享 resolver 声明 supportsStrict=true；不在这里在线探测模型/服务器是否实际接受。
		const strict = resolveJsonSchemaStrictSampling(tool, true);
		// 返回一项新声明对象。
		return {
			// 协议标签 function。
			type: "function",
			// 名称/描述/schema/严格标志位于同一个 function 对象。
			function: {
				// 原样保留工具名，不用历史 id 清洗规则处理名称。
				name: tool.name,
				// 描述字符串原样保留。
				description: tool.description,
				// strict=true 取严格副本，否则原schema，再递归去symbol等非字符串枚举字段；as 不证明schema根对象合法。
				parameters: stripSymbolKeys(getJsonSchemaToolParameters(tool, strict)) as Record<string, unknown>,
				// 未选 strict 时显式 false，不是省略字段；没有 prefer 因服务器拒绝后自动关闭重试的流程。
				strict: strict ?? false,
			},
		};
	});
}

/**
 * 递归复制数组/对象，只用 Object.entries 保存对象自有可枚举字符串键，返回新容器或原标量，无I/O。
 * 例 TypeBox 的 symbol 元数据不会进入新 schema，数组仍保持数组；并非只去 symbol，原型/不可枚举属性/数组自定义属性也不保留。
 * 没有循环引用检测或特殊键完整保留保证，getter/循环输入可导致抛错，函数名不等于完整 JSON 安全验证。
 */
// 将数组/对象递归转为新容器，只保留对象自有可枚举字符串键，标量原样返回。
function stripSymbolKeys(value: unknown): unknown {
	// 数组单独处理，避免 Object.entries 把它变数字键对象。
	if (Array.isArray(value)) {
		/**
		 * map 回调递归处理一个数组元素，返回对应新值，不修改原数组；例嵌套对象中的symbol也被递归复制规则省略。
		 */
		// 逐项递归，数组自定义额外属性不在 map 输出中复制。
		return value.map((item) => stripSymbolKeys(item));
	}

	// 非null对象也包含类实例，统一重建成普通对象，不保留原型/属性描述符。
	if (value && typeof value === "object") {
		// 新建输出字典；这不是对传入对象原地 delete symbol。
		const result: Record<string, unknown> = {};
		// Object.entries 忽略 symbol 和不可枚举字段，getter 的读取仍可能执行/抛错。
		for (const [key, entry] of Object.entries(value)) {
			// 递归处理每个值并赋给新对象，循环引用没有 visited 防护。
			result[key] = stripSymbolKeys(entry);
		}
		// 返回复制出的普通对象。
		return result;
	}

	// 字符串/数字/布尔/null/undefined 等未进入容器分支的值原样返回。
	return value;
}

/**
 * 把共享转换后的历史消息转 Mistral 内存消息，输入消息数组与视觉支持标志，返回新数组，不发网络或改原历史。
 * 按角色处理：首条完整system/后续更新，用户文字或图块，assistant文字/思考与独立toolCalls，toolResult正文提示加图片。
 * 例工具错误只有图且模型看不了时发送错误省略提示；assistant空白文字被跳过，用户直接空字符串仍保留。
 * JSON参数序列化等可抛错；这里只按声明视觉能力选形状，不验证图片内容或执行工具，协议转换会重排成文字在图前/工具单独字段的布局。
 */
// 历史消息转 Mistral 内存形状，输出新数组；媒体支持决定图片保留/占位，不发网络。
function toChatMessages(messages: Message[], supportsImages: boolean): MistralChatMessage[] {
	// 新消息数组用于按角色顺序累计。
	const result: MistralChatMessage[] = [];

	// entries 同时给原数组下标与消息，不是结果数组下标。
	for (const [index, msg] of messages.entries()) {
		// system 分支可以包含首条完整规则或后续更新。
		if (msg.role === "system") {
			// 原输入下标0才渲染完整system；中途system用更新说明，即使结果中前面空消息曾被跳过也不改变这个判定。
			const text = index === 0 ? getSystemMessageText(msg) : renderSystemMessageUpdate(msg);
			// 非空系统文字才追加，清理孤立代理码元后仍用 system 角色。
			if (text.length > 0) result.push({ role: "system", content: sanitizeSurrogates(text) });
			// 此角色处理完继续下一条，不落入工具结果逻辑。
			continue;
		}

		// 用户消息按字符串与块数组分流。
		if (msg.role === "user") {
			// 字符串分支包括空串。
			if (typeof msg.content === "string") {
				// 直接字符串清理后仍追加，即使为空；不在此 trim 用户正文。
				result.push({ role: "user", content: sanitizeSurrogates(msg.content) });
				// 已处理字符串用户消息，跳过数组分支。
				continue;
			}
			/**
			 * some 回调判断一个用户内容块是否为image，返回布尔值，无修改；用于全部图被过滤时给占位提示。
			 */
			// 记录当前输入块是否带图，供数组全部过滤后决定占位。
			const hadImages = msg.content.some((item) => item.type === "image");
			// 从块数组依次过滤/转换，生成新内容数组。
			const content: MistralContentChunk[] = msg.content
				/**
				 * filter 回调保留所有文字；supportsImages=true时也保留合法图块，不修改块。例不支持图片时仅图片项被移除。
				 */
				// 文字一律保留，图只在 supportsImages 为真时保留；用户块联合只有这两种合法类别。
				.filter((item) => item.type === "text" || supportsImages)
				/**
				 * map 回调将合法用户文字或图片转成 Mistral 块，返回新对象，无I/O；例 PNG data 包成 imageUrl，而非上传文件。
				 */
				// 按合法标签把用户块转成对应原生形状。
				.map((item) => {
					// 文字清理后包装 type:text，不额外 trim。
					if (item.type === "text") return { type: "text", text: sanitizeSurrogates(item.text) };
					// 图片拼 data:MIME;base64,数据，既有 MIME/base64 不在此解码验证。
					return { type: "image_url", imageUrl: `data:${item.mimeType};base64,${item.data}` };
				});
			// 转换后还有块就追加用户消息，空 text 块也仍算一块。
			if (content.length > 0) {
				// role:user 与已转换 content 一起写入结果。
				result.push({ role: "user", content });
				// 已追加有效数组，不再发图片缺失占位。
				continue;
			}
			// 只有原输入有图且模型不支持、结果数组又空时，才使用下面占位。
			if (hadImages && !supportsImages) {
				// 只表示图片被省略，原固定提示字符串不改；共享上游转换也可能已提前把图降级成文字。
				result.push({ role: "user", content: "(image omitted: model does not support images)" });
			}
			// 数组用户消息处理完继续，完全空且无图时不追加任何消息。
			continue;
		}

		// assistant 历史里文字/思考与工具调用分两个容器收集。
		if (msg.role === "assistant") {
			// 普通/思考按它们在原内容中的相对次序保存。
			const contentParts: MistralContentChunk[] = [];
			// 工具调用单独放 toolCalls；协议字段布局不保留工具与文字在一个 content 数组中的交错位置。
			const toolCalls: MistralRequestToolCall[] = [];

			// 遍历本条 assistant 的内容块。
			for (const block of msg.content) {
				// 文字块按标签收窄。
				if (block.type === "text") {
					// trim 只用来判断有非空白文字，不把真实发送内容 trim。
					if (block.text.trim().length > 0) {
						// 有效文字清理代理码元后追加。
						contentParts.push({ type: "text", text: sanitizeSurrogates(block.text) });
					}
					// 文字块处理后不落到工具分支。
					continue;
				}
				// 思考块独立保留为原生 thinking；跨模型是否丢弃已由共享转换器先处理。
				if (block.type === "thinking") {
					// 纯空白思考在此跳过，没有按签名额外保留的分支。
					if (block.thinking.trim().length > 0) {
						// 非空思考包装成一个结构块。
						contentParts.push({
							// 标签为 thinking。
							type: "thinking",
							// 内部用单个 text 子片段，不传 Pi 的 thinkingSignature/redacted 等其他元数据。
							thinking: [{ type: "text", text: sanitizeSurrogates(block.thinking) }],
						});
					}
					// 思考块已处理，继续下一块。
					continue;
				}
				// 余下合法 assistant 块为 ToolCall，不在此调用工具。
				toolCalls.push({
					// 沿用共享转换后的调用 id，不再在这里全面清洗所有历史 id。
					id: block.id,
					// function 类型标签。
					type: "function",
					// 参数按 JSON 字符串发送，假值兜底 {}；无法序列化时可抛错中止请求构造。
					function: { name: block.name, arguments: JSON.stringify(block.arguments || {}) },
					// 历史每项固定 index:0，不把输入 toolCall 的出现序号写进此字段。
					index: 0,
				});
			}

			// 新 assistant 消息显式 prefix:false，不以旧内容作为继续补写前缀。
			const assistantMessage: MistralChatMessage = { role: "assistant", prefix: false };
			// 非空文字/思考数组才附 content。
			if (contentParts.length > 0) assistantMessage.content = contentParts;
			// 非空工具数组才附 toolCalls，不额外创建假工具。
			if (toolCalls.length > 0) assistantMessage.toolCalls = toolCalls;
			// 至少有正文/思考或工具才追加历史assistant，完全空则省略。
			if (contentParts.length > 0 || toolCalls.length > 0) result.push(assistantMessage);
			// assistant 处理完，不落入工具结果分支。
			continue;
		}

		// 剩余合法角色为 toolResult，构造文字及可选图片块。
		const toolContent: MistralContentChunk[] = [];
		// 从工具结果中提取文字，并按LF连接。
		const textResult = msg.content
			/**
			 * 工具结果过滤回调只接受文字块，不修改输入；图片由后面另一个循环收集。
			 */
			// 只保留 text，不把图片元数据 JSON 化成正文。
			.filter((part) => part.type === "text")
			/**
			 * 映射回调取清理后的文字，非文字回空串，返回字符串；不在这里做工具结果整体trim。
			 */
			// 再按 type 检查取清理后的 text；其他分支回空串，保留原有表达式。
			.map((part) => (part.type === "text" ? sanitizeSurrogates(part.text) : ""))
			// 多个文字块以LF分隔，不直接连成一个词。
			.join("\n");
		/**
		 * some 回调检查工具结果的一块是否为图片，返回布尔值，不解码或校验图片；首个命中就停止。
		 */
		// 记录此输入结果是否有图，不检查图片数据有效性。
		const hasImages = msg.content.some((part) => part.type === "image");
		// 根据文字、图片支持和错误标志选择正文/占位/错误前缀。
		const toolText = buildToolResultText(textResult, hasImages, supportsImages, msg.isError);
		// 即使没真实文字也有一块提示，避免协议里空工具结果。
		toolContent.push({ type: "text", text: toolText });
		// 再按原序扫描结果图片。
		for (const part of msg.content) {
			// 模型不支持图时一张也不附，正文已负责省略提示。
			if (!supportsImages) continue;
			// 非图块跳过，文字已经在前面收集。
			if (part.type !== "image") continue;
			// 支持图片才追加一块 image_url。
			toolContent.push({
				// 原生图片类型标签。
				type: "image_url",
				// 用已有 MIME/base64 拼数据 URL，不触发额外读文件/图像压缩。
				imageUrl: `data:${part.mimeType};base64,${part.data}`,
			});
		}
		// 结果单独作为 tool 角色，不与下一条工具结果强行合并。
		result.push({
			// tool 角色表示某次工具调用的返回。
			role: "tool",
			// 调用关联 id 使用共享转换器调整后的值。
			toolCallId: msg.toolCallId,
			// 保留原工具名。
			name: msg.toolName,
			// content 先文字提示，再所有可用图片；不保留输入文字/图片原来的交错位置。
			content: toolContent,
		});
	}

	// 返回整个转换结果，输入历史本身不被此函数原地改写。
	return result;
}

/**
 * 为工具结果生成必有文字的正文/占位，输入原文字、有无图、视觉能力和错误标志，返回字符串，无外部修改。
 * 先trim文字，有文字则错误前缀+正文+必要的图片省略尾注；无文字时按可用图/被省略图/无输出选择提示。
 * 例 isError=true且无文字无图得 [tool error] (no tool output)；只改变发给模型的文字，图片的实际附加由调用者处理。
 */
// 为工具结果选文字表达，四个输入描述现有内容/能力/错误，返回新字符串，无I/O。
function buildToolResultText(text: string, hasImages: boolean, supportsImages: boolean, isError: boolean): string {
	// 工具结果文字真的 trim 后发送，区别用户/assistant仅用trim作空白判定。
	const trimmed = text.trim();
	// 仅依 isError 标志加固定前缀，不分析文本猜工具是否失败。
	const errorPrefix = isError ? "[tool error] " : "";

	// 有非空白文字优先直接使用它。
	if (trimmed.length > 0) {
		// 有图但模型不能看时在文字后加省略提示；能看则图片由外层附加，不加此尾注。
		const imageSuffix = hasImages && !supportsImages ? "\n[tool image omitted: model does not support images]" : "";
		// 合成错误前缀、修剪后的文字与可选图像尾注。
		return `${errorPrefix}${trimmed}${imageSuffix}`;
	}

	// 没真实文字但有图时用图片占位路径。
	if (hasImages) {
		// 能看图片时提示查看附件，不把 base64 自身写成正文。
		if (supportsImages) {
			// 根据错误标志选错误/普通的看图提示。
			return isError ? "[tool error] (see attached image)" : "(see attached image)";
		}
		// 不能看图时再按是否错误选文案。
		return isError
			? // 错误图片省略提示。
				"[tool error] (image omitted: model does not support images)"
			: // 成功结果图片省略提示。
				"(image omitted: model does not support images)";
	}

	// 文字与图都没有时仍给无输出提示，错误标志继续保留。
	return isError ? "[tool error] (no tool output)" : "(no tool output)";
}

/**
 * 把工具选择转成支持的原生形状，返回原字符串、新函数对象或undefined，无修改/网络。
 * 例 required 原样保留；指定 read 只复制其名字，不检查 read 在当前工具列表、也不执行它。坏未类型化对象仍可能访问失败。
 */
// 把允许的工具选择变成内存协议形状，不读取工具目录或执行工具。
function mapToolChoice(
	// 索引访问复用 MistralOptions.toolChoice 联合，包含 undefined。
	choice: MistralOptions["toolChoice"],
	// 返回允许字符串、指定函数对象或 undefined，不是返回函数执行结果。
): "auto" | "none" | "any" | "required" | { type: "function"; function: { name: string } } | undefined {
	// 缺省直接不设置；正常TS调用只有undefined可能是假值，未类型化空串也会被这里省略。
	if (!choice) return undefined;
	// 四种允许字符串原样保留，required 不改成 any。
	if (choice === "auto" || choice === "none" || choice === "any" || choice === "required") {
		// 返回原选择字符串。
		return choice;
	}
	// 其他合法输入是指定函数对象，重建有限结构。
	return {
		// 原生 function 选择标签。
		type: "function",
		// 仅取 function.name，不校验名称存在于当前工具集合。
		function: { name: choice.function.name },
	};
}

/**
 * 把停止原因转统一 stop/length/toolUse/error 及可选说明，纯函数不发新请求，未知值返回 error。
 * 例 model_length→length，error→带 server error 的错误文字以供上层分类器识别；null直调→stop，但流消费器跳过null，不凭它补结束原因。
 * 不是由“是否存在工具块”推断toolUse，只有服务端 tool_calls 值走该映射；本函数也不自动重试失败。
 */
// 供应商停止字符串转统一原因/可选错误文字，不发新请求或自动重试。
function mapChatStopReason(reason: string | null): { stopReason: StopReason; errorMessage?: string } {
	// 直接调用传 null 会得到 stop，但上面的流消费器仅对真值调用，因此它不会据缺失原因自动成功。
	if (reason === null) return { stopReason: "stop" };
	// 精确匹配供应商停止字符串，区分大小写。
	switch (reason) {
		// stop 正常结束。
		case "stop":
			// 返回统一 stop，不代表整个 Agent 不再处理工具/队列。
			return { stopReason: "stop" };
		// length 表示输出长度结束。
		case "length":
		// model_length 也映射为长度受限。
		case "model_length":
			// 返回 length，保留截断语义。
			return { stopReason: "length" };
		// tool_calls 表示模型请求执行工具。
		case "tool_calls":
			// 返回 toolUse；实际工具执行不在本文件。
			return { stopReason: "toolUse" };
		// 原因 error 进入明确错误路径。
		case "error":
			// Mistral reports transient server failures this way; "server error" makes the message retryable.
			// 说明里保留 server error 供上层重试分类器识别；本 mapper 自己不重试。
			return { stopReason: "error", errorMessage: "Provider stopped with: error (server error)" };
		// 未列出的任何字符串统一视为错误，不默认宽松 stop。
		default:
			// 错误文字附原原因，便于排查新的供应商停止值。
			return { stopReason: "error", errorMessage: `Provider stopped with: ${reason}` };
	}
}
