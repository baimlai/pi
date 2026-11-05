// Derives (§12): values computed from watchables, pulled when read and marked dirty by commits; and `mapShared`, which
// keeps unchanged elements identical so a derive's diff stays cheap.

// 文件导读
// 所属包与模块：packages/chord/src/state 的派生值模块（design §12），属于 Chord 状态层。
// 职责边界：把“来源值 + 纯计算函数”组合成惰性、可缓存的 JSON 值；不负责来源的生命周期（由 host/对象结束
// 时调用 detach），也不负责帧编码。上游：对象激活时 host 调用 attach 解析来源并登记依赖；来源变化时
// Source.changed 调用 invalidate 标脏。下游：watch 读取 deliver 生成的 diff 帧；其他 derive 把本 derive
// 当作输入；mapShared 常被文档投影使用，以保持未变化元素的对象身份。
// 错误流向：compute 抛错 -> 状态变 failed，读取时抛出；同一失败周期通过 attach 的 report 上报一次；
// 来源恢复后下次读取自愈。detach 后永远抛对象的结束错误。
// 能力清单：
// - DeriveSource（类型）：JSON 来源（Source 或 Constant）。
// - DeriveInput（类型）：更宽输入，含原生 source。
// - Derive（类）：派生值实现，含 value/start/attach/detach/invalidate/sourceRetired/deliver 与私有重算。
// - mapShared（函数）：按对象身份缓存元素映射结果的工厂函数。
// 组合关系与典型顺序：构造 Derive(sources, compute, batch) -> attach(resolve, report) 登记依赖 ->
// 来源 invalidate -> 批次 deliver -> value 触发 #recompute -> 生成 diff 帧。
// 示例（真实签名）：const d = new Derive([member], (values) => values[0], batch);
// d.attach((source) => resolveMember(source as string), host.onError); const current = d.value; // 首次读取即计算
// 建议阅读顺序：先读 DeriveState 与字段注释理解状态机，再看 value/start，然后 attach/detach，
// 接着 invalidate/sourceRetired，最后 deliver 与 #recompute；mapShared 可单独阅读。

import type { Context } from "../context/index.ts";
import { diffRevisions, type Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import type { Batch } from "./batch.ts";
import { NativeSource } from "./native-source.ts";
import { type Constant, type Dependent, handedOut, Source, type WatchStart } from "./watchable.ts";

/** A JSON watchable as Chord follows it (a state member, a JSON derive source): a source, or a constant. */
// 可被 derive 读取的 JSON 来源：变化型 Source 或恒定 Constant；两者都提供 value/openWatch。
export type DeriveSource = Source | Constant;

/** What a derive reads: a JSON source or constant, or a native source (a `writable`, a registry value, `ref.state`). */
// 更宽的输入联合：原生 source（持有非 JSON 的进程内值）也可作为 derive 的来源；
// NativeSource 提供 value 与 dependents，但不参与 JSON 帧投递。
export type DeriveInput = DeriveSource | NativeSource;

/**
 * Where a derive stands. `dirty`: a source changed since the last compute (or there was none). A failed derive (its
 * compute threw) throws its error until a source it reads changes or is re-bound, then recomputes (self-healing, design
 * §11); a detached one (its object ended) throws its object's error for good.
 */
// 状态判别联合，kind 是运行时标签：
// - dirty：需要重算（初次或来源变化后）；
// - clean：缓存有效，value 为结果；
// - failed：compute 抛错；读取时重新抛出，来源变化后可自愈；
// - detached：所属对象已结束，永远抛 error，不再重算。
// error 使用 unknown：抛出值不保证是 Error。
type DeriveState =
	| { readonly kind: "dirty" }
	| { readonly kind: "clean"; readonly value: JsonValue }
	| { readonly kind: "failed"; readonly error: unknown }
	| { readonly kind: "detached"; readonly error: unknown };

// 复用的 dirty 状态对象：状态无附加字段，共享一个实例可减少分配。
const DIRTY: DeriveState = { kind: "dirty" };

// 空操作数组常量：表示“值未变化”，避免每帧分配空数组。
const NO_OPS: readonly Op[] = [];

/** What a failed derive's watches had: no value, so its next value frame replaces the value whole. */
// unique symbol 类型：NO_VALUE 是唯一的哨兵，不会与任何 JsonValue 混淆。
// 用途：区分“watch 从未拿到值（失败启动）”与“拿到过某个 JSON 值”，决定恢复时是否发送整体替换 "r" 操作。
const NO_VALUE: unique symbol = Symbol("no value");

/**
 * A derive: `compute` over its sources' values, recomputed on read when dirty, so each compute runs at most once per
 * batch and after its sources. A commit only marks it; the batch recomputes it only when something watched depends on
 * it.
 */
// 类职责：既是 Source（可被 watch），又是 Dependent（可被来源标脏）。
// 字段分工：#compute 是纯函数；#declared 保存尚未解析的声明来源；#sources 是已解析来源；
// #state 是状态机；#framed 保存本批投递前的“watch 已知值”；#retired 记录本批是否发生文档退役；
// #failing 保证一次失败只上报一次，直到出现一次成功值。#good 是失败期间新 watch 的起点。
export class Derive extends Source implements Dependent {
	readonly #compute: (values: readonly unknown[]) => JsonValue;
	/** The sources as declared, until `attach` resolves them. */
	#declared: readonly unknown[] | undefined;
	#sources: readonly DeriveInput[] = [];
	#state: DeriveState = { kind: "dirty" };
	/** The value this derive's watches have, kept from its marking to its frame in the batch. */
	#framed: JsonValue | typeof NO_VALUE | undefined;
	/** Whether a source's document was retired in the current batch while this derive is watched (rule 21). */
	#retired = false;
	/** Reports a failure of its compute to its owner (`attach`); once per failure episode, which a value ends. */
	#report: ((error: unknown) => void) | undefined;
	#failing = false;
	/** Its last good value, which a watch opened while it is failed starts at (`NO_VALUE` before the first). */
	#good: JsonValue | typeof NO_VALUE = NO_VALUE;

	// 构造：保存声明来源（尚未解析）与计算函数；不改状态、不注册依赖、不计算。
	// sources 用 unknown[] 是因为调用方可能传入路由标识等中间形态，attach 时才由 resolve 映射为 DeriveInput。
	// 示例：new Derive([member], (values) => values[0], batch)。
	constructor(sources: readonly unknown[], compute: (values: readonly unknown[]) => JsonValue, batch: Batch) {
		super(batch);
		this.#declared = sources;
		this.#compute = compute;
	}

	// 读取值：clean 直接返回缓存；dirty 触发计算；failed/detached 抛出保存错误。
	// getter 使 derive 可像普通属性一样参与 Source.value 的抽象实现。
	// 示例：const first = derive.value; 来源未变化时第二次读取直接返回同一缓存值。
	get value(): JsonValue {
		const state = this.#state;
		if (state.kind === "clean") return state.value;
		if (state.kind === "dirty") return this.#recompute();
		// 收窄后 state 只能是 failed 或 detached，两者都带 error。
		throw state.error;
	}

	/** Its value, or while failed its failure and last good value (a detached derive throws). */
	// 新 watch 的启动点：正常取值为 value；计算抛错且状态确为 failed 时返回失败 + 最后好值。
	// detached 的错误不转成可恢复失败，而是直接抛给 watch 调用方。
	// 示例：const start = derive.start(); start.kind === "failed" 时 start.last 可能给出最后好值。
	start(): WatchStart {
		try {
			return { kind: "value", value: this.value };
		} catch (error) {
			// 只有 failed 状态允许“以失败启动”；detached 继续抛。
			if (this.#state.kind !== "failed") throw error;
			// NO_VALUE 是内部哨兵，对外转换为 undefined（表示从未有过值）。
			return { kind: "failed", error, last: this.#good === NO_VALUE ? undefined : this.#good };
		}
	}

	/**
	 * Starts reading its sources, as `resolve` maps the declared ones (at activation); the first read computes.
	 * `report` gets a throw of its compute, once per failure episode (a value ends it); a failing source's error is its
	 * source's to report.
	 */
	// 激活时调用：把声明来源映射成真实输入，并把自己登记为每个可变来源的依赖者。
	// 输入 resolve 接收声明值与索引；report 接收 compute 的失败（每个失败周期一次）。
	// 副作用：修改 #sources/#declared，向来源的 dependents 集合加 this；不立即计算（首次读取才算）。
	// 示例：attach((s) => resolveMember(s as string), console.error)。
	attach(resolve: (source: unknown, index: number) => DeriveInput, report: (error: unknown) => void): void {
		this.#report = report;
		// ! 断言 #declared 仍在（attach 只应调用一次）；map 保留声明顺序，索引传给 resolve。
		this.#sources = this.#declared!.map(resolve);
		// 释放声明数组，之后只认已解析来源。
		this.#declared = undefined;
		for (const source of this.#sources) {
			// Constant 没有 dependents，不需要登记；instanceof 用来区分两种可变实现。
			if (source instanceof Source || source instanceof NativeSource) source.dependents.add(this);
		}
	}

	/** Its object ended: no source keeps it, its watches end `ended`, reads throw `error` (the object's). */
	// 对象结束：从所有来源注销、清空来源、置 detached、丢弃本批帧上下文、结束 watch。
	// 输入 error 通常是对象的 released 错误；之后 value 永远抛出它。
	// 示例：对象 released 时调用 derive.detach(error)；之后 derive.value 总是抛出该错误。
	detach(error: Error): void {
		for (const source of this.#sources) {
			if (source instanceof Source || source instanceof NativeSource) source.dependents.delete(this);
		}
		this.#sources = [];
		this.#declared = undefined;
		this.#state = { kind: "detached", error };
		this.#framed = undefined;
		this.endWatches();
	}

	/**
	 * A source changed: mark this derive and its dependents dirty, flags only; a failed one too, which recomputes on its
	 * next read and heals when its sources give a value it can compute. An already dirty derive has dirty dependents
	 * (every read recomputes its sources first), so marking stops there.
	 */
	// 被来源标脏：只改标志，不计算。
	// - 已 dirty 或 detached：无需传播（dirty 的下游必然也已 dirty；detached 不再变化）。
	// - 被 watch 且当前 clean：把当前值记入 #framed，作为本批 diff 的基准；
	//   失败态则记 NO_VALUE，表示 watch 没有值可 diff。
	// - 置 dirty 并调用 changed()，让本 derive 排进批次帧并继续标脏下游。
	// 示例：来源 source.changed() 时对每个 dependent 调用 derive.invalidate()。
	invalidate(): void {
		const state = this.#state;
		if (state.kind === "dirty" || state.kind === "detached") return;
		if (this.watched) this.#framed = state.kind === "clean" ? state.value : NO_VALUE;
		this.#state = DIRTY;
		this.changed();
	}

	/**
	 * A source's document was retired in this batch (`Source.retiredInBatch`): a watched derive's frame carries the
	 * flag, and the derives reading this one are told too.
	 */
	// 退役传播：visited 保证每个 derive 每次退役只处理一次（菱形依赖只遍历一次）。
	// 被 watch 时记录 #retired，帧里会带上 retired；无论是否被 watch，都继续通知下游 derive。
	// 示例：来源文档 retire 时 derive.sourceRetired(new Set()) 把标记沿依赖图传给下游。
	sourceRetired(visited: Set<Dependent>): void {
		// Once per derive per retirement: a diamond of derives is walked in its size, not once per path.
		if (visited.has(this)) return;
		visited.add(this);
		if (this.watched) this.#retired = true;
		for (const derive of this.dependents) derive.sourceRetired(visited);
	}

	/**
	 * Delivers the frame: the diff from the watches' value, a retirement even without ops (rule 21). A compute that
	 * throws gives one failure call when the watches had a value (one per failure episode), the watches stay open; a
	 * retirement waits for the next value.
	 */
	// 批次投递：先取走过期基准 #framed（undefined 表示本批未被 invalidate 登记，理论上不应发生），
	// 计算当前值；成功则生成 diff 并发布，失败则发一次失败帧并保持 watch 打开。
	// 示例：值从 { n: 1 } 变为 { n: 2 } 时发布 diffRevisions 生成的 ops，而不是整个值。
	deliver(context: Context): void {
		// ! 断言本 derive 被 changed() 登记时一定设置了 #framed 基准。
		const before = this.#framed!;
		const retired = this.#retired;
		// 立即清空，避免重入或下一批误用旧基准。
		this.#framed = undefined;
		let after: JsonValue;
		try {
			after = this.value;
		} catch (error) {
			// Still failed since the last call: nothing new for the watches.
			// 若 watch 之前就没有值（失败期间新开），重复失败不再发帧；已有值时发一次失败帧。
			if (before !== NO_VALUE) this.failWatches(error, context);
			return;
		}
		// 计算成功，本批退役标记已随帧处理（或无需再保留）。
		this.#retired = false;
		let ops: readonly Op[] = NO_OPS;
		// 按身份比较新旧值；相同则不发值帧（但退役仍可能单独发布）。
		if (after !== before) {
			this.batch.count("chord.derive.diffs");
			// 之前没有值为整体替换 "r"；否则计算结构化 diff。
			ops = before === NO_VALUE ? [["r", after]] : diffRevisions(before, after);
		}
		// 有实际变化或退役时才发布；纯粹的“重算但值相同”不打扰 watch。
		if (ops.length > 0 || retired) this.publish(after, ops, retired, context);
	}

	// 私有重算：在 batch.compute 中执行，期间禁止来源变更（assertNotComputing 生效的同一标志）。
	// 外层 try 统一把任何失败（来源读取或 compute）转为 failed 状态并重新抛出。
	// 示例：dirty 状态下读取 derive.value 触发 #recompute，成功后缓存 clean 值。
	#recompute(): JsonValue {
		return this.batch.compute(() => {
			try {
				this.batch.count("chord.derive.computes");
				// A failing source throws its own error here, so a derive over a failed derive fails with the same error.
				// 逐个同步读取来源值；来源若失败会在此抛出，本 derive 随之失败。
				const values = this.#sources.map((source) => source.value);
				let value: JsonValue;
				try {
					// 纯函数计算；不应有副作用，也不应读取外部可变状态。
					value = this.#compute(values);
				} catch (error) {
					// 失败周期内只上报第一次；#failing 在成功取值后复位。
					if (!this.#failing) this.#report?.(handedOut(error));
					this.#failing = true;
					throw error;
				}
				// 计算成功：清除失败标记，缓存值，并记录为最后好值。
				this.#failing = false;
				this.#state = { kind: "clean", value };
				this.#good = value;
				return value;
			} catch (error) {
				// 来源失败与 compute 失败都归入 failed，下次读取可自愈重试。
				this.#state = { kind: "failed", error };
				throw error;
			}
		});
	}
}

/**
 * Maps an array calling `f` only for object elements not seen before (by identity), returning the previous result for
 * the others; primitive elements are mapped every time. The cache is weak: dropped elements take their results along.
 */
// 工厂函数：返回一个映射函数，对对象元素按身份缓存结果。
// 输入 f 把元素映射为 JSON 值；返回 elements => R[]。
// 缓存是 WeakMap：元素对象被回收时缓存条目自动消失，不会造成内存泄漏；基本类型不能做 WeakMap 键，
// 因此字符串/数字/null 每次都调用 f（这是既定规则，不是遗漏）。
// 示例：const shared = mapShared((d: Doc) => view(d)); shared([a, b]) 之后再调用 shared([a]) 会复用 a 的结果。
export function mapShared<E, R extends JsonValue>(f: (element: E) => R): (elements: readonly E[]) => R[] {
	const results = new WeakMap<object, R>();
	return (elements) =>
		elements.map((element) => {
			// The decided rule: identity caching for objects only.
			// typeof null 也是 "object"，必须排除；函数类型也会走到这里，同样按对象缓存。
			if (typeof element !== "object" || element === null) return f(element);
			let result = results.get(element);
			// undefined 既表示未缓存，也可能是 f 的合法返回值；R 是 JsonValue，undefined 不是 JsonValue，
			// 因此这里用 undefined 作为“未命中”哨兵是安全的。
			if (result === undefined) {
				result = f(element);
				results.set(element, result);
			}
			return result;
		});
}
