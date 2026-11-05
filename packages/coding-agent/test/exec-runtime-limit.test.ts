// 模拟较小的 Node 字符串上限，检查默认输出额度会收敛到运行时上限；不分配 256 MiB 数据。
// 命名空间导入让 typeof buffer 在类型位置描述该模块的全部导出。
import * as buffer from "node:buffer";
import { expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";

// Vitest 提升模块 mock 注册；工厂拿真实模块，再只覆盖 MAX_STRING_LENGTH，不更改进程的真实 Buffer 实现。
// async 回调返回 Promise 形式的替代导出对象；例：让 exec 模块读到模拟的 268435440 上限。
vi.mock("node:buffer", async (importOriginal) => {
	// 泛型 typeof buffer 让 actual 保留真实模块静态类型；await 等待 Vitest 获取原导出。
	const actual = await importOriginal<typeof buffer>();
	// 展开真实导出，新 constants 对象覆盖同名字段，其他成员沿用原值。
	return {
		...actual,
		// 32-bit Node's maximum is 16 bytes below 256 MiB.
		constants: { ...actual.constants, MAX_STRING_LENGTH: 268_435_440 },
	};
});

// Regression tests for https://github.com/earendil-works/pi/issues/11360
// 真正启动一个本机 Node 子进程只输出 ok，等待结果；证明缺省额度不会在启动前被上限校验拒绝。
it("executes with the default cap when the runtime string limit is below 256 MiB", async () => {
	// process.execPath 是当前 Node，-e 执行固定代码；cwd 是当前测试包目录，不经过 shell 拼接。
	const result = await execCommand(process.execPath, ["-e", 'process.stdout.write("ok")'], process.cwd());

	// 深比较全部结果字段：stdout 有 ok、无 stderr、成功退出且未请求杀死或截断。
	expect(result).toEqual({ stdout: "ok", stderr: "", code: 0, killed: false, truncated: false });
});

// 显式额度比模拟上限大 1，应在 spawn 前拒绝 Promise；不实际生成大输出。
it("still rejects an explicit cap above the runtime string limit", async () => {
	// rejects 等待异步拒绝并检查 RangeError 类型；未断言具体错误消息。
	await expect(
		// maxBuffer 的 number 类型无法约束数值上界，所以实现仍需运行时范围校验。
		execCommand(process.execPath, ["-e", ""], process.cwd(), { maxBuffer: buffer.constants.MAX_STRING_LENGTH + 1 }),
	).rejects.toThrow(RangeError);
});
