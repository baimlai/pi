/**
 * Prompt Templates
 *
 * File-based templates that inject content when invoked with /templatename.
 *
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/sdk，SDK 示例系列第 08 个。上游由
 * `node examples/sdk/08-prompt-templates.ts` 直接运行（需先构建工作区）；下游用
 * DefaultResourceLoader 的 promptsOverride 追加一个内存模板，再把加载器交给 createAgentSession。
 *
 * 演示什么：提示词模板是 Markdown 片段，用户输入 /deploy 时由 AgentSession.prompt 默认展开
 * 为模板正文（可带参数占位符）。PromptTemplate 包含 name、description、filePath、sourceInfo、
 * content 等字段；filePath 用于来源展示，正文已放在 content 中，不需要立即读磁盘。本例追加
 * 的模板指向 /virtual 路径，仅作示范。脚本不发送模型消息；创建会话后立即释放。
 *
 * 能力清单（按调用顺序）：
 * - PromptTemplate 与 createSyntheticSourceInfo：构造模板元数据。
 * - new DefaultResourceLoader({ promptsOverride })：在发现结果上追加模板。
 * - loader.reload()：执行模板发现/覆盖。
 * - loader.getPrompts()：读取 { prompts, diagnostics }。
 * - createAgentSession({ resourceLoader, sessionManager })：装配可识别 /deploy 的会话。
 *
 * 典型运行顺序与预期输出：
 *   1. 运行脚本；打印 `Discovered prompt templates:`。
 *   2. 每行显示 `/名称: 描述`，其中包含追加的 /deploy。
 *   3. 打印会话创建提示后立即 dispose；没有模型请求，也不写文件。
 *
 * 示例（真实签名，运行时会展开模板）：
 *   const { session } = await createAgentSession({ resourceLoader: loader });
 *   await session.prompt("/deploy"); // 默认 expandPromptTemplates=true，会发送模板正文
 *   若传 { expandPromptTemplates: false }，同一串文字会作为普通用户消息发送。
 *
 * 建议阅读顺序：先看 PromptTemplate 字段与 content，再看 promptsOverride 的合并方式，
 * 最后看 getPrompts 的返回值与末尾计数表达式。
 */

// createSyntheticSourceInfo 生成来源元信息；type PromptTemplate 只参与编译期检查。
import {
	createAgentSession,
	createSyntheticSourceInfo,
	DefaultResourceLoader,
	getAgentDir,
	type PromptTemplate,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

// Define custom templates
// 构造模板对象；: PromptTemplate 不校验运行时内容，缺字段会在编译期报错。
const deployTemplate: PromptTemplate = {
	// 命令名：用户用 /deploy 调用。
	name: "deploy",
	// 命令列表中的说明文字。
	description: "Deploy the application",
	// 模板文件路径，用于来源展示；本例不读取该路径。
	filePath: "/virtual/prompts/deploy.md",
	// 来源标为 sdk；scope 默认 temporary，origin 默认 top-level。
	sourceInfo: createSyntheticSourceInfo("/virtual/prompts/deploy.md", { source: "sdk" }),
	// 模板正文；展开时原样注入用户消息，参数占位符在展开阶段处理。
	content: `# Deploy Instructions

1. Build: npm run build
2. Test: npm test
3. Deploy: npm run deploy`,
};

// 创建加载器；promptsOverride 在发现完成后执行。
const loader = new DefaultResourceLoader({
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	// current 含 { prompts, diagnostics }；返回新对象，不修改原数组。
	promptsOverride: (current) => ({
		// 展开现有模板再追加 deploy；同名冲突是否保留首项由加载器上层规则处理。
		prompts: [...current.prompts, deployTemplate],
		// 原样保留发现诊断。
		diagnostics: current.diagnostics,
	}),
});
// 执行发现/覆盖，缓存最终模板列表。
await loader.reload();

// Discover templates from cwd/.pi/prompts/ and ~/.pi/agent/prompts/
// 读取缓存结果；discovered 已包含 override 追加的 deploy。
const discovered = loader.getPrompts().prompts;
console.log("Discovered prompt templates:");
for (const template of discovered) {
	// 用 / 前缀展示调用形式；description 可能为空字符串。
	console.log(`  /${template.name}: ${template.description}`);
}

// 会话将识别这些模板，但创建本身不会发送模型请求。
const { session } = await createAgentSession({
	resourceLoader: loader,
	sessionManager: SessionManager.inMemory(),
});
// 与 07 相同的计数说明：discovered 已包含追加项，+1 会让打印数比实际多一。
console.log(`Session created with ${discovered.length + 1} prompt templates`);
// 立即释放；示例没有调用 prompt("/deploy")。
session.dispose();
