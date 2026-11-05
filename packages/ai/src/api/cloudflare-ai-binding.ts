/**
 * 把 Worker 的 AI binding.fetch 包装成 Pi 请求可注入的 fetch，供已经指向 binding 路由的模型使用。
 * 例模型 baseUrl 已是 https://workers-binding.ai/.../anthropic，createAiBindingFetch(env.AI) 只转交请求，不把普通 HTTPS 网关 URL 自动换成该地址。
 * 工厂检查 fetch 成员并绑定 this，返回值不复制/缓存正文，不改方法、头、query 或返回 Response；取消/超时仍取决于调用方和 binding。
 * 本文件用结构接口避开 Cloudflare 类型包依赖；只检查函数存在，不验证 binding 真实身份、账户/网关权限或后端剥头行为。
 */
/**
 * AI Gateway transport over the Workers AI binding.
 *
 * pi's Cloudflare AI Gateway support speaks HTTPS
 * (`gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}/...`, see `api/cloudflare.ts`),
 * which needs a Cloudflare API token even when the caller is a Worker in the gateway's own
 * account.
 *
 * A Worker avoids that token by talking to the gateway through the AI binding's `fetch`
 * passthrough (`env.AI.fetch()`), which serves the gateway's provider passthrough at
 * `https://workers-binding.ai/ai-gateway/gateways/{gateway}/{provider}/{endpoint...}` — the same
 * shape as the HTTPS URL, minus the account id (the binding channel carries identity). Binding
 * calls are pre-authenticated in-account and return the provider's native wire format as a
 * regular (streaming) `Response`, so API implementations behave identically over either
 * transport.
 *
 * A model whose `baseUrl` names that route therefore needs no translation: point it there and
 * pass {@link createAiBindingFetch} as the request `fetch`. Nothing is rewritten, buffered or
 * re-encoded — method, headers, query string and the body stream go to the binding as they
 * arrive, so every method, non-JSON body and streaming request body works.
 *
 * The only thing this module adds over calling `env.AI.fetch()` yourself is a type: `Ai#fetch`
 * exists at runtime (`workerd/src/cloudflare/internal/ai-api.ts:158`) but
 * `@cloudflare/workers-types`' `Ai` class does not declare it yet, so calling it directly means
 * casting the binding at every call site. {@link AiBinding} takes the cast instead — declare
 * `fetch` optional, check it once at construction — so `env.AI` can be passed as-is. Once
 * workers-types declares `fetch`, the optional marker and the runtime check both go away.
 */

// 复用宿主 fetch 函数签名；纯类型导入，不加载 Cloudflare SDK 或开启网络请求。
import type { FetchFunction } from "../types.ts";

/**
 * The Workers AI binding (`env.AI`), described structurally so this module does not depend on
 * `@cloudflare/workers-types`.
 *
 * `fetch` is optional only because the published `Ai` type doesn't declare it yet — every real
 * binding has it at runtime. `aiGatewayLogId` is here to pin the type to the AI binding: it is
 * the one member unique to `Ai`, so without it this interface would also accept an `AiGateway`
 * or any hand-rolled `{ fetch }` object, which is exactly the mistake the runtime check reports
 * late.
 */
/**
 * 本模块需要的 binding 最小结构；例如测试也可手工实现这两个成员，不是某种不可伪造的实例品牌。
 * aiGatewayLogId 让正常 TS 调用更贴近 AI binding 外形，本工厂并不读取/核验它；fetch 可选使缺能力的运行环境可在构造时明确报错。
 * 上方英语解释此兼容接口的设计背景；这里不在运行时探测 Cloudflare SDK 版本或保证任意绑定实例一定有 fetch。
 */
export interface AiBinding {
	// 日志 ID 可是字符串或 null；不是请求认证 token，也不由此文件赋值/更新。
	aiGatewayLogId: string | null;
	// 可选方法接标准请求输入/配置，返回 Response Promise；? 不会自动生成实现或兜底网络请求。
	fetch?(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

/**
 * Placeholder value for auth headers on binding-routed requests. API implementations
 * require an API key or a recognized auth header (`authorization`, `x-api-key`,
 * `cf-aig-authorization`) before dispatch; binding calls are pre-authenticated, so pass
 * `cf-aig-authorization: Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}` to satisfy
 * the check. The gateway ignores (and strips) `cf-aig-authorization` on binding-routed
 * requests. Pair it with `Authorization: null` / `x-api-key: null` so the SDKs' placeholder
 * auth headers never reach the gateway, which would treat a request-supplied auth header as a
 * BYOK provider key that overrides its stored keys — the same as it would over HTTPS.
 */
// 固定占位文字，供本地适配器的认证来源检查使用，不是真实 Cloudflare/upstream key；本模块不自行加头、删头或向网关证明身份。
export const CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL = "cloudflare-gateway-binding";

/**
 * Create a `fetch` backed by the AI binding, for models whose `baseUrl` already names a route
 * the binding serves — including the gateway's provider passthrough,
 * `https://workers-binding.ai/ai-gateway/gateways/{gateway}/{provider}/...`. Requests pass
 * through untouched.
 *
 * ```ts
 * const model = {
 *   // ...
 *   baseUrl: `https://workers-binding.ai/ai-gateway/gateways/${gateway}/anthropic`,
 * };
 * await models.complete(model, context, {
 *   headers: {
 *     "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
 *     Authorization: null,
 *     "x-api-key": null,
 *   },
 *   fetch: createAiBindingFetch(env.AI),
 * });
 * ```
 */
/**
 * 接一个结构上符合 AiBinding 的对象，确认 fetch 是函数后 bind(binding)，返回可作 options.fetch 的透传函数。
 * 例传入一个内存 fetch 返回 Response("{}") 的对象，调用返回函数会得到该同一 Response，工厂本身不发送请求。
 * 缺 fetch 立即同步抛 TypeError；实际请求的同步异常/Promise 拒绝原样传播，不自动退回 globalThis.fetch。
 * 返回闭包保存绑定后的方法，之后改 binding.fetch 不会使它自动换实现；不 URL 改写、不读/重编码正文、不安排重试或 timeout。
 * 上方示例的 sentinel/null 头需由调用者配置，实际后端鉴权/剥头是外部协议，不由本包装器执行或保证。
 */
export function createAiBindingFetch(binding: AiBinding): FetchFunction {
	// `fetch` is optional on the type, so its presence is checked here — early, rather than as a
	// confusing failure on the first inference request.
	// 本模块能力边界只验证可选成员是函数，不验证其返回值/签名实现或 aiGatewayLogId。
	if (typeof binding.fetch !== "function") {
		// 在构造工厂时拒绝缺能力对象，不等第一次模型请求才失败。
		throw new TypeError("createAiBindingFetch: the AI binding does not expose fetch()");
	}
	// Bound eagerly: `fetch` is a mutable property, so the narrowing above would not survive into
	// the returned closure.
	// bind 固定方法调用时的 this 为 binding，避免作为普通 fetch 回调调用时丢失接收者。
	const bindingFetch = binding.fetch.bind(binding);
	// 两参数原样转发并直接返回内层 Promise；不是 async 再包一层，也不会消费 Response 的流。
	return (input, init) => bindingFetch(input, init);
}
