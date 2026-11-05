// 文件导读
// 所属：packages/chord/test/examples/58-themes/plugins/solarized，目录插件 @board/solarized 的 tui facet。
// 作用：把同一份 Solarized Dark 贡献给终端 surface 的主题注册表。终端运行时（../56-web/tui/main.ts）
// 自动跟随主题，并用 TerminalTheme 按角色取色；没有本文件，终端里就没有可选主题。
// 上游：同目录 package.json（插件名 @board/solarized）与文件名 tui.ts（facet 种类）；./theme.ts 的共享数据。
// 下游：@board/app/v1 的 defineFacet 与 Themes。
// 能力清单：
// - 默认导出一个 facet：self.contribute(Themes, solarized)（与 web.ts 的值相同，但贡献到不同 kind 的注册表）。
// 典型用法（示例）：
//   // 终端构建加载本文件后，activeTheme 在 tui 侧得到 solarized-dark
// 阅读顺序：与 web.ts 对照，理解“同一主题、两个 surface 各贡献一次”。
// 运行方式：不单独运行；由终端 base bundle 的插件构建加载。
// 说明：single-file 插件 midnight.web.ts 只有 web kind，因此终端侧没有 Midnight；58 在启动终端前已选回
// solarized-dark，终端只使用 Solarized 的颜色。
//
// The Solarized theme in terminals.

// 与 web.ts 相同的两个导入；kind 由文件名决定，而不是 import 的内容。
import { defineFacet, Themes } from "@board/app/v1";
// 共享数据：colors、web.radius、tui.muted 都在这里，TerminalTheme 会优先使用 tui 覆盖。
import { solarized } from "./theme.ts";

// 终端侧贡献：注册表按插件名排序，所以终端里第一个深色主题同样是 solarized-dark。
export default defineFacet((_host, self) => self.contribute(Themes, solarized));
