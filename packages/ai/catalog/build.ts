// 把供应商声明与已抓取的上游数据组装成三类目录；先缓存原始聊天模型，再按固定次序应用共享与供应商规则。
import type {
	AnyModel,
	Api,
	ClassifierApi,
	ClassifierModel,
	ImageApi,
	ImageModel,
	KnownApi,
	Model,
	OpenAICompletionsCompat,
} from "../src/types.ts";
import type { ApiCompatDefaults, ChatModel, ProviderContext, ProviderDefinition } from "./define.ts";
import { mergeThinking } from "./define.ts";
import { applyClaudeFamilyRules } from "./families/anthropic.ts";
import { applyDeepSeekCompatRules, applyDeepSeekFamilyRules } from "./families/deepseek.ts";
import { applyOpenAiFamilyRules } from "./families/openai.ts";
import { getEffortThinkingLevelMap } from "./reasoning.ts";
import type { CatalogSources } from "./sources/index.ts";
import type { ModelsDevModel } from "./sources/models-dev.ts";

export interface ProviderCatalog {
	// 交叉类型 & 要求每条聊天模型明确带 type:"chat"，便于公共混合目录区分用途。
	chat: (Model<Api> & { type: "chat" })[];
	// 图片生成和分类模型不参加聊天模型的兼容/思考规则。
	image: ImageModel<ImageApi>[];
	classifier: ClassifierModel<ClassifierApi>[];
}

// Keep the generated default no less restrictive than coding-agent's historical
// image preprocessing. Provider limits can narrow this profile, but unknown
// providers retain the cache-safe 2000px / 4.5 MiB behavior.
const DEFAULT_IMAGE_RESIZE = {
	// 像素边长、字节数、JPEG质量是预处理元数据，写进目录本身不执行图片缩放。
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: 4.5 * 1024 * 1024,
	jpegQuality: 80,
} as const;

// 用 provider/id 组成来源表的键，无副作用；Pick 仅要求这两字段。例如 p/a 得到 p:a，不对冒号转义。
function modelKey(model: Pick<AnyModel, "provider" | "id">): string {
	// 模板字符串插入身份文字，不生成 URL。
	return `${model.provider}:${model.id}`;
}

// 按模型协议取默认兼容配置，返回 void 并修改模型；没有该协议配置时直接结束。
// 默认可为函数；例默认 supportsStore:false 与模型已有 true 合并后仍为 true。函数异常向外传播。
function applyCompatDefaults(model: ChatModel, defaults: ApiCompatDefaults | undefined): void {
	// 可选链允许整个 defaults 缺失；as 把映射类型视作统一值/回调联合，不验证任意 API 字符串。
	const entry = defaults?.[model.api as KnownApi] as
		| Model<Api>["compat"]
		| ((model: Model<Api>) => Model<Api>["compat"])
		| undefined;
	// 没默认值就不创建 compat 字段。
	if (!entry) return;
	// typeof 在此区分配置联合的函数/对象两种合法成员，不是额外校验已知参数形状。
	const compat = typeof entry === "function" ? entry(model) : entry;
	// 原模型配置放后面，因此具体条目优先于供应商默认。
	model.compat = { ...compat, ...model.compat } as Model<Api>["compat"];
}

/** Whether the model's API sends models.dev effort values to the host as-is. */
// 判断该协议/配置是否原样发送 effort，返回 boolean、不修改输入；例 deepseek thinkingFormat 不走原生 effort 规则。
// 这里只检查目录已有标记，不向远端试探支持程度；缺省 Completions 格式按 openai、支持 effort 按 true。
function sendsNativeEffort(model: ChatModel): boolean {
	// Anthropic 只有自适应思考才使用 effort 元数据，普通预算模式不适用。
	if (model.api === "anthropic-messages") {
		return (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking === true;
	}
	// 三种 Responses 协议都可读取此类 effort。
	if (
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses"
	) {
		// 任一 Responses 分支满足就结束判断。
		return true;
	}
	// 其余协议中只继续处理 Chat Completions。
	if (model.api !== "openai-completions") return false;
	// ?? 仅在 null/undefined 时补空对象，不替换显式 false 配置。
	const compat: OpenAICompletionsCompat = (model as Model<"openai-completions">).compat ?? {};
	// && 要求格式与支持标记同时满足。
	return (compat.thinkingFormat ?? "openai") === "openai" && (compat.supportsReasoningEffort ?? true);
}

// 从已登记的来源提取 effort 并浅合到模型，返回 void；例来源支持 high/none 则生成 high 与 off:"none" 等键。
// 没来源或协议不发送原生 effort 时不改；并非一次新的上游请求。
function applyModelsDevEffort(model: ChatModel, source: ModelsDevModel | undefined): void {
	// 可选链把缺来源/缺选项处理为无操作，|| 短路避免后续不必要转换。
	if (!source?.reasoningOptions || !sendsNativeEffort(model)) return;
	// helper 忽略不能映射到 Pi 档位的 default/null 值。
	const map = getEffortThinkingLevelMap(source.reasoningOptions);
	// 只在存在可用映射时覆盖同名档位。
	if (map) mergeThinking(model, map);
}

// 给任意看图模型补 resize 默认值，返回 void 并修改 inputLimits；例已有 maxWidth:1000 保留，缺 maxHeight 补2000。
// 不缩放真实图片，原有 images 其他限制保留；文本模型跳过。
function applyImageResizeDefaults(model: AnyModel): void {
	// 目录输入不含 image 则没有图片预处理规则要补。
	if (!model.input.includes("image")) return;
	// 暂存旧 images，后面新建外壳时还能保留其 resize 字段。
	const images = model.inputLimits?.images;
	// 顶层已有输入限制不丢失；resize 以模型更具体的值为准。
	model.inputLimits = {
		...model.inputLimits,
		images: { ...images, resize: { ...DEFAULT_IMAGE_RESIZE, ...images?.resize } },
	};
}

/** Build every provider's catalog from the fetched sources. */
// 输入有序供应商声明、已加载来源和严格模式，输出 provider→三类目录；过程会改声明 hooks 产出的模型并可能抛构建错误。
// 先建立聊天模型依赖缓存（供 Azure 等克隆 OpenAI），再去重、默认兼容→家族规则→单条收尾→图片默认→整组收尾。
// 例 A.models 调 ctx.providerModels("B") 可提前构建 B，获得共享规则之前的深克隆；A→B→A 的循环会抛错。
// 无文件/网络 I/O；hooks 自身若有副作用或抛错会直接影响构建，strict 通过 ctx 交各供应商解释。
export function buildCatalog(
	definitions: readonly ProviderDefinition[],
	sources: CatalogSources,
	strict: boolean,
): Record<string, ProviderCatalog> {
	// map 回调产出 [id,definition] 键值对；Map 重复 id 会采用最后一条声明，没有单独拒绝重复声明。
	const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
	// 来源记录按 provider:id 关联，替换模型对象后仍可查同身份元数据。
	const modelsDevSources = new Map<string, ModelsDevModel>();
	// stageOne 缓存仅 models hook 的产物；building 记录当前递归链上的供应商以检查依赖环。
	const stageOne = new Map<string, ChatModel[]>();
	const building = new Set<string>();

	// 为一个供应商创建 hooks 上下文，返回新对象并闭包引用本次构建的缓存；不读取全局状态。
	// 例 ctx.providerModels("openai") 返回深克隆，后续改 Azure 字段不会连带改 OpenAI 原模型。
	function context(providerId: string): ProviderContext {
		// 属性简写直接传当前 id、共享来源和 strict，并提供三个操作回调。
		return {
			providerId,
			sources,
			strict,
			// 箭头函数先按需构建依赖，再 structuredClone；来源表本身不随克隆复制。
			providerModels: (id) => structuredClone(buildModels(id)),
			// 读取已登记的规范来源，找不到时为 undefined。
			modelsDevSource: (model) => modelsDevSources.get(modelKey(model)),
			// 登记同身份来源会覆盖旧值，供后续共享 effort 规则读取。
			recordModelsDevSource: (model, source) => {
				modelsDevSources.set(modelKey(model), source);
			},
		};
	}

	// 构建并缓存单个供应商的第一阶段聊天数组；已有缓存直接复用，未知 id/递归依赖/错 provider 抛 Error。
	// 例 B 先作为 A 的依赖构建后，主循环再遇 B 就不重复运行 B.models；成功才写缓存。
	function buildModels(providerId: string): ChatModel[] {
		// 空数组也是真值，所以无模型的供应商一样能命中缓存。
		const built = stageOne.get(providerId);
		if (built) return built;
		// 由 id 找声明；缺失与依赖环都在调用 hook 之前拒绝。
		const definition = definitionsById.get(providerId);
		if (!definition) throw new Error(`Unknown provider: ${providerId}`);
		if (building.has(providerId)) throw new Error(`Provider ${providerId} depends on itself`);
		// 将 id 加入递归链；hook 抛错时整个构建退出，并没有 finally 清除此集合。
		building.add(providerId);
		// ?. 只在 models 方法存在时调用，?? 把缺 hook 的结果补为空列表。
		const models = definition.models?.(context(providerId)) ?? [];
		// hook 正常返回后离开当前递归链。
		building.delete(providerId);
		// 运行规则要求：每条聊天模型的 provider 必须归当前声明，类型 string 本身无法保证。
		for (const model of models) {
			if (model.provider !== providerId) {
				throw new Error(`${providerId} produced ${modelKey(model)} for another provider`);
			}
		}
		// 身份检查全部通过才把原数组记入缓存。
		stageOne.set(providerId, models);
		return models;
	}

	// 按声明顺序确保全部第一阶段完成；依赖可能更早被递归创建。
	for (const definition of definitions) buildModels(definition.id);

	// 返回对象按定义顺序插入供应商键，内容会在以下第二阶段逐组填好。
	const catalogs: Record<string, ProviderCatalog> = {};
	for (const definition of definitions) {
		// 为本供应商准备上下文、输出数组与 id 去重集合。
		const ctx = context(definition.id);
		const chat: ChatModel[] = [];
		const seen = new Set<string>();
		// 取第一阶段列表，去重保留同 id 的第一项；没有跨模型种类去重。
		for (const model of stageOne.get(definition.id) ?? []) {
			// The first source listing a model wins.
			if (seen.has(model.id)) continue;
			// 先记 id，再把同一对象引用加入聊天输出数组。
			seen.add(model.id);
			chat.push(model);
		}

		// 顺序是行为的一部分，后面规则可覆盖前面的 compat/思考映射。
		for (const model of chat) {
			// 供应商默认在已有模型配置之下；DeepSeek 协议修正需先于判断原生 effort。
			applyCompatDefaults(model, definition.compat);
			applyDeepSeekCompatRules(model);
			// 来源 effort 之后应用三家族规则，统一各托管平台的公共能力事实。
			applyModelsDevEffort(model, ctx.modelsDevSource(model));
			applyOpenAiFamilyRules(model);
			applyClaudeFamilyRules(model);
			applyDeepSeekFamilyRules(model);
		}
		// 单条供应商收尾在共享规则之后，能明确覆盖共享默认。
		for (const model of chat) definition.finalize?.(model, ctx);
		// 收尾完成后清掉空兼容壳，再补可看图模型的预处理默认。
		for (const model of chat) {
			if (model.compat && Object.keys(model.compat).length === 0) delete model.compat;
			applyImageResizeDefaults(model);
		}
		// 最后一次整组处理可建立如 Anthropic 回退模型的跨条目关系。
		definition.finalizeAll?.(chat, ctx);

		// 专用图片目录只补 resize 默认，分类目录在这里没有额外默认规则。
		const image = definition.images?.(ctx) ?? [];
		for (const model of image) applyImageResizeDefaults(model);
		const classifier = definition.classifiers?.(ctx) ?? [];
		// 新目录外壳：聊天模型浅复制并写明确种类，嵌套 cost/compat 等仍沿用引用。
		catalogs[definition.id] = {
			chat: chat.map((model) => ({ ...model, type: "chat" as const })),
			image,
			classifier,
		};
	}
	// 全部供应商成功后才返回；任一 hook 抛错则调用方得不到部分结果。
	return catalogs;
}
