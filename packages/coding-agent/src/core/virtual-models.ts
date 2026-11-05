/**
 * Virtual models are catalog entries that route each request to a physical model.
 *
 * The selection (`model_change`, `agent.state.model`, `ctx.model`) may name a virtual model.
 * Everything below the routing step only sees physical models: providers stream them and
 * assistant messages record them. A virtual model never reaches a provider.
 *
 * Virtual models belong to a provider id but are not provider models. `ModelRuntime` keeps them
 * separately and adds them to the provider's catalog with `withVirtualModels()`, so any provider,
 * including one with physical models, can list several virtual models.
 */
// 虚拟模型是供选择的“路由入口”，上层选中它，再由 ModelRuntime/AgentSession 找物理模型；本文件提供目录包装与分支状态辅助。
// AgentMessage 包含应用自定义消息，比纯模型协议 Message 更宽。
import type { AgentMessage } from "@earendil-works/pi-agent-core";
// 同一 import 中 type 前缀只引入类型，其余名字会在运行时使用。
import {
	// AnyModel 覆盖聊天、图片、分类等目录条目。
	type AnyModel,
	// Api 表示聊天 API 协议类型。
	type Api,
	// 助手结果包含实际提供商、模型 ID、stopReason 与用量。
	type AssistantMessage,
	// 事件流可以逐个消费增量，也能等待最终消息。
	type AssistantMessageEventStream,
	// 按模型类别判断，兼容未显式写 type 的聊天模型。
	isModelType,
	// 同步返回外层事件流并立即开始 setup；setup 错误变成流错误，而非等迭代时才启动。
	lazyStream,
	// 路由读取的是已经转换为模型协议的消息列表。
	type Message,
	// Model<Api> 是聊天模型描述，不是已打开的连接。
	type Model,
	// 允许的思考级别字符串联合类型。
	type ModelThinkingLevel,
	// 提供商承载目录、认证和实际请求能力。
	type Provider,
	// 思考级别映射可以把不支持的级别标为 null。
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
// 会话原始条目组成分支；包含模型切换、消息、自定义状态等不同 type。
import type { SessionEntry } from "./session-manager.ts";

/** API id of virtual catalog entries. Requests for it fail unless routed first. */
/** 虚拟目录条目的 API 标记；例：api=pi-virtual 用于辨认路由入口，不对应远端 HTTP 协议。 */
export const VIRTUAL_MODEL_API = "pi-virtual";

/** Custom entry type that stores router state on the session branch. */
/** 记录路由状态的自定义会话条目类型；状态随分支保存，不写成一条用户消息。 */
export const VIRTUAL_MODEL_STATE_ENTRY = "pi.virtual-model-state";

/** Data of a `pi.virtual-model-state` custom entry. */
/** 路由状态数据；TState 允许路由器定义状态结构，默认 unknown 要求读取后先明确其类型。 */
export interface VirtualModelStateData<TState = unknown> {
	// 提供商与模型 ID 共同定位是哪一个虚拟入口的状态。
	provider: string;
	// 同一提供商下多个虚拟模型不共用状态键。
	modelId: string;
	// 状态值由路由器管理；可持久化数据应能 JSON 序列化，泛型本身不能保证这一点。
	state: TState;
}

// 统一列出所有可映射的思考级别，构建目录时逐档标注支持与否。
const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Why a request is being routed.
 * - `user`: first request after a message the user wrote (prompt, steering, or follow-up)
 * - `continuation`: any other request in the agent loop, e.g. after tool results or extension messages
 * - `retry`: automatic retry after a failed request, including after compaction for a context overflow
 * - `direct`: a request outside the agent loop, e.g. a compaction summary or an extension call
 */
/** 路由原因：用户首轮 user、普通续轮 continuation、失败恢复 retry、循环外摘要等 direct；路由器可按原因选模型。 */
export type ModelRouteReason = "user" | "continuation" | "retry" | "direct";

/** 路由输入，例：根据 messages 长度及 reason 决定这次用快模型还是大模型；并不自行发送请求。 */
export interface ModelRouteRequest<TState = unknown> {
	/** The selected virtual model. */
	// 这里是用户选中的虚拟模型，不是之前已经回答过的物理模型。
	model: Model<Api>;
	/** The selected thinking level. Its meaning is up to the router. */
	// 用户选定的思考档位可由路由器解释，再给出物理档位。
	thinkingLevel: ModelThinkingLevel;
	// 使用上面的字符串联合类型，不能任意拼另一种原因名。
	reason: ModelRouteReason;
	/** Physical model and thinking level of the latest successful response in `messages`. */
	// previous 可缺省；存在时记录最近成功回复的物理模型，可选保存其思考级别。
	previous?: { model: Model<Api>; thinkingLevel?: ModelThinkingLevel };
	/**
	 * For `retry`: the failed request, which `messages` no longer contains. `message` carries its
	 * `stopReason` and `errorMessage`. Absent when the router itself failed.
	 */
	// 失败模型信息与消息单列，因为失败尝试可能已从本次 messages 中投影隐去；路由本身失败时可能没有此字段。
	failed?: { model: Model<Api>; thinkingLevel?: ModelThinkingLevel; message: AssistantMessage };
	/** Router state last returned on this session branch. Undefined before the first state and for `direct` requests. */
	// 当前分支上次保存的状态；direct 请求不读取/更新这份会话路由状态。
	state?: TState;
	/** Conversation for this request, including system messages. */
	// 包含系统消息的模型上下文；readonly 限制数组增删，不是运行时深冻结。
	messages: readonly Message[];
	// 路由回调可能异步，需主动检查或转交 signal 才能响应取消。
	signal?: AbortSignal;
}

/** Physical model and thinking level for one request. */
/** 路由输出：真正使用的物理模型、思考级别与可选下一状态；例如返回另一家已配置认证的模型。 */
export interface ModelRoute<TState = unknown> {
	// 物理模型是后续 Provider 真正会收到的 model。
	model: Model<Api>;
	// 输出的级别还可能由 ModelRuntime 按该物理模型支持能力钳制。
	thinkingLevel: ModelThinkingLevel;
	/**
	 * New router state, stored on the session branch unless it is `request.state` itself. Return
	 * `request.state` or undefined to keep the current state. Must be JSON-serializable. Ignored for
	 * `direct` requests.
	 */
	// 返回原 state 引用或 undefined 表示沿用，返回新状态则由上层按分支保存；本接口不会实际落盘。
	state?: TState;
}

/** 注册一个虚拟模型及路由函数；目录元数据供选择，route 决定每次真实请求的目标。 */
export interface VirtualModelDefinition<TState = unknown> {
	/** Provider the virtual model is listed under. May be a provider with physical models. */
	// 入口可挂在已有物理模型的提供商下，也可挂在专用提供商下。
	provider: string;
	/** Model id. Must not be the id of a physical model of `provider`. */
	// 注册时 ID 不得撞已有物理模型；之后远端目录新添同名条目时，包装器仍会隐藏它。
	id: string;
	// 用户菜单中的显示名，实际请求记录会写路由后的物理模型。
	name: string;
	/** Thinking levels offered for selection. Defaults to `["off"]`. */
	// 只列允许用户选择的档位；未配置默认 off，不代表物理模型全部不支持思考。
	thinkingLevels?: readonly ModelThinkingLevel[];
	/**
	 * Limits shown before the first response. Afterwards, Pi uses the limits of the physical model
	 * that answered. Unset limits are unknown (0).
	 */
	// 首次回复前用于显示的预估窗口；省略按未知 0 展示，后续上层可用实际回复模型容量。
	contextWindow?: number;
	// 同样用于初始显示的输出上限，不会由这个字段把物理模型变大。
	maxTokens?: number;
	/** Input types accepted for selection. Defaults to text and images; routed models without image support get placeholders. */
	// 入口默认接受文字和图片；路由到不支持图片的模型时，上层会处理图片占位转换。
	input?: ("text" | "image")[];
	/** Pick the physical model, which must have credentials, and thinking level for one request. */
	// 方法签名允许同步结果或 Promise；TState 把输入与输出状态类型关联起来。
	route(request: ModelRouteRequest<TState>): ModelRoute<TState> | Promise<ModelRoute<TState>>;
}

/** Whether a model or message names a virtual model. Failed routing leaves the virtual model on its message. */
/** 只按 api 标记判断虚拟入口；例如失败路由的助手消息也可能保留 pi-virtual。 */
export function isVirtualModel(model: { api: string }): boolean {
	// 参数只要求有 api 字符串，因此模型描述和消息都可使用；不查目录、不验证路由。
	return model.api === VIRTUAL_MODEL_API;
}

/** Latest successful response. Its model is physical: failed or aborted requests, including failed routing, are skipped. */
/** 从后往前找非 error/aborted 的助手回复；如工具调用回复也算成功结果，不要求一定是最终文字。 */
export function findLatestResponse(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	// 倒序扫描优先找到最近一条，找到就返回，不收集所有回复。
	for (let i = messages.length - 1; i >= 0; i--) {
		// 取当前消息，随后按 role 缩小 AgentMessage 的联合类型。
		const message = messages[i];
		// 排除普通失败与用户中止；“物理模型”依赖正常路由协议，并非此函数又查了一遍目录。
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
			// 直接返回原消息引用，没有深复制或改写历史。
			return message;
		}
	}
	// 没有符合条件的助手消息时返回 undefined。
	return undefined;
}

/**
 * The model selection a session branch records. A virtual `model_change` holds until the next
 * `model_change`, because responses name the physical models it routed to. Otherwise the latest
 * physical response wins, as in sessions without virtual models. A virtual model that is no longer
 * registered does not hold, so the selection falls back to the physical model that answered last.
 *
 * Only the last `model_change` can hold, so this looks up at most one model in the catalog.
 */
/** 还原分支的模型选择；例：选虚拟 V 后它用物理 P 回答，仍保留 V 为用户选择，除非 V 已注销。 */
export function getBranchSelection(
	// 输入是当前分支的原始会话条目顺序，不是混合其他分支的全文件列表。
	branch: readonly SessionEntry[],
	// 查询函数只在需要判断一次旧 model_change 是否仍是已注册虚拟模型时使用。
	getModel: (provider: string, modelId: string) => Model<Api> | undefined,
	// 只返回提供商与模型 ID；不是返回整个 Model 对象或认证结果。
): { provider: string; modelId: string } | undefined {
	// 从最近条目向过去看，最新模型变化/物理响应优先参与选择。
	for (let i = branch.length - 1; i >= 0; i--) {
		// 每个 entry 是带 type 的联合类型。
		const entry = branch[i];
		// 如果先遇到显式切换，直接认这个记录；此分支不额外检查它当前还在不在目录。
		if (entry.type === "model_change") {
			// 返回对象属性中的键名和局部变量名可不同，例如 modelId 来自 entry.modelId。
			return { provider: entry.provider, modelId: entry.modelId };
		}
		// 遇到物理助手消息时进入恢复判断；这里没有排除 error/aborted，不能套用 findLatestResponse 的成功筛选。
		if (entry.type === "message" && entry.message.role === "assistant" && !isVirtualModel(entry.message)) {
			// 先把实际物理响应作为默认选择。
			const response = { provider: entry.message.provider, modelId: entry.message.model };
			// 只找这一条响应之前最后一次显式模型切换。
			const change = findLastModelChange(branch, i);
			// 有切换记录才访问目录；&& 短路避免给 undefined 取字段。
			const model = change && getModel(change.provider, change.modelId);
			// 该切换仍指向已登记虚拟模型就保留虚拟选择，否则用实际物理响应；不遍历所有旧切换逐个查目录。
			return change && model && isVirtualModel(model) ? change : response;
		}
	}
	// 既没有切换也没有可用物理助手条目时，交由调用方选择默认模型。
	return undefined;
}

/** 找指定下标之前最后一次 model_change；例如响应前是 V→W，就只返回 W，不检查目录或认证。 */
function findLastModelChange(
	// 与调用者传入同一分支，避免跨分支误用模型选择。
	branch: readonly SessionEntry[],
	// before 是排除的当前位置，扫描从 before-1 开始。
	before: number,
	// 返回轻量 ID 对，没有则 undefined。
): { provider: string; modelId: string } | undefined {
	// i-- 每轮向前走一步，直到分支起点。
	for (let i = before - 1; i >= 0; i--) {
		// 先取当前条目，再依 type 判断。
		const entry = branch[i];
		// 找到第一个即返回，因此自然是 before 之前最近的切换。
		if (entry.type === "model_change") return { provider: entry.provider, modelId: entry.modelId };
	}
	// 扫描完仍没找到时返回 undefined。
	return undefined;
}

/** Latest router state a session branch stores for a virtual model. */
/** 找分支上某虚拟模型最近保存的状态；例如 V 的状态不会被同一提供商下 W 的自定义条目覆盖。 */
export function getVirtualModelState(branch: readonly SessionEntry[], provider: string, modelId: string): unknown {
	// 倒序优先最近一次保存，和路由状态随分支演进的语义对应。
	for (let i = branch.length - 1; i >= 0; i--) {
		// 原始条目可能是消息、配置变化或其他扩展自定义数据。
		const entry = branch[i];
		// 先筛 type 与 customType，跳过不是路由状态的条目。
		if (entry.type !== "custom" || entry.customType !== VIRTUAL_MODEL_STATE_ENTRY) continue;
		// as 仅按该自定义协议断言结构，不在此做完整运行时数据校验。
		const data = entry.data as VirtualModelStateData | undefined;
		// 可选链处理缺数据；提供商和模型 ID 都相同才返回原 state 引用。
		if (data?.provider === provider && data.modelId === modelId) return data.state;
	}
	// 还没保存过该模型状态就返回 undefined，由路由器决定初始状态。
	return undefined;
}

/** Build the catalog entry of a virtual model. */
/** 从定义生成虚拟目录元数据；Omit<..., "route"> 表示这里不需要路由函数，函数另由运行时保管。 */
export function createVirtualModel(definition: Omit<VirtualModelDefinition, "route">): Model<Api> {
	// 省略时默认只开放 off；显式空数组不会被 ?? 换成默认值。
	const levels = definition.thinkingLevels ?? ["off"];
	// 先建空映射，再按全部已知档位填支持与不支持项。
	const thinkingLevelMap: ThinkingLevelMap = {};
	// 选中的档位映射为自己，其他档位为 null；例如只含 off/high 就禁用其余档位。
	for (const level of THINKING_LEVELS) thinkingLevelMap[level] = levels.includes(level) ? level : null;
	// 返回符合聊天模型接口的目录对象，不是请求结果。
	return {
		// ID 与提供商一起标识入口。
		id: definition.id,
		// 显示名直接来自定义。
		name: definition.name,
		// 虚拟 API 标记让后续路由与流防线能识别它。
		api: VIRTUAL_MODEL_API,
		// 保留虚拟模型挂靠的提供商；真实回复会记录目标物理提供商。
		provider: definition.provider,
		// 空地址是占位，不会被用于真的 HTTP 请求。
		baseUrl: "",
		// some 检查至少一个非 off 档位，决定是否在目录上标有思考能力。
		reasoning: levels.some((level) => level !== "off"),
		// 属性简写，使用刚计算的完整档位映射。
		thinkingLevelMap,
		// 默认入口允许 text/image；不等于每个可能路由目标都有图片能力。
		input: definition.input ?? ["text", "image"],
		// 零成本是入口的目录占位，不代表路由后的模型免费。
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// 没有容量声明时用 0 表示未知，不是无限上下文。
		contextWindow: definition.contextWindow ?? 0,
		// 输出上限同样先显示未知值；这里不校验数字是否正数。
		maxTokens: definition.maxTokens ?? 0,
	};
}

/** Stream for a virtual model that was not routed, e.g. `stream()` with API-specific options. */
/** 返回明确的错误流，防止把未路由的虚拟入口当物理 API 发送；例：直接对虚拟模型调用特定 API stream。 */
function unroutedStream(model: Model<Api>): AssistantMessageEventStream {
	// lazyStream 立即执行异步 setup，抛错会转成外层 error 事件与最终错误消息。
	return lazyStream(model, async () => {
		// 只报告需要先路由，不尝试偷偷挑一个默认物理模型。
		throw new Error(`Virtual model ${model.provider}/${model.id} must be routed before streaming`);
	});
}

/**
 * Add virtual models to a provider's catalog. Without a provider, the result is a keyless provider
 * that only lists the virtual models. A virtual model hides a physical chat model with the same id,
 * which a catalog refresh can add after registration. Availability follows the provider's auth.
 */
/** 将虚拟条目加入目录；例：虚拟 chat/x 隐藏同名物理 chat/x，但图片 x 仍可保留。 */
export function withVirtualModels(
	// 指定目录所属提供商 ID。
	providerId: string,
	// 允许没有底层物理提供商，此时创建只列虚拟模型的外观。
	provider: Provider | undefined,
	// 这是需要加入的虚拟聊天目录，不在本函数执行 route 回调。
	virtualModels: readonly Model<Api>[],
	// 返回 Provider 供 Models 枚举/检查/分派；实际路由在更上层处理。
): Provider {
	// 没有底层提供商时，不能假装有一套真实网络请求实现。
	if (!provider) {
		// 构造仅含虚拟目录和拒绝未路由请求的 Provider。
		return {
			// 供 Models 根据 ID 查找此入口。
			id: providerId,
			// 默认显示名也用同一个 ID。
			name: providerId,
			// 返回无 key 的认证结果，并标明 virtual 来源；物理路由目标是否有认证仍由运行时检查。
			auth: { apiKey: { name: "Virtual model", resolve: async () => ({ auth: {}, source: "virtual" }) } },
			// 直接返回传入的只读虚拟目录；不深复制。
			getModels: () => virtualModels,
			// 特定 API 的 stream 也拒绝直接发虚拟请求。
			stream: unroutedStream,
			// 统一参数 streamSimple 同样需要上层先完成路由。
			streamSimple: unroutedStream,
		};
	}
	// Set 保存虚拟 ID，便于判定哪些物理聊天条目应被隐藏。
	const ids = new Set(virtualModels.map((model) => model.id));
	// 泛型箭头函数保留输入模型元素的类型，能用于聊天目录或混合目录。
	const physical = <TModel extends AnyModel>(models: readonly TModel[]) =>
		// 先去掉已有虚拟条目，再隐藏同 ID 的物理聊天模型；不隐藏同 ID 的非聊天模型。
		models.filter((model) => !isVirtualModel(model) && !(isModelType(model, "chat") && ids.has(model.id)));
	// 另一个局部筛选函数只保留虚拟项，用于调用物理过滤器后再补回。
	const virtual = <TModel extends AnyModel>(models: readonly TModel[]) =>
		// 判断依据仍是 api 标记，不会执行路由器。
		models.filter((model) => isVirtualModel(model));
	// 解构保留底层筛选函数，避免下面覆写后的方法递归调用自己。
	const { filterModels, filterAllModels } = provider;
	// 返回浅包装对象，保留其他原提供商功能。
	return {
		// auth 等未重写字段仍沿用原引用，因此可用性继续受底层提供商认证规则影响。
		...provider,
		// 每次枚举先取物理基线并过滤冲突，再追加当前虚拟模型。
		getModels: () => [...physical(provider.getModels()), ...virtualModels],
		// 全类型目录保留图片/分类；旧提供商缺 getAllModels 时退回聊天目录。
		getAllModels: () => [...physical(provider.getAllModels?.() ?? provider.getModels()), ...virtualModels],
		// 按凭证过滤模型时，只把物理部分交给底层过滤器。
		filterModels: (models, credential) => {
			// real 是过滤冲突后的物理候选，不包含虚拟入口。
			const real = physical(models);
			// 底层可无过滤器，此时保留 real；最后把本批输入里的虚拟项加回，不让物理权限规则误删它们。
			return [...(filterModels?.(real, credential) ?? real), ...virtual(models)];
		},
		// 全类型过滤入口仅在底层本身存在此能力时提供。
		filterAllModels:
			// && 会在底层没有函数时得到 undefined，不强行伪造新能力。
			filterAllModels &&
			// 同样只过滤物理部分，再追加本批虚拟项；不会把聊天过滤器套到所有非聊天模型上。
			((models, credential) => [...filterAllModels(physical(models), credential), ...virtual(models)]),
		// 流调用根据实际模型是否虚拟分流。
		stream: (model, context, options) =>
			// 虚拟就产生错误流，物理才交给原 provider.stream。
			isVirtualModel(model) ? unroutedStream(model) : provider.stream(model, context, options),
		// 统一参数聊天入口使用同样防线。
		streamSimple: (model, context, options) =>
			// 这个包装器不自己解析认证、路由或更改上下文，继续委托底层物理实现。
			isVirtualModel(model) ? unroutedStream(model) : provider.streamSimple(model, context, options),
	};
}
