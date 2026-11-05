import type * as Fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getShellConfig } from "../src/utils/shell.ts";

// 模块 mock 工厂拿到原模块加载器，异步返回替换后的导出；只替换 accessSync，让所有候选路径都“存在”。
// 例如传入 D:\WinNT\Sysnative\bash.exe 时不访问该磁盘，不能据此证明真实 Windows 文件可执行。
vi.mock("node:fs", async (importOriginal) => ({
	// typeof Fs 是模块导出的静态类型；await 等原模块加载，展开后保留其他 fs 方法。
	...(await importOriginal<typeof Fs>()),
	// 空函数既不抛错也不实际检查文件，shellPathExists 因而返回 true。
	accessSync: () => {},
}));

// 保存原属性描述符，包括值和属性标记；! 只让编译器相信它存在，不做运行时检查。
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

// 每例把平台属性临时伪装为 Windows，触发配置分支；无返回，不启动 Windows 进程。
beforeEach(() => {
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
});

// 每例结束还原平台属性与 stub 环境；只恢复本例改动的状态，不清理任意外部模块缓存。
afterEach(() => {
	// 使用完整原描述符恢复，避免只改值遗漏 configurable 等标记。
	Object.defineProperty(process, "platform", platformDescriptor);
	// 撤销 SystemRoot 的测试覆盖。
	vi.unstubAllEnvs();
});

// #9490: identify legacy WSL launchers under the actual Windows directory.
// 表格登记六例路径识别，不运行 bash；实际验证的是 shell 配置的 args/commandTransport。
describe("legacy WSL bash detection", () => {
	// 每行依次是 SystemRoot、显式 shell、是否经 stdin 传命令；覆盖斜杠/大小写、Sysnative、缺省根及误匹配。
	it.each([
		["D:\\WinNT\\", "d:/WINNT/System32/BASH.EXE", true],
		["D:\\WinNT", "D:\\WinNT\\Sysnative\\bash.exe", true],
		[undefined, "E:\\Windows\\System32\\bash.exe", true],
		["D:\\WinNT", "D:\\Git\\bin\\bash.exe", false],
		["D:\\WinNT", "E:\\Windows\\System32\\bash.exe", false],
		["WinNT", "C:\\Windows\\System32\\bash.exe", false],
	] as const)("resolves %j / %j to stdin=%j", (systemRoot, shell, stdin) => {
		// as const 让表项保留字面量元组类型，回调参数由每列推断；stubEnv(undefined) 表示根目录未知。
		vi.stubEnv("SystemRoot", systemRoot);

		// 显式路径通过 mock 的存在性检查；三元表达式生成两种完整期望，toEqual 深比较对象。
		expect(getShellConfig(shell)).toEqual(
			stdin ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] },
		);
	});
});
