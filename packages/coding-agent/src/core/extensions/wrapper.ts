// 把已注册的工具定义适配成 Agent 可执行的工具，并在执行时提供扩展上下文。
/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers only adapt tool execution so extension tools receive the runner context.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

// AgentTool 是低层循环需要的类型；type 导入在运行时擦除。
import type { AgentTool } from "@earendil-works/pi-agent-core";
// 通用适配器负责转发 execute 参数，本文件补“从哪里得到 ctx”。
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
// 扩展运行器知道当前会话、模型和工具上下文应怎样建立。
import type { ExtensionRunner } from "./runner.ts";
// 注册条目包含工具定义及来源信息；此处使用其中的 definition。
import type { RegisteredTool } from "./types.ts";

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createToolContext() for consistent context across tools and event handlers.
 */
/**
 * 将一个注册条目变成 AgentTool，保留工具定义并提供延迟创建上下文的函数。
 * 输入是注册条目与本会话的扩展运行器，返回适配工具；创建阶段不执行工具。
 * 例：注册 read 后，模型真正调用 read 时，execute 的转发层才按调用 id 建 ctx，再读文件。
 * 工具前置/后置拦截由 AgentSession 的钩子管理，这个函数只接适配关系。
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	// 把注册条目里的 ToolDefinition 适配成 AgentTool，并传一个创建执行上下文的回调。
	return wrapToolDefinition(registeredTool.definition, (toolCallId, signal) =>
		// 等工具真的被执行才创建 ctx，其中包含 cwd、model、嵌套工具调用等会话能力。
		runner.createToolContext(toolCallId, signal),
	);
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createToolContext() for consistent context across tools and event handlers.
 */
/**
 * 保持注册顺序，将一批条目逐个适配成 AgentTool；空数组得到空数组。
 * 同一 runner 被所有上下文工厂引用，但真正的 ctx 在各次执行需要时创建。
 * 例：[read 定义, write 定义] 变成两个可供 Agent 按名字查找的执行对象，不立即读取或写入文件。
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	// map 把每个注册条目变成一个可执行工具；这一阶段只接线，不读取文件、不调用模型。
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
