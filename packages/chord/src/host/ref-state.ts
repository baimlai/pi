// The state of a reference (§7): loading, live, failed or ended; and `ref.state`, the native watchable that follows
// it.

// 所属：packages/chord/src/host 的引用状态模块（设计 §7）：ref.state 背后的状态源。
// 职责边界：把 Binding 的当前状态读取并广播给监视者；不决定绑定如何变化，也不保存第二份权威状态。
// 上游：reference.ts 的 Binding 创建 ReferenceState 并在状态变化时调用 moved/released；ref.state 返回该 NativeSource。
// 下游：ref.state.watch 的订阅者（应用、derive、链接层）逐状态收到通知；释放时以 ended 错误结束所有 watch。
// 结果与错误：状态对象是判别联合；释放时 released(ended) 把错误作为最后通知，不抛给调用者。
// 能力清单：
// - RefState：loading/live/failed/ended 四态联合。
// - Failed/Ended：Extract 出的失败分支与结束分支类型。
// - LOADING/LIVE：无字段状态共享常量，重复读取不产生“新状态”。
// - ReferenceState：NativeSource<RefState> 子类；value 读取最新状态，watch 建立订阅，moved 标记变化，
//   released 结束全部订阅，#mark 在批次中通知 derive。
// 组合与典型顺序：Binding 状态变化 -> moved() -> #mark 安排批次通知 -> watch 的监听者收到帧；
// 引用释放 -> released(error) -> 每个 watch 以 ended 结束并清空。
// 示例：const state = new ReferenceState(() => binding.state, batch);
//       const watch = await state.watch(context);
//       // binding 状态变化后，watch 的下一次读取得到新的 RefState
// 建议阅读顺序：RefState/Failed/Ended -> LOADING/LIVE -> ReferenceState 字段/构造 -> value -> watch -> moved/released -> #mark。
import { BACKGROUND_CONTEXT, type Context } from "../context/index.ts";
import type { ChordError, FailureCause } from "../data/index.ts";
import { type Batch, NativeSource } from "../state/internal.ts";
import { NativeWatch } from "../watch.ts";

/**
 * Where a reference stands. `loading`: its object activates, retries or is parked on dependencies still under way, it
 * waits for its host's publication or a parent link, or its link is down (the reference's coarser view of its object's
 * waiting and activating); `failed`: its object failed and no attempt runs (`transient`: `retryAt` is when its backoff
 * retries it; `broken`: no automatic retry), or nothing fits it or its object is parked on a failed dependency
 * (`waiting`: an event wakes it, `retryAt` undefined); `live`: bound; `ended`: for good, with the error that says why
 * (`released` without a reason: released by its holder; `released/ended`: its object ended; `released/closed`: its
 * host closed; `forbidden/revoked`).
 */
// kind 是联合类型的区分字段：先判断 kind，TypeScript 才允许读该分支的专有字段。
// readonly 约束开发期赋值，并不在运行时冻结对象；retryAt 是毫秒时间戳或 undefined。
export type RefState =
	| { readonly kind: "loading" }
	| { readonly kind: "live" }
	| { readonly kind: "failed"; readonly cause: FailureCause; readonly retryAt: number | undefined }
	| { readonly kind: "ended"; readonly error: ChordError };

/** A failed reference's state. */
// Extract 从联合类型中挑出 kind 为 failed 的成员；它不执行任何运行时校验。
export type Failed = Extract<RefState, { readonly kind: "failed" }>;

/** An ended reference's state. */
// 同样抽出 ended 分支，因此调用 released 时可以直接读取 error。
export type Ended = Extract<RefState, { readonly kind: "ended" }>;

/** The states without fields, one object each: a change of state is a new object (a native watch compares by identity). */
// 无附加数据的状态共用对象；NativeWatch 比较对象身份，因此重复使用 LOADING 不算一次新变化。
export const LOADING: RefState = { kind: "loading" };

// LIVE 同样复用；失败和结束则另外创建含原因的状态对象。
export const LIVE: RefState = { kind: "live" };

/**
 * `ref.state`, a native source: its value is the reference's state, read through `read`; each watch gets every new
 * state, in its own context (not one call per batch, as a followed source's), and ends `ended` when the reference is
 * released (the end is the notification). Derives reading it are marked in a batch of its own when it changes.
 */
// ReferenceState 继承可给 derive 提供输入的 NativeSource；它另管自己的状态监听器，逐状态发送通知。
export class ReferenceState extends NativeSource<RefState> {
	// # 是 JavaScript 私有字段；read 回调读取 Binding 的最新状态，避免维护第二份权威状态。
	readonly #read: () => RefState;
	/** The watches with the contexts they were taken in, which their frames carry. */
	// Map 把监听器关联到创建它的上下文；发送帧时保留各订阅者的上下文。
	readonly #watches = new Map<NativeWatch<RefState>, Context>();
	/** The state the watches have: a change is announced only when the state is another object. */
	// 缓存上次已通知的状态引用，用 === 判断是否真有下一步。
	#last: RefState;

	// 创建状态源，输入读取回调和可选批次，不启动监听或计时。
	// 先初始化父类，再记住回调和初始状态；例如刚 hold 的引用初始读到 loading。
	constructor(read: () => RefState, batch: Batch | undefined) {
		// 父类保存批次；undefined 表示此源已经无需持有宿主批次。
		super(batch);
		// 保存回调本身，后续每次读取都调用它。
		this.#read = read;
		// 初始快照仅用来去重，不复制状态对象。
		this.#last = read();
	}

	// 读取最新状态，无参数也不主动通知监听器；例如 ref.state.value.kind 可为 live。
	get value(): RefState {
		// 调用引用提供的读取函数，直接返回原状态对象。
		return this.#read();
	}

	/** Every state in order: a watch sees each step it went through. */
	// 为 context 创建状态监听，返回 Promise 包装的 NativeWatch；取消上下文会停止该监听。
	// 已有结束状态时返回已结束的监听；否则注册删除回调。例：await ref.state.watch(ctx) 取得当前状态。
	async watch(context: Context): Promise<NativeWatch<RefState>> {
		// 先读取本次订阅的起始状态。
		const state = this.#read();
		// 保存父类批次，后面的分支可把 undefined 缩窄掉。
		const batch = this.batch;
		// An ended reference has nothing more to announce, and keeps no host to report to.
		// 源无批次或引用已结束时，不再登记任何后续监听。
		if (batch === undefined || state.kind === "ended") {
			// 用当前状态创建监听；两个空回调分别表示无需解绑，也无需向宿主报告监听错误。
			const ended = new NativeWatch<RefState>(state, IGNORE, IGNORE);
			// 立即结束监听，closed 会完成；结束本身就是终止通知。
			ended.end({ kind: "ended" });
			// async 会把已结束的对象包装成已完成 Promise。
			return ended;
		}
		// 禁止在批次计算/发布的重入位置订阅；这是运行时的时序约束。
		batch.assertOutside("watch");
		// 停止时删除自己的 Map 项；监听函数出错则交给批次的 reportListener。
		const watch = new NativeWatch<RefState>(state, () => this.#watches.delete(watch), batch.reportListener);
		// 记住监听及其上下文，以后 moved 会逐项发送。
		this.#watches.set(watch, context);
		// 上下文带取消信号才观察它；取消只结束此监听。
		if (context.abortSignal !== undefined) watch.observeAbort(context.abortSignal);
		// 把注册完成的监听交给调用方，调用方之后可 start 安装处理函数。
		return watch;
	}

	/** The reference's state may have changed: every watch gets it when it is another state, derives are marked. */
	// 引用通知可能变动时调用；读取当前状态、按身份去重、逐监听发送，再标记依赖它的 derive。
	// 无返回值；例如 loading 变 live 发一次，重复通知同一 LIVE 对象不发。
	moved(): void {
		// 获取当前权威状态。
		const state = this.#read();
		// 同一对象表示没有新状态，直接返回。
		if (state === this.#last) return;
		// 先更新缓存，记录本次已通知到的状态。
		this.#last = state;
		// 解构每个 Map 项，以该监听原有上下文把状态入队。
		for (const [watch, context] of this.#watches) watch.advance(state, context);
		// 只有存在下游 derive 才安排批次标记，避免无人使用时的额外批次。
		if (this.dependents.size > 0) this.#mark();
	}

	/** The reference ended (`ended`, the reference's state): every watch ends `ended`, derives are marked a last time. */
	// 引用永久结束时输入 ended 状态；清掉监听和宿主关联，并让下游最后重读一次。
	// 例如 release 后监听 closed 完成；这不重新发送一个普通 value 帧。
	released(ended: Ended): void {
		// An ended reference keeps nothing of its object: not the last failure's error, not the host.
		// 用最终状态替换旧失败信息，避免缓存旧对象或失败的关联。
		this.#last = ended;
		// Ending detaches, which deletes the current entry (safe while iterating) and runs no listener.
		// 逐个结束监听；其删除回调会同步移除当前 Map 项，遍历仍可继续。
		for (const watch of this.#watches.keys()) watch.end({ kind: "ended" });
		// 拿到批次，决定是否还需要唤醒下游。
		const batch = this.batch;
		// 无批次或没有下游时，直接结束 NativeSource 即可。
		if (batch === undefined || this.dependents.size === 0) {
			// 父类 end 断开自身批次，不保留宿主。
			this.end();
			// 已完成清理，提前退出。
			return;
		}
		// Ended where the marks run: a release while a batch's flushes send marks in the next commit, after this.
		// 有下游时进入/安排一个批次执行下面两步；回调可能在当前发布后的下一批次执行。
		batch.within(() => {
			// 先把下游标脏，让它们读到 ended 状态。
			this.changed();
			// 再结束源并丢掉批次引用。
			this.end();
			// 没有引用专属上下文，使用不会代表用户调用的后台上下文。
		}, BACKGROUND_CONTEXT);
	}

	/**
	 * Marks the derives reading it, in the batch running now or one of its own (apart from `moved`: a closure there
	 * would allocate on every state change). A reference has no context of its own: the background context.
	 */
	// 把状态变化纳入批次，无参数无结果；若源已结束则不做事。
	// 例如 derive 读取 ref.state 时，moved 由此让它在批次中重算。
	#mark(): void {
		// ?. 仅在 batch 存在时调用 within；箭头回调调用父类 changed 标记依赖。
		this.batch?.within(() => this.changed(), BACKGROUND_CONTEXT);
	}
}

// 无输入无输出也无副作用的空回调，给已结束的监听使用；例如停止它无需删除任何 Map 项。
const IGNORE = (): void => {};
