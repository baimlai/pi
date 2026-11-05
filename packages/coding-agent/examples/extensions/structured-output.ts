/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是“终止型工具结果”。
 * 上游：宿主加载扩展后，模型在需要机器可读最终答案时调用 structured_output；下游：工具
 * 返回 content + details + terminate:true，Agent 循环看到 terminate 后不再发起一次额外的
 * 后续模型请求。示例本身不写文件、不发网络请求；是否产生模型费用取决于这次工具调用。
 *
 * 演示的机制：普通工具结果会让模型继续生成一条总结回复；terminate:true 表示这次工具
 * 结果就是本轮的最终输出，从而省掉一次 follow-up 模型调用。promptSnippet 与
 * promptGuidelines 让模型知道何时、如何调用；renderResult 决定 TUI 中结果的样式。
 *
 * 能力清单：
 * - StructuredOutputDetails：details 的业务结构（标题、摘要、行动项）。
 * - structuredOutputTool：defineTool 定义的工具，参数为 headline/summary/actionItems。
 * - 默认导出：注册该工具，返回 void。
 *
 * 典型运行顺序：加载扩展 -> 用户要求“给出结构化结果” -> 模型调用 structured_output ->
 * TUI 显示格式化结果 -> 本轮结束，不再生成额外助手回合。
 *
 * 示例（真实签名）：
 *   structuredOutputTool.execute(id, {
 *     headline: "Release ready", summary: "All checks pass.", actionItems: ["tag v1"],
 *   }, signal, onUpdate, ctx);  // 真实运行时由工具管线调用，不直接手写
 *
 * 建议阅读顺序：先看 ToolDefinition 字段（name/description/promptSnippet/parameters），
 * 再看 execute 返回值中的 terminate，最后看 renderResult 如何按 details 绘制。
 *
 * 前置条件：交互或非交互会话均可；renderResult 只在有 TUI 时可见，模型仍能读取 content。
 */

/**
 * Structured Output Tool
 *
 * Demonstrates `terminate: true` so the agent can end on a tool call
 * without paying for an extra follow-up LLM turn.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// 这是 details 的编译期结构声明；运行时不校验，写入方和读取方按约定使用同一形状。
interface StructuredOutputDetails {
	// 结果短标题。
	headline: string;
	// 一段摘要文字。
	summary: string;
	// 行动项字符串数组。
	actionItems: string[];
}

// defineTool 只把对象原样返回并保留由 schema 推导的 params 类型；它不注册、不执行。
const structuredOutputTool = defineTool({
	name: "structured_output",
	label: "Structured Output",
	description:
		"Return a final structured answer. Use this as your last action when the user asks for structured output or a machine-readable summary.",
	promptSnippet: "Emit a final structured answer as a terminating tool result",
	promptGuidelines: [
		"Use structured_output as your final action when the user asks for structured output, JSON-like output, or a machine-readable summary.",
		"After calling structured_output, do not emit another assistant response in the same turn.",
	],
	// Type.Object/Type.String/Type.Array 构成 TypeBox 运行时 schema；工具管线据此校验模型参数。
	parameters: Type.Object({
		// 每题字段的 description 会进入模型可见的 JSON schema。
		headline: Type.String({ description: "Short title for the result" }),
		summary: Type.String({ description: "One-paragraph summary" }),
		actionItems: Type.Array(Type.String(), { description: "Concrete next steps or key bullets" }),
	}),

	// execute 由工具管线调用；本次示例不使用调用 ID、取消信号、进度回调和上下文，因此写成 _ 前缀参数。
	async execute(_toolCallId, params) {
		// 返回对象同时满足 AgentToolResult 结构：content 给模型，details 给渲染器。
		return {
			// 模型看到的确认文本；真正结构化数据在 details 中。
			content: [{ type: "text", text: `Saved structured output: ${params.headline}` }],
			// satisfies 只做编译期形状检查，不改变返回对象的运行时值。
			details: {
				headline: params.headline,
				summary: params.summary,
				actionItems: params.actionItems,
			} satisfies StructuredOutputDetails,
			// 关键：告诉 Agent 循环这是最终结果，无需再请求一次助手回复。
			terminate: true,
		};
	},

	// renderResult 只影响 TUI 显示；options 本次未用，theme 用于上色。
	renderResult(result, _options, theme) {
		// details 在类型上是 unknown，需要 as 断言；这里没有运行时形状校验，缺失时走下面的兜底。
		const details = result.details as StructuredOutputDetails | undefined;
		// 没有 details 时退回显示第一个文本块，保持可用。
		if (!details) {
			// content 是内容块数组，[0] 可能是 undefined；?. 与三元表达式一起处理。
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		}

		// 组装多行展示：标题加粗、摘要正文、空行、编号行动项。
		const lines = [
			theme.fg("toolTitle", theme.bold(details.headline)),
			theme.fg("text", details.summary),
			"",
			// 展开数组再 map：每个行动项转成 "1. xxx" 的暗色行。
			...details.actionItems.map((item, index) => theme.fg("muted", `${index + 1}. ${item}`)),
		];
		// Text(内容, paddingX, paddingY)：这里左右和上下内边距都是 0。
		return new Text(lines.join("\n"), 0, 0);
	},
});

// 扩展入口：只注册定义好的工具；注册本身不执行工具，模型调用时才进入 execute。
export default function (pi: ExtensionAPI) {
	pi.registerTool(structuredOutputTool);
}
