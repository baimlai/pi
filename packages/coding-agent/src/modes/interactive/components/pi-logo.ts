// 生成启动标识的半块图形/纯文字ANSI串；只返回字符串，不接真实终端或画布。
// 用RGB构造品牌色，前/背景编码服从theme记录的模式；Apple Terminal检测依平台与环境线索。
import { backgroundAnsi, foregroundAnsi, isAppleTerminalSession, rgbColor } from "@earendil-works/pi-tui";
// 取当前主题颜色模式，标识色值本身不随主题token变化；调用前需初始化主题。
import { theme } from "../theme/theme.ts";

// 固定珊瑚色；rgbColor检查通道并返回颜色数据，不写终端。
const CORAL = rgbColor(228, 138, 122);
// 固定蓝色。
const BLUE = rgbColor(79, 142, 179);
// 固定黄色。
const YELLOW = rgbColor(234, 182, 93);
// SGR0恢复全部默认样式，不保存外层颜色/粗体栈。
const RESET = "\x1b[0m";

/**
 * The pi logo: 4 cells wide and 2 lines tall. Each cell shows two square pixels with half blocks:
 *
 *   coral coral coral .
 *   blue  .     coral .
 *   blue  blue  .     yellow
 *   blue  .     .     yellow
 *
 * The brand colors stay fixed across themes; they follow the terminal's color mode.
 */
// 返回固定两行半块字符标识，TS二元组要求正好两项；例上游逐行加到欢迎区域。
// 几何设计为4列×2行，每格上下两个像素；品牌色固定但编码模式随实例，终端是否准确显示仍看支持情况。
// 无文件/网络/绘屏，读取未初始化theme会抛；内部reset可清外层样式。
export function piLogoLines(): [string, string] {
	// 读当前实例模式，不在此重新探测真实硬件。
	const mode = theme.getColorMode();
	// 局部fg箭头把同形RGB转前景开启码；typeof CORAL是TS取值类型，不是运行时typeof检查。
	const fg = (color: typeof CORAL) => foregroundAnsi(color, mode);
	// The fourth cell of the top line is empty, so it is padded to the same width as the bottom line.
	// 上半行用▀前景画上像素/背景画下像素，再拼▀█；末尾空格补到4列，ANSI字符串长度远不止4。
	const top = `${fg(CORAL)}${backgroundAnsi(BLUE, mode)}▀${RESET}${fg(CORAL)}▀█${RESET} `;
	// 下半行用蓝█▀、空格与黄█，重置让后面空格恢复默认。
	const bottom = `${fg(BLUE)}█▀${RESET} ${fg(YELLOW)}█${RESET}`;
	// 返回两串而非拼成含换行的一串，便于上层布局。
	return [top, bottom];
}

/**
 * Whether the terminal renders the half-block logo correctly. Apple Terminal draws gaps between rows and
 * misaligns the half blocks, so it gets the text wordmark instead.
 */
// 按Apple Terminal会话启发式决定是否用半块标识，返回boolean；例命中时宿主可改用Pi文字。
// 不做实际像素试绘，不是对所有终端/字体的支持证明；不会因为返回false自动显示替代物。
export function supportsPiLogo(): boolean {
	// 对darwin平台且TERM_PROGRAM精确为Apple_Terminal的判定取反，无Theme访问或终端I/O。
	return !isAppleTerminalSession();
}

/** Text fallback for the logo: "Pi" with the logo's coral and yellow. */
// 返回两字母Pi品牌色备选字符串，例宿主在supportsPiLogo=false时选它；不自行作环境分支。
// 按当前模式编码，P珊瑚/i黄色，各后reset全部样式；不执行绘屏。
export function piWordmark(): string {
	// 读取theme的既有颜色模式。
	const mode = theme.getColorMode();
	// 模板组合两个字母及颜色/复位码，仍只是string。
	return `${foregroundAnsi(CORAL, mode)}P${RESET}${foregroundAnsi(YELLOW, mode)}i${RESET}`;
}
