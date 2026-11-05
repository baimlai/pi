// 文件导读：packages/ai 的本地脚本化 Faux Provider（测试用假供应商）。
//
// 所属模块：AI provider 适配层。真实供应商在这里把 HTTP/SSE 转成统一消息事件；faux.ts 反过来把测试预先排队的
// AssistantMessage 或响应工厂“回放”成同一种事件流，所以上层 Models、agent 循环和 UI 无需感知真假供应商。
//
// 职责边界：本文件不访问网络、不读取密钥、不执行工具、不调用真实 tokenizer，也不计费。它只负责：
//   1) 构造测试消息与内容块；2) 维护每个实例的脚本队列、调用计数、提示词缓存和延迟响应表；
//   3) 按协议产生 start / *_start / *_delta / *_end / done / error 事件；4) 用字符数近似 token/usage。
// 上游入口：compat.ts 的 registerFauxProvider 会调用 createFauxCore，并把 stream/streamSimple 注册到全局 API 表
// （该全局注册不接入 deferred 接口）；显式 Models 场景直接调用 fauxProvider 取得 handle，再
// models.setProvider(handle.provider)，此时四个入口 stream / streamSimple / fetchDeferred / cancelDeferred 都可用，
// 并由 Models 调用。下游：事件流消费者（Models 的流读取逻辑、agent 循环、测试）读取
// AssistantMessageEventStream；最终 AssistantMessage 进入会话历史。错误不会同步抛出给消费者，而是包装成
// stopReason="error" 的消息，经 error 事件和 end 关闭流；队列耗尽、句柄未知/已取消、工厂抛错都走这条路径。
//
// 能力清单（导出项）：
//   - FauxModelDefinition：注册模型时可选覆盖的目录字段，仅 id 必填；是纯编译期形状，没有运行时校验。
//   - FauxContentBlock：assistant 脚本允许的块联合：TextContent | ThinkingContent | ToolCall。
//   - fauxText / fauxThinking / fauxToolCall：分别构造文字、思考、工具调用块；不产生事件或副作用。
//   - fauxAssistantMessage：构造脚本用的完整 AssistantMessage，可指定内容、停止原因、延迟句柄、错误文字、响应 id 和时间戳。
//   - FauxProviderState：可观察状态对象，记录 stream 调用数、延迟 fetch 数和已取消句柄快照。
//   - FauxResponseFactory：响应工厂签名，拿到 context/options/state/model 后同步或异步返回消息，可制造动态或失败响应。
//   - FauxResponseStep：队列元素联合：静态 AssistantMessage 或 FauxResponseFactory。
//   - RegisterFauxProviderOptions：api/provider 名、模型表、token 分片范围、速度、延迟轮询配置。
//   - FauxProviderRegistration：registerFauxProvider 的返回值形状（模型、api id、状态、队列控制与注销函数）。
//   - FauxProviderHandle：fauxProvider 的返回值，含 provider、api、models、getModel、state 与队列操作。
//   - createFauxCore：核心运行时；把选项变成可调用的流函数和可变状态，不自行注册。
//   - fauxProvider：用 createProvider 把核心装配成标准 Provider，返回独立 handle，便于每个测试隔离。
//
// 组合与典型调用顺序：fauxProvider(options) → models.setProvider(handle.provider) → handle.setResponses([...]) →
// 上层发起请求 → stream 同步 shift 队列并返回事件流 → 微任务中调用 onResponse、解析工厂、补 usage、streamWithDeltas
// 播放事件 → 消费者读到 done/error 后流关闭。延迟场景把中间两步换成 streamOptions.deferred=true，再按句柄调用
// fetchDeferred，直到出现最终消息；需要放弃时调用 cancelDeferred。
//
// 示例（真实签名；createModels 来自 ../models.ts，其余来自本文件）：
//   const faux = fauxProvider({ tokensPerSecond: 100 });
//   const models = createModels();
//   models.setProvider(faux.provider);
//   faux.setResponses([fauxAssistantMessage("hi", { stopReason: "stop" })]);
//   // 之后 models 的流式调用会消费这条脚本，并收到 text_start/text_delta/text_end/done。
// 说明：示例只展示最常见的注册与排队方式；真实运行时还会检查队列是否为空，并异步推送事件。
//
// 建议阅读顺序：先看 FauxModelDefinition / FauxContentBlock 与 fauxText、fauxThinking、fauxToolCall、
// fauxAssistantMessage，理解“脚本长什么样”；再看 FauxResponseStep、RegisterFauxProviderOptions、
// FauxProviderState、FauxProviderHandle，理解控制面；随后读 estimateTokens 到 streamWithDeltas 的流式实现；
// 最后读 createFauxCore（状态与四个 API）和 fauxProvider（包装与返回）。
import { createProvider, type Provider } from "../models.ts";
// 下面类型全部来自统一协议层：消息/内容块、事件流、请求选项、延迟句柄和模型目录；本文件不重新定义这些协议，只按它们的契约产生数据。
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	DeferredCancelOptions,
	DeferredFetchOptions,
	DeferredHandle,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	TranscriptContext,
	Usage,
} from "../types.ts";
// 创建与真实适配器相同的事件流对象；队列、result() 与 durationMs 计时都在该模块实现。
import { createAssistantMessageEventStream } from "../utils/event-stream.ts";
// 增量解析工具参数的 JSON 文本，让 toolcall_delta 中暴露的参数像真实供应商一样逐步长出来；最终仍以完整 arguments 为准。
import { ToolCallArgumentsStream } from "../utils/streaming-json.ts";
// 把 SystemMessage 的正文和 sections 拼成文本，用于估算提示词长度；它不执行章节或工具。
import { getSystemMessageText } from "../utils/text.ts";

// 未显式提供 api 时，默认以随机后缀生成独有协议名，避免多次注册互相覆盖；这里的基础字面量只作为 randomId 前缀。
const DEFAULT_API = "faux";
// 默认供应商 id；同一进程多次注册同名 provider 时由调用方的注册表决定覆盖关系。
const DEFAULT_PROVIDER = "faux";
// 默认模型 id，也是 fauxAssistantMessage 不指定模型时写进消息的标识。
const DEFAULT_MODEL_ID = "faux-1";
// 默认模型展示名；未给 models 时用于唯一的内置模型。
const DEFAULT_MODEL_NAME = "Faux Model";
// 占位端点：faux 不发 HTTP，但 Model 类型要求 baseUrl 字段。
const DEFAULT_BASE_URL = "http://localhost:0";
// 每次模拟分片最少对应的 token 数；不是实际 tokenizer token，字符数按 tokenSize*4 近似。
const DEFAULT_MIN_TOKEN_SIZE = 3;
// 每次模拟分片最多对应的 token 数；分片大小在 [min,max] 内随机，实际文本可能因取整略偏离。
const DEFAULT_MAX_TOKEN_SIZE = 5;

// 全零用量占位：真实输入/输出/缓存与费用都由 withUsageEstimate 或调用方覆盖；直接构造的消息引用这个共享对象。
const DEFAULT_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// 注册 faux 模型时可覆盖的目录字段；只有 id 必填，其余回退到 createFauxCore 里的默认值。
// 这些字段只影响测试模型元数据，不会探测真实供应商能力，也不会自动改变流行为。
export interface FauxModelDefinition {
	// 模型标识，同时写进返回的 AssistantMessage.model。
	id: string;
	// 展示名；省略时使用 id，而不是 DEFAULT_MODEL_NAME。
	name?: string;
	// 是否标记推理模型；测试可用它检查按模型能力分支的逻辑，但 faux 流本身不因 true 就发送思考块。
	reasoning?: boolean;
	// 允许的输入模态；联合字符串数组的写法让每个元素只能是 "text" 或 "image"。
	input?: ("text" | "image")[];
	// 索引访问类型：取出 Model<string> 上 inputLimits 属性的类型，避免在这里重复声明图片/请求限制结构。
	inputLimits?: Model<string>["inputLimits"];
	// 四项基础费率；没有 total/tiers，createFauxCore 只在整份 cost 缺失时补零，不做分项合并。
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	// 上下文窗口元数据，默认 128000；faux 不做真正的上下文溢出检查。
	contextWindow?: number;
	// 最大输出元数据，默认 16384；不会截断脚本里更长的回答。
	maxTokens?: number;
}

// assistant 消息脚本可包含的块：文字、思考或工具调用；不接受图片，因为 AssistantMessage.content 本身也只允许这三种。
export type FauxContentBlock = TextContent | ThinkingContent | ToolCall;

// 构造一个文字块，省去手写 { type: "text", text }；例 fauxText("hi") 得到 { type: "text", text: "hi" }。无 I/O。
export function fauxText(text: string): TextContent {
	// type 使用字符串字面量，TS 据此把它收窄到 TextContent 而不会当成任意 string。
	return { type: "text", text };
}

// 构造一个思考块；例 fauxThinking("plan") 得到 { type: "thinking", thinking: "plan" }。不会触发推理或计费。
export function fauxThinking(thinking: string): ThinkingContent {
	// 返回普通对象，thinking 字段保存脚本给出的思考文字。
	return { type: "thinking", thinking };
}

// 构造工具调用块；name 是工具名，arguments_ 是符合 JSON 对象的参数，options.id 可固定调用 id。
// 例 fauxToolCall("echo", { text: "hi" }, { id: "tool-1" })；不传 id 时用 randomId("tool") 生成。无执行动作。
export function fauxToolCall(name: string, arguments_: ToolCall["arguments"], options: { id?: string } = {}): ToolCall {
	// 参数名写成 arguments_ 是为了避开严格模式下对 arguments 绑定的限制；尾部下划线没有运行时含义。
	return {
		// 联合分辨字段，固定为 toolCall。
		type: "toolCall",
		// ?? 只在 id 为 null/undefined 时回退，空字符串仍会被保留。
		id: options.id ?? randomId("tool"),
		// 模型选择的工具名。
		name,
		// ToolCall["arguments"] 是索引访问类型，等价于该字段的 JSON 对象类型。
		arguments: arguments_,
	};
}

// 把字符串、单个块或块数组统一成块数组；输入类型本身已排除非法块，运行时只用 Array.isArray 区分数组与单块。
// 例 normalizeFauxAssistantContent("hi") → [{type:"text",text:"hi"}]；传单个 thinking 块 → [该块]；不复制数组。
function normalizeFauxAssistantContent(content: string | FauxContentBlock | FauxContentBlock[]): FauxContentBlock[] {
	// typeof 在这里区分联合中的字符串分支；这是类型收窄，不验证文本内容。
	if (typeof content === "string") {
		// 字符串包装成单个文字块，避免调用方再写类型字段。
		return [fauxText(content)];
	}
	// 输入类型还剩“单块”或“块数组”；运行时必须用 Array.isArray 区分，否则无法把单个对象直接当数组返回。
	return Array.isArray(content) ? content : [content];
}

// 构造排队用的完整 assistant 消息；content 可为字符串、单块或块数组，options 可指定停止原因、延迟句柄、错误文字、响应 id 和时间戳。
// 例 fauxAssistantMessage("hi") 得到 stopReason="stop" 的普通回答；fauxAssistantMessage([fauxToolCall(...)], { stopReason: "toolUse" }) 表示请求工具。
// 只创建普通对象，不校验 content 组合、不调用模型、不写历史；api/provider/model 先用 faux 默认值，真正返回时 cloneMessage 再改成注册身份。
export function fauxAssistantMessage(
	// 内容可为字符串（自动转文字块）、单个块或块数组。
	content: string | FauxContentBlock | FauxContentBlock[],
	// 选项对象带默认 {}，所以可只传 content；每个字段用 ? 表示可省略。
	options: {
		// 用 AssistantMessage["stopReason"] 索引访问，保持与统一停止原因联合完全一致。
		stopReason?: AssistantMessage["stopReason"];
		// 可选后台句柄，直接放进最终消息，用于模拟 deferred 结果。
		deferred?: DeferredHandle;
		// 失败/取消时给调用方看的文字；不影响 stopReason 本身。
		errorMessage?: string;
		// 供应商响应 id，可被 telemetry 等记录。
		responseId?: string;
		// 毫秒时间戳；缺省用当前 Date.now()，不是单调时钟。
		timestamp?: number;
	} = {},
): AssistantMessage {
	// 返回符合 AssistantMessage 接口的普通对象，字段顺序与接口无运行时关系。
	return {
		// 角色字面量固定为 assistant。
		role: "assistant",
		// 归一化后保证是块数组；字符串已在上面转成文字块。
		content: normalizeFauxAssistantContent(content),
		// 以下三项是占位身份，cloneMessage 在真正返回前会覆盖成注册的 api/provider/model。
		api: DEFAULT_API,
		provider: DEFAULT_PROVIDER,
		model: DEFAULT_MODEL_ID,
		// 共享全零用量；withUsageEstimate 会替换成新 usage 对象。
		usage: DEFAULT_USAGE,
		// ?? 只在 undefined/null 时回退到 "stop"；显式 "error" 等值原样保留。
		stopReason: options.stopReason ?? "stop",
		// 条件展开：选项缺失就什么都不加，避免把可选字段显式写成 undefined。
		...(options.deferred === undefined ? {} : { deferred: options.deferred }),
		// 同样只在调用方提供错误文字时加入 errorMessage。
		...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
		// 同样只在提供响应 id 时加入 responseId。
		...(options.responseId === undefined ? {} : { responseId: options.responseId }),
		// ?? 保留显式 0；只有 undefined/null 才取当前时间。
		timestamp: options.timestamp ?? Date.now(),
	};
}

// 测试可观察的共享状态；每次读取都是同一对象，工厂函数也能通过参数拿到它。
export interface FauxProviderState {
	// stream 被调用的次数，包括没有排队回复而直接失败的调用。
	callCount: number;
	// fetchDeferred 被调用的次数，包括句柄无效、已取消或仍在 pending 的轮询。
	deferredFetchCount: number;
	// 每次 cancelDeferred 的句柄副本；未知句柄也会记录，不能据此证明远端任务真的停止。
	cancelledDeferred: DeferredHandle[];
}

// 脚本工厂：请求到来时按上下文、提交选项、共享状态和请求模型动态生成一条 assistant 消息（可异步）。
// 例 (_context, _options, state) => fauxAssistantMessage(`第${state.callCount}次`)；工厂抛错会变成流里的 error 消息。
export type FauxResponseFactory = (
	// 已规范化的请求上下文，工具声明在 system 消息里。
	context: TranscriptContext,
	// 提交时的统一选项，可能含 sessionId、cacheRetention、deferred 等；类型允许 undefined。
	options: SimpleStreamOptions | undefined,
	// 同一 provider 内共享的调用计数与取消记录。
	state: FauxProviderState,
	// 本次请求的模型目录对象，可据此按 api/id/reasoning 分支。
	model: Model<string>,
	// 同步返回固定消息，或返回 Promise 延迟决定。
) => AssistantMessage | Promise<AssistantMessage>;

// 队列中的一步：完整消息（每次消费会克隆）或按请求生成的工厂；联合类型让两种写法都能 setResponses。
export type FauxResponseStep = AssistantMessage | FauxResponseFactory;

// 注册 faux provider 的配置；所有字段可省略，缺省值在 createFauxCore 中决定。
export interface RegisterFauxProviderOptions {
	// 协议 id；省略时用 randomId("faux") 生成，避免不同测试的全局注册互相覆盖。
	api?: string;
	// 供应商 id，默认 "faux"。
	provider?: string;
	// 模型目录定义数组；为空数组时退回一个默认模型，而不是创建零模型 provider。
	models?: FauxModelDefinition[];
	// 延迟响应模拟参数；只有请求带 streamOptions.deferred 时才会创建延迟句柄。
	deferred?: {
		/** Number of fetches that return the original handle before the scripted response becomes ready. */
		// 前 N 次 fetchDeferred 仍返回带 deferred 句柄的消息，之后才解析并返回最终消息；负数/小数会在创建时归零/向下取整。
		pendingFetches?: number;
		// 建议的轮询间隔，原样放进 DeferredHandle.pollAfterMs；本文件不据此自动轮询。
		pollAfterMs?: number;
	};
	// 模拟流式速度：每片延时约 estimateTokens(chunk)/tokensPerSecond 秒；省略或 <=0 时立即排队。
	tokensPerSecond?: number;
	// 每个模拟分片对应的 token 数范围；实际字符数按 tokenSize*4 近似，不是真实 tokenizer。
	tokenSize?: {
		// 最小 token 数，缺省 3；最终会被限制到至少 1。
		min?: number;
		// 最大 token 数，缺省 5；小于 min 时会被提升到 min。
		max?: number;
	};
}

// compat.ts 的 registerFauxProvider 返回的句柄：比 fauxProvider 的句柄多一个卸载全局注册的方法。
export interface FauxProviderRegistration {
	// 实际注册的协议 id。
	api: string;
	// 非空模型元组；[Model<string>, ...Model<string>[]] 表示至少一项，getModel() 才能安全返回首项。
	models: [Model<string>, ...Model<string>[]];
	// 无参重载：返回首模型；不检查模型是否仍被某处引用。
	getModel(): Model<string>;
	// 按 id 查找；找不到返回 undefined，而不是抛错。
	getModel(modelId: string): Model<string> | undefined;
	// 共享调用/轮询/取消状态。
	state: FauxProviderState;
	// 用新数组替换待消费队列（内部会复制数组）。
	setResponses: (responses: FauxResponseStep[]) => void;
	// 在现有队列尾部追加脚本。
	appendResponses: (responses: FauxResponseStep[]) => void;
	// 读取尚未消费的脚本数量。
	getPendingResponseCount: () => number;
	// 从 compat 全局注册表中按来源卸载；不影响其他来源覆盖的注册。
	unregister: () => void;
}

// fauxProvider 返回的句柄：把同一个核心装配进显式 Models 集合，因此不需要全局卸载方法。
export interface FauxProviderHandle {
	// 可直接交给 models.setProvider 的标准 Provider。
	provider: Provider;
	// 协议 id，用于诊断或构造额外模型。
	api: string;
	// 非空模型元组。
	models: [Model<string>, ...Model<string>[]];
	// 取首模型的重载。
	getModel(): Model<string>;
	// 按 id 取模型，找不到为 undefined。
	getModel(modelId: string): Model<string> | undefined;
	// 共享状态。
	state: FauxProviderState;
	// 替换脚本队列。
	setResponses: (responses: FauxResponseStep[]) => void;
	// 追加脚本。
	appendResponses: (responses: FauxResponseStep[]) => void;
	// 剩余脚本数。
	getPendingResponseCount: () => number;
}

// 粗略 token 估算：按每 4 个 UTF-16 码元约 1 token 向上取整；例 "hello" 长度 5 → 2，不是分词器结果。
function estimateTokens(text: string): number {
	// Math.ceil 保证非空文本至少算 1；空串得 0。
	return Math.ceil(text.length / 4);
}

// 生成带前缀的随机标识：前缀 + 毫秒时间 + Math.random 的 36 进制小数；例 "tool:171...:k3j9x"。
// 不是密码学随机，也不保证跨进程绝对唯一；仅用于测试中区分调用/延迟句柄。
function randomId(prefix: string): string {
	// toString(36) 把 0..1 的小数转成 a-z0-9 串，slice(2) 去掉开头的 "0."。
	return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

// 把用户/工具结果内容转成估算提示词用的文字：字符串原样；图文块数组逐块转换，图片写成 [image:mime:base64长度]。
// 例 [{type:"text",text:"hi"},{type:"image",mimeType:"image/png",data:"abcd"}] → "hi\n[image:image/png:4]"；不读取图片解码结果。
function contentToText(content: string | Array<TextContent | ImageContent>): string {
	// 联合类型先按 typeof 收窄：字符串分支直接返回，后续分支只能是数组。
	if (typeof content === "string") {
		return content;
	}
	// map 对每个内容块产生一行文字，再用 \n 连接；不修改原数组。
	return content
		.map((block) => {
			// type 是文字块联合的分辨字段，TS 在该分支把 block 收窄为 TextContent。
			if (block.type === "text") {
				return block.text;
			}
			// 剩下的是图片块；data 是 base64 字符串，length 是编码后字符数而不是原始字节数。
			return `[image:${block.mimeType}:${block.data.length}]`;
		})
		.join("\n");
}

// 把 assistant 内容块转成估算输出 token 的文字：文字/思考取正文，工具调用写成 "名字:参数JSON"。
// 例 [{type:"toolCall",name:"echo",arguments:{x:1}}] → 'echo:{"x":1}'；JSON.stringify 未捕获异常（如循环引用会抛错）。
function assistantContentToText(content: Array<TextContent | ThinkingContent | ToolCall>): string {
	// 每块一行，最后用换行连接；空白块也会产生空行，不会被过滤。
	return content
		.map((block) => {
			// 文字块直接取正文。
			if (block.type === "text") {
				return block.text;
			}
			// 思考块取 thinking 字段，和可见回答分开统计。
			if (block.type === "thinking") {
				return block.thinking;
			}
			// 剩余的联合成员是 ToolCall：名字加完整参数序列化，便于估算参数长度。
			return `${block.name}:${JSON.stringify(block.arguments)}`;
		})
		.join("\n");
}

// 把工具结果消息转成文字：第一行是工具名，随后每个文字/图片块各占一行；例 toolName "echo" + 文本 "ok" → "echo\nok"。
function toolResultToText(message: ToolResultMessage): string {
	// 展开语法把 toolName 与 map 结果合成一个字符串数组，再由 join 加换行。
	return [message.toolName, ...message.content.map((block) => contentToText([block]))].join("\n");
}

// 把任意 Message 转成估算提示词用的单条文字：system 额外带上工具增删记录，user 走图文转换，assistant 走块转换，其余按工具结果处理。
// 例 system 消息含 sections 时由 getSystemMessageText 拼入；工具增删写成 tool-:/tool+: 前缀；无 I/O。
function messageToText(message: Message): string {
	// 按 role 标签收窄联合；先处理 system 是因为它可能有 sections/toolsAdded/toolsRemoved。
	if (message.role === "system") {
		return (
			[
				// system 正文与章节文字。
				getSystemMessageText(message),
				// 可选 toolsRemoved 存在时逐项序列化，前缀 tool- 表示移除；?.map 为 undefined 时给空数组。
				...(message.toolsRemoved?.map((tool) => `tool-:${JSON.stringify(tool)}`) ?? []),
				// toolsAdded 同理，前缀 tool+ 表示新增。
				...(message.toolsAdded?.map((tool) => `tool+:${JSON.stringify(tool)}`) ?? []),
			]
				// 去掉空字符串段，避免拼接出多余空行；filter 使用普通函数接收值为 string。
				.filter((part) => part.length > 0)
				// 段之间用单个换行连接。
				.join("\n")
		);
	}
	// 用户消息可能是字符串或文字/图片数组，交给 contentToText。
	if (message.role === "user") {
		return contentToText(message.content);
	}
	// assistant 的 content 固定是三种块组成的数组。
	if (message.role === "assistant") {
		return assistantContentToText(message.content);
	}
	// 联合类型收窄到最后一个成员 ToolResultMessage；TS 保证这里 role 为 toolResult。
	return toolResultToText(message);
}

/** Length of the prompt text that joins `messages` with blank lines. */
// 计算按空行（"\n\n"，2 个字符）连接前 count 条消息后的总字符数；count 可小于数组长度，用于只算公共前缀。
// 例 ["ab","cd"] → 2 + 2 + 2 = 6；空数组 → 0；不真正拼接字符串，避免重复分配。
function joinedLength(messages: readonly string[], count = messages.length): number {
	// 非空时先加 count-1 个分隔符，每条消息之间两个换行符；count 为 0 时没有分隔符。
	let length = count > 0 ? (count - 1) * 2 : 0;
	// 逐条累加 UTF-16 码元长度。
	for (let index = 0; index < count; index++) length += messages[index]!.length;
	// 返回总长度；调用方保证 count 不超过数组长度，否则读取 undefined.length 会抛 TypeError，这里不做防护。
	return length;
}

/**
 * Length of the common prefix of the two joined prompts. Equal messages are compared whole; characters are compared
 * only from the first message that differs.
 */
// 计算两份拼接后提示词的公共前缀长度：整条相同的消息直接跳过，只在第一条不同消息处逐字符比较。
// 例 previous ["user:hello world"]、current 追加 "user:next" 时公共前缀 16；两数组用同一空行分隔规则，避免把分隔符算错。
function commonPromptPrefixLength(previous: readonly string[], current: readonly string[]): number {
	// index 指向第一条不相同的消息；同时受两个数组长度限制。
	let index = 0;
	while (index < previous.length && index < current.length && previous[index] === current[index]) index++;
	// rest 取从 index 开始仍未比较的拼接文本：为空串，或先补分隔符（若前面已有消息）再 join。
	// 箭头函数捕获外层 index；返回 string，不修改 messages。
	const rest = (messages: readonly string[]) =>
		index === messages.length ? "" : (index > 0 ? "\n\n" : "") + messages.slice(index).join("\n\n");
	// 已整条相等的部分用 joinedLength 计算；剩余文本再逐字符求公共前缀。
	return joinedLength(previous, index) + commonPrefixLength(rest(previous), rest(current));
}

// 逐 UTF-16 码元比较两个字符串的公共前缀长度；例 "abc","abd" → 2。长度按 code unit 计，不按字素簇或 Unicode 码点。
function commonPrefixLength(a: string, b: string): number {
	// 公共前缀不可能超过较短字符串的长度。
	const length = Math.min(a.length, b.length);
	// index 同时作为已匹配字符数。
	let index = 0;
	// 逐位比较；循环条件保证 index < length，TS 把 a[index]/b[index] 视为 string，运行时不读取越界位置。
	while (index < length && a[index] === b[index]) {
		index++;
	}
	// 返回首次不同或较短串末尾的位置。
	return index;
}

// 给一条 assistant 消息补上模拟 usage：提示词按每条消息一行、空行分隔估算 token，输出按内容文字估算，并按 sessionId 模拟缓存前缀。
// 输入 context 与提交选项，返回新对象（浅展开原消息 + 新 usage），不修改传入消息；副作用是更新 promptCache。
// 例 sessionId="s1" 首次提示词 16 字符 → input=0、cacheWrite=4；同 session 追加内容后 → cacheRead=4、cacheWrite=剩余 token。
function withUsageEstimate(
	// 待补 usage 的最终/错误消息；content 已确定。
	message: AssistantMessage,
	// 已规范上下文，只有 messages 参与提示词估算。
	context: TranscriptContext,
	// 提交选项，决定是否模拟缓存；undefined 时按无 sessionId 处理。
	options: StreamOptions | undefined,
	// 按 sessionId 保存上一次提示词文本的映射；跨请求共享，用于计算公共前缀。
	promptCache: Map<string, readonly string[]>,
): AssistantMessage {
	// 每条消息先转成 "role:文本"；toolCall 参数等也包含在内，整份提示词再用空行连接。
	// One text per message; the whole prompt joins them with blank lines.
	const prompt = context.messages.map((message) => `${message.role}:${messageToText(message)}`);
	// 不实际拼接，直接用长度公式得到提示词字符数。
	const promptLength = joinedLength(prompt);
	// 提示词 token 估算，向上取整。
	const promptTokens = Math.ceil(promptLength / 4);
	// 输出 token 只按本条回答的内容估算；思考与工具参数也计入。
	const outputTokens = estimateTokens(assistantContentToText(message.content));
	// 默认没有缓存时，全部提示词算未缓存输入。
	let input = promptTokens;
	// 缓存读取 token，默认 0。
	let cacheRead = 0;
	// 缓存写入 token，默认 0。
	let cacheWrite = 0;
	// 可选会话标识；没有它就不模拟缓存。
	const sessionId = options?.sessionId;

	// 只有同时有 sessionId 且缓存保留不是 "none" 时才模拟缓存；未指定 cacheRetention 时按非 none 处理。
	if (sessionId && options?.cacheRetention !== "none") {
		// 取该会话上一次的提示词消息数组；没有则是首次。
		const previousPrompt = promptCache.get(sessionId);
		// 有历史提示词就计算公共前缀，模拟供应商缓存命中。
		if (previousPrompt) {
			// 公共前缀按字符计，包含消息之间的空行。
			const cachedChars = commonPromptPrefixLength(previousPrompt, prompt);
			// 命中部分换算为 token，向上取整。
			cacheRead = Math.ceil(cachedChars / 4);
			// 总量减去命中量，避免除法取整造成负数；不是精确的“新增字符数”。
			cacheWrite = Math.max(0, promptTokens - cacheRead);
		} else {
			// 首次请求没有可读缓存，全部提示词都算写入。
			cacheWrite = promptTokens;
		}
		// Every prompt token is either read from or written to the simulated cache.
		// 模拟约定：命中/写入已覆盖全部提示词，因此普通 input 置 0；totalTokens 仍把它们相加。
		input = 0;
		// 记录本次提示词，供同一会话下一次计算前缀；即使 cacheWrite 为 0 也会更新。
		promptCache.set(sessionId, prompt);
	}

	// 返回新消息对象；usage 是全新对象，原消息的 usage 不被改写。
	return {
		// 展开原消息，保留 content/stopReason/deferred/errorMessage 等字段。
		...message,
		// 统一用量结构；费用固定为 0，因为 faux 不模拟计费。
		usage: {
			// 未缓存输入；模拟缓存开启时为 0。
			input,
			// 输出 token 估算。
			output: outputTokens,
			// 模拟命中的缓存读取量。
			cacheRead,
			// 模拟写入的缓存量。
			cacheWrite,
			// 总 token 为四项之和；这里把 cacheRead/cacheWrite 与 input/output 直接相加。
			totalTokens: input + outputTokens + cacheRead + cacheWrite,
			// 五项费用全零，不按目录价格计算。
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

// 把一个字符串随机切成若干“token 块”，每块字符数约为随机 tokenSize*4；用于模拟流式增量。
// 例 min=3,max=3 时每块 12 字符；空字符串返回 [""]，让调用方仍能发出一次空 delta。无 I/O。
function splitStringByTokenSize(text: string, minTokenSize: number, maxTokenSize: number): string[] {
	// 收集切片结果。
	const chunks: string[] = [];
	// index 是当前切片起点。
	let index = 0;
	// 每次至少前进 1 个字符，所以循环一定结束。
	while (index < text.length) {
		// Math.random() 在 [0,1)，floor 后得到 [0, max-min] 的整数，再加上 min。
		const tokenSize = minTokenSize + Math.floor(Math.random() * (maxTokenSize - minTokenSize + 1));
		// 每 token 约 4 个 UTF-16 码元；至少 1 防止参数异常造成死循环。
		const charSize = Math.max(1, tokenSize * 4);
		// slice 到起点+charSize；可能切开代理对，但不影响字符串按码元切分。
		chunks.push(text.slice(index, index + charSize));
		// 起点前进本块大小。
		index += charSize;
	}
	// 空文本没有循环，返回一个空串块，保证流协议仍发出 start/end。
	return chunks.length > 0 ? chunks : [""];
}

// 克隆脚本消息并改写协议/供应商/模型身份；structuredClone 深复制内容，避免多个请求共享同一可变对象。
// 例 cloneMessage(msg, "faux:x", "p", "m1") 返回同内容但 api/provider/model 已替换的新消息；不校验被克隆对象是否含函数。
function cloneMessage(message: AssistantMessage, api: string, provider: string, modelId: string): AssistantMessage {
	// structuredClone 只支持可结构化克隆的数据；消息类型按设计可序列化，但运行时可被绕过。
	const cloned = structuredClone(message);
	// 浅展开克隆结果后再覆盖身份字段；content 等嵌套对象仍是克隆出来的副本。
	return {
		...cloned,
		// 使用本次注册的协议 id，而不是脚本里 faux 默认值。
		api,
		// 使用本次注册的供应商 id。
		provider,
		// 使用实际请求的模型 id，支持一次注册多个模型。
		model: modelId,
		// timestamp 在类型上必填，?? 只在运行时被绕过时兜底当前时间。
		timestamp: cloned.timestamp ?? Date.now(),
		// usage 同理：缺失时回退共享零值，正常脚本消息不会走到这里。
		usage: cloned.usage ?? DEFAULT_USAGE,
	};
}

// 构造“结果仍在后台”的占位消息：content 为空、stopReason="deferred"、带句柄；fetchDeferred 在最终结果未就绪时重复返回它。
// 例 createDeferredMessage(model, handle) 只描述状态，不等待任务，也不修改 handle。
function createDeferredMessage(model: Model<string>, handle: DeferredHandle): AssistantMessage {
	// 返回完整 AssistantMessage，保持与服务端延迟响应相同的协议形状。
	return {
		// 角色固定 assistant。
		role: "assistant",
		// 还没有任何内容块。
		content: [],
		// 身份取自本次请求模型。
		api: model.api,
		// 供应商 id。
		provider: model.provider,
		// 请求模型 id。
		model: model.id,
		// 零用量占位，不代表后台任务真实消耗。
		usage: DEFAULT_USAGE,
		// 延迟停止原因让上层知道需要轮询而不是结束。
		stopReason: "deferred",
		// 保存可序列化句柄，调用方之后用它 fetch/cancel。
		deferred: handle,
		// 创建时间。
		timestamp: Date.now(),
	};
}

// 把任意抛出值包装成 protocol 规定的 error AssistantMessage；例 throw new Error("boom") → stopReason="error"、errorMessage="boom"。
// 不记录堆栈，也不把非 Error 对象展开；Error 之外的值用 String 转成 "[object Object]" 之类文字。
function createErrorMessage(error: unknown, api: string, provider: string, modelId: string): AssistantMessage {
	// 完整消息，content 为空。
	return {
		// 统一角色。
		role: "assistant",
		// 失败消息没有内容块。
		content: [],
		// 以本次注册协议标识失败，而不是沿用脚本消息。
		api,
		// 供应商 id。
		provider,
		// 请求模型 id。
		model: modelId,
		// 零用量占位。
		usage: DEFAULT_USAGE,
		// 错误停止原因，消费者据此区分成功完成。
		stopReason: "error",
		// instanceof 在这里收窄 unknown 到 Error 以读取 message；跨 realm 的 Error 可能不命中，此时走 String。
		errorMessage: error instanceof Error ? error.message : String(error),
		// 失败发生时间。
		timestamp: Date.now(),
	};
}

// 基于当前 partial 生成 aborted 消息：保留已产生的块和用量，改写停止原因为 aborted 并加统一取消文字。
// 例流到一半被 AbortSignal 取消时，调用方拿到已输出内容但 stopReason="aborted"；不撤销已经发出的 delta 事件。
function createAbortedMessage(partial: AssistantMessage): AssistantMessage {
	// 浅展开保留 content 引用；后续不会再修改该 partial，因此无需深复制。
	return {
		...partial,
		// 取消状态。
		stopReason: "aborted",
		// 固定说明文字，不是供应商原始错误。
		errorMessage: "Request was aborted",
		// 取消发生时间覆盖原消息时间。
		timestamp: Date.now(),
	};
}

// 按模拟速度等待一个分片：未设置或非正 tokensPerSecond 时用 queueMicrotask 尽快继续；否则按 token 数/速度计算毫秒延时。
// 例 chunk 估算 2 token、tokensPerSecond=100 → 等待约 20ms 后 resolve；返回 Promise，不检查取消信号。
function scheduleChunk(chunk: string, tokensPerSecond: number | undefined): Promise<void> {
	// !tokensPerSecond 同时覆盖 undefined 和 0；<=0 也视为不限速。
	if (!tokensPerSecond || tokensPerSecond <= 0) {
		// 微任务在当前同步栈结束后立即执行，比 setTimeout(0) 更早，但仍保持异步。
		return new Promise((resolve) => queueMicrotask(resolve));
	}
	// token 数除以每秒 token 数得到秒数，再乘 1000 转毫秒。
	const delayMs = (estimateTokens(chunk) / tokensPerSecond) * 1000;
	// setTimeout 接受小数毫秒；resolve 由计时器调用。
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

// 把一条已确定的消息重新“播放”为流事件：按脚本块顺序发 start/各块 start-delta-end/终止事件，并按 tokensPerSecond 限速。
// 输入要写入的流、最终消息、分片 token 范围、速度和取消信号；输出 Promise 在终止事件写入后完成。
// 副作用是向 stream 推送事件；取消时推送 error(aborted)+end，脚本缺 stopReason 时抛出（由调用方转成错误事件）。
// 例 message 含一个 text 块 "hi" → start、text_start、若干 text_delta、text_end、done，随后 end(message)。
async function streamWithDeltas(
	// 事件输出端；调用方已经把它返回给消费者。
	stream: AssistantMessageEventStream,
	// 流结束后应得到的完整消息；其 content 决定事件序列。
	message: AssistantMessage,
	// 每个分片的最小估算 token 数。
	minTokenSize: number,
	// 每个分片的最大估算 token 数。
	maxTokenSize: number,
	// 限速值；undefined 或非正数表示只让出微任务、不按时间等待。
	tokensPerSecond: number | undefined,
	// 取消信号；每次等待后都会重新检查。
	signal: AbortSignal | undefined,
): Promise<void> {
	// partial 是消费者在事件里看到的“增长中消息”：先清空内容并标记 pending，之后每个 delta 都基于它生成快照。
	const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
	// 在发出 start 前已取消：直接给一个终止错误，不产生任何内容事件。
	if (signal?.aborted) {
		// 基于空的 pending partial 生成取消消息。
		const aborted = createAbortedMessage(partial);
		// 先推流级错误事件，reason 为 aborted。
		stream.push({ type: "error", reason: "aborted", error: aborted });
		// 再关闭流并带上最终消息。
		stream.end(aborted);
		// 结束本函数。
		return;
	}

	// 发出开始事件；{ ...partial } 是快照，避免后续修改影响已交给消费者的对象。
	stream.push({ type: "start", partial: { ...partial } });

	// 按最终内容的顺序逐块播放；索引同时作为协议的 contentIndex。
	for (let index = 0; index < message.content.length; index++) {
		// 每个内容块开始前检查取消，已取消就不再产生新块。
		if (signal?.aborted) {
			// 用当前 partial（可能已有前面块）构造取消结果。
			const aborted = createAbortedMessage(partial);
			// 追发终止错误事件。
			stream.push({ type: "error", reason: "aborted", error: aborted });
			// 关闭流。
			stream.end(aborted);
			// 提前返回，剩余块不再输出。
			return;
		}

		// 取出当前内容块；联合类型在此处尚未收窄。
		const block = message.content[index];

		// 通过 tag 字段收窄到思考块；TypeScript 的判别联合让后文能访问 block.thinking。
		if (block.type === "thinking") {
			// 向 partial 追加一个空的 thinking 块；使用新数组而不是 push，保证快照不可变。
			partial.content = [...partial.content, { type: "thinking", thinking: "" }];
			// 发出块开始事件，contentIndex 指向该块。
			stream.push({ type: "thinking_start", contentIndex: index, partial: { ...partial } });
			// 把完整思考文本随机切成块；空文本也会得到一个空块。
			for (const chunk of splitStringByTokenSize(block.thinking, minTokenSize, maxTokenSize)) {
				// 按模拟速度等待，让消费者能观察到逐块到达。
				await scheduleChunk(chunk, tokensPerSecond);
				// 等待期间可能被取消；取消后立即终止。
				if (signal?.aborted) {
					// 保留已累积的 partial 内容。
					const aborted = createAbortedMessage(partial);
					// 推终止错误。
					stream.push({ type: "error", reason: "aborted", error: aborted });
					// 关闭流。
					stream.end(aborted);
					// 停止播放。
					return;
				}
				// 把当前块文本追加到 partial 对应位置；as 断言告诉编译器这里是 ThinkingContent（由上面的替换逻辑保证）。
				(partial.content[index] as ThinkingContent).thinking += chunk;
				// 发出增量事件，delta 是本段文本，partial 是到目前为止的快照。
				stream.push({ type: "thinking_delta", contentIndex: index, delta: chunk, partial: { ...partial } });
			}
			// 块结束：content 给出完整思考文本，partial 仍为快照。
			stream.push({
				// 事件类型。
				type: "thinking_end",
				// 对应内容下标。
				contentIndex: index,
				// 最终完整文本。
				content: block.thinking,
				// 当前消息快照。
				partial: { ...partial },
			});
			// 跳到下一个内容块，避免落入后面的 text/tool 分支。
			continue;
		}

		// 同理处理正文文本块。
		if (block.type === "text") {
			// 追加空 text 块到 partial。
			partial.content = [...partial.content, { type: "text", text: "" }];
			// 发出 text_start。
			stream.push({ type: "text_start", contentIndex: index, partial: { ...partial } });
			// 随机分片完整文本。
			for (const chunk of splitStringByTokenSize(block.text, minTokenSize, maxTokenSize)) {
				// 限速等待。
				await scheduleChunk(chunk, tokensPerSecond);
				// 等待后检查取消。
				if (signal?.aborted) {
					// 保留已输出内容。
					const aborted = createAbortedMessage(partial);
					// 错误事件。
					stream.push({ type: "error", reason: "aborted", error: aborted });
					// 关闭流。
					stream.end(aborted);
					// 停止。
					return;
				}
				// 累加到 partial 的文本块。
				(partial.content[index] as TextContent).text += chunk;
				// 发出 text_delta。
				stream.push({ type: "text_delta", contentIndex: index, delta: chunk, partial: { ...partial } });
			}
			// 文本块结束，content 是完整文本。
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: { ...partial } });
			// 继续下一块。
			continue;
		}

		// 剩下的判别成员只有 toolCall：先追加占位块，arguments 暂为空对象。
		partial.content = [...partial.content, { type: "toolCall", id: block.id, name: block.name, arguments: {} }];
		// 发出工具调用开始事件。
		stream.push({ type: "toolcall_start", contentIndex: index, partial: { ...partial } });
		// Partial arguments come from the same parser real providers use, so consumers see them grow.
		// 使用与真实供应商相同的增量 JSON 解析器，让事件的 arguments 逐步成形，而不是只在结束时出现。
		const toolArguments = new ToolCallArgumentsStream();
		// 把最终参数对象序列化成 JSON 文本，再按 token 大小分片；delta 携带的是 JSON 字符串片段。
		for (const chunk of splitStringByTokenSize(JSON.stringify(block.arguments), minTokenSize, maxTokenSize)) {
			// 模拟网络/生成等待。
			await scheduleChunk(chunk, tokensPerSecond);
			// 每次等待后检查取消。
			if (signal?.aborted) {
				// partial 中只保留已解析的中间参数。
				const aborted = createAbortedMessage(partial);
				// 推错误事件。
				stream.push({ type: "error", reason: "aborted", error: aborted });
				// 结束流。
				stream.end(aborted);
				// 停止。
				return;
			}
			// append 返回当前已解析的参数对象；未完成 JSON 时得到尽力而为的中间值。
			(partial.content[index] as ToolCall).arguments = toolArguments.append(chunk);
			// 发出 toolcall_delta，delta 是原始 JSON 文本片段。
			stream.push({ type: "toolcall_delta", contentIndex: index, delta: chunk, partial: { ...partial } });
		}
		// 全部片段发完后，用脚本里的最终参数覆盖解析结果，避免分片边界造成的偏差。
		(partial.content[index] as ToolCall).arguments = block.arguments;
		// 发出 toolcall_end，toolCall 字段携带完整原始块。
		stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: { ...partial } });
	}

	// pending 是内部临时状态；若脚本消息最终仍是它，说明脚本写错了，抛出让调用方捕获并转成错误事件。
	if (message.stopReason === "pending") {
		// 该异常不会从本函数正常返回，而是由 createFauxCore 的 try/catch 接收。
		throw new Error("Faux response ended without a stop reason");
	}
	// 脚本消息本身是错误/取消时，内容事件已播放完，再以对应 reason 结束。
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		// 这里 error 字段是完整消息；reason 收窄为 "error" | "aborted"。
		stream.push({ type: "error", reason: message.stopReason, error: message });
		// 关闭流。
		stream.end(message);
		// 不再发 done。
		return;
	}

	// 正常完成：done 事件带停止原因，随后 end 关闭流；两者携带同一条最终消息。
	stream.push({ type: "done", reason: message.stopReason, message });
	// 关闭事件流。
	stream.end(message);
}

// 创建一套 faux 运行时核心：持有待播脚本队列、调用计数、缓存映射和延迟响应表，并实现 stream/streamSimple/fetchDeferred/cancelDeferred。
// 输入注册选项（api/provider 名、模型表、token 分片范围、速度、延迟轮询配置）；输出可直接交给 createProvider 或注册函数的一组函数与状态。
// 副作用仅限内存中的队列/计数/缓存变化，不访问网络，也不自动注册到全局 Models；例 createFauxCore({}) 得到默认 faux-1 模型和空队列。
export function createFauxCore(options: RegisterFauxProviderOptions) {
	// 协议 id 未指定时用 randomId("faux") 生成唯一值，避免并行测试注册同名协议互相覆盖。
	const api = options.api ?? randomId(DEFAULT_API);
	// 供应商 id 默认 "faux"；同一进程可显式传不同值以隔离多个实例。
	const provider = options.provider ?? DEFAULT_PROVIDER;
	// 先取 min/max 的较小值并保证至少 1：若用户把 min 配得比 max 大，则分片下限被压到 max。
	const minTokenSize = Math.max(
		// 下限硬性为 1，防止 0 或负数导致分片循环无法前进。
		1,
		// 两个默认值分别用于缺失的 min/max；optional chaining 让未配置 tokenSize 时安全读取。
		Math.min(options.tokenSize?.min ?? DEFAULT_MIN_TOKEN_SIZE, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE),
	);
	// 上限至少等于已修正的下限，保证随机范围 [min,max] 合法。
	const maxTokenSize = Math.max(minTokenSize, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE);
	// 待消费脚本步骤队列；每次 stream 调用 shift 一个，可被 setResponses 整体替换。
	let pendingResponses: FauxResponseStep[] = [];
	// 全局模拟速度；共享给每个流，undefined 表示不按时间限速。
	const tokensPerSecond = options.tokensPerSecond;
	// 可变运行状态，供测试断言调用次数和取消记录；对象引用跨调用保持不变。
	const state: FauxProviderState = { callCount: 0, deferredFetchCount: 0, cancelledDeferred: [] };
	// 按 sessionId 保存上次提示词，用于 withUsageEstimate 模拟前缀缓存；只增不自动清理。
	const promptCache = new Map<string, readonly string[]>();
	// 延迟响应表：句柄 id → 提交时的脚本、上下文、选项、模型与轮询状态；值类型是对象字面量类型。
	const deferredResponses = new Map<
		// 键是 DeferredHandle.id。
		string,
		// 每条延迟响应保存的数据。
		{
			// 交给调用方的句柄。
			handle: DeferredHandle;
			// 尚未解析的脚本步骤，可含异步工厂。
			step: FauxResponseStep;
			// 提交时快照的上下文。
			context: TranscriptContext;
			// 提交时的完整流选项；undefined 表示调用方没传。
			options: SimpleStreamOptions | undefined;
			// 提交请求所用的模型。
			model: Model<string>;
			// 最终结果出现前还要返回几次 deferred 占位。
			pendingFetches: number;
			// cancelDeferred 标记；之后 fetch 会失败。
			cancelled: boolean;
			// 解析后缓存的最终消息，保证多次 fetch 只解析一次；? 表示可能尚未生成。
			final?: AssistantMessage;
		}
	>();

	// 未提供任何模型时使用内置默认模型；?.length 同时处理 models 为 undefined 的情况。
	const modelDefinitions = options.models?.length
		? options.models
		: [
				{
					// 默认模型 id。
					id: DEFAULT_MODEL_ID,
					// 展示名。
					name: DEFAULT_MODEL_NAME,
					// 默认不声明推理能力。
					reasoning: false,
					// as 断言把 string[] 收窄为 ("text" | "image")[]；这是编译期声明，不改运行时值。
					input: ["text", "image"] as ("text" | "image")[],
					// 全部费率为 0。
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					// 默认上下文窗口。
					contextWindow: 128000,
					// 默认最大输出。
					maxTokens: 16384,
				},
			];
	// 把用户定义补全为完整 Model 对象；map 返回的普通数组随后被断言为非空元组。
	const models = modelDefinitions.map((definition) => ({
		// 模型 id 必填。
		id: definition.id,
		// 展示名缺失时退回 id；?? 只处理 null/undefined，不处理空字符串。
		name: definition.name ?? definition.id,
		// 本次注册的协议 id。
		api,
		// 本次注册的供应商 id。
		provider,
		// 固定的假 baseUrl，仅用于满足 Model 形状。
		baseUrl: DEFAULT_BASE_URL,
		// 推理能力默认 false。
		reasoning: definition.reasoning ?? false,
		// 输入模态默认文本+图片。
		input: definition.input ?? ["text", "image"],
		// 可选的每模态输入限制原样传递。
		inputLimits: definition.inputLimits,
		// 缺省费率为全零。
		cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// 缺省上下文窗口。
		contextWindow: definition.contextWindow ?? 128000,
		// 缺省最大输出。
		maxTokens: definition.maxTokens ?? 16384,
		// 断言至少一个元素：上面的三元分支保证空数组会回退到默认模型；运行时没有额外检查。
	})) as [Model<string>, ...Model<string>[]];

	// 解析一个脚本步骤并补全身份与 usage：工厂函数会先被 await 执行，静态消息则直接使用。
	// 返回新消息；副作用来自工厂本身（它拿到 state 可记录或修改），本函数自身只写 promptCache。
	// 例 step 为 fauxAssistantMessage("hi") 时直接克隆；为 async () => fauxAssistantMessage("x") 时等待其完成。
	const resolveResponse = async (
		// 队列中取出的步骤：消息对象或异步工厂。
		step: FauxResponseStep,
		// 本次请求上下文，传给工厂并用于 usage 估算。
		context: TranscriptContext,
		// 提交选项，传给工厂（例如可读 sessionId）。
		streamOptions: SimpleStreamOptions | undefined,
		// 本次请求模型，决定 api/provider/model 覆盖值。
		requestModel: Model<string>,
	): Promise<AssistantMessage> => {
		// typeof 判断把联合类型收窄为函数分支；await 兼容工厂同步或异步返回消息。
		const resolved = typeof step === "function" ? await step(context, streamOptions, state, requestModel) : step;
		// 先深克隆并改写身份，再计算 usage；返回新对象，脚本里的原消息不被修改。
		return withUsageEstimate(
			// 克隆时使用核心注册的 api/provider 和实际请求的模型 id。
			cloneMessage(resolved, api, provider, requestModel.id),
			// 上下文用于提示词 token 估算。
			context,
			// 选项用于 sessionId/cacheRetention。
			streamOptions,
			// 共享缓存映射。
			promptCache,
		);
	};

	// 实现流式入口：同步取走一个脚本步骤并返回事件流，真正的推送在微任务里异步进行。
	// 输入模型、上下文、简单选项；输出 AssistantMessageEventStream。副作用：队列 shift、callCount 自增、onResponse 回调、缓存更新。
	// 错误路径：队列空、工厂抛错、脚本缺停止原因都会变成 error 事件；消费者不会收到同步异常。
	const stream: StreamFunction<string, SimpleStreamOptions> = (requestModel, context, streamOptions) => {
		// 创建对外事件流；函数返回后消费者即可订阅。
		const outer = createAssistantMessageEventStream();
		// 同步取出队首步骤；undefined 表示脚本已耗尽。
		const step = pendingResponses.shift();
		// 调用计数在返回事件流前自增，测试可立即断言。
		state.callCount++;

		// 把实际工作排入微任务：保证先返回 outer，让调用方先拿到可监听对象。
		queueMicrotask(async () => {
			// 捕获异步阶段一切异常并转成协议错误事件。
			try {
				// 先调用可选 onResponse 回调；即使没有排队脚本也调用，便于测试观察请求已到达。
				await streamOptions?.onResponse?.({ status: 200, headers: {} }, requestModel);
				// 没有步骤：构造错误消息，补 usage 后终止事件流。
				if (!step) {
					// 用 let 是因为随后会被 withUsageEstimate 返回的新对象替换。
					let message = createErrorMessage(
						// 明确的队列耗尽错误。
						new Error("No more faux responses queued"),
						// 注册协议 id。
						api,
						// 注册供应商 id。
						provider,
						// 请求模型 id。
						requestModel.id,
					);
					// 错误消息也带估算 usage；没有 sessionId 时为普通 input。
					message = withUsageEstimate(message, context, streamOptions, promptCache);
					// 推 error 事件，reason 为 "error"。
					outer.push({ type: "error", reason: "error", error: message });
					// 关闭流。
					outer.end(message);
					// 结束微任务。
					return;
				}

				// 调用方要求延迟响应时，不走普通解析，而是登记句柄并先返回 deferred 占位。
				if (streamOptions?.deferred) {
					// 构造句柄；字段可 JSON 序列化，供上层轮询。
					const handle: DeferredHandle = {
						// 使用请求模型上的供应商，而不是核心默认值（二者通常相同）。
						provider: requestModel.provider,
						// 请求模型 id。
						modelId: requestModel.id,
						// 请求协议 id。
						api: requestModel.api,
						// 随机唯一 id，作为延迟响应表的键。
						id: randomId("deferred"),
						// 条件展开：只有显式配置了 pollAfterMs（包括 0）才加入字段。
						...(options.deferred?.pollAfterMs !== undefined ? { pollAfterMs: options.deferred.pollAfterMs } : {}),
					};
					// 保存提交现场；工厂延迟到第一次真正 fetch 时才执行。
					deferredResponses.set(handle.id, {
						// 句柄本体，之后会原样返回给调用方。
						handle,
						// 本次取出的脚本步骤。
						step,
						// 上下文快照（按约定不再变更）。
						context,
						// 完整提交选项，包含 deferred/signal/onResponse，最终解析前会剔除。
						options: streamOptions,
						// 请求模型。
						model: requestModel,
						// 先返回几次占位：floor 保证整数，max 防负数；缺省 0。
						pendingFetches: Math.max(0, Math.floor(options.deferred?.pendingFetches ?? 0)),
						// 初始未取消。
						cancelled: false,
					});
					// 用 createDeferredMessage 作为“消息”播放协议：内容为空、stopReason="deferred"。
					await streamWithDeltas(
						// 同一输出流。
						outer,
						// 占位消息携带句柄。
						createDeferredMessage(requestModel, handle),
						// 分片下限（占位没有内容，实际不会分片）。
						minTokenSize,
						// 分片上限。
						maxTokenSize,
						// 速度。
						tokensPerSecond,
						// 提交时的取消信号。
						streamOptions.signal,
					);
					// 延迟分支结束。
					return;
				}

				// 普通分支：先解析脚本并补 usage，再按块播放。
				const message = await resolveResponse(step, context, streamOptions, requestModel);
				// 可选链读取 signal：streamOptions 可能为 undefined。
				await streamWithDeltas(outer, message, minTokenSize, maxTokenSize, tokensPerSecond, streamOptions?.signal);
			} catch (error) {
				// 工厂抛错或 streamWithDeltas 抛错都在这里收口成协议错误消息。
				const message = createErrorMessage(error, api, provider, requestModel.id);
				// 推 error 事件。
				outer.push({ type: "error", reason: "error", error: message });
				// 关闭流。
				outer.end(message);
			}
		});

		// 同步返回事件流，异步工作尚未完成。
		return outer;
	};

	// streamSimple 直接委托给 stream：faux 不需要区分“完整选项”和“简单选项”，两者类型相同。
	const streamSimple: StreamFunction<string, SimpleStreamOptions> = (streamModel, context, streamOptions) =>
		// 原样转发三个参数。
		stream(streamModel, context, streamOptions);

	// 拉取一次延迟响应：同步返回事件流，微任务中校验句柄，按 pendingFetches 决定继续返回占位还是播放最终结果。
	// 最终结果只解析一次并缓存在 entry.final；失败路径（未知/已取消/工厂抛错）都在流里变成 error 事件。
	// 例 pendingFetches=1 时第一次 fetch 得到 deferred 占位，第二次得到真正回答并补 usage。
	const fetchDeferred = (
		// 当前请求模型；必须与提交时同 id，否则句柄校验失败。
		requestModel: Model<string>,
		// 调用方持有的句柄，id 用于查表。
		handle: DeferredHandle,
		// 可选拉取选项：onResponse 回调与本次 fetch 的取消信号。
		fetchOptions?: DeferredFetchOptions,
	): AssistantMessageEventStream => {
		// 创建事件流，立即返回。
		const outer = createAssistantMessageEventStream();
		// fetch 次数在同步阶段累加，便于测试断言。
		state.deferredFetchCount++;

		// 异步执行校验与解析；消费者已经可以监听 outer。
		queueMicrotask(async () => {
			// 兜底捕获校验失败、解析失败等所有异常。
			try {
				// 先调用可选 onResponse，再查表；状态码固定 200。
				await fetchOptions?.onResponse?.({ status: 200, headers: {} }, requestModel);
				// 根据 id 查找延迟条目。
				const entry = deferredResponses.get(handle.id);
				// 三项身份必须同时匹配：条目存在、provider 相同、modelId 相同、api 相同；否则视为伪造/过期句柄。
				if (
					// 没有该 id。
					!entry ||
					// 供应商不匹配。
					entry.handle.provider !== handle.provider ||
					// 模型不匹配。
					entry.handle.modelId !== handle.modelId ||
					// 协议不匹配。
					entry.handle.api !== handle.api
				) {
					// 抛错后由外层 catch 转成 error 流。
					throw new Error(`Unknown faux deferred response: ${handle.id}`);
				}
				// 已取消的条目不能再拉取。
				if (entry.cancelled) throw new Error(`Faux deferred response was cancelled: ${handle.id}`);

				// 还处于“占位”阶段：递减计数并再次返回 deferred 消息。
				if (entry.pendingFetches > 0) {
					// 每次只消耗一次，负数不会出现（进入分支时必为正）。
					entry.pendingFetches--;
					// 播放空内容的 deferred 协议；信号来自本次 fetch 选项。
					await streamWithDeltas(
						// 输出流。
						outer,
						// 同一个句柄，让调用方继续轮询。
						createDeferredMessage(requestModel, entry.handle),
						// 分片参数。
						minTokenSize,
						// 分片参数。
						maxTokenSize,
						// 速度。
						tokensPerSecond,
						// 本次拉取可被独立取消。
						fetchOptions?.signal,
					);
					// 占位分支结束。
					return;
				}

				// 最终结果尚未解析：现在执行脚本工厂并缓存。
				if (!entry.final) {
					// 解构剔除提交阶段的三个字段；其余选项留给工厂。
					const {
						// 提交时的 deferred 标记会强制延迟，不能传给最终解析（否则工厂看到错误状态）。
						deferred: _deferred,
						// 提交时的 AbortSignal 只属于最初请求，不应影响本次拉取。
						signal: _submissionSignal,
						// 提交时的 onResponse 已调用过，避免重复回调。
						onResponse: _submissionOnResponse,
						// rest 收集剩余选项；变量名前的下划线是“故意不用”的约定，不改变运行时。
						...submissionOptions
					} = entry.options ?? {};
					// 内层 try 只捕获工厂/克隆错误，把它们变成可播放的 error 消息；校验错误仍走外层。
					try {
						// 使用提交时的上下文、模型与选项解析，结果缓存供后续 fetch 复用。
						entry.final = await resolveResponse(entry.step, entry.context, submissionOptions, entry.model);
					} catch (error) {
						// 工厂失败也缓存成最终错误消息，保证之后每次 fetch 得到一致结果。
						entry.final = createErrorMessage(error, api, provider, entry.model.id);
					}
				}
				// 播放缓存的最终消息（成功或 error/aborted 脚本状态）。
				await streamWithDeltas(
					// 输出流。
					outer,
					// 此时已确定非空：要么原本有，要么上面的 if 刚赋值。
					entry.final,
					// 分片参数。
					minTokenSize,
					// 分片参数。
					maxTokenSize,
					// 速度。
					tokensPerSecond,
					// 本次 fetch 的取消信号。
					fetchOptions?.signal,
				);
			} catch (error) {
				// 未知句柄、已取消等错误统一转成协议消息。
				const message = createErrorMessage(error, api, provider, requestModel.id);
				// 推 error 事件。
				outer.push({ type: "error", reason: "error", error: message });
				// 关闭流。
				outer.end(message);
			}
		});

		// 同步返回事件流。
		return outer;
	};

	// 取消延迟响应：记录句柄快照、把条目标记为 cancelled、调用可选 onResponse；不删除条目，也不解析脚本。
	// 例 cancelDeferred(model, handle) 后再次 fetch 会得到“was cancelled”错误。
	const cancelDeferred = async (
		// 请求模型，仅用于 onResponse 回调。
		requestModel: Model<string>,
		// 要取消的句柄。
		handle: DeferredHandle,
		// 可选的取消回调与选项。
		cancelOptions?: DeferredCancelOptions,
	): Promise<void> => {
		// 在查找前深拷贝，保留调用时快照；即使之后 handle 被改也不影响记录。
		state.cancelledDeferred.push(structuredClone(handle));
		// 查找条目；未知 id 不会抛错，只是无法标记。
		const entry = deferredResponses.get(handle.id);
		// 找到才标记，避免对 undefined 赋值。
		if (entry) entry.cancelled = true;
		// 可选回调在标记后执行；await 让调用方等待回调完成。
		await cancelOptions?.onResponse?.({ status: 200, headers: {} }, requestModel);
	};

	// 按 id 查模型：无参返回默认（第一个）模型，有参找不到时返回 undefined。
	// 两个重载只影响编译期返回类型，运行时只有一个实现。
	function getModel(): Model<string>;
	// 传入 id 时返回可能缺失的模型。
	function getModel(requestedModelId: string): Model<string> | undefined;
	// 实现签名允许可选参数；重载列表对调用方隐藏这个实现。
	function getModel(requestedModelId?: string): Model<string> | undefined {
		// 空字符串和 undefined 都走默认模型；类型上调用方只能省略或传 string。
		if (!requestedModelId) {
			// 元组类型保证 [0] 一定存在。
			return models[0];
		}
		// 线性查找第一个 id 完全相等的模型；找不到返回 undefined。
		return models.find((candidate) => candidate.id === requestedModelId);
	}

	// 汇总核心能力；该对象被注册函数或 fauxProvider 继续包装。
	return {
		// 协议 id。
		api,
		// 供应商 id。
		provider,
		// 非空模型元组。
		models,
		// 流式入口。
		stream,
		// 简单流入口（与 stream 相同）。
		streamSimple,
		// 延迟拉取。
		fetchDeferred,
		// 延迟取消。
		cancelDeferred,
		// 模型查找。
		getModel,
		// 可变状态对象。
		state,
		// 整体替换待播脚本：先复制传入数组，调用方之后修改自己的数组不影响队列。
		setResponses(responses: FauxResponseStep[]) {
			// 新数组避免共享引用。
			pendingResponses = [...responses];
		},
		// 追加脚本到队尾：展开后逐个 push，保留已有步骤。
		appendResponses(responses: FauxResponseStep[]) {
			// push 允许传入多个参数。
			pendingResponses.push(...responses);
		},
		// 返回当前剩余步骤数，不包含已取走或延迟表中的步骤。
		getPendingResponseCount() {
			// 队列长度即剩余数。
			return pendingResponses.length;
		},
	};
}

// 把 faux 核心包装成可交给 Models 的 Provider 对象；不触碰全局注册表，适合每个测试自建独立 Models。
// 输入可选注册选项；输出 FauxProviderHandle，含 provider、api、models、getModel、state 和脚本队列操作。
// 副作用仅创建对象；auth.resolve 是异步占位，不读取环境变量，也不校验密钥。
// 示例：const faux = fauxProvider(); models.setProvider(faux.provider); faux.setResponses([fauxAssistantMessage("hi")]);
/**
 * Faux provider for tests built on explicit `Models` collections:
 *
 * ```ts
 * const faux = fauxProvider();
 * const models = createModels();
 * models.setProvider(faux.provider);
 * faux.setResponses([fauxAssistantMessage("hi")]);
 * ```
 */
export function fauxProvider(options: RegisterFauxProviderOptions = {}): FauxProviderHandle {
	// 默认参数 {} 允许无参调用；创建独立核心，队列和缓存互不共享。
	const core = createFauxCore(options);
	// 用统一的 createProvider 构造 Provider；它负责把模型表与 api 适配器组装成 Models 需要的形状。
	const provider = createProvider({
		// 供应商 id 来自核心。
		id: core.provider,
		// 伪造一条 API key 认证：名称仅用于展示，resolve 直接返回空 auth，不发起任何 I/O。
		auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
		// 直接复用核心模型元组。
		models: core.models,
		// 四个流/延迟函数即 Provider 的 API 实现。
		api: {
			// 完整流入口。
			stream: core.stream,
			// 简单流入口。
			streamSimple: core.streamSimple,
			// 延迟拉取。
			fetchDeferred: core.fetchDeferred,
			// 延迟取消。
			cancelDeferred: core.cancelDeferred,
		},
	});
	// 返回句柄：保留核心可操作能力，同时提供已组装的 provider。
	return {
		// 供 Models.setProvider 使用。
		provider,
		// 协议 id，便于测试构造期望值。
		api: core.api,
		// 模型元组。
		models: core.models,
		// 模型查找函数引用。
		getModel: core.getModel,
		// 共享状态引用。
		state: core.state,
		// 替换队列。
		setResponses: core.setResponses,
		// 追加队列。
		appendResponses: core.appendResponses,
		// 查询剩余数。
		getPendingResponseCount: core.getPendingResponseCount,
	};
}
