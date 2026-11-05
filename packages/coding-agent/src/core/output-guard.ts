// 把普通stdout输出临时转到stderr，让JSON/RPC等模式独占stdout协议通道；显式writeRawStdout仍可发协议数据。
// 原始写入按Promise链串行，遇暂时性缓冲错误重试；这不是可恢复的日志存储，致命写错会请求进程退出。
// 索引访问类型后面复用这两个写函数签名，运行时绑定的仍是原来的stream.write。
interface StdoutTakeoverState {
	// 接管前绑定到stdout的写函数；这里只公开字符串+回调这种使用方式。
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	// 接管前绑定到stderr，普通stdout日志转发到这里。
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	// 未bind的原stdout.write，供恢复方法身份；typeof这里取编译期的属性类型。
	originalStdoutWrite: typeof process.stdout.write;
}

// undefined表示未接管；模块状态不是按每个会话各维护一份。
let stdoutTakeoverState: StdoutTakeoverState | undefined;

// 缓冲暂不可写时每次等10ms，没有在这里设置最大重试次数或总超时。
const RAW_STDOUT_RETRY_DELAY_MS = 10;

// 初始已完成Promise，后续原始stdout写入都接到同一条链尾。
let rawStdoutWriteTail: Promise<void> = Promise.resolve();

/**
 * 取得当前可直接写stdout的函数，不实际写数据。
 * 例：已接管时返回接管前绑定的函数，绕过改写后的stdout.write；未接管时bind当前stdout.write。
 */
function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	// 存在状态时不能再取process.stdout.write，否则会把协议数据也转到stderr。
	if (stdoutTakeoverState) {
		// 返回保存的绑定函数，this已固定为stdout。
		return stdoutTakeoverState.rawStdoutWrite;
	}
	// 类型断言只约束本文件的调用形式，不验证/替换底层stream实现。
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

/**
 * 写一个原始stdout字符串并等写回调；临时缓冲错误每10ms重试，其他错误拒绝Promise。
 * 例：EAGAIN可进入下一轮，EPIPE直接抛；不把write返回false当作完成，等待回调才resolve。
 * 循环无次数/取消上限；重试是重新提交整块，不提供端到端“恰好一次写入”协议保证。
 */
async function writeRawStdoutChunk(text: string): Promise<void> {
	// 成功return或不可重试异常throw才结束循环。
	while (true) {
		// 捕获本轮同步抛错与回调报告的异步错误。
		try {
			// Promise<void>表示完成时不带业务返回值，只表达写入回调成功。
			await new Promise<void>((resolve, reject) => {
				// stream.write也可能在调用时立即throw，需转成Promise拒绝。
				try {
					// 每轮选择当前原始函数；接管/恢复状态可能在排队期间改变。
					getRawStdoutWrite()(text, (error) => {
						// 只在回调无错误时视为本次写成功。
						if (error) reject(error);
						else resolve();
					});
				} catch (error) {
					// 非Error抛出值转换成Error；String(error)不是内容脱敏。
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			// 本块成功，不再进入循环重发。
			return;
		} catch (error) {
			// 统一拿到Error便于读取可选code。
			const writeError = error instanceof Error ? error : new Error(String(error));
			// &交叉类型说明可能附code；as不会检查外部异常的形状。
			const code = (writeError as Error & { code?: unknown }).code;
			// 只有这些缓冲/暂不可写码允许重试，其他故障向上拒绝。
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				// 保留原错误说明，不无限吞掉断管等永久故障。
				throw writeError;
			}
			// 异步定时等待，不忙等阻塞线程；结束后重新尝试整个text。
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

/**
 * 接管process.stdout.write，把普通输出转换成文字写到接管前的stderr；重复调用不再包一层。
 * 例：接管后console.log会去stderr，而writeRawStdout可继续发stdout协议。修改的是进程全局函数，调用方须在适当时机restore。
 * 包装使用String(chunk)，忽略显式encoding参数，不承诺任意Uint8Array都按原write编码规则还原字节。
 */
export function takeOverStdout(): void {
	// 幂等保护，不覆盖首次保存的原函数。
	if (stdoutTakeoverState) {
		return;
	}

	// bind保存正确的this，并固定接管前函数，避免后面回到包装器递归。
	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	// stderr自身没有被本函数改写，但仍保存接管时的绑定版本。
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	// 恢复需要原方法引用，而不是绑定后产生的新函数。
	const originalStdoutWrite = process.stdout.write;

	// 函数重载由可选的“编码或回调”联合参数模拟；断言让包装适配Node完整write类型，不补运行时校验。
	process.stdout.write = ((
		// Node write接收字符串或字节数组，本包装后续统一String转换。
		chunk: string | Uint8Array,
		// typeof在运行时区分第二参数是回调还是编码名，这是重载输入的必要分流。
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		// 字符串编码作为第二参数时，完成回调在第三参数。
		callback?: (error?: Error | null) => void,
	): boolean => {
		// 第二参数为函数时把它当完成回调。
		if (typeof encodingOrCallback === "function") {
			// 直接转stderr并返回其背压布尔值，不经过原始stdout排队链。
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		// 显式编码名未转交；文字化后交stderr默认编码与第三参数回调。
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	// 保存状态后，显式原始写入可绕过刚替换的stdout.write。
	stdoutTakeoverState = {
		// 三个属性简写分别引用上面保存的局部变量。
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

/**
 * 恢复接管前的stdout.write并清掉接管状态，未接管时直接返回。
 * 不等待既有原始输出链完成，不清空链或恢复其他模块在接管期间自行替换的方法。
 */
export function restoreStdout(): void {
	// 允许重复清理，不访问undefined中的原方法。
	if (!stdoutTakeoverState) {
		return;
	}

	// 恢复本模块保存的旧函数引用，覆盖当前stdout.write。
	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	// 后续getRawStdoutWrite重新绑定当时的当前方法。
	stdoutTakeoverState = undefined;
}

/** 返回本模块是否持有接管状态，无I/O；它不检查其他模块是否又覆盖了stdout.write。 */
export function isStdoutTakenOver(): boolean {
	// 与undefined严格比较，返回布尔值。
	return stdoutTakeoverState !== undefined;
}

/**
 * 把协议文字排到原始stdout串行链，立即返回void；空文字跳过。
 * 例：连续写两条JSONL会按排队顺序处理。不可重试写入故障会请求process.exit(1)，调用者要等待收尾应调用wait/flush，而非await这个void。
 */
export function writeRawStdout(text: string): void {
	// 正常排队入口不为零长度字符串安排一个写回调。
	if (text.length === 0) {
		return;
	}
	// then把当前块接到既有尾部；前项拒绝会使链保持拒绝，不在这里恢复继续写。
	rawStdoutWriteTail = rawStdoutWriteTail.then(() => writeRawStdoutChunk(text));
	// void明确忽略catch返回的Promise；致命写错使协议通道不可用，按代码既定规则退出进程。
	void rawStdoutWriteTail.catch(() => {
		process.exit(1);
	});
}

/**
 * 等原始stdout链追到一个未再增加任务的尾部，成功返回Promise<void>；写入拒绝仍向上传出。
 * 例：等待期间又排一块，完成旧tail后会再等新tail；不保证未来调用方再写的内容也已经完成。
 */
export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		// 保存本轮观察到的Promise身份。
		const tail = rawStdoutWriteTail;
		// 等其全部前驱和当前块完成。
		await tail;
		// 同一引用表示这次等待期间没有新任务接到链上。
		if (tail === rawStdoutWriteTail) {
			return;
		}
	}
}

/**
 * 先等已有链，再直接写一个空块并等回调，作为当前stdout写队列的收尾屏障。
 * 不调用fsync，不承诺远端终端已显示或磁盘已持久化，也不阻止随后产生的新写入。
 */
export async function flushRawStdout(): Promise<void> {
	// 等追上目前已排队的所有原始输出。
	await waitForRawStdoutBackpressure();
	// 此处直接调用底层辅助，所以空字符串不会被writeRawStdout的提前返回跳过。
	await writeRawStdoutChunk("");
}
