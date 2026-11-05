// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；用 `pi -e ./built-in-tool-renderer.ts` 加载。
// 演示内容：以同名重新注册内置 read/bash/edit/write，保留原执行逻辑，只替换 renderCall/renderResult，得到更紧凑的终端展示。
// 上下游：扩展加载时 create*ToolDefinition(process.cwd()) 取原始定义，pi.registerTool 交给宿主；模型调用工具时仍执行原 execute，渲染层把参数/结果转换成 pi-tui 的 Text 组件。示例没有其他导出。
// 能力清单：
// - 默认导出 (pi: ExtensionAPI) => void：构造并注册四个同名工具；加载时不读文件、不运行命令。
// - Read 渲染：调用行显示路径和 offset/limit；结果行显示行数、截断总量，展开预览 15 行。
// - Bash 渲染：调用行显示命令（最多 80）和秒级 timeout；结果行显示成功/退出码、非空行数，展开预览 20 行。
// - Edit 渲染：调用行显示路径；结果行统计 diff 增删（排除 +++/---），展开预览 30 行。
// - Write 渲染：调用行显示路径和内容行数；结果行显示 Written 或错误首行。
// 典型运行顺序：加载扩展 -> 同名定义替换内置工具 -> 模型调用任一工具 -> 原 execute 执行 -> 自定义 renderCall/renderResult 绘制结果。
// 示例（真实签名）：
//   pi -e ./examples/extensions/built-in-tool-renderer.ts
//   # 调用 read 时显示 "read src/app.ts"，结果折叠为 "42 lines"，按 ctrl+e 展开前 15 行
// 测试引用：packages/coding-agent/test/tool-renderer-examples.test.ts（用真实扩展加载器验证渲染器不会改写系统提示）。
// 阅读顺序：先看四个 create*ToolDefinition 与 registerTool 的展开，再逐个看 renderCall；renderResult 按 read -> bash -> edit -> write 读。
// 前置与副作用：同名注册会整体替换内置工具的扩展定义，所以必须用 ...original 保留 schema/execute 等字段；这些渲染器只改显示，不改变工具行为或模型可见的 content。Edit 的 renderShell:"self" 随展开对象保留。示例使用 process.cwd() 构造工具；渲染中的行数/diff/退出码都是字符串启发式，可能因输出格式变化而偏差。特别是 Bash 渲染器查找 "exit code: N"，而当前内置 bash 失败时追加的是 "Command exited with code N"，正则通常匹配不到，失败可能显示为 done；Edit/Write 用 "Error" 前缀识别失败，也可能漏掉实际错误（renderResult 的 context.isError 更可靠，但示例未使用）。运行工具本身仍可能读写文件或执行命令。
/**
 * Built-in Tool Renderer Example - Custom rendering for built-in tools
 *
 * Demonstrates how to override the rendering of built-in tools (read, bash,
 * edit, write) without changing their behavior. Each tool is re-registered
 * with the same name, delegating execution to the original implementation
 * while providing compact custom renderCall/renderResult functions.
 *
 * This is useful for users who prefer more concise tool output, or who want
 * to highlight specific information (e.g., showing only the diff stats for
 * edit, or just the exit code for bash).
 *
 * How it works:
 * - registerTool() with the same name as a built-in replaces it entirely
 * - We create the original definitions via createReadToolDefinition(), etc.
 *   and override only their renderers
 * - renderCall() controls what's shown when the tool is invoked
 * - renderResult() controls what's shown after execution completes
 * - renderShell: "self" lets a tool render its own outer shell instead of
 *   using the default boxed shell from ToolExecutionComponent
 * - The `expanded` flag in renderResult indicates whether the user has
 *   toggled the tool output open (via ctrl+e or clicking)
 *
 * Usage:
 *   pi -e ./built-in-tool-renderer.ts
 */

// import type 只引入类型，编译后消失；三个 Details 类型描述工具结果的 details 字段，下面用 as 断言时不会产生运行时检查。
import type { BashToolDetails, EditToolDetails, ExtensionAPI, ReadToolDetails } from "@earendil-works/pi-coding-agent";
// 四个工厂按 cwd 生成内置工具定义（schema、execute、默认渲染器）；单纯调用工厂不会注册或执行工具。
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
// Text 是 pi-tui 的文本组件；构造参数是 (text, paddingX, paddingY [, bgFn])，这里都使用 0 内边距。
import { Text } from "@earendil-works/pi-tui";

// 扩展入口：注册四个同名内置工具，只覆盖渲染器；没有返回值，加载阶段不访问文件系统。
// 示例：输入 /read 后调用工具，界面显示本文件定义的紧凑行；执行结果与内置工具一致。
export default function (pi: ExtensionAPI) {
	// 扩展加载时的进程工作目录；四个工具定义都固定使用它，后续会话切目录也不会重新构造。
	const cwd = process.cwd();

	// --- Read tool: show path and line count ---
	// createReadToolDefinition 返回完整定义但不注册、不读取文件；真正读取发生在模型调用后的 execute。
	const originalRead = createReadToolDefinition(cwd);
	// 与内置 read 同名，注册后会替换内置定义；展开原始对象保证参数校验和执行逻辑不变。
	pi.registerTool({
		// ...originalRead 复制 name/label/description/parameters/promptSnippet/execute 等；下面两个渲染器覆盖同名字段。
		...originalRead,

		// renderCall：绘制工具调用行；args 由 read schema 推导，theme 负责着色，_context 未使用。
		renderCall(args, theme, _context) {
			// theme.fg(token,text) 按当前主题着色，theme.bold 加粗；不要在渲染器里写死 ANSI 转义。
			let text = theme.fg("toolTitle", theme.bold("read "));
			text += theme.fg("accent", args.path);
			// offset/limit 是可选数字；这里用真值判断，0 会被当作“未提供”（read 的 offset 是 1 起始，0 本身无效）。
			if (args.offset || args.limit) {
				// 显式标注 string[] 让 parts.push 的元素类型明确；join 后为空时括号里没有内容，但只有至少一个真值才会进入此分支。
				const parts: string[] = [];
				if (args.offset) parts.push(`offset=${args.offset}`);
				if (args.limit) parts.push(`limit=${args.limit}`);
				// 把可选的 offset/limit 合成一段 dim 色说明；模板字符串只拼接已计算的 parts。
				text += theme.fg("dim", ` (${parts.join(", ")})`);
			}
			// Text 的 paddingX/paddingY 为 0，紧凑显示；第三个参数之后可传背景函数，这里省略。
			return new Text(text, 0, 0);
		},

		// renderResult：绘制结果；expanded 控制是否展开预览，isPartial 表示流式未完成。
		renderResult(result, { expanded, isPartial }, theme, _context) {
			// 部分结果阶段只显示占位文字，避免读取尚未完成的 details/content。
			if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);

			// result.details 的静态类型很宽；这里 as ReadToolDetails 只是告诉 TypeScript，运行时不会验证形状，仍可能是 undefined。
			const details = result.details as ReadToolDetails | undefined;
			// 只看第一个内容块：read 正常返回 text，但也可能返回 image；content 可能为空。
			const content = result.content[0];

			// 图片块用固定提示代替实际图片；这里没有读取图片数据。
			if (content?.type === "image") {
				return new Text(theme.fg("success", "Image loaded"), 0, 0);
			}

			// 既不是 text 也不是 image（或没有内容块）时显示错误占位；这不是工具执行失败，只是渲染器无法展示。
			if (content?.type !== "text") {
				return new Text(theme.fg("error", "No content"), 0, 0);
			}

			// split("\n").length 把末尾空段也算一行，因此以换行结尾的文本会比直观行号多 1。
			const lineCount = content.text.split("\n").length;
			let text = theme.fg("success", `${lineCount} lines`);

			// truncation 是可选字段；?. 在 details 或 truncation 缺失时短路，truncated 为 false 时不追加警告。
			if (details?.truncation?.truncated) {
				// totalLines 是截断前的总行数；这里只显示“从多少行截断”，不显示实际保留了多少。
				text += theme.fg("warning", ` (truncated from ${details.truncation.totalLines})`);
			}

			// 展开时只预览前 15 行；这是渲染上限，不影响发送给模型的 content。
			if (expanded) {
				// 切分完整文本后 slice；15 是显示上限，不是 read 的 limit 参数。
				const lines = content.text.split("\n").slice(0, 15);
				for (const line of lines) {
					text += `\n${theme.fg("dim", line)}`;
				}
				// lineCount 是切分段数；大于 15 时提示剩余行数。
				if (lineCount > 15) {
					// 嵌套模板字符串：外层拼接换行和 muted 色，内层计算剩余行数；模板内部不能插入注释。
					text += `\n${theme.fg("muted", `... ${lineCount - 15} more lines`)}`;
				}
			}

			// 所有分支都返回 Component；Text 的 0,0 表示无内边距。
			return new Text(text, 0, 0);
		},
	});

	// --- Bash tool: show command and exit code ---
	// createBashToolDefinition 只创建定义；schema 中的 timeout 单位是秒，执行时才启动 shell。
	const originalBash = createBashToolDefinition(cwd);
	// 同名替换内置 bash，spread 保留 command/timeout schema 与原 execute。
	pi.registerTool({
		...originalBash,

		// renderCall：绘制 bash 调用行，包含命令和可选的秒级 timeout。
		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("$ "));
			// 超过 80 个 UTF-16 码元时截到 77 再加 "..."，总长仍为 80；可能从中间切开 emoji。
			const cmd = args.command.length > 80 ? `${args.command.slice(0, 77)}...` : args.command;
			text += theme.fg("accent", cmd);
			// timeout 是可选秒数；0 或 undefined 都不显示，schema 本身要求正数。
			if (args.timeout) {
				text += theme.fg("dim", ` (timeout: ${args.timeout}s)`);
			}
			return new Text(text, 0, 0);
		},

		// renderResult：从输出中提取退出码和行数，按 expanded/isPartial 决定展示。
		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);

			const details = result.details as BashToolDetails | undefined;
			const content = result.content[0];
			// output 可能同时包含 stdout、stderr 与工具追加的状态行；渲染器无法区分来源。
			const output = content?.type === "text" ? content.text : "";

			// 在整段输出里搜索 "exit code: N"；当前内置 bash 失败时追加的是 "Command exited with code N"，所以通常匹配不到。
			// 如果命令自身打印了 "exit code: N"，反而可能误判；更可靠的是 renderResult 第 4 个参数的 context.isError。
			const exitMatch = output.match(/exit code: (\d+)/);
			// match 返回 RegExpMatchArray | null；第二个参数 10 明确按十进制解析。
			const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
			// 只统计非空行，口径与 read 的切分段计数不同；用于粗略展示输出规模。
			const lineCount = output.split("\n").filter((l) => l.trim()).length;

			let text = "";
			// 没找到退出码时按成功显示 "done"；结合上面的格式差异，失败命令也可能落到这里。
			if (exitCode === 0 || exitCode === null) {
				text += theme.fg("success", "done");
			} else {
				text += theme.fg("error", `exit ${exitCode}`);
			}
			text += theme.fg("dim", ` (${lineCount} lines)`);

			// details.truncation 只在结果被截断时存在；这里只显示标记，不显示总量或完整输出路径。
			if (details?.truncation?.truncated) {
				text += theme.fg("warning", " [truncated]");
			}

			// 展开时预览前 20 行；下方再次 split 是为了计算总段数，与 lines 数组独立。
			if (expanded) {
				const lines = output.split("\n").slice(0, 20);
				for (const line of lines) {
					text += `\n${theme.fg("dim", line)}`;
				}
				// 空行也计入总段数；与 lineCount 的“非空行”口径不同。
				if (output.split("\n").length > 20) {
					text += `\n${theme.fg("muted", "... more output")}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// --- Edit tool: show path and diff stats ---
	// createEditToolDefinition 需要 cwd 解析相对路径；构造时不读写文件。
	const originalEdit = createEditToolDefinition(cwd);
	// 同名替换内置 edit；展开 originalEdit 会保留 renderShell:"self"（编辑工具自己画外壳）。
	pi.registerTool({
		...originalEdit,

		// renderCall：绘制编辑调用行，只显示工具名和路径。
		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("edit "));
			text += theme.fg("accent", args.path);
			return new Text(text, 0, 0);
		},

		// renderResult：显示错误首行或 diff 增删统计；expanded 时预览 diff。
		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Editing..."), 0, 0);

			// as EditToolDetails 只是类型断言；details 运行时可能缺失或来自旧版本工具。
			const details = result.details as EditToolDetails | undefined;
			const content = result.content[0];

			// 用 content.text.startsWith("Error") 判断失败，是渲染层约定；工具抛错时正文通常是错误消息本身（如 "Could not edit file: ..."），不一定以 Error 开头。
			// renderResult 的第 4 个参数 context.isError 才是结构化标志，但本示例用 _context 忽略了它。
			if (content?.type === "text" && content.text.startsWith("Error")) {
				// 只显示错误第一行，避免多行错误撑高界面。
				return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
			}

			// 没有 diff 说明无修改可展示或工具未提供 details；显示固定成功文案。
			if (!details?.diff) {
				return new Text(theme.fg("success", "Applied"), 0, 0);
			}

			// Count additions and removals from the diff
			// diff 按行切分；同一数组用于统计和展开预览。
			const diffLines = details.diff.split("\n");
			let additions = 0;
			let removals = 0;
			// 统计 + / - 行，排除 +++/--- 文件头；@@ hunk 头不计入增删。
			for (const line of diffLines) {
				if (line.startsWith("+") && !line.startsWith("+++")) additions++;
				if (line.startsWith("-") && !line.startsWith("---")) removals++;
			}

			// 用 success/error 色显示增删计数；斜杠用 dim 色分隔。
			let text = theme.fg("success", `+${additions}`);
			text += theme.fg("dim", " / ");
			text += theme.fg("error", `-${removals}`);

			// 展开时最多显示 30 行 diff，并按行首字符着色。
			if (expanded) {
				// slice 不修改 diffLines；分类规则与统计一致。
				for (const line of diffLines.slice(0, 30)) {
					if (line.startsWith("+") && !line.startsWith("+++")) {
						text += `\n${theme.fg("success", line)}`;
					} else if (line.startsWith("-") && !line.startsWith("---")) {
						text += `\n${theme.fg("error", line)}`;
					} else {
						text += `\n${theme.fg("dim", line)}`;
					}
				}
				// diffLines.length 是总段数；这里提示的是剩余行数，不是剩余增删数。
				if (diffLines.length > 30) {
					text += `\n${theme.fg("muted", `... ${diffLines.length - 30} more diff lines`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// --- Write tool: show path and size ---
	// createWriteToolDefinition 只返回定义；execute 才会写文件。
	const originalWrite = createWriteToolDefinition(cwd);
	// 同名替换内置 write；write 的结果 details 是 undefined，渲染只看 content。
	pi.registerTool({
		...originalWrite,

		// renderCall：绘制写入调用行，显示路径和内容行数。
		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("write "));
			text += theme.fg("accent", args.path);
			// 末尾换行会多算一个空段；这是预览统计，不影响实际写入内容。
			const lineCount = args.content.split("\n").length;
			text += theme.fg("dim", ` (${lineCount} lines)`);
			return new Text(text, 0, 0);
		},

		// renderResult：写入无 details，只显示错误首行或固定成功文案。
		renderResult(result, { isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Writing..."), 0, 0);

			// 正常结果只有一个 text 块；错误仍用 "Error" 前缀约定识别，同样可能漏掉实际错误。
			const content = result.content[0];
			if (content?.type === "text" && content.text.startsWith("Error")) {
				return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
			}

			// 成功只显示固定 "Written"；行数已在调用阶段展示。
			return new Text(theme.fg("success", "Written"), 0, 0);
		},
	});
}
