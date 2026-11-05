// 文件导读
// 所属：packages/chord/test/examples/53-app，Chord 示例 53 到 55 共用的启动脚本，对应 slice 13 的 startServer。
// 作用：把 notes 应用自己的决定集中在这里——API 名称/版本/模块表、facet 种类、principal、listen 地址、
// 内置插件根、项目 worker 的入口与策略——其余交给 kit：数据目录、单实例锁、store、host、HTTP 与会话、
// owner 链接与 token 文件、插件构建与发布。
// 上游：示例 main.ts 调用 startNotes(dataDir, context)；worker.ts 复用同一份 API 与 KINDS 调用 startWorker。
// 下游：src/node/app/index.ts 的 startServer；./app/v1.ts 与 ./app/v1/server.ts 是模块表的值；
// ./app/principals.ts 提供身份类型；./plugins/ 是内置插件根。
// 能力清单（按导出）：
// - API：应用名 @notes/app、版本 ["v1"]、模块表（@notes/app/v1 与仅服务器可用的 @notes/app/v1/server）；
// - KINDS：server 与 worker 两种 facet 种类，平台都是 node；
// - startNotes：以 dataDir 启动并返回 App<NotesPrincipal>。
// 典型调用（示例）：
//   const app = await startNotes(join(tmp, "data"), context);
//   console.log(app.ownerLink()); // http://127.0.0.1:<port>/_chord/owner#<token>
// 阅读顺序：先看 startNotes 的选项对象，再看 API/KINDS 常量，然后读 src/node/app/app.ts 的 startServer 主流程。
// 运行方式：由示例入口调用；单独运行没有输出，也不建目录（startServer 只在调用时启动）。
// 副作用：监听回环端口、创建数据目录与 store、启动插件 watcher；第一次访问项目时启动 worker 子进程。
// 失败：startServer 初始化失败会先关闭已打开的资源再拒绝；运行期错误通过 onError 回调报告，kind 区分来源。
//
// The notes app's start: everything the app itself decides, given to `startServer`. The kit does the rest: the data
// directory, the store, the host, HTTP with sessions and the owner link, a workers component for projects, and the
// plugins (`plugins/` here, the app's required root, and `<dataDir>/plugins/`, the user's).
// Examples 53 to 55 call `startNotes`; a real app's `start.ts` calls it with `process.argv[2]` and prints the link.

// 把 import.meta.url（file: URL）转成本地路径；Node 内建。
import { fileURLToPath } from "node:url";
// Context 只作为类型使用，剥离后不存在。
import type { Context } from "../../../src/context/index.ts";
// `type App` 是仅类型导入；startServer 是运行时函数。
import { type App, startServer } from "../../../src/node/app/index.ts";
// 应用的身份类型。
import type { NotesPrincipal } from "./app/principals.ts";
// 服务器专用 API 子模块（含 Sessions 与 Http）。
import * as v1server from "./app/v1/server.ts";
// 公共 API 模块（schema、facet、Project、Sections 等）。
import * as v1 from "./app/v1.ts";

// API 是 AppApi 形状的对象：name 用于默认数据目录与归档归属，versions 新到旧，modules 的键是插件里的
// import 说明符，值是“本进程的模块实例”（插件求值时 require 到同一个对象，契约 token 才能相等）。
/** The app's API: its name, versions (newest first) and this process's modules (the worker's entry has the same). */
export const API = {
	name: "@notes/app",
	versions: ["v1"],
	modules: { "@notes/app/v1": v1, "@notes/app/v1/server": v1server },
};

// KINDS 描述每种 facet 的运行平台。server 宿主与 worker 宿主都跑在 Node，所以都是 node。
// `as const` 把 platform 收窄成字面量 "node"（而不是 string），使对象可赋给 AppKind；
// 它只是编译期断言，运行时对象不变。
/** The app's facet kinds. */
export const KINDS = { server: { platform: "node" }, worker: { platform: "node" } } as const;

// 函数说明：startNotes 启动 notes 应用。
// 输入：dataDir 数据目录（可以不预先存在）；context 取消与遥测上下文。
// 输出：Promise<App<NotesPrincipal>>，即包含 ownerLink/ownerTokenFile/close 等成员的运行中应用。
// 副作用：前面列出的目录、锁、store、端口、插件 watcher；span 级副作用由 startServer 负责。
// 错误：初始化失败先清理再拒绝；服务端运行期错误交给 onError。
// 流程：组装 AppOptions → startServer 依次 openServer/createHost/createHttp/createPlugins/workersOf/
// 核心 facet/surfacesOf/plugins.load/ownerTokenFile → 返回 App。
// 示例：const app = await startNotes(dataDir, context); startNotes 本身不打印链接。
// 说明：泛型 <NotesPrincipal> 让 api/principal/kinds 与用户插件收到同一身份类型。
/** Starts the notes app on a free loopback port with its data in `dataDir`. */
export function startNotes(dataDir: string, context: Context): Promise<App<NotesPrincipal>> {
	// 直接返回 startServer 的 Promise；不是 async 函数，少一层包装。
	return startServer<NotesPrincipal>(
		{
			// 应用名：默认数据目录名、归档 manifest 的 app 字段、日志前缀都用它。
			name: "notes",
			dataDir,
			// 内置（必需）插件根：相对本文件解析到 ./plugins/，即 home 与 notes 两个插件。
			// fileURLToPath 以本模块位置为基准，因此从任意 cwd 运行都能找到。
			root: fileURLToPath(new URL("./plugins/", import.meta.url)),
			// 只监听回环地址；port 0 由操作系统分配空闲端口，测试可并行。
			listen: { host: "127.0.0.1", port: 0 },
			api: API,
			kinds: KINDS,
			// 服务器自身身份是 server；worker 身份由地址生成，project 字段取 host 地址 key
			// （Project({id:"p1"}) → "project|p1"）。
			principal: { server: { kind: "server" }, worker: (address) => ({ kind: "worker", project: address.key }) },
			// workers 是数组：同一应用可以定义多种 worker 种类；这里只有 Project 一种。
			workers: [
				{
					// 这个 worker 对应的 host kind；地址参数 schema 决定了项目 id 的校验。
					kind: v1.Project,
					// worker 进程的入口模块，里面调用 startWorker。
					entry: fileURLToPath(new URL("./worker.ts", import.meta.url)),
					// 原样传给子进程的 Node 参数：选择 package exports 的 source 条件（直接跑 .ts 源码）、
					// 开启类型剥离、关闭实验特性警告。
					execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
					// What each project's worker gets as `WorkerInfo.start`.
					// 每个项目启动时由服务器生成的应用数据；会作为 startWorker 的 start 参数交给 worker。
					// 这里只给 project key，插件再用 JSON.stringify 展示。
					start: (address) => ({ project: address.key }),
					// Who may reach a project: the owner (through the server's routes) and the server itself.
					// 同步策略：owner 与 server 放行；其他身份（例如普通 user）拒绝。
					// 服务器身份在 kit 内部总会放行，不会经过这个函数。
					authorize: (principal) => principal.kind === "owner" || principal.kind === "server",
					// 空闲 60 秒后停止 worker；下次访问会重新启动并恢复持久化状态。
					idleMs: () => 60_000,
				},
			],
			// kit 的统一错误通道：error.kind 区分 host/http/workers/plugins 等来源，error.error 是原始错误。
			onError: (error) => console.error("app:", error.kind, error.error),
		},
		context,
	);
}
