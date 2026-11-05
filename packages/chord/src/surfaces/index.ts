// The client surfaces' portable part (slice 11): the scripts objects a server serves and clients hold, plugin scripts
// that register themselves, a client host kept connected and current, a host's loaded plugins, and themes.
//
// 文件导读
// 所属：packages/chord 的 surfaces 层入口（`chord/surfaces`），汇总 web/react/tui 共用的可移植部分。
// 职责边界：只做再导出，不实现逻辑；不依赖 DOM、React 或 Node 终端 API，因此可同时运行在浏览器、worker 和终端。
// 上游：`/web`、`/react`、`/tui` 子路径以及应用代码从这里取公共类型与函数；下游：同目录八个实现文件。
// 结果与错误保持各函数原样，本文件不包装、不吞错。
// 能力清单：
// - active-theme：followActiveTheme 与 ThemeFollower，跟随服务器主题/用户选择/客户端模式。
// - client：Client、ClientError、ClientOptions、startClient，启动并维护一个客户端 host。
// - connection：keepConnected 与 ConnectionState/Loop* 类型，负责断线重连循环。
// - loaded：LoadedFacets、Prepared、SetEntry，管理已加载插件集合的装载/重载。
// - registered：REGISTER、registeredSource、evaluateRegistered 等，自注册插件脚本协议与 CommonJS 互操作。
// - scripts：ScriptSet/ScriptEntry 契约与 WebScripts/TuiScripts 远程对象。
// - theme-choice：ThemeChoice 远程对象与 themeChoiceFacet。
// - themes：Theme/ThemePick 类型、Themes 注册表、activeTheme、CSS/ANSI 转换函数与回退主题。
// 组合与顺序：典型启动是 startClient（内部 keepConnected + LoadedFacets）→ 插件脚本 evaluateRegistered →
// followActiveTheme 订阅主题；服务器侧创建 WebScripts/TuiScripts 与 Themes/ThemeChoice 远程对象。
// 示例：`import { startClient, followActiveTheme } from "@earendil-works/chord/surfaces";`
// 阅读顺序：先看 client.ts 的 startClient 与 connection.ts，再看 scripts/registered/loaded 的加载链，
// 最后看 themes/theme-choice/active-theme 的主题链。

export { followActiveTheme, type ThemeFollower } from "./active-theme.ts";
export {
	type Client,
	type ClientError,
	type ClientOptions,
	startClient,
} from "./client.ts";
export {
	type ConnectionState,
	keepConnected,
	type LoopEnvironment,
	type LoopLink,
	type LoopOptions,
	type SocketEvents,
} from "./connection.ts";
export { LoadedFacets, type Prepared, type SetEntry } from "./loaded.ts";
export {
	type ClientModules,
	evaluateRegistered,
	type FacetFunction,
	REGISTER,
	type RegisteredScript,
	registeredSource,
} from "./registered.ts";
export { type ScriptEntry, ScriptSet, type ScriptsContract, TuiScripts, WebScripts } from "./scripts.ts";
export { ThemeChoice, themeChoiceFacet } from "./theme-choice.ts";
export {
	activeTheme,
	BASE_ROLES,
	type BaseRole,
	type ColorDepth,
	FALLBACK_THEMES,
	type Theme,
	type ThemePick,
	Themes,
	terminalColor,
	themesFacet,
	themeVariables,
} from "./themes.ts";
