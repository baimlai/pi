/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/49-plugin-api/app/v2.ts，应用仍提供的旧版 API 模块。
 * 演示什么：版本化 API 的兼容层。v2 只是对 v3 的 re-export，但保留旧名字：注册表在 v3 叫 Greetings，
 * 在 v2 叫 Hellos。插件按 @acme/app/v2 写代码也能构建和运行，不需要改源码。
 * 上游/下游：main.ts 把本模块实例作为 "@acme/app/v2" 宿主包；plugins/legacy/server.ts 从它导入。
 * 能力清单：constant、defineFacet、Hellos（即 Greetings 的别名）、local、str。
 * 典型运行顺序：构建时按 api.versions 允许 v2 导入 -> 求值时宿主注入本模块实例 -> 插件用 Hellos 贡献。
 * 示例（真实签名）：export { Greetings as Hellos } from "./v3.ts";
 * 建议阅读顺序：先看导出的别名，再对照 legacy/server.ts 的 import。
 * 前置条件：仅作为宿主包被 import；单独执行本文件不产生输出。
 */
// Acme's API, version 2 (`@acme/app/v2`): still provided, as a thin layer over v3. Version 2 called the greetings
// registry `Hellos`; the layer keeps that name, so plugins written against v2 build and run unchanged.

// 纯 re-export：不在这里创建新对象，运行时得到的就是 v3.ts 的同一批导出。
// `Greetings as Hellos` 同时改值层名字和类型层名字；旧插件写 Hellos，宿主看到的仍是名为 acme.greetings 的注册表。
// 注意 API_VERSION 等 v3 新增导出没有转发，v2 的公开面刻意保持在旧集合内。
export { constant, defineFacet, Greetings as Hellos, local, str } from "./v3.ts";
