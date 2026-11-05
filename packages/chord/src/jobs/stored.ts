// A persisted run's record (slice 6b §4.1, D5): the document each unsettled run of a persisted job keeps in its
// object's store (namespace `chord.jobs`, kind the job name, key the run id), and the conversion of an outcome to and
// from it. Errors are stored in the wire error format, so a `PluginError`'s code, message and details survive.

// 文件导读（持久化运行记录的形状层）
// 所属：packages/chord/src/jobs，Chord v2 作业模块的持久化子层（slice 6b）。
// 职责边界：只定义“存储文档长什么样”以及内存/存储之间的转换；不决定何时写、不调用 store、不推进运行状态机。
// 上游入口：records.ts 在 stage 时用 storedRun 生成/更新记录，在 load 时用 recordOf 读取记录，在结算时用
// outcomeOf 还原调用方可见的结果；PersistedRuns（persisted.ts）只把结果交给 store 引擎。
// 下游依赖：link 层的 wireError/errorFromWire（错误可跨进程、可落盘），以及 documents 的 JsonObject、run.ts 的
// Phase/BlockedReason/JobRun 类型。
// 结果与错误流向：正常路径全部是纯函数转换；唯一可能抛错的是 errorFromWire 遇到畸形 ChordError 信封（协议错误）。
// 记录本身由 Chord 自己写，读取侧不做 schema 校验（recordOf 的断言依赖这个信任边界）。
// 能力清单：
// - StoredJobError：作业失败的存储形状，threw 分支的 error 换成 WireError。
// - StoredOutcome：存储的结果联合，只保留 result 或 error，不重复保存 id/args/state。
// - StoredRun：一个未结算运行在 chord.jobs 里的完整文档形状。
// - RUN_RECORD：记录文档自身的版本与指纹常量（"chord.job-run.1"）。
// - StoredFields：一次 stage 可以覆盖的可变字段集合。
// - storedRun：把 JobRun 投影成 StoredRun，并可覆盖指定字段。
// - outcomeOf：把 StoredOutcome 与运行身份拼回内存 AnyOutcome。
// - recordOf：把文档引擎读出的 JsonObject 断言成 StoredRun。
// 组合关系/典型顺序：storedRun(run, fields) 生成记录 -> PersistedRuns.stage 写入 -> 加载时 recordOf(value) ->
// 结算时 outcomeOf(stored, id, args, state) 还原结果 -> stageRetire 删除记录。
// 示例（真实签名）：
//   const rec: StoredRun = storedRun(run, { phase: "running" });
//   const out: AnyOutcome = outcomeOf({ kind: "done", result: 42 }, run.id, run.args, undefined);
// 建议阅读顺序：先 StoredRun/StoredOutcome/StoredJobError 看落盘形状，再看 storedRun 与 outcomeOf 的双向转换，
// 最后看 RUN_RECORD 与 recordOf 的“Chord 自有文档”边界。
// 设计要点：落盘的错误使用链接协议里的 wire error 格式（ChordError 的 JSON，或插件的 code/message/details），
// 因此插件错误经过一次持久化仍能还原成原来的错误类型，而普通 Error 会变成 PluginError(internal)。
// 这里所有函数都是纯函数（只读输入并返回新对象），不写 store、不抛业务错误；唯一可能抛的是 errorFromWire 遇到畸形错误信封。
import type { JsonObject } from "../documents/index.ts";
import type { JsonValue } from "../json.ts";
import { errorFromWire, wireError } from "../link/internal.ts";
import type { WireError } from "../link/message.ts";
import type { JobError } from "./definition.ts";
import type { AnyOutcome, BlockedReason, JobRun, Phase } from "./run.ts";

/** How a run failed, as stored: a thrown error in the wire format, an abort, the restart limit. */
// 与 JobError 一一对应，但 threw 分支的 error 换成了 WireError（可 JSON 传输/存储）。
// 判别字段 kind 保持相同，因此 aborted/restart_limit 两个分支可以原样复用，不需要转换。
export type StoredJobError =
	| { readonly kind: "threw"; readonly error: WireError }
	| { readonly kind: "aborted"; readonly reason: "abort" | "reload" | "restart" }
	| { readonly kind: "restart_limit"; readonly restarts: number };

/** A run's outcome as stored: its result, or how it failed. */
// 存储层不保存 id/args/state：id 是文档键，args 在记录顶层，state 在单独的 chord.job-states 文档里；
// 读取时 outcomeOf 再把三者拼回完整 Outcome，避免同一数据存两遍。
export type StoredOutcome =
	| { readonly kind: "done"; readonly result: JsonValue }
	| { readonly kind: "failed"; readonly error: StoredJobError };

/** The record document of one unsettled persisted run. */
// 一条运行记录对应一个未结算的运行；运行结算后记录被删除，而不是保留历史。
// version/fingerprint 是“作业版本 + schema 指纹”：reload 后旧运行仍按启动时的版本解释自己的 args/result。
// trace 是调用链追踪信息；blocked 记录冻结原因；outcome 在最终提交阶段写入，随后记录即被移除。
export type StoredRun = {
	readonly version: number;
	readonly fingerprint: string;
	// args 是启动时已经校验过的 JSON 参数；key 只在调用者显式传了去重键时存在（可选属性，不是 null）。
	readonly args: JsonValue;
	readonly key?: string;
	readonly trace?: { readonly [key: string]: string };
	// phase 复制 run.ts 的 Phase（pending/running/stopped/finishing/blocked），让加载代码知道恢复后该做什么。
	readonly phase: Phase;
	readonly restarts: number;
	readonly finishFailures: number;
	// 用可选属性 `abort?: true` 而不是 boolean：只有“被标记中止”才写这个字段，读取时 undefined 即为未标记。
	readonly abort?: true;
	readonly blocked?: BlockedReason;
	// 记录在“已结算、尚未删除”的极短窗口里带 outcome；正常读取路径也可能看到它。
	readonly outcome?: StoredOutcome;
};

/**
 * The record documents' version and fingerprint (Chord's own documents: no definition, no `migrate`; a new record
 * shape raises the version).
 */
// `as const` 让两个字段成为字面量类型（1 与 "chord.job-run.1"），防止调用方误改；
// 它也是 Chord 自己的文档定义：records.ts 用 RUN_RECORD 作为 Persistence 的“定义”参数。
// 记录格式若发生不兼容变化，手工把 version 加 1 并换一个新指纹，而不是走 defineState 的 migrate。
export const RUN_RECORD = { version: 1, fingerprint: "chord.job-run.1" } as const;

/** What a change sets on a run's record; the rest is the run's own. */
// 部分更新：每个字段都可选，storedRun 会把它与 run 当前字段合并。
// abortMarked 在内存里叫 abortMarked，落盘字段叫 abort；blocked/outcome 在内存里是对象，落盘要转换。
export type StoredFields = {
	readonly phase?: Phase;
	readonly restarts?: number;
	readonly finishFailures?: number;
	readonly abortMarked?: true;
	readonly blocked?: BlockedReason;
	readonly outcome?: AnyOutcome;
};

/** `run`'s record as stored with `fields` changed (its own version and fingerprint). */
// 用途：把内存里的 JobRun 投影成待写入 store 的普通 JSON 对象。
// 输入 run 与可选的覆盖字段；输出全新对象（不修改 run）；无副作用。
// 流程：先取 run 顶层字段，再把 pick(run) 与 fields 合并，最后按“可选字段存在才展开”的规则组装。
// 例（真实运行时）：storedRun(run, { phase: "running" }) 会用 run 的 restarts/args，而 phase 强制为 "running"。
export function storedRun(run: JobRun, fields: StoredFields = {}): StoredRun {
	// 解构出运行身份字段；这些字段不会因 stage 的字段变化而变化。
	const { version, fingerprint, args, key, trace } = run;
	// 对象展开先取 pick(run) 的当前值，再让 fields 覆盖同名键（后者在右侧，优先级更高）。
	// `{ ...pick(run), ...fields }` 得到的是 StoredFields 形状；解构时未提供的键为 undefined。
	const { phase, restarts, finishFailures, abortMarked, blocked, outcome } = { ...pick(run), ...fields };
	return {
		version,
		fingerprint,
		args,
		// 条件展开：值为 undefined 时连键都不出现，避免 JSON 里出现显式 undefined（JSON.stringify 会丢掉它，
		// 但文档对象在内存里会被比较/序列化，保持“没有这个键”更精确）。
		...(key === undefined ? {} : { key }),
		...(trace === undefined ? {} : { trace }),
		// phase/restarts/finishFailures 是必填字段，直接写入；若 fields 没覆盖，它们来自 pick(run)。
		phase,
		restarts,
		finishFailures,
		// abortMarked 在内存里是 boolean 标志，落盘改为存在性标志 `abort: true`；`true as const` 保证类型是字面量 true。
		...(abortMarked ? { abort: true as const } : {}),
		...(blocked === undefined ? {} : { blocked }),
		// outcome 是内存里的完整 Outcome（含 id/args/state），落盘前只保留 result/error 部分。
		...(outcome === undefined ? {} : { outcome: storedOutcome(outcome) }),
	};
}

/** The fields of `run` a record stores that change. */
// Required<Omit<...>> 是编译期类型运算：先去掉 blocked/outcome/abortMarked，再把剩余字段变成必填。
// 但函数返回时又用 StoredFields 交叉，允许这三个字段缺失；这么写是为了让调用处能安全解构必填的 phase/restarts/finishFailures。
// 运行期没有任何检查：run 的字段由 JobRun 维护，这里假设它们始终存在。
function pick(run: JobRun): Required<Omit<StoredFields, "blocked" | "outcome" | "abortMarked">> & StoredFields {
	// 解构 run 的可变字段；blocked/outcome 可能是 undefined，由调用方按需处理。
	const { phase, restarts, finishFailures, blocked, outcome } = run;
	// 只有 abortMarked 为真才带 abortMarked 键；其余字段直接透传（undefined 也作为值存在，随后被条件展开过滤）。
	return { phase, restarts, finishFailures, ...(run.abortMarked ? { abortMarked: true } : {}), blocked, outcome };
}

/** An outcome as stored: a result as it is (JSON: persisted jobs refuse `bytes()`), an error in the wire format. */
// 输入内存 Outcome，输出 StoredOutcome。done 分支只取 result；failed 分支把 JobError 转成 StoredJobError。
// `as JsonValue` 是编译期断言：defineJob 只对“持久化作业”禁止 bytes，普通作业的 result 仍可能含 Uint8Array，
// 但只有持久化作业会走到这里，因此该断言依赖声明阶段的约束，运行期不再检查。
function storedOutcome(outcome: AnyOutcome): StoredOutcome {
	// kind 是判别字段；分支内 TS 自动把 outcome 收窄到 done 变体。
	if (outcome.kind === "done") return { kind: "done", result: outcome.result as JsonValue };
	// 失败分支保留失败形状，错误字段交给 storedError 转换。
	return { kind: "failed", error: storedError(outcome.error) };
}

// threw 分支必须经过 wireError；aborted/restart_limit 的结构已经是纯 JSON，可以直接返回同一个对象。
// 这里没有兜底分支：JobError 的三个 kind 已覆盖，TS 的穷尽性检查（配合返回类型）能发现漏掉的分支。
function storedError(error: JobError): StoredJobError {
	return error.kind === "threw" ? { kind: "threw", error: wireError(error.error) } : error;
}

/** The outcome a stored one stands for, rebuilt as the in-memory one (`id`, `args` and `state` from the run). */
// 用途：从记录文档还原调用方看到的 Outcome。输入存储的部分结果 + 运行身份（id、args、state）。
// 输出完整的 AnyOutcome；无副作用。例：stored.kind === "done" 时返回 { id, args, state, kind: "done", result }。
// 注意：state 可能来自 chord.job-states 文档，调用方要先读出来再传入；undefined 表示该作业没有状态文档。
export function outcomeOf(
	stored: StoredOutcome,
	id: string,
	args: JsonValue,
	state: JsonValue | undefined,
): AnyOutcome {
	// done 分支直接拼装；result 已在持久化时确认是 JSON。
	if (stored.kind === "done") return { id, args, state, kind: "done", result: stored.result };
	// failed 分支先取出存储错误；解构只读，不修改 stored。
	const { error } = stored;
	// 只有 threw 需要把 WireError 还原成真正的错误对象；畸形信封会让 errorFromWire 抛协议错误。
	// `const rebuilt: JobError` 是显式类型注解，确保两个分支都符合内存错误形状。
	const rebuilt: JobError = error.kind === "threw" ? { kind: "threw", error: errorFromWire(error.error) } : error;
	// 拼回带运行身份的统一形状；调用方随后可按 kind 收窄。
	return { id, args, state, kind: "failed", error: rebuilt };
}

/** A stored record as Chord wrote it (the record definition's value, a JSON object). */
// 输入是文档引擎读出的 JsonObject；输出 StoredRun。
// `as unknown as` 是这里唯一一次双重断言：文档层的值类型是宽泛 JSON，无法从类型上证明它符合 StoredRun；
// 该保证来自写侧只由 storedRun 写入（见下方注释），而不是运行期校验。若存储被手工篡改，字段缺失会一直传到使用处。
export function recordOf(value: JsonObject): StoredRun {
	// Chord's own document: `storedRun` wrote it.
	// 不做字段级校验，是因为这个命名空间只由 Chord 自己写；这是已决定的信任边界，不是疏忽。
	return value as unknown as StoredRun;
}
