// Surviving drops: a reference held before any link exists, `ref.state` as it follows the link, calls parked while
// loading and sent in order once live, a call in flight when the link drops, and the re-hold after `connect` again.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/10-drops.ts
// 文件导读
// 所属包与示例系列：packages/chord/test/examples，Chord v2 示例 10，对应 slice 3b（引用状态、链路断开与重新持有）。
// 演示什么：在没有链路时先 hold 一个远端引用（状态 loading、variant 未知），调用会在本地排队；连接后引用转 live，
//   排队调用按原顺序发出；链路中断时在途调用以 unavailable 拒绝且不重发，引用回到 loading 并保留最后的值；
//   重新连接后引用被重新持有，成员取得新快照，等待中的调用按顺序发送；最后 release 让引用 ended。
// 上游/下游：文件顶部命令启动；下游使用 src/host 的 createHost/defineFacet/hold/get、src/link 的 memoryLinkPair、
//   src/contracts 的 remote/defineState。示例只在进程内通信，不访问网络。
// 能力清单（按演示的机制）：
// - host.hold：同步返回引用；没有链路时也能立刻拿到句柄，状态为 loading。
// - ref.state：NativeWatchable<RefState>，本示例用 watch 观察 loading → live → loading → live → ended。
// - 排队调用：加载期间通过引用发出的调用不会立即失败，而是等待链路就绪后按顺序发送。
// - 在途调用与断开：链路关闭时在途调用以 ChordError code "unavailable"、message "the link closed" 拒绝，不重发。
// - 重新持有：connect 新链路后引用自动 re-hold，成员拿到新快照，排队调用按创建顺序发送。
// - release：引用 ended（code released，无 reason 表示持有人主动释放），其 state watch 以 ended 结束。
// - serve 的 linger 选项：对象在最后一个引用释放后继续存活 60 秒，重连的客户端因此能找回原有文档。
// 典型运行顺序：load 两端 -> hold（无链路）-> 观察 ref.state -> 发起一个排队 add -> connect -> 得到排队结果 ->
//   发起 slow 并在 10ms 后关闭 server 端链路 -> 观察在途失败与保留值 -> 链路断开时再发起两个 add -> 重新 connect ->
//   观察成员帧与两个调用的顺序结果 -> release -> 关闭两端。
// 示例（符合真实签名）：
//   const notes = client.hold(Notes, { session: "S1" }, context); // 立即返回，state 为 loading
//   const pending = notes.add({ text: "queued" }, context);       // 链路未建立时排队
//   // connect 之后 pending resolve，返回值是服务端文档长度
// 运行方式与环境：在 packages/chord 下执行文件顶部命令；纯进程内、无环境变量；约几十毫秒完成。
// 预期输出：held without a link: { kind: 'loading' } variant: undefined；ref.state → live；parked call's result
//   once live: 1；notes: [ 'written while loading' ] variant: editor；ref.state → loading；in-flight call:
//   rejected: the link closed；after the drop: { kind: 'loading' } last notes: [...]；两张 notes frame（插入补丁）；
//   parked results, in order: 2 3；release 后 watch ended: { kind: 'ended' } 且 state 为 ended(released)。
// 对应测试与文档：packages/chord/test/remote/hold.test.ts、replica.test.ts；packages/chord/test/host/ref-state.test.ts；
//   slices.md 的 slice 3b；断链后的持久化行为见示例 28-persisted-jobs.ts 等。
// 建议阅读顺序：先看 Notes 契约、NotesDoc 与带 linger 的工厂，再看 connect/settle 辅助函数，随后按 main 的 1-6 步
//   读 hold、排队、断链、重连与释放。
import { BACKGROUND_CONTEXT, type Context } from "../../src/context/index.ts";
import { arr, hostKind, int, method, obj, remote, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, type Host } from "../../src/host/index.ts";
import { type Link, memoryLinkPair } from "../../src/link/index.ts";

// 进程内后台上下文；hold/get 与调用都显式传入。
const context = BACKGROUND_CONTEXT;

// P 是两端 principal 的联合；判别字段 kind 用于类型窄化。
type P = { kind: "owner" } | { kind: "server" };

// The server's host kind: a remote contract's `hostAddress` names the host serving its objects.
// 无参数 hostKind；Server() 生成地址供 hostAddress 使用。
const Server = hostKind("server");

// Notes 只有一个 editor 变体：notes 是字符串数组，add 返回整数，slow 用于制造在途调用。
const Notes = remote("example.notes", {
	version: 1,
	params: { session: str() },
	// hostAddress 忽略参数，固定返回 Server()。
	hostAddress: () => Server(),
	variants: {
		editor: {
			state: { notes: arr(str()) },
			methods: { add: method(obj({ text: str() }), int()), slow: method() },
		},
	},
});

// 服务端文档保存字符串列表；initial 只在首次创建时求值。
const NotesDoc = defineState("notes", { schema: obj({ list: arr(str()) }), version: 1, initial: () => ({ list: [] }) });

// facet 登记远端契约；第三个参数是 ServeOptions，这里设置 linger。
const facet = defineFacet<P>((host) => {
	// Lingers for a minute after its last reference: a client that reconnects within it finds its notes again.
	// 工厂参数解构：第一个是 params（未用），第二个 principal（未用），第三个是 self。
	host.serve(
		Notes,
		(_, _principal, self) => {
			// 取得文档句柄；对象 linger 期间文档和依赖都保留。
			const doc = self.state(NotesDoc);
			return {
				variant: "editor",
				members: {
					// notes 派生自文档列表；返回不可变数组。
					notes: self.derive([doc], ([d]) => d.list),
					// add 在事务中追加文本；`void` 丢弃 push 的返回值，回调不返回业务值。
					add: async ({ text }, ctx) => {
						await doc.change((draft) => void draft.list.push(text), ctx);
						// 提交后读取文档长度作为结果；这里是同步读取当前值。
						return doc.value.list.length;
					},
					// slow 一直挂起，直到处理器 context 被中止（调用取消或引用释放）时 resolve null。
					slow: (ctx) => new Promise((resolve) => ctx.abortSignal?.addEventListener("abort", () => resolve(null))),
				},
			};
		},
		// 最后一个引用释放后继续存活 60 秒；期间新的 hold 复用同一对象和文档。
		{ linger: 60_000 },
	);
});

// server 宿主：address 供寻址，principal 是本地请求身份。
const server = createHost<P>({
	address: Server(),
	principal: { kind: "server" },
	onError: (error) => console.error("server:", error),
});
// 发布 facet；带参数的 Notes 要等首次访问才创建。
await server.load([{ name: "@example/notes", facet }], context);
// client 没有 facets；先 load 建立宿主生命周期，稍后才连接。
const client = createHost<P>({ onError: (error) => console.error("client:", error) });
await client.load([], context);

/** A new link between the hosts: the server stamps the client as its owner. Returns the server's end. */
// connect 辅助函数：建立内存链路，server 侧把对端登记为 owner，client 侧把对端登记为 server。
// 返回 server 端的 Link（up），方便第 3 步主动关闭链路；client 端 down 不再暴露。
function connect(server: Host<P>, client: Host<P>, context: Context): Link {
	const [up, down] = memoryLinkPair();
	server.accept(up, { principal: { kind: "owner" } }, context);
	client.connect(down, { principal: { kind: "server" } }, context);
	return up;
}

// settle 返回 10ms 后 resolve 的 Promise；用于让链路消息与回调跑完，不是精确同步点。
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// 1. A hold before any link: a reference at once, `loading`, its variant unknown. Calls on it park.
// hold 同步返回引用；此时没有链路，state 为 loading，variant 尚未知（运行时 undefined）。
const notes = client.hold(Notes, { session: "S1" }, context);
// 打印初始状态与变体；模板中的 undefined 是运行时值，不是字符串。
console.log("held without a link:", notes.state.value, "variant:", notes.variant);
// 观察引用状态；state.watch 是 NativeWatchable，返回原生 watch 句柄。
const watch = await notes.state.watch(context);
// 原生帧只有 value/failed 两种；value 分支的 call.value 是 RefState，读取 kind 即可。
watch.start(async (call) => {
	if (call.kind === "value") console.log("  ref.state →", call.value.kind);
});
// 加载期间调用 add：不会立刻失败，而是本地排队，等引用 live 后发送；pending 是它的 Promise。
const parked = notes.add({ text: "written while loading" }, context);

// 2. Connect: the reference is held over the link, goes live, and the parked call is sent.
// 建立链路；引用自动 re-hold，状态转 live，排队调用被发出。
let link = connect(server, client, context);
// await parked 得到服务端 add 的结果（文档长度 1）。
console.log("parked call's result once live:", await parked);
// 读取副本成员与变体，确认引用已可用。
console.log("notes:", notes.notes.value, "variant:", notes.variant);

// 3. The link drops (the server's end closes it). A call in flight fails `unavailable` and is never resent; the
// reference goes loading and keeps its last values.
// 先发起慢调用；它会在服务端挂起，直到链路关闭使处理器 context 被中止。
const inFlight = notes.slow(context).catch((error: Error) => `rejected: ${error.message}`);
// 等 10ms，确保调用已经在途而不是仍在排队。
await settle();
// 关闭 server 端链路；两端都会感知断开。
link.close();
// 在途调用以 unavailable / "the link closed" 拒绝，且不会被重发。
console.log("in-flight call:", await inFlight);
// 等状态传播完成。
await settle();
// 引用回到 loading，但成员保留断开前的最后值，仍可同步读取。
console.log("after the drop:", notes.state.value, "last notes:", notes.notes.value);

// 4. Calls made while the link is down park; they wait at most the reference's readyTimeout (60 s here).
// 链路断开期间再次调用：两个 add 都在引用上排队；等待上限是引用的 readyTimeout（宿主默认 60 秒）。
const first = notes.add({ text: "first while down" }, context);
const second = notes.add({ text: "second while down" }, context);

// 5. The app connects again (its link adapter would): every reference is held again with fresh ids, its members get
// the new snapshot as one frame `[["r", value]]`, then the parked calls are sent in the order they were made.
// 在重连前建立成员 watch，观察重新持有后到达的帧。
const frames = await notes.notes.watch(context);
frames.start(async (call) => {
	// 打印差分操作：根替换是 "r"，增量补丁（例如列表插入）是 "p"；本示例的两条打印对应两个排队 add。
	if (call.kind === "value") console.log("  notes frame:", JSON.stringify(call.ops));
});
// 建立新链路；引用重新持有，成员快照与排队调用随之到达。
link = connect(server, client, context);
// 按创建顺序 await 两个排队调用：服务端文档长度为 2 和 3，证明发送顺序与调用顺序一致。
console.log("parked results, in order:", await first, await second);
// 等待帧回调执行。
await settle();
// 读取重新持有后的完整成员值。
console.log("notes after the re-hold:", notes.notes.value);

// 6. Release: `ref.state` is `ended` (its error says the holder released it) and its watch ends.
// release 同步释放引用；waiting/in-flight 调用随之拒绝。
notes.release();
// watch.closed 是 state watch 的终态（ended）；state.value 是引用终态，错误为 released（无 reason）。
console.log("watch ended:", await watch.closed, "state:", notes.state.value);
// 先关 client 再关 server；linger 的对象最终随宿主关闭而结束。
await client.close(context);
await server.close(context);
