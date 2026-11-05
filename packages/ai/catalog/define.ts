// 模型目录构建的共同类型和小工具：供应商声明先产出数据，再由 build.ts 合并规则；本文件不发模型请求。
// import type 只供 TypeScript 检查，运行时被擦除；Api 等类型的声明并不验证远端 JSON。
import type {
	Api,
	ClassifierApi,
	ClassifierModel,
	ImageApi,
	ImageModel,
	KnownApi,
	Model,
	ModelInputLimits,
	ThinkingLevelMap,
} from "../src/types.ts";
import type { CatalogSources } from "./sources/index.ts";
import { type ModelsDevModel, modelsDevChatModels, modelsDevCost } from "./sources/models-dev.ts";

// 泛型 Model<Api> 允许各聊天协议；这个别名没有图片生成/分类模型的专用字段。
export type ChatModel = Model<Api>;
// 索引访问取某协议的 compat 类型；NonNullable 去掉可选字段的 undefined/null，只约束编译期。
export type ModelCompat<TApi extends Api> = NonNullable<Model<TApi>["compat"]>;

/**
 * Compat defaults per API. They sit under each model's own compat, so model
 * values win. A function receives the model to vary defaults by model.
 */
export type ApiCompatDefaults = {
	// 映射类型逐个 KnownApi 生成可选键；值可以是固定配置，也可以是按该协议模型计算配置的函数。
	[TApi in KnownApi]?: ModelCompat<TApi> | ((model: Model<TApi>) => ModelCompat<TApi>);
};

/** Passed to every provider hook. */
export interface ProviderContext {
	/** The provider being built. */
	readonly providerId: string;
	// 预先加载的上游目录；readonly 只禁止重新赋这个属性，内部对象不是深冻结。
	readonly sources: CatalogSources;
	/** Fail instead of degrading when upstream data is unexpected. */
	readonly strict: boolean;
	/** Copies of another provider's chat models before shared rules run. */
	providerModels(providerId: string): ChatModel[];
	/** The models.dev entry a model was built from, if it was recorded. */
	modelsDevSource(model: ChatModel): ModelsDevModel | undefined;
	/** Record the models.dev entry so shared rules can use its reasoning metadata. */
	recordModelsDevSource(model: ChatModel, source: ModelsDevModel): void;
}

/**
 * One built-in provider's catalog. The build runs, in order:
 * 1. `models()`: upstream models plus authored ones, with data corrections.
 * 2. `compat` defaults and the shared model-family rules in `families/`.
 * 3. `finalize()`: provider-specific behavior that must win over shared rules.
 * 4. Shared normalization (image input limits), then `finalizeAll()`.
 */
export interface ProviderDefinition {
	// Pi 的供应商身份，不一定等于 models.dev 使用的供应商键。
	id: string;
	// 方法名后的 ? 表示可省略；模型数组是构建输入，不是现场调用 API 的结果。
	models?(ctx: ProviderContext): ChatModel[];
	// 专用图片生成/分类目录，各自使用对应 Api 泛型，不混作聊天模型。
	images?(ctx: ProviderContext): ImageModel<ImageApi>[];
	classifiers?(ctx: ProviderContext): ClassifierModel<ClassifierApi>[];
	// 默认 compat 在单个模型已有值下面合并，因此已有值优先。
	compat?: ApiCompatDefaults;
	// 两个收尾钩子返回 void，意味着直接修改传入模型；单条之后才做整组收尾。
	finalize?(model: ChatModel, ctx: ProviderContext): void;
	finalizeAll?(models: ChatModel[], ctx: ProviderContext): void;
}

// 为对象字面量提供 ProviderDefinition 类型检查，再原样返回同一引用；无校验/注册/I/O。
// 例 defineProvider({ id: "demo", models: () => [] }) 只构造声明，真正运行 models 要等 buildCatalog。
export function defineProvider(definition: ProviderDefinition): ProviderDefinition {
	// 不复制也不冻结，调用方后续仍可改这份对象。
	return definition;
}

/** Shallow-merge compat flags into a model. */
// 把第二个参数浅合入 model.compat，返回 void 并改变模型；例旧 supportsStore:true 遇新 false 会被覆盖。
// TApi extends Api 限制协议泛型；as 处理条件类型合并的表达限制，不增加运行校验，嵌套对象不递归合并。
export function mergeCompat<TApi extends Api>(model: Model<TApi>, compat: ModelCompat<TApi>): void {
	// 对象展开从左到右覆盖同名键；undefined 的旧 compat 可直接展开。
	model.compat = { ...model.compat, ...compat } as ModelCompat<TApi>;
}

/** Shallow-merge thinking level mappings into a model. Later values win. */
// 合并思考档位并修改模型，不返回新模型；例 {low:"low"} 再合 {low:null} 会明确禁用 low。
// 未提供的键保留旧值；null 表示不支持，缺键由请求适配器采用默认规则。
export function mergeThinking(model: ChatModel, map: ThinkingLevelMap): void {
	// 每次创建新的映射外壳，后写的 map 键覆盖原映射对应键。
	model.thinkingLevelMap = { ...model.thinkingLevelMap, ...map };
}

/** Provider input limits for image-capable models. Limits the model already carries take precedence. */
// 为可看图的聊天模型补输入限制，返回 void、修改模型；例默认 images.maxPerRequest=100 不会盖掉模型已有的 20。
// 文本模型直接跳过；顶层和 images 分别浅合并，更深层（如 resize）仍按整字段覆盖。
export function withInputLimits(model: ChatModel, limits: ModelInputLimits): void {
	// includes 查目录声明的模态，不探测真实服务是否接受图片。
	if (!model.input.includes("image")) return;
	// 先放默认再放模型自身值，保留它更具体的限制。
	model.inputLimits = {
		...limits,
		...model.inputLimits,
		// 可选链在原 inputLimits 缺失时给 undefined，不触发属性访问错误。
		images: { ...limits.images, ...model.inputLimits?.images },
	};
}

/** Add models only when upstream has not listed them (yet). */
// 按 id 给可变 models 数组补缺项并返回同一数组；例已有 a，再补 a/b，最终只增加 b。
// additions 是只读数组视图，元素本身不克隆；重复 additions 的后项也会因前项已推入而跳过。无 I/O。
export function addMissing(models: ChatModel[], additions: readonly ChatModel[]): ChatModel[] {
	// for...of 依次取得每条候选模型，不是数组索引。
	for (const addition of additions) {
		// some 回调有任意同 id 即 true；不存在才 push，因此已有元数据优先。
		if (!models.some((model) => model.id === addition.id)) models.push(addition);
	}
	// 返回可供继续 map 的原数组，而非副本。
	return models;
}

export interface ModelsDevOptions<TApi extends Api> {
	// 必选协议和基础地址决定映射的 Model<TApi>；不会由声明自动创建 HTTP 客户端。
	api: TApi;
	baseUrl: string;
	// 可选兼容项/请求头在创建每个模型时浅复制。
	compat?: ModelCompat<TApi>;
	headers?: Record<string, string>;
	/** Only models models.dev lists on this API protocol (e.g. "responses"). */
	protocol?: string;
	/** Skip models models.dev marks deprecated. */
	skipDeprecated?: boolean;
	/** Expose models.dev effort levels through the shared rules. Defaults to true. */
	recordReasoning?: boolean;
	/** Fallback limits when models.dev has none. Defaults to 4096 each. */
	defaultContextWindow?: number;
	defaultMaxTokens?: number;
	/** Extra filter. Models without tool support are always skipped. */
	include?(source: ModelsDevModel): boolean;
	/** Adjust or replace the mapped model. Return undefined to skip it. */
	map?(model: Model<TApi>, source: ModelsDevModel): ChatModel | undefined;
}

/** Map one models.dev provider's tool-capable chat models onto pi models. */
// 从 ctx 已加载目录选 sourceProvider 的聊天模型，过滤后转换为 Pi 数组；不发网络，也不改上游对象。
// options 可再过滤/替换，返回 undefined 表示丢弃；默认登记原始来源供共享 effort 规则读取。
// 例某来源没有工具能力，即使 include 返回 true 仍被跳过；contextWindow=0 会因 || 被当缺值，回退到配置或 4096。
// 泛型只检查传入协议与 compat 关系，未知远端字段并未在本函数被完整 schema 校验。
export function modelsDevModels<TApi extends Api>(
	ctx: ProviderContext,
	sourceProvider: string,
	options: ModelsDevOptions<TApi>,
): ChatModel[] {
	// 明确元素类型，收集经过 map 之后的结果。
	const models: ChatModel[] = [];
	// modelsDevChatModels 先排除非 chat 类型，并把 v2 字段规范成统一来源形状。
	for (const source of modelsDevChatModels(ctx.sources.modelsDev, sourceProvider)) {
		// 没工具能力的来源始终丢弃，continue 进入下一条。
		if (!source.toolCall) continue;
		// 指定 protocol 时至少一条上游 API 必须匹配；some 回调只读条目。
		if (options.protocol && !source.apis.some((api) => api.protocol === options.protocol)) continue;
		// 只有调用者启用 skipDeprecated 才过滤 deprecated 状态。
		if (options.skipDeprecated && source.status === "deprecated") continue;
		// 可选额外谓词被调用一次，false 丢弃；异常会向调用者传播。
		if (options.include && !options.include(source)) continue;
		// 新建基础模型；属性简写/对象字面量只装数据，不校验服务可调用性。
		const base: Model<TApi> = {
			// 原始 id 不改名，空 name 用 id；|| 同样把空串当缺值。
			id: source.id,
			name: source.name || source.id,
			// 输出供应商始终用当前 ctx 身份，允许上游键与 Pi id 不同。
			api: options.api,
			provider: ctx.providerId,
			baseUrl: options.baseUrl,
			reasoning: source.reasoning,
			// 三元表达式根据 imageInput 选择支持模态，文本始终包含。
			input: source.imageInput ? ["text", "image"] : ["text"],
			// 价格转换保留上下文阶梯；缺少的基础费率在 helper 内补 0。
			cost: modelsDevCost(source.cost),
			// || 按真值依次选上游值、调用者默认和 4096，不是仅判断 undefined。
			contextWindow: source.contextWindow || options.defaultContextWindow || 4096,
			maxTokens: source.maxTokens || options.defaultMaxTokens || 4096,
			// 条件对象展开只在配置存在时加入字段，并分别复制 headers/compat 外壳。
			...(options.headers ? { headers: { ...options.headers } } : {}),
			...(options.compat ? { compat: { ...options.compat } } : {}),
		};
		// map 可原地改 base、返回替代模型或 undefined；没提供时保留 base。
		const model = options.map ? options.map(base, source) : base;
		// map 返回 undefined 时不登记来源也不输出模型。
		if (!model) continue;
		// 只有明确 false 才禁用来源登记，缺省为启用。
		if (options.recordReasoning !== false) ctx.recordModelsDevSource(model, source);
		// 推入最终对象引用，未对每个嵌套属性深克隆。
		models.push(model);
	}
	// 空目录或全部被过滤时自然返回空数组。
	return models;
}
