// 路径处理的公共入口：区分真实路径、字符串比较、输入归一化、显示与文件版本，供 CLI、会话和存储使用。
// realpathSync 会访问文件系统并跟随符号链接，statSync 读取文件元数据。
import { realpathSync, statSync } from "node:fs";
// homedir 取操作系统用户主目录，例如 /Users/alice。
import { homedir } from "node:os";
// resolve as nodeResolvePath 是导入重命名；posix/win32 分别提供两套路径字符串规则。
import { isAbsolute, join, resolve as nodeResolvePath, posix, relative, sep, win32 } from "node:path";
// 把 file:// URL 转成本地路径，包括处理 URL 编码的空格。
import { fileURLToPath } from "node:url";
// 同步调用外部工具的公共封装，用于设置云同步忽略属性。
import { spawnProcessSync } from "./child-process.ts";

// 正则字符集合列出不换行空格、全角空格等；g 标志表示替换所有匹配位置。
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** 输入归一化的可选开关；默认只展开 ~，其他开关省略时不会启用。 */
export interface PathInputOptions {
	/** Trim leading/trailing whitespace before normalization. */
	// 去掉首尾空白适合用户输入框；真实文件名也可能含空白，因此由调用方选择。
	trim?: boolean;
	/** Expand leading `~` to a home directory. Defaults to true. */
	// ? 表示可省略，默认 true 在 normalizePath 中通过 ?? 实现。
	expandTilde?: boolean;
	/** Home directory used for `~` expansion. Defaults to `os.homedir()`. */
	// 可注入主目录，比如测试用 /home/test，不必修改全机用户配置。
	homeDir?: string;
	/** Strip a leading `@`, used for CLI @file paths. */
	// CLI 的 @file 写法中 @ 是参数标记；启用后只去掉开头一个 @。
	stripAtPrefix?: boolean;
	/** Normalize unicode space variants to regular spaces. */
	// 将特殊 Unicode 空格转换为普通空格，同样由调用者显式启用。
	normalizeUnicodeSpaces?: boolean;
}

/**
 * Resolve a path to its canonical (real) form, following symlinks.
 * Falls back to the raw path if resolution fails (e.g. the target does
 * not exist yet), so that callers never crash on missing filesystem
 * entries.
 */
/** 跟随符号链接拿真实路径；例如 link 指向 actual 时返回 actual，失败则保留原输入。 */
export function canonicalizePath(path: string): string {
	try {
		// 需要文件系统能够解析目标；这里不同于只操作字符串的 resolve。
		return realpathSync(path);
	} catch {
		// 文件缺失、权限等解析失败都回退，不在此函数向上抛错。
		return path;
	}
}

/**
 * Key for comparing filesystem paths: the resolved absolute path, case-folded
 * on Windows because Windows paths are case-insensitive (`c:\Users` and
 * `C:\Users` are the same directory). NTFS can enable per-directory case
 * sensitivity, but it is rarely used outside WSL interop, so it is ignored
 * here (https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity).
 * Does not touch the filesystem; call `canonicalizePath` first when symlinks
 * must compare equal. Use only for comparison, never for display or
 * filesystem access.
 */
/** 生成仅供比较的绝对路径键；Windows 转小写，不解析符号链接，也不应用于显示或文件访问。 */
export function getPathComparisonKey(path: string): string {
	// 运行时选择路径规则，测试可以在调用前模拟平台。
	const pathApi = getPlatformPathApi();
	// resolve 以当前工作目录为基准处理相对路径并折叠 . 和 ..，无需访问目标。
	const resolvedPath = pathApi.resolve(path);
	// 三元表达式只在 Windows 转小写；这是项目的比较约定，忽略其可配置的逐目录大小写敏感性。
	return pathApi === win32 ? resolvedPath.toLowerCase() : resolvedPath;
}

/** `node:path` rules for the current platform, read at call time so tests can simulate Windows. */
/** 每次调用按当前平台选择路径 API；typeof win32 在类型位置描述该模块对象的类型。 */
function getPlatformPathApi(): typeof win32 {
	// 非 Windows 使用 POSIX 规则，包括 macOS 与 Linux。
	return process.platform === "win32" ? win32 : posix;
}

/** True when both paths name the same location (see `getPathComparisonKey`). */
/** 按路径比较键判断相等，例如 Windows 的 C:\Work 和 c:\work；符号链接需提前真实化。 */
export function pathsEqual(left: string, right: string): boolean {
	// 严格相等比较两个标准化后的字符串，不检查文件是否真的存在。
	return getPathComparisonKey(left) === getPathComparisonKey(right);
}

/** True when `child` is `parent` or inside it (see `getPathComparisonKey`). */
/** 按字符串判断 child 等于 parent 或处于其下；例如 /a/b 属于 /a，/ab 不属于 /a。 */
export function isPathWithin(parent: string, child: string): boolean {
	// 先统一父路径的绝对形式和平台大小写规则。
	const parentKey = getPathComparisonKey(parent);
	// 子路径使用同一套比较规则。
	const childKey = getPathComparisonKey(child);
	// 目录自身也算在目录内，直接返回 true。
	if (childKey === parentKey) return true;
	// Filesystem roots (`/`, `C:\`) already end with a separator.
	// 根路径已自带分隔符，不应再多拼一个；Windows 与 POSIX 的分隔符不同。
	const pathSep = getPlatformPathApi().sep;
	// 补齐边界分隔符后查前缀，避免 /a 与 /ab 混淆；不跟随符号链接，不能单独当作安全沙箱检查。
	return childKey.startsWith(parentKey.endsWith(pathSep) ? parentKey : `${parentKey}${pathSep}`);
}

/** Replace a leading home directory with `~` for display. Relative paths are returned unchanged. */
/** 为显示把主目录前缀缩为 ~；例如 /home/a/docs → ~/docs，相对路径保持原样。 */
export function shortenHomePath(path: string, homeDir: string = homedir()): string {
	// 使用当前平台规则判断绝对路径与计算相对路径。
	const pathApi = getPlatformPathApi();
	// 无主目录、输入相对、或位于主目录外时，直接保留输入。
	if (!homeDir || !pathApi.isAbsolute(path) || !isPathWithin(homeDir, path)) return path;
	// 已确认属于主目录，计算其内部相对部分。
	const relativePath = pathApi.relative(homeDir, path);
	// 目录自身得到空相对路径，因此返回单个 ~；子项拼上平台分隔符。
	return relativePath ? `~${pathApi.sep}${relativePath}` : "~";
}

/** 用文件元数据拼出缓存版本；文件无法 stat 就返回 undefined，这不是内容 SHA-256。 */
export function getFileRevision(path: string): string | undefined {
	try {
		// bigint: true 用大整数保留纳秒时间等精度，不经过可能丢精度的 JavaScript number。
		const stats = statSync(path, { bigint: true });
		// 设备号、inode、大小、修改时间、状态变化时间共同组成比较字符串。
		return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
	} catch {
		// 不存在或无权读取都返回 undefined；调用方不能把两个 undefined 当成版本一致。
		return undefined;
	}
}

/**
 * Returns true if the value is NOT a package source (npm:, git:, etc.),
 * a built-in extension (builtin:), or a remote URL protocol. Bare names,
 * relative paths, and file: URLs are considered local.
 */
/** 排除已知包来源及远端协议，其他输入视为本地候选；file:// 属于本地。 */
export function isLocalPath(value: string): boolean {
	// 先去首尾空白再判断前缀，避免普通用户输入空格影响分类。
	const trimmed = value.trim();
	// Known non-local prefixes. file: URLs are local paths and are intentionally resolved by resolvePath().
	// || 表示任意一种已知非本地来源匹配即可进入分支。
	if (
		// npm: 是包管理器资源描述，不是磁盘上一个以 npm: 开头的文件名。
		trimmed.startsWith("npm:") ||
		// git: 表示 Git 包来源。
		trimmed.startsWith("git:") ||
		// github: 是仓库来源缩写。
		trimmed.startsWith("github:") ||
		// http: 和 https: 均是远端 URL。
		trimmed.startsWith("http:") ||
		trimmed.startsWith("https:") ||
		// ssh: 也是远端来源。
		trimmed.startsWith("ssh:") ||
		// builtin: 表示程序内置扩展，而不是用户指定的本地文件。
		trimmed.startsWith("builtin:")
	) {
		// 命中已知非本地前缀就返回 false。
		return false;
	}
	// 未命中则返回 true；这是识别约定，不是通用 URL 解析器或文件存在性检查。
	return true;
}

/** Convert Git Bash, MSYS, Cygwin, and WSL drive paths to a form native Windows APIs accept. */
/** 把 /c/dir、/mnt/c/dir、/cygdrive/c/dir 这类 shell 盘符路径转换为 C:\dir。 */
export function normalizeWindowsShellPath(filePath: string): string {
	// 仅处理单斜线开头且没有反斜线的形式；// 可能是网络路径，保留原样。
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
	// 正则接受可选 mnt/ 或 cygdrive/，捕获盘符与剩余路径；i 表示盘符不区分大小写。
	const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	// 不像受支持盘符形式时，不猜测如何转换。
	if (!match) return filePath;
	// 第 2 个捕获组可能缺失，所以用 ?.；把后续 / 转成 Windows 反斜线。
	const suffix = match[2]?.replaceAll("/", "\\");
	// 盘符转大写；?? 把缺失的后缀视为空字符串，生成盘符根路径。
	return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

/** 按选项整理路径输入：空白/@/Windows shell/~ /file URL；不会普遍转绝对路径或解析符号链接。 */
export function normalizePath(input: string, options: PathInputOptions = {}): string {
	// let 允许后续逐步更新；默认不 trim，避免改变真实文件名。
	let normalized = options.trim ? input.trim() : input;
	// 只有显式启用时才把 Unicode 空格统一。
	if (options.normalizeUnicodeSpaces) {
		// replace 使用前面的全局正则，普通字符保持原样。
		normalized = normalized.replace(UNICODE_SPACES, " ");
	}
	// && 短路表示开关启用且确实以 @ 开头才去标记。
	if (options.stripAtPrefix && normalized.startsWith("@")) {
		// slice(1) 从第二个字符开始；@@file 会剩下 @file，不会循环剥离。
		normalized = normalized.slice(1);
	}
	// 只有当前运行于 Windows 才启用盘符路径转换。
	if (process.platform === "win32") {
		// 例如 /mnt/c/code 转为 Windows 可接受的盘符形式。
		normalized = normalizeWindowsShellPath(normalized);
	}

	// ?? 仅对 null/undefined 回退；显式 false 会保留，所以可以关闭默认的 ~ 展开。
	if (options.expandTilde ?? true) {
		// 优先采用调用方 homeDir，否则查询操作系统。
		const home = options.homeDir ?? homedir();
		// 只有一个 ~ 时直接返回主目录。
		if (normalized === "~") return home;
		// 只展开 ~/ 或 Windows 的 ~\；~someone 不是这里支持的用户目录语法。
		if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
			// 去掉前两个字符再拼主目录，不手写平台分隔符。
			return join(home, normalized.slice(2));
		}
	}

	// 只识别 file:// 开头的 URL，其他普通路径不进入 URL 解析。
	if (/^file:\/\//.test(normalized)) {
		// 例如 file:///tmp/a%20b 转为 /tmp/a b；非法 file URL 会由标准库抛错。
		return fileURLToPath(normalized);
	}

	// 其余直接返回整理后的字符串，因此 ./a 仍可能是相对路径。
	return normalized;
}

/** 把输入解析成绝对路径；例如 resolvePath("a.ts", "/work") 得到 /work/a.ts，但不跟随符号链接。 */
export function resolvePath(input: string, baseDir: string = process.cwd(), options: PathInputOptions = {}): string {
	// 输入按调用方指定的选项归一化。
	const normalized = normalizePath(input, options);
	// 基准目录使用默认归一化规则，不继承输入专用的 @ 前缀等选项。
	const normalizedBaseDir = normalizePath(baseDir);
	// 绝对输入独立解析；相对输入先接基准目录，再折叠 . 与 ..。
	return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);
}

/** 位于 cwd 内时返回相对路径，cwd 本身返回 .；目录外返回 undefined。 */
export function getCwdRelativePath(filePath: string, cwd: string): string | undefined {
	// cwd 即使以相对形式传入，也先转成绝对基准。
	const resolvedCwd = resolvePath(cwd);
	// filePath 的相对部分明确以这个 cwd 为基准，不以脚本文件所在目录为基准。
	const resolvedPath = resolvePath(filePath, resolvedCwd);
	// relative 计算从 cwd 走到目标所需的路径。
	const relativePath = relative(resolvedCwd, resolvedPath);
	// 下面把“目录自身”与“内部路径”两种情况合并判断。
	const isInsideCwd =
		// 相对路径为空表示目标就是 cwd。
		relativePath === "" ||
		// 排除父目录、以 ../ 开头的路径和跨盘等绝对结果；只做词法位置判断，不解析符号链接。
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));

	// 内部目标返回相对路径；空字符串用 || 换成 .，外部目标则返回 undefined。
	return isInsideCwd ? relativePath || "." : undefined;
}

/** 显示文件路径：cwd 内尽量用相对路径，外部用绝对路径，最后统一显示为 / 分隔。 */
export function formatPathRelativeToCwdOrAbsolute(filePath: string, cwd: string): string {
	// 先以 cwd 为基准拿到绝对形式。
	const absolutePath = resolvePath(filePath, cwd);
	// ?? 对目录外 undefined 回退绝对路径；split/join 只用于显示分隔符，不再访问文件。
	return (getCwdRelativePath(absolutePath, cwd) ?? absolutePath).split(sep).join("/");
}

/** 为路径设置当前平台支持的云同步忽略属性；macOS 调 xattr，Linux 调 setfattr，其他平台不执行工具。 */
export function markPathIgnoredByCloudSync(path: string): void {
	// 条件表达式选出本平台要写的扩展属性列表。
	const attrs =
		// darwin 是 Node 表示 macOS 的平台名。
		process.platform === "darwin"
			? // 分别面向 Dropbox 与 Apple File Provider 的忽略标记。
				["com.dropbox.ignored", "com.apple.fileprovider.ignore#P"]
			: // Linux 另用用户命名空间的扩展属性。
				process.platform === "linux"
				? // Linux 的 Dropbox 忽略属性名称。
					["user.com.dropbox.ignored"]
				: // 其他平台得到空数组，因此下面循环零次。
					[];

	// 逐条设置，不会把两个不同云同步服务的属性混成一个。
	for (const attr of attrs) {
		// macOS 与 Linux 使用的系统工具及参数不同。
		if (process.platform === "darwin") {
			// xattr -w 将属性写为 1；stdio: ignore 不把工具输出混入终端界面，返回结果未在此检查。
			spawnProcessSync("xattr", ["-w", attr, "1", path], { encoding: "utf-8", stdio: "ignore" });
		} else {
			// Linux 使用 setfattr -n 属性 -v 值；参数数组避免把路径拼成 shell 命令字符串。
			spawnProcessSync("setfattr", ["-n", attr, "-v", "1", path], { encoding: "utf-8", stdio: "ignore" });
		}
	}
}
