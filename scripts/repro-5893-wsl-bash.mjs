#!/usr/bin/env node
// 这个手工复现只适用于Windows进程，通过指定的WSL启动器执行bash工具，检查变量展开是否保留；本轮不执行真实shell。

// 文件导读：GitHub issue #5893 的 Windows/WSL bash 手工复现脚本。
// 所属：仓库根 scripts/，不是自动测试，不在 npm scripts 或 CI 中运行；只供维护者在 Windows 主机上手工执行。
// 作用：用 coding-agent 的 bash 工具通过 `C:\Windows\System32\bash.exe` 执行两条命令，检查子 bash 是否保留
//   `${name}` 这类变量展开，而不是被 JS 模板或参数处理提前消费。
// 上游：`node scripts/repro-5893-wsl-bash.mjs`，必须在 Windows PowerShell/CMD 中运行；WSL 内部（Node 平台为 linux）
//   会主动拒绝，macOS/Linux 同样拒绝。
// 下游：导入 `packages/coding-agent/src/core/tools/bash.ts` 的 createBashTool；每次 execute 启动真实 bash 进程。
// 前置条件：已启用 WSL，且固定启动器路径存在；缺失时脚本报错，不会尝试安装或自动寻找其他 bash。
// 输出与退出码：每条用例成功时打印归一化后的输出；任何断言失败或前置检查失败都抛错，Node 退出码 1。
// 副作用：启动子进程执行 shell 命令（仅 echo/for/seq，无文件写入）；不会修改仓库。
// 能力清单：
//   - getTextOutput(result)：从工具结果中提取 text 块并用换行连接。
//   - runCase(label, command, expectedOutput)：运行一条命令并做去尾空白后的完整字符串比较。
//   - 顶部检查：平台与启动器存在性。
// 典型运行与预期：
//   示例（仅 Windows）`node scripts/repro-5893-wsl-bash.mjs`；成功时最后打印
//   `issue #5893 WSL bash repro passed`。
// 阅读顺序：先看常量 shellPath 与三个展开表达式，再看 runCase 的断言方式，最后看两条命令用例。
import { existsSync } from "node:fs";
import { createBashTool } from "../packages/coding-agent/src/core/tools/bash.ts";

// 固定Windows系统WSL启动器；这不是在当前平台自动寻找bash。
const shellPath = "C:\\Windows\\System32\\bash.exe";
// 把$与花括号拆开构造字面展开式，确保由子bash展开，不由JS模板尝试读取name变量。
const nameExpansion = "$" + "{name}";
const countExpansion = "$" + "{count}";
const iExpansion = "$" + "{i}";

// 输入bash工具结果，提取全部text块并以换行连接，返回字符串且不改变结果；例如非text图片块会被跳过。
function getTextOutput(result) {
	// 从结果的content数组开始链式过滤和映射；此脚本未对外部结果另做schema校验。
	return result.content
		// 只保留type为text的块，其他内容不参与精确输出断言。
		.filter((content) => content.type === "text")
		// 取文字字段，null/undefined回退空串；??不会替换已有空字符串。
		.map((content) => content.text ?? "")
		// 多个文字块之间插入换行，不保留块结构。
		.join("\n");
}

// 输入用例名、命令和期望文字，异步运行bash工具并比较去尾空白后的结果；成功打印、失败抛错。
// 例如简单变量用例应得到Hello, World!；错误信息列出期望和实际，调用方未捕获会使脚本失败。
async function runCase(label, command, expectedOutput) {
	// cwd采用启动脚本的当前目录，shellPath显式覆盖默认shell；创建工具此时还没有执行命令。
	const tool = createBashTool(process.cwd(), { shellPath });
	// execute的第一个参数是工具调用ID，第二个是模型参数对象；await等实际进程完成。
	const result = await tool.execute(label, { command });
	// trimEnd删除所有末尾空白，不只最后一个换行，所以这项断言不检查尾空白保真。
	const output = getTextOutput(result).trimEnd();
	// 按完整字符串比较输出；不匹配就进入错误路径。
	if (output !== expectedOutput) {
		// 构造Error并抛出，阻止继续执行后面的用例。
		throw new Error(
			// 数组中的用例名/期望/实际逐行拼接，便于人查看差异。
			[
				`${label} failed`,
				"Expected:",
				expectedOutput,
				"Actual:",
				output,
			].join("\n"),
		// join把诊断数组变成一条多行错误消息。
		);
	}
	console.log(output);
// 只有断言通过才打印归一后的输出。
}

if (process.platform !== "win32") {
	// 运行时检查当前Node平台；WSL内Node属于linux，也会被拒绝以确保复现Windows启动链。
	throw new Error("This repro must run from Windows PowerShell/CMD, not macOS/Linux or inside WSL.");
}

if (!existsSync(shellPath)) {
	// 检查固定启动器是否存在；缺失就报告安装前提，不尝试自动安装。
	throw new Error(`WSL bash launcher not found at ${shellPath}. Install/enable WSL first.`);
}

await runCase(
	// 顶层await顺序跑简单变量用例；模板插入的是预先拼出的bash变量表达式。
	"issue-5893-simple-variable",
	`name='World'; echo "Hello, ${nameExpansion}!"`,
	// 命令在bash里设置name并在双引号echo中展开；原始命令字符串保持不变。
	"Hello, World!",
);

await runCase(
	// 第二个用例覆盖命令替换seq、for循环和多个变量展开，只有第一个通过后才执行。
	"issue-5893-loop-variable",
	`count=3; for i in $(seq 1 ${countExpansion}); do echo "Iteration ${iExpansion} of ${countExpansion}"; done`,
	// countExpansion/iExpansion在JS中只拼文字，真正的循环与${...}展开由WSL bash完成。
	"Iteration 1 of 3\nIteration 2 of 3\nIteration 3 of 3",
);

console.log("issue #5893 WSL bash repro passed");
