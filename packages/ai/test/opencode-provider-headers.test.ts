// 纯内存检查OpenCode聊天包装如何注入会话头、保留大小写不同的覆盖/null标记，以及缺少sessionId时不补头。
// 测试使用recordingStreams和已完成假流，不调用Zen/Go工厂、SDK或真实端点；5个展开用例只断言下层收到的headers，不证明HTTP最终编码/远端路由成功。
import { describe, expect, it } from "vitest";
// fauxAssistantMessage只造本地ok消息；默认身份仍是faux，不是把它当OpenCode服务返回的消息。
import { fauxAssistantMessage } from "../src/providers/faux.ts";
// 被测包装函数，实际注入发生在调用stream/streamSimple时，而不是创建包装时。
import { withOpenCodeSessionHeader } from "../src/providers/opencode-headers.ts";
// 四个type导入仅检查fixture及回调形状，不开启任何请求。
import type { Api, Model, ProviderStreams, StreamOptions } from "../src/types.ts";
// 真正事件流类，用来提供合法的同步流返回接口与最终结果Promise。
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
// 将旧Context形状规范为TranscriptContext，不执行压缩/模型调用。
import { normalizeContext } from "../src/utils/transcript.ts";

// 造一个满足Model<Api>的测试对象；api为自定义test-api，正好说明此测试不借真实API实现发送。
const model: Model<Api> = {
	// 模型ID固定test-model，不查目录存在性。
	id: "test-model",
	// 展示名字只作fixture字段。
	name: "Test model",
	// 自定义API名，不触发协议注册或SDK加载。
	api: "test-api",
	// provider字段模拟opencode身份，被测wrapper本身不据此判断要不要补头。
	provider: "opencode",
	// 真实样式URL仅存文字，两个recording回调均不fetch它。
	baseUrl: "https://opencode.ai/zen/v1",
	// 无推理能力，非本例断言目标。
	reasoning: false,
	// 输入模态为文字，不创建图片载荷。
	input: ["text"],
	// 四费率全零为占位，不运行价格计算。
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	// 上下文窗口占位1000，不在此测试token截断。
	contextWindow: 1000,
	// 输出限额占位100，不限制后面假流分词。
	maxTokens: 100,
};
// 无systemPrompt/tools时normalizeContext只包messages并复用消息数组；用户hi时间戳固定0，避免假装来自远端。
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

// 创建并立即完成一条假流，无参数、返回AssistantMessageEventStream；例最终正文ok，按start→done→end组织。只本机时钟/队列副作用，没有timer或网络，构造/推事件错误直接传播。
function completedStream(): AssistantMessageEventStream {
	// 每次创建独立事件流队列/最终结果Promise，并记录本地开始时间。
	const stream = new AssistantMessageEventStream();
	// 创建ok消息，默认usage等来自faux helper；不是按上面的model重写其身份。
	const message = fauxAssistantMessage("ok");
	// 先推start，partial指向同一message对象。
	stream.push({ type: "start", partial: message });
	// done使result兑现message，流可给此对象补durationMs；不要求消费者先开始迭代。
	stream.push({ type: "done", reason: "stop", message });
	// 结束流并唤醒迭代等待者，已兑现的结果不会被重复resolve改写。
	stream.end(message);
	// 返回已完成流，测试调用者忽略结果也不会留下等待网络的任务。
	return stream;
}

// 构造两种记录流方法，输入同步capture回调，返回ProviderStreams；例被调用时capture先看到options，再得到completedStream。
// 只保留capture闭包，不发送；回调抛错会阻止造流并直接传播，两方法各调用一次都新建假流。
function recordingStreams(capture: (options: StreamOptions | undefined) => void): ProviderStreams {
	// 返回新能力对象，不复用某个全局SDK客户端。
	return {
		// 原始流回调的模型/上下文下划线标未使用，只观察options。
		stream: (_model, _context, options) => {
			// 同步将实际收到的选项原引用交capture，不自动克隆或验证。
			capture(options);
			// 再创建已完成假流满足接口返回契约。
			return completedStream();
		},
		// 简化流回调接同样三个参数，不在这里转换reasoning等选项。
		streamSimple: (_model, _context, options) => {
			// 简化路径也先同步捕获选项。
			capture(options);
			// 为本次简化调用另建假流，不和原始方法共用一个流实例。
			return completedStream();
		},
	};
}

// 分组回调注册下面参数化用例，共5例；没有afterEach，因为这些例不改全局环境/注册表，捕获变量都在每例局部。
describe("OpenCode provider headers", () => {
	// Regression test for https://github.com/earendil-works/pi/issues/9326
	// 对原英语9326回归分别测stream/streamSimple两条入口，as const保留只读方法名字面量；it.each按两项展开两例。
	it.each(["stream", "streamSimple"] as const)(
		// %s由当前方法名填测试标题，不是业务请求的格式化参数。
		"maps sessionId for %s requests even without cache retention",
		// 测试回调接method，无业务返回；给会话+none缓存仍应补头，断言失败由Vitest报告。
		(method) => {
			// let允许capture稍后赋值；undefined表示还没收到下层选项，不是默认已捕获空对象。
			let captured: StreamOptions | undefined;
			// 被测wrapper包住下面的纯记录实现，构造此行不发送或消费事件。
			const streams = withOpenCodeSessionHeader(
				// 创建捕获闭包，options参数由recordingStreams的签名推导。
				recordingStreams((options) => {
					// 把下层收到的整个选项引用存外层变量，便于后面检查headers。
					captured = options;
				}),
			);

			// 动态方法索引只可能是两种已知入口；会话conversation-1且缓存none，强调路由头独立于缓存保留。
			streams[method](model, context, { sessionId: "conversation-1", cacheRetention: "none" });

			// 按数组展开的每例都要求精确头字典，未断言opts对象引用、返回内容或请求HTTP报文。
			expect(captured?.headers).toEqual({ "x-opencode-session": "conversation-1" });
		},
	);

	// 接下来按两份覆盖fixture展开两例，均只走streamSimple；不额外展开成四种方法组合。
	it.each([
		// 已有大写形式的会话头及字符串值，应原拼法/值保留而非注入标准小写重复键。
		{ headers: { "X-OpenCode-Session": "caller-value" }, expected: { "X-OpenCode-Session": "caller-value" } },
		// 已有同名null标记也应保留，不能因假值而被generated-value覆盖；null是否在HTTP层删除不由本例测试。
		{ headers: { "X-OpenCode-Session": null }, expected: { "X-OpenCode-Session": null } },
		// as const保留fixture字面量/只读视图，解构回调直接拿headers/expected，不在运行时冻结它们。
	] as const)("preserves a case-insensitive caller override", ({ headers, expected }) => {
		// 当前这一覆盖例自己的可缺捕获变量，与前一例隔离。
		let captured: StreamOptions | undefined;
		// 包一份新记录实现，避免共享上次捕获状态。
		const streams = withOpenCodeSessionHeader(
			// 收到下层选项时调用当前闭包。
			recordingStreams((options) => {
				// 保存选项引用；即便headers中值null也有正常options对象。
				captured = options;
			}),
		);

		// 虽给generated-value会话，已有大小写不同的同名头使wrapper直接保留原options，不注入另一份。
		streams.streamSimple(model, context, { sessionId: "generated-value", headers });

		// 头字典要与fixture expected内容一致；没有用Object.is断言原headers引用未变。
		expect(captured?.headers).toEqual(expected);
	});

	// 没有sessionId时只应透传自定义头；例{x-custom:value}不能凭provider/opencode字段补出会话ID。
	it("does not fabricate a session header when sessionId is absent", () => {
		// 重新声明本例局部捕获状态。
		let captured: StreamOptions | undefined;
		// 为此例创建会话头wrapper及纯记录实现。
		const streams = withOpenCodeSessionHeader(
			// 回调只接本次下层收到的选项。
			recordingStreams((options) => {
				// 记录它用于最终断言，不改原headers内容。
				captured = options;
			}),
		);

		// 调用简化流只给x-custom，没有sessionId，不生成随机会话或从模型身份推导。
		streams.streamSimple(model, context, { headers: { "x-custom": "value" } });

		// 精确要求仍只有自定义头，不测试sessionId为空串/空白或继承键等其它边缘。
		expect(captured?.headers).toEqual({ "x-custom": "value" });
	});
});
