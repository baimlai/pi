// Chord v2's terminal surface, the sandbox side (`@earendil-works/chord/tui`; slice 11 §4): `startTerminalRuntime` in
// the app's terminal entry, the bridged terminal, the theme lookup and `TuiScope`. The launcher and the server side are
// `/tui/launcher` and `/surfaces`'s `tuiSurface`.
// 中文说明：本文件是沙箱侧终端面的公共出口，只重导出入口、终端/主题适配器和资源作用域，不含逻辑。
// 上游：应用终端入口从 @earendil-works/chord/tui 导入；下游：runtime.ts 组装这些部件，launcher 在沙箱外。
// 浏览器/Node 类型提示：这些代码运行在启动器创建的沙箱进程内，不直接访问真实终端。
// 所属：@earendil-works/chord/tui 包的沙箱侧公共出口；不包含 launcher 或服务器实现。
// 边界：只重导出，不含逻辑；导入方仍需在启动器提供的沙箱内运行，浏览器入口在 /web，服务器表面在 /surfaces。
// 上游：应用终端入口 import 本模块；下游：bridge/runtime/scope/terminal/theme 各自实现。
// 导出清单：Bridge/BridgeRequest/BridgeStart/LauncherMessage/SandboxMessage 是类型；AttachedFile、TerminalRuntime、
// TerminalRuntimeOptions、startTerminalRuntime 是启动 API；TuiScope、BridgeTerminal、TerminalTheme 是具体类。
// 组合：startTerminalRuntime 返回 TerminalRuntime，其中 terminal 是 BridgeTerminal、theme 是 TerminalTheme；TuiScope 使用 runtime.host。
// 示例：import { startTerminalRuntime } from "@earendil-works/chord/tui";
// 阅读顺序：bridge.ts → runtime.ts → terminal.ts/theme.ts → scope.ts。

// export type 只导出类型，编译后消失；运行时对象（Bridge 等）由 bootstrap 注入，不从模块导入。
export type { Bridge, BridgeRequest, BridgeStart, LauncherMessage, SandboxMessage } from "./bridge.ts";
// 运行时入口与三个具体类构成应用依赖的最小面：启动函数、桥接终端、主题查询和 TuiScope。
export {
	type AttachedFile,
	startTerminalRuntime,
	type TerminalRuntime,
	type TerminalRuntimeOptions,
} from "./runtime.ts";
export { TuiScope } from "./scope.ts";
export { BridgeTerminal } from "./terminal.ts";
export { TerminalTheme } from "./theme.ts";
