// 内置工具的公共导出与装配入口；区别 ToolDefinition（会话带上下文的定义）和 Tool（低层 Agent 可执行接口），工厂阶段都不执行工具。
// 具名重新导出：调用方可从 tools/index.ts 集中导入这些工具与类型；此段不执行工具。
export {
	// 仅重新导出命令后端接口：宿主可实现 exec 替换本地 shell；type 在运行时擦除。
	type BashOperations,
	// 启动钩子的 command/cwd/env 数据形状，供扩展在进程启动前查看或修改。
	type BashSpawnContext,
	// 启动前变换回调类型，输入并返回一份 BashSpawnContext。
	type BashSpawnHook,
	// shell 展示详情类型：截断统计与完整输出日志路径，不是命令 stdout 正文。
	type BashToolDetails,
	// 模型调用 bash 的输入类型，包含 command 和可选 timeout 秒数。
	type BashToolInput,
	// 宿主构造 bash 的设置：shell 路径、执行后端、命令前缀与环境暴露等。
	type BashToolOptions,
	// 为独立 Agent 构造可执行 bash 适配工具；创建时不会启动 shell。
	createBashTool,
	// 为 AgentSession 构造带 schema、execute、渲染器的 bash 完整定义。
	createBashToolDefinition,
	// 单独构造 Pi 的本地 shell 执行后端，扩展可以包裹它而保留超时/取消规则。
	createLocalBashOperations,
	// 结束此组从 bash.ts 的具名重导出；外部可从本统一入口导入，而实现仍在原模块。
} from "./bash.ts";
// 具名重新导出：调用方可从 tools/index.ts 集中导入这些工具与类型；此段不执行工具。
export {
	// 构造低层 edit 工具，供独立 Agent 做精确文本替换。
	createEditTool,
	// 构造会话使用的编辑定义，包含输入兼容整理、替换执行和预览渲染。
	createEditToolDefinition,
	// 编辑后端接口：access/readFile/writeFile，宿主可注入不同文件系统。
	type EditOperations,
	// 编辑结果详情：显示 diff、标准 patch、新文件第一变化行。
	type EditToolDetails,
	// 模型编辑输入类型：path 与多项 oldText/newText 的 edits 数组。
	type EditToolInput,
	// 编辑工厂设置，主要用于替换文件操作实现。
	type EditToolOptions,
	// 结束此组从 edit.ts 的具名重导出；外部可从本统一入口导入，而实现仍在原模块。
} from "./edit.ts";
// 公开同文件修改队列，供宿主自定义文件修改能力复用串行规则。
export { withFileMutationQueue } from "./file-mutation-queue.ts";
// 具名重新导出：调用方可从 tools/index.ts 集中导入这些工具与类型；此段不执行工具。
export {
	// 构造低层文件名搜索工具，执行时按 glob 返回路径，不搜索文件正文。
	createFindTool,
	// 构造会话使用的 find 定义；默认 fd，也可宿主注入 glob 后端。
	createFindToolDefinition,
	// find 后端契约：exists 与 glob；自定义 glob 能替代默认 fd 进程。
	type FindOperations,
	// find 的数量上限与字节截断详情，供结果渲染解释省略部分。
	type FindToolDetails,
	// 模型 find 输入类型：pattern、可选搜索目录 path 和结果 limit。
	type FindToolInput,
	// find 创建设置，可注入自定义目录存在性和 glob 搜索操作。
	type FindToolOptions,
	// 结束此组从 find.ts 的具名重导出；外部可从本统一入口导入，而实现仍在原模块。
} from "./find.ts";
// 具名重新导出：调用方可从 tools/index.ts 集中导入这些工具与类型；此段不执行工具。
export {
	// 构造低层正文搜索工具，以 rg 搜索并返回命中行号和可选上下文。
	createGrepTool,
	// 构造会话用 grep 定义，接入搜索 schema、execute 和结果显示。
	createGrepToolDefinition,
	// grep 可替换的 isDirectory/readFile 接口；不包含替代 rg 搜索本身的方法。
	type GrepOperations,
	// grep 展示详情，分别记录匹配上限、整段裁剪和过长单行裁剪。
	type GrepToolDetails,
	// 模型 grep 输入类型，包括 pattern、路径、文件 glob、上下文、大小写和字面量选项。
	type GrepToolInput,
	// 宿主可替换 grep 的文件类型判断/上下文读取，搜索仍由默认 rg 进程完成。
	type GrepToolOptions,
	// 结束此组从 grep.ts 的具名重导出；外部可从本统一入口导入，而实现仍在原模块。
} from "./grep.ts";
// 具名重新导出：调用方可从 tools/index.ts 集中导入这些工具与类型；此段不执行工具。
export {
	// 构造低层目录列表工具，返回直接条目而不递归遍历。
	createLsTool,
	// 构造会话用 ls 定义，包含目录参数、排序/格式化与结果渲染。
	createLsToolDefinition,
	// 目录后端契约：exists、stat、readdir，允许同步或异步实现。
	type LsOperations,
	// 目录条目上限和正文截断详情。
	type LsToolDetails,
	// 模型 ls 输入类型：可选目录 path 和条目 limit。
	type LsToolInput,
	// 创建目录工具时的文件系统后端配置。
	type LsToolOptions,
	// 结束此组从 ls.ts 的具名重导出；外部可从本统一入口导入，而实现仍在原模块。
} from "./ls.ts";
// 具名重新导出：调用方可从 tools/index.ts 集中导入这些工具与类型；此段不执行工具。
export {
	// 创建 PowerShell 本地执行后端，自动添加 UTF-8 控制台输出设置，复用共享 shell 管线。
	createLocalPowerShellOperations,
	// 构造低层 powershell 工具，与 bash 接口类似但命令语言及 shell 不同。
	createPowerShellTool,
	// 构造会话用 PowerShell 定义，使用 PS> 显示提示符。
	createPowerShellToolDefinition,
	// PowerShell exec 后端契约，与 BashOperations 共用参数/输出形状。
	type PowerShellOperations,
	// PowerShell 启动前的命令、工作目录和环境对象类型。
	type PowerShellSpawnContext,
	// PowerShell 进程启动前变换 command/cwd/env 的宿主回调类型。
	type PowerShellSpawnHook,
	// PowerShell 的输出截断与日志详情类型，和 bash 复用。
	type PowerShellToolDetails,
	// 模型 PowerShell 参数：command 和可选超时秒数。
	type PowerShellToolInput,
	// PowerShell 工厂可选后端、环境暴露与启动钩子，不含 bash 专用 shellPath/前缀选项。
	type PowerShellToolOptions,
	// 结束此组从 powershell.ts 的具名重导出；外部可从本统一入口导入，而实现仍在原模块。
} from "./powershell.ts";
// 具名重新导出：调用方可从 tools/index.ts 集中导入这些工具与类型；此段不执行工具。
export {
	// 构造低层文件读取工具，读文本或图片，受输出/图片限制控制。
	createReadTool,
	// 构造带执行上下文的 read 定义，供会话创建和图片/文本渲染使用。
	createReadToolDefinition,
	// 读取后端接口：access/readFile 及可选图片 MIME 探测。
	type ReadOperations,
	// read 的输出截断详情，供 UI 展示“还可从哪一行继续读”。
	type ReadToolDetails,
	// 模型 read 参数类型：path、可选 offset/limit，行号从 1 开始。
	type ReadToolInput,
	// read 工厂设置：文件后端、图片自动缩放和兜底尺寸约束。
	type ReadToolOptions,
	// 结束此组从 read.ts 的具名重导出；外部可从本统一入口导入，而实现仍在原模块。
} from "./read.ts";
// 具名重新导出：调用方可从 tools/index.ts 集中导入这些工具与类型；此段不执行工具。
export {
	// 公共工具正文默认字节预算 50×1024；不是模型 token 数。
	DEFAULT_MAX_BYTES,
	// 公共工具正文默认行数上限 2000，先触及行数或字节哪个就按哪个裁剪。
	DEFAULT_MAX_LINES,
	// 把字节数转为 B/KB/MB 显示文本，供限制提示使用。
	formatSize,
	// 可选行数/字节预算对象的类型。
	type TruncationOptions,
	// 正文裁剪结果类型，包含前后数量、原因与特殊半行标志。
	type TruncationResult,
	// 本地保留开头完整行，适合 read/搜索输出；不是调用模型总结对话。
	truncateHead,
	// 按字符串长度裁剪 grep 单行，超长时增加可见后缀。
	truncateLine,
	// 本地保留末尾行，适合 shell 最后诊断；超长末行可特殊保留末尾片段。
	truncateTail,
	// 结束此组从 truncate.ts 的具名重导出；外部可从本统一入口导入，而实现仍在原模块。
} from "./truncate.ts";
// 具名重新导出：调用方可从 tools/index.ts 集中导入这些工具与类型；此段不执行工具。
export {
	// 构造低层整文件写入工具，支持新建与覆盖，执行时自动建父目录。
	createWriteTool,
	// 构造会话用 write 定义，包含 schema、同文件队列执行及渲染。
	createWriteToolDefinition,
	// 写入后端接口：mkdir 与 writeFile，便于本地/远程实现替换。
	type WriteOperations,
	// 模型 write 参数类型：path 和完整 content，不是局部 diff。
	type WriteToolInput,
	// 宿主构造 write 时的操作后端设置。
	type WriteToolOptions,
	// 结束此组从 write.ts 的具名重导出；外部可从本统一入口导入，而实现仍在原模块。
} from "./write.ts";

// 从通用 Agent 包只导入工具接口类型；import type 不在运行时额外取得一个值。
import type { AgentTool } from "@earendil-works/pi-agent-core";
// 会话工具定义比低层 AgentTool 多执行上下文/渲染等信息，下面分别提供两套工厂。
import type { ToolDefinition } from "../extensions/types.ts";
// 上方 export 只负责对外转发，不会在本模块建立可用局部绑定；这里 import 工厂供下面装配调用。
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
// 引入精确编辑的两种接口工厂与它们共享的宿主配置类型。
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
// 引入按文件名 glob 查找的工具/定义工厂。
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
// 引入搜索文件正文的工具/定义工厂。
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
// 引入目录直接条目列表的工具/定义工厂。
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
// 引入 PowerShell 专属工厂，复用 shell 执行机制而保留不同命令语言。
import { createPowerShellTool, createPowerShellToolDefinition, type PowerShellToolOptions } from "./powershell.ts";
// 引入文本/图片读取的工具/定义工厂。
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
// 引入完整文件写入的工具/定义工厂。
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

// 给异构内置工具统一起名 Tool；type 导出只影响类型检查，运行时不存在这个别名。
export type Tool = AgentTool<any>;
// 统一表示 schema 和详情类型可能不同的工具定义。
export type ToolDef = ToolDefinition<any, any>;
// 字符串字面量联合类型限定内置名字；它不自动验证 JavaScript/外部 JSON 的运行时输入。
export type ToolName = "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls";
// 运行时 Set 存放允许的工具名，支持 has(name) 等存在性查询；泛型限制开发时可放入的值。
export const allToolNames: Set<ToolName> = new Set([
	// 运行时集合中登记 read，供名称查询使用；登记不意味着模型必定已启用它。
	"read",
	// 登记 bash 名称，对应 shell 命令执行。
	"bash",
	// 登记 PowerShell 名称，与 bash 分开选择。
	"powershell",
	// 登记精确文本替换工具名称。
	"edit",
	// 登记完整文件写入/覆盖工具名称。
	"write",
	// 登记正文搜索名称。
	"grep",
	// 登记文件路径 glob 搜索名称。
	"find",
	// 登记目录直接条目列表名称。
	"ls",
]);

// 宿主按工具名配置各自操作；这些不是模型可调用的工具参数。
export interface ToolsOptions {
	// read 可配置文件操作和图片处理。
	read?: ReadToolOptions;
	// bash 可配置 shell、环境暴露、启动钩子与执行适配。
	bash?: BashToolOptions;
	// PowerShell 使用自己的执行选项子集。
	powershell?: PowerShellToolOptions;
	// write 可替换 mkdir/writeFile 后端。
	write?: WriteToolOptions;
	// edit 可替换 access/readFile/writeFile 后端。
	edit?: EditToolOptions;
	// grep 配置目录判断及上下文读取，实际搜索仍使用 rg。
	grep?: GrepToolOptions;
	// find 可配置 glob 搜索后端，注入后不走默认 fd。
	find?: FindToolOptions;
	// ls 配置存在性、stat 和目录条目读取。
	ls?: LsToolOptions;
}

/**
 * 按一个合法 ToolName 选择定义工厂，传入工作目录和该工具专属 options；返回定义对象，不执行命令或文件操作。
 * 例：createToolDefinition("read", "/project", {read:{autoResizeImages:false}}) 只构造 read 定义。switch default 为运行时错误输入给出明确异常。
 */
export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	// 根据名字分派；每个 case 中的 return 直接返回工厂结果，不会落入下一个 case。
	switch (toolName) {
		// 选择 read 的对应工厂，下面只传它自己的 options 字段。
		case "read":
			// 构造 read 的完整定义；?. 允许 options 未传，具体默认值由该工厂处理。
			return createReadToolDefinition(cwd, options?.read);
		// 选择 bash 的对应工厂，下面只传它自己的 options 字段。
		case "bash":
			// 构造 bash 的完整定义；?. 允许 options 未传，具体默认值由该工厂处理。
			return createBashToolDefinition(cwd, options?.bash);
		// 选择 powershell 的对应工厂，下面只传它自己的 options 字段。
		case "powershell":
			// 为 powershell 选择会话定义工厂，只传其专属设置，不把 bash 配置误传给它。
			return createPowerShellToolDefinition(cwd, options?.powershell);
		// 选择 edit 的对应工厂，下面只传它自己的 options 字段。
		case "edit":
			// 构造 edit 的完整定义；?. 允许 options 未传，具体默认值由该工厂处理。
			return createEditToolDefinition(cwd, options?.edit);
		// 选择 write 的对应工厂，下面只传它自己的 options 字段。
		case "write":
			// 构造 write 的完整定义；?. 允许 options 未传，具体默认值由该工厂处理。
			return createWriteToolDefinition(cwd, options?.write);
		// 选择 grep 的对应工厂，下面只传它自己的 options 字段。
		case "grep":
			// 构造 grep 的完整定义；?. 允许 options 未传，具体默认值由该工厂处理。
			return createGrepToolDefinition(cwd, options?.grep);
		// 选择 find 的对应工厂，下面只传它自己的 options 字段。
		case "find":
			// 构造 find 的完整定义；?. 允许 options 未传，具体默认值由该工厂处理。
			return createFindToolDefinition(cwd, options?.find);
		// 选择 ls 的对应工厂，下面只传它自己的 options 字段。
		case "ls":
			// 构造 ls 的完整定义；?. 允许 options 未传，具体默认值由该工厂处理。
			return createLsToolDefinition(cwd, options?.ls);
		// 处理运行时越过 TS ToolName 联合类型的未知值；下一行显式抛错。
		default:
			// 处理运行时越过 TypeScript 的非法名字，不能只依赖编译时联合类型。
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

/**
 * 按工具名选择低层 AgentTool 工厂；与 createToolDefinition 相似，但返回的是不依赖会话定义接口的适配工具。
 * 例：独立 new Agent({tools:[createTool("read",cwd)]}) 使用这一路，真正执行发生在模型发出 toolCall 之后。
 */
export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	// 根据名字分派；每个 case 中的 return 直接返回工厂结果，不会落入下一个 case。
	switch (toolName) {
		// 选择 read 的对应工厂，下面只传它自己的 options 字段。
		case "read":
			// 构造 read 的低层适配工具；没有在此调用 execute。
			return createReadTool(cwd, options?.read);
		// 选择 bash 的对应工厂，下面只传它自己的 options 字段。
		case "bash":
			// 构造 bash 的低层适配工具；没有在此调用 execute。
			return createBashTool(cwd, options?.bash);
		// 选择 powershell 的对应工厂，下面只传它自己的 options 字段。
		case "powershell":
			// 选择低层 PowerShell 工厂，返回工具对象，尚未执行用户命令。
			return createPowerShellTool(cwd, options?.powershell);
		// 选择 edit 的对应工厂，下面只传它自己的 options 字段。
		case "edit":
			// 构造 edit 的低层适配工具；没有在此调用 execute。
			return createEditTool(cwd, options?.edit);
		// 选择 write 的对应工厂，下面只传它自己的 options 字段。
		case "write":
			// 构造 write 的低层适配工具；没有在此调用 execute。
			return createWriteTool(cwd, options?.write);
		// 选择 grep 的对应工厂，下面只传它自己的 options 字段。
		case "grep":
			// 构造 grep 的低层适配工具；没有在此调用 execute。
			return createGrepTool(cwd, options?.grep);
		// 选择 find 的对应工厂，下面只传它自己的 options 字段。
		case "find":
			// 构造 find 的低层适配工具；没有在此调用 execute。
			return createFindTool(cwd, options?.find);
		// 选择 ls 的对应工厂，下面只传它自己的 options 字段。
		case "ls":
			// 构造 ls 的低层适配工具；没有在此调用 execute。
			return createLsTool(cwd, options?.ls);
		// 处理运行时越过 TS ToolName 联合类型的未知值；下一行显式抛错。
		default:
			// 处理运行时越过 TypeScript 的非法名字，不能只依赖编译时联合类型。
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

/**
 * 返回默认编码工作所用四种工具定义：read、bash、edit、write，数组顺序保持这里的装配顺序。
 * 输入 cwd/options，输出定义数组；没有激活所有搜索工具，也没有运行任何工具。
 */
export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	// 返回按声明顺序构造的工具数组；新建对象不等于执行其中的 execute。
	return [
		// 向当前组合中加入 read 定义，传递相同会话目录及专属配置。
		createReadToolDefinition(cwd, options?.read),
		// 向当前组合中加入 bash 定义，传递相同会话目录及专属配置。
		createBashToolDefinition(cwd, options?.bash),
		// 向当前组合中加入 edit 定义，传递相同会话目录及专属配置。
		createEditToolDefinition(cwd, options?.edit),
		// 向当前组合中加入 write 定义，传递相同会话目录及专属配置。
		createWriteToolDefinition(cwd, options?.write),
	];
}

/**
 * 返回 read、grep、find、ls 四种只读用途的工具定义；不包含 write/edit/bash。
 * 只读指这些内置能力的用途，不是对整个进程或自定义 operations 施加操作系统沙箱。
 */
export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	// 返回按声明顺序构造的工具数组；新建对象不等于执行其中的 execute。
	return [
		// 向当前组合中加入 read 定义，传递相同会话目录及专属配置。
		createReadToolDefinition(cwd, options?.read),
		// 向当前组合中加入 grep 定义，传递相同会话目录及专属配置。
		createGrepToolDefinition(cwd, options?.grep),
		// 向当前组合中加入 find 定义，传递相同会话目录及专属配置。
		createFindToolDefinition(cwd, options?.find),
		// 向当前组合中加入 ls 定义，传递相同会话目录及专属配置。
		createLsToolDefinition(cwd, options?.ls),
	];
}

/**
 * 一次创建全部内置定义并按 ToolName 建索引；调用者仍需另行决定启用哪些，不能把注册等同于全部暴露给模型。
 * Record<ToolName, ToolDef> 让 TypeScript 要求每个工具名都有一个定义。
 */
export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	// 返回工具名到工厂结果的映射对象。
	return {
		// 以 read 为键保存对应定义，供上层按名字挑选。
		read: createReadToolDefinition(cwd, options?.read),
		// 以 bash 为键保存对应定义，供上层按名字挑选。
		bash: createBashToolDefinition(cwd, options?.bash),
		// 以 powershell 为索引创建完整定义，供会话按名称挑选。
		powershell: createPowerShellToolDefinition(cwd, options?.powershell),
		// 以 edit 为键保存对应定义，供上层按名字挑选。
		edit: createEditToolDefinition(cwd, options?.edit),
		// 以 write 为键保存对应定义，供上层按名字挑选。
		write: createWriteToolDefinition(cwd, options?.write),
		// 以 grep 为键保存对应定义，供上层按名字挑选。
		grep: createGrepToolDefinition(cwd, options?.grep),
		// 以 find 为键保存对应定义，供上层按名字挑选。
		find: createFindToolDefinition(cwd, options?.find),
		// 以 ls 为键保存对应定义，供上层按名字挑选。
		ls: createLsToolDefinition(cwd, options?.ls),
	};
}

/**
 * 创建默认编码用的四个低层 AgentTool；输入 cwd/options，输出 read/bash/edit/write 数组。
 * 这与 definitions 版本的区别是返回接口，不是工作流自动启动。
 */
export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	// 返回按声明顺序构造的工具数组；新建对象不等于执行其中的 execute。
	return [
		// 向当前工具数组加入 read，这里不产生实际工具 I/O。
		createReadTool(cwd, options?.read),
		// 向当前工具数组加入 bash，这里不产生实际工具 I/O。
		createBashTool(cwd, options?.bash),
		// 向当前工具数组加入 edit，这里不产生实际工具 I/O。
		createEditTool(cwd, options?.edit),
		// 向当前工具数组加入 write，这里不产生实际工具 I/O。
		createWriteTool(cwd, options?.write),
	];
}

/**
 * 创建 read/grep/find/ls 低层工具数组供独立 Agent 使用；不在这里请求模型或读取目录。
 * 例：只想构建代码检索 Agent 时，可用此数组作为初始 tools。
 */
export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	// 返回按声明顺序构造的工具数组；新建对象不等于执行其中的 execute。
	return [
		// 向当前工具数组加入 read，这里不产生实际工具 I/O。
		createReadTool(cwd, options?.read),
		// 向当前工具数组加入 grep，这里不产生实际工具 I/O。
		createGrepTool(cwd, options?.grep),
		// 向当前工具数组加入 find，这里不产生实际工具 I/O。
		createFindTool(cwd, options?.find),
		// 向当前工具数组加入 ls，这里不产生实际工具 I/O。
		createLsTool(cwd, options?.ls),
	];
}

/**
 * 返回按工具名索引的全部低层工具；Record 要求键集合完整，实际启用集合由上层选择。
 * 例：const read = createAllTools(cwd).read 取得一个工具对象，调用 execute 才读取文件。
 */
export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	// 返回工具名到工厂结果的映射对象。
	return {
		// 以 read 为键保存低层工具对象，调用方可按需提取。
		read: createReadTool(cwd, options?.read),
		// 以 bash 为键保存低层工具对象，调用方可按需提取。
		bash: createBashTool(cwd, options?.bash),
		// 以 powershell 为索引创建低层工具对象。
		powershell: createPowerShellTool(cwd, options?.powershell),
		// 以 edit 为键保存低层工具对象，调用方可按需提取。
		edit: createEditTool(cwd, options?.edit),
		// 以 write 为键保存低层工具对象，调用方可按需提取。
		write: createWriteTool(cwd, options?.write),
		// 以 grep 为键保存低层工具对象，调用方可按需提取。
		grep: createGrepTool(cwd, options?.grep),
		// 以 find 为键保存低层工具对象，调用方可按需提取。
		find: createFindTool(cwd, options?.find),
		// 以 ls 为键保存低层工具对象，调用方可按需提取。
		ls: createLsTool(cwd, options?.ls),
	};
}
