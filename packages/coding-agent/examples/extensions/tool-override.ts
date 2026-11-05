/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是覆盖内置工具。
 * 上游：宿主通过 `pi -e ./tool-override.ts` 加载；模型调用 read 工具时进入这里。
 * 下游：使用与内置工具相同的 name "read" 覆盖内置实现；日志写到 getAgentDir() 下的
 * read-access.log（通常位于用户级 agent 目录），实际读取使用 node:fs/promises。
 * /read-log 命令读取同一日志并显示最近 20 条。
 *
 * 演示的机制：同名注册会让扩展工具替换内置 read；不提供 renderCall/renderResult 时
 * 宿主沿用内置渲染器（语法高亮、行号、截断提示）。示例通过正则阻止敏感路径，并用
 * withFileMutationQueue 串行化同一日志文件的追加，避免并发写交错。
 *
 * 能力清单：
 * - LOG_FILE：访问日志绝对路径。
 * - BLOCKED_PATTERNS：敏感文件名/目录的正则列表。
 * - isBlockedPath(path)：任一正则命中即阻止。
 * - logAccess(path, allowed, reason?)：异步追加一行日志，失败被吞掉。
 * - readSchema：与内置 read 兼容的 path/offset/limit 参数 schema。
 * - 默认导出：注册覆盖版 read 和 /read-log 命令。
 *
 * 典型运行顺序：加载扩展 -> 模型读取普通文件（成功并写 ALLOWED 日志）-> 模型读取 .env
 * （被拒绝并写 BLOCKED 日志）-> 用户输入 /read-log 查看最近记录。
 *
 * 示例（真实签名）：
 *   pi.registerTool({ name: "read", label: "read (audited)", description: "...",
 *     parameters: readSchema, async execute(...) { ... } });
 *   同名覆盖只影响本会话的工具表；不修改磁盘上的内置工具实现。
 *
 * 建议阅读顺序：先看 BLOCKED_PATTERNS 与 isBlockedPath，再看 logAccess 的串行写入，
 * 最后看 execute 的阻止/读取/截断三条路径。
 *
 * 前置条件：示例会读取真实文件并写日志文件（副作用）；日志目录需可写，写失败被忽略。
 * 参数校验由 schema 完成，execute 内仍把错误转成文本而不是抛异常。
 */

/**
 * Tool Override Example - Demonstrates overriding built-in tools
 *
 * Extensions can register tools with the same name as built-in tools to replace them.
 * This is useful for:
 * - Adding logging or auditing to tool calls
 * - Implementing access control or sandboxing
 * - Routing tool calls to remote systems (e.g., pi-ssh-remote)
 * - Modifying tool behavior for specific workflows
 *
 * This example overrides the `read` tool to:
 * 1. Log all file access to a log file
 * 2. Block access to sensitive paths (e.g., .env files)
 * 3. Delegate to the original read implementation for allowed files
 *
 * Since no custom renderCall/renderResult are provided, the built-in renderer
 * is used automatically (syntax highlighting, line numbers, truncation warnings).
 *
 * Usage:
 *   pi -e ./tool-override.ts
 */

import type { TextContent } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { constants, readFileSync } from "fs";
import { access, appendFile, readFile } from "fs/promises";
import { join, resolve } from "path";
import { Type } from "typebox";

// 日志位置由宿主配置决定（PI_AGENT_DIR 可覆盖），不是当前项目目录。
const LOG_FILE = join(getAgentDir(), "read-access.log");

// Paths that are blocked from reading
// 正则列表只匹配路径文本；它不知道符号链接指向哪里，也不是完整的沙箱策略。
const BLOCKED_PATTERNS = [
	/\.env$/,
	/\.env\..+$/,
	/secrets?\.(json|yaml|yml|toml)$/i,
	/credentials?\.(json|yaml|yml|toml)$/i,
	/\/\.ssh\//,
	/\/\.aws\//,
	/\/\.gnupg\//,
];

// 判断路径文本是否命中任一正则；some 遇到第一个 true 即停止。
function isBlockedPath(path: string): boolean {
	return BLOCKED_PATTERNS.some((pattern) => pattern.test(path));
}

// 追加一条访问记录：成功/阻止都写，日志失败不影响工具主流程（错误被 catch 吞掉）。
async function logAccess(path: string, allowed: boolean, reason?: string) {
	// ISO 8601 UTC 时间戳，便于排序。
	const timestamp = new Date().toISOString();
	// 三元表达式把布尔值映射成日志状态词。
	const status = allowed ? "ALLOWED" : "BLOCKED";
	// 可选原因放在括号内；无原因时为空串。
	const msg = reason ? ` (${reason})` : "";
	// 末尾加 \n，appendFile 才能一次写完整行。
	const line = `[${timestamp}] ${status}: ${path}${msg}\n`;

	try {
		// withFileMutationQueue 按文件串行化写操作，避免多个工具并发时行交错。
		await withFileMutationQueue(LOG_FILE, async () => {
			// appendFile 在文件不存在时创建；编码默认 utf8。
			await appendFile(LOG_FILE, line);
		});
	} catch {
		// Ignore logging errors
		// 日志是辅助功能：磁盘只读或权限不足不应让文件读取失败。
	}
}

// 与内置 read 的参数保持兼容：path 必填，offset/limit 可选；Type.Optional 允许属性缺失。
const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

// 扩展入口：用同名 read 覆盖内置工具，并额外注册日志查看命令。
export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "read", // Same name as built-in - this will override it
		label: "read (audited)",
		// description 告诉模型敏感路径会被拒绝，减少无意义重试。
		description:
			"Read the contents of a file with access logging. Some sensitive paths (.env, secrets, credentials) are blocked.",
		parameters: readSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// 解构出三个字段；offset/limit 类型是 number | undefined。
			const { path, offset, limit } = params;
			// 相对路径按当前会话 cwd 解析；path.resolve 对绝对路径原样返回。
			const absolutePath = resolve(ctx.cwd, path);

			// Check if path is blocked
			// 先检查阻止列表，命中时不读取任何内容，但仍写日志。
			if (isBlockedPath(absolutePath)) {
				await logAccess(absolutePath, false, "matches blocked pattern");
				return {
					content: [
						{
							type: "text",
							text: `Access denied: "${path}" matches a blocked pattern (sensitive file). This tool blocks access to .env files, secrets, credentials, and SSH/AWS/GPG directories.`,
						},
					],
					// details 里的标记可供渲染器或后续逻辑识别阻止结果。
					details: { blocked: true },
				};
			}

			// Log allowed access
			// 注意：先记 ALLOWED 再尝试读取；实际读取失败时日志已经写成允许，这不是审计上的强保证。
			await logAccess(absolutePath, true);

			// Perform the actual read (simplified implementation)
			try {
				// access 以 R_OK 检查可读权限；不可读时抛错进入 catch。
				await access(absolutePath, constants.R_OK);
				// 整文件读入内存再按行切分；大文件可能占用较多内存。
				const content = await readFile(absolutePath, "utf-8");
				const lines = content.split("\n");

				// Apply offset and limit
				// offset 是 1-based，数组下标要减 1；Math.max 防止 0/负数产生负下标。
				const startLine = offset ? Math.max(0, offset - 1) : 0;
				// 没有 limit 时结束位置就是数组长度；有则从起点加行数。
				const endLine = limit ? startLine + limit : lines.length;
				// slice 的结束下标不包含在结果中，符合“读 limit 行”的直觉。
				const selectedLines = lines.slice(startLine, endLine);

				// Basic truncation (50KB limit)
				// 先拼成全文，再按 UTF-8 字节数判断是否超过 50KB。
				let text = selectedLines.join("\n");
				const maxBytes = 50 * 1024;
				if (Buffer.byteLength(text, "utf-8") > maxBytes) {
					// 直接 slice 字符可能截断多字节字符；这里只是示例的近似截断，内置工具会更严谨。
					text = `${text.slice(0, maxBytes)}\n\n[Output truncated at 50KB]`;
				}

				return {
					// as TextContent[] 把字面量数组断言成内容块类型，满足结果结构。
					content: [{ type: "text", text }] as TextContent[],
					// details 记录原始总行数，便于渲染器展示范围。
					details: { lines: lines.length },
				};
			} catch (error: any) {
				// 示例用 any 读取 error.message；生产代码应判断 error instanceof Error。
				return {
					content: [{ type: "text", text: `Error reading file: ${error.message}` }] as TextContent[],
					details: { error: true },
				};
			}
		},

		// No renderCall/renderResult - uses built-in renderer automatically
		// (syntax highlighting, line numbers, truncation warnings, etc.)
	});

	// Also register a command to view the access log
	// /read-log 同步读取日志；文件不存在或读取失败时提示没有日志。
	pi.registerCommand("read-log", {
		description: "View the file access log",
		handler: async (_args, ctx) => {
			try {
				// readFileSync 阻塞事件循环，但日志文件通常很小；这里作为简化示例。
				const log = readFileSync(LOG_FILE, "utf-8");
				// trim 去掉尾部空行，split 后取最后 20 条。
				const lines = log.trim().split("\n").slice(-20); // Last 20 entries
				ctx.ui.notify(`Recent file access:\n${lines.join("\n")}`, "info");
			} catch {
				ctx.ui.notify("No access log found", "info");
			}
		},
	});
}
