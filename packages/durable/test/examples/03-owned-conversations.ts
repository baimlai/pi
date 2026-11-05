// 文件导读
// 所属：packages/durable 的 test/examples 系列第 03 个示例，演示“任务拥有会话”的典型 agent 结构。
// 演示内容：定义后台 supervisor 任务、app 自己的 AgentRegistry 文档，并在一个原子提交里同时创建：
//   一个 background 顶层任务、该任务拥有的子会话、以及主会话里登记子会话的注册表。示例只创建记录，不运行任务。
// 上游入口：从 packages/durable 目录直接运行；下游调用 defineTask、Session.commit、Tx.createTask、
//   Tx.createConversation、Tx.doc、Session.snapshot。没有模型或网络访问。
// 能力清单（按演示机制）：
// - defineTask<I, S, R>：声明任务状态机；S 必须含 phase 字段，phases 必须覆盖 S 的每个 phase。
// - Tx.createTask(task, input, options)：创建任务记录；options.ownership 必填，background 让任务不参与普通空闲等待。
// - Tx.createConversation({ ownership: { kind: "task", taskId } })：创建归属于该任务的子会话。
// - defineDoc(... history: "latest", fork: "initial")：只保留最新值；分叉时从 initial 重新开始。
// - requestId：写入注册表的稳定名字，重复发送同一条首消息时可以据此去重（本示例只存名字，不实际发送）。
// 典型运行顺序：定义任务/文档 → 建主会话 → 一个 commit 建任务+子会话+注册表 → 打印快照 → close。
// 示例（真实运行命令）：
//   cd packages/durable
//   node --conditions=source --experimental-strip-types test/examples/03-owned-conversations.ts
// 预期输出：supervisor task: <id>；child conversation: { id, owner: { conversationId, taskId } }；
//   registry: { agents: { researcher: { conversationId, requestId } } }。
// 阅读顺序：先看 defineTask 的泛型与 phases，再看 defineDoc 的 history/fork，最后看 setup 提交里三者的依赖关系。
// A background task that owns a child conversation.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/03-owned-conversations.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
// ConversationId 是带品牌的数字 ID 类型；type 前缀表示它是纯类型导入，运行时会被擦除。
import { type ConversationId, createSession, defineDoc, defineTask, MemoryStorage } from "../../src/index.ts";

// 共享上下文，不设置取消信号。
const context = BACKGROUND_CONTEXT;
// 内存存储；示例结束后所有记录消失。
const session = createSession(new MemoryStorage());

// A typical agent setup: a background task supervises a helper conversation,
// and the main conversation keeps a registry that maps agent names to their
// conversations. All three are created in one commit, so after a crash either
// all of them exist or none do.
// 典型 agent 结构说明：主会话保存“名字 -> 子会话”的注册表；子会话由后台任务拥有；三者同一提交创建，保证原子性。

// A task definition needs a name, a version, the task's starting state, a
// handler for every phase, and an abort handler (11-tasks.ts runs a task).
// This example only creates the task record; a plain Session never runs it.
// 定义任务：输入 I=null，检查点 S={phase:"ready"}，结果 R=null。
// initial 返回第一个检查点；phases 是映射类型，S 的每个 phase 都必须有处理器，漏写会编译报错。
// abort 在任务被中止时运行；这里空实现，因为示例不运行任务。
const Supervisor = defineTask<null, { phase: "ready" }, null>({
	name: "example.supervisor",
	version: 1,
	initial: () => ({ phase: "ready" }),
	phases: { ready: async () => {} },
	abort: async () => {},
});

// "latest" keeps only the current value. "initial" means forks of this
// conversation start without a registry, so a child doesn't inherit its
// parent's list of agents.
// 定义会话级注册表文档；泛型描述 agents 是“字符串 -> { conversationId, requestId }”的记录。
// Record<string, ...> 是 TypeScript 内置工具类型，表示任意字符串键都映射到同一种值。
// history: "latest" 表示只保留当前值（不能 snapshotAsOf）；fork: "initial" 表示分叉以 initial 重新开始。
const AgentRegistry = defineDoc<{
	agents: Record<string, { conversationId: ConversationId; requestId: string }>;
}>({
	checkpointWhen: () => false,
	kind: "example.agent-registry",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {} }),
});

// 创建主会话；它的 id 用于把 supervisor 任务挂到该会话上。
const main = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);

// setup 提交同时写三类记录：任务、子会话、注册表；回调返回后它们一起生效。
const setup = await session.commit(async (tx) => {
	// `background: true` means the task is side work: waiting for the main
	// conversation to finish does not wait for it.
	// createTask 返回 TaskId；ownership: { kind: "conversation" } 表示任务归会话所有。
	// conversationId 显式指定归属会话（在未绑定会话的 Session 提交里是必填项）。
	// background 任务不参与普通空闲等待、会话级中止和级联清理。
	const supervisorId = await tx.createTask(Supervisor, null, {
		ownership: { kind: "conversation" },
		conversationId: main.id,
		background: true,
	});

	// The child records that it belongs to the supervisor task. The task was
	// created a few lines above in this same commit, which is allowed.
	// 子会话的 ownership 指向刚创建的任务；同一事务中先建任务再建会话是允许的。
	const child = await tx.createConversation({ ownership: { kind: "task", taskId: supervisorId } });

	// requestId is a fixed name for the child's first message. Later code sends
	// that message using this requestId, so a retry after a crash cannot
	// deliver it twice.
	// 登记 researcher 子会话；requestId 是应用约定的稳定字符串，示例只写入文档，不真正发送消息。
	// tx.doc 首次使用时会按 initial 创建文档，所以不需要先显式初始化。
	(await tx.doc(AgentRegistry, main.id)).agents.researcher = {
		conversationId: child.id,
		requestId: `researcher:first-message:${supervisorId}`,
	};
	// 返回两个新 ID，供后面打印；对象解构由调用方使用。
	return { supervisorId, child };
}, context);

// 以下输出只读取已提交状态；快照返回的对象不应被修改。
console.log("supervisor task:", setup.supervisorId);
console.log("child conversation:", setup.child);
console.log("registry:", await session.snapshot(AgentRegistry, main.id, context));

// 关闭 Session；如果 setup 提交失败，前面的记录都不会存在。
await session.close(context);
