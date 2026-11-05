// Claims (slice 6b "owner names and claims", "claims per table and per document namespace"): what can collide in a
// store is claimed once, in memory: a table by its SQL name, documents by `(owner, namespace)`. A claim is held by its
// claimant (an object, a `StoreStorage`) until its end releases every claim it holds. While a batch applies, nothing
// is claimed: batch apply and owners exclude each other both ways.

// 文件导读
// 所属：packages/chord/src/store（store 层，内存占用登记）。
// 职责边界：只记录谁占用了哪个表名或文档分区，以及批量重放锁；不读写数据库，不创建表。
// 上游：表句柄/文档对象激活时调用 table/documents；reload 用 assertTable/assertDocuments 预检查；批量重放用 lock。下游：冲突以 invalid/args 抛给调用方，held 供批量重放前判断。
// 能力清单：
// - Claimant：占用者身份，label 只用于错误文本；
// - Claims：占用登记表，持有正向与反向两个 Map；
// - held：是否还有任何占用（按占用者数量判断）；
// - table/documents：登记完整 SQL 表名或 owner+namespace 分区；
// - assertTable/assertDocuments：只检查冲突、不登记；
// - lock：批量重放期间拒绝新占用，返回解锁闭包；
// - release：删除一个占用者的全部登记。
// 组合顺序：激活时 table/documents 登记 -> 使用期间持有 -> 结束时 release；批量重放前确认 !held -> lock() -> apply -> unlock。
// 示例：const claims = new Claims(); claims.table("notes:items", a); claims.table("notes:items", b) 抛 invalid/args；claims.release(a) 后 held 为 false。
// 建议阅读顺序：Claimant/Claims 字段 -> table/documents/assert* -> lock/release -> #claim/#assert。

import { invalid } from "../data/internal.ts";

/** Who holds claims: named in the refusal of a second claim. */
export type Claimant = { readonly label: string };

// Claimant 是占用者对象的类型：label 用于错误消息；Map 按对象身份区分占用者，同名 label 不等于同一个占用者。

/** A store's claims, by key; one claimant per key. */
export class Claims {
	// 正向索引：一个表或文档分区的键对应一个占用者；反向索引让释放只遍历该占用者自己的键。
	readonly #holders = new Map<string, Claimant>();
	readonly #keys = new Map<Claimant, string[]>();
	/** Whether a batch applies now: no claim is taken meanwhile. */
	#locked = false;

	/** Whether any claimant holds a claim (batch apply is refused then: its memory would go stale). */
	// 是否至少有人占用一个资源；只读内存索引，无副作用。例如最后一位占用者 release 后返回 false，不表示数据库没有数据。
	get held(): boolean {
		// 反向 Map 每个键是一位仍有占用记录的调用者；size 是人数而不是表数。
		return this.#keys.size > 0;
	}

	/** Claims table `table` (its SQL name) for `claimant`; held by another: `invalid/args`. */
	// 为占用者登记完整 SQL 表名，冲突或批量重放锁定时抛 invalid/args；成功无返回值。例如 a 占用 notes:items 后 b 不能再占用它。
	table(table: string, claimant: Claimant): void {
		// JSON.stringify 保留表名的引号与转义；前缀使表键和文档分区键属于不同空间。
		this.#claim(`table ${JSON.stringify(table)}`, claimant);
	}

	/** Claims the documents of `owner` in `namespace` for `claimant`; held by another: `invalid/args`. */
	// 占用 owner 与 namespace 的组合，不涉及具体文档键；例如同一 owner 的 chord 与 session 分区可以由不同对象占用，冲突规则与 table 相同。
	documents(owner: string, namespace: string, claimant: Claimant): void {
		// 对二元数组编码能区分 ["a","bc"] 与 ["ab","c"]，不会靠含糊的字符串拼接构造身份。
		this.#claim(`documents ${JSON.stringify([owner, namespace])}`, claimant);
	}

	/** Throws as `table` would for `claimant`, claiming nothing (a reload's staging checks its declarations). */
	// 预先检查表能否被占用但不登记；用于 reload 试声明。例如对空闲表调用两次都通过，held 仍不会因此变成 true。
	assertTable(table: string, claimant: Claimant): void {
		// 与真正登记共用同一种键和冲突检查，避免预检查与执行阶段判断不同。
		this.#assert(`table ${JSON.stringify(table)}`, claimant);
	}

	/** Throws as `documents` would for `claimant`, claiming nothing. */
	// 预检查文档分区的占用资格，无内存登记；例如 reload 可先检查同一 owner/namespace，真正激活后再调用 documents。
	assertDocuments(owner: string, namespace: string, claimant: Claimant): void {
		// 使用与 documents 完全相同的分区键，失败直接向调用者抛出。
		this.#assert(`documents ${JSON.stringify([owner, namespace])}`, claimant);
	}

	/** Refuses every claim (`invalid/args`) until the returned unlock: a batch applies meanwhile. */
	// 标记批量重放正在占用 store，并返回解除锁定的闭包；调用者负责在完成或失败后调用它。例如 const unlock = claims.lock(); try { … } finally { unlock(); }。
	lock(): () => void {
		// 本方法仅置位，不自行检查 held；applyBatch 在调用前检查是否存在所有者。
		this.#locked = true;
		// 箭头函数捕获当前 this；解除的是这一个 Claims 实例的锁，没有 SQL 操作。
		return () => {
			this.#locked = false;
		};
	}

	/** Releases every claim `claimant` holds. */
	// 删除一个占用者的全部登记，无返回值；未知占用者等同于空操作。例如释放 a 不会解除 b 的其他表占用。
	release(claimant: Claimant): void {
		// ?? [] 在没有反向索引时提供空数组；for…of 逐个清除该占用者的正向索引。
		for (const key of this.#keys.get(claimant) ?? []) this.#holders.delete(key);
		// 最后删除反向项，使 held 能准确反映是否还有任何占用。
		this.#keys.delete(claimant);
	}

	// 检查并登记一个内部资源键，同一占用者重复登记不重复计数；例如 a 连续声明同一表只保存一份键，其他占用者或锁定状态会抛错。
	#claim(key: string, claimant: Claimant): void {
		// 先检查再修改，冲突时两个索引都不受影响。
		this.#assert(key, claimant);
		// 同一对象的重复声明是幂等的，不向反向数组再加一项。
		if (this.#holders.get(key) === claimant) return;
		// 登记正向关系；只有检查已确认键空闲后才会到这里。
		this.#holders.set(key, claimant);
		// 取该占用者已有的资源列表，没有时创建列表，否则就地追加。
		const keys = this.#keys.get(claimant);
		if (keys === undefined) this.#keys.set(claimant, [key]);
		else keys.push(key);
	}

	/** Refuses `key` to `claimant` while a batch applies or another claimant holds it. */
	// 内部只读检查：批量重放期间全部拒绝，已有占用者与申请者不是同一对象时拒绝；例如同 label 的两个对象仍冲突，成功时不返回数据。
	#assert(key: string, claimant: Claimant): void {
		// 锁定检查先于占用者身份判断，所以原占用者在锁定时也不能重复申请。
		if (this.#locked) throw invalid("args", `store: ${key} cannot be claimed while a batch applies`);
		// Map.get 的结果可能为 undefined；这是运行时登记状态，而非外部输入的形状校验。
		const holder = this.#holders.get(key);
		// && 要求已有占用且属于别人；错误只展示 label，不暴露整个对象。
		if (holder !== undefined && holder !== claimant)
			throw invalid("args", `store: ${key} is claimed by ${holder.label}`);
	}
}
