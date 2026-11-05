// Harness 共用的等待登记与分页/查询适配；这里不执行任务，也不直接写存储。
// 所属：packages/durable/src/harness，Durable Harness 的共享工具层。
// 上游：Submissions、TaskGraphView、ConversationViews、Scheduler 等把“某键完成时唤醒谁”登记进 Waiters，
// 并在关闭时统一拒绝；TaskGraph 与 Scheduler 用 scanAll 拉平存储分页，Harness 用 conversationEntries 拼查询。
// 下游：Waiters 只在内存中保存 Promise 与完成方法；scanAll、conversationEntries 把参数交给 Session 的存储扫描。
// 泛型只在编译期约束键和结果，运行时不做形状检查；等待者拿到同一个值引用，不会被复制。
// 能力清单：
// - Waiters：按键登记、完成或统一拒绝等待者的内存表，并跟随 Context 取消。
// - scanAll：把 (cursor) => Page 的分页扫描按页序拉平成完整数组。
// - closedError：把 Session 的 failure 转成对外关闭错误。
// - optionalExtension：把可选扩展名转成可展开字段对象。
// - conversationEntries：把独立会话 ID 与查询投影成 EntryQuery。
// 组合与顺序：使用方先 Waiters.add 等键，再在提交观察或关闭回调里 resolve/rejectAll；
// TaskGraph/Scheduler 先 scanAll 扫任务与提交，关闭时用 closedError 拒绝；Harness.entries 用 conversationEntries 拼查询。
// 示例：const waiters = new Waiters<number, string>(); const pending = waiters.add(1, context);
//      waiters.resolve(1, "done"); // pending 随后得到 "done"
// 建议阅读顺序：先看 Waiters 的 add/resolve/rejectAll，再看 scanAll，最后看 closedError、optionalExtension、
// conversationEntries 三个纯函数助手。
import type { Context } from "@earendil-works/chord/context";
import { SessionFailed } from "../errors.ts";
import type { ConversationId, Cursor, EntryQuery, Page } from "../types.ts";

/** Pending waits by key. Each settles once: through `resolve`, `rejectAll`, or cancellation of its context. */
/**
 * 按 key 收集尚未完成的等待，供“别处完成后再唤醒调用方”的场景使用。
 * 输入：add 给键 K 和 Context，resolve 给键与结果 T；输出：add 返回 Promise<T>，其余方法返回 void。
 * 副作用：增删 #sets 中的 Map/Set 条目，并在 context 的 abortSignal 上挂/摘监听；不写 Session，也不提交事务。
 * 错误：context 已取消或之后取消时，Promise 以 signal.reason 拒绝；rejectAll 用调用方给的原因拒绝全部等待。
 * 流程：add 先查取消，再登记 waiter 与 abort 监听；resolve 先删键再完成整组；关闭路径统一调 rejectAll。
 * 例：const w = new Waiters<number, string>(); const p = w.add(1, ctx); w.resolve(1, "ok") 后 p 得到 "ok"。
 * 例只是用法示意；K/T 不会被运行时验证，真实上下文由调用方（如 Submissions）提供。
 */
export class Waiters<K, T> {
	// K 是目标键类型，T 是成功结果类型；# 是运行时私有字段，readonly 限制字段重新赋值而非 Map 内容。
	// 每个键可有多个等待者；PromiseWithResolvers 同时保存 promise 和其 resolve/reject。
	readonly #sets = new Map<K, Set<PromiseWithResolvers<T>>>();

	/**
	 * 为 key 登记一次等待并返回 Promise<T>；context 取消只拒绝本次等待，不取消共享任务。
	 * 先检查取消、加入集合，再监听取消；Promise 结束后解除监听。例：add(7, ctx) 由 resolve(7, value) 完成。
	 * rejectAll 或取消会让 await 抛出原原因；T 只在编译时约束结果，不在运行时验证结果形状。
	 */
	add(key: K, context: Context): Promise<T> {
		// ?. 允许 context 没有取消信号。
		const signal = context.abortSignal;
		// 已取消的调用直接得到拒绝，不留登记。
		// Promise.reject 返回“已拒绝的 Promise”，不会同步 throw；await 它时才在调用方抛出 signal.reason。
		if (signal?.aborted) return Promise.reject(signal.reason);
		// Promise.withResolvers 是标准 API：一次得到 promise 与它的 resolve/reject，便于把完成权留在本类。
		const waiter = Promise.withResolvers<T>();
		// ?? 仅在查不到集合时创建新集合。
		const set = this.#sets.get(key) ?? new Set();
		// Set.add 返回集合本身：同时加入等待者和保存该组。
		this.#sets.set(key, set.add(waiter));
		if (signal !== undefined) {
			// 回调捕获本次 waiter，取消时不会影响同键的其他等待者。
			const onAbort = (): void => {
				set.delete(waiter);
				// 身份检查防止误删 resolve 后为同键新建的另一组。
				if (set.size === 0 && this.#sets.get(key) === set) this.#sets.delete(key);
				waiter.reject(signal.reason);
			};
			// once 使 abort 最多触发一次，正常完成还需要下面主动解绑。
			signal.addEventListener("abort", onAbort, { once: true });
			const detach = (): void => signal.removeEventListener("abort", onAbort);
			// 成功、失败都解绑；这是注册回调，并非在此等待结果。
			waiter.promise.then(detach, detach);
		}
		// 只暴露 Promise，内部保留结束它的方法。
		return waiter.promise;
	}

	/** 返回有等待者的键快照，不改登记。例：键 7 有两个等待者时结果仍只包含一个 7。 */
	keys(): K[] {
		// ... 将 Map 键的迭代器展开成独立数组。
		// 复制成快照后，调用方可在遍历结果时安全地 resolve 或新增等待者，不会改动正在迭代的 Map。
		return [...this.#sets.keys()];
	}

	/** 用 value 完成 key 下全部等待并删除该组；未知键无事发生。例：resolve(7, result)。 */
	resolve(key: K, value: T): void {
		const set = this.#sets.get(key);
		// 先移除，之后对同键 add 会创建新组。
		this.#sets.delete(key);
		// 没有该键时迭代空数组；已有 Promise 都收到同一个值引用。
		// Promise 只有第一次 resolve/reject 生效；若某等待者同时被 abort 拒绝，后到的调用只是空操作。
		for (const waiter of set ?? []) waiter.resolve(value);
	}

	/** 用同一个 unknown 原因拒绝全部等待并清空登记；例如 Session 关闭时使用。 */
	// 参数类型是 unknown 而不是 Error：Session 可能因任意被抛出的值失败，调用方不必先包装。
	// 例：rejectAll(closedError(session)) 让所有未完成的 add 同时拒绝，之后 keys() 为空。
	rejectAll(error: unknown): void {
		// 清 Map 前取集合快照，否则会失去需要拒绝的等待者。
		const sets = [...this.#sets.values()];
		this.#sets.clear();
		// 外层遍历各键的集合，内层拒绝集合中每一个 Promise。
		for (const set of sets) for (const waiter of set) waiter.reject(error);
	}
}

/** Every item of a paginated scan, in page order. */
/**
 * 逐次 await scan(cursor) 到 next 为 undefined，按页内顺序合并，不排序或去重。
 * scan 首次收到 undefined，任何页失败会使整个 Promise 拒绝。例：两页 [a,b]、[c] 得 [a,b,c]。
 */
// 参数签名示例：scanAll((cursor) => storage.scanTasks({ status: "queued" }, 256, cursor, context))。
// 返回的数组是新数组，元素本身仍是存储/事务返回的同一引用；不修改 Page，不感知业务含义。
export async function scanAll<T>(scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> {
	// T 是元素类型，数组逐页积累；未赋值的 cursor 初始为 undefined。
	// Page<T, Cursor> 由 items 和可选 next 游标组成，next 为 undefined 表示没有下一页。
	const items: T[] = [];
	let cursor: Cursor | undefined;
	do {
		// do/while 至少读一页，await 后才能知道下一游标。
		const page = await scan(cursor);
		// 将这页的元素逐个传给 push，保留页内与页间顺序。
		// ... 把 page.items 展开成一个个实参；页很大时也只为本次调用创建实参列表。
		items.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return items;
}

/** What a closed Harness rejects with: `SessionFailed` with the cause when it closed because the Session failed. */
/** 构造关闭错误而不抛出：无 failure 得普通 Error，有则用 SessionFailed 保留原错误 cause。 */
// 参数是结构化类型：只要求有可选的 failure.error，不要求传入真正的 Session 类。
// 无副作用；调用方决定 throw 还是交给 Promise 拒绝。例：closedError({ failure: undefined }).message 为 "Harness is closed"。
export function closedError(session: { readonly failure: { readonly error: unknown } | undefined }): Error {
	const failure = session.failure;
	// 三元表达式选择实例；unknown 允许 cause 为任意被抛出的值。
	return failure === undefined ? new Error("Harness is closed") : new SessionFailed(failure.error);
}

/** `{ extension }` when the extension is known. */
/** 将可选扩展名变成可展开字段，不验证名字。例：undefined 得 {}，"search" 得 { extension: "search" }。 */
// 用途：把扩展名并进诊断或报告对象时，省略键比留下 undefined 更符合严格 JSON / 可选字段语义。
// 输入可为任意字符串（含空串），函数不做白名单检查；返回值是新对象，每次调用都会分配。
export function optionalExtension(extension: string | undefined): { readonly extension?: string } {
	// 省略键与保留 extension: undefined 不同，调用者可把结果展开进报告。
	return extension === undefined ? {} : { extension };
}

/** The scan of conversation `conversationId`'s history that `query` asks for, without fields an untyped caller added. */
/**
 * 用独立会话 ID 和 query 中三个允许字段构建查询，不读存储、不修改输入。
 * Omit 在类型层去掉 conversationId；实际对象重建还会忽略 JavaScript 调用者额外传入的字段。
 * 例：query 为 { order: "ascending" } 时结果只含指定会话和顺序，不含未提供的范围键。
 */
// 典型调用在 Harness.entries：conversationEntries(this.id, query)，随后交给 storage.scanEntries 分页。
// Omit<EntryQuery, "conversationId"> 是映射类型：得到去掉该键后的新类型，运行时仍是普通对象参数。
export function conversationEntries(
	conversationId: ConversationId,
	query: Omit<EntryQuery, "conversationId">,
): EntryQuery {
	return {
		// 会话始终取独立参数；不接受 query 携带的同名字段覆盖它。
		conversationId,
		// 条件对象展开只加入有值字段；这里是白名单投影，不是对范围数值的运行时校验。
		...(query.minEntryId === undefined ? {} : { minEntryId: query.minEntryId }),
		...(query.maxEntryId === undefined ? {} : { maxEntryId: query.maxEntryId }),
		...(query.order === undefined ? {} : { order: query.order }),
	};
}
