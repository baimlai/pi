// 模型目录按客户端最低版本分发；此常量同时供发布器、兼容性检查与 pin 更新使用。
// The oldest pi version that receives model catalogs published from this checkout.
// pi.dev keeps one catalog per minimum version; clients older than this keep the
// last catalog published under the previous minimum and stop receiving updates.
//
// Bump this only when generated model metadata requires behavior unavailable in
// older pi clients, in the same commit as the change that requires it.
// 1.2.1: kimi-coding models use openai-completions at /coding/v1; older clients only
// implement anthropic-messages for kimi-coding and ignore a model's api.
// 导出目录接收方最低版本，不是当前仓库版本；例如 1.2.0 继续取旧最低版本下的目录，1.2.1 才能接收本目录。
// 只有生成元数据依赖新版运行逻辑时才连同那项改动提升本值；本文件不执行发布或迁移。
export const MINIMUM_PI_VERSION = "1.2.1";
