// 用本地助手事件流和内存工具验证低层 Agent 循环、队列、准备/收尾钩子与单工具管线；不访问真实模型。
// it 的异步回调通常无业务输入并返回 Promise<void>，it.each 会另传参数；断言失败会使该用例失败，并不成为业务工具结果。
// 所有执行副作用限于内存记录、模块默认流引用与本地微任务/计时器；时长阈值和样例轨迹不证明所有调度或性能情况。
// 从依赖模块导入运行时工厂与类型；type 标记的项只参与 TypeScript 检查。
import {
	// 完整助手消息的类型，涵盖文本、思考及工具调用等内容块。
	type AssistantMessage,
	// 本地事件流工厂；本文件用 push(done/error) 模拟供应商，而不发送请求。
	createAssistantMessageEventStream,
	// 模型边界认识的标准消息联合类型。
	type Message,
	// 模型元数据的泛型类型；API 字面量可约束对应选项。
	type Model,
	// role:toolResult 的完整消息类型，便于筛选后读取 durationMs/usage。
	type ToolResultMessage,
	// 用户消息的静态形状，content 可直接使用字符串。
	type UserMessage,
} from "@earendil-works/pi-ai";
// 导入数组、对象、字符串 schema 构建器；后续工具参数会接受真正的运行时校验。
import { arr, obj, str } from "@earendil-works/pi-schema";
// describe 分组，it 注册用例，expect 在执行期间检查断言；导入不等于运行各测试回调。
import { describe, expect, it } from "vitest";
// 导入被测循环入口与单工具调用管线；本文件通过注入本地流替换实际模型请求。
import { agentLoop, agentLoopContinue, runAgentLoop, runToolCall } from "../src/agent-loop.ts";
// 导入模块默认流设置器，兼容性用例会临时修改这个模块级引用。
import { setDefaultStreamFn } from "../src/index.ts";
// 只引入本包类型；这些声明不会在 JavaScript 执行时变成校验器。
import type {
	// 上下文含消息及可选的实际工具实现。
	AgentContext,
	// 生命周期事件的带 type 标签联合，可通过条件收窄字段。
	AgentEvent,
	// 循环配置含模型、消息转换和回合/工具钩子。
	AgentLoopConfig,
	// Agent 内部消息联合；自定义扩展消息由调用方转换到模型协议。
	AgentMessage,
	// 工具对象类型，泛型关联参数 schema 与 details。
	AgentTool,
	// 从助手内容中提取出的工具调用块类型。
	AgentToolCall,
} from "../src/types.ts";

// 构造一份全零的模型用量。无输入，每次返回独立对象，不请求模型；例 createUsage().cost.total 为 0，仅供消息夹具使用。
function createUsage() {
	// 返回独立的零 token/零费用用量夹具，下面逐字段填值。
	return {
		// 模型输入 token 数固定为零，避免把夹具当真实计费数据。
		input: 0,
		// 模型输出 token 数固定为零。
		output: 0,
		// 缓存读取 token 数固定为零，不实际测试缓存命中。
		cacheRead: 0,
		// 缓存写入 token 数固定为零。
		cacheWrite: 0,
		// 总 token 数也固定为零，不在该助手夹具里计数。
		totalTokens: 0,
		// 给四种 token 分量及总费用填零；每次工厂调用新建这层对象。
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// 构造本地 mock 模型元数据。无输入，返回指定 openai-responses API 的 Model；baseUrl 虽是占位地址，真正不联网依赖各用例注入的本地流。例 id 为 mock。
function createModel(): Model<"openai-responses"> {
	// 返回 mock 模型对象，包含协议、能力、单价和窗口元数据。
	return {
		// 模型标识为 mock，与夹具消息里的 model 对应。
		id: "mock",
		// 显示名称也为 mock，不执行模型发现。
		name: "mock",
		// 声明协议类别为 openai-responses；实际函数仍由测试注入。
		api: "openai-responses",
		// 供应商标签为 openai，只是夹具元数据。
		provider: "openai",
		// 填入不可用于真实服务的示例地址；不联网的关键仍是本地 StreamFn。
		baseUrl: "https://example.invalid",
		// 模型元数据标记不支持思考；本文件不调用真实供应商能力校验。
		reasoning: false,
		// 声明输入模态只有文字；数组值是模型能力元数据。
		input: ["text"],
		// 模型单价全为零，不表示真实供应商免费。
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// 示例上下文窗口元数据，不会在本测试自动生成 8192 个 token。
		contextWindow: 8192,
		// 示例输出上限元数据；截断用例靠手动构造 length 停止原因。
		maxTokens: 2048,
	};
}

// 用给定内容块和停止原因构造 assistant 消息，默认正常 stop；返回消息并读取当前时间，不发送请求。例工具调用配 toolUse，错误场景配 error。
function createAssistantMessage(
	// 索引访问类型：直接复用 AssistantMessage 的 content 字段类型，不另建不一致定义。
	content: AssistantMessage["content"],
	// 复用停止原因联合，调用者不传时默认 stop。
	stopReason: AssistantMessage["stopReason"] = "stop",
	// 声明返回值为完整助手消息，TS 会检查字段是否齐全。
): AssistantMessage {
	// 把传入内容、停止原因与固定模型信息组装成一条完整助手消息。
	return {
		// 消息角色为助手，与模型流最终结果协议一致。
		role: "assistant",
		// 属性简写，把当前传入的 content 引用放入对象，不深复制内容块。
		content,
		// 声明协议类别为 openai-responses；实际函数仍由测试注入。
		api: "openai-responses",
		// 供应商标签为 openai，只是夹具元数据。
		provider: "openai",
		// 把结果归到 mock 模型，方便与模型夹具对应。
		model: "mock",
		// 为该消息创建独立的零用量对象。
		usage: createUsage(),
		// 使用参数给出的停止原因；循环后续调度读取的是消息中的此字段。
		stopReason,
		// 记录当前毫秒时间，不对真实世界的固定时刻作断言。
		timestamp: Date.now(),
	};
}

// 把文本包装为带当前时间的用户消息。输入如 Hello，输出 role:user/content:Hello；只创建夹具，不触发循环。
function createUserMessage(text: string): UserMessage {
	// 返回带当前时间的用户消息，正文直接复用输入字符串。
	return {
		// 标记为用户消息，循环会把它作为新的输入。
		role: "user",
		// 用户文本直接使用传入字符串，不分割内容块或执行文本。
		content: text,
		// 记录当前毫秒时间，不对真实世界的固定时刻作断言。
		timestamp: Date.now(),
	};
}

// Simple identity converter for tests - just passes through standard messages
// 投影测试历史，只保留四种标准角色。输入 AgentMessage[]，输出新的 Message[]，对象仍复用；例 notification 被过滤。末尾 as 只让 TS 接受类型，不进行运行时校验。
function identityConverter(messages: AgentMessage[]): Message[] {
	// 过滤生成新数组；原消息对象引用保持，下一行按角色决定是否保留。
	return messages.filter(
		// || 表示任一标准角色匹配就保留；这只是角色判断，并未验证每个字段。
		(m) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult",
		// 类型断言只改变 TS 眼中的类型，不转换对象也不检查字段。
	) as Message[];
}

// 默认流兼容性分组；describe 注册内部测试，不在分组阶段运行模型。
describe("default stream function compatibility", () => {
	// 验证旧调用者漏传 streamFn 时会取模块默认函数。先安装本地 done 流，再用 Reflect.apply 绕过必填参数签名，最后清除默认值；例一次 Hello 对应一次本地调用。finally 清 undefined，并非恢复先前可能存在的默认函数。
	it("uses the configured default when a legacy caller omits streamFn", async () => {
		// 从零记录默认流函数实际被调用的次数。
		let calls = 0;
		// 安装本地零参回调；循环传来的模型等参数在此被忽略，副作用为替换模块默认函数。
		setDefaultStreamFn(() => {
			// 每进入一次本地默认流，就增加调用计数。
			calls++;
			// 新建一条纯内存助手事件流，保存事件队列及最终结果 Promise。
			const stream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 把下面构造的事件交给本地流；done/error 会同时确定最终消息。
				stream.push({
					// 正常终止事件；循环仍会依据其 message.stopReason 判断是否执行工具或退出。
					type: "done",
					// 该事件声明正常停止，和下面助手夹具的默认 stop 对应。
					reason: "stop",
					// 在终止事件里直接放入完整助手夹具；循环可通过 result() 取到它。
					message: createAssistantMessage([{ type: "text", text: "fallback" }]),
				});
			});
			// 把刚创建的本地流交回调用方；最终消息由稍后的微任务提供。
			return stream;
		});

		// try 保证此段成功或抛错都转入后面的 finally 清理默认流。
		try {
			// 建立空消息、空工具上下文；类型注解在开发期检查字段。
			const context: AgentContext = { messages: [], tools: [] };
			// 配置本地模型元数据及标准角色转换器，实际流由默认设置器提供。
			const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
			// 用动态调用传参数列表；它绕开 agentLoop 正常调用时必填 streamFn 的静态检查，this 为 undefined。
			const stream = Reflect.apply(agentLoop, undefined, [
				// 第一参数是只含 Hello 的新用户消息数组。
				[createUserMessage("Hello")],
				// 传入当前测试上下文，含历史及实际工具。
				context,
				// 传入本用例的模型、转换和钩子配置。
				config,
				// 此位置不提供取消信号；具体参数含义按当前调用签名区分。
				undefined,
				// 参数列表只有四项，漏传第五项 streamFn；ReturnType 复用返回类型，as 不验证返回值。
			]) as ReturnType<typeof agentLoop>;

			// 只等待本次 Agent 运行的最终新增消息，不需要逐个读取事件才能驱动生产者。
			await stream.result();
			// 本地默认函数只应被调用一次，证明漏参入口实际使用了这个替身。
			expect(calls).toBe(1);
			// 无论断言或等待是否失败，都清理这次安装的模块默认函数。
		} finally {
			// 清除模块默认流；这里没有保存和恢复此前可能存在的值。
			setDefaultStreamFn(undefined);
		}
	});
});

// 新输入启动循环的分组；每个用例独立构建本地上下文与 mock 流。
describe("agentLoop with AgentMessage", () => {
	// 验证一次文本请求产生用户/助手消息及几类生命周期事件。输入空历史与 Hello，mock 回 Hi there；收集输出后检查角色和事件存在性。toContain 不证明完整事件顺序，没有真实模型请求。
	it("should emit events with AgentMessage types", async () => {
		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 没有可执行工具；也无须额外宣布非空工具列表。
			tools: [],
		};

		// 构造本次新增用户输入；它的固定文本只用于夹具，mock 回复不分析这段自然语言。
		const userPrompt: AgentMessage = createUserMessage("Hello");

		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
		};

		// 定义无输入本地请求替身：每调用一次，创建事件流并安排预设回复，返回流供循环消费。
		const streamFn = () => {
			// 新建一条纯内存助手事件流，保存事件队列及最终结果 Promise。
			const stream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
				const message = createAssistantMessage([{ type: "text", text: "Hi there!" }]);
				// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
				stream.push({ type: "done", reason: "stop", message });
			});
			// 把刚创建的本地流交回调用方；最终消息由稍后的微任务提供。
			return stream;
		};

		// 创建本次运行的事件记录数组，用于随后筛选或顺序断言。
		const events: AgentEvent[] = [];
		// 以新用户输入启动循环，传入本地 mock 流且不提供取消信号。
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		// 按异步迭代协议逐项等待事件；循环继续直到 agent_end 让流结束。
		for await (const event of stream) {
			// 把收到的事件引用按接收顺序追加到数组，不复制其深层对象。
			events.push(event);
		}

		// 取得本次调用新增的完整消息数组；continue 不会把先前历史重复计入。
		const messages = await stream.result();

		// Should have user message and assistant message
		// 新增消息恰好两条：本次用户输入和最终助手回复，没有非空工具声明需补发。
		expect(messages.length).toBe(2);
		// 第一条新增消息应是用户输入，确认新 prompt 被纳入结果。
		expect(messages[0].role).toBe("user");
		// 第二条新增消息应是助手回复。
		expect(messages[1].role).toBe("assistant");

		// Verify event sequence
		// 把已收集的事件映射成 type 列表，后面的 toContain 只检查各类事件存在。
		const eventTypes = events.map((e) => e.type);
		// 事件列表里必须出现 agent_start，表示本次运行已启动；这里只检查存在性。
		expect(eventTypes).toContain("agent_start");
		// 事件列表里必须出现 turn_start，表示已启动一个回合。
		expect(eventTypes).toContain("turn_start");
		// 事件列表里必须出现 message_start，不在此检查它出现几次或属于哪个角色。
		expect(eventTypes).toContain("message_start");
		// 事件列表里必须出现 message_end，不单独以此证明消息 start/end 配对顺序。
		expect(eventTypes).toContain("message_end");
		// 事件列表里必须出现 turn_end，表示回合有正常的结束通知。
		expect(eventTypes).toContain("turn_end");
		// 事件列表里必须出现 agent_end，表示该运行已发出最终消息集合。
		expect(eventTypes).toContain("agent_end");
	});

	// 验证提供给流函数的上下文只含 transcript messages。输入 system 与 Hello，mock 内检查字段和 system 对象引用后返回 done；不测试真实供应商如何接收这些消息。
	it("should build provider context exclusively from transcript messages", async () => {
		// 创建带明确 system 角色的原始历史消息，用于检查请求是否沿用其对象。
		const initialSystem: AgentMessage = {
			// 这是一条系统消息，保存提示或工具声明，而非顶层 context.systemPrompt。
			role: "system",
			// 固定提示正文，测试不改写或执行此字符串。
			content: "Transcript prompt",
			// 该系统消息不新增工具，避免引入额外工具变更。
			toolsAdded: [],
			// 用固定毫秒值构造夹具，不依赖当前时间。
			timestamp: 1,
		};
		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 没有可执行工具；也无须额外宣布非空工具列表。
			tools: [],
		};
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
		};
		// 启动被测 Agent 运行；参数依次为新消息、上下文、配置、取消信号及本地流函数。
		const stream = agentLoop(
			// 把 system 与 Hello 作为本次初始消息；预期 system 引用可直接传到模型边界。
			[initialSystem, createUserMessage("Hello")],
			// 传入当前测试上下文，含历史及实际工具。
			context,
			// 传入本用例的模型、转换和钩子配置。
			config,
			// 此位置不提供取消信号；具体参数含义按当前调用签名区分。
			undefined,
			// 本地流回调忽略模型参数，检查实际请求上下文后返回 done；断言异常会中断这条路径。
			(_model, providerContext) => {
				// The provider receives a transcript: no top-level prompt or tool fields.
				// 只允许模型边界上下文拥有 messages 这一可枚举自有键，不检查消息对象的所有深层字段。
				expect(Object.keys(providerContext)).toEqual(["messages"]);
				// 用引用相等检查传到请求边界的是指定对象，而非仅字段相同的复制品。
				expect(providerContext.messages[0]).toBe(initialSystem);
				// 为当前模拟请求创建独立助手事件流，无网络连接。
				const response = createAssistantMessageEventStream();
				// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
				queueMicrotask(() => {
					// 发布本次 mock 的预设终止事件，供循环消费并取得最终结果。
					response.push({
						// 正常终止事件；循环仍会依据其 message.stopReason 判断是否执行工具或退出。
						type: "done",
						// 该事件声明正常停止，和下面助手夹具的默认 stop 对应。
						reason: "stop",
						// 在终止事件里直接放入完整助手夹具；循环可通过 result() 取到它。
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				});
				// 返回这次 mock 响应流，不等待其中消息被消费。
				return response;
			},
		);

		// 只等待本次 Agent 运行的最终新增消息，不需要逐个读取事件才能驱动生产者。
		await stream.result();
	});

	// 验证调用方可通过 convertToLlm 排除自定义 notification。先在历史放入通知，再发送 Hello，记录转换结果并消费本地流；例模型请求侧只留用户消息，不据此断言原历史被删除。
	it("should handle custom message types via convertToLlm", async () => {
		// Create a custom message type
		// 声明仅供此测试的通知形状；interface 只做静态描述，不产生构造器。
		interface CustomNotification {
			// 角色限定为 notification 字面量，和标准消息区分。
			role: "notification";
			// 自定义正文的静态类型为字符串；字段名为 text，并非标准消息的 content。
			text: string;
			// 时间字段为数值，具体是否合理不由此类型验证。
			timestamp: number;
		}

		// 建立自定义通知实例，以测试请求投影时的过滤。
		const notification: CustomNotification = {
			// 运行时角色实际为 notification，供下面筛选器识别。
			role: "notification",
			// 固定通知正文，不预期发给本地模型请求。
			text: "This is a notification",
			// 记录当前毫秒时间，不对真实世界的固定时刻作断言。
			timestamp: Date.now(),
		};

		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 双重断言跨过自定义消息与已声明联合的差异，不会验证通知符合标准模型消息。
			messages: [notification as unknown as AgentMessage], // Custom message in context
			// 没有可执行工具；也无须额外宣布非空工具列表。
			tools: [],
		};

		// 构造本次新增用户输入；它的固定文本只用于夹具，mock 回复不分析这段自然语言。
		const userPrompt: AgentMessage = createUserMessage("Hello");

		// 保存转换器最近产生的消息数组，之后检查请求侧投影。
		let convertedMessages: Message[] = [];
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 转换回调接收 Agent 历史，筛选/映射后返回模型能认识的消息；会修改本用例的观察变量。
			convertToLlm: (messages) => {
				// Filter out notifications, convert rest
				// 记录转换后的新数组；后续链式 filter 具体决定保留项。
				convertedMessages = messages
					// 先按实际 role 排除通知；类型断言只允许访问更宽泛的字符串角色。
					.filter((m) => (m as { role: string }).role !== "notification")
					// 再保留该用例需要的三种角色；as 不补齐字段，不在此处理 system。
					.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
				// 将刚记录的标准消息投影交回请求边界，不原地删改传入的历史数组。
				return convertedMessages;
			},
		};

		// 定义无输入本地请求替身：每调用一次，创建事件流并安排预设回复，返回流供循环消费。
		const streamFn = () => {
			// 新建一条纯内存助手事件流，保存事件队列及最终结果 Promise。
			const stream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
				stream.push({ type: "done", reason: "stop", message });
			});
			// 把刚创建的本地流交回调用方；最终消息由稍后的微任务提供。
			return stream;
		};

		// 创建本次运行的事件记录数组，用于随后筛选或顺序断言。
		const events: AgentEvent[] = [];
		// 以新用户输入启动循环，传入本地 mock 流且不提供取消信号。
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		// 按异步迭代协议逐项等待事件；循环继续直到 agent_end 让流结束。
		for await (const event of stream) {
			// 把收到的事件引用按接收顺序追加到数组，不复制其深层对象。
			events.push(event);
		}

		// The notification should have been filtered out in convertToLlm
		// 转换侧只保留一个消息；下方角色断言进一步确认它是用户消息。
		expect(convertedMessages.length).toBe(1); // Only user message
		// 唯一保留项应是用户输入，通知没有进入模型请求投影。
		expect(convertedMessages[0].role).toBe("user");
	});

	// 验证上下文变换结果交给消息转换。输入四条旧消息及一个新问题，transformContext 保留最后两条，convertToLlm 记录筛选结果；检查两数组长度，不使用模型摘要或改写会话文件。
	it("should apply transformContext before convertToLlm", async () => {
		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始化历史消息数组，具体用户/助手交替项见下文。
			messages: [
				// 向历史数组放入一条预设用户消息，保留其先后位置。
				createUserMessage("old message 1"),
				// 构造预设历史或回复的助手消息，不进行文本生成。
				createAssistantMessage([{ type: "text", text: "old response 1" }]),
				// 向历史数组放入一条预设用户消息，保留其先后位置。
				createUserMessage("old message 2"),
				// 构造预设历史或回复的助手消息，不进行文本生成。
				createAssistantMessage([{ type: "text", text: "old response 2" }]),
			],
			// 没有可执行工具；也无须额外宣布非空工具列表。
			tools: [],
		};

		// 构造本次新增用户输入；它的固定文本只用于夹具，mock 回复不分析这段自然语言。
		const userPrompt: AgentMessage = createUserMessage("new message");

		// 保存 transformContext 的输出引用，供转换后的长度比较。
		let transformedMessages: AgentMessage[] = [];
		// 保存转换器最近产生的消息数组，之后检查请求侧投影。
		let convertedMessages: Message[] = [];

		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 异步变换钩子接收 Agent 历史，返回裁剪后的数组；它在 convertToLlm 之前执行。
			transformContext: async (messages) => {
				// Keep only last 2 messages (prune old ones)
				// 负索引从数组尾部取两条，生成浅复制数组，不总结或修改其中消息。
				transformedMessages = messages.slice(-2);
				// 把最后两条历史交给后续转换器。
				return transformedMessages;
			},
			// 转换回调接收 Agent 历史，筛选/映射后返回模型能认识的消息；会修改本用例的观察变量。
			convertToLlm: (messages) => {
				// 对传给转换器的数组按角色筛选，并保存结果作观察。
				convertedMessages = messages.filter(
					// 只保留用户、助手和工具结果角色，不按内容做校验。
					(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
					// 类型断言只改变 TS 眼中的类型，不转换对象也不检查字段。
				) as Message[];
				// 将刚记录的标准消息投影交回请求边界，不原地删改传入的历史数组。
				return convertedMessages;
			},
		};

		// 定义无输入本地请求替身：每调用一次，创建事件流并安排预设回复，返回流供循环消费。
		const streamFn = () => {
			// 新建一条纯内存助手事件流，保存事件队列及最终结果 Promise。
			const stream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
				stream.push({ type: "done", reason: "stop", message });
			});
			// 把刚创建的本地流交回调用方；最终消息由稍后的微任务提供。
			return stream;
		};

		// 以新用户输入启动循环，传入本地 mock 流且不提供取消信号。
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		// 消费所有事件以等待循环结束，此处不使用每个事件值。
		for await (const _ of stream) {
			// consume
		}

		// transformContext should have been called first, keeping only last 2
		// 裁剪结果应只剩最后两条历史，而非全部五条。
		expect(transformedMessages.length).toBe(2);
		// Then convertToLlm receives the pruned messages
		// 后续转换器接收到裁剪结果，因此也应只产生两条标准消息。
		expect(convertedMessages.length).toBe(2);
	});

	// 验证模型工具调用经过本地执行、后置钩子及结果消息。第一次 mock 要求 echo(hello)，工具返回 usage，afterToolCall 替换 usage，第二次正常完成；检查执行输入、事件及最终工具用量。
	it("should handle tool calls and results", async () => {
		// 参数 schema 要求 value 为字符串；obj/str 还供运行时验证和可能的转换使用。
		const toolSchema = obj({ value: str() });
		// 记录本地工具真正收到的字符串值，阻止/截断路径不应向其追加。
		const executed: string[] = [];
		// 构造工具原始上报用量，所有数值是预设夹具而非实际执行计量。
		const toolUsage = {
			// 预设输入 token 分量；仅用于检查 usage 字段传递。
			input: 1,
			// 预设输出 token 分量；仅用于检查 usage 字段传递。
			output: 2,
			// 预设缓存读取 token 分量；仅用于检查 usage 字段传递。
			cacheRead: 3,
			// 预设缓存写入 token 分量；仅用于检查 usage 字段传递。
			cacheWrite: 4,
			// 预设总 token 数；仅用于检查 usage 字段传递。
			totalTokens: 10,
			// 设置这份用量夹具的各项费用与合计，后置钩子应整体替换而非深合并。
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		// 构造后置钩子将替换进去的另一份工具用量，便于区分原值与覆盖值。
		const patchedToolUsage = {
			// 预设输入 token 分量；仅用于检查 usage 字段传递。
			input: 5,
			// 预设输出 token 分量；仅用于检查 usage 字段传递。
			output: 6,
			// 预设缓存读取 token 分量；仅用于检查 usage 字段传递。
			cacheRead: 7,
			// 预设缓存写入 token 分量；仅用于检查 usage 字段传递。
			cacheWrite: 8,
			// 预设总 token 数；仅用于检查 usage 字段传递。
			totalTokens: 26,
			// 设置这份用量夹具的各项费用与合计，后置钩子应整体替换而非深合并。
			cost: { input: 0.5, output: 0.6, cacheRead: 0.7, cacheWrite: 0.8, total: 2.6 },
		};
		// 观察变量允许尚未调用钩子的 undefined；typeof toolUsage 复用这份对象的字段类型。
		let observedToolUsage: typeof toolUsage | undefined;
		// 工具类型把 typeof toolSchema 的参数结构与 {value:string} 详情关联；typeof 在此提取静态类型。
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			// 工具名为 echo，与模型调用块的 name 匹配。
			name: "echo",
			// 工具显示标签，和调用匹配用的 name 字段分开。
			label: "Echo",
			// 工具说明随声明投影提供给模型，不执行这段文字。
			description: "Echo tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 本地执行器收到调用 id 和已准备/验证的参数，异步返回结果；此处忽略 id，只操作内存。
			async execute(_toolCallId, params) {
				// 把实际到达 execute 的 value 追加到记录中，便于区别仅生成调用与真正执行。
				executed.push(params.value);
				// 返回 echo 文本、value 详情和原始 usage，供后置钩子观察及替换。
				return {
					// 把本地输入拼进工具文本结果；模板插值只生成字符串，不执行模型或真实文件操作。
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					// details 保存本地展示/扩展数据；并非模型可见 content 的自动副本。
					details: { value: params.value },
					// 工具上报该用例预设用量，不从执行文本计算真实 token。
					usage: toolUsage,
				};
			},
		};

		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 把本地 tool 放进可执行工具列表，循环按名字匹配它。
			tools: [tool],
		};

		// 构造本次新增用户输入；它的固定文本只用于夹具，mock 回复不分析这段自然语言。
		const userPrompt: AgentMessage = createUserMessage("echo something");

		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// 后置钩子解构执行结果，记录原始 usage 后返回覆盖值；运行在工具完成与结果消息发布之间。
			afterToolCall: async ({ result }) => {
				// 读取工具原始 usage，尚未应用本钩子的覆盖。
				observedToolUsage = result.usage;
				// 仅替换 usage；其他结果字段仍沿用原工具返回值。
				return { usage: patchedToolUsage };
			},
		};

		// 记录当前预设响应的序号，零代表首次工具请求，后续通常返回文本结束。
		let callIndex = 0;
		// 定义无输入本地请求替身：每调用一次，创建事件流并安排预设回复，返回流供循环消费。
		const streamFn = () => {
			// 新建一条纯内存助手事件流，保存事件队列及最终结果 Promise。
			const stream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 首次本地请求发工具调用，后续走普通文本回复分支。
				if (callIndex === 0) {
					// First call: return tool call
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage(
						// 预设调用 id=tool-1、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
						"toolUse",
					);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					stream.push({ type: "done", reason: "toolUse", message });
					// 前面的首次请求条件不成立时，构造普通文本回复作为本轮收尾。
				} else {
					// Second call: return final response
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					stream.push({ type: "done", reason: "stop", message });
				}
				// 推进 mock 请求序号，确保下一次循环请求不会重复首轮工具调用。
				callIndex++;
			});
			// 把刚创建的本地流交回调用方；最终消息由稍后的微任务提供。
			return stream;
		};

		// 创建本次运行的事件记录数组，用于随后筛选或顺序断言。
		const events: AgentEvent[] = [];
		// 以新用户输入启动循环，传入本地 mock 流且不提供取消信号。
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		// 按异步迭代协议逐项等待事件；循环继续直到 agent_end 让流结束。
		for await (const event of stream) {
			// 把收到的事件引用按接收顺序追加到数组，不复制其深层对象。
			events.push(event);
		}

		// Tool should have been executed
		// 真正执行记录应只有 hello，证明 mock 工具调用进入了本地 execute。
		expect(executed).toEqual(["hello"]);

		// Should have tool execution events
		// 查找第一个工具执行开始事件，find 找不到时返回 undefined。
		const toolStart = events.find((e) => e.type === "tool_execution_start");
		// 查找第一个工具执行结束事件，和工具结果 message_end 区分。
		const toolEnd = events.find((e) => e.type === "tool_execution_end");
		// 必须有工具处理开始事件，不能只在助手内容里看见 toolCall。
		expect(toolStart).toBeDefined();
		// 必须有工具处理结束事件，再在收窄分支里检查其状态。
		expect(toolEnd).toBeDefined();
		// 可选链兼顾未找到事件；条件成立时 TS 收窄到有 isError/result 的事件分支。
		if (toolEnd?.type === "tool_execution_end") {
			// 完成事件应为成功，echo 和后置 usage 覆盖没有将它变成错误。
			expect(toolEnd.isError).toBe(false);
		}
		// 后置钩子所见 usage 应仍是工具原值，而非自身将要返回的覆盖。
		expect(observedToolUsage).toEqual(toolUsage);
		// 取得本次调用新增的完整消息数组；continue 不会把先前历史重复计入。
		const messages = await stream.result();
		// 从本次新增消息里取首条工具结果，不是从工具执行事件里取。
		const toolResult = messages.find((message) => message.role === "toolResult");
		// 最终工具消息 usage 应采用钩子提供的整份替代对象。
		expect(toolResult?.role === "toolResult" ? toolResult.usage : undefined).toEqual(patchedToolUsage);
	});

	// #10549
	// 复现 #10549 的工具耗时记录。前置钩子每次等 100ms，真正 execute 等 30ms，其中 blocked 被阻止；检查实际执行的 durationMs 范围、阻止结果无耗时。计时阈值受本机调度影响，不是性能复杂度证明。
	it("records how long execute() took on the tool result, excluding hooks", async () => {
		// 参数 schema 要求 value 为字符串；obj/str 还供运行时验证和可能的转换使用。
		const toolSchema = obj({ value: str() });
		// 本地延时函数接收毫秒数，注册计时器后返回 Promise；ms 是最低等待量，调度可延后。
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		// 工具类型把 typeof toolSchema 的参数结构与 {value:string} 详情关联；typeof 在此提取静态类型。
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			// 工具名为 echo，与模型调用块的 name 匹配。
			name: "echo",
			// 工具显示标签，和调用匹配用的 name 字段分开。
			label: "Echo",
			// 工具说明随声明投影提供给模型，不执行这段文字。
			description: "Echo tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 本地执行器收到调用 id 和已准备/验证的参数，异步返回结果；此处忽略 id，只操作内存。
			async execute(_toolCallId, params) {
				// 让真正 execute 阶段至少等待约 30ms，供耗时字段对照。
				await sleep(30);
				// 执行器返回输入文字与详情，不附带额外延时或模型请求。
				return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
			},
		};
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// 前置钩子接收原始调用信息，先等待再决定是否阻止；这段耗时不应记为 execute 耗时。
			beforeToolCall: async ({ toolCall }) => {
				// 在前置阶段等待约 100ms，以便区分钩子与真正执行的时长。
				await sleep(100);
				// id 为 blocked 时返回阻止决策，其他调用照常；三元表达式只选择其中一支。
				return toolCall.id === "blocked" ? { block: true, reason: "no" } : undefined;
			},
		};
		// 记录当前预设响应的序号，零代表首次工具请求，后续通常返回文本结束。
		let callIndex = 0;
		// 定义无输入本地请求替身：每调用一次，创建事件流并安排预设回复，返回流供循环消费。
		const streamFn = () => {
			// 新建一条纯内存助手事件流，保存事件队列及最终结果 Promise。
			const stream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 准备由后续条件表达式选择的一条完整助手消息。
				const message =
					// 根据当前请求序号选择首轮工具消息或收尾文本。
					callIndex === 0
						? // 三元表达式的真分支构造首轮工具调用消息，并把 stopReason 设为 toolUse。
							createAssistantMessage(
								[
									// 预设调用 id=ran、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
									{ type: "toolCall", id: "ran", name: "echo", arguments: { value: "a" } },
									// 预设调用 id=blocked、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
									{ type: "toolCall", id: "blocked", name: "echo", arguments: { value: "b" } },
								],
								// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
								"toolUse",
							)
						: // 三元表达式的假分支构造正常 stop 文本回复，用于收尾或暴露不应发生的续轮。
							createAssistantMessage([{ type: "text", text: "done" }]);
				// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
				stream.push({ type: "done", reason: callIndex === 0 ? "toolUse" : "stop", message });
				// 推进 mock 请求序号，确保下一次循环请求不会重复首轮工具调用。
				callIndex++;
			});
			// 把刚创建的本地流交回调用方；最终消息由稍后的微任务提供。
			return stream;
		};
		// 启动该用例的 Agent 循环，最后的本地回调构造预设回复；工具和钩子使用当前配置。
		const stream = agentLoop([createUserMessage("go")], { messages: [], tools: [tool] }, config, undefined, streamFn);
		// 排空异步事件流，当前用例只关心最终结果或外部观察变量。
		for await (const _event of stream) {
			// drain
		}
		// 等待新增消息数组后筛选工具结果，先完成括号内 await 再调用 filter。
		const results = (await stream.result()).filter(
			// 返回类型谓词使筛选后的数组在 TS 中成为 ToolResultMessage[]；运行时仍只判断角色。
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		// 按源调用顺序解构两条结果，字段可选链可处理不存在的项。
		const [ran, blocked] = results;
		// 实际 execute 等待 30ms，因此要求记录至少 25ms；不要求时钟精确到 30。
		expect(ran?.durationMs).toBeGreaterThanOrEqual(25);
		// 执行时长应低于 100ms，以区分前置钩子延时；这是有调度波动的测试阈值。
		expect(ran?.durationMs).toBeLessThan(100);
		// 被前置钩子阻止的调用应形成错误工具消息，而非成功空结果。
		expect(blocked?.isError).toBe(true);
		// 被前置阻止、未执行的结果不应具有 durationMs 自有/继承可见属性。
		expect(blocked).not.toHaveProperty("durationMs");
	});

	// 验证 length 截断消息里的工具即使参数可通过 schema 也不能执行。mock 先发 echo(hel)+length，循环生成错误工具结果后再次请求并结束；检查未执行、错误说明和请求次数。这里直接构造截断后的调用，不运行 JSON 补全解析器。
	it("should not execute tool calls from a length-truncated assistant message", async () => {
		// 参数 schema 要求 value 为字符串；obj/str 还供运行时验证和可能的转换使用。
		const toolSchema = obj({ value: str() });
		// 记录本地工具真正收到的字符串值，阻止/截断路径不应向其追加。
		const executed: string[] = [];
		// 工具类型把 typeof toolSchema 的参数结构与 {value:string} 详情关联；typeof 在此提取静态类型。
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			// 工具名为 echo，与模型调用块的 name 匹配。
			name: "echo",
			// 工具显示标签，和调用匹配用的 name 字段分开。
			label: "Echo",
			// 工具说明随声明投影提供给模型，不执行这段文字。
			description: "Echo tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 本地执行器收到调用 id 和已准备/验证的参数，异步返回结果；此处忽略 id，只操作内存。
			async execute(_toolCallId, params) {
				// 把实际到达 execute 的 value 追加到记录中，便于区别仅生成调用与真正执行。
				executed.push(params.value);
				// 如果实际进入 execute，就返回 echo 内容与详情；截断用例要求这段始终不运行。
				return {
					// 把本地输入拼进工具文本结果；模板插值只生成字符串，不执行模型或真实文件操作。
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					// details 保存本地展示/扩展数据；并非模型可见 content 的自动副本。
					details: { value: params.value },
				};
			},
		};

		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 把本地 tool 放进可执行工具列表，循环按名字匹配它。
			tools: [tool],
		};

		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
		};

		// 记录当前预设响应的序号，零代表首次工具请求，后续通常返回文本结束。
		let callIndex = 0;
		// 定义无输入本地请求替身：每调用一次，创建事件流并安排预设回复，返回流供循环消费。
		const streamFn = () => {
			// 新建一条纯内存助手事件流，保存事件队列及最终结果 Promise。
			const stream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 首次本地请求发工具调用，后续走普通文本回复分支。
				if (callIndex === 0) {
					// Output hit the token limit mid tool call. The salvage parser can
					// produce arguments that validate but are silently truncated, so
					// nothing in this message may execute.
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage(
						// 预设调用 id=tool-1、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hel" } }],
						// 把完整助手消息标记为输出截断，循环应生成错误工具结果而不执行这些参数。
						"length",
					);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					stream.push({ type: "done", reason: "length", message });
					// 前面的首次请求条件不成立时，构造普通文本回复作为本轮收尾。
				} else {
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					stream.push({ type: "done", reason: "stop", message });
				}
				// 推进 mock 请求序号，确保下一次循环请求不会重复首轮工具调用。
				callIndex++;
			});
			// 把刚创建的本地流交回调用方；最终消息由稍后的微任务提供。
			return stream;
		};

		// 创建本次运行的事件记录数组，用于随后筛选或顺序断言。
		const events: AgentEvent[] = [];
		// 启动该用例的 Agent 循环，最后的本地回调构造预设回复；工具和钩子使用当前配置。
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, streamFn);
		// 按异步迭代协议逐项等待事件；循环继续直到 agent_end 让流结束。
		for await (const event of stream) {
			// 把收到的事件引用按接收顺序追加到数组，不复制其深层对象。
			events.push(event);
		}

		// The tool must never execute with potentially truncated arguments.
		// length 截断消息的工具不得执行，因此记录数组必须完全为空。
		expect(executed).toEqual([]);

		// 查找第一个工具执行结束事件，和工具结果 message_end 区分。
		const toolEnd = events.find((e) => e.type === "tool_execution_end");
		// 截断也应发布明确的工具结束事件，让请求与错误结果有可见终点。
		expect(toolEnd).toBeDefined();
		// 可选链兼顾未找到事件；条件成立时 TS 收窄到有 isError/result 的事件分支。
		if (toolEnd?.type === "tool_execution_end") {
			// 截断工具的完成事件必须标记为错误。
			expect(toolEnd.isError).toBe(true);
			// 在错误结果内容中找首个文本块；显式注解仅提供 type 字段给筛选条件。
			const text = toolEnd.result.content.find((c: { type: string }) => c.type === "text");
			// 要求错误文本包含输出 token 限制说明；前面的条件表达式兼顾找不到文本块。
			expect(text && "text" in text ? text.text : "").toContain("output token limit");
		}

		// The loop continues so the model can re-issue the tool call.
		// 一次截断工具回复后应再调用一次本地模型，让它有重发机会；此 mock 的第二次直接结束。
		expect(callIndex).toBe(2);
		// 取得本次调用新增的完整消息数组；continue 不会把先前历史重复计入。
		const messages = await stream.result();
		// 最后一条新增消息必须是第二次请求得到的助手消息。
		expect(messages[messages.length - 1].role).toBe("assistant");
	});

	// 验证 beforeToolCall 可以修改已验证的参数，随后不会重新验证。schema 要字符串，mock 发 hello，钩子把副本 value 改成 123，本地工具记录数字；这是钩子边界的实际行为，不表示数字符合该 schema。
	it("should execute mutated beforeToolCall args without revalidation", async () => {
		// 参数 schema 要求 value 为字符串；obj/str 还供运行时验证和可能的转换使用。
		const toolSchema = obj({ value: str() });
		// 记录可能被钩子改成数字的值；Array<T> 与 T[] 都是数组类型语法。
		const executed: Array<string | number> = [];
		// 参数依旧源于字符串 schema，详情刻意允许字符串或数字，以观测钩子修改后的实值。
		const tool: AgentTool<typeof toolSchema, { value: string | number }> = {
			// 工具名为 echo，与模型调用块的 name 匹配。
			name: "echo",
			// 工具显示标签，和调用匹配用的 name 字段分开。
			label: "Echo",
			// 工具说明随声明投影提供给模型，不执行这段文字。
			description: "Echo tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 本地执行器收到调用 id 和已准备/验证的参数，异步返回结果；此处忽略 id，只操作内存。
			async execute(_toolCallId, params) {
				// 记录执行参数；as 放宽静态视角，运行时不会把字符串变成数字。
				executed.push(params.value as string | number);
				// 把钩子修改后的实值用于文本和详情，借此观察验证之后允许修改的边界。
				return {
					// String(params.value) 在运行时把钩子改出的数字转为文字，再插入 echo 文本；这和上面的 as 类型断言作用不同。
					content: [{ type: "text", text: `echoed: ${String(params.value)}` }],
					// 同样把实际值放入详情，断言不生成转换代码。
					details: { value: params.value as string | number },
				};
			},
		};

		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 把本地 tool 放进可执行工具列表，循环按名字匹配它。
			tools: [tool],
		};

		// 构造本次新增用户输入；它的固定文本只用于夹具，mock 回复不分析这段自然语言。
		const userPrompt: AgentMessage = createUserMessage("echo something");

		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// 前置钩子拿到已验证的参数副本，可修改它；返回 undefined 代表不阻止。
			beforeToolCall: async ({ args }) => {
				// 把 unknown 断言为可修改的宽字段形状，不重新执行 schema 校验。
				const mutableArgs = args as { value: string | number };
				// 直接把参数副本的 value 改为数字，用来验证钩子后不再校验的边界。
				mutableArgs.value = 123;
				// 此钩子不提供覆盖或阻止决策，调用方沿用当前状态。
				return undefined;
			},
		};

		// 记录当前预设响应的序号，零代表首次工具请求，后续通常返回文本结束。
		let callIndex = 0;
		// 定义无输入本地请求替身：每调用一次，创建事件流并安排预设回复，返回流供循环消费。
		const streamFn = () => {
			// 新建一条纯内存助手事件流，保存事件队列及最终结果 Promise。
			const stream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 首次本地请求发工具调用，后续走普通文本回复分支。
				if (callIndex === 0) {
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage(
						// 预设调用 id=tool-1、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
						"toolUse",
					);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					stream.push({ type: "done", reason: "toolUse", message });
					// 前面的首次请求条件不成立时，构造普通文本回复作为本轮收尾。
				} else {
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					stream.push({ type: "done", reason: "stop", message });
				}
				// 推进 mock 请求序号，确保下一次循环请求不会重复首轮工具调用。
				callIndex++;
			});
			// 把刚创建的本地流交回调用方；最终消息由稍后的微任务提供。
			return stream;
		};

		// 以新用户输入启动循环，传入本地 mock 流且不提供取消信号。
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		// 排空异步事件流，当前用例只关心最终结果或外部观察变量。
		for await (const _event of stream) {
			// consume
		}

		// 执行器实际收到数字 123，而不是原字符串 hello，证明钩子修改没有被再次校验拦回。
		expect(executed).toEqual([123]);
	});

	// 验证 prepareArguments 先整理参数再走 schema 校验。mock 发平铺 oldText/newText，工具适配器改为 edits 数组，execute 记录数组；例 before→after 变为一条替换，不实际编辑文件。
	it("should prepare tool arguments for validation", async () => {
		// 每条替换要求 oldText/newText 两个字符串，未写入文件。
		const replaceSchema = obj({ oldText: str(), newText: str() });
		// 正式参数要求 edits 数组，每个元素都符合替换 schema。
		const toolSchema = obj({ edits: arr(replaceSchema) });
		// 记录每次 execute 得到的 edits 数组；外层数组收集多次执行，内层数组表示一次的替换列表。
		const executed: Array<Array<{ oldText: string; newText: string }>> = [];
		// 把 edits schema 作为参数类型，工具详情只返回替换条数。
		const tool: AgentTool<typeof toolSchema, { count: number }> = {
			// 模型通过名字 edit 找到该本地参数适配工具，不是真实文件编辑器。
			name: "edit",
			// 给工具显示用的标签。
			label: "Edit",
			// 测试用工具描述，未提供真实文件修改能力。
			description: "Edit tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 参数准备器接收模型原始 unknown 输入，同步返回正式参数形状；在 schema 校验前调用。
			prepareArguments(args) {
				// 原始模型参数是信任边界：先排除空值和非对象，再安全读取字段。
				if (!args || typeof args !== "object") {
					// 无法适配就原值返回，让后续 schema 判断；as 本身不修复或验证数据。
					return args as { edits: { oldText: string; newText: string }[] };
				}
				// 把对象视为可能含两种参数写法的形状，下面仍检查平铺字段的运行时类型。
				const input = args as {
					// 可选的正式替换列表；? 表示字段可能缺失，不执行数组校验。
					edits?: Array<{ oldText: string; newText: string }>;
					// 兼容输入里可选的平铺旧文本字段。
					oldText?: string;
					// 兼容输入里可选的平铺新文本字段。
					newText?: string;
				};
				// 只有两个平铺字段都实际为字符串才适配，否则把原参数留给 schema。
				if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
					// 无法适配就原值返回，让后续 schema 判断；as 本身不修复或验证数据。
					return args as { edits: { oldText: string; newText: string }[] };
				}
				// 创建正式 edits 形状，把已有列表与平铺替换项合在一起交给后续校验。
				return {
					// 缺少 edits 时用空数组，再追加平铺替换项；展开为浅复制，这里没有独立验证现有 edits 可迭代。
					edits: [...(input.edits ?? []), { oldText: input.oldText, newText: input.newText }],
				};
			},
			// 本地执行器收到调用 id 和已准备/验证的参数，异步返回结果；此处忽略 id，只操作内存。
			async execute(_toolCallId, params) {
				// 记录经过准备和 schema 处理后的替换数组引用。
				executed.push(params.edits);
				// 返回替换条数及文字摘要；这只是内存工具，并未处理任何文件。
				return {
					// 把本地输入拼进工具文本结果；模板插值只生成字符串，不执行模型或真实文件操作。
					content: [{ type: "text", text: `edited ${params.edits.length}` }],
					// 详情记替换条数，不表示真实文件中成功替换的次数。
					details: { count: params.edits.length },
				};
			},
		};

		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 把本地 tool 放进可执行工具列表，循环按名字匹配它。
			tools: [tool],
		};

		// 构造本次新增用户输入；它的固定文本只用于夹具，mock 回复不分析这段自然语言。
		const userPrompt: AgentMessage = createUserMessage("edit something");
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
		};

		// 记录当前预设响应的序号，零代表首次工具请求，后续通常返回文本结束。
		let callIndex = 0;
		// 定义无输入本地请求替身：每调用一次，创建事件流并安排预设回复，返回流供循环消费。
		const streamFn = () => {
			// 新建一条纯内存助手事件流，保存事件队列及最终结果 Promise。
			const stream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 首次本地请求发工具调用，后续走普通文本回复分支。
				if (callIndex === 0) {
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage(
						[
							{
								// 标记该内容块为工具请求，不是实际执行结果。
								type: "toolCall",
								// 此调用的关联 id 固定为 tool-1，供工具结果对应原请求。
								id: "tool-1",
								// 模型通过名字 edit 找到该本地参数适配工具，不是真实文件编辑器。
								name: "edit",
								// 故意用平铺 oldText/newText，而非正式 edits 参数，检验 prepareArguments 的适配。
								arguments: { oldText: "before", newText: "after" },
							},
						],
						// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
						"toolUse",
					);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					stream.push({ type: "done", reason: "toolUse", message });
					// 前面的首次请求条件不成立时，构造普通文本回复作为本轮收尾。
				} else {
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					stream.push({ type: "done", reason: "stop", message });
				}
				// 推进 mock 请求序号，确保下一次循环请求不会重复首轮工具调用。
				callIndex++;
			});
			// 把刚创建的本地流交回调用方；最终消息由稍后的微任务提供。
			return stream;
		};

		// 以新用户输入启动循环，传入本地 mock 流且不提供取消信号。
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		// 排空异步事件流，当前用例只关心最终结果或外部观察变量。
		for await (const _event of stream) {
			// consume
		}

		// 执行器得到一条标准 edits 数组，其内容来自平铺参数的适配。
		expect(executed).toEqual([[{ oldText: "before", newText: "after" }]]);
	});

	// 验证并行批次的两种顺序：完成事件按完成先后，工具结果消息及 turn_end 结果按源调用顺序。first 等门闩、second 立即结束，20ms 后释放 first；检查观测到重叠及三组 id，并非线程并行测试。
	it("should emit tool_execution_end in completion order but persist tool results in source order", async () => {
		// 参数 schema 要求 value 为字符串；obj/str 还供运行时验证和可能的转换使用。
		const toolSchema = obj({ value: str() });
		// 记录 first 是否越过门闩，供 second 观察两次执行是否重叠。
		let firstResolved = false;
		// 初始未观察到重叠，second 若在 first 未完成时运行就改为 true。
		let parallelObserved = false;
		// 保存稍后释放门闩的回调；联合 undefined 表示尚未赋值，括号中的 () => void 是函数类型。
		let releaseFirst: (() => void) | undefined;
		// 创建仅用于时序同步的 Promise<void>，执行器同步得到 resolve；此 Promise 不返回业务数据。
		const firstDone = new Promise<void>((resolve) => {
			// 保存 resolve 引用，计时器之后调用它让等待 first 的执行器继续。
			releaseFirst = resolve;
		});

		// 工具类型把 typeof toolSchema 的参数结构与 {value:string} 详情关联；typeof 在此提取静态类型。
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			// 工具名为 echo，与模型调用块的 name 匹配。
			name: "echo",
			// 工具显示标签，和调用匹配用的 name 字段分开。
			label: "Echo",
			// 工具说明随声明投影提供给模型，不执行这段文字。
			description: "Echo tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 本地执行器收到调用 id 和已准备/验证的参数，异步返回结果；此处忽略 id，只操作内存。
			async execute(_toolCallId, params) {
				// 只让 first 调用等待门闩，second 用作观察者。
				if (params.value === "first") {
					// 暂停当前工具执行到门闩释放，其他已启动的异步工具仍可运行。
					await firstDone;
					// first 已通过等待点，后续 second 观察时应知道它不再阻塞。
					firstResolved = true;
				}
				// 若 second 开始时 first 还未释放，则两次异步执行确有重叠。
				if (params.value === "second" && !firstResolved) {
					// 记录已观察到重叠等待，不表示两个 JavaScript 回调在不同线程执行。
					parallelObserved = true;
				}
				// 等待门闩后返回 echo 结果，供比较完成事件和提交结果的两种顺序。
				return {
					// 把本地输入拼进工具文本结果；模板插值只生成字符串，不执行模型或真实文件操作。
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					// 这条工具完成时保留其参数值作为详情，不把 first/second 的完成先后改成消息顺序。
					details: { value: params.value },
				};
			},
		};

		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 把本地 tool 放进可执行工具列表，循环按名字匹配它。
			tools: [tool],
		};

		// 构造本次新增用户输入；它的固定文本只用于夹具，mock 回复不分析这段自然语言。
		const userPrompt: AgentMessage = createUserMessage("echo both");
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// 显式选择并行批次：前置准备仍依序，真正执行可并发等待。
			toolExecution: "parallel",
		};

		// 记录当前预设响应的序号，零代表首次工具请求，后续通常返回文本结束。
		let callIndex = 0;
		// 启动该用例的 Agent 循环，最后的本地回调构造预设回复；工具和钩子使用当前配置。
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			// 创建本轮本地响应流；随后微任务把预设消息送进去。
			const mockStream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 首次本地请求发工具调用，后续走普通文本回复分支。
				if (callIndex === 0) {
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage(
						[
							// 预设调用 id=tool-1、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							// 预设调用 id=tool-2、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
						"toolUse",
					);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					mockStream.push({ type: "done", reason: "toolUse", message });
					// 约 20ms 后可选调用释放函数；?.() 只在回调已赋值时调用，计时不保证精确到点。
					setTimeout(() => releaseFirst?.(), 20);
					// 前面的首次请求条件不成立时，构造普通文本回复作为本轮收尾。
				} else {
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					mockStream.push({ type: "done", reason: "stop", message });
				}
				// 推进 mock 请求序号，确保下一次循环请求不会重复首轮工具调用。
				callIndex++;
			});
			// 交回本轮模拟流，循环随后异步迭代它。
			return mockStream;
		});

		// 创建本次运行的事件记录数组，用于随后筛选或顺序断言。
		const events: AgentEvent[] = [];
		// 按异步迭代协议逐项等待事件；循环继续直到 agent_end 让流结束。
		for await (const event of stream) {
			// 把收到的事件引用按接收顺序追加到数组，不复制其深层对象。
			events.push(event);
		}

		// 把完成事件投影成 id 列表；flatMap 的空数组可排除无关事件。
		const toolExecutionEndIds = events.flatMap((event) => {
			// 只保留工具完成事件，其他生命周期事件走空数组分支。
			if (event.type !== "tool_execution_end") {
				// 该分支没有待交付消息或投影项，返回空数组。
				return [];
			}
			// 把相关事件的调用 id 包成单元素数组，供 flatMap 展平。
			return [event.toolCallId];
		});
		// 从事件流投影工具结果消息的 id，观察提交顺序而非工具完成先后。
		const toolResultIds = events.flatMap((event) => {
			// 先排除非完整消息事件，再检查消息角色；|| 短路避免访问不具有 message 的事件。
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				// 该分支没有待交付消息或投影项，返回空数组。
				return [];
			}
			// 提取这条工具结果关联的原始调用 id。
			return [event.message.toolCallId];
		});
		// 从 turn_end 的整批结果提取 id，核对回合快照的顺序。
		const turnToolResultIds = events.flatMap((event) => {
			// 仅回合结束事件提供此处需要的 toolResults 数组。
			if (event.type !== "turn_end") {
				// 该分支没有待交付消息或投影项，返回空数组。
				return [];
			}
			// 把该回合结果数组按原顺序映射为调用 id。
			return event.toolResults.map((toolResult) => toolResult.toolCallId);
		});

		// 核对是否观测到 second 在 first 仍等待时运行；这是本地异步重叠的结果。
		expect(parallelObserved).toBe(true);
		// 完成事件应为 second→first，反映本地第二项先结束。
		expect(toolExecutionEndIds).toEqual(["tool-2", "tool-1"]);
		// 工具结果消息/回合结果应保持 first→second 的源调用次序。
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
		// 工具结果消息/回合结果应保持 first→second 的源调用次序。
		expect(turnToolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	// 验证工具批次完成后才注入 steering。顺序执行 first/second，队列在至少一次工具执行后可返回 interrupt；检查两工具结果先于插话消息，第二次本地请求能看到插话。
	it("should inject queued messages after all tool calls complete", async () => {
		// 参数 schema 要求 value 为字符串；obj/str 还供运行时验证和可能的转换使用。
		const toolSchema = obj({ value: str() });
		// 记录本地工具真正收到的字符串值，阻止/截断路径不应向其追加。
		const executed: string[] = [];
		// 工具类型把 typeof toolSchema 的参数结构与 {value:string} 详情关联；typeof 在此提取静态类型。
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			// 工具名为 echo，与模型调用块的 name 匹配。
			name: "echo",
			// 工具显示标签，和调用匹配用的 name 字段分开。
			label: "Echo",
			// 工具说明随声明投影提供给模型，不执行这段文字。
			description: "Echo tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 本地执行器收到调用 id 和已准备/验证的参数，异步返回结果；此处忽略 id，只操作内存。
			async execute(_toolCallId, params) {
				// 把实际到达 execute 的 value 追加到记录中，便于区别仅生成调用与真正执行。
				executed.push(params.value);
				// 将本次已执行值写成工具正文与详情，两个调用都应先完成才注入插话。
				return {
					// 把本地输入拼进工具文本结果；模板插值只生成字符串，不执行模型或真实文件操作。
					content: [{ type: "text", text: `ok:${params.value}` }],
					// details 保存本地展示/扩展数据；并非模型可见 content 的自动副本。
					details: { value: params.value },
				};
			},
		};

		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 把本地 tool 放进可执行工具列表，循环按名字匹配它。
			tools: [tool],
		};

		// 构造本次新增用户输入；它的固定文本只用于夹具，mock 回复不分析这段自然语言。
		const userPrompt: AgentMessage = createUserMessage("start");
		// 预建插话用户消息，仅在队列回调允许时交给循环。
		const queuedUserMessage: AgentMessage = createUserMessage("interrupt");

		// 保证这条插话最多交付一次，避免无限续轮。
		let queuedDelivered = false;
		// 记录当前预设响应的序号，零代表首次工具请求，后续通常返回文本结束。
		let callIndex = 0;
		// 记录第二次本地请求是否含插话文本。
		let sawInterruptInContext = false;

		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// 显式选择依次准备、执行、后处理每次调用。
			toolExecution: "sequential",
			// 异步队列读取器无输入，按当前记录返回待交付消息，并更新本地交付状态。
			getSteeringMessages: async () => {
				// Return steering message after tool execution has started.
				// 只有至少一工具已经执行且尚未交付插话，才向循环返回它。
				if (executed.length >= 1 && !queuedDelivered) {
					// 标记插话已交付，后续查询返回空数组。
					queuedDelivered = true;
					// 把预设插话作为本次队列批次返回。
					return [queuedUserMessage];
				}
				// 该分支没有待交付消息或投影项，返回空数组。
				return [];
			},
		};

		// 创建本次运行的事件记录数组，用于随后筛选或顺序断言。
		const events: AgentEvent[] = [];
		// 启动循环并注入本地回调；忽略模型/选项参数，在请求上下文中观察插话。
		const stream = agentLoop([userPrompt], context, config, undefined, (_model, ctx, _options) => {
			// Check if interrupt message is in context on second call
			// 第二次本地请求才检查插话是否已经写入待发上下文。
			if (callIndex === 1) {
				// some 只需一条消息满足条件；将检查结果保存在本地观察变量。
				sawInterruptInContext = ctx.messages.some(
					// 同时要求用户角色、字符串正文及文本 interrupt，避免把内容块数组当相同文本。
					(m) => m.role === "user" && typeof m.content === "string" && m.content === "interrupt",
				);
			}

			// 创建本轮本地响应流；随后微任务把预设消息送进去。
			const mockStream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 首次本地请求发工具调用，后续走普通文本回复分支。
				if (callIndex === 0) {
					// First call: return two tool calls
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage(
						[
							// 预设调用 id=tool-1、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							// 预设调用 id=tool-2、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
						"toolUse",
					);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					mockStream.push({ type: "done", reason: "toolUse", message });
					// 前面的首次请求条件不成立时，构造普通文本回复作为本轮收尾。
				} else {
					// Second call: return final response
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					mockStream.push({ type: "done", reason: "stop", message });
				}
				// 推进 mock 请求序号，确保下一次循环请求不会重复首轮工具调用。
				callIndex++;
			});
			// 交回本轮模拟流，循环随后异步迭代它。
			return mockStream;
		});

		// 按异步迭代协议逐项等待事件；循环继续直到 agent_end 让流结束。
		for await (const event of stream) {
			// 把收到的事件引用按接收顺序追加到数组，不复制其深层对象。
			events.push(event);
		}

		// Both tools should execute before steering is injected
		// 两次 execute 都应完成并保持 first→second 的调用次序，不能因插话跳过 second。
		expect(executed).toEqual(["first", "second"]);

		// 筛选所有工具执行结束事件，随后检查数量和错误标志。
		const toolEnds = events.filter(
			// 类型谓词配合 Extract 从联合中提取完成事件，运行时判断仍是 type 相等。
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		// 本批必须产生两条工具结束事件，对应两个调用。
		expect(toolEnds.length).toBe(2);
		// 第一条工具结束事件应成功。
		expect(toolEnds[0].isError).toBe(false);
		// 第二条工具结束事件也应成功，插话不是工具失败原因。
		expect(toolEnds[1].isError).toBe(false);

		// Queued message should appear in events after both tool result messages
		// 把 message_start 投影为工具 id 或用户文本，以比较插话和结果的相对顺序。
		const eventSequence = events.flatMap((event) => {
			// 忽略非消息开始事件，不重复把同一消息的 end 也计入顺序。
			if (event.type !== "message_start") return [];
			// 工具结果映射成 tool:调用id，模板字符串只用于本地断言标签。
			if (event.message.role === "toolResult") return [`tool:${event.message.toolCallId}`];
			// 只保留正文为字符串的用户消息，数组形式正文不进入这份观察序列。
			if (event.message.role === "user" && typeof event.message.content === "string") {
				// 以用户文本代表消息在事件序列中的位置。
				return [event.message.content];
			}
			// 该分支没有待交付消息或投影项，返回空数组。
			return [];
		});
		// 投影的消息序列里必须包含 interrupt，否则索引比较可能误导。
		expect(eventSequence).toContain("interrupt");
		// 比较前后两项在事件序列中的索引，要求工具结果位于 interrupt 之前。
		expect(eventSequence.indexOf("tool:tool-1")).toBeLessThan(eventSequence.indexOf("interrupt"));
		// 比较前后两项在事件序列中的索引，要求工具结果位于 interrupt 之前。
		expect(eventSequence.indexOf("tool:tool-2")).toBeLessThan(eventSequence.indexOf("interrupt"));

		// Interrupt message should be in context when second LLM call is made
		// 第二次模型边界请求应能看到已经注入的 interrupt 用户文本。
		expect(sawInterruptInContext).toBe(true);
	});

	// 验证工具声明 sequential 会覆盖默认并行策略。两次调用同一慢工具，first 等门闩，second 观察 first 是否完成；20ms 后释放，检查未观测重叠及消息顺序。
	it("should force sequential execution when a tool has executionMode=sequential even with default parallel config", async () => {
		// 参数 schema 要求 value 为字符串；obj/str 还供运行时验证和可能的转换使用。
		const toolSchema = obj({ value: str() });
		// 记录 first 是否越过门闩，供 second 观察两次执行是否重叠。
		let firstResolved = false;
		// 初始未观察到重叠，second 若在 first 未完成时运行就改为 true。
		let parallelObserved = false;
		// 保存稍后释放门闩的回调；联合 undefined 表示尚未赋值，括号中的 () => void 是函数类型。
		let releaseFirst: (() => void) | undefined;
		// 创建仅用于时序同步的 Promise<void>，执行器同步得到 resolve；此 Promise 不返回业务数据。
		const firstDone = new Promise<void>((resolve) => {
			// 保存 resolve 引用，计时器之后调用它让等待 first 的执行器继续。
			releaseFirst = resolve;
		});

		// 创建慢工具的类型化本地实现；参数和详情都含字符串 value。
		const slowTool: AgentTool<typeof toolSchema, { value: string }> = {
			// 用 slow 名称匹配模型调用中的慢工具。
			name: "slow",
			// 慢工具的显示标签。
			label: "Slow",
			// 仅为该本地夹具提供说明。
			description: "Slow tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 本工具要求串行；同批出现它会让整批不走默认并行执行。
			executionMode: "sequential",
			// 本地执行器收到调用 id 和已准备/验证的参数，异步返回结果；此处忽略 id，只操作内存。
			async execute(_toolCallId, params) {
				// 只让 first 调用等待门闩，second 用作观察者。
				if (params.value === "first") {
					// 暂停当前工具执行到门闩释放，其他已启动的异步工具仍可运行。
					await firstDone;
					// first 已通过等待点，后续 second 观察时应知道它不再阻塞。
					firstResolved = true;
				}
				// 若 second 开始时 first 还未释放，则两次异步执行确有重叠。
				if (params.value === "second" && !firstResolved) {
					// 记录已观察到重叠等待，不表示两个 JavaScript 回调在不同线程执行。
					parallelObserved = true;
				}
				// 慢调用越过门闩后返回结果，串行模式下一次 execute 才会开始。
				return {
					// 把本地输入拼进工具文本结果；模板插值只生成字符串，不执行模型或真实文件操作。
					content: [{ type: "text", text: `slow: ${params.value}` }],
					// details 保存本地展示/扩展数据；并非模型可见 content 的自动副本。
					details: { value: params.value },
				};
			},
		};

		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 只有一个声明 sequential 的慢工具，可在同批中被调用多次。
			tools: [slowTool],
		};

		// 构造本次新增用户输入；它的固定文本只用于夹具，mock 回复不分析这段自然语言。
		const userPrompt: AgentMessage = createUserMessage("run both");
		// config is parallel (default), but tool forces sequential
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
		};

		// 记录当前预设响应的序号，零代表首次工具请求，后续通常返回文本结束。
		let callIndex = 0;
		// 启动该用例的 Agent 循环，最后的本地回调构造预设回复；工具和钩子使用当前配置。
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			// 创建本轮本地响应流；随后微任务把预设消息送进去。
			const mockStream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 首次本地请求发工具调用，后续走普通文本回复分支。
				if (callIndex === 0) {
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage(
						[
							// 预设调用 id=tool-1、工具 slow；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
							{ type: "toolCall", id: "tool-1", name: "slow", arguments: { value: "first" } },
							// 预设调用 id=tool-2、工具 slow；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
							{ type: "toolCall", id: "tool-2", name: "slow", arguments: { value: "second" } },
						],
						// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
						"toolUse",
					);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					mockStream.push({ type: "done", reason: "toolUse", message });
					// 约 20ms 后可选调用释放函数；?.() 只在回调已赋值时调用，计时不保证精确到点。
					setTimeout(() => releaseFirst?.(), 20);
					// 前面的首次请求条件不成立时，构造普通文本回复作为本轮收尾。
				} else {
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					mockStream.push({ type: "done", reason: "stop", message });
				}
				// 推进 mock 请求序号，确保下一次循环请求不会重复首轮工具调用。
				callIndex++;
			});
			// 交回本轮模拟流，循环随后异步迭代它。
			return mockStream;
		});

		// 创建本次运行的事件记录数组，用于随后筛选或顺序断言。
		const events: AgentEvent[] = [];
		// 按异步迭代协议逐项等待事件；循环继续直到 agent_end 让流结束。
		for await (const event of stream) {
			// 把收到的事件引用按接收顺序追加到数组，不复制其深层对象。
			events.push(event);
		}

		// With sequential execution, second tool should NOT start before first finishes
		// 核对是否观测到 second 在 first 仍等待时运行；这是本地异步重叠的结果。
		expect(parallelObserved).toBe(false);

		// 从事件流投影工具结果消息的 id，观察提交顺序而非工具完成先后。
		const toolResultIds = events.flatMap((event) => {
			// 先排除非完整消息事件，再检查消息角色；|| 短路避免访问不具有 message 的事件。
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				// 该分支没有待交付消息或投影项，返回空数组。
				return [];
			}
			// 提取这条工具结果关联的原始调用 id。
			return [event.message.toolCallId];
		});
		// 工具结果消息/回合结果应保持 first→second 的源调用次序。
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	// 验证混合工具批次含一个 sequential 声明时走串行路径。slow:a 等门闩，fast:b 只记录启动；此用例断言首个启动记录为 slow:a 且 fast:b 出现，没有单独记录 slow 完成时刻。
	it("should force sequential execution when one of multiple tools has executionMode=sequential", async () => {
		// 参数 schema 要求 value 为字符串；obj/str 还供运行时验证和可能的转换使用。
		const toolSchema = obj({ value: str() });
		// 按 execute 入口被调用的顺序记录标签，未单独记录完成事件。
		const executionOrder: string[] = [];
		// 保存 slow 的释放函数，允许赋值前为 undefined。
		let releaseSlow: (() => void) | undefined;
		// 为慢工具创建一个只传递完成信号的门闩 Promise。
		const slowDone = new Promise<void>((resolve) => {
			// 将门闩完成函数保留给稍后的计时器。
			releaseSlow = resolve;
		});

		// 创建慢工具的类型化本地实现；参数和详情都含字符串 value。
		const slowTool: AgentTool<typeof toolSchema, { value: string }> = {
			// 用 slow 名称匹配模型调用中的慢工具。
			name: "slow",
			// 慢工具的显示标签。
			label: "Slow",
			// 仅为该本地夹具提供说明。
			description: "Slow tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 本工具要求串行；同批出现它会让整批不走默认并行执行。
			executionMode: "sequential",
			// 本地执行器收到调用 id 和已准备/验证的参数，异步返回结果；此处忽略 id，只操作内存。
			async execute(_toolCallId, params) {
				// 在 slow 刚进入 execute 时记录启动标签，并非完成标签。
				executionOrder.push(`slow:${params.value}`);
				// 只阻塞输入 a 的慢调用。
				if (params.value === "a") {
					// 等待计时器释放 slow 的门闩。
					await slowDone;
				}
				// 返回慢工具的正文和详情；进入门闩等待发生在此返回之前。
				return {
					// 把本地输入拼进工具文本结果；模板插值只生成字符串，不执行模型或真实文件操作。
					content: [{ type: "text", text: `slow: ${params.value}` }],
					// details 保存本地展示/扩展数据；并非模型可见 content 的自动副本。
					details: { value: params.value },
				};
			},
		};

		// 另建不声明 executionMode 的快工具，默认可参与并行批次。
		const fastTool: AgentTool<typeof toolSchema, { value: string }> = {
			// 快工具通过 fast 名称匹配。
			name: "fast",
			// 给快工具显示用的标签。
			label: "Fast",
			// 快工具的固定说明。
			description: "Fast tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// no executionMode = defaults to parallel
			// 本地执行器收到调用 id 和已准备/验证的参数，异步返回结果；此处忽略 id，只操作内存。
			async execute(_toolCallId, params) {
				// 记录快工具进入 execute 的时刻顺序，不独立测量 slow 是否刚完成。
				executionOrder.push(`fast:${params.value}`);
				// 快工具直接返回结果，不额外等待或访问外部资源。
				return {
					// 把本地输入拼进工具文本结果；模板插值只生成字符串，不执行模型或真实文件操作。
					content: [{ type: "text", text: `fast: ${params.value}` }],
					// details 保存本地展示/扩展数据；并非模型可见 content 的自动副本。
					details: { value: params.value },
				};
			},
		};

		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 同时注册慢、快工具；其中任一个 sequential 就足以让整个批次串行。
			tools: [slowTool, fastTool],
		};

		// 构造本次新增用户输入；它的固定文本只用于夹具，mock 回复不分析这段自然语言。
		const userPrompt: AgentMessage = createUserMessage("run both");
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// parallel by default, but slowTool forces sequential
		};

		// 记录当前预设响应的序号，零代表首次工具请求，后续通常返回文本结束。
		let callIndex = 0;
		// 启动该用例的 Agent 循环，最后的本地回调构造预设回复；工具和钩子使用当前配置。
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			// 创建本轮本地响应流；随后微任务把预设消息送进去。
			const mockStream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 首次本地请求发工具调用，后续走普通文本回复分支。
				if (callIndex === 0) {
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage(
						[
							// 预设调用 id=tool-1、工具 slow；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
							{ type: "toolCall", id: "tool-1", name: "slow", arguments: { value: "a" } },
							// 预设调用 id=tool-2、工具 fast；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
							{ type: "toolCall", id: "tool-2", name: "fast", arguments: { value: "b" } },
						],
						// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
						"toolUse",
					);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					mockStream.push({ type: "done", reason: "toolUse", message });
					// 约 20ms 后释放慢工具，防止其门闩永久等待。
					setTimeout(() => releaseSlow?.(), 20);
					// 前面的首次请求条件不成立时，构造普通文本回复作为本轮收尾。
				} else {
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					mockStream.push({ type: "done", reason: "stop", message });
				}
				// 推进 mock 请求序号，确保下一次循环请求不会重复首轮工具调用。
				callIndex++;
			});
			// 交回本轮模拟流，循环随后异步迭代它。
			return mockStream;
		});

		// 创建本次运行的事件记录数组，用于随后筛选或顺序断言。
		const events: AgentEvent[] = [];
		// 按异步迭代协议逐项等待事件；循环继续直到 agent_end 让流结束。
		for await (const event of stream) {
			// 把收到的事件引用按接收顺序追加到数组，不复制其深层对象。
			events.push(event);
		}

		// Fast tool should NOT run before slow tool finishes
		// 只断言第一个 execute 入口标签为 slow:a；该断言本身不记录 slow 的完成时刻。
		expect(executionOrder[0]).toBe("slow:a");
		// 快工具 fast:b 也应进入 execute；toContain 不单独证明它何时相对 slow 完成。
		expect(executionOrder).toContain("fast:b");
	});

	// 验证全部工具明确 parallel 时可重叠等待。first 等门闩、second 记录 first 未完成，20ms 后释放；结果要求观察到重叠，只涉及本地异步任务。
	it("should allow parallel execution when all tools have executionMode=parallel", async () => {
		// 参数 schema 要求 value 为字符串；obj/str 还供运行时验证和可能的转换使用。
		const toolSchema = obj({ value: str() });
		// 记录 first 是否越过门闩，供 second 观察两次执行是否重叠。
		let firstResolved = false;
		// 初始未观察到重叠，second 若在 first 未完成时运行就改为 true。
		let parallelObserved = false;
		// 保存稍后释放门闩的回调；联合 undefined 表示尚未赋值，括号中的 () => void 是函数类型。
		let releaseFirst: (() => void) | undefined;
		// 创建仅用于时序同步的 Promise<void>，执行器同步得到 resolve；此 Promise 不返回业务数据。
		const firstDone = new Promise<void>((resolve) => {
			// 保存 resolve 引用，计时器之后调用它让等待 first 的执行器继续。
			releaseFirst = resolve;
		});

		// 工具类型把 typeof toolSchema 的参数结构与 {value:string} 详情关联；typeof 在此提取静态类型。
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			// 工具名为 echo，与模型调用块的 name 匹配。
			name: "echo",
			// 工具显示标签，和调用匹配用的 name 字段分开。
			label: "Echo",
			// 工具说明随声明投影提供给模型，不执行这段文字。
			description: "Echo tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 本工具明确允许并行；仍受整批配置或其他 sequential 工具约束。
			executionMode: "parallel",
			// 本地执行器收到调用 id 和已准备/验证的参数，异步返回结果；此处忽略 id，只操作内存。
			async execute(_toolCallId, params) {
				// 只让 first 调用等待门闩，second 用作观察者。
				if (params.value === "first") {
					// 暂停当前工具执行到门闩释放，其他已启动的异步工具仍可运行。
					await firstDone;
					// first 已通过等待点，后续 second 观察时应知道它不再阻塞。
					firstResolved = true;
				}
				// 若 second 开始时 first 还未释放，则两次异步执行确有重叠。
				if (params.value === "second" && !firstResolved) {
					// 记录已观察到重叠等待，不表示两个 JavaScript 回调在不同线程执行。
					parallelObserved = true;
				}
				// 返回本次 echo 结果，允许另一个已启动的工具等待同时存在。
				return {
					// 把本地输入拼进工具文本结果；模板插值只生成字符串，不执行模型或真实文件操作。
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					// details 保存本地展示/扩展数据；并非模型可见 content 的自动副本。
					details: { value: params.value },
				};
			},
		};

		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 把本地 tool 放进可执行工具列表，循环按名字匹配它。
			tools: [tool],
		};

		// 构造本次新增用户输入；它的固定文本只用于夹具，mock 回复不分析这段自然语言。
		const userPrompt: AgentMessage = createUserMessage("echo both");
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
		};

		// 记录当前预设响应的序号，零代表首次工具请求，后续通常返回文本结束。
		let callIndex = 0;
		// 启动该用例的 Agent 循环，最后的本地回调构造预设回复；工具和钩子使用当前配置。
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			// 创建本轮本地响应流；随后微任务把预设消息送进去。
			const mockStream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 首次本地请求发工具调用，后续走普通文本回复分支。
				if (callIndex === 0) {
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage(
						[
							// 预设调用 id=tool-1、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							// 预设调用 id=tool-2、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
						"toolUse",
					);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					mockStream.push({ type: "done", reason: "toolUse", message });
					// 约 20ms 后可选调用释放函数；?.() 只在回调已赋值时调用，计时不保证精确到点。
					setTimeout(() => releaseFirst?.(), 20);
					// 前面的首次请求条件不成立时，构造普通文本回复作为本轮收尾。
				} else {
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					mockStream.push({ type: "done", reason: "stop", message });
				}
				// 推进 mock 请求序号，确保下一次循环请求不会重复首轮工具调用。
				callIndex++;
			});
			// 交回本轮模拟流，循环随后异步迭代它。
			return mockStream;
		});

		// 创建本次运行的事件记录数组，用于随后筛选或顺序断言。
		const events: AgentEvent[] = [];
		// 按异步迭代协议逐项等待事件；循环继续直到 agent_end 让流结束。
		for await (const event of stream) {
			// 把收到的事件引用按接收顺序追加到数组，不复制其深层对象。
			events.push(event);
		}

		// With executionMode=parallel, second tool should start before first finishes
		// 核对是否观测到 second 在 first 仍等待时运行；这是本地异步重叠的结果。
		expect(parallelObserved).toBe(true);
	});

	// 验证 finishTurn 位于工具结果 message_end 之后、turn_end 之前。echo 返回 terminate:true 避免自动续轮，事件接收器与钩子共同记顺序；例最后三项为工具结果、finishTurn、turn_end。
	it("runs finishTurn after tool-result messages and before turn_end", async () => {
		// 参数 schema 要求 value 为字符串；obj/str 还供运行时验证和可能的转换使用。
		const toolSchema = obj({ value: str() });
		// 工具类型把 typeof toolSchema 的参数结构与 {value:string} 详情关联；typeof 在此提取静态类型。
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			// 工具名为 echo，与模型调用块的 name 匹配。
			name: "echo",
			// 工具显示标签，和调用匹配用的 name 字段分开。
			label: "Echo",
			// 工具说明随声明投影提供给模型，不执行这段文字。
			description: "Echo tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 本地执行器收到调用 id 和已准备/验证的参数，异步返回结果；此处忽略 id，只操作内存。
			async execute(_toolCallId, params) {
				// 返回正常工具结果并附 terminate:true，让本轮收尾后无需再模拟一次文本请求。
				return {
					// 最终模型可见内容使用已验证参数的文字。
					content: [{ type: "text", text: params.value }],
					// details 保存本地展示/扩展数据；并非模型可见 content 的自动副本。
					details: { value: params.value },
					// 该结果要求停止工具批次后的自动续轮；只有本批所有最终结果都为 true 才生效。
					terminate: true,
				};
			},
		};
		// 把钩子和特定事件按发生次序记为字符串，用于顺序断言。
		const ordering: string[] = [];
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// 回合收尾钩子得到已提交的上下文与结果，同步断言并记录顺序，隐式返回 undefined。
			finishTurn: ({ context, toolResults }) => {
				// 标记 finishTurn 已开始，用于和消息/回合事件比较。
				ordering.push("finishTurn");
				// 收尾钩子应拿到本轮唯一一个工具结果。
				expect(toolResults).toHaveLength(1);
				// 调用 finishTurn 时，上下文最后一条消息已经是工具结果；at(-1) 从数组末尾取值。
				expect(context.messages.at(-1)?.role).toBe("toolResult");
			},
		};

		// 直接 await 低层执行函数，并传事件接收器；区别于返回 EventStream 的包装入口。
		await runAgentLoop(
			// 发起一个 echo 用户输入，实际模型内容由最后的本地回调决定。
			[createUserMessage("echo")],
			// 传入空历史和可执行本地工具；循环可能补充工具声明 system 消息。
			{ messages: [], tools: [tool] },
			// 传入本用例的模型、转换和钩子配置。
			config,
			// 事件接收器按事件标签同步收集顺序或已完成消息，不发送外部通知。
			(event) => {
				// 仅完整消息结束时记录其角色标签，工具结果应出现在 finishTurn 之前。
				if (event.type === "message_end") ordering.push(`message_end:${event.message.role}`);
				// 记录回合结束事件，随后与 finishTurn 的位置作比较。
				if (event.type === "turn_end") ordering.push("turn_end");
			},
			// 此位置不提供取消信号；具体参数含义按当前调用签名区分。
			undefined,
			// 无参数本地流回调，每次调用构造预设助手结果，不使用真实供应商。
			() => {
				// 新建一条纯内存助手事件流，保存事件队列及最终结果 Promise。
				const stream = createAssistantMessageEventStream();
				// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
				queueMicrotask(() => {
					// 把下面构造的事件交给本地流；done/error 会同时确定最终消息。
					stream.push({
						// 正常终止事件；循环仍会依据其 message.stopReason 判断是否执行工具或退出。
						type: "done",
						// 事件原因标记工具请求，助手消息也必须携带相应调用及 stopReason。
						reason: "toolUse",
						// 在终止事件里直接放入完整助手夹具；循环可通过 result() 取到它。
						message: createAssistantMessage(
							// 预设调用 id=tool-1、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
							[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
							// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
							"toolUse",
						),
					});
				});
				// 把刚创建的本地流交回调用方；最终消息由稍后的微任务提供。
				return stream;
			},
		);

		// 只比较最后三项：工具结果完整消息先发布，再运行 finishTurn，最后发布 turn_end。
		expect(ordering.slice(-3)).toEqual(["message_end:toolResult", "finishTurn", "turn_end"]);
	});

	// 分别验证 error/aborted 两种硬退出：本地错误流结束后仍调用 finishTurn，但其 continue 决策不能触发下一请求。检查一轮请求、一次启动插话检查、零 follow-up 查询及收尾顺序。as const 保留字面量类型，不冻结数组。
	it.each(["error", "aborted"] as const)(
		// 参数化测试标题中的 %s 会替换为当前原因；下面异步回调每次只接收一个 error/aborted 字面量。
		"runs finishTurn for a %s assistant before turn_end without changing the hard exit",
		// 每个参数化异步用例先记录顺序与查询次数，再注入对应错误流并检查硬退出不被 continue 覆盖。
		async (reason) => {
			// 把钩子和特定事件按发生次序记为字符串，用于顺序断言。
			const ordering: string[] = [];
			// 记录本地请求函数调用次数；名称不表示访问了真实 provider。
			let providerCalls = 0;
			// 统计循环实际调用 steering 读取器的次数，包括启动检查。
			let steeringPolls = 0;
			// 统计自然停止处 follow-up 读取器的调用次数。
			let followUpPolls = 0;
			// 直接 await 低层执行函数，并传事件接收器；区别于返回 EventStream 的包装入口。
			await runAgentLoop(
				// 发送固定 run 输入，让本地错误响应走一次完整回合。
				[createUserMessage("run")],
				// 空历史和空工具的初始上下文，没有真实工具能力。
				{ messages: [], tools: [] },
				{
					// 每次创建一份 mock 元数据，不调用模型服务。
					model: createModel(),
					// 请求前调用前述角色筛选器，保留标准消息。
					convertToLlm: identityConverter,
					// finishTurn 接收完成的助手消息，记录顺序后故意请求 continue，验证硬退出优先。
					finishTurn: ({ message }) => {
						// 收尾钩子看到的消息 stopReason 应等于当前参数 error 或 aborted。
						expect(message.stopReason).toBe(reason);
						// 标记 finishTurn 已开始，用于和消息/回合事件比较。
						ordering.push("finishTurn");
						// 故意请求继续；当前消息是 error/aborted，硬退出必须优先于此决策。
						return { action: "continue" };
					},
					// 异步队列读取器无输入，按当前记录返回待交付消息，并更新本地交付状态。
					getSteeringMessages: async () => {
						// 记录一次插话队列查询，用于检查 end/硬退出的调度边界。
						steeringPolls++;
						// 该分支没有待交付消息或投影项，返回空数组。
						return [];
					},
					// 无输入异步追问读取器，按本用例状态返回排队消息或空数组。
					getFollowUpMessages: async () => {
						// 记录一次追问队列查询。
						followUpPolls++;
						// 创建待交付的追问；如果调度错误地查询它，就可能触发不该有的下一轮。
						return [createUserMessage("queued")];
					},
				},
				// 事件接收器按事件标签同步收集顺序或已完成消息，不发送外部通知。
				(event) => {
					// 记录回合结束事件，随后与 finishTurn 的位置作比较。
					if (event.type === "turn_end") ordering.push("turn_end");
				},
				// 此位置不提供取消信号；具体参数含义按当前调用签名区分。
				undefined,
				// 无参数本地流回调，每次调用构造预设助手结果，不使用真实供应商。
				() => {
					// 每次进入本地 StreamFn 都递增请求计数。
					providerCalls++;
					// 新建一条纯内存助手事件流，保存事件队列及最终结果 Promise。
					const stream = createAssistantMessageEventStream();
					// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
					queueMicrotask(() => {
						// 把下面构造的事件交给本地流；done/error 会同时确定最终消息。
						stream.push({
							// 用协议错误终止事件携带完整错误助手消息；最终结果 Promise 本身仍可 resolve。
							type: "error",
							// 属性简写，填入当前参数化用例的 error 或 aborted 原因。
							reason,
							// 错误事件里的 error 是完整助手消息对象，不是直接 throw 的 Error。
							error: {
								// 展开基础助手夹具并把其 stopReason 设为当前错误原因，确保低层按硬退出处理。
								...createAssistantMessage([], reason),
								// 给错误消息填入对应字符串，供展示而非抛出异常。
								errorMessage: reason,
							},
						});
					});
					// 把刚创建的本地流交回调用方；最终消息由稍后的微任务提供。
					return stream;
				},
			);

			// 错误回合的可观察收尾顺序为 finishTurn 然后 turn_end。
			expect(ordering).toEqual(["finishTurn", "turn_end"]);
			// 硬退出只允许一次 mock 请求，continue 决策不能再请求模型。
			expect(providerCalls).toBe(1);
			// 仅执行启动时的那次 steering 查询，错误回合后不再轮询。
			expect(steeringPolls).toBe(1);
			// 硬退出不会进入自然停止处的 follow-up 查询。
			expect(followUpPolls).toBe(0);
		},
	);

	// 验证 finishTurn 返回 end 后不轮询队列，也不准备下一轮。mock 发 noop 调用，工具正常完成，再结束当前运行；启动时已有一次 steering 查询，所以最终断言为 1 而非 0。
	it("action:end skips queue polling and next-turn preparation", async () => {
		// 定义空对象参数 schema，本用例使用无业务输入的 noop。
		const toolSchema = obj({});
		// 该工具参数来自空对象 schema，详情类型明确为 undefined。
		const tool: AgentTool<typeof toolSchema, undefined> = {
			// noop 仅返回固定结果，没有真实外部动作。
			name: "noop",
			// 空操作工具的显示标签。
			label: "Noop",
			// 固定工具说明。
			description: "Noop tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 无参数本地执行器返回固定结果；async 让返回对象包装为 Promise。
			async execute() {
				// 返回完成文本且没有详情，不进行 IO。
				return { content: [{ type: "text", text: "done" }], details: undefined };
			},
		};
		// 记录本地请求函数调用次数；名称不表示访问了真实 provider。
		let providerCalls = 0;
		// 统计循环实际调用 steering 读取器的次数，包括启动检查。
		let steeringPolls = 0;
		// 统计自然停止处 follow-up 读取器的调用次数。
		let followUpPolls = 0;
		// 记录下一轮准备钩子的执行次数，用来证明 end 没有进入后续准备。
		let prepareNextTurnCalls = 0;
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// 零参回调直接返回 end 决策对象；箭头后的括号让花括号作为对象表达式。
			finishTurn: () => ({ action: "end" }),
			// 下一轮准备回调只计数并不替换状态，end 路径不应调用它。
			prepareNextTurn: () => {
				// 每进入一次下一轮准备回调就计数。
				prepareNextTurnCalls++;
				// 此钩子不提供覆盖或阻止决策，调用方沿用当前状态。
				return undefined;
			},
			// 异步队列读取器无输入，按当前记录返回待交付消息，并更新本地交付状态。
			getSteeringMessages: async () => {
				// 记录一次插话队列查询，用于检查 end/硬退出的调度边界。
				steeringPolls++;
				// 该分支没有待交付消息或投影项，返回空数组。
				return [];
			},
			// 无输入异步追问读取器，按本用例状态返回排队消息或空数组。
			getFollowUpMessages: async () => {
				// 记录一次追问队列查询。
				followUpPolls++;
				// 创建待交付的追问；如果调度错误地查询它，就可能触发不该有的下一轮。
				return [createUserMessage("queued")];
			},
		};

		// 启动该用例的 Agent 循环，最后的本地回调构造预设回复；工具和钩子使用当前配置。
		const stream = agentLoop([createUserMessage("run")], { messages: [], tools: [tool] }, config, undefined, () => {
			// 每次进入本地 StreamFn 都递增请求计数。
			providerCalls++;
			// 为当前模拟请求创建独立助手事件流，无网络连接。
			const response = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 发布本次 mock 的预设终止事件，供循环消费并取得最终结果。
				response.push({
					// 正常终止事件；循环仍会依据其 message.stopReason 判断是否执行工具或退出。
					type: "done",
					// 事件原因标记工具请求，助手消息也必须携带相应调用及 stopReason。
					reason: "toolUse",
					// 在终止事件里直接放入完整助手夹具；循环可通过 result() 取到它。
					message: createAssistantMessage(
						// 本次助手消息要求调用 noop；真正终止由随后 finishTurn 的 end 决策控制。
						[{ type: "toolCall", id: "tool-1", name: "noop", arguments: {} }],
						// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
						"toolUse",
					),
				});
			});
			// 返回这次 mock 响应流，不等待其中消息被消费。
			return response;
		});
		// 只等待本次 Agent 运行的最终新增消息，不需要逐个读取事件才能驱动生产者。
		await stream.result();

		// end 决策使单次工具请求后不再进入第二个 mock 请求。
		expect(providerCalls).toBe(1);
		// steering 仍有启动阶段的一次查询；end 只阻止回合后的查询。
		expect(steeringPolls).toBe(1);
		// end 决策应使追问读取器一次都不被调用。
		expect(followUpPolls).toBe(0);
		// 既然 end 已经结束运行，就不应调用下一轮准备回调。
		expect(prepareNextTurnCalls).toBe(0);
	});

	// 验证没有自然续轮理由时 continue 决策补一次上下文请求。首轮 finishTurn 要求继续，第二轮返回 undefined；两次纯文本本地请求共调用钩子两次，不额外加入用户消息。
	it("makes exactly one context-only request when no natural request satisfies continuation", async () => {
		// 记录本地请求函数调用次数；名称不表示访问了真实 provider。
		let providerCalls = 0;
		// 累计 finishTurn 被调用次数，首轮与后续轮采用不同决策。
		let finishCalls = 0;
		// 启动被测 Agent 运行；参数依次为新消息、上下文、配置、取消信号及本地流函数。
		const stream = agentLoop(
			// 初始输入为 run，后续额外请求应复用已有上下文，不再伪造新用户输入。
			[createUserMessage("run")],
			// 空历史和空工具的初始上下文，没有真实工具能力。
			{ messages: [], tools: [] },
			{
				// 每次创建一份 mock 元数据，不调用模型服务。
				model: createModel(),
				// 请求前调用前述角色筛选器，保留标准消息。
				convertToLlm: identityConverter,
				// 无输入收尾回调借助闭包计数，首轮请求继续，随后恢复自然调度。
				finishTurn: () => {
					// 先递增回合收尾次数，再以此选择决策。
					finishCalls++;
					// 只在首轮要求至少一个后续请求，其他回合返回 undefined。
					return finishCalls === 1 ? { action: "continue" } : undefined;
				},
			},
			// 此位置不提供取消信号；具体参数含义按当前调用签名区分。
			undefined,
			// 无参数本地流回调，每次调用构造预设助手结果，不使用真实供应商。
			() => {
				// 每次进入本地 StreamFn 都递增请求计数。
				providerCalls++;
				// 为当前模拟请求创建独立助手事件流，无网络连接。
				const response = createAssistantMessageEventStream();
				// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
				queueMicrotask(() => {
					// 发布本次 mock 的预设终止事件，供循环消费并取得最终结果。
					response.push({
						// 正常终止事件；循环仍会依据其 message.stopReason 判断是否执行工具或退出。
						type: "done",
						// 该事件声明正常停止，和下面助手夹具的默认 stop 对应。
						reason: "stop",
						// 在终止事件里直接放入完整助手夹具；循环可通过 result() 取到它。
						message: createAssistantMessage([{ type: "text", text: `response ${providerCalls}` }]),
					});
				});
				// 返回这次 mock 响应流，不等待其中消息被消费。
				return response;
			},
		);
		// 只等待本次 Agent 运行的最终新增消息，不需要逐个读取事件才能驱动生产者。
		await stream.result();

		// 首轮 continue 应只补一轮上下文请求，总计两次，而非无穷续轮。
		expect(providerCalls).toBe(2);
		// 两次请求各完成一个回合，因此 finishTurn 正好调用两次。
		expect(finishCalls).toBe(2);
	});

	// 验证工具结果所需的自然下一请求可兑现 continue，不重复补第三次请求。第一次 noop 工具调用，第二次文本完成；检查请求和 finishTurn 各两次。
	it("lets a natural tool-result request satisfy continuation", async () => {
		// 定义空对象参数 schema，本用例使用无业务输入的 noop。
		const toolSchema = obj({});
		// 该工具参数来自空对象 schema，详情类型明确为 undefined。
		const tool: AgentTool<typeof toolSchema, undefined> = {
			// noop 仅返回固定结果，没有真实外部动作。
			name: "noop",
			// 空操作工具的显示标签。
			label: "Noop",
			// 固定工具说明。
			description: "Noop tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 无参数本地执行器返回固定结果；async 让返回对象包装为 Promise。
			async execute() {
				// 返回完成文本且没有详情，不进行 IO。
				return { content: [{ type: "text", text: "done" }], details: undefined };
			},
		};
		// 记录本地请求函数调用次数；名称不表示访问了真实 provider。
		let providerCalls = 0;
		// 累计 finishTurn 被调用次数，首轮与后续轮采用不同决策。
		let finishCalls = 0;
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// 无输入收尾回调借助闭包计数，首轮请求继续，随后恢复自然调度。
			finishTurn: () => {
				// 先递增回合收尾次数，再以此选择决策。
				finishCalls++;
				// 只在首轮要求至少一个后续请求，其他回合返回 undefined。
				return finishCalls === 1 ? { action: "continue" } : undefined;
			},
		};

		// 启动该用例的 Agent 循环，最后的本地回调构造预设回复；工具和钩子使用当前配置。
		const stream = agentLoop([createUserMessage("run")], { messages: [], tools: [tool] }, config, undefined, () => {
			// 每次进入本地 StreamFn 都递增请求计数。
			providerCalls++;
			// 为当前模拟请求创建独立助手事件流，无网络连接。
			const response = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 准备由后续条件表达式选择的一条完整助手消息。
				const message =
					// 按递增后的请求计数区分首次工具调用与第二次最终文本。
					providerCalls === 1
						? // 三元表达式的真分支构造首轮工具调用消息，并把 stopReason 设为 toolUse。
							createAssistantMessage(
								[{ type: "toolCall", id: "tool-1", name: "noop", arguments: {} }],
								"toolUse",
							)
						: // 三元表达式的假分支构造正常 stop 文本回复，用于收尾或暴露不应发生的续轮。
							createAssistantMessage([{ type: "text", text: "done" }]);
				// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
				response.push({ type: "done", reason: providerCalls === 1 ? "toolUse" : "stop", message });
			});
			// 返回这次 mock 响应流，不等待其中消息被消费。
			return response;
		});
		// 只等待本次 Agent 运行的最终新增消息，不需要逐个读取事件才能驱动生产者。
		await stream.result();

		// 工具结果的自然续轮已满足 continue，总请求数仍是两次。
		expect(providerCalls).toBe(2);
		// 工具回合与收尾文本各调用一次 finishTurn。
		expect(finishCalls).toBe(2);
	});

	// 分别用 steering 与 follow-up 验证自然队列请求能兑现 continue。首轮结束仅交付一次排队消息，第二次 mock 检查用户文本；要求共两次请求，而非再额外空转一轮。
	it.each(["steering", "follow-up"] as const)("lets a natural %s request satisfy continuation", async (queueKind) => {
		// 用当前 queueKind 创建排队消息；文字与该参数一致，以便第二次请求检查。
		const queuedMessage = createUserMessage(queueKind);
		// 记录本地请求函数调用次数；名称不表示访问了真实 provider。
		let providerCalls = 0;
		// 累计 finishTurn 被调用次数，首轮与后续轮采用不同决策。
		let finishCalls = 0;
		// 统计循环实际调用 steering 读取器的次数，包括启动检查。
		let steeringPolls = 0;
		// 保证 follow-up 夹具仅交付一次，避免重复排队。
		let followUpDelivered = false;
		// 记录第二次模型边界请求中用户文本，检查队列输入确实进入上下文。
		const secondRequestUsers: string[] = [];
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// 无输入收尾回调借助闭包计数，首轮请求继续，随后恢复自然调度。
			finishTurn: () => {
				// 先递增回合收尾次数，再以此选择决策。
				finishCalls++;
				// 只在首轮要求至少一个后续请求，其他回合返回 undefined。
				return finishCalls === 1 ? { action: "continue" } : undefined;
			},
			// 异步队列读取器无输入，按当前记录返回待交付消息，并更新本地交付状态。
			getSteeringMessages: async () => {
				// 记录一次插话队列查询，用于检查 end/硬退出的调度边界。
				steeringPolls++;
				// 仅 steering 分支在第二次查询交付一次，启动查询返回空。
				return queueKind === "steering" && steeringPolls === 2 ? [queuedMessage] : [];
			},
			// 无输入异步追问读取器，按本用例状态返回排队消息或空数组。
			getFollowUpMessages: async () => {
				// 非 follow-up 参数或已交付时不再返回追问。
				if (queueKind !== "follow-up" || followUpDelivered) return [];
				// 标记追问已从这份假队列中取走。
				followUpDelivered = true;
				// 把当前参数对应的那条排队用户消息交给循环。
				return [queuedMessage];
			},
		};

		// 启动被测 Agent 运行；参数依次为新消息、上下文、配置、取消信号及本地流函数。
		const stream = agentLoop(
			// 发送初始 run 用户消息；排队的 steering/follow-up 由各读取钩子另行交付。
			[createUserMessage("run")],
			// 空历史和空工具的初始上下文，没有真实工具能力。
			{ messages: [], tools: [] },
			// 传入本用例的模型、转换和钩子配置。
			config,
			// 此位置不提供取消信号；具体参数含义按当前调用签名区分。
			undefined,
			// 本地 StreamFn 接收模型上下文，忽略模型参数并记录目标轮的消息。
			(_model, context) => {
				// 每次进入本地 StreamFn 都递增请求计数。
				providerCalls++;
				// 只在第二个请求观察 queued 消息是否进入模型边界。
				if (providerCalls === 2) {
					// 将本次上下文筛选出的用户文本展开追加到观察数组。
					secondRequestUsers.push(
						// 先用 flatMap 提取用户字符串正文，再用 ... 把每项作为 push 的独立参数。
						...context.messages.flatMap((message) =>
							// 用户且正文是字符串才产生一项，其他消息产生空数组。
							message.role === "user" && typeof message.content === "string" ? [message.content] : [],
						),
					);
				}
				// 为当前模拟请求创建独立助手事件流，无网络连接。
				const response = createAssistantMessageEventStream();
				// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
				queueMicrotask(() => {
					// 发布本次 mock 的预设终止事件，供循环消费并取得最终结果。
					response.push({
						// 正常终止事件；循环仍会依据其 message.stopReason 判断是否执行工具或退出。
						type: "done",
						// 该事件声明正常停止，和下面助手夹具的默认 stop 对应。
						reason: "stop",
						// 在终止事件里直接放入完整助手夹具；循环可通过 result() 取到它。
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				});
				// 返回这次 mock 响应流，不等待其中消息被消费。
				return response;
			},
		);
		// 只等待本次 Agent 运行的最终新增消息，不需要逐个读取事件才能驱动生产者。
		await stream.result();

		// 一条排队输入的自然续轮已经兑现 continue，不能额外补第三次请求。
		expect(providerCalls).toBe(2);
		// 两次请求各执行一次 finishTurn。
		expect(finishCalls).toBe(2);
		// 第二个请求必须包含当前参数对应的 steering 或 follow-up 文本。
		expect(secondRequestUsers).toContain(queueKind);
	});

	// 验证首轮 prepareRequest 在排队消息发布后执行，并能替换上下文、模型和思考级别。先注入 steering，再用 canonical projection 替换请求历史；mock 检查 replacement/high，不代表该模型元数据真的支持 high。
	it("prepares the initial request after pending messages and can replace request state", async () => {
		// 浅展开 mock 元数据并覆盖 id/name，之后用引用相等检查是否真的换用此对象。
		const replacementModel = { ...createModel(), id: "replacement", name: "replacement" };
		// 构造请求投影替换后的唯一用户消息，不等同于改写持久会话。
		const canonicalMessage = createUserMessage("canonical projection");
		// 构造启动阶段将交付的一条插话。
		const steeringMessage = createUserMessage("steering");
		// 收集 message_end 已经发布过的消息引用，供 prepareRequest 检查时机。
		const completedMessages: AgentMessage[] = [];
		// 启动插话只允许返回一次。
		let steeringDelivered = false;
		// 统计当前准备钩子调用次数；具体是 prepareRequest 或 prepareNextTurn 由本用例确定。
		let prepareCalls = 0;
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// 异步队列读取器无输入，按当前记录返回待交付消息，并更新本地交付状态。
			getSteeringMessages: async () => {
				// 插话已经交付后，后续查询返回空，避免多次请求。
				if (steeringDelivered) return [];
				// 标记启动插话已经取出。
				steeringDelivered = true;
				// 把预建的 steering 消息作为这次读取结果。
				return [steeringMessage];
			},
			// 请求准备钩子接收当前上下文，检查已发布的消息，再返回请求状态覆盖；第一轮也会调用。
			prepareRequest: ({ context }) => {
				// 记录本次准备钩子调用，后续与预期轮次数比较。
				prepareCalls++;
				// prepareRequest 运行时，事件接收器已经看到 steering 的 message_end。
				expect(completedMessages).toContain(steeringMessage);
				// 同一时刻当前历史也应已经追加这条 steering 消息对象。
				expect(context.messages).toContain(steeringMessage);
				// 返回请求快照覆盖；替换上下文、模型和思考级别，不重新发布 canonical 消息的事件。
				return {
					// 浅复制请求上下文，只把 messages 替换为规范投影；其他字段仍复用。
					context: { ...context, messages: [canonicalMessage] },
					// 把后续请求使用的模型对象替换为上面这份指定对象。
					model: replacementModel,
					// 请求准备返回 high，循环会映射到 StreamFn 的 reasoning；此处不验证模型能力。
					thinkingLevel: "high",
				};
			},
		};

		// 直接 await 低层执行函数，并传事件接收器；区别于返回 EventStream 的包装入口。
		await runAgentLoop(
			// 本次用户输入为 prompt；请求前还会追加启动 steering。
			[createUserMessage("prompt")],
			// 空历史和空工具的初始上下文，没有真实工具能力。
			{ messages: [], tools: [] },
			// 传入本用例的模型、转换和钩子配置。
			config,
			// 事件接收器按事件标签同步收集顺序或已完成消息，不发送外部通知。
			(event) => {
				// 只记录已发布完成事件的消息，以检查 prepareRequest 之前已经发布 steering。
				if (event.type === "message_end") completedMessages.push(event.message);
			},
			// 此位置不提供取消信号；具体参数含义按当前调用签名区分。
			undefined,
			// 本地请求回调检查最终模型对象、请求历史与推导出的 reasoning，再返回固定 done 流。
			(model, context, options) => {
				// 最终传给本地 StreamFn 的模型必须是 replacementModel 本身，而非原 mock 对象。
				expect(model).toBe(replacementModel);
				// 最终请求历史应完全替换为 canonicalMessage 这一条，而非追加在 prompt 后面。
				expect(context.messages).toEqual([canonicalMessage]);
				// 准备回调的 thinkingLevel:high 应映射到流选项 reasoning:high；可选链兼顾选项缺失。
				expect(options?.reasoning).toBe("high");
				// 为当前模拟请求创建独立助手事件流，无网络连接。
				const response = createAssistantMessageEventStream();
				// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
				queueMicrotask(() => {
					// 发布本次 mock 的预设终止事件，供循环消费并取得最终结果。
					response.push({
						// 正常终止事件；循环仍会依据其 message.stopReason 判断是否执行工具或退出。
						type: "done",
						// 该事件声明正常停止，和下面助手夹具的默认 stop 对应。
						reason: "stop",
						// 在终止事件里直接放入完整助手夹具；循环可通过 result() 取到它。
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				});
				// 返回这次 mock 响应流，不等待其中消息被消费。
				return response;
			},
		);

		// 只有首轮请求，因此 prepareRequest 调用一次。
		expect(prepareCalls).toBe(1);
	});

	// 验证 prepareRequest 之后不会立刻再次取 steering。第一轮准备时入队 late steering，首次 mock 看不到，轮后查询才交付给第二次请求；记录两次准备和三次队列查询。
	it("does not poll steering after prepareRequest", async () => {
		// 用普通数组作为可控插话队列；push 入队，splice(0) 取走全部项。
		const queued: AgentMessage[] = [];
		// 预建准备回调期间才入队的消息，用对象引用观察是否进入请求。
		const lateSteering = createUserMessage("late steering");
		// 按请求顺序记录是否包含 lateSteering，之后比较 false/true。
		const requestIncludedSteering: boolean[] = [];
		// 记录 prepareRequest 执行次数，以便只在第一轮制造新插话。
		let requestPreparations = 0;
		// 统计循环实际调用 steering 读取器的次数，包括启动检查。
		let steeringPolls = 0;
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// 异步队列读取器无输入，按当前记录返回待交付消息，并更新本地交付状态。
			getSteeringMessages: async () => {
				// 记录一次插话队列查询，用于检查 end/硬退出的调度边界。
				steeringPolls++;
				// 从下标零起删除并返回全部排队消息；会修改假队列而非浅复制观察。
				return queued.splice(0);
			},
			// 请求准备回调只操作本地计数/队列，不返回状态覆盖。
			prepareRequest: () => {
				// 增加准备次数，首轮才进行下一行入队动作。
				requestPreparations++;
				// 只在首次请求准备期间排入插话，测试准备后不重新立即轮询的边界。
				if (requestPreparations === 1) queued.push(lateSteering);
			},
		};

		// 启动被测 Agent 运行；参数依次为新消息、上下文、配置、取消信号及本地流函数。
		const stream = agentLoop(
			// 初始用户输入为 run，插话将在 prepareRequest 内才入队。
			[createUserMessage("run")],
			// 空历史和空工具的初始上下文，没有真实工具能力。
			{ messages: [], tools: [] },
			// 传入本用例的模型、转换和钩子配置。
			config,
			// 此位置不提供取消信号；具体参数含义按当前调用签名区分。
			undefined,
			// 本地 StreamFn 接收模型上下文，忽略模型参数并记录目标轮的消息。
			(_model, context) => {
				// 按对象引用检查当前请求是否含这条新插话，记录为布尔值。
				requestIncludedSteering.push(context.messages.includes(lateSteering));
				// 为当前模拟请求创建独立助手事件流，无网络连接。
				const response = createAssistantMessageEventStream();
				// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
				queueMicrotask(() => {
					// 发布本次 mock 的预设终止事件，供循环消费并取得最终结果。
					response.push({
						// 正常终止事件；循环仍会依据其 message.stopReason 判断是否执行工具或退出。
						type: "done",
						// 该事件声明正常停止，和下面助手夹具的默认 stop 对应。
						reason: "stop",
						// 在终止事件里直接放入完整助手夹具；循环可通过 result() 取到它。
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				});
				// 返回这次 mock 响应流，不等待其中消息被消费。
				return response;
			},
		);
		// 只等待本次 Agent 运行的最终新增消息，不需要逐个读取事件才能驱动生产者。
		await stream.result();

		// 精确检查首个请求不含新插话，下一请求才包含它。
		expect(requestIncludedSteering).toEqual([false, true]);
		// 两次本地模型请求应分别调用一次 prepareRequest，共两次。
		expect(requestPreparations).toBe(2);
		// Startup, post-turn delivery, then the final natural-stop check.
		// steering 查询为启动、首轮后交付、最终自然停止前检查，共三次。
		expect(steeringPolls).toBe(3);
	});

	// 验证 prepareNextTurn 返回的上下文快照及附加消息用于工具后的下一请求。第一次 echo，准备回调仅首次补 system guidance，第二次 mock 记录是否存在；只做消息数组浅复制。
	it("should use prepareNextTurn snapshot before continuing", async () => {
		// 参数 schema 要求 value 为字符串；obj/str 还供运行时验证和可能的转换使用。
		const toolSchema = obj({ value: str() });
		// 工具类型把 typeof toolSchema 的参数结构与 {value:string} 详情关联；typeof 在此提取静态类型。
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			// 工具名为 echo，与模型调用块的 name 匹配。
			name: "echo",
			// 工具显示标签，和调用匹配用的 name 字段分开。
			label: "Echo",
			// 工具说明随声明投影提供给模型，不执行这段文字。
			description: "Echo tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 本地执行器收到调用 id 和已准备/验证的参数，异步返回结果；此处忽略 id，只操作内存。
			async execute(_toolCallId, params) {
				// 返回首轮 echo 结果，让循环自然进入下一回合准备。
				return {
					// 把本地输入拼进工具文本结果；模板插值只生成字符串，不执行模型或真实文件操作。
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					// details 保存本地展示/扩展数据；并非模型可见 content 的自动副本。
					details: { value: params.value },
				};
			},
		};
		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 把本地 tool 放进可执行工具列表，循环按名字匹配它。
			tools: [tool],
		};
		// 记录第二轮模型请求是否已经包含准备回调追加的 system guidance。
		let convertedSecondTurnHasUpdate = false;
		// 统计当前准备钩子调用次数；具体是 prepareRequest 或 prepareNextTurn 由本用例确定。
		let prepareCalls = 0;
		// 防止 prepareNextTurn 在多次调用时反复注入相同系统消息。
		let prepared = false;
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// 异步下一轮准备钩子把传入 context 重命名为 currentContext，返回浅快照与待追加消息。
			prepareNextTurn: async ({ context: currentContext }) => {
				// 记录本次准备钩子调用，后续与预期轮次数比较。
				prepareCalls++;
				// 已经准备过就不再更新，避免重复注入 guidance。
				if (prepared) return undefined;
				// 标记首次快照已经生成。
				prepared = true;
				// 返回下一回合快照及额外系统消息；新消息由循环正常发布后才请求模型。
				return {
					// 返回给循环的上下文替换对象，下面单独设消息与工具引用。
					context: {
						// 浅复制消息数组，保留各消息对象；不是递归快照或不可变副本。
						messages: currentContext.messages.slice(),
						// 复用当前工具数组引用，保留下一轮的可执行能力。
						tools: currentContext.tools,
					},
					// 另行返回待追加的系统消息；循环会按正常 start/end 生命周期发布。
					messages: [{ role: "system", content: "updated guidance", timestamp: 1 }],
				};
			},
		};

		// 统计本地模拟请求次数，不实际计量供应商请求。
		let llmCalls = 0;
		// 启动该用例的 Agent 循环，最后的本地回调构造预设回复；工具和钩子使用当前配置。
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, (_model, ctx) => {
			// 每次进入本地流回调记一次请求。
			llmCalls++;
			// 只在工具后的第二次请求观察准备产生的系统消息。
			if (llmCalls === 2) {
				// 检查模型边界的标准消息中至少有一条更新 guidance。
				convertedSecondTurnHasUpdate = ctx.messages.some(
					// 同时要求 system 角色与固定正文，排除其他系统声明消息。
					(message) => message.role === "system" && message.content === "updated guidance",
				);
			}
			// 创建本轮本地响应流；随后微任务把预设消息送进去。
			const mockStream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 首轮返回工具调用，后续轮按本用例需要返回文本或不应执行的分支。
				if (llmCalls === 1) {
					// 向本地响应流写入事件，不向真实服务发送数据。
					mockStream.push({
						// 正常终止事件；循环仍会依据其 message.stopReason 判断是否执行工具或退出。
						type: "done",
						// 事件原因标记工具请求，助手消息也必须携带相应调用及 stopReason。
						reason: "toolUse",
						// 在终止事件里直接放入完整助手夹具；循环可通过 result() 取到它。
						message: createAssistantMessage(
							// 预设调用 id=tool-1、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
							[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
							// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
							"toolUse",
						),
					});
					// 前面的首次请求条件不成立时，构造普通文本回复作为本轮收尾。
				} else {
					// 向本地响应流写入事件，不向真实服务发送数据。
					mockStream.push({
						// 正常终止事件；循环仍会依据其 message.stopReason 判断是否执行工具或退出。
						type: "done",
						// 该事件声明正常停止，和下面助手夹具的默认 stop 对应。
						reason: "stop",
						// 在终止事件里直接放入完整助手夹具；循环可通过 result() 取到它。
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
			});
			// 交回本轮模拟流，循环随后异步迭代它。
			return mockStream;
		});

		// 排空异步事件流，当前用例只关心最终结果或外部观察变量。
		for await (const _event of stream) {
			// consume
		}

		// 工具后应再进行一次文本请求，总计两次本地请求。
		expect(llmCalls).toBe(2);
		// 只有从首轮进入次轮时需要 prepareNextTurn，所以调用一次。
		expect(prepareCalls).toBe(1);
		// 第二轮标准请求消息中应确实含 updated guidance 系统正文。
		expect(convertedSecondTurnHasUpdate).toBe(true);
	});

	// 验证 prepareNextTurn 期间新入队的 steering 会在下一请求前补取。noop 触发续轮，准备回调入队 late steering 并返回 undefined；第二次 mock 检查消息引用存在。
	it("picks up steering queued during prepareNextTurn before the next request", async () => {
		// 定义空对象参数 schema，本用例使用无业务输入的 noop。
		const toolSchema = obj({});
		// 该工具参数来自空对象 schema，详情类型明确为 undefined。
		const tool: AgentTool<typeof toolSchema, undefined> = {
			// noop 仅返回固定结果，没有真实外部动作。
			name: "noop",
			// 空操作工具的显示标签。
			label: "Noop",
			// 固定工具说明。
			description: "Noop tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 无参数本地执行器返回固定结果；async 让返回对象包装为 Promise。
			async execute() {
				// 返回完成文本且没有详情，不进行 IO。
				return { content: [{ type: "text", text: "done" }], details: undefined };
			},
		};
		// 用普通数组作为可控插话队列；push 入队，splice(0) 取走全部项。
		const queued: AgentMessage[] = [];
		// 预建准备回调期间才入队的消息，用对象引用观察是否进入请求。
		const lateSteering = createUserMessage("late steering");
		// 记录本地请求函数调用次数；名称不表示访问了真实 provider。
		let providerCalls = 0;
		// 记录第二轮请求中是否已经出现准备期间新入队的插话。
		let secondRequestIncludedSteering = false;
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// 下一轮准备回调向假队列追加 lateSteering，再返回 undefined 保持当前请求状态；用来测试准备后的补充队列读取。
			prepareNextTurn: () => {
				// 准备阶段把消息加入假队列，模拟耗时准备期间出现的新输入。
				queued.push(lateSteering);
				// 此钩子不提供覆盖或阻止决策，调用方沿用当前状态。
				return undefined;
			},
			// 异步读取并清空本地假队列，实际入队由准备钩子控制。
			getSteeringMessages: async () => queued.splice(0),
		};

		// 启动被测 Agent 运行；参数依次为新消息、上下文、配置、取消信号及本地流函数。
		const stream = agentLoop(
			// 发送初始 run；noop 结果将自然触发下一轮准备。
			[createUserMessage("run")],
			// 传入空历史和可执行本地工具；循环可能补充工具声明 system 消息。
			{ messages: [], tools: [tool] },
			// 传入本用例的模型、转换和钩子配置。
			config,
			// 此位置不提供取消信号；具体参数含义按当前调用签名区分。
			undefined,
			// 本地 StreamFn 接收模型上下文，忽略模型参数并记录目标轮的消息。
			(_model, context) => {
				// 每次进入本地 StreamFn 都递增请求计数。
				providerCalls++;
				// 第二轮用引用相等检查新插话是否已追加到请求历史。
				if (providerCalls === 2) secondRequestIncludedSteering = context.messages.includes(lateSteering);
				// 为当前模拟请求创建独立助手事件流，无网络连接。
				const response = createAssistantMessageEventStream();
				// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
				queueMicrotask(() => {
					// 准备由后续条件表达式选择的一条完整助手消息。
					const message =
						// 首次 mock 发 noop 工具调用，第二次改为正常文本结束。
						providerCalls === 1
							? // 三元表达式的真分支构造首轮工具调用消息，并把 stopReason 设为 toolUse。
								createAssistantMessage(
									// 预设调用 id=tool-1、工具 noop；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
									[{ type: "toolCall", id: "tool-1", name: "noop", arguments: {} }],
									// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
									"toolUse",
								)
							: // 三元表达式的假分支构造正常 stop 文本回复，用于收尾或暴露不应发生的续轮。
								createAssistantMessage([{ type: "text", text: "done" }]);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					response.push({ type: "done", reason: providerCalls === 1 ? "toolUse" : "stop", message });
				});
				// 返回这次 mock 响应流，不等待其中消息被消费。
				return response;
			},
		);
		// 只等待本次 Agent 运行的最终新增消息，不需要逐个读取事件才能驱动生产者。
		await stream.result();

		// 准备时入队的插话与工具自然续轮合在第二次请求处理，不应再加第三次。
		expect(providerCalls).toBe(2);
		// 第二次请求必须含准备期间入队的 lateSteering 对象。
		expect(secondRequestIncludedSteering).toBe(true);
	});

	// 验证 finishTurn 收到已完成的工具结果和上下文，end 决策随后阻止继续轮询。echo 执行一次，回调记录角色与 id；检查完整事件数组、消息角色、一次启动 steering 查询及零 follow-up 查询。
	it("action:end receives finalized turn context and stops before queue polling", async () => {
		// 参数 schema 要求 value 为字符串；obj/str 还供运行时验证和可能的转换使用。
		const toolSchema = obj({ value: str() });
		// 记录本地工具真正收到的字符串值，阻止/截断路径不应向其追加。
		const executed: string[] = [];
		// 工具类型把 typeof toolSchema 的参数结构与 {value:string} 详情关联；typeof 在此提取静态类型。
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			// 工具名为 echo，与模型调用块的 name 匹配。
			name: "echo",
			// 工具显示标签，和调用匹配用的 name 字段分开。
			label: "Echo",
			// 工具说明随声明投影提供给模型，不执行这段文字。
			description: "Echo tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 本地执行器收到调用 id 和已准备/验证的参数，异步返回结果；此处忽略 id，只操作内存。
			async execute(_toolCallId, params) {
				// 把实际到达 execute 的 value 追加到记录中，便于区别仅生成调用与真正执行。
				executed.push(params.value);
				// 返回 echo 结果；finishTurn 应在这份结果写进消息历史后看到它。
				return {
					// 把本地输入拼进工具文本结果；模板插值只生成字符串，不执行模型或真实文件操作。
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					// details 保存本地展示/扩展数据；并非模型可见 content 的自动副本。
					details: { value: params.value },
				};
			},
		};

		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 把本地 tool 放进可执行工具列表，循环按名字匹配它。
			tools: [tool],
		};

		// 统计循环实际调用 steering 读取器的次数，包括启动检查。
		let steeringPolls = 0;
		// 统计自然停止处 follow-up 读取器的调用次数。
		let followUpPolls = 0;
		// 记录 finishTurn 收到的结果 id 数组。
		let callbackToolResultIds: string[] = [];
		// 记录 finishTurn 所见完成上下文中的消息角色顺序。
		let callbackContextRoles: string[] = [];
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// 收尾钩子拿到完整助手、结果和已追加上下文，记录它们后返回 end；async 将决策包装为 Promise。
			finishTurn: async ({ message, toolResults, context }) => {
				// 收尾快照的 message 是发起该回合工具调用的助手消息。
				expect(message.role).toBe("assistant");
				// 按回合结果数组原顺序提取 id，验证工具结果已经进入快照。
				callbackToolResultIds = toolResults.map((toolResult) => toolResult.toolCallId);
				// 把已完成上下文投影为角色列表，包含自动补出的工具声明 system。
				callbackContextRoles = context.messages.map((contextMessage) => contextMessage.role);
				// 明确结束本次低层运行；随后不再查询排队消息或准备下一轮。
				return { action: "end" };
			},
			// 异步队列读取器无输入，按当前记录返回待交付消息，并更新本地交付状态。
			getSteeringMessages: async () => {
				// 记录一次插话队列查询，用于检查 end/硬退出的调度边界。
				steeringPolls++;
				// 该分支没有待交付消息或投影项，返回空数组。
				return [];
			},
			// 无输入异步追问读取器，按本用例状态返回排队消息或空数组。
			getFollowUpMessages: async () => {
				// 记录一次追问队列查询。
				followUpPolls++;
				// 构造不应被取出的追问；end 正常生效时此回调根本不会运行。
				return [createUserMessage("follow up should stay queued")];
			},
		};

		// 统计本地模拟请求次数，不实际计量供应商请求。
		let llmCalls = 0;
		// 启动该用例的 Agent 循环，最后的本地回调构造预设回复；工具和钩子使用当前配置。
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			// 每次进入本地流回调记一次请求。
			llmCalls++;
			// 创建本轮本地响应流；随后微任务把预设消息送进去。
			const mockStream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 首轮返回工具调用，后续轮按本用例需要返回文本或不应执行的分支。
				if (llmCalls === 1) {
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage(
						// 预设调用 id=tool-1、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
						"toolUse",
					);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					mockStream.push({ type: "done", reason: "toolUse", message });
					// 前面的首次请求条件不成立时，构造普通文本回复作为本轮收尾。
				} else {
					// 向本地响应流写入事件，不向真实服务发送数据。
					mockStream.push({
						// 正常终止事件；循环仍会依据其 message.stopReason 判断是否执行工具或退出。
						type: "done",
						// 该事件声明正常停止，和下面助手夹具的默认 stop 对应。
						reason: "stop",
						// 在终止事件里直接放入完整助手夹具；循环可通过 result() 取到它。
						message: createAssistantMessage([{ type: "text", text: "should not run" }]),
					});
				}
			});
			// 交回本轮模拟流，循环随后异步迭代它。
			return mockStream;
		});

		// 创建本次运行的事件记录数组，用于随后筛选或顺序断言。
		const events: AgentEvent[] = [];
		// 按异步迭代协议逐项等待事件；循环继续直到 agent_end 让流结束。
		for await (const event of stream) {
			// 把收到的事件引用按接收顺序追加到数组，不复制其深层对象。
			events.push(event);
		}

		// 取得本次调用新增的完整消息数组；continue 不会把先前历史重复计入。
		const messages = await stream.result();
		// finishTurn 的 end 决策应使本地流函数只执行一次。
		expect(llmCalls).toBe(1);
		// end 不跳过本回合工具，echo 已实际执行且输入 hello。
		expect(executed).toEqual(["hello"]);
		// 仅有启动 steering 查询；end 后不再查询。
		expect(steeringPolls).toBe(1);
		// end 使 follow-up 查询次数保持零。
		expect(followUpPolls).toBe(0);
		// finishTurn 应拿到已经完成的 tool-1 结果。
		expect(callbackToolResultIds).toEqual(["tool-1"]);
		// 收尾上下文已含工具声明 system、用户、助手和工具结果，按该顺序排列。
		expect(callbackContextRoles).toEqual(["system", "user", "assistant", "toolResult"]);
		// The context declares no tools, so the loop announces the loadout with a system message.
		// 初始 transcript 尚未声明工具，但 context.tools 实际已注册 echo，因此新增消息含自动补出的 system 工具声明。
		expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "toolResult"]);
		// 精确比较该路径整段事件 type 顺序；此数组不包含 finishTurn 自身，因为它是钩子而非 AgentEvent。
		expect(events.map((event) => event.type)).toEqual([
			// 整个 Agent 运行开始。
			"agent_start",
			// 首个回合开始。
			"turn_start",
			// 自动生成的工具声明 system 消息开始。
			"message_start",
			// 工具声明 system 消息完整发布。
			"message_end",
			// 用户输入消息开始。
			"message_start",
			// 用户输入消息完整发布。
			"message_end",
			// 本地流只发 done，因此循环补发助手消息开始事件。
			"message_start",
			// 助手工具请求消息完整发布。
			"message_end",
			// 开始这一次工具调用的处理管线。
			"tool_execution_start",
			// 工具执行及后置处理完成。
			"tool_execution_end",
			// 工具结果消息开始发布。
			"message_start",
			// 工具结果消息完整发布；finishTurn 在其后、turn_end 之前执行。
			"message_end",
			// 回合结束；finishTurn 已作出 end 决策。
			"turn_end",
			// 本次 Agent 运行结束，不再查询队列。
			"agent_end",
		]);
	});

	// 验证本批全部工具结果 terminate:true 时停止工具后的自动请求。一个 echo 结果要求终止，检查只请求一次、四条新增消息及一次 turn_end；terminate 不是对未结束工具的强制取消。 此字段只关闭工具结果带来的自然续轮；finishTurn 或排队消息仍可另行要求继续，本用例没有提供这些继续理由。
	it("should stop after a tool batch when every tool result sets terminate=true", async () => {
		// 参数 schema 要求 value 为字符串；obj/str 还供运行时验证和可能的转换使用。
		const toolSchema = obj({ value: str() });
		// 工具类型把 typeof toolSchema 的参数结构与 {value:string} 详情关联；typeof 在此提取静态类型。
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			// 工具名为 echo，与模型调用块的 name 匹配。
			name: "echo",
			// 工具显示标签，和调用匹配用的 name 字段分开。
			label: "Echo",
			// 工具说明随声明投影提供给模型，不执行这段文字。
			description: "Echo tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 本地执行器收到调用 id 和已准备/验证的参数，异步返回结果；此处忽略 id，只操作内存。
			async execute(_toolCallId, params) {
				// 把执行结果标为终止，检查单工具批次无需后续模型请求。
				return {
					// 把本地输入拼进工具文本结果；模板插值只生成字符串，不执行模型或真实文件操作。
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					// details 保存本地展示/扩展数据；并非模型可见 content 的自动副本。
					details: { value: params.value },
					// 该结果要求停止工具批次后的自动续轮；只有本批所有最终结果都为 true 才生效。
					terminate: true,
				};
			},
		};

		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 把本地 tool 放进可执行工具列表，循环按名字匹配它。
			tools: [tool],
		};

		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
		};

		// 统计本地模拟请求次数，不实际计量供应商请求。
		let llmCalls = 0;
		// 启动该用例的 Agent 循环，最后的本地回调构造预设回复；工具和钩子使用当前配置。
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			// 每次进入本地流回调记一次请求。
			llmCalls++;
			// 创建本轮本地响应流；随后微任务把预设消息送进去。
			const mockStream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
				const message = createAssistantMessage(
					// 预设调用 id=tool-1、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
					"toolUse",
				);
				// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
				mockStream.push({ type: "done", reason: "toolUse", message });
			});
			// 交回本轮模拟流，循环随后异步迭代它。
			return mockStream;
		});

		// 创建本次运行的事件记录数组，用于随后筛选或顺序断言。
		const events: AgentEvent[] = [];
		// 按异步迭代协议逐项等待事件；循环继续直到 agent_end 让流结束。
		for await (const event of stream) {
			// 把收到的事件引用按接收顺序追加到数组，不复制其深层对象。
			events.push(event);
		}

		// 取得本次调用新增的完整消息数组；continue 不会把先前历史重复计入。
		const messages = await stream.result();
		// 所有最终工具结果都要求 terminate 时，不再执行第二个模型请求。
		expect(llmCalls).toBe(1);
		// 按新增消息角色数组的完整顺序比较，包括工具列表引发的 system 声明。
		expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "toolResult"]);
		// 这次终止仍应正常产生一次 turn_end，而不是绕过收尾。
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);
	});

	// 验证被 beforeToolCall 阻止的调用也可贡献 terminate:true。mock 要求 echo，钩子阻止并说明原因，execute 不运行；检查错误工具消息及只请求一次。
	it("should stop after a blocked tool call when beforeToolCall sets terminate=true", async () => {
		// 参数 schema 要求 value 为字符串；obj/str 还供运行时验证和可能的转换使用。
		const toolSchema = obj({ value: str() });
		// 记录被阻止的工具是否错误地进入 execute。
		let executed = false;
		// 工具类型把 typeof toolSchema 的参数结构与 {value:string} 详情关联；typeof 在此提取静态类型。
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			// 工具名为 echo，与模型调用块的 name 匹配。
			name: "echo",
			// 工具显示标签，和调用匹配用的 name 字段分开。
			label: "Echo",
			// 工具说明随声明投影提供给模型，不执行这段文字。
			description: "Echo tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 无参数本地执行器返回固定结果；async 让返回对象包装为 Promise。
			async execute() {
				// 只要实际执行器被调用就置 true，随后断言应仍为 false。
				executed = true;
				// 这是阻止失效才可能得到的工具结果，正确路径应完全跳过本 return。
				return {
					// 若阻止失效才会生成这段固定工具内容，用于区别正确路径。
					content: [{ type: "text", text: "should not execute" }],
					// 同样属于不应执行分支的夹具详情。
					details: { value: "unexpected" },
				};
			},
		};
		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 把本地 tool 放进可执行工具列表，循环按名字匹配它。
			tools: [tool],
		};
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// 前置钩子不依赖输入，直接阻止并要求本结果贡献终止；工具 execute 不会被调用。
			beforeToolCall: async () => ({ block: true, reason: "Blocked by policy", terminate: true }),
		};

		// 统计本地模拟请求次数，不实际计量供应商请求。
		let llmCalls = 0;
		// 启动该用例的 Agent 循环，最后的本地回调构造预设回复；工具和钩子使用当前配置。
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			// 每次进入本地流回调记一次请求。
			llmCalls++;
			// 创建本轮本地响应流；随后微任务把预设消息送进去。
			const mockStream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 准备由后续条件表达式选择的一条完整助手消息。
				const message =
					// 首轮发 echo 调用，若错误续轮才会选择后面的不应执行文本。
					llmCalls === 1
						? // 三元表达式的真分支构造首轮工具调用消息，并把 stopReason 设为 toolUse。
							createAssistantMessage(
								// 预设调用 id=tool-1、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
								[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
								// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
								"toolUse",
							)
						: // 三元表达式的假分支构造正常 stop 文本回复，用于收尾或暴露不应发生的续轮。
							createAssistantMessage([{ type: "text", text: "should not run" }]);
				// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
				mockStream.push({ type: "done", reason: llmCalls === 1 ? "toolUse" : "stop", message });
			});
			// 交回本轮模拟流，循环随后异步迭代它。
			return mockStream;
		});

		// 排空异步事件流，当前用例只关心最终结果或外部观察变量。
		for await (const _event of stream) {
			// consume
		}

		// 取得本次调用新增的完整消息数组；continue 不会把先前历史重复计入。
		const messages = await stream.result();
		// 从本次新增消息里取首条工具结果，不是从工具执行事件里取。
		const toolResult = messages.find((message) => message.role === "toolResult");
		// 前置钩子阻止成功，execute 中的标志赋值不应发生。
		expect(executed).toBe(false);
		// 这条被阻止结果也带 terminate，因此不应请求第二次模型。
		expect(llmCalls).toBe(1);
		// 只有找到工具结果并确认其 isError 才通过；缺失结果时条件表达式返回 false。
		expect(toolResult?.role === "toolResult" ? toolResult.isError : false).toBe(true);
		// 检查工具内容数组里存在深度相等的指定错误文本块；不要求它是唯一内容。
		expect(toolResult?.role === "toolResult" ? toolResult.content : []).toContainEqual({
			// 匹配被阻止结果中的文本内容块。
			type: "text",
			// 错误文字应沿用前置钩子传入的 Blocked by policy。
			text: "Blocked by policy",
		});
	});

	// 验证一个被阻止且要求终止的调用不足以终止混合批次。first 被阻止、second 真正执行且不要求终止，因此还应请求一次文本回复；检查 executed 只含 second。
	it("should continue after a mixed batch with one terminating blocked call", async () => {
		// 参数 schema 要求 value 为字符串；obj/str 还供运行时验证和可能的转换使用。
		const toolSchema = obj({ value: str() });
		// 记录本地工具真正收到的字符串值，阻止/截断路径不应向其追加。
		const executed: string[] = [];
		// 工具类型把 typeof toolSchema 的参数结构与 {value:string} 详情关联；typeof 在此提取静态类型。
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			// 工具名为 echo，与模型调用块的 name 匹配。
			name: "echo",
			// 工具显示标签，和调用匹配用的 name 字段分开。
			label: "Echo",
			// 工具说明随声明投影提供给模型，不执行这段文字。
			description: "Echo tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 本地执行器收到调用 id 和已准备/验证的参数，异步返回结果；此处忽略 id，只操作内存。
			async execute(_toolCallId, params) {
				// 把实际到达 execute 的 value 追加到记录中，便于区别仅生成调用与真正执行。
				executed.push(params.value);
				// 仅允许 second 进入这里返回正常结果，它未要求 terminate，因此整个批次应继续。
				return {
					// 把本地输入拼进工具文本结果；模板插值只生成字符串，不执行模型或真实文件操作。
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					// details 保存本地展示/扩展数据；并非模型可见 content 的自动副本。
					details: { value: params.value },
				};
			},
		};
		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 把本地 tool 放进可执行工具列表，循环按名字匹配它。
			tools: [tool],
		};
		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// 显式选择并行批次：前置准备仍依序，真正执行可并发等待。
			toolExecution: "parallel",
			// 前置钩子拿到已验证的参数副本，可修改它；返回 undefined 代表不阻止。
			beforeToolCall: async ({ args }) => {
				// 把 unknown 参数断言为字符串字段形状后解构；这里不产生运行时验证，schema 处理已在钩子前。
				const { value } = args as { value: string };
				// 仅 first 被阻止并要求终止，second 不阻止也不附加 terminate。
				return value === "first" ? { block: true, reason: "Blocked first", terminate: true } : undefined;
			},
		};

		// 统计本地模拟请求次数，不实际计量供应商请求。
		let llmCalls = 0;
		// 启动该用例的 Agent 循环，最后的本地回调构造预设回复；工具和钩子使用当前配置。
		const stream = agentLoop([createUserMessage("echo both")], context, config, undefined, () => {
			// 每次进入本地流回调记一次请求。
			llmCalls++;
			// 创建本轮本地响应流；随后微任务把预设消息送进去。
			const mockStream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 准备由后续条件表达式选择的一条完整助手消息。
				const message =
					// 首轮请求两个工具，次轮才返回正常结束文本。
					llmCalls === 1
						? // 三元表达式的真分支构造首轮工具调用消息，并把 stopReason 设为 toolUse。
							createAssistantMessage(
								[
									// 预设调用 id=tool-1、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
									{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
									// 预设调用 id=tool-2、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
									{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
								],
								// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
								"toolUse",
							)
						: // 三元表达式的假分支构造正常 stop 文本回复，用于收尾或暴露不应发生的续轮。
							createAssistantMessage([{ type: "text", text: "done" }]);
				// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
				mockStream.push({ type: "done", reason: llmCalls === 1 ? "toolUse" : "stop", message });
			});
			// 交回本轮模拟流，循环随后异步迭代它。
			return mockStream;
		});

		// 排空异步事件流，当前用例只关心最终结果或外部观察变量。
		for await (const _event of stream) {
			// consume
		}

		// first 被阻止，只有 second 实际进入工具执行器。
		expect(executed).toEqual(["second"]);
		// 混合批次未全部要求终止，所以应再请求一次最终文本，共两次。
		expect(llmCalls).toBe(2);
	});

	// 验证并行批次只有部分结果 terminate 时仍续轮。first 为 true，second 为 false，两结果都完成后再取文本回复；检查两次请求及消息角色顺序。
	it("should continue after parallel tool calls when not all tool results terminate", async () => {
		// 参数 schema 要求 value 为字符串；obj/str 还供运行时验证和可能的转换使用。
		const toolSchema = obj({ value: str() });
		// 工具类型把 typeof toolSchema 的参数结构与 {value:string} 详情关联；typeof 在此提取静态类型。
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			// 工具名为 echo，与模型调用块的 name 匹配。
			name: "echo",
			// 工具显示标签，和调用匹配用的 name 字段分开。
			label: "Echo",
			// 工具说明随声明投影提供给模型，不执行这段文字。
			description: "Echo tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 本地执行器收到调用 id 和已准备/验证的参数，异步返回结果；此处忽略 id，只操作内存。
			async execute(_toolCallId, params) {
				// 为两次调用返回结果，并按 value 分别设置 true/false 终止标志。
				return {
					// 把本地输入拼进工具文本结果；模板插值只生成字符串，不执行模型或真实文件操作。
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					// details 保存本地展示/扩展数据；并非模型可见 content 的自动副本。
					details: { value: params.value },
					// first 的结果终止标志为 true，second 为 false；整批每项都 true 才能停止续轮。
					terminate: params.value === "first",
				};
			},
		};

		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 把本地 tool 放进可执行工具列表，循环按名字匹配它。
			tools: [tool],
		};

		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// 显式选择并行批次：前置准备仍依序，真正执行可并发等待。
			toolExecution: "parallel",
		};

		// 记录当前预设响应的序号，零代表首次工具请求，后续通常返回文本结束。
		let callIndex = 0;
		// 启动该用例的 Agent 循环，最后的本地回调构造预设回复；工具和钩子使用当前配置。
		const stream = agentLoop([createUserMessage("echo both")], context, config, undefined, () => {
			// 创建本轮本地响应流；随后微任务把预设消息送进去。
			const mockStream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 首次本地请求发工具调用，后续走普通文本回复分支。
				if (callIndex === 0) {
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage(
						[
							// 预设调用 id=tool-1、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							// 预设调用 id=tool-2、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
						"toolUse",
					);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					mockStream.push({ type: "done", reason: "toolUse", message });
					// 前面的首次请求条件不成立时，构造普通文本回复作为本轮收尾。
				} else {
					// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
					mockStream.push({ type: "done", reason: "stop", message });
				}
				// 推进 mock 请求序号，确保下一次循环请求不会重复首轮工具调用。
				callIndex++;
			});
			// 交回本轮模拟流，循环随后异步迭代它。
			return mockStream;
		});

		// 排空异步事件流，当前用例只关心最终结果或外部观察变量。
		for await (const _event of stream) {
			// consume
		}

		// 取得本次调用新增的完整消息数组；continue 不会把先前历史重复计入。
		const messages = await stream.result();
		// 部分 terminate 的并行批次仍需一个后续文本请求，共调用两次本地流。
		expect(callIndex).toBe(2);
		// 对下面列出的完整顺序作深度相等比较；只检查本用例这条执行轨迹。
		expect(messages.map((message) => message.role)).toEqual([
			// 工具集合变动补出的 system 声明。
			"system",
			// 原始新增用户输入。
			"user",
			// 一次含两个工具调用的助手消息。
			"assistant",
			// 源顺序第一条工具结果消息；对应的工具执行结果要求 terminate:true，此消息包装本身不保存 terminate 字段。
			"toolResult",
			// 源顺序第二条工具结果消息；对应执行结果不要求终止，因此该批还会自然续轮。
			"toolResult",
			// 工具结果后的最终助手文本回复。
			"assistant",
		]);
	});

	// 验证后置钩子可以给工具结果补 terminate:true。工具原始结果不要求终止，afterToolCall 设置后使单工具批次停止；只断请求次数为一。
	it("should allow afterToolCall to mark a tool batch as terminating", async () => {
		// 参数 schema 要求 value 为字符串；obj/str 还供运行时验证和可能的转换使用。
		const toolSchema = obj({ value: str() });
		// 工具类型把 typeof toolSchema 的参数结构与 {value:string} 详情关联；typeof 在此提取静态类型。
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			// 工具名为 echo，与模型调用块的 name 匹配。
			name: "echo",
			// 工具显示标签，和调用匹配用的 name 字段分开。
			label: "Echo",
			// 工具说明随声明投影提供给模型，不执行这段文字。
			description: "Echo tool",
			// 绑定本用例参数 schema，工具执行前由管线校验。
			parameters: toolSchema,
			// 本地执行器收到调用 id 和已准备/验证的参数，异步返回结果；此处忽略 id，只操作内存。
			async execute(_toolCallId, params) {
				// 工具自身返回普通结果，不要求终止；后置钩子稍后补终止标志。
				return {
					// 把本地输入拼进工具文本结果；模板插值只生成字符串，不执行模型或真实文件操作。
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					// details 保存本地展示/扩展数据；并非模型可见 content 的自动副本。
					details: { value: params.value },
				};
			},
		};

		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 把本地 tool 放进可执行工具列表，循环按名字匹配它。
			tools: [tool],
		};

		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
			// 后置钩子给已执行结果补终止标志，不修改正文或详情。
			afterToolCall: async () => ({ terminate: true }),
		};

		// 统计本地模拟请求次数，不实际计量供应商请求。
		let llmCalls = 0;
		// 启动该用例的 Agent 循环，最后的本地回调构造预设回复；工具和钩子使用当前配置。
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			// 每次进入本地流回调记一次请求。
			llmCalls++;
			// 创建本轮本地响应流；随后微任务把预设消息送进去。
			const mockStream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
				const message = createAssistantMessage(
					// 预设调用 id=tool-1、工具 echo；参数见 arguments，真正执行还要经过工具查找、准备与钩子。
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					// 把该完整消息的 stopReason 设为 toolUse，允许进入工具处理后的自然续轮。
					"toolUse",
				);
				// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
				mockStream.push({ type: "done", reason: "toolUse", message });
			});
			// 交回本轮模拟流，循环随后异步迭代它。
			return mockStream;
		});

		// 排空异步事件流，当前用例只关心最终结果或外部观察变量。
		for await (const _event of stream) {
			// consume
		}

		// 后置钩子追加 terminate 后，这个单工具批次也应只请求一次模型。
		expect(llmCalls).toBe(1);
	});
});

// 从已有历史继续的分组；不重复发布现有输入消息。
describe("agentLoopContinue with AgentMessage", () => {
	// 验证 continue 空上下文时同步抛错。输入空 messages，备用流函数若调用就主动报错；toThrow 检查错误文字，无异步模型请求。
	it("should throw when context has no messages", () => {
		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 初始历史为空，运行时新增消息由循环另行累积。
			messages: [],
			// 没有可执行工具；也无须额外宣布非空工具列表。
			tools: [],
		};

		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
		};

		// 传入函数而非执行结果，供 toThrow 捕获同步异常；不是检测 Promise rejection。
		expect(
			() =>
				// 把可能同步抛错的 continue 调用包在断言回调中；若错误地进入请求阶段就运行下方失败替身。
				agentLoopContinue(context, config, undefined, () => {
					// 主动抛出不同错误，确保空上下文测试若意外进入流回调就不会伪装成正确错误。
					throw new Error("Unexpected stream call");
				}),
			// 捕获同步抛出的错误并检查包含这段文字，不要求消息完全相等。
		).toThrow("Cannot continue: no messages in context");
	});

	// 验证 continue 复用既有用户历史，不重新发布用户消息。mock 仅返回一条助手消息；消费事件后检查新增消息与 message_end 都只含助手。as any 只放宽测试访问的静态类型。
	it("should continue from existing context without emitting user message events", async () => {
		// 预先建立已有用户历史，continue 不应再把它作为新增消息返回。
		const userMessage: AgentMessage = createUserMessage("Hello");

		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 上下文已有一条用户消息，continue 从此继续而不再发布其消息事件。
			messages: [userMessage],
			// 没有可执行工具；也无须额外宣布非空工具列表。
			tools: [],
		};

		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 请求前调用前述角色筛选器，保留标准消息。
			convertToLlm: identityConverter,
		};

		// 定义无输入本地请求替身：每调用一次，创建事件流并安排预设回复，返回流供循环消费。
		const streamFn = () => {
			// 新建一条纯内存助手事件流，保存事件队列及最终结果 Promise。
			const stream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
				stream.push({ type: "done", reason: "stop", message });
			});
			// 把刚创建的本地流交回调用方；最终消息由稍后的微任务提供。
			return stream;
		};

		// 创建本次运行的事件记录数组，用于随后筛选或顺序断言。
		const events: AgentEvent[] = [];
		// 从已有历史继续，不追加或重新发布先前输入；显式传入本地模型流。
		const stream = agentLoopContinue(context, config, undefined, streamFn);

		// 按异步迭代协议逐项等待事件；循环继续直到 agent_end 让流结束。
		for await (const event of stream) {
			// 把收到的事件引用按接收顺序追加到数组，不复制其深层对象。
			events.push(event);
		}

		// 取得本次调用新增的完整消息数组；continue 不会把先前历史重复计入。
		const messages = await stream.result();

		// Should only return the new assistant message (not the existing user message)
		// continue 返回值只含新增助手，不重复包含原有用户历史，所以长度为一。
		expect(messages.length).toBe(1);
		// 唯一新增消息应是本地生成的助手回复。
		expect(messages[0].role).toBe("assistant");

		// Should NOT have user message events (that's the key difference from agentLoop)
		// 只选完整消息结束事件，不把开始/回合等事件混入数量比较。
		const messageEndEvents = events.filter((e) => e.type === "message_end");
		// continue 应只发布一条完整消息事件，即新增助手，不能重发已有用户事件。
		expect(messageEndEvents.length).toBe(1);
		// 把事件断言为 any 后读取角色，只是放宽静态检查；实际角色仍必须为 assistant。
		expect((messageEndEvents[0] as any).message.role).toBe("assistant");
	});

	// 验证自定义末条消息可由调用方转换为用户输入。历史 custom/text 经 convertToLlm map/filter 得到标准消息，mock 回答后只返回新增助手消息；用例没有真实供应商来验证角色协议。
	it("should allow custom message types as last message (caller responsibility)", async () => {
		// Custom message that will be converted to user message by convertToLlm
		// 声明测试专用 custom 消息形状，仅在编译时存在。
		interface CustomMessage {
			// 角色类型固定为 custom，需由调用方转换到标准模型消息。
			role: "custom";
			// 自定义正文的静态类型为字符串；字段名为 text，并非标准消息的 content。
			text: string;
			// 时间字段为数值，具体是否合理不由此类型验证。
			timestamp: number;
		}

		// 创建现有历史中的自定义消息，不额外发新用户输入。
		const customMessage: CustomMessage = {
			// 实际运行时角色是 custom，供转换器识别。
			role: "custom",
			// 自定义正文字段名是 text，转换时会搬到标准用户消息的 content。
			text: "Hook content",
			// 记录当前毫秒时间，不对真实世界的固定时刻作断言。
			timestamp: Date.now(),
		};

		// 构造本用例的 Agent 上下文，随后字段明确历史与本地可执行工具。
		const context: AgentContext = {
			// 双重断言让这份未做声明合并的自定义夹具进入 Agent 历史，不进行运行时转换。
			messages: [customMessage as unknown as AgentMessage],
			// 没有可执行工具；也无须额外宣布非空工具列表。
			tools: [],
		};

		// 设置当前用例的循环选项；钩子与本地请求函数各自独立。
		const config: AgentLoopConfig = {
			// 每次创建一份 mock 元数据，不调用模型服务。
			model: createModel(),
			// 转换器接收当前 Agent 历史，逐项把 custom 投影为标准用户消息并筛掉非标准角色，返回新数组。
			convertToLlm: (messages) => {
				// Convert custom to user message
				// 通过后续 map/filter 构造标准请求消息，不直接把 custom 原样交给流函数。
				return (
					messages
						// 逐项映射历史：custom 变为用户消息，其他项原对象返回。
						.map((m) => {
							// 借助 any 放宽静态角色访问，运行时仍需实际 role 等于 custom。
							if ((m as any).role === "custom") {
								// 把 custom 消息投影为新的标准用户对象，不修改原自定义消息。
								return {
									// as const 保留 user 字面量类型，避免扩大成 string；它不会冻结消息对象。
									role: "user" as const,
									// 从自定义消息读取 text 放进标准 content，any 不检查该字段实际类型。
									content: (m as any).text,
									// 保留原消息时间，转换器不重新排序或生成时间。
									timestamp: m.timestamp,
								};
							}
							// 非 custom 消息保持原引用，随后再按标准角色筛选。
							return m;
						})
						// 再保留该用例需要的三种角色；as 不补齐字段，不在此处理 system。
						.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[]
				);
			},
		};

		// 定义无输入本地请求替身：每调用一次，创建事件流并安排预设回复，返回流供循环消费。
		const streamFn = () => {
			// 新建一条纯内存助手事件流，保存事件队列及最终结果 Promise。
			const stream = createAssistantMessageEventStream();
			// 登记一个无输入微任务，当前同步调用返回后推送预设终止事件；不是另起线程。
			queueMicrotask(() => {
				// 构造这次 mock 的完整助手消息；单参数时默认 stop，工具场景会额外提供停止原因。
				const message = createAssistantMessage([{ type: "text", text: "Response to custom message" }]);
				// 把该分支预设的终止原因和完整消息推入本地流，结束单次模拟请求。
				stream.push({ type: "done", reason: "stop", message });
			});
			// 把刚创建的本地流交回调用方；最终消息由稍后的微任务提供。
			return stream;
		};

		// Should not throw - the custom message will be converted to user message
		// 从已有历史继续，不追加或重新发布先前输入；显式传入本地模型流。
		const stream = agentLoopContinue(context, config, undefined, streamFn);

		// 创建本次运行的事件记录数组，用于随后筛选或顺序断言。
		const events: AgentEvent[] = [];
		// 按异步迭代协议逐项等待事件；循环继续直到 agent_end 让流结束。
		for await (const event of stream) {
			// 把收到的事件引用按接收顺序追加到数组，不复制其深层对象。
			events.push(event);
		}

		// 取得本次调用新增的完整消息数组；continue 不会把先前历史重复计入。
		const messages = await stream.result();
		// 自定义历史由转换器处理后，本次仍只新增一条助手消息。
		expect(messages.length).toBe(1);
		// 新增项必须是助手消息，而非把 custom 转换出的用户消息重复计入新增数组。
		expect(messages[0].role).toBe("assistant");
	});
});

// 单工具管线分组；工具夹具只操作内存，不发送 Agent 生命周期事件。
describe("runToolCall", () => {
	// 供 runToolCall 组共用的 echo 参数 schema，value 必须符合字符串规则。
	const echoSchema = obj({ value: str() });
	// 声明可直接复用的 echo 本地工具，参数类型由 schema 推导，详情沿泛型默认类型。
	const echo: AgentTool<typeof echoSchema> = {
		// 工具名为 echo，与模型调用块的 name 匹配。
		name: "echo",
		// 工具显示标签，和调用匹配用的 name 字段分开。
		label: "Echo",
		// 工具说明随声明投影提供给模型，不执行这段文字。
		description: "Echo tool",
		// 执行前按这份 echo schema 准备/校验参数。
		parameters: echoSchema,
		// 声明结构化输出形状；此文件检查管线如何传递结构结果，并没有专门断言输出 schema 校验。
		outputSchema: obj({ value: str() }),
		// 执行器接收参数和可选进度回调；此处忽略 id/取消信号，先发增量再返回最终 echo。
		async execute(_toolCallId, params, _signal, onUpdate) {
			// 有进度接收器才同步调用，发送一条 partial；没有则跳过而不抛错。
			onUpdate?.({ content: [{ type: "text", text: "partial" }], details: {} });
			// 返回 echo 的完整文字与结构化结果，和前面已发送的 partial 分开。
			return {
				// 最终模型可见内容使用已验证参数的文字。
				content: [{ type: "text", text: params.value }],
				// 工具详情为空对象，与 structuredContent 单独保存。
				details: {},
				// 结构化结果保留 value，供后置钩子覆盖/丢弃规则测试。
				structuredContent: { value: params.value },
			};
		},
	};
	// 另建主动返回错误结果的工具，区别于 execute 抛异常。
	const failing: AgentTool = {
		// 通过 failing 名称触发这份固定失败工具。
		name: "failing",
		// 失败工具的显示名称。
		label: "Failing",
		// 说明此工具 resolve 错误结果，而非一定 reject。
		description: "Returns an error result",
		// 该工具不需要业务参数，使用空对象 schema。
		parameters: obj({}),
		// 无参数本地执行器返回固定结果；async 让返回对象包装为 Promise。
		async execute() {
			// 以正常 Promise 结果返回错误标志和 partial 详情，检查失败时详情仍可保留。
			return { content: [{ type: "text", text: "bad" }], details: { partial: true }, isError: true };
		},
	};
	// 构造发起调用的助手消息夹具，供 hooks 上下文引用，不运行模型。
	const assistantMessage = createAssistantMessage([]);
	// 本地调用块工厂：输入 id/name/参数，返回 toolCall 对象，无 IO；索引访问类型复用 arguments 定义。
	const call = (id: string, name: string, args: AgentToolCall["arguments"]): AgentToolCall => ({
		// 标记该内容块为工具请求，不是实际执行结果。
		type: "toolCall",
		// 调用 id 属性简写，结果与钩子记录会使用此值关联。
		id,
		// 把输入工具名作为匹配目标，不自动判断是否注册。
		name,
		// 保存传入参数引用；准备/验证管线随后会克隆并按 schema 处理。
		arguments: args,
	});

	// 直接验证 runToolCall 的准备、校验、前后钩子及失败结果。依次执行有效 echo、非法嵌套参数、被阻止调用、未知工具和返回 isError 的工具；检查局部结果、增量及钩子顺序，无 Agent 事件或消息持久化。
	it("validates, runs the hooks, and reports failures as error outcomes", async () => {
		// 记录前后钩子实际进入的调用 id 与顺序。
		const hookCalls: string[] = [];
		// 以 unknown 数组保存所有进度结果；读取前不能直接假定它们的结构。
		const updates: unknown[] = [];
		// 组装单次工具管线的选项，包含可用工具、发起消息、上下文和各回调。
		const options = {
			// 仅允许在这两个本地工具中按名字解析调用。
			tools: [echo, failing],
			// 属性简写，向钩子提供预设发起助手消息。
			assistantMessage,
			// 单工具管线的上下文只提供空历史；独立 tools 参数决定能解析哪些工具。
			context: { messages: [] },
			// 前置钩子显式描述所需参数片段，记录 id 并按 value 判断是否阻止；unknown 访问需断言。
			beforeToolCall: async ({ toolCall, args }: { toolCall: { id: string }; args: unknown }) => {
				// 记录前置钩子进入，非法参数及未知工具不应到达这里。
				hookCalls.push(`before ${toolCall.id}`);
				// 只阻止 value=blocked，返回固定原因；可选 value 断言不执行新的校验。
				if ((args as { value?: string }).value === "blocked") return { block: true, reason: "nope" };
				// 此钩子不提供覆盖或阻止决策，调用方沿用当前状态。
				return undefined;
			},
			// 后置钩子只依赖调用 id，记录进入后不覆盖结果；被前置阻止时不会调用它。
			afterToolCall: async ({ toolCall }: { toolCall: { id: string } }) => {
				// 记录后置钩子进入，包括工具主动返回 isError 的情况。
				hookCalls.push(`after ${toolCall.id}`);
				// 此钩子不提供覆盖或阻止决策，调用方沿用当前状态。
				return undefined;
			},
			// 同步进度接收器保存 unknown 结果，无外部 UI 或持久化副作用。
			onUpdate: (partial: unknown) => {
				// 保存增量对象引用，稍后比较仅成功 echo 发出的一条进度。
				updates.push(partial);
			},
		};

		// 等待本地调用 a（echo）完成，再局部匹配结果；不要求对象所有其他字段都相等。
		expect(await runToolCall(call("a", "echo", { value: "a" }), options)).toMatchObject({
			// 局部匹配只要求返回结果关联调用 a，不检查对象的全部字段。
			toolCall: { id: "a" },
			// 局部匹配最终结构化 echo 结果，不要求其余结果字段不存在。
			result: { structuredContent: { value: "a" } },
			// 期望这次成功调用未被管线标记为错误。
			isError: false,
		});
		// 等待本地调用 b（echo）完成，再局部匹配结果；不要求对象所有其他字段都相等。
		expect(await runToolCall(call("b", "echo", { value: { nested: true } }), options)).toMatchObject({
			// 期望这条调用被报告为错误结果；不是要求 await 抛出异常。
			isError: true,
		});
		// 等待本地调用 c（echo）完成，再局部匹配结果；不要求对象所有其他字段都相等。
		expect(await runToolCall(call("c", "echo", { value: "blocked" }), options)).toMatchObject({
			// 被阻止调用的模型可见正文应含前置钩子给出的原因。
			result: { content: [{ type: "text", text: "nope" }] },
			// 期望这条调用被报告为错误结果；不是要求 await 抛出异常。
			isError: true,
		});
		// 等待本地调用 d（missing）完成，再局部匹配结果；不要求对象所有其他字段都相等。
		expect(await runToolCall(call("d", "missing", {}), options)).toMatchObject({
			// 未知工具直接返回固定错误文本，不能进入 execute 或 hooks。
			result: { content: [{ type: "text", text: "Tool missing not found" }] },
			// 期望这条调用被报告为错误结果；不是要求 await 抛出异常。
			isError: true,
		});
		// Error results keep their details.
		// 等待本地调用 e（failing）完成，再局部匹配结果；不要求对象所有其他字段都相等。
		expect(await runToolCall(call("e", "failing", {}), options)).toMatchObject({
			// 主动失败工具的详情仍保留 partial，不因错误标志被丢弃。
			result: { details: { partial: true } },
			// 期望这条调用被报告为错误结果；不是要求 await 抛出异常。
			isError: true,
		});
		// 只有成功 echo 调用发出一条 partial 增量；被阻止/未知/校验失败路径不会运行其 execute。
		expect(updates).toEqual([{ content: [{ type: "text", text: "partial" }], details: {} }]);
		// Validation failures and unknown tools never reach the hooks; blocked calls skip afterToolCall.
		// 精确比较钩子记录顺序：非法参数/未知工具不到钩子，阻止调用不进后置钩子。
		expect(hookCalls).toEqual(["before a", "after a", "before c", "before e", "after e"]);
	});

	// 验证 afterToolCall 对 structuredContent 的四种覆盖组合。逐次调用 echo(original)，分别替换 content、结构结果、两者或仅 details；最终收集结构结果，检查只换文字会丢弃旧结构结果。
	it("lets afterToolCall replace structured content and drops it when only content is replaced", async () => {
		// 创建替换正文夹具；as const 只保留 text 标签类型，这个值本身不是脱敏算法。
		const redacted = [{ type: "text" as const, text: "redacted" }];
		// 列出四种后置覆盖对象，后续逐项运行同一 echo 输入来比较合并语义。
		const results = [
			// 只换正文，旧结构结果可能失配，因此管线应移除它。
			{ content: redacted },
			// 只换结构结果，正文保持工具原值。
			{ structuredContent: { value: "replaced" } },
			// 同时换正文和结构结果，应采用明确给出的结构结果。
			{ content: redacted, structuredContent: { value: "both" } },
			// 只换详情，不触碰正文，因此原结构结果应保留。
			{ details: { note: "kept" } },
		];
		// 收集每种覆盖之后实际输出的 structuredContent。
		const seen: unknown[] = [];
		// 依次运行四种覆盖方案，等待当前调用完成才进行下一次。
		for (const afterResult of results) {
			// 直接运行一条 echo(original)，不创建 Agent 运行或消息事件流。
			const outcome = await runToolCall(call("x", "echo", { value: "original" }), {
				// 本次独立管线只在 echo 工具中查找实现。
				tools: [echo],
				// 属性简写，向钩子提供预设发起助手消息。
				assistantMessage,
				// 单工具管线的上下文只提供空历史；独立 tools 参数决定能解析哪些工具。
				context: { messages: [] },
				// 闭包捕获当前循环的覆盖对象，异步返回给工具收尾管线。
				afterToolCall: async () => afterResult,
			});
			// 记录合并后的结构字段；字段被删除时读取得到 undefined。
			seen.push(outcome.result.structuredContent);
		}
		// 比较四种覆盖后的结构结果：只换正文时删除，只换 details 时保留原结构。
		expect(seen).toEqual([undefined, { value: "replaced" }, { value: "both" }, { value: "original" }]);
	});
});
