// Tests of an activation's deadline (slice 6a §9): it expires once after its budget; paused time does not count; a
// cleared deadline never expires.
// 这里用虚拟时钟验证激活预算；推进 1000 毫秒不会实际等一秒，也不验证真实系统调度的精度。

import { describe, expect, it, vi } from "vitest";
import { Deadline } from "../../src/host/deadline.ts";
import { fakeTimers } from "../support.ts";

describe("deadline", () => {
	// 在本组每个用例前安装虚拟时钟，并在结束后恢复真实时钟。
	fakeTimers();

	// 无外部输入；创建 100ms 期限，跨过到期点再继续推进，断言回调只执行一次。
	// 例子就是下面的 99ms + 1000ms：前一段未到期，后一段触发一次；失败由 expect 抛出。
	it("expires once after its budget", () => {
		// vi.fn 保存调用次数，不做实际资源操作。
		const expired = vi.fn();
		// 构造时立即启动一个 100ms 定时器；此处不需要保留实例。
		new Deadline(100, expired);
		// 距到期还差 1ms，回调应尚未调用。
		vi.advanceTimersByTime(99);
		expect(expired).not.toHaveBeenCalled();
		// 一次推进超过期限；普通 setTimeout 不是重复定时器。
		vi.advanceTimersByTime(1_000);
		expect(expired).toHaveBeenCalledTimes(1);
	});

	// 无参数；先花掉 60ms，再暂停一秒，恢复后只剩 40ms；返回 void，仅修改虚拟时钟。
	// 这个例子证明暂停时间不计入预算，断言异常交给测试框架。
	it("paused time does not count: resumed with the budget it had left", () => {
		// 用可计数回调和保留的实例观察暂停、恢复效果。
		const expired = vi.fn();
		const deadline = new Deadline(100, expired);
		// 100 - 60 = 40ms，pause 会清定时器并记录剩余预算。
		vi.advanceTimersByTime(60);
		deadline.pause();
		// 暂停期间没有期限定时器；一秒后恢复原来的 40ms。
		vi.advanceTimersByTime(1_000);
		deadline.resume();
		// 恢复后 39ms 仍未到期，再过 1ms 才调用一次。
		vi.advanceTimersByTime(39);
		expect(expired).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(expired).toHaveBeenCalledTimes(1);
	});

	// 无参数；暂停后永久清除期限，再尝试恢复，断言不会重新启动；没有真实等待。
	// 例：清除 100ms 期限后推进 1000ms 仍无调用，说明 clear 与 pause 的含义不同。
	it("a cleared deadline never expires, also when resumed", () => {
		// 新建一个尚未到期的期限及其调用记录。
		const expired = vi.fn();
		const deadline = new Deadline(100, expired);
		// pause 可恢复，clear 则设置永久清除标记，随后 resume 不再排定时器。
		deadline.pause();
		deadline.clear();
		deadline.resume();
		// 跨过原预算十倍仍不能触发回调。
		vi.advanceTimersByTime(1_000);
		expect(expired).not.toHaveBeenCalled();
	});
});
