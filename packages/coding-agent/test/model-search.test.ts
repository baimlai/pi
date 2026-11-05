// 用本地模型对象检查名称去重与模糊搜索排序，不加载远端目录或请求模型。
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { getDistinctModelName, getModelSelectorSearchText } from "../src/modes/interactive/model-search.ts";

// #5916
// 这一组注册显示名判断用例；#5916 是原有回归问题编号。
describe("getDistinctModelName", () => {
	// 例：显示名的词都已被 ID 表达时返回 undefined；有限样本检查大小写、分隔符及缺省名。
	it("hides names that restate the ID", () => {
		// 连字符 ID 与空格/小数点显示名按规则归一后无需重复显示。
		expect(getDistinctModelName({ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" })).toBeUndefined();
		// 供应商命名空间已经出现在 ID 中，名称不带额外信息。
		expect(getDistinctModelName({ id: "openai/gpt-oss-120b", name: "OpenAI: gpt-oss-120b" })).toBeUndefined();
		// 多行 expect 的实参仍只有一次函数调用；下面传地域和日期等额外 ID 片段。
		expect(
			// EU 与名称词可被此长 ID 覆盖，要求隐藏名称。
			getDistinctModelName({ id: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0", name: "Claude Sonnet 4.5 (EU)" }),
		).toBeUndefined();
		// 空字符串名称应视作无额外显示名。
		expect(getDistinctModelName({ id: "gpt-5", name: "" })).toBeUndefined();
		// 省略可选 name 字段也应得到 undefined，不是空字符串。
		expect(getDistinctModelName({ id: "gpt-5" })).toBeUndefined();
	});

	// 例：名称带 ID 中没有的新词应保留原显示名；不会把新名称写回模型对象。
	it("shows names with words the ID lacks", () => {
		// const 保存带额外账户/供应商说明的固定显示名。
		const name = "MiniMax M3 [rasmus@openrouter, parasail]";
		// 属性简写 name 等于 name:name；toBe 要求返回同值字符串。
		expect(getDistinctModelName({ id: "minimax/minimax-m3", name })).toBe(name);
		// Nano Banana 等词不在 Gemini ID 内，因此要求返回这段名称。
		expect(getDistinctModelName({ id: "gemini-3.1-flash-lite-image", name: "Nano Banana 2 Lite" })).toBe(
			// 跨行 toBe 的实参是完整预期名称，非另一条语句。
			"Nano Banana 2 Lite",
		);
	});

	// 例：单字符 4 不能仅因 ID 的 2603 含数字就视为已覆盖，要求完整词匹配。
	it("requires single-character words to match a whole ID token", () => {
		// 若算法错误地按任意子串覆盖单字符，这个名称就会被隐藏而导致断言失败。
		expect(getDistinctModelName({ id: "mistral-small-2603", name: "Mistral Small 4" })).toBe("Mistral Small 4");
	});
});

// 第二组把产品搜索文本交给真实 fuzzyFilter，比较固定候选的结果位置。
describe("model selector search ranking", () => {
	// #11220
	// 例：opus 的两种实际/代理候选应排前二；sort 后比较所以不限定这两者的内部顺序。
	it("ranks models containing the query above scattered matches", () => {
		// 数组混合 Sonnet、Opus 和 OSS；每个对象是搜索所需字段，没有创建真实 Model 实例。
		const models = [
			// openrouter 是实际供应商；id 内 openai 是代理模型的命名空间。
			{ provider: "openrouter", id: "openai/gpt-oss-120b", name: "OpenAI: gpt-oss-120b" },
			// 两种 Claude 家族让连续 opus 命中与其他零散字符匹配形成对比。
			{ provider: "openrouter", id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5" },
			{ provider: "openrouter", id: "anthropic/claude-opus-4.1", name: "Anthropic: Claude Opus 4.1" },
			// 后两项是直连 anthropic 的短 ID，和代理路径同时参与评分。
			{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
			{ provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" },
		];

		// fuzzyFilter 调用 getModelSelectorSearchText 取评分文本；map 的 m 是每项候选，取出 id 构成新数组。
		const result = fuzzyFilter(models, "opus", getModelSelectorSearchText).map((m) => m.id);

		// slice 复制前两项再 sort，避免依赖它们彼此名次；只断言这组候选中谁占前二。
		expect(result.slice(0, 2).sort()).toEqual(["anthropic/claude-opus-4.1", "claude-opus-4-1"]);
	});

	// #10065
	// 例：共同带长 fireworks 前缀时，输入 firerouter 应把路由项排第一，不联网查目录。
	it("ranks the typed model above models sharing a long provider prefix", () => {
		// 构造同供应商的两个普通模型和一个路由 ID。
		const models = [
			// 前两项没有 name，搜索文本仍可由 provider/id 生成。
			{ provider: "fireworks", id: "accounts/fireworks/models/deepseek-v4-flash-0731" },
			{ provider: "fireworks", id: "accounts/fireworks/models/kimi-k3" },
			// 路由候选同时有显示名 FireRouter 与含 firerouter 的 ID。
			{ provider: "fireworks", id: "accounts/fireworks/routers/firerouter", name: "FireRouter" },
		];

		// 获得排序后的原候选对象数组；没有像上一例再投影为 id。
		const result = fuzzyFilter(models, "firerouter", getModelSelectorSearchText);

		// result[0]?.id 在结果为空时得到 undefined，toBe 再失败；只检查首位候选。
		expect(result[0]?.id).toBe("accounts/fireworks/routers/firerouter");
	});
});
