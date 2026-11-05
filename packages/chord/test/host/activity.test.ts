// Tests of \`host.activity\` (§3, R26): the counts per kind, one publication per microtask turn with changes, a slow
// watcher, derives over it, nothing scheduled while nobody follows it, lingering.
// 用内存链路观察 host 的工作计数；activity 包含未绑定的入站 hold，presence 则只列已经绑定的引用。

import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { bool, int, local, method, remote } from "../../src/contracts/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { constant } from "../../src/state/index.ts";
import { fakeTimers, flushed, framesOf, linked, loaded, Notes, Server, serveNotes, transported } from "../support.ts";

// 无实例参数的远程契约仍按 principal 区分对象；地址固定为测试 Server，v 变体只暴露整数 n。
const Kept = remote("app.kept", {
	version: 1,
	params: {},
	// 地址回调只返回逻辑地址，不会启动进程或发请求。
	hostAddress: () => Server(),
	variants: { v: { state: { n: int() } } },
});

// 每个 it 返回 Promise<void>；辅助函数只创建内存 host/link，不连接真实模型或远程服务。
describe("host.activity", () => {
	// 验证 references 只计从链路到达且放置在此的 hold；本 host 的 get 不计入此项。
	// 例：client 持有 S1、server 自己持有 S2 后仍是 1；释放 S1 并送达 release 后为 0。
	it("counts holds arriving over links and served here, not this host's own references", async () => {
		// linked 把服务 Notes 的 server 与空 client 用内存链路连起来。
		const { server, client } = await linked((h) => void serveNotes(h));
		// 初始没有入站引用、运行调用、job 或 linger 对象。
		expect(server.activity.value).toEqual({ references: 0, calls: 0, jobs: 0, lingering: 0 });
		// client.get 发 hold 并等到绑定；server.get 仅创建本地引用。
		const notes = await client.get(Notes, { session: "S1" }, context);
		await server.get(Notes, { session: "S2" }, context);
		expect(server.activity.value.references).toBe(1);
		// release 发消息，必须等内存传输任务跑完才能读 server 端下降后的计数。
		notes.release();
		await transported();
		expect(server.activity.value.references).toBe(0);
	});

	// 验证等待缺失 provider 的 hold 仍保活 host；无输入，断言失败由测试框架报告。
	// 例：没人服务 Notes，引用 failed/waiting 但 references=1，presence=[]；释放后计数归零。
	it("counts a hold placed here from its arrival, bound or not: a missing provider keeps the worker alive (M§10)", async () => {
		// 空 setup 不服务任何契约；hold 立即返回，不像 get 那样等待 live。
		const { server, client } = await linked(() => {});
		const missing = client.hold(Notes, { session: "S1" }, context);
		// 让 hold 和 failed 消息都到达，确认原因是 waiting 而非永久 broken。
		await transported();
		expect(missing.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		// 一个等待 provider 的入站请求也算 references。
		expect(server.activity.value.references).toBe(1);
		// Presence lists bound references only.
		// 缺失 provider 还未绑定，presence 不能把它显示成正在观看对象的引用。
		expect(server.references(Notes).value).toEqual([]);
		// 释放等待请求后也要等 release 传到 server，再读计数。
		missing.release();
		await transported();
		expect(server.activity.value.references).toBe(0);
	});

	// 验证 calls 包含此 host 执行的本地和远程 handler，持续到 handler 自己结束。
	// 例：两次 wait 等待各自 abort，释放两个引用后 allSettled 吸收预期拒绝，calls 从 2 变 0。
	it("counts method calls running on this host, local and remote, until they settle", async () => {
		// 为同一个 Notes 对象分别拿链路引用与本 host 引用。
		const { server, client } = await linked((h) => void serveNotes(h));
		const remoteRef = await client.get(Notes, { session: "S1" }, context);
		const localRef = await server.get(Notes, { session: "S1" }, context);
		// wait 的测试实现等待 ctx.abortSignal，不立即完成；数组保留两条 caller promise。
		const calls = [remoteRef.wait(context), localRef.wait(context)];
		// 等远程 call 到达 server，才应观察到同时运行两次。
		await transported();
		expect(server.activity.value.calls).toBe(2);
		// 释放引用会拒绝其调用并触发 handler 的 abort；allSettled 不因预期拒绝提前退出。
		remoteRef.release();
		localRef.release();
		await Promise.allSettled(calls);
		// handler 完成与远程清理都跑完，server 才没有活跃 calls。
		await transported();
		expect(server.activity.value.calls).toBe(0);
	});

	// 无输入；同一轮发十次立即完成的调用，收集 activity 帧，验证开始和结束各合并成一帧。
	// 例：得到 calls=10 后 calls=0 的替换帧，而非二十条逐次加减帧；返回 Promise<void>。
	it("publishes once per microtask turn with changes; a slow watcher gets the newest counts", async () => {
		// 无参数本地对象暴露 bump；async 返回 null，调用仍经过异步 handler 路径。
		const Counter = local("app.counter", { version: 1, params: {}, members: { bump: method() } });
		const { host } = await loaded((h) => h.serve(Counter, () => ({ bump: async () => null })));
		// 获取服务并打开 watch，framesOf 启动 listener，把 value/ops 放入数组。
		const counter = await host.get(Counter, {}, context);
		const watch = await host.activity.watch(context);
		const frames = framesOf(watch);
		// Ten calls started in one turn: ten changes, one publication; they settle in a later turn: one more.
		// 生成器每次启动一次 bump，Promise.all 等十次都成功后再排空观察队列。
		const bumps = Array.from({ length: 10 }, () => counter.bump(context));
		await Promise.all(bumps);
		await flushed();
		// 纯函数生成预期计数；这里的 number 是编译期参数类型，不是运行时检查。
		const counts = (calls: number) => ({ references: 0, calls, jobs: 0, lingering: 0 });
		// r 表示整值替换；本用例只证明十次调用这个固定场景的两帧输出。
		expect(frames).toEqual([
			[counts(10), [["r", counts(10)]]],
			[counts(0), [["r", counts(0)]]],
		]);
	});

	// 验证忙 listener 会合并期间的帧；第一帧用 gate 阻塞，两次 bump 后再放行。
	// 例：seen 最终只含 calls=1、calls=0；不会中断第一条 listener，也不测试无限队列的上限。
	it("gives a slow watcher the newest counts once it is free: its pending frames fold", async () => {
		// 准备可立即完成的本地计数方法及其引用。
		const Counter = local("app.counter", { version: 1, params: {}, members: { bump: method() } });
		const { host } = await loaded((h) => h.serve(Counter, () => ({ bump: async () => null })));
		const counter = await host.get(Counter, {}, context);
		// watch 在 start 前已拍下初值，gate 可手动 resolve，seen 存后续 listener 收到的值。
		const watch = await host.activity.watch(context);
		const gate = Promise.withResolvers<void>();
		const seen: unknown[] = [];
		// listener 输入是 value|failed 的带 kind 联合；忽略 failed，首个值到来后等 gate。
		watch.start(async (call) => {
			// 运行时按 kind 分支后 TypeScript 才允许访问 value。
			if (call.kind !== "value") return;
			// 数组 push 是这个 listener 的可观察副作用；只阻塞第一次。
			seen.push(call.value);
			if (seen.length === 1) await gate.promise;
		});
		// Three more publications while the watcher is busy with the first.
		// 分别等待两次调用及其发布，使第二次调用的开始、结束都发生在 listener 忙时。
		for (let i = 0; i < 2; i++) {
			await counter.bump(context);
			await flushed();
		}
		// 解除第一帧阻塞，队列给出期间最新值；随后构造并比较预期计数。
		gate.resolve();
		await flushed();
		const counts = (calls: number) => ({ references: 0, calls, jobs: 0, lingering: 0 });
		expect(seen).toEqual([counts(1), counts(0)]);
	});

	// 验证没人订阅 activity 时不排发布微任务，之后 watch 仍能同步读到当前计数。
	// 例：wait 未结束时新 watch 读 calls=1，放行后恰好排一次发布；finally 恢复全局 spy。
	it("schedules nothing while nobody watches or derives from it; a later watch reads the counts then", async () => {
		// bump 立即完成，wait 返回可手动放行的 promise；两者用于区分无人关注和有人 watch 两段。
		const Counter = local("app.counter", { version: 1, params: {}, members: { bump: method(), wait: method() } });
		const gate = Promise.withResolvers<null>();
		const { host } = await loaded((h) =>
			h.serve(Counter, () => ({ bump: async () => null, wait: () => gate.promise })),
		);
		// 先取引用再观察 queueMicrotask，避免把对象激活本身排的工作混进计数。
		const counter = await host.get(Counter, {}, context);
		const scheduled = vi.spyOn(globalThis, "queueMicrotask");
		// spy 修改全局函数，因此无论断言成功失败都必须在 finally 恢复。
		try {
			// 完成 bump 后保持一个 wait 在运行；不订阅 activity 应无发布排队。
			await counter.bump(context);
			const waiting = counter.wait(context);
			await flushed();
			expect(scheduled).not.toHaveBeenCalled();
			// 此时打开 watch 从计数器构建当前值，不依赖之前的发布。
			const watch = await host.activity.watch(context);
			expect(watch.value).toMatchObject({ calls: 1 });
			// 放行 wait，结束计数的变动在已有 watcher 时排一个微任务。
			gate.resolve(null);
			await waiting;
			expect(scheduled).toHaveBeenCalledTimes(1);
		} finally {
			// 恢复真实 queueMicrotask；避免影响同文件后续用例。
			scheduled.mockRestore();
		}
	});

	// 验证 activity 可以作为 derive 的源，计数发布时在同批重算；host 被基础代码闭包持有。
	// 例：work 运行时 busy=true，完成后 false；无输入，返回 Promise<void>，只改内存状态。
	it("feeds derives (base code holding the host): they recompute in the publishing batch", async () => {
		// Busy 暴露布尔状态和无参方法；host 的空 onError 不记录本场景不预期的通知。
		const Busy = local("app.busy", { version: 1, params: {}, members: { busy: bool(), work: method() } });
		const host = createHost({ onError: () => {} });
		// facet 工厂返回两个成员；derive 从单元素 sources 解构出 calls，映射为是否大于零。
		const facet = defineFacet((h) =>
			h.serve(Busy, (_, self) => ({
				busy: self.derive([host.activity], ([{ calls }]) => calls > 0),
				work: async () => null,
			})),
		);
		// 先加载再 get；否则 host 会以 not_ready 拒绝本 host 尚未发布的请求。
		await host.load([{ name: "@test/core", facet }], context);
		const busy = await host.get(Busy, {}, context);
		// 记录 busy 的变化帧，执行一次 work，并等微任务发布结束。
		const values = framesOf(await busy.busy.watch(context));
		await busy.work(context);
		await flushed();
		// 解构每帧的值忽略 ops，确认 true 后 false；当前同步读也必须为 false。
		expect(values.map(([value]) => value)).toEqual([true, false]);
		expect(busy.busy.value).toBe(false);
	});

	// linger 用虚拟时钟验证，不实际等一秒；只对本嵌套组的用例安装。
	describe("lingering", () => {
		fakeTimers();

		// 释放最后 hold 后对象被 linger 保留，再次引用会取消 linger；第二次释放并到期后归零。
		// 例：references/lingering 从 0/1 到 1/0 再到 0/1，1000ms 后 lingering=0。
		it("counts live objects kept by their type's linger after their last reference, until they end", async () => {
			// Kept 的工厂返回固定整数，linger 选项为 1000ms，副作用仅是内存生命周期。
			const { server, client } = await linked((h) =>
				h.serve(Kept, () => ({ variant: "v", members: { n: constant(1) } }), { linger: 1000 }),
			);
			// 先绑定后释放，等待 release 到达 provider 再看 lingering。
			const kept = await client.get(Kept, {}, context);
			kept.release();
			await transported();
			expect(server.activity.value).toMatchObject({ references: 0, lingering: 1 });
			// A new reference within the linger takes it back.
			// 窗口内新引用复用活对象，references 增加同时取消 linger 计数。
			const again = await client.get(Kept, {}, context);
			expect(server.activity.value).toMatchObject({ references: 1, lingering: 0 });
			// 第二次释放重新进入 linger；这次推进完整窗口让它结束。
			again.release();
			await transported();
			expect(server.activity.value.lingering).toBe(1);
			// Async 版推进时钟也等待期间的异步清理任务。
			await vi.advanceTimersByTimeAsync(1000);
			expect(server.activity.value.lingering).toBe(0);
		});
	});

	// 历史测试名提到 slice 5；实际场景只是空 host 没有登记任何 job，jobs 应为零。
	// 不证明所有 job 的计数逻辑；无输入，返回 Promise<void>，loaded 的清理由测试辅助钩子处理。
	it("counts no jobs before slice 5", async () => {
		// 空 setup 只完成发布，未创建作业。
		const { host } = await loaded(() => {});
		expect(host.activity.value.jobs).toBe(0);
	});
});
