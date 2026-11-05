// 汇总已记录的token与费用，供会话统计、嵌套工具和费用分组展示使用；不请求供应商账单，也不自行推算模型价格。
// 仅导入Usage类型；这里兼容入口提供的类型与实际usage字段契约对应。
import type { Usage } from "@earendil-works/pi-ai/compat";
// 会话条目是带type的联合，下面通过type/role收窄后读取各自用量。
import type { SessionEntry } from "./session-manager.ts";

// 面向统计展示的可变累计器，不含Usage的totalTokens或每项价格明细。
export interface UsageTotals {
	// 普通输入token累计。
	input: number;
	// 输出token累计，reasoning若已包含在output中，不另外重复加。
	output: number;
	// 缓存读取token累计。
	cacheRead: number;
	// 缓存写入token累计，1小时子项不在此再加一次。
	cacheWrite: number;
	// 直接累计usage.cost.total，不用四个成本字段重新构造total。
	cost: number;
}

/**
 * 创建全零的新累计对象，无输入，无外部副作用。
 * 例：每个新的provider/id费用分组各建一份；不同调用不会共享一个全局可变对象。
 */
export function createUsageTotals(): UsageTotals {
	// 返回对象字面量，每次新建。
	return {
		// 输入初值0。
		input: 0,
		// 输出初值0。
		output: 0,
		// 缓存读初值0。
		cacheRead: 0,
		// 缓存写初值0。
		cacheWrite: 0,
		// 费用初值0。
		cost: 0,
	};
}

/**
 * 把一份Usage加进已有totals，原地修改累计器，返回void，不修改usage。
 * 例：totals.input=3、usage.input=2，调用后为5；调用两次就加两次，本函数不按消息id去重。
 */
export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	// +=是读取原值再相加赋回。
	totals.input += usage.input;
	// 累计输出token。
	totals.output += usage.output;
	// 累计缓存读token。
	totals.cacheRead += usage.cacheRead;
	// 累计缓存写token。
	totals.cacheWrite += usage.cacheWrite;
	// 采用用量记录已有total费用，保留供应商报告/上游计算的结果。
	totals.cost += usage.cost.total;
}

/** Sum of two usages, keeping the optional token splits when either side reports them. */
/**
 * 合并两份完整Usage，返回新对象；可选细分字段任一方提供时才保留，缺的一方按0加。
 * 例：first.reasoning=5、second未报，则合计保留5；两边都未报不生成reasoning字段。只累加，不做去重或价格重算；cost.totalFromProvider仅两边都明确true才为true。
 */
export function combineUsage(first: Usage, second: Usage): Usage {
	// 新建顶层对象，避免改写first/second。
	return {
		// 合并普通输入token。
		input: first.input + second.input,
		// 合并输出token。
		output: first.output + second.output,
		// 合并缓存读token。
		cacheRead: first.cacheRead + second.cacheRead,
		// 合并缓存写token。
		cacheWrite: first.cacheWrite + second.cacheWrite,
		// 条件对象展开：任一方非undefined才创建cacheWrite1h子项，显式0也保留。
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? // ??只把缺失值当0，不把已经报告的0丢掉。
				{ cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: // 两边都没报告，展开空对象使字段真正缺省。
				{}),
		// reasoning同样按“是否报告”决定保留，而非按是否大于0。
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? // 思考细分值相加，不在这里再次加到output或totalTokens。
				{ reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: // 没有细分信息时省略reasoning。
				{}),
		// 直接累加上游totalTokens，未假设它必须等于其他字段的某个重算公式。
		totalTokens: first.totalTokens + second.totalTokens,
		// 费用明细也构造新对象。
		cost: {
			// 输入费用相加。
			input: first.cost.input + second.cost.input,
			// 输出费用相加。
			output: first.cost.output + second.cost.output,
			// 缓存读取费用相加。
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			// 缓存写入费用相加。
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			// 总费用独立相加，不用明细强行覆盖它。
			total: first.cost.total + second.cost.total,
			// A sum is provider-reported only when every part is.
			// ===true要求两项都明确为true；undefined/false与true合并仍为false。
			totalFromProvider: first.cost.totalFromProvider === true && second.cost.totalFromProvider === true,
		},
	};
}

// 一条费用分组展示数据，不是原始会话条目。
export interface UsageCostBreakdownEntry {
	// 模型归属键或统一Tools/summaries桶名。
	key: string;
	// 该分组的总费用。
	cost: number;
	// 按输入/输出/缓存读/缓存写四项相加得到的展示token总数。
	tokens: number;
}

/** Group model-attributed usage by model and all other usage into a separate bucket. */
/**
 * 扫描条目按模型归属分组：assistant优先用responseModel，usage用自身模型；工具与摘要归Tools/summaries。
 * 例：虚拟模型请求实际路由到physical，assistant有responseModel时费用归physical。返回非空用量组并按费用降序；只读entries，新建分组累计器，不调用模型或修改历史。
 */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
	// Map把每个分组键关联到独立累计器。
	const totalsByKey = new Map<string, UsageTotals>();

	// 按条目顺序扫描，不主动限定当前分支；调用方必须提供它希望统计的entries。
	for (const entry of entries) {
		// 每轮重置key，未识别条目会保持undefined。
		let key: string | undefined;
		// 每轮重置待累计用量，避免误用上一条的usage。
		let usage: Usage | undefined;
		// 先识别assistant消息，联合收窄后可安全读其模型与用量字段。
		if (entry.type === "message" && entry.message.role === "assistant") {
			// responseModel缺失才用model；provider仍来自该消息的provider，不另拆responseModel。
			key = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
			// 使用消息已记录的Usage。
			usage = entry.message.usage;
			// 独立usage条目可代表预热或其他按模型记录的动作。
		} else if (entry.type === "usage") {
			// 按该条目provider/model归属。
			key = `${entry.provider}/${entry.model}`;
			// 取独立条目的用量。
			usage = entry.usage;
			// 有usage的工具结果进入统一辅助桶，没有usage则不计。
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			// 固定分组名不声称能细分每个工具背后的模型。
			key = "Tools/summaries";
			// 采用工具结果消息携带的用量。
			usage = entry.message.usage;
			// 分支摘要或压缩条目只有保存了usage才计入。
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			// 摘要费用与其他工具用量共用桶。
			key = "Tools/summaries";
			// 读取摘要条目的用量。
			usage = entry.usage;
		}
		// 没有已识别分组/用量的条目跳过，不伪造全零项。
		if (!key || !usage) continue;

		// 取该键现有可变累计器。
		let totals = totalsByKey.get(key);
		// 首次见到分组才创建。
		if (!totals) {
			// 获取新的零累计对象。
			totals = createUsageTotals();
			// Map保存其引用，后面原地累加就会保留结果。
			totalsByKey.set(key, totals);
		}
		// 按统一规则累加本条用量，不重复单独加reasoning子项。
		addUsageToTotals(totals, usage);
	}

	// Array.from第二参数映射Map键值对，解构后生成展示对象数组。
	return (
		Array.from(totalsByKey, ([key, totals]) => ({
			// 保留分组键。
			key,
			// 输出累计总费用。
			cost: totals.cost,
			// 展示token用四个主桶相加，未直接使用Usage.totalTokens。
			tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
		}))
			// 费用或token任一为正才展示；不是简单判断存在条目就保留。
			.filter((entry) => entry.cost > 0 || entry.tokens > 0)
			// 按费用从大到小排序；费用相等不额外按名称排序。
			.sort((a, b) => b.cost - a.cost)
	);
}
