/*
 * 文件导读
 * ========
 * 所属：packages/chord/src/delta，Chord 共享的 Delta 模块；是 `track()`、`appendText()` 和 Tracker/Change/Prepared
 * 接口的实现文件，也是 Delta 里最大的状态机。
 *
 * 职责边界：本文件负责“事务式修改一份不可变 JSON 值”的全部运行时机制：
 * - 用 Proxy + 覆盖层（overlay）记录草稿上的读/写/删，不修改 base；
 * - `prepare()` 把覆盖层物化成一批 Op（供传输/记录）和一份新值（供 adopt）；
 * - `adopt()` 只做 O(1) 指针交换，并让竞争中的旧草稿变为 stale；
 * - `prepareReplace()` 支持整值替换，并做深比较以识别 no-op；
 * - `appendText()` 提供 O(text.length) 的字符串追加快路径。
 * 它不负责编码（index.ts 的 encoder）、不负责路径字典、不主动落盘；错误以 TypeError/Error 抛给调用方，
 * prepare 失败会把上下文置为 aborted 并清理。
 *
 * 上游入口：documents/slot.ts、documents/keyed-slot.ts、documents/transaction.ts、jobs/run-states.ts、
 * old/state.ts、old/cell.ts 等调用 `track(initial)`，随后在 `change.state`（类型为 Draft<T>）上修改。
 * 下游依赖/结果：`Prepared.ops` 交给 encoder/diff 的消费者；`Prepared.value` 被 `adopt()` 接管为新的
 * `tracker.value`。依赖 index.ts 的 Op/applyImmutable/overlap/ownedSlice/RESERVED_SEGMENTS、json.ts 的
 * copyJson，以及本文件的 apply-immutable-trusted 快速应用器。
 *
 * 能力清单（导出项）：
 * - `track<T extends object>(initial): Tracker<T>`：O(1) 接管一份 alias-free 严格 JSON 的不可变所有权。
 * - `Tracker<T>`：`value`、`revision`、`beginChange()`、`prepareReplace(value)`、`adopt(prepared)`。
 * - `Change<T>`：`state: Draft<T>`、`prepare(): Prepared<T>`、`abort()`。
 * - `Prepared<T>`：`base`、`value`、`ops`、`baseRevision`、`abort()`。
 * - `appendText(draft, key, text)`：在草稿的字符串字段后追加，生成单条 append op。
 * - `StringKeys<T>`：类型工具，找出值类型恰为 string 的必填键。
 * - 再导出 `Draft`、`JsonValue`、`Op`。
 * 主要内部结构：`TrackerImpl`（所有权/竞争/版本）、`ChangeImpl`（事务状态机）、`PreparedImpl`（准备结果）、
 * `OverlayContext`/`OverlayNode`（覆盖层）、`ArrayOverlay`/`PieceNode`（数组的隐式 treap）。
 *
 * 组合关系与典型顺序：
 *   const tracker = track(initial);                 // 接管所有权，不遍历
 *   const change = tracker.beginChange();           // 新 overlay，旧 open 草稿被降级为 competitor
 *   change.state.title = "b";                       // Proxy 记录写入
 *   change.state.rows.push({ n: 2 });               // 数组 mutator 修改 piece 树
 *   const prepared = change.prepare();              // 生成 ops + 物化新值；上下文只读
 *   tracker.adopt(prepared);                        // 指针交换、revision+1、竞争草稿 stale
 * 出错时：prepare 捕获异常并 abort；adopt 拒绝不属于本 tracker、已消费、已 abort 或基于旧 revision 的
 * prepared；对已结束草稿的任何读写抛 TypeError。
 *
 * 示例（真实签名；op 形状以实际输出为准）：
 *   const tracker = track({ title: "a", rows: [{ n: 1 }] });
 *   const change = tracker.beginChange();
 *   change.state.title = "b";
 *   change.state.rows.push({ n: 2 });
 *   const prepared = change.prepare();
 *   // prepared.value 深等于 { title: "b", rows: [{ n: 1 }, { n: 2 }] }
 *   // prepared.ops 包含对 title 的 s（或 a）和对 rows 的 p 追加
 *   tracker.adopt(prepared);
 *   // tracker.revision 从 0 变为 1；tracker.value === prepared.value
 * 所有权规则：track 不遍历、不复制 initial，调用方之后不得再修改它；草稿只允许在 change 未结束前使用。
 *
 * 建议阅读顺序：先读 `Prepared`/`Change`/`Tracker` 接口与 `ChangeImpl`/`TrackerImpl` 的生命周期方法，
 * 再看 `track`/`appendText`；随后读对象访问（getProperty/setProperty/deleteProperty 与 write/delete 缓存），
 * 然后读数组 overlay（piece treap、locator、mutators），最后读 `emitOperations` 如何把覆盖层压成 Op。
 * 类型定义集中在文件开头，可先扫一遍字段含义，再随实现回看。
 */
import type { JsonValue } from "../json.ts";
import { copyJson } from "../json.ts";
import { applyImmutableTrusted } from "./apply-immutable-trusted.ts";
import type { Draft } from "./draft.ts";
import {
	applyImmutable,
	type NonEmptyPath,
	type Op,
	overlap,
	ownedSlice,
	type Path,
	RESERVED_SEGMENTS,
} from "./index.ts";

// 再导出：调用方可以从 tracker 或 delta/index 任一入口拿到这些类型。
export type { Draft, JsonValue, Op };

/** Keys of `T` whose value type is exactly `string`: required, and not a string literal type. */
/**
 * 类型工具：找出 `T` 中“值类型恰为 string”的必填键。
 *
 * 规则：
 * - 数组直接得到 never（数组没有字符串键的业务语义）；
 * - 映射类型逐键检查：`string extends T[Key]` 表示值类型宽于 string（即恰好是 string 或 any），
 *   再要求 `T[Key] extends string`，排除 any/number 等；
 * - 最后用 `[keyof T]` 索引，得到所有满足条件键的联合。
 * 目的：`appendText(draft, key, text)` 只允许传字符串字段，且不接受 string 字面量类型（如 "a"|"b"），
 * 因为对字面量类型追加后可能超出原类型范围。
 *
 * 编译期检查：只在 TypeScript 层生效；JS 调用仍可能传任意键，appendText 会做运行时检查。
 */
export type StringKeys<T> = T extends readonly unknown[]
	? never
	: { [Key in keyof T]: string extends T[Key] ? (T[Key] extends string ? Key : never) : never }[keyof T];

// JSON 原始值；注意不含 undefined。
type Primitive = null | boolean | number | string;
// JSON 容器：数组或字符串键对象。
type Container = JsonValue[] | Record<string, JsonValue>;
// 覆盖层中保存的值。
type Stored = JsonValue;
// 存储引用：原始值直接内联，容器放入 context.stored 数组并用 { index } 间接引用。
// 这样可以区分“值本身”与“槽位”，并在覆盖被覆盖/删除时释放槽位。
type StoredRef = Primitive | { index: number };
// 事务/上下文状态：open 可写；prepared 只读待 adopt；consumed 已 adopt；aborted 已放弃；stale 被竞争胜者淘汰。
type Status = "open" | "prepared" | "consumed" | "aborted" | "stale";
// 用对象包一层，使多个 Prepared/Change 能共享并观察同一个状态。
type StatusCell = { value: Status };

// 插入来源：一组按顺序存储的引用；数组 overlay 的 insert piece 指向它。
type InsertSource = { refs: StoredRef[] };
// 父节点种类：0 = 对象属性；1 = base 数组元素；2 = 插入数组元素。
type ParentKind = 0 | 1 | 2; // object, base-array entry, inserted-array entry

// 数组 overlay 的“片段”（piece）：描述逻辑数组中连续的一段来自哪里。
// - base：来自底值数组的 start 下标开始，step 为 +1/-1（reverse 会产生 -1）；
// - insert：来自某个 InsertSource 的 refs 数组。
// 多个 piece 按逻辑顺序组成整个数组视图。
type BasePiece = { kind: "base"; start: number; length: number; step: 1 | -1 };
type InsertPiece = { kind: "insert"; source: InsertSource; start: number; length: number; step: 1 | -1 };
type Piece = BasePiece | InsertPiece;

// 隐式 treap（笛卡尔树）节点：按中序遍历表示数组逻辑顺序，priority 维护平衡，elements 是子树元素总数。
// 用它可以在 O(log n) 内按逻辑下标定位、切分和拼接数组片段，而不必重排整份数组。
type PieceNode = {
	piece: Piece;
	left: PieceNode | undefined;
	right: PieceNode | undefined;
	priority: number;
	elements: number;
};

// 片段定位缓存：logicalStart 是它在逻辑数组中的起点，minimum/maximum 是来源下标范围，用于二分查找。
type PieceLocation = { piece: Piece; logicalStart: number; minimum: number; maximum: number };

// 密集修改区：一段连续下标大量被改写时，用一条 splice 替代逐下标 set。
type DenseRegion = { start: number; length: number };
// 密集候选：indices 是少量候选下标；达到 256 个后升级为 bits 位图；length 是数组长度。
type DenseCandidates = { indices: number[]; bits: Uint8Array | undefined; length: number };

// 数组操作计划（prepare 时生成）：
// - removeRuns：成对的 [起始逻辑下标, 删除个数]，按从后往前排列以便原地应用；
// - permutation：需要重排时的新旧下标映射；
// - insertRuns：三元组 [逻辑下标, piece 起始下标, piece 结束下标]，对应一段连续插入。
type ArrayPlan = {
	removeRuns: number[];
	permutation: number[] | undefined;
	insertRuns: number[];
};

// 一个数组节点的覆盖层。
// root：隐式 treap 根；pieces：扁平化缓存，结构变化时清空；baseOverrides/insertOverrides：覆盖值。
// structural/generation：是否/第几次结构变化；plan：缓存的发射计划；seed：treap 伪随机优先级种子。
// locatedOffset：locatePiece 的输出；baseLocations/insertLocations：源下标定位缓存。
type ArrayOverlay = {
	root: PieceNode | undefined;
	pieces: Piece[] | undefined;
	baseOverrides: Map<number, StoredRef> | undefined;
	insertOverrides: Map<InsertSource, Map<number, StoredRef>> | undefined;
	structural: boolean;
	generation: number;
	plan: ArrayPlan | undefined;
	seed: number;
	locatedOffset: number;
	baseLocations: PieceLocation[] | undefined;
	insertLocations: Map<InsertSource, PieceLocation[]> | undefined;
};

// 覆盖层中的一个“节点”，对应底值里的一个对象/数组容器；草稿中的 proxy 就是它的可写视图。
// 字段分三类：父子定位（baseIndex/parentIndex/parentKind/parentKey 等）、对象写删缓存
// （writeKey/writeValue/writes/deleteKey/deletes/readded/appends）、数组覆盖（array）与发射优化缓存
// （dirty/subtreeDirty/preparedPath）。
// baseIndex 指向 context.bases 中的底值；parentIndex 是父节点在 context.nodes 中的下标，-1 表示根。
// parentKind 0=对象属性，1=base 数组元素，2=插入数组元素；parentSource 只对插入元素存在。
// parentPlacement 表示该节点来自放置值；target/proxy 是 Proxy 的 target 与返回给调用方的代理。
// writeKey/writeValue 是单键写快速路径，writes 是多键 Map；deleteKey/deletes 同理。
// readded 记录删除后又重新添加的键；array 是该节点的数组覆盖层。
// dirty 表示节点直接变化，subtreeDirty 表示后代变化，preparedPath 缓存 emit 时的逻辑路径。
type OverlayNode = {
	context: OverlayContext;
	baseIndex: number;
	parentIndex: number;
	parentKind: ParentKind;
	parentKey: string | number;
	parentSource?: InsertSource;
	parentPlacement: boolean;
	target: object;
	proxy: object;
	writeKey?: string;
	writeValue?: StoredRef;
	writes?: Map<string, StoredRef>;
	deleteKey?: string;
	deletes?: Set<string>;
	readded?: Set<string>;
	/**
	 * Keys whose only changes in this transaction are `appendText()` calls, with the text appended so far. `prepare()`
	 * records each as one append op without comparing the old and new strings.
	 */
	appends?: Map<string, string>;
	array?: ArrayOverlay;
	dirty?: boolean;
	subtreeDirty?: boolean;
	preparedPath?: Path;
};

// 一个事务/替换操作的上下文：拥有所有节点、覆盖数据、状态和生命周期标志。
// owner 是 tracker 身份；tracker 是反向弱引用；baseRevision 记录草稿基于的 revision；status 是状态单元。
// root 是根节点；bases 是底值容器表；stored 是覆盖层容器槽位；dirty/nodes 分别记录待发射节点和全部节点。
// rawNodes 是底值容器到节点的弱映射（根不登记）；ops 缓存 prepare 后的操作。
// replacement/replacementNoop 标记整值替换上下文及 no-op；baseValue 是上下文基于的旧根。
// overlayReleased 表示强引用已释放；simpleObjectMaterialization 表示可直接 cloneNode 物化；
// registryRef 是 tracker 竞争集合中的弱引用。
type OverlayContext = {
	owner: object;
	tracker: WeakRef<TrackerImpl<object>>;
	baseRevision: number;
	status: StatusCell;
	root: OverlayNode | undefined;
	bases: Container[] | undefined;
	stored: Container[] | undefined;
	dirty: OverlayNode[];
	nodes: OverlayNode[];
	rawNodes: WeakMap<object, OverlayNode> | undefined;
	ops: Op[] | undefined;
	replacement: boolean;
	replacementNoop: boolean;
	baseValue: object | undefined;
	overlayReleased: boolean;
	simpleObjectMaterialization: boolean;
	registryRef: WeakRef<OverlayContext> | undefined;
};

// Proxy target 上存放节点的隐藏符号键；用 Symbol 避免与 JSON 键冲突。
const NODE = Symbol("chord.delta.overlay.node");
// Prepared 对象 -> 上下文的弱映射；adopt 时据此验证来源和状态。
const PREPARED = new WeakMap<object, OverlayContext>();
// 清理后的哨兵值：节点 target/proxy 指向它，后续访问能识别“已结束”。
const RELEASED: Record<string, JsonValue> = {};
// 数组的覆盖实现需要拦截这些方法名；get 时返回自定义 mutator，而不是 Array.prototype 的原生方法。
const ARRAY_MUTATORS = new Set<PropertyKey>([
	"push",
	"pop",
	"shift",
	"unshift",
	"splice",
	"reverse",
	"sort",
	"fill",
	"copyWithin",
]);
// 单次事务允许生成的最大 op 数；超过后退回根替换。
const MAX_DELTA_OPERATIONS = 4_096;
// 简单对象快速发射路径允许的脏节点上限。
const MAX_SIMPLE_OBJECT_NODES = 128;
// 复用的数据属性描述符；defineData 写完后重置 value。
const DATA_DESCRIPTOR: PropertyDescriptor = {
	value: undefined,
	writable: true,
	enumerable: true,
	configurable: true,
};

/**
 * prepare() 的结果：一份已物化的新值 + 可直接发送的 op 批次。
 *
 * 字段含义：
 * - `base`：这次修改基于的旧根（用于 adopt 时校验 tracker 仍停在同一值上）；
 * - `value`：物化后的新根；成功 adopt 后就是 tracker 的新 value；
 * - `ops`：把 base 变成 value 的操作；无变化时是空数组；
 * - `baseRevision`：生成时基于的 revision；
 * - `abort()`：放弃这份结果，把上下文置为 aborted（已消费/已 stale 时无效果）。
 * 生命周期：prepare 后上下文只读；adopt 成功 -> consumed；abort 或竞争失败 -> aborted/stale。
 */
export interface Prepared<T extends object> {
	readonly base: T;
	readonly value: T;
	readonly ops: readonly Op[];
	readonly baseRevision: number;
	abort(): void;
}

/**
 * 一个打开的修改事务。
 *
 * - `state`：可写草稿视图（类型 Draft<T>，运行时是根节点的 Proxy）；事务结束后再访问会抛 TypeError。
 * - `prepare()`：结束修改，生成 Prepared；只能调用一次；失败会自动 abort。
 * - `abort()`：放弃修改并清理草稿；成功 prepare 之后再调用会把 prepared 状态改为 aborted。
 */
export interface Change<T extends object> {
	readonly state: Draft<T>;
	prepare(): Prepared<T>;
	abort(): void;
}

/**
 * 一份不可变 JSON 值的所有者；同一时刻可以存在多个草稿，但只有一个能成功 adopt。
 *
 * - `value`：当前 revision 的根（成功后指向 Prepared.value，不复制）；
 * - `revision`：从 0 开始，每次成功 adopt 加一；
 * - `beginChange()`：开始一个普通事务；
 * - `prepareReplace(value)`：准备整值替换（会深比较以识别 no-op）；
 * - `adopt(prepared)`：提交一份由本 tracker 产生、基于当前 revision 且尚未消费的 Prepared。
 */
export interface Tracker<T extends object> {
	readonly value: T;
	readonly revision: number;
	beginChange(): Change<T>;
	prepareReplace(value: T): Prepared<T>;
	adopt(prepared: Prepared<T>): void;
}

class PreparedImpl<T extends object> implements Prepared<T> {
	// 上下文私有引用：用于校验 owner/状态，并让 abort 能找到它。
	readonly #context: OverlayContext;
	readonly value: T;
	readonly base: T;
	readonly ops: readonly Op[];

	/**
	 * 由 materializePrepared 创建；不要在外部直接 new。
	 * 输入：上下文、物化值、操作批次；副作用：把 this 登记到 PREPARED 弱映射，供 adopt 反查上下文。
	 * base 取自 context.baseValue，因此与生成时的旧根是同一引用。
	 */
	constructor(context: OverlayContext, value: T, operations: readonly Op[]) {
		this.#context = context;
		this.value = value;
		this.base = context.baseValue as T;
		this.ops = operations;
		PREPARED.set(this, context);
	}

	// 生成时基于的 tracker revision；adopt 用它判断是否已过期。
	get baseRevision(): number {
		return this.#context.baseRevision;
	}

	// 放弃这份 prepared：委托 abortContext；若已被消费或 stale，abortContext 会直接返回。
	abort(): void {
		abortContext(this.#context);
	}
}

class ChangeImpl<T extends object> implements Change<T> {
	// 活动期间保存上下文；prepare/abort 结束后置为 undefined，防止继续使用草稿。
	#context: OverlayContext | undefined;
	// prepare 成功后保存状态单元；之后调用 abort() 需要把 prepared 改为 aborted。
	#preparedStatus: StatusCell | undefined;
	#settled = false;

	constructor(context: OverlayContext) {
		this.#context = context;
	}

	/**
	 * 根草稿 proxy。
	 *
	 * 输入：无；输出：Draft<T>；副作用：无。
	 * 错误：事务已 settle 或根已释放时抛 TypeError。
	 * 运行时返回的是 tracker 创建的 Proxy；Draft<T> 只是编译期视图。
	 */
	get state(): Draft<T> {
		const state = this.#context?.root?.proxy;
		if (state === undefined) throw new TypeError("Cannot use a settled overlay");
		return state as Draft<T>;
	}

	/**
	 * 结束修改并生成 Prepared<T>。
	 *
	 * 输入：无；输出：物化后的值 + op 批次；副作用：上下文状态先变 prepared，随后物化并清理覆盖层。
	 * 错误：重复调用抛 Error；上下文已不可写抛 TypeError；物化/发射过程中的错误会被捕获，
	 *       把状态置为 aborted、清理上下文，然后重新抛出。无论成功失败，事务都标记 settled。
	 * 流程：置 prepared -> 若无 dirty 则 ops=[]，否则 emitOperations -> materializePrepared
	 *       -> 保存状态单元 -> settled -> 返回。finally 清空 #context。
	 *
	 * 例子：草稿中只把 a 从 1 改成 2，prepare() 返回 ops 约 [["s",["a"],2]]，value 为 {a:2}。
	 */
	prepare(): Prepared<T> {
		if (this.#settled) throw new Error("Change has already been settled");
		const context = this.#context!;
		// 只有 open 状态可 prepare；prepared/consumed/aborted/stale 都不可写。
		assertWritable(context);
		context.status.value = "prepared";
		try {
			// 替换上下文（prepareReplace）不在这里发射，materializePrepared -> ensureOperations 会处理。
			// 普通上下文若没有任何 dirty 节点，直接给空批次，跳过遍历。
			if (!context.replacement) context.ops = context.dirty.length === 0 ? [] : emitOperations(context);
			const prepared = materializePrepared<T>(context);
			// 保存状态引用：abort() 在 prepare 之后调用时需要把 prepared 改为 aborted。
			this.#preparedStatus = context.status;
			this.#settled = true;
			return prepared;
		} catch (error) {
			// 物化失败：上下文已不可用，清理并标记 aborted；重新抛给调用方。
			context.status.value = "aborted";
			clearContext(context);
			this.#settled = true;
			throw error;
		} finally {
			// 即使成功也断开 Change 对上下文的引用；之后 state 访问会抛“settled”。
			this.#context = undefined;
		}
	}

	/**
	 * 放弃事务。
	 *
	 * 输入：无；输出：无；副作用：置 settled 并清理上下文。
	 * 已经 prepare 过：把 prepared 状态改为 aborted（若仍处于 prepared），prepared 对象随之失效；
	 * 尚未 settle：调用 abortContext 清理草稿；重复调用是安全的。
	 */
	abort(): void {
		if (this.#settled) {
			if (this.#preparedStatus?.value === "prepared") this.#preparedStatus.value = "aborted";
			this.#preparedStatus = undefined;
			return;
		}
		this.#settled = true;
		abortContext(this.#context!);
		this.#context = undefined;
	}
}

/**
 * Open drafts are tracked so that adopting one change makes its open competitors stale at once. Prepared contexts need
 * no tracking: `prepare()` releases their overlay, and `adopt()` rejects them by revision.
 *
 * The most recent open context is held strongly in `#open`: with one transaction at a time per tracker, the common case,
 * that is the only one, and it costs no `WeakRef` (each `WeakRef` target survives the scavenges of the current job, and
 * V8 then pretenures the context allocation site). A second `beginChange()` while one is open moves the older context
 * into `#competitors` through a `WeakRef`, so a draft the caller drops can be collected. A dropped draft that was never
 * settled stays held by `#open` until the tracker's next `beginChange()` or `adopt()`: at most one per tracker.
 */
/**
 * Tracker 的唯一实现；`#owner` 是身份令牌，用来判断 Prepared 是否属于本 tracker。
 *
 * 并发模型：同一时刻允许多个打开的 Change。旧事务不会立刻报错，而是被降级为“竞争者”；
 * 任何一个事务成功 adopt 后，其余事务被标记 stale，从而保证同一 revision 只产生一个后继。
 * 所有权：tracker 直接持有 `#value`，不做复制；`#value` 与 prepared.base 的同一性是 adopt 的校验条件。
 */
class TrackerImpl<T extends object> implements Tracker<T> {
	// 空对象只用于身份比较；不同 tracker 永远不会得到同一个 owner 引用。
	readonly #owner = {};
	// 当前最新开始、尚未 prepare/abort 的事务；beginChange 会把它降级。
	#open: OverlayContext | undefined;
	// 已降级但还活着的竞争者；用 WeakRef，避免 tracker 阻止它们被 GC。
	#competitors: Set<WeakRef<OverlayContext>> | undefined;
	// tracker 自己也用弱引用，供上下文反查 owner（不阻止 tracker 被回收）。
	readonly #selfRef: WeakRef<TrackerImpl<object>>;
	#value: T;
	#revision = 0;
	// 竞争者集合的惰性清理预算：每降级一次减一，归零时扫一遍失效的 WeakRef。
	#pruneBudget = 256;

	constructor(initial: T) {
		this.#value = initial;
		// as unknown as 只用于消协变/不变差异；运行时仍是同一个 tracker 对象。
		this.#selfRef = new WeakRef(this as unknown as TrackerImpl<object>);
	}

	// 当前根；adopt 成功后直接指向新值，不做深拷贝。
	get value(): T {
		return this.#value;
	}

	// 从 0 开始，每次成功 adopt 加 1；用于判断 prepared 是否基于旧版本。
	get revision(): number {
		return this.#revision;
	}

	/**
	 * 开始一个修改事务。
	 *
	 * 输入：无；输出：Change<T>，其 state 是根 Proxy。
	 * 副作用：若已有 open 事务，把它降级为 competitor（不立即失败）；新上下文成为 #open。
	 * 错误：初始根不符合所有权约定（有别名/非严格 JSON）属于调用方违约，本函数不主动检查。
	 */
	beginChange(): Change<T> {
		// replacement=false：普通草稿；base 与 root 都指向当前值，草稿只记录差异。
		const context = createContext(this.#selfRef, this.#owner, this.#revision, this.#value, false, this.#value);
		if (this.#open !== undefined) this.#demote(this.#open);
		this.#open = context;
		return new ChangeImpl(context);
	}

	/**
	 * 准备把整棵树替换成 `value`。
	 *
	 * 输入：新根（调用方移交所有权）；输出：Prepared；副作用：创建一个 replacement 上下文并立即物化。
	 * 若新旧值深相等，物化为空操作：ops 为空、value 复用当前值（由 replacementNoop 标记决定）。
	 * 错误：物化失败时置 aborted、清理并重新抛出。
	 * 注意：这里不登记 #open / competitors；它不产生可写草稿，只有一个准备结果。
	 */
	prepareReplace(value: T): Prepared<T> {
		// Not tracked: materialization below releases the context before this returns, as `prepare()` does.
		const context = createContext(this.#selfRef, this.#owner, this.#revision, value, true, this.#value);
		context.status.value = "prepared";
		try {
			return materializePrepared<T>(context);
		} catch (error) {
			context.status.value = "aborted";
			clearContext(context);
			throw error;
		}
	}

	/**
	 * 提交一份 Prepared：校验归属、状态、revision 和 base 同一性，然后做指针交换。
	 *
	 * 输入：由本 tracker 的 prepare 产生的 Prepared；输出：无；副作用：
	 *   #value 换成 prepared.value、revision+1、状态置 consumed，并把其他竞争者置 stale。
	 * 错误：不属于本 tracker、已消费/已 abort/已 stale/未 ready、revision 或 base 不匹配时抛 Error。
	 * 关键点：物化已在 prepare 阶段完成，adopt 本身不会失败；持久化失败时调用方只需丢弃这个候选，
	 *          不会破坏 tracker 当前权威值。
	 */
	adopt(prepared: Prepared<T>): void {
		// 通过 WeakMap 反查上下文：伪造的对象没有登记，得到 undefined。
		const context = PREPARED.get(prepared as object);
		if (context?.owner !== this.#owner) throw new Error("Prepared change belongs to a different tracker");
		if (context.status.value === "consumed") throw new Error("Prepared change has already been used");
		if (context.status.value === "aborted") throw new Error("Prepared change has been aborted");
		if (context.status.value === "stale") throw new Error("Prepared change is stale");
		if (context.status.value !== "prepared") throw new Error("Prepared change is not ready");
		// 版本已推进：即使 base 引用碰巧相同，也不能把旧候选接到新历史上。
		if (context.baseRevision !== this.#revision) {
			context.status.value = "stale";
			clearContext(context);
			throw new Error("Prepared change is stale");
		}

		// revision 相同还不够：根可能被替换成另一个结构相同的值；引用比较确认它仍是同一份权威值。
		if (this.#value !== prepared.base) {
			context.status.value = "stale";
			throw new Error("Prepared change is stale");
		}
		// Materialization happened during prepare. Adoption is an infallible pointer
		// swap so storage failure can discard the candidate without touching authority.
		this.#value = prepared.value;
		context.status.value = "consumed";
		this.#revision += 1;
		this.#invalidate(context);
	}

	/**
	 * 上下文结束后的注销入口（由 abort/prepare 清理路径调用）。
	 *
	 * 输入：上下文；输出：无；副作用：从 #open 或竞争者集合中移除并清空 registryRef。
	 * 若上下文不是当前 open，也不是登记过的竞争者，则什么也不做；重复调用安全。
	 */
	releaseContext(context: OverlayContext): void {
		if (this.#open === context) this.#open = undefined;
		else if (context.registryRef !== undefined) this.#competitors?.delete(context.registryRef);
		context.registryRef = undefined;
	}

	/**
	 * 把一个仍打开的旧事务降级为竞争者。
	 *
	 * 输入：旧上下文；输出：无；副作用：创建 WeakRef 放进 #competitors，并维护清理预算。
	 * 用 WeakRef 的原因：事务对象和它的 proxy 可能已被调用方丢弃；tracker 不应把它们强引用到永远。
	 * 清理策略：每降级约 256 次扫一遍已失效的引用；预算至少保持 256，避免小集合反复扫描。
	 */
	#demote(context: OverlayContext): void {
		const reference = new WeakRef(context);
		context.registryRef = reference;
		this.#competitors ??= new Set();
		this.#competitors.add(reference);
		this.#pruneBudget -= 1;
		if (this.#pruneBudget === 0) {
			for (const entry of this.#competitors) {
				if (entry.deref() === undefined) this.#competitors.delete(entry);
			}
			this.#pruneBudget = Math.max(256, this.#competitors.size);
		}
	}

	/**
	 * adopt 成功后让所有竞争事务过期。
	 *
	 * 输入：成功者上下文；输出：无；副作用：清空 #open 与 #competitors，对每个仍存活者调用 staleCompetitor。
	 * winner 会被跳过，因此成功者自己的状态保持 consumed。
	 */
	#invalidate(winner: OverlayContext): void {
		const open = this.#open;
		const competitors = this.#competitors;
		this.#open = undefined;
		this.#competitors = undefined;
		this.#pruneBudget = 256;
		if (open !== undefined) staleCompetitor(open, winner);
		if (competitors === undefined) return;
		for (const reference of competitors) {
			const context = reference.deref();
			if (context !== undefined) staleCompetitor(context, winner);
		}
	}

	/**
	 * replacement 上下文在物化时需要确认“基于哪个权威值”。
	 *
	 * 输入：上下文；输出：若上下文基于当前 revision，返回当前根；否则 undefined（说明已过期）。
	 * 这是 prepareReplace 在生成期间防止竞态读取旧值的钩子。
	 */
	replacementBase(context: OverlayContext): T | undefined {
		return context.baseRevision === this.#revision ? this.#value : undefined;
	}
}

/**
 * 把一个竞争上下文标记为 stale，并断开它对覆盖层的强引用。
 *
 * 输入：竞争者上下文、成功者上下文；输出：无；副作用：状态改为 stale，清空 registryRef 和覆盖层引用。
 * 跳过 winner；只有 open/prepared 需要改状态，consumed/aborted/stale 保持原状。
 * 这里不遍历草稿接触过的每个节点：丢弃强引用是 O(1)，外部仍持有的 proxy 会通过状态看到失效。
 */
function staleCompetitor(context: OverlayContext, winner: OverlayContext): void {
	if (context === winner) return;
	if (context.status.value === "open" || context.status.value === "prepared") context.status.value = "stale";
	// Adoption must not walk every node touched by a competing draft. Drop the
	// context's strong overlay references in O(1); externally retained proxies
	// still see the stale status and are reclaimed with their holders.
	context.registryRef = undefined;
	releaseOverlayReferences(context);
}

/** Take immutable ownership of an alias-free strict-JSON root in O(1). */
/**
 * 以 O(1) 接管一个无别名、严格 JSON 的根。
 *
 * 输入：`initial`，调用方承诺此后不再直接修改它，且树内没有共享容器；输出：Tracker。
 * 副作用：无复制、无遍历；tracker 直接持有该引用。
 * 错误：不做运行时校验；违反所有权约定的行为是未定义后果（可能出现丢失写入或共享突变）。
 * 这是刻意的设计：tracker 是高频写路径，跟踪成本必须与树大小无关。
 */
export function track<T extends object>(initial: T): Tracker<T> {
	return new TrackerImpl(initial);
}

/**
 * Append `text` to the string at `draft[key]`, costing O(text.length). The change is recorded as one append op
 * (several appends to the same key in one change join into one op) without comparing the old and new strings. A plain
 * assignment such as `draft[key] += text` gives the same op, but `prepare()` then has to check that the new string
 * extends the old one, which reads the whole string: O(length) per change. A plain assignment or deletion of the key in
 * the same change falls back to that check.
 */
export function appendText<T extends object>(draft: Draft<T>, key: StringKeys<T>, text: string): void {
	// Trust boundary: JavaScript callers can pass any object and key; the types cover TypeScript callers.
	const node = (draft as Record<PropertyKey, unknown>)[NODE] as OverlayNode | undefined;
	if (node === undefined) throw new TypeError("appendText() needs a draft");
	// appendText 是写操作：已 prepare 的草稿只读，已 settle 的草稿直接不可用。
	assertWritable(node.context);
	const name = String(key);
	// 数组或已被删除的键没有可追加的字符串：current 为 undefined，下面统一报错。
	const current = Array.isArray(nodeBase(node)) || !objectHas(node, name) ? undefined : objectValue(node, name);
	if (typeof current !== "string") throw new TypeError(`appendText() needs a string at ${JSON.stringify(name)}`);
	// 空串不产生任何观察得到的差异，直接返回，避免制造 dirty 节点。
	if (text.length === 0) return;
	// The op and the new value keep the text; a copy, so they never keep a larger string the caller cut it from alive.
	// ownedSlice 复制一份：调用方可能传入大字符串的切片，不能让值长期持有底层更大的字符串。
	const owned = ownedSlice(text, 0);
	// appends 记录“本次事务内纯追加”的字符串，用于 prepare 时直接生成 `a` 而不比较新旧串。
	// 第一次写返回 ""；若该键已是非追加写入（包括结构写），返回 undefined，表示不能再走快速路径。
	const appended = node.appends?.get(name) ?? (hasObjectWrite(node, name) ? undefined : "");
	setObjectWrite(node, name, current + owned);
	markDirty(node);
	if (appended !== undefined) {
		node.appends ??= new Map();
		node.appends.set(name, appended + owned);
	}
}

/**
 * prepare 的最后一步：确保 ops、物化新值、创建 Prepared，并清理草稿。
 *
 * 输入：已置为 prepared 的上下文；输出：PreparedImpl；副作用：释放/清理覆盖层。
 * 物化路径：
 *   - 无操作：复用 base，value === base；
 *   - 纯对象且启用 simpleObjectMaterialization：直接从草稿节点克隆，跳过 op 重放；
 *   - 其他：按 ops 应用（信任快速路径或公共 applyImmutable）。
 * 大草稿（节点数 > 4096）用 releaseOverlayReferences 延迟逐节点清理，避免 prepare 卡顿；
 * 小草稿用 clearContext 立即断开引用。两者都不修改已经物化的值。
 */
function materializePrepared<T extends object>(context: OverlayContext): PreparedImpl<T> {
	const operations = ensureOperations(context);
	const base = context.baseValue as T;
	// Operation payloads are already detached from the mutable overlay. The
	// resulting revision and public batch intentionally share those payloads under
	// the trusted immutable-transfer contract.
	const value =
		operations.length === 0
			? base
			: context.simpleObjectMaterialization
				? (cloneNode(context.root!) as T)
				: materializeOperations(base, operations);
	const prepared = new PreparedImpl(context, value, operations);
	if (context.nodes.length > 4_096) releaseOverlayReferences(context);
	else clearContext(context);
	return prepared;
}

/**
 * 按 op 类型选择应用器。
 *
 * 输入：base 与 ops；输出：新根；副作用：无（应用器内部只改自己拷贝的容器）。
 * 含 p/m（数组 splice/permutation）时交给公共 applyImmutable：原生数组操作更快；
 * 否则交给可信快速路径 applyImmutableTrusted，省去重复的路径与 payload 校验。
 */
function materializeOperations<T extends object>(base: T, operations: readonly Op[]): T {
	for (const operation of operations) {
		// Native splice/permutation remains faster for large structural batches.
		if (operation[0] === "p" || operation[0] === "m") return applyImmutable(base, operations);
	}
	return applyImmutableTrusted(base, operations);
}

/**
 * 创建一个覆盖层上下文（草稿的内部状态），并创建根节点。
 *
 * 输入：tracker 弱引用、owner 身份、基础 revision、root、是否 replacement、权威 base。
 * 输出：初始化完毕的 OverlayContext；副作用：创建根节点的 target/Proxy 并登记到 nodes。
 * 字段说明见 OverlayContext；这里所有集合都按需分配，空草稿不产生 Map/WeakMap 开销。
 */
function createContext<T extends object>(
	tracker: WeakRef<TrackerImpl<object>>,
	owner: object,
	baseRevision: number,
	root: T,
	replacement: boolean,
	base: T,
): OverlayContext {
	const context: OverlayContext = {
		owner,
		tracker,
		baseRevision,
		status: { value: "open" },
		root: undefined,
		bases: [],
		stored: undefined,
		dirty: [],
		nodes: [],
		rawNodes: undefined,
		ops: undefined,
		replacement,
		replacementNoop: false,
		baseValue: base,
		overlayReleased: false,
		simpleObjectMaterialization: false,
		registryRef: undefined,
	};
	context.root = createNode(context, root as Container, undefined);
	return context;
}

/**
 * 所有草稿对象和草稿数组共享的 Proxy 处理器（数组也复用它，数组相关行为由底层 nodeBase 判定）。
 *
 * 设计：Proxy 的 target 是一个空的 `{}` 或 `[]`，真正的数据（base、覆盖层）由 node 记录。
 * 每个 trap 都先通过 target 上的 NODE 符号取回节点；settle 后 NODE 会被删除，于是访问报错。
 */
const sharedObjectHandler: ProxyHandler<object> = {
	deleteProperty(target, property) {
		return deleteProperty(nodeForTarget(target), property);
	},
	defineProperty(target) {
		// Object.defineProperty 绕过 set trap，且可能引入不可配置属性；不支持，避免状态不一致。
		assertWritable(nodeForTarget(target).context);
		throw new TypeError("Defining overlay properties is not supported");
	},
	get(target, property) {
		// `then` 特殊处理：草稿不是 Promise；若返回函数，await 草稿时会被当成 thenable。
		// 已 settle 时返回 undefined，让 await 得到普通对象而不是继续调用。
		if (property === "then") {
			const node = (target as Record<PropertyKey, unknown>)[NODE] as OverlayNode | undefined;
			if (node === undefined || isSettledContext(node.context)) return undefined;
		}
		const node = nodeForTarget(target);
		if (property === NODE) return node;
		return getProperty(node, property);
	},
	getOwnPropertyDescriptor(target, property) {
		return getDescriptor(nodeForTarget(target), property);
	},
	getPrototypeOf(target) {
		const node = nodeForTarget(target);
		assertReadable(node.context);
		// 暴露 base 的原型（普通对象 -> Object.prototype，null 原型对象 -> null）。
		return Object.getPrototypeOf(nodeBase(node));
	},
	has(target, property) {
		return hasProperty(nodeForTarget(target), property);
	},
	isExtensible(target) {
		assertReadable(nodeForTarget(target).context);
		return true;
	},
	ownKeys(target) {
		return ownKeys(nodeForTarget(target));
	},
	preventExtensions(target) {
		assertWritable(nodeForTarget(target).context);
		throw new TypeError("Overlays cannot be made non-extensible");
	},
	set(target, property, value) {
		return setProperty(nodeForTarget(target), property, value);
	},
	setPrototypeOf(target) {
		assertWritable(nodeForTarget(target).context);
		throw new TypeError("Changing an overlay prototype is not supported");
	},
};

// 数组没有额外的 trap 差异：length、下标、数组方法都在 getProperty/setProperty 内部分派。
const sharedArrayHandler: ProxyHandler<object> = sharedObjectHandler;

/**
 * 为一个 base 容器创建覆盖层节点及其 Proxy（同一 base 在本上下文内复用）。
 *
 * 输入：上下文、base 容器、父节点信息（父节点/种类/键/插入来源/placement 标记）。
 * 输出：OverlayNode；副作用：把 base 放入 context.bases，把节点放入 context.nodes；
 *       首次遇到非根容器时建立 rawNodes 弱映射，保证同一 base 只对应一个节点。
 * 错误：无；节点字段都是内部数据。
 *
 * 参数 `parentKind`：0 表示对象属性，1 表示数组 base 元素，2 表示数组插入元素；
 * `parentSource` 只在数组插入元素时存在；`parentPlacement` 表示该值是否由外部 placement 写入。
 */
function createNode(
	context: OverlayContext,
	base: Container,
	parent: OverlayNode | undefined,
	parentKind: ParentKind = 0,
	parentKey: string | number = "",
	parentSource: InsertSource | undefined = undefined,
	parentPlacement = false,
): OverlayNode {
	// 同一 base 被多次读取（例如 get 两次同一子对象）时返回同一个 proxy，保持身份稳定。
	const existing = context.rawNodes?.get(base);
	if (existing !== undefined) return existing;
	// Proxy 的 target 必须与 base 同类型（数组/对象），便于原生方法通过内部槽检查。
	const target: object = Array.isArray(base) ? [] : {};
	const baseIndex = context.bases!.length;
	// 根节点的 parentIndex 为 -1；其余记录父节点在 nodes 中的下标（用下标而不是引用，便于释放）。
	const parentIndex = parent?.baseIndex ?? -1;
	context.bases!.push(base);
	const node: OverlayNode = {
		context,
		baseIndex,
		parentIndex,
		parentKind,
		parentKey,
		parentPlacement,
		target,
		proxy: target,
	};
	if (parentSource !== undefined) node.parentSource = parentSource;
	(target as Record<PropertyKey, unknown>)[NODE] = node;
	node.proxy = new Proxy(target, Array.isArray(base) ? sharedArrayHandler : sharedObjectHandler);
	// The root is never reached again through a child value (tracked values are alias-free), so a change that touches
	// only the root needs no map.
	if (parent !== undefined) {
		context.rawNodes ??= new WeakMap();
		context.rawNodes.set(base, node);
	}
	context.nodes.push(node);
	return node;
}

// 通过 baseIndex 间接取 base：释放覆盖层时只清空 bases 数组即可断开所有引用。
function nodeBase(node: OverlayNode): Container {
	return node.context.bases![node.baseIndex]!;
}

// 根节点没有父节点；parentIndex 是 nodes 下标，不是 baseIndex（两者恰好同序但语义不同）。
function nodeParent(node: OverlayNode): OverlayNode | undefined {
	return node.parentIndex < 0 ? undefined : node.context.nodes[node.parentIndex];
}

/**
 * 把一次写入的值放进上下文的 stored 表，返回可存进节点的引用。
 *
 * 输入：上下文、Stored 值；输出：原始值（primitive 直接存）或 `{index}` 引用。
 * 副作用：首次写入容器时创建 stored 数组并 push。
 * 为什么要间接层：节点字段需要可枚举/可复制的简单形状，同时容器值的生命周期由 stored 表统一释放。
 */
function storeValue(context: OverlayContext, value: Stored): StoredRef {
	if (!isContainer(value)) return value;
	// Created on the first container write: primitive writes never store.
	context.stored ??= [];
	const index = context.stored.length;
	context.stored.push(value);
	return { index };
}

// 把 StoredRef 还原为值；注意 RELEASED 哨兵也会被原样返回，由调用方负责不要读取已释放项。
function storedValue(context: OverlayContext, reference: StoredRef): Stored {
	return typeof reference === "object" && reference !== null ? context.stored![reference.index]! : reference;
}

/**
 * 替换一个已有的存储槽。
 *
 * 输入：上下文、旧引用、新值；输出：新引用；副作用：可能原地替换 stored 槽或标记旧槽 RELEASED。
 * 规则：新值仍是容器且旧引用也是槽引用时复用槽；否则重新 store；新值变成 primitive 时释放旧槽并直接返回 primitive。
 */
function replaceStoredValue(context: OverlayContext, reference: StoredRef, value: Stored): StoredRef {
	if (isContainer(value)) {
		if (typeof reference === "object" && reference !== null) {
			context.stored![reference.index] = value;
			return reference;
		}
		return storeValue(context, value);
	}
	if (typeof reference === "object" && reference !== null) context.stored![reference.index] = RELEASED;
	return value;
}

// 删除/覆盖容器值时把槽标记为 RELEASED，帮助大草稿的延迟清理尽快释放容器。
function releaseStoredValue(context: OverlayContext, reference: StoredRef): void {
	if (typeof reference === "object" && reference !== null) context.stored![reference.index] = RELEASED;
}

// Proxy trap 的 target -> 节点；NODE 在 settle 时被清除，所以之后访问统一抛 TypeError。
function nodeForTarget(target: object): OverlayNode {
	const node = (target as Record<PropertyKey, unknown>)[NODE] as OverlayNode | undefined;
	if (node === undefined) throw new TypeError("Cannot use a settled overlay");
	return node;
}

// 上下文是否已经不可读：显式释放，或状态进入 consumed/aborted/stale 任一终态。
function isSettledContext(context: OverlayContext): boolean {
	return (
		context.overlayReleased ||
		context.status.value === "consumed" ||
		context.status.value === "aborted" ||
		context.status.value === "stale"
	);
}

// 读取前检查：settle 后的 proxy 不再暴露数据。
function assertReadable(context: OverlayContext): void {
	if (isSettledContext(context)) throw new TypeError("Cannot use a settled overlay");
}

// 写入前检查：除了可读，还要求状态仍是 open；prepared 之后只读。
function assertWritable(context: OverlayContext): void {
	assertReadable(context);
	if (context.status.value !== "open") throw new TypeError("Prepared overlays are read-only");
}

/**
 * get trap 的读取分派：数组 -> overlay 计算；对象 -> base/覆盖层合并。
 *
 * 输入：节点与属性键；输出：值（容器会包成子节点 proxy）。
 * 错误：settle 后抛 TypeError；不存在的属性走原型链。
 * 数组特殊处理：length 由 overlay 计算；mutator 方法返回绑定 overlay 的包装；
 * 下标走 piece treap；其他属性（map、slice 等）从 Array.prototype 读取并绑定到 proxy。
 */
function getProperty(node: OverlayNode, property: PropertyKey): unknown {
	assertReadable(node.context);
	if (Array.isArray(nodeBase(node))) {
		const overlay = arrayOverlay(node);
		if (property === "length") return arrayLength(overlay);
		if (ARRAY_MUTATORS.has(property)) return arrayMutators[property as keyof typeof arrayMutators];
		const index = arrayIndex(property);
		if (index !== undefined) return getArrayIndex(node, index);
		// 非下标方法：用 proxy 作为 this，方法内部对数组的读写会继续经过我们的 trap。
		return Reflect.get(Array.prototype, property, node.proxy);
	}
	if (typeof property === "symbol") return Reflect.get(nodeBase(node), property, node.proxy);
	const key = String(property);
	if (!objectHas(node, key)) {
		// 显式删除过：即使 base 上有也返回 undefined；否则按原型链读取（如 toString）。
		if (isObjectDeleted(node, key) || Object.hasOwn(nodeBase(node), key)) return undefined;
		return Reflect.get(nodeBase(node), property, node.proxy);
	}
	const value = objectValue(node, key);
	// primitive 直接返回；容器延迟创建节点，只在真正被访问时付出成本。
	if (!isContainer(value)) return value;
	return createNode(node.context, value, node, 0, key, undefined, hasObjectWrite(node, key)).proxy;
}

/**
 * 读取数组某个逻辑下标。
 *
 * 输入：数组节点与下标；输出：值或子节点 proxy；越界返回 undefined。
 * 流程：定位覆盖层中负责该下标的 piece，算出它在 piece 内的 sourceIndex，再按 piece 类型读 base 或插入源；
 *       容器值创建节点时记录父种类、key 和来源，供后续写回时正确定位。
 */
function getArrayIndex(node: OverlayNode, index: number): unknown {
	const overlay = arrayOverlay(node);
	if (index >= arrayLength(overlay)) return undefined;
	const piece = locatePiece(overlay, index);
	// locatedOffset 是 locatePiece 的副产物：目标下标在 piece 内的偏移。
	const sourceIndex = piece.start + piece.step * overlay.locatedOffset;
	const value = entryValueAt(node, piece, sourceIndex);
	if (!isContainer(value)) return value;
	return createNode(
		node.context,
		value,
		node,
		piece.kind === "base" ? 1 : 2,
		sourceIndex,
		piece.kind === "insert" ? piece.source : undefined,
		piece.kind === "insert" || hasEntryOverrideAt(overlay, piece, sourceIndex),
	).proxy;
}

/**
 * set trap：数组与对象都支持，但语义和错误不同。
 *
 * 输入：节点、属性键、调用方提供的值；输出：true（表示写入成功）。
 * 错误：symbol 键不支持；数组只允许下标和 length，且不允许产生空洞；overlay 只写一层索引。
 * 对象：值为 undefined 等价于 delete（与 JS 普通对象赋值语义一致）；
 *       相同 primitive 的重复写不标 dirty；容器值经 clonePlacement 复制/校验后存放。
 */
function setProperty(node: OverlayNode, property: PropertyKey, supplied: unknown): boolean {
	assertWritable(node.context);
	if (typeof property === "symbol") throw new TypeError("Symbol writes are not supported");
	if (Array.isArray(nodeBase(node))) {
		if (property === "length") {
			setArrayLength(node, toArrayLength(supplied));
			return true;
		}
		const index = arrayIndex(property);
		if (index === undefined) throw new TypeError("Only array indices and length can be written");
		// 允许 index === length（追加），但不允许跳过中间元素；overlay 数组必须保持稠密。
		if (index > arrayLength(arrayOverlay(node))) throw new TypeError("Overlay arrays cannot contain holes");
		// clonePlacement：把外部对象复制成独立值，防止调用方之后继续修改它而影响草稿。
		setArrayIndex(node, index, clonePlacement(supplied));
		return true;
	}
	const key = String(property);
	if (supplied === undefined) return deleteProperty(node, key);
	const stored = clonePlacement(supplied);
	const current = objectValue(node, key);
	const wasDeleted = isObjectDeleted(node, key);
	// 同一 primitive 的重复写不产生任何观察差异；但容器不能这样比较引用（每次都视为一次写入）。
	if (!wasDeleted && !isContainer(stored) && current === stored) return true;
	// 任何非纯粹追加的写入都会使该键的 appends 快速路径失效。
	node.appends?.delete(key);
	setObjectWrite(node, key, stored);
	if (wasDeleted && Object.hasOwn(nodeBase(node), key)) {
		// 重新添加一个曾被删除的 base 键：ownKeys 需要把它从“新键”分类中排除。
		if (node.readded === undefined) node.readded = new Set();
		node.readded.add(key);
	}
	deleteObjectDeletion(node, key);
	markDirty(node);
	return true;
}

/**
 * delete trap：对象键删除；数组不支持（delete 会产生空洞）。
 *
 * 输入：节点与键；输出：true；副作用：删除覆盖层写入、记录删除标记、标 dirty。
 * 不存在的键直接返回 true（与 JS delete 语义一致，且不产生 op）。
 */
function deleteProperty(node: OverlayNode, property: PropertyKey): boolean {
	assertWritable(node.context);
	if (typeof property === "symbol") throw new TypeError("Symbol writes are not supported");
	if (Array.isArray(nodeBase(node))) throw new TypeError("Overlay arrays cannot contain holes");
	const key = String(property);
	if (!objectHas(node, key)) return true;
	node.appends?.delete(key);
	deleteObjectWrite(node, key);
	node.readded?.delete(key);
	setObjectDeletion(node, key);
	markDirty(node);
	return true;
}

/**
 * has trap（`in` 运算符）。
 *
 * 数组：length 恒存在；合法下标判断是否小于 overlay 长度；其他键查 Array.prototype。
 * 对象：symbol 走 base 原型链；字符串键使用合并后的 objectHas（删除标记优先，其次是覆盖写入/base 自有键）。
 */
function hasProperty(node: OverlayNode, property: PropertyKey): boolean {
	assertReadable(node.context);
	if (Array.isArray(nodeBase(node))) {
		if (property === "length") return true;
		const index = arrayIndex(property);
		if (index !== undefined) return index < arrayLength(arrayOverlay(node));
		return property in Array.prototype;
	}
	return typeof property === "symbol" ? property in nodeBase(node) : objectHas(node, String(property));
}

/**
 * ownKeys trap（Object.keys/for...in/JSON.stringify 等）。
 *
 * 输入：节点；输出：键数组。数组返回 "0".."n-1" 和 "length"；对象按 JS 顺序：
 * 整数下标升序在前，其余字符串按插入顺序。
 * 快速路径：若没有任何删除/重加/新增键，直接用 base 的 Object.keys，避免分配合并集合。
 */
function ownKeys(node: OverlayNode): ArrayLike<string | symbol> {
	assertReadable(node.context);
	if (Array.isArray(nodeBase(node))) {
		const length = arrayLength(arrayOverlay(node));
		const keys = new Array<string>(length + 1);
		for (let index = 0; index < length; index++) keys[index] = String(index);
		keys[length] = "length";
		return keys;
	}
	// 仅当所有覆盖写入都落在 base 已有键上时，键集合与 base 完全相同。
	let existingKeysOnly =
		node.deleteKey === undefined &&
		node.deletes === undefined &&
		node.readded === undefined &&
		(node.writeKey === undefined || Object.hasOwn(nodeBase(node), node.writeKey));
	if (existingKeysOnly && node.writes !== undefined) {
		for (const key of node.writes.keys()) {
			if (!Object.hasOwn(nodeBase(node), key)) {
				existingKeysOnly = false;
				break;
			}
		}
	}
	if (existingKeysOnly) return Object.keys(nodeBase(node));
	// 慢路径：过滤删除/重新添加的键，再补上覆盖写入中的新键。
	const keys = Object.keys(nodeBase(node)).filter((key) => !isObjectDeleted(node, key) && !node.readded?.has(key));
	const seen = new Set(keys);
	if (node.writeKey !== undefined && !seen.has(node.writeKey)) {
		keys.push(node.writeKey);
		seen.add(node.writeKey);
	}
	if (node.writes !== undefined) {
		for (const key of node.writes.keys()) {
			if (seen.has(key)) continue;
			keys.push(key);
			seen.add(key);
		}
	}
	// JS 自有键顺序：数组下标形式的键按数值升序排在字符串键之前。
	const indices: number[] = [];
	const strings: string[] = [];
	for (const key of keys) {
		const index = arrayIndex(key);
		if (index === undefined) strings.push(key);
		else indices.push(index);
	}
	indices.sort((left, right) => left - right);
	return [...indices.map(String), ...strings];
}

/**
 * getOwnPropertyDescriptor trap：Object.getOwnPropertyDescriptor / 展开运算符等会调用。
 *
 * 数组：length 使用 target 的真实 descriptor（先同步 target.length）；
 *       合法下标返回通用可配置数据属性；对象：不存在或已删除返回 undefined。
 * writable 在 open 状态为 true，prepared 之后为 false：向反射 API 反映只读状态。
 */
function getDescriptor(node: OverlayNode, property: PropertyKey): PropertyDescriptor | undefined {
	assertReadable(node.context);
	if (Array.isArray(nodeBase(node))) {
		if (property === "length") {
			const length = arrayLength(arrayOverlay(node));
			(node.target as unknown[]).length = length;
			return Reflect.getOwnPropertyDescriptor(node.target, "length");
		}
		const index = arrayIndex(property);
		if (index === undefined || index >= arrayLength(arrayOverlay(node))) return undefined;
	} else {
		if (typeof property === "symbol" || !objectHas(node, String(property))) return undefined;
	}
	return {
		configurable: true,
		enumerable: true,
		writable: node.context.status.value === "open",
		value: getProperty(node, property),
	};
}

// 判断某键是否被覆盖写入；writeKey/writeValue 是单键快路径，writes 是多键时的 Map。
function hasObjectWrite(node: OverlayNode, key: string): boolean {
	return node.writeKey === key || (node.writes?.has(key) ?? false);
}

/**
 * 记录一次对象键写入。
 *
 * 输入：节点、键、Stored 值；输出：无；副作用：更新 writeKey/writeValue 或 writes Map，必要时把存储值放进 stored。
 * 结构演进：无写入 -> 单键快路径；写同一个键 -> 原地替换值；写第二个键 -> 把快路径内容搬进 Map，
 * 之后都走 Map，避免每条写入都做“键是否相同”的分支判断。
 */
function setObjectWrite(node: OverlayNode, key: string, value: Stored): void {
	if (node.writes !== undefined) {
		const reference = node.writes.get(key);
		node.writes.set(
			key,
			reference === undefined ? storeValue(node.context, value) : replaceStoredValue(node.context, reference, value),
		);
		return;
	}
	if (node.writeKey === undefined || node.writeKey === key) {
		node.writeKey = key;
		node.writeValue =
			node.writeValue === undefined
				? storeValue(node.context, value)
				: replaceStoredValue(node.context, node.writeValue, value);
		return;
	}
	// 第二个不同的键：升级为 Map，并清空单键字段，避免同一写入存在两份表示。
	node.writes = new Map();
	node.writes.set(node.writeKey, node.writeValue!);
	node.writes.set(key, storeValue(node.context, value));
	node.writeKey = undefined;
	node.writeValue = undefined;
}

// 删除覆盖写入并释放它占用的存储槽；键本身可能回退到 base 值（由调用方的删除标记决定）。
function deleteObjectWrite(node: OverlayNode, key: string): void {
	if (node.writeKey === key) {
		node.writeKey = undefined;
		releaseStoredValue(node.context, node.writeValue!);
		node.writeValue = undefined;
	} else {
		const reference = node.writes?.get(key);
		if (reference !== undefined) releaseStoredValue(node.context, reference);
		node.writes?.delete(key);
	}
}

// 是否存在“已删除”标记；与写入标记不同，删除标记优先级更高（删除后再写会清掉它）。
function isObjectDeleted(node: OverlayNode, key: string): boolean {
	return node.deleteKey === key || (node.deletes?.has(key) ?? false);
}

// 记录删除标记；与写入一样有单键快路径，第二个键时升级为 Set。
function setObjectDeletion(node: OverlayNode, key: string): void {
	if (node.deletes !== undefined) {
		node.deletes.add(key);
		return;
	}
	if (node.deleteKey === undefined || node.deleteKey === key) {
		node.deleteKey = key;
		return;
	}
	node.deletes = new Set();
	node.deletes.add(node.deleteKey);
	node.deletes.add(key);
	node.deleteKey = undefined;
}

// 撤销删除标记（重新写入该键时调用）。
function deleteObjectDeletion(node: OverlayNode, key: string): void {
	if (node.deleteKey === key) node.deleteKey = undefined;
	else node.deletes?.delete(key);
}

// 合并视图上的“自有键是否存在”：删除优先，其次覆盖写入，最后看 base 自有键（不看原型链）。
function objectHas(node: OverlayNode, key: string): boolean {
	if (isObjectDeleted(node, key)) return false;
	return hasObjectWrite(node, key) || Object.hasOwn(nodeBase(node), key);
}

// 合并视图上的取值：覆盖写入优先，否则读 base；`!` 表示调用方已用 objectHas 确认存在。
function objectValue(node: OverlayNode, key: string): Stored {
	if (node.writeKey === key) return storedValue(node.context, node.writeValue!);
	const reference = node.writes?.get(key);
	if (reference !== undefined) return storedValue(node.context, reference);
	return (nodeBase(node) as Record<string, JsonValue>)[key]!;
}

/**
 * 标记节点被修改。
 *
 * 输入：节点；输出：无；副作用：首次标记时把节点加入 dirty 列表，并沿父链设置 subtreeDirty。
 * dirty 列表保证每条最底层修改只 emit 一次；subtreeDirty 让 emit 快速跳过未变化的子树。
 * 父链只会向上，因此一次写入是 O(深度)，不是 O(树大小)。
 */
function markDirty(node: OverlayNode): void {
	if (node.dirty) return;
	node.dirty = true;
	node.context.dirty.push(node);
	for (let parent = nodeParent(node); parent !== undefined; parent = nodeParent(parent)) parent.subtreeDirty = true;
}

/**
 * 延迟创建数组覆盖层（惰性 treap）。
 *
 * 输入：数组节点；输出：ArrayOverlay；副作用：首次调用时在 node.array 上创建并建立初始 base piece。
 * 初始状态是一整段 step=1 的 base piece，后续插入/删除通过 split/merge 把它拆成多段。
 * 空数组没有 piece；seed 是 treap 优先级的固定初值（确定性伪随机，便于复现）。
 */
function arrayOverlay(node: OverlayNode): ArrayOverlay {
	if (node.array !== undefined) return node.array;
	const base = nodeBase(node) as JsonValue[];
	const overlay: ArrayOverlay = {
		root: undefined,
		pieces: undefined,
		baseOverrides: undefined,
		insertOverrides: undefined,
		structural: false,
		generation: 0,
		plan: undefined,
		seed: 0x9e3779b9,
		locatedOffset: 0,
		baseLocations: undefined,
		insertLocations: undefined,
	};
	if (base.length > 0)
		overlay.root = createPieceNode(overlay, { kind: "base", start: 0, length: base.length, step: 1 });
	node.array = overlay;
	return overlay;
}

// 惰性创建 base 元素覆盖表：key 是 base 数组中的原始下标，value 是指向 stored 的引用。
function baseOverridesForWrite(overlay: ArrayOverlay): Map<number, StoredRef> {
	if (overlay.baseOverrides === undefined) overlay.baseOverrides = new Map();
	return overlay.baseOverrides;
}

// 插入元素的覆盖表按 InsertSource 分组：key 是该插入源内部的下标。
function insertOverridesForWrite(overlay: ArrayOverlay): Map<InsertSource, Map<number, StoredRef>> {
	if (overlay.insertOverrides === undefined) overlay.insertOverrides = new Map();
	return overlay.insertOverrides;
}

/**
 * 生成隐式 treap 的随机优先级（xorshift32）。
 *
 * 输入：overlay（读取并更新 seed）；输出：32 位无符号整数。
 * 固定初值 + 确定性递推：同一操作序列总得到同一树形，便于测试与复现。
 */
function nextPiecePriority(overlay: ArrayOverlay): number {
	let value = overlay.seed;
	value ^= value << 13;
	value ^= value >>> 17;
	value ^= value << 5;
	overlay.seed = value >>> 0;
	return overlay.seed;
}

// treap 的子树元素总数；空子树为 0。
function treeElements(node: PieceNode | undefined): number {
	return node?.elements ?? 0;
}

// 结构变化后重算节点的 elements：左子树 + 本 piece 长度 + 右子树。
function updatePieceNode(node: PieceNode): void {
	node.elements = treeElements(node.left) + node.piece.length + treeElements(node.right);
}

// 创建 treap 叶子；优先级从这里取，piece 本身不携带树信息。
function createPieceNode(overlay: ArrayOverlay, piece: Piece): PieceNode {
	return { piece, left: undefined, right: undefined, priority: nextPiecePriority(overlay), elements: piece.length };
}

/**
 * 合并两棵 treap，要求 left 的所有元素都排在 right 之前。
 *
 * 输入：两棵子树；输出：合并后的根；副作用：原地改指针并更新 elements。
 * 规则：优先级大者作根（大根堆），递归把另一棵并入其相应子树；不复制节点。
 */
function mergePieceTrees(left: PieceNode | undefined, right: PieceNode | undefined): PieceNode | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	if (left.priority >= right.priority) {
		left.right = mergePieceTrees(left.right, right);
		updatePieceNode(left);
		return left;
	}
	right.left = mergePieceTrees(left, right.left);
	updatePieceNode(right);
	return right;
}

/**
 * 在逻辑下标 `index` 处把 treap 分成 [0,index) 与 [index,end) 两棵。
 *
 * 输入：overlay（需要创建新节点时取优先级）、根、切分下标；输出：左右两棵子树。
 * 关键分支：
 * - index 落在左子树：递归切左子树，把右半挂回 root.left；
 * - index 落在右子树：减去本节点和左子树的长度后递归切右子树；
 * - index 正好在节点左边界/右边界：断开对应子树，无需新建 piece；
 * - index 落在 piece 内部：把 piece 拆成两段（调整 start/length，step 不变），各自建节点。
 * 这是惰性数组结构的基本操作：O(log pieces)，不移动元素。
 */
function splitPieceTree(
	overlay: ArrayOverlay,
	root: PieceNode | undefined,
	index: number,
): [PieceNode | undefined, PieceNode | undefined] {
	if (root === undefined) return [undefined, undefined];
	const leftLength = treeElements(root.left);
	if (index < leftLength) {
		const [left, right] = splitPieceTree(overlay, root.left, index);
		root.left = right;
		updatePieceNode(root);
		return [left, root];
	}
	const pieceEnd = leftLength + root.piece.length;
	if (index > pieceEnd) {
		const [left, right] = splitPieceTree(overlay, root.right, index - pieceEnd);
		root.right = left;
		updatePieceNode(root);
		return [root, right];
	}
	if (index === leftLength) {
		const left = root.left;
		root.left = undefined;
		updatePieceNode(root);
		return [left, root];
	}
	if (index === pieceEnd) {
		const right = root.right;
		root.right = undefined;
		updatePieceNode(root);
		return [root, right];
	}
	// 切在 piece 中间：第一段保留原 start/step，第二段起点按 step 前移 offset。
	const offset = index - leftLength;
	const first = { ...root.piece, length: offset };
	const second = {
		...root.piece,
		start: root.piece.start + root.piece.step * offset,
		length: root.piece.length - offset,
	};
	return [
		mergePieceTrees(root.left, createPieceNode(overlay, first)),
		mergePieceTrees(createPieceNode(overlay, second), root.right),
	];
}

// 最左/最右叶子节点；用于相邻 piece 的合并判断与尾部快速追加。
function leftmostPieceNode(node: PieceNode): PieceNode {
	while (node.left !== undefined) node = node.left;
	return node;
}

function rightmostPieceNode(node: PieceNode): PieceNode {
	while (node.right !== undefined) node = node.right;
	return node;
}

/**
 * 判断两段相邻 piece 能否合并成一段。
 *
 * 条件：同 kind；插入 piece 还必须同一 InsertSource（不同插入批次不能共用一个 refs 数组）；
 * 两段都长度为 1 时只要求源下标相差 1（可形成 step=±1 的两元素段）；
 * 其余情况要求 step 相同且左段末尾的下一个源下标正好是右段起点。
 */
function mergeablePieces(left: Piece, right: Piece): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "insert" && left.source !== (right as InsertPiece).source) return false;
	if (left.length === 1 && right.length === 1) return Math.abs(right.start - left.start) === 1;
	return left.step === right.step && left.start + left.step * left.length === right.start;
}

/**
 * 拼接两棵 treap，并合并接缝处可合并的 piece。
 *
 * 输入：overlay 与左右树；输出：新根；副作用：可能拆分最右/最左叶子并创建合并节点。
 * 递归处理：如果接缝不能合并，退化为普通 merge；否则各切掉接缝 piece，合成一段后重新加入并继续检查新接缝。
 */
function joinNormalized(
	overlay: ArrayOverlay,
	left: PieceNode | undefined,
	right: PieceNode | undefined,
): PieceNode | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	const leftPiece = rightmostPieceNode(left).piece;
	const rightPiece = leftmostPieceNode(right).piece;
	if (!mergeablePieces(leftPiece, rightPiece)) return mergePieceTrees(left, right);
	const [leftRest] = splitPieceTree(overlay, left, treeElements(left) - leftPiece.length);
	const [, rightRest] = splitPieceTree(overlay, right, rightPiece.length);
	// 两段长度都为 1 且源下标相邻时，合并后的 step 由方向决定（+1 或 -1）。
	const step = leftPiece.length === 1 ? ((rightPiece.start - leftPiece.start) as 1 | -1) : leftPiece.step;
	const combined: Piece =
		leftPiece.kind === "base"
			? { kind: "base", start: leftPiece.start, length: leftPiece.length + rightPiece.length, step }
			: {
					kind: "insert",
					source: leftPiece.source,
					start: leftPiece.start,
					length: leftPiece.length + rightPiece.length,
					step,
				};
	return joinNormalized(overlay, joinNormalized(overlay, leftRest, createPieceNode(overlay, combined)), rightRest);
}

// 中序遍历：得到逻辑顺序的 piece 数组。
function flattenPieceTree(node: PieceNode | undefined, output: Piece[]): void {
	if (node === undefined) return;
	flattenPieceTree(node.left, output);
	output.push(node.piece);
	flattenPieceTree(node.right, output);
}

// 缓存的 piece 顺序视图；任何结构变化都会把 overlay.pieces 清空，下次访问再重建。
function piecesOf(overlay: ArrayOverlay): readonly Piece[] {
	if (overlay.pieces === undefined) {
		overlay.pieces = [];
		flattenPieceTree(overlay.root, overlay.pieces);
	}
	return overlay.pieces;
}

// 从 piece 数组重建 treap；先调用 mergePieces 消掉可合并的相邻段。
function treeFromPieces(overlay: ArrayOverlay, pieces: Piece[]): PieceNode | undefined {
	mergePieces(pieces);
	let root: PieceNode | undefined;
	for (const piece of pieces) root = mergePieceTrees(root, createPieceNode(overlay, piece));
	return root;
}

// 整体替换 piece 树（reverse 使用），并清空所有与旧结构相关的缓存。
function replaceAllPieces(overlay: ArrayOverlay, pieces: Piece[]): void {
	overlay.root = treeFromPieces(overlay, pieces);
	overlay.pieces = undefined;
	overlay.baseLocations = undefined;
	overlay.insertLocations = undefined;
}

// 数组逻辑长度就是整棵 treap 的元素总数。
function arrayLength(overlay: ArrayOverlay): number {
	return treeElements(overlay.root);
}

/**
 * 定位逻辑下标所在的 piece。
 *
 * 输入：overlay、逻辑下标；输出：Piece；副作用：把该下标在 piece 内的偏移写入 overlay.locatedOffset。
 * 错误：越界抛 RangeError（调用方通常已先检查长度）。
 * 流程：迭代向下，比较左子树长度和 piece 覆盖区间；进入右子树时减去左侧全部元素。
 */
function locatePiece(overlay: ArrayOverlay, index: number): Piece {
	let node = overlay.root;
	while (node !== undefined) {
		const leftLength = treeElements(node.left);
		if (index < leftLength) node = node.left;
		else if (index >= leftLength + node.piece.length) {
			index -= leftLength + node.piece.length;
			node = node.right;
		} else {
			overlay.locatedOffset = index - leftLength;
			return node.piece;
		}
	}
	throw new RangeError("Array overlay index is out of range");
}

/**
 * 判断属性键是否是合法数组下标，返回数值；否则 undefined。
 *
 * 手写解析避免 `String(Number(key)) === key` 的分配；规则与 JS 数组下标一致：
 * 非空、最多 10 位、无前导零（"0" 除外）、值 < 2^32 - 1。
 */
function arrayIndex(property: PropertyKey): number | undefined {
	if (typeof property !== "string" || property.length === 0 || property.length > 10) return undefined;
	if (property === "0") return 0;
	const first = property.charCodeAt(0);
	if (first < 49 || first > 57) return undefined;
	let index = first - 48;
	for (let offset = 1; offset < property.length; offset++) {
		const digit = property.charCodeAt(offset) - 48;
		if (digit < 0 || digit > 9) return undefined;
		index = index * 10 + digit;
		if (index >= 4_294_967_295) return undefined;
	}
	return index;
}

/**
 * 按 piece 类型读取某个源下标的值。
 *
 * 输入：数组节点、piece、piece 内部源下标；输出：Stored。
 * base piece：优先读 baseOverrides，再读 base 数组；
 * insert piece：优先读该 InsertSource 的覆盖表，再读 source.refs。
 * 注意 sourceIndex 是“源”下标，不是逻辑下标；同一个源可能因重排出现在多个逻辑位置。
 */
function entryValueAt(node: OverlayNode, piece: Piece, sourceIndex: number): Stored {
	const overlay = arrayOverlay(node);
	if (piece.kind === "base") {
		const valueIndex = overlay.baseOverrides?.get(sourceIndex);
		return valueIndex === undefined
			? (nodeBase(node) as JsonValue[])[sourceIndex]!
			: storedValue(node.context, valueIndex);
	}
	const overrides = overlay.insertOverrides?.get(piece.source);
	const reference = overrides?.has(sourceIndex) ? overrides.get(sourceIndex)! : piece.source.refs[sourceIndex]!;
	return storedValue(node.context, reference);
}

// 该源下标是否被显式覆盖；用于区分“placement 值”和“原值”，影响 emit 的保守程度。
function hasEntryOverrideAt(overlay: ArrayOverlay, piece: Piece, sourceIndex: number): boolean {
	return piece.kind === "base"
		? (overlay.baseOverrides?.has(sourceIndex) ?? false)
		: (overlay.insertOverrides?.get(piece.source)?.has(sourceIndex) ?? false);
}

// 把最右 piece 长度增加 amount 并沿途更新 elements；仅用于尾部快速追加。
function extendRightmostPiece(node: PieceNode, amount: number): void {
	if (node.right !== undefined) extendRightmostPiece(node.right, amount);
	else node.piece.length += amount;
	updatePieceNode(node);
}

// 结构变化后统一失效：pieces 顺序、两套源下标位置缓存、以及预计算的 ArrayPlan。
function invalidatePieceCaches(overlay: ArrayOverlay): void {
	overlay.pieces = undefined;
	overlay.baseLocations = undefined;
	overlay.insertLocations = undefined;
	overlay.plan = undefined;
}

/**
 * 用 inserted 替换逻辑区间 [index, index+remove)。
 *
 * 输入：数组节点、起始逻辑下标、删除数量、插入 piece；输出：无。
 * 副作用：修改 treap、清缓存、标记 structural、generation+1、markDirty。
 * 快速路径：在末尾追加且尾部是“还没被覆盖的插入源末尾”时，把新 refs 直接接进旧 source，
 * 避免 split/merge；否则标准 split -> 拼接 -> joinNormalized。
 * 所有删除/插入最终都落在这里，数组的结构性 op 从 generation 变化推导。
 */
function replacePieceRange(node: OverlayNode, index: number, remove: number, inserted: Piece[]): void {
	if (remove === 0 && inserted.length === 0) return;
	const overlay = arrayOverlay(node);
	if (remove === 0 && index === arrayLength(overlay) && inserted.length === 1 && overlay.root !== undefined) {
		const addition = inserted[0]!;
		const tail = rightmostPieceNode(overlay.root).piece;
		if (
			addition.kind === "insert" &&
			tail.kind === "insert" &&
			tail.step === 1 &&
			tail.start + tail.length === tail.source.refs.length
		) {
			// 尾部 piece 仍覆盖其 source 的连续末尾：直接扩展同一个 refs，push 保持 O(1) 摊还。
			for (let offset = 0; offset < addition.length; offset++) {
				tail.source.refs.push(addition.source.refs[addition.start + offset]!);
			}
			extendRightmostPiece(overlay.root, addition.length);
			invalidatePieceCaches(overlay);
			overlay.structural = true;
			overlay.generation += 1;
			markDirty(node);
			return;
		}
	}
	const [left, rest] = splitPieceTree(overlay, overlay.root, index);
	const [, right] = splitPieceTree(overlay, rest, remove);
	const middle = treeFromPieces(overlay, inserted);
	overlay.root = joinNormalized(overlay, joinNormalized(overlay, left, middle), right);
	invalidatePieceCaches(overlay);
	overlay.structural = true;
	overlay.generation += 1;
	markDirty(node);
}

/**
 * 就地合并 piece 数组中可合并的相邻段（treeFromPieces 的前置步骤）。
 *
 * 输入：Piece[]；输出：无；副作用：修改 left 的 step/length 并 splice 掉 right。
 * 只处理“同源且源下标连续”的情况；跨 source 不合并。循环下标在合并时不前进，以便继续检查新邻居。
 */
function mergePieces(pieces: Piece[]): void {
	for (let index = 1; index < pieces.length; ) {
		const left = pieces[index - 1]!;
		const right = pieces[index]!;
		const sameSource =
			left.kind === right.kind && (left.kind === "base" || left.source === (right as InsertPiece).source);
		if (sameSource && left.length === 1 && right.length === 1 && Math.abs(right.start - left.start) === 1) {
			left.step = (right.start - left.start) as 1 | -1;
			left.length = 2;
			pieces.splice(index, 1);
		} else if (sameSource && left.step === right.step && left.start + left.step * left.length === right.start) {
			left.length += right.length;
			pieces.splice(index, 1);
		} else index += 1;
	}
}

/**
 * 把若干 Stored 值包装成一个新的 insert piece。
 *
 * 输入：节点、值数组、起始偏移（默认 0）；输出：空数组或单个 step=1 的 InsertPiece。
 * 副作用：为每个值调用 storeValue，把容器放进 context.stored。
 */
function insertPiece(node: OverlayNode, items: Stored[], start = 0): InsertPiece[] {
	if (items.length === start) return [];
	const refs: StoredRef[] = [];
	for (let index = start; index < items.length; index++) refs.push(storeValue(node.context, items[index]!));
	return [{ kind: "insert", source: { refs }, start: 0, length: refs.length, step: 1 }];
}

/**
 * 把外部传入的数组方法参数（push/unshift/splice 的 items）复制成 placement 值并包装成 insert piece。
 *
 * 输入：节点、参数数组、起始偏移；输出：空数组或一个 insert piece。
 * 副作用：clonePlacement 会验证/复制参数，storeValue 把容器放进 stored；失败时回滚 stored 长度。
 * 与 insertPiece 的区别：这里不信任调用方的值，必须复制；`values` 原地改写为 StoredRef 以复用数组。
 */
function insertPlacementPiece(node: OverlayNode, values: unknown[], start = 0): InsertPiece[] {
	if (values.length === start) return [];
	const storedLength = node.context.stored?.length ?? 0;
	try {
		for (let index = start; index < values.length; index++)
			values[index] = storeValue(node.context, clonePlacement(values[index]));
	} catch (error) {
		// 一半参数已入 stored，若复制/校验失败就回滚，避免泄漏半成品引用。
		if (node.context.stored !== undefined) node.context.stored.length = storedLength;
		throw error;
	}
	return [
		{
			kind: "insert",
			source: { refs: values as StoredRef[] },
			start,
			length: values.length - start,
			step: 1,
		},
	];
}

/**
 * 写入数组某个逻辑下标（index === length 视为追加）。
 *
 * 输入：节点、下标、Stored 值；输出：无；副作用：修改覆盖表或追加 piece，然后 markDirty。
 * 已经是同一 primitive 的写入直接忽略；写回 base 原值时会删除覆盖项（保持最小覆盖层）。
 * 容器值一律视为覆盖（不能按引用比较），因为后续修改必须经过写时复制。
 */
function setArrayIndex(node: OverlayNode, index: number, stored: Stored): void {
	const overlay = arrayOverlay(node);
	const length = arrayLength(overlay);
	if (index === length) {
		replacePieceRange(node, length, 0, insertPiece(node, [stored]));
		return;
	}
	const piece = locatePiece(overlay, index);
	const sourceIndex = piece.start + piece.step * overlay.locatedOffset;
	const current = entryValueAt(node, piece, sourceIndex);
	if (!isContainer(stored) && current === stored) return;
	if (piece.kind === "base") {
		const existingIndex = overlay.baseOverrides?.get(sourceIndex);
		if (!isContainer(stored) && stored === (nodeBase(node) as JsonValue[])[sourceIndex]) {
			// 写回 base 原值：覆盖项已无意义，删除并释放存储槽。
			if (existingIndex !== undefined) releaseStoredValue(node.context, existingIndex);
			overlay.baseOverrides?.delete(sourceIndex);
		} else if (existingIndex === undefined) {
			baseOverridesForWrite(overlay).set(sourceIndex, storeValue(node.context, stored));
		} else overlay.baseOverrides!.set(sourceIndex, replaceStoredValue(node.context, existingIndex, stored));
	} else {
		let overrides = overlay.insertOverrides?.get(piece.source);
		const existingIndex = overrides?.get(sourceIndex);
		if (!isContainer(stored) && stored === storedValue(node.context, piece.source.refs[sourceIndex]!)) {
			// 写回插入源原值：删除该 source 的覆盖项；空 Map 一并移除。
			if (existingIndex !== undefined) releaseStoredValue(node.context, existingIndex);
			overrides?.delete(sourceIndex);
			if (overrides?.size === 0) overlay.insertOverrides?.delete(piece.source);
		} else {
			if (overrides === undefined) {
				overrides = new Map();
				insertOverridesForWrite(overlay).set(piece.source, overrides);
			}
			if (existingIndex === undefined) overrides.set(sourceIndex, storeValue(node.context, stored));
			else overrides.set(sourceIndex, replaceStoredValue(node.context, existingIndex, stored));
		}
	}
	markDirty(node);
}

/**
 * 设置数组 length：缩小时删除尾部，扩大时用 null 填充（与 JS 数组的空洞不同，overlay 保持稠密）。
 *
 * 输入：节点与新长度；输出：无；副作用：修改 piece 树并 markDirty。
 * 新元素用 null 而不是 undefined，因为 overlay 只表达严格 JSON，null 是合法 JSON 值。
 */
function setArrayLength(node: OverlayNode, next: number): void {
	const current = arrayLength(arrayOverlay(node));
	if (next === current) return;
	if (next < current) replacePieceRange(node, next, current - next, []);
	else
		replacePieceRange(
			node,
			current,
			0,
			insertPiece(
				node,
				Array.from({ length: next - current }, () => null),
			),
		);
}

// 校验 length 赋值：必须是 [0, 2^32) 内的整数；否则抛 RangeError（与原生数组一致）。
function toArrayLength(value: unknown): number {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 0 || number >= 4_294_967_296) throw new RangeError("Invalid array length");
	return number;
}

// ToIntegerOrInfinity 的简化实现：NaN/±0 -> 0，有限数截断，Infinity 保留。
function toIntegerOrInfinity(value: unknown): number {
	const number = Number(value);
	if (Number.isNaN(number) || number === 0) return 0;
	return Number.isFinite(number) ? Math.trunc(number) : number;
}

// 把相对下标 clamp 到 [0,length]：负数从末尾算，-Infinity 变 0，正数不超过 length。
function clampIndex(value: number, length: number): number {
	if (value === Number.NEGATIVE_INFINITY) return 0;
	if (value < 0) return Math.max(length + value, 0);
	return Math.min(value, length);
}

/**
 * 数组 mutator 的 receiver 解析。
 *
 * 输入：方法调用时的 this；输出：数组节点或 undefined。
 * undefined 表示 this 不是 overlay（例如从 Array.prototype 借给普通数组），此时调用方回退到原生方法。
 * 是 overlay 数组但已 settle -> 抛 TypeError；是 overlay 对象而不是数组 -> 抛不兼容 receiver。
 */
function mutatorNode(receiver: unknown): OverlayNode | undefined {
	if (!isContainer(receiver)) return undefined;
	const node = Reflect.get(receiver, NODE) as OverlayNode | undefined;
	if (node === undefined) return undefined;
	if (!Array.isArray(nodeBase(node))) throw new TypeError("Array mutator called on incompatible receiver");
	assertWritable(node.context);
	return node;
}

/**
 * 草稿数组的方法表：覆盖会修改数组的原生方法，其余方法（map/slice/indexOf 等）仍走 Array.prototype。
 *
 * 每个方法遵循同一模式：
 * 1. `mutatorNode(this)`：若不是 overlay 就退回原生实现（保持借用语义）；
 * 2. 用逻辑长度和下标工具把参数规范化为 [start,end)；
 * 3. 通过 replacePieceRange / 覆盖表修改惰性结构；
 * 4. 返回与原生方法一致的返回值（新长度、被删元素或 proxy 本身）。
 * 不修改调用方传入的对象：items 一律经 insertPlacementPiece/clonePlacement 复制。
 */
const arrayMutators = {
	// push：在尾部追加，返回新长度；items 全部复制。
	push(this: unknown, ...items: unknown[]): number {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.push, this, items) as number;
		const length = arrayLength(arrayOverlay(node));
		replacePieceRange(node, length, 0, insertPlacementPiece(node, items));
		return length + items.length;
	},
	// pop：先读取末元素（容器会包成 proxy），再删除最后一段；空数组返回 undefined。
	pop(this: unknown): unknown {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.pop, this, []);
		const length = arrayLength(arrayOverlay(node));
		if (length === 0) return undefined;
		const value = getArrayIndex(node, length - 1);
		replacePieceRange(node, length - 1, 1, []);
		return value;
	},
	// shift：与 pop 对称，删除首个元素并返回它。
	shift(this: unknown): unknown {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.shift, this, []);
		const length = arrayLength(arrayOverlay(node));
		if (length === 0) return undefined;
		const value = getArrayIndex(node, 0);
		replacePieceRange(node, 0, 1, []);
		return value;
	},
	// unshift：在头部插入；返回新长度。
	unshift(this: unknown, ...items: unknown[]): number {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.unshift, this, items) as number;
		replacePieceRange(node, 0, 0, insertPlacementPiece(node, items));
		return arrayLength(arrayOverlay(node));
	},
	/**
	 * splice：参数语义与原生一致。
	 * 无参数：不删除、不插入；只有 start：删到末尾；否则 remove 被 clamp 到 [0,length-start]。
	 * 先取出被删元素（保证返回值是删除前的值），再替换区间。
	 */
	splice(this: unknown, ...args: unknown[]): unknown[] {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.splice, this, args) as unknown[];
		const length = arrayLength(arrayOverlay(node));
		const start = args.length === 0 ? 0 : clampIndex(toIntegerOrInfinity(args[0]), length);
		const remove =
			args.length === 0
				? 0
				: args.length === 1
					? length - start
					: Math.min(Math.max(toIntegerOrInfinity(args[1]), 0), length - start);
		const removed = Array.from({ length: remove }, (_, offset) => getArrayIndex(node, start + offset));
		const itemStart = Math.min(2, args.length);
		const itemCount = Math.max(args.length - 2, 0);
		replacePieceRange(node, start, remove, insertPlacementPiece(node, args, itemStart));
		setArrayLength(node, length - remove + itemCount);
		return removed;
	},
	/**
	 * reverse：不移动元素，只反转 piece 顺序并翻转每段的遍历方向。
	 * 对每段：新起点 = 原起点 + step*(length-1)，step 取反（+1 <-> -1）；
	 * 这样逻辑顺序反转，而每个元素仍指向同一个源下标。
	 * 长度 0/1 时无操作；返回 proxy 本身（与原生 reverse 返回同一数组对象一致）。
	 */
	reverse(this: unknown): unknown {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.reverse, this, []);
		const overlay = arrayOverlay(node);
		if (arrayLength(overlay) < 2) return node.proxy;
		const pieces = [...piecesOf(overlay)].reverse();
		for (const piece of pieces) {
			piece.start += piece.step * (piece.length - 1);
			piece.step = piece.step === 1 ? -1 : 1;
		}
		replaceAllPieces(overlay, pieces);
		overlay.structural = true;
		overlay.generation += 1;
		overlay.plan = undefined;
		markDirty(node);
		return node.proxy;
	},
	/**
	 * sort：取出所有逻辑元素 -> 排序 -> 用源标记重建 piece 序列。
	 *
	 * 排序键不直接存值，而是“源标记”：
	 * - base 元素用非负的 base 下标；
	 * - 插入元素用负数 token（-(n+1)），指向 insertedSources/insertedIndices 中的槽。
	 * 这样 comparator 看到的是值，但排序结果仍能映射回原始来源，避免复制整个数组。
	 * 细节：
	 * - comparator 抛错或调用期间修改草稿会让 generation 变化；此时仍按已取得的顺序继续，
	 *   最后通过 deduplicateArrayEntries 把重复源转成独立插入项，保持 JS sort 的宽松语义；
	 * - 若排序后前缀与当前 piece 顺序完全一致，则不做任何结构修改；
	 * - 返回 proxy 本身。
	 */
	sort(this: unknown, comparator?: unknown): unknown {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.sort, this, [comparator]);
		if (comparator !== undefined && typeof comparator !== "function")
			throw new TypeError("Comparator must be a function");
		const overlay = arrayOverlay(node);
		const insertedSources: InsertSource[] = [];
		const insertedIndices: number[] = [];
		const insertedValues: unknown[] = [];
		const baseValues: unknown[] = new Array((nodeBase(node) as JsonValue[]).length);
		const order: number[] = [];
		for (const piece of piecesOf(overlay)) {
			for (let offset = 0; offset < piece.length; offset++) {
				const sourceIndex = piece.start + piece.step * offset;
				if (piece.kind === "base") {
					order.push(sourceIndex);
					baseValues[sourceIndex] = publicSortValue(node, sourceIndex, insertedSources, insertedIndices);
				} else {
					insertedSources.push(piece.source);
					insertedIndices.push(sourceIndex);
					const token = -insertedSources.length;
					order.push(token);
					insertedValues.push(publicSortValue(node, token, insertedSources, insertedIndices));
				}
			}
		}
		// 快照当前覆盖值：comparator 可能修改数组，排序后要按原值恢复覆盖项。
		const baseSnapshot = new Map<number, Stored>();
		for (const [index, valueIndex] of overlay.baseOverrides ?? [])
			baseSnapshot.set(index, storedValue(node.context, valueIndex));
		const insertSnapshots = new Map<InsertSource, Map<number, Stored>>();
		for (const [source, overrides] of overlay.insertOverrides ?? []) {
			const snapshot = new Map<number, Stored>();
			for (const [index, valueIndex] of overrides) snapshot.set(index, storedValue(node.context, valueIndex));
			insertSnapshots.set(source, snapshot);
		}
		const generation = overlay.generation;
		order.sort((left, right) => {
			const leftValue = left < 0 ? insertedValues[-left - 1] : baseValues[left];
			const rightValue = right < 0 ? insertedValues[-right - 1] : baseValues[right];
			if (typeof comparator === "function") return Number(comparator(leftValue, rightValue));
			// 原生 sort 把 undefined 排到最后、其余按字符串比较；overlay 不允许 undefined，
			// 因此这里只实现字符串序。
			const a = String(leftValue);
			const b = String(rightValue);
			return a < b ? -1 : a > b ? 1 : 0;
		});
		// comparator 可能增删/覆盖元素：按“源下标”把快照里的覆盖值重新挂回去。
		if (
			baseSnapshot.size > 0 ||
			insertSnapshots.size > 0 ||
			(overlay.baseOverrides?.size ?? 0) > 0 ||
			(overlay.insertOverrides?.size ?? 0) > 0
		) {
			for (const token of order) {
				restoreSortOverride(node, token, insertedSources, insertedIndices, baseSnapshot, insertSnapshots);
			}
		}
		const comparatorWasStructural = overlay.generation !== generation;
		const currentLength = arrayLength(overlay);
		const samePrefix =
			currentLength >= order.length &&
			order.every((token, index) => sameSortTokenAt(overlay, index, token, insertedSources, insertedIndices));
		if (!samePrefix) {
			replacePieceRange(
				node,
				0,
				Math.min(order.length, currentLength),
				piecesFromSortOrder(order, insertedSources, insertedIndices),
			);
		}
		// comparator 结构性地改过数组：排序后可能出现同一源下标的多份拷贝，转成独立插入项。
		if (comparatorWasStructural) deduplicateArrayEntries(node);
		return node.proxy;
	},
	// fill：用同一个值的独立副本填充 [start,end)；每个位置都 clonePlacement，避免共享容器。
	fill(this: unknown, supplied: unknown, startArg?: unknown, endArg?: unknown): unknown {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.fill, this, [supplied, startArg, endArg]);
		const length = arrayLength(arrayOverlay(node));
		const start = startArg === undefined ? 0 : clampIndex(toIntegerOrInfinity(startArg), length);
		const end = endArg === undefined ? length : clampIndex(toIntegerOrInfinity(endArg), length);
		if (end <= start) return node.proxy;
		const items = Array.from({ length: end - start }, () => clonePlacement(supplied));
		replacePieceRange(node, start, end - start, insertPiece(node, items));
		return node.proxy;
	},
	// copyWithin：复制区间 [start,end) 到 target，重叠时先全部读取再写回（副本数组）。
	copyWithin(this: unknown, targetArg: unknown, startArg: unknown, endArg?: unknown): unknown {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.copyWithin, this, [targetArg, startArg, endArg]);
		const length = arrayLength(arrayOverlay(node));
		const target = clampIndex(toIntegerOrInfinity(targetArg), length);
		const start = clampIndex(toIntegerOrInfinity(startArg), length);
		const end = endArg === undefined ? length : clampIndex(toIntegerOrInfinity(endArg), length);
		const count = Math.min(Math.max(end - start, 0), length - target);
		const values = Array.from({ length: count }, (_, offset) => clonePlacement(getArrayIndex(node, start + offset)));
		replacePieceRange(node, target, count, insertPiece(node, values));
		return node.proxy;
	},
};

// 负数 token 的第 n 个槽对应 insertedSources[n]；非负 token 表示 base 下标，没有 source。
function sortTokenSource(token: number, sources: readonly InsertSource[]): InsertSource | undefined {
	return token < 0 ? sources[-token - 1] : undefined;
}

// 同理取插入源内部下标；base token 本身就是下标。
function sortTokenIndex(token: number, indices: readonly number[]): number {
	return token < 0 ? indices[-token - 1]! : token;
}

/**
 * 为 sort 取一个元素的“公开值”：若元素是容器，返回子节点 proxy，让 comparator 看到可读的草稿视图。
 *
 * 输入：数组节点、源 token、token 槽表；输出：primitive 或 proxy。
 * 覆盖值优先于基础值；parentKind/parentSource 决定 comparator 若修改子对象时如何写回。
 */
function publicSortValue(
	node: OverlayNode,
	token: number,
	sources: readonly InsertSource[],
	indices: readonly number[],
): unknown {
	const overlay = arrayOverlay(node);
	const source = sortTokenSource(token, sources);
	const sourceIndex = sortTokenIndex(token, indices);
	const overrideIndex =
		source === undefined
			? overlay.baseOverrides?.get(sourceIndex)
			: overlay.insertOverrides?.get(source)?.get(sourceIndex);
	const value =
		overrideIndex !== undefined
			? storedValue(node.context, overrideIndex)
			: source === undefined
				? (nodeBase(node) as JsonValue[])[sourceIndex]!
				: storedValue(node.context, source.refs[sourceIndex]!);
	if (!isContainer(value)) return value;
	return createNode(
		node.context,
		value,
		node,
		source === undefined ? 1 : 2,
		sourceIndex,
		source,
		source !== undefined || (overlay.baseOverrides?.has(sourceIndex) ?? false),
	).proxy;
}

/**
 * 把排序前快照中的覆盖值恢复到对应源下标。
 *
 * 输入：token 及快照；输出：无；副作用：更新 baseOverrides/insertOverrides，必要时释放/创建存储槽。
 * 排序期间 comparator 可能重写同一源下标，因此这里以快照为准覆盖回去；快照没有的覆盖项要删除。
 */
function restoreSortOverride(
	node: OverlayNode,
	token: number,
	sources: readonly InsertSource[],
	indices: readonly number[],
	baseSnapshot: ReadonlyMap<number, Stored>,
	insertSnapshots: ReadonlyMap<InsertSource, ReadonlyMap<number, Stored>>,
): void {
	const overlay = arrayOverlay(node);
	const source = sortTokenSource(token, sources);
	const sourceIndex = sortTokenIndex(token, indices);
	if (source === undefined) {
		const existingIndex = overlay.baseOverrides?.get(sourceIndex);
		const snapshotValue = baseSnapshot.get(sourceIndex);
		if (snapshotValue !== undefined) {
			if (existingIndex === undefined)
				baseOverridesForWrite(overlay).set(sourceIndex, storeValue(node.context, snapshotValue));
			else overlay.baseOverrides!.set(sourceIndex, replaceStoredValue(node.context, existingIndex, snapshotValue));
		} else {
			if (existingIndex !== undefined) releaseStoredValue(node.context, existingIndex);
			overlay.baseOverrides?.delete(sourceIndex);
		}
		return;
	}
	let overrides = overlay.insertOverrides?.get(source);
	const existingIndex = overrides?.get(sourceIndex);
	const snapshotValue = insertSnapshots.get(source)?.get(sourceIndex);
	if (snapshotValue !== undefined) {
		if (overrides === undefined) {
			overrides = new Map();
			insertOverridesForWrite(overlay).set(source, overrides);
		}
		if (existingIndex === undefined) overrides.set(sourceIndex, storeValue(node.context, snapshotValue));
		else overrides.set(sourceIndex, replaceStoredValue(node.context, existingIndex, snapshotValue));
	} else {
		if (existingIndex !== undefined) releaseStoredValue(node.context, existingIndex);
		overrides?.delete(sourceIndex);
		if (overrides?.size === 0) overlay.insertOverrides?.delete(source);
	}
}

// 检查当前第 logicalIndex 个元素是否仍是排序 token 描述的那个源元素（用于判断是否要重建 piece）。
function sameSortTokenAt(
	overlay: ArrayOverlay,
	logicalIndex: number,
	token: number,
	sources: readonly InsertSource[],
	indices: readonly number[],
): boolean {
	const piece = locatePiece(overlay, logicalIndex);
	const sourceIndex = piece.start + piece.step * overlay.locatedOffset;
	const tokenSource = sortTokenSource(token, sources);
	return (
		sourceIndex === sortTokenIndex(token, indices) &&
		((piece.kind === "base" && tokenSource === undefined) ||
			(piece.kind === "insert" && piece.source === tokenSource))
	);
}

/**
 * sort 的 comparator 修改过数组时，把重复出现的源元素“物化”成独立插入项。
 *
 * 输入：数组节点；输出：无；副作用：若发现重复，重建整个 piece 树。
 * 为什么需要：piece 用“源下标 + 步长”表示元素，如果同一源出现两次（comparator 复制了元素），
 * 两处仍会共享同一源值，后续写入会互相影响。重复项复制成新的 placement 值，保证独立身份。
 * 第一次出现的元素保留源引用；只有重复项走 insertPiece + clonePlacementStored。
 */
function deduplicateArrayEntries(node: OverlayNode): void {
	const overlay = arrayOverlay(node);
	const seenBase = new Set<number>();
	const seenInsert = new Map<InsertSource, Set<number>>();
	const next: Piece[] = [];
	let duplicated = false;
	for (const piece of piecesOf(overlay)) {
		for (let offset = 0; offset < piece.length; offset++) {
			const sourceIndex = piece.start + piece.step * offset;
			let seen: boolean;
			if (piece.kind === "base") {
				seen = seenBase.has(sourceIndex);
				seenBase.add(sourceIndex);
			} else {
				let indices = seenInsert.get(piece.source);
				if (indices === undefined) {
					indices = new Set();
					seenInsert.set(piece.source, indices);
				}
				seen = indices.has(sourceIndex);
				indices.add(sourceIndex);
			}
			if (seen) {
				duplicated = true;
				appendMergedPiece(
					next,
					insertPiece(node, [clonePlacementStored(entryValueAt(node, piece, sourceIndex), node.context)])[0]!,
				);
			} else appendMergedPiece(next, singletonPiece(piece, sourceIndex));
		}
	}
	if (!duplicated) return;
	replaceAllPieces(overlay, next);
	overlay.structural = true;
	overlay.generation += 1;
	overlay.plan = undefined;
	markDirty(node);
}

// 把排序后的 token 序列转成尽量少的 piece：相邻且源下标连续的 token 合并成一段。
function piecesFromSortOrder(
	order: readonly number[],
	sources: readonly InsertSource[],
	indices: readonly number[],
): Piece[] {
	const pieces: Piece[] = [];
	for (const token of order) {
		const source = token < 0 ? sources[-token - 1] : undefined;
		const sourceIndex = token < 0 ? indices[-token - 1]! : token;
		const previous = pieces.at(-1);
		const sameSource =
			previous !== undefined &&
			((source === undefined && previous.kind === "base") ||
				(source !== undefined && previous.kind === "insert" && previous.source === source));
		if (previous !== undefined && sameSource) {
			if (previous.length === 1) {
				const step = sourceIndex - previous.start;
				if (step === 1 || step === -1) {
					previous.step = step;
					previous.length = 2;
					continue;
				}
			} else if (previous.start + previous.step * previous.length === sourceIndex) {
				previous.length += 1;
				continue;
			}
		}
		pieces.push(
			source === undefined
				? { kind: "base", start: sourceIndex, length: 1, step: 1 }
				: { kind: "insert", source, start: sourceIndex, length: 1, step: 1 },
		);
	}
	return pieces;
}

/**
 * 向 piece 数组追加一项，并尽可能与末项合并。
 *
 * 输入：目标数组与新 piece；输出：无；副作用：可能修改末项 step/length，否则 push。
 * 合并条件与 mergePieces 相同：同源、长度 1 时下标相邻，或长段时源下标连续。
 */
function appendMergedPiece(pieces: Piece[], piece: Piece): void {
	const previous = pieces.at(-1);
	const sameSource =
		previous !== undefined &&
		previous.kind === piece.kind &&
		(previous.kind === "base" || previous.source === (piece as InsertPiece).source);
	if (previous !== undefined && sameSource && previous.length === 1 && piece.length === 1) {
		const step = piece.start - previous.start;
		if (step === 1 || step === -1) {
			previous.step = step;
			previous.length = 2;
			return;
		}
	}
	if (
		previous !== undefined &&
		sameSource &&
		previous.step === piece.step &&
		previous.start + previous.step * previous.length === piece.start
	) {
		previous.length += piece.length;
	} else pieces.push(piece);
}

// 把 piece 中的单个源下标提取成独立 piece（长度 1、step 1）；供去重和重建使用。
function singletonPiece(piece: Piece, sourceIndex: number): Piece {
	return piece.kind === "base"
		? { kind: "base", start: sourceIndex, length: 1, step: 1 }
		: { kind: "insert", source: piece.source, start: sourceIndex, length: 1, step: 1 };
}

/**
 * 把外部写入的值转换成草稿内部持有、与调用方隔离的值。
 *
 * 输入：任意 JS 值；输出：Stored；副作用：可能创建节点/复制容器。
 * - 传进来的是草稿 proxy：调用 clonePlacementNode 复制其当前逻辑内容（不是复制底层 base）；
 * - 否则调用 copyJson：校验严格 JSON 并深拷贝，拒绝函数/symbol/undefined/非普通对象等。
 * 错误：非法 JSON 值由 copyJson 抛出，保持 prepare 失败的原子性。
 */
function clonePlacement(value: unknown): Stored {
	const proxyNode = isContainer(value) ? (Reflect.get(value, NODE) as OverlayNode | undefined) : undefined;
	return proxyNode === undefined ? copyJson(value) : clonePlacementNode(proxyNode);
}

/**
 * 深拷贝一个已提交节点的当前逻辑值（用于 simpleObjectMaterialization 快速路径）。
 *
 * 输入：节点；输出：容器；副作用：读取节点/覆盖层，不修改它们。
 * 数组按 piece 顺序逐项 cloneStored；对象用 ownKeys 的顺序 defineData，保留 null 原型。
 */
function cloneNode(node: OverlayNode): Container {
	assertReadable(node.context);
	if (Array.isArray(nodeBase(node))) {
		const overlay = arrayOverlay(node);
		const result: JsonValue[] = [];
		for (const piece of piecesOf(overlay)) {
			for (let offset = 0; offset < piece.length; offset++) {
				const sourceIndex = piece.start + piece.step * offset;
				result.push(cloneStored(entryValueAt(node, piece, sourceIndex), node.context));
			}
		}
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(nodeBase(node))) as Record<string, JsonValue>;
	for (const key of ownKeys(node) as string[])
		defineData(result, key, cloneStored(objectValue(node, key), node.context));
	return result;
}

/**
 * cloneNode 的值级版本：primitive 原样；容器若未被修改则按引用共享，只有 dirty/subtreeDirty 的才递归复制。
 *
 * 输入：Stored 值、上下文；输出：新值或共享引用；副作用：读 rawNodes。
 * 这是写时复制的收益点：未修改的子树不复制，但前提是它们没有别名。
 */
function cloneStored(value: Stored, context: OverlayContext): Stored {
	if (!isContainer(value)) return value;
	const node = context.rawNodes?.get(value);
	return node === undefined || (!node.dirty && !node.subtreeDirty) ? value : cloneNode(node);
}

/**
 * 复制一个草稿 proxy 的当前逻辑内容，作为 placement 值存进草稿。
 *
 * 与 cloneNode 类似，但叶值使用 clonePlacementStored：普通值走 copyJson（严格校验+复制），
 * 已经属于本上下文的容器递归复制，保证放置后的值不再与外部/原位置共享可变状态。
 */
function clonePlacementNode(node: OverlayNode): Container {
	assertReadable(node.context);
	if (Array.isArray(nodeBase(node))) {
		const overlay = arrayOverlay(node);
		const result: JsonValue[] = [];
		for (const piece of piecesOf(overlay)) {
			for (let offset = 0; offset < piece.length; offset++) {
				const sourceIndex = piece.start + piece.step * offset;
				result.push(clonePlacementStored(entryValueAt(node, piece, sourceIndex), node.context));
			}
		}
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(nodeBase(node))) as Record<string, JsonValue>;
	for (const key of ownKeys(node) as string[])
		defineData(result, key, clonePlacementStored(objectValue(node, key), node.context));
	return result;
}

// clonePlacementNode 的值级版本：primitive 走 copyJson；容器若属于本上下文则递归复制，否则 copyJson 深拷贝。
function clonePlacementStored(value: Stored, context: OverlayContext): Stored {
	if (!isContainer(value)) return copyJson(value);
	const node = context.rawNodes?.get(value);
	return node === undefined ? copyJson(value) : clonePlacementNode(node);
}

// 用共享 DATA_DESCRIPTOR 定义数据属性，避免 `__proto__` 触发原型 setter；写完清空 value 防止长引用。
function defineData(target: object, key: PropertyKey, value: JsonValue): void {
	DATA_DESCRIPTOR.value = value;
	Object.defineProperty(target, key, DATA_DESCRIPTOR);
	DATA_DESCRIPTOR.value = undefined;
}

/**
 * 把草稿的 dirty 节点转换成发送用的 op 批次。
 *
 * 输入：prepared 状态、已发射 ops 的上下文；输出：Op[]；副作用：可能设置 simpleObjectMaterialization，
 *       清空模块级 locatedDenseArray 临时缓存；极端情况下返回 single root replace。
 * 流程：
 * 1. 先尝试纯对象快速路径 emitSimpleObjectOperations；成功就直接返回。
 * 2. 扫描 dirty 节点，记录可折叠成数组 `p` 的密集候选，以及被“保留键/placement”强制的折叠点。
 * 3. 为每个节点解析路径；按路径深度分桶，从浅到深发射，保证父节点先写。
 * 4. 有祖先已折叠或 placement 祖先的节点跳过（父写入已经覆盖它）。
 * 5. op 数量超过 MAX_DELTA_OPERATIONS 时放弃增量，返回 [["r", 克隆整个根]]。
 * 跳过无法解析路径的节点：说明父节点不再指向同一 base（例如已被删除/替换）。
 */
function emitOperations(context: OverlayContext): Op[] {
	const simple = emitSimpleObjectOperations(context);
	if (simple !== undefined) return simple;
	const operations: Op[] = [];
	const forcedFolds = new Map<OverlayNode, Path>();
	const emissionPaths = new Map<OverlayNode, Path>();
	const denseIndices = new Map<OverlayNode, DenseCandidates>();
	for (const node of context.dirty) {
		// 被替换/移动的数组子元素可以合并成一次密集 p，而不是逐元素 s/a。
		recordDenseArrayPosition(node, denseIndices);
		if (Array.isArray(nodeBase(node))) {
			const overlay = arrayOverlay(node);
			if (!overlay.structural && (overlay.baseOverrides?.size ?? 0) > 0) {
				let candidates = denseIndices.get(node);
				if (candidates === undefined) {
					candidates = { indices: [], bits: undefined, length: (nodeBase(node) as JsonValue[]).length };
					denseIndices.set(node, candidates);
				}
				for (const index of overlay.baseOverrides!.keys()) addDenseCandidate(candidates, index);
			}
		}
	}
	// 只为路径安全且确有密集段的数组建立 region 表。
	const denseRegions = new Map<OverlayNode, DenseRegion[]>();
	for (const [array, candidates] of denseIndices) {
		const path = resolvePath(array);
		if (path === undefined || path.some((segment) => typeof segment === "string" && RESERVED_SEGMENTS.has(segment))) {
			continue;
		}
		const regions = buildDenseRegions(candidates);
		if (regions.length > 0) denseRegions.set(array, regions);
	}
	for (const node of context.dirty) {
		const path = resolvePath(node);
		if (path === undefined) continue;
		// 祖先数组会用密集 p 整段替换，子节点的单独 op 变得多余且可能冲突。
		if (hasCoveringDenseRegion(node, path, denseRegions)) continue;
		emissionPaths.set(node, path);
		if (!Array.isArray(nodeBase(node)) && hasReservedMutation(node)) forcedFolds.set(node, path);
		// 路径中出现 __proto__/constructor/prototype 时不能逐层写：折叠到保留键之前的祖先，整值替换。
		const reservedAt = path.findIndex((segment) => typeof segment === "string" && RESERVED_SEGMENTS.has(segment));
		if (reservedAt >= 0) {
			let ancestor = node;
			for (let depth = path.length; depth > reservedAt; depth--) ancestor = nodeParent(ancestor)!;
			forcedFolds.set(ancestor, path.slice(0, reservedAt));
		}
	}
	for (const [node, path] of forcedFolds) emissionPaths.set(node, path);
	for (const node of denseRegions.keys()) {
		const path = resolvePath(node);
		if (path !== undefined && !hasCoveringDenseRegion(node, path, denseRegions)) emissionPaths.set(node, path);
	}
	// 按路径深度分桶：父节点先发射，子节点可依赖新的父值。
	let maxDepth = 0;
	for (const path of emissionPaths.values()) maxDepth = Math.max(maxDepth, path.length);
	const buckets: OverlayNode[][] = Array.from({ length: maxDepth + 1 }, () => []);
	for (const [node, path] of emissionPaths) buckets[path.length]!.push(node);
	const folded = new Set<OverlayNode>();
	for (const bucket of buckets) {
		for (const node of bucket) {
			const path = emissionPaths.get(node)!;
			// placement 祖先：该子树的当前值由外部放置决定，不能按原路径逐项发射。
			if (hasPlacementAncestor(node) || hasFoldedAncestor(node, folded)) continue;
			if (forcedFolds.has(node)) {
				emitSet(operations, path, cloneNode(node));
				folded.add(node);
				continue;
			}
			if (Array.isArray(nodeBase(node))) emitArrayOperations(node, path, operations, denseRegions.get(node));
			else emitObjectOperations(node, path, operations);
			if (operations.length > MAX_DELTA_OPERATIONS) {
				locatedDenseArray = undefined;
				return [["r", cloneNode(context.root!)]];
			}
		}
	}
	locatedDenseArray = undefined;
	return operations;
}

/**
 * 纯对象草稿的快速发射路径。
 *
 * 输入：上下文；输出：Op[]（成功）或 undefined（形状不符合，交给通用路径）。
 * 适用条件：所有 dirty 节点都是对象；没有数组祖先；没有保留键写入；没有 placement 祖先；节点数 <= 上限。
 * 成功时按深度稳定排序（浅层先写），逐节点 emitObjectOperations；若全部写入都是“容器归一化写入”，
 * 可设置 simpleObjectMaterialization，让 materializePrepared 直接 cloneNode 而不用重放 ops。
 */
function emitSimpleObjectOperations(context: OverlayContext): Op[] | undefined {
	const nodes: OverlayNode[] = [];
	for (const node of context.dirty) {
		if (Array.isArray(nodeBase(node)) || hasReservedMutation(node) || hasPlacementAncestor(node)) return undefined;
		for (let parent = nodeParent(node); parent !== undefined; parent = nodeParent(parent)) {
			if (Array.isArray(nodeBase(parent))) return undefined;
		}
		const path = resolvePath(node);
		if (path === undefined) continue;
		for (const segment of path) {
			if (typeof segment === "string" && RESERVED_SEGMENTS.has(segment)) return undefined;
		}
		nodes.push(node);
		if (nodes.length > MAX_SIMPLE_OBJECT_NODES) return undefined;
	}
	// Stable insertion sort avoids comparator/bucket allocations for the usual
	// handful of dirty object nodes.
	// 小数组用插入排序，稳定且不分配比较器；只按路径深度排序，同深度保持 dirty 顺序。
	for (let index = 1; index < nodes.length; index++) {
		const node = nodes[index]!;
		const depth = node.preparedPath!.length;
		let at = index;
		while (at > 0 && nodes[at - 1]!.preparedPath!.length > depth) {
			nodes[at] = nodes[at - 1]!;
			at -= 1;
		}
		nodes[at] = node;
	}
	const operations: Op[] = [];
	let canMaterializeDirectly = true;
	for (const node of nodes) {
		// 返回 true 表示发生了子容器归一化写入，直接 clone 根更简单可靠。
		if (emitObjectOperations(node, node.preparedPath!, operations)) canMaterializeDirectly = false;
		if (operations.length > MAX_DELTA_OPERATIONS) return [["r", cloneNode(context.root!)]];
	}
	context.simpleObjectMaterialization = canMaterializeDirectly;
	return operations;
}

// 密集候选扫描的模块级临时结果：avoid 每次调用分配 {array,index} 对象。
let locatedDenseArray: OverlayNode | undefined;
let locatedDenseIndex = 0;

/**
 * 判断 dirty 节点是否是一个未结构变化的 base 数组的直接子元素，并记录父数组与源下标。
 *
 * 输入：节点；输出：true 表示 locatedDenseArray/locatedDenseIndex 已设置；副作用：写模块级临时变量。
 * 条件：最近祖先数组存在；子节点来自 base（parentKind === 1）；数组没有结构变化；
 *       父数组当前槽位仍指向该节点的 base（没有被覆盖或移走）。
 */
function locateDenseArrayPosition(node: OverlayNode): boolean {
	let child = node;
	for (let parent = nodeParent(child); parent !== undefined; parent = nodeParent(child)) {
		if (Array.isArray(nodeBase(parent))) {
			const overlay = arrayOverlay(parent);
			if (child.parentKind !== 1 || overlay.structural) return false;
			const sourceIndex = child.parentKey as number;
			const valueIndex = overlay.baseOverrides?.get(sourceIndex);
			const current =
				valueIndex === undefined
					? (nodeBase(parent) as JsonValue[])[sourceIndex]
					: storedValue(parent.context, valueIndex);
			if (current !== nodeBase(child)) return false;
			locatedDenseArray = parent;
			locatedDenseIndex = sourceIndex;
			return true;
		}
		child = parent;
	}
	return false;
}

// 某节点的路径是否落在某个祖先数组已计划整段发送的密集区间内。
function hasCoveringDenseRegion(
	node: OverlayNode,
	path: Path,
	denseRegions: ReadonlyMap<OverlayNode, readonly DenseRegion[]>,
): boolean {
	for (let parent = nodeParent(node); parent !== undefined; parent = nodeParent(parent)) {
		const regions = denseRegions.get(parent);
		if (regions === undefined) continue;
		const parentPath = resolvePath(parent);
		if (parentPath === undefined || path.length <= parentPath.length) continue;
		let matches = true;
		for (let index = 0; index < parentPath.length; index++) {
			if (path[index] !== parentPath[index]) {
				matches = false;
				break;
			}
		}
		if (!matches) continue;
		const index = path[parentPath.length];
		if (typeof index === "number" && regionContaining(regions, index)) return true;
	}
	return false;
}

/**
 * 记录一个密集候选下标。
 *
 * 输入：候选集合与下标；输出：无；副作用：小集合用 indices 数组，达到 256 个后升级为 Uint8Array 位图。
 * 阈值 256 与 buildDenseRegions 的最小 count 一致：少于 256 个修改不值得整段 p。
 */
function addDenseCandidate(candidates: DenseCandidates, index: number): void {
	if (candidates.bits !== undefined) {
		candidates.bits[index] = 1;
		return;
	}
	candidates.indices.push(index);
	if (candidates.indices.length < 256) return;
	candidates.bits = new Uint8Array(candidates.length);
	for (const existing of candidates.indices) candidates.bits[existing] = 1;
	candidates.indices.length = 0;
}

// 若节点是数组直接子元素，把其父数组/源下标记入按数组分组的候选表。
function recordDenseArrayPosition(node: OverlayNode, groups: Map<OverlayNode, DenseCandidates>): void {
	if (!locateDenseArrayPosition(node)) return;
	let candidates = groups.get(locatedDenseArray!);
	if (candidates === undefined) {
		candidates = { indices: [], bits: undefined, length: (nodeBase(locatedDenseArray!) as JsonValue[]).length };
		groups.set(locatedDenseArray!, candidates);
	}
	addDenseCandidate(candidates, locatedDenseIndex);
}

/**
 * 从候选位图提取值得整段替换的密集区间。
 *
 * 输入：候选集合；输出：DenseRegion[]；副作用：无。
 * 规则：区间允许至多一个空洞（gap > 1 时结束）；长度内至少 256 个候选且密度 >= 50% 才成立。
 * 只在 bits 已创建（候选达到 256）时才会产生区间。
 */
function buildDenseRegions(candidates: DenseCandidates): DenseRegion[] {
	if (candidates.bits === undefined) return [];
	const regions: DenseRegion[] = [];
	const bits = candidates.bits;
	for (let at = 0; at < bits.length; ) {
		while (at < bits.length && bits[at] === 0) at += 1;
		if (at === bits.length) break;
		const start = at;
		let end = at;
		let count = 0;
		let gap = 0;
		while (at < bits.length) {
			if (bits[at] !== 0) {
				count += 1;
				end = at;
				gap = 0;
			} else if (++gap > 1) break;
			at += 1;
		}
		const length = end - start + 1;
		if (count >= 256 && count * 2 >= length) regions.push({ start, length });
	}
	return regions;
}

// 线性判断下标是否落在任一区间；区间数量通常很小。
function regionContaining(regions: readonly DenseRegion[], index: number): boolean {
	for (const region of regions) if (index >= region.start && index < region.start + region.length) return true;
	return false;
}

// 节点是否有保留键（__proto__/constructor/prototype）的写入或删除；有则必须整值折叠。
function hasReservedMutation(node: OverlayNode): boolean {
	if (node.writeKey !== undefined && RESERVED_SEGMENTS.has(node.writeKey)) return true;
	if (node.deleteKey !== undefined && RESERVED_SEGMENTS.has(node.deleteKey)) return true;
	if (node.writes !== undefined) {
		for (const key of node.writes.keys()) if (RESERVED_SEGMENTS.has(key)) return true;
	}
	if (node.deletes !== undefined) {
		for (const key of node.deletes) if (RESERVED_SEGMENTS.has(key)) return true;
	}
	return false;
}

// 沿父链检查是否有已折叠的祖先；已折叠祖先的整值写入已经包含该节点。
function hasFoldedAncestor(node: OverlayNode, folded: ReadonlySet<OverlayNode>): boolean {
	for (let parent = nodeParent(node); parent !== undefined; parent = nodeParent(parent))
		if (folded.has(parent)) return true;
	return false;
}

// 沿父链检查是否有 placement 来源的祖先（值由外部放置，路径无法安全逐项重放）。
function hasPlacementAncestor(node: OverlayNode): boolean {
	for (let current: OverlayNode | undefined = node; current !== undefined; current = nodeParent(current)) {
		if (nodeParent(current) !== undefined && current.parentPlacement) return true;
	}
	return false;
}

/**
 * 发射单个对象键的写入 op。
 *
 * 输入：节点、父路径、输出数组、键、值；输出：true 表示“容器归一化写入”（before/after 都是容器但未产生 op），
 *       调用方据此禁用直接 clone 快速路径。
 * 快速路径：appends 命中时直接写 `a`，无需比较字符串。
 * 其他情况：before 取 base 值（重新添加的键视为 undefined），after 取克隆后的当前值；
 * 两者相同则不发射；字符串优化交给 emitChangedValue。
 */
function emitObjectWrite(node: OverlayNode, path: Path, operations: Op[], key: string, value: Stored): boolean {
	const nextPath = [...path, key] as unknown as NonEmptyPath;
	const appended = node.appends?.get(key);
	if (appended !== undefined) {
		operations.push(["a", nextPath, appended]);
		return false;
	}
	// 重新添加的键在 base 上存在，但语义上是“先删后加”；对 op 来说 before 应视为不存在。
	const before =
		node.readded?.has(key) || !Object.hasOwn(nodeBase(node), key)
			? undefined
			: (nodeBase(node) as Record<string, JsonValue>)[key];
	const after = cloneStored(value, node.context);
	const emitted = emitChangedValue(operations, nextPath, before, after);
	return isContainer(before) && isContainer(after) && !emitted;
}

/**
 * 发射一个对象节点的全部写入/删除。
 *
 * 输入：节点、路径、operations；输出：是否发生“容器归一化写入”（emitObjectWrite 的返回值聚合）。
 * 顺序：先为重新添加的 base 键补 `d`（保证键顺序），再写 writeKey，再写 writes Map，最后删除键。
 * 超过 op 上限时的提前返回只用于让调用方尽快走根替换；不代表一定完成。
 */
function emitObjectOperations(node: OverlayNode, path: Path, operations: Op[]): boolean {
	// Immutable replay must encode delete-and-readd explicitly so string-key
	// insertion order matches the draft.
	if (node.readded !== undefined) {
		for (const key of node.readded) {
			if (Object.hasOwn(nodeBase(node), key)) operations.push(["d", [...path, key] as unknown as NonEmptyPath]);
		}
	}
	let normalizedContainerWrite = false;
	if (node.writeKey !== undefined)
		normalizedContainerWrite = emitObjectWrite(
			node,
			path,
			operations,
			node.writeKey,
			objectValue(node, node.writeKey),
		);
	if (node.writes !== undefined) {
		for (const [key, valueIndex] of node.writes) {
			if (operations.length > MAX_DELTA_OPERATIONS) return normalizedContainerWrite;
			if (emitObjectWrite(node, path, operations, key, storedValue(node.context, valueIndex)))
				normalizedContainerWrite = true;
		}
	}
	// 只发射 base 上确实存在的删除；删除一个本来就不存在的键不产生差异。
	if (node.deleteKey !== undefined && Object.hasOwn(nodeBase(node), node.deleteKey)) {
		operations.push(["d", [...path, node.deleteKey] as unknown as NonEmptyPath]);
	}
	if (node.deletes !== undefined) {
		for (const key of node.deletes) {
			if (operations.length > MAX_DELTA_OPERATIONS) return normalizedContainerWrite;
			if (Object.hasOwn(nodeBase(node), key)) operations.push(["d", [...path, key] as unknown as NonEmptyPath]);
		}
	}
	return normalizedContainerWrite;
}

/**
 * 为结构性数组变化生成替换计划并缓存。
 *
 * 输入：数组节点；输出：ArrayPlan；副作用：写入 overlay.plan，并在下次结构变化时失效。
 * 先尝试“保留元素顺序不变”的 O(pieces) 计划；失败再走逐元素 O(baseLength) 的置换计划。
 */
function buildArrayPlan(node: OverlayNode): ArrayPlan {
	const overlay = arrayOverlay(node);
	if (overlay.plan !== undefined) return overlay.plan;
	const base = nodeBase(node) as JsonValue[];
	const pieces = piecesOf(overlay);
	overlay.plan = orderedArrayPlan(base.length, pieces) ?? elementArrayPlan(base.length, pieces);
	return overlay.plan;
}

/**
 * The plan when the retained base elements keep their order, the common case of inserts and removals: computed from the
 * pieces alone, so appending to a long array costs no walk over its elements. `undefined` when base elements moved.
 */
/**
 * 保留元素顺序不变时的数组计划（插入/删除的常见情况）。
 *
 * 输入：base 长度与 piece 顺序；输出：ArrayPlan 或 undefined（base 元素发生移动）。
 * 条件：所有 base piece 的 step 为 1（长度 1 时 step 无关紧要），且源区间严格递增、不重叠。
 * removeRuns：从后往前计算“未被保留的连续区间”，避免删除操作影响前面的下标。
 * insertRuns：连续插入 piece 的 [逻辑下标, 首 piece, 尾后 piece] 三元组。
 */
function orderedArrayPlan(baseLength: number, pieces: readonly Piece[]): ArrayPlan | undefined {
	// Retained base ranges in piece order, `[first, last]` each; ordered means strictly ascending without overlap.
	const ranges: number[] = [];
	for (const piece of pieces) {
		if (piece.kind !== "base" || piece.length === 0) continue;
		if (piece.step !== 1 && piece.length > 1) return undefined;
		if (ranges.length > 0 && piece.start <= ranges[ranges.length - 1]!) return undefined;
		ranges.push(piece.start, piece.start + piece.length - 1);
	}
	// Unretained runs from the end backwards, as `start, length` pairs: after the last range, between ranges, before the first.
	const removeRuns: number[] = [];
	let end = baseLength;
	for (let index = ranges.length - 2; index >= -2; index -= 2) {
		const start = index >= 0 ? ranges[index + 1]! + 1 : 0;
		if (end > start) removeRuns.push(start, end - start);
		if (index >= 0) end = ranges[index]!;
	}
	return { removeRuns, permutation: undefined, insertRuns: insertRunsOf(pieces) };
}

/**
 * 逐元素走 base 的数组计划，处理 reverse/sort 等移动了 base 元素的情况。
 *
 * 输入：base 长度与 pieces；输出：ArrayPlan；副作用：分配 Uint8Array(baseLength) 与若干数组。
 * retained 标记哪些 base 下标仍存在；targetBase 是它们在新数组中的顺序；
 * 若 targetBase 与升序的 retainedBase 不同，就生成 permutation（新数组第 i 项 = 旧数组第 p[i] 项）。
 */
/** The plan from a walk over every base element, for pieces that moved base elements. */
function elementArrayPlan(baseLength: number, pieces: readonly Piece[]): ArrayPlan {
	const retained = new Uint8Array(baseLength);
	const targetBase: number[] = [];
	for (const piece of pieces) {
		if (piece.kind !== "base") continue;
		for (let offset = 0; offset < piece.length; offset++) {
			const index = piece.start + piece.step * offset;
			retained[index] = 1;
			targetBase.push(index);
		}
	}
	const removeRuns: number[] = [];
	for (let end = baseLength; end > 0; ) {
		if (retained[end - 1] !== 0) {
			end -= 1;
			continue;
		}
		let start = end - 1;
		while (start > 0 && retained[start - 1] === 0) start -= 1;
		removeRuns.push(start, end - start);
		end = start;
	}
	const retainedBase: number[] = [];
	for (let index = 0; index < retained.length; index++) if (retained[index] !== 0) retainedBase.push(index);
	let permutation: number[] | undefined;
	if (targetBase.some((value, index) => value !== retainedBase[index])) {
		const positions = new Map(retainedBase.map((value, index) => [value, index]));
		permutation = targetBase.map((value) => positions.get(value)!);
	}
	return { removeRuns, permutation, insertRuns: insertRunsOf(pieces) };
}

/**
 * 找出连续 insert piece 组成的 run。
 *
 * 输入：piece 顺序；输出：扁平数组，每三个数描述一个 run：插入位置（逻辑下标）、起始 piece 下标、结束 piece 下标。
 * 插入位置 = 当前逻辑位置减去 run 自身长度；多个相邻插入 piece 合并成一次 splice 插入。
 */
/** Runs of consecutive insert pieces as `logical index, first piece, end piece` triples. */
function insertRunsOf(pieces: readonly Piece[]): number[] {
	const insertRuns: number[] = [];
	let logicalIndex = 0;
	for (let pieceIndex = 0; pieceIndex < pieces.length; ) {
		const piece = pieces[pieceIndex]!;
		if (piece.kind === "base") {
			logicalIndex += piece.length;
			pieceIndex += 1;
			continue;
		}
		const startPiece = pieceIndex;
		while (pieceIndex < pieces.length && pieces[pieceIndex]!.kind === "insert") {
			logicalIndex += pieces[pieceIndex]!.length;
			pieceIndex += 1;
		}
		insertRuns.push(logicalIndex - rangeLength(pieces, startPiece, pieceIndex), startPiece, pieceIndex);
	}
	return insertRuns;
}

// 求 pieces[start,end) 的长度和。
function rangeLength(pieces: readonly Piece[], start: number, end: number): number {
	let length = 0;
	for (let index = start; index < end; index++) length += pieces[index]!.length;
	return length;
}

/**
 * 发射一个数组节点的修改。
 *
 * 输入：数组节点、路径、operations、可选密集区间；输出：无。
 * 顺序：
 * 1. 密集区间：每个区间发一个 `p`，payload 是整段当前值；
 * 2. 结构变化：按 ArrayPlan 先删除（从后往前，下标稳定）、再 permutation（如有）、再按 run 插入；
 * 3. 剩余的 base 覆盖项：按源下标找到当前逻辑下标，发 `s`/`a`/`t`；
 *    落在密集区间内的跳过（已被整段 p 覆盖）。
 * 超过 op 上限时提前返回，调用方最终会用根替换兜底。
 */
function emitArrayOperations(
	node: OverlayNode,
	path: Path,
	operations: Op[],
	denseRegions: readonly DenseRegion[] | undefined,
): void {
	const overlay = arrayOverlay(node);
	const base = nodeBase(node) as JsonValue[];
	if (denseRegions !== undefined) {
		for (const region of denseRegions) {
			if (operations.length > MAX_DELTA_OPERATIONS) return;
			operations.push(["p", path, region.start, region.length, cloneArrayRegion(node, region)]);
		}
	}
	if (overlay.structural) {
		const plan = buildArrayPlan(node);
		for (let index = 0; index < plan.removeRuns.length; index += 2) {
			if (operations.length > MAX_DELTA_OPERATIONS) return;
			operations.push(["p", path, plan.removeRuns[index]!, plan.removeRuns[index + 1]!, []]);
		}
		if (plan.permutation !== undefined) operations.push(["m", path, plan.permutation]);
		const pieces = piecesOf(overlay);
		for (let run = 0; run < plan.insertRuns.length; run += 3) {
			if (operations.length > MAX_DELTA_OPERATIONS) return;
			const logicalIndex = plan.insertRuns[run]!;
			const items: JsonValue[] = [];
			for (let pieceIndex = plan.insertRuns[run + 1]!; pieceIndex < plan.insertRuns[run + 2]!; pieceIndex++) {
				const piece = pieces[pieceIndex]! as InsertPiece;
				for (let offset = 0; offset < piece.length; offset++) {
					const sourceIndex = piece.start + piece.step * offset;
					items.push(cloneStored(entryValueAt(node, piece, sourceIndex), node.context));
				}
			}
			operations.push(["p", path, logicalIndex, 0, items]);
		}
	}
	for (const [baseIndex, valueIndex] of overlay.baseOverrides ?? []) {
		if (operations.length > MAX_DELTA_OPERATIONS) return;
		const index = findEntryIndex(overlay, 1, baseIndex, undefined);
		if (index === undefined || (denseRegions !== undefined && regionContaining(denseRegions, index))) continue;
		emitChangedValue(
			operations,
			[...path, index] as unknown as NonEmptyPath,
			base[baseIndex],
			cloneStored(storedValue(node.context, valueIndex), node.context),
		);
	}
}

// 克隆数组的一个密集区间为独立 JSON 数组（用于 `p` 的 payload）。
function cloneArrayRegion(node: OverlayNode, region: DenseRegion): JsonValue[] {
	const overlay = arrayOverlay(node);
	const result: JsonValue[] = [];
	for (let index = region.start; index < region.start + region.length; index++) {
		const piece = locatePiece(overlay, index);
		const sourceIndex = piece.start + piece.step * overlay.locatedOffset;
		result.push(cloneStored(entryValueAt(node, piece, sourceIndex), node.context));
	}
	return result;
}

/**
 * 发射一个被修改的值，自动选择最小 op。
 *
 * 输入：operations、路径、before（base 旧值，可能 undefined）、after（克隆后的新值）。
 * 输出：是否发射了 op；副作用：向 operations push。
 * 顺序：
 * - 值相等（primitive ===，或容器深比较相等）：不发射；
 * - 字符串且是纯前缀扩展：发 `a`；
 * - 字符串存在足够长的公共前后缀：发 `t` + 可选 `a`；
 * - 其余：发 `s`。
 * `ownedSlice` 保证 op 文本不持有调用方大字符串的底层存储。
 */
function emitChangedValue(
	operations: Op[],
	path: NonEmptyPath,
	before: JsonValue | undefined,
	after: JsonValue,
): boolean {
	if (!isContainer(after) && before === after) return false;
	if (isContainer(before) && isContainer(after) && equalTrustedJson(before, after)) return false;
	if (typeof before === "string" && typeof after === "string") {
		// O(length): any slice of a rope makes V8 flatten all of it, so this prefix check copies the whole string once per
		// change, even when the writer only appended. Streaming writers use appendText(), which skips it. The op text gets
		// a copy of its own, so it does not keep the whole of `after` alive.
		if (after.length > before.length && after.slice(0, before.length) === before) {
			operations.push(["a", path, ownedSlice(after, before.length)]);
			return true;
		}
		const shared = overlap(before, after, 65_536);
		if (shared > 0) {
			operations.push(["t", path, before.length - shared]);
			if (after.length > shared) operations.push(["a", path, ownedSlice(after, shared)]);
			return true;
		}
	}
	operations.push(["s", path, after]);
	return true;
}

// 发射“把路径处的值设成 value”：空路径是根替换 `r`，否则是 `s`。
function emitSet(operations: Op[], path: Path, value: JsonValue): void {
	if (path.length === 0) operations.push(["r", value]);
	else operations.push(["s", path as NonEmptyPath, value]);
}

/**
 * 解析节点当前的逻辑路径（相对于根），并缓存到 node.preparedPath。
 *
 * 输入：节点；输出：Path 或 undefined；副作用：写入 preparedPath（父路径也会被缓存）。
 * undefined 的情况：父路径不可解析，或父容器当前不再指向该节点的 base（被删除/覆盖/移动）。
 * 对象父：检查 objectHas 且 objectValue 仍是同一 base；
 * 数组父：用 findEntryIndex 找当前逻辑下标，并再次确认该位置的源值仍是该节点。
 */
function resolvePath(node: OverlayNode): Path | undefined {
	if (node.preparedPath !== undefined) return node.preparedPath;
	const parent = nodeParent(node);
	if (parent === undefined) {
		node.preparedPath = [];
		return node.preparedPath;
	}
	const parentPath = resolvePath(parent);
	if (parentPath === undefined) return undefined;
	if (node.parentKind === 0) {
		const key = node.parentKey as string;
		if (!objectHas(parent, key) || objectValue(parent, key) !== nodeBase(node)) return undefined;
		node.preparedPath = [...parentPath, key];
		return node.preparedPath;
	}
	const overlay = arrayOverlay(parent);
	const index = findEntryIndex(overlay, node.parentKind, node.parentKey as number, node.parentSource);
	if (index === undefined) return undefined;
	const piece = locatePiece(overlay, index);
	if (entryValueAt(parent, piece, node.parentKey as number) !== nodeBase(node)) return undefined;
	node.preparedPath = [...parentPath, index];
	return node.preparedPath;
}

/**
 * 建立“源下标 -> piece 位置”的排序索引，供 findEntryIndex 二分查找。
 *
 * 输入：overlay；输出：无；副作用：填充 baseLocations 和 insertLocations，并按 minimum 排序。
 * 每个 PieceLocation 记录：piece、逻辑起点、源下标最小/最大值。
 * step 可为 -1，因此 minimum/maximum 用 min/max 计算，不能假定 start <= last。
 */
function ensurePieceLocations(overlay: ArrayOverlay): void {
	if (overlay.baseLocations !== undefined) return;
	overlay.baseLocations = [];
	overlay.insertLocations = new Map();
	let logicalStart = 0;
	for (const piece of piecesOf(overlay)) {
		const last = piece.start + piece.step * (piece.length - 1);
		const location = {
			piece,
			logicalStart,
			minimum: Math.min(piece.start, last),
			maximum: Math.max(piece.start, last),
		};
		if (piece.kind === "base") overlay.baseLocations.push(location);
		else {
			let locations = overlay.insertLocations.get(piece.source);
			if (locations === undefined) {
				locations = [];
				overlay.insertLocations.set(piece.source, locations);
			}
			locations.push(location);
		}
		logicalStart += piece.length;
	}
	const byMinimum = (left: PieceLocation, right: PieceLocation): number => left.minimum - right.minimum;
	overlay.baseLocations.sort(byMinimum);
	for (const locations of overlay.insertLocations.values()) locations.sort(byMinimum);
}

/**
 * 把“源下标”映射回当前逻辑下标。
 *
 * 输入：overlay、父种类（base=1/insert=2）、源下标、插入源；输出：逻辑下标或 undefined。
 * 快速路径：base 且数组没有结构变化时，逻辑下标就等于源下标。
 * 慢路径：按 minimum 二分找到可能覆盖该源下标的 piece，检查 maximum 与 step 整除；
 *         一个源下标可能因重排出现在多处，返回排序后第一个覆盖它的 piece。
 */
function findEntryIndex(
	overlay: ArrayOverlay,
	kind: ParentKind,
	sourceIndex: number,
	source: InsertSource | undefined,
): number | undefined {
	if (kind === 1 && !overlay.structural) return sourceIndex;
	ensurePieceLocations(overlay);
	const locations = kind === 1 ? overlay.baseLocations! : overlay.insertLocations!.get(source!);
	if (locations === undefined) return undefined;
	let low = 0;
	let high = locations.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (locations[middle]!.minimum <= sourceIndex) low = middle + 1;
		else high = middle;
	}
	const location = locations[low - 1];
	if (location === undefined || sourceIndex > location.maximum) return undefined;
	const offset = (sourceIndex - location.piece.start) / location.piece.step;
	return offset >= 0 && offset < location.piece.length ? location.logicalStart + offset : undefined;
}

/**
 * 返回上下文的操作批次（惰性生成并缓存）。
 *
 * 输入：上下文；输出：Op[]；副作用：写入 context.ops / replacementNoop。
 * replacement 上下文：与当前权威 base 深比较；相等则 ops=[]（no-op），否则单个根替换 `r`。
 * 普通上下文：走 emitOperations。prepare 与 materializePrepared 都会调用，缓存保证只生成一次。
 */
function ensureOperations(context: OverlayContext): Op[] {
	if (context.ops !== undefined) return context.ops;
	assertReadable(context);
	if (context.replacement) {
		const base = context.tracker.deref()?.replacementBase(context);
		context.replacementNoop =
			base !== undefined && equalTrustedJson(base as unknown as JsonValue, nodeBase(context.root!) as JsonValue);
		context.ops = context.replacementNoop ? [] : [["r", nodeBase(context.root!)]];
	} else context.ops = emitOperations(context);
	return context.ops;
}

/**
 * 深比较两个可信 JSON 值。
 *
 * 输入：left/right；输出：boolean；副作用：无。
 * 只用于 tracker 自己的值，不重复校验严格 JSON；先比较引用，再按数组/对象递归。
 * 对象比较键数量与自有键存在性，不比较键顺序（JSON 语义上对象无序）。
 */
function equalTrustedJson(left: JsonValue, right: JsonValue): boolean {
	if (left === right) return true;
	if (!isContainer(left) || !isContainer(right) || Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left)) {
		const other = right as JsonValue[];
		if (left.length !== other.length) return false;
		for (let index = 0; index < left.length; index++)
			if (!equalTrustedJson(left[index]!, other[index]!)) return false;
		return true;
	}
	const other = right as Record<string, JsonValue>;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(other).length) return false;
	for (const key of keys) if (!Object.hasOwn(other, key) || !equalTrustedJson(left[key]!, other[key]!)) return false;
	return true;
}

/**
 * 主动放弃上下文：只在仍 open/prepared 时有效，已 consumed/aborted/stale 直接返回。
 * 置 aborted 后调用 clearContext 逐节点清理；重复 abort 安全。
 */
function abortContext(context: OverlayContext): void {
	if (context.status.value === "aborted" || context.status.value === "consumed" || context.status.value === "stale")
		return;
	context.status.value = "aborted";
	clearContext(context);
}

/**
 * 大草稿的 O(1) 清理：只断开上下文对覆盖层/值的强引用，不逐节点删除。
 *
 * 输入：上下文；输出：无；副作用：注销 tracker 登记、清空模块级密集缓存、标记 overlayReleased。
 * 代价：外部仍持有的 proxy 在下次访问时通过 NODE 缺失/overlayReleased 抛错；
 * 它们与自己的持有者一起被回收，因此不需要遍历 nodes。
 */
function releaseOverlayReferences(context: OverlayContext): void {
	context.tracker.deref()?.releaseContext(context);
	if (locatedDenseArray?.context === context) locatedDenseArray = undefined;
	context.overlayReleased = true;
	context.dirty.length = 0;
	context.nodes.length = 0;
	context.rawNodes = undefined;
	context.ops = undefined;
	context.root = undefined;
	context.bases = undefined;
	context.stored = undefined;
	context.baseValue = undefined;
}

/**
 * 小/中草稿的立即清理：逐节点抹掉 target 上的 NODE 与管理结构。
 *
 * 输入：上下文；输出：无；副作用：清空节点字段、数组 target 长度、覆盖表，最后清空上下文引用并标记 released。
 * 目的：让被外部保留的 proxy 立即失效（NODE 删除 -> TypeError），同时尽快释放大对象。
 */
function clearContext(context: OverlayContext): void {
	context.tracker.deref()?.releaseContext(context);
	if (locatedDenseArray?.context === context) locatedDenseArray = undefined;
	for (const node of context.nodes) {
		// 清空 target 的真实数组内容，避免它继续持有元素引用。
		if (Array.isArray(node.target)) node.target.length = 0;
		Reflect.deleteProperty(node.target, NODE);
		node.writes?.clear();
		node.deletes?.clear();
		node.readded?.clear();
		if (node.array?.pieces !== undefined) node.array.pieces.length = 0;
		if (node.array !== undefined) {
			node.array.root = undefined;
			node.array.baseLocations = undefined;
			node.array.insertLocations = undefined;
		}
		node.array?.baseOverrides?.clear();
		node.array?.insertOverrides?.clear();
		node.parentSource = undefined;
		node.target = RELEASED;
		node.proxy = RELEASED;
		node.writeKey = undefined;
		node.writeValue = undefined;
		node.writes = undefined;
		node.deleteKey = undefined;
		node.deletes = undefined;
		node.readded = undefined;
		node.array = undefined;
		node.subtreeDirty = undefined;
		node.preparedPath = undefined;
	}
	context.dirty.length = 0;
	context.nodes.length = 0;
	context.rawNodes = undefined;
	context.ops = undefined;
	context.root = undefined;
	context.bases = undefined;
	context.stored = undefined;
	context.baseValue = undefined;
	context.overlayReleased = true;
}

// 运行时容器判定：非 null 的对象。作为类型谓词，让调用方在 if 内收窄为 Container。
function isContainer(value: unknown): value is Container {
	return value !== null && typeof value === "object";
}
