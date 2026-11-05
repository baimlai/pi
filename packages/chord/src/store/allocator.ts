// The store's id allocator (slice 6b D3, §1.2): one counter for every id in the store (Durable's `mintId`, Chord's
// document ids), synchronous, raised by explicit ids, saturating at `Number.MAX_SAFE_INTEGER`.
// 本文件提供 store 内唯一的 id 计数器：所有文档和 Durable 的会话 id 都从这里取号，避免两个来源各自计数而碰撞。
// 上游是提交步骤（Step.ids）和导入/重放路径；它只改内存数字，持久化由调用方在同一事务里写入 meta 表。
// 所属模块：packages/chord/src/store 的 id 分配器。
// 上下游：Step 创建时用提交的 nextId 构造；导入/重放用归档的 nextId。依赖方在任何 SQL 之前同步取号。
// 结果：mint 返回 number 或抛 "ID space is exhausted"；value/raise 不产生 SQL；持久化由调用方写 meta。
// 能力清单：
// - FIRST_ID：首个可分配 id（1 预留给 Durable 根会话）。
// - IdAllocator：value getter、mint、raise 组成的同步计数器。
// 组合关系：构造(next) -> mint 发放并递增 -> 记录里的显式 id 用 raise 抬水位 -> 提交把 value 写入 meta。
// 示例：const allocator = new IdAllocator(FIRST_ID); allocator.mint(); // 2，随后 allocator.value === 3
// 阅读顺序：先 FIRST_ID 与 #next，再 value/mint 的边界，最后 raise 的饱和处理。

/** The first id the allocator gives: id 1 is Durable's root conversation. */
export const FIRST_ID = 2;

// const 表示绑定不能重新赋值；这个起点给 Durable 预留了 id 1，不代表 store 自动创建那条记录。

/**
 * The allocator: `value` is the next id it gives. An id raised to `Number.MAX_SAFE_INTEGER` is accepted, the value
 * stays there, and every later `mint` throws: no id past the safe range (it would stop counting exactly and repeat).
 */
// 计数器状态机：正常取号时递增；公开的 raise 只会抬高；一旦到达上限就饱和，后续 mint 抛错。
// 构造时不访问数据库，调用方必须传入正确起点（打开时从 meta 表读，导入时由归档给出）。
export class IdAllocator {
	// # 是 JavaScript 的运行时私有字段；只有本类代码能直接访问这个待发放的计数器。
	#next: number;

	/** 从调用者给的下一个 ID 开始计数，不读取数据库；例如参数为 5 时第一次 mint 返回 5。合法范围由打开/导入 store 的路径保证。 */
	constructor(next: number) {
		// 保存数字，不发放 ID，也不在构造阶段推进计数器。
		this.#next = next;
	}

	/** The next id `mint` gives; what each commit persists. */
	// 这是 getter：调用者写 allocator.value 读取，不调用方法；返回的是“下一个将发放”的数，不会消耗它。
	/** 同步读取当前计数器，不消耗 ID；例如 mint 前读到 5，mint 后读到 6，达到上限时该值仍停在上限。 */
	get value(): number {
		// getter 让调用者写 allocator.value；读取只返回数字，没有 SQL 副作用。
		return this.#next;
	}

	/** Takes the next id; throws "ID space is exhausted" once saturated (Durable's message). */
	/** 取一个 ID 并递增；若下一个值已到安全整数上限就抛错。例如从 5 开始连续调用得到 5、6；失败不会把计数器推进到不精确的整数。 */
	mint(): number {
		// >= 同时覆盖已饱和的情况；这里检查运行时的计数状态，不是检查 number 类型本身。
		if (this.#next >= Number.MAX_SAFE_INTEGER) throw new Error("ID space is exhausted");
		// 后置 ++ 先作为返回值取旧数，再将字段加一；即使以后的提交回滚，已发的数字也不回收。
		return this.#next++;
	}

	/** Raises the counter above `id`, an id written explicitly (Durable mints ahead), saturating. */
	/** 看见显式写入的 ID 时抬高水位，返回 void；较小 ID 不改变水位。例如当前 5 遇到 9 后变成 10，遇到 3 后仍为 5；不写数据库。 */
	raise(id: number): void {
		// Math.min 将新水位封顶；显式写入 MAX_SAFE_INTEGER 后 value 停在上限，后续 mint 会拒绝。
		if (id >= this.#next) this.#next = Math.min(id + 1, Number.MAX_SAFE_INTEGER);
	}
}
