// 工具定义与低层 AgentTool 的适配层；它转发参数并补 ctx，不负责文件读写，也不替代 Agent 的参数校验。
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import type { ExtensionToolContext, ToolDefinition } from "../extensions/types.ts";

/**
 * An `AgentTool` with a TypeBox parameter schema whose `execute` and `prepareArguments` are typed by TypeBox's
 * `Static`, as the built-in tools are (pi-agent-core types `params` through pi-schema, which maps only the common
 * TypeBox kinds). Spreads into a `ToolDefinition` of the same schema.
 */
// 泛型 TParams 约束为 TypeBox schema，TDetails 描述详情；Omit 从原 AgentTool 中拿掉两项后在下方重写类型。
export type TypeBoxAgentTool<TParams extends TSchema = TSchema, TDetails = any> = Omit<
	// 基础类型仍保留 name、description、参数 schema 和执行策略等其他字段。
	AgentTool<TParams, TDetails>,
	// 用字面量联合类型指定要移除的两个键，避免它们原先的参数推导与 TypeBox 不一致。
	"prepareArguments" | "execute"
	// & 是交叉类型：剩余基础字段加上下方重新声明的两个函数。
> & {
	// 可选输入整理函数接未知 JSON，返回由 TypeBox Static 推导的参数形状；仍需实际 schema 校验。
	prepareArguments?: (args: unknown) => Static<TParams>;
	// 声明函数属性的签名；这里没有函数实现，不会启动任何工作。
	execute: (
		// 每次调用的关联 id，供事件和工具结果配对。
		toolCallId: string,
		// Static 从 TypeBox schema 推导具体参数，例如 read 的 path/offset/limit。
		params: Static<TParams>,
		// 可选取消信号，工具实现需要自己观察或向 I/O 继续传递。
		signal?: AbortSignal,
		// 可选的部分结果回调，详情类型与最终结果保持一致。
		onUpdate?: AgentToolUpdateCallback<TDetails>,
		// 执行异步完成后返回工具内容与详情；类型本身不实施运行时校验。
	) => Promise<AgentToolResult<TDetails>>;
};

/** Creates the context for one tool call. */
// 函数类型别名：根据本次 id/取消信号创建执行上下文，可能包含 cwd、model 和嵌套工具能力。
export type ToolContextFactory = (toolCallId: string, signal: AbortSignal | undefined) => ExtensionToolContext;

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
/**
 * 把包含 ctx 的 ToolDefinition 转成 AgentTool；输入定义和可选上下文工厂，返回一份转发对象，无文件副作用。
 * 执行时先用显式 ctx，否则调用 ctxFactory(id, signal)，再转交 definition.execute；直接调用返回工具不自动做 schema 校验。
 * 例：read 定义可以依靠 ctxFactory 得到会话 cwd；低层 Agent 正常工具管线会在执行之前校验参数。
 */
export function wrapToolDefinition<TDetails = unknown>(
	// 工具定义含描述、参数 schema 和真正的 execute，例如 createReadToolDefinition() 返回的对象。
	definition: ToolDefinition<any, TDetails>,
	// 可选函数：每次执行时按 toolCallId 和取消信号创建 ctx，而不是永久固定一份上下文。
	// 可选回调共享给每个工具，但每次执行时才获取本次 ctx。
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
				// 标准 Agent 工具管线在转发前会校验参数；直接调用此适配器时，调用者应自行保证参数符合 schema。
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
/**
 * 批量适配工具定义；输入数组和可选 ctx 工厂，返回同顺序的 AgentTool 数组。
 * 例：[readDefinition, writeDefinition] 被 map 成两份可供 Agent 调用的工具对象；不在这里执行它们。
 */
export function wrapToolDefinitions(
	// 这里接受参数 schema/详情各不相同的定义数组；已有 any 是此异构接口的原始设计。
	definitions: ToolDefinition<any, any>[],
	// 可选回调共享给每个工具，但每次执行时才获取本次 ctx。
	ctxFactory?: ToolContextFactory,
): AgentTool<any>[] {
	// map 保持顺序，逐一调用上面的单工具适配器。
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
/**
 * 为宿主传来的普通 AgentTool 合成最小 ToolDefinition，使会话内部仍统一按“定义”管理工具。
 * 复制名字/schema/执行策略，execute 直接转发；返回定义没有原工具缺失的 renderer 或提示词信息。
 * 例：自定义 AgentTool echo 通过 baseToolsOverride 进入 AgentSession 时使用这里。
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		// 复制工具调用名，不重命名模型可见能力。
		name: tool.name,
		// 复制 UI 展示名。
		label: tool.label,
		// 保留工具用途说明，不改变模型提示。
		description: tool.description,
		// 运行时 schema 对象原样传递；as any 只解决两层通用类型表达不一致，不转换对象。
		parameters: tool.parameters as any,
		// 保留程序化输出 schema，若原工具没声明则为 undefined。
		outputSchema: tool.outputSchema,
		// 保留给供应商的结构化参数生成偏好。
		constrainedSampling: tool.constrainedSampling,
		// 保留原输入整理函数，后续 Agent 管线按同样顺序调用。
		prepareArguments: tool.prepareArguments,
		// 保留串行/并行要求，避免适配后改变一批工具的执行顺序。
		executionMode: tool.executionMode,
		// 转发函数不使用 ToolDefinition 的额外 ctx；原 AgentTool 接口没有这个位置。
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
