// 所属：packages/durable/src/harness，Durable harness 的实时状态文档层（pi.live）。
// 解决的问题：运行中的生成、工具、嵌套调用需要频繁发布进度，但进度不是对话历史；它必须可观察、可恢复、可清理，
// 且不能因为每次流式提交都写完整文档而放大存储。pi.live 用 latest + fork initial 表示“现在”，用延迟持久化减少写入。
// 职责边界：纯数据操作；任务在自己的提交里调用这些函数，本文件不执行任务、不调度、不提交事务、不解析模型。
// 上游：generation/compaction/tool 任务与 Harness 的调度清理钩子。下游：观察文档的客户端、view 推导和恢复逻辑。
// 能力清单：
// - ToolSlot/NestedToolSlot/NestedToolSummary：模型调用与嵌套调用的进度、参数和结束摘要；
// - CompactionStatus/CompactionFailure：压缩任务状态与最近失败；
// - RunFailureReason/RunFailure/LiveRun/LiveState：运行失败原因、输入结算、工具轮数和顶层状态；
// - LiveDoc：文档定义（latest、fork initial、v3 迁移、checkpointWhen）；
// - PROGRESS_COMMIT：延迟持久化的提交选项；
// - LIMITS_RESTARTS/cutOffTooOften/salvageable/cutOffCount：重启上限判断与可读文案；
// - RunEnd/endRun：结束运行、结算输入、清理展示字段；
// - addCompactionStatus/compactionStatus/removeCompactionStatus/failCompactionStatus：压缩状态增删查改；
// - toolSlot/finishSlot/removeNestedSlots/clearProgress：槽位查找、完成、子槽位清理与进度清空；
// - settleSchedulerOutcome：调度器 faulted/orphaned 终态时的 Harness 清理钩子（工具/压缩/生成各自处理）。
// 典型顺序：任务开始写 run/tools/generation → 节流提交用 PROGRESS_COMMIT 更新 → 完成时 finishSlot/endRun →
//   调度器异常时 settleSchedulerOutcome 兜底清理。
// 示例：endRun(tx, live, taskId, { status: "unanswered", reason: "aborted" });
//   结算 run.inputs 为 unanswered、删除 run 与展示字段；示例在事务回调内调用，函数本身不提交。
// 建议阅读顺序：先读 LiveState/LiveRun 与文档定义，再读 endRun/工具槽位函数，最后读 settleSchedulerOutcome 的分支；
//   cutOff* 与 PROGRESS_COMMIT 可穿插在相关调用点阅读。
import type { Draft } from "@earendil-works/chord/delta";
import type { JsonRepresentation, JsonValue } from "@earendil-works/chord/json";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { defineDoc } from "../documents.ts";
import type { Transaction } from "../session/transaction.ts";
import type {
	CommitOptions,
	EntryId,
	JsonObject,
	SubmissionId,
	SubmissionSettlement,
	TaskId,
	TaskRecord,
	Tx,
} from "../types.ts";
import { convertPartial } from "./generation.ts";
import type { SchedulerOutcome } from "./scheduler.ts";
import type { CompactionReason, CompactionResult, ToolDiagnostic } from "./types.ts";

// SlotProgress 是模型调用与嵌套调用共享的进度字段：状态、保留输出、丢弃计数、详情和诊断。
// 这些字段都是可选的，因为调用在不同阶段发布不同信息；它们只用于展示，不参与模型上下文。
/** What a running tool call publishes, shared by model-issued and nested calls. */
type SlotProgress = {
	callId: string;
	name: string;
	status: "pending" | "running" | "done";
	/** Retained running output and what the bounds dropped. */
	output?: string;
	droppedBytes?: number;
	droppedLines?: number;
	/** Last `details()` value. */
	details?: JsonValue;
	/** Diagnostics recorded through `api.diagnostic()`. */
	diagnostics?: ToolDiagnostic[];
};

// ToolSlot 在进度字段之外带 taskId、unoffered 和 entry：taskId 在顺序轮次里可能尚未分配。
// unoffered 为 true 表示模型请求了未提供的工具，工具任务会直接结算 tool_unavailable，而不执行任何代码。
/** Presentation of one tool call of the current round. */
export type ToolSlot = SlotProgress & {
	/** Absent for a call not started yet (sequential round). */
	taskId?: TaskId;
	/** A call to a tool its request did not offer: its task settles `tool_unavailable` without running anything. */
	unoffered?: true;
	/** Result entry once done; absent when the tool task faulted or was orphaned. */
	entry?: EntryId;
};

// NestedToolSlot 描述工具内部通过 executeTool() 发起的嵌套调用；callId 形如 <parentCallId>/<key>。
// Harness 通过 taskId 关联槽位：taskId 是本次调用的工具任务，parentTaskId 是发起它的任务。
/**
 * Presentation of one nested call: a call a running tool made through `executeTool()`. `callId` is
 * `<parentCallId>/<key>`, the call's ID, unique because keys contain no `/`. The Harness relates
 * slots by task ID: `taskId` is the call's tool task, `parentTaskId` the calling one, model-issued or nested.
 */
export type NestedToolSlot = SlotProgress & {
	parentCallId: string;
	parentTaskId: TaskId;
	taskId: TaskId;
	// 嵌套调用开始时先记录模型给的参数；开始执行后会被修复、beforeTool 改写和类型转换后的实际参数替换。
	/**
	 * What the call was made with, replaced by the arguments it runs with, after repair, `beforeTool`, and coercion,
	 * once it starts executing. A model-issued call's arguments are in its assistant entry instead.
	 */
	arguments: JsonObject;
	// summary 只在调用完成后出现，用于状态行；完整结果保存在调用方任务的文档里，不放在 pi.live。
	/** Once done: how the call ended, for a status line. The result itself is in the caller's `NestedCallDoc`. */
	summary?: NestedToolSummary;
};

// NestedToolSummary 是嵌套调用的结束摘要：是否错误、耗时、花费和最多 500 字符的错误文本。
/** How a nested call ended: an error flag, its execution time, its spend, and up to 500 characters of error text. */
export type NestedToolSummary = {
	isError: boolean;
	durationMs?: number;
	usage?: JsonRepresentation<Usage>;
	error?: string;
};

// CompactionStatus 表示一个正在运行的压缩任务：触发原因、是否阻塞运行、尝试次数和退避时间。
/** Presentation of one live compaction task (spec §8.7). */
export type CompactionStatus = {
	taskId: TaskId<CompactionResult>;
	/** What started it: `compact()`, a threshold, or a context overflow. */
	trigger: CompactionReason;
	/** Whether a generation waits for it: a compaction the generation owns. */
	blocking: boolean;
	attempt: number;
	/** Durable backoff before the next summarization attempt. */
	retry?: { at: number; error: string };
};

// CompactionFailure 保留“最近一次压缩失败”的信息，供压缩任务结束后客户端展示；产生新摘要时会被清除。
/** The newest compaction that failed since a compaction last produced a summary (spec §8.7). */
export type CompactionFailure = {
	taskId: TaskId<CompactionResult>;
	/** What started the compaction that failed. */
	trigger: CompactionReason;
	/** The failed or faulted outcome's error message, or why the scheduler orphaned the task. */
	error: string;
};

// RunFailureReason 是运行无回答结束的原因枚举；它是普通字符串联合，运行时不做枚举校验。
// 各原因的语义：
// model_error：模型响应失败（重试耗尽）或所需压缩失败。
// no_model：没有配置模型，或配置的模型不可用。
// aborted：运行被 Conversation.abort()/abortTask() 取消；detail 可能说明取消处理器多次被切断。
// reset：排队的重置在工具后边界开始了新上下文，尚未回答。
// faulted：任务在无法恢复处抛错，或存储拒绝提交。
// orphaned：任务被取消时没有已注册定义能接管。
// interrupted：宿主在模型回答时停止，超过 settings.retry 的重试次数。
// restart_limit：生成连续被切断 settings.restartLimit 次。
// nothing_to_answer：上下文不以用户消息或工具结果结尾，因此不发送请求。
// turn_limit：工具轮达到会话的 maxTurns；继续运行会从结果恢复。
/**
 * Why a run ended without an answer:
 * - `model_error`: the model's response failed, after any retries, or the compaction a request needed failed;
 * - `no_model`: no model is configured, or the configured one is not available;
 * - `aborted`: the run was aborted (`Conversation.abort()`, `abortTask()`); `detail` says when its abort handler was
 *   cut off `settings.restartLimit` times and did not finish;
 * - `reset`: a queued reset started a new context at the post-tools boundary, before an answer (a tool's handoff
 *   continues the run);
 * - `faulted`: the run's task threw where it cannot recover, or storage rejected its commit;
 * - `orphaned`: the run's task was aborted while no registered definition could take it;
 * - `interrupted`: the host stopped while the model was answering, more often than `settings.retry` retries;
 * - `restart_limit`: the run's generation was cut off `settings.restartLimit` times in a row; a request or poll it was
 *   cut off during counts as a failed attempt first, so this ends one whose charge itself keeps failing;
 * - `nothing_to_answer`: the context did not end in a user message or tool results (empty, or ending in an answer), so
 *   no request was sent, as for a continue after an answer;
 * - `turn_limit`: a tool round reached the conversation's `maxTurns`; a continue resumes on its results.
 */
export type RunFailureReason =
	| "model_error"
	| "no_model"
	| "aborted"
	| "reset"
	| "faulted"
	| "orphaned"
	| "interrupted"
	| "restart_limit"
	| "nothing_to_answer"
	| "turn_limit";

// RunFailure 记录最近一次无回答运行：哪个任务结束、哪些输入被结算、原因和可选细节。
/** The newest run that ended without an answer (spec §8.2). */
export type RunFailure = {
	/** The task that ended the run: the run's task at its end. */
	taskId: TaskId;
	// inputs 是这次运行的输入提交 ID，结束时被结算为 unanswered。
	/** The run's inputs, settled `unanswered`. */
	inputs: SubmissionId[];
	// reason 说明这次运行为何没有回答，取值见 RunFailureReason。
	reason: RunFailureReason;
	/**
	 * `model_error`: the error text; `no_model`: which model is missing; `faulted`: the error message; `orphaned`: why
	 * the task could not run (`missing_task`, `task_too_old`, `migration_failed`); `interrupted` and `restart_limit`: what
	 * was cut off, and how often; `turn_limit`: the tool rounds the run took, `"1 turn"` or `"N turns"`.
	 */
	detail?: string;
	// first 让 afterRun 钩子看到失败运行的历史；与 LiveRun.first 对应。
	/** The failed run's `run.first`, so a continue's `afterRun` hooks see its history too. */
	first?: EntryId;
};

// LiveRun 是运行控制：taskId 负责结算输入，inputs 是已放置输入，turns 记录工具轮数，first 是运行第一条记录。
// afterRun 出现表示已经回答，但还要等待钩子请求的任务；此时队列项继续排队，运行最终不算失败。
/** Run control (spec §8.2). */
export type LiveRun = {
	/** The task that settles the run's inputs: its generation, handed from one to the next. */
	taskId: TaskId;
	/** The run's placed inputs, settled when it ends; `[]` once it answered and runs only its `afterRun` tasks. */
	inputs: SubmissionId[];
	/** Tool rounds so far, which `AgentState.maxTurns` bounds; an `onYield` continuation starts the count over. */
	turns: number;
	/**
	 * The run's first entry: the first one the boundary that started it placed, a continue's the failed run's it
	 * continues; otherwise its first tool-calling answer. A run started before it was recorded may lack it; `afterRun`
	 * hooks then get the answer as the first entry.
	 */
	first?: EntryId;
	/**
	 * Present once the run answered and its generation waits for the tasks `afterRun` hooks asked for, listed once
	 * created: queued items stay queued until they are terminal, and the run then ends without a failure.
	 */
	afterRun?: { tasks?: TaskId[] };
};

// LiveState 是 pi.live 的顶层形状：run 表示忙，generation/tools/nestedTools 表示当前展示，compactions/失败字段用于诊断。
/** Built-in live conversation state: run control and presentation of the current generation and tool round. */
// run 只在忙时存在，包括“已回答但还在等 afterRun 任务”的阶段；空闲时所有展示字段都应被清空。
export type LiveState = {
	/** Run control; present exactly while busy, also while a run that answered runs its `afterRun` tasks. */
	run?: LiveRun;
	// generation 表示当前生成尝试；message 是节流提交的部分助手消息，retry 是退避信息，deferred 是延迟轮询时间。
	/** Presentation of the current generation attempt. */
	generation?: {
		attempt: number;
		/** Committed throttled partial of the in-flight response. */
		message?: JsonRepresentation<AssistantMessage>;
		/** Durable backoff before the next attempt. */
		retry?: { at: number; error: string };
		/** Provider-side deferred response being polled. */
		deferred?: { pollAt: number };
	};
	// tools 只在工具轮存在，按调用顺序排列；generation 的 tools 相位结束后会被删除。
	/** The current tool round in call order, from the tool-calling answer until the generation's `tools` phase ends it. */
	tools?: ToolSlot[];
	// nestedTools 按创建顺序排列，父调用一定在子调用之前，因此 taskId 升序；调用结算时其子槽位被移除。
	/**
	 * Nested calls of running tool calls, in creation order, so a parent precedes its children and task IDs ascend. A
	 * call's nested slots are removed when the call settles.
	 */
	nestedTools?: NestedToolSlot[];
	// compactions 按任务 ID 排序；没有压缩任务时字段被删除。
	/** Live compaction tasks in task ID order; absent when none. */
	compactions?: CompactionStatus[];
	// compactionFailure 是最近一次压缩失败；产生摘要会删除它，被中止或没找到可压缩内容则保留。
	/**
	 * The newest compaction failure, so a client can show it after the task ended. A compaction that produces a summary
	 * removes it; one that is aborted or finds nothing to compact leaves it.
	 */
	compactionFailure?: CompactionFailure;
	// runFailure 由结束运行的提交写入；后续开始新运行的提交会删除它，但同一提交里因 afterFailedRun/重置启动的新运行会保留。
	/**
	 * Why the newest run ended without an answer, so a client can show it after the run ended. Set in the commit that
	 * ends the run; removed when a later commit starts a run. A run started in the same commit, by
	 * `afterFailedRun: "continue"` or after a reset, keeps it.
	 */
	runFailure?: RunFailure;
};

// LiveDoc 是 pi.live 的文档定义：latest 只存最新值，fork initial 让分叉从空状态开始。
// version 3 的 migrate 把旧字段 reason 改名为 trigger，并补上缺少的 run.turns。
// checkpointWhen 决定何时可以写完整检查点而不是增量：没有生成、没有运行中的工具/嵌套槽位时。
export const LiveDoc = defineDoc<LiveState>({
	kind: "pi.live",
	version: 3,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	// Version 1 named a compaction's trigger `reason`, in `compactions` and `compactionFailure`. Versions 1 and 2 (as
	// builds before `run.turns` stored it) may lack `run.turns`: a run in flight across the upgrade counts its turns
	// from 0. Version 2 already names the trigger `trigger`, so renaming leaves it alone.
	// migrate 接收旧版本 JSON，返回新形状；它只在读取旧版本文档时运行一次，不改变已存储记录的版本号字段本身。
	migrate: (value) => {
		// as 是编译期断言：旧值被当成带可选字段的 JsonObject 视图；运行时仍按 typeof 检查 turns。
		const live = value as { run?: JsonObject; compactions?: JsonObject[]; compactionFailure?: JsonObject };
		const { run, compactions, compactionFailure } = live;
		return {
			...value,
			// run 存在但 turns 缺失（旧构建或升级中的运行）时补 0；typeof 是必要的运行时检查，因为输入是旧 JSON。
			...(run === undefined ? {} : { run: { ...run, turns: typeof run.turns === "number" ? run.turns : 0 } }),
			// compactions 与 compactionFailure 的 reason 字段统一改名 trigger；renameReason 保持键顺序。
			...(compactions === undefined ? {} : { compactions: compactions.map(renameReason) }),
			...(compactionFailure === undefined ? {} : { compactionFailure: renameReason(compactionFailure) }),
		} as LiveState;
	},
	// checkpointWhen 的规则：只要没有生成、没有运行中的工具槽位、没有运行中的嵌套槽位，就可以用完整检查点。
	// 这样增量链最多跨越一次生成或一轮重叠工具执行，且运行中的槽位输出是唯一较大的字段。
	// 注意不要添加“增量数量上限”；工具输出基准测试会检查这条规则。
	// REMINDER: a complete base whenever nothing runs (spec §8.2): no generation and no running tool slot. That holds
	// while idle, in the commit handing a generation over to its tool round, and between tools, so the delta chain
	// spans at most one generation or the overlapping execution of one round's tools. A slot holds output only while
	// running, so every base is small; a nested call's result lives in its caller's task documents, never here. Do not
	// add a delta-count bound; the tool output benchmark checks this rule.
	checkpointWhen: (value) =>
		value.generation === undefined &&
		!(value.tools ?? []).some((slot) => slot.status === "running") &&
		!(value.nestedTools ?? []).some((slot) => slot.status === "running"),
});

// renameReason 用 Object.fromEntries 重建对象：键为 reason 时改成 trigger，其余保持不变；Object.entries 保留插入顺序。
/** A copy of a version 1 compaction status or failure with `reason` renamed `trigger`, its keys in their order. */
function renameReason(value: JsonObject): JsonObject {
	return Object.fromEntries(Object.entries(value).map(([key, field]) => [key === "reason" ? "trigger" : key, field]));
}

// PROGRESS_COMMIT 让进度写入延迟持久化：同一次提交里与文档的其他变更一起存储，或在 persistWithinMs 后落盘。
// 观察者仍会立即看到这些值；只有 Storage 写入被推迟，崩溃最多丢失约 persistWithinMs 的进度。
/**
 * How the progress throttles commit a partial answer and running tool output into `pi.live`: deferred, so storage gets
 * them together, at the next commit that reads or writes `pi.live` or after `settings.progress.persistWithinMs`. Every
 * commit that consumes or clears streamed fields reads `pi.live`, so it stores them with its own changes (spec §8.2).
 */
export const PROGRESS_COMMIT: CommitOptions = { persistence: { kind: "deferred" } };

// RUN_TASK_KINDS 是能够拥有 pi.live.run 的内置任务种类；目前只有生成任务。
/** Built-in task kinds that can own `pi.live.run`. */
const RUN_TASK_KINDS: ReadonlySet<string> = new Set(["pi.generation"]);
const TOOL_TASK_KIND = "pi.tool";
const COMPACTION_TASK_KIND = "pi.compaction";

// LIMITS_RESTARTS 列出自带重启上限处理的内置任务：生成、工具、压缩。其他种类的任务被调度器直接 faulted。
/**
 * Built-in task kinds that end themselves once cut off `settings.restartLimit` times (`TaskRecord.restarts`); the
 * scheduler faults a task of any other kind instead (spec §5.4).
 */
export const LIMITS_RESTARTS: ReadonlySet<string> = new Set([...RUN_TASK_KINDS, TOOL_TASK_KIND, COMPACTION_TASK_KIND]);

// cutOffTooOften 判断任务是否已经连续被切断到上限；只有 restarts 已定义时才读取 settings，正常路径不解析设置。
/** Whether `task` was cut off `settings.restartLimit` times in a row, so its phase ends it instead of running. */
export function cutOffTooOften(
	task: { readonly restarts?: number },
	runtime: { readonly settings: { readonly restartLimit: number } },
): boolean {
	// The settings are read only for a task that was cut off at all, so the normal path resolves nothing more.
	return task.restarts !== undefined && task.restarts >= runtime.settings.restartLimit;
}

// salvageable 判断任务在达到上限时是否还能做收尾清理（例如转换部分响应）；超过上限则放弃，因为清理本身可能就是切断原因。
/**
 * Whether a task at the limit may still do the cleanup it does when it ends, such as converting a partial: only at the
 * limit. Past it, that cleanup may be what cut the task off, so the task ends without it.
 */
export function salvageable(
	task: { readonly restarts?: number },
	runtime: { readonly settings: { readonly restartLimit: number } },
): boolean {
	return (task.restarts ?? 0) <= runtime.settings.restartLimit;
}

// cutOffCount 生成人类可读的次数描述："once" 或 "3 times in a row"；restarts 缺省按 0 处理。
/** How often a task was cut off, for a message: "once", or "3 times in a row". */
export function cutOffCount(task: { readonly restarts?: number }): string {
	const restarts = task.restarts ?? 0;
	return restarts === 1 ? "once" : `${restarts} times in a row`;
}

// RunEnd 表示运行结束：有回答时记录答案条目；无回答时记录原因、细节和可选结算方式。
/** How a run ends: with an answer, or without one, settling its inputs `unanswered` and recording why. */
export type RunEnd =
	| { readonly status: "done"; readonly answer: EntryId }
	| {
			readonly status: "unanswered";
			readonly reason: RunFailureReason;
			readonly detail?: string;
			/** The inputs' settlement; default `unanswered` with `reason` and `detail`. */
			readonly settlement?: SubmissionSettlement;
	  };

// endRun 结束 taskId 拥有的运行：结算输入、删除 run，无回答时记录 runFailure。
// 已经回答且只等 afterRun 任务的运行不记录失败；无论哪种结束都清理 generation/tools/nestedTools。
// 例：endRun(tx, live, taskId, { status: "done", answer: entryId }) 把输入结算为 done，并删除运行展示字段（entryId 是 EntryId）。
/**
 * End the run owned by `taskId`: settle each of its inputs, remove `run`, and, without an answer, record
 * `runFailure`. A run that answered already, and runs only its `afterRun` tasks, records no failure, however it ends.
 * Always removes `generation`, `tools`, and `nestedTools`, whose presentation belongs to the ending run.
 */
export function endRun(tx: Tx, live: Draft<LiveState>, taskId: TaskId, end: RunEnd): void {
	// 只有当前 run 属于这个任务时才结算；其他任务可能已经接管运行。
	if (live.run?.taskId === taskId) {
		// 先复制输入 ID 快照：接下来会删除 live.run，结算循环只依赖这份数组。
		const inputs = [...live.run.inputs];
		const { first } = live.run;
		// done：每个输入都结算为 done，并关联答案条目。
		if (end.status === "done") {
			for (const id of inputs) tx.settleSubmission(id, { status: "done", answer: end.answer });
			// 无回答但 afterRun 已定义：运行已经回答过，只是等待子任务；不写 runFailure，输入保持 done。
		} else if (live.run.afterRun === undefined) {
			const { reason, detail } = end;
			// settlement 可由调用方覆盖（例如 turn_limit 想用不同 reason），缺省为 unanswered + reason/detail。
			const settlement = end.settlement ?? {
				status: "unanswered",
				reason,
				...(detail === undefined ? {} : { detail }),
			};
			// 逐个结算输入；settlement 对象被复用，但 settleSubmission 只读取它。
			for (const id of inputs) tx.settleSubmission(id, settlement);
			// runFailure 只在无回答且没有 afterRun 时写入；first 缺省时省略。
			live.runFailure = {
				taskId,
				inputs,
				reason,
				...(detail === undefined ? {} : { detail }),
				...(first === undefined ? {} : { first }),
			};
		}
		// 删除 run 表示运行结束；后面三个字段属于运行展示，无论绑定的是哪个任务都清掉。
		delete live.run;
	}
	delete live.generation;
	delete live.tools;
	delete live.nestedTools;
}

// addCompactionStatus 把新压缩状态追加到列表；??= 在字段缺失时创建空数组。
/** Add the status of a compaction task created in this commit; statuses stay in task ID order. */
export function addCompactionStatus(live: Draft<LiveState>, status: CompactionStatus): void {
	live.compactions ??= [];
	live.compactions.push(status);
}

// compactionStatus 按任务 ID 查找状态；返回 Draft 让调用方原地修改（例如写入 retry/attempt）。
/** The status of compaction task `taskId`, if listed. */
export function compactionStatus(live: Draft<LiveState>, taskId: TaskId): Draft<CompactionStatus> | undefined {
	return live.compactions?.find((status) => status.taskId === taskId);
}

// removeCompactionStatus 找到并删除状态；列表为空时删除字段，保持“无压缩即无字段”的形状。
/** Remove the status of compaction task `taskId`, and the list once empty. */
export function removeCompactionStatus(live: Draft<LiveState>, taskId: TaskId): void {
	const statuses = live.compactions;
	if (statuses === undefined) return;
	const index = statuses.findIndex((status) => status.taskId === taskId);
	if (index >= 0) statuses.splice(index, 1);
	if (statuses.length === 0) delete live.compactions;
}

// failCompactionStatus 把状态转成 compactionFailure 并移除状态；状态不存在时仍会执行移除（无操作）。
/** Remove the status of compaction task `taskId` and record that it failed with `error`. */
export function failCompactionStatus(live: Draft<LiveState>, taskId: TaskId, error: string): void {
	const status = compactionStatus(live, taskId);
	if (status !== undefined) live.compactionFailure = { taskId: status.taskId, trigger: status.trigger, error };
	removeCompactionStatus(live, taskId);
}

// toolSlot 查找工具任务对应的槽位：先在模型调用槽位里线性查找，再在嵌套槽位里二分查找。
// 嵌套槽位可能成千上万，且每个提交都会查找；二分避免每次遍历，减少 Chord 草稿变更跟踪的节点开销。
// 返回 Draft，调用方可以原地更新状态/输出。
/**
 * The slot of tool task `taskId`, model-issued or nested, if `pi.live` still lists it. Nested slots are found by binary
 * search: a tool may make thousands of nested calls, each of which looks up its slot in several commits, and every
 * element a search reads costs a node in the draft's change tracker. Their task IDs ascend: each slot is appended in
 * the commit that creates its task, task IDs ascend in commit order, and removal keeps the order.
 */
// 模型调用槽位数量很少，线性 find 足够；找到就直接返回。
export function toolSlot(live: Draft<LiveState>, taskId: TaskId): Draft<ToolSlot | NestedToolSlot> | undefined {
	const slot = live.tools?.find((each) => each.taskId === taskId);
	// 没有嵌套槽位字段时无需二分；返回 undefined。
	if (slot !== undefined || live.nestedTools === undefined) return slot;
	const nested = live.nestedTools;
	// 嵌套槽位按 taskId 升序：创建提交顺序递增，删除保序；因此可以二分。
	let low = 0;
	let high = nested.length - 1;
	// >>> 1 同样是无符号右移求中位；candidate 的非空断言由 while 边界保证。
	while (low <= high) {
		const middle = (low + high) >>> 1;
		const candidate = nested[middle]!;
		if (candidate.taskId === taskId) return candidate;
		if (candidate.taskId < taskId) low = middle + 1;
		else high = middle - 1;
	}
	return undefined;
}

// finishSlot 标记槽位完成并清空运行输出；调用方再设置模型调用的 entry 或嵌套调用的 summary。
// 任务 faulted/orphaned 时不会设置结果字段，但状态仍要置为 done，避免界面一直显示运行中。
/**
 * Mark a slot done and clear its running output; the caller sets a model-issued call's result `entry`, or a nested
 * call's `summary`. Neither is set when the task faulted or was orphaned.
 */
export function finishSlot(slot: Draft<ToolSlot | NestedToolSlot>): void {
	slot.status = "done";
	clearProgress(slot);
}

// removeNestedSlots 删除 taskId 之下的所有嵌套槽位（含子孙）：列表父在子前，所以一次前向扫描即可传播删除集合。
/** Remove the nested slots below tool task `taskId`, transitively; the list holds parents before their children. */
export function removeNestedSlots(live: Draft<LiveState>, taskId: TaskId): void {
	const nested = live.nestedTools;
	if (nested === undefined) return;
	// removed 从父任务 ID 开始；只要槽位的 parentTaskId 在集合里，就把它的 taskId 也加入，从而覆盖任意深度。
	const removed = new Set<TaskId>([taskId]);
	for (const slot of nested) if (removed.has(slot.parentTaskId)) removed.add(slot.taskId);
	// 逆序删除，避免 splice 导致索引移动；只删除父任务在集合里的槽位（父本身不会出现在 nestedTools 里）。
	for (let index = nested.length - 1; index >= 0; index--) {
		if (removed.has(nested[index]!.parentTaskId)) nested.splice(index, 1);
	}
	if (nested.length === 0) delete live.nestedTools;
}

// clearProgress 删除运行期发布字段；结果条目或重跑会重新写入。
/** Remove what a tool published while running; its result entry or a rerun replaces it. */
export function clearProgress(slot: Draft<SlotProgress>): void {
	delete slot.output;
	delete slot.droppedBytes;
	delete slot.droppedLines;
	delete slot.details;
	delete slot.diagnostics;
}

// settleSchedulerOutcome 是调度器写入 faulted/orphaned 终态时的 Harness 清理钩子。
// 工具任务：槽位标记 done（没有 entry），并删除其嵌套槽位；上下文推导会为缺失结果合成错误结果。
// 压缩任务：移除状态并记录失败（被重启上限切断的视为中止，不算失败）。
// 生成任务：把已提交的部分响应转成 aborted 条目，并结束运行；其他任务种类不碰 pi.live。
// 调度器不知道任务种类，由 Harness 通过 options 注入本函数。
/**
 * Harness cleanup for a terminal outcome the scheduler writes itself (`faulted` or `orphaned`). A run task ends its
 * run; a tool task's slot is marked done without an entry, and context derivation synthesizes the missing result; a
 * compaction task's status is removed and its failure recorded.
 * Ignores other kinds so it never creates `pi.live` elsewhere. The scheduler calls this without knowing task kinds;
 * the Harness passes it in (spec §5.4).
 * REMINDER: a committed generation partial becomes an aborted assistant entry here, exactly as in the generation abort
 * handler, so the transcript keeps what the model produced and `pi.usage` counts its spend. The scheduler's commit has
 * no task scope, so that entry has no `byTaskId`. Faults come from task bugs
 * or malformed provider data (a non-JSON value in a response), or a commit the Storage rejected without effect; an
 * uncertain storage failure poisons the Session instead and writes no outcome.
 */
export async function settleSchedulerOutcome(
	tx: Transaction,
	record: TaskRecord<JsonValue, JsonValue, JsonValue>,
	outcome: SchedulerOutcome,
): Promise<void> {
	// 工具任务分支：读取 live，找到槽位并完成；removeNestedSlots 清理该调用发起的所有嵌套槽位。
	if (record.kind === TOOL_TASK_KIND) {
		const live = await tx.doc(LiveDoc, record.conversationId);
		const slot = toolSlot(live, record.id);
		if (slot !== undefined) finishSlot(slot);
		removeNestedSlots(live, record.id);
		return;
	}
	// Only an abort handler is faulted for the limit here (the built-in phases end themselves): the task was aborted,
	// and keeps that meaning. Its run ends `aborted`, with the limit as detail, and an aborted compaction is no failure.
	// detail 只在 faulted 结果里有结构化原因；restart_limit 表示这是“连续切断”导致的 fault，而非普通任务 bug。
	const detail = outcome.status === "faulted" ? outcome.error.detail : undefined;
	// 对象/非空/字段存在检查都是运行时判断，因为 detail 的类型是 JsonValue，可能来自持久化记录。
	const cutOff =
		typeof detail === "object" && detail !== null && "reason" in detail && detail.reason === "restart_limit";
	// 压缩任务分支：cutOff 时只移除状态（视作中止），否则记录失败消息。
	if (record.kind === COMPACTION_TASK_KIND) {
		const live = await tx.doc(LiveDoc, record.conversationId);
		if (cutOff) removeCompactionStatus(live, record.id);
		// 失败消息优先用 error.message；orphaned 没有 error，用 outcome.reason。
		else failCompactionStatus(live, record.id, outcome.status === "faulted" ? outcome.error.message : outcome.reason);
		return;
	}
	// 非生成任务到此为止；不再读取/创建 pi.live，避免在无关任务里产生文档。
	if (!RUN_TASK_KINDS.has(record.kind)) return;
	// 生成任务：只有当前 run 仍属于该任务时才结束；否则说明运行已被接管，不能重复结算。
	const live = await tx.doc(LiveDoc, record.conversationId);
	if (live.run?.taskId !== record.id) return;
	// Cut off, the abort handler may have died converting the partial: the run ends without it.
	// 未达到上限时尝试把已提交的部分响应转换成 aborted 助手条目；达到上限时跳过，因为该转换可能正是切断原因。
	if (!cutOff) await convertPartial(tx, live, record.conversationId);
	// faulted：原因可能是 restart_limit（归为 aborted）或真实任务错误；orphaned：记录调度器给出的原因，并按该原因结算输入。
	endRun(
		tx,
		live,
		record.id,
		outcome.status === "faulted"
			? { status: "unanswered", reason: cutOff ? "aborted" : "faulted", detail: outcome.error.message }
			: {
					status: "unanswered",
					reason: "orphaned",
					detail: outcome.reason,
					settlement: { status: "unanswered", reason: outcome.reason },
				},
	);
}
