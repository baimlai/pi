// Entry 8: awaited gets. `host.get` and `ctx.get` resolve once the reference is ready; abort, the ctx closing and the
// host's `readyTimeout` reject them and release only that reference.
import assert from "node:assert/strict";
import { num, obj } from "@earendil-works/pi-schema";
import { describe, it } from "vitest";
import {
	type Ctx,
	createHost,
	type Host,
	hostNamed,
	isChordError,
	memoryLinkPair,
	remote,
} from "../../src/old/index.ts";
import { CountingLink } from "./fixtures/counting.ts";

// 返回定时器 Promise，给异步帧传输一次执行机会；例如 sleep(5) 至少等到定时器被调度，不保证精确 5ms。
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// 轮询无参数条件，最多 attempts 次，每次失败等 2ms；成功返回 void，否则 assert 抛错。
// 例如等待 release 帧出现，而不是假定某个固定延迟后一定出现。
async function until(check: () => boolean, attempts = 200): Promise<void> {
	// 循环条件每次重新调用 check，达到次数上限就停止等待。
	for (let i = 0; i < attempts && !check(); i++) await sleep(2);
	// 最后再检查一次，仍为假则以明确消息让测试失败。
	assert.ok(check(), "condition not reached");
}

// 远程测试契约位于 server：空输入、main 变体，暴露数字状态 n；此处只声明接口。
const Slow = remote("t.e8-slow", {
	version: 1,
	input: obj({}, { open: true }),
	host: hostNamed("server"),
	variants: { main: { state: { n: num() } } },
});

/** A server whose `Slow` object goes live when `open()` is called; a browser whose link counts frames. */
// 建立内存 server/browser 和计数通道，返回这些对象及手动开门函数。
// readyTimeout 可省略；例如 setup(30) 让浏览器的 get 最多等待约 30ms。副作用限于内存主机与定时器。
function setup(readyTimeout?: number) {
	// 先用空函数占位，Promise 构造器同步执行时会改成 resolve。
	let open = () => {};
	// 创建人为阻塞资源激活的 Promise<void>；只控制完成，没有数据返回。
	const opened = new Promise<void>((resolve) => {
		// 把完成函数交给测试，之后 open() 才会放行。
		open = resolve;
	});
	// 建立命名服务端，忽略此夹具中的错误报告。
	const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
	// 工厂忽略输入与主体，通过 self 声明资源和状态；前导下划线只表示这些参数未使用。
	server.serve(Slow, (_input, _principal, self) => {
		// gate 的 open 回调返回未完成 Promise，阻止对象就绪；声明版本为 1。
		self.resource("gate", { version: 1, open: () => opened });
		// 返回 main 实现，n 的初值是 1；状态已声明不代表资源已经打开。
		return { variant: "main", n: self.state("n", num(), 1) };
	});
	// 数组解构取得一对内存端点，down 给服务端，up 给浏览器。
	const [down, up] = memoryLinkPair();
	// 服务端接受端点，并把来自该连接的调用标为用户 u。
	server.accept(down, { principal: { user: "u" } });
	// 包装浏览器端点，用帧数量验证引用共享与释放。
	const link = new CountingLink(up);
	// Host 类型约束配置产生的接口；运行时建立 client 主机，通过计数通道连接服务端。
	const browser: Host = createHost({
		self: { kind: "host" },
		name: "browser",
		kind: "client",
		// 浏览器把上游对端认作 server 主体；这与服务端赋予浏览器的用户主体是两个方向。
		upstream: { link, principal: { kind: "server" } },
		onError: () => {},
		// 对象展开条件配置：undefined 时完全不传此字段，保留主机默认值。
		...(readyTimeout === undefined ? {} : { readyTimeout }),
	});
	// 属性简写返回四个共享引用，调用者负责在测试尾部关闭服务端。
	return { server, browser, link, open };
}

// 注册等待引用的四个异步测试；describe 回调负责登记用例，真正动作发生在 it 回调内。
describe("awaited gets", () => {
	// 例子：两个 get 等同一个 Slow，只取消第一个；验证仍共用一个 hold，第二个成功后释放才发 release。
	it("an aborted get rejects and releases only its reference; the binding stays for the others", async () => {
		// 建立尚未开门的主机，拿到控制与统计对象。
		const { server, browser, link, open } = setup();
		// AbortController 只用于第一个 get 的等待信号。
		const abort = new AbortController();
		// 立即发起但不 await，以便同时建立另一个等待引用。
		const first = browser.get(Slow, {}, { signal: abort.signal });
		// 第二个 get 不传取消信号，观察第一个取消是否错误影响它。
		const second = browser.get(Slow, {});
		// 给 hold/激活异步步骤机会运行；固定睡眠本身不是状态完成证明。
		await sleep(5);
		// 触发第一个等待者取消。
		abort.abort();
		// 断言第一个 Promise 拒绝且错误代码为 aborted；谓词实际检查运行时错误。
		await assert.rejects(first, (error) => isChordError(error, "aborted"));
		await sleep(5);
		// 仍有第二个引用，所以此时不应向服务端释放共享 hold。
		assert.equal(link.count("sent", "release"), 0, "the other awaiting get keeps the hold");
		// 手动完成资源开启，允许 Slow 激活。
		open();
		// 第二个等待成功时才拿到已水合的引用。
		const ref = await second;
		// 读取已到达的状态快照，验证 n 的初值。
		assert.equal(ref.n.value, 1);
		// 两次 get 仅发送一个 hold，验证绑定层共享。
		assert.equal(link.count("sent", "hold"), 1);
		// 释放最后一个外部引用，不是关闭整个浏览器。
		ref.release();
		// 轮询直到共享 hold 确实释放，而不是只等一个固定时长。
		await until(() => link.count("sent", "release") === 1);
		// 等待服务端关闭及内存连接清理。
		await server.close();
	});

	// 在 root 调用内启动 ctx.get 却不等它；root 回调结束即清理调用拥有的引用，未完成 get 应拒绝 aborted。
	it("a ctx.get still waiting when its call settles rejects aborted and releases its reference", async () => {
		// 创建独立夹具，避免与前一用例共享主机和帧计数。
		const { server, browser, link, open } = setup();
		// 暂存外层要验证的 Promise；unknown 表示此用例不依赖其成功值类型，undefined 表示尚未赋值。
		let pending: Promise<unknown> | undefined;
		// root 提供调用作用域；此 async 回调没有等待 pending，故会先结束。
		await browser.root(async (ctx: Ctx) => {
			// ctx.get 的引用归当前 root 调用所有。
			pending = ctx.get(Slow, {});
			// 先挂拒绝处理避免未处理拒绝报告，保留原 pending 供后面的 assert.rejects 检验。
			pending.catch(() => {});
		});
		// 非空断言 ! 仅告诉 TypeScript 此时已赋值；实际断言仍等待原 Promise 拒绝。
		await assert.rejects(pending!, (error) => isChordError(error, "aborted"));
		// 等到帧计数证明本次 hold 已释放。
		await until(() => link.count("sent", "release") === 1);
		// 完成资源门闩，让待激活对象可以继续。
		open();
		// 等待服务端清理并结束内存连接。
		await server.close();
	});

	// 把超时设成 30ms 且永不开门，验证 unavailable/ready_timeout 和随后发送 release，不证明精确耗时。
	it("a get times out after readyTimeout with ready_timeout and releases its hold", async () => {
		// 只取此例需要的对象，故意不取开门函数。
		const { server, browser, link } = setup(30);
		// 等待 get 失败；下面谓词同时检查错误代码与 reason，不能只看 Promise 被拒绝。
		await assert.rejects(
			browser.get(Slow, {}),
			// isChordError 在运行时识别错误，也将 error 类型缩窄后再读取 reason。
			(error) => isChordError(error, "unavailable") && error.reason === "ready_timeout",
		);
		// 等到帧计数证明本次 hold 已释放。
		await until(() => link.count("sent", "release") === 1);
		// 等待服务端清理并结束内存连接。
		await server.close();
	});

	// 先开门，再在 root 内读取 n；回调返回 1 后自动释放调用持有的引用，验证 release 帧。
	it("ctx.get resolves hydrated; the call's reference is released when the call ends", async () => {
		// 创建独立夹具，避免与前一用例共享主机和帧计数。
		const { server, browser, link, open } = setup();
		// 完成资源门闩，让待激活对象可以继续。
		open();
		// root 的返回 Promise 跟随 async 回调返回的数字。
		const value = await browser.root(async (ctx: Ctx) => {
			// 等待当前调用范围的引用及初始状态到齐。
			const slow = await ctx.get(Slow, {});
			// 读取快照并返回数字，不把引用带出作用域。
			return slow.n.value;
		});
		// 验证回调读到的实际状态值。
		assert.equal(value, 1);
		// 等到帧计数证明本次 hold 已释放。
		await until(() => link.count("sent", "release") === 1);
		// 等待服务端清理并结束内存连接。
		await server.close();
	});
});
