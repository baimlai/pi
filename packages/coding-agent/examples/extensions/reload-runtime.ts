// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：演示两种触发运行时重载的方式：用户执行 /reload-runtime 命令，或模型调用 reload_runtime 工具。
//   工具不能直接重载（没有命令上下文，且 Agent 运行中不能重载），因此只记录请求并终止本轮，等
//   agent_settled 后再通过命令通道触发。
// 上游：`pi --extension ./examples/extensions/reload-runtime.ts` 加载；命令由用户输入，或由模型调用工具。
// 下游：ctx.reload() 重载扩展/技能/提示/主题/上下文文件并替换当前扩展运行时；pi.sendUserMessage 以命令
//   形式注入 /reload-runtime。重载会使当前扩展实例失效，后续代码不应再依赖旧 ctx。
// 能力：
//   /reload-runtime 命令  直接等待 ctx.reload()。
//   reload_runtime 工具   设置闭包标志并返回 terminate，结束当前运行。
//   agent_settled 处理器  在 Agent 完全空闲后派发命令。
// 典型顺序：用户命令 -> reload；或模型调用工具 -> terminate 结束本轮 -> agent_settled -> sendUserMessage
//   -> 命令处理器 -> reload。
// 示例：模型调用 reload_runtime 后，这一轮回复结束且没有后续自动续跑时，宿主执行 /reload-runtime，
//   扩展被重新加载；模型不会把这个命令当成普通用户文本回答。
// 阅读顺序：先看命令的“重载即终点”，再看工具与闭包标志，最后看 agent_settled 的延迟派发。

/**
 * Reload Runtime Extension
 *
 * Demonstrates ctx.reload() from ExtensionCommandContext and an LLM-callable
 * tool that requests a reload once the agent has settled.
 */

// ExtensionAPI 仅作类型使用；Type 用于声明工具参数 schema（这里为空对象）。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// 扩展入口。输入：宿主 API；输出：无；副作用是注册命令、工具与 agent_settled 处理器。
// reloadRequested 位于闭包中，被工具（写）和事件处理器（读并复位）共享；重载后整个模块会重新执行。
export default function (pi: ExtensionAPI) {
	// Command entrypoint for reload.
	// Treat reload as terminal for this handler.
	// 命令处理器收到 ExtensionCommandContext（带 reload 能力）。await 后立即 return：
	// 重载会使当前运行时失效，后续不应继续使用 ctx 或访问旧扩展状态。
	pi.registerCommand("reload-runtime", {
		description: "Reload extensions, skills, prompts, themes, and context files",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});

	// LLM-callable tool. Tools do not receive ExtensionCommandContext, so they cannot call
	// ctx.reload(), and Pi cannot reload while the agent is running. The tool records the
	// request and ends the run; the agent_settled handler then runs the command above.
	// 工具回调拿到的是普通 ExtensionContext，没有 reload 方法；因此用闭包标志搭桥。
	let reloadRequested = false;

	// 工具声明：空参数对象表示模型无需提供任何参数。
	// execute 省略了宿主会传入的参数（调用 id、params、signal 等），因为本实现不需要它们。
	pi.registerTool({
		name: "reload_runtime",
		label: "Reload Runtime",
		description: "Reload extensions, skills, prompts, themes, and context files",
		parameters: Type.Object({}),
		async execute() {
			// 先记录请求，再让本轮结束；没有直接执行重载。
			reloadRequested = true;
			// content 是模型看到的文字；details 是 UI/程序用的附加数据。
			// terminate 是“本批工具结束后停止”的提示：只有该批所有最终结果都为 true 才提前终止；
			// 单独一次调用时即结束本轮，让 agent 进入 settled 状态。
			return {
				content: [{ type: "text", text: "Reload requested. Pi reloads after this response." }],
				details: {},
				terminate: true,
			};
		},
	});

	// agent_settled 在 Agent 完全稳定后触发：没有计划中的自动重试、压缩或排队续跑。
	// 事件带 aborted 字段，但这里不区分；重载请求是主动触发的，与取消无关。
	pi.on("agent_settled", () => {
		// 没有请求时什么也不做，避免每次 Agent 结束都触发重载。
		if (!reloadRequested) return;
		// 先复位标志再派发：即使后续派发/重载失败，也不会在下一个 settled 事件里重复请求。
		reloadRequested = false;
		// Sent from agent_settled, the command runs after every settled handler finishes, while
		// the agent is idle. expandPromptTemplates dispatches it as a command, not as model input.
		// expandPromptTemplates 让输入走命令/技能/模板展开路径，所以 "/reload-runtime" 被执行，
		// 而不是作为普通用户消息发给模型。
		pi.sendUserMessage("/reload-runtime", { expandPromptTemplates: true });
	});
}
