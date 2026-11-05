// 统一Windows cross-spawn与其他平台Node子进程API，并等待退出/输出收尾；包管理、命令执行等模块复用。
// 这里只提供进程机制，不限制能执行哪些命令；options可启用shell，Windows包装还可能为.cmd/shebang等选择cmd.exe，不是禁止shell的接口。
import {
	type ChildProcess,
	type ChildProcessByStdio,
	spawn as nodeSpawn,
	spawnSync as nodeSpawnSync,
	type SpawnOptions,
	type SpawnOptionsWithStdioTuple,
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	type StdioNull,
	type StdioPipe,
} from "node:child_process";
import type { Readable } from "node:stream";
import crossSpawn from "cross-spawn";

// 子进程退出后，输出管道连续空闲这么多毫秒才兜底完成；不是从spawn开始计算的命令执行总超时。
const EXIT_STDIO_GRACE_MS = 100;

// 异步启动进程，输入命令、参数数组及Node选项，返回ChildProcess；Windows交cross-spawn兼容命令解析，其余用node:child_process。
// 例如stdio:["ignore","pipe","pipe"]命中首个重载，让TS知道stdin为null且stdout/stderr可读；只是类型约定，不是新增运行时检查。
// 启动会产生外部进程及后续error/exit事件，调用方应监听/等待；本函数不捕获同步参数错误、不自动结束进程。
// 下面无函数体的两条声明是重载签名，运行时只有后面一份实现；一般SpawnOptions无法保证输出流一定存在。
export function spawnProcess(
	// 可执行文件/命令名，与args分开传递；是否经shell解释还取决于options及Windows包装的命令类型判断。
	command: string,
	// 每一项为单独参数，不在本函数做命令正文拼接或转义。
	args: string[],
	// 三元组顺序是stdin/stdout/stderr；StdioNull表示不向父进程暴露输入管道。
	options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable>;
// 普通重载返回较宽的ChildProcess，调用方需要处理可能为null的stdio成员。
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess;
// 重载实现接受所有上面允许的参数组合，原样转交对应平台实现。
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
	// 三元分支只在本次调用时选择一侧，不会同时启动两个进程。
	return process.platform === "win32" ? crossSpawn(command, args, options) : nodeSpawn(command, args, options);
}

// 同步启动并等候子进程，输入命令/参数和带文字编码的选项，返回状态、stdout/stderr等结果，会阻塞当前线程。
// 例如encoding:"utf-8"使返回类型SpawnSyncReturns<string>的输出为文字；非零status不自动抛错，调用方检查status/error。
// Windows使用crossSpawn.sync，其余Node spawnSync；options可启用shell，Windows包装也可能按命令类型使用cmd，接口不提供输入校验或沙箱。
export function spawnProcessSync(
	// 要执行的命令，与参数分开保留。
	command: string,
	// 字符串数组传给底层API，不进行额外分词。
	args: string[],
	// encoding是此接口必填的类型字段，因此选择返回文字的重载。
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
	// Windows包装处理平台启动差异，同步结果形状沿用Node类型。
	return process.platform === "win32"
		? crossSpawn.sync(command, args, options)
		: // 非Windows直接使用引入时改名的nodeSpawnSync，避免与包装函数混淆。
			nodeSpawnSync(command, args, options);
}

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * A short-lived child can `exit` while a detached descendant keeps its stdout/stderr
 * pipe open. We must not resolve and destroy the streams on a fixed deadline measured
 * from `exit`, or output still being written past that deadline is silently lost
 * (earendil-works/pi#5303). Instead, after `exit` we wait for the pipes to fall idle:
 * the grace timer is re-armed on every chunk, so an actively writing descendant keeps
 * us reading, while a quiet inherited handle (e.g. a Windows daemonized descendant
 * that never lets `close` fire) still releases us after the grace elapses.
 */
// 输入刚启动的ChildProcess，返回退出码或null（如信号终止）的Promise；启动error使其拒绝，不把非零码当异常。
// 先等exit，然后等两条输出结束，或close；后代一直持有管道时以退出后100ms连续空闲兜底，每块新输出都会重新计时。
// 例如exit后每50ms仍来一块输出就持续等，最后一块后静默100ms才结束；更晚才恢复的输出仍可能丢失，这是空闲窗口策略而非无限等待。
// 成功收尾会移除本函数监听并destroy两条输出流；已有业务data监听不由此代为保存，调用方需先自行收集输出。
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	// 执行器立刻安装监听，闭包状态被下面所有事件回调共用。
	return new Promise((resolve, reject) => {
		// 防止error/close/计时器等竞争路径把一次等待重复结算。
		let settled = false;
		// 是否已收到主子进程exit；输出空闲兜底只在这个事件之后才启用。
		let exited = false;
		// 保存exit报告的退出码，null不等于成功0，也不在这里改成其他值。
		let exitCode: number | null = null;
		// NodeJS.Timeout是Node计时器句柄类型，undefined代表尚未设置或已清理。
		let postExitTimer: NodeJS.Timeout | undefined;
		// 没有stdout管道就视作无须等待；存在流则等待end或兜底，不读取其历史事件。
		let stdoutEnded = child.stdout === null;
		// stderr独立追踪，不能因stdout先结束就丢掉最后的错误输出。
		let stderrEnded = child.stderr === null;

		// 清理本等待器的计时器/事件绑定，无参数/返回，不移除其他模块挂的监听；终结成功和错误两路都会调用。
		// 例如定时器先结算后，后来的close事件不应再触发同一份处理逻辑。
		const cleanup = () => {
			// 仅已有计时器时取消，避免保留对进程/闭包的引用。
			if (postExitTimer) {
				// clearTimeout取消未来触发，不撤销已经执行的回调。
				clearTimeout(postExitTimer);
				// 标记句柄已释放，后续清理不会重复持有旧引用。
				postExitTimer = undefined;
			}
			// 逐个按回调身份撤销本函数安装的子进程事件。
			child.removeListener("error", onError);
			// exit只说明主进程退出，不等于所有继承管道关闭。
			child.removeListener("exit", onExit);
			// close用于正常所有stdio关闭时提前结束等待。
			child.removeListener("close", onClose);
			// ?.只在stdout存在时操作，end代表读取端收到结束。
			child.stdout?.removeListener("end", onStdoutEnd);
			// stderr有单独end回调，和stdout的状态分开。
			child.stderr?.removeListener("end", onStderrEnd);
			// 数据监听只负责刷新空闲时间，不收集输出内容。
			child.stdout?.removeListener("data", onData);
			// 两条流共用onData，任一流活跃都延长等待。
			child.stderr?.removeListener("data", onData);
		};

		// 以给定码成功完成一次等待，无返回；清理监听并销毁输出流，随后resolve，不终止仍存活的后代。
		// 例如两流都end后传exitCode，或close直接传其code；null原样保留给调用方解释信号退出。
		const finalize = (code: number | null) => {
			// 只接受首条结算路径，其他竞争事件直接忽略。
			if (settled) return;
			// 先设标记再清理，避免清理引起的新事件重复结算。
			settled = true;
			// 撤销本函数所有监听及计时器，其他模块自己的监听不受removeListener影响。
			cleanup();
			// 完成后关闭本地读取流；这不是对后代进程发终止信号。
			child.stdout?.destroy();
			// 也关闭错误管道，防止后代安静持有句柄让父进程继续等待。
			child.stderr?.destroy();
			// Promise只返回退出码，不把stdout/stderr文本打包返回。
			resolve(code);
		};

		// 无参数/返回，检查是否已exit且两流均结束，满足时完成Promise；由exit和两个end回调复用。
		// 例如stdout早已end、stderr后end，则最后一个end收到时即可完成，不必等满100ms。
		const maybeFinalizeAfterExit = () => {
			// 未exit时不能仅凭输出关闭就认为命令已完成；已结算也不重复处理。
			if (!exited || settled) return;
			// 两流都结束才走立即收尾路径，缺省null流初始已标记结束。
			if (stdoutEnded && stderrEnded) {
				// 使用exit事件保存的码，不凭流end推测成功。
				finalize(exitCode);
			}
		};

		// 无参数/返回，重设退出后空闲计时器；例如收到新数据后从该时刻重新计100ms，而非追加100ms。
		const armIdleTimer = () => {
			// 已有计时器先取消，始终最多保留一个收尾计时器。
			if (postExitTimer) clearTimeout(postExitTimer);
			// 回调未来执行时读取闭包exitCode；持续输出会在到时之前不断重设它。
			postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
		};

		// 数据事件只刷新空闲窗口，无需接收/解析chunk，无返回；exit前的数据不启动兜底计时。
		// 例如后代在主进程exit后继续写stdout，会推迟destroy流，减少尾部输出截断。
		const onData = () => {
			// Output is still arriving after exit; defer finalizing so we don't
			// destroy the stream mid-write and truncate the tail.
			// 只有主进程已退出且本等待仍活跃时，数据才影响空闲窗口。
			if (exited && !settled) armIdleTimer();
		};

		// stdout的end回调，无参数/返回，标记读取结束并检查是否可完成；不代表stderr也结束。
		const onStdoutEnd = () => {
			// 更新与这一条流对应的状态，闭包变量可由箭头函数修改。
			stdoutEnded = true;
			// 若exit及另一条流已结束就立即resolve，否则继续等。
			maybeFinalizeAfterExit();
		};

		// stderr的end回调，无参数/返回，和stdout对称；例如错误管道最后结束时触发立即收尾。
		const onStderrEnd = () => {
			// 只改变错误流结束状态。
			stderrEnded = true;
			// 复用统一完成条件，避免两条流各自决定退出码。
			maybeFinalizeAfterExit();
		};

		// 子进程error回调，输入Node错误，无返回；只在未结算时拒绝并撤销监听，不走成功finalize的destroy路径。
		// 例如可执行文件不存在触发error，使await抛错，调用方负责上层进程/输出资源收尾。
		const onError = (err: Error) => {
			// 成功或其他错误已结算时不再拒绝Promise。
			if (settled) return;
			// 先锁定终态再清理，防止后续exit/close接管结果。
			settled = true;
			// 释放这个等待器创建的计时器/监听。
			cleanup();
			// 保留原错误对象给调用方，不伪造成退出码。
			reject(err);
		};

		// 主进程exit回调，输入退出码或null，无返回；记录状态后尝试即时完成，否则启用空闲兜底。
		// 例如shell已结束但后代仍持有stdout时，不会只因exit就立刻销毁管道。
		const onExit = (code: number | null) => {
			// 标记现在起的数据会刷新退出后空闲计时器。
			exited = true;
			// 保存Node给的原码；信号参数未在本函数读取，null交上层结合child.signalCode解释。
			exitCode = code;
			// 若管道此前已经结束，直接完成而无需额外等待。
			maybeFinalizeAfterExit();
			// 刚才未完成时才启用100ms空闲兜底。
			if (!settled) {
				armIdleTimer();
			}
		};

		// 子进程close回调，输入其退出码，无返回；代表正常stdio收尾时直接完成，避免不必要等待。
		const onClose = (code: number | null) => {
			// finalize自己做重复结算保护，和exit/end/计时器竞争也只返回一次。
			finalize(code);
		};

		// end每条流只需一次，?.跳过不暴露管道的stdio配置。
		child.stdout?.once("end", onStdoutEnd);
		// stderr读取结束独立标记，保证有两条管道时都被考虑。
		child.stderr?.once("end", onStderrEnd);
		// on接收每一块数据以不断重设空闲时间；业务输出文本由其他data监听收集。
		child.stdout?.on("data", onData);
		// 任一输出管道活跃都应延后收尾。
		child.stderr?.on("data", onData);
		// 启动失败等error拒绝Promise，而不是挂到永远不来的exit上。
		child.once("error", onError);
		// exit是开始退出后等待的边界，不能代替stdio关闭事件。
		child.once("exit", onExit);
		// 正常close可抢先结束空闲等待；所有回调最终都由cleanup撤销。
		child.once("close", onClose);
	});
}
