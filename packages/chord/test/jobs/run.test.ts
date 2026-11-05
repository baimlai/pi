// Tests of one run's record (§15): its `running` entry per phase, and its handle's wait for the outcome.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../src/context/index.ts";
import { ChordError } from "../../src/data/index.ts";
import { JobRun } from "../../src/jobs/run.ts";
import { rejection } from "../support.ts";

// 直接测试内存中的 JobRun 记录和等待器；不启动宿主或真实工作，例如用 resolve 手动送入结果。
describe("a run", () => {
	// 无参同步用例构造记录、改变阶段并读取条目；验证输出形状，返回 void，不执行 run/finish。
	it("has an entry per phase: args and state while running or finishing, neither when blocked, with its reason", () => {
		// 参数依次是 id、定义版本、指纹、去重键、原始参数、记录阶段；这里均为固定测试数据。
		const run = new JobRun("r1", 2, "f2", "k", { command: "ls" }, "running");
		// entryFor 接收当前状态及供当前版本展示的参数；结果带去重键和 state。
		expect(run.entryFor({ output: "" }, run.args)).toEqual({
			id: "r1",
			version: 2,
			key: "k",
			args: { command: "ls" },
			state: { output: "" },
			phase: "running",
		});
		// 直接改字段模拟阶段；此后立即检查的是另一个 r2，不是 r1 的 finishing 条目。
		run.phase = "finishing";
		// r2 没有 key/state，生成的 JSON 也不应包含这些可选字段。
		expect(new JobRun("r2", 1, "f1", undefined, { a: 1 }, "running").entryFor(undefined, { a: 1 })).toEqual({
			id: "r2",
			version: 1,
			args: { a: 1 },
			phase: "running",
		});
		// blocked 条目隐藏参数和状态，只保留 id/version/phase/reason。
		run.phase = "blocked";
		run.blocked = "finish_failed";
		expect(run.entryFor({ output: "x" }, run.args)).toEqual({
			id: "r1",
			version: 2,
			phase: "blocked",
			reason: "finish_failed",
		});
		// 同一阶段的另一原因是代码版本不适配；toMatchObject 只断言指定字段。
		run.blocked = "version";
		expect(run.entryFor(undefined, run.args)).toMatchObject({ phase: "blocked", reason: "version" });
		// A persisted run waiting for its reservation, or stopped, runs (again): `running`.
		// pending/stopped 是存储内部阶段，对外列表统一显示 running；这不是证明已经调用 run。
		run.phase = "pending";
		expect(run.entryFor(undefined, run.args)).toMatchObject({ phase: "running" });
		// 干净停止的记录恢复后仍需处理，因此也显示为待执行工作。
		run.phase = "stopped";
		expect(run.entryFor(undefined, run.args)).toMatchObject({ phase: "running" });
		// An older run's entry shows its args as the current code takes them (mapped by its job).
		// entryFor 不自行映射参数：直接使用传入的展示值，旧记录的原始 run.args 不必被改写。
		run.phase = "running";
		expect(run.entryFor(undefined, { command: "ls -l" })).toMatchObject({ args: { command: "ls -l" } });
	});

	// 异步用例手动完成运行并观察等待；例：取消某个等待得到 left，之后的等待仍能得到成功结果。
	// 返回 Promise<void>，副作用限于内存等待器和一个取消上下文；没有任务宿主或真实 shell。
	it("gives every waiter the outcome, late ones too; a waiter's context ends only its wait", async () => {
		// 没有去重键的独立运行，初始尚未完成。
		const run = new JobRun("r1", 1, "f1", undefined, {}, "running");
		// 解构并将 context 重命名为 waiting，避免遮蔽上方后台 context。
		const { context: waiting, cancel } = withCancel(context);
		// rejection 立即安装 catch，并把拒绝原因作为正常值返回给后面的 expect。
		const cancelled = rejection(run.handle.outcome(waiting));
		// 取消只作用于这个等待器，不等同于 Job.abort，不改变 run 阶段或业务结果。
		cancel(new Error("left"));
		expect(await cancelled).toMatchObject({ message: "left" });
		// as const 保留 kind 的字面量类型并令属性在 TS 中只读；运行时不会冻结对象。
		const outcome = { id: "r1", args: {}, state: undefined, kind: "done", result: 1 } as const;
		// 手动完成等待器，模拟 finish 提交后由任务管理器发布结果。
		run.resolve(outcome);
		// 晚注册的等待也直接获得同一个对象引用，而非结果副本。
		expect(await run.handle.outcome(context)).toBe(outcome);
		// 另建运行检查最终拒绝分支，不能再使用已成功完成的 r1。
		const rejected = new JobRun("r2", 1, "f1", undefined, {}, "running");
		// reject 保存最终失败；与 Outcome 的 kind: failed（业务结果对象）不同，这里是 Promise 拒绝。
		rejected.reject(new ChordError({ code: "aborted", message: "dropped" }));
		// rejection 会把 ChordError 转为 JSON，因此断言的是 code 而非异常实例。
		expect(await rejection(rejected.handle.outcome(context))).toMatchObject({ code: "aborted" });
	});
});
