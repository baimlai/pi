// 共享模型与认证运行时：上接 SDK/CLI/会话，下接 pi-ai Models 和 Provider；负责配置叠加、可用性快照、凭证串行操作、真实请求与虚拟模型路由。
// dirname 取得配置文件父目录，join 按平台路径规则拼出模型缓存地址。
import { dirname, join } from "node:path";
// 从 pi-ai 导入运行时函数与大量协议类型；type 项只在 TS 检查时存在。
import {
	// 所有模型种类的联合，包括聊天、图片生成和分类。
	type AnyModel,
	// 聊天 API 标识的类型，约束模型与请求选项。
	type Api,
	// 按具体 API 参数化的供应商流请求配置。
	type ApiStreamOptions,
	// 图片生成的最终结果类型，包含输出及失败状态。
	type AssistantImages,
	// 一条完整助手回复的类型，包含内容、用量和 stopReason。
	type AssistantMessage,
	// 可迭代流及 result() 的类型，先同步返回，事件随后异步到达。
	type AssistantMessageEventStream,
	// 认证配置检查元信息，不是实际秘密值，也不代表远端请求成功。
	type AuthCheck,
	// 登录流程需要的交互回调和可选取消信号。
	type AuthInteraction,
	// 认证操作的基础选项，包含可选 signal。
	type AuthOperationOptions,
	// 实际请求认证解析结果，可能含 key、headers、baseUrl 和环境。
	type AuthResult,
	// 认证种类字面量联合，例如 api_key/oauth。
	type AuthType,
	// 分类模型可用 API 的类型。
	type ClassifierApi,
	// 分类输入数据结构。
	type ClassifierContext,
	// 分类模型元数据的泛型类型。
	type ClassifierModel,
	// 供应商底层分类请求选项。
	type ClassifierOptions,
	// 分类成功或失败的结果数据。
	type ClassifierResult,
	// 调用者的聊天上下文，允许旧式顶层 systemPrompt/tools。
	type Context,
	// 凭证实体联合，可能含真实 API Key 或 OAuth token。
	type Credential,
	// 不带秘密内容的凭证元信息，适合列表/UI。
	type CredentialInfo,
	// 异步凭证存储契约，允许文件或内存实现。
	type CredentialStore,
	// 按模型思考能力限制传入级别，不执行模型推理。
	clampThinkingLevel,
	// 创建可变供应商集合，其内部负责通用认证解析和模型操作转接。
	createModels,
	// 供应商延迟响应取消选项。
	type DeferredCancelOptions,
	// 供应商延迟响应取回选项。
	type DeferredFetchOptions,
	// 已在远端创建的延迟任务句柄，不是本地 Promise。
	type DeferredHandle,
	// 生成 OpenCode 兼容会话标识请求头，供需要这类头的模型使用。
	getOpenCodeSessionHeaders,
	// 图片生成 API 标识类型。
	type ImageApi,
	// 图片生成模型元数据类型。
	type ImageModel,
	// 图片生成输入上下文。
	type ImagesContext,
	// 供应商底层图片请求选项。
	type ImagesOptions,
	// 登录流程可选配置。
	type LoginOptions,
	// 同步返回外层流并立即开始异步 setup；setup 失败会变成 error 流事件。
	lazyStream,
	// 已转换为模型协议的聊天消息联合类型。
	type Message,
	// 聊天模型元数据类型，包含 provider/id/api/能力等。
	type Model,
	// 公共 Models 接口，ModelRuntime 需实现其全部方法。
	type Models,
	// 在 API 专属流配置上增加公共请求头变换能力。
	type ModelsApiStreamOptions,
	// 分类配置加公共变换选项。
	type ModelsClassifierOptions,
	// 延迟任务取消配置加公共变换选项。
	type ModelsDeferredCancelOptions,
	// 延迟结果读取配置加公共变换选项。
	type ModelsDeferredFetchOptions,
	// 带稳定 code 的模型/认证操作错误类。
	ModelsError,
	// 图片请求配置加公共变换选项。
	type ModelsImagesOptions,
	// 模型目录刷新选项，区分网络许可、限定供应商与取消。
	type ModelsRefreshOptions,
	// 刷新结果含 aborted 和按供应商汇总的错误 Map。
	type ModelsRefreshResult,
	// 请求装配后的 transformHeaders 变换契约。
	type ModelsRequestTransforms,
	// 通用思考级别等简单流配置加公共变换选项。
	type ModelsSimpleStreamOptions,
	// 模型目录缓存存储接口，不是会话消息存储。
	type ModelsStore,
	// 模型层思考级别联合类型。
	type ModelThinkingLevel,
	// 模型操作种类，例如 chat/image/classifier。
	type ModelType,
	// 从种类映射到对应模型结构的类型映射。
	type ModelTypeMap,
	// 比 Models 多出 set/delete/clear Provider 能力的内部接口。
	type MutableModels,
	// 把顶层旧提示词/工具折进 system 消息，不是压缩摘要。
	normalizeContext,
	// 供应商运行时对象，拥有目录、认证方法和实际请求实现。
	type Provider,
	// 头字段字典值可以是 string 或 null；null 是下游删除该头的标记。
	type ProviderHeaders,
	// 按模型种类计算供应商请求配置的条件类型。
	type ProviderRequestOptions,
	// 供应商底层简单聊天流配置。
	type SimpleStreamOptions,
	// 跨 API 的基础聊天流配置。
	type StreamOptions,
	// 以上类型/函数均来自 pi-ai 公共入口。
} from "@earendil-works/pi-ai";
// 命名空间导入整个内置供应商目录模块，后面按需调用工厂与发布时间查询。
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
// OpenRouter 的目录可按用户 key 个性化，模型/价格/限制可能因 key 不同而不同。
import { personalizeOpenRouterCatalog } from "@earendil-works/pi-ai/providers/openrouter";
// 下面集中导入请求边界的操作种类校验与失败结果构造函数。
import {
	// 聊天入口拒绝传入图片/分类模型。
	assertChatModel,
	// 分类请求带图片时检查该模型是否支持图片输入。
	assertClassifierInputSupported,
	// 分类入口校验模型种类。
	assertClassifierModel,
	// 图片生成入口校验模型种类。
	assertImageModel,
	// 把分类异常转换成稳定失败结果，而不是继续抛出。
	classifierErrorResult,
	// 把图片异常转换成稳定失败结果。
	imageErrorResult,
	// 这些操作助手共享 pi-ai 的错误语义。
} from "@earendil-works/pi-ai/utils/model-operations";
// 用户配置路径统一由 config 决定。
import { getAgentDir } from "../config.ts";
// operationSignal 补默认信号，raceWithAbortSignal 只取消等待，不通用地强制终止原任务。
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
// 将 AuthStorage 重命名为 DefaultAuthStorage，突出它只是未传自定义存储时的默认实现。
import { AuthStorage as DefaultAuthStorage } from "./auth-storage.ts";
// models.json 的一次不可变加载结果，负责文件解析与 schema 校验。
import { ModelConfig } from "./model-config.ts";
// 模型目录缓存可落文件或纯内存，具体依赖创建选项。
import { FileModelsStore, InMemoryCodingAgentModelsStore } from "./models-store.ts";
// 供应商组合层负责合并内置、models.json 与扩展配置。
import {
	// UI 使用的认证来源/是否配置状态类型。
	type AuthStatus,
	// 旧 ModelRegistry 请求兼容配置类型。
	type CompatibilityRequestConfig,
	// 组合供应商对象并校验模型配置，可能抛出组合错误。
	composeModelProvider,
	// 只检查配置值/环境引用是否存在，不能等同远端 key 已验证。
	configuredRequestAuthStatus,
	// 扩展声明供应商的输入结构。
	type ProviderConfigInput,
	// 解析旧兼容请求需要的头及 authHeader 行为。
	resolveCompatibilityRequestConfig,
	// 解析当前模型的配置头，包括环境/命令值解析。
	resolveConfiguredModelHeaders,
	// 扩展注册边界的结构校验，错误注册应先抛错再修改既有状态。
	validateExtensionProvider,
	// 以上都来自同一配置组合模块。
} from "./provider-composer.ts";
// 给内置 Provider 包远端目录刷新或个性化目录能力，不立即发模型聊天请求。
import { withPersonalizedCatalog, withRemoteCatalog } from "./remote-catalog-provider.ts";
// 在持久存储上覆盖本进程临时 API Key，覆盖不自动写入 auth.json。
import { RuntimeCredentials } from "./runtime-credentials.ts";
// 以下是虚拟模型目录和每次请求路由的辅助契约。
import {
	// 从虚拟声明生成可展示/选择的模型目录项。
	createVirtualModel,
	// 从历史倒查最近成功的物理模型回复。
	findLatestResponse,
	// 按 api 标记识别虚拟模型，不执行其路由。
	isVirtualModel,
	// 路由返回的物理模型、思考级别及可选状态类型。
	type ModelRoute,
	// 路由原因区分用户请求、工具续轮、重试和直接请求。
	type ModelRouteReason,
	// 虚拟模型声明包含展示字段与 route 回调。
	type VirtualModelDefinition,
	// 把虚拟模型附加到供应商目录；没有物理 Provider 时可建无秘密要求的虚拟占位供应商。
	withVirtualModels,
	// 虚拟能力公共入口不负责在此创建会话历史。
} from "./virtual-models.ts";

// 单个注册虚拟模型的内部记录：目录元数据与路由函数分开保存。
interface RegisteredVirtualModel {
	// 可选中的虚拟模型目录项；其 api 不应直接进入物理供应商。
	model: Model<Api>;
	// 索引访问类型复用 VirtualModelDefinition 的 route 签名，不另写一套参数。
	route: VirtualModelDefinition["route"];
}

// 同步供 UI/模型选择读取的最近快照，可能落后于正在进行的异步认证检查。
interface ModelRuntimeSnapshot {
	// 最近已知聊天目录，readonly 只是 TS 使用约束，不冻结对象。
	all: readonly Model<Api>[];
	// 最近可用聊天列表；完整检查会应用供应商策略，注册/重建期间也可能先按配置供应商集合粗筛。
	available: readonly Model<Api>[];
	// 最近检查或注册时临时标记为配置可用的供应商集合，不表示已发一次远端请求成功。
	configuredProviders: ReadonlySet<string>;
	// 最近凭证列表出现的供应商，包含 RuntimeCredentials 的临时覆盖元信息。
	storedProviders: ReadonlySet<string>;
	// 认证检查结果或注册阶段临时标签，保存类型/来源而非真实请求 token。
	auth: ReadonlyMap<string, AuthCheck | undefined>;
}

// 创建运行时的可选输入；声明不执行磁盘/网络操作。
export interface CreateModelRuntimeOptions {
	/** Credential storage. Defaults to the file at authPath. */
	// 可注入存储，省略时用 authPath 对应文件存储。
	credentials?: CredentialStore;
	// 默认凭证文件地址，只有未提供 credentials 时使用。
	authPath?: string;
	// null 明确禁用 models.json，undefined 使用默认地址；两者语义不同。
	modelsPath?: string | null;
	// 可注入目录缓存存储，否则按是否有 modelsPath 选择文件/内存。
	modelsStore?: ModelsStore;
	// 默认文件缓存地址覆盖，仅在需要新建 FileModelsStore 时使用。
	modelsStorePath?: string;
	/** Allow create() to refresh model catalogs over the network. Defaults to false. */
	// 只允许创建阶段联网刷新目录，默认 false，不是所有认证操作的总网络开关。
	allowModelNetwork?: boolean;
	/** Timeout for the create-time network model refresh. */
	// 创建阶段网络目录刷新超时毫秒数，不自动限制任意扩展回调。
	modelRefreshTimeoutMs?: number;
	// 远端目录服务基址覆盖，供目录包装器使用。
	catalogBaseUrl?: string;
	/** Optional caller cancellation for initial cache restoration and availability checks. */
	// 调用方初始加载/可用性查询取消信号。
	signal?: AbortSignal;
	/** Skip initial catalog and availability refresh. Static models remain available. */
	// false 跳过首次刷新；静态目录仍由构造时注册提供。
	refreshOnCreate?: boolean;
}

// 认证覆盖类型继承通用 signal 等操作参数，再加本运行时的请求级覆盖。
export interface ModelRuntimeAuthOverrides extends AuthOperationOptions {
	// 只针对本次认证解析提供 API Key，不在此类型层持久化。
	apiKey?: string;
	// 本次环境值覆盖，Record<string,string> 表示字符串字典。
	env?: Record<string, string>;
	/** Require this much remaining OAuth-token validity; defaults to five minutes. */
	// OAuth 最小剩余有效期要求交给底层解析器，可能触发刷新网络及保存。
	minOAuthValidityMs?: number;
}

// 同步失败错误记录已成功完成的凭证操作种类，便于区分登录、退出或临时覆盖变更。
export type CredentialSynchronizationOperation = "login" | "logout" | "setRuntimeApiKey" | "removeRuntimeApiKey";

/** Credentials changed successfully, but the local model/auth snapshot could not be synchronized. */
// 表示秘密存储/覆盖已经改成功、但本地模型认证快照没同步成功；不能把此错误当作“凭证一定没改”。
export class CredentialSynchronizationError extends Error {
	// readonly 限制 TS 重新赋值，不对运行时错误实例自动冻结。
	readonly providerId: string;
	// 哪个操作已经提交成功。
	readonly operation: CredentialSynchronizationOperation;
	// 成功操作得到的凭证；移除/退出时可为 undefined，字段可能含秘密不要随意打印。
	readonly credential: Credential | undefined;

	// 构造部分成功错误。输入供应商、操作、已提交凭证和 cause 选项；结果 Error，不回滚存储。
	// 例如 OAuth 登录落盘后目录刷新失败，错误仍携带已保存凭证供上层正确处理。
	constructor(
		// 失败同步对应的供应商 id。
		providerId: string,
		// 此前已经完成的凭证操作名称。
		operation: CredentialSynchronizationOperation,
		// 已提交的凭证值，可能没有。
		credential: Credential | undefined,
		// 标准 ErrorOptions 可保留原 cause 异常链。
		options: ErrorOptions,
		// 构造器体在所有参数收集完成后开始。
	) {
		// super 设置可读消息与 cause，明确指出提交成功但同步失败。
		super(`Credential ${operation} committed for ${providerId}, but local synchronization failed`, options);
		// 具体错误名称方便 UI/日志辨认。
		this.name = "CredentialSynchronizationError";
		// 保存供应商身份。
		this.providerId = providerId;
		// 保存已提交的操作种类。
		this.operation = operation;
		// 保存凭证引用，不在这里写磁盘或输出秘密。
		this.credential = credential;
	}
}

// 按头名称忽略大小写合并。输入可选基础/覆盖头，返回新字典或 undefined，不改输入。
// 先复制 base，再删除所有同名不同大小写旧键，最后写覆盖值。例如 X-A:a 加 x-a:null 只留下 x-a:null；null 保留为下游删除标记，不在这里丢弃。
function mergeHeaders(
	// 低优先级基础头，允许缺省。
	base: ProviderHeaders | undefined,
	// 高优先级覆盖头，允许值为 null。
	override: ProviderHeaders | undefined,
	// 双方都无头返回 undefined，否则返回字典（可能为空）。
): ProviderHeaders | undefined {
	// 避免无头时制造无用对象。
	if (!base && !override) return undefined;
	// 对象展开浅复制基础字典，后续 delete 不会改 base。
	const merged = { ...base };
	// Object.entries 枚举覆盖头，每轮解构名称和值。
	for (const [name, value] of Object.entries(override ?? {})) {
		// 只把名称转小写用于比较，最终输出仍保留覆盖项原拼写。
		const lowerName = name.toLowerCase();
		// 遍历当前合并对象的所有旧键，清除大小写别名。
		for (const existingName of Object.keys(merged)) {
			// delete 移除同名旧键，即使旧键与新键拼写不同也能覆盖。
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		// 写入新名称和值，包括 null；删除语义由更下游应用。
		merged[name] = value;
	}
	// 返回合并后的新对象。
	return merged;
}

/** Configured pi-ai Models collection used by coding-agent and SDK consumers. */
// 实现 pi-ai Models 公共能力，同时增加 coding-agent 的配置叠加、快照、临时凭证和虚拟模型路由。
export class ModelRuntime implements Models {
	// 真正的通用供应商集合，负责底层目录/认证实现。
	private readonly models: MutableModels;
	// 凭证覆盖层，共享给 this.models，供临时 key 与持久存储统一读取。
	private readonly credentials: RuntimeCredentials;
	// 创建时的基础 Provider 表，用于每次重建恢复原始内置定义。
	private readonly defaultBuiltins: ReadonlyMap<string, Provider>;
	// 当前内置表可能加入 models.json 的 Radius 实例；readonly 只固定 Map 引用。
	private readonly builtins = new Map<string, Provider>();
	// 扩展直接注册的原生 Provider 对象。
	private readonly nativeExtensionProviders = new Map<string, Provider>();
	// 扩展按配置形式注册的供应商覆盖；同名原生/配置注册相互替换。
	private readonly extensionProviders = new Map<string, ProviderConfigInput>();
	/** Virtual models by provider id, then model id. */
	// 二级 Map 先按供应商，再按虚拟模型 id 定位声明。
	private readonly virtualModels = new Map<string, Map<string, RegisteredVirtualModel>>();
	// 供应商组合错误按 id 保存，getError 汇总展示。
	private readonly compositionErrors = new Map<string, string>();
	// models.json 源地址，可禁用；刷新时仍从同一地址重新加载。
	private readonly modelsPath: string | undefined;
	// 目录联网刷新的默认许可，由创建时 PI_OFFLINE 是否定义决定；显式 refresh.allowNetwork 仍可覆盖默认。
	private readonly modelNetworkEnabled: boolean;
	// 当前加载完成的不可变模型配置快照，refresh 会换整份引用。
	private config: ModelConfig;
	// 首次快照从空集合开始，构造重建和异步刷新逐步填充。
	private snapshot: ModelRuntimeSnapshot = {
		// 空聊天目录初值。
		all: [],
		// 空可用聊天模型初值。
		available: [],
		// 尚未做认证检查，没有配置可用的供应商快照。
		configuredProviders: new Set(),
		// 尚未列出任何存储凭证供应商。
		storedProviders: new Set(),
		// 尚无认证类型/来源检查结果。
		auth: new Map(),
	};
	// 完整可用性刷新代次，防止较旧异步结果覆盖较新结果。
	private availabilityRefreshSeq = 0;
	// 错误状态的刷新代次，避免旧失败抹掉/覆盖新结果。
	private availabilityErrorSeq = 0;
	// 每个供应商单独的可用性代次，局部凭证变更可让旧局部检查失效。
	private readonly providerAvailabilitySeq = new Map<string, number>();
	// 最近有效可用性刷新错误文字；保存异常消息，不保存 Credential 对象。
	private availabilityError: string | undefined;
	// 按供应商保存凭证操作的队尾 Promise；不同供应商可以并行，同一供应商串行。
	private readonly credentialOperations = new Map<string, Promise<unknown>>();

	// 私有构造器只组装现成依赖，输入凭证、配置、路径、缓存、内置 Provider 和网络默认值，无异步返回。
	// 建立基础目录并重建供应商；实际创建入口是 static create，例如由它先读 models.json 再调用此构造器。
	private constructor(
		// 已经套好临时覆盖能力的凭证存储。
		credentials: RuntimeCredentials,
		// 已读/校验的模型配置快照。
		config: ModelConfig,
		// 后续刷新重新加载的源文件地址。
		modelsPath: string | undefined,
		// 模型目录缓存读写实现，不存对话历史。
		modelsStore: ModelsStore,
		// 创建阶段准备好的基础供应商列表，只读类型不复制 Provider 对象。
		providers: readonly Provider[],
		// 默认是否允许目录网络刷新。
		modelNetworkEnabled: boolean,
		// 使用显式字段赋值，不采用需要额外 JS emit 的 TS 参数属性语法。
	) {
		// 保存共享凭证实例。
		this.credentials = credentials;
		// 保存已加载配置。
		this.config = config;
		// 保存配置源路径。
		this.modelsPath = modelsPath;
		// 固定本实例网络默认策略。
		this.modelNetworkEnabled = modelNetworkEnabled;
		// map 回调把 Provider 变成 [id,对象] 键值对，Map 以 id 建索引。
		this.defaultBuiltins = new Map(providers.map((provider) => [provider.id, provider]));
		// for...of 解构原始内置表，复制索引到可调整表；Provider 对象本身复用。
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		// 创建底层 Models 并传共享存储；此处不发聊天请求。
		this.models = createModels({ credentials, modelsStore });
		// 组合/注册所有初始供应商，建立同步聊天目录快照。
		this.rebuildProviders();
	}

	// 异步创建运行时。输入可选配置，返回就绪实例；读文件/缓存、可按选项刷新目录，失败可抛出。
	// 流程：凭证覆盖→模型配置/缓存→包装内置目录→构造→Radius 重建→首次刷新。例如默认创建只用本地目录恢复，不代表后续 OAuth 认证永不联网。
	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		// 调用者存储优先，否则创建默认文件存储，再统一套临时 key 覆盖层。
		const credentials = new RuntimeCredentials(options.credentials ?? DefaultAuthStorage.create(options.authPath));
		// 下面专门区分 modelsPath:null 和未传路径。
		const modelsPath =
			// null 禁用模型配置文件；undefined 使用 ~/.pi/agent/models.json。
			options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
		// 等待配置读取/解析/schema 校验；配置问题通常保存在 ModelConfig.getError 中。
		const config = await ModelConfig.load(modelsPath);
		// 选择目录缓存实现，不是在这里创建会话 JSONL。
		const modelsStore =
			// 调用者传了存储就直接复用。
			options.modelsStore ??
			// 没有传缓存时，根据是否启用模型配置地址决定文件/内存。
			(modelsPath
				? // 文件缓存默认与 models.json 同目录，名为 models-store.json。
					new FileModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json"))
				: // 禁用 modelsPath 且没传缓存时使用纯内存目录缓存。
					new InMemoryCodingAgentModelsStore());
		// 读取随包内置模型数据生成时间，帮助远端包装器判断缓存新旧。
		const builtinModelDataGeneratedAt = builtinProviderCatalog.getBuiltinModelDataGeneratedAt();
		// map 回调输入一个内置 Provider，输出直接复用或带目录刷新包装的对象；构造包装器不等于马上联网。
		const providers = builtinProviderCatalog.builtinProviders().map((provider) => {
			// Radius 本身保持原实现，不套通用远端目录包装。
			if (provider.id === "radius") return provider;
			// OpenRouter narrows the catalog to the models, limits and prices of the user's key.
			// OpenRouter 目录需按用户凭证个性化，而不是所有用户共用一份模型清单。
			if (provider.id === "openrouter") {
				// 创建具有个性化目录能力的 Provider 包装。
				return withPersonalizedCatalog(
					// 保留原供应商的认证和请求能力。
					provider,
					// 传 OpenRouter 具体的凭证目录处理函数引用。
					personalizeOpenRouterCatalog,
					// 允许覆盖目录服务基址。
					options.catalogBaseUrl,
					// 传静态目录时间，供缓存/远端新旧比较。
					builtinModelDataGeneratedAt,
				);
			}
			// 其他供应商使用通用远端目录包装，实际刷新由后面的 refresh 决定。
			return withRemoteCatalog(provider, options.catalogBaseUrl, builtinModelDataGeneratedAt);
		});
		// 所有依赖准备好后创建本地运行时对象。
		const runtime = new ModelRuntime(
			// 传共享临时/持久凭证覆盖层。
			credentials,
			// 传这次读出的配置快照。
			config,
			// 保留配置源供后续 refresh 重读。
			modelsPath,
			// 传目录缓存存储。
			modelsStore,
			// 传包装过的基础内置供应商列表。
			providers,
			// 注意此处只看 PI_OFFLINE 是否为 undefined；即便环境值是空串或 0 字符串，也会使默认网络刷新关闭。
			process.env.PI_OFFLINE === undefined,
		);
		// 用 models.json 中的 oauth:radius 项补齐/覆盖当前内置供应商表。
		runtime.configureRadiusProviders();
		// Radius 表变化后重建底层 Provider 集合和目录快照。
		runtime.rebuildProviders();
		// 创建阶段只有默认允许网络且用户明确 allowModelNetwork:true 才联网刷新。
		const refreshFromNetwork = runtime.modelNetworkEnabled && options.allowModelNetwork === true;
		// 以下控制器只为可联网首次刷新且显式给超时时长时创建。
		const controller =
			// 不联网或未给超时，就不额外创建超时控制器。
			refreshFromNetwork && options.modelRefreshTimeoutMs !== undefined ? new AbortController() : undefined;
		// 定时回调调用 abort 发取消信号；创建定时器不阻塞线程等待。
		const timeout = controller ? setTimeout(() => controller.abort(), options.modelRefreshTimeoutMs) : undefined;
		// 组合调用方取消与内部超时信号，任一取消即通知刷新。
		const signal = controller
			? // 有超时控制器时再看调用方是否也给了 signal。
				options.signal
				? // AbortSignal.any 生成“任意一个取消即取消”的合成信号。
					AbortSignal.any([options.signal, controller.signal])
				: // 没有外部信号就只用超时控制器信号。
					controller.signal
			: // 没有内部控制器就沿用调用方可选信号。
				options.signal;
		// 保证无论刷新成功还是失败都会清除内部计时器。
		try {
			// 只有显式 false 才跳过首次目录/可用性刷新。
			if (options.refreshOnCreate !== false) {
				// 等待缓存恢复/可选联网和认证配置可用性检查；不发送聊天问题。
				await runtime.refresh({ allowNetwork: refreshFromNetwork, signal });
			}
			// finally 在成功 return 之前或抛错之后都会执行。
		} finally {
			// 创建过定时器才清除，避免刷新后定时器残留。
			if (timeout) clearTimeout(timeout);
		}
		// 返回构建完成的模型运行时。
		return runtime;
	}

	// 按当前配置重建 Radius 基础供应商。无输入/返回值，只修改内置表，不发聊天请求。
	// 先恢复原内置列表，再为 oauth:radius 且有 baseUrl 的项造网关 Provider，例如去掉末尾 /v1 得到 gateway。
	private configureRadiusProviders(): void {
		// 清掉上一次配置的 Radius 派生项，避免已删配置继续生效。
		this.builtins.clear();
		// 重新放入原始内置 Provider 表。
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		// 遍历当前 models.json 配置涉及的供应商 id。
		for (const providerId of this.config.getProviderIds()) {
			// 读取该 id 的完整配置块。
			const config = this.config.getProvider(providerId);
			// 只有明确 Radius 登录并配置 baseUrl 的项需要特殊实例；其他跳过。
			if (config?.oauth !== "radius" || !config.baseUrl) continue;
			// 将派生 Radius Provider 保存到本次内置表，可能覆盖同 id 原项。
			this.builtins.set(
				// Map 键采用配置中的供应商 id。
				providerId,
				// 调用随包 Radius 工厂，组装对象，不在此登录。
				builtinProviderCatalog.radiusProvider({
					// 派生对象使用该配置 id。
					id: providerId,
					// 有显示名优先使用，否则用 id。
					name: config.name ?? providerId,
					// 正则只移除末尾 /v1 与可选尾斜线，避免网关重复拼版本路径。
					gateway: config.baseUrl.replace(/\/v1\/?$/u, ""),
				}),
			);
		}
	}

	// 汇总所有来源供应商 id。无输入，返回去重 Set，无网络/存储副作用。
	// 例如内置 p 和扩展 p 只保留一个 id，后续组合再决定实际对象。
	private providerIds(): Set<string> {
		// Set 对下面展开的字符串去重。
		return new Set([
			// 加入当前内置（含 Radius 派生）供应商。
			...this.builtins.keys(),
			// 加入扩展原生 Provider。
			...this.nativeExtensionProviders.keys(),
			// 加入仅在 models.json 配置里出现的自定义供应商。
			...this.config.getProviderIds(),
			// 加入配置式扩展供应商。
			...this.extensionProviders.keys(),
			// 加入只有虚拟模型也可能存在的供应商 id。
			...this.virtualModels.keys(),
		]);
	}

	/** Returns the provider without virtual models, or undefined when only virtual models define it. */
	// 重新组合并注册一个供应商。输入 id，返回不含虚拟模型的基础 Provider 或 undefined；副作用是更新底层集合。
	// 例如基础不存在但有虚拟项，底层仍注册虚拟占位对象，返回值仍是 undefined。
	private recomposeProvider(providerId: string): Provider | undefined {
		// 先按内置/原生/配置规则得到物理能力对象，组合错误由 composeProvider 记录。
		const provider = this.composeProvider(providerId);
		// 取该供应商所有虚拟记录，缺省空迭代列表，再 map 提取目录项。
		const virtualModels = [...(this.virtualModels.get(providerId)?.values() ?? [])].map((entry) => entry.model);
		// 有虚拟项就包装/创建供应商，加入虚拟目录，登记到 Models。
		if (virtualModels.length > 0) this.models.setProvider(withVirtualModels(providerId, provider, virtualModels));
		// 没有虚拟项但有真实 Provider 时直接注册它。
		else if (provider) this.models.setProvider(provider);
		// 所有来源都没有时删除底层该 id，避免残留旧对象。
		else this.models.deleteProvider(providerId);
		// 返回未包装虚拟目录的对象，调用者据此识别纯虚拟供应商。
		return provider;
	}

	/** The provider without virtual models, or undefined when nothing defines it. */
	// 合并某供应商的内置/原生与用户/扩展配置。输入 id，返回基础 Provider，可为空；只组装对象和错误表。
	// 没有覆盖复用原对象；组合失败保留错误并退回 base，例如配置 API 不合法仍可保留基础目录供 UI 展示。
	private composeProvider(providerId: string): Provider | undefined {
		// 扩展原生对象优先于普通内置对象，?? 保留第一份非空定义。
		const base = this.nativeExtensionProviders.get(providerId) ?? this.builtins.get(providerId);
		// 取得扩展配置覆盖层。
		const extension = this.extensionProviders.get(providerId);
		// models.json 和扩展都没有覆盖时无需重新包装。
		if (!this.config.getProvider(providerId) && !extension) {
			// No overlays: use the builtin untouched so its auth/login/stream behavior is exact.
			// 清除这个 id 上次遗留的组合错误。
			this.compositionErrors.delete(providerId);
			// 原样返回基础 Provider，保持其认证/流行为。
			return base;
		}
		// 组合和校验可能抛错，先隔离到当前供应商。
		try {
			// 实际合并模型、认证、请求行为及配置头。
			const provider = composeModelProvider(providerId, base, this.config, extension);
			// 本轮组合成功，去掉旧错误。
			this.compositionErrors.delete(providerId);
			// 返回组合后的新 Provider。
			return provider;
			// 失败时仍保留一个可查询的基础对象，不让全部目录加载停止。
		} catch (error) {
			// 记录具体供应商错误，供 getError 汇总；不是把它假装成组合成功。
			this.compositionErrors.set(providerId, error instanceof Error ? error.message : String(error));
			// 基础不存在就返回 undefined，底层之后会删除该 id。
			return base;
		}
	}

	// 重建全部底层 Provider。无参数/返回，修改集合与同步快照，不执行聊天。
	// 清空→重组所有来源 id→更新目录，例如 refresh 重新加载 models.json 后调用。
	private rebuildProviders(): void {
		// 删除当前底层注册表，后面按当前来源完整重建。
		this.models.clearProviders();
		// 清除旧组合错误，本轮重新收集。
		this.compositionErrors.clear();
		// 遍历去重 id 集合，每项执行独立重组。
		for (const providerId of this.providerIds()) this.recomposeProvider(providerId);
		// 注册变化后更新同步聊天模型目录和按旧认证状态推导的可用项。
		this.updateModelSnapshot();
	}

	// 更新同步目录快照。无参数/返回，读取 Models 当前聊天目录；暂时沿用旧配置供应商集合。
	// 例如刚注册模型时立即能列表展示，可用性精确筛选随后异步刷新；此方法不调用认证检查。
	private updateModelSnapshot(): void {
		// 展开复制目录数组，模型元数据对象仍复用。
		const all = [...this.models.getModels()];
		// 用新对象替换 snapshot 引用，而不是逐属性原地修改旧快照。
		this.snapshot = {
			// 保留认证/存储供应商等还未刷新字段。
			...this.snapshot,
			// 更新完整聊天目录。
			all,
			// 先按已有 configuredProviders 粗筛可用项，可能尚未反映最新凭证或供应商专属过滤策略。
			available: all.filter((model) => this.snapshot.configuredProviders.has(model.provider)),
		};
	}

	// 完成一次全局可用性刷新。输入全局代次/错误代次/信号，异步无值返回；读认证元数据并更新快照，不发测试聊天。
	// 并行查可用模型、各 Provider 认证和凭证列表，只有仍最新的代次可发布；例如旧慢查询不能覆盖新一次刷新。
	private async runAvailabilityRefresh(seq: number, errorSeq: number, signal: AbortSignal): Promise<void> {
		// 捕获当前已注册 Provider 列表，作为本轮检查范围。
		const providers = this.models.getProviders();
		// Promise.all 并发三类互不依赖的查询，解构对应结果。
		const [available, checks, credentials] = await Promise.all([
			// undefined 表示查所有供应商的聊天可用模型，底层会按凭证和供应商过滤策略筛选。
			this.models.getAvailable(undefined, { signal }),
			// 内部 Promise.all 并发每个供应商的认证配置检查。
			Promise.all(
				// map 为各 Provider 启动一个检查 Promise。
				providers.map(
					// async 回调返回元组 [id,认证检查]；显式元组类型避免推断成普通混合数组。
					async (provider): Promise<[string, AuthCheck | undefined]> => [
						// 元组第一项是供应商 id。
						provider.id,
						// checkAuth 不刷新 OAuth，只检查完整配置；结果可能 undefined。
						await this.models.checkAuth(provider.id, { signal }),
					],
				),
			),
			// 只列出凭证类型/供应商元信息，不把 token 写入 snapshot。
			this.credentials.list({ signal }),
		]);
		// 已有更新的全局刷新启动就丢弃本轮结果，不覆盖新状态。
		if (seq !== this.availabilityRefreshSeq) return;
		// 由 id/检查元组构造认证索引 Map。
		const auth = new Map(checks);
		// 下面从有检查结果的项生成配置可用供应商 Set。
		const configuredProviders = new Set(
			// 以本轮所有 [供应商 id,检查结果] 元组为筛选起点，不使用尚未同步的旧快照。
			checks
				// 类型谓词把有 AuthCheck 的元组留下，排除 undefined。
				.filter((entry): entry is [string, AuthCheck] => entry[1] !== undefined)
				// 解构每项只取供应商 id。
				.map(([providerId]) => providerId),
		);
		// 所有查询完成且代次有效后一次发布整个新快照。
		this.snapshot = {
			// 再次读取当前目录，避免只使用刷新开始时的目录数组。
			all: [...this.models.getModels()],
			// 保存底层已经经过可用性策略筛过的模型。
			available: [...available],
			// 保存有完整认证检查结果的供应商集合。
			configuredProviders,
			// 存储列表按 providerId 建 Set；包含临时 API Key 覆盖列表项。
			storedProviders: new Set(credentials.map((entry) => entry.providerId)),
			// 保存认证来源/类型索引，无真实认证秘密。
			auth,
		};
		// 只有没有更新错误代次时才能清掉错误，避免旧成功抹掉新失败。
		if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
	}

	// 发起全局可用性刷新。输入可选信号，返回完成 Promise；递增代次并记录非取消错误。
	// 这里的 queue 名称不表示凭证串行队列，刷新可并发，靠序号让旧结果失效；例如刷新 A 比 B 慢，A 最终不发布。
	private queueAvailabilityRefresh(signal?: AbortSignal): Promise<void> {
		// 前置 ++ 先加一再取值，标识当前最新全局请求。
		const seq = ++this.availabilityRefreshSeq;
		// 使所有已经启动的局部供应商查询失效，避免与此全局结果竞争。
		for (const [providerId, providerSeq] of this.providerAvailabilitySeq) {
			// 逐个增加局部代次，不需要等待旧查询真正结束。
			this.providerAvailabilitySeq.set(providerId, providerSeq + 1);
		}
		// 本轮同时成为最新可用性错误状态的拥有者。
		const errorSeq = ++this.availabilityErrorSeq;
		// 缺省信号归一为无超时的未取消信号，便于内部必填参数。
		const effectiveSignal = operationSignal(signal);
		// 启动刷新并挂错误回调：输入异常，必要时记录后再次抛出；不是吞掉失败。
		return this.runAvailabilityRefresh(seq, errorSeq, effectiveSignal).catch((error) => {
			// 只有当前错误代次且不是用户取消，才更新可展示错误。
			if (errorSeq === this.availabilityErrorSeq && !effectiveSignal.aborted) {
				// Error 取 message，其他抛出值转换为文字。
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			// 让调用方仍可 await 到真实失败。
			throw error;
		});
	}

	// 刷新单个供应商可用性。输入 id/取消信号，异步无值返回；更新该供应商在整体快照中的部分。
	// 使旧全局失效→并行查目录/认证/凭证→代次检查→合并快照；例如登录 p 后只重算 p，保留 q 的已有状态。不会通过聊天请求验证密钥。
	private async refreshProviderAvailability(providerId: string, signal: AbortSignal): Promise<void> {
		// Invalidate any full availability pass that started before this credential change.
		// 凭证局部变更使较早开始的全局查询不可再发布旧认证状态。
		++this.availabilityRefreshSeq;
		// 为这个供应商生成新局部代次；没查过时从 1 开始。
		const providerSeq = (this.providerAvailabilitySeq.get(providerId) ?? 0) + 1;
		// 立刻发布代次，使前一次同供应商查询失效。
		this.providerAvailabilitySeq.set(providerId, providerSeq);
		// 本轮也拥有一个新的错误代次。
		const errorSeq = ++this.availabilityErrorSeq;
		// 查询/取消/发布阶段的异常在下面统一记录和传播。
		try {
			// 三种查询并发执行，各结果按数组位置解构。
			const [available, auth, credential] = await Promise.all([
				// 取得该供应商经过策略筛选的可用聊天模型。
				this.models.getAvailable(providerId, { signal }),
				// 检查认证配置完整性，不刷新 OAuth。
				this.models.checkAuth(providerId, { signal }),
				// 读取现有凭证用于“已存储”状态；可能是运行期覆盖层返回值。
				this.credentials.read(providerId, { signal }),
			]);
			// 等待查询期间可能已取消，发布前再次检查。
			signal.throwIfAborted();
			// 新一轮同供应商查询已开始就丢弃本轮，不覆盖它。
			if (this.providerAvailabilitySeq.get(providerId) !== providerSeq) return;
			// 复制当前配置供应商 Set，后面只变本 id。
			const configuredProviders = new Set(this.snapshot.configuredProviders);
			// 同样复制存储供应商集合。
			const storedProviders = new Set(this.snapshot.storedProviders);
			// 复制认证结果 Map，保留其他供应商状态。
			const authByProvider = new Map(this.snapshot.auth);
			// 有检查结果代表该供应商认证配置完整。
			if (auth) {
				// 把此供应商加入 configured 集合。
				configuredProviders.add(providerId);
				// 更新其认证类型/来源。
				authByProvider.set(providerId, auth);
				// 没有结果时移除旧的认证就绪标记。
			} else {
				// 从 configured 集合删除该供应商。
				configuredProviders.delete(providerId);
				// 同时删除旧认证结果，避免 UI 继续显示过期类型。
				authByProvider.delete(providerId);
			}
			// 读到凭证就标记有存储/覆盖记录。
			if (credential) storedProviders.add(providerId);
			// 没读到则清除旧存储标记。
			else storedProviders.delete(providerId);
			// 读取目前聊天模型全目录，作为合并输出的稳定顺序。
			const all = [...this.models.getModels()];
			// 建立可用模型复合键索引，便于保留其他供应商并替换当前供应商。
			const availableById = new Map(
				// 先删旧 p 的可用项，再加新 available；map 将每模型变成 [键,对象]。
				[...this.snapshot.available.filter((model) => model.provider !== providerId), ...available].map((model) => [
					// provider 与 id 用零字符隔开，避免两字段边界歧义。
					`${model.provider}\0${model.id}`,
					// 索引值为原模型对象。
					model,
				]),
			);
			// 一次性替换快照引用，读者不会看到逐字段更新中间态。
			this.snapshot = {
				// 保存最新完整目录。
				all,
				// 按全目录顺序查可用索引；flatMap 遇缺项返回 [] 删除，命中模型对象作为一个元素保留。
				available: all.flatMap((model) => availableById.get(`${model.provider}\0${model.id}`) ?? []),
				// 保存局部更新后的配置供应商集合。
				configuredProviders,
				// 保存局部更新后的存储供应商集合。
				storedProviders,
				// auth 属性名显式绑定到更新后的 authByProvider Map。
				auth: authByProvider,
			};
			// 只由最新错误代次清除先前错误。
			if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
			// 捕获查询/取消异常，是否记入公共状态需再核对代次。
		} catch (error) {
			// 多行条件要求下面三个条件全部成立才保存错误。
			if (
				// 当前供应商没有被更新一轮查询抢先。
				this.providerAvailabilitySeq.get(providerId) === providerSeq &&
				// 本轮仍是最新错误状态来源。
				errorSeq === this.availabilityErrorSeq &&
				// 取消不作为一般可用性故障显示。
				!signal.aborted
			) {
				// 把当前有效异常转为可读状态文字。
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			// 无论是否写错误快照，原异常都向调用方传播。
			throw error;
		}
	}

	// 读取当前 Provider 列表。无参数，同步返回只读数组视图，无认证/网络刷新；例如 UI 列供应商时使用。
	getProviders(): readonly Provider[] {
		// 直接委托底层 Models 取最近注册对象。
		return this.models.getProviders();
	}

	// 按 id 查当前 Provider。输入字符串，同步返回对象或 undefined，无请求；例如查未知 id 返回空。
	getProvider(providerId: string): Provider | undefined {
		// 不自动创建供应商，不在这里检查登录状态。
		return this.models.getProvider(providerId);
	}

	// 读取最近已知聊天目录。输入可选供应商 id，同步返回模型列表，无刷新；例如没传 id 列全部聊天项，不含专用图片模型。
	getModels(providerId?: string): readonly Model<Api>[] {
		// 底层 getModels 读取 Provider 当前目录；不是直接返回 snapshot.all 字段。
		return this.models.getModels(providerId);
	}

	// 按供应商/id 查聊天模型。输入两个字符串，返回元数据或 undefined，无认证/网络操作；例如 UI 模糊匹配最后会拿到此具体对象。
	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		// 复用 Models 的聊天查找规则，可能包含已注册虚拟项。
		return this.models.getModel(providerId, modelId);
	}

	// 按模型种类列目录。输入 type/可选供应商，同步返回对应类型数组，无刷新。
	// 泛型 TType extends ModelType 将输入字面量与 ModelTypeMap[TType] 输出关联；例如 image 得图片模型列表。
	getModelsOfType<TType extends ModelType>(type: TType, providerId?: string): readonly ModelTypeMap[TType][] {
		// 按类型与供应商直接转交查询。
		return this.models.getModelsOfType(type, providerId);
	}

	// 按种类/供应商/id 查目录项。输入三字段，同步返回对应模型类型或 undefined，无网络。
	// 例如 type=classifier 时 TS 返回分类模型，运行时实际查找仍由底层按种类执行。
	getModelOfType<TType extends ModelType>(
		// 泛型字面量决定返回映射类型。
		type: TType,
		// 供应商标识。
		providerId: string,
		// 该种类下的模型 id；不同操作种类可以复用同一 upstream id。
		modelId: string,
		// 索引访问类型保证返回值与 type 关联，而不是总返回所有模型联合。
	): ModelTypeMap[TType] | undefined {
		// 底层负责目录查找及种类过滤。
		return this.models.getModelOfType(type, providerId, modelId);
	}

	// 读取所有种类目录。输入可选供应商 id，同步返回 AnyModel 数组，无刷新。
	// 例如同时列聊天、图片生成和分类元数据，区别于 getModels 只列聊天。
	getAllModels(providerId?: string): readonly AnyModel[] {
		// 转交底层聚合目录接口。
		return this.models.getAllModels(providerId);
	}

	// 查询某种类的认证可用模型。输入 type/供应商/认证选项，异步返回类型对应列表；不更新本类聊天 snapshot。
	// 例如获取可用 image 项会执行配置检查/供应商过滤，不等于发图像生成请求。
	getAvailableOfType<TType extends ModelType>(
		// 泛型 type 决定结果的模型形状。
		type: TType,
		// 省略供应商查全部。
		providerId?: string,
		// 可传取消信号控制认证/存储查询。
		options?: AuthOperationOptions,
		// readonly 限制调用者从 TS 修改返回数组，不强制冻结。
	): Promise<readonly ModelTypeMap[TType][]> {
		// 直接转交底层类型查询，异常原样传播。
		return this.models.getAvailableOfType(type, providerId, options);
	}

	// 查询所有种类的可用模型。输入可选供应商与认证选项，返回 Promise 列表，不修改本类聊天 snapshot。
	// 例如同时取认证可用聊天/图片模型，底层只验证配置并应用目录策略。
	getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		// 供调用者自行 await 的底层查询 Promise。
		return this.models.getAllAvailable(providerId, options);
	}

	// 检查认证配置。输入供应商及选项，返回类型/来源或 undefined；不刷新 OAuth、不发验证聊天。
	// 例如本地存有 OAuth 类型但已过期仍可能配置完整，真正 getAuth 才处理刷新。
	async checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		// async 包装后原样等待/转交底层结果，异常向外传播。
		return this.models.checkAuth(providerId, options);
	}

	// 查询可用聊天模型。输入可选供应商与选项，异步返回列表；单供应商只记录错误，全量刷新还会更新快照。
	// 例如不传 id 等完整快照刷新；传 p 则只返回 p 的本轮检查结果，不自动把它写入 snapshot.available。
	async getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		// 供应商字符串非空时使用局部直接查询路径。
		if (providerId) {
			// 给本轮可能的错误状态分配新代次。
			const errorSeq = ++this.availabilityErrorSeq;
			// 局部查询失败需要记录并继续传播。
			try {
				// 等待底层读取认证配置及过滤模型，不发聊天。
				const available = await this.models.getAvailable(providerId, options);
				// 若未被较新查询取代，清除之前可用性错误。
				if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
				// 直接返回该供应商的本轮结果，不在这里刷新全量快照。
				return available;
				// 捕获局部查询异常。
			} catch (error) {
				// 最新有效且没有被用户取消时，才保留错误文字。
				if (errorSeq === this.availabilityErrorSeq && !options?.signal?.aborted) {
					// 统一提取消息，供 getError 使用。
					this.availabilityError = error instanceof Error ? error.message : String(error);
				}
				// 调用方仍接到原异常。
				throw error;
			}
		}
		// 没有指定供应商时启动全量可用性查询并等待发布快照。
		await this.queueAvailabilityRefresh(options?.signal);
		// 返回刚发布（或因代次竞争保留的更新）快照列表。
		return this.snapshot.available;
	}

	// 读取已有可用聊天快照。无输入，同步返回最近列表，不检查凭证/不发请求。
	// 例如启动模型选择可快速用它，但它可能尚未反映刚改的认证。
	getAvailableSnapshot(): readonly Model<Api>[] {
		// 返回快照数组引用，只读约束在 TS 层。
		return this.snapshot.available;
	}

	// 汇总模型运行时错误。无输入，返回多段文字或 undefined，无网络/打印副作用。
	// 包括 models.json 错、逐供应商组合错和最后有效可用性错，段落用空行隔开。
	getError(): string | undefined {
		// 局部错误文字数组，稍后拼接。
		const errors: string[] = [];
		// 读取配置加载/解析/schema 错误，不重新加载文件。
		const configError = this.config.getError();
		// 存在配置错误才加入列表。
		if (configError) errors.push(configError);
		// 遍历逐供应商组合错误 Map。
		for (const [providerId, error] of this.compositionErrors) {
			// 为每条附供应商名称便于定位。
			errors.push(`Provider "${providerId}": ${error}`);
		}
		// 有有效可用性错误时附单独段落。
		if (this.availabilityError) errors.push(`Availability refresh: ${this.availabilityError}`);
		// 有错误才 join 两个换行，否则用 undefined 表示没有。
		return errors.length > 0 ? errors.join("\n\n") : undefined;
	}

	// 读取扩展配置式注册原值。输入 id，返回声明或 undefined，无副作用；例如兼容注册器重放配置时使用。不是已经合并完的 Provider。
	getRegisteredProviderConfig(providerId: string): ProviderConfigInput | undefined {
		// 只查 extensionProviders，不包含 models.json 或原生注册对象。
		return this.extensionProviders.get(providerId);
	}

	// 列扩展注册供应商 id。无输入，返回去重新数组，无网络。
	// 包括配置式和原生式扩展，但不单独加入仅有虚拟模型的 id。
	getRegisteredProviderIds(): readonly string[] {
		// 两类 Map 键展开到 Set 去重后再转数组。
		return [...new Set([...this.extensionProviders.keys(), ...this.nativeExtensionProviders.keys()])];
	}

	// 读取扩展原生 Provider。输入 id，返回对象或 undefined，无刷新；例如兼容注册器保存现成实现时使用。
	getRegisteredNativeProvider(providerId: string): Provider | undefined {
		// 只查原生扩展表，不返回最终配置包装对象。
		return this.nativeExtensionProviders.get(providerId);
	}

	/** @internal Compatibility fallback for ModelRegistry when provider auth is unconfigured. */
	// 取得旧 ModelRegistry 兼容请求配置。输入模型，返回 headers/authHeader；可解析配置命令/环境值，不执行聊天。
	// 这是未配置 Provider 认证时兼容后备路径，不能当作已成功认证。
	getCompatibilityRequestConfig(model: Model<Api>): CompatibilityRequestConfig {
		// 把合并规则交给 provider-composer，避免本类重复实现。
		return resolveCompatibilityRequestConfig(
			// 模型本身的 id/headers 也会参与解析。
			model,
			// 读取该供应商 models.json 层。
			this.config.getProvider(model.provider),
			// 读取扩展注册层。
			this.extensionProviders.get(model.provider),
		);
	}

	// 判断最近快照的认证种类是否 OAuth。输入供应商，返回 boolean，无实时读取/刷新。
	// 例如刚替换临时 key 但快照未同步前，结果仍可能是旧状态。
	isUsingOAuth(providerId: string): boolean {
		// 可选链无结果时比较为 false，不取得真实 token。
		return this.snapshot.auth.get(providerId)?.type === "oauth";
	}

	// 判断快照 OAuth 是否为订阅认证。输入 id，返回 boolean，无网络；还要求当前 Provider 显式 isSubscription:true。
	// 不是所有 OAuth 都代表可用付费订阅资格。
	isUsingSubscription(providerId: string): boolean {
		// && 短路：非 OAuth 时无需继续访问 Provider 订阅标志。
		return this.isUsingOAuth(providerId) && this.models.getProvider(providerId)?.auth.oauth?.isSubscription === true;
	}

	// 判断快照是否有完整认证配置。输入 id，同步返回 boolean，无实时 token 检验。
	// 例如恢复历史模型用这个快速筛选，真正请求仍要 getAuth 解析。
	hasConfiguredAuth(providerId: string): boolean {
		// 只读 configuredProviders 集合成员关系。
		return this.snapshot.configuredProviders.has(providerId);
	}

	// getAuth 的第一个重载：传供应商 id 时只做供应商级认证解析；重载签名本身没有函数体。
	getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	// 第二个重载：传具体模型时还会应用模型配置头；TS 根据实参选签名，运行时共用下面实现。
	getAuth(model: AnyModel, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	// 解析真实请求认证。输入供应商或模型及可选覆盖，返回 AuthResult/undefined，可能刷新/保存 OAuth 或执行配置值命令。
	// 供应商直转底层；模型在底层解析后再合并配置头。例如模型自有 X-Region 可覆盖认证头同名项；不在此发送聊天。
	async getAuth(
		// 联合输入在实现体中用 typeof 区分两个公共重载。
		providerOrModel: string | AnyModel,
		// 缺省覆盖为空对象；可含 key、环境、取消与最小 token 有效期。
		overrides: ModelRuntimeAuthOverrides = {},
		// 异步返回认证结果，不代表一次模型调用的完成结果。
	): Promise<AuthResult | undefined> {
		// 字符串输入直接走供应商级解析，无需模型头规则。
		if (typeof providerOrModel === "string") return this.models.getAuth(providerOrModel, overrides);
		// 模型输入先由底层处理供应商认证和模型静态头。
		const resolution = await this.models.getAuth(providerOrModel, overrides);
		// 未知/未配置认证时返回 undefined，不继续解析无目标请求头。
		if (!resolution) return undefined;
		// 随后解析模型在 models.json/扩展中的额外配置头。
		const configuredHeaders = resolveConfiguredModelHeaders(
			// 传完整模型，以 provider/id 定位配置。
			providerOrModel,
			// 读取用户模型配置覆盖。
			this.config.getProvider(providerOrModel.provider),
			// 读取扩展注册覆盖。
			this.extensionProviders.get(providerOrModel.provider),
			// 合并底层认证环境和调用方环境，后者同名优先，供头值解析使用。
			{ ...(resolution.env ?? {}), ...(overrides.env ?? {}) },
		);
		// 创建新结果对象，保留底层来源信息等元数据。
		return {
			// 浅复制认证结果而不改原对象。
			...resolution,
			// auth 子对象也需单独复制，才能只替换 headers。
			auth: {
				// 保留 apiKey/baseUrl 等已解析认证字段。
				...resolution.auth,
				// 模型配置头最高优先级，大小写无关覆盖；null 语义保留给下游。
				headers: mergeHeaders(resolution.auth.headers, configuredHeaders),
			},
		};
	}

	// 同供应商凭证操作串行。输入 id、信号及无参 async task，返回保留 T 的 Promise；不同 id 可并行。
	// 先等前一个结算（即使失败）→检查取消→标记 started→执行 task。排队期间取消可先结束调用者等待，但槽仍随链收尾；started 先胜出后返回 operation，等待真正任务结算，不强行释放串行槽。
	private enqueueCredentialOperation<T>(providerId: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
		// 取该供应商队尾，没有时使用已完成 Promise 立即允许首任务。
		const previous = this.credentialOperations.get(providerId) ?? Promise.resolve();
		// 稍后保存 started Promise 的 resolve 函数，类型是无参 void 回调。
		let markStarted: (() => void) | undefined;
		// executor 立即运行，只保存 resolve；此 Promise 表示任务已开始，不表示任务完成。
		const started = new Promise<void>((resolve) => {
			// 赋值的是函数引用，不在这里标记 started。
			markStarted = resolve;
		});
		// 立即调用 async IIFE 建立本次操作 Promise，IIFE 是定义后马上执行的函数表达式。
		const operation = (async () => {
			// 前项失败也必须等它真实结算；catch 吞旧错误，避免一错阻断后续所有凭证操作。
			await previous.catch(() => {});
			// 轮到自己时再查取消，排队取消的任务到这里不会开始 task。
			signal.throwIfAborted();
			// 允许开始后完成 started，外层可停止“排队取消竞赛”。
			markStarted?.();
			// 真正执行回调，异步返回值会被本 async 函数接管，异常也成为 operation 拒绝。
			return task();
			// 末尾 () 立刻启动 IIFE，不是只存一个函数定义。
		})();
		// 另建会吞错的队尾供下一项等待；调用者的 operation 错误仍保留。
		const tail = operation.catch(() => {});
		// 先把本项登记为最新队尾，后到请求必须排在它后面。
		this.credentialOperations.set(providerId, tail);
		// 队尾无论成功/失败最终都完成，在 then 回调里清理 Map；void 表示不等这条清理链。
		void tail.then(() => {
			// 只有自己仍是最新尾项才删键，避免旧任务收尾误删后来入队任务。
			if (this.credentialOperations.get(providerId) === tail) this.credentialOperations.delete(providerId);
		});
		// 仅在 started 上比赛取消；started 先完成后 then 返回完整 operation，Promise 会吸收其最终成功/失败。
		return raceWithAbortSignal(started, signal).then(() => operation);
	}

	// 凭证提交后同步本地状态。输入 id、操作、已提交凭证、信号，异步无值返回。
	// 重组 Provider→本地目录刷新→同步快照/认证；任何失败包装 CredentialSynchronizationError，不撤销已完成凭证变更。例如登录成功但取消同步，仍需承认存储已改变。
	private async synchronizeCredentialState(
		// 需要同步的供应商。
		providerId: string,
		// 已经成功完成的操作名称。
		operation: CredentialSynchronizationOperation,
		// 此前提交的凭证，错误里保留给调用方，可能 undefined。
		credential: Credential | undefined,
		// 与提交操作同一取消信号，取消同步也会产生部分成功错误。
		signal: AbortSignal,
		// 返回完成 Promise，不返回新的秘密值。
	): Promise<void> {
		// 把同步各阶段的错误保留为标准 cause 链。
		try {
			// 即使在提交后才取消，也应停止后续工作并报告同步未完成。
			signal.throwIfAborted();
			// 按现有配置和新认证状态重建该供应商对象。
			this.recomposeProvider(providerId);
			// 组合函数会记录而非直接抛组合错误，这里需要显式检查。
			const compositionError = this.compositionErrors.get(providerId);
			// 有组合错误就立即失败，不能把 base 后备对象当成已同步成功。
			if (compositionError) throw new Error(compositionError);
			// 只对该供应商从本地缓存/配置刷新目录，不允许这次目录联网。
			const result = await this.models.refresh({ allowNetwork: false, providers: [providerId], signal });
			// 底层报告 aborted 时，如信号确已取消则按原取消原因抛出。
			if (result.aborted) signal.throwIfAborted();
			// 读取该供应商刷新失败，其他供应商不在本次范围。
			const refreshError = result.errors.get(providerId);
			// 有具体刷新错误则向 catch 交原错误。
			if (refreshError) throw refreshError;
			// 目录刷新完更新同步模型快照，仍要后面重新核对认证。
			this.updateModelSnapshot();
			// 等待该供应商的可用模型、认证来源和存储状态更新。
			await this.refreshProviderAvailability(providerId, signal);
			// 此时凭证变更已成功，以下是同步阶段失败而不是写入失败。
		} catch (cause) {
			// 包装 cause，同时保留已提交凭证和操作，调用方不能据此假定回滚。
			throw new CredentialSynchronizationError(providerId, operation, credential, { cause });
		}
	}

	// 设置本进程临时 API Key。输入 id/key/可选信号，返回完成 Promise，不写持久 key。
	// 同供应商排队→覆盖 RuntimeCredentials→同步目录/认证；例如命令行 --api-key 只影响当前进程。同步失败时 key 已覆盖，不自动恢复。
	setRuntimeApiKey(providerId: string, apiKey: string, options: AuthOperationOptions = {}): Promise<void> {
		// 没有 signal 时补一个无截止时间的未取消信号。
		const signal = operationSignal(options.signal);
		// 注册无参异步任务，真正轮到此 id 的队列项时才写覆盖并等待同步。
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			// 先修改内存覆盖 Map，底层持久凭证保持原样。
			this.credentials.setRuntimeApiKey(providerId, apiKey);
			// 覆盖成功后同步本地目录与认证快照。
			await this.synchronizeCredentialState(
				// 同步目标供应商 id。
				providerId,
				// 错误元数据标明已经设置临时 key。
				"setRuntimeApiKey",
				// 按 api_key 凭证形状记录已提交值；这里包含秘密，不应随意日志输出。
				{ type: "api_key", key: apiKey },
				// 将同一取消信号传入同步阶段。
				signal,
			);
		});
	}

	// 移除本进程 key 覆盖。输入 id/可选选项，返回 Promise；不会删除 auth.json 原凭证。
	// 串行删除内存项后同步，后续认证回退到持久存储/环境；同步失败不把覆盖自动加回。
	removeRuntimeApiKey(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		// 归一化取消信号。
		const signal = operationSignal(options.signal);
		// 任务轮到时才执行删除和同步；注册闭包不是现在就删 key。
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			// 清除运行期覆盖，让持久存储重新可见。
			this.credentials.removeRuntimeApiKey(providerId);
			// 同步时 credential 为 undefined，仅表示移除覆盖，不断言底层所有认证都不存在。
			await this.synchronizeCredentialState(providerId, "removeRuntimeApiKey", undefined, signal);
		});
	}

	// 列凭证元信息。输入可选操作选项，返回只读列表 Promise，不返回真实秘密。
	// RuntimeCredentials 会把临时覆盖合并进去，例如某供应商临时 key 类型覆盖原 OAuth 列表项。
	listCredentials(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		// 直接委托覆盖层，读取/取消异常原样传播。
		return this.credentials.list(options);
	}

	// 取得 UI 认证来源状态。输入供应商 id，同步返回配置状态，不解析真实 token 或验证远端。
	// 优先临时→存储快照→models.json/扩展→认证快照。例如配置命令被视为“有来源”，并不在这里执行一次命令验证 key。
	getProviderAuthStatus(providerId: string): AuthStatus {
		// 只检查覆盖键是否登记，空字符串覆盖也可能 has=true；不要把这个 UI 状态当真实有效 key。
		if (this.credentials.hasRuntimeApiKey(providerId)) return { configured: true, source: "runtime" };
		// 最近列表有存储项就标 stored，不在此重新读磁盘。
		if (this.snapshot.storedProviders.has(providerId)) return { configured: true, source: "stored" };
		// 没有存储/运行期覆盖，再查模型配置中的 key 来源声明。
		const configured = configuredRequestAuthStatus(
			// 用户 models.json 层。
			this.config.getProvider(providerId),
			// 扩展注册层。
			this.extensionProviders.get(providerId),
		);
		// 配置明确给出结果（含 configured:false）时直接返回，不再用环境快照覆盖它。
		if (configured) return configured;
		// 最后看最近认证检查的类型/来源。
		const check = this.snapshot.auth.get(providerId);
		// 有检查就标环境来源并附 label，无检查返回 configured:false；这是显示分类，不是请求认证对象。
		return check ? { configured: true, source: "environment", label: check.source } : { configured: false };
	}

	// 为实际请求装配供应商、认证和参数。输入模型与可选配置，异步返回三者；可能刷新 OAuth/执行头值命令和变换回调，但尚未调用供应商模型操作。
	// 例如先合并 OpenCode 头→认证/模型头→本次请求头，再执行 transformHeaders；下一层才 stream/generateImages。
	private async prepareRequest<
		// TModel extends AnyModel 让同一实现服务聊天、图片和分类，保留具体模型类型。
		TModel extends AnyModel,
		// TOptions 同时满足该模型的请求参数与公共头变换契约；& 是交叉类型。
		TOptions extends ProviderRequestOptions<TModel> & ModelsRequestTransforms,
		// 结束泛型列表，下面是运行期实参。
	>(
		// 本次请求要使用的模型元数据。
		model: TModel,
		// 请求参数可缺省，泛型保留调用方选项字段。
		options: TOptions | undefined,
		// 返回 Promise 的内联对象类型。
	): Promise<{
		// 明确找到的 Provider 对象，不是可能 undefined 的查询结果。
		provider: Provider;
		// 可能套用认证 baseUrl 后的模型，类型仍是原 TModel。
		model: TModel;
		// Omit 去掉已消费的 transformHeaders，再与底层参数交叉，回调不会传给供应商重复执行。
		options: Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>;
		// 返回类型结束后开始实际认证与参数装配。
	}> {
		// 先根据 model.provider 查当前注册表。
		const provider = this.models.getProvider(model.provider);
		// 未知供应商立即报 provider 类错误，不能向不确定目标发送凭证。
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		// 解析本次模型真实认证，可能发生 OAuth 刷新/存储写入。
		const resolution = await this.getAuth(model, {
			// 本次显式 key 覆盖认证默认值。
			apiKey: options?.apiKey,
			// 本次环境覆写供认证和模型头值解析。
			env: options?.env,
			// 把请求取消信号沿认证层传递。
			signal: options?.signal,
		});
		// 未配置认证报 auth 类错误，后续实际请求不启动。
		if (!resolution) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);

		// 对象 rest 解构分离 transformHeaders，剩余选项才交供应商。
		const { transformHeaders, ...rawProviderOptions } = options ?? {};
		// 断言保留泛型字段关系；as 不复制/验证对象，值仍是上一行 rest 对象。
		const providerOptions = rawProviderOptions as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>;
		// 认证可覆盖 endpoint 时浅复制模型只改 baseUrl，否则复用原模型对象。
		const requestModel: TModel = resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model;
		// 不同种类请求不一定含 sessionId，下面只提取字符串形态。
		const sessionId =
			// in 判断泛型对象是否有字段，typeof 进一步区分实际联合值，供通用请求头助手使用。
			"sessionId" in providerOptions && typeof providerOptions.sessionId === "string"
				? // 合法字符串会话 id 原样保留。
					providerOptions.sessionId
				: // 没有该字段或不是字符串则不给会话头。
					undefined;
		// 按层级合并请求头，后面的覆盖前面的，名称比较忽略大小写。
		let headers = mergeHeaders(
			// 先让已解析认证/模型头覆盖 OpenCode 自动会话头。
			mergeHeaders(getOpenCodeSessionHeaders(requestModel, sessionId), resolution.auth.headers),
			// 本次请求显式 headers 优先于上述所有默认头。
			providerOptions.headers,
		);
		// 存在头变换回调才 await 执行，输入完整合并头或空对象；异常阻止后续请求。
		if (transformHeaders) headers = await transformHeaders(headers ?? {});
		// 合并解析认证环境与显式请求环境，双方都没提供则保持 undefined。
		const env =
			// 任一来源存在才创建环境对象。
			resolution.env || providerOptions.env
				? // 后展开的请求 env 对同名键优先，保留不重复的认证环境项。
					{ ...(resolution.env ?? {}), ...(providerOptions.env ?? {}) }
				: // 无环境保持缺省，不无故创建空字典。
					undefined;
		// 返回装配结果，调用者下一步才进入具体供应商操作。
		return {
			// 返回已查明 Provider 引用。
			provider,
			// 返回应用了 baseUrl 覆盖的模型对象。
			model: requestModel,
			// 构造独立请求参数对象。
			options: {
				// 先保留除 transformHeaders 外的原始选项。
				...providerOptions,
				// 显式请求 key 优先，否则使用已解析认证 key；?? 保留明确非空值。
				apiKey: providerOptions.apiKey ?? resolution.auth.apiKey,
				// 写入最终合并且变换过的头，包括仍需下游处理的 null 标记。
				headers,
				// 写入合并后的请求环境。
				env,
				// 断言输出符合消费掉变换器后的泛型契约，不执行运行时 schema 校验。
			} as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>,
		};
	}

	// 发送 API 专属聊天流。输入模型、上下文和选项，同步返回事件流；异步认证/请求随后经外层流转发，失败变 error 事件。
	// 先规范上下文，再 lazyStream 立即启动 setup；例如调用后即可 for await 接收 delta，并不等开始迭代才启动。
	stream<TApi extends Api>(
		// TApi 泛型把模型 api 与专属请求选项绑定。
		model: Model<TApi>,
		// 上下文含消息及可选顶层提示词/工具。
		context: Context,
		// 选项保留当前 API 特定能力和公共头变换。
		options?: ModelsApiStreamOptions<TApi>,
		// 方法不是 async，直接给调用方一个可迭代流对象。
	): AssistantMessageEventStream {
		// 把 systemPrompt/tools 规范到 system 消息，不做摘要或截断。
		const transcript = normalizeContext(context);
		// setup 回调无参数，异步返回供应商内层流；lazyStream 在本次调用中就开始它，认证错误转成外层错误事件。
		return lazyStream(model, async () => {
			// 在请求操作边界明确拒绝非聊天模型。
			assertChatModel(model);
			// 等待认证与参数准备，不先越过认证调用供应商。
			const prepared = await this.prepareRequest(
				// 把当前模型交给通用装配器。
				model,
				// 断言通用化 stream 选项以跨 API 装配；原实际值没改变。
				options as (StreamOptions & ModelsRequestTransforms) | undefined,
			);
			// 真正调用当前 Provider 的 stream；专属选项断言仅恢复原 API 类型关联。
			return prepared.provider.stream(prepared.model, transcript, prepared.options as ApiStreamOptions<TApi>);
		});
	}

	// 等待 API 专属聊天完整结果。输入同 stream，返回最终 AssistantMessage Promise；会实际请求模型。
	// 例如只想要完整答案而不逐 delta 展示时用 complete；内部仍按流执行，错误通常体现在消息 stopReason。
	complete<TApi extends Api>(
		// 具体聊天模型，泛型约束与 options 一致。
		model: Model<TApi>,
		// 本轮完整上下文。
		context: Context,
		// 当前 API 的可选配置。
		options?: ModelsApiStreamOptions<TApi>,
		// 返回的不是 delta，而是流结束后的完整消息。
	): Promise<AssistantMessage> {
		// 调用 stream 启动工作，再 result() 等待同一条流的最终消息。
		return this.stream(model, context, options).result();
	}

	// 发送通用简单聊天流。输入模型/上下文/选项，返回事件流；物理模型直接认证请求，虚拟模型先路由到真实模型。
	// 例如摘要直接使用虚拟选择时在这里 reason=direct 路由；切到其他供应商会去掉原 apiKey/headers/env，避免凭证跨供应商传递。
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		// 先规范化上下文，路由器也看到包含系统信息的完整消息。
		const transcript = normalizeContext(context);
		// 虚拟目录项不是实际 API，需要在请求前确定物理模型。
		if (isVirtualModel(model)) {
			// Requests outside the agent loop are routed here. Callers sized them before routing, so
			// cap the output budget to the routed model.
			// 虚拟 setup 无参异步返回递归物理流，立即开始路由；失败也转为外层错误事件。
			return lazyStream(model, async () => {
				// 等待用户/扩展声明的 route 决定真实模型及思考级别。
				const route = await this.resolveModel(model, transcript.messages, {
					// agent-loop 之外的这条路径标 direct，不在此持久化分支路由状态。
					reason: "direct",
					// 通用 reasoning 未给时用 off 作为路由输入级别。
					thinkingLevel: options?.reasoning ?? "off",
					// 把请求信号交给路由器，是否及时响应仍由路由实现合作。
					signal: options?.signal,
				});
				// 对象解构并改名，取物理模型最大输出 token 预算。
				const { maxTokens: limit } = route.model;
				// 显式预算为真且模型限制大于 0 时取较小值；否则保留调用者原预算，不自动创造一个预算值。
				const maxTokens = options?.maxTokens && limit > 0 ? Math.min(options.maxTokens, limit) : options?.maxTokens;
				// off 转为底层 reasoning 未指定，其余用路由器决定并已收窄的级别。
				const reasoning = route.thinkingLevel === "off" ? undefined : route.thinkingLevel;
				// Caller credentials were resolved for the virtual model's provider. Another provider
				// resolves its own, so they are not sent to the wrong vendor.
				// 从选项中单独拆出可能含原供应商认证信息的三个字段。
				const { apiKey, headers, env, ...rest } = options ?? {};
				// 同供应商保留这些字段，跨供应商用空对象，目标将重新解析自己的认证。
				const auth = route.model.provider === model.provider ? { apiKey, headers, env } : {};
				// 递归进入已校验的物理模型路径；保留其他配置并用路由结果覆盖预算/思考。
				return this.streamSimple(route.model, context, { ...rest, ...auth, maxTokens, reasoning });
			});
		}
		// 物理 setup 无参异步返回供应商简单流，马上开始认证；lazyStream 负责转发事件/包装 setup 错误。
		return lazyStream(model, async () => {
			// 请求边界确认是聊天模型，防止把图片模型误送聊天协议。
			assertChatModel(model);
			// 等待认证与最终头/环境装配。
			const prepared = await this.prepareRequest(model, options);
			// 真正进入 Provider.streamSimple，开始由它负责网络与协议处理。
			return prepared.provider.streamSimple(prepared.model, transcript, prepared.options as SimpleStreamOptions);
		});
	}

	// 通用聊天一次等完整结果。输入模型/上下文/选项，返回最终助手消息 Promise，实际执行请求。
	// 例如 compaction 摘要只需完整文字时可用；内部复用 streamSimple，包括虚拟路由和错误流语义。
	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		// 启动通用流并等待其 result，不另发第二次请求。
		return this.streamSimple(model, context, options).result();
	}

	// 取回远端延迟任务的流。输入聊天模型、句柄与选项，同步返回事件流；会认证并调用 fetchDeferred。
	// 例如前次返回任务句柄，本次流式等最终结果；不支持此能力会返回错误事件。
	streamDeferred(
		// 任务所属模型元数据，用于找供应商和认证。
		model: Model<Api>,
		// 远端任务句柄，原样交供应商解释。
		handle: DeferredHandle,
		// 可含取消/请求头变换等读取选项。
		options?: ModelsDeferredFetchOptions,
		// 直接返回流而不是等待任务完成。
	): AssistantMessageEventStream {
		// setup 回调立即开始类型检查/认证，返回内层延迟结果流；失败由 lazyStream 包装。
		return lazyStream(model, async () => {
			// 此延迟结果入口只支持聊天模型。
			assertChatModel(model);
			// 先解析任务供应商的实际认证。
			const prepared = await this.prepareRequest(model, options);
			// Provider 的延迟能力是可选方法，需在能力边界检查。
			if (!prepared.provider.fetchDeferred) {
				// 缺少能力时报稳定 provider 错误，之后转成外层流事件。
				throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
			}
			// 实际启动远端任务结果获取，handle 与认证后模型/参数一起传递。
			return prepared.provider.fetchDeferred(prepared.model, handle, prepared.options as DeferredFetchOptions);
		});
	}

	// 等待延迟任务完整消息。输入模型、句柄、选项，返回 Promise；实际读取一次远端任务。
	// 例如不需要 delta 的客户端用 fetchDeferred，底层仍复用 streamDeferred。
	async fetchDeferred(
		// 已有任务所属聊天模型。
		model: Model<Api>,
		// 原有远端句柄，不在这里创建新任务。
		handle: DeferredHandle,
		// 读取配置与可选 signal。
		options?: ModelsDeferredFetchOptions,
		// 结果是最终 AssistantMessage，失败遵循流结果状态。
	): Promise<AssistantMessage> {
		// 复用一条延迟结果流，等待其完整消息。
		return this.streamDeferred(model, handle, options).result();
	}

	// 请求取消远端延迟任务。输入模型、句柄、选项，异步无值返回；需要供应商支持 cancelDeferred，否则抛错。
	// 例如用户明确取消后台 response 时使用；等待完成不意味着本函数自行回收全部会话历史。
	async cancelDeferred(
		// 任务所属聊天模型。
		model: Model<Api>,
		// 远端 handle 由供应商格式定义。
		handle: DeferredHandle,
		// 取消请求本身也可带认证/超时等参数。
		options?: ModelsDeferredCancelOptions,
		// 方法失败通过拒绝 Promise 报告，不包装成助手流消息。
	): Promise<void> {
		// 操作边界校验聊天种类。
		assertChatModel(model);
		// 取消接口也需完整认证与请求头准备。
		const prepared = await this.prepareRequest(model, options);
		// 运行时检测 Provider 是否声明取消能力。
		if (!prepared.provider.cancelDeferred) {
			// 不支持时明确抛错，不假装任务已取消。
			throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
		}
		// 真正调用远端取消实现并等待完成。
		await prepared.provider.cancelDeferred(prepared.model, handle, prepared.options as DeferredCancelOptions);
	}

	// 通过专用图片模型生成图像。输入模型/图像上下文/选项，返回 AssistantImages；捕获异常转失败结果。
	// 流程：类型检查→认证装配→能力检查→供应商请求，例如无图像能力会返回 stopReason:error，而不向外继续 throw。
	async generateImages(
		// 图片生成模型，区别于能看图的聊天模型。
		model: ImageModel<ImageApi>,
		// 图片任务输入，具体图像 prompt/参考等由协议定义。
		context: ImagesContext,
		// 图像请求配置和公共头变换。
		options?: ModelsImagesOptions,
		// 异步结果可能成功或 error/aborted，调用方需要读 stopReason。
	): Promise<AssistantImages> {
		// 将校验、认证与请求的所有异常统一转成结果。
		try {
			// 在操作种类边界确认是专用图片模型。
			assertImageModel(model);
			// 准备认证、endpoint、headers 与环境。
			const prepared = await this.prepareRequest(model, options);
			// Provider 的图片能力可省略，不能仅因目录有模型就假定方法存在。
			if (!prepared.provider.generateImages) {
				// 缺少能力时抛出的错误会被本方法 catch 转结果。
				throw new ModelsError("provider", `Provider ${model.provider} does not support image generation`);
			}
			// await 实际图像请求，让异步拒绝也能进入本方法 catch。
			return await prepared.provider.generateImages(prepared.model, context, prepared.options as ImagesOptions);
			// 捕获请求或准备阶段异常。
		} catch (error) {
			// 返回空输出错误结构；signal 已取消时使用 aborted 状态。
			return imageErrorResult(model, error, options?.signal?.aborted);
		}
	}

	// 通过专用分类模型处理结构化输入。输入模型/context/选项，返回 ClassifierResult；异常转换为失败结果。
	// 先验证种类及图片输入能力，再认证、检查 Provider.classify 并调用，例如纯文本分类模型收到图片会在本地返回错误。
	async classify(
		// 类型受分类 API 约束的模型目录项。
		model: ClassifierModel<ClassifierApi>,
		// 分类输入上下文，可能包含图片等模态。
		context: ClassifierContext,
		// 分类参数与公共头变换。
		options?: ModelsClassifierOptions,
		// 返回分类答案或错误状态，不用普通 assistant 文本代替分类结构。
	): Promise<ClassifierResult> {
		// 整个类型/能力/认证/请求阶段都纳入失败结果转换。
		try {
			// 先核对分类模型种类。
			assertClassifierModel(model);
			// 有图片时核对模型目录是否允许 image 输入，不检查图片字节有效性。
			assertClassifierInputSupported(model, context);
			// 准备真实认证与供应商请求配置。
			const prepared = await this.prepareRequest(model, options);
			// 确认 Provider 有分类操作方法。
			if (!prepared.provider.classify) {
				// 没有能力抛稳定 provider 错，再由 catch 转分类错误结果。
				throw new ModelsError("provider", `Provider ${model.provider} does not support classification`);
			}
			// 真正发起分类操作，await 保证异步错误也被下面捕获。
			return await prepared.provider.classify(prepared.model, context, prepared.options as ClassifierOptions);
			// 捕获准备与请求阶段错误。
		} catch (error) {
			// 构造空答案失败结果，按 signal 区分 error/aborted。
			return classifierErrorResult(model, error, options?.signal?.aborted);
		}
	}

	// 按供应商登录并同步快照。输入 id、认证种类、交互对象和可选选项，返回已保存凭证 Promise。
	// 同供应商串行；底层登录/写凭证成功后再同步目录与认证。同步失败不撤销登录，抛 CredentialSynchronizationError；例如用户授权 OAuth 成功后即使本地刷新出错，token 也可能已落盘。
	login(
		// 登录目标供应商，必须已注册且支持相应流程。
		providerId: string,
		// api_key 或 oauth 等登录种类。
		type: AuthType,
		// 宿主的浏览器/输入/通知等交互回调及 signal，真实行为由供应商登录实现决定。
		interaction: AuthInteraction,
		// 供应商登录可选配置。
		options?: LoginOptions,
		// 返回秘密凭证实体，不应作为普通日志随意打印。
	): Promise<Credential> {
		// 登录的取消信号来自 interaction，不是随意给它加固定超时。
		const signal = operationSignal(interaction.signal);
		// 注册无参异步任务：排队轮到后才真正登录、保存和同步。
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			// 底层执行登录交互并持久保存返回凭证，等待真正完成写入。
			const credential = await this.models.login(providerId, type, { ...interaction, signal }, options);
			// 提交成功后刷新本地 Provider/可用性；失败是部分成功同步错误。
			await this.synchronizeCredentialState(providerId, "login", credential, signal);
			// 同步成功才正常返回已提交凭证。
			return credential;
		});
	}

	// 按供应商退出登录。输入 id/选项，返回 Promise，无值；会删除底层凭证及临时覆盖并同步状态。
	// 同 id 排队，删除成功后同步失败不会恢复旧凭证；例如退出后 UI 快照失败仍需承认凭证已删除。
	logout(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		// 复用调用方信号或建立未取消的默认信号。
		const signal = operationSignal(options.signal);
		// 队列轮到才执行底层删除与同步，保持同供应商顺序。
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			// 等待存储实际删除完成，RuntimeCredentials.delete 还会清掉临时覆盖。
			await this.models.logout(providerId, { signal });
			// 以 logout 操作和 undefined 凭证同步后续目录/认证快照。
			await this.synchronizeCredentialState(providerId, "logout", undefined, signal);
		});
	}

	// 刷新模型配置/目录/认证可用性。输入可选范围、网络许可、信号，返回 aborted 和错误 Map。
	// 先重读 models.json→重组 Provider→底层刷新目录→更新快照→查询可用性；不发聊天。显式 allowNetwork 覆盖默认，单供应商可用性错合进 errors；全量可用性错保存在 getError 的状态中。
	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		// 每次重新加载同一配置源，配置错误通过 ModelConfig 快照保留。
		this.config = await ModelConfig.load(this.modelsPath);
		// 按新配置恢复/补齐 Radius Provider 基础表。
		this.configureRadiusProviders();
		// 传 providers（即使空数组）表示限定范围分支。
		if (options.providers) {
			// Set 去重范围 id，只重组这些供应商对象。
			for (const providerId of new Set(options.providers)) this.recomposeProvider(providerId);
			// 局部 Provider 变化后同步更新聊天目录快照。
			this.updateModelSnapshot();
			// 没有范围就重建全部 Provider。
		} else {
			// 完整清空/组合并更新目录，删除已经不存在的来源。
			this.rebuildProviders();
		}
		// 给底层刷新构造有效参数对象。
		const refreshOptions = {
			// 保留 force/providers/signal 等调用方选项。
			...options,
			// 显式 allowNetwork 优先，包括 true；否则采用创建时默认。这不是 PI_OFFLINE 的不可覆盖硬封锁。
			allowNetwork: options.allowNetwork ?? this.modelNetworkEnabled,
		};
		// Published pi-ai builds before ModelsStore returned void and accepted a provider ID.
		// The fallback keeps source-mode CLI tests working without rebuilding workspace dependencies.
		// 等待底层目录刷新；兼容旧已构建 pi-ai 返回 void 时用默认结果。as 只适配 TS，?? 才执行运行时回退。
		const result = ((await this.models.refresh(refreshOptions)) as ModelsRefreshResult | undefined) ?? {
			// 兼容结果的取消状态来自 signal，没信号默认为 false。
			aborted: refreshOptions.signal?.aborted ?? false,
			// 旧实现没有按供应商错误集合时用空 Map。
			errors: new Map(),
		};
		// 复制底层错误 Map，后面可添加可用性查询错误而不改底层结果。
		const errors = new Map(result.errors);
		// 目录刷新后重新读取当前聊天模型集合。
		this.updateModelSnapshot();
		// 限定范围时逐个同步可用性，以便局部凭证状态立即更新。
		if (options.providers) {
			// Promise.all 并发不同供应商的可用性查询。
			await Promise.all(
				// 去重后 map async 回调，每项只更新自己的供应商，并自行收集错误。
				[...new Set(options.providers)].map(async (providerId) => {
					// 每个局部查询单独捕获异常，其他项仍继续。
					try {
						// 补齐 signal 并执行该供应商目录/认证/凭证状态同步。
						await this.refreshProviderAvailability(providerId, operationSignal(options.signal));
						// 局部查询失败不使整个 Promise.all 提前拒绝。
					} catch (error) {
						// 取消时不当作普通供应商错误追加。
						if (!options.signal?.aborted) {
							// 把异常标准化为 Error 后记入该供应商 errors。
							errors.set(providerId, error instanceof Error ? error : new Error(String(error)));
						}
					}
				}),
			);
			// 全量刷新则统一更新全部认证/可用性快照。
		} else {
			// 全量可用性失败由自身错误状态保留，这里不让已刷目录结果完全失效。
			try {
				// 启动并等待全局检查，代次控制保证旧结果不覆盖新结果。
				await this.queueAvailabilityRefresh(options.signal);
				// 此处故意忽略拒绝；getError 仍可报告最新有效可用性错误。
			} catch {
				// Availability errors are recorded by the latest pass; refreshed models remain usable.
			}
		}
		// 最终 aborted 同时考虑底层结果和外部 signal，errors 合并目录与局部可用性失败。
		return { aborted: result.aborted || (options.signal?.aborted ?? false), errors };
	}

	// 注册完整原生 Provider。输入对象，无返回值；更新注册表/目录并启动不联网刷新。
	// 空 id 抛错；同 id 配置式注册被替换，例如扩展可提供自己实现的 streamSimple。注册不意味着已经发送模型请求或同步等完认证检查。
	registerNativeProvider(provider: Provider): void {
		// 扩展声明边界拒绝空白 id，但不修改有空白的非空原 id。
		if (!provider.id.trim()) throw new Error("Provider id must not be empty.");
		// 同名原生注册取代配置式扩展覆盖。
		this.extensionProviders.delete(provider.id);
		// 保存 Provider 原对象引用。
		this.nativeExtensionProviders.set(provider.id, provider);
		// 重新叠加用户配置和虚拟目录，更新底层实际注册。
		this.recomposeProvider(provider.id);
		// 同步使目录立即能列新模型。
		this.updateModelSnapshot();
		// 异步认证刷新前先按存储/明确配置临时标已配置，减少初选空窗。
		this.markProvisionallyConfigured(
			// 本次供应商 id。
			provider.id,
			// 只按 models.json 配置判断是否存在 key 来源，扩展配置层此时已清除。
			configuredRequestAuthStatus(this.config.getProvider(provider.id), undefined),
			// 只有纯 OAuth 无 apiKey 方法才标 oauth，否则暂按 api_key。
			provider.auth.oauth && !provider.auth.apiKey ? "oauth" : "api_key",
		);
		// void 明确不等待 Promise，目录刷新禁网络；实际认证可用性稍后完成，并非返回时已经验证成功。
		void this.refresh({ allowNetwork: false });
	}

	/**
	 * Mark a newly registered provider as configured when it has a stored credential or a configured
	 * API key. Availability checks run asynchronously, and callers such as initial model selection
	 * read the snapshot before they finish. The next availability pass replaces this entry.
	 */
	// 为新注册供应商临时补配置快照。输入 id、配置状态和认证种类，无返回值；不读取秘密、不验证远端。
	// 有存储项或明确配置才补，已有真实 check 不覆盖；例如刚注册含 models.json key 的 Provider 可立即用于初选，后续刷新再替换临时状态。
	private markProvisionallyConfigured(
		// 需要暂时标就绪的供应商。
		providerId: string,
		// 配置来源检测结果，可缺省或 configured:false。
		configuredStatus: AuthStatus | undefined,
		// 临时认证类型标签，后续真实 check 会替换。
		type: AuthType,
		// 这是同步快照更新，不返回认证凭证。
	): void {
		// 既没有存储/覆盖记录，也没有明确配置，就不能臆造就绪状态。
		if (!this.snapshot.storedProviders.has(providerId) && !configuredStatus?.configured) return;
		// 复制 Set 并加入当前 id，保留其他供应商。
		const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
		// 复制认证 Map，后续仅在缺项时加临时标签。
		const auth = new Map(this.snapshot.auth);
		// Never clobber a real check result.
		// 已有真实结果就保留，避免临时猜测覆盖准确来源。
		if (!auth.get(providerId)) auth.set(providerId, { type, source: "configured provider" });
		// 整体替换快照引用。
		this.snapshot = {
			// 保留全目录与存储集合等其他字段。
			...this.snapshot,
			// 保存补齐后的认证标签表。
			auth,
			// 保存临时配置就绪集合。
			configuredProviders,
			// 按新集合从聊天目录粗筛可用模型，供应商细筛稍后异步刷新。
			available: this.snapshot.all.filter((model) => configuredProviders.has(model.provider)),
		};
	}

	// 注册配置式扩展 Provider。输入 id/配置，无返回值；先验证，再合并已定义字段、更新目录并后台刷新。
	// 重复注册保留旧未覆盖字段，显式 undefined 不擦除旧值；例如只更新 baseUrl 时旧 apiKey 配置还在。输入结构错误会在修改旧注册之前抛出。
	registerProvider(providerId: string, config: ProviderConfigInput): void {
		// Validate the incoming registration on its own, like the legacy registry:
		// a broken re-registration must throw without touching the stored config.
		// 注册信任边界校验本次输入，不能先修改旧状态再发现配置非法。
		validateExtensionProvider(providerId, this.builtins.get(providerId), this.config.getProvider(providerId), config);
		// 配置式注册取代同 id 原生扩展 Provider，但仍可叠加内置基础。
		this.nativeExtensionProviders.delete(providerId);
		// Re-registration merges defined values over the previous registration and
		// preserves undefined ones, matching the legacy ModelRegistry contract.
		// 取得旧配置式注册值，用于保留未重新声明字段。
		const previous = this.extensionProviders.get(providerId);
		// 浅复制旧字段形成新 effective 对象，不原地改旧对象。
		const effective: ProviderConfigInput = { ...previous };
		// 逐一遍历本次配置显式给出的字段。
		for (const [key, value] of Object.entries(config)) {
			// 只写非 undefined；Record 断言让动态字段赋值可通过 TS，不验证运行时值形状。
			if (value !== undefined) (effective as Record<string, unknown>)[key] = value;
		}
		// 保存合并后的扩展配置。
		this.extensionProviders.set(providerId, effective);
		// 按当前内置/用户配置组合出实际 Provider。
		this.recomposeProvider(providerId);
		// 同步更新聊天模型目录快照。
		this.updateModelSnapshot();
		// 若已有凭证或配置 key，补临时认证就绪状态。
		this.markProvisionallyConfigured(
			// 当前供应商 id。
			providerId,
			// 按用户配置和本次有效扩展覆盖计算配置来源。
			configuredRequestAuthStatus(this.config.getProvider(providerId), effective),
			// 纯 OAuth 扩展暂标 oauth，其余暂标 api_key，最终由 check 更新。
			effective.oauth && !effective.apiKey ? "oauth" : "api_key",
		);
		// 后台本地目录/可用性刷新，不 await，不在注册时发模型问答。
		void this.refresh({ allowNetwork: false });
	}

	// 撤销供应商的扩展覆盖。输入 id，无返回值；移除配置式/原生式注册后重组并后台刷新。
	// 例如 p 原本也有内置实现，撤销后会回到内置，而不是保证 p 从所有来源消失；虚拟模型表也不在这里清除。
	unregisterProvider(providerId: string): void {
		// 删除配置式扩展声明。
		this.extensionProviders.delete(providerId);
		// 删除原生扩展对象。
		this.nativeExtensionProviders.delete(providerId);
		// 重新按剩余内置/用户配置/虚拟项决定实际 Provider。
		this.recomposeProvider(providerId);
		// 刷新同步目录快照。
		this.updateModelSnapshot();
		// 后台本地刷新认证/可用性，方法返回不等它完成。
		void this.refresh({ allowNetwork: false });
	}

	/**
	 * Register a virtual model under `definition.provider`, which may also list physical models or
	 * several virtual models. Re-registering the same provider and id replaces the virtual model.
	 * Throws when the id belongs to a physical model of that provider.
	 */
	// 注册虚拟模型选择和路由回调。输入声明，无返回值；修改虚拟表/目录并后台本地刷新，不执行 route。
	// 拒绝空 id 或与物理项冲突，同 provider/id 再注册替换原虚拟项；例如 smart 在每次请求才由回调选物理模型。
	registerVirtualModel(definition: VirtualModelDefinition): void {
		// 解构并把 provider 改名 providerId，避免与 Provider 对象变量混淆。
		const { provider: providerId, id } = definition;
		// 扩展声明边界拒绝空白供应商或模型 id，不悄悄生成新名称。
		if (!providerId.trim() || !id.trim()) throw new Error("Virtual model provider and id must not be empty.");
		// 查当前聊天目录该 id 是否已被占用。
		const existing = this.models.getModel(providerId, id);
		// 已有物理聊天模型时不能用虚拟声明覆盖它。
		if (existing && !isVirtualModel(existing)) {
			// 抛明确冲突错误，虚拟表尚未写入。
			throw new Error(`Virtual model ${providerId}/${id} conflicts with a physical model.`);
		}
		// 复用已有供应商二级表，否则创建新 Map。
		const models = this.virtualModels.get(providerId) ?? new Map<string, RegisteredVirtualModel>();
		// 保存生成的虚拟目录与 route 转接闭包；request 输入原样交声明回调，只有后续 resolveModel 才调用，副作用由回调实现决定。
		models.set(id, { model: createVirtualModel(definition), route: (request) => definition.route(request) });
		// 把二级表写回总表，首次注册也变得可查询。
		this.virtualModels.set(providerId, models);
		// 重组底层目录；若没有物理 Provider 且快照还未配置，需给纯虚拟供应商补无秘密占位状态。
		if (!this.recomposeProvider(providerId) && !this.snapshot.configuredProviders.has(providerId)) {
			// A provider of only virtual models needs no credentials. Mark it configured now: session
			// restore checks auth before the refresh below lands.
			// 临时认证标签 source=virtual，仅表示路由入口自身不需要秘密，目标物理模型仍须自己的认证。
			const auth = new Map(this.snapshot.auth).set(providerId, { type: "api_key", source: "virtual" });
			// 复制配置供应商 Set 并加入纯虚拟 id，恢复历史时可识别其选择。
			const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
			// 保留其他快照字段，更新虚拟就绪标签。
			this.snapshot = { ...this.snapshot, auth, configuredProviders };
		}
		// 同步加入虚拟目录项与粗筛可用性。
		this.updateModelSnapshot();
		// 后台本地目录/认证刷新，最终细化快照。
		void this.refresh({ allowNetwork: false });
	}

	// 撤销一个虚拟模型。输入 provider/id，无返回值；删除声明、重组目录并后台刷新。
	// 不存在直接返回；最后一个虚拟项移除后删空二级表，但同供应商的真实 Provider 仍可保留。
	unregisterVirtualModel(providerId: string, id: string): void {
		// 取供应商的虚拟表，可能不存在。
		const models = this.virtualModels.get(providerId);
		// 可选链删除失败或无表就提前结束，无需无效重建。
		if (!models?.delete(id)) return;
		// 二级表空了就移除总表中的供应商键。
		if (models.size === 0) this.virtualModels.delete(providerId);
		// 按剩余来源重新组合实际 Provider。
		this.recomposeProvider(providerId);
		// 立即更新聊天目录快照。
		this.updateModelSnapshot();
		// 后台本地刷新可用性，返回时不保证它已完成。
		void this.refresh({ allowNetwork: false });
	}

	/**
	 * Ask a virtual model's router for the model and thinking level of one request. The router must
	 * return a physical catalog model whose provider has credentials; the thinking level is clamped
	 * to that model. Throws when routing fails.
	 *
	 * `previous` reports the latest successful response in `messages`. A retry passes the failed
	 * response as `options.failed`; `messages` no longer contains it. `options.state` is the router
	 * state stored by the caller, which also stores the returned state.
	 */
	// 执行一次虚拟路由。输入虚拟选择、消息和原因/思考/失败/状态，异步返回物理 ModelRoute。
	// 先取注册回调→补最近成功/失败物理模型→await route→核对目标为目录物理项且快照有认证→限制思考。此函数不直接调用物理 stream，route 自身可有用户定义副作用；例如 smart 重试改到另一个已配置供应商。
	async resolveModel(
		// 当前虚拟目录选择，不能将其直接发供应商。
		model: Model<Api>,
		// 只读消息上下文，供路由器判断轮次和最近结果。
		messages: readonly Message[],
		// 附加路由信息对象，状态存取由外层会话负责，本函数仅转交。
		options: {
			// 原因有 user/continuation/retry/direct 等，影响路由器策略。
			reason: ModelRouteReason;
			// 当前选中思考级别，路由器可以改成目标支持的级别。
			thinkingLevel: ModelThinkingLevel;
			// 可选取消信号由路由回调合作处理，本函数没有另加通用取消竞赛。
			signal?: AbortSignal;
			// 失败响应可用于重试决策；路由本身失败时可能没有可用物理模型。
			failed?: AssistantMessage;
			// 任意路由状态 unknown，具体结构由声明者负责，不自动校验/序列化。
			state?: unknown;
		},
		// 返回实际目录模型、有效思考级别以及回调返回状态。
	): Promise<ModelRoute> {
		// 先构造标识文字，后续错误复用同一名称。
		const name = `Virtual model ${model.provider}/${model.id}`;
		// 从供应商/id 二级虚拟表取已注册目录与 route。
		const virtual = this.virtualModels.get(model.provider)?.get(model.id);
		// 目录项若已被撤销，明确拒绝而不是猜默认物理目标。
		if (!virtual) throw new Error(`${name} is not registered.`);
		// 拆出 failed，其余 reason/thinkingLevel/signal/state 一并交路由器。
		const { failed, ...request } = options;
		// 从消息中找最近一次非 error/aborted 的助手结果。
		const latest = findLatestResponse(messages);
		// 仅当前目录里仍存在且非虚拟的模型能作为 previous 物理元数据。
		const previousModel = latest && this.getPhysicalModel(latest.provider, latest.model);
		// A failed routing attempt names the virtual model; there is no physical request to report.
		// 同样查失败响应是否确实指向物理模型；路由失败留下虚拟名时查不到。
		const failedModel = failed && this.getPhysicalModel(failed.provider, failed.model);
		// 真正调用已注册路由回调并等待结果；这一步不是调用 Provider.stream。
		const route = await virtual.route({
			// 展开本次原因、级别、信号与旧状态。
			...request,
			// 把虚拟选择元数据传给路由器，便于区分同供应商多个虚拟入口。
			model,
			// 有最近物理响应才提供 previous，并附当时思考级别。
			previous: previousModel && { model: previousModel, thinkingLevel: latest?.thinkingLevel },
			// 只有失败响应与其物理模型都存在才提供 failed，避免把路由失败伪装成物理请求失败。
			failed: failedModel && failed && { model: failedModel, thinkingLevel: failed.thinkingLevel, message: failed },
			// 将完整只读上下文交给路由策略，不在此压缩或删工具结果。
			messages,
		});
		// 不直接信任 route 返回的整个模型对象，按 provider/id 重新取当前目录的物理聊天模型。
		const target = this.getPhysicalModel(route.model.provider, route.model.id);
		// 构造包含虚拟来源和目标的诊断说明。
		const routed = `${name} routed to ${route.model.provider}/${route.model.id}`;
		// 目标不存在或仍是虚拟项就拒绝，不支持无限虚拟递归跳转。
		if (!target) throw new Error(`${routed}, which is not a physical model.`);
		// 要求目标供应商在最近配置快照中已就绪；这不是现场刷新 token，真正请求仍会 prepareRequest/getAuth。
		if (!this.hasConfiguredAuth(target.provider)) throw new Error(`${routed}, which has no credentials.`);
		// 返回当前目录模型与能力收窄后的思考级别，状态原样交还外层保存；这里不发物理请求。
		return { model: target, thinkingLevel: clampThinkingLevel(target, route.thinkingLevel), state: route.state };
	}

	/** A catalog chat model that is not virtual. */
	// 查物理聊天模型。输入 provider/id，同步返回目录项或 undefined，无认证/网络操作。
	// 例如虚拟路由返回另一个虚拟 id 时此助手返回空，从而阻止虚拟链式路由。
	getPhysicalModel(providerId: string, modelId: string): Model<Api> | undefined {
		// 先按聊天目录规则查询，可能查到虚拟项。
		const model = this.models.getModel(providerId, modelId);
		// 存在且不是虚拟 api 才保留原模型对象，否则 undefined。
		return model && !isVirtualModel(model) ? model : undefined;
	}
}
