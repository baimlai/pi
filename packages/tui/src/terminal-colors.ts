// 定义终端回复颜色的数据类型及纯字符串解析；TuiBase发查询、收集完整调色板并消费回复，本文件不写终端、不维护查询队列。
// OSC是ESC ]开头的控制串；此处支持BEL或ESC反斜杠作为结束符。RgbColor只声明通道形状，不保证值已验证。
export interface RgbColor {
	// 红通道，约定0..255。
	r: number;
	// 绿通道。
	g: number;
	// 蓝通道，不含alpha。
	b: number;
}

// 深/浅配色的字面量联合，不是具体RGB颜色。
export type TerminalColorScheme = "dark" | "light";

/** Colors the terminal reports for its current theme. */
// 查询结果字段可缺；是否凑齐16色由TUI收集器决定，而非这个接口运行时保证。
export interface TerminalColors {
	/** Default foreground (OSC 10). */
	// 默认前景色，来自OSC10。
	foreground?: RgbColor;
	/** Default background (OSC 11). */
	// 默认背景色，来自OSC11。
	background?: RgbColor;
	/** ANSI colors 0-15 (OSC 4). Only set when the terminal reported all 16. */
	// ANSI0..15数组；上游只在16项都可解析时返回，接口本身仍只是普通数组类型。
	palette?: RgbColor[];
}

// 将已确认的6位hex转RGB；例：#ff0080→255/0/128。可有#，不在此校验长度/字符，依赖调用方；无修改。
function hexToRgb(hex: string): RgbColor {
	// 只移除首位#，不trim或替换中间字符。
	const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
	// 前两位转红通道，基数16。
	const r = parseInt(normalized.slice(0, 2), 16);
	// 中间两位转绿。
	const g = parseInt(normalized.slice(2, 4), 16);
	// 最后两位转蓝。
	const b = parseInt(normalized.slice(4, 6), 16);
	// 返回属性简写组成的新对象。
	return { r, g, b };
}

// 把一段十六进制通道按自身位数归一化到0..255；例：ffff→255、8000约128。非法字符undefined，无I/O。
// 不限制位数或检查溢出，极长输入仍可能得到非有限计算结果，不能当完整颜色合法性验证。
function parseOscHexChannel(channel: string): number | undefined {
	// 至少一位且每位十六进制，大小写均可；无m/g。
	if (!/^[0-9a-f]+$/i.test(channel)) {
		// 字符不合法直接undefined。
		return undefined;
	}
	// 该位数能表示的最大值，例如4位是65535。
	const max = 16 ** channel.length - 1;
	// 最大值不正则不能作为缩放分母。
	if (max <= 0) {
		// 不可用时undefined。
		return undefined;
	}
	// 实际值除该位数上限再乘255，四舍五入为常用通道标度。
	return Math.round((parseInt(channel, 16) / max) * 255);
}

/** What an OSC color reply reports: the default foreground (OSC 10), background (OSC 11), or a palette index (OSC 4). */
// 回复目标可为前景、背景或调色板数字；number类型没限定只到15。
export type OscColorTarget = "foreground" | "background" | number;

// 整串匹配OSC10/11或OSC4;一至三位索引；正文不含BEL/ESC，不校验索引上限为15/255。
const OSC_COLOR_RESPONSE_PATTERN = /^\x1b\](?:(1[01])|4;(\d{1,3}));([^\x07\x1b]*)(?:\x07|\x1b\\)$/i;
// 匹配一个或多个连续CSI ?997;1/2 n报告；重复捕获组最终保留最后一次，1深色2浅色。
const COLOR_SCHEME_REPORT_PATTERN = /^(?:\x1b\[\?997;(1|2)n)+$/;

/**
 * Parse an OSC 10, 11, or 4 color reply. Returns undefined when `data` is not such a reply;
 * `rgb` is undefined when it is a reply with an unparseable color.
 */
// 解析一条OSC颜色回复，返回{target,rgb}或undefined；例：OSC4;13;#ff0080指向索引13。
// 区分“不像回复”和“回复但颜色坏了”：后者仍返回目标且rgb=undefined。无I/O/状态修改，不拼分片。
export function parseOscColorResponse(data: string): { target: OscColorTarget; rgb: RgbColor | undefined } | undefined {
	// 按支持的完整回复模式匹配。
	const match = data.match(OSC_COLOR_RESPONSE_PATTERN);
	// 形状不符合时不消费为颜色回复。
	if (!match) {
		// 返回undefined。
		return undefined;
	}
	// 三元分支确定回复目标。
	const target: OscColorTarget =
		// 10→前景、11→背景，否则把OSC4索引捕获转十进制，不在这里限定调色板范围。
		match[1] === "10" ? "foreground" : match[1] === "11" ? "background" : Number.parseInt(match[2], 10);
	// 即使颜色解析失败仍保留target，供上游确认已收到该字段回复。
	return { target, rgb: parseOscColorValue(match[3]) };
}

// 解析颜色正文为RGB或undefined；例：rgb:ffff/0000/8000。支持6/12位hex及斜杠分通道，不修改输入。
// 会移除可选rgb:/rgba:前缀但不处理alpha，只用前三段，额外段忽略；不等同CSS rgb()/rgba()语法。
function parseOscColorValue(rawValue: string): RgbColor | undefined {
	// 只在正文两侧trim空白，协议外壳由外层检查。
	const value = rawValue.trim();
	// #开头进入固定总位数分支。
	if (value.startsWith("#")) {
		// 去掉#供格式检查。
		const hex = value.slice(1);
		// 6位hex每通道两位。
		if (/^[0-9a-f]{6}$/i.test(hex)) {
			// 复用8位通道直接解析。
			return hexToRgb(value);
		}
		// 12位hex每通道四位，需按65535归一化。
		if (/^[0-9a-f]{12}$/i.test(hex)) {
			// 红的四位。
			const r = parseOscHexChannel(hex.slice(0, 4));
			// 绿的四位。
			const g = parseOscHexChannel(hex.slice(4, 8));
			// 蓝的四位。
			const b = parseOscHexChannel(hex.slice(8, 12));
			// 三者均非undefined才返回RGB，不以0的真假判断有效性。
			return r !== undefined && g !== undefined && b !== undefined ? { r, g, b } : undefined;
		}
		// #开头但长度/字符无效就不再试斜杠形式。
		return undefined;
	}

	// 可选rgb:/rgba:前缀大小写不敏感；无前缀也能继续按斜杠拆分。
	const rgbValue = value.replace(/^rgba?:/i, "");
	// 解构只拿前三段，第四段并不作为透明度输出。
	const [red, green, blue] = rgbValue.split("/");
	// 少任一通道就失败，空字符串还会由通道解析器拒绝。
	if (red === undefined || green === undefined || blue === undefined) {
		// 返回undefined。
		return undefined;
	}
	// 红按其自身位数换算。
	const r = parseOscHexChannel(red);
	// 绿按自身位数换算，不要求三段等宽。
	const g = parseOscHexChannel(green);
	// 蓝同样换算。
	const b = parseOscHexChannel(blue);
	// 都可解析才返回新对象。
	return r !== undefined && g !== undefined && b !== undefined ? { r, g, b } : undefined;
}

// 解析一串深浅报告并返回最后一条的dark/light，非法undefined；例：1n后跟2n得到light。纯函数，不探测当前主题或注册监听。
export function parseTerminalColorSchemeReport(data: string): TerminalColorScheme | undefined {
	// 整串必须完全由合法报告组成，不容许前后普通文字。
	const match = data.match(COLOR_SCHEME_REPORT_PATTERN);
	// 任何不匹配形状都失败。
	if (!match) {
		// 无报告结果。
		return undefined;
	}
	// 重复组留下最后的1/2；2浅色，其余匹配结果只能是1深色。
	return match[1] === "2" ? "light" : "dark";
}
