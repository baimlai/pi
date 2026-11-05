// Keyed slots (slice 6a §1.2, §4, §10, §11): the documents of one keyed name on one object, by key. In memory, every
// present document stays; persisted, a document is loaded on demand (a cold read is a job on the object's line, one
// load in flight per key, shared) and leaves memory when unpinned and idle for the retention (`residency.ts`). A key
// read through `at(key)` or a watch has its own source, which exists while the key is pinned.

// 文件导读
// 所属：packages/chord/src/documents，键控文档槽（keyed documents 的核心存储与驻留）。
// 职责边界：管理每个 key 的 Resident（内存值）、KeySource（pin 后的可观察源）与共享冷加载；负责 key 规范化、版本迁移、按需加载、退役/驱逐；不直接拼 SQL（交给 Persistence）。
// 上游：Documents.declare 建槽；Keyed 句柄的 get/keys/watch/at 与 Transaction.draftSlot/retire 进入；下游：Persistence、Residency、AddressSource/Batch。
// 结果/错误：非法 key 抛 invalid/args；封条拒绝抛 released/ended；未加载读取抛 not_ready；decode/migrate 失败让对象 broken 并抛出；store 错误原样传播。
// 能力清单：Access 读身份；SharedLoad 进行中加载；KEYS_PAGE 分页大小；KeyedSlot 槽实现；KeySource 每个 pinned key 的源。
// 组合关系：get 命中内存 → touch；未命中 persisted → 共享冷加载（对象线）→ Resident；工厂 at(key) → pin → KeySource；提交 adopt → 更新 Resident 并写 source 帧；长期未用 → Residency 驱逐。
// 示例：const items = self.state(itemsDef); const v = await items.get("a", ctx); for await (const key of items.keys(ctx)) { ... }。
// 阅读顺序：先看 Access/SharedLoad 与三个 Map，再看 get/keys/watch/pin/load，最后看 hydrate/#loadShared/#startLoad 与 KeySource。
// 不变量：一个 key 至多一个 Resident、一个 KeySource、一个进行中的共享加载；安装/迁移都在对象线上串行。
import { awaitWithContext, type Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import { asChordError } from "../data/internal.ts";
import { type Prepared, type Tracker, track } from "../delta/index.ts";
import type { StagedWrite } from "../store/step.ts";
import { compareText, storedText } from "../store/text.ts";
import type { Watch } from "../watch.ts";
import { AddressSource } from "./address-source.ts";
import type { JsonObject } from "./definition.ts";
import type { Documents } from "./documents.ts";
import type { SealToken } from "./fence.ts";
import {
	type DocumentChange,
	type Loaded,
	type Persistence,
	type Stored,
	type StoredChange,
	storedAfter,
} from "./persistence.ts";
import { Resident } from "./residency.ts";
import { type AnyDefinition, type DocumentSlot, type PersistedSlot, SlotDefinition } from "./slot.ts";

// Access 是读请求的身份：哪个 attempt 的封条（用于拒绝已封句柄）与句柄定义版本（R15）。
// 句柄类把自身（token+version）作为 Access 传入，避免槽依赖具体句柄类型。
/** Whom a read is for: a handle's seal token and the version it was declared with (R15). */
export type Access = { readonly token: SealToken; readonly version: number };

// 共享加载：done 是所有等待者共同等待的 Promise；tokens 收集等待者句柄；refused 在加载真正拿线时确定。
// refused === undefined 表示还没拿线；拿线后若所有 token 都已封，加载直接以 released 结束（不读 store）。
// 只记录 token 不记录调用者：多个句柄可共享同一加载；被拒的判断是 token 是否在 refused 集合。
/**
 * A cold load in flight, shared by its waiters: their handles' tokens, and those already sealed when the load took
 * the line (`undefined` until then), whose waiters it refuses (rule 4).
 */
type SharedLoad = {
	readonly done: Promise<void>;
	readonly tokens: Set<SealToken>;
	refused: ReadonlySet<SealToken> | undefined;
};

// 键分页大小：每次 store 查询最多 100 个键；keys() 循环直到不足一页。
/** The keys `keys(ctx)` reads per page from the store. */
const KEYS_PAGE = 100;

// 例：persisted keyed 文档 items：内存里 a/b 两个 Resident；工厂 at("a") pin 住 a；一次 get("c") 触发共享冷加载；未 pin 的 b 在 10 分钟后可被驱逐。
/** A keyed slot: one resident per document in memory, one source per pinned key. */
export class KeyedSlot implements DocumentSlot, PersistedSlot {
	readonly owner: Documents;
	readonly definition: SlotDefinition;
	readonly persisted: PersistedSlot | undefined;
	readonly #persistence: Persistence | undefined;
	// #residents 保存内存中的文档；#sources 保存被 pin 的键的源；#loads 保存进行中的共享加载；#keyWhat 是错误信息前缀，构造时算一次。
	// 三个 Map 的键都是规范化后的 key（见 key()），因此内存与 store 使用同一字符串。
	readonly #residents = new Map<string, Resident>();
	/** The sources of pinned keys: a key is pinned while it has one. */
	readonly #sources = new Map<string, KeySource>();
	/** Cold loads in flight, by key: shared by every reader of the key. */
	readonly #loads = new Map<string, SharedLoad>();
	/** Names a refused key (the slot's name is the same at every version): made once, not per key check. */
	readonly #keyWhat: string;

	// 函数说明：保存 owner/definition/persistence；无 I/O。persisted 指向自身，供事务使用；内存文档为 undefined。
	constructor(owner: Documents, definition: AnyDefinition, persistence: Persistence | undefined) {
		this.owner = owner;
		this.definition = new SlotDefinition(definition);
		this.#keyWhat = `${definition.name}: key`;
		this.#persistence = persistence;
		this.persisted = persistence === undefined ? undefined : this;
	}

	// 非空断言：只有 persisted 存在的路径会调用；运行期不做检查。
	get persistence(): Persistence {
		// Only reached through `persisted`, which a persisted slot alone has.
		return this.#persistence!;
	}

	// 函数说明：读取 key 的值；输入原始 key/access/context；返回 Promise<JsonObject|undefined>；键非法时以 rejected Promise 返回。
	// 为什么不用 async：避免在热路径多包一层 Promise；同步抛错转成 Promise.reject，调用方看到的语义不变。
	// this.key(raw) 是信任边界：NUL 抛 invalid/args，孤立代理项替换为 U+FFFD。
	/**
	 * The value at `key`, `undefined` when absent. A document in memory is read at once (also through a sealed
	 * handle); a cold persisted one is loaded on the line (refused `released` once the access's token is sealed), and
	 * `context` ends only this caller's wait. An absent key is not cached (rule 20).
	 */
	// 函数体注释见下一行的 try：get 只做 key 规范化与错误封装，真正异步逻辑在 #get。
	get(raw: string, access: Access, context: Context): Promise<JsonObject | undefined> {
		// Not `async`: `#get` is the one async layer; a refused key still reaches the caller as a rejection.
		// try 包住 this.key(raw) 与 #get 的同步部分；key 规范化可能抛 invalid/args，必须变成 Promise 拒绝而不是同步抛出。
		try {
			return this.#get(this.key(raw), access, context);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/** `get` of a key that went through `key` already. */
	// 函数说明：get 的异步部分；先检查对象存活与句柄版本，再走内存或冷加载。
	// 内存命中会 touch（持久且未 pin 时），返回 tracker.value（引用，不复制）。
	// 纯内存 keyed 槽（无 persistence）缺席就是 undefined，不会等待。
	// 冷加载后可能仍无 resident（store 中不存在），因此再查一次 Map 而不是假定存在。
	async #get(key: string, access: Access, context: Context): Promise<JsonObject | undefined> {
		this.owner.assertLive();
		this.definition.assertVersion(access.version);
		const resident = this.#resident(key);
		// 热路径：内存命中直接返回，不经过对象线，也不等待 store。
		if (resident !== undefined) {
			this.#touch(resident);
			return resident.tracker.value;
		}
		// 纯内存槽没有冷加载概念：缺席即最终结果。
		if (this.#persistence === undefined) return undefined;
		await this.#loadShared(key, access.token, context);
		return this.#residents.get(key)?.tracker.value;
	}

	// 函数说明：异步生成器，按键码点序产出键；输入 access/context，产出 string。
	// 错误：对象结束/版本栅栏在开始时检查；每页读取在对象线上执行，可能因封条抛 released。
	// 纯内存槽直接对 residents 的键排序输出；排序用 compareText（码点序），与 store 的 BINARY 排序一致。
	// 持久槽用 (after, limit) 游标分页：page.length < KEYS_PAGE 表示到底；否则把本页最后一个键作为下一页游标。
	/** The present keys in code point order: in memory, the residents; persisted, the store's, a page per line job. */
	async *keys(access: Access, context: Context): AsyncIterable<string> {
		this.owner.assertLive();
		this.definition.assertVersion(access.version);
		const persistence = this.#persistence;
		// [...keys()] 先复制再排序，避免修改 Map 的插入顺序；sort 的比较器返回码点差值。
		if (persistence === undefined) {
			yield* [...this.#residents.keys()].sort(compareText);
			return;
		}
		let after: string | undefined;
		// 无限循环靠“不足一页”返回；每页是一次独立对象线任务，期间其他事务可以插队。
		for (;;) {
			const page = await this.owner.onLine(() => persistence.keys(after, KEYS_PAGE, context), access.token);
			yield* page;
			if (page.length < KEYS_PAGE) return;
			after = page.at(-1);
		}
	}

	// 函数说明：打开单键 watch；输入原始 key/access/context；缺席或加载后立刻被退役返回 undefined。
	// 流程：先 #get 确保文档存在 → pin 住 key → 复查 resident → 从 source.openWatch 建立 watch → watch.closed 时释放 pin。
	/**
	 * A watch of the document at `key`, `undefined` when absent (after a cold load); it follows the address (a
	 * retirement is a frame with the `retired` flag) and pins the key until it ends.
	 */
	async watch(raw: string, access: Access, context: Context): Promise<Watch<JsonObject> | undefined> {
		const key = this.key(raw);
		if ((await this.#get(key, access, context)) === undefined) return undefined;
		// pin 必须在 openWatch 之前：watch 的生命周期内键不能被驱逐，source 也不能被删除。
		const release = this.pin(key, context);
		// Retired between the load and now: absent.
		// 加载与 pin 之间文档可能被退役；此时不应建立 watch，先释放 pin 再返回 undefined。
		if (!this.#residents.has(key)) {
			release();
			return undefined;
		}
		let watch: Watch<JsonObject>;
		try {
			// The source's values are this slot's documents.
			watch = this.#sources.get(key)!.openWatch(context) as Watch<JsonObject>;
		} catch (error) {
			release();
			throw error;
		}
		// watch 关闭（stop/abort/对象结束）后释放 pin；不等待，因为它与调用者读取 watch 无依赖。
		void watch.closed.then(release);
		return watch;
	}

	// 函数说明：pin 住一个键；输入原始 key/context，返回幂等 release 函数；副作用是创建/复用 KeySource。
	// 例：items.at("a") 在工厂内 pin("a")；本次 attempt 结束时 Documents.hydrate 释放上一轮 pins，source.pins 归零后删除。
	// release 闭包用 released 防重复执行；--pins 后若还有其他 pin 或 source 已被替换，就什么都不做。
	/**
	 * Pins `key`: its source (made by the first pin) and its document stay in memory until the returned release
	 * (idempotent) runs; a persisted key not in memory is loaded by the next activation load (`loadDeclared`).
	 */
	pin(raw: string, context: Context): () => void {
		const key = this.key(raw);
		let source = this.#sources.get(key);
		if (source === undefined) {
			// ready 的判定：内存文档没有 store 或 key 已在内存；否则需要 loadDeclared/ensure 先加载。
			// KeySource 的 initial 从当前定义取；这一步可能触发 initial() 的首次 schema 校验。
			const ready = this.#persistence === undefined || this.#residents.has(key);
			source = new KeySource(this, key, this.definition.current.initial(context), ready);
			this.#sources.set(key, source);
		}
		// 每次 pin 计数加一；已有 resident 时 forget，被 pin 的文档不再参与驱逐。
		source.pins++;
		const resident = this.#residents.get(key);
		if (resident !== undefined) this.owner.residency.forget(resident);
		const pinned = source;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			// 先减计数；仍被其他声明者 pin 或 source 已被替换时，保持现状。
			// 最后一个 pin 释放时删除 source；resident 若还在则重新 touch，开始新的保留期。
			if (--pinned.pins > 0 || this.#sources.get(key) !== pinned) return;
			this.#sources.delete(key);
			const idle = this.#residents.get(key);
			if (idle !== undefined) this.#touch(idle);
		};
	}

	// 函数说明：确保 pinned key 已加载；输入 key/context，无返回；不读 store，当 ready !== false 时直接返回。
	// 用于消费者 at(key) 的 activation 路径：只在确实未加载时排一次对象线任务。
	/** Loads pinned `key` on the line unless it was loaded since it was pinned (a consumer's `at(key)`, slice 6a §12). */
	async ensure(raw: string, context: Context): Promise<void> {
		const key = this.key(raw);
		// 可选链 ?.：没有 source（未 pin）时得到 undefined，!== false 成立，直接返回；只有 pinned 且未加载才继续。
		if (this.#sources.get(key)?.ready !== false) return;
		await this.owner.onLine(() => this.load(key, context));
	}

	// 返回 pinned key 的源；若调用者未 pin，`!` 会得到 undefined 并在后续访问时失败（调用契约要求先 pin）。
	/** The source of pinned `key`. */
	source(key: string): KeySource {
		return this.#sources.get(this.key(key))!;
	}

	// 函数说明：规范化键；输入插件字符串，返回 store/内存共用的文本；NUL → invalid/args，孤立代理项 → U+FFFD。
	// 这是信任边界：所有入口（get/watch/pin/ensure/source）都经过这里，保证同一逻辑键只有一种表示。
	// storedText 只在需要时复制（含孤立代理项时 toWellFormed），普通文本直接返回原引用。
	/**
	 * `key` as the slot and the store keep it: the `str()` text rules (slice 6a §8), a lone surrogate replaced by
	 * U+FFFD, NUL refused `invalid/args`. Plugin keys are a trust boundary; every entry point takes them through here,
	 * so memory and the store agree on one key.
	 */
	key(key: string): string {
		// #keyWhat 是预先拼好的错误前缀，避免每次拒绝都重新拼字符串。
		return storedText(key, this.#keyWhat);
	}

	// 函数说明：activation 加载所有 pinned 但未 ready 的键；调用者持线，逐个 await。
	/** Loads every pinned key not loaded since it was pinned (activation, holding the line). */
	async loadDeclared(context: Context): Promise<void> {
		// 只加载未 ready 的 source；已 ready 的键（内存或已查过 store）不会重复读。
		for (const [key, source] of this.#sources) if (!source.ready) await this.load(key, context);
	}

	// 函数说明：在持线状态下加载一个键并安装 Resident；输入 key/context/可选 token，无返回；读/解码错误向外抛。
	// 已在内存直接返回：adopt 总是赢过并发加载（提交先安装了新值，就不能被旧 store 值覆盖）。
	// token.sealed 检查在 await read 之后：事务被切断后读到的值可能已过期，不再安装。
	// decode 失败（版本更新、指纹不同、migrate 抛错）会 asChordError 包装并让对象 broken，然后继续抛出。
	// 安装前再次检查 resident：在 read/decode 期间别的提交可能已经安装；此处不覆盖。
	// 安装后 touch：未 pin 的持久文档开始计算保留期；source 存在则标记 ready。
	// 文档不存在时不创建 Resident，但 source.ready 仍置真，表示“已查过，确实缺席”。
	/**
	 * Loads the document at `key` (the caller holds the line) and installs it while it is still absent from memory (a
	 * commit's `adopt` always wins). A stored version newer than the code's, another fingerprint or a failing `migrate`
	 * fails the owner (slice 6a §1.4) and rejects with the cause.
	 */
	async load(key: string, context: Context, token?: SealToken): Promise<void> {
		if (this.#residents.has(key)) return;
		// A store error rejects as the store's (`storage_failed`, `aborted`).
		// store 错误（storage_failed/aborted）在这里直接 reject，不包装成 broken：调用者决定事务失败方式。
		const document = await this.persistence.read(key, context);
		// The transaction was cut meanwhile: what it read may be stale already.
		// 可选链 + 严格比较：没有 token（activation 加载）时不停；只有事务加载且 token 已封才放弃安装。
		if (token?.sealed === true) return;
		let loaded: Loaded | undefined;
		try {
			loaded =
				document === undefined ? undefined : this.persistence.decode(document, this.definition.current, context);
		} catch (error) {
			// What the code cannot read (a failing `migrate`, whatever it throws) fails the owner.
			const failure = asChordError(error, this.owner.label);
			this.owner.fail(failure);
			throw failure;
		}
		// 双重条件：文档存在，且期间没有 adopt 安装过 Resident；后者优先，不能覆盖更新的内存值。
		if (loaded !== undefined && !this.#residents.has(key)) {
			const resident = new Resident(this, key, track(loaded.value), loaded.stored, this.definition.current.version);
			this.#residents.set(key, resident);
			this.#touch(resident);
		}
		// 若该键被 pin，标记 ready 让 KeySource.value 可读；未被 pin 时没有 source，无需更新。
		const source = this.#sources.get(key);
		if (source !== undefined) source.ready = true;
	}

	// 冷文档：持久槽中存在但不在内存；事务据此决定先加载还是直接退役。
	cold(key: string): boolean {
		return this.#persistence !== undefined && !this.#residents.has(key);
	}

	// 返回内存 resident 的存储坐标；冷文档返回 undefined，事务会改用 find() 的结果。
	stored(key: string): Stored | undefined {
		return this.#residents.get(key)?.stored;
	}

	// 函数说明：把提交的改动交给 Persistence.stage；key 已规范化；返回 StoredChange。
	stage(key: string, change: DocumentChange, was: Stored | undefined, writes: StagedWrite[]): StoredChange {
		return this.persistence.stage(key, this.definition.current, was, change, writes);
	}

	// 函数说明：接收新 attempt 的定义；输入 definition/context，无返回；升版时迁移 pinned 文档并重发替换帧。
	// 先更新 SlotDefinition：后续 #resident、initial、migrate 都以新定义为准。
	// 首次水合或同版本：不迁移任何值，直接返回（未 pin 的旧值在下次访问时按需迁移）。
	// 只立即迁移 pinned 文档：它们被 watch/依赖，必须在本次 activation 内完成；未 pin 的留在内存里带旧 version，访问时再迁。
	/**
	 * Takes the attempt's declaration: a newer version migrates each document in memory on its next access (persisted
	 * ones store a base with their next change); the pinned keys are watched, so they migrate now, all or none, and
	 * take `initial()` again.
	 */
	hydrate(definition: AnyDefinition, context: Context): void {
		const from = this.definition.hydrated;
		// 先换定义再做迁移：migrate 和 initial 都读取 definition.current，顺序不能反。
		this.definition.hydrate(definition);
		if (from === undefined || from.version === definition.version) return;
		// flatMap 过滤没有 resident 的 pinned key；下一行 map 里的 as const 让元组推断为 [Resident, Tracker] 而不是宽数组。
		const pinned = [...this.#sources.keys()].flatMap((key) => this.#residents.get(key) ?? []);
		const migrated = pinned.map((resident) => [resident, this.#migrated(resident, context)] as const);
		for (const [resident, tracker] of migrated) {
			resident.tracker = tracker;
			resident.version = definition.version;
		}
		// 迁移结果先在 map 中全部算完再赋值：任一迁移抛错都不会只更新一半 resident。
		// 帧在 batch 的 adopt 阶段登记：每个 pinned source 以新 initial 重新对齐并发根替换。
		// initial(context) 对每个 source 都调用一次；keyed 的 initial 是“缺席值”，不共享。
		this.owner.batch.commit(() => {
			for (const source of this.#sources.values()) source.retake(definition.initial(context));
		}, context);
	}

	// 取 key 的 tracker；会触发按需迁移（#resident）。没有 resident 时 undefined，草拟从 initial 开始。
	current(key: string): Tracker<JsonObject> | undefined {
		return this.#resident(key)?.tracker;
	}

	// 为缺席文档取新 initial；每次调用都可能执行用户工厂（类型保证形状，R8 只校验第一次）。
	/** The value a draft of an absent document starts from: a fresh `initial()`. */
	initial(context: Context): JsonObject {
		return this.definition.current.initial(context);
	}

	// 函数说明：收养提交；输入 key/tracker/prepared/change，无返回；副作用是安装/更新 resident 与 source 帧。
	// storedAfter(change) 把提交的存储意图转成内存应记住的 Stored；change 为 undefined 表示纯内存槽。
	// 注意：adopt 可能发生在对象 seal 之后（store step 已获准），所以不调用 assertLive。
	adopt(
		key: string,
		tracker: Tracker<JsonObject>,
		prepared: Prepared<JsonObject>,
		change: StoredChange | undefined,
	): void {
		const stored = change === undefined ? undefined : storedAfter(change);
		const source = this.#sources.get(key);
		const before = source?.peek();
		// Delta 的收养是指针交换：tracker.value 变成 prepared.value；prepared 之后不可复用。
		tracker.adopt(prepared);
		let resident = this.#residents.get(key);
		const { version } = this.definition.current;
		// 已有 resident 时原地更新（保持 Map 插入顺序）；没有时新建并登记。
		if (resident === undefined) {
			resident = new Resident(this, key, tracker, stored, version);
			this.#residents.set(key, resident);
		} else {
			resident.tracker = tracker;
			resident.stored = stored;
			resident.version = version;
		}
		// 未 pin：touch 开始保留期；已 pin：由 source.written 比较 before 并生成帧。
		// before! 的非空断言由 source 存在保证：peek 总能给出当前值或 initial。
		if (source === undefined) this.#touch(resident);
		else source.written(before!, prepared);
	}

	// 函数说明：退役 key；无返回；副作用是移出内存、停止保留期计时、让 pinned source 发 retired 帧。
	// 没有 resident 时也要通知 source：它可能正被 watch 且值缺席，需要 retired 标志。
	/** Retires the document at `key` (inside the batch): out of memory, its source reads `initial()` with the flag. */
	retire(key: string): void {
		const resident = this.#residents.get(key);
		// 先删内存并 forget，再通知 source；顺序保证帧发出时 peek 已回落到 initial。
		if (resident !== undefined) {
			this.#residents.delete(key);
			this.owner.residency.forget(resident);
		}
		this.#sources.get(key)?.retire();
	}

	// 函数说明：清扫回调；仅当 Map 仍指向同一个 Resident 时删除，避免误删之后重新安装的新实例。
	/** The sweep found `resident` idle past the retention: it leaves memory. */
	evict(resident: Resident): void {
		if (this.#residents.get(resident.key) === resident) this.#residents.delete(resident.key);
	}

	/** Its object ended or no attempt declares it any more: the documents go and the keys' watches end. */
	// 函数说明：对象结束或 attempt 不再声明；清内存与所有 source，watch 收到 ended（不是 retired）。
	// 不写 store：持久文档留在磁盘，重新声明时重新加载。
	drop(): void {
		for (const resident of this.#residents.values()) this.owner.residency.forget(resident);
		this.#residents.clear();
		for (const source of this.#sources.values()) source.end();
		this.#sources.clear();
	}

	// 函数说明：共享冷加载；输入 key/token/context，无返回；token 已封或对象结束时抛 released。
	// assertAdmitted 在查进行中加载之前：即使已有加载，已封句柄也不能搭车（rule 4）。
	// 同一 key 只启动一次加载；后续等待者把自己的 token 加入集合。
	// awaitWithContext 只让当前调用者的等待可被其 context 取消；底层加载仍在对象 context 下继续，其他等待者不受影响。
	// 例：A、B 同时 get 冷键；只读一次 store；A 的 attempt 在加载前被封，A 得到 released，B 正常读到值。
	/**
	 * A cold persisted key's load, one in flight per key, on the line under the owner's context (rule 11). The load is
	 * every waiter's: when it takes the line, a waiter whose handle was sealed meanwhile (its attempt failed live, the
	 * object still open) is refused `released`, and with no other waiter the load does not run (rule 4).
	 */
	async #loadShared(key: string, token: SealToken, context: Context): Promise<void> {
		// Also when a load is in flight: a sealed handle's cold read is refused (rule 4).
		// 封条检查逐次执行：句柄被封后即使加载已在途，也不能再发起冷读。
		this.owner.assertAdmitted(token);
		let load = this.#loads.get(key);
		if (load === undefined) load = this.#startLoad(key);
		load.tokens.add(token);
		// 只等待共享 Promise；调用者取消只影响自己的 await，不取消加载本身。
		await awaitWithContext(load.done, context);
		// 加载拿线时快照到的已封 token 会进入 refused；这类等待者即使加载成功也按 released 处理。
		if (load.refused?.has(token)) throw this.owner.released();
	}

	// 函数说明：创建并登记一次共享加载；输入 key，返回 SharedLoad；副作用是排入对象线。
	// done 的 Promise 由 onLine 创建；async 任务在拿到线之后才执行，所以 load 变量此时已赋值（闭包安全）。
	// 无论完成或拒绝都从 #loads 删除；then 的两个参数共用 settled，避免 unhandled rejection 影响清理。
	/** Starts the shared load of `key`; it leaves `#loads` when it settles. */
	#startLoad(key: string): SharedLoad {
		const tokens = new Set<SealToken>();
		const load: SharedLoad = {
			tokens,
			refused: undefined,
			// The job runs once the line is taken, after `load` is assigned.
			// onLine 返回的 Promise 就是 done；任务的真正执行发生在 acquire 获得对象线之后。
			done: this.owner.onLine(async () => {
				// 拿线时快照 tokens 并检查封条；之后新加入的等待者不在 refused 里，但 assertAdmitted 已保证它们未封。
				const refused = new Set([...tokens].filter(({ sealed }) => sealed));
				load.refused = refused;
				// 所有等待者都被封：任务直接以 released 结束，不读 store（rule 4）。
				// 只要还有一个未封等待者，加载继续；它使用 owner.context（rule 11），不因某个调用者取消而停止。
				if (refused.size === tokens.size) throw this.owner.released();
				await this.load(key, this.owner.context);
			}),
		};
		this.#loads.set(key, load);
		const settled = (): void => {
			this.#loads.delete(key);
		};
		// 成功和失败都删除 #loads 条目；这里不重新抛出，错误由各等待者的 awaitWithContext 观察。
		load.done.then(settled, settled);
		return load;
	}

	// 函数说明：取 resident 并在版本落后时按需迁移；输入 key，返回 Resident|undefined。
	// 迁移用 owner.context（不是某个调用者的 context）：结果安装到共享内存，必须与对象生命周期一致。
	/** The resident at `key`, migrated to the slot's version first when it is older (migration on access). */
	#resident(key: string): Resident | undefined {
		const resident = this.#residents.get(key);
		// 版本相同直接返回；落后才迁移。注意这一步会改变 tracker，所有读取者共享迁移结果。
		if (resident === undefined || resident.version === this.definition.current.version) return resident;
		const tracker = this.#migrated(resident, this.owner.context);
		resident.tracker = tracker;
		resident.version = this.definition.current.version;
		return resident;
	}

	// 函数说明：迁移一个 resident 的值；输入 resident/context，返回新 tracker；失败让对象 broken 并抛出。
	// definition.current.migrate 内部会做一次 schema 校验（R8）；这里只负责把普通错误包成 ChordError 并上报。
	// 例：v1 的 {n:1} 经 migrate 得到 v2 的 {count:1}；失败时对象收到 unavailable/broken。
	/**
	 * `resident`'s value migrated from its version to the slot's (checked, R8). A throwing `migrate` fails the live
	 * owner `broken` (slice 6a §1.4) and throws the failure (an activation fails with it).
	 */
	#migrated(resident: Resident, context: Context): Tracker<JsonObject> {
		try {
			// track 把迁移结果包成新 tracker；旧 tracker 不被修改，便于失败时保持原值。
			return track(this.definition.current.migrate(resident.tracker.value, resident.version, context));
		} catch (error) {
			// 普通 Error 转成 ChordError（unavailable），保留 cause；随后 owner.fail 让 live 对象 broken。
			const failure = asChordError(error, this.owner.label);
			this.owner.fail(failure);
			throw failure;
		}
	}

	// 函数说明：未 pin 的持久 resident 被使用；输入 resident，无返回；副作用是 Residency.touch。
	// 纯内存槽与已 pin 键不参与驱逐，因此不做任何事。
	/** A use of `resident` while unpinned: persisted, it is idle from now (Durable's granule rule). */
	#touch(resident: Resident): void {
		if (this.#persistence !== undefined && !this.#sources.has(resident.key)) this.owner.residency.touch(resident);
	}
}

// 每个 pinned key 一个 KeySource；它继承 AddressSource，所以 retire/replaced 会生成标准帧。
// 生命周期由 pin 计数控制：最后一个 release 删除 source；之后若重新 pin 会创建新 source。
/**
 * One pinned key of a keyed slot as a source (`handle.at(key)`, a keyed member's `at(key)`, `watch(key)`): the
 * document's value, `initial()` while it is absent; retirements arrive with the `retired` flag.
 */
export class KeySource extends AddressSource {
	// pins 是运行期计数，0 时槽删除 source；ready 表示“自 pin 以来是否已查过 store”（缺席也算查过）；#initial 是缺席值。
	readonly #slot: KeyedSlot;
	readonly key: string;
	/** Its pins: at 0 the slot forgets it. */
	pins = 0;
	/** Whether the key was loaded since it was pinned (always, in memory): its value is known. */
	ready: boolean;
	#initial: JsonObject;

	// 函数说明：super(slot.owner.batch) 接入批次；保存 slot/key/initial/ready；无 I/O。
	// 例：new KeySource(slot, "a", {count:0}, true) 表示 a 已在内存。
	constructor(slot: KeyedSlot, key: string, initial: JsonObject, ready: boolean) {
		super(slot.owner.batch);
		this.#slot = slot;
		this.key = key;
		this.#initial = initial;
		this.ready = ready;
	}

	// 函数说明：读 source 当前值；对象结束 → released；未 ready → not_ready（pinned 但尚未加载）。
	// ready 为 true 后，值来自 slot.current(key)（可能触发按需迁移）或 initial（确实缺席）。
	get value(): JsonObject {
		this.#slot.owner.assertLive();
		if (!this.ready) {
			const message = `${this.#slot.definition.current.name}(${this.key}): read before it was loaded`;
			throw new ChordError({ code: "not_ready", message });
		}
		return this.peek();
	}

	// 不检查 ready/存活，仅供槽内部在提交与帧比较时使用；缺席时返回 initial。
	/** The value without the checks (inside its slot's commits). */
	peek(): JsonObject {
		return this.#slot.current(this.key)?.value ?? this.#initial;
	}

	// 文档被退役：按 AddressSource 的约定发 [["r", initial]] 并带 retired 标志。
	/** The document was retired: `initial()` from now, with the flag. */
	retire(): void {
		this.retired(this.#initial);
	}

	// 新定义接管（迁移后）：更新 initial；若已 ready，当前值以整根替换帧发出。
	// 未 ready 时不发帧：watch 尚未看到过值，activation 的初始帧会直接用新 initial。
	/** A new definition took over (inside a batch): `initial()` again, the value as a root replacement. */
	retake(initial: JsonObject): void {
		this.#initial = initial;
		if (this.ready) this.replaced();
	}

	// 槽被 drop：立即结束所有 watch（ended），不发送退役帧。
	/** Its slot was dropped: the watches end. */
	end(): void {
		this.endWatches();
	}
}
