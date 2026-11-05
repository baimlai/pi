/**
 * 宿主与QuickJS后端之间的桥协议：启动数据、调用请求、回复、输出及结束通知。
 * 工具值通常装成JSON字符串跨桥，消息外壳用type区分；下面两个守卫仅识别外壳，不完整验证全部字段。
 * 这份类型不会发消息；实际传输由worker、inline或remote后端实现，公共Execution负责解码及结束决策。
 */
// 输出/进度只是类型依赖，编译后擦除。
import type { CodemodeDuring, CodemodeOutputItem } from "../types.ts";
// 模块类型可描述已编译WASM，运行时不因此读磁盘。
import type { CodemodeWasmModule } from "../wasm.ts";

/**
 * Messages between the host (main thread) and the worker. Tool arguments,
 * results, and values cross as JSON strings: the worker passes them into and
 * out of the QuickJS VM as strings and never builds structured values itself.
 */

/**
 * Everything a VM needs to run one script, independent of where it runs. Plain data, so it can
 * cross a `postMessage` or a Workers RPC call unchanged.
 */
/** 各种后端共用的单次VM启动数据，不含宿主execute函数，避免把函数实现直接交给脚本。 */
export interface VmStartData {
	// JS异步函数体正文，允许顶层await/return；编译由VM完成。
	code: string;
	/** `jsName` is the identifier the script uses; `description` is listed in `ALL_TOOLS`. */
	// 原名、脚本用名、说明三者都传；这里只传工具目录，不传宿主可执行闭包。
	tools: { name: string; jsName: string; description: string }[];
	// 全局函数名称及是否将所有实参打包，不带描述/schema。
	globals: { name: string; spread: boolean }[];
	// 字段必须存在但值可undefined；这不同于memoryLimitBytes?可省略字段。
	memoryLimitBytes: number | undefined;
	/** Snapshot for `load()`: key to JSON text. */
	// 初始store每个值独立序列化为JSON文字，脚本load时再解码/复制。
	store: Record<string, string>;
	/**
	 * Run deterministically (`CodemodeSandboxBase.start()`): UTC, a virtual clock starting at `startedAt` (ms since
	 * the epoch) that moves only with delivered results, randomness from `seed`, no `WeakRef`, results applied in
	 * `seq` order, and `started`/`idle` messages.
	 */
	// ?允许普通execute不带该配置；start才固定时间/随机源并发送进度消息。
	deterministic?: { startedAt: number; seed: number };
}

/** Node/Bun worker在线程共用启动数据上，另外附编译模块与共享中断标志。 */
export interface WorkerData extends VmStartData {
	/** Compiled `quickjs-wasi` module. Structured clone shares the compiled code with the worker. */
	// structured clone可共享编译代码，VM实例/线性内存仍每次新建。
	wasm: CodemodeWasmModule;
	/**
	 * One Int32 the host sets to non-zero before terminating the worker. The VM's interrupt handler
	 * polls it, because Bun's `worker.terminate()` cannot stop a thread that is spinning in wasm.
	 */
	// 一个Int32共享标志，宿主Atomics置位，VM轮询；不轮询的内建计算可能延后停止。
	interrupt: SharedArrayBuffer;
}

/** JSON-encoded `{ name?, message, stack? }` of an error thrown by the script. */
// type别名仍只是string，不因名字含Json就保证载荷可解析。
export type ScriptErrorJson = string;

/** VM→宿主的带标签联合，switch(message.type)会让TS收窄；wire真实字段仍需读取处验证/解码。 */
export type WorkerToHostMessage =
	// 请求调用：id区分并发调用，target选择工具/全局，args为JSON文本；undefined单独表示未传可编码值。
	| { type: "call"; id: number; target: "tool" | "global"; name: string; args: string | undefined }
	// 逐项输出文本/图片；它们和最终return值走不同消息。
	| { type: "output"; item: CodemodeOutputItem }
	/**
	 * `writes` is a JSON array of `[key, json]` for `store()` and `[key]` for deletions. Deterministic mode: `during`
	 * is the result the VM was processing when the script finished (0: its first run) and the calls issued by then.
	 */
	// 成功结束：value和writes仍是JSON文字，宿主解码为CodemodeResult；during仅确定性模式可能带。
	| { type: "done"; ok: true; value: string | undefined; writes: string; during?: CodemodeDuring }
	// 失败结束：error是脚本异常的JSON对象文本，不是宿主Error实例。
	| { type: "done"; ok: false; error: ScriptErrorJson; during?: CodemodeDuring }
	/** The VM failed outside the script's control, for example a wasm trap. */
	// 脚本外故障，如WASM trap，宿主归类sandbox。
	| { type: "crash"; message: string }
	/** Deterministic mode, before the script runs: what the VM is, so a replay can refuse a different one. */
	// 确定性启动先发指纹，供宿主比较重放环境；不是自动认证证明。
	| { type: "started"; fingerprint: string }
	/**
	 * Deterministic mode, after the script waits again: having processed result `seq` (0: the script's first run), it
	 * has issued `issued` calls in total.
	 */
	// 确定性VM再次等待时报告累计已发调用数和当前结果seq。
	| { type: "idle"; seq: number; issued: number };

/** 宿主→VM目前只有调用回复这一种外壳；ok仍为boolean，载荷语义由成功/失败决定。 */
export type HostToWorkerMessage =
	/**
	 * `payload` is the JSON result when `ok`, otherwise the error message. Deterministic mode: `seq` numbers the
	 * results from 1 in the order the VM applies them, and the VM's clock reads `now` while it processes this one.
	 */
	// 没有|也可把类型声明跨行写为单个对象形状。
	{
		// 字面量result用于消息识别。
		type: "result";
		// 回答VM之前发出的调用id。
		id: number;
		// true解析payload为JSON成功值，false把payload当错误消息。
		ok: boolean;
		// 成功值undefined单独表示，其余成功值JSON文本；失败通常是可读message。
		payload: string | undefined;
		// start中的回复应用顺序，1起连续；普通execute可省略。
		seq?: number;
		// start在处理这份结果时使用的虚拟epoch毫秒，实际时钟单调规则由VM维护。
		now?: number;
		/** Deterministic mode, `ok: false`: a JSON object whose properties the script's `Error` gets. */
		// start失败回答的附加Error属性JSON文本；关键错误字段不会由它覆盖。
		properties?: string;
	};

/** wire外壳识别：非null对象且type在已知六项中即true。例{type:"call"}也会通过，不保证id/name/args存在，不能当完整schema验证。 */
export function isWorkerToHostMessage(value: unknown): value is WorkerToHostMessage {
	// unknown来自传输边界，先排除原始值/null；数组若自己带type也未被这条检查排除。
	if (typeof value !== "object" || value === null) return false;
	// as只让TS读可选type，不能代替字段验证。
	const type = (value as { type?: unknown }).type;
	// 用||任一个外壳匹配即可返回true。
	return (
		// 工具/全局调用请求。
		type === "call" ||
		// 输出片段。
		type === "output" ||
		// 成功或失败的结束消息。
		type === "done" ||
		// VM基础设施故障。
		type === "crash" ||
		// 确定性启动指纹。
		type === "started" ||
		// 确定性空闲进度。
		type === "idle"
	);
}

/** wire回复外壳识别：只查非null对象且type=result；例{type:"result"}也通过，payload/id等不在此验证。value is类型谓词只帮助编译期收窄。 */
export function isHostToWorkerMessage(value: unknown): value is HostToWorkerMessage {
	// &&短路使后面的属性读取只在非null对象上发生，不深度走查载荷。
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "result";
}
