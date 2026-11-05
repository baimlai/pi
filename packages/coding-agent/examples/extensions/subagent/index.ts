/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions/subagent 的主模块，主题是“把任务委派给
 * 独立子代理进程”。
 * 上游：模型调用 subagent 工具，参数为 single（agent+task）、parallel（tasks 数组）或
 * chain（chain 数组，任务里可用 {previous}）之一。
 * 下游：node:child_process.spawn 启动 `pi --mode json -p --no-session` 子进程并逐行解析 JSON
 * 事件；discoverAgents 读取代理定义；writePromptToTempFile 把 systemPrompt 写入临时文件并
 * 通过 --append-system-prompt 传入；getPiInvocation 决定用当前脚本还是 `pi` 命令；
 * withFileMutationQueue 串行化临时文件写入；TUI 渲染使用 Container/Markdown/Text/Spacer。
 *
 * 演示的机制：每个子代理都有独立上下文窗口；父子进程只通过 JSON 事件流、退出码和最终
 * assistant 文本通信。parallel 模式最多 8 个任务、4 个并发；chain 模式按顺序执行，把上一步
 * 最终输出替换进 {previous}，任一步失败即停止；每个结果都保留 usage 供渲染与成本统计。
 * 并行输出超过 50KB 时截断正文，但完整内容仍保存在工具 details 中。
 *
 * 能力清单：
 * - formatTokens/formatUsageStats/formatToolCall：用量与工具调用摘要。
 * - SingleResult/SubagentDetails/UsageStats：结果与 details 结构。
 * - getFinalOutput/isFailedResult/getResultOutput/truncateParallelOutput/getDisplayItems。
 * - mapWithConcurrencyLimit：固定 worker 数量的并发映射。
 * - writePromptToTempFile/getPiInvocation：子进程启动辅助。
 * - runSingleAgent：启动一个子代理、解析事件、聚合 usage、处理 abort 与临时文件清理。
 * - 默认导出：注册 subagent 工具，实现 single/parallel/chain 三种调度与 TUI 渲染。
 *
 * 典型运行顺序：模型提供参数 -> 发现代理 -> 校验恰好一种模式 -> 项目代理确认 -> 依次/并发
 * 启动子进程 -> 汇总输出与 usage -> 渲染折叠或展开结果。
 *
 * 示例（真实签名）：
 *   await runSingleAgent(ctx.cwd, dispatchDefaults, agents, "reviewer", task, undefined,
 *     undefined, signal, onUpdate, makeDetails("single"));
 *   子进程参数形如：["--mode", "json", "-p", "--no-session", "--model", "...", "Task: ..."]。
 *
 * 建议阅读顺序：先看结果类型与格式化函数，再看 mapWithConcurrencyLimit/getPiInvocation，
 * 然后精读 runSingleAgent 的 JSON 行解析与 abort 处理，最后看 execute 的三种模式和渲染。
 *
 * 前置条件：需要能找到 pi 可执行文件或当前脚本；代理定义来自同目录 agents.ts；每个子代理都
 * 会产生真实的模型调用与费用。示例不限制子代理的工具写权限，项目级代理运行前会请求确认。
 */

/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	formatReadLineRange,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

// 并行任务总数与并发 worker 数上限；两者独立，避免一次启动过多子进程。
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
// 折叠结果最多显示的事件条数。
const COLLAPSED_ITEM_COUNT = 10;
// 并行模式下每个任务正文的上限（50KB），超出只截断展示，details 保留完整内容。
const PER_TASK_OUTPUT_CAP = 50 * 1024;

// 把 token 数格式化成紧凑字符串；不同量级保留不同精度。
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

// 组合一行 usage：turn 数、输入/输出/缓存 token、成本、上下文与模型名。
// 所有字段为 0 时对应片段被省略；返回空串表示没有可展示信息。
function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	// turns > 1 时用复数；0 不显示。
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	// 成本固定 4 位小数，便于比较小额费用。
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

// 把子代理的工具调用压成一行 TUI 摘要；参数来自 JSON 事件，运行时断言为预期类型。
// 未知工具退回“工具名 + JSON 预览”，保证总有可读输出。
function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	// 把 home 目录替换成 ~，缩短常见绝对路径。
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	// 每种内置工具用专门的摘要格式；参数名兼容 file_path 与 path 两种历史写法。
	switch (toolName) {
		case "bash": {
			// 命令最多预览 60 字符；缺失时显示省略号。
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const lineRange = formatReadLineRange(args.offset, args.limit);
			let text = themeFg("accent", filePath);
			if (lineRange) {
				text += themeFg("warning", lineRange);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

// 单个子代理的用量累计；turns 是助手消息数，contextTokens 取最后一次的 totalTokens。
interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

// 一个子代理调用的完整结果；exitCode -1 在并行模式中表示仍在运行。
interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

// 工具 details：包含模式、代理范围与所有子结果，用于渲染与持久化。
interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

// 取最后一条助手消息中的第一段文本；没有则返回空串。
function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

// 三种失败信号：进程退出码非 0、模型 stopReason 为 error 或 aborted。
function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

// 失败时优先展示 errorMessage，其次 stderr，最后退回 assistant 文本；
// 成功时只展示最终 assistant 文本。
function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

// 按 UTF-8 字节数截断并行输出；逐字符回退，避免切断多字节字符。
function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	// 先按字符切片（可能超出字节上限），再从尾部逐个删除直到满足上限。
	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

// 渲染用事件：文本块或工具调用；args 使用 any 是因为 JSON 事件的参数形状未知。
type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

// 从消息中提取可展示事件，跳过用户/工具结果消息。
function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

// 并发映射：固定 limit 个 worker，从共享 nextIndex 取任务，结果按原下标写回。
// 某个任务 reject 会让 Promise.all 立即 reject；其余 worker 不会被自动取消。
async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	// 并发度至少 1，且不超过任务数。
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	// 创建 limit 个异步 worker；每个循环取下一个下标直到耗尽。
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

// 把 systemPrompt 写入 0600 权限的临时文件，避免长提示词经过命令行参数。
async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	// mkdtemp 生成唯一目录；文件名只保留单词字符、点、横线与下划线。
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	// 与内置工具一致地串行化同一路径写入；mode 0o600 限制其他用户读取。
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

// 决定如何启动子进程：优先用当前脚本；打包运行时退回 `pi` 命令。
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	// Bun 单文件可执行包的虚拟路径不能直接交给 node。
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	// 如果当前可执行文件是 node/bun 本身，说明没有可直接重跑的脚本，改用 PATH 中的 pi。
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

// 启动一个子代理并等待退出：解析 JSON 事件、累计 usage、转发中间更新、处理 abort。
// 返回 SingleResult 而不是抛错（除非被 abort）；未知代理也以 exitCode 1 结果表示。
async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	// 按名称精确匹配；重名已在 discoverAgents 中去重。
	const agent = agents.find((a) => a.name === agentName);

	// 未知代理：构造失败结果，列出可用名称，方便模型修正参数。
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	// 子进程始终使用 JSON 模式、-p（单次执行）与 --no-session（不写会话文件）。
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	// 代理自定义模型优先；未指定时继承父会话模型与思考级别。
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	// tools 逗号分隔；空数组视为不限制。
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	// 临时提示词文件在 finally 中清理；先声明以便失败时也能删除。
	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
	};

	// 把当前已收到的消息作为 partial 结果推给调用方；没有 onUpdate 时是空操作。
	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		// 代理正文非空才写临时文件；通过 --append-system-prompt 追加到默认提示后。
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		// 任务作为最后一个位置参数；子进程按普通提示处理。
		args.push(`Task: ${task}`);
		let wasAborted = false;

		// 等待子进程退出；Promise 只负责把 exit code 变成数字，不在这里抛错。
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			// shell: false 避免命令注入；stdin 关闭，子进程不会等待交互输入。
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			// stdout 可能一次给半个 JSON 行，buffer 保存未完成部分。
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				// 非 JSON 行（例如启动警告）直接忽略。
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				// message_end 是完整消息事件；assistant 消息才累计 usage。
				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							// 缺失字段按 0 处理；cost 取嵌套的 total。
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							// contextTokens 取最新值而不是累加。
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						// 第一次拿到模型名时记录；stopReason/errorMessage 以最后一条为准。
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					// 收到消息就推送一次 partial 更新。
					emitUpdate();
				}

				// 工具结果单独事件；也加入消息列表供渲染。
				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				// 追加到 buffer 后按换行拆行；最后一段可能不完整，留到下次。
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			// stderr 不按行解析，直接累积用于错误展示。
			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				// 进程结束时 buffer 里可能还有最后一行。
				if (buffer.trim()) processLine(buffer);
				// code 为 null（被信号终止）时按 0 处理；abort 由 wasAborted 单独判断。
				resolve(code ?? 0);
			});

			// spawn 失败（找不到命令）时没有 close 事件，直接按退出码 1 处理。
			proc.on("error", () => {
				resolve(1);
			});

			// abort：先 SIGTERM，5 秒后仍未退出则 SIGKILL。
			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				// 监听时 signal 已 abort，立即执行；否则等事件。
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		// abort 被视为异常路径；调用方会捕获并转为失败结果。
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		// 清理临时提示词文件与目录；删除失败不影响结果。
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

// 并行模式的一项任务：agent + task 必填，cwd 可选（默认继承父进程 cwd）。
const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

// 链式模式的一步：task 里可写 {previous}，运行时替换为上一步的最终输出。
const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

// StringEnum 生成带 default 的字符串枚举 schema；运行时由 TypeBox/校验层检查取值。
const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

// 工具参数是联合载荷：agent/task、tasks、chain 三选一，由 execute 里的 modeCount 校验。
const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

// 扩展入口：注册 subagent 工具，含执行逻辑与两套渲染函数。
export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		// 执行入口：先判定模式，再按 chain/parallel/single 分派；参数错误返回文本而不是抛错。
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// agentScope 缺省为 "user"；dispatchDefaults 把父会话的模型与思考级别传给子进程。
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			// 发现代理并读取确认开关；confirmProjectAgents 缺省 true。
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			// 三个模式各自是否提供；modeCount 必须恰好为 1。
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			// 生成 details 构造器：把 mode/scope/代理目录与结果列表打包，供渲染层使用。
			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			// 模式数不为 1 时拒绝执行，并列出可用代理帮助模型纠正参数。
			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// 项目级代理来自仓库文件，属于不可信输入；非受信项目且启用确认时先询问用户。
			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI &&
				!ctx.isProjectTrusted()
			) {
				// 收集本次请求点名的代理（三种模式合并），再筛出 source 为 project 的。
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				// 只有点名了至少一个项目级代理才弹确认。
				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					// 用户拒绝：返回取消结果，不启动任何子进程。
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			// 链式模式：逐步执行，后一步可读取前一步输出。
			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					// 所有 {previous} 都替换为上一阶段完整输出；第一步为空串。
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					// chainUpdate 把“已完成结果 + 当前部分结果”合并后转发，渲染层能看到完整链条。
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					// 第 i+1 步以 i+1 作为 step 编号，仅用于 UI 展示。
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					// 任一步失败即停止链条，返回带 isError 的结果。
					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					// 只有成功时才更新 previousOutput，供下一步替换。
					previousOutput = getFinalOutput(result.messages);
				}
				// 全部成功：返回最后一步输出作为工具结果正文。
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			// 并行模式：所有任务同时启动，受 MAX_CONCURRENCY 限制。
			if (params.tasks && params.tasks.length > 0) {
				// 超过上限直接拒绝，避免创建过多子进程。
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				// 按任务下标预分配槽位，保证流式更新顺序稳定。
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				// 占位结果的 exitCode = -1 表示仍在运行。
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				// 每次状态变化都重新统计 running/done 并整体推送。
				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				// 并发执行；每个任务的部分结果写回自己的下标槽位。
				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					// 完成后用最终结果覆盖占位。
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				// 汇总：成功计数与每个任务的摘要；单个输出按 PER_TASK_OUTPUT_CAP 截断。
				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			// 单代理模式：直接用调用方传入的 onUpdate，流式更新最直观。
			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			// 理论上不可达（modeCount 已校验），保留兜底返回。
			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		// 调用阶段渲染：按 chain/tasks/single 三种参数形状给出摘要，最多预览 3 项。
		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				// 标题行：工具名 + 模式与步数 + 作用域。
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				// 每步一行：序号、代理名、任务预览（去掉 {previous} 占位符）。
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				// 超过 3 步只显示剩余数量。
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				// 并行模式：同样最多预览 3 个任务。
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			// 单代理模式：代理名与任务预览（60 字符截断）。
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		// 结果渲染：details 决定展示哪些结果；无 details 时退回纯文本。
		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			// Markdown 渲染器使用默认 markdown 主题，与工具结果正文一致。
			const mdTheme = getMarkdownTheme();

			// 通用条目渲染：limit 表示只保留最后 N 项，并提示省略数量。
			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						// 折叠时只显示每条文本的前 3 行。
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			// 单代理模式：expanded 时用 Container 逐行组合，否则用单段 Text 折叠展示。
			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						// 展开视图列出所有工具调用，再以 Markdown 渲染最终输出。
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					// usage 行按 token/费用统计；模型名缺失时 formatUsageStats 自行处理。
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				// 折叠视图：标题 + 最多 COLLAPSED_ITEM_COUNT 条记录 + 用量。
				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			// 多结果模式的汇总用量：逐字段相加；contextTokens 不累加故不在此处统计。
			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			// 链式模式：按 step 顺序展示每一步的任务、工具调用与最终输出。
			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					// 末尾追加整条链的总用量。
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				// 折叠视图：每步只保留最近 5 条记录。
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			// 并行模式：先统计运行中/成功/失败数量，决定图标与状态文案。
			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				// 运行中显示沙漏；有失败显示半圆；全部成功显示对勾。
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				// 运行中即使 expanded 也走折叠视图，避免半成品输出频繁重排。
				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				// 折叠或运行中：每个任务一行状态；运行中的任务显示 (running...)。
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				// 运行中不显示总用量（数字仍在变化）；折叠时才提示展开快捷键。
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			// 未知模式兜底：输出纯文本首块。
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
