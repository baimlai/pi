/*
 * 文件导读
 * ========
 * 所属：packages/chord/src/old 的 Chord v1 对象状态层（旧实现；packages/chord/src 下的 Chord v2 与本文件无关）。
 * 本文件提供对象内部使用的两种状态源：可写的 `Cell` 和同步派生 `Derived`，两者共享 `Source` 基类。
 *
 * 职责边界：
 * - 负责保存当前值、执行 schema 校验、把一次写入转换成 delta 操作、按依赖顺序重算派生值、把快照/增量事件排队
 *   通知订阅者，以及报告“远端成员是否已经收到首个快照”的水合状态（HYDRATION）。
 * - 不负责契约绑定、引用生命周期、跨进程传输和持久化。对象工厂在 object.ts 中通过 self.state/self.derive 创建
 *   这些源；connection.ts/remote.ts 把远端状态成员包装成 Readable 后交给 Derived 订阅；reload.ts 在提交时调用
 *   Cell.reset/initialize 和 Derived.attach/detach。
 *
 * 上游入口：object.ts 的 StateBuilder.state/derive（构造 Cell/Derived）、reload.ts 的 prepare/dryRun 与 commit
 * （reset/attach/detach）、state.ts 的复制状态附加入口（把外部流当作可订阅源）。
 * 下游依赖：delta 的 track/diffRevisions（记录草稿并生成 Op）、publish.ts 的 enqueue/holdPublications（通知顺序）、
 * schema.ts 的 assertValid（状态校验）、types.ts 的 Ctx/Readable/StateEvent、errors.ts 的 ChordError。
 * 结果与错误：同步方法直接返回；校验或写守卫失败抛 ChordError（not_ready、invalid/state、forbidden 等）；订阅者
 * 回调抛出的异常不会回传给写入者，而是交给构造时传入的 report。
 *
 * 能力清单（按导出项）：
 * - `SourceOptions`：每个源共享的 `{ dev, report }`，决定是否逐次校验、错误报告到哪里。
 * - `WriteGuard`：写入前的权限检查函数；Cell.change/replace 的第一步就调用它。
 * - `HYDRATION` / `Hydration` / `hydrationOf` / `unhydrated`：水合协议，判断一个 Readable 是否已经有值。
 * - `Source<T>`：Cell 与 Derived 的共同基类，持有 key、seq、依赖集合、校验用 schema 和通知分发器。
 * - `Cell<T>`：一个状态格子；支持 change（草稿式局部更新）、replace（整值替换）、reset（重载迁移）和 initialize。
 * - `Derived<T>`：由若干 Readable 同步计算出的值；源变化时按 seq 顺序重算并发布 diff。
 * - `Sources` / `SourceValues<S>`：derive 的源元组及其对应值元组的类型工具。
 * - `isSource`：运行时判断是否为 Cell/Derived；`notReady`：构造 not_ready 错误的工厂。
 *
 * 组合关系与典型调用顺序（对象工厂内部）：
 *   const cell = self.state("count", obj({ n: int() }), { n: 0 }); // object.ts 创建 Cell
 *   cell.change(ctx, (draft) => { draft.n += 1; });                 // 写入，生成 ops 并通知订阅者
 *   const doubled = self.derive([cell], (value) => value.n * 2);    // 创建 Derived，commit 时 attach
 *   doubled.value;                                                  // 同步读取派生值
 *   订阅：cell.subscribe(v => ...) 先收到当前值；cell.events(e => ...) 先收到 { type: "snap" }。
 *
 * 示例（真实签名；ctx 由一次根调用或对象方法提供）：
 *   const cell = new Cell<{ n: number }>("count", obj({ n: int() }), { value: { n: 0 } }, (ctx) => {
 *     if (ctx.principal !== "owner") throw forbidden();
 *   }, { dev: true, report: console.error });
 *   const off = cell.events((event) => console.log(event.type));
 *   cell.change(ctx, (draft) => { draft.n += 1; });
 *   off();
 * 学习时请区分：Cell/Derived 是内部实现，普通应用代码通过 self.state/self.derive 间接使用它们。
 *
 * 建议阅读顺序：先读 `SourceOptions`、`Source`、`Cell`、`Derived` 的公开成员，再看 `Fanout`、`unbox`、
 * `computeDependents`、`#publish` 这些内部机制，最后回到 `Hydration` 与 `sharesStructure` 的边界条件。
 */
// 仅类型导入：pi-schema 的 Schema 描述一个 JSON Schema 对象，编译期约束，不产生运行时校验。
import type { Schema } from "@earendil-works/pi-schema";
// Delta 模块：track 建立可写草稿追踪器，diffRevisions 比较两个不可变值生成 Op；Draft/JsonValue/Op/Tracker 都由此进入。
import { type Draft, diffRevisions, type JsonValue, type Op, type Tracker, track } from "../delta/index.ts";
// Chord 统一错误类型；本文件的 not_ready 最终也用它表达。
import { ChordError } from "./errors.ts";
// 进程内 FIFO 通知队列：emit 先 enqueue，再按入队顺序送达，避免重入写入打乱观察顺序。
import { enqueue, holdPublications } from "./publish.ts";
// assertValid：运行时 schema 校验入口，构造、初始化和 change 返回值等位置都会用到它。
import { assertValid } from "./schema.ts";
// Ctx/Readable/StateEvent 是对象调用与状态流的公共接口；只用类型，不在运行时导入。
import type { Ctx, Readable, StateEvent } from "./types.ts";

// 每个状态源共享的运行时选项：dev 关闭时写入不做逐次 schema 校验；report 接管订阅者与派生重算的错误。
export interface SourceOptions {
	// 开发模式开关。生产模式下 Cell 只在构造/初始化以及 change 回调返回值等位置做 assertValid，逐次写入校验关闭。
	readonly dev: boolean;
	// 错误报告回调。约定是“接管错误、不再向写入者抛出”，所以回调自身抛错会破坏隔离。
	readonly report: (error: unknown) => void;
}

// WriteGuard 是函数类型别名：接收本次调用的 Ctx，返回 void；无权写入时直接抛错（常见为 forbidden）。
// 它不是装饰器，也不会缓存结果；Cell 在每次 change/replace 开始时调用。
/** Checks that `ctx` may write an object's cells now; throws otherwise. */
export type WriteGuard = (ctx: Ctx) => void;

// 模块级自增计数器：每构造一个 Source 分配一个递增序号。派生值按 seq 升序重算，先建好的依赖先算。
// 序号只在同一进程内有序，不参与跨进程协议。
let sequence = 0;

// Fanout 是 Cell/Derived 内部的通知分发器：把“值订阅”和“事件订阅”分开保存，并隔离单个回调的异常。
// 它不是跨进程通道；跨进程的 state 帧由 connection.ts 负责。
/** Fans out values and delta events; listener errors are reported, not thrown to the writer. */
class Fanout<T> {
	// #values 保存值回调，#events 保存带类型的状态事件回调；Set 保证同一个函数只注册一次。
	readonly #values = new Set<(value: T) => void>();
	// # 前缀是 ECMAScript 私有字段语法：只能在类内部访问，运行时不进入原型，也不会与普通属性名冲突。
	readonly #events = new Set<(event: StateEvent<T>) => void>();
	// report 接管回调异常，避免一个坏订阅者中断写入或其他订阅者。
	readonly #report: (error: unknown) => void;

	// 构造时只保存报告函数；两个 Set 已在字段初始化时创建。
	constructor(report: (error: unknown) => void) {
		this.#report = report;
	}

	// 订阅值：立即用当前值调用一次，然后返回取消函数。这是 Readable 的约定（先交付当前值）。
	subscribe(listener: (value: T) => void, current: T): () => void {
		// 先注册再回调，因此回调里同步取消订阅也能删除自己。
		this.#values.add(listener);
		// 第一次回调走 #call，异常同样只报告，不会让 subscribe 失败。
		this.#call(listener, current);
		// 返回的闭包只删除这一个监听器；重复调用 delete 无副作用。
		return () => this.#values.delete(listener);
	}

	// 订阅状态事件：立即收到 { type: "snap", value }，之后是 ops/reset 事件。
	events(listener: (event: StateEvent<T>) => void, current: T): () => void {
		this.#events.add(listener);
		// snap 是完整快照；这个对象字面量在这里被类型推断为 StateEvent<T> 的 snap 分支。
		this.#call(listener, { type: "snap", value: current });
		return () => this.#events.delete(listener);
	}

	// emit 只投递给“当前已订阅”的监听器；调用时先复制监听器集合，投递前再检查是否仍订阅。
	/**
	 * Queues delivery to the listeners subscribed now. A listener that subscribes later already got this revision in
	 * its snapshot; one that unsubscribes before delivery is skipped.
	 */
	emit(event: StateEvent<T>): void {
		// 把 Set 展开成数组，固定本次投递的候选者；避免回调中增删监听器改变正在遍历的集合。
		const events = [...this.#events];
		const values = [...this.#values];
		// enqueue 把投递排进进程内 FIFO 队列；即使此刻没有 hold，也会在队列轮到时同步执行。
		enqueue(() => {
			// 事件监听器先收到事件；this.#events.has 复查确保在排队期间取消订阅的监听器被跳过。
			for (const listener of events) if (this.#events.has(listener)) this.#call(listener, event);
			// 值监听器只收到 event.value；snap 事件同样会触发它们，因此不会漏掉当前值。
			for (const listener of values) if (this.#values.has(listener)) this.#call(listener, event.value);
		});
	}

	// #call 用泛型 V 统一处理值回调和事件回调；listener 的异常在此被捕获并交给 report。
	#call<V>(listener: (value: V) => void, value: V): void {
		// 捕获范围只包住单个监听器：一个监听器抛错不会阻止其余监听器。
		try {
			listener(value);
			// 只有 report 自己抛错时才可能向上传播；这是调用方的契约问题，不是订阅者隔离失效。
		} catch (error) {
			this.#report(error);
		}
	}
}

// 水合（hydration）表示远端对象成员是否已经收到首个快照。用 unique symbol 作键，避免与普通属性冲突。
/**
 * Whether a state source has its value (entry 8): a remote reference's member before its first snapshot has none, and
 * neither has anything derived from or forwarding it. Sources without this symbol always have their value.
 */
// unique symbol 是 Symbol 的类型级唯一化：typeof HYDRATION 是唯一的 symbol 类型，运行时值仍是 Symbol。
export const HYDRATION: unique symbol = Symbol("chord.hydration");

// Hydration 只暴露两个成员：当前是否已水合，以及等待完成的 Promise。
export interface Hydration {
	// true 表示 value 已经可用；false 时读取可能抛 not_ready，取决于具体源的实现。
	readonly hydrated: boolean;
	// 返回的 Promise 在源完成水合时 resolve；源先结束则 reject，调用方应处理拒绝。
	/** Resolves once hydrated; rejects if the source ends first. */
	whenHydrated(): Promise<void>;
}

// 从一个 unknown 值上取水合信息；只有对象才可能携带这个 symbol。
/** The hydration of a readable, or undefined for a source that always has its value. */
export function hydrationOf(value: unknown): Hydration | undefined {
	// 运行时形状检查：null/原始值直接视为“没有水合信息”；这不是 schema 校验，只区分载体形状。
	if (value === null || typeof value !== "object") return undefined;
	// 故意用一次类型断言读取 symbol 属性：TypeScript 不知道任意对象上是否有该键，缺失时结果为 undefined。
	return (value as { readonly [HYDRATION]?: Hydration })[HYDRATION];
}

// 过滤出一组尚未水合的源；输入可以是任何可迭代对象，结果总是数组。
/** The hydrations of `sources` that are not hydrated yet. */
export const unhydrated = (sources: Iterable<unknown>): Hydration[] =>
	// hydrationOf 对每个源返回 Hydration|undefined；`=== false` 只保留明确未水合者，filter 的类型谓词把结果收窄为 Hydration[]。
	[...sources]
		.map(hydrationOf)
		.filter((hydration): hydration is Hydration => hydration?.hydrated === false);

// Source 是对象内部状态源的公共基类；子类只实现 value，其余通知和校验逻辑复用。
/** An object-owned state source (cell or derivation). Writes recompute dependents atomically. */
// implements Readable<T> 是编译期检查：Source 必须提供 value/subscribe/events；抽象类本身不实现 value。
export abstract class Source<T> implements Readable<T> {
	// key 是对象内的状态名（state/derive 声明名），用于错误信息和依赖身份识别。
	readonly key: string;
	// seq 在构造时递增，用来按创建顺序拓扑排序派生值；它不是 revision，也不随写入变化。
	readonly seq = ++sequence;
	// dependents 保存直接依赖此源的 Derived；写入时从这些节点出发递归收集全部受影响者。
	readonly dependents = new Set<Derived<unknown>>();
	/** Schemas of remote state members currently exposing this source (checked per write in dev mode). */
	// 对象会把远端成员声明的 schema 汇总到这里；dev 模式下每次写入额外校验。
	schemas: readonly Schema[] = [];
	// options 和 fanout 都是 protected：子类可以读，外部不可见。
	protected readonly options: SourceOptions;
	protected readonly fanout: Fanout<T>;

	// 构造只保存 key/options 并创建 Fanout；值本身由子类管理。
	constructor(key: string, options: SourceOptions) {
		this.key = key;
		this.options = options;
		this.fanout = new Fanout(options.report);
	}

	// 抽象 getter：基类不提供实现，子类必须给出同步读取逻辑。
	abstract get value(): T;

	// 把 Readable.subscribe 转发给 Fanout，并传入当前值作为立即回调。
	subscribe(listener: (value: T) => void): () => void {
		return this.fanout.subscribe(listener, this.value);
	}

	// 同上，但以 snap 事件形式交付当前值。
	events(listener: (event: StateEvent<T>) => void): () => void {
		return this.fanout.events(listener, this.value);
	}

	// validate 是内部校验入口：dev 为 false 时直接返回，生产模式不在每次写入上跑 schema。
	/** Per-write validation, dev mode only. */
	validate(value: unknown): void {
		// 先校验源自身 schema，再校验所有“把它暴露为远端状态”的 schema；任一失败都抛 invalid。
		if (!this.options.dev) return;
		for (const schema of this.ownSchemas()) assertValid("state", `state ${this.key}`, schema, value);
		for (const schema of this.schemas) assertValid("state", `state ${this.key}`, schema, value);
	}

	// 默认没有自身 schema；Cell 覆写为返回自己的 schema。
	protected ownSchemas(): readonly Schema[] {
		return [];
	}
}

// Box 是 Cell 的内部包装：Tracker 追踪容器，所以把值包进 { v } 后，整体替换也能生成对 v 的路径操作。
/** The tracker tracks containers, so a cell tracks `{ v: value }` and strips the box from published ops. */
interface Box<T> {
	v: T;
}

// unbox 去掉内部盒子的第一段路径（"v"），把 Tracker 产生的 Op 转成面向使用者的 Op。
function unbox(ops: readonly Op[], value: unknown): Op[] {
	// result 收集转换后的操作，顺序保持输入顺序。
	const result: Op[] = [];
	for (const op of ops) {
		// 根替换，或路径为空（对盒子整体操作）：统一转成一条对当前值的 r 操作。
		if (op[0] === "r" || op[1].length === 0) return [["r", value as JsonValue]];
		// slice(1) 去掉盒子字段 v；结果仍是 Seg[] 类型的路径。
		const path = op[1].slice(1);
		// 按动词分派：Op 首元素是字面量标签，switch 后 TypeScript 能收窄元组形状。
		switch (op[0]) {
			case "p":
				// p 操作需要额外参数 start/remove/items，所以显式重新构造五元组。
				result.push(["p", path, op[2], op[3], op[4]]);
				break;
			case "m":
				// m 是数组置换，参数是 number[]；路径可以为空（对根数组重排）。
				result.push(["m", path, op[2]]);
				break;
			// 其余 s/d/a/t 都作用在具体路径上。
			default:
				// s/d/a/t on the value itself replace it.
				// 去掉 v 后路径为空，说明操作直接作用在值本身，只能整体替换。
				if (path.length === 0) return [["r", value as JsonValue]];
				// d 只有两元；s/a/t 带 payload，保留为三元组。
				if (op[0] === "d") result.push(["d", path as [string | number, ...(string | number)[]]]);
				else result.push([op[0], path as [string | number, ...(string | number)[]], op[2]] as Op);
		}
	}
	// 返回转换后的操作数组；调用方可能进一步用 diffRevisions 的结果覆盖它。
	return result;
}

// Cell 是对象的一个可写状态格子：创建时校验初值，写入时（dev 模式）校验新值，并把变化发布给订阅者。
/** A state cell holding any JSON value, validated against its schema at creation and (dev mode) on writes. */
// 继承 Source<T>，因此自动拥有 key/seq/dependents/fanout/validate；额外维护 Tracker、写守卫和初始化标记。
export class Cell<T> extends Source<T> {
	// schema 不是 readonly：reload 在状态版本升级时会替换它（reset）。
	/** Replaced at a reload commit that changes the schema (state-version bump). */
	// Tracker<Box<T>> 负责记录草稿、生成 ops、接管不可变新值；类型参数写 Box 是为了追踪容器。
	schema: Schema;
	// guard 检查本次 Ctx 是否有权写这个对象；具体策略由对象运行时提供。
	#tracker: Tracker<Box<T>>;
	readonly #guard: WriteGuard;
	// 使用 # 私有字段，外部无法伪造初始化状态；init 型 cell 在 initialize 前读写都抛 not_ready。
	/** False until `initialize` for a cell declared with `init`: reads and writes throw `not_ready`. */
	#initialized: boolean;

	// initial 存在代表“立即有值”的 cell；不存在则是 init 型 cell，等对象激活时 initialize。
	/**
	 * `initial` is always validated against `schema`; ownership moves to the cell. Without `initial`, the cell has no
	 * value until `initialize` (a cell declared with `init`, filled before its object goes live).
	 */
	constructor(
		key: string,
		schema: Schema,
		initial: { readonly value: T } | undefined,
		// super 先保存 key/options 并创建 fanout；随后子类字段才初始化。
		guard: WriteGuard,
		options: SourceOptions,
	) {
		super(key, options);
		// 初值立即校验（无论 dev）；所有权移交给 cell，调用方之后不应再修改这个值。
		if (initial !== undefined) assertValid("state", `initial value of state ${key}`, schema, initial.value);
		// schema 是对象工厂声明的状态 schema；reload 迁移时可整体替换。
		this.schema = schema;
		// 没有初值时先放占位 null；#initialized=false 保证 value 读取先抛 not_ready，占位值不会泄露。
		this.#tracker = track<Box<T>>({ v: (initial?.value ?? null) as T });
		// 保存写守卫；它只检查权限，不执行写入。
		this.#guard = guard;
		// 有初值即视为已初始化；init 型 cell 此处为 false。
		this.#initialized = initial !== undefined;
	}

	// 为 init 型 cell 设置第一个值：只允许一次，校验后不发布事件（对象尚未对外可见）。
	/** Sets the first value of a cell declared with `init` (validated; ownership moves to the cell). Publishes nothing. */
	initialize(value: T): void {
		// 第二次 initialize 是调用方错误；用普通 Error 表示编程错误，而不是业务错误码。
		if (this.#initialized) throw new Error(`state ${this.key} is already initialized`);
		// 与构造时相同，值必须满足 cell 的 schema。
		assertValid("state", `initial value of state ${this.key}`, this.schema, value);
		// 用新的 Tracker 接管初值，替换构造时的占位 null。
		this.#tracker = track<Box<T>>({ v: value });
		// 标记已初始化，后续 value/change/replace 不再抛 not_ready。
		this.#initialized = true;
	}

	// 告诉 Source.validate：这个 cell 自己的 schema 也要参与每次写入校验。
	protected override ownSchemas(): readonly Schema[] {
		return [this.schema];
	}

	// 同步读取当前值；未初始化时抛 not_ready（统一错误码，不是普通 Error）。
	get value(): T {
		if (!this.#initialized) throw notReady(`state ${this.key} (its init has not run)`);
		return this.#tracker.value.v;
	}

	// change 有两个重载：回调返回 void 表示只改草稿；回调返回值表示用返回值替换整个值。
	/**
	 * Mutates a draft (only mutated paths are published), or returns a new value (`n => n + 1`). A returned value is
	 * always validated against the schema. The draft is unusable after `fn` returns.
	 */
	// 重载声明只为类型推断服务，下面才是实现；实现签名用 unknown 接收两种回调结果。
	change(ctx: Ctx, fn: (draft: Draft<T>) => T): void;
	change(ctx: Ctx, fn: (draft: Draft<T>) => void): void;
	// 实现流程：取写权限 → 检查初始化 → 开草稿 → 执行回调 → 物化 → 发布。
	change(ctx: Ctx, fn: (draft: Draft<T>) => unknown): void {
		// 守卫可能抛 forbidden；它发生在任何状态变更之前。
		this.#guard(ctx);
		// 未初始化时不能写；错误消息说明是 init 尚未运行。
		if (!this.#initialized) throw notReady(`state ${this.key} (its init has not run)`);
		// beginChange 打开新草稿；旧的未提交草稿会失效。
		const change = this.#tracker.beginChange();
		// prepared 的类型由 ReturnType<typeof change.prepare> 推导，避免重复写出 Prepared<Box<T>>。
		let prepared: ReturnType<typeof change.prepare>;
		// try/catch 保证回调或校验失败时 abort 草稿，不留下半提交状态。
		try {
			// change.state 是 Draft<Box<T>>；draft.v 经断言暴露为 Draft<T>，实际对象由 Proxy 提供。
			const draft = change.state as Draft<Box<T>>;
			// 执行业务回调；draft 只能在回调返回前使用。
			const result: unknown = fn(draft.v as Draft<T>);
			// Promise 不是合法 JSON 状态值，也不允许异步写入；发现后立即 TypeError。
			if (result instanceof Promise) throw new TypeError("cell.change callbacks must be synchronous");
			// undefined 表示“只改草稿”；其他返回值表示整体替换。
			if (result !== undefined) {
				// 返回值与草稿根是同一引用时不必再校验（它就是草稿本身）。
				if (result !== draft.v) assertValid("state", `state ${this.key}`, this.schema, result);
				// 把返回值写回草稿的 v 字段；随后 prepare 会把它物化。
				draft.v = result as Draft<T>;
			}
			// prepare 物化为不可变新值和 ops；这之后草稿只读。
			prepared = change.prepare();
			// 任意异常（包括 assertValid 的 ChordError）都先回滚草稿。
		} catch (error) {
			// abort 丢弃覆盖层；不会发布任何东西。
			change.abort();
			// 保留原始异常继续向上抛，调用方看到真正原因。
			throw error;
		}
		// 发布 prepared（可能包含派生值重算）；成功后 change 才真正生效。
		this.#publish(prepared, "ops");
	}

	// replace 直接替换整个值；调用方转移所有权，之后不得再改传入对象。
	/**
	 * Replaces the whole value. Ownership of `value` moves to the cell: never mutate it afterwards.
	 *
	 * Subscribers get a structural diff (`diffRevisions`) when `diff` is true, or by default when the new value shares
	 * containers with the old one (a new immutable revision of the same state, e.g. mirrored from another store);
	 * otherwise a single `r` op. The resulting value is the same either way; only the ops differ.
	 */
	// options.diff 控制是否发送结构 diff；默认根据新旧值是否共享容器决定。
	replace(ctx: Ctx, value: T, options: { readonly diff?: boolean } = {}): void {
		// 与 change 相同，先检查写权限。
		this.#guard(ctx);
		// init 型 cell 未初始化时不能替换。
		if (!this.#initialized) throw notReady(`state ${this.key} (its init has not run)`);
		// 保存旧值用于 diff；这里的 value 已通过初始化检查。
		const before = this.value;
		// 显式 options.diff 优先；否则 sharesStructure 判断这是否是同一状态的新的不可变 revision。
		const diff = options.diff ?? sharesStructure(before, value);
		// diffRevisions 只生成操作，不改变 before/after；值本身仍由 prepareReplace 接管。
		const ops = diff ? diffRevisions(before as JsonValue, value as JsonValue) : undefined;
		// type 为 ops；validate=true 请求校验（dev 模式才实际执行）并重算派生；ops 参数覆盖 Tracker 自己生成的根替换。
		this.#publish(this.#tracker.prepareReplace({ v: value }), "ops", true, ops);
	}

	// reset 用于 reload 迁移：调用方已经在准备阶段校验过值和派生，所以这里不再检查。
	/**
	 * Installs a migrated value and its schema (reload commit). The caller validated the value and the derivations
	 * over it against every schema that will apply, so nothing is checked here. Subscribers receive a reset.
	 */
	reset(value: T, schema: Schema): void {
		// 先换 schema，再发布 reset；订阅者收到完整值而不是增量。
		this.schema = schema;
		// reset 不校验、不重算派生；type 为 reset，通知携带完整 value。
		this.#publish(this.#tracker.prepareReplace({ v: value }), "reset", false);
	}

	// #publish 是 Cell 的核心提交步骤：先校验并算出所有派生新值，再在 holdPublications 中接管 revision 并排队通知。
	/** Adopts this revision and every derived one, then queues all notifications (cell first, then derivations). */
	#publish(
		prepared: ReturnType<Tracker<Box<T>>["prepareReplace"]>,
		type: "ops" | "reset",
		validate = true,
		ops?: readonly Op[],
	): void {
		// 没有任何 ops 的普通写入是 no-op：只接管 revision，不通知，也不重算派生。
		if (prepared.ops.length === 0 && type === "ops") {
			// 接管 prepared 让 Tracker 前进到新 revision；不产生事件。
			this.#tracker.adopt(prepared);
			// 提前返回，跳过下面的通知和依赖重算。
			return;
		}
		// prepared.value 是盒子，取出 v 作为真正的新值。
		const value = prepared.value.v;
		// candidates 保存所有受影响派生值的新结果；Map 的键是 Derived 实例。
		let candidates: Map<Derived<unknown>, unknown>;
		// 校验或重算失败时不能接管 prepared，必须 abort 后把错误抛给写入者。
		try {
			// 先校验 Cell 自身及远端暴露 schema（dev 模式才真正执行校验循环）。
			if (validate) this.validate(value);
			// 从本源的 dependents 出发，按 seq 顺序重算所有传递依赖。
			candidates = computeDependents(this as Source<unknown>, value, validate);
			// 捕获上面的任意异常。
		} catch (error) {
			// 丢弃 prepared，Tracker 状态不变。
			prepared.abort();
			// 原样抛出，保持错误码与 reason。
			throw error;
		}
		// holdPublications 暂停通知投递，等 adopt 和派生 install 全部完成后再统一释放。
		holdPublications(() => {
			// 接管 prepared；此后 Tracker.value 指向新 revision。
			this.#tracker.adopt(prepared);
			// 显式 diff ops 优先；否则把 Tracker 的盒子操作 unbox 成对外 Op。
			const published = ops !== undefined && ops.length > 0 ? ops : unbox(prepared.ops, value);
			// reset 事件只带 value；普通写入带 ops 和完整 value。
			this.fanout.emit(type === "reset" ? { type, value } : { type, ops: published, value });
			// 派生值按 seq 顺序安装；它们的 fanout 会在同一个 hold 内排队通知。
			for (const [derived, next] of candidates) derived.install(next);
		});
	}
}

// sharesStructure 判断 b 是否在同一个键上复用了 a 的容器对象；用于识别“同一状态的新 revision”。
/** True if `b` reuses at least one container of `a` at the same key: a new revision of the same state. */
function sharesStructure(a: unknown, b: unknown): boolean {
	// 非对象、null、同一引用都不算“共享结构”；数组与对象类型必须一致。
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || a === b) return false;
	// 数组和普通对象不能互相复用同一个容器。
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	// 只检查 b 的自有可枚举字段；Object.entries 返回 [key, value] 对。
	for (const [key, child] of Object.entries(b)) {
		// 值本身是对象且与 a 同键的值同一引用时，认为 b 复用了 a 的结构。
		if (child !== null && typeof child === "object" && (a as Record<string, unknown>)[key] === child) return true;
	}
	// 没有找到任何共享容器。
	return false;
}

// computeDependents 从直接依赖出发收集全部传递依赖，并按创建序号重算；validate 可关闭（reset 已提前校验）。
/** Recomputes every transitive dependent of `changed` against candidate values and validates them. */
function computeDependents(changed: Source<unknown>, value: unknown, validate = true): Map<Derived<unknown>, unknown> {
	// pending 同时充当“已访问”集合，避免菱形依赖被重复收集。
	const pending = new Set<Derived<unknown>>();
	// visit 是递归 DFS：只沿 Source.dependents 走，因此外部 Readable 不会出现在这里。
	const visit = (source: Source<unknown>): void => {
		// 遍历该源当前登记的所有直接依赖。
		for (const derived of source.dependents) {
			// 已经访问过的派生值不再递归，防止菱形依赖重复计算。
			if (pending.has(derived)) continue;
			// 先登记再递归，保证环（不应存在）也不会无限循环。
			pending.add(derived);
			// 继续访问这个派生值的下游。
			visit(derived);
		}
	};
	// 从 changed 的直接依赖开始收集；changed 自身的值由调用方单独提供。
	visit(changed);
	// values 保存“本次写入过程中的候选值”；读取时优先用它，避免读到旧值。
	const values = new Map<Readable<unknown>, unknown>([[changed, value]]);
	// result 只保存 Derived 的计算结果，供 Cell.#publish 依次 install。
	const result = new Map<Derived<unknown>, unknown>();
	// 按 seq 升序保证上游派生先算；展开成数组后 sort 不会修改原 Set。
	for (const derived of [...pending].sort((a, b) => a.seq - b.seq)) {
		// compute 的回调在 values 有候选值时返回候选值，否则读源的当前值。
		const next = derived.compute((source) => (values.has(source) ? values.get(source) : source.value));
		// dev 模式下校验派生值；生产模式跳过，只有调用方显式要求时才检查。
		if (validate) derived.validate(next);
		// 记录候选值，供下游派生读取。
		values.set(derived, next);
		// 记录结果，供发布阶段安装。
		result.set(derived, next);
	}
	return result;
}

// Sources 是 Readable 的只读元组；derive 用它推导每个源的值类型。
export type Sources = readonly Readable<unknown>[];
// 映射类型 SourceValues：对元组 S 的每个位置提取 Readable<infer T> 的 T，得到与源一一对应的参数元组。
export type SourceValues<S extends Sources> = { [K in keyof S]: S[K] extends Readable<infer T> ? T : never };

// isReadable 是运行时结构判断：只要对象有 subscribe 函数和 value 属性即视为可读源。
const isReadable = (value: unknown): value is Readable<unknown> =>
	// 这属于信任边界检查：derive 接收调用方传入的 unknown 数组，TypeScript 只能保证声明类型，运行时要防误用。
	value !== null &&
	typeof value === "object" &&
	typeof (value as Readable<unknown>).subscribe === "function" &&
	"value" in value;

// Derived 表示同步派生：源变化时重算，结果通过 Source 的 fanout 以 diff 事件发布。
/**
 * A synchronous derivation. Sources are object cells/derivations (recomputed atomically with the write) or other
 * readables such as reference state members (recomputed when they publish). Subscribers receive diffs.
 */
// 继承 Source<T> 获得 key/seq/dependents/fanout；额外保存源列表、计算函数和外部订阅取消函数。
export class Derived<T> extends Source<T> {
	// sources 是构造时传入的只读源列表；顺序决定 fn 的实参顺序。
	readonly sources: readonly Readable<unknown>[];
	// #fn 保存计算函数；参数类型被擦成 never[]，由 compute 负责按 sources 展开。
	readonly #fn: (...values: never[]) => unknown;
	// #value 缓存最近一次计算的派生值；只有 install 能更新。
	#value: T;
	// #external 保存非 Source 源（如远端成员）的取消函数，detach 时统一调用。
	#external: (() => void)[] = [];

	// 构造只保存源和函数，不立即计算；真正计算在 attach 时（重载的 dryRun 可以提供预计算值）。
	constructor(key: string, sources: Sources, fn: (...values: never[]) => unknown, options: SourceOptions) {
		super(key, options);
		// sources.map 做运行时检查后再返回；类型上 Sources 已经是 Readable，这里防的是绕过类型的调用方。
		this.sources = sources.map((source) => {
			// 失败时抛 TypeError，并带上 derive 的 key，便于定位哪个派生声明写错了。
			if (!isReadable(source)) throw new TypeError(`derive ${key}: sources must be readables`);
			// 返回原对象，不做包装；Derived 直接使用它的 value/subscribe。
			return source;
		});
		// 保存用户函数；它必须是同步的，compute 会再次检查返回值。
		this.#fn = fn;
		// 先给一个类型断言占位值；attach 之前读取的行为不应被外部依赖。
		this.#value = undefined as T;
	}

	// attach 之后返回缓存的派生值；没有 setter，派生值只能由 install 更新。
	get value(): T {
		return this.#value;
	}

	// [HYDRATION] 是计算属性名：读取时执行 getter，而不是存在一个字段。
	/** Hydrated once every source is (a derivation over a remote member waits for its snapshot). */
	get [HYDRATION](): Hydration | undefined {
		// 只要有一个源未水合，就返回一个等待全部源水合的 Hydration。
		const pending = unhydrated(this.sources);
		// 全部已水合时返回 undefined，表示“这个源总是有值”。
		if (pending.length === 0) return undefined;
		// whenHydrated 用 Promise.all 等待所有待水合源；任一拒绝则整体拒绝。
		return {
			hydrated: false,
			// then(() => {}) 把 Promise<void[]> 调整为 Promise<void>，不改变完成/失败时机。
			whenHydrated: () => Promise.all(pending.map((hydration) => hydration.whenHydrated())).then(() => {}),
		};
	}

	// attach 在对象提交时调用：取初值并订阅源；detach 在替换/卸载时撤销订阅。
	/**
	 * Computes the first value (or takes it from `precomputed`, a reload's validated dry run) and starts following
	 * the sources (at install, never inside a factory).
	 */
	attach(precomputed?: ReadonlyMap<unknown, unknown>): void {
		// precomputed 是 reload dryRun 验证过的候选值；优先使用它，避免重复计算。
		this.#value = precomputed?.has(this) ? (precomputed.get(this) as T) : this.compute((source) => source.value);
		// 对每个源区分两类：Source 走内部 dependents 图；其他 Readable（远端成员等）走 subscribe。
		for (const source of this.sources) {
			// Source 分支只登记依赖；刷新由写入方调用 computeDependents 统一驱动。
			if (source instanceof Source) source.dependents.add(this as Derived<unknown>);
			// 外部源的每次发布都调用 refresh；返回的取消函数存起来供 detach 使用。
			else this.#external.push(source.subscribe(() => this.refresh()));
		}
	}

	// detach 只移除本派生注册的依赖和外部订阅；可重复调用，splice(0) 清空数组。
	detach(): void {
		// 对 Source 源删除 dependents 登记；instanceof 是运行时判断。
		for (const source of this.sources)
			if (source instanceof Source) source.dependents.delete(this as Derived<unknown>);
		// splice(0) 返回全部取消函数并清空 #external，然后逐个调用。
		for (const unsubscribe of this.#external.splice(0)) unsubscribe();
	}

	// compute 调用用户函数并把源值展开成参数；read 回调允许调用方替换读取方式（dryRun/写入候选值）。
	compute(read: (source: Readable<unknown>) => unknown): T {
		// sources.map(read) 产生参数数组；展开语法把每个元素作为独立实参。as never[] 是类型层面的桥接。
		const result: unknown = this.#fn(...(this.sources.map(read) as never[]));
		// 派生函数必须同步；返回 Promise 会让依赖图失去同步一致性。
		if (result instanceof Promise) throw new TypeError(`derive ${this.key}: fn must be synchronous`);
		// 用户函数的结果被视为 T；运行时只检查了“不是 Promise”，没有 schema 校验。
		return result as T;
	}

	// refresh 用于外部源发布：重算自身和全部依赖；错误报告给 options.report，因为外部写入已经发生。
	/** Recomputes and republishes, including dependents. Errors are reported (the source write already happened). */
	refresh(): void {
		// 捕获重算/校验异常，避免从订阅回调冒泡到外部源。
		try {
			// 先按当前源值计算自身新值。
			const next = this.compute((source) => source.value);
			// 再计算所有传递依赖的候选值（默认开启校验）。
			const dependents = computeDependents(this as Derived<unknown>, next);
			// 在同一个 hold 内安装自身和依赖，观察者看到一致的顺序。
			holdPublications(() => {
				// install 更新缓存并排队发布自身事件。
				this.install(next);
				// 逐个安装下游派生值；顺序已由 computeDependents 按 seq 排好。
				for (const [derived, value] of dependents) derived.install(value);
			});
			// 失败只报告；源写入已经发生，不能把异常抛回给源。
		} catch (error) {
			this.options.report(error);
		}
	}

	// install 更新缓存值并发布 diff；这是内部入口，Source 的写入路径也会调用它。
	install(next: T): void {
		// 保存旧值用于 diff；undefined 作为“尚无值”的特殊情况处理。
		const before = this.#value;
		// 先更新缓存，后续读取看到新值。
		this.#value = next;
		// 旧值或新值任一为 undefined 时无法可靠 diff，改用 r（整体替换）。
		const ops: Op[] =
			// null 用于表示“没有值”的 wire 形式；JsonValue 不允许 undefined。
			before === undefined || next === undefined
				? // 两边都有值时生成结构 diff；before 与 next 必须是严格 JSON 值。
					[["r", (next ?? null) as JsonValue]]
				: diffRevisions(before as JsonValue, next as JsonValue);
		// 没有操作表示值未变，不发布事件。
		if (ops.length > 0) this.fanout.emit({ type: "ops", ops, value: next });
	}
}

// instanceof 是运行时判断；子类 Cell/Derived 都满足。
export const isSource = (value: unknown): value is Cell<unknown> | Derived<unknown> => value instanceof Source;

/** Thrown by placeholders used before activation finished. */
// 统一的 not_ready 错误工厂：调用方可以 throw notReady(...)，错误码固定为 not_ready。
export const notReady = (what: string): ChordError => new ChordError("not_ready", `${what} is not ready`);
