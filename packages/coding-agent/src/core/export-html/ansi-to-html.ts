/**
 * ANSI escape code to HTML converter.
 *
 * Converts terminal ANSI color/style codes to HTML with inline styles.
 * Supports:
 * - Standard foreground colors (30-37) and bright variants (90-97)
 * - Standard background colors (40-47) and bright variants (100-107)
 * - 256-color palette (38;5;N and 48;5;N)
 * - RGB true color (38;2;R;G;B and 48;2;R;G;B)
 * - Text styles: bold (1), dim (2), italic (3), underline (4)
 * - Reset (0)
 */

// 将扩展工具TUI渲染出来的颜色/样式文字转换成HTML片段，供tool-renderer嵌入导出页；不写文件、不运行终端控制命令。
// 只识别本文件正则的ESC[数字/分号m形式，未知ANSI不全部清理；正文转义HTML字符，但这不是通用终端协议净化器。
// Standard ANSI color palette (0-15)
// 数组下标对应传统16色；实际终端自定义调色板可能不同，这里采用固定导出色，不读取用户终端调色板。
const ANSI_COLORS = [
	"#000000", // 0: black
	"#800000", // 1: red
	"#008000", // 2: green
	"#808000", // 3: yellow
	"#000080", // 4: blue
	"#800080", // 5: magenta
	"#008080", // 6: cyan
	"#c0c0c0", // 7: white
	"#808080", // 8: bright black
	"#ff0000", // 9: bright red
	"#00ff00", // 10: bright green
	"#ffff00", // 11: bright yellow
	"#0000ff", // 12: bright blue
	"#ff00ff", // 13: bright magenta
	"#00ffff", // 14: bright cyan
	"#ffffff", // 15: bright white
];

/**
 * Convert 256-color index to hex.
 */
// 输入256色索引，返回预设/6阶色立方/灰阶的十六进制文字，无I/O；例如196得到#ff0000，232得到#080808。
// 预期索引0..255，但函数未验证或钳位；超范围参数不保证得到合法CSS颜色，不把number类型当作已验证颜色范围。
function color256ToHex(index: number): string {
	// Standard colors (0-15)
	// 0..15直接查表，负数同样会进此分支但可能取得undefined，现有代码未另行纠正。
	if (index < 16) {
		return ANSI_COLORS[index];
	}

	// Color cube (16-231): 6x6x6 = 216 colors
	// 从16减起，每36项一层红，每6项一档绿，剩余是蓝，得到每通道0..5。
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		// 局部纯函数把阶数映射为0/95/135/175/215/255；例如n=1→95。
		const toComponent = (n: number) => (n === 0 ? 0 : 55 + n * 40);
		// 数字转16进制并至少补两位，不是截成恰好两位；输入合法时得到标准通道文字。
		const toHex = (n: number) => toComponent(n).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// Grayscale (232-255): 24 shades
	// 灰阶三通道相等，从8开始每档加10，255对应238。
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * Escape HTML special characters.
 */
// 输入正文，依次转义&、尖括号和单双引号后返回，无副作用；例如<b>变&lt;b&gt;，避免被当真实HTML标签。
// 先转义原有&，再生成其他实体，避免把本次新加的&amp;等重复转义；不删除控制字符或校验URL。
function escapeHtml(text: string): string {
	// /.../g替换全部匹配，链式replace每步生成新字符串，不修改调用方的text。
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

// 当前SGR状态快照：颜色null表示恢复默认，其余布尔控制独立样式；仅在一次ansiToHtml调用内可变。
interface TextStyle {
	// 前景/背景是本转换器构造的CSS颜色字符串，并非任意用户HTML。
	fg: string | null;
	bg: string | null;
	// 粗体、低亮度、斜体、下划线，未实现反色/删除线等其他SGR样式。
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
}

// 无输入，返回新的全默认样式对象，互不共享状态；例如每一行转换都从无色/不加粗开始，不自动继承上一行末态。
function createEmptyStyle(): TextStyle {
	return {
		fg: null,
		bg: null,
		bold: false,
		dim: false,
		italic: false,
		underline: false,
	};
}

// 输入当前样式，按固定顺序拼CSS属性字符串，无外部副作用；例如{fg:"#ff0000",bold:true,...}得到color:#ff0000;font-weight:bold。
// 只拼非空颜色/启用布尔，不加外层style引号；dim用opacity近似终端低亮度，视觉不保证和真实终端完全一致。
function styleToInlineCSS(style: TextStyle): string {
	const parts: string[] = [];
	// 每个独立if可同时生效，不是互斥else链；最终用分号连接、不追加尾分号。
	if (style.fg) parts.push(`color:${style.fg}`);
	if (style.bg) parts.push(`background-color:${style.bg}`);
	if (style.bold) parts.push("font-weight:bold");
	if (style.dim) parts.push("opacity:0.6");
	if (style.italic) parts.push("font-style:italic");
	if (style.underline) parts.push("text-decoration:underline");
	return parts.join(";");
}

// 输入样式，返回是否任一颜色非null或任一样式启用，无修改；例如全默认false，fg设定就true，决定是否需要span。
function hasStyle(style: TextStyle): boolean {
	return style.fg !== null || style.bg !== null || style.bold || style.dim || style.italic || style.underline;
}

/**
 * Parse ANSI SGR (Select Graphic Rendition) codes and update style.
 */
// 输入一组数字SGR参数及可变样式对象，按顺序原地更新，无返回；例如[1,31]开粗体和红色，[22,39]清粗体/低亮及前景。
// 扩展色会额外消费2个或4个参数，未知码忽略；只检查参数数量/模式，不验证RGB通道与256色索引范围。
function applySgrCode(params: number[], style: TextStyle): void {
	// 手动游标而非for-of，以便遇38/48的扩展参数时一次跳过整个颜色描述。
	let i = 0;
	while (i < params.length) {
		const code = params[i];

		if (code === 0) {
			// Reset all
			// 清除所有已实现样式，不从主题/终端查询默认颜色，而是以后不生成对应CSS。
			style.fg = null;
			style.bg = null;
			style.bold = false;
			style.dim = false;
			style.italic = false;
			style.underline = false;
		} else if (code === 1) {
			// 开粗体；2开低亮、3开斜体、4开下划线，彼此独立保留已有状态。
			style.bold = true;
		} else if (code === 2) {
			style.dim = true;
		} else if (code === 3) {
			style.italic = true;
		} else if (code === 4) {
			style.underline = true;
		} else if (code === 22) {
			// Reset bold/dim
			// SGR22同时清除粗体/低亮；23/24分别清斜体/下划线，不影响颜色。
			style.bold = false;
			style.dim = false;
		} else if (code === 23) {
			style.italic = false;
		} else if (code === 24) {
			style.underline = false;
		} else if (code >= 30 && code <= 37) {
			// Standard foreground colors
			// 减30映射到调色板0..7。
			style.fg = ANSI_COLORS[code - 30];
		} else if (code === 38) {
			// Extended foreground color
			// 38后模式5要求还有索引，模式2要求还有三个通道；不足时本轮不设置颜色，后续参数仍可按普通码处理。
			if (params[i + 1] === 5 && params.length > i + 2) {
				// 256-color: 38;5;N
				style.fg = color256ToHex(params[i + 2]);
				// 主循环尾还会i++，这里加2一共消费38、5、N三个数字。
				i += 2;
			} else if (params[i + 1] === 2 && params.length > i + 4) {
				// RGB: 38;2;R;G;B
				const r = params[i + 2];
				const g = params[i + 3];
				const b = params[i + 4];
				// 用十进制rgb(...)写CSS，保留现有数值，不在此钳到0..255。
				style.fg = `rgb(${r},${g},${b})`;
				i += 4;
			}
		} else if (code === 39) {
			// Default foreground
			// 只清前景，背景与字体样式继续保留。
			style.fg = null;
		} else if (code >= 40 && code <= 47) {
			// Standard background colors
			// 减40映射到背景的传统0..7色。
			style.bg = ANSI_COLORS[code - 40];
		} else if (code === 48) {
			// Extended background color
			// 和38同样解析模式5索引或模式2三通道，区别仅写入bg而非fg。
			if (params[i + 1] === 5 && params.length > i + 2) {
				// 256-color: 48;5;N
				style.bg = color256ToHex(params[i + 2]);
				// 加2后尾部再加1，跳过整个48;5;N。
				i += 2;
			} else if (params[i + 1] === 2 && params.length > i + 4) {
				// RGB: 48;2;R;G;B
				const r = params[i + 2];
				const g = params[i + 3];
				const b = params[i + 4];
				style.bg = `rgb(${r},${g},${b})`;
				// 加4后尾部再加1，跳过整个48;2;R;G;B。
				i += 4;
			}
		} else if (code === 49) {
			// Default background
			// 只恢复默认背景。
			style.bg = null;
		} else if (code >= 90 && code <= 97) {
			// Bright foreground colors
			// 90..97映射调色板8..15，100..107同样用于亮背景。
			style.fg = ANSI_COLORS[code - 90 + 8];
		} else if (code >= 100 && code <= 107) {
			// Bright background colors
			style.bg = ANSI_COLORS[code - 100 + 8];
		}
		// Ignore unrecognized codes

		// 未识别或处理完当前码，都至少前进一步；扩展色分支已提前增加额外步数。
		i++;
	}
}

// Match ANSI escape sequences: ESC[ followed by params and ending with 'm'
// 捕获组只收数字和分号，空参数ESC[m也匹配；不支持冒号参数、8位CSI或任意OSC，g让exec逐次扫描。
const ANSI_REGEX = /\x1b\[([\d;]*)m/g;

/**
 * Convert ANSI-escaped text to HTML with inline styles.
 */
// 输入可能含SGR的文字，返回正文转义、样式span包裹的HTML片段，无I/O；例如ESC[31m红ESC[0m得到红色span。
// 流程：逐个匹配SGR→追加前段正文→关闭旧span→更新累计样式→开新span→最后补正文并闭span；不把未知转义当HTML代码执行。
// 一次调用样式从空开始，函数不负责跨行/跨块保存半条序列；未识别控制字符仍可能留在返回字符串中。
export function ansiToHtml(text: string): string {
	// 本次可变状态互相独立，inSpan记录是否需要闭标签，lastIndex记录上一个已消费SGR之后的位置。
	const style = createEmptyStyle();
	let result = "";
	let lastIndex = 0;
	let inSpan = false;

	// Reset regex state
	// 正则是模块共享且带g，每次调用先归零，避免沿用上次exec的扫描起点。
	ANSI_REGEX.lastIndex = 0;

	let match = ANSI_REGEX.exec(text);
	// exec返回匹配数组或null，循环直到找不到下一条本规则识别的SGR。
	while (match !== null) {
		// Add text before this escape sequence
		// 在改变样式前追加正文，沿用当前已打开span；HTML特殊字符始终先转义。
		const beforeText = text.slice(lastIndex, match.index);
		if (beforeText) {
			result += escapeHtml(beforeText);
		}

		// Parse SGR parameters
		// 空参数整体按[0]恢复；分号切出的空项parseInt为NaN，||0也当恢复，不对超大数字做范围限制。
		const paramStr = match[1];
		const params = paramStr ? paramStr.split(";").map((p) => parseInt(p, 10) || 0) : [0];

		// Close existing span if we have one
		// 每个SGR边界都结束旧span，即使新样式相同也不合并；不会产生未配对的样式标签。
		if (inSpan) {
			result += "</span>";
			inSpan = false;
		}

		// Apply the codes
		// 原地修改同一个style，使未被本条码清除的其他样式持续生效。
		applySgrCode(params, style);

		// Open new span if we have any styling
		// 全默认不加span，让外层页面样式控制正文默认颜色。
		if (hasStyle(style)) {
			result += `<span style="${styleToInlineCSS(style)}">`;
			inSpan = true;
		}

		// match.index是原串位置，match[0]是含ESC的整条码，消费后继续exec扫描。
		lastIndex = match.index + match[0].length;
		match = ANSI_REGEX.exec(text);
	}

	// Add remaining text
	// 最后一条SGR之后或完全无SGR时的剩余文字也要转义输出。
	const remainingText = text.slice(lastIndex);
	if (remainingText) {
		result += escapeHtml(remainingText);
	}

	// Close any open span
	// 输入没显式reset也会闭合HTML标签，但不会把这份style传给下一次调用。
	if (inSpan) {
		result += "</span>";
	}

	return result;
}

/**
 * Convert array of ANSI-escaped lines to HTML.
 * Each line is wrapped in a div element.
 */
// 输入按行拆好的ANSI文字数组，逐行独立转换并用div拼接返回，无I/O；例如["", "x"]首行用&nbsp;占位。
// 每行重新初始化SGR状态，不继承上一行颜色；join("")避免把源码换行加入HTML布局，原行内空格由导出CSS控制展示。
export function ansiLinesToHtml(lines: string[]): string {
	return lines.map((line) => `<div class="ansi-line">${ansiToHtml(line) || "&nbsp;"}</div>`).join("");
}
