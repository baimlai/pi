// 通用的后进先出快照栈，供 Input/Editor 在修改前保存状态、撤销时取回；只存与取状态，不负责什么时候合并编辑，也没有 redo、容量上限或磁盘持久化。
/**
 * Generic undo stack with clone-on-push semantics.
 *
 * Stores deep clones of state snapshots. Popped snapshots are returned
 * directly (no re-cloning) since they are already detached.
 */
// <S> 是泛型类型参数，调用方如 UndoStack<InputState> 指定快照形状；只约束编译期，不能保证 S 中所有值都能被 structuredClone 克隆。
export class UndoStack<S> {
	// 每个实例自己的快照数组，尾部是最近一次状态。
	private stack: S[] = [];

	/** Push a deep clone of the given state onto the stack. */
	// 深复制 state 再压栈，返回 void，不修改传入对象；复制失败会抛错，因 push 参数先求值，此时尚未加入新项。
	// 例：push({cursor:1}) 后调用者把原对象改成 2，旧快照仍为 1；含函数等不可克隆值的状态会失败。
	push(state: S): void {
		// structuredClone 先复制可克隆结构，成功后才 push；克隆规则由运行时定义，不是 JSON 序列化，也不冻结结果。
		this.stack.push(structuredClone(state));
	}

	/** Pop and return the most recent snapshot, or undefined if empty. */
	// 弹出并返回最近快照或 undefined，修改栈但不再克隆快照。例：先 push A 再 push B，第一次 pop 得 B，第二次得 A；调用者自行把它写回编辑状态。
	pop(): S | undefined {
		// 直接返回数组 pop 的结果，空栈自然为 undefined，弹出对象之后由调用者持有。
		return this.stack.pop();
	}

	/** Remove all snapshots. */
	// 丢弃全部快照，无参数/返回值，不修改快照曾复制自的原状态，也不执行编辑器恢复。例：开始独立会话时 clear()，后续 pop 得 undefined。
	clear(): void {
		// 把现有数组长度设 0，释放栈对各快照的引用。
		this.stack.length = 0;
	}

	// 只读访问器返回还可弹出的快照数，无副作用。例：压入两次后 length 为 2，pop 一次后为 1。
	get length(): number {
		// 返回数组项数，不计算对象大小或文本长度。
		return this.stack.length;
	}
}
