// 文件导读
// 所属：packages/durable 的 test/examples 系列第 01 个示例，演示“文档（document）”与转录条目一起持久化。
// 演示内容：定义一份每个会话一份的 Notes 文档，在两次提交里分别写条目和文档值，然后用 snapshot() 读最新值、
//   用 snapshotAsOf() 读某个条目写入那一刻的文档值。全程只用 MemoryStorage，不访问网络或模型。
// 上游入口：从 packages/durable 目录直接运行；下游调用 defineDoc、Session.commit、Tx.appendEntry、Tx.doc、
//   Session.snapshot/snapshotAsOf。结果只打印到 stdout；异常直接让进程失败。
// 能力清单（按演示机制）：
// - defineDoc<T>(definition)：声明文档 token；运行时只校验 version 为正整数，其他字段由 TypeScript 约束。
// - scope/history/fork：决定每个会话一份、保留历史、以及 fork 时复制哪个时刻的值。
// - tx.doc(token, conversationId)：返回可修改的 Draft，首次使用会创建文档；提交结束时把修改保存为 ops。
// - Session.snapshot()：读取当前最新值；不存在时返回 undefined。
// - Session.snapshotAsOf()：只适用于 rewindable 文档，读取指定条目写入时的值。
// 典型运行顺序：定义 token → 创建会话 → 两次 commit（appendEntry + doc 赋值）→ 读最新/历史值 → close。
// 示例（真实运行命令）：
//   cd packages/durable
//   node --conditions=source --experimental-strip-types test/examples/01-documents.ts
// 预期输出：latest notes: { text: 'after goodbye' }；first entry 时为 'after hello'；second entry 时为 'after goodbye'。
// 阅读顺序：先看 defineDoc 的字段（尤其是 history/fork），再看第一次 commit 如何同时写条目和文档，最后比较两个读取 API。
// Store document state next to transcript entries.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/01-documents.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
// createSession、defineDoc、MemoryStorage 都从包根入口获得；defineDoc 只是声明，不创建文档。
import { createSession, defineDoc, MemoryStorage } from "../../src/index.ts";

// 共享上下文；BACKGROUND_CONTEXT 不含取消信号。
const context = BACKGROUND_CONTEXT;
// 本示例使用内存存储，所有记录随进程结束消失。
const session = createSession(new MemoryStorage());

// A document is a JSON object attached to something; here, one per conversation.
// "rewindable" keeps old values readable, so you can ask what the document
// looked like when a particular entry was written.
// `fork` says what a forked copy of the conversation starts with (see 02-forks.ts).
// 定义文档 token。泛型 <{ text: string }> 是 data 的编译期类型，运行时没有 schema 校验写入的字段。
// checkpointWhen 必填：返回 false 表示普通变更始终存增量，不额外存完整 base 检查点。
// scope: "conversation" 让每个会话有独立的一份文档；history: "rewindable" 保留可回看的历史。
// fork: "asOf" 表示从某个条目分叉时，新会话继承该条目时刻的文档值，而不是 initial。
const Notes = defineDoc<{ text: string }>({
	checkpointWhen: () => false,
	kind: "example.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf", // a fork starts with the value these notes had at the fork entry
	initial: () => ({ text: "" }),
});

// 创建一个 ownerless 会话；返回记录中的 id 用于后续所有文档/条目操作。
const chat = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);

// tx.doc() returns an editable copy of the document (created on first use).
// Plain assignments to it are saved when the commit finishes.
// commit 回调是 async：await 让 appendEntry 先写入条目，再获得同一事务的 Draft 并赋值。
// 回调返回 entry，因此外层 firstEntry 的类型是 EntryRecord，而不是 commit 内部的 Promise。
const firstEntry = await session.commit(async (tx) => {
	// appendEntry 返回带分配 ID 的条目记录；kind 是普通字符串，data 不进入模型上下文。
	const entry = await tx.appendEntry(chat.id, { kind: "note", data: "hello" });
	// await tx.doc(...) 拿到 Draft<{text:string}>；直接改 .text 会产生 delta op，提交结束时统一保存。
	(await tx.doc(Notes, chat.id)).text = "after hello";
	// 返回条目记录，让外层能拿到它的 id 供 snapshotAsOf 使用。
	return entry;
}, context);

// 第二次提交结构相同：条目和文档值在同一个原子提交里生效，不会出现“条目已写、文档没写”的中间状态。
const secondEntry = await session.commit(async (tx) => {
	const entry = await tx.appendEntry(chat.id, { kind: "note", data: "goodbye" });
	(await tx.doc(Notes, chat.id)).text = "after goodbye";
	return entry;
}, context);

// snapshot() reads the latest value. snapshotAsOf() reads the value that was
// saved in the same commit as the given entry.
// 三个读取都只读已提交状态，不会触发创建；值不存在时返回 undefined。
// snapshotAsOf 的第三个参数是 EntryId，编译期只接受 rewindable 文档 token。
console.log("latest notes:", await session.snapshot(Notes, chat.id, context));
console.log("notes at first entry:", await session.snapshotAsOf(Notes, chat.id, firstEntry.id, context));
console.log("notes at second entry:", await session.snapshotAsOf(Notes, chat.id, secondEntry.id, context));

// 关闭 Session；之前的提交已全部落库（内存后端即写入内存）。
await session.close(context);
