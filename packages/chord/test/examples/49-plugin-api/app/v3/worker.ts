/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/49-plugin-api/app/v3/worker.ts，v3 API 的 worker kind 专属模块。
 * 演示什么：第三种 facet 种类可以有各自的 API。worker 里运行的索引器向 Indexers 注册表贡献名字，
 * 由 worker 侧 facet 的 compose 合成数组（用于示例 52）。
 * 上游/下游：本组的示例 49 不加载 worker；示例 52 把 "@acme/app/v3/worker" 列为 worker kind 的宿主包。
 * 能力清单：Indexers 注册表 token（贡献 { readonly name: string }，读值 readonly string[]）。
 * 典型运行顺序：worker facet 构建 -> worker 求值注入本模块 -> 插件贡献名字 -> 测试辅助 facet 收集。
 * 示例（真实签名）：defineRegistry<{ readonly name: string }, readonly string[]>("acme.indexers", { version: 1 })
 * 建议阅读顺序：先读类型参数，再看示例 52 如何 serve/contribute 该注册表。
 * 前置条件：仅作为宿主包被 import；单独执行不产生输出。
 */
// Acme's API v3 for worker facets only (`@acme/app/v3/worker`): a registry of the workers' indexers (example 52).

// 创建 token 所需的 defineRegistry 来自 Chord 源码；本文件属于学习示例，路径是相对 app/v3/ 的五层上跳。
import { defineRegistry } from "../../../../../src/index.ts";

// C = { readonly name: string }：worker 贡献自己的名字；V = readonly string[]：合成后是名字列表。
// 注册表名 acme.indexers 与契约版本 1 一起构成跨 bundle 的识别信息。
/** Word indexers a worker runs over a project's notes: each contributes its name. */
export const Indexers = defineRegistry<{ readonly name: string }, readonly string[]>("acme.indexers", { version: 1 });
