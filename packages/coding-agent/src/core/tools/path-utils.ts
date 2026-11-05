// 工具路径入口：正规化用户路径，并为 macOS 截图名称中的空格、重音字符和引号尝试可读文件名变体。
// 同步 exists 辅助使用 accessSync；F_OK 只检查存在性，不等于保证有读取权限。
import { accessSync, constants } from "node:fs";
// 异步 access 返回 Promise，适合工具执行过程中的 await。
import { access } from "node:fs/promises";
// 共享路径层负责 ~、file: URL、平台分隔符和相对目录处理；此文件只补工具使用的选项与候选名。
import { normalizePath, resolvePath } from "../../utils/paths.ts";

// U+202F 是窄不换行空格，看起来像普通空格，却是不同字符。
const NARROW_NO_BREAK_SPACE = "\u202F";

/**
 * 把截图名称里 AM/PM 前的普通空格替换为窄不换行空格；纯字符串转换，不访问磁盘。
 * 例如名称中的“ 10.00.00 AM.png”可匹配 macOS 实际使用的特殊空格。
 */
function tryMacOSScreenshotPath(filePath: string): string {
	// 正则捕获 AM/PM；g 处理全部匹配，i 忽略大小写，替换字符串 $1 放回捕获内容。
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

/**
 * 生成 Unicode NFD 文件名变体：把组合字符分解，方便匹配 macOS 的存储形式。
 * 例如 é 可表示为 e 加组合重音；看起来相同的名称可能有不同编码。
 */
function tryNFDVariant(filePath: string): string {
	// macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
	// normalize 返回新字符串，原路径变量不变；NFD 是 Unicode 分解标准形式。
	return filePath.normalize("NFD");
}

/**
 * 把普通单引号替换成右弯单引号，生成 macOS 截图名称的候选路径。
 * 例如法语名称 d'écran 的 ASCII 引号与系统生成的弯引号不同；此函数不保证候选文件存在。
 */
function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	// g 表示替换路径中的所有普通单引号，U+2019 是右弯引号。
	return filePath.replace(/'/g, "\u2019");
}

/**
 * 同步查询路径是否存在；成功返回 true，所有访问异常返回 false，不区分缺路径与无访问权限。
 * 例如 resolveReadPath 依次探测候选文件名时使用，调用期间会阻塞当前线程的文件系统查询。
 */
function fileExists(filePath: string): boolean {
	try {
		// 同步询问操作系统该路径能否被定位；异常交给 catch。
		accessSync(filePath, constants.F_OK);
		// access 未抛错，当前探测视为存在。
		return true;
		// 不需要错误对象时 catch 可省略括号；这里只把所有访问失败折合成 false。
	} catch {
		// 路径未能被访问，调用者可以继续尝试其他候选；不是严格证明文件绝对不存在。
		return false;
	}
}

/**
 * 异步探测路径存在性，返回 Promise<boolean>；任何 access 失败均视为 false。
 * 例如 await pathExists("/tmp/a.txt")，不会读取 a.txt 的正文。
 */
export async function pathExists(filePath: string): Promise<boolean> {
	try {
		// 异步询问存在性；await 等待成功或异常，不会打开并读取文件正文。
		await access(filePath, constants.F_OK);
		// access 未抛错，当前探测视为存在。
		return true;
		// 不需要错误对象时 catch 可省略括号；这里只把所有访问失败折合成 false。
	} catch {
		// 路径未能被访问，调用者可以继续尝试其他候选；不是严格证明文件绝对不存在。
		return false;
	}
}

/**
 * 仅正规化输入路径：统一 Unicode 空格、移除开头 @，并由 normalizePath 处理 ~ 等形式。
 * 例如 @~/a.txt 变为用户主目录下的路径；不会检查文件是否存在。
 */
export function expandPath(filePath: string): string {
	// 传对象选项，要求统一特殊空格并去 @；其余默认路径处理由共享函数决定。
	return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
/**
 * 把相对路径相对于传入 cwd 解析，兼容 ~、@file 和 Unicode 空格；返回绝对路径，不创建文件。
 * 例如 resolveToCwd("src/a.ts", "/project") 得到 /project/src/a.ts。
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	// 用传入 cwd 而非盲用进程目录，保证会话切换工作目录后工具相对路径也正确。
	return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * 同步解析读取路径，先试原路径，再试 macOS 空格、NFD、弯引号及组合变体，找到即返回。
 * 所有候选都不存在时仍返回原解析路径，让真正的读文件操作报告错误；不在这里创建文件。
 */
export function resolveReadPath(filePath: string, cwd: string): string {
	// 先正规化并解析原始输入，作为优先候选和最终错误路径。
	const resolved = resolveToCwd(filePath, cwd);

	// 原名能定位时立即采用，不再尝试可能指向另一个文件的近似名称。
	if (fileExists(resolved)) {
		// 返回原始绝对路径；此行既可能表示原名命中，也可能是全部变体失败后的兜底，结合所在分支阅读。
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	// 第一候选只改变截图 AM/PM 前的特殊空格。
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	// 只有确实产生不同名称时才查磁盘；&& 从左到右短路，左边为 false 就不做右边查询。
	if (amPmVariant !== resolved && fileExists(amPmVariant)) {
		// 采用已经确认能定位的特殊空格候选。
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	// 第二候选把重音等字符换成 NFD 编码。
	const nfdVariant = tryNFDVariant(resolved);
	// 不同编码候选存在时才采用；不会仅因字符正规化就无条件替换。
	if (nfdVariant !== resolved && fileExists(nfdVariant)) {
		// 返回能定位的 NFD 路径。
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	// 第三候选仅把直引号换成弯引号。
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	// 只接受实际存在的弯引号名称。
	if (curlyVariant !== resolved && fileExists(curlyVariant)) {
		// 采用查到的弯引号路径。
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	// 最后同时尝试 NFD 与弯引号，覆盖两种差异一起出现的截图名称。
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	// 组合变体也必须通过存在性探测，不凭转换结果猜测命中。
	if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
		// 返回最终命中的组合候选。
		return nfdCurlyVariant;
	}

	// 返回原始绝对路径；此行既可能表示原名命中，也可能是全部变体失败后的兜底，结合所在分支阅读。
	return resolved;
}

/**
 * resolveReadPath 的异步版本，用 await 探测各候选，避免同步 access 阻塞。
 * 例：read 工具收到截图路径后调用它；变体全部失败时返回原解析路径，后续 access 再报错。
 */
export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
	// 先正规化并解析原始输入，作为优先候选和最终错误路径。
	const resolved = resolveToCwd(filePath, cwd);

	// 异步版本同样优先原始解析路径。
	if (await pathExists(resolved)) {
		// 返回原始绝对路径；此行既可能表示原名命中，也可能是全部变体失败后的兜底，结合所在分支阅读。
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	// 第一候选只改变截图 AM/PM 前的特殊空格。
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	// 先排除与原路径相同的候选，再异步查存在性，减少无意义 I/O。
	if (amPmVariant !== resolved && (await pathExists(amPmVariant))) {
		// 采用已经确认能定位的特殊空格候选。
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	// 第二候选把重音等字符换成 NFD 编码。
	const nfdVariant = tryNFDVariant(resolved);
	// 异步探测 Unicode NFD 候选。
	if (nfdVariant !== resolved && (await pathExists(nfdVariant))) {
		// 返回能定位的 NFD 路径。
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	// 第三候选仅把直引号换成弯引号。
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	// 异步探测弯引号候选，await 的结果参与 && 条件。
	if (curlyVariant !== resolved && (await pathExists(curlyVariant))) {
		// 采用查到的弯引号路径。
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	// 最后同时尝试 NFD 与弯引号，覆盖两种差异一起出现的截图名称。
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	// 异步检查组合变体；前面各次 await 都按候选优先级串行执行。
	if (nfdCurlyVariant !== resolved && (await pathExists(nfdCurlyVariant))) {
		// 返回最终命中的组合候选。
		return nfdCurlyVariant;
	}

	// 返回原始绝对路径；此行既可能表示原名命中，也可能是全部变体失败后的兜底，结合所在分支阅读。
	return resolved;
}
