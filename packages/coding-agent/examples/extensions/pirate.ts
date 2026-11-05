// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：用扩展内的 pirateMode 开关动态改写系统提示：开启后每轮在现有系统提示末尾追加海盗口吻要求。
// 上游：复制到 ~/.pi/agent/extensions/ 或项目 .pi/extensions/ 后由宿主自动加载；也可用 -e 指定。
// 下游：/pirate 命令切换状态并 notify；before_agent_start 返回 { systemPrompt } 替换本轮完整系统提示。
//   不写文件、不发网络、不持久化状态。
// 能力：
//   pirateExtension  模块内 pirateMode 状态、/pirate 命令和 before_agent_start 处理器。
// 典型顺序：加载 -> /pirate 开启 -> 提交消息 -> before_agent_start 读取状态并追加提示 -> 模型按海盗口吻回复。
// 示例：开启后问 "How do I list files?"，回复仍是正确命令，但措辞类似 "Ahoy, matey! Use ls, arrr!"。
// 阅读顺序：先看 pirateMode 的作用域，再看命令如何切换，最后看事件返回值是“替换”而不是“自动追加”。

/**
 * Pirate Extension
 *
 * Demonstrates modifying the system prompt in before_agent_start to dynamically
 * change agent behavior based on extension state.
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /pirate to toggle pirate mode
 * 3. When enabled, the agent will respond like a pirate
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 扩展入口。输入：宿主 API；输出：无；副作用是注册命令和事件处理器。
// pirateMode 是闭包变量：命令处理器与 before_agent_start 处理器共享同一份状态，重载扩展后重置。
export default function pirateExtension(pi: ExtensionAPI) {
	let pirateMode = false;

	// Register /pirate command to toggle pirate mode
	// 命令只翻转布尔值并提示，不立即影响当前已开始的回合；下一轮 before_agent_start 才读取新状态。
	pi.registerCommand("pirate", {
		description: "Toggle pirate mode (agent speaks like a pirate)",
		handler: async (_args, ctx) => {
			pirateMode = !pirateMode;
			// 三元表达式按新状态选择提示文案；等级 "info" 只影响展示样式。
			ctx.ui.notify(pirateMode ? "Arrr! Pirate mode enabled!" : "Pirate mode disabled", "info");
		},
	});

	// Append to system prompt when pirate mode is enabled
	// 每轮启动前触发。返回 undefined 表示不干预；返回对象中的 systemPrompt 会替换本轮完整提示。
	// 因此这里必须显式拼上 event.systemPrompt，否则原系统提示会被整段丢弃。
	pi.on("before_agent_start", async (event) => {
		if (pirateMode) {
			// 模板字符串内容会原样进入系统提示；它包含多行规则，末尾换行也是提示的一部分。
			// 本注释位于模板之外，不改变提示文本。
			return {
				systemPrompt:
					event.systemPrompt +
					`

IMPORTANT: You are now in PIRATE MODE. You must:
- Speak like a stereotypical pirate in all responses
- Use phrases like "Arrr!", "Ahoy!", "Shiver me timbers!", "Avast!", "Ye scurvy dog!"
- Replace "my" with "me", "you" with "ye", "your" with "yer"
- Refer to the user as "matey" or "landlubber"
- End sentences with nautical expressions
- Still complete the actual task correctly, just in pirate speak
`,
			};
		}
		// 关闭状态没有任何覆盖；注意不是返回空 systemPrompt（空字符串会清空提示）。
		return undefined;
	});
}
