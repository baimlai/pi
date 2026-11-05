// 执行已加载扩展的事件处理器并创建会话/工具/命令上下文；每类事件有独立聚合与失败规则，真正会话动作由 AgentSession/宿主绑定。
/**
 * Extension runner - executes extensions and manages their lifecycle.
 */

// AgentMessage 是应用层消息联合，AgentTool 是低层可执行工具形状；这里只导入类型。
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
// 同时导入系统状态重放函数与模型/图片/请求头类型。
import {
	// 把历史 system 增量重放成当前完整提示词/工具，恢复 context 扩展裁剪后的系统状态。
	getCurrentSystemMessage,
	// 图片输入内容块类型。
	type ImageContent,
	// 聊天模型元数据，已有 any 泛型兼容不同 API。
	type Model,
	// 原生供应商对象，包含认证/目录/请求实现。
	type Provider,
	// 请求头值允许 null 删除标记，不等同纯字符串字典。
	type ProviderHeaders,
	// 这些类型/函数来自公共 pi-ai 入口。
} from "@earendil-works/pi-ai";
// 快捷键字串类型，后面运行时仍按小写规范匹配。
import type { KeyId } from "@earendil-works/pi-tui";
// Theme 为类型，theme 是当前主题运行值；无 UI 桩的 getter 动态读取后者。
import { type Theme, theme } from "../../modes/interactive/theme/theme.ts";
// 缓存保温决策的 warm/stop 类型。
import type { CacheWarmingAction } from "../cache-warmer.ts";
// 快捷键等资源冲突的诊断结构类型。
import type { ResourceDiagnostic } from "../diagnostics.ts";
// 已解析键绑定配置，支持单个键、键数组或缺省。
import type { KeybindingsConfig } from "../keybindings.ts";
// 模型/认证注册兼容层的类型，本 runner 不直接创建模型运行时。
import type { ModelRegistry } from "../model-registry.ts";
// 会话模型循环候选结构。
import type { ScopedModel } from "../model-resolver.ts";
// 历史管理器依赖类型，用于扩展只读/命令上下文适配。
import type { SessionManager } from "../session-manager.ts";
// 系统提示词选项、规范化与渲染入口集中从同一模块导入。
import {
	// 调用方可提供的基础提示词构造选项。
	type BuildSystemPromptOptions,
	// 将当前选项渲染成完整系统提示词字符串。
	buildSystemPrompt,
	// 规范化后各默认字段已齐全的选项类型。
	type NormalizedBuildSystemPromptOptions,
	// 为选项补齐默认结构，before_agent_start 的多个处理器共同修改其结果。
	normalizeBuildSystemPromptOptions,
	// 以上符号来自 system-prompt 模块。
} from "../system-prompt.ts";
// 底层虚拟模型定义，route 执行与注册不同阶段。
import type { VirtualModelDefinition } from "../virtual-models.ts";
// 下面全是扩展契约类型；真实事件行为由本文件各 emit 方法分别实现。
import type {
	// 最终收尾前边界事件，允许草稿与继续决定。
	AgentBeforeSettleEvent,
	// 由空闲自定义消息触发的运行前事件。
	BeforeAgentStartCustomEvent,
	// 用户/custom 两种运行前事件联合。
	BeforeAgentStartEvent,
	// 运行前处理器返回的附加消息/完整提示词覆盖。
	BeforeAgentStartEventResult,
	// 由用户输入触发的运行前事件。
	BeforeAgentStartUserEvent,
	// 完全组装后的请求头事件，处理器原地修改。
	BeforeProviderHeadersEvent,
	// 供应商请求体变换事件，载荷为 unknown。
	BeforeProviderRequestEvent,
	// 边界草稿应用后的消息与 canContinue 预览结构。
	BoundaryContextPreview,
	// 边界处理器可替换 entries/continue 的返回形状。
	BoundaryResult,
	// 保温策略事件，带原建议 action。
	CacheWarmingDecisionEvent,
	// 扩展可选的保温 action 覆盖结果。
	CacheWarmingDecisionEventResult,
	// 异步触发压缩时的回调/额外说明配置。
	CompactOptions,
	// 只含非 system 会话的上下文事件。
	ContextEvent,
	// 上下文处理器可选返回消息数组。
	ContextEventResult,
	// 上下文窗口占用展示类型，tokens 允许未知 null。
	ContextUsage,
	// 包含 system 的完全上下文事件。
	ContextWithSystemEvent,
	// custom 状态条目显示函数类型。
	EntryRenderer,
	// 嵌套工具调用配置，含 signal/onUpdate。
	ExecuteToolOptions,
	// 加载后的单扩展注册表结构。
	Extension,
	// 宿主提供的 pi.* 动作函数集合。
	ExtensionActions,
	// 命令处理器可控制会话的增强上下文。
	ExtensionCommandContext,
	// 宿主提供的命令上下文动作，可能未绑定。
	ExtensionCommandContextActions,
	// 普通事件处理器上下文接口。
	ExtensionContext,
	// 宿主提供的 ctx.* 动作集合。
	ExtensionContextActions,
	// 来源/事件/错误文字组成的扩展错误结构。
	ExtensionError,
	// 所有公共扩展事件的联合类型。
	ExtensionEvent,
	// 扩展 CLI 参数声明结构。
	ExtensionFlag,
	// tui/rpc/json/print 四类扩展宿主模式。
	ExtensionMode,
	// loader 创建、runner 绑定动作的共享 runtime。
	ExtensionRuntime,
	// 快捷键定义与来源类型。
	ExtensionShortcut,
	// 带 tools/executeTool 能力的工具执行上下文。
	ExtensionToolContext,
	// 宿主提供的 UI 方法契约，print 可使用无操作实现。
	ExtensionUIContext,
	// 用户输入事件，携带文字/图片/来源。
	InputEvent,
	// 输入处理器 continue/transform/handled 三类结果。
	InputEventResult,
	// 输入来源字面量联合。
	InputSource,
	// 成功扩展、加载问题与共享 runtime 的聚合结构。
	LoadExtensionsResult,
	// 交互 Markdown 显示变换函数类型。
	MarkdownTransformer,
	// 消息完成时可改写的事件。
	MessageEndEvent,
	// 消息完成处理器的可选替换结果。
	MessageEndEventResult,
	// custom_message 的界面渲染函数类型。
	MessageRenderer,
	// 信任决策阶段专用受限上下文，不是完整会话 ctx。
	ProjectTrustContext,
	// 目标项目 cwd 的信任事件。
	ProjectTrustEvent,
	// yes/no/undecided 与可选记住决定的结果。
	ProjectTrustEventResult,
	// 配置式供应商注册声明。
	ProviderConfig,
	// 命令原名、来源、handler 等登记信息。
	RegisteredCommand,
	// 工具定义与来源捆绑后的登记信息。
	RegisteredTool,
	// 替换会话成功后传 withSession 的新上下文。
	ReplacedSessionContext,
	// 为同名命令分配唯一 invocationName 后的结构。
	ResolvedCommand,
	// 启动/reload 后补充资源的发现事件。
	ResourcesDiscoverEvent,
	// 扩展返回额外 skill/prompt/theme 路径。
	ResourcesDiscoverResult,
	// 压缩前可取消或提供替代摘要的返回类型。
	SessionBeforeCompactResult,
	// 分叉前可取消结果。
	SessionBeforeForkResult,
	// 会话切换前可取消结果。
	SessionBeforeSwitchResult,
	// 会话树导航前可取消/改摘要等结果。
	SessionBeforeTreeResult,
	// custom/context_edit/compaction 等边界草稿联合。
	SessionBoundaryDraft,
	// 退出/reload/切换前关闭事件。
	SessionShutdownEvent,
	// 执行前工具事件，参数已经走过低层初次校验。
	ToolCallEvent,
	// 阻止/终止批次的工具前置结果。
	ToolCallEventResult,
	// 工具调用/结果的显示实现子集。
	ToolRenderers,
	// 执行后工具结果事件。
	ToolResultEvent,
	// 结果内容/详情/状态/用量可选覆盖字段。
	ToolResultEventResult,
	// 每个低层回合末尾的边界事件。
	TurnEndEvent,
	// 扩展 UI 阻塞对话种类。
	UIPromptKind,
	// 用户手动 shell 请求事件，区别于模型 bash 工具。
	UserBashEvent,
	// 替换手动 shell 的 operations/result 互斥结果。
	UserBashEventResult,
	// 以上类型通过统一 types.ts 保持公开 API 与执行层一致。
} from "./types.ts";

// Extension shortcuts compete with canonical keybinding ids from keybindings.json.
// Only editor-global shortcuts are reserved here. Picker-specific bindings are not.
// 只有这些全局编辑器动作绑定的键不能被扩展覆盖；列表存动作 id，实际键从用户配置解析，未硬编码具体按键。
const RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = [
	// 保护中断当前操作的动作。
	"app.interrupt",
	// 保护清空编辑器/显示的应用动作。
	"app.clear",
	// 保护应用退出动作。
	"app.exit",
	// 保护终端挂起动作。
	"app.suspend",
	// 保护思考级别循环动作。
	"app.thinking.cycle",
	// 保护向前循环模型动作。
	"app.model.cycleForward",
	// 保护向后循环模型动作。
	"app.model.cycleBackward",
	// 保护模型选择器动作。
	"app.model.select",
	// 保护工具输出展开动作。
	"app.tools.expand",
	// 保护思考显示切换动作。
	"app.thinking.toggle",
	// 保护外部编辑器动作。
	"app.editor.external",
	// 保护复制消息动作。
	"app.message.copy",
	// 保护把消息排成 follow-up 的动作。
	"app.message.followUp",
	// 保护通用输入提交动作。
	"tui.input.submit",
	// 保护选择确认动作。
	"tui.select.confirm",
	// 保护选择取消动作。
	"tui.select.cancel",
	// 保护通用输入复制动作。
	"tui.input.copy",
	// 保护编辑器删到行尾动作。
	"tui.editor.deleteToLineEnd",
	// as const 保留字面量只读元组类型；不在运行时冻结数组。
] as const;

// Partial 允许只出现已绑定的 KeyId；Record 的值保存动作 id 和是否禁止扩展覆盖。
type BuiltInKeyBindings = Partial<Record<KeyId, { keybinding: string; restrictOverride: boolean }>>;

// 反建实际键到内置动作索引。输入解析后键配置，返回字典，无监听/改配置副作用。
// 归一为键数组、小写键名，保留动作优先；例如两个动作绑定同键，其中一个保留动作始终挡扩展覆盖，不受遍历先后影响。
const buildBuiltinKeybindings = (resolvedKeybindings: KeybindingsConfig): BuiltInKeyBindings => {
	// 初始空字典断言为稀疏键映射，不产生运行时验证。
	const builtinKeybindings = {} as BuiltInKeyBindings;
	// Object.entries 遍历动作 id 与配置键值。
	for (const [keybinding, keys] of Object.entries(resolvedKeybindings)) {
		// 该动作没绑定键就跳过。
		if (keys === undefined) continue;
		// 合法联合可能是单字串或数组，统一成数组便于遍历。
		const keyList = Array.isArray(keys) ? keys : [keys];
		// 名单中的动作禁止覆盖；as readonly string[] 只放宽 includes 的 TS 参数范围。
		const restrictOverride = (RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS as readonly string[]).includes(keybinding);
		// 同一动作可以绑定多个键，逐个建立索引。
		for (const key of keyList) {
			// 键名忽略大小写；as KeyId 告诉 TS 规范后仍按键类型处理。
			const normalizedKey = key.toLowerCase() as KeyId;
			// If multiple actions bind the same key, the reserved action wins so extensions
			// remain blocked by reserved shortcuts regardless of iteration order.
			// 读该物理键此前映射的动作。
			const existing = builtinKeybindings[normalizedKey];
			// 此前已被保留动作占用且这次非保留，就不覆盖。
			if (existing?.restrictOverride && !restrictOverride) continue;
			// 其余情况写本次动作，保留动作可覆盖非保留；同级后项胜出。
			builtinKeybindings[normalizedKey] = {
				// 记录原动作 id，供冲突提示说明用途。
				keybinding,
				// 记录扩展是否必须让位。
				restrictOverride,
			};
		}
	}
	// 返回索引，不改输入键配置。
	return builtinKeybindings;
};

// 校验 user_bash 扩展返回值的运行时边界。输入 unknown，返回 boolean 并收窄联合类型，不执行命令。
// 必须恰有 operations/result 一项；operations 至少有 exec 函数，result 检查必要输出字段。例如同时给两项直接 false，这不是深度验证所有自定义操作实现。
function isUserBashEventResult(value: unknown): value is UserBashEventResult {
	// 拒绝非对象或 null，数组仍可能继续接受下方字段检查。
	if (typeof value !== "object" || value === null) return false;
	// as 允许按字串键读外部对象，不代替下面实际判断。
	const candidate = value as Record<string, unknown>;
	// 是否提供非 undefined operations。
	const hasOperations = candidate.operations !== undefined;
	// 是否提供非 undefined result。
	const hasResult = candidate.result !== undefined;
	// 两者都给或都没给都不是合法互斥结果。
	if (hasOperations === hasResult) return false;

	// 有 operations 时只检查该路径。
	if (hasOperations) {
		// 取出待验证的自定义操作对象。
		const operations = candidate.operations;
		// 必须是非 null 对象，才能读 exec。
		if (typeof operations !== "object" || operations === null) return false;
		// 至少要求 exec 真是函数；不会在此调用它测试执行。
		return typeof (operations as Record<string, unknown>).exec === "function";
	}

	// 另一合法形态是完整替代 BashResult。
	const result = candidate.result;
	// 替代结果必须是非 null 对象。
	if (typeof result !== "object" || result === null) return false;
	// 转为未知字段字典继续逐字段验证。
	const resultRecord = result as Record<string, unknown>;
	// 以下字段约束全部通过才接受替代结果。
	return (
		// output 必须是文本，空字符串也合法。
		typeof resultRecord.output === "string" &&
		// exitCode 字段必须存在，即使值明确为 undefined。
		"exitCode" in resultRecord &&
		// 退出码允许 undefined 或数字，这里未额外限制整数/有限性。
		(resultRecord.exitCode === undefined || typeof resultRecord.exitCode === "number") &&
		// cancelled 必须是布尔状态。
		typeof resultRecord.cancelled === "boolean" &&
		// truncated 必须是布尔状态。
		typeof resultRecord.truncated === "boolean" &&
		// 完整输出路径可缺省或字符串，不在此确认文件存在。
		(resultRecord.fullOutputPath === undefined || typeof resultRecord.fullOutputPath === "string")
	);
}

/** The message that starts a run: the before_agent_start event without its prompt fields. */
// 运行触发联合，Pick 从用户/custom 事件中只抽取实际输入字段；类型本身不触发事件。
export type BeforeAgentStartTrigger =
	// 用户触发携带 prompt 和可选图片。
	| Pick<BeforeAgentStartUserEvent, "messageType" | "prompt" | "images">
	// custom 触发携带已有自定义消息，二者用 messageType 判别。
	| Pick<BeforeAgentStartCustomEvent, "messageType" | "message">;

/** Combined result from all before_agent_start handlers. */
// before_agent_start 多处理器聚合结果，宿主收到后才构造实际运行输入。
interface BeforeAgentStartCombinedResult {
	// NonNullable 去掉可选 message 的 undefined，再装成数组，允许多处理器各加一条。
	messages: NonNullable<BeforeAgentStartEventResult["message"]>[];
	// 所有处理器共同修改后的规范提示词选项。
	systemPromptOptions: NormalizedBuildSystemPromptOptions;
}

/**
 * Events handled by the generic emit() method.
 * Events with dedicated emitXxx() methods are excluded for stronger type safety.
 */
// Exclude 从总事件联合剔除有专门聚合方法的事件，防止用通用 emit 绕过它们语义。
type RunnerEmitEvent = Exclude<
	// 原始联合包括全部 ExtensionEvent。
	ExtensionEvent,
	// 工具前置需 block 短路和错误传播。
	| ToolCallEvent
	// 项目信任需 yes/no 首决定胜出。
	| ProjectTrustEvent
	// 工具结果需逐字段累积覆盖。
	| ToolResultEvent
	// 用户 shell 需互斥结果运行时校验。
	| UserBashEvent
	// 普通上下文需保留/恢复系统状态。
	| ContextEvent
	// 全上下文有独立放开 system 的阶段。
	| ContextWithSystemEvent
	// 保温决策需返回最后一次 action 覆盖。
	| CacheWarmingDecisionEvent
	// 请求体需链式替换 payload。
	| BeforeProviderRequestEvent
	// 请求头需共享对象原地变更。
	| BeforeProviderHeadersEvent
	// 运行前需汇总自定义消息与提示词修改。
	| BeforeAgentStartEvent
	// 消息完成需保持角色的链式替换。
	| MessageEndEvent
	// 资源发现需汇总带来源的路径。
	| ResourcesDiscoverEvent
	// 输入需 handled 短路、transform 串联。
	| InputEvent
	// 回合末边界需草稿及上下文预览。
	| TurnEndEvent
	// 最终收尾边界也走专门 emitBoundary。
	| AgentBeforeSettleEvent
>;

// Extract 从通用事件里抽出四种可取消的 session_before_*，用 type 字段限定。
type SessionBeforeEvent = Extract<
	// 限定候选联合来自普通 emit 支持的事件。
	RunnerEmitEvent,
	// 四种事件分别控制恢复/新建、分叉、压缩、树导航。
	{ type: "session_before_switch" | "session_before_fork" | "session_before_compact" | "session_before_tree" }
>;

// 四种前置结果的联合，执行中以事件类型决定最终静态返回形状。
type SessionBeforeEventResult =
	// 切换前结果可取消。
	| SessionBeforeSwitchResult
	// 分叉前结果可取消并沿用兼容字段。
	| SessionBeforeForkResult
	// 压缩前结果可取消或给自定义摘要。
	| SessionBeforeCompactResult
	// 树导航前可覆盖摘要/指令/标签。
	| SessionBeforeTreeResult;

// 条件类型把具体事件 TEvent 映射到对应结果，编译后擦除，不运行这些三元判断。
type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? // 切换前返回其结果或 undefined。
		SessionBeforeSwitchResult | undefined
	: // 否则检查是否分叉前事件。
		TEvent extends { type: "session_before_fork" }
		? // 分叉前对应结果类型。
			SessionBeforeForkResult | undefined
		: // 否则检查压缩前。
			TEvent extends { type: "session_before_compact" }
			? // 压缩前对应结果类型。
				SessionBeforeCompactResult | undefined
			: // 最后检查树导航前。
				TEvent extends { type: "session_before_tree" }
				? // 树导航前对应结果类型。
					SessionBeforeTreeResult | undefined
				: // 其他普通通知事件不使用返回值。
					undefined;

// 错误观察者函数类型：输入结构化错误，返回 void；本 runner 同步调用它。
export type ExtensionErrorListener = (error: ExtensionError) => void;

// 边界基础事件先剔除由 runner 聚合维护的 entries/continue/context。
type BoundaryBaseEvent =
	// turn_end 的其他回合信息仍由宿主提供。
	| Omit<TurnEndEvent, "entries" | "continue" | "context">
	// agent_before_settle 的 outcome/type 同样保留。
	| Omit<AgentBeforeSettleEvent, "entries" | "continue" | "context">;

// 边界派发结果包含草稿、继续意图、最后有效预览与是否有效。
interface BoundaryDispatchResult {
	// 最终选定的草稿列表，未在 runner 内写入历史。
	entries: SessionBoundaryDraft[];
	// 处理器最终决定是否希望继续，不等于已发送下一请求。
	continue: boolean;
	// 最近一次 buildContext 成功返回的预览。
	context: BoundaryContextPreview;
	// 最后一次预览是否有效；后续处理器可修复之前的无效草稿。
	valid: boolean;
}

// 宿主新建会话回调契约，输入可选父来源/初始化/新上下文函数，返回取消状态 Promise；声明不新建会话。
export type NewSessionHandler = (options?: {
	// 可选父会话路径，记录关系而非自动复制历史。
	parentSession?: string;
	// 初始化回调接新 SessionManager，异步无值返回，可写初始历史。
	setup?: (sessionManager: SessionManager) => Promise<void>;
	// 替换后回调使用新有效 ctx，避免继续操作旧上下文。
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	// 新建由宿主决定是否取消，运行时错误仍可能拒绝。
}) => Promise<{ cancelled: boolean }>;

// 分叉宿主回调类型，例如 before 用户消息可让 UI 回填原问题；这里只声明委托入口。
export type ForkHandler = (
	// 会话树参考条目 id。
	entryId: string,
	// 可选位置 before/at 及替换后新 ctx 回调。
	options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	// 返回是否被扩展/宿主取消，不在类型层保证必定成功。
) => Promise<{ cancelled: boolean }>;

// 会话树导航回调类型，可能附加模型摘要与标签，副作用由 AgentSession 实现。
export type NavigateTreeHandler = (
	// 要导航到的条目 id。
	targetId: string,
	// 摘要开关、补充/替代指令与标签都可缺省。
	options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	// 异步完成后返回取消状态。
) => Promise<{ cancelled: boolean }>;

// 恢复其他 JSONL 的宿主回调契约，不在声明时读文件。
export type SwitchSessionHandler = (
	// 目标会话文件路径。
	sessionPath: string,
	// 恢复后可用新 ctx 继续操作的回调。
	options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	// 返回取消状态 Promise，其他错误可拒绝。
) => Promise<{ cancelled: boolean }>;

// reload 宿主动作无参数、异步无值返回，实际资源重载由宿主实现。
export type ReloadHandler = () => Promise<void>;

// shutdown 宿主动作无参数、同步无值返回，是否退出进程由模式层决定。
export type ShutdownHandler = () => void;

/**
 * Helper function to emit session_shutdown event to extensions.
 * Returns true if the event was emitted, false if there were no handlers.
 */
// 按需发送关闭事件。输入 runner 与关闭原因事件，异步返回是否实际派发；不自行 dispose 会话。
// 例如 runtime 替换前先 await 此函数，扩展可清资源；没监听器直接 false。普通处理器错误由 emit 报诊断后继续。
export async function emitSessionShutdownEvent(
	// 当前即将关闭的扩展运行器，不是新会话实例。
	extensionRunner: ExtensionRunner,
	// 包含 quit/reload/new/resume/fork 和可选目标文件的事件。
	event: SessionShutdownEvent,
	// Promise<boolean> 仅表示有没有处理器，不能当全部外部资源必定已释放的保证。
): Promise<boolean> {
	// 没有 session_shutdown 监听器时省去派发。
	if (extensionRunner.hasHandlers("session_shutdown")) {
		// 等待通用 emit 按顺序执行处理器。
		await extensionRunner.emit(event);
		// 确实尝试派发后返回 true。
		return true;
	}
	// 无处理器返回 false。
	return false;
}

// 为一次事件派发拍处理器数组快照。输入扩展列表/事件名，返回每扩展与函数数组，无执行副作用。
// slice 使派发中新增/退订不改本轮名单；下一次派发才使用新名单，函数和 Extension 对象仍复用。
function snapshotEventHandlers(extensions: Extension[], event: ExtensionEvent["type"]) {
	// map 保留扩展顺序，缺该事件用空数组；只复制处理器数组，不深复制扩展对象。
	return extensions.map((ext) => ({ ext, handlers: ext.handlers.get(event)?.slice() ?? [] }));
}

// 比较两消息列表是否相同引用序列。输入两个数组，返回 boolean，无深比较/修改。
// 数组容器可以不同但同顺序同对象则 true；只改某对象内部 text 也仍可能 true。
function sameMessages(left: AgentMessage[], right: AgentMessage[]): boolean {
	// 先比较长度，再 every 按索引比较对象身份；不是内容 JSON 相等判断。
	return left.length === right.length && left.every((message, index) => message === right[index]);
}

/**
 * Re-attach the prompt and tool state after a `context` handler. Handlers only see the
 * conversation; the system messages belong to Pi. An unchanged conversation keeps every
 * system message in place, so models with mid-conversation support keep their cached
 * prefix. A changed one gets the replayed prompt sections and tool declarations as one
 * leading system message, so pruning, windowing, or slicing from a compaction summary
 * cannot drop them.
 */
// 在 context 处理后恢复系统状态。输入完整当前轨迹、处理器原可见快照与返回列表，返回下一轨迹。
// 若消息引用序列没变保留原 system 增量/缓存前缀；变了就重放系统状态为一条开头 system，再接 returned。这里只重组数组，不发请求，不禁止处理器自行注入其他角色。
function restoreSystemMessages(
	// 包含原 system 增量的完整会话消息。
	current: AgentMessage[],
	// 调用 handler 前给它看的非 system 消息引用快照。
	visible: AgentMessage[],
	// handler 返回或原地增删后的非 system 列表。
	returned: AgentMessage[],
	// 返回值可能复用 current/returned，也可能新建外层数组。
): AgentMessage[] {
	// 引用序列未改时保留全部原 system 位置，内容对象的原地变化仍共享。
	if (sameMessages(returned, visible)) return current;
	// 有修改则重放当前完整系统正文、sections 和工具状态。
	const head = getCurrentSystemMessage(current);
	// 有系统状态就前插合成头，否则直接用 returned；不重新运行 handler。
	return head ? [head, ...returned] : returned;
}

// 在尚未绑定完整会话时派发项目信任。输入预加载扩展结果/事件/受限 ctx，返回首个非 undecided 决定与先前错误。
// 按加载/注册顺序 await；例如首项 undecided 后第二项 yes 结束。处理器异常只收集后继续；as 不验证外部返回 schema，undefined/错误形状可能抛错后被记诊断。
export async function emitProjectTrustEvent(
	// 只使用已经预加载、允许处理信任事件的扩展集合。
	extensionsResult: LoadExtensionsResult,
	// 目标目录与 project_trust 判别字段。
	event: ProjectTrustEvent,
	// 受限 select/confirm/input/notify 上下文，不要求已创建 AgentSession。
	ctx: ProjectTrustContext,
	// 无决定时 result 省略，errors 仍完整返回。
): Promise<{ result?: ProjectTrustEventResult; errors: ExtensionError[] }> {
	// 为信任阶段单独累积结构化错误，不依赖 runner 已绑定。
	const errors: ExtensionError[] = [];
	// 快照事件名单，保证本次派发顺序稳定。
	for (const { ext, handlers } of snapshotEventHandlers(extensionsResult.extensions, "project_trust")) {
		// A single extension may register multiple handlers for the same event.
		// The first project_trust handler that returns yes/no wins; undecided falls through.
		// 单扩展同一事件可有多个 handler，依注册顺序逐个尝试。
		for (const handler of handlers) {
			// 单处理器失败不妨碍后面给出信任决定。
			try {
				// await 同时接受同步与异步返回；断言只约束静态使用，不做合法 yes/no 检查。
				const handlerResult = (await handler(event, ctx)) as ProjectTrustEventResult;
				// 明确 undecided 表示继续问后面的处理器。
				if (handlerResult.trusted === "undecided") {
					// 跳过本结果，处理下一 handler。
					continue;
				}
				// 其他结果立即返回；公开契约期望 yes/no，实际这里不再验证字符串枚举。
				return { result: handlerResult, errors };
				// 异常变错误条目，允许后续处理器继续。
			} catch (error) {
				// 保留事件/来源/堆栈，交上层信任流程展示。
				errors.push({
					// 指出出错扩展的地址。
					extensionPath: ext.path,
					// 本次事件种类固定为 project_trust。
					event: event.type,
					// 任意 JS 抛出值统一成错误文字。
					error: error instanceof Error ? error.message : String(error),
					// 只有 Error 才读取 stack，其他值不假定有堆栈。
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
	}
	// 所有 handler 都未决定/失败时只有 errors，让上层按存储/默认/UI 策略继续。
	return { errors };
}

// 无对话能力时使用的 UI 桩。每个方法维持接口返回形状，无真实终端交互；hasUI 通过对象身份识别它。
// 例如 print 模式 select 得 undefined、confirm 得 false；不能因方法存在就假定弹窗可用。
const noOpUIContext: ExtensionUIContext = {
	// select 桩接接口允许的参数但忽略，异步返回未选择，不显示菜单。
	select: async () => undefined,
	// confirm 桩异步返回 false，不自动同意任何操作。
	confirm: async () => false,
	// input 桩异步返回没有输入。
	input: async () => undefined,
	// notify 桩无操作，不写 stderr 或弹窗。
	notify: () => {},
	// 终端输入订阅桩返回无操作 off，不安装真实监听。
	onTerminalInput: () => () => {},
	// 状态文字设置桩不修改界面。
	setStatus: () => {},
	// 工作中提示设置桩无操作。
	setWorkingMessage: () => {},
	// 工作加载行显隐桩无操作。
	setWorkingVisible: () => {},
	// 加载指示器配置桩不启动动画。
	setWorkingIndicator: () => {},
	// 隐藏思考标签桩无操作。
	setHiddenThinkingLabel: () => {},
	// widget 桩不创建组件。
	setWidget: () => {},
	// footer 桩不调用传入工厂。
	setFooter: () => {},
	// header 桩不调用传入工厂。
	setHeader: () => {},
	// 标题设置桩不发送终端控制符。
	setTitle: () => {},
	// custom 桩异步返回 undefined；as never 仅适配任意泛型 T，运行时不是一个真实 T 结果。
	custom: async () => undefined as never,
	// 粘贴桩不写编辑器。
	pasteToEditor: () => {},
	// 设置编辑器正文桩无操作。
	setEditorText: () => {},
	// 读取编辑器桩返回空串。
	getEditorText: () => "",
	// 多行编辑器桩异步返回 undefined。
	editor: async () => undefined,
	// 自动补全包装桩不执行工厂。
	addAutocompleteProvider: () => {},
	// 自定义编辑器设置桩不创建组件。
	setEditorComponent: () => {},
	// 无 UI 不提供自定义编辑器工厂。
	getEditorComponent: () => undefined,
	// theme getter 无参数、返回当前主题引用，无副作用；每次访问再读，不固化构造时主题。
	get theme() {
		// 返回模块当前 live theme 值。
		return theme;
	},
	// 主题列表桩返回新空数组。
	getAllThemes: () => [],
	// 主题查找桩返回未找到。
	getTheme: () => undefined,
	// 主题切换桩接名称/对象，返回失败说明，不假装已成功切换。
	setTheme: (_theme: string | Theme) => ({ success: false, error: "UI not available" }),
	// 工具展开状态桩始终 false。
	getToolsExpanded: () => false,
	// 工具展开设置桩无操作。
	setToolsExpanded: () => {},
};

// 已加载扩展执行容器，负责绑定宿主动作、管理旧 ctx、事件聚合与 UI 对话通知；不是 Agent 模型循环本身。
export class ExtensionRunner {
	// 成功加载的扩展列表，遍历顺序决定很多首项/后项规则。
	private extensions: Extension[];
	// loader 创建、所有扩展 API 共同引用的共享 runtime。
	private runtime: ExtensionRuntime;
	// 当前模式提供的 UI 实现或 noOp 桩。
	private uiContext: ExtensionUIContext;
	// 默认扩展模式 print；setUIContext 后更新。
	private mode: ExtensionMode = "print";
	// 本运行器所属会话 cwd。
	private cwd: string;
	// 历史管理器引用，ctx 提供只读接口是 TS 约束，不是运行时深冻结。
	private sessionManager: SessionManager;
	// 兼容模型注册/认证入口，通常包装 ModelRuntime。
	private modelRegistry: ModelRegistry;
	// Set 保存错误观察者，同一函数不会重复登记。
	private errorListeners: Set<ExtensionErrorListener> = new Set();
	// 当前模型读取回调默认无选择，bindCore 替换后才取得真实模型。
	private getModel: () => Model<any> | undefined = () => undefined;
	// 模型循环范围默认空，回调执行时返回当下值。
	private getScopedModels: () => readonly ScopedModel[] = () => [];
	// 未绑定时空闲查询默认 true，正常宿主绑定后按会话 busy/compaction 状态判断。
	private isIdleFn: () => boolean = () => true;
	// 未绑定的 trust 回调默认 true；正常上下文应由宿主明确绑定实际项目状态，不能把默认当授权流程。
	private isProjectTrustedFn: () => boolean = () => true;
	// 当前低层运行 signal 回调，未绑定默认没有。
	private getSignalFn: () => AbortSignal | undefined = () => undefined;
	// 命令等待空闲默认立即完成，不等待真实 Agent。
	private waitForIdleFn: () => Promise<void> = async () => {};
	// 取消动作默认无操作，绑定后由宿主实施。
	private abortFn: () => void = () => {};
	// 默认没有待处理消息，实际由绑定函数提供。
	private hasPendingMessagesFn: () => boolean = () => false;
	// 上下文用量读取默认 undefined，不造假数值。
	private getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	// 压缩默认无操作，真实宿主会启动异步流程并用回调通知。
	private compactFn: (options?: CompactOptions) => void = () => {};
	// 系统提示词默认空串。
	private getSystemPromptFn: () => string = () => "";
	// 基础提示词选项回调默认按本 cwd 生成最小规范结构。
	private getSystemPromptOptionsFn: () => BuildSystemPromptOptions = () =>
		// 只有回调被调用时才规范化，不在字段初始化时构造整个提示词。
		normalizeBuildSystemPromptOptions({ cwd: this.cwd });
	// 嵌套工具执行实现可未绑定；使用其索引访问类型复用公开契约。
	private executeToolFn: ExtensionContextActions["executeTool"];
	// 可调用工具列表默认空数组，之后实时从宿主读取。
	private getCallableToolsFn: () => readonly AgentTool[] = () => [];
	/** Registered MCP servers already reported as unhandled. */
	// 记录已经报告“没有 MCP 连接处理器”的服务器名，避免重复提示。
	private readonly reportedMcpServers = new Set<string>();
	// 未绑定的新会话桩异步返回未取消，不实际创建会话；宿主需绑定才有行为。
	private newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	// 分叉默认桩同样不操作历史。
	private forkHandler: ForkHandler = async () => ({ cancelled: false });
	// 树导航默认桩不改叶子。
	private navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	// 会话切换默认桩不读 JSONL。
	private switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
	// 重载默认桩异步空操作。
	private reloadHandler: ReloadHandler = async () => {};
	// 退出默认桩不退出进程。
	private shutdownHandler: ShutdownHandler = () => {};
	// 最近 getShortcuts 生成的警告列表。
	private shortcutDiagnostics: ResourceDiagnostic[] = [];
	// 命令诊断列表，当前解析实现仅清空未追加冲突警告。
	private commandDiagnostics: ResourceDiagnostic[] = [];
	// 运行器失效消息，非空时 guarded ctx 操作抛错。
	private staleMessage: string | undefined;
	// 嵌套 UI 对话计数，只给最外一层发 start/end。
	private uiPromptDepth = 0;
	// 当前最外层对话的 kind/可选标题，供结束事件配对。
	private activeUIPrompt: { kind: UIPromptKind; title?: string } | undefined;

	// 构造执行容器。输入扩展、runtime、cwd、历史和模型注册器，无异步结果；只保存引用并装无 UI 桩。
	// 例如先 new ExtensionRunner 再 bindCore 注入会话能力；构造本身不执行任何扩展事件或模型请求。
	constructor(
		// 已初始化成功的扩展注册记录。
		extensions: Extension[],
		// 与这些 API 共用的 runtime，后续就地替换其动作字段。
		runtime: ExtensionRuntime,
		// 此运行器所属工作目录。
		cwd: string,
		// 当前会话历史对象。
		sessionManager: SessionManager,
		// 宿主提供的模型兼容注册器。
		modelRegistry: ModelRegistry,
		// 普通构造参数在体内显式赋值，没有使用 TS 参数属性语法。
	) {
		// 保留加载顺序列表引用。
		this.extensions = extensions;
		// 保存共享 runtime，确保已经创建的 API 也能看到绑定后的新动作。
		this.runtime = runtime;
		// 尚无真实 UI 时使用统一空操作对象。
		this.uiContext = noOpUIContext;
		// 保存会话 cwd。
		this.cwd = cwd;
		// 保存历史管理器。
		this.sessionManager = sessionManager;
		// 保存模型注册/认证适配器。
		this.modelRegistry = modelRegistry;
	}

	// 把宿主能力绑定到扩展运行器。输入 pi 动作、ctx 动作和可选模型注册覆写，无返回值；替换桩、注册 MCP 监听并消费 Provider 队列。
	// 逐项注册失败报错误继续，之后 Provider 注册实时生效；例如加载期 registerProvider 到这里才接上模型目录。函数本身不触发普通模型回答。
	bindCore(
		// 公开 pi.sendMessage/getTools 等动作由会话提供。
		actions: ExtensionActions,
		// ctx.model/isIdle/abort 等动态读取和控制由宿主提供。
		contextActions: ExtensionContextActions,
		// 可选模型注册路径覆写；未给则回退 ModelRegistry，已给时宿主可额外刷新当前模型引用。
		providerActions?: {
			// 配置式 Provider 注册动作输入名称/配置，无返回值。
			registerProvider?: (name: string, config: ProviderConfig) => void;
			// 原生 Provider 注册动作输入完整对象。
			registerNativeProvider?: (provider: Provider) => void;
			// 按供应商名移除扩展覆盖的动作。
			unregisterProvider?: (name: string) => void;
			// 虚拟模型定义注册动作，此刻不执行 route。
			registerVirtualModel?: (definition: VirtualModelDefinition) => void;
			// 按 provider/id 注销虚拟入口。
			unregisterVirtualModel?: (provider: string, id: string) => void;
		},
		// 绑定无返回值，会修改共享 runtime 和本 runner 字段。
	): void {
		// Copy actions into the shared runtime (all extension APIs reference this)
		// 把发 custom 消息桩替换为宿主函数引用，尚未发送消息。
		this.runtime.sendMessage = actions.sendMessage;
		// 绑定发用户输入动作。
		this.runtime.sendUserMessage = actions.sendUserMessage;
		// 绑定持久 custom 状态追加动作。
		this.runtime.appendEntry = actions.appendEntry;
		// 绑定会话名设置动作。
		this.runtime.setSessionName = actions.setSessionName;
		// 绑定实时会话名读取。
		this.runtime.getSessionName = actions.getSessionName;
		// 绑定历史条目标签动作。
		this.runtime.setLabel = actions.setLabel;
		// 绑定激活工具名称查询。
		this.runtime.getActiveTools = actions.getActiveTools;
		// 绑定全部工具信息查询。
		this.runtime.getAllTools = actions.getAllTools;
		// 绑定有效设置读取。
		this.runtime.getSettings = actions.getSettings;
		// 绑定工具激活调整。
		this.runtime.setActiveTools = actions.setActiveTools;
		// 绑定动态工具注册后刷新入口。
		this.runtime.refreshTools = actions.refreshTools;
		// 绑定当前命令列表读取。
		this.runtime.getCommands = actions.getCommands;
		// 绑定异步模型选择动作。
		this.runtime.setModel = actions.setModel;
		// 绑定思考级别读取。
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		// 绑定思考级别设置。
		this.runtime.setThinkingLevel = actions.setThinkingLevel;
		// 安装无参 ctx 工厂回调，只有调用 runtime.createContext 时才实际创建对象。
		this.runtime.createContext = () => this.createContext();

		// Context actions (required)
		// 保存动态模型读取函数，后续 getter 执行时使用。
		this.getModel = contextActions.getModel;
		// 保存模型范围读取函数。
		this.getScopedModels = contextActions.getScopedModels;
		// 保存会话空闲判断，真实规则由宿主实现。
		this.isIdleFn = contextActions.isIdle;
		// 保存项目信任状态读取，不在绑定时重新询问信任。
		this.isProjectTrustedFn = contextActions.isProjectTrusted;
		// 保存当前运行 signal 的取得函数。
		this.getSignalFn = contextActions.getSignal;
		// 保存取消动作引用，当前不调用。
		this.abortFn = contextActions.abort;
		// 保存排队消息判断函数。
		this.hasPendingMessagesFn = contextActions.hasPendingMessages;
		// 保存宿主退出动作。
		this.shutdownHandler = contextActions.shutdown;
		// 保存上下文占用查询函数。
		this.getContextUsageFn = contextActions.getContextUsage;
		// 保存异步压缩触发入口（公开签名返回 void）。
		this.compactFn = contextActions.compact;
		// 保存当前有效系统提示词读取函数。
		this.getSystemPromptFn = contextActions.getSystemPrompt;
		// 基础提示词选项读取允许宿主省略，下面给后备。
		this.getSystemPromptOptionsFn =
			// 缺省时安装按 runner cwd 规范化的无参回调，不立即调用它。
			contextActions.getSystemPromptOptions ?? (() => normalizeBuildSystemPromptOptions({ cwd: this.cwd }));
		// 嵌套调用实现可选，createToolContext 会处理缺省情况。
		this.executeToolFn = contextActions.executeTool;
		// 可调用工具读取可选，未给时每次返回空数组。
		this.getCallableToolsFn = contextActions.getCallableTools ?? (() => []);

		// Servers registered from now on reach the extension that connects them right away. Servers
		// registered during loading are read on session_start.
		// 安装无参 MCP 注册变化回调；注册/注销真正发生后才执行，不在此直接连接全部服务器。
		this.runtime.mcpServers.setChangeListener(() => {
			// 发布当时完整服务器列表的事件，void 表示不 await 监听器完成。
			void this.emit({ type: "mcp_servers_change", servers: this.runtime.mcpServers.list() });
			// 随后检查是否有 MCP 连接扩展，没有则报告声明未处理。
			this.reportUnhandledMcpServers();
		});

		// Flush provider registrations queued during extension loading
		// 遍历加载时暂存的配置式注册，保留队列顺序。
		for (const { name, config, extensionPath } of this.runtime.pendingProviderRegistrations) {
			// 单个错误不能阻断其他供应商注册尝试。
			try {
				// 宿主明确提供注册实现时优先用它。
				if (providerActions?.registerProvider) {
					// 调用宿主配置式注册，可能校验并改模型目录。
					providerActions.registerProvider(name, config);
					// 没有宿主覆写时走兼容注册器。
				} else {
					// 由 ModelRegistry 解析/注册配置式 Provider。
					this.modelRegistry.registerProvider(name, config);
				}
				// 本项注册抛错时转结构化扩展错误。
			} catch (err) {
				// 通过同步错误观察者报告，不在这里退出程序。
				this.emitError({
					// 来源使用加载期记录的真实 extensionPath。
					extensionPath,
					// 错误类别标 register_provider。
					event: "register_provider",
					// Error 取 message，其余转字符串。
					error: err instanceof Error ? err.message : String(err),
					// Error 可提供 stack，其他值无堆栈。
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		// 已尝试队列清空，失败项不保留等待自动重试。
		this.runtime.pendingProviderRegistrations = [];
		// 第二队列承载原生 Provider 对象。
		for (const { provider, extensionPath } of this.runtime.pendingNativeProviderRegistrations) {
			// 同样隔离逐项失败。
			try {
				// 原生注册优先宿主覆写。
				if (providerActions?.registerNativeProvider) {
					// 把原对象交宿主，不调用其模型 stream。
					providerActions.registerNativeProvider(provider);
					// 未覆写则走 ModelRegistry 的原生重载。
				} else {
					// 只传 Provider 对象即可识别原生注册。
					this.modelRegistry.registerProvider(provider);
				}
				// 捕获此原生声明的注册异常。
			} catch (err) {
				// 报告给错误观察者，继续下一声明。
				this.emitError({
					// 附原扩展来源。
					extensionPath,
					// 原生/配置式共享 register_provider 错误类别。
					event: "register_provider",
					// 统一读取可显示消息。
					error: err instanceof Error ? err.message : String(err),
					// 可选保留 Error 堆栈。
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		// 清空原生待注册队列，不重复消费。
		this.runtime.pendingNativeProviderRegistrations = [];
		// 本地注册助手接虚拟定义，返回 void；优先宿主覆写，否则兼容注册器，不执行路由。
		// 同一助手也会作为后续 runtime.registerVirtualModel 的直接实现。
		const registerVirtualModel = (definition: VirtualModelDefinition) => {
			// 有宿主虚拟注册动作就使用它。
			if (providerActions?.registerVirtualModel) providerActions.registerVirtualModel(definition);
			// 没有则委托 ModelRegistry 的虚拟注册入口。
			else this.modelRegistry.registerVirtualModel(definition);
		};
		// 按加载期顺序消费虚拟模型声明。
		for (const { definition, extensionPath } of this.runtime.pendingVirtualModelRegistrations) {
			// 单声明异常不阻断后面虚拟项。
			try {
				// 真正注册目录与路由函数引用，但不调用 route。
				registerVirtualModel(definition);
				// 处理非法 id/冲突等注册错误。
			} catch (err) {
				// 发扩展错误通知。
				this.emitError({
					// 保留声明来源路径。
					extensionPath,
					// 虚拟注册使用单独错误类别。
					event: "register_virtual_model",
					// 转换任意抛出值为文字。
					error: err instanceof Error ? err.message : String(err),
					// Error 附堆栈供诊断。
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		// 虚拟待注册队列也在尝试后清空，错误由观察者处理，不在此自动重试。
		this.runtime.pendingVirtualModelRegistrations = [];

		// From this point on, provider registration/unregistration takes effect immediately
		// without requiring a /reload.
		// 安装配置式实时注册回调。输入名称/配置，返回 void；此刻只是替换函数，之后扩展调用时才改目录，错误不再由这段队列循环统一吞掉。
		this.runtime.registerProvider = (name, config) => {
			// 执行回调时优先宿主提供的额外协调逻辑。
			if (providerActions?.registerProvider) {
				// 把名称/配置交宿主。
				providerActions.registerProvider(name, config);
				// 宿主已处理即结束，避免再注册一次。
				return;
			}
			// 没有覆写才直接调兼容 ModelRegistry。
			this.modelRegistry.registerProvider(name, config);
		};
		// 安装原生实时注册回调，接 Provider 对象、返回 void，不调用 Provider.stream。
		this.runtime.registerNativeProvider = (provider) => {
			// 有宿主原生注册入口优先它。
			if (providerActions?.registerNativeProvider) {
				// 把原对象交给宿主登记。
				providerActions.registerNativeProvider(provider);
				// 已处理就结束回调。
				return;
			}
			// 后备路径使用兼容注册器的原生重载。
			this.modelRegistry.registerProvider(provider);
		};
		// 安装实时注销回调，接供应商名、返回 void；实际恢复/移除规则由运行时决定。
		this.runtime.unregisterProvider = (name) => {
			// 宿主可在注销后维护当前模型引用，因此优先使用。
			if (providerActions?.unregisterProvider) {
				// 执行宿主注销。
				providerActions.unregisterProvider(name);
				// 避免同一注销再走后备实现。
				return;
			}
			// 没有宿主入口时用 ModelRegistry 撤扩展覆盖。
			this.modelRegistry.unregisterProvider(name);
		};
		// 复用上面定义的虚拟注册助手，后续 API 调用无需 reload 即可生效。
		this.runtime.registerVirtualModel = registerVirtualModel;
		// 安装虚拟注销回调，接 provider/id，无返回值；只注销目录入口不删除历史选择记录。
		this.runtime.unregisterVirtualModel = (provider, id) => {
			// 有宿主覆写就使用它。
			if (providerActions?.unregisterVirtualModel) providerActions.unregisterVirtualModel(provider, id);
			// 否则交兼容注册器。
			else this.modelRegistry.unregisterVirtualModel(provider, id);
		};
	}

	// 绑定或重置命令专用能力。输入可选宿主动作，无返回值，只替换函数引用。
	// 有动作时安装真实等待/新建/分叉/导航/切换/reload；传 undefined 时回到空操作桩，桩的 cancelled:false 不代表真的执行成功。
	bindCommandContext(actions?: ExtensionCommandContextActions): void {
		// 提供了完整动作对象才启用真实命令控制。
		if (actions) {
			// 保存等待空闲函数，不在此等待。
			this.waitForIdleFn = actions.waitForIdle;
			// 保存新建会话函数。
			this.newSessionHandler = actions.newSession;
			// 保存按条目分叉函数。
			this.forkHandler = actions.fork;
			// 保存树导航函数。
			this.navigateTreeHandler = actions.navigateTree;
			// 保存恢复文件函数。
			this.switchSessionHandler = actions.switchSession;
			// 保存资源重载函数。
			this.reloadHandler = actions.reload;
			// 完成绑定后不再重置为桩。
			return;
		}

		// 清绑定时等待空闲桩立即完成。
		this.waitForIdleFn = async () => {};
		// 新建桩只返回未取消，不创建文件或会话。
		this.newSessionHandler = async () => ({ cancelled: false });
		// 分叉桩不改变历史。
		this.forkHandler = async () => ({ cancelled: false });
		// 导航桩不改变叶子。
		this.navigateTreeHandler = async () => ({ cancelled: false });
		// 恢复桩不读新日志。
		this.switchSessionHandler = async () => ({ cancelled: false });
		// reload 桩异步无操作。
		this.reloadHandler = async () => {};
	}

	// 设置 UI 实现和模式。输入可选 UI/模式，返回 void；真实 UI 被包装以发对话 start/end，没有 UI 用桩。
	// 例如 RPC 可提供远程对话实现，mode 与 hasUI 是两项信息，不能只用方法存在判断可交互。
	setUIContext(uiContext?: ExtensionUIContext, mode: ExtensionMode = "print"): void {
		// 提供对象才包装提示方法；缺省直接使用统一 noOp 引用。
		this.uiContext = uiContext ? this.wrapUIPromptContext(uiContext) : noOpUIContext;
		// 保存模式，默认 print。
		this.mode = mode;
	}

	// 给阻塞 UI 方法加活动通知包装。输入原 UI，返回新对象，不立刻开对话。
	// 保留其他属性，再覆盖 select/confirm/input/editor/custom；例如调用 select 时才进入 withUIPrompt，返回值/失败仍向调用者传播。
	private wrapUIPromptContext(ui: ExtensionUIContext): ExtensionUIContext {
		// 构造新外层 UI 对象。
		return {
			// 先浅复制原 UI 的可枚举属性；若原对象有 getter，展开会在此读取其值。
			...ui,
			// select 回调透传标题/选项/超时等，嵌套无参闭包到实际弹窗阶段才调 ui.select，返回同一选择结果类型。
			select: (title, options, opts) => this.withUIPrompt("select", title, () => ui.select(title, options, opts)),
			// confirm 包装透传标题/正文/配置，异步返回肯定/否定，不在包装时确认。
			confirm: (title, message, opts) => this.withUIPrompt("confirm", title, () => ui.confirm(title, message, opts)),
			// input 包装保留 placeholder 与配置，返回输入或取消结果。
			input: (title, placeholder, opts) =>
				// withUIPrompt 负责通知生命周期，真正输入由 ui.input 提供。
				this.withUIPrompt("input", title, () => ui.input(title, placeholder, opts)),
			// editor 包装接标题/预填，原样委托多行编辑器 Promise。
			editor: (title, prefill) => this.withUIPrompt("editor", title, () => ui.editor(title, prefill)),
			// custom 包装透传组件工厂/选项；没有统一标题，组件何时创建由原 UI 决定。
			custom: (factory, options) => this.withUIPrompt("custom", undefined, () => ui.custom(factory, options)),
		};
	}

	// 协调一层 UI 等待。输入种类/可选标题/无参异步 run，返回保留 T 的 Promise，有开始/结束通知副作用。
	// 只有深度从 0 到 1 发 start，所有嵌套完成后发 end；同步 throw 与 Promise 拒绝都清计数，例如外层 custom 内再调 input 不重复报两套等待状态。
	private withUIPrompt<T>(kind: UIPromptKind, title: string | undefined, run: () => Promise<T>): Promise<T> {
		// 后置 ++ 先比较旧深度是否 0，再增加计数。
		const outerPrompt = this.uiPromptDepth++ === 0;
		// 只有最外层对话记录公共提示状态。
		if (outerPrompt) {
			// 保存原最外层类型/标题，嵌套结束不改其名称。
			this.activeUIPrompt = { kind, title };
			// 调度 start 事件；title 为空串时省略字段，通知不直接 await。
			this.emitUIPromptEvent({ type: "ui_prompt_start", reason: "ui_prompt", kind, ...(title ? { title } : {}) });
		}

		// finish 回调无参/返回，减少深度并在最后一层结束时发通知；由 finally 或同步 catch 触发。
		const finish = () => {
			// 前置 -- 先减计数，只要仍有其他嵌套层就不发 end。
			if (--this.uiPromptDepth > 0) return;
			// 最后归零，避免保留负数状态。
			this.uiPromptDepth = 0;

			// 优先使用外层记录，缺失时用当前参数后备。
			const prompt = this.activeUIPrompt ?? { kind, title };
			// 清掉当前对话记录。
			this.activeUIPrompt = undefined;
			// 调度成对的 end 事件。
			this.emitUIPromptEvent({
				// 结束事件类型。
				type: "ui_prompt_end",
				// 等待原因统一 ui_prompt。
				reason: "ui_prompt",
				// 沿用最外层种类，而不是最后关闭的内层种类。
				kind: prompt.kind,
				// 有非空标题才附上，保持与开始事件一致。
				...(prompt.title ? { title: prompt.title } : {}),
			});
		};

		// 兼容 run 本身同步 throw，而不只是返回拒绝 Promise。
		try {
			// 执行真实 UI 操作，Promise 最终无论成功失败都 finish，保留原 T 结果或错误。
			return run().finally(finish);
			// run 在返回 Promise 前同步失败时走这里。
		} catch (err) {
			// 同步错误也必须释放深度并通知结束。
			finish();
			// 清理后重新抛原异常，不伪造用户取消结果。
			throw err;
		}
	}

	// 将 UI 通知放到微任务。输入 start/end 事件，返回 void；不等待所有监听器。
	// 例如同步弹窗开始/结束先排队，可避免立刻递归进入事件处理；错误由普通 emit 的规则处理。
	private emitUIPromptEvent(event: Extract<RunnerEmitEvent, { type: "ui_prompt_start" | "ui_prompt_end" }>): void {
		// queueMicrotask 注册无参回调，在当前调用栈结束后运行。
		queueMicrotask(() => {
			// 发通知但不 await；若错误观察者自身抛错，本方法没有额外 catch。
			void this.emit(event);
		});
	}

	// 读取包装后的 UI。无参数，返回当前对象引用，无弹窗；例如宿主可取方法供扩展使用。
	getUIContext(): ExtensionUIContext {
		// 直接返回引用，不再包装或复制。
		return this.uiContext;
	}

	// 判断是否绑定真实 UI。无输入，返回 boolean，无副作用；仅比较是否 noOp 引用，不逐方法验证能力。
	hasUI(): boolean {
		// 只要不是统一桩即视为有 UI，模式仍需另查。
		return this.uiContext !== noOpUIContext;
	}

	// 列已加载扩展的展示路径。无输入，返回新字符串数组，不扫描磁盘；顺序同加载列表。
	getExtensionPaths(): string[] {
		// map 只取 path，保留原显示/合成名称。
		return this.extensions.map((e) => e.path);
	}

	/** Get all registered tools from all extensions (first registration per name wins). */
	// 合并扩展工具。无输入，返回 RegisteredTool 新数组；跨扩展同名只保留加载顺序首项，不执行工具。
	// 同一扩展 Map 内同名注册早已被后 set 替换；AgentSession 随后还可用 SDK 同名工具覆盖本列表。
	getAllRegisteredTools(): RegisteredTool[] {
		// 以最终工具名字建局部去重 Map。
		const toolsByName = new Map<string, RegisteredTool>();
		// 按扩展加载顺序遍历，不是按注册墙钟时间全局排序。
		for (const ext of this.extensions) {
			// 按该扩展 tools Map 插入顺序取工具。
			for (const tool of ext.tools.values()) {
				// 名字已被前扩展占用就跳过。
				if (!toolsByName.has(tool.definition.name)) {
					// 只登记第一次跨扩展出现的同名项。
					toolsByName.set(tool.definition.name, tool);
				}
			}
		}
		// Array.from 复制列表容器，工具定义/来源对象仍共享。
		return Array.from(toolsByName.values());
	}

	/** Get a tool definition by name. Returns undefined if not found. */
	// 按名取扩展工具定义。输入名称，返回首个匹配 definition 或 undefined，无执行副作用。
	// 例如 A/B 同名 read，A 在加载列表靠前则取 A；返回原定义不是深副本。
	getToolDefinition(toolName: string): RegisteredTool["definition"] | undefined {
		// 按加载顺序查找。
		for (const ext of this.extensions) {
			// 本扩展 Map 可能没有这个名字。
			const tool = ext.tools.get(toolName);
			// 遇到第一项就停止搜索。
			if (tool) {
				// 只返回定义字段，不返回其来源记录。
				return tool.definition;
			}
		}
		// 所有扩展都没有则 undefined。
		return undefined;
	}

	// 合并 CLI 参数声明。无输入，返回新 Map，同名由加载顺序首扩展胜出；不改变共享参数值。
	// 例如多个扩展都声明 verbose，帮助只采用前者的说明。
	getFlags(): Map<string, ExtensionFlag> {
		// 独立 Map 防止改返回 Map 直接改扩展声明表。
		const allFlags = new Map<string, ExtensionFlag>();
		// 逐加载扩展遍历。
		for (const ext of this.extensions) {
			// 解构每项参数名与声明。
			for (const [name, flag] of ext.flags) {
				// 只接收尚未登记的名称。
				if (!allFlags.has(name)) {
					// 保存首项声明引用，不复制其字段。
					allFlags.set(name, flag);
				}
			}
		}
		// 返回合并声明表，参数真实值另在 runtime.flagValues。
		return allFlags;
	}

	// 写共享参数值。输入名称和值，无返回值；不检查参数是否被哪个扩展声明，也不校验与声明类别匹配。
	// 供上层 CLI 解析后设置，例如 false 也原样保存；声明边界验证在调用方。
	setFlagValue(name: string, value: boolean | string): void {
		// 直接 Map.set 同名替换，不持久化为设置文件。
		this.runtime.flagValues.set(name, value);
	}

	// 取参数值快照。无输入，返回新 Map，修改其键值不影响共享表；值都是基本类型。
	// 例如 reload 可把此表传给新 runtime 恢复参数。
	getFlagValues(): Map<string, boolean | string> {
		// Map 构造器复制键值对，保留布尔/字符串原值。
		return new Map(this.runtime.flagValues);
	}

	// 解析可生效扩展快捷键。输入最终内置键配置，返回按小写键索引的新 Map；重建冲突诊断，可能 console.warn。
	// 保留内置动作拒扩展；非保留内置可被覆盖；扩展间同键后加载者胜出。例如冲突有警告但工具同名仍是另一套首项规则。
	getShortcuts(resolvedKeybindings: KeybindingsConfig): Map<KeyId, ExtensionShortcut> {
		// 每次重新计算前清旧诊断。
		this.shortcutDiagnostics = [];
		// 反向索引内置真实按键，用户改键后冲突规则跟着变。
		const builtinKeybindings = buildBuiltinKeybindings(resolvedKeybindings);
		// 本轮扩展快捷键索引从空开始。
		const extensionShortcuts = new Map<KeyId, ExtensionShortcut>();

		// 诊断回调输入消息/扩展地址，返回 void；保存 warning，没 UI 时同时写控制台。
		// 有 UI 时由宿主读取列表展示，不在这里重复 warn。
		const addDiagnostic = (message: string, extensionPath: string) => {
			// 保留警告级别和来源路径。
			this.shortcutDiagnostics.push({ type: "warning", message, path: extensionPath });
			// 未绑定真实 UI 时才走 console.warn。
			if (!this.hasUI()) {
				// 输出冲突消息，console.warn 通常走 stderr。
				console.warn(message);
			}
		};

		// 按加载顺序处理扩展，影响同键后项胜出。
		for (const ext of this.extensions) {
			// 解构原键名和快捷键定义。
			for (const [key, shortcut] of ext.shortcuts) {
				// 比较键转小写，定义里仍保留原写法。
				const normalizedKey = key.toLowerCase() as KeyId;

				// 查看是否撞到某内置绑定。
				const builtInKeybinding = builtinKeybindings[normalizedKey];
				// 禁止覆盖的内置动作优先保留。
				if (builtInKeybinding?.restrictOverride === true) {
					// 追加“跳过扩展快捷键”警告。
					addDiagnostic(
						// 消息带原键及来源，不自动重绑定其他键。
						`Extension shortcut '${key}' from ${shortcut.extensionPath} conflicts with built-in shortcut. Skipping.`,
						// 诊断归属当前快捷键扩展。
						shortcut.extensionPath,
					);
					// 跳过这项，不进入扩展 Map。
					continue;
				}

				// 内置动作允许覆盖时可以生效，但仍要报告冲突。
				if (builtInKeybinding?.restrictOverride === false) {
					// 记录本次扩展将替代内置键用途的警告。
					addDiagnostic(
						// 提示内置动作 id 和最终使用的扩展来源。
						`Extension shortcut conflict: '${key}' is built-in shortcut for ${builtInKeybinding.keybinding} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						// 警告归属当前扩展。
						shortcut.extensionPath,
					);
				}

				// 再看是否有更早扩展占相同小写键。
				const existingExtensionShortcut = extensionShortcuts.get(normalizedKey);
				// 已有扩展项时也应提示将被覆盖。
				if (existingExtensionShortcut) {
					// 追加两个扩展之间的冲突诊断。
					addDiagnostic(
						// 消息明确列原持有者与新的胜出者。
						`Extension shortcut conflict: '${key}' registered by both ${existingExtensionShortcut.extensionPath} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						// 归属后来的扩展，便于定位覆盖来源。
						shortcut.extensionPath,
					);
				}
				// 写入当前项，Map.set 覆盖先前扩展同键，顺序仍保留该键第一次插入位置。
				extensionShortcuts.set(normalizedKey, shortcut);
			}
		}
		// 返回最终生效索引，尚未安装键盘监听或调用任何 handler。
		return extensionShortcuts;
	}

	// 取最近快捷键诊断。无输入，返回内部数组引用，无重新计算；例如 UI 在 getShortcuts 后读取 warning。
	getShortcutDiagnostics(): ResourceDiagnostic[] {
		// 不是数组副本，调用者应只读使用。
		return this.shortcutDiagnostics;
	}

	// 使运行器与共享 runtime 失效。输入可选说明，无返回值；非空首次消息才写入，后续 guarded ctx 操作抛错。
	// 例如 reload 后旧命令 ctx 不能再 newSession；共享 runtime 同时清追踪总线订阅，但不通用回滚外部副作用。
	invalidate(
		// 默认长文案解释替换后应使用 withSession 新 ctx；这里只设置错误文字。
		message = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		// 同步无值返回，不等待异步请求停止。
	): void {
		// 已有非空 staleMessage 不再替换首次失效理由。
		if (!this.staleMessage) {
			// 记录该 runner 的旧实例错误说明。
			this.staleMessage = message;
			// 共享 API 也标失效并清总线订阅，不能只禁止 ctx getter。
			this.runtime.invalidate(message);
		}
	}

	// 检查本 runner 是否仍可用。无输入/返回，失效则同步抛错；不检测底层网络状态。
	// 例如保存的旧 ctx.model getter 会在读前调用它。
	private assertActive(): void {
		// 非空错误消息表示运行器已经过期。
		if (this.staleMessage) {
			// 抛保存的说明，保持“旧上下文”错误含义。
			throw new Error(this.staleMessage);
		}
	}

	// 订阅扩展错误。输入监听函数，返回 off，不马上通知。
	// Set 同函数只保存一次，off 通过 delete 移除；观察者若自己抛错，本 runner 不再隔离它。
	onError(listener: ExtensionErrorListener): () => void {
		// 将函数引用加入 Set。
		this.errorListeners.add(listener);
		// 无参 off 删除监听；运行时实际返回 delete 的 boolean，公开签名 void 表示调用者不依赖该值。
		return () => this.errorListeners.delete(listener);
	}

	// 同步广播错误。输入结构化错误，无返回值，不打印默认日志；观察者抛错会向调用方传播。
	// 例如一个扩展 handler 出错后由宿主监听器展示，尚无人监听时此函数不输出。
	emitError(error: ExtensionError): void {
		// 按 Set 插入顺序调用当前错误观察者，未做快照复制。
		for (const listener of this.errorListeners) {
			// 实际调用 listener，传同一个错误对象引用。
			listener(error);
		}
	}

	/**
	 * Report registered MCP servers when no extension handles `mcp_servers_change`, which means
	 * nothing connects them (for example when another MCP extension replaced the built-in one).
	 */
	// 报告无人连接的 MCP 声明。无输入/返回，可能同步发错误通知；按服务器名去重，不实际连接服务器。
	// 只要存在 mcp_servers_change handler 就不报告，不能据此证明 handler 连接成功。
	reportUnhandledMcpServers(): void {
		// 任何已加载扩展声明该事件就认为有人接管 MCP。
		if (this.hasHandlers("mcp_servers_change")) return;
		// 遍历当前已提交注册表的服务器快照。
		for (const server of this.runtime.mcpServers.list()) {
			// 同名已经报过则跳过；后续注销再同名注册也仍被该 Set 记住。
			if (this.reportedMcpServers.has(server.name)) continue;
			// 先记已报告，避免重复回调引起重复提示。
			this.reportedMcpServers.add(server.name);
			// 给宿主发具体未处理错误。
			this.emitError({
				// 归属服务器登记的扩展来源。
				extensionPath: server.extensionPath,
				// 类别保留为 register_mcp_server，便于关联声明。
				event: "register_mcp_server",
				// 提示可能内置 MCP 被替换，但没有断言唯一原因。
				error: `MCP server "${server.name}" is registered, but no loaded extension connects MCP servers; another extension may have replaced the built-in MCP support`,
			});
		}
	}

	// 判断某事件是否有处理器。输入字符串，返回 boolean，不执行监听函数；例如资源发现为空时可直接跳过派发。
	hasHandlers(eventType: string): boolean {
		// 逐已加载扩展查其私有事件表。
		for (const ext of this.extensions) {
			// 读取事件数组，可能没注册。
			const handlers = ext.handlers.get(eventType);
			// 数组非空才算有人监听。
			if (handlers && handlers.length > 0) {
				// 找到一个即可 true，不继续遍历。
				return true;
			}
		}
		// 所有扩展都没有有效数组则 false。
		return false;
	}

	// 取得 custom_message 渲染器。输入 customType，返回加载顺序首个函数或 undefined，无实际绘制。
	// 同扩展重复登记已替换，其余扩展同类型不覆盖首项。
	getMessageRenderer(customType: string): MessageRenderer | undefined {
		// 按加载顺序搜索。
		for (const ext of this.extensions) {
			// 本扩展可能没有该类型。
			const renderer = ext.messageRenderers.get(customType);
			// 有函数则立即采用。
			if (renderer) {
				// 返回原回调引用，UI 以后才调用。
				return renderer;
			}
		}
		// 没有渲染器使用上游默认展示方式。
		return undefined;
	}

	// 收集 Markdown 显示变换器。无输入，返回按加载顺序的新数组，不执行变换。
	// 每扩展最多一个字段，flatMap 把缺省项当空列表略过。
	getMarkdownTransformers(): MarkdownTransformer[] {
		// 有变换器就返回单元素列表以摊平，无则 []，不复制函数。
		return this.extensions.flatMap((ext) => (ext.markdownTransformer ? [ext.markdownTransformer] : []));
	}

	/** Renderers of calls to `toolName`: extension resolvers in load order, then `base`. */
	// 解析某工具的显示方法。输入工具名与无参 base 后备，返回渲染器或 undefined；会执行 resolver 链，不执行工具。
	// 按扩展/注册顺序，resolver 可调用 next 取得后层，也可短路不调用；全部委托后才访问 base，例如为未注册工具定制历史展示。
	resolveToolRenderers(toolName: string, base: () => ToolRenderers | undefined): ToolRenderers | undefined {
		// 摊平所有扩展的可选解析器列表。
		const resolvers = this.extensions.flatMap((ext) => ext.toolRenderers ?? []);
		// 递归 resolve 接当前下标，返回剩余链结果，无额外缓存；闭包 next 不提前执行。
		const resolve = (index: number): ToolRenderers | undefined =>
			// 还有解析器就调用它并传 () => resolve(index+1)，到末尾才调 base。
			index < resolvers.length ? resolvers[index](toolName, () => resolve(index + 1)) : base();
		// 从首项开始实际解析。
		return resolve(0);
	}

	// 取得 custom 状态条目渲染器。输入类型，返回首个回调或 undefined；不把该条目加入模型上下文。
	// 例如扩展持久化计数器可在 UI 展示。
	getEntryRenderer(customType: string): EntryRenderer | undefined {
		// 按加载顺序优先查前扩展。
		for (const ext of this.extensions) {
			// 旧扩展可能没有可选 entryRenderers Map。
			const renderer = ext.entryRenderers?.get(customType);
			// 找到函数即可结束。
			if (renderer) {
				// 交 UI 的是函数引用，不在此生成 Component。
				return renderer;
			}
		}
		// 未找到返回 undefined 供 UI 兜底。
		return undefined;
	}

	// 给所有扩展命令分配无歧义调用名。无输入，返回新 ResolvedCommand 数组，不执行命令。
	// 先统计同原名数量，再顺序分配 name:1/name:2，若与现有字面名称撞车继续增后缀；例如两个 review 不采用工具的“首项胜出”规则。
	private resolveRegisteredCommands(): ResolvedCommand[] {
		// 按加载/Map 顺序累积原命令记录。
		const commands: RegisteredCommand[] = [];
		// 统计每个原 name 总出现数。
		const counts = new Map<string, number>();

		// 遍历所有扩展。
		for (const ext of this.extensions) {
			// 读取该扩展登记的命令值。
			for (const command of ext.commands.values()) {
				// 加入列表，复用原命令对象。
				commands.push(command);
				// 已有计数加一，首项从零开始。
				counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
			}
		}

		// 记录当前处理到每个原名的第几次。
		const seen = new Map<string, number>();
		// 记录已经占用的最终调用名，防止后缀与字面命令碰撞。
		const takenInvocationNames = new Set<string>();

		// map 回调输入一个原命令、输出带 invocationName 的浅副本，不改原记录。
		return commands.map((command) => {
			// 计算该原名本次序号，从 1 起。
			const occurrence = (seen.get(command.name) ?? 0) + 1;
			// 更新出现次数计数。
			seen.set(command.name, occurrence);

			// 总数多于一才先用 name:序号，独一原名优先不加后缀。
			let invocationName = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;

			// 最终名字已占用时还要避让，不能只靠原名计数。
			if (takenInvocationNames.has(invocationName)) {
				// 从本次出现序号开始试后缀。
				let suffix = occurrence;
				// do...while 至少尝试一次新后缀。
				do {
					// 先增加编号，再拼候选。
					suffix++;
					// 候选使用原 name，不在已有后缀字串后无穷追加。
					invocationName = `${command.name}:${suffix}`;
					// 撞到已占名称就持续加一，直到当前列表范围内唯一。
				} while (takenInvocationNames.has(invocationName));
			}

			// 标记本次最终调用名已经使用。
			takenInvocationNames.add(invocationName);
			// 返回新对象，保留 handler/来源/说明。
			return {
				// 浅复制原命令所有字段。
				...command,
				// 附最终 invocationName，查找命令时使用它。
				invocationName,
			};
		});
	}

	// 读取模型注册器。无参数，返回同一引用，无认证/刷新；例如工具 ctx 用它查询目录。
	getModelRegistry(): ModelRegistry {
		// 不创建新注册器或凭证存储。
		return this.modelRegistry;
	}

	// 列已解析命令。无输入，返回带唯一调用名的新数组；每次清命令诊断，当前解析实现不另加警告。
	// 例如 UI 列表和 getCommand 都依据同一分配规则。
	getRegisteredCommands(): ResolvedCommand[] {
		// 重置上次命令诊断列表。
		this.commandDiagnostics = [];
		// 执行名字冲突解析，不运行命令 handler。
		return this.resolveRegisteredCommands();
	}

	// 读取最近命令诊断。无参数，返回内部数组，无重新解析；当前通常为空。
	getCommandDiagnostics(): ResourceDiagnostic[] {
		// 直接返回引用，调用方应只读。
		return this.commandDiagnostics;
	}

	// 按最终调用名查命令。输入名称，返回 ResolvedCommand 或 undefined，无执行副作用。
	// 例如同名时要传 review:1；不会自动把模糊前缀匹配到第一项。
	getCommand(name: string): ResolvedCommand | undefined {
		// 重新解析全列表，再 find 精确 invocationName，相同规则确保帮助和执行一致。
		return this.resolveRegisteredCommands().find((command) => command.invocationName === name);
	}

	/**
	 * Request a graceful shutdown. Called by extension tools and event handlers.
	 * The actual shutdown behavior is provided by the mode via bindExtensions().
	 */
	// 请求宿主优雅退出。无输入/返回，立即调绑定 shutdown；默认桩不做事。
	// 扩展处理器可调用它，但实际终端清理/进程退出由模式实现，函数本身不 await 会话 settled。
	shutdown(): void {
		// 调用宿主引用，不在这里硬编码 process.exit。
		this.shutdownHandler();
	}

	// 读取激活工具名。无参数，返回宿主数组；先拒绝旧 runner，再委托共享 runtime。
	// 若尚未 bindCore，动作桩仍会抛未初始化错误。
	getActiveTools(): string[] {
		// 生命周期检查防止用失效会话取数据。
		this.assertActive();
		// 读取当下激活工具，不只列本扩展工具。
		return this.runtime.getActiveTools();
	}

	/**
	 * Create an ExtensionContext for use in event handlers and tool execution.
	 * Context values are resolved at call time, so changes via bindCore/bindUI are reflected.
	 */
	// 创建普通事件上下文。无参数，返回新对象，不立即执行会话动作。
	// getter/方法每次 assertActive，再读取 runner/宿主当下状态；例如旧 ctx 在 reload 后读取 cwd 会抛错。getModel/getScopedModels 函数引用在创建时捕获，函数读取的会话值仍是调用时决定。
	createContext(): ExtensionContext {
		// 保存 this 引用给对象方法/getter 使用，避免它们的 this 变成 ctx。
		const runner = this;
		// 捕获当前绑定的模型 getter 函数，不在这里调用。
		const getModel = this.getModel;
		// 同样捕获模型范围 getter 函数。
		const getScopedModels = this.getScopedModels;
		// 返回数据 getter 与操作函数组成的对象。
		return {
			// ui getter 无参，返回最新包装 UI；访问才检查失效并读取，不弹窗。
			get ui() {
				// 禁止旧 ctx 读取 UI。
				runner.assertActive();
				// 返回 runner 当前 UI 引用。
				return runner.uiContext;
			},
			// mode getter 返回当前 tui/rpc/json/print，不执行模式切换。
			get mode() {
				// 读取模式前检查当前 runner。
				runner.assertActive();
				// 实时读 mode 字段。
				return runner.mode;
			},
			// hasUI getter 返回 UI 桩身份判断结果，不逐项保证全部 UI 方法有功能。
			get hasUI() {
				// 先拒绝旧上下文。
				runner.assertActive();
				// 委托 runner.hasUI，不缓存初始状态。
				return runner.hasUI();
			},
			// cwd getter 无输入，返回本会话目录；例如工具扩展按它解析相对路径，不是进程每次 cwd。
			get cwd() {
				// 先拒绝失效 ctx。
				runner.assertActive();
				// 读取 runner 保存目录，不访问磁盘。
				return runner.cwd;
			},
			// sessionManager getter 返回当前历史引用的只读类型视图，不进行深冻结；读取前检查失效。
			get sessionManager() {
				// 禁止旧 ctx 取得旧历史对象。
				runner.assertActive();
				// 返回宿主传入的管理器，公开接口限制能调用的方法。
				return runner.sessionManager;
			},
			// modelRegistry getter 返回共享模型注册器，无认证网络副作用；旧 ctx 读取会失败。
			get modelRegistry() {
				// 失效检查在引用暴露前。
				runner.assertActive();
				// 返回已有注册器，不创建另一个目录。
				return runner.modelRegistry;
			},
			// model getter 返回调用时模型选择，可 undefined；不代表物理路由已选定或已经发请求。
			get model() {
				// 先确认上下文仍活跃。
				runner.assertActive();
				// 执行创建 ctx 时捕获的读取函数，它通常从会话实时状态取值。
				return getModel();
			},
			// scopedModels getter 返回当前模型循环范围，只读契约不冻结内部对象。
			get scopedModels() {
				// 先检查旧实例。
				runner.assertActive();
				// 调用捕获的范围读取函数，未配置范围通常空数组。
				return getScopedModels();
			},
			// thinkingLevel getter 无输入，返回当下级别；不是已发生的思考用量。
			get thinkingLevel() {
				// 禁止失效会话读取。
				runner.assertActive();
				// 通过共享 runtime 当前绑定动作取得值。
				return runner.runtime.getThinkingLevel();
			},
			// isIdle 方法无输入，返回宿主布尔状态，不等待；正常会话含运行与压缩 busy 判断，但独立手动 bash 不在其 idle 规则中。
			isIdle: () => {
				// 只检查上下文生命周期，不在此刷新 Agent 状态。
				runner.assertActive();
				// 委托宿主实时空闲判断。
				return runner.isIdleFn();
			},
			// isProjectTrusted 方法无参返回实际宿主信任状态，不在这里弹信任对话。
			isProjectTrusted: () => {
				// 先拒绝旧 ctx。
				runner.assertActive();
				// 交绑定实现读取信任状态。
				return runner.isProjectTrustedFn();
			},
			// signal getter 返回当前低层运行信号或 undefined，无参数/副作用；它不是取消控制器。
			get signal() {
				// 信号也不能从陈旧实例读取。
				runner.assertActive();
				// 调用宿主获取当前信号，空闲通常 undefined。
				return runner.getSignalFn();
			},
			// abort 方法无参数/返回，只发宿主取消动作；不会由这个 void 签名保证已完成全部清理。
			abort: () => {
				// 失效 ctx 不能取消新会话。
				runner.assertActive();
				// 真正取消由宿主实现，不在 runner 硬停 JS 代码。
				runner.abortFn();
			},
			// hasPendingMessages 无参返回宿主的待输入判断；正常会话只算展示用 steering/followUp 文字，不囊括所有 custom 缓冲。
			hasPendingMessages: () => {
				// 先检查上下文有效。
				runner.assertActive();
				// 执行宿主查询，不消费队列。
				return runner.hasPendingMessagesFn();
			},
			// shutdown 无参数/返回，委托宿主退出；无绑定时默认桩不做事，不在此硬编码进程退出。
			shutdown: () => {
				// 阻止旧上下文触发当前宿主退出动作。
				runner.assertActive();
				// 调用绑定退出函数，错误原样传播。
				runner.shutdownHandler();
			},
			// getContextUsage 无参返回占用结构或 undefined，不发模型请求；例如刚压缩后 tokens 可以 null。
			getContextUsage: () => {
				// 读取前确认上下文有效。
				runner.assertActive();
				// 实时委托宿主估算/读取用量。
				return runner.getContextUsageFn();
			},
			// compact 回调输入可选指令与完成/失败回调，返回 void；委托异步流程，不 await 其结果。
			// 例如 ctx.compact({onComplete}) 通过回调拿摘要，不应 await void 当压缩已结束。
			compact: (options) => {
				// 旧 ctx 禁止触发压缩。
				runner.assertActive();
				// 具体压缩、模型调用与错误回调由宿主实现承担。
				runner.compactFn(options);
			},
			// getSystemPrompt 无参返回当前有效提示词字符串，无模型调用；before_agent_start 专用 ctx 后面会覆盖这个读取路径。
			getSystemPrompt: () => {
				// 先检查上下文仍有效。
				runner.assertActive();
				// 转给宿主有效提示词读取函数。
				return runner.getSystemPromptFn();
			},
		};
	}

	/**
	 * Create the context for executing the tool call `toolCallId`: the extension context plus
	 * `tools` and `executeTool()`. `signal` is the default signal of nested calls.
	 */
	// 为一条工具调用创建上下文。输入父 toolCallId 与可选默认 signal，返回新扩展 ctx 加 tools/executeTool，不立即执行工具。
	// 例如 codemode 调 read 时自动归入父 id；每个嵌套调用的显式 signal 优先于父信号，未绑定嵌套能力返回 isError 结果。
	createToolContext(toolCallId: string, signal: AbortSignal | undefined): ExtensionToolContext {
		// 保存 runner 供属性描述符 getter/函数闭包引用。
		const runner = this;
		// createContext() returns a fresh object, so adding properties does not affect other contexts.
		// 在新普通 ctx 对象上加描述符，保留已有 guarded getters；as 只拓展 TS 接口，不创建字段。
		return Object.defineProperties(this.createContext() as ExtensionToolContext, {
			// tools 属性描述符定义一个动态 getter。
			tools: {
				// tools getter 无参返回此刻可调用工具列表，不等于模型当前声明列表；不执行工具。
				get() {
					// 先拒绝陈旧上下文。
					runner.assertActive();
					// 让宿主返回 callable 规则筛后的工具，codemode/deferred 可能未声明仍可调用。
					return runner.getCallableToolsFn();
				},
			},
			// executeTool 描述符用 value 放函数，而不是在定义时调用它。
			executeTool: {
				// 嵌套执行函数接名称/unknown 参数/可选配置，返回 Outcome Promise；真正调用时才检查能力并委托低层管线。
				// 例如无嵌套实现返回错误结果而不抛未知能力错误；assertActive 自身仍可同步导致 Promise 拒绝。
				value: async (name: string, args: unknown, options: ExecuteToolOptions = {}) => {
					// 先检查工具所属运行器未失效。
					runner.assertActive();
					// 宿主没有提供执行实现时不能假装工具已经运行。
					if (!runner.executeToolFn) {
						// 构造与标准嵌套结果同形的失败 Outcome。
						return {
							// 用父 id/0 作关联标识，参数对象为空占位，不把 unknown 输入当已验证参数。
							toolCall: { type: "toolCall", id: `${toolCallId}/0`, name, arguments: {} },
							// 失败结果由文本和空详情组成。
							result: {
								// 明确提示当前上下文不支持嵌套工具。
								content: [{ type: "text", text: "Nested tool calls are not available in this context" }],
								// 没有业务详情，使用空对象。
								details: {},
							},
							// 标记 isError:true，调用者按结果而非异常识别此能力缺失。
							isError: true,
						};
					}
					// 实际委托父 id/名字/原参数；对象展开保留 onUpdate 等，最后补 signal，只有未给 signal 才继承父工具信号。
					return runner.executeToolFn(toolCallId, name, args, { ...options, signal: options.signal ?? signal });
				},
			},
		});
	}

	// 创建命令专用 ctx。无输入，返回新对象，增加等待空闲/会话切换/重载方法；创建本身不执行动作。
	// 复制属性描述符保留懒 getter 与失效检查，例如命令 /new 之后旧 ctx 失效，后续工作应放 withSession 新 ctx。
	createCommandContext(): ExtensionCommandContext {
		// Use property descriptors instead of object spread so the guarded getters from
		// createContext() stay lazy. A spread would eagerly read them once and freeze the
		// old values into the returned object, bypassing stale-instance checks.
		// 用 defineProperties 建新对象，避免 {...ctx} 提前读取 getter 固化旧值。
		const context = Object.defineProperties(
			// 目标是空对象，不复用上一命令的 ctx。
			{},
			// 取普通 ctx 全部自有属性描述符，保留 get 与方法属性特征。
			Object.getOwnPropertyDescriptors(this.createContext()),
			// 断言新增方法后符合命令 ctx，运行时不是强制验证。
		) as ExtensionCommandContext;
		// 安装基础提示词选项读取回调，无参返回当前结构；不是已经渲染的完整文本。
		context.getSystemPromptOptions = () => {
			// 旧命令 ctx 读取也必须失败。
			this.assertActive();
			// 委托宿主选项 getter，不自行保存配置。
			return this.getSystemPromptOptionsFn();
		};
		// 安装等待空闲方法，无参返回 Promise；这里只注册，调用时才等待宿主状态。
		context.waitForIdle = () => {
			// 先检查上下文有效。
			this.assertActive();
			// 返回宿主等待 Promise，不强行取消当前回合。
			return this.waitForIdleFn();
		};
		// 新建回调输入可选初始化等配置，返回宿主取消状态 Promise；有历史/资源替换副作用。
		context.newSession = (options) => {
			// 确保不是已被上一切换替换的 ctx。
			this.assertActive();
			// 交宿主新建，不在 runner 自己创建 SessionManager。
			return this.newSessionHandler(options);
		};
		// 分叉回调输入条目 id/位置/withSession，返回宿主 Promise，实际复制/重建由宿主完成。
		context.fork = (entryId, options) => {
			// 旧 ctx 不能继续分叉。
			this.assertActive();
			// 原样透传目标和选项。
			return this.forkHandler(entryId, options);
		};
		// 树导航回调输入目标与摘要/标签选项，返回宿主取消状态 Promise，可能请求摘要模型。
		context.navigateTree = (targetId, options) => {
			// 失效检查在实际导航前。
			this.assertActive();
			// 转交宿主导航实现，不在这里计算分支共同祖先。
			return this.navigateTreeHandler(targetId, options);
		};
		// 恢复回调输入 JSONL 路径与 withSession，返回宿主结果；创建新 ctx 本身尚不读取文件。
		context.switchSession = (sessionPath, options) => {
			// 先拒绝旧上下文。
			this.assertActive();
			// 让宿主打开/检查并替换会话。
			return this.switchSessionHandler(sessionPath, options);
		};
		// 重载方法无输入，返回宿主 Promise；重载成功后此旧 ctx 通常失效，应停止继续使用。
		context.reload = () => {
			// 只允许有效命令 ctx 开始重载。
			this.assertActive();
			// 实际扩展/资源重载由宿主执行。
			return this.reloadHandler();
		};
		// 返回带方法且仍保留动态 getter 的新命令上下文。
		return context;
	}

	// 顺序聚合边界处理器。输入 turn_end/收尾基础事件与草稿预览函数，返回最终草稿/继续意图/预览/有效性，runner 不写历史。
	// 初始空草稿先预览，再每个 handler 后重算；后返回字段替换前字段，不自动拼数组。无效草稿可被后续 handler 修复；最后仍无效返回空草稿与 continue:false，初始 buildContext 异常则直接向外拒绝。
	async emitBoundary(
		// 基础事件由会话提供，含 outcome/回合信息但没聚合状态。
		baseEvent: BoundaryBaseEvent,
		// buildContext 回调可同步或异步，输入候选草稿，返回预览；真正执行时可能校验/构建内存历史。
		buildContext: (entries: SessionBoundaryDraft[]) => BoundaryContextPreview | Promise<BoundaryContextPreview>,
		// 异步结果含 valid，不代表 continue 一定被宿主执行，还需可运行性判断。
	): Promise<BoundaryDispatchResult> {
		// 本轮所有处理器使用一个新普通 ctx。
		const ctx = this.createContext();
		// 初始草稿为空数组，后续可能替换引用。
		let entries: SessionBoundaryDraft[] = [];
		// 初始没有继续意图，显式 false 可覆盖之前 true。
		let shouldContinue = false;
		// 先构建空草稿上下文；这一步在处理器 try 外，失败直接拒绝。
		let context = await buildContext(entries);
		// 初始预览成功就设有效。
		let valid = true;

		// 派发名单快照按扩展/注册顺序，处理中退订不改变本轮列表。
		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, baseEvent.type)) {
			// 依次等待一个处理器后再给下一个最新聚合状态。
			for (const handler of handlers) {
				// 为本 handler 构造当前边界事件对象。
				const event = {
					// 先保留宿主事件字段。
					...baseEvent,
					// 传当前 entries 数组引用；处理器也可能原地改数组。
					entries,
					// 传前面处理器留下的继续意图。
					continue: shouldContinue,
					// 传最近一次成功的草稿投影预览。
					context,
					// 断言为两种边界事件联合，运行时字段来自本次实际 baseEvent。
				} as TurnEndEvent | AgentBeforeSettleEvent;
				// handler 失败时报告，但仍要重新检查当前草稿以防原地修改。
				try {
					// 等待返回可选字段；as 不验证草稿形状，后面 buildContext 承担实际可用性检查。
					const handlerResult = (await handler(event, ctx)) as BoundaryResult | undefined;
					// 字段明确提供就整体替换 entries，包括空数组；不是自动 append。
					if (handlerResult?.entries !== undefined) entries = handlerResult.entries;
					// 明确提供布尔值就覆盖意图，false 不能被当缺省。
					if (handlerResult?.continue !== undefined) shouldContinue = handlerResult.continue;
					// 异常变扩展诊断，不自动撤销 handler 原地改动。
				} catch (err) {
					// 向宿主错误观察者发送失败。
					this.emitError({
						// 记录当前扩展来源。
						extensionPath: ext.path,
						// 保留实际边界事件类别。
						event: baseEvent.type,
						// 统一读取可显示错误消息。
						error: err instanceof Error ? err.message : String(err),
						// Error 附堆栈。
						stack: err instanceof Error ? err.stack : undefined,
					});
				}

				// 无论 handler 成功/失败，都对当前 entries 重算预览。
				try {
					// 真正调用 buildContext，验证并得到这一阶段可见上下文。
					context = await buildContext(entries);
					// 成功可把之前 invalid 恢复为 true，允许后续 handler 修复草稿。
					valid = true;
					// 无效草稿不直接 throw 终止整条链，仍让后续处理器有机会替换。
				} catch (err) {
					// 标记当前草稿无效；context 保持上次成功预览引用。
					valid = false;
					// 报告候选边界条目无效。
					this.emitError({
						// 把失败归属刚执行的扩展。
						extensionPath: ext.path,
						// 错误事件仍是当前边界类别。
						event: baseEvent.type,
						// 附 buildContext 的校验失败原因。
						error: `Invalid boundary entries: ${err instanceof Error ? err.message : String(err)}`,
						// 有 Error 时保存堆栈。
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			}
		}

		// 最后一次预览的有效性决定是否允许把草稿交宿主提交。
		return valid
			? // 有效时返回最终 entries/意图与预览，不在这里写 SessionManager。
				{ entries, continue: shouldContinue, context, valid: true }
			: // 无效时丢弃草稿与继续意图，但附最后有效 context 帮助诊断，不声称它对应无效条目。
				{ entries: [], continue: false, context, valid: false };
	}

	// 识别通用事件是否四类 session_before。输入事件，返回 boolean/TS 类型谓词，无副作用；例如 before_compact 才采用取消结果聚合规则。
	private isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
		// 以下四种 type 任一命中就 true。
		return (
			// 切换/新建会话前。
			event.type === "session_before_switch" ||
			// 分叉前。
			event.type === "session_before_fork" ||
			// 压缩前。
			event.type === "session_before_compact" ||
			// 树导航前。
			event.type === "session_before_tree"
		);
	}

	// 通用通知/会话前置事件派发。输入事件，返回类型随具体事件变化；顺序 await handlers。
	// 普通返回值忽略；四类 before 保存最近真值结果，遇 cancel 真值立刻短路。handler 错误报告后继续，不合并多份 before 结果，例如后 handler 只返回 cancel:false 会替换前面的自定义结果字段。
	async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		// 给本轮新建有效性受保护的 ctx。
		const ctx = this.createContext();
		// 初始没有 before 结果，未返回时保持 undefined。
		let result: SessionBeforeEventResult | undefined;

		// 扩展/处理器列表在事件开始时拍快照。
		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, event.type)) {
			// 按同扩展注册顺序逐个 await。
			for (const handler of handlers) {
				// 单处理器异常不默认阻止生命周期事件。
				try {
					// 实际执行 handler，普通事件也可产生扩展自身副作用。
					const handlerResult = await handler(event, ctx);

					// 只有四类 before 且返回真值时才记录结果；空对象也是真值。
					if (this.isSessionBeforeEvent(event) && handlerResult) {
						// 最近一个结果整体覆盖旧结果，不逐字段深合并。
						result = handlerResult as SessionBeforeEventResult;
						// cancel 真值就立即结束后续处理器，不要求 ===true。
						if (result.cancel) {
							// 泛型断言恢复 TEvent 对应的结果类型，值本身不转换。
							return result as RunnerEmitResult<TEvent>;
						}
					}
					// 普通处理器错误按通知策略收集/发送后继续。
				} catch (err) {
					// 从任意抛出值生成文字。
					const message = err instanceof Error ? err.message : String(err);
					// 只有 Error 有可选 stack。
					const stack = err instanceof Error ? err.stack : undefined;
					// 同步通知宿主错误监听器；监听器自身若抛错仍可能中断派发。
					this.emitError({
						// 当前扩展路径。
						extensionPath: ext.path,
						// 本次事件类型。
						event: event.type,
						// 保留已规范化文字。
						error: message,
						// 保留可选堆栈。
						stack,
					});
				}
			}
		}

		// 无取消则返回最近 before 结果，普通通知通常 undefined。
		return result as RunnerEmitResult<TEvent>;
	}

	/** Returns the event's own action unless a handler overrides it; the last override wins. */
	// 聚合缓存保温决定。输入原始事件，异步返回最终 warm/stop；不直接发保温请求。
	// 起点 event.action，处理器最后一个提供的 action 胜出；后处理器看到的仍是同一 event，不自动把局部 action 写回事件。
	async emitCacheWarmingDecision(event: CacheWarmingDecisionEvent): Promise<CacheWarmingAction> {
		// 新建上下文供决策读取当前会话状态。
		const ctx = this.createContext();
		// 默认采用核心原建议。
		let action = event.action;

		// 按快照顺序遍历决定处理器。
		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, event.type)) {
			// 一个扩展可多次订阅，依序参与。
			for (const handler of handlers) {
				// 决策 handler 异常不直接中止核心保温策略。
				try {
					// 等待可选动作覆盖，断言本身不校验非法 action。
					const result = (await handler(event, ctx)) as CacheWarmingDecisionEventResult | undefined;
					// 只要字段非 undefined 就覆盖，最终一次定义生效。
					if (result?.action !== undefined) action = result.action;
					// 失败报告后继续后面处理器。
				} catch (err) {
					// 发结构化错误通知。
					this.emitError({
						// 归属当前扩展。
						extensionPath: ext.path,
						// 类别 cache_warming_decision。
						event: event.type,
						// 错误统一转文字。
						error: err instanceof Error ? err.message : String(err),
						// Error 可附堆栈。
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			}
		}

		// 返回局部聚合 action，真正 warm/stop 由保温器执行。
		return action;
	}

	// 链式改写完成消息。输入 message_end 事件，返回最终替代消息或 undefined；不在此持久化。
	// 后处理器看前面替换，替换必须同 role；非法角色报错后略过该替换，异常报错继续。示例 assistant 只能替成 assistant，最终上游原地替换原消息对象。
	async emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined> {
		// 创建本轮公共 ctx。
		const ctx = this.createContext();
		// 当前消息从原事件开始，保留对象引用。
		let currentMessage = event.message;
		// 跟踪是否有明确合法替换，不把未返回当已改写。
		let modified = false;

		// 快照所有 message_end 处理器。
		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "message_end")) {
			// 依序等待各 handler。
			for (const handler of handlers) {
				// 处理器/角色检查错误单独隔离。
				try {
					// 每次构造新事件外壳，把当前已替换消息提供给后项。
					const currentEvent: MessageEndEvent = { ...event, message: currentMessage };
					// 等待可选替换结果，不自动深复制 message。
					const handlerResult = (await handler(currentEvent, ctx)) as MessageEndEventResult | undefined;
					// 没返回 message 就继续；处理器对共享消息内部的原地修改仍可能已发生。
					if (!handlerResult?.message) continue;

					// 用原当前 role 检查替换，避免 user 变 assistant 破坏消息语义。
					if (handlerResult.message.role !== currentMessage.role) {
						// 报告角色不合法，不采用这份替换。
						this.emitError({
							// 当前来源扩展。
							extensionPath: ext.path,
							// 错误归属 message_end。
							event: "message_end",
							// 明确要求保持消息角色。
							error: "message_end handlers must return a message with the same role",
						});
						// 跳过此替换，后处理器继续看到旧 currentMessage。
						continue;
					}

					// 合法替换成为后面处理器的新输入。
					currentMessage = handlerResult.message;
					// 标记最终需把替换交上游。
					modified = true;
					// 异常只报告，继续后续链。
				} catch (err) {
					// 规范错误文字。
					const message = err instanceof Error ? err.message : String(err);
					// 可选堆栈。
					const stack = err instanceof Error ? err.stack : undefined;
					// 通知宿主扩展错误观察者。
					this.emitError({
						// 来源路径。
						extensionPath: ext.path,
						// 事件类别。
						event: "message_end",
						// 错误消息。
						error: message,
						// 错误堆栈。
						stack,
					});
				}
			}
		}

		// 只有明确采用过替换才返回它；否则 undefined 让上游保持原对象。
		return modified ? currentMessage : undefined;
	}

	// 链式改写工具结果。输入 tool_result，返回所有最终可覆盖字段或 undefined；不会重新执行工具。
	// 后 handler 看前项修改；字段未给保持已有，但 content 替换却未同时给 structuredContent 会删旧结构结果，避免脱敏文字后仍泄漏旧结构。异常报错后继续，不自动回滚前面的字段修改。
	async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		// 创建当前会话 ctx。
		const ctx = this.createContext();
		// 只浅复制事件外壳，内容数组/详情对象初始仍共享。
		const currentEvent: ToolResultEvent = { ...event };
		// 标记是否采用了任一结果字段覆盖。
		let modified = false;

		// 快照全部 tool_result 订阅。
		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "tool_result")) {
			// 保持扩展及处理器注册顺序。
			for (const handler of handlers) {
				// 逐 handler 错误隔离。
				try {
					// 把已经累计修改的 currentEvent 交下一个，等待可选覆盖。
					const handlerResult = (await handler(currentEvent, ctx)) as ToolResultEventResult | undefined;
					// 没有返回对象就继续；这不是对所有原地对象修改的事务回滚。
					if (!handlerResult) continue;

					// content 明确存在时才替换，空数组也有效。
					if (handlerResult.content !== undefined) {
						// 把新可见内容写到当前事件。
						currentEvent.content = handlerResult.content;
						// Structured content that is not replaced along with the content may no longer match it.
						// 没有同时提供新结构化内容就删除旧字段，防止与新文字不一致。
						if (handlerResult.structuredContent === undefined) delete currentEvent.structuredContent;
						// 标记最终需要返回覆盖。
						modified = true;
					}
					// details 明确提供才更新；undefined 表示保留，null 可作为明确替代值。
					if (handlerResult.details !== undefined) {
						// 替换程序化详情。
						currentEvent.details = handlerResult.details;
						// 记录已有覆盖。
						modified = true;
					}
					// 只有显式提供 structuredContent 才覆盖；undefined 表示沿用当前字段。
					if (handlerResult.structuredContent !== undefined) {
						// 保存新的结构化工具结果；这里只赋值，不验证其符合 outputSchema。
						currentEvent.structuredContent = handlerResult.structuredContent;
						// 记录本次处理器提供了修改。
						modified = true;
					}
					// isError 使用是否为 undefined 判断，所以 false 也能清除之前的错误标记。
					if (handlerResult.isError !== undefined) {
						// 更新结果错误状态。
						currentEvent.isError = handlerResult.isError;
						// 记录错误状态发生了显式覆盖。
						modified = true;
					}
					// usage 显式提供时替换当前用量；这里不累加多个处理器的数字。
					if (handlerResult.usage !== undefined) {
						// 保留最后一次提供的用量对象。
						currentEvent.usage = handlerResult.usage;
						// 标记存在覆盖结果。
						modified = true;
					}
					// 单个处理器抛错后报告并继续后面的处理器；已经发生的原地修改不会回滚。
				} catch (err) {
					// Error 取 message，其他抛出值转成字符串。
					const message = err instanceof Error ? err.message : String(err);
					// 仅 Error 自带堆栈，其他值没有 stack。
					const stack = err instanceof Error ? err.stack : undefined;
					// 通知扩展错误订阅者；错误订阅者自身抛错时本层不会再吞掉。
					this.emitError({
						// 附带出错扩展的路径。
						extensionPath: ext.path,
						// 标明失败的是 tool_result 事件。
						event: "tool_result",
						// 提供可读错误文本。
						error: message,
						// 附带可选堆栈。
						stack,
					});
				}
			}
		}

		// 所有处理器都没有显式覆盖字段时，无须返回一个新的结果对象。
		if (!modified) {
			// undefined 让调用方沿用原工具结果；不等于能撤销共享对象的原地修改。
			return undefined;
		}

		// 把累计后的完整覆盖交回工具执行包装层。
		return {
			// 最终可见内容。
			content: currentEvent.content,
			// 最终程序化详情。
			details: currentEvent.details,
			// 最终结构化内容，可能因内容被替换而清空。
			structuredContent: currentEvent.structuredContent,
			// 最终错误标记。
			isError: currentEvent.isError,
			// 最终用量数据。
			usage: currentEvent.usage,
		};
	}

	// 依次询问 tool_call 处理器是否拦截执行，输入为待执行工具事件，返回首个 block 结果或最后一个普通结果。
	// 例如第一个返回 { block: true, reason: "请先确认" } 就不再调用后续订阅者。这里没有局部 catch，异常交上游处理。
	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		// 为这次派发创建会话上下文；创建本身不会执行工具。
		const ctx = this.createContext();
		// 用联合类型记录可能尚无处理结果。
		let result: ToolCallEventResult | undefined;

		// 固定本次处理器快照，派发过程中新增订阅不插入当前轮。
		for (const { handlers } of snapshotEventHandlers(this.extensions, "tool_call")) {
			// 按注册顺序逐个等待。
			for (const handler of handlers) {
				// 调用并等待处理器；拒绝会直接中断本方法。
				const handlerResult = await handler(event, ctx);

				// 只接纳真值结果，undefined 表示不发表意见。
				if (handlerResult) {
					// 类型断言只告诉编译器把结果看成工具调用结果，不做运行时结构校验。
					result = handlerResult as ToolCallEventResult;
					// block 为真就立即停止询问其他处理器。
					if (result.block) {
						// 把拦截原因和标志交给工具包装层，实际阻止工具由调用方执行。
						return result;
					}
				}
			}
		}

		// 没有拦截时返回最后一个真值结果，也可能是 undefined。
		return result;
	}

	// 询问 user_bash 订阅者接管用户的 !/!! 命令：首个合法结果生效；都返回 undefined 则交回本地执行。
	// 输入为命令事件；返回自定义操作或现成结果。非法结果和处理器错误会报告后重新抛出，防止接管失败又意外执行本地命令。
	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		// 创建当前会话上下文。
		const ctx = this.createContext();

		// 快照本次 user_bash 订阅并保留来源扩展。
		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "user_bash")) {
			// 按订阅顺序尝试接管。
			for (const handler of handlers) {
				// 把接管失败纳入错误报告。
				try {
					// 等待处理器决定是否接管；此时扩展可能已执行自己的外部动作。
					const handlerResult = await handler(event, ctx);
					// 只有 undefined 表示放弃接管并继续；null 等值会进入格式校验。
					if (handlerResult === undefined) continue;
					// 在扩展返回值这个边界检查 operations/result 二选一及其必要字段，不验证命令输出的业务含义。
					if (!isUserBashEventResult(handlerResult)) {
						// 不合法时创建错误，随后走同一报告和重抛路径。
						throw new Error(
							// 错误文本说明：本地执行请返回 undefined，接管则只返回一种合法对象。
							"Invalid user_bash handler result: return undefined for local execution or exactly one valid { operations } or { result } object",
						);
					}
					// 首个合法接管结果直接生效，后续处理器不再执行。
					return handlerResult;
					// 接住处理器异常或格式校验异常。
				} catch (err) {
					// 提取可读错误文本。
					const message = err instanceof Error ? err.message : String(err);
					// 保留 Error 的堆栈信息。
					const stack = err instanceof Error ? err.stack : undefined;
					// 先把错误送给 runner 的错误观察者。
					this.emitError({
						// 标识扩展路径。
						extensionPath: ext.path,
						// 标识 user_bash 阶段。
						event: "user_bash",
						// 传递错误消息。
						error: message,
						// 传递可选堆栈。
						stack,
					});
					// 重抛同一个错误，让上游终止这次 bash 接管流程。
					throw err;
				}
			}
		}

		// 无人接管时返回 undefined；是否本地执行由调用方决定。
		return undefined;
	}

	/**
	 * Run the request-time transforms in two phases. `context` handlers see the conversation
	 * only and Pi restores the prompt and tool state after each; `context_with_system`
	 * handlers then see the full transcript and their output is used as returned.
	 */
	// 按两阶段处理发给模型的消息：先把隐藏 system 的会话交 context，再把完整消息交 context_with_system。
	// 输入消息先 structuredClone，输出是累计处理后的消息数组；单 handler 失败会报告并继续，处理器自己的外部副作用不回滚。例：先删旧工具结果，再在完整阶段补系统指令。
	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		// 创建本次处理所用上下文。
		const ctx = this.createContext();
		// 深拷贝可克隆消息，避免直接改调用者数组/消息；不可克隆值会在进入 handler 循环前抛错。
		let currentMessages = structuredClone(messages);

		// 快照第一阶段 context 处理器。
		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "context")) {
			// 按扩展及注册顺序运行。
			for (const handler of handlers) {
				// 隔离单处理器抛出的异常。
				try {
					// 隐藏所有 role 为 system 的项，保留其余消息对象引用。
					const visibleMessages = currentMessages.filter((message) => message.role !== "system");
					// 浅拷贝可见数组作为引用顺序快照；不复制每条消息的内容。
					const visibleSnapshot = visibleMessages.slice();
					// 事件携带可见消息，允许处理器返回新数组或修改这个数组。
					const event: ContextEvent = { type: "context", messages: visibleMessages };
					// 等待处理并用断言声明可选消息覆盖；断言不检查运行时返回结构。
					const handlerResult = (await handler(event, ctx)) as ContextEventResult | undefined;

					// Handlers may return a new list or edit event.messages in place.
					// 优先选择处理器显式返回的消息数组。
					const returned =
						// 可选链处理 undefined 返回，空数组仍是有效覆盖。
						handlerResult?.messages ??
						// 没有显式返回时，只有数组长度/元素引用顺序变化才把可见数组视为替换；消息内容原地变化已共享到 currentMessages。
						(sameMessages(visibleMessages, visibleSnapshot) ? undefined : visibleMessages);
					// 没有数组替换则继续下一个处理器。
					if (!returned) continue;
					// 恢复隐藏 system：可见引用序列没变则保留原位置，否则合并系统状态后前置，再接新会话。
					currentMessages = restoreSystemMessages(currentMessages, visibleSnapshot, returned);
					// 报告失败后继续下一处理器；失败前的共享对象修改不会自动撤销。
				} catch (err) {
					// 将异常转成可读文本。
					const message = err instanceof Error ? err.message : String(err);
					// 提取可选堆栈。
					const stack = err instanceof Error ? err.stack : undefined;
					// 发出 runner 错误事件。
					this.emitError({
						// 标记来源扩展。
						extensionPath: ext.path,
						// 标记 context 阶段。
						event: "context",
						// 传递消息。
						error: message,
						// 传递堆栈。
						stack,
					});
				}
			}
		}

		// 开始第二阶段；它能看到前面恢复后的完整消息，包括 system。
		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "context_with_system")) {
			// 顺序执行完整上下文处理器。
			for (const handler of handlers) {
				// 隔离处理器异常。
				try {
					// 记录进入该处理器前是否以 system 开头，用于检查它是否移除了开头系统状态。
					const hadLeadingSystemMessage = currentMessages[0]?.role === "system";
					// 把当前完整数组交给处理器；数组及消息允许原地修改。
					const event: ContextWithSystemEvent = { type: "context_with_system", messages: currentMessages };
					// 等待可选新数组；这里只做类型断言。
					const handlerResult = (await handler(event, ctx)) as ContextEventResult | undefined;
					// 显式返回的 messages 替换整个数组，否则沿用当前数组及其原地修改。
					currentMessages = handlerResult?.messages ?? currentMessages;
					// Providers read the prompt and initial tools from the leading system message.
					// Losing it is never intended; report it but honor the handler's output.
					// 若原本有开头 system、处理后没有，就报告潜在供应商兼容问题。
					if (hadLeadingSystemMessage && currentMessages[0]?.role !== "system") {
						// 只报告、不恢复被删 system；最终尊重处理器返回的数组。
						this.emitError({
							// 附带来源扩展路径。
							extensionPath: ext.path,
							// 指出完整上下文阶段。
							event: "context_with_system",
							// 说明多数供应商会从开头 system 读取系统状态，后续扩展可能继续修复。
							error: "Handler removed the leading system message; the request has no prompt or initial tool declarations. Keep it at index 0 or replace a dropped prefix with getCurrentSystemMessage().",
						});
					}
					// 处理器异常和这段 try 中的其他异常都会进入此处。
				} catch (err) {
					// 取得错误文本。
					const message = err instanceof Error ? err.message : String(err);
					// 取得可选堆栈。
					const stack = err instanceof Error ? err.stack : undefined;
					// 向错误订阅者报告。
					this.emitError({
						// 记录扩展路径。
						extensionPath: ext.path,
						// 记录完整上下文阶段。
						event: "context_with_system",
						// 传递错误消息。
						error: message,
						// 传递堆栈。
						stack,
					});
				}
			}
		}

		// 返回两阶段累计后的消息；这里不发送模型请求。
		return currentMessages;
	}

	// 依次改写供应商请求负载，输入/输出用 unknown 表示各供应商结构不同；每次非 undefined 返回都成为下一处理器输入。
	// 例如扩展返回带自定义字段的新对象；异常报告后继续，不自动回滚先前修改，本方法也不发网络请求。
	async emitBeforeProviderRequest(payload: unknown): Promise<unknown> {
		// 创建会话上下文。
		const ctx = this.createContext();
		// 从调用者提供的请求对象开始累计。
		let currentPayload = payload;

		// 固定 before_provider_request 订阅快照。
		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "before_provider_request")) {
			// 依次运行。
			for (const handler of handlers) {
				// 隔离单个扩展错误。
				try {
					// 为当前处理器建立事件对象。
					const event: BeforeProviderRequestEvent = {
						// 事件判别字段。
						type: "before_provider_request",
						// 提供上一处理器累计后的负载。
						payload: currentPayload,
					};
					// 等待返回任意负载替代值。
					const handlerResult = await handler(event, ctx);
					// undefined 表示不替换；null、false 等值仍会被接纳，供应商后续负责使用它。
					if (handlerResult !== undefined) {
						// 把替代值交给后续处理器。
						currentPayload = handlerResult;
					}
					// 报告错误并继续；已修改共享对象的副作用仍可能保留。
				} catch (err) {
					// 生成错误文本。
					const message = err instanceof Error ? err.message : String(err);
					// 提取堆栈。
					const stack = err instanceof Error ? err.stack : undefined;
					// 通知错误观察者。
					this.emitError({
						// 标记扩展。
						extensionPath: ext.path,
						// 标记请求负载阶段。
						event: "before_provider_request",
						// 传递错误信息。
						error: message,
						// 传递堆栈。
						stack,
					});
				}
			}
		}

		// 返回最终负载供真正请求链使用。
		return currentPayload;
	}

	// 顺序允许扩展原地改写同一份请求头，返回同一对象；handler 返回值被忽略。
	// 例如 headers["X-Trace"] = "abc"；null 删除标记由后面的供应商头合并规则处理，这里不直接发送请求。
	async emitBeforeProviderHeaders(headers: ProviderHeaders): Promise<ProviderHeaders> {
		// 创建会话上下文。
		const ctx = this.createContext();

		// 快照请求头处理器。
		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "before_provider_headers")) {
			// 按顺序运行，每个处理器看到前面的原地修改。
			for (const handler of handlers) {
				// 隔离单处理器异常。
				try {
					// Handlers mutate `headers` in place; the return value is ignored.
					// 构造事件并保留头对象引用。
					const event: BeforeProviderHeadersEvent = {
						// 标明请求头阶段。
						type: "before_provider_headers",
						// 交出共享请求头对象。
						headers,
					};
					// 等待处理完成但丢弃其返回值。
					await handler(event, ctx);
					// 异常只报告，头对象已经发生的修改不回滚。
				} catch (err) {
					// 生成错误文本。
					const message = err instanceof Error ? err.message : String(err);
					// 提取可选堆栈。
					const stack = err instanceof Error ? err.stack : undefined;
					// 通知 runner 错误订阅者。
					this.emitError({
						// 记录来源扩展。
						extensionPath: ext.path,
						// 记录请求头阶段。
						event: "before_provider_headers",
						// 传递错误消息。
						error: message,
						// 传递堆栈。
						stack,
					});
				}
			}
		}

		// 把同一份已修改请求头交回请求链。
		return headers;
	}

	// 运行一轮 before_agent_start：累计扩展自定义消息，并让所有处理器共同调整系统提示构造选项；返回二者给会话层。
	// 例如前一个扩展追加说明，后一个调用 event.systemPrompt 看到更新后的渲染文本。这里建立/渲染提示，不调用模型。
	async emitBeforeAgentStart(
		// trigger 区分本轮由用户文字/图片还是空闲自定义消息触发。
		trigger: BeforeAgentStartTrigger,
		// 传入原始系统提示构造选项。
		systemPromptOptions: BuildSystemPromptOptions,
		// 异步返回累计自定义消息与最终规范提示选项，供会话层构造这一轮输入。
	): Promise<BeforeAgentStartCombinedResult> {
		// 规范化并复制提示构造选项，形成这一轮共享的可修改选项。
		const currentOptions = normalizeBuildSystemPromptOptions(systemPromptOptions);
		// 建立惰性渲染函数：调用时才基于最新选项构造字符串。
		const renderCurrentSystemPrompt = (): string => buildSystemPrompt(currentOptions);
		// 用属性描述符复制上下文，保留 getter 的惰性读取语义。
		const ctx = Object.defineProperties(
			// 新上下文容器。
			{},
			// 取得当前标准上下文的描述符；不通过展开立即读取所有 getter。
			Object.getOwnPropertyDescriptors(this.createContext()),
			// 类型断言声明复制后的对象满足 ExtensionContext。
		) as ExtensionContext;
		// 为本次启动单独覆盖 getSystemPrompt。
		ctx.getSystemPrompt = () => {
			// 实际调用时先拒绝过期 runtime。
			this.assertActive();
			// 返回当前共享选项渲染出的系统提示。
			return renderCurrentSystemPrompt();
		};
		// 收集所有扩展消息；NonNullable 从可选 message 类型里剔除 undefined/null。
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];

		// 快照本轮启动前订阅。
		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "before_agent_start")) {
			// 顺序运行，后一个可看到前一个更新后的选项。
			for (const handler of handlers) {
				// 隔离单 handler 的异常。
				try {
					// 构造每个处理器拿到的启动事件。
					const event: BeforeAgentStartEvent = {
						// 复制触发信息；后面的 type 明确覆盖判别字段。
						...trigger,
						// 指定启动前事件类型。
						type: "before_agent_start",
						// getter 每次读取才渲染最新系统提示，并非固定初始快照。
						get systemPrompt() {
							// 通过共享渲染函数取得文本。
							return renderCurrentSystemPrompt();
						},
						// 暴露可直接修改的本轮选项。
						systemPromptOptions: currentOptions,
					};
					// 等待处理器的可选消息/完整提示覆盖。
					const handlerResult = await handler(event, ctx);

					// 只有真值结果进入覆盖流程。
					if (handlerResult) {
						// 断言返回对象类型，不进行运行时字段校验。
						const result = handlerResult as BeforeAgentStartEventResult;
						// 有 message 就按顺序收集；并非后一个覆盖前一个。
						if (result.message) messages.push(result.message);
						// systemPrompt 明确提供时生效，空字符串也是覆盖。
						if (result.systemPrompt !== undefined) {
							// 写入 forceSystemPrompt，后续渲染优先使用它。
							currentOptions.forceSystemPrompt = result.systemPrompt;
						}
					}
					// 报告异常后继续，已改动共享选项的部分不会回滚。
				} catch (err) {
					// 取得错误文本。
					const message = err instanceof Error ? err.message : String(err);
					// 取得堆栈。
					const stack = err instanceof Error ? err.stack : undefined;
					// 通知扩展错误观察者。
					this.emitError({
						// 标记扩展路径。
						extensionPath: ext.path,
						// 标记启动前阶段。
						event: "before_agent_start",
						// 传递错误消息。
						error: message,
						// 传递堆栈。
						stack,
					});
				}
			}
		}

		// 一次返回所有消息与最终选项，由会话层继续组成请求。
		return { messages, systemPromptOptions: currentOptions };
	}

	// 运行资源发现事件并按顺序汇总技能、提示、主题路径，给每条路径附上声明扩展来源。
	// 输入为 cwd 和启动/重载原因；返回三类路径，不在此读取资源、去重或验证文件存在。单处理器失败报告后继续。
	async emitResourcesDiscover(
		// 传入当前资源发现的工作目录。
		cwd: string,
		// reason 的类型直接引用事件字段，避免重复定义允许值。
		reason: ResourcesDiscoverEvent["reason"],
		// Promise 内联对象类型说明异步结果结构。
	): Promise<{
		// 技能列表每项包含路径与来源扩展路径。
		skillPaths: Array<{ path: string; extensionPath: string }>;
		// 提示模板列表使用相同来源结构。
		promptPaths: Array<{ path: string; extensionPath: string }>;
		// 主题列表使用相同来源结构。
		themePaths: Array<{ path: string; extensionPath: string }>;
	}> {
		// 创建资源发现上下文。
		const ctx = this.createContext();
		// 初始化技能结果，Array<T> 是泛型数组写法。
		const skillPaths: Array<{ path: string; extensionPath: string }> = [];
		// 初始化提示结果。
		const promptPaths: Array<{ path: string; extensionPath: string }> = [];
		// 初始化主题结果。
		const themePaths: Array<{ path: string; extensionPath: string }> = [];

		// 快照资源发现订阅。
		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "resources_discover")) {
			// 按注册顺序收集。
			for (const handler of handlers) {
				// 隔离各处理器失败。
				try {
					// 构造带工作目录和原因的事件。
					const event: ResourcesDiscoverEvent = { type: "resources_discover", cwd, reason };
					// 等待扩展返回可选路径列表。
					const handlerResult = await handler(event, ctx);
					// 断言可选发现结果，运行时不额外检查列表元素类型。
					const result = handlerResult as ResourcesDiscoverResult | undefined;

					// 技能路径存在且非空才追加。
					if (result?.skillPaths?.length) {
						// map 给每项补上来源，展开运算符把它们逐项 push 到结果数组。
						skillPaths.push(...result.skillPaths.map((path) => ({ path, extensionPath: ext.path })));
					}
					// 提示路径非空才追加。
					if (result?.promptPaths?.length) {
						// 给提示路径标记来源并保持原顺序。
						promptPaths.push(...result.promptPaths.map((path) => ({ path, extensionPath: ext.path })));
					}
					// 主题路径非空才追加。
					if (result?.themePaths?.length) {
						// 给主题路径标记来源并保持原顺序。
						themePaths.push(...result.themePaths.map((path) => ({ path, extensionPath: ext.path })));
					}
					// 失败报告后继续其他扩展；前面累计结果保留。
				} catch (err) {
					// 取得错误文本。
					const message = err instanceof Error ? err.message : String(err);
					// 取得可选堆栈。
					const stack = err instanceof Error ? err.stack : undefined;
					// 向错误观察者发送报告。
					this.emitError({
						// 标记来源扩展。
						extensionPath: ext.path,
						// 标记资源发现阶段。
						event: "resources_discover",
						// 传递错误信息。
						error: message,
						// 传递堆栈。
						stack,
					});
				}
			}
		}

		// 返回三种资源，读取/解析/冲突处理由上游资源加载器完成。
		return { skillPaths, promptPaths, themePaths };
	}

	/** Emit input event. Transforms chain, "handled" short-circuits. */
	// 按顺序让扩展处理用户输入：handled 立即结束，transform 改写后交下一处理器，continue/undefined 保持。
	// 输入包含文字、图片、来源和可选队列方式；返回最终变化或 continue，不在此调用模型。异常报告后继续。例：给 hello 输入加上项目约定的前缀。
	async emitInput(
		// 原始用户文字。
		text: string,
		// 可选图片内容数组，undefined 表示没有提供。
		images: ImageContent[] | undefined,
		// 输入来源供扩展区分交互、RPC 或扩展注入等路径。
		source: InputSource,
		// 可选指定繁忙时转向还是跟进队列；问号表示可省略。
		streamingBehavior?: "steer" | "followUp",
		// 异步返回 continue/transform/handled 判别联合，不直接返回模型回复。
	): Promise<InputEventResult> {
		// 创建处理上下文。
		const ctx = this.createContext();
		// 保存可逐步替换的文字。
		let currentText = text;
		// 保存可逐步替换的图片引用。
		let currentImages = images;

		// 快照输入处理器。
		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "input")) {
			// 按扩展/注册顺序运行。
			for (const handler of handlers) {
				// 隔离单个处理器异常。
				try {
					// 构造本次输入事件。
					const event: InputEvent = {
						// 指定 input 判别字段。
						type: "input",
						// 下一个处理器拿到累计文字。
						text: currentText,
						// 下一个处理器拿到累计图片。
						images: currentImages,
						// 保留最初来源。
						source,
						// 保留最初队列方式。
						streamingBehavior,
					};
					// 等待处理结果并断言为允许的动作联合类型。
					const result = (await handler(event, ctx)) as InputEventResult | undefined;
					// handled 表示扩展已经接手，立即原样返回，不再调用后续处理器。
					if (result?.action === "handled") return result;
					// 仅 transform 动作进入文本/图片更新。
					if (result?.action === "transform") {
						// 替换文字，包括空字符串。
						currentText = result.text;
						// images 未提供则保留原图片；空数组可明确清空，null 也因 ?? 被当成保留。
						currentImages = result.images ?? currentImages;
					}
					// 报告错误并继续；扩展自己的外部动作不会回滚。
				} catch (err) {
					// 通知错误观察者。
					this.emitError({
						// 记录来源扩展。
						extensionPath: ext.path,
						// 记录输入阶段。
						event: "input",
						// 生成错误文本。
						error: err instanceof Error ? err.message : String(err),
						// 仅 Error 提供堆栈。
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			}
		}
		// 用文字值及图片数组引用判断是否发生最终变化，不深比较图片元素。
		return currentText !== text || currentImages !== images
			? // 有变化就返回合并后的 transform，让上游继续处理。
				{ action: "transform", text: currentText, images: currentImages }
			: // 无变化返回 continue；之前处理器即使返回 transform 后又改回原值，也会走这里。
				{ action: "continue" };
	}
}
