// 验证按对象身份计数的退避窗口：首次 1 秒、每次翻倍、最多 60 秒，以及提前跳过与清理。
import { describe, expect, it, vi } from "vitest";
import { Backoff } from "../../src/host/backoff.ts";
import { fakeTimers } from "../support.ts";

/** The length of the window `failed` opens for `identity`, measured until `due` runs. */
// 输入退避器、vi.fn 回调和身份字符串；登记一次失败，每次推进 100ms，直到回调出现，返回经过的毫秒数。
// ReturnType<typeof vi.fn> 在编译期提取模拟函数的类型，运行时没有类型校验；函数会修改退避状态和虚拟时钟。
// 例：新身份 a 返回 1000；再次对同一身份调用返回 2000。仅供已有 fakeTimers 的测试使用。
function window(backoff: Backoff, due: ReturnType<typeof vi.fn>, identity: string): number {
	// 记住原调用数，避免把前一轮的回调当成本轮完成。
	const calls = due.mock.calls.length;
	// 虚拟 Date.now 与定时器一起前进，以两次读数之差测窗口。
	const start = Date.now();
	// failed 创建或替换该身份的定时器，并在已有延迟基础上翻倍。
	backoff.failed(identity);
	// 每次向前走 100ms；回调增加调用数才退出，因此这里不测小于 100ms 的精度。
	while (due.mock.calls.length === calls) vi.advanceTimersByTime(100);
	// 测试数据的窗口恰为 100ms 的倍数，差值就是期待的退避长度。
	return Date.now() - start;
}

// 组织此机制的用例；回调在注册时执行，实际状态和断言放在各 it 回调中。
describe("backoff", () => {
	// 每例从清零的虚拟时钟开始，结束时恢复，避免真实等待 60 秒。
	fakeTimers();

	// 无参数、返回 void；连续登记九次失败并测长，验证上限及传回的身份。
	// 例：a 的第七次起都为 60000ms；模拟回调没有实际重试对象的副作用。
	it("opens a window of 1 s after the first failure, doubling up to 60 s, and calls due at its end", () => {
		// 回调只记调用；退避器在定时器结束时把身份交给它。
		const due = vi.fn();
		const backoff = new Backoff(due);
		// Array.from 的第二参数是逐元素生成器，这里忽略索引，依次测同一身份九个窗口。
		const windows = Array.from({ length: 9 }, () => window(backoff, due, "a"));
		// 精确比对九个毫秒数，验证翻倍及截顶，而非笼统地说延迟增长。
		expect(windows).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
		// every 解构每条 mock 调用的第一个参数，确认到期通知始终是 a。
		expect(due.mock.calls.every(([identity]) => identity === "a")).toBe(true);
	});

	// 验证 until 返回绝对到期时刻，仅在窗口仍运行时存在；通过推进时钟和 skip 改变状态。
	// 例：时间 5000ms 时 a 首次失败，retryAt 为 6000；未失败的 b 为 undefined。
	it("tells when a running window ends: a failed reference's retryAt", () => {
		// 此例只关心 until，空回调刻意不做事。
		const backoff = new Backoff(() => {});
		// 先偏移当前时刻，区分“绝对时间”与“延迟长度”。
		vi.advanceTimersByTime(5_000);
		backoff.failed("a");
		expect([backoff.until("a"), backoff.until("b")]).toEqual([6_000, undefined]);
		// 到期后 timer 被清掉，即使仍保留上次延迟，也不再有 until。
		vi.advanceTimersByTime(1_000);
		expect(backoff.until("a")).toBeUndefined();
		// 第二次失败延迟 2000ms，所以 6000 + 2000 = 8000。
		backoff.failed("a");
		expect(backoff.until("a")).toBe(8_000);
		// skip 提前清除定时器；不必等到 8000，until 立即消失。
		backoff.skip("a");
		expect(backoff.until("a")).toBeUndefined();
	});

	// 验证 waiting 只表示“有运行中的窗口”；a 失败后为 true，未登记的 b 为 false，到期后 a 也为 false。
	// 无输入与返回值，副作用仅为本地退避器及虚拟时钟变化；断言不符时抛出测试错误。
	it("is waiting only inside a window", () => {
		// 建立无副作用的到期回调，再开启 a 的首个 1000ms 窗口。
		const backoff = new Backoff(() => {});
		backoff.failed("a");
		expect([backoff.waiting("a"), backoff.waiting("b")]).toEqual([true, false]);
		// 时钟推进到边界，due 已执行，waiting 应立即变回 false。
		vi.advanceTimersByTime(1000);
		expect(backoff.waiting("a")).toBe(false);
	});

	// 比较 skip 与 delete：前者只取消窗口并保留延迟历史，后者连历史一并删除。
	// 例：跳过首次窗口后，下次仍为 2000ms；删除身份后又从 1000ms 开始。返回 void，不操作真实资源。
	it("skip ends a window without due and keeps its delay; delete starts over", () => {
		// 保存 due 的调用记录，观察 skip 会不会误发到期通知。
		const due = vi.fn();
		const backoff = new Backoff(due);
		backoff.failed("a");
		// 取消窗口后，推进超过原来的到期点。
		backoff.skip("a");
		vi.advanceTimersByTime(5000);
		// 既不在等待，也没有 due；后续 window 验证延迟历史尚在。
		expect([backoff.waiting("a"), due.mock.calls.length]).toEqual([false, 0]);
		expect(window(backoff, due, "a")).toBe(2000);
		// 删除身份意味着下次失败视为首次。
		backoff.delete("a");
		expect(window(backoff, due, "a")).toBe(1000);
	});

	// 模拟对象结束：运行中的窗口仍保留，已结束的窗口则从 map 删除；没有真正创建 Chord 对象。
	// 例：a 失败后立刻 ended 仍 waiting，经过 1000ms 再 ended 后，下次失败回到 1000ms。
	it("ended keeps a running window and drops a passed one", () => {
		// 准备回调和 a 的首个窗口。
		const due = vi.fn();
		const backoff = new Backoff(due);
		backoff.failed("a");
		// 对象结束不会跳过正在执行的退避窗口。
		backoff.ended("a");
		expect(backoff.waiting("a")).toBe(true);
		// 到期后再通知 ended 才会删掉历史，因此下次 window 从首档开始。
		vi.advanceTimersByTime(1000);
		backoff.ended("a");
		expect(window(backoff, due, "a")).toBe(1000);
	});

	// 在窗口没到期时再次 failed，应取消旧 timer 并排一个翻倍的新 timer，不让两个通知并发。
	// 例：连续失败后 1999ms 无通知且只有一个 timer，第 2000ms 恰好通知一次；返回 void。
	it("a failure inside a running window replaces it: one due, after the doubled delay", () => {
		// 同一个回调观察两次 failed 是否合并为一个最终定时器。
		const due = vi.fn();
		const backoff = new Backoff(due);
		backoff.failed("a");
		backoff.failed("a");
		// 第二个窗口为 2000ms，距到期一毫秒时旧窗口也不得触发。
		vi.advanceTimersByTime(1999);
		expect([due.mock.calls.length, vi.getTimerCount()]).toEqual([0, 1]);
		// 到达边界只调用一次。
		vi.advanceTimersByTime(1);
		expect(due).toHaveBeenCalledTimes(1);
	});

	// 无输入；同时登记 a、b 后 clear，断言所有窗口与定时器都消失；用于模拟 host 关闭时清理。
	// 此例不验证对象关闭本身，只验证 Backoff.clear 的两身份场景。
	it("clear forgets every identity with its timer", () => {
		// 两个身份各开一个窗口。
		const backoff = new Backoff(() => {});
		backoff.failed("a");
		backoff.failed("b");
		// 清空会逐身份 delete，既删除历史也取消 timer。
		backoff.clear();
		expect([backoff.waiting("a"), backoff.waiting("b"), vi.getTimerCount()]).toEqual([false, false, 0]);
	});
});
