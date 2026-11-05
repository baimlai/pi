// 所属：packages/durable/src/harness，Durable harness 的会话收件箱层（内置文档 pi.inbox）。
// 解决的问题：会话忙时新提交不能立即追加，否则会插进正在进行的运行；steer/followUp/write 需要按模式在“工具轮结束”
// 或“回答结束”的边界统一落位，并且 reset/head 写入会改变活动范围。
// 职责边界：只定义队列形状与状态转换；准入决策在 submissions.ts，边界调用时机在 generation.ts，读写顺序由事务保证。
// 边界读取必须发生在事务的第一次表写入之前，否则 Session 会抛 ReadAfterWrite；本文件不负责这个顺序，调用方 prepareBoundary() 保证。
// 上游：Submissions 在忙时把输入或条目草稿写入队列；generation 在 postTools/final 调用 applyBoundary()。
// 下游：tx.appendEntry() 写条目、tx.placeSubmission()/settleSubmission() 结算提交；重置写入会让新上下文从该条目开始。
// 能力清单：
// - InboxItem/InboxState：排队项的判别联合与文档形状；
// - InboxDoc：conversation 作用域、latest 历史、fork initial 的文档定义；
// - QueueModes：从 Settings 取 steeringMode/followUpMode 的编译期视图；
// - Boundary/BoundaryResult：一次边界读到的快照和放置结果；
// - prepareBoundary：在事务第一次写之前读取 head 与队列；
// - applyBoundary：按模式选择并放置 steer/followUp/write，删除已放置项；
// - appendInput/pickInputEntry：把用户输入落成 pi.user 或自定义条目；
// - isDisplayOnly/hasQueuedReset/isStale：忙会话立即追加、重置检测与过期 head 判断；
// - removeInboxItem/withdrawQueuedInputs：删除单个排队项、撤销全部排队输入。
// 典型顺序：admit（忙时入队）→ prepareBoundary → 选择条目 → appendEntry → placeSubmission → 删除队列项 → 返回结果。
// 示例：const boundary = await prepareBoundary(tx, conversationId, runtime.settings);
//   const result = await applyBoundary(tx, boundary, "postTools", now); // result.users 是已落位的用户提交 ID
//   示例只展示调用顺序；实际选中项取决于队列模式与是否有 reset。
// 建议阅读顺序：先看 InboxItem/InboxDoc 理解队列内容，再读 prepareBoundary/applyBoundary，最后看 appendInput 与
//   isDisplayOnly/isStale/withdrawQueuedInputs 这些单点规则。
import type { Draft } from "@earendil-works/chord/delta";
import { copyJson, type JsonRepresentation } from "@earendil-works/chord/json";
import { defineDoc } from "../documents.ts";
import { UserEntry } from "../entries.ts";
import type { ConversationId, EntryDraft, EntryId, EntryRecord, JsonObject, SubmissionId, Tx } from "../types.ts";
import type { InputEntry, QueueMode, Settings, UserInput } from "./types.ts";

// InboxItem 是排队项的运行时可持久化形状；Submissions 在写入前已把用户输入转成 JsonRepresentation<UserInput>。
// 判别字段 mode 决定后续由边界放置成哪种条目：steer/followUp 是用户输入，write 是应用写入的条目草稿。
/** A queued submission: user input for a run, with the entry it is placed as when not `pi.user`, or an entry write. */
export type InboxItem =
	// steer 和 followUp 只在队列模式下不同：steer 优先插入当前运行，followUp 在回答后开始下一轮；条目本身都是一个用户消息。
	| {
			id: SubmissionId;
			mode: "steer" | "followUp";
			// content 是会被持久化的用户内容；JsonRepresentation 是严格 JSON 的编译期描述，不是运行时校验器。
			content: JsonRepresentation<UserInput>;
			// entry 可选：给出时用自定义条目种类（如应用自己的作者信息），不给则写 pi.user。
			entry?: JsonRepresentation<InputEntry>;
	  }
	/** `entry` is an `EntryDraft`, stored as plain JSON. */
	// write 分支只保存条目草稿；entry 的 JSON 形状由 EntryDraft 在编译期约束，文档层不再逐字段校验。
	| { id: SubmissionId; mode: "write"; entry: JsonObject };

// InboxState 是文档顶层对象；数组顺序就是提交 ID 顺序，边界按位置删除已放置项。
/** Built-in queue of one conversation's submissions waiting for a boundary, in ID order. */
export type InboxState = { items: InboxItem[] };

// InboxDoc 是会话级文档：history: "latest" 只保留最新值，fork: "initial" 让分支从空队列开始而不是复制父队列。
// checkpointWhen 在队列为空时返回 true，表示空闲状态可以作为完整检查点，避免为每次增删积累增量链。
// defineDoc 运行时只校验 version 为正整数；scope/history/fork 的组合由 TypeScript 重载约束，文档读写时还会核对记录语义。
export const InboxDoc = defineDoc<InboxState>({
	kind: "pi.inbox",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: [] }),
	checkpointWhen: (value) => value.items.length === 0,
});

// Pick<Settings, "steeringMode" | "followUpMode"> 只取两个字段；它是编译期结构约束，运行时对象可能还带其他字段。
/** The settings a boundary reads, on the Session line. */
export type QueueModes = Pick<Settings, "steeringMode" | "followUpMode">;

// Boundary 是“边界读到的快照”：inbox 是文档草稿，后续放置会直接修改它；head 是活动上下文的起点，放置 head 写入后会前移。
/** What a boundary reads before the commit's first table write, and the newest head it has seen so far. */
export type Boundary = {
	readonly conversationId: ConversationId;
	readonly inbox: Draft<InboxState>;
	readonly steeringMode: QueueMode;
	readonly followUpMode: QueueMode;
	// head 可变：本事务里先放置的 reset/head 写入会影响后续写入是否 stale，因此不能让 Boundary 成为只读快照。
	/** Start of the active range, the newest head marker's `head`; advanced by heads written in this commit. */
	head: EntryId | undefined;
};

// BoundaryResult 汇总这次边界放置了什么：users 是已落位的用户提交 ID，first 是第一个落位条目的 ID，reset 表示放了重置条目。
/**
 * Selected user items, in ID order, the first entry the boundary placed, a write's or a user item's (a run it starts
 * begins there, `LiveRun.first`), and whether a `head: "self"` write (a reset) was placed.
 */
// users 只记录 steer/followUp 两类（write 不算运行输入）；first 供 LiveRun.first 使用，表示运行从哪条记录开始。
export type BoundaryResult = {
	readonly users: SubmissionId[];
	readonly first: EntryId | undefined;
	readonly reset: boolean;
};

// prepareBoundary 必须在事务开始时调用：它读取最新 head 标记和 pi.inbox，都是表读；之后的 appendEntry/createTask 才是表写。
// 参数 modes 来自每次读取的 Settings；返回的 inbox 是可写的 Draft，边界放置会就地删除选中项。
// 例：await prepareBoundary(tx, conversationId, runtime.settings) 得到当前队列；它不放置任何项，也不改变状态。
/**
 * Read what a boundary needs. Table reads must precede the commit's first table write, so callers prepare the
 * boundary at the start of their commit.
 */
export async function prepareBoundary(tx: Tx, conversationId: ConversationId, modes: QueueModes): Promise<Boundary> {
	const head = (await tx.latestHeadMarker(conversationId))?.head;
	const inbox = await tx.doc(InboxDoc, conversationId);
	return {
		conversationId,
		inbox,
		steeringMode: modes.steeringMode,
		followUpMode: modes.followUpMode,
		head,
	};
}

// applyBoundary 是收件箱的核心状态转换：先决定本次边界要放哪些项，再按顺序 appendEntry、placeSubmission、从队列删除。
// at 为 postTools（工具轮结束）或 final（回答/失败结束）；reset 会把 postTools 提升为 final，因为新上下文要先清空队列。
// 选中但 stale 的 head 写入会被结算为 unanswered/stale；返回结果供调用方启动下一轮运行或结束运行。
// 例：队列 [steer A, write W, followUp B]，steeringMode "one-at-a-time" 在 postTools 只放 A 和 W，B 留到 final。
/**
 * Place the queued items a boundary selects (spec §6): every write, the first or all steers, and at `final` the first
 * or all follow-ups. A selected reset turns a `postTools` boundary into `final`. Writes are placed first and user
 * items after them, each in ID order, so user items queued before a reset run in the new context. A write whose head
 * targets an entry before the active range, including a range started earlier in this commit, is stale. Selected and
 * stale items are removed positionally.
 */
export async function applyBoundary(
	tx: Tx,
	boundary: Boundary,
	at: "postTools" | "final",
	now: number,
): Promise<BoundaryResult> {
	const { conversationId, inbox } = boundary;
	const items = inbox.items;
	const reset = hasQueuedReset(items);
	const final = at === "final" || reset;
	// pick 返回符合 mode 的队列下标；"all" 全选，"one-at-a-time" 只取第一个。返回的是下标而不是项，便于后面按位置删除。
	const pick = (mode: "steer" | "followUp", queueMode: QueueMode): number[] => {
		const indexes = items.flatMap((item, index) => (item.mode === mode ? [index] : []));
		return queueMode === "all" ? indexes : indexes.slice(0, 1);
	};
	// writes 收集所有 write 下标；它们不受 steering/followUp 模式影响，每个边界都会尝试放置。
	const writes = items.flatMap((item, index) => (item.mode === "write" ? [index] : []));
	// users 先合并 steer 与（final 时的）followUp 下标，再按数值升序，保证混合类型也按提交顺序放置。
	const users = [...pick("steer", boundary.steeringMode), ...(final ? pick("followUp", boundary.followUpMode) : [])];
	users.sort((a, b) => a - b);

	// appendEntry() 会复制草稿值；所有写入完成后才删除队列项，避免边遍历边改数组。
	// `appendEntry()` copies the drafts' values; the items are removed only afterwards.
	let first: EntryId | undefined;
	for (const index of writes) {
		// Extract<InboxItem, { mode: "write" }> 是联合类型收窄：只保留 write 分支；as Draft 告诉 TS 这是可写文档草稿。
		const item = items[index] as Draft<Extract<InboxItem, { mode: "write" }>>;
		// entry 在 JSON 文档里是普通对象；as unknown as EntryDraft 是跨类型断言，因为持久化形状已擦除了 TypeScript 的 EntryDraft 标记。
		const draft = item.entry as unknown as EntryDraft;
		// isStale 只检查数字 head 是否早于活动范围起点；head:"self" 和 head 缺省的写入不会 stale。
		if (isStale(boundary, draft)) {
			tx.settleSubmission(item.id, { status: "unanswered", reason: "stale" });
			continue;
		}
		// appendEntry 返回带 id 的正式记录；只有真正追加成功后才更新 boundary.head 和结算 submission。
		const entry = await tx.appendEntry(conversationId, draft);
		// draft.head === "self" 表示从新条目自身开始新上下文；普通数字 head 则把起点前移到该条目。
		if (draft.head !== undefined) boundary.head = draft.head === "self" ? entry.id : draft.head;
		// placeSubmission 把排队 submission 标为 placed 并关联条目；它不写条目内容，条目已由上一行追加。
		tx.placeSubmission(item.id, entry.id);
		// ??= 只在 first 仍为 undefined 时赋值；这保留“本次边界第一个落位条目”的语义。
		first ??= entry.id;
	}
	const placed: SubmissionId[] = [];
	for (const index of users) {
		const item = items[index] as Draft<Extract<InboxItem, { mode: "steer" | "followUp" }>>;
		// appendInput 负责把用户内容写成 pi.user 或调用方指定的条目；item.entry 缺省时写默认用户条目。
		const entry = await appendInput(tx, conversationId, item.content as UserInput, item.entry as InputEntry, now);
		// placeSubmission 与用户条目在同一事务里提交；placed 数组只用于返回给运行控制。
		tx.placeSubmission(item.id, entry.id);
		placed.push(item.id);
		first ??= entry.id;
	}
	// 删除从大到小进行：先删后面的下标不会让前面的下标失效。sort 的比较函数返回 b - a 即降序。
	const removed = [...writes, ...users].sort((a, b) => b - a);
	// splice 原地修改文档草稿 items，Chord 会把这次删除记录为文档增量。
	for (const index of removed) items.splice(index, 1);
	return { users: placed, first, reset };
}

// appendInput 决定用户输入落位后的条目种类：没有 entry 时用内置 UserEntry，否则用 entry 的 kind 与 data。
// 两种情况下 model 都是同一条 { role: "user", content, timestamp } 消息；函数只追加条目，不启动运行。
// 例：appendInput(tx, id, "hi", undefined, 123) 追加 pi.user，model 为 [{ role: "user", content: "hi", timestamp: 123 }]。
/** Append the entry an input is placed as: `entry`'s kind and data, or `pi.user`, with the user message of `content`. */
export function appendInput(
	tx: Tx,
	conversationId: ConversationId,
	content: UserInput,
	entry: InputEntry | undefined,
	now: number,
): Promise<EntryRecord> {
	// as const 让对象字面量的 role 保持字面量 "user"，从而匹配 pi-ai 的 UserMessage 联合类型。
	const message = { role: "user", content, timestamp: now } as const;
	// 两个分支都调用 tx.appendEntry；重载根据是否传 token 推断返回类型，UserEntry 分支的 data 类型为 never。
	if (entry === undefined) return tx.appendEntry(UserEntry, conversationId, { model: [message] });
	return tx.appendEntry(conversationId, { ...pickInputEntry(entry), model: [message] });
}

// pickInputEntry 只保留 kind 和 data，丢弃未在 InputEntry 类型中声明的字段；这是对“未类型化调用者”的运行时收敛。
// copyJson 会复制值并去掉 undefined 属性，得到严格 JSON；返回类型 JsonRepresentation<InputEntry> 只是编译期描述。
/** The kind and data of an input's entry as strict JSON, without other fields an untyped caller might pass. */
export function pickInputEntry({ kind, data }: InputEntry): JsonRepresentation<InputEntry> {
	const picked = data === undefined ? { kind } : { kind, data };
	return copyJson(picked, { omitUndefinedProperties: true }) as JsonRepresentation<InputEntry>;
}

// isDisplayOnly 判断写入是否只影响展示：没有 model/head/edits 就不会改变模型上下文，因此可以在忙会话中立即追加。
// 注意“present counts”：字段存在但为空数组也算影响上下文，不能当展示条目立即放置。
/**
 * Whether a write is display-only: it has no `model`, `head`, or `edits` (present counts, even if empty), so it changes
 * nothing the model sees and needs no boundary.
 */
export function isDisplayOnly(entry: EntryDraft): boolean {
	return entry.model === undefined && entry.head === undefined && entry.edits === undefined;
}

// hasQueuedReset 扫描所有排队项，寻找 mode 为 write 且 entry.head 恰好为 "self" 的重置写入。
/** Whether a reset (`head: "self"` write) is queued; entries appended before it leave the active range when it lands. */
export function hasQueuedReset(items: readonly InboxItem[]): boolean {
	return items.some((item) => item.mode === "write" && item.entry.head === "self");
}

// isStale 只针对数字 head：若该 head 早于活动范围起点，放置它会把已经被压缩或重置切掉的历史重新带回上下文。
// 缺省 head 的写入不改变范围；"self" 表示以新条目自身为起点，也不会 stale。
/** Whether a head write targets an entry before the active range, so placing it would bring back cut history. */
export function isStale(boundary: Boundary, entry: EntryDraft): boolean {
	return typeof entry.head === "number" && boundary.head !== undefined && entry.head < boundary.head;
}

// removeInboxItem 只从队列删除对应 id 的项，不结算 submission；调用方负责在事务里另行 settle。
// findIndex 找不到时返回 -1，此时什么也不做；splice 只删除一项。
/** Remove a withdrawn submission's item; the caller settles the submission. */
export async function removeInboxItem(tx: Tx, conversationId: ConversationId, id: SubmissionId): Promise<void> {
	const items = (await tx.doc(InboxDoc, conversationId)).items;
	const index = items.findIndex((item) => item.id === id);
	if (index >= 0) items.splice(index, 1);
}

// withdrawQueuedInputs 逆序遍历队列，删除 steer/followUp 并结算为 unanswered；write 项保留，等后续边界放置。
// reason 默认 "aborted"；取消运行、失败策略 withdraw 和关闭清理都复用这个函数。
/**
 * Withdraw every queued input of a conversation, as `Conversation.abort()` and abort cascades do: each settles
 * `unanswered` with `reason` (default `aborted`) and leaves the inbox; queued writes stay for later placement.
 */
export async function withdrawQueuedInputs(tx: Tx, conversationId: ConversationId, reason = "aborted"): Promise<void> {
	// items 是文档草稿中的数组；逆序 splice 避免索引移动导致漏删。i-- 在最后一项到 0 后停止。
	const items = (await tx.doc(InboxDoc, conversationId)).items;
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index]!;
		// 跳过 write 项：它们可能只是展示条目或等待边界的应用写入，撤销运行输入不应丢弃它们。
		if (item.mode === "write") continue;
		// settleSubmission 记录终态和原因；splice 把项移出队列，后续边界不会再看到它。
		tx.settleSubmission(item.id, { status: "unanswered", reason });
		items.splice(index, 1);
	}
}
