// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；复制到扩展目录或 `pi -e ./custom-header.ts` 加载。
// 演示内容：用 ctx.ui.setHeader 把内置头部（logo + 快捷键提示）替换成由字符块拼成的 pi mascot，并保留一个恢复命令。
// 上下游：session_start 时检查 ctx.mode 并安装头部工厂；/builtin-header 命令恢复内置头部。头部组件由宿主在渲染时创建，getPiMascot 只做字符串/主题拼装；不调用模型、不写文件。
// 能力清单：
// - getPiMascot(theme: Theme)：返回 mascot 的多行字符串数组，首尾各一个空行。
// - 默认导出 (pi: ExtensionAPI) => void：注册 session_start 和 /builtin-header。
// - session_start 回调：仅 TUI 安装自定义 header；其他模式跳过。
// 典型运行顺序：启动 TUI -> session_start 安装 mascot 头部 -> 渲染显示眼睛、横梁、四条腿和版本副标题 -> /builtin-header 恢复内置头部。
// 示例（真实签名）：
//   pi -e ./examples/extensions/custom-header.ts
//   // TUI 顶部显示字符拼成的 mascot 与 "shitty coding agent v0.x.y" 副标题
// 阅读顺序：先看 getPiMascot 的颜色函数、字符常量和组装，再看 session_start 的模式判断与 setHeader 工厂，最后看恢复命令。
// 前置与副作用：只有 TUI 有头部区域；rpc/json/print 模式不会安装。示例只在 session_start 安装，/builtin-header 恢复后，下一次 session_start（reload/new/resume/fork）会再次安装 mascot。render 忽略 width，长行在窄终端可能被宿主裁剪。颜色只是主题转义，不改变字符宽度；副标题和版本字符串属于原示例文案。
/**
 * Custom Header Extension
 *
 * Demonstrates ctx.ui.setHeader() for replacing the built-in header
 * (logo + keybinding hints) with a custom component showing the pi mascot.
 */

// import type 只引入类型；Theme 用于给 setHeader 工厂和 getPiMascot 标注主题参数。
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
// VERSION 是运行时值，来自包导出；与上面的 type import 分开。
import { VERSION } from "@earendil-works/pi-coding-agent";

// --- PI MASCOT ---
// Based on pi_mascot.ts - the pi agent character
// 根据主题生成 mascot 的多行字符串数组；输入 Theme，输出 string[]，纯函数、无 I/O。
// 颜色函数把任意文本包上主题 ANSI 转义；返回数组包含首尾空行，便于头部留白。
// 示例：getPiMascot(theme) 返回 ["", "     █▌  █▌", ...]（实际颜色由主题决定）。
function getPiMascot(theme: Theme): string[] {
	// 三个颜色 helper 都是 (text: string) => string；white 是恒等函数，black 用 dim token 近似。
	// --- COLORS ---
	// 3b1b Blue: R=80, G=180, B=230
	// theme.fg("accent", text) 只添加颜色转义，不改变可见字符宽度。
	const piBlue = (text: string) => theme.fg("accent", text);
	// white 原样返回文本；注释说明也可以换成 theme.fg("text", text)。
	const white = (text: string) => text; // Use plain white (or theme.fg("text", text))
	// black 实际使用 dim 主题 token，而不是纯黑；这是为了在深浅终端里都能看清。
	const black = (text: string) => theme.fg("dim", text); // Use dim for contrast

	// --- GLYPHS ---
	// BLOCK 是 U+2588 全块字符，用作 mascot 的像素。
	const BLOCK = "█";
	// PUPIL 是 U+258C 左半块，与全块组合出侧视瞳孔。
	const PUPIL = "▌"; // Vertical half-block for the pupil

	// --- CONSTRUCTION ---

	// 1. The Eye Unit: [White Full Block][Black Vertical Sliver]
	// This creates the "looking sideways" effect
	// 模板字符串把白色块和 dim 半块拼成一个眼睛单元；两个字符都占一个终端列。
	const eye = `${white(BLOCK)}${black(PUPIL)}`;

	// 2. Line 1: The Eyes
	// 5 spaces indent aligns them with the start of the legs
	// 眼睛行前面 5 个空格，使眼睛与下方腿部对齐。
	const lineEyes = `     ${eye}  ${eye}`;

	// 3. Line 2: The Wide Top Bar (The "Overhang")
	// 14 blocks wide for that serif-style roof
	// repeat(14) 生成 14 个块；前面两个空格形成顶部横梁的缩进。
	const lineBar = `  ${piBlue(BLOCK.repeat(14))}`;

	// 4. Lines 3-6: The Legs
	// Indented 5 spaces relative to the very left edge
	// Leg width: 2 blocks | Gap: 4 blocks
	// 每条腿两个块、中间四个空格；四条腿共用同一字符串。
	const lineLeg = `     ${piBlue(BLOCK.repeat(2))}    ${piBlue(BLOCK.repeat(2))}`;

	// --- ASSEMBLY ---
	// 数组首尾各一个空行，返回后由 render 直接展开。
	return ["", lineEyes, lineBar, lineLeg, lineLeg, lineLeg, lineLeg, ""];
}

// 扩展入口：注册 session_start 和 /builtin-header；加载时不安装头部。
export default function (pi: ExtensionAPI) {
	// session_start 在启动、恢复、分叉、/new 后触发；每次 TUI 会话都重新安装头部。
	// Set custom header immediately on load (if UI is available)
	// 事件回调没有 await；async 只因事件处理器允许异步。
	pi.on("session_start", async (_event, ctx) => {
		// 只有 TUI 有头部区域；rpc/json/print 模式跳过，避免无效调用。
		if (ctx.mode === "tui") {
			// setHeader 接收工厂；宿主在渲染时调用，参数包含 TUI 和主题。
			ctx.ui.setHeader((_tui, theme) => {
				// 工厂返回 Component：render 返回行数组，invalidate 需要空实现。
				return {
					// render 的 width 参数在这里未使用；长行可能超出窄终端，由宿主裁剪。
					render(_width: number): string[] {
						// 每次重画都重新生成 mascot 字符串数组；纯字符串操作很轻。
						const mascotLines = getPiMascot(theme);
						// Add a subtitle with hint
						// muted 色显示副标题，dim 色追加版本号；VERSION 是运行时包版本。
						const subtitle = `${theme.fg("muted", "   shitty coding agent")}${theme.fg("dim", ` v${VERSION}`)}`;
						// 把 mascot 行与副标题拼成新数组；首尾空行已包含在 mascot 中。
						return [...mascotLines, subtitle];
					},
					// 没有缓存需要失效。
					invalidate() {},
				};
			});
		}
	});

	// Command to restore built-in header
	// /builtin-header 恢复内置头部；命令本身仍在，下一次 session_start 会再次安装 mascot。
	pi.registerCommand("builtin-header", {
		description: "Restore built-in header with keybinding hints",
		// 无参数；handler 直接调用 UI。
		handler: async (_args, ctx) => {
			// undefined 表示恢复宿主内置头部（logo + 快捷键提示）。
			ctx.ui.setHeader(undefined);
			// 通知用户已恢复；不检查当前是否真的在 TUI 模式。
			ctx.ui.notify("Built-in header restored", "info");
		},
	});
}
