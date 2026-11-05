// OpenRouter三种列表转Pi聊天/图片生成/分类目录；价格换算共用运行时目录读取器的helper。
import { type OpenRouterModel, openRouterCost } from "../../src/providers/openrouter-api.ts";
import type { ClassifierModel, ImageModel, Model, ThinkingLevel, ThinkingLevelMap } from "../../src/types.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export interface OpenRouterReasoningMetadata {
	// 是否强制思考、默认状态和原生effort列表；当前转换只读取mandatory/supported_efforts。
	mandatory?: boolean;
	default_enabled?: boolean;
	supported_efforts?: Array<ThinkingLevel | "none">;
	default_effort?: ThinkingLevel | "none";
}

/** Convert OpenRouter's reasoning metadata into Pi model capabilities. */
export function getOpenRouterThinkingLevelMap(
	reasoning: OpenRouterReasoningMetadata | undefined,
): ThinkingLevelMap | undefined {
	// 没元数据则不覆写协议默认，不把未知等同不支持思考。
	if (!reasoning) return undefined;
	// 强制思考但没effort列表也能明确禁off；空数组按没列表处理。
	if (!reasoning.supported_efforts?.length) return reasoning.mandatory === true ? { off: null } : undefined;

	// OpenRouter's supported_efforts uses the same effort values as models.dev reasoning_options,
	// so both sources can share the same Pi thinking-level conversion.
	// 包装成models.dev同形选项，复用档位映射，不修改原数组。
	const map = getEffortThinkingLevelMap([{ type: "effort", values: reasoning.supported_efforts }]);
	// helper无可用档位时仍保留mandatory对off的限制。
	if (!map) return reasoning.mandatory === true ? { off: null } : undefined;
	// 非mandatory明确允许none，即便supported_efforts没列none；这是此来源的转换规则。
	return { ...map, off: reasoning.mandatory === true ? null : "none" };
}

// 扩展共享的id/价格/限额字段；只是HTTP响应预期类型，没有自动运行时校验。
export interface OpenRouterModelListItem extends OpenRouterModel {
	name: string;
	supported_parameters?: string[];
	architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[] };
	reasoning?: OpenRouterReasoningMetadata;
}

export interface OpenRouterCatalog {
	// 索引访问如 OpenRouterCatalog["chat"] 可复用对应数组元素约束。
	chat: Model<"anthropic-messages" | "openai-completions">[];
	images: ImageModel<"openrouter-images">[];
	classifiers: ClassifierModel<"typesafe-system-one">[];
}

// 保留text/image并去重，返回新数组无修改；例["audio","image","image"]→["image"]，缺省→[]。
function modalities(values: string[] | undefined): ("text" | "image")[] {
	return Array.from(
		// filter的value is谓词让TS收窄结果元素联合，实际条件只认这两个字符串；Set保持首次出现顺序。
		new Set((values ?? []).filter((value): value is "text" | "image" => value === "text" || value === "image")),
	);
}

/**
 * Build the OpenRouter catalog from the default listing and the
 * `output_modalities=image` and `output_modalities=decisions` listings. The
 * default listing omits image-only and decision models, so those come from
 * the other listings. An upstream model may appear in several results; it then
 * gets separate entries per operation.
 */
export function buildOpenRouterCatalog(
	listed: readonly OpenRouterModelListItem[],
	imageListed: readonly OpenRouterModelListItem[],
	decisionListed: readonly OpenRouterModelListItem[],
): OpenRouterCatalog {
	// 此函数只转换传入列表、不联网；例同id同时在chat/image列表会得到两种操作条目。
	// 专用images/classifiers内部按id首项去重；聊天列表不在这里去重，后续buildCatalog处理。
	const chat: OpenRouterCatalog["chat"] = [];

	// 遍历默认列表，只把支持tools的条目当聊天模型。
	for (const model of listed) {
		// Only include models that support tools
		// 未提供supported_parameters也算不支持工具，因此跳过。
		if (!model.supported_parameters?.includes("tools")) continue;
		// Parse input modalities
		// 聊天始终有text，旧architecture.modality字符串包含image时再追加看图能力。
		const input: ("text" | "image")[] = ["text"];
		if (model.architecture?.modality?.includes("image")) {
			input.push("image");
		}

		// 思考档位独立由元数据转换，不因支持工具就推定支持思考。
		const thinkingLevelMap = getOpenRouterThinkingLevelMap(model.reasoning);
		// Includes the `~anthropic/claude-*-latest` aliases, which OpenRouter's Messages endpoint accepts.
		// 正则允许~anthropic别名；:batch显式排除Messages端点。
		const useAnthropicMessages = /^~?anthropic\//.test(model.id) && !model.id.endsWith(":batch");
		// 新建目录条目并推入，不改上游model；协议选择同时决定两个不同baseUrl。
		chat.push({
			type: "chat",
			id: model.id,
			name: model.name,
			api: useAnthropicMessages ? "anthropic-messages" : "openai-completions",
			baseUrl: useAnthropicMessages ? "https://openrouter.ai/api" : "https://openrouter.ai/api/v1",
			provider: "openrouter",
			// reasoning标记看参数列表，映射存在时条件展开thinkingLevelMap。
			reasoning: model.supported_parameters?.includes("reasoning") || false,
			...(thinkingLevelMap && { thinkingLevelMap }),
			input,
			// 单token字符串价转换为每百万token费率，缺/坏基础价回退0。
			cost: openRouterCost(model.pricing),
			// 优先top_provider现场限额；||把0也视为缺值，最终4096。
			contextWindow: model.top_provider?.context_length || model.context_length || 4096,
			maxTokens: model.top_provider?.max_completion_tokens || 4096,
		});
	}

	// 图片生成来自单独image列表，不要求支持tools。
	const images: OpenRouterCatalog["images"] = [];
	for (const model of imageListed) {
		// 只对已接纳的图片条目去重；先前不满足模态的条目不会占用id。
		if (images.some((entry) => entry.id === model.id)) continue;
		// 输出必须确实包含image，输入模态可缺、届时用text默认。
		const output = modalities(model.architecture?.output_modalities);
		if (!output.includes("image")) continue;
		const input = modalities(model.architecture?.input_modalities);
		// 明确type:image与openrouter-images协议，和支持看图的chat模型不同。
		images.push({
			type: "image",
			id: model.id,
			name: model.name,
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: input.length > 0 ? input : ["text"],
			output,
			cost: openRouterCost(model.pricing),
		});
	}

	// Decision models such as TypeSafe's Jev are served through OpenRouter's
	// TypeSafe-compatible System One endpoint.
	// decision列表转换成classifier，不走聊天或图片生成入口。
	const classifiers: OpenRouterCatalog["classifiers"] = [];
	for (const model of decisionListed) {
		// 去重并确认上游输出含decisions；可选链允许缺架构时跳过。
		if (classifiers.some((entry) => entry.id === model.id)) continue;
		if (!model.architecture?.output_modalities?.includes("decisions")) continue;
		// 前一个continue已排除缺architecture的情况，TS据此允许直接读其input_modalities。
		const input = modalities(model.architecture.input_modalities);
		// 按System One协议记录，图像放state-image-urls而不发opt-in头。
		classifiers.push({
			type: "classifier",
			id: model.id,
			name: model.name,
			api: "typesafe-system-one",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: input.length > 0 ? input : ["text"],
			cost: openRouterCost(model.pricing),
			contextWindow: model.top_provider?.context_length || model.context_length || 4096,
			// OpenRouter answers TypeSafe `assets` with 200 but drops the images.
			compat: { imageInput: "state-image-urls", sendImageOptInHeader: false },
		});
	}

	// 返回三份新数组，错误字段不在此经过完整schema验证。
	return { chat, images, classifiers };
}

// GET一个指定查询的列表，返回Promise数组；例query="?output_modalities=image"只改变请求URL。
// 非2xx/网络/JSON异常拒绝；缺data回空，但as并不验证data真是模型数组。
async function fetchOpenRouterList(query: string): Promise<OpenRouterModelListItem[]> {
	// query由本模块固定调用点提供，直接拼接，没有参数编码过程。
	const response = await fetch(`${OPENROUTER_MODELS_URL}${query}`);
	// 只检查HTTP成功状态。
	if (!response.ok) throw new Error(`OpenRouter API returned ${response.status}`);
	// 类型断言仅用于静态读取，JSON值可能不符合预期。
	const data = (await response.json()) as { data?: OpenRouterModelListItem[] };
	// null/undefined回空，其他形状不会被这里修正。
	return data.data ?? [];
}

/** Fetch the tool-capable chat, image, and decision listings. */
// 并行抓三列表再转换，返回Promise<OpenRouterCatalog>；任一请求拒绝则整函数拒绝，不返回部分目录。
// 默认列表漏图片专用/decision条目，因此另外发两个query；不是运行模型推理。
export async function fetchOpenRouterCatalog(): Promise<OpenRouterCatalog> {
	// Promise.all保持结果与输入顺序对应；数组解构按顺序给三个变量。
	const [listed, imageListed, decisionListed] = await Promise.all([
		fetchOpenRouterList(""),
		fetchOpenRouterList("?output_modalities=image"),
		fetchOpenRouterList("?output_modalities=decisions"),
	]);
	// 所有请求成功后才统一过滤/映射。
	return buildOpenRouterCatalog(listed, imageListed, decisionListed);
}
