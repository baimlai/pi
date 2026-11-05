// 所属：packages/durable/src/harness，Durable harness 的生成任务 pi.generation 与运行控制核心。
// 解决的问题：一次“运行”跨越多个可持久化相位（准备提示词、请求模型、重试/轮询、执行工具轮、afterRun、结束），
// 每个相位都可能在提交之间崩溃或被取消；本文件把这些相位写成任务检查点，使恢复从最后一个已提交相位继续。
// 职责边界：编排请求与运行状态；模型调用交给 Models（pi-ai），工具执行交给 ToolTask，压缩交给 CompactionTask，
// 队列落位交给 inbox.ts，展示状态交给 live.ts。本文件不直接实现 provider、工具或文档存储。
// 上游：Conversation.create/prompt/continue/abort、工具轮完成、调度器恢复与关闭。下游：provider 请求、工具任务、
// 压缩任务、pi.live/pi.usage/会话条目，最终以 TaskOutcome 结束，并把运行交给下一个生成任务或结算输入。
// 能力清单：
// - GenerationInput/GenerationCheckpoint/GenerationResult：输入（空）、七个相位的检查点、结果（回答条目 ID）；
// - GenerationTask：内置任务定义（prepare/request/retry/poll/tools/finish/drain 以及 abort）；
// - convertPartial：把已提交的部分响应转成 aborted 助手条目；
// - startRun/handOver：为已放置输入启动运行、把运行控制权交给后继生成任务；
// - 内部辅助：阈值/溢出压缩、失败与中断处理、流式节流提交、响应分类、工具轮与 afterRun 任务校验。
// 典型相位顺序：prepare → request →（retry 或 poll）→ tools → finish → drain；回答后可在 final/postTools 边界交棒。
// 示例：const task = await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId });
//   创建后由调度器运行；示例不含提示词内容或模型调用，实际输入由 pi.live.run 记录。
// 建议阅读顺序：先读 GenerationCheckpoint 七个分支，再读 GenerationTask.phases（prepare/request/classify 为主），
//   随后读 answer/finishToolRound 的运行交接，最后按需读失败、中断与流式节流辅助函数。
import type { Context } from "@earendil-works/chord/context";
import type { Draft } from "@earendil-works/chord/delta";
import { copyJson, type JsonValue } from "@earendil-works/chord/json";
import type {
	Api,
	AssistantMessage,
	DeferredHandle,
	Message,
	Model,
	ModelThinkingLevel,
	SimpleStreamOptions,
	ToolCall,
} from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError, retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { AssistantEntry, ResetEntry, SystemEntry, UserEntry } from "../entries.ts";
import type { ExecutionEnv } from "../env/index.ts";
import type { TaskCreationOptions } from "../session/transaction.ts";
import { defineTask } from "../tasks.ts";
import type {
	ConversationId,
	EntryId,
	NextTaskState,
	SubmissionId,
	Task,
	TaskId,
	TaskOutcome,
	TaskRuntime,
	Tx,
	TypedEntry,
} from "../types.ts";
import { addTools, agentHooks, sectionExtension } from "./agent.ts";
import { compactionPolicy, createCompaction, estimateContext, selectCut } from "./compaction.ts";
import { applyBoundary, type Boundary, hasQueuedReset, prepareBoundary, withdrawQueuedInputs } from "./inbox.ts";
import {
	cutOffCount,
	cutOffTooOften,
	endRun,
	LiveDoc,
	type LiveState,
	PROGRESS_COMMIT,
	type RunEnd,
	salvageable,
	type ToolSlot,
} from "./live.ts";
import { PartialChanges, type PartialMessage } from "./partial-changes.ts";
import { planSystemEntries, renderSections, replaySections } from "./prompt.ts";
import { ensureProviderSessionId } from "./provider.ts";
import { endedByCrashes } from "./scheduler.ts";
import { appendToolResult, harnessError, ToolTask, type ToolTaskResult } from "./tool.ts";
import type {
	AfterFailedRun,
	CompactionPolicy,
	CompactionResult,
	ContextView,
	ConversationStreamOptions,
	GenerationHooks,
	ModelRef,
	PromptInput,
	RunEndTask,
	RunSummary,
	ToolControl,
	UserInput,
} from "./types.ts";
import { recordUsage } from "./usage.ts";
import { optionalExtension } from "./util.ts";

// GenerationInput 为空记录类型 Record<string, never>：该任务没有输入字段，运行时对象是 {}。
export type GenerationInput = Record<string, never>;

// GenerationCheckpoint 是判别联合：phase 字段决定恢复时执行哪个函数，并决定哪些字段存在。
// TypeScript 在 if/switch 中按 phase 收窄；运行时只按字符串分派，不校验字段完整性（旧版本检查点由 migrate 兼容）。
export type GenerationCheckpoint =
	| {
			phase: "prepare";
			attempt: number;
			// compacted 记录当前运行等待过的阻塞压缩；有它时不再启动第二个压缩，prepare 恢复时检查其结果。
			/** The blocking compaction this generation waited for; it starts no other compaction (spec §8.3). */
			compacted?: TaskId<CompactionResult>;
			// overflow 只在“溢出触发的阻塞压缩”上记录；prepare 恢复时据此把压缩失败转成 model_error。
			/** Error text of the overflow that started `compacted`; checked once when `prepare` resumes. */
			overflow?: string;
			// threshold 标记“阈值触发的阻塞压缩”；阈值压缩失败意味着上下文仍过大，prepare 不再发请求。
			/** Set when the blocking threshold started `compacted`; its outcome is checked once when `prepare` resumes. */
			threshold?: true;
	  }
	// request 相位：模型、思考级别、请求选项和截止条目已经固定；恢复时按相同参数重发。
	| {
			phase: "request";
			attempt: number;
			compacted?: TaskId<CompactionResult>;
			model: ModelRef;
			thinkingLevel: ModelThinkingLevel;
			// streamOptions 在准备提交时固定，恢复后重发仍使用同一组选项，避免设置变化导致请求语义漂移。
			/** The settings' request options when preparation committed; a resend after recovery uses them unchanged. */
			streamOptions: ConversationStreamOptions;
			// cutoff 是请求包含的最新条目；后续读取上下文时用它复现同一请求范围。
			/** Newest entry included in the request. */
			cutoff: EntryId;
	  }
	// retry 相位：等待退避时间；可选 poll 表示“主机在轮询延迟响应时死亡”，恢复后应再次轮询而不是重新请求。
	| {
			phase: "retry";
			attempt: number;
			compacted?: TaskId<CompactionResult>;
			until: number;
			// poll 只保存重新轮询所需的最小信息，避免丢弃 provider 已经完成的任务或重复计费。
			/**
			 * The deferred response a poll was fetching when the host died: the next attempt polls it again instead of
			 * sending another request, so the provider's job is neither lost nor paid twice. Absent otherwise.
			 */
			poll?: { model: ModelRef; thinkingLevel?: ModelThinkingLevel; cutoff: EntryId; handle: DeferredHandle };
	  }
	// poll 相位：已确定要轮询的延迟响应，等待 pollAt；thinkingLevel 在旧版本检查点中可能缺失。
	| {
			phase: "poll";
			attempt: number;
			compacted?: TaskId<CompactionResult>;
			model: ModelRef;
			// 旧版本检查点没有 thinkingLevel；可选字段让 migrate 不必补值，分类时也允许 undefined。
			/** Absent in checkpoints of earlier versions. */
			thinkingLevel?: ModelThinkingLevel;
			cutoff: EntryId;
			handle: DeferredHandle;
			pollAt: number;
	  }
	// tools 相位：等待本轮工具任务；tools 是已创建任务的 ID，pending 是顺序执行时尚未开始的调用 ID。
	| {
			/** Waiting on the round's tool tasks, which the generation owns (spec §8.5). */
			phase: "tools";
			// assistant 是本轮工具调用的助手条目 ID，工具结果会关联回它。
			/** The tool-calling answer. */
			assistant: EntryId;
			// tools 随顺序轮次逐个增长；pending 只保留调用 ID，开始在 tools 相位中创建对应任务。
			/** Tool tasks created so far, in call order; grows by one per started call of a sequential round. */
			tools: TaskId<ToolTaskResult>[];
			/** Calls of a sequential round not started yet, in call order. */
			pending: string[];
	  }
	// finish 相位：运行已经回答、输入已结算，但 afterRun 钩子可能请求子任务；pi.live.run 在此期间保留。
	// 此相位崩溃是安全的：还没有创建任何子任务，恢复时会重新询问钩子。
	| {
			/**
			 * The run answered: its answer is committed and its inputs settled, and it keeps `pi.live.run` while `afterRun`
			 * hooks are asked for tasks (spec §8.3). A crash here asks them again: nothing was created yet.
			 */
			phase: "finish";
			run: RunSummary;
	  }
	// drain 相位：afterRun 请求的子任务已创建，等待它们到达终态后结束运行；结果不影响运行的完成状态。
	| {
			/** Waiting on the tasks `afterRun` hooks asked for, which the generation owns; then the run ends. */
			phase: "drain";
			answer: EntryId;
			tasks: TaskId[];
	  };

// GenerationResult 只有一个字段：最终回答条目的 ID。
export type GenerationResult = { entryId: EntryId };

// Runtime/Next 是长泛型别名：Runtime 固定本任务的四个泛型参数，Next 是相位返回的状态联合；二者只在编译期存在。
type Runtime = TaskRuntime<GenerationInput, GenerationCheckpoint, GenerationResult, GenerationHooks>;
type Next = NextTaskState<GenerationCheckpoint, GenerationResult>;

// Request 汇总“响应分类”需要的请求信息；messages 可选，因为 tools 相位可能已经推导过上下文。
/** What classification needs from the request that produced a message. */
type Request = {
	readonly attempt: number;
	readonly compacted: TaskId<CompactionResult> | undefined;
	readonly model: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel | undefined;
	readonly cutoff: EntryId;
	// messages 是 cutoff 处的已提交模型上下文；给出时分类和工具轮不再重新读取。
	/** Committed model context through `cutoff`, when the phase already derived it. */
	readonly messages?: readonly Message[];
	/** Set when the message came from polling, so a still deferred result polls strictly later. */
	// pollAt 表示消息来自延迟轮询；再次得到 deferred 时，下一次轮询必须严格晚于这个时间。
	readonly pollAt?: number;
};

// 没有 pollAfterMs 时的默认轮询间隔：5 秒。
const DEFAULT_POLL_AFTER_MS = 5000;

// GenerationTask 是内置任务定义：name/version 用于注册、恢复与迁移匹配；initial 从 prepare 的第一次尝试开始。
/**
 * Built-in generation task: prepares the positional system prompt and tool loadout, requests or polls the model,
 * retries, and classifies the response. The run's inputs live in `pi.live.run`.
 */
// 定义的四个泛型依次是输入、检查点、结果、钩子接口；defineTask 只做编译期检查，运行时分派由调度器完成。
export const GenerationTask = defineTask<GenerationInput, GenerationCheckpoint, GenerationResult, GenerationHooks>({
	name: "pi.generation",
	version: 2,
	initial: () => ({ phase: "prepare", attempt: 1 }),
	// 版本 2 的变化：顺序工具轮中“未提供给模型的调用”进入 pending，并在槽位里标记 unoffered。
	// 旧版 Harness 会为这些调用创建未标记的任务并解析工具名，因此版本 2 任务在旧版 Harness 中保持阻塞而不是被错误执行。
	// Version 2 leaves calls to tools not offered in a sequential round's `pending`, flagged `unoffered` in their slots.
	// A version 1 Harness would start their tool tasks unflagged, resolving the name, so it leaves version 2 blocked
	// instead. A version 1 checkpoint has no such calls and is kept as it is.
	// migrate 把旧检查点原样交给新版本：版本 1 没有 unoffered 调用，形状兼容；as 是编译期断言，运行时不做字段校验。
	migrate: (input, checkpoint) => ({
		input: input as GenerationInput,
		checkpoint: checkpoint as GenerationCheckpoint,
	}),
	// phases 的每个函数都必须以 runtime.commit() 结束（或抛错），让调度器得到持久化进度；没有提交的返回会被判为故障。
	phases: {
		// prepare 相位：渲染系统提示词与工具集，追加位置性的 pi.system 条目，然后进入 request。
		// 本相位解析出的 agent/settings 在本次请求中固定；忙会话只有 Harness 能写模型上下文，所以读到提交时仍然有效。
		/**
		 * Render the system prompt and tool loadout and append the positional `pi.system` entries they need, then move to
		 * `request`. The agent and settings resolved here are fixed for this request. Only the Harness writes model
		 * context to a busy conversation, so the context read here is still current at the commit; display-only entries
		 * may land meanwhile.
		 */
		// prepare 入口；task/runtime/context 由调度器提供，runtime 暴露文档、任务、模型、钩子和提交能力。
		prepare: async (task, runtime, context) => {
			// 连续被切断太多次时结束运行，进入专门的 restart_limit 失败路径。
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, context);
			// 解构会话 ID；后续所有文档与任务都在这个会话作用域内创建。
			const { conversationId } = runtime;
			// runtime.agent() 在相位内解析一次 Agent（模型、工具、段、钩子）；同一相位内多次调用应得到同一结果。
			const agent = await runtime.agent(context);
			// settings 是 Harness 级设置；retry/compaction/progress 等策略从这里读取。
			const settings = runtime.settings;
			// 解构出存储的模型引用和思考级别；两者都可能未设置。
			const { model, thinkingLevel } = agent;
			// 通过模型目录解析实际模型；解析失败返回 undefined，下一行统一处理。
			const resolved = model === undefined ? undefined : runtime.models.getModel(model.provider, model.modelId);
			// 没有模型或模型不可用：结算输入为 no_model 并失败；这是运行时检查，因为目录可能变化。
			if (model === undefined || resolved === undefined) return failNoModel(runtime, model, context);
			// 从检查点取出重试计数、压缩引用和溢出/阈值标记；phase 在 prepare 分支中已确定为 "prepare"。
			const { attempt, compacted, overflow, threshold: blocked } = task.state.checkpoint;
			// 溢出触发的阻塞压缩已完成或失败，都会在恢复时检查一次；用 runtime.outcomes 读取子任务结果。
			if (compacted !== undefined && overflow !== undefined) {
				const [outcome] = await runtime.outcomes([compacted], context);
				// 压缩未完成或没有产生摘要条目：上下文仍然溢出，按 model_error 结束；detail 保留原始溢出文本。
				if (outcome?.status !== "completed" || outcome.result.entryId === undefined) {
					return failModelError(runtime, overflow, context);
				}
			}
			// 阈值压缩的两种“无害”结局：没有可压缩内容或被钩子拒绝，此时请求可能仍然放得下；
			// 但压缩失败意味着上下文被判定过大，继续请求只会再次溢出或没有回答空间。
			// A threshold compaction that found nothing to compact or was declined leaves a request that may still fit. One
			// that failed left a context it judged too large: sending it would at best leave no room for the answer.
			// 阈值压缩结果检查：只有非 completed 才失败；completed 但没有摘要条目（被取消/无可压缩）继续发请求。
			if (compacted !== undefined && blocked === true) {
				const [outcome] = await runtime.outcomes([compacted], context);
				if (outcome !== undefined && outcome.status !== "completed") {
					return failModelError(runtime, compactionFailure(outcome), context);
				}
			}
			// 读取当前活动上下文；压缩可能刚追加摘要条目，所以必须在检查完结果后重新读取，而不是复用旧视图。
			const view = await runtime.context(conversationId, context);
			// The model owes an answer only to a context ending in a user message or tool results; system messages say
			// nothing it answers. Otherwise, as for a continue after an answer or in an empty conversation, end the run
			// before any request.
			// 模型只对“以用户消息或工具结果结尾”的上下文作答；系统消息不构成问题。findLast 跳过系统消息找最后一条非系统消息。
			const last = view.messages.findLast((message) => message.role !== "system");
			// 最后一条既不是用户也不是工具结果（例如回答后继续或空会话）：在发请求前结束运行。
			if (last?.role !== "user" && last?.role !== "toolResult") return failNothingToAnswer(runtime, context);
			// replaySections 从历史系统消息还原“已展示的提示词段”，避免重复渲染相同内容。
			const shown = replaySections(view.messages);
			// env 可能由宿主提供执行环境；它的构造可能失败，失败不应阻止请求（除非任务已被取消）。
			let env: ExecutionEnv | undefined;
			// try/catch 只保护 env 构造；context.abortSignal 已中止时重新抛出，让调度器处理取消。
			try {
				env = await runtime.env(context);
			} catch (error) {
				if (context.abortSignal?.aborted) throw error;
				// 非取消错误通过 report 记录为 host 回调错误；env 保持 undefined，提示词渲染继续。
				runtime.report(error, { kind: "host", callback: "env" });
			}
			// PromptInput 是段渲染的输入：会话、agent、环境、已展示段和文档读取器；Object.fromEntries 把 Map 转成普通对象。
			const input: PromptInput = { conversationId, agent, env, shown: Object.fromEntries(shown), read: runtime };
			// renderSections 按顺序渲染扩展段；渲染错误按段归属到提供/包装它的扩展，而不是让整个请求失败。
			const desired = await renderSections(
				agent.sections,
				input,
				shown,
				// 错误回调传入段对象；sectionExtension 找到负责该段的最后一个扩展，optionalExtension 在找不到时省略 extension 字段。
				(error, section) =>
					runtime.report(error, {
						kind: "extension",
						...optionalExtension(sectionExtension(agent, section.key)),
					}),
				context,
			);
			// planSystemEntries 比较期望段与已展示段，决定需要追加哪些 pi.system 条目和工具声明条目。
			const entries = planSystemEntries(view, desired, agent.tools, runtime.now());
			// 只有尚未启动过压缩时才计算阈值触发；已有 compacted 时避免同一运行重复压缩。
			const threshold =
				compacted === undefined
					? // thresholdCompaction 读取模型上下文窗口和压缩策略，返回 blocking/background/undefined。
						thresholdCompaction(view, entries, resolved.contextWindow, compactionPolicy(settings, model))
					: undefined;
			// 阻塞阈值：先压缩再重新准备；在压缩追加条目之前转录不变，所以直接提交等待状态即可。
			if (threshold === "blocking") {
				// Compact first and prepare again; the transcript is unchanged until the compaction appends.
				await runtime.commit(async (tx): Promise<Next> => {
					// 创建压缩任务，owner 是当前生成任务；子任务完成后 prepare 恢复并检查结果。
					const child = await createCompaction(tx, conversationId, { reason: "threshold" }, runtime.taskId);
					// 检查点保留 attempt，并记录 compacted 与 threshold；等待子任务时使用 allSettled，任何终态都会唤醒。
					const checkpoint = { phase: "prepare", attempt, compacted: child, threshold: true } as const;
					return { status: "waiting", checkpoint, on: [child], policy: "allSettled" };
				}, context);
				return;
			}
			// 提交准备结果：可能追加系统条目、启动后台压缩，并写入 request 检查点。
			await runtime.commit(async (tx) => {
				// The context ends in a message the model answers, so the conversation has an entry.
				// latestEntryId 返回最新条目 ID；上下文已确认可回答，所以会话至少有一条条目；! 只是编译期非空断言，运行时不检查。
				let cutoff = (await tx.latestEntryId(conversationId))!;
				// 逐条追加计划中的系统条目；appendEntry 返回带 ID 的记录，最后一条成为请求的 cutoff。
				for (const entry of entries) cutoff = (await tx.appendEntry(SystemEntry, conversationId, entry)).id;
				// Checked in this commit, so a compaction admitted during preparation counts.
				// 后台阈值压缩只在没有其他压缩任务运行时创建；在本提交内检查，准备期间准入的压缩也会被看到。
				if (threshold === "background" && (await tx.doc(LiveDoc, conversationId)).compactions === undefined) {
					// 无 owner 的压缩归会话所有，后台运行；它不阻塞本次请求。
					await createCompaction(tx, conversationId, { reason: "threshold" });
				}
				// request 检查点在 prepare 与 request 之间传递；compacted 为 undefined 时条件展开会完全省略该字段。
				const request = {
					attempt,
					...(compacted === undefined ? {} : { compacted }),
					model,
					thinkingLevel,
					streamOptions: settings.stream,
					cutoff,
				};
				// 进入 running：调度器立即执行 request 相位；checkpoint 中 phase 用字面量 "request" 判别。
				return { status: "running", checkpoint: { phase: "request", ...request } };
			}, context);
		},
		// request 相位：转换上次残留的部分响应，发布尝试号，读取上下文，应用 beforeRequest 钩子，然后流式请求模型。
		request: async (task, runtime, context) => {
			// Charging the attempt may itself be what keeps failing, such as converting a huge partial: the limit ends it.
			// 计费/转换这次尝试本身也可能不断被切断；达到上限时由 endCutOff 结束，而不是无限重试。
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, context);
			// task.restarts 存在表示主机在上次请求飞行中停止；按规范这是一次失败尝试（interrupted），不是静默重发。
			// The host stopped while this request was in flight: a failed attempt, not a resend (spec §8.3).
			if (task.restarts !== undefined) return interrupted(runtime, task.state.checkpoint, context);
			// 解构请求参数；这些字段在 prepare 提交时固定，恢复后保持不变。
			const { attempt, compacted, model: ref, thinkingLevel, streamOptions, cutoff } = task.state.checkpoint;
			const conversationId = runtime.conversationId;
			// The attempt shown is presentation, stored like progress (`PROGRESS_COMMIT`); converting a partial left by an
			// interrupted attempt appends an entry, which makes the commit immediate.
			// 先提交一次进度：把上次中断留下的部分响应转成 aborted 条目，并显示本次尝试号。
			await runtime.commit(
				async (tx) => {
					const live = await tx.doc(LiveDoc, conversationId);
					// convertPartial 读取 pi.live.generation.message；有内容才追加 aborted 助手条目，避免重复转换。
					await convertPartial(tx, live, conversationId);
					// live.generation 只保留展示字段 attempt；真正的检查点仍在任务记录里。
					live.generation = { attempt };
					return undefined;
				},
				context,
				// PROGRESS_COMMIT 允许该提交延迟持久化；但如果 convertPartial 追加了条目，提交会立即持久化。
				PROGRESS_COMMIT,
			);
			// 重新解析模型；目录可能在运行期间更新，恢复时模型可能已被删除。
			const model = runtime.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) return failNoModel(runtime, ref, context);
			// 读取截止 cutoff 的上下文；at 让请求范围与 prepare 看到的范围一致，不受新条目影响。
			const view = await runtime.context(conversationId, context, { at: cutoff });
			let messages = view.messages;
			// beforeRequest 钩子可以替换整个消息数组；多个钩子按扩展顺序串行，后一个看到前一个替换后的 messages。
			await runtime.hooks.each("beforeRequest", async (hook) => {
				const replaced = await hook({ messages }, runtime, context);
				if (replaced !== undefined) messages = replaced.messages;
			});
			// SimpleStreamOptions 汇总请求选项；展开 streamOptions 保留用户/设置提供的字段。
			const options: SimpleStreamOptions = {
				...streamOptions,
				// signal 让取消能中断 provider 请求；telemetry 传递观测上下文。
				signal: runtime.signal,
				telemetry: context.telemetry,
				// provider 会话 ID 用于缓存/会话亲和；ensureProviderSessionId 可能创建或读取持久身份。
				sessionId: await ensureProviderSessionId(runtime, context),
				// thinkingLevel 为 "off" 时不传 reasoning 字段，避免 provider 把它当作显式推理请求。
				...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
				// onPayload 让 beforeProviderRequest 钩子修改最终请求体；它在 provider 发送前被调用。
				onPayload: (payload) => providerPayload(runtime, model, payload, context),
			};
			// streamResponse 返回终态 AssistantMessage；期间的部分响应由它节流写入 pi.live。
			const message = await streamResponse(runtime, model, messages, options, attempt, context);
			// 分类请求包含 messages，供工具轮复用；pollAt 缺省表示本次不是轮询。
			const request = { attempt, compacted, model: ref, thinkingLevel, cutoff, messages: view.messages };
			// classify 在一个提交里清理部分响应并决定下一步（回答、工具轮、轮询、重试或失败）。
			await classify(runtime, request, message, context);
		},
		// retry 相位：退避睡眠结束后的入口；提前唤醒或旧记录中 until 未到时会继续睡。
		/** After the backoff's sleep; a run before `until` (an early wake, or a record of an earlier version) sleeps again. */
		retry: async (task, runtime, context) => {
			// 解构 retry 字段；poll 可选，只有“轮询期间主机死亡”才有。
			const { attempt, compacted, until, poll } = task.state.checkpoint;
			// 再次检查重启上限；计费尝试本身被切断也会到达这里。
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, context);
			// 当前时间早于 until：把同一检查点交回调度器并睡到 until；sleepUntil 不消耗 attempt。
			if (until > runtime.now()) return runtime.sleepUntil(until, task.state.checkpoint, context);
			// 提交下一次尝试：清除 retry 展示字段，决定进入 poll 还是 prepare。
			await runtime.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				const kept = compacted === undefined ? {} : { compacted };
				// A poll the host died during polls its response again, as the next attempt.
				// 有 poll 记录：恢复的是被中断的轮询，attempt 加一但不再发送新请求。
				if (poll !== undefined) {
					const pollAt = runtime.now();
					// live.generation 显示下一次 attempt 与轮询时间；deferred.pollAt 让客户端知道何时刷新。
					live.generation = { attempt: attempt + 1, deferred: { pollAt } };
					return {
						status: "running",
						// 轮询检查点保留模型、思考级别、cutoff 与 handle；pollAt 是本次恢复后的轮询时间。
						checkpoint: { phase: "poll", attempt: attempt + 1, ...kept, ...poll, pollAt },
					};
				}
				// 普通重试：显示 attempt 加一，然后回到 prepare 重新渲染/读取上下文。
				live.generation = { attempt: attempt + 1 };
				// prepare 检查点保留 compacted（如果有），attempt 加一；下一次请求可能因设置变化而使用新策略。
				return { status: "running", checkpoint: { phase: "prepare", attempt: attempt + 1, ...kept } };
			}, context);
		},
		// poll 相位：等待 pollAt 后拉取延迟响应；提前唤醒时继续睡。
		/** After the sleep until `pollAt`; a run before it (an early wake, or a record of an earlier version) sleeps again. */
		poll: async (task, runtime, context) => {
			// 解构轮询参数；handle 是 provider 返回的延迟句柄，cutoff 是请求范围。
			const { attempt, compacted, model: ref, thinkingLevel, cutoff, handle, pollAt } = task.state.checkpoint;
			// 重启上限检查。
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, context);
			// task.restarts 表示主机在拉取延迟响应时死亡；按失败尝试处理。先于时间检查，因为替换主机的时钟可能回拨。
			// The host stopped while the poll's fetch was in flight: a failed attempt, as for a request. Checked before the
			// time, which may have moved backwards on a replacement host; a sleeping poll is never cut off.
			// 已中断的轮询不 sleep；直接进入 interrupted 的重试/失败逻辑。
			if (task.restarts !== undefined) return interrupted(runtime, task.state.checkpoint, context);
			// pollAt 未到：睡到 pollAt；poll 检查点原样保存。
			if (pollAt > runtime.now()) return runtime.sleepUntil(pollAt, task.state.checkpoint, context);
			// 重新解析模型；模型可能已不可用。
			const model = runtime.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) return failNoModel(runtime, ref, context);
			// fetchDeferred 通过 provider 拉取延迟响应；signal/telemetry 传递取消与观测。
			const message = await runtime.models.fetchDeferred(model, handle, {
				signal: runtime.signal,
				telemetry: context.telemetry,
			});
			// request 对象标记 pollAt，分类时若仍是 deferred，会保证下一次轮询严格更晚。
			const request = { attempt, compacted, model: ref, thinkingLevel, cutoff, pollAt };
			// 与 request 相位共用分类逻辑；分类结果提交并决定下一步。
			await classify(runtime, request, message, context);
		},
		// tools 相位：顺序轮次逐个启动调用并等待；全部启动后进入 finishToolRound。
		tools: async (task, runtime, context) => {
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, context);
			// 解构回合信息；pending 是尚未开始的调用 ID 数组。
			const { assistant, tools, pending } = task.state.checkpoint;
			// 取出下一个调用与剩余调用；next 为 undefined 表示顺序轮次的调用都已启动。
			const [next, ...rest] = pending;
			// 没有待启动调用：所有工具任务已在 tools 数组中，进入收尾。
			if (next === undefined) return finishToolRound(runtime, assistant, tools, context);
			// Sequential round: start the next call and wait for it.
			// 为下一个调用创建工具任务，并提交新的等待状态。
			await runtime.commit(async (tx): Promise<Next> => {
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				// 找到对应槽位；taskId 尚未设置的是本轮尚未启动的调用。unoffered 会随任务一起传递。
				const slot = live.tools?.find((slot) => slot.callId === next && slot.taskId === undefined);
				// createToolTask 创建模型发出的工具任务；所有权属于当前生成任务。
				const taskId = await createToolTask(tx, runtime, assistant, next, slot?.unoffered);
				// 把任务 ID 写回槽位，供展示和后续查找；槽位可能因并发清理而消失，存在时才写。
				if (slot !== undefined) slot.taskId = taskId;
				// 新检查点保留已创建任务并推进 pending；字面量 phase "tools" 保持判别类型。
				const checkpoint: GenerationCheckpoint = {
					phase: "tools",
					assistant,
					tools: [...tools, taskId],
					pending: rest,
				};
				// allSettled：等待新任务；完成、失败、中止都会唤醒并进入下一次 tools 相位。
				return { status: "waiting", checkpoint, on: [taskId], policy: "allSettled" };
			}, context);
		},
		// finish 相位：在进入 drain 的同一提交里询问 afterRun 钩子并创建子任务；没有任务则立即结束运行。
		/**
		 * Ask the `afterRun` hooks for tasks and create them, as the generation's children, in the commit that moves to
		 * `drain`; without any, end the run now.
		 */
		finish: async (task, runtime, context) => {
			const { run } = task.state.checkpoint;
			// 已经回答的运行被切断太多次：结束为 completed，但标记 task_interrupted，不再等待 afterRun。
			if (cutOffTooOften(task, runtime)) return endAnsweredCutOff(runtime, task, run.answer, context);
			// prepared 收集通过校验的任务；错误会被聚合后抛给 hooks.each 报告。
			const prepared: PreparedTask[] = [];
			// afterRun 钩子按扩展顺序调用；一个钩子可以返回多个任务请求。
			await runtime.hooks.each("afterRun", async (hook) => {
				const asked = await hook(run, runtime, context);
				// prepareRunEndTasks 在提交外校验任务名、输入和初始检查点；拒绝项收集后统一抛出。
				if (asked !== undefined) prepareRunEndTasks(runtime, asked.tasks, prepared);
			});
			// 没有可创建任务：直接结束运行（answer），并放置 final 边界。
			if (prepared.length === 0) return endAnsweredRun(runtime, run.answer, context);
			// 创建所有通过校验的子任务；所有权是当前生成任务，运行会等待它们。
			await runtime.commit(async (tx): Promise<Next> => {
				const tasks: TaskId[] = [];
				for (const { task, input } of prepared) {
					// 每个任务用安装时的定义创建，input 已经复制为严格 JSON。
					tasks.push(await tx.createTask(task, input, { ownership: { kind: "task", taskId: runtime.taskId } }));
				}
				// 在 pi.live.run 上记录 afterRun 任务 ID，供观察者看到“已回答但仍在等待”。
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				if (live.run?.taskId === runtime.taskId && live.run.afterRun !== undefined) live.run.afterRun.tasks = tasks;
				// drain 检查点只保留 answer 与任务 ID；on 字段是等待集合。
				const checkpoint = { phase: "drain", answer: run.answer, tasks } as const;
				return { status: "waiting", checkpoint, on: tasks, policy: "allSettled" };
			}, context);
		},
		// drain 相位：afterRun 任务无论成功失败都已终态，直接结束运行。
		/** The after-run tasks are terminal, whatever their outcomes: end the run. */
		drain: async (task, runtime, context) => {
			const { answer } = task.state.checkpoint;
			// 切断上限同样适用；已回答的运行以 completed 结束并标记中断。
			if (cutOffTooOften(task, runtime)) return endAnsweredCutOff(runtime, task, answer, context);
			// endAnsweredRun 放置 final 边界、结算输入并可能启动下一个运行。
			return endAnsweredRun(runtime, answer, context);
		},
	},
	// abort 相位：任务被取消时清理；已提交的部分响应转成 aborted 条目，未启动的工具调用补结果。
	abort: async (task, runtime, context) => {
		// checkpoint 决定取消时要清理什么（轮询句柄、未启动调用）。
		const checkpoint = task.state.checkpoint;
		// 先从检查点找延迟响应句柄；找到则取消 provider 任务，失败只报告不抛出。
		const polled = deferredOf(checkpoint);
		if (polled !== undefined) await cancelDeferred(runtime, polled, context);
		const conversationId = runtime.conversationId;
		// 中止发生在工具轮内时，顺序轮次里尚未启动的调用需要补 aborted/tool_unavailable 结果；
		// 这段注释紧邻下面的条件表达式，说明 unstarted 的来源。
		// Runs after the round's tool tasks are terminal; calls never started get `aborted` results (spec §8.5), unoffered
		// ones `tool_unavailable`.
		// 只有 tools 相位有 pending 调用；readCalls 从助手条目中按 ID 找回调用对象。
		const unstarted =
			checkpoint.phase === "tools"
				? await readCalls(runtime, checkpoint.assistant, checkpoint.pending, context)
				: [];
		// 在同一个提交里完成清理：转换部分响应、补工具结果、结束运行。
		await runtime.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversationId);
			await convertPartial(tx, live, conversationId);
			for (const call of unstarted) {
				// 槽位上的 unoffered 标记表示请求没有提供该工具；这种调用不可能真正执行，应结算为 tool_unavailable。
				// A call its request did not offer could not have run either way.
				const unoffered = live.tools?.find((slot) => slot.callId === call.id)?.unoffered === true;
				// unoffered 用 harnessError 生成错误结果；aborted 用于本来可执行但被取消的调用。
				const result = unoffered
					? harnessError("tool_unavailable", `Tool ${call.name} is not available`)
					: harnessError("aborted", `Tool ${call.name} was aborted`);
				// appendToolResult 追加工具结果的条目；即使工具从未启动，也要让 provider 看到成对结果。
				await appendToolResult(tx, conversationId, call, result, { timestamp: runtime.now() });
			}
			// finish/drain 中运行已回答：输入保持 done，不写 runFailure；其他相位按 aborted 结算。
			// In `finish` and `drain` the run answered already: it ends without a failure, its inputs stay `done`.
			endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "aborted" });
			// 任务以 aborted 终态结束；abort 调用方负责后续 UI/队列处理。
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});

// readCalls 按给定 ID 顺序返回助手条目中的工具调用；找不到的 ID 被跳过。
/** The calls `callIds` of the assistant entry, in the given order. */
// 参数 assistant 是助手条目 ID，callIds 是调用 ID；返回顺序与 callIds 一致。
async function readCalls(
	runtime: Runtime,
	assistant: EntryId,
	callIds: readonly string[],
	context: Context,
): Promise<ToolCall[]> {
	// 读取助手条目的第一条消息；工具调用保存在这条助手消息里。
	const message = (await runtime.entry(AssistantEntry, assistant, context))?.model?.[0];
	// 运行时检查 role，再过滤 toolCall 内容；其他内容（文本/思考）不参与。
	const calls = message?.role === "assistant" ? message.content.filter((content) => content.type === "toolCall") : [];
	// flatMap：对每个请求 ID 找第一个匹配调用；slice(0,1) 防止重复 ID 返回多条。
	return callIds.flatMap((id) => calls.filter((call) => call.id === id).slice(0, 1));
}

// createToolTask 创建模型调用对应的工具任务；unoffered 为 true 时任务直接结算工具不可用。
/** A tool task for call `callId`, owned by the generation; `unoffered` for a call to a tool its request did not offer. */
// 输入输入检查点中的 assistant 与 callId；返回工具任务 ID。
function createToolTask(
	tx: Tx,
	runtime: Runtime,
	assistant: EntryId,
	callId: string,
	unoffered: true | undefined,
): Promise<TaskId<ToolTaskResult>> {
	// createTask 的输入是判别 kind "model"；条件展开在未标记时省略 unoffered 字段。
	return tx.createTask(
		ToolTask,
		{ kind: "model", assistant, callId, ...(unoffered === undefined ? {} : { unoffered }) },
		// 所有权属于生成任务，生成任务取消时级联取消工具任务。
		{ ownership: { kind: "task", taskId: runtime.taskId } },
	);
}

// thresholdCompaction 决定准备阶段是否启动压缩：先算估算 token，再比较阻塞线与后台线；
// 只有 selectCut 能找到安全切点时才返回方向，否则压缩没有意义。
/**
 * Which threshold compaction preparation starts before its request (spec §8.3): `blocking` above
 * `contextWindow - reserveTokens`, `background` above the background threshold, and only when range selection finds a
 * cut. The caller starts a background one only while no compaction is listed.
 */
// 参数 view 是当前上下文，planned 是即将追加的系统条目，contextWindow 与 policy 来自模型/设置。
function thresholdCompaction(
	view: ContextView,
	planned: readonly { readonly model?: readonly Message[] }[],
	contextWindow: number,
	policy: CompactionPolicy,
): "blocking" | "background" | undefined {
	// 禁用压缩或模型上下文窗口未知（<=0）时不做阈值判断。
	if (!policy.enabled || contextWindow <= 0) return undefined;
	// estimateContext 把当前消息与计划条目的消息一起估算；flatMap 展开每个计划条目的 model 数组。
	const tokens = estimateContext(
		view,
		planned.flatMap((entry) => entry.model ?? []),
	);
	// 阻塞线 = 上下文窗口 - 预留回答空间；超过它必须先压缩，否则回答没有空间。
	const blocking = contextWindow - policy.reserveTokens;
	// 后台线比阻塞线更低（减去 backgroundTokens），用于提前在后台压缩；0 表示关闭后台触发。
	const background = blocking - policy.backgroundTokens;
	// 超过阻塞线优先返回 blocking；否则在启用后台压缩且超过后台线时返回 background。
	const over =
		tokens > blocking ? "blocking" : policy.backgroundTokens > 0 && tokens > background ? "background" : undefined;
	// 没有触发，或没有可压缩区间：返回 undefined；后者避免创建必然空转的压缩任务。
	if (over === undefined || selectCut(view, policy.keepRecentTokens) === undefined) return undefined;
	return over;
}

// compactionFailure 把非 completed 的压缩结果转成失败文本；用于 prepare 恢复时向运行报告。
/** Error text for a generation whose blocking compaction ended without completing. */
// 判别联合按 status 分支；failed/faulted 用 error.message，orphaned 用调度器给出的原因。
function compactionFailure(outcome: Exclude<TaskOutcome<CompactionResult>, { status: "completed" }>): string {
	switch (outcome.status) {
		case "failed":
		case "faulted":
			return `Compaction failed: ${outcome.error.message}`;
		case "orphaned":
			return `Compaction failed: ${outcome.reason}`;
		case "aborted":
			return "Compaction was aborted";
	}
}

// failModelError 结算运行输入为 model_error 并让生成任务失败；text 是给客户端的原因。
/** Settle the run's inputs `unanswered` with `model_error` and fail with `text`. */
async function failModelError(runtime: Runtime, text: string, context: Context): Promise<void> {
	// 所有读写都在同一个提交里：读取失败处理策略，然后结束运行。
	await runtime.commit(async (tx) => {
		// prepareFailure 在第一次表写之前读取 afterFailedRun 策略与可能的 boundary。
		const failure = await prepareFailure(tx, runtime);
		// 读取 pi.live 草稿；endFailedRun 会修改 run/runFailure 字段。
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		// endFailedRun 结算输入、按策略处理队列，并写入 runFailure。
		await endFailedRun(tx, runtime, live, failure, { status: "unanswered", reason: "model_error", detail: text });
		// 返回终态失败；error.detail.reason 用于上层分类。
		return {
			status: "terminal",
			outcome: { status: "failed", error: { message: text, detail: { reason: "model_error" } } },
		};
	}, context);
}

// interrupted 处理“主机在请求/轮询飞行中停止”：按重试策略决定退避重试还是结束运行。
// 已提交的部分响应会转成 aborted 条目；轮询的延迟响应在不再重试时取消，避免 provider 后台任务泄漏。
/**
 * The host stopped while this attempt's request or poll was in flight (`TaskRecord.restarts`): a failed attempt under
 * `settings.retry` (spec §8.3). The committed partial becomes an aborted entry; the next attempt follows the backoff, a
 * poll's by polling its deferred response again, or, with no retry left, the run ends `interrupted`.
 */
// 参数 checkpoint 已收窄为 request 或 poll 分支，因此 attempt/compacted 一定存在。
async function interrupted(
	runtime: Runtime,
	checkpoint: Extract<GenerationCheckpoint, { phase: "request" | "poll" }>,
	context: Context,
): Promise<void> {
	// 重试计数与压缩引用；attempt 表示当前是第几次尝试。
	const { attempt, compacted } = checkpoint;
	// 读取当前重试策略；设置可能在运行期间变化，所以不固定于 prepare。
	const policy = runtime.settings.retry;
	// 可重试条件：策略启用且当前尝试数未超过 maxRetries；attempt 从 1 开始。
	const retry = policy.enabled && attempt <= policy.maxRetries;
	// 退避时间由 retryDelayMs 计算；不可重试时 until=0（不会使用）。
	const until = retry ? runtime.now() + retryDelayMs(policy, attempt) : 0;
	// 只有 poll 相位携带延迟句柄；request 相位是普通请求。
	const polled = checkpoint.phase === "poll" ? checkpoint : undefined;
	// 失败文本区分两种情况，便于诊断主机在哪一步停止。
	const text =
		polled === undefined
			? `The host stopped while the model was answering, on attempt ${attempt}`
			: `The host stopped while the deferred answer was fetched, on attempt ${attempt}`;
	// 不再重试且存在轮询句柄：取消 provider 的延迟任务；取消失败只报告。
	// A run that ends does not leave the provider's job running.
	if (!retry && polled !== undefined) await cancelDeferred(runtime, polled, context);
	// 提交重试或失败；返回 Next 供调度器决定 sleeping/terminal。
	await runtime.commit(async (tx): Promise<Next> => {
		// Read before the first table write; only a failure uses it.
		// 失败处理需要读表（afterFailedRun 策略/边界），必须在本次提交第一次写之前读取。
		const failure = retry ? undefined : await prepareFailure(tx, runtime);
		// 读取 pi.live；后续可能写重试展示或 runFailure。
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		// 把已提交的部分响应转成 aborted 助手条目；这是恢复后仍能看到“上次尝试留下了什么”的原因。
		await convertPartial(tx, live, runtime.conversationId);
		// 可重试：写 retry 展示字段并进入 retry 检查点。
		if (failure === undefined) {
			// pi.live.generation.retry 显示下次重试时间与错误文本。
			live.generation = { attempt, retry: { at: until, error: text } };
			// poll 记录用条件展开构造：只有 poll 相位才有；thinkingLevel 可能缺失，也不写出 undefined。
			const poll =
				polled === undefined
					? {}
					: {
							poll: {
								model: polled.model,
								...(polled.thinkingLevel === undefined ? {} : { thinkingLevel: polled.thinkingLevel }),
								cutoff: polled.cutoff,
								handle: polled.handle,
							},
						};
			// retry 检查点保留 attempt（尚未增加），并带 poll 信息；恢复后 retry 相位会再决定进入 poll 还是 prepare。
			const next = { phase: "retry", attempt, ...(compacted === undefined ? {} : { compacted }), until, ...poll };
			return { status: "sleeping", checkpoint: next as GenerationCheckpoint, until };
		}
		// 不可重试：结算输入为 interrupted 并结束失败；detail 记录文本。
		await endFailedRun(tx, runtime, live, failure, { status: "unanswered", reason: "interrupted", detail: text });
		return {
			status: "terminal",
			outcome: { status: "failed", error: { message: text, detail: { reason: "interrupted" } } },
		};
	}, context);
}

// endCutOff 处理连续被切断达到 restartLimit 的生成：尽量保存部分响应并取消延迟响应，然后失败为 restart_limit。
/**
 * End a run whose generation was cut off `settings.restartLimit` times in a row (spec §5.4). At the limit it still
 * keeps a committed partial as an aborted entry and cancels a deferred response it polled; past the limit that cleanup
 * may be what cut it off, so it ends without it.
 */
// task 只需要 restarts 与 checkpoint；cutOffCount 生成可读次数。
async function endCutOff(
	runtime: Runtime,
	task: { readonly restarts?: number; readonly state: { readonly checkpoint: GenerationCheckpoint } },
	context: Context,
): Promise<void> {
	// 当前检查点决定文本中的相位名（prepare/request/tools 等）。
	const checkpoint = task.state.checkpoint;
	// 失败文本包含次数与相位；模板字符串在运行时拼接。
	const text = `The generation was interrupted ${cutOffCount(task)} in its ${checkpoint.phase} phase`;
	// salvageable 判断是否还允许做收尾清理；超过上限时清理本身可能再次被切断。
	const salvage = salvageable(task, runtime);
	// 找出检查点轮询的延迟响应（poll 或 retry.poll）。
	const polled = deferredOf(checkpoint);
	// 只有允许清理且存在轮询句柄时才取消，避免在极限情况下继续做重活。
	if (salvage && polled !== undefined) await cancelDeferred(runtime, polled, context);
	// 提交失败终态；prepareFailure 在写之前读取策略。
	await runtime.commit(async (tx): Promise<Next> => {
		// 读取失败处理策略；这是失败运行结束需要的表读。
		const failure = await prepareFailure(tx, runtime);
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		// 允许清理时转换部分响应；否则跳过，直接结束。
		if (salvage) await convertPartial(tx, live, runtime.conversationId);
		// endFailedRun 结算输入、处理队列并写 runFailure；原因固定 restart_limit。
		await endFailedRun(tx, runtime, live, failure, { status: "unanswered", reason: "restart_limit", detail: text });
		return {
			status: "terminal",
			outcome: { status: "failed", error: { message: text, detail: { reason: "restart_limit" } } },
		};
	}, context);
}

// deferredOf 从检查点提取“仍需要轮询的延迟响应”：poll 相位直接有，retry 相位可能有 poll。
/** The deferred response a checkpoint polls, or will poll again after a retry's backoff. */
function deferredOf(
	checkpoint: GenerationCheckpoint,
): { readonly model: ModelRef; readonly handle: DeferredHandle } | undefined {
	// poll 分支返回整个检查点（含 model/handle）；类型上多出的字段不会影响调用方。
	if (checkpoint.phase === "poll") return checkpoint;
	// retry 分支只有 poll 字段存在时返回；否则 undefined。
	return checkpoint.phase === "retry" ? checkpoint.poll : undefined;
}

// cancelDeferred 取消一个不会再有尝试轮询的延迟响应；模型缺失时静默返回，取消失败只报告。
/** Cancel a deferred response no attempt will poll again; a failure is reported, never thrown. */
async function cancelDeferred(
	runtime: Runtime,
	checkpoint: { readonly model: ModelRef; readonly handle: DeferredHandle },
	context: Context,
): Promise<void> {
	// 重新解析模型；目录变化可能导致模型不存在。
	const model = runtime.models.getModel(checkpoint.model.provider, checkpoint.model.modelId);
	if (model === undefined) return;
	// try 包住 provider 取消调用；signal 已中止时也可能抛错，但不应让清理失败。
	try {
		await runtime.models.cancelDeferred(model, checkpoint.handle, {
			signal: runtime.signal,
			telemetry: context.telemetry,
		});
		// 取消错误报告为 host/models 回调错误；不向外抛，避免掩盖原始失败。
	} catch (error) {
		runtime.report(error, { kind: "host", callback: "models" });
	}
}

// failNoModel 结算输入为 no_model 并失败；消息区分“未配置”和“配置的模型不可用”。
/** Settle the run's inputs `unanswered` with `no_model` and fail. */
async function failNoModel(runtime: Runtime, ref: ModelRef | undefined, context: Context): Promise<void> {
	// ref 为 undefined 表示没有选择模型；否则用 provider/modelId 组成可读消息。
	const message =
		ref === undefined ? "No model is configured" : `Model ${ref.provider}/${ref.modelId} is not available`;
	// 提交失败终态；先读策略，再结束运行。
	await runtime.commit(async (tx) => {
		const failure = await prepareFailure(tx, runtime);
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		// settlement 明确把输入结算为 no_model；endFailedRun 仍会按 afterFailedRun 策略处理队列。
		await endFailedRun(tx, runtime, live, failure, {
			status: "unanswered",
			reason: "no_model",
			detail: message,
			settlement: { status: "unanswered", reason: "no_model" },
		});
		// 返回失败结果；detail.reason 与任务失败原因一致。
		return { status: "terminal", outcome: { status: "failed", error: { message, detail: { reason: "no_model" } } } };
	}, context);
}

// failNothingToAnswer 结束“上下文没有可回答内容”的运行；它不发请求，也不需要模型。
/** End the run without a request: its context has nothing the model would answer. */
// 该函数只接收 runtime/context；错误文本固定。
async function failNothingToAnswer(runtime: Runtime, context: Context): Promise<void> {
	const message = "The conversation has nothing to answer";
	// 提交失败：读策略、结束运行、返回 terminal failed。
	await runtime.commit(async (tx) => {
		const failure = await prepareFailure(tx, runtime);
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		// 原因 nothing_to_answer 会写入 runFailure，并结算输入为 unanswered。
		await endFailedRun(tx, runtime, live, failure, { status: "unanswered", reason: "nothing_to_answer" });
		const error = { message, detail: { reason: "nothing_to_answer" } };
		return { status: "terminal", outcome: { status: "failed", error } };
	}, context);
}

// Failure 是失败运行结束所需的表读结果：策略，以及 continue 策略下预先读取的边界。
/** What a failed run's end needs from the table, read before the commit's first table write. */
type Failure = { readonly policy: AfterFailedRun; readonly boundary?: Boundary };

// prepareFailure 在事务第一次写之前读取 afterFailedRun；continue 时还需要 prepareBoundary 的队列快照。
async function prepareFailure(tx: Tx, runtime: Runtime): Promise<Failure> {
	const settings = runtime.settings;
	// policy 是运行失败后对排队项的处理方式：keep、continue 或 withdraw。
	const policy = settings.afterFailedRun;
	// 只有 continue 需要边界；其他策略不需要读取队列，避免不必要的表读。
	if (policy !== "continue") return { policy };
	return { policy, boundary: await prepareBoundary(tx, runtime.conversationId, settings) };
}

// endFailedRun 结束失败运行：先结算输入，再按策略保留/继续/撤销排队项；continue 时可能立即启动下一个运行。
/**
 * End a failed run, settling its inputs with `settlement`, and do with the inputs queued behind it what
 * `settings.afterFailedRun` says (spec §6): keep them, start the next run with them, or withdraw them.
 */
// 参数 live 是同一个提交里的 pi.live 草稿；end 是无回答的 RunEnd 分支。
async function endFailedRun(
	tx: Tx,
	runtime: Runtime,
	live: Draft<LiveState>,
	failure: Failure,
	end: Extract<RunEnd, { status: "unanswered" }>,
): Promise<void> {
	const conversationId = runtime.conversationId;
	// endRun 结算输入、删除 run 并写 runFailure；它同时清理 generation/tools/nestedTools。
	endRun(tx, live, runtime.taskId, end);
	// withdraw 策略：撤销所有排队输入并结算为 run_failed；队列中的 write 项保留。
	if (failure.policy === "withdraw") await withdrawQueuedInputs(tx, conversationId, "run_failed");
	// 没有 boundary 表示策略不是 continue（或是 keep），到此结束。
	if (failure.boundary === undefined) return;
	// continue 策略：在 final 边界放置选中项；stale 写入会被结算而不是带回旧历史。
	const { users, first } = await applyBoundary(tx, failure.boundary, "final", runtime.now());
	// 有选中的用户输入时立即启动下一个运行；keepFailure 让新运行保留刚写入的 runFailure 供客户端展示。
	if (users.length > 0) await startRun(tx, conversationId, live, { inputs: users, first }, { keepFailure: true });
}

// convertPartial 把 pi.live 中已提交的部分助手消息转成 aborted 条目；调用方负责随后替换/删除 generation。
/**
 * Append a committed partial left by an interrupted, aborted, faulted, or orphaned attempt as an aborted assistant
 * entry; the caller replaces or removes `generation`.
 */
export async function convertPartial(tx: Tx, live: Draft<LiveState>, conversationId: ConversationId): Promise<void> {
	// 没有部分消息时直接返回；空 generation 不需要条目。
	const partial = live.generation?.message;
	if (partial === undefined) return;
	// copyJson 深复制成普通 JSON；as unknown as AssistantMessage 是必要的双重断言：JSON 表示不能直接赋给 AssistantMessage，运行时不校验形状。
	const message = copyJson(partial) as unknown as AssistantMessage;
	// 强制 stopReason "aborted"：部分响应没有正常停止，不能伪装成完整回答。
	await appendAssistant(tx, conversationId, { ...message, stopReason: "aborted" });
}

// providerPayload 对一次 provider 请求体应用 beforeProviderRequest 替换链。
/** The `beforeProviderRequest` replacement chain over one provider request body. */
// model 用于钩子判断；payload 是 provider 即将发送的对象；返回最终 payload。
async function providerPayload(
	runtime: Runtime,
	model: Model<Api>,
	payload: unknown,
	context: Context,
): Promise<unknown> {
	// current 保存替换链的当前值；初始是原 payload。
	let current = payload;
	// hooks.each 按扩展顺序串行调用；每个钩子可以返回 undefined 表示不替换。
	await runtime.hooks.each("beforeProviderRequest", async (hook) => {
		// 返回新 payload 时更新 current，后续钩子看到更新后的值。
		const replaced = await hook({ model, payload: current }, runtime, context);
		if (replaced !== undefined) current = replaced.payload;
	});
	return current;
}

// streamResponse 流式请求模型并返回终态消息；期间按 partialIntervalMs 节流提交部分响应。
// 最多一个提交在飞行中；finally 停止计时器并等待飞行中的提交，避免终态之后又落入旧部分响应。
/**
 * Stream one request and return the terminal message. Partials commit as trailing writes at most every
 * `progress.partialIntervalMs` (default 100 ms) with one commit in flight, deferred (`PROGRESS_COMMIT`); `finally` stops
 * the throttle and awaits that commit, so no stale partial lands after the outcome. A commit appends what text and
 * thinking grew by and applies the argument changes since the last one (`PartialChanges`), so its cost follows the new
 * text, not the strings' length.
 */
// 参数 messages 是本次请求上下文；options 已含 signal/telemetry/sessionId 等；attempt 只用于展示。
async function streamResponse(
	runtime: Runtime,
	model: Model<Api>,
	messages: readonly Message[],
	options: SimpleStreamOptions,
	attempt: number,
	context: Context,
): Promise<AssistantMessage> {
	// 节流间隔来自 progress.partialIntervalMs；默认 100ms。
	const interval = runtime.settings.progress.partialIntervalMs;
	// pending 保存最新部分响应；timer 是下一次 flush 的取消函数。
	let pending: AssistantMessage | undefined;
	let timer: (() => void) | undefined;
	// inFlight 是当前提交 Promise；同一时间最多一个，避免并发写同一文档。
	let inFlight: Promise<void> | undefined;
	// stopped 在 for-await 结束后置 true，阻止计时器再安排新的提交。
	let stopped = false;
	// PartialChanges 跟踪自上次提交以来文本/思考增长和工具参数变化。
	const changes = new PartialChanges();
	// flush 把 pending 部分响应提交到 pi.live；它是普通函数，内部异步任务由 inFlight 跟踪。
	const flush = (): void => {
		// 计时器已触发或取消，清空引用；下一次有 pending 时重新安排。
		timer = undefined;
		// 取走 pending 并清空，避免同一个部分响应提交两次。
		const partial = pending;
		pending = undefined;
		// 没有新部分响应或已停止：不提交。
		if (partial === undefined || stopped) return;
		// 开始异步提交；赋值给 inFlight，供 finally 等待。
		inFlight = (async () => {
			// 同步复制部分响应：provider 会继续修改自己的对象；复制后内容固定。
			// Copy synchronously: the provider keeps mutating its partial. The changes since the last commit belong to it.
			// `copyJson()` returns untyped JSON; a copy of a message is that message's JSON representation.
			// copyJson 返回无类型 JSON；断言为 PartialMessage 表示“这是某条助手消息的 JSON 表示”。
			const message = copyJson(partial, { omitUndefinedProperties: true }) as PartialMessage;
			// changes.take(message) 取出自上次提交以来的增量；返回 taken 供失败时恢复。
			const taken = changes.take(message);
			try {
				// 提交到 pi.live；PROGRESS_COMMIT 允许延迟持久化。
				await runtime.commit(
					async (tx) => {
						// 读取文档草稿；live.generation 可能尚不存在。
						const live = await tx.doc(LiveDoc, runtime.conversationId);
						// ??= 只在 generation 缺失时创建最小展示状态；已有状态保留 attempt 等字段。
						live.generation ??= { attempt };
						// changes.commit 把文本/思考追加和工具参数写入草稿；只记录增量，不重写整条消息。
						changes.commit(live.generation, message, taken);
						return undefined;
					},
					context,
					PROGRESS_COMMIT,
				);
				// 提交失败：把增量放回 PartialChanges，下一次提交可以重试；然后重新抛出给外层 catch。
			} catch (error) {
				// restore 还原 taken 的跟踪状态，避免增量丢失。
				changes.restore(taken);
				throw error;
			}
			// 提交 Promise 的错误处理：abort mark/close 之后的拒绝是预期的，已提交状态仍然一致。
		})()
			.catch((error: unknown) => {
				// Rejections after an abort mark or close are expected; the committed state stays consistent.
				// 只有未中止时才 report；中止后的拒绝不视为错误，已提交状态保持一致。
				if (!runtime.signal.aborted) runtime.report(error);
			})
			// finally 在提交完成后清理 inFlight，并在还有 pending 时重新安排计时器。
			.finally(() => {
				inFlight = undefined;
				// 只有仍有待提交内容且未停止时才重新计时；否则等待下一次事件触发。
				if (pending !== undefined && !stopped) timer = runtime.setTimer(flush, interval);
			});
	};
	// try/finally 保证无论 provider 抛错都停止节流并等待飞行中的提交。
	try {
		// streamSimple 返回异步事件流；[...messages] 复制数组，避免 provider 修改调用方上下文。
		const events = runtime.models.streamSimple(model, { messages: [...messages] }, options);
		// for await 逐个消费事件；每个事件可能带 partial 消息。
		for await (const event of events) {
			// A partial without content, such as pi-ai's opening `start` event, shows nothing; a deferred response
			// never gets past it, so it never leaves a partial.
			// done/error 没有可展示部分；content 为空的事件（如开始事件）也不发布。延迟响应永远到不了有内容的事件。
			if (event.type === "done" || event.type === "error" || event.partial.content.length === 0) continue;
			// 记录事件到 PartialChanges；它只跟踪增长，不写文档。
			changes.observe(event);
			// 保存最新部分响应，等待节流计时器提交。
			pending = event.partial;
			// 没有计时器且没有提交在飞行中时启动计时；否则当前提交完成后会重新安排。
			if (timer === undefined && inFlight === undefined) timer = runtime.setTimer(flush, interval);
		}
		// events.result() 等待流结束并返回终态消息；provider 错误会在这里抛出。
		return await events.result();
		// finally：先停止新的 flush，再取消计时器，最后等待飞行中的提交完成。
	} finally {
		stopped = true;
		// timer?.() 是可选调用：没有计时器时什么都不做。
		timer?.();
		// await inFlight 确保 finally 返回前最后一次提交已经落盘，不会在终态之后写入旧部分响应。
		await inFlight;
	}
}

// classify 在一个提交里分类终态消息：延迟轮询、工具轮、回答、重试或失败。
/** Classify a terminal provider message in one commit that also clears the partial. */
// request 提供 attempt/model/cutoff 等分类上下文；message 是 provider 终态消息。
async function classify(
	runtime: Runtime,
	request: Request,
	message: AssistantMessage,
	context: Context,
): Promise<void> {
	// 任务已被 abort mark 或关闭：让抛出的中止原因交给 abort 处理器；这里不再提交分类结果。
	// An abort mark or close: the abort invocation or the reopened run handles the committed state.
	runtime.signal.throwIfAborted();
	const conversationId = runtime.conversationId;
	// 解构请求字段；compacted 用于判断是否已经压缩过。
	const { attempt, compacted, model: ref, thinkingLevel, cutoff } = request;
	// Record the requested level, as pi-agent-core's agent loop does.
	// 记录请求的思考级别，与 pi-agent-core 的行为一致；provider 可能在消息中省略该字段。
	if (thinkingLevel !== undefined) message.thinkingLevel = thinkingLevel;
	// 延迟响应：消息不是最终回答，而是 provider 返回的句柄；进入轮询相位。
	if (message.stopReason === "deferred" && message.deferred !== undefined) {
		const handle = message.deferred;
		// pollAt 取两者较大值：不少于当前时间加 provider 建议间隔，也不早于上次轮询时间 + 1ms。
		const pollAt = Math.max(
			runtime.now() + (handle.pollAfterMs ?? DEFAULT_POLL_AFTER_MS),
			// request.pollAt 缺省时用 -Infinity，保证第一次轮询只受 provider 间隔限制；+1 防止同一毫秒重复轮询。
			request.pollAt === undefined ? Number.NEGATIVE_INFINITY : request.pollAt + 1,
		);
		// 提交轮询检查点；不追加助手条目，因为答案还没产生。
		await runtime.commit(async (tx): Promise<Next> => {
			// pi.live.generation 显示本次 attempt 与 deferred.pollAt；轮询期间不展示部分响应。
			(await tx.doc(LiveDoc, conversationId)).generation = { attempt, deferred: { pollAt } };
			// 检查点保存模型、可选思考级别、cutoff、handle 和 pollAt；用 as const 保持字面量 phase。
			const checkpoint = {
				phase: "poll",
				attempt,
				...(compacted === undefined ? {} : { compacted }),
				model: ref,
				...(thinkingLevel === undefined ? {} : { thinkingLevel }),
				cutoff,
				handle,
				pollAt,
			} as const;
			// sleeping 状态让调度器在 pollAt 前不调用任务；until 是 Harness 时钟毫秒。
			return { status: "sleeping", checkpoint, until: pollAt };
		}, context);
		return;
	}
	// afterResponse 钩子看到终态消息；它们不能替换消息，只能观察/记录。
	await runtime.hooks.each("afterResponse", (hook) => hook(message, runtime, context));
	// 类型谓词过滤出 ToolCall；message.content 还可能有 text/thinking。
	const calls = message.content.filter((content): content is ToolCall => content.type === "toolCall");
	// 正常工具调用：stopReason 为 toolUse 且至少一个调用；进入工具轮。
	if (message.stopReason === "toolUse" && calls.length > 0) {
		return startToolRound(runtime, request, message, calls, context);
	}
	// stop、length 或带调用的 toolUse 都视为“有回答可记录”：length 表示被截断但仍有内容。
	if (message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse") {
		return answer(runtime, message, context);
	}
	// 以下处理错误、中止等剩余停止原因；重试与压缩策略在分类时读取，而不是准备时固定。
	// The retry and compaction policies govern the next attempt, so they are read now rather than pinned at preparation.
	// settings 是当前 Harness 设置；策略变化会影响本次分类。
	const settings = runtime.settings;
	// 只有 stopReason 为 error 且错误被判定为上下文溢出时才考虑压缩；isContextOverflow 检查错误详情。
	const overflow = message.stopReason === "error" && isContextOverflow(message);
	// 读取该模型的压缩策略（可能被 per-model override 覆盖）。
	const compaction = compactionPolicy(settings, ref);
	// 溢出、尚未压缩、策略启用：满足三个条件才尝试溢出压缩。
	if (overflow && compacted === undefined && compaction.enabled) {
		// 读取 cutoff 处的上下文；用于判断是否存在安全切点。
		const view = await runtime.context(conversationId, context, { at: cutoff });
		// 没有可压缩区间时不做压缩，继续走重试/失败逻辑（溢出本身不可重试）。
		if (selectCut(view, compaction.keepRecentTokens) !== undefined) {
			const text = message.errorMessage ?? "Context overflow";
			// 溢出压缩提交：追加失败消息条目、清除部分响应展示、创建压缩子任务并等待。
			await runtime.commit(async (tx): Promise<Next> => {
				const live = await tx.doc(LiveDoc, conversationId);
				// 失败消息作为正常助手条目追加，让下一次请求能看到错误上下文。
				await appendAssistant(tx, conversationId, message);
				// 删除 generation 展示字段；压缩任务会接管状态。
				delete live.generation;
				// 创建溢出压缩，owner 是当前生成任务；reason 为 overflow。
				const child = await createCompaction(tx, conversationId, { reason: "overflow" }, runtime.taskId);
				// 检查点回到 prepare，等待子任务；overflow 文本用于压缩失败时报告。
				const checkpoint = { phase: "prepare", attempt, compacted: child, overflow: text } as const;
				return { status: "waiting", checkpoint, on: [child], policy: "allSettled" };
			}, context);
			return;
		}
	}
	// 读取重试策略；只有非溢出错误才可能重试。
	const policy = settings.retry;
	// An overflow is never retried: only a compaction can make the next request fit.
	// 重试条件：错误停止、非溢出、被 pi-ai 判定可重试、策略启用、尝试次数未超限。
	const retry =
		message.stopReason === "error" &&
		!overflow &&
		isRetryableAssistantError(message) &&
		policy.enabled &&
		attempt <= policy.maxRetries;
	// 退避时间；不可重试时为 0。
	const until = retry ? runtime.now() + retryDelayMs(policy, attempt) : 0;
	// 提交分类结果：失败时结算运行，可重试时进入 retry 睡眠。
	await runtime.commit(async (tx): Promise<Next> => {
		// Read before the first table write; only a failure uses it.
		// 失败处理需要读表；只有不重试时才读取，避免多余 I/O。
		const failure = retry ? undefined : await prepareFailure(tx, runtime);
		const live = await tx.doc(LiveDoc, conversationId);
		// 追加模型错误消息（或非错误但无法回答的消息）到转录；它参与后续上下文。
		await appendAssistant(tx, conversationId, message);
		// 可重试分支：写 retry 展示字段并返回 sleeping。
		if (failure === undefined) {
			// errorMessage 可能为空字符串；展示层仍能显示重试时间。
			live.generation = { attempt, retry: { at: until, error: message.errorMessage ?? "" } };
			const checkpoint = {
				phase: "retry",
				attempt,
				...(compacted === undefined ? {} : { compacted }),
				until,
			} as const;
			return { status: "sleeping", checkpoint, until };
		}
		// 不可重试：生成失败文本；errorMessage 缺省时使用 stopReason。
		const text = message.errorMessage ?? `Model response ended with stop reason ${message.stopReason}`;
		// 结算输入为 model_error；如果 afterFailedRun 是 continue，可能立即启动下一个运行。
		await endFailedRun(tx, runtime, live, failure, { status: "unanswered", reason: "model_error", detail: text });
		return {
			status: "terminal",
			outcome: { status: "failed", error: { message: text, detail: { reason: "model_error" } } },
		};
	}, context);
}

// answer 处理最终回答：先问 onYield 是否要继续，再决定是否等待 afterRun、放置 final 边界并交棒。
// 续写只有在队列没有用户项且没有 reset 时才被采用，避免吞掉用户输入或重置。
/**
 * A final answer; the final boundary places queued items (spec §6). The first `onYield` continuation appends a user
 * message and hands the run to a successor generation, but only when the inbox holds no user item and no reset.
 * Otherwise the run's inputs settle `done`; with `afterRun` hooks selected the run waits for the tasks they ask for,
 * in `finish` and `drain`, before the final boundary; without, selected user items start the next run now.
 */
// continuation 只在第一个返回 continue 的 onYield 钩子处设置；后续钩子看到已设置就不再覆盖。
async function answer(runtime: Runtime, message: AssistantMessage, context: Context): Promise<void> {
	let continuation: UserInput | undefined;
	// onYield 钩子按扩展顺序调用；返回 undefined 表示不续写。
	await runtime.hooks.each("onYield", async (hook) => {
		if (continuation !== undefined) return;
		// 取钩子结果的 continue 字段；第一个非 undefined 的 continue 生效。
		continuation = (await hook(message, runtime, context))?.continue;
	});
	// asksAfterRun 检查选中的扩展是否有 afterRun 钩子；有则运行要等待其任务。
	const afterRun = await asksAfterRun(runtime, context);
	const conversationId = runtime.conversationId;
	// 用一个提交完成回答：读边界、追加助手条目、决定交棒/等待/结束。
	await runtime.commit(async (tx): Promise<Next> => {
		// Queue modes are read on the Session line, when the boundary is decided.
		// 队列模式在 Session 线上读取，边界决定后不再变化。
		const boundary = await prepareBoundary(tx, conversationId, runtime.settings);
		const live = await tx.doc(LiveDoc, conversationId);
		// 追加最终助手条目，得到回答条目 ID；它是 GenerationResult 与 RunEnd.answer。
		const entry = await appendAssistant(tx, conversationId, message);
		// 默认结果已完成；后续分支可能改为 running。
		const result: Next = { status: "terminal", outcome: { status: "completed", result: { entryId: entry.id } } };
		// takesContinuation 是类型谓词：返回 true 时 continuation 收窄为 UserInput。
		const continues = takesContinuation(continuation, boundary) ? continuation : undefined;
		// 没有续写但配置了 afterRun：holdRun 结算输入并保留运行，进入 finish 相位。
		if (continues === undefined && afterRun) {
			const held = holdRun(tx, live, runtime, { reason: "answer", answer: entry.id, last: entry.id });
			if (held !== undefined) return held;
		}
		// final 边界：放置队列中选中的用户输入/write；返回的用户 ID 用于启动下一个运行。
		const { users, first } = await applyBoundary(tx, boundary, "final", runtime.now());
		// 有续写：追加一条用户消息并创建后继生成任务，把运行控制权交出去。
		if (continues !== undefined) {
			// 续写内容包装成 UserMessage；role 字面量由 as const 保持。
			const user = { role: "user", content: continues, timestamp: runtime.now() } as const;
			// 续写作为普通 pi.user 条目追加；它成为后继运行的输入上下文。
			await tx.appendEntry(UserEntry, conversationId, { model: [user] });
			// 续写把运行的 turns 清零，让后继请求重新开始轮数；限制 onYield 循环是扩展的责任，不在核心层强制。
			// The continuation starts the run's turn count over: bounding `onYield` loops is the extension's job.
			// 只有当前任务仍拥有运行时才改轮数，避免覆盖其他任务已接管的运行。
			if (live.run?.taskId === runtime.taskId) live.run.turns = 0;
			// 创建新生成任务并交棒；handOver 只更新仍属于 from 的运行。
			handOver(live, runtime.taskId, await createGeneration(tx, conversationId));
			// 删除 generation 展示字段；后继任务会按需重建。
			delete live.generation;
			return result;
		}
		// 无续写：结束运行并结算输入为 done；answer 关联回答条目。
		endRun(tx, live, runtime.taskId, { status: "done", answer: entry.id });
		// 边界选中的用户输入立即启动下一个运行；first 是该运行的起始条目。
		if (users.length > 0) await startRun(tx, conversationId, live, { inputs: users, first });
		return result;
	}, context);
}

// asksAfterRun 判断选定 agent 是否注册了 GenerationTask 的 afterRun 钩子。
/** Whether the phase's agent selects an `afterRun` hook, so a run that answers waits for its tasks (spec §8.3). */
async function asksAfterRun(runtime: Runtime, context: Context): Promise<boolean> {
	// agentHooks 按键名收集钩子；handlers 是 object，类型断言后检查 afterRun 是否为函数。
	const hooks = agentHooks(await runtime.agent(context), GenerationTask.definition.name);
	return hooks.some(({ handlers }) => typeof (handlers as Partial<GenerationHooks>).afterRun === "function");
}

// holdRun 是“已回答且需等待 afterRun”的提交 A：结算输入为 done，保留 pi.live.run，进入 finish。
// final 边界要等运行结束，所以在等待期间排队项保持排队。
/**
 * Commit A of a run that answered with `afterRun` hooks selected (spec §8.3): settle the run's inputs `done` with the
 * answer and keep `pi.live.run` for the after-run tasks, then ask the hooks in `finish`. The final boundary waits for
 * the run's end, so queued items stay queued.
 */
// 输入 live 草稿、runtime 和 RunSummary（first 由函数补）；返回 Next 或 undefined（运行不属于本任务）。
function holdRun(tx: Tx, live: Draft<LiveState>, runtime: Runtime, end: Omit<RunSummary, "first">): Next | undefined {
	// 读取当前 run；它可能已被其他任务接管。
	const run = live.run;
	// taskId 不匹配：不修改任何状态，返回 undefined 让调用方走其他分支。
	if (run?.taskId !== runtime.taskId) return undefined;
	// 每个输入结算为 done 并关联回答条目；holdRun 之后输入数组清空，避免重复结算。
	for (const id of run.inputs) tx.settleSubmission(id, { status: "done", answer: end.answer });
	// 清空 inputs 表示这些提交已经结算；运行仍保留用于 afterRun。
	run.inputs = [];
	// afterRun 字段标记“已回答，等待子任务”；finish 相位会填充任务 ID。
	run.afterRun = {};
	// 生成的展示字段清除：生成已结束，工具槽位也不再运行。
	delete live.generation;
	delete live.tools;
	delete live.nestedTools;
	// run.first 缺省（例如旧版本记录在 first 被记录之前启动）时，用回答条目作为运行起点。
	// A run started before `first` was recorded has its answer as its first entry.
	// 构造 RunSummary；展开 end 保留 reason/answer 等字段。
	const summary: RunSummary = { ...end, first: run.first ?? end.answer };
	// 返回 running + finish 检查点；调度器继续执行 finish。
	return { status: "running", checkpoint: { phase: "finish", run: summary } };
}

// PreparedTask 是通过校验、可直接创建的任务：定义已改写 initial 为固定检查点，输入是严格 JSON。
/** A task an `afterRun` hook asked for, checked and ready to create. */
type PreparedTask = { readonly task: Task<JsonValue, { phase: string }, JsonValue, object>; readonly input: JsonValue };

// prepareRunEndTasks 校验 afterRun 请求：拒绝内置任务、未安装任务、非 JSON 输入和未知初始相位。
// 校验在提交外完成，拒绝项聚合后抛出；hooks.each 会把错误归因到发起请求的扩展。
/**
 * Check the tasks one `afterRun` hook asked for, off the line, and add those that pass to `prepared`, so a broken request
 * is skipped instead of failing the creating commit: its kind must be an installed task that is not built-in, its input
 * JSON, and its definition's `initial()` must return a JSON checkpoint of one of its phases. The task is created from
 * the installed definition, as every task runs under it, with that checkpoint, so `initial()` runs once. Then throws
 * the rejections, which `hooks.each` reports against the hook's extension.
 */
// runtime 提供注册表；requests 是钩子返回的任务请求；prepared 是输出数组。
function prepareRunEndTasks(runtime: Runtime, requests: readonly RunEndTask[], prepared: PreparedTask[]): void {
	// rejected 收集错误，单个错误直接抛，多个用 AggregateError。
	const rejected: unknown[] = [];
	// 逐个处理请求；每个请求独立 try/catch，坏请求不阻止其他请求。
	for (const request of requests) {
		try {
			// 读取任务定义名。内置任务名以 pi. 开头，afterRun 不能启动它们；这是运行时字符串检查，类型系统无法表达。
			const name = request.task.definition.name;
			// 拒绝内置任务，避免 afterRun 递归启动生成/压缩/工具等核心任务。
			if (name.startsWith("pi.")) throw new Error(`An afterRun hook cannot start the built-in task ${name}`);
			// 从注册表取已安装定义；只允许已安装任务。
			const installed = runtime.registry.task(name);
			if (installed === undefined) throw new Error(`Task ${name} is not installed`);
			// copyJson 把输入转成严格 JSON 并去掉 undefined；不合法输入会在这里抛错。
			const input = copyJson(request.input, { omitUndefinedProperties: true });
			// The registry erases definitions; an installed one is a task definition of its kind.
			// 注册表擦除了具体泛型；as 断言把它当作 PreparedTask 的定义视图，运行时仍是同一对象。
			const definition = installed.definition as PreparedTask["task"]["definition"];
			// 运行 initial() 得到初始检查点并复制；检查点必须是 JSON。
			const checkpoint = copyJson(definition.initial(input), { omitUndefinedProperties: true }) as { phase: string };
			// Object.hasOwn 检查初始相位确实存在；防止 initial 返回未知 phase。
			if (!Object.hasOwn(definition.phases, checkpoint.phase)) {
				// 错误消息包含任务名与相位，String() 处理非字符串 phase。
				throw new Error(`Task ${name} starts at the unknown phase ${String(checkpoint.phase)}`);
			}
			// 用改写后的 initial 构造任务：创建时直接使用已算好的检查点，避免 initial 再运行一次产生不同结果。
			prepared.push({ task: { definition: { ...definition, initial: () => checkpoint } }, input });
			// 捕获本请求的任何错误，加入 rejected；继续处理下一个请求。
		} catch (error) {
			rejected.push(error);
		}
	}
	// 只有一个拒绝：直接抛出，保留原始错误类型。
	if (rejected.length === 1) throw rejected[0];
	// 多个拒绝：AggregateError 汇总；hooks.each 报告为单个错误。
	if (rejected.length > 1)
		throw new AggregateError(rejected, `${rejected.length} afterRun task requests were rejected`);
}

// endAnsweredRun 是“已回答运行”的提交 B：afterRun 任务已终态或不存在；放置 final 边界、结束运行、可能启动下一个。
/**
 * Commit B of a run that answered (spec §8.3): its after-run tasks are terminal, or there were none. Place what the
 * final boundary selects, end the run, and start the next one for selected user items.
 */
// 参数 answer 是回答条目 ID；它同时用于结束状态和结果。
async function endAnsweredRun(runtime: Runtime, answer: EntryId, context: Context): Promise<void> {
	const conversationId = runtime.conversationId;
	await runtime.commit(async (tx): Promise<Next> => {
		// 边界必须在第一次写之前读取；applyBoundary 之后才有表写。
		const boundary = await prepareBoundary(tx, conversationId, runtime.settings);
		const live = await tx.doc(LiveDoc, conversationId);
		// 放置选中项；users 是本次落位的用户提交 ID。
		const { users, first } = await applyBoundary(tx, boundary, "final", runtime.now());
		// 结束运行，结算输入为 done 并关联回答条目。
		endRun(tx, live, runtime.taskId, { status: "done", answer });
		// 有选中用户输入：立即启动下一个运行；first 是该运行的第一条记录。
		if (users.length > 0) await startRun(tx, conversationId, live, { inputs: users, first });
		// 完成结果返回回答条目 ID；即使启动了下一个运行，本任务仍以 completed 结束。
		return { status: "terminal", outcome: { status: "completed", result: { entryId: answer } } };
	}, context);
}

// endAnsweredCutOff 处理“已回答但 finish/drain 被切断到上限”的运行：仍以 completed 结束，不写失败。
/**
 * End a run that answered once its `finish` or `drain` phase was cut off `settings.restartLimit` times (spec §5.4):
 * the run answered, so it ends `completed`, without a failure and without the tasks it would still have waited for,
 * marked so the scheduler reports it `task_interrupted`. Queued items stay queued, as after a failed run.
 */
// 参数 answer 是已回答的条目；checkpoint.phase 只用于错误文本。
async function endAnsweredCutOff(
	runtime: Runtime,
	task: { readonly restarts?: number; readonly state: { readonly checkpoint: GenerationCheckpoint } },
	answer: EntryId,
	context: Context,
): Promise<void> {
	// 文本包含次数与相位；cutOffCount 生成 "once"/"N times"。
	const text = `The generation was interrupted ${cutOffCount(task)} in its ${task.state.checkpoint.phase} phase`;
	// 提交结束：读取 live，结束运行，返回 completed 并标记中断。
	await runtime.commit(async (tx): Promise<Next> => {
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		// endRun done：输入结算为 done，关联回答条目。
		endRun(tx, live, runtime.taskId, { status: "done", answer });
		// 先构造 completed 结果；随后 endedByCrashes 会附加提示信息。
		const completed: Next = { status: "terminal", outcome: { status: "completed", result: { entryId: answer } } };
		// endedByCrashes 修改结果，让调度器报告 task_interrupted；这是“完成但被切断”的标记。
		return endedByCrashes(completed, text);
	}, context);
}

// takesContinuation 决定回答后的 onYield 续写是否被采用：队列里不能有 steer/followUp，也不能有 reset。
/**
 * Whether an answer's `onYield` continuation is taken (spec §8.3), decided from the inbox before the final boundary
 * places anything: only when it holds no user item, of which the boundary would select one, and no reset, which would
 * otherwise run first. A continuation starts the turn count over.
 */
// 类型谓词：返回 true 时 continuation 从 UserInput | undefined 收窄为 UserInput。
function takesContinuation(continuation: UserInput | undefined, boundary: Boundary): continuation is UserInput {
	// 读取边界里的队列快照；此时还没有放置任何项。
	const items = boundary.inbox.items;
	return (
		// 必须有续写内容；没有则直接 false。
		continuation !== undefined &&
		// 队列中存在 steer/followUp 时，final 边界会选中它们；续写不能吞掉用户输入。
		!items.some((item) => item.mode === "steer" || item.mode === "followUp") &&
		// 排队的 reset 会开启新上下文；续写必须让位给重置。
		!hasQueuedReset(items)
	);
}

// startToolRound 追加工具调用回答并在同一提交里创建工具任务。
// 顺序轮次只立即启动第一个调用，其余进入 pending；未提供的工具会在槽位标记 unoffered，任务结算 tool_unavailable。
/**
 * Append the tool-calling answer and start its tool round in one commit (spec §8.3). Every call gets a tool task owned by
 * the generation, in call order, only the first one now when the round is sequential; a call to a tool the request did
 * not offer is flagged, and its task settles `tool_unavailable`. The generation then waits for them in its `tools`
 * phase, keeping the run.
 */
// request 提供上下文与 cutoff；calls 是分类阶段过滤出的工具调用。
async function startToolRound(
	runtime: Runtime,
	request: Request,
	message: AssistantMessage,
	calls: readonly ToolCall[],
	context: Context,
): Promise<void> {
	// 会话 ID 用于文档与任务作用域。
	const conversationId = runtime.conversationId;
	// 如果分类时没有传 messages，就按 cutoff 重新读取；?? 只在 undefined 时读取。
	const messages =
		request.messages ?? (await runtime.context(conversationId, context, { at: request.cutoff })).messages;
	// getCurrentTools 从上下文提取当前提供的工具名；Set 提供 O(1) 查找，用于识别未提供的调用。
	const offered = new Set(getCurrentTools(messages).map((tool) => tool.name));
	// Read as the round starts; a tool is resolved as its tool task resolves it.
	// 工具运行模式在回合开始时读取；工具任务执行时也会重新解析。
	const tools = (await runtime.agent(context)).tools;
	// 顺序条件：全局 sequential，或本轮任一已提供工具声明 executionMode "sequential"。
	const sequential =
		runtime.settings.toolExecution === "sequential" ||
		// 只检查已提供的调用；未提供的调用不会执行，也不影响顺序模式。
		calls.some(
			(call) =>
				offered.has(call.name) && tools.find((tool) => tool.name === call.name)?.executionMode === "sequential",
		);
	// 提交：追加助手条目、创建任务/槽位、更新运行轮数，然后等待。
	await runtime.commit(async (tx): Promise<Next> => {
		const live = await tx.doc(LiveDoc, conversationId);
		// 追加工具调用回答；工具结果稍后关联到这个条目。
		const entry = await appendAssistant(tx, conversationId, message);
		// slots 保存展示槽位；tools 保存已创建任务 ID；pending 保存顺序轮次尚未启动的调用 ID。
		const slots: ToolSlot[] = [];
		const tools: TaskId<ToolTaskResult>[] = [];
		const pending: string[] = [];
		// 按调用顺序遍历；每个调用都会得到一个槽位。
		for (const call of calls) {
			// unoffered 用条件展开：已提供时为 {}，未提供时为 { unoffered: true }；as const 保持字面量。
			const unoffered = offered.has(call.name) ? {} : ({ unoffered: true } as const);
			// 顺序轮次且已有任务：本调用先不创建任务，只记录到 pending。
			if (sequential && tools.length > 0) {
				pending.push(call.id);
				// pending 槽位没有 taskId，状态 pending；工具任务会在后续 tools 相位创建。
				slots.push({ callId: call.id, name: call.name, status: "pending", ...unoffered });
				continue;
			}
			// 非顺序或第一个调用：立即创建工具任务。
			const taskId = await createToolTask(tx, runtime, entry.id, call.id, unoffered.unoffered);
			tools.push(taskId);
			// 槽位记录 taskId 与 unoffered，状态 pending；执行时更新为 running/done。
			slots.push({ callId: call.id, name: call.name, taskId, status: "pending", ...unoffered });
		}
		// 生成已进入工具轮，删除 generation 展示字段。
		delete live.generation;
		// live.tools 保存本轮所有槽位，按调用顺序；生成等待它们。
		live.tools = slots;
		// 只有当前任务仍拥有运行时才更新轮数与 first。
		if (live.run?.taskId === runtime.taskId) {
			// A tool round is one turn of the run (`AgentState.maxTurns`).
			// 工具轮计为运行的一轮；maxTurns 用它限制循环。
			live.run.turns += 1;
			// A run its boundary started without placing anything, as a continue after an answer, begins here.
			// first 缺省时用本轮助手条目作为运行起点（运行可能从 continue 开始，之前没有放置条目）。
			live.run.first ??= entry.id;
		}
		// tools 检查点保存助手条目、已创建任务与待启动调用；等待集合只含已创建任务。
		const checkpoint = { phase: "tools", assistant: entry.id, tools, pending } as const;
		// allSettled：任务完成/失败/中止都会唤醒生成；顺序轮次会在下一次 tools 相位启动下一个。
		return { status: "waiting", checkpoint, on: tools, policy: "allSettled" };
	}, context);
}

// finishToolRound 收尾工具轮：读取结果与控制、应用 addTools/handoff、判断 terminate/turn_limit/reset，然后交棒或结束。
/**
 * The round's tools are terminal: apply their controls, append a `handoff`'s reset, and then end the run at the final
 * boundary (`terminate`), end it like a failure at the conversation's turn limit (`turn_limit`), end it at a queued
 * reset, or hand it to the next generation at the `postTools` boundary, in the handoff's new context when there is one
 * (spec §8.5).
 */
// 参数 assistant 是该轮助手条目；tools 是本轮创建的任务 ID，顺序与调用一致。
async function finishToolRound(
	runtime: Runtime,
	assistant: EntryId,
	tools: readonly TaskId<ToolTaskResult>[],
	context: Context,
): Promise<void> {
	// 会话 ID 用于文档/任务。
	const conversationId = runtime.conversationId;
	// controls 按任务 ID 保存工具结果里的控制指令；未完成/无控制的为 undefined。
	const controls = new Map<TaskId, ToolControl | undefined>();
	// runtime.outcomes 等待并返回所有工具任务结果，顺序与 tools 一致。
	const outcomes = await runtime.outcomes(tools, context);
	// 逐个映射；outcomes[index] 与 tools[index] 对应。
	tools.forEach((id, index) => {
		const outcome = outcomes[index]!;
		// Version 1 results have no kind; every result a generation's round reads is a model-issued call's.
		// 只有 completed 且不是 nested 的结果才有 ToolControl；nested 结果来自 executeTool，不影响运行控制。
		controls.set(
			id,
			outcome.status === "completed" && outcome.result.kind !== "nested" ? outcome.result.control : undefined,
		);
	});
	// 读取槽位快照；缺少文档时用空数组。
	const slots = (await runtime.snapshot(LiveDoc, conversationId, context))?.tools ?? [];
	// 每个已完成槽位可能写入 entry 字段（工具结果条目 ID）；flatMap 过滤 undefined。
	const results = slots.flatMap((slot) => (slot.entry === undefined ? [] : [slot.entry]));
	// afterTools 钩子看到助手条目与本轮结果 ID；它们可以观察但不能改分类。
	await runtime.hooks.each("afterTools", (hook) => hook(assistant, results, runtime, context));
	// In call order, the slots' order; a slot without a task (faulted or orphaned before it got one) has no control.
	// 按槽位顺序取控制；槽位可能没有 taskId（故障/孤儿），此时控制为 undefined。
	const ordered = slots.map((slot) => (slot.taskId === undefined ? undefined : controls.get(slot.taskId)));
	// Every call of the round must ask to terminate.
	// 只有所有调用都请求 terminate 才终止运行；空轮次不终止。
	const terminate = slots.length > 0 && ordered.every((control) => control?.terminate === true);
	// addTools 收集所有控制请求加载的工具名；后续在提交里写入 agent 状态。
	const added = ordered.flatMap((control) => control?.addTools ?? []);
	// The last handoff in call order wins.
	// handoff 取调用顺序中最后一个 handoff；它会触发 reset 并开启新上下文。
	const handoff = ordered.findLast((control) => control?.handoff !== undefined)?.handoff;
	// Read from the phase's agent, as every agent field; a `configure()` during the round applies at its end.
	// maxTurns 从本相位的 agent 读取；轮次中 configure() 的变更在回合末生效。
	const maxTurns = (await runtime.agent(context)).maxTurns;
	// terminate 且配置了 afterRun 时，运行需要保留等待钩子任务。
	const afterRun = terminate && (await asksAfterRun(runtime, context));
	// 提交：读边界、应用 addTools、处理 handoff、判断结束/限制/交棒。
	await runtime.commit(async (tx): Promise<Next> => {
		// 边界必须在第一次写之前读取；后面对 addTools/appendEntry 才是写。
		const boundary = await prepareBoundary(tx, conversationId, runtime.settings);
		// 把控制请求的工具名写入 agent 状态，让下一次请求提供它们。
		if (added.length > 0) await addTools(tx, conversationId, added);
		// 读取 live 草稿与当前时钟；所有条目时间戳一致。
		const live = await tx.doc(LiveDoc, conversationId);
		const now = runtime.now();
		// The run's last entry so far: the newest result, or the assistant when no result has an entry.
		// last 初始为最新工具结果或助手条目；handoff reset 会把它更新为新条目。
		let last = results.reduce((newest, id) => (id > newest ? id : newest), assistant);
		// handoff 存在：追加 reset 条目（head: "self"），让后续上下文从新消息开始。
		if (handoff !== undefined) {
			// The handoff's reset precedes every queued item, so queued writes and selected steers land in its context.
			// reset 的 model 是一条用户消息，内容是 handoff 文本。
			const message = { role: "user", content: handoff, timestamp: now } as const;
			// ResetEntry 的 head: "self" 表示新上下文从该条目自身开始；前面历史被切掉。
			const entry = await tx.appendEntry(ResetEntry, conversationId, { head: "self", model: [message] });
			// 更新边界 head，使随后放置的排队项相对于新上下文判断是否 stale。
			boundary.head = entry.id;
			// last 更新为 reset 条目，供 holdRun 的 RunSummary 使用。
			last = entry.id;
		}
		// 读取当前运行轮数；运行不属于本任务时按 0 处理。
		const turns = live.run?.taskId === runtime.taskId ? live.run.turns : 0;
		// 需要等待 afterRun：holdRun 结算输入、保留运行并进入 finish；reason 为 terminate。
		const held = afterRun ? holdRun(tx, live, runtime, { reason: "terminate", answer: assistant, last }) : undefined;
		if (held !== undefined) return held;
		// 所有调用请求终止：放置 final 边界、结束运行、可能启动下一个运行。
		if (terminate) {
			const { users, first } = await applyBoundary(tx, boundary, "final", now);
			endRun(tx, live, runtime.taskId, { status: "done", answer: assistant });
			if (users.length > 0) await startRun(tx, conversationId, live, { inputs: users, first });
			// 未终止但达到 maxTurns：按失败处理，afterFailedRun 决定队列；continue 可以稍后从工具结果恢复。
		} else if (maxTurns !== undefined && turns >= maxTurns) {
			// The turn limit ends the run like a failure: `afterFailedRun` decides the queued items, and a continue resumes
			// it on the round's results. The table was read for the boundary already, before any write.
			// 读取失败策略；continue 时复用已读边界，避免重复表读。
			const policy = runtime.settings.afterFailedRun;
			// 构造失败上下文；非 continue 不需要 boundary。
			const failure = { policy, ...(policy === "continue" ? { boundary } : {}) };
			// endFailedRun 结算为 turn_limit；detail 用单复数可读文本。
			await endFailedRun(tx, runtime, live, failure, {
				status: "unanswered",
				reason: "turn_limit",
				detail: turns === 1 ? "1 turn" : `${turns} turns`,
			});
			// 普通工具轮结束：在 postTools 边界放置 steer/write，然后交棒给下一个生成任务。
		} else {
			const { users, first, reset } = await applyBoundary(tx, boundary, "postTools", now);
			// reset 标志表示本次放置了重置条目；它会切断当前运行的上下文。
			if (reset) {
				// The queued reset cut the run's context before an answer.
				// 有 reset：当前运行无回答结束，原因 reset。
				endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "reset" });
				// reset 后仍有选中的用户输入：立即启动新运行；keepFailure 保留可能的失败展示。
				if (users.length > 0) {
					await startRun(tx, conversationId, live, { inputs: users, first }, { keepFailure: true });
				}
				// 没有 reset：删除本轮工具展示字段，准备交棒。
			} else {
				delete live.tools;
				delete live.nestedTools;
				// 把本次边界选中的用户提交加入当前运行的 inputs，让后继生成任务结算它们。
				if (live.run?.taskId === runtime.taskId) live.run.inputs.push(...users);
				// 创建后继生成任务并把运行控制权交出去；新任务从 request 相位重新读取上下文。
				handOver(live, runtime.taskId, await createGeneration(tx, conversationId));
			}
		}
		// 本任务以 completed 结束，结果仍是本轮助手条目；运行本身由后继任务继续。
		return { status: "terminal", outcome: { status: "completed", result: { entryId: assistant } } };
	}, context);
}

// appendAssistant 追加助手条目并记录模型用量；所有内置助手条目写入都必须经过这里，保证用量账本完整。
/**
 * Append a provider result and add its usage to `pi.usage` in the same commit.
 * REMINDER: every built-in writer of assistant entries goes through here, so the usage ledger stays complete.
 */
// 参数 message 是 provider 终态消息；返回带 ID 的条目记录。
async function appendAssistant(
	tx: Tx,
	conversationId: ConversationId,
	message: AssistantMessage,
): Promise<TypedEntry<never>> {
	// recordUsage 记录到 pi.usage 的 models 桶，键为 provider/model；usage 可能含缓存/推理等可选计数。
	await recordUsage(tx, conversationId, "models", `${message.provider}/${message.model}`, message.usage);
	// 追加 AssistantEntry；model 数组包含这条消息。
	return tx.appendEntry(AssistantEntry, conversationId, { model: [message] });
}

// startRun 为已放置的输入启动新运行：创建生成任务、写入 pi.live.run，并清除旧的 runFailure（除非 keepFailure）。
/**
 * Start a run for `inputs`, placed input submissions, whose first entry is `first` (`LiveRun.first`): a new generation
 * takes `pi.live.run`. Removes `runFailure`, unless `keepFailure`: a run started in the commit that ended the failed one
 * keeps its failure.
 */
// inputs 是已放置的 submission ID；first 是运行第一条记录，可能 undefined（边界没有放置条目）。
export async function startRun(
	tx: Tx,
	conversationId: ConversationId,
	live: Draft<LiveState>,
	run: { readonly inputs: SubmissionId[]; readonly first: EntryId | undefined },
	options?: { readonly keepFailure?: boolean },
): Promise<void> {
	// 解构输入与起点。
	const { inputs, first } = run;
	// 创建生成任务；submissionIds 让任务记录关联这些提交，便于取消/结算。
	const taskId = await createGeneration(tx, conversationId, { submissionIds: inputs });
	// 写入运行状态：turns 从 0 开始；first 缺省时省略字段。
	live.run = { taskId, inputs, turns: 0, ...(first === undefined ? {} : { first }) };
	// 新运行默认清除上次失败；同一提交内启动后继运行时可保留。
	if (options?.keepFailure !== true) delete live.runFailure;
}

// createGeneration 创建一个归会话所有的生成任务；它不带输入，运行状态在 pi.live.run。
/** A generation owned by its conversation. */
// telemetry 目前只含 submissionIds；展开到 createTask 选项。
function createGeneration(
	tx: Tx,
	conversationId: ConversationId,
	telemetry: Pick<TaskCreationOptions, "submissionIds"> = {},
): Promise<TaskId<GenerationResult>> {
	// ownership conversation 表示任务由会话拥有，不阻塞某个父任务；会话关闭时会级联取消。
	return tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId, ...telemetry });
}

// handOver 把运行控制权从 from 交给 to；只有运行仍属于 from 时才更新，避免覆盖已接管的运行。
/** Hand run control from `from` to `to`; the run's inputs move with it. */
export function handOver(live: Draft<LiveState>, from: TaskId, to: TaskId): void {
	// 只替换 taskId；运行对象原样保留 inputs/turns/first。
	if (live.run?.taskId === from) live.run.taskId = to;
}
