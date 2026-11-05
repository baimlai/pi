// 可选的“客户端 → 自建代理 → 模型”请求适配器。Agent 仍消费统一模型事件；代理负责供应商认证，客户端重建被省略的累计草稿。
/**
 * Proxy stream function for apps that route LLM calls through a server.
 * The server manages auth and proxies requests to LLM providers.
 */

// 从 pi-ai 引入统一消息/流协议和工具参数解析器；同一 import 中带 type 的名字只用于类型检查。
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type ToolCall,
	ToolCallArgumentsStream,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

/**
 * Proxy event types - server sends these with partial field stripped to reduce bandwidth.
 */
// 代理在线路上传输的“事件联合类型”：type 标签决定本事件有哪些字段；它省略客户端可自行重建的 partial。
export type ProxyAssistantMessageEvent =
	// 消息开始，只需一个类型标签；客户端已有模型信息，可以自行建立空草稿。
	| { type: "start" }
	// 建立文字块；contentIndex 是内容数组下标，例如 0 表示第一块。
	| { type: "text_start"; contentIndex: number }
	// 文字增量：告诉客户端往哪个块追加哪些字符，例如 delta 为“你好”。
	| { type: "text_delta"; contentIndex: number; delta: string }
	// 文字块结束；? 表示签名可缺省，存在时用于保留供应商的内容签名。
	| { type: "text_end"; contentIndex: number; contentSignature?: string }
	// 建立思考块；与文字块分开，后续增量写入 thinking 字段。
	| { type: "thinking_start"; contentIndex: number }
	// 只传本次新增思考文字，客户端自行积累此前内容。
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	// 思考块结束，可附供应商签名；不表示整个请求已经结束。
	| { type: "thinking_end"; contentIndex: number; contentSignature?: string }
	// 开始工具调用块，需要调用 id 和工具名；参数稍后分片到达。
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	// 工具参数的 JSON 片段，例如先到 {"path":，下一片才到 "a.txt"}。
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	// 完整工具块到达，用最终 ToolCall 覆盖逐片推测的结果。
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
	| {
			// 正常终止事件；其 reason 解释模型是自行停止、达到长度限制，还是要执行工具。
			type: "done";
			// Extract 是 TS 工具类型：从 StopReason 联合中只挑正常结束的三种值。
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			// 索引访问类型：复用 AssistantMessage 的 usage 字段类型，避免维护两份 token/费用结构。
			usage: AssistantMessage["usage"];
			// 可选的供应商实际思考级别，可能与应用请求的统一级别不同。
			providerThinkingLevel?: string;
	  }
	| {
			// 失败终止事件；错误同样通过事件流传回，不要求调用方只靠 catch 获取。
			type: "error";
			// 这个分支只允许用户取消或错误，不能误写成 toolUse。
			reason: Extract<StopReason, "aborted" | "error">;
			// 可选可读错误原因；它不是可执行代码或重新抛出的 Error 对象。
			errorMessage?: string;
			// 索引访问类型：复用 AssistantMessage 的 usage 字段类型，避免维护两份 token/费用结构。
			usage: AssistantMessage["usage"];
			// 可选的供应商实际思考级别，可能与应用请求的统一级别不同。
			providerThinkingLevel?: string;
	  };

// Pick<T, K> 从请求选项中选出可以放进 JSON 的字段；取消信号和回调在客户端使用。
type ProxySerializableStreamOptions = Pick<
	// 第一项是原始类型，下面的字符串联合列出要保留的字段名。
	SimpleStreamOptions,
	// 温度选项：影响供应商支持的生成采样；代理负责转交。
	| "temperature"
	// 供应商支持的其他采样设置，不在本文件解释或执行采样算法。
	| "samplingParams"
	// 本次允许的输出 token 上限，区别于上下文窗口总大小。
	| "maxTokens"
	// 应用请求的思考级别。
	| "reasoning"
	// 缓存保留偏好；实际支持和计费由供应商实现决定。
	| "cacheRetention"
	// 会话标识，可供供应商做缓存或会话相关处理；历史仍通过 context 明确发送。
	| "sessionId"
	// 传给模型请求的额外请求头；代理服务器的 Authorization 则单独使用 authToken。
	| "headers"
	// 请求附带的元数据。
	| "metadata"
	// 供应商传输偏好，当前客户端到代理仍由下面的 fetch 请求完成。
	| "transport"
	// 思考 token 预算设置，具体映射由模型供应商处理。
	| "thinkingBudgets"
	// 允许供应商重试等待的上限，不会在本文件自己实现重试循环。
	| "maxRetryDelayMs"
>;

// 接口继承已筛选的可序列化选项，再补本地 signal 和代理地址/认证。extends 在此是类型扩展。
export interface ProxyStreamOptions extends ProxySerializableStreamOptions {
	/** Local abort signal for the proxy request */
	// 用户取消时由该信号终止本地代理请求；这个对象不会被塞进发送给服务器的 options JSON。
	signal?: AbortSignal;
	/** Auth token for the proxy server */
	// 登录自建代理服务器用的令牌；不是由客户端直接管理的模型供应商 API Key。
	authToken: string;
	/** Proxy server URL (e.g., "https://genai.example.com") */
	// 代理服务器基地址，例如示意地址 https://example.test；下面会拼上 /api/stream。
	proxyUrl: string;
}

/**
 * Stream function that proxies through a server instead of calling LLM providers directly.
 * The server strips the partial field from delta events to reduce bandwidth.
 * We reconstruct the partial message client-side.
 *
 * Use this as the `streamFn` option when creating an Agent that needs to go through a proxy.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 * ```
 */
/**
 * 从代理配置里取出允许序列化的生成选项，返回一个普通对象，不访问网络、不修改传入对象。
 * 流程：逐字段挑选 → fetch 的请求体再 JSON.stringify。例：authToken 留作外层请求认证，不进入 options 子对象。
 */
function buildProxyRequestOptions(options: ProxyStreamOptions): ProxySerializableStreamOptions {
	// 组装一个新对象；这里只复制明确列出的可序列化字段，不会发送整个 options。
	return {
		// 复制温度；未提供时值为 undefined，JSON.stringify 会省略该对象字段。
		temperature: options.temperature,
		// 透传其他采样参数，仍由服务器/供应商解释。
		samplingParams: options.samplingParams,
		// 传递输出预算，不在客户端用字符数强行截断模型结果。
		maxTokens: options.maxTokens,
		// 传递统一思考级别。
		reasoning: options.reasoning,
		// 传递缓存偏好，不承诺本次一定命中缓存。
		cacheRetention: options.cacheRetention,
		// 保留会话标识。
		sessionId: options.sessionId,
		// 这些是业务请求选项中的 headers，与 fetch 访问代理的外层 headers 是两层配置。
		headers: options.headers,
		// 带上调用方提供的元数据。
		metadata: options.metadata,
		// 把最终模型传输偏好交给代理处理。
		transport: options.transport,
		// 把思考预算交给代理后的模型适配器。
		thinkingBudgets: options.thinkingBudgets,
		// 透传重试等待上限，本函数本身不等待。
		maxRetryDelayMs: options.maxRetryDelayMs,
	};
}

/**
 * 经自建代理向模型请求，立即返回事件流；网络在内部 async 任务中执行，逐行 SSE 重建完整草稿。
 * 输入是模型、规范化历史、代理 URL/令牌与生成选项；副作用是 POST 网络请求、发布流事件、更新内部草稿。
 * 流程：建空草稿 → 发 POST → 解码并逐行处理 → done/error 完成；网络/JSON 错误也变成 error 事件。
 * 例：把 streamFn 设成调用 streamProxy 的函数，代理发 text_delta("你好") 后，本地消费者会看到累计文字“你好”。
 * 若认证需 await，先在 async 初始化代码取到令牌，再由回调闭包使用；或者把 streamFn 本身声明为 async，不能在普通箭头函数体里直接 await。
 */
export function streamProxy(
	// 待请求的模型元数据；这里现有的 any 允许任意已支持 API 的模型，运行时仍靠代理协议工作。
	model: Model<any>,
	// 已经规范化的模型消息历史，system 提示词和工具声明放在消息中。
	context: TranscriptContext,
	// 代理地址、代理认证及本次生成选项；不同于 Agent 的整个配置对象。
	options: ProxyStreamOptions,
	// 同步返回可异步迭代的事件流；完整回复通过 stream.result() 的 Promise 获取。
): AssistantMessageEventStream {
	// 创建给 Agent 消费的队列；下面后台任务不断 push 事件，当前函数可以立即把队列返回。
	const stream = createAssistantMessageEventStream();

	// 立即调用 async 箭头函数，在后台等待网络；函数返回 Promise，但这里不把该 Promise 当作事件流返回。
	(async () => {
		// Initialize the partial message that we'll build up from events
		// 客户端维护同一条累计草稿；服务器省略 partial 时，就在这份对象上重建它。
		const partial: AssistantMessage = {
			// 代理收到的是模型输出，因此消息角色是 assistant，不是代理服务器充当 user。
			role: "assistant",
			// 尚未收到 done/error 前处于 pending；不能提前宣布生成成功。
			stopReason: "pending",
			// 文字、思考和工具块会按 contentIndex 填进这个数组。
			content: [],
			// 记录模型协议，例如某种 OpenAI 或 Anthropic API 形状。
			api: model.api,
			// 记录提供商标识。
			provider: model.provider,
			// 记录具体模型 id，不把整个模型目录对象存入回复。
			model: model.id,
			// 先初始化用量为零；终止事件到达后由服务器报告的实际用量替换。
			usage: {
				// 输入 token 暂未获知，先记零，不表示这次请求无需输入。
				input: 0,
				// 输出 token 暂未获知。
				output: 0,
				// 缓存读取用量尚未上报。
				cacheRead: 0,
				// 缓存写入用量尚未上报。
				cacheWrite: 0,
				// 总用量先置零；代理不会通过字节长度猜测最终计费。
				totalTokens: 0,
				// 各项费用的初始占位值；最终由服务器 usage 覆盖。
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			// 记录开始建立回复的毫秒时间戳。
			timestamp: Date.now(),
		};

		// 稍后取得响应体的字节读取器；泛型 Uint8Array 表示每块都是原始字节。
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

		// 定义收到取消信号后的处理函数；等事件发生时才调用它。
		const abortHandler = () => {
			// 响应体读取器已经建立时，取消后续读取。尚未建立时由 fetch 的 signal 负责取消。
			if (reader) {
				// 取消读取；取消操作自身失败时忽略，因为用户取消仍会由外层状态检查报告。
				reader.cancel("Request aborted by user").catch(() => {});
			}
		};

		// 调用方提供了取消信号时，才注册/移除监听。
		if (options.signal) {
			// 注册取消回调；后面的 finally 无论成功失败都会移除它。
			options.signal.addEventListener("abort", abortHandler);
		}

		// 把网络、JSON 解析和协议处理放进统一错误路径，失败会生成 error 事件。
		try {
			// 真正访问自建代理的 /api/stream。await 等响应头，不会等完整生成结果。
			const response = await fetch(`${options.proxyUrl}/api/stream`, {
				// 使用 POST，把模型、历史和选项放在请求体里。
				method: "POST",
				// 这里是客户端访问代理时使用的 HTTP 头。
				headers: {
					// 模板字符串拼成 Bearer 认证头；服务器验证的是代理访问身份。
					Authorization: `Bearer ${options.authToken}`,
					// 告诉代理请求体是 JSON 文本。
					"Content-Type": "application/json",
				},
				// 把普通对象序列化为 JSON；函数和 AbortSignal 不属于这里要传的业务字段。
				body: JSON.stringify({
					// 对象简写：model: model，发送模型选择和元数据。
					model,
					// 发送当前完整上下文，代理不必靠客户端进程内存猜历史。
					context,
					// 只发送筛选后的生成参数，避免泄漏客户端回调、signal 和外层代理认证字段。
					options: buildProxyRequestOptions(options),
				}),
				// fetch 本身也接入取消，可中止建立连接或读取响应体。
				signal: options.signal,
			});

			// HTTP 非成功状态先按代理错误处理；response.ok 对应 200～299。
			if (!response.ok) {
				// 先准备保底错误文字，代理没有返回可读 JSON 时仍有 HTTP 状态可查。
				let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
				// 尝试提取错误响应 JSON 的具体说明；解析失败时内层 catch 仅保留 HTTP 状态文字。
				try {
					// 尝试解 JSON 并作类型断言。as 不会在运行时验证服务器字段形状，这是当前实现的信任边界。
					const errorData = (await response.json()) as { error?: string };
					// 代理给出了 error 字段就优先使用更具体的说明。
					if (errorData.error) {
						// 用服务器错误说明替换只有状态码的保底文字。
						errorMessage = `Proxy error: ${errorData.error}`;
					}
					// 错误响应未必是 JSON；解析失败时保留之前准备的 HTTP 错误说明。
				} catch {
					// Couldn't parse error response
				}
				// 把代理 HTTP 错误交给下方总 catch，最终仍经统一 error 流事件发出。
				throw new Error(errorMessage);
			}

			// ! 是非空断言，运行时不会生成检查；从成功响应体获取读取器，若实际无 body 会进入 catch。
			reader = response.body!.getReader();
			// 按 UTF-8 把字节流解码成文字，能正确处理中文字符跨网络分片的情况。
			const decoder = new TextDecoder();
			// 缓存尚未组成完整行的尾巴；一次 read 不保证恰好是一条 SSE 事件。
			let buffer = "";
			// 记录是否收到协议的 done/error；仅有网络 EOF 不能当成模型正常结束。
			let sawTerminalEvent = false;
			// Argument streams of open tool calls by content index, kept off the content blocks.
			// 按内容块下标保存每个工具调用的流式 JSON 解析器，不把解析状态写进模型内容。
			const toolArguments = new Map<number, ToolCallArgumentsStream>();

			// 内部辅助回调：处理一行代理 SSE 数据，会更新草稿和输出事件队列。
			const processLine = (line: string): void => {
				// 当前代理协议只处理 data: 空格开头的数据行，其他 SSE 字段/空行直接忽略。
				if (!line.startsWith("data: ")) return;
				// 去掉 data: 前缀及两端空白，得到 JSON 事件文字。
				const data = line.slice(6).trim();
				// 空数据不解析，避免 JSON.parse 对空串抛错。
				if (!data) return;
				// 读取线路 JSON 并声明预期事件类型；这不是 schema 校验，坏 JSON 会由外层 catch 报为流错误。
				const proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;
				// 按 type 更新累计草稿，把精简代理事件补成统一 AssistantMessageEvent。
				const event = processProxyEvent(proxyEvent, partial, toolArguments);
				// 某些不匹配的工具结束事件可能不产出统一事件，只有有返回值时才 push。
				if (event) {
					// 见过终止事件就记录，之后网络正常关闭不再误报“中途断开”。
					if (event.type === "done" || event.type === "error") sawTerminalEvent = true;
					// 把重建的统一事件交给本地消费者，如 Agent 的 for await 循环。
					stream.push(event);
				}
			};

			// 持续读取网络字节直到 done，或发生取消/解析错误。
			while (true) {
				// 解构读取结果：done 表示响应体结束，value 是这次收到的字节。
				const { done, value } = await reader.read();
				// 字节读完退出 while；后面还需检查取消和协议终止事件。
				if (done) break;

				// 异步等待期间可能被取消，拿到下一块数据后再确认，不继续发布成功内容。
				if (options.signal?.aborted) {
					// 将用户取消送入统一错误通道，catch 会把 stopReason 设置成 aborted。
					throw new Error("Request aborted by user");
				}

				// 流模式保留半个 UTF-8 字符的解码状态，将本次文字加到缓冲尾部。
				buffer += decoder.decode(value, { stream: true });
				// 按换行拆成候选事件行；最后一段可能尚未结束，下一行会把它留回 buffer。
				const lines = buffer.split("\n");
				// 最后一段可能没有换行，留下等下一批；pop 会从数组移除它。
				buffer = lines.pop() || "";

				// 按到达顺序处理所有完整行，保证文字和工具参数片段顺序不乱。
				for (const line of lines) {
					// 解析这一行并转发统一事件；不是再发一次模型请求。
					processLine(line);
				}
			}

			// 异步等待期间可能被取消，拿到下一块数据后再确认，不继续发布成功内容。
			if (options.signal?.aborted) {
				// 将用户取消送入统一错误通道，catch 会把 stopReason 设置成 aborted。
				throw new Error("Request aborted by user");
			}

			// The final event may not be newline-terminated; flush the decoder and
			// process whatever is left in the buffer.
			// 不传输入会冲洗解码器，取出尚未输出的剩余字符。
			buffer += decoder.decode();
			// 最后一个事件可能没有结尾换行，不能因为 split 没形成完整行就漏掉。
			if (buffer) {
				// 处理最后残留的协议数据。
				processLine(buffer);
			}

			// 网络已结束却没有 done/error，说明回复可能被代理中断，需要显式失败。
			if (!sawTerminalEvent) {
				// A clean EOF without a done/error event means the server dropped the
				// response mid-stream. Surface it as an error instead of leaving
				// consumers waiting on a result that never arrives.
				// 把累计草稿标为失败；已生成的文字仍留在 content 中便于显示。
				partial.stopReason = "error";
				// 说明连接在模型协议完成前关闭，而不是让 result() 永远等待。
				partial.errorMessage = "Connection closed by proxy server before the response completed";
				// 发布统一终止错误事件，由队列据此完成最终结果。
				stream.push({
					// 错误事件标签，消费者可据此停止正常生成并显示原因。
					type: "error",
					// 这里是连接/协议失败，不是用户主动取消。
					reason: "error",
					// 错误事件携带当前整条草稿，包含截至失败时已经生成的内容和错误原因。
					error: partial,
				});
			}

			// 关闭队列，不再等待后续网络事件；已经入队的内容仍可被消费者读完。
			stream.end();
			// 所有连接、响应解析、数据顺序异常都汇入这里，转换成协议化的错误消息。
		} catch (error) {
			// catch 的值可能不是 Error；在异常边界统一转成可读文字。
			const errorMessage = error instanceof Error ? error.message : String(error);
			// 如果用户的 signal 已取消就标 aborted，其余按 error；三元表达式一次选一个值。
			const reason = options.signal?.aborted ? "aborted" : "error";
			// 让最终 AssistantMessage 与即将发出的 error 事件原因一致。
			partial.stopReason = reason;
			// 保存异常说明，供 UI、历史和日志读取。
			partial.errorMessage = errorMessage;
			// 发布统一终止错误事件，由队列据此完成最终结果。
			stream.push({
				// 错误事件标签，消费者可据此停止正常生成并显示原因。
				type: "error",
				// 对象字段简写，沿用刚判断的 aborted/error。
				reason,
				// 错误事件携带当前整条草稿，包含截至失败时已经生成的内容和错误原因。
				error: partial,
			});
			// 关闭队列，不再等待后续网络事件；已经入队的内容仍可被消费者读完。
			stream.end();
			// 无论正常结束、失败还是取消，都会运行监听器清理。
		} finally {
			// 调用方提供了取消信号时，才注册/移除监听。
			if (options.signal) {
				// 移除本次注册的监听，避免结束后仍引用 reader/草稿等资源。
				options.signal.removeEventListener("abort", abortHandler);
			}
		}
		// 末尾括号立即调用上面的 async 函数；异步工作继续，外层接着返回 stream。
	})();

	// 立即返回事件流对象，调用方能在请求尚未结束时逐片消费它。
	return stream;
}

/**
 * Process a proxy event and update the partial message.
 */
/**
 * 把一条精简代理事件补成 pi-ai 统一事件，原地更新 partial 及工具参数 Map；不请求模型、不执行工具。
 * 流程按 type 分支：start 建块、delta 追加、end 收尾、done/error 写统计；某些工具结束事件不匹配时返回 undefined。
 * 例：已有 text:"你" 时收到 text_delta("好")，返回增量事件，同时草稿文字变成“你好”。
 */
function processProxyEvent(
	// 代理的一条精简事件；后面的 switch 会按 type 收窄联合类型。
	proxyEvent: ProxyAssistantMessageEvent,
	// 传入的累计草稿会被原地更新，这是本函数主要副作用。
	partial: AssistantMessage,
	// 还未完成工具调用的参数解析状态，键为内容数组下标。
	toolArguments: Map<number, ToolCallArgumentsStream>,
	// 返回补全 partial 的统一事件；某些无法匹配的 toolcall_end 返回 undefined。
): AssistantMessageEvent | undefined {
	// 按事件标签分派；TS 在每个 case 内知道该事件允许访问哪些字段。
	switch (proxyEvent.type) {
		// 模型消息开始，草稿已经由 streamProxy 建好。
		case "start":
			// 把原协议只有 type 的事件补成含完整草稿的开始事件。
			return { type: "start", partial };

		// 创建这个下标的文字内容块。
		case "text_start":
			// 用空字符串初始化；随后 text_delta 才逐片追加正文。
			partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
			// 告知消费者哪个文字块开始，并附当前草稿。
			return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };

		// 花括号让此 case 有独立作用域，可与其他 case 复用变量名 content。
		case "text_delta": {
			// 取这条事件指定的内容块，而不是总往最后一块写，支持不同种类的块。
			const content = partial.content[proxyEvent.contentIndex];
			// 核对来自网络的事件顺序/块种类，避免把文字片段写进工具或思考块。
			if (content?.type === "text") {
				// 把新增文字追加到累计正文，例如“你”再加“好”变成“你好”。
				content.text += proxyEvent.delta;
				// 返回补全后的统一块事件，同时带内容下标和累计草稿，供 Agent/UI 消费。
				return {
					// 统一事件仍标文字增量，不改成完整消息结束。
					type: "text_delta",
					// 保留原内容下标，消费者可以定位当前块。
					contentIndex: proxyEvent.contentIndex,
					// 既提供新增片段，也在 partial 中提供累计内容，两种消费方式都可用。
					delta: proxyEvent.delta,
					// 附同一份累计草稿引用；本函数不会为每个普通文字片段深拷贝整条消息。
					partial,
				};
			}
			// 服务器先发增量却没建立正确文字块时，拒绝无声丢失内容，外层转成 error。
			throw new Error("Received text_delta for non-text content");
		}

		// 当前文字块结束，可能带内容签名。
		case "text_end": {
			// 取这条事件指定的内容块，而不是总往最后一块写，支持不同种类的块。
			const content = partial.content[proxyEvent.contentIndex];
			// 核对来自网络的事件顺序/块种类，避免把文字片段写进工具或思考块。
			if (content?.type === "text") {
				// 保存供应商签名；这个字段不是用户可见正文。
				content.textSignature = proxyEvent.contentSignature;
				// 返回补全后的统一块事件，同时带内容下标和累计草稿，供 Agent/UI 消费。
				return {
					// 转发文字块结束事件，不等于整条 assistant 消息结束。
					type: "text_end",
					// 保留原内容下标，消费者可以定位当前块。
					contentIndex: proxyEvent.contentIndex,
					// 结束事件附完整文字，避免消费者还要去逐片拼接才能读取最终块。
					content: content.text,
					// 附同一份累计草稿引用；本函数不会为每个普通文字片段深拷贝整条消息。
					partial,
				};
			}
			// 块种类不对表示代理数据顺序/内容不一致，作为错误报告。
			throw new Error("Received text_end for non-text content");
		}

		// 思考块的生命周期与普通文字独立。
		case "thinking_start":
			// 建立空思考内容，后续增量写进 thinking 而不是 text。
			partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
			// 附上草稿并发出统一思考开始事件。
			return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };

		// 接收一段新增思考文字。
		case "thinking_delta": {
			// 取这条事件指定的内容块，而不是总往最后一块写，支持不同种类的块。
			const content = partial.content[proxyEvent.contentIndex];
			// 确认服务器事件对应已存在的思考块；这是网络协议状态检查。
			if (content?.type === "thinking") {
				// 累积思考文字，与普通正文保持不同内容块。
				content.thinking += proxyEvent.delta;
				// 返回补全后的统一块事件，同时带内容下标和累计草稿，供 Agent/UI 消费。
				return {
					// 让消费者把它当思考增量渲染或记录。
					type: "thinking_delta",
					// 保留原内容下标，消费者可以定位当前块。
					contentIndex: proxyEvent.contentIndex,
					// 既提供新增片段，也在 partial 中提供累计内容，两种消费方式都可用。
					delta: proxyEvent.delta,
					// 附同一份累计草稿引用；本函数不会为每个普通文字片段深拷贝整条消息。
					partial,
				};
			}
			// 不把类型/顺序错误默默吞掉；外层统一转成失败回复。
			throw new Error("Received thinking_delta for non-thinking content");
		}

		// 思考块结束，可以保存供应商签名。
		case "thinking_end": {
			// 取这条事件指定的内容块，而不是总往最后一块写，支持不同种类的块。
			const content = partial.content[proxyEvent.contentIndex];
			// 确认服务器事件对应已存在的思考块；这是网络协议状态检查。
			if (content?.type === "thinking") {
				// 保留思考签名，以便后续请求或回放需要时带上。
				content.thinkingSignature = proxyEvent.contentSignature;
				// 返回补全后的统一块事件，同时带内容下标和累计草稿，供 Agent/UI 消费。
				return {
					// 只结束当前思考块，后面仍可能有文字或工具调用。
					type: "thinking_end",
					// 保留原内容下标，消费者可以定位当前块。
					contentIndex: proxyEvent.contentIndex,
					// 给结束事件提供累计完整思考内容。
					content: content.thinking,
					// 附同一份累计草稿引用；本函数不会为每个普通文字片段深拷贝整条消息。
					partial,
				};
			}
			// 收到与当前块类型不匹配的结束事件就失败，不伪装成完整成功。
			throw new Error("Received thinking_end for non-thinking content");
		}

		// 模型开始声明一个工具请求；这里仅重建调用，不执行本地工具。
		case "toolcall_start":
			// 按协议给定位置建立工具调用块。
			partial.content[proxyEvent.contentIndex] = {
				// 统一内容协议用驼峰 toolCall；事件名则使用 toolcall_start。
				type: "toolCall",
				// 工具调用唯一标识，后续 toolResult 必须用这个 id 与请求配对。
				id: proxyEvent.id,
				// 工具名，例如 read；Agent 后续按名字找可执行实现。
				name: proxyEvent.toolName,
				// 先用空参数对象占位，流式 JSON 到达时再逐步解析。
				arguments: {},
			};
			// 为这个工具下标创建独立解析器，多个工具参数片段不会串在一起。
			toolArguments.set(proxyEvent.contentIndex, new ToolCallArgumentsStream());
			// 发布工具调用开始事件，仍不执行工具。
			return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };

		// 接收工具参数的下一段 JSON 文本。
		case "toolcall_delta": {
			// 取这条事件指定的内容块，而不是总往最后一块写，支持不同种类的块。
			const content = partial.content[proxyEvent.contentIndex];
			// 找到该块对应的参数解析器；没有则是协议状态缺失。
			const args = toolArguments.get(proxyEvent.contentIndex);
			// 同时确认工具块和解析器存在，才能把参数增量附加到正确位置。
			if (content?.type === "toolCall" && args !== undefined) {
				// A new block object, so reactive consumers see the change.
				// append 接受未完整 JSON，返回当前可解析参数；新建块对象让按引用比较的 UI 能发现变化。
				partial.content[proxyEvent.contentIndex] = { ...content, arguments: args.append(proxyEvent.delta) };
				// 返回补全后的统一块事件，同时带内容下标和累计草稿，供 Agent/UI 消费。
				return {
					// 把这一片参数变化作为工具增量事件发布。
					type: "toolcall_delta",
					// 保留原内容下标，消费者可以定位当前块。
					contentIndex: proxyEvent.contentIndex,
					// 既提供新增片段，也在 partial 中提供累计内容，两种消费方式都可用。
					delta: proxyEvent.delta,
					// 附同一份累计草稿引用；本函数不会为每个普通文字片段深拷贝整条消息。
					partial,
				};
			}
			// 工具增量没有匹配的 start/解析器时作为协议错误处理。
			throw new Error("Received toolcall_delta for non-toolCall content");
		}

		// 工具声明最终完成，服务器会给完整 ToolCall。
		case "toolcall_end": {
			// 取这条事件指定的内容块，而不是总往最后一块写，支持不同种类的块。
			const content = partial.content[proxyEvent.contentIndex];
			// 只接受与现有工具内容块匹配的结束事件。
			if (content?.type === "toolCall") {
				// 将最终 id/name/arguments 等字段覆盖到块对象；这是浅层字段赋值。
				Object.assign(content, proxyEvent.toolCall);
				// 解析结束，释放这次工具参数的累积状态。
				toolArguments.delete(proxyEvent.contentIndex);
				// 返回补全后的统一块事件，同时带内容下标和累计草稿，供 Agent/UI 消费。
				return {
					// 告知上层工具调用声明完整，真正执行仍由 Agent 循环随后决定。
					type: "toolcall_end",
					// 保留原内容下标，消费者可以定位当前块。
					contentIndex: proxyEvent.contentIndex,
					// 结束事件带上已合并的完整工具调用。
					toolCall: content,
					// 附同一份累计草稿引用；本函数不会为每个普通文字片段深拷贝整条消息。
					partial,
				};
			}
			// 没有可匹配块的这个分支不发事件；default 的未知事件也以没有统一事件结束。
			return undefined;
		}

		// 整条模型回复正常结束，接收停止原因和服务器统计。
		case "done":
			// 用终止原因替换开始时的 pending；可以是 stop、length、toolUse 或错误分支的原因。
			partial.stopReason = proxyEvent.reason;
			// 最终采用服务器的 token/费用统计，不用客户端字符数猜。
			partial.usage = proxyEvent.usage;
			// 只有服务器确实给了实际思考级别才写入，避免凭空填默认级别。
			if (proxyEvent.providerThinkingLevel !== undefined) {
				// 记录供应商实际使用的思考级别。
				partial.providerThinkingLevel = proxyEvent.providerThinkingLevel;
			}
			// 用统一 done 事件交付最终消息，消费者的 result() 能据此拿到完整回复。
			return { type: "done", reason: proxyEvent.reason, message: partial };

		// 服务器明确报告生成失败/取消，同样可能保留此前生成的部分内容。
		case "error":
			// 用终止原因替换开始时的 pending；可以是 stop、length、toolUse 或错误分支的原因。
			partial.stopReason = proxyEvent.reason;
			// 把服务器原因写进最终失败消息。
			partial.errorMessage = proxyEvent.errorMessage;
			// 最终采用服务器的 token/费用统计，不用客户端字符数猜。
			partial.usage = proxyEvent.usage;
			// 只有服务器确实给了实际思考级别才写入，避免凭空填默认级别。
			if (proxyEvent.providerThinkingLevel !== undefined) {
				// 记录供应商实际使用的思考级别。
				partial.providerThinkingLevel = proxyEvent.providerThinkingLevel;
			}
			// 统一错误事件把最终失败消息放在 error 字段，字段名与 done 的 message 不同。
			return { type: "error", reason: proxyEvent.reason, error: partial };

		// 兜底未知事件类型；下面的 never 同时提醒开发者是否漏处理了新增类型。
		default: {
			// 穷尽检查：所有已声明 type 都应在上面处理；若增加类型而没增加 case，TS 会报错。
			const _exhaustiveCheck: never = proxyEvent;
			// 网络仍可能发来类型声明之外的数据；这个现有兜底仅警告，不等于完整的协议 schema 校验。
			console.warn(`Unhandled proxy event type: ${(proxyEvent as any).type}`);
			// 没有可匹配块的这个分支不发事件；default 的未知事件也以没有统一事件结束。
			return undefined;
		}
	}
}
