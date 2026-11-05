// 压缩模块的统一出口：调用方可以从这个文件同时取得长会话压缩、分支摘要和共享工具。
// 这里没有启动压缩；export * 只把目标模块的导出继续公开。实际协调者是 AgentSession。
/**
 * Compaction and summarization utilities.
 */

// 公开离开会话树旧分支时收集历史、生成分支摘要的函数和类型。
export * from "./branch-summarization.ts";
// 公开 token 估算、保留边界选择、压缩准备以及模型摘要请求。
export * from "./compaction.ts";
// 公开两种摘要共用的文件操作记录、会话转文本和系统提示词。
export * from "./utils.ts";
