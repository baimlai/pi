#!/usr/bin/env node
// 文件导读：把某个项目 cwd 的 pi 会话导出为可分析的纯文本转录，并可选调用子代理提炼重复指令。
// 所属：仓库根 `scripts/` 的会话分析脚本系列；这是唯一会启动外部 pi 进程的统计脚本。
// 作用：
//   1. 根据 cwd 推导 `~/.pi/agent/sessions/<encoded>/*.jsonl`，解析 user/assistant 文本消息。
//   2. 按 SESSION 分隔拼接，并按 MAX_CHARS_PER_FILE 切成多个 .txt，避免单个文件超出模型上下文。
//   3. 传 --analyze 时，为每个 .txt 启动一个 `pi --mode json` 子代理，读取转录并写 .summary.txt；
//      最后再启动一个子代理把所有 summary 合并成 FINAL-SUMMARY.txt。
// 上游：手动运行 `node scripts/session-transcripts.ts [--analyze] [--output <dir>] [cwd]`；
//   Node 直接执行 .ts 依赖仓库使用的 strip-only TypeScript（类型在运行时被擦除）。
// 下游：读取会话 JSONL；导入 coding-agent 的 parseSessionEntries 与 chalk；--analyze 时 spawn `pi`；
//   写入输出目录下的转录/摘要文件。子代理只被授予 read,write 两个工具。
// 输出与错误：成功打印找到/写出的文件数；无会话目录或无转录时 process.exit(1)；
//   单个子代理失败只打印错误并继续其它文件。注意 main().catch(console.error) 只打印而不设置退出码，
//   因此 main 内部未显式 exit 的异常不会让进程以非 0 结束。
// 高风险：--analyze 会实际调用模型（可能产生费用）并让子代理写文件；输出目录已存在时同名 .txt 会被覆盖。
// 能力清单：
//   - cwdToSessionDir：cwd → 会话目录名编码。
//   - extractTextContent/parseSession：从 JSONL 提取 user/assistant 文本。
//   - truncateLine/runSubagent：子代理事件的紧凑显示与进程封装。
//   - main：参数解析、转录切分、逐文件分析、最终汇总。
// 典型调用与预期：
//   示例 `node scripts/session-transcripts.ts --output /tmp/transcripts`；
//   只导出转录、不调用模型，打印 `Created N transcript file(s)`。
//   `--analyze` 会额外启动 pi，要求本机已安装并在 PATH 中找到 pi。
// 阅读顺序：先读 cwd 编码与 parseSession，再看 runSubagent 的 JSON 事件处理，最后按 main 的三段流程阅读。
/**
 * Extracts session transcripts for a given cwd, splits into context-sized files,
 * optionally spawns subagents to analyze patterns.
 *
 * Usage: node scripts/session-transcripts.ts [--analyze] [--output <dir>] [cwd]
 *   --analyze      Spawn pi subagents to analyze each transcript file
 *   --output <dir> Output directory for transcript files (defaults to ./session-transcripts)
 *   cwd            Working directory to extract sessions for (defaults to current)
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { spawn } from "child_process";
import { createInterface } from "node:readline";
import { homedir } from "os";
import { join, resolve } from "path";
// `type` 导入只引入类型、不产生运行时 import；SessionMessageEntry 用于把通用 entry 收窄成消息条目。
import { parseSessionEntries, type SessionMessageEntry } from "../packages/coding-agent/src/core/session-manager.ts";
import chalk from "chalk";

// 每个输出文件最多约 10 万字符，约 2 万 token，为子代理的提示与输出留出余量。
const MAX_CHARS_PER_FILE = 100_000; // ~20k tokens, leaving room for prompt + analysis + output

// 把绝对 cwd 编码成 pi 的会话目录名：去掉前导斜杠，把 `/` 换成 `-`，两端包 `--`。
// 例：cwdToSessionDir("/Users/me/repo") → "--Users-me-repo--"。
function cwdToSessionDir(cwd: string): string {
	// replace 去掉所有 `/` 后，字符串以 `-` 开头；slice(1) 去掉它，再手动加两端 `--`。
	const normalized = resolve(cwd).replace(/\//g, "-");
	return `--${normalized.slice(1)}--`; // Remove leading slash, wrap with --
}

// 从消息 content 提取纯文本：字符串直接返回；数组只拼接 type=text 的块。
// 非字符串且非数组时返回空串，兼容旧会话格式。类型注解说明入参的联合类型。
function extractTextContent(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	// 理论上 content 可能是未定义的旧格式；运行时兜底，类型上已由调用方断言。
	if (!Array.isArray(content)) return "";

	// filter 先保留有 text 的文本块，map 取 text；`!` 是 TypeScript 非空断言，
	// 告诉编译器 text 一定存在（运行时不会产生任何检查），最后由换行拼接。
	return content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text!)
		.join("\n");
}

// 解析单个会话 JSONL，返回形如 `[USER]\n...` / `[ASSISTANT]\n...` 的文本数组。
// 只保留 user/assistant 且文本非空的消息；toolCall、工具结果与系统消息不导出。
// 输入是文件路径，纯读取；parseSessionEntries 负责把 JSONL 文本变成条目数组。
function parseSession(filePath: string): string[] {
	const content = readFileSync(filePath, "utf8");
	const entries = parseSessionEntries(content);
	const messages: string[] = [];

	for (const entry of entries) {
		// 会话条目有多种 type；转录只关心 message。
		if (entry.type !== "message") continue;
		// 类型断言：上面的判断已把 entry 收窄，但 parseSessionEntries 的返回类型可能较宽，
		// 这里告诉编译器消息条目才有的 message 字段。断言不改变运行时值。
		const msgEntry = entry as SessionMessageEntry;
		const { role, content } = msgEntry.message;

		// 跳过工具结果等非对话角色，避免把机器输出当成用户指令。
		if (role !== "user" && role !== "assistant") continue;

		// content 可能是字符串或多模态块数组；统一提取文本。
		const text = extractTextContent(content as string | Array<{ type: string; text?: string }>);
		// 纯空白消息没有分析价值，跳过。
		if (!text.trim()) continue;

		// 角色大写并单独成行，便于阅读与后续代理识别说话者。
		messages.push(`[${role.toUpperCase()}]\n${text}`);
	}

	return messages;
}

// 子代理输出的显示宽度：每段状态文本最多 100 字符。
const MAX_DISPLAY_WIDTH = 100;

// 把可能多行的文本压成单行（换行/连续空白都变空格），超宽时截断并加省略号。
// 仅用于终端显示，不影响写给子代理的提示内容。
function truncateLine(text: string, maxWidth: number): string {
	const singleLine = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxWidth) return singleLine;
	// 预留 3 个字符给 "..."，保证结果不超过 maxWidth。
	return singleLine.slice(0, maxWidth - 3) + "...";
}

// `pi --mode json` 事件的最小子集。interface 只在编译期存在，运行时完全擦除；
// 带 `?` 的属性可能缺失，因此下面访问前都要先判断。
interface JsonEvent {
	type: string;
	assistantMessageEvent?: { type: string; delta?: string };
	toolName?: string;
	args?: {
		path?: string;
		offset?: number;
		limit?: number;
		content?: string;
	};
}

// 启动一个 pi 子代理执行分析提示，返回它是否以 0 退出。
// 输入 prompt 与工作目录 cwd；副作用的重点是：
//   - spawn `pi --mode json --tools read,write -p <prompt>`，stdin 关闭，stdout/stderr 管道；
//   - 逐行解析 JSON 事件，把增量文本与工具调用以彩色状态打印到当前终端；
//   - 不向子代理传环境变量（继承父进程），因此需要本机已配置好可用模型。
// 该 Promise 永不 reject：spawn 失败或非 0 退出都 resolve {success:false}，由调用方决定是否继续。
function runSubagent(prompt: string, cwd: string): Promise<{ success: boolean }> {
	return new Promise((resolve) => {
		// `-p` 是单次 prompt 模式；read,write 限制子代理只能读转录、写摘要。
		const child = spawn("pi", ["--mode", "json", "--tools", "read,write", "-p", prompt], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		// 累积 text_delta，等到工具调用或回合结束再一次性显示。
		let textBuffer = "";

		// readline 按行切 stdout；每一行应是一个完整 JSON 事件。
		const rl = createInterface({ input: child.stdout });

		rl.on("line", (line) => {
			try {
				const event: JsonEvent = JSON.parse(line);

				if (event.type === "message_update" && event.assistantMessageEvent) {
					const msgEvent = event.assistantMessageEvent;
					// 只累积文本增量；thinking/tool 等其他增量忽略。
					if (msgEvent.type === "text_delta" && msgEvent.delta) {
						textBuffer += msgEvent.delta;
					}
				} else if (event.type === "tool_execution_start" && event.toolName) {
					// Print accumulated text before tool starts
					// 工具开始前把已累积的说明文本打印成一行，然后清空缓冲。
					if (textBuffer.trim()) {
						console.log(chalk.dim("  " + truncateLine(textBuffer, MAX_DISPLAY_WIDTH)));
						textBuffer = "";
					}
					// Format tool call with args
					// 根据工具类型拼出紧凑参数：read 带 offset/limit，write 只显示路径。
					let argsStr = "";
					if (event.args) {
						if (event.toolName === "read") {
							argsStr = event.args.path || "";
							// 只有非零 offset/limit 才显示，减少噪声。
							if (event.args.offset) argsStr += ` offset=${event.args.offset}`;
							if (event.args.limit) argsStr += ` limit=${event.args.limit}`;
						} else if (event.toolName === "write") {
							argsStr = event.args.path || "";
						}
					}
					console.log(chalk.cyan(`  [${event.toolName}] ${argsStr}`));
				} else if (event.type === "turn_end") {
					// Print any remaining text at turn end
					// 回合结束时冲出最后一段文本；无论是否有内容都清空缓冲。
					if (textBuffer.trim()) {
						console.log(chalk.dim("  " + truncateLine(textBuffer, MAX_DISPLAY_WIDTH)));
					}
					textBuffer = "";
				}
			} catch {
				// Ignore malformed JSON
			}
		});

		// 子代理的 stderr 原样转发（红色），便于看到 provider/工具错误。
		child.stderr.on("data", (data) => {
			process.stderr.write(chalk.red(data.toString()));
		});

		// close 在进程退出且 stdio 关闭后触发；code 为 null 通常表示被信号终止，视为失败。
		child.on("close", (code) => {
			resolve({ success: code === 0 });
		});

		// spawn 本身失败（例如找不到 pi）时不会触发 close；这里打印原因并 resolve false。
		child.on("error", (err) => {
			console.error(chalk.red(`  Failed to spawn pi: ${err.message}`));
			resolve({ success: false });
		});
	});
}

// 主流程：解析参数 → 定位会话目录 → 导出并切分转录 →（可选）逐文件分析与汇总。
// 只有 --analyze 分支会启动外部进程和额外写文件；前面的导出是纯读会话 + 写输出目录。
async function main() {
	const args = process.argv.slice(2);
	const analyzeFlag = args.includes("--analyze");

	// Parse --output <dir>
	// 没有 --output 时默认写到当前目录的 session-transcripts/；resolve 转绝对路径。
	const outputIdx = args.indexOf("--output");
	let outputDir = resolve("./session-transcripts");
	if (outputIdx !== -1 && args[outputIdx + 1]) {
		outputDir = resolve(args[outputIdx + 1]);
	}

	// Find cwd (positional arg that's not a flag or flag value)
	// 手写位置参数识别：先标记 --analyze 与 --output 及其值的下标，剩下的第一个非 -- 参数就是 cwd。
	const flagIndices = new Set<number>();
	flagIndices.add(args.indexOf("--analyze"));
	if (outputIdx !== -1) {
		flagIndices.add(outputIdx);
		flagIndices.add(outputIdx + 1);
	}
	const cwdArg = args.find((a, i) => !flagIndices.has(i) && !a.startsWith("--"));
	const cwd = resolve(cwdArg || process.cwd());

	// recursive 允许输出目录尚不存在；已存在时不报错。
	mkdirSync(outputDir, { recursive: true });
	const sessionsBase = join(homedir(), ".pi/agent/sessions");
	const sessionDirName = cwdToSessionDir(cwd);
	const sessionDir = join(sessionsBase, sessionDirName);

	// 没有该项目的会话目录说明从未在此 cwd 运行过 pi；直接失败而不是生成空转录。
	if (!existsSync(sessionDir)) {
		console.error(`No sessions found for ${cwd}`);
		console.error(`Expected: ${sessionDir}`);
		process.exit(1);
	}

	// 只取 .jsonl；sort 让输出按文件名（含时间前缀）稳定排序。
	const sessionFiles = readdirSync(sessionDir)
		.filter((f) => f.endsWith(".jsonl"))
		.sort();

	console.log(`Found ${sessionFiles.length} session files in ${sessionDir}`);

	// Collect all transcripts
	// 每个有消息的会话包上 SESSION 头尾，消息之间用 --- 分隔。
	const allTranscripts: string[] = [];
	for (const file of sessionFiles) {
		const filePath = join(sessionDir, file);
		const messages = parseSession(filePath);
		if (messages.length > 0) {
			allTranscripts.push(`=== SESSION: ${file} ===\n${messages.join("\n---\n")}\n=== END SESSION ===`);
		}
	}

	// 所有会话都没有可导出的对话文本时同样以 1 退出。
	if (allTranscripts.length === 0) {
		console.error("No transcripts found");
		process.exit(1);
	}

	// Split into files respecting MAX_CHARS_PER_FILE
	// 贪心装箱：尽量把多个会话放进一个文件；单个会话超限时独占一个文件（可能仍超限）。
	const outputFiles: string[] = [];
	let currentContent = "";
	let fileIndex = 0;

	for (const transcript of allTranscripts) {
		// If adding this transcript would exceed limit, write current and start new
		// +2 是拼接时可能加入的两个换行；当前文件非空且放不下时先落盘。
		if (currentContent.length > 0 && currentContent.length + transcript.length + 2 > MAX_CHARS_PER_FILE) {
			const filename = `session-transcripts-${String(fileIndex).padStart(3, "0")}.txt`;
			writeFileSync(join(outputDir, filename), currentContent);
			outputFiles.push(filename);
			console.log(`Wrote ${filename} (${currentContent.length} chars)`);
			currentContent = "";
			fileIndex++;
		}

		// If this single transcript exceeds limit, write it to its own file
		// 单条转录本身超限时不拆分会话，整体写入并标记 oversized，避免破坏上下文。
		if (transcript.length > MAX_CHARS_PER_FILE) {
			// Write any pending content first
			if (currentContent.length > 0) {
				const filename = `session-transcripts-${String(fileIndex).padStart(3, "0")}.txt`;
				writeFileSync(join(outputDir, filename), currentContent);
				outputFiles.push(filename);
				console.log(`Wrote ${filename} (${currentContent.length} chars)`);
				currentContent = "";
				fileIndex++;
			}
			// Write the large transcript to its own file
			const filename = `session-transcripts-${String(fileIndex).padStart(3, "0")}.txt`;
			writeFileSync(join(outputDir, filename), transcript);
			outputFiles.push(filename);
			console.log(chalk.yellow(`Wrote ${filename} (${transcript.length} chars) - oversized`));
			fileIndex++;
			// 已单独处理，跳过下面的累积逻辑。
			continue;
		}

		// 非首个会话之间空两行，便于阅读与按 SESSION 边界切分。
		currentContent += (currentContent ? "\n\n" : "") + transcript;
	}

	// Write remaining content
	// 循环结束后缓冲里可能还有最后一个文件。
	if (currentContent.length > 0) {
		const filename = `session-transcripts-${String(fileIndex).padStart(3, "0")}.txt`;
		writeFileSync(join(outputDir, filename), currentContent);
		outputFiles.push(filename);
		console.log(`Wrote ${filename} (${currentContent.length} chars)`);
	}

	console.log(`\nCreated ${outputFiles.length} transcript file(s) in ${outputDir}`);

	// 未请求分析时到此结束；不调用任何模型。
	if (!analyzeFlag) {
		console.log("\nRun with --analyze to spawn pi subagents for pattern analysis.");
		return;
	}

	// Find AGENTS.md files to compare against
	// 全局与项目级 AGENTS.md 都可能存在；只把存在的路径交给子代理，用于区分 NEW/EXISTING。
	const globalAgentsMd = join(homedir(), ".pi/agent/AGENTS.md");
	const localAgentsMd = join(cwd, "AGENTS.md");
	const agentsMdFiles = [globalAgentsMd, localAgentsMd].filter(existsSync);
	// 有 AGENTS.md 时在提示最前面插入“先读现有规则”的步骤；没有时留空。
	const agentsMdSection =
		agentsMdFiles.length > 0
			? `STEP 1: Read the existing AGENTS.md file(s) to see what's already encoded:\n${agentsMdFiles.join("\n")}\n\nSTEP 2: `
			: "";

	// Spawn subagents to analyze each file
	// 分析提示要求按 1000 行分块读完整个转录，并输出严格格式的 PATTERN 块；
	// 这是一段多行模板字符串，${agentsMdSection} 是唯一动态片段。
	const analysisPrompt = `You are analyzing session transcripts to identify recurring user instructions that could be automated.

${agentsMdSection}READING THE TRANSCRIPT:
The transcript file is large. Read it in chunks of 1000 lines using offset/limit parameters:
1. First: read with limit=1000 (lines 1-1000)
2. Then: read with offset=1001, limit=1000 (lines 1001-2000)
3. Continue incrementing offset by 1000 until you reach the end
4. Only after reading the ENTIRE file, perform the analysis and write the summary

ANALYSIS TASK:
Look for patterns where the user repeatedly gives similar instructions. These could become:
- AGENTS.md entries: coding style rules, behavior guidelines, project conventions
- Skills: multi-step workflows with external tools (search, browser, APIs)
- Prompt templates: reusable prompts for common tasks

Compare each pattern against the existing AGENTS.md content to determine if it's NEW or EXISTING.

OUTPUT FORMAT (strict):
Write a file with exactly this structure. Use --- as separator between patterns.

PATTERN: <short descriptive name>
STATUS: NEW | EXISTING
TYPE: agents-md | skill | prompt-template
FREQUENCY: <number of times observed>
EVIDENCE:
- "<exact quote 1>"
- "<exact quote 2>"
- "<exact quote 3>"
DRAFT:
<proposed content for AGENTS.md entry, SKILL.md, or prompt template>
---

Rules:
- Only include patterns that appear 2+ times
- STATUS is NEW if not in AGENTS.md, EXISTING if already covered
- EVIDENCE must contain exact quotes from the transcripts
- DRAFT must be ready-to-use content
- If no patterns found, write "NO PATTERNS FOUND"
- Do not include any other text outside this format`;

	console.log("\nSpawning subagents for analysis...");
	// 逐个文件串行分析（不并发），避免同时启动过多模型请求；任一失败不影响后续文件。
	for (const file of outputFiles) {
		// 每个转录对应一个 .summary.txt：把文件名里的 ".txt" 替换为 ".summary.txt"。
		const summaryFile = file.replace(".txt", ".summary.txt");
		const filePath = join(outputDir, file);
		const summaryPath = join(outputDir, summaryFile);

		// 读取文件只为得到字符数与行数，用于告诉子代理规模；内容本身由子代理自己 read。
		const fileContent = readFileSync(filePath, "utf8");
		const fileSize = fileContent.length;

		console.log(`Analyzing ${file} (${fileSize} chars)...`);

		const lineCount = fileContent.split("\n").length;
		// 在基础提示后追加具体文件路径、行数与输出路径；模板字符串中三个 ${} 均为运行时值。
		const fullPrompt = `${analysisPrompt}\n\nThe file ${filePath} has ${lineCount} lines. Read it in full using chunked reads, then write your analysis to ${summaryPath}`;

		const result = await runSubagent(fullPrompt, outputDir);

		// 只有“进程成功且摘要文件确实存在”才算完整成功；其余两种情况分别给出不同提示。
		if (result.success && existsSync(summaryPath)) {
			console.log(chalk.green(`  -> ${summaryFile}`));
		} else if (result.success) {
			console.error(chalk.yellow(`  Agent finished but did not write ${summaryFile}`));
		} else {
			console.error(chalk.red(`  Failed to analyze ${file}`));
		}
	}

	// Collect all created summary files
	// 重新扫描输出目录而不是用循环里的列表，这样也能把之前运行留下的摘要纳入汇总。
	const summaryFiles = readdirSync(outputDir)
		.filter((f) => f.endsWith(".summary.txt"))
		.sort();

	console.log(`\n=== Individual Analysis Complete ===`);
	console.log(`Created ${summaryFiles.length} summary files`);

	if (summaryFiles.length === 0) {
		console.log(chalk.yellow("No summary files created. Nothing to aggregate."));
		return;
	}

	// Final aggregation step
	// 最后再启动一个子代理，把所有 .summary.txt 合并、去重、排序为 FINAL-SUMMARY.txt。
	console.log("\nAggregating findings into final summary...");

	// 每行一个绝对路径，作为提示中的文件列表；最终文件路径固定。
	const summaryPaths = summaryFiles.map((f) => join(outputDir, f)).join("\n");
	const finalSummaryPath = join(outputDir, "FINAL-SUMMARY.txt");

	// 汇总提示包含 AGENTS.md 路径、所有摘要路径与严格输出格式；不要在这些模板内容中插入注释。
	const aggregationPrompt = `You are aggregating pattern analysis results from multiple summary files.

STEP 1: Read the existing AGENTS.md file(s) to understand what patterns are already encoded:
${agentsMdFiles.length > 0 ? agentsMdFiles.join("\n") : "(no AGENTS.md files found)"}

STEP 2: Read ALL of the following summary files:
${summaryPaths}

STEP 3: Create a consolidated final summary that:
1. Merges duplicate patterns (same pattern found in multiple files)
2. Ranks patterns by total frequency across all files
3. Groups by status (NEW first, then EXISTING) and type
4. Provides the best/most complete DRAFT for each unique pattern
5. Verify STATUS against AGENTS.md content (pattern may be marked NEW in summaries but actually exists)

OUTPUT FORMAT (strict):
Write the final summary with this structure:

# NEW PATTERNS (not yet in AGENTS.md)

## AGENTS.MD: <pattern name>
Total Frequency: <sum across all files>
Evidence:
- "<best quotes>"
Draft:
<consolidated draft>

## SKILL: <pattern name>
...

## PROMPT-TEMPLATE: <pattern name>
...

---

# EXISTING PATTERNS (already in AGENTS.md, for reference)

## <pattern name>
Total Frequency: <N>
Already covered by: <quote relevant section from AGENTS.md>

---

# SUMMARY
- New patterns to add: <N>
- Already covered: <N>
- Top 3 new patterns by frequency: <list>

Write the final summary to ${finalSummaryPath}`;

	// 汇总子代理同样以 read,write 运行；判断标准是进程成功且 FINAL-SUMMARY.txt 存在。
	const aggregateResult = await runSubagent(aggregationPrompt, outputDir);

	if (aggregateResult.success && existsSync(finalSummaryPath)) {
		console.log(chalk.green(`\n=== Final Summary Created ===`));
		console.log(chalk.green(`  ${finalSummaryPath}`));
	} else if (aggregateResult.success) {
		console.error(chalk.yellow(`Agent finished but did not write final summary`));
	} else {
		console.error(chalk.red(`Failed to create final summary`));
	}
}

// 顶层启动：只注册 console.error 作为拒绝处理，不设置 process.exitCode；
// 因此未显式 process.exit(1) 的异常会被打印但进程仍以 0 退出。
main().catch(console.error);
