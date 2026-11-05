// `startWorker` (slice 13 §1): a worker of an app built with the kit, in its entry module. `workerMain` plus the kit's
// part: the worker's directory under its kind and address with its store, the host at the worker's address acting as
// the principal the server gave it, connected to the server first, its plugins loaded with the kit's worker facets
// (`WorkerInfo`, `Files`).

// 所属：packages/chord/src/node/app，app kit 的 worker 入口（slice 13 §1）。
// 职责边界：在 worker 进程里用 startWorker 建立目录、store、host，连接服务器，加载核心 facet 与插件；不负责进程启动或路由。
// 上游：worker 入口模块调用 startWorker(options)；下游：workerMain 提供握手和模块解析，layout/store/host/plugins/data/files/info 各模块。
// 结果与错误：返回 void；启动或加载错误交给 options.onError，workerMain 用固定 redact 消息隐藏细节；关闭由父链路触发。
// 能力清单：WorkerOptions 是输入类型；startWorker 是入口；内部 packages 合并所有 kind 的包，core 数组注册 WorkerInfo/Files/HostData。
// 组合顺序：workerMain 收到 { address, start, parent, plugins, onClose } → 建目录/store → createHost → connect(parent) → core facets → plugins.load → 返回 busy。
// 示例：export default startWorker({ api, kinds, onError }); // 服务器启动 worker 时调用此入口。
// 建议阅读顺序：先看 WorkerOptions，再看 startWorker 的主回调，最后 workerMain 选项。
import { join } from "node:path";
import type { Principal } from "../../data/index.ts";
import { createHost } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import { openNodeSqliteDatabase } from "../../sqlite/node.ts";
import { openStore, sqliteBackend } from "../../store/index.ts";
import type { Watchable } from "../../watch.ts";
import { workerMain } from "../workers/index.ts";
import type { AppApi, AppKind, KitStart } from "./app.ts";
import { hostDataFacet } from "./data.ts";
import { filesFacet } from "./files.ts";
import { workerInfoFacet } from "./info.ts";
import { privateDirectory, privateStore } from "./layout.ts";

// WorkerOptions 描述 worker 启动所需的编译期信息：API 模块、所有 kind 的包、可选 busy 状态和错误回调。
/** What `startWorker` takes: the app's API and kinds as the server's `startServer` has them, this process's modules. */
export type WorkerOptions = {
	readonly api: AppApi;
	readonly kinds: Readonly<Record<string, AppKind>>;
	// busy 是应用额外的保活计数；缺省时返回空对象，表示没有额外忙碌原因。
	/** Extra keep-alive counts of the app (a record of numbers, all zero when idle). */
	readonly busy?: Watchable<Readonly<Record<string, number>>>;
	// onError 同时接收主机运行错误和启动失败错误；类型是 unknown，因为错误可能来自任意层。
	/** The worker host's errors (`HostError`) and a failed start's. */
	readonly onError: (error: unknown) => void;
};

/** Runs this process as a worker of the app: once the start message arrived, its host is up and its plugins loaded. */
// 把当前进程作为应用 worker 运行：输入 WorkerOptions，返回 void；主机和插件保持运行，直到父进程关闭。
// 主要流程：合并所有 kind 的包，workerMain 握手拿到 start，建私有目录和 store，建 host 并连接服务器，加载核心 facet 与插件。
// 错误通过 options.onError 报告；workerMain 还用固定 redact 消息隐藏内部错误细节。
// 例子：worker 入口调用 startWorker({ api, kinds, onError })，服务器启动的 worker 进程由此建立主机。
export function startWorker<P extends Principal>(options: WorkerOptions): void {
	// The worker's facet kind comes with the start message: every kind's packages are offered, its own are imported.
	// Object.values 遍历 kinds；?? {} 处理没有 packages 的 kind，Object.assign 把各 kind 的包合并成一个对象。
	const packages = Object.assign({}, ...Object.values(options.kinds).map((kind) => kind.packages ?? {}));
	// workerMain 处理消息循环；第二个参数提供 hostPackages、redact 和 onError。
	workerMain(
		// 解构启动消息：address 是主机地址，start 是服务器发的 JSON，parent 是服务器链路，plugins 负责加载插件，onClose 注册关闭回调。
		async ({ address, start, parent, plugins, onClose }, context) => {
			// The server's `startServer` sends `{ kit, app }`.
			// start 由服务器序列化，形状是 {kit, app}；as 是编译期断言，线路输入已由框架校验。
			const { kit, app } = start as { readonly kit: KitStart; readonly app: JsonValue };
			// kit.dir 是服务器为这个地址准备的 worker 目录；先收紧目录权限。
			await privateDirectory(kit.dir);
			// 在同目录数据库文件上设置 0600，再交给 SQLite 打开。
			await privateStore(join(kit.dir, "store.sqlite"));
			// 打开 store，并把错误上下文传入；SQLite 文件由 openNodeSqliteDatabase 映射。
			const store = await openStore(
				sqliteBackend(await openNodeSqliteDatabase(join(kit.dir, "store.sqlite"))),
				context,
			);
			// 注册关闭回调；workerMain 会按注册顺序处理，store 在这里先关闭。
			onClose((ctx) => store.close(ctx));
			// worker 的身份由服务器在启动数据中给出，不信任本地进程自报。
			// Principals are the app's: the server made these with its `principal` options.
			// createHost 建立 worker 主机；address 决定对象地址，store 提供持久状态。
			const host = createHost<P>({
				address,
				// kit.principal 在服务器侧生成，先在 wire 上校验，再断言成应用的 principal 类型 P。
				principal: kit.principal as unknown as P,
				store,
				onError: options.onError,
			});
			// 父链路关闭时也释放主机。
			onClose((ctx) => host.close(ctx));
			// First: the server sees the worker started, then the load runs.
			// 先连接服务器再加载插件：服务器先看到主机启动。trusted 表示这是同一应用内部的服务器链路。
			host.connect(parent, { principal: kit.server as unknown as P, trusted: true }, context);
			// WorkerInfo 的地址字段只保留 kind/key/params；params 从 Address 的 JSON 值断言为 JsonValue。
			const info = {
				address: { kind: address.kind, key: address.key, params: address.params as JsonValue },
				start: app,
			};
			// 核心 facet 列表：worker-info、files、data；顺序无关，随后与插件一起交给 plugins.load。
			const core = [
				// workerInfoFacet 返回固定值；start 是服务器给此 worker 的应用启动数据。
				{ name: "chord.app.worker-info", facet: workerInfoFacet<P>(info) },
				// filesFacet 使用 kit.dir/files 作为存储目录，kit.files/kit.uploads 是服务器规定的容量上限。
				{ name: "chord.app.files", facet: filesFacet<P>(join(kit.dir, "files"), kit.files, kit.uploads) },
				// hostDataFacet 只允许服务器导出：store 和 files 路径在 worker 进程内，打包由服务器请求触发。
				{
					name: "chord.app.data",
					facet: hostDataFacet<P>(store, join(kit.dir, "files"), kit.server as unknown as P),
				},
			];
			// 加载插件 kind：kit.facet 是此 worker 的 facet 种类，core 是 kit 自带对象；插件可通过 WorkerInfo 等读取。
			await plugins.load(host, { kind: kit.facet, core }, context);
			// 没有 busy 时返回 {}；有则把 watchable 交给 workerMain 用于保活。
			return options.busy === undefined ? {} : { busy: options.busy };
		},
		// workerMain 的模块解析表：API 模块和所有 kind 的包；插件 import 时从这里取。
		{
			hostPackages: { ...options.api.modules, ...packages },
			// redact 把内部错误替换为固定消息，避免向公共链路泄露路径或堆栈。
			// Worker errors are public (decision "worker errors in public"): a fixed message, never the error's own.
			// onError 保留给应用自己的日志或上报，不改变 redact 的公开消息。
			redact: () => ({ message: "worker failed" }),
			onError: options.onError,
		},
	);
}
