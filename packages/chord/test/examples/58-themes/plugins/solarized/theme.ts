// 文件导读
// 所属：packages/chord/test/examples/58-themes/plugins/solarized，目录插件 @board/solarized 的共享主题数据。
// 作用：定义 Solarized Dark 一份 Theme 值，供同目录 web.ts 与 tui.ts 分别贡献给各自 kind 的 Themes 注册表；
// 避免在两个 facet 文件里重复颜色。它本身不是 facet，没有被发现器当作插件入口。
// 上游：同目录 package.json（name "@board/solarized"、private、type module）给出插件名与模块类型；
// 目录插件可以 import 自己的文件，因此 web.ts/tui.ts 能引用本文件（单文件插件不允许）。
// 下游：@board/app/v1 的 Theme 类型（仅类型导入）。
// 能力清单：
// - solarized：id/name/mode、7 个基础角色颜色、web.radius、tui.muted 覆盖。
// 典型用法（示例）：
//   import { solarized } from "./theme.ts";
//   self.contribute(Themes, solarized);
// 阅读顺序：先看 id/mode，再看 colors 的 7 个角色，最后看 web/tui 两个扩展字段。
// 运行方式：不单独运行；被 web.ts 与 tui.ts 在构建时打包。
// 类型检查与运行时：`Theme` 注解只在编译期检查字段与角色齐全；运行时贡献值不经过 schema，
// 使用方按 id/mode 读取，未知角色在 terminalColor 中回退为默认色。
//
// The Solarized theme's data, shared by its web and terminal facets: colours by role, a radius for the web, a
// 256-colour accent for terminals.

// 仅类型导入：Theme 在类型剥离后消失，本文件导出的是纯数据对象。
import type { Theme } from "@board/app/v1";

// 显式标注 Theme，让编译器检查 mode 字面量、颜色角色齐全与 web/tui 形状。
// 所有字段都是只读类型；运行时不冻结对象。
export const solarized: Theme = {
	// id 是 ThemeChoice 保存的稳定标识，也是 58 中等待 "solarized-dark" 的依据。
	id: "solarized-dark",
	// name 是展示名（示例输出使用它）。
	name: "Solarized Dark",
	// mode 决定它参与深色选择。
	mode: "dark",
	// 7 个基础角色必须齐全：accent/bg/fg/muted/error/warning/success。
	// 58 第 5 步会改写这个 accent 的十六进制值（改成 #d33682，RGB 211,54,130）。
	colors: {
		accent: "#b58900",
		bg: "#002b36",
		fg: "#839496",
		muted: "#586e75",
		error: "#dc322f",
		warning: "#cb4b16",
		success: "#859900",
	},
	// web 额外变量：键不带 `--`，themeVariables 会加上前缀（这里生成 --radius: 4px）。
	web: { radius: "4px" },
	// tui 覆盖：角色名 → 终端颜色。muted 用 xterm 256 调色板的索引 240，
	// terminalColor 优先取这个值，生成 38;5;240，而不是把 #586e75 映射到最近色。
	tui: { muted: "240" },
};
