/*
 * 文件导读
 * ========
 * 所属：packages/chord/src/delta，Chord 共享的 Delta 模块；服务 watch、routines/jobs、remote hold 等
 * “一个状态对一个慢消费者”的场景。
 *
 * 职责边界：本文件只管理待发送 Op 的排队与折叠，不编码、不应用、不校验 op 形状。它保证队列里的 op
 * 按原顺序可重放；当同一路径出现多个可合并的叶子操作时，用等价但更短的操作替换它们；当积压超过上限时，
 * 放弃增量并通知调用方改用完整值替换。收到的 op 数组与元组绝不被原地修改（它们可能同时喂给其他消费者）。
 *
 * 上游入口：调用方在每次状态提交后调用 `push(ops)`；op 来自 Delta 的 tracker、`diffRevisions()` 或
 * `appendText()`。
 * 下游依赖/结果：消费者调用 `take()`，得到 `{ kind: "ops", ops }` 交给 encoder 编码或 applyImmutable 应用；
 * 或得到 `{ kind: "replace" }`，由调用方用当前完整值做根替换。`size` 用于判断“是否有积压需要发”。
 * 错误流向：本文件不抛业务错误；输入 op 的来源被信任。折叠失败（超过上限）不是异常，而是状态切到 replace。
 *
 * 能力清单：
 * - `PendingTake`：`take()` 的返回联合，区分“一批 op”与“请用当前值替换”。
 * - `MAX_PENDING_OPS = 10_000`：积压上限；超过后只保留 replace 语义。
 * - `PendingOps`：队列类。
 *   - `push(ops)`：追加一批提交产生的操作，必要时开始折叠。
 *   - `size`：折叠后的待处理数量；replace 状态固定为 1。
 *   - `take()`：取走全部内容并把队列重置为空。
 *   - 私有 `#fold`：逐条折叠并检查溢出。
 * 文件内辅助（未导出）：
 *   - `LeafOp`：可折叠的 `a`/原始值 `s` 元组类型。
 *   - `Folding` / `State`：队列状态与叶子索引的内部结构。
 *   - `mergeLeaf`、`pathKey`、`merge`：叶子合并的具体规则。
 *
 * 组合关系与典型顺序：
 *   每次提交 push -> 第一批按引用保存 -> 第二批开始折叠 -> 同路径叶子合并 -> 超限转 replace
 *   -> 消费者 take（或先看 size）-> 队列清空，继续下一轮。
 *
 * 示例（真实签名）：
 *   const pending = new PendingOps();
 *   pending.push([["s", ["n"], 1]]);
 *   pending.push([["s", ["n"], 2], ["a", ["text"], "x"]]);
 *   const taken = pending.take();
 *   // taken.kind === "ops"；其中 ["s",["n"],1] 已被 ["s",["n"],2] 取代。
 * 再次 take() 返回 kind 为 "ops"、ops 为空数组的共享常量，size 为 0。
 *
 * 建议阅读顺序：先读 `State` 与 `PendingTake` 理解状态机，再读 `push` 的四个分支，然后看 `#fold`
 * 与 `merge` 的折叠规则，最后读 `pathKey` 的键唯一性说明。
 */
// The pending queue: the ops a slow consumer of one state has not taken yet, folded while they wait.
import type { JsonValue } from "../json.ts";
import type { NonEmptyPath, Op, Path } from "./index.ts";

/**
 * What `PendingOps.take()` hands over: the pending ops, folded, or `replace` after an overflow, which the owner of the
 * queue turns into a root replacement with the current value.
 */
/**
 * `PendingOps.take()` 的返回类型，是一个可辨识联合（tagged union）：
 * - `{ kind: "ops", ops }`：正常情况，返回折叠后的操作；
 * - `{ kind: "replace" }`：队列曾因操作太多溢出，调用方应改用“当前完整值”做根替换。
 *
 * 调用方通过 `taken.kind === "ops"` 收窄类型后，才能访问 `taken.ops`；这是编译期保证。
 */
export type PendingTake = { readonly kind: "ops"; readonly ops: readonly Op[] } | { readonly kind: "replace" };

/** Pending ops past which only "replace with the current value" stays pending. */
/** 待处理操作数的上限；超过后队列进入 replace 状态，只保留“用当前值替换”这一个语义。 */
export const MAX_PENDING_OPS = 10_000;

/** A leaf op: an append, or a set of a primitive. The leaf index points at these only. */
/**
 * 叶子操作：追加字符串的 `a`，或把某个路径设为原始值（非对象）的 `s`。
 * `NonEmptyPath` 保证路径至少有一段；叶子索引只指向这两种 op。
 * 这里用只读元组类型精确描述 op 的形状，`op[0]` 是字面量 "a" / "s"，便于编译器收窄。
 */
type LeafOp = readonly ["a", NonEmptyPath, string] | readonly ["s", NonEmptyPath, JsonValue];

// 折叠状态的内部结构。
type Folding = {
	readonly kind: "folding";
	/** Owned by the queue until `take()` hands it over; never one of the received op arrays. */
	// 队列自己拥有的 op 数组，直到 take() 交出为止；绝不是外部传入的那个数组。
	readonly ops: Op[];
	/** Path key to the position of the last pending leaf op on that path. */
	// 路径键 -> 该路径上最后一个待处理叶子 op 在 ops 中的下标。
	readonly leaves: Map<string, number>;
};

// 队列状态机：同一时刻只会处于其中一种状态。
type State =
	| { readonly kind: "empty" }
	/** One batch, kept by reference: a consumer that keeps up never pays for folding. */
	// 只有一批操作时按引用保存：跟得上节奏的消费者完全不用为折叠付费。
	| { readonly kind: "batch"; readonly ops: readonly Op[] }
	| Folding
	/** Overflowed: nothing more accumulates until `take()` or a batch that starts with `r`. */
	// 已溢出：在 take() 或下一条以 `r` 开头的批次到来之前，不再累积任何 op。
	| { readonly kind: "replace" };

// 下面四个单例常量复用于不变的空/替换状态，避免每次 take()/push() 都分配新对象。
const EMPTY: State = { kind: "empty" };

const REPLACE: State = { kind: "replace" };

const NO_OPS: PendingTake = { kind: "ops", ops: [] };

const REPLACE_TAKE: PendingTake = { kind: "replace" };

/**
 * Pending ops of one state for one consumer, in order and raw (never encoded while they wait). `r` drops everything
 * before it. A leaf op merges into the last pending leaf op on the same path (`a` + `a` joined, `s` replaces `s` or `a`,
 * `a` after a string `s` appends into it); any other op clears the leaf index. Leaf ops on different paths commute,
 * except after an ancestor primitive `s`, after which the descendant cannot be written until a structural op clears the
 * index. Past `MAX_PENDING_OPS` only "replace with the current value" stays pending.
 *
 * Ops are only those of Delta's tracker, `diffRevisions()` and `appendText()`; received op arrays and tuples are never
 * mutated (they feed other consumers too), a merge makes a new tuple.
 */
/**
 * 单个状态、单个消费者的待发送操作队列，按顺序保存原始 op（等待期间不编码）。
 *
 * 折叠规则（都发生在同一路径上）：
 * - `a` + `a`：合并成一个 `a`，字符串直接拼接；
 * - `s` 覆盖之前的 `s` 或 `a`（后写者胜）；
 * - 字符串 `s` 后面的 `a`：合并成 `s`，值为两者拼接；
 * - 任何其他结构性 op（如 `p`、`m`、`d`、设置对象的 `s`）：清空叶子索引，因为路径语义可能已改变。
 *
 * `r` 会丢弃它之前的全部待处理操作。不同路径的叶子 op 通常可以交换顺序，但祖先被设为原始值后，
 * 后代写入在结构性 op 清空索引之前无法安全合并。
 *
 * 输入 op 只来自 Delta 自己的 tracker / `diffRevisions()` / `appendText()`，因此这里不重新校验形状。
 */
export class PendingOps {
	#state: State = EMPTY;

	/** Queue the ops of one commit. */
	/**
	 * 追加一次提交产生的一批操作。
	 *
	 * 输入：`ops`，只读的 op 数组；空数组直接忽略。
	 * 输出：无；副作用：推进内部状态，可能进入 folding 或 replace。
	 * 错误：无（信任 op 来源）。
	 *
	 * 例子：先 push([["s",["n"],1]])，再 push([["s",["n"],2]])，take() 得到一批只含 `["s",["n"],2]` 的 op。
	 */
	push(ops: readonly Op[]): void {
		if (ops.length === 0) return;
		const state = this.#state;
		// A batch that starts with `r` (the tracker's and `diffRevisions()`'s only place for it) drops everything
		// pending, also an overflow, and is kept as received.
		// 以 `r` 开头的批次（tracker 和 diffRevisions() 只会在首位放 `r`）意味着“整根已替换”，
		// 之前的一切待处理操作都作废，连 replace 溢出状态也一并清除；这一批按引用原样保存。
		if (ops[0]![0] === "r") {
			this.#state = { kind: "batch", ops };
			return;
		}
		switch (state.kind) {
			case "empty":
				// 第一批不折叠，直接引用保存；消费者如果每次都及时 take()，成本只是保存一个引用。
				this.#state = { kind: "batch", ops };
				return;
			case "batch": {
				// 第二批到来，必须把旧批次和新批次一起折叠进一个由队列拥有的新数组。
				const folding: Folding = { kind: "folding", ops: [], leaves: new Map() };
				this.#state = folding;
				// 旧批次可能折叠失败（溢出），此时不再折叠新批次，直接丢弃。
				if (this.#fold(state.ops, folding)) this.#fold(ops, folding);
				return;
			}
			case "folding":
				// 已有折叠状态，继续把新批次折进去。
				this.#fold(ops, state);
				return;
			case "replace":
				// 已溢出，后续 op 一律忽略；只有 take() 或新的 `r` 批次能结束这个状态。
				return;
		}
	}

	/**
	 * Pending ops after folding; 1 once overflowed (the replacement the owner sends). One batch is counted as received,
	 * so a single commit larger than `MAX_PENDING_OPS` counts in full until a second one arrives and overflows.
	 */
	/**
	 * 当前待处理操作数（折叠后的数量）；已溢出时返回 1，表示“一个替换”。
	 *
	 * 注意：单批操作按原样计入，因此一次超过 `MAX_PENDING_OPS` 的提交会完整计为它的长度，
	 * 直到第二批到达并触发溢出。这里返回的是 `number`，不是编译期常量。
	 */
	get size(): number {
		const state = this.#state;
		if (state.kind === "empty") return 0;
		return state.kind === "replace" ? 1 : state.ops.length;
	}

	/** Hand over everything pending and start empty. */
	/**
	 * 取走全部待处理内容并把队列重置为空。
	 *
	 * 输入：无；输出：`PendingTake`；副作用：状态变为 empty。
	 * 空队列返回共享的 `NO_OPS`；batch/folding 把内部 ops 数组的所有权交给调用方（调用方不得再改它）；
	 * replace 返回共享的 `REPLACE_TAKE`。
	 */
	take(): PendingTake {
		const state = this.#state;
		// 先重置状态，再根据旧状态构造返回值：取走后队列始终回到 empty。
		this.#state = EMPTY;
		switch (state.kind) {
			case "empty":
				return NO_OPS;
			case "batch":
			case "folding":
				return { kind: "ops", ops: state.ops };
			case "replace":
				return REPLACE_TAKE;
		}
	}

	/** Fold `ops` into `folding`; false once the queue overflowed into `replace`. */
	/**
	 * 把一批 op 折叠进 `folding`；一旦超过上限就切到 replace 并返回 false。
	 *
	 * 输入：`ops` 与目标 folding；输出：true 表示继续可折叠，false 表示已溢出。
	 * 副作用：修改 folding.ops、folding.leaves，可能在溢出时修改 this.#state。
	 * 流程：逐条 op 处理；能合并的叶子 op 直接 `continue`，否则清空叶子索引并 push；
	 *      每 push 一条就检查长度上限。
	 */
	#fold(ops: readonly Op[], folding: Folding): boolean {
		for (const op of ops) {
			switch (op[0]) {
				case "r":
					// 折叠过程中遇到根替换：之前累积的内容全部失效，重置数组和索引，
					// 然后这条 `r` 本身仍会被 push 到末尾（它代表新的起点）。
					folding.ops.length = 0;
					folding.leaves.clear();
					break;
				case "a":
					// 追加是叶子 op，优先尝试与同路径的上一条叶子合并。
					if (mergeLeaf(op, folding)) continue;
					break;
				case "s":
					// 只有设置原始值的 `s` 才算叶子；设置对象/数组会改变结构，必须清空索引。
					if (isPrimitive(op[2])) {
						if (mergeLeaf(op, folding)) continue;
					} else if (folding.leaves.size > 0) folding.leaves.clear();
					break;
				default:
					// 其他结构性 op（d/p/m/t）：之前的路径索引不再可信，清空。
					if (folding.leaves.size > 0) folding.leaves.clear();
			}
			// 未合并的 op 按顺序保留。
			folding.ops.push(op);
			// 超过上限就放弃折叠，转为 replace 语义：调用方将发送当前完整值。
			if (folding.ops.length > MAX_PENDING_OPS) {
				this.#state = REPLACE;
				return false;
			}
		}
		return true;
	}
}

// 运行时判断 JSON 原始值：null、字符串、数字、布尔。JSON 中没有 undefined/对象；
// 先判断 null 是因为 `typeof null === "object"`。
const isPrimitive = (value: JsonValue): boolean => value === null || typeof value !== "object";

/**
 * Merge the leaf op `op` into the last pending leaf op on its path, or index it as that op at the position it is about
 * to be pushed to. True when merged.
 */
/**
 * 尝试把叶子 op 合并到同路径上最后一个待处理叶子 op，或者把它登记为“即将 push 的位置”。
 *
 * 输入：`op` 叶子操作；`folding` 当前折叠状态。
 * 输出：true 表示已合并（调用方不应再 push）；false 表示未合并，索引已更新为 `folding.ops.length`。
 * 副作用：可能替换 folding.ops 中已有的元组，或写入 leaves。
 *
 * 注意：索引只指向叶子 op，因为任何 non-leaf op 都会清空 leaves；因此 `folding.ops[at]` 可以安全断言为 LeafOp。
 */
function mergeLeaf(op: LeafOp, folding: Folding): boolean {
	const key = pathKey(op[1]);
	const at = folding.leaves.get(key);
	if (at !== undefined) {
		// The index points at leaf ops only.
		const merged = merge(folding.ops[at] as LeafOp, op);
		if (merged !== undefined) {
			// 替换旧元组而不是修改它：旧元组可能仍被其他消费者引用。
			folding.ops[at] = merged;
			return true;
		}
	}
	// 没有可合并项：记住“这条 op 即将被 push 到的下标”。调用方随后 push，位置正好吻合。
	folding.leaves.set(key, folding.ops.length);
	return false;
}

/**
 * The key of a path in the leaf index. Injective, as merging two distinct paths would lose a write: `["a.b"]` and
 * `["a", "b"]` are different keys. A number and its string (`1`, `"1"`) may share one: within one index lifetime a
 * parent is either an array or an object, as changing it is a structural op that clears the index.
 */
/**
 * 把路径转成叶子索引的字符串键。
 *
 * 必须保证不同路径不会得到同一个键，否则合并会丢失一次写入：
 * `["a.b"]` 与 `["a","b"]` 必须区分开，而 `JSON.stringify` 正好会保留数组结构。
 * 数字下标 1 与字符串 "1" 也会得到不同的键（`[1]` 与 `["1"]`）。它们在对象属性语义上
 * 可能指向同一个位置，但这里宁可少合并也不误合并；改变容器种类属于结构性 op，会清空索引。
 */
function pathKey(path: Path): string {
	return JSON.stringify(path);
}

/** `next` folded into `previous` (same path), or undefined when they do not fold. */
/**
 * 把同一路径上的 `next` 折叠到 `previous` 中，返回新的叶子 op；不能折叠时返回 undefined。
 *
 * 组合规则：
 * - next 是 `s`：直接取代 previous（后写者胜），无论 previous 是 `s` 还是 `a`；
 * - previous 是 `a`、next 是 `a`：字符串拼接后仍是 `a`；
 * - previous 是字符串值的 `s`、next 是 `a`：等价于把拼接结果一次 `s`（tracker 从不对非字符串追加）；
 * - 其余（如 previous 是数字/布尔/对象，next 是 `a`）：无法折叠。
 */
function merge(previous: LeafOp, next: LeafOp): LeafOp | undefined {
	if (next[0] === "s") return next;
	if (previous[0] === "a") return ["a", previous[1], previous[2] + next[2]];
	// Only a string set takes an append; the tracker never appends to another primitive.
	if (typeof previous[2] === "string") return ["s", previous[1], previous[2] + next[2]];
	return undefined;
}
