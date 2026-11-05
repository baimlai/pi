// Presence and keep-alive counts. `host.references(Type)` is a JSON watchable of the references to objects of a type
// on this host, one entry per reference with the object's params, its principal and its incarnation (two tabs are two
// origins); a derive over it is a viewer count, and a link drop is a departure in the same batch. `host.activity` counts
// what keeps a host busy (holds over links, running calls, jobs, lingering objects), published at most once per
// microtask turn: the app's supervisor decides when an idle worker stops.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/16-presence-and-activity.ts
// 文件导读
// 所属包与示例系列：packages/chord/test/examples，Chord v2 示例 16，对应 slice 4b（presence 与 activity）。
// 演示什么：server 用 host.references(Doc) 观察某类型的全部引用（每条引用一项，含 params/principal/incarnation），
//   并据此派生“观看人数”；两个 tab 属于同一 principal 时共享一个对象但仍是两条引用；链路断开就是一次离开；
//   host.activity 输出宿主忙碌计数（引用、运行中的调用、作业、linger 对象），用于监督者判断何时可以停掉空 Worker。
// 上游/下游：文件顶部命令启动；下游使用 src/host 的 createHost/defineFacet/references/activity、src/contracts 的
//   remote、src/link 的 memoryLinkPair。示例全在进程内运行，无外部服务；调用 think 只是 20ms 的本地延时。
// 能力清单（按演示的机制）：
// - host.references(Type)：JSON watchable，每个引用一项 { params, principal, incarnation }；可作为 derive 的源。
// - 观看人数派生：按 params.id 过滤引用并计数，引用变化与链路断开在同一批次内更新。
// - principal 与对象身份：同 principal 的两个 tab 共享对象，但 references 仍按引用计数（3 条引用、2 个对象）。
// - host.activity：Watchable<ActivityCounts>；字段 references/calls/jobs/lingering，每个微任务轮次最多发布一次。
// - 运行中的调用计入 calls；对象在最后一个引用释放后按 linger 计入 lingering，随后归零。
// 典型运行顺序：server load -> 观察 activity -> 三个 tab（ada 两个、bob 一个）并发创建 -> 各自 get d1 ->
//   打印 viewers 与引用列表 -> think 调用期间观察 calls=1 -> 关闭 bob 的链路（references 减一、lingering 加一）->
//   关闭 ada 两个 tab，等待 linger 结束后 references 与 lingering 归零 -> 停止 watch、关闭 server。
// 示例（符合真实签名）：
//   const activity = await server.activity.watch(context);
//   activity.start(async (call) => {
//     if (call.kind === "value") console.log(call.value.references, call.value.lingering);
//   });
// 运行方式与环境：在 packages/chord 下执行文件顶部命令；无环境变量、无外部服务；总时长约 0.15 秒。
// 预期输出：若干 activity 行，references 从 1 增到 3，think 期间 calls:1，bob 断链后 references:2、lingering:1；
//   viewers seen by ada: 3；references: [ 'ada @ …', 'ada @ …', 'bob @ …' ]（incarnation 后缀因运行而异）；
//   viewers after bob's link dropped: 2；最后 references at the end: 0，并伴随 lingering 递减的 activity 帧。
// 对应测试与文档：packages/chord/test/host/presence.test.ts、activity.test.ts；slices.md 的 slice 4b；
//   references 的实现见 src/host/presence.ts。
// 建议阅读顺序：先看 P、Doc 契约与 server/facet 的 viewers 派生，再看 activity watch 与 tab 辅助函数，
//   随后按 3-6 步读引用计数、运行中调用、断链与 linger 归零。
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { hostKind, int, method, remote, str } from "../../src/contracts/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";

// 后台上下文；所有 get 与关闭显式传入。
const context = BACKGROUND_CONTEXT;

// P 有两种 principal：带名字的 user 与 server；名字用于在 references 列表里区分用户。
type P = { kind: "user"; name: string } | { kind: "server" };

// The server's host kind: a remote contract's `hostAddress` names the host serving its objects.
// 无参数 hostKind；Doc 的 hostAddress 固定返回这个地址。
const Server = hostKind("server");

/** A shared document view: who else is looking (`viewers`), and a slow method. */
// Doc 按 id 寻址；v 变体暴露 viewers 状态和 think 方法（无参数、返回整数）。
const Doc = remote("example.doc", {
	version: 1,
	params: { id: str() },
	hostAddress: () => Server(),
	variants: { v: { state: { viewers: int() }, methods: { think: method(undefined, int()) } } },
});

// 1. The server serves `Doc`; its factory derives the viewer count from `host.references(Doc)` (on the facet's host).
// server 宿主带地址与 server principal；facet 在 setup 中登记 Doc 工厂。
const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError: console.error });
const facet = defineFacet<P>((host) => {
	// 第三个参数给 serve 设置 linger 50ms：最后一个引用释放后对象短暂保留。
	host.serve(
		Doc,
		({ id }, _principal, self) => ({
			variant: "v",
			members: {
				// viewers 派生自 references(Doc)：过滤同一文档 id 的引用并计数。
				// host.references 是 JSON watchable；derive 的源数组元素可以是它，回调收到当前引用列表。
				viewers: self.derive([host.references(Doc)], ([refs]) => refs.filter((ref) => ref.params.id === id).length),
				// think 睡 20ms 后按调用者 principal 返回 42 或 0；返回值为示例展示，不影响状态。
				think: async (ctx) => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					return ctx.principal?.kind === "user" ? 42 : 0;
				},
			},
		}),
		// 对象在引用归零后保留 50ms；期间 activity 记为 lingering。
		{ linger: 50 },
	);
});
await server.load([{ name: "@example/doc", facet }], context);

// 2. The supervisor's view: every publication of the counts.
// 观察 activity；它是宿主级 Watchable<ActivityCounts>，值是不可变快照。
const activity = await server.activity.watch(context);
activity.start(async (call) => {
	// 原生帧 value 分支的 call.value 是 ActivityCounts；JSON.stringify 打印四个计数字段。
	if (call.kind === "value") console.log("  activity:", JSON.stringify(call.value));
});

/** A tab of `name` on a new link; returns the tab and the server's end of its link. */
// tab 辅助函数：创建客户端宿主，先 load，再建立链路；返回 tab 宿主与 server 端链路（用于模拟断线）。
async function tab(name: string) {
	const host = createHost<P>({ onError: console.error });
	await host.load([], context);
	const [a, b] = memoryLinkPair();
	// server 把对端登记为带名字的 user；这就是 references 中 principal 的来源。
	server.accept(a, { principal: { kind: "user", name } }, context);
	host.connect(b, { principal: { kind: "server" } }, context);
	return { host, link: a };
}

// 3. Ada opens the document in two tabs, Bob in one: three references, three incarnations, two objects (one per principal);
// the viewer count is over every object of the document.
// 并发创建三个 tab；ada1/ada2 同 principal，bob 不同。
const [ada1, ada2, bob] = await Promise.all([tab("ada"), tab("ada"), tab("bob")]);
// 每个 tab 各 get 一次 d1：产生三条引用；ada 的两个 tab 共享同一 Doc 对象，bob 有另一对象。
const doc = await ada1.host.get(Doc, { id: "d1" }, context);
await ada2.host.get(Doc, { id: "d1" }, context);
await bob.host.get(Doc, { id: "d1" }, context);
// 等引用登记与派生重新计算完成。
await new Promise((resolve) => setTimeout(resolve, 5));
// viewers 按引用计数，因此是 3（不是对象数 2）。
console.log("viewers seen by ada:", doc.viewers.value);
// server.references(Doc).value 是 Presence 数组；map 把每项格式化为“名字 @ incarnation 后四位”。
const present = server
	.references(Doc)
	.value.map(
		({ principal, incarnation }) => `${principal?.kind === "user" ? principal.name : "?"} @ ${incarnation.slice(-4)}`,
	);
// 打印三条引用；两个 ada 的名字相同但 incarnation 不同（两个宿主实例）。
console.log("references:", present);

// 4. A call running counts as activity until it settles.
// think 运行 20ms；期间 activity 的 calls 为 1，结束后回到 0。
await doc.think(context);

// 5. Bob's link drops: a departure, at once. Bob's own `Doc` object (identities include the principal) lingers.
// 关闭 server 端链路，模拟 bob 离开；引用立即减少，bob 的对象因 linger 暂留 50ms。
bob.link.close();
// 等状态与 activity 发布。
await new Promise((resolve) => setTimeout(resolve, 5));
// 观看人数降到 2（ada 的两个 tab 仍在）。
console.log("viewers after bob's link dropped:", doc.viewers.value);

// 6. Ada closes both tabs: the object lingers (50 ms) with no references, then ends; then everything is zero.
// 关闭 ada 的两个 tab 宿主；它们的引用全部释放，Doc 对象进入 linger。
await ada1.host.close(context);
await ada2.host.close(context);
// 等待超过 linger（100ms > 50ms），让对象结束、activity 归零。
await new Promise((resolve) => setTimeout(resolve, 100));
// 此时该类型没有任何引用。
console.log("references at the end:", server.references(Doc).value.length);
// 停止 activity watch，再关闭 server。
await activity.stop();
await server.close(context);
