/**
 * 把QuickJS放在调用线程的后端，供portable入口和远程服务端使用，不依赖Node worker或磁盘。
 * 同步计算会挡住宿主事件循环，所以还要按中断轮询次数计额度，而不能只依赖timeout定时器。
 * VM回调只排microtask，等VM栈退回再通知公共执行器，避免在VM内部再次进入deliver/dispose。
 */
/**
 * Runs the VM on the calling thread, for runtimes without worker threads (Cloudflare Workers and
 * Durable Objects, browsers) and for the server side of `RemoteCodemodeSandbox`.
 *
 * Problem: QuickJS runs synchronously. While a script computes, the host's event loop does not
 * run, so neither the deadline timer nor an abort signal can fire. On Workers even `Date.now()` is
 * frozen during synchronous execution, so the VM cannot check a clock either. Example: with a
 * worker thread, `while (true) {}` is stopped by the host's 200 ms timer; on the calling thread
 * that timer never gets a chance to run.
 *
 * Solution: an interrupt budget. QuickJS polls its interrupt handler periodically while a script
 * runs; this launcher counts the polls across the whole execution and interrupts the script once
 * the count passes the budget. The execution then fails with `kind: "timeout"`. The deadline and
 * abort signal still work whenever the script waits on a tool, since the event loop runs then.
 *
 * The rate of polls depends on the code and the machine. Measured with a tight loop: about 50,000
 * per second of CPU on an Apple M-series laptop and about 10,000 per second on Cloudflare Durable
 * Objects (October 2026). The default of 100,000 allows roughly 2 to 10 seconds of uninterrupted
 * computation; keep it well below the platform's own CPU limit, because hitting that limit resets
 * a Durable Object instead of failing one script.
 *
 * Once the VM reports `done` or `crash`, the result is decided, so the VM is interrupted at the
 * next poll instead of running on until the host stops it. Example: a script that keeps printing in
 * a `for (;;)` loop after its output limit was reached would otherwise run until the budget ran out
 * and be reported as a timeout.
 *
 * Stack: the VM runs on the caller's stack, which is smaller than a worker thread's (about 1 MB
 * on Node's main thread), so QuickJS's stack guard is set to {@link INLINE_MAX_STACK_SIZE}.
 *
 * Reentrancy: VM callbacks run inside QuickJS. Messages from the VM are delivered to the host in
 * a microtask, after the VM has returned, so host code (tool calls, `finish()`, disposal) never
 * runs inside a VM callback and never re-enters the VM.
 */
// 公共工具/默认值配置类型，编译后擦除。
import type { CodemodeSandboxBaseOptions } from "../types.ts";
// 只取不透明编译模块类型，不引入wasm.ts的Node文件读取。
import type { CodemodeWasmModule } from "../wasm.ts";
// 共享宿主状态机和未知异常转文字，VmLauncher只是启动函数类型。
import { CodemodeSandboxBase, errorMessage, type VmLauncher } from "./execution.ts";
// 后端无论放在哪个线程，都共用同一套VM驱动。
import { startVm } from "./vm.ts";

/** 默认轮询额度100000，超过才请求中断；次数和运行毫秒不固定等价，取决于脚本、引擎和机器。 */
export const DEFAULT_INTERRUPT_BUDGET = 100_000;

/** Allows recursion about 1,000 calls deep and trips well before a 1 MB host stack overflows. */
// 调用线程的栈守卫设为256KiB；这是QuickJS栈额度，不是整个线程内存，递归层数仅是原说明里的近似量。
export const INLINE_MAX_STACK_SIZE = 256 * 1024;

/** 继承通用沙箱参数并要求提供WASM；inline不自己从磁盘找文件，适合由打包器提供编译模块。 */
export interface InlineCodemodeSandboxOptions extends CodemodeSandboxBaseOptions {
	/**
	 * Compiled `quickjs-wasi/quickjs.wasm`. On Cloudflare, import it with Wrangler's `CompiledWasm`
	 * rule (`@earendil-works/pi-codemode/cloudflare` does this); on Node, `loadQuickJSWasm()`.
	 */
	// 可传现成模块或加载Promise；每次VM实例仍独立。
	wasm: CodemodeWasmModule | Promise<CodemodeWasmModule>;
	/**
	 * Interrupt polls an execution may use before it fails with `kind: "timeout"`. The only limit on
	 * a script that computes without awaiting a tool. Default: {@link DEFAULT_INTERRUPT_BUDGET}.
	 */
	// 可选轮询额度，省略用默认；本层不额外验证有限/正整数范围。
	interruptBudget?: number;
}

/**
 * 返回调用线程VM的启动闭包；例inlineLauncher(wasm,1000)在第1001次相关轮询时标记耗尽。
 * 等模块→创建VM与中断回调→把消息延后到microtask→返回post/stop；创建闭包本身不运行脚本。
 * 轮询次数跨await工具累计；普通timeout/取消只有事件循环能运行时才有机会触发，不能把额度当精确秒表。
 */
export function inlineLauncher(
	// 类型联合兼容编译完成与尚在加载，不读取Node文件。
	wasm: CodemodeWasmModule | Promise<CodemodeWasmModule>,
	// 默认值只在undefined时采用，0/负数/NaN等显式值仍原样进入比较。
	interruptBudget: number = DEFAULT_INTERRUPT_BUDGET,
): VmLauncher {
	// async启动函数，公共Execution可在其Promise完成前收到VM消息。
	return async (data, events) => {
		// 成功等待后保存真正编译模块。
		let module: CodemodeWasmModule;
		// 模块加载失败按统一可读原因包装。
		try {
			// await兼容模块或Promise；不会在这里重新编译WASM。
			module = await wasm;
		} catch (error) {
			// 失败交公共层变sandbox结果。
			throw new Error(`Failed to load QuickJS: ${errorMessage(error)}`);
		}
		// 是否已收到宿主停止请求，挡后续回复/消息。
		let stopped = false;
		// VM是否已经发过done/crash，防止后续中断噪声盖住原结果。
		let settled = false;
		// 本次执行累计轮询，不随工具等待重新归零。
		let polls = 0;
		// 是否因额度耗尽请求中断，方便把VM崩溃表现还原为timeout原因。
		let exhausted = false;
		// 创建本次VM，startVm会先运行前导脚本及用户初段，再给session。
		const session = await startVm({
			// 普通/确定性启动数据共同传入。
			data,
			// 复用编译模块，实例由VM驱动创建。
			wasm: module,
			// 调用线程栈较小，指定较保守QuickJS栈上限。
			maxStackSize: INLINE_MAX_STACK_SIZE,
			// 额度也进入确定性指纹，避免不同限制下重放时误认为环境相同。
			interruptBudget,
			/** VM轮询是否应中断：停止/终态/耗尽优先，其余累计并比较预算。同步回调不读取墙钟时间。 */
			shouldInterrupt: () => {
				// 已结束后下次轮询立即打断，不再继续消耗脚本工作。
				if (stopped || settled || exhausted) return true;
				// 前置++先加1；到预算本身还允许继续，超出才耗尽。
				if (++polls <= interruptBudget) return false;
				// 记下真正原因，后面发timeout而非泛化crash。
				exhausted = true;
				// 请求QuickJS中断，依赖引擎有机会轮询。
				return true;
			},
			/** VM内同步通知只记录标记并排microtask，不能在此回调里直接重入VM或dispose。 */
			post: (message) => {
				// 只有done/crash是终态；output/call/started/idle不是。
				const terminal = message.type === "done" || message.type === "crash";
				// Only the first terminal message counts: a crash caused by interrupting a settled VM is noise.
				// 第一个终态已记录就忽略第二个，保留输出超限等原原因。
				if (terminal && settled) return;
				// 先同步置位，使还在VM里的后续轮询立即停止。
				if (terminal) settled = true;
				// 延后执行宿主分派，等当前VM栈退出来。
				queueMicrotask(() => {
					// 停止请求后丢弃已排队消息。
					if (stopped) return;
					// The interrupt surfaces as a crash or a failed done; report what caused it instead.
					// 额度耗尽可能表现为done失败或crash，统一还原其真实限制原因。
					if (exhausted && (message.type === "done" || message.type === "crash")) {
						// 交公共层finish决定脚本结果。
						events.failure({
							// timeout类别不表示按毫秒的timer必然触发。
							kind: "timeout",
							// 明确是额度值，不把它写成实际运行秒数。
							message: `Execution exceeded its interrupt budget of ${interruptBudget}`,
						});
						// 不再把同一终态当普通消息发一次。
						return;
					}
					// 其他消息原样交公共Execution识别和JSON解码。
					events.message(message);
				});
			},
		});
		// 交出通信句柄，前面已建立独立VM session。
		return {
			/** 宿主回复当前调用；停止后不再递交，防使用已dispose的session。 */
			post: (message) => {
				// 未停止就交session.deliver；普通模式立即应用，start可能先按seq缓冲，补齐缺口后才恢复VM。
				if (!stopped) session.deliver(message);
			},
			/** 请求停止本调用线程VM，重复调用无操作；dispose释放实例，不等不配合取消的宿主工具完成。 */
			stop: async () => {
				// 避免重复释放同一个VM。
				if (stopped) return;
				// 先置位，挡住已排队microtask及后续回复。
				stopped = true;
				// 这里已处于VM外，安全释放会话实例。
				session.dispose();
			},
		};
	};
}

/**
 * Runs each execution's QuickJS VM on the calling thread. Works in any runtime with WebAssembly
 * and microtasks; needs no worker threads, files, or Node built-ins. A script that computes
 * blocks the caller's thread until it awaits a tool or uses up its interrupt budget, so prefer
 * `CodemodeSandbox` where worker threads exist, and `RemoteCodemodeSandbox` to keep scripts off a
 * thread that must stay responsive (such as a Durable Object that serves a session).
 */
/** 公共API的调用线程实现；例new InlineCodemodeSandbox({wasm,tools})后execute。构造不运行脚本，execute时同步VM工作会占用调用线程。 */
export class InlineCodemodeSandbox extends CodemodeSandboxBase {
	/** 把公共配置与inline启动器交父类；WASM必须由调用方提供，默认额度由inlineLauncher处理。 */
	constructor(options: InlineCodemodeSandboxOptions) {
		// super初始化工具表/默认值；这里只创建启动闭包，不先创建VM。
		super(options, inlineLauncher(options.wasm, options.interruptBudget));
	}
}
