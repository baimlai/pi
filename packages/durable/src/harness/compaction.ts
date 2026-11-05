// 所属：packages/durable/src/harness，Durable harness 的内置压缩任务 pi.compaction（触发策略、选区间、摘要与放置）。
// 解决的问题：上下文超过模型窗口或达到阈值时，把旧前缀替换成摘要，同时保证工具调用/结果成对、保留近期上下文、
// 可重试、可被 beforeCompact 钩子取消或覆盖，并且摘要条目写进正确的位置。
// 职责边界：只负责“选区间 → 调模型摘要 → 放置条目”；阈值/溢出触发与阻塞等待由 generation 完成，文档与条目写入走 Tx。
// 上游：generation 的阈值/溢出检测、Conversation.compact() 手动调用、恢复时的阻塞等待。
// 下游：pi.live 的压缩状态、pi.usage 的摘要花费、会话转录里的 pi.compaction 条目（直接追加或作为写入提交在边界放置）。
// 能力清单：
// - CompactionInput：触发原因（manual/threshold/overflow）与可选关注指令；
// - SummaryRequest/CompactionCheckpoint：select 固定下来的区间与 summarize/retry 相位；
// - CompactionTask：内置任务定义，phases 为 select/summarize/retry，abort 负责清理状态；
// - createCompaction：在调用方事务里创建任务并登记状态，返回 TaskId；
// - compactionPolicy：全局策略逐字段被 per-model override 覆盖；
// - selectCut/isCandidate：从尾部累计 token，选安全切割点（不切断工具调用/结果配对）；
// - summarizedMessages：取 cut 之前的消息，工具结果已排序；
// - estimateContext：用最新真实 usage 加后续启发式估算当前上下文 token；
// - serializeConversation/contentText/truncate：把消息转成摘要模型可读的纯文本；
// - 内部辅助：summaryText/summaryFailure/summaryPrompt/place/placeSummary/complete/failCutOff/failNoModel。
// 典型顺序：createCompaction（可带 owner）→ 调度器运行 select → beforeCompact 钩子 → 提交 summarize 检查点 →
//   completeSimple → 成功 placeSummary / 可重试 sleeping retry / 失败记录 CompactionFailure。
// 示例：const task = await createCompaction(tx, conversationId, { reason: "threshold" }, runtime.taskId);
//   第四个参数是等待它的生成任务 ID（省略则表示会话拥有；其中非手动压缩在后台运行）；返回值是压缩任务 ID，本调用只创建任务并登记状态，摘要由调度器稍后运行。
// 关键约束：摘要条目只替换 head 之前的上下文；压缩可以阻塞运行（owner 为生成任务）或在后台运行（会话拥有）。
// 建议阅读顺序：先读 CompactionInput/SummaryRequest/CompactionCheckpoint 与 CompactionTask 的相位签名，再读 select
//   与 selectCut，随后 summarize/retry，最后按需读序列化与放置辅助函数。
import type { Context } from "@earendil-works/chord/context";
import type { Draft } from "@earendil-works/chord/delta";
import type { AssistantMessage, Message, ModelThinkingLevel, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { isRetryableAssistantError, retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import { CompactionEntry } from "../entries.ts";
import { defineTask } from "../tasks.ts";
import type {
	ConversationId,
	EntryDraft,
	EntryId,
	NextTaskState,
	RunningTask,
	TaskId,
	TaskRuntime,
	Tx,
} from "../types.ts";
import { orderToolResults } from "./context.ts";
import {
	addCompactionStatus,
	compactionStatus,
	cutOffCount,
	cutOffTooOften,
	failCompactionStatus,
	LiveDoc,
	type LiveState,
	removeCompactionStatus,
} from "./live.ts";
import { ensureProviderSessionId } from "./provider.ts";
import { admitSubmission } from "./submissions.ts";
import type {
	CompactionHooks,
	CompactionPolicy,
	CompactionReason,
	CompactionResult,
	ContextView,
	ConversationStreamOptions,
	ModelRef,
	Settings,
} from "./types.ts";
import { recordUsage } from "./usage.ts";

// CompactionInput 是压缩任务的输入：触发原因和可选的额外关注指令；它在创建任务时持久化。
export type CompactionInput = { reason: CompactionReason; instructions?: string };

// SummaryRequest 是“摘要请求”的固定参数，select 阶段决定后写入检查点，summarize/retry 阶段复用。
// attempt 从 1 开始；tail 是选择区间时的最新条目；firstKept 是摘要后保留的第一条（摘要条目的 head）。
/** The pinned summarization request. */
export type SummaryRequest = {
	// attempt 用于重试退避；model 是运行时的模型引用，不是模型对象。
	attempt: number;
	model: ModelRef;
	thinkingLevel: ModelThinkingLevel;
	streamOptions: ConversationStreamOptions;
	maxTokens: number;
	/** Newest entry of the context the range was selected from. */
	// tail 固定“读上下文时看到的最新条目”，summarize 用它重建同一区间；firstKept 是摘要条目的 head。
	tail: EntryId;
	/** First entry kept verbatim; the summary's `head`. */
	firstKept: EntryId;
};

// CompactionCheckpoint 是任务的三个相位：select 选择区间；summarize 携带请求；retry 额外记录重试时间。
// 判别字段 phase 让 TypeScript 在 switch/if 中收窄；运行时只依赖这个字符串，不做 schema 校验。
export type CompactionCheckpoint =
	| { phase: "select" }
	| ({ phase: "summarize" } & SummaryRequest)
	| ({ phase: "retry"; until: number } & SummaryRequest);

// Runtime/Next 是给长泛型起别名，避免在每个函数签名里重复；它们只在编译期存在。
type Runtime = TaskRuntime<CompactionInput, CompactionCheckpoint, CompactionResult, CompactionHooks>;
type Next = NextTaskState<CompactionCheckpoint, CompactionResult>;

// 序列化摘要源时每个工具结果最多保留的字符数；超出部分用截断说明代替。
/** Longest tool result text a serialized summary source keeps. */
const TOOL_RESULT_MAX_CHARS = 2000;

// 摘要条目的文本前后缀：模型看到的是“历史已被压缩成以下摘要”的说明，而不是原始消息。
const SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

// 摘要模型的系统提示：只生成结构化摘要，不继续对话；模板字符串内容保持原样，注释不能插进字符串。
const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

// 摘要模型的用户提示：规定输出的章节格式；对话内容在 summaryPrompt() 中包进 <conversation>。
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work. If the conversation starts with an earlier summary, preserve its information and fold the newer messages into it.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

// CompactionTask 是内置任务定义；name/version 决定注册与恢复时的匹配，initial 从 select 相位开始。
// phases 的每个函数都必须通过 runtime.commit() 产生持久进度或终态，否则调度器会把任务判为 faulted。
/**
 * Built-in compaction task (spec §8.7): select an old prefix of the model context, summarize it, and place a summary
 * entry whose `head` is the first kept entry. A compaction the generation owns blocks it and appends directly; a
 * conversation-owned one places its summary through a write submission.
 */
export const CompactionTask = defineTask<CompactionInput, CompactionCheckpoint, CompactionResult, CompactionHooks>({
	name: "pi.compaction",
	version: 1,
	initial: () => ({ phase: "select" }),
	phases: {
		// select 相位：解析模型与策略，读当前上下文，选择可压缩区间，询问 beforeCompact 钩子，然后提交 summarize 检查点。
		select: async (task, runtime, context) => {
			// 被重启切断太多次时直接结束；这是内置任务自己的重启上限处理，调度器不会再故障化它。
			if (cutOffTooOften(task, runtime)) return failCutOff(runtime, task, context);
			const { conversationId } = runtime;
			// runtime.agent() 在相位内最多解析一次；模型、思考级别和工具选择在本次压缩中固定。
			const agent = await runtime.agent(context);
			const settings = runtime.settings;
			const ref = agent.model;
			// getModel 返回 undefined 表示模型不可用；ref 也存在但模型缺失同样走 no_model 失败。
			const model = ref === undefined ? undefined : runtime.models.getModel(ref.provider, ref.modelId);
			if (ref === undefined || model === undefined) return failNoModel(runtime, ref, context);
			// 压缩策略可能被 per-model override 覆盖；reserveTokens/keepRecentTokens 决定阈值与保留量。
			const policy = compactionPolicy(settings, ref);
			// 读取当前活动上下文；压缩只处理已经提交的条目。
			const view = await runtime.context(conversationId, context);
			// selectCut 返回“第一条保留条目的下标”，undefined 表示没有可压缩内容（空上下文或保留量已覆盖全部）。
			const cut = selectCut(view, policy.keepRecentTokens);
			// 没有可压缩内容：清除状态并以空结果完成，不调用模型。
			if (cut === undefined) return complete(runtime, context);
			// 非空断言：cut 由上一行排除 undefined；view.entries[cut] 是第一条保留条目。
			const firstKept = view.entries[cut]!.id;
			// 输入来自任务记录；reason 是 manual/threshold/overflow，instructions 是可选关注点。
			const { reason, instructions } = task.input;
			// compaction 对象同时给钩子与摘要序列化使用。
			const compaction = {
				reason,
				// entries 是要被摘要替换的旧条目（前 cut 条）。
				entries: view.entries.slice(0, cut),
				// messages 是这些条目的模型消息，已经按工具结果顺序整理。
				messages: summarizedMessages(view, cut),
				// firstKept 是第一条保留条目，最终写入摘要条目的 head。
				firstKept,
				...(instructions === undefined ? {} : { instructions }),
			};
			// decision 的三态：undefined 表示没有钩子决定；decline 表示取消压缩；summary 表示钩子直接给出摘要。
			let decision: { readonly decline: true } | { readonly summary: string } | undefined;
			// hooks.each 按扩展顺序调用；只有第一个非 undefined 的决定生效（decision === undefined 守卫）。
			await runtime.hooks.each("beforeCompact", async (hook) => {
				if (decision === undefined) decision = await hook(compaction, runtime, context);
			});
			// "decline" in decision 是判别联合收窄：有 decline 字段的分支表示钩子拒绝压缩。
			if (decision !== undefined && "decline" in decision) return complete(runtime, context);
			// 钩子提供摘要时跳过模型调用，直接进入放置阶段；仍会在同一提交里结束任务。
			if (decision !== undefined) return place(runtime, firstKept, decision.summary, context);
			// request 写入检查点，后续 summarize 相位根据它重建请求；attempt 固定为 1。
			const request: SummaryRequest = {
				attempt: 1,
				model: ref,
				thinkingLevel: agent.thinkingLevel,
				streamOptions: settings.stream,
				// maxTokens 取“预留 token 的 80%（向下取整）”和“模型最大输出”的较小值；模型最大输出 <= 0 时用 Infinity 表示不设上限。
				maxTokens: Math.min(
					Math.floor(0.8 * policy.reserveTokens),
					model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
				),
				// tail 是整个上下文视图里最新的条目 ID；entries 按 ID 升序，reduce 从 firstKept 开始也能得到末尾最大值。
				tail: view.entries.reduce((tail, entry) => (entry.id > tail ? entry.id : tail), firstKept),
				firstKept,
			};
			// 提交 running + summarize 检查点；下一次调度会从 summarize 继续，而不是重新选择区间。
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "summarize", ...request } }), context);
		},
		// summarize 相位：用保存的请求构造系统/用户消息，调用 completeSimple()，再分类结果（成功、可重试、失败）。
		summarize: async (task, runtime, context) => {
			// 再次检查重启上限；如果“计费这次尝试”本身不断被切断，最终也会走到这里。
			if (cutOffTooOften(task, runtime)) return failCutOff(runtime, task, context);
			// 解构 checkpoint 并丢弃 phase 字段；剩余字段就是 SummaryRequest。
			const { phase: _, ...request } = task.state.checkpoint;
			const { model: ref, thinkingLevel, streamOptions, maxTokens, tail, firstKept, attempt } = request;
			// 重新解析模型；模型目录可能在运行期间变化，恢复时可能已不可用。
			const model = runtime.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) return failNoModel(runtime, ref, context);
			// 关键不变量：tail 处的上下文不可变，所以现在读到的区间就是 select 当时选择的区间。
			// The context at `tail` is immutable, so this is the range `select` chose.
			// at: tail 让上下文读取截止到固定条目，避免 summarize 看到 select 之后的新条目。
			const view = await runtime.context(runtime.conversationId, context, { at: tail });
			// findIndex 找 firstKept 在当前范围中的位置；它应当存在，因为 firstKept 就在 tail 之内。
			const cut = view.entries.findIndex((entry) => entry.id === firstKept);
			// now 用作两条消息的时间戳；它来自 Harness 时钟，不是 Date.now()。
			const now = runtime.now();
			// 系统提示 + 用户消息：用户消息内容是序列化对话、摘要提示和可选关注点。
			const messages: Message[] = [
				{ role: "system", content: SUMMARIZATION_SYSTEM_PROMPT, timestamp: now },
				{
					role: "user",
					content: [{ type: "text", text: summaryPrompt(summarizedMessages(view, cut), task.input.instructions) }],
					timestamp: now,
				},
			];
			// deferred 选项对摘要请求无意义（摘要需要完整响应），因此从转发选项中排除，其余 stream 选项保留。
			const { deferred: _deferred, ...forwarded } = streamOptions;
			// cacheRetention: "none" 避免为一次性摘要请求建立缓存；signal/telemetry 透传取消与观测。
			const options: SimpleStreamOptions = {
				...forwarded,
				cacheRetention: "none",
				maxTokens,
				signal: runtime.signal,
				telemetry: context.telemetry,
				// sessionId 使用会话的持久 provider 身份；thinkingLevel 为 "off" 时不传 reasoning 字段。
				sessionId: await ensureProviderSessionId(runtime, context),
				...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
			};
			// completeSimple 是非流式的完整响应；它内部仍可能产生流事件，但这里只关心终态消息。
			const message = await runtime.models.completeSimple(model, { messages }, options);
			// 如果任务在等待响应时被取消/关闭，signal 已中止；此时不处理消息，交给 abort 处理器或恢复流程。
			// An abort mark or close: the abort invocation or the reopened task handles the committed state.
			// throwIfAborted 会抛出 signal 的原因；这是运行时检查，不是 TS 类型保证。
			runtime.signal.throwIfAborted();
			// 只有“正常 stop、无工具调用、且有文本”的响应才算摘要；其他情况返回 undefined。
			const summary = summaryText(message);
			// 重试策略在分类时读取，而不是在 prepare 时固定；设置改变会影响下一次尝试。
			const policy = runtime.settings.retry;
			// 可重试条件：stopReason 为 error、错误被 pi-ai 判定为可重试、策略启用且尝试次数未超限。
			const retry =
				message.stopReason === "error" &&
				isRetryableAssistantError(message) &&
				policy.enabled &&
				attempt <= policy.maxRetries;
			// 退避时间由 retryDelayMs(policy, attempt) 计算；不可重试时 until=0（不会被使用）。
			const until = retry ? runtime.now() + retryDelayMs(policy, attempt) : 0;
			// 在同一个提交里记录用量、更新实时状态并决定任务下一步；异步回调允许 prepareFailure 之类的表读。
			await runtime.commit(async (tx, current): Promise<Next> => {
				// 摘要花费记入 models 桶，键为 provider/modelId；message.usage 可能含可选计数。
				await recordUsage(
					tx,
					runtime.conversationId,
					"models",
					`${message.provider}/${message.model}`,
					message.usage,
				);
				// 读取 pi.live 草稿，用于移除压缩状态或写失败信息。
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				// 成功摘要：写入摘要条目并完成任务；placeSummary 会决定直接追加还是走写入提交。
				if (summary !== undefined) return placeSummary(tx, runtime, current, live, firstKept, summary);
				// 可重试错误：保留状态并写 retry 时间，任务进入 sleeping，直到 until 后再试。
				if (retry) {
					const status = compactionStatus(live, runtime.taskId);
					// status 可能已被其他提交移除（例如任务被取消）；存在时才写 retry 字段。
					if (status !== undefined) status.retry = { at: until, error: message.errorMessage ?? "" };
					// as const 让 phase 保持字面量 "retry"，匹配 CompactionCheckpoint 联合。
					const checkpoint = { phase: "retry", ...request, until } as const;
					// sleeping 状态让调度器在 until 前不调用任务；until 是 Harness 时钟毫秒。
					return { status: "sleeping", checkpoint, until };
				}
				// 不可重试：生成失败文本，记录 compactionFailure，并以 failed 终态结束。
				const text = summaryFailure(message);
				// failCompactionStatus 会把状态转成 compactionFailure 并移除状态。
				failCompactionStatus(live, runtime.taskId, text);
				return {
					status: "terminal",
					// detail.reason 固定为 model_error；message 是给客户端看的简短原因。
					outcome: { status: "failed", error: { message: text, detail: { reason: "model_error" } } },
				};
			}, context);
		},
		// retry 相位：退避结束后的入口。如果还没到 until（提前唤醒或旧版本记录），继续睡。
		/** After the backoff's sleep; a run before `until` (an early wake, or a record of an earlier version) sleeps again. */
		retry: async (task, runtime, context) => {
			// 解构出 until 和请求字段；phase 丢弃。
			const { phase: _, until, ...request } = task.state.checkpoint;
			// 再次检查重启上限；被切断次数过多时不再重试。
			if (cutOffTooOften(task, runtime)) return failCutOff(runtime, task, context);
			// until 未到：把当前检查点原样交回调度器并睡到 until；这处理时钟回拨/提前唤醒。
			if (until > runtime.now()) return runtime.sleepUntil(until, task.state.checkpoint, context);
			// attempt 只在真正开始下一次尝试时递增；sleep 本身不算尝试。
			const attempt = request.attempt + 1;
			// 提交新的 summarize 检查点并清除 retry 状态；attempt 加一。
			await runtime.commit(async (tx) => {
				// 读取实时状态；任务可能已经被取消，status 可能是 undefined。
				const status = compactionStatus(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
				if (status !== undefined) {
					// 只有状态还在时才更新显示字段；delete 移除退避信息。
					status.attempt = attempt;
					delete status.retry;
				}
				// 回到 summarize 相位，携带原请求和新 attempt。
				return { status: "running", checkpoint: { phase: "summarize", ...request, attempt } };
			}, context);
		},
	},
	// abort 相位：任务被取消时清理状态；已经提交的部分响应由 generation 的 abort 或调度器处理，这里不转换。
	abort: async (_task, runtime, context) => {
		// 提交终态 aborted；removeCompactionStatus 同时删除列表中的状态。
		await runtime.commit(async (tx) => {
			removeCompactionStatus(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});

// createCompaction 在调用方的事务里创建压缩任务并登记状态；owner 是等待它的生成任务（阻塞压缩），缺省为会话拥有（非手动时后台运行）。
// 返回 TaskId<CompactionResult>；创建本身不执行摘要，调度器稍后运行任务。
/**
 * Create a compaction task with its status in this commit. `owner` is the generation that waits for it (a blocking
 * compaction); without one it is conversation-owned, and `background` unless it is manual.
 */
// ownership 是判别联合：task 表示阻塞压缩（父任务等待），conversation 表示会话拥有的后台任务。
export async function createCompaction(
	tx: Tx,
	conversationId: ConversationId,
	input: CompactionInput,
	owner?: TaskId,
): Promise<TaskId<CompactionResult>> {
	// background 只有“会话拥有且非手动”的压缩才为 true；手动压缩在空闲时立即放置摘要，忙时排队。
	const ownership =
		owner === undefined ? ({ kind: "conversation" } as const) : { kind: "task" as const, taskId: owner };
	const background = owner === undefined && input.reason !== "manual";
	// createTask 使用任务的初始检查点（select）；conversationId 决定任务归属与文档作用域。
	const taskId = await tx.createTask(CompactionTask, input, { ownership, conversationId, background });
	// 状态记录触发原因、是否阻塞和第一次尝试；addCompactionStatus 按任务 ID 追加。
	const status = { taskId, trigger: input.reason, blocking: owner !== undefined, attempt: 1 };
	addCompactionStatus(await tx.doc(LiveDoc, conversationId), status);
	return taskId;
}

// compactionPolicy 解析某模型的压缩策略：全局策略逐字段被 modelOverrides["provider/modelId"] 覆盖。
// 返回值总是完整 CompactionPolicy；覆盖对象可以只给部分字段。
/** The compaction policy for `model`: its `modelOverrides` entry over the harness-wide policy, field by field. */
export function compactionPolicy(settings: Settings, model: ModelRef): CompactionPolicy {
	// 解构出 modelOverrides，其余字段组成全局策略；...policy 是编译期对象类型。
	const { modelOverrides, ...policy } = settings.compaction;
	// 键必须是精确的 "provider/modelId" 字符串；找不到覆盖时 override 为 undefined。
	const override = modelOverrides?.[`${model.provider}/${model.modelId}`];
	// 每个字段用 ?? 回退到全局值；false/0 是有效覆盖值，不会被 ?? 当成缺省。
	return {
		enabled: override?.enabled ?? policy.enabled,
		reserveTokens: override?.reserveTokens ?? policy.reserveTokens,
		keepRecentTokens: override?.keepRecentTokens ?? policy.keepRecentTokens,
		backgroundTokens: override?.backgroundTokens ?? policy.backgroundTokens,
	};
}

// selectCut 选择“摘要替换到哪里”：返回 view.entries 中第一条保留条目的下标，undefined 表示没有可压缩内容。
// 算法从尾部向前累计 token，直到保留量达到 keepRecentTokens，再切割到该位置之后第一个安全候选（用户/助手消息开头）。
// 不能切在工具结果之前，也不能切在“后续还有该助手调用结果”的用户条目之前，否则 provider 会收到孤立的 toolResult。
/**
 * Index in `view.entries` of the first entry a summary keeps, or `undefined` when there is nothing to compact
 * (spec §8.7). Walks back from the tail until `keepRecentTokens` are kept, then cuts at the first candidate at or after
 * that entry: an entry whose contribution starts with a user or assistant message, never a tool result, and never a
 * user entry that a result of the preceding assistant's calls still follows.
 */
export function selectCut(view: ContextView, keepRecentTokens: number): number | undefined {
	// contributions 与 entries 一一对应；每个元素是该条目的模型消息数组。
	const { contributions } = view;
	// 有 head 标记时下标 0 是标记本身，不能作为切割点；从 1 开始。
	const start = view.head === undefined ? 0 : 1;
	// candidates 记录所有可以安全切割的下标；后面在满足保留量后从中选择。
	const candidates: number[] = [];
	// 线性扫描所有条目判断候选；候选判断本身可能向后扫描找调用结果，但条目数量有限。
	for (let index = start; index < contributions.length; index++) {
		if (isCandidate(contributions, index)) candidates.push(index);
	}
	// kept 从 0 开始累计；cut 初始 undefined，表示还没找到满足保留量的位置。
	let kept = 0;
	let cut: number | undefined;
	// 从尾部向前遍历；index >= start 保证不越过 head 标记。
	for (let index = contributions.length - 1; index >= start; index--) {
		// 每个条目贡献多条消息，逐条累加估计 token；estimateMessageTokens 是启发式估算，不等于真实计费。
		for (const message of contributions[index]!) kept += estimateMessageTokens(message);
		// 保留量还不够：继续向前扩大摘要范围。
		if (kept < keepRecentTokens) continue;
		// 找到满足保留量的位置：取“该位置或之后的第一个候选”，若没有则取最后一个候选。
		cut = candidates.find((candidate) => candidate >= index) ?? candidates.at(-1);
		break;
	}
	// 没有任何候选（例如全是工具结果或空范围）：不压缩。
	if (cut === undefined) return undefined;
	// 还要确保切点之前确实有条目：如果 [start, cut) 全是空贡献，则没有可压缩内容。
	for (let index = start; index < cut; index++) if (contributions[index]!.length > 0) return cut;
	return undefined;
}

// isCandidate 判断某个条目能否作为摘要边界：条目贡献的第一条消息必须是助手消息或用户消息。
function isCandidate(contributions: ContextView["contributions"], index: number): boolean {
	// first 是该条目的第一条贡献消息；空贡献返回 undefined，随后 role 检查失败。
	const first = contributions[index]![0];
	// 助手消息开头总是安全：它不依赖前面的工具结果。
	if (first?.role === "assistant") return true;
	// 非用户开头不安全；工具结果必须紧跟其调用。
	if (first?.role !== "user") return false;
	// A result of the preceding assistant's calls that follows this entry, before the next assistant, belongs before it.
	// 向前找最近的助手消息，收集它的工具调用 ID；用户条目若在这些调用结果之前，则不能切。
	let calls: ReadonlySet<string> = new Set();
	for (let before = index - 1; before >= 0; before--) {
		// findLast 从前往后找最近的助手消息；没有助手时继续向前。
		const assistant = contributions[before]!.findLast((message) => message.role === "assistant");
		if (assistant === undefined) continue;
		// flatMap 只保留 toolCall 内容并提取 id；new Set 提供 O(1) 查找。
		calls = new Set(assistant.content.flatMap((content) => (content.type === "toolCall" ? [content.id] : [])));
		break;
	}
	// 没有待匹配的调用：用户条目安全。
	if (calls.size === 0) return true;
	// 向后扫描，直到遇到下一条助手消息。
	for (let after = index; after < contributions.length; after++) {
		for (const [position, message] of contributions[after]!.entries()) {
			// 在用户条目之后又出现助手消息（或后续条目）：说明调用结果不会跨到这里，安全。
			if (message.role === "assistant" && (after > index || position > 0)) return true;
			// 遇到属于前面调用的工具结果：该结果必须在用户条目之前，所以此处不能切。
			if (message.role === "toolResult" && calls.has(message.toolCallId)) return false;
		}
	}
	// 扫描到末尾仍未遇到匹配结果：用户条目安全。
	return true;
}

// summarizedMessages 返回 cut 之前条目的模型消息，按 provider 期望的顺序排列（工具结果紧跟调用）。
/** Model messages of the entries before `cut`: the head marker first, ordered like model context (spec §2.1). */
export function summarizedMessages(view: ContextView, cut: number): Message[] {
	return orderToolResults(view.contributions.slice(0, cut).flat());
}

// estimateContext 估算“当前上下文 + 额外消息”的 token 数，用于阈值压缩判断。
// 优先使用 head 标记之后最近的、带真实 usage 的助手消息（它的请求包含标记）；之后的消息用启发式估算。
// 没有可用 usage 时，估算所有消息；例：estimateContext(view, []) 返回当前请求的近似 token。
/**
 * Size of a request over `view` followed by `extra` (spec §8.3): the usage of the newest assistant appended after the
 * head marker, whose request included the marker, plus estimates of the messages after it; without one, estimates of
 * every message.
 */
export function estimateContext(view: ContextView, extra: readonly Message[]): number {
	// measured 是找到的带真实 usage 的助手消息；undefined 表示还没找到。
	let measured: AssistantMessage | undefined;
	// after 是 head 标记的 ID；没有 head 用 -Infinity，让所有条目都 >= after。
	const after = view.head?.id ?? Number.NEGATIVE_INFINITY;
	// 从最新条目向前找；找到 measured 后循环条件失效。
	for (let index = view.entries.length - 1; index >= 0 && measured === undefined; index--) {
		// 跳过 head 标记及更早条目：它们不在当前上下文里。
		if (view.entries[index]!.id <= after) continue;
		// findLast 的谓词带类型守卫：只接受 assistant 且 usage 的上下文 token > 0；calculateContextTokens 处理可选计数。
		measured = view.contributions[index]!.findLast(
			(message): message is AssistantMessage =>
				message.role === "assistant" && calculateContextTokens(message.usage) > 0,
		);
	}
	// from 是 measured 在 view.messages 中的下一条下标；找不到（-1）时从 0 开始。
	const from = measured === undefined ? 0 : view.messages.lastIndexOf(measured) + 1;
	// 先取 measured 的真实 token；没有 measured 则 0。
	let tokens = measured === undefined ? 0 : calculateContextTokens(measured.usage);
	// 后续消息逐条估算；view.messages 已经过排序与编辑处理。
	for (const message of view.messages.slice(from)) tokens += estimateMessageTokens(message);
	// 额外消息（例如准备追加的系统提示）也要计入。
	for (const message of extra) tokens += estimateMessageTokens(message);
	return tokens;
}

// summaryText 从终态消息提取摘要文本：必须 stop、无工具调用，且拼接后的文本非空。
/** The summary of a clean `stop` with text and no tool call; anything else is not a summary. */
function summaryText(message: AssistantMessage): string | undefined {
	// stopReason !== "stop" 或存在 toolCall 时不是摘要；some 只做语义分类，判断响应里有没有工具调用。
	if (message.stopReason !== "stop" || message.content.some((content) => content.type === "toolCall"))
		return undefined;
	// flatMap 只保留 text 内容；join("\n") 保留段落分隔，trim 去掉首尾空白。
	const text = message.content
		.flatMap((content) => (content.type === "text" ? [content.text] : []))
		.join("\n")
		.trim();
	return text.length === 0 ? undefined : text;
}

// summaryFailure 生成失败说明：区分模型错误/中止、长度上限、尝试调用工具和无文本。
function summaryFailure(message: AssistantMessage): string {
	// error 和 aborted 优先用 provider 的错误消息；缺省用 stopReason。
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		return `Summarization failed: ${message.errorMessage ?? message.stopReason}`;
	}
	// length 表示输出被截断，摘要不完整。
	if (message.stopReason === "length") return "Summarization hit the token limit; the summary is incomplete";
	// 有工具调用时说明模型误解了任务。
	if (message.content.some((content) => content.type === "toolCall")) return "Summarization attempted to call a tool";
	// 其他情况（例如 stop 但无文本）说明没有可用文本。
	return "Summarization produced no text";
}

// summaryPrompt 构造摘要模型的用户消息：<conversation> 包裹序列化对话，后面是固定提示与可选关注点。
/** The summarizer's user message: the serialized conversation, the prompt, and any instructions. */
// focus 为空字符串时不添加额外段落；instructions 来自任务输入。
function summaryPrompt(messages: readonly Message[], instructions: string | undefined): string {
	const focus = instructions === undefined ? "" : `\n\nAdditional focus: ${instructions}`;
	// 模板字符串只在这里拼接；对话文本已由 serializeConversation 转义为纯文本。
	return `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n${SUMMARIZATION_PROMPT}${focus}`;
}

// serializeConversation 把消息转成纯文本，让摘要模型“阅读记录”而不是继续对话；系统消息被省略，思考内容也被省略。
// 省略 thinking 的原因：provider 返回的是真实推理的摘要，重放的 thinking 往往不属于当前上下文，包含它可能让请求比被摘要的上下文还大。
// 可见文本、工具调用和工具结果足以记录发生了什么。
/**
 * Messages as plain text, so the summarizer reads a transcript instead of continuing it. System messages are omitted.
 * Thinking is omitted too: providers return summaries of the real reasoning, and replayed thinking is often not part of
 * the live context (a block that does not match its request is dropped), so including it can make the request larger
 * than the context it summarizes. Visible text, tool calls, and tool results record what happened.
 */
// parts 收集各段文本，最后用空行连接。
export function serializeConversation(messages: readonly Message[]): string {
	const parts: string[] = [];
	// 遍历消息；未知角色（系统/自定义）直接跳过。
	for (const message of messages) {
		// 用户消息可能是字符串或多块内容，contentText 统一提取文本块。
		if (message.role === "user") {
			const text = contentText(message.content);
			if (text.length > 0) parts.push(`[User]: ${text}`);
			// 助手消息：文本块与工具调用分开输出；arguments 用 JSON.stringify 每个值。
		} else if (message.role === "assistant") {
			// flatMap 只保留 text 内容；join("\n") 保留段落。
			const text = message.content.flatMap((content) => (content.type === "text" ? [content.text] : []));
			// 工具调用格式化为 name(key=value, ...)；Object.entries 遍历参数键，JSON.stringify 保留类型信息。
			const calls = message.content.flatMap((content) =>
				content.type === "toolCall"
					? [
							`${content.name}(${Object.entries(content.arguments)
								.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
								.join(", ")})`,
						]
					: [],
			);
			// 文本和调用分开成两段，避免把调用混进自然语言。
			if (text.length > 0) parts.push(`[Assistant]: ${text.join("\n")}`);
			if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
			// 工具结果：提取文本并截断到 TOOL_RESULT_MAX_CHARS，防止单个大结果占满摘要请求。
		} else if (message.role === "toolResult") {
			const text = contentText(message.content);
			if (text.length > 0) parts.push(`[Tool result]: ${truncate(text, TOOL_RESULT_MAX_CHARS)}`);
		}
	}
	return parts.join("\n\n");
}

// contentText 处理两种消息内容形状：字符串，或带 type/text 的内容块数组；只取文本块，忽略图片等。
function contentText(content: string | readonly { readonly type: string; readonly text?: string }[]): string {
	// typeof content === "string" 是运行时判别，因为联合类型可能来自持久化消息。
	if (typeof content === "string") return content;
	return (
		content
			// flatMap 过滤类型并提取 text；block.text !== undefined 排除没有文本的块。
			.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
			.join("\n")
	);
}

// truncate 在超长时保留前 maxChars 个字符，并追加被截断的字符数；长度按 UTF-16 code unit 计算，不按字素。
function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

// place 在独立提交里放置钩子提供的摘要；它读取 pi.live 草稿并复用 placeSummary。
/** Place a summary supplied by a hook in its own commit. */
// commit 回调返回 placeSummary 的 Next 状态，因此任务在同一事务里结束。
async function place(runtime: Runtime, firstKept: EntryId, summary: string, context: Context): Promise<void> {
	await runtime.commit(
		async (tx, current) =>
			placeSummary(tx, runtime, current, await tx.doc(LiveDoc, runtime.conversationId), firstKept, summary),
		context,
	);
}

// placeSummary 放置摘要条目并完成压缩：阻塞压缩直接 appendEntry，会话拥有的压缩通过写入提交在边界放置。
// 摘要条目的 head 是 firstKept，data.reason 记录触发原因；两种方式都先移除压缩状态并清除失败记录。
/**
 * Place the summary entry and complete (spec §8.7). A blocking compaction, owned by its generation, appends it: the
 * generation holds the run and waits. A conversation-owned one admits it as a write submission, placed at once when
 * idle, otherwise at the next boundary, or settled `stale`.
 * REMINDER: nothing else may append to a busy conversation, so every non-blocking summary goes through admission.
 */
async function placeSummary(
	tx: Tx,
	runtime: Runtime,
	current: RunningTask<CompactionInput, CompactionCheckpoint, CompactionResult>,
	live: Draft<LiveState>,
	firstKept: EntryId,
	summary: string,
): Promise<Next> {
	// 先移除状态并清掉上一次失败；摘要成功意味着失败不再需要展示。
	removeCompactionStatus(live, runtime.taskId);
	delete live.compactionFailure;
	// 摘要文本加上前后缀；模型看到的是说明性包裹，不是原始历史。
	const text = `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}`;
	// 条目草稿：kind 来自 CompactionEntry；head 指向 firstKept；model 是一条用户消息；data 记录原因。
	// satisfies EntryDraft 是编译期检查：形状必须匹配 EntryDraft，但不会改变运行时对象。
	const entry = {
		kind: CompactionEntry.kind,
		head: firstKept,
		model: [{ role: "user", content: [{ type: "text", text }], timestamp: runtime.now() }],
		data: { reason: current.input.reason },
	} satisfies EntryDraft;
	// 阻塞压缩（owner 存在）直接追加条目；否则作为 write submission 准入，在边界放置。
	const result: CompactionResult =
		current.owner === undefined
			? // 条件表达式返回两种结果形状：submissionId 或 entryId；两者都在 CompactionResult 中可选。
				{
					submissionId: (
						await admitSubmission(
							tx,
							// admitSubmission 在事务内完成准入；requestId 以 compaction:任务ID 去重，重复提交不会写两次。
							runtime.conversationId,
							{ type: "write", requestId: `compaction:${runtime.taskId}`, entry },
							runtime.now(),
							runtime.settings,
						)
					).id,
				}
			: // tx.appendEntry 立即追加并返回带 ID 的条目；阻塞压缩持有运行，因此这里不会与忙会话规则冲突。
				{ entryId: (await tx.appendEntry(runtime.conversationId, entry)).id };
	return { status: "terminal", outcome: { status: "completed", result } };
}

// complete 清除状态并以空结果完成任务：没有摘要时 CompactionResult 的两个字段都缺省。
/** Remove the status and complete without a summary. */
async function complete(runtime: Runtime, context: Context): Promise<void> {
	await runtime.commit(async (tx) => {
		removeCompactionStatus(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
		return { status: "terminal", outcome: { status: "completed", result: {} } };
	}, context);
}

// failCutOff 处理“连续被重启切断”的压缩：记录失败并让任务终态失败，而不是再次运行。
/** Fail a compaction cut off `settings.restartLimit` times in a row (spec §5.4) instead of running it again. */
async function failCutOff(runtime: Runtime, task: { readonly restarts?: number }, context: Context): Promise<void> {
	// cutOffCount 生成 "once"/"N times in a row" 文案；任务记录里的 restarts 由调度器维护。
	const message = `Compaction was interrupted ${cutOffCount(task)}`;
	await runtime.commit(async (tx) => {
		failCompactionStatus(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId, message);
		return {
			status: "terminal",
			outcome: { status: "failed", error: { message, detail: { reason: "restart_limit" } } },
		};
	}, context);
}

// failNoModel 处理模型缺失或未配置：记录 failure 状态并以 no_model 终态失败。
async function failNoModel(runtime: Runtime, ref: ModelRef | undefined, context: Context): Promise<void> {
	const message =
		// 两种消息区分“没有选择模型”和“选择的模型在目录中不存在”。
		ref === undefined ? "No model is configured" : `Model ${ref.provider}/${ref.modelId} is not available`;
	await runtime.commit(async (tx) => {
		failCompactionStatus(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId, message);
		return { status: "terminal", outcome: { status: "failed", error: { message, detail: { reason: "no_model" } } } };
	}, context);
}
