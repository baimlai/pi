// 本文件实现 Provider 工厂和 Models 集合：目录管理、凭证解析、请求装配及能力分流；不在模块导入时注册所有供应商。
import { lazyStream } from "./api/lazy.ts";
// 默认认证上下文工厂可读取环境/文件存在性，不是已解析的 API key。
import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
// 未注入凭证存储时用进程内实现，不自动加载用户 auth.json。
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
// 认证模块负责 OAuth 锁内轮换、请求认证解析及稳定 ModelsError 分类。
import {
	type AuthResolutionOverrides,
	ModelsError,
	refreshStoredOAuthCredential,
	resolveProviderAuth,
} from "./auth/resolve.ts";
// 认证相关 import type 仅供编译期使用，登录/存储实现由传入依赖提供。
import type {
	AuthCheck,
	AuthContext,
	AuthInteraction,
	AuthOperationOptions,
	AuthResult,
	AuthType,
	Credential,
	CredentialStore,
	LoginOptions,
	ProviderAuth,
} from "./auth/types.ts";
// 目录缓存默认也是内存实现；可注入文件/其他存储实现。
import { InMemoryModelsStore, type ModelsStore, type ModelsStoreEntry } from "./models-store.ts";
// telemetry 沿流转发路径观察请求，不另发一份模型调用。
import { observeModelRequest } from "./telemetry.ts";
// 统一类型覆盖聊天、图片、分类以及各自上下文/结果；type 导入在 JS 中擦除。
import type {
	AnyModel,
	Api,
	ApiStreamOptions,
	AssistantImages,
	AssistantMessage,
	AssistantMessageEventStream,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
	Context,
	DeferredCancelOptions,
	DeferredFetchOptions,
	DeferredHandle,
	ImageApi,
	ImageModel,
	ImagesContext,
	ImagesOptions,
	Model,
	ModelCostRates,
	ModelThinkingLevel,
	ModelType,
	ModelTypeMap,
	ProviderClassifier,
	ProviderHeaders,
	ProviderImages,
	ProviderRequestOptions,
	ProviderStreams,
	SimpleStreamOptions,
	TranscriptContext,
	Usage,
} from "./types.ts";
// 取消辅助把“停止等待”和“底层任务实际停止”分开，控制器合作程度仍看实现。
import { operationSignal, raceWithAbortSignal } from "./utils/abort.ts";
// 身份字段按层合并，OpenCode 会话头需要实际模型与可选会话 id。
import { type ClientIdentity, getOpenCodeSessionHeaders, mergeClientIdentity } from "./utils/identity.ts";
// 运行时能力检查用于操作边界，不由纯 TypeScript 类型自动完成。
import {
	assertChatModel,
	assertClassifierInputSupported,
	assertClassifierModel,
	assertImageModel,
	classifierErrorResult,
	getModelType,
	imageErrorResult,
	isModelType,
} from "./utils/model-operations.ts";
// 把旧式顶层提示词/工具规范进消息，供应商只接 TranscriptContext。
import { normalizeContext } from "./utils/transcript.ts";

// 类型和运行值转导出保持公开错误入口一致，本行不重新包装类。
export { ModelsError, type ModelsErrorCode } from "./auth/resolve.ts";
// 对外导出本库拥有的遥测 schema，并不在此创建网络收集器。
export { AI_TELEMETRY_SCHEMA } from "./telemetry.ts";
// 公开模型种类查询/收窄函数，混合目录需先分清 chat/image/classifier。
export { getModelType, isModelType } from "./utils/model-operations.ts";

// 供应商发布操作可同时指定持久目录变更与同步内存更新；这是数据协议，不会因创建对象就执行。
export interface ModelsPublication {
	/** Provider-selected persisted catalog. Omit to leave storage unchanged; null deletes it. */
	// undefined 不改存储，null 删除，普通条目替换该家目录，三者有不同意义。
	persist?: ModelsStoreEntry | null;
	/** Optional synchronous update of provider-private in-memory catalog state. */
	// 持久化所选动作完成且代次仍有效后才同步执行，返回 void；异步 update 不属于接口契约。
	update?: () => void;
}

// 动态目录刷新上下文由集合创建，供应商实现选择何时缓存/联网并通过 publish 提交。
export interface RefreshModelsContext {
	/** Effective configured credential. OAuth credentials are refreshed before network access. */
	// 有效存储凭证，网络阶段可已完成 OAuth 刷新；不在字段声明处校验令牌远端有效性。
	credential?: Credential;
	/** Immutable provider-scoped catalog snapshot captured before this refresh phase. */
	// 本刷新阶段开始前读到的目录副本，Readonly 是浅类型约束，不是运行时深冻结。
	stored?: Readonly<ModelsStoreEntry>;
	/**
	 * Generation-checked publication. Persistence policy remains provider-owned;
	 * the update runs synchronously only after the selected persistence mutation.
	 */
	// 异步发布返回 boolean，false 表示发布检查发现失效；取消等待或存储/update 失败还可能拒绝 Promise，已发生写入不自动回滚。
	publish(publication: ModelsPublication): Promise<boolean>;
	/** False during offline/cache-only initialization. */
	// false 表示只恢复缓存；这是合作接口规则，供应商回调需自行遵守。
	allowNetwork: boolean;
	/** Bypass provider freshness checks and fetch immediately when network access is allowed. */
	// force 仅在允许联网的阶段传入，供应商据此绕过自己的新鲜度判断。
	force?: boolean;
	/** Always present, including when the public refresh caller omits its optional signal. */
	// 公共调用没给信号时内部补一份，供应商始终收到信号。
	signal: AbortSignal;
	/**
	 * Base URL of the registered provider, including configuration overrides that wrappers apply
	 * outside the provider receiving this context.
	 */
	// 注册供应商的有效基础地址，可包含外层配置包装覆盖。
	baseUrl?: string;
}

// 一次刷新调用的选项，默认 allowNetwork=true 在实现里明确设置。
export interface ModelsRefreshOptions {
	// 是否允许网络阶段，省略不是离线。
	allowNetwork?: boolean;
	/** Restrict refresh to these provider IDs. Unknown and static providers are ignored. */
	// 限定 provider id 数组，未知/静态项忽略；空数组明确不刷任何项。
	providers?: readonly string[];
	/** Bypass provider freshness checks and fetch immediately when network access is allowed. */
	// 请求强制更新，不等于绕过认证或强制终止旧请求。
	force?: boolean;
	// 取消本次等待/后续阶段，已开始的 token 轮换另有持久化规则。
	signal?: AbortSignal;
}

// 刷新以结果返回总体取消状态与各家错误，不代表所有目录一定更新。
export interface ModelsRefreshResult {
	// 只反映调用者 signal 是否取消；某家被新刷新取代不必让整个结果 aborted=true。
	aborted: boolean;
	// Map 键是供应商 id，值为错误；ReadonlyMap 限制调用方类型操作，不冻结对象。
	errors: ReadonlyMap<string, Error>;
}

// Models 独有的请求装配钩子，供应商接收前会移除 transformHeaders 字段。
export interface ModelsRequestTransforms {
	/** Transform fully assembled model/auth/request headers before provider dispatch. */
	// 最终完整 headers 可同步/异步替换；不自动校验返回头安全性，异常按请求路径处理。
	transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>;
}

// 交叉类型为具体 API 参数增加 Models 层头变换，保留原 API 泛型关联。
export type ModelsApiStreamOptions<TApi extends Api> = ApiStreamOptions<TApi> & ModelsRequestTransforms;
// 统一聊天参数加头变换。
export type ModelsSimpleStreamOptions = SimpleStreamOptions & ModelsRequestTransforms;
// 延迟结果获取参数加头变换。
export type ModelsDeferredFetchOptions = DeferredFetchOptions & ModelsRequestTransforms;
// 延迟任务取消参数加头变换。
export type ModelsDeferredCancelOptions = DeferredCancelOptions & ModelsRequestTransforms;
// 图片生成参数加头变换。
export type ModelsImagesOptions = ImagesOptions & ModelsRequestTransforms;
// 分类请求参数加头变换。
export type ModelsClassifierOptions = ClassifierOptions & ModelsRequestTransforms;

// Record 强制三个已知种类键都存在，true 是集合占位；不是运行时注册所有模型。
const KNOWN_MODEL_TYPES: Record<ModelType, true> = { chat: true, image: true, classifier: true };

/** Models from stores and remote sources may have types that only newer versions know. */
/**
 * 判断模型种类是否是当前版本知道的 chat/image/classifier，返回 boolean；这是存储/远端目录输入兼容边界。
 * 未写 type 按 chat；例：新版本保存的未知 type 被旧版本过滤，而不是误送现有请求接口。
 */
function hasKnownModelType(model: AnyModel): boolean {
	// Object.hasOwn 避免原型同名属性误判，getModelType 兼容省略 chat 类型的旧目录。
	return Object.hasOwn(KNOWN_MODEL_TYPES, getModelType(model));
}

/** Drops stored models whose type this version does not know. */
/**
 * 浅复制目录条目并过滤未知种类，返回 ModelsStoreEntry；原模型对象仍共享。
 * 例：[chat,未来种类] 只留下 chat，etag/checkedAt 等条目字段保留；不做全字段 schema 校验。
 */
function withKnownModelTypes(entry: ModelsStoreEntry): ModelsStoreEntry {
	// 对象展开保留 ETag 等元数据，filter 只复制数组容器，保留已知模型对象引用。
	return { ...entry, models: entry.models.filter(hasKnownModelType) };
}

/** Any model a provider with chat APIs `TApi` can list. */
// 同一供应商可列聊天（受 TApi 约束）、图片和分类，后两者各用自己的协议联合。
type ProviderModel<TApi extends Api> = Model<TApi> | ImageModel<ImageApi> | ClassifierModel<ClassifierApi>;

/**
 * A provider is the concrete runtime unit. It owns id/name/base metadata,
 * auth methods, model listing, and the operations its models support
 * (streaming, image generation, classification).
 *
 * `TApi` lets concrete provider factories declare which chat APIs their models
 * use (e.g. `openaiProvider(): Provider<"openai-responses" | "openai-completions">`),
 * giving typed chat model lists to direct factory users. Other model types use
 * their operation-specific API unions. Inside a `Models` collection providers
 * are held as `Provider<Api>`.
 */
// Provider 是实际请求能力对象，泛型描述聊天协议集合；实现方法可以有状态，接口不会自动实现它们。
export interface Provider<TApi extends Api = Api> {
	// 供应商 id 作为集合唯一键；readonly 在编译期限制通过此接口重新赋值，不冻结运行时对象，也不让头部等对象字段深只读。
	readonly id: string;
	// 只读展示名，区别于 id。
	readonly name: string;

	// 可选基础地址，实际模型/认证/配置可进一步覆盖。
	readonly baseUrl?: string;
	// 供应商默认头，null 可表达抑制标记。
	readonly headers?: ProviderHeaders;

	/**
	 * Required: at least one of `apiKey`/`oauth`. Every provider has auth
	 * semantics — even providers with only ambient credentials (env vars, AWS
	 * profiles, ADC files) and keyless local servers provide `apiKey` auth
	 * whose `resolve()` reports whether the provider is configured.
	 * `Models.getAuth()` returns undefined when the provider is unconfigured.
	 */
	// 每家必须提供认证语义，即便是免 key 本地服务，也由 apiKey.resolve 表示配置可用。
	readonly auth: ProviderAuth;

	/**
	 * Current known chat models, sync. Static providers return their catalog;
	 * dynamic providers return the list as of the last `refreshModels()` (empty
	 * before the first). Must not throw; `Models` treats a throwing
	 * implementation as having no models.
	 */
	// 同步读已知聊天列表，契约要求不抛；Models 同步枚举入口会尽力吞错，但其他路径不全都吞。
	getModels(): readonly Model<TApi>[];

	/**
	 * Current known models of every type, sync, with the same contract as
	 * `getModels()`. Providers with only chat models may omit it; `Models` then
	 * uses `getModels()`. Model ids are unique within each type; one upstream
	 * model may have separate entries for different operations.
	 */
	// 可选全种类同步目录方法，省略则退回 getModels；同 id 可在不同种类各有条目。
	getAllModels?(): readonly ProviderModel<TApi>[];

	/**
	 * Dynamic providers only: restore `context.stored` and optionally fetch a newer list using
	 * the effective credential. Implementations retain their previous list on failure, publish
	 * persistence and synchronous state changes through `context.publish()`, and honor the
	 * shared abort signal for blocking work.
	 */
	// 动态供应商可实现此异步阶段；必须通过 context.publish 协调内存/持久状态，不仅返回数组。
	refreshModels?(context: RefreshModelsContext): Promise<void>;

	/**
	 * Optional provider policy for credential-specific model availability.
	 * `getModels()` remains the complete synchronous chat catalog; `Models.getAvailable()`
	 * applies this filter after confirming that provider auth is configured.
	 */
	// 按凭证/订阅过滤聊天可用目录，不改变原同步完整目录契约。
	filterModels?(models: readonly Model<TApi>[], credential: Credential | undefined): readonly Model<TApi>[];

	/**
	 * Optional credential-specific availability policy across every model type.
	 * Without it, `Models.getAllAvailable()` applies `filterModels` to chat models
	 * and keeps every other model.
	 */
	// 可选全种类资格过滤，优先于只过滤聊天的 filterModels。
	filterAllModels?(
		// 输入已知全目录，ProviderModel<TApi> 保留各类模型的类型区分。
		models: readonly ProviderModel<TApi>[],
		// 有效存储凭证可缺省，供应商可按环境配置过滤。
		credential: Credential | undefined,
		// 返回允许的全种类列表，未要求深复制。
	): readonly ProviderModel<TApi>[];

	/** Stream a normalized transcript. `Models` normalizes the caller's `Context` before dispatching here. */
	// 泛型 T 再约束到本 Provider 的聊天 API 子集，保证 options 与 model 对应。
	stream<T extends TApi>(
		// 具体协议模型。
		model: Model<T>,
		// 规则/工具均在消息中的规范上下文。
		context: TranscriptContext,
		// 该具体协议的可选参数。
		options?: ApiStreamOptions<T>,
		// 同步返回事件流，内部准备/网络异步执行。
	): AssistantMessageEventStream;

	// 统一参数聊天入口，不把类型化参数映射都暴露给调用方。
	streamSimple(
		// 本供应商聊天协议联合的模型。
		model: Model<TApi>,
		// 规范化消息历史。
		context: TranscriptContext,
		// 统一 reasoning/工具选择等选项。
		options?: SimpleStreamOptions,
		// 返回事件流而非完整正文。
	): AssistantMessageEventStream;
	// 可选后台结果获取流。
	fetchDeferred?(
		// 后台结果所用聊天模型。
		model: Model<TApi>,
		// 供应商持久句柄。
		handle: DeferredHandle,
		// 本轮长轮询等获取选项。
		options?: DeferredFetchOptions,
		// 获取也返回统一事件流。
	): AssistantMessageEventStream;
	// 可选后台取消操作，Promise 可拒绝；不是聊天错误流。
	cancelDeferred?(model: Model<TApi>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void>;

	/** Present when the provider supports dedicated image models. Never rejects. */
	// 图片能力可缺省，存在时按契约用结果中的错误表达失败。
	generateImages?(
		// 专用图片模型，不能误传仅能看图的聊天模型。
		model: ImageModel<ImageApi>,
		// 图片输入内容。
		context: ImagesContext,
		// 图片请求选项。
		options?: ImagesOptions,
		// 完整图片结果 Promise，不返回聊天流。
	): Promise<AssistantImages>;

	/** Present when the provider supports structured classifier models. Never rejects. */
	// 可选分类能力，契约为完整结果而非错误抛出；外层 Models 另有 catch 兜底。
	classify?(
		// 专用分类目录项。
		model: ClassifierModel<ClassifierApi>,
		// 状态与问题输入。
		context: ClassifierContext,
		// 分类选项。
		options?: ClassifierOptions,
		// 分类结果 Promise。
	): Promise<ClassifierResult>;
}

/**
 * Runtime collection of providers plus auth application and request
 * convenience. Providers own request behavior; `Models` resolves auth and
 * delegates each request to the provider that owns the model.
 *
 * Read accessors come in three flavors: the unqualified ones (`getModels`,
 * `getModel`, `getAvailable`) return chat models, the `*OfType` accessors
 * return one model type, and `getAllModels`/`getAllAvailable` return every type.
 */
// Models 公共集合能力契约：不带 OfType/All 的目录入口默认只处理聊天。
export interface Models {
	// 同步列所有注册 Provider 的对象引用。
	getProviders(): readonly Provider[];
	// 同步按 id 查实现，不存在 undefined。
	getProvider(id: string): Provider | undefined;

	/**
	 * Sync read of last-known chat models from one provider or all providers.
	 * Best-effort: a provider whose `getModels()` throws yields no models.
	 */
	// 同步读一处/全部已知聊天目录，不执行 refresh。
	getModels(provider?: string): readonly Model<Api>[];

	/**
	 * Sync runtime chat model lookup against last-known lists. Dynamic model lists
	 * are typed as `Model<Api>`; narrow with the `hasApi()` type guard.
	 */
	// 动态目录查得宽 API 联合，需 hasApi 再收窄才能用精确协议参数。
	getModel(provider: string, id: string): Model<Api> | undefined;

	/** Sync read of last-known models of one type from one provider or all providers. */
	// 按种类读目录，返回元素类型随 TType 变化。
	getModelsOfType<TType extends ModelType>(type: TType, provider?: string): readonly ModelTypeMap[TType][];

	/** Sync runtime lookup of a model of one type against last-known lists. */
	// 种类+供应商+id 精确定位，找不到保留 undefined。
	getModelOfType<TType extends ModelType>(type: TType, provider: string, id: string): ModelTypeMap[TType] | undefined;

	/** Sync read of last-known models of every type from one provider or all providers. */
	// 列全部模型种类，区别于默认聊天列表。
	getAllModels(provider?: string): readonly AnyModel[];

	/**
	 * Refresh selected configured dynamic providers concurrently (all when `providers` is omitted).
	 * Provider errors and cancellation are returned without rejecting; static, unknown, and
	 * unconfigured providers are skipped.
	 */
	// 异步刷新返回错误集合；正常供应商失败不简单等同抛出整个 Promise。
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;

	/** Check whether a provider has complete auth configuration without refreshing OAuth. */
	// 检查配置可用性，不刷新 OAuth；缺专用 check 的 API key 方法可能回退 resolve。
	checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined>;

	/** Return chat models whose providers have complete auth configuration. */
	// 异步查询聊天可用列表，不是本层预先缓存的认证快照。
	getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]>;

	/** Return models of one type whose providers have complete auth configuration. */
	// 按种类返回认证与资格通过的模型，先 await 再使用。
	getAvailableOfType<TType extends ModelType>(
		// 类别决定元素类型，如 image 对应 ImageModel。
		type: TType,
		// 可限定一家供应商。
		providerId?: string,
		// 可选取消信号。
		options?: AuthOperationOptions,
		// 异步得到只读类型数组，元素未因 readonly 自动冻结。
	): Promise<readonly ModelTypeMap[TType][]>;

	/** Return models of every type whose providers have complete auth configuration. */
	// 全种类可用列表，含图片/分类。
	getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]>;

	/**
	 * Resolve provider-scoped auth by provider id, or provider auth plus static
	 * model headers when passed a model. Includes a source label for status UI.
	 * Resolves `undefined` when the provider is unknown or unconfigured.
	 * Rejects with `ModelsError`: code "oauth" when a token refresh fails (the
	 * stored credential is preserved for retry; re-login fixes it), code "auth"
	 * when api-key resolution or the credential store fails. Request paths
	 * surface rejections as stream errors.
	 */
	// 字符串重载只解析供应商级认证，可能刷新 OAuth 或执行配置解析。
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	// 模型重载还合并模型静态 headers；重载签名不会生成两个 JS 实现。
	getAuth(model: AnyModel, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;

	/** Run a provider-owned login flow and persist its returned credential. */
	// 供应商持有登录流程，本集合等待它并保存凭证，可能交互/联网/写存储。
	login(providerId: string, type: AuthType, interaction: AuthInteraction, options?: LoginOptions): Promise<Credential>;

	/** Remove the stored credential for a provider. */
	// 注销删除凭证，不删除 Provider 目录注册。
	logout(providerId: string, options?: AuthOperationOptions): Promise<void>;

	// 专属参数聊天：模型 API 与参数泛型一致。
	stream<TApi extends Api>(
		// 保留 TApi 的模型。
		model: Model<TApi>,
		// 公共上下文可使用顶层 systemPrompt/tools 简写。
		context: Context,
		// 具体协议参数加 Models 头变换。
		options?: ModelsApiStreamOptions<TApi>,
		// 返回同步可用的异步事件流。
	): AssistantMessageEventStream;

	// 完整结果方便入口，内部仍执行 stream 而不是独立第二次网络请求。
	complete<TApi extends Api>(
		// 具体协议模型。
		model: Model<TApi>,
		// 同一模型请求上下文。
		context: Context,
		// 具体协议选项。
		options?: ModelsApiStreamOptions<TApi>,
		// 最终消息可能为 error/aborted，Promise 完成不等于远端成功。
	): Promise<AssistantMessage>;

	// 统一参数流式聊天，与专属参数入口区别在参数表达。
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
	// 统一流的完整结果 Promise。
	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage>;
	// 流式轮询/获取持久后台结果。
	streamDeferred(
		// 获取所用模型。
		model: Model<Api>,
		// 任务句柄。
		handle: DeferredHandle,
		// 长轮询/取消等请求参数。
		options?: ModelsDeferredFetchOptions,
		// 返回获取流，消息可仍是 pending/deferred。
	): AssistantMessageEventStream;
	// 获取最终一次流消息的方便入口，不保证后台任务已完成。
	fetchDeferred(
		// 获取模型。
		model: Model<Api>,
		// 供应商任务句柄。
		handle: DeferredHandle,
		// 本次获取选项。
		options?: ModelsDeferredFetchOptions,
		// 完整获取结果，仍需检查 stopReason。
	): Promise<AssistantMessage>;
	// 取消延迟任务返回完成/拒绝，不保证远端 best-effort 取消必定生效。
	cancelDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredCancelOptions): Promise<void>;

	/**
	 * Generate images through the owning provider with auth resolved like
	 * `stream()`. Never rejects: unknown providers, unconfigured auth, and
	 * providers without `generateImages` return an error `AssistantImages`.
	 */
	// 图片生成独立入口，正常失败转 AssistantImages 的错误字段。
	generateImages(
		// 专用图片模型。
		model: ImageModel<ImageApi>,
		// 图片输入上下文。
		context: ImagesContext,
		// 图片选项与 Models 头变换。
		options?: ModelsImagesOptions,
		// 返回完整图片结果。
	): Promise<AssistantImages>;

	/** Classify structured state through the owning provider. Never rejects. */
	// 分类独立入口，异常转分类失败数据。
	classify(
		// 专用分类模型。
		model: ClassifierModel<ClassifierApi>,
		// 状态和问题输入。
		context: ClassifierContext,
		// 分类选项。
		options?: ModelsClassifierOptions,
		// 返回完整分类结果。
	): Promise<ClassifierResult>;
}

// 可变集合在只读查询/请求能力之外增加供应商注册生命周期操作。
export interface MutableModels extends Models {
	/** Upsert/replace by provider.id. Provider ids are unique. */
	// 按同 id 替换实现，并使旧在途刷新代次失效。
	setProvider(provider: Provider): void;
	// 仅删除注册，不删除凭证/目录文件。
	deleteProvider(id: string): void;
	// 清整个注册表并取消已知刷新，不清注入存储。
	clearProviders(): void;
}

// 可选依赖注入，默认构造内存存储和默认认证上下文，集合起初没有供应商。
export interface CreateModelsOptions {
	// 凭证存储负责串行修改与持久化语义，可注入文件或内存。
	credentials?: CredentialStore;
	// 动态模型目录缓存存储。
	modelsStore?: ModelsStore;
	// 环境和文件存在性等认证能力，不直接等同真实秘密。
	authContext?: AuthContext;
	/** Default identity of every request; a request's `identity` overrides it field by field. */
	// 默认调用应用身份，请求 identity 按字段覆盖；不是模型供应商身份。
	identity?: ClientIdentity;
}

/**
 * 不区分大小写地合并两份请求头，override 同名优先，并保留 null 删除标记。
 * 返回新对象或 undefined，不改输入；例：base.Authorization 被 override.authorization 替换，最终键采用后者大小写；不在此发 HTTP 或过滤 null。
 */
function mergeHeaders(
	// 基础请求头可缺省。
	base: ProviderHeaders | undefined,
	// 覆盖请求头同名优先，可含 null 删除标记。
	override: ProviderHeaders | undefined,
	// 返回合并对象或 undefined，没有 HTTP 副作用。
): ProviderHeaders | undefined {
	// 两边都没给才保持 undefined，不造无用空对象。
	if (!base && !override) return undefined;
	// 先浅复制基础头，避免直接改调用者数据。
	const merged = { ...base };
	// override 省略时遍历空对象；每项解构名字与值。
	for (const [name, value] of Object.entries(override ?? {})) {
		// 用小写键作不区分大小写比较，但最终保留覆盖者的原键写法。
		const lowerName = name.toLowerCase();
		// 查已有所有键，防 Authorization/authorization 双份同时存在。
		for (const existingName of Object.keys(merged)) {
			// 同名先删旧键，避免不同大小写遗留。
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		// 写入覆盖值，null 也原样保留。
		merged[name] = value;
	}
	// 返回新头对象，不在此执行过滤/网络发送。
	return merged;
}

// 内部实现满足 MutableModels，createModels 只公开接口形状；private 是 TS 编译期可见性限制，不是运行时 # 字段隔离。
class ModelsImpl implements MutableModels {
	// 供应商注册表，键为唯一 id。
	private providers = new Map<string, Provider>();
	// 凭证存储依赖，所有请求通过它解析认证。
	private credentials: CredentialStore;
	// 持久目录存储依赖，和凭证存储分开。
	private modelsStore: ModelsStore;
	// 环境/文件能力上下文，供各家认证实现使用。
	private authContext: AuthContext;
	// 默认客户端身份，可缺省。
	private identity: ClientIdentity | undefined;
	// 每家递增刷新代次，防旧刷新覆盖新状态；不是 token 用量计数。
	private refreshGenerations = new Map<string, number>();
	// 每家当前刷新控制器，可因重注册/新刷新/删除被取消。
	private refreshControllers = new Map<string, AbortController>();
	// 每家发布串行链，避免持久化与内存更新顺序交错；失败尾部会被观察。
	private publicationChains = new Map<string, Promise<unknown>>();

	/**
	 * 构建模型/认证集合，默认使用内存凭证与目录存储以及默认认证上下文。
	 * 返回类实例；只保存依赖，不自动注册内置供应商、刷新目录或执行聊天。例：createModels() 后 getProviders() 仍为空，需 setProvider。
	 */
	constructor(options?: CreateModelsOptions) {
		// 没注入凭证存储就创建独立内存存储，不读 coding-agent 的文件。
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		// 目录缓存也缺省独立内存实现。
		this.modelsStore = options?.modelsStore ?? new InMemoryModelsStore();
		// 默认认证上下文提供环境/文件查询能力，实际供应商解析时再使用。
		this.authContext = options?.authContext ?? defaultAuthContext();
		// 保存可选默认身份引用，后续按请求合并。
		this.identity = options?.identity;
	}

	/**
	 * 按 provider.id 新增或替换实现，返回 void；先使旧刷新代次失效并取消旧刷新等待。
	 * 例：同 id 重注册后，旧目录请求即使晚返回，也不能凭旧代次提交新的内存状态；不在此请求新目录。
	 */
	setProvider(provider: Provider): void {
		// 更换 Provider 前先使其旧刷新失效，避免旧发布覆盖新实现。
		this.supersedeProviderRefresh(provider.id);
		// Map.set 按相同 id 替换旧对象，不隐式合并其目录。
		this.providers.set(provider.id, provider);
	}

	/**
	 * 删除供应商注册并使其旧刷新失效，返回 void。
	 * 只改注册表，不删除凭证或持久目录；例：deleteProvider("demo") 后 getProvider 查不到，但再次注册可恢复已有目录。
	 */
	deleteProvider(id: string): void {
		// 删除也要作废仍在途刷新。
		this.supersedeProviderRefresh(id);
		// 移除注册项，不动 credentials/modelsStore。
		this.providers.delete(id);
	}

	/**
	 * 取消/作废所有注册项与在途刷新，再清供应商表，返回 void。
	 * 例：有供应商已从表移除但仍有刷新控制器，也纳入处理；不清凭证、目录持久文件或重置历史代次映射。
	 */
	clearProviders(): void {
		// 注册表和控制器表的 id 并集，Set 去重。
		for (const id of new Set([...this.providers.keys(), ...this.refreshControllers.keys()])) {
			// 每个 id 都推进代次并发取消，不只处理仍注册的项。
			this.supersedeProviderRefresh(id);
		}
		// 释放全部注册实现引用，持久数据仍留在注入存储。
		this.providers.clear();
	}

	/**
	 * 返回当前供应商对象的新数组，无网络读取；数组元素仍为原实现引用。例：修改返回数组不改变注册表，修改某个实现自身状态仍是同一对象。
	 */
	getProviders(): readonly Provider[] {
		// 把 Map 的值迭代器转新数组，元素仍共享。
		return Array.from(this.providers.values());
	}

	/**
	 * 按 id 查当前注册实现，返回 Provider 或 undefined，无副作用。例：未知 demo 不会自动加载内置工厂。
	 */
	getProvider(id: string): Provider | undefined {
		// 精确按字符串 id 查，未找到 undefined。
		return this.providers.get(id);
	}

	/**
	 * 同步尽力读取一处或全部供应商的已知聊天目录，返回只读类型数组。
	 * 指定供应商直接返回其目录；全部则合并；供应商枚举抛错在此吞掉并按空目录处理。例：动态提供商尚未刷新时可能为空；不在这里刷新认证或联网。
	 */
	getModels(provider?: string): readonly Model<Api>[] {
		// 明确给出 provider（即便空字符串）就只查该键，不扫描全部。
		if (provider !== undefined) {
			// 读取当前已注册对象。
			const entry = this.providers.get(provider);
			// 未知供应商返回空数组，不自动创建工厂。
			if (!entry) return [];
			// 提供商枚举错误在该同步查询入口尽力吞掉。
			try {
				// 有实现就返回其现有目录，未强制复制数组。
				return entry.getModels();
				// 捕获供应商 getModels 抛错，不能据此认为远端真的没有模型。
			} catch {
				// 失败按空列表处理。
				return [];
			}
		}

		// 跨供应商聚合结果使用新数组。
		const models: Model<Api>[] = [];
		// 按 Map 注册顺序枚举各 Provider。
		for (const entry of this.providers.values()) {
			// 每家独立捕获，单家失败不阻断其他家。
			try {
				// 展开该家聊天模型，保留模型对象身份。
				models.push(...entry.getModels());
				// 异常时保留已收集结果并继续下一家。
			} catch {
				// Best-effort: ill-behaved providers yield no models.
			}
		}
		// 返回聚合列表，没有检查认证配置。
		return models;
	}

	/**
	 * 同步尽力读取全部种类目录；优先 getAllModels，省略时退 getModels。
	 * 指定供应商返回原目录引用，跨供应商合并新数组；枚举失败按该供应商没有模型处理。例：图片模型不会混入 getModels，但会在这里列出。
	 */
	getAllModels(provider?: string): readonly AnyModel[] {
		// 指定 provider 时只查一家。
		if (provider !== undefined) {
			// 读取注册实现。
			const entry = this.providers.get(provider);
			// 未知家返回空目录。
			if (!entry) return [];
			// 全种类目录查询同样采用尽力枚举策略。
			try {
				// 可选 getAllModels 未实现才退 getModels；空数组不触发回退。
				return entry.getAllModels?.() ?? entry.getModels();
				// 捕获同步目录提供方错误。
			} catch {
				// 该家暂以空列表呈现。
				return [];
			}
		}

		// 跨供应商全种类聚合数组。
		const models: AnyModel[] = [];
		// 依注册顺序遍历各家。
		for (const entry of this.providers.values()) {
			// 分别保护每次目录读取。
			try {
				// 用全种类接口优先，旧聊天供应商无需实现新接口。
				models.push(...(entry.getAllModels?.() ?? entry.getModels()));
				// 失败不清掉其他家已收集模型。
			} catch {
				// Best-effort: ill-behaved providers yield no models.
			}
		}
		// 返回全种类合并列表，无网络刷新。
		return models;
	}

	/**
	 * 从全部种类目录按 type 筛选，返回与类别泛型对应的数组。
	 * 类型谓词让 image 参数得到 ImageModel[]，未写 type 的旧模型通过 isModelType 视为 chat；本方法不主动刷新目录或请求模型。例：getModelsOfType("classifier","demo")。
	 */
	getModelsOfType<TType extends ModelType>(type: TType, provider?: string): readonly ModelTypeMap[TType][] {
		// 类型谓词将筛选结果收窄为 ModelTypeMap[TType][]，运行时比较由 isModelType 完成。
		return this.getAllModels(provider).filter((model): model is ModelTypeMap[TType] => isModelType(model, type));
	}

	/**
	 * 在一家的聊天目录按 id 找首个模型，返回引用或 undefined，无认证检查。例：同 id 的图片项不会由这个入口返回。
	 */
	getModel(provider: string, id: string): Model<Api> | undefined {
		// 只在该家聊天目录按 id 找第一项，找不到 undefined。
		return this.getModels(provider).find((model) => model.id === id);
	}

	/**
	 * 按种类、供应商、id 查首个模型，返回 ModelTypeMap[TType] 或 undefined。
	 * 例：image/demo/paint 与 chat/demo/paint 可并存，类别决定查哪一项。
	 */
	getModelOfType<TType extends ModelType>(type: TType, provider: string, id: string): ModelTypeMap[TType] | undefined {
		// 先按种类得到目录，再按 id 精确匹配。
		return this.getModelsOfType(type, provider).find((model) => model.id === id);
	}

	/**
	 * 增加供应商刷新代次并移除/取消旧控制器，返回新代次数字。
	 * 例：旧 g1 被 g2 替代后，后续检查会拒绝旧发布，但不会回滚已经开始/完成的存储操作；取消信号不是强制终止任意任务。
	 */
	private supersedeProviderRefresh(providerId: string): number {
		// 未有记录从 0 加一，旧代次永不复用本次新数字。
		const generation = (this.refreshGenerations.get(providerId) ?? 0) + 1;
		// 先更新代次，旧发布在后续检查会被判失效；已开始的存储操作仍由其实现处理。
		this.refreshGenerations.set(providerId, generation);
		// 查旧刷新控制器。
		const previous = this.refreshControllers.get(providerId);
		// 存在旧刷新才发取消。
		if (previous) {
			// 先移除旧控制器引用，防旧 finally 错清新状态。
			this.refreshControllers.delete(providerId);
			// 通知旧任务取消，是否停止其 I/O 仍看实现配合。
			previous.abort();
		}
		// 将新代次交新刷新/注册操作使用。
		return generation;
	}

	/**
	 * 开启新刷新：先作废旧代次，再存一个新控制器，返回两者。
	 * 例：同供应商两轮 refresh 不并用同一控制器，后来的刷新具有更新代次。
	 */
	private beginProviderRefresh(providerId: string): { generation: number; controller: AbortController } {
		// 统一作废旧任务，不另外复制代次算法。
		const generation = this.supersedeProviderRefresh(providerId);
		// 为本轮创建独立控制器。
		const controller = new AbortController();
		// 保存当前控制器供下一轮/注销查找。
		this.refreshControllers.set(providerId, controller);
		// 返回代次和信号所有者。
		return { generation, controller };
	}

	/**
	 * 按供应商串行发布目录持久化与内存更新，返回本次发布是否被接受；空发布也可成功。
	 * 等旧发布结束后检查信号/代次，按 persist 删除/写入/不写，再检查一次才同步 update；旧失败不堵后续。
	 * 存储、update 或取消等待产生的异常还可能拒绝 Promise，false 只表示发布检查发现失效。
	 * 例：旧请求写完前新代次到来，可能已完成存储写入但本轮返回 false 且不更新内存；不承诺跨存储与内存的原子回滚。
	 */
	private publishProviderModels(
		// 发布属于哪家 Provider。
		providerId: string,
		// 产生发布数据的那一轮代次。
		generation: number,
		// 当前刷新合并后的信号。
		signal: AbortSignal,
		// 可选存储动作和同步内存更新回调。
		publication: ModelsPublication,
		// 异步返回本次是否仍有效并接受发布。
	): Promise<boolean> {
		// 同家先等待旧发布尾部，没有时以已完成 Promise 为起点。
		const previous = this.publicationChains.get(providerId) ?? Promise.resolve();
		// 异步 IIFE 立即开始排队，返回该发布自己的 Promise。
		const queued = (async () => {
			// 观察旧失败但仍继续排队，不让一次失败堵死后面。
			await previous.catch(() => {});
			// 未轮到前已取消或代次旧，直接 false 不触碰存储/内存。
			if (signal.aborted || this.refreshGenerations.get(providerId) !== generation) return false;

			// null 明确删除持久目录。
			if (publication.persist === null) {
				// 删除操作传本次信号，真正取消语义由 ModelsStore 实现。
				await this.modelsStore.delete(providerId, { signal });
				// undefined 表示不写，普通条目才进入替换分支。
			} else if (publication.persist !== undefined) {
				// 写前深复制发布数据，避免调用者之后改变待存目录对象。
				await this.modelsStore.write(providerId, structuredClone(publication.persist), { signal });
			}

			// 存储等待可能跨过新刷新，更新内存前再次验证代次/取消。
			if (signal.aborted || this.refreshGenerations.get(providerId) !== generation) return false;
			// 同步更新回调在所选持久化成功后运行，不 await 任意异步返回。
			publication.update?.();
			// 接受了本次发布；没有 update/persist 的有效空发布也会 true。
			return true;
		})();
		// 队尾只用于串行和清理，捕获失败不改变 queued 给调用者的拒绝。
		const tail = queued.catch(() => {});
		// 保存同家最新发布尾 Promise。
		this.publicationChains.set(providerId, tail);
		// 尾部成功/已吞错后清引用，避免永久保留已结束链。
		void tail.then(() => {
			// 只删除仍是同一个 tail 的项，旧清理不能删新发布链。
			if (this.publicationChains.get(providerId) === tail) this.publicationChains.delete(providerId);
		});
		// 调用者可先因取消拒绝，但队列仍被观察；不是强制终止存储实现。
		return raceWithAbortSignal(queued, signal);
	}

	/**
	 * 运行动态供应商的一次缓存/网络阶段，返回 Promise<void>。
	 * 读取持久目录、复制并过滤未知种类，再把凭证、发布器、allowNetwork/force/信号/baseUrl 交 refreshModels。
	 * 例：离线阶段 force 不传入；回调自己的缓存策略由供应商实现，本方法不直接抓取 HTTP。
	 */
	private async runProviderRefreshPhase(
		// 交叉类型 Required<Pick<...>> 表示已确认 refreshModels 必有，可直接调用。
		provider: Provider & Required<Pick<Provider, "refreshModels">>,
		// 本阶段有效凭证，离线恢复阶段可能为存储原值。
		credential: Credential | undefined,
		// 是否允许网络，供应商须遵守该协作规则。
		allowNetwork: boolean,
		// 可选强制刷新，仅网络阶段有意义。
		force: boolean | undefined,
		// 本轮发布代次。
		generation: number,
		// 本轮组合取消信号。
		signal: AbortSignal,
		// 只关心阶段完成，无额外返回目录值。
	): Promise<void> {
		// 通过存储读取该家之前目录；失败向 refresh 的单家错误收集传播。
		const stored = await this.modelsStore.read(provider.id, { signal });
		// 把阶段上下文交动态 Provider，后续缓存/HTTP策略由它实现。
		await provider.refreshModels({
			// 传阶段凭证。
			credential,
			// 目录副本过滤未知种类，Readonly 不执行 Object.freeze；没有缓存就 undefined。
			stored: stored ? withKnownModelTypes(structuredClone(stored)) : undefined,
			// 闭包把发布绑定到正确 provider/代次/信号，不能借此发布其他家。
			publish: (publication) => this.publishProviderModels(provider.id, generation, signal, publication),
			// 告知是否允许网络。
			allowNetwork,
			// 离线时强制丢掉 force，避免把它误当联网许可。
			force: allowNetwork ? force : undefined,
			// 每家 callback 都收到存在的 AbortSignal。
			signal,
			// 有效基础端点，包括供应商外层包装后的覆盖。
			baseUrl: provider.baseUrl,
		});
	}

	/**
	 * 并发刷新选中的动态供应商，先恢复缓存，再按允许联网与认证状态执行网络阶段。
	 * 返回 aborted 与按供应商分组的错误，普通供应商失败被收集；静态/未知项忽略。每家用独立代次及合并信号，旧刷新可被替代。
	 * 例：A 刷新失败而 B 成功，结果含 A 错误并保留 B；取消会结束调用者等待，已开始的 OAuth token 轮换可继续完成保存。
	 * 未传 allowNetwork 默认 true；离线初始化必须显式 false。供应商回调仍需合作遵守该标志，本层不强制阻断所有网络。
	 */
	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		// 未传时允许网络阶段；上层离线必须显式 false。
		const allowNetwork = options.allowNetwork ?? true;
		// 公共信号省略则补未取消信号，不强加默认截止时间。
		const callerSignal = operationSignal(options.signal);
		// 收集每家遇到的真实异常，取消不计入普通错误列表。
		const errors = new Map<string, Error>();
		// 调用前已取消直接返回结果，不启动目录/认证读取。
		if (callerSignal.aborted) return { aborted: true, errors };
		// 限制 id 列表用 Set；空列表为有效空集合，不是“不限制”。
		const selected = options.providers ? new Set(options.providers) : undefined;
		// 从当前供应商表选择可动态刷新的项。
		const refreshable = Array.from(this.providers.values()).filter(
			// 类型谓词给后续调用 refreshModels 提供必有方法的类型依据。
			(provider): provider is Provider & Required<Pick<Provider, "refreshModels">> =>
				// 必须声明方法，且没有范围限制或 id 在范围内；静态项忽略。
				provider.refreshModels !== undefined && (!selected || selected.has(provider.id)),
		);

		// Promise.all 并发处理各家，每家内部按缓存→网络阶段顺序。
		const refresh = Promise.all(
			// map 回调每家建立独立操作。
			refreshable.map(async (provider) => {
				// 新代次使同一家旧刷新失效。
				const { generation, controller } = this.beginProviderRefresh(provider.id);
				// 任一调用者取消或被后续同家刷新替代，都使本轮 signal 取消。
				const signal = AbortSignal.any([callerSignal, controller.signal]);
				// 内部实际工作 Promise 与外层取消等待分开。
				const operation = (async () => {
					// 暂存读到的凭证，缺省可 undefined。
					let storedCredential: Credential | undefined;
					// 暂存凭证读取错误，仍先让缓存目录恢复。
					let credentialError: unknown;
					// 单独捕获凭证读取失败，避免缓存恢复被提前跳过。
					try {
						// 传合并信号读取存储凭证。
						storedCredential = await this.readCredential(provider.id, signal);
						// 失败先记录，不立刻跳出全部阶段。
					} catch (error) {
						// 保留原抛出值，可能不是 Error。
						credentialError = error;
					}

					// Restore cached provider state before auth resolution or network access.
					// 在本方法后面的认证解析与目录网络阶段之前，先以不允许网络的参数恢复缓存。
					await this.runProviderRefreshPhase(provider, storedCredential, false, undefined, generation, signal);
					// 缓存恢复完成后再报告之前读取凭证的错误。
					if (credentialError !== undefined) throw credentialError;
					// 明确离线或已取消，停止网络阶段。
					if (!allowNetwork || signal.aborted) return;

					// 为联网阶段解析有效凭证，可能刷新已过期 OAuth。
					const credential = await this.resolveRefreshCredential(provider, storedCredential, signal);
					// 没有可用认证语义则不发网络目录抓取。
					if (!credential) return;
					// 这次才允许网络，并透传本次 force。
					await this.runProviderRefreshPhase(provider, credential, true, options.force, generation, signal);
				})();

				// 外层等待实际工作，但允许 signal 提前结束本轮等待。
				try {
					// 内部 Promise 被观察，即使它因 OAuth 轮换继续也不会漏未处理拒绝。
					await raceWithAbortSignal(operation, signal);
					// 异常转按家结果，取消不当普通失败。
				} catch (error) {
					// 只有非取消异常加入错误 Map。
					if (!signal.aborted) {
						// 记录供应商 id 对应错误。
						errors.set(
							// 按当前家作为键。
							provider.id,
							// 已有 Error 原样保留，不丢栈/ModelsError code。
							error instanceof Error
								? // Error 分支原样采用。
									error
								: // 非 Error 包装成 model_source，cause 保留原值。
									new ModelsError("model_source", `Model refresh failed for ${provider.id}`, { cause: error }),
						);
					}
					// 无论该家完成、错误还是取消都清本轮控制器。
				} finally {
					// 身份相同才可删，旧 finally 不删下一轮控制器。
					if (this.refreshControllers.get(provider.id) === controller) {
						// 移除本轮控制器登记，不回退代次。
						this.refreshControllers.delete(provider.id);
					}
				}
			}),
		);

		// 外层还响应整个 refresh 调用者取消。
		try {
			// 并发各家 Promise 正常收集结束，或调用者先停止等待。
			await raceWithAbortSignal(refresh, callerSignal);
			// 一般错误只有非调用者取消才重新抛出；正常单家错误已在内部收集。
		} catch (error) {
			// 沿用异常不伪装 aborted=true；接口正常失败流程是结果而非一概吞所有未知异常。
			if (!callerSignal.aborted) throw error;
		}

		// aborted 只看 callerSignal，错误 Map 再复制，避免后续迟到工作改已返回容器。
		return { aborted: callerSignal.aborted, errors: new Map(errors) };
	}

	/**
	 * 为目录网络刷新取得有效凭证，返回 Credential 或 undefined；可能刷新/保存 OAuth。
	 * OAuth 只在已过期时刷新（不同于普通请求的提前五分钟策略），未过期直接用；API key 则调用 resolve 并包装结果。
	 * 例：过期 OAuth 在存储锁内二次检查，开始轮换后不因本轮刷新取消而丢弃新 token；后续目录发布仍受代次限制。
	 */
	private async resolveRefreshCredential(
		// 要刷目录的供应商实现。
		provider: Provider,
		// 前面读到的原始存储凭证。
		stored: Credential | undefined,
		// 本次刷新取消信号。
		signal: AbortSignal,
		// 返回目录抓取可用凭证，未配置则 undefined。
	): Promise<Credential | undefined> {
		// 存储 OAuth 优先，不在失败时静默回退环境 key。
		if (stored?.type === "oauth") {
			// 查该家是否支持 OAuth 认证语义。
			const oauth = provider.auth.oauth;
			// 没有匹配 OAuth 方法不能按 API key 硬套。
			if (!oauth) return undefined;
			// 目录刷新只检查是否已到 expires，不使用普通请求的提前有效期阈值。
			if (Date.now() < stored.expires) return stored;
			// 已取消就不启动新的 token 轮换。
			if (signal.aborted) return undefined;
			// A refresh that has started survives cancellation or a superseding model refresh, so a
			// rotated refresh token is always persisted. A newer refresh then sees the fresh credential.
			// 存储锁内二次确认是否需刷新；开始后以独立超时完成轮换/持久化。
			return refreshStoredOAuthCredential(
				// 注入凭证存储。
				this.credentials,
				// 该供应商 id。
				provider.id,
				// 供应商 OAuth 刷新实现。
				oauth,
				// 锁内最新凭证仍已过期才真的轮换，避免并发重复刷新。
				(current) => Date.now() >= current.expires,
				// 该信号只负责开始轮换前的锁等待/检查，详见下层函数契约。
				signal,
			);
		}

		// 非 OAuth 走 API key/环境凭证解析能力。
		const apiKey = provider.auth.apiKey;
		// 供应商没有 apiKey 方法即无法解析该路径。
		if (!apiKey) return undefined;
		// 仅 api_key 类型作为匹配存储凭证传入，其余 undefined。
		const credential = stored?.type === "api_key" ? stored : undefined;
		// 具体解析可执行供应商自有工作，收到相同取消信号。
		const result = await apiKey.resolve({ ctx: this.authContext, credential, signal });
		// 无认证结果不进入网络目录阶段。
		if (!result) return undefined;
		// 统一包装 key/env；结果即便没有 key 也可用 env/免 key 的认证语义表达配置。
		return { type: "api_key", key: result.auth.apiKey, env: result.env };
	}

	/**
	 * 读取存储凭证，存储异常包装成 code=auth 的 ModelsError；返回凭证或 undefined。
	 * 例：文件读失败能带 cause 追溯；不在这里刷新 OAuth 或自动改用环境凭证。
	 */
	private async readCredential(providerId: string, signal: AbortSignal): Promise<Credential | undefined> {
		// 读错误在认证边界包装，以便外层按 auth 类识别。
		try {
			// 完整保留存储凭证，不在这里展开供应商专用字段。
			return await this.credentials.read(providerId, { signal });
			// catch 值类型不保证 Error。
		} catch (error) {
			// 包装 auth code 和供应商 id，cause 留原错误，不泄露凭证正文。
			throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
		}
	}

	/**
	 * 判断供应商认证配置是否可用，返回类型/来源或 undefined，不调用聊天。
	 * 存有 OAuth 且支持该方法就报告 OAuth，不在此刷新/检查过期；API key 优先专用 check，没有则真正 resolve。
	 * 例：没有 check 的自定义解析器可能执行自己的 I/O，不能把所有 availability 查询都保证为纯快照或绝对无副作用。
	 */
	private async checkProviderAuth(
		// 当前注册的认证实现集合。
		provider: Provider,
		// 可能缺省的存储凭证。
		credential: Credential | undefined,
		// 实际检查的取消信号。
		signal: AbortSignal,
		// 返回检查元数据，不返回请求秘密。
	): Promise<AuthCheck | undefined> {
		// 有 OAuth 存储项，检查只看供应商能否处理该种类。
		if (credential?.type === "oauth") {
			// 不刷新/验证 expires 或请求远端；有匹配方法即报告 OAuth。
			return provider.auth.oauth ? { source: "OAuth", type: "oauth" } : undefined;
		}
		// 普通路径取得 API key 能力。
		const apiKey = provider.auth.apiKey;
		// 不存在则未配置可用的对应认证路径。
		if (!apiKey) return undefined;
		// 有专用 check 时优先，通常可避免 request-time 的命令/I/O。
		if (apiKey.check) {
			// 专用 check 抛错包装 auth 错误。
			try {
				// 等待供应商配置检查。
				return await apiKey.check({
					// 供应商自有环境/文件查询能力。
					ctx: this.authContext,
					// 只给匹配 api_key 凭证，不误交 OAuth 对象。
					credential: credential?.type === "api_key" ? credential : undefined,
					// 继续传信号，是否及时中止由实现合作。
					signal,
				});
				// 检查异常可拒绝 availability 查询，不等同无模型。
			} catch (error) {
				// 加稳定 auth 类错误并保留 cause。
				throw new ModelsError("auth", `API key auth check failed for provider ${provider.id}`, { cause: error });
			}
		}

		// 没 check 则完整 resolve，可能有 request-time 副作用；不能称绝对只读快照。
		const resolution = await resolveProviderAuth(provider, this.credentials, this.authContext, { signal });
		// 结果映成不含秘密的类型/来源，缺结果 undefined。
		return resolution ? { source: resolution.source, type: "api_key" } : undefined;
	}

	/**
	 * 按 id 异步查认证配置并响应取消；未知供应商返回 undefined，存储/检查失败拒绝 Promise。
	 * 例：OAuth 有存储项即可得到 oauth 类型，认证 token 的可用时长仍须 getAuth 解析；本层没有独立认证快照缓存。
	 */
	checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		// 补存在的 signal，便于统一内部签名。
		const signal = operationSignal(options?.signal);
		// IIFE 马上开始检查，不等 Promise 被 await 才启动。
		const check = (async () => {
			// 调用前取消不读取存储。
			signal.throwIfAborted();
			// 查询现有注册表，不加载工厂。
			const provider = this.providers.get(providerId);
			// 未知家返回未配置，不自动创建它。
			if (!provider) return undefined;
			// 先读凭证，再交上述分支检查，非 OAuth 不隐式保证无网络。
			return this.checkProviderAuth(provider, await this.readCredential(providerId, signal), signal);
		})();
		// 调用者可取消等待，原 Promise 仍被观察。
		return raceWithAbortSignal(check, signal);
	}

	/**
	 * 为指定一家或全部已注册供应商并发读凭证、做认证检查，再过滤掉未配置项。
	 * 返回 provider/credential/auth 记录数组；任何一家检查失败可使整体拒绝，尚在运行的其他检查不被此 Promise.all 自动取消。
	 * 例：后续 getAvailable 在这些记录上执行各供应商的用户资格过滤。
	 */
	private async getAuthenticatedProviders(providerId: string | undefined, signal: AbortSignal) {
		// 检查开始即响应取消。
		signal.throwIfAborted();
		// 指定非空 id 查一家；本表达式以真值判断，空字符串会走全部供应商分支。
		const providers = providerId
			? // 查单家并过滤 undefined，避免后面读取不存在对象。
				[this.providers.get(providerId)].filter((entry) => entry !== undefined)
			: // 未指定（或空字符串）使用当前全部注册实现。
				this.getProviders();
		// 并发检查各家，单个拒绝会使 Promise.all 拒绝。
		const checks = await Promise.all(
			// 每家先读凭证，再查配置可用性。
			providers.map(async (provider) => {
				// 读取这家有效存储值。
				const credential = await this.readCredential(provider.id, signal);
				// 把实现、凭证和检查结果捆成记录供后续资格过滤。
				return { provider, credential, auth: await this.checkProviderAuth(provider, credential, signal) };
			}),
		);
		// 仅保留 auth 不为 undefined，空 source 标签并不导致过滤。
		return checks.filter((entry) => entry.auth !== undefined);
	}

	/**
	 * 异步返回有认证配置且通过供应商策略的聊天模型，返回可取消的 Promise。
	 * 先取得认证记录，再逐家 getModels/filterModels；此路径不采用同步 getModels 的吞枚举错误逻辑，枚举/过滤异常可传播。
	 * 例：某订阅只允许目录一部分模型，可由 filterModels 排除；不保证每个模型远端实际请求一定成功。
	 */
	getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		// 统一可取消信号。
		const signal = operationSignal(options?.signal);
		// 立即启动异步查询过程。
		const available = (async () => {
			// 先取得认证通过的供应商记录。
			const providers = await this.getAuthenticatedProviders(providerId, signal);
			// 每家可贡献零/一/多模型，flatMap 合成一列表。
			return providers.flatMap(({ provider, credential }) => {
				// 直接调用 Provider.getModels，此处没有同步查询入口的 try/catch。
				const models = provider.getModels();
				// 有资格过滤器则用其结果，否则全部聊天目录；空数组不回退。
				return provider.filterModels?.(models, credential) ?? models;
			});
		})();
		// 取消只终止调用者等待，不自动取消其他供应商非合作代码。
		return raceWithAbortSignal(available, signal);
	}

	/**
	 * 先获取全部可用种类，再按泛型 type 收窄并返回新数组，无额外网络模型请求。
	 * 例：getAvailableOfType("image") 得专用图片模型，仍会经过凭证/资格检查，不只是读已维护快照。
	 */
	async getAvailableOfType<TType extends ModelType>(
		// 要取的种类决定返回数组类型。
		type: TType,
		// 可限定供应商。
		providerId?: string,
		// 取消等认证操作选项。
		options?: AuthOperationOptions,
		// Promise 结果为类别对应的只读类型数组。
	): Promise<readonly ModelTypeMap[TType][]> {
		// 先全种类资格筛选，再用类型谓词按类别筛，不复制模型对象。
		return (await this.getAllAvailable(providerId, options)).filter((model): model is ModelTypeMap[TType] =>
			// 实际分类比较包括省略 type 视为 chat 的规则。
			isModelType(model, type),
		);
	}

	/**
	 * 返回全部种类的可用模型，优先 filterAllModels，否则仅对聊天应用 filterModels，其他种类保留。
	 * 并发认证后按目录过滤；返回可取消等待的 Promise，供应商枚举/过滤错误可拒绝。例：chat 与 image 同 id 时，仅聊天 id 集合用于聊天资格，不误删图片项。
	 */
	getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		// 为全种类检查补信号。
		const signal = operationSignal(options?.signal);
		// 启动异步操作，最后用外层 race 响应取消。
		const available = (async () => {
			// 检查凭证/配置后才做模型资格过滤。
			const providers = await this.getAuthenticatedProviders(providerId, signal);
			// 按每家聚合目录。
			return providers.flatMap(({ provider, credential }) => {
				// 优先全种类目录，没提供则用聊天目录。
				const models = provider.getAllModels?.() ?? provider.getModels();
				// 有全种类过滤器就完全以它为准，不叠加 filterModels。
				if (provider.filterAllModels) return provider.filterAllModels(models, credential);
				// 没有任何资格过滤就保留全部种类目录。
				if (!provider.filterModels) return models;
				// 只有聊天过滤器时建立允许聊天 id 集合。
				const availableChatIds = new Set(
					// 聊天目录经过资格过滤后提 id，图片/分类不在这集合里判断。
					provider
						.filterModels(provider.getModels(), credential)
						.map((model) => model.id),
				);
				// 非 chat 总保留，chat 必须命中允许集合；同 id 的图片不会被误排除。
				return models.filter((model) => !isModelType(model, "chat") || availableChatIds.has(model.id));
			});
		})();
		// 本次等待可取消，异常仍可向调用方传播。
		return raceWithAbortSignal(available, signal);
	}

	// 供应商 id 的认证重载，不带具体模型静态头。
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	// 模型的认证重载，包含模型 headers 合并。
	getAuth(model: AnyModel, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	/**
	 * 解析供应商认证；传模型时额外合并该模型静态 headers，传字符串只做供应商级解析。
	 * 未知或未配置返回 undefined；普通解析失败以 ModelsError 拒绝，OAuth 可能刷新并保存。例：模型专有头覆盖同名认证头，null 删除标记仍保留给适配器。
	 * 重载只约束 TypeScript 调用形状，不在运行时自动装载或校验整份模型。
	 */
	async getAuth(
		// 联合参数在实现里按 typeof 分流，不生成两个实现。
		providerOrModel: string | AnyModel,
		// 可选请求显式 key/env/最小 OAuth 有效期/信号覆盖。
		overrides?: AuthResolutionOverrides,
		// 返回可能缺省的解析结果。
	): Promise<AuthResult | undefined> {
		// 统一信号给认证器。
		const signal = operationSignal(overrides?.signal);
		// 字符串直接当供应商 id，对象取 provider 字段。
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		// 先查注册实现，不为未知 id 读取存储。
		const provider = this.providers.get(providerId);
		// 找不到直接 undefined；此分支不主动 throwIfAborted。
		if (!provider) return undefined;
		// 完整认证解析处理存储优先、显式覆盖与 OAuth 刷新，信号传入。
		const result = await resolveProviderAuth(provider, this.credentials, this.authContext, { ...overrides, signal });
		// 无结果/字符串重载/无模型头时原样返回，不无故复制。
		if (!result || typeof providerOrModel === "string" || !providerOrModel.headers) return result;
		// 模型静态头需要新对象合并，不修改原 auth 结果。
		return {
			// 保留 source/env 等认证字段。
			...result,
			// 只覆盖 auth 子对象里的 headers。
			auth: {
				// 保留 key/baseUrl 等已解析值。
				...result.auth,
				// 模型头后合入，同名不区分大小写优先，null 删除标记不在此过滤。
				headers: mergeHeaders(result.auth.headers, providerOrModel.headers),
			},
		};
	}

	/**
	 * 执行指定认证类型的供应商登录交互并将凭证交存储 modify，返回登录所得 Credential。
	 * 未知/无登录方法抛 ModelsError；支持取消登录/锁等待，记录 mutation 是否已开始，开始后等其结果；实际写入取消语义由 store 实现。
	 * 例：OAuth 对话完成不等于凭证一定落盘，必须等 modify 成功；存储失败包装 auth 错，取消优先保留信号原因。
	 */
	async login(
		// 目标供应商 id。
		providerId: string,
		// 选择 api_key 或 oauth 登录方法。
		type: AuthType,
		// 宿主交互能力含 prompt/notify 与可选取消信号。
		interaction: AuthInteraction,
		// 可选设备/应用身份等登录参数。
		options?: LoginOptions,
		// 返回供应商新生成的凭证，存储持久化失败仍拒绝。
	): Promise<Credential> {
		// 无信号补一份，始终能检查取消。
		const signal = operationSignal(interaction.signal);
		// 已取消不开始登录交互。
		signal.throwIfAborted();
		// 查当前实现。
		const provider = this.providers.get(providerId);
		// 未知供应商抛 provider 分类错误。
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${providerId}`);
		// 按认证类型选择对应方法，不自己实现浏览器 OAuth。
		const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
		// 没有登录能力，例如只支持环境认证，不能强行调用。
		if (!method?.login) {
			// 错误指出不支持所选登录形式。
			throw new ModelsError("auth", `${provider.name} does not support ${type} login`);
		}
		// 开始登录流程，interaction 浅复制后统一补 signal。
		const loginOperation: Promise<Credential> = method.login({ ...interaction, signal }, options);
		// 调用者取消时可先结束等待，登录实现仍需遵守信号。
		const credential = await raceWithAbortSignal(loginOperation, signal);
		// 记录存储修改回调是否已经开始，不把 Promise 创建等同已拿到存储锁。
		let mutationStarted = false;
		// 完成函数用于通知“轮到修改回调了”。
		let markMutationStarted: (() => void) | undefined;
		// 创建开始通知 Promise，而非等待整个持久化结束。
		const started = new Promise<void>((resolve) => {
			// 保存 resolve 给修改回调调用。
			markMutationStarted = resolve;
		});
		// 登录成功后通过 store 的串行修改入口保存。
		const mutation = this.credentials.modify(
			// 当前供应商作为存储键。
			providerId,
			// 不采用旧凭证，登录所得新值替换它。
			async () => {
				// 轮到回调执行时才标 mutationStarted=true。
				mutationStarted = true;
				// 通知外部等待者修改阶段已开始。
				markMutationStarted?.();
				// 把登录结果作为新凭证交存储，不在本层再刷新一次。
				return credential;
			},
			// 信号仍传给存储；不同 store 对回调后取消的语义可不同，不保证写一定会完成。
			{ signal },
		);
		// 无论外层是否取消，mutation 拒绝都被观察，避免未处理拒绝。
		void mutation.catch(() => {});
		// 明确协调“尚未开始”与“已经进入修改回调”两阶段取消。
		try {
			// 这层 Promise 等开始或修改完成，同时监听调用者取消。
			await new Promise<void>((resolve, reject) => {
				// 取消监听仅在修改尚未开始时提前拒绝。
				const onAbort = () => {
					// 开始后不由这个监听直接拒绝，但下面 await mutation 仍可能收到 store 的取消/失败。
					if (!mutationStarted) reject(signal.reason);
				};
				// 一次性取消监听，完成竞争路径也会移除。
				signal.addEventListener("abort", onAbort, { once: true });
				// 回调启动或修改完成任一先到，就结束本层开始等待。
				void Promise.race([started, mutation]).then(
					// 正常竞争结果不需要拿其值，只需知道阶段已过。
					() => {
						// 移除监听引用，避免结束后继续响应旧取消。
						signal.removeEventListener("abort", onAbort);
						// 开始等待 Promise 完成，不表示持久化已结束。
						resolve();
					},
					// 若 store 在回调开始前就失败，竞争也以拒绝结束。
					(error: unknown) => {
						// 失败同样移除取消监听。
						signal.removeEventListener("abort", onAbort);
						// 传播原 store 错误给外层包装。
						reject(error);
					},
				);
				// 覆盖安装监听前后的取消时机；不依赖将来一定再发事件。
				if (signal.aborted) onAbort();
			});
			// 等 store.modify 返回的 Promise 结算后才返回 credential；该 Promise 仍可因 store 自己的取消逻辑拒绝，不保证底层工作已停止。
			await mutation;
			// 处理存储错误或取消，不吞成登录成功。
		} catch (error) {
			// 若信号取消，优先抛其原始原因。
			signal.throwIfAborted();
			// 非取消错误包装为 auth 类，并保留 cause。
			throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
		}
		// 完整保存路径成功后返回登录取得的凭证，而非 modify 可能返回的另一引用。
		return credential;
	}

	/**
	 * 删除供应商已存凭证，返回 Promise<void>；取消先处理，其他存储错误包装 auth 错。
	 * 例：logout 不删除供应商注册或目录；是否清运行时临时覆盖取决于传入 CredentialStore 实现。
	 */
	async logout(providerId: string, options?: AuthOperationOptions): Promise<void> {
		// 补可用 signal。
		const signal = operationSignal(options?.signal);
		// 取消前置检查，不开始删除。
		signal.throwIfAborted();
		// 删除错误要包装，但取消原因优先。
		try {
			// 交 store 串行删除；本类不直接碰文件。
			await this.credentials.delete(providerId, { signal });
			// catch 任意存储抛出值。
		} catch (error) {
			// 已经取消时抛取消原因为主。
			signal.throwIfAborted();
			// 其他错误保留 cause，标 auth 类。
			throw new ModelsError("auth", `Credential store delete failed for ${providerId}`, { cause: error });
		}
	}

	/**
	 * 按模型 provider 查请求实现，没有就抛 provider 类 ModelsError；返回原 Provider 引用。
	 * 例：目录对象本身存在也不能跳过注册检查；不在此认证或执行模型。
	 */
	private requireProvider(model: AnyModel): Provider {
		// 目录模型声明的 provider 是注册表键。
		const provider = this.providers.get(model.provider);
		// 未知实现不能仅凭模型对象就发请求。
		if (!provider) {
			// 抛出可分类错误，而非凭空构建默认 Provider。
			throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		}
		// 返回已注册原对象。
		return provider;
	}

	/**
	 * 聊天请求边界先确认模型种类，再查注册供应商；返回 Provider 或抛错。
	 * 例：把 ImageModel 误传聊天入口不会被当普通文字模型请求；该检查不验证全字段 schema。
	 */
	private requireChatProvider(model: Model<Api>): Provider {
		// 请求种类边界防误传 image/classifier。
		assertChatModel(model);
		// 通过种类检查后再查供应商，不解析凭证。
		return this.requireProvider(model);
	}

	/**
	 * 为聊天/图片/分类请求合并认证、端点、请求头、环境和应用身份，返回请求模型及选项。
	 * 显式请求字段优先，transformHeaders 最后运行且不传给供应商；可异步刷新认证，尚未执行实际模型操作。
	 * 例：auth 给出专属 baseUrl 时浅复制模型；Authorization 不区分大小写覆盖，并保留 null；env/identity 按字段合并。
	 */
	private async applyAuth<
		// TModel 保留聊天/图片/分类的具体模型类型。
		TModel extends AnyModel,
		// TOptions 必须同时具备该模型公共选项与 Models 头变换契约。
		TOptions extends ProviderRequestOptions<TModel> & ModelsRequestTransforms,
		// 泛型参数声明结束，以下才是函数值参数列表。
	>(
		// 输入模型类型贯穿返回 requestModel。
		model: TModel,
		// 选项可以 undefined，装配时补必要字段。
		options: TOptions | undefined,
		// 异步返回结构从这里开始，不是立即返回对象。
	): Promise<{
		// 模型可浅复制覆盖端点，但保持 TModel 能力类型。
		requestModel: TModel;
		// Omit 移除 Models 专用 transformHeaders，剩余形状加公共选项后交 Provider。
		requestOptions: Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>;
		// 返回对象类型声明结束，下面进入真正的认证装配函数体。
	}> {
		// 先确认 Provider 存在，避免未知家继续认证。
		this.requireProvider(model);
		// 获取按模型合并后的认证，可能刷新 OAuth。
		const resolution = await this.getAuth(model, {
			// 本次显式 key 交认证器，使它选择对应 apiKey 解析路径。
			apiKey: options?.apiKey,
			// 请求 env 可覆盖认证环境值。
			env: options?.env,
			// 取消信号继续贯穿认证。
			signal: options?.signal,
		});
		// 未配置认证即无法继续此集合请求，即便某服务不需秘密也应提供免 key 的认证语义。
		if (!resolution) {
			// 抛 auth 类错误，由流/图片/分类上层各自转结果。
			throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
		}
		// 取认证子对象的 key/headers/baseUrl。
		const auth = resolution.auth;

		// Explicit request options win per-field; the Models-only transform runs last.
		// 显式 key 优先；?? 保留空字符串作为明确覆盖值，不用真值回退。
		const apiKey = options?.apiKey ?? auth.apiKey;
		// 认证专属 baseUrl 存在时浅复制模型，否则沿用同引用。
		const requestModel: TModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
		// 只有聊天等具 sessionId 的选项分支才提取会话 id。
		const sessionId =
			// in 收窄不同操作选项联合，typeof 保证此处读取到的 sessionId 为字符串；沿用既有边界逻辑。
			options && "sessionId" in options && typeof options.sessionId === "string" ? options.sessionId : undefined;
		// 请求头分两层合并，最后才执行变换钩子。
		let headers = mergeHeaders(
			// OpenCode 会话头作基线，认证头后覆盖。
			mergeHeaders(getOpenCodeSessionHeaders(requestModel, sessionId), auth.headers),
			// 本次请求头再覆盖模型/认证/默认同名头。
			options?.headers,
		);
		// transformHeaders 可异步替换完整结果，空头时传 {}；异常传给上层请求错误路径。
		if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
		// 环境按来源与本次请求合并，请求同名优先；双方没有时保持 undefined。
		const env = resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;
		// 默认应用身份和请求身份逐字段合并。
		const identity = mergeClientIdentity(this.identity, options?.identity);
		// 对象剩余语法消费掉 transformHeaders，避免传给原生 API 请求选项。
		const { transformHeaders: _transformHeaders, ...providerOptions } = options ?? {};
		// 组最终提供商选项，不在此调用 stream 等能力。
		const requestOptions = {
			// 先保留用户其他参数，如温度/timeout/metadata。
			...providerOptions,
			// 写最终显式/认证 key。
			apiKey,
			// 写变换后的头，null 仍可能存在，真正过滤由下层 HTTP 适配器处理。
			headers,
			// 写合并环境。
			env,
			// 确有身份结果才附 identity，不凭空加 undefined 字段。
			...(identity === undefined ? {} : { identity }),
			// 断言装配结果满足移除钩子后的选项类型，不运行 schema 校验。
		} as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>;

		// 返回模型与参数两件数据，供应商实现由调用方法已经查得。
		return { requestModel, requestOptions };
	}

	/**
	 * 以 API 专属参数请求聊天，先规范上下文，再立即开始 lazy setup，返回外层事件流。
	 * 认证/提供商调度在 setup 内，普通 setup/流异常转 error 消息，telemetry 观察该逻辑请求。
	 * 例：无需先 for await 才开始认证；await stream.result() 也可能得到失败消息。
	 */
	stream<TApi extends Api>(
		// 具体聊天协议模型。
		model: Model<TApi>,
		// 公共上下文，尚可含顶层简写。
		context: Context,
		// 该协议可选参数与头变换。
		options?: ModelsApiStreamOptions<TApi>,
		// 同步返回事件流，不是 async Promise 包装。
	): AssistantMessageEventStream {
		// 先把 systemPrompt/tools 折入 system 消息；异常发生在 lazy setup 之外。
		const transcript = normalizeContext(context);
		// lazyStream 立即调用异步 setup，外层流随后即可供消费者使用。
		return lazyStream(
			// 模型身份用于错误/telemetry。
			model,
			// 实际认证与 Provider 调用在该 async 工厂内，抛错变 Promise 拒绝。
			async () => {
				// 确认 chat 种类和注册实现。
				const provider = this.requireChatProvider(model);
				// 请求装配异步取认证、端点和最终选项。
				const { requestModel, requestOptions } = await this.applyAuth(
					// 保留当前具体模型。
					model,
					// 断言到集合通用 API 参数形状，实际数据不变。
					options as ModelsApiStreamOptions<Api> | undefined,
				);
				// 交该 Provider 的专属流方法，context 已规范；断言恢复 TApi 参数关联。
				return provider.stream(requestModel, transcript, requestOptions as ApiStreamOptions<TApi>);
			},
			// 正常逻辑请求 telemetry（poll=false），不是另一份模型请求。
			observeModelRequest(model, options, false),
		);
	}

	/**
	 * 启动同一专属聊天流并等待最终 AssistantMessage，返回 Promise，不另发第二次请求。
	 * 例：const r=await models.complete(m,ctx); 还需检查 r.stopReason；正常返回不是远端成功保证，前置规范化等异常仍可拒绝。
	 */
	async complete<TApi extends Api>(
		// 具体 API 模型。
		model: Model<TApi>,
		// 同一请求上下文。
		context: Context,
		// 专属参数。
		options?: ModelsApiStreamOptions<TApi>,
		// 最终结果 Promise 可含失败消息。
	): Promise<AssistantMessage> {
		// 启动流并等待其最终结果，不重复调用供应商两次。
		return this.stream(model, context, options).result();
	}

	/**
	 * 以供应商无关选项请求聊天，返回立即启动 setup 的外层事件流。
	 * 与 stream 共用认证/上下文/telemetry，最后调用 provider.streamSimple；本层不包含 coding-agent 的虚拟模型路由。例：reasoning 统一值由具体适配器映射。
	 */
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		// 统一参数入口也先规范上下文，规则和工具在消息里。
		const transcript = normalizeContext(context);
		// 与专属入口一样立即启动 lazy setup。
		return lazyStream(
			// 原模型用于错误身份。
			model,
			// 异步工厂返回真实 Provider 流。
			async () => {
				// 先确认 chat 与注册实现。
				const provider = this.requireChatProvider(model);
				// 装配认证与统一参数，无需专属 API 参数断言。
				const { requestModel, requestOptions } = await this.applyAuth(model, options);
				// 交 provider.streamSimple，参数转换由实现负责。
				return provider.streamSimple(requestModel, transcript, requestOptions as SimpleStreamOptions);
			},
			// 标普通请求的观察器。
			observeModelRequest(model, options, false),
		);
	}

	/**
	 * 启动统一参数聊天流并取最终消息 Promise，可能得到 error/aborted 消息。
	 * 例：只需整段回答时使用 completeSimple；不会因为不用 for await 就改成非流式网络协议。
	 */
	async completeSimple(
		// 统一参数的聊天模型。
		model: Model<Api>,
		// 公共上下文。
		context: Context,
		// 统一参数选项。
		options?: ModelsSimpleStreamOptions,
		// 异步返回最终完整消息。
	): Promise<AssistantMessage> {
		// 复用流的 result，不改网络协议为另一种请求。
		return this.streamSimple(model, context, options).result();
	}

	/**
	 * 获取已提交延迟任务的流，返回同步外层事件流并立即检查供应商能力/认证。
	 * 缺 fetchDeferred 能力转流 error；telemetry 标为 poll，句柄原样给供应商。例：持久 response id 可在新一次调用轮询，不代表此方法等待整个后台任务直到成功。
	 */
	streamDeferred(
		// 要获取延迟任务的模型。
		model: Model<Api>,
		// 持久后台句柄。
		handle: DeferredHandle,
		// 获取选项及头变换。
		options?: ModelsDeferredFetchOptions,
		// 返回外层事件流，setup 失败也走协议错误。
	): AssistantMessageEventStream {
		// 获取使用 lazyStream 包裹能力/认证/实际流。
		return lazyStream(
			// 模型提供错误消息身份。
			model,
			// 异步获取准备工作立即开始。
			async () => {
				// 确认聊天模型与注册实现。
				const provider = this.requireChatProvider(model);
				// Provider 没暴露获取能力就不能继续。
				if (!provider.fetchDeferred) {
					// 能力错误在 lazy 中变 error 消息。
					throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
				}
				// 获取也重新解析当前认证，不把句柄当认证 token。
				const { requestModel, requestOptions } = await this.applyAuth(model, options);
				// 使用认证端点与参数，句柄原样传入。
				return provider.fetchDeferred(requestModel, handle, requestOptions as DeferredFetchOptions);
			},
			// 标记 poll=true；pending/deferred 轮询不累计 token/费用，终态轮询仍记录报告用量，不在此执行账单去重。
			observeModelRequest(model, options, true),
		);
	}

	/**
	 * 等待一次延迟结果获取流的最终消息，返回 Promise<AssistantMessage>；不新建后台生成任务。
	 * 例：消息可能仍 pending/deferred，调用者需依 stopReason 决定是否以后再轮询。
	 */
	async fetchDeferred(
		// 获取所用模型。
		model: Model<Api>,
		// 原后台句柄。
		handle: DeferredHandle,
		// 本次轮询配置。
		options?: ModelsDeferredFetchOptions,
		// 一次获取最终消息 Promise，可能仍 pending/deferred。
	): Promise<AssistantMessage> {
		// 等待当前获取流的最终消息，不自动无限轮询。
		return this.streamDeferred(model, handle, options).result();
	}

	/**
	 * 以认证后的请求参数尝试取消延迟任务，返回 Promise<void>；缺能力或认证错误拒绝。
	 * 不同于取结果流，这里直接抛异常；例：调用成功只说明供应商取消接口完成，最终取消效果依提供商 best-effort 契约。
	 */
	async cancelDeferred(
		// 要取消任务的模型。
		model: Model<Api>,
		// 供应商持久句柄。
		handle: DeferredHandle,
		// 取消操作公共参数与头变换。
		options?: ModelsDeferredCancelOptions,
		// Promise<void> 只说明完成/拒绝，没有回答文本。
	): Promise<void> {
		// 直接查 chat Provider，异常拒绝该 async 方法而非形成流。
		const provider = this.requireChatProvider(model);
		// 未支持取消能力则明确报错。
		if (!provider.cancelDeferred) {
			// 稳定 provider 类错误。
			throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
		}
		// 取消也通过最新认证与请求头装配。
		const { requestModel, requestOptions } = await this.applyAuth(model, options);
		// 等待供应商 best-effort 取消方法结束。
		await provider.cancelDeferred(requestModel, handle, requestOptions);
	}

	/**
	 * 专用图片生成入口，按模型种类、供应商能力、认证顺序装配后执行。
	 * 返回 AssistantImages，try 中异常转空 output 的 error/aborted 结果；例：无 generateImages 能力不拒绝该正常输入调用，而返回错误状态供检查。
	 */
	async generateImages(
		// 专用图片生成模型。
		model: ImageModel<ImageApi>,
		// 图片输入内容，不是聊天 messages。
		context: ImagesContext,
		// 图片参数加头变换。
		options?: ModelsImagesOptions,
		// 返回完整图片任务结果。
	): Promise<AssistantImages> {
		// 准备/实际调用错误都在本层捕获范围。
		try {
			// 确认操作种类，typed 签名不替代这个公共能力边界。
			assertImageModel(model);
			// 取得拥有该模型的 Provider。
			const provider = this.requireProvider(model);
			// 接口可省略图片生成方法，不能仅凭有模型目录就假定能调用。
			if (!provider.generateImages) {
				// 缺能力错误由本方法 catch 转图片结果。
				throw new ModelsError("provider", `Provider ${model.provider} does not support image generation`);
			}
			// 解析认证、端点、头与环境。
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			// await 让异步请求拒绝也被本 try 捕获。
			return await provider.generateImages(requestModel, context, requestOptions);
			// 捕获真实请求或准备异常。
		} catch (error) {
			// 返回空 output 的错误，若调用信号已取消则标 aborted。
			return imageErrorResult(model, error, options?.signal?.aborted);
		}
	}

	/**
	 * 专用分类入口，先确认模型种类及图片输入能力，再认证并调用供应商。
	 * 返回 ClassifierResult；try 中异常转空 answers 的失败/取消结果。例：纯文字分类模型收到非空 images 时本地返回错误，不在这里验证图片字节内容。
	 */
	async classify(
		// 专用分类模型。
		model: ClassifierModel<ClassifierApi>,
		// 结构化状态与问题输入。
		context: ClassifierContext,
		// 分类参数加头变换。
		options?: ModelsClassifierOptions,
		// 返回完整分类结果。
	): Promise<ClassifierResult> {
		// 能力、认证、请求全部在异常转换范围。
		try {
			// 先确认 classifier 种类。
			assertClassifierModel(model);
			// 图片非空时核对模型 input 能力，不验证编码。
			assertClassifierInputSupported(model, context);
			// 取实际注册供应商。
			const provider = this.requireProvider(model);
			// 没有 classify 方法不能继续。
			if (!provider.classify) {
				// 抛能力错误，catch 转失败结果。
				throw new ModelsError("provider", `Provider ${model.provider} does not support classification`);
			}
			// 统一装配认证和公共请求字段。
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			// await 捕获供应商异步拒绝，不裸返回未观察 Promise。
			return await provider.classify(requestModel, context, requestOptions);
			// 捕获准备或调用异常。
		} catch (error) {
			// 返回空 answers，按信号状态标 error/aborted。
			return classifierErrorResult(model, error, options?.signal?.aborted);
		}
	}
}

/**
 * 创建空的可变 Models 集合，注入可选凭证、目录存储、认证上下文和默认身份。
 * 默认内存存储，不自动加入供应商或执行网络请求。例：const m=createModels(); m.setProvider(provider); 然后按模型查询/请求。
 */
export function createModels(options?: CreateModelsOptions): MutableModels {
	// 构造实现并以接口返回；不注册供应商或调用 refresh。
	return new ModelsImpl(options);
}

// 从静态数据、认证与各能力实现装配 Provider 的输入契约。
export interface CreateProviderOptions<TApi extends Api = Api> {
	// 唯一供应商 id。
	id: string;
	/** Display name. Default: `id`. */
	// 可选展示名，实际默认 id。
	name?: string;
	// 可选基础端点。
	baseUrl?: string;
	// 可选默认请求头。
	headers?: ProviderHeaders;
	/** Required — every provider has auth semantics, even ambient/keyless ones. */
	// 认证语义必需，即便免 key 服务也不能省略整个 auth。
	auth: ProviderAuth;
	/**
	 * Static baseline models of every type (empty for purely dynamic providers).
	 * Models without `type` are chat models.
	 */
	// 静态全种类基线；没有 type 的旧目录项当聊天。
	models: readonly ProviderModel<TApi>[];
	/**
	 * Fetch a dynamic model overlay of every type. createProvider restores and
	 * publishes it transactionally and drops models of unknown types.
	 */
	// 可选动态抓取器，返回全种类覆盖目录；本工厂会通过发布器保存/更新。
	fetchModels?: (context: RefreshModelsContext) => Promise<readonly ProviderModel<TApi>[]>;
	/** Credential-specific chat model availability. See `Provider.filterModels`. */
	// 聊天目录资格过滤器。
	filterModels?: (models: readonly Model<TApi>[], credential: Credential | undefined) => readonly Model<TApi>[];
	/** Credential-specific availability across every model type. See `Provider.filterAllModels`. */
	// 全种类资格过滤优先，输入可能混合 chat/image/classifier。
	filterAllModels?: (
		// 待过滤的供应商全目录。
		models: readonly ProviderModel<TApi>[],
		// 可选有效凭证供订阅/账号资格规则。
		credential: Credential | undefined,
		// 返回保留目录，不在类型层验证是否来自原数组。
	) => readonly ProviderModel<TApi>[];
	/**
	 * Chat implementation: a single one for all chat models, or a map keyed by
	 * `model.api` for mixed-API providers. Optional when `images` or
	 * `classifiers` is given.
	 */
	// 聊天实现可以是一对象或按 TApi 映射的稀疏表；未提供时须有其他能力实现。
	api?: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;
	/** Image-generation implementations keyed by `model.api`. */
	// 图片生成协议到实现对象的可选映射。
	images?: Partial<Record<ImageApi, ProviderImages>>;
	/** Classifier implementations keyed by `model.api`. */
	// 分类协议到实现对象的可选映射。
	classifiers?: Partial<Record<ClassifierApi, ProviderClassifier>>;
}

/**
 * Builds a provider from parts. Built-in provider factories and models.json
 * custom providers both go through this. A single `api` streams all chat
 * models; an `api` map dispatches on `model.api`, and a model whose api has
 * no entry produces a stream error. One-shot operation maps dispatch on
 * `model.api` the same way. At least one concrete implementation across
 * `api`/`images`/`classifiers` is required; empty maps are rejected.
 */
/**
 * 把元数据、认证、静态目录、动态抓取与聊天/图片/分类实现拼成 Provider。
 * 至少要一个具体实现，否则同步抛错；目录以种类+id 合并静态和动态覆盖，缺协议实现时生成错误结果或流。
 * 构造时不执行 fetchModels/login/聊天；动态刷新通过 context.publish 先持久化再更新内存，失败不自动回滚已完成的外部写入。
 * 例：同一个供应商同时列 chat/a 与 image/a，二者不会互相覆盖；api 映射可让不同聊天模型走不同协议。
 */
export function createProvider<TApi extends Api = Api>(input: CreateProviderOptions<TApi>): Provider<TApi> {
	// 先判断 api 是单一流实现，还是协议映射表。
	const single =
		// API 装配声明边界检查 stream 是否函数，不逐字段验证实现；as 只为读取可能成员。
		input.api && typeof (input.api as ProviderStreams).stream === "function"
			? // 单一实现保留原对象。
				(input.api as ProviderStreams)
			: // 否则 single 为 undefined。
				undefined;
	// 单一或未传 api 时没有映射；其余按字符串键的实现表读取。
	const byApi = single || !input.api ? undefined : (input.api as Partial<Record<string, ProviderStreams>>);
	// 图片映射断言到通用字符串键，未提供仍 undefined。
	const images = input.images as Partial<Record<string, ProviderImages>> | undefined;
	// 分类映射同样泛化键类型，不改原对象。
	const classifiers = input.classifiers as Partial<Record<string, ProviderClassifier>> | undefined;
	// 单一聊天实现变单项数组；映射则列出已提供实现，去 undefined。
	const streams = single ? [single] : Object.values(byApi ?? {}).filter((entry) => entry !== undefined);
	// 列出实际图片实现，后面决定是否暴露能力。
	const imageImplementations = Object.values(images ?? {}).filter((entry) => entry !== undefined);
	// 列出实际分类实现。
	const classifierImplementations = Object.values(classifiers ?? {}).filter((entry) => entry !== undefined);
	// 三类具体实现都空，不能构造只有目录却无任何请求能力的 Provider。
	if (streams.length === 0 && imageImplementations.length === 0 && classifierImplementations.length === 0) {
		// 同步拒绝空实现配置，不等待调用模型时才报错。
		throw new Error(`Provider ${input.id}: at least one of "api", "images", or "classifiers" is required.`);
	}

	// 保留静态目录数组引用，调用方按约定不要原地篡改它。
	const baselineModels = input.models;
	// 动态覆盖初始为空，只有刷新发布才更新。
	let dynamicModels: readonly ProviderModel<TApi>[] = [];
	// 局部保存可选抓取器，构造时不执行。
	const fetchModels = input.fetchModels;
	/**
	 * 局部目录读取器，返回静态基线与当前动态覆盖合并的新数组。
	 * 按种类+id 替换，新增动态项放末尾，模型对象不深复制；例：动态 chat/a 替基线 chat/a，但不替 image/a。
	 */
	const currentModels = (): readonly ProviderModel<TApi>[] => {
		// 每次读目录先复制静态基线容器。
		const merged = [...baselineModels];
		// 按动态目录顺序合并覆盖。
		for (const model of dynamicModels) {
			// 查相同种类+id 的基线/此前动态项。
			const index = merged.findIndex(
				// 不同种类即使 id 相同也不覆盖。
				(entry) => getModelType(entry) === getModelType(model) && entry.id === model.id,
			);
			// 找到同键就替换该位置，保持位置顺序。
			if (index >= 0) merged[index] = model;
			// 未找到则追加新模型。
			else merged.push(model);
		}
		// 返回新数组，模型对象仍共享。
		return merged;
	};
	/**
	 * 局部按模型 api 找聊天实现，单一实现优先，否则查映射；返回实现或 undefined，无 I/O。例：同供应商的 Responses 与 Completions 目录项可走不同映射。
	 */
	// 单实现优先，否则按模型 api 查实现；缺映射 undefined，由 dispatch 报错。
	const apiFor = (model: Model<Api>): ProviderStreams | undefined => single ?? byApi?.[model.api];

	/**
	 * 按模型 api 选择单一或映射的聊天实现，再执行传入 run 回调，返回事件流。
	 * 无匹配实现时用 lazyStream 返回 error 消息；有实现时直接调用 run，同步抛错仍可传播给外层调用者。
	 * 例：chat api=x 没有映射项，返回“no API implementation”错误流，而不是自动换另一协议。
	 */
	const dispatch = (
		// 将要请求的聊天模型，用 api 定位实现。
		model: Model<Api>,
		// 具体 stream 或 streamSimple 调用通过函数参数注入。
		run: (streams: ProviderStreams) => AssistantMessageEventStream,
		// 同步返回统一事件流。
	): AssistantMessageEventStream => {
		// 按 apiFor 得到本模型实现，不基于 model.id 猜协议。
		const streams = apiFor(model);
		// 未配置该协议也不自动切别的实现。
		if (!streams) {
			// 用 async setup 抛错，包装成协议 error 事件而非在这里同步抛。
			return lazyStream(model, async () => {
				// 错误指出供应商与缺少的 api。
				throw new ModelsError("stream", `Provider ${input.id} has no API implementation for "${model.api}"`);
			});
		}
		// 有实现直接运行注入回调，未在此再包装同步异常。
		return run(streams);
	};

	// 构造 Provider 对象，属性多为输入透传与闭包方法。
	const provider: Provider<TApi> = {
		// 保留 id 作为集合键。
		id: input.id,
		// 未给 name 默认 id，空字符串 name 仍保留。
		name: input.name ?? input.id,
		// 基础端点元数据。
		baseUrl: input.baseUrl,
		// 默认头元数据。
		headers: input.headers,
		// 供应商认证方法对象。
		auth: input.auth,
		// 聊天目录从当前合并目录筛出，类型谓词保留 TApi；未 type 模型按 chat。
		getModels: () => currentModels().filter((model): model is Model<TApi> => isModelType(model, "chat")),
		// 全目录直接使用合并闭包。
		getAllModels: currentModels,
		// 有抓取器才暴露 refreshModels，静态 Provider 没该方法。
		refreshModels: fetchModels
			? // 异步刷新回调只有真正刷新时才运行。
				async (context) => {
					// 存在缓存时先恢复，不立刻直接联网覆盖。
					if (context.stored) {
						// 从缓存目录提取当前供应商的项。
						const restored = context.stored.models
							// 过滤其他 provider 的模型，避免缓存混家。
							.filter((model) => model.provider === input.id)
							// 类型断言协调当前 ProviderModel 泛型，不校验每项所有字段。
							.map((model) => model as ProviderModel<TApi>);
						// 恢复也必须经 generation 检查的发布器。
						if (
							// 等待同步内存更新是否仍被接受，恢复不带 persist 不重写缓存。
							!(await context.publish({
								// update 只负责更新本 Provider 的动态目录状态。
								update: () => {
									// 把恢复列表作为当前动态覆盖。
									dynamicModels = restored;
								},
							}))
						) {
							// 被取消/新代次取代则结束，不再继续联网。
							return;
						}
					}
					// 缓存恢复后，明确离线或已取消就停止网络阶段。
					if (!context.allowNetwork || context.signal.aborted) return;
					// 实际动态抓取在此 await，可能联网或执行供应商自有逻辑。
					const fetched = await fetchModels(context);
					// 抓取完成再检查取消，避免把过时结果提交。
					if (context.signal.aborted) return;
					// 过滤当前版本未知种类；不等同全字段 schema 校验或按 provider 再过滤抓取结果。
					const refreshed = fetched.filter(hasKnownModelType);
					// 经发布器先保存选定目录，再同步更新本地状态。
					await context.publish({
						// 记录动态目录与 Date.now 毫秒检查时间，不只保存模型文本。
						persist: { models: refreshed, checkedAt: Date.now() },
						// 同步状态变更回调不会提前于持久化成功执行。
						update: () => {
							// 将最新动态目录设为当前覆盖，不在此直接改基线。
							dynamicModels = refreshed;
						},
					});
				}
			: // 没抓取器就不暴露刷新方法。
				undefined,
		// 聊天资格过滤原样透传，构造时不执行。
		filterModels: input.filterModels,
		// 全种类资格过滤同样透传。
		filterAllModels: input.filterAllModels,
		// 专属流入口通过 dispatch 按协议选择，不在工厂再做认证装配。
		stream: (model, context, options) => dispatch(model, (streams) => streams.stream(model, context, options)),
		// 统一参数流入口也走同一协议分发。
		streamSimple: (model, context, options) =>
			// 选定实现后原样转发 model/context/options。
			dispatch(model, (streams) => streams.streamSimple(model, context, options)),
	};

	// 至少一个聊天实现声明获取后台结果能力，才给 Provider 暴露该方法。
	if (streams.some((entry) => entry.fetchDeferred !== undefined)) {
		// 每次调用再按实际模型协议检查具体能力。
		provider.fetchDeferred = (model, handle, options) =>
			// 获取过程通过 lazyStream 包裹加载/能力错误。
			lazyStream(model, async () => {
				// 当前模型 API 对应实现，可能与其他支持该能力的实现不同。
				const implementation = apiFor(model);
				// 总接口有能力不代表每个协议都有，必须再检查。
				if (!implementation?.fetchDeferred) {
					// 缺能力构造 provider 类错误，进入外层错误流。
					throw new ModelsError(
						// 稳定错误类别。
						"provider",
						// 文案指出实际协议未提供该能力。
						`Provider ${input.id} does not support deferred responses for "${model.api}"`,
					);
				}
				// 有实现才调用其后台获取流。
				return implementation.fetchDeferred(model, handle, options);
			});
	}
	// 至少一个实现支持取消才给 Provider 添加方法。
	if (streams.some((entry) => entry.cancelDeferred !== undefined)) {
		// 取消是 async 方法，错误以 Promise 拒绝，不生成流。
		provider.cancelDeferred = async (model, handle, options) => {
			// 按该模型 API 取具体实现。
			const implementation = apiFor(model);
			// 某个协议没取消能力，不能用另一个协议方法替代。
			if (!implementation?.cancelDeferred) {
				// 构造能力错误。
				throw new ModelsError(
					// 错误类别为 provider。
					"provider",
					// 带具体协议的可读说明。
					`Provider ${input.id} cannot cancel deferred responses for "${model.api}"`,
				);
			}
			// 等待实际取消实现完成，仍是 best-effort 契约。
			await implementation.cancelDeferred(model, handle, options);
		};
	}
	// 有图片映射且至少一项实现时暴露图片生成能力。
	if (images && imageImplementations.length > 0) {
		// 图片生成由模型 api 查映射，不经过聊天 dispatch。
		provider.generateImages = async (model, context, options) => {
			// 查具体图片实现。
			const implementation = images[model.api];
			// 该协议没实现时返回错误数据，而不是回退其他图片 API。
			if (!implementation) {
				// 调用统一图片错误包装器。
				return imageErrorResult(
					// 错误结果保留原模型身份。
					model,
					// 构造缺实现的 ModelsError。
					new ModelsError(
						// 错误类别 provider。
						"provider",
						// 指出缺少该图片 API 实现。
						`Provider ${input.id} has no image generation implementation for "${model.api}"`,
					),
				);
			}
			// 找到实现直接转发；若实现自己抛异常/拒绝，本 Provider 包装不另 catch，Models.generateImages 外层才会兜底。
			return implementation.generateImages(model, context, options);
		};
	}
	// 分类映射非空时才暴露 classify。
	if (classifiers && classifierImplementations.length > 0) {
		// 每次按实际分类 api 调度。
		provider.classify = async (model, context, options) => {
			// 读取该协议具体实现。
			const implementation = classifiers[model.api];
			// 缺实现返回结构化错误答案。
			if (!implementation) {
				// 统一分类错误包装器。
				return classifierErrorResult(
					// 保留模型身份。
					model,
					// 错误指出供应商与缺失分类协议。
					new ModelsError("provider", `Provider ${input.id} has no classifier implementation for "${model.api}"`),
				);
			}
			// 直接转发具体实现；遵守“不拒绝”需要实现合作，Models.classify 另有外层 catch。
			return implementation.classify(model, context, options);
		};
	}

	// 返回完整 Provider，本函数本身没有执行认证/抓取/模型请求。
	return provider;
}

/**
 * Runtime-checked narrowing for dynamically looked-up models:
 *
 * ```ts
 * const model = models.getModel("anthropic", "claude-opus-4-7");
 * if (model && hasApi(model, "anthropic-messages")) {
 *   // model: Model<"anthropic-messages">, stream options fully typed
 * }
 * ```
 *
 * Non-chat models never match, even when their api id equals `api`.
 */
/**
 * 同时校验模型为聊天且 api 等于指定值，返回类型谓词，供动态目录恢复精确参数类型。
 * 例：if (hasApi(m,"anthropic-messages")) 内 m 是对应 Model；图片模型即使 api 同名也不匹配，无副作用。
 */
export function hasApi<TApi extends Api>(model: AnyModel, api: TApi): model is Model<TApi> {
	// 先核对 chat 种类，再比协议，真分支得到 Model<TApi> 类型收窄。
	return isModelType(model, "chat") && model.api === api;
}

/**
 * 按目录价格及用量计算费用，直接修改 usage.cost 并返回同一 cost 对象。
 * 先按含缓存的输入量选最大已超过阈值的档，再计算每百万 token 单价；一小时缓存写按两倍普通输入价。
 * 例：恰好等于 inputTokensAbove 不进该档，必须严格大于；这是目录估算，最后标 totalFromProvider=false，不能保留原供应商账单标记。
 */
export function calculateCost(model: AnyModel, usage: Usage): Usage["cost"] {
	// 价格档位依据普通输入+缓存读+缓存写，总量不包含 output。
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	// 初始采用基础单价，后面可被阶梯覆盖。
	let rates: ModelCostRates = model.cost;
	// 已匹配阈值初始为 -1，便于挑最高有效阈值。
	let matchedThreshold = -1;
	// 没 tiers 当空数组，使用基础价格。
	for (const tier of model.cost.tiers ?? []) {
		// 必须严格超过档位门槛，且该门槛高于已选档，不依赖数组先后排序。
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			// 选当前档价格，结构包含四类单价。
			rates = tier;
			// 记录其阈值，防后面的低档覆盖高档。
			matchedThreshold = tier.inputTokensAbove;
		}
	}

	// Anthropic charges 2x base input for 1h cache writes.
	// cacheWrite1h 是 cacheWrite 子集，缺失按 0。
	const longWrite = usage.cacheWrite1h ?? 0;
	// 总写缓存减 1h 子集得到普通短缓存写量，不重复计费。
	const shortWrite = usage.cacheWrite - longWrite;
	// 单价按每百万 token，乘实际普通输入量。
	usage.cost.input = (rates.input / 1000000) * usage.input;
	// 输出按当前档输出单价。
	usage.cost.output = (rates.output / 1000000) * usage.output;
	// 缓存读按当前档缓存读单价。
	usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;
	// 短写用缓存写价，1h 写用两倍输入价，再统一除百万。
	usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;
	// 总额为四项目录估算和，不采用旧 total 值。
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	// 明确这次结果是估算，覆盖原 true 的供应商实报标记。
	usage.cost.totalFromProvider = false;
	// 返回同一个 usage.cost 引用，调用方原对象已被改写。
	return usage.cost;
}

// 统一级别从低到高的有序列表，模型能力过滤/钳制都以它为准。
const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 列当前模型支持的统一思考级别，返回新数组，无网络能力探测。
 * 不支持 reasoning 只有 off；null 映射排除，xhigh/max 必须显式非 undefined，其他缺映射仍可用。例：仅 reasoning=true 不自动开放 xhigh。
 */
export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	// 不支持 reasoning 的模型只给 off，不推断远端更多档位。
	if (!model.reasoning) return ["off"];

	// filter 返回支持列表新数组，不修改共享常量。
	return EXTENDED_THINKING_LEVELS.filter((level) => {
		// 读取该档位原生映射，可能 undefined/null/具体值。
		const mapped = model.thinkingLevelMap?.[level];
		// null 明确禁用该档，优先排除。
		if (mapped === null) return false;
		// xhigh/max 需要显式映射，undefined 不开放；null 已在上面排除。
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		// 其他档位默认允许，交适配器默认映射。
		return true;
	});
}

/**
 * 将请求思考级别映到支持集合，返回可用值，不改模型。
 * 已支持原样返回；否则先从请求位置向更高查，再向更低查，最终首项/off。例：high 不支持而 xhigh 有映射时可向上选 xhigh，并非总是降低到 low。
 */
export function clampThinkingLevel<TApi extends Api>(
	// 模型目录声明提供能力与思考映射。
	model: Model<TApi>,
	// 用户想要的统一级别。
	level: ModelThinkingLevel,
	// 返回实际可选级别，不修改模型或全局默认。
): ModelThinkingLevel {
	// 重新按能力计算可用列表。
	const availableLevels = getSupportedThinkingLevels(model);
	// 已支持则不改变请求。
	if (availableLevels.includes(level)) return level;

	// 获取请求在从低到高列表的位置。
	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	// 未知值的既有兜底：选首可用，否则 off；类型正常调用只会给合法联合值。
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	// 先从请求级别向更高位置查，避免默认只往下猜。
	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		// 当前候选级别。
		const candidate = EXTENDED_THINKING_LEVELS[i];
		// 第一个支持项即返回。
		if (availableLevels.includes(candidate)) return candidate;
	}
	// 向上没有，再向更低位置倒查。
	for (let i = requestedIndex - 1; i >= 0; i--) {
		// 取较低候选。
		const candidate = EXTENDED_THINKING_LEVELS[i];
		// 第一个支持项即返回。
		if (availableLevels.includes(candidate)) return candidate;
	}
	// 两边都没找到则首支持/off 兜底。
	return availableLevels[0] ?? "off";
}

/**
 * Check if two models are equal by comparing their type, id, and provider.
 * Returns false if either model is null or undefined.
 */
/**
 * 按种类、id、provider 判断两个模型身份是否相同；任一为空返回 false。
 * 例：同供应商同 id 的 chat 与 image 不相等；不同 baseUrl/价格但三项相同仍相等，不是逐字段深比较。
 */
export function modelsAreEqual(a: AnyModel | null | undefined, b: AnyModel | null | undefined): boolean {
	// 任一缺失就不相等，两个 undefined 也不是“同一模型”。
	if (!a || !b) return false;
	// 类型、id、provider 三项同时匹配才算身份相等，不比 api/baseUrl/价格。
	return getModelType(a) === getModelType(b) && a.id === b.id && a.provider === b.provider;
}
