// 实验功能只有环境变量精确等于 "1" 才开启；各例临时改本进程环境，并在结束后恢复原值。
import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

// 分组回调保存进入这组测试时的环境值，注册五种固定输入；不读写配置文件。
describe("areExperimentalFeaturesEnabled", () => {
	// 环境变量类型是 string | undefined，缺失与空字符串不同。
	const originalPiExperimental = process.env.PI_EXPERIMENTAL;

	// 每例结束后恢复同一个原始值；用 delete 恢复缺失，不能赋 undefined 当作删除。
	afterEach(() => {
		// === undefined 区分“原来未设置”和“原来设置为空串”。
		if (originalPiExperimental === undefined) {
			// 删除当前测试临时添加的属性。
			delete process.env.PI_EXPERIMENTAL;
		} else {
			// 原来存在时恢复原字符串，包括可能的空字符串。
			process.env.PI_EXPERIMENTAL = originalPiExperimental;
		}
	});

	// 例：没有开关时返回 false；删除是实际副作用，afterEach 负责恢复。
	it("returns false when PI_EXPERIMENTAL is unset", () => {
		// 构造未设置状态。
		delete process.env.PI_EXPERIMENTAL;

		// 函数即时读环境；toBe 比较布尔值，不依赖模块加载时的快照。
		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	// 空字符串确实存在，但不能当作开启。
	it("returns false when PI_EXPERIMENTAL is empty", () => {
		// 环境赋值保留空字符串，不删除属性。
		process.env.PI_EXPERIMENTAL = "";

		// 本例与前例分别验证空值和缺失值。
		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	// 唯一开启样本是字符串 1，不是数值 1 或任意真值。
	it("returns true when PI_EXPERIMENTAL is set to 1", () => {
		// Node 环境变量的值使用字符串。
		process.env.PI_EXPERIMENTAL = "1";

		// 精确匹配开启值时返回 true。
		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	// 非空字符串 0 在 JS 布尔转换里为真，但此开关要求精确匹配，仍应关闭。
	it("returns false when PI_EXPERIMENTAL is set to 0", () => {
		// 构造明确的非开启值。
		process.env.PI_EXPERIMENTAL = "0";

		// 验证实现没有直接 Boolean(process.env.PI_EXPERIMENTAL)。
		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	// 常见文字 true 也不是受支持开启值；这组不声称穷举了所有字符串。
	it("returns false when PI_EXPERIMENTAL is set to a non-1 value", () => {
		// 传的是字面文字，不是布尔类型 true。
		process.env.PI_EXPERIMENTAL = "true";

		// 精确字符串契约避免把其他配置写法静默当成开启。
		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
