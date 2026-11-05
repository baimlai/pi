// MCP主入口集中导出客户端、协议内容/消息/工具类型及stdio和HTTP传输；OAuth和内存测试辅助另有/oauth、/testing子入口。例：从@earendil-works/pi-mcp导入McpClient、StreamableHttpTransport。
// 重导出让外部使用稳定入口，不在这里new客户端/启动传输；运行时值对应模块仍会加载，type标记的导出在JS擦除，类型不是自动输入验证。
// AuthProvider描述取令牌/可选认证恢复方法，McpFetch是可注入请求函数类型，UnauthorizedContext提供失败响应/目标/旧token等恢复上下文；此行只导出这些类型，不读取凭据。
export type { AuthProvider, McpFetch, UnauthorizedContext } from "./auth-provider.ts";
// 导出McpClient类与两种选项类型：前者管理连接/请求，Options控制客户端能力与缺省值，RequestOptions控制单次请求；只有显式connect/request才进入相应流程。
export { McpClient, type McpClientOptions, type McpRequestOptions } from "./client.ts";
// 这一组公开内容块的数据类型及一个实际转换函数，所有type成员在JS里擦除。
export {
	// 音频内容的MIME类型和base64数据字段类型，不负责解码播放。
	type AudioContent,
	// 二进制资源正文类型，区别于文本资源正文。
	type BlobResourceContents,
	// 工具调用结果类型，含content及可选structuredContent/isError等字段。
	type CallToolResult,
	// 内容注解类型，用于受众/优先级等元信息，不自动执行策略。
	type ContentAnnotations,
	// 内容块联合类型，按各type标签区分文本/图像/音频/资源等。
	type ContentBlock,
	// 嵌入资源内容块类型，内部包含资源正文对象。
	type EmbeddedResourceContent,
	// 图像内容类型，字段声明不自动解析图片字节。
	type ImageContent,
	// 模型侧转换结果类型，只含文本和图像；输入音频会转省略说明文字，不输出audio块。
	type LlmContent,
	// 资源链接内容类型，引用URI而非已下载正文。
	type ResourceLinkContent,
	// 文本内容块类型。
	type TextContent,
	// 文本资源正文类型，含URI与文本等字段。
	type TextResourceContents,
	// 实际转换工具内容到LlmContent的函数，部分资源转文字/媒体，不负责向模型发送请求。
	toLlmContent,
} from "./protocol/content.ts";
// 这一组公开JSON-RPC的局部守卫、类型、错误和解析入口；不等于完整协议schema验证器。
export {
	// 判断消息是否满足本地通知形状，名字不是执行通知。
	isJsonRpcNotification,
	// 判断消息是否满足本地请求形状。
	isJsonRpcRequest,
	// 判断消息是否满足本地响应形状，成功/失败字段检查范围看实际守卫。
	isJsonRpcResponse,
	// 标准JSON-RPC错误码数值表，是运行时常量对象而非TS enum。
	JSON_RPC_ERROR_CODES,
	// 响应error中的code/message/可选data对象类型。
	type JsonRpcErrorObject,
	// 失败响应类型，区别于成功result响应。
	type JsonRpcErrorResponse,
	// 允许的请求/响应ID类型，不负责分配唯一ID。
	type JsonRpcId,
	// JSON-RPC请求/通知/响应的联合类型。
	type JsonRpcMessage,
	// 通知类型，无请求ID，不自动等待业务回复。
	type JsonRpcNotification,
	// 请求类型，携带id/method及可选params。
	type JsonRpcRequest,
	// 成功或失败响应联合。
	type JsonRpcResponse,
	// 成功result响应类型。
	type JsonRpcSuccessResponse,
	// 请求取消/发送者不再等待时使用的本地错误类。
	McpAbortError,
	// 连接不可用/关闭时使用的错误类。
	McpConnectionClosedError,
	// 封装JSON-RPC错误码/data的通用MCP错误类。
	McpError,
	// 请求等待超时时使用的本地错误类。
	McpTimeoutError,
	// 对已解码unknown值作局部消息结构检查，成功返回原引用；不解析JSON文本、不执行method，检查失败会抛错。
	parseJsonRpcMessage,
} from "./protocol/jsonrpc.ts";
// 重导出初始化、能力、工具、资源、进度等协议契约和本地支持版本常量。
export {
	// 取消通知参数类型，只描述requestId/可选reason，不直接撤销执行。
	type CancelledNotification,
	// 客户端声明的能力类型，不代表服务器已经同意或启用这些能力。
	type ClientCapabilities,
	// 实现名称/版本等标识类型。
	type Implementation,
	// 初始化请求参数类型，含客户端信息与能力。
	type InitializeParams,
	// 初始化响应结果类型，含协商版本/服务器信息/能力。
	type InitializeResult,
	// 本地默认最新协议版本字符串，非运行时从网络查询。
	LATEST_PROTOCOL_VERSION,
	// 资源列表分页结果类型。
	type ListResourcesResult,
	// 资源模板列表分页结果类型。
	type ListResourceTemplatesResult,
	// 工具列表分页结果类型。
	type ListToolsResult,
	// 进度通知参数类型，是否重置请求超时由客户端实际策略决定。
	type ProgressNotification,
	// 读取资源返回的正文集合类型，不在此获取URI。
	type ReadResourceResult,
	// 资源描述类型，与实际资源正文不同。
	type Resource,
	// URI模板资源描述类型，不自动展开或请求模板。
	type ResourceTemplate,
	// 客户端root描述类型，声明并不自动提供服务器文件系统权限。
	type Root,
	// 服务器能力类型，只有收到并使用实际初始化结果才有相应快照。
	type ServerCapabilities,
	// 本地支持的版本列表运行时常量，不是所有服务器都支持的保证。
	SUPPORTED_PROTOCOL_VERSIONS,
	// 从支持版本清单推导出的TS版本联合。
	type SupportedProtocolVersion,
	// 工具名称/输入schema等描述类型，类型本身不执行工具。
	type Tool,
	// 工具行为注解类型，不自动沙箱或证明工具安全。
	type ToolAnnotations,
	// 工具执行相关协议元信息类型，是否执行任务行为仍取决于实际实现。
	type ToolExecution,
} from "./protocol/types.ts";
// 导出stdio传输类及选项类型，显式start会启动子进程；本行只导出，不代表现在运行命令。
export { StdioTransport, type StdioTransportOptions } from "./transports/stdio.ts";
// 公开HTTP传输及其状态错误类/选项，OAuth适配器从另一个子入口导入。
export {
	// HTTP认证挑战仍需处理时使用的错误类。
	McpAuthRequiredError,
	// 非成功HTTP响应的一般错误类，含状态/正文诊断信息。
	McpHttpError,
	// 已有HTTP会话过期的专用错误类，不等于本地token到期。
	McpSessionExpiredError,
	// 支持POST/可选GET SSE与会话管理的实际传输类；start只设本地启动标记，send才发送HTTP，之后可按配置启动GET流。
	StreamableHttpTransport,
	// HTTP URL/头/fetch/认证/流恢复等选项类型。
	type StreamableHttpTransportOptions,
} from "./transports/streamable-http.ts";
// 整个块仅重导出传输契约类型，实际底座TransportEvents没有在这个主入口导出。
export type {
	// start/send/close和订阅方法的共同接口，不自动给每个实现相同取消/重试行为。
	McpTransport,
	// 无参数关闭事件回调类型。
	McpTransportCloseListener,
	// 接收Error的错误事件回调类型。
	McpTransportErrorListener,
	// 接收JsonRpcMessage的消息事件回调类型，void不意味着会await异步监听器。
	McpTransportMessageListener,
	// 单次send的可选signal等控制类型，具体实现是否读取由实现决定。
	McpTransportSendOptions,
} from "./transports/transport.ts";
