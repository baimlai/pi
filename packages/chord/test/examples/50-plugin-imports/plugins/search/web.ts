// 文件导读
// 所属：packages/chord/test/examples/50-plugin-imports/plugins/search，search 插件的 web facet。
// 作用：导入 notes 的 web 种类契约文件（web facet 允许），并向应用 web API 的 Panels 注册表贡献一个标题。
// 上下游：example 50 的 build 会构建本 facet（browser 平台）；server 宿主不加载 web facet。main.ts 第 5 步打印
// copied，可看到 contract.web.ts 被复制进本 facet 的脚本。
// 能力：默认导出的 Facet；setup 中 self.contribute(Panels, { title: ... })。
// 运行：node --conditions=source --experimental-strip-types test/examples/50-plugin-imports/main.ts（只在构建阶段执行）。
// 示例：self.contribute(Panels, { title: `search ${notesPanel.title}` });
// 阅读顺序：notes/contract.web.ts -> 本文件。
// The search plugin's web facet: imports the notes plugin's web contract file, which web facets may.

// defineFacet 来自共享 API；Panels 只存在于 web 种类模块。
import { defineFacet } from "@acme/app/v3";
import { Panels } from "@acme/app/v3/web";
// 相对导入同根插件的 web 文件：构建器确认目标种类与本 facet 相同，因此允许。
import { notesPanel } from "../notes/contract.web.ts";

// defineFacet 的第二个参数 self 提供 contribute；_host 以单下划线表示这里不使用宿主。
// 注册表贡献只在插件加载期间存在；标题由模板字符串拼接。
export default defineFacet((_host, self) => self.contribute(Panels, { title: `search ${notesPanel.title}` }));
