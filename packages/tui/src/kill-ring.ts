// 保存 Input/Editor 成段删除的文本，支持之后粘回与轮换旧记录；它不是系统剪贴板，是否累积由上层 lastAction 决定。内部用可增长数组，没有容量上限或自动淘汰。
/**
 * Ring buffer for Emacs-style kill/yank operations.
 *
 * Tracks killed (deleted) text entries. Consecutive kills can accumulate
 * into a single entry. Supports yank (paste most recent) and yank-pop
 * (cycle through older entries).
 */
// 无显式构造函数，new KillRing() 依字段初值得到空记录环；类本身不决定何时删除或插入编辑器文字。
export class KillRing {
	// 数组尾部是当前可粘回条目，rotate 会改变顺序；private 是编译期外部访问限制。
	private ring: string[] = [];

	/**
	 * Add text to the kill ring.
	 *
	 * @param text - The killed text to add
	 * @param opts - Push options
	 * @param opts.prepend - If accumulating, prepend (backward deletion) or append (forward deletion)
	 * @param opts.accumulate - Merge with the most recent entry instead of creating a new one
	 */
	// 保存删文或合并到当前条目，无返回值，原地修改环；输入为文本和包含 prepend/可选 accumulate 的对象。
	// 例：先存 "bar" 再向后删 "foo " 且累积，prepend:true 得 "foo bar"；空文本跳过，未开启累积就建立独立条目，不写终端或系统剪贴板。
	push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
		// 空字符串没有可恢复内容，直接不操作。
		if (!text) return;

		// 只有明确的 truthy accumulate 且已有条目时才合并，空环仍走新建分支。
		if (opts.accumulate && this.ring.length > 0) {
			// 弹出当前尾项；! 是 TypeScript 非空断言，前面的 length 条件说明普通数组状态下存在项。
			const last = this.ring.pop()!;
			// prepend 决定新删文放在旧条目前还是后，合并后再作为尾项存回，条目数不变。
			this.ring.push(opts.prepend ? text + last : last + text);
			// 没有可合并目标或未要求累积时，新建条目。
		} else {
			// push 将新删文追加到尾部，成为新的当前条目。
			this.ring.push(text);
		}
	}

	/** Get most recent entry without modifying the ring. */
	// 读取当前删文，返回字符串或 undefined，无副作用，不从环中移除。例：多次 peek 可得到同一文字，空环返回 undefined。
	peek(): string | undefined {
		// 数组非空读取最后一项，否则显式返回 undefined；字符串按值返回，不需克隆。
		return this.ring.length > 0 ? this.ring[this.ring.length - 1] : undefined;
	}

	/** Move last entry to front (for yank-pop cycling). */
	// 轮换当前记录，无参数/返回值；多于一项时把尾项移到首部，使倒数第二项成为新的当前条目。
	// 例：["first","second","third"] 变 ["third","first","second"]，再 peek 得 second；0/1 项不操作，不改变编辑器正文。
	rotate(): void {
		// 至少两项才有轮换意义。
		if (this.ring.length > 1) {
			// 先取出原尾项，非空断言不生成运行时检查。
			const last = this.ring.pop()!;
			// unshift 原地插到首部，后续 peek 仍读取新的尾部。
			this.ring.unshift(last);
		}
	}

	// 只读访问器返回条目数，无副作用。例：累积删除不会增加项数，独立 push 才增加；这里不是所有文本的字符总数。
	get length(): number {
		// 读取数组长度。
		return this.ring.length;
	}
}
