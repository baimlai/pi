// 文件导读
// 所属：packages/chord/test/examples/50-plugin-imports/plugins/notes，notes 插件的 server facet（facet 入口）。
// 作用：服务共享契约 Notes，返回固定文本；演示同根共享契约被 facet 相对导入并在构建时复制。
// 上下游：discovery 读取同目录 package.json 的 name（插件身份 @acme/notes），把 server.ts 识别为 server 种类 facet；
// build 用 esbuild 打包它，load 求值 default export 并执行 setup；下游是宿主的 host.serve。运行期 search 插件通过
// self.get 获取同一个 Notes 对象。
// 同目录 package.json 是 JSON 清单，不能写注释：name = "@acme/notes" 是插件身份，private 防止误发布，
// type: "module" 让插件源码按 ES 模块解析；discovery 和 installDependencies 读取它。
// 能力：默认导出一个 Facet；setup 中 host.serve(Notes, factory)。
// 运行：node --conditions=source --experimental-strip-types test/examples/50-plugin-imports/main.ts
// 示例：export default defineFacet((host) => host.serve(Notes, () => ({ text: constant("…") })));
// 阅读顺序：contract.ts -> 本文件 -> search/server.ts。
// The notes plugin's server facet: serves `Notes`.

// constant 创建永不变化的值；defineFacet 只记录 setup，不在这里执行。
import { constant, defineFacet } from "@acme/app/v3";
// 同根相对导入：构建时把 contract.ts 复制进本脚本；运行时不从磁盘解析该路径。
import { Notes } from "./contract.ts";

// 默认导出是 facet 的入口约定：插件构建器取到它，宿主加载时调用 setup。
// setup 中 host.serve 注册契约与工厂；工厂没有参数，返回实现对象，text 是 constant 包装的 Watchable。
export default defineFacet((host) => host.serve(Notes, () => ({ text: constant("buy milk, call bob, ship it") })));
