// 文件导读
// 所属：packages/chord/test/examples/58-themes/plugins，单文件 web 插件。
// 作用：向 kit 的 Themes 注册表贡献第二个深色主题 Midnight。它只有基础颜色，没有 web 额外变量（如 --radius），
// 也没有 tui 覆盖，因此选它后页面的 --radius 不存在。
// 上游：文件名 `<name>.<kind>.ts` 决定插件身份——midnight.web.ts 是插件 midnight 的 web facet；
// 单文件插件没有 package.json，只能 import 应用 API（@board/app/v1）。
// 下游：src/index.ts 的 defineFacet 与 Themes（chord.themes）；58 的 main.ts 把本文件复制进 board 插件根。
// 能力清单：
// - 贡献一个 Theme：id "midnight"、name、mode "dark"、7 个基础角色颜色。
// 典型调用（示例）：
//   self.contribute(Themes, { id: "midnight", name: "Midnight", mode: "dark", colors: { … } });
// 阅读顺序：先看文件名与 import，再看 contribute 的 Theme 字段；对照 solarized/theme.ts 的 web/tui 扩展。
// 运行方式：不单独运行；由 board 的 server 构建并作为 web surface 脚本发布。
// 类型检查与运行时：colors 的 7 个角色在编译期必须齐全；贡献值没有运行时 schema 校验，
// 主题合法性由 ThemeChoice/activeTheme 的消费逻辑按 id/mode 使用。
//
// A second dark theme for pages, as a single-file plugin (it imports only the app's API).

// 单文件插件只允许 import 应用 API；defineFacet 声明 facet，Themes 是主题注册表。
import { defineFacet, Themes } from "@board/app/v1";

// _host 不使用；self.contribute 把主题值直接放进注册表（注册表的原始贡献值，不是 {value,version} 包装）。
// 插件名 midnight 排在 @board/solarized 之后，所以它不是第一个深色主题。
export default defineFacet((_host, self) =>
	self.contribute(Themes, {
		// id 是 ThemeChoice 里保存的稳定标识；name 是展示名。
		id: "midnight",
		name: "Midnight",
		// mode 决定它参与深色还是浅色选择。
		mode: "dark",
		// 基础角色必须齐全；web 额外变量（如 radius）与 tui 覆盖都可选，这里都不提供。
		colors: {
			accent: "#7aa2f7",
			bg: "#1a1b26",
			fg: "#c0caf5",
			muted: "#565f89",
			error: "#f7768e",
			warning: "#e0af68",
			success: "#9ece6a",
		},
	}),
);
