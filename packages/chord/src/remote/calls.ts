// 本文件实现每条链路的调用名额：发送前排队，回复或取消后释放名额。
//
// 所属模块：packages/chord/src/remote（Chord v2 远端层）的流控基础件，由 ConsumerSide 为每条连接持有一个实例。
// 职责边界：只维护“已发送多少调用、谁在排队、何时放行”，不构造消息、不解析回复、不结算调用方 Promise。
// 上游入口：ConsumerSide.call 在发送前调用 submit；HostLink.opened 在对端 hello 到达后调用 opened。
// 下游依赖：QueuedCall 的 send 回调以及调用方维护的 hold 编号。
// 结果与错误流向：send 同步执行，抛出的异常原样传给调用者；窗口本身不制造错误，调用失败由消费端处理。
//
// 能力清单：
// - type QueuedCall：排队项契约，只有 hold 编号与 send 回调两个字段。
// - class CallWindow：泛型先进先出窗口；submit 立即发送或入队，opened 设置对端上限并排空，freed 归还名额，remove/removeHold 取消排队项，clear 在连接关闭时取出全部等待项。
//
// 组合关系：ConsumerSide 创建窗口；call 先 submit，hello 到达或调用结束触发 opened/freed，窗口再回调排队项的 send。
// 示例：const window = new CallWindow(); window.opened(2); window.submit({ hold: 7, send: () => sendCall(7) });
// 建议阅读顺序：先看 QueuedCall 与三个字段，再看 submit/freed 的主路径，最后看 removeHold/clear 这些清理路径。
// The call window (§3, decision log "Flow control: an ack-clocked window"): at most the peer's N calls in flight on a
// link from this host; further calls wait in one FIFO queue, sent in order as replies free slots.

/** A call waiting for a slot: its hold (a rebind or release takes it out) and what sends it. */
// 排队项保存所属 hold 编号与真正发送的回调；readonly 限制 TypeScript 赋值，不会冻结运行时对象。
export type QueuedCall = { readonly hold: number; readonly send: () => void };

/**
 * The calls of one link's consumer side. `limit` is the peer's N from its `hello` (0 before it, so every call waits).
 * A relay forwards its downstream calls at once, so only this host's own calls are counted here.
 */
// C 是泛型：可带额外字段，但至少满足 QueuedCall；省略类型参数时使用 QueuedCall。
// Set 按插入顺序迭代，且同一对象只存一次，因而作为先进先出队列使用。
export class CallWindow<C extends QueuedCall = QueuedCall> {
	// 握手前不知道对端容量，初始为 0，所有调用都等待。
	#limit = 0;
	// 记录已发送但还没有释放名额的调用数；# 表示 JavaScript 私有字段。
	#inFlight = 0;
	// Set 自身可以增删元素；readonly 仅禁止把字段重新指向另一个集合。
	readonly #waiting = new Set<C>();

	/** Sends `call` now when a slot is free and nothing waits, otherwise queues it behind the earlier calls. */
	// 提交一个调用；输入含发送回调，没有返回值。空队列且有名额时立即发送，否则保存在队尾。
	// 副作用是修改计数或队列并可能同步执行 send；例如上限 1 时第二次提交要等第一次 freed。
	submit(call: C): void {
		// 既要有空位，也不能越过先来的调用。
		if (this.#waiting.size === 0 && this.#inFlight < this.#limit) {
			// 先占用一个发送名额。
			this.#inFlight++;
			// 同步调用排队项提供的发送动作；结果不在窗口中等待。
			call.send();
			// 该路径完成，停止继续处理本次提交或队列。
			return;
		}
		// 没有立即发送条件时，保留调用对象供稍后放行。
		this.#waiting.add(call);
	}

	/** The peer's window arrived with its `hello`: waiting calls go out. */
	// 握手告诉我们对端并发上限 limit；保存上限并发送能够容纳的队列项，无返回值。
	// 例如握手前上限为 0，opened(2) 可放行最早两项；send 抛错不会在此吞掉。
	opened(limit: number): void {
		// 用握手值替换当前容量；这里信任已由协议层检查的数值。
		this.#limit = limit;
		// 容量变化后立即尝试发送等待项。
		this.#drain();
	}

	/** A call in flight ended (its reply, its abort sent, its hold released or gone): its slot is free. */
	// 一个已发送调用结束后释放一个名额并继续排队项，无参数或返回值。
	// 例如 2 个调用占满上限 2，回复一个便可发出下一个；调用者负责每项只释放一次。
	freed(): void {
		// 对应一个结束的已发送调用，归还名额。
		this.#inFlight--;
		// 容量变化后立即尝试发送等待项。
		this.#drain();
	}

	/** Takes a waiting call out (its caller cancelled); nothing happens for one that is not waiting. */
	// 按对象身份移除尚未发送的 call，无返回值；不改变已发送计数。
	// 例如取消排队调用只删队列项，不需要通知对端。
	remove(call: C): void {
		// 从等待集合移除该对象；删除不存在的元素没有效果。
		this.#waiting.delete(call);
	}

	/** Takes every waiting call of `hold` out and returns them (its hold rebinds or was released). */
	// 移除属于 hold 的所有排队调用并返回这些对象；不负责拒绝调用的 Promise。
	// 先遍历再按编号删除和收集；例如 hold 7 重新绑定时，旧方法编号的排队调用可由调用方统一拒绝。
	removeHold(hold: number): C[] {
		// 建立结果数组，C[] 表示泛型元素 C 的数组。
		const removed: C[] = [];
		// Set 的迭代保持插入顺序；迭代时删除当前项是允许的。
		for (const call of this.#waiting) {
			// 不同持有编号的调用保留，continue 跳到下一项。
			if (call.hold !== hold) continue;
			// 从等待集合移除该对象；删除不存在的元素没有效果。
			this.#waiting.delete(call);
			// 把刚移除的调用交给上层处理。
			removed.push(call);
		}
		// 返回移出的对象数组，保留顺序。
		return removed;
	}

	/** Takes every waiting call out and returns them (the link closed). */
	// 清空等待队列并返回原队列顺序的数组，不改已发送计数。
	// 例如链路关闭后调用者遍历结果拒绝 Promise；这里只收集排队项。
	clear(): C[] {
		// 展开运算符把集合元素收进新数组，不复制调用对象本身。
		const removed = [...this.#waiting];
		// 删掉所有等待项，已发送项不在该集合中。
		this.#waiting.clear();
		// 返回移出的对象数组，保留顺序。
		return removed;
	}

	/** Sends waiting calls in order while slots are free. */
	// 内部放行函数：按插入顺序消耗可用名额，无输入返回。
	// 发送前先删除并计数，避免回调再次进入时把同一项发两次；例如上限 1 只发送队首。
	#drain(): void {
		// Set 的迭代保持插入顺序；迭代时删除当前项是允许的。
		for (const call of this.#waiting) {
			// 容量用完就结束；剩余项留待下一次 freed。
			if (this.#inFlight >= this.#limit) return;
			// 从等待集合移除该对象；删除不存在的元素没有效果。
			this.#waiting.delete(call);
			// 先占用一个发送名额。
			this.#inFlight++;
			// 同步调用排队项提供的发送动作；结果不在窗口中等待。
			call.send();
		}
	}
}
