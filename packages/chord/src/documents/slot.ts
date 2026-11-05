// Document slots (slice 6a §1.2): one per declared document name on its object, across the object's attempts. A slot
// holds the documents' trackers, the version and definition its values are of, what is stored of persisted ones, and
// the watches; each attempt's handles are thin views of it. This file: what every slot is, and the singleton's slot
// (the keyed one is `keyed-slot.ts`).

// 文件导读
// 所属：packages/chord/src/documents，文档槽的共享抽象与单例槽实现。
// 职责边界：槽跨 attempt 持有 tracker/initial/stored/watch；负责定义兼容检查、版本栅栏、hydration、加载、收养与退役；不直接执行 store 写入（交给 Persistence）。
// 上游：Documents.declare/hydrate/load；下游：AddressSource（帧）、Persistence（读写）、Transaction（draft/adopt/retire 的调用面）。
// 结果/错误：check 抛普通 Error（声明不兼容）；value 抛 released/not_ready；load 的 store 错误原样抛出，decode/migrate 错误由调用方包装；adopt 在对象 seal 后仍执行。
// 能力清单：AnyDefinition 宽化定义；DocumentSlot/PersistedSlot 事务接口；SlotDefinition 定义状态与版本栅栏；SingletonSlot 单例实现（value/hydrate/load/stage/adopt/retire/drop）。
// 组合关系：declare（new/复用槽）→ hydrate（取 initial、迁移、发替换帧）→ load（持久 singleton 读 store）→ 事务 draft/adopt/retire → watch 帧。
// 示例：const slot = new SingletonSlot(documents, definition, undefined); slot.hydrate(definition, ctx); slot.value 得到 initial()。
// 阅读顺序：先看 DocumentSlot/PersistedSlot 的契约，再看 SlotDefinition.check/assertVersion，最后看 SingletonSlot 的 hydrate/load/adopt。
// 运行期边界：check 的输入来自插件声明（信任边界）；value 的 not_ready/released 是运行期状态检查；#initial! 等非空断言没有运行时校验。
import type { Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import { type Prepared, type Tracker, track } from "../delta/index.ts";
import type { StagedWrite } from "../store/step.ts";
import { AddressSource } from "./address-source.ts";
import type { CommitPersistence, JsonObject, StateDefinition } from "./definition.ts";
import type { Documents } from "./documents.ts";
import type { SealToken } from "./fence.ts";
import { type DocumentChange, type Persistence, type Stored, type StoredChange, storedAfter } from "./persistence.ts";

// 宽化类型：抹掉值、keyed、persist 的具体类型，便于 Map 与跨定义操作；运行期仍是具体 StateDefinition。
/** A document definition, whatever its value and keyedness. */
export type AnyDefinition = StateDefinition<JsonObject, boolean, boolean>;

// 事务只依赖这组能力：取 tracker、取 initial、收养、退役；singleton 与 keyed 各自实现。
// persisted 为 undefined 表示纯内存文档；持久槽返回自身，从而暴露 PersistedSlot 的冷加载/暂存能力。
/**
 * What a transaction drafts and adopts: documents of one object by key (a singleton ignores the key). The slots of
 * `self.state`, and Chord's own (a job's run state documents).
 */
export interface DocumentSlot {
	readonly owner: Documents;
	/** The tracker of the document at `key`, `undefined` while absent. */
	current(key: string): Tracker<JsonObject> | undefined;
	/** The value a draft of an absent document starts from. */
	initial(context: Context): JsonObject;
	/** The persisted slot's store side; `undefined` for documents in memory only. */
	readonly persisted: PersistedSlot | undefined;
	/** Adopts a commit of the document at `key` (inside the batch), with what the commit stored of it. */
	adopt(
		key: string,
		tracker: Tracker<JsonObject>,
		prepared: Prepared<JsonObject>,
		stored: StoredChange | undefined,
	): void;
	/** Retires the document at `key` (inside the batch). */
	retire(key: string): void;
}

// cold(key)：文档可能存在但不在内存（keyed 未加载）；singleton 永远 false。
// stored(key)：内存已知的存储坐标；stage 把它与事务的 DocumentChange 一起交给 Persistence.stage。
// load(key, context, token?)：调用者持线；token 可让被切断的事务在读完 store 后放弃安装。
/** What a transaction needs of a persisted slot (slice 6a §4, §10). */
export interface PersistedSlot {
	readonly persistence: Persistence;
	readonly definition: SlotDefinition;
	/** Whether the document at `key` may be stored without being in memory (a persisted keyed document not loaded). */
	cold(key: string): boolean;
	/** What is stored of the document at `key` as memory knows it; `undefined` when absent or cold. */
	stored(key: string): Stored | undefined;
	/**
	 * Stages one commit's writes of the document at `key` into `writes` (`was`: what is stored of it, a cold one's as
	 * the transaction found it); `persistence` is the transaction's (a deferred change of a run's state is held, D8).
	 */
	stage(
		key: string,
		change: DocumentChange,
		was: Stored | undefined,
		writes: StagedWrite[],
		persistence: CommitPersistence,
	): StoredChange;
	/**
	 * Loads the document at `key` (its caller holds the line): installed when present and still absent from memory,
	 * and, for a transaction's load (`token`), while the token is not sealed (a cut transaction released the line, so
	 * a successor may have changed or retired the key meanwhile).
	 */
	load(key: string, context: Context, token?: SealToken): Promise<void>;
}

// 例：同一个名字的槽第一次由 v1 定义创建，第二次 attempt 用 v2 定义 hydrate；#current 变成 v2，旧句柄的 assertVersion(1) 抛错。
/**
 * The definition a slot's values are of (the one that hydrated it last; the first declaration until then): the checks
 * of a new attempt's declaration and the old handles' version fence (R15).
 */
export class SlotDefinition {
	// #current 是最近一次 hydrate 的定义，也是 check/版本栅栏比较的基准；#hydrated 区分“第一次声明”与“已水合”。
	#current: AnyDefinition;
	#hydrated = false;

	// 函数说明：以首个定义初始化；无输出。例：new SlotDefinition(definitionV1)。
	constructor(definition: AnyDefinition) {
		this.#current = definition;
	}

	// 返回当前定义；调用者据此拿 name/version/initial。
	/** The definition the values are of. */
	get current(): AnyDefinition {
		return this.#current;
	}

	// 返回水合过的定义；首次声明后、首次 hydrate 前为 undefined，用于判断是否需要迁移/发替换帧。
	/** The definition the values were hydrated with, `undefined` before the first hydration. */
	get hydrated(): AnyDefinition | undefined {
		return this.#hydrated ? this.#current : undefined;
	}

	// 函数说明：验证新 attempt 的声明与已有文档兼容；成功无返回，失败抛普通 Error（activation 失败 broken）。
	// 输入来自插件调用 defineState 的声明，是信任边界；四类不兼容：keyed 翻转、persist 翻转、旧版本、同版本不同指纹。
	// 例：已有 keyed 文档，新代码声明为 singleton → 抛 declared singleton...；这阻止同一存储被两种形状解释。
	// 声明版本更旧说明运行的是旧代码，而内存值已被新代码迁移；拒绝而不是降级，避免旧代码写坏新形状。
	// 同版本不同指纹是 schema 改了没升版本；加载路径也会拒绝（checkReadable），这里提前在声明时拒绝。
	/**
	 * Checks a declaration of this name by a new attempt: a flipped `keyed` or `persist`, a version older than the values (old code)
	 * or the same version with another fingerprint (a schema changed without a bump) throw (the attempt fails broken).
	 */
	check(definition: AnyDefinition): void {
		// 解构后逐个比较：比较对象是 #current（上一次水合/首次声明），不是传进来的 definition。
		const { name, version, keyed, persist, fingerprint } = this.#current;
		if (definition.keyed !== keyed) {
			throw new Error(`${name}: declared ${definition.keyed ? "keyed" : "singleton"}, its documents are not`);
		}
		if (definition.persist !== persist) {
			throw new Error(`${name}: declared ${definition.persist ? "persisted" : "in memory"}, its documents are not`);
		}
		if (definition.version < version) {
			throw new Error(`${name}: version ${definition.version} is older than its documents' (${version})`);
		}
		if (definition.version === version && definition.fingerprint !== fingerprint) {
			throw new Error(`${name}: the schema changed without a version bump (version ${version})`);
		}
	}

	// 函数说明：记录本次 attempt 实际水合的定义；输入 definition，无返回；不迁移值（迁移由槽实现）。
	// #current 更新后，旧句柄的 assertVersion 会看到新版本并抛 released/version。
	/** Records the hydration with `definition`. */
	hydrate(definition: AnyDefinition): void {
		this.#current = definition;
		this.#hydrated = true;
	}

	// 函数说明：句柄版本栅栏；输入句柄声明版本，成功无返回，失败抛 ChordError。
	// 相等直接通过；句柄更旧 → released/version（旧代码不能读新形状）；句柄更新 → not_ready（新代码等 activation 迁移）。
	// 例：迁移到 v2 后，v1 句柄读 value 抛 released；v2 句柄在迁移前读抛 not_ready。
	// 版本号比较是运行期检查：定义来自插件，TS 类型不携带这个不变量。
	/**
	 * Throws `released` for a handle of `version` once the values migrated past it (old code reads no new shape), and
	 * `not_ready` for a handle of a newer version until its activation migrated them (new code reads no old shape: a
	 * retry's factory).
	 */
	assertVersion(version: number): void {
		const current = this.#current;
		if (version === current.version) return;
		const message = `${current.name}: a handle of version ${version}; the documents are at version ${current.version}`;
		if (version < current.version) throw new ChordError({ code: "released", reason: "version", message });
		throw new ChordError({ code: "not_ready", message: `${message} until the activation migrates them` });
	}
}

// 例：声明一次、从未写入的 singleton 读 initial；写入后 tracker 存在；retire 后 tracker 清空又读 initial。
// 持久 singleton 每个对象生命周期只加载一次；加载失败时 #loaded 保持 false，下次 activation 重试。
/**
 * A singleton's slot: one tracker while written, `initial()` while absent; the source its handles and members watch.
 * Persisted, it loads once per object (again after a failed load) and stays in memory while the object lives.
 */
export class SingletonSlot extends AddressSource implements DocumentSlot, PersistedSlot {
	// persisted 指向自身，让事务看到 PersistedSlot 接口；#persistence 是实际实现，内存文档中为 undefined。
	// #initial 在 hydrate 时取一次；#tracker 只在有写入/加载值时存在；#stored 是 store 坐标；#loaded 区分未加载与已加载（不存在也算已加载）。
	readonly owner: Documents;
	readonly definition: SlotDefinition;
	readonly persisted: PersistedSlot | undefined;
	readonly #persistence: Persistence | undefined;
	/** `initial()`, taken at hydration; `undefined` before the first. */
	#initial: JsonObject | undefined;
	#tracker: Tracker<JsonObject> | undefined;
	/** What is stored of it (persisted); `undefined` while absent. */
	#stored: Stored | undefined;
	/** In memory: always; persisted: once loaded. */
	#loaded: boolean;

	// 函数说明：super(owner.batch) 让 Source 能把变化登记进 host 的批次；内存文档直接 loaded，持久文档等 load。
	// 不在此读取 store；加载发生在 activation 的 loadDeclared，且由对象线串行。
	constructor(owner: Documents, definition: AnyDefinition, persistence: Persistence | undefined) {
		super(owner.batch);
		this.owner = owner;
		this.definition = new SlotDefinition(definition);
		this.#persistence = persistence;
		this.persisted = persistence === undefined ? undefined : this;
		this.#loaded = persistence === undefined;
	}

	// 仅在 persisted !== undefined 的路径上被调用；`!` 是非空断言，运行期不检查，所以不能从外部随意调用。
	get persistence(): Persistence {
		// Only reached through `persisted`, which a persisted slot alone has.
		return this.#persistence!;
	}

	// 函数说明：读当前值；错误：对象已结束 → released/ended；未水合或持久文档未加载 → not_ready。
	// 例：工厂里在 hydration 前读 self.state 的 singleton 会抛 not_ready；对象结束后读抛 released。
	// 有 tracker 用 tracker.value，否则用 hydration 时的 initial；返回的是文档值引用，不复制。
	get value(): JsonObject {
		this.owner.assertLive();
		if (this.#initial === undefined || !this.#loaded) {
			const message = `${this.definition.current.name}: read before activation`;
			throw new ChordError({ code: "not_ready", message });
		}
		return this.#tracker?.value ?? this.#initial;
	}

	// 函数说明：接收本次 attempt 的定义并更新内存值；输入 definition/context，无返回；可能迁移、换 initial、发替换帧。
	// 同版本只更新 SlotDefinition，保留 tracker/stored/initial（重试不需要迁移）。
	// before 只在“之前已水合并已加载”时取旧值；首次 hydrate 或未加载时为 undefined，避免读到 not_ready。
	// tracker 的两种情况：没有 tracker 或首次水合时保持现有 tracker（通常就是 undefined）；否则把现有值 migrate 成新的 tracker。
	// `#initial = definition.initial(context)` 每次升版都重新取；旧 initial 不再使用。
	// 最后若之前有可读旧值，batch.commit(() => this.replaced(), context) 在 adopt 阶段登记整根替换帧。
	/**
	 * Takes the attempt's declaration `definition` (`check` accepted it): the first takes `initial()`; a newer version
	 * migrates the value in memory (a persisted one stores a base with its next change) and takes `initial()` again,
	 * and a value that changed reaches watches as a root replacement; the same version keeps everything.
	 */
	hydrate(definition: AnyDefinition, context: Context): void {
		const from = this.definition.hydrated;
		// 同版本是常见路径：只换定义引用，不动 tracker；这也让重试 attempt 不产生 watch 帧。
		if (from !== undefined && from.version === definition.version) {
			this.definition.hydrate(definition);
			return;
		}
		// 三元表达式同时表达两个条件：从未水合或尚未加载时没有可读旧值，不能调用 this.value（会抛 not_ready）。
		const before = from === undefined || !this.#loaded ? undefined : this.value;
		const tracker =
			this.#tracker === undefined || from === undefined
				? this.#tracker
				: track(definition.migrate(this.#tracker.value, from.version, context));
		this.#initial = definition.initial(context);
		this.#tracker = tracker;
		this.definition.hydrate(definition);
		if (before !== undefined) this.batch.commit(() => this.replaced(), context);
	}

	// 函数说明：从 store 加载 singleton；输入 key（忽略）/context，无返回；错误原样向外抛。
	// 已加载（含“存储中不存在”）直接返回；读失败不会把 #loaded 置真，因此下次加载会重试。
	// decode 的迁移/校验错误也向外抛；activation 会把它当作失败处理。
	// 文档不存在时只把 #loaded 置真，不创建 tracker，读值仍走 initial。
	/** Loads the persisted document unless it is loaded already (the caller holds the line). */
	async load(_key: string, context: Context): Promise<void> {
		if (this.#loaded) return;
		const document = await this.persistence.read("", context);
		// Singletons load at activation, on the line: what the code cannot read fails the activation.
		const loaded =
			document === undefined ? undefined : this.persistence.decode(document, this.definition.current, context);
		if (loaded !== undefined) {
			this.#tracker = track(loaded.value);
			this.#stored = loaded.stored;
		}
		this.#loaded = true;
	}

	/** Loads the persisted document unless it is loaded already (activation, holding the line). */
	// 函数说明：activation 的统一入口；持线调用 load("", context)；singleton 没有键。
	loadDeclared(context: Context): Promise<void> {
		return this.load("", context);
	}

	/** A singleton has one document: its key is always `""`. */
	// singleton 的键恒为空串；文档地址因此不带 key 字段。
	key(_key: string): string {
		return "";
	}

	// singleton 加载后常驻内存，不存在“冷”状态。
	cold(_key: string): boolean {
		return false;
	}

	// 返回内存已知的存储坐标；纯内存文档与未持久化值为 undefined。
	stored(_key: string): Stored | undefined {
		return this.#stored;
	}

	// 函数说明：把一个提交的改动交给 Persistence.stage；输入 key/change/was/writes，返回 StoredChange。
	// 这里不传 held：singleton 的延迟写入由 run state 自己的路径处理，普通状态用默认 immediate。
	stage(key: string, change: DocumentChange, was: Stored | undefined, writes: StagedWrite[]): StoredChange {
		return this.persistence.stage(key, this.definition.current, was, change, writes);
	}

	// 返回文档 tracker；没有写入/加载值时为 undefined，草拟会从 initial 开始。
	current(_key: string): Tracker<JsonObject> | undefined {
		return this.#tracker;
	}

	// 返回 hydration 时取好的 initial；`!` 断言它已存在（调用前必须已 hydrate）。
	// 例：新建 singleton 的第一笔写入从该值开始，而不是重新调用用户工厂。
	/** The value a draft of the absent document starts from: the `initial()` taken at hydration. */
	initial(_context: Context): JsonObject {
		return this.#initial!;
	}

	// 函数说明：收养一次已准备的提交；输入 tracker/prepared/stored，无返回；副作用是换 tracker、更新 stored、发帧。
	// 注释说明不检查对象存活：store 步骤可能在对象 seal 后才执行 adopt，这是 slice 6a §1.3 允许的。
	// before 取收养前的值（tracker 或 initial）；tracker.adopt(prepared) 是 Delta 的指针交换，之后 tracker.value 为新值。
	// written(before, prepared) 生成 watch 帧；ops 是否可用由 AddressSource 根据 prepared.base === before 判定。
	adopt(
		_key: string,
		tracker: Tracker<JsonObject>,
		prepared: Prepared<JsonObject>,
		stored: StoredChange | undefined,
	): void {
		// Unchecked: a step admitted before the object ended adopts after its seal (slice 6a §1.3).
		const before = this.#tracker?.value ?? this.#initial!;
		tracker.adopt(prepared);
		this.#tracker = tracker;
		this.#stored = stored === undefined ? undefined : storedAfter(stored);
		this.written(before, prepared);
	}

	/** Retires the document: it reads `initial()` again, and the frame says it was retired. */
	// 函数说明：退役文档；无输入，无返回；副作用是清空 tracker/stored 并发出 retired 帧。
	// 之后再有草拟会重新从 initial 开始；持久文档的下一次写入会存 base（stored 已清）。
	retire(_key: string): void {
		this.#tracker = undefined;
		this.#stored = undefined;
		this.retired(this.#initial!);
	}

	/** Its object ended or no attempt declares it any more: the document goes and its watches end. */
	// 函数说明：对象结束或本次 attempt 不再声明该文档；清内存并结束 watch（watch 收到 ended，而非 retired）。
	// 不写 store：持久文档仍在磁盘，重新声明时会重新加载。
	drop(): void {
		this.#tracker = undefined;
		this.#stored = undefined;
		this.endWatches();
	}
}
