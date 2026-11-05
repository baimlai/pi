// 模型适配器把增量事件 push 到这里；Agent 用 for await 消费它，用 result() 等一条最终回答。
// 只导入类型：一个表示完整模型消息，一个表示 start/delta/done 等事件的联合类型。
import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

// 内部先进先出队列；泛型 T 让它既能存事件，也能存等待者回调，内部用两个栈避免频繁 shift。
class FifoQueue<T> {
	// 新数据先放入 incoming；private 是 TS 的访问限制。
	private incoming: T[] = [];
	// 待取数据放入 outgoing，顺序与 incoming 相反，pop 即可取最早值。
	private outgoing: T[] = [];

	// 用途：读取队列总长度。get 让调用者写 queue.length 而不是 length()；没有修改队列。
	get length(): number {
		// 两边数组中的元素合起来，才是全部尚未消费的数据。
		return this.incoming.length + this.outgoing.length;
	}

	// 用途：把一个值放到队尾。例依次 enqueue(A)、enqueue(B)，后面会先得到 A；直接修改 incoming。
	enqueue(value: T): void {
		// push 追加到 incoming 末尾，单次入队无需重排已有元素。
		this.incoming.push(value);
	}

	// 用途：取走最早值；队列空时返回 undefined。例队内 A/B 两项，第一次取 A，下一次取 B。
	dequeue(): T | undefined {
		// 只有输出栈用完才搬运输入栈，避免每次出队都重排。
		if (this.outgoing.length === 0) {
			// 把输入栈全部倒过来，最早入队的元素会来到输出栈顶部。
			while (this.incoming.length > 0) {
				// ! 是非空断言：while 已保证有元素，TS 无法从数组长度一直推导 pop 的结果。
				this.outgoing.push(this.incoming.pop()!);
			}
		}
		// 取输出栈顶部；两边都空时 pop 自然返回 undefined。
		return this.outgoing.pop();
	}
}

// Generic event stream class for async iteration
// 事件流：T 是逐个事件类型，R 是最终汇总结果，默认与 T 相同。implements 只检查协议实现；for await 依赖下方 Symbol.asyncIterator 方法。
export class EventStream<T, R = T> implements AsyncIterable<T> {
	// 生产快于消费时暂存事件，保证先产生的先交付。
	private queue = new FifoQueue<T>();
	// 消费快于生产时暂存 Promise 的 resolve；IteratorResult 区分有值与迭代结束。
	private waiting = new FifoQueue<(value: IteratorResult<T>) => void>();
	// 是否不再接受新事件；protected 允许下面的子类计时逻辑读取。
	protected done = false;
	// 整个流的最终结果 Promise；它与逐个事件的异步迭代是两种读取方式。
	private finalResultPromise: Promise<R>;
	// ! 表示构造时一定会赋值；保存 resolve，便于 push/end 在稍后确定结果。
	private resolveFinalResult!: (result: R) => void;
	// 由使用者决定哪种事件是终止事件，通用流本身不固定事件字段。
	private isComplete: (event: T) => boolean;
	// 终止事件到最终结果的提取函数，例如从 done 事件里取完整 assistant 消息。
	private extractResult: (event: T) => R;

	// 用途：建立流并接好终止判断和结果提取。例判断 event.type==="done"，提取 event.message；只初始化，不启动网络。
	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		// 保存判断函数的引用，以后每次 push 时调用。
		this.isComplete = isComplete;
		// 保存终止结果提取规则。
		this.extractResult = extractResult;
		// 最终结果的等待器在创建流时就准备好。
		this.finalResultPromise = new Promise((resolve) => {
			// 把 resolve 放进实例字段，终止事件到来时可从其他方法调用。
			this.resolveFinalResult = resolve;
		});
	}

	// 用途：生产者送入一条事件；如果有人正在等待就立即交付，否则入队。终止事件也会作为普通最后一项交给迭代器，同时 resolve 最终结果。
	push(event: T): void {
		// 流终止后迟到事件被忽略，不能重开流或改掉最终结果。
		if (this.done) return;

		// 用构造时注入的规则判断是否为最后事件。
		if (this.isComplete(event)) {
			// 标记后续 push 不再生效；已排队事件仍可由迭代器读取。
			this.done = true;
			// 从终止事件取 R，让 result() 的等待者拿到最终汇总值。
			this.resolveFinalResult(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		// 优先找最早正在等下一条事件的消费者。
		const waiter = this.waiting.dequeue();
		// 确有等待者时，无需把事件绕道存进事件队列。
		if (waiter) {
			// 交付当前事件；即便它是终止事件，这次仍返回 done:false，保证消费者能看到最后事件。
			waiter({ value: event, done: false });
		} else {
			// 没有等待者就保存到队尾，后面启动迭代时再读。
			this.queue.enqueue(event);
		}
	}

	// 用途：显式结束流并唤醒等待者。可传最终结果；不传时仅结束迭代，若从未有终止事件，result() 仍可能未完成，不能把这两件事混为一谈。
	end(result?: R): void {
		// 标记后续 push 不再生效；已排队事件仍可由迭代器读取。
		this.done = true;
		// 只有明确传了最终值才尝试完成汇总 Promise。
		if (result !== undefined) {
			// 传入的最终结果成为 R；Promise 若已经完成，后续 resolve 不会改变结果。
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		// 所有正在等待下一项的消费者都应知道流结束，不让等待挂住。
		while (this.waiting.length > 0) {
			// 循环条件已经保证队列非空，! 告诉 TS 这里存在回调。
			const waiter = this.waiting.dequeue()!;
			// 迭代结束时 done:true，value 不再有实际事件意义；这里原有断言是协议适配。
			waiter({ value: undefined as any, done: true });
		}
	}

	// 用途：实现异步生成器。async * 允许既 await 等事件又 yield 逐项交付；for await (const event of stream) 会调用此协议方法。
	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		// 不断取下一项，直到 done 分支 return 结束本次迭代。
		while (true) {
			// 已有积压时先消费；终止状态也不会丢掉已排队事件。
			if (this.queue.length > 0) {
				// yield 将最早事件交给外部循环，然后暂停到它要下一项；非空断言对应上面的长度判断。
				yield this.queue.dequeue()!;
				// 队列空且流已结束时，已无事件可交付。
			} else if (this.done) {
				// 结束当前分支所在的函数；在异步生成器中表示迭代结束。
				return;
			} else {
				// 暂时无数据就把 resolve 排进等待队列；push 或 end 会唤醒这个 await。
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.enqueue(resolve));
				// end 送来的结束通知让生成器退出。
				if (result.done) return;
				// push 送来的事件继续交给外部 for await。
				yield result.value;
			}
		}
	}

	// 用途：等待最终汇总结果，不消费中间事件。例 await response.result() 得到完整 AssistantMessage；多次调用复用同一个 Promise。
	result(): Promise<R> {
		// 返回构造时建立的结果 Promise，而不是拼装当前队列内容。
		return this.finalResultPromise;
	}
}

/**
 * Event stream of one assistant response. It also times the response: the final message (`done` or `error` event, or
 * the result passed to `end()`) gets `durationMs`, measured with a monotonic clock from the stream's creation, unless
 * the message already has one or its `timestamp` predates the stream. A stream that forwards a response which started
 * elsewhere, such as a deferred result fetched later, therefore leaves it untimed.
 */
// 专用于一条模型回答的事件流；基类 T/R 分别固定为事件和完整消息，并增加耗时记录。
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	// # 是 JavaScript 真正的私有字段；墙上时钟用来判断消息是否早于此流产生。
	readonly #startedAt = Date.now();
	// 单调时钟用于计算时长，不受系统时间被调整影响。
	readonly #startedAtMonotonic = performance.now();

	// 用途：把 done/error 两种终止事件接到基类。创建时开始计时；异常结果同样能通过 result() 得到一条完整错误消息。
	constructor() {
		// 子类构造器先初始化基类，将下面两个函数作为终止/取结果的策略。
		super(
			// done 与 error 都终止单次模型流；text_delta 等不会终止。
			(event) => event.type === "done" || event.type === "error",
			// 终止后从相应事件字段提取完整消息。
			(event) => {
				// type 标签收窄联合类型，TS 知道该分支有 message 字段。
				if (event.type === "done") {
					// 正常完成时使用供应商整理好的最终消息。
					return event.message;
					// 错误事件里的 error 字段仍是 AssistantMessage，不是裸 Error。
				} else if (event.type === "error") {
					// 结果 Promise 会 resolve 错误消息，错误状态由 stopReason 等字段表达。
					return event.error;
				}
				// 提取器本应只接到终止事件；若协议使用错误，明确暴露问题。
				throw new Error("Unexpected event type for final result");
			},
		);
	}

	// 用途：在发布最终事件前补耗时，再走基类队列。override 让 TS 确认父类确有同名方法。
	override push(event: AssistantMessageEvent): void {
		// 正常完成结果先尝试记录耗时。
		if (event.type === "done") this.#time(event.message);
		// 失败结果也记录已花时间，便于统一展示。
		else if (event.type === "error") this.#time(event.error);
		// 保持基类事件交付与结果 Promise 的完整行为。
		super.push(event);
	}

	// 用途：显式结束并给出消息时也计时，覆盖没有通过 done/error 事件结束的路径。
	override end(result?: AssistantMessage): void {
		// 只有有最终消息可修改时才调用计时逻辑。
		if (result !== undefined) this.#time(result);
		// 仍由基类标记结束并唤醒消费者。
		super.end(result);
	}

	// 用途：只为本流新产生且未计时的消息补 durationMs。例晚些时候获取的旧 deferred 回答不在这里冒充“刚开始生成”的耗时；会修改传入消息。
	#time(message: AssistantMessage): void {
		// 已有耗时、消息早于该流、或流已结束，均保持原消息计时信息。
		if (this.done || message.durationMs !== undefined || message.timestamp < this.#startedAt) return;
		// 取单调时钟差并四舍五入为毫秒，Math.max 保证不出现负时长。
		message.durationMs = Math.max(0, Math.round(performance.now() - this.#startedAtMonotonic));
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
// 用途：给扩展提供简便工厂。例 const stream=createAssistantMessageEventStream()，再由适配器 push 事件；不创建网络连接。
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	// 每次返回独立流，队列、结果 Promise 和计时器互不共用。
	return new AssistantMessageEventStream();
}
