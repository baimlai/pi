// Bun独立二进制的静态OAuth装配：让编译器看见每个实际flow模块，再把工厂表交共享loader。
// import会加载各模块依赖图，不是纯类型导入；本文件函数调用只登记方法工厂，不自动登录/刷新或开浏览器。
// Anthropic对象包含该提供商的登录/刷新等方法，稍后load函数才取它。
import { anthropicOAuth } from "./auth/oauth/anthropic.ts";
// Copilot设备码认证方法对象。
import { githubCopilotOAuth } from "./auth/oauth/github-copilot.ts";
// Kimi Coding认证方法对象。
import { kimiCodingOAuth } from "./auth/oauth/kimi-coding.ts";
// 保存整张静态工厂表的setter，不按键增量合并。
import { registerBundledOAuthFlowLoaders } from "./auth/oauth/load.ts";
// Meta认证方法对象。
import { metaOAuth } from "./auth/oauth/meta.ts";
// OpenAI ChatGPT直连flow，区别于下一行Codex。
import { openaiChatGPTOAuth } from "./auth/oauth/openai-chatgpt.ts";
// OpenAI Codex认证flow对象。
import { openaiCodexOAuth } from "./auth/oauth/openai-codex.ts";
// OpenRouter授权换key的flow对象。
import { openRouterOAuth } from "./auth/oauth/openrouter.ts";
// Radius是接{name,gateway}的工厂，不是单个固定网关对象。
import { createRadiusOAuth } from "./auth/oauth/radius.ts";
// xAI认证方法对象。
import { xaiOAuth } from "./auth/oauth/xai.ts";

/** Register OAuth flows statically embedded in the standalone Bun binary. */
// 注册二进制已经静态打包的9个OAuth工厂，无参数/返回；例Bun runtime-setup调用一次后loader不必走变量动态import。
// 每次替换整表，登记本身不执行各箭头/Radius工厂；实际login/refresh仍需后续显式调用，错误传播属于后续流程。
export function registerBunOAuthFlows(): void {
	// 对象整体交给registry setter，按引用保存，不深复制/冻结。
	registerBundledOAuthFlowLoaders({
		// 箭头无参数，稍后返回同一个Anthropic flow对象。
		anthropic: () => anthropicOAuth,
		// Codex loader返回对应静态对象。
		openaiCodex: () => openaiCodexOAuth,
		// ChatGPT loader返回独立对象，没被Codex覆盖。
		openaiChatGPT: () => openaiChatGPTOAuth,
		// Copilot loader不在此开始轮询设备码。
		githubCopilot: () => githubCopilotOAuth,
		// OpenRouter loader返回已导入对象。
		openrouter: () => openRouterOAuth,
		// Kimi loader返回已导入对象。
		kimiCoding: () => kimiCodingOAuth,
		// Meta loader同样延迟取方法对象，不在登记时请求。
		meta: () => metaOAuth,
		// xAI loader返回其flow。
		xai: () => xaiOAuth,
		// 直接保存Radius工厂函数引用，调用方稍后传name/gateway再造具体flow，不在此写死唯一网关。
		radius: createRadiusOAuth,
	});
}
