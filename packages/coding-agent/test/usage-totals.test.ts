import type { Usage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { combineUsage } from "../src/core/usage-totals.ts";

// 为合并测试制造一份 Usage；total 是费用而非 token 数，? 表示第二参数可省略。
// 返回新对象，不读账单或计费；例如 usage(2, true) 的总费用为 2 且标记来自提供商，其他费用明细仍为 0。
function usage(total: number, totalFromProvider?: boolean): Usage {
	// : Usage 在开发时检查结构，不在运行时校验费用明细是否与 total 相加一致。
	return {
		// 固定各 token 项，仅让调用者控制本测试关心的总费用/来源。
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: {
			// 四项明细固定为零；本例刻意测试 combineUsage 直接合并 total 的行为。
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total,
			// 对象展开与三元表达式：省略参数就不生成该字段，显式 false 仍保留 false。
			...(totalFromProvider === undefined ? {} : { totalFromProvider }),
		},
	};
}

// 登记用量来源标记的一个测试，不覆盖 combineUsage 的所有可选 token 细分。
describe("combineUsage", () => {
	// 无参数、无 I/O；枚举两方来源标记的四种组合，断言失败会使测试失败。
	it("marks the combined total as provider-reported only when both totals are", () => {
		// 两方都明确 true 才保持 true；toMatchObject 只比这些字段，同时验证总费用 1+2=3。
		expect(combineUsage(usage(1, true), usage(2, true)).cost).toMatchObject({ total: 3, totalFromProvider: true });
		// 右方未报告标记时不能把合计称作完全由提供商报告。
		expect(combineUsage(usage(1, true), usage(2)).cost.totalFromProvider).toBe(false);
		// 左方未报告也同样为 false，验证合并顺序不改变这个规则。
		expect(combineUsage(usage(1), usage(2, true)).cost.totalFromProvider).toBe(false);
		// 两方均缺省仍显式生成 false；本例没有单独枚举显式 false 输入。
		expect(combineUsage(usage(1), usage(2)).cost.totalFromProvider).toBe(false);
	});
});
