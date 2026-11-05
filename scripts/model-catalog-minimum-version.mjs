// 文件导读
// 所属：仓库根 scripts/ 的模型目录发布工具链，是发布器、兼容性检查和 CI 共用的一个常量模块。
// 作用：声明“从本仓库发布的模型目录至少需要哪个 pi 客户端版本才能接收”。pi.dev 按最低版本保存目录，
// 低于该值的客户端继续拿旧目录，不再收到更新。
// 上游读取方：publish-model-catalog.mjs（写入索引条目）、check-model-catalog-compat.mjs（与最新 release 比较）、
// .github/workflows/publish-model-catalog.yml（通过上述脚本间接使用）。注意：下方原有说明提到“pin 更新”，
// 但 update-model-catalog-pin.mjs 并不导入本常量，它从 pi.dev 发现最新 revision；两者只在发布流程层面相关。
// 下游：没有依赖；本文件无 I/O、无副作用、无退出码，导入即得到字符串常量。
// 能力清单：仅导出 MINIMUM_PI_VERSION（semver 字符串，当前 "1.2.1"）。
// 示例（真实导出，不是运行时分支）：
//   import { MINIMUM_PI_VERSION } from "./model-catalog-minimum-version.mjs";
//   console.log(MINIMUM_PI_VERSION); // "1.2.1"
// 组合方式：发布新目录时，索引里同一最低版本的旧条目会被新 revision 替换；提升本值等于另开一条目录线。
// 阅读顺序：先读下方常量的分发规则，再看 publish-model-catalog.mjs 的 buildIndex 如何使用它。
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
