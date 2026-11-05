// 验证内存链路的微任务顺序、关闭丢弃与监听器释放；WeakRef 用于检查关闭后不残留强引用。
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { createHost } from "../../src/host/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import { expectCollected, flushed } from "../support.ts";

// 把任意多个数字实参打包成字节数组，无外部副作用；例如 bytes(1,2) 得到两字节。
// ...values 是剩余参数，number[] 是开发时限制，不是运行时数值范围校验。
const bytes = (...values: number[]) => new Uint8Array(values);

// 登记同进程双端链路测试；实现用 queueMicrotask 送到另一端。
describe("memory links", () => {
	// 异步测试先发 1、2 再安装监听器，之后发 3，检查排队和延后交付。
	// 回调无参数，返回 Promise<void>；只创建内存端点，断言顺序必须为 1/2/3。
	it("deliver in order, one task later, and queue what arrives before the listener", async () => {
		// 数组解构取出相连的两端，a.send 对应 b 的入站回调。
		const [a, b] = memoryLinkPair();
		// 用局部数字数组记录收到的首字节；后面回调会修改它。
		const got: number[] = [];
		// 从 a 发出首字节 1，交付由微任务调度；若端点已关则无效果。
		a.send(bytes(1));
		// 紧接着发送 2，让同方向的顺序可被观察。
		a.send(bytes(2));
		// 等待 setImmediate 跨到下一轮事件循环，让已排的微任务送达；不表示所有未来任务完成。
		await flushed();
		// 登记入站回调并记录首字节，已到达的排队消息会同步交给它。
		// ! 只是告诉 TypeScript 样本非空，不在运行时检查长度。
		b.onMessage((message) => got.push(message[0]!));
		// 此观察点只应收到 1、2；发送 3 后立即比较也仍如此，因为尚未运行其微任务。
		expect(got).toEqual([1, 2]);
		// 再发 3，下一条断言发生在其微任务之前。
		a.send(bytes(3));
		// 此观察点只应收到 1、2；发送 3 后立即比较也仍如此，因为尚未运行其微任务。
		expect(got).toEqual([1, 2]);
		// 等待 setImmediate 跨到下一轮事件循环，让已排的微任务送达；不表示所有未来任务完成。
		await flushed();
		// 等待之后要求三条消息完整且有序。
		expect(got).toEqual([1, 2, 3]);
	});

	// 比较关闭本端和对端的通知时机，并检查关闭后发送被丢弃。
	// 本例 a 的关闭同步发生，b 的通知在等待后发生；回调只维护局部记录。
	it("close this end at once and the peer one task later; send after close is a no-op", async () => {
		// 数组解构取出相连的两端，a.send 对应 b 的入站回调。
		const [a, b] = memoryLinkPair();
		// 用字符串数组记录两个端点的关闭通知顺序。
		const closes: string[] = [];
		// 用局部数字数组记录收到的首字节；后面回调会修改它。
		const got: number[] = [];
		// a 的无参数关闭回调把标识写入 closes。
		a.onClose(() => closes.push("a"));
		// b 的关闭通知记录到同一数组，便于比较时机。
		b.onClose(() => closes.push("b"));
		// 登记入站回调并记录首字节，已到达的排队消息会同步交给它。
		// ! 只是告诉 TypeScript 样本非空，不在运行时检查长度。
		b.onMessage((message) => got.push(message[0]!));
		// 关闭 a；同时排队关闭其对端，尚未交付的消息会被丢弃。
		a.close();
		// 此刻仅 a 应同步通知，b 尚未通知。
		expect(closes).toEqual(["a"]);
		// 从 a 发出首字节 1，交付由微任务调度；若端点已关则无效果。
		a.send(bytes(1));
		// 等待 setImmediate 跨到下一轮事件循环，让已排的微任务送达；不表示所有未来任务完成。
		await flushed();
		// 跨过调度后，对端关闭也应完成。
		expect(closes).toEqual(["a", "b"]);
		// 对已经关闭的 b 也尝试发送，验证另一方向同样无效。
		b.send(bytes(2));
		// 等待 setImmediate 跨到下一轮事件循环，让已排的微任务送达；不表示所有未来任务完成。
		await flushed();
		// 要求记录仍为空，表明这些发送未触发消息监听器。
		expect(got).toEqual([]);
		// 记录在端点关闭之后才登记的关闭监听器是否立刻执行。
		const late: string[] = [];
		// 已关闭端点应立刻调用这个无参数回调，而不是继续保存它。
		a.onClose(() => late.push("late"));
		// 无需等待即出现记录，证明晚登记通知同步发生。
		expect(late).toEqual(["late"]);
	});

	// 先排队向 a 发送，再在交付前关闭 a；要求收到列表为空。
	// 无输入，返回完成断言的 Promise；例如待交付的 1 不应越过关闭边界。
	it("drop messages still in flight to a closed end", async () => {
		// 数组解构取出相连的两端，a.send 对应 b 的入站回调。
		const [a, b] = memoryLinkPair();
		// 用局部数字数组记录收到的首字节；后面回调会修改它。
		const got: number[] = [];
		// 监听 a 的入站消息，用首字节数组观察是否错误交付。
		a.onMessage((message) => got.push(message[0]!));
		// 消息刚排进微任务队列，还没有到达 a。
		b.send(bytes(1));
		// 关闭 a；同时排队关闭其对端，尚未交付的消息会被丢弃。
		a.close();
		// 等待 setImmediate 跨到下一轮事件循环，让已排的微任务送达；不表示所有未来任务完成。
		await flushed();
		// 要求记录仍为空，表明这些发送未触发消息监听器。
		expect(got).toEqual([]);
	});

	// 先积压两条入站消息，让监听器处理首条时关闭 b，要求不再交付第二条。
	// 实际只记录 1；此回调通过关闭内存端点改变测试状态，无真实传输。
	it("stop delivering queued messages once a listener closed the link", async () => {
		// 数组解构取出相连的两端，a.send 对应 b 的入站回调。
		const [a, b] = memoryLinkPair();
		// 用局部数字数组记录收到的首字节；后面回调会修改它。
		const got: number[] = [];
		// 从 a 发出首字节 1，交付由微任务调度；若端点已关则无效果。
		a.send(bytes(1));
		// 紧接着发送 2，让同方向的顺序可被观察。
		a.send(bytes(2));
		// 等待 setImmediate 跨到下一轮事件循环，让已排的微任务送达；不表示所有未来任务完成。
		await flushed();
		// 安装接收回调，输入一条字节消息；每次执行都会记录并关闭本端。
		// 例如第一次收到 1 时关闭，待交付的 2 随即丢弃。
		b.onMessage((message) => {
			// 先记录触发本次回调的字节，方便区别完全未调用与调用一次。
			got.push(message[0]!);
			// 在回调内部关闭端点，使队列交付循环的后续轮次发现已关闭。
			b.close();
		});
		// 要求只有首条记录，第二条不能继续穿过关闭点。
		expect(got).toEqual([1]);
	});

	// 保留端点本身，弱引用其监听器，然后关闭并请求 GC，检验不再持有回调。
	// 返回异步断言结果；实际观察仅这些样本监听器可回收，不证明所有对象都无泄漏。
	it("keep no listener once closed", async () => {
		// 数组解构取出相连的两端，a.send 对应 b 的入站回调。
		const [a, b] = memoryLinkPair();
		// 立即调用函数表达式隔离局部强引用；返回 WeakRef 数组供外层观察回收。
		const refs = (() => {
			// 创建无输入、无返回和无副作用的空监听函数，仅用于被链路持有与回收。
			const listener = { onMessage: () => {} };
			// 把同一个函数安装为 a 的消息监听器。
			a.onMessage(listener.onMessage);
			// 也安装为关闭监听器，要求两种监听槽都在关闭后释放。
			a.onClose(listener.onMessage);
			// 仅把弱引用传出，不让测试自身延长监听器寿命。
			return [new WeakRef(listener.onMessage)];
			// 结束并立即执行隔离作用域，让局部强引用离开当前执行范围。
		})();
		// 关闭 a；同时排队关闭其对端，尚未交付的消息会被丢弃。
		a.close();
		// 等待 setImmediate 跨到下一轮事件循环，让已排的微任务送达；不表示所有未来任务完成。
		await flushed();
		// 展开弱引用列表交给辅助函数，多轮等待和 GC 后要求它们均无法解引用。
		await expectCollected(...refs);
		// 仍保留对端变量，避免因为整对链路都不可达而掩盖监听器清理问题。
		expect(b).toBeDefined();
	});
});

// 登记已关闭端点再次被 host 接收时的引用释放测试。
describe("a closed memory link", () => {
	// 先关闭链路，再让临时 host accept 它，保留端点并检验 host 可被回收。
	// 本例使用空插件 host，无业务调用；返回 GC 检查的 Promise，副作用仅内存对象创建。
	it("keeps no listener set after its close: accepting it keeps no host", async () => {
		// 数组解构取出相连的两端，a.send 对应 b 的入站回调。
		const [a, b] = memoryLinkPair();
		// 关闭 a；同时排队关闭其对端，尚未交付的消息会被丢弃。
		a.close();
		// 等待 setImmediate 跨到下一轮事件循环，让已排的微任务送达；不表示所有未来任务完成。
		await flushed();
		// 异步立即调用函数把 host 的强引用限制在局部，外层只获得弱引用。
		const refs = await (async () => {
			// 创建 host；空错误回调不记录后台错误，因此本例的断言只针对可回收性。
			const host = createHost({ onError: () => {} });
			// 加载空插件集合，使 host 完成首次加载；背景上下文不主动取消。
			await host.load([], BACKGROUND_CONTEXT);
			// 将已关闭 a 当作子链接接收，传入本地指定的 owner 身份。
			host.accept(a, { principal: { kind: "owner" } }, BACKGROUND_CONTEXT);
			// 只返回 host 的弱引用，允许其失去作用域内最后的强引用。
			return [new WeakRef(host)];
			// 结束并立即执行隔离作用域，让局部强引用离开当前执行范围。
		})();
		// 展开弱引用列表交给辅助函数，多轮等待和 GC 后要求它们均无法解引用。
		await expectCollected(...refs);
		// 保留两端点，GC 断言不能靠端点本身先被回收来成立。
		expect([a, b]).toBeDefined();
	});
});
