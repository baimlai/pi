// 所属：packages/durable/src/images，Node/Bun 的 Photon 图片处理器入口，由 package.json 的 "./images/node" 导出。
// 解决的问题：Photon 解码大图会在调用线程阻塞一两秒；本文件默认把处理放进 worker 线程，并让空闲 worker 退出以
// 释放不会缩小的 Wasm 内存；worker 在当前平台无法启动时回退到调用线程。
// 职责边界：只解析 wasm、创建处理器和 worker；不判断图片格式（prepare 负责），不注册工具，不读取用户文件。
// 上游：应用 await createNodePhotonImages() 后把返回值传给 createCodingTools({ images }) 或 read；
// 下游：./node-worker.ts（worker 入口）、./index.ts 的 createPhotonImages、node:fs/promises、node:module、
// node:worker_threads。
// 错误流向：工厂本身几乎不失败（worker 模式下不立即读 wasm）；首次 prepare 启动 worker 失败且属于“worker 不可用”
// 时回退到 inProcess，其他错误原样 reject；单张图片失败由 index.ts 的 prepare 返回 undefined。
// 能力清单：
// - NodePhotonImagesOptions：worker（是否用线程，默认 true）、idleMs（空闲退出毫秒，默认 30000）。
// - createNodePhotonImages(options)：async 工厂，返回 ImageProcessor。
// - inProcess()：内部，直接在主线程读取 wasm 并创建处理器。
// - WorkerUnavailable：内部错误类，区分“worker 启动失败”和“某张图片处理失败”。
// - PhotonThread：内部类，管理一个 worker、未完成请求、空闲计时和退出回调。
// 组合与典型顺序：createNodePhotonImages() → 第一次 prepare 惰性 new PhotonThread → worker 回复；
// 队列清空后 unref 并启动 idle 计时 → 超时 terminate，onExit 清空 thread → 下次 prepare 再建新 worker。
// 示例：
//   const images = await createNodePhotonImages({ idleMs: 60_000 });
//   const prepared = await images.prepare(bytes, "image/png", DEFAULT_IMAGE_LIMITS);
// 注意：worker 模式下工厂返回的 await 不等待 wasm 读取；真正启动 worker 发生在第一次 prepare。
// 建议阅读顺序：先看 NodePhotonImagesOptions 与 createNodePhotonImages，再看 inProcess/WorkerUnavailable，
// 最后读 PhotonThread 的构造函数、prepare、#settled/#exit 生命周期。
// readFile 用于 worker:false / 回退路径的异步读取；createRequire 在 ESM 中解析已安装的 wasm 路径。
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
// Worker 是 Node 的 worker_threads 线程类；这里只用它启动 node-worker.ts。
import { Worker } from "node:worker_threads";
// 以下三个是类型：ImageProcessor 是返回接口，ImageLimits/PreparedImage 只用于方法签名。
import type { ImageLimits, ImageProcessor, PreparedImage } from "../tools/image-processor.ts";
// 共享工厂：在回退路径中直接初始化 Photon。
import { createPhotonImages } from "./index.ts";
// 消息形状从 worker 入口模块做纯类型导入；不会因此启动或执行 worker 文件。
import type { PrepareReply, PrepareRequest } from "./node-worker.ts";

// 选项对象：两个字段都可省略，因此都有默认行为；readonly 只是编译期约束。
// 例：createNodePhotonImages({ worker: false }) 让所有图片在主线程处理，便于调试或无法使用 worker 的平台。
export type NodePhotonImagesOptions = {
	// worker 是可选布尔值（? 表示可省略）；只有显式 false 才关闭线程，undefined 采用默认 true。
	// 类型只在编译期检查；运行时传入其他值也不会被本文件校验。
	/**
	 * Prepare images in a worker thread, so a large photo does not block the event loop for the second or two Photon
	 * takes. Default `true`; `false` prepares them on the calling thread.
	 */
	readonly worker?: boolean;
	// idleMs 是可选毫秒数；用 ?? 取默认值，因此 0 会被保留（表示最后一次回复后尽快退出）。
	// 它只在 worker 模式生效；worker:false 时该值被忽略。
	/**
	 * How long the worker stays after its last image before it exits, freeing Photon's WebAssembly memory, which never
	 * shrinks while it lives. The next image starts a new one. Default 30 s.
	 */
	readonly idleMs?: number;
};

// 函数说明：createNodePhotonImages 接收可选的 worker/idleMs 配置，返回 Promise<ImageProcessor>。
// 输入缺省为 {}；worker 为 false 时立即走 inProcess（读取 wasm）；否则返回一个惰性启动 worker 的处理器。
// 副作用：worker:false 时异步读 wasm 并初始化 Photon；默认路径只创建闭包，不启动线程、不读文件。
// 错误：worker:false 时 wasm 解析/读取/初始化错误会让 Promise reject；默认路径的错误推迟到第一次 prepare。
// 主流程：判断 worker 开关 → 保存 idleMs/thread/fallback 状态 → 返回 { prepare }，首次调用才建线程。
// 示例：const images = await createNodePhotonImages(); // 默认 worker
//       const inline = await createNodePhotonImages({ worker: false, idleMs: 0 });
// 上面第二例的 idleMs 在 worker:false 下不生效；await 只等待工厂返回对象。
/**
 * `createPhotonImages()` for Node and Bun, with Photon's WebAssembly read from the installed `@silvia-odwyer/photon`,
 * by default in a worker thread that keeps the process alive only while it prepares an image. A worker that cannot
 * start falls back to the calling thread. A single-file binary cannot resolve the package: read its own copy of
 * `photon_rs_bg.wasm` and call `createPhotonImages()`.
 */
export async function createNodePhotonImages(options: NodePhotonImagesOptions = {}): Promise<ImageProcessor> {
	// 严格比较 false：只有调用方明确关闭才走调用线程；undefined 保持默认的 worker 模式。
	if (options.worker === false) return inProcess();
	// ?? 只对 null/undefined 取默认值；idleMs: 0 会被保留，而不是被 30000 覆盖。
	const idleMs = options.idleMs ?? 30_000;
	// 两个闭包变量按处理器实例隔离：thread 为空表示下次 prepare 需要新建 worker；
	// fallback 一旦设置，就表示当前平台无法使用 worker，之后所有图片都在调用线程处理。
	let thread: PhotonThread | undefined;
	let fallback: Promise<ImageProcessor> | undefined;
	// 返回的对象满足 ImageProcessor；prepare 的 async 方法允许内部 await 线程回复。
	return {
		async prepare(bytes, mimeType, limits) {
			// 已确定回退时不再尝试 worker；fallback 是 Promise，可能仍在读取 wasm，因此 await 后再调用。
			if (fallback !== undefined) return (await fallback).prepare(bytes, mimeType, limits);
			try {
				// ??= 仅当 thread 为 null/undefined 时创建；onExit 回调把 thread 清空，使空闲退出后能重建。
				thread ??= new PhotonThread(idleMs, () => {
					thread = undefined;
				});
				// await 把 worker 的回复（或拒绝）转成本次 prepare 的结果；thread 仍保留给后续并发请求。
				return await thread.prepare(bytes, mimeType, limits);
			} catch (error) {
				// 只有“worker 启动不了”才回退；单张图片的错误应原样抛给调用方，不能悄悄换执行路径。
				if (!(error instanceof WorkerUnavailable)) throw error;
				// No worker on this platform or build: prepare here from now on.
				// 只创建一次 fallback Promise，后续 prepare 共用同一个主线程处理器；读取 wasm 的错误会向外传。
				fallback = inProcess();
				return (await fallback).prepare(bytes, mimeType, limits);
			}
		},
	};
}

// 内部函数：在调用线程读取已安装包中的 photon_rs_bg.wasm，并初始化 Photon 处理器。
// 无参数；返回 Promise<ImageProcessor>。副作用是读取文件并占用 Wasm 内存；不启动线程。
// 错误路径：包未安装、文件缺失、读取失败或 initSync 初始化失败都会让返回的 Promise reject。
// 示例（内部调用）：const inline = await inProcess();
async function inProcess(): Promise<ImageProcessor> {
	// createRequire(import.meta.url) 以本模块为基准解析依赖；resolve 只计算路径，不加载模块。
	// 单文件打包产物没有 node_modules 时，这一步会抛错，调用方需要自行提供 wasm 并直接用 createPhotonImages。
	const path = createRequire(import.meta.url).resolve("@silvia-odwyer/photon/photon_rs_bg.wasm");
	// readFile 返回 Buffer（Uint8Array 子类）；createPhotonImages 的 SyncInitInput 接受 BufferSource。
	// 这里 await 文件读取，然后再同步初始化 Wasm；两步的错误都由返回的 Promise 传播。
	return createPhotonImages(await readFile(path));
}

/** The worker could not start, as opposed to failing on one image. */
// 内部标记类：只有“worker 无法启动”才抛它；它区分回退条件与单张图片处理错误。
// extends Error 让 instanceof 在运行时可靠识别；catch 中不做 message 文本比较。
class WorkerUnavailable extends Error {}

// 内部类：封装一个 worker 线程、尚未回复的请求、空闲计时器和退出回调。
// 生命周期由 createNodePhotonImages 的闭包持有；一个实例只服务一个 worker，worker 退出后实例被丢弃。
// 并发：prepare 可被多次调用，每个请求有独立 id 与 Promise；worker 内部串行执行像素工作。
// 错误：构造时无法 new Worker 会抛 WorkerUnavailable；运行中 worker 崩溃会拒绝所有 pending 请求。
/** One worker thread and the requests it has not answered; it exits after `idleMs` without requests. */
class PhotonThread {
	// # 前缀是 ECMAScript 私有字段：运行时真正不可从类外访问，不同于 TypeScript 的 private 修饰符。
	// #worker 由构造函数赋值；#pending 用「请求 id → 延迟 Promise」记录等待回复的调用。
	readonly #worker: Worker;
	// PromiseWithResolvers 是 ES2024 的全局辅助类型/函数；Map 的值保存 resolve/reject 对。
	readonly #pending = new Map<number, PromiseWithResolvers<PreparedImage | undefined>>();
	// 空闲多少毫秒后退出；#onExit 在退出时通知工厂清空 thread 引用。
	readonly #idleMs: number;
	readonly #onExit: () => void;
	// 单调递增的请求 id；每个实例从 0 开始，reply 按这个 id 找回请求。
	#nextId = 0;
	// setTimeout 的返回值类型在不同运行环境可能不同，ReturnType<typeof setTimeout> 让类型跟随当前环境。
	// undefined 表示当前没有安排退出计时。
	#idle: ReturnType<typeof setTimeout> | undefined;
	/** Whether the worker answered once: a failure before that means it is unavailable. */
	// 首次收到任意回复后置 true；在此之前发生 error/exit 视为“worker 本身不可用”，可回退到调用线程。
	#started = false;

	// 构造函数：接收空闲毫秒数与退出回调，立即创建 worker 并挂好事件监听。
	// 输出是已可用的实例；副作用是启动线程（初始处于 unref 状态）。启动失败抛 WorkerUnavailable。
	// 主流程：保存配置 → 选择 .ts/.js 入口 → new Worker → unref → 监听 message/error/exit。
	// 示例（内部）：new PhotonThread(30_000, () => { thread = undefined; });
	constructor(idleMs: number, onExit: () => void) {
		this.#idleMs = idleMs;
		this.#onExit = onExit;
		// Run from source under a TypeScript runtime, as in tests; built, the worker sits next to this file as JS.
		// 这是运行时字符串判断：源码测试时 import.meta.url 以 .ts 结尾；构建后同目录生成 node-worker.js。
		const file = import.meta.url.endsWith(".ts") ? "./node-worker.ts" : "./node-worker.js";
		try {
			// new URL(相对路径, 当前模块 URL) 得到绝对 file: URL；Worker 接受 URL 并自行加载入口。
			this.#worker = new Worker(new URL(file, import.meta.url));
		} catch (error) {
			// 入口缺失、平台不支持 worker 等同步失败统一转成内部标记错误，并保留原始原因。
			throw new WorkerUnavailable("The Photon image worker cannot start", { cause: error });
		}
		// unref 后，空闲 worker 不会单独阻止 Node 进程退出；prepare 会临时 ref。
		this.#worker.unref();
		// 每次收到回复：先记录 worker 确实工作过，再按 id 找请求。
		this.#worker.on("message", (reply: PrepareReply) => {
			this.#started = true;
			// 找不到对应请求时直接忽略：可能是 worker 崩溃后清理过 pending，迟到的回复没有等待者。
			const request = this.#pending.get(reply.id);
			if (request === undefined) return;
			// 先从 Map 删除，避免重复回复或清理逻辑再次结算同一个 Promise。
			this.#pending.delete(reply.id);
			// "error" in reply 是编译期的联合收窄，同时也是运行时属性检查；成功分支没有 error 字段。
			if ("error" in reply) request.reject(new Error(reply.error));
			else request.resolve(reply.result);
			// 队列空了就安排空闲退出；仍有 pending 时保持 worker ref 状态。
			this.#settled();
		});
		// fail 处理 error 与 exit 两种失败：首个回复前失败归因于“worker 不可用”，之后归因于运行错误。
		const fail = (error: unknown): void => {
			// #started 为 false 时把任意启动失败包装成 WorkerUnavailable，供 createNodePhotonImages 决定是否回退。
			const failure = this.#started
				? error
				: new WorkerUnavailable("The Photon image worker cannot start", { cause: error });
			// 所有等待中的请求都以同一失败原因 reject；clear 防止之后重复结算。
			for (const request of this.#pending.values()) request.reject(failure);
			this.#pending.clear();
			// 通知工厂清空 thread，下一次 prepare 会尝试新建 worker（或再次回退）。
			this.#exit();
		};
		// "error" 事件带原始错误；"exit" 只有退出码，这里包装成 Error 以便统一处理。
		this.#worker.on("error", fail);
		this.#worker.on("exit", (code) => fail(new Error(`The Photon image worker exited with code ${code}`)));
	}

	// 方法说明：把一个图片处理请求发给 worker，返回在回复到达时结算的 Promise。
	// 输入 bytes/mimeType/limits 原样进入消息；输出成功为 PreparedImage | undefined，worker 崩溃或 prepare
	// 意外 reject 时 Promise 被拒绝。副作用：复制字节、转移副本、临时 ref worker、占用一个 pending id。
	// 主流程：分配 id → 建延迟 Promise → 登记 pending → 取消空闲计时 → ref → 复制并转移字节 → postMessage。
	// 示例（内部）：const result = await thread.prepare(pngBytes, "image/png", limits);
	prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits): Promise<PreparedImage | undefined> {
		// 后自增：本次使用旧值作为 id，再把 #nextId 加一；id 在实例内唯一。
		const id = this.#nextId++;
		// Promise.withResolvers 一次返回 { promise, resolve, reject }，适合把回调式回复桥接成 Promise。
		const request = Promise.withResolvers<PreparedImage | undefined>();
		this.#pending.set(id, request);
		// 有新请求就取消空闲退出计时，避免 worker 在处理图片时被定时器终止。
		if (this.#idle !== undefined) clearTimeout(this.#idle);
		this.#idle = undefined;
		// A pending image keeps the process alive, as one prepared on the calling thread would.
		// ref 抵消构造函数里的 unref：有未完成请求时，Node 进程不会提前退出。
		this.#worker.ref();
		// A copy, transferred: the caller keeps its bytes.
		// slice() 复制一份 Uint8Array；transfer 列表把副本的 ArrayBuffer 所有权移交给 worker，主线程仍保留原数组。
		const copy = bytes.slice();
		// satisfies 在编译期确认消息符合 PrepareRequest，但不改变运行时对象；第二个参数是转移列表。
		this.#worker.postMessage({ id, bytes: copy, mimeType, limits } satisfies PrepareRequest, [copy.buffer]);
		// 返回 promise 而不是等待：调用方 await 时，回复由 message 监听器 resolve/reject。
		return request.promise;
	}

	// 私有方法：一次回复处理完后调用；队列为空时启动空闲退出计时。
	// 输入无；输出无；副作用是 unref worker、安排定时器并 unref 定时器。没有错误路径。
	// 主流程：仍有 pending → 直接返回；否则 unref → setTimeout(退出) → 计时器 unref。
	#settled(): void {
		// 还有请求在等回复时不安排退出，避免终止正在使用的 worker。
		if (this.#pending.size > 0) return;
		// 没有请求了，worker 不应再阻止进程退出；下次 prepare 会再次 ref。
		this.#worker.unref();
		// 到期时先通知工厂（清空 thread），再异步 terminate；terminate 返回 Promise，void 表示不等待。
		this.#idle = setTimeout(() => {
			this.#exit();
			void this.#worker.terminate();
		}, this.#idleMs);
		// 计时器本身也不阻止进程退出；否则空闲处理器会让进程多活 idleMs。
		this.#idle.unref();
	}

	// 私有方法：取消空闲计时（若存在）并通知工厂本实例已退出；可重复调用，不抛错。
	// 退出后工厂的 thread 变为 undefined，下一次 prepare 会创建新 worker。
	#exit(): void {
		if (this.#idle !== undefined) clearTimeout(this.#idle);
		this.#idle = undefined;
		// onExit 是构造函数传入的闭包，由 createNodePhotonImages 负责把 thread 置空。
		this.#onExit();
	}
}
