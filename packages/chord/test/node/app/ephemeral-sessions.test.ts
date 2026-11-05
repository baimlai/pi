// 用虚拟计时器验证临时会话的连接计数、宽限期和容量，不访问真实登录状态。
// Tests of ephemeral sessions (slice 13 §3, carry-over to slice 11): at most `max`, the oldest ending past it; each
// ends once its last link closed and none opened for the grace period, or when none opened within it of the login.

import { afterEach, describe, expect, it, vi } from "vitest";
import { EphemeralSessions } from "../../../src/node/app/ephemeral-sessions.ts";

// 所有例子共用的人工用户身份，仅作内存数据。
const PRINCIPAL = { kind: "user", id: "u", name: "u" };

// 无参收尾回调在每个用例后恢复计时器，即使断言抛错也执行。
afterEach(() => {
	// 取消 Vitest 的假计时器，避免污染下一用例。
	vi.useRealTimers();
});

// 登记临时会话机制的三个用例。
describe("ephemeral sessions", () => {
	// 此例用两个连接关闭回调模拟断线；最后连接关闭后等 1000ms，期间重连应取消删除。
	// 回调重复执行不能减两次计数；无业务返回值，只检查内存会话是否存在。
	it("end with their last link after the grace period; a link opening meanwhile keeps them", () => {
		// 用 Vitest 控制时间推进，不真实等待几秒。
		vi.useFakeTimers();
		// 最多 10 个会话，无连接宽限期设为 1000ms。
		const sessions = new EphemeralSessions(10, 1000);
		// 登记 a；hash 是占位摘要，不在本单元测试验签。
		sessions.issue("a", "hash", PRINCIPAL);
		// 登记第一个连接并获得其关闭回调；! 只保证编译器允许调用。
		const first = sessions.linkOpened("a")!;
		// 同一会话再开第二个连接，尚不能因第一个关闭而过期。
		const second = sessions.linkOpened("a")!;
		// 关闭第一个连接，第二个仍保持会话。
		first();
		// 跨过宽限期，仍有活连接时不应删除；重连保持时也如此。
		vi.advanceTimersByTime(5000);
		// 只验证这一步 a 仍在管理器中。
		expect(sessions.get("a")).toBeDefined();
		// 第一次调用关闭第二个连接，第二次调用应被幂等保护忽略，不重复扣计数。
		second();
		// 第一次调用关闭第二个连接，第二次调用应被幂等保护忽略，不重复扣计数。
		second();
		// 到删除前 1ms，留出重连时机。
		vi.advanceTimersByTime(999);
		// 重连，取消无连接时的到期计时。
		const again = sessions.linkOpened("a")!;
		// 跨过宽限期，仍有活连接时不应删除；重连保持时也如此。
		vi.advanceTimersByTime(5000);
		// 只验证这一步 a 仍在管理器中。
		expect(sessions.get("a")).toBeDefined();
		// 关闭重连后的最后连接，重新开始完整宽限期。
		again();
		// 推进一个完整宽限期，执行到期回调。
		vi.advanceTimersByTime(1000);
		// a 应已因没有连接而删除。
		expect(sessions.get("a")).toBeUndefined();
		// 已删除的 id 不能再打开连接。
		expect(sessions.linkOpened("a")).toBeUndefined();
	});

	// 此例 issue 后从未建立连接，1000ms 后也必须清理，避免登录但不连接的会话永久存活。
	it("end when no link opens within the grace period of the login", () => {
		// 用 Vitest 控制时间推进，不真实等待几秒。
		vi.useFakeTimers();
		// 最多 10 个会话，无连接宽限期设为 1000ms。
		const sessions = new EphemeralSessions(10, 1000);
		// 登记 a；hash 是占位摘要，不在本单元测试验签。
		sessions.issue("a", "hash", PRINCIPAL);
		// 推进一个完整宽限期，执行到期回调。
		vi.advanceTimersByTime(1000);
		// a 应已因没有连接而删除。
		expect(sessions.get("a")).toBeUndefined();
	});

	// 将容量设为 2，按 a→b→c 登记，预期最老 a 被淘汰；随后验证 revoke 的返回值和重复删除。
	it("keep at most max: past it the oldest ends", () => {
		// 本例最大容量 2，宽限期一分钟。
		const sessions = new EphemeralSessions(2, 60_000);
		// 按数组顺序依次登记，第三个进入时触发容量清理。
		for (const id of ["a", "b", "c"]) sessions.issue(id, "hash", PRINCIPAL);
		// map 将每个 id 的存在性转成布尔值，核对淘汰的是最老一项。
		expect(["a", "b", "c"].map((id) => sessions.get(id) !== undefined)).toEqual([false, true, true]);
		// 首次删除 b 成功，并取消它的定时器。
		expect(sessions.revoke("b")).toBe(true);
		// 重复删除无对象可删，返回 false。
		expect(sessions.revoke("b")).toBe(false);
		// 清理最后的会话和定时器。
		sessions.revoke("c");
	});
});
