// 文件导读
// 所属：packages/durable 的内置日志条目种类（transcript entry kinds），供 harness/ 的提交、上下文与视图逻辑使用。
// 作用：用 defineEntry 给 EntryRecord.kind 建立类型化 token，并提供按 kind 收窄的 is() 守卫；token 本身不创建或提交条目。
// 职责边界：defineEntry 只在定义时校验 kind 是非空字符串；不校验 model/data 的内容，也不检查条目是否属于某个会话。
// 上游：harness/generation.ts 写 pi.assistant / pi.system / pi.reset；提交路径与 inbox 写 pi.user；
// harness/tool.ts 写 pi.tool-result；harness/compaction.ts 写 pi.compaction。
// 下游：harness/context.ts 与 view.ts 决定哪些条目进入模型上下文；transcript.ts 渲染给应用；Tx.entry(token, id) 读取。
// 能力清单：
// - defineEntry<D=never>(kind)：返回 Entry<D>；D 是 data 字段的开发时类型，默认 never 表示该种类不带 data。
// - UserEntry（pi.user）：用户输入，model 为 [UserMessage]，由提交逻辑写入。
// - AssistantEntry（pi.assistant）：模型响应（含失败/中止），model 为 [AssistantMessage]，由生成任务写入。
// - SystemEntry（pi.system）：位置性的系统提示/工具变更标记，model 为 content 为空的 [SystemMessage]。
// - ToolResultEntry（pi.tool-result）：工具结果，model 为 [ToolResultMessage]，data 为 { diagnostics }。
// - ResetEntry（pi.reset）：新一轮上下文的起点，head 总是 "self"；model 可有 handoff 用户消息。
// - CompactionEntry（pi.compaction）：压缩摘要，data 为 { reason }，head 是第一个保留条目。
// 组合与典型顺序：写入方 appendEntry(token, conversationId, draft) → 条目持久化 → 读取方 tx.entry(token, id) 或
// is() 收窄后使用 data；上下文逻辑从最新 head 标记往后读取 model 消息。
// 示例（真实 API 形状；消息对象需由 pi-ai 构造）：
//   await conversation.commit((tx) => tx.appendEntry(UserEntry, conversationId, { model: [userMessage] }), context);
//   const record = await conversation.commit((tx) => tx.entry(AssistantEntry, id), context);
//   if (record !== undefined) { /* record.model 是只读 Message 数组或 undefined */ }
// 阅读顺序：先看 defineEntry 与 types.ts 的 Entry/TypedEntry/EntryRecord，再读各内置 token 的英文说明。
import type { JsonValue } from "@earendil-works/chord/json";
import type { CompactionReason, ToolDiagnostic } from "./harness/types.ts";
import type { Entry, EntryRecord, TypedEntry } from "./types.ts";

// 用 kind 名称定义一种日志条目，并返回可用于类型缩小的 is 回调；不创建条目、不提交任何记录。
// D 描述 data 的开发时类型，默认 never 表示该种类不携带 data；没有运行时 schema 校验。
// 流程是拒绝空/非字符串名称，再闭包保存名称；例：defineEntry<{ text: string }>("app.note")。
// 后续 token.is(record) 仅比较 kind，不能证明 record.data 的内容真的符合 { text: string }。
// 定义一个条目种类 token。
// 输入：kind 是持久化的种类名（如 "pi.user"）；泛型 D 是 data 的开发时类型（默认 never）。
// 输出：Entry<D>，含成员 kind 与 is() 守卫；副作用：无；错误：kind 不是非空字符串时抛 TypeError。
// 主要流程：运行时只检查名称，然后用闭包捕获名称并返回 { kind, is }；不注册到任何表，也不持久化。
// 例子：const Note = defineEntry<{ text: string }>("app.note"); Note.is(record) 只证明 kind 相同，
// 不证明 record.data 真的满足 { text: string }；内容校验需要在写入边界自行完成。
/** Define a typed entry kind whose `is()` guard narrows by `EntryRecord.kind`. */
export function defineEntry<D extends JsonValue = never>(kind: string): Entry<D> {
	// 这是原有名称入口校验：TS 参数虽是 string，JS 调用仍可传错类型；不校验内容结构。
	if (typeof kind !== "string" || kind.length === 0) throw new TypeError("Entry kind must be a non-empty string");
	// 返回名称和谓词；每个 token 的谓词都捕获本次传入的 kind。
	return {
		// 字段简写把调用者名称保存下来，写条目时可用 token.kind。
		kind,
		// entry is TypedEntry<D> 是类型谓词：先排除 undefined，再按名称判断，不检查 model/data。
		is: (entry: EntryRecord | undefined): entry is TypedEntry<D> => entry !== undefined && entry.kind === kind,
	};
}

/** User input: `model` is `[UserMessage]`. Written by submissions. */
// 此处不传泛型，因此 D 为 never：条目约定只带 model，不带 data。
// 用户输入种类；此行只建立 token，真正的 UserMessage 由提交逻辑写入。
export const UserEntry = defineEntry("pi.user");
/** Provider result with any stop reason: `model` is `[AssistantMessage]`. Written by generation. */
// 模型响应种类，包括失败/中止响应；是否进入下一轮模型上下文由 context 逻辑决定。
export const AssistantEntry = defineEntry("pi.assistant");
/** Positional prompt and tool change: `model` is `[SystemMessage]` with empty `content`. */
// 系统提示段和工具变更的位置标记；token 自身不生成 SystemMessage。
export const SystemEntry = defineEntry("pi.system");
/**
 * Tool result: `model` is `[ToolResultMessage]`, whose content ends with the rendered diagnostics block; `data` holds
 * the structured diagnostics, possibly none. Written by tool tasks, and by generation for calls it did not offer.
 */
// 泛型要求 data 含诊断数组；这是 TS 约束，defineEntry 不逐项验证诊断。
export const ToolResultEntry = defineEntry<{ diagnostics: ToolDiagnostic[] }>("pi.tool-result");
/**
 * Start of a new context: always `head: "self"`, with `model` absent for a plain reset or `[UserMessage]` carrying the
 * handoff text. Written by `Conversation.reset()` and the `handoff` tool control.
 */
// 重置通过 head 改变后续上下文起点，不表示从存储删除旧条目。
export const ResetEntry = defineEntry("pi.reset");
/**
 * Compaction summary: `model` is `[UserMessage]` with the wrapped summary, `head` the first kept entry. Written by
 * compaction tasks, directly or through a write submission.
 */
// 摘要条目的 data 在开发时要求 reason；压缩任务负责实际生成消息与保留区间。
export const CompactionEntry = defineEntry<{ reason: CompactionReason }>("pi.compaction");
