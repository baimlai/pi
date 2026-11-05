// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：演示“提示生成器”模式：/qna 找到当前分支最后一条完整 assistant 消息，用它作为输入调用一次模型，
//   提取其中的待答问题，按 Q:/A: 格式加载到编辑器，供用户填写后发送。
// 上游：`pi -e ./qna.ts` 加载；用户执行 /qna。要求交互模式且已选模型。
// 下游：sessionManager.getBranch 读取会话；modelRegistry.complete 发起一次模型调用；BorderedLoader 显示
//   可取消的等待框；ctx.ui.setEditorText 把结果写回输入框。不写文件，除模型请求外无网络。
// 能力：
//   SYSTEM_PROMPT       提取问题的系统提示。
//   默认导出函数         注册 /qna 命令。
// 典型顺序：/qna -> 检查 mode/model -> 向前找最后 assistant 文本 -> 显示 loader -> 调用模型 -> 结果进编辑器。
// 示例：上一条回复含两个问题，执行 /qna 后编辑器出现两段 "Q: ... / A: ..."。
// 阅读顺序：先看消息筛选与 stopReason 检查，再看 loader 的取消/错误路径，最后看结果如何写回编辑器。

/**
 * Q&A extraction extension - extracts questions from assistant responses
 *
 * Demonstrates the "prompt generator" pattern:
 * 1. /qna command gets the last assistant message
 * 2. Shows a spinner while extracting (hides editor)
 * 3. Loads the result into the editor for user to fill in answers
 */

import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";

// 提取器的系统提示。模板字符串内容会原样发送给模型；注释只加在模板外，不改变提示文本。
// 它要求每个问题以 Q: 开头、后跟空行和 A:，无问题时输出固定句子。
const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering and format them for the user to fill in.

Output format:
- List each question on its own line, prefixed with "Q: "
- After each question, add a blank line for the answer prefixed with "A: "
- If no questions are found, output "No questions found in the last message."

Example output:
Q: What is your preferred database?
A: 

Q: Should we use TypeScript or JavaScript?
A: 

Keep questions in the order they appeared. Be concise.`;

// 扩展入口。输入：宿主 API；输出：无；副作用是注册 /qna 命令。
// 命令本身不修改会话，只读取消息并把提取结果写进编辑器。
export default function (pi: ExtensionAPI) {
	pi.registerCommand("qna", {
		description: "Extract questions from last assistant message into editor",
		handler: async (_args, ctx) => {
			// custom UI、loader 和编辑器写入都依赖 TUI；非交互模式直接拒绝。
			if (ctx.mode !== "tui") {
				ctx.ui.notify("qna requires interactive mode", "error");
				return;
			}

			// 没有当前模型就无法发起提取请求；这里先给出明确提示。
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// Find the last assistant message on the current branch
			// 从分支末尾向前找，跳过 toolResult 等非 assistant 消息；只取当前分支，不含其他分支。
			const branch = ctx.sessionManager.getBranch();
			let lastAssistantText: string | undefined;

			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				// 会话条目是联合类型；type 收窄后才能访问 message 字段。
				if (entry.type === "message") {
					const msg = entry.message;
					// `in` 守卫排除没有 role 的消息形状，再比较 role 字面量。
					if ("role" in msg && msg.role === "assistant") {
						// 只有正常结束的回复才可靠；aborted/error/toolUse 等提示用户而不继续。
						if (msg.stopReason !== "stop") {
							ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
							return;
						}
						// 类型谓词收窄 content 联合，只保留 text 块；thinking/toolCall 被过滤掉。
						const textParts = msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text);
						// 没有文字（只有工具调用）时继续向前找更早的 assistant 消息。
						if (textParts.length > 0) {
							lastAssistantText = textParts.join("\n");
							break;
						}
					}
				}
			}

			if (!lastAssistantText) {
				ctx.ui.notify("No assistant messages found", "error");
				return;
			}

			// Run extraction with loader UI
			// custom 的泛型是 string | null：成功得到提取文本，取消/失败得到 null。
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				// 文案里的 ctx.model! 非空断言：外层已检查，但闭包内 TS 不会保留收窄。
				const loader = new BorderedLoader(tui, theme, `Extracting questions using ${ctx.model!.id}...`);
				// 用户按取消键时直接结束 custom；真正的模型请求由 signal 协作取消。
				loader.onAbort = () => done(null);

				// Do the work
				// 构造一次性用户消息：content 是 TextContent 数组，timestamp 只在会话展示中使用。
				const doExtract = async () => {
					const userMessage: UserMessage = {
						role: "user",
						content: [{ type: "text", text: lastAssistantText! }],
						timestamp: Date.now(),
					};

					// complete 返回完整响应（非流式聚合），signal 来自 loader；取消后请求应尽快结束。
					const response = await ctx.modelRegistry.complete(
						ctx.model!,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{ signal: loader.signal },
					);

					// 被取消的请求不产生可编辑文本，按 null 处理。
					if (response.stopReason === "aborted") {
						return null;
					}

					// 只拼接文字块；示例忽略 thinking 等非文本内容。
					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				};

				// 启动异步任务但不 await：组件先返回给 TUI 显示 loader，完成后 done 关闭。
				// 任何异常（网络、鉴权、序列化）都转成 null，避免 unhandled rejection。
				doExtract()
					.then(done)
					.catch(() => done(null));

				return loader;
			});

			// null 同时代表用户取消和提取失败；示例统一提示 Cancelled。
			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// 把提取结果写入输入框，而不是直接发送；用户可补充答案后再提交。
			ctx.ui.setEditorText(result);
			ctx.ui.notify("Questions loaded. Edit and submit when ready.", "info");
		},
	});
}
