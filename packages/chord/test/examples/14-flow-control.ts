// Flow control: a slow tab. At most two of a provider's own `bound`/`state` messages are unacknowledged per origin;
// while the window is full the provider folds the ops of every commit into its pending queues and sends them as one
// message when an `ack` frees a slot. A relay folds and drops nothing: it forwards at once under the tab's origin and
// returns each `ack` to the worker that sent the message, so a slow tab folds at the worker, alone.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/14-flow-control.ts
// 文件导读
// 所属包与示例系列：packages/chord/test/examples，Chord v2 示例 14，对应 slice 4a（流量控制窗口、origin 与中继）。
// 演示什么：一个“慢 tab”暂停读取链路，provider 最多只发送两个未确认的 bound/state 消息；窗口满后 provider 把后续
//   提交的操作折叠进待发队列，等 ack 释放名额后合并成一条消息。经过 server 中继时，中继立即转发并原样回传 ack，
//   因此折叠仍发生在真正发送消息的 worker 上；另一个快 tab 使用不同 origin，照常逐条收到每次变化。
// 上游/下游：文件顶部命令启动；下游使用 src/link 的 memoryLinkPair/binaryCodec/describeMessage、src/host 的
//   createHost/route/accept/connect。示例完全在进程内运行，不启动子进程或网络监听。
// 能力清单（按演示的机制）：
// - Link 接口：send/onMessage/close/onClose 四个方法；tap 与 Pausable 都是手动实现的装饰器。
// - tap：包装链路并解码每条消息，打印 bound/state/ack 的紧凑元组形式，再把原始字节交给下游。
// - Pausable：暂停时缓冲入站消息（tab 因此不发送 ack），resume 后按到达顺序释放。
// - 流控窗口：每个 origin 最多两个未确认的 provider 消息；满窗时 ops 折叠进 pending，ack 后合并发送。
// - origin 与中继：server 为每个下游 tab 分配 origin，消息包成 ["@", origin, tuple]；ack 带同一 origin 回传给 worker。
// - 快慢隔离：慢 tab 的 origin 窗口满时，另一个 origin 的快 tab 不受影响，逐条看到每次 append。
// 典型运行顺序：建 worker S1 与直连慢 tab -> 暂停 -> 1000 次 append -> 观察 tab 未前进而 worker 已 4000 字符 ->
//   resume -> 观察折叠后的状态一次到达 -> 建 server 路由与 S2 worker -> 慢 tab + 快 tab -> 暂停慢 tab 并 append 5 次 ->
//   观察慢 tab 停在空串、快 tab 收到 5 次变化 -> resume -> 慢 tab 一次收到完整文本 -> 依次关闭。
// 示例（符合真实签名）：
//   const slow = new Pausable(down);
//   slow.paused = true;                 // 缓冲入站消息，不产生 ack
//   await reply1.append(" tok", context); // 窗口满后 provider 折叠 pending
//   slow.resume();                      // 释放缓冲，ack 让 provider 发送合并后的 state
// 运行方式与环境：在 packages/chord 下执行文件顶部命令；无环境变量、无外部服务；约几十毫秒完成。
// 预期输出以两段标题开始；第一段先看到 tab ← ["b",…]，暂停时 tab 显示 0 字符而 worker 有 4000；resume 后 tab 显示
//   4000。第二段中 worker ← ["@",1,["a"]] 表示中继回传的 ack；暂停时慢 tab 仍为空、快 tab saw 5 changes；
//   resume 后慢 tab 显示完整文本。折叠后的消息内容较长，tap 只打印前 110 个字符。
// 对应测试与文档：packages/chord/test/remote/provider.test.ts、host-link.test.ts、relay.test.ts；
//   packages/chord/test/link/message.test.ts；slices.md 的 slice 4a 与 design.md 的流量控制章节。
// 建议阅读顺序：先看 Reply/View 契约、workerFacet 与 worker/tab 辅助函数，再看 tap 与 Pausable 两个 Link 实现，
//   最后按 1-4 步读直连折叠与中继折叠。
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { hostKind, local, method, obj, remote, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, type Host } from "../../src/host/index.ts";
import { binaryCodec, describeMessage, type Link, memoryLinkPair } from "../../src/link/index.ts";

// 进程内后台上下文；所有 append 与 get 显式传入。
const context = BACKGROUND_CONTEXT;

// P 覆盖 owner（tab）、server（中继）、带 session 的 worker。
type P = { kind: "owner" } | { kind: "server" } | { kind: "worker"; session: string };

// Server 无参数；Session 以 id 为参数。
const Server = hostKind("server");
const Session = hostKind("session", { id: str() });

/** The worker's own document of a streamed reply, and its one write. */
// Reply 是 worker 的本地类型：reply 是文档状态，append 接收字符串并返回无结果。
const Reply = local("example.reply", {
	version: 1,
	params: {},
	members: { reply: obj({ text: str() }), append: method(str()) },
});

/** What a tab holds: the reply, on its session's worker. */
// View 是 tab 看到的远端契约：按 session 寻址，owner 变体只有 reply 状态。
const View = remote("example.view", {
	version: 1,
	params: { session: str() },
	// 地址工厂把 session 映射为 Session 地址。
	hostAddress: ({ session }) => Session({ id: session }),
	variants: { owner: { state: { reply: obj({ text: str() }) } } },
});

// 每个 worker 一份回复文档，初始为空串。
const ReplyDoc = defineState("reply", { schema: obj({ text: str() }), version: 1, initial: () => ({ text: "" }) });

// workerFacet 同时服务本地 Reply 与远端 View。
const workerFacet = defineFacet<P>((host) => {
	host.serve(Reply, (_, self) => {
		// 文档句柄本身是可观察的，可以直接作为状态成员暴露。
		const doc = self.state(ReplyDoc);
		return {
			// reply 成员就是文档；读取 .value 得到 { text }。
			reply: doc,
			// append 在事务中把 token 追加到文本末尾；没有特殊拼接逻辑，纯字符串 +=。
			append: async (token, ctx) => {
				await doc.change((draft) => {
					draft.text += token;
				}, ctx);
				// 无结果的方法返回 null。
				return null;
			},
		};
	});
	// View 的工厂忽略参数与 principal，声明依赖 Reply 并复用它的 reply 成员。
	host.serve(View, (_params, _principal, self) => ({
		variant: "owner",
		members: { reply: self.get(Reply, {}).reply },
	}));
});

/** A worker for `id`, loaded. */
// worker 辅助函数：按 session id 创建宿主（地址与 principal 都带 id），加载 facet 后返回。
// 注意这里没有 connect/accept；直连场景由 worker.accept 接收 tab， 中继场景由调用方选择 connect。
async function worker(id: string): Promise<Host<P>> {
	const host = createHost<P>({
		address: Session({ id }),
		principal: { kind: "worker", session: id },
		onError: console.error,
	});
	await host.load([{ name: "@example/worker", facet: workerFacet }], context);
	return host;
}

/** A link end that logs, as `label`, every `bound`, `state` and `ack` its host receives. */
// tap 返回一个包装 Link：四个方法全部委托给内部 link，只有 onMessage 增加了日志。
// 输入是链路与标签；输出仍是 Link，因此可以继续交给 accept/connect。
function tap(link: Link, label: string): Link {
	return {
		// 用箭头函数包一层，避免丢失内部 link 的 this；运行时直接转发。
		send: (message) => link.send(message),
		onMessage: (listener) =>
			link.onMessage((message) => {
				// 解码只用于展示；原始 message 仍然原样交给下游 listener。
				const decoded = binaryCodec.decode(message);
				// 只打印流控相关的三种消息；比较 kind 也是类型窄化的起点。
				const shown = decoded.kind === "ack" || decoded.kind === "bound" || decoded.kind === "state";
				// describeMessage 返回文本元组形式；slice(0, 110) 截断长消息，保留可读前缀。
				if (shown) console.log(`  ${label} ←`, describeMessage(decoded).slice(0, 110));
				listener(message);
			}),
		close: () => link.close(),
		onClose: (listener) => link.onClose(listener),
	};
}

/** A slow tab's end of its link: while paused, what arrives waits (so the tab acknowledges nothing). */
// Pausable 实现 Link，用暂停模拟一个处理不过来的 tab：消息到达后先进入 #waiting，不交给消费者。
// # 前缀是 ECMAScript 私有字段，不是 TypeScript 的 private；运行时由引擎保证不可外部访问。
class Pausable implements Link {
	// paused 是公开可变字段，示例直接赋值。
	paused = false;
	readonly #link: Link;
	readonly #waiting: Uint8Array[] = [];
	// #listener 默认空函数，避免未安装监听器时调用报错；类型标注说明它接收原始字节。
	#listener: (message: Uint8Array) => void = () => {};

	constructor(link: Link) {
		this.#link = link;
		// 只登记一次内部监听器；暂停与否在这里分流，而不是在上层。
		link.onMessage((message) => {
			if (this.paused) this.#waiting.push(message);
			else this.#listener(message);
		});
	}

	// resume 关闭暂停并按到达顺序交付缓冲消息；splice(0) 取出全部元素并清空数组。
	resume(): void {
		this.paused = false;
		for (const message of this.#waiting.splice(0)) this.#listener(message);
	}

	send(message: Uint8Array): void {
		this.#link.send(message);
	}

	// Link 只允许一个监听器；这里保存上层安装的那一个。
	onMessage(listener: (message: Uint8Array) => void): void {
		this.#listener = listener;
	}

	close(): void {
		this.#link.close();
	}

	onClose(listener: () => void): void {
		this.#link.onClose(listener);
	}
}

/** A tab connected over `link`, loaded. */
// tab 辅助函数：创建无 facet 的客户端宿主，connect 后 load，返回可 get 的 Host。
async function tab(link: Link): Promise<Host<P>> {
	const host = createHost<P>({ onError: console.error });
	host.connect(link, { principal: { kind: "server" } }, context);
	await host.load([], context);
	return host;
}

// settle 让链路消息与回调跑完；10ms 是示例的观察窗口，不是精确同步保证。
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// 1. Folding at the provider: a tab directly on a worker. Paused, it acknowledges nothing; the worker sends two
// `state` messages (the window), then folds 1,000 appends into its pending queue.
// 第一段：tab 直连 worker；tap 记录 tab 收到的 bound/state。
console.log("a slow tab on the provider:");
const w1 = await worker("S1");
const [up, down] = memoryLinkPair();
// worker.accept 把 tab 视为 owner；链路方向是 tab -> worker。
w1.accept(up, { principal: { kind: "owner" } }, context);
// Pausable 包住 tab 端，便于暂停读取。
const slow = new Pausable(down);
// tab 的链路再包一层 tap，打印它收到的消息。
const t1 = await tab(tap(slow, "tab"));
// 获取远端 View；首次 get 让 worker 创建对象并发送 bound。
const view1 = await t1.get(View, { session: "S1" }, context);
// 在 worker 本地获取 Reply 引用，直接驱动 append（绕开远端窗口）。
const reply1 = await w1.get(Reply, {}, context);
// 暂停：之后到达的状态消息全部进入 #waiting，tab 不会回 ack。
slow.paused = true;
// 连续 1000 次 append，每次 " tok" 共 4 个字符，合计 4000 字符。
for (let i = 0; i < 1_000; i++) await reply1.append(" tok", context);
await settle();
// 暂停状态下 tab 的副本没有前进（0 字符），worker 的文档已有 4000 字符。
console.log(
	"  paused: the tab shows",
	view1.reply.value.text.length,
	"characters, the worker has",
	reply1.reply.value.text.length,
);

// 2. Resumed: the tab applies and acknowledges the two, and the freed slot carries one `state` with one folded append.
// 恢复后 tab 应用缓冲的两条消息并回 ack；worker 用释放的名额发送折叠后的剩余操作。
slow.resume();
await settle();
// tab 现在与 worker 一致：4000 字符。
console.log("  resumed: the tab shows", view1.reply.value.text.length, "characters");

// 3. The same slow tab through a server: its holds reach the worker with the tab's ids under the tab link's origin
// (`["@",1,…]`), the worker's window for that origin fills and it folds there; a second, fast tab is another origin and
// receives every commit.
// 第二段：tab 经 server 中继访问 S2 的 worker。
console.log("a slow tab through a relay:");
const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError: console.error });
// w2 在 resolve 中赋值；let 允许后续使用非空断言读取。
let w2: Host<P> | undefined;
server.route(
	Session,
	{
		// 本例不限制 principal，任何调用者都放行。
		authorize: () => true,
		resolve: async (address) => {
			// a 交给路由，b 交给 worker；worker 用 connect 接入 server。
			const [a, b] = memoryLinkPair();
			w2 = await worker(address.params.id);
			// worker 端包 tap，打印它收到的消息（主要是回传的 ack，带中继 origin）。
			w2.connect(tap(b, "worker"), { principal: { kind: "server" }, trusted: true }, context);
			// 路由立即返回 server 端链路；worker 的加载已在 worker() 内完成。
			return { link: a, principal: { kind: "worker", session: address.params.id }, trusted: true };
		},
	},
	context,
);
await server.load([], context);
// 慢 tab 的链路：server 端 accept 为 owner，客户端链路经 Pausable + tap。
const [up2, down2] = memoryLinkPair();
server.accept(up2, { principal: { kind: "owner" } }, context);
const slow2 = new Pausable(down2);
const t2 = await tab(tap(slow2, "tab"));
// 两个 tab 都访问 S2；它们可能共享同一个 worker 对象，但中继为每条下游链路分配独立 origin，
// 因此慢 tab 的流控窗口与快 tab 互不影响。
const view2 = await t2.get(View, { session: "S2" }, context);
// 快 tab 使用另一条链路与另一个 origin。
const [up3, down3] = memoryLinkPair();
server.accept(up3, { principal: { kind: "owner" } }, context);
const t3 = await tab(down3);
const view3 = await t3.get(View, { session: "S2" }, context);
// 统计快 tab 收到的变化次数。
let fast = 0;
const watch = await view3.reply.watch(context);
watch.start(async () => {
	// 不读取具体值，只计数；watch 每次提交回调一次。
	fast++;
});
// 在 worker 本地取得 Reply；w2 已由 resolve 赋值，非空断言只影响类型。
const reply2 = await w2!.get(Reply, {}, context);
// 暂停慢 tab；快 tab 不受影响。
slow2.paused = true;
// 5 次追加，每次 3 个字符（" t0" 等）。
for (let i = 0; i < 5; i++) await reply2.append(` t${i}`, context);
await settle();
// 慢 tab 的副本仍为空，worker 已有全部 5 段文本。
console.log("  paused: the slow tab shows", view2.reply.value, "the worker has", reply2.reply.value);
// 快 tab 逐条看到 5 次变化。
console.log("  the fast tab saw", fast, "changes:", view3.reply.value);

// 4. Resumed: the slow tab acknowledges the two; the relay returns each `ack` to the worker with the origin, and the
// worker's freed slot carries one `state` with the three folded appends.
// 恢复慢 tab；它应用并确认缓冲的两条消息，中继把 ack 连同 origin 回传给 worker。
slow2.resume();
await settle();
// 慢 tab 最终显示完整文本；折叠细节由 tap 打印的 state 数量体现。
console.log("  resumed: the slow tab shows", view2.reply.value);

// 依次关闭：先 tab 与 worker，再停止 watch、关闭其余 tab 与 server。
await t1.close(context);
await w1.close(context);
await watch.stop();
await t2.close(context);
await t3.close(context);
await server.close(context);
await w2!.close(context);
