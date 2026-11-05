// 旧版全局 API 兼容入口：集中重导出旧名字，维护聊天分发表，并在调用时衔接静态内置供应商与环境密钥；新应用可直接使用 Models 实例。
/**
 * Temporary compatibility entrypoint preserving the old global pi-ai API
 * surface: api-dispatch `stream()`/`complete()` with env API key injection,
 * the api-registry, generated catalog reads (`getModel`/`getModels`/
 * `getProviders`), per-API lazy stream wrappers, and image generation.
 *
 * Existing apps switch imports from "@earendil-works/pi-ai" to
 * "@earendil-works/pi-ai/compat" unchanged; new code uses `createModels()`
 * and the provider factories. This module is deleted with the coding-agent
 * ModelManager migration.
 */

// export * 重导出目标模块的具名导出；这组轻量工厂推迟实际 SDK 加载，但不等于整个 compat 模块没有求值副作用。
export * from "./api/anthropic-messages.lazy.ts";
// Azure Responses 的延迟适配工厂。
export * from "./api/azure-openai-responses.lazy.ts";
// AWS Bedrock 的延迟适配工厂。
export * from "./api/bedrock-converse-stream.lazy.ts";
// Google API key 路径的延迟适配工厂。
export * from "./api/google-generative-ai.lazy.ts";
// Google Vertex 路径的延迟适配工厂。
export * from "./api/google-vertex.lazy.ts";
// Mistral 对话适配工厂。
export * from "./api/mistral-conversations.lazy.ts";
// Codex Responses 适配工厂。
export * from "./api/openai-codex-responses.lazy.ts";
// OpenAI Chat Completions 适配工厂。
export * from "./api/openai-completions.lazy.ts";
// OpenAI Responses 适配工厂。
export * from "./api/openai-responses.lazy.ts";
// Pi 消息协议适配工厂。
export * from "./api/pi-messages.lazy.ts";
// 旧调用方仍能通过此入口使用环境密钥查找助手。
export * from "./env-api-keys.ts";
// 图片静态目录的旧读取函数。
export * from "./image-models.ts";
// 全局图片生成入口；其依赖模块会安装内置图片注册。
export * from "./images.ts";
// 全局图片 API 注册接口，与下方聊天注册表独立。
export * from "./images-api-registry.ts";
// 同时暴露新的核心 API，使迁移期间可以从一个入口引用。
export * from "./index.ts";
// 保留旧版各供应商流函数的别名。
export * from "./legacy-api-aliases.ts";
// 暴露图片内置注册与延迟生成包装器。
export * from "./providers/images/register-builtins.ts";

// 下组值导入用于创建内置轻量流实现；重导出本身不会在当前文件建立可直接使用的同名局部变量。
import { anthropicMessagesApi } from "./api/anthropic-messages.lazy.ts";
// Azure 工厂，实际请求模块仍由延迟包装加载。
import { azureOpenAIResponsesApi } from "./api/azure-openai-responses.lazy.ts";
// Bedrock 工厂，不在这条导入处发 AWS 请求。
import { bedrockConverseStreamApi } from "./api/bedrock-converse-stream.lazy.ts";
// Google API key 路径工厂。
import { googleGenerativeAIApi } from "./api/google-generative-ai.lazy.ts";
// Vertex 路径工厂。
import { googleVertexApi } from "./api/google-vertex.lazy.ts";
// Mistral 工厂。
import { mistralConversationsApi } from "./api/mistral-conversations.lazy.ts";
// Codex 工厂。
import { openAICodexResponsesApi } from "./api/openai-codex-responses.lazy.ts";
// Completions 工厂。
import { openAICompletionsApi } from "./api/openai-completions.lazy.ts";
// Responses 工厂。
import { openAIResponsesApi } from "./api/openai-responses.lazy.ts";
// Pi 消息工厂。
import { piMessagesApi } from "./api/pi-messages.lazy.ts";
// 查询请求 env/进程环境中的密钥或环境认证占位标记，不在此执行 OAuth 交换。
import { getEnvApiKey } from "./env-api-keys.ts";
// Models 请求选项只用于描述 Cloudflare 特殊分发分支的参数。
import type { ModelsApiStreamOptions } from "./models.ts";
// builtinModels 创建内置供应商集合；后三个助手只读生成的静态聊天目录。
import { builtinModels, getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "./providers/all.ts";

// 只重导出内置供应商键的类型，运行时没有 BuiltinProvider 变量。
export type { BuiltinProvider } from "./providers/all.ts";

// Faux 核心提供本地脚本回复及控制接口；此文件负责把它接入旧全局分发表。
import { createFauxCore, type FauxProviderRegistration, type RegisterFauxProviderOptions } from "./providers/faux.ts";
// 泛型 API/模型、流及上下文契约，编译后不留下这些 type 导入。
import type {
	Api,
	ApiStreamOptions,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	ProviderStreams,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TranscriptContext,
} from "./types.ts";
// 将旧顶层 systemPrompt/tools 转成 transcript 的初始 system 消息，再交给实际流实现。
import { normalizeContext } from "./utils/transcript.ts";

/** @deprecated Static catalog read. Use `getBuiltinModel` from "@earendil-works/pi-ai/providers/all" or `Models.getModel()`. */
// 静态查询的直接别名，保留原函数泛型签名；输入供应商和对应模型键，返回生成的聊天模型对象，无请求或认证副作用。例如目录中同一键重复查询得到同一对象。
// 不读取下方 compatModels 的远端刷新或认证状态；合法键由类型约束，绕过检查传无效键仍可能得到 undefined。
export const getModel = getBuiltinModel;

/** @deprecated Static catalog read. Use `getBuiltinModels` from "@earendil-works/pi-ai/providers/all" or `Models.getModels()`. */
// 输入供应商名，返回生成聊天目录的模型数组，无请求或认证副作用；例如用来列出某供应商静态菜单项。不是图片目录，也不是已认证模型筛选。
export const getModels = getBuiltinModels;

/** @deprecated Static catalog read. Use `getBuiltinProviders` from "@earendil-works/pi-ai/providers/all" or `Models.getProviders()`. */
// 无参数，返回生成聊天目录中的供应商名新数组，无请求副作用；例如展示所有静态供应商选项，不从全局 API 注册表反推供应商。
export const getProviders = getBuiltinProviders;

// 内部统一流签名：调用后立即得到事件流对象，最终回复通过流的 result() Promise 取得。
export type ApiStreamFunction = (
	// 泛化 API 后的聊天模型描述。
	model: Model<Api>,
	// 已规范化的消息轨迹，不再使用旧顶层 systemPrompt/tools。
	context: TranscriptContext,
	// 可省略的公共原始流选项。
	options?: StreamOptions,
) => AssistantMessageEventStream;

// 简化选项流签名；与上面的区别是 options 接受跨供应商的 SimpleStreamOptions。
export type ApiStreamSimpleFunction = (
	// 仍是聊天模型，非图片/分类模型。
	model: Model<Api>,
	// 真实实现收到统一 transcript 上下文。
	context: TranscriptContext,
	// 由下层适配器把通用思考等级等选项转换成各 API 配置。
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

// 一个全局聊天 API 实现；extends 约束泛型，= 设置省略泛型时的默认类型，不会生成运行时检查。
export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
	// 注册键对应 API 协议，不要求与供应商名相同。
	api: TApi;
	// 原始流实现保留自己的模型 API 与选项类型。
	stream: StreamFunction<TApi, TOptions>;
	// 简化流也绑定同一 API，选项统一为 SimpleStreamOptions。
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

// 存储端擦去各注册实现不同的泛型；包装函数会先核对 model.api。
interface ApiProviderInternal {
	// 当前实现的 API 名称。
	api: Api;
	// 包装后的公共原始流函数。
	stream: ApiStreamFunction;
	// 包装后的公共简化流函数。
	streamSimple: ApiStreamSimpleFunction;
}

// Map 一项还记可选来源，以便扩展或 Faux 按自己的来源卸载当前条目。
type RegisteredApiProvider = {
	// 新建的内部对象，与传入注册函数的外部对象不是同一个引用。
	provider: ApiProviderInternal;
	// 没传来源的条目仍可存在，不会自动分配来源。
	sourceId?: string;
};

// 模块级共享表，只保存每个 API 的当前实现；同键覆盖不形成可回滚的注册栈。
const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

// 用途：把某 API 的原始流函数转为内部统一签名。输入 API 和函数，返回闭包；例如 A 实现收到 model.api=B 时同步抛错，匹配时原样委托。
// 包装阶段不发请求；调用时只验证 API 字符串，as 不验证模型其他字段或选项，实际流副作用与错误处理属于被包装函数。
function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
	// 闭包捕获的预期 API。
	api: TApi,
	// 捕获当前函数值；以后修改外部 provider.stream 不会自动替换此引用。
	stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
	// 普通箭头函数不是 async，API 检查与下层调用都可能同步抛错。
	return (model, context, options) => {
		// 统一存储签名允许较宽模型，调用前用实际 API 值重新核对。
		if (model.api !== api) {
			// 不能把另一协议的模型直接交给本实现。
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		// 两处 as 连接泛型与公共存储签名，不转换任何运行时值或把异常变成流事件。
		return stream(model as Model<TApi>, context, options as TOptions);
	};
}

// 用途：包装简化选项流实现，输入 API 和函数，输出统一签名闭包；流程同原始流，但选项已经统一，无需把 options 断言成专有类型。
// 例注册 A 后向此包装器传 B 模型会同步抛错；匹配时返回实际事件流，本层不转换思考配置、不消费事件，也不捕获错误。
function wrapStreamSimple<TApi extends Api>(
	// 要求匹配的 API 名称。
	api: TApi,
	// 某 API 的简化流函数引用。
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
): ApiStreamSimpleFunction {
	// 保存参数形成闭包，供以后每次请求使用。
	return (model, context, options) => {
		// 这里只验证 API，非完整模型 schema。
		if (model.api !== api) {
			// 模板字符串报告实际值和预期值。
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		// 模型类型断言在编译期消除差异；上下文和选项直接透传。
		return streamSimple(model as Model<TApi>, context, options);
	};
}

// 用途：安装全局聊天 API，输入实现及可选来源，无返回值；同 API 后注册覆盖先注册。例如扩展可用自定义 Completions 实现替换默认实现。
// 流程：按 api 建键、包装两种流、保存来源；注册本身不发请求，不注册模型目录，也不保留旧实现供卸载后恢复。
export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	// 泛型关联 API、模型与原始流选项。
	provider: ApiProvider<TApi, TOptions>,
	// 可选来源用于按来源删除；省略则记录 undefined。
	sourceId?: string,
): void {
	// 同键覆盖当前值，不改变键原来的插入位置。
	apiProviderRegistry.set(provider.api, {
		// 保存注册时的字段和函数引用，不直接存原 provider 对象。
		provider: {
			// 保留协议名。
			api: provider.api,
			// 原始流安装 API 一致性检查。
			stream: wrapStream(provider.api, provider.stream),
			// 简化流同样先检查 API 再委托。
			streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
		},
		// 属性简写，等价于 sourceId: sourceId。
		sourceId,
	});
}

// 用途：按 API 查当前实现，返回内部对象或 undefined；例如查询已注册 A 得到包装对象。仅查内存，无请求或复制，返回对象仍与注册表共享。
export function getApiProvider(api: Api): ApiProviderInternal | undefined {
	// 可选链在没找到记录时返回 undefined。
	return apiProviderRegistry.get(api)?.provider;
}

// 用途：枚举当前聊天 API 实现，无输入，返回新数组；例如展示已装协议。按 Map 键插入顺序列出，元素仍为共享内部对象，不公开 sourceId。
export function getApiProviders(): ApiProviderInternal[] {
	// Array.from 的映射回调逐项抽取 provider。
	return Array.from(apiProviderRegistry.values(), (entry) => entry.provider);
}

// 用途：按 sourceId 删除当前匹配条目，无返回值。例 X 注册后被 Y 覆盖，卸载 X 不会删掉 Y；也不会恢复 X 曾覆盖的旧实现。
// 只修改注册表，不取消已经取得函数并在运行中的请求。
export function unregisterApiProviders(sourceId: string): void {
	// 解构每条 Map 记录的键和值。
	for (const [api, entry] of apiProviderRegistry.entries()) {
		// 用当前来源字符串严格相等判断归属。
		if (entry.sourceId === sourceId) {
			// 删除匹配键，没有调用实现的清理回调。
			apiProviderRegistry.delete(api);
		}
	}
}

// 用途：内部清空聊天表，无输入输出，供 reset 在重装前使用。例 reset 删除测试覆盖时会调用此处；不清图片表或外部持有的 Faux 队列。
function clearApiProviders(): void {
	// 清除所有当前实现及来源记录。
	apiProviderRegistry.clear();
}

// 用途：创建本地脚本回复核心并接入全局聊天表；输入可选模型/脚本/节奏配置，返回模型、共享状态、队列控制与卸载句柄。
// 流程：创建核心、生成来源、注册两种流、暴露控制器。例如令 r 为返回句柄，r.setResponses([fauxAssistantMessage("你好")]) 后，complete(r.getModel(), context) 消费一次脚本回复。
// 核心使用本地脚本而非自带外部模型服务请求，自定义响应回调的副作用由回调决定；这里只注册 stream/streamSimple，不接入核心的 deferred 接口；指定已有 API 时仍覆盖当前项。
export function registerFauxProvider(options: RegisterFauxProviderOptions = {}): FauxProviderRegistration {
	// 默认 {} 在省略或传 undefined 时采用；核心创建模型、队列及调用/模拟缓存状态。
	const core = createFauxCore(options);
	// 随机数转 36 进制后截取作为来源后缀，不是密码学唯一性保证。
	const sourceId = `faux-provider-${Math.random().toString(36).slice(2, 10)}`;
	// 发布两种流，并把来源与当前条目一起保存。
	registerApiProvider({ api: core.api, stream: core.stream, streamSimple: core.streamSimple }, sourceId);
	// 控制句柄直接复用核心函数/状态，没有复制出另一套队列。
	return {
		// 实际使用的 API，可由选项指定或由核心生成。
		api: core.api,
		// 核心构造出的模型数组。
		models: core.models,
		// 省略 ID 取首模型，提供 ID 时查该模型。
		getModel: core.getModel,
		// 共享调用次数等可观察状态。
		state: core.state,
		// 替换待消费的脚本回复队列。
		setResponses: core.setResponses,
		// 在队尾追加脚本回复。
		appendResponses: core.appendResponses,
		// 查询剩余脚本数量。
		getPendingResponseCount: core.getPendingResponseCount,
		// 用途：无参数/返回值，按闭包来源卸载本次当前注册。例如另一来源已经覆盖它时不会删除另一来源；不清队列或恢复先前实现。
		unregister() {
			// sourceId 由外层函数捕获，调用方不必重新提供。
			unregisterApiProviders(sourceId);
		},
	};
}

// 二元组数组的每项是 [协议名,流集合]；工厂在此创建轻量延迟包装，不在此发模型请求。
const BUILTIN_APIS: [Api, ProviderStreams][] = [
	// Anthropic Messages。
	["anthropic-messages", anthropicMessagesApi()],
	// OpenAI Chat Completions。
	["openai-completions", openAICompletionsApi()],
	// OpenAI Responses。
	["openai-responses", openAIResponsesApi()],
	// Codex Responses。
	["openai-codex-responses", openAICodexResponsesApi()],
	// Azure Responses。
	["azure-openai-responses", azureOpenAIResponsesApi()],
	// Google API key 路径。
	["google-generative-ai", googleGenerativeAIApi()],
	// Google Vertex 路径。
	["google-vertex", googleVertexApi()],
	// Mistral Conversations。
	["mistral-conversations", mistralConversationsApi()],
	// AWS Bedrock Converse。
	["bedrock-converse-stream", bedrockConverseStreamApi()],
	// Pi 消息协议。
	["pi-messages", piMessagesApi()],
];

// 记录内置注册流程结束时的当前实现引用；ReturnType 推导查询函数返回类型。已有扩展覆盖也会被记下，不能把表名当作内置来源证明。
const builtinApiProviderInstances = new Map<Api, ReturnType<typeof getApiProvider>>();

/**
 * Registers the builtin API implementations into the api-registry without
 * clobbering existing entries: compat may load after a test or extension has
 * already registered an override for a builtin api id.
 */
// 用途：给聊天表补齐十种协议并记录当前对象身份，无输入/返回值，已有项不覆盖。
// 例扩展预先注册 A，本函数会保留它并记录其引用；随后内置供应商选择按此引用比较，并不严格证明实现源自内置工厂。
export function registerBuiltInApiProviders(): void {
	// 按声明顺序拆出 API 及延迟流集合。
	for (const [api, streams] of BUILTIN_APIS) {
		// 仅缺少实现时填入默认值，区别于图片注册的无条件覆盖。
		if (!getApiProvider(api)) {
			// 注册函数引用，不在这里执行原始流或简化流。
			registerApiProvider({ api, stream: streams.stream, streamSimple: streams.streamSimple });
		}
		// 无论刚安装还是原本存在，都保存此刻内部对象引用。
		builtinApiProviderInstances.set(api, getApiProvider(api));
	}
}

// 用途：清空聊天注册及身份表，再安装默认协议；无参数/返回值。例如测试结束调用可移除测试覆盖。不重建 compatModels、不清图片表，也不取消已有流。
export function resetApiProviders(): void {
	// 先删除聊天表所有当前项，包括扩展与 Faux。
	clearApiProviders();
	// 同时删除旧对象身份。
	builtinApiProviderInstances.clear();
	// 在空表中装回十种默认实现并记下引用。
	registerBuiltInApiProviders();
}

// 导入 compat 就会在模块求值时补齐聊天默认 API，具有模块级注册副作用。
registerBuiltInApiProviders();

// 创建内置供应商的独立 Models 集合；这里装配对象，不自动刷新远端目录或发模型请求。
const compatModels = builtinModels();
// 环境认证助手用此占位符表达 ADC/环境角色等条件，它不是可直接发送的真实密钥。
const AMBIENT_AUTH_MARKER = "<authenticated>";

// 用途：判断 key 是否为去掉两端空白后非空的字符串，参数必须传入但允许值为 undefined，返回布尔值，无副作用；例 "  " 为 false，" key " 为 true，但不修剪原值。
// 返回类型 apiKey is string 是类型谓词，让调用处在 true 分支缩小类型；它不证明密钥格式正确或服务端接受。
function hasExplicitApiKey(apiKey: string | undefined): apiKey is string {
	// && 短路确保只有字符串才执行 trim；保留既有运行时 typeof 检查。
	return typeof apiKey === "string" && apiKey.trim().length > 0;
}

// 用途：给旧聊天直达调用补环境 key。输入模型与可选配置，返回原配置或浅拷贝；例如没有显式 key 而 env 提供 OPENAI_API_KEY 时，仅新增 apiKey 字段。
// 流程：优先显式非空 key、查询供应商环境、排除认证占位符、合并配置。不会修改原 options、解析凭证存储或执行 OAuth；环境助手可能探测 ADC 文件是否存在。
function withEnvApiKey<TOptions extends StreamOptions>(
	// provider 决定查哪一组环境变量，而不是 model.api。
	model: Model<Api>,
	// 参数本身必须提供，但其值允许 undefined；区别于 options?: TOptions 的可省略写法。
	options: TOptions | undefined,
): TOptions | undefined {
	// 已提供非空 key 时保留原配置对象及原 key 文本。
	if (hasExplicitApiKey(options?.apiKey)) return options;
	// 先使用下层支持的请求 env，再由助手按自己的规则回退进程环境。
	const apiKey = getEnvApiKey(model.provider, options?.env);
	// 无 key 或仅表示环境认证条件时，不把占位符塞进真实请求。
	if (!apiKey || apiKey === AMBIENT_AUTH_MARKER) return options;
	// 对象展开浅复制现有字段，再覆盖 apiKey；as 只维持泛型视图，不做校验或深拷贝。
	return { ...options, apiKey } as TOptions;
}

// 用途：为 Cloudflare 分支判断本次配置是否看起来已经带认证，输入可选选项，返回布尔值，无副作用。
// 例非空 apiKey 为 true；精确小写键 cf-aig-authorization 只要值是字符串也为 true（包括空字符串），不验证有效性，也不做 header 名大小写归一。
function hasResolvedCloudflareAuth(options: StreamOptions | undefined): boolean {
	// || 表示满足两种本地条件之一；可选链允许缺少配置/headers。
	return hasExplicitApiKey(options?.apiKey) || typeof options?.headers?.["cf-aig-authorization"] === "string";
}

// 用途：决定模型能否走 compatModels 中的内置供应商对象，输入模型，返回供应商或 undefined；只查本地状态，无请求。
// 流程：先比 API 实现引用，再按 provider 找供应商，确认它有同 API 的聊天模型。例自定义模型 ID 也可走此路，只要供应商有该 API；并不要求该 ID 在目录中。
// 身份表保存的是上次 registerBuiltInApiProviders 时的当前引用，包含当时已存在的覆盖；普通后续覆盖会因引用不同而回到注册表分发。
function getBuiltinProviderForModel(model: Model<Api>) {
	// 当前注册引用已变就放弃供应商路径；两侧都 undefined 仍会继续，但后面还要实际找到供应商及匹配 API。
	if (getApiProvider(model.api) !== builtinApiProviderInstances.get(model.api)) return undefined;
	// provider 字符串决定从独立供应商集合中找哪个对象。
	const provider = compatModels.getProvider(model.provider);
	// some 只要求存在一个 API 相同的聊天模型；不比较模型 ID，未命中或供应商缺失均返回 undefined。
	return provider?.getModels().some((candidate) => candidate.api === model.api) ? provider : undefined;
}

// 用途：按 API 取全局聊天实现，缺失时同步抛错，命中时返回内部对象；例 Faux 卸载后再调用它的 API 会在此报告未注册。不加载模块或发请求。
function resolveApiProvider(api: Api) {
	// get 返回实现或 undefined。
	const provider = getApiProvider(api);
	// 必须有实现才能分发，不在此猜其他兼容协议。
	if (!provider) {
		// 同步抛出；complete 的 async 外层会把它转成拒绝，但直接 stream 调用方需自行处理。
		throw new Error(`No API provider registered for api: ${api}`);
	}
	// 返回同一个内部对象引用。
	return provider;
}

// 用途：旧全局原始流入口，输入模型、旧/新上下文和可选请求配置，立即返回事件流；实际请求可能在下层异步进行。
// 流程：规范化上下文、选供应商；缺少本地认证的 Cloudflare 经 Models 解析认证，其余内置路径补环境 key 后直调，最后回退 API 注册表。
// 例注册 Faux 后可 stream(fauxModel,{messages:[用户消息]}) 逐事件读取；这里不消费事件或自行重试，规范化/查表/调用的同步错误可直接抛出。
export function stream<TApi extends Api>(
	// API 泛型关联模型与后续传输选项断言，不是运行时模型验证。
	model: Model<TApi>,
	// normalizeContext 把旧顶层 systemPrompt/tools 转为初始 system 消息；没有这些字段时复用消息数组。
	context: Context,
	// ProviderStreamOptions 包含各供应商可用的请求选项；? 允许完全省略。
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	// 在选择实现前统一消息轨迹；此处不压缩、总结或清理历史。
	const transcript = normalizeContext(context);
	// 检查当前 API 对象身份与供应商的 API 支持。
	const builtinProvider = getBuiltinProviderForModel(model);
	// 有符合条件的供应商时优先走供应商对象。
	if (builtinProvider) {
		// 仅供应商名前缀精确为 cloudflare- 且本地未见认证时，交 Models 走其认证解析。
		if (model.provider.startsWith("cloudflare-") && !hasResolvedCloudflareAuth(options)) {
			// 断言适配 Models 的泛型选项，不转换值；Models 负责选择供应商、解析认证并转交流。
			return compatModels.stream(model, transcript, options as ModelsApiStreamOptions<TApi> | undefined);
		}
		// 其他内置路径只先补环境 key，再直接调用供应商包装；不在此入口读取凭证存储。
		return builtinProvider.stream(model, transcript, withEnvApiKey(model, options) as ApiStreamOptions<TApi>);
	}
	// 自定义 API 或不符合供应商路径时查全局表；缺失会同步抛错。
	const provider = resolveApiProvider(model.api);
	// 补环境 key 后调用注册包装器，它还会核对 model.api；as 不验证专有配置。
	return provider.stream(model, transcript, withEnvApiKey(model, options) as StreamOptions);
}

// 用途：原始选项的一次性完成入口；输入同 stream，返回最终 AssistantMessage 的 Promise。例如只想要全文而非逐字展示，可 await complete(model,context)。
// 流程：启动流后等 result；下层 stopReason:"error" 结果通常仍正常兑现，不能认为 await 成功就表示模型成功。同步启动异常通过 async 转为拒绝；本层不做工具执行或后续轮次。
export async function complete<TApi extends Api>(
	// 本次请求使用的聊天模型。
	model: Model<TApi>,
	// 完整上下文交给 stream 规范化。
	context: Context,
	// 可省略的供应商原始请求选项。
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	// 启动与直接 stream 相同的分发流程，实际请求副作用也发生在其下层。
	const s = stream(model, context, options);
	// async 返回时采用 result Promise 的结算状态，不需要本函数遍历所有增量事件。
	return s.result();
}

// 用途：旧全局简化选项流入口，输入模型、上下文与通用配置，返回事件流；例如 reasoning 等通用配置会由实际实现转换为供应商选项。
// 流程与 stream 相同：规范化、供应商身份检查、Cloudflare 必要时走 Models 认证、否则补环境 key 或查注册表。这里不转换事件、不做工具循环、不兜底捕获同步异常。
export function streamSimple<TApi extends Api>(
	// API 类型仍由模型决定。
	model: Model<TApi>,
	// 支持旧顶层 systemPrompt/tools 的上下文。
	context: Context,
	// 简化选项使用公共思考等级等字段，而非专有 API 配置集合。
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	// 统一成 transcript 形状，保持消息内容由调用方提供。
	const transcript = normalizeContext(context);
	// 依据当前对象引用和供应商已有 API 决定是否走供应商。
	const builtinProvider = getBuiltinProviderForModel(model);
	// 找到本地内置供应商才进入专用分支。
	if (builtinProvider) {
		// 没有本地已解析认证的 Cloudflare 需要更完整的 Models 认证流程。
		if (model.provider.startsWith("cloudflare-") && !hasResolvedCloudflareAuth(options)) {
			// 通用选项可以直接传入 Models.streamSimple，无需原始选项的 API 泛型断言。
			return compatModels.streamSimple(model, transcript, options);
		}
		// 其他情况补环境 key 后调用供应商简化流实现。
		return builtinProvider.streamSimple(model, transcript, withEnvApiKey(model, options));
	}
	// 全局表支持用户注册 API；未注册时这里抛错。
	const provider = resolveApiProvider(model.api);
	// 统一签名接受简化选项，返回实现的原事件流。
	return provider.streamSimple(model, transcript, withEnvApiKey(model, options));
}

// 用途：等待简化选项流的最终回复，输入同 streamSimple，返回 AssistantMessage Promise；例如 await completeSimple(model,context,{reasoning:"low"})。
// 先启动再等待 result，不执行工具或追加轮次；流的错误回复可正常兑现，同步启动异常会因 async 成为拒绝，请求副作用由下层实现负责。
export async function completeSimple<TApi extends Api>(
	// 本轮聊天模型及其 API。
	model: Model<TApi>,
	// 本轮完整上下文。
	context: Context,
	// 通用请求选项，可省略。
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	// 启动简化选项分发，与调用方自己使用 streamSimple 相同。
	const s = streamSimple(model, context, options);
	// 只返回最终消息 Promise，不将所有中途事件拼成额外结果数组。
	return s.result();
}
