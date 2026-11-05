/// <reference lib="dom" />
// The page's themes (slice 11 §4b, decision "Looks and themes"): the active theme written as CSS custom properties on
// `:root` (and `color-scheme`), following the registry, the user's pick and the system's colour scheme; no reload. The
// app's stylesheet and the plugins' CSS read the variables.
// 所属：web 浏览器侧主题适配器；把共享 Theme 注册表写到 :root CSS 变量。
// 职责：按系统深浅模式跟随主题，写变量与 color-scheme，返回停止函数。
// 边界：不创建主题、不保存用户选择（共享 follower 负责）；停止只结束监听，不恢复旧变量。
// 上游：startPage 调用；下游：followActiveTheme/themeVariables、matchMedia、document。
// 导出：followThemes；writeVariables 是内部函数。
// 组合：followThemes → followActiveTheme → 回调 writeVariables；matchMedia change → follower.setMode。
// 示例：const stop = await followThemes(host, context); stop();
// 阅读顺序：followThemes → writeVariables。

import type { Context } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import type { Host } from "../host/index.ts";
import { followActiveTheme, themeVariables } from "../surfaces/index.ts";

/** Follows the themes on `host` and writes the active one on `:root` until the returned stop. */
/** 为页面建立主题跟随：host 提供主题注册表/用户选择，context 控制取消，返回停止函数。
 * 监听系统深浅模式，把当前主题写到根元素；例如系统转 dark 时会重新选择 dark 主题并更新 CSS。
 * 启动期间取得注册表失败会拒绝；停止只结束监听，不恢复之前的 CSS 变量和 color-scheme。
 */
export async function followThemes<P extends Principal>(host: Host<P>, context: Context): Promise<() => void> {
	// matches 是当前系统偏好的快照，后续 change 事件再读最新值。
	const scheme = matchMedia("(prefers-color-scheme: dark)");
	// 保存上次写入的变量名，以便主题切换时删除新主题不再提供的变量。
	let written: readonly string[] = [];
	// 先建立共享主题跟随；回调在初始 fallback、注册表、选择或模式变化时写 DOM。
	const follower = await followActiveTheme(
		host,
		scheme.matches ? "dark" : "light",
		(theme) => {
			// writeVariables 返回本次变量名，供下一次清理使用。
			written = writeVariables(themeVariables(theme), written);
			// 通知浏览器内建控件采用相应配色模式。
			document.documentElement.style.colorScheme = theme.mode;
		},
		context,
	);
	// 系统事件只改变 mode，实际选择主题仍由共享 follower 完成。
	const schemeChanged = (): void => follower.setMode(scheme.matches ? "dark" : "light");
	scheme.addEventListener("change", schemeChanged);
	// 返回清理闭包，结束 Chord 跟随并移除 DOM 媒体查询监听。
	return () => {
		follower.stop();
		scheme.removeEventListener("change", schemeChanged);
	};
}

/** Sets `variables` on `:root`, removing those of `before` it no longer has; the names it set. */
/** 将变量表写入根元素并删去 before 中已消失的名字，返回本次名字数组；例如 --radius 被删会 removeProperty。
 * 这是直接 DOM 写入，不检查颜色是否合法，也不处理本函数此前未记录的其他 CSS 属性。
 */
function writeVariables(variables: Readonly<Record<string, string>>, before: readonly string[]): readonly string[] {
	// style 指向根元素的内联样式；对它修改会立即影响页面样式计算。
	const style = document.documentElement.style;
	// hasOwn 区分实际存在的变量与原型属性；只移除上次由本跟随器写过的名字。
	for (const name of before) if (!Object.hasOwn(variables, name)) style.removeProperty(name);
	// Object.entries 逐项取名字和值；setProperty 支持 -- 开头的自定义变量。
	for (const [name, value] of Object.entries(variables)) style.setProperty(name, value);
	// 新数组只记录名字，CSS 值已写到 DOM。
	return Object.keys(variables);
}
