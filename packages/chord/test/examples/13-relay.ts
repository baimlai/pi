// A relay over real transports: a tab on a loopback WebSocket, a server that relays, and a worker per session forked
// over IPC. The worker gets its start data from its start message and serves it as `SessionInfo` through its core
// facet (§18); the server routes by address and parses no part.
// Run from packages/chord (the same file is the worker when its first argument is `worker`):
//   node --conditions=source --experimental-strip-types test/examples/13-relay.ts
// 文件导读
// 所属包与示例系列：packages/chord/test/examples，Chord v2 示例 13，对应 slice 4a（真实传输、双端链路、relay）。
// 演示什么：用真实传输搭一条三级链路：tab 通过 loopback WebSocket 连 server，server 按 session 地址 fork 子进程
//   worker（IPC 链路），请求由 server 中继到对应 worker；worker 从启动消息取得 start data，经核心 facet 提供
//   SessionInfo；server 只按地址路由，不解析业务分片。
// 上游/下游：文件顶部命令启动 server 分支；同一文件以 `worker` 参数被 fork 时进入 worker 分支。下游使用 ws 的
//   WebSocketServer、Node 的 child_process.fork、src/link 的 ipcLink/webSocketLink、src/host 的 createHost/route。
//   会启动子进程并监听 127.0.0.1 的随机端口（回环网络），不访问外部服务。
// 能力清单（按演示的机制）：
// - ipcLink(port)：把 Node IPC 通道包装成 Chord Link；worker 侧跳过非启动消息（Uint8Array 链路数据）。
// - 启动消息：server 用 child.send 发送应用自己的 Start；worker 监听 process message，取到后移除监听器。
// - 核心 facet：用 start data + pid 构造 SessionInfo，并以固定名称 "@example/core" 先于插件 load。
// - webSocketLink(socket)：把 ws 的 socket 与浏览器风格 WebSocket 包装成 Link，两端各用一次。
// - server.route + fork：resolve 按 session 地址 fork worker、发送启动消息、立即返回 IPC 链路。
// - 中继：tab 的 hold 经 server 转发到 worker；server 不解析业务部分，只按地址选链路。
// - 关闭顺序：tab.close -> server.close（关闭路由链路，worker 收到 onClose 后退出）-> wss.close。
// 典型运行顺序：server 分支注册 route -> load -> 启动 WebSocketServer -> tab connect/load -> get S1（fork 第一个 worker）
//   -> 读 info、写两条 notes -> get S2（fork 第二个 worker）-> 关 tab/server/WebSocketServer。
// 示例（符合真实签名）：
//   const link = ipcLink(child);
//   return { link, principal: { kind: "worker", session: address.params.id }, trusted: true };
//   // worker 侧：
//   worker.connect(ipcLink(process as unknown as IpcPort), { principal: { kind: "server" }, trusted: true }, context);
// 运行方式与环境：在 packages/chord 下执行文件顶部命令；需要 Node 支持全局 WebSocket、--experimental-strip-types，
//   以及工作区依赖 ws；子进程通过 execArgv 继承同样的运行条件。无环境变量；仅使用回环地址与临时端口。
// 预期输出：server: forked pid … for session|S1；tab: S1 info { id: 'S1', title: 'Session S1', pid: … }
//   server pid …；tab: S1 notes [ 'milk', 'bread' ]；server: forked pid … for session|S2；
//   tab: S2 info { … } notes []；closed。pid 与顺序细节可能因调度略有差异。
// 对应测试与文档：packages/chord/test/link/ipc.test.ts、test/link/websocket.test.ts、test/remote/relay.test.ts、
//   test/node/（worker 适配）；slices.md 的 slice 4a；设计文档 §18（start data）与 §22（传输）。
// 建议阅读顺序：先看 P、hostKind、Init/SessionInfo/Notes 契约与 Start 类型，再看 coreWorkerFacet/notesFacet，
//   随后按 `process.argv[2] === "worker"` 分成两段读 worker 分支与 server 分支。
import { fork } from "node:child_process";
import type { AddressInfo } from "node:net";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { arr, hostKind, int, local, method, obj, remote, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { type IpcPort, ipcLink, webSocketLink } from "../../src/link/index.ts";
import { constant } from "../../src/state/index.ts";

// 后台上下文；fork 出来的 worker 也显式传入它。
const context = BACKGROUND_CONTEXT;

// P 是三种 principal：owner（tab）、server（中继/父进程）、绑定 session 的 worker（子进程）。
type P = { kind: "owner" } | { kind: "server" } | { kind: "worker"; session: string };

// Server 无参数；Session 以 id 为参数，地址 key 形如 session|S1。
const Server = hostKind("server");
const Session = hostKind("session", { id: str() });

// Init 是 worker 启动数据的 schema：会话 id、标题、进程号；同时用于 SessionInfo 与 Notes.info 成员。
const Init = obj({ id: str(), title: str(), pid: int() });

/** Start data: a local object with empty params (host lifetime) and constant state, served by the core facet. */
// SessionInfo 是 worker 上的本地类型：空参数（随宿主存活），init 状态恒定。
// 它由核心 facet 提供，名字 "@example/core" 固定，插件可以按契约引用。
const SessionInfo = local("example.session-info", { version: 1, params: {}, members: { init: Init } });

// Notes 远端契约：地址按 session 计算，owner 变体暴露 info、notes 与 add。
const Notes = remote("example.notes", {
	version: 1,
	params: { session: str() },
	// hostAddress 的真实签名是 (params) => Address；把 session 映射成 Session({ id: session })。
	hostAddress: ({ session }) => Session({ id: session }),
	variants: {
		owner: { state: { info: Init, notes: arr(str()) }, methods: { add: method(obj({ text: str() }), int()) } },
	},
});

/** What the server sends a worker it forked: the app's own message, not the link's. */
// Start 是应用自定义的启动消息形状；readonly 只是编译期约束，不冻结运行时对象。
type Start = { readonly id: string; readonly title: string };

/** The worker's core facet, made from its start message (base code, loaded under a fixed name). */
// coreWorkerFacet 接收完整的 init（含 pid），返回一个 facet；里面只服务 SessionInfo，状态是 constant(init)。
// 这是一个闭包工厂：每次 fork 的子进程用各自的启动数据创建一个 facet。
const coreWorkerFacet = (init: { id: string; title: string; pid: number }) =>
	defineFacet<P>((host) => {
		// constant 把普通对象包装成不可变 watchable；info 成员因此可读、不会变化。
		host.serve(SessionInfo, () => ({ init: constant(init) }));
	});

// worker 的笔记文档；每个 worker 进程各有一份。
const NotesDoc = defineState("notes", { schema: obj({ list: arr(str()) }), version: 1, initial: () => ({ list: [] }) });

/** A plugin's facet on the worker: its notes, and the start data read through a reference. */
// notesFacet 是插件 facet：服务 Notes，并通过依赖引用读取核心 facet 的 SessionInfo。
const notesFacet = defineFacet<P>((host) => {
	host.serve(Notes, (_, _principal, self) => {
		const doc = self.state(NotesDoc);
		// self.get 声明对 SessionInfo 的依赖；Chord 保证它在 Notes 激活前可用。
		const info = self.get(SessionInfo, {});
		return {
			variant: "owner",
			members: {
				// info.init 是依赖引用的状态成员；直接作为 Notes.info 暴露。
				info: info.init,
				// notes 派生自文档列表。
				notes: self.derive([doc], ([d]) => d.list),
				// add 追加文本并返回长度；`void` 丢弃 push 的返回值。
				add: async ({ text }, ctx) => {
					await doc.change((draft) => void draft.list.push(text), ctx);
					return doc.value.list.length;
				},
			},
		};
	});
});

// 同一个文件根据第一个命令行参数选择角色：server 分支 fork 时会传 "worker"。
if (process.argv[2] === "worker") {
	// The worker. 1. Its link first: it queues the link's messages until the host listens, and skips the app's own.
	// 把 Node 的 IPC 通道包装成 Link；IpcPort 是 link 层需要的最小接口，这里用两次断言桥接 Node 类型。
	const link = ipcLink(process as unknown as IpcPort);
	// 等待应用的启动消息；这是普通 process message，不是 Chord 链路消息。
	const start = await new Promise<Start>((resolve) => {
		// listener 只处理非 Uint8Array 的消息；链路的二进制分片会被跳过。
		const listener = (message: unknown) => {
			if (message instanceof Uint8Array) return;
			// 拿到启动消息后移除监听器，避免后续消息重复触发。
			process.off("message", listener);
			// The start message the server's `resolve` sent: the app's own shape.
			// as Start 只是告诉 TypeScript 形状，运行时不校验；发送方由 satisfies 约束过。
			resolve(message as Start);
		};
		// 开始监听父进程消息；link 会自行排队，直到宿主开始监听。
		process.on("message", listener);
	});
	// 2. Its host at its address: connect first (W6), then load the core facet with the start data, then the plugins.
	// worker 宿主以会话地址标识自己，principal 是带 session 的 worker。
	const worker = createHost<P>({
		address: Session({ id: start.id }),
		principal: { kind: "worker", session: start.id },
		onError: console.error,
	});
	// 先 connect（对端视为 server，trusted 放宽分片限额），再 load。
	worker.connect(link, { principal: { kind: "server" }, trusted: true }, context);
	// 核心 facet 先加载并固定命名，插件 facet 随后；start 展开后补上 pid。
	await worker.load(
		[
			{ name: "@example/core", facet: coreWorkerFacet({ ...start, pid: process.pid }) },
			{ name: "@example/notes", facet: notesFacet },
		],
		context,
	);
	// The server closing the link ends the worker.
	// 链路关闭时退出进程；这保证 server 关闭后不会留下孤儿子进程。
	link.onClose(() => process.exit(0));
} else {
	// The server. 3. A route forks a worker per session, sends it its start message and returns the IPC link at once.
	// server 宿主：地址 Server()，principal 为 server。
	const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError: console.error });
	server.route(
		Session,
		{
			// 只有 owner 能进入；guest 等会被拒绝。
			authorize: (principal) => principal.kind === "owner",
			// No `signal` for the fork: the context is aborted when the host closes, which would kill the worker (and emit
			// `error` on the child); a link Chord closes, at `host.close` or because it arrived after it, ends the worker.
			// resolve 按地址 fork 一个子进程；地址的 key 与参数决定启动数据。
			resolve: async (address) => {
				// fileURLToPath 把 import.meta.url 转成本文件路径；子进程以 "worker" 参数运行同一文件。
				// advanced 序列化支持结构化数据；execArgv 把 source 条件与 strip-types 传给子进程。
				const child = fork(fileURLToPath(import.meta.url), ["worker"], {
					serialization: "advanced",
					execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
				});
				// satisfies Start 检查消息形状但不改变推断类型；启动消息会先于链路业务数据到达。
				child.send({ id: address.params.id, title: `Session ${address.params.id}` } satisfies Start);
				// 打印子进程 pid 与地址，便于和 tab 输出的 info.pid 对照。
				console.log(`server: forked pid ${child.pid} for ${address.key}`);
				// 立即返回 IPC 链路；路由不需要等待 worker load 完成。
				return { link: ipcLink(child), principal: { kind: "worker", session: address.params.id }, trusted: true };
			},
		},
		context,
	);
	// server 自身没有 facet；load 建立生命周期并让 route 生效。
	await server.load([], context);

	// 4. Tabs reach the server over a WebSocket; its entry point stamps each as the owner here.
	// 监听回环地址的随机端口（port: 0 由系统分配），等待 listening 事件后读取实际端口。
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise((resolve) => wss.once("listening", resolve));
	// 每个新连接包装成 Link，accept 时把对端登记为 owner。
	wss.on("connection", (socket) => server.accept(webSocketLink(socket), { principal: { kind: "owner" } }, context));
	// address() 的类型是 AddressInfo | string | null；断言为 AddressInfo 后读取 port，运行时不校验。
	const { port } = wss.address() as AddressInfo;

	// 5. A tab: Node's own WebSocket, as a browser's. Its holds go tab → server (relay) → worker.
	// tab 宿主没有 facets；connect 使用 Node 全局 WebSocket，对端 principal 是 server。
	const tab = createHost<P>({ onError: console.error });
	tab.connect(webSocketLink(new WebSocket(`ws://127.0.0.1:${port}`)), { principal: { kind: "server" } }, context);
	await tab.load([], context);
	// 首次 get S1：server 路由时 fork worker，返回后 tab 得到 owner 变体。
	const s1 = await tab.get(Notes, { session: "S1" }, context);
	// info 来自 worker 的启动数据；server pid 是当前进程，用来对照子进程 pid。
	console.log("tab: S1 info", s1.info.value, "server pid", process.pid);
	// 两次写入都经 server 中继到 S1 的 worker。
	await s1.add({ text: "milk" }, context);
	await s1.add({ text: "bread" }, context);
	// 等待状态副本更新后读取。
	await new Promise((resolve) => setTimeout(resolve, 10));
	console.log("tab: S1 notes", s1.notes.value);

	// 6. Another session is another worker process.
	// S2 是不同地址，因此 route 会 fork 第二个 worker；它的文档是空的。
	const s2 = await tab.get(Notes, { session: "S2" }, context);
	console.log("tab: S2 info", s2.info.value, "notes", s2.notes.value);

	// 7. Closing the server closes its route links; each worker exits when its link closes.
	// 先关 tab 关闭 WebSocket 链路，再关 server 关闭路由链路（worker 随之退出），最后关闭 WebSocketServer。
	await tab.close(context);
	await server.close(context);
	await new Promise((resolve) => wss.close(resolve));
	console.log("closed");
}
