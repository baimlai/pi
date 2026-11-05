import { describe, expect, it } from "vitest";
import { streamSimple as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { streamSimple as streamAzure } from "../src/api/azure-openai-responses.ts";
import { streamSimple as streamGoogle } from "../src/api/google-generative-ai.ts";
import { streamSimple as streamMistral } from "../src/api/mistral-conversations.ts";
import { streamSimple as streamCodex } from "../src/api/openai-codex-responses.ts";
import { streamSimple as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { streamSimple as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Api, AssistantMessageEventStream, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// 按输入 API 构造零价格聊天模型并返回，无网络或注册副作用；例如 model("openai-responses") 保留该协议的静态类型。
// TApi extends Api 是泛型约束：传入的协议类型同时用于返回的 Model<TApi>，不在运行时校验协议存在。
function model<TApi extends Api>(api: TApi): Model<TApi> {
	// 每次新建对象；URL 使用保留的 invalid 域，本组预期会在任何请求发生前抛错。
	return {
		// 固定 id/显示名，不从内置目录取真实模型。
		id: "test-model",
		name: "Test",
		// 属性简写保留输入协议；自定义 provider 也避免触发 Anthropic 专属联邦认证环境解析。
		api,
		provider: "test-provider",
		// 只提供请求元数据，不会在构造对象时打开连接。
		baseUrl: "https://example.invalid",
		// 不启用思考，只允许文字输入。
		reasoning: false,
		input: ["text"],
		// 四项单位费率为零；本组没有任何模型用量。
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// 数字中的 _ 只是分隔符，给完整模型类型补齐容量字段。
		contextWindow: 1_000,
		maxTokens: 100,
	};
}

// 输入创建事件流的无参回调，断言它同步抛缺认证错误，返回 void；例 () => streamSimple(...,{})。
// 不等待 result() 或遍历流：如果实现只把错误放进返回流，这个断言会失败，正是要守住的区别。
function expectMissingAuthThrows(create: () => AssistantMessageEventStream): void {
	// 传回调本身让 toThrow 调用并捕获异常；只匹配错误正文中的供应商提示，不检查所有错误属性。
	expect(create).toThrow("No API key for provider: test-provider");
}

// 注册直接 API 入口的认证契约；不会调用高层 Provider 凭证解析器或真实登录。
describe("direct API authentication", () => {
	// 七种简单入口都必须在返回流前拒绝空认证；无参数返回 void，各回调只被断言调用一次。
	it("throws synchronously when auth is missing", () => {
		// 将原始空 Context 标记为规范上下文；无提示词/工具时 messages 仍为空。
		const context = normalizeContext({ messages: [] });
		// Anthropic 分支使用自定义 provider，所以不会自动寻找 anthropic 的联邦配置。
		expectMissingAuthThrows(() => streamAnthropic(model("anthropic-messages"), context, {}));
		// Azure 的 streamSimple 只接受显式请求认证，本例空对象没有 apiKey。
		expectMissingAuthThrows(() => streamAzure(model("azure-openai-responses"), context, {}));
		// Google 同样在调用其网络 stream 之前检查缺 key。
		expectMissingAuthThrows(() => streamGoogle(model("google-generative-ai"), context, {}));
		// Mistral 的简单入口也要同步拒绝。
		expectMissingAuthThrows(() => streamMistral(model("mistral-conversations"), context, {}));
		// Codex 在此测试的是未给 token，不尝试刷新 OAuth 或建立 WebSocket。
		expectMissingAuthThrows(() => streamCodex(model("openai-codex-responses"), context, {}));
		// Completions 可另从显式授权头获取认证，但本例 headers 也未提供。
		expectMissingAuthThrows(() => streamOpenAICompletions(model("openai-completions"), context, {}));
		// Responses 保持同样的同步失败边界；本例不覆盖 key 存在但无效时的服务端错误。
		expectMissingAuthThrows(() => streamOpenAIResponses(model("openai-responses"), context, {}));
	});
});
