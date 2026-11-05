/**
 * Context Files (AGENTS.md)
 *
 * Context files provide project-specific instructions loaded into the system prompt.
 *
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/sdk，SDK 示例系列第 07 个。上游由
 * `node examples/sdk/07-context-files.ts` 直接运行（需先构建工作区）；下游用
 * DefaultResourceLoader 的 agentsFilesOverride 在发现的 AGENTS.md 列表上追加一条虚拟说明，
 * 再把加载器交给 createAgentSession。
 *
 * 演示什么：上下文文件是自动拼进系统提示词的项目/用户说明。加载器会从 cwd 向上查找
 * AGENTS.md，并读取用户级说明；agentsFilesOverride 可以增删这个列表。本例没有写磁盘，
 * 只是在内存里的数组中追加一个 /virtual/AGENTS.md。文件里的模板字符串是运行时内容，
 * 注释不插入其中。脚本不发送模型请求；创建会话后立即释放。
 *
 * 注意：上方英文注释说“返回空列表可完全禁用上下文文件”，但下面的代码并没有返回空列表，
 * 而是展开 current.agentsFiles 后追加一项。若要禁用，应在 agentsFilesOverride 中返回
 * { agentsFiles: [] }；当前示例演示的是“追加”。
 *
 * 能力清单（按调用顺序）：
 * - new DefaultResourceLoader({ agentsFilesOverride })：注册上下文文件覆盖回调。
 * - loader.reload()：执行发现并应用覆盖，结果缓存在加载器中。
 * - loader.getAgentsFiles()：读取 { agentsFiles: Array<{ path, content }> }。
 * - for...of 打印每个文件的路径和 content 的 UTF-16 码元数。
 * - createAgentSession({ resourceLoader, sessionManager })：装配会话；本例不提问。
 *
 * 典型运行顺序与预期输出：
 *   1. 运行脚本；打印 `Discovered context files:`。
 *   2. 每行列出发现到的文件路径和字符数，最后一行是虚拟文件的路径。
 *   3. 打印会话创建提示，随后立即 dispose；没有模型费用、没有文件写入。
 *
 * 示例（真实签名，真正禁用上下文文件）：
 *   agentsFilesOverride: () => ({ agentsFiles: [] })
 *   返回空数组后，模型不会收到任何 AGENTS.md 内容；这不会删除磁盘上的文件。
 *
 * 建议阅读顺序：先看 agentsFilesOverride 的输入/返回形状，再看 reload 与 getAgentsFiles，
 * 最后留意会话创建日志中的计数表达式。
 */

// 加载器负责发现并覆盖上下文文件，getAgentDir 指定用户配置根，历史使用内存实现。
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

// Disable context files entirely by returning an empty list in agentsFilesOverride.
// 中文说明：上面的英文描述与本段代码不一致；本段实际是“保留现有列表再追加”，不是禁用。
// current 是 { agentsFiles }，没有可修改的诊断字段。
const loader = new DefaultResourceLoader({
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	agentsFilesOverride: (current) => ({
		// 展开复制现有列表，再追加一个虚拟文件；原数组本身不被修改。
		agentsFiles: [
			...current.agentsFiles,
			{
				// 路径只用于来源展示和冲突诊断，不需要真实存在；加载器不会读这个虚拟路径。
				path: "/virtual/AGENTS.md",
				// content 会直接进入系统提示词的上下文部分，模板字符串保留原有换行与缩进。
				content: `# Project Guidelines

## Code Style
- Use TypeScript strict mode
- No any types
- Prefer const over let`,
			},
		],
	}),
});
// 执行发现与覆盖；不调用 reload 时 getAgentsFiles 只能看到未初始化的空结果。
await loader.reload();

// Discover AGENTS.md files walking up from cwd
// 读取缓存结果；discovered 已包含 override 追加的虚拟文件。
const discovered = loader.getAgentsFiles().agentsFiles;
console.log("Discovered context files:");
for (const file of discovered) {
	// content.length 是 UTF-16 码元数量，不是字节数，也不完全等于可见字符数（emoji 会占两个码元）。
	console.log(`  - ${file.path} (${file.content.length} chars)`);
}

// 用同一个加载器装配会话；inMemory 历史不写文件。创建会话不会主动读取文件内容。
const { session } = await createAgentSession({
	resourceLoader: loader,
	sessionManager: SessionManager.inMemory(),
});
// 注意：discovered 已经包含虚拟文件，这里的 +1 会让打印数量比实际数组长度多一；
// 原示例保留该表达式，实际计数应使用 discovered.length。
console.log(`Session created with ${discovered.length + 1} context files`);
// 立即释放；没有运行提示词，因此不会产生模型请求。
session.dispose();
