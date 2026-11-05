// 文件导读
// 所属：packages/durable（@earendil-works/pi-durable）的 test/examples 系列第 00 个示例，是最小可运行的 Session 入门。
// 演示内容：创建一个内存 Session，在一次原子提交里新建 conversation，然后关闭 Session。没有模型、网络、工具或文件写入。
// 上游入口：在 packages/durable 目录用 Node 的 strip-types 直接运行本文件；下游调用 src/session 的 createSession、
//   src/storage/memory 的 MemoryStorage，以及 chord 的 Context/BACKGROUND_CONTEXT。
// 输出与失败：stdout 只打印新会话记录；存储/提交/关闭异常会让顶层 await 拒绝，进程以非零码失败（没有 try/finally）。
// 能力清单（按演示机制）：
// - MemoryStorage：所有会话、条目、任务、文档都保存在进程内存，进程结束即丢失。
// - createSession(storage)：打开低层 Session；包含提交、文档读写、watch 等能力，但不调度任务。
// - Session.commit(change, context)：在一次原子事务里执行回调；回调抛错则整次提交不生效。
// - Tx.createConversation({ ownership })：在事务里创建会话；ownership 必须显式给出。
// - Session.close(context)：先封闭新提交，再结算并关闭存储。
// 典型运行顺序：createSession → commit(创建 conversation) → console.log → close。示例可以直接照抄这四步。
// 示例（真实运行命令，不是代码片段）：
//   cd packages/durable
//   node --conditions=source --experimental-strip-types test/examples/00-conversation.ts
// 预期输出类似：standalone conversation: { id: 2 }（ID 由存储分配，实际值可能因版本不同而变化）。
// 阅读顺序：先看文件头的运行命令，再看 createSession/context 两个准备变量，最后看 commit 回调里的所有权字段。
// A Session stores conversations, transcript entries, tasks, and documents.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/00-conversation.ts
// 从 chord/context 取 BACKGROUND_CONTEXT 常量；上下文携带取消信号和遥测信息，"background" 表示永不取消。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
// 从包根入口导入低层 Session 工厂与内存存储；".ts" 后缀是 Node strip-types 直接运行源码所需的写法。
import { createSession, MemoryStorage } from "../../src/index.ts";

// MemoryStorage keeps everything in memory; other storage backends keep it on disk.
// 构造一个内存后端实例并交给 createSession；`new` 创建类实例，createSession 返回的 Session 持有它并负责关闭。
const session = createSession(new MemoryStorage());

// Every Session call takes a context, which is used for cancellation.
// BACKGROUND_CONTEXT means "never cancel".
// 共享同一个上下文对象给后续提交/关闭；它不设置中止信号，所以这些操作不会被本示例取消。
const context = BACKGROUND_CONTEXT;

// All writes happen inside session.commit(). The callback receives a
// transaction `tx`; everything it writes is saved together when the callback
// returns, or discarded if it throws.
// "ownerless" means no task created this conversation.
// commit 的泛型 T 由回调返回值推断，这里 T 是 ConversationRecord；回调可以是 async，错误会拒绝整个 Promise。
// 箭头函数参数 tx 的类型由 commit 的签名推断为 Tx，不需要手写类型注解。
// 所有权对象是带 kind 判别字段的联合：ownerless 表示由应用创建，不属于任何任务树。
const standalone = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
// 打印 createConversation 返回的不可变记录；此时提交已经完成，记录对外可见。
console.log("standalone conversation:", standalone);

// 关闭 Session：等待已准入工作结算并关闭存储；close 之后继续使用时操作会拒绝。
await session.close(context);
