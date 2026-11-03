/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers only adapt tool execution so extension tools receive the runner context.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createToolContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	// 中文工具链：把注册条目里的 ToolDefinition 适配成 AgentTool，并传一个创建执行上下文的回调。
	return wrapToolDefinition(registeredTool.definition, (toolCallId, signal) =>
		// 等工具真的被执行才创建 ctx，其中包含 cwd、model、嵌套工具调用等会话能力。
		runner.createToolContext(toolCallId, signal),
	);
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createToolContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	// map 把每个注册条目变成一个可执行工具；这一阶段只接线，不读取文件、不调用模型。
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
