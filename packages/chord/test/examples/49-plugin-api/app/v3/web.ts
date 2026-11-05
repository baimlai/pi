/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/49-plugin-api/app/v3/web.ts，v3 API 的 web kind 专属模块。
 * 演示什么：web facet 的 API 可以包含仅页面存在的契约。Panels 是注册表：每个贡献者提交 { title }，
 * 页面侧 facet 的 compose 把它们合成标题数组。
 * 上游/下游：main.ts 以 "@acme/app/v3/web" 提供给 web kind；plugins/panel/web.ts 导入并贡献；
 * 示例 52 的 worker 不使用该模块。
 * 能力清单：Panels 注册表 token（贡献类型 { readonly title: string }，读值 readonly string[]）。
 * 典型运行顺序：web facet 构建 -> 页面求值注入本模块 -> 插件贡献 { title } -> 页面 facet compose。
 * 示例（真实签名）：defineRegistry<{ readonly title: string }, readonly string[]>("acme.panels", { version: 1 })
 * 建议阅读顺序：先看类型参数，再对照 panel/web.ts 的 contribute 与 main.ts 的 compose。
 * 前置条件：仅作为宿主包被 import；单独执行不产生输出。
 */
// Acme's API v3 for web facets only (`@acme/app/v3/web`): the panels a page shows.

// 同 v3.ts：本模块内部需要 defineRegistry 来创建 token。
// 路径多一级 ../，因为文件位于 app/v3/ 子目录，需要五层 .. 才回到 packages/chord/src。
import { defineRegistry } from "../../../../../src/index.ts";

// C = { readonly title: string }：贡献者必须提交带 title 的对象。V = readonly string[]：页面读到的合成值。
// 名字 acme.panels 必须全局唯一；version: 1 表示贡献者按第 1 版契约编写。
/** A panel's title, one per contributing plugin. */
export const Panels = defineRegistry<{ readonly title: string }, readonly string[]>("acme.panels", { version: 1 });
