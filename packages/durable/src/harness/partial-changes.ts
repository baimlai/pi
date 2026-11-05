// What a streamed answer changed in its partial message between two partial commits, so a commit costs the new text.

// 所属：packages/durable/src/harness，Durable Harness 的流式响应增量提交模块（问题 #9265）。
// 解决的问题：Chord 把容器赋值记为一整个 set，并把“更长的字符串重新赋值”变成 O(长度) 的比较与发布；
// 若每次节流提交都重写不断增长的助手消息，代价随回答长度增长。本模块记录事件级的文本/参数增量，
// 让提交尽量只写新增片段。
// 职责边界：只维护内存中的观察缓冲并修改调用方给的 Chord 草稿；不提交事务、不持久化、不直接调用模型。
// 上游：generation.ts 的流式响应循环把 AssistantMessageEvent 交给 observe()，节流点调用 take()/commit()。
// 下游：json.ts 的 assignJson/AssignPlan（逐叶写入）、pi-ai 的 StreamingJsonParser（解析工具参数增量）、
// Chord delta 的 appendText（记录字符串追加）。
// 结果与错误：observe/take/commit/restore 都同步；commit 遇到计划与旧值不符时退回整体赋值；
// 提交失败由调用方 abort 草稿并调用 restore() 归还参数增量，异常本身向外传播。
// 能力清单：
// - PartialMessage：pi.live.generation.message 里保存的助手消息 JSON 表示。
// - PartialCommit：take() 的产物，含写入计划 plan 与每个工具调用的参数变化/快照。
// - PartialChanges：跟踪文本/思考增量与工具参数解析器，提供 observe/take/commit/restore。
// 组合与顺序：observe(每个流事件) → take(消息副本) 取出本批增量 → commit(草稿, 消息, 本批) 写入 pi.live →
// 成功则 adoption 由调用方完成；失败则 change.abort() + restore(本批)，下次提交重新应用。
// 示例：const changes = new PartialChanges();
//   changes.observe(event); // text_delta / toolcall_delta 等
//   const taken = changes.take(copyJson(partial)); // 清空文本缓冲并生成计划
//   const draft = tracker.beginChange();
//   changes.commit(draft.state.generation, copy, taken);
// 建议阅读顺序：先看 PartialMessage/PartialCommit 与 ToolCallState 的数据形状，再看 observe 的事件分支，
// 然后看 take 如何生成计划、commit 如何应用参数变化，最后看 restore 和 applyChange/value/isRecord 三个助手。
// 测试：test/harness-partial-changes.test.ts 用纯内存事件与 Chord 草稿验证最终参数、追加操作与失败重放。
// Chord delta：appendText 记录对象成员追加，Draft 是可写草稿的编译期类型。
import { appendText, type Draft } from "@earendil-works/chord/delta";
// JsonRepresentation<AssistantMessage> 把助手消息类型映射成纯 JSON 形状；JsonValue 是 JSON 联合类型。
import type { JsonRepresentation, JsonValue } from "@earendil-works/chord/json";
// AssistantMessageEvent 是流事件联合；ToolCall 用于取 arguments 的类型；AssistantMessage 是完整消息形状。
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
// StreamingJsonParser 增量解析工具参数字符串；JsonChange 是“哪个路径发生了什么”的判别联合。
import { type JsonChange, StreamingJsonParser } from "@earendil-works/pi-ai/utils/streaming-json";
// assignJson 按 AssignPlan 写入草稿；AssignPlan 是追加/保留/子字段三种写入计划。
import { type AssignPlan, assignJson } from "./json.ts";
// LiveState 描述 pi.live 文档；这里只取 generation.message 的类型。
import type { LiveState } from "./live.ts";

// 工具参数变化路径上可能出现的容器：对象或数组；只在类型层使用。
type JsonContainer = Record<string, JsonValue> | JsonValue[];

/** A partial message as `pi.live.generation.message` holds it. */
// 助手消息的可写 JSON 表示；泛型 JsonRepresentation 让字段在编译期仍是消息结构，而不是任意 JSON。
export type PartialMessage = JsonRepresentation<AssistantMessage>;

/** Committed arguments of a streamed tool call. */
// ToolCall["arguments"] 是模型给的参数记录；JsonRepresentation 去掉其中的非 JSON 类型（如 undefined）。
type Arguments = JsonRepresentation<ToolCall>["arguments"];

/** What one partial commit writes besides the partial message itself; from `PartialChanges.take()`. */
// take() 的返回：plan 描述消息主体怎么写（文本追加、参数交给 changes），toolCalls 描述每个被跟踪调用的参数增量。
// plan 中的 arguments 子计划为 keep，表示参数不由 assignJson 直接覆盖，而由 commit 按 changes 逐条应用。
export type PartialCommit = {
	/** The plan `assignJson()` writes the message with: text appends, and the arguments it leaves to `changes`. */
	readonly plan: AssignPlan;
	/** Each tracked tool call by content index: its argument changes since the last commit, in order, and its snapshot. */
	readonly toolCalls: ReadonlyMap<number, { readonly changes: readonly JsonChange[]; readonly snapshot: Arguments }>;
};

/** What a tracked tool call changed since the last commit, and whether any commit took its changes yet. */
// parser 增量解析参数文本；changes 是自上次 take 后累积的变化；committed 记录是否已有一批变化被提交过。
type ToolCallState = { readonly parser: StreamingJsonParser; changes: JsonChange[]; committed: boolean };

/**
 * Collects, from a response's events, what changed in its partial message since the last commit, so the commit appends
 * new text instead of reassigning growing strings. Reassigning makes Chord compare the old and new string, which costs
 * O(length) per commit.
 *
 * - Text and thinking: the `text_delta` and `thinking_delta` events. The commit appends them where the committed string
 *   plus the deltas has the new string's length, and compares otherwise. A block's `*_end` event drops them, because
 *   providers may replace the text when a block ends.
 * - Tool-call arguments: a `StreamingJsonParser` per call, fed with the raw argument text of each `toolcall_delta`,
 *   reports what each piece changed. The commit applies those changes to the committed arguments in order and leaves
 *   the arguments out of the message assignment, so the committed arguments are exactly the parsed text so far.
 *   `toolcall_end` ends the tracking; the call's last commit assigns its final arguments.
 */
// 跟踪一次助手响应中“自上次提交以来”的变化。构造无参数，内部只建两个 Map。
// 典型生命周期：创建 → 每个事件 observe → 节流点 take → commit（失败则 restore）→ 响应结束。
// 状态只在内存中；它不理解持久化或重试，调用方必须按失败路径归还已取走的变化。
export class PartialChanges {
	// 按 contentIndex 记录未提交的文本/思考增量；同一 index 连续同类 delta 会拼接。
	#text = new Map<number, { readonly field: "text" | "thinking"; text: string }>();
	// 按 contentIndex 跟踪工具调用参数的增量解析器；toolcall_end 时移除。
	readonly #toolCalls = new Map<number, ToolCallState>();

	/** Record what `event` changed. */
	// 输入一个流事件，无返回值；按 event.type 更新内存缓冲，不写草稿、不提交。
	// 例：连续两个 text_delta 会合并成一段待追加文本；toolcall_start 会为对应 index 新建解析器。
	// 未知事件类型（如 message 级事件）被 switch 忽略。
	observe(event: AssistantMessageEvent): void {
		// switch 对判别联合收窄：每个 case 里 event 的字段集合由 type 决定。
		switch (event.type) {
			case "text_delta":
			case "thinking_delta": {
				// 两个 case 共享逻辑，用 event.type 运行时再选出字段名。
				const field = event.type === "text_delta" ? "text" : "thinking";
				const pending = this.#text.get(event.contentIndex);
				// 同一块连续同字段增量追加到缓冲；字段切换（如块被替换）则重新开始，避免把旧文本算进追加。
				if (pending?.field === field) pending.text += event.delta;
				else this.#text.set(event.contentIndex, { field, text: event.delta });
				return;
			}
			case "toolcall_start":
				// 新工具调用的参数从空文档开始解析；committed:false 表示还没有任何一批变化被提交。
				this.#toolCalls.set(event.contentIndex, {
					parser: new StreamingJsonParser(),
					changes: [],
					committed: false,
				});
				return;
			case "toolcall_delta": {
				const call = this.#toolCalls.get(event.contentIndex);
				// 未在 start 时登记（例如插件插入了事件）就忽略，不尝试补建解析器。
				if (call === undefined) return;
				// append 返回本次片段新产生/修改的 JsonChange 列表，按发生顺序。
				for (const change of call.parser.append(event.delta)) {
					// Arguments are an object: any other root shows as no arguments, so the snapshot is committed instead.
					// 空 path 表示根值变化；若根不是对象（例如先出现字符串/数字），停止增量跟踪，
					// 让最终快照在 toolcall_end 后由下一次赋值处理。
					if (change.path.length === 0 && !isRecord(change.kind === "set" ? value(change) : null)) {
						this.#toolCalls.delete(event.contentIndex);
						return;
					}
					call.changes.push(change);
				}
				return;
			}
			case "text_end":
			case "thinking_end":
				// 块结束时丢弃文本增量：供应商可能在结束时改写整段文本，追加计划会与最终值不符。
				this.#text.delete(event.contentIndex);
				return;
			case "toolcall_end":
				// 参数解析结束；该调用最后一批 changes 仍留给下一次 take/commit，之后不再新增。
				this.#toolCalls.delete(event.contentIndex);
				return;
		}
	}

	/**
	 * Take what changed since the last call, for a commit of `message`, a copy of the partial. Clears the arguments of
	 * tracked tool calls in `message`: the commit writes them from the changes. Call `restore()` if the commit fails.
	 */
	// 输入本次要提交的消息副本（PartialMessage），输出 PartialCommit；副作用：清空文本缓冲、清空被跟踪调用的 changes。
	// 关键约定：会就地把 message 中工具块的 arguments 置为 {}，让 assignJson 保留它，随后由 commit 逐条应用增量。
	// 错误：不抛业务错误；调用方必须在提交失败时调用 restore() 归还 changes，否则下一批会丢失。
	// 例：一个工具调用已解析出 {"a":"x"} 时，plan 会让 arguments 走 keep，toolCalls 带该调用的 changes 与快照。
	take(message: PartialMessage): PartialCommit {
		// 每个 content 下标对应一个字段计划：文本用 append，工具参数用 keep。
		const blocks = new Map<string | number, AssignPlan>();
		for (const [index, { field, text }] of this.#text) {
			// append 计划只记录新增片段；assignJson 在长度吻合时用它，否则退回整体赋值。
			blocks.set(index, { kind: "fields", fields: new Map([[field, { kind: "append", text }]]) });
		}
		// 取走后清空，避免下一批重复追加同一段文本。
		this.#text = new Map();
		const toolCalls = new Map<number, { readonly changes: readonly JsonChange[]; readonly snapshot: Arguments }>();
		for (const [index, call] of this.#toolCalls) {
			const block = message.content[index];
			// A tracked call is the tool call its `toolcall_start` named; the narrowing only tells TypeScript.
			// 快照中的下标未必仍是工具块（内容可能被供应商改写），只有 toolCall 才有 arguments。
			if (block?.type !== "toolCall") continue;
			// snapshot 是供应商此刻看到的完整参数；changes 是本批增量，提交时先应用 changes。
			toolCalls.set(index, { changes: call.changes, snapshot: block.arguments });
			// 清空复制消息里的参数，配合 keep 计划，防止 assignJson 把完整参数再整体写一遍。
			block.arguments = {};
			blocks.set(index, { kind: "fields", fields: new Map([["arguments", { kind: "keep" }]]) });
			// 取走本批变化；若提交失败，restore() 会把它们放回 call.changes 前面。
			call.changes = [];
		}
		// 顶层计划固定从 generation.message 的 content 开始，逐块写入。
		return {
			plan: { kind: "fields", fields: new Map([["content", { kind: "fields", fields: blocks }]]) },
			toolCalls,
		};
	}

	/**
	 * Write `message` with what `commit` took into `generation.message`: the message leaf by leaf with the plan, then the
	 * argument changes. A tracked call whose block is new here gets its arguments from its changes, which then start at
	 * its first piece; when the committed message lost a call whose changes were already committed (another writer reset
	 * it), the call falls back to its snapshot from now on.
	 */
	// 输入 pi.live 的 generation 草稿、消息副本、take() 的产物；无返回值，直接修改草稿（尚未提交）。
	// 副作用：assignJson 写入消息主体；对每个已跟踪调用按其 changes 逐条修改参数。
	// 错误：不主动抛业务错误；草稿/事务失败由调用方回滚并 restore()。
	// 例：第二次提交只追加文本时，assignJson 走 append 计划；工具参数则从已提交对象上追加字符串片段。
	commit(
		generation: Draft<NonNullable<LiveState["generation"]>>,
		message: PartialMessage,
		commit: PartialCommit,
	): void {
		// 已提交消息的块数；用于判断某个被跟踪调用是否已经存在于目标草稿里。
		const committedBlocks = generation.message?.content.length ?? 0;
		// 待应用参数变化的调用列表，先收集再在 assignJson 之后执行。
		const apply: [number, readonly JsonChange[]][] = [];
		for (const [index, { changes, snapshot }] of commit.toolCalls) {
			const call = this.#toolCalls.get(index);
			// toolcall_end 后解析器已移除：本批变化不再跟踪，直接跳过（其最终值由后续整体赋值负责）。
			if (call === undefined) continue;
			const block = message.content[index];
			// 已提交消息没有这个块，但调用此前已有批次提交过：说明另一个写入者重置了消息，旧增量已丢失。
			if (index >= committedBlocks && call.committed && block?.type === "toolCall") {
				// The earlier changes are not in the committed message: commit the snapshot and stop tracking the call.
				// 用本批快照补回完整参数，并停止增量跟踪，避免在错误基础上继续追加。
				this.#toolCalls.delete(index);
				block.arguments = snapshot;
				continue;
			}
			// 标记该调用已有批次被提交；之后再次丢失消息时才能识别“旧增量已丢”的情况。
			call.committed = true;
			apply.push([index, changes]);
		}
		// 先按计划写消息主体；此时工具参数块被 keep 保留，还没有写入任何参数。
		assignJson(generation, "message", message, commit.plan);
		// 再读取刚写好的 content；它可能已被 Chord 合并进现有数组。
		const content = generation.message?.content ?? [];
		for (const [index, changes] of apply) {
			const block = content[index];
			// 再次确认块类型；与 take() 时的检查对应，防止内容序列在两次操作间变化。
			if (block?.type !== "toolCall") continue;
			// 按解析顺序应用增量；append 会尽量只记录新增字符串。
			for (const change of changes) applyChange(block, change);
		}
	}

	/** Put back what a failed commit took, so the next commit applies it first. */
	// 输入失败的 PartialCommit；把取走的参数变化放回各调用的 changes 前面，无返回值。
	// 文本变化不在这里恢复：take() 已清空文本缓冲，而下一批消息副本仍包含完整文本，
	// 下一次 take 会从“新文本 - 已提交文本”重新生成 append 计划（长度不吻合时退回整体赋值）。
	// 例：本批 changes [c2] 失败后，下一次提交先应用 [c2, 新变化...]。
	restore(commit: PartialCommit): void {
		for (const [index, { changes }] of commit.toolCalls) {
			const call = this.#toolCalls.get(index);
			// 只恢复仍在跟踪的调用；已结束或已放弃的调用不再接收增量。
			if (call !== undefined) call.changes = [...changes, ...call.changes];
		}
	}
}

/** Apply one argument change to the committed arguments of `block`. */
// 输入工具块草稿与一条 JsonChange；原地应用变化，无返回值。
// path 是解析器给的位置数组：空 path 表示根值，否则最后一段是成员/下标。
// 例：set path ["a"] value "x" 会写 block.arguments.a = "x"；append path ["content"] 则追加文本。
function applyChange(block: Draft<JsonRepresentation<ToolCall>>, change: JsonChange): void {
	const key = change.path.at(-1);
	if (key === undefined) {
		// Only an object root is tracked (`observe()` drops any other), and only `set` starts it.
		// 根变化只有在 set 且值是对象时才可写成参数对象；其他情况忽略（跟踪已停止）。
		const root = change.kind === "set" ? value(change) : undefined;
		if (isRecord(root)) block.arguments = root;
		return;
	}
	// The path follows the parsed argument text, not a type: each segment names a container `observe()` saw set.
	// 逐段取出父容器；路径来自解析器，正常输入保证中间节点存在，因此这里用 ! 表达该不变量。
	let parent = block.arguments as Draft<JsonContainer>;
	for (const segment of change.path.slice(0, -1)) {
		parent = (parent as Record<string | number, Draft<JsonContainer>>)[segment]!;
	}
	// 最后一段在父容器中的槽位；对象用字符串键，数组用数字下标。
	const slots = parent as Record<string | number, JsonValue>;
	if (change.kind === "set") slots[key] = value(change);
	// appendText() takes object members; a string in an array is reassigned, which compares it whole.
	// 数组中的字符串没有追加记录，只能整体重赋；对象成员则走 Chord 的追加记录。
	else if (Array.isArray(parent)) slots[key] = `${slots[key] as string}${change.text}`;
	// 对象成员走 Chord 的追加记录；String(key) 把数字下标也变成可传的字符串键。
	else appendText(parent as Draft<Record<string, string>>, String(key), change.text);
}

/** The value a `set` change reports: JSON data, which pi-ai types with read-only arrays. */
// 把 JsonChange 的 value 断成 JsonValue；只是类型桥接，不做运行时转换。
function value(change: Extract<JsonChange, { kind: "set" }>): JsonValue {
	return change.value as JsonValue;
}

// 类型谓词：判断 JSON 值是否为非数组对象；运行时检查 object/null/Array.isArray，成功后 TS 允许按字符串键访问。
function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
