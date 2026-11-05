// 文件导读
// 所属：packages/chord/test/examples/50-plugin-imports/plugins/peek，peek 插件的 server facet。
// 作用：故意演示按种类文件的拒绝：server facet 经本插件的 view.ts 间接导入 notes 的 contract.web.ts，构建器沿导入链
// 报错（"a web file, imported into a server facet (...)"）。
// 上下游：example 50 的 discovery 找到同目录 package.json（@acme/peek）与 server.ts；build 失败；由于 plugins/ 是
// required 根，load 在宿主加载完成后以 PluginError 拒绝，error.failed 列出 peek。本 facet 从未被求值。
// 同目录 package.json 是清单（JSON 不能注释）：name = "@acme/peek" 是插件身份，private/type 与其他插件相同。
// 能力：默认导出的 Facet 仅用于展示错误路径；若构建成功，setup 会打印 notesPanel。
// 运行：node --conditions=source --experimental-strip-types test/examples/50-plugin-imports/main.ts
// 示例：import { notesPanel } from "./view.ts"; export default defineFacet(() => console.log(notesPanel));
// 阅读顺序：view.ts -> 本文件 -> main.ts 的加载报告。
// The peek plugin's server facet reaches a web file through its helper: refused at build, naming the chain.

// 插件只从应用 API 取构建器。
import { defineFacet } from "@acme/app/v3";
// 这里导入的是本插件的普通 helper，但 helper 又转出 web 种类文件；构建器会跟随链检查。
import { notesPanel } from "./view.ts";

// setup 不接收 host 参数，因为这里只演示构建拒绝；若构建通过，加载时这一行会打印 notesPanel。
export default defineFacet(() => console.log(notesPanel));
