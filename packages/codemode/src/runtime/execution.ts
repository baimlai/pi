/**
 * codemode的公共宿主执行管线：三种VM后端都复用这里的工具调度、输出、结果、超时、取消及可重放回复。
 * 区分三件事：脚本结果已决定、停止请求已结算、VM/宿主工具真正停止；它们不保证同一时刻发生。
 * 普通execute自动运行宿主工具；start只报告调用，等宿主deliver按编号回答，不替宿主保存可重放日志。
 */
/**
 * Host side of an execution, shared by every place a VM can run.
 *
 * The host owns everything the script must not influence: the tool table, call records, output,
 * the deadline, the caller's abort signal, and the decoding of what the VM reports. The VM itself
 * runs somewhere a {@link VmLauncher} decides: a worker thread (`CodemodeSandbox`), the calling
 * thread (`InlineCodemodeSandbox`), or another isolate reached over RPC (`RemoteCodemodeSandbox`).
 * The two sides only exchange the messages in `protocol.ts`, so the launchers differ in transport
 * and termination, not in behavior.
 *
 * Lifecycle of one execution:
 * 1. The constructor arms the deadline and abort listener, then asks the launcher for a channel.
 * 2. Messages from the VM arrive through {@link VmEvents.message}; tool calls run here and their
 *    results go back through {@link VmChannel.post}. Replies produced before the launcher has
 *    returned its channel are queued and flushed when it arrives.
 * 3. The first terminal event wins: `done`, `crash`, a launcher failure, the deadline, or an abort.
 *    `finish()` aborts pending tool calls, asks the channel to stop, and resolves the result once
 *    that request completes. A worker or remote VM may exit later. Later events are ignored.
 *
 * The launcher, not this class, is responsible for actually stopping a running VM: a worker is
 * terminated, an in-thread VM is interrupted and disposed, and a remote VM is told to stop at its
 * next exchange.
 */
// 名称正规化规则与声明生成共用，例如my-tool→my_tool；这里只取函数，不加载Node线程后端。
import { toCodemodeIdentifier } from "../identifier.ts";
// 这一组都是编译期契约；type导入在JS中擦除，详细字段见types.ts。
import type {
	// 单次工具调用的状态和真实耗时。
	CodemodeCall,
	// ok/error/cancelled字面量联合。
	CodemodeCallStatus,
	// start的全局名称/传参声明。
	CodemodeDeclaredGlobal,
	// start的工具名/脚本名声明。
	CodemodeDeclaredTool,
	// 确定性运行结束时的seq/issued。
	CodemodeDuring,
	// 统一失败原因，不是直接抛给脚本的Error实例。
	CodemodeError,
	// 普通execute的单次参数。
	CodemodeExecuteOptions,
	// 宿主对一条调用的成功或失败回答。
	CodemodeOutcome,
	// 输出text/image的标签联合。
	CodemodeOutputItem,
	// 整次执行的成功/失败联合。
	CodemodeResult,
	// start返回的运行句柄。
	CodemodeRun,
	// start的时间、种子、声明及回调。
	CodemodeRunOptions,
	// 各沙箱共享默认配置。
	CodemodeSandboxBaseOptions,
	// 成功执行的set/delete写集合。
	CodemodeStoreWrites,
	// 真正可由宿主调用的工具定义。
	CodemodeTool,
} from "../types.ts";
// 混合导入：只有守卫函数为运行值，其余type条目擦除。
import {
	// 发回VM的工具回复消息类型。
	type HostToWorkerMessage,
	// 只识别已知type外壳，不深度验证每个消息字段。
	isWorkerToHostMessage,
	// 传给后端的纯数据启动包。
	type VmStartData,
	// VM发回的调用/输出/结束/进度联合。
	type WorkerToHostMessage,
} from "./protocol.ts";

// 普通execute默认5分钟；start另有默认无时限的规则。
const DEFAULT_TIMEOUT_MS = 300_000;
// ASCII标识符字符形状，不排除保留字；全局名最多只允许一个点。
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// ReadonlySet只限制通过此类型修改；这些名字不可被自定义全局遮盖。
const RESERVED_GLOBALS: ReadonlySet<string> = new Set([
	// 工具对象命名空间。
	"tools",
	// 工具目录。
	"ALL_TOOLS",
	// 输出日志助手。
	"console",
	// 文字输出助手。
	"text",
	// 图片输出助手。
	"image",
	// 成功提前结束助手。
	"exit",
	// 当前全局对象。
	"globalThis",
	// 状态写入助手。
	"store",
	// 状态读取助手。
	"load",
]);

/** Callbacks a launcher uses to report what its VM does. */
/** 后端报告VM行为的回调；公共Execution承接消息与失败，后端不自己组装最终脚本结果。 */
export interface VmEvents {
	/** A message from the VM. Validated here, so launchers can pass through anything they receive. */
	/** 接收wire unknown；例{type:"done",...}经识别/解码后决定结果，不能假定所有载荷字段已验证。 */
	message(message: unknown): void;
	/** The VM failed or stopped outside the bridge, for example a worker exit or a remote error. */
	/** 报告VM/传输故障；例worker提前exit，公共层仅在尚未结束时采用该失败。 */
	failure(error: CodemodeError): void;
}

/** The host's handle on a running VM. */
/** 已启动后端的通信句柄：宿主用post回答调用，用stop请求结束；返回句柄不代表VM已空闲。 */
export interface VmChannel {
	/** 发一条工具回答；具体后端可能postMessage、直接VM递交或完成远端exchange。 */
	post(message: HostToWorkerMessage): void;
	/** Requests VM shutdown. Called once; may resolve before a worker or remote VM actually exits. */
	/** 请求停止并返回完成Promise；按后端契约，它可早于真实worker退出，不保证宿主工具副作用停下。 */
	stop(): Promise<void>;
}

/**
 * Starts a VM for one execution. Rejections become `sandbox` errors with the rejection's message.
 * The VM may start reporting messages before the returned promise settles.
 */
// 函数类型联合允许同步通道或Promise通道；启动中也可能先收到消息，所以要有unsent队列。
export type VmLauncher = (data: VmStartData, events: VmEvents) => VmChannel | Promise<VmChannel>;

/** 任意捕获异常转文字；Error用message，其他走String。例throw "bad"→bad；自定义字符串转换若抛错仍会传播。 */
export function errorMessage(error: unknown): string {
	// instanceof只用于未知异常，不对已有静态类型参数多做猜测。
	return error instanceof Error ? error.message : String(error);
}

/** 初始store逐值转JSON文本；undefined/函数/Symbol等stringify为undefined就省略，BigInt/环等异常传播。发生在创建Execution/启动时限前，不持久化或深验证值。 */
function serializeStore(store: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
	// 新建普通对象保存键→JSON文字；不是Map，也不做特殊键规范化。
	const serialized: Record<string, string> = {};
	// Object.entries只看自有可枚举字符串键，未传store时用{}。
	for (const [key, value] of Object.entries(store ?? {})) {
		// 每个值单独序列化，toJSON等可执行调用方对象上的方法。
		const json = JSON.stringify(value);
		// 只保存有JSON文本的值，不把undefined硬写成字符串"undefined"。
		if (json !== undefined) serialized[key] = json;
	}
	// 返回传给VM的快照文字，不返回对原对象的可变引用。
	return serialized;
}

/**
 * The prelude that serializes values for the host runs in the same VM as the script, so a script
 * that patches built-ins (for example `Array.prototype.toJSON`) can make it send malformed data.
 * Payloads that do not decode throw this error, and the execution fails as a sandbox error.
 */
/** 桥载荷不满足当前解码规则时的内部类别；例如writes不是数组。由receive包装成sandbox失败。 */
class BridgeError extends Error {}

/** 解码VM发来的JSON文字；例"{坏"抛带what上下文的BridgeError，正确JSON仍返回unknown，下一层再检查结构。 */
function parseBridgeJson(json: string, what: string): unknown {
	// 只包JSON.parse本身，把语法解析失败统一成桥错误。
	try {
		// 数字/数组/null等也都是可解析JSON，不在此判业务形状。
		return JSON.parse(json);
		// 此catch不使用原解析器错误细节。
	} catch {
		// what标明是返回值、store写入还是脚本错误出错。
		throw new BridgeError(`${what} is not valid JSON`);
	}
}

/** 解码成功done的写集合：[["n","1"],["old"]]→set.n=1及delete:["old"]。只校验该协议形状，未持久化、未在此再核VM额度。 */
function parseStoreWrites(json: string): CodemodeStoreWrites {
	// 先解出外层JSON，元素值暂时未知。
	const entries = parseBridgeJson(json, "store writes");
	// wire边界要求数组，拒绝null/普通对象等。
	if (!Array.isArray(entries)) throw new BridgeError("store writes are not an array");
	// 普通对象set和数组delete分开积累；这里不自动合并冲突键。
	const writes: CodemodeStoreWrites = { set: {}, delete: [] };
	// 遍历每条[key,json]或[key]。
	for (const entry of entries) {
		// 三部分共同约束每条写记录，任何错误使整次桥解码失败。
		if (
			// 必须为数组，不能把任意对象当元组。
			!Array.isArray(entry) ||
			// 键必须字符串。
			typeof entry[0] !== "string" ||
			// 长2时第二项必须JSON字符串；否则只允许长1表示删除。
			(entry.length === 2 ? typeof entry[1] !== "string" : entry.length !== 1)
		) {
			// 错误不返回部分写集合。
			throw new BridgeError("store writes contain a malformed entry");
		}
		// 形状检查后断言元组类型；string?表示第二项可省略。
		const [key, value] = entry as [string, string?];
		// 没第二项就记录删除，不先操作宿主store。
		if (value === undefined) writes.delete.push(key);
		// 有文字则再解码JSON值；set是普通对象赋值，不提供特殊键隔离/重复写检测。
		else writes.set[key] = parseBridgeJson(value, `store value for ${JSON.stringify(key)}`);
	}
	// 此结果只描述写集，实际是否落库/写会话由调用方决定。
	return writes;
}

/** 脚本错误JSON转统一script错误；message必为字符串，name/stack可缺。例{"message":"bad"}有效；只判非null对象，没有排除数组。 */
function parseScriptError(json: string): CodemodeError {
	// 解析文字语法，仍需检查字段形状。
	const parsed = parseBridgeJson(json, "script error");
	// typeof null也是object，须额外排除；不验证原型或额外键。
	if (typeof parsed !== "object" || parsed === null) throw new BridgeError("script error is not an object");
	// 只取三字段，其他错误属性不进入此最终错误对象。
	const { name, message, stack } = parsed as Record<string, unknown>;
	// 错误消息必须存在且为字符串，可选字段一旦提供也必须为字符串。
	if (
		// undefined/null/数字message都拒绝。
		typeof message !== "string" ||
		// name缺失允许，不把非字符串强制转换。
		(name !== undefined && typeof name !== "string") ||
		// stack缺失允许，不假定总有调用栈。
		(stack !== undefined && typeof stack !== "string")
	) {
		// 桥格式错误不是用户脚本Error本身，交receive归sandbox。
		throw new BridgeError("script error is malformed");
	}
	// 固定kind:script；对象简写{name}沿用已收窄的局部值。
	return { kind: "script", name, message, stack };
}

/** 仍在等待结果的调用状态，结束时用它发取消和更新耗时；globals的record为空但仍会被取消。 */
interface PendingCall {
	// 普通工具才有账目，global不加入result.calls。
	record: CodemodeCall | undefined;
	// performance.now真实时钟，不是start虚拟Date.now。
	startedAt: number;
	// 每条调用独立控制器，避免单条操作互相干扰。
	controller: AbortController;
}

/** Checks global names: identifiers or `namespace.member`, not shadowing a built-in global or each other. */
/** 检查全局名形状、重复、内建保留名及namespace冲突；例models.list合法，models与models.list共存会抛错。无IO，不验证自定义函数实现。 */
function checkGlobals(globals: readonly CodemodeDeclaredGlobal[]): void {
	// 保存完整名称，检查完全相同的重复。
	const names = new Set<string>();
	// 保存namespace部分，用于最后检查与普通全局函数重名。
	const namespaces = new Set<string>();
	// 按注册顺序逐个检查声明。
	for (const global of globals) {
		// 按点拆；零个点普通函数，一个点命名空间成员。
		const parts = global.name.split(".");
		// 超一层点、空/非法片段或第一片段为保留名都拒绝；不完整检查JS保留字或所有内建全局。
		if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part)) || RESERVED_GLOBALS.has(parts[0])) {
			// 直接给出哪条全局名不合规则。
			throw new Error(`Invalid global name "${global.name}"`);
		}
		// 完全重复不静默覆盖。
		if (names.has(global.name)) throw new Error(`Global "${global.name}" is already registered`);
		// 两片段形式记录namespace。
		if (parts.length === 2) namespaces.add(parts[0]);
		// 记整个名称，不只记成员名。
		names.add(global.name);
	}
	// 所有名收集好后再判，输入顺序不影响namespace冲突检测。
	for (const name of namespaces) {
		// 例models与models.list会争用同一个globalThis.models。
		if (names.has(name)) throw new Error(`Global "${name}" conflicts with the namespace "${name}"`);
	}
}

/** Callbacks of a host-controlled run: its calls go to the caller, which answers them with `deliver()`. */
// Pick只取start的三个回调类型，保持与公开接口一致，不复制其余选项。
type Control = Pick<CodemodeRunOptions, "onStarted" | "onCall" | "onIdle">;

/** 内部单次执行参数；默认值和JSON快照在公共入口算好，再交Execution。 */
interface ExecutionOptions {
	// 本次JS异步函数体。
	code: string;
	// 给VM看的只读工具声明列表。
	tools: readonly CodemodeDeclaredTool[];
	// 给VM看的全局名称/传参列表。
	globals: readonly CodemodeDeclaredGlobal[];
	/** Run the script's calls; unused when `control` is set. */
	// 普通execute按名称找宿主实现，start改由control回答，故传空Map。
	executors: { tools: ReadonlyMap<string, CodemodeTool>; globals: ReadonlyMap<string, CodemodeTool> };
	// 有限数才安装timer，Infinity/NaN都不安装；这里不另校验正数/整数。
	timeoutMs: number;
	// 外部取消信号，可明确undefined。
	signal: AbortSignal | undefined;
	// VM堆限制，可缺。
	memoryLimitBytes: number | undefined;
	// 预先序列化的load快照。
	store: Record<string, string>;
	// start才固定虚拟时间和随机源。
	deterministic?: { startedAt: number; seed: number };
	// 存在就走宿主控制模式，不自动调用executors。
	control?: Control;
	// 具体后端的启动函数。
	launch: VmLauncher;
}

/** One script run in its own VM. */
/** 一次脚本的宿主状态机；首次终态决定结果，工具/输出/时限都留在宿主，后端只负责VM。 */
class Execution {
	// 给公共入口等待的结果Promise，readonly不让结果深只读。
	readonly promise: Promise<CodemodeResult>;
	// !是确定赋值断言；构造中的Promise executor同步填入resolve函数。
	private resolveResult!: (result: CodemodeResult) => void;
	// 后端异步启动期间没有通道。
	private channel: VmChannel | undefined;
	/** Replies produced before the launcher returned the channel. */
	// VM可能先发调用而启动Promise还没交通道，回复暂存在这里。
	private unsent: HostToWorkerMessage[] = [];
	// 索引访问类型复用ExecutionOptions里同一字段定义。
	private readonly executors: ExecutionOptions["executors"];
	// 有control就转发调用；没有则自动执行工具。
	private readonly control: Control | undefined;
	/** Result numbers `deliver()` used. */
	// start已使用的回复seq，防同一结果号重复；不同于调用id。
	private readonly delivered = new Set<number>();
	// 结束时撤销同一外部信号监听。
	private readonly signal: AbortSignal | undefined;
	// ReturnType取当前运行环境的定时器句柄类型。
	private readonly timer: ReturnType<typeof setTimeout> | undefined;
	// 按VM报告顺序保留输出，不自动把return值加进去。
	private readonly output: CodemodeOutputItem[] = [];
	// 按普通工具调用发起顺序保留摘要，globals不入账。
	private readonly calls: CodemodeCall[] = [];
	// id→未回答调用；Map为空不必然代表脚本已结束。
	private readonly pending = new Map<number, PendingCall>();
	/** Whether the execution has its outcome. */
	// true表示结果已决定，早于Promise完成和可能更晚的真实线程exit。
	finished = false;

	/** 创建结果Promise→装时限/取消→构建启动数据→调用后端。例外部信号已abort时不启动VM；加载/启动晚到会请求stop，不覆盖旧结果。 */
	constructor(options: ExecutionOptions) {
		// Promise executor同步运行，这里不启动异步任务本身。
		this.promise = new Promise<CodemodeResult>((resolve) => {
			// 保存resolve，finish以后才完成Promise。
			this.resolveResult = resolve;
		});
		// 保存宿主实现路由表。
		this.executors = options.executors;
		// 保存可选控制回调。
		this.control = options.control;
		// 保存外部取消信号引用。
		this.signal = options.signal;

		// 仅有限数字有timer；Infinity用于显式禁用，NaN也会跳过但不表示合法输入已验证。
		if (Number.isFinite(options.timeoutMs)) {
			// 事件循环有机会运行才触发；调用线程VM同步计算可能阻塞定时器，需另靠中断额度。
			this.timer = setTimeout(() => {
				// 通过统一finish争取首次结果，不直接终止工具或线程。
				this.finish({ kind: "timeout", message: `Execution timed out after ${options.timeoutMs} ms` });
				// 延时使用原数，负数/小数等遵循宿主setTimeout规则，未在此归一化。
			}, options.timeoutMs);
		}

		// 有信号才安装或立即响应。
		if (options.signal) {
			// 信号在入口前就取消，立即走onAbort。
			if (options.signal.aborted) {
				// onAbort会决定aborted结果。
				this.onAbort();
			} else {
				// once只自动消费一次事件，finish仍主动移除未触发监听。
				options.signal.addEventListener("abort", this.onAbort, { once: true });
			}
		}
		// 立即取消后不再创建启动数据/后端。
		if (this.finished) return;

		// 只把普通数据交给VM，不传宿主工具函数引用。
		const data: VmStartData = {
			// 原脚本文字由后端编译。
			code: options.code,
			// 声明投影为VM需要的三个字段。
			tools: options.tools.map((tool) => ({
				// 原名用于宿主反向路由。
				name: tool.name,
				// 显式jsName优先，否则统一名称映射；不在此解决普通execute的碰撞。
				jsName: tool.jsName ?? toCodemodeIdentifier(tool.name),
				// 缺描述补空串，保证传输字段完整。
				description: tool.description ?? "",
			})),
			// 全局只带名称和严格布尔spread，未提供即false。
			globals: options.globals.map((global) => ({ name: global.name, spread: global.spread === true })),
			// VM内存限制仍可undefined。
			memoryLimitBytes: options.memoryLimitBytes,
			// 已序列化快照原样放入启动包。
			store: options.store,
			// 条件展开：只有start的确定性配置存在才写字段。
			...(options.deterministic ? { deterministic: options.deterministic } : {}),
		};
		// 后端靠这两个回调把消息/故障送回公共层。
		const events: VmEvents = {
			// 箭头闭包保留当前this，避免回调接收者丢失。
			message: (message) => this.receive(message),
			// 后端失败进入统一finish；已finished则忽略。
			failure: (error) => this.finish(error),
		};
		// Promise executor捕获launch同步throw，resolve同化异步Promise；then分开处理成功/失败。
		new Promise<VmChannel>((resolve) => resolve(options.launch(data, events))).then(
			// 后端通道到达时，Execution可能已决定超时/取消结果；VM仍可能在运行。
			(channel) => {
				// 启动期间先结束了，通道只需清理。
				if (this.finished) {
					// 请求stop并忽略其拒绝，不再等待后端真实线程exit。
					void channel.stop().catch(() => undefined);
					// 不把迟到通道安装进已结束状态。
					return;
				}
				// 现在才能通过通道发宿主回复。
				this.channel = channel;
				// splice(0)取出并清空早到回复，按队列顺序发送；post异常不会在这条then里另catch。
				for (const message of this.unsent.splice(0)) channel.post(message);
			},
			// 启动失败可来自加载WASM、worker构造或其他后端操作。
			(error: unknown) => {
				// 归类sandbox，已有终态会使finish无操作。
				this.finish({ kind: "sandbox", message: errorMessage(error) });
			},
		);
	}

	/** `CodemodeRun.deliver()`. */
	/**
	 * start的手动回答入口；例deliver(1,1000,call.id,{ok:true,value:42})。
	 * 校验时钟/唯一正seq/等待id→序列化→记账移除pending→发回复；VM负责按seq连续应用及虚拟时间不倒退。
	 * JSON.stringify异常在修改状态前传播，宿主可重答；函数/Symbol可变undefined、NaN变null，不是完整JSON数据验证。
	 * 已finished直接忽略；本函数不自动填缺失seq，也不替宿主执行工具。
	 */
	deliver(seq: number, now: number, id: number, outcome: CodemodeOutcome): void {
		// 已有结果时迟到回答无操作，即使传来的其他参数不合规也不再检查。
		if (this.finished) return;
		// start回复的wire/宿主控制边界，时间必须有限，但可早于上次；VM用max避免时钟倒退。
		if (!Number.isFinite(now)) throw new Error(`The clock value of result ${seq} is not a finite number`);
		// seq必须正整数且从未使用，允许先送2再送1，VM自己等缺口。
		if (!Number.isInteger(seq) || seq < 1 || this.delivered.has(seq)) {
			// 同一seq不能回答两次不同调用。
			throw new Error(`Result number ${seq} is not a positive integer used once`);
		}
		// id必须对应当前仍等待的调用。
		const pending = this.pending.get(id);
		// 不存在、已回答或已取消的id不能再回答。
		if (pending === undefined) throw new Error(`Call ${id} is not waiting for a result`);
		// 只有失败回答才检查额外Error属性容器。
		if (!outcome.ok && outcome.properties !== undefined) {
			// 解构方便读取，不克隆properties。
			const { properties } = outcome;
			// 宿主控制边界要求非null、非数组对象，不深度验证内部字段JSON性。
			if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
				// 形状不符时不消费调用或seq。
				throw new Error(`The properties of result ${seq} are not an object`);
			}
		}
		// Serialized before anything is recorded, so a value JSON cannot hold leaves the call waiting for another answer.
		// 成功载荷分undefined/JSON文字，失败载荷直接是错误message。
		const payload = outcome.ok
			? // undefined不可JSON编码，所以单独传递。
				outcome.value === undefined
				? // 通道允许payload为undefined。
					undefined
				: // stringify可抛异常，也可省略/转换某些值，不做额外round-trip检查。
					JSON.stringify(outcome.value)
			: // 失败message是字符串契约，不在此再校验静态已保证的类型。
				outcome.message;
		// 附加错误属性独立序列化；成功回答不带它。
		const properties =
			// 编码仍可能抛错，此时下面的记账尚未开始。
			!outcome.ok && outcome.properties !== undefined ? JSON.stringify(outcome.properties) : undefined;
		// 现在消费seq，防重复。
		this.delivered.add(seq);
		// 从等待表移除，使结束清理不再取消这条已回答调用。
		this.pending.delete(id);
		// 仅普通工具有摘要，global只完成桥回复。
		if (pending.record) {
			// 记录回答成功/失败，和全脚本最终是否成功独立。
			pending.record.status = outcome.ok ? "ok" : "error";
			// 真实等待时长，不使用参数now虚拟时钟。
			pending.record.durationMs = performance.now() - pending.startedAt;
		}
		// 发消息或先排队，后端负责真正传递。
		this.post({
			// 统一回复外壳。
			type: "result",
			// 原调用编号。
			id,
			// 回答类别。
			ok: outcome.ok,
			// 上面已经准备的JSON文字/错误消息。
			payload,
			// 确定性应用顺序。
			seq,
			// 处理该回复时的虚拟时间候选。
			now,
			// 仅提供额外属性时展开字段，不强制写properties:undefined。
			...(properties === undefined ? {} : { properties }),
		});
	}

	/** 宿主主动取消本次执行，返回同一结果Promise；例close用Sandbox closed理由，不等待宿主工具真的停止。 */
	abort(message: string): Promise<CodemodeResult> {
		// 首次终态才生效，后续重复abort不覆盖已有结果。
		this.finish({ kind: "aborted", message });
		// 始终返回本次同一Promise，不另外等待线程exit。
		return this.promise;
	}

	/** 外部AbortSignal监听器；箭头字段保留this，Error reason用其message，其余理由采用统一文字。 */
	private readonly onAbort = (): void => {
		// reason可以任意值，先按unknown读取。
		const reason: unknown = this.signal?.reason;
		// 取消原因不是Error时不会直接String(reason)，按当前规则回退固定提示。
		this.finish({ kind: "aborted", message: reason instanceof Error ? reason.message : "Execution aborted" });
	};

	/** 宿主→VM回复出口；有通道立即post，没有通道先排队。例启动尚未完成时同步工具返回，回复不会丢。 */
	private post(message: HostToWorkerMessage): void {
		// 通道已安装，直接调用后端post。
		if (this.channel) this.channel.post(message);
		// 后端启动中，保存同一消息对象引用等待flush。
		else this.unsent.push(message);
	}

	/** An exception here would escape into the launcher's transport and leave the execution unsettled. */
	/** wire消息总入口：捕获解析或同步回调错误，转成sandbox结果，避免异常直接逃出消息监听。异步handleCall的工作由其自身处理。 */
	private receive(message: unknown): void {
		// 所有同步分派及解码放在统一try。
		try {
			// handleMessage先忽略迟到消息，再识别type。
			this.handleMessage(message);
			// 捕获的是未知异常，不假定所有错误均来自桥载荷。
		} catch (error) {
			// 统一收尾，保留已经收集的输出/调用。
			this.finish({
				// 不把桥坏数据误归脚本throw。
				kind: "sandbox",
				// 依据内部错误类别选诊断文案。
				message:
					// BridgeError是解码/协议错误；并非证明脚本一定改过原型。
					error instanceof BridgeError
						? // 原提示给出可能原因，前导脚本也有冻结保护，不把这段文案当定因。
							`Sandbox bridge broken: ${error.message}. The script may have modified built-ins such as a prototype's toJSON.`
						: // 其他宿主同步异常用通用失败消息。
							`Sandbox host failed: ${errorMessage(error)}`,
			});
		}
	}

	/** 按消息标签分派输出、调用、启动/空闲进度或结束；只检查已知外壳，具体JSON在相应分支解码，不完整深验每个字段。 */
	private handleMessage(message: unknown): void {
		// 首次结束之后忽略迟到消息，包括worker exit/crash和输出。
		if (this.finished) return;
		// unknown wire边界只做type守卫；{type:"output"}等不完整对象也可能通过。
		if (!isWorkerToHostMessage(message)) throw new BridgeError("unknown message from the worker");
		// switch利用标签联合收窄TS分支。
		switch (message.type) {
			// 输出片段按到达顺序收集。
			case "output":
				// 直接推item，不在这里额外检查图片或字符额度；那些限制主要在VM前导脚本。
				this.output.push(message.item);
				// break结束此switch分支，不结束整个执行。
				break;
			// 请求执行工具/全局函数。
			case "call":
				// 防当前pending里重复id；不保存所有历史id来检查后续复用。
				if (this.pending.has(message.id)) throw new BridgeError(`duplicate call id ${message.id}`);
				// start模式把调用交onCall，不运行沙箱注册的实现。
				if (this.control) this.forwardCall(message, this.control);
				// 普通模式异步执行；void不等待，所以多工具能并发。
				else void this.handleCall(message);
				// 不等待工具完成就退出这次消息分派。
				break;
			// 确定性VM启动时的指纹。
			case "started":
				// 只有control及可选onStarted都存在才通知；同步throw由receive捕获。
				this.control?.onStarted?.(message.fingerprint);
				// 继续等待后续消息。
				break;
			// 确定性VM处理到一个结果后再次等待。
			case "idle":
				// 报seq和累计issued，不等于此处自动落持久日志。
				this.control?.onIdle?.(message.seq, message.issued);
				// 通知不直接结束脚本。
				break;
			// 这是脚本成功/失败的结束消息。
			case "done":
				// 先完整解码再finish，避免半初始化结果。
				this.handleDone(message);
				// 此分支结束不再处理其他标签。
				break;
			// VM/传输基础设施崩溃。
			case "crash":
				// 用sandbox错误尝试决定终态。
				this.finish({ kind: "sandbox", message: message.message });
				// 首次终态规则仍由finish控制。
				break;
		}
	}

	/** 解析done：失败解错误，成功解return及store写集合，再进入finish。Extract只取type=done的两种联合形状，不等于运行时schema验证。 */
	private handleDone(message: Extract<WorkerToHostMessage, { type: "done" }>): void {
		// Decode everything before finish(), which must not throw once it starts.
		// 失败载荷不读成功字段value/writes。
		if (!message.ok) {
			// undefined占位表示没有成功值/写集；可保留确定性during。
			this.finish(parseScriptError(message.error), undefined, undefined, message.during);
			// 不再进入成功JSON解码。
			return;
		}
		// 明确undefined直接保留，其他值按JSON文本解码。
		const value = message.value === undefined ? undefined : parseBridgeJson(message.value, "return value");
		// 在调用finish前求值写集，解析失败会由receive转sandbox而非发布成功。
		this.finish(undefined, value, parseStoreWrites(message.writes), message.during);
	}

	/** A host-controlled run: record the call and hand it to the caller, which answers with `deliver()`. */
	/** start的调用转发：解args→可选工具账目→记录pending→同步onCall。例宿主稍后deliver；onCall抛错会由receive终止执行。 */
	private forwardCall(message: Extract<WorkerToHostMessage, { type: "call" }>, control: Control): void {
		// 解构外壳字段，target决定是否记普通工具账。
		const { id, name, target } = message;
		// 未传参数保留undefined；有文字使用桥解析器，错误归BridgeError。
		const args = message.args === undefined ? undefined : parseBridgeJson(message.args, "call arguments");
		// global同样等待回复，但不用普通工具摘要。
		const record: CodemodeCall | undefined =
			// 初始cancelled是“尚未正常回答”状态，正常deliver以后改ok/error。
			target === "tool" ? { name, status: "cancelled", durationMs: 0 } : undefined;
		// 把同一账目对象存进结果列表，后续直接更新。
		if (record) this.calls.push(record);
		// 必须先登记pending再调onCall，允许宿主同步回答而不报id未知。
		this.pending.set(id, { record, startedAt: performance.now(), controller: new AbortController() });
		// 只发纯数据，不给宿主此控制器；宿主若异步操作需自行安排取消处理。
		control.onCall({ id, target, name, args });
	}

	/** 普通execute的调用管线：找实现→解args→await执行→编码回复→若尚未取消则更新账并post。工具/编码错误会变脚本可catch的拒绝，不必终止整个脚本。 */
	private async handleCall(message: Extract<WorkerToHostMessage, { type: "call" }>): Promise<void> {
		// 原名称用于查实现，与脚本别名不同。
		const { id, name } = message;
		// 只有target严格tool才选工具表，其余按global路径，wire守卫并未完整验target。
		const isTool = message.target === "tool";
		// 普通工具先记cancelled，完成后再改状态。
		const record: CodemodeCall | undefined = isTool ? { name, status: "cancelled", durationMs: 0 } : undefined;
		// global无record，但仍需pending和取消信号。
		if (record) this.calls.push(record);
		// 每调用独立控制器与起始时刻。
		const pending: PendingCall = { record, startedAt: performance.now(), controller: new AbortController() };
		// 执行前保存，结束时可同步发取消。
		this.pending.set(id, pending);

		// 两分支都要赋值，所以先声明状态。
		let status: CodemodeCallStatus;
		// 两分支都构造一条结果消息。
		let reply: HostToWorkerMessage;
		// 查表、参数解析、执行及序列化错误都统一成为工具拒绝。
		try {
			// 根据调用类别选择宿主已注册Map，不能由脚本直接拿到其他函数。
			const tool = (isTool ? this.executors.tools : this.executors.globals).get(name);
			// 未找到实现给脚本一个可读错误。
			if (!tool) throw new Error(`Unknown ${isTool ? "tool" : "global"} "${name}"`);
			// 这条路径用JSON.parse直接解码，异常在此try变工具错误，而非parseBridgeJson的BridgeError。
			const args: unknown = message.args === undefined ? undefined : JSON.parse(message.args);
			// await兼容同步结果和Promise，传本次合作取消信号；宿主工具可做真实IO。
			const value = await tool.execute(args, { signal: pending.controller.signal });
			// JSON编码返回，undefined单独通过；编码异常和工具throw一样走catch。
			reply = { type: "result", id, ok: true, payload: value === undefined ? undefined : JSON.stringify(value) };
			// 成功指宿主调用和编码完成，不是全脚本成功。
			status = "ok";
		} catch (error) {
			// 只把错误message发回脚本，不保留宿主Error对象/栈/额外字段。
			reply = { type: "result", id, ok: false, payload: errorMessage(error) };
			// 账目改为error前还要确认未被结束取消。
			status = "error";
		}

		// Already cancelled by finish(): the record keeps "cancelled" and the
		// VM is gone or going.
		// finish清过pending则delete=false，迟到工具结果不再改账或发VM回复；不代表工具副作用被撤销。
		if (!this.pending.delete(id)) return;
		// 仍有效的普通工具才更新摘要。
		if (record) {
			// 采用这次已确定的调用状态。
			record.status = status;
			// 真实耗时，包括await等待，不用脚本虚拟时钟。
			record.durationMs = performance.now() - pending.startedAt;
		}
		// 用通道或早到队列回复；这一行在上面try之外，post异常不由工具catch接住。
		this.post(reply);
	}

	/**
	 * 唯一终态入口：抢占finished→清timer/监听→取消pending→组结果→请求后端stop→完成Promise。
	 * 例脚本return时没await的工具会记cancelled并收到abort；其已发生的文件/网络副作用不回滚。
	 * 没通道就立即resolve，迟到启动完成另行stop；有通道等待的是stop请求Promise，不是worker真实exit或所有工具完成。
	 * output/calls沿用数组引用，during只挑seq/issued；失败没有storeWrites。
	 */
	private finish(
		// 有error走失败分支，undefined表示成功。
		error: CodemodeError | undefined,
		// 可选脚本return值，与output独立。
		value?: unknown,
		// 可选成功写集，缺省最终补空集合。
		writes?: CodemodeStoreWrites,
		// 可选确定性结束位置。
		during?: CodemodeDuring,
	): void {
		// 只有第一个终态生效；close/超时/done竞争时不会互相覆盖。
		if (this.finished) return;
		// 先置位，让abort回调/迟到消息不再二次收尾。
		this.finished = true;
		// 清除未来超时回调，undefined句柄也可接受。
		clearTimeout(this.timer);
		// 按同一函数引用撤掉外部取消监听。
		this.signal?.removeEventListener("abort", this.onAbort);

		// 本轮统一使用真实结束时刻统计未完成调用耗时。
		const now = performance.now();
		// pending同时包括普通工具和global。
		for (const pending of this.pending.values()) {
			// 普通工具仍保持初始化的cancelled，只补到结束时的耗时。
			if (pending.record) pending.record.durationMs = now - pending.startedAt;
			// 合作式取消通知；不会等待宿主函数真停止，也不回滚已做的操作。
			pending.controller.abort();
		}
		// 移除等待表，使迟到handleCall结果走delete=false路径。
		this.pending.clear();
		// 未发出的回复不再有必要发送给结束的VM。
		this.unsent = [];

		// 若有during，重新挑两字段，避免把其他额外字段整体透传。
		const ended = during === undefined ? {} : { during: { seq: during.seq, issued: during.issued } };
		// 三元表达式创建标签联合，error存在才带error。
		const result: CodemodeResult = error
			? // 失败仍带已收集的输出和调用，但没有value/storeWrites。
				{ ok: false, error, output: this.output, calls: this.calls, ...ended }
			: // 成功分支。
				{
					// 字面量true供TS收窄。
					ok: true,
					// 原脚本值，可能undefined。
					value,
					// 不自动合并相邻文本或图片。
					output: this.output,
					// 账目顺序沿发起顺序。
					calls: this.calls,
					// 成功但没有显式写集合时补空，不自动落盘。
					storeWrites: writes ?? { set: {}, delete: [] },
					// 条件进度字段展开。
					...ended,
				};
		// 还没拿到后端通道，例如WASM加载中就超时。
		if (!this.channel) {
			// 此时不等启动完成就给调用方结果。
			this.resolveResult(result);
			// 构造里迟到通道分支负责发stop。
			return;
		}
		// 有通道则先发后端停止请求。
		this.channel
			// 后端stop Promise可比真实线程exit更早完成。
			.stop()
			// 停止请求拒绝也不替换已决定的脚本结果。
			.catch(() => undefined)
			// 请求结算后resolve同一结果。
			.then(() => this.resolveResult(result));
	}
}

/**
 * Tool table, defaults, and in-flight executions; the behavior every sandbox shares. Subclasses
 * only choose where the VM runs by passing a {@link VmLauncher}.
 *
 * The script sees `tools.<name>(args)` for every registered tool, `ALL_TOOLS`, the output helpers
 * `text`, `image`, `exit`, and `console.*`, `store`/`load`, and the configured globals; nothing
 * else (no timers, `fetch`, `process`, `require`, modules). Each `execute()` gets its own VM; the
 * sandbox only holds the tool table and defaults. `close()` aborts in-flight executions.
 */
/** 可复用的宿主沙箱：持有工具表/默认值及正在运行的Execution；子类只提供VM位置。例一次构造可多次execute，每次独立VM，store仍由外部传入保存。 */
export class CodemodeSandboxBase {
	// name→实现，register/unregister管理。
	private readonly toolsByName = new Map<string, CodemodeTool>();
	// 全局实现固定在构造时填入，普通execute会共享此表。
	private readonly globalsByName = new Map<string, CodemodeTool>();
	// 普通execute的默认时限。
	private readonly timeoutMs: number;
	// VM堆限制，不等于整个宿主进程内存限制。
	private readonly memoryLimitBytes: number | undefined;
	// 后端启动函数，主线程、worker和remote可互换。
	private readonly launch: VmLauncher;
	// 活跃Execution集合，close据此发取消。
	private readonly running = new Set<Execution>();
	// close之后永久拒绝新execute/start，无reopen方法。
	private closed = false;

	/** 保存默认值/启动器，注册工具并检查全局；例重复工具名构造即抛错。构造不启动VM、不执行工具，保留传入工具对象引用。 */
	constructor(options: CodemodeSandboxBaseOptions, launch: VmLauncher) {
		// ??保留0等显式值，只有缺失才默认5分钟；不在这里另验数字范围。
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		// 可undefined，实际交后端/VM采用。
		this.memoryLimitBytes = options.memoryLimitBytes;
		// 仅保存函数，不先调用。
		this.launch = launch;
		// 每个工具走同一重名检查。
		for (const tool of options.tools ?? []) this.registerTool(tool);
		// 全局一次性检查名称形状、保留名与冲突。
		checkGlobals(options.globals ?? []);
		// 检查通过后按原名保存实现，不克隆工具对象。
		for (const global of options.globals ?? []) this.globalsByName.set(global.name, global);
	}

	/** Throws if a tool with the same name is already registered. */
	/** 注册一项宿主工具；例同名echo再次注册抛错，不覆盖原项。普通execute仅核原名重复，正规化脚本别名碰撞由VM前导脚本先占者优先处理。 */
	registerTool(tool: CodemodeTool): void {
		// Map.has只看注册原名，不拿toCodemodeIdentifier后的名字检查。
		if (this.toolsByName.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
		// 保存同一对象引用，后面外部修改对象字段仍可能影响实现。
		this.toolsByName.set(tool.name, tool);
	}

	/** 按原名移除，返回是否曾存在；例unregisterTool("echo")。不取消在途执行，其工具Map在execute入口已做浅快照。 */
	unregisterTool(name: string): boolean {
		// Map.delete的布尔结果直接返回，不加载/调用工具。
		return this.toolsByName.delete(name);
	}

	/** 返回当前工具列表的新数组；例只想列名称可map(t=>t.name)。数组是新容器，里面工具仍原对象，未深拷贝。 */
	get tools(): CodemodeTool[] {
		// values迭代器展开为插入顺序数组。
		return [...this.toolsByName.values()];
	}

	/** 返回全局能力的新数组视图；读取无IO，不把global隐藏的宿主函数转成沙箱内直接函数引用。 */
	get globals(): CodemodeTool[] {
		// 同样只复制外层数组，元素仍同一注册对象。
		return [...this.globalsByName.values()];
	}

	/**
	 * `code` is an async function body: `return` and top-level `await` work.
	 * Never rejects for script failures; those come back as `{ ok: false }`.
	 * The script can use `store(key, value)` and `load(key)` on `options.store`.
	 */
	/**
	 * 普通入口：检查closed→工具表浅快照→序列化初始store→创建Execution→登记运行→结束移除。
	 * 例execute("return await tools.echo(1)")自动执行注册的echo，脚本错误通常resolve为ok:false。
	 * 关闭后返回拒绝Promise；初始store序列化或构造同步异常也可直接抛出，因此不承诺所有问题都只走结果对象。
	 * 每次独立VM；不会替调用方解析@options或持久化storeWrites。
	 */
	execute(code: string, options: CodemodeExecuteOptions = {}): Promise<CodemodeResult> {
		// 已close返回Promise拒绝，不创建Execution。
		if (this.closed) return Promise.reject(new Error("Sandbox is closed"));
		// 复制工具Map，运行期间register/unregister不改本次集合；内部工具对象仍共享。
		const tools = new Map(this.toolsByName);
		// 参数对象先全部求值，才调用Execution构造并启动timer。
		const execution = new Execution({
			// code原文，不在这里trim或做安全扫描。
			code,
			// 本次工具声明取浅快照中的实现对象投影。
			tools: [...tools.values()],
			// 全局声明数组在入口取当前值。
			globals: [...this.globalsByName.values()],
			// tools用快照，globals沿用固定内部表，不做每次深复制。
			executors: { tools, globals: this.globalsByName },
			// 单次时限优先，缺省用构造默认。
			timeoutMs: options.timeoutMs ?? this.timeoutMs,
			// 取消只作用于本次Execution。
			signal: options.signal,
			// 所有本沙箱执行沿用同一VM内存配置值。
			memoryLimitBytes: this.memoryLimitBytes,
			// 同步JSON快照发生在Execution计时前，BigInt/环可此时抛错。
			store: serializeStore(options.store),
			// 让后端决定VM在哪。
			launch: this.launch,
		});
		// 即使执行已立即取消，也登记到同一集合，finally会移除。
		this.running.add(execution);
		// finally只做集合清理，返回原结果/异常；不等真实worker退出。
		return execution.promise.finally(() => this.running.delete(execution));
	}

	/**
	 * Run `code` deterministically, with the caller answering its calls: the same script, start time, seed, tools,
	 * globals, and store, answered with the same results in the same `seq` order, makes the same calls with the same
	 * arguments and produces the same output, on any VM with the same fingerprint. A host can therefore replay it
	 * after a restart. The VM runs in UTC, its clock reads `startedAt` and then the `now` of the result being
	 * processed, its randomness comes from `seed`, and `WeakRef` and `FinalizationRegistry` do not exist.
	 *
	 * The sandbox's own tools and globals are not used: the run declares its own, and every call goes to
	 * `options.onCall`. Never rejects for script failures; abort through `options.signal` to end the run with an
	 * error the script cannot catch.
	 */
	/**
	 * 可重放入口：校验初始时钟/种子/名称→独立声明和control→创建Execution→返回result/deliver/finished句柄。
	 * 例start("return 1",{startedAt:0,seed:7,onCall:()=>{}})不用工具即可完成；脚本等待调用并要继续时，宿主需deliver回答。
	 * 未await的调用可能在脚本先结束时被取消，不要求每次发出的调用都先有答案。
	 * 不使用本沙箱已注册的工具/全局实现，也不继承普通execute的默认时限；不自动持久化历史/重放外部副作用。
	 * 校验/初始JSON错误同步抛；脚本异常通过result的ok:false报告。确定性还要求相同VM指纹和相同顺序的回答。
	 */
	start(code: string, options: CodemodeRunOptions): CodemodeRun {
		// start返回句柄而不是Promise，所以关闭直接throw。
		if (this.closed) throw new Error("Sandbox is closed");
		// 宿主控制边界：虚拟初时钟需有限且非负，不要求整数。
		if (!Number.isFinite(options.startedAt) || options.startedAt < 0) {
			// 拒绝NaN/Infinity/负数，避免虚拟时钟无意义。
			throw new Error("startedAt must be a non-negative number of milliseconds since the epoch");
		}
		// 种子限制为可用无符号32位整数，0也允许。
		if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff) {
			// 十六进制0xffffffff等于4294967295。
			throw new Error("seed must be a 32-bit unsigned integer");
		}
		// 本次声明缺省空，不回退this.tools。
		const tools = options.tools ?? [];
		// 原工具名必须唯一；Set.size与长度比较找重复。
		if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error("Tool names must be unique");
		// 显式jsName优先，用旧值有助重放时保持命名。
		const scriptNames = tools.map((tool) => tool.jsName ?? toCodemodeIdentifier(tool.name));
		// start额外拒绝脚本用名碰撞；仍未在此完整验证jsName字符或保留字。
		if (new Set(scriptNames).size !== tools.length) throw new Error("Tool script names must be unique");
		// 全局同样用本次独立声明。
		const globals = options.globals ?? [];
		// 重用全局命名检查，不向本沙箱实现表注册。
		checkGlobals(globals);
		// store等参数求值仍先于Execution timer。
		const execution = new Execution({
			// 原脚本异步函数体。
			code,
			// 本次工具声明。
			tools,
			// 本次全局声明。
			globals,
			// start不会自动用实现表，传空表表示此路径没有宿主工具执行器。
			executors: { tools: new Map(), globals: new Map() },
			// 无单次timeoutMs即Infinity，明确不继承this.timeoutMs。
			timeoutMs: options.timeoutMs ?? Number.POSITIVE_INFINITY,
			// 调用方可外部取消整个run。
			signal: options.signal,
			// VM内存仍沿用沙箱公共配置。
			memoryLimitBytes: this.memoryLimitBytes,
			// 把初始值变JSON快照，可同步抛错。
			store: serializeStore(options.store),
			// 固定虚拟起点与随机种子，不影响宿主performance.now统计。
			deterministic: { startedAt: options.startedAt, seed: options.seed },
			// 存在control即转发调用，回调引用原样保存。
			control: { onStarted: options.onStarted, onCall: options.onCall, onIdle: options.onIdle },
			// 同一个后端也能启动确定性VM。
			launch: this.launch,
		});
		// 加入活跃执行集合，供close取消。
		this.running.add(execution);
		// 结果结算后移除集合，不代表后端线程已exit。
		const result = execution.promise.finally(() => this.running.delete(execution));
		// 返回普通句柄，VM执行/结果仍异步进行。
		return {
			// 结果Promise，与下面finished查询时刻不同。
			result,
			// 箭头闭包绑定当前Execution，外部调deliver不依赖句柄this。
			deliver: (seq, now, id, outcome) => execution.deliver(seq, now, id, outcome),
			/** 读取执行内部终态标记，不等价于结果Promise已结算或线程已退出。 */
			get finished() {
				// 每次访问取实时finished，不是创建句柄时拍的布尔快照。
				return execution.finished;
			},
		};
	}

	/** Aborts in-flight executions (they resolve with `kind: "aborted"`) and rejects new ones. */
	/** 永久关闭入口，取消running集合快照中的Execution并等它们结果结算。可重复调用；不等真实worker exit或宿主工具完成，副作用不回滚。 */
	// execute/start在Execution构造返回后才running.add；若自定义启动器同步回调重入close，尚未加入的这一项不在取消快照内。
	async close(): Promise<void> {
		// 先拒绝新运行，再取当前集合，避免正常新请求加入。
		this.closed = true;
		// 展开拍活跃集合快照，逐个abort后Promise.all等结果；每个结果可能早于底层真实停止。
		await Promise.all([...this.running].map((execution) => execution.abort("Sandbox closed")));
	}
}
