/**
 * 不引入Node内建模块的公共入口，面向浏览器/Cloudflare等环境：可选调用线程VM或远端VM。
 * 例导入InlineCodemodeSandbox并传已编译wasm；此入口不从磁盘加载WASM，也不导出Node worker沙箱。
 * 这里只聚合API；可用的WebAssembly和具体远端能力仍由运行环境/调用方提供，不因类型声明自动具备。
 */
/**
 * Sandboxes that need no Node built-ins: `InlineCodemodeSandbox` runs the VM on the calling thread
 * and `RemoteCodemodeSandbox` runs it in another isolate. Neither imports `node:*` modules, so this
 * entry works in Cloudflare Workers, Durable Objects, and browsers. `CodemodeSandbox`, which uses
 * worker threads, stays in the main entry.
 */
// 共用名称映射：my-tool变my_tool；不自动消除名称碰撞。
export { toCodemodeIdentifier } from "./identifier.ts";
// 公共宿主执行管线：工具表、消息、结果、取消；具体VM位置由后端选择。
export { CodemodeSandboxBase } from "./runtime/execution.ts";
// 从下面指定模块聚合公开符号；条目前的type表示该项只在编译期存在。
export {
	// 调用线程版的默认中断轮询额度，不是固定毫秒数。
	DEFAULT_INTERRUPT_BUDGET,
	// VM放在调用线程，会阻塞同步计算；中断额度帮助限制不让出线程的脚本。
	InlineCodemodeSandbox,
	// inline配置类型，需提供编译WASM，可指定中断额度及公共选项。
	type InlineCodemodeSandboxOptions,
} from "./runtime/inline.ts";
// 从下面指定模块聚合公开符号；条目前的type表示该项只在编译期存在。
export {
	// VM前导脚本的输出文字/base64累计码元上限，不是token预算。
	MAX_OUTPUT_CHARS,
	// VM前导脚本的输出项目数上限，与累计码元限制分开。
	MAX_OUTPUT_ITEMS,
	// store键长加值JSON文字的累计码元额度，实际持久化仍由宿主负责。
	MAX_STORE_TOTAL_CHARS,
	// store单个JSON值的码元额度，不是磁盘字节数。
	MAX_STORE_VALUE_CHARS,
} from "./runtime/prelude-source.ts";
// 仅导出桥协议类型：宿主回复、启动数据及VM消息，不执行传输。
export type { HostToWorkerMessage, VmStartData, WorkerToHostMessage } from "./runtime/protocol.ts";
// 从下面指定模块聚合公开符号；条目前的type表示该项只在编译期存在。
export {
	// 远端能力接口，execute接受启动请求及回调交换函数；类型本身不建网络。
	type CodemodeRemote,
	// 远端向宿主交一批消息并等待一个回复的异步函数类型。
	type CodemodeRemoteExchange,
	// 远端消息类型，包含VM消息或桥外failure。
	type CodemodeRemoteMessage,
	// 宿主回复类型：调用结果、stop或无调用时null。
	type CodemodeRemoteReply,
	// 远端启动数据与可选请求中断额度类型。
	type CodemodeRemoteRequest,
	// 远端服务配置类型：WASM与其可执行额度上限。
	type CodemodeServeOptions,
	// 宿主保留工具，远端跑VM的沙箱类；传输实现由调用方注入。
	RemoteCodemodeSandbox,
	// 远端工厂和请求额度等配置类型，不含worker线程专属选项。
	type RemoteCodemodeSandboxOptions,
	// 远端执行一次VM并通过exchange交换消息；不会自动部署HTTP/RPC服务。
	serveCodemodeRemote,
} from "./runtime/remote.ts";
// 下列整组都是编译期类型重导出，不生成同名运行时变量。
export type {
	// 一条普通工具调用的状态/真实经过耗时，globals不入此账。
	CodemodeCall,
	// 工具摘要状态ok/error/cancelled，取消不证明副作用已停。
	CodemodeCallStatus,
	// start单次运行声明的全局名/传参方式，不含宿主实现。
	CodemodeDeclaredGlobal,
	// start单次运行声明的工具名/脚本用名/说明，不含execute。
	CodemodeDeclaredTool,
	// 确定性运行结束时处理到的结果序号和累计调用数。
	CodemodeDuring,
	// 统一错误对象类型，含类别、原因及可选name/stack。
	CodemodeError,
	// script/timeout/aborted/sandbox字面量联合，供调用方分支。
	CodemodeErrorKind,
	// 普通execute的单次信号/时限/store快照配置。
	CodemodeExecuteOptions,
	// start交给宿主处理的调用，包含id/目标类别/名称/参数。
	CodemodeHostCall,
	// 仅供声明渲染的schema数据类型，不包含验证函数。
	CodemodeJsonSchema,
	// 宿主回答一条调用的成功值或错误，不等于整脚本结果。
	CodemodeOutcome,
	// text/console或image输出片段的带标签联合。
	CodemodeOutputItem,
	// 整次脚本的成功/失败联合；先判ok再读value/storeWrites或error。
	CodemodeResult,
	// start返回的运行句柄，含result、finished和逐调用deliver。
	CodemodeRun,
	// 确定性运行初时钟/种子/工具声明/回调等配置类型。
	CodemodeRunOptions,
	// 各后端共有的工具、全局能力、时限和VM内存配置。
	CodemodeSandboxBaseOptions,
	// 成功运行的set/delete写集合，调用方决定如何持久化。
	CodemodeStoreWrites,
	// 宿主工具定义：元信息及同步/异步execute能力。
	CodemodeTool,
	// 传给宿主工具的取消信号上下文，不是强制停止机制。
	CodemodeToolContext,
} from "./types.ts";
// 只重导出不透明模块类型；type会擦除，因此不把wasm.ts的Node IO带进portable运行图。
export type { CodemodeWasmModule } from "./wasm.ts";
