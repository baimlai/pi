import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import type { ExtensionToolContext, ToolDefinition } from "../extensions/types.ts";

/**
 * An `AgentTool` with a TypeBox parameter schema whose `execute` and `prepareArguments` are typed by TypeBox's
 * `Static`, as the built-in tools are (pi-agent-core types `params` through pi-schema, which maps only the common
 * TypeBox kinds). Spreads into a `ToolDefinition` of the same schema.
 */
export type TypeBoxAgentTool<TParams extends TSchema = TSchema, TDetails = any> = Omit<
	AgentTool<TParams, TDetails>,
	"prepareArguments" | "execute"
> & {
	prepareArguments?: (args: unknown) => Static<TParams>;
	execute: (
		toolCallId: string,
		params: Static<TParams>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
};

/** Creates the context for one tool call. */
export type ToolContextFactory = (toolCallId: string, signal: AbortSignal | undefined) => ExtensionToolContext;

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	// 工具定义含描述、参数 schema 和真正的 execute，例如 createReadToolDefinition() 返回的对象。
	definition: ToolDefinition<any, TDetails>,
	// 可选函数：每次执行时按 toolCallId 和取消信号创建 ctx，而不是永久固定一份上下文。
	ctxFactory?: ToolContextFactory,
): AgentTool<any, TDetails> {
	// 返回低层 Agent 认识的工具形状；下面大部分字段只是从原定义透传。
	return {
		// 用来匹配模型给出的工具名，例如 read。
		name: definition.name,
		// 界面展示名。
		label: definition.label,
		// 给模型看的工具用途说明。
		description: definition.description,
		// Agent 按这份 schema 校验模型发来的 JSON 参数。
		parameters: definition.parameters,
		// 给程序调用者的结构化结果形状。
		outputSchema: definition.outputSchema,
		// 模型生成参数时能否使用严格 JSON schema 等约束。
		constrainedSampling: definition.constrainedSampling,
		// 如有需要，先整理参数形状，再由 Agent 按 parameters 校验。
		prepareArguments: definition.prepareArguments,
		// 工具是否要求串行；会影响同一 assistant 回答中的整批调用。
		executionMode: definition.executionMode,
		// 保存一段转发函数。Agent 调用它时才继续进入下面的 definition.execute。
		execute: (toolCallId, params, signal, onUpdate, ctx?: ExtensionToolContext) =>
			// 这里最终进入具体工具实现，例如 read.ts 中 async execute(...)。
			definition.execute(
				// 原样传递 id，便于调用与结果配对。
				toolCallId,
				// 参数已经经过 Agent 的运行时 schema 校验。
				params,
				// 取消信号继续传给实际文件读取等操作。
				signal,
				// 工具可以用此回调发布执行进度；read 通常一次返回结果。
				onUpdate,
				// 显式 ctx 优先；没有时才调用工厂。as 是类型断言，不会在运行时创造 ctx。
				ctx ?? (ctxFactory?.(toolCallId, signal) as ExtensionToolContext),
			),
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: ToolContextFactory,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		outputSchema: tool.outputSchema,
		constrainedSampling: tool.constrainedSampling,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
