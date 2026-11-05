/**
 * Session Management
 *
 * Control session persistence: in-memory, new file, continue, or open specific.
 *
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/sdk，SDK 示例系列第 11 个。上游由
 * `node examples/sdk/11-sessions.ts` 直接运行（需先构建工作区）；下游调用 SessionManager
 * 的四种入口选择历史持久化方式，再交给 createAgentSession。
 *
 * 演示什么：SessionManager.inMemory 完全不落盘；SessionManager.create 为新会话计算文件路径，
 * 但只有出现首条 user/assistant 消息时才真正创建 JSONL 文件；continueRecent 打开最近会话，
 * 没有则新建；list 扫描默认会话目录并按活跃时间排序，open 再按路径恢复指定会话。本例创建
 * 会话后不提问，因此新建的会话通常不会出现在 list 结果中（文件尚未写出）。脚本不发送模型
 * 请求；会读取会话目录，create 还会确保目录存在。
 *
 * 能力清单（按调用顺序）：
 * - SessionManager.inMemory()：无文件历史，sessionFile 为 undefined。
 * - SessionManager.create(cwd)：新持久化会话，计算默认目录与文件名。
 * - SessionManager.continueRecent(cwd)：恢复最近修改的有效会话，否则新建。
 * - SessionManager.list(cwd)：异步读取 SessionInfo[]（含 id、firstMessage、path）。
 * - SessionManager.open(path)：按路径加载已有会话。
 * - createAgentSession({ sessionManager })：用选定的历史管理器装配会话。
 *
 * 典型运行顺序与预期输出：
 *   1. 运行脚本；先打印内存会话为 `(none)`，再打印新会话计算出的文件路径。
 *   2. 恢复最近会话（若有）并打印路径；modelFallbackMessage 非空时打印 Note。
 *   3. 打印会话总数和前三条摘要；有会话时打开第一条并打印 sessionId。
 *   4. 每一步立即 dispose；没有 prompt，所以不会创建新对话文件。
 *
 * 示例（真实签名）：
 *   const sm = SessionManager.open("/path/to/session.jsonl");
 *   const { session } = await createAgentSession({ sessionManager: sm });
 *   该会话从文件恢复历史；文件损坏且非空时 open 会抛错，不会覆盖原文件。
 *
 * 建议阅读顺序：先看四种 SessionManager 工厂的区别，再看 list 的返回字段，最后看文件末尾
 * 注释里自定义会话目录的用法。
 */

// createAgentSession 装配；SessionManager 是历史管理器的类与静态工厂容器。
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

// In-memory (no persistence)
// 内存会话不创建目录/文件，sessionFile getter 返回 undefined；?? 只对 null/undefined 回退。
const { session: inMemory } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
});
console.log("In-memory session:", inMemory.sessionFile ?? "(none)");
inMemory.dispose();

// New persistent session
// create 会确保默认会话目录存在并计算文件名，但不会在此时写空文件。
const { session: newSession } = await createAgentSession({
	sessionManager: SessionManager.create(process.cwd()),
});
console.log("New session file:", newSession.sessionFile);
// 没有消息就 dispose，因此上面打印的路径可能对应一个尚不存在的文件。
newSession.dispose();

// Continue most recent session (or create new if none)
// continueRecent 读取默认目录中最新的有效会话；没有可恢复项时按新会话处理。
const { session: continued, modelFallbackMessage } = await createAgentSession({
	sessionManager: SessionManager.continueRecent(process.cwd()),
});
// 恢复的模型不可用而回退时会带说明；本字段只是提示，不是已弹出的 UI 警告。
if (modelFallbackMessage) console.log("Note:", modelFallbackMessage);
console.log("Continued session:", continued.sessionFile);
continued.dispose();

// List and open specific session
// list 只返回磁盘上已存在的会话文件；按活跃时间降序排列，普通读取失败会尽力返回空列表。
const sessions = await SessionManager.list(process.cwd());
console.log(`\nFound ${sessions.length} sessions:`);
// slice(0, 3) 取前三条展示；字符串 slice 截断 id 和首条消息，避免刷屏。
for (const info of sessions.slice(0, 3)) {
	console.log(`  ${info.id.slice(0, 8)}... - "${info.firstMessage.slice(0, 30)}..."`);
}

if (sessions.length > 0) {
	// open 读取并解析指定文件，恢复其历史、模型选择等；没有有效会话时跳过。
	const { session: opened } = await createAgentSession({
		sessionManager: SessionManager.open(sessions[0].path),
	});
	console.log(`\nOpened: ${opened.sessionId}`);
	opened.dispose();
}

// Custom session directory (no cwd encoding)
// 取消注释后，会话文件直接放在 customDir，不按 cwd 生成编码子目录；
// list/continueRecent 也必须传同一个目录，否则会去默认目录查找。
// const customDir = "/path/to/my-sessions";
// const { session } = await createAgentSession({
//   sessionManager: SessionManager.create(process.cwd(), customDir),
// });
// SessionManager.list(process.cwd(), customDir);
// SessionManager.continueRecent(process.cwd(), customDir);
