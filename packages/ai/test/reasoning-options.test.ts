import { describe, expect, it } from "vitest";
import { getEffortThinkingLevelMap } from "../catalog/reasoning.ts";

// 只测试目录数据到 Pi 思考档位的纯转换，不请求模型，也不证明供应商实际支持这些人工样本值。
describe("getEffortThinkingLevelMap", () => {
	// 输入同时含开关和 effort 枚举，无副作用；只将明确的 none/low/high/max 暴露出来，其他档位标为 null。
	it("exposes only verified effort values and none", () => {
		// expect 的参数是实际转换结果，toEqual 逐字段比较完整映射。
		expect(
			// toggle 不提供 effort 值；有 none 才可把统一 off 映射到原生 none。
			getEffortThinkingLevelMap([{ type: "toggle" }, { type: "effort", values: ["none", "low", "high", "max"] }]),
		).toEqual({
			// "none" 是供应商字符串，null 表示该 Pi 档位未被样本声明支持。
			off: "none",
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	// 示例 effort 只有 low/high/max，必须显式把 off 设 null，不能从“可选 effort”推测关闭能力。
	it("does not infer thinking-off from an effort list", () => {
		// 这个纯调用返回新映射；缺少 none 是与上一例的唯一关键差异。
		expect(getEffortThinkingLevelMap([{ type: "effort", values: ["low", "high", "max"] }])).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	// 输入没有任何可映到 Pi 档位的 effort 值时返回 undefined；不在此替适配器实现 toggle 或 token 预算。
	it("leaves toggle and budget controls for their adapter-specific implementations", () => {
		// 单纯开关没有 effort 列表，转换器直接不提供映射。
		expect(getEffortThinkingLevelMap([{ type: "toggle" }])).toBeUndefined();
		// 预算上下限只是人工输入数据，不会在本用例分配或消耗 token。
		expect(getEffortThinkingLevelMap([{ type: "budget_tokens", min: 1024, max: 32000 }])).toBeUndefined();
		// JSON null 和字符串 default 不对应 Pi 的六种明确 effort 档位，也不推导成 off。
		expect(getEffortThinkingLevelMap([{ type: "effort", values: [null, "default"] }])).toBeUndefined();
	});
});
