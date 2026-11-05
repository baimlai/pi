// 文件导读
// 所属：packages/chord/test/examples/51-single-file-plugin/plugins，单文件插件 hello 的 web facet。
// 作用：与 hello.server.ts 使用同一个首名 hello，因此 discovery 把两个文件合并为插件 hello；本文件演示单文件插件
// 也能向注册表贡献。
// 上下游：example 51 的 server 宿主不加载 web facet，但 discovery 会列出它；第 2 步删除它并创建同名目录。
// 能力：默认导出的 Facet，setup 中 self.contribute(Panels, { title: "hello" })。
// 运行：node --conditions=source --experimental-strip-types test/examples/51-single-file-plugin/main.ts
// 示例：export default defineFacet((_host, self) => self.contribute(Panels, { title: "hello" }));
// 阅读顺序：hello.server.ts -> 本文件。
// The same plugin's web facet: a second file with the same first name.

import { defineFacet } from "@acme/app/v3";
// Panels 来自 web 种类模块；只有 web facet 能导入它。
import { Panels } from "@acme/app/v3/web";

// _host 表示 setup 不使用宿主；self.contribute 在插件加载期间贡献一个面板标题。
export default defineFacet((_host, self) => self.contribute(Panels, { title: "hello" }));
