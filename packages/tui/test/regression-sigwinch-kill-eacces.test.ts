// 验证刷新终端尺寸的尽力而为策略：Windows不发信号，POSIX发信号失败也不崩溃；用进程内 mock 替代当前调用，不操作真实 TTY。
// 导入 Node 断言，检查同步调用是否抛错或发生预期副作用。
import assert from "node:assert";
// after 在整个组结束后恢复全局；describe/it 以默认非并发方式注册这组修改 process 的用例。
import { after, describe, it } from "node:test";
// 导入尺寸刷新函数；当前实现只向 process.pid 发 SIGWINCH，测试正针对这个同步边界。
import { refreshTerminalDimensions } from "../src/terminal.ts";

// 组织刷新策略回归；下面保存原全局值，mock 只应在本测试文件的测试进程内生效。
describe("refreshTerminalDimensions", () => {
	// 保存原 kill 函数供最后恢复，也作为首个 mock 中其他 PID 的回退；本用例实际调用只传自身 PID。
	const originalKill = process.kill;
	// 保存原平台字符串，不是查询或更改操作系统。
	const originalPlatform = process.platform;

	// 伪装 Linux 并让对自身发信号同步抛 EACCES，调用刷新后预期不抛出；这里不验证真实 seccomp/LSM 环境。
	it("does not throw when kill(2) returns EACCES for self-signal", () => {
		// 重定义 Node 暴露的 platform 属性值，强制进入 POSIX 分支，不会把当前系统变成 Linux。
		Object.defineProperty(process, "platform", { value: "linux" });
		// 立即调用的箭头工厂返回新的 kill 函数；typeof process.kill 仅提供 TS 签名，不复制实现或检查权限。
		process.kill = ((): typeof process.kill => {
			// 替身接收 PID/信号；_signal 表示此分支主要检查 PID，并不意味着参数未传入。
			return (pid, _signal) => {
				// 刷新实现传自身 PID，所以当前实际调用命中此分支，绝不会落到下面原函数。
				if (pid === process.pid) {
					// as NodeJS.ErrnoException 只是静态断言，普通 Error 要在下一行手动加 code，断言本身不生成系统异常。
					const err = new Error("kill EACCES") as NodeJS.ErrnoException;
					// 给错误附上 EACCES，模拟底层权限拒绝。
					err.code = "EACCES";
					// 同步抛出，使被测函数的 try/catch 承担吞错工作。
					throw err;
				}
				// 保留非自身 PID 的原函数回退，用 call 显式指定 this；当前被测实现与输入不触达这里，因此测试不实际发信号。
				return originalKill.call(process, pid, _signal);
			};
			// 括号后的 () 立即执行工厂并把返回函数赋给 process.kill，仍未调用这份替身。
		})();

		// doesNotThrow 立即调用无参数回调，若异常逃出就让断言失败；不等待 Promise。
		assert.doesNotThrow(() => {
			// 被测刷新只会调用 mock，然后捕获其 EACCES；没有真实终端尺寸查询。
			refreshTerminalDimensions();
		});
	});

	// 伪装 Windows 后用标志型 mock 检查刷新根本不调用 kill；无真实信号，失败抛断言。
	it("does not call kill on win32", () => {
		// 强制进入 win32 早返回分支。
		Object.defineProperty(process, "platform", { value: "win32" });
		// 本地可变布尔值记录替身是否曾被调用。
		let killCalled = false;
		// 另建符合原 kill 静态签名的函数，不沿用上一用例的 EACCES 行为。
		process.kill = ((): typeof process.kill => {
			// 替身忽略入参，若被调用只写内存标志。
			return () => {
				// 用副作用让后面断言区分“没有调用”和“调用后吞错”。
				killCalled = true;
				// 模拟 kill 的布尔返回，不代表任何系统信号送达。
				return true;
			};
			// 立即执行工厂取得函数并安装，没有执行函数体中的标志赋值。
		})();

		// 在伪 Windows 环境调用刷新，预期最前面的平台判断直接返回。
		refreshTerminalDimensions();

		// 验证 mock 从未触发；消息字符串只在断言失败时展示。
		assert.strictEqual(killCalled, false, "kill should not be called on win32");
	});

	// 虽然原测试名叫 preserves other error codes，实际断言只证明 EPERM 也被吞掉，不检查错误保留、记录或重新抛出。
	it("preserves other error codes", () => {
		// 重新设置 Linux，以免上一例的 win32 早返回使后面测试空通过。
		Object.defineProperty(process, "platform", { value: "linux" });
		// 安装第三份 kill mock，让任意调用都抛 EPERM，不可能落到系统原函数。
		process.kill = ((): typeof process.kill => {
			// 返回无参数使用的替身；TS 允许函数忽略接口要求的入参。
			return () => {
				// 创建普通 Error 并静态标为可带 code 的错误接口。
				const err = new Error("kill EPERM") as NodeJS.ErrnoException;
				// 设置另一种权限错误码，与首例 EACCES 区分。
				err.code = "EPERM";
				// 同步抛出，验证刷新捕获不是只特判 EACCES。
				throw err;
			};
			// 完成立即调用的工厂赋值，下一步刷新才执行替身。
		})();

		// EPERM is also ignored - the refresh is best-effort
		// 断言同步回调无错误逃出，不对日志或屏幕尺寸做要求。
		assert.doesNotThrow(() => {
			// 调用被测刷新，内部 catch 吞掉模拟的 EPERM。
			refreshTerminalDimensions();
		});
	});

	// 组结束的清理钩子恢复 kill/platform，无参数/返回值；普通用例失败也执行清理，但强制进程退出不在此保证内。
	after(() => {
		// 恢复最初保存的原 kill 函数引用。
		process.kill = originalKill;
		// 恢复原平台值，结束测试对该 process 属性的覆盖。
		Object.defineProperty(process, "platform", { value: originalPlatform });
	});
});
