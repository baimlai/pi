// An object's documents (§9, P2, slice 6a §1.2, §10): its slots across attempts, its line (its transactions and line
// jobs run one at a time), the seal fence over the transaction holding the line, the factory's pins between attempts,
// the activation's loads and the residency of keyed documents.

// 文件导读
// 所属：packages/chord/src/documents，单个对象的文档管理器。
// 职责边界：持有一个对象的槽集合、对象线、封条、上一轮 pin 与驻留管理；负责声明/水合/加载/开事务/切断；不实现文档值语义（槽）或存储（Persistence）。
// 上游：host 的 activation 创建并调用 declare/hydrate/load/tx；应用通过句柄间接触发；下游：SingletonSlot/KeyedSlot、Transaction、Persistence、Line、Residency、Batch。
// 结果/错误：tx 内的业务错误丢弃整笔并原样抛出；context 已中止且未提交时额外 report transaction_cancelled；seal 后新事务/onLine 抛 released/ended；加载/迁移错误失败 activation 或 broken。
// 能力清单：TransactionCancelled 取消报告；DocumentsOwner 宿主回调；Documents 类（declare/check/hydrate/load/onLine/tx/fence/assertLive/assertAdmitted/fail/seal/settled/end/released）。
// 组合关系：activation → declare（槽+句柄）→ hydrate（initial/迁移+释放旧 pins）→ load（持久文档）→ 上线；写入走 tx（line → Transaction → commit）→ watch 帧；对象结束 seal → settled → end。
// 示例：const docs = new Documents(owner); const handle = docs.declare(def, token, attempt); docs.hydrate(new Map([[def.name, def]]), pins, ctx); await docs.load(ctx)。
// 阅读顺序：先看 DocumentsOwner 与状态字段，再看 declare/hydrate/load，最后看 tx/fence/seal/end 的封条与收尾。
// 运行期状态机：#state 为 open/sealed/ended；#holder 只在事务持线时存在；这些是运行期检查，TS 类型不阻止调用顺序错误。
import type { Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import type { Batch } from "../state/internal.ts";
import type { ChordStore } from "../store/store.ts";
import type { CommitPersistence, JsonObject, StateDefinition } from "./definition.ts";
import { SealToken } from "./fence.ts";
import { type HandleOf, type KeyDeclarer, Keyed, Singleton } from "./handles.ts";
import { KeyedSlot } from "./keyed-slot.ts";
import { Line } from "./line.ts";
import { Persistence } from "./persistence.ts";
import { Residency } from "./residency.ts";
import { type AnyDefinition, SingletonSlot } from "./slot.ts";
import { Transaction } from "./transaction.ts";

// 报告形状：kind 固定为 transaction_cancelled；object 是对象标签；error 是 context.abortSignal.reason（取消原因）。
// 只在“事务未提交且 context 已 abort”时报告；否则普通错误由调用者处理，避免重复上报。
/**
 * A transaction (a document change or retirement, `self.tx`, a job start) that did not commit because the context it
 * was started with ended first: a root whose `fn` settled, a handler or routine whose object ended, a caller that
 * cancelled. `error` is that context's abort reason, naming the scope that ended (decision "Mistakes that wait are
 * reported at once" (e)).
 */
export type TransactionCancelled = {
	readonly kind: "transaction_cancelled";
	readonly object: string;
	readonly error: unknown;
};

// 宿主（对象/attempt 层）提供给文档管理器的回调；store 可选，因为并非所有对象都可持久化。
// context 是对象的上下文（rule 11）：共享冷加载用它，而非某个调用者的 context。
// fail 用于把不可读文档变成 broken；report 用于取消事务；两者都由宿主决定如何呈现。
/**
 * Who owns an object's documents: the object's name, batch and context, its store address, its live failure, and where
 * a cancelled transaction is reported.
 */
export type DocumentsOwner = {
	/** The owner's name in errors. */
	readonly label: string;
	readonly batch: Batch;
	/** The object's context: shared cold loads run under it (rule 11). */
	readonly context: Context;
	/** The host's store and the object's owner name in it (its type, R2), when it has one. */
	readonly store: { readonly store: ChordStore; readonly owner: string } | undefined;
	/** A document the code cannot read fails the live object `broken` (slice 6a §1.4); ignored when it is not live. */
	fail(error: ChordError): void;
	/** Reports a transaction its context's end cancelled (the host's `onError`). */
	report(error: TransactionCancelled): void;
};

// 例：一个对象第一次 activation 声明 counter（singleton）；第二次 activation 继续用同一 slot，attempt token 不同（旧句柄被栅栏拒绝）。
/**
 * The documents of one object, from its first activation to its end: one slot per declared name, kept across
 * attempts, and the line. Each attempt declares its handles under its own seal token; the object's own transactions
 * (job outcomes) run under `own`, sealed only by the object's end.
 */
export class Documents {
	/** The owner's name in errors. */
	// 错误信息里显示的对象名；构造时从 owner.label 复制。
	readonly label: string;
	readonly batch: Batch;
	/** The object's context. */
	readonly context: Context;
	// 本对象唯一的线：事务、冷加载、键分页与驱逐清扫都排在这条 Promise 链上，一次只跑一个。
	readonly line = new Line();
	// 构造 Residency 时传入的回调把清扫排到对象线；onLine 返回的 Promise 用 void 丢弃。
	// 按设计唯一可能的拒绝是对象结束后 onLine 的 released；sweep 本身只改内存不抛错，空 catch 不隐藏业务错误。
	/**
	 * The idle persisted keyed documents and their eviction. A sweep's only rejection is `onLine`'s `released` once
	 * the object ended (a sweep itself drops trackers in memory and does not throw): nothing to report.
	 */
	readonly residency = new Residency((sweep) => void this.onLine(async () => sweep()).catch(() => {}));
	readonly #owner: DocumentsOwner;
	/** The token of the object's own transactions: sealed with the object (`seal`). */
	// own 是对象自身事务（job outcomes）的封条，只在 seal() 时封；#holder 记录当前持线事务，用于切断。
	// #state 三态是运行期状态机；#pins 是上一轮工厂 at(key) 的释放函数，下一轮 hydrate 时释放。
	readonly own = new SealToken();
	readonly #slots = new Map<string, SingletonSlot | KeyedSlot>();
	/** The transaction holding the line, until it settles or its token is sealed. */
	#holder: Transaction | undefined;
	/** `sealed`: the object is ending; its documents stay readable, its transactions throw `released`. */
	#state: "open" | "sealed" | "ended" = "open";
	/** The pins the last factory that returned declared (`at(key)`): held until the next one returns (rule 6). */
	#pins: readonly (() => void)[] = [];

	// 函数说明：保存 label/batch/context/owner；无 I/O、无状态变化。
	// 例：new Documents({ label: "cart", batch, context, store: { store, owner: "cart" }, fail, report })。
	constructor(owner: DocumentsOwner) {
		this.label = owner.label;
		this.batch = owner.batch;
		this.context = owner.context;
		this.#owner = owner;
	}

	// 函数说明：为定义创建/复用一个槽并返回本次 attempt 的句柄；输入 definition/token/declarer，返回 HandleOf<D>。
	// 已有同名槽时先 SlotDefinition.check：再次声明必须兼容（keyed/persist/版本/指纹）。
	// 槽与句柄是分离的：槽跨 attempt 存活，句柄每次 attempt 重建，因此旧句柄不会看到新 attempt 的声明。
	/**
	 * A handle to `definition`'s slot for an attempt sealed by `token`, whose `at(key)` pins `declarer` takes: the slot
	 * made by the first declaration of its name, checked against the values for later ones (`SlotDefinition.check`).
	 * "Declared twice" is the attempt's check.
	 */
	// 泛型 D 保留定义的具体类型，返回类型 HandleOf<D> 才能在编译期选 Singleton/Keyed；方法体里类型被擦除。
	declare<D extends StateDefinition<JsonObject, boolean, boolean>>(
		definition: D,
		token: SealToken,
		declarer: KeyDeclarer,
	): HandleOf<D> {
		// 先按定义名查已有槽；名字是槽的身份，同一对象内同名定义共享一个槽。
		const slot = this.#slots.get(definition.name);
		// 已存在则只做兼容检查，不重建：声明不兼容会抛错，让 activation 失败。
		if (slot !== undefined) slot.definition.check(definition);
		// persistence 只在“新建且 persist”时创建；已存在的槽保留自己的 Persistence（地址相同）。
		const persistence = slot === undefined && definition.persist ? this.#persistence(definition.name) : undefined;
		// The definition's `keyed` decides the slot's class and the handle's; its documents are the definition's `T`.
		// keyed 分支：复用或新建 KeyedSlot，再包一层 Keyed（带 token/version/declarer）。
		// `as unknown as HandleOf<D>` 是必要断言：D 的泛型关系无法让 TS 自动收窄到具体句柄类型；运行期没有转换。
		if (definition.keyed) {
			const keyed = slot ?? this.#add(new KeyedSlot(this, definition, persistence));
			// Keyed 构造参数中的 declarer 是 attempt：at(key) 调用的 pin 由它管理。
			return new Keyed(keyed as KeyedSlot, token, definition.version, declarer) as unknown as HandleOf<D>;
		}
		// singleton 分支同理；KeyedSlot 与 SingletonSlot 的构造参数一致（owner/definition/persistence）。
		const singleton = slot ?? this.#add(new SingletonSlot(this, definition, persistence));
		return new Singleton(singleton as SingletonSlot, token, definition.version) as unknown as HandleOf<D>;
	}

	// 函数说明：只做声明检查不创建槽；用于 reload 的 staging（录音式工厂先对现有文档演练一遍）。
	// 不存在同名槽时什么也不做；存在时调用 SlotDefinition.check。
	/**
	 * Checks a declaration of `definition` as `declare` would, changing nothing (a reload's staging: a recording factory
	 * declares against the documents the object has).
	 */
	check(definition: AnyDefinition): void {
		this.#slots.get(definition.name)?.definition.check(definition);
	}

	// 函数说明：提交一次 attempt 的声明结果；输入 declared/pins/context，无返回；可能 drop 未声明槽、迁移声明槽。
	// 先换 pins：新工厂的 pin 生效，上一轮工厂的 pin 全部释放（rule 6）。
	// 声明中的每个槽执行 hydrate：取 initial、迁移旧值、必要时发替换帧；抛错则 activation 失败。
	/**
	 * Takes an attempt's declarations once its factory returned: its `at(key)` pins replace the previous factory's, the
	 * slots it no longer declares are dropped (their watches end; persisted ones load again when declared again), every
	 * declared one hydrated (`initial()`, migrations; a throw fails the activation).
	 */
	hydrate(declared: ReadonlyMap<string, AnyDefinition>, pins: readonly (() => void)[], context: Context): void {
		// 先保存旧 pins 再替换：释放动作必须在槽变更前发生，避免旧 source 指向已 drop 的槽。
		const previous = this.#pins;
		this.#pins = pins;
		// 释放上一轮所有 pin；release 幂等，重复释放安全。
		for (const release of previous) release();
		// A dropped persisted slot goes whole, its loaded documents too: observably the same as keeping them, since
		// every committed write is in the store and a later declaration reloads from there.
		// 未再声明的槽整个丢弃（含已加载文档）：所有已提交写入都在 store，重新声明会重新加载。
		for (const [name, slot] of this.#slots) {
			if (declared.has(name)) continue;
			this.#slots.delete(name);
			slot.drop();
		}
		// 声明中的每个槽 hydrate；`!` 断言槽一定存在（首次声明由 declare 创建，已存在则复用）。
		for (const [name, definition] of declared) this.#slots.get(name)!.hydrate(definition, context);
	}

	// 函数说明：activation 的持久文档加载；输入 context，返回 Promise<void>|undefined；undefined 表示无需等待。
	// 先筛出 persisted 槽；纯内存对象直接返回 undefined，不额外占用一次微任务。
	// 有持久文档时排入对象线，逐个 loadDeclared：singleton 加载本身，keyed 加载 pinned 键。
	/**
	 * Loads, in one line job, every persisted singleton not loaded yet and every pinned key not loaded since it was
	 * pinned (an attempt's activation, before it goes live, rule 6); `undefined` when nothing is persisted. A failure
	 * fails the activation.
	 */
	load(context: Context): Promise<void> | undefined {
		// filter 的结果是新数组；它只包含持久槽，内存槽不参与 activation 加载。
		const persisted = [...this.#slots.values()].filter((slot) => slot.persisted !== undefined);
		// In memory only: nothing to wait for (an activation without persisted documents takes no extra turn).
		// 纯内存对象无需等待：返回 undefined 让 activation 直接继续（不产生额外 turn）。
		if (persisted.length === 0) return undefined;
		// 整个加载循环作为一个对象线任务：期间不会有事务或冷加载插入。
		return this.onLine(async () => {
			for (const slot of persisted) await slot.loadDeclared(context);
		});
	}

	// 函数说明：在对象线上执行 job；输入 job/token，返回 job 结果；拒绝条件见下。
	// 第一次检查在排队前：对象已 seal/end 或句柄 token 已封时立刻抛 released，不占线。
	// await line.acquire() 之后必须再查一次：排队期间对象可能 seal，或 token 被封；这类早先排队的任务也要被拒。
	// finally 保证 release 一定执行，否则后续所有任务会永久卡住。
	// 例：keys() 的分页读取通过 onLine 执行；对象 seal 后正在等待的页读取在拿线时抛 released。
	/**
	 * Runs `job` on the line (a cold load, a page of keys, an eviction sweep); refused `released` once the object is
	 * ending or `token` (the handle's that asks, when the job is one handle's) is sealed, a job queued before either
	 * included (anything taking the line after the seal is refused, rule 4).
	 */
	async onLine<T>(job: () => Promise<T>, token?: SealToken): Promise<T> {
		// 排队前快速拒绝；这里的 `token?.sealed` 用可选链，未传 token（槽级任务）时不检查句柄封条。
		if (this.#state !== "open" || token?.sealed) throw this.released();
		// 等待期间对象可能变化，因此下面还要再检查一次；不能把这里的检查结果当作最终状态。
		const release = await this.line.acquire();
		try {
			// 拿线后的复检：seal 之前已排队的工作也必须被拒，否则会在文档已结束的语义下运行。
			if (this.#state !== "open" || token?.sealed) throw this.released();
			return await job();
		} finally {
			// 无论 job 成功或抛错都释放线；release 幂等，重复调用无副作用。
			release();
		}
	}

	// 函数说明：把 fn 作为一次事务执行并提交；输入 fn/token/context/persistence，返回 fn 的结果。
	// 错误：批次内重入、token 已封、对象结束 → 抛错；fn 抛错或 commit 失败 → 丢弃并抛出；context 已中止且未提交 → 额外报告 transaction_cancelled。
	// persistence 用于 D8：run state 的延迟写入在 commit 时传给 Transaction。
	// 例：await documents.tx(tx => tx.draft(counter).then(d => { d.count++; }), token, ctx) 返回 undefined，提交后 watch 收到一帧。
	/**
	 * Runs `fn` as one transaction on the line under `token` and commits what it drafted (§9): a throw, an abort of
	 * `context`, the token's seal or the object's end discards everything; one that did not commit while `context` was
	 * aborted is also reported (`transaction_cancelled`): an empty `catch` cannot hide a change that never happened.
	 * `persistence` defers storing a run state's change (D8).
	 */
	async tx<R>(
		fn: (tx: Transaction) => R | Promise<R>,
		token: SealToken,
		context: Context,
		persistence?: CommitPersistence,
	): Promise<R> {
		// 拒绝在 adopt/deliver/flush 中开新事务（W1 重入规则）；运行期检查，不在类型层表达。
		this.batch.assertOutside("tx");
		this.assertAdmitted(token);
		// 拿线后才创建 Transaction：Transaction 构造函数会接收 release，cut 时可自行释放线。
		const release = await this.line.acquire();
		const tx = new Transaction(this, token, release, context, persistence);
		// try 覆盖 fn 与 commit；任何一步抛错都走 discard + report + 原样 rethrow。
		try {
			this.assertAdmitted(token);
			this.#holder = tx;
			const result = await fn(tx);
			// In-memory-only commits are synchronous (W12): no await unless the store's step is taken.
			// commit 在纯内存时同步完成并返回 void；只有走 store step 时才返回 Promise（W12），所以用 !== undefined 判断是否 await。
			const step = tx.commit();
			if (step !== undefined) await step;
			return result;
		} catch (error) {
			// 丢弃是幂等的：若已被 fence 切断（状态 cut），discard 直接返回，不会覆盖 cut 状态。
			tx.discard();
			// Only a transaction that did not commit reads this; Chord's own run under contexts that never abort.
			// 只有 context 确实 abort 时才报告取消；普通业务错误不报告，避免把用户异常当成取消。
			// report 的 error 使用 signal.reason（任意值），宿主负责呈现；随后仍把原错误抛给调用者。
			const signal = context.abortSignal;
			if (signal?.aborted)
				this.#owner.report({ kind: "transaction_cancelled", object: this.label, error: signal.reason });
			throw error;
			// 收尾顺序：清 holder → 释放线 → settle staged 变更；release 在前，settle 在释放后同步执行。
			// holder 可能已被 fence 清空，所以用身份比较；settle 让 job 的运行记录知道提交成功或丢弃。
		} finally {
			if (this.#holder === tx) this.#holder = undefined;
			release();
			tx.settle();
		}
	}

	// 函数说明：封住 token 并切断持有该 token 的当前事务；无返回。
	// 先 seal 再检查 holder：即使 holder 不存在，后续新事务也会被 assertAdmitted 拒绝。
	// #cut 只处理“正在持线”的事务；排队中的事务会在拿线后的 assertAdmitted 被拒。
	/**
	 * Seals `token` (the seal fence): its transactions are refused from now on, and the one holding the line is
	 * discarded and the line released.
	 */
	fence(token: SealToken): void {
		token.seal();
		if (this.#holder?.token === token) this.#cut();
	}

	// 对象 end 后所有文档使用都抛 released/ended；seal 不影响读取（文档仍可读）。
	/** Throws `released` once the object ended. */
	assertLive(): void {
		if (this.#state === "ended") throw this.released();
	}

	// 决定“还能不能开始新工作”：token 已封或对象非 open（sealed/ended）都拒绝。
	// 这是 seal fence 的运行时检查；TS 类型不表达封条状态。
	/** Throws `released` once `token` is sealed or the object is ending: no new work takes the line. */
	assertAdmitted(token: SealToken): void {
		if (token.sealed || this.#state !== "open") throw this.released();
	}

	// 转发给宿主：live 对象变成 broken；对象已不 live 时宿主应忽略（契约由宿主实现）。
	/** The live object fails `broken` with `error` (a document the code cannot read); ignored when it is not live. */
	fail(error: ChordError): void {
		this.#owner.fail(error);
	}

	// 函数说明：对象进入结束流程；无返回；副作用是封 own token、切断当前事务，文档仍可读。
	// 幂等：已 seal/end 时直接返回；end 之后调用不会再改状态。
	/** The object is ending: every transaction is refused, the one holding the line discarded; documents stay readable. */
	seal(): void {
		// 只有 open 能进入 sealed；重复 seal 或 end 后的调用都是空操作。
		if (this.#state !== "open") return;
		this.#state = "sealed";
		// 封对象自己的 token，拒绝后续 job outcome 事务；attempt 的 token 由各自的 fence 处理。
		this.own.seal();
		// holder.cut() 对已进入 stepping 的事务无效，所以已获准的 store step 会跑完；其他状态的事务被丢弃。
		this.#cut();
	}

	// 函数说明：等对象线空闲；无返回；seal 后的 teardown 在这里等待已获准 step 完成，保证 adopt 到仍然存在的文档。
	// acquire 后立即 release：拿到线说明之前所有 holder 都已释放；不执行任何工作。
	/**
	 * Resolves once the line is free. After `seal` only an admitted step can hold it (every other holder was cut):
	 * the object's teardown waits here, so the step adopts into documents that still exist (slice 6a §1.3).
	 */
	async settled(): Promise<void> {
		// seal 会 cut 掉非 step 的 holder；因此这里等到的是已获准的 step（或无人持线）。
		const release = await this.line.acquire();
		release();
	}

	// 函数说明：对象彻底结束；无返回；副作用是结束 residency 定时器、drop 所有槽、清 pins。
	// drop 会结束所有 watch（ended），之后任何读取/句柄使用抛 released；不再访问 store。
	// 幂等：重复调用只是再次清空空集合。
	/** Drops every document and pin; watches end `ended`, and every later use throws `released`. */
	end(): void {
		this.#state = "ended";
		// 先停驱逐定时器，再 drop 槽；否则清扫可能在 drop 之后访问已清空的 resident 集合。
		this.residency.end();
		for (const slot of this.#slots.values()) slot.drop();
		this.#slots.clear();
		this.#pins = [];
	}

	// 构造本对象统一的 released/ended 错误；消息含对象标签，便于定位。
	// 返回 ChordError 而不是 throw，调用者决定抛出时机。
	/** The `released` error of this object's documents. */
	released(): ChordError {
		return new ChordError({ code: "released", reason: "ended", message: `${this.label}: ended` });
	}

	// 取走 holder 并切断；先清空引用再 cut，避免 cut 内部重入时看到自己。
	// holder?.cut() 的 ?. 处理没有持线者的情况；cut 自身负责释放线（只释放一次）。
	/** Discards the transaction holding the line and releases the line. */
	#cut(): void {
		// 先保存再清空：cut 可能同步触发 release 并让下一个 holder 进入，不能让它被误清。
		const holder = this.#holder;
		this.#holder = undefined;
		holder?.cut();
	}

	// 以定义当前名字登记槽；返回同一个槽便于构造句柄。
	// 泛型 S 保证调用者拿回具体槽类型（SingletonSlot|KeyedSlot）。
	#add<S extends SingletonSlot | KeyedSlot>(slot: S): S {
		this.#slots.set(slot.definition.current.name, slot);
		return slot;
	}

	// 取宿主 store 并构造 Persistence；owner.store! 的非空断言由 declare 的 persist 条件保证（P3）。
	// namespace 固定为 "chord"：应用状态文档的命名空间；job 的命名空间由 jobs 层另行传入。
	// kind 是定义名，key 由 Persistence.at 决定。
	/** The store side of persisted documents named `name`; the attempt checked the store first (P3). */
	#persistence(name: string): Persistence {
		// 解构出 store 与对象类型名；`!` 是编译期断言，运行期若为 undefined 会在解构时抛 TypeError。
		const { store, owner } = this.#owner.store!;
		// 每次 declare 新建一个 Persistence 对象；它只是地址包装，不持有连接。
		return new Persistence(store, owner, "chord", name);
	}
}
