// An object's line (§9): its transactions, cold loads, key pages and eviction sweeps run on it one at a time, in the
// order they asked.

// 文件导读
// 所属：packages/chord/src/documents，对象级串行执行器。
// 职责边界：只排队；不执行 job、不处理错误、不做超时或取消；错误与释放由调用者（Documents.onLine/tx）负责。
// 上游：Documents.tx 与 onLine；下游：调用者拿到 release，在 finally 中释放，让下一个持有者继续。
// 结果/错误：acquire 不会因前序工作失败而 reject；但若调用者不 release，队列会永久阻塞，所以必须用 finally。
// 能力清单：Line 类（#tail 链尾，acquire() 返回 release）。
// 组合关系：每个对象一个 Line；事务持有线期间完成草拟/提交，冷加载与分页也排在它后面；退出时 release。
// 示例：const release = await line.acquire(); try { await work(); } finally { release(); }。
// 阅读顺序：先看 acquire 的 promise 链，再看 documents.ts 的 onLine/tx 如何配对 release。
/** An object's line: `acquire()` resolves with the release once every earlier holder released; releasing twice is harmless. */
export class Line {
	// #tail 永远指向“最后一个排队者的完成 Promise”；初值已 resolve，第一个 acquire 立即通过。
	// 它不保存值，只保存顺序；每个新持有者把自己尚未完成的 promise 接到链尾。
	#tail: Promise<void> = Promise.resolve();

	// 函数说明：acquire() 排队取得对象线；无参数，返回 Promise<release>；副作用是推进 #tail。
	// 主要流程：withResolvers 造出本次 promise/resolve；换掉链尾；等旧链尾完成后把 resolve 交给调用者。
	// Promise.withResolvers 一次得到 { promise, resolve, reject }；这里只用 promise 与 resolve，不产生额外 Promise。
	// previous.then(() => resolve) 的返回值就是 resolve 函数本身：调用者 await 到的是“释放函数”，不是工作结果。
	// 链上的 promise 只会被 release 的 resolve 完成，不会携带前序工作的错误；因此调用者必须保证 release（通常用 finally）。
	// 重复 release 无副作用：Promise 的 resolve 第二次调用被忽略。
	/** Resolves with this holder's release once every earlier holder released. */
	acquire(): Promise<() => void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const previous = this.#tail;
		this.#tail = promise;
		return previous.then(() => resolve);
	}
}
