// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；用 `pi --extension examples/extensions/custom-compaction.ts` 加载。
// 演示内容：接管 session_before_compact，用另一个模型（google/gemini-2.5-flash）把待压缩消息总结成一份摘要，替代宿主默认压缩。
// 上下游：宿主在手动 /compact、上下文阈值或溢出恢复时触发事件；处理器读取 preparation，调用 ctx.modelRegistry.find/complete，把 {compaction} 返回给会话层；sessionManager 再负责追加 entry。失败/缺少模型时返回 undefined，让宿主执行默认压缩。
// 能力清单：
// - 默认导出 (pi: ExtensionAPI) => void：注册压缩前处理器；加载时不请求模型。
// - session_before_compact 回调：选择模型、合并 messagesToSummarize/turnPrefixMessages、序列化对话、构造摘要提示、调用模型、过滤文本并返回 CompactionResult。
// 典型运行顺序：/compact 或达到阈值 -> 回调提示已触发 -> 找到 Gemini Flash -> 序列化全部待压缩消息 -> 一次 complete 请求 -> 返回摘要和 firstKeptEntryId -> 会话层追加 compaction entry。
// 示例（真实签名）：
//   pi --extension ./examples/extensions/custom-compaction.ts
//   // /compact 后如已配置 Google provider，会看到摘要请求与 "Custom compaction: summarizing ..." 提示
// 测试引用：packages/coding-agent/test/compaction-extensions-example.test.ts（mock provider，验证 complete 调用与返回的 compaction）。
// 阅读顺序：先看事件解构和模型选择，再看消息合并/序列化与提示词，最后看 complete 调用、空摘要和错误回退。
// 前置与副作用：需要已注册且已认证的 Google provider/model，否则警告并回退；压缩会产生一次真实的模型请求和费用。signal 透传给请求，取消时可能返回 aborted 回复。示例不检查 response.stopReason：若被中止的回复仍含非空文本，可能被当作有效摘要。catch 只提示错误并回退，不抛出。返回的 firstKeptEntryId 会保留宿主指定的近期尾部，英文文件头“丢弃全部旧轮”的说法并不完全准确。
/**
 * Custom Compaction Extension
 *
 * Replaces the default compaction behavior with a full summary of the entire context.
 * Instead of keeping the last 20k tokens of conversation turns, this extension:
 * 1. Summarizes ALL messages (messagesToSummarize + turnPrefixMessages)
 * 2. Discards all old turns completely, keeping only the summary
 *
 * This example also demonstrates using a different model (Gemini Flash) for summarization,
 * which can be cheaper/faster than the main conversation model.
 *
 * Usage:
 *   pi --extension examples/extensions/custom-compaction.ts
 */

// uuidv7 生成按时间有序的请求 ID；这里作为 complete 的 sessionId，不用于持久会话文件。
import { uuidv7 } from "@earendil-works/pi-ai";
// import type 只引入类型，编译后擦除；ExtensionAPI 用于标注扩展入口。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// convertToLlm 把 AgentMessage 转成模型可读消息；serializeConversation 再把它压成带角色标记的文本。
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

// 扩展入口：注册 session_before_compact 处理器；加载时不请求模型。
// 处理器返回 {compaction} 提供摘要，返回 undefined 则让宿主执行默认压缩。
// 示例：/compact 时用 google/gemini-2.5-flash 总结全部待压缩消息；缺少该模型则警告并回退。
export default function (pi: ExtensionAPI) {
	// session_before_compact 在压缩实际发生前触发；事件携带 preparation、当前分支原始条目和取消信号。
	pi.on("session_before_compact", async (event, ctx) => {
		// 每次进入回调都提示，便于区分自定义摘要是否生效；这是 UI 副作用，不影响压缩结果。
		ctx.ui.notify("Custom compaction extension triggered", "info");

		// preparation 是宿主算好的压缩材料；branchEntries 这里不用，用 _ 别名表示忽略；signal 用于取消模型请求。
		const { preparation, branchEntries: _, signal } = event;
		// messagesToSummarize 是会被摘要替代的旧轮消息，turnPrefixMessages 是切断轮次的前半段；tokensBefore 是压缩前估算。
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

		// modelRegistry.find 只查注册表，返回 Model<Api> | undefined；不保证该 provider 已认证。
		// Use Gemini Flash for summarization (cheaper/faster than most conversation models)
		// 固定选择 Google 的 Gemini Flash；如果项目没有该 provider/model，就回退。
		const model = ctx.modelRegistry.find("google", "gemini-2.5-flash");
		// 找不到模型时警告并结束，返回 undefined 让宿主走默认压缩。
		if (!model) {
			ctx.ui.notify(`Could not find Gemini Flash model, using default compaction`, "warning");
			return;
		}

		// 展开两个数组生成新数组；顺序保持宿主给的旧消息在前、轮次前缀在后。
		// Combine all messages for full summary
		// 这里没有按 token 截断；消息很多时请求会很大，成本由所用模型承担。
		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

		// 通知包含消息数、估算 token 和模型 id；toLocaleString 只影响数字展示。
		ctx.ui.notify(
			`Custom compaction: summarizing ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens) with ${model.id}...`,
			"info",
		);

		// convertToLlm 转换 AgentMessage（例如工具消息变成 provider 可读形式），serializeConversation 再转成纯文本。
		// Convert messages to readable text format
		// 这一步有损：思考块、图片等不会完整保留，摘要模型只看到序列化后的文本。
		const conversationText = serializeConversation(convertToLlm(allMessages));

		// previousSummary 是上一次压缩留下的摘要；存在时作为额外上下文拼进提示，帮助增量更新。
		// Include previous summary context if available
		// 条件表达式生成前置说明；previousSummary 为空时为空串。
		const previousContext = previousSummary ? `\n\nPrevious session summary for context:\n${previousSummary}` : "";

		// 只构造一条 user 消息；所有摘要要求都写在正文里，没有额外的 system 消息。
		// Build messages that ask for a comprehensive summary
		// 数组元素用 as const 固定 role/content 的字面量类型；timestamp 是毫秒数，不是 ISO 字符串。
		const summaryMessages = [
			{
				// role: "user" 表示这是用户输入；模型会把它当作摘要指令，而不是系统指令。
				role: "user" as const,
				// content 是文本块数组，与 provider 的消息格式一致；type: "text" 也是字面量。
				content: [
					{
						type: "text" as const,
						// text 是摘要提示词模板；${previousContext} 和 ${conversationText} 在运行时插入，模板内容本身不能加注释。
						text: `You are a conversation summarizer. Create a comprehensive summary of this conversation that captures:${previousContext}

1. The main goals and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file modifications, or technical details
4. Current state of any ongoing work
5. Any blockers, issues, or open questions
6. Next steps that were planned or suggested

Be thorough but concise. The summary will replace the ENTIRE conversation history, so include all information needed to continue the work effectively.

Format the summary as structured markdown with clear sections.

<conversation>
${conversationText}
</conversation>`,
					},
				],
				timestamp: Date.now(),
			},
		];

		// 从这里开始是唯一的模型调用与错误边界；请求失败会回退到默认压缩。
		try {
			// signal 来自宿主压缩流程；用户取消时 complete 可能以 aborted 结束。
			// Pass signal to honor abort requests (e.g., user cancels compaction)
			// complete 使用解析好的 model/auth，返回 AssistantMessage；这里不流式输出。
			const response = await ctx.modelRegistry.complete(
				model,
				// 只传 messages，不传 systemPrompt/tools；摘要请求是独立的单轮对话。
				{ messages: summaryMessages },
				{
					// 最多生成 8192 token；实际摘要仍受模型自身上限约束。
					maxTokens: 8192,
					// 取消信号透传；abort 时请求可能 reject 或返回 stopReason "aborted"。
					signal,
					// 明确不使用缓存保留策略；具体含义由 provider 适配层决定。
					cacheRetention: "none",
					// 每个请求生成新的 uuidv7；用于请求标识/日志，不等于持久会话 id。
					sessionId: uuidv7(),
				},
			);

			// 只保留 text 块并拼接；类型谓词只做编译期收窄，运行时只比较 c.type；思考块、工具调用等不会进入摘要。
			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			// 空白摘要视为失败；如果已取消则不再提示，否则警告后回退。
			if (!summary.trim()) {
				// signal.aborted 是只读布尔值；取消时不重复打扰用户。
				if (!signal.aborted) ctx.ui.notify("Compaction summary was empty, using default compaction", "warning");
				return;
			}

			// 返回 CompactionResult：summary 替代旧上下文，firstKeptEntryId 保留宿主指定的近期尾部，tokensBefore 用于统计。
			// Return compaction content - SessionManager adds id/parentId
			// 注意仍保留 firstKeptEntryId 之后的消息；英文文件头说“丢弃全部旧轮”并不准确。
			// Use firstKeptEntryId from preparation to keep recent messages
			// 返回对象由 session runner 检查后追加为 compaction entry；扩展不直接写日志。
			return {
				// compaction 字段是结果类型要求的包装；不是再次触发压缩。
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					// usage 记录本次摘要请求的 token/成本，供会话统计使用。
					usage: response.usage,
				},
			};
			// 模型请求、鉴权或序列化异常都会进入这里；错误文本只用于 UI 提示。
		} catch (error) {
			// error 在外部边界可能是任意值，所以用 instanceof 取 message；这是运行时检查。
			const message = error instanceof Error ? error.message : String(error);
			// 提示错误后返回 undefined，宿主仍会执行默认压缩。
			ctx.ui.notify(`Compaction failed: ${message}`, "error");
			// Fall back to default compaction on error
			// 显式 return 结束处理器；undefined 表示不提供 compaction。
			return;
		}
	});
}
