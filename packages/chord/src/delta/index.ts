/*
 * 文件导读
 * ========
 * 所属：packages/chord/src/delta，Chord 共享的 Delta 模块的公共入口与核心协议定义。
 *
 * 职责边界：定义“操作”的两种词汇——内存/磁盘使用的 `Op` 与跨边界使用的 `WireOp`；提供运行时校验、
 * 路径安全规则、可变与不可变两种应用器，以及 encoder/decoder 压缩对。它不产生 op（那是 tracker.ts 与
 * diff.ts 的职责），也不负责副本生命周期、重连或状态管理。
 *
 * 上游入口：tracker.ts 的 `prepare()`、diff.ts 的 `diffRevisions()`、tracker.ts 的 `appendText()` 产生 Op；
 * 边界层（连接、link、remote hold）在发送前调用 `encoder()`，接收端调用 `decoder()`。
 * 下游依赖/结果：`apply()` 原地修改可变值；`applyImmutable()`/`applyImmutableBatches()` 用写时复制
 * 得到新值，供不可变副本消费；`PendingOps`（从 pending.ts 再导出）折叠慢消费者的待发送操作。
 * 错误流向：形状问题抛 `TypeError`；危险路径段抛 `UnsafePathError`；路径走不通或目标类型不符抛
 * `PathError`。校验只覆盖形状/路径，不检查 payload 是否为严格 JSON。
 *
 * 能力清单（导出项，按类别）：
 * - 路径类型：`Seg`（字符串键或数字下标）、`Path`（只读段数组）、`NonEmptyPath`（至少一段）、
 *   `PathRef`（内联路径或编码器分配的整数 id）。
 * - 操作类型：`Op`（解码后的 r/s/d/a/t/p/m 元组联合）、`WireOp`（增加 `#` 字典、id 引用和短元组）。
 * - 分类常量：`isReplace`（是否根替换）、`isBase`（批次是否以根替换开头）。
 * - 字符串辅助：`overlap`（最长后缀-前缀重叠）、`ownedSlice`（切断 V8 切片对原串的引用）。
 * - 安全与校验：`RESERVED_SEGMENTS`（原型链危险键集合）、`UnsafePathError`、`PathError`、
 *   `assertValidOp`、`assertValidWireOp`、`assertSafePath`。
 * - 应用器：`apply`（可变、原地）、`applyImmutable`（单批不可变）、`applyImmutableBatches`
 *   （多批只保留最终结果）。
 * - 编解码：`Encoder`/`encoder()`、`Decoder`/`decoder()`。
 * - 再导出：`diffRevisions`、`Draft`、`track`/`Tracker`/`Change`/`Prepared`/`StringKeys`/`appendText`、
 *   `PendingOps`/`PendingTake`。
 * 文件内辅助（未导出）：`isObj`、`assertPathArg`、`assertPermutation`、`assertIndexInRange`、`applyOps`、
 *   `appendCopy`、`copyContainers`、`resolveValue`、`resolve`、`pathKey`。
 *
 * 组合关系与典型顺序：
 *   写入方 track -> 修改 Draft -> prepare() 得到 Op[] -> 发送前 encoder().encode(ops)
 *   接收方 decoder().decode(wire) -> applyImmutable(base, ops)（副本只保留最终状态）。
 *   可变消费者直接 apply(target, ops)；慢消费者用 PendingOps 折叠等待中的 op 再编码/应用。
 *   Op 是内存、网络、磁盘共用的唯一表示；路径字典只存在于 encode 与 decode 之间，apply 不认识 id/短形式。
 *
 * 依赖约束：Delta 只依赖纯 JSON 与自身模块，不依赖 harness 的其他部分；保持依赖箭头指向这里，
 * 不要反向引用上层。
 *
 * 示例（真实签名）：
 *   const ops: Op[] = [["s", ["n"], 1], ["s", ["n"], 2]];
 *   const next = applyImmutable({ n: 0 }, ops);       // { n: 1 } 之后 { n: 2 }，原对象不变
 *   const wire = encoder().encode(ops);               // 第二条省略了路径
 *   const decoded = decoder().decode(wire);           // 还原成两条完整 Op
 *   const mutated = apply({ n: 0 }, decoded);         // 原地修改并返回同一个根
 * 注意 encoder/decoder 必须按配对的状态流使用；跨流复用 id 会解码失败。
 *
 * 建议阅读顺序：先看 `Seg`/`Path`/`Op`/`WireOp` 两组类型与分类函数，再读路径安全与两个校验器，
 * 然后读 `apply` 的主循环，接着读 `applyImmutableBatches` 的写时复制路径，最后读 encoder/decoder。
 * tracker 与 diff 分别在同目录的 tracker.ts、diff.ts，用法从本文件的再导出进入。
 */
import type { JsonValue } from "../json.ts";

// 重新导出 JsonValue，让使用 `@earendil-works/chord/delta` 的调用方不必再单独导入 json.ts。
export type { JsonValue } from "../json.ts";

// 类型谓词：非 null 的对象。注意数组也满足 object；这里只用来区分标量与容器。
const isObj = (value: unknown): value is object => value !== null && typeof value === "object";

// ─────────────────────────────────────────────────────────────────────────────
// chord/delta — immutable revision tracking and operations over plain JSON.
//
// Depends on nothing else in the harness. Session storage, the runtime and the
// facet host consume it; keep the arrows pointing that way.
// ─────────────────────────────────────────────────────────────────────────────

// Seg 是路径的一段：对象键用字符串，数组下标用数字。
export type Seg = string | number;
// Path 是只读的段数组；NonEmptyPath 在类型层面保证至少一段，供 s/d/a/t 使用（它们不能写根）。
export type Path = readonly Seg[];
export type NonEmptyPath = readonly [Seg, ...Seg[]];

/** A path inline, or an id assigned by the encoder on second use. */
// PathRef 出现在 WireOp 里：要么直接内联路径，要么是编码器分配的整数 id。
// 泛型 P extends Path 让 s/d/a/t 仍能要求非空路径；默认值 Path 供 p/m 使用（可以写根数组）。
export type PathRef<P extends Path = Path> = P | number;

/**
 * Tuples are the form — in memory, on the wire, on disk.
 *
 * `r` is the ONLY op that replaces a whole value. `s`/`d`/`a`/`t` cannot target
 * the root: the type forbids it. `p` and `m` may, because a tracked value can
 * itself be an array. Operation shape is not canonical: an array may be emptied by either
 * a replacement or a root splice.
 *
 * `Op` knows nothing about the path dictionary. Interning, id references and
 * omitted paths live in `WireOp` and exist only between `encode` and `decode`.
 */
// Op 是解码后的操作联合类型。每个成员都是一个只读元组，第一个元素是“动词”字面量：
// - r: 用 payload 整体替换根（唯一能替换整个值的 op）；
// - s: 把路径末端设为 payload；
// - d: 删除路径末端（数组用 splice 保持稠密）；
// - a: 在路径末端的字符串后追加；
// - t: 从路径末端的字符串截断到指定长度；
// - p: 对路径指向的数组执行 splice(start, removeCount, ...items)；
// - m: 按置换重排路径指向的数组，new[i] = old[permutation[i]]。
// 这些元组在运行时就是普通数组；readonly 只限制 TypeScript 调用方不得原地改元组。
export type Op =
	| readonly ["r", JsonValue]
	| readonly ["s", NonEmptyPath, JsonValue]
	| readonly ["d", NonEmptyPath]
	| readonly ["a", NonEmptyPath, string]
	| readonly ["t", NonEmptyPath, number]
	| readonly ["p", Path, number, number, JsonValue[]]
	/** Reorder an array in place: `new[i] = old[permutation[i]]`. */
	| readonly ["m", Path, number[]];

/**
 * What crosses a boundary. Adds two compressions and nothing else:
 *
 *   ["#", id, path]    defines an id, emitted on a path's SECOND use
 *   a numeric PathRef  references a previously defined id
 *   a shortened tuple  reuses the previous op's path; arity disambiguates
 *
 * ["r", value] carries no path, so it encodes to itself — which is why isBase
 * works unchanged on either vocabulary.
 */
// WireOp 是跨边界的形式，只比 Op 多两种压缩：
// 1. 路径 id：某路径第二次出现时先发 ["#", id, path] 定义，之后用数字 id 引用；
// 2. 短元组：与上一条 op 路径相同时省略路径，靠元组长度（arity）区分短形式与完整形式。
// 注意短形式的歧义全靠长度：例如 ["s", value] 是短形式，而 ["s", path, value] 是完整形式。
// decoder 必须与配对 encoder 的状态流一致；路径 id 是跨批次唯一的共享状态。
export type WireOp =
	| readonly ["r", JsonValue]
	| readonly ["s", PathRef<NonEmptyPath>, JsonValue]
	| readonly ["s", JsonValue]
	| readonly ["d", PathRef<NonEmptyPath>]
	| readonly ["d"]
	| readonly ["a", PathRef<NonEmptyPath>, string]
	| readonly ["a", string]
	| readonly ["t", PathRef<NonEmptyPath>, number]
	| readonly ["t", number]
	| readonly ["p", PathRef, number, number, JsonValue[]]
	| readonly ["p", number, number, JsonValue[]]
	| readonly ["m", PathRef, number[]]
	| readonly ["m", number[]]
	| readonly ["#", number, Path];

// ─── Classification ──────────────────────────────────────────────────────────

// 判断一条 op 是否是根替换。Op 与 WireOp 的 r 形式相同，所以同一个函数对两种词汇都适用。
// 返回 boolean 而不是类型谓词：调用方通常只关心分支，不依赖收窄后的类型。
export const isReplace = (op: Op | WireOp): boolean => op[0] === "r";

/**
 * A batch begins with a replacement. Flush guarantees `r` is at index 0 or absent,
 * so this is exact rather than a heuristic.
 */
// 判断一批 op 是否以根替换开头（即“基线”批次）。空数组返回 false。
// `ops[0]!` 的非空断言是安全的：前面已经用 `ops.length > 0` 保证存在。
export const isBase = (ops: readonly (Op | WireOp)[]): boolean => ops.length > 0 && ops[0]![0] === "r";

// ─── Overlap ─────────────────────────────────────────────────────────────────

/**
 * Longest suffix of `a` that is a prefix of `b`. Probes with indexOf and verifies
 * exact substring equality, so the hot loops are native. A hand-written KMP is
 * asymptotically equivalent and much slower in practice.
 *
 * Always correct: the returned n satisfies a.slice(a.length - n) === b.slice(0, n).
 */
/**
 * 求 `a` 的后缀中，最长的、同时是 `b` 前缀的长度。
 *
 * 用途：diff 把“旧字符串变成新字符串”压缩成更小的操作（避免整串替换）。
 * 输入：
 * - `a`、`b`：旧/新字符串；
 * - `scan`：只检查 `a` 末尾多少个字符（限制成本）；
 * - `probe`：先用多长的 `b` 头部做索引，默认 64；
 * - `maxCandidates`：最多尝试多少个匹配位置，默认 8。
 * 输出：重叠长度 n（0 表示没有）。保证 `a.slice(a.length - n) === b.slice(0, n)`。
 * 错误：无；这是纯函数，无副作用。
 *
 * 算法：从 `b` 头取一段 head，用原生 `indexOf` 在 `a` 的尾部反复找出现位置，
 * 命中后用 `slice` 比较剩余部分是否完全相等。先用长 head（候选少、能快速发现大重叠），
 * 找不到再退化为单字符 head（能发现任意重叠，但候选多）。候选数超过上限就放弃并返回 0，
 * 调用方会退化为一次 `s`（更大但绝不错误）。对于重复度高的文本（如构建日志），
 * 这个上限避免在成千上万个相同位置之间反复扫描。
 *
 * 例子：overlap("abcdef", "cdefgh", 100) 返回 4，因为 "cdef" 同时是 a 的后缀和 b 的前缀。
 */
export function overlap(a: string, b: string, scan: number, probe = 64, maxCandidates = 8): number {
	// 边界情况：任一为空，或调用方不允许扫描，直接没有重叠。
	if (a.length === 0 || b.length === 0 || scan === 0) return 0;
	// 只保留 a 的末尾 scan 个字符作为搜索范围；a 比 scan 短时就用整个 a。
	const tail = a.length > scan ? a.slice(a.length - scan) : a;

	// A probe of length h can only find overlaps of at least h — the head must
	// actually occur in `a`. So try a long head first (few candidates, and it
	// catches the large overlaps a rolling window produces), then fall back to one
	// character, which finds any overlap at the cost of more candidates.
	//
	// Candidates are bounded because repetitive output — a build log, or any run of
	// one character — makes a long head match at thousands of positions. Giving up
	// returns 0, which emits a set: larger, never wrong.
	// 两轮探测：先长 head，再单字符。`Math.min(probe, b.length)` 防止 b 比 probe 短时越界。
	for (const h of [Math.min(probe, b.length), 1]) {
		const head = b.slice(0, h);
		let tried = 0;
		// 从 tail 中找到 head 的每个出现位置 k，k 之后的长度就是候选重叠 n。
		for (let k = tail.indexOf(head); k !== -1; k = tail.indexOf(head, k + 1)) {
			// 先自增再比较：超过 maxCandidates 就停止这一轮探测。
			if (++tried > maxCandidates) break;
			const n = tail.length - k;
			// n 不能超过 b 的长度；再用完整 slice 相等确认，避免仅凭 head 命中就误判。
			if (n <= b.length && tail.slice(k) === b.slice(0, n)) return n;
		}
		// 单字符那一轮之后没有更长的探测可退，结束循环。
		if (h === 1) break;
	}
	// 没有找到可信重叠：返回 0，调用方将生成更大的替换操作。
	return 0;
}

/**
 * `text.slice(start, end)` as a string of its own. V8 represents a slice of 13 or more characters as a view that keeps
 * all of `text` alive, so an append op cut from a long, growing string would retain that whole string for as long as
 * the op lives: in a delta chain, a watch backlog, or a value built by applying the op. Appending a character and
 * slicing it off again makes V8 copy just the slice.
 */
/**
 * 把 `text.slice(start, end)` 变成一段独立、不引用原字符串内存的拷贝。
 *
 * 为什么需要：V8 对长度 >= 13 的 slice 结果常用“视图”表示，视图会持有整个原字符串。
 * 如果 append op 从一条很长的滚动日志里切下一小段，这条 op 在 delta 链、watch 积压或应用后的值中
 * 存活多久，原字符串就被保留多久。这里先拼接一个空格（强制生成新字符串），再切掉空格，
 * 让 V8 复制这段内容而不是保留原串。
 *
 * 输入：文本、起点、终点（默认到末尾）；输出：内容相同但内存独立的字符串。
 * 副作用：无（不修改参数）；错误：无。
 *
 * 例子：ownedSlice("abcdef", 2, 4) 返回 "cd"，且不持有 "abcdef" 的底层存储。
 */
export function ownedSlice(text: string, start: number, end = text.length): string {
	return `${text.slice(start, end)} `.slice(0, -1);
}

// ─── Immutable revision tracking ─────────────────────────────────────────────

// 重新导出 tracker 与 diff 的公共 API，使 `@earendil-works/chord/delta` 成为单一入口。
// 这里只转发符号，不在 index.ts 内实现它们。
export { diffRevisions } from "./diff.ts";
export type { Draft } from "./draft.ts";
export { appendText, type Change, type Prepared, type StringKeys, type Tracker, track } from "./tracker.ts";

// ─── Pending ops of a slow consumer ──────────────────────────────────────────

// 慢消费者的折叠队列；实现见 pending.ts。
export { PendingOps, type PendingTake } from "./pending.ts";

// ─── Path safety ─────────────────────────────────────────────────────────────

/**
 * Segments that reach the prototype chain.
 *
 * `JSON.parse` is safe on its own — it makes `__proto__` an own property. What is
 * not safe is `parent[key] = value`, which is exactly what an applier does, and
 * paths are data: `["s", ["__proto__", "isAdmin"], true]` pollutes
 * `Object.prototype` for the whole process.
 *
 * Ops arrive from a facet, a plugin compartment, or a tool whose details may echo
 * model output, so none of it is trusted input.
 */
/**
 * 会被当成“通往原型链”的危险路径段。
 *
 * 为什么单独列出来：`JSON.parse` 本身会把 `__proto__` 建成自有属性，是安全的；
 * 危险的是应用器里的 `parent[key] = value` 写法。路径是数据：
 * `["s", ["__proto__", "isAdmin"], true]` 一旦被直接赋值，就会污染整个进程的
 * `Object.prototype.isAdmin`。因此所有来自边界（facet、插件隔离区、工具回显模型输出）的路径都不被信任。
 *
 * 用 ReadonlySet<string> 标注，类型上禁止调用方 add/delete，但运行时它仍是可变 Set，只是不导出修改入口。
 */
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * 路径中出现危险段时抛出的错误。
 *
 * `segment` 记录具体是哪一段；`name` 设为类名，便于日志和 `instanceof` 之外的字符串判断。
 * 注意构造函数没有使用 TypeScript 的“参数属性”简写（`constructor(readonly segment: Seg)`），
 * 因为 Node 的 --experimental-strip-types 只支持可擦除语法，参数属性需要 JS 代码生成，会被拒绝。
 */
export class UnsafePathError extends Error {
	// Not a parameter property: Node's --experimental-strip-types rejects those,
	// and these files are meant to run under it directly.
	readonly segment: Seg;
	constructor(segment: Seg) {
		super(`unsafe path segment: ${String(segment)}`);
		this.segment = segment;
		this.name = "UnsafePathError";
	}
}

/**
 * Verb, arity and payload shape for a **decoded** op: paths inline, no `#`, no
 * short forms. `apply` uses this.
 *
 * Validating `Op` against the wire grammar would be laxer than the type: a
 * two-element `["s", value]` would pass, and `apply` would then read the value as
 * a path. Each vocabulary gets the validator that matches it.
 */
/**
 * 校验一条“已解码”的 Op：路径内联、没有 `#`、没有短形式；`apply` 在应用前调用它。
 *
 * 输入：unknown（运行时数据，可能来自 JSON.parse 或 JS 调用方）。
 * 输出：无返回值；通过后 TypeScript 由 `asserts op is Op` 断言签名把 op 收窄为 Op。
 * 错误：形状不对时抛 TypeError，消息指出具体字段。
 * 副作用：可能调用 assertSafePath（抛 UnsafePathError），不修改 op。
 *
 * 校验范围仅限：动词、元组长度、路径结构/安全性、下标与置换的整数性。
 * 它不检查 payload 是否为严格 JSON，也不检查路径在目标值中是否真的存在——那些分别由
 * tracker 的输入约定和 `apply` 的 resolve 阶段处理。
 *
 * 例子：assertValidOp(["s", ["a"], 1]) 通过；assertValidOp(["s", "a", 1]) 抛 TypeError（路径不是数组）。
 */
export function assertValidOp(op: unknown): asserts op is Op {
	// 所有 op 都必须是至少含一个元素的元组（运行时即数组）。
	if (!Array.isArray(op) || op.length === 0) throw new TypeError("op is not a tuple");
	// 按首元素（动词）分派。每个分支都同时检查长度和该动词特有的字段。
	switch (op[0]) {
		case "r":
			// r 只有两个元素：动词与替换值；payload 内容不在这里校验。
			if (op.length !== 2) throw new TypeError("r arity");
			return;
		case "s":
			if (op.length !== 3) throw new TypeError("s arity");
			// 第二个参数必须是非空安全路径，第三个参数是任意 JsonValue 形状（未深查）。
			assertPathArg(op[1], true);
			return;
		case "d":
			if (op.length !== 2) throw new TypeError("d arity");
			assertPathArg(op[1], true);
			return;
		case "a":
			// a 的值必须是字符串；同时要求非空安全路径。
			if (op.length !== 3 || typeof op[2] !== "string") throw new TypeError("a shape");
			assertPathArg(op[1], true);
			return;
		case "t":
			// t 的保留长度必须是非负整数。
			if (op.length !== 3 || !Number.isInteger(op[2]) || op[2] < 0) throw new TypeError("t shape");
			assertPathArg(op[1], true);
			return;
		case "p": {
			// p 允许空路径（对根数组做 splice），所以 assertPathArg 不传 nonEmpty。
			if (op.length !== 5) throw new TypeError("p arity");
			assertPathArg(op[1]);
			if (!Number.isInteger(op[2]) || op[2] < 0) throw new TypeError("p index");
			if (!Number.isInteger(op[3]) || op[3] < 0) throw new TypeError("p remove");
			if (!Array.isArray(op[4])) throw new TypeError("p items");
			return;
		}
		case "m":
			if (op.length !== 3) throw new TypeError("m arity");
			assertPathArg(op[1]);
			assertPermutation(op[2]);
			return;
		// Silently skipping an unknown verb is how a newer producer's op vanishes.
		// 未知动词必须报错：静默跳过会把新版本生产者的 op 悄悄丢掉。
		default:
			throw new TypeError(`unknown op verb: ${String(op[0])}`);
	}
}

// 校验路径参数：必须是数组；按需要求非空；所有段都必须安全。
// nonEmpty 有默认值 false，所以 p/m 可以直接调用 assertPathArg(op[1])。
function assertPathArg(p: unknown, nonEmpty = false): void {
	if (!Array.isArray(p)) throw new TypeError("path is not an array");
	if (nonEmpty && p.length === 0) throw new TypeError("path is empty");
	// 经过数组检查后才能断言为 Path；assertSafePath 会逐个检查段。
	assertSafePath(p as Path);
}

/**
 * 校验置换必须是一个双射：长度 n 的数组恰好包含 0..n-1 各一次。
 *
 * 输入：unknown；输出：无；错误：非数组、非整数、越界或重复时抛 TypeError。
 * 副作用：分配一个长度为 n 的 Uint8Array 作为“已出现”标记，O(n) 时间/空间。
 * `asserts value is number[]` 让调用方在之后把值当 number[] 使用。
 */
function assertPermutation(value: unknown): asserts value is number[] {
	if (!Array.isArray(value)) throw new TypeError("m permutation is not an array");
	// Uint8Array 每个元素初始为 0；seen[i] 为 1 表示下标 i 已出现过。
	const seen = new Uint8Array(value.length);
	for (const index of value) {
		if (!Number.isInteger(index) || index < 0 || index >= value.length || seen[index] !== 0) {
			throw new TypeError("m permutation is not a bijection");
		}
		seen[index] = 1;
	}
}

/** The same, for the wire grammar: ids and short forms are legal here. */
/**
 * 校验 WireOp 的线格式：这里允许路径 id 与短形式，其它形状规则与 Op 类似。
 *
 * 输入：unknown（跨边界的不可信数据）；输出：无，通过后收窄为 WireOp。
 * 错误：TypeError；路径 id 未定义不会在这里报错（由 decoder 解析时抛 PathError）。
 * 副作用：可能抛 UnsafePathError；不修改输入。
 *
 * 关键安全点：`okRef` 拒绝字符串路径。若不拒绝，`"a".slice(0, -1)` 会得到空字符串，
 * 进而被当作根路径写入——一个“不是路径的东西”被接受成路径。
 */
export function assertValidWireOp(op: unknown): asserts op is WireOp {
	if (!Array.isArray(op) || op.length === 0) throw new TypeError("op is not a tuple");
	// 只取首元素作动词；其余字段在各分支里按位置读取。
	const [verb] = op as unknown[];
	// 局部闭包校验“路径引用”：数字 id 或内联路径数组。闭包复用 op 的上下文，不单独导出。
	const okRef = (r: unknown): void => {
		if (typeof r === "number") {
			if (!Number.isInteger(r) || r < 0) throw new TypeError("bad path id");
			return;
		}
		// A string is not a path. Unchecked, `"a".slice(0, -1)` is `""`, so it
		// resolves to the ROOT and writes there — a path that is not a path, accepted.
		if (!Array.isArray(r)) throw new TypeError("path is not an array");
		assertSafePath(r as Path);
	};
	switch (verb) {
		case "r":
			if (op.length !== 2) throw new TypeError("r arity");
			return;
		case "s":
			// 长度 3：完整形式 ["s", ref, value]；长度 2：短形式 ["s", value]。
			if (op.length === 3) okRef(op[1]);
			else if (op.length !== 2) throw new TypeError("s arity");
			return;
		case "d":
			// 长度 2：["d", ref]；长度 1：短形式 ["d"]。
			if (op.length === 2) okRef(op[1]);
			else if (op.length !== 1) throw new TypeError("d arity");
			return;
		case "a":
			if (op.length === 3) {
				okRef(op[1]);
				if (typeof op[2] !== "string") throw new TypeError("a value");
			} else if (op.length === 2) {
				// 短形式里 op[1] 是追加值本身，不是路径。
				if (typeof op[1] !== "string") throw new TypeError("a value");
			} else throw new TypeError("a arity");
			return;
		case "t":
			if (op.length === 3) {
				okRef(op[1]);
				// `as number` 在 Number.isInteger 检查后才有意义；运行时先做检查再比较。
				if (!Number.isInteger(op[2]) || (op[2] as number) < 0) throw new TypeError("t count");
			} else if (op.length === 2) {
				if (!Number.isInteger(op[1]) || (op[1] as number) < 0) throw new TypeError("t count");
			} else throw new TypeError("t arity");
			return;
		case "p": {
			// 完整形式长度 5：[p, ref, index, remove, items]；短形式长度 4：[p, index, remove, items]。
			// 其他长度用空数组解构，让 items 为 undefined，随后统一报 arity。
			const [i, r, items] = op.length === 5 ? [op[2], op[3], op[4]] : op.length === 4 ? [op[1], op[2], op[3]] : [];
			if (items === undefined) throw new TypeError("p arity");
			if (op.length === 5) okRef(op[1]);
			if (!Number.isInteger(i) || (i as number) < 0) throw new TypeError("p index");
			if (!Number.isInteger(r) || (r as number) < 0) throw new TypeError("p remove");
			if (!Array.isArray(items)) throw new TypeError("p items");
			return;
		}
		case "m":
			// 完整形式 ["m", ref, permutation]；短形式 ["m", permutation]。
			if (op.length === 3) okRef(op[1]);
			else if (op.length !== 2) throw new TypeError("m arity");
			assertPermutation(op[op.length - 1]);
			return;
		case "#": {
			// 路径字典定义：["#", id, path]；id 是非负整数，path 已内联且必须安全。
			if (op.length !== 3 || !Number.isInteger(op[1]) || (op[1] as number) < 0 || !Array.isArray(op[2])) {
				throw new TypeError("# shape");
			}
			assertSafePath(op[2] as Path);
			return;
		}
		// Silently skipping an unknown verb is how a newer producer's op vanishes.
		default:
			throw new TypeError(`unknown op verb: ${String(verb)}`);
	}
}

/**
 * 检查路径的每一段是否安全。
 *
 * 规则：字符串段不能是 `__proto__`/`constructor`/`prototype`；数字段必须是 >= 0 的整数。
 * 输入：Path；输出：无；错误：UnsafePathError（携带违规段）。
 * 这是运行时的信任边界检查：TypeScript 的 Seg 类型只保证 string | number，
 * 无法在编译期排除危险字符串或负数/小数。
 */
export function assertSafePath(path: Path): void {
	for (const seg of path) {
		if (typeof seg === "string") {
			if (RESERVED_SEGMENTS.has(seg)) throw new UnsafePathError(seg);
		} else if (!Number.isInteger(seg) || seg < 0) {
			throw new UnsafePathError(seg);
		}
	}
}

/**
 * An index may address an existing element or append exactly one past the end.
 *
 * This is not an arbitrary cap — it is what keeps the value a `JsonValue`. A
 * sparse array does not survive a JSON round trip: holes serialise to `null` and
 * return as real properties, so `arr[7] = x` on a length-3 array already produces
 * state a replica cannot match. Rejecting the write is more honest than silently
 * diverging.
 *
 * It also removes the denial of service it would otherwise permit:
 * `["s", ["xs", 4294967290], 1]` allocates a 4.29-billion-entry array from one op.
 * Growth stays possible and stays proportional — the tracker already emits
 * `arr.length = n` as a splice of explicit nulls, whose op size grows with the
 * gap, so a large growth costs a large op rather than a small one.
 */
/**
 * 限制数组下标只能指向已有元素，或恰好追加到末尾后一位。
 *
 * 为什么必须限制：稀疏数组无法在 JSON 往返中保持形状——空洞会序列化成 null，再解析回来变成真实属性，
 * 副本之间就会分叉。`arr[7] = x` 作用于长度 3 的数组时已经产生了不可复制状态，直接拒绝比静默分叉更诚实。
 *
 * 这也消除了一个拒绝服务入口：一条 `["s", ["xs", 4294967290], 1]` 就能分配 42.9 亿长度的数组。
 * 仍然允许按比例增长：tracker 把 `arr.length = n` 表示为显式 null 的 splice，op 大小随间隔增长，
 * 因此“大增长”必须付出“大 op”的代价，而不是一条小 op 造成巨大分配。
 *
 * 输入：父数组与下标；输出：无；错误：index > length 时抛 UnsafePathError。
 * 注意：负数/小数已在 assertSafePath 中拒绝；这里只查上界。
 */
function assertIndexInRange(parent: readonly unknown[], index: number): void {
	if (index > parent.length) throw new UnsafePathError(index);
}

// ─── Applier ─────────────────────────────────────────────────────────────────

/**
 * 操作路径无法解析、或解析后类型不符合该操作要求时抛出的错误。
 *
 * `path` 保存原始路径或 decoder 的数字 id，便于定位；消息用 JSON.stringify 展示。
 * 与 UnsafePathError 的分工：后者表示“路径本身危险/非法”，前者表示“路径在值里走不通或目标类型不对”。
 */
export class PathError extends Error {
	readonly path: Path | number;
	constructor(path: Path | number) {
		super(`unresolvable path: ${JSON.stringify(path)}`);
		this.path = path;
		this.name = "PathError";
	}
}

/**
 * Apply ops to a plain mutable value. Returns the value, because `r` replaces it
 * outright and cannot be done in place.
 *
 * Takes decoded ops. Path ids and omitted paths are a wire concern — run
 * `decode` first if the ops came from a boundary.
 */
/**
 * 把一组已解码的 Op 应用到一个普通可变值上，并返回新的根。
 *
 * 输入：`target` 当前值（可为 undefined，此时通常紧接着有 `r`）；`ops` 已解码操作。
 * 输出：应用后的根；返回类型 T 是因为 `r` 可能把根换成别的值，无法原地完成。
 * 副作用：除 `r` 外会原地修改 target 指向的对象/数组及其子容器。
 * 错误：形状非法抛 TypeError；路径危险抛 UnsafePathError；路径不可解析或目标类型不对抛 PathError。
 *
 * 例子：apply({ text: "ab" }, [["a", ["text"], "c"]]) 返回同一个对象，且 text 变为 "abc"。
 *
 * 边界：如果 op 来自网络或外部输入，必须先 `decoder().decode()`；本函数不认识路径 id 和短形式。
 */
export function apply<T>(target: T | undefined, ops: readonly Op[]): T {
	return applyOps(target, ops);
}

/**
 * `apply` 的内部实现；逐条 op 校验并执行。
 *
 * 输入：可变根与 Op 数组；输出：最终根；副作用：原地修改（r 除外）。
 * 错误：见 apply。执行过程中前一条 op 的修改可能已经生效；本函数不提供回滚。
 */
function applyOps<T>(target: T | undefined, ops: readonly Op[]): T {
	// 内部统一按 JsonValue 处理；T 的约束由调用方保证，入口处做一次类型断言。
	let root = target as unknown as JsonValue;

	for (const op of ops) {
		// 每条 op 都校验形状/路径安全；这是运行时信任边界，TypeScript 类型在 JS 调用时不存在。
		assertValidOp(op);
		if (op[0] === "r") {
			// Adopted, not copied. The consumer owns the batch it was handed.
			//
			// Fanning one batch out to several consumers in-process therefore makes
			// their replicas alias each other. That is an ownership rule, not a
			// defect: copy the batch at the fan-out point, or let each consumer
			// decode its own. A batch that crosses a real boundary is already
			// distinct, because serialisation produces fresh objects.
			// r 直接接管 payload 的引用，不拷贝：调用方把批次交出后即转移所有权。
			// 同一批次分发给多个消费者会让它们的副本互相别名；这是所有权规则，不是缺陷。
			root = op[1];
			continue;
		}

		const path = op[1];
		assertSafePath(path);

		if (op[0] === "p") {
			// 空路径表示根本身就是目标数组；否则沿路径解析出数组。
			const target_ = path.length === 0 ? root : resolve(root, path);
			if (!Array.isArray(target_)) throw new PathError(path);
			// 先删除指定数量，再在 start 处插入 items。两步而不是一次 splice，
			// 是为了给下面的分块插入留出简单的偏移计算。
			target_.splice(op[2], op[3]);
			// 参数展开有引擎上限（约 12 万），这里按 1 万一组插入，避免超大 items 触发 RangeError。
			const chunkSize = 10_000;
			for (let offset = 0; offset < op[4].length; offset += chunkSize) {
				target_.splice(op[2] + offset, 0, ...op[4].slice(offset, offset + chunkSize));
			}
			continue;
		}
		if (op[0] === "m") {
			const target_ = path.length === 0 ? root : resolve(root, path);
			// 置换长度必须与数组长度一致，否则无法形成双射。
			if (!Array.isArray(target_) || target_.length !== op[2].length) throw new PathError(path);
			// 先快照旧顺序，再按 permutation 写入，避免边读边写覆盖尚未读取的元素。
			const previous = target_.slice();
			for (let index = 0; index < op[2].length; index++) target_[index] = previous[op[2][index]!]!;
			continue;
		}

		// s/d/a/t can never target the root — the type forbids it.
		// 这四种 op 的路径非空，因此父路径 slice(0, -1) 至少是一个可解析的节点；
		// 对根数组来说父路径为空，resolve(root, []) 会返回根，但 resolve 要求它是对象（数组满足）。
		const parent = resolve(root, path.slice(0, -1)) as Record<Seg, JsonValue>;
		const key = path[path.length - 1]!;
		if (Array.isArray(parent)) {
			// 数组的 key 必须是数字，且只能写已有下标或末尾后一位，防止稀疏数组和超大分配。
			if (typeof key !== "number") throw new UnsafePathError(key);
			assertIndexInRange(parent, key);
		}
		// defineProperty rather than assignment: a setter inherited from the prototype
		// chain would otherwise run on write.
		// 用 defineProperty 定义自有数据属性，避免触发原型链上的 setter（例如 __proto__）。
		const write = (value: JsonValue) => {
			Object.defineProperty(parent, key, { value, writable: true, enumerable: true, configurable: true });
		};
		// 只读自有属性：继承来的 getter 不能执行，读取也不能逃逸到原型链。
		const read = (): unknown => (Object.hasOwn(parent, key) ? parent[key] : undefined);
		switch (op[0]) {
			case "s":
				write(op[2]);
				break;
			case "d":
				if (Array.isArray(parent)) {
					// 删除不存在的数组下标视为路径错误；splice 保持数组稠密。
					if (typeof key !== "number" || key >= parent.length) throw new PathError(path);
					(parent as unknown as JsonValue[]).splice(key, 1);
				} else delete parent[key];
				break;
			case "a": {
				// 只有字符串支持追加；当前值来自自有属性。
				const current = read();
				if (typeof current !== "string") throw new PathError(path);
				write(`${current}${op[2]}`);
				break;
			}
			case "t": {
				// 截断到前 op[2] 个字符；slice 对超过长度的值会自然截到末尾。
				const current = read();
				if (typeof current !== "string") throw new PathError(path);
				write(current.slice(op[2]));
				break;
			}
		}
	}
	// 与入口断言对称：内部 JsonValue 表示还原成调用方的 T。
	return root as unknown as T;
}

/** Apply one decoded operation batch without mutating the previous immutable value. */
/**
 * 应用一批已解码 op，返回新值而不修改旧值（写时复制）。
 *
 * 输入：旧根与一批 Op；输出：应用后的根；副作用：不修改 target 与 op payload。
 * 错误：与 `apply` 相同，但校验失败时不会把部分结果暴露给调用方，旧值保持不变。
 * 实现只是把单批包装成 `applyImmutableBatches`，共享同一套路径与所有权逻辑。
 */
export function applyImmutable<T>(target: T | undefined, ops: readonly Op[]): T {
	return applyImmutableBatches(target, [ops]);
}

/**
 * Apply decoded operation batches as one final-result-only replay.
 *
 * Containers copied for an earlier batch may be mutated while applying a later
 * batch, so this deliberately exposes no intermediate revisions.
 */
/**
 * 依次应用多个操作批次，只返回最终结果，不暴露中间 revision。
 *
 * 输入：旧根与可迭代的多批 Op（可以是 generator，边产边用）；输出：最终根。
 * 副作用：不修改输入值；内部会修改自己拷贝出来的容器。
 * 错误：任一批次的 op 非法或路径不可解析即抛错；此前已做的拷贝都是私有的，不会污染 base。
 *
 * 为什么“只返回最终结果”：`owned` 跨批次共享，第一批拷贝出的容器可能在第二批被继续原地修改。
 * 如果中途把引用交给调用方，它会看到后续批次的修改，得到一个不稳定的“中间快照”。
 * 调用方若需要中间状态，应逐批调用 `applyImmutable`。
 *
 * 例子：batches = [[["s",["n"],1]], [["s",["n"],2]]]，结果 n 为 2，原值 n 不变。
 */
export function applyImmutableBatches<T>(target: T | undefined, batches: Iterable<readonly Op[]>): T {
	let root = target as unknown as JsonValue;
	// owned 必须在所有批次间共享：同一容器只拷贝一次，后续批次直接改副本。
	const owned = new WeakSet<object>();
	for (const ops of batches) {
		for (const op of ops) {
			assertValidOp(op);
			if (op[0] === "r") {
				// 与可变应用相同：接管 payload 引用。后续批次若要改它，会先经过 copyContainers 拷贝。
				root = op[1];
				continue;
			}
			if (op[0] === "p") {
				// 快速路径：向尚未拷贝的数组末尾追加时，用 concat 一次完成拷贝+插入。
				const appended = appendCopy(root, op, owned);
				if (appended !== undefined) {
					root = appended;
					continue;
				}
			}
			// 一般路径：先沿路径把所有需要修改的容器拷贝出来（p/m 拷贝到目标数组本身，
			// s/d/a/t 拷贝到父容器），再对副本执行一次 applyOps。
			root = copyContainers(root, op[0] === "p" || op[0] === "m" ? op[1] : op[1].slice(0, -1), owned);
			root = applyOps(root, [op]);
		}
	}
	return root as unknown as T;
}

/**
 * An append to an array not yet copied in this replay, built as one copy with the items (`concat`) instead of a copy that
 * the insert then grows, which copies it again. `undefined` for any other splice and for any path that is not a plain
 * walk over own properties, which takes the general path and so fails with its errors.
 */
/**
 * `applyImmutableBatches` 的追加快速路径：向尚未拷贝的数组末尾插入元素时一次完成。
 *
 * 输入：当前根、一条 p 操作、跨批次 owned 集合。
 * 输出：新根；若这条 p 不适合快速路径（不是纯追加、路径不满足自有属性遍历、数组已拷贝过），返回 undefined，
 *       让调用方走一般路径，并由一般路径给出应有的错误。
 * 副作用：新数组通过 concat 创建并登记到 owned；父容器会被浅拷贝并挂上新数组。
 * 错误：本函数自身不抛；条件不满足一律返回 undefined。
 *
 * 类型 `Extract<Op, { 0: "p" }>` 从 Op 联合中只取出首元素为 "p" 的成员（splice 操作），
 * 这样函数体内可以直接访问 op[2]、op[3]、op[4]。
 */
function appendCopy(root: JsonValue, op: Extract<Op, { 0: "p" }>, owned: WeakSet<object>): JsonValue | undefined {
	// 解构出路径、起始下标、删除数量与插入项；只处理 deleteCount === 0 的纯插入。
	const [, path, index, deleteCount, items] = op;
	if (deleteCount !== 0) return undefined;
	let target: JsonValue = root;
	// 手动沿路径下钻，同时验证每一步：字符串段只走普通对象（且非保留键），数字段只走数组。
	// 任何一步不是自有属性或类型不符，就退回一般路径。
	for (const segment of path) {
		const valid =
			typeof segment === "string"
				? !RESERVED_SEGMENTS.has(segment) && isObj(target) && !Array.isArray(target)
				: Number.isInteger(segment) && segment >= 0 && Array.isArray(target);
		if (!valid || !Object.hasOwn(target as object, segment)) return undefined;
		// valid 里已经检查过 isObj/Array.isArray，但 TS 无法跨条件关联，所以这里断言索引访问。
		target = (target as Record<Seg, JsonValue>)[segment]!;
	}
	// 只有“在数组末尾追加”且数组尚未被本轮回放拷贝时才走快速路径。
	if (!Array.isArray(target) || owned.has(target) || index !== target.length) return undefined;
	// concat 一次得到“旧元素 + 新元素”的新数组，避免先 slice 再用 splice 扩容导致二次拷贝。
	const appended = target.concat(items);
	owned.add(appended);
	// 根数组：新数组直接就是新根。
	if (path.length === 0) return appended;
	// 非根数组：拷贝父路径上的容器，并把新数组挂到父副本的同一个键上。
	const parentPath = path.slice(0, -1);
	const copiedRoot = copyContainers(root, parentPath, owned);
	Object.defineProperty(resolve(copiedRoot, parentPath), path[path.length - 1]!, {
		value: appended,
		writable: true,
		enumerable: true,
		configurable: true,
	});
	return copiedRoot;
}

/**
 * 沿 path 把根到路径末端的容器全部浅拷贝出来，返回新的根。
 *
 * 输入：根、路径（p/m 传目标容器自身的路径；s/d/a/t 传父容器路径）、owned 集合。
 * 输出：新根；路径上的容器要么已在 owned 中（直接复用），要么新拷贝。
 * 错误：根/中间节点不是对象、不是自有属性、数组遇到非数字段时抛 PathError/UnsafePathError。
 * 副作用：只修改拷贝出来的容器；原容器不变。
 * 关键点：路径为空时只拷贝根，返回根副本。
 */
function copyContainers(root: JsonValue, path: Path, owned: WeakSet<object>): JsonValue {
	// 局部拷贝函数：数组用 slice，对象保留原型；null 原型对象用 Object.assign 避免继承 setter。
	const copy = (value: JsonValue): JsonValue[] | Record<string, JsonValue> => {
		if (Array.isArray(value)) return value.slice();
		if (!isObj(value)) throw new PathError(path);
		// Spread and `Object.assign()` onto a null-prototype object define own data properties, `__proto__` included,
		// as `Object.defineProperty()` per key does, at a fraction of its cost.
		return Object.getPrototypeOf(value) === null ? Object.assign(Object.create(null), value) : { ...value };
	};
	if (!isObj(root)) throw new PathError(path);
	let copiedRoot: JsonValue[] | Record<string, JsonValue>;
	// 根已在本轮回放中拷贝过，就继续用同一个副本；否则拷一份并登记。
	if (owned.has(root)) copiedRoot = root as JsonValue[] | Record<string, JsonValue>;
	else {
		copiedRoot = copy(root);
		owned.add(copiedRoot);
	}
	let destination = copiedRoot;
	for (const segment of path) {
		// 只沿自有属性走，且数组下标必须是数字；否则路径不可解析/危险。
		if (!Object.hasOwn(destination, segment)) throw new PathError(path);
		if (Array.isArray(destination) && typeof segment !== "number") throw new UnsafePathError(segment);
		const child = (destination as Record<Seg, JsonValue>)[segment]!;
		if (!isObj(child)) throw new PathError(path);
		// 子容器已拷贝过：它已经是本轮结果的一部分，直接下钻。
		if (owned.has(child)) {
			destination = child as JsonValue[] | Record<string, JsonValue>;
			continue;
		}
		// 否则浅拷贝子容器并挂到父副本上，再继续。
		const copiedChild = copy(child);
		Object.defineProperty(destination, segment, {
			value: copiedChild,
			writable: true,
			enumerable: true,
			configurable: true,
		});
		owned.add(copiedChild);
		destination = copiedChild;
	}
	return copiedRoot;
}

/**
 * 沿路径解析出一个值，不要求末端是对象；每一步都只读自有属性。
 *
 * 输入：根与路径；输出：路径末端值（可能是标量）；错误：中间不是对象、数组遇到非数字段、属性不存在时抛错。
 * 副作用：无；绝不触发原型链上的 getter。
 */
function resolveValue(root: JsonValue, path: Path): JsonValue {
	let node: JsonValue = root;
	for (const seg of path) {
		if (!isObj(node)) throw new PathError(path);
		if (Array.isArray(node) && typeof seg !== "number") throw new UnsafePathError(seg);
		// Own properties only: an inherited getter must not run, and a walk must not
		// escape the value into the prototype chain.
		// 必须用 hasOwn：直接读 node[seg] 可能命中继承属性或 getter。
		if (!Object.hasOwn(node, seg as PropertyKey)) throw new PathError(path);
		node = (node as Record<Seg, JsonValue>)[seg]!;
	}
	return node;
}

/**
 * 解析路径并要求末端是容器（对象或数组）。
 *
 * 供 apply 中 p/m 的目标查找，以及 s/d/a/t 的父容器查找使用。
 * 输入：根与路径；输出：末端对象/数组；错误：resolveValue 的错误，或末端不是对象时抛 PathError。
 */
function resolve(root: JsonValue, path: Path): JsonValue {
	const node = resolveValue(root, path);
	if (!isObj(node)) throw new PathError(path);
	return node;
}

// ─── Codec ───────────────────────────────────────────────────────────────────
//
// Path interning and arity omission live between the tracker and a boundary;
// `Op` and `apply` know nothing about them.
//
// Consecutive batches of one encoder may be concatenated into one batch (links
// coalesce waiting state this way): only path ids span batches, and every batch
// starts with an explicit path.
//
// ONE PAIR PER INDEPENDENT STATE STREAM. Every decoder must observe exactly the
// batches encoded by its matching encoder, beginning with that state's base.
// Sharing a transport connection does not make separately hydrated states one
// stream.

// 编码器/解码器的核心辅助：把路径序列化成稳定的字符串键，用于 Set/Map 查找。
// 与 pending.ts 的 pathKey 同构；不同路径不会因为数值/字符串差异而混淆（JSON 保留类型）。
const pathKey = (path: Path): string => JSON.stringify(path);

export interface Encoder {
	encode(ops: readonly Op[]): WireOp[];
}

/**
 * Intern on SECOND use. A definition costs more than the path it replaces, so
 * interning on first use loses on the many paths written exactly once.
 */
/**
 * 创建一个编码器：把 Op 压缩成 WireOp，供跨边界传输。
 *
 * 输入/输出：`encode(ops)` 接收一批已解码 Op，返回等价的 WireOp 数组。
 * 副作用：编码器内部维护“已见路径”和“id 字典”；同一编码器实例的多个批次共享 id，
 *       但短形式（省略路径）只在批次内生效。
 * 错误：encode 本身不校验输入；调用方应保证传入合法 Op。
 *
 * 压缩策略：
 * - 路径第二次出现时才分配 id 并发送 ["#", id, path]（定义成本高于一次内联，很多路径只写一次）；
 * - 同一批次内与上一条 op 路径相同时，用短元组省略路径；
 * - 遇到 `r` 清空所有字典：基线批次是恢复点，之后必须自包含。
 *
 * 例子：两条同路径 s 操作会编码成 [["s", path, 1], ["s", 2]]，
 * 第二条省略了路径，由解码器复用上一条路径。
 */
export function encoder(): Encoder {
	// seen：路径第一次使用（内联）后记下，用于判断“这是第二次”。
	// ids：路径 -> 已分配的 id；nextId：下一个可用整数 id。
	const seen = new Set<string>();
	const ids = new Map<string, number>();
	let nextId = 0;
	let previous: string | undefined; // last path in THIS batch

	return {
		encode(ops) {
			// Arity omission is scoped to a batch. Letting it span batches would make
			// a batch's first op depend on the previous batch's last one, so a reader
			// that skips or reorders a batch decodes into the wrong path. Ids are the
			// only cross-batch state, and the dictionary makes those explicit.
			// previous 每个批次重置：短形式不能跨批次依赖上一条的路径，否则跳过/重排批次会解码到错误路径。
			previous = undefined;
			const out: WireOp[] = [];
			for (const op of ops) {
				if (op[0] === "r") {
					// r 原样输出（WireOp 的 r 与 Op 相同）。
					out.push(op);
					// A base batch is a RECOVERY POINT: a reader replays from the last one
					// with a fresh decoder. So everything after it must be self-contained.
					// Keeping ids across a replacement emits references to definitions the
					// reader never saw — recovery fails with an unresolvable path id.
					// r 是恢复点：读者可以从这里用全新 decoder 重放。因此必须清空字典，
					// 否则 r 之后可能引用“读者从未见过的 id”，恢复时报路径不可解析。
					seen.clear();
					ids.clear();
					nextId = 0;
					previous = undefined;
					continue;
				}
				const path = op[1];
				const key = pathKey(path);

				// Same path as the previous op: drop the ref entirely.
				// 与上一条 op 路径相同：直接发短形式，路径字段整个省掉。
				if (key === previous) {
					switch (op[0]) {
						case "s":
							out.push(["s", op[2]]);
							break;
						case "d":
							out.push(["d"]);
							break;
						case "a":
							out.push(["a", op[2]]);
							break;
						case "t":
							out.push(["t", op[2]]);
							break;
						case "p":
							out.push(["p", op[2], op[3], op[4]]);
							break;
						case "m":
							out.push(["m", op[2]]);
							break;
					}
					continue;
				}

				// 非短形式：决定用内联路径还是数字 id。
				let ref: PathRef = path;
				const existing = ids.get(key);
				if (existing !== undefined) {
					// 已经定义过 id：直接引用。
					ref = existing;
				} else if (seen.has(key)) {
					// 第二次出现：分配 id，先发 # 定义，再在当前 op 中引用它。
					const id = nextId++;
					ids.set(key, id);
					out.push(["#", id, path]); // second use: define, then reference
					ref = id;
				} else {
					seen.add(key); // first use: inline
				}

				// 按动词输出完整形式（ref 可能是内联路径或 id）。
				// s/d/a/t 的路径类型是 NonEmptyPath；Op 的对应成员本身非空，但 ref 是联合类型，
				// TypeScript 无法自动保留“非空”信息，因此这里显式断言。
				switch (op[0]) {
					case "s":
						out.push(["s", ref as PathRef<NonEmptyPath>, op[2]]);
						break;
					case "d":
						out.push(["d", ref as PathRef<NonEmptyPath>]);
						break;
					case "a":
						out.push(["a", ref as PathRef<NonEmptyPath>, op[2]]);
						break;
					case "t":
						out.push(["t", ref as PathRef<NonEmptyPath>, op[2]]);
						break;
					case "p":
						out.push(["p", ref, op[2], op[3], op[4]]);
						break;
					case "m":
						out.push(["m", ref, op[2]]);
						break;
				}
				// 只有显式写出路径的 op 才更新 previous；短形式继续沿用同一路径。
				previous = key;
			}
			return out;
		},
	};
}

export interface Decoder {
	/** Ops as received: each is validated (`assertValidWireOp`) before use. */
	decode(wire: readonly unknown[]): Op[];
}

/**
 * 创建一个解码器：把 WireOp 还原成 Op。
 *
 * 输入/输出：`decode(wire)` 接收一批线格式元组（unknown，可能来自 JSON.parse），返回完整 Op 数组。
 * 副作用：内部维护 id -> 路径字典；遇到 `r` 清空字典和批次内 previous。
 * 错误：每条 op 先过 assertValidWireOp（TypeError）；短形式缺少前一路径、id 未定义、s/d/a/t 路径为空
 *       时抛 PathError。
 *
 * 必须与配对编码器的状态流严格对应：id 可跨批次，但短形式只在批次内有效；中途丢批次会导致后续 id
 * 引用错位。一个 decoder 只服务一条独立状态流。
 *
 * 例子：decode([["s", ["a"], 1], ["s", 2]]) 返回 [["s",["a"],1], ["s",["a"],2]]。
 */
export function decoder(): Decoder {
	// 跨批次保存 id -> 路径；`r` 时清空。注意这里不保存 previous（批次内也显式管理）。
	const paths = new Map<number, Path>();

	return {
		decode(wire) {
			let previous: Path | undefined; // scoped to the batch, as in encode
			const out: Op[] = [];
			for (const op of wire) {
				// 运行时信任边界：每条线格式 op 都校验形状、id 与路径安全。
				assertValidWireOp(op);
				if (op[0] === "#") {
					// 字典定义不产生输出 op，只登记路径；重复定义会覆盖旧 id。
					// assertValidWireOp 已经查过数组形状，这里再查一次路径段安全。
					assertSafePath(op[2]);
					paths.set(op[1], op[2]);
					continue;
				}
				if (op[0] === "r") {
					// 根替换原样输出；清空路径字典与 previous，恢复点之后必须自包含。
					out.push(op);
					paths.clear();
					previous = undefined;
					continue;
				}

				// Arity tells us whether a ref is present: the short forms omit it.
				// 用元组长度判断是否为短形式：
				// - d 短形式长度为 1；其他非 p 动词（s/a/t/m）短形式长度为 2；
				// - p 长形式 5、短形式 4。
				const short =
					(op[0] === "d" && op.length === 1) ||
					(op[0] !== "d" && op[0] !== "p" && op.length === 2) ||
					(op[0] === "p" && op.length === 4);

				let path: Path;
				if (short) {
					// 短形式复用上一条 op 的路径；批次第一条就是短形式说明流不完整。
					if (previous === undefined) throw new PathError([]);
					path = previous;
				} else {
					// 完整形式：op[1] 是内联路径数组或数字 id。
					const ref = op[1] as PathRef;
					if (typeof ref === "number") {
						const resolved = paths.get(ref);
						if (resolved === undefined) throw new PathError(ref);
						path = resolved;
					} else {
						path = ref;
					}
					// 只有显式路径才更新 previous；id 引用解析出的路径也算。
					previous = path;
				}

				// s/d/a/t 的路径不能为空（空路径代表根，只有 r 或 p/m 能操作根）。
				if (op[0] !== "p" && op[0] !== "m" && path.length === 0) throw new PathError(path);
				switch (op[0]) {
					case "s":
						// 短形式的 payload 在 op[1]，完整形式在 op[2]。
						out.push(["s", path as NonEmptyPath, (short ? op[1] : op[2]) as JsonValue]);
						break;
					case "d":
						out.push(["d", path as NonEmptyPath]);
						break;
					case "a":
						out.push(["a", path as NonEmptyPath, (short ? op[1] : op[2]) as string]);
						break;
					case "t":
						out.push(["t", path as NonEmptyPath, (short ? op[1] : op[2]) as number]);
						break;
					case "p": {
						// p 的短形式字段整体左移一位：短形式 [p, i, r, items]，完整形式 [p, ref, i, r, items]。
						const [i, r, items] = short
							? [op[1] as number, op[2] as number, op[3] as JsonValue[]]
							: [op[2] as number, op[3] as number, op[4] as JsonValue[]];
						out.push(["p", path, i, r, items]);
						break;
					}
					case "m":
						// 短形式 [m, permutation]，完整形式 [m, ref, permutation]。
						out.push(["m", path, (short ? op[1] : op[2]) as number[]]);
						break;
				}
			}
			return out;
		},
	};
}
