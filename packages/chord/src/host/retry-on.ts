// Wake signals (slice 8 §3, D2): `self.retryOn(...sources)`. The object follows each declared source while it lives,
// replaced by each attempt's declaration; a new value of a source wakes it (the object decides what a wake does: a
// retry while failed, remembered while it activates, nothing while live). Failures of a source wake nothing.
// 本文件把工厂里声明的 retryOn 源变成对象生命周期内的订阅：每次尝试重新声明时替换旧订阅，对象结束或重绑时解除。
// 上游是 attempt 执行工厂后的安装逻辑；下游是对象的 wake 回调。订阅本身只转发“有新值”事件，不执行重试。
// 所属模块：packages/chord/src/host 的对象唤醒订阅（slice 8 的 self.retryOn）。
// 上下游：安装工厂结果时调用 retrySource 校验、RetryWakes.replace 订阅；依赖 state 的 NativeObserver/advance 与 registries 的源类型。
// 结果：源出现新值时调用对象给的 wake；声明阶段不合法则以 invalid/args 抛出；订阅期间源失败不唤醒。
// 能力清单：
// - RetrySource：允许的源类型联合（注册表值或常量）。
// - retrySource：运行时校验工厂返回的 unknown，收窄为 RetrySource。
// - RetryWakes：管理一次尝试的订阅集合，支持替换与停止。
// 组合关系：replace 先解除旧观察者，再把同一 wake 挂到每个新源；stop 在对象结束或重绑时解除全部。
// 示例：const wakes = new RetryWakes(); wakes.replace([retrySource(source, "retryOn")], () => retry()); wakes.stop();
// 阅读顺序：先 RetrySource/retrySource 的边界检查，再 replace 的替换语义，最后 stop 的清理。

import { RegistryValueSource } from "../registries/internal.ts";
import { Constant, type NativeObserver } from "../state/internal.ts";

/** What `retryOn` takes: sources that live independently of the attempt (a registry value; a constant never wakes). */
// 联合类型：合法的唤醒源只能是这两类。RegistryValueSource 是注册表合成值（可随贡献变化），
// Constant 是不可变常量（类型上允许，但永远不会发出新值，因此实际不会触发唤醒）。
export type RetrySource = RegistryValueSource | Constant;

/**
 * Checks a `retryOn` source (declaration policy: TypeScript cannot tell a reference's member or this attempt's
 * `writable` from a registry value or a constant).
 */
// 校验一个 retryOn 参数是否属于合法来源。输入是 unknown（插件代码可能传任意值）和用于错误消息的标签；
// 合法时原样返回同一对象，否则抛普通 Error。这是声明策略的运行时检查：TypeScript 分不清“引用成员”和“注册表值”。
// 示例：retrySource(writable, "Notes") 抛错，因为 writable 属于当前 attempt，会随对象结束而失效。
export function retrySource(source: unknown, label: string): RetrySource {
	// instanceof 做运行时类检查并让 TS 把 unknown 收窄为联合类型；两个内部类都由 Chord 自己创建。
	if (source instanceof RegistryValueSource || source instanceof Constant) return source;
	// 不返回默认值：非法声明必须在工厂执行阶段立刻失败，避免安装一个不会工作的订阅。
	throw new Error(`${label}: self.retryOn takes registry values and constants (sources that outlive the attempt)`);
}

/**
 * The wake signals of one object: its subscriptions (one set at a time, the last attempt's declaration) and what its
 * object decides a wake by.
 */
// 一个对象持有的唤醒订阅集合。没有构造函数参数；由对象在需要时创建，并通过 replace/stop 管理。
// 同一时刻只有一套订阅（最近一次 attempt 的声明）。它不保存值，只把来源的新值转成一次 wake 回调。
export class RetryWakes {
	/** The attempt a wake arrived during, while it activates: if it fails, it is retried at once. */
	// 记录“这条唤醒发生在哪次 attempt 激活期间”；attempt 失败时对象据此决定立即重试一次。
	during: object | undefined;
	/**
	 * Set from its object's contributions leaving until that batch delivered: a composition its own leaving made does
	 * not wake it (an object failing live would retry itself without backoff).
	 */
	// leaving 为 true 时忽略唤醒：对象自己的贡献离开注册表会引起一次合成，不应把它当成外部信号而立刻自愈。
	leaving = false;
	// 数组元素是“来源 + 观察者”的配对，stop 时凭观察者身份退订；Constant 没有订阅接口，所以不会进入这个数组。
	#subscribed: { readonly source: RegistryValueSource; readonly observer: NativeObserver<unknown> }[] = [];

	/** Follows `sources` instead of the previous set; `wake` runs inside the batch of each new value (it only records). */
	// 用新声明替换旧订阅。输入是只读来源数组和每次新值时的无参回调；无返回值。
	// 先退订旧集合，避免声明变化后仍收到旧来源的事件；然后只订阅 RegistryValueSource（Constant 永远是常量，不需要订阅）。
	// 示例：replace([self.registry(M)], () => this.wake()) 会先移除上一次注册表订阅，再订阅新注册表值。
	replace(sources: readonly RetrySource[], wake: () => void): void {
		this.stop();
		// 一个观察者对象可以被多个来源共享：subscribe 只保存引用，事件到来时调用 advance。
		// NativeObserver 的 advance 接收 NativeWatchCall，联合类型靠 call.kind 收窄；只有 value 才唤醒，failed 不唤醒。
		const observer: NativeObserver<unknown> = {
			advance: (call) => {
				if (call.kind === "value") wake();
			},
			end: () => {},
		};
		// 逐个来源登记。instanceof 同时完成运行时类型判断和 TS 收窄；constant 被跳过是设计决定，不是遗漏。
		for (const source of sources) {
			if (!(source instanceof RegistryValueSource)) continue;
			source.subscribe(observer);
			// 记录配对，stop 时才能精确退订；同一观察者对象可安全地供多个来源使用。
			this.#subscribed.push({ source, observer });
		}
	}

	/** Stops following (the object ended, or a new declaration replaces the set). */
	// 停止跟随全部来源。无输入无返回；对象结束或新声明替换时调用，重复调用是安全的（空数组不再循环）。
	// 解构出配对中的 source 和 observer，逐一退订；最后换空数组，丢掉对来源的引用以便 GC。
	stop(): void {
		for (const { source, observer } of this.#subscribed) source.unsubscribe(observer);
		this.#subscribed = [];
	}
}
