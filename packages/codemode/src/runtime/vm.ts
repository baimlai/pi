/**
 * 三种后端共用的QuickJS驱动：建立独立WASM实例，装前导脚本与唯一消息桥，编译用户async函数，接回复推进Promise任务。
 * “宿主JS值”和“VM句柄”不能混用：桥用字符串/数字通信，工具参数/结果通常以JSON文字跨边界。
 * start另外固定时间/随机/时区并按seq重排回复；VM报告done不自己销毁，后端仍负责dispose或terminate。
 */
/**
 * Drives one QuickJS VM through one script, independent of the transport that connects it to the
 * host. The worker thread, the in-thread launcher, and the remote server all run the VM through
 * this module, so the bridge between prelude and host exists once.
 *
 * Contract with the caller:
 * - `post` receives every message for the host, synchronously from inside VM callbacks. The
 *   caller must not re-enter the VM from `post` (no `deliver`, no `dispose`); a worker posts to
 *   another thread, and the in-thread launcher defers delivery to a microtask.
 * - `deliver` hands the VM a tool result and runs the script until it waits again. It must only be
 *   called while the VM is idle, which holds for any caller that never re-enters from `post`.
 * - `shouldInterrupt` is polled by QuickJS while the script runs, and here between batches of
 *   promise jobs. Returning true throws an uncatchable error in the script; the VM then reports
 *   `crash` or a failed `done`. The job batches matter for a script such as `while (true) await
 *   null`: every iteration is a separate job that executes only a few opcodes, so QuickJS's own
 *   polling, which counts opcodes, would let it run for a long time between polls.
 * - The VM never decides on its own when it is finished: after `done` or `crash` it stays alive
 *   until the caller disposes it (or terminates the worker that hosts it).
 *
 * Failures after the VM exists are reported as a `crash` message; `startVm` only rejects when the
 * VM cannot be created at all.
 *
 * Deterministic mode (`data.deterministic`, used by `CodemodeSandboxBase.start()`): a script must make the same
 * calls with the same arguments every time it runs with the same results, so a host can replay it after a restart.
 * The VM is otherwise deterministic, because it only runs when the host delivers something and has no timers.
 * What remains is fixed here:
 * - Time: every WASI clock reads virtual time, `startedAt` and then the `now` of the result being processed, never going backwards.
 *   While the context is created, the realtime clock reads a value derived from the seed instead, because QuickJS
 *   seeds `Math.random()` from the first clock read, and which read comes first is the engine's business.
 * - Randomness: `random_get` draws from a PRNG over the seed.
 * - Timezone: UTC, not the host's.
 * - Garbage collection: `WeakRef` and `FinalizationRegistry` are not available; collection timing is not.
 * - Delivery order: results carry a `seq` and are applied strictly in that order, buffering early ones, because a
 *   transport (RPC replies) may deliver them in another order than the host sent them.
 * The VM reports `started` with its fingerprint before the script runs, and `idle` with the number of calls issued
 * after each drain, so the host can check a replay step by step.
 */
// 固定版本quickjs-wasi的引擎/异常/句柄API；type条目只供编译，其余为运行值。
import { Intrinsics, JSException, type JSValueHandle, MAX_STACK_SIZE, QuickJS } from "quickjs-wasi";
// 只导入不透明编译模块类型，不引入Node文件读取。
import type { CodemodeWasmModule } from "../wasm.ts";
// VM先执行的JS字符串，提供tools/输出/store等助手；其原值会参与确定性指纹。
import { PRELUDE_SOURCE } from "./prelude-source.ts";
// 桥协议类型擦除，不在此自动验证每个wire字段。
import type { HostToWorkerMessage, VmStartData, WorkerToHostMessage } from "./protocol.ts";

/** 单次VM句柄；后端必须在VM外调用deliver/dispose，不能在同步post回调中重入同一VM。 */
export interface VmSession {
	/** 交工具回复；普通模式立即应用，start按seq缓冲乱序回复，补齐缺口后才恢复脚本。错误一般通过post(crash)报告。 */
	deliver(message: HostToWorkerMessage): void;
	/** Releases the VM's wasm instance. The session must not be used afterwards. */
	/** 释放VM持有的句柄/回调/实例引用，可重复调用，供宿主GC回收，不保证内存立即归还；调用后不得继续使用VM句柄，也不撤销工具副作用。 */
	dispose(): void;
}

/** 单个VM驱动配置，不含真实宿主工具闭包；消息桥由回调注入，位置由worker/inline/remote后端决定。 */
export interface StartVmOptions {
	// 脚本、工具声明、store快照、内存和可选确定性起点。
	data: VmStartData;
	// 已编译模块，不在此加载磁盘文件。
	wasm: CodemodeWasmModule;
	/**
	 * QuickJS's guard on its own stack, which turns deep recursion into a catchable `RangeError`.
	 * The wasm frames also use the host thread's native stack, so the guard must trip before that
	 * stack runs out: a host overflow fails the whole execution instead. Default: `MAX_STACK_SIZE`
	 * (512 KiB), which fits the 4 MB stack of a Node worker thread but not a 1 MB main thread.
	 */
	// QuickJS栈守卫字节数，缺省采用依赖MAX_STACK_SIZE；不是整个宿主栈/进程内存限额。
	maxStackSize?: number;
	/** Interrupt polls this VM may use, if the launcher counts them; part of the fingerprint. */
	// 轮询额度本身由launcher计数，此处仅纳入指纹并调用shouldInterrupt。
	interruptBudget?: number;
	/** 同步消息出口；部分桥通知发生在VM栈内，started/idle等也可能从驱动层发出。后端应统一跨线程/排微任务处理，不借回调重入VM。 */
	post(message: WorkerToHostMessage): void;
	/** 快速轮询是否请求中断；来自共享标志或轮询额度，不要求在此读取真实时钟。 */
	shouldInterrupt(): boolean;
}

/**
 * Bumped whenever this module or the prelude changes what a deterministic script observes, beyond what the
 * fingerprint's other parts (engine versions, prelude hash, limits) already capture.
 */
// 可重放语义版本，补充引擎版本/前导脚本hash/限制；仅改外部解释注释不会改变这个运行值。
const DETERMINISTIC_VERSION = 1;

/** FNV-1a over UTF-16 code units, as 8 hex digits: identifies the prelude in the fingerprint. */
/** 按UTF-16码元算FNV-1a标识，例返回固定8位十六进制；不是防碰撞的密码学签名，用于检测prelude版本差异。 */
function fnv1a(text: string): string {
	// FNV偏移初值，十六进制便于对照算法。
	let hash = 0x811c9dc5;
	// string.length/charCodeAt逐码元，非逐Unicode码点或UTF8字节。
	for (let index = 0; index < text.length; index++) {
		// ^=先把当前码元异或进32位状态。
		hash ^= text.charCodeAt(index);
		// imul按32位整数乘法，保留乘积低32位而不是普通浮点乘积。
		hash = Math.imul(hash, 0x01000193);
	}
	// >>>0转无符号32位，再转16进制并补前导0到8位。
	return (hash >>> 0).toString(16).padStart(8, "0");
}

// 模块加载时对实际JS字符串求hash，修改字符串里的注释也会改变确定性环境指纹。
const PRELUDE_HASH = fnv1a(PRELUDE_SOURCE);

/** mulberry32: a small, fast PRNG; one 32-bit draw per call. */
/** mulberry32伪随机生成器工厂，例同seed重复构造会得同序列；返回闭包每次产一个无符号32位数，不用于密码学随机。 */
function prng(seed: number): () => number {
	// >>>0把seed收成32位无符号状态，闭包持有此可变值。
	let state = seed >>> 0;
	/** 每次推进state再混合位，返回一个0到0xffffffff的整数，不是Math.random的0到1浮点。 */
	return () => {
		// 加固定常量后截回32位，定义序列推进规则。
		state = (state + 0x6d2b79f5) >>> 0;
		// 移位/异或/乘法混合位，1|state令乘数为奇数。
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		// 第二轮混合，所有位操作走JS32位整数语义。
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		// 最后再异或高位并转无符号，保证输出非负。
		return (value ^ (value >>> 14)) >>> 0;
	};
}

/** The deterministic VM's clock: seed-derived while the context is created, then virtual time. */
/** 确定性WASI时钟；引擎创建期用seed派生时间，用户脚本开始后改为宿主交付结果推动的虚拟时间。 */
interface VirtualClock {
	// true时尚在QuickJS.create，避免引擎随机初始化依赖真实时间。
	creating: boolean;
	// 虚拟epoch毫秒起点，用于performance.now的相对差值。
	startedAt: number;
	// 当前虚拟epoch毫秒，只随按序结果单调前进。
	now: number;
	// 无符号32位种子，不以本机时钟重新播种。
	seed: number;
}

/** WASI clock and random functions for deterministic mode, on top of {@link discardOutput}. */
/**
 * 返回WASI导入工厂：丢弃引擎stdout/stderr，并提供虚拟clock_time_get及可重复random_get。
 * 例两次相同seed/结果顺序使VM观察到相同时间和随机字节；WASI以纳秒存时间，宿主配置以毫秒传入。
 * 只作用于此VM实例的WASM内存，不修改宿主Date或Math.random。
 */
function deterministicWasi(clock: VirtualClock) {
	// 先与常量混合种子，让这条WASI字节流与引擎按时钟播种的Math.random源分开。
	const random = prng(clock.seed ^ 0x9e3779b9);
	// 返回接WASM内存的函数；readonly只禁止重赋buffer引用，不禁止往内存写字节。
	return (memory: { readonly buffer: ArrayBufferLike }) => ({
		// 复用仅计写入长度、实际丢弃数据的fd_write。
		...discardOutput(memory),
		/** WASI时钟回调：clockId=0取epoch，其他取起点后时长；创建期epoch专供引擎播种。precision未采用。 */
		clock_time_get(clockId: number, _precision: bigint, resultPtr: number): number {
			// bigint存纳秒，避免JS number不能精确保存很大epoch纳秒整数。
			let nanoseconds: bigint;
			// QuickJS seeds Math.random() from this reading in microseconds and turns 0 into 1, so seed s reads s + 1.
			// 创建期用(seed+1)微秒，避免QuickJS把0种子和1混同；非实时钟返回0。
			if (clock.creating) nanoseconds = clockId === 0 ? BigInt(clock.seed + 1) * 1000n : 0n;
			// 创建后epoch毫秒先四舍五入，再乘百万转纳秒；不是读取真实Date.now。
			else if (clockId === 0) nanoseconds = BigInt(Math.round(clock.now)) * 1_000_000n;
			// 其他clockId统一返回相对起点的虚拟经过时间。
			else nanoseconds = BigInt(Math.round(clock.now - clock.startedAt)) * 1_000_000n;
			// 在WASM内存resultPtr写64位无符号纳秒，true指定小端；不返回时间作函数结果。
			new DataView(memory.buffer).setBigUint64(resultPtr, nanoseconds, true);
			// WASI返回0表示成功，真正数据已写内存。
			return 0;
		},
		/** 按确定性PRNG填WASM请求的字节区；例长度5需两次32位draw，最后只写第二个draw的一字节。 */
		random_get(bufPtr: number, bufLen: number): number {
			// Uint8Array是内存视图，写它直接改WASM线性内存，不创建同长副本。
			const bytes = new Uint8Array(memory.buffer, bufPtr, bufLen);
			// 每四字节消费一个32位随机数。
			for (let index = 0; index < bufLen; index += 4) {
				// 闭包PRNG推进一次。
				const value = random();
				// 低字节先写；Uint8赋值保留低8位，末块用长度条件避免越界。
				for (let byte = 0; byte < 4 && index + byte < bufLen; byte++) bytes[index + byte] = value >>> (byte * 8);
			}
			// 返回WASI成功码。
			return 0;
		},
	});
}

/**
 * QuickJS writes engine diagnostics to fd 1 and 2, which the default shim
 * forwards to the host's stdout and stderr. That output belongs to the host
 * application (for example a TUI), so it is discarded. Reporting every byte as
 * written keeps libc from retrying.
 */
/** WASI输出替身工厂：读取各iovec长度并回报“已写全部”，实际不读取/转发正文，避免引擎诊断污染宿主TUI。 */
function discardOutput(memory: { readonly buffer: ArrayBufferLike }) {
	// 返回导入函数对象，不在构造时写终端。
	return {
		/** fd_write接收WASM内存指针；_fd未采用，iovec每项为32位数据指针+32位长度。只累计长度，不复制内容。 */
		fd_write(_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
			// DataView便于按字节偏移和小端读写整数。
			const view = new DataView(memory.buffer);
			// 当前调用累计宣称已写的字节数。
			let written = 0;
			// 每个iovec都读取其长度字段。
			for (let i = 0; i < iovsLen; i++) {
				// 一项8字节，+4跳过指针读长度；true表示WASI小端。
				written += view.getUint32(iovsPtr + i * 8 + 4, true);
			}
			// 把累计字节数写到nwrittenPtr，让libc不继续重试输出。
			view.setUint32(nwrittenPtr, written, true);
			// 返回成功；这并不代表数据真的到达用户stdout/stderr。
			return 0;
		},
	};
}

/** QuickJS编译异常转JSON错误文字；例SyntaxError带codemode.js行号。可选栈去尾空白，加Name: message前缀方便宿主展示。 */
function describeException(error: JSException): string {
	// 有message就带冒号，没message仅类名。
	const head = error.message ? `${error.name}: ${error.message}` : error.name;
	// stack可缺，?.只在存在时trimEnd。
	const stack = error.stack?.trimEnd();
	// 返回的是JSON字符串，不是Error对象；stack缺失时仍给head。
	return JSON.stringify({ name: error.name, message: error.message, stack: stack ? `${head}\n${stack}` : head });
}

/** Promise jobs run between two `shouldInterrupt` polls while draining the job queue. */
// 每执行50个Promise job再主动检查中断，避免微任务自旋长时间绕开引擎操作码轮询。
const JOBS_PER_POLL = 50;

/** 任意驱动/引擎错误转crash消息，例WASM trap；不假装是脚本可catch的工具失败，String转换自身仍可抛错。 */
function crashMessage(error: unknown): WorkerToHostMessage {
	// Error保留name/message组合，其他未知值只转文字。
	return { type: "crash", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
}

/**
 * 创建一份独立QuickJS实例，装prelude/桥，再把用户正文编成async函数执行，返回可递交回复/释放的session。
 * 例return await tools.echo(1)：先post call，后端收到宿主result再session.deliver继续，最终post done。
 * start模式固定时钟/随机/UTC与按seq应用；普通execute沿引擎默认时钟/随机。store已是JSON文本快照。
 * create失败会拒绝；创建后的主执行try内错误通常post crash，JS编译异常另post done失败。
 * post是调用方同步回调，若它自身抛错仍可逸出；不承诺所有宿主回调异常都被归一。done只报告结果，释放由后端负责。
 */
export async function startVm(options: StartVmOptions): Promise<VmSession> {
	// 解构本次数据和同步消息出口。
	const { data, post } = options;
	// 缺省用依赖默认栈额度，inline会显式给更小值。
	const maxStackSize = options.maxStackSize ?? MAX_STACK_SIZE;
	// 只有start携带确定性初值。
	const deterministic = data.deterministic;
	// &&在缺配置时产生undefined，否则创建VirtualClock对象；联合类型要求调用前先判断存在。
	const clock: VirtualClock | undefined = deterministic && {
		// 引擎创建期间先用种子派生时钟。
		creating: true,
		// 保存epoch起点，不读宿主Date.now。
		startedAt: deterministic.startedAt,
		// 虚拟当前时间先等于起点。
		now: deterministic.startedAt,
		// 规范成32位无符号，公共start此前也校验了范围。
		seed: deterministic.seed >>> 0,
	};
	// 异步创建独立WASM实例，这一调用在后面主try之前，失败会拒绝startVm。
	const vm = await QuickJS.create({
		// 复用编译模块，不等于复用VM状态/内存。
		wasm: options.wasm,
		// 引擎堆分配限制来自宿主，不由脚本自行提升。
		memoryLimit: data.memoryLimitBytes,
		// Without a guard, deep recursion overflows the wasm stack and traps instead of throwing a
		// catchable RangeError.
		// 栈守卫让深递归尽量变可catch RangeError，而非直接宿主栈溢出。
		maxStackSize,
		// 引擎执行期间也轮询同一shouldInterrupt。
		interruptHandler: options.shouldInterrupt,
		// 确定性模式改时钟/随机，普通模式只覆盖输出，不覆盖默认时钟/随机。
		wasi: clock ? deterministicWasi(clock) : discardOutput,
		// 位掩码清掉WEAK_REF同时限制相关弱引用能力，时区固定UTC；普通模式不写这些覆盖字段。
		...(clock ? { timezoneOffset: 0, intrinsics: Intrinsics.ALL & ~Intrinsics.WEAK_REF } : {}),
	});
	// 引擎初始化完成，之后WASI时钟使用虚拟当前时间，不再用seed派生值。
	if (clock) clock.creating = false;
	// session销毁标记，防重复释放及迟到回复。
	let disposed = false;
	/** Calls the script has issued, tools and globals; reported with every `idle`. */
	// tools和globals共同累计issued，和只记普通工具的宿主calls账不同。
	let issued = 0;
	/** Deterministic mode: the next result to apply, and results that arrived before it. */
	// 确定性下一个应应用的结果号从1开始，不按到达顺序直接应用。
	let nextSeq = 1;
	/** The result being processed, 0 during the script's first run; reported with `done`. */
	// 正在处理的结果号，初次脚本运行尚未收到结果故为0。
	let current = 0;
	// 先到的后序结果按seq缓存，等前面的缺口补齐。
	const early = new Map<number, HostToWorkerMessage>();
	/** 实际应用一条回答：把普通宿主值换成VM句柄，调用prelude.settle，再推进Promise jobs；调用者必须在VM栈外。 */
	const apply = (message: HostToWorkerMessage): void => {
		// scope自动释放这次临时创建的数字/字符串/返回值句柄，保留外层api/settle生命周期。
		vm.withScope(() => {
			// callFunction参数依次是函数句柄、this句柄、实参句柄；不是直接把宿主对象跨进VM。
			vm.callFunction(
				// prelude返回对象上的settle函数句柄。
				settle,
				// this设为prelude API对象。
				api,
				// 调用id转VM number句柄。
				vm.newNumber(message.id),
				// 使用依赖缓存的true/false单例，不为它们单独手动释放。
				message.ok ? vm.true : vm.false,
				// JSON载荷文本转VM string；undefined用VM单例，不等于宿主undefined直接传参。
				message.payload === undefined ? vm.undefined : vm.newString(message.payload),
				// 附加错误属性同样以JSON文字跨桥。
				message.properties === undefined ? vm.undefined : vm.newString(message.properties),
			);
		});
		// settle完成对应Promise后，推进脚本后续await回调直到再次等待/结束。
		drain();
	};
	// 先建句柄闭包，api/settle/drain稍后初始化，正常后端等startVm完成后才外部调用deliver。
	const session: VmSession = {
		/** 接宿主回复；普通模式直接apply，确定性模式验seq并缓冲，按连续seq应用，错误转crash。不是收到任意回复就必然执行脚本。 */
		deliver(message) {
			// 已dispose的迟到回答无操作。
			if (disposed) return;
			// 应用/排序/VM异常由此转换为crash。
			try {
				// 没虚拟clock表示普通execute，不要求seq。
				if (!clock) {
					// 立即settle并drain，宿主谁先完成通常谁先交结果。
					apply(message);
					// 普通路径不进确定性排序。
					return;
				}
				// start的回复必须带seq。
				const { seq } = message;
				// 缺序号、非整数、已过序号或当前已缓存重复都会拒绝。
				if (seq === undefined || !Number.isInteger(seq) || seq < nextSeq || early.has(seq)) {
					// 这是VM驱动错误，catch后报告crash，不在此让宿主直接throw。
					throw new Error(`Result ${message.id} has sequence number ${seq}, expected ${nextSeq} or later, once`);
				}
				// 先按序号保存；若缺nextSeq，下面循环一次也不会执行。
				early.set(seq, message);
				// 只有当前期待的seq已经存在才恢复，之后连续消耗已缓存的后序结果。
				for (let next = early.get(nextSeq); next !== undefined; next = early.get(nextSeq)) {
					// 应用前移除当前项，避免重复留在早到缓存。
					early.delete(nextSeq);
					// Never backwards: a resumed host's clock may be behind the one that started the run.
					// 有限now候选取max，重启后宿主时钟较早也不会倒退；没合法now就维持原时钟。
					if (next.now !== undefined && Number.isFinite(next.now)) clock.now = Math.max(clock.now, next.now);
					// 在apply前设置current，脚本本轮done会带这个进度。
					current = nextSeq;
					// 真正恢复脚本；可能同步发新调用/输出/终态给post。
					apply(next);
					// 每应用一项后报告idle，宿主已结束时后端/公共层可忽略迟到idle。
					post({ type: "idle", seq: nextSeq, issued });
					// 当前结果消费完成，下次要下一连续编号。
					nextSeq++;
				}
			} catch (error) {
				// 驱动错误转基础设施crash；post本身若再throw不由这条catch内部重新捕获。
				post(crashMessage(error));
			}
		},
		/** 标记销毁并释放整个实例，重复无操作；不等待宿主工具或网络，也不清应用层持久store。 */
		dispose() {
			// 防第二次释放同实例。
			if (disposed) return;
			// 先挡后续deliver。
			disposed = true;
			// SDK清除句柄、回调及exports/instance/module引用，交宿主GC回收；不保证内存当场归还，不能再用旧JSValueHandle。
			vm.dispose();
		},
	};

	// JSValueHandle是WASM里JS值的宿主引用，不是普通宿主JS对象。
	let api: JSValueHandle;
	// prelude的settle函数，生命期和VM同长。
	let settle: JSValueHandle;
	// prelude的“无恢复来源却仍等待”检测函数。
	let stalled: JSValueHandle;
	// `executePendingJobs()` runs the queue to empty without a chance to interrupt, so jobs run one at a
	// time through the (internal, but public) exports; quickjs-wasi is pinned to an exact version.
	// 固定依赖版本下直接取底层导出，一次执行一个Promise job，避免不可插入检查的整队列drain。
	const exports = vm._getExports();
	/** Run queued jobs, then fail a script that waits on nothing that can ever resume it. */
	/** 清Promise job队列，每50项额外查中断；清完再检测死等。例await new Promise(()=>{})且无宿主调用时会报告脚本永不可恢复。 */
	const drain = () => {
		// 这次drain局部job计数重新开始，launcher自己的总轮询额度不会因此清零。
		let jobs = 0;
		// 只要引擎还有待执行微任务就继续。
		while (exports.qjs_is_job_pending()) {
			// A job only fails for uncatchable errors, such as an interrupt.
			// 底层job执行返回负值表示失败，外层转换crash/timeout原因。
			if (exports.qjs_execute_pending_job() < 0) throw new Error("Promise job failed");
			// 每到50的倍数主动查一次，配合引擎正常操作码轮询拦微任务自旋。
			if (++jobs % JOBS_PER_POLL === 0 && options.shouldInterrupt()) throw new Error("Execution interrupted");
		}
		// jobs为空后让prelude判断是否还有宿主pending；返回值句柄立即dispose。
		vm.callFunction(stalled, api).dispose();
	};

	// 从这里起包装前导/桥/用户编译及初段执行错误；create本身不在本try内。
	try {
		// Called from the prelude with primitives only.
		/** 暴露给prelude闭包的唯一宿主桥；kind/a/b/c按约定只用原始值编码，用户脚本不直接拿到此函数引用。 */
		// 参数是C调用方拥有的borrowed句柄，SDK不把它们纳入withScope自动释放；要跨回调保留时需dup，此处只即时读取。
		const bridge = vm.newFunction("bridge", (kind, a, b, c) => {
			// 将kind句柄转字符串分派；未知kind无分支，最后仍返回vm.undefined。
			switch (kind.toString()) {
				// 普通工具调用。
				case "call":
				// 全局函数调用，与工具共享调用编号。
				case "global":
					// 两类都增加确定性累计issued。
					issued++;
					// 同步post调用消息，后端必须避免借此重入当前VM。
					post({
						// 给宿主统一call外壳。
						type: "call",
						// id由VM内部递增，句柄转number。
						id: a.toNumber(),
						// VM桥kind区分宿主路由的tool/global。
						target: kind.toString() === "call" ? "tool" : "global",
						// 原始工具/全局名称，不是正规化脚本别名。
						name: b.toString(),
						// 缺参数用undefined，其余把JSON文字句柄转字符串；不是此处解析业务JSON。
						args: c === undefined || c.isUndefined ? undefined : c.toString(),
					});
					// 完成此桥消息，不退出脚本。
					break;
				// 前导输出助手请求追加文字/图片。
				case "output":
					// 将原始字符串字段组装成宿主输出片段。
					post({
						// 输出外壳与最终return分开。
						type: "output",
						// 三元选择image、console文本、普通文本。
						item:
							// a是输出类别句柄。
							a.toString() === "image"
								? // 图片保持base64/MIME文字，实际格式检查主要在prelude.image。
									{ type: "image", data: b.toString(), mimeType: c.toString() }
								: // console输出带特殊标记，宿主可独立渲染。
									a.toString() === "console"
									? // true为字面量标记，不是日志严重等级。
										{ type: "text", text: b.toString(), console: true }
									: // 其他输出类别归普通text，不在此完整验证协议枚举。
										{ type: "text", text: b.toString() },
					});
					// 这条输出报告完成。
					break;
				// 前导脚本报告成功/失败，不在这里立刻dispose VM。
				case "done": {
					// The host stops the VM on `done`, so the `idle` of this drain never arrives: report its numbers here.
					// start带当前seq/累计issued，普通execute不带during。
					const during = clock ? { during: { seq: current, issued } } : {};
					// 成功标志来自VM布尔值句柄转换。
					if (a.toBoolean()) {
						// 成功结束消息，宿主再解JSON值/写集合。
						post({
							// 标签done。
							type: "done",
							// 真值成功。
							ok: true,
							// return值JSON文字或undefined，没在此插入output数组。
							value: b === undefined || b.isUndefined ? undefined : b.toString(),
							// store写集合仍为JSON文字，由宿主校验/解码。
							writes: c.toString(),
							// 仅确定性模式有during。
							...during,
						});
					} else {
						// 失败载荷是prelude描述过的错误JSON文字，不是宿主Error实例。
						post({ type: "done", ok: false, error: b.toString(), ...during });
					}
					// 结束此桥调用分支。
					break;
				}
			}
			// 宿主桥返回VM的undefined单例，不把post结果暴露给脚本。
			return vm.undefined;
		});

		// These handles live as long as the VM, which the caller disposes as a whole.
		// 用scope建prelude API：临时参数/函数句柄自动释放，只逃逸最终返回对象。
		api = vm.withScope((scope) =>
			// escape让返回API句柄活过当前scope，后面跟整个VM一起释放。
			scope.escape(
				// 先eval得到前导函数，再调用它装能力。
				vm.callFunction(
					// 文件名只供栈诊断，未读名为codemode-prelude.js的磁盘文件。
					vm.evalCode(PRELUDE_SOURCE, "codemode-prelude.js"),
					// 前导函数this为VM undefined。
					vm.undefined,
					// 将唯一宿主bridge函数句柄交闭包，不安装到用户globalThis。
					bridge,
					// 工具目录先JSON.stringify，再作为VM字符串传入。
					vm.newString(JSON.stringify(data.tools)),
					// 全局声明同样走JSON文字。
					vm.newString(JSON.stringify(data.globals)),
					// store已是键→JSON文字字典，这里再编码外壳交prelude解析。
					vm.newString(JSON.stringify(data.store)),
				),
			),
		);
		// 取API对象上的函数句柄，后续每条工具回复使用它。
		settle = api.getProp("settle");
		// run负责调用用户async函数并监听最终Promise。
		const run = api.getProp("run");
		// stalled负责识别没有工具/计时器能唤醒的永久等待。
		stalled = api.getProp("stalled");
		// 只有start需要启动环境指纹。
		if (clock) {
			// 依赖给出QuickJS-WASI与引擎版本。
			const versions = vm.versions;
			// 未给额度就显示none，worker依靠宿主deadline/shared flag而非inline额度。
			const budget = options.interruptBudget ?? "none";
			// 在运行用户正文前同步报告started。
			post({
				// 这是确定性协议的启动标签。
				type: "started",
				// 组合引擎版本、实际prelude字符串hash、语义版本、栈/堆/额度；不是密码学认证或自动历史比较。
				fingerprint: `quickjs-wasi ${versions["quickjs-wasi"]}, quickjs ${versions.quickjs}, prelude ${PRELUDE_HASH}, deterministic ${DETERMINISTIC_VERSION}, stack ${maxStackSize}, heap ${data.memoryLimitBytes ?? "none"}, budget ${budget}`,
			});
		}

		// The prefix shares the first line with the script so reported line numbers
		// match the script as written.
		// 用户函数句柄与prelude API分开持有。
		let fn: JSValueHandle;
		// 单独识别JS编译异常，作为script失败而不是泛化sandbox。
		try {
			// 包成async箭头函数体：允许顶层await/return；前缀和正文共首行保持行号，首行列号仍可能偏移。
			fn = vm.evalCode(`(async (tools, console) => {${data.code}\n})`, "codemode.js");
		} catch (error) {
			// 只有依赖JSException才走脚本语法错误路径，其他异常外抛给主catch。
			if (!(error instanceof JSException)) throw error;
			// 脚本编译失败用done而非crash；此路径未附during。
			post({ type: "done", ok: false, error: describeException(error) });
			// 仍返回session，后端负责最终释放。
			return session;
		}
		// 调用prelude.run传入用户函数，run监听Promise；本次返回句柄立即释放。
		vm.callFunction(run, api, fn).dispose();
		// run内部已拿到函数引用，释放宿主fn句柄不等于撤销正在运行的脚本。
		fn.dispose();
		// 推进初次async执行产生的Promise jobs，直到等待工具或结束。
		drain();
		// start初轮进度seq=0；若done已先决定结果，后端/宿主会忽略此迟到idle。
		if (clock) post({ type: "idle", seq: 0, issued });
	} catch (error) {
		// VM驱动/前导等主try内异常转crash，宿主按sandbox或中断原因归类。
		post(crashMessage(error));
	}
	// VM可已报告结果，也可等宿主工具；返回session不自动dispose。
	return session;
}
