/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是“手动总结会话”。
 * 上游：用户输入 /summarize 触发命令。下游：ctx.sessionManager.getBranch() 读取当前分支
 * 消息；ctx.modelRegistry.find("openai", "gpt-5.2")/hasConfiguredAuth()/complete() 发起
 * 一次真实模型调用；ctx.ui.custom() 用 Markdown 组件展示摘要。
 *
 * 演示的机制：扩展可以自己拼一段“总结提示词”，把当前会话的纯文本与工具调用描述发给
 * 指定模型，再把助手回复渲染成可滚动的 TUI 面板。它不会写入会话历史，也不会替换正式
 * 的自动压缩摘要。
 *
 * 能力清单：
 * - ContentBlock/SessionEntry：只读输入的最小结构声明。
 * - extractTextParts(content)：从字符串或内容块数组提取文本。
 * - extractToolCallLines(content)：把工具调用转成一行描述。
 * - buildConversationText(entries)：把 user/assistant 消息按顺序拼成纯文本。
 * - buildSummaryPrompt(conversationText)：生成带 <conversation> 包裹的提示词。
 * - showSummaryUi(summary, ctx)：TUI 中显示 Markdown 摘要，Enter/Esc 关闭。
 * - 默认导出：注册 /summarize 命令，串联以上步骤。
 *
 * 典型运行顺序：加载扩展 -> 在 gpt-5.2 已配置认证的会话里输入 /summarize -> 提示
 * "Preparing summary..." -> 等待模型 -> 弹窗显示摘要。未找到模型/未配置认证时只提示，
 * 不发起请求。
 *
 * 示例（真实签名）：
 *   const model = ctx.modelRegistry.find("openai", "gpt-5.2"); // Model | undefined
 *   const response = await ctx.modelRegistry.complete(model, { messages }, options);
 *   示例硬编码了模型名；真实使用时可改成 ctx.model 或读取设置。
 *
 * 建议阅读顺序：先看三个提取/拼接函数，再看 showSummaryUi，最后看命令处理器中的查找
 * 模型、调用 complete、提取回复文本。
 *
 * 前置条件：需要 openai/gpt-5.2 的认证；调用模型会产生网络请求与费用。非 TUI 模式不
 * 显示摘要面板，但命令仍会执行（showSummaryUi 提前返回）。
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";

// 内容块的最小只读视图；字段都可选，因为输入来自运行时 unknown，不能假设形状。
type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

// 会话条目的最小视图：只关心 type 与 message.role/content。
type SessionEntry = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

// 从 unknown 的 content 中提取文本：兼容纯字符串与内容块数组两种历史格式。
const extractTextParts = (content: unknown): string[] => {
	// 旧消息可能直接存字符串。
	if (typeof content === "string") {
		return [content];
	}

	// 非数组且非字符串的输入无法解释，返回空数组而不是抛错。
	if (!Array.isArray(content)) {
		return [];
	}

	const textParts: string[] = [];
	for (const part of content) {
		// 跳过 null/非对象元素；这是对 unknown 的运行时形状检查。
		if (!part || typeof part !== "object") {
			continue;
		}

		// 断言为最小结构后检查字段；只有 type==="text" 且 text 是字符串才收集。
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text);
		}
	}

	return textParts;
};

// 把助手消息中的工具调用转成一行描述，便于总结时知道发生过什么。
const extractToolCallLines = (content: unknown): string[] => {
	// 只有数组可能包含 toolCall 块。
	if (!Array.isArray(content)) {
		return [];
	}

	const toolCalls: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}

		const block = part as ContentBlock;
		// 只收集 name 为字符串的 toolCall 块。
		if (block.type !== "toolCall" || typeof block.name !== "string") {
			continue;
		}

		// arguments 可能缺失；?? 选择空对象保证 JSON.stringify 有输入。
		const args = block.arguments ?? {};
		// JSON.stringify 不保证键顺序；参数值可能含敏感信息，摘要会发给模型。
		toolCalls.push(`Tool ${block.name} was called with args ${JSON.stringify(args)}`);
	}

	return toolCalls;
};

// 按时间顺序拼接当前分支的 user/assistant 文本与工具调用描述。
const buildConversationText = (entries: SessionEntry[]): string => {
	const sections: string[] = [];

	for (const entry of entries) {
		// 跳过非消息条目，以及没有 message/role 的残缺条目。
		if (entry.type !== "message" || !entry.message?.role) {
			continue;
		}

		const role = entry.message.role;
		// 只总结用户与助手两种角色；工具结果/系统消息不纳入。
		const isUser = role === "user";
		const isAssistant = role === "assistant";

		if (!isUser && !isAssistant) {
			continue;
		}

		const entryLines: string[] = [];
		const textParts = extractTextParts(entry.message.content);
		if (textParts.length > 0) {
			// 角色标签用英文，保持提示词与模型输入一致。
			const roleLabel = isUser ? "User" : "Assistant";
			// 多个文本块用换行连接，再 trim 去掉两端空白。
			const messageText = textParts.join("\n").trim();
			if (messageText.length > 0) {
				entryLines.push(`${roleLabel}: ${messageText}`);
			}
		}

		// 只有助手消息才可能带工具调用。
		if (isAssistant) {
			// 展开数组再 push，把多行追加到同一段。
			entryLines.push(...extractToolCallLines(entry.message.content));
		}

		// 空消息段不加入，避免多余的空白分隔。
		if (entryLines.length > 0) {
			sections.push(entryLines.join("\n"));
		}
	}

	// 不同消息之间空一行。
	return sections.join("\n\n");
};

// 组装发给模型的提示词；<conversation> 标签让模型清楚内容边界。
const buildSummaryPrompt = (conversationText: string): string =>
	[
		"Summarize this conversation so I can resume it later.",
		"Include goals, key decisions, progress, open questions, and next steps.",
		"Keep it concise and structured with headings.",
		"",
		"<conversation>",
		conversationText,
		"</conversation>",
		// 数组 join("\n") 比多行模板字符串更容易控制行尾。
	].join("\n");

// 在 TUI 中展示摘要：动态边框 + Markdown + 关闭提示。
const showSummaryUi = async (summary: string, ctx: ExtensionCommandContext) => {
	// 非 TUI 模式直接返回，不显示面板。
	if (ctx.mode !== "tui") {
		return;
	}

	// custom 返回 Promise，直到 done() 被调用；这里不返回具体结果。
	await ctx.ui.custom((_tui, theme, _kb, done) => {
		const container = new Container();
		// DynamicBorder 接收着色函数，给整条边框上 accent 色。
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		// Markdown 主题负责标题、列表、代码块等样式。
		const mdTheme = getMarkdownTheme();

		// 子组件按加入顺序纵向排列：上边框、标题、正文、提示、下边框。
		container.addChild(border);
		container.addChild(new Text(theme.fg("accent", theme.bold("Conversation Summary")), 1, 0));
		container.addChild(new Markdown(summary, 1, 1, mdTheme));
		container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0));
		container.addChild(border);

		// 最小 Component 实现：渲染/失效委托给 container，按键只处理关闭。
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				// enter 与 escape 都结束等待；done 参数类型由 custom 泛型推断为 void。
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
					done(undefined);
				}
			},
		};
	});
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("summarize", {
		description: "Summarize the current conversation in a custom UI",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			const conversationText = buildConversationText(branch);

			if (!conversationText.trim()) {
				if (ctx.hasUI) {
					ctx.ui.notify("No conversation text found", "warning");
				}
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.notify("Preparing summary...", "info");
			}

			const model = ctx.modelRegistry.find("openai", "gpt-5.2");
			if (!model) {
				if (ctx.hasUI) ctx.ui.notify("Model openai/gpt-5.2 not found", "warning");
				return;
			}
			if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
				if (ctx.hasUI) ctx.ui.notify("No authentication configured for openai/gpt-5.2", "warning");
				return;
			}

			const summaryMessages = [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: buildSummaryPrompt(conversationText) }],
					timestamp: Date.now(),
				},
			];

			const response = await ctx.modelRegistry.complete(
				model,
				{ messages: summaryMessages },
				{
					reasoningEffort: "high",
					cacheRetention: "none",
					sessionId: uuidv7(),
				},
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			await showSummaryUi(summary, ctx);
		},
	});
}
