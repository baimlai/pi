// 所属：packages/chord/src/node/http，Chord v2 HTTP 组件的公开 barrel；应用通过 "@earendil-works/chord/http"
// 导入（slice 10 §2）。这是 Node-only 入口，可选 peer 依赖 ws 只在升级路径中使用。
// 职责边界：本文件没有实现，只重新导出同目录模块的类型和运行时值；它决定应用可见的 HTTP API 面，
// 不改变任何行为，也不做错误转换。
// 上游入口：应用、测试和示例从包导出映射加载此入口。下游依赖：admission、authenticate、cookies、file、
// headers、http、node、request、response、router、upgrades 十一个实现文件。
// 结果与错误流向：运行时值（createHttp、cookie、fileResponse、HttpFailure、HttpListener、nodeRequest、Http）
// 直接来自各模块；类型在编译期擦除。错误语义由被导出模块决定，本文件不捕获也不包装。
// 能力清单：
// - Connection / Provenance：连接信息与请求来源分类（local/remote/relayed）；
// - Authenticator / Authenticators：单个认证函数类型与认证器注册表令牌；
// - CookieOptions / cookie / readCookie / readSignedCookie：签名 cookie 的生成与读取；
// - FileResponseOptions / fileResponse：把磁盘文件包装成 bytes 响应；
// - createHttp / HttpOptions / LinksOptions / HttpError / HookName / HttpComponent / HttpListener：
//   组件入口、应用设置、错误与钩子名、运行中组件接口、监听器本地契约；
// - ListenAddress / NodeRequest / nodeRequest：监听地址与挂载到第三方 Node 服务器时的请求转换；
// - HttpRequest / HttpFailure / HttpResponse：路由看到的请求、带状态码的失败、响应描述；
// - Http / HttpContribution / HttpRoute / HttpRouteOptions / HttpWrap / WrapPhase / HttpSocket /
//   WebSocketHandle / HttpRelay / Router：路由注册表令牌、贡献形状、路由/包装器/套接字/中继类型；
// - LinkOptions：链接端点每个套接字的分片限制与最大帧。
// 组合关系：应用先 createHttp(host, options, context) 得到组件，把 http.facet 交给宿主；需要时把 http.upgrade
// 挂到自己的 Node server；路由处理函数再直接使用 cookie/fileResponse 等辅助函数。Http 注册表由插件贡献。
// 示例：import { createHttp, cookie, fileResponse } from "@earendil-works/chord/http";
// 建议阅读顺序：先看 createHttp/HttpComponent 的签名，再沿请求路径读 http.ts -> admission.ts -> router.ts ->
// request.ts -> response.ts；需要认证、文件、cookie 或升级时再读对应模块。
// Chord v2's HTTP component (`@earendil-works/chord/http`, slice 10 §2): a Web-standard `fetch` handler built
// from the routes, wraps and sockets plugins contribute to the registry `Http`, with the security baseline on by
// default, Chord's own Node listener, a Node upgrade adapter and the Node request conversion for apps that mount it.
// Node-only; `ws` is an optional peer dependency, imported only here.

// 来源判定相关：Provenance 说明请求来自本地回环、允许域名还是受信中继；Connection 是监听器看到的套接字信息。
// 这两个名字通常只用于类型标注，运行时对象由 admit 或 Node 适配器产生。
export type { Connection, Provenance } from "./admission.ts";
// 认证相关：Authenticator 是单个认证函数类型，Authenticators 是插件贡献认证器的注册表令牌；
// 组件按注册表顺序询问认证器，细节见 authenticate.ts。
export { type Authenticator, Authenticators } from "./authenticate.ts";
// Cookie 相关：cookie 生成带签名的 Set-Cookie 文本，readCookie/readSignedCookie 读取并验签；
// 它们只在已解析的请求和响应头之间搬运文本，不直接操作浏览器。
export { type CookieOptions, cookie, readCookie, readSignedCookie } from "./cookies.ts";
// 文件响应：fileResponse 把磁盘文件包装成 bytes 响应描述，按需打开文件句柄；
// 权限边界（root）和 404/403 语义由该模块负责。
export { type FileResponseOptions, fileResponse } from "./file.ts";
// 组件主体：createHttp 根据应用设置和注册表构建 fetch 处理器、Node 升级适配器和生命周期 facet；
// 同时导出选项、错误联合、钩子名、监听器本地契约和链接端点选项等类型。
// 这些名字里只有 createHttp 和 HttpListener 有运行时值，其余是编译期类型。
export {
	createHttp,
	type HookName,
	type HttpComponent,
	type HttpError,
	HttpListener,
	type HttpOptions,
	type LinksOptions,
} from "./http.ts";
// Node 适配：ListenAddress 描述监听地址，NodeRequest 是挂载到第三方 Node 服务器时转换后的结果，
// nodeRequest 负责把 IncomingMessage/ServerResponse 转成 Web Request 或明确的拒绝状态。
export { type ListenAddress, type NodeRequest, nodeRequest } from "./node.ts";
// 请求与失败：HttpRequest 是路由看到的请求形状，HttpFailure 携带会被组件转换成 HTTP 状态码的错误。
export { HttpFailure, type HttpRequest } from "./request.ts";
// 响应描述：HttpResponse 是路由返回的联合类型（json/html/bytes/redirect/error），由组件翻译成实际响应。
export type { HttpResponse } from "./response.ts";
// 路由注册表：Http 是 "chord.http" 注册表令牌，HttpContribution 是插件贡献的 routes/wraps/sockets 等配置，
// 其余类型描述路由、选项、包装器、套接字处理、中继和阶段；composeRouter 不在此重新导出，属于组件内部。
export {
	Http,
	type HttpContribution,
	type HttpRelay,
	type HttpRoute,
	type HttpRouteOptions,
	type HttpSocket,
	type HttpWrap,
	type Router,
	type WebSocketHandle,
	type WrapPhase,
} from "./router.ts";
// 升级连接：LinkOptions 指定链接端点每个套接字的分片限制和最大帧大小；
// 插件套接字的类型在上面的 HttpSocket/WebSocketHandle 中导出。
export type { LinkOptions } from "./upgrades.ts";
