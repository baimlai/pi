// 将内置 Provider、models.json 和扩展注册配置组合成一个 Provider；目录合成、认证解析、请求头和能力分派各有独立优先级。
import {
	// AnyModel 包括聊天、图片和分类；不是所有字段都能直接用于任意能力。
	type AnyModel,
	// Api 是聊天协议 ID 类型。
	type Api,
	// API key 认证包含 login/check/resolve 三类操作，分别处理交互、配置检查和实际请求认证。
	type ApiKeyAuth,
	// 聊天事件流，既能逐条消费增量，也能等最终消息。
	type AssistantMessageEventStream,
	// 认证上下文提供环境值等宿主能力，不要求认证实现直接依赖 process.env。
	type AuthContext,
	// 登录交互可发通知或询问用户，和读取既存凭证不同。
	type AuthInteraction,
	// 完整认证结果包括 auth、环境和来源说明。
	type AuthResult,
	// 分类协议及模型类型，用于分派非聊天请求。
	type ClassifierApi,
	type ClassifierModel,
	// Credential 是可保存的 API key/OAuth 数据，不等于 HTTP 请求使用的 ModelAuth。
	type Credential,
	// 图片 API 协议类型。
	type ImageApi,
	// 按模型能力判断并收窄类型。
	isModelType,
	// 同步交出外层流并立即开始异步 setup；失败整理成流错误结果。
	lazyStream,
	// Model<Api> 表示聊天目录描述。
	type Model,
	// ModelAuth 承载已解析 key、头和可选地址，供实际请求装配。
	type ModelAuth,
	// 新 OAuth 接口将登录、刷新和凭证转请求认证分开。
	type OAuthAuth,
	// 旧扩展 OAuth 凭证，适配时补上新接口的 type 标签。
	type OAuthCredentials,
	// 旧式扩展登录回调集合。
	type OAuthLoginCallbacks,
	// Provider 组合目录、认证与多类请求能力。
	type Provider,
	// 分类请求实现，不是一个具体分类模型的目录字段。
	type ProviderClassifier,
	// ProviderHeaders 允许保留删除标记；这里的对象展开不是通用大小写折叠器。
	type ProviderHeaders,
	// 图片生成请求实现。
	type ProviderImages,
	// 刷新上下文的 publish 用于受刷新代次/取消信号约束地更新目录。
	type RefreshModelsContext,
	// 统一参数的聊天选项。
	type SimpleStreamOptions,
	// 特定 API 的聊天选项。
	type StreamOptions,
	// TranscriptContext 是带模型协议消息的聊天上下文，供流实现使用。
	type TranscriptContext,
} from "@earendil-works/pi-ai";
// 兼容注册器可按 API ID 查实现；没有可复用的底层 Provider 时走这条后备路径。
import { getApiProvider } from "@earendil-works/pi-ai/compat";
// 图片与分类缺实现时，按各自接口形状返回错误结果。
import { classifierErrorResult, imageErrorResult } from "@earendil-works/pi-ai/utils/model-operations";
// 模型文件类型来自 schema，ModelConfig 负责加载快照，本模块负责组合而非再次读文件。
import type { ModelConfig, ModelsJsonModel, ModelsJsonModelOverride, ModelsJsonProvider } from "./model-config.ts";
// 复用配置字符串解析；其中 OrThrow 路径不使用命令结果缓存。
import {
	// 旧 clearApiKeyCache 名称实际清的是配置 !命令结果缓存。
	clearConfigValueCache,
	// 列模板引用变量，不执行命令。
	getConfigValueEnvVarNames,
	// 识别 !开头的命令表达式。
	isCommandConfigValue,
	// 检查模板变量是否齐全，不等于认证成功。
	isConfigValueConfigured,
	// 解析 key，缺值抛出带位置说明的错误。
	resolveConfigValueOrThrow,
	// 严格解析所有头，缺一项就拒绝；!命令每次重跑。
	resolveHeadersOrThrow,
} from "./resolve-config-value.ts";

/** 扩展旧 OAuth 配置，由 adaptOAuth 转成统一认证接口；例：扩展提供 login/refreshToken/getApiKey。 */
export interface ExtensionOAuthConfig {
	// 认证方式的显示名。
	name: string;
	/** Whether access through this auth method is backed by a provider subscription. */
	// 是否属于提供商订阅，供界面/策略读取，并非在这里判断账号实际套餐。
	isSubscription?: boolean;
	/** @deprecated Retained for extension source compatibility; ignored by canonical auth flows. */
	// 废弃字段仍保留类型兼容，但新认证流程忽略它；不能据此推断会启动回调服务器。
	usesCallbackServer?: boolean;
	/** 通过旧回调完成登录并返回 OAuth 凭证，可能包含交互与网络。 */
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	/** 刷新凭证；signal 必须由实现配合检查或传给网络请求，类型本身不会取消工作。 */
	refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
	/** 将 OAuth 凭证转换为请求用的 key 字符串，例如从 access token 派生。 */
	getApiKey(credentials: OAuthCredentials): string;
	/** 可选的旧聊天目录投影；例如订阅登录后调整聊天模型列表，不处理图片/分类。 */
	modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}

// 扩展三类模型共用的目录字段；这些是开发时类型约束，不是磁盘 JSON schema。
interface ProviderModelConfigBase {
	// 模型 ID 在提供商目录内定位。
	id: string;
	// 给用户显示的名称。
	name: string;
	// 可省略 API，后续按类型和基线推断；有值时是协议 ID。
	api?: string;
	// 可省略地址，后续沿模型/扩展/基线优先级找。
	baseUrl?: string;
	// 输入模态数组，可以支持文字、图片或两者。
	input: ("text" | "image")[];
	// 索引访问类型复用模型已有的输入限制字段结构。
	inputLimits?: AnyModel["inputLimits"];
	// 复用模型成本类型，避免扩展层另写不一致结构。
	cost: AnyModel["cost"];
	// 模型级原始请求头表达式，在请求认证阶段另行解析。
	headers?: Record<string, string>;
}

/** 扩展的聊天模型定义；extends 继承共用目录字段，type 可省略兼容旧聊天定义。 */
export interface ProviderChatModelConfig extends ProviderModelConfigBase {
	// 可选标签没有值时仍按 chat 处理。
	type?: "chat";
	// 进一步把通用 api 字符串约束为聊天 API 类型。
	api?: Api;
	// 是否支持思考；不等于本次请求开启思考。
	reasoning: boolean;
	// 思考档位与提供商值的映射。
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	// 提示词缓存能力元数据。
	promptCache?: Model<Api>["promptCache"];
	// 整个上下文窗口的 token 容量。
	contextWindow: number;
	// 最大输出 token 数，和输入历史上限不是同一项。
	maxTokens: number;
	// 通用请求采样附加字段。
	samplingParams?: Model<Api>["samplingParams"];
	// 不同思考档位覆盖通用采样字段。
	samplingParamsByThinkingLevel?: Model<Api>["samplingParamsByThinkingLevel"];
	// 聊天 API 兼容选项。
	compat?: Model<Api>["compat"];
}

/** 扩展图片模型定义：必须带 image 标签，不能误当作缺标签的聊天模型。 */
export interface ProviderImageModelConfig extends ProviderModelConfigBase {
	// 字面量标签使联合类型可按能力收窄。
	type: "image";
	// 图片协议不能靠提供商级聊天 api 自动补齐。
	api?: ImageApi;
	// 图片生成结果可以包含文字和图片，与 input 是不同方向的模态。
	output: ("text" | "image")[];
}

/** 扩展分类模型定义：独立的 classifier 标签、协议、容量和兼容选项。 */
export interface ProviderClassifierModelConfig extends ProviderModelConfigBase {
	// 明确分类能力，避免 ID 与聊天模型撞名时取错字段。
	type: "classifier";
	// 分类协议 ID。
	api?: ClassifierApi;
	// 分类模型的上下文容量。
	contextWindow: number;
	// 使用分类模型自己的 compat 类型，不把全部聊天协议选项强套给它。
	compat?: ClassifierModel<ClassifierApi>["compat"];
}

/** 三选一的模型定义；判断 type 后才能使用 reasoning/output 等各类特有字段。 */
export type ProviderModelConfig = ProviderChatModelConfig | ProviderImageModelConfig | ProviderClassifierModelConfig;

/** Input type for the extension registerProvider API. */
/** 扩展 registerProvider 的输入：可只覆盖地址，也可替换目录并增加各能力实现。 */
export interface ProviderConfigInput {
	// 扩展显示名优先于文件和内置显示名。
	name?: string;
	// 扩展可替换目录中的模型地址。
	baseUrl?: string;
	// 扩展级 key 配置优先于 models.json，同样可用变量或命令表达式。
	apiKey?: string;
	// 默认聊天 API；不自动当成图片或分类 API。
	api?: Api;
	// 可选聊天流函数；注册它必须同时声明 api，才知道何时选用。
	streamSimple?: (
		// 回调收到本次真正选择的聊天模型。
		model: Model<Api>,
		// 输入为模型协议上下文，而非 UI 原始文本。
		context: TranscriptContext,
		// 统一参数选项，允许省略。
		options?: SimpleStreamOptions,
		// 函数返回事件流，不是 Promise<string>。
	) => AssistantMessageEventStream;
	// Partial<Record<...>> 表示按图片 API 名登记部分实现，不要求实现所有图片协议。
	images?: Partial<Record<ImageApi, ProviderImages>>;
	// 分类 API 使用独立实现表，不与聊天 streamSimple 共用。
	classifiers?: Partial<Record<ClassifierApi, ProviderClassifier>>;
	// 提供商级原始请求头配置，可包含 $变量模板和 !命令。
	headers?: Record<string, string>;
	// 是否显式生成 Bearer Authorization；false 不代表提供商不再进行任何认证。
	authHeader?: boolean;
	// 可提供旧式 OAuth 登录与刷新实现，之后统一适配。
	oauth?: ExtensionOAuthConfig;
	// 提供数组意味着替换目录，连空数组也是明确替换；省略数组才保留基线。
	models?: ProviderModelConfig[];
	/** 动态获取扩展目录；返回新数组后，经 publish 发布，不能把开始刷新当成同步目录已更新。 */
	refreshModels?(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;
}

/** 配置来源提示；configured=true 只说明具备配置，不保证命令成功或远端接受凭证。 */
export type AuthStatus = {
	// 布尔值用于界面判断有无配置，和实际 HTTP 成功分开。
	configured: boolean;
	// 来源联合类型限制合法标签；runtime/stored 等由其他运行时入口补充。
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	// 可选可读标签，例如引用了哪几个环境变量。
	label?: string;
};

/** 沿用旧 API 名称，实际指向配置命令缓存清理函数；不是清空持久登录凭证。 */
export const clearApiKeyCache = clearConfigValueCache;

/** 取全能力基线目录；旧 Provider 只有 getModels 时退回聊天目录，没有 Provider 就为空。 */
function getAllProviderModels(provider: Provider | undefined): readonly AnyModel[] {
	// 可选调用 ?.() 处理缺方法，?? 只在无结果时回退，不会把合法空数组换掉。
	return provider ? (provider.getAllModels?.() ?? provider.getModels()) : [];
}

/** 合并兼容选项；顶层后者覆盖，四个指定嵌套字典再合一层，不是通用递归深合并。 */
function mergeCompat(
	// 用索引访问类型复用 Model 的 compat，允许不存在。
	base: Model<Api>["compat"],
	// 覆盖可来自完整模型或 models.json 的局部模型覆盖。
	override: Model<Api>["compat"] | ModelsJsonModelOverride["compat"],
	// 返回值仍与聊天模型 compat 字段一致。
): Model<Api>["compat"] {
	// 没覆盖就返回原引用，不额外分配对象。
	if (!override) return base;
	// 先浅合并；NonNullable 去除类型中的空缺可能，断言不会运行时检查字段。
	const merged = { ...base, ...override } as NonNullable<Model<Api>["compat"]>;
	// 把各 compat 形状视为未知值字典，便于处理下面几项共享的嵌套规则。
	const baseNested = base as Record<string, unknown> | undefined;
	// override 在前面已确认存在。
	const overrideNested = override as Record<string, unknown>;
	// mergedNested 和 merged 指向同一新对象，写前者会反映到返回值，不会改原基线对象。
	const mergedNested = merged as Record<string, unknown>;
	// as const 保留键名联合，只有这四项采用额外一层合并。
	for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"] as const) {
		// 基线该键可能不存在。
		const baseValue = baseNested?.[key];
		// 读取覆盖层对应键。
		const overrideValue = overrideNested[key];
		// 只要任一层的该值是非 null 对象，就执行这一层字典合并。
		if (
			// typeof null 也为 object，因此需同时排除 null。
			(typeof baseValue === "object" && baseValue !== null) ||
			// 覆盖值是对象也会进入，不要求基线本来已有对象。
			(typeof overrideValue === "object" && overrideValue !== null)
		) {
			// 先基线后覆盖；更深层字段仍按整个值替换，不继续递归。
			mergedNested[key] = { ...(baseValue as object | undefined), ...(overrideValue as object | undefined) };
		}
	}
	// 返回合并后的兼容配置。
	return merged;
}

/** 合并输入限制，特别保留未覆盖的 images/resize 子字段；例如只改尺寸，不丢原图片数量上限。 */
function mergeInputLimits(
	// 基线输入限制，可以缺省。
	base: Model<Api>["inputLimits"],
	// 磁盘模型覆盖中的局部限制。
	override: ModelsJsonModelOverride["inputLimits"],
	// 返回的结构继续符合模型 inputLimits 类型。
): Model<Api>["inputLimits"] {
	// 没有覆盖时复用原对象。
	if (!override) return base;
	// 有覆盖时创建新对象，避免改动冻结的文件配置或原模型。
	return {
		// 先展开原顶层限制。
		...base,
		// 再覆盖当前指定的顶层字段。
		...override,
		// 图片子对象有覆盖时才进入更细合并。
		images: override.images
			? {
					// 保留未被覆盖的原图片限制。
					...base?.images,
					// 覆盖图片层提供的字段。
					...override.images,
					// resize 也是嵌套对象，不能被只填一项的新对象整体抹掉。
					resize: override.images.resize
						? // 存在 resize 覆盖就合并其一层字段。
							{ ...base?.images?.resize, ...override.images.resize }
						: // 没给 resize 则沿用基线 resize。
							base?.images?.resize,
				}
			: // 整组 images 没覆盖时保持基线对象。
				base?.images,
	};
}

/** 按思考档位合并采样字典；例：只覆盖 high.temperature，不丢 high 的其他采样项和 low 档位。 */
function mergeSamplingParamsByThinkingLevel(
	// 原始每档采样参数。
	base: Model<Api>["samplingParamsByThinkingLevel"],
	// 本次可选覆盖。
	override: Model<Api>["samplingParamsByThinkingLevel"],
	// 返回同一类档位映射，可缺省。
): Model<Api>["samplingParamsByThinkingLevel"] {
	// 没有覆盖直接返回原值。
	if (!override) return base;
	// 先保留各档位引用，之后只替换有覆盖的档位。
	const merged = { ...base };
	// 逐个已知思考级别处理，不用任意未知字段做新档位。
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
		// 取这一档的覆盖字典。
		const params = override[level];
		// 有字典就按字段合并；空对象也是 truthy，会得到一份浅复制。
		if (params) merged[level] = { ...base?.[level], ...params };
	}
	// 返回新的档位映射。
	return merged;
}

/** 对最终聊天目录应用 modelOverrides；例：只改模型 A 的输出价格，保留其他能力与成本。 */
function applyModelOverride(model: Model<Api>, override: ModelsJsonModelOverride): Model<Api> {
	// 构造新模型，不原地改基线或冻结配置。
	return {
		// 先保留所有模型元数据。
		...model,
		// ?? 只在 null/undefined 时回退，显式空字符串也不会回退；文件 schema 会另外拒绝空名称。
		name: override.name ?? model.name,
		// false 也是有效覆盖，不能用 || 使其回退成原 true。
		reasoning: override.reasoning ?? model.reasoning,
		// 思考映射只覆盖明确给出的键。
		thinkingLevelMap: override.thinkingLevelMap
			? // 对象展开按档位合并，保留原先其他映射。
				{ ...model.thinkingLevelMap, ...override.thinkingLevelMap }
			: // 整项省略时复用原映射。
				model.thinkingLevelMap,
		// 模态数组整体替换，不和原数组去重拼接；as 是编译期断言。
		input: (override.input as ("text" | "image")[] | undefined) ?? model.input,
		// 输入限制按前面 images/resize 的特定层级合并。
		inputLimits: mergeInputLimits(model.inputLimits, override.inputLimits),
		// 有成本覆盖才重建成本对象。
		cost: override.cost
			? {
					// 每个成本项使用 ??，明确零价格不会丢失。
					input: override.cost.input ?? model.cost.input,
					// 输出单价独立覆盖。
					output: override.cost.output ?? model.cost.output,
					// 缓存读取单价独立覆盖。
					cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
					// 缓存写入单价独立覆盖。
					cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
					// 分层价格 tiers 整项替换，不递归按层索引合并。
					tiers: override.cost.tiers ?? model.cost.tiers,
				}
			: // 没覆盖成本就复用原成本对象。
				model.cost,
		// 提示词缓存元数据做一层字典合并，不在这里实际创建缓存。
		promptCache: override.promptCache ? { ...model.promptCache, ...override.promptCache } : model.promptCache,
		// 窗口覆盖不能改变远端实际能力，只改变本地目录认知/预算。
		contextWindow: override.contextWindow ?? model.contextWindow,
		// 输出上限同样用覆盖值或原值。
		maxTokens: override.maxTokens ?? model.maxTokens,
		// 有通用采样覆盖才合并字段。
		samplingParams: override.samplingParams
			? // 相同参数以 override 为准，未给参数保留。
				{ ...model.samplingParams, ...override.samplingParams }
			: // 没给采样覆盖时复用原值。
				model.samplingParams,
		// 按档位另行合并，不把整个映射只做顶层覆盖。
		samplingParamsByThinkingLevel: mergeSamplingParamsByThinkingLevel(
			// 传入模型原档位参数。
			model.samplingParamsByThinkingLevel,
			// 传入文件中的档位覆盖。
			override.samplingParamsByThinkingLevel,
		),
		// 兼容选项沿四个特定嵌套键的规则处理；headers 在请求时另行合成，不在这里写回模型。
		compat: mergeCompat(model.compat, override.compat),
	};
}

/** 把 models.json 的一个定义变成聊天模型；例：省略 api/baseUrl 可借基线，但其他能力字段按定义或固定默认值。 */
function modelFromJson(
	// 提供商 ID 由外层目录决定。
	providerId: string,
	// 已通过文件 schema 的新模型定义。
	definition: ModelsJsonModel,
	// 提供商层的默认 API、地址及兼容配置。
	providerConfig: ModelsJsonProvider,
	// 虽然传入整个基线模型，这里只借其 api 和 baseUrl，不继承所有能力/成本。
	defaults: Model<Api> | undefined,
	// 返回完整聊天 Model，不是局部覆盖对象。
): Model<Api> {
	// 优先级：模型定义 → 提供商文件配置 → 基线；?? 不把其他有值字段视为空。
	const api = definition.api ?? providerConfig.api ?? defaults?.api;
	// 最终仍没有 API 就不能构建可分派的模型。
	if (!api) {
		// 抛配置错误，由调用方在注册/重载时展示。
		throw new Error(
			// 错误点名具体提供商与模型，便于定位。
			`Provider ${providerId}, model ${definition.id}: no "api" specified. Set at provider or model level.`,
		);
	}
	// 地址采用同样的三层优先级。
	const baseUrl = definition.baseUrl ?? providerConfig.baseUrl ?? defaults?.baseUrl;
	// 没有有效地址就拒绝，不能凭空推断一个远端服务地址。
	if (!baseUrl) throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
	// 显式窗口必须为正数；虽然文件 schema 已检查，这里保留原合成函数的数值约束。
	if (definition.contextWindow !== undefined && definition.contextWindow <= 0) {
		// 无效窗口报告模型位置。
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid contextWindow`);
	}
	// 最大输出也保留原正数约束。
	if (definition.maxTokens !== undefined && definition.maxTokens <= 0) {
		// 不自动把负数或零修成默认值掩盖配置问题。
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid maxTokens`);
	}
	// 字段补齐后生成新的目录对象。
	return {
		// 发送给服务端的模型 ID。
		id: definition.id,
		// 名称省略时回退 ID，不借基线显示名。
		name: definition.name ?? definition.id,
		// 把已选协议按 Api 类型使用，as 本身不会查实现注册表。
		api: api as Api,
		// 绑定当前提供商。
		provider: providerId,
		// 属性简写，使用刚确定的地址。
		baseUrl,
		// 定义没给 reasoning 时默认 false，即使借用的基线模型支持思考也不会自动继承。
		reasoning: definition.reasoning ?? false,
		// 思考映射从定义读取。
		thinkingLevelMap: definition.thinkingLevelMap,
		// 输入默认 text，不借基线的图片能力。
		input: (definition.input ?? ["text"]) as ("text" | "image")[],
		// 输入限制直接取定义。
		inputLimits: definition.inputLimits,
		// 成本未填默认全零，是本地目录默认值，不代表服务端免费。
		cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// 提示词缓存字段直接取定义。
		promptCache: definition.promptCache,
		// 未填窗口在这里真正补成 128000；schema Check 本身没有改 parsed 对象。
		contextWindow: definition.contextWindow ?? 128000,
		// 未填输出上限真正补成 16384。
		maxTokens: definition.maxTokens ?? 16384,
		// 通用采样参数取定义。
		samplingParams: definition.samplingParams,
		// 按思考档位的采样参数取定义。
		samplingParamsByThinkingLevel: definition.samplingParamsByThinkingLevel,
		// 原始配置头不放到模型元数据里；之后 rawModelHeaders 在请求认证阶段查找。
		headers: undefined,
		// 提供商兼容默认加模型级覆盖，模型级同字段优先。
		compat: mergeCompat(providerConfig.compat, definition.compat),
	};
}

/** 找用于借 api/baseUrl 的聊天基线：先同 ID，再指定 API，再 openai-completions，最后第一项。 */
function findModelDefaults(models: readonly AnyModel[], modelId: string, api?: Api): Model<Api> | undefined {
	// 先筛 chat，避免同 ID 图片/分类条目被借作聊天基线。
	const chatModels = models.filter((model) => isModelType(model, "chat"));
	// ?? 链按顺序选择首个存在的候选，空数组最后会得到 undefined。
	return (
		// 同 ID 的候选优先级最高。
		chatModels.find((model) => model.id === modelId) ??
		// 给了 API 才按它找，否则这一步跳过。
		(api ? chatModels.find((model) => model.api === api) : undefined) ??
		// 没有精确匹配时优先借 OpenAI completions 兼容模型。
		chatModels.find((model) => model.api === "openai-completions") ??
		// 再没有就用首个聊天模型；这里只选候选，不修改目录。
		chatModels[0]
	);
}

/** 扩展也按类别找基线；例：图片 x 不会借聊天 x 的协议，聊天类别额外偏好 OpenAI completions。 */
function findExtensionModelDefaults(
	// 可能是混合能力目录。
	models: readonly AnyModel[],
	// 扩展模型定义决定应筛哪种类别。
	definition: ProviderModelConfig,
	// 无同类基线时允许返回 undefined，再由构建函数检查是否显式填齐。
): AnyModel | undefined {
	// 未写 type 的旧定义按 chat。
	const type = definition.type ?? "chat";
	// 将候选限制在同一种能力。
	const candidates = models.filter((model) => isModelType(model, type));
	return (
		// 先找同类别同 ID。
		candidates.find((model) => model.id === definition.id) ??
		// 再找同类别同 API。
		(definition.api ? candidates.find((model) => model.api === definition.api) : undefined) ??
		// 只在聊天类别使用 openai-completions 后备，图片和分类不走此偏好。
		(type === "chat" ? candidates.find((model) => model.api === "openai-completions") : undefined) ??
		// 最后返回同类第一项。
		candidates[0]
	);
}

/** 从扩展定义构建任一类别模型；只补协议/提供商/地址，其他必需字段由扩展类型契约提供。 */
function extensionModelFromDefinition(
	// 当前提供商 ID。
	providerId: string,
	// 借默认值使用的现有混合目录。
	models: readonly AnyModel[],
	// 扩展提供商配置，包含可选全局地址和聊天 API。
	config: ProviderConfigInput,
	// 带类别标签的扩展模型定义。
	definition: ProviderModelConfig,
	// 返回 AnyModel 联合类型，下面按标签构造相应分支。
): AnyModel {
	// 省略标签视为聊天，兼容旧扩展。
	const type = definition.type ?? "chat";
	// 按同类别规则选择可能的基线。
	const defaults = findExtensionModelDefaults(models, definition);
	// 模型 API → 仅聊天时采用扩展提供商 API → 同类基线；图片/分类不借聊天默认 API。
	const api = definition.api ?? (type === "chat" ? config.api : undefined) ?? defaults?.api;
	// 三处都没有协议就拒绝。
	if (!api) {
		// 用模型具体位置描述配置缺口。
		throw new Error(
			// 聊天提示可填模型或提供商级，非聊天提示必须在模型级明确协议。
			`Provider ${providerId}, model ${definition.id}: no "api" specified. Set it at model level${type === "chat" ? " or provider level" : ""}.`,
		);
	}
	// 地址则对所有类别采用模型 → 扩展提供商 → 基线。
	const baseUrl = definition.baseUrl ?? config.baseUrl ?? defaults?.baseUrl;
	// 最终地址缺失时不创建半成品模型。
	if (!baseUrl) throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
	// 按 image 标签收窄 definition，可保留图片专属 output 等字段。
	if (definition.type === "image") {
		// 展开定义后覆盖实际协议/提供商/地址；headers 留到请求时单独解析。
		return { ...definition, api: api as ImageApi, provider: providerId, baseUrl, headers: undefined };
	}
	// 分类分支保留分类专有字段。
	if (definition.type === "classifier") {
		// 断言 API 对应分类协议，运行时仍由后续实现表分派。
		return { ...definition, api: api as ClassifierApi, provider: providerId, baseUrl, headers: undefined };
	}
	// 剩余是聊天分支，沿同样补齐规则构造；不自动填省略的扩展能力字段。
	return { ...definition, api: api as Api, provider: providerId, baseUrl, headers: undefined };
}

/** 应用提供商文件配置并 upsert 自定义聊天模型；例：内置 A/B，models 重定义 A，结果仍保留 B。 */
function applyModelsJson(
	// 错误与新目录绑定到当前提供商 ID。
	providerId: string,
	// 内置或底层提供商提供的原始目录。
	baseModels: readonly AnyModel[],
	// 该提供商可能根本没在 models.json 中配置。
	config: ModelsJsonProvider | undefined,
	// 返回新数组，不直接改传入的基线数组。
): AnyModel[] {
	// 没配置就浅复制数组；模型对象可复用。
	if (!config) return [...baseModels];
	// Radius OAuth 的跨字段规则：必须同时给网关 baseUrl。
	if (config.oauth && !config.baseUrl) {
		// schema 只验证字段类型，这里验证两字段之间的组合关系。
		throw new Error(`Provider ${providerId}: "baseUrl" is required when "oauth" is set.`);
	}
	// 非空 modelOverrides 算有效配置；Object.keys 检查它确有条目。
	const hasOverrides = config.modelOverrides && Object.keys(config.modelOverrides).length > 0;
	// 下面全部都没有才判为无实际配置内容；单独 name/api 并不满足这些条件。
	if (
		// 没有非空的自定义聊天模型数组。
		!config.models?.length &&
		// 没有新地址。
		!config.baseUrl &&
		// 没有提供商头；空对象仍为 truthy，会被视作已给配置。
		!config.headers &&
		// 没有兼容选项。
		!config.compat &&
		// 没有非空的模型覆盖。
		!hasOverrides &&
		// 没有提供商 key 表达式。
		!config.apiKey &&
		// 没有 OAuth 配置。
		!config.oauth &&
		// authHeader 只要明确给值就算内容，显式 false 不等于省略。
		config.authHeader === undefined
	) {
		// 完全无有效配置则报错，不静默忽略用户写下的提供商块。
		throw new Error(
			// 保留原错误文本；上面实际可接受的条件还包括 apiKey/oauth/authHeader。
			`Provider ${providerId}: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".`,
		);
	}

	// 先逐个投影基线，后面再 upsert 文件定义。
	const models: AnyModel[] = baseModels.map((model) => {
		// Radius 网关配置不直接覆盖每个底层模型地址；其他提供商可统一换 baseUrl。
		const baseUrl = config.oauth === "radius" ? model.baseUrl : (config.baseUrl ?? model.baseUrl);
		// 聊天模型应用专用兼容选项合并。
		if (isModelType(model, "chat")) return { ...model, baseUrl, compat: mergeCompat(model.compat, config.compat) };
		// Classifier APIs read their own compat fields, such as how a System One service takes images.
		// 分类有自己的兼容选项消费路径，文件提供 compat 时做一层覆盖。
		if (isModelType(model, "classifier") && config.compat) {
			// 这里没有套聊天 mergeCompat 的四嵌套键规则。
			return { ...model, baseUrl, compat: { ...model.compat, ...config.compat } };
		}
		// 其他能力仍可更新地址，但不强塞聊天 compat。
		return { ...model, baseUrl };
	});
	// 省略 models 时循环零次；文件 models 是增补/替换指定聊天项，不会清掉未列出的基线。
	for (const definition of config.models ?? []) {
		// 同类别同 ID 才算待替换项，避免撞到图片/分类 ID。
		const existingIndex = models.findIndex((model) => isModelType(model, "chat") && model.id === definition.id);
		// 找候选仅用于新定义的 api/baseUrl 兜底。
		const defaults = findModelDefaults(models, definition.id, definition.api ?? config.api);
		// 按新模型定义规则构建，不能误当作给旧模型局部 merge。
		const model = modelFromJson(providerId, definition, config, defaults);
		// 命中则在新数组原位置替换这条聊天模型。
		if (existingIndex >= 0) models[existingIndex] = model;
		// 未命中追加，保留其他已存在模型。
		else models.push(model);
	}
	// 这里还没应用 modelOverrides，最终组合流程会在所有目录投影之后只应用一次。
	return models;
}

/** 扩展 models 与文件 models 语义不同：扩展给数组就整表替换；只给 baseUrl 则改现有目录地址。 */
function applyExtension(
	// 当前提供商 ID，用于构建扩展条目。
	providerId: string,
	// 已经经过前一层文件配置的目录。
	models: readonly AnyModel[],
	// 可选扩展覆盖，省略就不更改条目。
	config: ProviderConfigInput | undefined,
	// 返回新目录数组，不改原数组。
): AnyModel[] {
	// 没有扩展就浅复制数组。
	if (!config) return [...models];
	// 只在 models 为 undefined 等假值时保留基线；空数组 [] 是 truthy，会进入整表替换。
	if (!config.models) {
		// 只给地址则对全部类别换地址；! 是非空断言，因为外层条件已检查有 baseUrl，不生成运行时校验。
		return config.baseUrl ? models.map((model) => ({ ...model, baseUrl: config.baseUrl! })) : [...models];
	}
	// 扩展数组每项独立构建，结果不自动追加旧模型；models:[] 会清空这层目录。
	return config.models.map((definition) => extensionModelFromDefinition(providerId, models, config, definition));
}

/** 将旧扩展 OAuth 回调适配新统一接口；例：onAuth 通知变 auth_url，返回凭证补 type=oauth。 */
function adaptOAuth(config: ExtensionOAuthConfig): OAuthAuth {
	// 返回新的 OAuthAuth 外观，不在适配构造阶段登录。
	return {
		// 保留登录方式显示名。
		name: config.name,
		// 保留是否订阅认证的标记。
		isSubscription: config.isSubscription,
		// 真正登录由新接口调用这个异步回调时启动。
		login: async (callbacks) => {
			// 执行扩展的旧登录函数，桥接所需交互能力。
			const credential = await config.login({
				// 授权 URL 通知转换为带 auth_url 标签的统一事件。
				onAuth: (info) => callbacks.notify({ type: "auth_url", ...info }),
				// 设备码通知也加上对应标签。
				onDeviceCode: (info) => callbacks.notify({ type: "device_code", ...info }),
				// 普通输入提示转换为 text 交互。
				onPrompt: (prompt) => callbacks.prompt({ type: "text", ...prompt }),
				// 进度文字转成通知，不等待用户回答。
				onProgress: (message) => callbacks.notify({ type: "progress", message }),
				// 手工验证码走 manual_code 提示，不强制使用本地回调服务器。
				onManualCodeInput: () => callbacks.prompt({ type: "manual_code", message: "Paste the authorization code" }),
				// 选项提示走 select 交互。
				onSelect: (prompt) => callbacks.prompt({ type: "select", ...prompt }),
				// 同一个取消信号传入扩展登录，让扩展能配合停止。
				signal: callbacks.signal,
			});
			// 对象展开后写 type，保证最终按 OAuth 凭证类型发布。
			return { ...credential, type: "oauth" };
		},
		// 刷新也补 OAuth 标签，保留扩展返回的其他凭证字段。
		refresh: async (credential, signal) => ({ ...(await config.refreshToken(credential, signal)), type: "oauth" }),
		// 旧 getApiKey 输出适配为 ModelAuth.apiKey；不在这里负责 token 是否过期的调度。
		toAuth: async (credential) => ({ apiKey: config.getApiKey(credential) }),
	};
}

/** 在已解析认证上合请求头；authHeader=true 时需要非空 key 并写 Authorization: Bearer，缺 key 会抛错。 */
function withConfiguredAuth(
	// 已有请求认证，可带 key/baseUrl/headers。
	auth: ModelAuth,
	// 配置表达式已经被解析成字符串头，再传入此函数。
	headers: Record<string, string> | undefined,
	// 布尔开关选择是否明确构造 Bearer 头，保留原公开内部接口。
	authHeader: boolean,
	// 返回新认证对象，不改原 auth。
): ModelAuth {
	// 只有至少一组头存在时才分配合并字典。
	let mergedHeaders: ProviderHeaders | undefined =
		// 普通对象展开按精确键名覆盖；这个函数本身不折叠头名称大小写。
		auth.headers || headers ? { ...auth.headers, ...headers } : undefined;
	// 仅明确启用 authHeader 时额外生成 Authorization。
	if (authHeader) {
		// 不能把 undefined/空 key 拼成伪认证头，直接报清晰错误。
		if (!auth.apiKey) throw new Error("authHeader requires a resolved API key");
		// 精确名 Authorization 以 Bearer 形式覆盖同名旧值。
		mergedHeaders = { ...mergedHeaders, Authorization: `Bearer ${auth.apiKey}` };
	}
	// 其余 key、baseUrl 等字段保留，只替换 headers。
	return { ...auth, headers: mergedHeaders };
}

/** 选原始 key 表达式：扩展优先于文件；例：扩展给 $B 时不再用文件的 $A。 */
function configuredApiKey(
	// 可选文件配置。
	config: ModelsJsonProvider | undefined,
	// 可选扩展覆盖。
	extension: ProviderConfigInput | undefined,
	// 结果仍是表达式字符串，或者 undefined，并没有真的查环境/运行命令。
): string | undefined {
	// ?? 保留扩展显式空字符串；文件 schema 不允许空 key，但扩展类型 string 没有该长度约束。
	return extension?.apiKey ?? config?.apiKey;
}

/** 合并提供商级原始请求头；相同精确键名扩展覆盖文件，尚不含模型专属头。 */
function configuredHeaders(
	// 文件级 headers 可能没有。
	config: ModelsJsonProvider | undefined,
	// 扩展级 headers 也可省略。
	extension: ProviderConfigInput | undefined,
	// 只有没有两组配置时直接返回 undefined。
): Record<string, string> | undefined {
	// 空对象是有效已给头配置，后面可以得到空字典。
	if (!config?.headers && !extension?.headers) return undefined;
	// 先文件后扩展，尚未展开里面的 $变量或 !命令。
	return { ...config?.headers, ...extension?.headers };
}

/** 为配置模板收集所需环境；显式字段优先，其余向 AuthContext 查询。例：$A/$B 只查尚未显式提供的名字。 */
async function configContextEnv(
	// 输入是一组 key/header 表达式，命令不会被当模板提取变量。
	values: readonly string[],
	// 宿主环境读取能力，可能是异步实现。
	ctx: AuthContext,
	// 可显式继承凭证或已解析认证带来的环境值。
	explicit?: Record<string, string>,
	// Promise 结束后才得到组好的环境字典；也可能没有任何字段。
): Promise<Record<string, string> | undefined> {
	// 浅复制，不原地修改 explicit。
	const env = { ...explicit };
	// flatMap 收集所有引用名，Set 去重，避免相同变量反复向宿主查询。
	for (const name of new Set(values.flatMap(getConfigValueEnvVarNames))) {
		// 只比较 undefined；显式空串这里仍算已提供，而后续模板解析的 || 规则还可能回退进程环境。
		if (env[name] !== undefined) continue;
		// await 宿主查询，不能假定每个值都同步来自 process.env。
		const value = await ctx.env(name);
		// 没有值就不填字段，不用空串掩盖缺失。
		if (value !== undefined) env[name] = value;
	}
	// 至少有一项才返回字典，否则 undefined。
	return Object.keys(env).length > 0 ? env : undefined;
}

/** 组合 API key 登录/检查/解析；存储凭证优先，其次配置表达式，再走基线默认解析，检查与解析不是同一步。 */
function composeApiKeyAuth(
	// 提供商 ID 进入错误定位。
	providerId: string,
	// 基线可能已有 API key 认证能力。
	base: Provider | undefined,
	// 文件可提供 key 与请求头表达式。
	config: ModelsJsonProvider | undefined,
	// 扩展可进一步覆盖 key、头和登录能力。
	extension: ProviderConfigInput | undefined,
	// 只支持 OAuth 且没声明 key 的提供商不会被强加一个 API key 登录方式。
): ApiKeyAuth | undefined {
	// 保存基线 API key 方法，之后可继承其 login/check/resolve。
	const inherited = base?.auth.apiKey;
	// 只选原表达式，不在合成构造时执行配置命令。
	const rawKey = configuredApiKey(config, extension);
	// 判断是否存在 OAuth 能力，决定是否需要生成默认 key 方法。
	const oauth = extension?.oauth ?? base?.auth.oauth;
	// OAuth-only providers get no fabricated API-key login method.
	// 没有原 key 方法和配置 key，但有 OAuth，就不伪造 key 入口。
	if (!inherited && rawKey === undefined && oauth) return undefined;
	// 原始提供商头按文件 → 扩展选取。
	const rawHeaders = configuredHeaders(config, extension);
	// authHeader 扩展优先；?? 保留明确 false，最后默认 false。
	const authHeader = extension?.authHeader ?? config?.authHeader ?? false;
	// 返回认证方法对象，真正输入凭证或解析请求要等调用其中回调。
	return {
		// 原名称优先，否则显示 API key。
		name: inherited?.name ?? "API key",
		// 登录交互优先继承原实现。
		login:
			// 只有原实现缺 login 才用默认询问方式。
			inherited?.login ??
			// async 箭头函数直接返回对象时用括号包对象字面量。
			(async (interaction: AuthInteraction) => ({
				// 给凭证打 api_key 标签，供 CredentialStore 保存。
				type: "api_key",
				// secret 提示请求用户输入；不在构造时自动弹出。
				key: await interaction.prompt({ type: "secret", message: "Enter API key" }),
			})),
		// check 查询配置状态，不在本层直接发送测试模型请求；继承的 check/resolve 实现自行决定额外行为。
		check: async (input) => {
			// 如果调用方已有凭证，先按它处理，不被文件 rawKey 抢走。
			if (input.credential) {
				// 基线提供专用检查时优先用它。
				if (inherited?.check) return inherited.check(input);
				// 没有专用检查但有非空存储 key，按已配置返回，不验证远端接受与否。
				if (input.credential.key) return { type: "api_key", source: "stored credential" };
				// 存储条目没有 key 时可让基线 resolve 从其他来源补认证。
				const resolved = await inherited?.resolve(input);
				// 能解析到结果就标可用并沿用其来源，否则未配置。
				return resolved ? { type: "api_key", source: resolved.source } : undefined;
			}
			// 没有传凭证，但配置了 key 表达式时进入此分支。
			if (rawKey !== undefined) {
				// 命令声明直接视为已配置，不为了列表检查就执行命令。
				if (isCommandConfigValue(rawKey)) return { type: "api_key", source: "configured API key" };
				// 模板路径先收集引用的环境名。
				const envNames = getConfigValueEnvVarNames(rawKey);
				// 逐项查宿主环境，遇缺立即失败。
				for (const name of envNames) {
					// 此检查只把 undefined 视为缺失，空字符串不会在本层被判缺，和真正模板解析规则不完全相同。
					if ((await input.ctx.env(name)) === undefined) return undefined;
				}
				// 所有模板引用都有值，或表达式是纯字面量，就返回配置状态。
				return { type: "api_key", source: "configured API key" };
			}
			// 没有凭证和 rawKey 时仍可借基线检查，例如基线自带环境认证。
			if (inherited?.check) return inherited.check(input);
			// 缺基线 check 时借其解析结果作为判断。
			const resolved = await inherited?.resolve(input);
			// 没解析结果就返回 undefined，不伪造认证来源。
			return resolved ? { type: "api_key", source: resolved.source } : undefined;
		},
		// resolve 才准备实际请求认证，必要时展开模板或执行 !命令。
		resolve: async (input) => {
			// 用可缺省的 AuthResult 保存各来源结果，未完成前不假设有 key。
			let result: AuthResult | undefined;
			// 凭证优先级高于配置 rawKey。
			if (input.credential) {
				// 有基线实现时让它解释存储凭证，可能包含提供商专有请求信息。
				result = inherited
					? // await 等基线认证解析完成。
						await inherited.resolve(input)
					: // 没有基线时必须有非空存储 key 才能构造通用认证。
						input.credential.key
						? // 同时保留凭证 env 及“存储凭证”来源。
							{ auth: { apiKey: input.credential.key }, env: input.credential.env, source: "stored credential" }
						: // 仅有空 key 且没有基线补全时，不能生成有效结果。
							undefined;
				// 没有存储凭证时才解析配置表达式。
			} else if (rawKey !== undefined) {
				// 先通过宿主收集表达式所需模板环境。
				const env = await configContextEnv([rawKey], input.ctx);
				// 严格且无命令缓存地解析 key，缺值抛错，错误说明具体提供商。
				const key = resolveConfigValueOrThrow(rawKey, `API key for provider "${providerId}"`, env);
				// 配置 key 也尽量借基线认证实现，不能只把它当通用字符串而丢提供商语义。
				result = inherited
					? // 把解析出的 key 包成临时 api_key 凭证交给基线，不在此持久保存它。
						await inherited.resolve({ ...input, credential: { type: "api_key", key } })
					: // 没有基线则构造通用请求 key 与来源说明。
						{ auth: { apiKey: key }, source: "configured API key" };
			} else {
				// 也没 rawKey 时，最后尝试基线的默认解析。
				result = await inherited?.resolve(input);
			}
			// 没有结果直接返回，不凭请求头配置伪造一次已成功解析。
			if (!result) return undefined;
			// 原凭证 env 加解析结果 env，同键以后者为准。
			const explicitEnv = { ...(input.credential?.env ?? {}), ...(result.env ?? {}) };
			// 再把请求头表达式需要的变量补齐，已有显式环境优先。
			const headerEnv = await configContextEnv(Object.values(rawHeaders ?? {}), input.ctx, explicitEnv);
			// 严格解析整组头，命令不缓存；任一失败会使本次认证解析拒绝。
			const headers = resolveHeadersOrThrow(rawHeaders, `provider "${providerId}"`, headerEnv);
			// 最后合头与可选 Bearer，保留原 result.env/source 等字段。
			return { ...result, auth: withConfiguredAuth(result.auth, headers, authHeader) };
		},
	};
}

/** 组合 OAuth 方法，保留登录/刷新，只包装 toAuth 以加入文件/扩展头；例：登录 token 转 key 后再加租户头。 */
function composeOAuthAuth(
	// 提供商 ID 仅用于配置错误定位。
	providerId: string,
	// 基线可能带 OAuth 能力。
	base: Provider | undefined,
	// 文件提供头与 Bearer 开关。
	config: ModelsJsonProvider | undefined,
	// 扩展可提供旧 OAuth 配置，优先于基线。
	extension: ProviderConfigInput | undefined,
	// 没有 OAuth 能力时返回 undefined，不编造登录流程。
): OAuthAuth | undefined {
	// 扩展有 OAuth 就适配它，否则沿用基线新接口。
	const oauth = extension?.oauth ? adaptOAuth(extension.oauth) : base?.auth.oauth;
	// 没有来源则提前结束。
	if (!oauth) return undefined;
	// 提供商头仍按扩展覆盖文件合并。
	const rawHeaders = configuredHeaders(config, extension);
	// Bearer 开关保留明确 false。
	const authHeader = extension?.authHeader ?? config?.authHeader ?? false;
	// 浅包装 OAuth 方法对象。
	return {
		// 未覆写的 login/refresh 等沿用原实现。
		...oauth,
		// 请求真正需要认证时调用这个包装后的 toAuth。
		toAuth: async (credential) => {
			// 先完成提供商自己的凭证转换。
			const auth = await oauth.toAuth(credential);
			// OAuthCredentials 可携带扩展字段，其 env 并非预先保证是字符串字典。
			const env = credential.env;
			// 配置头用凭证环境加进程环境按解析器规则展开。
			const headers = resolveHeadersOrThrow(
				// 传入提供商级原始头字典。
				rawHeaders,
				// 错误提示包含提供商位置。
				`provider "${providerId}"`,
				// 扩展凭证字段边界先确认非 null 对象；as 仍不验证其每个值均为字符串。
				typeof env === "object" && env !== null ? (env as Record<string, string>) : undefined,
			);
			// 合并已解析头，并按开关生成 Bearer；失败会向上拒绝。
			return withConfiguredAuth(auth, headers, authHeader);
		},
	};
}

/** 选模型专属原始头：聊天 override → 文件自定义模型 → 同类别同 ID 的扩展定义，后层精确键覆盖。 */
function rawModelHeaders(
	// 必须知道模型类别与 ID，避免图片 x 借到聊天 x 的头。
	model: AnyModel,
	// 文件定义/覆盖只作用于聊天模型。
	config: ModelsJsonProvider | undefined,
	// 扩展定义可以包含多类模型。
	extension: ProviderConfigInput | undefined,
	// 返回的仍是表达式，真正解析由公开 helper 执行。
): Record<string, string> | undefined {
	// models.json definitions and overrides are chat-only. Extension definitions
	// are matched by operation and id so colliding models cannot share headers.
	// 只有聊天模型在文件 models 数组查定义。
	const chatDefinition = isModelType(model, "chat")
		? // find 取第一个 ID 匹配的文件定义。
			config?.models?.find((entry) => entry.id === model.id)
		: // 非聊天模型跳过文件聊天定义。
			undefined;
	// 扩展按类别与 ID 共同匹配。
	const extensionModel = extension?.models?.find(
		// 省略 type 都按 chat，确保同名不同能力不会共享头。
		(entry) => (entry.type ?? "chat") === (model.type ?? "chat") && entry.id === model.id,
	);
	// 头优先级与模型元数据 modelOverrides 的优先级不一样，按这里的对象展开顺序理解。
	const headers = {
		// 最先放文件聊天模型的 override 头。
		...(isModelType(model, "chat") ? config?.modelOverrides?.[model.id]?.headers : undefined),
		// 文件模型定义的同名头覆盖上一层。
		...chatDefinition?.headers,
		// 最后扩展模型定义头再覆盖；尚未加入提供商头。
		...extensionModel?.headers,
	};
	// 没专属头则返回 undefined。
	return Object.keys(headers).length > 0 ? headers : undefined;
}

/** 登记扩展前检查协议与模型组合；例：有 streamSimple 却没 api 立即报错，不等用户第一次请求。 */
export function validateExtensionProvider(
	// 错误归属的提供商 ID。
	providerId: string,
	// 已有基线可用于默认协议/地址。
	base: Provider | undefined,
	// 可能同时存在文件层配置。
	modelsConfig: ModelsJsonProvider | undefined,
	// 待登记的扩展配置，当前还没写进运行时注册表。
	extension: ProviderConfigInput,
	// 只检查并抛错，不返回新 Provider，也不实际发网络请求。
): void {
	// 自定义聊天流必须有明确 API 才能在请求时匹配。
	if (extension.streamSimple && !extension.api) {
		// 保留既有注册规则，避免错误登记覆盖旧配置。
		throw new Error(`Provider ${providerId}: "api" is required when registering streamSimple.`);
	}
	// 实际构建一次层叠目录以发现缺 api/baseUrl 等错误；不在这里测试远端凭证。
	applyExtension(providerId, applyModelsJson(providerId, getAllProviderModels(base), modelsConfig), extension);
}

/** Compose built-in, models.json, and extension layers without reading credentials. */
/** 组合 Provider：基线 → 文件 upsert → 扩展整表替换/地址覆盖 → 旧 OAuth 聊天投影 → 文件 modelOverrides。
 * 例：扩展把 A/B 换为 A/C，文件对 A 的 contextWindow 覆盖仍在最终生效；模型头优先级另看 rawModelHeaders。 */
export function composeModelProvider(
	// 当前注册的提供商 ID。
	providerId: string,
	// 内置或原生扩展 Provider 可缺省。
	base: Provider | undefined,
	// 已读好的不可变文件配置快照，不在这个函数主动读取 auth.json。
	modelConfig: ModelConfig,
	// 可选扩展配置，和原生 Provider 对象不同。
	extension: ProviderConfigInput | undefined,
	// 返回的对象立即可枚举目录，网络/登录只在相应回调调用时发生。
): Provider {
	// 取当前提供商文件块，未配置则 undefined。
	const config = modelConfig.getProvider(providerId);
	// 闭包保存最近发布的旧扩展 OAuth 凭证，供 modifyModels 投影目录。
	let extensionOAuthCredential: OAuthCredentials | undefined;
	// 刷新产生的扩展新目录也在闭包保存；索引访问类型复用 models 的类型。
	let refreshedExtensionModels: ProviderConfigInput["models"];
	// 每次枚举时选最新已发布的扩展目录，而不是固化构造时数组。
	const currentExtension = (): ProviderConfigInput | undefined =>
		// 空数组也 truthy，明确刷新为空同样会替换；没有刷新值才沿用初始 extension。
		extension && refreshedExtensionModels ? { ...extension, models: refreshedExtensionModels } : extension;
	// models.json modelOverrides are the topmost user-config layer: they apply once,
	// after custom-model upserts, extension model replacement, and legacy OAuth projection.
	// 此闭包完整执行目录组合，每次 getModels/getAllModels 都会调用。
	const getAllModels = (): AnyModel[] => {
		// 先做文件层，再做扩展层。
		let models = applyExtension(
			// 将新模型绑定当前提供商。
			providerId,
			// 基线全部能力先应用文件 upsert/地址/compat。
			applyModelsJson(providerId, getAllProviderModels(base), config),
			// 扩展使用当前已发布的目录或初始定义。
			currentExtension(),
		);
		// 只有刷新发布过 OAuth 凭证且旧扩展提供 modifyModels，才应用旧目录投影。
		if (extensionOAuthCredential && extension?.oauth?.modifyModels) {
			// The extension hook is chat-only; other model types pass through untouched.
			// 重建数组，保持非聊天条目经过该钩子时不被改写。
			models = [
				// 旧钩子得到聊天模型数组和当前 OAuth 凭证。
				...extension.oauth.modifyModels(
					// 只把 chat 子集交给旧扩展。
					models.filter((model) => isModelType(model, "chat")),
					// 传入闭包中最近发布的凭证，不在这里主动刷新 token。
					extensionOAuthCredential,
				),
				// 其他能力的模型原样追加回去。
				...models.filter((model) => !isModelType(model, "chat")),
			];
		}
		// 所有模型经过最终映射，检查文件 modelOverrides。
		return models.map((model) => {
			// 按 ID 取覆盖，但下一行还限制必须为聊天模型。
			const override = config?.modelOverrides?.[model.id];
			// 只有聊天项应用最终覆盖；图片/分类同 ID 不借这份聊天配置。
			return override && isModelType(model, "chat") ? applyModelOverride(model, override) : model;
		});
	};
	// Validate eagerly so registration/reload reports structural errors immediately.
	// 构造时先执行一次目录组合，让注册/重载立刻发现结构性错误，不推迟到首个请求。
	getAllModels();
	// 建立 API key 方法外观，尚未执行 login/resolve。
	const apiKey = composeApiKeyAuth(providerId, base, config, extension);
	// 建立 OAuth 方法外观。
	const oauth = composeOAuthAuth(providerId, base, config, extension);
	// 没有任何认证方法时拒绝构造，不编造已登录状态。
	if (!apiKey && !oauth) throw new Error(`Provider ${providerId}: no authentication method configured.`);

	// 判断底层聊天目录是否有支持当前 API 的模型；按 API 匹配，而不是只按模型 ID。
	const supportsBaseApi = (model: Model<Api>) => base?.getModels().some((entry) => entry.api === model.api) ?? false;
	// 内部流分派函数同时服务特定 API 与统一参数入口，保留原 simple 标记的行为。
	const streamWith = (
		// 模型已经是本次要发送的物理聊天模型。
		model: Model<Api>,
		// 模型协议上下文，不由这里重新组系统提示词。
		context: TranscriptContext,
		// 选项可以不存在，或包含特定 API 参数。
		options: StreamOptions | undefined,
		// false 选基线 stream，true 选基线 streamSimple。
		simple: boolean,
		// 立即返回事件流，由 lazyStream 承接异步 setup 与错误。
	): AssistantMessageEventStream =>
		// setup 在调用 lazyStream 时就启动，不等消费者第一次迭代。
		lazyStream(model, async () => {
			// 扩展自定义 streamSimple 的 API 匹配时优先，不论上层从哪种 stream 入口进来。
			if (extension?.streamSimple && model.api === extension.api) {
				// options 按旧扩展统一选项类型转交，断言不在运行时改参数。
				return extension.streamSimple(model, context, options as SimpleStreamOptions);
			}
			// 否则底层 Provider 声明支持这个 API 时，复用它的实现。
			if (base && supportsBaseApi(model)) {
				// 根据入口类型选择相应底层方法。
				return simple
					? // 统一参数入口交给 base.streamSimple。
						base.streamSimple(model, context, options as SimpleStreamOptions)
					: // 特定 API 入口交给 base.stream。
						base.stream(model, context, options);
			}
			// 最后按 API ID 从兼容全局注册器查具体实现。
			const api = getApiProvider(model.api);
			// 没有实现则抛 setup 错误，由外层错误流表达。
			if (!api) throw new Error(`No API provider registered for api: ${model.api}`);
			// 后备 API 同样区分 simple 与 API 专属入口。
			return simple
				? // 统一参数走其 streamSimple。
					api.streamSimple(model, context, options as SimpleStreamOptions)
				: // 特定 API 参数走其 stream。
					api.stream(model, context, options);
		});

	// 组装最终 Provider；不是完整展开原对象，而是逐项选择支持的能力。
	const provider: Provider = {
		// ID 不受扩展显示名影响。
		id: providerId,
		// 显示名依次选扩展、文件、基线、扩展 OAuth 名、ID，和目录优先级分开。
		name: extension?.name ?? config?.name ?? base?.name ?? extension?.oauth?.name ?? providerId,
		// Provider 级地址优先扩展，然后文件，再基线；模型本身还有自己的地址字段。
		baseUrl: extension?.baseUrl ?? config?.baseUrl ?? base?.baseUrl,
		// 这里保留基线 headers；配置头在认证解析中合成，不提前执行表达式。
		headers: base?.headers,
		// 条件对象展开只加入存在的认证方法。
		auth: { ...(apiKey ? { apiKey } : {}), ...(oauth ? { oauth } : {}) },
		// 兼容的聊天枚举入口，从完整目录筛出 chat。
		getModels: () => getAllModels().filter((model) => isModelType(model, "chat")),
		// 完整能力目录使用上面组合闭包。
		getAllModels,
		// 只有需要底层刷新、扩展刷新或旧 OAuth 目录投影时才暴露 refreshModels。
		refreshModels:
			// 任一能力存在即需刷新入口，不表示三者都存在。
			base?.refreshModels || extension?.refreshModels || extension?.oauth?.modifyModels
				? // 异步回调由 Models 的刷新流程调用。
					async (context) => {
						// 先等底层刷新完成，保留其缓存/远端目录逻辑。
						await base?.refreshModels?.(context);
						// NonNullable 去掉 models 的 undefined；局部变量本身仍允许“本轮未刷新”。
						let refreshed: NonNullable<ProviderConfigInput["models"]> | undefined;
						// 扩展有刷新回调时再执行，结果可以是明确空数组。
						if (extension?.refreshModels) refreshed = await extension.refreshModels(context);
						// 等待期间可能被新代次替代或取消，已取消就不发布扩展状态。
						if (context.signal.aborted) return;
						// 只有 OAuth 凭证传给旧 modifyModels；API key 或无凭证时清成 undefined。
						const oauthCredential = context.credential?.type === "oauth" ? context.credential : undefined;
						// 借统一发布闸门校验代次与取消，避免旧任务直接改闭包。
						await context.publish({
							// 此 wrapper 只请求同步 update，不自动把扩展返回数组作为 persist 全文保存。
							update: () => {
								// 数组（包括空数组）都 truthy，有返回值才替换上次发布目录。
								if (refreshed) {
									// Validate before publishing the new synchronous list.
									// 正式换同步目录之前，按与初始注册相同的组合规则再检查新定义。
									applyExtension(providerId, applyModelsJson(providerId, getAllProviderModels(base), config), {
										// 保留扩展现有 API/地址/认证等配置。
										...extension,
										// 仅用刷新结果替换 models。
										models: refreshed,
									});
									// 验证没有抛错才发布为后续枚举看到的扩展数组。
									refreshedExtensionModels = refreshed;
								}
								// 随后更新旧 OAuth 投影用的凭证；不能把开始 refresh 就当成目录已更新。
								extensionOAuthCredential = oauthCredential;
							},
						});
					}
				: // 没有任何相关刷新能力时不提供该方法。
					undefined,
		// 聊天权限筛选沿用基线，扩展替换目录也会经过这个基线过滤入口。
		filterModels: base?.filterModels
			? // 非空断言来自外层存在性条件，Credential | undefined 仍允许无存储凭证。
				(models, credential: Credential | undefined) => base.filterModels!(models, credential)
			: // 没有基线过滤器则保持 undefined。
				undefined,
		// 全能力筛选与聊天筛选单独继承。
		filterAllModels: base?.filterAllModels
			? // 不将聊天过滤器自动套给图片/分类。
				(models, credential: Credential | undefined) => base.filterAllModels!(models, credential)
			: // 缺少全能力筛选时不伪造能力。
				undefined,
		// 特定 API 流入口用 false。
		stream: (model, context, options) => streamWith(model, context, options, false),
		// 统一参数流入口用 true；最终仍走同一个分派闭包。
		streamSimple: (model, context, options) => streamWith(model, context, options, true),
	};

	// 延迟结果能力只从基线显式转接，不靠方法名猜其存在。
	const fetchDeferred = base?.fetchDeferred;
	// 有能力才往结果 Provider 加方法。
	if (fetchDeferred) {
		// 转发模型、远端任务句柄和选项，不在此重建一次任务。
		provider.fetchDeferred = (model, handle, options) => fetchDeferred(model, handle, options);
	}
	// 取消延迟任务也是独立可选能力。
	const cancelDeferred = base?.cancelDeferred;
	// 不能只因支持 fetchDeferred 就假设一定能取消。
	if (cancelDeferred) {
		// 沿基线接口委托取消。
		provider.cancelDeferred = (model, handle, options) => cancelDeferred(model, handle, options);
	}
	// 扩展图片实现按 ImageApi 索引。
	const extensionImages = extension?.images;
	// 基线也可能支持图片生成。
	const generateImages = base?.generateImages;
	// 任一来源存在才暴露 generateImages。
	if (generateImages || Object.keys(extensionImages ?? {}).length > 0) {
		// 调用时按当前模型 API 再选择实现，不只按扩展是否有任意图片能力。
		provider.generateImages = (model, context, options) => {
			// 取这个图片协议的扩展实现。
			const implementation = extensionImages?.[model.api];
			// 匹配的扩展优先于基线。
			if (implementation) return implementation.generateImages(model, context, options);
			// 扩展未覆盖该协议时使用基线方法。
			if (generateImages) return generateImages(model, context, options);
			// 缺匹配实现时返回已完成的 Promise，成功拿到的是错误结果，不是有效图片。
			return Promise.resolve(
				// 错误结果保留模型身份，output 为空并标 stopReason:error。
				imageErrorResult(model, new Error(`Provider ${providerId} has no image implementation for "${model.api}"`)),
			);
		};
	}
	// 分类能力沿相同“扩展按 API 优先，基线后备”的规则。
	const extensionClassifiers = extension?.classifiers;
	// 保存基线分类方法。
	const classify = base?.classify;
	// 只有存在某个分类来源才提供 classify。
	if (classify || Object.keys(extensionClassifiers ?? {}).length > 0) {
		// 实际调用时再根据 model.api 选实现。
		provider.classify = (model, context, options) => {
			// 按分类 API 精确查扩展实现。
			const implementation = extensionClassifiers?.[model.api];
			// 扩展有匹配就直接转发。
			if (implementation) return implementation.classify(model, context, options);
			// 否则借基线分类。
			if (classify) return classify(model, context, options);
			// 都无匹配则给错误结果 Promise，不抛出虚假的成功分类。
			return Promise.resolve(
				// 使用分类结果形状，不复用图片错误结果。
				classifierErrorResult(
					// 结果中的模型身份来自本次分类模型。
					model,
					// 具体说明该提供商缺哪个分类 API 的实现。
					new Error(`Provider ${providerId} has no classifier implementation for "${model.api}"`),
				),
			);
		};
	}

	// 返回已组装对象；目录验证已执行，认证和实际请求留在对应回调。
	return provider;
}

/** 解析模型专属请求头，不包含提供商级头；例：模型定义 X-Tenant=$TENANT，缺值时抛带模型位置的错误。 */
export function resolveConfiguredModelHeaders(
	// 按能力类别、提供商和 ID 定位模型。
	model: AnyModel,
	// 文件头只查聊天定义/覆盖。
	config: ModelsJsonProvider | undefined,
	// 扩展头按同类别同 ID 查。
	extension: ProviderConfigInput | undefined,
	// 可传入认证解析得到的模板环境；不作为 !命令的进程环境覆盖。
	env?: Record<string, string>,
	// 没有任何模型专属头时可返回 undefined，解析失败则抛错。
): Record<string, string> | undefined {
	// 严格解析器不使用命令缓存。
	return resolveHeadersOrThrow(
		// 先组合原始头表达式，优先级看 rawModelHeaders 的实际展开顺序。
		rawModelHeaders(model, config, extension),
		// 错误标出具体提供商/模型位置。
		`model "${model.provider}/${model.id}"`,
		// 将请求本次环境用于模板解析。
		env,
	);
}

/** 旧接口所需的请求配置：可选头及是否要求 Bearer；不等于完整 AuthResult。 */
export interface CompatibilityRequestConfig {
	// 允许 ProviderHeaders 的删除标记，后续 HTTP 适配再消费。
	headers?: ProviderHeaders;
	// 该布尔值始终存在，省略配置时计算成 false。
	authHeader: boolean;
}

/** 旧接口认证缺省时仍可取头和 Bearer 开关；模型专属头优先于提供商头，再覆盖模型已有头。 */
export function resolveCompatibilityRequestConfig(
	// 实际模型可以是任一能力，文件专属头仍限制聊天。
	model: AnyModel,
	// 可选文件配置。
	config: ModelsJsonProvider | undefined,
	// 可选扩展覆盖。
	extension: ProviderConfigInput | undefined,
	// 返回兼容配置，不自动证明请求可用。
): CompatibilityRequestConfig {
	// 严格解析所有配置头，这个入口没有显式 env 参数，模板回退进程环境。
	const configured = resolveHeadersOrThrow(
		// 先提供商级，再模型专属，后者精确键覆盖。
		{ ...configuredHeaders(config, extension), ...rawModelHeaders(model, config, extension) },
		// 错误说明定位模型。
		`model "${model.provider}/${model.id}"`,
	);
	// 返回请求配置对象。
	return {
		// 已解析配置头最后覆盖 model.headers；仍是普通对象精确键名合并。
		headers: model.headers || configured ? { ...model.headers, ...configured } : undefined,
		// 扩展的 authHeader 优先，文件其次，最后 false。
		authHeader: extension?.authHeader ?? config?.authHeader ?? false,
	};
}

/** 显示配置认证来源，不读取凭证存储；例：!命令标已配置但不会试运行，$TOKEN 则检查变量是否齐全。 */
export function configuredRequestAuthStatus(
	// 文件提供的 key 表达式。
	config: ModelsJsonProvider | undefined,
	// 扩展 key 可以覆盖文件。
	extension: ProviderConfigInput | undefined,
	// 没有任何 key 表达式返回 undefined，由 ModelRuntime 再考虑存储/环境等其他来源。
): AuthStatus | undefined {
	// 先按统一优先级选原表达式。
	const value = configuredApiKey(config, extension);
	// 没有表达式不是 configured:false 的唯一来源，交上层继续判断。
	if (value === undefined) return undefined;
	// 命令只要已声明就标配置存在；不会启动命令来检查输出。
	if (isCommandConfigValue(value)) return { configured: true, source: "models_json_command" };
	// 非命令路径提取模板引用的变量名。
	const names = getConfigValueEnvVarNames(value);
	// 有变量时用环境来源标签，即便表达式另外带普通文字。
	if (names.length > 0) {
		// 检查每个变量按解析器规则是否有非空值，不发远端验证请求。
		return isConfigValueConfigured(value)
			? // label 把变量名列给界面，不是把实际 key 内容当标签。
				{ configured: true, source: "environment", label: names.join(", ") }
			: // 任一变量缺失就标未配置。
				{ configured: false };
	}
	// 纯字面量时扩展 key 标 fallback，文件 key 标 models_json_key；空扩展字符串也按这里原规则标已配置。
	return { configured: true, source: extension?.apiKey !== undefined ? "fallback" : "models_json_key" };
}
