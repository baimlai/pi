// OpenAI兼容适配收到OpenRouter用量后，用供应商报告的费用覆盖目录估算总价；只更新usage对象，不发请求。
// Usage 里 cost.total 是总费用，其他成本分项可能仍来自目录估算。
import type { Usage } from "../types.ts";

// 描述OpenRouter响应的账务字段；这是远端输入，因此实际使用前仍检查数值。
export interface OpenRouterUsageAccounting {
	/** Amount charged to the user's OpenRouter account. */
	// OpenRouter账户被收取的金额，null 表示未知而不是0。
	cost: number | null;
	/** Whether OpenRouter used the user's upstream provider key. */
	// 是否用了用户自己的上游key；BYOK情况下还需把上游账户费用算进去。
	is_byok: boolean;
	// 可选明细对象；远端允许整个对象为null。
	cost_details: {
		/** Total inference cost billed through the user's upstream provider account, when available. */
		// 上游推理总价，null 时尝试用下面的输入/输出分项恢复。
		upstream_inference_cost: number | null;
		/** Upstream cost for prompt processing, including any provider-side cache pricing. */
		// 上游输入处理费用，包括它自己的缓存定价效果。
		upstream_inference_prompt_cost: number;
		/** Upstream cost for completion generation. */
		// 上游输出生成费用。
		upstream_inference_completions_cost: number;
		/** Metered server-tool cost already included in OpenRouter's charged `cost`. */
		// 服务端工具费用已计入OpenRouter cost，此函数不再重复相加。
		server_tool_cost?: number | null;
		// 联合类型表示明细可能不存在；使用前必须检查。
	} | null;
}

// 用途：判断远端费用是否为有限非负数字。例0有效、NaN/Infinity/负数/字符串无效；类型谓词让通过后的值可参与加法。
function isValidCost(value: unknown): value is number {
	// number 类型本身可含NaN和Infinity，因此还需要有限性和业务非负检查。
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// 用途：识别OpenRouter目录项或指向OpenRouter的自定义兼容项。例provider=custom但URL包含openrouter.ai也匹配；此函数不解析或请求URL。
export function isOpenRouterModel(model: { provider: string; baseUrl: string }): boolean {
	// 按供应商名或URL子串匹配；并非严格hostname白名单验证。
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");
}

/** Replace the catalog total with OpenRouter's billed cost when the response contains complete, valid accounting. */
// 用途：仅当账务数据完整有效时修改usage.cost.total。例非BYOK费用0.01就覆盖总价；BYOK则OpenRouter费用加上游费用，无效报告保持原估算。
export function applyOpenRouterReportedCost(usage: Usage, reported: OpenRouterUsageAccounting): void {
	// 远端总价不可用就不覆盖，避免把未知值当成免费。
	if (!isValidCost(reported.cost)) return;

	// OpenRouter直接计费，不再额外算用户上游账户费用。
	if (reported.is_byok === false) {
		// 修改原usage总价，分项字段仍保留原来的内容。
		usage.cost.total = reported.cost;
		// 标记总价来自供应商账务，调用者不应误以为这是纯目录估算。
		usage.cost.totalFromProvider = true;
		// 本分支已处理，或明细不合法的分支在此结束，不继续覆盖费用。
		return;
	}

	// 用自有上游key时，用户总支出还包括上游账户消耗。
	if (reported.is_byok === true) {
		// 取出上游费用明细。
		const details = reported.cost_details;
		// 缺少明细无法知道上游花费，保持原总价而非仅报网关部分。
		if (!details) return;
		// 先按unknown处理远端总价，后续验证成功才能加法。
		let upstreamCost: unknown = details.upstream_inference_cost;
		// 上游总价明确缺失时，尝试从两个分项恢复。
		if (upstreamCost === null) {
			if (
				// 任一输入分项不可用，都不能可靠恢复总价。
				!isValidCost(details.upstream_inference_prompt_cost) ||
				// 输出分项同样必须是有限非负数字。
				!isValidCost(details.upstream_inference_completions_cost)
			) {
				// 本分支已处理，或明细不合法的分支在此结束，不继续覆盖费用。
				return;
			}
			// 两个有效分项相加得到候选上游总价。
			upstreamCost = details.upstream_inference_prompt_cost + details.upstream_inference_completions_cost;
		}
		// 无论直接报告还是分项恢复，都再次确认候选总价有效。
		if (!isValidCost(upstreamCost)) return;
		// 最终总价是网关收费加用户自己的上游费用，服务端工具费不另加。
		usage.cost.total = reported.cost + upstreamCost;
		// 标记总价来自供应商账务，调用者不应误以为这是纯目录估算。
		usage.cost.totalFromProvider = true;
	}
}
