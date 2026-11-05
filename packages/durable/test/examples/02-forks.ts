// 文件导读
// 所属：packages/durable 的 test/examples 系列第 02 个示例，演示会话分叉（fork）与文档的 fork 语义。
// 演示内容：先在一个会话里写两条 note 和两次 Notes 文档值，然后在“第一条 note”处分叉；观察新会话只继承分叉点之前的
//   转录，并拿到分叉点时刻的文档值（fork: "asOf"）；最后修改分叉文档，确认父会话不受影响。
// 上游入口：从 packages/durable 目录直接运行；下游调用 Session.commit、Tx.forkConversation、Tx.scanEntries、
//   Session.snapshot。结果打印到 stdout，异常直接失败。
// 能力清单（按演示机制）：
// - Tx.forkConversation(parentId, at, options)：在某个可见条目处分叉，创建新的 ConversationRecord。
// - tx.scanEntries(query, limit)：按存储顺序分页读取条目，默认最新在前；items 是 EntryRecord 数组。
// - snapshot(Notes, branch.id)：读取分叉会话自己的文档副本。
// - fork: "asOf"：分叉文档以分叉条目写入时的值为起点；父会话之后的修改不会流入分叉。
// 典型运行顺序：定义 Notes → 建父会话 → 写 hello/goodbye → fork(firstEntry) → 读分叉转录/文档 → 改分叉文档 → 对比父子。
// 示例（真实运行命令）：
//   cd packages/durable
//   node --conditions=source --experimental-strip-types test/examples/02-forks.ts
// 预期输出：fork transcript: [ 'hello' ]；fork notes: { text: 'after hello' }；修改后分叉为 changed only in the fork，
//   父会话仍为 after goodbye。
// 阅读顺序：先看 Notes 的 fork 字段，再看 forkConversation 的三个参数，最后看分叉后独立编辑的对比输出。
// Fork a conversation.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/02-forks.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
// defineDoc 声明文档；本示例复用与 01 相同的 Notes 定义，重点是分叉（fork）行为。
import { createSession, defineDoc, MemoryStorage } from "../../src/index.ts";

// 共享操作上下文，不设置取消信号。
const context = BACKGROUND_CONTEXT;
// 内存存储：父会话与分叉都保存在同一进程内。
const session = createSession(new MemoryStorage());

// 与 01-documents.ts 相同的可回看文档定义；fork: "asOf" 决定分叉时复制哪个时刻的值。
const Notes = defineDoc<{ text: string }>({
	checkpointWhen: () => false,
	kind: "example.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ text: "" }),
});

// 创建父会话。
const chat = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
// 第一条 note 与文档值 "after hello" 在同一个提交里保存；它的 id 将作为分叉点。
const firstEntry = await session.commit(async (tx) => {
	const entry = await tx.appendEntry(chat.id, { kind: "note", data: "hello" });
	(await tx.doc(Notes, chat.id)).text = "after hello";
	return entry;
}, context);
// 第二条 note 与 "after goodbye" 写入父会话；它位于分叉点之后，分叉不会看到。
await session.commit(async (tx) => {
	await tx.appendEntry(chat.id, { kind: "note", data: "goodbye" });
	(await tx.doc(Notes, chat.id)).text = "after goodbye";
}, context);

// A fork is a new conversation that continues from one entry of another. It
// sees the parent's transcript up to that entry, and each document follows its
// own `fork` setting. Notes uses "asOf", so the fork starts with the notes
// value from the fork entry.
// forkConversation 返回新会话的 ConversationRecord；parentConversationId 与 at 都是必填参数。
// ownership 同样必填：这里让分叉成为 ownerless，而不是挂到某个任务下。
// 整个 fork 在一个原子提交里完成，分叉记录的创建和文档复制一起生效。
const branch = await session.commit(
	(tx) => tx.forkConversation(chat.id, firstEntry.id, { ownership: { kind: "ownerless" } }),
	context,
);

// scanEntries() pages through visible entries, newest first. The fork sees
// "hello" (inherited from the parent) but not "goodbye", which came later.
// query 里 conversationId 指向新会话；第二个参数 10 是分页大小，返回 Page<EntryRecord>。
// items.map 只取每条条目的 data 字段；分支的转录在编译期是 EntryRecord[]，data 类型为 JsonValue。
const branchEntries = await session.commit((tx) => tx.scanEntries({ conversationId: branch.id }, 10), context);
console.log(
	"fork transcript:",
	branchEntries.items.map((entry) => entry.data),
);
// snapshot 读取分叉会话自己的文档；asOf 语义让它是分叉点时刻的 "after hello"。
console.log("fork notes:", await session.snapshot(Notes, branch.id, context));

// The fork's copy is independent: editing it leaves the parent unchanged.
// 只改分叉会话的文档；父会话的文档值保存在另一份地址上，不会被这次提交影响。
await session.commit(async (tx) => {
	(await tx.doc(Notes, branch.id)).text = "changed only in the fork";
}, context);
console.log("fork notes after edit:", await session.snapshot(Notes, branch.id, context));
// 父会话仍读取自己的最新值 "after goodbye"。
console.log("parent notes after edit:", await session.snapshot(Notes, chat.id, context));

// 关闭 Session，结束本示例。
await session.close(context);
