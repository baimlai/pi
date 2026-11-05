// pi-ai 的核心公开入口：重导出类型、模型集合、凭证接口及通用工具；不在入口自动安装完整供应商目录。
// Core only, side-effect free: no generated catalogs, no provider factories,
// no api-registry, no OAuth implementations, no compat. Provider factories
// live under "@earendil-works/pi-ai/providers/*", API implementations under
// "@earendil-works/pi-ai/api/*", the old global API under
// "@earendil-works/pi-ai/compat".
// 以下 export type 只公开各 API 的参数类型，不在运行时加载它们的实现模块。
export type { AnthropicEffort, AnthropicOptions, AnthropicThinkingDisplay } from "./api/anthropic-messages.ts";
// Azure Responses 参数类型。
export type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.ts";
// Bedrock 参数与推理显示类型。
export type { BedrockOptions, BedrockThinkingDisplay } from "./api/bedrock-converse-stream.ts";
// Google Generative AI 参数类型。
export type { GoogleOptions } from "./api/google-generative-ai.ts";
// Google 思考级别的原生/解析后类型。
export type { GoogleApiThinkingLevel, ResolvedGoogleThinkingLevel } from "./api/google-shared.ts";
// Vertex 参数类型。
export type { GoogleVertexOptions } from "./api/google-vertex.ts";
// export * 转发 lazyStream/lazyApi 等公开运行值与类型，实际加载时机由工厂决定。
export * from "./api/lazy.ts";
// Mistral 参数仅作类型导出。
export type { MistralOptions } from "./api/mistral-conversations.ts";
// Codex Responses 配置与调试统计类型，不在此建立 WebSocket。
export type { OpenAICodexResponsesOptions, OpenAICodexWebSocketDebugStats } from "./api/openai-codex-responses.ts";
// Completions 协议参数类型。
export type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
// Responses 协议参数类型。
export type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
// pi-messages 的事件/请求类型，不安装协议实现。
export type { PiMessagesEvent, PiMessagesOptions, PiMessagesRewriteImpact } from "./api/pi-messages.ts";
// 默认认证上下文工厂，如环境读取/文件存在性能力。
export * from "./auth/context.ts";
// 内存凭证存储等实现，导出不等于已经持有某个用户秘密。
export * from "./auth/credential-store.ts";
// 通用认证辅助函数。
export * from "./auth/helpers.ts";
// 凭证与登录/刷新接口类型及其公共导出。
export * from "./auth/types.ts";
// 兼容扩展 OAuth 交互类型也仅转导出类型，下面各项不会启动登录流程。
export type {
	OAuthAuthInfo,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthSelectOption,
	OAuthSelectPrompt,
} from "./compat/extension-oauth-types.ts";
// Provider/Models 集合工厂、模型能力查询、费用/思考辅助等核心能力。
export * from "./models.ts";
// 模型目录缓存契约和内存实现。
export * from "./models-store.ts";
// 可控 faux 提供商用于本地测试/演示；不会自动改真实供应商注册。
export * from "./providers/faux.ts";
// 按会话 id 登记和清理资源的通用机制。
export * from "./session-resources.ts";
// 消息、模型、请求参数与流事件的统一类型。
export * from "./types.ts";
// 诊断数据的整理/格式化工具，不代表已主动记录某次错误。
export * from "./utils/diagnostics.ts";
// 异步事件流和最终结果 Promise 的公共类/工厂。
export * from "./utils/event-stream.ts";
// 调用应用身份及供应商归因头的合并逻辑。
export * from "./utils/identity.ts";
// 模型工具参数 JSON 的解析/修复工具。
export * from "./utils/json-parse.ts";
// 上下文溢出与长度截断的错误识别。
export * from "./utils/overflow.ts";
// 重试策略、退避和调用包装函数，导入不会启动计时器。
export * from "./utils/retry.ts";
// 增量 JSON 文本解析辅助。
export * from "./utils/streaming-json.ts";
// 字符串枚举 schema 辅助，不是 TypeScript enum 语法。
export * from "./utils/string-enum.ts";
// 只公开这三个文字提取/渲染函数，其余该模块名字不由这行转发。
export { contentText, getSystemMessageText, renderSystemMessageUpdate } from "./utils/text.ts";
// system 章节/工具增删的重放和上下文规范化。
export * from "./utils/transcript.ts";
// 只公开 UUIDv7 生成函数，调用时才生成标识。
export { uuidv7 } from "./utils/uuid.ts";
// 工具参数 schema 校验函数，类型声明本身不代替这些运行时检查。
export * from "./utils/validation.ts";
// 公开包版本常量，不在这里执行版本联网检查。
export { PI_AI_VERSION } from "./utils/version.ts";
