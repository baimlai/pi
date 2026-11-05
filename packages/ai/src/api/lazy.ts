// 把异步实现加载/认证准备接成同步可返回的事件流；这里不负责具体供应商协议。
import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams } from "../types.ts";
// 事件流类是真正的运行值；上一行 import type 只用于编译期。
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

/**
 * 把 setup/转发阶段的异常转为完整 assistant 错误消息，返回新对象，不请求模型。
 * 保留模型身份与开始时间，内容和用量置空/零，stopReason 固定 error；例：认证初始化失败可作为 error 事件的 error 字段交给调用方。
 */
function createSetupErrorMessage(model: Model<Api>, error: unknown, timestamp: number): AssistantMessage {
	// 构造统一错误消息，而非把异常作为流成功正文。
	return {
		// 仍用 assistant 角色承载失败状态。
		role: "assistant",
		// 准备失败没有生成内容，不伪造文字或工具调用。
		content: [],
		// 保留请求 API 标识。
		api: model.api,
		// 保留供应商标识。
		provider: model.provider,
		// 记录模型 id，未进行物理路由推断。
		model: model.id,
		// 没有实际用量可报告时用零占位，不能据此保证服务没有发生费用。
		usage: {
			// 普通输入 token 占位零。
			input: 0,
			// 输出 token 占位零。
			output: 0,
			// 缓存读取占位零。
			cacheRead: 0,
			// 缓存写入占位零。
			cacheWrite: 0,
			// 合计占位零。
			totalTokens: 0,
			// 各项估算费用占位零。
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		// setup/转发异常统一标 error，不在此根据 AbortSignal 自动改 aborted。
		stopReason: "error",
		// 外部抛出值是 unknown，Error 取 message，其他转文字。
		errorMessage: error instanceof Error ? error.message : String(error),
		// 沿用这次流创建时捕获的请求开始时间。
		timestamp,
	};
}

/**
 * 判断任意异步事件源是否还提供 result() 方法，返回布尔值并收窄类型。
 * 运行时只检查该成员是否为函数，不验证其签名/返回内容。例：带 result() 的流结束后可再读取它的权威最终消息。
 */
function hasResult(
	// 输入只承诺可异步迭代，不承诺有 result 成员。
	source: AsyncIterable<AssistantMessageEvent>,
	// 类型谓词与 & 交叉类型让真分支可调用 result()，不生成方法。
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	// as 只协调可选未知成员访问；实际能力判断由 typeof 执行。
	return typeof (source as { result?: unknown }).result === "function";
}

/** Synchronous, read-only observation of the stream's existing forwarding path. */
// 观察器在原转发路径中同步调用，void 签名不等于异常会被自动忽略。
export interface LazyStreamObserver {
	// 每个已推入外层的事件通知一次，可省略。
	onEvent?(event: AssistantMessageEvent): void;
	// 最终结果可 undefined；每次 lazyStream 通过闭包限制最多通知一次。
	onResult?(result: AssistantMessage | undefined): void;
}

/**
 * 消费内部异步流并转发事件到外部流，最后结束外部流、通知最终结果，返回 Promise<void>。
 * 逐事件保留 done/error 消息，若来源有 result() 则用它覆盖最终结果；事件与消息对象不深复制。
 * 例：内部依次 start、text_delta、done，调用者从 outer 收到相同事件；来源或观察器抛错会拒绝本函数，由 lazyStream 后续 catch 处理。
 */
async function forwardStream(
	// 目标是调用者已经拿到的外层流。
	target: AssistantMessageEventStream,
	// 来源只需实现异步迭代协议。
	source: AsyncIterable<AssistantMessageEvent>,
	// 可选同步观察器，不改变本方法的事件顺序。
	observer: LazyStreamObserver | undefined,
	// 闭包提供的一次性结果通知函数。
	observeResult: (result: AssistantMessage | undefined) => void,
	// 异步完成没有额外业务返回值；失败可拒绝。
): Promise<void> {
	// 尚未见最终事件时结果未知。
	let result: AssistantMessage | undefined;
	// for await 按来源产出顺序消费；await 迭代失败也会拒绝。
	for await (const event of source) {
		// 先将同一事件对象交外层队列。
		target.push(event);
		// 再通知观察器；?.() 允许观察器或方法未提供。
		observer?.onEvent?.(event);
		// done 携带完整成功/长度/工具/延迟结果消息。
		if (event.type === "done") result = event.message;
		// error 携带完整失败/取消消息，不是普通 Error 实例。
		else if (event.type === "error") result = event.error;
	}
	// 来源额外提供 result 时以它为最终结果，即使与最后事件所记对象不同。
	if (hasResult(source)) result = await source.result();
	// 结束外层；无最终结果时由 EventStream 自身协议处理等待者。
	target.end(result);
	// 结束后再发最终结果观察通知。
	observeResult(result);
}

/**
 * Returns a stream synchronously while running async setup (auth resolution,
 * lazy module loading) behind it. Setup failures terminate the stream with an
 * error event.
 */
/**
 * 同步返回外层事件流，同时立即调用 setup 开始异步准备与转发，不等消费者开始迭代。
 * 输入模型、返回内部 AsyncIterable 的工厂和可选同步观察器；工厂 Promise/转发拒绝进入 catch，尝试发错误并结束；观察器异常未隔离，可能打断处理，外层已结束也不能修改此前结果。
 * 例：const s=lazyStream(m,async()=>provider.stream(m,ctx)) 调用时就开始 setup；await s.result() 可能得到 stopReason=error，不能只看 Promise 完成。
 * setup 若在返回 Promise 前同步抛出，因调用本身不在 try 内会直接抛出；闭包使最终结果观察器最多调用一次。
 */
export function lazyStream(
	// 模型用于 setup 错误消息身份，不由这里选择实际请求供应商。
	model: Model<Api>,
	// 函数类型要求 setup 返回 Promise，不在类型层保证实现绝不同步抛错。
	setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
	// 观察器可省略，各钩子也可分别省略。
	observer?: LazyStreamObserver,
	// 方法本身不是 async，直接返回流对象。
): AssistantMessageEventStream {
	// 捕获请求开始毫秒，失败消息沿用它。
	const startedAt = Date.now();
	// 先建外层流，认证/加载还没完成时调用者就能拿到它。
	const outer = new AssistantMessageEventStream();
	// 防止正常/失败等多条路径重复报告最终结果。
	let observedResult = false;
	// 局部箭头闭包保留本次观察状态。
	const observeResult = (result: AssistantMessage | undefined): void => {
		// 已经通知则直接结束，不再次回调。
		if (observedResult) return;
		// 先标记已通知，防止观察器重入时再通知。
		observedResult = true;
		// 可选通知结果，异常并不在该闭包里吞掉。
		observer?.onResult?.(result);
	};

	// 立即调用工厂；lazy 是延迟实现装载到方法调用时，不是延迟到 for await 开始。
	setup()
		// setup 成功后把内部异步源转发到同一外层流。
		.then((inner) => forwardStream(outer, inner, observer, observeResult))
		// 这里捕获 setup Promise 和 forwardStream 链的拒绝。
		.catch((error) => {
			// 将异常包装成零内容的 assistant 错误消息。
			const message = createSetupErrorMessage(model, error, startedAt);
			// error 事件的 error 字段是完整消息，reason 固定 error。
			const event: AssistantMessageEvent = { type: "error", reason: "error", error: message };
			// 推入错误事件，让消费者能从协议读取失败。
			outer.push(event);
			// 观察器也看到该错误；若观察器再抛错，这条 catch 链没有额外隔离。
			observer?.onEvent?.(event);
			// 以失败消息结束外层，result() 得到的是消息而非自动抛原错误。
			outer.end(message);
			// 通过一次性闭包报告结果。
			observeResult(message);
		});

	// 同步交还外层流，不等待内部加载/请求完成。
	return outer;
}

/**
 * Wraps a dynamically imported API implementation module as `ProviderStreams`.
 * The module loads on first stream call; the host's import cache deduplicates
 * loads. Load failures terminate the returned stream with an error event.
 */
// 能力声明只决定包装对象是否暴露可选方法，真实加载后仍需确认实现存在。
export interface LazyApiCapabilities {
	// 是否安装获取延迟结果的流方法。
	fetchDeferred?: boolean;
	// 是否安装取消延迟任务的 Promise 方法。
	cancelDeferred?: boolean;
}

/**
 * 把异步加载工厂包装成 ProviderStreams，构造时不调用 load；各 stream 方法一调用就立即启动加载。
 * 默认只暴露 stream/streamSimple，按 capabilities 安装延迟结果获取/取消入口；返回可供 createProvider 使用的实现对象。
 * 例：lazyApi(load,{fetchDeferred:true}) 的获取失败变流 error，cancelDeferred 的加载/能力错误则拒绝 Promise；本包装器没有自己的模块缓存，是否复用由 load/宿主导入缓存决定。
 */
export function lazyApi(load: () => Promise<ProviderStreams>, capabilities?: LazyApiCapabilities): ProviderStreams {
	// 构造供应商聊天实现接口；箭头回调保存 load，但此时不运行。
	const api: ProviderStreams = {
		// 专属参数流式入口，每次调用才加载实现。
		stream: (model, context, options) =>
			// async 工厂等待 load 后取 stream；同步返回外层流，后续失败进 error 事件。
			lazyStream(model, async () => (await load()).stream(model, context, options)),
		// 统一参数流式入口，与 stream 相同加载时机。
		streamSimple: (model, context, options) =>
			// 把 model/context/options 原样转给载入的 streamSimple。
			lazyStream(model, async () => (await load()).streamSimple(model, context, options)),
	};

	// 只有显式声明支持获取延迟结果才安装入口。
	if (capabilities?.fetchDeferred) {
		// 可选函数属性在构造后的对象上补入。
		api.fetchDeferred = (model, handle, options) =>
			// 再次用 lazyStream 包住加载和能力检查，调用时立即开始。
			lazyStream(model, async () => {
				// 实际装载实现模块/对象。
				const implementation = await load();
				// 声明能力与真实实现不符时抛错，转成外层流错误。
				if (!implementation.fetchDeferred) throw new Error("API does not support deferred responses");
				// 有能力就转发模型、句柄和获取选项。
				return implementation.fetchDeferred(model, handle, options);
			});
	}
	// 只有显式声明支持取消才安装入口。
	if (capabilities?.cancelDeferred) {
		// 取消是 async Promise 入口，不通过事件流包装错误。
		api.cancelDeferred = async (model, handle, options) => {
			// 等待加载实际实现。
			const implementation = await load();
			// 缺取消方法则拒绝 Promise，不能伪装取消成功。
			if (!implementation.cancelDeferred) throw new Error("API cannot cancel deferred responses");
			// 等待实现取消操作结束，其 best-effort 效果仍取决于提供商。
			await implementation.cancelDeferred(model, handle, options);
		};
	}

	// 返回构造好的能力对象，本身不建立模型请求。
	return api;
}
