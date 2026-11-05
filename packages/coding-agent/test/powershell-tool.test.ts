// 验证 PowerShell 启动参数；第二例仅 Windows 执行真实命令，其他平台跳过。
import { describe, expect, it } from "vitest";
import { createPowerShellTool } from "../src/core/tools/powershell.ts";
import { getPowerShellConfig, POWERSHELL_ARGS } from "../src/utils/shell.ts";

// 输入工具结果的最小内容形状，筛选文本块后用换行拼接返回；无 I/O。
// 例：text 块缺 text 时作为空串；该函数不校验内容来源，异常不额外捕获。
// Array<{...}> 与 {...}[] 等价，text? 表示字段可以缺省。
function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	// 从内容数组开始链式转换，不修改原 result。
	// filter 回调只保留 type 为 text 的块；图片或其他块不进入后续拼接。
	// map 用 ?? 把缺 text 变为空串，已有空串也保留。
	// join 在各个文本块之间插入换行，零块时返回空字符串。
	return result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("\n");
}

// 注册 PowerShell 工具测试；仅组声明本身不会启动 shell。
describe("powershell tool", () => {
	// 比较启动参数，要求执行策略绕过仅随该进程参数传入；不改变系统策略。
	it("uses process-local execution policy bypass", () => {
		// toEqual 逐元素比较数组与顺序；as const 的产品常量仍是普通运行时数组。
		expect(POWERSHELL_ARGS).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
	});

	// skipIf 在非 Windows 跳过；Windows 上真实执行带重音字符输出与 Process 范围策略查询。
	// 回调返回 Promise，命令启动/执行或断言失败会由 Vitest 报错；本例不测试其他编码。
	it.skipIf(process.platform !== "win32")("executes PowerShell commands with UTF-8 output", async () => {
		// 解析当前可用 PowerShell 配置，可能在本机寻找可执行程序；缺失时会抛错。
		const config = getPowerShellConfig();
		// 要求实际配置沿用上面已检查的启动参数。
		expect(config.args).toEqual(POWERSHELL_ARGS);

		// 以当前进程目录创建工具定义，此时尚未执行命令。
		const tool = createPowerShellTool(process.cwd());
		// await 等待工具实际启动 PowerShell、收集输出并返回结果；测试调用 ID 为固定字符串。
		const result = await tool.execute("powershell-test", {
			// 命令输出固定 Unicode 文本，再查询这个 PowerShell 进程的 ExecutionPolicy。
			command: "Write-Output 'héllo €'; Get-ExecutionPolicy -Scope Process",
		});
		// 只提取文本块，忽略结果中其他类型内容。
		const output = getTextOutput(result);

		// 检查 UTF-8 示例文字未损坏，不能据此保证所有字节组合都正确。
		expect(output).toContain("héllo €");
		// 检查进程策略输出含 Bypass，不查询或修改用户/机器级策略。
		expect(output).toContain("Bypass");
	});
});
