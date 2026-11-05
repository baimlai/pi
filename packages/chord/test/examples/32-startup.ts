// 文件导读
// 所属：packages/chord/test/examples，Chord v2 示例 32，对应 slice 7a（启动屏障/依赖模型 §6）。
// 演示内容：load 先在一个批次里发布所有 facet 的声明，再启动 host-lifetime 对象；此时发出的请求与链路上的 hold
// 只等这次发布，不等 start barrier。两个 host 的对象互相依赖（无环）不会死锁：server 的 Bootstrap 需要 worker 的
// Agent，Agent 需要 server 的 Catalog。load 的 resolve 条件是每个 host-lifetime 对象都已有首次结局：
// live、因自身原因失败、在此无阻塞者的停放，或 ended；等待另一个 host 也算首次结局，因此 server.load 不会等 worker。
// 上游入口：命令行直接运行；两个内存 host 经 memoryLinkPair 相连，不写文件、不联网。
// 下游调用：hostKind/remote/local、createHost/defineFacet/route/load/get/hold、memoryLinkPair、constant。
// 失败行为：插件 setup 抛错会被 load 报告并排除；本例无失败。worker 的 load 用 void + then 记录完成，
// 不阻塞任何调用方；后台错误走各自宿主的 onError。
// 能力清单（按演示机制列出，本文件没有导出）：
// - Principal：server/worker（带 session）身份。
// - Server/Session：hostKind 地址种类；Session 带 {id} 参数。
// - Bootstrap：server 上的空参数本地对象，load 时启动，依赖 Agent。
// - Agent：session worker 上的远程对象；Catalog：server 上的远程对象，state models。
// - startWorker()：建 worker host，先 connect 再 load（W6），返回 worker 与链路端。
// - server.route(Session)：按地址参数创建 worker 并返回链路/身份。
// - core facet：服务 Catalog（constant(3)）与 Bootstrap。
// - 主流程：server.load（发布后 Bootstrap 停放）→ server.load resolve → get Bootstrap 等到 live，读到 3。
// 典型运行顺序：定义契约 → 建 server、声明 route → load（Bootstrap 启动并跨 host 等待）→ get(Bootstrap) →
// 释放引用、关闭 server 与所有 worker。
// 示例（真实签名）：
//   const bootstrap = await server.get(Bootstrap, {}, context);   // 等到 live
//   const models: number = bootstrap.agents.value;
// 阅读顺序：先看四个类型/契约与 startWorker，再看 route 与 core facet，最后读两段主流程。
// 前置条件：Node 支持 --experimental-strip-types。在 packages/chord 下运行：
//   node --conditions=source --experimental-strip-types test/examples/32-startup.ts
// 预期输出（本机实测；毫秒数与相邻行先后随调度略变，状态结论不变）：
//   3 ms: server: Bootstrap declares the worker's Agent
//   5 ms: worker loaded
//   5 ms: worker: Agent declares the server's Catalog
//   6 ms: server loaded; Bootstrap is loading
//   7 ms: Bootstrap live, it sees 3 models through the worker
// 相关文档：packages/chord/docs/slice-7a.md（启动屏障、W6）与 design.md §6；相关测试：test/host/ 的 startup/依赖用例。
// Startup (dependency model §6, slice 7a): `load` publishes every facet's declarations in one batch first, then starts
// the host-lifetime objects; requests made here and holds arriving on links wait only for that publication, never for
// the start barrier. Two hosts whose objects need each other's types (an acyclic graph) used to deadlock: the server's
// eager `Bootstrap` needs the worker's `Agent`, the `Agent` needs the server's `Catalog`, and the worker's hold for
// `Catalog` waited for the server's whole `load`, which waited for `Bootstrap`. Now it starts at once, no timeout.
// `load` resolves when each host-lifetime object had its first outcome: live, failed by its own cause, or parked with
// no blocker here still without one (a wait on another host ends the first pass).
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/32-startup.ts
// hostKind/remote/local 来自契约层；constant 是永不变化的 watchable；memoryLinkPair 提供内存链路两端。
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { hostKind, int, local, remote, str } from "../../src/contracts/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import { constant } from "../../src/state/index.ts";

const context = BACKGROUND_CONTEXT;
// 相对启动的毫秒数，用来观察启动顺序与耗时；取整到毫秒。
const started = Date.now();
const at = (): string => `${Date.now() - started} ms`;

// worker 身份携带 session；server 身份不携带参数。判别字段是字面量 kind，收窄后可读 session。
// 只是类型，principal 的字段由宿主/链路配置决定，运行期不做 schema 校验。
type Principal = { readonly kind: "server" } | { readonly kind: "worker"; readonly session: string };

// 两个宿主种类：Server() 无参数；Session({id}) 带参数，地址键包含 id。
// hostKind 的 params 声明会在创建时快照并检查必填字段。
const Server = hostKind("server");
const Session = hostKind("session", { id: str() });

/** On the server, a host-lifetime object (local, empty params): it starts at `load`. */
// host-lifetime 对象：空 params 的本地对象在 load 的启动阶段激活，而不是等 get。
// agents 是 int 状态成员，实现是 Agent 的 models（见 core facet）。
const Bootstrap = local("example.bootstrap", { version: 1, params: {}, members: { agents: int() } });

/** On the session's worker. */
// 远程 Agent：按 session 分对象；hostAddress 把地址指向对应 Session 宿主。
// 变体 v 只有 state models；远程对象的状态由工厂成员的 watchable 提供。
// hostAddress 决定放置，不进入指纹；同一契约可以放在不同地址的宿主上。
const Agent = remote("example.agent", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: { v: { state: { models: int() } } },
});

/** On the server. */
// Catalog 放在 Server 宿主；空 params 表示单一对象，所有 worker 共享。
// 注意它仍是远程契约（可以从别的 host 取），只是地址固定在本 server。
const Catalog = remote("example.catalog", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { v: { state: { models: int() } } },
});

/** The worker of a session, started by the server's route; it connects first, then loads (W6). */
// 用途：为一个 session 创建 worker 宿主，先把父链路连好，再异步 load 它的插件。
// 输入：id（session 字符串）；输出：{worker, link}，link 是交给 server 路由的一端。
// 副作用：创建 host、连接链路、启动 load；load 的 Promise 不 await（由 server 的启动流程继续推进）。
// 错误路径：createHost/connect 同步抛错向上传播；load 的插件失败进入 load 报告（这里没有）。
// 主要流程：memoryLinkPair → createHost(address=Session) → connect(down, server 身份) → 定义 agents facet →
// void load().then(记录 worker loaded) → 返回 up 端。
// 关键顺序（W6）：worker 必须先 connect 再 load，这样 load 期间发出的远程 hold 能立即沿父链路发出，
// 而不是等一个还没有的链路。
// 类型说明：ReturnType<typeof startWorker> 在后面用来给 workers 数组元素定型，避免手写返回结构。
// 示例（真实签名）：const { worker, link } = startWorker("S1");
function startWorker(id: string) {
	// 同一内存链路的两端；worker 连 down，server 稍后接受 up。
	const [up, down] = memoryLinkPair();
	// address 让本宿主成为 Session({id}) 的目的地；principal 是 worker 自身身份。
	// onError 只打印后台错误 kind；本例运行中没有。
	const worker = createHost<Principal>({
		address: Session({ id }),
		principal: { kind: "worker", session: id },
		onError: (error) => console.log(`${at()}: worker reported ${error.kind}`),
	});
	// 父链接：对端（server）身份为 server；trusted 跳过消息编码检查，但不放宽 principal 字段。
	// connect 在 load 之前完成，符合 W6。
	worker.connect(down, { principal: { kind: "server" }, trusted: true }, context);
	// facet：服务 Agent（远程类型）。工厂在 Agent 被创建时运行一次。
	const agents = defineFacet<Principal>((host) =>
		host.serve(Agent, (_params, _principal, self) => {
			// 这一行证明“Agent 工厂确实执行了”，并且它声明的是 server 的 Catalog（跨 host 依赖）。
			console.log(`${at()}: worker: Agent declares the server's Catalog`);
			// 成员 models 直接使用 Catalog 引用的 state 成员（watchable）；Catalog 未绑定时 Agent 停放。
			return { variant: "v", members: { models: self.get(Catalog, {}).models } };
		}),
	);
	// 不 await load：worker 的启动与 server 的启动并行推进。
	// `void` 明确表示丢弃 Promise；.then 只记录完成。load 的失败项在报告里，这里不检查。
	void worker
		.load([{ name: "@example/agents", facet: agents }], context)
		.then(() => console.log(`${at()}: worker loaded`));
	// 返回 worker（收尾关闭）与 server 端链路（up）。
	return { worker, link: up };
}

// 保存 route 创建的 worker，便于最后关闭。ReturnType<typeof startWorker> 提取返回对象类型。
const workers: ReturnType<typeof startWorker>[] = [];
// server 宿主：地址 Server，自身身份 server，readyTimeout 设为 10 分钟。
// 这里故意给一个很长的 readyTimeout：即使有它，也没有任何路径在等它——启动不靠超时打破死锁。
// onError 打印后台错误 kind；本例运行中没有。
const server = createHost<Principal>({
	address: Server(),
	principal: { kind: "server" },
	// No readyTimeout is needed to break anything: a long one shows nothing waits for it.
	readyTimeout: 600_000,
	onError: (error) => console.log(`${at()}: server reported ${error.kind}`),
});
// 为 Session 种类声明路由（必须在 load 之前）：这是 server 端到达某个 Session 地址时的解析方式。
// authorize 是信任边界：这里无条件放行；真实应用应在这里检查调用者身份。
// resolve 收到 Address，返回链路与对端 principal；async 表示允许异步建立链路。
// address.params.id 的类型来自 hostKind 的 params 声明（string），无需再校验。
server.route(
	Session,
	{
		authorize: () => true,
		resolve: async (address) => {
			// 为该 session 启动 worker，并记录到 workers。
			const started = startWorker(address.params.id);
			workers.push(started);
			// link 是 server 这一端；principal 标记经此链路到达的请求身份为对应 worker。
			return { link: started.link, principal: { kind: "worker", session: address.params.id }, trusted: true };
		},
	},
	context,
);
// core facet：Catalog 与 Bootstrap 都在 server 上。
// Catalog 工厂返回 models = constant(3)：常量 watchable，永不发新帧；因此 worker 读到的永远是 3。
// Bootstrap 工厂在 load 启动阶段运行：先声明 Agent（session S1）依赖，members.agents 直接使用其 models 成员。
// self.get 不等待；依赖跨 host 未就绪时 Bootstrap 停放，而不是抛错。
const core = defineFacet<Principal>((host) => {
	host.serve(Catalog, () => ({ variant: "v", members: { models: constant(3) } }));
	host.serve(Bootstrap, (_, self) => {
		console.log(`${at()}: server: Bootstrap declares the worker's Agent`);
		return { agents: self.get(Agent, { session: "S1" }).models };
	});
});

// 1. The server's load: publication (Catalog served), then Bootstrap starts and parks on the worker's Agent. A wait on
// another host is a first outcome, so `load` resolves without waiting for the worker.
// load 的两个阶段：先在一个批次里发布 Catalog 等服务；发布后所有已等待的 hold 得以放置。
// 然后启动空参数对象 Bootstrap：它声明 Agent 依赖，Agent 的 hostAddress 是 Session，触发 route 创建 worker。
// Bootstrap 的首次结局是“停放在另一 host 的依赖上”，因此 server.load 可以 resolve，不等待 worker。
// 此时的引用状态是 loading：引用层对“对象正在等待/激活/链路未就绪”的较粗视图。
await server.load([{ name: "@example/core", facet: core }], context);
console.log(`${at()}: server loaded; Bootstrap is ${server.hold(Bootstrap, {}, context).state.value.kind}`);

// 2. The worker's hold for Catalog bound on the published server; Agent went live, then Bootstrap.
// worker 在 server 发布之后 loads：Agent 工厂声明 Catalog；Catalog 已在 server 上发布，所以 hold 立即绑定。
// Agent live 后，server 上的 Bootstrap 依赖满足，自动继续为 live。
// get 在这里等待引用 live（readyTimeout 600s 只是上限，实际毫秒级）；返回的引用可用于读成员。
const bootstrap = await server.get(Bootstrap, {}, context);
// agents 是 int 成员，实际来源是 Agent 的 models（Catalog 的 constant(3) 跨两次链路传回）。
// 输出 3 证明跨 host 依赖链已全部绑定。
console.log(`${at()}: Bootstrap live, it sees ${bootstrap.agents.value} models through the worker`);

// 收尾：释放 Bootstrap 引用；关闭 server（其链路与对象随之结束）；再关闭每个 worker。
// workers 由 route 的 resolve 创建，可能在 load 期间；此处按创建顺序关闭。
bootstrap.release();
await server.close(context);
for (const { worker } of workers) await worker.close(context);
