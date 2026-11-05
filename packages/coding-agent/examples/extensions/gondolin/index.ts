/**
 * Gondolin Tool Routing Example
 *
 * Runs pi's built-in tools inside a local Gondolin micro-VM. The host working
 * directory is mounted at /workspace in the guest. File changes under
 * /workspace write through to the host; other guest filesystem changes are
 * isolated to the VM.
 *
 * Setup:
 *   cd packages/coding-agent/examples/extensions/gondolin
 *   npm install --ignore-scripts
 *
 * Usage:
 *   cd /path/to/project
 *   pi -e /path/to/pi/packages/coding-agent/examples/extensions/gondolin
 *
 * Requirements:
 *   - Node.js >= 23.6.0 for @earendil-works/gondolin
 *   - QEMU installed (for example, `brew install qemu` on macOS)
 */

/**
 * 文件导读（Gondolin 微虚拟机工具路由示例）
 *
 * 所属与用途：本文件是 `packages/coding-agent/examples/extensions/gondolin` 扩展包的入口，
 * 演示把 pi 内置的 read/write/edit/bash/grep/find/ls 工具重定向到本地 Gondolin 微虚拟机。
 * 宿主当前工作目录以写穿（write-through）方式挂载到 guest 的 `/workspace`：
 * 对 `/workspace` 的修改会落到宿主，其他 guest 路径的修改只存在于 VM 内。
 *
 * 上游如何进入：同目录 `package.json` 声明 `pi.extensions: ["./index.ts"]`，并依赖
 * `@earendil-works/gondolin@0.14.0`。首次使用需在本目录执行 `npm install --ignore-scripts`，
 * 且机器需安装 QEMU。然后在目标项目目录运行：
 *   pi -e /path/to/pi/packages/coding-agent/examples/extensions/gondolin
 * 会话启动事件会预热 VM；之后模型调用的内置工具和用户 `!` bash 都在 VM 中执行。
 *
 * 下游依赖：`@earendil-works/gondolin` 提供 `VM` 与 `RealFSProvider`；
 * `@earendil-works/pi-coding-agent` 提供工具工厂、操作接口、截断/格式化辅助。
 * 本扩展自身不调用模型 API；工具执行和 guest 命令可能按命令内容访问网络。
 *
 * 能力清单：
 * - 路径映射：`stripAtPrefix`、`toPosix`、`isInsideHostPath`、`hostPathToGuest`、`toGuestPath`。
 * - 工具操作适配：`createGondolinReadOps`/`WriteOps`/`EditOps`/`LsOps`/`FindOps`/`BashOps`。
 * - 搜索实现：`walkGuestFiles`、`matchesToolGlob`、`createLineMatcher`、`appendGrepBlock`、
 *   `executeGondolinGrep`（自定义 grep，不经过内置 grep 的 operations 接口）。
 * - 生命周期：`startVm`、`ensureVm`、`session_start`、`session_shutdown`、`/gondolin` 状态命令。
 * - 路由：七个 `registerTool` 替换 execute，`user_bash` 钩子，`before_agent_start` 改写系统提示里的 cwd。
 *
 * 典型运行顺序：
 *   1. 安装依赖与 QEMU；
 *   2. 在项目目录启动 pi 并加载扩展；
 *   3. `session_start` 触发 `ensureVm`，状态栏出现 Gondolin；
 *   4. 模型调用工具 -> 每次 ensureVm（复用单飞 Promise）-> 通过 VM 执行；
 *   5. `/gondolin` 查看 VM id、宿主/guest 路径与 shell；
 *   6. 退出时会话关闭 VM 并清除状态。
 *
 * 示例（真实调用形状）：
 *   const vm = await VM.create({
 *     sessionLabel: "pi demo",
 *     vfs: { mounts: { "/workspace": new RealFSProvider(localCwd) } },
 *   }); // 扩展内部按此形状创建，不需要用户写
 *   await vm.fs.readFile("/workspace/src/a.ts", { encoding: "utf8" });
 * 用户侧只需让模型调用 read/bash；宿主路径会自动映射，例如 `<cwd>/src/a.ts` -> `/workspace/src/a.ts`。
 *
 * 建议阅读顺序：先看路径映射五个函数，再看各 Operations 适配器，随后看 grep 的遍历/截断，
 * 最后看默认导出的生命周期与工具注册。
 *
 * 主要边界/风险：
 * - 本文件的路径映射只做字符串判断，不解析符号链接；挂载层 `RealFSProvider` 自己会做
 *   realpath 校验，symlink 指向宿主 root 外时会被拒绝，但这是挂载层的保证，不是这些函数的。
 * - `find` 的实现忽略 `options.ignore`，只硬编码跳过 `.git` 和 `node_modules`。
 * - `grep` 把整个文件读入内存，按行匹配，且用 `Number.MAX_SAFE_INTEGER` 作为行数上限，
 *   只由 `truncateHead` 的字节预算限制输出。
 * - `ensureVm` 是单飞（single-flight）：并发调用共享同一个启动 Promise，失败后清空以便重试。
 * - 扩展假定 POSIX 风格路径；Windows 盘符路径没有专门处理。
 */

import path from "node:path";
import { RealFSProvider, VM } from "@earendil-works/gondolin";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	DEFAULT_MAX_BYTES,
	type EditOperations,
	type FindOperations,
	formatSize,
	type GrepToolDetails,
	type GrepToolInput,
	type LsOperations,
	type ReadOperations,
	truncateHead,
	truncateLine,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const GUEST_WORKSPACE = "/workspace";
const DEFAULT_GREP_LIMIT = 100;

type TextToolResult<TDetails> = {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails | undefined;
};

/**
 * 去掉工具路径参数开头的 `@`。
 *
 * 输入：任意字符串。输出：去掉一个前导 `@` 的字符串，没有则原样返回。
 * 副作用/错误：无。只去掉一个 `@`，`"@@x"` 会变成 `"@x"`。
 * 示例：`stripAtPrefix("@src/a.ts")` 返回 `"src/a.ts"`。
 */
function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

/**
 * 把宿主平台的路径分隔符统一成 POSIX `/`。
 *
 * 输入：宿主路径字符串。输出：用 `/` 分隔的字符串。
 * 副作用：无。Windows 下 `C:\a\b` -> `C:/a/b`；POSIX 下原样。
 * 注意：只替换分隔符，不改变盘符或解析语义。
 * 示例：在 Windows 上 `toPosix("src\\a.ts")` 返回 `"src/a.ts"`。
 */
function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

/**
 * 判断 `value` 是否等于 `root` 或位于其子树内（纯词法判断）。
 *
 * 输入：`root` 与 `value`，预期都是绝对路径。
 * 输出：布尔值。副作用：无。
 * 实现：用 `path.relative` 求相对路径；空串表示同一路径；以 `..` 开头或仍是绝对路径（不同盘符）
 * 表示在外部。
 * 注意：不解析 symlink，不要求 `value` 存在；大小写敏感由平台决定。
 * 边界：用 `startsWith("..")` 判断外部路径，名为 `..foo` 的 cwd 内条目也会被误判为外部。
 * 示例：`isInsideHostPath("/a/b", "/a/b/c") === true`；
 * `isInsideHostPath("/a/b", "/a/bc") === false`（相对路径是 `../bc`）。
 */
function isInsideHostPath(root: string, value: string): boolean {
	const relativePath = path.relative(root, value);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

/**
 * 把宿主 cwd 内的路径映射到 guest 的 `/workspace` 下。
 *
 * 输入：`localCwd` 宿主工作目录，`hostPath` 待映射路径。
 * 输出：子树内映射为 `/workspace[/相对路径]`；子树外返回 POSIX 化的原路径。
 * 副作用/错误：无；纯字符串运算。调用方通常先确认在子树内。
 * 示例：`hostPathToGuest("/p", "/p/src/a.ts")` 返回 `"/workspace/src/a.ts"`；
 * 等于根时返回 `"/workspace"`。
 */
function hostPathToGuest(localCwd: string, hostPath: string): string {
	const relativePath = path.relative(localCwd, hostPath);
	if (!isInsideHostPath(localCwd, hostPath)) return toPosix(hostPath);
	return relativePath ? path.posix.join(GUEST_WORKSPACE, toPosix(relativePath)) : GUEST_WORKSPACE;
}

/**
 * 把工具参数中的路径转换成 guest 路径。
 *
 * 输入：宿主 cwd 与模型/工具给出的原始路径（可带 `@`、可相对、可绝对）。
 * 输出：guest 绝对路径。
 * 副作用：无。错误路径：不会因路径不存在而报错；只做字符串解析。
 * 规则：
 * - 去掉 `@` 和首尾空白；空串 -> `/workspace`；
 * - 绝对路径在宿主 cwd 子树内 -> 映射到 `/workspace/...`；
 * - 其他绝对路径 -> 当作 guest 绝对路径（例如 `/etc/passwd` 仍是 guest 的 `/etc/passwd`）；
 * - 相对路径 -> 相对 `/workspace` 解析。
 * 注意：这意味着宿主绝对路径若在 cwd 外，不会被映射到宿主的同一位置。
 * 示例：`toGuestPath("/p", "@src/a.ts")` 返回 `"/workspace/src/a.ts"`；
 * `toGuestPath("/p", "/p/README.md")` 返回 `"/workspace/README.md"`；
 * `toGuestPath("/p", "/tmp/x")` 返回 `"/tmp/x"`（guest 内路径）。
 */
function toGuestPath(localCwd: string, inputPath: string): string {
	const trimmed = stripAtPrefix(inputPath.trim());
	if (!trimmed) return GUEST_WORKSPACE;
	if (path.isAbsolute(trimmed)) {
		if (isInsideHostPath(localCwd, trimmed)) return hostPathToGuest(localCwd, trimmed);
		return path.posix.resolve("/", toPosix(trimmed));
	}
	return path.posix.resolve(GUEST_WORKSPACE, toPosix(trimmed));
}

/**
 * 创建 read 工具所需的 VM 文件操作。
 *
 * 输入：已启动的 `vm` 与宿主 cwd。输出：`ReadOperations` 对象。
 * 副作用：无（创建对象）；实际读文件发生在工具调用时。错误由 VM 的 Promise 拒绝传播。
 * 方法：`readFile` 返回 Buffer；`access` 只做可访问性检查；`detectImageMimeType` 按扩展名推断。
 * 示例：`createGondolinReadOps(vm, "/p").readFile("/p/a.txt")` 实际读取 guest `/workspace/a.txt`。
 * 注意 MIME 只依据文件名，不读取文件头；未知扩展名返回 null。
 */
function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
	return {
		readFile: async (filePath) => vm.fs.readFile(toGuestPath(localCwd, filePath)),
		access: async (filePath) => {
			await vm.fs.access(toGuestPath(localCwd, filePath));
		},
		detectImageMimeType: async (filePath) => {
			const ext = path.posix.extname(toGuestPath(localCwd, filePath)).toLowerCase();
			if (ext === ".png") return "image/png";
			if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
			if (ext === ".gif") return "image/gif";
			if (ext === ".webp") return "image/webp";
			return null;
		},
	};
}

/**
 * 创建 write 工具所需的 VM 文件操作。
 *
 * 输入：`vm`、宿主 cwd。输出：`WriteOperations` 对象。
 * 副作用：工具调用时会写 guest 文件；若目标是 `/workspace`，由于挂载是写穿的，也会改宿主文件。
 * 错误路径：父目录不存在或 VM 拒绝写入时 Promise 拒绝。
 * `writeFile` 固定 UTF-8，不能写任意二进制；`mkdir` 使用 `recursive: true`，已存在不报错。
 * 示例：`writeFile("/p/new/a.txt", "hi")` 在 guest 写 `/workspace/new/a.txt`。
 */
function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
	return {
		writeFile: async (filePath, content) => {
			await vm.fs.writeFile(toGuestPath(localCwd, filePath), content, { encoding: "utf8" });
		},
		mkdir: async (dirPath) => {
			await vm.fs.mkdir(toGuestPath(localCwd, dirPath), { recursive: true });
		},
	};
}

/**
 * 创建 edit 工具所需操作：复用 read/write 适配器。
 *
 * 输入：`vm`、宿主 cwd。输出：`EditOperations`，包含读、写、可读性检查。
 * 副作用/错误：与底层读写相同；edit 工具自身负责“读取-替换-写回”的逻辑。
 * 示例：编辑宿主 `<cwd>/a.ts` 时，工具通过这里的 readFile/writeFile 在 guest 对应路径完成。
 */
function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
	const readOps = createGondolinReadOps(vm, localCwd);
	const writeOps = createGondolinWriteOps(vm, localCwd);
	return {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		access: readOps.access,
	};
}

/**
 * 创建 ls 工具所需的 VM 文件操作。
 *
 * 输入：`vm`、宿主 cwd。输出：`LsOperations`。
 * 副作用：只读 guest 文件系统，无写入。
 * `exists` 把 access 的拒绝（不存在、无权限）统一折成 false；`stat` 返回 VM 的 stat 对象
 * （工具只要求 `isDirectory()`）；`readdir` 返回直接子项名字，不递归。
 * 示例：`exists("/p/nope")` 返回 false 而不是抛错。
 */
function createGondolinLsOps(vm: VM, localCwd: string): LsOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(localCwd, filePath));
				return true;
			} catch {
				return false;
			}
		},
		stat: async (filePath) => vm.fs.stat(toGuestPath(localCwd, filePath)),
		readdir: async (dirPath) => vm.fs.listDir(toGuestPath(localCwd, dirPath)),
	};
}

/**
 * 递归遍历 guest 文件树，对每个非目录项调用 `visit`。
 *
 * 输入：
 * - `root`：起点 guest 路径；若是文件，只访问该文件。
 * - `visit(guestPath, relativePath)`：返回 Promise<boolean>；返回 false 表示提前停止整个遍历。
 * - `signal`：可选取消信号；每次进入目录/访问文件前检查，stat/readdir 也会接收它。
 * 输出：`Promise<boolean>`，完整遍历为 true，被 visit 提前终止为 false。
 * 副作用：只读 guest 文件系统。
 * 错误路径：signal 已中止时抛 `Error("Operation aborted")`；根 stat 失败会抛出；
 * 子项 stat 失败则静默跳过（常见于权限或竞态删除）；`visit` 的异常会传播。
 * 主要流程：检查根 -> 根是文件则 visit -> 否则递归目录；硬编码跳过 `.git` 与 `node_modules`。
 * 注意：没有符号链接循环保护，也不应用其他忽略规则；递归深度没有显式上限，
 * 极深的目录树会形成很长的 Promise 链并占用内存。
 *
 * 示例：`await walkGuestFiles(vm, "/workspace", async (p, rel) => { console.log(rel); return true; })`
 * 会打印除 `.git`/`node_modules` 外的所有文件相对路径。
 */
async function walkGuestFiles(
	vm: VM,
	root: string,
	visit: (guestPath: string, relativePath: string) => Promise<boolean>,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) throw new Error("Operation aborted");
	const stat = await vm.fs.stat(root, { signal });
	// 文件根：相对路径取 basename，直接访问一次后结束。
	if (!stat.isDirectory()) return visit(root, path.posix.basename(root));

	// 局部递归函数保留 root 的 relativeDir 初始为空串；返回值用于向上传递“停止”。
	const walkDirectory = async (dir: string, relativeDir: string): Promise<boolean> => {
		if (signal?.aborted) throw new Error("Operation aborted");
		const entries = await vm.fs.listDir(dir, { signal });
		for (const entry of entries) {
			// 只跳过名字完全等于这两个的条目；不处理其他忽略规则。
			if (entry === ".git" || entry === "node_modules") continue;
			const guestPath = path.posix.join(dir, entry);
			const relativePath = relativeDir ? path.posix.join(relativeDir, entry) : entry;
			// 显式类型标注复用了 VM.fs.stat 的返回类型；Awaited 取出 Promise 解析后的类型。
			let entryStat: Awaited<ReturnType<VM["fs"]["stat"]>>;
			try {
				entryStat = await vm.fs.stat(guestPath, { signal });
			} catch {
				// 单个条目查不到/无权限时跳过，不中断整个搜索。
				continue;
			}
			if (entryStat.isDirectory()) {
				// 子目录返回 false 时立即向上返回 false，停止剩余兄弟项。
				if (!(await walkDirectory(guestPath, relativePath))) return false;
			} else if (!(await visit(guestPath, relativePath))) {
				return false;
			}
		}
		return true;
	};

	return walkDirectory(root, "");
}

/**
 * 判断相对路径是否匹配工具的 glob 模式。
 *
 * 输入：`relativePath` 相对于搜索根的路径；`pattern` 可能含 `/`。
 * 输出：布尔值。副作用：无。
 * 规则：模式含 `/` 时先按整条相对路径匹配，再尝试自动加 `**\/` 前缀匹配任意深度；
 * 不含 `/` 时只匹配 basename（因此 `*.ts` 能命中所有目录下的文件）。
 * 注意：使用 Node 的 `path.posix.matchesGlob`，与 shell/rg 的方言可能不同；没有显式处理隐藏文件规则。
 * 示例：`matchesToolGlob("src/a.ts", "src/*.ts") === true`；
 * `matchesToolGlob("src/deep/a.ts", "*.ts") === true`（取 basename）。
 */
function matchesToolGlob(relativePath: string, pattern: string): boolean {
	const normalizedPattern = toPosix(pattern);
	if (normalizedPattern.includes("/")) {
		return (
			path.posix.matchesGlob(relativePath, normalizedPattern) ||
			path.posix.matchesGlob(relativePath, `**/${normalizedPattern}`)
		);
	}
	return path.posix.matchesGlob(path.posix.basename(relativePath), normalizedPattern);
}

/**
 * 创建 find 工具所需的 VM 操作。
 *
 * 输入：`vm`、宿主 cwd。输出：`FindOperations`。
 * 副作用：只读遍历 guest 文件系统；`glob` 返回匹配的 guest 路径数组。
 * 错误路径：根不存在时 walk 的 stat 会抛错；单个条目的 stat 错误被 walk 跳过。
 * `exists` 把 access 失败折成 false。`glob` 的 `options.ignore` 参数没有使用，
 * 只硬编码跳过 `.git`/`node_modules`；达到 `options.limit` 后停止。
 * 示例：`glob("**\/*.ts", "/p", { ignore: [], limit: 100 })` 返回最多 100 个 guest 绝对路径。
 */
function createGondolinFindOps(vm: VM, localCwd: string): FindOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(localCwd, filePath));
				return true;
			} catch {
				return false;
			}
		},
		glob: async (pattern, cwd, options) => {
			const root = toGuestPath(localCwd, cwd);
			const results: string[] = [];
			await walkGuestFiles(vm, root, async (guestPath, relativePath) => {
				if (results.length >= options.limit) return false;
				if (matchesToolGlob(relativePath, pattern)) results.push(guestPath);
				// 达到上限后返回 false，让 walk 提前停止。
				return results.length < options.limit;
			});
			return results;
		},
	};
}

/**
 * 根据 grep 参数创建“一行是否匹配”的判定函数。
 *
 * 输入：`pattern`、`literal`（true 表示按字面量）、`ignoreCase`。
 * 输出：`(line: string) => boolean`。
 * 副作用：无。错误路径：`literal` 为假时 `new RegExp(pattern)` 在模式非法时抛 SyntaxError；
 * 该错误不会被本函数捕获，会中止整个 grep。
 * 字面量模式通过 `includes` 判断；忽略大小写时两边都转小写。
 * 示例：`createLineMatcher("foo", true, false)("xfoo") === true`；
 * `createLineMatcher("^foo", false, false)("foobar") === true`。
 */
function createLineMatcher(pattern: string, literal: boolean | undefined, ignoreCase: boolean | undefined) {
	if (literal) {
		const needle = ignoreCase ? pattern.toLowerCase() : pattern;
		return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
	}
	const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
	return (line: string) => regex.test(line);
}

/**
 * 把一次匹配及其上下文行追加到输出数组。
 *
 * 输入对象：`outputLines`（累积输出）、`lines`（当前文件按行拆分）、`relativePath`（展示用路径）、
 * `lineIndex`（匹配行的 0 基下标）、`contextLines`（前后各取多少行）。
 * 输出：布尔值，表示本块是否有行被 `truncateLine` 截断。
 * 副作用：原地 push 到 `outputLines`；不修改 `lines`。
 * 错误路径：索引越界用 `?? ""` 兜底；不会抛错。
 * 格式：匹配行用 `path:行号: 内容`，上下文行用 `path-行号- 内容`，行号从 1 开始。
 * 注意：同一文件多个匹配的上下文块会重复输出，不做合并。
 * 示例：对 `lines=["a","hit","b"]`、lineIndex=1、context=1，输出三行，中间用冒号，上下用短横线。
 */
function appendGrepBlock(params: {
	outputLines: string[];
	lines: string[];
	relativePath: string;
	lineIndex: number;
	contextLines: number;
}): boolean {
	let linesTruncated = false;
	// start/end 都夹在文件行范围内；contextLines 为 0 时只输出匹配行。
	const start = params.contextLines > 0 ? Math.max(0, params.lineIndex - params.contextLines) : params.lineIndex;
	const end =
		params.contextLines > 0
			? Math.min(params.lines.length - 1, params.lineIndex + params.contextLines)
			: params.lineIndex;

	for (let index = start; index <= end; index++) {
		const rawLine = params.lines[index] ?? "";
		// 再次去掉剩余 CR（文件可能混合 CRLF/CR）；truncateLine 按单行字符预算截断。
		const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ""));
		if (wasTruncated) linesTruncated = true;
		const separator = index === params.lineIndex ? ":" : "-";
		params.outputLines.push(`${params.relativePath}${separator}${index + 1}${separator} ${text}`);
	}
	return linesTruncated;
}

/**
 * 在 guest 文件系统中执行 grep，并返回与内置 grep 工具相同形状的结果。
 *
 * 输入：
 * - `vm`、`localCwd`：VM 与宿主 cwd，用于路径映射。
 * - `params`：`GrepToolInput`，含 `pattern`、可选 `path`/`glob`/`literal`/`ignoreCase`/`context`/`limit`。
 * - `signal`：取消信号，贯穿 stat/read/遍历/逐行匹配。
 * 输出：`{ content: [{ type: "text", text }], details }`；无匹配时 text 为 `No matches found`。
 * 副作用：只读 guest 文件系统；不写文件。
 * 错误路径：根路径 stat 失败、正则非法、signal 中止会抛错；单个文件读取失败或 stat 失败则跳过；
 * 结果只按字节预算截断，截断信息写入 details 和末尾提示。
 * 主要流程：解析根 -> 建匹配器 -> 遍历文件 -> glob 过滤 -> 读 UTF-8 -> 规范换行 -> 逐行匹配 ->
 * 追加上下文 -> 达到匹配上限停止 -> 汇总输出并用 `truncateHead` 限制字节。
 * 注意：`maxLines` 设为 `Number.MAX_SAFE_INTEGER`，所以行数不设限，只有默认字节预算生效；
 * 若某行匹配，上下文行也会一并输出但不计入 `matchCount`。
 *
 * 示例：`executeGondolinGrep(vm, "/p", { pattern: "TODO", path: "src", context: 1, limit: 10 })`
 * 返回最多 10 个匹配块；details 可能包含 `{ matchLimitReached: 10 }` 等字段。
 */
async function executeGondolinGrep(
	vm: VM,
	localCwd: string,
	params: GrepToolInput,
	signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
	const root = toGuestPath(localCwd, params.path ?? ".");
	const rootStat = await vm.fs.stat(root, { signal });
	// 记住根是文件还是目录，决定输出路径使用相对路径还是 basename。
	const rootIsDirectory = rootStat.isDirectory();
	const matcher = createLineMatcher(params.pattern, params.literal, params.ignoreCase);
	// 负数/0 视为无上下文；未提供也是 0。
	const contextLines = params.context && params.context > 0 ? params.context : 0;
	// limit 至少为 1；未提供时用默认 100。
	const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const outputLines: string[] = [];
	const details: GrepToolDetails = {};
	// 三个状态分别记录：匹配数、是否因上限停止、是否有单行被截断。
	let matchCount = 0;
	let matchLimitReached = false;
	let linesTruncated = false;

	await walkGuestFiles(
		vm,
		root,
		async (guestPath, relativePath) => {
			if (matchCount >= effectiveLimit) return false;
			// glob 只过滤文件；目录遍历本身不按 glob 剪枝。
			if (params.glob && !matchesToolGlob(relativePath, params.glob)) return true;
			let content: string;
			try {
				// 整个文件一次性读入 UTF-8；大文件会占用相应内存。
				content = await vm.fs.readFile(guestPath, { encoding: "utf8", signal });
			} catch {
				// 无权限、竞态删除、VM 错误等读取失败按“无匹配”跳过，不终止搜索。
				return true;
			}
			// 先统一 CRLF 和单独 CR，再按 LF 拆分；末尾换行会产生一个空行。
			const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			// 搜索根是文件时只显示文件名；是目录时显示相对路径。
			const displayPath = rootIsDirectory ? relativePath : path.posix.basename(guestPath);
			for (let index = 0; index < lines.length; index++) {
				if (signal?.aborted) throw new Error("Operation aborted");
				if (!matcher(lines[index] ?? "")) continue;
				matchCount++;
				if (appendGrepBlock({ outputLines, lines, relativePath: displayPath, lineIndex: index, contextLines })) {
					linesTruncated = true;
				}
				if (matchCount >= effectiveLimit) {
					matchLimitReached = true;
					// 达到上限立即停止遍历；注意此时 output 可能含有超出 limit 的上下文行。
					return false;
				}
			}
			return true;
		},
		signal,
	);

	if (matchCount === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

	const rawOutput = outputLines.join("\n");
	// 只限制总字节（默认 DEFAULT_MAX_BYTES），不限制行数。
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	const notices: string[] = [];
	let output = truncation.content;

	if (matchLimitReached) {
		details.matchLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} matches limit reached`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push("long lines truncated");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	// 只有确实发生截断/限流时才追加方括号提示，避免普通结果多出噪声。
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

	return {
		content: [{ type: "text", text: output }],
		// 没有任何详情时保持 details 为 undefined，与内置工具约定一致。
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

/**
 * 把 Node 的环境变量字典转换成只含字符串的普通对象。
 *
 * 输入：`NodeJS.ProcessEnv`（值可能为 undefined）或 undefined。
 * 输出：`Record<string, string>` 或 undefined。副作用：无。
 * 该函数是运行时边界：过滤掉值为 undefined 的键，满足 VM exec 的 env 类型。
 * 示例：`sanitizeEnv({ A: "1", B: undefined })` 返回 `{ A: "1" }`；输入 undefined 返回 undefined。
 */
function sanitizeEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
	if (!env) return undefined;
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") result[key] = value;
	}
	return result;
}

/**
 * 创建 bash 工具所需的 VM 执行操作。
 *
 * 输入：`vm`、宿主 cwd、guest 中探测到的 shell 路径。
 * 输出：`BashOperations`，其中 `exec` 在 guest 中运行命令。
 * 副作用：执行任意 shell 命令；可能写 guest（`/workspace` 会写穿到宿主）、启动进程、访问网络。
 * 错误路径：signal 已中止时立刻抛 `"aborted"`；超时抛 `"timeout:<秒>"`；其他 VM 错误原样传播。
 * 退出码：成功时返回 `{ exitCode }`；非零退出码不抛错，由工具层决定如何展示。
 * 主要流程：映射 cwd -> 把外部 signal 与超时都接到内部 AbortController -> 启动
 * `[shellPath, "-lc", command]` -> 流式转发输出 -> await 进程结果 -> 清理定时器与监听器。
 * 注意：`timeout` 单位是秒，内部乘 1000 转毫秒；外部 signal 的 abort 会中止 VM 进程。
 * `-l` 让 shell 作为登录 shell 读取 profile；`-c` 执行传入命令。
 *
 * 示例：`createGondolinBashOps(vm, "/p", "/bin/bash").exec("echo hi", "/p", {...})`
 * 在 guest `/workspace` 执行并返回 `{ exitCode: 0 }`；输出通过 `onData` 分块交付。
 */
function createGondolinBashOps(vm: VM, localCwd: string, shellPath: string): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			// 工具层可能已经取消；不要启动进程。
			if (signal?.aborted) throw new Error("aborted");
			const guestCwd = toGuestPath(localCwd, cwd);
			// 内部 controller 统一承载“外部取消”和“超时”两种中止来源。
			const controller = new AbortController();
			const onAbort = () => controller.abort();
			// `{ once: true }` 让监听器在首次触发后自动移除；finally 仍会再移除一次（无害）。
			signal?.addEventListener("abort", onAbort, { once: true });

			let timedOut = false;
			// 只有正数超时才设置定时器；Node 的 setTimeout 以毫秒计。
			const timer =
				timeout && timeout > 0
					? setTimeout(() => {
							timedOut = true;
							controller.abort();
						}, timeout * 1000)
					: undefined;

			try {
				const proc = vm.exec([shellPath, "-lc", command], {
					cwd: guestCwd,
					env: sanitizeEnv(env),
					signal: controller.signal,
					stdout: "pipe",
					stderr: "pipe",
				});
				// `output()` 是异步可迭代对象，chunk.data 是 Buffer/字节块；stdout 与 stderr 都走这里。
				for await (const chunk of proc.output()) onData(chunk.data);
				const result = await proc;
				return { exitCode: result.exitCode };
			} catch (error) {
				// 优先报告外部取消；否则区分超时；其余错误保持原样。
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				throw error;
			} finally {
				// 无论成功失败都清理定时器与监听器，避免泄漏。
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}

/**
 * 扩展默认导出：创建 VM、路由内置工具，并注册会话生命周期钩子。
 *
 * 输入：`pi` 扩展 API。输出：无返回值。
 * 副作用：注册事件/命令/工具；在会话启动或首次使用时创建微 VM 并挂载宿主 cwd；
 * 会话结束时关闭 VM。工具调用可能读写宿主 `/workspace` 对应的文件、执行任意命令。
 * 错误路径：VM 创建失败会通过 `ensureVm` 的 Promise 传给调用者；`session_start` 没有本地
 * catch，错误由扩展运行器处理；工具执行的错误由工具链反馈给模型。
 * 主要流程：记录启动时的 cwd -> 创建本地工具副本用于元数据 -> 定义单飞 ensureVm ->
 * 注册 session_start/shutdown、/gondolin、七个工具、user_bash 与 before_agent_start。
 *
 * 示例：在 `/p` 启动 pi 并加载扩展后，模型调用 read `<cwd>/a.ts` 实际读取 guest
 * `/workspace/a.ts`；`!pwd` 由 guest shell 返回 `/workspace`。
 */
export default function (pi: ExtensionAPI) {
	const localCwd = process.cwd();
	// 这些本地工具实例只用于复用 name/label/description/parameters 等定义；execute 会被替换。
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	const localGrep = createGrepTool(localCwd);
	const localFind = createFindTool(localCwd);
	const localLs = createLsTool(localCwd);

	// 单例 VM 与启动中的 Promise；`vm` 为空但 `vmStarting` 非空表示正在启动。
	let vm: VM | undefined;
	let vmStarting: Promise<VM> | undefined;
	// 初始化时先假设 /bin/sh；startVm 探测到 bash 后替换。
	let shellPath = "/bin/sh";

	/**
	 * 真正创建并挂载 VM（内部函数，由 ensureVm 调用）。
	 *
	 * 输入：可选扩展上下文，用于状态栏和通知。
	 * 输出：创建成功的 `VM`。
	 * 副作用：启动微 VM；把宿主 `localCwd` 以写穿方式挂载到 guest `/workspace`；
	 * 在 guest 中执行 `command -v bash`；更新状态栏/通知。
	 * 错误路径：`VM.create` 或探测命令失败时 Promise 拒绝；函数没有回滚逻辑，若 `VM.create`
	 * 已成功而探测失败，这个已创建的 VM 不会被关闭，`vm` 也尚未赋值。
	 * 流程：状态“starting” -> 创建 VM -> 探测 bash -> 保存 shellPath -> 保存 vm -> 状态/通知。
	 *
	 * 示例：`await startVm(ctx)` 后 `vm.id` 可用，`shellPath` 可能是 `/usr/bin/bash` 或 `/bin/sh`。
	 * 探测命令带 `|| true`，因此 bash 不存在时不会因非零退出码失败。
	 */
	async function startVm(ctx?: ExtensionContext): Promise<VM> {
		ctx?.ui.setStatus("gondolin", ctx.ui.theme.fg("accent", `Gondolin: starting ${GUEST_WORKSPACE}`));
		const created = await VM.create({
			// 会话标签只用于展示/诊断，不参与路径映射。
			sessionLabel: `pi ${path.basename(localCwd)}`,
			vfs: {
				mounts: {
					// 键是 guest 路径；RealFSProvider 把读写转发到宿主 localCwd。
					[GUEST_WORKSPACE]: new RealFSProvider(localCwd),
				},
			},
		});
		// 探测 guest 是否有 bash；`-l` 登录 shell，`-c` 执行命令。
		const bashProbe = await created.exec(["/bin/sh", "-lc", "command -v bash || true"]);
		// 空输出（没有 bash）时回退 /bin/sh。
		shellPath = bashProbe.stdout.trim() || "/bin/sh";
		vm = created;
		// 状态栏只显示 id 前 8 位，避免过长。
		ctx?.ui.setStatus(
			"gondolin",
			ctx.ui.theme.fg("accent", `Gondolin: ${created.id.slice(0, 8)} (${GUEST_WORKSPACE})`),
		);
		ctx?.ui.notify(`Gondolin VM ready. ${localCwd} is mounted at ${GUEST_WORKSPACE}.`, "info");
		return created;
	}

	/**
	 * 确保 VM 已启动；并发调用共享同一个启动 Promise（单飞）。
	 *
	 * 输入：可选扩展上下文，仅首次启动时用于 UI 状态。
	 * 输出：`Promise<VM>`。
	 * 副作用：可能触发 `startVm`；不重复创建。
	 * 错误路径：启动失败时 Promise 拒绝；`finally` 会清空 `vmStarting`，之后可重试。
	 * 主要流程：已有 vm 直接返回 -> 没有启动中的 Promise 则创建 -> 返回该 Promise。
	 *
	 * 示例：两个工具同时调用 `ensureVm()` 时，只会执行一次 `VM.create`，两者 await 同一结果。
	 * 注意：`startVm` 内部先设置 `vm`，再返回；`finally` 清空的是 `vmStarting`，不影响已创建的 vm。
	 */
	async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
		if (vm) return vm;
		if (!vmStarting) {
			vmStarting = startVm(ctx).finally(() => {
				vmStarting = undefined;
			});
		}
		return vmStarting;
	}

	// 会话启动时预热 VM；未捕获的错误会交给扩展运行器，工具首次调用时仍会再次 ensureVm。
	pi.on("session_start", async (_event, ctx) => {
		await ensureVm(ctx);
	});

	// 会话关闭：先清空模块引用，防止新调用复用正在关闭的 VM，再关闭实际实例。
	// 若此时仍有 startVm 在途，这里没有等待它；其成功回调之后仍可能把 vm 重新赋值。
	pi.on("session_shutdown", async (_event, ctx) => {
		const activeVm = vm;
		vm = undefined;
		vmStarting = undefined;
		if (!activeVm) return;
		ctx.ui.setStatus("gondolin", ctx.ui.theme.fg("muted", "Gondolin: stopping"));
		try {
			await activeVm.close();
		} finally {
			// 即使 close 失败也清除状态栏，避免残留 “stopping”。
			ctx.ui.setStatus("gondolin", undefined);
		}
	});

	// `/gondolin` 展示当前 VM 信息；没有 VM 时会等待启动（可能触发创建）。
	pi.registerCommand("gondolin", {
		description: "Show Gondolin VM status",
		handler: async (_args, ctx) => {
			const activeVm = await ensureVm(ctx);
			ctx.ui.notify(
				[
					`Gondolin VM: ${activeVm.id}`,
					`Host workspace: ${localCwd}`,
					`Guest workspace: ${GUEST_WORKSPACE}`,
					`Shell: ${shellPath}`,
				].join("\n"),
				"info",
			);
		},
	});

	// read/write/edit/bash/ls/find 六个工具使用同一模式：用 `...localX` 继承内置工具的名称/schema/描述，
	// 只替换 execute，在调用时创建指向 GUEST_WORKSPACE 的新工具并注入 VM operations。
	// 这样模型看到的工具契约与内置工具一致，实际文件访问落在 guest。grep 在下面单独处理。
	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createReadTool(GUEST_WORKSPACE, {
				operations: createGondolinReadOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	// write 的内容固定按 UTF-8 写入 guest；写 /workspace 时会同步落到宿主。
	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createWriteTool(GUEST_WORKSPACE, {
				operations: createGondolinWriteOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	// edit 复用 read/write 适配器，先读后写；替换匹配逻辑仍由内置 edit 工具实现。
	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createEditTool(GUEST_WORKSPACE, {
				operations: createGondolinEditOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	// bash 的 command/cwd/timeout 由内置工具解析，实际进程启动在 createGondolinBashOps。
	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createBashTool(GUEST_WORKSPACE, {
				operations: createGondolinBashOps(activeVm, localCwd, shellPath),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	// ls 只读取 guest 目录结构；不存在/无权限统一折成 false 或由 stat 拒绝。
	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createLsTool(GUEST_WORKSPACE, {
				operations: createGondolinLsOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	// find 用自定义 glob 遍历 guest；忽略 .git/node_modules，未使用 ignore 参数。
	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createFindTool(GUEST_WORKSPACE, {
				operations: createGondolinFindOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	// grep 完全替换 execute，不使用内置 grep 的 operations；由 executeGondolinGrep 自行遍历/匹配。
	pi.registerTool({
		...localGrep,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			return executeGondolinGrep(activeVm, localCwd, params, signal);
		},
	});

	// 用户在交互界面用 `!` 执行 bash 时，宿主通过此钩子取执行后端；这里也路由到 VM。
	pi.on("user_bash", async (_event, ctx) => {
		const activeVm = await ensureVm(ctx);
		return { operations: createGondolinBashOps(activeVm, localCwd, shellPath) };
	});

	// 系统提示里原本写的是宿主 cwd；工具实际在 guest 运行，因此启动前把 cwd 行改成 /workspace。
	pi.on("before_agent_start", async (event, ctx) => {
		await ensureVm(ctx);
		const localLine = `Current working directory: ${localCwd}`;
		const guestLine = `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM; host workspace mounted from ${localCwd})`;
		// 只替换第一次出现的精确行；若宿主没有该行（版本差异），则以空行分隔追加。
		const systemPrompt = event.systemPrompt.includes(localLine)
			? event.systemPrompt.replace(localLine, guestLine)
			: `${event.systemPrompt}\n\n${guestLine}`;
		return { systemPrompt };
	});
}
