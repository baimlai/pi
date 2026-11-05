/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是自定义工具的输出截断。
 * 上游：模型调用名为 rg 的工具时进入 execute；用户也可以从 TUI 展开结果查看详情。
 * 下游：child_process.execSync 启动系统 rg/ripgrep；截断使用宿主导出的 truncateHead、
 * DEFAULT_MAX_LINES、DEFAULT_MAX_BYTES、formatSize；被截断时把完整输出写入系统临时目录
 * 下的 pi-rg-* 文件夹。
 *
 * 演示的机制：自定义工具必须自己限制输出大小，否则会把上下文淹没。示例先用
 * truncateHead 保留开头 2000 行/50KB（先到者为准），再在正文后追加截断说明和完整输出
 * 的临时文件路径，让模型知道内容不完整、可以去哪里读。renderCall/renderResult 演示
 * 自定义调用行和结果行，包括 streaming 的 isPartial 状态与 expanded 展开状态。
 *
 * 能力清单：
 * - RgParams：pattern/path/glob 参数 schema。
 * - RgDetails：结果详情（匹配数、截断信息、完整输出路径）。
 * - 默认导出：注册 rg 工具，包含 execute、renderCall、renderResult。
 *
 * 典型运行顺序：加载扩展 -> 模型调用 rg 搜索 -> 未匹配时返回 "No matches found"；
 * 匹配少时直接显示；匹配过多时正文被截断并给出临时文件路径。
 *
 * 示例（真实签名）：
 *   // 真实运行时由工具管线调用
 *   await rgTool.execute(id, { pattern: "TODO", path: "src" }, signal, onUpdate, ctx);
 *   命令本身使用 args.join(" ") 交给 execSync，未经 shell 转义；参数含空格或特殊字符时
 *   可能被 shell 重新解释，这是示例的已知简化。
 *
 * 建议阅读顺序：先看 schema/详情类型，再看 execute 中构造命令、处理退出码 1、截断与
 * 临时文件，最后看两个渲染函数。
 *
 * 前置条件：系统需安装 ripgrep（rg 命令）；需要可写临时目录。示例会启动子进程并写临时
 * 文件，但不调用模型、不写项目文件。
 */

/**
 * Truncated Tool Example - Demonstrates proper output truncation for custom tools
 *
 * Custom tools MUST truncate their output to avoid overwhelming the LLM context.
 * The built-in limit is 50KB (~10k tokens) and 2000 lines, whichever is hit first.
 *
 * This example shows how to:
 * 1. Use the built-in truncation utilities
 * 2. Write full output to a temp file when truncated
 * 3. Inform the LLM where to find the complete output
 * 4. Custom rendering of tool calls and results
 *
 * The `rg` tool here wraps ripgrep with proper truncation. Compare this to the
 * built-in `grep` tool in src/core/tools/grep.ts for a more complete implementation.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { Type } from "typebox";

// 模型可传的参数：pattern 必填，path/glob 可选；description 会出现在 JSON schema 中。
const RgParams = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex)" }),
	path: Type.Optional(Type.String({ description: "Directory to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "File glob pattern, e.g. '*.ts'" })),
});

// details 的业务结构；? 表示该字段只在特定分支存在，读取方需判空。
interface RgDetails {
	pattern: string;
	path?: string;
	glob?: string;
	matchCount: number;
	// 只有发生截断时才附带裁剪统计。
	truncation?: TruncationResult;
	// 只有发生截断并成功写临时文件时才存在。
	fullOutputPath?: string;
}

// 扩展入口：注册一个工具；execute 之外的两个 render 函数只影响 TUI 显示。
export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "rg",
		label: "ripgrep",
		// Document the truncation limits in the tool description so the LLM knows
		description: `Search file contents using ripgrep. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, full output is saved to a temp file.`,
		parameters: RgParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// 解构时把 path 改名 searchPath，避免与可能导入的 path 模块或局部变量混淆。
			const { pattern, path: searchPath, glob } = params;

			// Build the ripgrep command
			// argv 数组先按 rg 的选项顺序组装；--line-number 输出行号，--color=never 避免 ANSI 干扰。
			const args = ["rg", "--line-number", "--color=never"];
			// glob 只在其非空时加入；push 可变长度参数。
			if (glob) args.push("--glob", glob);
			args.push(pattern);
			// 未指定目录时搜索当前目录；|| 在空串/undefined 时选 "."。
			args.push(searchPath || ".");

			let output: string;
			try {
				// 注意：args.join(" ") 后交给 execSync，会经过 shell；带空格/引号的参数可能被重新解释。
				output = execSync(args.join(" "), {
					// cwd 使用会话工作目录，而不是扩展进程启动目录。
					cwd: ctx.cwd,
					// encoding 让返回值直接是 string（否则是 Buffer）。
					encoding: "utf-8",
					maxBuffer: 100 * 1024 * 1024, // 100MB buffer to capture full output
				});
			} catch (err: any) {
				// ripgrep exits with 1 when no matches found
				// 退出码 1 是“无匹配”的正常信号，不是错误。
				if (err.status === 1) {
					return {
						content: [{ type: "text", text: "No matches found" }],
						details: { pattern, path: searchPath, glob, matchCount: 0 } as RgDetails,
					};
				}
				// 其他失败（rg 不存在、参数错误等）转成抛错，由工具管线呈现为工具错误。
				throw new Error(`ripgrep failed: ${err.message}`);
			}

			// 有些 rg 版本无匹配时退出码仍为 0 但输出为空；统一按无匹配处理。
			if (!output.trim()) {
				return {
					content: [{ type: "text", text: "No matches found" }],
					details: { pattern, path: searchPath, glob, matchCount: 0 } as RgDetails,
				};
			}

			// Apply truncation using built-in utilities
			// truncateHead keeps the first N lines/bytes (good for search results)
			// truncateTail keeps the last N lines/bytes (good for logs/command output)
			// 两个上限同时传入，实际触发哪个由 TruncationResult.truncatedBy 说明。
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			// Count matches (each non-empty line with a match)
			// 以非空行数近似匹配行数；同一行多个匹配只算一次。
			const matchCount = output.split("\n").filter((line) => line.trim()).length;

			const details: RgDetails = {
				pattern,
				path: searchPath,
				glob,
				matchCount,
			};

			// 初始正文是截断后的内容；未截断时它就是完整输出。
			let resultText = truncation.content;

			// 只有确实裁剪过才写临时文件并追加说明，避免无谓磁盘操作。
			if (truncation.truncated) {
				// Save full output to a temp file so LLM can access it if needed
				// mkdtemp 创建唯一目录，后缀带进程随机串，避免并发冲突。
				const tempDir = await mkdtemp(join(tmpdir(), "pi-rg-"));
				const tempFile = join(tempDir, "output.txt");
				// 与内置工具一致地串行化写入，防止同路径并发写。
				await withFileMutationQueue(tempFile, async () => {
					await writeFile(tempFile, output, "utf8");
				});

				// 把裁剪统计和路径放进 details，供渲染器和后续调用使用。
				details.truncation = truncation;
				details.fullOutputPath = tempFile;

				// Add truncation notice - this helps the LLM understand the output is incomplete
				// 用总数减输出数得到被省略的行数/字节数。
				const truncatedLines = truncation.totalLines - truncation.outputLines;
				const truncatedBytes = truncation.totalBytes - truncation.outputBytes;

				// 分四段拼接说明，避免单行过长；内容会进入模型上下文。
				resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				resultText += ` ${truncatedLines} lines (${formatSize(truncatedBytes)}) omitted.`;
				resultText += ` Full output saved to: ${tempFile}]`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details,
			};
		},

		// Custom rendering of the tool call (shown before/during execution)
		// 调用行：工具名 + 高亮模式 + 可选目录与 glob；只读 args，不执行搜索。
		renderCall(args, theme, _context) {
			// 先构造带样式的基础字符串，再用 += 追加可选片段。
			let text = theme.fg("toolTitle", theme.bold("rg "));
			text += theme.fg("accent", `"${args.pattern}"`);
			// 可选参数可能为 undefined，直接用 if 判断即可。
			if (args.path) {
				text += theme.fg("muted", ` in ${args.path}`);
			}
			if (args.glob) {
				text += theme.fg("dim", ` --glob ${args.glob}`);
			}
			// Text 的 0,0 是左右/上下内边距。
			return new Text(text, 0, 0);
		},

		// Custom rendering of the tool result
		// 结果行：partial 显示搜索中，完成时显示匹配数；展开状态附加正文前 20 行。
		renderResult(result, { expanded, isPartial }, theme, _context) {
			// details 是 unknown，断言后仍用 ?. 防御旧结果没有该字段。
			const details = result.details as RgDetails | undefined;

			// Handle streaming/partial results
			if (isPartial) {
				return new Text(theme.fg("warning", "Searching..."), 0, 0);
			}

			// No matches
			// 没有 details 或匹配数为 0 都显示无匹配。
			if (!details || details.matchCount === 0) {
				return new Text(theme.fg("dim", "No matches found"), 0, 0);
			}

			// Build result display
			let text = theme.fg("success", `${details.matchCount} matches`);

			// Show truncation warning if applicable
			// 可选链避免 details.truncation 不存在时访问 truncated 报错。
			if (details.truncation?.truncated) {
				text += theme.fg("warning", " (truncated)");
			}

			// In expanded view, show the actual matches
			if (expanded) {
				// content[0] 可能是 undefined；后续再判断 type。
				const content = result.content[0];
				if (content?.type === "text") {
					// Show first 20 lines in expanded view, or all if fewer
					// slice(0,20) 在不足 20 行时返回全部；split 会重复计算一次行数。
					const lines = content.text.split("\n").slice(0, 20);
					for (const line of lines) {
						text += `\n${theme.fg("dim", line)}`;
					}
					if (content.text.split("\n").length > 20) {
						text += `\n${theme.fg("muted", "... (use read tool to see full output)")}`;
					}
				}

				// Show temp file path if truncated
				// 有完整输出路径时提示用户/模型可以读取该文件。
				if (details.fullOutputPath) {
					text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
