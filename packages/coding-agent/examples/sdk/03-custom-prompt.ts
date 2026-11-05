/**
 * Custom System Prompt
 *
 * Shows how to replace or modify the default system prompt.
 *
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/sdk，SDK 示例系列第 03 个。上游由
 * `node examples/sdk/03-custom-prompt.ts` 直接运行（需先构建工作区）；下游用
 * DefaultResourceLoader 的覆盖回调改写系统提示词，再把加载器交给 createAgentSession。
 *
 * 演示什么：两种系统提示词定制方式。选项 1 用 systemPromptOverride 整体替换默认提示词，
 * 同时把 appendSystemPromptOverride 置为空数组，避免再拼接 ~/.pi/agent 或 <cwd>/.pi 中的
 * APPEND_SYSTEM.md；选项 2 保留默认提示词，只在末尾追加项目指令。两个会话都使用内存历史，
 * 不会写会话文件。运行会真实调用模型，可能产生费用。
 *
 * 能力清单（按调用顺序）：
 * - getAgentDir()：返回用户级配置目录（默认 ~/.pi/agent）。
 * - new DefaultResourceLoader(options)：创建资源加载器，覆盖回调仅在 reload 时执行。
 * - loader.reload()：发现技能/扩展/说明文件并应用 systemPrompt 与 appendSystemPrompt 覆盖。
 * - createAgentSession({ resourceLoader, sessionManager })：用准备好的加载器和内存历史装配会话。
 * - session.subscribe / session.prompt / session.dispose：观察文字增量、提问、清理。
 *
 * 典型运行顺序与预期输出：
 *   1. 运行脚本，先看到 `=== Replace prompt ===`，模型以海盗口吻回答并可能补 "Arrr!"。
 *   2. 再看到 `=== Modify prompt ===`，模型按追加的简洁/项目符号指令回答。
 *   3. 两个会话分别释放；没有持久化会话文件。
 *
 * 示例（真实签名）：
 *   const loader = new DefaultResourceLoader({
 *     cwd: process.cwd(),
 *     agentDir: getAgentDir(),
 *     systemPromptOverride: (base) => `${base ?? ""}\n\nBe concise.`,
 *   });
 *   await loader.reload();
 *   const { session } = await createAgentSession({ resourceLoader: loader, sessionManager: SessionManager.inMemory() });
 *   base 的类型是 string | undefined，使用前要处理缺省情况。
 *
 * 建议阅读顺序：先看 cwd/agentDir 的来源，再看 loader1 的“完全替换 + 禁用追加”，随后看
 * loader2 在 base 数组上追加，最后看两次 createAgentSession 与事件流。
 */

// 命名导入：DefaultResourceLoader 构造资源加载器，getAgentDir 提供用户配置目录，
// SessionManager 提供内存历史，createAgentSession 负责最终装配。
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

// 当前工作目录决定项目级资源发现（例如 <cwd>/.pi）；它同时会成为工具的相对路径基准。
const cwd = process.cwd();
// 用户级配置根；不传则无法显式区分项目资源与全局资源，这里先取默认值再显式传入。
const agentDir = getAgentDir();

// Option 1: Replace prompt entirely
// 创建加载器时只保存选项；覆盖回调要等 reload() 才被调用。
const loader1 = new DefaultResourceLoader({
	// 项目资源从 cwd 发现。
	cwd,
	// 全局资源从 agentDir 发现。
	agentDir,
	// 回调忽略传入的 base，返回一段全新提示词；模板字符串内容属于运行时空格与文字，不插注释。
	systemPromptOverride: () => `You are a helpful assistant that speaks like a pirate.
Always end responses with "Arrr!"`,
	// Needed to avoid DefaultResourceLoader appending APPEND_SYSTEM.md from ~/.pi/agent or <cwd>/.pi.
	// 返回空数组而不是修改 base，确保不再追加任何 APPEND_SYSTEM.md 内容。
	appendSystemPromptOverride: () => [],
});
// reload 才发现资源并执行上面两个覆盖回调；不调用它，加载器里的提示词仍是未初始化状态。
await loader1.reload();

// 传入已经 reload 的加载器；createAgentSession 不会替调用方再次 reload 自定义加载器。
// SessionManager.inMemory() 不创建文件，适合演示和测试。
const { session: session1 } = await createAgentSession({
	resourceLoader: loader1,
	sessionManager: SessionManager.inMemory(),
});

// 与 01/02 相同的流式订阅和清理结构；这里用 session1 别名避免与第二个会话重名。
try {
	session1.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	// 分隔标签先打印，随后模型输出紧跟在下一行。
	console.log("=== Replace prompt ===");
	// 等待整轮运行结束；prompt 的 resolve 不代表一定成功，失败会以异常拒绝。
	await session1.prompt("What is 2 + 2?");
	// 输出两个换行，与下一段演示分开。
	console.log("\n");
} finally {
	session1.dispose();
}

// Option 2: Append instructions to the default prompt
// 第二个加载器只覆盖追加提示词；systemPromptOverride 留空，因此基础系统提示词保持默认。
const loader2 = new DefaultResourceLoader({
	cwd,
	agentDir,
	// base 是加载器已发现并准备追加的字符串数组；展开后追加一段，得到新数组而不是原地 push。
	appendSystemPromptOverride: (base) => [
		...base,
		"## Additional Instructions\n- Always be concise\n- Use bullet points when listing things",
	],
});
// 同样必须 reload，覆盖回调才会执行并缓存最终提示词。
await loader2.reload();

// 第二个会话使用独立的内存历史；它与 session1 共享 cwd/agentDir，但加载器实例不同。
const { session: session2 } = await createAgentSession({
	resourceLoader: loader2,
	sessionManager: SessionManager.inMemory(),
});

try {
	// 订阅方式相同；两个会话不会互相收到对方的事件。
	session2.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	console.log("=== Modify prompt ===");
	// 这条问题用来观察追加指令（简洁、使用项目符号）对回答风格的影响。
	await session2.prompt("List 3 benefits of TypeScript.");
	// 单个换行收尾。
	console.log();
} finally {
	session2.dispose();
}
