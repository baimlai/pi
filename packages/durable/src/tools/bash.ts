// 所属：packages/durable/src/tools，Durable 的 shell 执行工具（bash 与 powershell）。
// 解决的问题：模型需要运行命令，但输出可能巨大、命令可能超时，且不同宿主（本地 Node、容器、远端）执行命令的
// 方式不同。这里把参数校验、输出保留策略、spill 文件、超时与退出码统一成一个工具契约，具体进程由 ExecutionEnv
// 的 exec 能力实现。
// 职责边界：只负责构造命令并解释环境返回的结果；不实现 shell、不直接调用 child_process、不保存环境变量，
// 也不把非零退出码转成异常（返回 isError 结果）。真正的取消与进程终止由环境依据 context.abortSignal 完成。
// 上游：Harness ToolTask 调用 createBashTool()/createPowerShellTool() 生成的工具。下游：requireEnv、
// prepareExecution、runCommand、ExecutionEnv.exec，以及 truncate.ts 的默认行/字节上限。
// 能力清单（导出项）：
// - BashToolInput/PowerShellToolInput/ShellStructuredOutput：由 schema 推导的参数和结构化输出类型。
// - BashExecution：准备阶段的命令、cwd、环境变量与继承策略，可被 prepare 原地修改。
// - BashPrepare：执行前回调，可改写 BashExecution；不返回替代对象。
// - BashToolOptions/PowerShellToolOptions：命令前缀、prepare 回调、PowerShell 程序候选列表。
// - createBashTool(options?)：通过环境 shell 执行字符串命令。
// - createPowerShellTool(options?)：直接启动 pwsh/powershell，把脚本作为单个参数，避免其他 shell 再解析。
// 组合与流向：execute → validateTimeout → prepareExecution（含可选 prepare）→ runCommand（顺序尝试候选命令、
// 流式 output、spill 诊断、退出码结果）。bash 只有一个字符串候选，powershell 为每个程序生成一个 argv 候选。
// 示例（真实签名）：
//   const bash = createBashTool({ commandPrefix: "cd project" });
//   // 模型调用 bash({ command: "printf hi", timeout: 2 })：实际脚本为 "cd project\nprintf hi"。
// 建议阅读顺序：先看两个 schema 与 BashExecution/BashPrepare 类型，再看 validateTimeout 和 prepareExecution，
// 然后读 runCommand（核心结果映射），最后看两个工厂的 execute。
import type { Context } from "@earendil-works/chord/context";
import { bool, num, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { defineTool } from "../harness/define.ts";
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "../harness/types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../truncate.ts";
import { requireEnv } from "./env.ts";

// 定时器的最大毫秒整数换算成秒；数字里的下划线只帮助阅读。
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

// Open objects, as the tools accepted extra arguments when their schemas were TypeBox's.
// obj/str/opt/num 构造运行时 schema：command 必填，timeout 可省略；没有在 schema 中限制正数范围。
const bashSchema = obj(
	{
		command: str({ description: "Bash command to execute" }),
		timeout: opt(num({ description: "Timeout in seconds (optional, no default timeout)" })),
	},
	{ open: true },
);

const powershellSchema = obj(
	{
		command: str({ description: "PowerShell command to execute" }),
		timeout: opt(num({ description: "Timeout in seconds (optional, no default timeout)" })),
	},
	{ open: true },
);

/** What a program that calls `bash` or `powershell` receives. */
const shellStructuredOutputSchema = obj(
	{
		output: str({ description: "Combined stdout and stderr: the retained tail, as the model sees it" }),
		truncated: bool({ description: "Whether earlier output was dropped" }),
		fullOutputPath: opt(str({ description: "File with the complete output, when it was spilled" })),
		exitCode: num(),
	},
	{ open: true },
);

// Static 从 schema 推导 TypeScript 参数类型；运行时 JSON 的实际检查仍由 Harness 校验 schema 完成。
export type BashToolInput = Static<typeof bashSchema>;
export type PowerShellToolInput = Static<typeof powershellSchema>;
export type ShellStructuredOutput = Static<typeof shellStructuredOutputSchema>;

/** A command about to run, which `prepare` may change: the script, its working directory and environment. */
export interface BashExecution {
	// prepare 可以直接修改这些字段；这是准备执行的数据，还没有启动进程。
	command: string;
	cwd: string;
	env: Record<string, string>;
	inheritEnv: boolean;
}

// 函数类型：接收可变执行数据、调用接口、上下文；可以同步结束或返回异步 Promise，不返回替代对象。
export type BashPrepare = (execution: BashExecution, api: ToolExecutionApi, context: Context) => void | Promise<void>;

export interface BashToolOptions {
	// ? 表示配置项可缺省；前缀是实际脚本文本，不是对命令的转义。
	commandPrefix?: string;
	prepare?: BashPrepare;
}

export interface PowerShellToolOptions {
	/** Lines run before each command. */
	commandPrefix?: string;
	prepare?: BashPrepare;
	/** PowerShell programs to try in order; default `pwsh`, then `powershell`. A program that cannot start is skipped. */
	programs?: readonly string[];
}

/**
 * 检查可选秒数 timeout 的数值策略，成功不返回值；省略表示不设超时。
 * 对非有限数、非正数和超过定时器范围的数抛错，不启动进程。例如 0 失败、0.5 可通过。
 * schema 的 number 类型不表达这些范围，所以仍需要这一步运行时策略检查。
 */
function validateTimeout(timeout: number | undefined): void {
	// undefined 是合法的“没有超时”，立即结束检查。
	if (timeout === undefined) return;
	// Number.isFinite 排除 NaN/Infinity；这里只检查数值含义，不重复判断 typeof。
	if (!Number.isFinite(timeout) || timeout <= 0) {
		// 统一报告有限正秒数要求。
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	// 上界避免秒数转毫秒后超出定时器可表示范围。
	if (timeout > MAX_TIMEOUT_SECONDS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
}

/** The execution of one call: the command with its prefix, in the environment's working directory, then `prepare`. */
/**
 * 根据 command、可选 options 和 api 环境构造 BashExecution，再等待 prepare 修改它；context 原样传入回调。
 * 返回同一执行数据对象，不执行命令；无环境或 prepare 拒绝时向外抛错。
 * 例如 commandPrefix="cd project" 时，前缀与命令用换行连接；prepare 随后仍可更改 cwd/env/command。
 */
async function prepareExecution(
	command: string,
	options: { commandPrefix?: string; prepare?: BashPrepare } | undefined,
	api: ToolExecutionApi,
	context: Context,
): Promise<BashExecution> {
	// 显式类型检查这四个字段；对象将交给 prepare 原地修改。
	const execution: BashExecution = {
		// ?. 安全读取可能不存在的配置；只有非空前缀才拼接换行。
		command: options?.commandPrefix ? `${options.commandPrefix}\n${command}` : command,
		// 从本次调用环境取得 cwd，可能是远端路径，不取 Node 自己的 cwd。
		cwd: requireEnv(api).cwd,
		// env 是额外环境变量，inheritEnv:true 表示还继承环境自身的变量。
		env: {},
		inheritEnv: true,
	};
	// 两层可选调用允许 options 或 prepare 缺省；await 同时兼容 void 和 Promise<void>。
	await options?.prepare?.(execution, api, context);
	// 回调无返回数据契约，最终采用它修改过的 execution。
	return execution;
}

/**
 * Run each command form in turn until one starts, streaming output to `api.output()` within the retained window, and
 * turn the result into the tool's result: a spill diagnostic, an error result for a nonzero exit, and a thrown error for
 * a failure such as a timeout. The structured output repeats the retained output with the exit code.
 */
/**
 * 在同一个 execution 配置下依次尝试 commands；timeout 为秒，api 接收流式输出与诊断，context 控制取消。
 * 只有启动失败 spawn_error 才尝试下一个形式；返回结构化的保留尾部输出及退出码。
 * 会启动环境进程，输出过大时环境可写临时文件；超时/取消/环境失败抛错，非零退出返回 isError。
 * 例如 PowerShell 先试 pwsh，仅无法启动它时才试 powershell；脚本以 1 退出不会再执行第二遍。
 */
async function runCommand(
	commands: readonly (string | readonly string[])[],
	execution: BashExecution,
	timeout: number | undefined,
	api: ToolExecutionApi,
	context: Context,
): Promise<ToolExecutionResult> {
	// requireEnv 保证本次调用有提供 exec 能力的环境。
	const env = requireEnv(api);
	// ReturnType 取得 env.exec 的 Promise 类型，Awaited 取出其 Result；没有候选命令时保留 undefined。
	let result: Awaited<ReturnType<typeof env.exec>> | undefined;
	// string 通过环境 shell 解释；字符串数组直接启动首元素程序，其余元素作为实参。
	for (const command of commands) {
		// await 等待本候选结束，执行期间 onOutput 可多次被调用。
		result = await env.exec(
			command,
			{
				// 使用 prepare 最终确定的工作目录、额外变量和继承策略。
				cwd: execution.cwd,
				env: execution.env,
				inheritEnv: execution.inheritEnv,
				// 对象展开只在提供 timeout 时加该属性，不擅自设置默认秒数。
				...(timeout === undefined ? {} : { timeout }),
				// 忽略回调给出的重复上下文，把文本和环境跳过计数一起交给 Harness 输出缓冲区。
				onOutput: (text, _context, info) => api.output(text, info.skipped),
				// 超出任一阈值时要求环境把完整原始输出保存到临时文件。
				spill: { afterBytes: DEFAULT_MAX_BYTES, afterLines: DEFAULT_MAX_LINES },
				// An environment may then omit output outside the retained tail and report the omission.
				...(api.outputWindow === undefined ? {} : { window: api.outputWindow }),
			},
			context,
		);
		// A program that could not start produced no output; the next form may.
		// 成功启动后的任何结果都停止尝试；只有根本无法启动程序才换下一个。
		if (result.ok || result.error.code !== "spawn_error") break;
	}
	// 自定义 programs 可以给空列表；此时没有执行结果，明确报错。
	if (result === undefined) throw new Error("No command to run");
	// 成功和失败都可能留下完整输出文件，例如超时前已产生大量文本。
	const spillPath = result.ok ? result.value.spillPath : result.error.spillPath;
	// 先发布路径诊断，即使下面抛错，调用层仍可保留这个诊断。
	if (spillPath !== undefined) {
		api.diagnostic({ severity: "info", code: "full_output", message: `Full output: ${spillPath}` });
	}
	if (!result.ok) {
		// 真正的上下文取消保留原 ExecutionError，便于上层识别取消来源。
		if (result.error.code === "aborted" && context.abortSignal?.aborted) throw result.error;
		// 超时与非上下文发起的终止转为面向调用者的普通错误。
		if (result.error.code === "timeout") throw new Error(`Command timed out after ${timeout} seconds`);
		if (result.error.code === "aborted") throw new Error("Command aborted");
		// 其他失败保留环境给出的错误对象。
		throw result.error;
	}
	// 此处 Result 已收窄为 ok；退出码非零仍是环境 exec 的成功返回。
	const exitCode = result.value.exitCode;
	// 读取 Harness 已按限制留下的尾部，而不是重复拼接所有流式输出。
	const retained = api.retainedOutput();
	// structuredOutput 给程序调用者；省略 output 则模型使用 api.output 保留的文本。
	const structuredOutput: ShellStructuredOutput = {
		output: retained.text,
		truncated: retained.truncated,
		...(spillPath === undefined ? {} : { fullOutputPath: spillPath }),
		exitCode,
	};
	// 0 是工具成功；其他退出码连同同一份结构化输出标为工具错误。
	if (exitCode === 0) return { structuredOutput };
	// as const 保留 severity 的字面量类型，不会冻结对象。
	const exited = { severity: "error", code: "exit_code", message: `Command exited with code ${exitCode}` } as const;
	return { structuredOutput, isError: true, diagnostics: [exited] };
}

/**
 * Runs a command through the environment's shell. Its output streams to `api.output()`, where the Harness keeps the
 * tail within the default limits; the result content is that retained output. The retained window goes to the
 * environment, which may omit output outside it and report how much it omitted, so dropped counts stay exact. Output
 * beyond the limits is spilled to a file whose path is reported as a diagnostic. A nonzero exit is an error result with
 * the exit code; a timeout throws, which makes an error result that still carries the output and diagnostics.
 */
/**
 * 创建 bash 工具；options 可注入脚本前缀和准备回调，返回注册描述，创建时不运行命令。
 * execute 校验秒数、准备执行配置，再调用环境 shell；其输出、异常与副作用由 runCommand 统一处理。
 * 例如执行 { command:"printf hello", timeout:2 } 会在配置环境 cwd 中运行并返回保留的输出。
 */
export function createBashTool(options?: BashToolOptions): ToolRegistration<typeof bashSchema> {
	// defineTool 在编译时根据 parameters 推导 execute.args，运行时原样返回对象。
	return defineTool({
		name: "bash",
		description: `Execute a bash command in the current working directory. Returns combined stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		structuredOutputSchema: shellStructuredOutputSchema,
		// 保留最后的输出窗口，便于看到命令结尾的错误；总阈值使用 Harness 默认值。
		outputLimits: { retain: "tail" },
		// args 已经通过 schema 校验，但 timeout 的正数/上界规则仍在函数内检查。
		async execute(args, api, context) {
			// 不合法秒数在创建进程之前失败。
			validateTimeout(args.timeout);
			// 等待可选 prepare，保证它的 cwd/env 修改完成。
			const execution = await prepareExecution(args.command, options, api, context);
			// 这里只有一个字符串候选，交由环境 shell 解析整个脚本。
			return runCommand([execution.command], execution, args.timeout, api, context);
		},
	});
}

/** Output in UTF-8 whatever the console's code page, as the coding agent's `powershell` tool does. */
const UTF8_OUTPUT = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}";
// as const 让参数表成为只读字面量元组；执行时通过展开复制进命令数组。
const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

/**
 * Runs a PowerShell command, like `bash` but through PowerShell instead of the environment's shell: `pwsh` (PowerShell
 * 7), else Windows PowerShell, started directly with the command as an argument, so no other shell parses it.
 */
/**
 * 创建 powershell 工具，options 可配置前缀、prepare 和按顺序尝试的程序名。
 * 返回注册定义；真正 execute 时设置 UTF-8 控制台输出，再以独立参数启动 PowerShell。
 * 错误和输出策略同 runCommand。例如 programs:["pwsh"] 只尝试该程序，不会自动补试 powershell。
 */
export function createPowerShellTool(options?: PowerShellToolOptions): ToolRegistration<typeof powershellSchema> {
	// ?? 只在 programs 是 undefined/null 时用默认；显式 [] 不会被替换。
	const programs = options?.programs ?? ["pwsh", "powershell"];
	return defineTool({
		name: "powershell",
		description: `Execute a PowerShell command in the current working directory. Returns combined stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		parameters: powershellSchema,
		structuredOutputSchema: shellStructuredOutputSchema,
		outputLimits: { retain: "tail" },
		// 此回调只在调用工具时运行；工厂本身不触发 prepare 或进程。
		async execute(args, api, context) {
			// 和 bash 使用同一套超时数值策略。
			validateTimeout(args.timeout);
			// 可选准备回调可调整脚本、cwd 与环境变量。
			const execution = await prepareExecution(args.command, options, api, context);
			// 固定 UTF-8 前导与准备好的命令以换行组成单一 -Command 参数。
			const script = `${UTF8_OUTPUT}\n${execution.command}`;
			// map 每个程序名得到一个 argv；不经过另一个 shell 的再次解析。
			const commands = programs.map((program) => [program, ...POWERSHELL_ARGS, script]);
			// 顺序尝试启动，流式输出与退出结果沿用共享逻辑。
			return runCommand(commands, execution, args.timeout, api, context);
		},
	});
}
