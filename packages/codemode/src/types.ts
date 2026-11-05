/**
 * codemode的公共数据契约：工具如何注册、脚本会产出什么、普通execute与可重放start各自接受什么。
 * interface/type在编译后擦除，不会校验外部JSON，也不会替宿主执行工具或持久化store。
 * 结果用ok:true/false区分成功与失败，调用方先判断ok，再读取value/storeWrites或error。
 */
// 不透明WASM模块类型仅用于配置，type导入不在运行时加载wasm.ts。
import type { CodemodeWasmModule } from "./wasm.ts";

/** 宿主工具的调用上下文；信号是合作式取消请求，工具自己决定如何响应，并不强行回滚副作用。 */
export interface CodemodeToolContext {
	/**
	 * Aborted when the script finishes (including unawaited calls), the
	 * execution times out, the caller aborts, or the sandbox is closed.
	 */
	// Execution结束会abort仍在pending里的调用；已完成并移出pending的调用不在该轮取消清理中。
	signal: AbortSignal;
}

/** A JSON Schema document. Only used to render declarations; values are not validated against it. */
// 索引签名允许任意schema键，但其值是unknown；true/false分别代表允许任意值/不允许任何值的schema。
export type CodemodeJsonSchema = { [key: string]: unknown } | boolean;

/** 一个宿主可执行能力的注册项；例{name:"echo",execute:args=>args}可供脚本await tools.echo("hi")，schema只负责介绍文字。 */
export interface CodemodeTool {
	/**
	 * The script calls tools as `tools.<id>(args)`, where `<id>` is the name with characters that
	 * are not valid in identifiers replaced by `_` (see `toCodemodeIdentifier`), and also as
	 * `tools["<name>"](args)`. Globals are called as `<name>(args)` and must be identifiers, or
	 * `<namespace>.<member>`, which groups them into a frozen namespace object.
	 */
	// 普通工具名映射ASCII标识符，也尝试保留原名访问；键碰撞时前导脚本先占者优先，不保证每个别名都指向当前工具。
	// 全局名允许plain或namespace.member，公共构造器另检查全局名冲突；start还检查工具脚本名重复。
	name: string;
	/** Shown as a doc comment in {@link renderDeclarations}, and listed in `ALL_TOOLS` for tools. */
	// 可选说明，供声明和ALL_TOOLS展示；不改变执行权限。
	description?: string;
	/** Schema of the single argument. Rendered as the parameter type; `unknown` when omitted. */
	// 单个入参的展示schema；这里不会根据schema校验脚本传来的args。
	inputSchema?: CodemodeJsonSchema;
	/** Schema of the resolved value. Rendered as the promise type; `unknown` when omitted. */
	// 异步完成值的展示schema；不会保证execute实际返回值符合它。
	outputSchema?: CodemodeJsonSchema;
	/** Globals only: `execute` receives all call arguments as an array instead of the first one. */
	// 只有宿主全局函数采用spread时，execute收到实参数组；否则通常只传第一实参。
	spread?: boolean;
	/**
	 * Globals only: TypeScript parameter list and return type for {@link renderDeclarations}, for
	 * example `(type: string, id?: string): Promise<Model[]>`. Replaces the rendering from the schemas.
	 */
	// 可手写如(type: string): Promise<string[]>；只覆盖展示，不改变spread或执行实现。
	signature?: string;
	/**
	 * `args` is whatever the script passed, after a JSON round trip. The return
	 * value must be JSON-serializable; a thrown error surfaces in the script as
	 * an `Error` with the same message.
	 */
	// unknown要求宿主自己理解参数；Promise<unknown>|unknown允许异步或同步结果，跨VM仍通过JSON值通信。
	execute(args: unknown, context: CodemodeToolContext): Promise<unknown> | unknown;
}

/**
 * One item of the script's output, in the order the script produced it: `text()` and `console.*`
 * produce text items, with `console: true` for `console.*`, and `image()` image items. `data` is base64.
 */
/** 输出的带标签联合：type字段决定有text还是data/mimeType。它不同于脚本return的最终value。 */
export type CodemodeOutputItem =
	// console?:true只能省略或为字面量true，标记console输出；不是任意boolean。
	| { type: "text"; text: string; console?: true }
	// 图片正文为base64字符串，MIME描述格式；类型定义不解码或验图片。
	| { type: "image"; data: string; mimeType: string };

/** 工具调用账目状态：成功、失败或执行结束时仍未完成而取消；cancelled不证明宿主副作用已经停止。 */
export type CodemodeCallStatus = "ok" | "error" | "cancelled";

/** 一次普通工具调用的摘要；宿主全局函数不加入result.calls。 */
export interface CodemodeCall {
	// 原工具名称，不一定等于脚本点访问用的正规化名。
	name: string;
	// 每项只有一个状态；记录初始化cancelled，完成时再改ok/error。
	status: CodemodeCallStatus;
	// 宿主performance.now计的真实经过时间；start的虚拟Date时钟不会替换这份耗时。
	durationMs: number;
}

/** 失败类别用于调用方分支处理；脚本自身异常、时限、取消、基础设施故障各有不同含义。 */
export type CodemodeErrorKind =
	/** The script threw or failed to parse. `name` and `stack` come from the script's error. */
	// 脚本throw或JS解析失败，名称/栈来自脚本错误文本。
	| "script"
	/**
	 * The overall deadline expired, or a VM on the calling thread used up its interrupt budget.
	 * The execution ended and the VM was asked to stop; a worker or remote VM may still be computing.
	 */
	// 超时或中断额度耗尽：宿主已决定失败并请求停止，worker/远程VM仍可能继续一段。
	| "timeout"
	/** The caller's signal fired or the sandbox was closed. The execution ended and the VM was asked to stop. */
	// 调用方信号或close触发，不是脚本内普通catch能够恢复的工具拒绝。
	| "aborted"
	/**
	 * The VM or its transport failed outside the script's control (for example a wasm trap, a missing
	 * worker file, or a remote sandbox that failed).
	 */
	// VM或传输桥失败，如WASM trap、worker入口缺失；不简单等于用户脚本写错。
	| "sandbox";

/** 统一错误对象；kind供程序分支，message供展示，name/stack允许缺失。 */
export interface CodemodeError {
	// 固定类别，不用人类可读message推断错误种类。
	kind: CodemodeErrorKind;
	// 原错误类名可能没有，例如单纯的传输报错。
	name?: string;
	// 可读原因；本类型没有脱敏或本地化保证。
	message: string;
	// 可能是QuickJS栈，不保证符合V8格式或存在。
	stack?: string;
}

/** Keys the script changed with `store()`. Only successful executions report writes. */
/** 脚本store写集合，只在成功结果返回；需要调用方选择保存到会话/数据库，沙箱不会自动持久化。 */
export interface CodemodeStoreWrites {
	// 键→新值；Record<string,unknown>不代表该值已通过应用自己的业务schema验证。
	set: Record<string, unknown>;
	/** Keys stored as `undefined`. */
	// 被store(key,undefined)删除的键；delete在这里是对象字段名，不是执行delete语句。
	delete: string[];
}

/**
 * `output` is kept for failed executions too, up to the failure. `exit()` completes with `value: undefined`.
 * `during`: in a {@link CodemodeSandboxBase.start} run that the script itself ended (it returned, threw, or exited),
 * the result being processed when it did.
 */
/** 用ok字面量区分两种结果；例if(result.ok)读取result.value，否则读取result.error。失败仍带已收集的output/calls。 */
export type CodemodeResult =
	// |后的第一种对象形状是成功分支。
	| {
			// true是精确字面量，TS据此排除下面的失败分支。
			ok: true;
			// 脚本return值；exit()/没有显式return通常为undefined，使用前需收窄unknown。
			value: unknown;
			// text/image/console输出；value不会自动插入此数组，展示由宿主选择。
			output: CodemodeOutputItem[];
			// 普通工具调用摘要，不包含globals。
			calls: CodemodeCall[];
			// 只有成功分支有写集合；工具已经做的IO并不会随脚本失败自动回滚。
			storeWrites: CodemodeStoreWrites;
			// start由脚本自行结束时可报告处理到哪份结果，普通execute通常没有。
			during?: CodemodeDuring;
	  }
	// 第二种形状为失败，没有value或storeWrites字段。
	| {
			// false使if(!result.ok)分支可安全读取error。
			ok: false;
			// 失败的统一错误；脚本失败一般作为此结果返回，而不是Promise拒绝。
			error: CodemodeError;
			// 保留失败前输出，方便诊断中途执行到哪里。
			output: CodemodeOutputItem[];
			// 保留工具摘要；未完成项在结束时仍记cancelled。
			calls: CodemodeCall[];
			// 脚本自行throw也可能带during；外部取消/超时不保证带它。
			during?: CodemodeDuring;
	  };

/** Options every sandbox accepts, wherever its VM runs. */
/** 所有沙箱共有配置；工具/全局能力决定脚本能做什么，后端位置由不同沙箱类决定。 */
export interface CodemodeSandboxBaseOptions {
	// 普通tools注册表，构造时缺省为空。
	tools?: CodemodeTool[];
	/**
	 * Functions exposed as top-level identifiers instead of on `tools`, for host helpers such as
	 * attaching an image to the result. They behave like tools (JSON round trip, promise result)
	 * but are not recorded in `result.calls`. Names must be identifiers and may not shadow the
	 * built-in globals (`tools`, `ALL_TOOLS`, `console`, `text`, `image`, `exit`, `store`, `load`).
	 */
	// 全局函数和namespace.member能力；与tools分开存，名字检查不允许遮住内建全局。
	globals?: CodemodeTool[];
	/**
	 * Overall deadline per execution, including time spent in tools. `Infinity` disables the
	 * deadline; the execution then only ends when the script settles or is aborted.
	 * Default: 300000.
	 */
	// execute默认300000毫秒，Infinity关闭该定时器；初始store序列化在Execution计时前，start也不继承该默认。
	timeoutMs?: number;
	/**
	 * Maximum memory the QuickJS VM may allocate. Allocations beyond it fail inside the script as
	 * `InternalError: out of memory`. Default: no limit beyond wasm32's 4 GiB address space.
	 */
	// 限制QuickJS VM堆，不是整个宿主/worker进程内存硬上限；后端还可能有自己的限制。
	memoryLimitBytes?: number;
}

/** Options of `CodemodeSandbox`, which runs each VM in a Node or Bun worker thread. */
/** extends继承公共选项，再加Node/Bun线程专属配置；不会因为声明接口就创建线程。 */
export interface CodemodeSandboxOptions extends CodemodeSandboxBaseOptions {
	/**
	 * Compiled `quickjs-wasi/quickjs.wasm`, usually from {@link loadQuickJSWasm}. Default:
	 * `loadQuickJSWasm()`, the file in the installed `quickjs-wasi` package. Pass it when that file
	 * is not on disk, for example in a Bun compiled executable.
	 */
	// 联合允许编译模块或尚在加载的Promise，便于跨多次执行共享编译成本。
	wasm?: CodemodeWasmModule | Promise<CodemodeWasmModule>;
	/**
	 * Worker entry that imports `@earendil-works/pi-codemode/worker`. Default: this package's own
	 * worker file. Pass it when this package is bundled, since the default is resolved relative to
	 * the module that creates the sandbox. Bun compiled executables require the relative string
	 * specifier of an embedded build entrypoint; other hosts usually use a URL.
	 */
	// URL或字符串均可；Bun嵌入入口通常用相对字符串，普通源/发布文件可用URL。
	workerUrl?: string | URL;
	/**
	 * Synchronously reserves capacity immediately before creating each worker, after loading wasm.
	 * Throw to deny admission without starting a worker. Return a release callback, called once if
	 * worker construction fails or when the worker actually exits, not when the result settles.
	 * The release callback must not throw. Reservations can be shared across sandbox instances.
	 */
	/** 可选同步准入钩子；例reserve成功返回release，失败throw拒绝启动。返回类型()=>void是释放回调，必须不抛错，真实exit或构造失败时调用。 */
	acquireWorker?(): () => void;
	/**
	 * Called once for each worker started by execute() or start(). `exited` resolves when that worker
	 * actually exits, which may be after the result and close() settle: on Bun a non-interruptible
	 * built-in can delay termination. Use it to keep the worker counted against host concurrency
	 * limits until it exits. A thrown callback error fails the execution and requests worker termination.
	 */
	/** 可选生命周期通知：拿到真实线程退出Promise。结果/close可能先完成，宿主可在此继续占用并发名额；钩子抛错会失败并请求停止。 */
	onWorkerStarted?(exited: Promise<void>): void;
}

/** A call the script made in a {@link CodemodeSandboxBase.start} run, answered with `CodemodeRun.deliver()`. */
/** start模式向宿主报告的一次调用；宿主自己执行并用run.deliver回答，沙箱不自动运行注册工具。 */
export interface CodemodeHostCall {
	/** The VM's own number for the call, `1`, `2`, ... in the order the script made its calls (tools and globals). */
	// VM递增编号，工具与globals共享序列，不等于宿主回复的seq。
	id: number;
	// target字面量联合用来选择工具或全局函数路由。
	target: "tool" | "global";
	// 原始能力名称，宿主据此寻找实现。
	name: string;
	/** What the script passed, after a JSON round trip; for spread globals the argument list. */
	// 已JSON往返的值；spread全局为实参数组，非JSON语义不会完整保留。
	args: unknown;
}

/** A tool as a {@link CodemodeSandboxBase.start} run's script sees it: `tools.<name>` and its `ALL_TOOLS` entry. */
/** start只声明脚本可见工具名/说明，不带execute和schema；实现由onCall的宿主决定。 */
export interface CodemodeDeclaredTool {
	// 名称必须和其他工具不重复，start负责检查。
	name: string;
	/**
	 * The identifier the script uses, `tools.<jsName>`. Default: `toCodemodeIdentifier(name)`. A host that replays a run
	 * passes the one the run started with, so a changed mapping cannot rename a tool under a resumed script.
	 */
	// 可显式冻结旧映射以重放；省略时走toCodemodeIdentifier，start另检查脚本名重复。
	jsName?: string;
	// ALL_TOOLS中的可读介绍，未提供时运行数据会填空串。
	description?: string;
}

/** A global as a {@link CodemodeSandboxBase.start} run's script sees it; the same names as `globals` allow. */
/** start中的全局声明；只有名称和传参模式，没有真实执行函数。 */
export interface CodemodeDeclaredGlobal {
	// 名称需符合普通标识符或namespace.member规则，构造启动处会检查。
	name: string;
	// true令脚本所有实参作为数组交给onCall.args，省略等于false。
	spread?: boolean;
}

/**
 * A call's answer. A rejection becomes an `Error` with `message` in the script, carrying the own properties of
 * `properties` (JSON values; `name`, `message`, and `stack` are ignored), for example `{ structuredOutput }`.
 */
/** 一次调用的回答，和整个脚本CodemodeResult不同；工具失败可被脚本try/catch，因此回答ok:false不必然导致全脚本失败。 */
export type CodemodeOutcome =
	// 成功回答携带值；JSON序列化失败会抛错并保留等待，宿主可重新提供可序列化的回答。
	| { ok: true; value: unknown }
	// 失败回答提供message和可选附加属性，脚本看到Error；name/message/stack不会被properties覆盖。
	| { ok: false; message: string; properties?: Record<string, unknown> };

/** In a {@link CodemodeSandboxBase.start} run: the result the VM was processing when the script finished, 0 for its first run, and the calls issued by then. */
/** 确定性执行的进度位置；它不自动持久化日志，仅让宿主知道何时结束。 */
export interface CodemodeDuring {
	// 正在处理的宿主结果序号，0表示尚未处理任何结果的初次运行。
	seq: number;
	// 到结束这一刻总共发出的调用数，包括globals。
	issued: number;
}

/** start可重放运行配置；同环境指纹/代码/初值/按序回复可重现行为，不意味外部工具本身也确定或会自动回滚。 */
export interface CodemodeRunOptions {
	/** The VM clock's start, in ms since the epoch: `Date.now()` until the first result arrives. */
	// 虚拟Date时钟初值，毫秒epoch；start检查有限且非负。
	startedAt: number;
	/** Seeds `Math.random()` and the VM's other randomness. A 32-bit unsigned integer. */
	// 0到0xffffffff的整数种子，start检查；影响VM随机序列。
	seed: number;
	// 本次独立工具声明，不使用沙箱原先的tools实现表。
	tools?: CodemodeDeclaredTool[];
	// 本次独立全局声明，同样由onCall回答。
	globals?: CodemodeDeclaredGlobal[];
	// 初始load快照，Readonly只防通过此类型重赋键，不是深冻结；跨桥时JSON序列化。
	store?: Readonly<Record<string, unknown>>;
	// 调用方可中止整个运行；不是给脚本一个可catch后继续的普通错误回答。
	signal?: AbortSignal;
	/** Deadline of this run in ms. Default: none (not the sandbox's default). */
	// 此处缺省无定时器，即使沙箱构造设了timeoutMs；时间额度仍计宿主等待，合作停止边界看后端。
	timeoutMs?: number;
	/** The VM's fingerprint, before the script runs and before any of its calls. */
	/** 可选启动通知，收到引擎/prelude/限制指纹；宿主可据此拒绝不一致的重放，类型本身不会自动比较历史。 */
	onStarted?(fingerprint: string): void;
	/** The script made a call. Answer it with `CodemodeRun.deliver()`, now or later. */
	/** 必需调用回调；例收到{id:1,args:"hi"}后用run.deliver(1,now,1,{ok:true,value:"hi"})回答，可异步稍后回答。 */
	onCall(call: CodemodeHostCall): void;
	/**
	 * The VM processed result `seq` (`0`: the script's first run, before any result) and waits again, having issued
	 * `issued` calls in total.
	 */
	/** 可选空闲通知，seq=0表示首次执行后等待；issued是累计发出的调用，不是未完成调用数量。 */
	onIdle?(seq: number, issued: number): void;
}

/** A running {@link CodemodeSandboxBase.start} execution. */
/** start立即返回的运行句柄；result异步完成，deliver可多次回答各个等待中的调用。 */
export interface CodemodeRun {
	// readonly只禁止调用方重新赋result字段，不让Promise或其结果深只读。
	readonly result: Promise<CodemodeResult>;
	/**
	 * Whether the run has its outcome: the script ended, timed out, or failed, or the run was aborted. Set when that is
	 * decided, before `result` settles; calls can no longer be answered. It does not mean the VM has exited.
	 */
	// finished=true是结果已决定，比result Promise结算更早；不是线程退出证明。
	readonly finished: boolean;
	/**
	 * Answer call `id` as result number `seq`. Results are numbered 1, 2, ... without gaps, and the VM applies them
	 * strictly in that order, whatever order they arrive in: after a gap it waits for the missing number. While it
	 * processes this one, its clock reads `now` (ms since the epoch), or the previous value if `now` is earlier.
	 * Throws for a call that is not waiting for an answer, a `seq` used before, or a `now` that is not finite.
	 */
	/** 用唯一正整数seq回答仍等待的id；可乱序送达但VM按seq连续应用，now不能倒退虚拟时钟。已finished则忽略；非法序号/id/时间会抛错。 */
	// JSON.stringify抛出的异常会传播且保留等待；它不是完整JSON值验证，函数/Symbol等可能变undefined，NaN会变null。
	deliver(seq: number, now: number, id: number, outcome: CodemodeOutcome): void;
}

/** 普通execute的一次调用配置；不同于start，execute自动调用工具实现，不需要宿主逐条deliver。 */
export interface CodemodeExecuteOptions {
	// 可选取消信号；结束时公共层会撤销监听。
	signal?: AbortSignal;
	/** Overrides the sandbox default for this execution. */
	// 覆盖构造默认，undefined用原默认，Infinity禁用定时器。
	timeoutMs?: number;
	/**
	 * Values the script reads with `load(key)`. Must be JSON-serializable. The script's own
	 * `store()` calls come back as `result.storeWrites`; persisting them is up to the caller.
	 */
	// 供load读取的初始值，执行前JSON序列化；不可序列化的输入可在计时/执行创建前同步抛错。
	store?: Readonly<Record<string, unknown>>;
}
