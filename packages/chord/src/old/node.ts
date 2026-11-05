/**
 * Chord v1 的 Node 专用导出入口（`@earendil-works/chord/old/node`）。
 *
 * 所属包与功能模块：packages/chord/src/old/node.ts，属于 Chord v1 的 src/old 实现，不是 v2。它本身没有
 * 业务逻辑，只把两个 Node-only 模块重新导出：loader.ts 的 facet 加载器，以及 manager.ts 的子进程宿主管理器。
 *
 * 职责边界：只做“导出面”与浏览器安全性隔离。old/index.ts 是浏览器也能导入的核心，不能依赖 node:module、
 * node:child_process 等内置模块；需要 Node 能力的应用从这个子路径导入。导入本文件会加载被重导出的模块并
 * 执行它们的模块级初始化，但不会自动 fork 子进程、打开 socket 或安装解析钩子（nodeLoader 首次调用才安装）。
 *
 * 上游入口：package.json 的 exports 将 `./old/node` 指向本文件；应用代码、CLI 或测试从这里导入。下游依赖：
 * loader.ts（nodeLoader，内部使用 node:module/registerHooks 与动态 import）和 manager.ts（childControl、
 * createHostManager、forkDriver、processLock 及消息/实例/驱动类型，内部使用 child_process/fs/net/os）。
 *
 * 能力清单（按导出项）：
 * - `nodeLoader`：FacetLoader 实现。把路径/URL 数组逐批导入为 Facet；每批通过 URL 查询参数刷新入口和同目录
 *   子模块的缓存，不提供模块隔离，也不回收旧模块（见 loader.ts 的 TODO）。
 * - `ControlMessage`：父子进程共享 IPC 通道上的控制消息联合：init/ready/fatal/shutdown/status。
 * - `Liveness`：管理器给 keepAlive 的只读快照：是否 booting、调用/订阅/任务计数、空闲毫秒数。
 * - `Exit`：子进程退出结果（code 或 signal）。
 * - `Instance`：已启动子进程的 pid、Chord IPC link、exited、send、killTree、onControl。
 * - `Driver`/`ForkDriverOptions`：可替换的启动器接口及 forkDriver 的入口、参数、环境、锁名等选项。
 * - `forkDriver(options)`：用 node:child_process.fork 启动子进程并包装成 Driver；创建独立进程组。
 * - `HostManagerOptions`/`HostManager`：启动、停止、替换、查询状态与存活信息的管理器契约。
 * - `createHostManager(options)`：串行化状态机，保证同一管理器同一时刻最多一个存活子进程；跨进程同名互斥
 *   由 processLock 负责。
 * - `processLock(name)`：基于内核 socket 的跨进程单实例锁，返回异步 release。
 * - `childControl(channel)`：子进程侧控制端：等待 init、取锁、报告 ready/fatal/status、处理 shutdown。
 *
 * 典型调用示例（示例，不会在导入时自动执行）：
 * ```ts
 * import { createHostManager, forkDriver } from "@earendil-works/chord/old/node";
 *
 * const manager = createHostManager({
 *   driver: forkDriver({ entry: "/srv/worker.js", init: { region: "eu" }, lock: "app:data" }),
 *   keepAlive: (liveness) => liveness.booting || liveness.idleFor < 60_000,
 * });
 * const instance = await manager.start(); // instance.link 交给 createHost(...).accept(link)
 * await manager.stop();                   // 宽限期后强杀进程树
 * ```
 * 子进程入口的对应写法是 `const control = childControl(); const init = await control.init;`，在打开存储前
 * `await control.lock()`，随后 `control.ready()` 并按需 `control.report(...)`。
 *
 * 建议阅读顺序：先读本文件的导出关系；需要加载插件时读 loader.ts 的 nodeLoader；需要子进程时按
 * manager.ts 的数据契约（ControlMessage/Liveness/Instance/Driver）→ processLock → forkDriver →
 * createHostManager → childControl 的顺序读。之后回到 host.ts 的 createHost/accept 理解 link 如何接入宿主。
 */
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
