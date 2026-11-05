// PowerShell 复用 bash.ts 的通用 shell 工具管线，只替换进程配置、提示符和 UTF-8 输出前缀。
// 共享 shell 配置层负责找到 PowerShell 程序与参数，这里不硬编码平台可执行文件。
import { getPowerShellConfig } from "../../utils/shell.ts";
import {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	type createBashTool,
	createLocalShellOperations,
	createShellToolDefinition,
	type ShellToolConfig,
} from "./bash.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

// 这段字符串是实际发送的 PowerShell 前置命令；设置 UTF-8，设置失败则由 PowerShell catch 忽略，不修改用户命令正文。
const UTF8_OUTPUT_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

// 向 system 提示词提供 PowerShell 用途和可用环境变量的建议。
export const powershellToolSystemPromptContribution = {
	// 给模型的一句话工具说明，保留原提示词。
	snippet: "Execute PowerShell commands",
	// 提示模型可查看 PI_* 元数据；是否真的暴露由工具 options 决定。
	guidelines: ["You can inspect PI_* environment variables for current model and session details."],
} as const;

// 类型别名：两个 shell 使用相同 exec 契约，并不表示 PowerShell 命令语法与 bash 相同。
export type PowerShellOperations = BashOperations;
// 进程启动前的 command/cwd/env 形状与 bash 一致。
export type PowerShellSpawnContext = BashSpawnContext;
// 宿主可在进程启动前修改命令、工作目录与环境的回调类型。
export type PowerShellSpawnHook = BashSpawnHook;
// 共享截断详情与完整输出路径类型。
export type PowerShellToolDetails = BashToolDetails;
// 模型仍传 command 与可选 timeout，单位是秒。
export type PowerShellToolInput = BashToolInput;

export interface PowerShellToolOptions
	// Pick 只挑出这三个配置字段；没有继承 bash 专用 commandPrefix/shellPath。空接口仍保留命名类型出口。
	extends Pick<BashToolOptions, "operations" | "exposeSessionEnvironment" | "spawnHook"> {}

/**
 * 返回 PowerShell 的本地执行适配器，不在工厂调用时启动进程；真正 exec 时先插入 UTF-8 输出设置。
 * 例：exec("Get-ChildItem", cwd, options) 会通过共享 shell 后端执行同一命令，保留取消/超时/输出回调。
 */
export function createLocalPowerShellOperations(): PowerShellOperations {
	// 注入 PowerShell 配置解析函数，复用进程执行、信号取消和超时处理。
	const operations = createLocalShellOperations("PowerShell", getPowerShellConfig);
	return {
		// exec 真正被调用时才拼接前缀；三个参数继续交给共享后端。
		exec: (command, cwd, options) => operations.exec(`${UTF8_OUTPUT_PREFIX}${command}`, cwd, options),
	};
}

// 定义 PowerShell 这一款工具的名称、显示和输出文件前缀，交给通用工厂。
const powershellToolConfig: ShellToolConfig = {
	// 模型调用名为 powershell，不是 bash 的别名。
	name: "powershell",
	// 界面显示名。
	label: "powershell",
	// 描述中使用的 shell 名称。
	shellName: "PowerShell",
	// 终端工具行使用 PowerShell 风格提示符。
	prompt: "PS>",
	// 沿用上方给模型的能力摘要。
	promptSnippet: powershellToolSystemPromptContribution.snippet,
	// 沿用 PI_* 环境变量说明，通用工厂会根据暴露开关决定是否提供。
	promptGuidelines: powershellToolSystemPromptContribution.guidelines,
	// 输出过长落盘时，用于区分临时日志文件名。
	tempFilePrefix: "pi-powershell",
};

/**
 * 创建 PowerShell 工具定义，返回类型从共享 createShellToolDefinition 自动提取，避免两边手写声明漂移。
 * 宿主可传 operations 做远程执行；没有时采用本地 PowerShell，输入 schema 和流式输出处理仍与 bash 共用。
 */
export function createPowerShellToolDefinition(
	// 默认命令工作目录；执行上下文可提供当前会话目录。
	cwd: string,
	// 可选宿主配置，不是模型传入的 command 参数。
	options?: PowerShellToolOptions,
	// ReturnType 取得另一个函数的返回类型，typeof 在类型位置取得该函数类型。
): ReturnType<typeof createShellToolDefinition> {
	// 调用共享定义工厂，返回参数 schema、execute 与渲染函数的完整对象。
	return createShellToolDefinition(cwd, powershellToolConfig, {
		// 先带上调用者显式配置；下面的同名 operations 字段会覆盖此处值。
		...options,
		// 有自定义执行操作则优先使用；没有才创建本地 PowerShell 适配器。
		operations: options?.operations ?? createLocalPowerShellOperations(),
	});
}

/**
 * 构造低层 Agent 能调用的 PowerShell 工具，并补回工具提示词元数据；没有执行命令。
 * 例：把 createPowerShellTool("/project") 放进 tools 后，模型才可通过 powershell 工具声明发起命令。
 */
export function createPowerShellTool(cwd: string, options?: PowerShellToolOptions): ReturnType<typeof createBashTool> {
	// 先取得通用工具定义，仍未产生子进程。
	const definition = createPowerShellToolDefinition(cwd, options);
	// 适配为低层 AgentTool，转发 execute。
	const tool = wrapToolDefinition(definition);
	// 把额外提示词元数据写到工具对象上；Object.assign 修改第一个参数并返回它。
	Object.assign(tool, {
		// wrapper 的核心字段之外补回一句话提示信息。
		promptSnippet: definition.promptSnippet,
		// 补回工具使用指南，供后续系统提示词组装。
		promptGuidelines: definition.promptGuidelines,
	});
	// 返回装配完的可执行工具对象，真正命令由以后调用 execute 时启动。
	return tool;
}
