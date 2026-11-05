// A reference's member as consumers follow it (decision "References are the only indirection", §7): a consumer's
// watches and derives over `ref.member` (or a key of a keyed member) attach here, and this passes them straight through
// to the object instance's own document or derive (its watches and subscribers subscribe there: no extra hop on
// commits, the commit's value and ops by reference). When the reference's target moves to a new instance (or a new
// object of its identity), it moves them and sends one frame, a diff from the last value; while it points at nothing it
// keeps the last value (a pointer, no copy), with one `failed` call when its target failed (none while it loads).

// 本文件的引用成员是转接点：绑定时直接跟随实例的源，断开时只保留最后的 JSON 值。
// 所属模块：packages/chord/src/host 的引用成员转接层（引用绑定与重绑）。
// 上下游：Binding 在绑定时调用 bind，目标加载/失败/成员消失/结束时调用 hold/fail/vanish/end；
//   下游是 state.Source 的依赖机制、Watch 和 delta.diffRevisions。
// 结果：读取返回 JsonValue 或按状态抛错；重绑在批次中由 deliver 发一帧差异或全量；本文件不做 SQL 或网络 I/O。
// 能力清单：
// - SourceState：unbound/bound/held/failed/ended 五种状态联合。
// - SourceOwner：未绑定时读取应抛哪个错误的接口（由 Binding 实现）。
// - ReferenceSource：watches/subscribers 的转接点，bind/hold/fail/vanish/end/deliver 管理生命周期。
// 组合关系：bind(source) -> #leave 旧源 -> #hook 新源 -> changed；批次结束时 deliver 用 diffRevisions 发给订阅者。
// 示例：const member = new ReferenceSource(batch, owner); member.bind(document); member.value; member.end(released);
// 阅读顺序：先 SourceState 各状态，再 value/start/openWatch 的读取语义，然后 bind/hold/fail/vanish/end 的状态迁移，
//   最后 deliver/#keep/#hook/#leave 的转接细节。
import type { Context } from "../context/index.ts";
import type { ChordError } from "../data/index.ts";
import { diffRevisions, type Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import {
	type Batch,
	type Dependent,
	type DeriveSource,
	handedOut,
	Source,
	type Subscriber,
	type WatchStart,
} from "../state/internal.ts";
import { Watch, type WatchCall, type WatchEnd } from "../watch.ts";

/**
 * Where a reference's source stands: never had a value (`unbound`: reads throw what its reference has instead),
 * following an instance's member, holding its last value while pointing at nothing (`failure` while its target is
 * failed: new watches start with it; `told`: its watches got a failure since that value, so the next is whole), failed
 * (a member its target's live variant lacks, or its compute threw when it was held: reads throw, `last` is the last
 * good value) or ended with its reference (nothing kept).
 */
// 这是按 kind 区分的联合类型；每个分支只带当前阶段需要的数据，readonly 只约束 TypeScript。
type SourceState =
	// unbound 从未拿到过值，读取时由引用决定抛 not_ready、失败原因还是 released。
	| { readonly kind: "unbound" }
	// bound 直接持有实例的文档/derive/常量源。
	| { readonly kind: "bound"; readonly source: DeriveSource }
	// held 已离开实例，只保留值和一次失败信息；told 记住监听是否收到过失败，恢复时需发全量。
	| { readonly kind: "held"; readonly value: JsonValue; readonly failure: unknown; readonly told: boolean }
	// failed 是成员本身不可用，读取抛错；last 给新监听提供最后好值。unknown 要先缩窄后使用。
	| { readonly kind: "failed"; readonly error: unknown; readonly last: JsonValue | undefined }
	// ended 永久结束，只保留终止错误。
	| { readonly kind: "ended"; readonly error: ChordError };

/** A reference owning its sources: what a read of one that never had a value throws. */
// SourceOwner 只要求能给出“从未有值时”的错误；接口在运行时擦除。
export interface SourceOwner {
	// 由 Binding 实现：例如引用仍 loading 时返回 not_ready，而不是伪造一个空值。
	none(): ChordError;
}

// 所有永久结束通知共用同一个只含 kind 的对象。
const ENDED: WatchEnd = { kind: "ended" };

/** No failure told: a held value's `failure` while its target loads. */
// 用 undefined 表示目标在加载、此时无需发送失败；它不是一个 JSON 值占位符。
const NO_FAILURE = undefined;

/**
 * One member (or key) of one reference. Bound, it is a dependent of the instance's member (its own dependents are
 * marked with it); its watches and subscribers subscribe to that member itself, so the member's frames reach them as
 * they are, and a derive member stays lazy while nothing follows it; holding or moving moves them.
 */
// extends 复用 JSON Source 的批次/依赖机制；implements 只检查本类具备 Dependent 所需方法。
export class ReferenceSource extends Source implements Dependent {
	// 每个引用成员一开始尚未绑定到任何实例。
	#state: SourceState = { kind: "unbound" };
	/**
	 * Its watches and subscribers, each subscribed to the bound member while bound; held, they get nothing. Made by the
	 * first.
	 */
	// 按需创建订阅集合；Set 同时保证同一个订阅者不重复登记。
	#passed: Set<Subscriber> | undefined;
	/** What its watches had at a re-bind (`undefined` for no value: they had a failure), until the re-bind's frame. */
	// 重绑时暂存监听已经见过的值，供 deliver 做差异；undefined 要求恢复帧全量替换。
	#framed: { readonly value: JsonValue | undefined } | undefined;
	/** Its reference: what a read throws while it never had a value (its failure, `not_ready`, or `released`). */
	readonly #owner: SourceOwner;

	// 输入宿主批次和引用拥有者，建立尚未绑定的转接源，无订阅副作用。
	// 例如为 notes 成员构造后，仍需 bind(document) 才能直接读到值。
	constructor(batch: Batch, owner: SourceOwner) {
		// 先初始化父类的批次和依赖集合。
		super(batch);
		// 保存拥有者，只在从未绑定时询问应抛哪种错误。
		this.#owner = owner;
	}

	/** Whether it never had a value (a watch waits for its reference's values first). */
	// 返回是否从未有过值，无副作用；例如 watch 遇到 true 会先等待首次 hydration。
	get unbound(): boolean {
		// 只比较状态标签，不把 held 的暂时失联当作首次未绑定。
		return this.#state.kind === "unbound";
	}

	// 按当前状态同步读 JSON 值；无输入，可能触发底层 derive 计算或抛错。
	// 例如目标失联但 held 仍返回最后的 notes，成员消失的 failed 则抛错误。
	get value(): JsonValue {
		// 固定本次读取的状态，switch 会按 kind 缩窄它的类型。
		const state = this.#state;
		// 不同阶段的读取规则集中于此。
		switch (state.kind) {
			case "bound":
				// 绑定时直接读底层源，值不复制。
				return state.source.value;
			case "held":
				// A derive over a failed reference's member computes on its last value too (owner, G2: A).
				// 暂存状态仍提供最后好值，下游 derive 可以继续基于它计算。
				return state.value;
			case "unbound":
				// 从未拿到值时，把错误交给拥有者决定。
				throw this.#owner.none();
			default:
				// 其余是 failed 或 ended，两者都有 error，读取会抛出它。
				throw state.error;
		}
	}

	/** What a new watch starts at: the bound member's start, the held value (after its failure), or the failure. */
	// 为新监听生成起始描述，不创建监听；返回好值，或错误加最后好值。
	// 例：held 携带失败时，监听以 last 开始并收到失败；unbound/ended 直接抛错。
	start(): WatchStart {
		// 读取当前状态并按标签分支。
		const state = this.#state;
		switch (state.kind) {
			case "bound":
				// Source 可报告自身失败与 last；常量仅有 value。instanceof 在这里识别内部源的运行时类别。
				return state.source instanceof Source ? state.source.start() : { kind: "value", value: state.source.value };
			case "held":
				// 目标仅加载时用普通 value 起步；已有失败时带上最后值和错误。
				return state.failure === NO_FAILURE
					? { kind: "value", value: state.value }
					: { kind: "failed", error: state.failure, last: state.value };
			case "failed":
				// 成员自身失败时把保存的 last 一并交给开监听流程。
				return { kind: "failed", error: state.error, last: state.last };
			case "unbound":
				// 首次无值无法开监听，抛拥有者当前给出的错误。
				throw this.#owner.none();
			case "ended":
				// 永久结束后所有起始读取抛终止错误。
				throw state.error;
		}
	}

	/**
	 * A watch subscribed to the bound member itself (as `Source.openWatch` starts one: on a failed member at its last
	 * good value, the failure first).
	 */
	// 输入监听上下文，同步返回已注册的 Watch；取消会结束它，失败且没有 last 时抛错。
	// 先取起始描述、登记透传订阅再补失败通知。例如有最后值 3 的失败源可开出从 3 起步的监听。
	openWatch(context: Context): Watch<JsonValue> {
		// 运行时禁止在批次发布内部重入订阅。
		this.batch.assertOutside("watch");
		// 先取得当前值/失败及最后值，订阅期间无需 await。
		const start = this.start();
		// 失败且从未有好值时，无值供 Watch 初始化，只能抛失败。
		if (start.kind === "failed" && start.last === undefined) throw start.error;
		// 选择好值或 last；! 是开发期非空断言，前面的分支已排除了 undefined。
		const value = start.kind === "value" ? start.value : start.last!;
		// 新监听停止时取消转接订阅，监听处理函数错误交批次报告。
		const watch: Watch<JsonValue> = new Watch(value, () => this.unsubscribe(watch), this.batch.reportListener);
		// 先加入透传集合，若已绑定则同时订到底层源。
		this.subscribe(watch);
		// 带取消信号时关联它，取消此上下文只停此 watch。
		if (context.abortSignal !== undefined) watch.observeAbort(context.abortSignal);
		// 失败起步时把错误栈物化后入队一条 failed 调用，监听仍可等待恢复。
		if (start.kind === "failed") watch.fail(handedOut(start.error), context);
		// 交回监听句柄，调用方之后可 start/stop。
		return watch;
	}

	/** Whether anything follows it: a watch, a subscriber or a derive (moving or ending it then needs a batch). */
	// 返回是否有人使用此源，无副作用；有监听或下游 derive 都需要重绑时进入批次。
	get inUse(): boolean {
		// 短路或合并两类使用者，不枚举它们。
		return this.watched || this.dependents.size > 0;
	}

	/** Whether a watch or a subscriber follows it (through the bound member). */
	// 返回是否有透传监听/订阅者；不把仅有 derive 依赖算作 watched。
	get watched(): boolean {
		// ?. 在集合未创建时得到 undefined，?? 只把 null/undefined 替换为 0。
		return (this.#passed?.size ?? 0) > 0;
	}

	/** Feeds `subscriber` the bound member's frames (it subscribes there) and the moves' frames. */
	// 输入订阅者，登记它并在绑定时直订底层源，无返回；不主动补发当前值。
	// 例如 link hold 先取快照再订阅，这里只负责后续帧。
	subscribe(subscriber: Subscriber): void {
		// ??= 仅在尚未分配集合时创建 Set。
		this.#passed ??= new Set();
		// 把订阅者加入集合，重绑时据此迁移。
		this.#passed.add(subscriber);
		// 取当前状态决定是否也应直订实例。
		const state = this.#state;
		// 只有可变化的 Source 有订阅机制；常量无需订阅，也不会发变化帧。
		if (state.kind === "bound" && state.source instanceof Source) state.source.subscribe(subscriber);
	}

	/** As `Source.unsubscribe`. */
	// 输入订阅者并解除它两处登记，无返回；例如 Watch.stop 经其回调走这里。
	unsubscribe(subscriber: Subscriber): void {
		// 集合未创建时 ?. 什么也不做。
		this.#passed?.delete(subscriber);
		// 读取当前绑定关系。
		const state = this.#state;
		// 若仍直订某个 Source，同步撤销那一处订阅。
		if (state.kind === "bound" && state.source instanceof Source) state.source.unsubscribe(subscriber);
	}

	/** The bound member changed: its dependents are marked (its frames reach the subscribers directly). */
	// 底层变化时向所有下游传播脏标记，无结果、不立即计算；例如 notes 变化让计数 derive 下次重算。
	invalidate(): void {
		// 逐个调用依赖者的 invalidate；值帧由底层直接送给订阅者，不在此再转发。
		for (const dependent of this.dependents) dependent.invalidate();
	}

	/** The bound member's document was retired: its dependents carry the flag on. */
	// 输入本次退休传播的 visited 集合并转给下游，无结果；例：文档退休让 derive 帧带 retired。
	sourceRetired(visited: Set<Dependent>): void {
		// 同一集合贯穿整次传播，由下游负责避免菱形依赖重复访问。
		for (const dependent of this.dependents) dependent.sourceRetired(visited);
	}

	/**
	 * Follows `source`, an instance's member, inside a batch: watches get one frame from the last value (a full one
	 * after a failure); derives downstream are marked and recompute, a failed one included (self-healing).
	 */
	// 输入新实例的源，在批次内切换依赖和透传订阅，之后发一条重绑差异帧。
	// 例如旧值 {n:1} 变为新实例 {n:2}，监听收到差异而句柄保持不变；结束后不能复活。
	bind(source: DeriveSource): void {
		// 记住旧状态，以便排除重复绑定。
		const state = this.#state;
		// 永久结束或已经跟随同一源时无事可做。
		if (state.kind === "ended" || (state.kind === "bound" && state.source === source)) return;
		// 先从旧源解绑，避免新旧实例同时送帧。
		this.#leave();
		// 有监听才保存它们见过的旧值；失败后 #shown 给 undefined，表示恢复需全量。
		if (this.watched) this.#framed = { value: this.#shown() };
		// 切换状态，后面的读取将从新源取得。
		this.#state = { kind: "bound", source };
		// 连接新源的依赖和直通订阅。
		this.#hook(source);
		// Marks the derives downstream: a failed one recomputes too (self-healing).
		// 把本转接源列入批次并标记下游，以统一发布重绑帧。
		this.changed();
	}

	/** Its target loads (a restart, a retry, a new object not live yet): it keeps its last value, and tells nothing. */
	// 目标加载时暂停跟随并留下值，无参数无返回，不发送失败帧。
	// 例如对象重启期间仍显示上一版 notes；已有失败被清除，但 told 保留恢复全量要求。
	hold(): void {
		// 读取状态，区分已经暂存和仍然绑定。
		const state = this.#state;
		// 已经暂存时无需再次读取旧实例。
		if (state.kind === "held") {
			// Its watches had the failure: the next value stays whole (`told`).
			// 对象展开复制这一小份内部状态，只清 failure，保留 value 和 told。
			if (state.failure !== NO_FAILURE) this.#state = { ...state, failure: NO_FAILURE };
			// 已处理暂存状态，直接返回。
			return;
		}
		// 仍绑定时从该实例取最后值并断开；其他阶段不做事。
		if (state.kind === "bound") this.#keep(NO_FAILURE);
	}

	/**
	 * Its target failed (`error`: its cause's, a refused version's, a removed type's), inside a batch: it keeps its last
	 * value, its watches and subscribers get one failure call (once per failure) and stay open.
	 */
	// 输入目标失败原因及上下文，在批次中保存最后值并发送一次失败，无返回。
	// 例如 provider 版本不符时 notes 仍可读，监听收到 failed 但继续等待恢复。
	fail(error: ChordError, context: Context): void {
		// Kept: its stack made text now, so it keeps none of the failed instance's frames.
		// 提前读取 Error.stack，避免调用栈延迟格式化保留失败实例。
		handedOut(error);
		// 读取当前阶段，确定是否有最后值可保留。
		const state = this.#state;
		// 已经暂存时沿用原来的值。
		if (state.kind === "held") {
			// 此轮已经发送过失败则不重复发送，即使又调用 fail。
			if (state.failure !== NO_FAILURE) return;
			// 保存失败并记下 told=true，恢复必须发全量值。
			this.#state = { kind: "held", value: state.value, failure: error, told: true };
			// 仍绑定时需先从实例取最后值并脱离。
		} else if (state.kind === "bound") {
			// #keep 如果发现成员本身已失败则返回 false，不再重复目标失败通知。
			if (!this.#keep(error)) return;
		} else {
			// unbound/failed/ended 不在这个目标失联处理路径内。
			return;
		}
		// 给仍订阅本引用成员的人发送 failed；并不结束 watch。
		this.#call({ kind: "failed", error }, context);
	}

	/**
	 * Its target's live variant lacks the member, inside a batch: reads throw `error`; watches and subscribers get one
	 * failure call and stay open (a later instance may bring the member back, as `[["r", value]]`).
	 */
	// 输入成员缺失错误和上下文，将成员设为失败并通知/标记下游，无返回。
	// 例：新 reader 变体没有 editor.secret，secret 的读取抛 invalid/member，后续变体仍能带回它。
	vanish(error: ChordError, context: Context): void {
		// 查看当前阶段。
		const state = this.#state;
		// 结束是永久状态，不再接受成员消失通知。
		if (state.kind === "ended") return;
		// 从未绑定时没有 last；其他状态通过起始描述取最后好值。
		const last = state.kind === "unbound" ? undefined : this.#lastGood();
		// 离开旧实例的订阅和依赖。
		this.#leave();
		// 保存物化栈后的成员错误和 last，读取从此抛错。
		this.#state = { kind: "failed", error: handedOut(error), last };
		// 通知订阅者此成员失败。
		this.#call({ kind: "failed", error }, context);
		// 同时标记 derive 重新读取，让它们看到成员已不可用。
		this.changed();
	}

	/**
	 * Its reference ended, inside a batch: reads throw `error`, watches end `ended`, and derives over it are marked
	 * (their next read throws it, no cached value stays).
	 */
	// 输入引用终止错误，断开实例、丢掉值和订阅并让下游重读，无返回。
	// 例如 release 后旧 watch 结束而 derive 再读会抛 released，不能靠缓存继续读旧成员。
	end(error: ChordError): void {
		// 先解绑实例，避免终止后仍收到源帧。
		this.#leave();
		// 只留下最终错误，不保存实例和最后 JSON 值。
		this.#state = { kind: "ended", error };
		// 取消尚未发布的重绑帧。
		this.#framed = undefined;
		// A copy: an ending watch unsubscribes itself.
		// 取出订阅集合，终止回调可能反过来取消订阅。
		const passed = this.#passed;
		// 先断开本类对集合的持有。
		this.#passed = undefined;
		// 复制小份订阅者列表后逐个结束，防止结束回调的删项影响遍历。
		if (passed !== undefined) for (const subscriber of [...passed]) subscriber.end(ENDED);
		// 让下游脏掉，下次读会命中 ended 的错误。
		for (const dependent of this.dependents) dependent.invalidate();
	}

	/** Delivers a move's frame: the diff from the watches' value to the new member's. */
	// 批次用 context 交付一次重绑帧，无返回；用旧值到新值的差异，失败恢复时用全量替换。
	// 例如旧实例 n=1、新实例 n=2 时发 Delta；对象引用不变则不发无意义帧。
	deliver(context: Context): void {
		// 取本批次保存的旧值信息。
		const framed = this.#framed;
		// 立即清掉，确保每次重绑只发布一次。
		this.#framed = undefined;
		// 没有迁移帧就无需读或 diff。
		if (framed === undefined) return;
		// 声明待取得的新值，类型是 JSON，不在此检查 schema。
		let after: JsonValue;
		// 读新值可能触发 derive 计算，因此要处理它抛错的情况。
		try {
			// 按新绑定读取当前值。
			after = this.value;
		} catch (error) {
			// 之前有值时告知这次读取失败；已经以失败起步的监听不重复收到同一类失败。
			if (framed.value !== undefined) this.#call({ kind: "failed", error: handedOut(error) }, context);
			// 读失败无法计算值差异，结束本次交付。
			return;
		}
		// 保存旧值用于身份比较及 Delta diff。
		const before = framed.value;
		// 值是同一引用则无变化；恢复时 before 为 undefined，因此不会被此判断吞掉。
		if (after === before) return;
		// After a failure (no value framed): whole, even when unchanged.
		// readonly Op[] 是只读操作数组类型；无 before 发 r 替换，否则计算结构差异。
		const ops: readonly Op[] = before === undefined ? [["r", after]] : diffRevisions(before, after);
		// 只有存在操作才送 value 帧；重绑本身不是文档退休，retired=false。
		if (ops.length > 0) this.#call({ kind: "value", value: after, ops, retired: false }, context);
	}

	/**
	 * Stops following the bound member and keeps its value (`failure`: the failure it is held with); a member whose value
	 * throws becomes failed. Whether it holds a value.
	 */
	// 输入暂存期间的目标失败（或 undefined），把已绑定源转换为 held/failed，返回是否保住一个好值。
	// 只供 bound 分支调用；例如加载重启时取最后值后脱离旧文档，避免引用把旧实例一直留住。
	#keep(failure: unknown): boolean {
		// as Extract 说明调用者已保证 bound，TypeScript 不能跨私有方法推导；它不做运行时检查。
		const state = this.#state as Extract<SourceState, { readonly kind: "bound" }>;
		// Source 的 start 能携带失败和 last；常量等稍后直接读 value。
		const start = state.source instanceof Source ? state.source.start() : undefined;
		// 先拆掉订阅，随后只保留普通数据。
		this.#leave();
		// 没有 start 描述（常量）或描述为 value 时，都能保存当前好值。
		if (start === undefined || start.kind === "value") {
			// 常量从 value 读，Source 从刚取的起始描述读，不复制 JSON。
			const value = start === undefined ? state.source.value : start.value;
			// 保存目标原因，并据是否有失败决定恢复是否必须全量。
			this.#state = { kind: "held", value, failure, told: failure !== NO_FAILURE };
			// true 表示暂存成功。
			return true;
		}
		// 底层本就失败时，保留它自己的错误及最后值，成员进入 failed。
		this.#state = { kind: "failed", error: handedOut(start.error), last: start.last };
		// false 告诉调用者不要再补一条目标失败通知。
		return false;
	}

	/** A call of its own (a move's frame, a failure) to its watches and subscribers. */
	// 输入一帧及上下文，直送当前透传订阅者，无返回；例如重绑或失联失败使用此补充路径。
	#call(call: WatchCall<JsonValue>, context: Context): void {
		// 集合尚未创建时没有人接收；否则逐项 advance，把缓冲/异步处理交给订阅者自己。
		if (this.#passed !== undefined) for (const subscriber of this.#passed) subscriber.advance(call, context);
	}

	/**
	 * The value its watches have before a move; `undefined` when they had a failure since it (their next value is whole,
	 * `[["r", value]]`, even when unchanged).
	 */
	// 返回监听已经见过的好值，无输入无副作用；若之前收到失败则返回 undefined 请求下一帧全量。
	// 例：held 保留数值 3 但 told=true，恢复值仍为 3 也要发 r。
	#shown(): JsonValue | undefined {
		// 读取当前状态。
		const state = this.#state;
		// 首次无值或已告知失败时不能以旧值作 diff 基线。
		if (state.kind === "unbound" || (state.kind === "held" && state.told)) return undefined;
		// 其余状态询问其起始描述，可能从底层计算或抛错。
		const start = this.start();
		// 只有无失败的起始描述能作为监听的正常基线。
		return start.kind === "value" ? start.value : undefined;
	}

	/** Its last good value, which watches opened while it is failed start at; `undefined` when it never had one. */
	// 返回最后好值或 undefined，不改变订阅；供 vanish 保存旧值。
	// 例如源 start 是 failed,last=3，则返回 3 而非抛该失败。
	#lastGood(): JsonValue | undefined {
		// 取得正常/失败两种起始描述。
		const start = this.start();
		// 正常取 value，失败取 last。
		return start.kind === "value" ? start.value : start.last;
	}

	/** Starts reading `source`: its changes mark this source's dependents, its frames reach the subscribers. */
	// 输入新底层源，连接本转接源的脏标记及已有订阅者，无返回。
	// 例如绑到文档 Source 后，下游 derive 随文档变动；Constant 不需要挂钩。
	#hook(source: DeriveSource): void {
		// 常量没有依赖/订阅集合，不做任何注册。
		if (!(source instanceof Source)) return;
		// 让源变化时调用本类 invalidate 传播下游脏标记。
		source.dependents.add(this);
		// 把已有 watch/hold 直接订到新源，提交时不增加转发一跳。
		if (this.#passed !== undefined) for (const subscriber of this.#passed) source.subscribe(subscriber);
	}

	/** Stops following the bound source, when bound: no more marks or frames from it. */
	// 无输入，解除 bound 源上的脏标记和透传订阅，无返回；不自行改变 #state。
	// 例如 bind 新源前调用它，移除旧源持有的本转接源和监听。
	#leave(): void {
		// 取旧状态。
		const state = this.#state;
		// 没有绑定就无需拆除。
		if (state.kind !== "bound") return;
		// 解构出旧源。
		const { source } = state;
		// 常量从未挂钩，无集合需要删除。
		if (!(source instanceof Source)) return;
		// 从旧源依赖集合删除本转接点，切断旧实例的保留路径。
		source.dependents.delete(this);
		// 撤销每个直通订阅，但本类 #passed 仍记得它们，供后续重绑。
		if (this.#passed !== undefined) for (const subscriber of this.#passed) source.unsubscribe(subscriber);
	}
}
