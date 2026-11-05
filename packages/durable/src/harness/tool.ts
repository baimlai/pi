// Durable 内置工具任务：把模型或嵌套调用解析成工具、校验参数、执行并结算，同时维护 pi.live 槽位与嵌套调用文档。
// 所属：packages/durable/src/harness（Harness 的任务层实现）。
// 上游：scheduler/runtime 提供 TaskRuntime（commit、memo、agent、env、hooks、signal、restart 计数、ownedTasks 等）；
//   agent.ts 提供解析后的 Registry/Agent；live.ts 提供 LiveDoc 槽位与 PROGRESS_COMMIT；entries.ts 写入 tool result 条目；
//   chord 提供 OutputBuffer/Progress/boundOutput/copyJson/overlap 等基础设施；pi-ai 提供 ToolCall/ToolResultMessage 与参数校验。
// 下游：模型发起的调用在 transcript 追加 pi.tool-result 条目；嵌套调用把结果写入父任务的 NestedCallDoc 并返回回执；
//   pi.usage 记录工具产生的 usage；pi.live.tools / pi.live.nestedTools 提供运行中展示；失败/中止/中断路径生成 error 结果。
// 职责边界：本文件负责任务级流程与结果规范化；不负责调度、不实现具体工具、不定义输出截断算法（chord 的 output 模块），
//   也不决定重试上限（settings.restartLimit 与 live.ts 的 cutOff 判定共同决定）。
// 能力清单：
// - ToolTaskInput / ToolTaskCheckpoint / ToolTaskResult：pi.tool 任务的输入、持久化检查点与终态回执。
// - NestedCallState / NestedCallDoc：嵌套调用按 key 存储的 taskId 与结果文档。
// - ToolTask：内置任务定义（name "pi.tool"，version 3），含 call/execute/abort 三个阶段。
// - harnessError：构造 Harness 自己生成的 error 结果。
// - appendToolResult：把结果写成 pi.tool-result 条目，并在同一提交记录 usage。
// 内部机制：run() 构造 ToolExecutionApi、节流发布进度；finalResult() 合并输出/details/diagnostics、执行 afterTool、
//   校验 structuredOutput；settle() 统一中止遗留嵌套调用并提交终态；startNestedCall() 保证重跑按 key 复用嵌套调用。
// 典型调用顺序：调度器运行 ToolTask.call → readCall/resolveTool/prepare/validate → beforeTool → 提交 intent →
//   run(execute) → finalResult(afterTool) → settle → 终态提交；崩溃后从 execute 阶段按 replay 策略恢复或生成 interrupted。
// 示例（真实签名）：
//   const task = defineTask<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult, ToolHooks>({ name: "pi.tool", version: 3, ... });
//   const result = harnessError("invalid_arguments", "Expected an object");
// 建议阅读顺序：先 ToolTaskInput/Checkpoint/Result 与 NestedCallDoc，再 ToolTask 的 call 阶段，随后 run 与 ToolExecutionApi，
//   最后 finalResult/afterHarnessResult、settle/startNestedCall 以及输出和 JSON 小工具。
import { awaitWithContext, type Context } from "@earendil-works/chord/context";
import { type Draft, overlap, ownedSlice } from "@earendil-works/chord/delta";
import { copyJson, type JsonRepresentation, type JsonValue } from "@earendil-works/chord/json";
import {
	boundOutput,
	OutputBuffer,
	type OutputLimits,
	PROGRESS_BYTES_PER_SECOND,
	Progress,
	type ProgressClock,
} from "@earendil-works/chord/output";
import type { ImageContent, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { compile, type Validator } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { defineDocFamily } from "../documents.ts";
import { AssistantEntry, ToolResultEntry } from "../entries.ts";
import type { ExecutionEnv } from "../env/index.ts";
import { errorMessage } from "../errors.ts";
import { defineTask } from "../tasks.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, utf8ByteLength } from "../truncate.ts";
import type {
	ConversationId,
	EntryId,
	JsonObject,
	Task,
	TaskId,
	TaskOptions,
	TaskOutcome,
	TaskRuntime,
	Tx,
	TypedEntry,
} from "../types.ts";
import { toolExtension } from "./agent.ts";
import { assignJson } from "./json.ts";
import {
	clearProgress,
	cutOffCount,
	cutOffTooOften,
	finishSlot,
	LiveDoc,
	type NestedToolSlot,
	type NestedToolSummary,
	PROGRESS_COMMIT,
	removeNestedSlots,
	salvageable,
	type ToolSlot,
	toolSlot,
} from "./live.ts";
import type {
	NestedToolExecutionResult,
	ToolControl,
	ToolDiagnostic,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolHookCall,
	ToolHooks,
	ToolRegistration,
} from "./types.ts";
import { recordUsage } from "./usage.ts";
import { optionalExtension } from "./util.ts";

/**
 * A model-issued call, read from its assistant entry, or a nested call a running tool made through `executeTool()`,
 * whose call the input carries because no entry holds it.
 */
// pi.tool 的两种输入：model 从 assistant 条目里按 callId 找到调用；nested 直接携带调用（不写入 transcript）。
export type ToolTaskInput =
	| {
			kind: "model";
			// 包含该 toolCall 的 assistant 条目；call 阶段读取其 model[0]。
			assistant: EntryId;
			// 模型生成的调用 ID，用于在该条目的 content 中定位 ToolCall。
			callId: string;
			/** A call to a tool its request did not offer: settles `tool_unavailable` without resolving the name. */
			// 请求未向模型提供该工具：不解析名字，直接以 tool_unavailable 结算，避免暴露未提供工具的信息。
			unoffered?: true;
	  }
	| {
			kind: "nested";
			// 发起嵌套调用的父工具任务。
			parent: TaskId;
			// 父调用 ID；嵌套调用的完整 ID 为 `<parentCallId>/<key>`。
			parentCallId: string;
			// 嵌套调用在父调用内的键，用于重跑复用；默认是本次调用中的序号。
			key: string;
			// 调用本身（id/name/arguments），由 executeTool() 构造。
			call: ToolCall;
			/** `false`: commit no running output, details, or diagnostics to the slot; the result still gets them. */
			// false 时不把运行中输出/details/诊断写入 pi.live 槽位，只保留最终结果。
			progress?: false;
	  };

// 检查点：call 表示尚未记录最终参数与重跑策略；execute 表示 intent 已持久化，参数和 replay 已固定。
export type ToolTaskCheckpoint =
	| { phase: "call" }
	/** Durable intent: the final arguments and the replay policy recorded before execution. */
	// execute 阶段：最终参数（经过修复/校验/hook）与 replay 策略已提交，崩溃后据此决定是否重跑。
	| { phase: "execute"; arguments: JsonObject; replay: "safe" | "unsafe" };

/**
 * A model-issued call's result is its transcript entry; a nested call's result is in its caller's
 * `NestedCallDoc`, so the receipt stays small and the result retires with the caller. A version 1 task that was
 * already holding its outcome as `completing` when the Harness upgraded finishes with a version 1 result,
 * `{ entryId, control? }` without `kind`; treat a result without `kind` as a model-issued call's.
 */
// 任务终态回执：model 只记录结果条目 ID（及可选 control）；nested 只记录 kind，真实结果在父任务的 NestedCallDoc 里。
export type ToolTaskResult = { kind: "model"; entryId: EntryId; control?: ToolControl } | { kind: "nested" };

/**
 * Memo of a tool task that made a nested call, in any attempt, committed before the first admission of each attempt:
 * only then can `pi.live` hold slots below it, which settling removes. A crash between the two only costs a scan.
 */
// 任务级 memo 键：本次工具调用（跨尝试）是否做过嵌套调用。首次接纳嵌套调用前写入，settle 据此决定是否扫描并清理槽位。
const MADE_NESTED_CALLS = "pi.tool.madeNestedCalls";

/** One nested call of a running tool: its task, and once it ended, its result. */
// 一个嵌套调用的持久状态：创建提交内 taskId 可能暂缺；运行中 result 缺失；调度器 faulted/orphaned 时也可能没有 result。
export type NestedCallState = {
	/** Absent only inside the commit that creates the call; a creation that fails leaves no member. */
	// 仅在创建该调用的提交内可能缺失；创建失败则不会留下这个文档成员。
	taskId?: TaskId<ToolTaskResult>;
	/** Exactly what `executeTool()` returns; absent while running, and for a call the scheduler faulted or orphaned. */
	// 与 executeTool() 的返回值完全一致；运行中、faulted 或 orphaned 时缺失，调用方用 fallbackResult 兜底。
	result?: JsonRepresentation<NestedToolExecutionResult>;
};

/**
 * The nested calls of a tool call, a task-scoped family of the calling task keyed by the nested call's key: so a rerun
 * finds the calls it already made, and the caller reads each result. Created with the nested task; the nested call's
 * terminal commit adds its result. One document per call, so no commit rewrites the others. Retires with the caller.
 */
// 嵌套调用索引：按父任务作用域、以 key 为成员名；每个调用一份文档，终态提交只改自己，调用方结束即整体退休。
export const NestedCallDoc = defineDocFamily<NestedCallState, null>({
	kind: "pi.tool.nested-call",
	version: 1,
	scope: "task",
	family: true,
	initial: () => ({}),
	// The document retires with its task.
	// 父任务终态时不保留检查点，文档随任务退休。
	checkpointWhen: () => false,
});

type Runtime = TaskRuntime<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult, ToolHooks>;
type Content = (TextContent | ImageContent)[];

/**
 * Built-in tool task: resolves the called tool among its phase agent's tools, validates, runs `beforeTool`, records intent,
 * executes, runs `afterTool`, and settles the result, all in one `call` handler so nothing separates resolution from
 * settlement. `execute` is reached only by recovery and applies the replay rule. A model-issued call settles by
 * appending its result entry; a nested call by writing its result to its caller's `NestedCallDoc`.
 */
// 内置 pi.tool 任务：正常路径全部在 call 阶段完成；execute 仅供崩溃恢复，按 replay 策略决定重跑或生成 interrupted。
export const ToolTask = defineTask<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult, ToolHooks>({
	name: "pi.tool",
	version: 3,
	initial: () => ({ phase: "call" }),
	// Version 1 had only model-issued calls, without `kind`; version 3 added `unoffered`, absent in version 2 inputs.
	// 迁移：v1 输入补 kind:"model"；v2→v3 输入形状兼容，直接按 ToolTaskInput 读取（unoffered 为可选）。
	migrate: (input, checkpoint, fromVersion) => ({
		input:
			fromVersion === 1
				? { kind: "model", ...(input as { assistant: EntryId; callId: string }) }
				: (input as ToolTaskInput),
		checkpoint: checkpoint as ToolTaskCheckpoint,
	}),
	phases: {
		call: async (task, runtime, context) => {
			// 先定位调用本身：nested 来自输入，model 来自 assistant 条目；找不到调用是数据损坏，直接抛错。
			const call = await readCall(runtime, task.input, context);
			// 连续被切断达到 restartLimit 时不再执行，转而从槽位重建结果并结束。
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, call, context);
			// 未提供的调用不解析工具；否则在 model 的 offered tools 或 tools 的 callable 集合中按名字查找。
			const tool = isUnoffered(task.input) ? undefined : await resolveTool(runtime, task.input, call.name, context);
			if (tool === undefined) {
				// 解析失败也生成正常的 tool 结果（错误诊断），让模型/调用方看到原因。
				const error = harnessError("tool_unavailable", `Tool ${call.name} is not available`);
				return reject(runtime, task.input, call, undefined, error, context);
			}
			// 第一步：可选的 prepareArguments 修复常见参数错误；返回 error 表示修复函数抛错。
			const prepared = prepare(tool, call.arguments as JsonObject);
			// 修复成功后再做 schema 校验与类型强制；两步任一失败都以 invalid_arguments 结算。
			const checked = "error" in prepared ? prepared : validate(tool, call, prepared.args);
			if ("error" in checked) return reject(runtime, task.input, call, tool, invalid(checked.error), context);
			let args = checked.args;
			let block: string | undefined;
			// beforeTool 按注册顺序串行执行；第一个 block 生效，arguments 可在后续 hook 前被替换。
			await runtime.hooks.each("beforeTool", async (hook) => {
				// 已有 block 时不再运行后续 hook（each 仍会遍历，但这里立即返回）。
				if (block !== undefined) return;
				try {
					const decision = await hook({ ...call, arguments: args }, runtime, context);
					if (decision?.block !== undefined) block = decision.block;
					else if (decision?.arguments !== undefined) args = decision.arguments;
				} catch (error) {
					// 中止是控制流，向上抛；其他 hook 抛错等同阻塞，消息作为原因。
					if (runtime.signal.aborted) throw error;
					block = errorMessage(error);
				}
			});
			if (block !== undefined) {
				// block 结果同样是正常工具结果，afterTool 仍可看到。
				const blocked = harnessError("blocked", `Tool call blocked: ${block}`);
				return reject(runtime, task.input, call, tool, blocked, context);
			}
			// hook 可能改动参数，因此替换后必须重新校验。
			const validated = validate(tool, call, args);
			if ("error" in validated) return reject(runtime, task.input, call, tool, invalid(validated.error), context);
			// Strict JSON: repair may set optional properties to undefined, which the slot and checkpoint cannot hold.
			// 去掉值为 undefined 的字段：槽位/检查点要求严格 JSON，不能存 undefined。
			const final = copyJson(validated.args, { omitUndefinedProperties: true }) as JsonObject;
			// The slot's status and arguments are presentation, stored like progress (`PROGRESS_COMMIT`); the intent is
			// durable before the tool runs. Parallel calls of one round then share no immediate write to `pi.live`.
			// 先用延迟提交更新展示槽位：状态 running，嵌套槽位同步最终参数；并行工具因此不会各自立即写 pi.live。
			await runtime.commit(
				async (tx) => {
					const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
					if (slot !== undefined) slot.status = "running";
					// A nested slot shows the arguments the call runs with, which repair, hooks, and coercion may have changed.
					// Assigned whole: an equal value records no change, and a rerun corrects what an earlier attempt showed.
					// 嵌套槽位显示实际执行参数；整体赋值，相等值不会产生 diff。
					if (slot !== undefined && "parentTaskId" in slot) slot.arguments = final;
					return undefined;
				},
				context,
				PROGRESS_COMMIT,
			);
			// intent 提交是同步立即持久化的：参数与 replay 策略在工具运行前落盘，崩溃后才能判断能否重跑。
			await runtime.commit(() => {
				const intent = { phase: "execute", arguments: final, replay: tool.replay ?? "unsafe" } as const;
				return { status: "running", checkpoint: intent };
			}, context);
			// 真正执行并结算；run 内部负责 afterTool、输出限制与终态提交。
			await run(runtime, task.input, call, tool, final, context);
		},
		/** Recovery after intent: rerun only when the stored and the current policy both say `safe`. */
		// 恢复入口：检查点里存有参数和当时的 replay 策略；只有“当时 safe 且当前定义仍 safe”才重跑。
		execute: async (task, runtime, context) => {
			const { arguments: args, replay } = task.state.checkpoint;
			// 重新读取调用；model 调用仍从 assistant 条目取，nested 调用在输入里。
			const call = await readCall(runtime, task.input, context);
			// Also before an interruption result: its `afterTool` hooks may be what cut the task off.
			// 生成 interrupted 结果前也要检查上限，因为 afterTool 本身可能正是反复切断任务的原因。
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, call, context);
			// 用当前注册表重新解析工具；定义可能已升级或消失。
			const tool = await resolveTool(runtime, task.input, call.name, context);
			if (replay === "safe" && tool?.replay === "safe") {
				// The rerun reports from scratch: clear what the interrupted attempt published, and show the slot running with
				// the arguments it runs with again, as the deferred commit that showed them may have been lost with the crash.
				// 重跑从零报告：清空上次尝试发布的输出/诊断，槽位恢复 running；上次的延迟展示提交可能已随崩溃丢失。
				await runtime.commit(async (tx) => {
					const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
					if (slot !== undefined) {
						clearProgress(slot);
						slot.status = "running";
						if ("parentTaskId" in slot) slot.arguments = args;
					}
					return undefined;
				}, context);
				return run(runtime, task.input, call, tool, args, context);
			}
			// 不满足双 safe：不重跑，从槽位已有的部分输出重建 interrupted 错误结果。
			const message = `Tool ${call.name} was interrupted and may have partially run`;
			// `failed` records cancellation intent, so the call's owned conversations, left unsupervised, are aborted.
			// failed 记录“取消其自有工作”的意图，避免重启后遗留无人监管的子会话。
			const ending = { status: "failed", message } as const;
			// Not cut off too often (checked above), so the hooks run.
			// 未超过上限，允许 afterTool 处理这个中断结果。
			await settleFromSlot(runtime, task.input, call, { tool }, ending, "interrupted", message, context);
		},
	},
	abort: async (task, runtime, context) => {
		// 中止处理器无法再被中止；读取调用信息用于结果文本。
		const call = await readCall(runtime, task.input, context);
		// Abandoned after a restart (`TaskOptions.abandonOnRestart`): say whether the call may have run. An unoffered call
		// could not run in any case, and its result says so.
		// 按情况选择诊断码：未提供工具 → tool_unavailable；显式中止 → aborted；
		// 重启中断且已进入 execute → interrupted（可能已部分运行）；尚未执行 → abandoned。
		const [code, message] = isUnoffered(task.input)
			? ["tool_unavailable", `Tool ${call.name} is not available`]
			: task.abortReason !== "restart"
				? ["aborted", `Tool ${call.name} was aborted`]
				: task.state.checkpoint.phase === "execute"
					? ["interrupted", `Tool ${call.name} was interrupted by a restart and may have partially run`]
					: ["abandoned", `Tool ${call.name} was not started: its caller ended with a restart`];
		// The scheduler runs an abort handler only while its restarts are below the limit, and faults the task without a
		// result when the last attempt is cut off. That attempt skips the hooks, which may be what cuts it off.
		// 最后一次尝试可能不给中止处理器；能运行时，只在 restarts 严格小于 limit-1 时才运行 afterTool，
		// 避免 hook 本身成为反复切断的原因。
		const hooks =
			(task.restarts ?? 0) < runtime.settings.restartLimit - 1
				? { tool: await toolForLimits(runtime, task.input, call.name, context) }
				: undefined;
		await settleFromSlot(runtime, task.input, call, hooks, { status: "aborted" }, code, message, context);
	},
});

/**
 * End a call cut off `settings.restartLimit` times in a row (spec §5.4) with an error result, built from the slot like
 * an interrupted call's, instead of running it again. `failed`, like an interruption, so its owned work is aborted.
 */
// 达到重启上限：不重跑，从槽位现有部分输出构造 restart_limit 错误结果，并以 failed 结束（取消其自有工作）。
async function endCutOff(
	runtime: Runtime,
	task: { readonly restarts?: number; readonly input: ToolTaskInput },
	call: ToolHookCall,
	context: Context,
): Promise<void> {
	const message = `Tool ${call.name} was interrupted ${cutOffCount(task)}; it is not run again`;
	// 显式 reason 让终态 faulted/settled 记录 restart_limit；结果码同名。
	const ending = { status: "failed", message, reason: "restart_limit" } as const;
	// Past the limit the hooks may be what keeps cutting the task off (`salvageable`).
	// 恰好在 limit 时仍可做收尾（afterTool）；超过 limit 则跳过，因为 hook 可能正是切断原因。
	const hooks = salvageable(task, runtime)
		? { tool: await toolForLimits(runtime, task.input, call.name, context) }
		: undefined;
	await settleFromSlot(runtime, task.input, call, hooks, ending, "restart_limit", message, context);
}

/**
 * Settle a result the Harness decided in the `call` phase, without running the tool: the tool did not resolve, the
 * arguments are invalid, or `beforeTool` blocked the call. `afterTool` applies as to an executed call's result.
 */
// call 阶段由 Harness 生成的错误结果（unavailable/invalid/blocked）：仍经过 afterTool，并以 completed 结束。
async function reject(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	tool: ToolRegistration | undefined,
	result: ToolExecutionResult,
	context: Context,
): Promise<void> {
	// truncation 为 undefined：结果不是从槽位重建，没有先前输出被丢弃。
	const settled = await afterHarnessResult(runtime, input, call, tool, result, undefined, context);
	await settle(runtime, input, call, COMPLETED, settled, context);
}

/**
 * Settle an error result built from the call's slot (`fromSlot`): an interruption, the restart limit, or an abort.
 * The tool is not running, so the slot read before the commit is still current when it commits. With `hooks`, the
 * result passes `afterTool` and is bounded with the limits of `hooks.tool` (the defaults when it is `undefined`);
 * without, it is settled as built, when the hooks may be what cuts the task off.
 */
// 从中断/中止/重启上限场景结算：读取 pi.live 槽位 → 重建 error 结果 → 可选 afterTool → 提交终态。
async function settleFromSlot(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	hooks: { readonly tool: ToolRegistration | undefined } | undefined,
	ending: Ending,
	code: string,
	message: string,
	context: Context,
): Promise<void> {
	// 快照读取：工具已不在运行，所以提交时槽位不会因工具写入而变化。
	const live = await runtime.snapshot(LiveDoc, runtime.conversationId, context);
	// 槽位可能已被清理（例如任务被调度器 orphaned），fromSlot 会用空输出兜底。
	const { result, truncation } = fromSlot(
		live === undefined ? undefined : toolSlot(live, runtime.taskId),
		code,
		message,
	);
	// 运行 hook 时截断诊断由 afterHarnessResult 处理；不运行 hook 时原样结算，无截断就返回结果，有则直接追加诊断。
	const settled =
		hooks !== undefined
			? await afterHarnessResult(runtime, input, call, hooks.tool, result, truncation, context)
			: truncation === undefined
				? result
				: { ...result, diagnostics: [...(result.diagnostics ?? []), truncation] };
	await settle(runtime, input, call, ending, settled, context);
}

/**
 * The tool whose output limits bound a hooks' result: the called tool, or none when it, or the agent, fails to resolve,
 * and for an unoffered call, which never resolves its name.
 */
// 只为确定输出限制而解析工具；解析失败/未提供时返回 undefined，随后使用默认限制。
async function toolForLimits(
	runtime: Runtime,
	input: ToolTaskInput,
	name: string,
	context: Context,
): Promise<ToolRegistration | undefined> {
	if (isUnoffered(input)) return undefined;
	return resolveTool(runtime, input, name, context).catch(() => undefined);
}

/** A model-issued call to a tool its request did not offer (spec §8.3). */
// 判断是否为“模型调用了请求未提供的工具”的特殊输入。
function isUnoffered(input: ToolTaskInput): boolean {
	return input.kind === "model" && input.unoffered === true;
}

/** The called tool: among the tools the model is offered for a model-issued call, else among those tools may call. */
// 模型调用只在 Agent.tools（已提供给模型的工具）中查找；嵌套调用只在 Agent.callable（callers 含 tools）中查找。
async function resolveTool(
	runtime: Runtime,
	input: ToolTaskInput,
	name: string,
	context: Context,
): Promise<ToolRegistration | undefined> {
	const agent = await runtime.agent(context);
	return (input.kind === "model" ? agent.tools : agent.callable).find((tool) => tool.name === name);
}

/** The tool's output limits, the defaults filled in; all defaults when the tool did not resolve. */
// 合并工具的输出限制与默认值；工具未解析时全部用默认值。
function outputLimits(tool: ToolRegistration | undefined): OutputLimits {
	return {
		maxBytes: tool?.outputLimits?.maxBytes ?? DEFAULT_MAX_BYTES,
		maxLines: tool?.outputLimits?.maxLines ?? DEFAULT_MAX_LINES,
		retain: tool?.outputLimits?.retain ?? "head",
	};
}

/** The call: from the input for a nested call, which hooks see with its parent, else from the assistant entry. */
// 读取调用并补上钩子可见的 parent 信息；同时设置遥测属性 tool.name/tool.call_id。
async function readCall(runtime: Runtime, input: ToolTaskInput, context: Context): Promise<ToolHookCall> {
	if (input.kind === "nested") {
		context.telemetry.setAttributes({
			"tool.name": input.call.name,
			"tool.call_id": input.call.id,
		});
		// 嵌套调用的 ToolCall 在输入里；补 parent 让 beforeTool/afterTool 能识别来源。
		return { ...input.call, parent: { taskId: input.parent, callId: input.parentCallId } };
	}
	// 模型调用：读取 assistant 条目的 model[0]，在其 content 中按 ID 找到 toolCall。
	const entry = await runtime.entry(AssistantEntry, input.assistant, context);
	const message = entry?.model?.[0];
	const call =
		message?.role === "assistant"
			? message.content.find(
					(content): content is ToolCall => content.type === "toolCall" && content.id === input.callId,
				)
			: undefined;
	// 条目缺失、角色不符或找不到 callId 都属于持久化数据不一致，无法生成有意义的工具结果。
	if (call === undefined) throw new Error(`Entry ${input.assistant} has no tool call ${input.callId}`);
	context.telemetry.setAttributes({
		"tool.name": call.name,
		"tool.call_id": call.id,
	});
	return call;
}

/** Arguments, or why they are invalid. */
// 参数修复/校验的结果：成功给 args，失败给 error 文本。
type Checked = { readonly args: JsonObject } | { readonly error: string };

/** The call's arguments as repaired by the tool; a throwing repair makes them invalid. */
// 调用 prepareArguments 修复参数；未定义则原样返回；抛错转为 invalid_arguments 文本。
function prepare(tool: ToolRegistration, args: JsonObject): Checked {
	if (tool.prepareArguments === undefined) return { args };
	try {
		return { args: tool.prepareArguments(args) as JsonObject };
	} catch (error) {
		return { error: errorMessage(error) };
	}
}

/** Arguments validated and coerced against the implementation's schema. */
// 用工具 schema 校验并强制类型（pi-ai validateToolArguments）；抛错转成 invalid_arguments 文本。
function validate(tool: ToolRegistration, call: ToolCall, args: JsonObject): Checked {
	try {
		return { args: validateToolArguments(tool, { ...call, arguments: args }) as JsonObject };
	} catch (error) {
		return { error: errorMessage(error) };
	}
}

// 参数无效的便捷构造：统一诊断码 invalid_arguments。
function invalid(message: string): ToolExecutionResult {
	return harnessError("invalid_arguments", message);
}

/** What a running tool reported through its api: output, the last details, and diagnostics. */
// 运行期报告汇总：输出缓冲、输出限制、诊断列表，以及最后一次 details；finalResult 会把这些合并进最终结果。
type Reported = {
	readonly output: OutputBuffer;
	readonly limits: OutputLimits;
	readonly diagnostics: ToolDiagnostic[];
	details: JsonValue | undefined;
};

/** Execute with the resolved implementation, then settle its result. */
// 执行已解析的工具：构造 ToolExecutionApi、节流发布进度、处理 abort/throw、执行 afterTool，最后提交终态。
async function run(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	tool: ToolRegistration,
	args: JsonObject,
	context: Context,
): Promise<void> {
	// 输出限制在本次执行内固定；工具定义不会在运行中变化。
	const limits = outputLimits(tool);
	const reported: Reported = { output: new OutputBuffer(limits), limits, diagnostics: [], details: undefined };
	// 模型调用总是发布进度；嵌套调用仅在 progress 未显式关闭时发布。
	const streams = input.kind === "model" || input.progress !== false;
	const progress = publishProgress(runtime, reported, streams, context);
	/** Nested call admissions this invocation started; cleanup waits for them, so it sees every nested call. */
	// 本次调用发起的嵌套接纳 Promise：结算前全部等待，确保能看到并中止所有已创建的嵌套调用。
	const admissions: Promise<unknown>[] = [];
	// A caller that can rerun reattaches to its nested calls and child tasks after a restart; any other caller never
	// resumes, so they are abandoned (`TaskOptions.abandonOnRestart`).
	// 只有 replay safe 的父工具会在重启后恢复，因此只有它需要重新挂接子任务；其他父工具的子调用重启即放弃。
	const resumes = tool.replay === "safe";
	/** Default keys: the order of this invocation's calls, so a rerun that calls in the same order reattaches. */
	// 默认 key 从 1 递增，按本次调用中 executeTool 的调用顺序生成，重跑顺序一致即可复用。
	let sequence = 0;
	/** This attempt's commit of the `MADE_NESTED_CALLS` memo. */
	// 本次尝试写入 MADE_NESTED_CALLS memo 的 Promise；失败时清空，下一次 executeTool 会重试。
	let madeNestedMemo: Promise<unknown> | undefined;
	// execute() 返回后置为 true，之后 api 的任何操作都抛错，避免结果结算后还有异步写入。
	let ended = false;
	const assertLive = (): void => {
		if (ended) throw new Error(`Tool call ${call.id} has settled`);
	};
	/** Built for this call, below, so a rerun after recovery gets the conversation's environment at that time. */
	// env 延迟到 execute 前构建；恢复重跑会重新调用 runtime.env，看到当时的会话配置。
	let env: ExecutionEnv | undefined;
	const api: ToolExecutionApi = {
		// 任务/会话/调用标识。
		taskId: runtime.taskId,
		conversationId: runtime.conversationId,
		callId: call.id,
		// 本阶段固定的注册表快照与 Agent 解析函数。
		registry: runtime.registry,
		agent: runtime.agent,
		// models 每次访问都取当前值。
		get models() {
			return runtime.models;
		},
		// env 在下方 execute 前赋值，getter 保证工具总看到同一个实例。
		get env() {
			return env;
		},
		now: () => runtime.now(),
		output: (chunk, skipped) => {
			assertLive();
			// OutputBuffer 返回 true 表示内容/截断信息有变化，需要触发进度提交。
			if (reported.output.push(chunk, skipped)) progress.mark();
		},
		// 只有保留尾部时才暴露滑动窗口配置；保留头部无法接受 skipped（跳过的文本无法通过头部窗口表达）。
		outputWindow:
			limits.retain === "tail"
				? {
						maxBytes: limits.maxBytes,
						maxLines: limits.maxLines,
						minIntervalMs: runtime.settings.progress.outputIntervalMs,
						bytesPerSecond: PROGRESS_BYTES_PER_SECOND,
					}
				: undefined,
		retainedOutput: () => {
			assertLive();
			const retained = reported.output.snapshot();
			// truncated 只看是否丢弃过字节；行数丢弃也必然伴随字节丢弃。
			return { text: retained.text, truncated: retained.droppedBytes > 0 };
		},
		diagnostic: (diagnostic) => {
			assertLive();
			// 复制成严格 JSON（去掉 undefined 字段），避免工具之后修改对象影响已发布诊断。
			reported.diagnostics.push(copyJson(diagnostic, { omitUndefinedProperties: true }) as ToolDiagnostic);
			progress.mark();
		},
		details: async (value, detailsContext) => {
			assertLive();
			// 先响应取消：调用方取消时不写入新 details。
			detailsContext.abortSignal?.throwIfAborted();
			reported.details = copyJson(value, { omitUndefinedProperties: true });
			// 等待下一次进度提交把 details 写入槽位；提交失败仍需被观察，因此先挂 catch。
			const committed = progress.markAndWait();
			// Cancelling the wait leaves the update in place; the commit's own outcome stays observed.
			// 只取消等待，不撤销已安排的提交；用 awaitWithContext 把取消传给调用方。
			committed.catch(() => {});
			return awaitWithContext(committed, detailsContext);
		},
		commit: async (change, commitContext, options) => {
			let result: Awaited<ReturnType<typeof change>> | undefined;
			// runtime.commit 的回调返回值表示任务检查点/状态；这里包一层，把 change 的返回单独捕获。
			await runtime.commit(
				async (tx) => {
					result = await change(tx);
					return undefined;
				},
				commitContext,
				options,
			);
			return result as Awaited<ReturnType<typeof change>>;
		},
		// memo 直接复用任务级实现（钩子与任务共享 memo）。
		memo: runtime.memo,
		createTask: async <I, S extends { phase: string }, R, H extends object>(
			task: Task<I, S, R, H>,
			input: I,
			options: Omit<TaskOptions, "conversationId">,
			taskContext: Context,
		): Promise<TaskId<R>> => {
			// 父工具不重跑时，其任务所有权子任务默认 abandonOnRestart；调用方显式选项优先。
			const child = options.ownership.kind === "task" && !resumes ? { abandonOnRestart: true, ...options } : options;
			let id: TaskId<R> | undefined;
			// 单独提交创建任务，返回 ID。
			await runtime.commit(async (tx) => {
				id = await tx.createTask(task, input, child);
				return undefined;
			}, taskContext);
			return id!;
		},
		getTask: runtime.getTask,
		waitForTask: runtime.waitForTask,
		conversation: runtime.conversation,
		// DocumentObserver/DocumentReader 的方法直接委托给运行时。
		snapshot: runtime.snapshot,
		snapshotAsOf: runtime.snapshotAsOf,
		watchDoc: runtime.watchDoc,
		executeTool: async (name, toolArgs, callContext, options = {}) => {
			assertLive();
			// 默认 key 是本次调用内的序号；显式 key 需先通过格式检查，避免与默认 key/路径分隔冲突。
			const key = options.key ?? String(++sequence);
			if (options.key !== undefined) checkKey(options.key);
			// The memo first, once per attempt; a failed one is tried again by the next call.
			// 每个尝试先提交一次 MADE_NESTED_CALLS memo；失败则清空，让下一次 executeTool 重试。
			madeNestedMemo ??= runtime.memo(MADE_NESTED_CALLS, true, callContext).catch((error: unknown) => {
				madeNestedMemo = undefined;
				throw error;
			});
			// Registered now, so cleanup waits for it.
			// 立即登记接纳 Promise，结算时 await，确保不会漏掉已开始创建的嵌套调用。
			const admission = madeNestedMemo.then(() =>
				startNestedCall(
					runtime,
					call.id,
					name,
					toolArgs,
					{ key, progress: options.progress, abandonOnRestart: !resumes },
					callContext,
				),
			);
			admissions.push(admission);
			const id = await admission;
			// 等待嵌套任务终态；取消 callContext 只取消等待，嵌套任务继续运行。
			const settled = await runtime.waitForTask(id, callContext);
			// 终态提交把结果写入父任务的 NestedCallDoc；这里按 key 读取。
			const stored = (await runtime.snapshot(NestedCallDoc, runtime.taskId, key, callContext))?.result;
			// A copy the tool may change; a nested call the scheduler faulted or orphaned stored none.
			// 返回副本，防止调用方修改持久化文档中的对象；没有存结果（faulted/orphaned）时构造兜底错误。
			return stored === undefined
				? fallbackResult(id, name, settled.state.outcome)
				: (copyJson(stored as unknown as JsonValue) as unknown as NestedToolExecutionResult);
		},
	};

	let result: ToolExecutionResult;
	let ending = COMPLETED;
	// Execution time of this attempt; a rerun after recovery measures only itself.
	// 只统计本次 execute 的耗时；恢复重跑不会包含崩溃前那次尝试。
	let durationMs: number | undefined;
	try {
		// 环境可能异步构建；失败也走下面的 catch，转成 tool_error 结果。
		env = await runtime.env(context);
		const startedAt = performance.now();
		try {
			// 工具实现本身的执行；无论成功/抛错都记录耗时。
			result = await tool.execute(args, api, context);
		} finally {
			durationMs = Math.round(performance.now() - startedAt);
		}
	} catch (error) {
		if (runtime.signal.aborted) {
			// 这是任务级中止：停止进度、拒绝等待者，并把原始中止错误向上抛，由调度器处理为 aborted。
			ended = true;
			for (const waiter of await progress.stop()) waiter.reject(error);
			throw error;
		}
		// 普通抛错转成 error 结果；工具错误不使任务 faulted，但以 failed 结束以取消其自有工作。
		result = { isError: true, diagnostics: [toolDiagnostic("tool_error", errorMessage(error))] };
		// A throw, from `execute()` or from building the environment, ends the task `failed`, which cancels what the call
		// owned; it no longer supervises it. The error text is already in the result.
		ending = { status: "failed", message: `Tool ${call.name} threw` };
	}
	// 之后不再允许新操作；下面等待已开始的嵌套接纳完成。
	ended = true;
	// No admission starts after `ended`; let those underway commit, so settlement aborts and lists their calls.
	// 用 allSettled：接纳失败不应阻止清理，settle 仍会中止并列出已创建的嵌套调用。
	await Promise.allSettled(admissions);
	// 结束输出缓冲，冻结最终文本。
	reported.output.end();
	// Details still waiting for a progress commit settle with the terminal commit, the final flush.
	// 停止节流器并取得仍在等待 details 提交的 waiter；终态提交会是最后一次 flush。
	const pending = await progress.stop();
	try {
		// 合并输出/details/diagnostics，执行 afterTool，校验 structuredOutput。
		const settled = await finalResult(runtime, input, call, tool, result, reported, context);
		// 提交终态；成功后再放行等待 details 的调用方，确保它们看到已持久化的结果。
		await settle(runtime, input, call, ending, settled, context, durationMs);
	} catch (error) {
		// 终态提交失败：拒绝所有 details 等待者并向上抛，任务不会进入错误终态。
		for (const waiter of pending) waiter.reject(error);
		throw error;
	}
	for (const waiter of pending) waiter.resolve();
}

/**
 * The Harness clock and timers for progress pacing. After the invocation ends nothing more commits, and the clock
 * answers with the last time it read.
 */
// 进度节流用的时钟：记录最后一次成功读取的时间；调用结束后 runtime.now() 可能抛错，此时沿用旧值。
function progressClock(runtime: Runtime): ProgressClock {
	let last = 0;
	return {
		now: () => {
			try {
				last = runtime.now();
			} catch {
				// The invocation ended.
				// 调用结束后时钟不可读；返回最后一次有效时间，避免节流器崩溃。
			}
			return last;
		},
		setTimer: (callback, delayMs) => runtime.setTimer(callback, delayMs),
	};
}

/**
 * Throttled commits of what the tool reported into its slot, in `pi.live.tools` or `pi.live.nestedTools`, each writing
 * only what changed since the last one, deferred (`PROGRESS_COMMIT`); none when `enabled` is false.
 */
// 节流发布工具进度：把输出文本、details、诊断增量写进槽位；默认延迟持久化，观察者仍立即看到。
function publishProgress(runtime: Runtime, reported: Reported, enabled: boolean, context: Context): Progress {
	// written 记录上次成功提交的内容，用于计算增量与字节数；diagnostics 存已提交数量。
	let written = { text: "", details: undefined as JsonValue | undefined, diagnostics: 0 };
	return new Progress(
		async () => {
			// 嵌套调用 progress:false 时不写槽位，也不会触发节奏提交。
			if (!enabled) return 0;
			// Capture everything synchronously: the tool keeps reporting while the commit is in flight.
			// 提交是异步的，而工具可能继续 output/details；先同步快照，得到本次提交的一致视图。
			const snapshot = reported.output.snapshot();
			const current = { text: snapshot.text, details: reported.details, diagnostics: reported.diagnostics.length };
			const added = reported.diagnostics.slice(written.diagnostics, current.diagnostics);
			const detailsChanged = current.details !== written.details;
			// What the commit writes, as Chord diffs the string: an append, a trim plus an append of what follows the shared
			// part, or the whole window when its bounded overlap search finds nothing.
			// 估算本次写入字节数，供 Progress 按 bytesPerSecond 控制节奏；不是精确的存储量。
			let bytes = 0;
			if (snapshot.text !== written.text) {
				// 常见情况是纯追加：从旧文本长度开始算。滑动尾部窗口时找重叠后缀/前缀，只计新增部分。
				const shared = snapshot.text.startsWith(written.text)
					? written.text.length
					: overlap(written.text, snapshot.text, 65_536);
				bytes += utf8ByteLength(snapshot.text.slice(shared));
			}
			// details 和新增诊断按 JSON 序列化后的字节数计。
			if (detailsChanged) bytes += utf8ByteLength(JSON.stringify(current.details ?? null));
			if (added.length > 0) bytes += utf8ByteLength(JSON.stringify(added));
			await runtime.commit(
				async (tx) => {
					// 每轮提交都重新读取 LiveDoc；槽位可能因运行/清理而消失。
					const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
					if (slot === undefined) return undefined;
					// REMINDER: assign `output` as one string field. Chord then diffs it into an append, or a trim plus an
					// append for a sliding tail; replacing the slot object would record the whole window on every commit.
					// 整体赋值 output 字符串而不是重建槽位：Chord 能把它 diff 成追加/裁剪，减少持久化量。
					if ((slot.output ?? "") !== snapshot.text) slot.output = snapshot.text;
					if (snapshot.droppedBytes > 0) slot.droppedBytes = snapshot.droppedBytes;
					if (snapshot.droppedLines > 0) slot.droppedLines = snapshot.droppedLines;
					// Diff details leaf by leaf and append new diagnostics, so each commit writes only what changed.
					// details 通过 assignJson 叶子级赋值；诊断只 push 新增项，避免每轮重写整个数组。
					if (detailsChanged && current.details !== undefined) {
						assignJson(slot, "details", current.details);
					}
					if (added.length > 0) {
						if (slot.diagnostics === undefined) slot.diagnostics = [];
						for (const diagnostic of added) slot.diagnostics.push(diagnostic);
					}
					return undefined;
				},
				context,
				// 延迟持久化：与同文档的其他变更合并落盘，减少写放大。
				PROGRESS_COMMIT,
			);
			// 只有提交成功才更新基线；失败时下一轮会重试同样的增量。
			written = current;
			return bytes;
		},
		(error) => {
			// Rejections after an abort mark or close are expected; the committed state stays consistent.
			// 中止/关闭后的拒绝是预期内的；其他错误上报给宿主。
			if (!runtime.signal.aborted) runtime.report(error);
		},
		// 输出提交间隔与时钟由 Progress 用于节流。
		runtime.settings.progress.outputIntervalMs,
		progressClock(runtime),
	);
}

/**
 * The settled result: the tool's result with the retained output and last details as fallbacks, its diagnostics after
 * those reported through the api, `afterTool` applied, explicit text bounded, and `structuredOutput` checked against the
 * tool's schema, with the Harness's diagnostics last. A nested call whose `structuredOutput` breaks the contract gets an
 * error result without it; a model-issued call only loses it, and the break is reported to the host.
 */
// 生成最终工具结果：合并运行期上报 → afterTool → 截断 → structuredOutput 校验 → 追加 Harness 诊断。
async function finalResult(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	tool: ToolRegistration,
	result: ToolExecutionResult,
	reported: Reported,
	context: Context,
): Promise<ToolExecutionResult> {
	// harness 存本函数自己产生的诊断（截断、结构化输出错误），最后统一排到工具/钩子诊断之后。
	const harness: ToolDiagnostic[] = [];
	// 只有工具未显式返回 output 时才使用运行期保留输出；显式 output 优先。
	const retained = result.output === undefined ? reported.output.snapshot() : undefined;
	// 有运行期保留输出时改写成内容（空文本不生成空 text 块）；工具显式返回 output 时直接使用。
	const output: Content =
		retained === undefined ? result.output! : retained.text === "" ? [] : [{ type: "text", text: retained.text }];
	// 合并：output 用上面的兜底，details 用最后一次 api.details，diagnostics 先运行期上报、后结果自带。
	let final: ToolExecutionResult = {
		...result,
		output,
		details: result.details === undefined ? reported.details : result.details,
		diagnostics: [...reported.diagnostics, ...(result.diagnostics ?? [])],
	};
	// afterTool 串行执行，每个钩子可以返回新结果；返回 undefined 表示保留当前结果。
	await runtime.hooks.each("afterTool", async (hook) => {
		final = (await hook(call, final, runtime, context)) ?? final;
	});
	// The retained output's truncation applies only while afterTool kept that output.
	// 用引用相等判断钩子是否原样保留了我们构造的 output；若替换过，旧截断信息不再适用。
	if (retained !== undefined && retained.droppedBytes > 0 && final.output === output) {
		harness.push(truncated(retained, reported.limits.retain));
	}
	// 对显式输出再执行工具的输出上限；afterTool 可能放大输出，因此必须重新裁剪。
	const bounded = boundContent(final.output ?? [], reported.limits);
	if (bounded.droppedBytes > 0) harness.push(truncated(bounded, reported.limits.retain));
	// 校验 structuredOutput 是否符合工具声明的 schema；undefined 表示符合或无需校验。
	const broken = structuredOutputError(tool, final);
	if (broken !== undefined) {
		// 不把非法 structuredOutput 交给程序；先从结果中移除。
		const { structuredOutput: _dropped, ...rest } = final;
		if (input.kind === "nested") {
			// 嵌套调用方是程序：契约被破坏时返回错误结果并附诊断。
			final = { ...rest, isError: true };
			harness.push(toolDiagnostic("invalid_structured_output", broken));
		} else {
			// The model never sees structured output, so its call stands; the host learns of the broken tool.
			// 模型调用不使用 structuredOutput，调用本身仍成功；只把问题报告给宿主（按扩展归因）。
			final = rest;
			// Only names the extension: a failed resolution leaves the report without the name.
			// 解析 Agent 只为找到工具所属扩展；解析失败则不带扩展信息上报。
			const extension = await runtime.agent(context).then(
				(agent) => toolExtension(agent, tool.name),
				() => undefined,
			);
			runtime.report(new Error(broken), { kind: "extension", ...optionalExtension(extension) });
		}
	}
	// Programs get the tool's own value: without a schema, its output. The model reads only `output`, so model-issued
	// calls skip both.
	// 无 schema 的嵌套调用把有界输出作为 structuredOutput；模型调用不需要这个字段。
	if (input.kind === "nested" && tool.structuredOutputSchema === undefined) {
		final = { ...final, structuredOutput: outputValue(bounded.content) as JsonValue };
	}
	// A schema tool's error result without structured output has its text only in the output, which programs never
	// get: it becomes an error diagnostic, as a thrown error's message does, unless one says what went wrong already.
	// 有 schema 的嵌套调用失败且没有 structuredOutput 时，程序看不到 output 文本；
	// 若现有诊断中没有 error，把文本转成 tool_error 诊断。
	if (
		input.kind === "nested" &&
		tool.structuredOutputSchema !== undefined &&
		final.isError === true &&
		final.structuredOutput === undefined &&
		![...(final.diagnostics ?? []), ...harness].some((diagnostic) => diagnostic.severity === "error")
	) {
		const text = bounded.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
		if (text !== "") harness.push(toolDiagnostic("tool_error", text));
	}
	// 最终 output 用裁剪后的内容，诊断把 Harness 诊断排在最后。
	return { ...final, output: bounded.content, diagnostics: [...(final.diagnostics ?? []), ...harness] };
}

/**
 * A result the Harness wrote itself, without executing the tool, after the `afterTool` chain, normalized like an
 * executed call's: the output bounded with the tool's limits (the defaults when it did not resolve), a truncation
 * diagnostic when that dropped something, and the hooks' `structuredOutput` dropped, since the tool never produced
 * one. A nested call that the hooks turned into a success gets the bounded output as its value, as a schema-less
 * tool's success does, unless the tool declares a schema. `usage` is kept and recorded; `control` applies only when
 * the task completes. `truncation` describes what the result's own output lost before (a slot's retained output); it
 * is kept only while the hooks keep that output.
 */
// 处理 Harness 自己生成的错误结果（unavailable/invalid/blocked/interrupted 等）：仍然过 afterTool，
// 但不使用 structuredOutput（工具并未真正产出），并按输出限制裁剪。
async function afterHarnessResult(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	tool: ToolRegistration | undefined,
	result: ToolExecutionResult,
	truncation: ToolDiagnostic | undefined,
	context: Context,
): Promise<ToolExecutionResult> {
	let final = result;
	// afterTool 可把错误结果改成成功结果或补充诊断。
	await runtime.hooks.each("afterTool", async (hook) => {
		final = (await hook(call, final, runtime, context)) ?? final;
	});
	const harness: ToolDiagnostic[] = [];
	// 仅当钩子保留原 output 时，之前的截断说明仍然成立。
	if (truncation !== undefined && final.output === result.output) harness.push(truncation);
	const limits = outputLimits(tool);
	const bounded = boundContent(final.output ?? [], limits);
	if (bounded.droppedBytes > 0) harness.push(truncated(bounded, limits.retain));
	// Harness 写的结果没有真正的 structuredOutput；钩子伪造的值不能交给程序。
	const { structuredOutput: _dropped, ...rest } = final;
	// 例外：嵌套调用被钩子改成成功，且工具无 schema，则把有界输出作为程序可见的值。
	const value =
		input.kind === "nested" && final.isError !== true && tool?.structuredOutputSchema === undefined
			? { structuredOutput: outputValue(bounded.content) as JsonValue }
			: {};
	return { ...rest, ...value, output: bounded.content, diagnostics: [...(rest.diagnostics ?? []), ...harness] };
}

// structuredOutput schema 编译缓存：schema 对象为键，避免每次调用重复 compile；WeakMap 不阻止 schema 被回收。
const structuredValidators = new WeakMap<object, Validator>();

/** Why a result's `structuredOutput` breaks the tool's contract, or `undefined` when it keeps it. */
// 校验 structuredOutput：无 schema 时禁止返回值；有 schema 时成功必须提供、错误可省略；
// 通过则返回 undefined，否则返回含 JSON 路径的可读错误。
function structuredOutputError(tool: ToolRegistration, result: ToolExecutionResult): string | undefined {
	const schema = tool.structuredOutputSchema;
	const value = result.structuredOutput;
	if (schema === undefined) {
		return value === undefined
			? undefined
			: `Tool ${tool.name} returned structuredOutput but declares no structuredOutputSchema`;
	}
	if (value === undefined) {
		// 错误结果允许没有 structuredOutput（失败时可能没有值）；成功必须有。
		return result.isError === true ? undefined : `Tool ${tool.name} returned no structuredOutput`;
	}
	// 首次校验时编译 schema；unresolvedRefs:"reject" 让悬空 $ref 直接编译失败。
	let validator = structuredValidators.get(schema);
	if (validator === undefined) {
		validator = compile(schema, { formats, unresolvedRefs: "reject" });
		structuredValidators.set(schema, validator);
	}
	if (validator.check(value)) return undefined;
	// JSON Pointer 第一段通常是根；去掉后用 "/" 分割，再反转义 ~1→/、~0→~，拼成点路径。
	const [first] = validator.errors(value);
	const path =
		first?.path
			.slice(1)
			.split("/")
			.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
			.join(".") || "root";
	return `Tool ${tool.name} returned structuredOutput that does not match its schema: ${path}: ${first?.message ?? "invalid"}`;
}

/**
 * Commit the tool's terminal state and mark its slot done. A model-issued call appends its result entry and ends with
 * the entry ID; a nested call writes its result to the caller's `NestedCallDoc`, records its usage, and ends with a
 * small receipt. Nested calls this call left running are aborted first, so they report into their slots before the
 * slots below the call leave `pi.live`. `control` applies only when the task completes.
 */
// 统一终态提交：先中止所有仍存活的嵌套调用，再在一个提交里写结果条目/嵌套结果、更新槽位、记录 usage 并返回终态。
async function settle(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	ending: Ending,
	result: ToolExecutionResult,
	context: Context,
	durationMs?: number,
): Promise<void> {
	// A crash in between leaves the call in `execute`: a safe rerun reattaches to the calls, an interruption ends here.
	// Every live nested call the task owns, also those an earlier attempt made and this one never called again.
	// 枚举本任务拥有的所有嵌套 pi.tool 任务（包括前一次尝试创建、本次未再调用的），随后全部中止。
	const nestedIds = (await runtime.ownedTasks(context))
		.filter((record) => record.kind === ToolTask.definition.name && (record.input as ToolTaskInput).kind === "nested")
		.map((record) => record.id);
	// Read before the settling commit: no admission starts after `ended`, and those underway were awaited.
	// 读取 memo 判断是否曾创建过嵌套调用；必须在结算提交前读，因为提交后任务可能终态。
	const madeNested = (await runtime.memo(MADE_NESTED_CALLS, context)) === true;
	// Mark them all before waiting for any: one may run until a sibling is cancelled.
	// 先并行标记/通知所有嵌套调用，再等待各自结束，避免一个调用等待另一个尚未收到中止信号。
	await Promise.all(nestedIds.map((id) => runtime.abortOwned(id, context)));
	// 单个提交完成结果与终态；嵌套调用的结果也会在它们自己的终态提交里落盘。
	await runtime.commit(async (tx) => {
		const conversationId = runtime.conversationId;
		// 读取 pi.live，用于完成/清理槽位。
		const live = await tx.doc(LiveDoc, conversationId);
		const slot = toolSlot(live, runtime.taskId);
		let settled: ToolTaskResult;
		if (input.kind === "nested") {
			// 嵌套结果：去掉 output（仅模型读）和 control（仅模型调用用），严格 JSON。
			const nested = nestedResult(runtime.taskId, result, durationMs);
			// usage 记到会话级 pi.usage 的 tools 分类。
			if (nested.usage !== undefined) await recordUsage(tx, conversationId, "tools", call.name, nested.usage);
			// The caller is never terminal before its owned nested calls, so its document is open; another task in it is a
			// bug, not a race.
			// 子调用终态时父任务必然仍存活，因此父任务的 NestedCallDoc 成员应存在且 taskId 匹配；不匹配属于内部错误。
			const state = await tx.doc(NestedCallDoc, input.parent, input.key, null);
			if (state.taskId !== runtime.taskId) throw new Error(`Nested call ${call.id} is not in its caller's index`);
			// 结果写入父调用索引，供 executeTool() 读取和重跑复用。
			state.result = nested as unknown as Draft<JsonRepresentation<NestedToolExecutionResult>>;
			if (slot !== undefined && "parentTaskId" in slot) {
				// 嵌套槽位完成，保留摘要（错误文本/耗时/usage），清空运行输出。
				finishSlot(slot);
				slot.summary = summaryOf(nested, result.output ?? []);
			}
			settled = { kind: "nested" };
		} else {
			// 模型调用：追加 pi.tool-result 条目；时间戳取 Harness 时钟，耗时只记本次尝试。
			const timing = { timestamp: runtime.now(), durationMs };
			const entry = await appendToolResult(tx, conversationId, call, result, timing);
			if (slot !== undefined && !("parentTaskId" in slot)) {
				// 模型调用槽位完成并指向结果条目。
				finishSlot(slot);
				slot.entry = entry.id;
			}
			// Tools build control objects freely; drop keys set to undefined so the task result is strict JSON.
			// control 只在任务成功完成时生效；中止/失败时不把 control 带进回执。
			const control =
				result.control === undefined || ending.status !== "completed"
					? {}
					: { control: copyJson(result.control as JsonValue, { omitUndefinedProperties: true }) as ToolControl };
			settled = { kind: "model", entryId: entry.id, ...control };
		}
		// A call that made no nested calls, in any attempt, has no slots below it; skipping the scan keeps many leaves
		// linear. Committed before the read: no nested call is admitted after `ended`.
		// 未创建过嵌套调用则无需扫描；否则删除本任务名下（含递归）的嵌套槽位。memo 已在提交前读取。
		if (madeNested) removeNestedSlots(live, runtime.taskId);
		// 按结束方式映射为任务终态与 outcome；result 始终携带在 outcome 中。
		if (ending.status === "aborted") return { status: "terminal", outcome: { status: "aborted", result: settled } };
		if (ending.status === "failed") {
			// failed 细节可选 reason，调度器/检视界面可据此区分 restart_limit 等。
			const error = {
				message: ending.message,
				...(ending.reason === undefined ? {} : { detail: { reason: ending.reason } }),
			};
			return { status: "terminal", outcome: { status: "failed", error, result: settled } };
		}
		return { status: "terminal", outcome: { status: "completed", result: settled } };
	}, context);
}

/**
 * A nested call's result, as stored and returned: strict JSON, without `output`, which only the model reads, and
 * without `control`, which only model-issued calls apply.
 */
// 嵌套结果的持久化形状：taskId、structuredOutput、isError、details、diagnostics、usage、durationMs；去掉 output/control。
function nestedResult(
	taskId: TaskId,
	result: ToolExecutionResult,
	durationMs: number | undefined,
): NestedToolExecutionResult {
	const nested = {
		taskId,
		structuredOutput: result.structuredOutput,
		// isError 统一成布尔值，缺省 false，程序端无需处理 undefined。
		isError: result.isError ?? false,
		details: result.details,
		diagnostics: result.diagnostics ?? [],
		usage: result.usage,
		durationMs,
	};
	// 去掉 undefined 字段，确保存进文档的是严格 JSON。
	return copyJson(nested as unknown as JsonValue, {
		omitUndefinedProperties: true,
	}) as unknown as NestedToolExecutionResult;
}

/**
 * Create nested call `key` of the call `parentCallId` in one commit: its tool task, owned by the calling task, its slot,
 * and its `NestedCallDoc`. A key already made returns that call's task when it names the same tool and arguments.
 */
// 幂等创建嵌套调用：同一个 key 必须对应同一工具和同一参数；已存在则复用任务（有 result 时视为 replay），
// 不存在则原子创建任务、索引和展示槽位。
async function startNestedCall(
	runtime: Runtime,
	parentCallId: string,
	name: string,
	args: JsonObject,
	options: { readonly key: string; readonly progress: boolean | undefined; readonly abandonOnRestart: boolean },
	context: Context,
): Promise<TaskId<ToolTaskResult>> {
	const key = options.key;
	// 子调用 ID 是父调用 ID + "/" + key；显式 key 已保证不含 "/"，因此不会与默认序号冲突。
	const call: ToolCall = {
		type: "toolCall",
		id: `${parentCallId}/${key}`,
		name,
		arguments: copyJson(args, { omitUndefinedProperties: true }) as JsonObject,
	};
	let id: TaskId<ToolTaskResult> | undefined;
	let replayed = false;
	await runtime.commit(async (tx) => {
		// Opened, or created empty for a key not made yet.
		// 打开或创建父任务下的这个 key 文档；initial() 为 {}。
		const state = await tx.doc(NestedCallDoc, runtime.taskId, key, null);
		const existing = state.taskId;
		if (existing !== undefined) {
			// 已有同 key 的调用：读取其输入，要求工具名和参数完全一致（JSON 结构相等），否则是调用方错误。
			const input = (await tx.task(existing))?.input as ToolTaskInput | undefined;
			const same =
				input?.kind === "nested" &&
				input.call.name === name &&
				jsonEqual(input.call.arguments as JsonValue, call.arguments as JsonValue);
			if (!same) throw new Error(`Nested call ${call.id} was already made with another tool or other arguments`);
			id = existing as TaskId<ToolTaskResult>;
			// 已有结果说明是完成后的重放；仍在运行则是重跑重新挂接。
			replayed = state.result !== undefined;
			return undefined;
		}
		// 新嵌套调用：输入携带父信息、key、调用和是否关闭进度展示。
		const input: ToolTaskInput = {
			kind: "nested",
			parent: runtime.taskId,
			parentCallId,
			key,
			call,
			...(options.progress === false ? { progress: false } : {}),
		};
		// 创建 pi.tool 子任务，所有权归父工具任务；父不恢复时子任务也 abandonOnRestart。
		const created = await tx.createTask(ToolTask, input, {
			ownership: { kind: "task", taskId: runtime.taskId },
			abandonOnRestart: options.abandonOnRestart,
		});
		// 索引记录 taskId，供 executeTool 等待结束后按 key 读取结果。
		state.taskId = created;
		// 在 pi.live.nestedTools 中追加 pending 槽位，展示嵌套调用。
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		live.nestedTools ??= [];
		const slot: NestedToolSlot = {
			callId: call.id,
			parentCallId,
			parentTaskId: runtime.taskId,
			name,
			taskId: created,
			arguments: call.arguments as JsonObject,
			status: "pending",
		};
		live.nestedTools.push(slot as Draft<NestedToolSlot>);
		id = created;
		return undefined;
	}, context);
	if (replayed) {
		// 遥测事件标记本次读取命中了已完成的嵌套调用。
		context.telemetry.addEvent("pi.durable.replay", { "tool.name": name });
	}
	return id!;
}

/**
 * What programs get of a tool's output when it declares no schema: one text item as its string, one image as itself,
 * nothing as `""`, and anything else as the content list.
 */
// 无 schema 工具给程序的 structuredOutput 形态：空→""；单文本→字符串；单图片→图片对象；多个→内容数组。
function outputValue(output: Content): string | ImageContent | Content {
	if (output.length === 0) return "";
	if (output.length > 1) return output;
	const [only] = output;
	return only!.type === "text" ? only!.text : only!;
}

/** What the caller gets for a nested call without a stored result: one the scheduler faulted or orphaned. */
// 嵌套调用没有持久化结果时的兜底：区分 faulted / orphaned / 其他无结果终态，生成 error 结果。
function fallbackResult(taskId: TaskId, name: string, outcome: TaskOutcome<ToolTaskResult>): NestedToolExecutionResult {
	const message =
		outcome.status === "faulted"
			? `Tool ${name} failed: ${outcome.error.message}`
			: outcome.status === "orphaned"
				? `Tool ${name} could not resume: ${outcome.reason}`
				: `Tool ${name} ended without a result`;
	// 诊断码直接使用 outcome.status，便于调用方按状态分支。
	const error = harnessError(outcome.status, message);
	return { taskId, isError: true, diagnostics: error.diagnostics ?? [] };
}

/**
 * How a tool task ends; the result entry is appended either way. `failed` (execution threw or was interrupted)
 * records cancellation intent for the conversations the call owns; a result with `isError` still completes.
 */
// 工具任务的结束方式：completed 成功；aborted 被中止；failed 表示执行抛错/中断，需取消其拥有的会话。
// 注意 isError 结果仍可能属于 completed（工具正常返回错误）。
type Ending =
	| { readonly status: "completed" | "aborted" }
	| { readonly status: "failed"; readonly message: string; readonly reason?: string };

const COMPLETED: Ending = { status: "completed" };

/**
 * An error result from the slot's durable partial output, details, and diagnostics, ending with `code`; and the
 * truncation diagnostic of that output, when its bounds dropped some, which the caller adds after `afterTool`.
 */
// 从 pi.live 槽位重建错误结果：保留部分输出、上次 details、已有诊断，再追加本次错误码诊断；
// 若槽位曾截断输出，额外返回 truncation 诊断，由调用方决定是否在 afterTool 后追加。
function fromSlot(
	slot: Readonly<ToolSlot | NestedToolSlot> | undefined,
	code: string,
	message: string,
): { readonly result: ToolExecutionResult; readonly truncation?: ToolDiagnostic } {
	const droppedBytes = slot?.droppedBytes ?? 0;
	const result: ToolExecutionResult = {
		// 空/缺失输出用空内容数组，避免生成空 text 块。
		output: slot?.output === undefined || slot.output === "" ? [] : [{ type: "text", text: slot.output }],
		isError: true,
		// details 只有存在时才带上，保持严格 JSON。
		...(slot?.details === undefined ? {} : { details: slot.details }),
		diagnostics: [...(slot?.diagnostics ?? []), toolDiagnostic(code, message)],
	};
	if (droppedBytes === 0) return { result };
	return { result, truncation: truncated({ droppedBytes, droppedLines: slot?.droppedLines ?? 0 }) };
}

/** An error result the Harness writes itself: no content and one `error` diagnostic with `code`. */
// Harness 自己生成的错误结果：无内容，仅一条 severity=error 的诊断。
export function harnessError(code: string, message: string): ToolExecutionResult {
	return { output: [], isError: true, diagnostics: [toolDiagnostic(code, message)] };
}

// 构造 error 级诊断的便捷函数。
function toolDiagnostic(code: string, message: string): ToolDiagnostic {
	return { severity: "error", code, message };
}

/** The Harness's truncation diagnostic; `retain` is unknown when rebuilt from a slot after recovery. */
// 生成截断诊断；从恢复后的槽位重建时 retain 未知，提示文本不写“开头/末尾”。
function truncated(
	dropped: { readonly droppedLines: number; readonly droppedBytes: number },
	retain?: "head" | "tail",
): ToolDiagnostic {
	const kept = retain === undefined ? "" : ` to its ${retain === "head" ? "beginning" : "end"}`;
	return {
		severity: "warn",
		code: "truncated",
		message: `Output truncated${kept}: ${dropped.droppedLines} lines, ${dropped.droppedBytes} bytes dropped`,
	};
}

/** Error text a nested call's summary keeps. */
// 嵌套调用摘要中错误文本的最大字符数，避免 pi.live 摘要携带大段输出。
const MAX_SUMMARY_ERROR_CHARS = 500;

/**
 * How a nested call ended, for its slot: error text, from its diagnostics or else its `output`, bounded. The bound is a
 * copy, so the slot never keeps a large output alive through a slice of it.
 */
// 嵌套槽位摘要：是否错误、耗时、usage，以及有界错误文本；ownedSlice 生成独立副本，避免槽位间接持有大输出。
function summaryOf(result: NestedToolExecutionResult, output: Content): NestedToolSummary {
	const error = result.isError ? ownedSlice(errorTextOf(result, output), 0, MAX_SUMMARY_ERROR_CHARS) : "";
	return {
		isError: result.isError,
		...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
		...(result.usage === undefined ? {} : { usage: result.usage }),
		...(error === "" ? {} : { error }),
	};
}

/** The error messages of a nested result, else the text items of its output, joined with newlines. */
// 摘要错误文本来源：优先 error 级诊断消息；没有诊断时退回输出中的文本项。
function errorTextOf(result: NestedToolExecutionResult, output: Content): string {
	const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
	if (errors.length > 0) return errors.map((diagnostic) => diagnostic.message).join("\n");
	return output.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
}

/**
 * Append a `pi.tool-result` entry. The content ends with the rendered diagnostics, so the stored message is exactly
 * what the model sees; `data` keeps the structured list. A result's usage is added to `pi.usage` in the same commit.
 */
// 写入模型可见的工具结果条目：content = 输出 + 渲染后的诊断，data 保留结构化诊断，同一提交记录 usage。
export async function appendToolResult(
	tx: Tx,
	conversationId: ConversationId,
	call: ToolCall,
	result: ToolExecutionResult,
	meta: { readonly timestamp: number; readonly durationMs?: number },
): Promise<TypedEntry<{ diagnostics: ToolDiagnostic[] }>> {
	const { timestamp, durationMs } = meta;
	const diagnostics = [...(result.diagnostics ?? [])];
	const content: Content = [...(result.output ?? [])];
	// 诊断渲染成一段 <harness> 文本追加在内容末尾，模型因此能看到截断、错误原因等。
	if (diagnostics.length > 0) content.push({ type: "text", text: renderDiagnostics(diagnostics) });
	const message = {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content,
		// details/usage/durationMs 都可选，缺失时不写字段。
		...(result.details === undefined ? {} : { details: result.details }),
		...(result.usage === undefined ? {} : { usage: result.usage }),
		isError: result.isError ?? false,
		...(durationMs === undefined ? {} : { durationMs }),
		timestamp,
	} as ToolResultMessage;
	// usage 与结果条目同提交写入，保证不会出现“有结果但无用量”或反之。
	if (result.usage !== undefined) await recordUsage(tx, conversationId, "tools", call.name, result.usage);
	// 条目 data 保留诊断数组，供结构化读取；model 字段是模型看到的消息。
	return tx.appendEntry(ToolResultEntry, conversationId, { model: [message], data: { diagnostics } });
}

// 诊断渲染格式：每条一行 `[severity] message`，整体包在 <harness> 中，便于模型区分工具输出与框架信息。
function renderDiagnostics(diagnostics: readonly ToolDiagnostic[]): string {
	return `<harness>\n${diagnostics.map((diagnostic) => `[${diagnostic.severity}] ${diagnostic.message}`).join("\n")}\n</harness>`;
}

/**
 * Bound the text of result content. When the joined text exceeds the limits, the text items are replaced by one bounded
 * item at the position of the first (head) or last (tail) text item; other content is kept.
 */
// 对结果内容中的全部文本合并后裁剪；超限时只保留一个裁剪后的 text 块（头部放在第一个文本项位置，
// 尾部放在最后一个文本项位置），图片等其他内容原样保留。
function boundContent(
	content: Content,
	limits: OutputLimits,
): { content: Content; droppedBytes: number; droppedLines: number } {
	const texts = content.filter((item): item is TextContent => item.type === "text");
	// 所有文本拼成一个字符串后统一裁剪，保证跨块的字节/行数限制一致。
	const bounded = boundOutput(texts.map((item) => item.text).join(""), limits);
	if (bounded.droppedBytes === 0) return { content, droppedBytes: 0, droppedLines: 0 };
	// 选择裁剪文本的落点：head 保留开头，放在第一个文本块；tail 保留结尾，放在最后一个文本块。
	const keep = limits.retain === "head" ? texts[0] : texts.at(-1);
	const result: Content = [];
	for (const item of content) {
		if (item.type !== "text") result.push(item);
		// 只替换被选中的文本块；其余文本块被丢弃，避免重复内容。
		else if (item === keep) result.push({ ...item, text: bounded.text });
	}
	return { content: result, droppedBytes: bounded.droppedBytes, droppedLines: bounded.droppedLines };
}

/**
 * Explicit nested call keys are path segments of the call ID, so IDs of different nested calls never collide, and are
 * never plain positive integers, which default keys use. `__proto__` stays reserved, as it was when keys indexed a JSON object.
 */
// 校验显式嵌套 key：非空、不含 "/"（调用 ID 以 / 分段）、不是 __proto__、不是正整数（避免与默认序号冲突）。
function checkKey(key: string): void {
	if (key === "" || key.includes("/") || key === "__proto__" || /^[1-9][0-9]*$/.test(key)) {
		throw new Error(
			`Nested call key ${JSON.stringify(key)} must be non-empty, without "/", not "__proto__", and not a positive integer`,
		);
	}
}

/** Structural JSON equality; object key order does not matter. */
// 结构化 JSON 相等：递归比较数组顺序与对象键值，忽略对象键顺序；用于判断同 key 嵌套调用是否参数一致。
function jsonEqual(a: JsonValue, b: JsonValue): boolean {
	if (a === b) return true;
	// 任一非对象（含 null）且不严格相等，即不相等。
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		// 只有两边都是数组、长度相同且逐项相等才相等；b[i]! 由长度检查保证存在。
		return (
			Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]!))
		);
	}
	// 对象：键数量相同，且 a 的每个键在 b 上存在并递归相等（Object.hasOwn 忽略原型链）。
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key]!, b[key]!))
	);
}
