// 用记录发送顺序的假调用，验证远端调用窗口的握手、排队、取消和内存释放。
import { describe, expect, it } from "vitest";
import { CallWindow, type QueuedCall } from "../../src/remote/calls.ts";
import { expectCollected } from "../support.ts";

/** A call of `hold` that records its name in `sent` when it goes out. */
// 制作一个排队项：name 是测试用名称，sent 是共享日志，hold 默认 0。
// 返回 QueuedCall；窗口真正发送时才向日志追加名称，不执行网络请求。
// 例如 callOf("a", log, 1) 属于 hold 1；void 丢弃 push 返回的数组长度，使 send 返回 undefined。
function callOf(name: string, sent: string[], hold = 0): QueuedCall {
	// 属性简写 hold 等于 hold: hold；闭包捕获 name 和 sent，直到调用项被释放。
	return { hold, send: () => void sent.push(name) };
}

// describe 的回调只注册下面的用例；每个 it 的回调由 Vitest 执行，断言失败会使该用例失败。
describe("the call window", () => {
	// 无输入、无业务返回值；以三次提交模拟握手前的调用，再公布 N=2，检查第三次仍排队。
	it("sends nothing before the peer's hello, then up to its N; the rest waits", () => {
		// string[] 约束日志只能装字符串，是开发时检查，不是运行时验证。
		const sent: string[] = [];
		// 初始 limit 为 0，代表还没收到对端 hello。
		const window = new CallWindow();
		// 依次提交 a、b、c；单行循环体每次都构造一个新的排队项。
		for (const name of ["a", "b", "c"]) window.submit(callOf(name, sent));
		// 握手前不能发出任何调用。
		expect(sent).toEqual([]);
		// 模拟 hello 公布容量 2：现在同步发送队首两项。
		window.opened(2);
		// 深比较数组，既查发送数量也查顺序。
		expect(sent).toEqual(["a", "b"]);
		// 模拟一条已发送调用结束，释放一个槽位并发送 c。
		window.freed();
		expect(sent).toEqual(["a", "b", "c"]);
	});

	// 用容量 1 和四条调用说明先进先出：每释放一个位置才允许下一条发送。
	it("sends waiting calls in order as slots free", () => {
		// 该用例使用独立日志和窗口，不继承上一例状态。
		const sent: string[] = [];
		const window = new CallWindow();
		// 一次只能有一条调用在途。
		window.opened(1);
		// a 立即发送，b/c/d 按 Set 的插入顺序排队。
		for (const name of ["a", "b", "c", "d"]) window.submit(callOf(name, sent));
		// 模拟前三条依次完成；计数器 slot 只控制模拟次数，不代表真实调用 id。
		for (let slot = 0; slot < 3; slot++) window.freed();
		// 四条的实际发送日志必须保持提交顺序。
		expect(sent).toEqual(["a", "b", "c", "d"]);
	});

	// 用 long/short 作为标签，检查窗口满时后来的调用不会抢占；这里不模拟真实耗时。
	it("never preempts: a call that waits does not overtake while every slot is taken", () => {
		// 准备容量为一的窗口和发送日志。
		const sent: string[] = [];
		const window = new CallWindow();
		window.opened(1);
		// 第一条占满唯一的在途位置。
		window.submit(callOf("long", sent));
		// 后来的 short 留在队列，不能替换 long。
		window.submit(callOf("short", sent));
		expect(sent).toEqual(["long"]);
	});

	// 构造取消项和同一 hold 的两条等待项，检查按项、按 hold 删除及重复删除的效果。
	it("takes out a cancelled waiting call, and every waiting call of a hold that rebinds", () => {
		// first 占满窗口，其余都只能等待。
		const sent: string[] = [];
		const window = new CallWindow();
		window.opened(1);
		window.submit(callOf("first", sent));
		// 保留项的对象身份；remove 根据对象身份删除，不能只靠名称。
		const cancelled = callOf("cancelled", sent);
		window.submit(cancelled);
		// 两项都属于 hold 1；真实重绑时旧方法索引可能失效，所以需一起取出。
		const rebinding = [callOf("hold 1 a", sent, 1), callOf("hold 1 b", sent, 1)];
		for (const call of rebinding) window.submit(call);
		// 留下一条不属于 hold 1 的尾项，证明不会误删其他 hold。
		window.submit(callOf("last", sent));
		// 删除尚未发送的单项。
		window.remove(cancelled);
		// A second remove of the same call changes nothing.
		// 再删一次应该无副作用，也不应释放在途槽位。
		window.remove(cancelled);
		// removeHold 返回被取出的原对象，调用方可据此逐项拒绝对应 Promise。
		expect(window.removeHold(1)).toEqual(rebinding);
		// first 完成后只剩 last 可以发送。
		window.freed();
		expect(sent).toEqual(["first", "last"]);
		// 所有等待项已移走；clear 返回空数组，已发送项不在其中。
		expect(window.clear()).toEqual([]);
	});

	// 异步 GC 用例：窗口继续存活时，已发送项与手动移除项应可回收。
	// IIFE（定义后立即执行的函数）限制局部强引用的寿命；WeakRef 本身不保活被指向对象。
	it("keeps no call that went out or was taken", async () => {
		// 容量一使 a 发送、b/c 排队。
		const window = new CallWindow();
		window.opened(1);
		const refs = (() => {
			// 分别构造已发送项、将发送的项、将被取消的项。
			const sent = callOf("a", []);
			const next = callOf("b", []);
			const waiting = callOf("c", []);
			for (const call of [sent, next, waiting]) window.submit(call);
			// 释放 a 的槽位使 b 发出，再删除 c。
			window.freed();
			window.remove(waiting);
			// 只把 a/c 的弱引用带出函数，避免测试代码自己保活它们。
			return [new WeakRef(sent), new WeakRef(waiting)];
		})();
		// 展开语法把数组转成多个参数；辅助函数多轮让出事件循环并触发 GC 后断言。
		await expectCollected(...refs);
		// 保持窗口本身可达，排除“整个窗口都回收了”导致的假通过。
		expect(window).toBeDefined();
	});
});
