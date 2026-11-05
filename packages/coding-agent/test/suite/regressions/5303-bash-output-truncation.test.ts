// 问题 #5303：用 EventEmitter 与 PassThrough 假子进程、虚拟时间验证退出后的输出空闲宽限；不会启动 git 或真实后代进程。
import type { ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForChildProcess } from "../../../src/utils/child-process.ts";

/**
 * Regression test for https://github.com/earendil-works/pi/issues/5303
 *
 * waitForChildProcess armed a fixed 100ms timer on `exit` and destroyed the
 * stdio streams when it fired. When a short-lived detached descendant kept the
 * stdout pipe open, `close` never fired, so that timer was the only thing that
 * resolved the wait, and any output written more than 100ms after exit was
 * binned. In practice every git commit whose pre-commit hook runs lint-staged
 * came back truncated mid-listr2 output, read by the model as a hang.
 *
 * The fix re-arms the grace on each chunk, so an actively writing pipe keeps us
 * reading while a genuinely idle held-open handle still releases after the
 * grace elapses. Both behaviours are covered below with virtual time so host
 * load cannot reorder a real subprocess's writes and the grace timer.
 */
// 注册退出后输出收尾的两种情况：持续每 50ms 输出，以及退出后完全安静。
describe("issue #5303 bash output truncation past exit", () => {
	// 创建最小假进程，返回带 stdout/stderr 的 EventEmitter，不启动 OS 进程；例如 emit(exit,0,null) 模拟退出。双重断言只满足 TS，不补齐真实 ChildProcess。
	function createChild(): ChildProcessByStdio<null, PassThrough, PassThrough> {
		// 把三个 stdio 字段合并到事件发射器实例，使真实等待函数可监听 exit/close/data/end。
		return Object.assign(new EventEmitter(), {
			// 没有输入流；泛型第一个参数 null 描述此形状。
			stdin: null,
			// 构造可写入也可读取的内存透传流，模拟标准输出管道。
			stdout: new PassThrough(),
			// 另建错误流，维持等待函数对两条输出的接口要求。
			stderr: new PassThrough(),
			// 经 unknown 断言成所需进程类型；运行时仍是最小 EventEmitter，不能拿它验证启动/信号等行为。
		}) as unknown as ChildProcessByStdio<null, PassThrough, PassThrough>;
	}

	// 每例前切换虚拟时钟，无输入返回；使 99ms/1ms 边界不依赖机器实际负载。
	beforeEach(() => {
		// 让 setTimeout 等由 Vitest 时钟控制，真实等待函数的空闲定时器也被接管。
		vi.useFakeTimers();
	});

	// 每个用例结束后执行清理回调；无参数、无业务返回值，断言失败时 Vitest 也会安排它运行。
	afterEach(() => {
		// 每例后恢复真实计时器，避免污染其他文件。
		vi.useRealTimers();
	});

	// 无输入异步用例：假退出后每 50ms 写一次，最后静默 99+1ms；断言最后一块未丢失且等待只在宽限耗尽后完成。
	it("captures output emitted after exit while a descendant holds stdout open", async () => {
		// 为本例创建独立假进程和内存管道，没有真实 PID。
		const child = createChild();
		// 累积已读取的输出文字，供末尾检查 HEAD/TICK6。
		let output = "";
		// 业务监听收到 Buffer 后追加到字符串；Buffer 注解在开发期检查回调参数，不会转换其他数据。
		child.stdout.on("data", (chunk: Buffer) => {
			// 把当前输出块解码后接到已有内容后面，保持事件到达顺序。
			output += chunk.toString();
		});
		// 记录等待 Promise 的 then 是否已经运行，便于观察完成时间边界。
		let resolved = false;
		// 调用真实收尾函数并安装 then；接收退出码，更新标记后透传该码，错误会继续拒绝。
		const waiting = waitForChildProcess(child).then((exitCode) => {
			// 只有成功结算后才置 true，表示异步等待确已完成。
			resolved = true;
			// 让 waiting 保留原退出码，供最终断言使用。
			return exitCode;
		});

		// 退出前写一块初始输出，确认正常头部也被收集。
		child.stdout.write("HEAD\n");
		// 同步发假 exit：退出码 0、无信号；不发 close/end，所以只能靠空闲宽限完成。
		child.emit("exit", 0, null);
		// 循环模拟六次后代输出，index++ 每轮加一，总跨度 300ms，超过旧固定 100ms 截断阈值。
		for (let index = 1; index <= 6; index++) {
			// 推进虚拟时间 50ms 并排空相关异步步骤，尚未达到当前 100ms 空闲阈值。
			await vi.advanceTimersByTimeAsync(50);
			// 写当前编号，真实等待函数应因这块 data 重新开始空闲计时。
			child.stdout.write(`TICK${index}\n`);
		}
		// 从最后一块输出或 exit 后推进 99ms，停在宽限边界前。
		await vi.advanceTimersByTimeAsync(99);
		// 要求尚未提前完成，防止丢弃宽限内仍可能到达的字节。
		expect(resolved).toBe(false);
		// 再推进 1ms，使连续空闲达到 100ms，触发真实收尾定时器。
		await vi.advanceTimersByTimeAsync(1);

		// 等待 Promise 并核对保留的成功退出码，没有把退出码与输出管道结束混为一件事。
		expect(await waiting).toBe(0);
		// 检查退出前的头部输出保留。
		expect(output).toContain("HEAD");
		// 检查第六次、退出后 300ms 的输出也保留；不据此保证无限晚到的字节都不会丢。
		expect(output).toContain("TICK6");
	});

	// 无输入异步用例：假退出后没有新输出，推进 99ms 尚未完成，再推进 1ms 应完成；模拟管道仍持有但不写入。
	it("resolves after the grace when a descendant holds stdout open but stays quiet", async () => {
		// 为本例创建独立假进程和内存管道，没有真实 PID。
		const child = createChild();
		// 记录等待 Promise 的 then 是否已经运行，便于观察完成时间边界。
		let resolved = false;
		// 调用真实收尾函数并安装 then；接收退出码，更新标记后透传该码，错误会继续拒绝。
		const waiting = waitForChildProcess(child).then((exitCode) => {
			// 只有成功结算后才置 true，表示异步等待确已完成。
			resolved = true;
			// 让 waiting 保留原退出码，供最终断言使用。
			return exitCode;
		});

		// 只在退出前写 DONE，后面保持管道打开但不再写，模拟安静持有句柄。
		child.stdout.write("DONE\n");
		// 同步发假 exit：退出码 0、无信号；不发 close/end，所以只能靠空闲宽限完成。
		child.emit("exit", 0, null);
		// 从最后一块输出或 exit 后推进 99ms，停在宽限边界前。
		await vi.advanceTimersByTimeAsync(99);
		// 要求尚未提前完成，防止丢弃宽限内仍可能到达的字节。
		expect(resolved).toBe(false);
		// 再推进 1ms，使连续空闲达到 100ms，触发真实收尾定时器。
		await vi.advanceTimersByTimeAsync(1);

		// 等待 Promise 并核对保留的成功退出码，没有把退出码与输出管道结束混为一件事。
		expect(await waiting).toBe(0);
	});
});
