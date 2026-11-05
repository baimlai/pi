// 文件导读
// 所属：packages/chord/test/examples/58-themes/plugins/solarized，目录插件 @board/solarized 的 web facet。
// 作用：把 theme.ts 的 Solarized Dark 贡献给 web surface 的主题注册表；页面构建加载本文件，
// 终端构建不加载它。58 的热更新同时重建 web 与 tui 两个 facet，因为它们属于同一个插件。
// 上游：同目录 package.json 给出插件名 @board/solarized；文件名 web.ts 指定 facet 种类；
// ./theme.ts 提供共享数据。
// 下游：@board/app/v1 的 defineFacet 与 Themes（chord.themes 注册表）。
// 能力清单：
// - 默认导出一个 facet：self.contribute(Themes, solarized)。
// 典型用法（示例）：
//   // 插件加载后，Themes 注册表多出 id "solarized-dark" 的深色主题
// 阅读顺序：先看 import，再看一行 contribute；主题字段在 theme.ts。
// 运行方式：不单独运行；由 board 的 web 构建打包，页面客户端加载后完成贡献。
// 类型检查与运行时：solarized 的 Theme 类型在编译期检查；注册表合并只在运行时收集贡献值，不校验颜色格式。
//
// The Solarized theme on pages.

// defineFacet 声明 facet；Themes 是主题注册表 token。
import { defineFacet, Themes } from "@board/app/v1";
// 共享的主题数据；目录插件允许 import 自己的文件。
import { solarized } from "./theme.ts";

// 不使用 host；self.contribute 把整个 Theme 作为原始贡献值放入注册表。
// 插件名与 kind 决定排序和加载范围：@board/solarized 排在 midnight 之前。
export default defineFacet((_host, self) => self.contribute(Themes, solarized));
