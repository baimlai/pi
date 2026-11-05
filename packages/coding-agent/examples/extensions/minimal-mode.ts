// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：演示如何用 registerTool 覆盖内置工具的渲染函数，实现“minimal 模式”：折叠时不显示输出
//   （read/bash/write/edit）或只显示计数（find/grep/ls），展开时显示完整输出。
// 上游：`pi -e ./minimal-mode.ts` 加载；宿主在执行工具和绘制工具行时调用下面注册的定义。
// 下游：create*ToolDefinition(cwd) 生成真正的工具实现（execute/parameters 等），本文件只替换
//   renderCall/renderResult；@earendil-works/pi-tui 的 Text 负责终端文本组件。不改变工具行为或结果。
// 能力：
//   shortenPath()          把 home 目录替换成 ~。
//   createBuiltInTools()   用当前 cwd 创建七个内置工具定义。
//   默认导出函数            注册七个带自定义渲染的工具。
// 运行：加载后正常使用工具，ctrl+o 在折叠（minimal）与展开（完整输出）之间切换。
// 示例：折叠状态下 bash 只显示 `$ command`，展开后显示命令输出。
// 阅读顺序：先看 shortenPath/createBuiltInTools，再任选一个工具块看 renderCall（折叠时也显示）与
//   renderResult（由 expanded 决定内容）；其余工具结构相同。

/**
 * Minimal Mode Example - Demonstrates a "minimal" tool display mode
 *
 * This extension overrides built-in tools to provide custom rendering:
 * - Collapsed mode: Only shows the tool call (command/path), no output
 * - Expanded mode: Shows full output like the built-in renderers
 *
 * This demonstrates how a "minimal mode" could work, where ctrl+o cycles through:
 * - Standard: Shows truncated output (current default)
 * - Expanded: Shows full output (current expanded)
 * - Minimal: Shows only tool call, no output (this extension's collapsed mode)
 *
 * Usage:
 *   pi -e ./minimal-mode.ts
 *
 * Then use ctrl+o to toggle between minimal (collapsed) and full (expanded) views.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	formatReadLineRange,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "os";

// 把 home 目录前缀替换成 ~，其余路径原样返回。输入/输出都是字符串，无副作用。
// 只是字符串前缀替换，不解析符号链接或规范化 ..；示例：/Users/me/a.ts -> ~/a.ts。
/**
 * Shorten a path by replacing home directory with ~
 */
function shortenPath(path: string): string {
	// homedir() 每次调用都读当前运行用户的 home 路径，不在模块加载时固化。
	const home = homedir();
	// startsWith 为真时 slice(home.length) 去掉 home 本身，再拼上 ~。
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	// 不在 home 下就原样返回。
	return path;
}

// 用给定工作目录创建七个内置工具定义的普通对象。输入：cwd；输出：以工具名为键的对象。
// 副作用：这些 create* 工厂通常只构造定义/捕获 cwd，不执行工具；具体参数由 execute 时处理。
// 示例：createBuiltInTools("/repo").read 可展开到 registerTool 中，仅替换渲染器。
function createBuiltInTools(cwd: string) {
	// 对象字面量的键名与工具名一致，便于下面 tools.read 展开；每个值都是完整 ToolDefinition。
	return {
		read: createReadToolDefinition(cwd),
		bash: createBashToolDefinition(cwd),
		edit: createEditToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
	};
}

// 扩展入口。输入：宿主 ExtensionAPI；输出：无；副作用是注册七个工具定义。
// 工具在加载时按 process.cwd() 创建；如果会话之后切换工作目录，这里的路径基准不会自动更新。
// 示例：加载本扩展后执行 read 工具，折叠行只显示路径与行范围，展开才显示文件内容。
export default function (pi: ExtensionAPI) {
	// 先构造内置工具，后面每个 registerTool 通过展开复用它们的 parameters/execute。
	const tools = createBuiltInTools(process.cwd());

	// =========================================================================
	// Read Tool
	// =========================================================================
	// 展开 tools.read 保留工具名、参数 schema、execute 等；后面同名的 renderCall/renderResult 覆盖原渲染。
	pi.registerTool({
		...tools.read,

		renderCall(args, theme, _context) {
			// renderCall 渲染“工具被调用”这一行；args 已按工具参数 schema 推导出类型，
			// || "" 是运行时的兜底写法，正常调用中 path 是必填字符串。
			// args.path 由 schema 保证存在，这里的 || "" 只是给可能缺省值兜底；再交给 shortenPath。
			const path = shortenPath(args.path || "");
			// 三元表达式选择有路径时的 accent 色文本，或占位省略号；let 因为下面可能要追加行范围。
			let pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");

			// formatReadLineRange 把 offset/limit 转成 " (L10-20)" 之类的展示文字；没有时返回空字符串。
			const lineRange = formatReadLineRange(args.offset, args.limit);
			if (lineRange) {
				pathDisplay += theme.fg("warning", lineRange);
			}

			// toolTitle 加粗工具名，后面拼接路径；Text 的另两个参数是左右/上下留白。
			return new Text(`${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			// Minimal mode: show nothing in collapsed state
			// expanded 由宿主的视图状态决定；折叠时返回空 Text，占位但不显示正文。
			if (!expanded) {
				return new Text("", 0, 0);
			}

			// Expanded mode: show full output
			// content 是 TextContent | ImageContent 的联合数组；find 找第一个文字块。
			const textContent = result.content.find((c) => c.type === "text");
			// find 的返回类型仍是联合；显式再判断 type 完成收窄，否则不能安全读 .text。
			if (!textContent || textContent.type !== "text") {
				return new Text("", 0, 0);
			}

			// 按换行切分后给每一行套 toolOutput 颜色，再拼回多行字符串；ANSI 样式不改变换行结构。
			const lines = textContent.text.split("\n");
			const output = lines.map((line) => theme.fg("toolOutput", line)).join("\n");
			// 前缀 \n 与调用行分开；Text 会按给定宽度处理换行。
			return new Text(`\n${output}`, 0, 0);
		},
	});

	// =========================================================================
	// Bash Tool
	// =========================================================================
	// 与 read 相同：保留 tools.bash 的实现，只换渲染。折叠时调用行仍有信息，结果行返回空。
	pi.registerTool({
		...tools.bash,

		renderCall(args, theme, _context) {
			// command 在 schema 中是必填，这里的 || "..." 只是展示兜底。
			const command = args.command || "...";
			// as number | undefined 是编译期断言：运行时不检查 timeout 是否真是数字。
			const timeout = args.timeout as number | undefined;
			// timeout 为真时才生成弱化后缀；0 会被当成没有超时。
			const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";

			// 用 "$ command" 的 shell 习惯展示调用；+ 连接带色前缀与可选超时。
			return new Text(theme.fg("toolTitle", theme.bold(`$ ${command}`)) + timeoutSuffix, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			// Minimal mode: show nothing in collapsed state
			if (!expanded) {
				return new Text("", 0, 0);
			}

			// Expanded mode: show full output
			const textContent = result.content.find((c) => c.type === "text");
			if (!textContent || textContent.type !== "text") {
				return new Text("", 0, 0);
			}

			// trim 去掉命令输出首尾空白，避免折叠/展开时多出空行；逐行着色再拼回。
			const output = textContent.text
				.trim()
				.split("\n")
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");

			// 全是空白时等同于没有输出，返回空组件。
			if (!output) {
				return new Text("", 0, 0);
			}

			return new Text(`\n${output}`, 0, 0);
		},
	});

	// =========================================================================
	// Write Tool
	// =========================================================================
	// write 的折叠态不显示结果（文件写入本身没有可读输出），展开态只在有文字时显示（通常是错误）。
	pi.registerTool({
		...tools.write,

		renderCall(args, theme, _context) {
			// 路径缩短；缺失时用省略号占位。
			const path = shortenPath(args.path || "");
			const pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
			// args.content 是待写入正文；按换行切分统计行数，空内容时固定 0。
			const lineCount = args.content ? args.content.split("\n").length : 0;
			// 行数为正才显示 "(N lines)"，避免 0 行时出现无意义提示。
			const lineInfo = lineCount > 0 ? theme.fg("muted", ` (${lineCount} lines)`) : "";

			return new Text(`${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}${lineInfo}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			// Minimal mode: show nothing (file was written)
			if (!expanded) {
				return new Text("", 0, 0);
			}

			// Expanded mode: show error if any
			// some 先判断是否存在非空文字块；没有就跳过后续 find。
			if (result.content.some((c) => c.type === "text" && c.text)) {
				const textContent = result.content.find((c) => c.type === "text");
				// find 可能返回 undefined 或图片块，所以还要检查 type 与 text 非空。
				if (textContent?.type === "text" && textContent.text) {
					return new Text(`\n${theme.fg("error", textContent.text)}`, 0, 0);
				}
			}

			return new Text("", 0, 0);
		},
	});

	// =========================================================================
	// Edit Tool
	// =========================================================================
	// edit 额外指定 renderShell: "default"，让宿主保留内置的调用外壳（例如差异/状态样式）。
	pi.registerTool({
		...tools.edit,
		renderShell: "default",

		renderCall(args, theme, _context) {
			// 与 read/write 相同的路径展示逻辑。
			const path = shortenPath(args.path || "");
			const pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");

			return new Text(`${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			// Minimal mode: show nothing in collapsed state
			if (!expanded) {
				return new Text("", 0, 0);
			}

			// Expanded mode: show diff or error
			const textContent = result.content.find((c) => c.type === "text");
			if (!textContent || textContent.type !== "text") {
				return new Text("", 0, 0);
			}

			// For errors, show the error message
			// 这里用字符串包含判断错误，属于示例的简化做法；真实错误还可能有 isError 标记等来源。
			const text = textContent.text;
			if (text.includes("Error") || text.includes("error")) {
				return new Text(`\n${theme.fg("error", text)}`, 0, 0);
			}

			// Otherwise show the text (would be nice to show actual diff here)
			return new Text(`\n${theme.fg("toolOutput", text)}`, 0, 0);
		},
	});

	// =========================================================================
	// Find Tool
	// =========================================================================
	// 查找类工具的 minimal 折叠态不显示零结果；有结果时只显示计数，展开后显示完整列表。
	pi.registerTool({
		...tools.find,

		renderCall(args, theme, _context) {
			// pattern 必填，这里仍用 || "" 做展示兜底；path 缺省显示当前目录 "."。
			const pattern = args.pattern || "";
			const path = shortenPath(args.path || ".");
			const limit = args.limit;

			// 先用工具名和搜索模式初始化一行，再用 += 追加路径与可选限制。
			let text = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", pattern)}`;
			text += theme.fg("toolOutput", ` in ${path}`);
			// !== undefined 而不是真值判断：limit 为 0 时也显示。
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` (limit ${limit})`);
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			// 折叠与展开是两套渲染逻辑，因此先按 expanded 分支。
			if (!expanded) {
				// Minimal: just show count
				const textContent = result.content.find((c) => c.type === "text");
				// ?. 与 type 检查共同收窄；没有文字结果就不显示计数。
				if (textContent?.type === "text") {
					// trim 去掉尾部换行，split 后 filter(Boolean) 去掉空行，得到实际条数。
					const count = textContent.text.trim().split("\n").filter(Boolean).length;
					if (count > 0) {
						return new Text(theme.fg("muted", ` → ${count} files`), 0, 0);
					}
				}
				return new Text("", 0, 0);
			}

			// Expanded: show full results
			const textContent = result.content.find((c) => c.type === "text");
			if (!textContent || textContent.type !== "text") {
				return new Text("", 0, 0);
			}

			// 逐行着色；trim 只影响首尾，不改变结果中间的相对顺序。
			const output = textContent.text
				.trim()
				.split("\n")
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");

			return new Text(`\n${output}`, 0, 0);
		},
	});

	// =========================================================================
	// Grep Tool
	// =========================================================================
	// grep 的调用行额外包含 glob 过滤；折叠态只显示匹配行数。
	pi.registerTool({
		...tools.grep,

		renderCall(args, theme, _context) {
			// 与 find 相同，展示用正则以 /pattern/ 形式包裹。
			const pattern = args.pattern || "";
			const path = shortenPath(args.path || ".");
			const glob = args.glob;
			const limit = args.limit;

			let text = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", `/${pattern}/`)}`;
			text += theme.fg("toolOutput", ` in ${path}`);
			// glob 可选；空字符串视为未提供。
			if (glob) {
				text += theme.fg("toolOutput", ` (${glob})`);
			}
			// limit 用 !== undefined 判断，0 也会显示。
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` limit ${limit}`);
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			if (!expanded) {
				// Minimal: just show match count
				const textContent = result.content.find((c) => c.type === "text");
				if (textContent?.type === "text") {
					// 这里把每个非空文本行当作一条匹配；grep 的实际输出格式由工具决定。
					const count = textContent.text.trim().split("\n").filter(Boolean).length;
					if (count > 0) {
						return new Text(theme.fg("muted", ` → ${count} matches`), 0, 0);
					}
				}
				return new Text("", 0, 0);
			}

			// Expanded: show full results
			const textContent = result.content.find((c) => c.type === "text");
			if (!textContent || textContent.type !== "text") {
				return new Text("", 0, 0);
			}

			const output = textContent.text
				.trim()
				.split("\n")
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");

			return new Text(`\n${output}`, 0, 0);
		},
	});

	// =========================================================================
	// Ls Tool
	// =========================================================================
	// ls 的折叠态只显示条目数，展开态显示完整列表；结构与 find/grep 一致。
	pi.registerTool({
		...tools.ls,

		renderCall(args, theme, _context) {
			const path = shortenPath(args.path || ".");
			const limit = args.limit;

			let text = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", path)}`;
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` (limit ${limit})`);
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			if (!expanded) {
				// Minimal: just show entry count
				const textContent = result.content.find((c) => c.type === "text");
				if (textContent?.type === "text") {
					// 每个非空行算一个条目；目录中名称含换行的情况不在示例处理范围内。
					const count = textContent.text.trim().split("\n").filter(Boolean).length;
					if (count > 0) {
						return new Text(theme.fg("muted", ` → ${count} entries`), 0, 0);
					}
				}
				return new Text("", 0, 0);
			}

			// Expanded: show full listing
			const textContent = result.content.find((c) => c.type === "text");
			if (!textContent || textContent.type !== "text") {
				return new Text("", 0, 0);
			}

			const output = textContent.text
				.trim()
				.split("\n")
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");

			return new Text(`\n${output}`, 0, 0);
		},
	});
}
