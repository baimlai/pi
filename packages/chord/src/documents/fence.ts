// The seal fence (slice 6a §1.3): the token an attempt, a job run's invocation or the object itself hands its
// transactions. Once sealed, new transactions under it are refused `released` and the open one is discarded.

// 文件导读
// 所属：packages/chord/src/documents，Chord 文档层的封条机制。
// 职责边界：只提供单向布尔开关；不负责切断事务、不管理尝试或对象生命周期，那些由 Documents.fence/#cut 完成。
// 上游：Documents 为每次尝试、单次任务或对象自身持有 token；下游：Transaction、Documents.onLine、KeyedSlot 的冷加载检查 token.sealed。
// 结果/错误：seal() 无错误；sealed 为 true 后，使用方抛 released（ended/version/discarded 等由调用点决定）。
// 能力清单：SealToken 类（#sealed 私有字段、sealed getter、seal() 方法）。
// 组合关系：尝试结束 → token.seal() → Documents 拒绝新事务/工作；对象结束 → own.seal() + #cut() 丢弃在途事务。
// 示例：const token = new SealToken(); token.seal(); token.sealed === true。
// 阅读顺序：先看 SealToken，再看 documents.ts 的 fence/assertAdmitted/tx 与 transaction.ts 的 cut。
/** One seal token; sealed once, never unsealed. */
export class SealToken {
	// #sealed 是 ECMAScript 私有字段：运行期外部无法访问（写 token.#sealed 是语法错误），不同于 TS 的 private（仅编译期）。
	// 初值 false；只有 seal() 会改成 true，之后不再回退。
	#sealed = false;

	// 函数说明：get sealed 返回当前状态；无输入，输出 boolean，无副作用。例：if (token.sealed) throw ...。
	// getter 让调用方按属性读取（token.sealed），返回当次快照；封条状态只由对象自身推进。
	/** Whether work under this token is refused. */
	get sealed(): boolean {
		return this.#sealed;
	}

	// 函数说明：seal() 永久置位；无输入输出，副作用是让后续 assertAdmitted/onLine 拒绝新工作。
	// 重复调用安全（幂等）；这里不切断持线事务，调用者必须走 Documents.fence 才能立即丢弃在途工作。
	// 例：documents.fence(token) 先 token.seal()，再检查当前 holder 是否属于该 token 并 cut。
	/** Seals the token; `Documents.fence` also discards the transaction it holds open. */
	seal(): void {
		this.#sealed = true;
	}
}
