/** Node-only parts of Chord v1 (`@earendil-works/chord/old/node`): child host processes, their manager, and the facet module loader. */
// 这是 Chord v1 的 Node 专用导出入口；没有业务函数，只重新导出加载器与子进程管理 API。
// 与 old/index.ts 分开，使浏览器导入 v1 核心时不必加载 node:module、node:child_process 等内置模块。
// 例如 import { nodeLoader } from "@earendil-works/chord/old/node"；导入会加载被重导出的模块，但不会自动启动子进程。
export { nodeLoader } from "./loader.ts";
// type 前缀的名称只参与 TS 类型检查；childControl/forkDriver 等普通名称是运行时值。
export {
	type ControlMessage,
	childControl,
	createHostManager,
	type Driver,
	type Exit,
	type ForkDriverOptions,
	forkDriver,
	type HostManager,
	type HostManagerOptions,
	type Instance,
	type Liveness,
	processLock,
} from "./manager.ts";
