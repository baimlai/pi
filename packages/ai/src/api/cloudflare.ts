/**
 * Cloudflare 各协议共用的端点模板，供目录生成/请求适配层引用；只有字符串常量，不创建客户端或发请求。
 * 例账户 a、网关 g 可把模板里的两种花括号替换掉；实际请求时由 cloudflare-stream 的 wrapper 使用已解析 env 完成。
 * Workers AI 的 OpenAI 兼容 /ai/v1 与模型运行 REST /ai 是不同根；网关也区分 compat、OpenAI、Anthropic 透传入口。
 * 这里保留仓库既有路由约定，不据注释推断远端当前支持的所有 API，也不检查模板替换后 URL/认证是否有效。
 */
/** Workers AI direct endpoint. */
// OpenAI 兼容聊天根；账户尚未填入，不可把占位符当真实账户发送。
export const CLOUDFLARE_WORKERS_AI_BASE_URL =
	"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1";

/** Workers AI REST endpoint root; model runs are posted to `run`. */
// REST 模型运行根；分类适配器据此追加 /run，不再经 /v1/chat/completions。
export const CLOUDFLARE_WORKERS_AI_REST_BASE_URL =
	"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai";

/** AI Gateway Unified API. https://developers.cloudflare.com/ai-gateway/usage/unified-api/ */
// 网关统一兼容入口同时要 account/gateway，两者是路由配置，不是上游模型 key。
export const CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL =
	"https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat";

/** AI Gateway → OpenAI passthrough. Used until /compat supports /v1/responses. */
// 仓库的 OpenAI 透传根，供 Responses 等适配器追加自身路径；本模块不做 compat 失败后自动重试切换。
export const CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL =
	"https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai";

/** AI Gateway → Anthropic passthrough. */
// Anthropic 原生协议透传根，后续仍按 Anthropic 适配器的消息与请求路径规则发送。
export const CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL =
	"https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic";
