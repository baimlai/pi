// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；用 `pi -e ./handoff.ts` 加载。
// 演示内容：/handoff <goal> 用当前模型把当前分支对话浓缩成新会话的起始 prompt，再创建带 parentSession 的新会话，把 prompt 放进编辑器草稿供审核。
// 上下游：命令 -> getHandoffMessages 取分支消息 -> convertToLlm/serializeConversation -> BorderedLoader + modelRegistry.complete 生成 -> ctx.ui.editor 审核 -> ctx.newSession({parentSession,withSession})。不直接写文件；newSession 会切换会话。
// 能力清单：
// - entryToMessage/getHandoffMessages：从 SessionEntry 重建 handoff 材料，处理最后一次 compaction。
// - 默认导出：注册 /handoff；TUI/模型/参数校验、生成、编辑、创建新会话。
// 典型运行顺序：/handoff 实现团队版 -> 收集消息 -> 生成 prompt（loader 可取消）-> 编辑器审核 -> 新会话打开并填入草稿 -> 用户提交。
// 示例（真实签名）：
//   /handoff now implement this for teams as well
//   // 生成的新会话编辑器中出现以 "## Context"、"## Task" 开头的草稿
// 阅读顺序：先看 entryToMessage/getHandoffMessages 如何重建上下文，再看命令的生成/取消/编辑，最后看 newSession 与 replacementCtx。
// 前置与副作用：仅 TUI；需要已选模型、非空 goal、至少一条可转换消息。生成请求使用当前模型，未设 maxTokens，会产生真实费用；取消和错误都显示 Cancelled，错误只写 console.error。只处理 stopReason "aborted"，error/length 等未单独处理；空文本仍会打开空编辑器。serializeConversation 会省略 thinking/图片并截断工具结果。getHandoffMessages 只取最后一次 compaction；找不到 firstKeptEntryId 时只保留摘要和其后的条目。newSession 成功后旧 ctx 失效，后续 UI 必须用 withSession 提供的 replacementCtx；草稿不会自动发送，用户需确认提交。newSession 也可能被 before 钩子取消。parentSession 来自 getSessionFile()，内存会话可能没有文件。
/**
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters
 * for your next task and creates a new session with a generated prompt.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *   /handoff check other places that need this fix
 *
 * The generated prompt appears as a draft in the editor for review/editing.
 */

// import type 只引入类型；AgentMessage 用于 entryToMessage/getHandoffMessages 的返回值。
import type { AgentMessage } from "@earendil-works/pi-agent-core";
// 混合导入：type Message 只用于编译期，uuidv7 是运行时值；这种写法不会加载未使用的类型。
import { type Message, uuidv7 } from "@earendil-works/pi-ai";
// ExtensionAPI 标注入口，SessionEntry 描述分支条目；都是类型。
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
// BorderedLoader 是等待界面组件，convertToLlm/serializeConversation 把消息转成模型可读文本。
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

// 生成 handoff prompt 的系统提示；下面整个模板字符串是原示例文案，内部不能插入注释。
const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

// 把 SessionEntry 转为 AgentMessage：普通消息直接返回，compaction 转成 compactionSummary，其他条目返回 undefined。
// 输入一条 session entry，输出 AgentMessage | undefined；不修改 entry，无 I/O。
// 示例：compaction entry -> {role:"compactionSummary", summary, tokensBefore, timestamp}。
function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	// 普通消息条目已带 AgentMessage；直接返回引用，不复制。
	if (entry.type === "message") {
		return entry.message;
	}
	// compaction 条目保存摘要和压缩前 token 数；转换成模型可读的 compactionSummary。
	if (entry.type === "compaction") {
		// 角色固定为 compactionSummary；字段名由 AgentMessage 联合类型要求。
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			// entry.timestamp 是 ISO 字符串，转成毫秒数；无效日期会得到 NaN。
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	// 标签、模型切换、custom entry 等不进入 handoff 材料，返回 undefined 后被过滤。
	return undefined;
}

// 重建 handoff 消息：没有压缩时用全部可转换条目；有压缩时只取最后一次压缩并保留其后的近期条目。
// 输入根到叶的分支数组，输出 AgentMessage[]；只读、无 I/O。
// 流程：反向找最后一个 compaction -> 找 firstKeptEntryId 的下标 -> 按 [摘要, 保留段, 压缩后条目] 拼接。
function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
	// 从后往前找最后一个 compaction；-1 表示本分支从未压缩。
	let compactionIndex = -1;
	// 倒序扫描，遇到第一个 compaction 就停；这是最近一次压缩。
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			// 记录下标后跳出；前面的旧 compaction 不再单独处理。
			break;
		}
	}
	if (compactionIndex < 0) {
		// 没有压缩：保持分支顺序，过滤掉非消息条目。
		return branch.map(entryToMessage).filter((message) => message !== undefined);
	}

	// 取出最近一次 compaction；下面用它记录的 firstKeptEntryId 恢复保留段。
	const compaction = branch[compactionIndex];
	// firstKeptEntryId 指向压缩后仍保留的第一条旧条目；找不到时 findIndex 返回 -1。
	const firstKeptIndex =
		compaction.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
	// 组合顺序：摘要在前，然后是从 firstKeptEntryId 到压缩点的保留条目，最后是压缩点之后的条目。
	const compactedBranch = [
		// compaction 条目本身先放进去，entryToMessage 会把它转成 summary。
		compaction,
		// firstKeptIndex 无效时展开空数组，只保留摘要和压缩后的条目。
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		// compactionIndex + 1 之后的条目发生在压缩之后，按原顺序追加。
		...branch.slice(compactionIndex + 1),
	];
	// 映射并过滤 undefined；filter 的窄化让数组类型保持 AgentMessage[]。
	return compactedBranch.map(entryToMessage).filter((message) => message !== undefined);
}

// 扩展入口：注册 /handoff；加载时不读取会话、不调用模型。
export default function (pi: ExtensionAPI) {
	// 命令名不带斜杠；description 用于命令列表。
	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session",
		// args 是 goal 原文；ctx 提供会话、模型、UI 和 newSession。
		handler: async (args, ctx) => {
			// 非 TUI 没有 BorderedLoader/editor，直接拒绝；RPC/JSON/print 不可用。
			if (ctx.mode !== "tui") {
				// 错误通知后结束，不生成 prompt。
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}

			// 生成需要当前模型；模型可能在生成期间变化，所以后面用非空断言。
			if (!ctx.model) {
				// 没有模型时提示并结束。
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// 去掉首尾空白；goal 为空则显示用法。
			const goal = args.trim();
			// 空 goal 不进入生成，避免让模型猜任务。
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
				return;
			}

			// 只传当前活动分支；getBranch 不包含其他分支。
			// Gather conversation context from current branch. If the branch was compacted,
			// include the compaction summary plus entries from firstKeptEntryId onward.
			// 读取分支并重建消息；压缩摘要会作为 compactionSummary 消息参与转换。
			const messages = getHandoffMessages(ctx.sessionManager.getBranch());

			// 没有可转换消息（例如空会话）时不做 handoff。
			if (messages.length === 0) {
				// 提示后结束；不会创建新会话。
				ctx.ui.notify("No conversation to hand off", "error");
				return;
			}

			// 先转成 LLM 消息，再序列化成纯文本；思考/图片和长工具结果会被省略或截断。
			// Convert to LLM format and serialize
			// convertToLlm 处理 custom/tool 等消息类型，输出 provider 可读的消息数组。
			const llmMessages = convertToLlm(messages);
			// serializeConversation 生成带角色标记的纯文本，作为生成请求的对话材料。
			const conversationText = serializeConversation(llmMessages);
			// 当前会话文件用于新会话的 parentSession 追踪；内存会话可能没有文件。
			const currentSessionFile = ctx.sessionManager.getSessionFile();

			// 用自定义 UI 承载 loader；回调必须同步返回一个 Component，异步生成通过 done 回传。
			// Generate the handoff prompt with loader UI
			// custom 的返回值是 string | null：生成成功得到 prompt，取消/失败得到 null。
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				// BorderedLoader 显示边框和动画；它本身不会自动取消 complete，需要业务观察 signal。
				const loader = new BorderedLoader(tui, theme, `Generating handoff prompt...`);
				// 用户按取消键时 done(null)，editor 不会打开；生成请求同时收到 loader.signal。
				loader.onAbort = () => done(null);

				// 异步生成放进后台；不要 await 它，否则会阻塞 custom 回调返回 loader。
				const doGenerate = async () => {
					// 构造一条 user 消息，正文包含序列化历史和用户 goal；模板内容不能插入注释。
					const userMessage: Message = {
						role: "user",
						content: [
							{
								type: "text",
								text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
							},
						],
						timestamp: Date.now(),
					};

					// 使用当前模型；ctx.model! 是非空断言，运行时不再检查（此前已检查一次）。
					const response = await ctx.modelRegistry.complete(
						ctx.model!,
						// 请求内容：systemPrompt 固定，messages 只含这一条 user 消息；未传 maxTokens，使用默认上限。
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{
							// loader.signal 让用户取消传播到 complete；不是所有 provider 都立即中止。
							signal: loader.signal,
							// 明确不使用缓存保留策略。
							cacheRetention: "none",
							// 每次生成新的请求 id；不用于持久会话。
							sessionId: uuidv7(),
						},
					);

					// 只把 aborted 当取消；error/length/toolUse 等停止原因仍会继续过滤文本。
					if (response.stopReason === "aborted") {
						return null;
					}

					// 拼接所有 text 块；类型谓词只做编译期收窄，运行时只比较 c.type；思考/工具调用块被丢弃。
					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				};

				// 成功时调用 done(result)；如果用户已取消，done 可能被调用两次，是否忽略由 UI 决定。
				doGenerate()
					.then(done)
					.catch((err) => {
						// 生成异常只写 console.error，UI 最终显示 Cancelled；错误细节不展示给用户。
						console.error("Handoff generation failed:", err);
						// 失败也用 null 结束 loader；不会把异常抛到命令层。
						done(null);
					});

				// 返回 loader 组件；custom 负责在 done 后移除并释放它。
				return loader;
			});

			// null 同时代表用户取消和生成失败；后面统一提示 Cancelled。
			if (result === null) {
				// 这里不区分 aborted/错误/空结果。
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Let user edit the generated prompt
			// 打开编辑器让用户审核生成结果；返回 string 或 undefined（取消）。
			const editedPrompt = await ctx.ui.editor("Edit handoff prompt", result);

			// 编辑器取消/关闭时不创建新会话。
			if (editedPrompt === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// newSession 成功后旧 ctx 失效；后续 UI 必须使用 replacementCtx。
			// Create new session with parent tracking. Use the replacement-session
			// context for post-switch UI work; the original ctx is stale after a
			// successful session replacement.
			// 创建并切换到新会话；parentSession 记录来源文件，withSession 在新会话中执行初始化。
			const newSessionResult = await ctx.newSession({
				// currentSessionFile 可能是 undefined（内存会话）；parentSession 是可选字段。
				parentSession: currentSessionFile,
				// withSession 在替换完成后调用；这里的 replacementCtx 才是新会话的有效上下文。
				withSession: async (replacementCtx) => {
					// 把生成/编辑后的 prompt 放入新会话编辑器，作为未发送草稿。
					replacementCtx.ui.setEditorText(editedPrompt);
					// 提示用户审核后提交；不会自动发送 prompt。
					replacementCtx.ui.notify("Handoff ready. Submit when ready.", "info");
				},
			});

			// 新会话可能被 session_before_switch 等钩子取消；此时旧 ctx 仍有效。
			if (newSessionResult.cancelled) {
				// 只在取消时用旧 ctx 通知；成功路径已在 withSession 中用新 ctx 提示。
				ctx.ui.notify("New session cancelled", "info");
			}
		},
	});
}
