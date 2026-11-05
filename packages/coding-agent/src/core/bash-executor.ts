// 包装可替换的BashOperations，统一清理输出、流式显示、保留尾部和大输出临时文件；AgentSession的!命令等路径使用它。
// 实际本地/远端启动由operations提供；本文件不能单凭接口保证取消已杀完远端进程。
/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

// 写流类型只用于注解，实际流由output-files辅助创建。
import type { WriteStream } from "node:fs";
// 在辅助函数256码元保留窗口内尽力拼接跨块ANSI序列再清理；超长未完整序列不保证都能拼接。
import { splitIncompleteAnsiSuffix, stripAnsi } from "../utils/ansi.ts";
// 输出过大时建立本机临时文件，即使实际命令在远端执行。
import { createOutputFileStream } from "../utils/output-files.ts";
// 复用二进制乱码清理，之后另去掉回车字符。
import { sanitizeBinaryOutput } from "../utils/shell.ts";
// 可替换exec接口，支持注入SSH/容器等实现；类型不自动验证远端执行行为。
import type { BashOperations } from "./tools/bash.ts";
// 最终显示使用统一尾截断规则和默认字节阈值。
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

// ============================================================================
// Types
// ============================================================================

// 本包装的可选流式回调与取消选项，不含独立timeout字段。
export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	// 接收已清理文字块；回调同步执行，抛错会影响执行流程。
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	// 信号传给operations，结束后也读取它标记是否取消。
	signal?: AbortSignal;
}

// 显示输出和执行状态，临时文件可另保存更完整的清理后文字。
export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	// 合并的清理后输出，必要时仅返回尾部；不保留stdout/stderr分流信息。
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	// 取消时强制undefined；其他情况底层exitCode为null也转undefined，不能假定每次都有数字。
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	// 结束时signal.aborted的状态，不是独立检测进程树已停止。
	cancelled: boolean;
	/** Whether the output was truncated */
	// 最终truncateTail是否裁剪，不等于临时文件是否存在。
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	// 可选的本机文件路径；end()不等于这里已经等待磁盘全部写完。
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
/**
 * 用operations执行command/cwd，收集原始Buffer并清理，返回可展示尾部与可选完整日志路径。
 * 例：远端exec不断onData时，onChunk同步显示清理文字；输出超默认阈值后开始写本机日志。取消导致exec拒绝时仍可返回已收到的输出，非取消异常则抛。
 * 不await写流完成、不处理write()背压；内存滚动计量用字符串length，单个大块也可超过目标，不能称为严格字节内存上限。
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	// 保存最近文字块，最终join成显示候选。
	const outputChunks: string[] = [];
	// 虽然名为Bytes，这里实际累加JS字符串length（UTF-16码元），不是Buffer字节。
	let outputBytes = 0;
	// 滚动缓冲目标是默认阈值的两倍；最终truncateTail仍用自己的限制。
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	// 临时文件懒创建，普通小输出不必有路径。
	let tempFilePath: string | undefined;
	// 写流引用初始undefined，创建后才可write/end。
	let tempFileStream: WriteStream | undefined;
	// 累计底层原始Buffer字节数，和outputBytes的计量不同。
	let totalBytes = 0;

	/**
	 * 局部辅助仅首次创建日志，并把此前保留的清理文字写进去，后续直接返回。
	 * 例：刚跨字节阈值时，旧块先补写，当前新块随后由appendText写；文件打开/写入完成是异步流行为。
	 */
	const ensureTempFile = () => {
		// 有路径意味着已创建过流，不因后续反复调用而建多个文件。
		if (tempFilePath) {
			// 重复调用不写一次旧块，避免日志重复。
			return;
		}
		// 解构赋值外面加括号，避免{...}被解析成语句块；同时更新路径和流两个外层变量。
		({ path: tempFilePath, stream: tempFileStream } = createOutputFileStream("pi-bash", ".log"));
		// 遍历此前缓冲的清理后块，不是原始二进制数据。
		for (const chunk of outputChunks) {
			// write()排入写流，返回的背压布尔值未处理。
			tempFileStream.write(chunk);
		}
	};

	// 默认TextDecoder按UTF-8跨块解码。
	const decoder = new TextDecoder();
	// Unfinished escape sequence at the end of the previous chunk, completed by the next chunk.
	// 保留块尾尚不完整的ANSI序列，下一块再拼接。
	let pendingAnsi = "";

	/**
	 * 局部追加器：清理ANSI/乱码/回车，必要时写日志并更新滚动块，最后同步回调。
	 * 例：只含控制字符的一块清理后为空，直接忽略，不调用onChunk。它捕获外层计数/文件状态，而不是纯字符串函数。
	 */
	const appendText = (rawText: string) => {
		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		// 从内到外执行stripAnsi、乱码清理，再全局删除\r；不是把每个\r改成换行。
		const text = sanitizeBinaryOutput(stripAnsi(rawText)).replace(/\r/g, "");
		// 空文字不进日志、缓冲和回调。
		if (!text) {
			// 提前返回本次追加，不中断整个exec。
			return;
		}

		// Start writing to temp file if exceeds threshold
		// 原始累计字节严格大于默认值才建日志，等于时不由此分支建。
		if (totalBytes > DEFAULT_MAX_BYTES) {
			// 首次会补写之前块，之后不重复创建。
			ensureTempFile();
		}

		// 已创建日志才保存当前文字。
		if (tempFileStream) {
			// 写入的是清理后的文本，不能当原始stdout字节备份。
			tempFileStream.write(text);
		}

		// Keep rolling buffer
		// 当前文字追加到滚动缓冲。
		outputChunks.push(text);
		// length按码元计量，多字节中文与原始字节数不相等。
		outputBytes += text.length;
		// 超目标且至少两块时删最旧块；保留最后一块，单块很大时不会继续拆小。
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			// shift删除首项；!由长度条件支持，非空断言不生成检查。
			const removed = outputChunks.shift()!;
			// 减掉被删字符串的码元长度。
			outputBytes -= removed.length;
		}

		// Stream to callback
		// 有回调才同步调用，不await其可能的异步尾部。
		if (options?.onChunk) {
			// 传当前清理块，不重复传整个累计输出。
			options.onChunk(text);
		}
	};

	/**
	 * 底层数据回调按Buffer更新原始字节量，再流式解码和完整ANSI分割。
	 * 例：UTF-8中文或转义序列跨两个Buffer，decoder/pendingAnsi负责把它们接起来。
	 */
	const onData = (data: Buffer) => {
		// Buffer.length才是原始字节数，清理会使最终文字更短。
		totalBytes += data.length;
		// 对象解构得到完整前缀和未完整尾缀；stream:true不冲刷UTF-8半字符。
		const { complete, pending } = splitIncompleteAnsiSuffix(pendingAnsi + decoder.decode(data, { stream: true }));
		// 保存尾缀，不能立刻把半段ANSI当普通文字展示。
		pendingAnsi = pending;
		// 只追加当前可完整处理的文字。
		appendText(complete);
	};

	/**
	 * 执行收尾时冲刷decoder并处理尚存ANSI尾缀；无参数，修改外层缓冲。
	 * 例：最后一个Buffer含不完整UTF-8字节，decoder.decode()按解码器规则处理结尾。
	 */
	const flushOutput = () => {
		// 无参数decode()结束流式解码，和pendingAnsi合并交清理器。
		const rest = pendingAnsi + decoder.decode();
		// 先清空挂起状态，防止重复保留同一尾缀。
		pendingAnsi = "";
		// 尾部也经过相同清理/日志/回调路径。
		appendText(rest);
	};

	// 底层未给退出码之前初始null。
	let exitCode: number | null = null;
	// 仅执行operations.exec在这个try/catch内，之后flush/truncate的异常不会在这里被当作exec取消。
	try {
		// await自定义执行；解构把结果exitCode写回外层变量，取消信号原样转发。
		({ exitCode } = await operations.exec(command, cwd, { onData, signal: options?.signal }));
		// 操作拒绝时检查是否已取消，决定抛错还是返回部分输出。
	} catch (err) {
		// An aborted command still returns the output it produced so far
		// 只有signal已取消才允许吞掉这次exec异常；没有独立检查异常类别。
		if (!options?.signal?.aborted) {
			// 非取消错误时请求日志流结束，不等待finish。
			tempFileStream?.end();
			// 原异常继续传出，不伪装成code非零的正常结果。
			throw err;
		}
	}

	// 正常或被取消后继续冲刷已收到输出。
	flushOutput();
	// 拼接的是滚动缓冲剩余内容；变量名fullOutput不表示原始全部字节都还在内存。
	const fullOutput = outputChunks.join("");
	// 统一尾截断按默认行/字节限制决定显示正文。
	const truncationResult = truncateTail(fullOutput);
	// 即使没跨原始字节阈值，最终因行数裁剪也可能需要日志。
	if (truncationResult.truncated) {
		// 确保另有日志承载完整清理文字；不会为已创建流重复补写块。
		ensureTempFile();
	}
	// 有日志时end，返回前没有await完成或关闭。
	tempFileStream?.end();
	// 结束时取信号状态，缺信号按false；调用取消不等于证明所有远端工作已结束。
	const cancelled = options?.signal?.aborted ?? false;

	// 返回供会话/UI展示的结果。
	return {
		// 截断则取尾部content，否则用剩余缓冲拼接文字。
		output: truncationResult.truncated ? truncationResult.content : fullOutput,
		// 取消时不再报告底层退出码；非取消的null也映射undefined。
		exitCode: cancelled ? undefined : (exitCode ?? undefined),
		// 属性简写保存取消状态。
		cancelled,
		// 采用最终truncateTail的截断判断。
		truncated: truncationResult.truncated,
		// 有日志才提供路径，可能在truncated=false时也已因原始字节量创建。
		fullOutputPath: tempFilePath,
	};
}
