// 检查Together本地模型目录的协议/模态/思考映射/费用元数据，以及兼容环境变量查找；不发请求验证服务端能力或账单。
// Vitest的afterEach恢复本文件改动的环境键，describe分组，it主体只读本地对象或改当前进程env。
import { afterEach, describe, expect, it } from "vitest";
// getModel是兼容层的静态目录别名，直接查生成目录，不在这行调用Models刷新或选择已认证模型。
import { getModel } from "../src/compat.ts";
// findEnvKeys返回有值变量名列表，getEnvApiKey返回所选变量值；后面只用Together，不走ADC/AWS分支。
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

// 模块加载时保存原环境值，类型可为undefined；不是每个用例开始时再取一遍，也不打印秘密。
const originalTogetherApiKey = process.env.TOGETHER_API_KEY;

// 每例结束恢复TOGETHER_API_KEY，无输入/业务返回；例原来没配则删临时键而非写文字undefined。断言失败也由Vitest安排清理，不修改用户shell或磁盘凭据。
afterEach(() => {
	// 严格undefined区分原本缺失与原本有空字符串。
	if (originalTogetherApiKey === undefined) {
		// 原来缺失就delete当前进程键，清掉测试用值。
		delete process.env.TOGETHER_API_KEY;
		// 原来有值时走赋回分支，不用真假判断丢掉空串。
	} else {
		// 恢复顶层快照的原文字，不发认证请求。
		process.env.TOGETHER_API_KEY = originalTogetherApiKey;
	}
});

// 注册下面三例，分组本身不创建实际模型会话。
describe("Together models", () => {
	// 按固定Kimi K3目录键检查协议、模型身份、能力、窗口与完整费用/兼容对象；例应使用Completions且接受text/image。
	// 标题中的registers在此仅由静态目录字段断言体现，未另调用工厂注册/发送请求，也不检查远端套餐可用性；同步断言失败使本例失败。
	it("registers the default Kimi K3 model via OpenAI-compatible Chat Completions API", () => {
		// 从Together生成聊天表读取moonshotai/Kimi-K3；模型品牌前缀不是把provider切换为moonshotai。
		const model = getModel("together", "moonshotai/Kimi-K3");

		// 先要求确有目录对象；这条Vitest断言不是TS的asserts函数，后续类型仍来自getModel签名。
		expect(model).toBeDefined();
		// 运行API字段必须精确是openai-completions，不只检查能否归为字符串。
		expect(model.api).toBe("openai-completions");
		// 供应商归属仍为together，与Kimi品牌名称分开。
		expect(model.provider).toBe("together");
		// 检查模型自身baseUrl字段，不调用URL或HTTP客户端，也不据此证明Provider默认端点覆盖优先级。
		expect(model.baseUrl).toBe("https://api.together.ai/v1");
		// reasoning=true是目录能力声明，不是一次实际推理已经发生。
		expect(model.reasoning).toBe(true);
		// 用toEqual比较预期映射三项null，表示这些档位不支持；没有调用档位过滤器，缺失其它档位的解释仍由支持集合/适配器规则处理。
		expect(model.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null });
		// 输入模态数组精确含text、image且顺序如此；这是接收图片输入，不代表图片生成能力。
		expect(model.input).toEqual(["text", "image"]);
		// 目录上下文容量要求1048576，不真的构造百万token测试请求。
		expect(model.contextWindow).toBe(1048576);
		// 目录最大输出要求131072，不测服务端输出限额。
		expect(model.maxTokens).toBe(131072);
		// toEqual深比较预期费用字段的值，不计算当前请求实际开销。
		expect(model.cost).toEqual({
			// 普通输入单价期望每百万token 3美元。
			input: 3,
			// 输出单价期望每百万token 15美元。
			output: 15,
			// 缓存读单价期望每百万token 0.3美元，未创建或命中真实缓存。
			cacheRead: 0.3,
			// 缓存写单价为0是静态价格元数据，不是证明所有缓存操作永远免费。
			cacheWrite: 0,
		});
		// 兼容对象用toEqual深比较预期值，后面的toMatchObject只检查预期子集；这里未用toStrictEqual区分缺失键与额外undefined键等更严格差异。
		expect(model.compat).toEqual({
			// 目录的store支持开关为false；本测试只比较元数据，不构造请求检查最终载荷是否含store。
			supportsStore: false,
			// developer角色支持声明为false，转换消息的行为未在此执行。
			supportsDeveloperRole: false,
			// reasoning_effort支持声明为false，和下例其它Together模型可为true形成模型级差异。
			supportsReasoningEffort: false,
			// 最大输出参数名声明为max_tokens，不是把所有协议都改用此键。
			maxTokensField: "max_tokens",
			// thinkingFormat为together表示使用该兼容格式，不是请求模型的供应商ID字段。
			thinkingFormat: "together",
			// 不声明支持strict工具模式，未在这里编译工具schema或向远端验证。
			supportsStrictMode: false,
			// 不声明支持长缓存保留，未测试真实TTL。
			supportsLongCacheRetention: false,
		});
	});

	// 比较GPT-OSS与DeepSeek两份思考映射/兼容元数据：同属Together仍可使用不同thinkingFormat。无外部输入/业务返回，不调用推理API。
	it("models Together reasoning controls from the Together API surface", () => {
		// 读取Together目录里的GPT-OSS模型，仍走本地表。
		const gptOss = getModel("together", "openai/gpt-oss-120b");
		// toEqual深比较以下null/字符串映射值，不运行原生思考参数转换。
		expect(gptOss.thinkingLevelMap).toEqual({
			// off=null表示目录声明不支持关闭思考，不是字符串"null"或省略值。
			off: null,
			// minimal也明确不支持。
			minimal: null,
			// low映射为provider原生low文字，不运行转换函数。
			low: "low",
			// medium映射为medium文字。
			medium: "medium",
			// high映射为high文字。
			high: "high",
			// max明确为null，不因统一枚举里有max就开放。
			max: null,
			// xhigh同样明确不支持，这里对象键先后不作为深相等语义的重点。
			xhigh: null,
		});
		// compat用部分匹配，允许目录还有其它兼容字段，不要求只含下面两项。
		expect(gptOss.compat).toMatchObject({
			// GPT-OSS声明支持reasoning_effort参数。
			supportsReasoningEffort: true,
			// 其思考格式期望openai，不是上例Kimi的together格式。
			thinkingFormat: "openai",
		});

		// 读取另一品牌DeepSeek的Together目录项，未换成直连DeepSeek Provider。
		const deepSeekV4 = getModel("together", "deepseek-ai/DeepSeek-V4-Pro-0813");
		// DeepSeek的预期映射与GPT-OSS不同；这里比较值，没有用toBe断言两对象身份。
		expect(deepSeekV4.thinkingLevelMap).toEqual({
			// minimal不支持。
			minimal: null,
			// low不支持。
			low: null,
			// medium不支持。
			medium: null,
			// high映射为原生high文字。
			high: "high",
			// xhigh不支持；此预期对象没列off/max，不等于代码会自动把缺项补成null。
			xhigh: null,
		});
		// 再对DeepSeek兼容元数据做部分匹配，不严格排除其它字段。
		expect(deepSeekV4.compat).toMatchObject({
			// 声明支持reasoning_effort，但实际格式还看下一项。
			supportsReasoningEffort: true,
			// DeepSeek在此目录用together格式，与同供应商GPT-OSS的openai格式分开。
			thinkingFormat: "together",
		});
	});

	// 临时设置进程环境假key，预期发现名与返回值对应；例test-together-key只在内存中比较，不尝试真实授权，afterEach随后还原。
	it("resolves TOGETHER_API_KEY from the environment", () => {
		// 把假值写到Together专用键，其他环境键不在此修改。
		process.env.TOGETHER_API_KEY = "test-together-key";

		// 发现数组应精确只包含TOGETHER_API_KEY变量名，不把秘密值放列表里。
		expect(findEnvKeys("together")).toEqual(["TOGETHER_API_KEY"]);
		// 实际读取函数应给test-together-key，证明此本地变量映射，不证明远端key有效。
		expect(getEnvApiKey("together")).toBe("test-together-key");
	});
});
