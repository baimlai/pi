// Persisted documents' store side (slice 6a §8, §10): a slot's address in the documents engine, what is stored of each
// loaded document (Durable's `LoadedDocument` fields), its loads with the version and fingerprint checks and the
// checked `migrate`, and the writes one commit stages for a changed or retired document.

// 文件导读
// 所属：packages/chord/src/documents，持久文档的 store 适配层。
// 职责边界：把 (owner, namespace, kind, key) 地址、读取解码、版本/指纹校验、提交暂存翻译成 store/engine 的调用；不直接执行 SQL，不管理内存驻留。
// 上游：SingletonSlot/KeyedSlot 的 load/retire/stage 与 Transaction.commit；下游：store/engine.ts 的 findDocument/loadDocument/listDocumentKeys/createDocument/changeDocument/retireDocument，以及 ChordStore.read。
// 结果/错误：读/写错误按 store 的 ChordError 传播；decode/checkReadable 的代码侧错误抛普通 Error，由调用方 asChordError 后让对象 broken。
// 能力清单：Stored/FoundDocument/Loaded 存储坐标类型；DocumentChange/Held/StoredChange 提交意图；Persistence 类（read/decode/find/keys/stage/at）；checkReadable 版本校验；storedAfter 提交后坐标。
// 组合关系：加载 = read → decode（checkReadable → migrate）→ 槽安装；提交 = 槽 stage → StagedWrite → store 步骤执行 → storedAfter 更新内存坐标。
// 示例：const p = new Persistence(store, "cart", "chord", "items"); const doc = await p.read("a", ctx); const loaded = p.decode(doc, definition, ctx)。
// 阅读顺序：先看 Stored/StoredChange 与地址含义，再看 read/decode/find，最后看 stage 的 base/delta 决策与 storedAfter。
// 运行期不校验 owner/namespace/kind/key 的文本形状；key 的规范化由 KeyedSlot.key（storedText）负责。
import type { Context } from "../context/index.ts";
import type { Op, Prepared } from "../delta/index.ts";
import {
	changeDocument,
	createDocument,
	type DocumentAddress,
	type DocumentContent,
	findDocument,
	listDocumentKeys,
	loadDocument,
	retireDocument,
	type StoredDocument,
} from "../store/engine.ts";
import type { StagedWrite } from "../store/step.ts";
import type { ChordStore } from "../store/store.ts";
import type { JsonObject } from "./definition.ts";
import type { AnyDefinition } from "./slot.ts";

// Stored 是内存里记住的存储坐标：id 与 revision 用于 CAS 写入；version 是 base 的定义版本；deltasSinceBase 供 checkpointWhen 决策。
// 这些字段来自 store 记录，运行期由引擎返回；这里不做形状检查。
/** What is stored of a loaded document: its record's id and revision, its base's version, the deltas after it. */
export type Stored = {
	readonly id: number;
	readonly revision: number;
	/** The version of the stored base: below the definition's, the next change stores a base (rule 1). */
	readonly version: number;
	readonly deltasSinceBase: number;
};

// find 的结果：不加载值，只拿存储坐标与写入时的 schema 指纹，用于退役前的可读性检查（R15）。
/** A live document found without loading it: what is stored of it and the fingerprint it was stored with. */
export type FoundDocument = { readonly stored: Stored; readonly fingerprint: string };

// decode 的结果：value 已经迁到定义当前版本，stored 仍是 store 里的坐标（version 是 base 的版本，不是迁移后的版本）。
/** A loaded document: its value at the definition's version, and what is stored of it. */
export type Loaded = { readonly value: JsonObject; readonly stored: Stored };

// 一个事务对一个文档的改动：prepared 为 undefined 表示只退役；retires 为 true 表示提交后文档应缺席。
// prepared 由 Delta 的 Change.prepare() 产生；它包含 base/value/ops，stage 用它决定 base 还是 delta。
/** One transaction's change of one document: its prepared draft (if changed), and whether it retires it. */
export type DocumentChange = { readonly prepared: Prepared<JsonObject> | undefined; readonly retires: boolean };

// D8：延迟持久化的运行状态先攒 ops；base 为 true 表示下一次写入必须整根存 base（例如底层记录版本已升）。
/** A run state's held ops (D8), stored before the next change's own; `base` when a held change asked for a base. */
export type Held = { readonly ops: readonly Op[]; readonly base: boolean };

// StoredChange 是提交对 store 的意图，判别字段 kind；create.created 是可变单元格，store 步骤真正分配 id 后回填。
// change.stored 的 revision 是“写入完成后的 revision”（旧值+1），供同一批后续写入使用。
// held 表示本批只改了内存：stored 仍是旧坐标，withinMs 是延迟上限。
/**
 * What one commit stores of a document, in the store writes' words: a retirement (nothing stored after it), a
 * creation whose id the step assigns (`create`: `created.id` once it applied), a change of the record `stored` was
 * prepared on, or nothing yet (`held`: a deferred change of a run's state, D8, kept in memory over `stored`).
 */
export type StoredChange =
	| { readonly kind: "retire" }
	| { readonly kind: "create"; readonly version: number; readonly created: { id: number } }
	| { readonly kind: "change"; readonly stored: Stored }
	| { readonly kind: "held"; readonly stored: Stored; readonly withinMs: number };

// 例：Persistence(store, "cart", "chord", "items") 对应地址 (owner=cart, namespace=chord, kind=items, key=?)；singleton 的 key 为 ""。
/**
 * The documents of one persisted name on one object: `(<object type>, namespace, name, key)`, the namespace `chord` for
 * `self.state`, `chord.jobs` and `chord.job-states` for persisted job runs (slice 6b D5).
 */
export class Persistence {
	// #address 不含 key：singleton 用原样地址，keyed 在 at(key) 时展开；Omit 是编译期类型运算。
	// store 是 host 的 ChordStore；本类不拥有它，也不负责关闭。
	readonly store: ChordStore;
	readonly #address: Omit<DocumentAddress, "key">;

	// 函数说明：保存 store 与公共地址；输入 owner/namespace/kind，无输出；不访问数据库，不校验字符串。
	// owner 是对象类型名（R2），同一对象的所有尝试共享同一地址，因此重启后仍能找回文档。
	/** `owner` is the object's type (R2); `kind` the definition's or the job's name. */
	constructor(store: ChordStore, owner: string, namespace: string, kind: string) {
		this.store = store;
		this.#address = { owner, namespace, kind };
	}

	// 函数说明：按键读取一条文档（记录+值）；输入 key/context，返回 StoredDocument 或 undefined；store 错误原样 rejects。
	// store.read 在一段受保护的读上下文中执行回调：先 findDocument 找活跃记录，再 loadDocument 解出值。
	// context 的 abortSignal 会中止等待，但不会取消 store 内部已经开始的读；这是 store.read 的契约。
	/**
	 * The stored document at `key`, `undefined` when absent: found and loaded with plain reads (a store error rejects
	 * as the store's). Counted (`chord.store.loads`).
	 */
	async read(key: string, context: Context): Promise<StoredDocument | undefined> {
		const address = this.at(key);
		// 回调里的两条 await 共享同一个 executor（同一读快照），因此 find 与 load 不会看到两次提交之间的状态。
		// `record === undefined ? undefined : ...` 用三元表达式把“缺席”与“加载失败”区分开：缺席不是错误。
		const document = await this.store.read(async (executor) => {
			const record = await findDocument(executor, address);
			return record === undefined ? undefined : loadDocument(executor, record);
		}, context);
		// 只有真正找到文档才计数 chord.store.loads；缺省键不增加加载指标。
		if (document !== undefined) context.telemetry.metrics?.counter("chord.store.loads").add(1);
		return document;
	}

	// 函数说明：把引擎文档转成定义可读的值；输入 StoredDocument/definition/context，返回 Loaded。
	// checkReadable 先拒绝“存储版本更新”或“同版本不同指纹”；旧版本则调用 definition.migrate（迁移结果已校验）。
	// 这里的错误都属于代码侧（migrate 抛什么就抛什么），store 侧错误在 read 阶段已经发生。
	/**
	 * `document` as `definition` reads it: a stored version newer than the code's, or the same version with another
	 * fingerprint (D9), throws; an older one is migrated and the result checked once (R8). What throws here is the
	 * code's (a failing `migrate` too, whatever it throws), never the store's.
	 */
	// `document.value as JsonObject` 是类型断言：引擎存储的根总是对象，运行时不再检查。
	// 版本相同直接复用存储值（不复制）；版本更旧才走 migrate，迁移后的值已经是当前定义的 T。
	decode(document: StoredDocument, definition: AnyDefinition, context: Context): Loaded {
		const { record, deltasSinceBase } = document;
		checkReadable(record, definition);
		// The engine stores what commits gave it: JSON objects of the record's version.
		const stored = document.value as JsonObject;
		const value =
			record.version === definition.version ? stored : definition.migrate(stored, record.version, context);
		return {
			value,
			stored: { id: record.id, revision: record.revision, version: record.version, deltasSinceBase },
		};
	}

	// 函数说明：不加载值，只查活跃记录；输入 key/context，返回 FoundDocument 或 undefined。
	// 与 read 不同，这里不增加 chord.store.loads：读取的是元数据，不是文档值。
	/**
	 * What is stored of the live document at `key` without loading it (a retirement's find) and the schema fingerprint
	 * it was stored with (`checkReadable` takes both), `undefined` when absent.
	 */
	// 退役只需 id/revision/version 与指纹，因此 deltasSinceBase 固定 0，避免多读不需要的列。
	// fingerprint 来自记录本身，用于 checkReadable 判断同版本 schema 是否变过。
	async find(key: string, context: Context): Promise<FoundDocument | undefined> {
		const record = await this.store.read((executor) => findDocument(executor, this.at(key)), context);
		if (record === undefined) return undefined;
		// The change counter is all a retirement needs; `deltasSinceBase` is not read for one.
		const stored = { id: record.id, revision: record.revision, version: record.version, deltasSinceBase: 0 };
		return { stored, fingerprint: record.fingerprint };
	}

	// 函数说明：列出 after 之后的至多 limit 个键；输入游标/limit/context，返回字符串数组（已按码点序）。
	// 分页与排序由引擎的 SQL 完成；调用方（KeyedSlot.keys）负责循环与 yield。
	/** Up to `limit` keys of live documents after `after`, in code point order. */
	keys(after: string | undefined, limit: number, context: Context): Promise<string[]> {
		return this.store.read((executor) => listDocumentKeys(executor, this.#address, after, limit), context);
	}

	// 函数说明：为一个提交暂存写入；输入 key/definition/stored/change/writes/held，返回 StoredChange。
	// 副作用：向 writes 追加 StagedWrite（retire/create/change），不执行 I/O；序列化在这里完成（rule 8，入队前）。
	// 例：stored 存在、值变化且 checkpointWhen 返回 false → 追加 changeDocument(... {kind:"delta"}) 并返回 {kind:"change"}。
	/**
	 * Stages one commit's writes of the document at `key` into `writes` (rule 8: serialized here, before the queue):
	 * its retirement when `retired` is stored, then its creation, or the change of `stored` (a base when created, when
	 * the stored version is older, or when `checkpointWhen` asks; a delta otherwise), `held` ops stored before the
	 * change's own (D8: a held base makes it a base). Returns what the commit stores.
	 */
	stage(
		key: string,
		definition: AnyDefinition,
		stored: Stored | undefined,
		change: DocumentChange,
		writes: StagedWrite[],
		held?: Held,
	): StoredChange {
		const { prepared, retires } = change;
		// 先追加退役写入：同一地址的新 create 依赖旧记录先释放唯一索引（WriteOrder 的 retire 阶段）。
		if (retires && stored !== undefined) writes.push(retireDocument(stored.id, stored.revision));
		if (prepared === undefined) return { kind: "retire" };
		const { version, fingerprint } = definition;
		// 纯退役（prepared 为空）已在上面返回；这里 prepared 一定存在。退役后重建与首次创建都走“创建新记录”。
		if (retires || stored === undefined) {
			const base = { version, fingerprint, value: prepared.value };
			const created = { id: 0 };
			// created 是可变单元格：createDocument 的回调在 store 步骤真正执行、分配 id 后才回填，返回的 StoredChange 与之共享该对象。
			// 序列化文本 JSON.stringify(prepared.value) 与 base.value 同时传入：文本入队，值用于记录。
			const write = createDocument(this.at(key), base, JSON.stringify(prepared.value), (id) => {
				created.id = id;
			});
			writes.push(write);
			return { kind: "create", version, created };
		}
		// 已有记录继续存在：默认存 delta；held.base、版本变化或 checkpointWhen 任一为真则整根存 base。
		// base 与 delta 是 DocumentContent 的两个分支，store 引擎按 kind 决定写入格式。
		const info = { deltasSinceBase: stored.deltasSinceBase };
		const base =
			held?.base === true ||
			stored.version !== version ||
			definition.checkpointWhen(prepared.value, prepared.ops, info);
		// held 的 ops 代表更早、尚未落盘的变更，必须排在新 ops 之前；若本次存 base，整根值已包含它们的效果。
		const ops = held === undefined ? prepared.ops : [...held.ops, ...prepared.ops];
		// content 的 kind 决定 store 写 base 还是 delta；text 必须与 content 对应（值 vs ops 数组）。
		const content: DocumentContent = base
			? { kind: "base", version, fingerprint, value: prepared.value }
			: { kind: "delta", version, ops };
		const text = JSON.stringify(base ? prepared.value : ops);
		// 用旧 revision 做乐观并发检查；store 步骤之后返回的新 revision 是旧值+1。
		writes.push(changeDocument(stored.id, stored.revision, content, text));
		// 存 base 时累计清零，否则加一；版本总是当前定义版本（新 base 的版本）。
		const deltasSinceBase = base ? 0 : stored.deltasSinceBase + 1;
		return { kind: "change", stored: { id: stored.id, revision: stored.revision + 1, version, deltasSinceBase } };
	}

	// 函数说明：构造某 key 的完整地址；输入 key，返回 DocumentAddress。
	// 空字符串键表示 singleton，不添加 key 字段；keyed 用展开复制，避免修改共享的 #address。
	/** The address of `key`: a singleton's (`""`) has no key. */
	at(key: string): DocumentAddress {
		return key === "" ? this.#address : { ...this.#address, key };
	}
}

/**
 * Throws when `definition` cannot read a document stored at `stored`'s version and fingerprint: a newer version than
 * the code's, or the same version with another fingerprint (D9). A load and a retirement check alike (R15).
 */
// 函数说明：读取前校验；输入存储的 version/fingerprint 与定义，成功无返回，失败抛普通 Error。
// 存储版本更高 → 旧代码不能读新形状；同版本不同指纹 → schema 改了却没升版本（D9）。
// 旧版本允许通过，由调用方 migrate；这里不检查 definition 是否有 migrate，交给 StateDefinition.migrate 报错。
// 错误是普通 Error，调用方（load/checkFound）用 asChordError 包成 unavailable 并让对象 broken。
export function checkReadable(
	stored: { readonly version: number; readonly fingerprint: string },
	definition: AnyDefinition,
): void {
	const { name, version, fingerprint } = definition;
	if (stored.version > version) {
		throw new Error(`${name}: stored at version ${stored.version}, newer than the code's ${version}`);
	}
	if (stored.version === version && stored.fingerprint !== fingerprint) {
		throw new Error(`${name}: stored with another schema at version ${version} (a schema changed without a bump)`);
	}
}

/** What is stored after a commit's `change` was adopted. */
// 函数说明：提交收养后，内存应记住的 Stored；输入 StoredChange，返回 Stored | undefined。
// retire → undefined（文档缺席）；create → revision 1、deltas 0、id 取步骤回填值；change/held → 返回其 stored。
// switch 覆盖了所有 kind，TS 可检查穷尽性；没有 default，新增 kind 时编译报错。
export function storedAfter(change: StoredChange): Stored | undefined {
	switch (change.kind) {
		case "retire":
			return undefined;
		case "create":
			return { id: change.created.id, revision: 1, version: change.version, deltasSinceBase: 0 };
		case "change":
		case "held":
			return change.stored;
	}
}
