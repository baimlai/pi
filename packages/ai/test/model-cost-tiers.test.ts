import { describe, expect, it } from "vitest";
import { buildOpenRouterCatalog, type OpenRouterModelListItem } from "../catalog/sources/openrouter.ts";
import { getAiGatewayCost } from "../catalog/sources/vercel-ai-gateway.ts";

// 输入复用上游列表项 pricing 的可选类型，返回纯转换后首个聊天模型的 cost；不发请求也不计实际账单。
// 例 prompt:"0.000002" 可得到 input:2；?. 使未生成聊天条目时返回 undefined，而不是访问空数组报错。
function openRouterChatCost(pricing: OpenRouterModelListItem["pricing"]) {
	// 构造一个支持工具的 Anthropic 模型样本，保证能进入聊天目录。
	const catalog = buildOpenRouterCatalog(
		[{ id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", supported_parameters: ["tools"], pricing }],
		// 图片/分类列表为空，使本辅助函数只关注聊天费率转换。
		[],
		[],
	);
	// 返回转换生成的费率引用；不复制，也不选择某次请求要使用的阶梯。
	return catalog.chat[0]?.cost;
}

// 注册 OpenRouter 条件单价转换测试；金额是固定样本，不能当作当前线上报价。
describe("OpenRouter pricing overrides", () => {
	// 输入基础费率和长度覆盖，输出每百万 token 的完整阶梯；例阈值 100000 原样写入 inputTokensAbove。
	it("turns prompt-length overrides into tiers", () => {
		// 对纯辅助函数结果作完整结构比较，没有请求级 token 成本相乘。
		expect(
			openRouterChatCost({
				// 下面四个字符串都是美元/token 的基础费率。
				prompt: "0.0000001",
				completion: "0.0000005",
				input_cache_read: "0.00000001",
				input_cache_write: "0.000000125",
				// 同一长度覆盖同时更新四项费率，转换后应形成一个完整档位。
				overrides: [
					{
						// 仅提供长度条件，不含 utc_* 时间条件，所以可转成 Pi 静态阶梯。
						min_prompt_tokens: 100000,
						prompt: "0.0000005",
						completion: "0.0000025",
						input_cache_read: "0.00000005",
						input_cache_write: "0.000000625",
					},
				],
			}),
		).toEqual({
			// 基础费率乘 1_000_000，并按实现保留转换后的数值。
			input: 0.1,
			output: 0.5,
			cacheRead: 0.01,
			cacheWrite: 0.125,
			// 这里断言描述的阈值，不验证真正成本计算器在等于阈值时选择哪档。
			tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
		});
	});

	// 覆盖只给普通输入/输出，预期缓存读写继续采用基础价；转换无外部副作用。
	it("keeps base rates missing from an override", () => {
		expect(
			openRouterChatCost({
				prompt: "0.000002",
				completion: "0.000012",
				input_cache_read: "0.0000002",
				input_cache_write: "0.000000375",
				// 缓存字段故意省略，不能被误填为零。
				overrides: [{ min_prompt_tokens: 200000, prompt: "0.000004", completion: "0.000018" }],
			})?.tiers,
		).toEqual([{ inputTokensAbove: 200000, input: 4, output: 18, cacheRead: 0.2, cacheWrite: 0.375 }]);
	});

	// 带时间/星期条件的价格无法由请求长度阶梯表达，预期跳过整条，不根据测试机器当前时间选价。
	it("skips time-of-day overrides", () => {
		expect(
			openRouterChatCost({
				prompt: "0.000000132",
				completion: "0.000000528",
				// 两条分别含 utc 时间范围与星期；第二条即使有长度阈值也要跳过。
				overrides: [
					{ utc_start: 0, utc_end: 1600, prompt: "0.000000132", completion: "0.000000528" },
					{ utc_days: ["saturday"], min_prompt_tokens: 1000, prompt: "0.0000001" },
				],
			}),
			// 没有可用阶梯时不应额外产生 tiers 字段，缺省缓存基础费率为零。
		).toEqual({ input: 0.132, output: 0.528, cacheRead: 0, cacheWrite: 0 });
	});
});

// Gateway 的原始 min 为包含式区间起点，Pi 用严格超过门槛；这组验证两种描述之间的减一转换。
describe("Vercel AI Gateway pricing tiers", () => {
	// 输入独立的输入/输出区间，合并成请求级完整费率档；例如 min:32001 对应 inputTokensAbove:32000。
	it("turns bracket starts into tiers with the rates in effect there", () => {
		expect(
			getAiGatewayCost({
				input: "0.000001",
				output: "0.000005",
				input_cache_read: "0.0000002",
				// max 不包含端点，最后一档省 max 表示没有该区间上界。
				input_tiers: [
					{ cost: "0.000001", min: 0, max: 32001 },
					{ cost: "0.0000018", min: 32001, max: 128001 },
					{ cost: "0.000003", min: 128001 },
				],
				// 输出费率也按请求输入长度选区间，并非按输出 token 数选择。
				output_tiers: [
					{ cost: "0.000005", min: 0, max: 32001 },
					{ cost: "0.000009", min: 32001, max: 128001 },
					{ cost: "0.000015", min: 128001 },
				],
			}),
		).toEqual({
			input: 1,
			output: 5,
			cacheRead: 0.2,
			cacheWrite: 0,
			// 两个非零起点合并成两个档位；缓存未提供区间，所以各档保留缓存基础费率。
			tiers: [
				{ inputTokensAbove: 32000, input: 1.8, output: 9, cacheRead: 0.2, cacheWrite: 0 },
				{ inputTokensAbove: 128000, input: 3, output: 15, cacheRead: 0.2, cacheWrite: 0 },
			],
		});
	});

	// 无区间输入时只返回四项基础费率；示例还覆盖字符串与 number 两种上游费率表示。
	it("returns base rates without tiers", () => {
		// 对象没有 *_tiers，结果也不附 tiers:[]。
		expect(getAiGatewayCost({ input: "0.000003", output: 0.000015 })).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});
});
