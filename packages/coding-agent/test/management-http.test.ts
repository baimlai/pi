// 用 fetch 和计时信号替身验证管理请求重试，全程不连接 example.test。
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../src/utils/management-http.ts";

// 每例结束恢复 spy 替换的方法；表达式体箭头函数直接返回 restoreAllMocks 的结果。
afterEach(() => vi.restoreAllMocks());

// 注册重试测试；it 的 async 回调返回 Promise，Vitest 等待完成并报告拒绝/断言错误。
describe("fetchWithRetry", () => {
	// 模拟连续两次传输错误再成功，验证默认总共三次请求；英文标题虽写 once，断言是三次。
	it("retries a transient transport failure once", async () => {
		// vi.spyOn 从全局 fetch 建立替身，以下链式设置按调用顺序消耗。
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			// 用 Error 拒绝第一轮 Promise，模拟 transport 异常，不产生真实请求。
			.mockRejectedValueOnce(new Error("fetch failed"))
			// 第二轮同样拒绝，迫使 helper 再重试。
			.mockRejectedValueOnce(new Error("fetch failed"))
			// 第三轮返回内存中构造的成功 JSON Response，链式调用不会在设置时执行请求。
			.mockResolvedValueOnce(Response.json({ ok: true }));

		// await 等待 helper 走完失败重试并返回最终 Response。
		const response = await fetchWithRetry("https://example.test");
		// 只验证 HTTP ok 标志，不读取或比较 JSON 正文。
		expect(response.ok).toBe(true);
		// 要求 fetch 替身恰好被调用三次。
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	// 传总体预算 1000ms，记录各轮收到的 signal；本例证明信号复用，不测真实耗时。
	it("shares the timeout budget across attempts", async () => {
		// AbortSignal[] 是静态元素类型，空数组用于保留实际传给替身的引用。
		const signals: AbortSignal[] = [];
		// 异步替身接收 fetch 参数；_input 表示此处不使用请求地址，init 可缺省。
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			// 可选链安全读取 signal，有信号才 push；省略花括号时 if 只控制这一条语句。
			if (init?.signal) signals.push(init.signal);
			// 首次记录信号后主动抛错，第二轮不再命中这个条件。
			if (signals.length === 1) throw new Error("fetch failed");
			// 重试时返回一个成功 Response，async 会将它包装为已兑现 Promise。
			return Response.json({ ok: true });
		});

		// 第二参数 undefined 沿用默认 RequestInit；第三参数仅设置共享总体预算。
		const response = await fetchWithRetry("https://example.test", undefined, { timeoutMs: 1000 });
		// 成功返回且总调用两次共同证明首轮错误后有一次重试。
		expect(response.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		// toBe 按对象身份比较，要求两轮 signal 是同一个对象，未等 1000ms 超时。
		expect(signals[0]).toBe(signals[1]);
	});

	// 手动让首轮单次超时信号取消，再要求下一轮创建新信号；无真实四秒等待。
	it("retries an attempt timeout", async () => {
		// 保存每次模拟 timeout 产生的控制器，以便首轮 fetch 主动触发取消。
		const controllers: AbortController[] = [];
		// 替换 AbortSignal.timeout，不用真实计时器；忽略传入时长只返回受控 signal。
		vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
			// 每调用一次 timeout 都创建一个可由测试取消的新控制器。
			const controller = new AbortController();
			// push 修改测试数组，按创建顺序记录控制器。
			controllers.push(controller);
			// 把对应 signal 交给 helper，controller 本身留在测试中。
			return controller.signal;
		});
		// fetch 用替身执行，读取 mock.calls 时本次调用已登记。
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			// 只在第一次 fetch 进入这里，第二次可正常返回。
			if (fetchMock.mock.calls.length === 1) {
				// 手动取消首个 timeout 控制器，模拟这一轮超时。
				controllers[0].abort();
				// 若组合后的请求信号已取消就抛原因；?. 表示缺信号则跳过调用。
				init?.signal?.throwIfAborted();
			}
			// 后续尝试返回成功响应，不触及网络。
			return Response.json({ ok: true });
		});

		// 启用每轮 4000ms 配置；timeout 已被替换，因此不会真的等待这段时间。
		await fetchWithRetry("https://example.test", undefined, { attemptTimeoutMs: 4000 });

		// 要求第一次超时后确有第二次 fetch。
		expect(fetchMock).toHaveBeenCalledTimes(2);
		// 要求每次尝试各创建一个控制器，而非复用已取消的首轮信号。
		expect(controllers).toHaveLength(2);
	});

	// 模拟 503 再成功，验证 HTTP 状态重试路径，区别于 Promise 抛错路径。
	it("retries transient HTTP responses and returns the successful response", async () => {
		// 依次编排两个 fetch 返回值，所有响应均在内存构造。
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			// 503 Response 是正常兑现的 Promise，helper 需根据 status 决定重试。
			.mockResolvedValueOnce(new Response("busy", { status: 503 }))
			// 第二次返回默认 200 JSON Response。
			.mockResolvedValueOnce(Response.json({ ok: true }));

		// 等待 helper 丢弃忙碌响应并取得第二个响应。
		const response = await fetchWithRetry("https://example.test");
		// 最终响应应成功；此处不验证 body.cancel 的调用次数。
		expect(response.ok).toBe(true);
		// 要求只有一次额外尝试。
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	// 预先取消调用方信号，要求在 fetch 之前失败；spy 原实现不会在通过路径上被调用。
	it("does not retry caller cancellation", async () => {
		// 控制器提供 caller signal，而非 helper 的单轮 timeout 信号。
		const controller = new AbortController();
		// 立即 abort，使第一次循环开始前 signal 已为 aborted。
		controller.abort();
		// 这里 spyOn 没设置实现，若误调用会转发真实 fetch；后面的断言要求零调用。
		const fetchMock = vi.spyOn(globalThis, "fetch");

		// rejects 等待异步拒绝并检查抛错，不要求具体错误文字。
		await expect(fetchWithRetry("https://example.test", { signal: controller.signal })).rejects.toThrow();
		// 要求从未尝试请求，证明预取消检查发生在 fetch 前。
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
