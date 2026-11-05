// 文件导读
// 所属包与目录：packages/chord/test/examples/36-plugin-failures/plugins/prices/contract.ts，@example/prices 的契约文件，
// 同时被 summary 插件复制导入。
// 演示什么：契约版本。main.ts 把副本里的版本字段升到 2；summary 的构建内联本文件副本，因此也会要求 v2。
// 上游入口：prices/server.ts 与 summary/server.ts 的 import；buildFacet 把跨插件文件复制进各自脚本并列在 copied。
// 下游依赖：@earendil-works/chord 的 int/local；上一级 package.json 的 name 是插件身份。
// 能力清单：Price 契约（local、空 params、成员 cents: int）。
// 示例（真实签名）：const Price = local("example.price", { version: <n>, params: {}, members: { cents: int() } });
// 典型运行：第 2 幕版本升到 2 且 prices facet 构建失败，summary 因闭包规则保留旧代码；第 3 幕 prices 修复并返回 300，
// summary 读到 "price v2: 300 cents"。
// 注意：members 里的 int() 是 schema 描述而不是初值；示例读取路径不会按 schema 逐次校验状态值。
// 建议阅读顺序：导入 -> Price 契约。
// The prices plugin's contract; the summary plugin imports (copies) it. The example moves it to version 2.

// int 声明整数成员 schema；local 声明仅本主机可见的契约。
import { int, local } from "@earendil-works/chord";

/** A price in cents. */
// 只声明本主机价格契约，金额单位为分；summary 打包此文件副本，版本更改会让旧/新消费者绑定规则不同。
// members 的 int 是 schema 而非初值；状态由 provider 返回，不会逐次在读取时校验。
// 契约令牌按名称、版本和指纹绑定；应用侧即使另建同名声明的对象，也能与插件里的这份匹配。
export const Price = local("example.price", { version: 1, params: {}, members: { cents: int() } });
