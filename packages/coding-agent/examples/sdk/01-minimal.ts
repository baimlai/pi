/**
 * Minimal SDK Usage
 *
 * Uses all defaults: discovers skills, extensions, tools, context files
 * from cwd and ~/.pi/agent. Model chosen from settings or first available.
 *
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/sdk，SDK 示例系列第 01 个。上游由
 * `node examples/sdk/01-minimal.ts` 直接运行（需先构建工作区，让包名解析到各包的 dist）；
 * 下游调用 createAgentSession 创建 AgentSession，再由会话向设置中选中的模型提供商发起请求。
 *
 * 演示什么：不传任何选项，完全使用默认值——从 cwd 和 ~/.pi/agent 发现技能、扩展、工具和
 * AGENTS.md 等上下文文件，模型取自设置或第一个可用模型。它是最小可运行示例：需要至少一个
 * 已配置认证的提供商，否则创建或提问时会因没有可用模型/凭证而报错。运行会发出真实模型请求，
 * 可能产生费用；默认历史管理器还会把会话写入磁盘，除非显式传 SessionManager.inMemory()。
 *
 * 能力清单（按调用顺序）：
 * - createAgentSession()：装配默认服务、资源、工具和会话历史管理器。
 * - session.subscribe(listener)：订阅会话事件流，返回退订函数（本例未保存）。
 * - session.prompt(text)：发送一条用户消息，并等待整轮模型/工具运行结束。
 * - session.state.messages：读取当前会话累积的 Agent 消息数组。
 * - session.dispose()：释放订阅、缓存和供应商会话资源，不删除会话历史文件。
 *
 * 典型运行顺序与预期输出：
 *   1. 在 packages/coding-agent 目录执行 `node examples/sdk/01-minimal.ts`。
 *   2. 模型回答的文字以增量形式写到 stdout，不额外换行。
 *   3. 运行结束后把每条消息对象打印到 stdout，最后输出一个空行。
 *
 * 示例（真实签名）：
 *   const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
 *     thinkingLevel: "low",
 *   });
 *   await session.prompt("hi");
 *   session.dispose();
 *   这里只使用部分返回字段；extensionsResult 供宿主初始化扩展 UI，modelFallbackMessage 是
 *   恢复会话时模型回退的可选提示。
 *
 * 建议阅读顺序：先看 import 与 createAgentSession() 的默认装配，再看 subscribe 中的两层事件
 * 收窄，最后看 prompt、消息读取和 finally 清理。
 */

// 从包根入口导入装配函数；运行值来自已构建的 dist，而不是直接读 src。
import { createAgentSession } from "@earendil-works/pi-coding-agent";

// ESM 支持顶层 await：等默认服务、资源和历史管理器全部准备好。解构只取 session，
// 其余返回字段（extensionsResult、modelFallbackMessage）在本例中忽略。
const { session } = await createAgentSession();

// try/finally 保证即使订阅或提问抛错，也会执行下面的 dispose；finally 不吞掉原异常。
try {
	// 注册事件监听：listener 收到一个可辨识联合，返回的退订函数在本例中未保存。
	session.subscribe((event) => {
		// 先按 event.type 收窄到 message_update，再按嵌套的 assistantMessageEvent.type
		// 收窄到 text_delta；思考增量、工具事件等不会进入这个分支。
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			// delta 是一小段文字；write 不自动换行，多个增量按到达顺序拼成完整回答。
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	// 发送用户消息；promise 在整轮运行（含工具调用和收尾）结束后才 resolve，
	// 若会话未选到模型/凭证会以错误拒绝。
	await session.prompt("What files are in the current directory?");
	// state 直接暴露底层 Agent 的可变状态；messages 是本次会话累积的消息数组，
	// console.log 会把每个对象按 Node 的 inspect 格式展开。
	session.state.messages.forEach((msg) => {
		console.log(msg);
	});
	// 回答增量已经写在 stdout 上，这里补一个换行，避免消息对象紧贴最后一行文字。
	console.log();
} finally {
	// 同步释放该会话的事件订阅和资源；它请求取消进行中的操作，但不等待异步任务全部停止，
	// 也不删除磁盘上的历史文件。
	session.dispose();
}
