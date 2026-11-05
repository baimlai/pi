/**
 * OpenRouter 目录使用的少量 HTTP 字段契约与价格换算；生成目录和账户 /models/user 个性化共用本文件。
 * 例 prompt="0.000003" 美元/token 换成 Pi 的 input=3 美元/百万 token；按提示长度的覆盖规则转成整次请求价格档。
 * 这里不访问网络、不查询当前时间或用户凭证，也不决定某次请求最终命中哪个档；返回数据由后续成本计算器使用。
 * 类型并非远端 JSON 校验器：parseFloat 允许数字前缀且未拒绝 Infinity，覆盖阈值也不在这里验证/排序。
 */
// 纯类型复用 Pi 的四种成本率及请求级阈值结构，运行 JS 不产生类型对象。
import type { ModelCost, ModelCostTier } from "../types.ts";

/** OpenRouter's per-token prices, as decimal strings. */
/** OpenRouter 的美元/token 价格候选；所有字段可缺省，字符串格式由 perMillion 实际解析，不因 TS 声明就保证合法。 */
export interface OpenRouterPricing {
	// 普通输入与输出各自的单 token 价格字符串。
	prompt?: string;
	completion?: string;
	// 缓存读/写单 token 价格，不自动从 prompt 按折扣推算。
	input_cache_read?: string;
	input_cache_write?: string;
	// 条件覆盖候选数组，本文件只保留可用提示长度表达的那部分。
	overrides?: OpenRouterPricingOverride[];
}

/**
 * A conditional price. `min_prompt_tokens` selects prompt-length pricing; `utc_*` fields select
 * time-of-day or weekday pricing. Missing rates keep the base price.
 */
/** 一条条件价格：阈值可限定请求输入长度；出现任意 utc_* 字段时本转换器整条跳过，即使同时有长度阈值。类型只描述字段，不在此运行时间策略。 */
export interface OpenRouterPricingOverride {
	// 转成 ModelCostTier.inputTokensAbove，后续按严格超出阈值选整次请求费率。
	min_prompt_tokens?: number;
	// 时间/星期维度 Pi 的 ModelCost 无法表达，本转换器不尝试折算为固定价。
	utc_start?: number;
	utc_end?: number;
	utc_days?: string[];
	// 覆盖里某项缺失/解析失败/为负时，使用对应基础费率。
	prompt?: string;
	completion?: string;
	input_cache_read?: string;
	input_cache_write?: string;
}

/** The fields pi reads from a model in OpenRouter's `GET /models` and `GET /models/user`. */
/** 目录条目的局部形状，不是完整远端响应 schema；例 id 对应目录模型，top_provider 可给账号实际上下文/输出限额。 */
export interface OpenRouterModel {
	// 供应商模型 ID；接口不限制空字符串或特定命名格式。
	id: string;
	// OpenRouter 可用 null/缺失表示没有这一限额；读取方按既有 || 规则也把 0 视为缺值，继续选其他来源。
	context_length?: number | null;
	// 可选路由供应商限额；max_completion_tokens 没有根级同名字段在本接口中。
	top_provider?: { context_length?: number | null; max_completion_tokens?: number | null };
	// 可选价格；不在类型声明处将其转换成 Pi 单位。
	pricing?: OpenRouterPricing;
}

/**
 * Convert one $/token price to $/1M tokens. 0 means free. Missing, invalid and negative prices use
 * the fallback: OpenRouter reports -1 for router models such as `openrouter/auto`, whose price
 * depends on the model they pick.
 */
/**
 * 把一个字符串单价换成每百万 token 费率，输入原串/缺省值与数值回退，输出 number。
 * 例 "0.000003"→3，"-1"/undefined/不能解析的串→fallback；0 保留为免费。
 * Number.parseFloat 只要求可解析数字前缀，例如 "2junk" 仍取 2；Infinity 也可进入成功分支，不把本函数说成完整价格合法性检查。
 */
function perMillion(value: string | undefined, fallback: number): number {
	// ?? 把缺失变空串，parseFloat 后会得到 NaN；没有调用 Number 严格要求整个字符串是数字。
	const perToken = Number.parseFloat(value ?? "");
	// 负数/NaN 比较不成立才回退；非负值乘百万再 toFixed(6)→Number，有限数按六位小数处理，Infinity 也未被单独排除。
	return perToken >= 0 ? Number((perToken * 1_000_000).toFixed(6)) : fallback;
}

/**
 * Convert OpenRouter's $/token prices to pi's $/1M tokens. Missing, invalid and negative base
 * prices are 0. Prompt-length overrides become request-wide tiers; a rate a tier does not list
 * keeps the base price. Time-of-day overrides are skipped because ModelCost cannot express them.
 */
/**
 * 先换四项基础单价，再筛选长度覆盖档并逐项换算；返回新的 ModelCost，不修改 pricing。
 * 例基础 input=3/output=15，阈值 100000 的覆盖只给 prompt 时，该档 input 替换、output 仍取基础 15。
 * 基础缺省/负数/NaN 费率回退 0；覆盖中对应项则回退基础费率。时间条件整条丢弃，不在这里按当前 UTC 选价。
 * 阈值按原顺序保留，不排序、去重或确认有限/非负；后续按 ModelCost 规则选“严格超过阈值”的整请求费率，不是累进分段收费。
 */
export function openRouterCost(pricing: OpenRouterPricing | undefined): ModelCost {
	// 四项均新建，缺 pricing 时可得到全零成本；不会保留另一份模型的旧费率。
	const base = {
		// 普通输入/输出换算。
		input: perMillion(pricing?.prompt, 0),
		output: perMillion(pricing?.completion, 0),
		// 缓存读写独立换算，不自动与普通输入价绑定。
		cacheRead: perMillion(pricing?.input_cache_read, 0),
		cacheWrite: perMillion(pricing?.input_cache_write, 0),
	};
	// flatMap 每条可贡献一档或零档；overrides 缺省视空数组，类型不在此保证外部运行值真是数组。
	const tiers = (pricing?.overrides ?? []).flatMap((override): ModelCostTier[] => {
		// 只采用有长度阈值且完全不带时间字段的覆盖。
		if (
			// 仅排 undefined，不验证阈值是否有限、正数等。
			override.min_prompt_tokens === undefined ||
			// 时间字段哪怕是 0/空数组也算提供，整条覆盖不转成固定价格档。
			override.utc_start !== undefined ||
			override.utc_end !== undefined ||
			override.utc_days !== undefined
		) {
			// 空数组表示过滤掉当前覆盖，flatMap 不保留占位项。
			return [];
		}
		// 每个符合条件的覆盖生成一个完整费率档，未列出的单价补基础值。
		return [
			{
				// 原阈值直接交 Pi 的 inputTokensAbove，不做加减一或排序。
				inputTokensAbove: override.min_prompt_tokens,
				// 逐项回退到 base，不因为某项有覆盖就把其他项清零。
				input: perMillion(override.prompt, base.input),
				output: perMillion(override.completion, base.output),
				cacheRead: perMillion(override.input_cache_read, base.cacheRead),
				cacheWrite: perMillion(override.input_cache_write, base.cacheWrite),
			},
		];
	});
	// 没档时省 tiers 字段，存在时新建基础+tiers 外壳；都不改输入对象/覆盖列表。
	return tiers.length > 0 ? { ...base, tiers } : base;
}
