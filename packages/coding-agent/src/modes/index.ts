// 汇总三种运行模式及JSON/RPC公开契约；值重导出会建立对应模块依赖，type重导出只参与TS检查。
/**
 * Run modes for the coding agent.
 */

// 交互TUI类与其构造选项；导出类本身不启动交互界面。
export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.ts";
// stdout事件经过瘦身后的协议类型，不是完整内存事件快照。
export type { JsonAgentSessionEvent } from "./json-event.ts";
// print/text或JSON事件流模式；函数调用时才发送输入和处理退出。
export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";
// 外部程序使用的RPC子进程客户端及监听/模型展示类型；RpcClient.start才实际启动node。
export { type ModelInfo, RpcClient, type RpcClientOptions, type RpcEventListener } from "./rpc/rpc-client.ts";
// 从stdin收协议命令的服务端模式运行函数。
export { runRpcMode } from "./rpc/rpc-mode.ts";
// 纯类型重导出：外部应用可据此检查编写的命令/结果，运行时wire输入仍须看服务端实际校验。
export type {
	// 发往服务端的命令联合，通常用type收窄。
	RpcCommand,
	// 服务端要求宿主展示选择框/通知/编辑器等的事件。
	RpcExtensionUIRequest,
	// 宿主按请求id回传的值/确认/取消结果。
	RpcExtensionUIResponse,
	// 命令成功/失败响应，不等于模型流的最终回答。
	RpcResponse,
	// get_state返回的当前会话字段集合。
	RpcSessionState,
} from "./rpc/rpc-types.ts";
