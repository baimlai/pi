// The terminal's theme lookup (slice 11 §4b, decision "Looks and themes"): colours by role from the active theme, as
// the terminal shows them (true colour, else the nearest of 256; a theme's `tui` overrides first). A plugin asks for a
// role (`theme.fg("accent", "Notes")`), never writes raw colours; a new theme applies at the next redraw.
// 中文说明：本文件提供终端颜色查询。上游：startTerminalRuntime 用初始主题和颜色深度创建；
// 下游：应用 redraw 时调用 fg/bg 包住文本，并通过 onChange 订阅主题切换。它不写终端，只返回 SGR 字符串。
// 所属：tui 沙箱侧主题查询，是 surfaces/terminalColor 的薄封装。
// 边界：只生成 SGR 字符串并保存当前主题/监听器，不写终端、不跟随注册表（跟随由 runtime.ts 负责）。
// 上游：startTerminalRuntime 创建并让 followActiveTheme 调用 set；下游：surfaces/terminalColor 做颜色映射。
// 导出清单：TerminalTheme；theme 读取当前主题，fg/bg 生成前景/背景序列，onChange 订阅，set 替换主题。
// 组合：new TerminalTheme(FALLBACK_THEMES.dark, depth) → followActiveTheme → set → redraw 中调用 fg/bg。
// 示例：const theme = new TerminalTheme(FALLBACK_THEMES.dark, "truecolor"); theme.fg("accent", "x");
// 阅读顺序：字段/构造 → theme getter → fg/bg → onChange/set。

import { type ColorDepth, type Theme, terminalColor } from "../surfaces/index.ts";

/** Colours by role for the terminal. */
// 终端主题视图：当前 Theme、颜色深度（真彩或 256 色）和主题变化的监听器集合。
export class TerminalTheme {
	// #depth 固定于构造时；#theme 可被 set 替换；#listeners 保存重绘回调，不复制回调。
	readonly #depth: ColorDepth;
	#theme: Theme;
	readonly #listeners = new Set<() => void>();

	// 只保存初始值；不注册任何全局监听，主题跟随由 runtime.ts 的 followActiveTheme 负责。
	constructor(theme: Theme, depth: ColorDepth) {
		this.#theme = theme;
		this.#depth = depth;
	}

	/** The active theme. */
	// 当前主题对象；调用方可以读取颜色/名称，但不应修改（类型标为 readonly 的字段）。
	get theme(): Theme {
		return this.#theme;
	}

	/** `text` in `role`'s colour (the default colour after it). */
	// 返回“设置前景色 + 文本 + 恢复默认前景(39)”的字符串；role 不存在时 terminalColor 返回 39，文本仍原样输出。
	// 例如 fg("accent", "Notes") 生成 ESC[38;2;...mNotes ESC[39m，嵌套时内层恢复会回到终端默认色而非外层色。
	fg(role: string, text: string): string {
		return `\x1b[${terminalColor(this.#theme, role, this.#depth, "fg")}m${text}\x1b[39m`;
	}

	/** `text` on `role`'s colour as its background. */
	// 返回“设置背景色 + 文本 + 恢复默认背景(49)”的字符串；与 fg 一样不做转义/长度检查。
	bg(role: string, text: string): string {
		return `\x1b[${terminalColor(this.#theme, role, this.#depth, "bg")}m${text}\x1b[49m`;
	}

	/** Calls `listener` when the active theme changes (to redraw) until the returned removal. */
	// 登记主题变化监听并返回移除函数；Set 保证同一函数只存一份，重复移除无害。
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** The active theme is now `theme`. */
	// 替换当前主题并同步通知所有监听器（通常触发一次重绘）；即使主题对象相同也会通知。
	set(theme: Theme): void {
		this.#theme = theme;
		for (const listener of this.#listeners) listener();
	}
}
