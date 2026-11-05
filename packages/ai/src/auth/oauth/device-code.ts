// OAuth设备码轮询共用逻辑，供应商flow负责网络请求和把响应映成状态；这里统一取消提示。
const CANCEL_MESSAGE = "Login cancelled";
// 未遇slow_down时超时使用普通说明。
const TIMEOUT_MESSAGE = "Device flow timed out";
// 出现过slow_down时选更具体的排查提示，不在此诊断或修复系统时钟。
const SLOW_DOWN_TIMEOUT_MESSAGE =
	// 这是固定错误文字的延续行，字符串内容不能插入源码注释。
	"Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.";
// 轮询间隔至少一秒，避免服务端给极小间隔导致忙轮询。
const MINIMUM_INTERVAL_MS = 1000;
// RFC 8628 section 3.2: if the authorization server omits `interval`, the client must use 5 seconds.
// 服务端省略interval时采用五秒默认。
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
// RFC 8628 section 3.5: `slow_down` means the polling interval must increase by 5 seconds.
// 没有有效服务端新间隔时，每遇slow_down增加五秒。
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;

// 尚未成功的三种状态，status是分辨字段。
type OAuthDeviceCodeIncompletePollResult =
	// pending只表示授权尚未完成，不是立即报错。
	| { status: "pending" }
	// slow_down可附服务端要求的新间隔，单位秒。
	| { status: "slow_down"; intervalSeconds?: number }
	// failed携带最终错误文字，helper把它变Error。
	| { status: "failed"; message: string };

// complete分支携带调用方定义的T，联合允许循环先收未完成状态再最终返回T。
export type OAuthDeviceCodePollResult<T> = OAuthDeviceCodeIncompletePollResult | { status: "complete"; value: T };

// 泛型选项把poll成功值与函数返回类型关联，接口本身不发请求。
export type OAuthDeviceCodePollOptions<T> = {
	// 建议间隔秒数，缺省用五秒，之后转换并限制最小一秒。
	intervalSeconds?: number;
	// 从helper调用时开始计算的期限秒数，不是绝对Unix时间。
	expiresInSeconds?: number;
	// true时首次网络轮询也先等待；缺省false立即开始。
	waitBeforeFirstPoll?: boolean;
	// 供应商注入的异步单次轮询，helper不自动给它增加超时信号。
	poll: () => Promise<OAuthDeviceCodePollResult<T>>;
	// 整个循环/睡眠使用同一取消信号。
	signal: AbortSignal;
};

/**
 * 可取消地等待ms毫秒，返回Promise<void>，正常到时成功，取消以指定文字的新Error拒绝。
 * 输入信号和可读取消说明，安排/清理计时器与监听；例：等5000毫秒时用户取消，可提前结束，不保留signal.reason原值。
 */
export function abortableSleep(ms: number, signal: AbortSignal, cancelMessage: string): Promise<void> {
	// 用Promise连接setTimeout的完成和取消事件的失败。
	return new Promise((resolve, reject) => {
		// 已取消时不创建后面的计时器。
		if (signal.aborted) {
			// 错误文字由调用者传入，不复用signal.reason。
			reject(new Error(cancelMessage));
			// reject后仍需return，阻止继续安装计时器。
			return;
		}

		// 定义等候期间取消时执行的闭包。
		const onAbort = () => {
			// 提前清掉正常到期任务，避免白等剩余时间。
			clearTimeout(timeout);
			// 让等待者因取消拒绝，Promise仅结算一次。
			reject(new Error(cancelMessage));
		};
		// 正常计时到期进入这个回调。
		const timeout = setTimeout(() => {
			// 到期后移除取消监听，不长期保留闭包。
			signal.removeEventListener("abort", onAbort);
			// 成功无数据，只表示等待期结束。
			resolve();
			// ms决定计时长度，平台计时器自行处理精度，不保证严格准点执行。
		}, ms);

		// once使此监听最多触发一次，取消路径无需重复处理。
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 按设备授权轮询协议重复调用poll，返回complete中的泛型T；失败/超时/取消拒绝。
 * 默认立即首次轮询，也可先等待；pending按间隔重试，slow_down采用服务端有效间隔或加五秒。例：pending→slow_down→complete最终只返回value。
 * deadline只控制循环和睡眠，不强制中断正在await的poll；poll自己须转交信号/设置超时。complete一旦返回即接受，即使这次请求跨过deadline。
 */
export async function pollOAuthDeviceCodeFlow<T>(options: OAuthDeviceCodePollOptions<T>): Promise<T> {
	// 先根据可选相对寿命计算绝对截止时间。
	const deadline =
		// 原逻辑仅检查number类型，未在此统一验证寿命有限/正值。
		typeof options.expiresInSeconds === "number"
			? // 秒乘1000与Date.now的毫秒对齐。
				Date.now() + options.expiresInSeconds * 1000
			: // 未给数字寿命时用正无穷，没有整体截止时间。
				Number.POSITIVE_INFINITY;
	// let保存会被slow_down修改的轮询间隔。
	let intervalMs = Math.max(
		// Math.max的第一个参数保证正常数字间隔不少于1000ms。
		MINIMUM_INTERVAL_MS,
		// 先取显式间隔或默认五秒，再转毫秒并向下取整；??保留显式0，后面最小值会夹到一秒。
		Math.floor((options.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000),
	);

	// 计数只用于最终超时提示，不限制允许slow_down的次数。
	let slowDownResponses = 0;
	// 只有明确要求才在第一次poll前睡眠。
	if (options.waitBeforeFirstPoll) {
		// 重新算截止前剩余毫秒，可能已小于等候间隔。
		const remainingMs = deadline - Date.now();
		// 剩余正数才等待，否则直接进入后面超时逻辑。
		if (remainingMs > 0) {
			// 等待不超过剩余期限，睡眠中取消可提前拒绝。
			await abortableSleep(Math.min(intervalMs, remainingMs), options.signal, CANCEL_MESSAGE);
		}
	}

	// 每轮开始看墙上时钟deadline，时钟跳变会影响剩余时间，不是单调计时器。
	while (Date.now() < deadline) {
		// 每次发poll前检查取消，避免已取消还开始下一轮。
		if (options.signal.aborted) {
			// 循环取消统一报告Login cancelled。
			throw new Error(CANCEL_MESSAGE);
		}

		// 等待供应商一次轮询；请求异常直接拒绝，不在此自动重试网络错误。
		const result = await options.poll();
		// 分辨成功分支后TS可读value。
		if (result.status === "complete") {
			// 直接返回T，不返回包装status对象；没有再检查请求结束时deadline/信号。
			return result.value;
		}
		// 失败是终止状态，不当作pending继续等。
		if (result.status === "failed") {
			// 把供应商给的说明转换成Error交调用者。
			throw new Error(result.message);
		}
		// slow_down进入间隔调整，普通pending保持原间隔。
		if (result.status === "slow_down") {
			// 记录曾出现过慢轮询提示。
			slowDownResponses += 1;
			// Use the server-provided interval when given (GitHub reports the new required minimum
			// in `interval`); trusting only a client-tracked value risks polling early forever under
			// WSL/VM clock drift. Otherwise apply RFC 8628 section 3.5: increase by 5 seconds.
			// 依据下面条件选择服务端新值还是本地累加。
			intervalMs =
				// 服务端可选interval需确为数字才能考虑。
				typeof result.intervalSeconds === "number" &&
				// 有限性排除NaN/Infinity，避免将它们用作有效间隔。
				Number.isFinite(result.intervalSeconds) &&
				// 服务端间隔还必须大于零。
				result.intervalSeconds > 0
					? // 有效值直接转成新的毫秒间隔并夹最小一秒，不是再与旧间隔取较大者。
						Math.max(MINIMUM_INTERVAL_MS, Math.floor(result.intervalSeconds * 1000))
					: // 没有效服务端值时在原间隔上增加五秒。
						Math.max(MINIMUM_INTERVAL_MS, intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS);
		}

		// poll耗时会消耗剩余寿命，所以等待前重算。
		const remainingMs = deadline - Date.now();
		// 已经到期就不再启动一个睡眠。
		if (remainingMs <= 0) {
			// break离开整个while，最后统一超时错误。
			break;
		}

		// 按新间隔/剩余期限较小者等待，信号取消会拒绝此sleep并结束循环。
		await abortableSleep(Math.min(intervalMs, remainingMs), options.signal, CANCEL_MESSAGE);
	}

	// 只根据是否见过slow_down选说明；没有自动重启设备授权或同步机器时间。
	throw new Error(slowDownResponses > 0 ? SLOW_DOWN_TIMEOUT_MESSAGE : TIMEOUT_MESSAGE);
}
