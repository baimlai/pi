// 验证旧全局complete在自定义API覆盖下把显式key交给注册实现；回复由内存事件流直接造出，不调用模型服务。
// 文件名含env，但唯一用例传的是options.apiKey，不测试环境变量注入或完整认证；全局注册表改动由afterEach重置。
import { afterEach, describe, expect, it } from "vitest";
// 导入compat会装配内置Models并注册默认聊天/图片包装；实际用例替换聊天API，后面不会调用SDK流或登录方法。
import { complete, registerApiProvider, resetApiProviders } from "../src/compat.ts";
// import type只检查消息/上下文/模型结构，运行时不产生这些类型变量。
import type { AssistantMessage, Context, Model } from "../src/types.ts";
// 事件流是真正的运行类，用来同步push事件并让complete等待result；不等于开HTTP连接。
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

// 给一条用户hi消息；类型注解要求Context结构，Date.now是模块加载时本机时间，不是发送请求的证据。
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

// 构造手写测试模型，泛型把api限为openai-responses，其他字段仍是普通对象；下面的URL不被本例fetch。
const model: Model<"openai-responses"> = {
	// 测试模型ID，不要求它存在于内置目录。
	id: "test-model",
	// 展示名，仅fixture元数据。
	name: "Test Model",
	// 协议名用于找旧API注册表，并由包装器检查模型API一致性。
	api: "openai-responses",
	// 自定义provider名与内置供应商分开；本例同时覆盖API对象引用，因此会走旧注册表fallback。
	provider: "custom-openai",
	// 固定示例端点，只存字符串，不创建网络客户端。
	baseUrl: "https://example.test/v1",
	// 不声明推理能力，非本例的断言目标。
	reasoning: false,
	// 接受文字输入的静态能力声明，不在此编码图片。
	input: ["text"],
	// 四项目录单价都为零，不表示从远端取到免费额度。
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	// 声明上下文容量，测试不会真的塞入128000 token或检查溢出。
	contextWindow: 128000,
	// 声明最大输出，内存回复仅两个字母，不验证服务端限额。
	maxTokens: 4096,
};

// 创建完整假assistant消息，无输入、返回新对象；例content是ok，身份复用model，usage全零、结束为stop。只读本机时钟，不发请求；流可能随后在同一对象补durationMs。
function message(): AssistantMessage {
	// 返回独立消息容器，嵌套content/usage也在本次调用新建。
	return {
		// 角色固定assistant，与前面的用户消息区分。
		role: "assistant",
		// 正文含一段text=ok，不含工具调用。
		content: [{ type: "text", text: "ok" }],
		// 沿用模型API，不硬编码另一个协议。
		api: model.api,
		// 沿用自定义provider字符串，便于消息身份一致。
		provider: model.provider,
		// 消息model字段存ID字符串，不存整个模型对象。
		model: model.id,
		// 用量对象补齐消息协议字段，没有实际模型计费读取。
		usage: {
			// 输入token占位零。
			input: 0,
			// 输出token占位零。
			output: 0,
			// 缓存读token占位零。
			cacheRead: 0,
			// 缓存写token占位零。
			cacheWrite: 0,
			// 总token占位零，没有从hi/ok做分词计算。
			totalTokens: 0,
			// 消息费用对象另含total；这是fixture数据，不测试价格公式。
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		// 结束原因为正常stop；本例不测试工具调用，complete本身也不负责执行工具或续轮。
		stopReason: "stop",
		// 函数调用时取时间戳，流的计时逻辑还会检查消息是否早于流创建。
		timestamp: Date.now(),
	};
}

// 此describe注册唯一fallback用例及清理钩子，不在分组时就调用complete。
describe("compat legacy API fallback", () => {
	// 每例后重装默认聊天API，无参数/业务返回；断言失败也会由Vitest运行它。它不清图片注册表或重建compatModels。
	afterEach(() => {
		// 清空当前聊天覆盖并注册默认包装，不运行这些包装器的模型请求。
		resetApiProviders();
	});

	// 安装一个本地API实现，再await complete并断言收到request-key；测试回调返回Promise<void>，流/断言错误会令用例失败。
	// 这里验证原始stream路径的显式key传递，虽然提供streamSimple实现满足接口，但本例未调用它，也未断言最终回复正文或事件消费顺序。
	it("dispatches unknown providers through the legacy API registry", async () => {
		// let先声明可缺字符串，闭包收到选项时再赋值；| undefined表示尚未捕获，不用any。
		let capturedApiKey: string | undefined;
		// 按api覆盖全局聊天注册项，保存两种流函数引用，不在注册这行调用流。
		registerApiProvider({
			// 覆盖openai-responses协议，不是新增同名Provider或更新模型目录。
			api: "openai-responses",
			// 原始流回调接模型/规范上下文/可选选项，前两项下划线标记未使用；返回同步事件流对象。
			stream: (_model, _context, options) => {
				// 可选链取options.apiKey存外层变量，若没options则undefined；捕获的是实参，不是读process.env。
				capturedApiKey = options?.apiKey;
				// 创建独立流，准备最终结果Promise与事件队列，同时开始本地耗时记录。
				const stream = new AssistantMessageEventStream();
				// 创建ok回复；这个调用不会访问供应商端点。
				const output = message();
				// 推start并传同一output引用作partial，未等待消费者先开始for await。
				stream.push({ type: "start", partial: output });
				// 推done让result Promise兑现output，stop与消息一致；流也可能补durationMs。
				stream.push({ type: "done", reason: "stop", message: output });
				// 显式end结束并唤醒迭代等待者；done已确定的最终结果不会被再次resolve改写。
				stream.end(output);
				// 将已经完成的流交回兼容分发器，complete可直接等它的result而无需遍历事件。
				return stream;
			},
			// 简化流的另一回调，输入同样捕获配置并造流；这是满足注册接口的备用路径，此用例没有执行它。
			streamSimple: (_model, _context, options) => {
				// 若简化路径被调用也把key写到相同捕获变量，但当前断言来自原始流路径。
				capturedApiKey = options?.apiKey;
				// 为简化调用新建事件流，不复用上面函数的局部实例。
				const stream = new AssistantMessageEventStream();
				// 新建另一份ok消息，而不是共享某次调用结果。
				const output = message();
				// 简化实现同样先推start事件。
				stream.push({ type: "start", partial: output });
				// 再推done，最终消息为当前output。
				stream.push({ type: "done", reason: "stop", message: output });
				// 结束此简化流；不安排setTimeout或网络工作。
				stream.end(output);
				// 返回这次构造的流对象。
				return stream;
			},
		});

		// 实际调用原始complete并await最终消息，显式request-key让withEnvApiKey直接保留选项，不查环境凭据；此处忽略返回消息。
		await complete(model, context, { apiKey: "request-key" });

		// 只断言注册回调捕获的key精确等于request-key；不会因模型URL是示例地址而自动测HTTP请求。
		expect(capturedApiKey).toBe("request-key");
	});
});
