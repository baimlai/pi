/**
 * Node/Bun主公共入口，聚合声明生成、源码配置解析、worker/inline/remote沙箱及公共类型。
 * 例从本入口导入CodemodeSandbox，再调用execute才会创建运行；导入本身不启动脚本或线程。
 * export {...} from是重导出，包含运行值；export type仅供TS，编译后擦除。
 */
// 从下面指定模块聚合公开符号；条目前的type表示该项只在编译期存在。
export {
	// 工具输入schema渲染的默认码元预算，过长先去约束标签再退unknown。
	DEFAULT_INPUT_SCHEMA_MAX_CHARS,
	// 声明生成参数类型，含只读tools/globals数组；不触发真实执行。
	type RenderDeclarationsOptions,
	// 把工具和全局能力元信息排成TS说明文字，不产生可调用函数。
	renderDeclarations,
	// 把输出schema转成展示类型，无schema为unknown，不校验实际返回值。
	renderToolOutputType,
	// 单工具说明+TS代码围栏，供搜索结果和模型阅读。
	renderToolSample,
	// 单工具的tools成员签名，名称正规化，入参类型有可选长度预算。
	renderToolSignature,
	// JSON Schema子集转TS类型文本，非完整验证器。
	schemaToType,
} from "./declarations.ts";
// 共用名称映射：my-tool变my_tool；不自动消除名称碰撞。
export { toCodemodeIdentifier } from "./identifier.ts";
// 公共宿主执行管线：工具表、消息、结果、取消；具体VM位置由后端选择。
export { CodemodeSandboxBase } from "./runtime/execution.ts";
// Node/Bun线程版；每次执行独立VM，结果完成与真实线程exit可能不同步。
export { CodemodeSandbox } from "./runtime/host.ts";
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
// 从下面指定模块聚合公开符号；条目前的type表示该项只在编译期存在。
export {
	// 可选首行配置的确切文字前缀// @options:。
	CODEMODE_OPTIONS_PREFIX,
	// 供语法约束能力使用的Lark外形语法，不是JS语法或安全验证器。
	CODEMODE_SOURCE_GRAMMAR,
	// 空输入或选项格式错误类别，和脚本运行错误区分。
	CodemodeSourceError,
	// 解析后的输出预算/毫秒时限类型，不自动落实限制。
	type CodemodeSourceOptions,
	// 保留正文行号的脚本与独立配置结果类型。
	type ParsedCodemodeSource,
	// 检查可选首行配置、拆出正文，不执行或编译JavaScript。
	parseCodemodeSource,
} from "./source.ts";
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
	// Node/Bun worker版配置类型，另带WASM/入口/准入及退出钩子。
	CodemodeSandboxOptions,
	// 成功运行的set/delete写集合，调用方决定如何持久化。
	CodemodeStoreWrites,
	// 宿主工具定义：元信息及同步/异步execute能力。
	CodemodeTool,
	// 传给宿主工具的取消信号上下文，不是强制停止机制。
	CodemodeToolContext,
} from "./types.ts";
// 类型加运行时函数：从安装依赖/指定路径读并编译WASM，按路径Promise缓存；调用时才读文件。
export { type CodemodeWasmModule, loadQuickJSWasm } from "./wasm.ts";
