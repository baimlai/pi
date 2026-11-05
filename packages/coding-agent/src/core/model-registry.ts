// 给扩展保留同步查询模型的外观接口；真正的认证、请求和注册由 ModelRuntime 完成。
// import type 只引入类型，编译后不会产生这些名字的运行时导入。
import type {
	// 不同聊天 API 的标识，Model<TApi> 用它关联模型和请求选项类型。
	Api,
	// 图片生成的完整结果；失败也能作为结果中的错误返回。
	AssistantImages,
	// 最终的完整助手消息，和逐个增量事件不同。
	AssistantMessage,
	// 异步事件流，可逐个读取事件，也可调用 result() 等最终消息。
	AssistantMessageEventStream,
	// 认证查询的可选参数，例如取消信号。
	AuthOperationOptions,
	// 认证解析的完整结果，不只有一个 API key 字符串。
	AuthResult,
	// 下面四项分别是分类 API、输入上下文、模型和结果类型。
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	// 聊天上下文，包括历史消息、系统提示和工具声明。
	Context,
	// 下面三项对应图片 API、模型描述和输入上下文。
	ImageApi,
	ImageModel,
	ImagesContext,
	// Model<Api> 是聊天模型；图片和分类有各自的模型类型。
	Model,
	// 特定 API 的参数；泛型会把模型与该 API 的参数绑定。
	ModelsApiStreamOptions,
	// 分类和图片生成的选项，与普通聊天选项分开。
	ModelsClassifierOptions,
	ModelsImagesOptions,
	// 模型刷新操作的选项及结果，结果可携带分提供商的错误。
	ModelsRefreshOptions,
	ModelsRefreshResult,
	// 跨提供商的统一聊天选项，具体转换交给运行时和提供商。
	ModelsSimpleStreamOptions,
	// ModelType 是能力类别，ModelTypeMap 把类别映射到对应模型类型。
	ModelType,
	ModelTypeMap,
	// Provider 是实现请求能力的对象；ProviderHeaders 描述请求头及删除标记。
	Provider,
	ProviderHeaders,
} from "@earendil-works/pi-ai";
// 本类只保留运行时引用，不再维护一套独立的模型和认证缓存。
import type { ModelRuntime } from "./model-runtime.ts";
// 配置覆盖及认证配置状态；“已配置”不是远端认证成功的保证。
import type { AuthStatus, ProviderConfigInput } from "./provider-composer.ts";
// 虚拟模型通过路由规则选择真正发请求的物理模型。
import type { VirtualModelDefinition } from "./virtual-models.ts";

// 类型转导出，扩展无需知道内部的类型定义位置。
export type { ProviderConfigInput } from "./provider-composer.ts";
/** 认证结果用 ok 区分成功与失败；先判断 ok，才能安全读取成功字段或 error。 */
export type ResolvedRequestAuth =
	| {
			// true 是字面量类型，与下面 false 一起构成联合类型的区分标记。
			ok: true;
			// 成功仍可没有 key，例如只靠自定义请求头或无需认证的提供商。
			apiKey?: string;
			// ? 表示可省略；请求头可能包含额外认证信息。
			headers?: ProviderHeaders;
			// 某些登录方式要求发往专属地址。
			baseUrl?: string;
			// Record<string, string> 表示键和值都为字符串的字典。
			env?: Record<string, string>;
	  }
	// 失败分支只提供 error；例如 if (!result.ok) 就可以展示 result.error。
	| { ok: false; error: string };
// 转导出原函数，没有在本模块创建另一份缓存。
export { clearApiKeyCache } from "./provider-composer.ts";

/**
 * Synchronous compatibility facade exposed to extensions.
 * Coding-agent internals use ModelRuntime directly.
 */
/** 扩展用的兼容入口：同步方法读取快照，异步方法执行刷新、认证解析或实际请求。 */
export class ModelRegistry {
	// private 禁止外部直接访问；readonly 禁止换掉这个引用，不禁止 runtime 自身更新。
	private readonly runtime: ModelRuntime;

	/** 注入已有运行时；例如 new ModelRegistry(runtime)，构造本身不刷新网络。 */
	constructor(runtime: ModelRuntime) {
		// 显式声明字段再赋值，使用 Node 可以直接擦除类型的 TypeScript 写法。
		this.runtime = runtime;
	}

	/** Reload models.json asynchronously. Await before making synchronous registry reads. */
	/** 重载配置和目录；要先 await refresh()，再通过同步方法读取这轮刷新后的快照。 */
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
		// 直接返回底层 Promise，保留完整刷新结果和错误。
		return this.runtime.refresh(options);
	}

	/** 返回配置、提供商组合或可用性检查的汇总错误；没有记录时返回 undefined。 */
	getError(): string | undefined {
		// 不只检查 models.json 语法，实际错误范围由运行时统一汇总。
		return this.runtime.getError();
	}

	/** 同步列出所有已登记聊天模型，包括尚未配置认证的模型。 */
	getAll(): Model<Api>[] {
		// ... 展开成新数组；数组可改，但其中模型对象没有在这里深复制。
		return [...this.runtime.getModels()];
	}

	/** 同步读最近可用模型快照；不代表此刻又向远端验证了一遍密钥。 */
	getAvailable(): Model<Api>[] {
		// 没有 await，也不会发起刷新；认证变化后需等待相应异步更新。
		return [...this.runtime.getAvailableSnapshot()];
	}

	/** 按提供商和模型 ID 精确查聊天模型；不存在就返回 undefined。 */
	find(provider: string, modelId: string): Model<Api> | undefined {
		// 模型 ID 在提供商目录内定位，因此需要两个字段一起查。
		return this.runtime.getModel(provider, modelId);
	}

	/** Find a model of a non-chat type, e.g. `findOfType("classifier", "typesafe", "jev-latest")`. */
	/** 按能力查模型；传 "classifier" 时，返回类型就是分类模型或 undefined。 */
	findOfType<TType extends ModelType>(
		// extends 约束泛型必须是合法模型类别，不是类继承。
		type: TType,
		// provider 和 modelId 共同定位模型。
		provider: string,
		modelId: string,
		// ModelTypeMap[TType] 是索引访问类型：从类型映射表取当前类别的模型类型。
	): ModelTypeMap[TType] | undefined {
		// 把三个定位条件原样交给运行时。
		return this.runtime.getModelOfType(type, provider, modelId);
	}

	/** 从快照判断提供商是否配置了认证；不会测试远端是否接受它。 */
	hasConfiguredAuth(model: Model<Api>): boolean {
		// 同一提供商的多个模型共享这一层认证配置状态。
		return this.runtime.hasConfiguredAuth(model.provider);
	}

	/** 解析模型的密钥和请求头；失败转换成 { ok: false, error }，便于扩展展示。 */
	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			// 可能需要读凭证、解析配置或刷新 OAuth，因此要 await 异步认证解析。
			const resolution = await this.runtime.getAuth(model);
			// 没得到认证结果，也可能是免认证或只使用自定义请求头的兼容提供商。
			if (!resolution) {
				// 取兼容配置，尤其是是否必须自动生成 Authorization 头。
				const compatibility = this.runtime.getCompatibilityRequestConfig(model);
				// 明确要求密钥却没有，就返回失败。
				if (compatibility.authHeader) {
					// 模板字符串把提供商 ID 嵌入错误文本，不在错误中包含密钥内容。
					return { ok: false, error: `No API key found for "${model.provider}"` };
				}
				// 允许只带请求头成功，因此 ok: true 不保证 apiKey 一定存在。
				return { ok: true, headers: compatibility.headers };
			}
			// 把运行时完整结果转换成旧接口支持的字段。
			return {
				// ok: true 让调用方进入成功分支后能够读取 apiKey 等字段。
				ok: true,
				// 取解析后的 key，不在这里打印或改写密钥。
				apiKey: resolution.auth.apiKey,
				// 这些头已由运行时结合模型配置解析。
				headers: resolution.auth.headers,
				// 条件对象展开：有专属地址才加 baseUrl 字段，否则展开空对象。
				...(resolution.auth.baseUrl ? { baseUrl: resolution.auth.baseUrl } : {}),
				// 保留本次认证附带的请求环境。
				env: resolution.env,
			};
		} catch (error) {
			// 异常是外部错误边界，可能不是 Error，检查后才能读取 cause。
			const cause = error instanceof Error ? error.cause : undefined;
			// 优先显示内部原因，再显示外层消息，最后将未知抛出值转成字符串。
			const message =
				cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
			// 将异常变成失败数据，调用方不必为普通解析失败写 try/catch。
			return {
				// false 选中联合类型的失败分支。
				ok: false,
				// 将内部特定错误转换成旧扩展熟悉的缺少 API key 提示。
				error:
					// 只匹配这一条消息，其他错误保留原说明。
					message === "authHeader requires a resolved API key"
						? // 匹配时补上提供商 ID。
							`No API key found for "${model.provider}"`
						: // 不匹配则返回刚提取出的原错误消息。
							message,
			};
		}
	}

	/** 返回认证配置状态及来源：运行时覆盖、存储、配置或环境；不调用模型。 */
	getProviderAuthStatus(provider: string): AuthStatus {
		// 状态规则由运行时统一管理，不在注册表另算一份。
		return this.runtime.getProviderAuthStatus(provider);
	}

	/** 按 ID 找实现请求能力的提供商对象；找不到就返回 undefined。 */
	getProvider(provider: string): Provider | undefined {
		// 得到的是 Provider 对象，而不是某一个 Model 模型描述。
		return this.runtime.getProvider(provider);
	}

	/** Stream through the configured provider with request-time authentication. */
	/** 用特定 API 参数流式聊天；认证在请求时解析，返回事件流而不是完整文本。 */
	stream<TApi extends Api>(
		// 同一个 TApi 将 model 与 options 的 API 参数关联起来。
		model: Model<TApi>,
		// 上下文传入系统提示、历史消息及工具声明。
		context: Context,
		// 可省略；这里允许该 API 的参数及取消信号。
		options?: ModelsApiStreamOptions<TApi>,
		// 返回事件流，调用方可以 for await...of，也可以等待 .result()。
	): AssistantMessageEventStream {
		// 不在这里自己拼 HTTP 请求，沿用运行时的认证和模型选择。
		return this.runtime.stream(model, context, options);
	}

	/** Stream with provider-neutral options and request-time authentication. */
	/** 用统一参数流式聊天；例如统一的 reasoning 设置，再由底层适配具体提供商。 */
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		// 虚拟模型路由也交给运行时的 streamSimple 处理。
		return this.runtime.streamSimple(model, context, options);
	}

	/**
	 * 等请求结束后返回整条助手消息；适用于不需要逐字显示的调用方。
	 * 例：const reply = await registry.complete(model, context); 还要检查 reply.stopReason。
	 * Promise 完成也可能得到 error/aborted 消息；底层会把认证/setup 失败整理成流的最终错误消息。
	 */
	complete<TApi extends Api>(
		// 泛型继续保证模型 API 和 options 对应。
		model: Model<TApi>,
		// 传入本次聊天的完整模型上下文。
		context: Context,
		// 省略参数时由底层采用其默认值。
		options?: ModelsApiStreamOptions<TApi>,
		// Promise<AssistantMessage> 表示将来获得整条消息，而不是流事件。
	): Promise<AssistantMessage> {
		// 运行时内部等待 stream(...).result()；本层只转发。
		return this.runtime.complete(model, context, options);
	}

	/** Every known model of a type (chat, image, classifier), optionally for one provider. */
	/** 列指定能力的全部模型，例如 getModelsOfType("image")；可再按提供商筛选。 */
	getModelsOfType<TType extends ModelType>(type: TType, provider?: string): readonly ModelTypeMap[TType][] {
		// readonly 只约束编译期数组操作，不等于运行时深冻结所有模型。
		return this.runtime.getModelsOfType(type, provider);
	}

	/** Models of a type whose provider has working credentials. */
	/** 异步查指定能力的可用模型；认证状态可用仍不能保证实际远端请求必定成功。 */
	getAvailableOfType<TType extends ModelType>(
		// 类别泛型决定返回数组中是哪一类模型。
		type: TType,
		// 省略提供商时跨提供商查这一类别。
		provider?: string,
		// 认证查询可携带取消信号等选项。
		options?: AuthOperationOptions,
		// Promise 包着只读数组：先 await 才能访问数组元素。
	): Promise<readonly ModelTypeMap[TType][]> {
		// 与同步 getAvailable() 读快照不同，这里调用底层异步查询。
		return this.runtime.getAvailableOfType(type, provider, options);
	}

	/** 用类别、提供商、ID 精确查模型；与 findOfType 转交同一个入口。 */
	getModelOfType<TType extends ModelType>(
		// 例如类别 "image" 会对应图片模型类型。
		type: TType,
		// 提供商 ID 定位模型所属目录。
		provider: string,
		// 模型 ID 进一步定位目录中的条目。
		modelId: string,
		// | undefined 要求调用方考虑找不到的情况。
	): ModelTypeMap[TType] | undefined {
		// 不会找不到就自动换一个模型。
		return this.runtime.getModelOfType(type, provider, modelId);
	}

	/** Classify structured state with request-time authentication. Never rejects. */
	/** 调分类模型；运行时将请求失败转成分类结果中的错误，调用方读取结果判断成功。 */
	classify(
		// 分类模型与聊天模型有不同的输入输出类型。
		model: ClassifierModel<ClassifierApi>,
		// 分类上下文描述待判断的结构化输入。
		context: ClassifierContext,
		// 分类请求可选参数，具体支持范围由提供商决定。
		options?: ModelsClassifierOptions,
		// 返回分类结果的 Promise，而不是聊天事件流。
	): Promise<ClassifierResult> {
		// 能力检查、认证和错误结果构造均由运行时处理。
		return this.runtime.classify(model, context, options);
	}

	/** Generate images with request-time authentication. Never rejects. */
	/** 请求生成图片；结果可能包含图片或错误，认证在运行时处理。 */
	generateImages(
		// 这里要求图片模型，不能误传普通聊天模型。
		model: ImageModel<ImageApi>,
		// 传入图片生成所需的上下文。
		context: ImagesContext,
		// 图片请求的可选配置。
		options?: ModelsImagesOptions,
		// 结果类型和 AssistantMessage 分开，不把图片假装成聊天文字。
	): Promise<AssistantImages> {
		// 沿用运行时请求路径，避免注册表再实现一套认证。
		return this.runtime.generateImages(model, context, options);
	}

	/** 优先显示提供商名字；没有名字时回退到 ID，供菜单展示。 */
	getProviderDisplayName(provider: string): string {
		// ?. 在对象不存在时返回 undefined；?? 只对 null/undefined 回退，空字符串不会回退。
		return this.runtime.getProvider(provider)?.name ?? provider;
	}

	/** 解析提供商的完整认证；可能返回 undefined，也可能以异常结束。 */
	getProviderAuth(provider: string): Promise<AuthResult | undefined> {
		// 字符串参数走提供商级查询，不合并某个模型专有的请求头配置。
		return this.runtime.getAuth(provider);
	}

	/** 只取提供商 key；查不到或解析失败都返回 undefined，省略其他认证字段。 */
	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		try {
			// 先 await 得到认证结果，再通过可选链读取 key。
			return (await this.runtime.getAuth(provider))?.auth.apiKey;
		} catch {
			// 这个便捷方法有意吞掉错误；要了解失败原因应调用完整认证接口。
			return undefined;
		}
	}

	/** 从最近的认证状态判断模型提供商是否用 OAuth；不会触发登录或刷新 token。 */
	isUsingOAuth(model: Model<Api>): boolean {
		// 认证状态按提供商查询，不是每个模型单独登录。
		return this.runtime.isUsingOAuth(model.provider);
	}

	/** 注册原生 Provider 对象，或按名字注册配置覆盖，例如 registerProvider("my-api", config)。 */
	registerProvider(provider: Provider): void;
	// 重载声明描述第二种合法调用方式，不会生成第二个 JavaScript 函数。
	registerProvider(providerName: string, config: ProviderConfigInput): void;
	// 唯一实现同时接收两种形状；可选 config 服务于对象形式的调用。
	registerProvider(providerOrName: Provider | string, config?: ProviderConfigInput): void {
		// 这是联合类型分流，字符串表示按名字注册，分支中类型随之缩小。
		if (typeof providerOrName === "string") {
			// 按名路径必须有配置；重载实现签名自身允许省略，所以此处保留原有约束。
			if (!config) throw new Error("Provider config is required when registering by name");
			// 由运行时合并提供商配置覆盖并重建状态。
			this.runtime.registerProvider(providerOrName, config);
			// 提前返回，不能把名字字符串再当 Provider 对象处理。
			return;
		}
		// 离开字符串分支后，类型已经缩小为原生 Provider 对象。
		this.runtime.registerNativeProvider(providerOrName);
	}

	/** 移除扩展的提供商覆盖；同名内置提供商或文件配置仍可能恢复生效。 */
	unregisterProvider(providerName: string): void {
		// 注销扩展覆盖不等于永久禁止整个程序使用这个提供商。
		this.runtime.unregisterProvider(providerName);
	}

	/** 注册虚拟模型及路由规则；物理模型在真正请求时由路由选择。 */
	registerVirtualModel(definition: VirtualModelDefinition): void {
		// 这里只登记定义，不立刻执行路由回调或请求模型。
		this.runtime.registerVirtualModel(definition);
	}

	/** 删除一个虚拟模型，需要提供商与虚拟 ID；不删除其可能路由到的物理模型。 */
	unregisterVirtualModel(providerName: string, id: string): void {
		// 注销范围是虚拟定义，不影响该提供商的登录凭证。
		this.runtime.unregisterVirtualModel(providerName, id);
	}

	/** 查询扩展按名字登记的配置覆盖；不是读取 models.json 的全部配置。 */
	getRegisteredProviderConfig(providerName: string): ProviderConfigInput | undefined {
		// 未按配置方式登记时返回 undefined。
		return this.runtime.getRegisteredProviderConfig(providerName);
	}

	/** 查询扩展登记的原生提供商对象，区别于按名字登记的配置覆盖。 */
	getRegisteredNativeProvider(providerName: string): Provider | undefined {
		// 这里不会把全部内置提供商都算作“扩展已注册”。
		return this.runtime.getRegisteredNativeProvider(providerName);
	}

	/** 列出扩展以配置或原生对象方式登记的提供商 ID，合并并去重。 */
	getRegisteredProviderIds(): readonly string[] {
		// 只读数组是类型约束；此列表不是全部内置提供商的目录。
		return this.runtime.getRegisteredProviderIds();
	}
}
