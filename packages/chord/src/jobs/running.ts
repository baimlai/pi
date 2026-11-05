// A job's `running` (§15): a JSON watchable of its unsettled runs, one entry per run in start order, tagged by phase.
// It is a source of its own (keyed state documents publish nothing): the job tells it each change in the commit step,
// and a frame carries exactly the ops of those changes, a run's state ops re-pathed under its entry.

// 文件导读（job.running 可观察列表）
// 所属：packages/chord/src/jobs，Chord v2 作业模块的观察者视图层。
// 职责边界：维护“未结算运行”的 JSON 数组，并在每个批次内向 watcher 发布一次增量 op；不决定运行相位、不读写 store。
// 上游入口：records.ts 在提交步骤里调用 add/replace/stateChanged/remove，把运行记录的变化投影到这里；
// 对象结束时 records.ts 调用 end()。
// 下游依赖：state 层的 Source/Batch（watch/subscribers、changed、publish）与 delta 层的 Op 格式；
// 结果流向所有 watch/derive 这个 Source 的调用方（包括通过链接转发给远端成员的路径）。
// 错误流向：对象结束后读 value 抛 ChordError released/ended；Object 仍在但下标找不到（内部约定破坏）不会额外防护。
// 能力清单：
// - RunningEntry：公开的条目联合，running/finishing 带 args（可选 state），blocked 只带 reason。
// - Running：继承 Source 的列表实现，提供 add/replace/stateChanged/remove/deliver/end。
// - under：把状态文档内部的 op 重新挂到 [条目的下标, "state"] 下。
// 组合关系/典型顺序：运行开始 -> add(entry)；记录变化 -> replace(before, after)；状态文档变化 -> stateChanged；
// 运行结算 -> remove(entry)；批次结束由 Source 调度器调用 deliver，watcher 收到“当前完整值 + ops”。
// 示例（真实调用形状）：
//   running.add({ id: "r1", version: 1, args: { n: 1 }, phase: "running" });
//   running.stateChanged(before, after, [["s", ["n"], 2]]); // watcher 看到路径 [index, "state", "n"]
// 建议阅读顺序：先 RunningEntry 了解外部看到的形状，再 Running 的字段与四个变更方法，最后看 under 的 op 重写。
// 数据结构选择：每次变化复制整个列表（未结算运行通常很少），换取“已发布的值不可变”；未被观察时不生成 op。
// 条目里包含 args（以及可选 state），因此 running 能让调用方看到运行参数；blocked 条目刻意不带 args/state，
// 因为它可能来自旧版本的作业，当前代码未必能解释那些值。
import type { Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import type { NonEmptyPath, Op, Path } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import { type Batch, Source } from "../state/internal.ts";
import type { BlockedReason } from "./run.ts";

/**
 * One entry of `running`: a running or finishing run with its args (and state, when the job has a state document), or
 * a blocked run, which carries neither (it may be of another version than the code).
 */
// 判别字段是 phase：running/finishing 条目带 args，blocked 条目只带 reason。
// `[S] extends [undefined]` 写成元组，是为了阻止条件类型对联合类型逐个分配：
// 当 S 是 undefined 时结果为 unknown（等价于不加字段），否则要求恰好有 state: S。
// 这是编译期技巧；运行期条目形状由 records.ts 构造，没有逐字段校验。
// 小例子：RunningEntry<string, undefined> 没有 state；RunningEntry<string, {n:number}> 必须有 state。
export type RunningEntry<A, S> =
	| ({
			readonly id: string;
			readonly version: number;
			readonly key?: string;
			readonly args: A;
			readonly phase: "running" | "finishing";
	  } & ([S] extends [undefined] ? unknown : { readonly state: S }))
	| { readonly id: string; readonly version: number; readonly phase: "blocked"; readonly reason: BlockedReason };

const EMPTY: readonly JsonValue[] = [];

/**
 * The list behind `running`. Every change copies the list (O(unsettled runs)) and, while it is watched, records its
 * ops; the batch delivers them as one frame. Unwatched, no op is built.
 */
// 继承 Source 而不是自己实现 Watchable：Source 提供 watches/subscribers、批内 changed 标记和 publish。
// 与其他 document source 不同的是，它的值不是某个 JSON 对象，而是一个条目数组；因此 op 使用数组路径（["p", [], index, ...]）。
// 例（真实行为）：两个运行开始时，watcher 在一个批次内收到一帧，含两个插入 op；没有 watcher 时只复制 @list，不分配 op。
export class Running extends Source {
	/** The job in errors. */
	readonly #label: string;
	/** `undefined` once its object ended: reads throw `released`, and no ended run's args or state are kept. */
	// 结束时刻意丢掉列表：既让读到旧值成为错误，也释放 args/state 的引用，避免对象结束后仍被 watcher 持有。
	#list: readonly JsonValue[] | undefined = EMPTY;
	/** The ops of the current batch's changes, kept only while watched. */
	// 一个批次内可能多次改列表（开始、状态变化、结束），#ops 累积这些增量，deliver 时一次发出。
	#ops: Op[] = [];
	/** Whether the current batch listed this source for a frame. */
	// 每个批次只需把本 source 标记一次；#listed 防止重复调用 batch.changed / 重复记录。
	#listed = false;

	constructor(batch: Batch, label: string) {
		// 把 batch 交给 Source 保存：所有变化与投递都发生在当前批次内。
		super(batch);
		this.#label = label;
	}

	get value(): JsonValue {
		// A list of JSON entries, shared and never mutated once published.
		// 返回内部数组的引用而不是副本：调用方按约定只读；Source 的帧也是共享值。
		return this.#current() as JsonValue;
	}

	/** Appends the entry of a new run. */
	// 输入是一个已由 records.ts 组装好的 JSON 条目；输出 void。
	// 副作用：替换内部列表并可能记录一个插入 op。例：开始运行 r1 后列表从 [] 变成 [entry(r1)]。
	add(entry: JsonValue): void {
		// 展开复制，而不是 push：旧列表可能已经被某个 watch 持有，不能被修改。
		const list = [...this.#current(), entry];
		this.#list = list;
		// #mark 返回“是否需要记录 op”（只有被观察时）；插入 op 的五个分量是 [tag, path, index, deleteCount, items]。
		if (this.#mark()) this.#ops.push(["p", [], list.length - 1, 0, [entry]]);
	}

	/** Replaces a run's entry `before` by `after` (its record changed). */
	// 按对象身份查找旧条目（indexOf 是引用相等），再整体替换；用于 phase/restarts 等普通字段变化。
	replace(before: JsonValue, after: JsonValue): void {
		const index = this.#replaced(before, after);
		// 记录路径为 [index] 的 set op；watch 端会据此只更新一个条目。
		if (this.#mark()) this.#ops.push(["s", [index], after]);
	}

	/** Replaces a run's entry `before` by `after`, whose state document changed by `ops`. */
	// 运行状态文档变化时，running 条目里的 state 字段也要跟着变；但 state 的增量 op 是相对 state 根的，
	// 这里用 under() 把它们重新挂到 [index, "state"] 下，保持与条目在列表中的位置一致。
	stateChanged(before: JsonValue, after: JsonValue, ops: readonly Op[]): void {
		const index = this.#replaced(before, after);
		if (this.#mark()) for (const op of ops) this.#ops.push(under([index, "state"], op));
	}

	/** Removes a run's entry. */
	// indexOf 找不到时返回 -1；调用方保证 entry 来自当前列表（内部约定，不做运行期防御）。
	remove(entry: JsonValue): void {
		const list = this.#current();
		const index = list.indexOf(entry);
		// toSpliced 返回新数组，不修改原数组（ES2023）；语义等价于 splice，但保持旧值可安全共享。
		this.#list = list.toSpliced(index, 1);
		// 删除 op：[tag, path, index, deleteCount, items]；items 为空。
		if (this.#mark()) this.#ops.push(["p", [], index, 1, []]);
	}

	// Source 的投递钩子：批次结束时调用。先把累积的 ops 取走并清空批次状态，再发布“当前完整值 + 本批 ops”。
	// retired 固定为 false：running 列表本身没有“文档退役”概念；对象结束时走 end()，而不是这个标志。
	deliver(context: Context): void {
		const ops = this.#ops;
		this.#ops = [];
		this.#listed = false;
		this.publish(this.#current() as JsonValue, ops, false, context);
	}

	/** Its object ended: every watch ends, and the list goes. */
	// 结束是单向的：watch 收到 ended，之后 value 读取抛 released；#list 置 undefined 也释放条目引用。
	end(): void {
		this.#list = undefined;
		this.#ops = [];
		this.endWatches();
	}

	// 读取当前列表的统一入口：对象结束后抛 ChordError released/ended，而不是返回 undefined。
	#current(): readonly JsonValue[] {
		if (this.#list === undefined) {
			throw new ChordError({ code: "released", reason: "ended", message: `${this.#label}: ended` });
		}
		return this.#list;
	}

	/** Copies the list with `after` in the place of `before`; returns that place. */
	// with() 也是非变异数组方法，返回替换了指定下标的新数组；返回 index 供调用方拼 op。
	// 若 before 不在列表中，index 为 -1，with(-1, ...) 实际会写到最后一个元素；调用方以对象身份保证不会发生。
	#replaced(before: JsonValue, after: JsonValue): number {
		const list = this.#current();
		const index = list.indexOf(before);
		this.#list = list.with(index, after);
		return index;
	}

	/**
	 * Records that the list changed, in the batch running now: derives over it are marked; while watched it is listed
	 * once per batch for a frame. Returns whether the change's ops are to be recorded (only while watched).
	 */
	// 两种情况：
	// 1) 没有 watcher：只需 changed() 通知依赖它的 derive，不构造 op（省分配）；
	// 2) 有 watcher：本批第一次变化时 changed() 一次，并返回 true 让调用方记录 op；后续变化只记录 op。
	// changed() 内部还会遍历 dependents 标记脏，因此即使没有 watcher，derive 也能看到新值。
	#mark(): boolean {
		if (!this.watched) {
			this.changed();
			return false;
		}
		if (!this.#listed) {
			this.#listed = true;
			this.changed();
		}
		return true;
	}
}

/** `op` of a value at `prefix` inside a larger one: a replacement becomes a set there. */
// 输入前缀 [列表下标, "state"] 和 state 内部的 op，输出在新根路径下的 op。
// 根替换 r 在子路径上必须变成 s（set）：不能替换整个条目，只能替换条目里的 state。
// `at` 把相对路径拼成 [index, "state", ...path]；类型 NonEmptyPath 保证拼接后非空。
// switch 覆盖 Op 的全部 tag，没有 default：新增 tag 时 TS 会用返回类型发现遗漏。
function under(prefix: readonly [number, string], op: Op): Op {
	const at = (path: Path): NonEmptyPath => [prefix[0], prefix[1], ...path];
	switch (op[0]) {
		case "r":
			return ["s", prefix, op[1]];
		case "s":
			return ["s", at(op[1]), op[2]];
		case "d":
			return ["d", at(op[1])];
		case "a":
			return ["a", at(op[1]), op[2]];
		case "t":
			return ["t", at(op[1]), op[2]];
		case "p":
			return ["p", at(op[1]), op[2], op[3], op[4]];
		case "m":
			return ["m", at(op[1]), op[2]];
	}
}
