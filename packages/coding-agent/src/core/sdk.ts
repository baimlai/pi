// SDK 会话装配入口：把模型、配置、历史、工具和扩展接入 AgentSession；CLI 与嵌入式应用复用它，实际问答由稍后 session.prompt 触发。
// 配置文件路径用 Node 的平台路径拼接函数构造。
import { join } from "node:path";
// Agent 是运行时类；AgentMessage/ThinkingLevel 前的 type 表示只导入类型；setDefaultStreamFn 注册兼容默认请求函数。
import { Agent, type AgentMessage, setDefaultStreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
// 模型运行时简单流请求选项类型，后面的索引访问类型也从这里取得回调签名。
import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
// compat 入口提供旧式请求兼容函数、能力限制助手及消息/模型类型。
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
// 统一获取用户配置根目录，避免由 SDK 自行猜路径。
import { getAgentDir } from "../config.ts";
// 将输入工作目录规范成绝对路径，不在这里验证目录存在。
import { resolvePath } from "../utils/paths.ts";
// 上层会话类管理消息、工具、扩展与压缩；标记函数记录请求认证由运行时负责。
import { AgentSession, markRuntimeStreamFunction } from "./agent-session.ts";
// 构造无可用模型时的可操作提示，不直接打印。
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
// 缓存保温器按策略保留/预热模型请求上下文，并非创建它就立刻发送模型请求。
import { CacheWarmer } from "./cache-warmer.ts";
// 从设置生成请求客户端身份信息，供实际请求使用。
import { getClientIdentity } from "./client-identity.ts";
// 导入内置思考级别兜底值，优先级低于显式、历史和配置选择。
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
// 扩展运行器、资源加载结果、启动事件和自定义工具的类型契约。
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
// 工具名/模式匹配器供排除规则使用。
import { createToolNameMatcher } from "./mcp-servers.ts";
// 将 coding-agent 特有消息转换成模型认识的消息格式。
import { convertToLlm } from "./messages.ts";
// 模型默认选择规则集中在 model-resolver，不在这里重复实现。
import { findInitialModel } from "./model-resolver.ts";
// 共享认证、模型目录和供应商路由的运行时对象。
import { ModelRuntime } from "./model-runtime.ts";
// ResourceLoader 接口可被 SDK 调用者替换。
import type { ResourceLoader } from "./resource-loader.ts";
// 没传加载器时使用默认资源发现实现。
import { DefaultResourceLoader } from "./resource-loader.ts";
// SessionManager 管历史；getDefaultSessionDir 按 cwd/agentDir 定位默认会话目录。
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
// 分组导入设置对象及工具选择规则。
import {
	// 在默认工具名单上应用 +name/-name 的纯名单变换。
	applyToolModifiers,
	// 无设置覆盖时的内置工具名称列表。
	DEFAULT_TOOL_NAMES,
	// 检查工具列表是否混用修饰项与白名单等不合法组合。
	getToolListError,
	// 判断名称是否为增删修饰项，不执行工具。
	isToolModifier,
	// 设置读取/持久化入口，会话请求中也动态读取它。
	SettingsManager,
	// 这些名字来自同一设置模块。
} from "./settings-manager.ts";
// 记录启动装配阶段的性能时间点，不影响模型输出。
import { time } from "./timings.ts";
// 工具工厂被导入后作为 SDK 公共能力重导出；这里并没有马上创建所有工具。
import {
	// 按 cwd 创建 Bash 执行工具的工厂。
	createBashTool,
	// 创建默认可读写编码工具集合的工厂。
	createCodingTools,
	// 创建字符串替换编辑工具的工厂。
	createEditTool,
	// 创建文件名查找工具的工厂。
	createFindTool,
	// 创建文本搜索工具的工厂。
	createGrepTool,
	// 创建目录列表工具的工厂。
	createLsTool,
	// 创建 PowerShell 执行工具的工厂。
	createPowerShellTool,
	// 创建默认只读工具集合的工厂。
	createReadOnlyTools,
	// 创建文本/图片读取工具的工厂。
	createReadTool,
	// 创建整文件写入工具的工厂。
	createWriteTool,
	// 给文件修改操作加同文件串行队列的包装器。
	withFileMutationQueue,
	// 这些工厂来自已统一定义的平台/目录工具入口。
} from "./tools/index.ts";
// 从历史分支恢复模型选择；虚拟模型不能仅凭 assistant 的物理模型名恢复。
import { getBranchSelection } from "./virtual-models.ts";

// Preserve the pre-0.81 fallback for extensions that construct Agent instances
// or invoke low-level agent loops without supplying streamFn. Agent core remains
// provider-agnostic and does not import pi-ai/compat itself.
// 模块被导入时注册兼容默认函数；这是配置函数引用，不是在此调用 streamSimple 请求模型。
setDefaultStreamFn(streamSimple);

// SDK 输入接口，? 都是可省略属性；类型约束不替代来自外部数据的运行时校验。
export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	// 项目资源发现和相对工具路径的 cwd；可从传入 SessionManager 继承。
	cwd?: string;
	/** Global config directory. Default: ~/.pi/agent */
	// 用户配置目录，区别于项目 cwd；省略使用默认根。
	agentDir?: string;

	/** Canonical model/auth runtime. Defaults to a runtime using agentDir/auth.json and models.json. */
	// 可传现成模型运行时以共享凭证和扩展模型注册，避免重建。
	modelRuntime?: ModelRuntime;

	/** Model to use. Default: from settings, else first available */
	// 显式模型优先于历史/设置恢复；既有 any 用于兼容不同 API 的 Model 泛型。
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	// 显式思考级别，最终还要按模型支持能力收窄。
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	// 模型循环候选数组；每项可指定切换时思考级别，未指定则继承当前值。
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, edit, write)
	 *   but keep extension/custom tools enabled
	 */
	// all 抑制全部默认工具，builtin 只抑制默认内置工具，扩展/自定义工具处理还有后续规则。
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names or patterns, where `*` matches any characters.
	 *
	 * When omitted, pi uses the resolved `defaultTools` setting for the initial
	 * selection when configured. Otherwise it enables the default built-in tools
	 * (read, bash, edit, write). Extension/custom tools remain enabled unless
	 * `noTools` changes that default. When provided, only matching tools are
	 * enabled. MCP tools stay registered for codemode and tool search unless an
	 * entry starts with `mcp__`; then only matching MCP tools are kept. An empty
	 * list, like `noTools: "all"`, disables MCP tools too.
	 *
	 * A list of only `+name` and `-name` entries is not an allowlist: it adds tools
	 * to or removes them from the default selection, like the `defaultTools` setting.
	 * These entries take exact names. Mixing them with plain entries throws.
	 */
	// 普通列表是允许名单/模式；全为 +name/-name 则修改默认名单；两者混用会抛错。
	tools?: string[];
	/**
	 * Optional denylist of tool names or patterns to disable. Applies after `tools` when both are
	 * provided, MCP tools included.
	 */
	// 排除名称或模式，最终可覆盖前面的允许名单，MCP 工具也适用。
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	// 附加注册的工具定义，实际执行发生在模型发出工具调用后。
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	// 自定义资源加载器必须由调用者准备好；传入后这里不会自动 reload 它。
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	// 指定历史管理器即可恢复文件或使用内存历史；没有 continueSession 这个当前接口属性。
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	// 可传共享设置管理器；否则按 cwd/agentDir 创建。
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	// 扩展初始化需要的启动来源信息，例如 resume/fork。
	sessionStartEvent?: SessionStartEvent;
}

/** Result from createAgentSession */
// 工厂返回对象的类型；解构 session 后才能进一步 prompt。
export interface CreateAgentSessionResult {
	/** The created session */
	// 创建后的上层会话对象，有 prompt/subscribe/compact 等能力。
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	// 加载扩展的结果，宿主可据此初始化交互 UI。
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	// 模型恢复失败并回退时的可选提示，不是已打印的警告。
	modelFallbackMessage?: string;
}

// Re-exports

// 把运行时容器、服务工厂及相关类型统一开放给 SDK 使用者。
export * from "./agent-session-runtime.ts";
// 下面只重导出类型，不在运行时多创建对象。
export type {
	// 扩展注册工具/命令/事件时使用的 API。
	ExtensionAPI,
	// 扩展命令回调的增强上下文类型。
	ExtensionCommandContext,
	// 普通扩展事件/工具上下文类型。
	ExtensionContext,
	// 扩展工厂函数类型，传给加载器后才被执行。
	ExtensionFactory,
	// 内联扩展声明，适合嵌入宿主直接提供。
	InlineExtension,
	// 斜杠命令的展示/调用信息结构。
	SlashCommandInfo,
	// 斜杠命令来源类型，供 UI 区分内置/扩展等来源。
	SlashCommandSource,
	// 完整自定义工具声明类型。
	ToolDefinition,
	// 类型直接来自扩展公共入口，不是本文件另写一份定义。
} from "./extensions/index.ts";
// 重导出提示词模板的数据结构类型。
export type { PromptTemplate } from "./prompt-templates.ts";
// 重导出技能元数据类型，供自定义资源加载使用。
export type { Skill } from "./skills.ts";
// 重导出工具定义使用的公共 Tool 类型。
export type { Tool } from "./tools/index.ts";

// 把已导入的工具工厂/队列包装器开放出去；export 不调用这些函数。
export {
	// 自定义修改类工具也能复用同路径串行策略。
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	// 供 SDK 用户创建完整默认编码工具组。
	createCodingTools,
	// 供 SDK 用户创建只读工具组。
	createReadOnlyTools,
	// 创建绑定调用者 cwd 的读取工具。
	createReadTool,
	// 创建绑定调用者 cwd 的 Bash 工具。
	createBashTool,
	// 创建绑定调用者 cwd 的精确/模糊编辑工具。
	createEditTool,
	// 创建绑定调用者 cwd 的整文件写入工具。
	createWriteTool,
	// 创建绑定调用者 cwd 的 rg 文本搜索工具。
	createGrepTool,
	// 创建绑定调用者 cwd 的文件名查找工具。
	createFindTool,
	// 创建绑定调用者 cwd 的目录列表工具。
	createLsTool,
	// 创建绑定调用者 cwd 的 PowerShell 工具。
	createPowerShellTool,
};

// Helper Functions

// 取得默认配置目录的本地转接助手。无输入，返回字符串，无读写；例如不传 agentDir 时调用它。实际规则仍由 config.getAgentDir 统一维护。
function getDefaultAgentDir(): string {
	// 不缓存结果，当前环境变量等配置仍由 getAgentDir 决定。
	return getAgentDir();
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@earendil-works/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
// 装配会话所需对象，不是在这里处理某一句问题。一般创建一次 session，再多次 await session.prompt(...)。
// 输入是可省略 options，返回会话/扩展结果/模型回退提示；会读取配置资源、准备历史并注册回调，失败向外抛。
// 流程是补服务→恢复模型/思考→选工具→构造 Agent→记录元数据→构造 AgentSession。示例 await createAgentSession({sessionManager:SessionManager.open(path)}) 恢复历史。
// 上方保留的旧英文 continueSession 示例与当前接口不一致；当前恢复入口是 sessionManager，不应照抄该旧属性。
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	// 确定工作目录，影响相对文件路径和项目资源发现；优先显式 cwd，再取会话目录，最后取进程目录。
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	// 确定 Pi 配置目录，默认 ~/.pi/agent；它不是用户项目的源码目录。
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	// 允许调用者传入资源加载器；没有时下面创建默认实现。
	let resourceLoader = options.resourceLoader;

	// 只有显式 agentDir 才传具体认证路径；否则让 ModelRuntime 使用其默认配置路径。
	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	// 模型配置文件路径与自定义 agentDir 一起确定。
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	// 创建/复用模型与认证运行时；后面的每次模型请求都通过它路由到实际供应商。
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));

	// 读取全局/项目设置，例如默认模型、工具、压缩阈值。
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	// 默认创建可持久化会话记录；可以显式传 SessionManager.inMemory() 只保存在内存。
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	// 调用者没有传资源加载器时才负责创建并加载默认资源。
	if (!resourceLoader) {
		// 把已确定目录与同一设置实例交给默认加载器。
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		// 等待资源发现与扩展执行完成，后面才能读取它们的定义。
		await resourceLoader.reload();
		// 记录加载阶段结束时间，方便启动性能分析。
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore
	// 恢复当前分支的有效消息；压缩过的历史会按投影规则呈现，不是把全部原始日志直接发模型。
	const existingSession = sessionManager.buildSessionContext();
	// 有恢复消息表示这是已有会话；后面会尝试恢复模型和思考级别。
	const hasExistingSession = existingSession.messages.length > 0;
	// some 找出分支是否有思考级别变更记录，区分旧版缺元数据与明确保存 off 等状态。
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	// 可变局部模型选择从显式输入开始，后面只在缺失时恢复/兜底。
	let model = options.model;
	// 可选回退消息初始为 undefined，只有恢复失败等情况才赋值。
	let modelFallbackMessage: string | undefined;

	// Assistant messages name the physical model that answered, so a virtual selection is only in
	// model_change entries.
	// 解析当前分支保存的模型选择；回调输入 provider/modelId，返回目录中的元数据，不请求模型。
	const sessionModel = getBranchSelection(sessionManager.getBranch(), (provider, modelId) =>
		// 向共享运行时查询已注册模型，允许虚拟选择识别。
		modelRuntime.getModel(provider, modelId),
	);

	// If session has data, try to restore model from it
	// 必须同时满足未指定模型、有已有消息、历史有模型选择，才尝试恢复。
	if (!model && hasExistingSession && sessionModel) {
		// 依据历史 provider/id 在当前目录中查模型。
		const restoredModel = modelRuntime.getModel(sessionModel.provider, sessionModel.modelId);
		// 模型仍存在且供应商具有配置认证状态才恢复；这不是一次实时可用性调用。
		if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			// 保留历史模型作为本会话选择。
			model = restoredModel;
		}
		// 查无模型或缺认证时准备提示，后面继续尝试默认选择。
		if (!model) {
			// 记录无法恢复的历史 provider/id，不在此打印。
			modelFallbackMessage = `Could not restore model ${sessionModel.provider}/${sessionModel.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	// 前面的显式/恢复都没有模型才进入默认选择。
	if (!model) {
		// 等待模型解析器按设置与供应商默认规则选择。
		const result = await findInitialModel({
			// 这里不再应用候选范围；CLI 若需范围选择，会在上游显式给 options.model。
			scopedModels: [],
			// 把已有会话状态传入，供解析器决定延续会话的默认行为。
			isContinuing: hasExistingSession,
			// 全局/项目合并设置里的默认供应商。
			defaultProvider: settingsManager.getDefaultProvider(),
			// 默认模型 id，与 provider 配成选择。
			defaultModelId: settingsManager.getDefaultModel(),
			// 默认思考配置供模型选择器使用。
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			// 所有按模型覆盖的思考设置供解析器参考。
			modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
			// 共享模型/认证运行时，让会话和模型请求函数使用一致的配置。
			modelRuntime,
		});
		// 保存解析结果中的模型；没有可用模型仍可能是 undefined。
		model = result.model;
		// 默认选择也失败时，需要无模型提示。
		if (!model) {
			// 用统一认证引导文字替换回退提示，宿主可决定展示方式。
			modelFallbackMessage = formatNoModelsAvailableMessage();
			// 若模型选到了但之前恢复失败，补上实际回退目标。
		} else if (modelFallbackMessage) {
			// += 追加新选择信息到已有字符串，不改变模型对象。
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	// 显式思考级别拥有最高优先级；undefined 才允许后面恢复/兜底。
	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	// 已有会话且无显式覆盖，优先考虑历史思考级别。
	if (thinkingLevel === undefined && hasExistingSession) {
		// 用是否有元数据条目区分历史真实选择和旧版默认投影。
		thinkingLevel = hasThinkingEntry
			? // as ThinkingLevel 告诉 TS 该历史值按思考级别处理，不做转换/验证。
				(existingSession.thinkingLevel as ThinkingLevel)
			: // 旧版没有思考记录时，用设置默认，再回退内置默认。
				(settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to per-model override, then global default
	// 还没有级别并已有模型时，再查该模型独有设置。
	if (thinkingLevel === undefined && model) {
		// 用模型 provider/id 读取其覆盖值。
		const perModel = settingsManager.getModelThinkingLevel(model.provider, model.id);
		// 配置了覆盖值才采用，未配置继续后面的通用默认。
		if (perModel) {
			// 保存该模型的专属级别。
			thinkingLevel = perModel;
		}
	}
	// 前面仍未确定级别，最后用全局/项目合并默认。
	if (thinkingLevel === undefined) {
		// ?? 只在设置未定义时取 DEFAULT_THINKING_LEVEL，不会把 off 当缺失。
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	// 没有模型时无法启用模型思考能力。
	if (!model) {
		// 强制把有效级别设成 off。
		thinkingLevel = "off";
		// 有模型时按其能力处理现有选择。
	} else {
		// clampThinkingLevel 返回该模型支持的级别；as 只缩窄 TS 类型，能力处理在函数内部。
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	// 显式工具列表先验证格式，区分纯修饰列表与普通允许名单。
	const toolListError = options.tools ? getToolListError(options.tools) : undefined;
	// 格式错误直接抛出，避免静默使用错误权限/选择规则。
	if (toolListError) throw new Error(`Invalid tools option: ${toolListError}`);
	// 任何 noTools 模式先清空内置默认起点，否则读取设置或默认内置名单。
	const defaultToolNames = options.noTools ? [] : (settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES);
	// A `tools` list of only `+name`/`-name` entries changes the default selection instead of
	// replacing it, like the `defaultTools` setting.
	// 可选链调用 some：列表里存在修饰项才按修饰路径处理；前面校验确保不会混搭。
	const toolModifiers = options.tools?.some(isToolModifier) ? options.tools : undefined;
	// 修饰列表以默认名单为起点应用增删；普通列表则原样作显式选择。
	const selectedToolNames = toolModifiers ? applyToolModifiers(defaultToolNames, toolModifiers) : options.tools;
	// 允许名单与初始活跃名单分开：扩展/MCP 注册及默认选择还需要保留模式语义。
	const allowedToolNames = toolModifiers
		? // 修饰项存在时，只有 noTools:all 才把修改结果也当完整允许名单。
			options.noTools === "all"
			? // all 从空起点加出的名字明确限定所有工具范围。
				selectedToolNames
			: // 其他修饰模式不产生完整允许名单，扩展工具仍按后续默认规则处理。
				undefined
		: // 普通 tools 显式作允许名单；未指定且 all 时使用空名单；其余不设白名单。
			(options.tools ?? (options.noTools === "all" ? [] : undefined));
	// 保存排除名单供初始筛选及后续工具注册使用。
	const excludedToolNames = options.excludeTools;
	// 有排除列表才编译名称/模式匹配函数，避免重复解析每个模式。
	const isExcludedTool = excludedToolNames ? createToolNameMatcher(excludedToolNames) : undefined;
	// filter 产出初始活跃工具名；可选匹配器缺失时 !undefined 为 true，全部保留。
	const initialActiveToolNames = (selectedToolNames ?? defaultToolNames).filter((name) => !isExcludedTool?.(name));

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	// 注册消息转换函数；名字虽长，主要是转换自定义消息，再按设置屏蔽图片。
	// 转换回调输入 Agent 消息数组，返回模型 Message 数组，不发送请求。
	// 先调用 convertToLlm，再动态读取 blockImages；如用户块含图片，替换成文字并折叠连续占位符，保留其他块。
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		// 先将 coding-agent 的 custom/bash/摘要等消息转成模型消息格式；不是调用模型。
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		// 每次转换时读设置，让会话中途屏蔽图片立即生效。
		if (!settingsManager.getBlockImages()) {
			// 没屏蔽图片直接返回转换结果，不做逐块遍历。
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		// map 回调逐条处理消息，返回新外层数组；不需要改动的项复用原对象。
		return converted.map((msg) => {
			// 这里只检查 user/toolResult 两种可能携带图片输入的角色。
			if (msg.role === "user" || msg.role === "toolResult") {
				// 保存 content 联合类型值供下面收窄。
				const content = msg.content;
				// content 合法类型既可能是字符串也可能是块数组，Array.isArray 区分这两个分支。
				if (Array.isArray(content)) {
					// some 只需找到一个 image 块就说明要替换。
					const hasImages = content.some((c) => c.type === "image");
					// 没有图片就不复制该消息内容。
					if (hasImages) {
						// 从原内容数组生成过滤后的新数组。
						const filteredContent = content
							// map 回调输入一个内容块，输出替代文本块或原块，无额外副作用。
							.map((c) =>
								// image 变为文字；as const 保持 type 是字面量 text，方便 TS 识别消息块判别字段。
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							// 随后 filter 去掉相邻重复占位文本，避免一串图片膨胀成重复提示。
							.filter(
								// 回调参数 c/i/arr 分别为替换后的当前块、索引、完整映射数组，返回是否保留。
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									// ! 把“当前项是连续重复占位符”的条件反转成 filter 的保留条件。
									!(
										// 先确保当前块是文本再访问 text，利用判别字段收窄联合类型。
										(
											c.type === "text" &&
											// 仅对固定图片禁用占位文字去重，其他正常文本不合并。
											c.text === "Image reading is disabled." &&
											// 第一项没有前驱，必须保留，避免访问负索引。
											i > 0 &&
											// 前一个块也必须是文本，才能比较其 text。
											arr[i - 1].type === "text" &&
											// 断言前项为文本结构后比较内容；相同连续占位符会被过滤，断言不产生运行时转换。
											(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
										)
									),
							);
						// 对象展开复制消息元数据，仅替换 content；没有改写原消息。
						return { ...msg, content: filteredContent };
					}
				}
			}
			// 非目标角色、字符串内容或没有图片时，返回原消息引用。
			return msg;
		});
	};

	// 共享引用盒子：稍后 AgentSession 创建扩展运行器后填 current，已注册的回调能读到最新值。
	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	// 创建缓存保温策略对象并交给会话管理；构造与后面 start 都不意味着每次问题一定多发一次请求。
	const cacheWarmer = new CacheWarmer(
		// 共享模型/认证运行时，让会话和模型请求函数使用一致的配置。
		modelRuntime,
		// 负责会话条目、分支、投影与可选 JSONL 保存。
		sessionManager,
		// 无参回调在保温器需要时读取当前模式，返回值，不修改设置；例如中途关闭模式可立即被观察到。
		() => settingsManager.getCacheWarmingMode(),
		// 决策回调接收事件，异步委托当前扩展；没有运行器则用原 action。此处注册闭包，真正事件由保温器后续触发。
		async (event) => extensionRunnerRef.current?.emitCacheWarmingDecision(event) ?? event.action,
	);
	// 每次请求才读取超时、重试等设置，使会话中途改配置也能生效。
	// 请求选项工厂输入可选本次覆盖对象，返回合并结果，无请求副作用。
	// 动态读超时/重试/身份，并构造请求头回调；例如本次 timeoutMs 显式值优先于设置。
	const buildRequestOptions = (options: ModelsSimpleStreamOptions = {}): ModelsSimpleStreamOptions => {
		// 读取供应商重试次数、超时和重试延迟设置。
		const providerRetrySettings = settingsManager.getProviderRetrySettings();
		// 读取 HTTP 空闲超时毫秒数，0 在配置层表示禁用。
		const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
		// 把 0 映射成最大 32 位定时器值，作为实际请求超时的近似禁用方案。
		const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
		// 为本次请求捕获当前扩展运行器，下面 header 回调用同一引用。
		const headerRunner = extensionRunnerRef.current;
		// 返回本次请求选项：保留显式参数，再补超时、重试、身份和请求头处理回调。
		return {
			// 先保留调用者提供的其他选项，后面的同名字段再按明确优先级补值。
			...options,
			// 超时依次优先本次显式值、重试设置 timeout、HTTP 设置换算值。
			timeoutMs: options.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs,
			// WebSocket 建连超时独立于 HTTP 空闲超时，显式覆盖优先。
			websocketConnectTimeoutMs: options.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs(),
			// 重试次数显式参数优先，再使用实时设置。
			maxRetries: options.maxRetries ?? providerRetrySettings.maxRetries,
			// 单次重试等待上限显式参数优先。
			maxRetryDelayMs: options.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
			// Replaces the agent loop's default identity; read per request so telemetry changes apply at once.
			// 每次构造选项时按当前分析/遥测设置生成客户端身份，覆盖 Agent 循环默认值，不缓存旧设置。
			identity: getClientIdentity(settingsManager),
			// 请求头变换回调输入 headers，返回保留或扩展修改后的头；注册时不运行。async 统一返回 Promise，扩展错误按运行器语义传播。
			transformHeaders: async (headers) =>
				// 只有存在 before_provider_headers 处理器才委托。
				headerRunner?.hasHandlers("before_provider_headers")
					? // 实际调用时等待/转交扩展生成的新请求头。
						headerRunner.emitBeforeProviderHeaders(headers)
					: // 没有处理器保持传入头不变。
						headers,
		};
	};
	// Warm only requests for the selected model. Requests a virtual selection routed, or that an
	// extension redirected, may not be repeated by the next request, so warming them could be wasted.
	// 为缓存保温生成“上下文仍有效”检查闭包。输入请求模型，返回无参 boolean 检查器；不发请求。
	// 捕获当时消息，之后比较 provider/id 与消息前缀引用，例如只追加回复仍有效，换分支/改旧消息会失效。
	const cacheContextIsCurrent = (requestModel: Model<any>) => {
		// 捕获当前消息数组引用，之后并不要求新数组本身与它同一引用。
		const messages = agent.state.messages;
		// 返回闭包，让保温器在未来执行检查，而不是创建时就给出一次固定结果。
		return () => {
			// 每次检查重新读取当前选择的模型。
			const currentModel = agent.state.model;
			// 每次检查重新读取当前会话消息。
			const currentMessages = agent.state.messages;
			// 只有下面四个条件全满足才允许继续把旧请求当保温目标。
			return (
				// 供应商必须与请求时相同，避免跨供应商复用判断。
				currentModel.provider === requestModel.provider &&
				// 模型 id 也必须相同；不比较整个模型对象引用。
				currentModel.id === requestModel.id &&
				// 当前历史不能比捕获历史短，截断/回退会让目标失效。
				messages.length <= currentMessages.length &&
				// every 逐项比较消息对象引用，要求原历史仍是当前前缀，允许只追加新消息。
				messages.every((message, index) => currentMessages[index] === message)
			);
		};
	};
	// 请求体回调接收 unknown 供应商载荷，异步返回扩展结果或原值，不自行发送请求。
	// 例如扩展订阅 before_provider_request 时可处理真实供应商格式；unknown 要由处理方按供应商解释。
	const transformProviderPayload = async (payload: unknown) => {
		// 执行回调时再读取扩展运行器，重载扩展后也能用到新对象。
		const runner = extensionRunnerRef.current;
		// 无对应处理器时原样返回载荷，不做不必要的结构猜测。
		if (!runner?.hasHandlers("before_provider_request")) return payload;
		// 把载荷交给当前扩展请求前钩子，并转交其异步结果。
		return runner.emitBeforeProviderRequest(payload);
	};
	// 响应头回调输入响应元数据、异步无值返回，负责通知扩展。NonNullable 去掉可选 onResponse 中的 undefined，再沿用其签名；不是处理完整助手回复。
	// 例如 HTTP 200 返回头后分发 after_provider_response。
	const handleProviderResponse: NonNullable<ModelsSimpleStreamOptions["onResponse"]> = async (response) => {
		// 执行回调时再读取扩展运行器，重载扩展后也能用到新对象。
		const runner = extensionRunnerRef.current;
		// 未订阅该事件就立即结束，不生成多余事件。
		if (!runner?.hasHandlers("after_provider_response")) return;
		// 等待扩展处理响应头通知。
		await runner.emit({
			// 事件类型限定为供应商响应头事件。
			type: "after_provider_response",
			// 传递响应状态码，不在这里把非 2xx 转成模型错误。
			status: response.status,
			// 传递供应商响应头。
			headers: response.headers,
		});
	};
	// 原始流事件回调接收供应商事件 data 和模型元数据，异步通知扩展，无返回内容。
	// 索引访问类型取 onProviderStreamEvent 的原签名；例如扩展可观察某 API 的原始 delta，但它不是 Agent 的标准消息事件。
	const handleProviderStreamEvent: NonNullable<ModelsSimpleStreamOptions["onProviderStreamEvent"]> = async (
		// 供应商特定原始事件，具体结构由其协议决定。
		data,
		// 当前模型选择，是一个含 provider/id 等信息的对象，不是正在运行的模型实例。
		model,
		// 箭头函数体在流事件到达时运行，当前仅注册函数。
	) => {
		// 执行回调时再读取扩展运行器，重载扩展后也能用到新对象。
		const runner = extensionRunnerRef.current;
		// 没有 provider_stream_event 订阅就跳过。
		if (!runner?.hasHandlers("provider_stream_event")) return;
		// 等待扩展处理当前原始流事件。
		await runner.emit({
			// 保留原始数据供扩展分析。
			data,
			// 公共扩展事件判别字段。
			type: "provider_stream_event",
			// 附带供应商名，帮助解释 data。
			provider: model.provider,
			// 附带模型使用的 API 标识。
			api: model.api,
			// 附带具体模型 id。
			model: model.id,
		});
	};

	// 创建低层 Agent，负责模型/工具循环；下面把 coding-agent 特有能力以回调形式交给它。
	const agent = new Agent({
		// Agent 起始状态；若恢复已有会话，就从旧历史继续。
		initialState: {
			// 先给空提示词；AgentSession 会根据资源、工具和扩展构造实际 system 内容。
			systemPrompt: "",
			// 当前模型选择，是一个含 provider/id 等信息的对象，不是正在运行的模型实例。
			model,
			// 当前思考级别，前面已经按模型能力限制到支持范围。
			thinkingLevel,
			// 这里先为空；稍后 AgentSession 的工具注册过程填入实际可执行工具。
			tools: [],
			// 放入已恢复的历史；之后每次 prompt 在这份会话基础上追加。
			messages: existingSession.messages,
		},
		// 传函数引用；真正调用发生在 agent-loop.ts 的模型请求边界。
		convertToLlm: convertToLlmWithBlockImages,
		// 关键接线：低层 Agent 以后通过这段回调请求模型；构造 Agent 时不会立即执行它。
		// 模型请求回调输入 model/context/options，异步返回流；实际执行才读选项、更新保温目标并调用运行时。
		// 例如 session.prompt 最后进入 Agent 循环时才走这里，构造 Agent 本身没有开始对话。
		streamFn: async (model, context, options) => {
			// 合并本次请求参数与实时设置，得到 ModelRuntime 使用的 options。
			const requestOptions = buildRequestOptions(options);
			// Compaction and summaries use their own routing ids; only session requests
			// replace the cache entry, so warming restarts from them. Keep warming while
			// the current transcript still extends the request's prefix. Agent state may
			// shallow-copy the messages array or refresh the model object without changing
			// the provider request, so top-level object identity is not a valid cache key.
			// 只有本会话的普通请求才替换缓存保温目标，摘要等独立请求不应替换它。
			if (options?.sessionId === sessionManager.getSessionId()) {
				// 登记缓存保温目标；实际是否保温由策略决定，不表示每次 prompt 必然额外发请求。
				cacheWarmer.start({ model, context, options: requestOptions }, cacheContextIsCurrent(model));
			}
			// 生产路径进入 ModelRuntime；它从 Models 取 Provider，处理认证后直接调用 provider.streamSimple。
			return modelRuntime.streamSimple(model, context, requestOptions);
		},
		// 供应商请求体构造后，让扩展有机会处理它。
		onPayload: transformProviderPayload,
		// 收到响应头时通知扩展；它不是完整 assistant 回答事件。
		onResponse: handleProviderResponse,
		// 将供应商原始流事件交给有需要的扩展观察。
		onProviderStreamEvent: handleProviderStreamEvent,
		// 给请求带上会话 id；缓存优化可能使用它，但聊天历史仍必须通过 messages 传递。
		sessionId: sessionManager.getSessionId(),
		// 请求前把上下文交给扩展；外层会话还会继续包装这个变换。
		// 上下文变换回调输入 Agent 消息，异步返回可用于后续转换的消息数组，副作用由扩展决定。
		// 例如 context 扩展可裁剪工具结果；这里仅保存回调，真正请求前才执行。
		transformContext: async (messages) => {
			// 执行回调时再读取扩展运行器，重载扩展后也能用到新对象。
			const runner = extensionRunnerRef.current;
			// 还没有扩展运行器时直接保留原上下文。
			if (!runner) return messages;
			// 调用扩展 context 处理器，取得本次请求使用的消息。
			return runner.emitContext(messages);
		},
		// 设置 steering 队列的出队策略：用于当前回合执行中插入的用户引导消息。
		steeringMode: settingsManager.getSteeringMode(),
		// 设置 follow-up 队列策略：用于当前工作结束后继续处理的消息。
		followUpMode: settingsManager.getFollowUpMode(),
		// 读取供应商传输偏好，例如流式传输模式，具体支持由运行时/供应商决定。
		transport: settingsManager.getTransport(),
		// 传入各思考级别预算配置，并非马上消耗 token。
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		// 设置 Agent 层可接受的供应商重试等待上限，详细每次请求选项还会动态合并。
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});
	// This stream resolves auth through modelRuntime, so summaries must not pre-resolve it (#11520).
	// 标记该请求函数已自行处理认证，避免摘要请求重复预解析 OAuth 等凭证。
	markRuntimeStreamFunction(agent.streamFunction, modelRuntime);

	// Restore missing settings metadata for older sessions.
	// 已有消息的会话只补旧版缺少的设置元数据。
	if (hasExistingSession) {
		// 没有思考变更条目才补，避免每次恢复重复追加。
		if (!hasThinkingEntry) {
			// 将本次解析的有效级别写入历史元数据，供下次恢复。
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
		// 没有已有消息时按新会话记录初始选择。
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		// 只有选到模型才能写 provider/id。
		if (model) {
			// 保存初始模型选择；这不是保存一条 assistant 回答。
			sessionManager.appendModelChange(model.provider, model.id);
		}
		// 即使暂时没有模型，也记录最终有效思考级别，例如 off。
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	// 把 Agent、日志、配置、工具、扩展组成上层会话；用户平时调用的是这个 session。
	const session = new AgentSession({
		// 交给会话层管理的低层 Agent 实例。
		agent,
		// 负责会话条目、分支、投影与可选 JSONL 保存。
		sessionManager,
		// 提供配置读取与更新，供请求前准备、工具和压缩使用。
		settingsManager,
		// 项目工作目录，read("decision.txt") 等相对路径以此为基准。
		cwd,
		// 提供 UI 模型循环候选，SDK 不在这里循环切换。
		scopedModels: options.scopedModels,
		// 给上层会话共享资源加载器，系统提示词和扩展工具从中取得。
		resourceLoader,
		// 把额外自定义工具定义交给会话统一注册。
		customTools: options.customTools,
		// 共享模型/认证运行时，让会话和模型请求函数使用一致的配置。
		modelRuntime,
		// 把保温器交给会话生命周期管理，后续请求/关闭才能协调保温任务。
		cacheWarmer,
		// 初始化活跃工具名称，最终可执行集合由会话注册逻辑补齐。
		initialActiveToolNames,
		// 只有未显式替换名单或使用增删修饰，且未抑制默认工具时，才保留“使用默认工具”标记。
		usesDefaultTools: (options.tools === undefined || toolModifiers !== undefined) && !options.noTools,
		// 保存默认工具增删规则，后续设置/资源重载可重新应用。
		defaultToolModifiers: toolModifiers,
		// 传递完整允许名单，供扩展/MCP 注册和选择规则继续使用。
		allowedToolNames,
		// 传递完整排除名单，避免之后新增工具绕过禁止规则。
		excludedToolNames,
		// 把引用盒子交给会话，创建扩展运行器后会填入 current。
		extensionRunnerRef,
		// 把启动来源元数据交给扩展会话初始化。
		sessionStartEvent: options.sessionStartEvent,
	});

	// 获取最终资源加载结果；不额外 reload，不代表扩展没有加载错误。
	const extensionsResult = resourceLoader.getExtensions();

	// 返回装配结果对象；用 const { session } = await createAgentSession(...) 解构出会话。
	return {
		// 真正拿来 subscribe、prompt、compact、dispose 的会话对象。
		session,
		// 附带扩展加载结果，交互界面可以据此绑定 UI。
		extensionsResult,
		// 恢复旧模型失败时的提示信息；没有问题时通常为 undefined。
		modelFallbackMessage,
	};
}
