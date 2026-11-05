// Writables (slice 8 §2, design §17): `self.writable(initial)`, an in-process value its attempt sets, identity
// compared; a contribution, a derive source and an `on` source, never a state member.

// 文件导读
// 所属包与模块：packages/chord/src/state 的可写值模块（slice 8 §2，design §17），属于 Chord 状态层。
// 职责边界：实现插件 attempt 内可 set 的进程内值；它不是文档、不持久化、不同步到其他 host。
// 上游：host 的 routine 上下文在 `self.writable(initial)` 时构造 WritableSource，传入拥有者与 batch；
// 插件代码调用 set。下游：set 通过 Batch.within 登记变更，FollowedSource 把新值推给 watch/observer；
// derive 和 registry 表把它当来源；attempt 结束时 host 调用 detach。
// 错误流向：attempt 结束后 set 抛保存的结束错误（released）；derive compute 或 registry compose 中 set 抛
// invalid/reentrant；这些错误来自 owner.assertUsable 与 batch.assertNotComputing。
// 能力清单：
// - Writable（接口）：应用可见的 NativeWatchable + set，值按身份比较。
// - WritableOwner（类型）：拥有者上下文与 assertUsable 运行时寿命检查。
// - WritableSource（类）：实现，含 value getter、set、私有 #change 与 detach。
// 组合关系与典型调用顺序：new WritableSource(initial, owner, batch) -> plugin.set(v) -> 身份比较 ->
// batch.within(#change) -> changed() -> 批次 deliver。detach(error) 使后续 set 失败并结束 watch。
// 示例（真实签名）：const wr = new WritableSource(0, { context, assertUsable: () => {} }, batch);
// wr.set(1); // 同一批次内 watch(wr) 看到 1；wr.set(1) 不会再次通知。
// 建议阅读顺序：先读 Writable 与 WritableOwner，再看 Ownership 状态，然后 WritableSource 构造/value/set，
// 最后 #change 与 detach 理解批次归属和结束语义。

import type { Context } from "../context/index.ts";
import type { NativeWatchable } from "../watch.ts";
import type { Batch } from "./batch.ts";
import { FollowedSource } from "./native-source.ts";

/** An in-process value that changes when its owner sets it; `set` of the same value notifies nobody. */
// 类型职责：应用可见的可写 watchable 接口。T 是值类型，运行时不做任何值校验，
// 只在 set 时以 === 比较身份。extends NativeWatchable<T> 表示它具备原生 source 的 watch/观察语义
// （不是 JSON watchable，因为值可以是任意进程内对象）。
export interface Writable<T> extends NativeWatchable<T> {
	/**
	 * Sets the value: a new value (by identity) is a new frame for its watches and marks the derives and registry
	 * tables reading it, in the batch running now or in one of its own. Throws `released` once its attempt ended, and
	 * `invalid/reentrant` inside a derive compute or a `compose`.
	 */
	// set 的输入是任意 T，没有返回值；副作用是修改内部值、排入一次批次变更并让依赖失效。
	// 错误路径：attempt 已结束抛 released（保存的是结束错误）；在 derive 计算或 registry compose 中调用抛
	// invalid/reentrant。示例：const count = self.writable(0); count.set(1) 会让 watch(count) 收到新值；
	// 但 count.set(1) 再执行一次不会通知，因为身份相同。
	set(value: T): void;
}

/** Who owns a writable: the context its own batches run in, and the check that its attempt still runs. */
// 拥有者信息由 host 提供：context 用于 set 自行开启批次时携带的上下文；
// assertUsable 是运行时的寿命检查，attempt 被 seal 后它会抛错。
export type WritableOwner = {
	readonly context: Context;
	/** Throws `released` once the attempt that made it was sealed. */
	assertUsable(): void;
};

/** Whom a writable belongs to: its running attempt, or nothing once that attempt ended (its error kept). */
// 判别联合：kind 是运行时真实存在的字符串标签，TypeScript 用它做收窄。
// owned 表示 attempt 仍在运行；ended 保留结束时的 Error，供后续 set 原样抛出。
// 两种状态下 value 都仍可读（detach 的文档语义是“守卫结束”，不是清除数据）。
type Ownership =
	| { readonly kind: "owned"; readonly owner: WritableOwner }
	| { readonly kind: "ended"; readonly error: Error };

/** A writable: its value, set by its owner's code, delivered through the host's batch. */
// 类职责：Writable 接口的实现，同时是一种“跟随型原生 source”，复用 FollowedSource 的观察者/订阅管理。
// 泛型 T 无运行时约束。私有字段 #value/#ownership 由 JS 类私有字段保证外部不可见（不是 TS 的 private）。
export class WritableSource<T> extends FollowedSource<T> implements Writable<T> {
	#value: T;
	#ownership: Ownership;

	// 构造：保存初始值，并把所有权标为“由 owner 拥有”；batch 交给父类，供后续 set 使用。
	// 无 I/O，不通知任何人。示例：new WritableSource(0, owner, batch)。
	constructor(initial: T, owner: WritableOwner, batch: Batch) {
		// 父类保存 batch 并初始化观察者映射等结构。
		super(batch);
		this.#value = initial;
		this.#ownership = { kind: "owned", owner };
	}

	// 读取当前值：同步、无副作用；即使 attempt 已结束也仍返回最后的值。
	// get 访问器只是语法糖，调用方写 writable.value。
	get value(): T {
		return this.#value;
	}

	// 输入新值；用途、错误与示例见接口注释。主要流程：检查寿命 -> 身份比较 -> 禁止在计算中调用 -> 写入批次。
	// 副作用：同批内的观察者与 derive 会在批次提交时看到新值；没有 I/O。
	set(value: T): void {
		// 先读一次，下面的分支基于同一个快照。
		const ownership = this.#ownership;
		// attempt 已结束时不能恢复，直接抛出保存的结束错误（通常是 released）。
		if (ownership.kind === "ended") throw ownership.error;
		// 询问 host：拥有它的 attempt 是否仍可用；seal 后这里会抛 released。
		ownership.owner.assertUsable();
		// The cost guard: setting the value it has costs one comparison past the seal check.
		// 身份相等（===）视为未变化；这也意味着内容相同但引用不同的对象仍会通知。
		if (value === this.#value) return;
		// batch 由父类保存；! 是非空断言，构造时已传入，属于已建立的不变量而非运行时检查。
		const batch = this.batch!;
		// 在 derive 的 compute 或 registry 的 compose 中同步 set 会造成重入；批次统一拒绝并报 invalid/reentrant。
		batch.assertNotComputing("writable.set");
		// 真正写入：把值变更登记到“当前正在运行的批次”，而不是立刻逐个回调。
		this.#change(value, batch, ownership.owner.context);
	}

	/**
	 * Adopts `value` in the batch running now, or in one of its own. Apart from `set`: a closure there would make every
	 * `set` allocate its context, the same value's too.
	 */
	// 私有方法：把“赋值 + 通知依赖”放进 batch.within。
	// within 在已有批次中运行时并入当前批次；否则用 context 新开一个批次并立即提交。
	// 这样多个同步 set 会合并为一次投递，watcher 在批次末尾看到最终值。
	// 示例：writable.set(2) 在批次外调用时，within 会立即 commit；批次内调用则并入当前批。
	#change(value: T, batch: Batch, context: Context): void {
		batch.within(() => {
			// 批次体内先改值，再调用 changed() 标记“本 source 需要投递”。
			this.#value = value;
			// changed 只做登记；真正 deliver 由批次在提交时统一执行。
			this.changed();
			// 第二个参数是批次上下文，用于新开批次时的日志/遥测归属。
		}, context);
	}

	/**
	 * Its attempt ended with `error`: its watches end `ended`, `set` throws `error`, its value stays readable; it keeps
	 * neither its attempt nor the host.
	 */
	// attempt 结束时由 host 调用：把所有权改为 ended，并让所有 watch 以 released/ended 结束。
	// 输入 error 是结束原因；无返回值；副作用是停止后续通知（end 会结束观察者）。
	// 示例：插件实例被 seal 后，旧 wr.set(...) 抛 released，而 wr.value 仍可读。
	detach(error: Error): void {
		// Kept by `set`: its stack is made text now, so it holds none of the frames' objects.
		// 提前访问 stack 触发 V8 的堆栈字符串化，避免长期持有创建时的调用帧对象；
		// void 表示故意丢弃返回值。
		void error.stack;
		// 保存结束错误，之后 set 原样抛出它（不重新包装）。
		this.#ownership = { kind: "ended", error };
		// 父类方法：结束所有 watch/观察者并清理订阅关系。
		this.end();
	}
}
