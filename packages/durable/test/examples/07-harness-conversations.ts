// 文件导读
// 所属：packages/durable 的 test/examples 系列第 07 个示例，演示 Harness 的会话句柄、类型化条目、创建会话与分叉。
// 演示内容：打开 Harness 和根会话，把根会话的 thinkingLevel 设为 high；用 defineEntry 定义一个带 data 的条目种类并写入；
//   再创建一个显式 thinkingLevel:minimal 的新会话，以及一个在 hello 条目处分叉、继承父会话 high 的会话；最后按 ID 查回句柄。
// 上游入口：从 packages/durable 目录直接运行；下游调用 Harness.open/root/createConversation/conversation、
//   Conversation.configure/commit/fork、Tx.appendEntry、defineEntry。没有模型请求与网络。
// 能力清单（按演示机制）：
// - Conversation：无状态句柄，绑定 Harness；句柄之间按 id 比较，不要依赖对象身份。
// - defineEntry<D>(kind)：创建条目种类 token；运行时只校验 kind 是非空字符串，data 的 D 是编译期类型。
// - Entry.is(record)：类型谓词，按 kind 收窄；不校验 data 的运行时形状。
// - Conversation.commit(change, context)：绑定该会话的 Session 提交；回调里的 tx.createTask 默认归属该会话。
// - Tx.appendEntry(token, conversationId, draft)：token 提供 kind 并决定 data 类型；draft.model 是该条目的模型消息数组。
// - Harness.createConversation({ownership, agent?, init?}, context)：在创建提交内应用 agent、运行 init。
// - Conversation.fork(at, options, context)：在可见条目处分叉；AgentDoc 的 fork:"asOf" 让新会话继承该条目时刻的 agent。
// - Harness.conversation(id, context)：按 ID 取回句柄；不存在时返回 undefined。
// 典型运行顺序：Harness.open → root() → configure high → 定义 Message → root.commit 写入 hello → 打印类型化读取 →
//   createConversation(minimal) → root.fork(hello.id) → 解析两个会话的 thinkingLevel → 按 ID 查回 → close。
// 示例（真实运行命令）：
//   cd packages/durable
//   node --conditions=source --experimental-strip-types test/examples/07-harness-conversations.ts
// 实际输出：
//   typed entry: true example
//   helper thinking: minimal
//   fork thinking: high
//   lookup: true
// 阅读顺序：先看 defineEntry 与 appendEntry 的配对，再看 createConversation 的 agent 选项，随后看 fork 为什么继承 high，
//   最后看 conversation() 的 undefined 分支与可选链比较。
// Conversation handles, typed entries, created conversations, and forks.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/07-harness-conversations.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
// createRegistry() 包含内置任务；本示例不安装额外扩展。
import { createRegistry, defineEntry, Harness, MemoryStorage } from "../../src/index.ts";

// 不取消任何操作。
const context = BACKGROUND_CONTEXT;
// Harness.open 需要 models 与 registry；MemoryStorage 随 Harness 关闭而关闭。
const harness = await Harness.open(
	new MemoryStorage(),
	{ models: createModels(), registry: createRegistry() },
	context,
);
// 首次 root() 创建根会话（ID 1）。
const root = await harness.root(context);
// configure 单独提交一次，把根会话的思考级别设为 high；此时根会话的 AgentDoc 值为 { thinkingLevel: "high" }。
await root.configure({ thinkingLevel: "high" }, context);

// Conversation handles are stateless; compare them by id. They bind commits
// to their conversation. An entry token types an entry kind's `data`.
// Message 的 data 类型是 { from: string }；defineEntry 运行时只检查 "message" 非空，不校验 data。
// 之后通过这个 token 写入或读取时，TypeScript 才知道 data.from 存在。
const Message = defineEntry<{ from: string }>("message");
// root.commit 与 Session.commit 相同，只是 tx.createTask 默认归属 root；回调返回 appendEntry 的记录。
// model 数组给该条目附上模型上下文：[{role:"user",...}] 是 UserMessage，timestamp 是消息时间戳。
// 这里没有 Submit，也没有生成；条目只是转录内容。
const hello = await root.commit(
	(tx) =>
		tx.appendEntry(Message, root.id, {
			data: { from: "example" },
			model: [{ role: "user", content: "hello", timestamp: 1 }],
		}),
	context,
);
// Message.is(hello) 按 kind 收窄类型，返回 true；hello.data.from 能通过编译，是因为 token 的泛型 D 是 {from:string}。
// 注意：is() 不验证运行时 data 真的一定有这个字段。
console.log("typed entry:", Message.is(hello), hello.data.from);

// createConversation() and fork() apply `agent` and run `init` in the
// creating commit. A fork starts with the agent the parent had at the fork
// entry.
// createConversation 返回新的无状态句柄；agent 的 thinkingLevel:minimal 在创建提交里写入。
// 未给 init，因此没有额外的首条内容。
const helper = await harness.createConversation(
	{ ownership: { kind: "ownerless" }, agent: { thinkingLevel: "minimal" } },
	context,
);
// root.fork(at, options, context)：at 是可见条目 ID；新会话复制该条目及之前的转录。
// AgentDoc 使用 fork:"asOf"，所以 retry 的 agent 是 hello 提交时的值——此时 root 已被 configure 成 high。
const retry = await root.fork(hello.id, { ownership: { kind: "ownerless" } }, context);
// helper 有显式 minimal，覆盖继承的宿主默认值。
console.log("helper thinking:", (await helper.agent(context)).thinkingLevel);
// retry 没有显式 agent 变更，继承分叉点的 high。
console.log("fork thinking:", (await retry.agent(context)).thinkingLevel);
// conversation() 可能返回 undefined；?. 只在有值时访问 id，比较结果因此是 true，不会抛错。
console.log("lookup:", (await harness.conversation(retry.id, context))?.id === retry.id);

// 关闭 Harness 及其存储；所有句柄随之失效。
await harness.close(context);
