// models.dev v2 数据的局部类型与规范化：只读取本目录需要的字段，并转换费用和思考元数据。
// 这些接口不是远端 JSON 的完整运行时 schema；下方可选链/typeof 只处理实际写出的少量边界。
import type { ModelCost } from "../../src/types.ts";

// models.dev v2 catalog. The schema is published as experimental, so everything
// the catalog reads goes through `normalizeModelsDevModel()` below.
// https://github.com/anomalyco/models.dev/blob/dev/packages/core/src/schema-v2.ts
export const MODELS_DEV_URL = "https://models.dev/experimental/v2.0/api.json";
// v2 has no provider-agnostic decision metadata endpoint; v1 still serves it.
export const MODELS_DEV_DECISIONS_URL = "https://models.dev/models.json?type=decision";

// 以 type 区分的联合：开关、强度列表、token预算三种选项；只有 effort 分支带 values。
export type ModelsDevReasoningOption =
	| { type: "toggle" }
	| {
			type: "effort";
			values: Array<"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default" | null>;
	  }
	| { type: "budget_tokens"; min?: number; max?: number };

// Extract 选出 effort 成员，["values"][number] 取数组元素联合，含 default 和 JSON null。
type ModelsDevEffort = Extract<ModelsDevReasoningOption, { type: "effort" }>["values"][number];

// ? 表示价格字段可缺失；写入价格可以是单价或按缓存寿命命名的单价表。
interface V2CachePrices {
	read?: number;
	write?: number | Record<string, number>;
	explicit?: { read?: number; write?: number | Record<string, number> };
}

// when 的值是 unknown，因为可能有 Pi 尚不能表达的条件；不是任意条件都可转换成上下文价格档。
interface V2CostOverride {
	when: Record<string, unknown>;
	price?: number;
	cache?: V2CachePrices;
}

// 输入和输出各自声明单位、基础价和覆盖；只处理 text/token 计价，不换算图片/时长等单位。
interface V2ModalityCost {
	input?: { unit?: string; price: number; cache?: V2CachePrices; overrides?: V2CostOverride[] };
	output?: { unit?: string; price: number; overrides?: V2CostOverride[] };
}

// 上游一个协议入口：base_url 是实际服务根，aisdk 仅作为某些提供方修正规则的元数据。
interface V2ApiEntry {
	base_url: string;
	path?: string;
	sdk?: { aisdk?: string };
	compatibility?: Record<string, unknown>;
	capabilities?: Record<string, unknown>;
}

/** The subset of a models.dev v2 model the catalog reads. */
export interface ModelsDevV2Model {
	// 原始身份、种类、显示名和可选状态；type 为 string，静态类型本身不保证等于 chat。
	id: string;
	type: string;
	name: string;
	status?: string;
	// 模态用上游原始字符串，后面 image/* 也可归一为 image。
	modalities: { input: string[]; output: string[] };
	// 原始能力：工具、思考支持和可选思考控制；不因 interface 写必选就证明 HTTP 真有字段。
	capabilities: {
		tools: { supported: boolean };
		reasoning: {
			supported: boolean;
			toggle?: boolean;
			effort?: ModelsDevEffort[];
			budget?: { min?: number; max?: number };
		};
		structured_output?: boolean;
	};
	// Pi 规范化读取 context/output，input 子限制暂不单独保留。
	limit?: { context?: number; input?: number; output?: number };
	cost?: { text?: V2ModalityCost };
	api: Record<string, V2ApiEntry>;
}

// Record 将供应商键映到模型字典；没有 models 的供应商在读取时当空列表。
export type ModelsDevV2Catalog = Record<string, { models?: Record<string, ModelsDevV2Model> }>;

/** Prices as models.dev lists them. Missing prices stay undefined. */
export interface ModelsDevCost {
	// 这四项可缺；还未在此层补免费默认，避免供应商无法辨别上游没报价与明确0。
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** Context-size tiers. Unlisted rates fall back to the base rates. */
	tiers?: Array<{ above: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>;
}

/** One API a model is served on, in the order models.dev lists them. */
export interface ModelsDevApi {
	// 协议名和基址从对象键/base_url 映来，顺序采用 Object.entries 枚举顺序。
	protocol: string;
	baseUrl: string;
	aisdk?: string;
}

/** A models.dev model normalized for the catalog. */
export interface ModelsDevModel {
	// 从原条目抄入的身份信息。
	id: string;
	name: string;
	type: string;
	status?: string;
	// 扁平化能力标记，给供应商过滤用；不是一次现场能力探测。
	toolCall: boolean;
	structuredOutput: boolean;
	reasoning: boolean;
	/** Undefined when the model does not reason. */
	reasoningOptions?: ModelsDevReasoningOption[];
	// 模态和限额、成本、入口是规范结果；source 保留原对象供特殊修正读取。
	imageInput: boolean;
	textInput: boolean;
	textOutput: boolean;
	contextWindow?: number;
	maxTokens?: number;
	cost: ModelsDevCost;
	apis: ModelsDevApi[];
	/** The full v2 entry, for fields not normalized above. */
	source: ModelsDevV2Model;
}

/** Provider-agnostic decision model metadata from models.dev. */
export interface ModelsDevDecisionMetadata {
	// v1 decision 元数据只用名字、种类、上下文，不承诺含直接提供方价格。
	id: string;
	type?: string;
	name: string;
	limit?: { context?: number };
}

// 从数字/价格字典取一个价格，缺省返回 undefined；例 {"5m":1,"1h":2} 取枚举的第一个值1，不按TTL大小排序。
// 仅区分合法类型联合的 object 分支；若外部 JSON 给了 null，本函数没有单独保护，Object.values 会抛错。
function firstPrice(write: number | Record<string, number> | undefined): number | undefined {
	// typeof 选择字典或原标量，数组下标0在空字典时也是 undefined。
	return typeof write === "object" ? Object.values(write)[0] : write;
}

// models.dev lists one cache write price per TTL; the first is the host's default.
// 优先取 cache.write，缺值再取显式缓存的 write；返回数值或 undefined，无修改。
// 例 write:0 会保留0，不回退 explicit.write，因为 ?? 只看 null/undefined。
function cacheWritePrice(cache: V2CachePrices | undefined): number | undefined {
	// 可选链容忍 cache/explicit 缺失；没有读 explicit.read。
	return firstPrice(cache?.write) ?? firstPrice(cache?.explicit?.write);
}

// 仅把单独 context 条件转成阈值；例 {context:{gt:100}}→100，带 region 的组合条件被忽略。
// gt/gte 都直接取数值，未区分包含端点、未校验有限/非负；as 不证明 context 真是对象，坏输入仍可能抛错。
function contextThreshold(when: Record<string, unknown>): number | undefined {
	// Object.keys 只列自有可枚举字符串键。
	const keys = Object.keys(when);
	// 不能表达复合条件时整个覆盖丢弃。
	if (keys.length !== 1 || keys[0] !== "context") return undefined;
	// 把未知字段视作可选gt/gte形状只是编译期断言，并非运行检查。
	const context = when.context as { gt?: unknown; gte?: unknown };
	// gt 优先；gt=0 时仍保留，不会因假值而选 gte。
	const size = context.gt ?? context.gte;
	// 这里实际只查 number，NaN/Infinity 也会通过；下游不是完整schema验证的替代。
	return typeof size === "number" ? size : undefined;
}

// 把 v2 text/token 价格整理为基础费率和上下文覆盖，返回新对象、不改输入；不是单位换算步骤。
// 例基础input=1/output=2，context.gt=100的输入覆盖3，会在tiers放 {above:100,input:3}，缺输出留待 modelsDevCost 补。
// 输入/输出缺任一个或单位不为 token 时返回空对象；不支持的其他条件覆盖被略过，坏外壳可能抛错。
function normalizeCost(cost: ModelsDevV2Model["cost"]): ModelsDevCost {
	// 可选链取 text 的两个计价方向。
	const input = cost?.text?.input;
	const output = cost?.text?.output;
	// 局部谓词将缺单位视为 token；没有把其他单位折算。
	const perToken = (unit: string | undefined) => unit === undefined || unit === "token";
	// 两方向都满足才继续；缺失的整份成本不会生成半套基础价格。
	if (!input || !output || !perToken(input.unit) || !perToken(output.unit)) return {};

	// Only context-size overrides map onto pi's cost tiers. Region, service-tier,
	// and time-based prices have no pi equivalent yet.
	// Map 按阈值合并两方向覆盖；NonNullable 去掉可选 tiers 的 undefined，[number]取其中一档类型。
	const tiers = new Map<number, NonNullable<ModelsDevCost["tiers"]>[number]>();
	// 返回阈值对应的可变档对象，首次才创建；例输入/输出同为100会落在同一项。
	const tier = (above: number) => {
		// 已有条目复用，使后面赋属性能补同一档。
		let entry = tiers.get(above);
		// 第一次遇此阈值时仅写 above，再放 Map。
		if (!entry) {
			entry = { above };
			tiers.set(above, entry);
		}
		// 返回原条目引用，不复制。
		return entry;
	};
	// 输入覆盖能给输入价及缓存读/写价。
	for (const override of input.overrides ?? []) {
		// 解析纯context阈值，无法表达的条件不进入费率档。
		const above = contextThreshold(override.when);
		if (above === undefined) continue;
		// 获取/建立该阈值的档位，再仅赋实际提供的字段；显式0有效。
		const entry = tier(above);
		if (override.price !== undefined) entry.input = override.price;
		if (override.cache?.read !== undefined) entry.cacheRead = override.cache.read;
		// 缓存写价格可来自普通或explicit字段的首项。
		const cacheWrite = cacheWritePrice(override.cache);
		if (cacheWrite !== undefined) entry.cacheWrite = cacheWrite;
	}
	// 输出覆盖只补output；同阈值与前面输入覆盖合并，未对 Map 的阈值排序。
	for (const override of output.overrides ?? []) {
		const above = contextThreshold(override.when);
		if (above === undefined) continue;
		if (override.price !== undefined) tier(above).output = override.price;
	}

	// 输出基础价直接沿用 v2 数值；没覆盖时省略 tiers 字段。
	return {
		input: input.price,
		output: output.price,
		cacheRead: input.cache?.read,
		cacheWrite: cacheWritePrice(input.cache),
		...(tiers.size > 0 ? { tiers: [...tiers.values()] } : {}),
	};
}

// 把原始 reasoning 控制字段展成联合选项数组；例 toggle:true、effort:["high"] 得两个成员。
// 不检查 supported，调用者只在支持思考时调用；返回新数组但 effort values 仍沿用原数组，无I/O。
function reasoningOptions(reasoning: ModelsDevV2Model["capabilities"]["reasoning"]): ModelsDevReasoningOption[] {
	// 用明确联合元素类型承接三类选项。
	const options: ModelsDevReasoningOption[] = [];
	// toggle 按真值，effort/budget 则仅看是否 undefined，空数组/空对象也算提供。
	if (reasoning.toggle) options.push({ type: "toggle" });
	if (reasoning.effort !== undefined) options.push({ type: "effort", values: reasoning.effort });
	if (reasoning.budget !== undefined) options.push({ type: "budget_tokens", ...reasoning.budget });
	// budget 的字段通过对象展开合入对应成员，没有验证范围或min<=max。
	return options;
}

// 将一个 v2 条目转换成统一来源对象；不修改输入，但 source 属性保留原引用，reasoning options可能共用子数组。
// 例 input=["image/png"] 会归类可看图，tools.supported 只有严格 true 才支持工具；limit.input 不映成contextWindow。
// 可选链只是局部缺字段回退，不校验完整 JSON，也不证明模态数组/成本对象真实类型。
export function normalizeModelsDevModel(model: ModelsDevV2Model): ModelsDevModel {
	// 缺输入列表用空数组；reasoning 暂存可能缺失的能力节点。
	const input = model.modalities?.input ?? [];
	const reasoning = model.capabilities?.reasoning;
	// 新对象中的id/name/type/status照抄，不在这层填展示名默认。
	return {
		id: model.id,
		name: model.name,
		type: model.type,
		status: model.status,
		// 三个支持标记用严格true，而非把字符串"true"也当真。
		toolCall: model.capabilities?.tools?.supported === true,
		structuredOutput: model.capabilities?.structured_output === true,
		reasoning: reasoning?.supported === true,
		// 仅在 supported 真值时解析控制元数据；注意条件用真值，标记字段本身用===true。
		reasoningOptions: reasoning?.supported ? reasoningOptions(reasoning) : undefined,
		// some 识别 image 或 image/ 前缀，文本输入/输出则只认精确text。
		imageInput: input.some((modality) => modality === "image" || modality.startsWith("image/")),
		textInput: input.includes("text"),
		textOutput: (model.modalities?.output ?? []).includes("text"),
		// 两个限额可保留undefined，具体默认由后续 modelsDevModels 决定。
		contextWindow: model.limit?.context,
		maxTokens: model.limit?.output,
		// 先规范成本；API字典按枚举顺序映成数组，解构回调同时拿协议键和条目值。
		cost: normalizeCost(model.cost),
		apis: Object.entries(model.api ?? {}).map(([protocol, entry]) => ({
			protocol,
			baseUrl: entry.base_url,
			aisdk: entry.sdk?.aisdk,
		})),
		// 不是深克隆，供应商读取原始未归一字段时仍可通过source访问。
		source: model,
	};
}

// 把价格表示舍到小数点后六位，再转回 number；例1.23456789→1.234568，不修改外部状态。
// toFixed 返回字符串，Number 去除尾零；没有排除 NaN/Infinity，不等于价格合法性检查。
export function roundCost(value: number): number {
	// 这里保留浮点计算语义，并非任意精度财务小数。
	return Number(value.toFixed(6));
}

/** Converts models.dev prices to pi's cost shape. Missing rates are free. */
// 将规范来源价格补齐四项并把 above 改名 inputTokensAbove，返回新成本对象，不改cost。
// 例基础input=1、某档只给output=4，输出档沿用input=1；这里不再乘一百万。
export function modelsDevCost(cost: ModelsDevCost): ModelCost {
	// 基础费率用||补0，undefined/NaN等假值也回退0，负数等真值不在此拒绝。
	const base = {
		input: cost.input || 0,
		output: cost.output || 0,
		cacheRead: cost.cacheRead || 0,
		cacheWrite: cost.cacheWrite || 0,
	};
	// 可选map逐档生成完整四项费率；?? 保留显式零覆盖。
	const tiers = cost.tiers?.map((tier) => ({
		inputTokensAbove: tier.above,
		input: tier.input ?? base.input,
		output: tier.output ?? base.output,
		cacheRead: tier.cacheRead ?? base.cacheRead,
		cacheWrite: tier.cacheWrite ?? base.cacheWrite,
	}));
	// 至少有一档才带 tiers，不排序或验证阈值；ModelCost按整请求费率档使用而非累进区段。
	return tiers && tiers.length > 0 ? { ...base, tiers } : base;
}

/**
 * Chat models of one models.dev provider. Specialized types (image, speech,
 * realtime, decision, ...) only appear in v2 and are left out here.
 */
// 从已加载字典取某供应商，过滤原始type严格为chat后规范化；返回新数组、无网络/修改。
// 例没有此provider时得到[]；图片/语音/decision条目即使可含text也不会混入聊天目录。
export function modelsDevChatModels(catalog: ModelsDevV2Catalog, provider: string): ModelsDevModel[] {
	return (
		// 缺供应商/models时把空对象的values当空数组。
		Object.values(catalog[provider]?.models ?? {})
			// Unlike pi models, models.dev v2 always states the type.
			// 参数解构直接取type；filter建新数组，随后map逐条调用规范化函数。
			.filter(({ type }) => type === "chat")
			.map(normalizeModelsDevModel)
	);
}
