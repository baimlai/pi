// 验证兼容认证助手如何选择环境变量：Copilot只认专用token，Anthropic的发现列表与实际API key选择不同。
// 七个用例只改当前进程七项env并比较本地结果，不向供应商验证token，不覆盖Vertex ADC文件探测或AWS环境认证。
// Vitest的describe分组、it注册用例、expect断言；afterEach即便用例断言失败也安排恢复环境。
import { afterEach, describe, expect, it } from "vitest";
// findEnvKeys给有值变量的名字，getEnvApiKey给选中的值；导入Node内置模块可异步发生，这些用例不调用ADC分支。
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

// 模块加载时记下Copilot专用变量原值，类型为string或undefined；快照早于本文件所有用例，不是每例重新取。
const originalCopilotGitHubToken = process.env.COPILOT_GITHUB_TOKEN;
// 记下GH_TOKEN，后面可证明它不会被当作Copilot凭据。
const originalGhToken = process.env.GH_TOKEN;
// 记下另一通用GITHUB_TOKEN；保存的只是原字符串，不另复制整个process.env。
const originalGitHubToken = process.env.GITHUB_TOKEN;
// 保留中国ZAI Coding Plan变量，清理时只恢复这一个键。
const originalZaiCodingCnApiKey = process.env.ZAI_CODING_CN_API_KEY;
// 保留Anthropic Bearer token来源，用来区分发现状态与x-api-key选择。
const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
// 保留旧OAuth token兼容变量，不在这里刷新它。
const originalAnthropicOauthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
// 保留常规API key变量；这些顶层const后面不被测试重新赋值。
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

// 每例之后恢复七项环境，无参数/返回业务值；例最初无GH_TOKEN则删除测试写入，而不是写入字符串undefined。
// 恢复只覆盖这里列的键，不是整份环境快照；没有修改用户shell或持久凭据文件。
afterEach(() => {
	// 原值严格等于undefined代表本来没有此配置，空字符串则应走后面赋回分支。
	if (originalCopilotGitHubToken === undefined) {
		// delete真正去掉Copilot环境键，避免process.env赋undefined被转成文字。
		delete process.env.COPILOT_GITHUB_TOKEN;
		// 原来有值时进入else，不把空串误当缺失。
	} else {
		// 赋回原Copilot字符串，清掉用例临时设置的token。
		process.env.COPILOT_GITHUB_TOKEN = originalCopilotGitHubToken;
	}

	// 检查原通用GH_TOKEN是否缺失。
	if (originalGhToken === undefined) {
		// 原来没有就删除，不保留用例中的gh-token。
		delete process.env.GH_TOKEN;
		// 原来存在时恢复其原文。
	} else {
		// 将保存的GH_TOKEN值写回当前进程。
		process.env.GH_TOKEN = originalGhToken;
	}

	// 对GITHUB_TOKEN也区分缺失与现有字符串。
	if (originalGitHubToken === undefined) {
		// 移除原来不存在的键。
		delete process.env.GITHUB_TOKEN;
		// 存在则选赋回路径。
	} else {
		// 恢复GITHUB_TOKEN原值，不触发GitHub登录。
		process.env.GITHUB_TOKEN = originalGitHubToken;
	}

	// 检查ZAI中国编码计划原变量是否存在。
	if (originalZaiCodingCnApiKey === undefined) {
		// 缺失时删除本例临时key。
		delete process.env.ZAI_CODING_CN_API_KEY;
		// 有原值则保留原先配置状态。
	} else {
		// 赋回ZAI_CODING_CN_API_KEY原值。
		process.env.ZAI_CODING_CN_API_KEY = originalZaiCodingCnApiKey;
	}

	// 判断Anthropic Bearer变量原来是否缺失。
	if (originalAnthropicAuthToken === undefined) {
		// 没有则删除，不把auth-token带到下一例。
		delete process.env.ANTHROPIC_AUTH_TOKEN;
		// 原来存在时恢复，不截断或trim。
	} else {
		// 赋回原ANTHROPIC_AUTH_TOKEN。
		process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
	}

	// 判断OAuth兼容变量原来是否缺失。
	if (originalAnthropicOauthToken === undefined) {
		// 缺失则从当前环境移除。
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
		// 有原值时走赋回分支。
	} else {
		// 恢复ANTHROPIC_OAUTH_TOKEN，不执行OAuth协议。
		process.env.ANTHROPIC_OAUTH_TOKEN = originalAnthropicOauthToken;
	}

	// 判断常规Anthropic API key原状态。
	if (originalAnthropicApiKey === undefined) {
		// 原来缺失就删去测试值。
		delete process.env.ANTHROPIC_API_KEY;
		// 原来存在则恢复，包括空字符串。
	} else {
		// 恢复ANTHROPIC_API_KEY，结束最后一个键的清理。
		process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
	}
});

// 分组回调同步注册下面七例，本身不做认证请求；每个it中的箭头才是测试主体。
describe("environment API keys", () => {
	// 输入只有两种通用GitHub token，预期Copilot两助手都无结果；例gh-token不会自动变Copilot token。环境修改随后由afterEach恢复。
	it("does not treat generic GitHub tokens as GitHub Copilot credentials", () => {
		// 明确移除Copilot专用变量，排除用户原配置干扰本例。
		delete process.env.COPILOT_GITHUB_TOKEN;
		// 设置假GH_TOKEN，仅作为本地字符串fixture，不是可用服务凭据。
		process.env.GH_TOKEN = "gh-token";
		// 同时给另一通用GitHub token，验证它也不补位。
		process.env.GITHUB_TOKEN = "github-token";

		// 发现列表必须为undefined，而非包含GH_TOKEN/GITHUB_TOKEN的数组。
		expect(findEnvKeys("github-copilot")).toBeUndefined();
		// 实际key读取同样没有结果；这是缺少专用配置，不是网络拒绝。
		expect(getEnvApiKey("github-copilot")).toBeUndefined();
	});

	// 输入专用和两个通用token，预期名字只报专用变量、值取copilot-token；证明本地映射选择，不证明远端token有效。
	it("resolves GitHub Copilot credentials from COPILOT_GITHUB_TOKEN", () => {
		// 设置专用Copilot变量，作为本例应选中的来源。
		process.env.COPILOT_GITHUB_TOKEN = "copilot-token";
		// 保留通用GH_TOKEN干扰项。
		process.env.GH_TOKEN = "gh-token";
		// 保留通用GITHUB_TOKEN干扰项。
		process.env.GITHUB_TOKEN = "github-token";

		// toEqual按数组内容比较，要求只有专用名字且没有通用名字。
		expect(findEnvKeys("github-copilot")).toEqual(["COPILOT_GITHUB_TOKEN"]);
		// toBe按字符串精确比较选中的值，不返回变量名字本身。
		expect(getEnvApiKey("github-copilot")).toBe("copilot-token");
	});

	// 给中国ZAI Coding Plan专用变量，预期发现名字和值一致；不检查其他ZAI服务共用key或地区端点。
	it("resolves ZAI China Coding Plan credentials from ZAI_CODING_CN_API_KEY", () => {
		// 把假key写到该provider对应的精确变量名。
		process.env.ZAI_CODING_CN_API_KEY = "zai-coding-cn-token";

		// 断言发现数组为单个中国计划名字。
		expect(findEnvKeys("zai-coding-cn")).toEqual(["ZAI_CODING_CN_API_KEY"]);
		// 断言读到此变量的假token文字。
		expect(getEnvApiKey("zai-coding-cn")).toBe("zai-coding-cn-token");
	});

	// 三种Anthropic配置同时存在：发现全列，但API key选择跳过Bearer后优先OAuth变量；例期望oauth-token而非auth-token/api-key。
	it("reports ANTHROPIC_AUTH_TOKEN but preserves OAuth token API key lookup", () => {
		// 设置Bearer专用材料，只参与本例发现列表。
		process.env.ANTHROPIC_AUTH_TOKEN = "auth-token";
		// 设置兼容OAuth token，应成为实际getEnvApiKey结果。
		process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-token";
		// 再给普通key作为优先级较低的候选。
		process.env.ANTHROPIC_API_KEY = "api-key";

		// 按精确数组顺序要求AUTH_TOKEN→OAUTH_TOKEN→API_KEY，toEqual也检查顺序。
		expect(findEnvKeys("anthropic")).toEqual(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
		// 实际key必须是OAuth变量值，而非发现列表第一项对应的Bearer。
		expect(getEnvApiKey("anthropic")).toBe("oauth-token");
	});

	// 只给Bearer来源时发现仍有名字，实际API key应缺失；体现状态发现不等于x-api-key可用。
	it("does not return ANTHROPIC_AUTH_TOKEN as an API key", () => {
		// 留下唯一Bearer变量。
		process.env.ANTHROPIC_AUTH_TOKEN = "auth-token";
		// 移除OAuth兼容变量，避免其从原环境兜底。
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
		// 同时移除常规key，保证本例只测Bearer。
		delete process.env.ANTHROPIC_API_KEY;

		// 发现仍报告Bearer变量名。
		expect(findEnvKeys("anthropic")).toEqual(["ANTHROPIC_AUTH_TOKEN"]);
		// getEnvApiKey跳过它后返回undefined；没有把Bearer值错用作普通key。
		expect(getEnvApiKey("anthropic")).toBeUndefined();
	});

	// 只给OAuth兼容变量时，两个助手分别返回该名字和oauth-token；不进行登录或刷新来获得它。
	it("preserves ANTHROPIC_OAUTH_TOKEN as an API key", () => {
		// 移除Bearer干扰项。
		delete process.env.ANTHROPIC_AUTH_TOKEN;
		// 写入唯一希望采用的OAuth兼容值。
		process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-token";
		// 移除普通key以孤立此来源。
		delete process.env.ANTHROPIC_API_KEY;

		// 发现列表仅含OAuth变量名字。
		expect(findEnvKeys("anthropic")).toEqual(["ANTHROPIC_OAUTH_TOKEN"]);
		// 实际key结果与该变量文字一致。
		expect(getEnvApiKey("anthropic")).toBe("oauth-token");
	});

	// 前两种Anthropic来源都缺失时，普通API key补位；例返回api-key。此例只断言值，未额外断言发现数组。
	it("falls back to ANTHROPIC_API_KEY for API key lookup", () => {
		// 删Bearer变量，明确没有较前的状态来源。
		delete process.env.ANTHROPIC_AUTH_TOKEN;
		// 删OAuth变量，强制走普通key候选。
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
		// 设置普通API key假值。
		process.env.ANTHROPIC_API_KEY = "api-key";

		// 精确要求api-key，验证本地回退选择。
		expect(getEnvApiKey("anthropic")).toBe("api-key");
	});
});
