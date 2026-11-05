// Durable Harness 的公开类型面：提交、工具、扩展、注册表、设置、会话与 hook 的编译期契约，几乎不含运行时代码。
// 所属：packages/durable/src/harness；Harness 对外 API 与扩展作者使用的主类型入口，并由 src/index.ts 再导出。
// 上游：应用传入 HarnessOptions 并实现 ToolRegistration/hook；pi-ai 提供 Model/Tool/Message/Usage 等模型类型，
//   pi-schema 提供 Static，核心 ../types.ts 提供 Tx/Entry/Session 等基础类型，view/task-graph 提供视图类型。
// 下游：harness.ts、submissions.ts、tool.ts、generation.ts、scheduler.ts 等实现文件用这些类型约束参数与返回值；
//   本文件只声明形状，运行时大多数类型被擦除，不执行接纳、调度、生成或存储。
// 职责边界：定义“能传什么、会得到什么、字段何时可选”，不定义错误类，也不在运行时校验值；文档里提到的
//   ConversationBusy/ConversationIdle/ReadAfterWrite 等由实现模块抛出。可选字段的语义（undefined/null/缺省）
//   在各自注释中说明，未标注时 undefined 表示未设置。
// 能力清单（按主题）：
// - 模型与输入：ModelRef、UserInput、InputEntry、SubmissionDraft（input/write/continue）、InputSubmissionDraft。
// - 提交与任务结果：SettledSubmissionRecord、Submission、SettledTask、AnyTask、ConversationAbortOptions、HooksOf。
// - 工具执行：ToolControl、ToolDiagnostic、ToolExecutionResult、NestedToolExecutionResult、ToolExecutionMode、
//   QueueMode、ToolExecutionApi、ToolArgs、ToolRegistration。
// - 提示词与扩展：PromptInput、PromptSection、HookRegistration、Wrap、Extension、RegistrySnapshot、
//   RegistryReader、Registry。
// - Agent 状态：AgentState、AgentChange、Agent、ConversationInit、ConversationCreateOptions。
// - 设置与选项：ConversationStreamOptions、ConversationRetryPolicy、CompactionPolicy、CompactionSettings、
//   ProgressPolicy、CompactionReason、CompactionResult、HarnessSettings、AfterFailedRun、Settings、EnvTarget、
//   HarnessOptions、Wake。
// - 检查与视图：TaskInspection、HarnessInspection、ContextView、Conversation、ConversationWatch、Harness。
// - Hooks：HookApi、HookResult、GenerationHooks、RunSummary、RunEndTask、ToolHookCall、ToolHooks、CompactionHooks。
// 组合关系：HarnessOptions 提供 Models、RegistryReader 与 Settings；Harness 用它们创建/读取 Conversation；
//   Conversation.submit 接收 SubmissionDraft；工具拿到 ToolExecutionApi 并返回 ToolExecutionResult；扩展经
//   Registry.install 进入注册表；任务定义上的 hooks 在运行时收到 HookApi。类型参数普遍用默认值保持易用性。
// 示例（真实签名）：
//   const draft: SubmissionDraft = { type: "input", content: "hello", whenBusy: "steer" };
//   const options: HarnessOptions = { models: () => models, registry: app.registry, settings: { toolExecution: "parallel" } };
// 建议阅读顺序：先 SubmissionDraft，再看 ToolRegistration/ToolExecutionApi 与 Extension/Registry，随后
//   HarnessSettings/HarnessOptions，之后 Conversation/Harness，最后 HookApi 与三组 hooks 的时序说明。
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { WatchHandle } from "@earendil-works/chord/watch";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	ClientIdentity,
	Message,
	Model,
	Models,
	ModelThinkingLevel,
	Tool,
	ToolCall,
	ToolResultMessage,
	Transport,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { Static } from "@earendil-works/pi-schema";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import type { ExecutionEnv, ShellOutputSkip, ShellOutputWindow } from "../env/index.ts";
import type {
	CommitOptions,
	ConversationId,
	ConversationOwnership,
	ConversationRecord,
	Cursor,
	DocumentObserver,
	DocumentReader,
	Entry,
	EntryDraft,
	EntryId,
	EntryQuery,
	EntryRecord,
	JsonObject,
	Observation,
	Observer,
	Page,
	Report,
	Session,
	SetTimer,
	SubmissionId,
	SubmissionRecord,
	Task,
	TaskId,
	TaskOptions,
	TaskRecord,
	TaskState,
	Tx,
	TypedEntry,
} from "../types.ts";
import type { TaskGraph, TaskGraphWatch } from "./task-graph.ts";
import type { UsageState } from "./usage.ts";
import type { ConversationView, ConversationWindow } from "./view.ts";

/** Provider and model ID resolved through pi-ai `Models`. */
/**
 * 模型身份：provider 名 + provider 内的 modelId，交给 pi-ai Models 解析。
 * 纯类型；不校验 provider/modelId 是否存在，解析失败在运行时由模型目录决定。
 * 例：{ provider: "anthropic", modelId: "claude-sonnet-4" }。
 */
export type ModelRef = {
	readonly provider: string;
	// modelId 只在 provider 内有意义，不是全局唯一名。
	readonly modelId: string;
};

// UserMessage["content"] 是索引访问类型：取 pi-ai 用户消息 content 字段的类型（字符串或内容块数组）。
export type UserInput = UserMessage["content"];

/**
 * The entry an input is placed as, instead of `pi.user`: an application kind, and data the transcript shows, such as its
 * author. Its model message is still the input's user message.
 */
/**
 * 自定义输入记录的显示信息：kind 决定 entry 类型，data 是转录/UI 可见的附加数据。
 * 模型看到的消息仍是输入本身的 user message；data 不进入上下文。
 * kind 由调用方保证不以 "pi." 开头（admission 的运行时检查会拒绝保留前缀）。
 * 例：{ kind: "app.note", data: { author: "alice" } }。
 */
export type InputEntry = { readonly kind: string; readonly data?: JsonValue };

/**
 * Host submission: user input that may start a run, a passive entry write, or a continue: a run without a new user
 * message, for an idle conversation whose context the model still owes an answer (it ends in a user message or tool
 * results, for example after a run that ended without an answer).
 */
/**
 * 宿主提交的输入形状：三种 type 的可辨识联合，外加可选的 requestId。
 * 输入/输出：纯类型；是 Conversation.submit 与 SubmissionHandle 的入参，admission 在运行时按 type 分支处理。
 * 公共字段 requestId：同一会话内用于去重；重复提交会复用/返回已有提交（实现细节见 submissions.ts）。
 * input：可带新用户内容，按 whenBusy 决定忙时 steer/followUp/reject，按 whenIdle 决定空闲时是否拒绝。
 * write：只写 entry（EntryDraft），不启动 run；仅 kind+data 的显示型 write 可在 run 中立即追加。
 * continue：空闲时在当前上下文上继续，不新增用户消息；忙时以 ConversationBusy 拒绝，从不排队。
 * 互斥字段用 never 声明（content/entry/whenBusy/whenIdle），让每种 type 只允许对应字段。
 * 例：{ type: "input", content: "hi", whenBusy: "followUp" }。
 */
export type SubmissionDraft = {
	// 可选去重键；没有时每次提交都新建。
	readonly requestId?: string;
	// & 与联合类型的交叉：requestId 对三个分支都可用（交叉分配）。
} & (
	| {
			// input 是唯一可以新增 user message 并启动/接管 run 的分支。
			readonly type: "input";
			readonly content: UserInput;
			// 忙时策略：steer 插入当前轮，followUp 排到下一轮，reject 直接以 ConversationBusy 拒绝。
			readonly whenBusy?: "steer" | "followUp" | "reject";
			/**
			 * `reject`: an idle conversation (no run) rejects the input with `ConversationIdle` and writes nothing, so the input
			 * never starts a run of its own. With `whenBusy: "steer"` it steers the current run or is refused; a run that
			 * answered and waits for its `afterRun` tasks is still busy, and such an input queues and starts the next run.
			 */
			// 只有 "reject"：空闲时若不想让输入自行启动 run，可用它拒绝；未设置则空闲输入会开始新 run。
			readonly whenIdle?: "reject";
			/** Place the input as this entry; default `pi.user` without data. The kind must not start with `pi.`. */
			// 自定义显示 entry；模型消息仍是 content 对应的 user message。
			readonly entry?: InputEntry;
	  }
	| {
			// write 不启动 run，只把 entry 写入转录；可用于 UI 记录或非模型可见数据。
			readonly type: "write";
			readonly entry: EntryDraft;
			// 其余分支字段显式标为 never：传了会在编译期报错。
			readonly content?: never;
			readonly whenBusy?: never;
			readonly whenIdle?: never;
	  }
	| {
			/**
			 * Start a run on the context as it is, without a user message. Only when idle: a busy conversation rejects it with
			 * `ConversationBusy`, and it never queues. Items kept in `pi.inbox` are placed first and join the run. A context
			 * with nothing to answer (empty, or ending in an answer, also a text answer cut off at its output limit) ends the
			 * run without a request, `unanswered` with `nothing_to_answer`. A cut-off answer with tool calls is continued:
			 * its calls never ran, and the context ends in their error results (`missing_result`).
			 */
			// continue 不新增用户消息；它先放置 pi.inbox 中排队的项，再就当前上下文继续。
			readonly type: "continue";
			readonly content?: never;
			readonly entry?: never;
			readonly whenBusy?: never;
			readonly whenIdle?: never;
	  }
);

// Extract 从联合中挑出 type 为 "input" 的成员；用于只需要 input 分支的内部函数签名。
export type InputSubmissionDraft = Extract<SubmissionDraft, { readonly type: "input" }>;

// 已结算提交：在完整记录上把 status 收窄为 done | unanswered，用于 Submission.wait 的返回值。
// 交叉类型不会在运行时改变对象，只是在类型层收紧 status。
export type SettledSubmissionRecord = SubmissionRecord & {
	readonly status: "done" | "unanswered";
};

/** Awaitable host object for one durably admitted submission. */
/**
 * 一个已持久接纳提交的句柄：查询状态、等待结算或中止。
 * id 是接纳后分配的 SubmissionId；三个方法都接收 Context，取消会影响等待而不撤销已提交的接纳。
 * wait 在 done/unanswered 时返回 SettledSubmissionRecord；abort 返回三种去向，错误以 Promise 拒绝。
 * 例：const sub = await conversation.submit(draft, ctx); const settled = await sub.wait(ctx);
 */
export interface Submission {
	// 接纳时分配，跨重开仍可用于 Harness.submission(id) 重新获取。
	readonly id: SubmissionId;
	// 读当前记录；可能在仍排队/已放置时返回未结算状态。
	status(context: Context): Promise<SubmissionRecord>;
	// 等到结算；取消 context 只取消等待，不改变提交。
	wait(context: Context): Promise<SettledSubmissionRecord>;
	// aborted：撤销排队中的输入；already_placed：已越过边界；settled：已结算。
	abort(context: Context): Promise<"aborted" | "already_placed" | "settled">;
}

// 已终止任务：完整 TaskRecord 与收窄为 terminal 的 state 的交叉类型。
// Extract 只保留 terminal 成员，因此调用方可直接读 outcome，而不必再判 status。
export type SettledTask<R> = TaskRecord<JsonValue, JsonValue, R> & {
	readonly state: Extract<TaskState<JsonValue, R>, { readonly status: "terminal" }>;
};

/** Erased executable task definition stored in the registry. */
/**
 * 注册表中类型擦除后的任务定义视图：只保留调度器需要的公共字段。
 * initial/phases/abort/migrate 的真实泛型在定义时已知，存进注册表后按 unknown 处理；AnyTask 让不同任务
 * 能放进同一数组。运行时不会读取 unknown 的形状，只转交给对应的执行器。
 * 例：{ definition: { name: "summarize", version: 1, initial: {...}, phases: {...}, abort: {...} } }。
 */
export type AnyTask = {
	readonly definition: {
		// name：任务定义名，用于注册表查找与 hook 匹配；version：迁移时比较的整数版本。
		readonly name: string;
		readonly version: number;
		// initial：创建任务时写入的初始输入，具体类型被擦除为 unknown。
		readonly initial: unknown;
		// phases：phase 名到 phase 定义的映射；abort：中止处理器定义。
		readonly phases: Readonly<Record<string, unknown>>;
		readonly abort: unknown;
		// migrate 可选：定义版本升级时把旧 checkpoint 迁移到新版本。
		readonly migrate?: unknown;
		// hooks：定义声明的 hook 映射；具体 handler 类型由任务泛型 H 给出。
		readonly hooks?: object;
	};
};

/** Options of `Conversation.abort()`. */
/**
 * Conversation.abort 的选项：background 控制是否跨越 background 边界。
 * 纯类型；默认只中止普通所有权范围，background 任务与其子树默认存活。
 * 例：{ background: true } 会连 background 任务一起标记，并撤回可达会话的排队输入。
 */
export type ConversationAbortOptions = {
	/**
	 * Cross background boundaries: mark every live task reached ignoring the background flag when the abort is admitted,
	 * withdraw the queued inputs of every conversation reached, and wait until those tasks are terminal and the
	 * conversation is ordinarily idle. Background work created afterwards is neither marked nor awaited.
	 */
	readonly background?: boolean;
};

/** Hook handler map declared by a task definition. */
/**
 * 从 Task 类型中提取其 hook 映射类型 H；条件类型在编译期做推断。
 * 输入：任何类型 K；若 K 是 Task<_I,_S,_R,H> 则结果 H，否则 never。以下划线开头的推断类型参数表示不使用。
 * 纯类型行为，无运行时副作用；用于让 hook 注册与任务定义的类型对齐。
 * 例：HooksOf<typeof generationTask> 得到 GenerationHooks。
 */
export type HooksOf<K> = K extends Task<infer _I, infer _S, infer _R, infer H> ? H : never;

/**
 * Invocation-bound conversation operations for tasks and tools. Rejects after the invocation ends. `submit` takes any
 * submission, in both forms of `Conversation.submit()`: a subagent's conversation is an ordinary one, so a tool may also
 * continue it, and a task may admit a submission in the same commit as its own writes (`runtime.commit()`); entries
 * the admission appends there carry the task's `byTaskId`. The transaction form also rejects once the invocation is
 * aborted.
 */
/**
 * 任务/工具在一次调用内可用的会话操作；调用结束后所有方法拒绝。
 * 与 Conversation 的区别：句柄绑定调用生命周期，不能读历史或 fork，只能提交、中止和等待空闲。
 * 两种 submit：普通形式返回 Submission；tx 形式把接纳并进调用方事务并返回 SubmissionId。
 * 错误：调用结束后拒绝；tx 形式在中止后也拒绝；其余接纳错误（ConversationBusy 等）与 Conversation.submit 相同。
 * 例：await handle.submit(tx, { type: "write", entry }); await handle.abort(context, { background: true });
 */
export interface ConversationHandle {
	readonly id: ConversationId;
	// 独立提交：立即走正常接纳路径。
	submit(submission: SubmissionDraft, context: Context): Promise<Submission>;
	// 事务内接纳：与调用方自己的写入同一提交；entries 会带 byTaskId。
	submit(tx: Tx, submission: SubmissionDraft): Promise<SubmissionId>;
	/** `Conversation.abort()`: withdraw queued inputs, abort the ordinary ownership scope, and wait until it is idle. */
	// 与 Conversation.abort 语义相同，但受调用生命周期约束。
	abort(context: Context, options?: ConversationAbortOptions): Promise<void>;
	/** Resolve when the conversation's ordinary ownership scope has no live non-background task. */
	waitForIdle(context: Context): Promise<void>;
}

/** Post-tools controls requested by a tool result. */
/**
 * 工具结果附带的“回合后控制”：加载工具、终止 run、或交接新上下文。
 * 纯类型；由本轮所有结果合并后由 generation 执行，不是工具自身能直接执行的动作。
 * terminate 需要本轮每个结果都为 true 才终止；handoff 按调用顺序取最后一个。
 * 例：{ terminate: true } 让本轮工具跑完后不再请求模型。
 */
export type ToolControl = {
	// 运行中把指定工具加入模型可用的集合（如 tool_search 的结果）。
	readonly addTools?: readonly string[];
	/** End the run without another model request when every result of the round sets it to `true`; `false` is a no-op. */
	readonly terminate?: boolean;
	/**
	 * Start a new context with this text as its user message, as `reset(handoff)` writes, and continue the run there.
	 * The last handoff in call order wins.
	 */
	// handoff 等价于写入一条 pi.reset，然后在新上下文继续；最后一个 handoff 生效。
	readonly handoff?: string;
};

/** Remark about a call for the model and the UI, such as truncation or a spill path; never part of the tool's data. */
/**
 * 工具调用的诊断信息：给模型/UI 的说明，不进入业务 structuredOutput。
 * severity 是固定三级；code 可选，供程序分类。无运行时校验，字符串由调用方负责。
 * 例：{ severity: "warn", message: "output truncated", code: "truncated" }。
 */
export type ToolDiagnostic = {
	readonly severity: "info" | "warn" | "error";
	readonly message: string;
	readonly code?: string;
};

/**
 * What a tool returns, on three channels: `output` for the model, `structuredOutput` for programs that call the tool
 * (`executeTool()` callers, code mode scripts), and `details` for UIs.
 */
/**
 * 工具返回值：三条通道（模型 output、程序 structuredOutput、UI details）加上错误、诊断、用量和控制。
 * 泛型 TDetails 默认 JsonValue，只约束 details；结构化输出 schema 是否必需由 ToolRegistration 决定。
 * 纯类型；工具实现返回它，tool.ts 负责校验/持久化/转成转录结果。
 * 例：{ output: "ok", structuredOutput: { ok: true }, details: { bytes: 2 } }。
 */
export type ToolExecutionResult<TDetails extends JsonValue = JsonValue> = {
	/** For the model. Omitted: the retained `output()` text. */
	readonly output?: ToolResultMessage["content"];
	/**
	 * For programs. Required unless `isError` when the tool declares `structuredOutputSchema`, and validated against it;
	 * not allowed without one, where programs get the output itself (`NestedToolExecutionResult.structuredOutput`).
	 */
	// 程序通道：声明了 structuredOutputSchema 时，除非 isError 否则必填并按 schema 校验；未声明则不允许。
	readonly structuredOutput?: JsonValue;
	// 标记错误结果；错误仍可有 output/structuredOutput，供模型或程序读取。
	readonly isError?: boolean;
	/** Omitted: the last `details()` value becomes the details. */
	// details 只给 UI；省略时采用工具运行中最后一次 api.details 的值。
	readonly details?: TDetails;
	/** Added after those recorded through `api.diagnostic()`. */
	// 结果自带诊断排在 api.diagnostic() 记录的诊断之后。
	readonly diagnostics?: readonly ToolDiagnostic[];
	/** Spend of the execution itself, such as a model call; stored on the result and in `pi.usage.tools`. */
	// usage 会写入结果，并按工具名累计到会话账本 pi.usage.tools。
	readonly usage?: Usage;
	// 回合后控制，由 generation 合并处理，不属于工具数据通道。
	readonly control?: ToolControl;
};

/**
 * Result of a nested call, as `executeTool()` returns it. Programs read `structuredOutput`; the output for the model
 * is not kept, and `control` does not apply.
 */
/**
 * 嵌套工具调用（executeTool）的结果：面向程序，不进入转录，也没有 control。
 * structuredOutput 的形态取决于被调工具是否声明 schema；Harness 自己写的错误结果没有 structuredOutput。
 * 纯类型；诊断/用量/durationMs 让调用方判断失败原因与成本。
 * 例：{ taskId, structuredOutput: { matches: 2 }, isError: false, diagnostics: [], durationMs: 12 }。
 */
export type NestedToolExecutionResult = {
	/** The nested call's tool task. */
	// 每个嵌套调用是独立的 pi.tool 任务，父任务为当前工具调用。
	readonly taskId: TaskId;
	/**
	 * The tool's value for programs. A tool with `structuredOutputSchema`: its validated `structuredOutput`, also on an
	 * error result that has one; absent otherwise, and an error's text is then in an error diagnostic. A tool without:
	 * its bounded output, success or error, as a string for one text item, an `ImageContent` for one image, `""` for
	 * none, and the content list otherwise. Absent on an error result the Harness wrote itself (unavailable, invalid,
	 * blocked, interrupted, aborted); `diagnostics` say what went wrong.
	 */
	readonly structuredOutput?: JsonValue;
	readonly isError: boolean;
	readonly details?: JsonValue;
	readonly diagnostics: readonly ToolDiagnostic[];
	readonly usage?: Usage;
	/** Execution time of the attempt that produced the result; absent when it never executed. */
	// 只统计真正执行的一次尝试；被阻止/参数非法/中止而未执行时为 undefined。
	readonly durationMs?: number;
};

/** Whether the tools of one round run at once or one after another in call order. */
// parallel：同一轮的工具并发执行；sequential：按调用顺序逐个执行。单个 sequential 工具会让整轮串行。
export type ToolExecutionMode = "parallel" | "sequential";

/** How many queued items of one mode a boundary places: the first, or all of them. */
// 边界放置排队项的策略：all 放置该模式全部条目，one-at-a-time 只放置第一条。
export type QueueMode = "all" | "one-at-a-time";

/**
 * Operations available to one tool invocation. A plain object, so a wrapper can spread it. Every operation rejects after
 * the invocation ends.
 */
/**
 * 一次工具调用可用的操作集合：文档读写、模型/环境、输出与诊断、提交与任务、嵌套工具调用。
 * 继承 DocumentObserver/DocumentReader（watchDoc/snapshot 等）；是普通对象，包装器可直接展开复制。
 * 生命周期：调用结束（或任务被中止）后，所有异步操作拒绝；output/details 等同步写入也只在调用内有效。
 * 错误：参数/状态错误以 Promise 拒绝；schema 错误、任务失败等由 tool.ts 转换，不在此类型中体现。
 * 例：execute: async (args, api, ctx) => { api.output("working"); await api.details({ step: 1 }, ctx); return { output: "done" }; }
 */
export interface ToolExecutionApi<TDetails extends JsonValue = JsonValue> extends DocumentObserver, DocumentReader {
	// 当前工具任务 ID；一个工具调用对应一个 pi.tool 任务。
	readonly taskId: TaskId;
	// 调用所在会话 ID。
	readonly conversationId: ConversationId;
	// 模型给出的工具调用 ID；嵌套调用的格式是 `<父 callId>/<key>`。
	readonly callId: string;
	/** The tool task's phase snapshot. */
	// 工具任务当前阶段（phase）固定的注册表快照；运行期间安装新扩展不会改变本次可解析的工具。
	readonly registry: RegistrySnapshot;
	/** The calling conversation's agent, as the tool task's phase resolved it. */
	// 返回本阶段解析出的 Agent（模型、扩展、工具、instructions、cwd 等）。
	agent(context: Context): Promise<Agent>;
	/** The current `HarnessOptions.models`, read at each access: the catalog, credentials, and request transforms. */
	// 每次访问都读取 HarnessOptions.models，宿主可热替换模型目录/凭证/请求转换。
	readonly models: Models;
	/** Built by `HarnessOptions.env` for this call; `undefined` without an environment. */
	// 本调用专用的执行环境（文件、shell 等）；未配置 HarnessOptions.env 时为 undefined。
	readonly env: ExecutionEnv | undefined;
	/** The Harness clock (`HarnessOptions.now`), for times a rerun after a restart compares against. */
	// Harness 时钟（默认 Date.now）；重启后重跑时用于比较截止时间。
	now(): number;
	/**
	 * Append running output; it becomes the result's `output` when the result omits it. `skipped` counts output
	 * omitted before the chunk, as reported by an environment given `outputWindow` (`ShellOutputInfo.skipped`).
	 */
	output(chunk: string | Uint8Array, skipped?: ShellOutputSkip): void;
	/**
	 * The tail this call's output keeps and the pace of its progress commits, for `ShellExecOptions.window`; `undefined`
	 * when the tool keeps the head of its output, which cannot accept skips. A wrapper that replaces `output` and
	 * transforms text must also replace this with `undefined`, so skipped text cannot bypass its transform.
	 */
	// 保留输出尾部时的窗口配置（行数/字节数与进度提交节奏）；保留头部时没有窗口，也就不能报告 skipped。
	readonly outputWindow: ShellOutputWindow | undefined;
	/**
	 * The output retained so far, as the model will see it when the result omits `output`, and whether earlier output was
	 * dropped; for a tool that also returns that text in its `structuredOutput`.
	 */
	// 返回截至目前保留的文本及是否截断；结果未给 output 时，模型看到的就是这段文本。
	retainedOutput(): { readonly text: string; readonly truncated: boolean };
	/** Record a model-visible remark about this call. */
	// 记录一条模型可见的诊断信息（ToolDiagnostic），用于解释阻塞、限制等。
	diagnostic(diagnostic: ToolDiagnostic): void;
	/** Replace running details; the last value becomes the result details when the result omits `details`. */
	// 替换运行中的 details（结构化中间结果）；结果未显式给 details 时取最后一次值。
	details(value: TDetails, context: Context): Promise<void>;
	/** A commit of this call's task; `options` may defer storing it (`CommitPersistence`). */
	// 以本工具任务为单位提交；options.withinMs 可把它延迟写入 Storage（观察者仍立即看到）。
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context, options?: CommitOptions): Promise<T>;
	memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
	memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
	/**
	 * Create a task in one commit. A child task of a tool that is not replay-safe defaults to `abandonOnRestart`: the
	 * tool never resumes after a restart, so nothing awaits the child then.
	 */
	// 在一个提交里创建子任务；非 replay-safe 工具创建的子任务默认 abandonOnRestart（重启后不再等待）。
	createTask<I, S extends { phase: string }, R, H extends object>(
		task: Task<I, S, R, H>,
		input: I,
		options: Omit<TaskOptions, "conversationId">,
		context: Context,
	): Promise<TaskId<R>>;
	// 读取任务记录；不存在时 undefined。
	getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined>;
	// 等待任意任务进入终态并返回终态回执；任务不存在/被删时按底层实现拒绝或返回。
	waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>>;
	/** Invocation-bound handle of an existing conversation, such as one this tool created in `commit()`. */
	// 获取已有会话的调用期句柄；会话不存在时为 undefined。
	conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
	/**
	 * Run tool `name` as a nested call of this one and wait for its result. The nested call is its own `pi.tool` task,
	 * owned by this call: it resolves the tool among the conversation's tools, validates, runs the `ToolTask` hooks (which
	 * see `call.parent`), applies output limits and the tool's replay policy, and reports progress in `pi.live.nestedTools`.
	 * Its result returns here instead of entering the transcript. A call that is blocked, invalid, throws, is interrupted,
	 * or is aborted returns an `isError` result.
	 *
	 * The nested call's key names it within this call; its call ID is `<callId>/<key>`. By default the key is the call's
	 * position among this invocation's nested calls, `1`, `2`, ... An explicit `key` must be non-empty, without `/`, not
	 * `__proto__`, and not a positive integer, so it never collides with a default one. A rerun of a replay-safe tool
	 * that makes a call with a used key, by calling in the same order or by passing the same `key`, gets that nested call
	 * back, finished or still running, instead of starting another. A nested call a crash interrupted before its result
	 * committed follows its own replay policy, so this is not exactly-once execution. Reusing a key with another tool or
	 * other arguments throws. A tool that is not replay-safe never reruns: after a restart, its unfinished nested calls
	 * are abandoned (`TaskOptions.abandonOnRestart`) before they run again.
	 *
	 * `progress: false` commits no running output, details, or diagnostics to the nested call's slot, only its status;
	 * the result still carries its details and diagnostics, and a schema-less tool's output as `structuredOutput`. An
	 * interrupted or aborted call's result is built from its slot, so it then has none of them. Either way, programs never
	 * get the partial output of an interrupted or aborted call.
	 *
	 * Nested calls run as soon as they are made, whatever their `executionMode`; the caller decides what runs at once by
	 * what it awaits. Cancelling `context` stops only the wait; the nested call runs on. When this call settles, nested
	 * calls it left running are aborted first. A nested result's `usage` is already counted under its tool; a result
	 * that passes it on counts it again. Rejects, instead of returning a result, once `execute()` has returned, when this
	 * call is aborted, or when the Harness closes.
	 */
	// 以本次调用为父，执行另一个工具并等待其结果；嵌套调用是独立的 pi.tool 任务，结果不回写 transcript。
	// key 用于重跑时复用同一嵌套调用；progress:false 时不提交运行中输出，只提交状态。
	executeTool(
		name: string,
		args: JsonObject,
		context: Context,
		options?: { readonly key?: string; readonly progress?: boolean },
	): Promise<NestedToolExecutionResult>;
}

/**
 * The arguments type of a tool with parameter schema `TParameters`: pi-schema's `Static<TParameters>` (the builders'
 * type, TypeBox's for the common TypeBox kinds, else `unknown`), and `any` for `ToolRegistration<any>`.
 */
// 从参数 schema 推导 execute(args) 的参数类型；schema 为 any 时保留 any，避免把 any 错误收窄成 unknown。
export type ToolArgs<TParameters> = IsAny<TParameters> extends true ? any : Static<TParameters>;

// `0 extends 1 & T` is resolved too early for a `T` constrained to `object`; this form waits for the argument.
// 条件类型技巧：错误用法是 0 extends 1 & T；这里用 boolean 双向分配判断 T 是否为 any，能等待具体类型实参。
type IsAny<T> = boolean extends (T extends never ? true : false) ? true : false;

/**
 * Executable tool registered in a registry. Only pi-ai `Tool` fields enter the transcript. `args` are typed by
 * `parameters` (any JSON Schema object; see {@link ToolArgs}), which the Harness validates them against before
 * `execute()`; `defineTool()` infers both generics.
 */
// 注册表中的可执行工具：pi-ai Tool 的字段会写入 transcript，其余字段（replay/executionMode 等）只影响 Harness。
export type ToolRegistration<
	TParameters extends object = object,
	TDetails extends JsonValue = JsonValue,
> = Tool<TParameters> & {
	/** Whether an interrupted execution may rerun on recovery. Default `unsafe`. */
	// 崩溃中断后是否允许自动重跑；默认 unsafe，只有明确幂等的工具才设 safe。
	readonly replay?: "safe" | "unsafe";
	/** Default: the settings' `toolExecution`. One sequential call makes its whole round sequential. */
	// 本轮执行模式；默认取 settings.toolExecution。任一调用为 sequential 时，整轮退化为串行。
	readonly executionMode?: ToolExecutionMode;
	/**
	 * Repair arguments models commonly get wrong before validation, such as a JSON string where an array belongs. Must be
	 * pure and must not mutate `args`: it runs again when a call is retried before its intent is recorded. Its result is
	 * still validated against `parameters`.
	 */
	// 校验前修正模型常见参数错误（如数组写成 JSON 字符串）；必须纯函数、不得修改传入对象，修正后仍要过 schema。
	prepareArguments?(args: unknown): ToolArgs<TParameters>;
	/**
	 * Schema of `structuredOutput`, which programs that call the tool receive. Omitted: they receive the result's bounded
	 * output, success or error, as `NestedToolExecutionResult.structuredOutput` describes.
	 */
	// structuredOutput 的 schema，供程序调用方（executeTool）校验；省略时程序拿到的是有界输出文本。
	readonly structuredOutputSchema?: object;
	/**
	 * Who may call the tool: the model, other tools through `executeTool()`, or both (default). A code mode tool is
	 * `["model"]`, so scripts cannot start scripts; tools behind code mode, such as MCP tools, can be `["tools"]`, so the
	 * model is never offered them.
	 */
	// 调用方白名单："model" 允许模型直接调用，"tools" 允许其他工具通过 executeTool 调用；默认两者皆可。
	readonly callers?: readonly ("model" | "tools")[];
	/**
	 * Not offered to the model until loaded: the model gets the tool only when `modelTools` names it, in its array or its
	 * `add`, which `control.addTools` (from a tool such as `tool_search`) writes. Other tools can call it any time.
	 */
	// 延迟工具：初始不提供给模型，需由 modelTools/control.addTools 显式加载；其他工具始终可调用。
	readonly deferred?: true;
	// 输出上限与保留端：maxBytes/maxLines 限制写入 transcript 的输出，retain 决定截断时保留头还是尾。
	readonly outputLimits?: {
		readonly maxBytes?: number;
		readonly maxLines?: number;
		readonly retain?: "head" | "tail";
	};
	// 真正执行工具；args 已通过 schema 校验，返回 ToolExecutionResult。
	execute(
		args: ToolArgs<TParameters>,
		api: ToolExecutionApi<TDetails>,
		context: Context,
	): Promise<ToolExecutionResult<TDetails>>;
};

/** Input to system prompt section rendering for one request preparation. */
// 每次准备模型请求时传给系统提示 section 的渲染输入。
export type PromptInput<Tool extends ToolRegistration = ToolRegistration> = {
	// 当前会话 ID。
	readonly conversationId: ConversationId;
	/** The request's resolution; `agent.tools` are the tools offered in this request. */
	// 本次请求解析出的 Agent；agent.tools 就是本次提供给模型的工具集合。
	readonly agent: Agent<Tool>;
	/** Built by `HarnessOptions.env` for this preparation; `undefined` without an environment. */
	// 本次请求准备阶段构建的执行环境；未配置 env 时为 undefined。
	readonly env: ExecutionEnv | undefined;
	/** Sections already in effect after replaying the active transcript. */
	// 重放当前 transcript 后已生效的 section 文本，按 key 索引，可用于避免重复渲染。
	readonly shown: Readonly<Record<string, string>>;
	/** Committed document reads. */
	// 已提交文档的只读入口（与 DocumentReader 相同）。
	readonly read: DocumentReader;
};

/** One system prompt section; the agent's sections render in order before each request. */
// 一个系统提示 section；每次请求前按 Agent.sections 顺序渲染，undefined 表示本次跳过。
export type PromptSection<Tool extends ToolRegistration = ToolRegistration> = {
	readonly key: string;
	render(input: PromptInput<Tool>, context: Context): string | undefined | Promise<string | undefined>;
	/** Default true: wrap the text as `<key>\n...\n</key>`. */
	// 默认 true，渲染结果包成 `<key>...</key>`；false 则原样拼接。
	readonly tag?: boolean;
};

/** Built by `hook()`; matches tasks by name. */
// 钩子注册：按任务名匹配，handlers 是该任务 Hook 对象（如 GenerationHooks/ToolHooks）。
export type HookRegistration = { readonly task: string; readonly handlers: object };

/** Built by `wrapTool()` and `wrapSection()`; targets a tool name or a section key. Wrappers are pure. */
// 包装器：按工具名包装 Tool，或按 section key 包装 PromptSection；必须是纯函数，可重复应用。
export type Wrap<Tool extends ToolRegistration = ToolRegistration> =
	| { readonly tool: string; wrap(tool: Tool): Tool }
	| { readonly section: string; wrap(section: PromptSection<Tool>): PromptSection<Tool> };

/** Named bundle of code; installed in a registry and selected by conversations by name. */
// 扩展：按名字安装到注册表，会话通过 AgentState.extensions 选择；一个扩展可包含工具、section、钩子、包装器和任务。
export interface Extension<Tool extends ToolRegistration = ToolRegistration> {
	readonly name: string;
	readonly tools?: readonly Tool[];
	readonly sections?: readonly PromptSection<Tool>[];
	readonly hooks?: readonly HookRegistration[];
	/** Apply where this extension is selected, in order. */
	// 只在选择该扩展的会话生效，按数组顺序应用。
	readonly wraps?: readonly Wrap<Tool>[];
	/** Resolved by name for every task, whichever conversations select this extension. */
	// 任务定义按名字全局解析，不受会话是否选择该扩展影响。
	readonly tasks?: readonly AnyTask[];
}

/** Immutable view of one published registry state. */
// 一次注册表发布状态的不可变快照；获取后其内容不随后续安装/卸载改变。
export interface RegistrySnapshot<Tool extends ToolRegistration = ToolRegistration> {
	// 按安装顺序返回全部扩展。
	installed(): readonly Extension<Tool>[];
	// 按名字查找扩展；未安装时 undefined。
	extension(name: string): Extension<Tool> | undefined;
	/** Every installed tool with its extension, in install order. Names may repeat across extensions. */
	// 所有已安装工具及其来源扩展；不同扩展可出现同名工具。
	tools(): readonly { readonly extension: Extension<Tool>; readonly tool: Tool }[];
	// 所有已安装 section 及其来源扩展，按安装顺序。
	sections(): readonly { readonly extension: Extension<Tool>; readonly section: PromptSection<Tool> }[];
	/** Built-in and installed task definitions. */
	// 内置任务与扩展安装的任务定义。
	tasks(): readonly AnyTask[];
	// 按名字查找任务定义；不存在时 undefined。
	task(name: string): AnyTask | undefined;
}

/** Read side of a registry consumed by a Harness. */
// Harness 消费的注册表只读接口；应用侧 Registry 在其上增加 install/uninstall。
export interface RegistryReader<Tool extends ToolRegistration = ToolRegistration> {
	/** Immutable view of the whole current registry. */
	// 当前整份注册表的不可变快照。
	snapshot(): RegistrySnapshot<Tool>;
	/** Called synchronously after every publication; wakes the scheduler to reconsider blocked tasks. */
	// 每次发布后同步调用监听器；Harness 用它唤醒调度器重新检查被阻塞任务。返回取消订阅函数。
	subscribe(listener: () => void): () => void;
}

/** Application-owned registry of extensions. */
// 应用持有的扩展注册表；安装/卸载会立即发布新快照。
export interface Registry<Tool extends ToolRegistration = ToolRegistration> extends RegistryReader<Tool> {
	/** Install `extension`, or replace the installed extension with its name in place. Publishes at once. */
	// 安装扩展；同名扩展原地替换，保持安装顺序，并立即发布。
	install(extension: Extension<Tool>): void;
	/** Remove the installed extension with `extension.name`, whichever object it is. A later install appends. */
	// 按名字卸载扩展（不要求传入同一对象）；之后重新安装会追加到末尾。
	uninstall(extension: Extension): void;
}

/** Stored choices of one conversation; names, not objects. Unset fields follow the host. */
// 会话持久化的 Agent 选择：只存扩展/工具/任务的名字，不存对象；未设置字段继承宿主默认值。
export type AgentState = {
	// 模型 provider/modelId；未设置时使用宿主默认模型。
	model?: ModelRef;
	// 思考级别（如 off/low/high）；未设置时使用模型/宿主默认值。
	thinkingLevel?: ModelThinkingLevel;
	/** An array selects exactly these extensions, in order. An object edits the host default selection. */
	// 扩展选择：数组表示精确选择这些扩展及其顺序；对象表示在宿主默认选择上增删。
	extensions?: string[] | { add?: string[]; remove?: string[] };
	/** Filters the selected extensions' tools: the enabled tools. An array enables exactly these, in order. */
	// 从已选扩展的工具中筛出启用工具：数组表示精确启用这些；对象表示删除部分工具。
	tools?: string[] | { remove: string[] };
	/**
	 * Filters the enabled tools the model may call (`callers` includes `model`): the tools offered to it. Never widens:
	 * other tools can still call the ones it leaves out.
	 * - Unset: every such tool except deferred ones.
	 * - An array: exactly these, in order, deferred ones too.
	 * - An object: every such tool except deferred ones and those in `remove`, in registry order, followed by the
	 *   deferred tools in `add` that are not in `remove`, in `add` order. Names of tools that are not deferred or not
	 *   registered have no effect in `add`.
	 */
	// 进一步筛选“提供给模型”的工具；不会扩大可调用集合，未提供的工具仍可被其他工具调用。
	modelTools?: string[] | { remove?: string[]; add?: string[] };
	/** Rendered after every extension section, as the section `instructions`. */
	// 自定义指令文本，作为 instructions section 放在所有扩展 section 之后渲染。
	instructions?: string;
	/** Directory within the environment's file system, passed to `HarnessOptions.env`. */
	// 会话工作目录，传给 HarnessOptions.env 构建执行环境。
	cwd?: string;
	/**
	 * Tool rounds one run takes at most (`pi.live.run.turns`): the round that reaches it runs its tools, then the run ends
	 * `unanswered` with `turn_limit`. An integer, `1` or more; unset, no limit. Task-owned children and forks inherit it.
	 */
	// 单次运行最多工具轮数；达到上限的轮仍执行工具，然后以 unanswered/turn_limit 结束。子任务与 fork 继承。
	maxTurns?: number;
};

/** A change to `pi.agent`: a given field replaces the stored one, `null` clears it, `undefined` changes nothing. */
// 修改 AgentState 的补丁：给出的字段替换旧值，null 清除，undefined 不改；数组/对象增删按字段语义处理。
export type AgentChange = {
	readonly model?: ModelRef | null;
	readonly thinkingLevel?: ModelThinkingLevel | null;
	// 扩展：对象数组表示整体替换；{add,remove} 表示增删；null 清除为宿主默认选择。
	readonly extensions?:
		| readonly Extension[]
		| { readonly add?: readonly Extension[]; readonly remove?: readonly Extension[] }
		| null;
	// 工具启用集合：数组整体替换；{remove} 删除；null 清除。
	readonly tools?: readonly ToolRegistration[] | { readonly remove: readonly ToolRegistration[] } | null;
	/** Replaces the stored filter as a whole; tools loaded with `control.addTools` are in its `add`. */
	// modelTools 过滤整体替换；通过 control.addTools 加载的工具会体现在 add 中。
	readonly modelTools?:
		| readonly ToolRegistration[]
		| { readonly remove?: readonly ToolRegistration[]; readonly add?: readonly ToolRegistration[] }
		| null;
	readonly instructions?: string | null;
	readonly cwd?: string | null;
	/** `configure()` throws a `RangeError` unless it is an integer `1` or more (or `null`). */
	// maxTurns 必须是 >=1 的整数或 null；configure() 否则抛 RangeError。
	readonly maxTurns?: number | null;
};

/** A conversation's agent resolved against a registry snapshot and the settings. */
// 会话 Agent 的解析结果：把存储的选择（AgentState）与注册表快照、宿主设置合并后的具体对象。
export type Agent<Tool extends ToolRegistration = ToolRegistration> = {
	// 已解析模型与思考级别。
	readonly model?: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	// 已选扩展对象，按生效顺序。
	readonly extensions: readonly Extension<Tool>[];
	/** The tools a request offers, in order: enabled, callable by the model, and selected by `modelTools`. */
	// 本次请求真正提供给模型的工具（已启用、callers 含 model、且经 modelTools 过滤），按顺序。
	readonly tools: readonly Tool[];
	/** The tools nested calls (`executeTool()`) resolve among, in order: enabled and callable by tools. */
	// executeTool() 可解析到的工具（已启用且 callers 含 tools），按顺序。
	readonly callable: readonly Tool[];
	/** Enabled deferred tools the model may call and is not offered yet, in registry order: what `tool_search` loads. */
	// 已启用但尚未提供给模型的延迟工具，模型可经 tool_search/control.addTools 加载。
	readonly deferred: readonly Tool[];
	/** Extension sections, then `instructions` when set. */
	// 系统提示 section：先扩展 section，后 instructions。
	readonly sections: readonly PromptSection<Tool>[];
	readonly instructions?: string;
	readonly cwd?: string;
	/**
	 * Tool rounds one run takes at most (`pi.live.run.turns`): the round that reaches it runs its tools, then the run ends
	 * `unanswered` with `turn_limit`. An integer, `1` or more; unset, no limit. Task-owned children and forks inherit it.
	 */
	// 单次运行最多工具轮数；达到上限的轮仍执行工具，然后以 unanswered/turn_limit 结束。子任务与 fork 继承。
	readonly maxTurns?: number;
};

/**
 * Runs inside the creating commit, after the creation hook and the `agent` change. The conversation creation is already
 * a table write, so table reads here throw `ReadAfterWrite`; document access remains available.
 */
// 会话初始化回调：在创建提交内、创建钩子与 agent 变更之后运行；此阶段表读取会抛 ReadAfterWrite，文档读写仍可用。
export type ConversationInit = (tx: Tx, conversationId: ConversationId) => void | Promise<void>;

// 创建会话的选项：所有权、创建提交中应用的 Agent 变更、初始化回调。
export type ConversationCreateOptions = {
	readonly ownership: ConversationOwnership;
	/** Applied in the creating commit after the creation hook's copy, before `init`. */
	// 在创建提交内应用：先复制创建钩子的结果，再应用该 agent 变更，最后执行 init。
	readonly agent?: AgentChange;
	readonly init?: ConversationInit;
};

/** Curated pi-ai request options; absent fields use pi-ai defaults. */
// 精选的 pi-ai 请求选项；未设置字段使用 pi-ai 默认值。
export type ConversationStreamOptions = {
	transport?: Transport;
	timeoutMs?: number;
	/** Provider/SDK retries inside one request attempt. */
	// 单次请求尝试内部的 provider/SDK 重试次数与最大重试延迟。
	maxRetries?: number;
	maxRetryDelayMs?: number;
	headers?: Record<string, string>;
	metadata?: JsonObject;
	cacheRetention?: CacheRetention;
	// 延迟/后台请求配置；window 指定延迟窗口。
	deferred?: boolean | { window?: "15m" | "1h" | "24h" };
};

/** Durable generation attempt retries; the JSON shape of pi-ai `RetryPolicy`. */
// Durable 层对生成尝试的重试策略；字段形状与 pi-ai RetryPolicy 一致，便于存储/传输。
export type ConversationRetryPolicy = {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxAgentDelayMs?: number;
};

/** Automatic compaction thresholds (spec §8.7); manual compaction ignores `enabled`. */
// 自动压缩阈值（spec §8.7）；手动 compact() 不受 enabled 影响。
export type CompactionPolicy = {
	/** Threshold and overflow compaction. */
	// 是否启用阈值压缩与溢出压缩。
	enabled: boolean;
	/** Room kept free for the answer: generation blocks to compact above `contextWindow - reserveTokens`. */
	// 为回答预留的 token；上下文超过 contextWindow-reserveTokens 时阻塞并先压缩。
	reserveTokens: number;
	/** Approximate size of the recent context a summary keeps verbatim. */
	// 摘要原样保留的近期上下文 token 估算值。
	keepRecentTokens: number;
	/** Background compaction starts `backgroundTokens` below the blocking threshold; `0` disables it. */
	// 后台压缩比阻塞阈值提前的 token 数；0 表示关闭后台压缩。
	backgroundTokens: number;
};

/**
 * Harness-wide compaction settings. `modelOverrides` is keyed by exact `"provider/modelId"`; each field it sets
 * replaces the harness-wide one for that model, so small- and large-window models can share a harness.
 */
// Harness 级压缩设置；modelOverrides 按精确 "provider/modelId" 覆盖单个模型字段，字段级覆盖而非整体替换。
export type CompactionSettings = Partial<CompactionPolicy> & {
	readonly modelOverrides?: Readonly<Record<string, Partial<CompactionPolicy>>>;
};

/**
 * How often running progress is committed, and how long it may wait in memory before it is stored. Progress commits are
 * deferred (`CommitPersistence`): watches see each at once, and Storage gets them together, at the run's next phase
 * boundary or after `persistWithinMs`. A host can commit less often, so live answers and tool output appear in larger steps.
 */
// 运行中进度的提交节奏：partial/output 限制最小间隔；持久化延迟由 persistWithinMs 控制，崩溃最多丢这么多进度。
export type ProgressPolicy = {
	/** Minimum pause between commits of the answer being generated. */
	// 生成中回答片段两次提交之间的最小停顿。
	partialIntervalMs: number;
	/** Minimum pause between commits of running tool output; large commits also pause in proportion to their size. */
	// 工具运行输出的最小提交间隔；大块输出还会按体积额外延迟。
	outputIntervalMs: number;
	/**
	 * How long these commits, and other deferred commits without their own `withinMs`, may stay in memory before they are
	 * stored (`CommitPersistence`); a crash loses at most about this much of an answer or of tool output. Default 1,000;
	 * `Infinity` stores them only at the next commit that reads or writes their document and at close.
	 */
	// 延迟提交在内存中最多停留的毫秒数；默认 1000，Infinity 表示只在下次文档读写提交或关闭时落盘。
	persistWithinMs: number;
};

/** Why a compaction runs: `compact()`, a threshold in generation preparation, or a context overflow. */
// 压缩原因：手动 compact()、生成准备时达到阈值、或上下文溢出。
export type CompactionReason = "manual" | "threshold" | "overflow";

/**
 * `entryId` of a blocking compaction's summary, or the `submissionId` of a conversation-owned compaction's summary
 * write; both absent when nothing was compacted.
 */
// 压缩结果：阻塞式压缩返回摘要 entryId；会话自有压缩返回摘要写入的 submissionId；未压缩则都为空。
export type CompactionResult = { entryId?: EntryId; submissionId?: SubmissionId };

/** Harness-wide run policy. Read at every resolution and never copied; getters are fine. Synchronous: some readers run on the Session line. */
// Harness 全局运行策略：每次解析都重新读取、不复制快照，因此可用 getter；必须同步返回（部分读取发生在 Session line）。
export type HarnessSettings = {
	/** Default extension selection; absent: every installed extension, in install order. */
	// 默认扩展选择；省略表示使用全部已安装扩展（按安装顺序）。
	readonly extensions?: readonly Extension[];
	readonly stream?: ConversationStreamOptions;
	readonly retry?: Partial<ConversationRetryPolicy>;
	readonly compaction?: CompactionSettings;
	readonly progress?: Partial<ProgressPolicy>;
	// 默认工具执行模式（parallel/sequential）。
	readonly toolExecution?: ToolExecutionMode;
	// steering 队列放置策略：all 或 one-at-a-time。
	readonly steeringMode?: QueueMode;
	// follow-up 队列放置策略：all 或 one-at-a-time。
	readonly followUpMode?: QueueMode;
	/**
	 * How long an idle conversation keeps its last context read in memory, so its next run reads only newer entries.
	 * Busy conversations always keep it; `0` drops it once the conversation is idle.
	 */
	// 空闲会话在内存中保留上次 context 读结果的时长，便于下次只读新条目；忙碌会话始终保留，0 表示空闲即释放。
	readonly contextRetentionMs?: number;
	/**
	 * How long a loaded document that no watch observes stays in memory after its last read or write;
	 * the next access loads it from Storage. Observed documents always stay. Default ten minutes; `0` drops one right
	 * after use; `Infinity` keeps them. Anything else that is not a number of milliseconds means the default.
	 */
	// 无观察者的已加载文档在最后一次读写后保留多久；默认 10 分钟，0 表示用完即释放，Infinity 永久保留。
	readonly documentRetentionMs?: number;
	/**
	 * What a run that fails (`model_error`, `no_model`, `interrupted`, `restart_limit`, `nothing_to_answer`,
	 * `turn_limit`) does with the inputs queued behind it: `keep` leaves them queued until the next input or queued write, `continue` starts the
	 * next run with them, as an answer would, and `withdraw` settles them `unanswered` with reason `run_failed`. Default
	 * `keep`.
	 */
	// 运行失败后对排队输入的处理：keep 保持排队，continue 立即开始下一轮，withdraw 以 unanswered/run_failed 结算。默认 keep。
	readonly afterFailedRun?: AfterFailedRun;
	/**
	 * How many times in a row a task may be cut off by a crash, eviction, or reset (a close does not count) without
	 * changing its state before it ends instead of running again: a tool call with an error result, a compaction failed
	 * into `pi.live.compactionFailure`, a run with `pi.live.runFailure` reason `restart_limit`, any other task `faulted`
	 * with detail `{ reason: "restart_limit" }`. A generation's request or poll the host died during is a failed attempt
	 * under `retry` first; the limit bounds it only when charging that attempt keeps being cut off. Default 5;
	 * `Infinity` never ends a task for it.
	 */
	// 任务因崩溃/驱逐/重置连续中断且未改变状态的最大次数；达到后不再重跑，而是按任务类型进入错误/失败终态。默认 5。
	readonly restartLimit?: number;
};

/**
 * What a failed run does with the inputs queued behind it (`HarnessSettings.afterFailedRun`): a run that ends with
 * `model_error`, `no_model`, `interrupted`, `restart_limit`, `nothing_to_answer`, or `turn_limit`.
 */
// 失败运行之后排队输入的处置方式，与 HarnessSettings.afterFailedRun 对应。
export type AfterFailedRun = "keep" | "continue" | "withdraw";

/** Resolved settings: every field over its built-in default, object fields merged. */
// 解析后的设置：每个字段都有值（内置默认），对象字段与默认值合并；供内部直接读取。
export type Settings = {
	/** Absent: every installed extension, in install order. */
	// 省略表示全部已安装扩展。
	readonly extensions?: readonly Extension[];
	readonly stream: ConversationStreamOptions;
	readonly retry: ConversationRetryPolicy;
	/** Harness-wide policy over the defaults; per-model overrides apply where the model is known. */
	// 压缩策略已合并默认值；模型已知时再叠加 modelOverrides。
	readonly compaction: CompactionPolicy & Pick<CompactionSettings, "modelOverrides">;
	readonly progress: ProgressPolicy;
	readonly toolExecution: ToolExecutionMode;
	readonly steeringMode: QueueMode;
	readonly followUpMode: QueueMode;
	readonly contextRetentionMs: number;
	readonly documentRetentionMs: number;
	readonly afterFailedRun: AfterFailedRun;
	readonly restartLimit: number;
};

/** What `HarnessOptions.env` builds an environment for. */
// HarnessOptions.env 构建执行环境的输入：目标会话、cwd 与文档读取入口。
export type EnvTarget = {
	readonly conversationId: ConversationId;
	/** The conversation's agent `cwd`. */
	// 该会话 Agent 配置的工作目录。
	readonly cwd?: string;
	readonly read: DocumentReader;
};

// 打开 Harness 的选项：模型、注册表、设置、环境、时钟、定时器、唤醒、错误报告等。
export type HarnessOptions<Tool extends ToolRegistration = ToolRegistration> = {
	/** Host-owned adapter for content-free admission/phase telemetry; propagation and metrics are optional. */
	// 宿主提供的遥测适配器，记录不含内容的准入/阶段信息；传播与指标可选。
	readonly telemetry?: TelemetryContext;
	/**
	 * pi-ai model access used by generation, compaction, hooks and tools: a `Models`, or a function returning the current
	 * one, called at each use, so a host can replace its model configuration without reopening the Harness.
	 */
	// 生成、压缩、钩子和工具使用的模型入口；可传函数，每次使用都调用，便于热替换模型配置。
	readonly models: Models | (() => Models);
	/**
	 * How model requests identify the app to providers, merged field by field over `DEFAULT_HARNESS_IDENTITY`
	 * (`{ attribution: PI_ATTRIBUTION }`, provider attribution to pi). It applies to every request through the Harness's
	 * models, including hooks and tools, and overrides the identity the `Models` was created with; a request's own
	 * `identity` overrides it. Pass `{ attribution: null }` to send no attribution headers.
	 */
	// 请求携带的应用标识；逐字段覆盖 DEFAULT_HARNESS_IDENTITY，请求自身 identity 优先级更高；attribution:null 不发归因头。
	readonly identity?: ClientIdentity;
	readonly registry: RegistryReader<Tool>;
	/** Run settings, or a function returning the current ones; read at each use either way. */
	// 运行设置，或返回设置的函数；无论哪种都在每次使用时重新读取。
	readonly settings?: HarnessSettings | (() => HarnessSettings | undefined);
	/** Builds a conversation's environment at each use. Never called on the Session line; may be async. */
	// 每次使用时构建会话执行环境；不在 Session line 上调用，可以异步。
	readonly env?: (target: EnvTarget, context: Context) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
	/**
	 * Runs in every commit that creates or forks a conversation, raw `tx.createConversation()` included, after the
	 * built-in `pi.*` documents and before the conveniences apply `agent` and run `init`. A fork already has its copies.
	 * Table reads throw `ReadAfterWrite`, as in `init`; a throw fails the creating commit.
	 */
	// 每个创建/fork 会话的提交都会在写入 pi.* 文档之后、应用 agent 与 init 之前调用；此处表读取抛 ReadAfterWrite，抛出会使提交失败。
	readonly conversationCreated?: (tx: Tx, conversation: ConversationRecord) => void | Promise<void>;
	/**
	 * The Harness clock, epoch milliseconds; default `Date.now`. Sleeping tasks store deadlines on it, so every process
	 * that opens the same storage must use the same clock.
	 */
	// Harness 时钟（epoch 毫秒），默认 Date.now；共享同一存储的进程必须使用同一时钟，否则睡眠截止时间不一致。
	readonly now?: () => number;
	/**
	 * Arms the timers of the Session, the scheduler, and its tasks: pacing progress commits, freeing idle memory
	 * (`background`), and, without `onWake`, resuming sleeping tasks; and the timers of `TaskRuntime.setTimer()`. The
	 * Node.js environment, file watcher, and image worker keep their own timers. Default `setTimeout`, with background
	 * timers unreferenced, or declined in Cloudflare Workers and where they cannot be unreferenced. Tests can pass fake
	 * timers; a host can keep timers off a process that should hibernate.
	 */
	// 定时器工厂：控制进度提交节奏、空闲内存释放、无 onWake 时恢复睡眠任务，以及 TaskRuntime.setTimer。默认 setTimeout。
	readonly setTimer?: SetTimer;
	/**
	 * Wakes the process for sleeping tasks instead of a `setTimer` timer. Without it, while scheduling runs, a timer that
	 * keeps the process alive resumes sleeping tasks when they are due. With it, the Harness arms no timer for them: it
	 * calls `onWake` after open and whenever `Harness.wake()` changes, and the host arms its own wakeup, such as a
	 * Durable Object alarm, and calls `resume()` when it fires. Called in a microtask the Session line never waits for,
	 * after the commit that changed the value was adopted, so a host arms a recovery wakeup before calls that can start
	 * work. It may call `wake()` and `resume()`, and must not block. A throw is reported, and the value is offered again
	 * at the next change.
	 */
	// 宿主唤醒回调：提供后 Harness 不为睡眠任务设定时器，而是在状态变化时告知宿主最早唤醒时间；宿主自行唤醒并调用 resume()。
	readonly onWake?: (wake: Wake) => void;
	/**
	 * Receives failures that do not fail the calling operation, such as a throwing hook or listener, a task that faulted,
	 * and the error that fails the Session, once: one `Report`, the `error` and what happened (`kind` and the fields of
	 * its `ReportInfo`). A host can tell a failed Session (`storage_failed`, often a platform reset) from a faulted task
	 * (`task_faulted`). Its own throw or rejection is dropped.
	 */
	// 非致命错误上报：钩子/监听器抛错、任务 faulted、会话致命错误等，每次一个 Report；回调自身抛错会被丢弃。
	readonly onReport?: (report: Report) => void;
	/**
	 * Open for reading only, as a viewer of a session that another process drives, for example a synced copy on a device
	 * that only shows it. Open recovers nothing: a `running` task stays as committed. Every commit with writes rejects
	 * with `ReadOnlySession` before it reaches Storage, and so does `resume()` and every call that enables scheduling;
	 * the Harness stays usable for reads and watches. `wake()` is always inactive, and `onWake` is never called. Reopen
	 * without it to write.
	 */
	// 只读打开：不执行恢复、不调度、不写 Storage；读取与观察仍可用，wake() 始终 inactive。重新打开时去掉此选项才能写。
	readonly readOnly?: boolean;
};

/**
 * When a Session next needs a running process (`Harness.wake()`). `active`: some task can run now or is running, or a
 * reconcile pass such as open's recovery has not landed yet, so a process that dies must be woken again soon, for
 * example by a recovery alarm. `at`: the earliest sleep not yet due,
 * when there is one. Neither: nothing needs a process until new work is submitted. Tasks blocked on a missing or
 * unmigratable definition, `completing` tasks, and waits on live tasks do not count; the work they wait for does.
 */
// 下一次需要运行进程的时间信息：active 表示现在有活或恢复尚未完成；at 是最早未到期的睡眠截止时间。
export type Wake = { readonly active: boolean; readonly at?: number };

/** Live task and what the scheduler would do with it under the current registry. */
// 单个活跃任务的检视信息：记录本身 + 调度器在当前注册表下对它的状态判定。
export type TaskInspection = {
	readonly record: TaskRecord<JsonValue, JsonValue, JsonValue>;
	readonly state: /** An invocation is active. */
	// 当前有调用正在执行。
		| { readonly kind: "running" }
		/** The next scheduling pass reserves it; `migrates` when its definition is newer and has `migrate`. */
		// 等待下一轮调度预留；migrates 表示定义版本更新且提供 migrate，会先迁移。
		| { readonly kind: "pending"; readonly migrates: boolean }
		/**
		 * Waits for these live tasks: the live part of its `on`, or, when abort-marked, its live ordinary owned work, which
		 * must end before its abort handler starts.
		 */
		// 等待 on 中仍存活的任务；或被标记中止时，等待其普通自有工作清空后才启动中止处理器。
		| { readonly kind: "waiting"; readonly on: readonly TaskId[] }
		/** Sleeps until the Harness clock reaches `until`. */
		// 睡眠到 Harness 时钟达到 until（epoch 毫秒）。
		| { readonly kind: "sleeping"; readonly until: number }
		/** Outcome held until its ordinary owned work drains. */
		// 已产生结果，但需等普通自有工作排空后才结算。
		| { readonly kind: "completing" }
		/** Cannot run here: no registered definition can take it (aborting it settles it as `orphaned`). */
		// 无法在此运行：没有可接收它的任务定义；中止它会被结算为 orphaned。
		| {
				readonly kind: "blocked";
				readonly reason: "missing_task" | "task_too_old" | "migration_failed";
				readonly error?: unknown;
		  };
};

/** Point-in-time view of live work: unfinished tasks and submissions, read on the Session line. */
// 活跃工作的时点快照：调度状态、未完成任务、未结算提交；在 Session line 上读取。
export type HarnessInspection = {
	readonly scheduling: "paused" | "running" | "closing";
	readonly tasks: readonly TaskInspection[];
	/** Queued and placed submissions, in ID order. */
	// 已排队与已放置的提交，按 ID 顺序。
	readonly submissions: readonly SubmissionRecord[];
};

/** Raw active transcript and derived model context. */
// 原始活跃 transcript 及由此推导的模型上下文。
export type ContextView = {
	/** Newest applicable head marker, if any. */
	// 最新且适用的 head 标记（上下文起点），没有则为 undefined。
	readonly head: EntryRecord | undefined;
	/** Raw active entries: the head marker followed by non-head entries from its head through the tail. */
	// 原始活跃条目：head 标记本身，加上从该 head 到末尾的非 head 条目。
	readonly entries: readonly EntryRecord[];
	/** Per entry of `entries`, its model messages after edits and excluded stop reasons, before tool result ordering. */
	// 与 entries 一一对应：每条经过编辑与 stop reasons 过滤后的模型消息，尚未做工具结果排序。
	readonly contributions: readonly (readonly Message[])[];
	/** Model context for the next provider request. */
	// 下一次 provider 请求实际使用的模型上下文（已完成排序与合并）。
	readonly messages: readonly Message[];
};

/** Stateless handle for one conversation, bound to the Harness that returned it. Compare handles by `id`. */
// 会话的无状态句柄，绑定到创建它的 Harness；句柄之间只按 id 比较。
export interface Conversation {
	readonly id: ConversationId;

	/** Resolved with the current registry snapshot and settings. */
	// 用当前注册表快照与设置解析该会话的 Agent。
	agent(context: Context): Promise<Agent>;
	/** `configure()` in its own commit. */
	// 在独立提交中应用 AgentChange（模型、扩展、工具、instructions、cwd、maxTurns）。
	configure(change: AgentChange, context: Context): Promise<void>;

	/**
	 * Durably admit user input, a passive entry write, or a continue. A busy conversation, or one with queued items,
	 * queues input and writes that affect model context in `pi.inbox`; `whenBusy: "reject"` rejects input with
	 * `ConversationBusy` instead and writes nothing. An idle conversation rejects `whenIdle: "reject"` input with
	 * `ConversationIdle` and writes nothing. A write of only `kind` and `data` (no `model`, `head`, or `edits`)
	 * is appended at once, even mid-run, as it changes nothing the model sees. A continue starts a run on the context as
	 * it is, after placing queued items; a busy conversation rejects it with `ConversationBusy`, as it never queues.
	 */
	// 持久化接纳输入/被动写入/continue：忙时按 whenBusy 排队或拒绝；空闲时按 whenIdle 决定；纯 kind+data 写入立即追加。
	submit(submission: SubmissionDraft, context: Context): Promise<Submission>;
	/**
	 * Admit a submission inside the caller's commit `tx` (`Harness.commit()`, `Conversation.commit()`, a task's
	 * `runtime.commit()`), with the same rules, and return its ID: the admission is stored with that commit, or not at all
	 * when the callback throws later or the commit fails. Call it before the commit's first table write (`appendEntry()`,
	 * `createTask()`, `createSubmission()`, another admission): otherwise it throws `ReadAfterWrite`, on every path.
	 * Documents may be read and written before and after it. A rejection (`ConversationBusy`, `ConversationIdle`) throws
	 * before any write, so the callback may catch it. Do not call `Submission` or other Harness reads inside the callback:
	 * they wait for the commit holding the line. Its `pi.durable.submit` span covers the admission only, so its `result`
	 * is provisional. Throws for a transaction of another Session.
	 */
	// 在调用方事务 tx 内接纳提交并返回 ID；与提交同生共死。必须在本次提交首次表写入之前调用，否则抛 ReadAfterWrite。
	submit(tx: Tx, submission: SubmissionDraft): Promise<SubmissionId>;
	/**
	 * Admit a write of a `pi.reset` entry that starts a new context, carrying `handoff` as a user message when given.
	 * Resolves after admission; while busy, it is placed at the next boundary.
	 */
	// 接纳一条 pi.reset 条目，开启新上下文；handoff 作为用户消息带入。忙碌时排到下一个边界放置。
	reset(handoff: string | undefined, context: Context): Promise<void>;
	/**
	 * Admit a manual compaction task and return its ID. It summarizes while the conversation keeps working and places its
	 * summary through a write submission: at once when idle, otherwise at the next boundary (spec §8.7).
	 */
	// 接纳一次手动压缩任务并返回任务 ID；会话继续工作，摘要通过写入提交放置：空闲立即、忙碌排到下一边界。
	compact(instructions: string | undefined, context: Context): Promise<TaskId<CompactionResult>>;

	/** Session commit whose `tx.createTask()` defaults to this conversation; `options` as for `Session.commit()`. */
	// Session 提交，其中 tx.createTask() 默认归属本会话；options 同 Session.commit()。
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context, options?: CommitOptions): Promise<T>;
	/**
	 * Committed raw active transcript and model context. With `at`, the context as of that visible entry: the same view
	 * `fork(at)` would start with, without creating a conversation.
	 */
	// 已提交的活跃 transcript 与模型上下文；at 指定可见条目时，返回 fork(at) 将看到的同一视图但不创建会话。
	context(context: Context, options?: { readonly at?: EntryId }): Promise<ContextView>;
	/** Fork-aware history of this conversation, newest first unless `query.order` is `ascending`. */
	// 感知 fork 的历史条目，默认最新在前（query.order 为 ascending 时反之）。
	entries(
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>>;
	// 从可见条目 at 分叉出新会话，选项控制所有权、Agent 变更与初始化。
	fork(at: EntryId, options: ConversationCreateOptions, context: Context): Promise<Conversation>;
	/**
	 * Withdraw queued inputs (queued writes stay), mark every live non-background task of the ordinary ownership scope,
	 * signal them, and resolve once the scope is idle. Background subtrees survive unless `background` is set.
	 */
	// 收回排队输入（排队写入保留），标记并通知普通所有权范围内的存活非后台任务，待范围空闲后返回；默认不中止后台子树。
	abort(context: Context, options?: ConversationAbortOptions): Promise<void>;
	/**
	 * Resolve when the ordinary ownership scope has no live non-background task: this conversation and the conversations
	 * owned, transitively, by its non-background tasks.
	 */
	// 等待普通所有权范围（本会话及其非后台任务递归拥有的会话）内没有存活非后台任务。
	waitForIdle(context: Context): Promise<void>;
	/**
	 * The structural view (spec §9.3) as a serialized watch; commits made while its listener runs arrive folded. Its
	 * `entries` are a window over the transcript, as `window` says: the newest 50 by default, then appends, dropping the
	 * oldest past 100. Built on the same mount as `Harness.observeConversation()`.
	 */
	// 会话结构视图的串行化 watch；entries 是 transcript 窗口（默认最新 50，超过 100 丢最旧），与 observeConversation 共用挂载。
	watch(context: Context, window?: ConversationWindow): Promise<ConversationWatch>;
}

// Conversation.watch 的句柄类型，值为 ConversationView。
export type ConversationWatch = WatchHandle<ConversationView>;

/** Durable agent harness over one Session. */
// 建立在单个 Session 之上的持久化 agent harness：会话、任务、提交、使用量与观察接口。
export interface Harness extends Session {
	/**
	 * Enable task scheduling. Idempotent; throws after close, and `ReadOnlySession` on a read-only Harness. Calls that
	 * ask for progress enable it too: `Conversation.submit()`, `Conversation.compact()`, `Conversation.abort()`,
	 * `Submission.wait()`, `waitForTask()`, `Harness.waitForIdle()`, and `Conversation.waitForIdle()`. Read-only viewers
	 * never do.
	 */
	// 启用任务调度：幂等；关闭后抛错，只读 Harness 抛 ReadOnlySession。请求进度的调用会自动启用它。
	resume(): void;
	/**
	 * When this Session next needs a running process, from the scheduler's memory: `active` while some task can run now
	 * or is running, `at` for the earliest sleep. Answers also while scheduling is paused. A host that wakes the
	 * process itself, such as a Durable Object alarm, arms from it and calls `resume()` when woken; see
	 * `HarnessOptions.onWake`.
	 */
	// 从调度器内存给出下次需要进程的信息：active 表示现在要跑，at 表示最早睡眠截止；暂停调度时也可查询。
	wake(): Wake;

	/** Return the reserved root conversation, creating it with `agent` and `init` in one commit when absent. */
	// 返回保留的根会话；不存在时在一个提交里用 agent/init 创建。
	root(
		context: Context,
		options?: { readonly agent?: AgentChange; readonly init?: ConversationInit },
	): Promise<Conversation>;
	// 按 ID 查找会话；不存在时 undefined。
	conversation(id: ConversationId, context: Context): Promise<Conversation | undefined>;
	// 创建新会话，应用选项中的所有权、Agent 变更与初始化回调。
	createConversation(options: ConversationCreateOptions, context: Context): Promise<Conversation>;

	// 读取任务记录；不存在时 undefined。
	getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined>;
	/** Live tasks and unsettled submissions. Writes nothing and runs no task code. */
	// 活跃任务与未结算提交的快照；不写 Storage、不运行任务代码。
	inspect(context: Context): Promise<HarnessInspection>;
	/** Reacquire a submission, for example after reopen. */
	// 重新获取提交句柄（例如重新打开 Harness 后）；不存在时 undefined。
	submission(id: SubmissionId, context: Context): Promise<Submission | undefined>;
	/** `not_found` for an unknown submission or one of another conversation than `conversationId`. */
	// 中止提交；未知提交或 conversationId 不匹配时返回 not_found。
	abortSubmission(
		id: SubmissionId,
		context: Context,
		conversationId?: ConversationId,
	): Promise<"aborted" | "already_placed" | "settled" | "not_found">;
	/**
	 * Commit the abort mark, signal and join an active run invocation, and schedule the abort invocation. A task whose
	 * definition cannot take it settles as `orphaned` instead.
	 */
	// 中止任务：先提交中止标记，通知并等待当前运行调用，再调度中止处理器；定义不支持中止的任务结算为 orphaned。
	abortTask(id: TaskId, context: Context): Promise<"marked" | "terminal">;
	/** Resolve with the terminal receipt; cancelling `context` cancels only this wait. */
	// 等待任务终态并返回回执；取消 context 只取消等待，不取消任务。
	waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>>;
	/** Resolve when the ordinary ownership scope of every ownerless conversation has no live non-background task. */
	// 等待所有无主会话的普通所有权范围内没有存活非后台任务。
	waitForIdle(context: Context): Promise<void>;
	/** Session total: every conversation's `pi.usage` summed. */
	// 会话总量：所有会话 pi.usage 的汇总。
	usage(context: Context): Promise<UsageState>;
	/**
	 * Every live task with its owner edge, status, and owned conversations (spec §9.4), as a serialized watch; commits
	 * made while its listener runs arrive folded.
	 */
	// 整个任务图的串行化 watch：每个活跃任务及其所有者边、状态、拥有的会话；监听期间的提交合并后送达。
	watchTaskGraph(context: Context): Promise<TaskGraphWatch>;
	/**
	 * Attach a synchronous `Observer` to a conversation's structural view (spec §9.3), atomically on the Session line,
	 * for adapters: `advance` gets each next revision with its operations as memory adopts the commit, inside Storage's
	 * `adopt` for a stored one and before it is stored for a deferred one, so it only records it. `window` as for
	 * `Conversation.watch()`; each observer has its own. `context` governs only the attachment.
	 */
	// 在 Session line 上原子挂接同步 Observer 到会话结构视图；advance 在内存采纳提交时取得增量操作，只记录不阻塞。
	observeConversation(
		id: ConversationId,
		observer: Observer<ConversationView>,
		context: Context,
		window?: ConversationWindow,
	): Promise<Observation<ConversationView>>;
	/**
	 * Attach a synchronous `Observer` to the task graph (spec §9.4), as `observeConversation()` does to a view. A
	 * `blocked` reason that changes without a commit (a registry change, a failed migration) advances it on the Session
	 * line outside any commit and `adopt`, with the background context.
	 */
	// 挂接同步 Observer 到任务图；不伴随提交的 blocked 原因变化也会在 Session line 上以 background context 推送。
	observeTaskGraph(observer: Observer<TaskGraph>, context: Context): Promise<Observation<TaskGraph>>;
}

/**
 * What a hook may use: committed reads and the asking task's memos, which hooks and the task share. Hooks run off the
 * Session line, so reads see what is committed when they run; a hook rerun after a crash may see more.
 */
// 钩子可用的能力：已提交读取 + 任务 memo（钩子与任务共享）。钩子不在 Session line 上运行，读取看到调用时的已提交状态。
export interface HookApi extends DocumentReader {
	readonly taskId: TaskId;
	readonly conversationId: ConversationId;
	/** The current `HarnessOptions.models`, read at each access. */
	// 每次访问都读取当前 HarnessOptions.models。
	readonly models: Models;
	memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
	memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
	/** Committed entry visible from the task's conversation, as `TaskRuntime.entry()`. */
	// 读取任务所在会话可见的已提交条目；不存在/不可见时 undefined。
	entry(id: EntryId, context: Context): Promise<EntryRecord | undefined>;
	/** Undefined when the entry is absent, not visible, or has another kind. */
	// 带类型 token 的读取：条目不存在、不可见或 kind 不符时返回 undefined。
	entry<D extends JsonValue>(token: Entry<D>, id: EntryId, context: Context): Promise<TypedEntry<D> | undefined>;
	/** Committed raw history of the task's conversation, as `TaskRuntime.entries()`. */
	// 读取任务所在会话的已提交原始历史，分页接口同 TaskRuntime.entries()。
	entries(
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>>;
}

// 钩子返回值：可同步返回、返回 undefined 表示不改，或返回 Promise。
export type HookResult<T> = T | undefined | Promise<T | undefined>;

/** Hooks of the built-in generation task. */
// 内置 generation 任务的钩子集合；按任务名注册，Harness 在生成流程的相应节点调用。
export interface GenerationHooks {
	/** Before every request attempt, including recovery; the result is used for that request only. */
	// 每次请求尝试前（含恢复）调用；返回的 messages 只影响本次请求。
	beforeRequest(
		request: { readonly messages: readonly Message[] },
		api: HookApi,
		context: Context,
	): HookResult<{ readonly messages: readonly Message[] }>;
	/**
	 * After pi-ai builds the provider request body, before it is sent; the result replaces the body for that request only.
	 * Runs again whenever pi-ai rebuilds the body, such as a retry within one attempt. The body is in the provider API's
	 * own format (`request.model.api`), so a hook checks the API before changing it.
	 */
	// pi-ai 构造完 provider 请求体、发送前调用；返回的 payload 只替换本次请求。重试重建请求体时会再次运行。
	beforeProviderRequest(
		request: { readonly model: Model<Api>; readonly payload: unknown },
		api: HookApi,
		context: Context,
	): HookResult<{ readonly payload: unknown }>;
	/** Every terminal provider message, before classification. */
	// 每个终态 provider 消息在分类前调用；用于观察原始响应。
	afterResponse(message: AssistantMessage, api: HookApi, context: Context): void | Promise<void>;
	/** A final answer; the first `continue` appends a user message and continues the run. */
	// 模型给出最终回答时调用；第一个返回 continue 的钩子会追加用户消息并继续本次运行。
	onYield(answer: AssistantMessage, api: HookApi, context: Context): HookResult<{ readonly continue: UserInput }>;
	/** After every tool of the round is terminal; `results` are the round's result entries in call order. */
	// 本轮所有工具都进入终态后调用；results 按调用顺序给出结果条目 ID。
	afterTools(assistant: EntryId, results: readonly EntryId[], api: HookApi, context: Context): void | Promise<void>;
	/**
	 * After a run answered, its answer committed and its inputs settled `done`: a final answer, or a `terminate` round;
	 * not when an `onYield` continuation is taken, and never after a failure or an abort. The requested tasks of every
	 * hook are created together as children of the generation, which keeps the run, and the conversation busy, until
	 * they are terminal; then queued items are placed and the run ends (spec §8.3). A crash before they are created asks
	 * again; once created, never again for this run.
	 */
	// 运行已回答、回答已提交且输入已 done 后调用；返回的任务作为 generation 子任务创建，全部终态后才放置排队项并结束运行。
	afterRun(run: RunSummary, api: HookApi, context: Context): HookResult<{ readonly tasks: readonly RunEndTask[] }>;
}

/** How a run ended, for `afterRun` hooks. Read the run's history with `api.entries({ minEntryId: first, maxEntryId: last })`. */
// 运行结束摘要，供 afterRun 钩子使用；可用 api.entries 按 first..last 读取本轮历史。
export type RunSummary = {
	/** A final answer, or a tool round whose every call asked to `terminate`. */
	// answer：正常最终回答；terminate：整轮所有调用都要求终止。
	readonly reason: "answer" | "terminate";
	/**
	 * The run's first entry (`LiveRun.first`): the first one the boundary that started it placed, for a continue the failed
	 * run's it continues, otherwise its first tool-calling answer; the answer itself for a run that has none of these.
	 */
	// 本轮第一条条目：启动边界的首条；continue 时为被继续运行的对应条目；否则为首个工具调用回答；都没有则就是回答本身。
	readonly first: EntryId;
	/** The answer, or the terminating round's tool-calling answer, whose results follow it. */
	// 回答条目；terminate 轮中为触发终止的工具调用回答，其结果条目排在其后。
	readonly answer: EntryId;
	/** The run's last entry: the answer; for a `terminate` round its newest result, or the reset of its handoff. */
	// 本轮最后一条：普通回答即回答条目；terminate 轮为最新结果条目或 handoff 的 reset 条目。
	readonly last: EntryId;
};

/** A task an `afterRun` hook asks for, built by `runEndTask()`. */
// afterRun 钩子请求创建的任务：任务定义 + 输入；通常由 runEndTask() 构造。
export type RunEndTask = { readonly task: AnyTask; readonly input: JsonValue };

/** A call as tool hooks see it; `parent` is set for a nested call, one a running tool made through `executeTool()`. */
// 工具钩子看到的调用；嵌套调用（executeTool 发起）带 parent 指明父任务与父 callId。
export type ToolHookCall = ToolCall & {
	readonly parent?: { readonly taskId: TaskId; readonly callId: string };
};

/** Hooks of the built-in tool task, for model-issued and nested calls. */
// 内置 tool 任务的钩子；模型发起的调用与嵌套调用都会经过。
export interface ToolHooks {
	/** Before intent; the first `block` wins, otherwise `arguments` replace the call's arguments. A throw blocks. */
	// 记录调用意图前调用：第一个 block 生效；否则 arguments 替换参数；钩子抛错等同阻塞。
	beforeTool(
		call: ToolHookCall,
		api: HookApi,
		context: Context,
	): HookResult<{ readonly arguments?: JsonObject; readonly block?: string }>;
	/**
	 * Before the result is committed; replaces the result. Runs on every result the tool task writes: an executed
	 * call's, and the error results the Harness writes itself, told apart by their diagnostic code: a tool that does not
	 * resolve (`tool_unavailable`), invalid arguments (`invalid_arguments`, with `call.arguments` as the model sent
	 * them), a block (`blocked`), and, rebuilt from the call's partial output, an interruption (`interrupted`), the
	 * restart limit (`restart_limit`), and an abort (`aborted`, `abandoned`). Once the task was cut off more than
	 * `settings.restartLimit` times the hooks no longer run, since they may be what cuts it off, nor in the last attempt
	 * the scheduler gives an abort handler (restarts at the limit minus one). A result's `structuredOutput` is dropped
	 * when the Harness wrote it (a nested call a hook turns into a success gets the bounded output as a schema-less tool's
	 * does), and its `control` applies only to a call that completes (not to an interrupted, cut-off, or aborted one).
	 * An abort's hooks run inside the abort handler, which cannot be aborted: a slow hook delays `Conversation.abort()`.
	 */
	// 结果提交前调用并替换结果；执行结果与 Harness 生成的错误结果都会经过，可按 diagnostic code 区分。
	afterTool(
		call: ToolHookCall,
		result: ToolExecutionResult,
		api: HookApi,
		context: Context,
	): HookResult<ToolExecutionResult>;
}

/** Hooks of the built-in compaction task. */
// 内置压缩任务的钩子。
export interface CompactionHooks {
	/**
	 * After range selection, before summarizing; the first decision wins. `entries` are the active entries the summary
	 * replaces, the head marker first, and `messages` their model context, the summarizer's source; `firstKept` is the
	 * first entry kept verbatim.
	 */
	// 选定压缩范围后、摘要前调用：第一个决定生效；entries/messages 是被替换的条目及其模型上下文，firstKept 为原样保留的首条。
	beforeCompact(
		compaction: {
			readonly reason: CompactionReason;
			readonly entries: readonly EntryRecord[];
			readonly messages: readonly Message[];
			readonly firstKept: EntryId;
			readonly instructions?: string;
		},
		api: HookApi,
		context: Context,
	): HookResult<{ readonly decline: true } | { readonly summary: string }>;
}
