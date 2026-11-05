// 本文件处在 UI/RPC 与低层 Agent 之间，协调会话历史、资源、工具、模型选择、摘要与重试；不同运行模式共用它。
/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */
// Node 内置文件/路径工具：技能展开同步读文件，扩展资源定位只处理路径字符串。

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
// Agent 类型在编译后擦除；runToolCall 是实际运行值，用于嵌套工具调用共用低层执行管线。
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type Agent,
	type AgentContext,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type AgentToolCallOutcome,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	type PrepareNextTurnContext,
	runToolCall,
	type StreamFn,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
// AI 层负责从内容取文字、重放提示词/工具声明及计算退避；不在这个 import 时调用模型。
import { contentText, getCurrentSystemMessage, getCurrentTools, retryDelayMs } from "@earendil-works/pi-ai";
// compat 提供既有 Model/消息/认证/用量类型，Model<any> 是这里沿用的兼容泛型写法，不是新增运行时校验。
import type {
	AssistantMessage,
	AuthResult,
	ImageContent,
	Model,
	ProviderHeaders,
	SystemMessage,
	TextContent,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai/compat";
// 兼容层提供模型能力、错误分类、流请求和资源清理；后面的会话协调按具体条件调用它们。
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRecoverableLength,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { processImage } from "../utils/image-process.ts";
import { sleep } from "../utils/sleep.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import { generateBugReportSummary } from "./bug-report.ts";
import type { CacheWarmer, CacheWarmingStatus } from "./cache-warmer.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	// 压缩模块负责估算、切分历史及模型摘要；AgentSession 负责何时调用和如何保存结果。
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateProjectedContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "./defaults.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type AgentActivityOutcome,
	type BoundaryContextPreview,
	type ContextUsage,
	type ExecuteToolOptions,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	// 扩展模块包含事件、上下文、工具定义等契约，以及实际的 ExtensionRunner 与包装函数。
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionBoundaryDraft,
	type SessionCompactFailedEvent,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolExposure,
	type ToolInfo,
	type ToolLoadout,
	type TreePreparation,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { type BeforeAgentStartTrigger, emitSessionShutdownEvent } from "./extensions/runner.ts";
import { createToolNameMatcher, isMcpToolName } from "./mcp-servers.ts";
import { type BashExecutionMessage, type CustomMessage, convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { NestedToolCallRunner } from "./nested-tool-calls.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { exportSessionToJsonl } from "./session-export.ts";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	type ContextEditEntry,
	getLatestCompactionEntry,
	type SessionEntry,
	SessionManager,
	type SessionProjection,
} from "./session-manager.ts";
import {
	applyToolModifiers,
	type CacheWarmingMode,
	DEFAULT_TOOL_NAMES,
	type SettingsManager,
} from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { BUILTIN_PATH_PREFIX, createSyntheticSourceInfo, isSyntheticPath, type SourceInfo } from "./source-info.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	diffSystemPromptSections,
	type NormalizedBuildSystemPromptOptions,
	normalizeBuildSystemPromptOptions,
} from "./system-prompt.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { addUsageToTotals, combineUsage, createUsageTotals } from "./usage-totals.ts";
import {
	findLatestResponse,
	getBranchSelection,
	getVirtualModelState,
	isVirtualModel,
	VIRTUAL_MODEL_STATE_ENTRY,
	type VirtualModelStateData,
} from "./virtual-models.ts";

/**
 * Stream functions that resolve auth through a given ModelRuntime themselves, such as the one
 * createAgentSession installs. Summaries sent through them must not pass pre-resolved credentials:
 * the runtime would take them as an explicit API key instead of the stored OAuth login (#11520).
 */
// WeakMap 以流函数为弱键关联 runtime；不因这张表单独阻止已不用的流函数被回收。
const runtimeStreamFunctions = new WeakMap<StreamFn, ModelRuntime>();

/** Mark `streamFn` as resolving auth through `modelRuntime` on its own. */
/**
 * 登记某个流函数自行通过指定 ModelRuntime 解析认证；输入两个对象，返回 void。
 * 只更新弱引用映射，不执行流函数、不读取凭证。例：SDK 安装自己的 runtime 流函数后登记它，摘要就不再预传 apiKey，避免把 OAuth 登录误作显式 key。
 */
export function markRuntimeStreamFunction(streamFn: StreamFn, modelRuntime: ModelRuntime): void {
	// 登记同一个函数到当前 runtime；set 覆盖旧映射，返回值在此忽略。
	runtimeStreamFunctions.set(streamFn, modelRuntime);
}

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
// 接口只约束解析结果形状，不检查技能文件或执行内容；userMessage 字段必须存在但允许 undefined。
export interface ParsedSkillBlock {
	// 技能包装中 name 属性的原文字。
	name: string;
	// 技能包装中 location 属性的原文字，不代表路径已验证可读。
	location: string;
	// 闭标签前的技能正文，按正则捕获不在这里 trim。
	content: string;
	// 技能块之后的用户补充；未捕获或 trim 后为空时设 undefined。
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
/**
 * 识别整段文字是否恰好符合 skill 包装格式，返回字段对象或 null；没有 I/O。
 * 用正则提取技能名、位置、正文和可选用户补充，补充部分 trim 后为空则设 undefined。
 * 例：<skill name="review" location="/a/SKILL.md"> 后按约定换行放正文并闭合，会提取 review；它不检查该文件实际存在。
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	// ^/$ 限制整段匹配；[^"]+ 取属性，非贪婪 [\s\S]*? 允许跨行正文；最后一组补充可省略。这不是通用 XML 解析器。
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	// 没符合包装格式就返回 null，调用者可继续把它当普通文字。
	if (!match) return null;
	// 构造新对象，正则捕获组从 1 开始，0 是整段匹配。
	return {
		// 第一组为技能名称。
		name: match[1],
		// 第二组为声明的位置。
		location: match[2],
		// 第三组为技能正文。
		content: match[3],
		// ?. 允许第四组不存在；|| 将 trim 后的空字符串也转换为 undefined。
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Tool execution events of calls a tool made through `ctx.executeTool()` carry `parentToolCallId`. */
// 条件类型对事件联合逐项判断；只有工具执行事件扩展 parentToolCallId，其余事件类型保持原样。
type WithParentToolCallId<E> = E extends {
	// 条件检查只匹配三种工具执行事件的 type，其他消息/回合事件走原类型分支。
	type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
}
	? // & 为交叉类型，在原事件字段基础上加可选父调用 id；不在运行时改对象。
		E & { parentToolCallId?: string }
	: // 条件类型的 false 分支保留原事件 E，不增加父调用字段。
		E;

/** Session-specific events that extend the core AgentEvent */
// 联合类型用 type 字面量区分事件；UI/RPC 根据它收窄字段，不是运行时自动派发注册表。
export type AgentSessionEvent =
	// Exclude 去掉低层 agent_end，随后用带 willRetry 的会话版替代；其他低层事件只补嵌套调用类型。
	| WithParentToolCallId<Exclude<AgentEvent, { type: "agent_end" }>>
	| {
			// 会话版结束事件仍带本次低层运行产生的消息，但不等于整个会话已 settled。
			type: "agent_end";
			// 低层此次运行的消息列表。
			messages: AgentMessage[];
			// 普通重试是否预计继续的提示值；实际是否重试仍由后续协调决定。
			willRetry: boolean;
	  }
	// 整个会话最终收尾事件，aborted 来自会话取消标记。
	| { type: "agent_settled"; aborted: boolean }
	| {
			// 队列变化只公布两类用户文字队列的快照。
			type: "queue_update";
			// 插话文字数组，readonly 仅类型层面限制消费者修改。
			steering: readonly string[];
			// 追问文字数组，同样不包含图片或 custom 队列的全部细节。
			followUp: readonly string[];
	  }
	// 压缩开始原因：手动、接近窗口阈值或溢出恢复。
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	// 会话树已追加条目的通知，不是草稿预览。
	| { type: "entry_appended"; entry: SessionEntry }
	// 会话显示名称发生变化，允许尚未命名。
	| { type: "session_info_changed"; name: string | undefined }
	// 当前有效思考级别变化，区别于仅保存全局偏好。
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			// 压缩结束事件可成功、取消或失败，配合下面字段表达。
			type: "compaction_end";
			// 保留触发原因，便于 UI 区分手动和自动路径。
			reason: "manual" | "threshold" | "overflow";
			// 成功时带结果，失败/取消时可 undefined。
			result: CompactionResult | undefined;
			// 是否取消，不把取消文字当普通错误信息。
			aborted: boolean;
			// 该压缩流程是否打算恢复被中断请求。
			willRetry: boolean;
			// 失败时可附展示文字；? 表示整个字段可省略。
			errorMessage?: string;
	  }
	// 普通回答开始第几次退避，包含次数上限、等待和错误说明。
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	// 普通回答重试结束通知，成功与最终错误分开表达。
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			// 摘要使用独立的重试事件，不能与普通回答的 _retryAttempt 混为同一计数器。
			type: "summarization_retry_scheduled";
			// 本次摘要重试序号，从 1 开始。
			attempt: number;
			// 本次策略允许的额外重试次数。
			maxAttempts: number;
			// 本次等待时间，单位毫秒。
			delayMs: number;
			// 导致重试的可读说明。
			errorMessage: string;
	  }
	// 分支摘要下一次重试请求即将启动。
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			// 压缩摘要重试请求即将启动。
			type: "summarization_retry_attempt_start";
			// source 字面量使分支能够读取 reason，而 branchSummary 分支无该字段。
			source: "compaction";
			// 该压缩摘要所属的手动/阈值/溢出场景。
			reason: "manual" | "threshold" | "overflow";
	  }
	// 摘要重试流程结束，可用于清理 UI 状态。
	| { type: "summarization_retry_finished" }
	// 用户手动 shell 的流输出，id 供调用方关联并发执行；不是模型工具的 tool_execution_update。
	| { type: "bash_execution_update"; id?: string; delta: string };

/** Listener function for agent session events */
// 回调函数类型，接一个会话事件并返回 void；本类 _emit 同步调用它。
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

/**
 * 把供应商请求头中的 null 删除标记滤掉，返回只有字符串值的新对象；未传 headers 则返回 undefined。
 * 例：{Authorization:"x",Debug:null} 得到 {Authorization:"x"}；不发送网络请求，也不修改原对象。
 */
function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	// 有 headers 才生成新对象；undefined 保持未传状态。
	return headers
		? // entries 转键值数组，过滤 null；entry is [string,string] 是类型谓词，让 fromEntries 知道剩下值全为字符串。
			Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: // 三元表达式未提供 headers 的分支，不制造空对象。
			undefined;
}

// 配置由宿主/SDK 准备；接口不负责构造这些依赖或验证真实凭证。
export interface AgentSessionConfig {
	// 处理模型/工具循环的低层 Agent，状态在各模式间共享。
	agent: Agent;
	// 会话树与投影/保存管理器，决定内存会话还是文件会话。
	sessionManager: SessionManager;
	// 提供默认模型、重试、压缩、工具和界面设置。
	settingsManager: SettingsManager;
	// 本会话的工作目录，供工具、资源及扩展上下文使用。
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	// Array<{...}> 表示每项带模型与可选思考级别的数组，供模型循环切换。
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	// 资源加载器提供当前已加载的扩展、技能、模板、主题及项目上下文。
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	// SDK 直接提供的工具定义，与扩展注册工具一起进入注册表。
	customTools?: ToolDefinition[];
	/** Canonical model/auth runtime used by coding-agent internals. */
	// 统一提供模型目录、虚拟路由与认证的运行时。
	modelRuntime: ModelRuntime;
	/** Keeps the prompt cache entry of the last session request warm. */
	// Pick 只要求保温器的五个成员，不要求传入整个具体类；? 允许完全不配置。
	cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	// 初始想激活的工具名；未传时由运行时构建路径给默认值。
	initialActiveToolNames?: string[];
	/**
	 * Whether the initial tools come from the `defaultTools` setting. When true, a resumed session
	 * replaces them with the loadout its transcript records, with `defaultToolModifiers` applied, and
	 * reload activates tools newly added to the setting. Tools removed from it stay active.
	 */
	// 是否从默认工具设置出发；决定恢复历史与 reload 时的协调规则。
	usesDefaultTools?: boolean;
	/**
	 * `+name`/`-name` entries applied on top of the `defaultTools` setting, from `--tools`. Reload
	 * applies them to the reloaded setting too, so a removed tool stays removed.
	 */
	// 默认集合上的加减修饰，如 +grep/-bash；不是完整允许列表。
	defaultToolModifiers?: string[];
	/**
	 * Optional allowlist of tool names or patterns (`*` matches any characters). When provided, only
	 * matching tools are exposed. A non-empty list without `mcp__` entries also keeps MCP tools
	 * registered for codemode and tool_search; only tool_search can declare them. An empty list
	 * exposes no tools.
	 */
	// 可选允许列表，空数组与没提供不同：空数组不暴露工具。
	allowedToolNames?: string[];
	/** Optional denylist of tool names or patterns. When provided, matching tools are not exposed. */
	// 可选排除列表，匹配项在构建注册表时被过滤。
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	// 替换基础工具实现的名字到 AgentTool 映射，后面会合成统一定义。
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	// 可变引用对象供外部回调读最新 runner；? 出现在字段与 current 内表示两层都可缺省。
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	// 绑定扩展时发送的会话启动元数据，缺省为 startup。
	sessionStartEvent?: SessionStartEvent;
}

// 宿主可逐步补充扩展交互能力；undefined 的项不会清掉旧绑定。
export interface ExtensionBindings {
	// 交互界面能力引用；非交互场景可缺省。
	uiContext?: ExtensionUIContext;
	// 扩展感知的当前运行模式，与 HTTP/模型类型无关。
	mode?: ExtensionMode;
	// 命令专用会话控制操作，由具体模式实现。
	commandContextActions?: ExtensionCommandContextActions;
	// 宿主自定义取消入口；没有时核心回退到 session.abort。
	abortHandler?: () => void;
	// 宿主退出操作，可缺省；不在类型声明时执行。
	shutdownHandler?: ShutdownHandler;
	// 接收扩展错误的监听函数。
	onError?: ExtensionErrorListener;
}

// 输入扩展已处理，或输入已入队，两种派发结果字面量。
export type QueuedInputDisposition = "handled" | "queued";
// 普通 prompt 还可能直接 started；类型联合复用上面的两种结果。
export type PromptDisposition = QueuedInputDisposition | "started";

/** Options for AgentSession.prompt() */
// 单次 prompt 的可选行为配置；接口只约束调用方式，实际默认值在 prompt 中读取。
export interface PromptOptions {
	/** Whether to dispatch extension commands and expand skill commands and prompt templates (default: true) */
	// 默认允许命令/技能/模板展开；false 时这些用户文字按普通正文处理。
	expandPromptTemplates?: boolean;
	/** Image attachments */
	// 用户附件数组，不是文件路径数组。
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	// 忙碌时选择插话或追问；这里只是字符串联合，不会自动取消正在输出的回复。
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	// 供 input 扩展区分 interactive/extension 等来源，默认值在调用路径设置。
	source?: InputSource;
	/** Internal hook used by RPC mode to observe how an accepted prompt was dispatched. Not called if the prompt is rejected. */
	// 回调接派发结果，拒绝 prompt 时不通知；返回 void 不承诺得到回答文本。
	preflightResult?: (disposition: PromptDisposition) => void;
}

/** Options for model/thinking mutations. */
// 模型与思考修改共用持久化选项，不要求每次修改都重写全局默认。
export interface ModelMutationOptions {
	/** Persist the new value to global defaults. Defaults to session-only. */
	// 显式 true 才保存全局偏好，否则仅影响当前会话状态与历史。
	persist?: boolean;
}

/** Result from cycleModel() */
// 模型循环结果同时说明实际级别与循环范围来源。
export interface ModelCycleResult {
	// 循环最终选择的模型。
	model: Model<any>;
	// 应用模型能力限制后的有效思考级别。
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	// true 表示采用 scoped 范围，false 表示全部可用快照。
	isScoped: boolean;
}

/** Session statistics for /session command */
// 统计返回结构区分累计消费与当前窗口占用，字段本身不发起统计。
export interface SessionStats {
	// 会话保存位置，内存会话可以没有。
	sessionFile: string | undefined;
	// 当前会话的唯一标识。
	sessionId: string;
	// 全部会话 message 条目中 user 的数量。
	userMessages: number;
	// 全部会话 message 条目中 assistant 的数量。
	assistantMessages: number;
	// assistant 正文中 toolCall 块的数量，不等于执行成功数。
	toolCalls: number;
	// toolResult 消息数量，包含失败结果。
	toolResults: number;
	// 所有 type=message 条目数，custom_message 等独立条目不算在这里。
	totalMessages: number;
	// 累计用量分量；不是当前一次请求的上下文大小。
	tokens: {
		// 累计普通输入 token。
		input: number;
		// 累计输出 token。
		output: number;
		// 累计缓存读取 token。
		cacheRead: number;
		// 累计缓存写入 token。
		cacheWrite: number;
		// 本函数将上述四项相加的总数。
		total: number;
	};
	// 按记录 usage.cost 累积的费用，不是实时供应商账单查询。
	cost: number;
	// 可选的当前有效上下文用量，区别于累计消费。
	contextUsage?: ContextUsage;
}

// 注册表内部条目把原始定义与来源元数据捆在一起。
interface ToolDefinitionEntry {
	// 工具 schema、执行函数与提示词元数据等定义。
	definition: ToolDefinition;
	// 内置、扩展或 SDK 来源，供错误报告和展示。
	sourceInfo: SourceInfo;
}

/**
 * 逐条调用 estimateTokens 累加消息体积估算，返回数字；不调用 tokenizer 服务或模型。
 * 例：两条消息分别估算 10/20 token，合计 30；这里只估算，不代替供应商实际计费数据。
 */
function estimateMessagesTokens(messages: AgentMessage[]): number {
	// 初始化总量，let 允许循环中累加。
	let tokens = 0;
	// for...of 顺序取得每条完整消息，不遍历数组下标。
	for (const message of messages) {
		// 按角色估算该消息后累加，+= 等价于旧值加本次值再赋回。
		tokens += estimateTokens(message);
	}
	// 返回估算总量，不修改 messages。
	return tokens;
}

// ============================================================================
// AgentSession Class
// ============================================================================

// export class 导出可构造的运行时类；private 限制 TS 使用方访问，不是 # 字段的 JavaScript 私有语法。
export class AgentSession {
	// 只读依赖引用不允许重新赋值，但 Agent 对象内部状态仍会变化。
	readonly agent: Agent;
	// 管理历史树/文件的依赖引用。
	readonly sessionManager: SessionManager;
	// 管理设置的依赖引用。
	readonly settingsManager: SettingsManager;

	// 模型循环范围保存在内存，可由 setScopedModels 替换。
	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	// 当前低层事件退订函数，销毁时调用。
	private _unsubscribeAgent?: () => void;
	// 公开订阅者数组，初始无人订阅。
	private _eventListeners: AgentSessionEventListener[] = [];
	// 整个会话运行忙碌标记，范围比低层流输出更长。
	private _isAgentRunActive = false;
	// 运行级取消意图，启动/重试/收尾阶段都检查它。
	private _agentRunAbortRequested = false;
	// 共享的空闲等待 Promise，尚无等待者时 undefined。
	private _idleWaitPromise: Promise<void> | undefined;
	// 保存 Promise 的完成函数；括号避免把 undefined 误读成函数返回类型的一部分。
	private _resolveIdleWait: (() => void) | undefined;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	// 展示用插话文字，真正完整消息队列在 Agent 内。
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	// 展示用追问文字，与插话优先级不同。
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	// 延到下次运行起始用户消息后注入的 custom 上下文。
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Context-only custom messages queued during a run, flushed once the current turn's tool results are in. */
	// 运行中仅补上下文的 custom 消息，等工具调用/结果配对完整后追加。
	private _pendingCustomMessages: CustomMessage[] = [];

	// Compaction state
	// 手动压缩取消控制器，存在时禁止普通 prompt 并发修改历史。
	private _compactionAbortController: AbortController | undefined = undefined;
	// 自动压缩的独立控制器，便于取消与判断 busy。
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	// 当前问题是否已做过一次溢出恢复，避免无限压缩重试。
	private _overflowRecoveryAttempted = false;

	// Branch summarization state
	// 分支导航/摘要独立控制器，也参与 isCompacting。
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	// 普通回复自动重试退避期间的控制器。
	private _retryAbortController: AbortController | undefined = undefined;
	// 普通回复额外重试计数，摘要使用自己的重试机制。
	private _retryAttempt = 0;
	/**
	 * Failed response that the next request repeats, set by auto-retry and overflow recovery. The
	 * retry is routed with it as `failed`, since the context no longer contains it.
	 */
	// 下次虚拟路由重试需知道的失败回复，失败原文已从有效上下文中省略。
	private _failedResponse: AssistantMessage | undefined;

	// Bash execution state
	// Set 保存并发手动 bash 的控制器；readonly 约束集合引用，add/delete 仍合法。
	private readonly _bashAbortControllers = new Set<AbortController>();
	// Agent 忙碌期间暂存的手动命令结果。
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	// ! 是确定赋值断言，告知 TS 由 _buildRuntime 稍后初始化，不在运行时检查它。
	private _extensionRunner!: ExtensionRunner;
	// 当前低层运行内回合序号，agent_start 时归零。
	private _turnIndex = 0;
	// 消息对象到来源条目 id 的弱映射，投影替换也要能追溯。
	private readonly _entryIdsByMessage = new WeakMap<object, string>();
	// 记录 finishTurn 已派发过边界的 assistant 对象，避免 turn_end 重复派发。
	private readonly _boundaryDispatchedMessages = new WeakSet<object>();
	// 低层刚完成的最后回复，供结束后重试/压缩判断；消费后清空。
	private _lastAssistantMessage: AssistantMessage | undefined;
	// 最近活动结果，供 agent_before_settle 告知扩展。
	private _lastActivityOutcome: AgentActivityOutcome = "completed";
	// 目前是否处在收尾前扩展边界。
	private _isBeforeSettle = false;
	// 专门记录上述异步边界期间到来的取消。
	private _abortDuringBeforeSettle = false;
	// 是否正在派发 settled，期间再次启动任务须先延后。
	private _isEmittingAgentSettled = false;
	// 保存可异步执行的延迟任务；Array<() => Promise<void>> 是函数数组。
	private readonly _deferredSettledActions: Array<() => Promise<void>> = [];

	// 当前资源加载器，reload 时重用并更新内容。
	private _resourceLoader: ResourceLoader;
	// SDK 自定义定义列表，构造缺省为空数组。
	private _customTools: ToolDefinition[];
	// 基础工具定义表，键是名字。
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	// 会话工作目录，不等同于配置目录。
	private _cwd: string;
	// 外部持有的可变 runner 引用，运行时重建后更新 current。
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	// 构造时传入的初始工具名，后续状态以实时集合为准。
	private _initialActiveToolNames?: string[];
	/**
	 * Tools of the restored or reloaded loadout that are not registered yet, such as tools of MCP
	 * servers that are still connecting. They are activated when they are registered, and dropped when
	 * `setActiveToolsByName()` deactivates a tool or the next agent run starts.
	 */
	// 恢复/reload 时尚未注册的工具名，注册完成可转为激活项。
	private _pendingToolNames = new Set<string>();
	// 是否遵从 defaultTools 的恢复/reload 策略。
	private _usesDefaultTools: boolean;
	// 保存 +name/-name 修饰项，reload 默认设置后仍应用。
	private _defaultToolModifiers: string[];
	/** Matches the `--tools` entries: tool names or patterns. */
	// 可选的名字匹配函数，函数不存在表示没有允许列表过滤。
	private _allowedTools?: (name: string) => boolean;
	/**
	 * Whether the allowlist filters MCP tools: it is empty (`--no-tools`) or names an MCP tool
	 * (`mcp__*`). Otherwise it keeps MCP tools registered for codemode and tool_search.
	 */
	// 允许列表是否明确过滤 MCP；空列表或含 mcp__ 条目才开启该规则。
	private _allowlistFiltersMcp = false;
	// 可选排除匹配函数，其命中优先拒绝。
	private _excludedTools?: (name: string) => boolean;
	// SDK 可覆盖本地基础工具实现。
	private _baseToolsOverride?: Record<string, AgentTool>;
	// 下次扩展绑定使用的启动原因等元数据。
	private _sessionStartEvent: SessionStartEvent;
	// 保存宿主界面上下文供新 runner 重新绑定。
	private _extensionUIContext?: ExtensionUIContext;
	// 未另行绑定时扩展模式按 print；这不是启动界面操作。
	private _extensionMode: ExtensionMode = "print";
	// 宿主提供的命令专用会话操作。
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	// 宿主自定义的取消回调。
	private _extensionAbortHandler?: () => void;
	// 宿主自定义的退出回调。
	private _extensionShutdownHandler?: ShutdownHandler;
	// 扩展错误监听函数，reload 后继续用于新 runner。
	private _extensionErrorListener?: ExtensionErrorListener;
	// 撤销上一次错误订阅的函数。
	private _extensionErrorUnsubscriber?: () => void;

	// 模型/认证/路由的统一依赖。
	private _modelRuntime: ModelRuntime;
	// 保温器只需这些选取成员，未配置则整个功能不参与。
	private _cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;

	// Tool registry for extension getTools/setTools
	// 工具名到实际 AgentTool 实现的映射，与原始定义表分开。
	private _toolRegistry: Map<string, AgentTool> = new Map();
	/** Created on the first `ctx.executeTool()` call. */
	// 嵌套调用运行器延迟创建，未用 ctx.executeTool 不创建。
	private _nestedToolCalls: NestedToolCallRunner | undefined;
	/** Declared tools whose declarations requests leave out, from `prepareLoadout` hooks. */
	// 本次工具 loadout 决定从请求声明中隐藏的名称集合；类型只读不冻结。
	private _hiddenDeclarations: ReadonlySet<string> = new Set();
	// 完整定义与来源表，可包含未激活工具。
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	// 已规范化的一行工具说明，用于系统提示词。
	private _toolPromptSnippets: Map<string, string> = new Map();
	// 已规范化去重的工具规则列表。
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// 规范化后的基础提示词选项，由运行时构建时初始化。
	private _baseSystemPromptOptions!: NormalizedBuildSystemPromptOptions;
	/** Prompt options after before_agent_start mutations for the active run. */
	// 本次运行临时提示词选项，收尾后清掉，下一次从基础开始。
	private _runSystemPromptOptions?: NormalizedBuildSystemPromptOptions;

	// 会话层把 Agent、会话记录、配置、扩展和工具接起来。调用链见 docs/learning/pi/QUERY_CALL_CHAIN.md。
	/**
	 * 把低层 Agent、会话树、设置、模型运行时、资源和扩展接成一个会话管理对象。
	 * 输入 config，保存依赖，建立工具过滤规则，订阅事件并安装各阶段钩子，构建扩展/工具运行时；按需从历史恢复工具。
	 * 副作用包含订阅、设置 Agent 回调、建立工具/提示词状态；构造器不直接启动普通 Agent.prompt，prepareLoadout 等扩展钩子可有自己的副作用。例：内存 SessionManager 可复用生命周期而不保存会话文件。
	 */
	constructor(config: AgentSessionConfig) {
		// 沿用宿主低层 Agent，不在这里新建并行循环。
		this.agent = config.agent;
		// 保存会话管理器引用，之后所有持久化与投影从这里协调。
		this.sessionManager = config.sessionManager;
		// 保存设置管理器引用。
		this.settingsManager = config.settingsManager;
		// 未传循环范围则用空数组；?? 只处理 null/undefined。
		this._scopedModels = config.scopedModels ?? [];
		// 保存已加载资源入口，后面构建扩展与提示词。
		this._resourceLoader = config.resourceLoader;
		// 未传 SDK 自定义工具则用空列表。
		this._customTools = config.customTools ?? [];
		// 保存该会话的工具/资源工作目录。
		this._cwd = config.cwd;
		// 保存统一模型运行时，不在构造时认证请求。
		this._modelRuntime = config.modelRuntime;
		// 保存可选缓存保温器。
		this._cacheWarmer = config.cacheWarmer;
		// 只有配置保温器才安装保温完成通知。
		if (this._cacheWarmer) {
			// 保温写入用量等条目时，经会话事件告知观察者。
			this._cacheWarmer.onWarmed = (entry) => this._emit({ type: "entry_appended", entry });
		}
		// 保存外部可变引用容器，后面建立 runner 再填 current。
		this._extensionRunnerRef = config.extensionRunnerRef;
		// 保留初始激活工具名供首次构建。
		this._initialActiveToolNames = config.initialActiveToolNames;
		// 缺省不假定初始工具来自 defaultTools。
		this._usesDefaultTools = config.usesDefaultTools ?? false;
		// 没有加减修饰则为空数组。
		this._defaultToolModifiers = config.defaultToolModifiers ?? [];
		// 数组即便为空也是真值；空允许列表仍需建立匹配器。
		if (config.allowedToolNames) {
			// 编译工具名/通配模式匹配函数，实际匹配留给后面注册/激活判断。
			this._allowedTools = createToolNameMatcher(config.allowedToolNames);
			// 计算是否由允许列表明确限制 MCP，而非把所有未点名 MCP 都删掉。
			this._allowlistFiltersMcp =
				// 空列表拒绝全部；出现 mcp__ 前缀表示用户显式控制 MCP 集合。
				config.allowedToolNames.length === 0 || config.allowedToolNames.some((entry) => entry.startsWith("mcp__"));
		}
		// 排除列表存在时建立匹配器，不存在保留 undefined。
		this._excludedTools = config.excludedToolNames ? createToolNameMatcher(config.excludedToolNames) : undefined;
		// 保存可选基础工具覆盖表。
		this._baseToolsOverride = config.baseToolsOverride;
		// 没有自定义启动元数据时，后续绑定发 startup 事件。
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		// 关键接线：订阅低层 Agent 事件。以后每次 message_end 都通过 _handleAgentEvent 保存完整消息。
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		// 安装工具前/后钩子，接扩展拦截与结果图片处理。这里只是注册回调，不执行工具。
		this._installAgentToolHooks();
		// 安装回合间刷新回调；工具执行完准备再问模型时，检查压缩并更新提示词/工具。
		this._installAgentNextTurnRefresh();
		// 安装每次请求前的投影回调：从会话记录中选出本次真正应该发给模型的消息。
		this._installAgentRequestProjection();
		// 接上回合结束扩展；扩展可能要求继续运行，所以不能只看模型有没有输出工具就判定会话空闲。
		this._installAgentBoundaryHooks();
		// 安装隐藏工具声明投影，不直接删除本地工具实现。
		this._installHiddenDeclarationsProjection();
		// 安装强制提示词投影，供 before_agent_start 的完整 system 覆盖。
		this._installAgentForcedPromptProjection();

		// 按初始工具名创建定义、runner、工具注册表及基础提示词。
		this._buildRuntime({
			// 当前期望激活的名字可缺省，由 _buildRuntime 给默认值。
			activeToolNames: this._initialActiveToolNames,
			// 首次构建允许注册时默认开启的扩展工具进入激活集合。
			includeAllExtensionTools: true,
		});
		// 使用默认工具策略时，再依会话历史与加减修饰恢复 loadout。
		if (this._usesDefaultTools) this._restoreToolsFromTranscript(this._defaultToolModifiers);
	}

	/**
	 * 读取会话持有的模型/认证运行时，返回同一对象引用；没有额外加载。例：session.modelRuntime.getAvailableSnapshot() 读取已维护的可用模型快照。
	 */
	get modelRuntime(): ModelRuntime {
		// getter 返回存下来的模型运行时引用。
		return this._modelRuntime;
	}

	/**
	 * 为内置 streamSimple 摘要请求获取必需认证，返回可能改写 baseUrl 的模型及 key/headers/env。
	 * 先调用 runtime.getAuth，再筛掉请求头删除标记；缺认证时按 OAuth 或普通 key 给错误。取消信号继续传给认证流程，异常通常向上传播。
	 * 例：认证指定自定义 baseUrl 时返回模型浅副本；找到 headers 也可通过本层条件，并不保证远端一定接受这些凭证。
	 */
	private async _getRequiredRequestAuth(
		// 摘要将要实际调用的模型，不是用户文字模式。
		model: Model<any>,
		// 可选取消信号，透传到认证操作。
		signal?: AbortSignal,
		// 异步返回对象的结构类型从这里开始，不是立即返回一个对象。
	): Promise<{
		// 返回的模型可能带认证配置覆盖后的 baseUrl。
		model: Model<any>;
		// 某些认证方式提供 key，另一些用 headers；字段均允许缺省。
		apiKey?: string;
		// 这里只返回字符串请求头，null 删除标记会过滤。
		headers?: Record<string, string>;
		// 请求专用环境覆盖，不把值写到 process.env。
		env?: Record<string, string>;
		// 结束返回对象类型，接下来才是函数体；字段问号只限制开发期类型。
	}> {
		// 声明认证结果，try 成功后赋值，catch 可检查原异常。
		let result: AuthResult | undefined;
		// 围住认证获取，精确替换已知缺 key 的错误，其余保持原因。
		try {
			// 异步获取认证，可能涉及 OAuth 刷新，收到 signal 可取消。
			result = await this._modelRuntime.getAuth(model, { signal });
			// 认证出错进入此分支，catch 的 error 需运行时收窄。
		} catch (error) {
			// 只有 Error 才读取 cause，其他抛出值没有假定结构。
			const cause = error instanceof Error ? error.cause : undefined;
			// 识别底层 authHeader 的明确缺 key 原因，不吞掉所有认证错误。
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				// 换成面向供应商的缺认证指导错误。
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			// 其他异常原样传播，包括取消/网络/配置错误。
			throw error;
		}
		// 满足存在认证结果，且有非空 key 或 headers 对象，才组返回值；这不是远端凭证有效性证明。
		if (result && (result.auth.apiKey || result.auth.headers)) {
			// 认证若覆盖 baseUrl 则浅复制模型；否则复用原模型引用。
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			// 把模型与认证信息打包，不在此发摘要请求。
			return {
				// 使用实际请求目标模型。
				model: requestModel,
				// 保留解析出的可选 key。
				apiKey: result.auth.apiKey,
				// 剔除 null 值请求头，再交 HTTP 请求使用。
				headers: withoutDeletedHeaders(result.auth.headers),
				// 继续传递该供应商请求的环境覆盖。
				env: result.env,
			};
		}

		// 无法形成请求认证时检查存储方式，区分登录失效提示与普通缺 key。
		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		// OAuth 供应商走重新登录指导。
		if (isOAuth) {
			// 抛 Error 拒绝当前摘要认证 Promise，不自动尝试模型调用。
			throw new Error(
				// 错误文案使用供应商名称，不包含 token/key 值。
				`Authentication failed for "${model.provider}". ` +
					// 说明凭证过期或网络等可能原因，并非在此已诊断出唯一原因。
					`Credentials may have expired or network is unavailable. ` +
					// 给用户重新登录的操作提示。
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		// 非 OAuth 则用通用缺 API key 指导。
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	/**
	 * 为摘要类请求选择实际模型、思考级别及合适的认证传法。
	 * 虚拟模型先按 direct 原因路由；内置 streamSimple 要求认证，同一 runtime 自管认证的流函数不接收预解析 key，其他自定义流尽力取认证。
	 * 返回请求参数；取消异常向上传播，其他自定义流的取认证失败会退回 model/thinkingLevel。例：自管 OAuth 流保留由 runtime 自行刷新的路径。
	 */
	private async _getSummarizationRequestAuth(
		// 当前选中的模型可能是路由入口，需要先解析为物理模型。
		selectedModel: Model<any>,
		// 摘要与认证共用的可选取消信号。
		signal?: AbortSignal,
		// 摘要请求参数异步返回对象，除了认证还包含路由后思考级别。
	): Promise<{
		// 实际用来估算/发送摘要的模型。
		model: Model<any>;
		// 按所用流函数策略决定是否预传 key。
		apiKey?: string;
		// 附加字符串请求头，允许缺省。
		headers?: Record<string, string>;
		// 摘要请求专用环境值。
		env?: Record<string, string>;
		// 路由后最终的思考级别。
		thinkingLevel: ThinkingLevel;
		// 结束 Promise 对象类型，实际各分支分别构造返回值。
	}> {
		// Route a virtual model first: summaries size their input and output from the model they get.
		// 解构模型与级别；虚拟模型按 direct 路由，普通选择直接沿用。
		const { model, thinkingLevel } = isVirtualModel(selectedModel)
			? // 给路由器当前有效模型消息，而非整个原始会话树。
				await this._modelRuntime.resolveModel(selectedModel, convertToLlm(this.messages), {
					// direct 表示这次是摘要等直接请求，不冒充新用户回合。
					reason: "direct",
					// 提供当前会话思考级别作为路由输入。
					thinkingLevel: this.thinkingLevel,
					// 路由也接收取消信号。
					signal,
				})
			: // 普通模型无需调用 router，直接构造同形结果。
				{ model: selectedModel, thinkingLevel: this.thinkingLevel };
		// 默认兼容流函数不会替我们解决认证，因此走必需认证路径。
		if (this.agent.streamFunction === streamSimple) {
			// await 后展开认证字段，并加最终思考级别。
			return { ...(await this._getRequiredRequestAuth(model, signal)), thinkingLevel };
		}
		// 同一个 runtime 管认证的流函数，禁止把已解析 OAuth token 当显式 key 再传入。
		if (runtimeStreamFunctions.get(this.agent.streamFunction) === this._modelRuntime) {
			// 只返回模型和级别，凭证留给流函数自己的 runtime。
			return { model, thinkingLevel };
		}

		// 其他自定义流函数尽力解析认证，但允许其自备凭证机制。
		try {
			// 通过 runtime 获取该物理模型认证。
			const result = await this._modelRuntime.getAuth(model, { signal });
			// 没结果仍交自定义流处理，不在该分支直接拒绝。
			if (!result) return { model, thinkingLevel };
			// 认证可覆盖端点，其他模型字段保持。
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			// 带上可取得的请求字段供自定义流使用。
			return {
				// 实际模型/端点。
				model: requestModel,
				// 可选的 API key。
				apiKey: result.auth.apiKey,
				// 过滤删除标记后的 headers。
				headers: withoutDeletedHeaders(result.auth.headers),
				// 认证解析附带的环境覆盖。
				env: result.env,
				// 保留路由后的思考级别。
				thinkingLevel,
			};
			// 认证解析异常与用户主动取消区别处理。
		} catch (error) {
			// 取消必须继续传播，不能回退后继续发送请求。
			if (signal?.aborted) throw error;
			// 其他错误回退到让自定义流自行认证；不声称本层已验证可用。
			return { model, thinkingLevel };
		}
	}

	/**
	 * The model whose limits apply to `message`, or undefined when the message came from another
	 * model. Under a virtual selection, that is the physical model that produced it.
	 */
	/**
	 * 根据一条 assistant 回复确定可用于该回复用量/长度判断的模型；返回模型或 undefined。
	 * 虚拟选择查回复声明的物理模型；普通选择必须 provider 与 id 都相同。例：切到大窗口模型后，旧小窗口回复不再按当前普通模型匹配。
	 */
	private _modelForMessage(message: AssistantMessage): Model<any> | undefined {
		// 读取当前选择，未选模型时仍可安全走下面比较。
		const model = this.model;
		// 虚拟模型时按消息标记的 provider/model 查物理模型。
		if (model && isVirtualModel(model)) return this._modelRuntime.getPhysicalModel(message.provider, message.model);
		// 普通选择必须供应商和 id 都一致，否则返回 undefined。
		return model?.provider === message.provider && model.id === message.model ? model : undefined;
	}

	/**
	 * Record the selection on the current branch when the branch implies another one, so a resume
	 * restores it. Tree navigation can leave the latest `model_change` on another branch; responses
	 * cannot record a virtual selection because they name physical models. Responses do record a
	 * physical selection unless the branch holds a virtual one; checking a physical selection against
	 * responses would record it on every prompt while `prepareRequest` redirects to another model.
	 */
	/**
	 * 必要时把当前虚拟/物理模型选择补记进当前分支，返回 void；可能追加 model_change 条目。
	 * 读取分支已有选择，相同或没有已记录选择则不写；仅涉及虚拟选择切换时补写。例：导航到另一分支后仍保留当前虚拟选择，下次运行先记录它。
	 */
	private _recordSelection(): void {
		// 先取当前模型快照，避免后续反复读 getter。
		const model = this.model;
		// 未选模型无可记录选择。
		if (!model) return;
		// 局部查目录回调，供分支选择恢复解析虚拟模型。
		const getModel = (provider: string, modelId: string) => this._modelRuntime.getModel(provider, modelId);
		// 按当前树分支推导最近记录的有效选择。
		const recorded = getBranchSelection(this.sessionManager.getBranch(), getModel);
		// 无已有记录或完全一致时不追加冗余记录。
		if (!recorded || (recorded.provider === model.provider && recorded.modelId === model.id)) return;
		// 解析分支记录对应的模型，判断旧选择是否虚拟。
		const recordedModel = getModel(recorded.provider, recorded.modelId);
		// 新旧都是普通物理选择时不补记，此处只处理虚拟选择的分支恢复歧义。
		if (!isVirtualModel(model) && !(recordedModel && isVirtualModel(recordedModel))) return;
		// 追加当前选择，使 resume 从这条分支能恢复它。
		this.sessionManager.appendModelChange(model.provider, model.id);
	}

	/** The model whose limits apply to the conversation. */
	/**
	 * 取得当前上下文限制所依据的模型：优先最近成功路由的物理模型，否则当前选择。
	 * 返回已有模型引用或 undefined，无副作用。例：虚拟 router 最近由模型 A 作答，图片/容量限制先按 A。
	 */
	private _limitsModel(): Model<any> | undefined {
		// 可选链取得最近路由模型，缺失则用当前选择。
		return this.routedModel?.model ?? this.model;
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	/**
	 * 把会话的工具调用前后回调接到 Agent，返回 void；只安装，不执行工具。
	 * 箭头函数每次读当前扩展运行器，reload 后自动使用新运行器。例：模型调用 read 时，先经过本会话的 tool_call 扩展。
	 */
	private _installAgentToolHooks(): void {
		// 包装执行前回调，真正执行时再取当前会话扩展。
		this.agent.beforeToolCall = (context) => this._beforeToolCall(context);
		// 包装执行后回调，接扩展改写及图片处理。
		this.agent.afterToolCall = (context) => this._afterToolCall(context);
	}

	/** `tool_call` handlers. `parentToolCallId` is set for calls another tool made. */
	/**
	 * 在执行工具前派发 tool_call，传工具名、调用 id、参数及可选父调用 id；返回扩展拦截结果或 undefined。
	 * 无监听器则跳过；扩展抛 Error 原样传播，其他抛出值包装成 Error，执行管线会据此处理失败。
	 * 例：codemode 内调用 read 时带父 id，让扩展区分嵌套调用；这里只断言参数类型，不重新校验参数 schema。
	 */
	private async _beforeToolCall(
		// 参数解构直接取调用与已解析参数，输入类型来自低层管线。
		{ toolCall, args }: BeforeToolCallContext,
		// 嵌套调用才有父 id，普通模型调用可不传。
		parentToolCallId?: string,
		// 返回可选前置拦截结果，Promise 表示要等扩展完成。
	): Promise<BeforeToolCallResult | undefined> {
		// 读取当前 runner，支持 reload 之后接上新扩展。
		const runner = this._extensionRunner;
		// 无人监听时不创建事件或执行扩展。
		if (!runner.hasHandlers("tool_call")) {
			// undefined 表示没有额外拦截意见。
			return undefined;
		}

		// 扩展执行异常在此转成适合管线处理的 Error。
		try {
			// 异步派发工具调用事件，扩展可返回阻止等结果。
			return await runner.emitToolCall({
				// 用字面量标识执行前阶段。
				type: "tool_call",
				// 模型/父工具要求调用的名字。
				toolName: toolCall.name,
				// 本次调用唯一 id，配对后续结果。
				toolCallId: toolCall.id,
				// 对象展开有父 id 才附字段，未传不写 undefined 字段。
				...(parentToolCallId ? { parentToolCallId } : {}),
				// as 只说明管线参数按对象使用，不在此验证每个键值。
				input: args as Record<string, unknown>,
			});
			// 捕获扩展错误，保持 Error 对象的堆栈与原因。
		} catch (err) {
			// 只有实际 Error 可原样重新抛出。
			if (err instanceof Error) {
				// 保留原 Error 供工具调用管线报告。
				throw err;
			}
			// 非 Error 抛出值转换为明确的阻止执行错误。
			throw new Error(`Extension failed, blocking execution: ${String(err)}`);
		}
	}

	/** `tool_result` handlers and image normalization. `parentToolCallId` is set for calls another tool made. */
	/**
	 * 在工具执行后依次运行 tool_result 扩展与结果图片规范化，返回覆盖字段或 undefined。
	 * 输入已执行结果和错误标记；扩展可改内容/详情/用量，再按图片设置和模型限制处理图片；未改任何内容则让调用方保留原结果。
	 * 例：扩展注入大图也会走 normalizeToolResultImages；本函数异步处理结果，不再次执行该工具。
	 * 工具结果图片处理失败时，下层保留原图片块；与用户 prompt 图片失败后丢弃的路径不同，也不保证远端一定接受原图。
	 */
	private async _afterToolCall(
		// 解构低层工具调用、参数、结果和错误状态。
		{ toolCall, args, result, isError }: AfterToolCallContext,
		// 可选父调用 id 用于追溯 ctx.executeTool。
		parentToolCallId?: string,
		// 返回可覆盖结果字段，或 undefined 表示无需覆盖。
	): Promise<AfterToolCallResult | undefined> {
		// 取当前 runner，reload 不需重装回调。
		const runner = this._extensionRunner;
		// 仅有 tool_result 监听器时调用扩展。
		const hookResult = runner.hasHandlers("tool_result")
			? // 等结果改写链完成，再做统一图片处理。
				await runner.emitToolResult({
					// 事件类型区别于执行进度 tool_execution_end。
					type: "tool_result",
					// 被执行的工具名。
					toolName: toolCall.name,
					// 本次工具调用 id。
					toolCallId: toolCall.id,
					// 嵌套调用附父 id。
					...(parentToolCallId ? { parentToolCallId } : {}),
					// 用对象类型提供已校验参数给扩展，不执行额外 schema 检查。
					input: args as Record<string, unknown>,
					// 原始可见内容块数组。
					content: result.content,
					// 程序化详情，未必发送模型。
					details: result.details,
					// 结构化结果存在才附上字段，保留其原值。
					...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
					// 执行管线提供的错误标记。
					isError,
					// 工具或嵌套请求记录的用量。
					usage: result.usage,
				})
			: // 没有监听器即无扩展替换结果。
				undefined;

		// 优先扩展新内容，否则保留原内容，均缺失时空数组兜底。
		const content = hookResult?.content ?? result.content ?? [];
		// Runs after the extension hook so images injected or replaced by extensions are normalized too.
		// 按当前限制模型取得可选图片缩放配置。
		const resizeOptions = this._limitsModel()?.inputLimits?.images?.resize;
		// 在扩展注入/替换图片之后统一规范化，返回可供模型的内容。
		const normalizedContent = await normalizeToolResultImages(content, {
			// 采用用户图片自动缩放设置。
			autoResizeImages: this.settingsManager.getImageAutoResize(),
			// 模型有缩放配置才覆盖传入，不凭空造默认值。
			...(resizeOptions ? { resizeOptions } : {}),
		});

		// 扩展没改结果且图片处理复用数组，表示没有任何内容替换。
		if (!hookResult && normalizedContent === content) {
			// 让低层沿用原结果，而非创建无意义覆盖对象。
			return undefined;
		}

		// The hook result already dropped structured content that replaced content no longer matches.
		// 有修改则返回覆盖字段，由执行管线与原结果协调。
		return {
			// 使用规范化后的内容数组。
			content: normalizedContent,
			// 扩展没提供详情时为 undefined，调用管线决定是否保留原详情。
			details: hookResult?.details,
			// 扩展改写可能清掉过期结构化结果；无扩展替换则保留原结构化内容。
			structuredContent: hookResult ? hookResult.structuredContent : result.structuredContent,
			// ?? 允许扩展明确设置 isError=false，不被原 true 覆盖。
			isError: hookResult?.isError ?? isError,
			// 扩展给用量时传回；undefined 不等于抹掉原累计用量。
			usage: hookResult?.usage,
		};
	}

	/**
	 * Run a call that the tool call `parentToolCallId` made through `ctx.executeTool()`. It goes
	 * through the agent's tool pipeline with the session's hooks, against the callable tools.
	 */
	/**
	 * 替工具中的 ctx.executeTool 执行一次嵌套调用，返回 AgentToolCallOutcome。
	 * 首次创建嵌套运行器，动态提供可调用工具、串行策略、前后钩子及事件派发；然后按父 id、工具名、参数和 options 调用。
	 * 例：父调用 c1 的 codemode 执行 read，嵌套结果与用量归入 c1；缺 assistant 来源时返回 isError 结果，不凭空制造来源消息。
	 */
	private async _executeNestedToolCall(
		// 父工具调用 id，嵌套记录归属它。
		parentToolCallId: string,
		// 要查注册表执行的工具名称。
		name: string,
		// 待调用参数是 unknown，实际 schema 检查交低层 runToolCall。
		args: unknown,
		// 含取消信号及部分结果回调等执行选项。
		options: ExecuteToolOptions,
		// Promise 完成后得到调用、结果与错误状态。
	): Promise<AgentToolCallOutcome> {
		// ??= 首次使用才创建运行器，后续复用其调用范围/计数和串行队列。
		this._nestedToolCalls ??= new NestedToolCallRunner({
			// 每次动态读取可调用集合，避免 reload/激活变化后用陈旧工具。
			getTools: () => this._getCallableTools(),
			// 会话低层串行策略也约束嵌套调用。
			isSequential: () => this.agent.toolExecution === "sequential",
			// 由嵌套运行器提供调用、父 id、信号和进度回调，转入标准执行管线。
			runToolCall: (toolCall, parentId, signal, onUpdate) => {
				// 用最近 assistant 作为工具调用语境，包含失败/取消回复也可找到。
				const assistantMessage = this._findLastAssistantMessage();
				// 没有 assistant 就不能构造合法调用语境。
				if (!assistantMessage) {
					// 回调需要 Promise，使用已完成 Promise 包装失败结果。
					return Promise.resolve({
						// 仍保留请求的 toolCall，便于调用者关联。
						toolCall,
						// 构造文字错误结果，不执行实际工具。
						result: { content: [{ type: "text", text: "No assistant message issued this call" }], details: {} },
						// 标记该次嵌套调用失败。
						isError: true,
					});
				}
				// 把调用转给共享 runToolCall，实现参数检查、执行与结果钩子。
				return runToolCall(toolCall, {
					// 使用可被工具调用的完整集合，而不只模型当前声明。
					tools: this._getCallableTools(),
					// 提供上述 assistant 来源。
					assistantMessage,
					// 传当前消息与 Agent 工具状态作为执行上下文。
					context: { messages: this.agent.state.messages, tools: this.agent.state.tools },
					// 回调透传父 id，让 tool_call 扩展看到归属关系。
					beforeToolCall: (context) => this._beforeToolCall(context, parentId),
					// 结果钩子同样携带父 id。
					afterToolCall: (context) => this._afterToolCall(context, parentId),
					// 继续传递取消信号。
					signal,
					// 继续传递部分结果通知函数。
					onUpdate,
				});
			},
			// 嵌套执行事件先让扩展处理，再通知公开观察者。
			emit: async (event) => {
				// 等待扩展 tool_execution_* 事件。
				await this._extensionRunner.emit(event);
				// 公开事件带 parentToolCallId；不在此伪造普通模型回合。
				this._emit(event);
			},
		});
		// 启动/等待这次嵌套调用；运行器还负责记录和串行协调。
		return this._nestedToolCalls.execute(parentToolCallId, name, args, options);
	}

	/** Whether `projection`, the current session projection, exceeds the compaction threshold of `model`. */
	/**
	 * 判断当前会话投影是否超过给定模型的自动压缩阈值，返回 boolean，无写入。
	 * 无正窗口直接 false，否则用投影估算与当前选择的压缩设置比较。例：窗口 100000、预留 10000，估算超过 90000 才触发。
	 */
	private _exceedsCompactionThreshold(model: Model<any>, projection: SessionProjection): boolean {
		// 无正上下文窗口不做这里的阈值比较。
		if (model.contextWindow <= 0) return false;
		// 统一调用阈值规则，只有 enabled 且超过窗口减预留才为 true。
		return shouldCompact(
			// 用考虑后续编辑/压缩后的投影估算，而非盲信旧回复用量。
			estimateProjectedContextTokens(projection, this.sessionManager.getBranch()).tokens,
			// 目标物理模型窗口。
			model.contextWindow,
			// 压缩策略仍来自当前会话模型选择对应设置。
			this.settingsManager.getCompactionSettings(this.model),
		);
	}

	// 工具之后再请求模型前，也有机会检查压缩；不是只在用户发新问题时压缩。
	/**
	 * 在下一次 assistant 回答前刷新会话投影，必要时做阈值压缩，返回替换 messages 后的 AgentContext。
	 * 普通物理模型在此检查；虚拟模型留待 prepareRequest 确定物理路由。例：工具返回大段内容后，下一次请求前可能先摘要旧历史。
	 */
	private async _compactBeforeNextAssistantResponse(context: AgentContext): Promise<AgentContext> {
		// 从内存里的会话树投影当前有效历史，包括压缩/编辑的效果；不是每次读一遍磁盘 JSONL。
		const projection = this.sessionManager.buildSessionProjection();
		// A virtual selection is checked in prepareRequest, against the model the request is routed to.
		// 取当前模型选择，压缩阈值需要知道它的上下文窗口。
		const model = this.model;
		// 没有模型或没超阈值就直接用投影；虚拟模型留到路由确定具体模型后再判断。
		if (!model || isVirtualModel(model) || !this._exceedsCompactionThreshold(model, projection)) {
			// 保留工具等上下文字段，用当前有效历史替换 messages。
			return { ...context, messages: projection.messages };
		}
		// 超阈值时执行自动压缩；默认方案会调用模型生成摘要，false 表示不重试已完成回答。
		await this._runAutoCompaction("threshold", false);
		// 压缩后重新投影，拿到“摘要 + 保留原文”等最终历史供下一次请求使用。
		return { ...context, messages: this.sessionManager.buildSessionProjection().messages };
	}

	// 注册每次模型请求前都执行的回调；函数安装一次，内部 async 函数会执行很多次。
	/**
	 * 包装 Agent.prepareRequest，使每次请求以会话树的有效投影为准，并处理虚拟路由。
	 * 先保留原回调、重建上下文，再选择模型；虚拟模型保存路由状态并按物理容量检查压缩，压缩后重新准备上下文。
	 * 安装函数返回 void；实际回调可调用路由/压缩并追加条目。例：context_edit 隐去旧工具结果后，下一请求不再沿用 Agent 中的旧副本。
	 */
	private _installAgentRequestProjection(): void {
		// 保留之前安装的回调，包装时不丢掉已有逻辑。
		const previousPrepareRequest = this.agent.prepareRequest;
		// 真正进入请求前才运行这个箭头函数，获得本次 context、模型及取消信号。
		this.agent.prepareRequest = async (request, signal) => {
			// 重试路由可能需要知道上一条失败回复；正常路径是 undefined。
			const failed = this._failedResponse;
			// 失败回复已保存在局部变量，清空一次性标记，避免下一次正常请求仍被当作重试。
			this._failedResponse = undefined;
			// 抽出构建请求快照的小函数；若路由后又发生压缩，可以重新构建一次。
			const prepare = async () => {
				// 从内存里的会话树投影当前有效历史，包括压缩/编辑的效果；不是每次读一遍磁盘 JSONL。
				const projection = this.sessionManager.buildSessionProjection();
				// 组装以 SessionManager 为准的上下文，防止 Agent 里的临时副本落后于会话编辑。
				const canonicalContext = {
					// 保留原上下文其他字段，下面替换消息和可执行工具。
					...request.context,
					// 请求使用当前有效历史，不等同于 JSONL 文件里所有原始条目。
					messages: projection.messages,
					// Messages declare the provider-visible loadout; context.tools keeps executable implementations.
					// 保留工具的本地实现；模型实际看到的声明则来自 system 消息。
					tools: this.agent.state.tools.slice(),
				};
				// 先把标准上下文交给此前的 prepareRequest 回调，让调用者继续修改本次请求。
				const previous = await previousPrepareRequest?.(
					{
						// 保留请求原有字段，再覆盖需要刷新的模型/上下文。
						...request,
						// 将权威投影作为之前回调的输入。
						context: canonicalContext,
						// 基于 Agent 当前模型选择构建本次请求，避免用旧快照中的模型。
						model: this.agent.state.model,
						// 使用当前思考级别；工具执行期间设置也可能变化。
						thinkingLevel: this.agent.state.thinkingLevel,
					},
					// 继续传递用户取消信号。
					signal,
				);
				// 返回回调结果、最终上下文和投影，后面路由与压缩检查都要用。
				return { previous, context: previous?.context ?? canonicalContext, projection };
			};
			// await 等快照准备好；解构一次取出三个字段，let 允许压缩后重新赋值。
			let { previous, context, projection } = await prepare();
			// 此前回调明确换了模型则尊重它，否则采用 Agent 当前选择。
			const model = previous?.model ?? this.agent.state.model;
			// 思考级别也允许回调覆盖；?? 仅在缺失时回退，"off" 等明确级别仍保留。
			const thinkingLevel = previous?.thinkingLevel ?? this.agent.state.thinkingLevel;
			// 普通物理模型走这里直接返回；后面的虚拟模型路由不是每次请求都必须经历。
			if (!isVirtualModel(model)) return { ...previous, context, model, thinkingLevel };

			// The selection stays in agent state; only this request uses the routed model. A routing
			// failure rejects, which ends the run with an error response. Only messages the user wrote
			// start a turn; extension messages can follow them, e.g. from before_agent_start.
			// 找到最后 assistant 所在下标；findLastIndex 找不到为 -1。
			const lastResponse = context.messages.findLastIndex((message) => message.role === "assistant");
			// 最后 assistant 之后有真正 user 角色才标新用户回合；custom 消息不单独算。
			const userTurn = context.messages.slice(lastResponse + 1).some((message) => message.role === "user");
			// 从当前分支读虚拟模型持久路由状态。
			const state = getVirtualModelState(this.sessionManager.getBranch(), model.provider, model.id);
			// 把转换后的当前消息交 router，确定本次物理模型与级别。
			const route = await this._modelRuntime.resolveModel(model, convertToLlm(context.messages), {
				// 失败恢复优先 retry，否则区分 user 与 continuation。
				reason: failed ? "retry" : userTurn ? "user" : "continuation",
				// 提供会话或之前回调确定的思考偏好。
				thinkingLevel,
				// 继续传递用户取消信号。
				signal,
				// 附失败回复供 router 决定改路由，正常请求为 undefined。
				failed,
				// 附当前分支的 router 状态。
				state,
			});
			// 路由返回新状态引用才追加，undefined 表示不更新。
			if (route.state !== undefined && route.state !== state) {
				// 记录是哪一个虚拟选择的状态；类型标注约束结构，不序列化校验状态内容。
				const data: VirtualModelStateData = { provider: model.provider, modelId: model.id, state: route.state };
				// append 返回 id，getEntry 再取可通知观察者的真实条目。
				const entry = this.sessionManager.getEntry(
					// 把路由状态存自定义条目，不把它当用户正文发送。
					this.sessionManager.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, data),
				);
				// 成功取到条目才发布追加通知。
				if (entry) this._emit({ type: "entry_appended", entry });
			}
			// The route stands: the router already decided this request. The state entry does not change
			// the projection.
			// 按本次确定的物理模型容量检查压缩，避免使用虚拟入口的泛化容量。
			if (this._exceedsCompactionThreshold(route.model, projection)) {
				// 超阈值时执行自动压缩；默认方案会调用模型生成摘要，false 表示不重试已完成回答。
				await this._runAutoCompaction("threshold", false);
				// 压缩改变历史，重新调用准备快照，但不重做已决定的物理路由。
				({ previous, context } = await prepare());
			}
			// 保留原回调其余字段，覆盖最终上下文、物理模型和思考级别。
			return { ...previous, context, model: route.model, thinkingLevel: route.thinkingLevel };
		};
	}

	/**
	 * 在一个 assistant 回合完成后执行 turn_end 扩展边界，返回扩展是否要求继续。
	 * 记录回合结果与消息条目 id，给扩展预览草稿，提交有效条目，再验证继续请求是否有可运行上下文；无法定位 assistant 条目则报告扩展错误并返回 false。
	 * 例：扩展追加 custom_message 后要求继续，可让模型处理这条上下文；只有 assistant 结尾且无待投递输入时不准空续跑。
	 */
	private async _dispatchTurnEndBoundary(
		// 本回合已完成的 assistant 对象。
		message: AssistantMessage,
		// 该回合所有配对工具结果，边界发生在结果保存之后。
		toolResults: ToolResultMessage[],
		// 返回是否要求低层再继续，并非返回模型内容。
	): Promise<boolean> {
		// 按 stopReason 映射边界结果，其余如 toolUse/length 在这里归 completed。
		this._lastActivityOutcome =
			// 取消优先映 aborted，错误映 error，其他归 completed。
			message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";
		// 后续扩展编辑需要已保存的 assistant 来源 id。
		const messageEntryId = this._findPersistedMessageEntryId(message);
		// 无 turn_end 处理器不做草稿预览，直接无续跑要求。
		if (!this._extensionRunner.hasHandlers("turn_end")) return false;
		// 无法定位来源时，不给扩展一个不可编辑的伪 id。
		if (!messageEntryId) {
			// 向扩展错误监听器报告边界定位失败。
			this._extensionRunner.emitError({
				// 边界内部错误使用合成来源标签。
				extensionPath: "<boundary>",
				// 指出发生在 turn_end 阶段。
				event: "turn_end",
				// 提供具体缺少来源条目的错误说明。
				error: "turn_end could not resolve the persisted assistant entry ID",
			});
			// 不能完成有效边界处理时停止这条续跑决定。
			return false;
		}
		// 将每个工具结果转成对应条目 id；flatMap 允许缺失时产出零项。
		const toolResultEntryIds = toolResults.flatMap((result) => {
			// 逐结果按映射/投影解析来源。
			const entryId = this._findPersistedMessageEntryId(result);
			// 有来源返回单项数组，没有则不加入 id 列表。
			return entryId ? [entryId] : [];
		});
		// 派发支持草稿预览和顺序扩展处理的边界。
		const boundary = await this._extensionRunner.emitBoundary(
			{
				// 明确本次是回合边界。
				type: "turn_end",
				// 当前运行内回合下标。
				turnIndex: this._turnIndex,
				// 传已保存的 assistant 正文对象。
				message,
				// 传配对工具结果数组。
				toolResults,
				// 扩展可据此对 assistant 做 context_edit。
				messageEntryId,
				// 工具结果对应的来源 id 列表。
				toolResultEntryIds,
				// 本回合结果分类。
				outcome: this._lastActivityOutcome,
			},
			// 每轮扩展草稿变化后，用内存 manager 重新计算预览。
			(entries) => this._buildBoundaryContext(entries, "turn_end"),
		);
		// 边界返回有效草稿后，提交到真实会话并刷新上下文。
		this._commitBoundaryDrafts(boundary.entries);
		// 扩展即便要求继续，也必须在最终提交状态仍有可运行输入。
		if (boundary.continue && !this._buildBoundaryContext([], "turn_end").canContinue) {
			// 报告无效继续要求，不暗中创建用户消息。
			this._reportInvalidBoundaryContinuation("turn_end");
			// 返回不继续，让外层按正常结束处理。
			return false;
		}
		// 通过检查后沿用扩展的继续标志。
		return boundary.continue;
	}

	/**
	 * 包装 Agent.finishTurn，把会话扩展边界的续跑决定并入已有钩子，返回 void。
	 * 实际回调先执行扩展，再执行原钩子；原钩子明确 end 优先，否则任一方 continue 就继续。例：扩展要求继续，但宿主明确 end 时仍结束。
	 */
	private _installAgentBoundaryHooks(): void {
		// 保存之前的 finishTurn，包装而非丢掉宿主决定。
		const previousFinishTurn = this.agent.finishTurn;
		// 低层每轮执行完工具后调用这个异步回调。
		this.agent.finishTurn = async (turn, signal) => {
			// 记住已发边界的消息对象，避免后续 turn_end 事件再次处理。
			this._boundaryDispatchedMessages.add(turn.message);
			// 先等扩展完成草稿与续跑决定。
			const extensionContinue = await this._dispatchTurnEndBoundary(turn.message, turn.toolResults);
			// 再等原宿主结束钩子，仍传 turn/signal。
			const previousDecision = await previousFinishTurn?.(turn, signal);
			// 原钩子明确结束具有优先权。
			if (previousDecision?.action === "end") return previousDecision;
			// 任一要求继续则给低层 continue 决定。
			if (extensionContinue || previousDecision?.action === "continue") return { action: "continue" };
			// 两边都没特殊决定，让低层走默认停止/队列规则。
			return undefined;
		};
	}

	// 在两次模型回答之间安装刷新钩子，工具结果已经保存后才准备下一轮。
	/**
	 * 安装回合之间的刷新回调，兼容原 prepareNextTurn/WithContext，再协调压缩、提示词及工具。
	 * 实际回调返回下一轮快照和可选 system 补丁；会修改当前工具集合和本次提示词选项。例：工具执行中启用新工具，下一轮更新本地实现和模型声明。
	 */
	private _installAgentNextTurnRefresh(): void {
		// 优先包装带回合上下文的新接口。
		const previousPrepareNextTurnWithContext =
			// ?? 只有新接口不存在时，尝试兼容旧 prepareNextTurn。
			this.agent.prepareNextTurnWithContext ??
			// 原旧接口存在才生成适配箭头函数。
			(this.agent.prepareNextTurn
				? // 忽略新 turn 参数，只把 signal 转给旧接口并等待它。
					async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: // 两个旧接口都没提供时不用制造空回调。
					undefined);
		// 把带上一回合信息的回调挂到 Agent；低层 runLoop 在下一回合前触发它。
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			// 先检查历史大小；必要时调用压缩，再得到新上下文。
			const context = await this._compactBeforeNextAssistantResponse(turn.context);
			// 把刷新后的上下文继续交给之前的钩子，保留已有调用者的行为。
			const previousSnapshot = await previousPrepareNextTurnWithContext?.({ ...turn, context }, signal);
			// 以之前钩子的替换结果为准；没有替换就用刚准备的上下文。
			const nextContext = previousSnapshot?.context ?? context;
			// 优先使用本次运行的提示词选项，否则用基础配置。
			const runOptions = this._runSystemPromptOptions ?? this._baseSystemPromptOptions;
			// 统一规范化下一轮提示词数据，后续按章节 diff。
			const options = normalizeBuildSystemPromptOptions({
				// 先保留本次运行提示词的其他选项。
				...runOptions,
				// 工具名以当前 Agent 激活集合为准。
				selectedTools: this.getActiveToolNames(),
				// 基础工具摘要与本次临时摘要合并，后者同名优先。
				toolSnippets: { ...this._baseSystemPromptOptions.toolSnippets, ...runOptions.toolSnippets },
				// 工具规则也按基础加本次覆盖合并。
				toolGuidelines: { ...this._baseSystemPromptOptions.toolGuidelines, ...runOptions.toolGuidelines },
			});
			// 比较提示词与工具声明；有变化时生成 system 补丁，而不是每轮无条件重写全部历史。
			const updateMessage = this._preparePromptAndToolLoadout(options, nextContext.messages);
			// Keep session.systemPrompt and ctx.getSystemPrompt() in step with what the provider sees.
			// 保存本轮最终提示词选项，让 session.systemPrompt 与模型看到的规则一致。
			this._runSystemPromptOptions = options;

			// 返回下一轮快照，不在此直接发模型请求。
			return {
				// 保留原回调提供的其他快照属性。
				...previousSnapshot,
				// 组上下文，把本地工具实现与消息投影分开维护。
				context: {
					// 保留消息与其他上下文字段。
					...nextContext,
					// 保留工具的本地实现；模型实际看到的声明则来自 system 消息。
					tools: this.agent.state.tools.slice(),
				},
				// system 补丁存在才追加到本轮待投递消息中。
				messages: updateMessage
					? // 先保留原回调的新消息，再追加提示词更新。
						[...(previousSnapshot?.messages ?? []), updateMessage]
					: // 没有 system 变化时沿用原回调 messages，可能 undefined。
						previousSnapshot?.messages,
				// 基于 Agent 当前模型选择构建本次请求，避免用旧快照中的模型。
				model: this.agent.state.model,
				// 使用当前思考级别；工具执行期间设置也可能变化。
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/**
	 * 用 SessionManager 的当前投影覆盖 Agent 已完成历史，并登记投影消息与来源条目 id。
	 * 返回 void，不重读磁盘；修改 Agent.messages 和弱映射。例：一次 context_edit 后调用它，后续请求与 UI 读到同一份有效历史。
	 */
	private _refreshFinalizedContext(): void {
		// 从会话树计算模型可见的最终消息与来源关联。
		const projection = this.sessionManager.buildSessionProjection();
		// 遍历每个投影条目，它可贡献零条/一条/多条消息。
		for (const entry of projection.entries) {
			// 把每条投影消息对象关联到来源条目，供编辑和恢复配对定位。
			for (const message of entry.messages) this._entryIdsByMessage.set(message, entry.sourceEntry.id);
		}
		// 用投影消息数组替换低层已完成上下文；不是追加重复历史。
		this.agent.state.messages = projection.messages;
	}

	/**
	 * 把扩展边界草稿依次追加到指定 manager，返回找到的实际会话条目数组。
	 * 支持 custom、custom_message、context_edit、compaction；压缩草稿的 tokensBefore 在应用到它时计算。
	 * 可能写入该 manager 对应会话；例：传内存预览 manager 只影响预览，传真实 manager 则提交历史。
	 */
	private _applyBoundaryDrafts(manager: SessionManager, drafts: SessionBoundaryDraft[]): SessionEntry[] {
		// 按追加顺序收集真实条目。
		const appended: SessionEntry[] = [];
		// 依序应用草稿，后面的草稿可基于前面已追加的状态。
		for (const draft of drafts) {
			// 每种分支都要产出条目 id，随后统一查条目。
			let entryId: string;
			// type 分辨草稿形状，TS 在各 case 收窄可用字段。
			switch (draft.type) {
				// custom 是程序化元数据，不是模型 custom 消息。
				case "custom":
					// 追加分类和任意数据，由会话管理器保存。
					entryId = manager.appendCustomEntry(draft.customType, draft.data);
					// break 防止落入下一个草稿分支。
					break;
				// custom_message 是可见/可入上下文的扩展消息。
				case "custom_message":
					// 将消息字段交会话层生成 id 与时间。
					entryId = manager.appendCustomMessageEntry(
						// 保留消息分类。
						draft.customType,
						// 保留文字或图片内容。
						draft.content,
						// 保留 UI 显示偏好。
						draft.display,
						// 保留程序化详情。
						draft.details,
					);
					// 本草稿已经处理完。
					break;
				// context_edit 按来源 id 修改模型投影，而非删除原条目。
				case "context_edit":
					// replacement=null 表示隐去，否则用替换数据重投影。
					entryId = manager.appendContextEdit(draft.targetId, draft.replacement);
					// 处理完编辑后走下一草稿。
					break;
				// 局部花括号允许该 case 单独声明 tokensBefore。
				case "compaction": {
					// 在应用本压缩草稿前即时估算现状。
					const tokensBefore = estimateProjectedContextTokens(
						// 使用指定 manager 的当前投影，预览时不读原 manager。
						manager.buildSessionProjection(),
						// 同一 manager 的当前分支供失效用量判断。
						manager.getBranch(),
						// 取估算结果的 tokens 数字。
					).tokens;
					// 追加扩展提供的压缩，而不是在此调用模型。
					entryId = manager.appendCompaction(
						// 扩展给出的摘要正文。
						draft.summary,
						// 从哪个来源条目开始保留原文。
						draft.firstKeptEntryId,
						// 刚计算的压缩前 token 估算。
						tokensBefore,
						// 扩展附带详情。
						draft.details,
						// true 标记压缩来自扩展。
						true,
						// 附扩展摘要过程的可选用量。
						draft.usage,
					);
					// 本草稿处理完成。
					break;
				}
			}
			// 追加接口返回 id，再按 id 找完整条目。
			const entry = manager.getEntry(entryId);
			// 找到才加入结果，避免对外发布 undefined。
			if (entry) appended.push(entry);
		}
		// 返回本次按序追加的条目数组。
		return appended;
	}

	/**
	 * 复制当前会话头和当前分支到内存 manager，再应用候选草稿，用于预览；返回新 manager。
	 * 缺会话头则抛错；不在本函数写原会话。例：扩展先预览一个删除上下文的 context_edit，确认后才由提交路径写入。
	 */
	private _createBoundaryPreviewManager(drafts: SessionBoundaryDraft[]): SessionManager {
		// 预览需要沿用同一会话头元数据。
		const header = this.sessionManager.getHeader();
		// 没有头无法构建一致预览，明确抛错。
		if (!header) throw new Error("Session header is missing");
		// 创建内存会话，种子仅当前分支而不是整棵其他分支。
		const manager = SessionManager.inMemory(this._cwd, undefined, [header, ...this.sessionManager.getBranch()]);
		// 在这个内存副本应用候选条目，不提交原会话。
		this._applyBoundaryDrafts(manager, drafts);
		// 返回可继续 buildSessionProjection 的预览 manager。
		return manager;
	}

	/**
	 * 合并低层 Agent 下一批待投递消息和会话暂存 custom 消息，返回新数组。
	 * 低层优先预览 steering，只有没有插话时才预览 followUp；该批还受 all/one-at-a-time 策略限制，不是两队列全部等待消息。
	 * 仅预览，不消费队列，消息对象仍共享。例：A 插话与 B 追问同时排队时，这里含 A 和暂存 custom，不同时含 B。
	 */
	private _getPendingBoundaryMessages(): AgentMessage[] {
		// 展开低层选出的下一批与全部暂存 custom；peek 不消费低层队列。
		return [...this.agent.peekQueuedMessages(), ...this._pendingCustomMessages];
	}

	/**
	 * 为 turn_end 或 agent_before_settle 计算草稿应用后的上下文预览与 canContinue。
	 * 从内存分支投影、转为模型消息，再结合末角色和队列判断；返回数据，不提交草稿。
	 * 例：仅 system 内容不够继续；末条是 user 则有模型可回答输入。两个边界对排队消息的放行条件略有区别，见下面条件。
	 */
	private _buildBoundaryContext(
		// 要预览的扩展草稿数组。
		drafts: SessionBoundaryDraft[],
		// 边界种类决定后面对排队输入的继续条件。
		boundary: "turn_end" | "agent_before_settle",
		// 返回扩展可读取的投影及可继续标志。
	): BoundaryContextPreview {
		// 先在内存副本应用草稿，再计算有效消息。
		const projection = this._createBoundaryPreviewManager(drafts).buildSessionProjection();
		// 读取尚未落入历史的等待消息。
		const pendingMessages = this._getPendingBoundaryMessages();
		// 去掉应用特有角色的包装，按真实模型消息判断结尾。
		const llmMessages = convertToLlm(projection.messages);
		// 空列表末项为 undefined；可选链避免访问缺项。
		const finalRole = llmMessages[llmMessages.length - 1]?.role;
		// 至少需要非 system 消息，纯规则不能单独形成一次可回答任务。
		const hasNonSystemContext = llmMessages.some((message) => message.role !== "system");
		// 已有非 system 且末条不为 assistant，当前上下文可继续请求。
		const contextCanContinue = hasNonSystemContext && finalRole !== "assistant";
		// context-only custom 等待入历史，也视为有继续内容。
		const pendingCustomContext = this._pendingCustomMessages.length > 0;
		// 返回预览，不改原会话位置。
		return {
			// 条目与其产生的消息之间的投影关系。
			contextEntries: projection.entries,
			// 仍是 Agent 应用层消息类型的有效上下文。
			contextMessages: projection.messages,
			// 转换成统一模型角色后的消息。
			llmMessages,
			// 低层队列与 custom 暂存合并的等待输入。
			pendingMessages,
			// 下面是三个可继续条件的逻辑或。
			canContinue:
				// 现有上下文本身已有非 assistant 结尾。
				contextCanContinue ||
				// 或者还有待追加 custom 上下文。
				pendingCustomContext ||
				// 回合结束与最终收尾对于低层队列采用不同条件。
				(boundary === "turn_end"
					? // turn_end 直接允许低层队列提供续跑输入。
						this.agent.hasQueuedMessages()
					: // 最终收尾只有 assistant 结尾且还有低层队列时由队列补新输入。
						finalRole === "assistant" && this.agent.hasQueuedMessages()),
		};
	}

	/**
	 * 提交扩展边界草稿，刷新有效历史，并逐条发布 entry_appended；返回 void。
	 * 例：扩展返回两个草稿时按顺序写入，监听者收到的是提交后的真实条目，而不是未提交预览。
	 */
	private _commitBoundaryDrafts(drafts: SessionBoundaryDraft[]): void {
		// 同样应用函数这次指向真实 manager，完成提交。
		const appended = this._applyBoundaryDrafts(this.sessionManager, drafts);
		// 让 Agent 状态与刚提交的树投影同步。
		this._refreshFinalizedContext();
		// 逐条通知已保存结果，保持追加顺序。
		for (const entry of appended) this._emit({ type: "entry_appended", entry });
	}

	/**
	 * 报告扩展要求续跑但上下文不可运行的错误，返回 void；交给扩展错误监听器。
	 * 例：turn_end 返回 continue=true，却没有新增可回答输入或待投递消息时，提示该决定无效。
	 */
	private _reportInvalidBoundaryContinuation(event: "turn_end" | "agent_before_settle"): void {
		// 错误交扩展统一监听，不在此 throw 或启动模型。
		this._extensionRunner.emitError({
			// 使用合成边界来源。
			extensionPath: "<boundary>",
			// 保留具体边界事件名。
			event,
			// 说明请求继续但无可运行模型输入的原因。
			error: `${event} requested continuation without runnable model context`,
		});
	}

	/** Emit an event to all listeners */
	/**
	 * 同步向本会话的公开监听器发送一个事件，返回 void；不等待监听器里的异步工作。
	 * 例：queue_update 让终端或 RPC 更新队列展示；监听器抛出异常会向当前调用传播，这里没有 catch。
	 */
	private _emit(event: AgentSessionEvent): void {
		// 按当前监听器数组逐项同步调用。
		for (const l of this._eventListeners) {
			// 调用监听函数；没有 try/catch，异常可传播给事件处理调用方。
			l(event);
		}
	}

	/**
	 * 发布当前插话/追问文字快照，返回 void；复制数组避免监听器直接改队列容器。
	 * 例：加入第二条追问后发送 followUp=[第一条,第二条]，不含图片或自定义消息队列。
	 */
	private _emitQueueUpdate(): void {
		// 用一个 queue_update 事件报告两类展示队列。
		this._emit({
			// 事件分辨字段。
			type: "queue_update",
			// 复制插话数组，保护内部容器不直接交给订阅者。
			steering: [...this._steeringMessages],
			// 复制追问数组，同样不复制不存在于此的图片数据。
			followUp: [...this._followUpMessages],
		});
	}

	/**
	 * 有 session_compact_failed 扩展监听器时，补 type 并异步派发失败信息。
	 * Omit 从输入类型移除 type，调用方只给 reason/aborted 等数据；例：自动压缩被取消也可按事件标记通知扩展。
	 */
	private async _emitSessionCompactFailed(event: Omit<SessionCompactFailedEvent, "type">): Promise<void> {
		// 无监听器就跳过派发工作。
		if (this._extensionRunner.hasHandlers("session_compact_failed")) {
			// Omit 输入不带 type，这里补事件字面量并等待扩展处理。
			await this._extensionRunner.emit({ type: "session_compact_failed", ...event });
		}
	}

	/**
	 * 取得会话级“等空闲”Promise，多名等待者共享同一个，返回 Promise<void>。
	 * 首次创建时保存 resolve，后续由 _resolveIdleWaitIfIdle 完成；例：两个 waitForIdle 都等本次运行最终收尾。
	 */
	private _getIdleWaitPromise(): Promise<void> {
		// 共享等待 Promise 不存在才创建。
		if (!this._idleWaitPromise) {
			// Promise 构造器同步拿到 resolve，本身尚未完成。
			this._idleWaitPromise = new Promise((resolve) => {
				// 把完成函数留给空闲状态转换处调用。
				this._resolveIdleWait = resolve;
			});
		}
		// 返回同一个待完成 Promise，避免每个等待者各建生命周期。
		return this._idleWaitPromise;
	}

	/**
	 * 会话已空闲且确有等待者时，清除等待状态并完成 Promise；否则无动作。
	 * 返回 void；先清引用再 resolve，后续新运行可创建独立等待。例：压缩刚完成但 Agent 仍运行时不提前放行。
	 */
	private _resolveIdleWaitIfIdle(): void {
		// 非空闲或无人等待时不能/无需完成 Promise。
		if (!this.isIdle || !this._resolveIdleWait) {
			// 提前返回，不改变等待引用。
			return;
		}
		// 先把 resolve 取到局部变量，后面可清字段。
		const resolve = this._resolveIdleWait;
		// 清旧 Promise，后续等待可独立建新 Promise。
		this._idleWaitPromise = undefined;
		// 清旧完成函数，防止同一等待多次消费。
		this._resolveIdleWait = undefined;
		// 完成等待者，不传值，符合 Promise<void>。
		resolve();
	}

	/**
	 * 发布整个会话运行 settled，处理通知期间延迟提交的新任务，再尝试唤醒空闲等待者。
	 * 先通知保温器，再将运行标记设空闲、派发扩展/公开事件并顺序执行延迟动作；保温器的后续调度由它自身决定。
	 * 例：settled 监听器再次 prompt，新任务排入 deferred，等当前通知完成后启动，避免收尾重入。
	 */
	private async _emitAgentSettled(): Promise<void> {
		// 通知保温器整个运行结束；具体保温调度策略在 warmer 内。
		this._cacheWarmer?.onAgentSettled();
		// 低层与扩展续跑都结束后，标记该运行不再忙碌。
		this._isAgentRunActive = false;
		// 通知期间禁止新 prompt 直接重入，而是收集延迟操作。
		this._isEmittingAgentSettled = true;
		// 无论扩展事件成功与否，都要释放通知中标记。
		try {
			// 记录本次运行是否收到取消意图。
			const aborted = this._agentRunAbortRequested;
			// 先异步通知扩展，扩展可注册后续工作。
			await this._extensionRunner.emit({ type: "agent_settled", aborted });
			// 再同步通知 UI/RPC 等公开观察者。
			this._emit({ type: "agent_settled", aborted });
			// finally 不依赖 try 是否正常返回。
		} finally {
			// 结束 settled 派发阶段，后续真正执行延迟任务可启动新运行。
			this._isEmittingAgentSettled = false;
		}

		// splice(0) 取走全部延迟任务并清原数组。
		const deferred = this._deferredSettledActions.splice(0);
		// 有延迟任务时顺序处理，不能同时开多个并行运行。
		if (deferred.length > 0) {
			// 即便延迟动作失败，仍重新判断是否空闲。
			try {
				// await 每项，保持监听器提交顺序。
				for (const action of deferred) await action();
				// finally 做空闲唤醒，不吞掉动作异常。
			} finally {
				// 只有延迟任务没有启动新的忙碌状态才放行等待者。
				this._resolveIdleWaitIfIdle();
			}
			// 有延迟分支已做空闲协调，不再往下重复调用。
			return;
		}
		// 没有延迟动作时，按最终状态完成共享等待。
		this._resolveIdleWaitIfIdle();
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	// Agent.processEvents → 此回调 → 扩展/公开订阅者 → SessionManager 保存。箭头函数保留 this。
	/**
	 * 处理低层 Agent 的每个事件：记录嵌套用量、同步队列展示、先派发扩展/公开事件，再持久化完整消息。
	 * 箭头属性保留 this；message_end 记录消息来源并更新重试/压缩状态，turn_end 再冲刷上下文专用消息。
	 * 例：逐字 message_update 只通知观察者，最终 message_end 才追加一次完成消息；扩展替换内容后保存替换结果。
	 */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// An abort requested while the run was starting, e.g. during before_agent_start, stops it
		// here. agent_start is awaited before the first request.
		// 启动准备期间收到取消时，低层 agent_start 一到就发 abort，首个请求前会观察信号。
		if (event.type === "agent_start" && this._agentRunAbortRequested) this.agent.abort();
		// Record the calls a tool made through ctx.executeTool() and their usage on its result message.
		// 只有发生过嵌套调用才有记录可处理。
		if (this._nestedToolCalls) {
			// 父工具结果消息开始时，将其全部嵌套调用汇总挂到该结果上。
			if (event.type === "message_start" && event.message.role === "toolResult") {
				// TS 已按角色收窄为工具结果消息。
				const message = event.message;
				// 按父 toolCallId 消费记录，避免下次重复累计。
				const summary = this._nestedToolCalls.takeRecord(message.toolCallId);
				// 有调用记录才写 nestedCalls 元数据。
				if (summary?.calls) message.nestedCalls = summary.calls;
				// 有嵌套用量时合并，不把它遗漏到会话统计外。
				if (summary?.usage) {
					// 原工具已有用量就相加，否则直接采用嵌套用量。
					message.usage = message.usage ? combineUsage(message.usage, summary.usage) : summary.usage;
				}
				// 低层这次运行结束时清空残留嵌套调用记录。
			} else if (event.type === "agent_end") {
				// 释放没被父结果消费的调用范围数据。
				this._nestedToolCalls.clear();
			}
		}
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		// 用户消息真正开始投递时，再从展示队列中移除对应文字。
		if (event.type === "message_start" && event.message.role === "user") {
			// 新用户输入开始，允许它有独立的一次溢出恢复。
			this._overflowRecoveryAttempted = false;
			// 将用户文字块拼起来，用空分隔符匹配排队原文。
			const messageText = contentText(event.message.content, "");
			// 没有文字时无法按该文字数组匹配，图片/空文字不会走下面查找。
			if (messageText) {
				// Check steering queue first
				// 优先找插话队列中同文第一项，indexOf 找不到返回 -1。
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				// 找到才移除，避免 splice(-1,1) 错删末项。
				if (steeringIndex !== -1) {
					// 删除已交给 Agent 的一项插话展示。
					this._steeringMessages.splice(steeringIndex, 1);
					// 立即发布新队列快照，再对外发当前消息事件。
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					// 插话没找到时，再查追问队列，保持同文消息匹配优先级。
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					// 追问找不到同样不修改数组。
					if (followUpIndex !== -1) {
						// 移除已经投递的首个同文追问。
						this._followUpMessages.splice(followUpIndex, 1);
						// 通知公开观察者更新追问显示。
						this._emitQueueUpdate();
					}
				}
			}
		}

		// Emit to extensions first, then notify public listeners.
		// 先让扩展处理事件；message_end 扩展可以替换消息内容，替换结果随后会被保存。
		await this._emitExtensionEvent(event);
		// 再通知公开订阅者，agent_end 额外告诉 UI 是否预计重试。注意这里仍早于下方 appendMessage。
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);

		// Handle session persistence
		// 只在完整消息结束时进入保存路径；message_update 的每个字符片段不会各存一条消息。
		if (event.type === "message_end") {
			// 保存后会得到条目 id；不是所有自定义角色都由这里负责保存，所以可能没有 id。
			let entryId: string | undefined;
			// Check if this is a custom message from extensions
			// custom 角色用 custom_message 专属条目，不与普通模型 message 条目混存。
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				// 按 custom 专属条目格式保存扩展消息。
				entryId = this.sessionManager.appendCustomMessageEntry(
					// 扩展分类名。
					event.message.customType,
					// 扩展正文或内容块。
					event.message.content,
					// 是否在界面展示，不控制 convertToLlm 是否发送。
					event.message.display,
					// 扩展自定义详情。
					event.message.details,
				);
			} else if (
				// 普通模型角色走统一 message 条目保存。
				event.message.role === "system" ||
				// user 是用户请求角色。
				event.message.role === "user" ||
				// assistant 包含回复、思考与工具调用。
				event.message.role === "assistant" ||
				// toolResult 与工具调用 id 配对。
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				// 保存 system/user/assistant/toolResult；文件会话追加 JSONL，内存会话只更新内存。
				entryId = this.sessionManager.appendMessage(event.message);
			}
			// 记录消息对象与会话条目 id 的关系，后面上下文编辑/扩展边界可以准确定位。
			if (entryId) this._entryIdsByMessage.set(event.message, entryId);
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// 只有 assistant 回复需要更新重试/压缩协调状态。
			if (event.message.role === "assistant") {
				// 沿用原有类型断言；上面的角色判断在开发期已提供收窄依据。
				const assistantMsg = event.message as AssistantMessage;
				// 留住最后一条 assistant 回复，低层结束后还要用它判断重试与自动压缩。
				this._lastAssistantMessage = assistantMsg;
				// 除 error/length 之外，清掉本轮溢出恢复已尝试标记。
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
					// 下一次异常可重新考虑一次恢复，不永久卡在“已经恢复过”。
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				// 非 error 的回复视为结束当前普通重试计数，包括取消/长度等非 error 状态。
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					// 发布一次重试结束结果。
					this._emit({
						// 普通重试结束事件名。
						type: "auto_retry_end",
						// 本条件按非 error 判定 success，不等同于业务任务一定完成。
						success: true,
						// 报告已尝试过的额外重试次数。
						attempt: this._retryAttempt,
					});
					// 本回复处理完，清普通重试累计次数。
					this._retryAttempt = 0;
				}
			}
		}

		// A turn ends after its assistant message and every tool result has been appended,
		// so this is the first point in the run where a context-only custom message can be
		// inserted without landing between a tool call and its result. Flushing after the
		// extension and listener dispatch above also picks up messages that turn_end
		// handlers queued.
		// 模型本回合要求的所有工具结果都已保存，此时插入额外上下文不会拆散调用/结果对。
		if (event.type === "turn_end") {
			// 把等待安全边界的自定义消息写进会话，避免夹在 toolCall 和对应 toolResult 中间。
			this._flushPendingCustomMessages();
		}
	};

	/**
	 * 根据 agent_end 最后一条 assistant 和重试预算预告是否可能重试，返回 boolean。
	 * 只做判定，不休眠、不删消息；取消、禁用或预算用完均 false。例：429 错误且还有预算时 UI 可显示后面还有重试。
	 */
	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		// 会话已经取消就不向 UI 预告继续重试。
		if (this._agentRunAbortRequested) return false;
		// 读取是否开启及次数预算。
		const settings = this.settingsManager.getRetrySettings();
		// 禁用或预算已到头，后面不会再安排普通重试。
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			// false 只表示预告不再普通重试，不涵盖溢出压缩恢复。
			return false;
		}

		// 从本次运行消息末尾倒查，不把更早的错误误作最终结果。
		for (let i = event.messages.length - 1; i >= 0; i--) {
			// 取得本次迭代消息。
			const message = event.messages[i];
			// 找到最后 assistant 就用它判断。
			if (message.role === "assistant") {
				// 委托统一错误分类，溢出会被排除。
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		// 没有 assistant 无法安排对应错误重试。
		return false;
	}

	/**
	 * 找消息对应的会话来源 id：先查弱映射，再按原对象匹配分支，最后按 Agent 消息位置对照投影。
	 * 返回 id 或 undefined，可能补写弱映射，不写会话。例：context_edit 生成的新消息对象仍可追溯到来源条目。
	 */
	private _findPersistedMessageEntryId(message: AgentMessage): string | undefined {
		// 优先通过对象弱映射直接定位来源。
		const mapped = this._entryIdsByMessage.get(message);
		// 已有映射立刻返回，免去扫描。
		if (mapped) return mapped;
		// 复制分支再 reverse，避免改变 manager 分支数组的顺序。
		for (const entry of [...this.sessionManager.getBranch()].reverse()) {
			// 原始 message 条目仍引用同一对象时可直接定位。
			if (entry.type === "message" && entry.message === message) return entry.id;
		}

		// 原对象可能只存在 Agent 状态，用其位置对照有效投影。
		const messageIndex = this.agent.state.messages.indexOf(message);
		// 不在 Agent 状态也不在原树时无法继续映射。
		if (messageIndex < 0) return undefined;
		// 取得与 Agent 消息顺序对应的权威投影。
		const projection = this.sessionManager.buildSessionProjection();
		// 投影条目不一定一条对应一消息，需要累计消息下标。
		let projectedIndex = 0;
		// 遍历投影来源条目。
		for (const entry of projection.entries) {
			// 逐条遍历该来源贡献的消息，空贡献不会增加索引。
			for (let i = 0; i < entry.messages.length; i++) {
				// 找到与 Agent 数组同一位置的来源。
				if (projectedIndex === messageIndex) {
					// 记缓存以便下次直接查找。
					this._entryIdsByMessage.set(message, entry.sourceEntry.id);
					// 返回来源条目 id，而不是消息自己的工具调用 id。
					return entry.sourceEntry.id;
				}
				// 每经过一条投影消息增加全局位置。
				projectedIndex++;
			}
		}
		// 扫描仍未匹配则显式返回 undefined。
		return undefined;
	}

	/**
	 * Persistently omit a failed attempt and its tool results from model context. Results are
	 * found in the projected context, so the pair stays together whether the attempt comes from
	 * the current run or a resumed session. An unpaired result fails the next request (#11227).
	 */
	/**
	 * 将一次失败 assistant 及其配对工具结果从模型上下文持久隐去，保留原始会话记录。
	 * 收集调用 id，在下一条 assistant 前找对应结果，解析来源后追加 replacement=null 的 context_edit，再刷新投影。
	 * 若仍在投影中的目标无法定位来源就抛错。例：重试含工具调用的失败请求时，一起隐去调用/结果，避免留下孤立 toolResult。
	 */
	private _omitRecoveryAttempt(message: AssistantMessage): void {
		// flatMap 从 toolCall 块提取 id，其他块产空数组，Set 去重。
		const toolCallIds = new Set(message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])));
		// A context edit replaces the projected copy, so match it by source entry as well.
		// context_edit 可能替换对象，来源 id 可连回原记录。
		const entryId = this._findPersistedMessageEntryId(message);
		// 后续工具结果匹配依据当前有效上下文。
		const messages = this.agent.state.messages;
		// 查失败 assistant 在有效历史中的位置。
		const index = messages.findIndex(
			// 既认原对象，也认同源条目的替换对象。
			(m) => m === message || (entryId !== undefined && this._entryIdsByMessage.get(m) === entryId),
		);
		// 收集应与该失败尝试一同隐去的结果。
		const toolResults: AgentMessage[] = [];
		// 只在找到 assistant 时扫描后文，否则不猜归属。
		for (const m of index < 0 ? [] : messages.slice(index + 1)) {
			// 下一条 assistant 表示下一个尝试/回合，停止跨界扫描。
			if (m.role === "assistant") break;
			// 只收属于本 assistant 工具调用 id 的 toolResult。
			if (m.role === "toolResult" && toolCallIds.has(m.toolCallId)) toolResults.push(m);
		}
		// 失败 assistant 与对应结果组成同一省略目标组。
		const targets = [message, ...toolResults];
		// 将每个消息解析为可以持久编辑的条目 id。
		const targetIds = targets.map((target) => this._findPersistedMessageEntryId(target));
		// 不能把仍存在于模型上下文的消息无声漏删。
		const unresolvedProjectedTarget = targets.some(
			// 若没 id 且仍在投影中，就标记无法持久省略。
			(target, index) => targetIds[index] === undefined && this.agent.state.messages.includes(target),
		);
		// 发现未解决目标，拒绝部分提交，避免拆散调用/结果。
		if (unresolvedProjectedTarget) {
			// 抛错让恢复失败可见，不伪装已成功清上下文。
			throw new Error("Cannot persist recovery omission because a projected message has no source entry");
		}
		// 逐个来源追加上下文省略编辑。
		for (const targetId of targetIds) {
			// 不在当前投影又无来源的目标可以跳过。
			if (!targetId) continue;
			// null replacement 表示模型不再看到，但原条目仍留在 raw 历史。
			const editId = this.sessionManager.appendContextEdit(targetId, null);
			// 按新增编辑 id 取真实条目供事件通知。
			const entry = this.sessionManager.getEntry(editId);
			// 找到编辑条目才发布 entry_appended。
			if (entry) this._emit({ type: "entry_appended", entry });
		}
		// 重建当前有效历史，立即让 Agent 不再包含该失败尝试。
		this._refreshFinalizedContext();
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	/**
	 * 从 Agent 当前消息倒序找最近 assistant，包括 error/aborted，返回原对象或 undefined。
	 * 没有 I/O。例：发送新问题前需要检查上次取消回复的上下文用量，也能在此找到。
	 */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		// 读取消息数组引用，只倒查不重排。
		const messages = this.agent.state.messages;
		// 从末到首寻找，包含 error/aborted。
		for (let i = messages.length - 1; i >= 0; i--) {
			// 当前倒查项。
			const msg = messages[i];
			// 角色符合就不用再向前找。
			if (msg.role === "assistant") {
				// 返回原 assistant 对象，断言不创建副本。
				return msg as AssistantMessage;
			}
		}
		// 没有任何 assistant 时明确无结果。
		return undefined;
	}

	/**
	 * 保留消息对象身份，把 target 的自有可枚举字段替换为 replacement 字段，返回 void。
	 * 先删旧键再 Object.assign，原对象被修改；相同引用直接跳过。例：message_end 扩展改正文后，Agent 状态、事件和稍后保存仍指向同一个已更新对象。
	 */
	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		// 同一个对象不需要清键，否则会把自己的源数据删掉。
		if (target === replacement) {
			// 原样结束，不触碰对象字段。
			return;
		}

		// 先转 unknown 再转键值对象，仅供按键删除；断言不进行运行时转换。
		const targetRecord = target as unknown as Record<string, unknown>;
		// Object.keys 只枚举自有可枚举字符串键。
		for (const key of Object.keys(targetRecord)) {
			// 移除原对象已有字段，避免 replacement 没有的旧字段残留。
			delete targetRecord[key];
		}
		// 把新消息字段写回原对象身份，所有持有 target 的位置同步可见。
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	/**
	 * 将低层 Agent 事件适配成扩展事件；message_end 允许替换消息，其余事件主要补回合序号或转发字段。
	 * 异步等待扩展；turn_end 用弱集合避免 finishTurn 已派发后重复触发；替换消息在扩展输入边界补空 content。
	 * 例：tool_execution_update 转发 partialResult，message_update 同时传供应商流事件用于细节渲染。
	 */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		// 低层运行开始，扩展回合计数从头开始。
		if (event.type === "agent_start") {
			// 第一回合编号为 0。
			this._turnIndex = 0;
			// 扩展收到 agent_start，但本方法没有重新启动 Agent。
			await this._extensionRunner.emit({ type: "agent_start" });
			// 低层运行结束，转发本次产生的消息。
		} else if (event.type === "agent_end") {
			// 扩展 agent_end 不是整个会话 settled，后面仍可能重试/续跑。
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
			// 新一轮模型回复开始时发布回合事件。
		} else if (event.type === "turn_start") {
			// 组扩展定义的 TurnStartEvent。
			const extensionEvent: TurnStartEvent = {
				// 事件分辨字段。
				type: "turn_start",
				// 使用本会话当前回合编号。
				turnIndex: this._turnIndex,
				// 派发时的毫秒时间，不重用原始请求开始时间。
				timestamp: Date.now(),
			};
			// 等扩展回合开始监听器完成。
			await this._extensionRunner.emit(extensionEvent);
			// 回合结束时，检查边界是否已由 finishTurn 派发。
		} else if (event.type === "turn_end") {
			// delete 同时查询并消费弱集合标记；已存在说明不要再派发。
			if (event.message.role === "assistant" && !this._boundaryDispatchedMessages.delete(event.message)) {
				// 兼容未经过 finishTurn 的结束路径，补一遍边界派发。
				await this._dispatchTurnEndBoundary(event.message, event.toolResults);
			}
			// 该回合结束后才增加编号。
			this._turnIndex++;
			// 消息开始：构造扩展契约的事件。
		} else if (event.type === "message_start") {
			// 显式标注 MessageStartEvent，TS 检查字段形状。
			const extensionEvent: MessageStartEvent = {
				// 开始事件名。
				type: "message_start",
				// 转发相同消息对象。
				message: event.message,
			};
			// 等待扩展完成，不在此追加历史。
			await this._extensionRunner.emit(extensionEvent);
			// 增量更新可能每次只多一点文字/思考/参数。
		} else if (event.type === "message_update") {
			// 组扩展消息更新事件。
			const extensionEvent: MessageUpdateEvent = {
				// 更新事件名。
				type: "message_update",
				// 当前累计中的 assistant 消息对象。
				message: event.message,
				// 底层供应商流事件描述这次具体增量。
				assistantMessageEvent: event.assistantMessageEvent,
			};
			// 等扩展处理增量，持久化仍等最终 message_end。
			await this._extensionRunner.emit(extensionEvent);
			// 消息最终完成时，扩展允许返回替代消息。
		} else if (event.type === "message_end") {
			// 创建完成事件，后续传给替换链。
			const extensionEvent: MessageEndEvent = {
				// 消息完成事件名。
				type: "message_end",
				// 仍是 Agent 已保存到内存的原消息对象。
				message: event.message,
			};
			// 异步取扩展链最后采用的消息替换结果。
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			// 没有替换则维持 Agent 原对象。
			if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				// 只有某些带 content 的角色才做空内容归一化。
				const normalized =
					// user 内容按块列表使用。
					(replacement.role === "user" ||
						// assistant 内容按块列表使用。
						replacement.role === "assistant" ||
						// toolResult 内容也不能保留 null。
						replacement.role === "toolResult" ||
						// custom 也可能由无类型扩展漏传正文。
						replacement.role === "custom") &&
					// == null 同时匹配 null/undefined；边界检查针对实际扩展返回值。
					replacement.content == null
						? // 空内容补 []，类型断言不改变其他字段。
							({ ...replacement, content: [] } as AgentMessage)
						: // 其他情况直接使用扩展原替换对象。
							replacement;
				// 原地复制替换字段，让事件、状态与随后保存一致。
				this._replaceMessageInPlace(event.message, normalized);
			}
			// 工具执行开始，适配参数供扩展观察。
		} else if (event.type === "tool_execution_start") {
			// 构造工具开始事件。
			const extensionEvent: ToolExecutionStartEvent = {
				// 执行进度事件，区别于可阻止执行的 tool_call。
				type: "tool_execution_start",
				// 工具调用配对 id。
				toolCallId: event.toolCallId,
				// 实际工具名称。
				toolName: event.toolName,
				// 已解析调用参数。
				args: event.args,
			};
			// 等待扩展开始观察回调。
			await this._extensionRunner.emit(extensionEvent);
			// 工具部分结果更新，不是最终 toolResult 消息。
		} else if (event.type === "tool_execution_update") {
			// 构造工具增量事件。
			const extensionEvent: ToolExecutionUpdateEvent = {
				// 工具更新事件名。
				type: "tool_execution_update",
				// 该进度属于的调用 id。
				toolCallId: event.toolCallId,
				// 正在执行的工具名。
				toolName: event.toolName,
				// 原调用参数。
				args: event.args,
				// 工具报告的部分结果，可用于进度预览。
				partialResult: event.partialResult,
			};
			// 等待扩展处理进度。
			await this._extensionRunner.emit(extensionEvent);
			// 工具执行结束，转发最终结果与错误状态。
		} else if (event.type === "tool_execution_end") {
			// 构造扩展工具完成事件。
			const extensionEvent: ToolExecutionEndEvent = {
				// 工具执行完成的事件名。
				type: "tool_execution_end",
				// 该结果对应的调用 id。
				toolCallId: event.toolCallId,
				// 实际工具名。
				toolName: event.toolName,
				// 最终工具结果正文/详情等。
				result: event.result,
				// 工具是否失败，非通过文字猜测。
				isError: event.isError,
				// 执行耗时存在才附带；0 仍算存在，不用真值判断丢掉。
				...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
			};
			// 等待扩展处理；真正持久化仍由完整消息事件路径完成。
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	/**
	 * 登记公开事件监听器，返回只移除此监听器的取消函数；会话内部持久化订阅不受影响。
	 * 例：const off=session.subscribe(onEvent); off() 停止该观察者，其他 UI/RPC 观察者仍可接收。
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		// 加入订阅数组，不覆盖之前监听器。
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		// 闭包保留 listener，之后可单独取消它。
		return () => {
			// 按同一函数引用找订阅位置。
			const index = this._eventListeners.indexOf(listener);
			// 未找到说明已移除，无需误删别项。
			if (index !== -1) {
				// 只删除该位置的一项订阅。
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** Disconnect from agent events during disposal. */
	/**
	 * 若仍订阅低层 Agent，调用退订函数并清引用，返回 void。
	 * 例：dispose 后不再由该会话处理旧 Agent 事件；重复调用在没有引用时无动作。
	 */
	private _disconnectFromAgent(): void {
		// 只有还保留退订函数时执行。
		if (this._unsubscribeAgent) {
			// 向 Agent 撤销本会话内部事件订阅。
			this._unsubscribeAgent();
			// 清引用，重复清理不再调用旧函数。
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	/**
	 * 释放该会话的事件订阅、缓存保温和供应商会话资源，并请求取消正在进行的操作。
	 * 返回 void，不等待所有异步操作完成；取消阶段异常被吞掉以继续后续清理，扩展上下文被标记失效。
	 * 例：切换会话后旧扩展 ctx 不能继续当新会话使用；这里不删除历史文件。
	 */
	dispose(): void {
		// 取消动作集中 try，避免其中某个抛错阻断后面的资源回收阶段。
		try {
			// 取消普通重试的等待。
			this.abortRetry();
			// 请求停止手动/自动压缩。
			this.abortCompaction();
			// 请求停止分支摘要。
			this.abortBranchSummary();
			// 请求停止所有独立手动 bash。
			this.abortBash();
			// 请求低层模型/工具循环停止。
			this.agent.abort();
			// 取消阶段抛异常也进入后面的解绑，不重新抛该取消异常。
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		// 使旧扩展上下文失效，后续调用可由 runner 检查并拒绝。
		this._extensionRunner.invalidate(
			// 失效指导文案说明替换会话/重载后如何改用新 ctx，不嵌入 token 或消息正文。
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		// 撤销低层事件订阅，避免旧会话继续保存后来的消息。
		this._disconnectFromAgent();
		// 释放所有公开监听引用。
		this._eventListeners = [];
		// 配置了保温器才撤销通知并取消保温。
		if (this._cacheWarmer) {
			// 取消旧会话的保温完成通知，避免后续发过时条目事件。
			this._cacheWarmer.onWarmed = undefined;
			// 请求保温器停止当前工作。
			this._cacheWarmer.cancel();
		}
		// 按 sessionId 清供应商保存的会话专属资源；不删除会话 JSONL。
		cleanupSessionResources(this.sessionId);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Refresh the public finalized transcript from the canonical session projection. */
	/**
	 * 从会话投影刷新公开的已完成消息，返回 void；会重设 Agent.messages。例：扩展追加上下文编辑后，调用它同步读取结果。
	 */
	refreshContext(): void {
		// 委托同一刷新方法，让公开 Agent 历史与会话投影一致。
		this._refreshFinalizedContext();
	}

	/** Full agent state */
	/**
	 * 读取低层 Agent 的完整状态原引用，没有复制或只读冻结。例：session.state.messages 与 Agent 当前消息数组相同。
	 */
	get state(): AgentState {
		// 直接返回可变状态对象，getter 不等于整个对象只读。
		return this.agent.state;
	}

	/** Current cache-warming state and the policy inputs that produced it. */
	/**
	 * 读取缓存保温器当前状态，未配置保温器时返回 undefined；没有新建保温任务。例：UI 用状态显示保温策略。
	 */
	get cacheWarmingStatus(): CacheWarmingStatus | undefined {
		// 未配置保温器时可选链返回 undefined。
		return this._cacheWarmer?.status;
	}

	/** Persist the cache-warming mode and immediately reconcile active warming. */
	/**
	 * 保存保温模式并让已有保温器立即重新协调，返回 void。例：改为关闭后通知 warmer 重新处理当前任务；实际调度规则在 warmer。
	 */
	setCacheWarmingMode(mode: CacheWarmingMode): void {
		// 通过设置管理器保存新模式。
		this.settingsManager.setCacheWarmingMode(mode);
		// 已有保温器按新设置立即重新协调，不存在则跳过。
		this._cacheWarmer?.onModeChanged();
	}

	/** Current model (may be undefined if not yet selected) */
	/**
	 * 读取当前模型选择；可能为物理模型、虚拟模型或 undefined，无认证/网络操作。例：未选模型的会话可读取 undefined。
	 */
	get model(): Model<any> | undefined {
		// 读取 Agent 当前模型引用，不在此访问模型网络。
		return this.agent.state.model;
	}

	/** Current thinking level */
	/**
	 * 读取 Agent 当前思考级别，返回 ThinkingLevel 字符串；不重新推导默认值。例：setThinkingLevel 后此处反映有效级别。
	 */
	get thinkingLevel(): ThinkingLevel {
		// 读取当前已经应用能力限制后的级别。
		return this.agent.state.thinkingLevel;
	}

	/** Under a virtual selection, the physical model and thinking level of the latest successful response. */
	/**
	 * 虚拟选择下，返回最近非 error/aborted 回复的物理模型及回复记录的思考级别；否则 undefined。
	 * 倒查消息再查模型目录，无网络。例：router 先用 A 后用 B，最近成功的是 B 就返回 B；目录已无 B 时不能返回它。
	 */
	get routedModel(): { model: Model<any>; thinkingLevel?: ThinkingLevel } | undefined {
		// 只为虚拟模型提供物理路由摘要；普通模型读取 model 即可。
		if (!this.model || !isVirtualModel(this.model)) return undefined;
		// 跳过 error/aborted，从有效消息里找最近一次回复。
		const latest = findLatestResponse(this.agent.state.messages);
		// 有回复才按它记载的供应商/id 查物理目录项。
		const model = latest && this._modelRuntime.getPhysicalModel(latest.provider, latest.model);
		// 物理模型存在才返回对象；thinkingLevel 可缺省，保留回复所记的值。
		return model && { model, thinkingLevel: latest?.thinkingLevel };
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	/**
	 * 读取会话运行忙碌标记，包含启动准备、低层运行、重试/续跑和收尾过程。例：before_agent_start 尚未发请求时也可为 true。
	 */
	get isStreaming(): boolean {
		// 读取整个运行标记，不直接读 Agent.isStreaming。
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, compaction, branch summary, retry, or queued continuation. */
	/**
	 * 按本类条件判断空闲：没有活动运行，也没有压缩或分支摘要。返回 boolean，不等待。
	 * 例：独立手动 bash 不参与这两个条件，isIdle 不能代替 isBashRunning；排队文字本身也不直接参与此表达式。
	 */
	get isIdle(): boolean {
		// 这里的空闲只由运行标记与三个摘要/压缩控制器决定。
		return !this._isAgentRunActive && !this.isCompacting;
	}

	/** Current effective system prompt, including changes not yet sent to the model. */
	/**
	 * 把本次运行选项或基础选项渲染成当前有效 system 提示词字符串，无写入。例：扩展临时改规则后，本次运行期间读取运行选项。
	 */
	get systemPrompt(): string {
		// ?? 优先本次临时规则，其次基础规则；每次读取都会渲染字符串。
		return buildSystemPrompt(this._runSystemPromptOptions ?? this._baseSystemPromptOptions);
	}

	/** Current retry attempt (0 if not retrying) */
	/**
	 * 读取普通回答的重试计数；0 表示当前没有累计的重试尝试，无副作用。例：第一轮退避前为 1。
	 */
	get retryAttempt(): number {
		// 直接读取普通回答重试次数。
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools, which are the tools declared to the model.
	 * Tools with `codemode` or `deferred` exposure are callable from other tools without being active.
	 */
	/**
	 * 返回当前 Agent.tools 中的工具名新数组；不包含所有已注册但未激活的工具。
	 * 例：已注册 deferred 工具仍可供 codemode 调用，但未必在这里出现；prepareLoadout 还可能隐藏部分请求声明。
	 */
	getActiveToolNames(): string[] {
		// map 提取名称产生新数组，工具对象本身没有复制。
		return this.agent.state.tools.map((t) => t.name);
	}

	/** Get the names of the tools that tools can call through `ctx.executeTool()`. */
	/**
	 * 返回 ctx.executeTool 可调用工具的名字新数组，按暴露级别和激活集合筛选。例：deferred 工具可以未激活却仍可被另一工具调用。
	 */
	getCallableToolNames(): string[] {
		// 先按 callable 规则筛选，再提取名字。
		return this._getCallableTools().map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	/**
	 * 把全部已纳入会话注册表的定义转换为 ToolInfo 数组，附 schema、规则、暴露级别和来源。
	 * 返回新信息对象，部分内部字段仍共享；annotations 做浅复制。例：UI 列工具时可区分 builtin 与 extension 来源，不执行工具。
	 */
	getAllTools(): ToolInfo[] {
		// 把定义表迭代器转数组，再解构每个定义和来源；({}) 表示箭头直接返回对象。
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			// 保留定义的稳定工具名。
			name: definition.name,
			// 此处是原始定义描述，prepareLoadout 临时描述变化保存在 Agent.tools。
			description: definition.description,
			// 提供参数 schema 引用，不实际验证参数。
			parameters: definition.parameters,
			// 附工具声明的提示词规则。
			promptGuidelines: definition.promptGuidelines,
			// 读取缺省 direct 等暴露策略。
			exposure: this._getToolExposure(definition.name),
			// 声明 namespace 时才附字段，不在此创建实际命名空间对象。
			...(definition.namespace ? { namespace: definition.namespace } : {}),
			// annotations 做浅复制，避免信息对象直接共享顶层注解对象。
			...(definition.annotations ? { annotations: { ...definition.annotations } } : {}),
			// reachesTools 说明工具可触达的其他工具信息，存在才附上。
			...(definition.reachesTools ? { reachesTools: definition.reachesTools } : {}),
			// 附定义来源供展示/错误定位。
			sourceInfo,
		}));
	}

	/**
	 * 按名称查原始工具定义，返回定义引用或 undefined，无加载或执行。例：getToolDefinition("read") 可供自定义 HTML 渲染器读取 schema。
	 */
	getToolDefinition(name: string): ToolDefinition | undefined {
		// Map.get 查不到为 undefined，?.definition 安全取可选字段。
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown and hidden tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	/**
	 * 按名字更新激活集合并重建提示词选项；返回 void，未注册/hidden/不准激活的名字被忽略。
	 * 若原激活工具有被关闭，清除待恢复工具；纯新增则保留待注册项。例：只新增 tool_search 不丢掉仍在连接的 MCP 工具。
	 */
	setActiveToolsByName(toolNames: string[]): void {
		// 记录更新前的激活集合，后面判断是否有关闭项。
		const previous = this.getActiveToolNames();
		// 应用实际可激活集合，并重建基础提示词选项。
		this._setActiveTools(toolNames);
		// A loadout that deactivates a tool replaces the restored one, whose pending tools are dropped.
		// One that only adds tools, like activating tool_search, keeps them.
		// Set 方便按名判断旧工具是否仍然启用。
		const active = new Set(this.getActiveToolNames());
		// 任一旧工具被关闭即放弃旧 loadout 的待注册项；只有新增时不清。
		if (previous.some((name) => !active.has(name))) this._pendingToolNames.clear();
	}

	/**
	 * 内部应用工具集合、移除已成功激活的 pending 名称并重建基础提示词，返回 void。
	 * 例：MCP 工具刚注册后传入它的名字，即从待恢复集合转入当前工具集合。
	 */
	private _setActiveTools(toolNames: string[]): void {
		// 底层筛选/钩子处理后得到实际工具，不等同于请求的全部名字。
		const tools = this._applyToolLoadout(toolNames);
		// 已成功激活项不再需要 pending 恢复等待。
		for (const tool of tools) this._pendingToolNames.delete(tool.name);
		// 按最终工具名重建基础 system 选项，后续请求再生成变化消息。
		this._rebuildSystemPrompt(tools.map((tool) => tool.name));
	}

	/**
	 * Whether `--tools` and `--exclude-tools` keep the tool registered. MCP tools stay registered
	 * unless the allowlist filters them (see `_allowlistFiltersMcp`).
	 */
	/**
	 * 判断工具是否保留注册资格，先检查排除列表，再允许列表，最后处理 MCP 特例。
	 * 返回 boolean 无写入。例：允许列表只有 read 时，MCP 工具仍可保留供 codemode/search，但显式排除匹配者不保留。
	 */
	private _isAllowedTool(name: string): boolean {
		// 排除规则命中优先拒绝，即使允许规则也匹配。
		if (this._excludedTools?.(name)) return false;
		// 没有允许列表或显式匹配，保留工具。
		if (!this._allowedTools || this._allowedTools(name)) return true;
		// 仅在允许列表不专管 MCP 时，保留未点名 MCP 供间接调用/搜索。
		return !this._allowlistFiltersMcp && isMcpToolName(name);
	}

	/**
	 * Whether the tool may be active, which declares it to the model. MCP tools the allowlist keeps
	 * without matching them are only for codemode and tool_search: they may be declared only when
	 * tool_search can load them (non-`direct` exposure and tool_search registered). This also applies
	 * to tools restored from the transcript or set by extensions.
	 */
	/**
	 * 判断已注册工具能否被激活并进入 Agent.tools，返回 boolean。
	 * 未被允许列表直接点名的 MCP 工具，只有非 direct 且已注册 tool_search 才放行；例：注册保留不等于可直接声明。
	 */
	private _isActivatable(name: string): boolean {
		// 没有允许列表、已点名或非 MCP，不需要这条 MCP 特殊限制。
		if (!this._allowedTools || this._allowedTools(name) || !isMcpToolName(name)) return true;
		// 未点名 MCP 要能由 tool_search 按需加载，direct 不行，且 tool_search 必须已注册。
		return this._getToolExposure(name) !== "direct" && this._toolRegistry.has("tool_search");
	}

	/**
	 * 查工具定义的 exposure，未提供或没查到时用 direct；返回字符串，无运行时工具执行。例：旧式普通工具默认按 direct 处理。
	 */
	private _getToolExposure(name: string): ToolExposure {
		// 可选链加 ?? 给缺省 direct，不因未写 exposure 就隐藏工具。
		return this._toolDefinitions.get(name)?.definition.exposure ?? "direct";
	}

	/**
	 * Tools callable through `ctx.executeTool()`: the active `direct` tools and every registered
	 * `codemode` or `deferred` tool.
	 */
	/**
	 * 筛选供 ctx.executeTool 调用的工具，默认采用当前激活名称集合。
	 * codemode/deferred 无需激活，direct 必须激活，model-only/hidden 不进入此结果。例：模型可见的 model-only 工具不能由另一个工具直接调用。
	 */
	private _getCallableTools(active: ReadonlySet<string> = new Set(this.getActiveToolNames())): AgentTool[] {
		// 展开 Map 的实现值并筛选成新数组，默认参数在调用时创建当前激活 Set。
		return [...this._toolRegistry.values()].filter((tool) => {
			// 每个工具按定义读取暴露策略。
			const exposure = this._getToolExposure(tool.name);
			// codemode/deferred 无需当前激活；direct 必须在 active；其他暴露级别不被工具调用。
			return exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active.has(tool.name));
		});
	}

	/**
	 * Set the agent's tools for the given active tool names and return them. The active tools are
	 * the registered, non-hidden ones; they are declared to the model. Active tools with a
	 * `prepareLoadout` hook can change the declared descriptions and hide declarations from
	 * requests (see {@link _installHiddenDeclarationsProjection}).
	 *
	 * The active tools are a set: tools that stay active keep their current order and newly active
	 * ones are appended, so reordering the same names does not change the prompt (#11495).
	 */
	/**
	 * 构建激活工具集合并运行 prepareLoadout 钩子，返回最终 Agent.tools 数组。
	 * 保留原有顺序，新增放末尾；过滤不可激活项；钩子可改声明描述和隐藏声明，错误报告后继续；最后保存隐藏集合与工具状态。
	 * 例：[read,bash] 再请求 [bash,read] 保持既有顺序，减少提示词无意义变化；这里不执行工具业务。
	 */
	private _applyToolLoadout(toolNames: string[]): AgentTool[] {
		// Set 去掉重复请求名，同时保留首次出现顺序。
		const requested = new Set(toolNames);
		// 先筛出仍请求保留的旧激活项，防止纯重新排序改变提示词。
		const kept = this.getActiveToolNames().filter((name) => requested.has(name));
		// 旧保留项在前，其余请求项后加，再按注册/暴露/激活限制筛选。
		const tools = [...new Set([...kept, ...requested])].flatMap((name) => {
			// 只从当前已注册实现中取工具，未知名字拿不到对象。
			const tool = this._toolRegistry.get(name);
			// hidden 不进 Agent.tools；_isActivatable 另限制未点名 MCP；失败产空数组。
			return tool && this._getToolExposure(name) !== "hidden" && this._isActivatable(name) ? [tool] : [];
		});
		// 仅从实际激活工具收集 prepareLoadout 钩子。
		const hooks = tools.flatMap((tool) => {
			// 按工具名取得原始定义及来源。
			const entry = this._toolDefinitions.get(tool.name);
			// 定义有钩子才加入，flatMap 的空数组表示跳过。
			return entry?.definition.prepareLoadout ? [entry] : [];
		});
		// 本次重算隐藏声明集合，不沿用旧 loadout 的隐藏项。
		const hidden = new Set<string>();
		// 没有描述改写时可复用 tools 数组。
		let declared = tools;
		// 无钩子不建立 loadout 辅助对象。
		if (hooks.length > 0) {
			// 给钩子的上下文区分“模型声明”“工具可调用”“全部已注册”。
			const loadout: ToolLoadout = {
				// 当前准备声明的激活工具。
				declared: tools,
				// 按本次候选激活 Set 计算 callable，而不是读尚未更新的 Agent 状态。
				callable: this._getCallableTools(new Set(tools.map((tool) => tool.name))),
				// 全部已注册实现可供钩子参考，不等于全部可执行。
				registered: [...this._toolRegistry.values()],
				// 提供按名读暴露级别的回调。
				getExposure: (name) => this._getToolExposure(name),
				// 提供原定义的可选命名空间信息。
				getNamespace: (name) => this._toolDefinitions.get(name)?.definition.namespace,
				// 提供规范化规则，未找到返回空列表。
				getPromptGuidelines: (name) => this._toolPromptGuidelines.get(name) ?? [],
			};
			// 收集钩子返回的描述改写，同名后处理者覆盖前者。
			const descriptions = new Map<string, string>();
			// 按候选工具顺序执行各自的同步准备钩子。
			for (const { definition, sourceInfo } of hooks) {
				// 单个钩子失败报告后继续，不毁掉整个工具装载。
				try {
					// 可选调用沿用定义类型；钩子同步返回改写数据。
					const changes = definition.prepareLoadout?.(loadout);
					// 未提供 descriptions 时遍历空对象；解构取得工具名与描述。
					for (const [name, description] of Object.entries(changes?.descriptions ?? {})) {
						// 记录本次新描述。
						descriptions.set(name, description);
					}
					// 隐藏名去重，后面投影过滤所有对应声明。
					for (const name of changes?.hiddenDeclarations ?? []) hidden.add(name);
					// 捕获的是扩展钩子失败，不是工具执行业务失败。
				} catch (error) {
					// 走扩展错误通道通知宿主。
					this._extensionRunner.emitError({
						// 错误归属于该工具定义来源。
						extensionPath: sourceInfo.path,
						// 标记 prepare_loadout 阶段。
						event: "prepare_loadout",
						// Error 用 message，其他抛出值转文字。
						error: error instanceof Error ? error.message : String(error),
						// 只有 Error 才附 stack。
						stack: error instanceof Error ? error.stack : undefined,
					});
				}
			}
			// 把描述改写应用到最终声明对象，保持工具次序。
			declared = tools.map((tool) => {
				// 查该工具是否被钩子给了新描述。
				const description = descriptions.get(tool.name);
				// undefined 才复用原对象，空字符串也是明确的新描述。
				return description === undefined ? tool : { ...tool, description };
			});
		}
		// 保存本次隐藏集合，下一请求 transformContext 使用它。
		this._hiddenDeclarations = hidden;
		// 更新低层可执行工具集合，隐藏声明投影另在请求边界处理。
		this.agent.state.tools = declared;
		// 返回最终工具供调用者重建提示词/读取名字。
		return declared;
	}

	/** Whether compaction or branch summarization is currently running */
	/**
	 * 任一手动压缩、自动压缩、分支摘要控制器存在时返回 true。例：navigateTree 尚在扩展准备阶段也因分支控制器存在而占用该状态。
	 */
	get isCompacting(): boolean {
		// 组合三个状态控制器，只要任一个存在就忙。
		return (
			// 自动压缩正在占用状态。
			this._autoCompactionAbortController !== undefined ||
			// 手动压缩正在占用状态。
			this._compactionAbortController !== undefined ||
			// 分支摘要/导航正在占用状态。
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	/**
	 * 返回 Agent 当前有效消息数组原引用，含应用层自定义类型；不会加载原始全历史。例：压缩前历史仍在会话文件里，但不全在 messages。
	 */
	get messages(): AgentMessage[] {
		// 返回已完成的有效消息原数组，不做 clone。
		return this.agent.state.messages;
	}

	/** Current steering mode */
	/**
	 * 读取低层插话队列每次投递策略，返回 all 或 one-at-a-time，无副作用。例：all 表示一次取该队列的全部等待项。
	 */
	get steeringMode(): "all" | "one-at-a-time" {
		// 直接读取 Agent 的插话投递策略。
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	/**
	 * 读取低层追问队列投递策略，无副作用。例：one-at-a-time 每次取一项，不代表立刻取消当前输出。
	 */
	get followUpMode(): "all" | "one-at-a-time" {
		// 直接读取 Agent 的追问投递策略。
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	/**
	 * 读取会话保存路径，内存/禁用保存时可为 undefined；不创建文件。例：导出界面可据此显示当前文件位置。
	 */
	get sessionFile(): string | undefined {
		// 通过会话管理器读取可选文件路径。
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	/**
	 * 读取 SessionManager 的当前会话 id，返回字符串，无额外磁盘读取。例：资源清理按这个 id 标识会话。
	 */
	get sessionId(): string {
		// 通过会话管理器读取当前 id。
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	/**
	 * 读取当前会话显示名，未设置时 undefined；与 id/文件路径不同。例：setSessionName("修复登录") 后显示该名称。
	 */
	get sessionName(): string | undefined {
		// 读取会话层最终显示名。
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	/**
	 * 取得循环切换用的模型范围原数组，在类型层面只读；运行时没有冻结。例：--models 解析后的子集用于 Ctrl+P。
	 */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		// 返回存下的数组，ReadonlyArray 只限制类型使用者的修改 API。
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	/**
	 * 替换内存中的循环模型范围，返回 void，不写设置或切换当前模型。例：传 [] 后 cycleModel 改用全部可用模型快照。
	 */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		// 替换循环范围引用，不自动去重或持久化。
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	/**
	 * 读取资源加载器当前提示词模板数组，类型为 ReadonlyArray；不重新扫描文件。例：prompt 展开 /review 时读取这个列表。
	 */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		// 资源加载器返回当前模板结果，这里只取 prompts 字段。
		return this._resourceLoader.getPrompts().prompts;
	}

	/**
	 * 清理一条工具提示词摘要为单行，空白结果返回 undefined，无 I/O。
	 * 例：" a\n  b " 变 "a b"；先合并换行，再折叠空白并 trim。
	 */
	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		// undefined 和空字符串均视为无摘要，不再做字符串清理。
		if (!text) return undefined;
		// 保留清理链结果；原字符串不可变，不会原地修改输入。
		const oneLine = text
			// 用正则把连续换行统一为空格。
			.replace(/[\r\n]+/g, " ")
			// 把所有连续空白折成一个空格。
			.replace(/\s+/g, " ")
			// 去掉首尾空白。
			.trim();
		// 清理后全为空白就返回 undefined，避免列空摘要。
		return oneLine.length > 0 ? oneLine : undefined;
	}

	/**
	 * 清理工具规则列表：去首尾空白、忽略空行并按首次出现顺序去重，返回新数组。
	 * 例：[" a ","a",""] 得 ["a"]；不会合并规则内部的空格。
	 */
	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		// 未提供规则或空列表时返回新空数组。
		if (!guidelines || guidelines.length === 0) {
			// 调用者可直接使用结果，不必判断 undefined。
			return [];
		}

		// Set 按首次插入顺序去重完整规则字符串。
		const unique = new Set<string>();
		// 依序清理每条规则。
		for (const guideline of guidelines) {
			// 只去规则两端空白，保留中间语句格式。
			const normalized = guideline.trim();
			// 空白规则不占提示词位置。
			if (normalized.length > 0) {
				// 相同规范化规则只存一次。
				unique.add(normalized);
			}
		}
		// 将去重后的迭代器转为普通数组。
		return Array.from(unique);
	}

	/**
	 * 根据工具、资源、技能和上下文文件重建基础 system 选项，返回 void。
	 * 仅保留已注册的选中名，收集工具摘要/规则，再规范化保存；不直接追加 system 消息。例：启用 read 后下一次准备请求才按差异生成声明/章节。
	 */
	private _rebuildSystemPrompt(toolNames: string[]): void {
		// 仅把已经注册的选中名写进提示词选项。
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		// 对象以工具名索引一行摘要，交后面的构建器使用。
		const toolSnippets: Record<string, string> = {};
		// 遍历全部注册工具的名字，包括未激活的，构建器再按选中工具取内容。
		for (const name of this._toolRegistry.keys()) {
			// 读取该工具规范化过的一行摘要。
			const snippet = this._toolPromptSnippets.get(name);
			// Tools without a snippet are not listed.
			// 没有摘要不列在对象里，不创造默认说明。
			if (snippet) toolSnippets[name] = snippet;
		}

		// 读取自定义基础 system 正文，未配置可 undefined。
		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		// 读取追加 system 的多段文字/文件内容。
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		// 多段附加规则用空行连接，没有则空字符串。
		const appendSystemPrompt = loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : "";
		// 当前已加载技能数据，不在这里重读 SKILL.md。
		const loadedSkills = this._resourceLoader.getSkills().skills;
		// 当前已加载 AGENTS.md/CLAUDE.md 等上下文文件数据。
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		// 规范化并保存基础提示词结构，尚未追加到会话历史。
		this._baseSystemPromptOptions = normalizeBuildSystemPromptOptions({
			// 让提示词构建器知道本会话工作目录。
			cwd: this._cwd,
			// 技能列表用于提示词技能发现说明。
			skills: loadedSkills,
			// 项目上下文文件正文与来源。
			contextFiles: loadedContextFiles,
			// 自定义基础 system 可替代默认正文规则。
			customPrompt: loaderSystemPrompt,
			// 附加 system 文本保留在独立选项。
			appendSystemPrompt,
			// 选中并已注册的工具名。
			selectedTools: validToolNames,
			// 隐藏声明工具在系统工具说明中也需一致处理。
			hiddenTools: [...this._hiddenDeclarations],
			// 工具的一行摘要集合。
			toolSnippets,
			// Map 转普通对象，以工具名索引规则数组。
			toolGuidelines: Object.fromEntries(this._toolPromptGuidelines),
		});
	}

	/**
	 * Apply a prompt and tool loadout for the next request. Sets the executable tools and
	 * returns a system message patching the prompt sections the model currently has (replayed
	 * from `messages`), or undefined when the prompt is unchanged. Tool changes are declared by
	 * the agent loop before the request.
	 *
	 * A forced prompt does not affect the transcript: the structured sections are still diffed
	 * and persisted, and the forced text is projected onto the request by
	 * {@link _installAgentForcedPromptProjection}.
	 */
	/**
	 * 应用下一请求的工具集合并计算 system 章节差异，返回补丁消息或 undefined。
	 * 会修改传入 options.selectedTools/hiddenTools 和 Agent 工具；从 messages 重放当前章节，与新章节比较。例：规则不变返回 undefined，变化时生成时间戳为当前时间的 system 补丁。
	 */
	private _preparePromptAndToolLoadout(
		// 传入将用于下一请求的规范化选项，本函数会更新其中工具字段。
		options: NormalizedBuildSystemPromptOptions,
		// 未传 messages 就对照当前 Agent 历史，调用时才计算默认值。
		messages: AgentMessage[] = this.agent.state.messages,
		// 返回可选 system 章节补丁，不是完整模型响应。
	): SystemMessage | undefined {
		// 先应用工具装载及钩子，更新选项中实际可激活名字。
		options.selectedTools = this._applyToolLoadout(options.selectedTools).map((tool) => tool.name);
		// The tool list and rules must match the declarations the request carries.
		// 同步此次钩子隐藏声明集合，保证提示词规则与声明一致。
		options.hiddenTools = [...this._hiddenDeclarations];
		// 按章节比较旧规则和新规则，删除/新增/变更都用补丁表达。
		const sections = diffSystemPromptSections(
			// 从所有 system 消息重放旧章节，没有则用空对象。
			getCurrentSystemMessage(messages)?.sections ?? {},
			// 基于新选项生成新章节内容。
			buildSystemPromptSections(options),
		);
		// 有差异才生成 system，正文为空由 sections 承载增量；没差异返回 undefined。
		return sections ? { role: "system", content: "", sections, timestamp: Date.now() } : undefined;
	}

	/**
	 * Send a forced prompt as the provider's leading system prompt without recording it.
	 *
	 * A `before_agent_start` handler that returns `systemPrompt` needs that exact text at the
	 * head of the request; a mid-conversation system message would leave the original prompt
	 * in place. The forced text is a rendering of the current prompt, so the transcript keeps
	 * its structured sections and the request is projected instead: the system messages
	 * collapse into one head holding the forced text and the current tools. Runs after the
	 * `context` extension handlers.
	 */
	/**
	 * Remove the declarations that `prepareLoadout` hooks hide from every request. The whole
	 * transcript is filtered with the current set, so the projected declarations stay consistent
	 * across requests and only change when the loadout does.
	 */
	/**
	 * 包装 transformContext，在每次请求投影中隐藏 prepareLoadout 指定的工具声明。
	 * 先运行原转换，再过滤所有 system 消息的 toolsAdded/toolsRemoved；不改原会话消息。例：codemode 内可调用的工具可以留在本地注册表，但不逐个出现在请求声明中。
	 */
	private _installHiddenDeclarationsProjection(): void {
		// 保存现有 transformContext，避免覆盖扩展上下文处理。
		const previousTransformContext = this.agent.transformContext;
		// 安装实际请求时才运行的异步消息转换。
		this.agent.transformContext = async (messages, signal) => {
			// 先等原转换（如 context 扩展），没有则用传入消息数组。
			const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
			// 每次运行读取当前隐藏集合，工具 reload 后无需重新安装。
			const hidden = this._hiddenDeclarations;
			// 隐藏集合为空直接复用已转换结果。
			if (hidden.size === 0) return transformed;
			// 逐消息投影，只改包含工具增删的 system 消息。
			return transformed.map((message) => {
				// 其他消息保持原引用；无工具增删的 system 也无需重建。
				if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved)) return message;
				// 对象剩余语法把原工具变更字段拿掉，rest 保留其他字段。
				const { toolsAdded, toolsRemoved, ...rest } = message;
				// 从新增声明中排除隐藏工具，缺列表当空数组。
				const added = toolsAdded?.filter((tool) => !hidden.has(tool.name)) ?? [];
				// 从删除声明中同样排除，保证请求投影自洽。
				const removed = toolsRemoved?.filter((tool) => !hidden.has(tool.name)) ?? [];
				// 构造新 system 对象，不修改会话原对象。
				return {
					// 保留规则正文/章节/时间等字段。
					...rest,
					// 过滤后还有新增项才带 toolsAdded 字段。
					...(added.length > 0 ? { toolsAdded: added } : {}),
					// 过滤后还有删除项才带 toolsRemoved 字段。
					...(removed.length > 0 ? { toolsRemoved: removed } : {}),
				};
			});
		};
	}

	/**
	 * 包装 transformContext，将本次强制 system 文本投影为唯一首条 system，返回 void。
	 * 实际回调先跑已有转换，再重放工具，将原所有 system 移去；没有 forceSystemPrompt 时原样返回。
	 * 例：before_agent_start 返回完整提示词时，模型首部使用这段精确正文，而会话树仍保存结构化章节。
	 */
	private _installAgentForcedPromptProjection(): void {
		// 把隐藏声明投影等之前安装的上下文转换保留下来。
		const previousTransformContext = this.agent.transformContext;
		// 实际模型请求前异步执行该包装回调。
		this.agent.transformContext = async (messages, signal) => {
			// 先运行之前转换，强制文本投影在它们之后。
			const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
			// 只有本次 before_agent_start 设置过强制文本才生效。
			const forced = this._runSystemPromptOptions?.forceSystemPrompt;
			// undefined 表示没覆盖；空字符串仍属于明确覆盖。
			if (forced === undefined) return transformed;
			// 重放转换后的所有 system，得到最终工具声明和首时间。
			const current = getCurrentSystemMessage(transformed);
			// 构造唯一头部 system，替代请求中的结构化历史规则。
			const head: SystemMessage = {
				// 固定 system 角色，不伪装成 user。
				role: "system",
				// 强制文本原样作正文，不再自动拼结构化章节。
				content: forced,
				// 沿用重放得到的当前完整工具声明，隐藏投影已经提前执行。
				...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
				// 优先保留 system 基线时间，没有才用现在。
				timestamp: current?.timestamp ?? Date.now(),
			};
			// 新头部在前，后面保留所有非 system 的消息原顺序；只改变请求投影。
			return [head, ...transformed.filter((message) => message.role !== "system")];
		};
	}

	/**
	 * Restore the active tool loadout declared by the session transcript, if it declares one.
	 * Tools reachable only from other tools are never declared, but they do not depend on the active
	 * set, so the transcript's declarations are the whole loadout.
	 * @param modifiers `+name`/`-name` entries applied to the restored loadout.
	 */
	/**
	 * 从当前分支的全部 system 增删记录恢复工具集合，并应用 +name/-name 修饰项。
	 * 没有 system 历史则保留现有工具；新出现的可默认激活扩展工具补入，未注册但允许的名字先 pending。
	 * 例：恢复会话时 MCP 尚未连上，先保留工具名，连接完成注册后再激活；不会把历史明确移除的工具自动加回。
	 */
	private _restoreToolsFromTranscript(modifiers: readonly string[] = []): void {
		// 恢复开始清旧 pending，后面基于本分支重新算。
		this._pendingToolNames.clear();
		// All system messages on the branch, including those before a compaction. Compaction snapshots
		// are derived from these, so replaying them gives the current loadout.
		// 读取本分支原始 system 条目，包含压缩前的工具变更记录。
		const systemMessages = this.sessionManager
			// getBranch 得根到叶的因果顺序。
			.getBranch()
			// 只有 type=message 且 role=system 才贡献工具增删；flatMap 其余产零项。
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "system" ? [entry.message] : []));
		// No recorded loadout: keep the current tools.
		// 没有任何 system 声明就不以空集合误关当前工具。
		if (systemMessages.length === 0) return;
		// Tools the branch ever added or removed. Removed tools stay inactive.
		// 收集分支曾提及的全部名字，区分明确移除与后来新注册。
		const mentioned = new Set(
			// 从每条 system 合并 toolsAdded/toolsRemoved 名称。
			systemMessages
				// 先转所有增删定义到一个平面列表。
				.flatMap((message) => [...(message.toolsAdded ?? []), ...(message.toolsRemoved ?? [])])
				// 只保留名字用于成员判断。
				.map((tool) => tool.name),
		);
		// Extension tools the branch never mentioned were registered after it recorded its loadout, so
		// they are activated like newly registered tools. Built-in tools follow `defaultTools` instead.
		// 注册表中新扩展工具按默认注册激活策略补入。
		const newTools = [...this._toolRegistry.keys()].filter(
			// 筛选每一个当前注册名称。
			(name) =>
				// 历史未提及、不是基础工具、且默认激活才算新增扩展工具。
				!mentioned.has(name) && !this._baseToolDefinitions.has(name) && this._isActivatedOnRegistration(name),
		);
		// The recorded loadout plus the new tools, with `--tools +name`/`-name` applied.
		// 对历史有效声明和新扩展工具应用用户的 +name/-name。
		const names = applyToolModifiers(
			// getCurrentTools 重放全部增删，已经删除的名字不会被恢复。
			[...getCurrentTools(systemMessages).map((tool) => tool.name), ...newTools],
			// 保留调用方提供的修饰规则，默认空数组。
			modifiers,
		);
		// Recorded tools that are not registered yet, such as MCP tools of servers still connecting, are
		// activated when they register. Excluded tools never register, so they are not kept pending.
		// 允许但尚未注册的名也记入 pending，排除项不留等待。
		this._pendingToolNames = new Set(names.filter((name) => this._isAllowedTool(name)));
		// Ignores names that are not registered.
		// 真正激活时仍过滤未注册/hidden 等，已成功激活名从 pending 删除。
		this._setActiveTools(names);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * Start a run from a user or custom message. The session counts as busy from here on, so
	 * messages sent while before_agent_start handlers run are queued into this run instead of
	 * starting another, and an abort requested meanwhile aborts the run as soon as it exists.
	 * @param onStarted Called once the run's messages are prepared, before the first request.
	 */
	// 会话运行入口。它比低层 Agent 循环更外层，还负责准备、重试、压缩和最终收尾。
	/**
	 * 从用户或 custom 触发启动完整会话运行，返回 Promise<void>，在本次全部续跑与收尾后完成。
	 * 先准备消息并标忙，通知 onStarted，然后低层 prompt；结束后协调重试/压缩/扩展继续，finally 清理并发布 settled。
	 * 例：一次 query 内先 read 再回答，期间错误退避也属于同一次忙碌生命周期；不返回回答文本，回答由事件/状态读取。
	 */
	private async _startRun(trigger: BeforeAgentStartTrigger, onStarted?: () => void): Promise<void> {
		// 先标记会话忙碌；before_agent_start 运行期间收到新输入也应排队，不能同时开第二个运行。
		this._isAgentRunActive = true;
		// 清掉上次取消标记，开始新的用户请求。
		this._agentRunAbortRequested = false;
		// 声明稍后准备的新消息数组；这里只声明类型，不会自动创建消息。
		let messages: AgentMessage[];
		// 准备阶段单独捕获失败，尚未进入低层 prompt 时也要清忙碌与通知等待者。
		try {
			// 准备用户消息、图片、扩展注入内容以及提示词补丁，必要时先做压缩。
			messages = await this._prepareRun(trigger);
		} catch (error) {
			// 准备失败时恢复会话空闲状态，避免永远卡在“处理中”。
			this._isAgentRunActive = false;
			// 把暂存的手动 bash 结果记入会话，放在不会拆散工具调用配对的位置。
			this._flushPendingBashMessages();
			// 把等待安全边界的自定义消息写进会话，避免夹在 toolCall 和对应 toolResult 中间。
			this._flushPendingCustomMessages();
			// 如果会话确实已经空闲，通知 waitForIdle 的等待者。
			this._resolveIdleWaitIfIdle();
			// 把错误继续交给调用方；这一步不会默默把失败当成功。
			throw error;
		}
		// Messages held while the run was starting go before its starting messages, as they would
		// have while idle. No run exists yet, so they cannot split a tool call from its result.
		// 把暂存的手动 bash 结果记入会话，放在不会拆散工具调用配对的位置。
		this._flushPendingBashMessages();
		// 把等待安全边界的自定义消息写进会话，避免夹在 toolCall 和对应 toolResult 中间。
		this._flushPendingCustomMessages();
		// 如果调用方提供了启动通知，现在回报“已开始”；?.() 表示函数存在才调用。
		onStarted?.();

		// Compaction before the prompt may have scheduled a retry; the new prompt replaces it.
		// 新问题替代旧的失败恢复目标，避免沿用上一运行的重试上下文。
		this._failedResponse = undefined;
		// 必要时把当前模型选择记进当前分支，确保恢复会话时知道选了哪个模型。
		this._recordSelection();
		// The run records the loadout in the transcript; restored tools that did not register by now
		// are dropped, so a tool that never registers does not stay pending.
		// 丢弃截至新运行仍未注册的待恢复工具，防止永远保留不存在的工具。
		this._pendingToolNames.clear();
		// 低层 prompt 与全部继续运行共享 finally，异常也要发布最终收尾状态。
		try {
			// 进入低层 Agent。它会完成“模型 → 工具 → 再问模型”的整个循环才返回。
			await this.agent.prompt(messages);
			// 低层运行结束后，会话还要检查重试、溢出恢复和扩展续跑；用户取消则停止。
			while (!this._agentRunAbortRequested) {
				// 检查最后回复：如果错误可重试、压缩后需恢复，或又有排队消息，则需要继续。
				if (await this._handlePostAgentRun()) {
					// 每个异步阶段后再看一次取消状态；break 退出当前 while。
					if (this._agentRunAbortRequested) break;
					// 根据现有上下文继续低层运行；不是把原用户问题再 append 一次。
					await this.agent.continue();
					// 这次继续运行结束后，重新检查是否还需要重试或处理新队列。
					continue;
				}
				// 若已取消，或收尾扩展也没要求继续，就退出会话运行。
				if (this._agentRunAbortRequested || !(await this._runBeforeSettleBoundary())) break;
				// 每个异步阶段后再看一次取消状态；break 退出当前 while。
				if (this._agentRunAbortRequested) break;
				// 根据现有上下文继续低层运行；不是把原用户问题再 append 一次。
				await this.agent.continue();
			}
			// 无论成功还是异常，都要做本次运行的清理并发布最终 settled 事件。
		} finally {
			// 如果取消发生在重试期间，补齐重试结束通知。
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			// 清空本次运行遗留的失败回复，下一次正常请求不再沿用它。
			this._failedResponse = undefined;
			// 释放本次运行的临时提示词覆盖，后面新 query 从基础配置重新准备。
			this._runSystemPromptOptions = undefined;
			// 把暂存的手动 bash 结果记入会话，放在不会拆散工具调用配对的位置。
			this._flushPendingBashMessages();
			// 把等待安全边界的自定义消息写进会话，避免夹在 toolCall 和对应 toolResult 中间。
			this._flushPendingCustomMessages();
			// 会话收尾完成的关键通知，比 agent_end 更适合判断整个 query 是否结束。
			await this._emitAgentSettled();
		}
	}

	/**
	 * Prepare a run and return its starting messages: compact first when needed, emit
	 * before_agent_start, apply the run's prompt options and tool loadout, and build the starting
	 * message followed by pending nextTurn messages (consumed here) and handler messages, with a
	 * system patch first when the prompt changed.
	 */
	// 将一次用户 query 变成开始运行所需的消息批次；这里还未发出普通回答请求。
	/**
	 * 准备本次起始消息批次，返回 AgentMessage[]，包括可选 system 补丁与用户/custom/扩展上下文。
	 * 先检查旧回复压缩，再执行 before_agent_start，协调实时工具、处理图片、消费 nextTurn 队列；不会在此执行普通回答循环。
	 * 例：一个问题附图加两条 nextTurn 消息，会按起始用户消息后跟两条上下文的顺序进入新批次。
	 */
	private async _prepareRun(trigger: BeforeAgentStartTrigger): Promise<AgentMessage[]> {
		// Check if we need to compact before sending (catches aborted responses).
		// The starting message is sent below, so do not call agent.continue() here.
		// 找到上一条模型回复，检查其用量/错误是否提示需要压缩。
		const lastAssistant = this._findLastAssistantMessage();
		// 会话有上一条回复才需要做这个发送前检查。
		if (lastAssistant) {
			// 包括上次被取消的回复也检查；可能先压缩，但不能在这里继续旧问题。
			await this._checkCompaction(lastAssistant, false);
		}

		// 保存扩展处理前的工具选择，后面判断扩展是否明确改了工具。
		const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools;
		// 运行 before_agent_start 扩展，允许注入上下文、改 system 规则、切换模型等。
		const result = await this._extensionRunner.emitBeforeAgentStart(trigger, this._baseSystemPromptOptions);
		// Handlers may edit event.systemPromptOptions.selectedTools or call setActiveTools(),
		// which updates the live loadout instead. An explicit edit wins; otherwise the live
		// loadout is authoritative, so a setActiveTools() call is not undone here.
		// 判断扩展有没有直接改 selectedTools；若没有，就尊重当前实时工具集合。
		const handlerEditedTools =
			// 工具数量不同，说明扩展改过列表。|| 表示任一条件为真就成立。
			result.systemPromptOptions.selectedTools.length !== selectedToolsBefore.length ||
			// 数量相同也可能换了工具或顺序，逐项比较确认。
			result.systemPromptOptions.selectedTools.some((name, index) => name !== selectedToolsBefore[index]);
		// 没明确改配置就以实时工具为准，避免撤销扩展通过 setActiveTools 做的变更。
		if (!handlerEditedTools) result.systemPromptOptions.selectedTools = this.getActiveToolNames();

		// 创建本次新消息列表；旧对话不在这里重建，由 Agent 上下文带入。
		const messages: AgentMessage[] = [];
		// 本次运行也可能由扩展自定义消息触发，不一定来自用户字符串。
		if (trigger.messageType === "custom") {
			// 自定义触发直接加入那条消息。
			messages.push(trigger.message);
		} else {
			// Normalize images after before_agent_start so extension-driven model selection
			// determines the resize profile used for the request and history.
			// 按最终选定模型的图片限制处理附件；纯文本问题时返回空图片列表。
			const normalized = await this._normalizePromptImages(trigger.images);
			// 准备最终用户文字；图片缩放/格式处理产生的提示也可能附在文字后面。
			const text =
				// 图片处理有提示才用空行追加到用户原文；没有提示保持原文，包括空字符串。
				normalized.hints.length > 0 ? `${trigger.prompt}\n\n${normalized.hints.join("\n")}` : trigger.prompt;
			// 追加一条结构化消息；大括号是对象，不是要执行的代码块。
			messages.push({
				// 明确标记这句话来自用户，模型据此区分指令来源。
				role: "user",
				// 内容是“文字块 + 图片块”数组；text 是 text: text 的简写。
				content: [{ type: "text", text }, ...normalized.images],
				// 记录毫秒时间戳，方便会话回放和统计。
				timestamp: Date.now(),
			});
		}
		// Inject any pending "nextTurn" messages as context alongside the starting message
		// 将之前排队的 nextTurn 上下文放到本次起始消息后面。
		messages.push(...this._pendingNextTurnMessages);
		// 这些消息已消费，清空队列，下一次 query 不再重复注入。
		this._pendingNextTurnMessages = [];
		// 再加入 before_agent_start 扩展提供的自定义上下文。
		for (const msg of result.messages) {
			// 追加一条结构化消息；大括号是对象，不是要执行的代码块。
			messages.push({
				// 先保留为 coding-agent 自定义消息，到了 convertToLlm 才转成模型可接受的消息。
				role: "custom",
				// 扩展自定义消息的分类名，供渲染和处理识别。
				customType: msg.customType,
				// Untyped extensions can pass null/missing content; normalize at ingestion.
				// 扩展是外部输入边界：漏掉内容时归一化为空数组，避免 null 进入历史。
				content: msg.content ?? [],
				// 记录是否展示给用户；是否进入模型由消息转换规则决定。
				display: msg.display,
				// 保存扩展附带的程序化详情。
				details: msg.details,
				// 记录毫秒时间戳，方便会话回放和统计。
				timestamp: Date.now(),
			});
		}
		// 根据最终工具集合/规则生成必要的 system 增量消息。
		const updateMessage = this._preparePromptAndToolLoadout(result.systemPromptOptions);
		// 保存本次运行的提示词选项，供后续内部多轮模型请求使用。
		this._runSystemPromptOptions = result.systemPromptOptions;
		// 有 system 补丁时插在新消息批次最前面；unshift 与 push 的插入位置相反。
		if (updateMessage) messages.unshift(updateMessage);
		// 返回本次新消息批次，交给 Agent.prompt；不是返回模型最终回答。
		return messages;
	}

	/**
	 * 处理低层运行结束后的恢复协调，返回外层是否应继续调用 Agent.continue。
	 * 一次性消费最后回复；优先取消，再普通重试、压缩恢复，最后检查 agent_end 新排队输入。
	 * 例：429 先退避，成功准备后返回 true；已完成回复后的阈值压缩不重复发送原问题。
	 */
	private async _handlePostAgentRun(): Promise<boolean> {
		// 低层 agent_end 之后，消费最后那条 assistant 回复，检查是否还需重试或压缩。
		const message = this._lastAssistantMessage;
		// 只处理一次，避免下次没有新回复时重复检查旧回复。
		this._lastAssistantMessage = undefined;
		// 用户取消优先；false 表示外层不应再调用 agent.continue()。
		if (this._agentRunAbortRequested) {
			// 收到取消时，如果普通重试尚有计数就发布取消结束并归零。
			this._finishCancelledRetry();
			// 取消优先，不再允许外层继续当前任务。
			return false;
		}
		// 没有回复时只检查队列，不凭空制造一次新的模型请求。
		if (!message) return this.agent.hasQueuedMessages();

		// 限流等暂时错误可以等待后重试；上下文溢出由后面的压缩恢复处理。
		if (this._isRetryableError(message) && (await this._prepareRetry(message))) {
			// 如果取消发生在重试期间，补齐重试结束通知。
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			// 把失败回复留给下一次虚拟路由的 failed 参数，虽然模型上下文已隐去失败消息。
			this._failedResponse = message;
			// 准备重试期间也可能被取消，返回当前取消标记的反值。
			return !this._agentRunAbortRequested;
		}
		// 等待普通重试准备后再检查一次取消，防止落入压缩恢复。
		if (this._agentRunAbortRequested) {
			// 补齐尚未结束的普通重试通知。
			this._finishCancelledRetry();
			// 取消后不继续。
			return false;
		}

		// 多次重试最终失败时，补齐重试结束事件并清空计数。
		if (message.stopReason === "error" && this._retryAttempt > 0) {
			// 多轮普通重试最终仍错误，给 UI/RPC 一个最终失败结束通知。
			this._emit({
				// 普通重试结束事件名。
				type: "auto_retry_end",
				// 最终回复仍 error，因此 success=false。
				success: false,
				// 报告真正完成过的额外尝试数。
				attempt: this._retryAttempt,
				// 保留最终供应商错误说明，可 undefined。
				finalError: message.errorMessage,
			});
			// 结束这批普通重试计数，下一用户任务可重新计数。
			this._retryAttempt = 0;
		}

		// 阈值或溢出可能触发压缩；返回 true 表示压缩后还要继续，例如恢复失败请求。
		if (await this._checkCompaction(message)) {
			// 压缩恢复返回继续意图后仍须尊重刚到的用户取消。
			return !this._agentRunAbortRequested;
		}

		// The low-level loop drains both queues before agent_end. Messages queued by
		// agent_end handlers require a fresh run before pre-settlement handlers fire.
		// agent_end 回调可能又排入新消息，仍需在最终 settled 前处理。
		return !this._agentRunAbortRequested && this.agent.hasQueuedMessages();
	}

	/**
	 * 在整个运行准备空闲前执行 agent_before_settle 扩展边界，返回是否仍需继续。
	 * 预览并提交草稿、冲刷 custom，再用最终上下文验证继续条件；取消优先，finally 清边界状态。
	 * 例：扩展添加待执行上下文后要求继续可被允许；单纯 continue=true 但无可运行输入则报告错误并停止。
	 */
	private async _runBeforeSettleBoundary(): Promise<boolean> {
		// 没人监听收尾边界，只凭低层队列决定是否继续。
		if (!this._extensionRunner.hasHandlers("agent_before_settle")) return this.agent.hasQueuedMessages();
		// 标记处于异步收尾扩展阶段，abort 会识别该阶段。
		this._isBeforeSettle = true;
		// 每次进入先清上次边界取消记录。
		this._abortDuringBeforeSettle = false;
		// 保证离开时清 _isBeforeSettle，包括异常和提前 return。
		try {
			// 执行可返回草稿与 continue 的收尾边界链。
			const result = await this._extensionRunner.emitBoundary(
				// 告诉扩展最近活动是完成、失败还是取消。
				{ type: "agent_before_settle", outcome: this._lastActivityOutcome },
				// 每次草稿变化重新在内存计算最终消息可运行性。
				(entries) => this._buildBoundaryContext(entries, "agent_before_settle"),
			);
			// 先把有效草稿正式提交。
			this._commitBoundaryDrafts(result.entries);
			// 再把边界期间排入的 context-only custom 消息写入。
			this._flushPendingCustomMessages();
			// 用真实提交后的状态再次判断，不只信扩展阶段的旧预览。
			const finalContext = this._buildBoundaryContext([], "agent_before_settle");
			// 边界等待期间用户取消优先，不再续跑。
			if (this._abortDuringBeforeSettle) return false;
			// 扩展续跑要求或新低层队列都可能延长本次运行。
			const shouldContinue = result.continue || this.agent.hasQueuedMessages();
			// 有继续意图但模型上下文无可回答输入，不准继续。
			if (shouldContinue && !finalContext.canContinue) {
				// 若是扩展明确要求的无效继续，报告扩展错误。
				if (result.continue) this._reportInvalidBoundaryContinuation("agent_before_settle");
				// 拒绝这次无上下文续跑。
				return false;
			}
			// 合法情况下返回最终继续决定。
			return shouldContinue;
			// 离开边界始终清标记。
		} finally {
			// 后续 abort 不再按边界等待期处理。
			this._isBeforeSettle = false;
		}
	}

	/**
	 * 对输入运行扩展拦截链，返回处理后的文字/图片；扩展 handled 则返回 undefined。
	 * 无处理器原样返回；transform 可替文字，未给新图片则保留旧图片。例：把“看这个文件”改写为完整路径后，后续模板展开使用新文字。
	 */
	private async _runInputHandlers(
		// 用户当前文字，可能已从上一输入来源转换。
		text: string,
		// 图片可缺省，transform 不提供替代时沿用。
		images: ImageContent[] | undefined,
		// 输入来源给扩展选择规则，不切换宿主 UI。
		source: InputSource,
		// 仅忙碌输入携带 steer/followUp 意图。
		streamingBehavior?: "steer" | "followUp",
		// 返回可继续处理的数据，undefined 表示扩展已接管。
	): Promise<{ text: string; images: ImageContent[] | undefined } | undefined> {
		// 没有 input 监听时避免额外派发链。
		if (!this._extensionRunner.hasHandlers("input")) {
			// 原文和原图原样返回。
			return { text, images };
		}

		// 等所有 input 改写链完成，handled 会在 runner 中短路。
		const inputResult = await this._extensionRunner.emitInput(text, images, source, streamingBehavior);
		// 扩展明确接管，不再发同一用户文字。
		if (inputResult.action === "handled") {
			// 以 undefined 告诉 prompt/queue 调用者已处理。
			return undefined;
		}
		// transform 表示采用扩展的新文字/可选图片。
		if (inputResult.action === "transform") {
			// 图片没给时保留原数组，给空数组则可以清掉原图片。
			return { text: inputResult.text, images: inputResult.images ?? images };
		}
		// continue 情况沿用原输入。
		return { text, images };
	}

	/**
	 * 逐张按图片设置和当前限制模型处理附件，返回可用图片与文字提示数组。
	 * base64 解码后调用 processImage；失败图片只留下提示，成功图片用处理后的数据/mimeType 并累积缩放提示。
	 * 例：不可处理附件不会照原样混入模型输入；队列辅助函数并不调用本方法，不能把该行为泛化到所有排队图片。
	 */
	private async _normalizePromptImages(
		// 可选的 base64 图片块数组。
		images: ImageContent[] | undefined,
		// 返回处理后图片数组和可附入文字的提示列表。
	): Promise<{ images: ImageContent[]; hints: string[] }> {
		// 没传图片直接得到两份空数组。
		if (!images) return { images: [], hints: [] };

		// 收集成功处理的图片，失败者不进入此数组。
		const normalizedImages: ImageContent[] = [];
		// 收集失败/缩放等说明，后面附用户文字。
		const hints: string[] = [];
		// 按附件顺序逐张等待处理，输出顺序与成功输入一致。
		for (const image of images) {
			// base64 解码为 Buffer，声明 MIME 交给处理器识别/转换。
			const processed = await processImage(Buffer.from(image.data, "base64"), image.mimeType, {
				// 采用设置中的是否自动缩放图片。
				autoResizeImages: this.settingsManager.getImageAutoResize(),
				// 优先按限制模型提供的具体 resize profile。
				resizeOptions: this._limitsModel()?.inputLimits?.images?.resize,
			});
			// ok 是结果分辨字段，false 时只能用失败信息，不能读成功数据。
			if (!processed.ok) {
				// 留下文字说明，避免模型误以为图片已正常传入。
				hints.push(processed.message);
				// 跳过失败图片，继续处理后面的附件。
				continue;
			}
			// 成功结果可能已改编码/MIME，重新建规范化图片块。
			normalizedImages.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
			// 把该图处理产生的多条提示按序加入。
			hints.push(...processed.hints);
		}
		// 返回两类结果供 _prepareRun 拼正文与图片块。
		return { images: normalizedImages, hints };
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	// 用户调用的会话提问入口。例 await session.prompt("读取 decision.txt")。
	/**
	 * 接收一次用户提问并完成命令/输入扩展/技能/模板处理，然后启动运行或排队。
	 * 返回 Promise<void>；空闲路径验证模型/认证再 _startRun，忙碌路径要求 streamingBehavior，settled 回调中调用先延后。
	 * 例：session.prompt("/review a.ts") 可展开模板；preflightResult 仅报告 handled/queued/started，不是回答结果；扩展命令错误也可被视为已处理。
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		// 如果在 settled 通知期间又提交问题，先延迟执行，避免收尾回调内重入当前流程。
		if (this._isEmittingAgentSettled) {
			// 把这次调用包装成稍后执行的函数，连同 text/options 一起保存。
			this._deferredSettledActions.push(async () => await this.prompt(text, options));
			// 结束当前函数；若位于提前退出分支，后面的模型请求不会执行。
			return;
		}
		// 默认允许斜杠命令、技能与模板展开；?. 允许不传 options，?? 提供缺省值。
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		// 可选的派发结果通知，RPC 等调用方据此知道请求是处理了、排队了还是启动了。
		const preflightResult = options?.preflightResult;
		// Handle extension commands first (execute immediately, even during streaming)
		// Extension commands manage their own LLM interaction via pi.sendMessage()
		// 以 / 开头时先检查扩展命令，例如 /my-command；命令可能自己处理，不必请求模型。
		if (expandPromptTemplates && text.startsWith("/")) {
			// 查找并执行注册的扩展命令，等待它处理完成。
			const handled = await this._tryExecuteExtensionCommand(text);
			// 找到命令并执行后，就不再把同一串文字当普通用户提问发送。
			if (handled) {
				// Extension command executed, no prompt to send
				// 如果调用方订阅了派发结果，通知“已由命令/扩展处理”。
				preflightResult?.("handled");
				// 结束当前函数；若位于提前退出分支，后面的模型请求不会执行。
				return;
			}
		}

		// 手动压缩正在进行时拒绝新 prompt，避免同时修改同一份会话上下文。
		if (this._compactionAbortController !== undefined) {
			// 当前条件不允许继续时抛出明确错误，Promise 会以拒绝状态交给调用方。
			throw new Error(
				// 错误提示只说明手动压缩占用；不把所有自动压缩误判成这个前置分支。
				"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
			);
		}

		// Emit input event for extension interception (before skill/template expansion)
		// 先让 input 扩展读取/改写输入；这个时点还没做技能和模板展开。
		const processedInput = await this._runInputHandlers(
			// 用户原始文字，例如“读取 decision.txt”。
			text,
			// 可选的用户图片附件。
			options?.images,
			// 标记输入来源，没指定时按 interactive；这不是切换到终端界面。
			options?.source ?? "interactive",
			// 只有会话正在工作时，才向扩展传插话/追问的排队方式。
			this.isStreaming ? options?.streamingBehavior : undefined,
		);
		// 扩展已经完全处理了输入时，就不再继续发模型请求。
		if (!processedInput) {
			// 如果调用方订阅了派发结果，通知“已由命令/扩展处理”。
			preflightResult?.("handled");
			// 结束当前函数；若位于提前退出分支，后面的模型请求不会执行。
			return;
		}
		// 对象解构并改名：取 text 放进 currentText，取 images 放进 currentImages。
		const { text: currentText, images: currentImages } = processedInput;

		// Expand skill commands (/skill:name args) and prompt templates (/template args)
		// 先保留处理后的文字，下一步可能把 /skill:name 或模板替换为正文。
		let expandedText = currentText;
		// 仅在调用方允许展开时处理技能和提示词模板。
		if (expandPromptTemplates) {
			// 把 /skill:name 参数展开成技能内容块；普通文字保持原样。
			expandedText = this._expandSkillCommand(expandedText);
			// 再展开提示词模板，例如 /review file.ts 转成一段完整指令。
			expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
		}

		// If streaming, queue via steer() or followUp() based on option
		// 会话已经在处理问题时，不另起并发运行，改走排队逻辑。
		if (this.isStreaming) {
			// 忙碌时必须说明是插话还是等当前任务结束后的追问。
			if (!options?.streamingBehavior) {
				// 当前条件不允许继续时抛出明确错误，Promise 会以拒绝状态交给调用方。
				throw new Error(
					// 忙碌输入必须指定 steer/followUp，错误里列合法值。
					"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
				);
			}
			// followUp：等模型没有工具/插话后再处理，而非立刻停止当前输出。
			if (options.streamingBehavior === "followUp") {
				// 加入 follow-up 队列，低层循环自然结束前读取。
				await this._queueFollowUp(expandedText, currentImages);
			} else {
				// 加入插话队列，在当前模型及工具回合结束后、下一次请求前投递。
				await this._queueSteer(expandedText, currentImages);
			}
			// 回报“已排队”；本次 prompt 返回不等于排队消息已经获得模型回答。
			preflightResult?.("queued");
			// 结束当前函数；若位于提前退出分支，后面的模型请求不会执行。
			return;
		}

		// Validate model
		// 普通空闲提问需要先选定模型，否则无法生成回答。
		if (!this.model) {
			// 缺模型时给调用方明确提示，在发送任何请求之前结束。
			throw new Error(formatNoModelSelectedMessage());
		}

		// 检查模型供应商是否有可用认证；真正请求时 ModelRuntime 仍会处理凭证。
		const hasConfiguredAuth =
			// 已经有配置的认证时可以直接通过这一项。
			this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
			// 否则异步查认证，例如供应商自己的环境凭证；存在结果就可以继续。
			(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
		// 配置和供应商认证检查均未给出认证入口时才报错；不在此发送聊天请求验证远端凭证。
		if (!hasConfiguredAuth) {
			// 区分 OAuth 登录与普通 API key，便于给出正确的修复提示。
			const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
			// OAuth 凭证可能过期，下面给出重新登录提示。
			if (isOAuth) {
				// 当前条件不允许继续时抛出明确错误，Promise 会以拒绝状态交给调用方。
				throw new Error(
					// 供应商名称进入错误说明，不包含其凭证值。
					`Authentication failed for "${this.model.provider}". ` +
						// 给出过期/网络不可用等可能原因，不能据这句话断言已定位根因。
						`Credentials may have expired or network is unavailable. ` +
						// 提示通过该供应商登录流程恢复认证。
						`Run '/login ${this.model.provider}' to re-authenticate.`,
				);
			}
			// 没有普通 key 时给出缺认证错误，不进入 Agent 工具循环。
			throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
		}

		// 所有前置处理通过：把用户文字/图片交给会话运行入口，随后进入 Agent.prompt。
		await this._startRun({ messageType: "user", prompt: expandedText, images: currentImages }, () =>
			// 启动回调：等起始消息准备好，再通知调用方运行已开始。
			preflightResult?.("started"),
		);
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	/**
	 * 解析 /命令及余下参数，查扩展命令并执行，返回是否找到该命令。
	 * 找不到 false；找到后构建命令上下文，成功或捕获异常并报告后均 true，不再把原文字发送模型。
	 * 例：/plan a.ts 调用 plan.handler("a.ts",ctx)；这里只按首个空格切分，不实现 shell 引号解析。
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		// 只找第一个普通空格作为命令/参数分界。
		const spaceIndex = text.indexOf(" ");
		// 无空格则去掉首个 / 全段作命令名；否则截到空格前。
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		// 余下内容不再 shell 拆词，直接交扩展 handler。
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		// 查注册命令，支持 runner 定义的调用名称解析。
		const command = this._extensionRunner.getCommand(commandName);
		// 找不到返回 false，让 prompt 继续处理模板/普通文字。
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		// 创建可操作会话的命令上下文，不只普通事件 ctx。
		const ctx = this._extensionRunner.createCommandContext();

		// 运行命令失败时转换成扩展错误通知。
		try {
			// 等待异步 handler，参数字符串与 ctx 原样传入。
			await command.handler(args, ctx);
			// 成功表示命令已处理，不再发用户 prompt。
			return true;
			// 捕获命令异常，避免同一命令文本又被当普通任务。
		} catch (err) {
			// Emit error via extension runner
			// 通过统一错误监听报告具体命令来源。
			this._extensionRunner.emitError({
				// 合成 command:名称 来源，不是扩展真实磁盘文件路径。
				extensionPath: `command:${commandName}`,
				// 标记命令执行阶段。
				event: "command",
				// 将 Error/其他抛出值规范化为可读说明。
				error: err instanceof Error ? err.message : String(err),
			});
			// 执行虽失败仍算已处理，返回 true 不代表命令业务成功。
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	/**
	 * 把已注册 /skill:name 指令展开为技能文件正文及可选参数，返回新文字或原文字。
	 * 同步读取文件，去 frontmatter，包装名称/位置/相对参考目录；未知技能或读取失败保留原文，失败另发扩展错误。
	 * 例：/skill:review a.ts 展开 review 的正文后追加 a.ts；不是在此执行技能里的命令。
	 */
	private _expandSkillCommand(text: string): string {
		// 不是技能命令立即保留原文字，不读文件。
		if (!text.startsWith("/skill:")) return text;

		// 按首个空格拆技能名与附加要求，不处理引号/转义参数语法。
		const spaceIndex = text.indexOf(" ");
		// /skill: 前缀长 7，截掉后取名字。
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		// 附加参数作为整段文本，去两端空白。
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		// 在当前加载器技能列表按名称精确找第一项。
		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		// 未知名字保留原文，不在这里伪造技能内容。
		if (!skill) return text; // Unknown skill, pass through

		// 同步读/解析技能文件异常在此转换为扩展错误。
		try {
			// 用 UTF-8 读取已发现技能文件，执行时仍可能不存在或不可读。
			const content = readFileSync(skill.filePath, "utf-8");
			// 去 YAML frontmatter 后 trim，保留给模型的技能正文。
			const body = stripFrontmatter(content).trim();
			// 包装包含技能名、文件位置、参考相对目录与正文的文本块；插值不做 XML 属性转义。
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			// 有附加要求则空行拼到技能闭标签之后，供 parseSkillBlock 分离。
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
			// 读取/展开失败不阻断普通输入，而是报告并返回原命令文字。
		} catch (err) {
			// Emit error like extension commands do
			// 派发扩展错误事件，方便 UI 展示技能展开失败。
			this._extensionRunner.emitError({
				// 以技能文件路径标识错误来源。
				extensionPath: skill.filePath,
				// 错误阶段为 skill_expansion。
				event: "skill_expansion",
				// Error 取 message，其他抛出值转字符串。
				error: err instanceof Error ? err.message : String(err),
			});
			// 失败时原文透传，后续可能作为普通用户文字发模型。
			return text; // Return original on error
		}
	}

	/**
	 * 公共插话/追问入口共享的输入处理，返回 handled 或 queued。
	 * 先拒绝扩展命令，再跑 input 扩展、技能和模板展开，最后按 behavior 入低层队列。
	 * 例：steer("/skill:review a.ts") 入队的是展开正文；不在这里验证模型认证或启动一次新运行。
	 */
	private async _queueUserInput(
		// 待排队用户文字。
		text: string,
		// 可选图片附件，与文字一起进入一条消息。
		images: ImageContent[] | undefined,
		// 字面量联合限定插话或追问两种排队方式。
		behavior: "steer" | "followUp",
		// input 扩展感知的来源。
		source: InputSource,
		// 返回处理掉或已入队，不等待对应模型回答。
	): Promise<QueuedInputDisposition> {
		// 斜杠开头才需要检查是否是不可排队的扩展命令。
		if (text.startsWith("/")) {
			// 已注册扩展命令抛错，避免模型误执行它的文字含义。
			this._throwIfExtensionCommand(text);
		}

		// 输入先走扩展，可被接管/改写。
		const processedInput = await this._runInputHandlers(
			// 原排队文字。
			text,
			// 原排队图片。
			images,
			// 转交实际输入来源。
			source,
			// 会话忙碌时才给扩展排队行为，空闲调用该 API 不假装有运行。
			this.isStreaming ? behavior : undefined,
		);
		// 被扩展接管时返回 handled，不再塞入低层队列。
		if (!processedInput) return "handled";

		// 先展开技能，读取当前技能文件正文。
		let expandedText = this._expandSkillCommand(processedInput.text);
		// 再展开提示词模板，使用当前加载模板的数组副本。
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		// 按既定排队方式派发，不另开低层 prompt。
		if (behavior === "steer") {
			// 插话通过下一工具/模型回合边界插入。
			await this._queueSteer(expandedText, processedInput.images);
		} else {
			// 追问等待低层现有工具/插话耗尽。
			await this._queueFollowUp(expandedText, processedInput.images);
		}
		// 已完成入队，不表示已发送模型或获得回答。
		return "queued";
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 * @throws Error if text is an extension command
	 */
	/**
	 * 提交插话文字与可选图片，通过共享输入处理后返回 handled/queued；来源默认 interactive。
	 * 例：任务正在跑时插入“先看测试”，在低层允许的回合边界投递，不代表立即打断正在流出的 token。
	 */
	async steer(
		// 要排队的插话文字，可含技能/模板命令。
		text: string,
		// 可选图片，不是文件名。
		images?: ImageContent[],
		// 只选取可选 source；不允许在此指定其他 prompt 选项。
		options?: { source?: InputSource },
		// 返回队列派发状态 Promise。
	): Promise<QueuedInputDisposition> {
		// 使用共享检查/展开链，并将默认来源设 interactive。
		return this._queueUserInput(text, images, "steer", options?.source ?? "interactive");
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 * @throws Error if text is an extension command
	 */
	/**
	 * 提交等当前工具/插话耗尽后处理的追问，返回 handled/queued；来源默认 interactive。
	 * 例：followUp("接着写说明") 不开第二个并发 Agent，交给低层追问队列按其策略取出。
	 */
	async followUp(
		// 等当前任务后处理的追问文字。
		text: string,
		// 追问附图可省略。
		images?: ImageContent[],
		// 可用 source 区分扩展或交互输入。
		options?: { source?: InputSource },
		// 返回 handled 或 queued 的异步结果。
	): Promise<QueuedInputDisposition> {
		// 与 steer 复用同一输入处理，只改变最终低层队列。
		return this._queueUserInput(text, images, "followUp", options?.source ?? "interactive");
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	/**
	 * 把已展开文字加入展示队列并构成 user 消息送入 Agent 插话队列，返回 Promise<void>。
	 * 可附原图片；发布 queue_update 后再入低层队列。例：文字 pending 展示先更新，但消息尚未生成模型回答。
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		// 先保存文字供 UI 展示；完整带图消息在 Agent 内。
		this._steeringMessages.push(text);
		// 立即发布插话队列快照。
		this._emitQueueUpdate();
		// 数组元素为 TextContent 或 ImageContent，第一块固定文字；text 是属性简写。
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		// 传过图片数组才展开，空数组也允许。
		if (images) {
			// 图片块按原顺序放文字之后，没有在这里处理尺寸。
			content.push(...images);
		}
		// 调用低层 steer 入队，不启动第二次 Agent 运行。
		this.agent.steer({
			// 最终排队消息是 user 角色。
			role: "user",
			// 复用刚拼好的内容数组。
			content,
			// 记录排队时毫秒时间。
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	/**
	 * 把已展开文字加入展示队列和 Agent 追问队列，返回 Promise<void>，不再执行输入扩展。
	 * 例：带图追问组合为一条 user 消息；这里没有调用 _normalizePromptImages。
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		// 保存追问展示文字，真正取出时由消息开始事件移除。
		this._followUpMessages.push(text);
		// 通知界面/RPC 队列变化。
		this._emitQueueUpdate();
		// 建立文字/图片联合类型数组，先放文字块。
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		// 有图片时继续追加内容块。
		if (images) {
			// spread 把各图片项分别加入数组，不把整数组当一个块。
			content.push(...images);
		}
		// 交 Agent.followUp 保存完整 user 消息，时间取当前毫秒。
		this.agent.followUp({ role: "user", content, timestamp: Date.now() });
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	/**
	 * 若文字首段对应已注册扩展命令则抛错，返回 void；不执行命令。
	 * 例：/plan 不能作为待模型处理的插话排队，应从 prompt 路径执行；未知 /name 在此不报错。
	 */
	private _throwIfExtensionCommand(text: string): void {
		// 队列入口已确认文字以 / 开头，查首空格以分命令名。
		const spaceIndex = text.indexOf(" ");
		// 去掉前导 /，无参数时取到末尾。
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		// 查命令注册表，而非把所有 /name 都禁止。
		const command = this._extensionRunner.getCommand(commandName);

		// 只有已注册扩展命令才不能经用户队列送模型。
		if (command) {
			// 通过 Error 拒绝当前异步排队入口。
			throw new Error(
				// 明确提示使用 prompt 立即执行扩展命令。
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles four cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Streaming + triggerTurn false: appended to state/session once the current turn ends
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	/**
	 * 发送扩展自定义消息，输入 Pick 只需分类/正文/显示/详情；返回 Promise<void>。
	 * nextTurn 延到下一起始消息后；运行中默认 steer 或 followUp；triggerTurn=false 延到工具结果齐备；空闲时按 triggerTurn 决定启动或只追加。
	 * 例：display=false 只是 UI 偏好，正文仍可进模型上下文；泛型 T 描述 details，不做运行时 schema 验证。
	 */
	async sendCustomMessage<T = unknown>(
		// Pick 仅要求原 custom 类型的这四个成员；details 的 T 保持调用方类型信息。
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		// 可选 triggerTurn 和三种投递方式，nextTurn 的判定优先。
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
		// 返回 Promise<void>，下一轮暂存情形会很快完成，并不等待模型处理。
	): Promise<void> {
		// 构造本次发送的应用层 custom 消息。
		const appMessage = {
			// as const 将角色保持为 "custom" 字面量，防止推断成任意 string。
			role: "custom" as const,
			// 保留扩展自定义分类。
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			// 无类型扩展可漏内容，入口用 ?? 补 []，不是给普通 typed 参数逐字段防御。
			content: message.content ?? [],
			// 界面显示偏好原样保存。
			display: message.display,
			// 泛型详情保留原数据引用，不复制或运行时验证。
			details: message.details,
			// 记录构造这条消息时的毫秒时间。
			timestamp: Date.now(),
			// satisfies 检查对象符合 CustomMessage<T>，同时保留推断出的更具体类型，不生成验证代码。
		} satisfies CustomMessage<T>;
		// nextTurn 优先于 streaming/triggerTurn，不会立即发模型。
		if (options?.deliverAs === "nextTurn") {
			// 暂存，等下一次 _prepareRun 跟随起始消息消费。
			this._pendingNextTurnMessages.push(appMessage);
			// 运行中只要没显式 false，就使用低层队列，不直接改历史。
		} else if (this.isStreaming && options?.triggerTurn !== false) {
			// 明确 followUp 交追问队列。
			if (options?.deliverAs === "followUp") {
				// 完整 custom 消息交低层，未加入文字展示队列。
				this.agent.followUp(appMessage);
				// 其他默认方式按 steer 插话投递。
			} else {
				// custom 消息将在低层消费时发开始/结束事件并保存。
				this.agent.steer(appMessage);
			}
			// 空闲且 triggerTurn 为真时启动由 custom 触发的新运行。
		} else if (options?.triggerTurn) {
			// 若正在 settled 通知期，先延迟，避免重入正在完成的运行。
			if (this._isEmittingAgentSettled) {
				// 闭包保留原输入/选项，稍后重新调用并创建消息。
				this._deferredSettledActions.push(async () => await this.sendCustomMessage(message, options));
				// 当前发送立即返回，延迟动作由 settled 协调器等待。
				return;
			}
			// 真正启动 custom 运行，before_agent_start 的触发类型为 custom。
			await this._startRun({ messageType: "custom", message: appMessage });
			// 运行中但显式 triggerTurn=false，等回合完整工具结果到齐再补上下文。
		} else if (this.isStreaming) {
			// Appending now would put the message between an assistant tool call and its
			// result, which providers that validate message order reject on replay. Defer
			// to the end of the turn. Nothing is emitted yet: message events must not
			// describe messages the session tree does not contain.
			// 仅暂存不立刻派发消息事件，避免事件描述尚未入树的数据。
			this._pendingCustomMessages.push(appMessage);
		} else {
			// 空闲且不触发模型时，立即追加为历史上下文。
			this._appendCustomMessage(appMessage);
		}
	}

	/**
	 * 将 custom 消息写会话、刷新有效历史，并向公开观察者发消息开始/结束事件；不启动模型。
	 * 返回 void。例：空闲追加一条背景说明后，下一 query 可在历史里看到它；这里未调用低层 Agent 的事件处理器。
	 */
	private _appendCustomMessage(appMessage: CustomMessage): void {
		// custom 用专属条目存储，manager 生成条目 id/时间。
		this.sessionManager.appendCustomMessageEntry(
			// 自定义消息分类。
			appMessage.customType,
			// 文字/图片正文。
			appMessage.content,
			// 界面展示开关。
			appMessage.display,
			// 附带程序化详情。
			appMessage.details,
		);
		// 投影刷新后状态才可读到新消息。
		this._refreshFinalizedContext();
		// 公开通知开始，观察者可以显示新 custom 消息。
		this._emit({ type: "message_start", message: appMessage });
		// 紧跟公开完成事件；不通过 _handleAgentEvent 再存一遍。
		this._emit({ type: "message_end", message: appMessage });
	}

	/**
	 * Append custom messages queued while the agent was running.
	 * Called once the current turn's tool results are in agent state and session history.
	 */
	/**
	 * 消费运行中暂存的 context-only custom 消息，依序调用追加路径，返回 void。
	 * 先换成空队列再追加，避免重复消费。例：工具调用与结果完整保存后再放入扩展说明，不插进配对中间。
	 */
	private _flushPendingCustomMessages(): void {
		// 无待追加消息时不刷新上下文。
		if (this._pendingCustomMessages.length === 0) return;

		// 先留局部引用，确保本批消费的是当前快照。
		const pending = this._pendingCustomMessages;
		// 把字段换为空数组，回调中新加入项不会混进旧批。
		this._pendingCustomMessages = [];
		// 按等待顺序逐条追加。
		for (const appMessage of pending) {
			// 每条都会写会话、刷新投影并发公开开始/结束通知。
			this._appendCustomMessage(appMessage);
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 * @param options.expandPromptTemplates Whether to dispatch extension commands and expand skill commands and prompt templates. Default: false.
	 */
	/**
	 * 把字符串或文字/图片块转为用户 prompt，调用会话入口，返回本次派发/运行完成的 Promise。
	 * 多文字块用换行拼接，图片单独收集；默认不展开命令/模板，来源标为 extension。
	 * 例：[text A,image,text B] 变为文字 A\nB 与单独图片列表；运行中仍需 options.deliverAs。
	 */
	async sendUserMessage(
		// 输入可以是整段文字或文字/图片块的联合数组。
		content: string | (TextContent | ImageContent)[],
		// 运行中需要 deliverAs；模板展开缺省关闭，不同于直接 prompt 的默认值。
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
		// 返回会话 prompt 的完成 Promise，不返回回复正文。
	): Promise<void> {
		// Normalize content to text string + optional images
		// 声明归一化后的文字变量，两条类型分支都会赋值。
		let text: string;
		// 图片只有确实存在时才保留数组，否则 undefined。
		let images: ImageContent[] | undefined;

		// typeof 收窄字符串/数组联合，属于内容表示的分流，不是重新验证每块 schema。
		if (typeof content === "string") {
			// 纯字符串原样当用户文字。
			text = content;
		} else {
			// 数组分支累计每个 text 块。
			const textParts: string[] = [];
			// 先建空图片数组，遍历后若空再改回 undefined。
			images = [];
			// 按照原内容顺序分出文字与图片。
			for (const part of content) {
				// type 是联合分辨字段，text 分支有 .text。
				if (part.type === "text") {
					// 收集文字块正文。
					textParts.push(part.text);
				} else {
					// 另一类只能为 ImageContent，按类型直接保留原块。
					images.push(part);
				}
			}
			// 多个文字块用换行拼接，图片不占文字位置。
			text = textParts.join("\n");
			// 没有图时用 undefined，避免给下游无意义的空附件列表。
			if (images.length === 0) images = undefined;
		}

		// 复用 prompt 的扩展输入、排队、认证、生命周期协调。
		await this.prompt(text, {
			// 只有显式 true 才允许本入口展开命令/技能/模板。
			expandPromptTemplates: options?.expandPromptTemplates ?? false,
			// 将 deliverAs 转成 prompt 期望的 streamingBehavior 名称。
			streamingBehavior: options?.deliverAs,
			// 传归一化后的可选图片。
			images,
			// 扩展发起的用户消息，input 事件来源标为 extension。
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	/**
	 * 清空展示用插话/追问和低层两队列，返回清空前的文字数组快照。
	 * 发布 queue_update；不清 pendingNextTurn/custom/bash。例：取消时可把返回文字恢复编辑器，图片和扩展队列消息不在返回文字数组中。
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		// 返回前复制插话文字，以便调用方恢复到编辑器。
		const steering = [...this._steeringMessages];
		// 追问也复制，避免随清空丢掉内容。
		const followUp = [...this._followUpMessages];
		// 清会话展示插话列表。
		this._steeringMessages = [];
		// 清会话展示追问列表。
		this._followUpMessages = [];
		// 清低层真实两队列，包含其中 custom/图片完整消息；不等于清本类所有暂存。
		this.agent.clearAllQueues();
		// 发布两个文字数组均为空的事件。
		this._emitQueueUpdate();
		// 返回清空前文字快照，未返回完整图片/自定义数据。
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	/**
	 * 返回展示用插话与追问条数之和，不涵盖所有低层/自定义队列。例：仅有 nextTurn custom 时可能仍为 0。
	 */
	get pendingMessageCount(): number {
		// 只相加展示文字队列长度，pending custom/bash/nextTurn 不参与。
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	/**
	 * 读取展示用插话文字原数组，类型只读、不冻结运行时对象。例：UI 渲染待发送文字；图片不在该数组里。
	 */
	getSteeringMessages(): readonly string[] {
		// 直接返回原文字数组，readonly 是 TS 限制。
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	/**
	 * 读取展示用追问文字原数组，类型只读；不消费消息。例：UI 可显示尚未开始处理的第二个问题。
	 */
	getFollowUpMessages(): readonly string[] {
		// 直接返回原追问文字数组，不消费。
		return this._followUpMessages;
	}

	/**
	 * 返回本会话使用的资源加载器引用；不自动 reload。例：技能指令查找经由它读取当前技能列表。
	 */
	get resourceLoader(): ResourceLoader {
		// 返回同一资源加载器对象。
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	/**
	 * 请求取消当前运行、重试、压缩和分支摘要，然后等待会话判定空闲。
	 * 边界收尾中另记取消标记；不在这里取消独立手动 bash，bash 有自己的 abortBash。
	 * 例：UI Esc 取消 query 后等待 settled，避免马上修改仍在运行的会话状态。
	 */
	async abort(): Promise<void> {
		// 有运行时才记运行级取消，空闲单独取消摘要仍可往下发控制器信号。
		if (this._isAgentRunActive) {
			// 外层 prompt/continue 协调循环会看到此标记。
			this._agentRunAbortRequested = true;
		}
		// 中断普通重试退避。
		this.abortRetry();
		// 中断手动/自动摘要压缩。
		this.abortCompaction();
		// 中断分支摘要/导航准备。
		this.abortBranchSummary();
		// 边界期间的取消另存标记，防止扩展之后又要求继续。
		if (this._isBeforeSettle) this._abortDuringBeforeSettle = true;
		// 通知低层当前模型或工具操作取消。
		this.agent.abort();
		// 等整个会话协调结束，不只等一次流请求停。
		await this.waitForIdle();
	}

	/**
	 * 若已空闲立即完成，否则等待共享空闲 Promise，返回 Promise<void>。
	 * 不启动或取消任务，不等独立 bash。例：宿主 await waitForIdle() 后再安排需空闲的会话操作。
	 */
	async waitForIdle(): Promise<void> {
		// 已经符合本类空闲定义就无需 Promise 等待。
		if (this.isIdle) {
			// 立即完成 Promise<void>。
			return;
		}
		// 共享等待直到运行/摘要清状态的路径唤醒。
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	/**
	 * 模型前后身份确实变化时异步派发 model_select，返回 Promise<void>。
	 * source 表示 set/cycle/restore；例：同 provider/id 再设一次不重复发选择事件，这里不改模型本身。
	 */
	private async _emitModelSelect(
		// 新模型必须有值。
		nextModel: Model<any>,
		// 旧模型可未选，供扩展比较。
		previousModel: Model<any> | undefined,
		// 区分用户直接设置、循环或恢复来源。
		source: "set" | "cycle" | "restore",
		// 事件异步处理完成后 Promise 才完成。
	): Promise<void> {
		// 按 provider/id 比较，同一模型不重复发事件。
		if (modelsAreEqual(previousModel, nextModel)) return;
		// 派发给当前扩展运行器，不在此保存 model_change。
		await this._extensionRunner.emit({
			// 模型选择事件名。
			type: "model_select",
			// 新模型引用。
			model: nextModel,
			// 可能缺省的原模型引用。
			previousModel,
			// 操作来源，便于扩展决定副作用。
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured and saves to the session transcript.
	 * Persists to global defaults only when options.persist is true.
	 * @throws Error if no auth is configured for the model
	 */
	/**
	 * 校验目标供应商认证后切换模型，记录会话，并按选项保存全局默认。
	 * 根据目标模型默认推导思考级别并钳制，再派发 model_select；可能认证失败抛错、写设置和追加会话记录。
	 * 例：setModel(B,{persist:true}) 同时改后续默认模型；不自动把有效思考级别写成全局默认。
	 */
	async setModel(model: Model<any>, options: ModelMutationOptions = {}): Promise<void> {
		// 先检查供应商认证；这是配置/可用性检查，不是发一次聊天验证 token。
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			// 缺认证拒绝切换，后续状态/历史尚未修改。
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		// 保留旧模型供事件比较。
		const previousModel = this.model;
		// 按目标偏好推导请求的思考级别，之后再钳制。
		const thinkingLevel = this._getThinkingLevelForModelSwitch(model);
		// 实际修改后续请求的模型选择。
		this.agent.state.model = model;
		// 在当前分支记录模型选择，resume 可恢复。
		this.sessionManager.appendModelChange(model.provider, model.id);
		// 只有显式 persist 才影响全局默认。
		if (options.persist) {
			// 把供应商和模型作为配对默认保存。
			this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
			// 非空循环范围按需补入新的持久默认模型。
			this._addPersistedDefaultToNonEmptyScope(model);
		}

		// Apply thinking level for the new model.
		// Per-model thinking level overrides take priority over the global default.
		// Model persistence does not implicitly rewrite the global thinking default.
		// 按新模型能力设置级别，不把 options.persist 透传，避免重写思考全局默认。
		this.setThinkingLevel(thinkingLevel);

		// 异步通知扩展模型确实改变。
		await this._emitModelSelect(model, previousModel, "set");
	}

	/**
	 * 持久默认模型切换时，若循环范围原本非空则补入新模型，并按需补 enabledModels 设置。
	 * 返回 void，已存在时跳过；enabledModels 未配置/为空时不创建新限制。例：循环范围 [A,B] 持久选 C 后补成 [A,B,C]。
	 */
	private _addPersistedDefaultToNonEmptyScope(model: Model<any>): void {
		// 空范围代表未限制模型，不因持久选择而建立单元素限制。
		if (this._scopedModels.length === 0) return;
		// 范围已有同 provider/id 则无需补入。
		if (this._scopedModels.some((scoped) => modelsAreEqual(scoped.model, model))) return;

		// 不可变数组拼接换引用，添加仅含 model 的新范围项。
		this._scopedModels = [...this._scopedModels, { model }];

		// 读取用户持久的模型循环/启用模式列表。
		const enabledModels = this.settingsManager.getEnabledModels();
		// 没配置或空列表不改限制设置。
		if (!enabledModels?.length) return;

		// 组合完整供应商/模型引用，避免同名不同供应商冲突。
		const modelReference = `${model.provider}/${model.id}`;
		// 已显式列该引用时大小写不敏感去重；此处不对通配模式作匹配。
		if (enabledModels.some((pattern) => pattern.toLowerCase() === modelReference.toLowerCase())) return;
		// 把新模型引用追加到已有 enabledModels 配置。
		this.settingsManager.setEnabledModels([...enabledModels, modelReference]);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	/**
	 * 按方向循环模型：有 scoped 范围用该范围，否则用可用快照；返回新模型信息或 undefined。
	 * 可写会话/选项指定的全局设置。例：forward 到末项后回首项；不足两项不切换。
	 */
	async cycleModel(
		// 方向仅允许 forward/backward，默认正向。
		direction: "forward" | "backward" = "forward",
		// 默认空选项表示只改会话，不保存全局默认。
		options: ModelMutationOptions = {},
		// 返回切换信息或无可循环结果。
	): Promise<ModelCycleResult | undefined> {
		// 非空范围优先，不混入范围之外模型。
		if (this._scopedModels.length > 0) {
			// 沿范围内可用交集循环。
			return this._cycleScopedModel(direction, options);
		}
		// 无范围使用当前可用快照循环。
		return this._cycleAvailableModel(direction, options);
	}

	/**
	 * 在范围内循环，先与当前可用模型快照交集，再按方向取下一项。
	 * 更新 Agent、记录 model_change、按需持久化、应用思考级别、派发选择事件并返回 isScoped=true。
	 * 例：范围 A/B/C 中 B 无认证可用性，循环只在 A/C；当前模型不在范围时先将索引当 0，再计算下一项。
	 */
	private async _cycleScopedModel(
		// 方向由公共入口决定，不在内部给另一个默认值。
		direction: "forward" | "backward",
		// 继续传模型持久化选项。
		options: ModelMutationOptions,
		// 返回可能切换的模型详情。
	): Promise<ModelCycleResult | undefined> {
		// 建立供应商加 NUL 加 id 的集合，区分同名模型。
		const availableIds = new Set(
			// getAvailableSnapshot 只读已刷新快照，不 await 网络检查。
			this._modelRuntime
				.getAvailableSnapshot()
				.map((model) => `${model.provider}\0${model.id}`),
		);
		// 仅保留 scoped 中当前可用的模型。
		const scopedModels = this._scopedModels.filter((scoped) =>
			// 根据供应商/id 复合键作交集判断。
			availableIds.has(`${scoped.model.provider}\0${scoped.model.id}`),
		);
		// 零或一个候选时无需切换，也不保存设置。
		if (scopedModels.length <= 1) return undefined;

		// 当前选择用于找循环起点和派发变更事件。
		const currentModel = this.model;
		// findIndex 找不到为 -1，比较规则为模型身份。
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		// 不在集合时按 0 作起点，因此 forward 会取第 2 项，不是直接首项。
		if (currentIndex === -1) currentIndex = 0;
		// 缓存长度供模运算。
		const len = scopedModels.length;
		// % 实现首尾环绕；反向先加 len 避免负余数。
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		// 读取计算后下标对应的范围项。
		const next = scopedModels[nextIndex];
		// 范围项显式级别优先于目标模型/全局配置。
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.model, next.thinkingLevel);

		// Apply model
		// 更新当前模型引用。
		this.agent.state.model = next.model;
		// 记录本次循环选择到当前会话分支。
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		// 按选项决定是否写全局默认模型。
		if (options.persist) {
			// 持久化供应商与 id。
			this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);
			// 保留非空模型范围中对持久默认的覆盖。
			this._addPersistedDefaultToNonEmptyScope(next.model);
		}

		// Apply thinking level for the new model.
		// - Explicit scoped model thinking level overrides defaults
		// - Per-model thinking level overrides take priority over the global default
		// setThinkingLevel clamps to model capabilities.
		// Model persistence does not implicitly rewrite the global thinking default.
		// 实际应用级别时再按模型能力钳制，不持久化全局思考默认。
		this.setThinkingLevel(thinkingLevel);

		// 通知模型循环变更，previousModel 是切换前值。
		await this._emitModelSelect(next.model, currentModel, "cycle");

		// 返回最终有效级别，不直接返回未钳制的范围偏好。
		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	/**
	 * 在全部可用模型快照中循环，不发起一次新的可用性刷新。
	 * 不足两项返回 undefined；其余更新模型/记录/思考级别并通知，可按 persist 保存默认。
	 * 例：backward 在首项回末项，返回 isScoped=false。
	 */
	private async _cycleAvailableModel(
		// 循环方向参数。
		direction: "forward" | "backward",
		// 是否保存默认的选项。
		options: ModelMutationOptions,
		// 返回切换结果或 undefined。
	): Promise<ModelCycleResult | undefined> {
		// 读取当前可用模型快照，避免每按一次快捷键都发刷新请求。
		const availableModels = this._modelRuntime.getAvailableSnapshot();
		// 不足两项不切换。
		if (availableModels.length <= 1) return undefined;

		// 记录旧模型选择。
		const currentModel = this.model;
		// 找当前选择在快照中的位置。
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		// 找不到按 0 作循环起点，与范围路径一致。
		if (currentIndex === -1) currentIndex = 0;
		// 记录候选总数。
		const len = availableModels.length;
		// 模运算实现双向环绕。
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		// 取下一候选模型。
		const nextModel = availableModels[nextIndex];

		// 没有显式范围级别，按目标模型配置/全局默认推导。
		const thinkingLevel = this._getThinkingLevelForModelSwitch(nextModel);
		// 修改 Agent 当前模型选择。
		this.agent.state.model = nextModel;
		// 追加可恢复的 model_change 历史。
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		// 只有 persist=true 写全局偏好。
		if (options.persist) {
			// 保存新模型供应商/id。
			this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
			// 按需补循环/启用配置；当前无 scope 时该辅助方法会立即返回。
			this._addPersistedDefaultToNonEmptyScope(nextModel);
		}

		// Apply thinking level for the new model.
		// Model persistence does not implicitly rewrite the global thinking default.
		// 应用级别但不联动持久化思考默认。
		this.setThinkingLevel(thinkingLevel);

		// 派发循环来源的扩展事件。
		await this._emitModelSelect(nextModel, currentModel, "cycle");

		// isScoped=false 标识来自全部可用快照。
		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves the clamped level to the session transcript only if the level actually changes.
	 * Persists the requested level to global defaults only when options.persist is true.
	 */
	/**
	 * 设置思考级别：先按当前模型支持项钳制，写 Agent，有变化才记录历史和派发事件。
	 * persist=true 保存的是用户请求的 level，有效级别可能不同；扩展事件用 void 启动，不在此等待完成。
	 * 例：目标模型不支持 high 时可落到支持级别，界面事件报告 effectiveLevel。
	 */
	setThinkingLevel(level: ThinkingLevel, options: ModelMutationOptions = {}): void {
		// 取得当前模型支持的候选级别列表。
		const availableLevels = this.getAvailableThinkingLevels();
		// 请求级别合法直接用，否则由兼容层按模型能力限制。
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		// 保存旧有效级别，供是否记录和扩展事件使用。
		const previousLevel = this.agent.state.thinkingLevel;
		// 仅比较有效值，不把请求偏好变化当必然实际改变。
		const isChanging = effectiveLevel !== previousLevel;

		// Agent 后续请求读取这个有效级别。
		this.agent.state.thinkingLevel = effectiveLevel;

		// 明确持久化时保存用户请求值，不用 effectiveLevel 替代。
		if (options.persist) {
			// 目标模型未来可能支持该请求级别，所以保存原始偏好。
			this.settingsManager.setDefaultThinkingLevel(level);
		}

		// 有效级别实际变化才追加历史/通知。
		if (isChanging) {
			// 记录当前分支实际采用的级别。
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			// 同步通知 UI/RPC 等公开观察者。
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			// void 明确不等待异步扩展事件，不代表同步派发完成。
			void this._extensionRunner.emit({
				// 扩展感知的思考选择事件名。
				type: "thinking_level_select",
				// 新有效值。
				level: effectiveLevel,
				// 切换前有效值。
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	/**
	 * 支持 reasoning 时向下一思考级别循环，调用设置路径并返回选择值；不支持则 undefined。
	 * 例：当前是列表最后一级，下一次回首级；可按 options 同步保存请求的全局默认。
	 */
	cycleThinkingLevel(options: ModelMutationOptions = {}): ThinkingLevel | undefined {
		// 模型不支持 reasoning 时不能循环，返回 undefined。
		if (!this.supportsThinking()) return undefined;

		// 取得按模型能力排列的可选级别。
		const levels = this.getAvailableThinkingLevels();
		// 查当前级别位置，找不到为 -1 时下一索引成为 0。
		const currentIndex = levels.indexOf(this.thinkingLevel);
		// 加一取模，末项回首项。
		const nextIndex = (currentIndex + 1) % levels.length;
		// 取本次请求的下一级别。
		const nextLevel = levels[nextIndex];

		// 经统一设置路径记录/通知及可选持久化。
		this.setThinkingLevel(nextLevel, options);
		// 返回选择项，不返回模型回答。
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	/**
	 * 返回当前模型允许的思考级别；尚无模型时返回全部选项的副本。
	 * 无 I/O，断言只协调兼容层类型。例：非推理模型通常只有 off，实际列表由 getSupportedThinkingLevels 决定。
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		// 没模型时返回全部选项副本，不把共享常量数组交出去。
		if (!this.model) return [...THINKING_LEVEL_OPTIONS];
		// 兼容层实际根据模型能力决定，as 仅协调 ThinkingLevel 类型。
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	/**
	 * 以当前模型 reasoning 字段的真假判断支持推理，返回 boolean。
	 * 例：未选择模型时 !!undefined 为 false；不检测远端服务的实时能力。
	 */
	supportsThinking(): boolean {
		// 可选链可得 undefined，!! 将其统一转成 boolean。
		return !!this.model?.reasoning;
	}

	/**
	 * 推导切换目标模型时的思考偏好：显式值 > 该模型配置 > 全局默认 > 当前值 > 默认常量。
	 * 返回待应用级别，不在这里钳制/写入。例：--models A:high 的 high 优先于 A 的配置；后续 setThinkingLevel 再按能力限制。
	 */
	private _getThinkingLevelForModelSwitch(targetModel?: Model<any>, explicitLevel?: ThinkingLevel): ThinkingLevel {
		// 显式值包括 off，只有 undefined 才允许回退。
		if (explicitLevel !== undefined) {
			// 直接返回显式偏好，后续统一设置方法负责钳制。
			return explicitLevel;
		}
		// Per-model default takes priority when switching to a model that has one
		// 有目标模型才读取该模型专属配置。
		if (targetModel) {
			// 按 provider/id 查模型思考默认，不混同不同供应商同名模型。
			const perModel = this.settingsManager.getModelThinkingLevel(targetModel.provider, targetModel.id);
			// 配置为 off 也属于明确值，应优先采用。
			if (perModel !== undefined) {
				// 返回目标模型偏好。
				return perModel;
			}
		}
		// 依次回退；当前 getter 的类型已是 ThinkingLevel，最后常量是沿用的兜底表达式。
		return this.settingsManager.getDefaultThinkingLevel() ?? this.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
	}

	/**
	 * 调用兼容层按模型能力钳制级别，无模型返回 off。
	 * _availableLevels 参数当前未使用，以下划线标示；例：传 high 时结果依据 model，而不是第二个数组参数直接查找。
	 */
	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		// 第二参数当前没参与计算；有模型委托 clamp，没模型固定 off。
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	/**
	 * 从设置同步低层插话/追问取出策略，返回 void；reload 后调用，不改现有队列内容。例：配置从 all 改为 one-at-a-time 后影响后续取消息。
	 */
	private syncQueueModesFromSettings(): void {
		// 从新设置更新 Agent 插话取出方式。
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		// 从新设置更新 Agent 追问取出方式。
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	/**
	 * 同时修改当前 Agent 和设置里的插话投递策略，返回 void。例：one-at-a-time 每次仅交一条插话，不改变已排队的正文。
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		// 实时策略立即供低层后续取队列使用。
		this.agent.steeringMode = mode;
		// 保存设置供后续会话/reload。
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	/**
	 * 同时修改当前 Agent 和设置里的追问投递策略，返回 void。例：all 让下一次取追问时取出全部等待项。
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		// 实时修改追问投递策略，不移动已有消息。
		this.agent.followUpMode = mode;
		// 保存追问策略设置。
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/** Generate Pi's built-in compaction summary for manual and automatic compaction. */
	/**
	 * 执行内置压缩摘要生成，输入预先算好的切点/历史、模型、自定义要求、信号和原因。
	 * 先解析实际摘要模型/认证，再调用 compaction.compact，复用流函数、环境、重试设置与通知；返回 CompactionResult。
	 * 例：切点位于一轮工具任务中部时，下层可分别总结旧历史和该轮前缀；这里不负责把结果存进会话。
	 */
	private async _runDefaultCompaction(
		// 已准备好的切点、旧消息和保留范围等数据。
		preparation: CompactionPreparation,
		// 选中的摘要模型，可能先经虚拟路由解析。
		model: Model<any>,
		// 可选摘要要求，undefined 使用默认摘要指令。
		customInstructions: string | undefined,
		// 当前摘要操作取消信号。
		signal: AbortSignal,
		// 原因给摘要重试事件带上上下文。
		reason: "manual" | "threshold" | "overflow",
		// 返回纯压缩结果，存储与 UI 事件由外层负责。
	): Promise<CompactionResult> {
		// Resolve the request only when Pi summarizes itself: routing may call models or fail.
		// 延迟到确实走内置方案时才解析认证/路由，扩展自供摘要无需该步骤。
		const request = await this._getSummarizationRequestAuth(model, signal);
		// 调用导入的 compact 函数，区别于本类 compact 方法。
		return compact(
			// 传预先准备的模型可见历史与切点。
			preparation,
			// 实际摘要物理模型，决定预算和输出限制。
			request.model,
			// 按流函数策略预解析或留空的 key。
			request.apiKey,
			// 可选请求头。
			request.headers,
			// 手动附加要求或默认 undefined。
			customInstructions,
			// 继续传取消信号。
			signal,
			// 路由后思考级别。
			request.thinkingLevel,
			// 沿用会话流函数，但不启动低层 Agent 消息/工具循环。
			this.agent.streamFunction,
			// 供应商环境覆盖。
			request.env,
			// 摘要重试预算/退避与会话设置一致，但执行独立重试流程。
			this.settingsManager.getRetrySettings(),
			// 把摘要重试通知转会话事件。
			this._summarizationRetryCallbacks({ source: "compaction", reason }),
			// 此处不传可选 sessionId；不据此推断自定义 streamFn 的缓存行为，摘要请求策略仍由下层实现决定。
			undefined, // sessionId
		);
	}

	/**
	 * 清除手动压缩控制器并尝试唤醒空闲等待者，返回 void。例：在 compaction_end 回调前清状态，回调提交新 prompt 不会误判手动压缩仍进行。
	 */
	private _clearManualCompactionState(): void {
		// 控制器存在性参与忙碌/提交检查，完成时先清除。
		this._compactionAbortController = undefined;
		// 状态变化后尝试完成空闲等待者。
		this._resolveIdleWaitIfIdle();
	}

	/**
	 * Manually compact the session context.
	 *
	 * This is the manual entry point used by `/compact`, RPC, and extensions. It is
	 * separate from automatic threshold/overflow compaction, which enters through
	 * `_checkCompaction()` and `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * Aborts the current agent operation first. Manual compaction never retries or
	 * continues the interrupted agent turn.
	 *
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	/**
	 * 手动压缩入口：先取消并等当前会话空闲，再准备历史、咨询扩展或调用内置摘要，保存压缩条目。
	 * 返回摘要结果和压缩前/后估算；会写会话、刷新投影及派发 start/end/扩展事件，失败通知后继续抛出；取消也会拒绝 Promise。
	 * 例：/compact 保留最近原文，其余转摘要；不会自动续跑刚被中断的用户任务。
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		// 先请求取消当前会话协调并等空闲；手动压缩不续跑刚取消的旧任务。
		await this.abort();
		// 创建本次手动摘要取消信号，同时让 isCompacting 和 prompt 检查看到忙碌。
		this._compactionAbortController = new AbortController();
		// 公开宣布手动压缩开始。
		this._emit({ type: "compaction_start", reason: "manual" });
		// 标记结果是否由扩展提供，保存条目及失败通知均会使用。
		let fromExtension = false;
		// 区分扩展主动 cancel 与其他失败。
		let cancelledByExtension = false;

		// 摘要、保存和通知都处于同一异常协调范围。
		try {
			// 读取这次开始时选择的模型。
			const model = this.model;
			// 手动压缩也需要模型，即使后面扩展可能提供结果。
			if (!model) {
				// 无模型给明确错误，catch 发失败通知后重新抛出。
				throw new Error(formatNoModelSelectedMessage());
			}

			// 按选择模型读取压缩设置，例如保留最近 token 预算。
			const settings = this.settingsManager.getCompactionSettings(model);
			// 只压当前根到叶分支，不将其他分支混入摘要。
			const pathEntries = this.sessionManager.getBranch();

			// 纯准备阶段算切点、需摘要消息、旧摘要与文件操作，不请求模型。
			const preparation = prepareCompaction(pathEntries, settings);
			// 无法生成有效准备数据时诊断原因。
			if (!preparation) {
				// Check why we can't compact
				// 检查当前分支最后一条，区别刚压缩与历史太小。
				const lastEntry = pathEntries[pathEntries.length - 1];
				// 末尾本来就是压缩条目，不再生成一份无新历史摘要。
				if (lastEntry?.type === "compaction") {
					// 抛 Already compacted 给手动调用者。
					throw new Error("Already compacted");
				}
				// 其余不可准备情况提示没有足够可压缩内容。
				throw new Error("Nothing to compact (session too small)");
			}

			// 先假定扩展未提供替代结果。
			let extensionCompaction: CompactionResult | undefined;

			// 只有存在压缩前处理器才派发拦截事件。
			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				// emit 的会话前事件结果在此断言为压缩专属结果，不做额外运行时 schema 校验。
				const result = (await this._extensionRunner.emit({
					// 手动/自动共享 session_before_compact 事件类别。
					type: "session_before_compact",
					// 预计算数据供扩展决定取消、自供摘要或沿用默认。
					preparation,
					// 提供原始当前分支条目参考。
					branchEntries: pathEntries,
					// 手动调用者的附加摘要要求。
					customInstructions,
					// 明确这次来源为 manual。
					reason: "manual",
					// 手动入口不会压缩后自动重试旧回答。
					willRetry: false,
					// 扩展也可观察用户取消信号。
					signal: this._compactionAbortController.signal,
					// 类型断言不等于检查了扩展返回对象的实际形状。
				})) as SessionBeforeCompactResult | undefined;

				// 扩展显式 cancel 优先，不再进入模型摘要。
				if (result?.cancel) {
					// 记为主动取消，catch 不输出普通失败文案。
					cancelledByExtension = true;
					// 手动取消仍通过拒绝 Promise 通知调用者。
					throw new Error("Compaction cancelled");
				}

				// 扩展可直接提供完整压缩结果，跳过内置模型摘要。
				if (result?.compaction) {
					// 保存扩展结果引用供下面统一取字段。
					extensionCompaction = result.compaction;
					// 来源标志写入条目和扩展后事件。
					fromExtension = true;
				}
			}

			// 下面两分支都会赋摘要，先声明待赋值变量。
			let summary: string;
			// 第一个保留原文的来源条目 id。
			let firstKeptEntryId: string;
			// 压缩前 token 记录值。
			let tokensBefore: number;
			// 可选摘要用量，后续统计包含该费用。
			let usage: Usage | undefined;
			// 详情可以是扩展自定义结构，因此 unknown。
			let details: unknown;

			// 有扩展结果就完全采用它，不隐式再请求默认摘要。
			if (extensionCompaction) {
				// Extension provided compaction content
				// 扩展提供摘要正文。
				summary = extensionCompaction.summary;
				// 扩展决定保留原文边界。
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				// 采用扩展报告的压缩前大小。
				tokensBefore = extensionCompaction.tokensBefore;
				// 采用扩展提供的可选用量。
				usage = extensionCompaction.usage;
				// 保留扩展附带详情。
				details = extensionCompaction.details;
			} else {
				// Shared default summary generator, also used by automatic compaction.
				// 扩展未提供则调用共享内置摘要请求路径。
				const result = await this._runDefaultCompaction(
					// 传准备阶段计算的数据。
					preparation,
					// 当前选定模型，在摘要请求准备中再处理虚拟路由。
					model,
					// 继续传手动附加要求。
					customInstructions,
					// 本次手动控制器信号。
					this._compactionAbortController.signal,
					// 来源传给摘要重试 UI。
					"manual",
				);
				// 取内置结果摘要。
				summary = result.summary;
				// 取内置切点对应保留边界。
				firstKeptEntryId = result.firstKeptEntryId;
				// 取准备时记录的 token 数。
				tokensBefore = result.tokensBefore;
				// 取内置摘要请求用量。
				usage = result.usage;
				// 取内置文件操作等详情。
				details = result.details;
			}

			// 摘要完成后还要检查取消，避免信号刚到仍提交结果。
			if (this._compactionAbortController.signal.aborted) {
				// 主动取消以相同异常路径清理状态。
				throw new Error("Compaction cancelled");
			}

			// 只追加压缩条目，原消息条目没有物理删除；投影决定之后发哪些消息。
			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			// 取全部保存条目，用于查摘要对应的压缩条目。
			const newEntries = this.sessionManager.getEntries();
			// 立刻把 Agent.messages 更新为摘要加保留原文等有效上下文。
			this._refreshFinalizedContext();
			// 用逐消息粗估给结果补压缩后大小，不混用旧回复用量。
			const estimatedTokensAfter = estimateMessagesTokens(this.sessionManager.buildSessionProjection().messages);

			// Get the saved compaction entry for the extension event
			// 按 type 与相同 summary 查第一条匹配记录，不保证它在多次相同摘要时必为刚追加那条。
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				// as 后接换行联合，表示查找结果可能为 CompactionEntry。
					| CompactionEntry
					// find 也可能 undefined，因此类型必须保留缺失分支。
					| undefined;

			// 确实取得压缩条目才派发后事件，沿用原有 runner 存在判断。
			if (this._extensionRunner && savedCompactionEntry) {
				// 等待扩展 session_compact 后处理。
				await this._extensionRunner.emit({
					// 压缩已完成的扩展事件名。
					type: "session_compact",
					// 传实际保存条目，带 id/时间等信息。
					compactionEntry: savedCompactionEntry,
					// 告知是否扩展自供摘要。
					fromExtension,
					// 本次手动触发。
					reason: "manual",
					// 本入口不自动续跑旧任务。
					willRetry: false,
				});
			}

			// 构造返回给 CLI/RPC/扩展的摘要结果，不包含会话条目 id。
			const compactionResult: CompactionResult = {
				// 摘要正文属性简写。
				summary,
				// 保留边界。
				firstKeptEntryId,
				// 压缩前大小。
				tokensBefore,
				// 刚估算的压缩后大小。
				estimatedTokensAfter,
				// 可选摘要用量。
				usage,
				// 实现相关详情。
				details,
			};
			// compaction_end listeners may submit queued prompts, so expose idle state before notifying them.
			// 先解除手动忙碌，再发 end，允许 end 订阅者提交新 prompt。
			this._clearManualCompactionState();
			// 向公开订阅者通知成功压缩。
			this._emit({
				// 压缩结束事件名。
				type: "compaction_end",
				// 手动原因。
				reason: "manual",
				// 携带上面整理的完整结果。
				result: compactionResult,
				// 成功路径非取消。
				aborted: false,
				// 不会自动恢复刚中止的用户任务。
				willRetry: false,
			});
			// 成功返回给调用方。
			return compactionResult;
			// 摘要/保存/后通知等异常统一进入失败协调。
		} catch (error) {
			// 规范化抛出值的可读说明。
			const message = error instanceof Error ? error.message : String(error);
			// 信号取消或扩展 cancel 都按 aborted=true 报告。
			const aborted = this._compactionAbortController.signal.aborted || cancelledByExtension;
			// 取消没有普通错误文案，真实失败加 Compaction failed 前缀。
			const errorMessage = aborted ? undefined : `Compaction failed: ${message}`;
			// 同样先清手动忙碌，再通知观察者。
			this._clearManualCompactionState();
			// 发公开失败/取消结束事件。
			this._emit({
				// 对应前面的 compaction_start。
				type: "compaction_end",
				// 保留 manual 原因。
				reason: "manual",
				// 失败没有压缩结果对象。
				result: undefined,
				// 报告取消判断。
				aborted,
				// 失败更不会恢复旧任务。
				willRetry: false,
				// 附可选失败文本。
				errorMessage,
			});
			// 扩展可另接收到失败信息。
			await this._emitSessionCompactFailed({
				// 手动原因。
				reason: "manual",
				// 取消可为 undefined 的错误描述。
				errorMessage,
				// 取消标志。
				aborted,
				// 无恢复重试。
				willRetry: false,
				// 已经决定的结果来源标志。
				fromExtension,
			});
			// 保留原异常交手动调用方，通知并不代替失败结果。
			throw error;
			// 最终再清理一次，覆盖正常/异常/通知回调抛错等路径。
		} finally {
			// 清状态并检查空闲等待。
			this._clearManualCompactionState();
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	/**
	 * 请求取消手动与自动压缩，返回 void；控制器不存在时可选调用无动作。
	 * 例：用户取消等待摘要的请求；这里只发信号，不立即清状态或删除已保存条目。
	 */
	abortCompaction(): void {
		// 有手动控制器才发 abort，不立即更改保存历史。
		this._compactionAbortController?.abort();
		// 自动摘要也接收同一取消入口。
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	/**
	 * 请求取消分支摘要/导航准备中的操作，返回 void。例：generateBranchSummary 读取该信号，清理状态由 navigateTree 的 finally 负责。
	 */
	abortBranchSummary(): void {
		// 只取消分支导航摘要控制器，不混改手动/自动压缩控制器。
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Dispatch automatic compaction after `agent_end` or before prompt submission.
	 * Manual compaction does not call this method; it enters through `compact()`.
	 *
	 * Automatic cases:
	 * 1. Overflow with retry: a context-overflow error or recoverable length stop;
	 *    remove the failed assistant message, compact, and retry the turn once.
	 * 2. Overflow without retry: a successful response exceeded the configured
	 *    context window; compact but preserve the completed response.
	 * 3. Threshold without retry: valid or estimated context usage crossed the
	 *    configured threshold; compact without retrying the completed response.
	 *
	 * Each case calls `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, that method calls the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 * @returns Whether the post-run loop should call `agent.continue()` for overflow recovery or queued messages
	 */
	/**
	 * 根据一条回复判断自动压缩和溢出恢复，返回外层是否继续 Agent 的布尔值。
	 * 先过滤禁用/取消/旧压缩用量，再区分显式溢出、可恢复截断和阈值；尊重上下文编辑后的投影，不把旧用量当当前大小。
	 * 副作用可能隐去失败调用/结果并调用自动摘要。例：上下文溢出仅做一次压缩后重试；已正常 stop 的超窗口回复只压缩，不重复回答。
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		// 采用当前选择对应的自动压缩策略。
		const settings = this.settingsManager.getCompactionSettings(this.model);
		// 关闭自动压缩则直接 false；这不是手动 compact 的 enabled 限制。
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		// 默认略过用户取消回复；新 prompt 前显式 false 会包含旧取消回复作阈值检查。
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model. Under a virtual selection, the
		// physical model that produced the message supplies the limits.
		// 确定这条回复的物理限制模型，普通切换后的旧模型回复可能不匹配。
		const messageModel = this._modelForMessage(assistantMessage);
		// 只有能确定对应模型，才做它自己的溢出/长度恢复。
		const sameModel = messageModel !== undefined;
		// 限制优先该回复对应模型，缺失退当前模型，仍无则 0。
		const contextWindow = (messageModel ?? this.model)?.contextWindow ?? 0;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		// 取当前分支最新压缩边界，避免用压缩前用量再次触发。
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		// 比较回复时间与压缩条目时间，等于边界也视为边界前。
		const assistantIsFromBeforeCompaction =
			// 压缩条目时间是字符串，转 Date 毫秒与消息数字时间比较。
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		// 旧回复的窗口/错误已经被后一次压缩处理，不重复恢复。
		if (assistantIsFromBeforeCompaction) {
			// 跳过旧回复全部自动压缩检查。
			return false;
		}

		// Automatic cases 1 and 2: context overflow.
		// A length stop is recoverable when output ended below the model's original desired limit,
		// independent of the configured context size or any context-clamped provider request limit.
		// 权威投影可能经过 context_edit，不能只看 Agent 原始消息。
		const currentProjection = this.sessionManager.buildSessionProjection();
		// 找到 assistant 对应来源，后面判断是否仍保留。
		const assistantEntryId = this._findPersistedMessageEntryId(assistantMessage);
		// 缺来源先按可考虑处理，否则检查来源是否仍贡献 assistant。
		const assistantIsProjected =
			// 无法定位来源时沿用原处理，不把它直接当已经隐去。
			assistantEntryId === undefined ||
			// 检查投影中各来源条目。
			currentProjection.entries.some(
				// 谓词跨多行同时要求来源 id 与角色匹配。
				(entry) =>
					// 必须是该 assistant 的同一来源条目。
					entry.sourceEntry.id === assistantEntryId &&
					// 且这条来源投影仍含 assistant，而非已被删除或替换成别角色。
					entry.messages.some((message) => message.role === "assistant"),
			);
		// 取得当前分支完整原始因果路径。
		const branch = this.sessionManager.getBranch();
		// 找来源条目下标，找不到为 -1。
		const assistantIndex = assistantEntryId ? branch.findIndex((entry) => entry.id === assistantEntryId) : -1;
		// 只看回复之后的事件；不把更早编辑视作这条回复之后的失效原因。
		const entriesAfterAssistant = assistantIndex >= 0 ? branch.slice(assistantIndex + 1) : [];
		// 任意后续 context_edit 都可能改变该回复统计过的上下文。
		const hasPostAssistantContextEdit = entriesAfterAssistant.some((entry) => entry.type === "context_edit");
		// 找专门指向该 assistant 的最后一次编辑。
		const latestAssistantEdit = entriesAfterAssistant
			// filter 把匹配编辑提出来，后面的 at(-1) 取最新。
			.filter(
				// 类型谓词使结果收窄为 ContextEditEntry 数组。
				(entry): entry is ContextEditEntry => entry.type === "context_edit" && entry.targetId === assistantEntryId,
			)
			// .at(-1) 没元素返回 undefined。
			.at(-1);
		// 显式错误恢复还要确认后面没有压缩或明确省略本条回复。
		const assistantRetainedForExplicitRecovery =
			// 无法定位来源时仍允许按原错误尝试恢复。
			assistantEntryId === undefined ||
			// 后面已有压缩说明这次错误已过边界，不再处理。
			(!entriesAfterAssistant.some((entry) => entry.type === "compaction") &&
				// 最新 replacement=null 表示已显式省略，不应重复恢复。
				latestAssistantEdit?.replacement !== null);
		// 统计只在消息仍可见且之后没有任何上下文编辑时直接匹配当前投影。
		const assistantUsageMatchesProjection = assistantIsProjected && !hasPostAssistantContextEdit;
		// 先识别 error 文案明确说上下文溢出，区别仅按 usage 超窗口判断。
		const explicitOverflow = assistantMessage.stopReason === "error" && isContextOverflow(assistantMessage);
		// 组合显式错误与用量溢出的不同前提。
		const contextOverflow =
			// 只有与当前普通选择或可查虚拟物理模型匹配才恢复。
			sameModel &&
			// 显式溢出要保留到需要恢复的阶段。
			((explicitOverflow && assistantRetainedForExplicitRecovery) ||
				// 用量超窗口则还要求这份用量没有被后续编辑改旧。
				(assistantUsageMatchesProjection && isContextOverflow(assistantMessage, contextWindow)));
		// 长度恢复是另一种情况：输出被截断且没达到模型原始期望输出上限。
		const recoverableLength =
			// 要求同模型且 assistant 仍投影，再以模型 maxTokens 判断，不用被上下文钳小后的请求上限。
			sameModel && assistantIsProjected && isRecoverableLength(assistantMessage, messageModel.maxTokens);
		// 两种异常都走一次压缩恢复协调。
		if (contextOverflow || recoverableLength) {
			// 正常 stop 的回复已完成，不重试这条回复；压缩后若仍有队列消息，外层仍可继续处理那些新输入。
			const willRetry = assistantMessage.stopReason !== "stop";

			// Case 2: the response completed successfully. Compact, but do not retry because
			// agent.continue() cannot continue from a completed assistant response.
			// 成功回复仅整理后续上下文，不删除/重发已完成回复。
			if (!willRetry) {
				// 以 overflow 原因压缩，willRetry=false。
				return await this._runAutoCompaction("overflow", false);
			}

			// 同一问题已试过压缩恢复，就不无限重试。
			if (this._overflowRecoveryAttempted) {
				// 根据溢出还是长度截断选择最终失败说明。
				const errorMessage = contextOverflow
					? // 上下文仍溢出时给减少上下文/换大模型建议。
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
					: // 长度仍截断时说明恢复失败。
						"Truncated response recovery failed after one compact-and-retry attempt.";
				// 这里只补结束错误事件，没有再次开启压缩。
				this._emit({
					// 公开压缩结束事件。
					type: "compaction_end",
					// 仍属 overflow 恢复路径。
					reason: "overflow",
					// 没有新压缩结果。
					result: undefined,
					// 这是恢复失败，不是取消。
					aborted: false,
					// 停止继续重试。
					willRetry: false,
					// 附最终失败文案。
					errorMessage,
				});
				// 也通知扩展本次恢复失败。
				await this._emitSessionCompactFailed({
					// overflow 原因。
					reason: "overflow",
					// 同样的失败文案。
					errorMessage,
					// 非取消。
					aborted: false,
					// 不再恢复。
					willRetry: false,
					// 没有扩展新结果参与这次拒绝。
					fromExtension: false,
				});
				// 返回 false，让外层不要再 continue 恢复同一异常。
				return false;
			}

			// Persistently omit the selected final attempt before post-run recovery compaction.
			// 在尝试恢复前先占用“一次恢复”标记。
			this._overflowRecoveryAttempted = true;
			// 成对持久隐去失败回复及工具结果，原历史可保留审查。
			this._omitRecoveryAttempt(assistantMessage);
			// 自动压缩返回是否可继续，可能因为无内容/取消/失败而 false。
			const retry = await this._runAutoCompaction("overflow", willRetry);
			// 确实会继续时，保存失败回复给下一次路由选择。
			if (retry) this._failedResponse = assistantMessage;
			// 将是否继续传给外层协调循环。
			return retry;
		}

		// Case 3: threshold compaction without retry.
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		// 阈值判断用的 token 数由后续分支赋值。
		let contextTokens: number;
		// 复用已算投影，避免反复构建。
		const projection = currentProjection;
		// 投影含上下文编辑来源时，按投影重估而非盲信旧用量。
		const hasContextEdits = projection.entries.some((entry) => entry.sourceEntry.type === "context_edit");
		// 有 usage 就按供应商 total 或分项计算，无则 0。
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		// 编辑可能使上下文变大/变小，优先用会识别失效用量的投影估算。
		if (hasContextEdits) {
			// 对当前投影和原分支一起估算。
			contextTokens = estimateProjectedContextTokens(projection, branch).tokens;
			// error 或全零用量，不能拿这条回复直接统计窗口占用。
		} else if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			// 读取当前 Agent 已完成消息。
			const messages = this.agent.state.messages;
			// 从最近有效回复用量加其后消息体积；没有用量则纯体积估算。
			const estimate = estimateContextTokens(messages);
			// Without provider usage, estimate.tokens is the pure message-size estimate.
			// Only usage-backed estimates need the stale pre-compaction check.
			// 只有确实借用了某条回复 usage 才检查它是否旧于压缩。
			if (estimate.lastUsageIndex !== null) {
				// Verify the usage source is post-compaction. Kept pre-compaction messages
				// have stale usage reflecting the old (larger) context and would falsely
				// trigger compaction right after one just finished.
				// 取得提供 usage 的消息。
				const usageMsg = messages[estimate.lastUsageIndex];
				// 下面同时要求存在压缩、来源为 assistant、时间不晚于压缩。
				if (
					// 没有压缩边界就不做旧用量排除。
					compactionEntry &&
					// 确保按 assistant 时间字段判断。
					usageMsg.role === "assistant" &&
					// 旧于最新压缩的 usage 反映压缩前大历史，不应用来马上重压。
					(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
				) {
					// 没有可靠的压缩后使用量来源时跳过这次阈值压缩。
					return false;
				}
			}
			// 可信估算采用 usage 加尾部或纯体积的结果。
			contextTokens = estimate.tokens;
		} else {
			// 正常有效直接用量且无编辑影响时直接采用它。
			contextTokens = directContextTokens;
		}
		// 按 enabled、窗口和 reserveTokens 统一判阈值。
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			// 超过阈值只为后续整理上下文，不重试已完成回复。
			return await this._runAutoCompaction("threshold", false);
		}
		// 所有条件均不触发时，不要求外层继续。
		return false;
	}

	/**
	 * Execute threshold or overflow compaction. Manual compaction uses
	 * `AgentSession.compact()` instead. Both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts` after preparation and extension
	 * interception.
	 *
	 * @param reason Automatic trigger selected by `_checkCompaction()`
	 * @param willRetry Whether to continue the interrupted turn after overflow compaction
	 * @returns Whether the post-run loop should call `agent.continue()`
	 */
	/**
	 * 执行自动阈值或溢出压缩，返回是否需要续跑恢复任务或投递队列。
	 * 准备不足/无模型返回 false；扩展可取消/提供摘要，否则内置模型摘要；保存条目、刷新上下文、发事件；错误转换通知并返回 false。
	 * 例：threshold 压缩成功但有追问在等，返回 true 继续处理追问；与手动入口不同，此处捕获失败而非向外重新抛出。
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		// 本次开始时的模型选择快照。
		const model = this.model;
		// 读取该选择的压缩设置，传给准备函数决定保留范围。
		const settings = this.settingsManager.getCompactionSettings(model);
		// 控制器在准备成功之后才创建，提前失败可仍 undefined。
		let abortController: AbortController | undefined;
		// 只有发布过 start 才需要相配 end/失败通知。
		let started = false;
		// 记录是否采用扩展摘要。
		let fromExtension = false;
		// 扩展显式取消单独计入 aborted。
		let cancelledByExtension = false;

		// 自动流程吞掉异常转 false，但仍做事件/清理。
		try {
			// 未选模型不进入自动摘要。
			if (!model) {
				// 无模型返回不续跑。
				return false;
			}

			// 只取当前分支历史。
			const pathEntries = this.sessionManager.getBranch();
			// 纯准备切点和摘要输入，不发网络请求。
			const preparation = prepareCompaction(pathEntries, settings);
			// 太小或刚压过无需/无法准备时返回。
			if (!preparation) {
				// 不宣布 start，也不会伪造结束事件。
				return false;
			}

			// 数据准备好才建立本次取消范围。
			abortController = new AbortController();
			// 公开保存控制器，让 abort/isCompacting 可感知。
			this._autoCompactionAbortController = abortController;
			// 已经进入实际压缩阶段。
			started = true;
			// 通知公开观察者开始及原因。
			this._emit({ type: "compaction_start", reason });
			// start 监听器可能同步取消，立即检查，不继续执行扩展/模型。
			abortController.signal.throwIfAborted();

			// 可选扩展替代结果，默认 undefined。
			let extensionCompaction: CompactionResult | undefined;

			// 存在压缩前监听器才执行扩展链。
			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				// 等 session_before_compact 决定，结果做 TS 类型断言。
				const extensionResult = (await this._extensionRunner.emit({
					// 与手动相同事件类型。
					type: "session_before_compact",
					// 准备好的摘要输入/保留边界。
					preparation,
					// 当前分支条目供扩展参考。
					branchEntries: pathEntries,
					// 自动路径没有手动附加摘要要求。
					customInstructions: undefined,
					// threshold 或 overflow 原因。
					reason,
					// 告诉扩展是否打算恢复失败回合。
					willRetry,
					// 本次自动取消信号。
					signal: abortController.signal,
					// 未返回结果允许 undefined。
				})) as SessionBeforeCompactResult | undefined;

				// 扩展 cancel 优先停止，不生成内置摘要。
				if (extensionResult?.cancel) {
					// 记录取消来源用于失败/取消事件。
					cancelledByExtension = true;
					// 进入统一 catch 以发布 aborted 结束。
					throw new Error("Compaction cancelled");
				}

				// 有替代 compaction 就采用它。
				if (extensionResult?.compaction) {
					// 保存扩展结果供下面提字段。
					extensionCompaction = extensionResult.compaction;
					// 来源标为扩展。
					fromExtension = true;
				}
			}
			// 异步扩展执行中用户可能取消，模型调用前再次检查。
			abortController.signal.throwIfAborted();

			// 两条摘要路径共享的正文变量。
			let summary: string;
			// 保留原文起点。
			let firstKeptEntryId: string;
			// 压缩前 token 数。
			let tokensBefore: number;
			// 可选摘要用量。
			let usage: Usage | undefined;
			// 具体实现的详情，可能任意扩展结构。
			let details: unknown;

			// 扩展自供结果，无需调用默认模型摘要。
			if (extensionCompaction) {
				// Extension provided compaction content
				// 采用扩展正文。
				summary = extensionCompaction.summary;
				// 采用扩展保留边界。
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				// 采用扩展报告大小。
				tokensBefore = extensionCompaction.tokensBefore;
				// 采用扩展可选用量。
				usage = extensionCompaction.usage;
				// 采用扩展详情。
				details = extensionCompaction.details;
			} else {
				// Shared default summary generator, also used by manual compaction.
				// 否则使用与手动相同的内置生成函数。
				const compactResult = await this._runDefaultCompaction(
					// 预计算准备数据。
					preparation,
					// 选中的模型，内部再解析物理路由。
					model,
					// 无自定义指令。
					undefined,
					// 自动压缩取消信号。
					abortController.signal,
					// 传原触发原因给重试 UI。
					reason,
				);
				// 取内置摘要正文。
				summary = compactResult.summary;
				// 取原文保留点。
				firstKeptEntryId = compactResult.firstKeptEntryId;
				// 取压缩前估算。
				tokensBefore = compactResult.tokensBefore;
				// 取摘要用量。
				usage = compactResult.usage;
				// 取内置详情。
				details = compactResult.details;
			}
			// 生成完成后再确认未被取消，才允许保存。
			abortController.signal.throwIfAborted();

			// 追加摘要条目，旧历史仍保留，之后投影裁选有效上下文。
			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			// 取全部已保存条目，下面按摘要查条目。
			const newEntries = this.sessionManager.getEntries();
			// 刷新 Agent.messages 为新投影。
			this._refreshFinalizedContext();
			// 估算压缩后模型消息大小，供返回结果与 UI 显示。
			const estimatedTokensAfter = estimateMessagesTokens(this.sessionManager.buildSessionProjection().messages);

			// Get the saved compaction entry for the extension event
			// find 按相同正文取首个 compaction；正文重复时不保证该项必是最新。
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				// 断言查找结果为压缩条目或缺省。
					| CompactionEntry
					// undefined 是 find 未匹配时的真实可能结果。
					| undefined;

			// 有真实保存条目才派发扩展压缩后事件。
			if (this._extensionRunner && savedCompactionEntry) {
				// 等待扩展后处理。
				await this._extensionRunner.emit({
					// 通知已完成的压缩。
					type: "session_compact",
					// 给实际条目 id/时间/摘要等。
					compactionEntry: savedCompactionEntry,
					// 报告摘要来源。
					fromExtension,
					// 报告 threshold/overflow。
					reason,
					// 报告本次计划是否恢复原回合。
					willRetry,
				});
			}

			// 构造本次压缩结果对象。
			const result: CompactionResult = {
				// 生成/扩展提供的正文。
				summary,
				// 保留原文起点。
				firstKeptEntryId,
				// 压缩前估算或扩展值。
				tokensBefore,
				// 当前投影重新估算的大小。
				estimatedTokensAfter,
				// 摘要用量。
				usage,
				// 摘要详情。
				details,
			};
			// 公开成功结束事件；自动控制器要到 finally 才清。
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			// 原本需要恢复失败回合，压缩成功后允许 continue。
			if (willRetry) return true;

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			// 不重试旧回复时，只为仍排队的消息再继续一次。
			return this.agent.hasQueuedMessages();
			// 自动失败转事件加 false，不像手动入口重新抛出。
		} catch (error) {
			// Error 取 message，非 Error 用固定兜底说明。
			const message = error instanceof Error ? error.message : "compaction failed";
			// 信号或扩展主动取消都标 aborted。
			const aborted = abortController?.signal.aborted === true || cancelledByExtension;
			// 仅已宣布开始的压缩补结束，准备失败不伪造生命周期。
			if (started) {
				// 取消不附普通失败说明；其余按触发原因给不同提示。
				const errorMessage = aborted
					? // 取消对应 undefined。
						undefined
					: // overflow 恢复失败与普通阈值失败分开命名。
						reason === "overflow"
						? // 窗口恢复失败的可读说明。
							`Context overflow recovery failed: ${message}`
						: // 普通自动压缩失败的说明。
							`Auto-compaction failed: ${message}`;
				// 向 UI/RPC 发结束事件。
				this._emit({
					// 对应本次开始。
					type: "compaction_end",
					// 保留原触发原因。
					reason,
					// 失败没有结果。
					result: undefined,
					// 取消标志。
					aborted,
					// 失败后不要求继续恢复。
					willRetry: false,
					// 可选错误文字。
					errorMessage,
				});
				// 扩展收到相同失败信息。
				await this._emitSessionCompactFailed({
					// 原触发原因。
					reason,
					// 可选错误说明。
					errorMessage,
					// 是否取消。
					aborted,
					// 不再恢复。
					willRetry: false,
					// 失败前是否采用扩展提供结果。
					fromExtension,
				});
			}
			// 不继续，让外层终止此自动恢复路径。
			return false;
			// 自动状态清理无论成功/提前返回/异常都执行。
		} finally {
			// 只清本次对应控制器，避免误清后续操作替换的引用。
			if (this._autoCompactionAbortController === abortController) {
				// 释放自动压缩 busy 标记。
				this._autoCompactionAbortController = undefined;
			}
			// 若整个会话现在确实空闲，唤醒等待者。
			this._resolveIdleWaitIfIdle();
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	/**
	 * 保存自动压缩 enabled 开关，返回 void，不立即执行压缩。例：关闭后 shouldCompact 和 _checkCompaction 会据设置跳过自动路径，手动 compact 仍有独立入口。
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		// 只保存 enabled 设置，不当场调用模型。
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	/**
	 * 读取自动压缩设置开关，无副作用。例：UI 用它展示是否开启，不说明此刻正在压缩。
	 */
	get autoCompactionEnabled(): boolean {
		// 从设置管理器读取 enabled。
		return this.settingsManager.getCompactionEnabled();
	}

	/**
	 * 绑定宿主提供的 UI、运行模式、命令操作、取消/退出和错误回调，然后发 session_start 并收扩展资源。
	 * 只更新传入的非 undefined 绑定，返回 Promise<void>；可能运行扩展回调与加载资源。
	 * 例：交互模式在建立界面后把 uiContext 交给同一会话，而 print 模式可绑定不同能力。
	 */
	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		// 只更新明确提供的 UI 绑定；undefined 不是清空操作。
		if (bindings.uiContext !== undefined) {
			// 保存 UI 上下文供当前和后续新 runner 使用。
			this._extensionUIContext = bindings.uiContext;
		}
		// 模式也仅在调用方明确传入时覆盖。
		if (bindings.mode !== undefined) {
			// 保存扩展模式，不切换实际宿主输入输出层。
			this._extensionMode = bindings.mode;
		}
		// 命令专属操作可在 UI 就绪后追加绑定。
		if (bindings.commandContextActions !== undefined) {
			// 保存供 runner 创建命令 ctx 时使用。
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		// 有自定义取消操作才替换原回调。
		if (bindings.abortHandler !== undefined) {
			// 保存宿主取消入口。
			this._extensionAbortHandler = bindings.abortHandler;
		}
		// 有退出操作才更新。
		if (bindings.shutdownHandler !== undefined) {
			// 保存宿主 shutdown 行为。
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		// 有错误监听才更新。
		if (bindings.onError !== undefined) {
			// 保存统一扩展错误展示函数。
			this._extensionErrorListener = bindings.onError;
		}

		// 将以上保存成员真正接到当前 runner。
		this._applyExtensionBindings(this._extensionRunner);
		// 派发本次 session_start 元数据，不在构造器直接发。
		await this._extensionRunner.emit(this._sessionStartEvent);
		// 让 runner 报告还没被扩展接管的 MCP 服务。
		this._extensionRunner.reportUnhandledMcpServers();
		// 仅 reload 原因传 reload，其他启动原因在资源发现阶段都按 startup。
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	/**
	 * 启动或 reload 后询问 resources_discover 扩展，再加载其技能/模板/主题并重建基础提示词。
	 * 没有监听器或全部路径为空时提前返回；不在此重新加载所有扩展。例：扩展提供 /tmp/review/SKILL.md，使后续技能查找可见。
	 */
	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		// 没有 resources_discover 监听器，不做无意义发现工作。
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			// 提前结束，不触碰当前资源。
			return;
		}

		// 接收三种资源路径与各自扩展来源。
		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			// 把会话工作目录提供给发现处理器。
			this._cwd,
			// 给 startup 或 reload 原因。
			reason,
		);

		// 三个路径列表都空就没有资源需要扩展加载。
		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			// 不无故重建提示词。
			return;
		}

		// 把发现结果转成加载器需要的路径+元数据结构。
		const extensionPaths: ResourceExtensionPaths = {
			// 技能来源路径保留每个扩展的定位基准。
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			// 提示词模板同样包装。
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			// 主题同样包装。
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		// 加载器把临时扩展资源并入当前资源集合，实际解析在资源加载器中。
		this._resourceLoader.extendResources(extensionPaths);
		// 技能/上下文等变化后刷新基础提示词，选中工具保持当前集合。
		this._rebuildSystemPrompt(this.getActiveToolNames());
	}

	/**
	 * 把扩展报告的路径附上临时资源来源元数据，返回新数组，不读取文件。
	 * 普通扩展以文件目录作 baseDir，合成路径没有物理 baseDir。例：/a/ext.ts 提供相对资源时，以 /a 为定位基准交给加载器。
	 */
	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		// 资源路径原样保留。
		path: string;
		// 临时/顶层是资源加载来源分类，不是 TypeScript 模块作用域。
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
		// 返回数组元素类型声明结束，下面 map 才生成实际对象。
	}> {
		// 每条输入映射成独立的新资源描述对象。
		return entries.map((entry) => {
			// 生成可读 extension:名字 标签。
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			// 合成扩展无物理目录；真实路径用 dirname 作相对资源基准。
			const baseDir = isSyntheticPath(entry.extensionPath) ? undefined : dirname(entry.extensionPath);
			// 构造加载器描述对象。
			return {
				// 扩展报告的资源路径。
				path: entry.path,
				// 附来源信息方便诊断/展示。
				metadata: {
					// 可读扩展来源标签。
					source,
					// temporary 表示本次扩展发现资源，不写持久安装配置。
					scope: "temporary",
					// top-level 表示顶层来源类别。
					origin: "top-level",
					// 可选物理基准目录。
					baseDir,
				},
			};
		});
	}

	/**
	 * 由扩展路径生成展示来源标签，返回字符串，无 I/O。
	 * 合成路径去尖括号，普通路径取 basename 并移除 .ts/.js。例：/a/review.ts → extension:review；不保证不同目录的同名扩展标签唯一。
	 */
	private getExtensionSourceLabel(extensionPath: string): string {
		// 合成路径如 <sdk:...> 与实际文件路径分流。
		if (isSyntheticPath(extensionPath)) {
			// 去掉尖括号用于标签，不读文件。
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		// 真实扩展取最后一段文件名。
		const base = basename(extensionPath);
		// 仅去末尾 .ts/.js，正则区分大小写。
		const name = base.replace(/\.(ts|js)$/, "");
		// 返回展示标签，不生成唯一 id。
		return `extension:${name}`;
	}

	/**
	 * 将保存的 UI/命令绑定应用到某个 runner，并替换扩展错误订阅，返回 void。
	 * 先退旧错误监听再装新监听；例：reload 换 runner 后仍沿用宿主错误展示回调，不重复订阅旧 runner。
	 */
	private _applyExtensionBindings(runner: ExtensionRunner): void {
		// 把保存的 UI 上下文和模式传给 runner。
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		// 绑定命令专属控制能力。
		runner.bindCommandContext(this._extensionCommandContextActions);

		// 先撤销旧错误订阅，?.() 允许尚无订阅。
		this._extensionErrorUnsubscriber?.();
		// 根据是否有错误监听来建立新订阅。
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? // onError 返回退订函数，供下一次/重载替换。
				runner.onError(this._extensionErrorListener)
			: // 没有监听器时清为 undefined。
				undefined;
	}

	/**
	 * 目录注册变化后按当前 provider/id 查新模型对象，有新引用才更新 Agent 选择。
	 * 返回 void，不改历史、不重新认证。例：扩展重注册模型改变 baseUrl 后，同 id 选择引用可换成新目录项；查不到则保留原选择。
	 */
	private _refreshCurrentModelFromRegistry(): void {
		// 读当前选择快照，未选无需刷新。
		const currentModel = this.model;
		// 没有模型时不凭注册变化替用户选择模型。
		if (!currentModel) {
			// 提前结束。
			return;
		}

		// 按相同 provider/id 查目录的新对象，虚拟模型也由统一运行时解析目录项。
		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		// 查不到或引用未变，不做无意义赋值。
		if (!refreshedModel || refreshedModel === currentModel) {
			// 不自动切到其他候选。
			return;
		}

		// 只更新对象引用，不追加新的 model_change 或触发 model_select。
		this.agent.state.model = refreshedModel;
	}

	/**
	 * 把会话操作接成扩展 runtime、普通上下文和供应商注册三组回调，返回 void。
	 * 包含消息/工具/模型/思考/压缩/命令/元数据能力；只在回调实际执行时做相应工作。
	 * 例：pi.sendMessage 内部启动异步发送并 catch 上报，ctx.compact 使用完成/失败回调；不能把所有回调都理解成同步执行完毕。
	 */
	private _bindExtensionCore(runner: ExtensionRunner): void {
		// 局部命令列表回调每次读取当前 runner/资源，不保存陈旧快照。
		const getCommands = (): SlashCommandInfo[] => {
			// 把已注册扩展命令转换为公共斜杠命令信息。
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				// 使用 invocationName，允许 runner 处理命令冲突/命名。
				name: command.invocationName,
				// 扩展自带描述可缺省。
				description: command.description,
				// 标记来源类别为 extension。
				source: "extension",
				// 保留真实/合成来源元数据。
				sourceInfo: command.sourceInfo,
			}));

			// 提示词模板同样成为可发现斜杠命令。
			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				// 模板命令名。
				name: template.name,
				// 模板说明。
				description: template.description,
				// 来源类别为 prompt，而非可执行扩展 handler。
				source: "prompt",
				// 模板文件来源信息。
				sourceInfo: template.sourceInfo,
			}));

			// 当前技能也转成命令列表项。
			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				// 技能采用 skill: 前缀，与同名模板/扩展命令区别。
				name: `skill:${skill.name}`,
				// 技能发现元数据的描述。
				description: skill.description,
				// 来源类别为 skill。
				source: "skill",
				// 技能来源信息。
				sourceInfo: skill.sourceInfo,
			}));

			// 按扩展、模板、技能拼成新数组，不在此处理调用优先级。
			return [...extensionCommands, ...templates, ...skills];
		};

		// 给 runner 分别绑定扩展 API 动作、上下文动作、供应商/虚拟模型注册动作。
		runner.bindCore(
			{
				// 扩展 pi.sendMessage 是 fire-and-report 风格的绑定，不直接把 Promise 返回扩展。
				sendMessage: (message, options) => {
					// 启动发送并显式接 catch，避免异步失败无人接收。
					this.sendCustomMessage(message, options).catch((err) => {
						// 失败通过 runner 错误监听渠道显示。
						runner.emitError({
							// 内部绑定产生的错误使用 runtime 合成来源。
							extensionPath: "<runtime>",
							// 指出失败动作是 send_message。
							event: "send_message",
							// 把错误转成文字；这里不做内容脱敏。
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				// 用户角色发送也用同样异步报告方式绑定。
				sendUserMessage: (content, options) => {
					// 通过会话 prompt 完整处理，异常在 catch 中报告。
					this.sendUserMessage(content, options).catch((err) => {
						// 向扩展错误监听器报告。
						runner.emitError({
							// 内部运行时来源。
							extensionPath: "<runtime>",
							// 区别于 custom 消息发送失败。
							event: "send_user_message",
							// 使用 Error.message 或字符串化抛出值。
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				// 扩展可追加程序化条目，不自动作为用户模型正文。
				appendEntry: (customType, data) => {
					// 会话管理器返回新 id。
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					// 用 id 读取完整条目。
					const entry = this.sessionManager.getEntry(entryId);
					// 找到保存结果才发公开通知。
					if (entry) {
						// 告知 UI/RPC 会话树多了条目。
						this._emit({ type: "entry_appended", entry });
					}
				},
				// 会话命名复用统一保存/通知入口。
				setSessionName: (name) => {
					// 避免扩展与 UI 各自实现不同命名行为。
					this.setSessionName(name);
				},
				// 提供当前名称读取函数，每次获取实时值。
				getSessionName: () => {
					// 直接从 manager 读取最终显示名。
					return this.sessionManager.getSessionName();
				},
				// 扩展可给已有条目标注/去标注，参数类型允许的清除规则由 manager 处理。
				setLabel: (entryId, label) => {
					// 标签变更是追加记录，不直接改旧条目正文。
					this.sessionManager.appendLabelChange(entryId, label);
				},
				// 返回当前模型可见激活名，而非注册表全体。
				getActiveTools: () => this.getActiveToolNames(),
				// 返回全部工具定义信息，包括非激活项。
				getAllTools: () => this.getAllTools(),
				// 返回设置管理器提供的设置快照/合并结果。
				getSettings: () => this.settingsManager.getSettings(),
				// 激活变更复用统一工具/提示词重建流程。
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				// 重新读取扩展注册工具，MCP 连接/动态注册后可刷新。
				refreshTools: () => this._refreshToolRegistry(),
				// 传上面构造的命令发现回调。
				getCommands,
				// 扩展模型切换返回 boolean，先做较轻的已配置认证判断。
				setModel: async (model) => {
					// 没有配置就 false，不调用 setModel 的异步检查路径。
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					// 有配置再真正校验并切模型，失败仍可抛异常。
					await this.setModel(model);
					// 成功结束返回 true，不是远端模型回答成功保证。
					return true;
				},
				// 实时读取当前有效思考级别。
				getThinkingLevel: () => this.thinkingLevel,
				// 修改思考只改会话，未显式持久化全局默认。
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				// 普通上下文读取当前模型，避免捕获绑定时旧引用。
				getModel: () => this.model,
				// 读取可循环模型范围。
				getScopedModels: () => this._scopedModels,
				// 按会话完整生命周期返回当前空闲标志。
				isIdle: () => this.isIdle,
				// 提供当前项目信任判定值，不在此重新弹确认。
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				// 提供低层当前活动请求的取消信号。
				getSignal: () => this.agent.signal,
				// ctx.abort 优先通过宿主，宿主可同步编辑器/UI 的取消状态。
				abort: () => {
					// 宿主有自定义取消入口才用它。
					if (this._extensionAbortHandler) {
						// 调用宿主取消处理，不在此等待其异步收尾。
						this._extensionAbortHandler();
						// 已由宿主处理，不再重复调用核心 abort。
						return;
					}
					// 无宿主绑定时 fire-and-forget 调核心取消；void 不等待空闲完成。
					void this.abort();
				},
				// 这个布尔值只按两类展示文字队列计数，不代表所有 pending 自定义消息。
				hasPendingMessages: () => this.pendingMessageCount > 0,
				// 退出必须由宿主提供，不在核心硬编码 process.exit。
				shutdown: () => {
					// 没有 shutdown 绑定时可选调用无动作。
					this._extensionShutdownHandler?.();
				},
				// 上下文用量读取复用考虑投影/压缩边界的算法。
				getContextUsage: () => this.getContextUsage(),
				// ctx.compact 是回调式绑定，不向扩展直接返回 compact 的 Promise。
				compact: (options) => {
					// 立即启动异步 IIFE，内部接住失败并调用 onError。
					void (async () => {
						// try 覆盖压缩和完成回调本身的异常。
						try {
							// 手动压缩可能先取消当前运行并等待空闲。
							const result = await this.compact(options?.customInstructions);
							// 成功后可选调用者的完成回调。
							options?.onComplete?.(result);
							// 失败规范化成 Error 交 onError。
						} catch (error) {
							// 非 Error 抛出值包装成 Error，保留统一回调参数类型。
							const err = error instanceof Error ? error : new Error(String(error));
							// 没有 onError 时不额外处理；这里 catch 已消费异常。
							options?.onError?.(err);
						}
						// () 调用刚声明的 async 箭头函数，void 标明外层不等待。
					})();
				},
				// 读取当前有效渲染 system，包括本次运行临时覆盖。
				getSystemPrompt: () => this.systemPrompt,
				// 此接口提供基础选项对象，不是临时运行覆盖的完整副本。
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
				// 工具上下文发起嵌套调用，经统一管线并记录父 id。
				executeTool: (callerId, name, args, options) => this._executeNestedToolCall(callerId, name, args, options),
				// 动态返回工具可调用集合，与模型声明集合区分。
				getCallableTools: () => this._getCallableTools(),
			},
			{
				// 扩展兼容供应商注册会变更运行时目录/认证组合。
				registerProvider: (name, config) => {
					// 把扩展配置注册进共享模型运行时。
					this._modelRuntime.registerProvider(name, config);
					// 同 id 模型定义可能换对象，更新当前选择引用。
					this._refreshCurrentModelFromRegistry();
				},
				// 原生供应商对象走原生注册路径。
				registerNativeProvider: (provider) => {
					// 注册统一 Provider 接口的实现。
					this._modelRuntime.registerNativeProvider(provider);
					// 注册后同样刷新当前模型目录引用。
					this._refreshCurrentModelFromRegistry();
				},
				// 卸载扩展供应商注册。
				unregisterProvider: (name) => {
					// 由运行时恢复/移除对应定义，不在此推断目录结果。
					this._modelRuntime.unregisterProvider(name);
					// 目录变化后刷新当前模型引用，查不到则沿用旧对象。
					this._refreshCurrentModelFromRegistry();
				},
				// 注册可路由的虚拟模型定义。
				registerVirtualModel: (definition) => {
					// 交模型运行时维护虚拟目录与路由函数。
					this._modelRuntime.registerVirtualModel(definition);
					// 同步当前选中项的引用。
					this._refreshCurrentModelFromRegistry();
				},
				// 通过供应商/id 移除虚拟模型定义。
				unregisterVirtualModel: (provider, id) => {
					// 实际注销规则在模型运行时。
					this._modelRuntime.unregisterVirtualModel(provider, id);
					// 尝试更新当前同名目录对象，不在此自动选择替代模型。
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	/**
	 * 重建定义与可执行工具注册表，合并内置、扩展和 SDK 定义，再协调激活集合与提示词。
	 * 按 allow/deny 过滤；跨扩展同名由 runner 保留首个注册项，随后合并的 SDK 同名工具可覆盖扩展/内置；规范化摘要/规则并恢复激活集合。
	 * 例：MCP 连接后新增 deferred 工具可注册供 codemode，是否进入模型声明还依赖允许列表、暴露策略和搜索加载规则。
	 */
	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		// Tools that were already activated on registration. A tool whose exposure changes to
		// `direct` or `model-only` (for example from `hidden`) is activated like a new tool.
		// 更新前记录“注册默认开启”类别，识别新注册或从 hidden 等转可声明的工具。
		const previousActivatedOnRegistration = new Set(
			// 旧注册表逐名按当前旧定义判断。
			[...this._toolRegistry.keys()].filter((name) => this._isActivatedOnRegistration(name)),
		);
		// 保留旧激活顺序，刷新不该无故重排提示词。
		const previousActiveToolNames = this.getActiveToolNames();
		// 局部保存允许匹配器，下面用它决定显式激活。
		const allowedTools = this._allowedTools;

		// 取跨扩展按名称去重后的注册工具（首个注册项胜出），可能包含动态连接后的 MCP 工具。
		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		// 已去重的扩展结果在前，SDK 定义在后；下面 Map.set 因而让 SDK 同名项覆盖扩展或内置定义。
		const allCustomTools = [
			// 扩展项已经有 definition 与 sourceInfo。
			...registeredTools,
			// SDK 工具没有扩展文件，补合成来源。
			...this._customTools.map((definition) => ({
				// 保留原 SDK 定义。
				definition,
				// 来源以 <sdk:工具名> 标识，不假装是可读文件。
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
			// 允许/排除策略先决定工具是否留在注册表。
		].filter((tool) => this._isAllowedTool(tool.definition.name));
		// 建立定义总表，后续同名自定义项可覆盖基础项。
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			// 从基础定义 Map 的键值对开始。
			Array.from(this._baseToolDefinitions.entries())
				// 基础工具也受同一注册保留规则过滤。
				.filter(([name]) => this._isAllowedTool(name))
				// 将允许的基础项映射成 Map 所需 [名字,条目]。
				.map(([name, definition]) => [
					// 键仍采用基础表的名称。
					name,
					{
						// 保存基础定义引用。
						definition,
						// 附 builtin: 合成来源，不读取某个真实路径。
						sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${name}`, { source: "builtin" }),
					},
				]),
		);
		// 依合并列表顺序插入自定义项。
		for (const tool of allCustomTools) {
			// 同名 set 覆盖基础/前项定义，保留最终来源。
			definitionRegistry.set(tool.definition.name, {
				// 工具定义包含执行、schema 与 prompt 元数据。
				definition: tool.definition,
				// 来源沿用扩展/SDK 记录。
				sourceInfo: tool.sourceInfo,
			});
		}
		// 让后续 exposure/prompt 查表使用新完整定义集合。
		this._toolDefinitions = definitionRegistry;
		// 重新生成工具一行摘要索引。
		this._toolPromptSnippets = new Map(
			// 遍历最终定义，而非把被覆盖的基础描述混入。
			Array.from(definitionRegistry.values())
				// 只从条目解构原始定义。
				.map(({ definition }) => {
					// 摘要转换单行、折空白，空内容不列。
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					// as const 保留键值二元组类型，避免推断成普通 string[]。
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				// 类型谓词过滤 undefined，使 Map 构造器得到合法只读二元组。
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		// 重新生成规则列表索引。
		this._toolPromptGuidelines = new Map(
			// 遍历最终定义集合。
			Array.from(definitionRegistry.values())
				// 每项只取 definition。
				.map(({ definition }) => {
					// 去空规则与重复规则，保留首次顺序。
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					// 仅非空列表写入 [名字,规则数组]；as const 保留二元组形状。
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				// 过滤不存在项并收窄二元组类型，第二成员是 string[]。
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		// 保存本轮 runner 引用供工具包装，后续 reload 会整体重包。
		const runner = this._extensionRunner;
		// 把扩展和 SDK 定义适配成低层 AgentTool，提供执行上下文与能力边界。
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		// 基础工具也走同一包装流程。
		const wrappedBuiltInTools = wrapRegisteredTools(
			// 读取全部基础定义。
			Array.from(this._baseToolDefinitions.values())
				// 按允许/排除规则过滤未保留项。
				.filter((definition) => this._isAllowedTool(definition.name))
				// 包装器输入项同时包含定义与来源。
				.map((definition) => ({
					// 基础定义原引用。
					definition,
					// 为基础工具创建可识别来源，非实际源码路径。
					sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${definition.name}`, {
						// 来源类别为 builtin。
						source: "builtin",
					}),
				})),
			// 工具执行时可创建当前 runner 的扩展上下文。
			runner,
		);

		// 先用基础实现建工具名到实现的 Map。
		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		// 自定义实现逐一覆盖，沿用原有 AgentTool[] 类型断言。
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			// 同名工具使用自定义实现，与上面的定义覆盖顺序一致。
			toolRegistry.set(tool.name, tool);
		}
		// 替换整个执行注册表引用。
		this._toolRegistry = toolRegistry;

		// 优先调用方指定激活项，否则保留旧激活集合。
		const nextActiveToolNames =
			// 两边都复制数组，后面 push 不修改输入/旧数组。
			(options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames])
				// 重新过滤当前注册保留策略，已排除项不保留激活。
				.filter((name) => this._isAllowedTool(name));

		// 有显式允许列表时，匹配可声明工具都可加入激活候选。
		if (allowedTools) {
			// 遍历当前实际注册实现名字，不按不存在名字激活。
			for (const toolName of this._toolRegistry.keys()) {
				// Naming or matching a tool activates it even when it is not active by default. MCP tools
				// kept registered without being named stay inactive.
				// 明确匹配且 direct/model-only 才在这一步主动启用。
				if (allowedTools(toolName) && this._isDeclarable(toolName)) {
					// 追加候选，最后统一去重/过滤。
					nextActiveToolNames.push(toolName);
				}
			}
			// 未配置允许列表且要求包含扩展工具，按注册默认激活规则处理全部扩展项。
		} else if (options?.includeAllExtensionTools) {
			// 遍历包装后的扩展/SDK 工具。
			for (const tool of wrappedExtensionTools) {
				// defaultActive=false 或非声明类别不自动开启。
				if (this._isActivatedOnRegistration(tool.name)) nextActiveToolNames.push(tool.name);
			}
			// 没明确指定激活集的普通刷新，只自动激活本次新出现的默认开启工具。
		} else if (!options?.activeToolNames) {
			// 遍历当前注册表检查新增/暴露变化。
			for (const toolName of this._toolRegistry.keys()) {
				// 旧表没默认开启、现在默认开启，才新增候选。
				if (!previousActivatedOnRegistration.has(toolName) && this._isActivatedOnRegistration(toolName)) {
					// 加入本次自动激活集合。
					nextActiveToolNames.push(toolName);
				}
			}
		}
		// Pending tools that are registered now become active.
		// 待恢复名也加入候选；尚没注册的会在下面过滤但仍留 pending。
		nextActiveToolNames.push(...this._pendingToolNames);

		// Set 去重后通过统一装载/提示词路径真正激活。
		this._setActiveTools([...new Set(nextActiveToolNames)]);
	}

	/** Whether activating the tool declares it to the model. */
	/**
	 * 判断工具注册时是否属于可直接声明类别，返回 direct/model-only 是否命中。
	 * 例：deferred 可以后续按需激活，但这里不把它当注册即声明的类别。
	 */
	private _isDeclarable(name: string): boolean {
		// 读取新定义对应暴露类型。
		const exposure = this._getToolExposure(name);
		// 只有这两类注册时可自动向模型声明。
		return exposure === "direct" || exposure === "model-only";
	}

	/** Whether registering the tool activates it, which declares it to the model. */
	/**
	 * 判断工具是否注册时默认激活：须属于 direct/model-only 且 defaultActive 不为 false。
	 * 例：defaultActive 未写视为默认开启，显式 false 保留注册但不自动加入激活列表。
	 */
	private _isActivatedOnRegistration(name: string): boolean {
		// 可声明且没显式关闭 defaultActive，默认会在注册时激活。
		return this._isDeclarable(name) && this._toolDefinitions.get(name)?.definition.defaultActive !== false;
	}

	/**
	 * 构建或重建会话工具/扩展运行时，输入初始激活项、扩展参数和值及扩展激活选项。
	 * 创建基础定义，接收已加载扩展，建立 runner 和核心/宿主绑定，再刷新工具注册表；返回 void。
	 * 例：SDK 覆盖 read 为远程实现时先合成 ToolDefinition，后续仍用统一注册与扩展上下文机制。
	 */
	private _buildRuntime(options: {
		// 可选指定激活集合，未传时用基础默认与扩展规则。
		activeToolNames?: string[];
		// 重载前保留的扩展 CLI 参数名值。
		flagValues?: Map<string, boolean | string>;
		// 是否按默认策略包含扩展工具。
		includeAllExtensionTools?: boolean;
		// 结束构建选项类型，void 表示建立运行时状态而不返回业务结果。
	}): void {
		// 基础 read 的图片设置来自配置。
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		// 基础 bash 可在命令前拼用户配置前缀。
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		// 基础 bash 使用配置 shell 路径。
		const shellPath = this.settingsManager.getShellPath();
		// SDK 可覆盖整组基础工具，否则创建默认工具定义。
		const baseToolDefinitions = this._baseToolsOverride
			? // 把覆盖记录映射成统一定义记录。
				Object.fromEntries(
					// 逐 [名字,AgentTool] 转换，外部键名沿用。
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						// 工具表键名。
						name,
						// 把普通 AgentTool 合成最小 ToolDefinition，复用后续定义优先注册机制。
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: // 默认本地定义按当前工作目录和各工具选项构建。
				createAllToolDefinitions(this._cwd, {
					// read 接图片缩放开关。
					read: { autoResizeImages },
					// bash 接前缀和 shellPath。
					bash: { commandPrefix: shellCommandPrefix, shellPath },
				});

		// 最终基础定义存 Map，供注册/来源/默认工具分类使用。
		this._baseToolDefinitions = new Map(
			// Object.entries 给键值对，as ToolDefinition 仅协调既有 union 类型。
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		// 资源加载器已经持有扩展加载结果与 runtime。
		const extensionsResult = this._resourceLoader.getExtensions();
		// 有保留参数才覆盖新 runtime 的参数表。
		if (options.flagValues) {
			// 遍历原参数 Map，保留 false/空字符串等合法值。
			for (const [name, value] of options.flagValues) {
				// 按名字写入新扩展 runtime 的 flagValues。
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		// 为本次扩展列表建立新 runner，构造并不等于已发 session_start。
		this._extensionRunner = new ExtensionRunner(
			// 已加载的扩展实例集合。
			extensionsResult.extensions,
			// 扩展共享 runtime 状态与注册缓存。
			extensionsResult.runtime,
			// 会话工作目录。
			this._cwd,
			// 当前 SessionManager 供扩展读取/操作历史。
			this.sessionManager,
			// 用统一 runtime 包装兼容 ModelRegistry 接口。
			new ModelRegistry(this._modelRuntime),
		);
		// 外部如保留 ref 容器，就更新它而非替换容器。
		if (this._extensionRunnerRef) {
			// 让外层回调可以读取最新 runner。
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		// 接消息/工具/模型等核心能力回调。
		this._bindExtensionCore(this._extensionRunner);
		// 接已有 UI/命令/错误绑定。
		this._applyExtensionBindings(this._extensionRunner);

		// 覆盖工具表提供默认激活名时采用其全部键，否则用四个基础工具。
		const defaultActiveToolNames = this._baseToolsOverride
			? // Object.keys 只取覆盖表自有可枚举名称。
				Object.keys(this._baseToolsOverride)
			: // 常规默认是 read/bash/edit/write，其余基础工具不自动开启。
				["read", "bash", "edit", "write"];
		// 显式空数组保留“一个也不选”，?? 不会把它变成默认。
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		// 建立新注册表与实际激活集合，末尾重建基础提示词。
		this._refreshToolRegistry({
			// 把候选基础激活名传下去。
			activeToolNames: baseActiveToolNames,
			// 是否纳入默认开启扩展工具由调用方决定。
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	/**
	 * 重新加载设置、资源和扩展，保留参数值及当前工具集合，并接入新增默认工具。
	 * 先通知旧 runner shutdown 并使 ctx 失效，再 reload 设置/资源、重建运行时；存在相关宿主绑定时运行前置回调、发 reload 的 session_start 并发现资源。
	 * 返回 Promise<void>，可能读文件/运行扩展/改状态；不清旧历史。例：新加 defaultTools 项自动激活，设置移除的旧项不因此自动关闭。
	 */
	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		// 保存旧 runner，shutdown 和失效都针对旧上下文。
		const oldRunner = this._extensionRunner;
		// 复制/获取原 CLI flagValues，交新 runtime 延续参数意图。
		const previousFlagValues = oldRunner.getFlagValues();
		// 先给旧扩展关闭通知，reason=reload。
		await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		// 旧 pi/ctx 失效，避免重载后持有旧能力继续操作。
		oldRunner.invalidate();
		// 局部函数每次按当前设置计算默认工具加修饰项。
		const getDefaultTools = () =>
			// 仅原本遵从默认工具策略时才读此设置。
			this._usesDefaultTools
				? // 按完整默认表再应用 CLI 的 +name/-name。
					applyToolModifiers(
						// 未配置 defaultTools 则用项目默认常量。
						this.settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES,
						// 保留用户加减意图，reload 后仍有效。
						this._defaultToolModifiers,
					)
				: // 非 defaultTools 策略不自动添加默认项。
					[];
		// 记录 reload 前的默认集合，后面只自动激活新增项。
		const previousDefaultTools = new Set(getDefaultTools());
		// 重新读取设置，可能涉及磁盘读取。
		await this.settingsManager.reload();
		// 新设置的队列策略立即同步到低层。
		this.syncQueueModesFromSettings();
		// 重置兼容 API provider 注册，资源 reload 会重新注册扩展供应商。
		resetApiProviders();
		// 重新发现/加载资源与扩展；异步失败向上传播。
		await this._resourceLoader.reload();
		// Activate tools newly added to defaultTools. Removed ones stay active, and tools disabled
		// during the session stay disabled unless the setting newly adds them.
		// 只比较新增默认工具，删除项不因此自动关闭。
		const addedDefaultTools = getDefaultTools().filter((name) => !previousDefaultTools.has(name));
		// Tools the new extensions register later, such as MCP tools, are pending until then.
		// 现有激活工具先记 pending，新的异步 MCP 注册后可恢复。
		for (const name of this.getActiveToolNames()) this._pendingToolNames.add(name);
		// 按新资源建立 runner、工具与提示词。
		this._buildRuntime({
			// 保留当前集合，再补本次设置中新加的默认项。
			activeToolNames: [...this.getActiveToolNames(), ...addedDefaultTools],
			// 给新扩展 runtime 填回原 flag 值。
			flagValues: previousFlagValues,
			// 这次完整重载按注册策略纳入扩展工具。
			includeAllExtensionTools: true,
		});

		// 是否做 session_start/资源发现取决于下面四类宿主绑定存在性。
		const hasBindings =
			// UI 绑定可表示会话已接入宿主。
			this._extensionUIContext ||
			// 命令操作绑定也算宿主已就绪。
			this._extensionCommandContextActions ||
			// 退出处理绑定也算。
			this._extensionShutdownHandler ||
			// 错误监听也算；仅 mode/abort 绑定本身不在此表达式中。
			this._extensionErrorListener;
		// 有对应绑定才发重载启动事件。
		if (hasBindings) {
			// 新 runner 已构建，启动事件前允许宿主做可选异步准备。
			await options?.beforeSessionStart?.();
			// 新扩展收到 session_start，明确 reason=reload。
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			// 检查本次仍无人接管的 MCP 服务。
			this._extensionRunner.reportUnhandledMcpServers();
			// 重载扩展可继续贡献技能/模板/主题资源。
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	/**
	 * 判定普通回答是否可自动重试，返回 boolean。
	 * 先排除上下文溢出（由压缩恢复负责），其余交兼容层错误分类。例：限流可重试，context length exceeded 走另一条协调路径。
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		// 上下文溢出排除普通重试，模型限制优先消息对应的物理模型。
		if (isContextOverflow(message, (this._modelForMessage(message) ?? this.model)?.contextWindow ?? 0)) return false;
		// 其余错误按共享错误分类，如限流/暂时服务错误。
		return isRetryableAssistantError(message);
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	/**
	 * 为摘要请求生成重试通知回调对象，无立即网络请求。
	 * 回调把等待、重试开始、结束映射成会话事件，并保留 branchSummary 或 compaction/reason 来源。例：摘要退避后 TUI 可重建对应进度提示。
	 */
	private _summarizationRetryCallbacks(
		// 带 source 的联合类型：仅 compaction 分支必须带 reason。
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
		// 返回三类通知函数，不在创建对象时发事件。
	): RetryCallbacks {
		// 构造回调对象，此刻不执行任何重试或派发。
		return {
			// 每次退避被安排时，参数由共享摘要重试执行器提供。
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				// 转为会话级通知供 UI/RPC 观察。
				this._emit({
					// 表示摘要退避已安排。
					type: "summarization_retry_scheduled",
					// 重试序号。
					attempt,
					// 额外尝试次数上限。
					maxAttempts,
					// 本次等待毫秒。
					delayMs,
					// 原始摘要错误说明。
					errorMessage,
				});
			},
			// 等待结束，下一次摘要调用即将发起。
			onRetryAttemptStart: () => {
				// 发重试请求启动通知。
				this._emit({
					// 事件名区别于普通回答 auto_retry_start。
					type: "summarization_retry_attempt_start",
					// 展开 source；compaction 同时包含 reason，branchSummary 没有该字段。
					...source,
				});
			},
			// 摘要重试流程全部结束时通知清 UI。
			onRetryFinished: () => {
				// 完成事件不带普通回答计数器信息。
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	/**
	 * 有普通回答重试计数时，归零并发布取消失败的 auto_retry_end，返回 void。
	 * 例：退避期间 Esc，UI 收到 Retry cancelled；计数原为 0 时不重复发事件。
	 */
	private _finishCancelledRetry(): void {
		// 没有累计重试时不重复发取消结束事件。
		if (this._retryAttempt === 0) return;
		// 先留最后计数供通知。
		const attempt = this._retryAttempt;
		// 先归零，避免后续收尾再次报告同一重试。
		this._retryAttempt = 0;
		// 发布普通重试结束状态。
		this._emit({
			// 普通重试结束事件名。
			type: "auto_retry_end",
			// 取消按不成功处理。
			success: false,
			// 最后额外重试次数。
			attempt,
			// 固定取消说明，与供应商错误不同。
			finalError: "Retry cancelled",
		});
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	/**
	 * 为可重试回复安排下一次恢复：检查预算、计数、计算退避、隐去失败消息并可取消地等待。
	 * 返回 true 只代表等待完成可继续，不在此发送下一模型请求；取消返回 false 并清重试状态。
	 * 例：baseDelay=1000 时首次等 1 秒、第二次 2 秒并受上限限制；原失败记录仍在原始历史，模型投影已省略它。
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		// 每次安排前读取实时重试设置。
		const settings = this.settingsManager.getRetrySettings();
		// 自动重试关闭则不改计数或消息。
		if (!settings.enabled) {
			// 告诉外层没有准备下一次重试。
			return false;
		}

		// 先试增一次，和 maxRetries 比较。
		this._retryAttempt++;

		// 超过允许额外次数则不发新请求。
		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			// 还原刚试增的次数，最终失败事件报告真实已尝试次数。
			this._retryAttempt--;
			// 不再继续普通恢复。
			return false;
		}

		// 指数退避按基础延迟、尝试序号和最大等待计算。
		const delayMs = retryDelayMs(settings, this._retryAttempt);

		// 先通知等待状态，观察者可显示倒计时/原因。
		this._emit({
			// 普通自动重试开始事件。
			type: "auto_retry_start",
			// 本次额外尝试序号。
			attempt: this._retryAttempt,
			// 最多额外重试次数，不是总请求数。
			maxAttempts: settings.maxRetries,
			// 即将等待的毫秒数。
			delayMs,
			// 供应商错误没文字时用 Unknown error 兜底。
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Keep the failed attempt in raw history while durably omitting it from model projection.
		// 通过 context_edit 持久省略失败 assistant 和对应工具结果，保留原历史。
		this._omitRecoveryAttempt(message);

		// Wait with exponential backoff (abortable)
		// 退避控制器存在期间 isRetrying=true，用户可 abortRetry。
		this._retryAbortController = new AbortController();
		// try/finally 保证控制器释放。
		try {
			// sleep 等时间，signal 中止会拒绝 Promise。
			await sleep(delayMs, this._retryAbortController.signal);
			// 等待异常在此按取消结束处理，sleep 的正常拒绝来源是 abort。
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			// 补取消的 auto_retry_end 并归零。
			this._finishCancelledRetry();
			// 不允许外层继续该重试。
			return false;
			// 无论等待成功或取消都释放控制器。
		} finally {
			// isRetrying 随控制器清除而 false，实际请求尚未在此发送。
			this._retryAbortController = undefined;
		}

		// 等待成功，只准备好了恢复，下一请求由外层 agent.continue 发起。
		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	/**
	 * 取消当前退避等待，返回 void；不会直接清计数，等待处负责发取消事件。例：没有控制器时可选调用无动作。
	 */
	abortRetry(): void {
		// 存在退避控制器才发取消信号。
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	/**
	 * 判断当前是否处于普通回答重试的退避控制器周期，返回 boolean。例：真正重试请求发出后控制器已清，此值不代表整个重试生命周期。
	 */
	get isRetrying(): boolean {
		// 判断退避控制器存在，不覆盖所有重试请求执行时间。
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	/**
	 * 读取自动重试设置开关，不检查当前运行状态。例：enabled=true 不等于现在正在退避。
	 */
	get autoRetryEnabled(): boolean {
		// 读取自动重试开关，不改变正在等的任务。
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	/**
	 * 保存自动重试 enabled 开关，返回 void，不主动取消已有退避。例：后续准备下一次重试时读取新设置。
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		// 只写设置，不直接调用 abortRetry。
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.id Optional identifier included in bash execution update events
	 * @param options.operations Custom BashOperations for remote execution
	 */
	/**
	 * 执行用户手动 shell 命令，支持本地或自定义远程 BashOperations，流式通知输出并记录结果。
	 * 建立独立控制器，拼设置前缀，执行后记原命令及结果，finally 移除控制器；返回 BashResult，执行异常向上传播。
	 * 例：!!ls 由调用者设 excludeFromContext=true，使记录不进模型，但仍保存会话；并发手动命令各有控制器。
	 */
	async executeBash(
		// 用户原命令正文，保存时仍用它而非加前缀后的整段。
		command: string,
		// 可选输出块回调，接工具执行过程中增量文字。
		onChunk?: (chunk: string) => void,
		// 可标上下文排除、事件 id 或自定义远程操作实现。
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
		// 返回输出、退出/取消/截断等 BashResult。
	): Promise<BashResult> {
		// 每个手动命令独立取消，不复用 Agent 当前请求控制器。
		const abortController = new AbortController();
		// 加入集合，支持并发命令统一取消与运行状态读取。
		this._bashAbortControllers.add(abortController);

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		// 读取可选命令前缀，例如配置 shell 初始化语句。
		const prefix = this.settingsManager.getShellCommandPrefix();
		// 读取本地操作将采用的 shell 路径。
		const shellPath = this.settingsManager.getShellPath();
		// 有前缀时用换行连接，不拼 shell 的 && 或保证前缀成功后才执行。
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		// 保证执行/记录异常也移除本控制器。
		try {
			// 执行器负责进程/远程适配、输出截断和完整输出文件等。
			const result = await executeBashWithOperations(
				// 实际执行包含配置前缀的命令。
				resolvedCommand,
				// 执行目录取 SessionManager 当前 cwd。
				this.sessionManager.getCwd(),
				// 有自定义 operations 就用它，否则构造本地 shell 适配。
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					// 每次输出增量同时给调用者和会话观察者。
					onChunk: (delta) => {
						// 可选 onChunk 同步调用，有异常可影响当前执行回调。
						onChunk?.(delta);
						// 事件带调用方可选 id，便于区分并发手动命令。
						this._emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					// 传本次命令独立的取消信号。
					signal: abortController.signal,
				},
			);

			// 执行完成后记录原始用户命令和结果，排除策略透传。
			this.recordBashResult(command, result, options);
			// 结果原样返回给调用方。
			return result;
			// 不论成功、异常、取消，最后都释放运行登记。
		} finally {
			// Set.delete 只移除此命令，不影响其他并发命令。
			this._bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	/**
	 * 把已经完成的 bash 结果包装为应用层消息；空闲立即保存，运行中暂存，返回 void。
	 * 不执行命令。例：扩展远程执行完后调用此方法，把 output/exitCode/cancelled/truncated 等带回会话。
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		// 构造应用层 shell 记录，后续 convertToLlm 再转 user 说明。
		const bashMessage: BashExecutionMessage = {
			// 角色不是 toolResult，因为它来自用户/扩展手动执行。
			role: "bashExecution",
			// 原命令正文属性简写。
			command,
			// 执行器截断策略处理后的输出。
			output: result.output,
			// 退出码可缺省，非零意义由具体命令决定。
			exitCode: result.exitCode,
			// 是否取消。
			cancelled: result.cancelled,
			// 输出是否被截断。
			truncated: result.truncated,
			// 可选完整输出文件位置，不保证文件永久保留。
			fullOutputPath: result.fullOutputPath,
			// 记录结果包装时毫秒时间。
			timestamp: Date.now(),
			// !! 等入口可要求不进入模型上下文，但仍保存记录。
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		// 运行中直接 append 可能拆开调用/结果，先暂存。
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			// 暂存将在 _startRun 的准备/最终收尾协调路径中冲刷；旧英语简写为 agent_end，应结合实际调用点理解。
			this._pendingBashMessages.push(bashMessage);
		} else {
			// 没有活动 Agent 运行则可直接追加到历史。
			this.sessionManager.appendMessage(bashMessage);
			// 立即刷新有效消息，让下一 prompt 带上这条记录（除非转换排除）。
			this._refreshFinalizedContext();
		}
	}

	/**
	 * Cancel running bash command.
	 */
	/**
	 * 向目前登记的每个独立 bash 控制器发取消请求，返回 void。
	 * 先复制集合再迭代；例：同时跑两个手动命令时都收到信号，完成后的清理由各自 finally 做。
	 */
	abortBash(): void {
		// 复制集合快照，避免取消回调导致集合变化影响本轮遍历。
		for (const abortController of [...this._bashAbortControllers]) {
			// 给每个独立 bash 发信号，不等待其退出。
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	/**
	 * 以独立 bash 控制器集合是否非空判断手动命令在运行，返回 boolean。例：isIdle=true 时仍可能 isBashRunning=true。
	 */
	get isBashRunning(): boolean {
		// 只要还有登记控制器就认为手动 bash 在运行。
		return this._bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	/**
	 * 判断是否有为保持工具顺序而暂存的 bash 消息，返回 boolean。例：命令已经执行完但 Agent 仍忙，结果可能仍在等落入上下文。
	 */
	get hasPendingBashMessages(): boolean {
		// 等待 flush 的结果与仍运行命令是不同状态。
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	/**
	 * 把暂存 bash 结果依序写会话，清空暂存并刷新有效上下文，返回 void。
	 * 例：会话运行开始前或最终收尾调用它；这里不逐条发低层 message_start/end。
	 */
	private _flushPendingBashMessages(): void {
		// 无等待结果就不重建上下文。
		if (this._pendingBashMessages.length === 0) return;

		// 按暂存顺序写入，不重跑命令。
		for (const bashMessage of this._pendingBashMessages) {
			// 每条保留其已记录的时间/输出与排除标志。
			this.sessionManager.appendMessage(bashMessage);
		}
		// 写入后清空待保存数组。
		this._pendingBashMessages = [];
		// 一次性刷新新投影，而不是每条重复刷新。
		this._refreshFinalizedContext();
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	/**
	 * 追加会话显示名变更并通知公开观察者与扩展，返回 void。
	 * 扩展事件以 void 启动不等待；例：命名为“登录问题”不修改 session id 或文件名，读取名称以 manager 的最终值为准。
	 */
	setSessionName(name: string): void {
		// 以 session_info 条目记录显示名变更，旧记录不直接改写。
		this.sessionManager.appendSessionInfo(name);
		// 从 manager 重新读最终名称，as const 保留事件字面量类型。
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		// 先同步通知公开观察者。
		this._emit(event);
		// 再发异步扩展通知，void 表明不等待完成。
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	/**
	 * 在同一会话文件的树上换当前位置，可先总结离开的分支，返回编辑器文字、取消状态和可选摘要条目。
	 * 拒绝忙碌/压缩；找共同祖先，咨询扩展，按需模型摘要，再移动叶子/写摘要与标签，刷新上下文和历史工具。
	 * 例：选中旧 user 节点时叶子退到它的父节点，旧文字返回编辑器供修改；不会直接再次执行该 user 消息。出错抛出，finally 清导航状态。
	 */
	async navigateTree(
		// 目标是已有会话条目的 id，不是会话文件路径。
		targetId: string,
		// 可选是否总结、摘要要求、是否替换默认要求及标签；默认空选项表示只移动位置。
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
		// 返回可编辑旧文字、取消/中止标志及可选保存摘要；异常仍通过拒绝 Promise 报告。
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		// 当前 Agent 运行含重试/收尾时不能导航，避免并发改历史。
		if (this.isStreaming) {
			// 要求先等当前回复结束。
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}
		// 任一压缩或分支导航控制器存在，也拒绝并发导航。
		if (this.isCompacting) {
			// 多行 throw 文案保持原样，调用方可显示。
			throw new Error(
				// 明确等现有摘要/导航完成。
				"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
			);
		}

		// 保存导航前叶子位置，供找共同祖先、摘要与事件。
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		// 同一目标无操作，不发扩展事件或重建状态。
		if (targetId === oldLeafId) {
			// 返回非取消但无编辑器文字/摘要。
			return { cancelled: false };
		}

		// Model required for summarization
		// 请求总结时预先要求模型，未请求总结则可无模型导航。
		if (options.summarize && !this.model) {
			// 即便扩展之后可能提供摘要，这条前置检查仍然生效。
			throw new Error("No model available for summarization");
		}

		// 查询目标条目；不能导航到不存在 id。
		const targetEntry = this.sessionManager.getEntry(targetId);
		// 没有目标明确抛错，不默默回根。
		if (!targetEntry) {
			// 错误文案带目标 id，便于定位。
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		// 取离开旧分支的独有条目和最近共同祖先，返回顺序已是从早到晚。
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			// 传当前只读会话查询接口。
			this.sessionManager,
			// 旧叶子可为 null，表示没有旧位置可总结。
			oldLeafId,
			// 目标用于查另一条根到叶路径。
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		// 保存可由扩展返回覆盖的摘要要求。
		let customInstructions = options.customInstructions;
		// 保存是否用自定义要求完全替换默认指令。
		let replaceInstructions = options.replaceInstructions;
		// 保存候选标签，可能由扩展改名或清空。
		let label = options.label;

		// 准备数据对象给扩展观察原导航意图。
		const preparation: TreePreparation = {
			// 选中的目标条目。
			targetId,
			// 离开的旧叶子。
			oldLeafId,
			// 两分支共有的最深条目，可 null。
			commonAncestorId,
			// 离开路径需要考虑总结的条目集合。
			entriesToSummarize,
			// 仅用户原 summarize 决定要不要总结，默认 false。
			userWantsSummary: options.summarize ?? false,
			// 初始附加摘要要求。
			customInstructions,
			// 初始替换要求标记。
			replaceInstructions,
			// 初始标签。
			label,
		};

		// Set up abort controller for summarization
		// 整个导航阶段占用分支控制器，即便不生成摘要也参与 busy 检查。
		this._branchSummaryAbortController = new AbortController();

		// 确保取消/成功/错误都清控制器并协调空闲。
		try {
			// 扩展可直接提供摘要、任意详情和用量。
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			// 缺省认为使用内置结果；有扩展替代再设 true。
			let fromExtension = false;

			// Emit session_before_tree event
			// 只有注册了 session_before_tree 才咨询扩展。
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				// 等待扩展前事件，结果按会话树结果契约断言。
				const result = (await this._extensionRunner.emit({
					// 导航前事件名。
					type: "session_before_tree",
					// 目标、旧位置、共同祖先等准备数据。
					preparation,
					// 扩展可据同一信号停止工作。
					signal: this._branchSummaryAbortController.signal,
					// undefined 表示未返回干预结果。
				})) as SessionBeforeTreeResult | undefined;

				// 扩展主动取消即返回，不改叶子位置。
				if (result?.cancel) {
					// 取消结果没有 aborted=true；它与用户信号中止区分。
					return { cancelled: true };
				}

				// 只有用户原先请求 summarize，才采用扩展自供摘要。
				if (result?.summary && options.summarize) {
					// 保存扩展摘要结果。
					extensionSummary = result.summary;
					// 记录摘要来源，后续条目/事件使用。
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				// undefined 表示不覆盖，空字符串也算扩展明确提供。
				if (result?.customInstructions !== undefined) {
					// 采用扩展的新指令。
					customInstructions = result.customInstructions;
				}
				// 布尔 false 也能覆盖 true，因此判断是否 undefined 而非真值。
				if (result?.replaceInstructions !== undefined) {
					// 采用扩展的新替换指令标记。
					replaceInstructions = result.replaceInstructions;
				}
				// 标签允许用空字符串表达不附标签。
				if (result?.label !== undefined) {
					// 保存扩展返回的标签文字。
					label = result.label;
				}
			}

			// Run default summarizer if needed
			// 默认没有生成摘要，后面分支选择赋值。
			let summaryText: string | undefined;
			// 摘要详情可来自内置文件列表或任意扩展数据。
			let summaryDetails: unknown;
			// 可选摘要用量用于累计统计。
			let summaryUsage: Usage | undefined;
			// 用户要总结、旧分支有内容且没扩展结果时，才真正调用内置摘要。
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				// 复用本次导航信号。
				const signal = this._branchSummaryAbortController.signal;
				// 分支摘要独立 reserveTokens 设置，不混用压缩 keepRecentTokens。
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				// 下层按模型预算裁选旧分支条目并生成摘要。
				const result = await generateBranchSummary(entriesToSummarize, {
					// this.model! 是非空断言，依据之前 summarize 检查；不在运行时创建模型。
					...(await this._getSummarizationRequestAuth(this.model!, signal)),
					// 同一信号贯穿认证/摘要。
					signal,
					// 可能由扩展改过的要求。
					customInstructions,
					// 是否替换默认摘要指令。
					replaceInstructions,
					// 给指令和输出预留容量，其余作为输入预算。
					reserveTokens: branchSummarySettings.reserveTokens,
					// 沿用当前流函数，不启动低层 Agent 工具回合。
					streamFn: this.agent.streamFunction,
					// 复用重试预算/退避设置。
					retry: this.settingsManager.getRetrySettings(),
					// 摘要重试事件标为 branchSummary，区别于压缩。
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				// 下层发现用户中止，返回 cancelled 与 aborted。
				if (result.aborted) {
					// 此时尚未切叶子/写摘要。
					return { cancelled: true, aborted: true };
				}
				// 下层报告错误时，本层转抛 Error 给调用者。
				if (result.error) {
					// 错误走 finally 清状态，不伪造成功导航。
					throw new Error(result.error);
				}
				// 保存生成的摘要正文，可 undefined。
				summaryText = result.summary;
				// 保存本次摘要请求用量。
				summaryUsage = result.usage;
				// 内置详情记录读取/修改过的文件集合。
				summaryDetails = {
					// 未提供读文件列表用空数组。
					readFiles: result.readFiles || [],
					// 未提供改文件列表用空数组。
					modifiedFiles: result.modifiedFiles || [],
				};
				// 扩展自供摘要路径，不再调用默认模型。
			} else if (extensionSummary) {
				// 采用扩展摘要正文。
				summaryText = extensionSummary.summary;
				// 保留扩展详情原数据。
				summaryDetails = extensionSummary.details;
				// 保留扩展用量。
				summaryUsage = extensionSummary.usage;
			}

			// Determine the new leaf position based on target type
			// 叶子允许 null，代表回到消息前的根位置。
			let newLeafId: string | null;
			// 仅选择 user/custom_message 时会返回旧文字供编辑。
			let editorText: string | undefined;

			// 选中用户消息时，准备让用户修改重发，而非把该消息留为最后一条再回答。
			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				// 真正叶子退到所选 user 的父节点，可能为 null。
				newLeafId = targetEntry.parentId;
				// 取旧用户文字，不把图片编码混入编辑器文本。
				editorText = contentText(targetEntry.message.content, "");
				// 应用层 custom_message 也按“退到父节点并回填文字”处理。
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				// 叶子取该消息父节点。
				newLeafId = targetEntry.parentId;
				// 提取自定义消息文字部分。
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				// 其他条目（如 assistant、摘要、元数据）直接以所选节点作新叶子。
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			// 可选保存后的分支摘要条目，返回给宿主/UI。
			let summaryEntry: BranchSummaryEntry | undefined;
			// 仅非空摘要正文才创建摘要分支；空字符串不保存摘要。
			if (summaryText) {
				// Create summary at target position (can be null for root)
				// 把旧分支总结挂到目标新位置，不挂回旧叶子。
				const summaryId = this.sessionManager.branchWithSummary(
					// 目标可以是根 null，也可以是已有父节点 id。
					newLeafId,
					// 摘要正文。
					summaryText,
					// 文件列表或扩展详情。
					summaryDetails,
					// 标识摘要来源。
					fromExtension,
					// 摘要可选用量。
					summaryUsage,
				);
				// 根据返回 id 取保存条目，沿用原有分支摘要断言。
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				// 非空标签才为新摘要追加标签记录。
				if (label) {
					// 标签落在 summaryId，不是原选中 user 条目。
					this.sessionManager.appendLabelChange(summaryId, label);
				}
				// 无摘要且退到根时，清当前叶子。
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				// 重设位置而不删除旧分支条目。
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				// 无摘要、非根时直接移动到目标父节点或选中非用户节点。
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			// 没创建摘要则标签附原目标条目，哪怕当前叶子因 user 回填退到其父节点。
			if (label && !summaryText) {
				// 追加目标标签记录，旧条目正文不改。
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update finalized context from the canonical session projection.
			// 根据新位置与摘要重建 Agent 有效消息。
			this._refreshFinalizedContext();
			// 工具也按新分支的 system 声明恢复，不继续盲用旧分支集合。
			this._restoreToolsFromTranscript();

			// Emit session_tree event
			// 异步通知扩展导航已经完成。
			await this._extensionRunner.emit({
				// 导航后事件名，与可取消前事件区别。
				type: "session_tree",
				// 重新读取真实叶子，创建摘要后叶子会是摘要条目。
				newLeafId: this.sessionManager.getLeafId(),
				// 保留导航前叶子用于对比。
				oldLeafId,
				// 可选新建摘要条目。
				summaryEntry,
				// 没有摘要时不声称摘要来自任何一方。
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			// 返回可回填文字、成功标记和新摘要；不自动向模型发旧问题。
			return { editorText, cancelled: false, summaryEntry };
			// 任何返回/异常都进 finally。
		} finally {
			// 释放导航/摘要 busy 标记。
			this._branchSummaryAbortController = undefined;
			// 若没有其他运行/摘要，唤醒 waitForIdle。
			this._resolveIdleWaitIfIdle();
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	/**
	 * 从全部会话条目收集非空 user 文字与条目 id，供分叉选择器，返回新数组。
	 * 不只当前分支，也不恢复/创建分叉；图片没有文字时不会成为选择项。例：旧分支的 user 问题仍可供选中重走。
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		// 全部会话条目，不只是当前分支投影。
		const entries = this.sessionManager.getEntries();
		// 显式数组元素结构含 entryId 和 text，初始为空。
		const result: Array<{ entryId: string; text: string }> = [];

		// 按原条目顺序遍历，包含其他分支历史。
		for (const entry of entries) {
			// 只关心 type=message，压缩/自定义条目不进选择器。
			if (entry.type !== "message") continue;
			// 再限定真正 user 角色，不包含手动 bash/custom。
			if (entry.message.role !== "user") continue;

			// 从 user 内容取文字块，用空分隔符连接。
			const text = contentText(entry.message.content, "");
			// 纯图/空文字不列为可回填文本项。
			if (text) {
				// 把来源 id 与文字放一起，后续用户选择可定位分叉起点。
				result.push({ entryId: entry.id, text });
			}
		}

		// 返回收集结果，不更改会话位置。
		return result;
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	/**
	 * 遍历所有会话条目统计消息/工具调用、token 与费用，再附当前上下文用量。
	 * 包括已压缩历史及其他分支，汇总 usage 条目、摘要用量、assistant/工具结果用量；返回统计对象，不重新询问供应商账单。
	 * 例：旧上下文被摘要后花费仍计入累计；custom_message 不属于下面 message 计数范围。
	 */
	getSessionStats(): SessionStats {
		// 各消息计数独立从零累加。
		let userMessages = 0;
		// assistant 总数，不限定 stopReason 是否成功。
		let assistantMessages = 0;
		// 工具结果总数。
		let toolResults = 0;
		// 只统计 type=message 条目的总数。
		let totalMessages = 0;
		// 后面数 assistant 内 toolCall 内容块，不数工具开始事件。
		let toolCalls = 0;
		// 创建用量/费用累加器，避免各类 usage 分别散落计算。
		const usageTotals = createUsageTotals();

		// 遍历所有分支和压缩前历史条目，区别于当前可见上下文。
		for (const entry of this.sessionManager.getEntries()) {
			// 独立 usage 条目也计费，比如缓存保温等工作记录。
			if (entry.type === "usage") {
				// 将该条目用量加到累计器。
				addUsageToTotals(usageTotals, entry.usage);
				// 分支摘要与压缩摘要自己花费模型用量，也计入总账。
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				// 存在 usage 才累加这些摘要条目。
				addUsageToTotals(usageTotals, entry.usage);
			}
			// 非普通 message 不参与下面消息数计数，但它的用量可能已在上面累加。
			if (entry.type !== "message") continue;
			// 每个 message 都计入总数，不论角色。
			totalMessages++;
			// 取该条目真实消息对象。
			const message = entry.message;
			// 用户角色增加 user 数量。
			if (message.role === "user") {
				// 自增一条用户消息。
				userMessages++;
				// toolResult 记录工具最终结果，不代表一定成功。
			} else if (message.role === "toolResult") {
				// 自增工具结果数。
				toolResults++;
				// 某些工具可能内部调用模型/嵌套工具，结果自带 usage。
				if (message.usage) {
					// 将这些工具用量计入累计。
					addUsageToTotals(usageTotals, message.usage);
				}
				// assistant 自带模型请求的 usage。
			} else if (message.role === "assistant") {
				// 所有 assistant 消息都计数，包括失败/取消尝试。
				assistantMessages++;
				// 沿用兼容层 AssistantMessage 断言。
				const assistantMsg = message as AssistantMessage;
				// 保留原有 content 数组检查，不把它新增成对 typed 值的防御模式。
				if (Array.isArray(assistantMsg.content)) {
					// 过滤工具调用块计数，思考/文字不计工具调用。
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				// 直接将本条 assistant 的 usage 分项加到总账；helper 按类型声明读取字段，不为任意缺字段旧数据补值。
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		// 组统计返回对象，消息计数和当前上下文统计保持分开。
		return {
			// 可选会话文件路径。
			sessionFile: this.sessionFile,
			// 当前会话 id。
			sessionId: this.sessionId,
			// 累计 user 数。
			userMessages,
			// 累计 assistant 数。
			assistantMessages,
			// 累计 toolCall 块数。
			toolCalls,
			// 累计 toolResult 数。
			toolResults,
			// 累计全部 message 数。
			totalMessages,
			// token 总账字段，从用量累加器取值。
			tokens: {
				// 累计 input。
				input: usageTotals.input,
				// 累计 output。
				output: usageTotals.output,
				// 累计 cacheRead。
				cacheRead: usageTotals.cacheRead,
				// 累计 cacheWrite。
				cacheWrite: usageTotals.cacheWrite,
				// 总数明确按四项相加，而不是任意一条 usage.totalTokens。
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			// 累计记录费用，可能依赖供应商报告或目录单价。
			cost: usageTotals.cost,
			// 附当前上下文占用，不把累计 tokens 当窗口占用。
			contextUsage: this.getContextUsage(),
		};
	}

	/**
	 * 估算当前有效上下文 token/窗口/占比；无有效模型窗口返回 undefined。
	 * 最新压缩后若还没有保留在投影中的有效新 assistant 用量，返回 tokens/percent=null；否则按投影估算。
	 * 例：刚压缩完显示大小未知，下一次有效回复后更新；percent 不钳到 100，超窗口可大于 100。
	 */
	getContextUsage(): ContextUsage | undefined {
		// 虚拟模型优先最近实际路由模型，普通选择直接用当前模型。
		const model = this._limitsModel();
		// 没有模型就没有可比较窗口，返回 undefined。
		if (!model) return undefined;

		// 缺窗口用 0 表达没有有效容量信息。
		const contextWindow = model.contextWindow ?? 0;
		// 非正窗口无法计算比例，返回 undefined。
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		// 取有效投影，排除 context_edit 隐去内容并考虑压缩摘要。
		const projection = this.sessionManager.buildSessionProjection();
		// 取当前分支原始顺序，供确认用量在压缩前还是后。
		const branch = this.sessionManager.getBranch();
		// 取最近压缩条目，不按全部文件里其他分支压缩判断。
		const latestCompaction = getLatestCompactionEntry(branch);

		// 有压缩边界才需要证明存在压缩后有效 usage。
		if (latestCompaction) {
			// 收集当前投影里含有效 assistant 使用量的来源 id。
			const projectedAssistants = new Set(
				// 每个投影条目可能贡献多消息，符合则产一个来源 id。
				projection.entries.flatMap((entry) =>
					// 只要该来源有一条合格 assistant 即记录。
					entry.messages.some(
						// 下面条件排除不可信用量来源。
						(message) =>
							// 必须是 assistant 消息。
							message.role === "assistant" &&
							// 取消回复不拿来判断真实占用。
							message.stopReason !== "aborted" &&
							// 错误回复不拿来判断真实占用。
							message.stopReason !== "error" &&
							// 全零 usage 也不是有效窗口统计。
							calculateContextTokens(message.usage) > 0,
					)
						? // 符合条件输出来源 id 单项数组。
							[entry.sourceEntry.id]
						: // 不符合则输出空数组，flatMap 不留下占位。
							[],
				),
			);
			// 找最新压缩在当前分支的位置。
			const compactionIndex = branch.findIndex((entry) => entry.id === latestCompaction.id);
			// 检查它之后是否有仍在投影里的有效 usage 来源。
			const hasPostCompactionUsage = branch
				// 只扫描压缩之后条目。
				.slice(compactionIndex + 1)
				// 来源 id 在上面的投影集合里才可信，已隐去的回复不算。
				.some((entry) => projectedAssistants.has(entry.id));
			// 压缩后尚无有效使用量时明确返回 null 大小/比例，避免拿旧大上下文冒充新大小。
			if (!hasPostCompactionUsage) return { tokens: null, contextWindow, percent: null };
		}

		// 已有有效信息后，用考虑后续编辑/压缩失效规则的估算器计算。
		const estimate = estimateProjectedContextTokens(projection, branch);
		// 除窗口乘 100 得百分比，不四舍五入或钳制范围。
		const percent = (estimate.tokens / contextWindow) * 100;

		// 返回当前占用，不修改累计统计或 settings。
		return {
			// 当前估算 token 数。
			tokens: estimate.tokens,
			// 限制模型上下文窗口。
			contextWindow,
			// 可能超过 100 的百分比。
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @param options Optional export presentation settings
	 * @returns Path to exported file
	 */
	/**
	 * 将会话导出 HTML，按可用显式主题/设置主题选择，接扩展工具渲染器，返回输出路径 Promise。
	 * 会写导出文件；例：指定不存在的主题时尝试设置里的有效主题，再交导出器默认处理，不在此改变当前终端主题。
	 */
	async exportToHtml(outputPath?: string, options: { themeName?: string } = {}): Promise<string> {
		// 按显式主题、设置主题顺序找首个真实存在名称。
		const themeName = [options.themeName, this.settingsManager.getTheme()].find(
			// undefined 或查不到主题的候选跳过，找不到最终为 undefined。
			(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
		);

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		// 创建 HTML 工具渲染适配，支持扩展自定义工具结果展示。
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			// 按工具名动态解析渲染器，缺定义通过回调查询。
			getToolRenderers: (name) =>
				// 传当前 runner 与定义查找，不硬编码每种工具 HTML。
				this._extensionRunner.resolveToolRenderers(name, () => this.getToolDefinition(name)),
			// 传当前交互主题对象，最终导出器还会结合 themeName。
			theme,
			// 渲染上下文使用会话实际工作目录。
			cwd: this.sessionManager.getCwd(),
		});

		// 调用导出器写文件并等待返回实际输出路径，可能是相对路径。
		return await exportSessionToHtml(this.sessionManager, this.state, {
			// 可选用户输出路径，默认位置由导出器决定。
			outputPath,
			// 筛选后的有效主题名或 undefined。
			themeName,
			// 工具自定义 HTML 渲染函数。
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	/**
	 * 导出当前分支为 JSONL，返回解析后的输出路径；会写文件。
	 * 例：同文件多个分支时只导出当前根到叶路径及会话头，具体路径默认由 exportSessionToJsonl 决定。
	 */
	exportToJsonl(outputPath?: string): string {
		// 委托专门导出器保存当前分支 JSONL，返回实际路径。
		return exportSessionToJsonl(this.sessionManager, outputPath);
	}

	/**
	 * Ask the current model to describe what went wrong in this session for a bug report.
	 * Used when the user declines to share the transcript itself.
	 */
	/**
	 * 让当前模型为错误报告总结会话，返回摘要文字 Promise；无模型则抛错。
	 * 复用摘要认证、当前有效消息、提示 hint、取消与重试策略；会调用模型但不在这里上传报告或分享原始会话。例：用户选择摘要报告时生成可查看的说明。
	 */
	async summarizeForBugReport(options: { hint?: string; signal: AbortSignal }): Promise<string> {
		// 先读当前选择，摘要可以按虚拟模型进一步路由。
		const model = this.model;
		// 没有选中模型就无法生成错误报告摘要。
		if (!model) {
			// 抛明确错误，尚未发摘要请求。
			throw new Error("No model selected");
		}
		// 调用模型生成报告摘要，不在这里发布/发送报告给第三方。
		return generateBugReportSummary({
			// 先解析实际模型、思考级别与符合流函数策略的认证。
			...(await this._getSummarizationRequestAuth(model, options.signal)),
			// 只提供当前有效消息，不自动发整棵原始会话树。
			messages: this.messages,
			// 用户提供的错误线索，可缺省。
			hint: options.hint,
			// 使用调用者必传的取消信号。
			signal: options.signal,
			// 沿用会话流函数的 SDK/网络行为。
			streamFn: this.agent.streamFunction,
			// 沿用重试预算与退避设置。
			retry: this.settingsManager.getRetrySettings(),
			// 错误报告摘要传 sessionId，区别于 _runDefaultCompaction 的显式 undefined。
			sessionId: this.sessionId,
		});
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	/**
	 * 倒序找到最近 assistant，跳过无内容的 aborted，拼接其中 text 块并 trim，返回文字或 undefined。
	 * 不拼思考或工具调用，不继续向前找第二条有文字回复。例：最近回复只有 toolCall，结果可为 undefined，适用于 /copy 读取最新回复。
	 */
	getLastAssistantText(): string | undefined {
		// 先取得当前有效消息，再以数组副本倒查。
		const lastAssistant = this.messages
			// slice() 浅复制，避免 reverse 改原历史顺序。
			.slice()
			// 反转副本，让 find 命中最近符合项。
			.reverse()
			// find 返回第一个符合者，之后不会再找更早有文字的回复。
			.find((m) => {
				// 非 assistant 直接跳过。
				if (m.role !== "assistant") return false;
				// 沿用既有兼容类型断言，消息对象未复制。
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				// 只跳过“取消且完全没内容”；取消但已有部分内容仍可选。
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				// 其他 assistant 即被选中，即使正文只有思考/工具块。
				return true;
			});

		// 没找到任何符合 assistant 时无可复制文字。
		if (!lastAssistant) return undefined;

		// 累计可展示 text 块，不加入 thinking 内容。
		let text = "";
		// 遍历被选中回复内容，类型断言不改变块本身。
		for (const content of (lastAssistant as AssistantMessage).content) {
			// 只有 text 块有 .text，其他类型忽略。
			if (content.type === "text") {
				// 直接连接多个文字块，不额外插换行。
				text += content.text;
			}
		}

		// 去首尾空白后为空返回 undefined；不会继续寻找更老回复。
		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	/**
	 * 为替换后的会话创建命令上下文，复制属性描述符以保留 getter，再覆盖可等待的发送函数。
	 * 返回新对象；例：withSession 回调里的新 ctx.sendUserMessage 可 await 本会话发送，不沿用旧失效 ctx；复制描述符不是深复制数据。
	 */
	createReplacedSessionContext(): ReplacedSessionContext {
		// 复制扩展命令 ctx 的全部自有描述符，保留 getter 与属性特征。
		const context = Object.defineProperties(
			// 用新空对象承载描述符，避免直接改 runner 原上下文。
			{},
			// getOwnPropertyDescriptors 不是展开求值，因此动态 getter 能继续保留。
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
			// 断言新对象满足替换会话上下文，后面补两个 Promise 发送能力。
		) as ReplacedSessionContext;
		// 覆盖为直接返回 Promise 的 custom 发送路径，便于 withSession 中 await。
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		// 用户消息发送也可等待，区别于 _bindExtensionCore 的 fire-and-report 绑定。
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		// 返回绑定当前会话的新 ctx，不复用旧会话已失效 ctx。
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	/**
	 * 询问当前扩展运行器是否有某事件的处理器，返回 boolean；不发事件。例：界面可先查 session_before_tree 是否有人监听。
	 */
	hasExtensionHandlers(eventType: string): boolean {
		// 只查是否有处理器，不派发也不等待扩展。
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	/**
	 * 返回当前扩展运行器引用，供宿主接 UI/错误处理等；reload 后该引用可能被替换。例：不要把旧 runner 当作永久有效的会话上下文。
	 */
	get extensionRunner(): ExtensionRunner {
		// 直接返回当前 runner，reload 后字段可替换。
		return this._extensionRunner;
	}
}
