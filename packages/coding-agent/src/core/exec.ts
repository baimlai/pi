// 供扩展/自定义工具执行本地程序：按argv启动、分开收集stdout/stderr，支持取消、超时和合并字节上限。
// 与BashOperations包装不同，这里使用Node spawn且shell:false，command/args不会自动按shell语法解释。
/**
 * Shared command execution utilities for extensions and custom tools.
 */

// 读取运行时最大字符串长度常量，避免默认缓存上限超过Node可表示范围。
import { constants as bufferConstants } from "node:buffer";
// Node原生spawn，不是cross-spawn包装；调用后立即得到ChildProcess对象。
import { spawn } from "node:child_process";
// 跨数据块保留UTF-8半个字符，避免每块单独toString造成损坏。
import { StringDecoder } from "node:string_decoder";
// 等待退出及管道收尾；底层对后代持有stdio的情况使用退出后空闲等待，不等无限close。
import { waitForChildProcess } from "../utils/child-process.ts";

// 默认256MiB并受运行时字符串长度限制；实际累计按原始Buffer字节，不是JS字符串length。
const DEFAULT_EXEC_MAX_BUFFER = Math.min(256 * 1024 * 1024, bufferConstants.MAX_STRING_LENGTH);
// 先SIGTERM，若仍未退出，5秒后尝试SIGKILL；不代表5秒内必然已终止。
const FORCE_KILL_DELAY_MS = 5000;

/**
 * Options for executing shell commands.
 */
// 命令执行选项；此接口没有env或shell字段，cwd如何使用见实际调用入口。
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	// 取消信号，可能在启动程序后才检查已取消状态。
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	// 正数毫秒才启动超时定时器；0、负数或缺省在本实现不启动它。
	timeout?: number;
	/** Working directory */
	// 扩展接口上层可读取这个cwd选项；本函数实际spawn使用独立第三参数cwd，不再次读取options.cwd。
	cwd?: string;
	/**
	 * Combined stdout/stderr byte limit; exceeding it terminates the command with `truncated: true`.
	 * Nonnegative integer up to the runtime string limit. Default: 256 MiB, capped by that limit.
	 */
	// stdout与stderr共享的原始字节上限；必须有限非负整数，显式0合法。
	maxBuffer?: number;
}

/**
 * Result of executing a shell command.
 */
// 一次执行结果；即使非零退出码也可正常resolve，而非总是抛异常。
export interface ExecResult {
	// 标准输出UTF-8文字。
	stdout: string;
	// 标准错误文字，某些spawn错误会作为后备错误说明写入。
	stderr: string;
	// 归一化退出码；单纯被信号结束导致null时这里可变成0，不能只凭code推断所有结束原因。
	code: number;
	/** The command was terminated by pi: timeout, abort, or output over `maxBuffer`. */
	// 本包装器是否调用过killProcess，不是内核确认已彻底杀完所有子孙进程的证明。
	killed: boolean;
	/** Output exceeded `maxBuffer`; stdout and stderr are incomplete and `code` is nonzero. */
	// 是否越过输出上限；一旦为true，结果code会被保证非零。
	truncated: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout, abort signal, and an output cap (`maxBuffer`).
 */
/**
 * 执行command+args并返回输出/状态；先验证maxBuffer，再spawn，收集两个管道，结束时清理监听与计时器。
 * 例：execCommand(process.execPath,["-e","console.log(1)"],cwd)返回stdout中的1；"echo x | wc"不会因shell:false被自动当管道解析。
 * 无效maxBuffer抛RangeError；ENOENT等Error通常转code=1。超时/取消先发SIGTERM，必要时再发SIGKILL，仅针对此proc；不把它称为进程树清理。
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	// ??保留显式0，缺省才使用默认上限。
	const maxBuffer = options?.maxBuffer ?? DEFAULT_EXEC_MAX_BUFFER;
	// number类型不能表达非负整数上界，因此这里检查选项的数值约束，不是重复typeof类型检查。
	if (!Number.isInteger(maxBuffer) || maxBuffer < 0 || maxBuffer > bufferConstants.MAX_STRING_LENGTH) {
		// 非法上限在spawn前拒绝，不尝试执行程序。
		throw new RangeError(`maxBuffer must be an integer between 0 and ${bufferConstants.MAX_STRING_LENGTH} bytes`);
	}

	// 以command和独立args数组启动程序，不自行拼shell命令串。
	const proc = spawn(command, args, {
		// 使用第三参数cwd作为工作目录。
		cwd,
		// 明确不由Node额外包一层shell；需要shell时调用方可显式把shell程序当command。
		shell: false,
		// stdin忽略，stdout/stderr设管道以便捕获。
		stdio: ["ignore", "pipe", "pipe"],
	});

	// 两个字符串独立累计，不能据此复原stdout/stderr原始交错顺序。
	let stdout = "";
	// stderr初始为空，后续也可能承载spawn异常信息。
	let stderr = "";
	// Decode across chunks: a multi-byte UTF-8 character can be split between two chunks,
	// and decoding each chunk separately would corrupt it (earendil-works/pi#11312).
	// stdout用自己的UTF-8解码状态。
	const stdoutDecoder = new StringDecoder("utf8");
	// stderr另用解码器，防止把两个流的半字符拼在一起。
	const stderrDecoder = new StringDecoder("utf8");
	// 共享字节额度累计器。
	let outputBytes = 0;
	// 截断标志初始false，一旦超上限后不再接收新输出。
	let truncated = false;
	// killProcess是否已经发起过结束动作，用于避免重复安排计时器。
	let killed = false;
	// 可选超时句柄，清理时undefined也可传clearTimeout。
	let timeoutId: NodeJS.Timeout | undefined;
	// 可选强制结束句柄。
	let forceKillId: NodeJS.Timeout | undefined;

	/**
	 * 局部结束函数只执行一次：标记killed、发SIGTERM，再安排5秒后的状态检查；返回void。
	 * 例：输出超限与用户取消几乎同时触发，只会首次安排强制结束计时器。发送信号并不证明已经退出。
	 */
	const killProcess = () => {
		// 重复触发直接跳过，防止不断重置宽限期。
		if (killed) return;
		// 先置标志，后续同名回调不会再进入发送分支。
		killed = true;
		// 尝试向当前子进程发SIGTERM；未在此枚举或杀死整个进程树。
		proc.kill("SIGTERM");
		// 保存延后检查的计时器，退出后finally会清掉它。
		forceKillId = setTimeout(() => {
			// `proc.killed` only says a signal was sent, so check whether the child actually exited.
			// 两个退出字段都仍null才认为未观察到退出；proc.killed只表示发送过信号，不能用它判断。
			if (proc.exitCode === null && proc.signalCode === null) {
				// 仍未退出就尝试更强的SIGKILL，实际平台行为由Node/操作系统决定。
				proc.kill("SIGKILL");
			}
			// 定时器延迟常量，不是整个函数完成的硬期限。
		}, FORCE_KILL_DELAY_MS);
	};

	// 传了取消信号才订阅。
	if (options?.signal) {
		// 已取消也仍已spawn，立刻请求结束新进程。
		if (options.signal.aborted) {
			// 复用相同kill逻辑。
			killProcess();
		} else {
			// once只触发一次，finally还会尝试移除监听。
			options.signal.addEventListener("abort", killProcess, { once: true });
		}
	}

	// 同时要求真值且大于0，未验证任意正数是否适合setTimeout的全部平台范围。
	if (options?.timeout && options.timeout > 0) {
		// 超时后同样调用killProcess，而非直接拒绝Promise。
		timeoutId = setTimeout(killProcess, options.timeout);
	}

	// Keep only bytes within the combined cap (#11360). Close both pipes on overflow so writing
	// descendants cannot keep waitForChildProcess busy after the child exits. Pausing is not
	// enough: Node resumes the child's stdio on exit.
	/**
	 * 局部字节裁剪器：在两个流共享额度内保留Buffer，首次超限销毁两管道并请求结束。
	 * 例：还剩3字节收到5字节，只返回前3；半个UTF-8字符留给解码器，截断后不强制补成替代字符。
	 */
	const takeWithinCap = (data: Buffer): Buffer | undefined => {
		// 超限后后续块全部舍弃，不继续重复杀进程。
		if (truncated) return undefined;
		// 剩余额度由共享已接收字节数计算。
		const remaining = maxBuffer - outputBytes;
		// 等于剩余额度仍完整接受，只有严格超出才截断。
		if (data.length <= remaining) {
			// 完整接受时累加实际Buffer长度。
			outputBytes += data.length;
			// 直接返回同一Buffer，不复制。
			return data;
		}
		// 首次越界设置标志。
		truncated = true;
		// 销毁stdout管道，防止后代持续写入使收尾等待无法空闲。
		proc.stdout?.destroy();
		// stderr也销毁，两个流的额度和关闭动作一起处理。
		proc.stderr?.destroy();
		// 输出超限是结束原因之一。
		killProcess();
		// subarray返回同一Buffer背后的切片视图；没额度时undefined。
		return remaining > 0 ? data.subarray(0, remaining) : undefined;
	};

	// stdout每次data事件处理原始Buffer。
	proc.stdout?.on("data", (data: Buffer) => {
		// 先裁字节额度再解码，避免先生成大字符串。
		const chunk = takeWithinCap(data);
		// 解码器只追加完整字符；半字符保留在decoder内部。
		if (chunk) stdout += stdoutDecoder.write(chunk);
	});

	// stderr独立监听但使用同一裁剪器。
	proc.stderr?.on("data", (data: Buffer) => {
		// 它会消耗同一剩余额度，事件到达顺序影响哪部分被保留。
		const chunk = takeWithinCap(data);
		// 追加stderr已接受的完整UTF-8文字。
		if (chunk) stderr += stderrDecoder.write(chunk);
	});

	// Node正常退出码也可能null，例如因信号结束。
	let code: number | null;
	// 捕获等待阶段错误并保证清理；spawn调用本身发生在这个try之前。
	try {
		// Do not hang on inherited stdio handles held open by detached descendants.
		// 等待退出和必要管道收尾，不承诺每个后代都已经终止。
		code = await waitForChildProcess(proc);
		// 进入等待异常处理。
	} catch (error) {
		// 非Error抛出值原样拒绝，不强行转为普通失败结果。
		if (!(error instanceof Error)) throw error;
		// Child-process errors (e.g. ENOENT) are failed executions, not host failures.
		// Error形式的子进程故障归为执行失败码1。
		code = 1;
		// 只有尚无stderr时才把error.message补进去，保留已收集错误输出。
		if (!stderr) stderr = error.message;
		// 成功、执行失败或异常退出都清理本函数资源。
	} finally {
		// 停止未触发的超时计时器。
		clearTimeout(timeoutId);
		// 停止未触发的SIGKILL计时器。
		clearTimeout(forceKillId);
		// 取消信号存在时移除本函数注册的回调。
		options?.signal?.removeEventListener("abort", killProcess);
	}

	// On truncation, discard any incomplete UTF-8 suffix buffered by either decoder.
	// Flushing it would append a replacement character that was not in the accepted output.
	// 没有截断才冲刷两个解码器的末尾；自然EOF的残缺字符可生成Unicode替代字符。
	if (!truncated) {
		// 追加stdout残余解码结果。
		stdout += stdoutDecoder.end();
		// 追加stderr残余解码结果。
		stderr += stderrDecoder.end();
	}

	// null退出码回退0；killed/truncated仍提供额外状态，0不证明一切正常。
	const exitCode = code ?? 0;
	// 返回结果对象，通常resolve而非按非零码抛错。
	return {
		// 属性简写保留stdout。
		stdout,
		// 属性简写保留stderr。
		stderr,
		// A truncated result must never read as success.
		// 若确实截断且归一化码恰好0，强制改1；其他非零码保留。
		code: truncated && exitCode === 0 ? 1 : exitCode,
		// 报告本包装器是否请求过结束。
		killed,
		// 报告输出是否因上限不完整。
		truncated,
	};
}
