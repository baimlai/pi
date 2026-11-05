// Document handles (slice 6a §1.2): what `self.state` returns, one per attempt and definition, a thin view of its
// object's slot bound to the attempt's seal token and the definition's version.

// 文件导读
// 所属：packages/chord/src/documents，应用可见的文档句柄层。
// 职责边界：句柄是薄视图：读委托给 slot，写变成 slot.owner.tx 的一次事务；不持有文档值、不直接读写 store。
// 上游：Documents.declare 在每次 attempt 中创建 Singleton/Keyed 并绑定 token 与 version；下游：slot.openWatch、slot.get/keys/watch、Documents.tx/Transaction。
// 结果/错误：读取可能抛 released（对象结束/旧版本）或 not_ready（未水合/未加载）；冷读返回 Promise，store 错误 reject；写入由事务统一提交或丢弃。
// 能力清单：SingletonHandle/KeyedHandle 应用接口；HandleOf 定义到句柄的类型映射；Singleton/Keyed 运行期句柄；KeyDeclarer 工厂内 at(key) 的声明接口。
// 组合关系：defineState → HandleOf 选类型 → declare 返回句柄 → value/watch/get 读 → change/retire 经 tx → commit 后 watch 帧。
// 示例：const counter = self.state(counterDef); counter.value; await counter.change(d => { d.count += 1; }, ctx)。
// 阅读顺序：先看两个接口与 HandleOf，再看 Singleton 的版本栅栏与事务委托，最后看 Keyed 的 key/at/watch 差异。
// 句柄不负责 pin 的生命周期：Keyed.at 只是把声明转交给 KeyDeclarer（attempt），由 attempt 在 hydrate 时统一释放。
import type { Context } from "../context/index.ts";
import type { Draft } from "../delta/index.ts";
import type { Watch, Watchable, WatchHandle } from "../watch.ts";
import type { JsonObject, StateDefinition } from "./definition.ts";
import type { SealToken } from "./fence.ts";
import type { KeyedSlot, KeySource } from "./keyed-slot.ts";
import type { SingletonSlot } from "./slot.ts";

// 接口描述应用看到的 singleton API；watch/value 来自 Watchable<T>，change/retire 各是一次事务。
// 例：const counter = self.state(counterDef); counter.value; await counter.change(d => { d.count++; }, ctx)。
/** A singleton document: a watchable that always has a value (`initial()` until written, and after a retire). */
export interface SingletonHandle<T extends JsonObject> extends Watchable<T> {
	/** One transaction that drafts this document and passes the draft to `fn`. */
	change<R>(fn: (draft: Draft<T>) => R, context: Context): Promise<R>;
	/** One transaction that retires this document: back to `initial()`. */
	retire(context: Context): Promise<void>;
}

// keyed 句柄不直接实现 Watchable：每个 key 通过 watch(key)/at(key) 单独观察。
// at 只能在工厂内调用，因为它要 pin 到本次 attempt；get/keys/watch 可随时调用，但受封条与版本栅栏。
/**
 * Keyed documents: many per object, by string key. Not a watchable itself: each key is, through `watch(key)` and
 * `at(key)`; a live collection is a singleton holding it.
 */
export interface KeyedHandle<T extends JsonObject> {
	/** The document's value, `undefined` when absent (persisted and not in memory: loaded on the object's line). */
	get(key: string, context: Context): Promise<T | undefined>;
	/** The keys of the present documents, in code point order. */
	keys(context: Context): AsyncIterable<string>;
	/**
	 * A watch of the document at `key`, `undefined` when absent. It follows the address: a retirement is one frame with
	 * `retired: true` and `initial()`, a later creation a root replacement; it ends with the object.
	 */
	watch(key: string, context: Context): Promise<WatchHandle<T> | undefined>;
	/**
	 * In the factory only: the document at `key` as a watchable (a state member, a derive source, an `on` source),
	 * `initial()` while absent, loaded before the object goes live and pinned while this attempt lives.
	 */
	at(key: string): Watchable<T>;
	/** One transaction that drafts the document at `key` and passes the draft to `fn`. */
	change<R>(key: string, fn: (draft: Draft<T>) => R, context: Context): Promise<R>;
	/** One transaction that retires the document at `key` (a no-op when absent). */
	retire(key: string, context: Context): Promise<void>;
}

// HandleOf 在编译期按定义的 K 选择句柄类型：K extends true → KeyedHandle，否则 SingletonHandle。
// infer T/K 从 StateDefinition<T,K,boolean> 提取；运行期不存在这个映射，declare 里用断言完成。
/** The handle `self.state(definition)` returns. */
export type HandleOf<D> = D extends StateDefinition<infer T, infer K, boolean>
	? K extends true
		? KeyedHandle<T>
		: SingletonHandle<T>
	: never;

// 例：Documents.declare 返回的 Singleton 绑定 slot、attempt token 和定义版本；同一 slot 在多次 attempt 间共享。
// 读操作不做封条检查（对象结束后 slot.value 会抛 released）；写操作在 tx 内检查 token。
// 暴露为 state member/derive 源时，框架取的是 slot 本身，不是这个薄句柄。
/**
 * A singleton's handle. Reads go to the slot (allowed after the seal); `change` and `retire` take the line under the
 * attempt's token. Exposed as a member or read by a derive, it resolves to the slot itself.
 */
export class Singleton implements SingletonHandle<JsonObject> {
	// slot 是真正的数据持有者；token 决定本句柄所属 attempt 的封条；version 用于旧代码/新代码的版本栅栏（R15）。
	readonly slot: SingletonSlot;
	readonly token: SealToken;
	/** The version of the definition it was declared with: the slot refuses it once its values are newer (R15). */
	readonly version: number;

	// 函数说明：保存三个字段；无校验、无副作用。例：new Singleton(slot, token, 1)。
	constructor(slot: SingletonSlot, token: SealToken, version: number) {
		this.slot = slot;
		this.token = token;
		this.version = version;
	}

	// 函数说明：读取当前值；副作用：assertVersion 可能抛 released/version 或 not_ready；slot.value 可能抛 released/not_ready。
	// 例：句柄版本 1、文档已迁到 2 → 这里抛 released/version，旧代码不会读到新形状。
	get value(): JsonObject {
		this.slot.definition.assertVersion(this.version);
		return this.slot.value;
	}

	// 函数说明：打开 watch；输入 context，返回 Promise<Watch<JsonObject>>；先做版本栅栏，再委托 slot.openWatch。
	// `as Watch<JsonObject>` 是编译期断言：基类 Source 的值类型被擦成 JsonValue，运行期没有转换。
	async watch(context: Context): Promise<Watch<JsonObject>> {
		this.slot.definition.assertVersion(this.version);
		// The slot's values are this handle's documents.
		return this.slot.openWatch(context) as Watch<JsonObject>;
	}

	// 函数说明：在本次 attempt 的封条下开启事务并草拟该文档；输入 fn 与 context，返回 fn 的结果。
	// 流程：slot.owner.tx 排队拿线 → tx.draft(this) 取 Draft → fn(draft) → tx.commit 收养；fn 抛错则整笔丢弃。
	// 例：await counter.change(d => { d.count += 1; }, ctx) 返回 fn 的返回值（此处 undefined）。
	change<R>(fn: (draft: Draft<JsonObject>) => R, context: Context): Promise<R> {
		return this.slot.owner.tx(async (tx) => fn(await tx.draft(this)), this.token, context);
	}

	// 函数说明：开启事务退役该 singleton；输入 context，返回 Promise<void>；不存在时提交为 no-op。
	retire(context: Context): Promise<void> {
		return this.slot.owner.tx((tx) => tx.retire(this), this.token, context);
	}
}

// 声明者只能是工厂（attempt），因为它负责 pin 的生命周期；在工厂外调用 at 会由实现抛错。
/** Who declares an attempt's `at(key)` pins: its factory, which alone may (the attempt). */
export interface KeyDeclarer {
	/** Pins `key` of `slot` for the attempt and returns its source; throws outside the factory. */
	at(slot: KeyedSlot, key: string): KeySource;
}

// 例：const items = self.state(itemsDef); await items.get("a", ctx); items.watch("a", ctx); items.at("a")（仅工厂）。
// 读、watch、keys 都先经过 key 规范化与版本栅栏；change/retire 通过 owner.tx 走对象线。
/** A keyed handle: reads go to the slot; `change`, `retire` and cold reads take the line under the attempt's token. */
export class Keyed implements KeyedHandle<JsonObject> {
	// #declarer 保存工厂的 pin 入口；它不暴露给应用。
	readonly slot: KeyedSlot;
	readonly token: SealToken;
	/** As `Singleton.version`. */
	readonly version: number;
	readonly #declarer: KeyDeclarer;

	// 函数说明：保存 slot/token/version/declarer；无 I/O。例：new Keyed(slot, token, 2, attempt)。
	constructor(slot: KeyedSlot, token: SealToken, version: number, declarer: KeyDeclarer) {
		this.slot = slot;
		this.token = token;
		this.version = version;
		this.#declarer = declarer;
	}

	// 函数说明：读取 key 的值；返回 Promise<JsonObject|undefined>；冷键会触发共享加载，加载失败 reject。
	// this 作为 Access（含 token 与 version）传给槽，槽据此做封条与版本检查。
	get(key: string, context: Context): Promise<JsonObject | undefined> {
		return this.slot.get(key, this, context);
	}

	// 函数说明：返回键的异步可迭代对象；调用方用 for await 逐个消费，分页由槽负责。
	keys(context: Context): AsyncIterable<string> {
		return this.slot.keys(this, context);
	}

	// 函数说明：打开单键 watch；不存在返回 undefined；watch 关闭时释放 pin。
	watch(key: string, context: Context): Promise<Watch<JsonObject> | undefined> {
		return this.slot.watch(key, this, context);
	}

	// 函数说明：工厂内把 key 声明为本次 attempt 的成员/依赖源；返回 Watchable，缺席时读 initial。
	// 两个断言：declarer 返回 KeySource，而签名要求 Watchable<JsonObject>；运行期 KeySource 已实现 Source，所以安全。
	at(key: string): Watchable<JsonObject> {
		// The source's values are this slot's documents.
		return this.#declarer.at(this.slot, key) as unknown as Watchable<JsonObject>;
	}

	// 函数说明：在事务中草拟 keyed 文档；输入 key/fn/context，返回 fn 结果；key 会先规范化。
	change<R>(key: string, fn: (draft: Draft<JsonObject>) => R, context: Context): Promise<R> {
		return this.slot.owner.tx(async (tx) => fn(await tx.draft(this, key)), this.token, context);
	}

	// 函数说明：事务退役 keyed 文档；不存在时 no-op。
	retire(key: string, context: Context): Promise<void> {
		return this.slot.owner.tx((tx) => tx.retire(this, key), this.token, context);
	}
}
