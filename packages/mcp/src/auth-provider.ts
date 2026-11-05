// 定义HTTP传输与认证提供者之间的契约：传输在请求前取得令牌，遇指定认证挑战可让提供者恢复凭证。本文件全是类型声明，不在导入时读令牌、刷新网络或开浏览器。
// McpFetch是可注入的请求函数类型，输入字符串/URL及可选RequestInit，返回Promise<Response>；例：可传兼容的fetch包装器，类型本身不发请求或检查HTTP状态。
export type McpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

// 传给onUnauthorized的上下文数据；实际由HTTP传输组装，OAuth适配器可利用其中的挑战/旧令牌决定恢复策略。
export interface UnauthorizedContext {
	/** The 401 response, or a 403 response whose challenge reports `insufficient_scope`. */
	// 原始失败Response，当前传输只对401或带insufficient_scope的403调用恢复；不是任意403都交给提供者，读取其头/正文是使用方的动作。
	response: Response;
	// 当前MCP服务器URL对象，供发现认证资源等使用；接口没有自动复制或检查可信域。
	serverUrl: URL;
	// 与传输一致的请求函数，可供认证发现/刷新使用；函数调用仍可产生网络副作用并拒绝，不是返回已缓存响应的只读查询。
	fetch: McpFetch;
	/** Access token the rejected request carried, if any. A different current token means another request already refreshed it. */
	// 被拒绝请求关联的可选令牌字符串；OAuth适配器可与当前值比较避免重复刷新。这里只传凭证快照，不保证它仍有效，也不保证提供者一定会使用这个字段。
	token?: string;
}

/** Supplies bearer tokens to an MCP HTTP transport and may refresh them after a 401 response. */
// 认证提供者接口，外部可以自定义实现，OAuth的adaptOAuthProvider是其中一种。它没有自动带存储/锁/刷新策略，也没有运行时保证实现一定不抛错。
export interface AuthProvider {
	/**
	 * Token for the next request. May refresh it over the network first, so the transport calls it only
	 * before requests whose answer it waits for. Closing a session reuses the token of the last request.
	 */
	// 无参数异步取得下次请求的令牌，返回字符串或undefined；例：token:async()=>cachedToken。实现可先读存储/刷新再返回，HTTP会await它；失败可使请求拒绝。
	// 当前HTTP请求包括通知/响应的POST和GET流开/重开，也会先取令牌，不仅tools/call；关闭会话的DELETE直接复用lastToken不再调用这里。lastToken是在最近一次headers()取值后保存，未要求那次请求已成功发出或返回成功。
	token(): Promise<string | undefined>;
	// 可选恢复方法，接收失败请求上下文，返回完成Promise；例：401后更新缓存令牌，HTTP再调用token重试一次。方法缺省就不进行该恢复，拒绝则失败向上传播。
	// 提供者自己负责恢复/并发共享或要求用户登录，接口并未实现这些动作；HTTP在恢复后检查发送者signal避免迟到派发，但不会借此强制中断共享认证恢复。
	onUnauthorized?(context: UnauthorizedContext): Promise<void>;
}
