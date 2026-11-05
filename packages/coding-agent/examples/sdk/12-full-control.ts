/**
 * Full Control
 *
 * Replace everything - no discovery, explicit configuration.
 *
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/sdk，SDK 示例系列第 12 个。上游由
 * `node examples/sdk/12-full-control.ts` 直接运行（需先构建工作区）；下游显式构造模型运行时、
 * 设置、资源加载器、工具名单和内存历史，再交给 createAgentSession。
 *
 * 演示什么：不使用 DefaultResourceLoader 的自动发现，而是手写一个实现 ResourceLoader 接口的
 * 对象：技能/提示词/主题/AGENTS.md 全部为空，系统提示词是固定字符串，扩展运行时用
 * createExtensionRuntime() 占位。模型用 pi-ai/compat 的 getModel 从静态目录取得，凭证由
 * 自定义 authPath 或环境变量 MY_ANTHROPIC_KEY 提供。运行会真实调用 Anthropic，可能产生费用；
 * 若既没有可用凭证也没有环境变量，会话可以创建，但 prompt 会因认证失败而拒绝。
 *
 * 能力清单（按调用顺序）：
 * - getModel(provider, id)：从兼容层静态模型目录查模型，找不到返回 undefined。
 * - ModelRuntime.create({ authPath, modelsPath })：独立凭证/模型目录。
 * - setRuntimeApiKey：可选的环境变量临时 key 覆盖。
 * - SettingsManager.inMemory：无文件设置覆盖。
 * - ResourceLoader 对象字面量：提供所有资源查询/扩展/提示词方法，全部返回空或固定值。
 * - createAgentSession 显式选项：cwd、agentDir、model、thinkingLevel、tools、历史与设置。
 *
 * 典型运行顺序与预期输出：
 *   1. 运行脚本；若模型不存在立即抛错。
 *   2. 若有认证，模型回答流式写到 stdout；否则 prompt 抛认证错误。
 *   3. finally 释放会话；模型目录缓存可能写在 /tmp/my-agent 下。
 *
 * 示例（真实签名）：
 *   const model = getModel("anthropic", "claude-sonnet-4-5"); // Model<Api> | undefined
 *   if (!model) throw new Error("Model not found");
 *   const loader: ResourceLoader = {
 *     ...所有必需方法...,
 *     getSystemPrompt: () => "You are a minimal assistant.",
 *   };
 *   对象字面量必须补齐接口的每个方法；TypeScript 在这里做结构检查，不会在运行时验证返回值。
 *
 * 建议阅读顺序：先看模型与运行时的构造，再看 ResourceLoader 的每个空实现，最后看
 * createAgentSession 的全部显式选项与事件流。
 */

// compat 的 getModel 只查静态模型目录，不检查凭证；ModelRuntime 负责凭证与请求路由。
import { getModel } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

// 独立的凭证/模型目录；不读取默认 ~/.pi/agent。路径为占位，生产使用时应按应用调整。
const modelRuntime = await ModelRuntime.create({
	authPath: "/tmp/my-agent/auth.json",
	modelsPath: "/tmp/my-agent/models.json",
});
// 环境变量存在时才覆盖临时 key；空字符串也是 falsy，会跳过。
if (process.env.MY_ANTHROPIC_KEY) {
	// 进程级覆盖，不写入 auth.json。
	await modelRuntime.setRuntimeApiKey("anthropic", process.env.MY_ANTHROPIC_KEY);
}

// 从静态目录取模型元数据；这里不验证该提供商是否有可用认证。
const model = getModel("anthropic", "claude-sonnet-4-5");
// 找不到模型时无法继续装配，直接抛出；抛出后下面的会话不会创建。
if (!model) throw new Error("Model not found");

// In-memory settings with overrides
// 无文件设置：关闭压缩，开启最多两次重试；其他字段保持默认。
const settingsManager = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: true, maxRetries: 2 },
});

// 会话和工具的工作目录。
const cwd = process.cwd();

// 手写的资源加载器：实现接口全部方法，拒绝任何自动发现。: ResourceLoader 是编译期结构约束。
const resourceLoader: ResourceLoader = {
	// 扩展列表为空；createExtensionRuntime() 返回未绑定动作的运行时，绑定前调用动作会抛错。
	getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
	// 无技能、无提示词模板、无主题、无上下文文件；每个数组都是新对象。
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	// 固定系统提示词；模板字符串里的换行会保留。它不包含工具说明，工具由 tools 选项另管。
	getSystemPrompt: () => `You are a minimal assistant.
Available: read, bash. Be concise.`,
	// 没有可追踪的来源信息，返回 undefined。
	getSystemPromptSource: () => undefined,
	// 没有追加提示词，返回空数组。
	getAppendSystemPrompt: () => [],
	// 没有追加来源，返回空数组。
	getAppendSystemPromptSources: () => [],
	// 不动态添加资源；无参数、无返回值。
	extendResources: () => {},
	// 没有发现过程可重载，异步空操作。
	reload: async () => {},
};

// 显式提供几乎所有装配输入；这是本示例“完全控制”的核心。
const { session } = await createAgentSession({
	// 项目/工具目录。
	cwd,
	// 用户配置目录也指向自定义位置，避免默认扩展/设置混入。
	agentDir: "/tmp/my-agent",
	// 静态目录取到的模型对象。
	model,
	// 关闭思考（仍会按模型能力处理，但 off 通常无需额外预算）。
	thinkingLevel: "off",
	// 复用带自定义凭证的运行时。
	modelRuntime,
	// 手写加载器：不会自动 reload。
	resourceLoader,
	// 只启用 read 与 bash；不会出现 edit/write。
	tools: ["read", "bash"],
	// 内存历史，绑定同一 cwd。
	sessionManager: SessionManager.inMemory(cwd),
	// 内存设置覆盖。
	settingsManager,
});

// 流式观察、提问和清理与其他示例一致。
try {
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	// 该问题会进入真实模型请求；没有认证时以异常拒绝并进入 finally。
	await session.prompt("List files in the current directory.");
	console.log();
} finally {
	session.dispose();
}
