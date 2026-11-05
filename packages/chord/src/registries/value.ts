// Registry values (slice 8 §1 "Reading", S2, S3): a registry's composed value as the readers of one version see it, a
// native source. The provider's version reads the composition itself; an older one reads it mapped back with
// `accepts[old].value`, once per composition, kept only while someone reads or follows it; a version the provider
// cannot serve fails `contract_mismatch`. Its readers (attempts that declared it) keep the mapping; its waiters
// (attempts parked on it, a waiting `host.registry`) are woken at every change of whether it is usable, and of its
// failure while it is not (dependency model §9); waited for while it is not, it is on the host's `UnboundClock`.

// 文件导读
// 所属包与模块：packages/chord/src/registries 的值源模块（slice 8 §1 “Reading”，S2/S3）。
// 职责边界：把某版本的合成值包装成原生 source，处理版本透传/降级映射、reader 与 waiter 的登记和唤醒、
// 关闭时的清理；不执行 compose（RegistryRecord 负责），不定义 token。
// 上游：RegistryRecord.value(version) 创建并缓存；record 标脏时调用 recomposed/relisted。
// 下游：watch/observe 经 FollowedSource 收到值；waiter（parked attempt、host.registry）通过 dependencyMoved
// 唤醒；无值等待登记在 host 的 UnboundClock（超时/关闭由 host 处理）。
// 错误流向：provider 版本更低或缺少适配器 -> contract_mismatch；映射抛错 -> registry_failed（每周期一次，
// 保留旧映射）；host 关闭 -> waiters 收到 released/closed。
// 能力清单：
// - RegistryWaiter（接口）：dependencyMoved 与 closed 两个回调。
// - RegistryValueSource（类）：值源实现，含 value/start/current/watched/read/wait/recomposed/relisted/close。
// 组合关系与典型调用顺序：record.value(v) -> new RegistryValueSource -> 读者 read() 或 waiter wait() ->
// start() -> record.start() -> 版本分派 -> #mappedStart -> 投递；表变化 -> recomposed/relisted；host.close -> close。
// 示例（真实签名）：const value = record.value(1); const release = value.read();
// const stop = value.wait({ dependencyMoved() {}, closed(error) {} }); await value.watch(context);
// 建议阅读顺序：先读 RegistryWaiter/Mapped/MapFailure/Registered 类型，再看 value/start/current/watched，
// 接着 read/wait，然后 recomposed/relisted/close，最后 #tell 与两个私有映射方法。

import { ChordError, isChordError } from "../data/index.ts";
import { asChordError } from "../data/internal.ts";
import { type Batch, FollowedSource, type NativeStart } from "../state/internal.ts";
import type { RegistryContribution } from "./contribution.ts";
import type { RegistryRecord } from "./record.ts";

/** Who waits for a registry's value (a parked attempt, a `host.registry`): told when it may have changed. */
// 等待者接口：dependencyMoved 在批次内调用，只能记录/转发；
// closed 表示 host 关闭，错误固定为 released/closed，等待到此结束。
export interface RegistryWaiter {
	/** The value may have changed (inside its batch: it only records). */
	dependencyMoved(): void;
	/** The value closed with its host: the wait ends with `error` (`released/closed`). */
	closed(error: ChordError): void;
}

// 共享的“可用”状态对象，避免每次通知分配。
const USABLE = { kind: "usable" } as const;

/** Whether two failures say the same: the same error, or ChordErrors alike (a version mismatch is made per read). */
// 身份相同直接为真；否则要求双方都是 ChordError 且 code/reason/message 相同。
// 版本不匹配错误每次读取都会新建，因此不能只靠引用比较，否则会反复唤醒等待者。
function sameError(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	return isChordError(a) && isChordError(b) && a.code === b.code && a.reason === b.reason && a.message === b.message;
}

/**
 * The last good mapping for an older version, the composition it was made from, and the contributions that composition
 * was built from (kept only while all are in the table, decision 5).
 */
// 映射缓存：from 是原始合成值（按身份比较），map 是适配函数（reload 后可能换一个，需重映射），
// value 是结果；contributions 是原合成来源，用于判断映射是否仍有效。
type Mapped = {
	readonly from: unknown;
	/** The adapter it was made with: a reload's provider brings another, which maps again. */
	readonly map: (current: never) => unknown;
	readonly value: unknown;
	readonly contributions: readonly RegistryContribution[] | undefined;
};

/** A failed mapping of composition `from` by `map`, until another composition or adapter maps. */
// 映射失败缓存：同一 from+map 失败期间不重复调用适配器，也不重复上报。
type MapFailure = { readonly from: unknown; readonly map: (current: never) => unknown; readonly error: unknown };

/**
 * Where a value's registry stands for it: on the host, or closed with the host (its last start kept, the record let
 * go, so a value an app keeps keeps no closed host).
 */
// 判别联合：open 持有 record；closed 只保留最后一次 start，并释放 record 引用（避免应用长期持有已关闭 host）。
type Registered =
	| { readonly kind: "open"; readonly record: RegistryRecord }
	| { readonly kind: "closed"; readonly last: NativeStart<unknown> };

/** One version's view of a registry's composed value. */
// 继承 FollowedSource：复用 watch/observe/批次投递。额外维护 readers、waiters、映射缓存与通知状态。
export class RegistryValueSource extends FollowedSource<unknown> {
	readonly name: string;
	readonly version: number;
	#registered: Registered;
	/** Its readers, each a token of its own (one object may read twice), until released. */
	// 用不透明 token 而不是调用对象做键：同一 attempt 可能多次 read，每次释放互不影响。
	readonly #readers = new Set<object>();
	/** Its waiters, each a token of its own, until released. */
	readonly #waiters = new Set<{ readonly waiter: RegistryWaiter }>();
	/**
	 * What its waiters were last told: usable (a value, or a failure with a last good one), or the error it has none
	 * for; a change wakes them.
	 */
	// 上次通知状态，用于抑制重复唤醒；undefined 表示“尚无通知基准”，第一次 start 不唤醒任何人。
	#told: { readonly kind: "usable" } | { readonly kind: "failed"; readonly error: unknown } | undefined;
	#mapped: Mapped | undefined;
	#mapFailure: MapFailure | undefined;

	// 构造：保存记录引用与版本，批次交给父类；不读取合成值、不登记 reader/waiter。
	// 示例：new RegistryValueSource(record, 1, batch)。
	constructor(record: RegistryRecord, version: number, batch: Batch) {
		super(batch);
		this.name = record.name;
		this.version = version;
		this.#registered = { kind: "open", record };
	}

	/** The composition (or its mapping) at its last good value; throws the failure when there is none. */
	// 读者读取入口：有值返回值；失败且无 last 时抛错；有 last 时返回旧好值（读者不必处理瞬时失败）。
	// 示例：const value = record.value(1).value; 失败且没有旧好值时这里抛出 ChordError。
	get value(): unknown {
		const start = this.start();
		if (start.kind === "value") return start.value;
		if (start.last === undefined) throw start.error;
		return start.last.value;
	}

	/**
	 * Its composition (mapped for an older version), composed now if its table changed; a change of whether it is
	 * usable, or of its failure while it is not, wakes its waiters.
	 */
	// 覆写 start：closed 时直接返回保存的 last；否则向 record 拉取（可能触发惰性合成）。
	// 有 waiter 时用 #tell 比较并唤醒；start 本身不抛错（把失败作为 NativeStart 返回）。
	// 示例：const start = source.start(); start.kind === "value" 时读取 start.value，否则读取 start.error。
	override start(): NativeStart<unknown> {
		const registered = this.#registered;
		if (registered.kind === "closed") return registered.last;
		const start = this.#start(registered.record);
		if (this.#waiters.size > 0) this.#tell(start, registered.record);
		return start;
	}

	/** Its composition (or mapping) now; throws while it is failed, though `.value` keeps the last good one. */
	// 与 value 的区别：失败时即使有旧好值也抛错。供贡献合成使用（失败必须让下游感知）。
	// 示例：try { source.current() } catch (error) { /* 值当前不可用 */ }
	override current(): unknown {
		const start = this.start();
		if (start.kind === "failed") throw start.error;
		return start.value;
	}

	/** Followed while someone watches or observes it, and while waiters wait on it. */
	// 覆写 watched：waiters 也算跟随者，使合成在有人等待时也会被拉取。
	// 示例：只有 parked attempt 在 wait 时 source.watched 仍为 true，注册表不会停止合成。
	override get watched(): boolean {
		return super.watched || this.#waiters.size > 0;
	}

	/** Registers a reader (an attempt that declared it) until the returned release: its mapping is kept meanwhile. */
	// 登记 reader token；返回释放函数。释放后若既无 readers 也无 watch/observer，就丢弃映射缓存
	// （下次读取再映射），避免长期持有旧合成值。
	// 示例：const release = source.read(); 使用完后 release(); 旧版本映射可能在释放后重算。
	read(): () => void {
		const token = {};
		this.#readers.add(token);
		return () => {
			this.#readers.delete(token);
			// super.watched 只算 watch/observer；waiters 不计入，因为等待者不需要保留旧映射。
			if (this.#readers.size === 0 && !super.watched) this.#dropMapping();
		};
	}

	/**
	 * Registers `waiter` (a parked attempt's object, a waiting `host.registry`) until the returned release: it is told
	 * of every change of whether this value is usable (inside the batch that made it: it only records).
	 */
	// 登记 waiter token；第一个等待者到来时清空 #told，使下一次 start 建立新基准（但不唤醒它，由它自己读取）。
	// 释放：若仍有等待者则只移除；否则清空通知状态并停止 UnboundClock 上的登记。
	// 示例：const release = source.wait({ dependencyMoved() {}, closed(error) {} }); 等待结束后 release()。
	wait(waiter: RegistryWaiter): () => void {
		const token = { waiter };
		if (this.#waiters.size === 0) this.#told = undefined;
		this.#waiters.add(token);
		return () => {
			this.#waiters.delete(token);
			if (this.#waiters.size > 0) return;
			this.#told = undefined;
			const registered = this.#registered;
			// 只在仍开放时访问 clock；closed 值源的 record 已释放。
			if (registered.kind === "open") registered.record.clock.stop(this);
		};
	}

	/** The registry's table changed (inside a batch): its dependents are marked, its followers get the next frame. */
	// 表从 clean 变脏：标脏依赖者并排帧（changed 同时做两件事）。
	// 示例：record.add(contribution) 之后，本批内对该值源调用 recomposed()。
	recomposed(): void {
		this.changed();
	}

	/**
	 * The registry's table changed again while not composed since (inside a batch): its dependents are marked already
	 * (none read it meanwhile, or it would be composed); its followers get the next frame. Marking stops here, so a
	 * cycle of registries through their values ends.
	 */
	// 已脏期间再次变化：只排帧，不再标脏依赖者；否则注册表互相依赖时标记会无限循环。
	// 示例：同一批内第二次 record.add(...) 导致表再变化时，record 对该值源调用 relisted()。
	relisted(): void {
		this.list();
	}

	/** The host closed: its watches and observers end, its readers and mapping go; it keeps its last start only. */
	// 关闭流程：先取最后一次 start（可能抛循环错误）作为 closed 状态的返回值；
	// 停止时钟、释放 record 引用、清空 readers、通知 waiters closed、清空通知状态与映射、结束 watch/observer。
	// 示例：host 关闭时自动调用；之后 source.start() 返回关闭前保存的 last，不再触发合成。
	close(): void {
		const registered = this.#registered;
		let last: NativeStart<unknown>;
		try {
			last = this.start();
		} catch (error) {
			// start 理论上只在循环读取时抛错；转成 failed 保存，保证 closed 状态可安全返回。
			last = { kind: "failed", error, last: undefined };
		}
		// After the last start, which a waiter put on the clock again.
		// 上面的 start 可能重新登记了 UnboundClock，因此在这里再停一次。
		if (registered.kind === "open") registered.record.clock.stop(this);
		this.#registered = { kind: "closed", last };
		this.#readers.clear();
		const waiters = [...this.#waiters];
		this.#waiters.clear();
		const error = new ChordError({ code: "released", reason: "closed", message: `registry ${this.name}: closed` });
		for (const { waiter } of waiters) waiter.closed(error);
		this.#told = undefined;
		this.#dropMapping();
		// 结束父类的 watch/observer。
		this.end();
	}

	/** Nobody follows it: without readers, its mapping goes (computed again on the next read). */
	// 父类在无 watch/observer 时调用；若仍有 reader（声明使用），必须保留映射。
	// 示例：最后一个 watch 停止且没有 reader 时，映射缓存被丢弃，下次读取重新调用适配器。
	protected override unfollowed(): void {
		if (this.#readers.size === 0) this.#dropMapping();
	}

	/**
	 * Wakes the waiters when `start` says something else than they were told (by usability, then by the error); while
	 * it is not usable, the wait is on its host's clock (`record.clock`).
	 */
	// 通知规则：
	// - 可用（有值，或失败但有 last 好值）：与上次同为 usable 则不动；否则置 USABLE 并停止时钟；
	// - 不可用（失败且无 last）：错误与上次相同时不动；否则更新状态与时钟（已登记则更新错误，否则新建登记）；
	// - 第一次建立基准（told === undefined）不唤醒任何 waiter，由 waiter 自己读取；
	// - 状态确实变化时逐个调用 dependencyMoved。
	// 示例：值从可用变为 contract_mismatch 时，每个登记 waiter 的 dependencyMoved() 各调用一次。
	#tell(start: NativeStart<unknown>, record: RegistryRecord): void {
		const told = this.#told;
		if (start.kind === "value" || start.last !== undefined) {
			if (told?.kind === "usable") return;
			this.#told = USABLE;
			record.clock.stop(this);
		} else {
			if (told?.kind === "failed" && sameError(told.error, start.error)) return;
			this.#told = { kind: "failed", error: start.error };
			const label = `registry ${this.name}`;
			// 非 ChordError 包装为 unavailable 并保留 cause；ChordError 原样使用。
			const error = asChordError(start.error, label);
			if (told?.kind === "failed") record.clock.failed(this, error);
			else record.clock.start(this, label, error);
		}
		// The first start of a wait wakes nobody: the waiter reads it itself.
		if (told === undefined) return;
		for (const { waiter } of this.#waiters) waiter.dependencyMoved();
	}

	// 丢弃映射缓存与映射失败缓存；下一次读取重新映射。
	// 示例：reader 全部释放后再次读取旧版本时，适配器会重新执行一次。
	#dropMapping(): void {
		this.#mapped = undefined;
		this.#mapFailure = undefined;
	}

	// 版本分派：
	// - 无 provider 或版本相同：直接使用 record 的合成（无 provider 时 record.start 返回 undeclared 失败）；
	// - provider 版本更高：需要 accepts[reader].value 适配器；
	// - provider 版本更低（读者比提供者新）或缺少适配器：contract_mismatch。
	// 示例：读者版本 1、provider 版本 2 且有 accepts[1].value 时转到 #mappedStart。
	#start(record: RegistryRecord): NativeStart<unknown> {
		const provided = record.providedVersion;
		if (provided === undefined || provided === this.version) return record.start();
		const map = provided > this.version ? record.valueAdapter(this.version) : undefined;
		if (map === undefined) {
			const message = `registry ${this.name}: version ${this.version} is not served here (version ${provided} is)`;
			return { kind: "failed", error: new ChordError({ code: "contract_mismatch", message }), last: undefined };
		}
		return this.#mappedStart(record, record.start(), map);
	}

	/**
	 * The composition `current` mapped back with `map`, once per composition; a throwing mapping fails this version
	 * only (reported once per episode), keeping its last good mapping; a composition mapped before heals it.
	 */
	// 映射流程：
	// 1) 合成失败且没有好值：没有可映射内容，原样返回（contract_mismatch 等版本问题也走这里）；
	// 2) 取原始合成值 from（或失败时的 last 好值）；
	// 3) 决策 5：旧映射的来源贡献若已离开表，丢弃映射；
	// 4) 命中 from+map 缓存：清除映射失败缓存（自愈）；
	// 5) 未命中且不是同一 from+map 的失败：调用适配器；成功缓存 mapped 及其来源贡献，失败缓存 mapFailure；
	// 6) 组装 NativeStart：映射失败优先；否则合成失败保留 last 好映射值；否则返回值。
	// 示例：provider v2 的合成值经 accepts[1].value 映射成 v1 形状后返回给版本 1 的读者。
	#mappedStart(
		record: RegistryRecord,
		current: NativeStart<unknown>,
		map: (current: never) => unknown,
	): NativeStart<unknown> {
		if (current.kind === "failed" && current.last === undefined) return current;
		const from = current.kind === "value" ? current.value : current.last!.value;
		// `undefined` is a composition too: the records, not their fields, say whether there is one.
		// A mapping built from a contribution that left is no last good value any more (decision 5).
		if (this.#mapped?.contributions !== undefined && !record.inTable(this.#mapped.contributions)) {
			this.#mapped = undefined;
		}
		const mapped = this.#mapped;
		const failure = this.#mapFailure;
		if (mapped !== undefined && mapped.from === from && mapped.map === map) {
			// 同一合成/适配器已成功映射：这次成功结束之前的映射失败周期。
			this.#mapFailure = undefined;
		} else if (failure === undefined || failure.from !== from || failure.map !== map) {
			try {
				// 适配器在 record.adapt 中运行（count 计数 + compute 重入保护）。
				const value = record.adapt(() => map(from as never));
				this.#mapped = { from, map, value, contributions: record.composedFrom };
				this.#mapFailure = undefined;
			} catch (error) {
				// 同一失败周期只上报一次；错误缓存到 from+map 变化为止。
				if (failure === undefined) record.failed(error);
				this.#mapFailure = { from, map, error };
			}
		}
		// 有成功映射才有 last；undefined 表示读者没有可用的旧值。
		const last = this.#mapped === undefined ? undefined : { value: this.#mapped.value };
		if (this.#mapFailure !== undefined) return { kind: "failed", error: this.#mapFailure.error, last };
		if (current.kind === "failed") return { kind: "failed", error: current.error, last };
		// 合成成功且映射成功：last 必存在，! 是内部不变量断言。
		return { kind: "value", value: last!.value };
	}
}
