// 内置工具显示入口，只汇总渲染器；交互/导出可据工具名取显示方法，无需导入实际执行器/schema。
/**
 * Built-in tool renderers, without the tools themselves.
 *
 * A presentation displays tool calls and results; it does not execute them and does not need their
 * typebox parameter schemas. Importing this instead of `core/tools/index.ts` keeps ~17 MB of module
 * graph out of a process that only renders.
 */

// ToolRenderers 只含外框与调用/结果显示方法，纯类型导入不会加载执行链。
import type { ToolRenderers } from "../../extensions/types.ts";
// 内置工具名联合类型；虽来自工具总入口，import type 编译后擦除，不引入该入口的运行时依赖。
import type { ToolName } from "../index.ts";
// bash/PowerShell 共同显示工厂，按提示符区分标题。
import { createShellRenderers } from "./bash.ts";
// edit 的预览及最终 diff 渲染器。
import { editRenderers } from "./edit.ts";
// find 文件名搜索展示。
import { findRenderers } from "./find.ts";
// grep 内容搜索展示。
import { grepRenderers } from "./grep.ts";
// ls 目录列表展示。
import { lsRenderers } from "./ls.ts";
// read 路径分类/正文展示。
import { readRenderers } from "./read.ts";
// write 参数正文和错误展示。
import { writeRenderers } from "./write.ts";

// 重导出显示契约类型，便于只做展示的调用者使用。
export type { ToolRenderers };

// 下面值导出供其他模块直接选取显示方法，不在这里执行工具。
export {
	// 重导出 shell 提示符显示工厂。
	createShellRenderers,
	// 重导出 edit 预览显示对象。
	editRenderers,
	// 重导出 find 显示对象。
	findRenderers,
	// 重导出 grep 显示对象。
	grepRenderers,
	// 重导出 ls 显示对象。
	lsRenderers,
	// 重导出 read 显示对象。
	readRenderers,
	// 重导出 write 显示对象。
	writeRenderers,
};

/** Renderers for every built-in tool, keyed by tool name. */
// 创建全部内置工具名到显示方法的字典，无参数，返回新外层对象；为两种shell分别创建显示方法对象，其他显示对象复用，不执行命令。
// 例如取表中的powershell，调用标题用PS>；Record<ToolName,...>在编译期要求内置名称齐全。
export function createAllToolRenderers(): Record<ToolName, ToolRenderers> {
	// 返回字典字面量，键是执行工具名。
	return {
		// read 复用文件读取显示对象。
		read: readRenderers,
		// 为 bash 创建闭包，显示 $ 提示符，不启动 shell。
		bash: createShellRenderers("$"),
		// PowerShell 同样使用 shell 渲染实现，只换成 PS> 标题。
		powershell: createShellRenderers("PS>"),
		// edit 复用预览/diff 显示对象。
		edit: editRenderers,
		// write 复用文件正文显示对象。
		write: writeRenderers,
		// grep 使用搜索结果显示。
		grep: grepRenderers,
		// find 使用文件名列表显示。
		find: findRenderers,
		// ls 使用目录列表显示。
		ls: lsRenderers,
	};
}

/**
 * Merge built-in renderers into a tool definition that does not supply its own.
 *
 * `ToolExecutionComponent` used to do this lookup itself, which forced every presentation to import
 * the tool implementations. Callers do it now, so a process that renders can import renderers alone.
 */
// 为工具显示定义补齐缺失的内置调用/结果槽。输入任意工具名和可选定义，返回原定义、内置对象或合并副本；不注册、不执行工具。
// 例如自定义 read 仅给 renderCall，renderResult 从内置补齐；renderShell 只保留 definition 自身，不会额外从内置补。
export function withBuiltInRenderers<TDefinition extends ToolRenderers>(
	// 名称运行时可任意字符串，不保证属于内置联合。
	toolName: string,
	// 泛型保留调用方定义上的额外字段，undefined 表示没有自定义定义。
	definition: TDefinition | undefined,
	// 联合返回值反映三条分支，未知工具且没定义时可为 undefined。
): TDefinition | ToolRenderers | undefined {
	// 构造内置表后按名取项，as ToolName 只允许 TS 索引，不会把未知名称变合法或自动验证名称。
	const builtIn = createAllToolRenderers()[toolName as ToolName];
	// 没有传自定义定义，直接返回对应内置对象，未知名则 undefined。
	if (!definition) return builtIn;
	// 非内置名没有后备，原定义原样返回。
	if (!builtIn) return definition;
	// 两边都存在时新建浅合并对象。
	return {
		// 先保留定义自身所有可枚举字段，包括 execute（若调用方传了完整定义）；这里不调用这些函数。
		...definition,
		// 仅 null/undefined 调用槽回退内置；已有函数优先。
		renderCall: definition.renderCall ?? builtIn.renderCall,
		// 结果槽独立做同样回退，不能因提供了一个槽就丢掉另一个。
		renderResult: definition.renderResult ?? builtIn.renderResult,
	};
}
