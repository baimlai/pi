// 所属：packages/durable/src/harness，Durable harness 的上下文推导层。
// 解决的问题：已提交的 EntryRecord 只是事件记录；模型请求需要“活动转录 + 编辑后的消息 + 基线系统提示词 + 成对工具结果”，
// 而每次请求全量扫描会随历史增长变慢。本文件用 head/tail 边界把不可变前缀缓存成 ContextRange。
// 职责边界：只读存储、在内存中冻结推导结果；不追加条目、不提交事务、不改文档。
// 关键不变量：范围边界（head 与 tail）之下的条目不会再变，因此可以缓存；扫描在 Session 线之外完成，边界在线上捕获。
// 上游：generation/compaction/tool 等任务在准备请求、选择压缩区间、估算 token 时调用。下游：pi-ai 的 Message[]。
// 能力清单：
// - ContextBounds：head 标记与 tail 端点的形状；
// - captureContextBounds：在 Session 线上捕获边界（at 可指定历史切片）；
// - ContextRange：一次读取的条目、派生视图、编辑集合、settled/open、基线状态和 current 标记；
// - readContextFrom：带缓存的读取，复用同 head 的上一次范围；
// - readContext：无缓存的一次性读取；
// - deriveContext：从边界完整推导 ContextView；
// - rangeEntry：在范围内按 ID 二分查找条目；
// - advanceRange：把一次提交追加的条目并入 current 范围，必要时裁剪或失效；
// - orderToolResults：把工具结果按调用顺序紧跟助手消息，缺失时合成错误结果。
// 典型顺序：readContextFrom/readContext 捕获边界 → deriveContext 或增量延展 → generation 用 view.messages 发请求；
//   提交后可用 advanceRange 避免重扫；压缩用 view.entries 与 selectCut 选择区间。
// 示例：const { view, range } = await readContextFrom(session, storage, conversationId, context, undefined, previous);
//   // view.messages 是本次请求消息；下一次提交后可把 range 交给 advanceRange()。示例不含实际读取的条目内容。
// 建议阅读顺序：先读 ContextBounds/ContextRange 字段含义，再读 readContext/deriveContext 的主流程，随后
//   advanceRange/extendRange 的增量规则，最后 orderToolResults/findBaseline 这两个顺序细节。
import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { SystemEntry } from "../entries.ts";
import { idFromNumber } from "../ids.ts";
import type { SessionImpl } from "../session/session.ts";
import type { ContextEdit, ConversationId, Cursor, EntryId, EntryQuery, EntryRecord, Storage } from "../types.ts";
import type { ContextView } from "./types.ts";

// 每页扫描 256 条，只是分页大小，不影响结果顺序；结果会 reverse 成从旧到新。
const SCAN_PAGE_SIZE = 256;
// 不进入模型上下文的停止原因：被中止、出错和延迟的助手响应都跳过；工具调用/正常停止仍保留。
const EXCLUDED_STOP_REASONS: ReadonlySet<AssistantMessage["stopReason"]> = new Set(["aborted", "error", "deferred"]);
// 工具调用没有对应结果时合成这段文本，保证模型看到“调用存在但结果缺失”，而不是悬空的 toolCall。
const MISSING_RESULT_TEXT = "Tool result unavailable: history ends before this call completed.";

// ContextBounds 固定一次上下文范围的端点：head 是最新可见的 head 标记（可能没有），tail 是范围末端条目 ID。
// 这两个字段是推导输入；范围一旦捕获，尾部条目不可变，后续读取只能延展 tail。
/** Head marker and newest visible entry that fix one committed context range. */
export type ContextBounds = {
	readonly head: (EntryRecord & { readonly head: EntryId }) | undefined;
	readonly tail: EntryId;
};

// captureContextBounds 在 Session 线上捕获范围端点；at 给定时表示“截至某个可见条目的历史视图”。
// 参数 session 提供最新条目/head 标记的缓存，storage 用于验证 at 可见，context 传递取消与遥测。
// visible 是调用方已知 at 可见时的优化，跳过一次 storage.entry 读取。
// 返回 undefined 表示会话没有条目；at 不可见时抛 Error。例：captureContextBounds(session, storage, id, ctx) 取当前范围。
/**
 * Capture the bounds of the current context, or of the context cut off at the visible entry `at`. The newest entry
 * and head marker are known from the Session's commits, so the current bounds usually cost no Storage read. Run this
 * on the Session line; entries at or below the tail are immutable, so `deriveContext()` can then scan them off the
 * line.
 */
export async function captureContextBounds(
	session: SessionImpl,
	storage: Storage,
	conversationId: ConversationId,
	context: Context,
	at?: EntryId,
	/** Set when `at` is known to be visible, as an entry of a range of the conversation is. */
	visible = false,
): Promise<ContextBounds | undefined> {
	// tail 先声明为 undefined，两个分支分别给它赋值，最后构造结果；这种写法让 TS 在返回处确定 tail 非空。
	let tail: EntryId | undefined;
	// 没有 at：取会话最新条目；latestEntryId 通常由 Session 的提交缓存回答，不必读存储。
	if (at === undefined) {
		tail = await session.latestEntryId(conversationId, context);
		if (tail === undefined) return undefined;
	} else {
		// 有 at：先用 storage.entry 验证它确实可见；不可见说明调用者拿了别的会话或已失效的条目。
		if (!visible && (await storage.entry(conversationId, at, context)) === undefined) {
			throw new Error(`Entry ${at} is not visible from conversation ${conversationId}`);
		}
		tail = at;
	}
	// 在 tail 处查最新 head 标记；返回 head 记录（若存在）和 tail，作为后续扫描的边界。
	return { head: await session.latestHeadMarker(conversationId, tail, context), tail };
}

// ContextRange 是一次读取的缓存：entries/view/edited/settled/open/baseline/current 都从同一批条目推导。
// 它可能比单次读取活得更久，所以 entries 和其中的 JSON 值会冻结，防止后续读取意外修改缓存。
/**
 * One context read: the visible entries it scanned, from the head marker's head, or transcript start, through
 * `bounds.tail`, oldest first, and the view derived from them. Entries at or below the tail never change, so a later
 * read with the same head marker extends both.
 */
export type ContextRange = {
	// bounds 是捕获时的端点；后续 advanceRange 只允许 append，不允许改写历史。
	readonly bounds: ContextBounds;
	// entries 是范围内的原始条目，从 head.head（或转录开头）到 tail，按 ID 升序。
	readonly entries: readonly EntryRecord[];
	// view 是派生结果：活动条目、每个条目的贡献消息、最终模型消息。
	readonly view: ContextView;
	// edited 是范围内所有编辑目标 ID 的集合，用于判断新条目是否影响旧条目。
	/** Targets of the edits in `entries`. */
	readonly edited: ReadonlySet<EntryId>;
	// settled 是“不会再被后续条目影响”的消息前缀：最后一个助手消息之前的消息，工具结果已排序。
	/**
	 * `view.messages` from the contributed messages before the last assistant message. Tool results are ordered within
	 * the messages up to the next assistant message, so later entries cannot change these.
	 */
	readonly settled: readonly Message[];
	// open 是最后一个助手消息起、尚未排序工具结果的消息；新条目可能追加工具结果，所以必须保持开放。
	/** Contributed messages from the last assistant message on, before tool result ordering. */
	readonly open: readonly Message[];
	// baseline 是基线系统消息：Message 表示找到，null 表示确定不该有，undefined 表示还可能由后续条目产生。
	/** The baseline's system message; see `findBaseline()`. */
	readonly baseline: Baseline;
	// current 表示读取时是否已经到达最新条目；只有 current 的范围才能用 advanceRange 增量延展。
	/**
	 * Whether the range reached the conversation's newest entry when it was read, so the entries of later commits extend
	 * it (`advanceRange()`); a range cut off at an earlier entry is not.
	 */
	readonly current: boolean;
};

// Baseline 用三态表达“基线是否可能变化”：找到值、确定没有、仍未知；这是运行时也可能出现的普通联合类型。
/** A baseline's system message, `null` when the range cannot have one, or `undefined` while a later entry may be one. */
type Baseline = Message | null | undefined;

// readContextFrom 是带缓存的读取：previous 是同会话上一次的范围，若 head 标记相同，只扫描上次 tail 之后的新条目。
// 返回新的 view（数组是新副本）和可传给下一次读取的 range；heads 变化时重新推导，范围无法安全延展时返回 undefined range。
// 条目在返回前冻结；调用方若保留 range 供 advanceRange 使用，必须在安装它的同步位置再检查 current。
// 例：连续两次读取同一会话，第二次只把新增条目并入 previous，而不是重扫全部历史。
/**
 * `readContext()` that reuses `previous`, an earlier range of the same conversation: with the same head marker, only
 * entries after its tail are scanned. Returns the view and the range to pass to the next read. A range outlives the
 * read, so its entries are frozen like `MemoryStorage` records, and the returned view has its own arrays. A caller that
 * keeps the range for `advanceRange()` checks `current` again, synchronously where it installs it: a commit can be
 * published between this function's return and the caller's continuation.
 */
// visible：at 已给且确实在 previous.entries 中时，captureContextBounds 可以跳过存储验证。
export async function readContextFrom(
	session: SessionImpl,
	storage: Storage,
	conversationId: ConversationId,
	context: Context,
	at: EntryId | undefined,
	previous: ContextRange | undefined,
): Promise<{ readonly view: ContextView; readonly range: ContextRange | undefined }> {
	// 注意这里要求 previous 与 at 同时存在；rangeEntry 用二分查找判断可见性。
	const visible = at !== undefined && previous !== undefined && rangeEntry(previous, at) !== undefined;
	// readOnLine 把边界捕获放到 Session 线上，保证与提交串行；回调只做读操作。
	const bounds = await session.readOnLine((line) =>
		captureContextBounds(session, line, conversationId, context, at, visible),
	);
	// 没有边界（空会话）：返回空视图且没有可复用范围。
	if (bounds === undefined) return { view: emptyView(), range: undefined };
	// bounds.head 来自存储/缓存，冻结它以防缓存与调用方共享时被修改；tail 是数字 ID，无需冻结。
	freezeJson(bounds.head);
	// current 仅由“是否指定 at”决定：指定 at 的范围是历史切片，永远不是最新。
	const current = at === undefined;
	let range: ContextRange;
	// 没有 previous 或 head 标记不同：重新扫描整个范围并完整推导。
	if (previous === undefined || previous.bounds.head?.id !== bounds.head?.id) {
		// scanRange 返回从旧到新的条目；freezeJson 深冻结后保存，避免缓存被后续修改。
		const entries = freezeJson(await scanRange(storage, conversationId, rangeQuery(bounds), context));
		range = deriveRange(bounds, entries, current);
		// 相同 head 且 tail 相同：没有新条目，直接复用上一次范围（view 会再复制数组）。
	} else if (bounds.tail === previous.bounds.tail) {
		range = previous;
		// tail 比上次更小：说明读取的是更早的历史切片（例如分叉点），保留 previous 中不超过新 tail 的条目重新推导。
	} else if (bounds.tail < previous.bounds.tail) {
		range = deriveRange(
			bounds,
			previous.entries.filter((entry) => entry.id <= bounds.tail),
			false,
		);
		// tail 更大：只扫描 previous.tail + 1 到新 tail 的条目；idFromNumber 把数字包装成带品牌类型的 EntryId。
	} else {
		const minEntryId = idFromNumber<EntryId>(previous.bounds.tail + 1);
		const added = await scanRange(storage, conversationId, { minEntryId, maxEntryId: bounds.tail }, context);
		// extendRange 会检查新增条目是否带来编辑/head 标记；若有则完整重推导，否则增量合并。
		range = extendRange(previous, bounds, freezeJson(added), current);
	}
	// 扫描期间可能有新提交；knownLatestEntryId 读取 Session 内存中的最新值，若已前进则把范围标记为非 current。
	// Entries committed while the scan ran off the line are not in the range: it is current only if none was.
	if (range.current && session.knownLatestEntryId(conversationId) !== range.bounds.tail) {
		range = { ...range, current: false };
	}
	// 视图数组复制一份再返回：range 内部保留自己的数组，调用方修改视图不会污染缓存。
	const { view } = range;
	return {
		view: {
			...view,
			entries: [...view.entries],
			contributions: [...view.contributions],
			messages: [...view.messages],
		},
		range,
	};
}

// readContext 是无缓存版本：捕获边界后完整扫描并推导，适合一次性读取（如工具上下文、压缩准备）。
/** Committed context of one conversation: bounds captured on the Session line, entries derived off it. */
// 同样通过 readOnLine 捕获边界；deriveContext 在线上外扫描。
export async function readContext(
	session: SessionImpl,
	storage: Storage,
	conversationId: ConversationId,
	context: Context,
	at?: EntryId,
): Promise<ContextView> {
	const bounds = await session.readOnLine((line) => captureContextBounds(session, line, conversationId, context, at));
	return deriveContext(storage, conversationId, bounds, context);
}

// deriveContext 是完整推导入口：给定边界，扫描范围并生成 ContextView；边界为 undefined 时返回空视图。
// 推导规则：H 是最新可见 head 标记；范围从 H.head（或转录开头）到 tail；每个目标取范围内最新编辑；上下文条目是 H 加范围中的非 head 条目。
/**
 * Derive the active transcript and model context of one conversation within captured bounds.
 *
 * H = newest visible head marker; the range runs from `H.head` (or transcript start) through the tail. Per target,
 * the newest edit in the range wins. Context entries are H followed by the range's non-head entries.
 */
// bounds 缺省通常表示空会话；此时没有条目可扫。
export async function deriveContext(
	storage: Storage,
	conversationId: ConversationId,
	bounds: ContextBounds | undefined,
	context: Context,
): Promise<ContextView> {
	if (bounds === undefined) return emptyView();
	// 完整扫描不假设范围是最新，因此 current 传 false。
	return deriveRange(bounds, await scanRange(storage, conversationId, rangeQuery(bounds), context), false).view;
}

// 空视图的四个字段都是空数组/undefined；它不是 null，调用方可以直接使用。
function emptyView(): ContextView {
	return { head: undefined, entries: [], contributions: [], messages: [] };
}

// rangeEntry 用二分查找在范围内按 ID 找条目；前提是 entries 已按 ID 升序，调用方保证。
// 返回 undefined 表示该条目不在这个范围内（可能已不可见或属于别的会话）。
/** Entry `id` of `range`, by binary search: a range holds its entries in ID order, every one visible from its conversation. */
export function rangeEntry(range: ContextRange, id: EntryId): EntryRecord | undefined {
	const entries = range.entries;
	let low = 0;
	let high = entries.length - 1;
	while (low <= high) {
		// >>> 1 是无符号右移一位，等价于 Math.floor((low + high) / 2)，但避免大数下的浮点问题。
		const middle = (low + high) >>> 1;
		const entry = entries[middle]!;
		if (entry.id === id) return entry;
		if (entry.id < id) low = middle + 1;
		else high = middle - 1;
	}
	return undefined;
}

// advanceRange 在不需要读存储的情况下把一次提交追加的条目并入范围：新条目一定是最新的，且新 head 标记不会指向范围起点之前。
// 返回 undefined 表示范围不再可用（旧 head 过期），调用方需要重新读取；非 current 的范围保持原样。
// 例：提交追加 2 条并写入新 head 标记，advanceRange 会重建窗口并置 current=true。
/**
 * `range` with the entries one commit appended to its conversation, in ID order, without reading Storage: the
 * conversation's own new entries are its newest, and a new head marker's head never lies before the range's start.
 * A range that is not `current` stays as it is; the next read extends it from Storage. `undefined` drops the range.
 */
export function advanceRange(range: ContextRange, appended: readonly EntryRecord[]): ContextRange | undefined {
	// 非 current 或没有新增条目：原样返回；非 current 的范围要等下一次完整读取。
	if (!range.current || appended.length === 0) return range;
	// 冻结调用方给的追加条目，因为它们会进入缓存。
	const added = freezeJson(appended);
	// head 初值沿用旧范围；循环找最后一个带 head 字段的新条目（head 标记只会出现在这种条目上）。
	let head = range.bounds.head;
	for (const entry of added) if (entry.head !== undefined) head = entry as typeof head;
	// 新边界 tail 是最后一条新增条目的 ID；.at(-1)! 的非空断言由前面的 length 检查保证。
	const bounds = { head, tail: added.at(-1)!.id };
	// head 标记 id 未变：同一基线，直接增量延展。
	if (head?.id === range.bounds.head?.id) return extendRange(range, bounds, added, true);
	// head 标记变了：从新 head 的 head 字段开始裁剪。
	const start = head!.head;
	// Heads only move forward: compaction keeps a later entry, a reset starts at itself, an older head is stale.
	// head 只能前移：若新起点早于旧 head 的起点，说明这是过期/乱序记录，丢弃整个范围。
	if (range.bounds.head !== undefined && start < range.bounds.head.head) return undefined;
	// 合并旧条目与新增条目，只保留 ID >= 新起点的部分；filter 不修改原数组。
	const entries = [...range.entries, ...added].filter((entry) => entry.id >= start);
	return deriveRange(bounds, entries, true);
}

// deriveRange 是范围推导的纯函数：从原始条目计算活动窗口、贡献、基线、消息和缓存字段。
/** Derive the context view from the entries scanned within `bounds`. */
function deriveRange(bounds: ContextBounds, entries: readonly EntryRecord[], current: boolean): ContextRange {
	// edits 只保留每个目标的最新编辑；Map.set 后写覆盖前写，遍历顺序是条目顺序（从旧到新）。
	const edits = new Map<EntryId, ContextEdit>();
	// Edits of every entry in the range count, including older head markers that `selectActive()` drops.
	// 注意：旧 head 标记之前的条目也可能带编辑，它们依然算数，因为编辑目标是可见条目。
	for (const entry of entries) for (const edit of entry.edits ?? []) edits.set(edit.target, edit);
	// 活动条目：有 head 标记时是“标记本身 + 范围内所有非 head 条目”；没有标记时是整个范围。
	const active = selectActive(bounds.head, entries);
	// 每个活动条目贡献的消息先应用编辑，再过滤被排除的停止原因；contribute 返回冻结数组。
	const contributions = active.map((entry) => contribute(entry, edits.get(entry.id)));
	// settle 把最后一个助手消息之前的消息固定下来，之后只需重排 open 部分的工具结果。
	const { settled, open } = settle([], contributions.flat());
	// 基线系统消息：在活动条目中找第一个 pi.system（或转录开头的系统消息）。
	const baseline = findBaseline(bounds.head, active);
	// 最终消息顺序：settled + 排序后的 open 工具结果，再把基线系统消息提到最前（若适用）。
	const messages = leadWithSystem([...settled, ...orderToolResults(open)], baseline);
	// view.entries 使用活动条目而不是全部范围条目；范围本身另存在 range.entries。
	const view = { head: bounds.head, entries: active, contributions, messages };
	// edited 用 Map 的键集合重建 Set；返回值的数组/集合都不与内部可变结构共享同一个引用（数组来自 map/Set 新建）。
	return { bounds, entries, view, edited: new Set(edits.keys()), settled, open, baseline, current };
}

// extendRange 是增量版本：同 head 下把新增条目接到 previous 后面，只推导新增贡献和新的 open 部分。
// 如果新增条目带编辑、带 head 标记，或编辑了旧条目，就必须完整重推导，因为旧贡献可能改变。
/**
 * `previous` extended by the entries `added` after its tail under the same head marker: only their contributions and
 * the open messages are derived. An added edit can change an earlier entry, so it derives the whole range again.
 */
function extendRange(
	previous: ContextRange,
	bounds: ContextBounds,
	added: readonly EntryRecord[],
	current: boolean,
): ContextRange {
	// 拼接旧条目与新增条目；新增条目已冻结。
	const entries = [...previous.entries, ...added];
	// 三个条件任一成立就回退到 deriveRange：新编辑、新 head 标记、或旧条目被新编辑目标命中。
	if (added.some((entry) => entry.edits !== undefined || entry.head !== undefined || previous.edited.has(entry.id))) {
		return deriveRange(bounds, entries, current);
	}
	// 普通新增条目没有编辑，贡献直接由 contribute(entry, undefined) 得到。
	const contributions = added.map((entry) => contribute(entry, undefined));
	// 把新增贡献并入 open，再 settle 一次；previous.settled 已经是稳定前缀。
	const { settled, open } = settle(previous.settled, [...previous.open, ...contributions.flat()]);
	// 基线如果已知（值或 null）就沿用；仍未知时才在新增条目里继续寻找。
	const baseline = previous.baseline !== undefined ? previous.baseline : findBaseline(bounds.head, added);
	// view.entries 仍是 previous 的活动条目加新增条目；新增的非 head 条目自然可见。
	const view = {
		head: bounds.head,
		entries: [...previous.view.entries, ...added],
		contributions: [...previous.view.contributions, ...contributions],
		messages: leadWithSystem([...settled, ...orderToolResults(open)], baseline),
	};
	// 返回延展后的范围，edited 集合不变；settled/open/baseline/current 更新。
	return { bounds, entries, view, edited: previous.edited, settled, open, baseline, current };
}

// findBaseline 决定本次上下文该用哪条系统提示词：head 标记之后第一个 pi.system 条目的系统消息，或没有 head 时的转录第一条。
// 返回 null 表示上下文开头已有系统消息（或编辑替换成了非系统消息），不应再插入基线；undefined 表示后续条目可能还会产生基线。
// 约束：基线只在 generation 写入完整段与工具集时产生；压缩后的保留历史里不再重复 pi.system。
/**
 * The baseline among `entries`, oldest first: the system message of the first `pi.system` entry after the head
 * marker, or of the transcript without one, when generation wrote it with every section and tool in effect. After a
 * head marker it always does, and omits the retained `pi.system` entries. Without one it does when it saw no system
 * message before, which holds unless an earlier entry carries one, even if an edit omits it later. An edit that targets
 * the baseline contributes other messages, or none, so none leads; a later entry does not take its place.
 */
function findBaseline(head: ContextBounds["head"], entries: readonly EntryRecord[]): Baseline {
	// 逐条检查活动条目；head 标记之前的条目被跳过（它们不在新上下文里）。
	for (const entry of entries) {
		if (head !== undefined && entry.id <= head.id) continue;
		// 第一个 pi.system 条目决定基线；entry.model 中找系统消息，找不到则为 null（该条目没有系统消息）。
		if (SystemEntry.is(entry)) return entry.model?.find((message) => message.role === "system") ?? null;
		// 没有 head 标记时，转录开头若已有系统消息（包括编辑替换出来的），也不再有基线。
		if (head === undefined && carriesSystemMessage(entry)) return null;
	}
	return undefined;
}

// carriesSystemMessage 检查条目自身消息或 replace 编辑的消息里是否含 system；omit 编辑不会产生系统消息。
/** Whether an entry's own messages, or the replacement messages of its edits, include a system message. */
function carriesSystemMessage(entry: EntryRecord): boolean {
	const isSystem = (message: Message) => message.role === "system";
	return (
		// 两个条件用 ?? false：model 缺省视为没有；edits 缺省同理；some 只在有值时调用。
		(entry.model?.some(isSystem) ?? false) ||
		(entry.edits?.some((edit) => edit.action === "replace" && edit.messages.some(isSystem)) ?? false)
	);
}

// leadWithSystem 在满足条件时把第一条系统消息移到最前：仅当它前面只有用户消息，或它本身就是基线。
// 原因：provider 只把“开头的系统消息”当作初始提示词和工具声明；若系统消息迟到，工具变更会重写请求工具列表并使整个提示词缓存失效。
// 只移动第一条系统消息，保持其余系统消息按提交顺序重放；助手消息之前的其他系统消息位置有语义，不能随意移动。
/**
 * Move the first system message to the front when only user messages precede it, or when it is the baseline's. A run's
 * input is committed before generation renders the system prompt, so a transcript starts with the input followed by
 * the baseline, and the range after a compaction with the kept history, assistant messages included. Providers treat
 * only a leading system message as the initial prompt and tool set; without it, a later tool change rewrites the
 * request's tool list and invalidates the whole prompt cache. Only the first system message moves, so replaying
 * system messages in order gives the same sections and tools. Any other system message, before an assistant message,
 * stays where it was committed: moving it would change what it means to the model.
 */
function leadWithSystem(messages: Message[], baseline: Baseline): Message[] {
	// findIndex 找第一条系统消息；index <= 0 表示没有或已经在最前，直接返回原数组。
	const index = messages.findIndex((message) => message.role === "system");
	// 非空断言：index 已由上一行排除 -1。
	if (index <= 0) return messages;
	const system = messages[index]!;
	// 不是基线且前面出现了非用户消息（通常是助手消息）：保留原位置，移动会改变对模型的含义。
	if (system !== baseline && messages.slice(0, index).some((message) => message.role !== "user")) {
		return messages;
	}
	// 新数组：[系统消息, 它之前的消息..., 它之后的消息...]；不修改入参数组的元素顺序。
	return [system, ...messages.slice(0, index), ...messages.slice(index + 1)];
}

// contribute 计算一个活动条目对模型上下文的贡献：先应用 omit/replace 编辑，再过滤被排除的助手停止原因。
// 返回冻结数组；工具结果排序由外层统一处理。
/** One active entry's model messages after its edit and excluded stop reasons, before tool result ordering. */
function contribute(entry: EntryRecord, edit: ContextEdit | undefined): readonly Message[] {
	// omit 编辑：条目完全不贡献消息，用同一个冻结空数组表示，便于共享。
	if (edit?.action === "omit") return Object.freeze([]);
	// replace 编辑用替换消息；没有编辑则用条目自身的 model（缺省为空）。
	const contributed = edit?.action === "replace" ? edit.messages : (entry.model ?? []);
	return Object.freeze(
		contributed.filter((message) => message.role !== "assistant" || !EXCLUDED_STOP_REASONS.has(message.stopReason)),
	);
}

// deeplyFrozen 记录本模块深冻结过的对象，避免 freezeJson 对共享子图重复遍历；WeakSet 不阻止对象被回收。
/** Objects `freezeJson()` froze with everything in them. `Object.isFrozen()` holds for shallow freezes too. */
const deeplyFrozen = new WeakSet<object>();

// freezeJson 递归冻结一个 JSON 值：先冻结子值再冻结自身，并登记到 deeplyFrozen。
// 它只处理 object（数组也走 Object.values 遍历下标）；原始值和 null 直接返回。
/** Freeze a JSON value and everything in it. */
function freezeJson<T>(value: T): T {
	// deeplyFrozen.has 让已经整体冻结过的子图直接跳过；这也是处理共享引用的环的必要检查（JSON 值理论上无环，但共享子树常见）。
	if (value === null || typeof value !== "object" || deeplyFrozen.has(value)) return value;
	// Object.values 对数组返回元素，对对象返回自有可枚举值；递归冻结所有子值。
	for (const child of Object.values(value)) freezeJson(child);
	Object.freeze(value);
	deeplyFrozen.add(value);
	return value;
}

// settle 把 open 中最后一个助手消息之前的部分排序并并入 settled：后续条目不能改变这些消息的顺序。
// 前提：orderToolResults(序列) 等于各段分别排序再拼接，只要后一段以助手消息开头。
/**
 * Move the ordered messages before the last assistant message of `open` to `settled`. `orderToolResults()` of a
 * sequence equals the concatenation over its parts when each later part starts with an assistant message.
 */
function settle(
	settled: readonly Message[],
	open: readonly Message[],
): { readonly settled: readonly Message[]; readonly open: readonly Message[] } {
	// findLastIndex 从后往前找助手消息；没有或第一项就是助手消息（index 0）时无需 settle。
	const last = open.findLastIndex((message) => message.role === "assistant");
	if (last <= 0) return { settled, open };
	// 前半段排序后接到 settled；open 从最后一个助手消息开始，保留其工具结果等待后续条目补充。
	return { settled: [...settled, ...orderToolResults(open.slice(0, last))], open: open.slice(last) };
}

// rangeQuery 把边界转成 EntryQuery：有 head 标记时从 head.head 开始，否则从转录开头到 tail。
/** The visible range of `bounds`: from the head marker's head, or transcript start, through the tail. */
function rangeQuery(bounds: ContextBounds): Omit<EntryQuery, "conversationId"> {
	const head = bounds.head;
	// 条件展开只加入存在的字段；Omit<EntryQuery, "conversationId"> 是编译期视图。
	return head === undefined ? { maxEntryId: bounds.tail } : { minEntryId: head.head, maxEntryId: bounds.tail };
}

// scanRange 分页读取范围内的可见条目，最后反转成从旧到新；cursor 为空表示没有下一页。
/** Visible entries within `range`, oldest first. */
async function scanRange(
	storage: Storage,
	conversationId: ConversationId,
	range: Omit<EntryQuery, "conversationId">,
	context: Context,
): Promise<EntryRecord[]> {
	// entries 按页收集；cursor 初始 undefined，让 storage 从第一页开始。
	const entries: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	// do/while 至少执行一次；每页最多 SCAN_PAGE_SIZE 条。
	do {
		// 展开 page.items 保持页内顺序；await 让出事件循环。
		const page = await storage.scanEntries({ conversationId, ...range }, SCAN_PAGE_SIZE, cursor, context);
		entries.push(...page.items);
		// 循环条件：next 为 undefined 表示读完；分页游标由存储决定，不在这里解析。
		cursor = page.next;
	} while (cursor !== undefined);
	// 存储按请求顺序返回（通常从新到旧），reverse 后统一为从旧到新；reverse 原地修改刚创建的数组。
	return entries.reverse();
}

// selectActive 构造活动条目：有 head 标记时把标记放在最前，再接范围内所有非 head 条目。
/** The head marker followed by the range's non-head entries, or the whole range without a marker. */
function selectActive(head: ContextBounds["head"], range: readonly EntryRecord[]): readonly EntryRecord[] {
	return head === undefined ? range : [head, ...range.filter((entry) => entry.head === undefined)];
}

// orderToolResults 把每个助手的工具结果按调用顺序紧跟在它后面：结果从“下一条助手消息之前”的消息里取。
// 缺失的结果会合成错误结果，没有对应调用的结果被丢弃；这保证 provider 看到的 toolCall/toolResult 成对且顺序合法。
// 例：assistant(call a,b) 后面是 [result b, result a] 会重排成 [a, b]；只有 result a 时为 b 合成 missing_result。
/**
 * Place each assistant's tool results directly after it in call order. Results are taken from the messages before
 * the next assistant; a missing result is synthesized and unmatched results are dropped.
 */
// ordered 是新数组；原 messages 不被修改。
export function orderToolResults(messages: readonly Message[]): Message[] {
	const ordered: Message[] = [];
	// 遍历每条消息；索引保留在原数组中，便于向前查找结果。
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		// 工具结果本身不直接 push，它们会在所属助手处按调用顺序补入；孤立结果因此被丢弃。
		if (message.role === "toolResult") continue;
		ordered.push(message);
		// 非助手消息原样保留；只有助手消息才可能触发结果重排。
		if (message.role !== "assistant") continue;
		// 类型谓词过滤：content is ToolCall 让 calls 的元素类型收窄为 ToolCall。
		const calls = message.content.filter((content): content is ToolCall => content.type === "toolCall");
		if (calls.length === 0) continue;
		// 没有工具调用的助手消息无需处理。
		const results = new Map<string, number>();
		// 向后收集结果，直到下一条助手消息；results 只记录每个 toolCallId 第一次出现的位置。
		for (let next = index + 1; next < messages.length && messages[next]!.role !== "assistant"; next++) {
			const candidate = messages[next]!;
			if (candidate.role === "toolResult" && !results.has(candidate.toolCallId)) {
				results.set(candidate.toolCallId, next);
				// 只接受未记录过的结果，避免重复 toolCallId 覆盖第一次；这里不检查调用是否存在，后面按 calls 取。
			}
		}
		for (const call of calls) {
			const resultIndex = results.get(call.id);
			// 按调用顺序 push；缺失时合成错误结果，时间戳沿用助手消息的时间。
			ordered.push(resultIndex === undefined ? missingResult(call, message.timestamp) : messages[resultIndex]!);
		}
	}
	return ordered;
}

// missingResult 构造一个冻结的错误工具结果；data 里的 reason 让 UI 知道这是推导出来的缺失结果，而不是工具真的返回。
function missingResult(call: ToolCall, timestamp: number): ToolResultMessage {
	return freezeJson({
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: MISSING_RESULT_TEXT }],
		isError: true,
		details: { reason: "missing_result" },
		timestamp,
	});
}
