// bash 与 PowerShell 共用的 shell 执行管线：创建进程、处理取消/超时、合并标准输出和错误、限量展示并保存可回查日志。
import { constants } from "node:fs";
// 给 Node 异步 access 起局部别名 fsAccess，避免与其他同名概念混淆。
import { access as fsAccess } from "node:fs/promises";
// 操作系统信号编号表用于把 SIGTERM 等终止转成 shell 约定的数字退出码。
import { constants as osConstants } from "node:os";
// spawn 创建子进程并返回 stdout/stderr 等流；实际命令副作用从调用它开始。
import { spawn } from "child_process";
// 同一导入里 Static 仅是 TS 类型工具，Type 是运行时 schema 构造对象。
import { type Static, Type } from "typebox";
// 共享等待器处理进程退出及管道收尾，避免后代持有输出管道导致永久等 close。
import { waitForChildProcess } from "../../utils/child-process.ts";
// 按具名导入复用 shell 配置、环境和进程树管理；下面每个名字都有独立用途。
import {
	// 解析本机 bash 的可执行文件、参数和命令传输方式。
	getShellConfig,
	// 得到 Pi 采用的子 shell 环境，后面再按会话填 PI_* 元数据。
	getShellEnv,
	// 取消/超时终止整个命令进程树，而非只杀最外层 shell。
	killProcessTree,
	// 配置解析器返回形状的 TS 类型，运行时擦除。
	type ShellConfig,
	// 登记分离子进程 PID，Pi 全局退出清理能找到它。
	trackDetachedChildPid,
	// 进程收尾后撤销登记，避免保留过时 PID。
	untrackDetachedChildPid,
	// 这组运行时帮助函数和 ShellConfig 类型来自统一 shell 平台适配层。
} from "../../utils/shell.ts";
// 只依赖会话执行上下文与完整工具定义的类型，不在这里加载扩展运行器。
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
// 增量解码输出、有限内存展示末尾并按需保存完整临时日志。
import { OutputAccumulator } from "./output-accumulator.ts";
// 共享 shell 渲染器与进度节流间隔，让命令输出通知和终端刷新节奏一致。
import { BASH_UPDATE_THROTTLE_MS, createShellRenderers } from "./renderers/bash.ts";
// TypeBoxAgentTool 保留参数类型推导，wrapper 把会话定义转为低层 Agent 接口。
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";
// 复用共同显示上限、大小格式化与裁剪详情类型，不复制另一套预算数字。
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

// Node 定时器安全上限；数字中的下划线只提高可读性，不改变数值。
const MAX_TIMEOUT_MS = 2_147_483_647;
/** Output limit of `structuredContent.output`, which programmatic callers such as codemode scripts receive. */
// 程序化结果输出预算为 1MiB，比模型可见的公共 50KB 更大但仍有限。
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;
// 模型参数单位是秒，转换此上限便于给出一致错误提示。
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

/**
 * 将模型给的秒数转成 Node 定时器毫秒，未传则返回 undefined，表示不主动加本工具超时。
 * 例：2.5 秒变 2500 毫秒；0、负数、无穷大或超出定时器范围会抛明确错误，不启动进程。
 */
function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	// 未指定超时就不设置本工具的计时中止；不是默认几秒后结束。
	if (timeout === undefined) return undefined;
	// 模型数值边界：必须有限且为正，不能传 NaN/Infinity/0/负数。
	if (!Number.isFinite(timeout) || timeout <= 0) {
		// 非法超时在启动进程前报错。
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	// 秒乘 1000 变毫秒，支持小数秒。
	const timeoutMs = timeout * 1000;
	// 过大的 setTimeout 值可能溢出成极短延迟，所以明确拒绝。
	if (timeoutMs > MAX_TIMEOUT_MS) {
		// 错误对外仍使用调用参数的秒单位。
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	// 返回可交给 setTimeout 的毫秒值。
	return timeoutMs;
}

// shell 模型调用的运行时输入 schema，bash 与 PowerShell 共用。
const bashSchema = Type.Object({
	// 命令原文是字符串；由 shell 解释，不是一个固定可执行文件名数组。
	command: Type.String({ description: "Shell command to execute" }),
	// 可选数值秒数，合法范围还需 resolveTimeoutMs 的运行时检查。
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

// 给模型的工具说明和环境变量使用建议，不执行命令。
export const bashToolSystemPromptContribution = {
	// 给系统提示词的一行 bash 能力摘要，不会因此立即执行示例命令。
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	// 供模型了解可选会话元数据；只有 exposeSessionEnvironment 允许时下方才把此建议放进工具。
	guidelines: ["You can inspect PI_* environment variables for current model and session details."],
	// 保持字面量与只读类型，避免 TS 把工具提示字段放宽成任意字符串/可变数组；不冻结运行时对象。
} as const;

// Static 由 schema 推导 TS 输入，类型会擦除，实际 JSON 仍由上层 schema 校验。
export type BashToolInput = Static<typeof bashSchema>;

/**
 * Result for programmatic callers such as codemode scripts. A non-zero exit code is an error result for the model, but scripts still resolve to this value.
 * `output` is not limited like the model-facing output: callers decide how much of it reaches the model.
 */
// 程序调用者收到的结构化结果 schema，与模型 content 不同。
const bashOutputSchema = Type.Object({
	// 合并 stdout/stderr 的正文，仍可能被程序化预算截断。
	output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
	// 告诉脚本 output 是否完整，不能仅看字符串像完整就假定无省略。
	truncated: Type.Boolean(),
	// 有可回查完整日志且结果被裁剪时提供文件路径。
	full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
	// 进程退出码：通常 0 成功，非零是命令失败；信号退出也转为数字。
	exit_code: Type.Number(),
	// 从工具执行阶段测得的经过秒数，保留一位小数。
	wall_time_seconds: Type.Number(),
});

// 由结构化输出 schema 推导 TypeScript 类型。
export type BashToolOutput = Static<typeof bashOutputSchema>;

// 终端/日志使用的展示详情，与模型正文及程序化结果分开。
export interface BashToolDetails {
	// 若模型展示内容有裁剪，记录计数和原因。
	truncation?: TruncationResult;
	// 保存完整命令输出的临时日志路径，只有需要保留时才创建。
	fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
// 可替换命令执行后端；默认本地，宿主可注入 SSH 等实现。
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to the exit code. Report signal terminations as 128 + signal number;
	 * a null exit code is treated as a failed command.
	 */
	// 执行函数属性签名，下面类型描述所需输入/输出，本身不是实现。
	exec: (
		// 要由选定 shell 解释的命令全文。
		command: string,
		// 执行命令的工作目录，影响相对路径与程序行为。
		cwd: string,
		// exec 的第三参数是本次执行设置，和创建工具时的 BashToolOptions 不是同一个层级。
		options: {
			// 每来一块 stdout/stderr 原始字节就调用，保持流式输出无需等进程退出。
			onData: (data: Buffer) => void;
			// 可选取消信号，后端应按契约处理取消。
			signal?: AbortSignal;
			// 可选超时秒数，默认本地后端再转毫秒。
			timeout?: number;
			// 可选子进程环境变量映射，包含 undefined 值的 Node 环境形状。
			env?: NodeJS.ProcessEnv;
		},
		// 异步返回退出码；null 表示没拿到有效退出码，上层按失败处理。
	) => Promise<{ exitCode: number | null }>;
}

/** Shared process execution used by the built-in shell tools. */
/**
 * 创建本地命令执行适配器，注入 shell 名称和配置解析函数；工厂无子进程副作用。
 * 返回 exec(command,cwd,options)，实际执行时检查目录、spawn、接输出、挂超时/取消、等待退出并 finally 清理。
 * 命令由选定 shell 解释，可产生用户命令自身的副作用；这里不是只读工具或操作系统沙箱。
 */
export function createLocalShellOperations(shellName: string, resolveShellConfig: () => ShellConfig): BashOperations {
	// 返回本地执行后端对象，真正启动命令的代码保存在下面 exec 回调中。
	return {
		/**
		 * 执行一次命令并持续调用 onData(Buffer)，返回最终 exitCode；取消/超时拒绝 Promise。
		 * shell 配置决定命令通过 argv 还是 stdin 传输；信号退出按 shell 约定转换为 128+信号编号。
		 */
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			// 先校验参数并转换时间，非法值不启动 shell。
			const timeoutMs = resolveTimeoutMs(timeout);
			// 若已经取消立即停止；在等待进程结束后同样再查一次，避免返回成功。
			if (signal?.aborted) {
				// 用共享后端约定的 aborted 错误，工具层随后会补充已产生的输出。
				throw new Error("aborted");
			}
			// 运行时解析当前平台/设置的 shell 可执行文件、参数与命令传输方式。
			const shellConfig = resolveShellConfig();
			// 把工作目录探测单独捕获，以便给出路径相关说明，而不是难以理解的启动错误。
			try {
				// 先确认工作目录能定位，缺路径时给专门错误而非难读的 spawn 失败。
				await fsAccess(cwd, constants.F_OK);
				// access 失败时转成带 shell 名称的目录错误；这一步发生在 spawn 之前。
			} catch {
				// 把工作目录问题与 shell 说明一起返回；F_OK 失败不严格只代表不存在，也可能受访问限制。
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}

			// 某些 shell 配置通过标准输入接收命令，其他配置把命令作为参数。
			const commandFromStdin = shellConfig.commandTransport === "stdin";
			// 真正启动子进程；这里参数数组与 shell 可执行文件分开，命令正文由该 shell 自己解释。
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				// 子进程采用本次准备的工作目录。
				cwd,
				// 非 Windows 创建独立进程组，方便取消时按进程树处理。
				detached: process.platform !== "win32",
				// 传入环境优先，未提供才取 Pi 的标准 shell 环境。
				env: env ?? getShellEnv(),
				// 需要 stdin 传命令时开放输入管道；stdout 和 stderr 都通过管道返回。
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				// Windows 上不为子进程弹出额外控制台窗口。
				windowsHide: true,
			});
			// 仅 stdin 传输配置才把命令写入输入管道。
			if (commandFromStdin) {
				// shell 早退出可能关闭 stdin，原实现忽略写管道错误，主要执行错误仍由进程等待处理。
				child.stdin?.on("error", () => {});
				// 一次写入命令并结束 stdin，让 shell 知道输入完整。
				child.stdin?.end(command);
			}
			// 进程成功取得 PID 后登记，Pi 退出清理也能追踪这些子进程。
			if (child.pid) trackDetachedChildPid(child.pid);
			// 区分定时中止与用户主动取消，给出不同结果文字。
			let timedOut = false;
			// 尚未设置计时器时为 undefined，finally 根据它清理。
			let timeoutHandle: NodeJS.Timeout | undefined;
			/**
			 * 取消回调请求终止整个进程树，避免仅杀 shell 而遗留它启动的后代进程。
			 * 请求 kill 后仍由 waitForChildProcess 等待收尾，不把发信号误当作已经退出。
			 */
			const onAbort = () => {
				// 向整个进程树发结束请求，不只处理最外层 shell。
				if (child.pid) killProcessTree(child.pid);
			};

			// 下面挂定时器/流监听并等待进程；对应 finally 无论哪种出口都清理 PID、定时器与取消监听。
			try {
				// Set timeout if provided.
				// 只有明确传入合法超时才挂定时器。
				if (timeoutMs !== undefined) {
					// 注册将来执行的超时回调，不在定义时立即运行。
					timeoutHandle = setTimeout(() => {
						// 先标记原因，再请求停止进程，等待结束后能识别是超时。
						timedOut = true;
						// 向整个进程树发结束请求，不只处理最外层 shell。
						if (child.pid) killProcessTree(child.pid);
						// 按已校验的毫秒延迟执行超时回调；设定定时器后继续接收正常输出，而不是在此阻塞等待。
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				// 标准输出的数据块交给同一个累计器回调。
				child.stdout?.on("data", onData);
				// 标准错误也合并到输出流中，便于模型看到构建/命令诊断。
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				// 调用方有取消能力才安装/清理信号监听。
				if (signal) {
					// 挂监听前可能已经取消，立即执行终止请求避免错过事件。
					if (signal.aborted) onAbort();
					// 未取消则监听未来一次 abort。
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				// 等待子进程及输出管道收尾，共享等待器处理后代持有管道等情况，避免死等 close。
				const exitCode = await waitForChildProcess(child);
				// 若已经取消立即停止；在等待进程结束后同样再查一次，避免返回成功。
				if (signal?.aborted) {
					// 用共享后端约定的 aborted 错误，工具层随后会补充已产生的输出。
					throw new Error("aborted");
				}
				// 确认退出后再根据标志报告超时，不把定时 kill 的退出码当普通命令失败。
				if (timedOut) {
					// 共享内部错误格式，工具层会转换成面向模型的完整超时说明。
					throw new Error(`timeout:${timeout}`);
				}
				// A signal-killed shell has no exit code. Use the standard shell convention so
				// callers do not mistake the termination for a successful command.
				// 进程因信号退出时通常没有正常退出码，用此信号名转换。
				const signalCode = child.signalCode;
				// 有正常码优先；否则信号按 128+编号，没有信号信息时兜底失败码 1，不误报成功。
				return { exitCode: exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1) };
				// 无论正常退出、取消、超时还是等待器抛错，都撤销执行期资源登记。
			} finally {
				// 运行收尾后撤销 PID 登记，避免退出清理误用已经结束的进程引用。
				if (child.pid) untrackDetachedChildPid(child.pid);
				// 命令提前结束后取消定时器，不能稍后又对已结束 PID 发 kill。
				if (timeoutHandle) clearTimeout(timeoutHandle);
				// 释放取消监听与闭包引用。
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
/**
 * 用共享 shell 后端构造 bash 操作，支持宿主指定 shellPath；返回适配对象，不立即执行。
 * 例：扩展包装 user_bash 时可用它保留 Pi 的取消、超时与输出处理行为。
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	// 传配置解析函数而非立刻执行 shell；shellPath 在每次实际 exec 解析时被读取。
	return createLocalShellOperations("bash", () => getShellConfig(options?.shellPath));
}

// 启动钩子能看到/返回的三项信息，不含命令执行结果。
export interface BashSpawnContext {
	// BashSpawnContext 中的命令全文，允许 spawnHook 在真正启动前变换。
	command: string;
	// BashSpawnContext 中的本次工作目录，不因父进程目录不同而自动改变。
	cwd: string;
	// 子进程环境对象，后面可填当前 PI_* 会话元数据。
	env: NodeJS.ProcessEnv;
}

// 同步启动前变换函数类型，必须返回可继续执行的 command/cwd/env。
export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

/**
 * 构造命令/cwd/env，先清除继承来的旧 PI_* 元数据，再按本次上下文有选择地填入，最后应用 spawnHook。
 * 输入命令与会话信息，输出可启动的普通对象，无子进程副作用；hook 可改 command、cwd 或 env。
 * 例：父进程可能来自另一个 Pi 会话，清掉旧 PI_MODEL 后才写当前模型，避免子命令读到过时身份。
 */
function resolveSpawnContext(
	// 要由选定 shell 解释的命令全文。
	command: string,
	// 执行命令的工作目录，影响相对路径与程序行为。
	cwd: string,
	// 可能未安装钩子，undefined 时使用基础启动配置。
	spawnHook: BashSpawnHook | undefined,
	// 决定是否向命令暴露当前 Pi 元信息，与是否调用 spawnHook 是不同设置。
	exposeSessionEnvironment: boolean,
	// 上下文可能没有，不能凭空构造会话 id 或模型信息。
	ctx: ExtensionContext | undefined,
	// 这个同步准备函数返回确定的 command/cwd/env 对象，没有启动子进程。
): BashSpawnContext {
	// 浅复制环境映射后再改 PI_*，不直接改共享原对象。
	const env = { ...getShellEnv() };
	// 清掉父进程遗留的会话 id，避免子命令误认为仍处在旧会话。
	delete env.PI_SESSION_ID;
	// 移除旧会话文件路径，随后只按当前上下文重填。
	delete env.PI_SESSION_FILE;
	// 移除旧模型供应商信息。
	delete env.PI_PROVIDER;
	// 移除旧模型 id。
	delete env.PI_MODEL;
	// 移除旧思考级别，缺当前值时不能继续沿用父会话的值。
	delete env.PI_REASONING_LEVEL;
	// 同时允许暴露且有真实上下文，才填本次 PI_*。
	if (exposeSessionEnvironment && ctx) {
		// 模型可能未选定，下面分支检查后再提取 provider/id。
		const model = ctx.model;
		// 将当前会话 id 传给命令作为元数据。
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		// 内存会话可能没有持久化文件路径。
		const sessionFile = ctx.sessionManager.getSessionFile();
		// 只有存在实际会话文件时才填该环境项。
		if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		// 选定模型存在时再暴露它的供应商和名字。
		if (model) {
			// 记录当前选中供应商，供用户命令按需读取。
			env.PI_PROVIDER = model.provider;
			// 记录选中模型 id。
			env.PI_MODEL = model.id;
		}
		// 有思考设置时传入，off 也是非空字符串而会被保留。
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	}
	// 组装基础启动对象；属性简写使用同名局部变量。
	const baseContext: BashSpawnContext = { command, cwd, env };
	// 有钩子则让宿主调整启动参数，没钩子直接使用基础对象。
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

// 宿主创建工具时的设置，不是模型可以自行提供的任意环境配置。
export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	// 可替换本地执行后端，例如宿主自行实现远程执行。
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	// 每次用户命令前统一插入的 shell 配置文字。
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	// 可选明确 shell 可执行路径，传给本地配置解析器。
	shellPath?: string;
	/** Expose current Pi session metadata as PI_* environment variables. Default: true */
	// 是否把当前 Pi 元信息暴露为 PI_*，默认 true。
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	// 启动前修改 command/cwd/env 的同步宿主回调。
	spawnHook?: BashSpawnHook;
}

// shell UI 行自己的计时状态，不是模型对话消息。
export type BashRenderState = {
	// 渲染侧开始时间，未开始时 undefined。
	startedAt: number | undefined;
	// 渲染侧结束时间，进行中没有固定终点。
	endedAt: number | undefined;
	// UI 定时刷新用的句柄，结束时需清理。
	interval: NodeJS.Timeout | undefined;
};

// 区分 bash/PowerShell 展示与描述的共享配置，而非命令参数。
export interface ShellToolConfig {
	// 模型调用时使用的工具名。
	name: string;
	// UI 使用的名称。
	label: string;
	// 描述里显示的 shell 品种，例如 PowerShell。
	shellName: string;
	// 终端命令行的提示符，如 $ 或 PS>。
	prompt: string;
	// 系统提示词中该工具的一行用途。
	promptSnippet: string;
	// 可选只读规则数组；readonly 只约束 TS 写操作，不冻结运行时值。
	promptGuidelines?: readonly string[];
	// 大输出日志文件名前缀。
	tempFilePrefix: string;
}

/**
 * 装配一款 shell 工具的 schema、execute 与渲染器，供 bash/PowerShell 复用；构造时不运行命令。
 * 执行：准备命令/环境 → 开输出累计器 → 启动后端并节流通知 → 结束/关闭日志 → 格式化结果与退出码。
 * 例：command:"printf hello" 得到文字 hello；非零退出返回 isError:true 且仍给程序调用者结构化输出。
 */
export function createShellToolDefinition(
	// 执行命令的工作目录，影响相对路径与程序行为。
	cwd: string,
	// 共享工厂接 bash/PowerShell 各自的名称、提示符、日志前缀等展示/说明配置。
	config: ShellToolConfig,
	// 宿主可注入执行后端、shell 路径、前缀与启动 hook；模型参数不能自行修改这些配置。
	options?: BashToolOptions,
	// 三个泛型依次描述输入 schema、结果详情、渲染状态；函数返回完整工具定义。
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	// 自定义操作优先；缺省创建本地 bash 执行后端，共享工厂也可由 PowerShell 显式注入其后端。
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	// 保存宿主统一前置命令，可能没有。
	const commandPrefix = options?.commandPrefix;
	// 默认暴露当前会话元数据；显式 false 不会被 ?? 覆盖。
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	// 保留启动前变换回调，execute 时再调用。
	const spawnHook = options?.spawnHook;
	// 返回这款 shell 的完整 ToolDefinition，执行函数与显示函数都仅在需要时被上层调用。
	return {
		// 同一工厂可生成 bash 或 powershell 的模型工具名。
		name: config.name,
		// 同步使用该 shell 的 UI 名称。
		label: config.label,
		// 模型可见说明由 shell 名称和实际公共预算组成，明确 stdout/stderr 合并、保留尾部、超限日志和可选秒数超时。
		description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		// 沿用各 shell 提供的系统提示词摘要。
		promptSnippet: config.promptSnippet,
		// 只在实际暴露 PI_* 时向模型给出相关建议，避免提示不可用能力。
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		// 两个 shell 共用 command/timeout 参数形状。
		parameters: bashSchema,
		// 程序调用者按结构化输出形状读取 stdout、退出码和耗时。
		outputSchema: bashOutputSchema,
		// 偏好供应商按 schema 产生参数；上层本地校验依然需要。
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		/**
		 * 执行一次模型 shell 调用，接收 command 和可选秒数 timeout，返回异步工具结果；副作用由命令决定。
		 * content 是受行数/字节限制的模型结果；structuredContent 给程序调用者更大但仍有上限的输出。
		 */
		async execute(
			// 统一调用 id，本 shell 执行器未直接用它。
			_toolCallId,
			// 解构模型参数，timeout 可省略；类型说明不会自动设置超时值。
			{ command, timeout }: { command: string; timeout?: number },
			// 本次调用取消信号，继续传给执行后端。
			signal?: AbortSignal,
			// 工具进度订阅回调，可没有；存在时会节流发送输出快照。
			onUpdate?,
			// 执行上下文可能提供会话 cwd 和模型元数据。
			ctx?: ExtensionContext,
		) {
			// 有前缀时在用户命令前插入换行拼接；否则原样保留用户命令。
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			// 把命令、目录、环境和宿主 hook 合成为本次实际启动参数。
			const spawnContext = resolveSpawnContext(
				// 经前缀处理后的命令全文。
				resolvedCommand,
				// 优先当前会话目录，缺少时退回工具默认目录。
				ctx?.cwd || cwd,
				// 可选宿主启动变换函数。
				spawnHook,
				// 是否填本次 PI_* 元数据。
				exposeSessionEnvironment,
				// 将当前会话上下文用于生成元数据，不直接发送给子进程。
				ctx,
			);
			// 建立流式输出累计器，小输出留内存，超限时写完整临时日志并保留展示尾部。
			const output = new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix });
			// 结束后关闭输出入口，避免晚到数据改变最终快照。
			let acceptingOutput = true;
			// 单个待触发进度刷新定时器，undefined 表示没有安排。
			let updateTimer: NodeJS.Timeout | undefined;
			// 新数据到达后置 true，成功发布快照后清 false。
			let updateDirty = false;
			// 最近一次通知时间，用于计算节流剩余等待。
			let lastUpdateAt = 0;

			/**
			 * 把待刷新的累计尾部快照发送给 onUpdate，重置脏标志并记录发送时间；没有订阅者或没有新数据则跳过。
			 * 只是部分进度通知，不是最终 toolResult，必要时会触发完整日志落盘。
			 */
			const emitOutputUpdate = () => {
				// 没有接收者或没有新数据，不做快照/通知工作。
				if (!onUpdate || !updateDirty) return;
				// 当前脏数据即将被快照通知消费。
				updateDirty = false;
				// 更新最近发送时刻，下一块输出按此计算间隔。
				lastUpdateAt = Date.now();
				// 输出过大时保证原文有日志，再取当前尾部与统计。
				const snapshot = output.snapshot({ persistIfTruncated: true });
				// 调用上层提供的进度回调；不是发新的用户或 assistant 对话消息。
				onUpdate({
					// 部分结果用当前尾部正文，空内容显式返回空字符串。
					content: [{ type: "text", text: snapshot.content || "" }],
					// 部分输出通知的详情对象，只携带有用的裁剪统计和日志路径，不是新的完整工具结果。
					details: {
						// 只有确实裁剪才附截断详情，正常小输出不显示无用信息。
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						// 若存在完整日志则同步提供路径。
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			/** 取消尚未触发的节流定时器并清空引用；结束后避免再发过期进度。 */
			const clearUpdateTimer = () => {
				// 确有等待中的刷新定时器才取消。
				if (updateTimer) {
					// 撤销未来刷新，避免结束之后再发部分结果。
					clearTimeout(updateTimer);
					// 清句柄，之后若还有新输出可重新安排。
					updateTimer = undefined;
				}
			};

			/**
			 * 标记有新输出，距离上次通知足够久则立即发，否则只安排一个延迟定时器。
			 * 例：命令一毫秒产生很多小块，不必每块都刷新终端；BASH_UPDATE_THROTTLE_MS 控制最密通知间隔。
			 */
			const scheduleOutputUpdate = () => {
				// 没有进度订阅者就无需安排任何节流定时器。
				if (!onUpdate) return;
				// 标记至少有一块未通知的新输出。
				updateDirty = true;
				// 最小通知间隔减去已过去时间，得到还需等待的毫秒。
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				// 已经超过最小间隔，可以立即刷新。
				if (delay <= 0) {
					// 清理待刷新定时器；避免立即发送后旧定时器又重复发送。
					clearUpdateTimer();
					// 若有新数据就发送当前累计快照，并更新节流时刻。
					emitOutputUpdate();
					// 已立即通知本批新输出，退出安排函数，不再额外注册一个延迟刷新。
					return;
				}
				// ??= 只有句柄为空缺才赋值，连续小块共用一个延迟任务，不重复创建定时器。
				updateTimer ??= setTimeout(() => {
					// 清句柄，之后若还有新输出可重新安排。
					updateTimer = undefined;
					// 若有新数据就发送当前累计快照，并更新节流时刻。
					emitOutputUpdate();
					// 剩余节流等待结束后才执行刷新；delay 来自“最小间隔减已过去时间”。
				}, delay);
			};

			// 存在订阅者时先发一次空初始状态，便于 UI 建立“执行中”的工具行。
			if (onUpdate) {
				// 初始进度没有正文，不应误认为最终工具结果为空。
				onUpdate({ content: [], details: undefined });
			}

			/**
			 * 子进程 stdout/stderr 共用回调，接受原始字节写入累计器并安排 UI 更新。
			 * acceptingOutput=false 后忽略晚到数据，防止输出结束后状态继续变化。
			 */
			const handleData = (data: Buffer) => {
				// 输出已结束就忽略晚到 chunk。
				if (!acceptingOutput) return;
				// 原始 Buffer 交累计器，避免自己把跨 chunk 的 UTF-8 字符拆坏。
				output.append(data);
				// 把当前新数据登记为需要 UI 刷新，按间隔决定立即或稍后发送。
				scheduleOutputUpdate();
			};

			/**
			 * 统一结束输出：停止接收、冲刷解码器、取消延迟、发布最后快照，等待临时文件写完后返回快照。
			 * 供成功、取消、超时错误路径复用；返回 Promise<OutputSnapshot>，不是命令退出码。
			 */
			const finishOutput = async () => {
				// 先关闭输出入口，再制作最终稳定快照。
				acceptingOutput = false;
				// 冲刷增量解码器并标记累计器结束。
				output.finish();
				// 清理待刷新定时器；避免立即发送后旧定时器又重复发送。
				clearUpdateTimer();
				// 若有新数据就发送当前累计快照，并更新节流时刻。
				emitOutputUpdate();
				// 输出过大时保证原文有日志，再取当前尾部与统计。
				const snapshot = output.snapshot({ persistIfTruncated: true });
				// 等待日志写入流完成，随后读取程序化完整输出才不会读到半文件。
				await output.closeTempFile();
				// 返回终结时的正文/统计/日志路径给格式化阶段。
				return snapshot;
			};

			/**
			 * 将累计快照变为模型可读文字与可选详情，超限时解释展示行范围或超长末行，并给完整日志路径。
			 * 输入快照与空输出占位，返回 {text,details}；它不重新执行命令，也不删除日志。
			 */
			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				// 取展示裁剪详情，包含完整总行数与当前展示行数。
				const truncation = snapshot.truncation;
				// 没有任何命令输出时采用调用方的空输出占位，如 (no output)。
				let text = snapshot.content || emptyText;
				// 未裁剪时不需要额外 UI 详情。
				let details: BashToolDetails | undefined;
				// 原始输出有部分省略时，必须提供范围和原文回查路径。
				if (truncation.truncated) {
					// 将裁剪统计和日志路径留给 UI。
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					// tail 保留最后若干行，计算这些行在完整输出中的起始行号。
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					// 保留尾部的末行号就是原输出总行数。
					const endLine = truncation.totalLines;
					// 最后一行本身太大，只返回它末尾一段，不能误称显示了整行。
					if (truncation.lastLinePartial) {
						// 以累计器记录的整条末行字节量解释它为何需要特殊裁剪。
						const lastLineSize = formatSize(output.getLastLineBytes());
						// 末行自己就超限时，提示只保留该行最后多少字节、整行多大，并给完整日志位置。
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
						// 仅行数超限的路径显示保留行范围，不另外声称字节上限已触发。
					} else if (truncation.truncatedBy === "lines") {
						// 按行数限制保留日志末尾，说明当前实际行范围及原总行数，读者不会误以为是完整日志。
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
						// 其余裁剪路径是字节预算限制，使用包含预算大小的提示。
					} else {
						// 字节预算先触及时，除行范围外额外写明上限与日志路径，便于回查未显示部分。
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				// 返回可读正文与结构化显示详情，尚未附命令最终退出状态。
				return { text, details };
			};

			/** 把取消/失败状态接到已有输出后，用空行分隔；无输出时直接返回状态说明。 */
			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;
			// 用单调时钟测耗时，不受系统时钟改动影响。
			const startedAt = performance.now();

			// 外层 try/finally 保证工具任何出口都清掉待刷新定时器，避免结束后继续发进度。
			try {
				// 声明等待后端给出的退出码，null 仍需作为失败处理。
				let exitCode: number | null;
				// 内层 try/catch 专门包装执行后端错误，使取消/超时时也保留已产生的命令输出。
				try {
					// 实际调用本地/注入后端执行准备后的命令，此处产生命令副作用。
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						// stdout/stderr 块都交给累计器入口。
						onData: handleData,
						// 转发本次取消信号。
						signal,
						// 转发模型提供的秒数，默认本地后端负责转换/校验。
						timeout,
						// 传入清理旧元数据、填充新元数据并经 hook 处理后的环境。
						env: spawnContext.env,
					});
					// 后端正常 resolve 后保存退出码，后面决定工具成功或失败。
					exitCode = result.exitCode;
					// 后端拒绝时先完成输出/日志收尾，再区分取消、超时或其他异常；不会把进程错误当空输出成功。
				} catch (err) {
					// 无论正常结束或取消/超时异常，都先完成输出与日志收尾，保留已发生的诊断。
					const snapshot = await finishOutput();
					// 错误路径不添加 (no output) 占位，保留真实已输出文字后再追加错误状态。
					const { text } = formatOutput(snapshot, "");
					// 识别后端取消标记，不把它当作普通命令报错。
					if (err instanceof Error && err.message === "aborted") {
						// 已产生输出加取消说明一起抛给 Agent，帮助用户知道取消前做到了哪里。
						throw new Error(appendStatus(text, "Command aborted"));
					}
					// 识别后端约定的超时原因前缀。
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						// 提取原秒数，使外部提示与用户配置一致。
						const timeoutSecs = err.message.split(":")[1];
						// 将超时和已有输出组合，错误结果中仍可看到最后诊断。
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					// 不属于取消/超时的异常原样继续传播，避免丢失其含义。
					throw err;
				}

				// 无论正常结束或取消/超时异常，都先完成输出与日志收尾，保留已发生的诊断。
				const snapshot = await finishOutput();
				// 解构 text 并改名 outputText，后面再按退出码附失败状态。
				const { text: outputText, details } = formatOutput(snapshot);
				// 没取得退出码不能按成功处理，尤其远程/自定义后端可能返回 null。
				if (exitCode === null) {
					// 报告不确定退出结果，而不伪造 exitCode=0。
					throw new Error(appendStatus(outputText, "Command terminated without an exit code"));
				}
				// 毫秒差转秒并四舍五入到一位小数。
				const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
				// 为脚本读取更大预算的正文，仍可能按 1MiB 保留首尾并省略中间。
				const fullOutput = await output.readFullOutput(STRUCTURED_OUTPUT_MAX_BYTES);
				// 构造输出 schema 对应的程序化结果，非零退出仍可返回该对象。
				const structuredContent: BashToolOutput = {
					// 程序调用者取得的正文，和模型可见 outputText 可能长度不同。
					output: fullOutput.content,
					// 明确程序化正文是否仍有省略。
					truncated: fullOutput.truncated,
					// 只有程序化正文被裁剪且有日志路径时才添加 full_output_path 字段。
					...(fullOutput.truncated && snapshot.fullOutputPath
						? // 条件为真时生成路径字段，帮助脚本回查完整日志。
							{ full_output_path: snapshot.fullOutputPath }
						: // 条件为假展开空对象，不生成一个无用 undefined 路径字段。
							{}),
					// 将确定的数值退出码返回给程序调用者。
					exit_code: exitCode,
					// 将单调时钟测得的耗时写入结构化结果。
					wall_time_seconds: wallTimeSeconds,
				};
				// 命令有正常退出码但失败，仍返回输出和详情，并标工具结果失败。
				if (exitCode !== 0) {
					// 非零退出仍返回工具结果数据，让程序调用者取得正文/退出码，同时通过 isError 标记失败。
					return {
						// 模型结果保留末尾诊断并追加非零退出码说明；下一层还用 isError:true 明确失败状态。
						content: [{ type: "text", text: appendStatus(outputText, `Command exited with code ${exitCode}`) }],
						// 沿用展示裁剪详情，未裁剪时为 undefined。
						details,
						// 保留程序化输出对象，脚本可自己判断退出码和正文。
						structuredContent,
						// 通知 Agent/模型这次命令失败，不能只在正文写失败却把状态当成功。
						isError: true,
					};
				}
				// 成功退出，模型接收较短正文，程序同时保留结构化大输出。
				return { content: [{ type: "text", text: outputText }], details, structuredContent };
				// 最后撤销节流定时器；它可能在各种成功/失败路径上尚未触发。
			} finally {
				// 清理待刷新定时器；避免立即发送后旧定时器又重复发送。
				clearUpdateTimer();
			}
		},
		// 构造对应提示符的 UI 渲染器；渲染不重复执行命令。
		...createShellRenderers(config.prompt),
	};
}

// bash 专属的模型名、终端提示符和日志前缀。
const bashToolConfig: ShellToolConfig = {
	// 模型工具调用名 bash。
	name: "bash",
	// 终端显示名 bash。
	label: "bash",
	// 共享描述中使用的 shell 品种名。
	shellName: "bash",
	// bash 命令行使用 $ 提示符。
	prompt: "$",
	// 复用上面的能力摘要。
	promptSnippet: bashToolSystemPromptContribution.snippet,
	// 复用 PI_* 环境元数据说明。
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	// 大输出日志名用 pi-bash 区分。
	tempFilePrefix: "pi-bash",
};

/** 以 bash 专属名称、提示符和日志前缀调用通用 shell 定义工厂；返回定义，不执行。 */
export function createBashToolDefinition(
	// 执行命令的工作目录，影响相对路径与程序行为。
	cwd: string,
	// 宿主可注入执行后端、shell 路径、前缀与启动 hook；模型参数不能自行修改这些配置。
	options?: BashToolOptions,
	// 三个泛型依次描述输入 schema、结果详情、渲染状态；函数返回完整工具定义。
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	// 将 bash 配置交共享工厂，不复制整套进程/输出逻辑。
	return createShellToolDefinition(cwd, bashToolConfig, options);
}

/**
 * 把 bash 定义适配成低层 AgentTool，并补回提示词摘要/指南。
 * 输入 cwd/options，返回工具对象；调用 execute 才会启动 shell。
 */
export function createBashTool(cwd: string, options?: BashToolOptions): TypeBoxAgentTool<typeof bashSchema> {
	// 先取得完整定义，包含 execute 与提示元数据。
	const definition = createBashToolDefinition(cwd, options);
	// 适配为低层 AgentTool，execute 被调用时才转发。
	const tool = wrapToolDefinition(definition);
	// 把 wrapper 未覆盖的提示词元数据写回工具对象。
	Object.assign(tool, {
		// 保留系统提示词摘要。
		promptSnippet: definition.promptSnippet,
		// 保留工具使用指南。
		promptGuidelines: definition.promptGuidelines,
	});
	// 返回装配好的工具供上层启用，不在工厂时运行 shell。
	return tool;
}
