// 客户端会话记录拼接器：把观察到的窗口视图与分页加载结果合成一条可能带空洞的记录。
// 所属：packages/durable/src/harness，Durable 的客户端视图层（spec §9.3）。
// 上游：应用或适配器创建 ConversationTranscript，merge() 接收 ConversationView（Harness 观察到的窗口）。
// 下游：返回 TranscriptView 供渲染；loadEarlier/fillGap 通过注入的 EntryLoader 调 Conversation.entries()。
// 它不订阅 Session、不写存储；条目 ID 有空洞，算法只比较边界，从不按 ID 计数或推算“第几条”。
// 能力清单：
// - TranscriptItem：客户端一行，判别联合 entry / gap / earlier。
// - TranscriptView：去掉窗口 entries/before、改为全量 items 的会话视图。
// - EntryLoader：会话记录分页加载函数类型，形状同 Conversation.entries()。
// - ConversationTranscriptOptions：pageSize 选项，默认 50。
// - ConversationTranscript：持有已加载条目与空洞、合并视图并支持向上翻页/填洞的类。
// 组合与顺序：应用把每个观察到的 ConversationView 交给 merge；需要补更早记录时把 items 里的 earlier 项映射到
// loadEarlier，把 gap 项映射到 fillGap；两者经 EntryLoader 取页后都由 #cover 更新范围、#build 重排 items。
// resume 提供掉线后重新 watch 的窗口；newest 给出当前记录到达的 ID。
// 示例：const transcript = new ConversationTranscript((query, limit, context) =>
//   conversation.entries(query, limit, undefined, context));
// const first = transcript.merge(observed); // observed: ConversationView
// await transcript.loadEarlier(context);    // 若 first.items[0] 是 earlier
// 错误流向：构造时 pageSize 非正整数抛 RangeError；未 merge 时 loadEarlier/fillGap 返回拒绝 Promise；
// 加载器抛错会让对应共享 Promise 拒绝，状态回滚到调用前（#cover 尚未执行）。
// 建议阅读顺序：先看四个导出类型，再看类字段与 constructor，然后 merge、loadEarlier、fillGap，
// 最后看 #cover、#subtract、#build、#result 与两个纯函数助手。
import type { Context } from "@earendil-works/chord/context";
import { idFromNumber } from "../ids.ts";
import type { Cursor, EntryId, EntryQuery, EntryRecord, Page } from "../types.ts";
import type { ConversationView, ConversationWindow } from "./view.ts";

/** One row of a client's transcript. */
// 判别联合：kind 是判别字段，switch/if 收窄后 TypeScript 才知道该行有没有 entry、after 等字段。
// 这只是编译期收窄；运行时只假设调用方给的对象确实带 kind（本类型不额外校验）。
export type TranscriptItem =
	// 已持有的一条会话记录。
	| { readonly kind: "entry"; readonly entry: EntryRecord }
	/** Entries strictly between `after` and `upTo` are missing: render "load more" and call `fillGap()`. */
	// 空洞：ID 严格位于 after 与 upTo 之间的记录尚未加载；两端都是已加载/已知边界。
	| { readonly kind: "gap"; readonly after: EntryId; readonly upTo: EntryId }
	/** The transcript continues above: render "load earlier" and call `loadEarlier()`. Always the first item. */
	// 更早的记录尚未加载；只要已知区间的下界不是 -Infinity，它就作为第一项出现。
	| { readonly kind: "earlier" };

/** The conversation view as a renderer sees it: `items`, the client's whole transcript, instead of the window. */
// Omit 在类型层去掉窗口字段 entries/before，再用 items 取代；运行时仍是普通对象，不会删除多余字段。
// 因此渲染器拿到的会话/documents 与最近一次 merge 的 view 相同，只是条目换成客户端全量拼接结果。
export type TranscriptView = Omit<ConversationView, "entries" | "before"> & {
	readonly items: readonly TranscriptItem[];
};

/** Pages a conversation's entries, as `Conversation.entries()` does without a cursor. */
// 加载器签名与 Conversation.entries() 的查询对齐：query 不含会话 ID（已由闭包绑定），limit 是页大小。
// 返回 Page：items 是本页记录，next 是续页游标；transcript 只按调用顺序使用，不检查游标来源。
export type EntryLoader = (
	query: Omit<EntryQuery, "conversationId">,
	limit: number,
	context: Context,
) => Promise<Page<EntryRecord, Cursor>>;

// 构造选项：pageSize 控制 loadEarlier/fillGap 每次请求的条数，默认 50；仅在构造时读取。
export type ConversationTranscriptOptions = {
	/** Entries `loadEarlier()` and `fillGap()` load per call; default 50. */
	readonly pageSize?: number;
};

// Extract 是条件工具类型：从联合中挑出 kind 为字面量 "gap" / "entry" 的成员，编译期完成。
// Gap 与 EntryItem 让后续代码能直接访问 after/upTo 或 entry，而不再需要每次判 kind。
type Gap = Extract<TranscriptItem, { kind: "gap" }>;
type EntryItem = Extract<TranscriptItem, { kind: "entry" }>;

// 共享的不可变占位项：所有 TranscriptView 的 items 数组都复用同一对象，比较身份即可知道没有新建。
const EARLIER: TranscriptItem = Object.freeze({ kind: "earlier" });

/**
 * What a client has of one conversation: every entry it got from a view or fetched, and the gaps between (spec §9.3).
 * A layer over any `ConversationView`, wherever it comes from: call `merge()` with every value of the view; it returns
 * the view with the client's whole transcript as `items` instead of the window. Entries never change once committed,
 * so the transcript only grows; a window that dropped its oldest entries keeps them here.
 *
 * A window whose `before` lies past the newest entry the client has does not continue it, after a stall, an overflow,
 * or a reconnect: the entries in between become a gap. Nothing counts entries or computes ranges from entry IDs, which
 * have holes; only exclusive bounds are turned into the inclusive bounds of `EntryQuery`. After a drop, a new watch
 * with `resume` as its window continues the transcript.
 *
 * A merge costs O(items) and never re-sorts or re-fetches; a merge, `loadEarlier()`, or `fillGap()` that adds nothing
 * returns the previous `items` array. Concurrent calls of `loadEarlier()`, or of `fillGap()` for the same gap, share one
 * load, so a placeholder that stays visible does not fetch twice.
 */
/**
 * 输入：构造时给 EntryLoader 与可选 pageSize；merge 给 ConversationView；loadEarlier/fillGap 给 Context（和 gap）。
 * 输出：公开方法都返回 TranscriptView；items 是客户端全量记录，含 entry/gap/earlier 三种行。
 * 副作用：只改实例内的 #entries/#gaps/#ids/#low/#tail/#items 与缓存；不写 Session，也不提交事务。
 * 错误：pageSize 非正整数抛 RangeError；未 merge 就翻页会得到拒绝的 Promise；加载器错误原样传播。
 * 流程：merge 覆盖窗口并扣减空洞；loadEarlier 向更早翻页；fillGap 从洞的起点向后填；#cover 更新已知范围，
 * #build 把条目与空洞交错成 items，#result 复用未变化的视图身份。
 * 真实运行时不会校验 EntryRecord 内容或 ID 连续性；以下示例只示意调用形状。
 * 示例：const transcript = new ConversationTranscript(
 *        (q, limit, ctx) => conversation.entries(q, limit, undefined, ctx));
 *      const view = transcript.merge(observed); // observed 来自 conversation.watch
 *      await transcript.loadEarlier(context);
 */
export class ConversationTranscript {
	// 注入的分页加载器；#pageSize 是 loadEarlier/fillGap 每次请求的条数。
	readonly #load: EntryLoader;
	readonly #pageSize: number;
	/** Every entry held, in ID order, as items. */
	// 已持有的 entry 行，按 ID 升序；空洞和 earlier 不放在这里，由 #items 统一派生。
	#entries: EntryItem[] = [];
	// 已持有 ID 的集合，用于去重；Set 的查找是 O(1)，避免每次 merge 扫描 #entries。
	readonly #ids = new Set<EntryId>();
	/** Gaps in ID order; each is an immutable item, replaced when it shrinks. */
	// 尚未加载的 ID 区间，按 ID 升序；每次缩小会换成新的冻结对象（gapOf）。
	#gaps: Gap[] = [];
	/** Whether anything was merged yet. */
	// 是否已经 merge 过；首次 merge 之前 resume 返回 undefined。
	#started = false;
	/** Exclusive lower bound of the known range: entries at or below it are not loaded; `-Infinity` at the start. */
	// 已知区间的排他下界：ID <= #low 的条目不在已知范围内；-Infinity 表示还没触到记录起点。
	#low = Number.NEGATIVE_INFINITY;
	/** Inclusive upper bound of the known range: the newest entry, or a later empty window's `before`. */
	// 已知区间的含端点上界：最新的条目 ID，或后续空窗口给出的 before；-Infinity 表示还没有任何已知 ID。
	#tail = Number.NEGATIVE_INFINITY;
	// 当前对外暴露的行数组；只在 #build 或尾部追加时换成新数组，便于 #result 做身份比较。
	#items: readonly TranscriptItem[] = [];
	// 最近一次 merge 的窗口视图：提供 conversation/docs，以及空窗口的 before。
	#last: ConversationView | undefined;
	// 上次返回的 TranscriptView；items/docs/conversation 都没变时直接复用它。
	#view: TranscriptView | undefined;
	// 共享的在途 loadEarlier Promise；并发调用只发一次请求。
	#earlier: Promise<TranscriptView> | undefined;
	// 按 "after:upTo" 共享的在途 fillGap Promise；同一洞的重复调用不会重复加载。
	readonly #filling = new Map<string, Promise<TranscriptView>>();

	/**
	 * 创建拼接器：load 负责取页，options.pageSize 默认 50；只校验参数，不加载任何记录。
	 * 错误：pageSize 不是安全整数或小于 1 时同步抛 RangeError。
	 * 例：new ConversationTranscript(
	 *   (query, limit, context) => conversation.entries(query, limit, undefined, context),
	 *   { pageSize: 100 },
	 * )。
	 */
	constructor(load: EntryLoader, options?: ConversationTranscriptOptions) {
		// options?. 允许省略整个选项对象；?? 只在左侧为 undefined 时取默认值。
		const pageSize = options?.pageSize ?? 50;
		// Number.isSafeInteger 是运行时检查：类型 number 本身不能保证正整数，因此这里必须验证。
		if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
			throw new RangeError(`Page size must be an integer >= 1, got ${pageSize}`);
		}
		this.#load = load;
		this.#pageSize = pageSize;
	}

	/**
	 * The ID the transcript reaches: its newest entry, or the `before` of a later window that was empty. Undefined before
	 * the first merge and for an empty transcript.
	 */
	get newest(): EntryId | undefined {
		// -Infinity 用作“还没有任何已知 ID”的哨兵；对外不暴露这个数值。
		// idFromNumber 只在可信边界套用 EntryId 品牌类型，运行时仍是 number，不检查记录是否存在。
		return this.#tail === Number.NEGATIVE_INFINITY ? undefined : idFromNumber<EntryId>(this.#tail);
	}

	/**
	 * The window that resumes this transcript after a drop: `{ from }` right after `newest`, so a new watch returns only
	 * what was missed when it fits its window, otherwise its newest entries and a gap; `{}` for an empty transcript;
	 * undefined before the first merge. `conversation.watch(context, transcript.resume)`.
	 */
	get resume(): ConversationWindow | undefined {
		// 首次 merge 之前不知道任何 ID，无法给出续看窗口。
		if (!this.#started) return undefined;
		const newest = this.newest;
		// 空记录给 {}（没有 from）；否则从 newest+1 开始，让新 watch 只返回遗漏的条目。
		return newest === undefined ? {} : { from: idFromNumber<EntryId>(newest + 1) };
	}

	/** Take one value of the view: its window's entries join the transcript. */
	/**
	 * 合并一个窗口视图并返回客户端全量视图：输入 ConversationView，输出 TranscriptView。
	 * 副作用：更新 #last 与已加载条目/范围；不修改 view，不发请求，也没有显式错误路径。
	 * 窗口可能为空（只带 before），此时用 before 当上界，仍能推进已知范围。
	 * 例：transcript.merge({ conversation, docs: {}, entries: [e5], before: id4 })。
	 */
	merge(view: ConversationView): TranscriptView {
		this.#last = view;
		// 对象解构：entries 是窗口内记录（ID 升序），before 是窗口前一条的 ID（窗口从记录起点开始时缺省）。
		const { entries, before } = view;
		// at(-1) 取最后一项，可选链避免空数组；?? 依次回退到 before、-Infinity（窗口完全为空且无 before）。
		const hi = entries.at(-1)?.id ?? before ?? Number.NEGATIVE_INFINITY;
		// 窗口覆盖的 ID 区间是 (before, hi]：before 是窗口前一条记录，窗口内是本次新增认识的范围。
		this.#cover(before ?? Number.NEGATIVE_INFINITY, hi, entries);
		return this.#result();
	}

	/** Load the page before the oldest entry held. Without anything earlier, returns the current view. */
	/**
	 * 从已持有条目的最旧处向更早翻一页；输入 Context，输出新的 TranscriptView（并发时是共享的 Promise）。
	 * 副作用：加载完成后更新 #entries/#gaps/#low/#tail；不写存储，也不修改调用方对象。
	 * 错误：从未 merge 时返回拒绝 Promise；加载器或分页失败使该 Promise 拒绝，已加载状态不变。
	 * 流程：查共享 Promise → 取当前排他下界 → 降序查 maxEntryId=下界 → 反转成升序 → #cover 扩展范围 → #result。
	 * 例：await transcript.loadEarlier(context) 后，items 顶部可能仍有 earlier（还有更早页），也可能消失（已到起点）。
	 */
	loadEarlier(context: Context): Promise<TranscriptView> {
		const last = this.#last;
		// 没有最近视图就拿不到 conversation/docs，也没法判断从哪继续；返回拒绝的 Promise 而非同步 throw。
		if (last === undefined) return Promise.reject(new Error("ConversationTranscript: merge a view first"));
		// 下界仍是 -Infinity 表示已经知道记录起点，没有更早的记录可加载。
		if (this.#low === Number.NEGATIVE_INFINITY) return Promise.resolve(this.#result());
		// 已有在途加载时直接复用它，避免占位符一直可见时重复请求。
		if (this.#earlier !== undefined) return this.#earlier;
		// 先捕获本次的下界；加载期间即使其他 merge 改了 #low，这次查询仍以捕获值为准。
		const low = this.#low;
		// The loader runs in a later microtask, so even its synchronous throw settles a promise that is already shared.
		// Promise.resolve().then 把加载推迟到微任务，保证加载器即使同步 throw 也只会让已共享的 Promise 拒绝。
		const loading = Promise.resolve().then(async () => {
			// 查询 ID <= 当前排他下界的记录，降序取最新一页；as const 让 order 字面量满足 EntryQuery 的联合。
			const query = { maxEntryId: idFromNumber<EntryId>(low), order: "descending" } as const;
			const page = await this.#load(query, this.#pageSize, context);
			// 页内是降序；复制后反转成升序，才能交给按 ID 升序维护的 #entries。
			const items = [...page.items].reverse();
			const oldest = items[0];
			// No next page, or an empty one: the transcript starts here.
			// page.next 为 undefined 说明后端没有更早页；空页同样说明已到起点。
			// 两种情况都把下界推到 -Infinity，之后 #build 不再放 earlier 占位。
			if (page.next === undefined || oldest === undefined) this.#cover(Number.NEGATIVE_INFINITY, low, items);
			// 否则本次只覆盖 (oldest.id - 1, low]；更早的部分保持未知，下一次 loadEarlier 继续。
			else this.#cover(oldest.id - 1, low, items);
			return this.#result();
		});
		this.#earlier = loading;
		// 完成后只清除自己登记的那次；期间若已有新调用覆盖 #earlier，不能误删。
		const settled = (): void => {
			if (this.#earlier === loading) this.#earlier = undefined;
		};
		// then 的第二个参数同样传 settled：成功、失败都要解除共享登记。
		loading.then(settled, settled);
		return loading;
	}

	/**
	 * Load the next page of `gap`, a gap item of `items`, shrinking it from its start, or removing it once nothing is
	 * missing. A gap that has shrunk since loads the gap it became; one that is no longer there returns the current view.
	 */
	/**
	 * 从洞的起点向后加载一页；输入 items 里的一个 gap 与 Context，输出新 TranscriptView（同洞并发共享）。
	 * 副作用：加载成功后缩小或移除该洞，并把新条目并入 #entries；不修改传入的 gap 对象。
	 * 错误：从未 merge 时返回拒绝 Promise；加载器失败使共享 Promise 拒绝，洞保持原样。
	 * 流程：把旧描述符解析到当前洞 → 按 "after:upTo" 共享 → 查 (after, upTo) 内的一页 → #cover 覆盖 → #result。
	 * 例：const gap = view.items.find((item) => item.kind === "gap");
	 *      if (gap !== undefined) await transcript.fillGap(gap, context);
	 */
	fillGap(gap: Gap, context: Context): Promise<TranscriptView> {
		// 先找 after/upTo 完全相同的洞；找不到再找与之重叠的洞。
		// 旧描述符可能在别的 fillGap 之后已经缩小，按重叠仍能定位到它变成的那个洞。
		const current =
			this.#gaps.find((each) => each.after === gap.after && each.upTo === gap.upTo) ??
			this.#gaps.find((each) => each.after < gap.upTo && gap.after < each.upTo);
		// 没有匹配洞：要么洞已被填满，要么描述符过期；只要 merge 过就返回当前视图。
		if (current === undefined) {
			const last = this.#last;
			if (last === undefined) return Promise.reject(new Error("ConversationTranscript: merge a view first"));
			return Promise.resolve(this.#result());
		}
		// Keyed by the gap the call resolved to, so a stale descriptor and the current one share the load.
		// 键用解析后的当前洞边界，因此过期描述符与当前描述符会共享同一次加载。
		const key = `${current.after}:${current.upTo}`;
		const running = this.#filling.get(key);
		if (running !== undefined) return running;
		// 与 loadEarlier 相同：推迟到微任务，保证加载器同步 throw 也只拒绝这个已经共享的 Promise。
		const filling = Promise.resolve().then(async () => {
			// 洞是排他区间 (after, upTo)，EntryQuery 用含端点上下界，所以查询 [after+1, upTo-1]。
			// 升序取最靠前的 pageSize 条，从洞的起点开始填。
			const query = {
				minEntryId: idFromNumber<EntryId>(current.after + 1),
				maxEntryId: idFromNumber<EntryId>(current.upTo - 1),
				order: "ascending",
			} as const;
			const page = await this.#load(query, this.#pageSize, context);
			// 升序页的最后一项是本次能到达的最大 ID。
			const newest = page.items.at(-1);
			// No next page, or an empty one: nothing else is missing.
			// 没有续页或空页说明洞已到底；覆盖整个 (after, upTo-1]，#subtract 会把该洞移除。
			if (page.next === undefined || newest === undefined) this.#cover(current.after, current.upTo - 1, page.items);
			// 否则只覆盖到 newest；剩余部分仍由 #subtract 保留为更小的洞。
			else this.#cover(current.after, newest.id, page.items);
			return this.#result();
		});
		this.#filling.set(key, filling);
		// 成功后只清除本次登记；身份比较避免误删后来者的 Promise。
		const settled = (): void => {
			if (this.#filling.get(key) === filling) this.#filling.delete(key);
		};
		filling.then(settled, settled);
		return filling;
	}

	/**
	 * Record that every entry with an ID in (`lo`, `hi`] is known, `added` being those entries in ID order: hold the new
	 * ones, shrink the gaps they fill, extend the known range, and open a gap where the range does not continue it.
	 */
	/**
	 * 记录“ID 在 (lo, hi] 内的条目都已知道”，added 是按 ID 升序的这批条目。
	 * 输入：排他下界 lo、含端点上界 hi、已知条目数组；输出 void。
	 * 副作用：更新 #entries/#ids/#gaps/#low/#tail/#items；不发起请求，也不修改 added 中的对象。
	 * 错误：不主动抛错；前提是 added 按 ID 升序（由加载器保证），乱序会让归并与空洞计算失真。
	 * 流程：过滤已持有 → 选择尾部追加或归并 → 按“首个区间 / 上方 / 下方 / 重叠”更新范围与空洞 → 必要时重建 items。
	 * 例：#cover(4, 6, [e5, e6]) 表示 5、6 已知，且 4 之前仍可能有未知记录。
	 */
	#cover(lo: number, hi: number, added: readonly EntryRecord[]): void {
		// 去重：已经持有的 ID 不重复插入；Set.has 是 O(1)，filter 只遍历本次新增。
		const fresh = added.filter((entry) => !this.#ids.has(entry.id));
		for (const entry of fresh) this.#ids.add(entry.id);
		// 保存旧 #entries 引用：后面要判断新条目是否全部位于尾部，以及重建 items 的基准。
		const held = this.#entries;
		// New entries past every held one: the items grow at their end.
		// 空新增、原本为空、或首条新增 ID 大于最后一条旧 ID，都可以直接 concat 到尾部。
		// 这里的 ! 是类型断言：|| 短路保证数组非空，但 TypeScript 不会为下标访问自动收窄。
		const appended = fresh.length === 0 || held.length === 0 || fresh[0]!.id > held.at(-1)!.entry.id;
		// 把记录包装成 entry 行；返回类型标注让 map 结果满足 EntryItem 的判别联合。
		const items = fresh.map((entry): EntryItem => ({ kind: "entry", entry }));
		// 尾部追加只需复制一次；插入中间则单趟归并，保持 ID 升序。
		if (items.length > 0) this.#entries = appended ? held.concat(items) : mergeById(held, items);
		let rebuild = false;
		// 第一种：首个已知区间，或此前完全没有条目/空洞、且新区间不早于已知上界。
		if (!this.#started || (held.length === 0 && this.#gaps.length === 0 && lo >= this.#tail)) {
			// The first range, or one after an empty transcript: it is all the client knows.
			// 此前没有可交错的条目，因此这个区间就是客户端全部已知内容，不需要造空洞。
			// 只有首次 merge 或下界变化会影响 earlier 占位，才需要重建 items。
			rebuild = !this.#started || lo !== this.#low;
			this.#started = true;
			this.#low = lo;
			this.#tail = Math.max(this.#tail, hi);
		} else if (lo > this.#tail) {
			// Past the newest known ID: what lies between is missing.
			// 新区间整体在已知上界之上：从旧上界到首条新记录之间无法表示，记一个洞。
			// added 为空时洞一直延伸到 lo，用 lo + 1 作为含端点式的“下一 ID”边界。
			const upTo = added[0]?.id ?? lo + 1;
			this.#gaps = [...this.#gaps, gapOf(this.#tail, upTo)];
			this.#tail = hi;
			rebuild = true;
		} else if (hi !== Number.NEGATIVE_INFINITY && hi < this.#low) {
			// Below the oldest known ID: what lies between is missing.
			// 新区间整体在最旧已知 ID 之下：洞从新区间上界延伸到第一条已持有记录（或旧下界之后）。
			const upTo = held.find((item) => item.entry.id > hi)?.entry.id ?? this.#low + 1;
			this.#gaps = [gapOf(hi, upTo), ...this.#gaps];
			this.#low = lo;
			rebuild = true;
		} else {
			// 与已知范围重叠或相邻：扣掉 (lo, hi] 已覆盖的部分，再按需扩展边界。
			const gaps = this.#subtract(lo, hi);
			if (gaps !== this.#gaps) {
				this.#gaps = gaps;
				rebuild = true;
			}
			if (lo < this.#low) {
				this.#low = lo;
				rebuild = true;
			}
			// 上界只影响未来空洞/续看位置，不影响现有 items 的顺序，因此不必重建。
			if (hi > this.#tail) this.#tail = hi;
		}
		// 中间插入会改变与空洞的交错位置，必须重建；尾部追加才可走 concat 快速路径。
		if (rebuild || !appended) this.#items = this.#build();
		else if (items.length > 0) this.#items = this.#items.concat(items);
	}

	/** The gaps without (`lo`, `hi`]; the same array when none changes, as when the range is empty. */
	/**
	 * 返回去掉已知区间 (lo, hi] 后剩下的空洞；输入排他下界与含端点上界，输出 Gap[]。
	 * 没有任何空洞变化时返回原数组（身份不变），调用方据此跳过重建；不修改原数组或条目。
	 * 例：洞 (0, 10) 减去 (4, 6] 后得到 (0,5) 与 (6,10) 两段（分别缺 1..4、7..9）。
	 */
	#subtract(lo: number, hi: number): Gap[] {
		// 空区间（hi <= lo）不覆盖任何 ID，空洞原样返回。
		if (hi <= lo) return this.#gaps;
		let changed = false;
		const gaps: Gap[] = [];
		for (const gap of this.#gaps) {
			// Missing: IDs in (after, upTo); known now: IDs in (lo, hi].
			// 两区间不相交：已知区间在洞下方（hi <= after），或已知区间从洞的末尾之后才开始。
			if (hi <= gap.after || lo + 1 >= gap.upTo) {
				gaps.push(gap);
				continue;
			}
			changed = true;
			// 洞的左段仍然未知：从 after 到“第一条位于 lo 之后的已持有条目”（没有则到 lo+1）。
			if (lo > gap.after) {
				const firstKnown = this.#entries.find((item) => item.entry.id > lo)?.entry.id ?? lo + 1;
				gaps.push(gapOf(gap.after, Math.min(gap.upTo, firstKnown)));
			}
			// 洞的右段仍然未知：从已知区间上界 hi 到原洞末尾。
			if (hi + 1 < gap.upTo) gaps.push(gapOf(hi, gap.upTo));
		}
		return changed ? gaps : this.#gaps;
	}

	/** Items in ID order: "earlier" until the start is known, then entries with each gap before the entry after it. */
	/**
	 * 把 #entries 与 #gaps 交错成对外 items：下界未知时先放 earlier，然后在每条记录前插入 after 更小的洞。
	 * 输入无；输出新数组；不修改内部状态，耗时 O(entries + gaps)。
	 * 例：entries=[e5,e9]、gaps=[(6,8)] 得到 e5、gap(6,8)、e9（若下界未知则再加 earlier）。
	 */
	#build(): TranscriptItem[] {
		// 只有已经知道记录起点（#low === -Infinity）才不放 earlier；否则顶部仍有更早内容。
		const items: TranscriptItem[] = this.#low === Number.NEGATIVE_INFINITY ? [] : [EARLIER];
		const gaps = this.#gaps;
		// 两个数组都按 ID 升序，用单个游标 next 即可一遍扫完。
		let next = 0;
		for (const item of this.#entries) {
			// 所有 after 小于当前记录 ID 的洞都应排在这条记录之前；! 表示下标经 while 条件保证有效。
			while (next < gaps.length && gaps[next]!.after < item.entry.id) items.push(gaps[next++]!);
			items.push(item);
		}
		// 尾部剩余的洞（位于所有已持有记录之后）依次追加。
		while (next < gaps.length) items.push(gaps[next++]!);
		return items;
	}

	/** The view with the current items; the previous one when nothing changed. */
	/**
	 * 用当前 #last 与 #items 生成或复用 TranscriptView；输入无，输出视图。
	 * 副作用仅更新 #view 缓存；不解释条目内容。只有三项身份都相同才复用，避免渲染器误判变化。
	 * 例：同一窗口连续 merge 两次且无新条目时，返回同一个 view 对象。
	 */
	#result(): TranscriptView {
		// ! 是类型断言：所有调用点都先确认 #last 已由 merge 设置（loadEarlier/fillGap 有前置检查）。
		const last = this.#last!;
		const previous = this.#view;
		// 引用相等而非深比较：items/docs/conversation 都是不可变或共享对象，身份不变即内容不变。
		if (
			previous !== undefined &&
			previous.items === this.#items &&
			previous.docs === last.docs &&
			previous.conversation === last.conversation
		) {
			return previous;
		}
		// 新视图复用最近的 conversation/docs；Omit 类型保证这里不再带 entries/before。
		this.#view = { conversation: last.conversation, docs: last.docs, items: this.#items };
		return this.#view;
	}
}

/** 把数字边界包成冻结的 Gap；例：gapOf(4, 6) 表示缺 ID 5。 */
// Object.freeze 防止调用方改动共享的洞对象；idFromNumber 只在边界处套用 EntryId 品牌，运行时仍是 number。
function gapOf(after: number, upTo: number): Gap {
	return Object.freeze({ kind: "gap", after: idFromNumber<EntryId>(after), upTo: idFromNumber<EntryId>(upTo) });
}

/** Two ID-ordered item lists merged in one pass. */
/**
 * 单趟归并两个按 ID 升序的 entry 行数组；输入两个数组，输出新数组，不修改输入。
 * 不负责去重（调用前已用 #ids 过滤）；例：[e1,e4] 与 [e2,e3] 得 [e1,e2,e3,e4]。
 */
function mergeById(left: readonly EntryItem[], right: readonly EntryItem[]): EntryItem[] {
	const merged: EntryItem[] = [];
	// 双指针分别扫描左右；每次取 ID 较小的一项，i++/j++ 返回旧下标后再前进。
	let i = 0;
	let j = 0;
	while (i < left.length && j < right.length) {
		// ! 是下标断言：循环条件保证 i、j 仍在范围内。
		merged.push(left[i]!.entry.id < right[j]!.entry.id ? left[i++]! : right[j++]!);
	}
	// 一侧耗尽后，把另一侧剩余项按序追加。
	while (i < left.length) merged.push(left[i++]!);
	while (j < right.length) merged.push(right[j++]!);
	return merged;
}
