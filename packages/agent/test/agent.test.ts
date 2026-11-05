// 用本地模型流和工具fixture检查有状态Agent：状态初始化、工具轨迹、订阅等待、取消、续轮队列及请求选项透传。无真实模型请求。
// ClientIdentity只导入类型，PI_ATTRIBUTION为请求归因元数据，不是认证凭证。
import { type ClientIdentity, PI_ATTRIBUTION } from "@earendil-works/pi-ai";
// 从兼容入口复用消息类型、事件流工厂、轨迹工具和内置目录读取；getModel只读本地生成的模型元数据。
import {
	// AssistantMessage是完整模型回复类型。
	type AssistantMessage,
	// 事件流工厂供下面模拟请求返回真实协议事件队列。
	createAssistantMessageEventStream,
	// 重放system消息以取得当前系统正文/工具声明。
	getCurrentSystemMessage,
	// 内置目录模型查询，不发请求或检查凭证。
	getModel,
	// 清洗可执行工具为模型声明，去掉execute等字段，schema会JSON往返复制。
	toToolDeclaration,
	// UserMessage只用作helper的返回类型。
	type UserMessage,
	// 结束兼容入口导入；同一import里的type名字会擦除，普通函数在运行时加载。
} from "@earendil-works/pi-ai/compat";
// obj创建参数规则数据；空obj({})默认禁止额外字段，构造不验证某个输入。
import { obj } from "@earendil-works/pi-schema";
// Vitest登记用例/参数化场景，expect比较运行值或Promise结果。
import { describe, expect, it } from "vitest";
// 从本包真实公开入口取Agent/默认stream设置及相关类型，不mock Agent核心逻辑。
import {
	// Agent持有状态、队列和事件订阅。
	Agent,
	// AgentEvent为带type标签的生命周期事件联合。
	type AgentEvent,
	// AgentTool将schema推导参数与execute签名关联。
	type AgentTool,
	// 进度回调类型的泛型对应工具details。
	type AgentToolUpdateCallback,
	// StreamFn约定请求函数返回统一模型事件流。
	type StreamFn,
	// 设置模块级默认streamFn；首例会临时设置，并在finally清成undefined。
	setDefaultStreamFn,
	// 结束本包公开入口导入；这里未建立Agent实例。
} from "../src/index.ts";

// 按文本创建一条UserMessage，返回新对象，读取本机时间；例输入hi得到user/content:hi。只组装数据，不排队或发送。
function createUserMessage(text: string): UserMessage {
	// role固定user，content保留字符串，Date.now返回毫秒；不是把文本转换成内容块数组。
	return { role: "user", content: text, timestamp: Date.now() };
}

// 创建正常结束的模拟文字回复，输入正文、返回完整AssistantMessage。例ok产生单text块和stop；用量全零，仅Date.now读时钟。
function createAssistantMessage(text: string): AssistantMessage {
	// 组装完整回复对象，补齐低层管线需要的协议字段。
	return {
		// 消息角色为assistant；这只是模拟模型输出数据，不代表请求了真实供应商。
		role: "assistant",
		// 数组含一个text块；text属性简写复用输入字符串。
		content: [{ type: "text", text }],
		// 用固定协议名补齐消息元数据，本地模拟流不调用该协议的真实API。
		api: "openai-responses",
		// 供应商字段固定openai，仅供元数据和管线使用。
		provider: "openai",
		// 模型标识固定mock，不查找或连接远程模型。
		model: "mock",
		// 模拟模型用量为全零，后面测试不依赖真实token计数。
		usage: {
			// 输入token数为零的fixture。
			input: 0,
			// 输出token数为零的fixture。
			output: 0,
			// 缓存读取token的模拟值。
			cacheRead: 0,
			// 缓存写入token的模拟值。
			cacheWrite: 0,
			// 总token模拟为零，不从消息字符数计算。
			totalTokens: 0,
			// 费用各项和合计都置零，不说明真实模型免费。
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		// helper统一设正常stop；某些取消fixture只改事件reason，不会自动改变本字段。
		stopReason: "stop",
		// 读取本机当前Unix毫秒作为消息时间，不要求每次调用得到不同值。
		timestamp: Date.now(),
	};
}

// 先索引content数组元素联合，再用Extract筛出type:toolCall，避免把文字块当工具请求。纯类型计算。
type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

// 按名字创建无参本地工具，返回AgentTool；例first执行后只回文字first。创建时不执行工具，schema/execute供Agent管线稍后使用。
function createTool(name: string): AgentTool {
	// 返回工具描述与执行函数组成的对象。
	return {
		// 属性简写把传入名字作为模型匹配名。
		name,
		// 展示标签复用同一个名字。
		label: name,
		// 模板文字补工具说明，不启动同名系统命令。
		description: `${name} tool`,
		// 声明工具接收空对象参数；规则创建与真正execute是两步。
		parameters: obj({}),
		// execute若被调用会异步返回name文字与空详情；参数被忽略，无外部IO。
		execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
	};
}

// 将一组工具请求块包成toolUse模型回复，返回新消息并读时钟；例noop调用随后让真实Agent执行本地noop。只保存content原数组引用，不执行工具。
function createAssistantToolUseMessage(content: ToolCallContent[]): AssistantMessage {
	// 建立工具请求回复所需的外层消息元数据。
	return {
		// 消息角色为assistant；这只是模拟模型输出数据，不代表请求了真实供应商。
		role: "assistant",
		// 属性简写保留传入工具内容数组，没有复制各调用块。
		content,
		// 用固定协议名补齐消息元数据，本地模拟流不调用该协议的真实API。
		api: "openai-responses",
		// 供应商字段固定openai，仅供元数据和管线使用。
		provider: "openai",
		// 模型标识固定mock，不查找或连接远程模型。
		model: "mock",
		// 模拟模型用量为全零，后面测试不依赖真实token计数。
		usage: {
			// 输入token数为零的fixture。
			input: 0,
			// 输出token数为零的fixture。
			output: 0,
			// 缓存读取token的模拟值。
			cacheRead: 0,
			// 缓存写入token的模拟值。
			cacheWrite: 0,
			// 总token模拟为零，不从消息字符数计算。
			totalTokens: 0,
			// 费用各项和合计都置零，不说明真实模型免费。
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		// stopReason:toolUse提示低层循环处理工具，不代表工具已经完成。
		stopReason: "toolUse",
		// 读取本机当前Unix毫秒作为消息时间，不要求每次调用得到不同值。
		timestamp: Date.now(),
	};
}

// 定义“本例不应请求模型”的失败哨兵；调用就抛错。适合只构造状态的测试，定义时不会抛。
const unusedStreamFunction: StreamFn = () => {
	// 一旦意外进入streamFn便暴露错误；状态类测试未必直接断言此消息，不能因此虚称所有调用路径都被测过。
	throw new Error("Unexpected stream call");
};

// 创建外部可解除的Promise屏障，返回promise和resolve。无参数，无IO；例测试先await其promise，另一处调用resolve放行。
function createDeferred(): {
	// Promise<void>表示完成时不返回业务值。
	promise: Promise<void>;
	// resolve成员是稍后主动通知完成的函数，签名不带参数。
	resolve: () => void;
	// 返回对象类型声明结束，接着才是createDeferred真实函数体。
} {
	// 先放空函数占位，let允许在同步Promise执行器里换成真实resolve。
	let resolve = () => {};
	// new Promise的执行器会立即同步执行，不等未来调度；因此返回前已取得真实resolve。
	const promise = new Promise<void>((resolvePromise) => {
		// 保存Promise自身的完成函数，供函数外调用；不是现在就完成Promise。
		resolve = resolvePromise;
	});
	// 对象简写返回屏障及其完成函数，二者关联同一份Promise。
	return { promise, resolve };
}

// 登记完整Agent分组；异步场景以fixture流和本地工具驱动真实核心，不使用供应商HTTP实现。
describe("Agent", () => {
	// 模拟旧编译调用方未传streamFn，验证使用模块默认mock且只请求一次；结束清理默认值。本例不保存/恢复可能原有的默认函数。
	it("uses the configured default when a legacy caller omits streamFn", async () => {
		// 计数默认mock请求次数，初始0。
		let calls = 0;
		// 安装模块共享默认函数，后续缺streamFn的Agent构造会读取它；此刻还没请求。
		setDefaultStreamFn(() => {
			// 每次默认mock真正被调用才加一。
			calls++;
			// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
			const stream = createAssistantMessageEventStream();
			// 延后发布模拟fallback终值，让调用方先拿到流对象。
			queueMicrotask(() => {
				// 创建固定fallback回复。
				const message = createAssistantMessage("fallback");
				// 把前面构造的message作为done终值；它会由真实低层循环转成message生命周期事件。
				stream.push({ type: "done", reason: "stop", message });
			});
			// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
			return stream;
		});

		// try包住构造、运行和断言，确保后面的finally清理默认函数。设置默认函数的那一步在try之前。
		try {
			// Reflect.construct按运行时方式传空选项，绕开new Agent的必填streamFn静态约束；as Agent不验证返回实例。
			const agent = Reflect.construct(Agent, [{}]) as Agent;
			// 真实prompt经默认本地流完成；不会请求供应商。
			await agent.prompt("Hello");
			// 检查默认函数恰好被调用一次，而非只检查回复文字。
			expect(calls).toBe(1);
			// 成功或异常都执行finally，不吞掉原测试失败。
		} finally {
			// 把模块默认引用清为undefined；不是恢复首例之前可能已有的任意值。
			setDefaultStreamFn(undefined);
		}
	});

	// 只构造默认状态并逐字段断言，模型为核心自己的占位元数据；不运行prompt或查远端默认模型。
	it("should create an agent instance with default state", () => {
		// 创建只供状态/队列断言的Agent；若误触模型请求，unusedStreamFunction会立刻抛错。
		const agent = new Agent({ streamFn: unusedStreamFunction });

		// 状态对象应该存在。
		expect(agent.state).toBeDefined();
		// 只要求model有值，不限定其id或证明它是可请求模型。
		expect(agent.state.model).toBeDefined();
		// 默认思考设置为off。
		expect(agent.state.thinkingLevel).toBe("off");
		// 初始没有可执行工具。
		expect(agent.state.tools).toEqual([]);
		// 没有提示词/工具/历史时，初始消息数组为空。
		expect(agent.state.messages).toEqual([]);
		// 构造完成尚未运行，忙碌标志为false。
		expect(agent.state.isStreaming).toBe(false);
		// 未生成任何消息草稿。
		expect(agent.state.streamingMessage).toBe(undefined);
		// 深比较空Set，确认尚无执行中工具调用id。
		expect(agent.state.pendingToolCalls).toEqual(new Set());
		// 没有历史运行错误提示。
		expect(agent.state.errorMessage).toBeUndefined();
	});

	// 给自定义提示词、模型及思考设置，检查提示词折成system且模型引用不复制；不调用模型。
	it("should create an agent instance with custom initial state", () => {
		// 只从已生成内置目录取gpt-4o-mini元数据，不请求其API。
		const customModel = getModel("openai", "gpt-4o-mini");
		// 创建带初态的真实Agent。
		const agent = new Agent({
			// 注入禁止意外请求的函数；单纯构造/重置状态不该调用它。
			streamFn: unusedStreamFunction,
			// initialState覆写少数字段，其余沿核心默认值。
			initialState: {
				// 初始系统正文，构造时转成首条system消息。
				systemPrompt: "You are a helpful assistant.",
				// 保存前面读取的模型对象引用。
				model: customModel,
				// 显式选择low思考级别。
				thinkingLevel: "low",
			},
		});

		// 比较折入历史后的system，合成初始时间戳固定0，不是构造时Date.now。
		expect(agent.state.messages).toEqual([{ role: "system", content: "You are a helpful assistant.", timestamp: 0 }]);
		// toBe比较引用身份，要求模型仍是customModel对象。
		expect(agent.state.model).toBe(customModel);
		// 自定义low应覆盖默认off。
		expect(agent.state.thinkingLevel).toBe("low");
	});

	// 检查初始提示词与工具描述共同写进首条system；只看声明，不执行echo。
	it("converts initial prompt and tools into transcript state", () => {
		// 定义一个合法无参本地工具fixture。
		const tool: AgentTool = {
			// 工具匹配名echo，用于模型调用与实际实现的对应。
			name: "echo",
			// 仅供UI展示的Echo名称，不参与工具匹配。
			label: "Echo",
			// 工具用途元数据，本例不会让模型阅读或推理这段说明。
			description: "Echo input",
			// 声明工具接收空对象参数；规则创建与真正execute是两步。
			parameters: obj({}),
			// 若调用execute会立即异步返回echo文字和空详情；这不是启动echo命令或子进程。
			execute: async () => ({ content: [{ type: "text", text: "echo" }], details: {} }),
		};
		// 构造真实Agent，初始化时建立系统轨迹。
		const agent = new Agent({
			// 初态同时给正文和工具，工具execute保留在运行态，模型历史只含声明。
			initialState: { systemPrompt: "You are helpful.", tools: [tool] },
			// 注入禁止意外请求的函数；单纯构造/重置状态不该调用它。
			streamFn: unusedStreamFunction,
		});

		// 读取合成的首条系统消息。
		const initial = agent.state.messages[0];
		// 可选链让缺消息得到undefined，断言应为system。
		expect(initial?.role).toBe("system");
		// 运行时确认存在且为system，并让TS据角色标签收窄后续字段；失败直接结束本例。
		if (initial?.role !== "system") throw new Error("expected initial system message");
		// 检查合成消息保留正文。
		expect(initial.content).toBe("You are helpful.");
		// 把toolsAdded投影为名字再比较，断言echo声明存在，不校验所有元数据。
		expect(initial.toolsAdded?.map((value) => value.name)).toEqual(["echo"]);
	});

	// 连续prompt三次：先有first，改可执行集合为second后补一条增删system，第三次不重复补。检查历史声明和请求轨迹，不执行工具。
	it("declares tool loadout changes to the model before the next request", async () => {
		// 创建最初可用的first工具。
		const first = createTool("first");
		// 创建稍后替换进去的second工具。
		const second = createTool("second");
		// 保存每次请求投影出的字符串列表；二维数组外层计请求，内层计这次可见输入，不保存完整上下文快照。
		const requests: string[][] = [];
		// 建立有提示词和first初态的Agent。
		const agent = new Agent({
			// 初始系统消息声明first，运行态也确实只有first。
			initialState: { systemPrompt: "You are helpful.", tools: [first] },
			// 本地模拟请求函数忽略模型，但检查真实低层循环传来的规范轨迹；没有网络调用。
			streamFn: (_model, context) => {
				// 每次本地streamFn收到上下文时，记录其中的工具声明投影。
				requests.push(
					// flatMap逐消息映射为两项或空数组并展开一层，忽略非system消息。
					context.messages.flatMap((message) =>
						// 只有system角色的工具变更参与本例记录。
						message.role === "system"
							? // system分支生成加工具、减工具两段文字。
								[
									// 缺toolsAdded用空数组，提名字再逗号连接；无新增也保留单独加号。
									`+${(message.toolsAdded ?? []).map((tool) => tool.name).join(",")}`,
									// 同样记录移除名字；没有移除时结果只是减号。
									`-${(message.toolsRemoved ?? []).map((tool) => tool.name).join(",")}`,
								]
							: // 非system映射空数组，从投影中消失。
								[],
					),
				);
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 把下面的模拟输出排到微任务，在当前同步调用栈结束后执行；不是等待真实模型。
				queueMicrotask(() => {
					// 发布正常终止事件和固定done文字，流据此完成result并终止迭代。
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				});
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});

		// 第一次prompt看到最初first声明。
		await agent.prompt("one");
		// 替换可执行工具数组；setter浅复制根数组，此刻还未新增system轨迹。
		agent.state.tools = [second];
		// 第二次请求前，低层按实际工具补second新增与first移除。
		await agent.prompt("two");
		// 工具未再变化，第三次请求应复用已有变更历史。
		await agent.prompt("three");

		// 深比较三个请求投影，既验证变更内容，也验证第三次没有重复声明补丁。
		expect(requests).toEqual([
			// 第一请求只有first的初始新增，移除为空。
			["+first", "-"],
			// 第二请求保留初始声明，再带second替代first的一条变化。
			["+first", "-", "+second", "-first"],
			// 第三请求投影相同，不新增第二份重复补丁。
			["+first", "-", "+second", "-first"],
		]);
		// find取首条带toolsRemoved的system；缺失得到undefined，下面比较将失败。
		const update = agent.state.messages.find((message) => message.role === "system" && message.toolsRemoved);
		// 检查实际写入Agent历史的工具变化消息，不只看模拟函数记录。
		expect(update).toEqual({
			// 这份消息承载系统规则或工具声明，角色为system。
			role: "system",
			// 系统正文为空，实际变更可能保存在sections或工具字段。
			content: "",
			// 新增声明只包含模型需要的字段和schema，不带label/execute。
			toolsAdded: [{ name: "second", description: "second tool", parameters: obj({}) }],
			// 移除引用只需名字first。
			toolsRemoved: [{ name: "first" }],
			// 非对称匹配任意Number值，不要求具体墙钟时刻；不是在此断言时间单调。
			timestamp: expect.any(Number),
		});
		// 取第一条已提交历史，空历史时可能为undefined。
		const initial = agent.state.messages[0];
		// 运行时确认存在且为system，并让TS据角色标签收窄后续字段；失败直接结束本例。
		if (initial?.role !== "system") throw new Error("expected initial system message");
		// 确认初始工具声明没有execute属性，避免把可执行函数写入模型轨迹；只直接检查首个工具这一字段。
		expect(initial.toolsAdded?.[0]).not.toHaveProperty("execute");
	});

	// 新工具与待发system章节同批出现时，应把工具声明合进该system，而非额外插一条；例skills章节和echo声明共存。
	it("merges tool changes into a pending system message", async () => {
		// 创建本例待加载的echo工具。
		const tool: AgentTool = {
			// 工具匹配名echo，用于模型调用与实际实现的对应。
			name: "echo",
			// 仅供UI展示的Echo名称，不参与工具匹配。
			label: "Echo",
			// 工具用途元数据，本例不会让模型阅读或推理这段说明。
			description: "Echo input",
			// 声明工具接收空对象参数；规则创建与真正execute是两步。
			parameters: obj({}),
			// 若调用execute会立即异步返回echo文字和空详情；这不是启动echo命令或子进程。
			execute: async () => ({ content: [{ type: "text", text: "echo" }], details: {} }),
		};
		// 开始只有提示词、尚无工具的Agent。
		const agent = new Agent({
			// 构造首条已有系统提示，后面还会发送一条章节补丁。
			initialState: { systemPrompt: "You are helpful." },
			// 本地模拟请求函数忽略模型，但检查真实低层循环传来的规范轨迹；没有网络调用。
			streamFn: (_model, context) => {
				// 模拟请求入口要求system恰有两条：初始提示加章节/工具合并消息。失败会抛入Agent错误处理，因此后续历史断言也很关键。
				expect(context.messages.filter((message) => message.role === "system")).toHaveLength(2);
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 把下面的模拟输出排到微任务，在当前同步调用栈结束后执行；不是等待真实模型。
				queueMicrotask(() => {
					// 发布正常终止事件和固定done文字，流据此完成result并终止迭代。
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				});
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});

		// 请求前先变更真正可执行集合，触发声明差异。
		agent.state.tools = [tool];
		// 一次prompt接收消息数组，原样的system/user内容由管线整合，不额外包成文字user。
		await agent.prompt([
			// 待发system给skills章节与固定时间1，正文为空。
			{ role: "system", content: "", sections: { skills: "<skills>x</skills>" }, timestamp: 1 },
			// 随后普通user消息提供hi，时间固定2。
			{ role: "user", content: "hi", timestamp: 2 },
		]);

		// 检查历史第1项正是合并后的补丁，保留章节和时间。
		expect(agent.state.messages[1]).toEqual({
			// 这份消息承载系统规则或工具声明，角色为system。
			role: "system",
			// 系统正文为空，实际变更可能保存在sections或工具字段。
			content: "",
			// skills章节不因工具变更而丢失。
			sections: { skills: "<skills>x</skills>" },
			// 同一消息加入echo的模型声明。
			toolsAdded: [{ name: "echo", description: "Echo input", parameters: obj({}) }],
			// 保留调用方的固定时间，不用新创建补丁的墙钟。
			timestamp: 1,
		});
	});

	// 待发system声称增second删first，但真实执行集合仍first，真实集合优先；移除虚假的工具字段并保留note章节。
	it("rewrites pending tool declarations to match the executable set", async () => {
		// 构造实际只拥有first的Agent。
		const agent = new Agent({
			// 初始轨迹与执行集合一致，都声明first。
			initialState: { systemPrompt: "You are helpful.", tools: [createTool("first")] },
			// 本例注入本地模拟流函数，不调用实际供应商请求实现。
			streamFn: () => {
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 把下面的模拟输出排到微任务，在当前同步调用栈结束后执行；不是等待真实模型。
				queueMicrotask(() => {
					// 发布正常终止事件和固定done文字，流据此完成result并终止迭代。
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				});
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});

		// The pending message claims to add `second` and remove `first`, but the executable
		// set still has `first` and lacks `second`: the executable set wins.
		// 发送故意与运行态冲突的工具声明及正常用户消息，测试协调逻辑，不是真授权second可执行。
		await agent.prompt([
			{
				// 待发变更是system消息。
				role: "system",
				// 正文留空，只有章节及有意冲突的工具字段。
				content: "",
				// note章节应保留，不属于需要纠正的工具集合。
				sections: { note: "<note>x</note>" },
				// toToolDeclaration去掉second的执行字段，但声明本身仍与真实运行集合不符。
				toolsAdded: [toToolDeclaration(createTool("second"))],
				// 故意声称first已移除，实际没有改agent.state.tools。
				toolsRemoved: [{ name: "first" }],
				// 保留固定时间，便于观察协调后仍沿用原元数据。
				timestamp: 1,
			},
			// 正常用户输入让本地模拟流运行一轮。
			{ role: "user", content: "hi", timestamp: 2 },
		]);

		// 预期协调后的历史补丁只剩正文/章节/时间；toEqual不会区别省略字段与值undefined，因此不是严格键集合断言。
		expect(agent.state.messages[1]).toEqual({
			// 这份消息承载系统规则或工具声明，角色为system。
			role: "system",
			// 系统正文为空，实际变更可能保存在sections或工具字段。
			content: "",
			// 非工具note章节保留。
			sections: { note: "<note>x</note>" },
			// 原时间保留。
			timestamp: 1,
		});
		// 重放全部system后，当前可声明工具应仍只有first；可选链缺对象/字段时会得到undefined并使比较失败。
		expect(getCurrentSystemMessage(agent.state.messages)?.toolsAdded?.map((tool) => tool.name)).toEqual(["first"]);
	});

	// reset清旧用户历史但保留重放后的系统正文和工具基线；只构造/重置，不请求模型。
	it("restores the transcript baseline when reset", () => {
		// 建立要在重置后保留声明的echo工具。
		const tool: AgentTool = {
			// 工具匹配名echo，用于模型调用与实际实现的对应。
			name: "echo",
			// 仅供UI展示的Echo名称，不参与工具匹配。
			label: "Echo",
			// 工具用途元数据，本例不会让模型阅读或推理这段说明。
			description: "Echo input",
			// 声明工具接收空对象参数；规则创建与真正execute是两步。
			parameters: obj({}),
			// 若调用execute会立即异步返回echo文字和空详情；这不是启动echo命令或子进程。
			execute: async () => ({ content: [{ type: "text", text: "echo" }], details: {} }),
		};
		// 构造带system配置、工具和旧user消息的Agent。
		const agent = new Agent({
			// 初始化同时给系统与对话数据。
			initialState: {
				// 保留的系统正文。
				systemPrompt: "You are helpful.",
				// 初始执行集合有echo，构造时写入system声明。
				tools: [tool],
				// 旧用户消息应被reset移除。
				messages: [{ role: "user", content: "old", timestamp: 1 }],
			},
			// 注入禁止意外请求的函数；单纯构造/重置状态不该调用它。
			streamFn: unusedStreamFunction,
		});

		// 空闲状态调用reset，重放当前system形成新历史基线，并清理运行标志/队列。
		agent.reset();

		// 重置后只剩一条system，不保留旧user。
		expect(agent.state.messages).toHaveLength(1);
		// 取第一条已提交历史，空历史时可能为undefined。
		const initial = agent.state.messages[0];
		// 可选链让缺消息得到undefined，断言应为system。
		expect(initial?.role).toBe("system");
		// 运行时确认存在且为system，并让TS据角色标签收窄后续字段；失败直接结束本例。
		if (initial?.role !== "system") throw new Error("expected initial system message");
		// 检查首条系统正文仍为初始规则，而非被工具声明变更覆盖。
		expect(initial.content).toBe("You are helpful.");
		// 投影首条系统声明的工具名字，应只含echo；这里没有逐字段比较整个schema。
		expect(initial.toolsAdded?.map((value) => value.name)).toEqual(["echo"]);
	});

	// 检查订阅不立即回放事件、直接改思考状态不发事件；取消订阅后也只做状态赋值，因此本例不能独立证明未来真正事件不会送到已取消监听器。
	it("should subscribe to events", () => {
		// 创建只供状态/队列断言的Agent；若误触模型请求，unusedStreamFunction会立刻抛错。
		const agent = new Agent({ streamFn: unusedStreamFunction });

		// 记录回调调用次数。
		let eventCount = 0;
		// 注册只计数的监听器，并保存返回的取消函数；_event表示本例不读事件内容。
		const unsubscribe = agent.subscribe((_event) => {
			// 监听器真的被调用才加一，本例预期始终0。
			eventCount++;
		});

		// No initial event on subscribe
		// 订阅动作本身不发初态事件。
		expect(eventCount).toBe(0);

		// State mutators don't emit events
		// 直接改思考属性，不启动运行或事件发布。
		agent.state.thinkingLevel = "low";
		// 状态变更后仍没通知监听器。
		expect(eventCount).toBe(0);
		// 同时确认赋值确实生效，避免以没改变任何状态导致计数不变。
		expect(agent.state.thinkingLevel).toBe("low");

		// Unsubscribe should work
		// 调用Set删除监听器的闭包；本行不产生生命周期事件。
		unsubscribe();
		// 取消后再改状态；这种状态赋值本来就不发事件。
		agent.state.thinkingLevel = "high";
		// 计数仍0，但未在取消后启动会真正发事件的prompt，证明范围有限。
		expect(eventCount).toBe(0); // Should not increase
	});

	// 令本地streamFn直接抛异常，检查Agent补完整生命周期、写错误回复及错误状态；prompt本身在这条路径通常resolve void，不等同原异常外抛。
	it("emits full lifecycle events for thrown run failures", async () => {
		// 建立会在请求边界故意失败的Agent。
		const agent = new Agent({
			// 本例注入本地模拟流函数，不调用实际供应商请求实现。
			streamFn: () => {
				// 模拟provider/runtime抛错，无真实供应商调用；虽然违反StreamFn常规失败事件契约，Agent外层仍应处理。
				throw new Error("provider exploded");
			},
		});
		// 只记录事件类型字符串，后面比较数量和顺序，不保存事件所有字段。
		const events: string[] = [];
		// 注册本例观察回调；真实Agent处理每条事件后会等待订阅者，再继续运行。
		agent.subscribe((event) => {
			// 将事件type追加到数组。
			events.push(event.type);
		});

		// 等待这次prompt及其事件监听器收尾；返回void，回答和状态从Agent历史读取。
		await agent.prompt("hello");

		// 深比较八个生命周期事件，验证失败前后仍有开始/结束配对。
		expect(events).toEqual([
			// 整次Agent运行开始。
			"agent_start",
			// 首轮turn开始。
			"turn_start",
			// 输入用户消息开始。
			"message_start",
			// 输入用户消息完整提交。
			"message_end",
			// 补出的失败assistant消息开始。
			"message_start",
			// 失败assistant消息完整提交。
			"message_end",
			// 失败回合结束，没有工具结果。
			"turn_end",
			// Agent本次事件结束；真正空闲还需外层finally清理。
			"agent_end",
		]);
		// 取历史最后一条，应该是包装后的错误回复；空数组时取到undefined。
		const lastMessage = agent.state.messages[agent.state.messages.length - 1];
		// 先断言角色为assistant。
		expect(lastMessage?.role).toBe("assistant");
		// 显式判断角色并抛错，既防缺消息，又让TS收窄到assistant字段。
		if (lastMessage?.role !== "assistant") throw new Error("Expected assistant message");
		// 检查消息stopReason为error，不因prompt resolve就误当模型成功。
		expect(lastMessage.stopReason).toBe("error");
		// 原Error.message应写进消息供上层展示。
		expect(lastMessage.errorMessage).toBe("provider exploded");
		// Agent整体errorMessage也同步到相同错误文字。
		expect(agent.state.errorMessage).toBe("provider exploded");
	});

	// agent_end订阅者被屏障卡住时，prompt和忙碌状态应继续等待；解除屏障后才完成。只测本例时序，10ms让步不是任意机器的实时保证。
	it("should await async subscribers before prompt resolves", async () => {
		// 创建手动resolve的屏障，让订阅者暂停，以便验证prompt/idle是否仍等待。
		const barrier = createDeferred();
		// 建立能很快返回ok终值的本地Agent，把等待重点放到订阅者。
		const agent = new Agent({
			// 本例注入本地模拟流函数，不调用实际供应商请求实现。
			streamFn: () => {
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 把下面的模拟输出排到微任务，在当前同步调用栈结束后执行；不是等待真实模型。
				queueMicrotask(() => {
					// 发布带固定ok回复的done终止事件，供真实Agent管线消费。
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});

		// 观察监听器是否越过屏障，不用它替代Agent正式状态。
		let listenerFinished = false;
		// async订阅者返回Promise，真实Agent会按订阅顺序await。
		agent.subscribe(async (event) => {
			// 只有agent_end事件才暂停，前面各消息事件可以正常处理完。
			if (event.type === "agent_end") {
				// 暂停当前订阅回调直到测试主动resolve，不会阻塞Node线程。
				await barrier.promise;
				// 解除屏障并恢复回调后，标记监听器结束。
				listenerFinished = true;
			}
		});

		// 记录prompt的then是否运行，初始false。
		let promptResolved = false;
		// 启动prompt并在其resolve后标记；先保存Promise避免立即await阻塞测试解除屏障。
		const promptPromise = agent.prompt("hello").then(() => {
			// 只有prompt resolve才置true，不是收到agent_end就置true。
			promptResolved = true;
		});

		// 等一次约10毫秒的定时器，给微任务/模拟流推进机会；调度可能更晚，不是精确时间或任意机器上的完成保证。
		await new Promise((resolve) => setTimeout(resolve, 10));
		// 监听器还没结束，所以prompt尚不能resolve。
		expect(promptResolved).toBe(false);
		// 屏障未解除，监听器未完成。
		expect(listenerFinished).toBe(false);
		// 此刻Agent仍有活跃运行，isStreaming包括工具和等待订阅者阶段，不仅表示网络正在吐字。
		expect(agent.state.isStreaming).toBe(true);

		// 解除订阅者屏障，其await之后的代码才可继续；resolve本身不立即同步跑完全部后续回调。
		barrier.resolve();
		// 等前面已启动的运行及订阅者真正收尾，不会再启动新一轮。
		await promptPromise;

		// 等待prompt结束后监听器必须已完成。
		expect(listenerFinished).toBe(true);
		// then回调也应执行，确认prompt确实resolve。
		expect(promptResolved).toBe(true);
		// 断言Agent已完成运行清理，进入可接受下一次prompt的空闲状态。
		expect(agent.state.isStreaming).toBe(false);
	});

	// 在assistant message_end订阅者中等待，检查waitForIdle也包含订阅者完成时间；解除后并等prompt/idle两者，不把某个事件发出当已空闲。
	it("waitForIdle should wait for async subscribers", async () => {
		// 创建手动resolve的屏障，让订阅者暂停，以便验证prompt/idle是否仍等待。
		const barrier = createDeferred();
		// 模拟回复正常ok，等待来自消息订阅者而非供应商耗时。
		const agent = new Agent({
			// 本例注入本地模拟流函数，不调用实际供应商请求实现。
			streamFn: () => {
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 把下面的模拟输出排到微任务，在当前同步调用栈结束后执行；不是等待真实模型。
				queueMicrotask(() => {
					// 发布带固定ok回复的done终止事件，供真实Agent管线消费。
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});

		// 异步订阅模型完整消息结束事件。
		agent.subscribe(async (event) => {
			// 同时筛message_end和assistant角色，使用户输入消息不会先卡住屏障。
			if (event.type === "message_end" && event.message.role === "assistant") {
				// 暂停当前订阅回调直到测试主动resolve，不会阻塞Node线程。
				await barrier.promise;
			}
		});

		// 立即启动prompt但保留Promise先不await，下面才能观察运行中的状态或解除屏障。
		const promptPromise = agent.prompt("hello");
		// 观察waitForIdle返回的Promise是否完成。
		let idleResolved = false;
		// 在prompt已启动后取得当前activeRun的idle Promise，并挂then记录。
		const idlePromise = agent.waitForIdle().then(() => {
			// idle resolve后才置true，便于先检查尚未空闲的阶段。
			idleResolved = true;
		});

		// 等一次约10毫秒的定时器，给微任务/模拟流推进机会；调度可能更晚，不是精确时间或任意机器上的完成保证。
		await new Promise((resolve) => setTimeout(resolve, 10));
		// 异步消息订阅者仍阻塞，idle不应提前resolve。
		expect(idleResolved).toBe(false);
		// 此刻Agent仍有活跃运行，isStreaming包括工具和等待订阅者阶段，不仅表示网络正在吐字。
		expect(agent.state.isStreaming).toBe(true);

		// 解除订阅者屏障，其await之后的代码才可继续；resolve本身不立即同步跑完全部后续回调。
		barrier.resolve();
		// Promise.all等待同一运行的prompt及idle两个入口；不是发两个prompt。
		await Promise.all([promptPromise, idlePromise]);

		// 解除屏障后应能等到idle。
		expect(idleResolved).toBe(true);
		// 断言Agent已完成运行清理，进入可接受下一次prompt的空闲状态。
		expect(agent.state.isStreaming).toBe(false);
	});

	// 监听agent_start取得活跃AbortSignal，再发abort确认同一信号变aborted；本地流靠5ms轮询配合结束，不证明任意工具都自动停止。
	it("should pass the active abort signal to subscribers", async () => {
		// 暂存订阅者收到的可选信号，初始undefined。
		let receivedSignal: AbortSignal | undefined;
		// 建立只有取消后才终止的模拟Agent运行。
		const agent = new Agent({
			// 注入本地流函数，只读取真实Agent转交的options，忽略模型和上下文；无实际模型请求。
			streamFn: (_model, _context, options) => {
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 把下面的模拟输出排到微任务，在当前同步调用栈结束后执行；不是等待真实模型。
				queueMicrotask(() => {
					// 发布开始事件和空文字草稿；fixture虽用stop初值，整体流仍需后续终止事件才能完成。
					stream.push({ type: "start", partial: createAssistantMessage("") });
					// 定义模拟流的取消轮询：已取消则发错误终止，否则稍后再次检查；只在此fixture中使用。
					const checkAbort = () => {
						// 检查可选options和signal是否已取消；没给信号时不会误判为true。
						if (options?.signal?.aborted) {
							// 发aborted终止事件，但消息helper的stopReason仍是stop；本例重点是信号/忙碌拒绝，不独立验证最终消息的取消原因。
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
							// 未取消则继续安排下次检查，这不是重发模型请求。
						} else {
							// 未取消时安排约5毫秒后重查，实际时刻由事件循环决定；没有同步忙等。
							setTimeout(checkAbort, 5);
						}
					};
					// 启动第一次取消检查，后续由上面的定时器递续。
					checkAbort();
				});
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});

		// 监听器接收事件和同次运行信号，参数名signal来自Agent而不是自己创建控制器。
		agent.subscribe((event, signal) => {
			// 在agent_start处保存信号，不依赖后续每条事件重复赋值。
			if (event.type === "agent_start") {
				// 保存信号对象引用，稍后abort会让该对象可见状态改变。
				receivedSignal = signal;
			}
		});

		// 立即启动prompt但保留Promise先不await，下面才能观察运行中的状态或解除屏障。
		const promptPromise = agent.prompt("hello");
		// 等一次约10毫秒的定时器，给微任务/模拟流推进机会；调度可能更晚，不是精确时间或任意机器上的完成保证。
		await new Promise((resolve) => setTimeout(resolve, 10));

		// agent_start订阅应收到一个信号对象。
		expect(receivedSignal).toBeDefined();
		// 发abort前该信号应未取消；缺信号得到undefined也会使断言失败。
		expect(receivedSignal?.aborted).toBe(false);

		// 对当前运行的AbortController发取消信号；模拟流要自行观察并发布结束事件，不是强制杀线程。
		agent.abort();
		// 等前面已启动的运行及订阅者真正收尾，不会再启动新一轮。
		await promptPromise;

		// 等待本地流收尾后，同一收到的信号已变为aborted。
		expect(receivedSignal?.aborted).toBe(true);
	});

	// 工具结束后调用保存的进度回调应被忽略：只保留执行中一次update，事件总数不增，当前观察窗口无未处理拒绝。临时进程监听在finally移除。
	it("should ignore tool updates after the tool execution settles", async () => {
		// 构造无字段的封闭对象参数规则，{}合法，方便专注工具生命周期。
		const toolSchema = obj({});
		// 保存带status详情的可选更新回调；尚未进入工具时undefined。
		let delayedUpdate: AgentToolUpdateCallback<{ status: string }> | undefined;
		// 类型化事件数组供后续过滤/计数；push保留事件对象引用，不深复制消息内容。
		const events: AgentEvent[] = [];
		// 收集当前进程观察到的未处理Promise拒绝原因，unknown不假定是Error。
		const unhandledRejections: unknown[] = [];
		// Node进程事件监听器，只记录原因；它不修复或消费Agent内部逻辑。
		const onUnhandledRejection = (error: unknown) => {
			// 把每次unhandledRejection原因追加到观察列表。
			unhandledRejections.push(error);
		};
		// 定义能捕获onUpdate并立刻结束的工具；参数来自空obj，详情明确有status。
		const tool: AgentTool<typeof toolSchema, { status: string }> = {
			// 工具匹配名delayed_tool。
			name: "delayed_tool",
			// 展示标签Delayed Tool。
			label: "Delayed Tool",
			// 描述强调捕获进度回调，执行逻辑在下面方法。
			description: "Captures progress callbacks",
			// 复用本例参数schema；typeof toolSchema用于静态推导参数。
			parameters: toolSchema,
			// 执行期间保存进度函数、报告running，再返回done和terminate:true；忽略id/参数/signal，不做外部IO。
			async execute(_toolCallId, _params, _signal, onUpdate) {
				// 闭包保存本次执行传入的回调，工具完成后测试再调用同一引用。
				delayedUpdate = onUpdate;
				// 可选调用一次执行中进度；无回调则跳过，不抛缺函数错误。
				onUpdate?.({
					// 进度的模型可见文字为running。
					content: [{ type: "text", text: "running" }],
					// 进度详情status也为running。
					details: { status: "running" },
				});
				// 工具执行立即返回最终结果，不等待任何定时任务。
				return {
					// 最终可见文字为ok。
					content: [{ type: "text", text: "ok" }],
					// 最终详情status为done。
					details: { status: "done" },
					// 单工具批全部要求terminate，阻止工具结果之后自动再请求模型；它不等同取消信号。
					terminate: true,
				};
			},
		};
		// 建立加载这一个工具、模型mock会请求它的Agent。
		const agent = new Agent({
			// 执行集合和初始系统工具声明包含本例tool。
			initialState: { tools: [tool] },
			// 本例注入本地模拟流函数，不调用实际供应商请求实现。
			streamFn: () => {
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 把下面的模拟输出排到微任务，在当前同步调用栈结束后执行；不是等待真实模型。
				queueMicrotask(() => {
					// 模拟供应商发一个完整工具调用消息终值。
					stream.push({
						// 模型消息正常结束事件。
						type: "done",
						// 原因toolUse使低层进入工具执行。
						reason: "toolUse",
						// 用helper将一条工具请求包进assistant内容。
						message: createAssistantToolUseMessage([
							// 调用delayed_tool且参数{}，由真实Agent查找和校验后运行上面的fixture。
							{ type: "toolCall", id: "call-1", name: "delayed_tool", arguments: {} },
						]),
					});
				});
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});
		// 注册本例观察回调；真实Agent处理每条事件后会等待订阅者，再继续运行。
		agent.subscribe((event) => {
			// 把当前事件追加到观察数组，不向Agent重新发布它。
			events.push(event);
		});

		// 注册Node进程级unhandledRejection观察，副作用不局限于Agent实例；后面finally必须解除。
		process.on("unhandledRejection", onUnhandledRejection);
		// try覆盖实际运行、迟到回调与断言，保证出现测试失败也移除进程监听。
		try {
			// 等单工具运行和事件订阅全部结束，随后再调用保存的进度函数。
			await agent.prompt("run tool");
			// 记录完整结束时的事件总数作为迟到回调前基线。
			const eventCountAfterPrompt = events.length;

			// 可选调用工具之前拿到的旧onUpdate，模拟迟到进度；它不该复活已结束执行。
			delayedUpdate?.({
				// 迟到进度文字late，便于和执行中的running区别。
				content: [{ type: "text", text: "late" }],
				// 迟到详情也明确标late。
				details: { status: "late" },
			});
			// 跨一次定时器任务观察迟到回调影响；Node零延时也非立即同步执行，不证明所有未来后台任务都完成。
			await new Promise((resolve) => setTimeout(resolve, 0));

			// 只允许执行中那一次update；迟到调用不能添第二次。
			expect(events.filter((event) => event.type === "tool_execution_update")).toHaveLength(1);
			// 全部事件数量保持基线，不只是过滤后的update数不变。
			expect(events).toHaveLength(eventCountAfterPrompt);
			// 此窗口没有观察到未处理拒绝；不能扩展成所有未来异步任务绝不拒绝。
			expect(unhandledRejections).toEqual([]);
			// 无论成功失败都执行清理。
		} finally {
			// 用同一函数引用移除本例进程监听，不清空其他测试或宿主的监听器。
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	// 一批默认并行工具中，快工具结束而慢工具仍运行时，快工具旧进度仍应忽略。以屏障控制先后而非只等固定毫秒，不发真实请求。
	it("should ignore a settled parallel tool update while another tool is still running", async () => {
		// 构造无字段的封闭对象参数规则，{}合法，方便专注工具生命周期。
		const toolSchema = obj({});
		// 通知慢工具已进入execute的屏障。
		const slowStarted = createDeferred();
		// 通知快工具的tool_execution_end已被发布观察到。
		const settledToolEnded = createDeferred();
		// 控制慢工具什么时候完成，不是操作系统锁。
		const releaseSlow = createDeferred();
		// 保存快工具的本次进度函数，等它结束后测试再调用。
		let settledToolUpdate: AgentToolUpdateCallback<{ status: string }> | undefined;
		// 类型化事件数组供后续过滤/计数；push保留事件对象引用，不深复制消息内容。
		const events: AgentEvent[] = [];
		// 定义很快返回终止结果的本地工具。
		const settledTool: AgentTool<typeof toolSchema, { status: string }> = {
			// 快工具名称settled_tool。
			name: "settled_tool",
			// 展示标签Settled Tool。
			label: "Settled Tool",
			// 用途描述捕获进度回调。
			description: "Captures progress callbacks",
			// 复用本例参数schema；typeof toolSchema用于静态推导参数。
			parameters: toolSchema,
			// 快工具只保存onUpdate再返回，不主动报告执行中进度。
			async execute(_toolCallId, _params, _signal, onUpdate) {
				// 保存本次快工具更新函数供迟到模拟。
				settledToolUpdate = onUpdate;
				// 立即返回快工具终值，不等待慢工具。
				return {
					// 快工具可见结果done。
					content: [{ type: "text", text: "done" }],
					// 快工具详情标done。
					details: { status: "done" },
					// 快工具要求整批一致终止后续自动模型请求；慢工具也会给同标记。
					terminate: true,
				};
			},
		};
		// 另一个工具故意卡在测试屏障中，让Agent保持活跃。
		const slowTool: AgentTool<typeof toolSchema, { status: string }> = {
			// 慢工具匹配名slow_tool。
			name: "slow_tool",
			// 慢工具展示标签。
			label: "Slow Tool",
			// 描述本工具使运行保持进行中，实际由await屏障实现。
			description: "Keeps the agent run active",
			// 复用本例参数schema；typeof toolSchema用于静态推导参数。
			parameters: toolSchema,
			// 慢工具执行器先发开始通知，再等测试放行后返回；无外部IO。
			async execute() {
				// 解除slowStarted，使测试知道慢工具已经运行，而不是仅被排入准备列表。
				slowStarted.resolve();
				// 挂起当前工具直到releaseSlow完成，线程仍可处理其他Promise和事件。
				await releaseSlow.promise;
				// 屏障解除后返回慢工具终值。
				return {
					// 慢工具可见文字done。
					content: [{ type: "text", text: "done" }],
					// 慢工具status详情为done。
					details: { status: "done" },
					// 两工具终值都terminate:true，整批结束后不再自动请求。
					terminate: true,
				};
			},
		};
		// Agent默认工具策略parallel，两者可并发execute；准备/事件发布仍有自己的顺序。
		const agent = new Agent({
			// 把快慢两个真实本地工具加载进执行集合。
			initialState: { tools: [settledTool, slowTool] },
			// 本例注入本地模拟流函数，不调用实际供应商请求实现。
			streamFn: () => {
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 把下面的模拟输出排到微任务，在当前同步调用栈结束后执行；不是等待真实模型。
				queueMicrotask(() => {
					// 模拟一次含两个工具调用的模型终值。
					stream.push({
						// 发布模型消息结束事件。
						type: "done",
						// 原因toolUse，请求执行内容里的两个调用。
						reason: "toolUse",
						// 创建工具使用消息，内容顺序快在前慢在后。
						message: createAssistantToolUseMessage([
							// 第一调用id为call-1，目标快工具，参数为空对象。
							{ type: "toolCall", id: "call-1", name: "settled_tool", arguments: {} },
							// 第二调用id为call-2，目标慢工具；不是另一轮模型请求。
							{ type: "toolCall", id: "call-2", name: "slow_tool", arguments: {} },
						]),
					});
				});
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});
		// 注册本例观察回调；真实Agent处理每条事件后会等待订阅者，再继续运行。
		agent.subscribe((event) => {
			// 把当前事件追加到观察数组，不向Agent重新发布它。
			events.push(event);
			// 只在快工具的结束事件被观察时发通知，避免在它尚未结算时测试迟到回调。
			if (event.type === "tool_execution_end" && event.toolCallId === "call-1") {
				// 解除快工具已结束的观察屏障。
				settledToolEnded.resolve();
			}
		});

		// 先启动含两个本地工具的运行，保留Promise供并发中间状态断言后等待。
		const promptPromise = agent.prompt("run tools");
		// 同时等慢工具已开始和快工具已结束，建立要测试的并行中间状态。
		await Promise.all([slowStarted.promise, settledToolEnded.promise]);
		// 记录迟到进度调用前所有事件总数，慢工具此时仍卡在屏障。
		const eventCountBeforeLateUpdate = events.length;

		// 模拟快工具已完成后的旧onUpdate，即使Agent整批还活跃也不该接受。
		settledToolUpdate?.({
			// 迟到内容late。
			content: [{ type: "text", text: "late" }],
			// 迟到详情late。
			details: { status: "late" },
		});
		// 跨一次定时器任务观察迟到回调影响；Node零延时也非立即同步执行，不证明所有未来后台任务都完成。
		await new Promise((resolve) => setTimeout(resolve, 0));
		// 让一次任务推进后事件总数仍应不变。
		expect(events).toHaveLength(eventCountBeforeLateUpdate);

		// 放行慢工具，使整批运行能够正常收尾，避免留悬挂Promise。
		releaseSlow.resolve();
		// 等前面已启动的运行及订阅者真正收尾，不会再启动新一轮。
		await promptPromise;
		// 两工具执行中均未主动发update，所以完成后update总数应0。
		expect(events.filter((event) => event.type === "tool_execution_update")).toHaveLength(0);
	});

	// 直接设置模型、思考、工具及消息，检查setter只浅复制数组；push保留消息引用。此例用as any简化不完整fixture，不证明非法工具可实际执行。
	it("should update state with mutators", () => {
		// 创建只供状态/队列断言的Agent；若误触模型请求，unusedStreamFunction会立刻抛错。
		const agent = new Agent({ streamFn: unusedStreamFunction });

		// Test setModel
		// 仅从本地内置目录取Google模型元数据，不加载ADC或请求Google。
		const newModel = getModel("google", "gemini-2.5-flash");
		// 把状态model引用替换为该模型对象。
		agent.state.model = newModel;
		// toBe要求引用身份相同，不只是字段相等。
		expect(agent.state.model).toBe(newModel);

		// Test setThinkingLevel
		// 直接赋high思考设置。
		agent.state.thinkingLevel = "high";
		// 检查getter可读回同一字面量。
		expect(agent.state.thinkingLevel).toBe("high");

		// Test setTools
		// 用as any刻意绕过AgentTool缺label/schema/execute的静态错误；实际对象仍缺这些字段，本例不运行它。
		const tools = [{ name: "test", description: "test tool" } as any];
		// 工具数组setter浅拷贝输入数组，内部工具对象仍共享。
		agent.state.tools = tools;
		// 比较数组内容不变。
		expect(agent.state.tools).toEqual(tools);
		// 引用不相等证明复制顶层数组，不证明工具对象被深复制。
		expect(agent.state.tools).not.toBe(tools); // Should be a copy

		// Test replaceMessages
		// as const保留role:user字面量供消息联合匹配；此处不冻结对象或数组。
		const messages = [{ role: "user" as const, content: "Hello", timestamp: Date.now() }];
		// 消息setter同样只浅复制最外层数组。
		agent.state.messages = messages;
		// 深比较历史内容与输入一致。
		expect(agent.state.messages).toEqual(messages);
		// 根数组引用不同，不声称内部消息独立拷贝。
		expect(agent.state.messages).not.toBe(messages); // Should be a copy

		// Test appendMessage
		// 构造不完整assistant fixture，as const保留角色及块标签字面量，尚缺完整协议元数据。
		const newMessage = { role: "assistant" as const, content: [{ type: "text" as const, text: "Hi" }] };
		// as any放宽push类型检查，数组中保存原消息引用；不执行运行时schema验证。
		agent.state.messages.push(newMessage as any);
		// 先前一条user加新assistant后长度为2。
		expect(agent.state.messages).toHaveLength(2);
		// 第1项正是newMessage引用，表明push不深复制。
		expect(agent.state.messages[1]).toBe(newMessage);

		// Test clearMessages
		// 用新空数组替换消息历史。
		agent.state.messages = [];
		// 确认清空成功；这只是state赋值，不等同reset保留system基线。
		expect(agent.state.messages).toEqual([]);
	});

	// steer应只排队而不立即改已提交历史；构造一条插话后检查历史里尚无它。本例不启动运行，因此不验证后续投递顺序。
	it("should support steering message queue", async () => {
		// 创建只供状态/队列断言的Agent；若误触模型请求，unusedStreamFunction会立刻抛错。
		const agent = new Agent({ streamFn: unusedStreamFunction });

		// as const保留user字面量，正文是字符串，时间取本机当前毫秒；不是已发送消息。
		const message = { role: "user" as const, content: "Steering message", timestamp: Date.now() };
		// 把message加入steering队列，不直接push到state.messages。
		agent.steer(message);

		// The message is queued but not yet in state.messages
		// not.toContainEqual按内容查找，确认历史还没有这条消息；本行不读取队列内部长度。
		expect(agent.state.messages).not.toContainEqual(message);
	});

	// followUp同样只排队；本例验证没有提前写入历史，不验证实际运行后何时消费。async回调这里没有await，不等同自动发生后台任务。
	it("should support follow-up message queue", async () => {
		// 创建只供状态/队列断言的Agent；若误触模型请求，unusedStreamFunction会立刻抛错。
		const agent = new Agent({ streamFn: unusedStreamFunction });

		// 创建一条user追问fixture，as const只保留类型字面量，不冻结对象。
		const message = { role: "user" as const, content: "Follow-up message", timestamp: Date.now() };
		// 加入较低优先级的follow-up队列，尚不启动模型请求。
		agent.followUp(message);

		// The message is queued but not yet in state.messages
		// 按深相等确认历史没有提前出现该追问。
		expect(agent.state.messages).not.toContainEqual(message);
	});

	// 空闲Agent调用abort应无异常；不在本例证明真实运行或外部工具会被中止。
	it("should handle abort controller", () => {
		// 创建只供状态/队列断言的Agent；若误触模型请求，unusedStreamFunction会立刻抛错。
		const agent = new Agent({ streamFn: unusedStreamFunction });

		// Should not throw even if nothing is running
		// 把调用包成箭头交给not.toThrow，捕获同步异常；核心可选链无activeRun时直接跳过。
		expect(() => agent.abort()).not.toThrow();
	});

	// 模拟流已start但未done时reset必须抛错且不能破坏历史；finally放行回复并等运行结束，再检查user/assistant均保留。
	it("should reject reset while processing without corrupting the transcript", async () => {
		// 建立开始通知屏障，保证断言发生在模拟流已发布start之后。
		const streamStarted = createDeferred();
		// 建立人为控制的响应屏障，稍后resolve才允许模拟回复完成。
		const releaseResponse = createDeferred();
		// 使用可由测试屏障控制结束时刻的本地流。
		const agent = new Agent({
			// 本例注入本地模拟流函数，不调用实际供应商请求实现。
			streamFn: () => {
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// async微任务先发start再await屏障；queueMicrotask不会自动处理回调返回的Promise拒绝，本fixture依赖这些步骤正常完成。
				queueMicrotask(async () => {
					// 发布开始事件和空文字草稿；fixture虽用stop初值，整体流仍需后续终止事件才能完成。
					stream.push({ type: "start", partial: createAssistantMessage("") });
					// 通知测试模拟流已开始，避免只靠sleep猜启动时机。
					streamStarted.resolve();
					// 等测试主动放行，保证reset断言期间运行尚未结束。
					await releaseResponse.promise;
					// 放行后发Done终值，让Agent能完成并清理busy状态。
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});

		// 启动prompt并保存Promise，先不等待完整回复。
		const promptPromise = agent.prompt("Hello");
		// 只等模拟start发生；Agent最终assistant仍未提交。
		await streamStarted.promise;

		// 用try/finally确保断言失败时也放行挂起的响应，避免泄漏未结束运行。
		try {
			// 此刻Agent仍有活跃运行，isStreaming包括工具和等待订阅者阶段，不仅表示网络正在吐字。
			expect(agent.state.isStreaming).toBe(true);
			// 历史此时只有已提交user；流式assistant草稿不等于正式完整历史。
			expect(agent.state.messages.map((message) => message.role)).toEqual(["user"]);
			// reset同步抛错，toThrow字符串检查消息包含该文案；不把错误当可恢复重置成功。
			expect(() => agent.reset()).toThrow("Agent is already processing. Wait for completion before resetting.");
			// 此刻Agent仍有活跃运行，isStreaming包括工具和等待订阅者阶段，不仅表示网络正在吐字。
			expect(agent.state.isStreaming).toBe(true);
			// 拒绝reset后历史角色仍只有user，证明未被清空或插入多余消息。
			expect(agent.state.messages.map((message) => message.role)).toEqual(["user"]);
			// 无论断言成败都运行收尾，不静默吞掉失败。
		} finally {
			// 解除模拟响应屏障，让悬挂请求继续发done。
			releaseResponse.resolve();
			// 等前面已启动的运行及订阅者真正收尾，不会再启动新一轮。
			await promptPromise;
		}

		// 断言Agent已完成运行清理，进入可接受下一次prompt的空闲状态。
		expect(agent.state.isStreaming).toBe(false);
		// 正常收尾后已提交历史应为user再assistant，初始没有系统配置所以无需system。
		expect(agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	// 已有prompt活跃时第二个prompt应reject忙碌错误，随后发abort清理本地轮询流。这里的错误为async函数Promise拒绝，不是调用时同步throw。
	it("should throw when prompt() called while streaming", async () => {
		// 信号初始未赋值，联合undefined要求后面用可选链或判断读取。
		let abortSignal: AbortSignal | undefined;
		// 配置会观察取消信号的本地流，让第一轮保持活跃。
		const agent = new Agent({
			// Use a stream function that responds to abort
			// 注入本地流函数，只读取真实Agent转交的options，忽略模型和上下文；无实际模型请求。
			streamFn: (_model, _context, options) => {
				// 保存真实Agent传给本地streamFn的可选取消信号，供定时轮询观察。
				abortSignal = options?.signal;
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 把下面的模拟输出排到微任务，在当前同步调用栈结束后执行；不是等待真实模型。
				queueMicrotask(() => {
					// 发布开始事件和空文字草稿；fixture虽用stop初值，整体流仍需后续终止事件才能完成。
					stream.push({ type: "start", partial: createAssistantMessage("") });
					// Check abort signal periodically
					// 定义模拟流的取消轮询：已取消则发错误终止，否则稍后再次检查；只在此fixture中使用。
					const checkAbort = () => {
						// 读取已保存的第一轮信号；取消后才生成终止事件。
						if (abortSignal?.aborted) {
							// 发aborted终止事件，但消息helper的stopReason仍是stop；本例重点是信号/忙碌拒绝，不独立验证最终消息的取消原因。
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
							// 否则继续5ms轮询，不结束第一轮。
						} else {
							// 未取消时安排约5毫秒后重查，实际时刻由事件循环决定；没有同步忙等。
							setTimeout(checkAbort, 5);
						}
					};
					// 启动第一次取消检查，后续由上面的定时器递续。
					checkAbort();
				});
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});

		// Start first prompt (don't await, it will block until abort)
		// 启动第一轮但不等待，使第二次prompt/continue可以在忙碌状态下调用。
		const firstPrompt = agent.prompt("First message");

		// Wait a tick for isStreaming to be set
		// 等一次约10毫秒的定时器，给微任务/模拟流推进机会；调度可能更晚，不是精确时间或任意机器上的完成保证。
		await new Promise((resolve) => setTimeout(resolve, 10));
		// 此刻Agent仍有活跃运行，isStreaming包括工具和等待订阅者阶段，不仅表示网络正在吐字。
		expect(agent.state.isStreaming).toBe(true);

		// Second prompt should reject
		// 第二次prompt返回Promise，rejects等待其拒绝并匹配Error消息；这里没有向普通队列加入Second message。
		await expect(agent.prompt("Second message")).rejects.toThrow(
			// 要求忙碌文案指出steer/followUp替代入口；字符串匹配是包含，不校验整条Error对象。
			"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
		);

		// Cleanup - abort to stop the stream
		// 对当前运行的AbortController发取消信号；模拟流要自行观察并发布结束事件，不是强制杀线程。
		agent.abort();
		// 取消后等待原prompt并忽略可能的拒绝；本例没有用finally包住前面的断言，不能宣称断言失败也一定完成此清理。
		await firstPrompt.catch(() => {}); // Ignore abort error
	});

	// 第一轮prompt仍忙时continue也应reject；之后abort让fixture终止。与上例区分两种入口的忙碌文案，不涉及真正的网络中断。
	it("should throw when continue() called while streaming", async () => {
		// 信号初始未赋值，联合undefined要求后面用可选链或判断读取。
		let abortSignal: AbortSignal | undefined;
		// 本地流同样靠取消轮询才结束，便于制造活跃状态。
		const agent = new Agent({
			// 注入本地流函数，只读取真实Agent转交的options，忽略模型和上下文；无实际模型请求。
			streamFn: (_model, _context, options) => {
				// 保存真实Agent传给本地streamFn的可选取消信号，供定时轮询观察。
				abortSignal = options?.signal;
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 把下面的模拟输出排到微任务，在当前同步调用栈结束后执行；不是等待真实模型。
				queueMicrotask(() => {
					// 发布开始事件和空文字草稿；fixture虽用stop初值，整体流仍需后续终止事件才能完成。
					stream.push({ type: "start", partial: createAssistantMessage("") });
					// 定义模拟流的取消轮询：已取消则发错误终止，否则稍后再次检查；只在此fixture中使用。
					const checkAbort = () => {
						// 若第一轮信号已取消，转发模拟aborted事件。
						if (abortSignal?.aborted) {
							// 发aborted终止事件，但消息helper的stopReason仍是stop；本例重点是信号/忙碌拒绝，不独立验证最终消息的取消原因。
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
							// 未取消则继续安排轮询。
						} else {
							// 未取消时安排约5毫秒后重查，实际时刻由事件循环决定；没有同步忙等。
							setTimeout(checkAbort, 5);
						}
					};
					// 启动第一次取消检查，后续由上面的定时器递续。
					checkAbort();
				});
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});

		// Start first prompt
		// 启动第一轮但不等待，使第二次prompt/continue可以在忙碌状态下调用。
		const firstPrompt = agent.prompt("First message");
		// 等一次约10毫秒的定时器，给微任务/模拟流推进机会；调度可能更晚，不是精确时间或任意机器上的完成保证。
		await new Promise((resolve) => setTimeout(resolve, 10));
		// 此刻Agent仍有活跃运行，isStreaming包括工具和等待订阅者阶段，不仅表示网络正在吐字。
		expect(agent.state.isStreaming).toBe(true);

		// continue() should reject
		// continue是async入口，使用rejects等待忙碌错误；不能写成expect(() => continue()).toThrow来捕获Promise拒绝。
		await expect(agent.continue()).rejects.toThrow(
			// 匹配continue专用忙碌提示。
			"Agent is already processing. Wait for completion before continuing.",
		);

		// Cleanup
		// 对当前运行的AbortController发取消信号；模拟流要自行观察并发布结束事件，不是强制杀线程。
		agent.abort();
		// 等第一轮收尾并吞掉可能的拒绝，避免清理路径把取消异常漏成未处理拒绝；不要求它一定reject。
		await firstPrompt.catch(() => {});
	});

	// 当历史以assistant结尾，continue可先取排队follow-up作为新输入再运行；检查追问真的进入历史并最终又有assistant。只用本地Processed回复。
	it("continue() should process queued follow-up messages after an assistant turn", async () => {
		// 构造立即返回Processed的模拟Agent。
		const agent = new Agent({
			// 本例注入本地模拟流函数，不调用实际供应商请求实现。
			streamFn: () => {
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 把下面的模拟输出排到微任务，在当前同步调用栈结束后执行；不是等待真实模型。
				queueMicrotask(() => {
					// 用Processed终值结束模拟回答，不发中间文字增量。
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Processed") });
				});
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});

		// 直接给一轮已完成历史；setter浅复制数组，内容对象仍复用。
		agent.state.messages = [
			{
				// 历史第一条user。
				role: "user",
				// 用户内容采用text块数组，与createUserMessage的字符串形式并存。
				content: [{ type: "text", text: "Initial" }],
				// 人为把user时间设为当前约10毫秒以前，不靠这个时间戳控制队列调度。
				timestamp: Date.now() - 10,
			},
			// 历史末尾已是assistant，所以continue要从队列取新输入才能继续。
			createAssistantMessage("Initial response"),
		];

		// 排一个带内容块的follow-up，当前不立即写进历史。
		agent.followUp({
			// 追问角色为user。
			role: "user",
			// 用固定Queued follow-up文字供后面在历史中查找。
			content: [{ type: "text", text: "Queued follow-up" }],
			// 读取本机当前Unix毫秒作为消息时间，不要求每次调用得到不同值。
			timestamp: Date.now(),
		});

		// 等待continue resolve void；结果不直接返回新回复，改由state读取。
		await expect(agent.continue()).resolves.toBeUndefined();

		// some查找任一匹配追问用户消息，找到就短路返回true。
		const hasQueuedFollowUp = agent.state.messages.some((message) => {
			// 非user立即排除，角色判断也使TS知道后面是UserMessage内容。
			if (message.role !== "user") return false;
			// 用户内容允许字符串或块数组；字符串分支直接比较正文。
			if (typeof message.content === "string") return message.content === "Queued follow-up";
			// 块数组用some找text标签且文字相同的任一块，忽略图片及其他文字。
			return message.content.some((part) => part.type === "text" && part.text === "Queued follow-up");
		});

		// 确认追问已投递进历史；不由此限定整段历史所有条数。
		expect(hasQueuedFollowUp).toBe(true);
		// 末项为assistant，说明本地续轮已经生成完整回答。
		expect(agent.state.messages[agent.state.messages.length - 1].role).toBe("assistant");
	});

	// 参数化两种插话消费模式：assistant末尾的continue兜底应遵守一次一条/一次全取，分别形成2或1次模型请求。每行登记一个用例。
	it.each([
		// one-at-a-time字面量通过as const保留；两条插话应分两次请求投递。
		{ mode: "one-at-a-time" as const, expectedRequests: 2 },
		// all模式一轮取两条，预期只有一次请求。
		{ mode: "all" as const, expectedRequests: 1 },
		// Vitest用表中mode替换标题，解构参数后执行同一场景；不是在运行中从字符串解析配置。
	])("continue() keeps $mode steering semantics for assistant-tail fallback", async ({ mode, expectedRequests }) => {
		// 保存每次请求投影出的字符串列表；二维数组外层计请求，内层计这次可见输入，不保存完整上下文快照。
		const requests: string[][] = [];
		// 真实Agent使用本行的插话模式和本地流。
		const agent = new Agent({
			// 设定steering队列每次drain策略。
			steeringMode: mode,
			// 本地模拟请求函数忽略模型，但检查真实低层循环传来的规范轨迹；没有网络调用。
			streamFn: (_model, context) => {
				// 每次模拟请求记录可见用户字符串，供比较是否一次误取两条。
				requests.push(
					// flatMap把每条user字符串映成一项，其他消息映为空数组并消去。
					context.messages.flatMap((message) =>
						// 只记录string形式的user；本例helper都产生这种形式，不能扩展成已记录所有内容块文本。
						message.role === "user" && typeof message.content === "string" ? [message.content] : [],
					),
				);
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 把下面的模拟输出排到微任务，在当前同步调用栈结束后执行；不是等待真实模型。
				queueMicrotask(() => {
					// 用Processed终值结束模拟回答，不发中间文字增量。
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Processed") });
				});
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});
		// 设为已有user/assistant完成历史，触发Agent.continue专门的assistant尾队列兜底。
		agent.state.messages = [createUserMessage("Initial"), createAssistantMessage("Initial response")];
		// 排第一条高优先级插话，不立即改历史。
		agent.steer(createUserMessage("Steering 1"));
		// 排第二条插话，FIFO顺序接在第一条后面。
		agent.steer(createUserMessage("Steering 2"));

		// 等队列续跑完成，确认无额外返回值；两种mode会发不同数量本地请求。
		await expect(agent.continue()).resolves.toBeUndefined();

		// 按表里预期检查请求次数，防止assistant-tail已drain后低层启动又额外取一次。
		expect(requests).toHaveLength(expectedRequests);
		// 第一请求必须含第一条插话。
		expect(requests[0]).toContain("Steering 1");
		// 一次一条模式走分请求断言，TS此时mode也被收窄为该字面量。
		if (mode === "one-at-a-time") {
			// 第一请求不应提前含第二条。
			expect(requests[0]).not.toContain("Steering 2");
			// 第二次请求才应含第二条；它也带之前已提交历史。
			expect(requests[1]).toContain("Steering 2");
			// 剩余all模式可一次消费全部插话。
		} else {
			// 第一请求同时含第二条，和第一条一起投递。
			expect(requests[0]).toContain("Steering 2");
		}
	});

	// 兼容旧prepareNextTurn(signal)签名：先工具回合再正常回答，检查回调收到AbortSignal且共两请求。不是新版withContext钩子的测试。
	it("keeps legacy prepareNextTurn signal callback behavior", async () => {
		// 为noop工具构造空对象参数规则，不执行任何工具。
		const schema = obj({});
		// 定义执行后需要让模型读结果再回答的noop工具，未设terminate。
		const tool: AgentTool<typeof schema> = {
			// noop只是本地工具名字，不是外部命令。
			name: "noop",
			// 给noop提供展示标签。
			label: "Noop",
			// 补齐工具用途说明。
			description: "Noop tool",
			// 引用本例的空对象规则，后续真实参数校验按它接受{}。
			parameters: schema,
			// noop执行器返回固定ok文字；async把结果包装成Promise，不做外部IO。
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		// 计实际进入mock请求函数次数，用来首轮发工具、次轮发文字。
		let requestCount = 0;
		// 记录旧钩子参数是否真为当前宿主AbortSignal实例，不只看TS类型。
		let sawAbortSignal = false;
		// 创建带noop和旧准备钩子的Agent。
		const agent = new Agent({
			// 初始加载noop，也会生成system工具声明。
			initialState: { tools: [tool] },
			// 旧prepareNextTurn参数是signal；async返回undefined表示不更新状态，下一轮照原上下文继续。
			prepareNextTurn: async (signal) => {
				// instanceof是测试运行对象身份的断言准备，不靠参数名字就认定是信号。
				sawAbortSignal = signal instanceof AbortSignal;
				// 本回调明确不返回状态更新，调用方应保留当前配置/上下文。
				return undefined;
			},
			// 本例注入本地模拟流函数，不调用实际供应商请求实现。
			streamFn: () => {
				// mock被调用时计数，决定响应哪一轮；不读远端request id。
				requestCount++;
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 把下面的模拟输出排到微任务，在当前同步调用栈结束后执行；不是等待真实模型。
				queueMicrotask(() => {
					// 首请求返回工具调用而非最终普通回答。
					if (requestCount === 1) {
						// 创建含一条noop的工具使用消息。
						const message = createAssistantToolUseMessage([
							// 工具调用id/tool-1和名字noop对应运行集合，{}符合空schema。
							{ type: "toolCall", id: "tool-1", name: "noop", arguments: {} },
						]);
						// 完成这条模拟模型输出并声明toolUse，真实Agent下一步将按其中工具块执行本地fixture工具。
						stream.push({ type: "done", reason: "toolUse", message });
						// 从微任务回调返回，避免首轮紧接着再向同一流发普通done。
						return;
					}
					// 第二次请求构造正常done文字，结束整个对话循环。
					const message = createAssistantMessage("done");
					// 把前面构造的message作为done终值；它会由真实低层循环转成message生命周期事件。
					stream.push({ type: "done", reason: "stop", message });
				});
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});

		// 启动并等待完整本地模拟运行；可能包含模型回复、工具及后续回合。
		await agent.prompt("start");

		// 首轮工具、次轮文字合计2次请求，不是仅两个流事件。
		expect(requestCount).toBe(2);
		// 确认旧prepareNextTurn确实接到了本机AbortSignal实例。
		expect(sawAbortSignal).toBe(true);
	});

	// finishTurn经AgentOptions透传给低层并得到活跃信号/已含工具结果的上下文；返回end应阻止工具后的第二次模型请求。
	it("forwards finishTurn through AgentOptions with the active abort signal", async () => {
		// 为noop工具构造空对象参数规则，不执行任何工具。
		const schema = obj({});
		// 工具仍是不带terminate的noop，停止的原因应来自finishTurn决定。
		const tool: AgentTool<typeof schema> = {
			// noop只是本地工具名字，不是外部命令。
			name: "noop",
			// 给noop提供展示标签。
			label: "Noop",
			// 补齐工具用途说明。
			description: "Noop tool",
			// 引用本例的空对象规则，后续真实参数校验按它接受{}。
			parameters: schema,
			// 工具执行仅返回tool complete文字和空详情，不自行停止模型循环。
			execute: async () => ({ content: [{ type: "text", text: "tool complete" }], details: {} }),
		};
		// 计请求次数以验证第二轮未发生。
		let requestCount = 0;
		// 观察finishTurn收到的运行信号。
		let sawAbortSignal = false;
		// 保存钩子看到的上下文角色投影，不保存全量消息副本。
		let callbackContextRoles: string[] = [];
		// 构造配置finishTurn的真实Agent。
		const agent = new Agent({
			// 工具集合含noop。
			initialState: { tools: [tool] },
			// 回合完成钩子在模型及工具结果追加后运行；读取上下文/信号并决定结束。
			finishTurn: (context, signal) => {
				// 运行时检查钩子第二参数是本机AbortSignal实例。
				sawAbortSignal = signal instanceof AbortSignal;
				// context外层是回合快照，context.context才是消息/工具上下文；map提取消息角色。
				callbackContextRoles = context.context.messages.map((message) => message.role);
				// action:end让低层直接结束，不再取队列或自动工具后续。
				return { action: "end" };
			},
			// 本例注入本地模拟流函数，不调用实际供应商请求实现。
			streamFn: () => {
				// 每次模拟模型请求加一，后面断言应只到1。
				requestCount++;
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 把下面的模拟输出排到微任务，在当前同步调用栈结束后执行；不是等待真实模型。
				queueMicrotask(() => {
					// 首轮发noop工具调用，走真实工具管线。
					if (requestCount === 1) {
						// 构造完整工具请求回复。
						const message = createAssistantToolUseMessage([
							// 唯一工具为noop，参数{}。
							{ type: "toolCall", id: "tool-1", name: "noop", arguments: {} },
						]);
						// 完成这条模拟模型输出并声明toolUse，真实Agent下一步将按其中工具块执行本地fixture工具。
						stream.push({ type: "done", reason: "toolUse", message });
						// 首轮发toolUse后立刻退出微任务分支。
						return;
					}
					// 如果误发第二次请求会走这个should not run回复；并非此行定义就立即执行。
					const message = createAssistantMessage("should not run");
					// 把前面构造的message作为done终值；它会由真实低层循环转成message生命周期事件。
					stream.push({ type: "done", reason: "stop", message });
				});
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});

		// 启动并等待完整本地模拟运行；可能包含模型回复、工具及后续回合。
		await agent.prompt("start");

		// finishTurn已end，所以只允许第一次工具模型请求。
		expect(requestCount).toBe(1);
		// 确认钩子实际收到信号。
		expect(sawAbortSignal).toBe(true);
		// 钩子上下文依次含初始工具system、用户、工具调用assistant、工具结果；没有额外普通回答。
		expect(callbackContextRoles).toEqual(["system", "user", "assistant", "toolResult"]);
	});

	// 参数化空历史与只有system两种不可续跑情形：即使两队列有消息也应先拒绝，不提前消费。每行独立一例，不启动模拟模型。
	it.each([
		// empty情形直接没有历史。
		{ name: "empty", messages: [] },
		// system-only只有配置没有可续答输入；as const保留角色标签，固定时间戳。
		{ name: "system-only", messages: [{ role: "system" as const, content: "system only", timestamp: 1 }] },
		// 标题用name标识场景，回调只解构messages交给同一断言过程。
	])("rejects a queued continuation from $name context without draining queues", async ({ messages }) => {
		// 创建待测历史的Agent；unusedStreamFunction确保这里不应进入请求。
		const agent = new Agent({ initialState: { messages }, streamFn: unusedStreamFunction });
		// 准备较高优先级插话。
		const steering = createUserMessage("steering");
		// 建立独立的follow-up追问消息，先保存数据，具体投递时机由Agent入口及低层队列调度决定。
		const followUp = createUserMessage("follow-up");
		// 把steering入队，先于follow-up被peek选择。
		agent.steer(steering);
		// 把该消息加入follow-up队列，尚不立即追加到历史或启动新运行。
		agent.followUp(followUp);

		// continue先校验历史并reject；字符串toThrow是消息包含匹配，不比较Error身份。
		await expect(agent.continue()).rejects.toThrow("No messages to continue from");
		// 拒绝后高优先级插话仍可预览，说明没被错误drain。
		expect(agent.peekQueuedMessages()).toEqual([steering]);
		// 清空插话队列，供下一次peek观察较低优先级follow-up；不是消费所有类型的消息。
		agent.clearSteeringQueue();
		// 插话清空后预览应选出follow-up，确认它尚未被本次运行消费；toEqual比较内容，不消费队列。
		expect(agent.peekQueuedMessages()).toEqual([followUp]);
	});

	// 参数化user末尾与toolResult末尾两种合法续跑历史；follow-up先等现有输入获得一轮回答，再进入第二轮。
	it.each([
		{
			// 本组场景标记user，用于测试标题。
			name: "user",
			// 只有一条既有用户输入，适合直接continue，不需要新增普通prompt消息。
			messages: [createUserMessage("existing user")],
		},
		{
			// 另一个场景以已完成工具结果作为最后一条消息。
			name: "toolResult",
			// 构造工具请求及结果已经配对的历史。
			messages: [
				// 最初用户输入。
				createUserMessage("existing user"),
				// 接一条包含noop请求的assistant，id为call-1。
				createAssistantToolUseMessage([{ type: "toolCall", id: "call-1", name: "noop", arguments: {} }]),
				{
					// 工具结果角色用as const保留，供TS匹配消息联合；不是此刻执行工具。
					role: "toolResult" as const,
					// 结果通过同一调用id与之前的noop请求对应。
					toolCallId: "call-1",
					// 工具名字也记录noop，供历史/请求转换使用。
					toolName: "noop",
					// 结果内容为done文字块，type同样保留字面量；没有真正调用外部工具。
					content: [{ type: "text" as const, text: "done" }],
					// 这条既有工具结果按成功记录，不是模型请求本身的stopReason。
					isError: false,
					// 固定时间戳便于比较是否保留原消息元数据，不代表真实墙钟时间。
					timestamp: 1,
				},
			],
		},
		// 对两种历史重复同一续跑流程，name填入标题，messages作为初始已提交历史。
	])("defers follow-up input on the first continuation request from a $name tail", async ({ messages }) => {
		// 保存每次请求投影出的字符串列表；二维数组外层计请求，内层计这次可见输入，不保存完整上下文快照。
		const requests: string[][] = [];
		// 创建本例真实Agent实例，接下来的选项配置本地模拟依赖；构造本身不执行prompt。
		const agent = new Agent({
			// 属性简写把本行历史传给Agent，构造时浅复制根数组。
			initialState: { messages },
			// 本地模拟请求函数忽略模型，但检查真实低层循环传来的规范轨迹；没有网络调用。
			streamFn: (_model, context) => {
				// 每次本地请求记录所有user字符串，供判断follow-up进入的轮次。
				requests.push(
					// flatMap将用户字符串保留为一项，其他消息过滤成空数组。
					context.messages.flatMap((message) =>
						// 只记录string用户正文；本例已有用户及follow-up都由helper构造成字符串。
						message.role === "user" && typeof message.content === "string" ? [message.content] : [],
					),
				);
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 单表达式微任务回调，延后发正常终值，不加外部延时。
				queueMicrotask(() =>
					// 以固定done文字完成本次本地模型流。
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") }),
				);
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});
		// 预先排follow-up，不把它当第一轮现有输入立即追加。
		agent.followUp(createUserMessage("follow-up"));

		// 从现有user/toolResult尾部继续；等先回答，再自动消费follow-up的整次运行。
		await agent.continue();

		// 当前输入一轮、follow-up一轮，共两次mock请求。
		expect(requests).toHaveLength(2);
		// 首次请求不应提前含follow-up。
		expect(requests[0]).not.toContain("follow-up");
		// 第二次才带上follow-up；仍会携带之前历史。
		expect(requests[1]).toContain("follow-up");
	});

	// 再按one-at-a-time/all参数化：与assistant尾兜底不同，这里从user尾直接走低层启动插话读取，仍应分别产生2或1次请求。
	it.each([
		// 一次一条的预期为2次请求，两条插话分开交模型。
		{ mode: "one-at-a-time" as const, expectedRequests: 2 },
		// 一次全取的预期为1次请求。
		{ mode: "all" as const, expectedRequests: 1 },
		// 从表中解构mode和期望请求数，给每种模式创建独立Agent。
	])("polls $mode steering at continuation startup", async ({ mode, expectedRequests }) => {
		// 保存每次请求投影出的字符串列表；二维数组外层计请求，内层计这次可见输入，不保存完整上下文快照。
		const requests: string[][] = [];
		// 创建本例真实Agent实例，接下来的选项配置本地模拟依赖；构造本身不执行prompt。
		const agent = new Agent({
			// 历史末尾是existing用户，直接续跑入口合法。
			initialState: { messages: [createUserMessage("existing")] },
			// 配置插话队列本次取出策略。
			steeringMode: mode,
			// 本地模拟请求函数忽略模型，但检查真实低层循环传来的规范轨迹；没有网络调用。
			streamFn: (_model, context) => {
				// 记录本次请求可见用户文本，观察启动消费插话。
				requests.push(
					// 逐条历史做字符串投影并展开。
					context.messages.flatMap((message) =>
						// 只包含user字符串，不把system/assistant/toolResult当用户输入。
						message.role === "user" && typeof message.content === "string" ? [message.content] : [],
					),
				);
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 用微任务稍后发布done，先把流返回Agent。
				queueMicrotask(() =>
					// 正常完成模拟回答；没有工具调用，所以后续请求来自队列而非工具。
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") }),
				);
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});
		// 按FIFO排first插话。
		agent.steer(createUserMessage("first"));
		// 接着排second插话。
		agent.steer(createUserMessage("second"));

		// 启动续跑并等所有选中队列后续处理完。
		await agent.continue();

		// 按模式断言mock请求数量。
		expect(requests).toHaveLength(expectedRequests);
		// 不论哪种mode，首次请求都应已看到first。
		expect(requests[0]).toContain("first");
		// 一次一条模式检查分轮投递。
		if (mode === "one-at-a-time") {
			// 首次没有second，避免启动重复drain。
			expect(requests[0]).not.toContain("second");
			// 后续请求才带second。
			expect(requests[1]).toContain("second");
			// all模式检查同轮一起投递。
		} else {
			// 首次请求已经包含second。
			expect(requests[0]).toContain("second");
		}
	});

	// 在user尾continue时同时排steering/follow-up，应先插话再等自然停止取追问；检查两请求可见输入，不只检查最终历史含两条。
	it("keeps steering ahead of follow-up from a non-assistant continuation tail", async () => {
		// 保存每次请求投影出的字符串列表；二维数组外层计请求，内层计这次可见输入，不保存完整上下文快照。
		const requests: string[][] = [];
		// 创建本例真实Agent实例，接下来的选项配置本地模拟依赖；构造本身不执行prompt。
		const agent = new Agent({
			// 已有用户消息构成合法非assistant续跑尾。
			initialState: { messages: [createUserMessage("existing")] },
			// 本地模拟请求函数忽略模型，但检查真实低层循环传来的规范轨迹；没有网络调用。
			streamFn: (_model, context) => {
				// 把请求用户正文投影记下来。
				requests.push(
					// flatMap把一条user字符串变一项，其余角色不记录。
					context.messages.flatMap((message) =>
						// 显式区分字符串与块数组；本例helper均用字符串。
						message.role === "user" && typeof message.content === "string" ? [message.content] : [],
					),
				);
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 微任务异步交付本地回答终值。
				queueMicrotask(() =>
					// done+stop使当前回合自然结束，之后才轮到低优先级follow-up。
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") }),
				);
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});
		// 加入高优先级steering插话。
		agent.steer(createUserMessage("steering"));
		// 再加入独立follow-up队列；入队顺序不是两者优先级的唯一依据。
		agent.followUp(createUserMessage("follow-up"));

		// 等续跑及队列后续全部结束。
		await agent.continue();

		// 两种输入分两轮处理，共两次模型mock调用。
		expect(requests).toHaveLength(2);
		// 第一请求带steering。
		expect(requests[0]).toContain("steering");
		// 第一请求尚无follow-up。
		expect(requests[0]).not.toContain("follow-up");
		// 第二请求才含follow-up。
		expect(requests[1]).toContain("follow-up");
	});

	// 用error/aborted两种失败终值参数化：即使finishTurn要求continue，失败仍应硬退出且保留排队消息。as const保存只读字面量元组供类型推导。
	it.each(["error", "aborted"] as const)(
		// 标题中的%s由本行stopReason填入，便于区分两例。
		"keeps queues on a %s response even when finishTurn requests continuation",
		// 异步用例接收当前失败原因，后面同时用于事件reason和消息stopReason，保持一致。
		async (stopReason) => {
			// 准备在模型回复完成事件中才排入的steering，避免低层启动时已被先消费。
			const queuedDuringResponse = createUserMessage("steering");
			// 建立独立的follow-up追问消息，先保存数据，具体投递时机由Agent入口及低层队列调度决定。
			const followUp = createUserMessage("follow-up");
			// 创建本例真实Agent实例，接下来的选项配置本地模拟依赖；构造本身不执行prompt。
			const agent = new Agent({
				// 回合钩子明确要求continue，用来验证错误/取消的硬退出优先级更高。
				finishTurn: () => ({ action: "continue" }),
				// 本例注入本地模拟流函数，不调用实际供应商请求实现。
				streamFn: () => {
					// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
					const stream = createAssistantMessageEventStream();
					// 把下面的模拟输出排到微任务，在当前同步调用栈结束后执行；不是等待真实模型。
					queueMicrotask(() => {
						// 本地mock发布一个错误终止事件，不抛异常或访问真实服务。
						stream.push({
							// 事件type为error，error/aborted都走这个统一终止标签。
							type: "error",
							// reason取当前表中的error或aborted。
							reason: stopReason,
							// error字段仍是AssistantMessage，不是裸Error实例。
							error: {
								// 浅展开正常回复fixture，下一行覆盖它原本的stopReason。
								...createAssistantMessage(stopReason),
								// 属性简写将消息原因改成与事件一致的失败原因。
								stopReason,
								// 错误说明也用同一字面量，不在此断言真实供应商错误格式。
								errorMessage: stopReason,
							},
						});
					});
					// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
					return stream;
				},
			});
			// 把该消息加入follow-up队列，尚不立即追加到历史或启动新运行。
			agent.followUp(followUp);
			// 注册本例观察回调；真实Agent处理每条事件后会等待订阅者，再继续运行。
			agent.subscribe((event) => {
				// 在assistant正式提交的message_end观察点排队，发生于finishTurn决策之前。
				if (event.type === "message_end" && event.message.role === "assistant") {
					// 把预先准备的steering入队，之后错误退出不该将其drain。
					agent.steer(queuedDuringResponse);
				}
			});

			// 启动并等待完整本地模拟运行；可能包含模型回复、工具及后续回合。
			await agent.prompt("start");

			// 结束后先预览steering，证明失败没有消费新排入插话；peek优先级不表示follow-up丢失。
			expect(agent.peekQueuedMessages()).toEqual([queuedDuringResponse]);
			// 清空插话队列，供下一次peek观察较低优先级follow-up；不是消费所有类型的消息。
			agent.clearSteeringQueue();
			// 插话清空后预览应选出follow-up，确认它尚未被本次运行消费；toEqual比较内容，不消费队列。
			expect(agent.peekQueuedMessages()).toEqual([followUp]);
		},
	);

	// 正常回复的finishTurn返回end时也直接结束并保留两队列；插话故意在message_end时入队，之后通过clear+peek依次检查。
	it("keeps queues when finishTurn ends the run", async () => {
		// 准备回复期间才插入的steering消息。
		const queuedDuringResponse = createUserMessage("steering");
		// 建立独立的follow-up追问消息，先保存数据，具体投递时机由Agent入口及低层队列调度决定。
		const followUp = createUserMessage("follow-up");
		// 创建本例真实Agent实例，接下来的选项配置本地模拟依赖；构造本身不执行prompt。
		const agent = new Agent({
			// 明确结束决定应让调度器跳过后续队列读取，不是取消正在执行的工具。
			finishTurn: () => ({ action: "end" }),
			// 本例注入本地模拟流函数，不调用实际供应商请求实现。
			streamFn: () => {
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 微任务回调稍后给正常done回复。
				queueMicrotask(() =>
					// 发布固定done文字终值，为finishTurn提供已完成回合。
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") }),
				);
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});
		// 把该消息加入follow-up队列，尚不立即追加到历史或启动新运行。
		agent.followUp(followUp);
		// 注册本例观察回调；真实Agent处理每条事件后会等待订阅者，再继续运行。
		agent.subscribe((event) => {
			// 只有assistant message_end触发新增插话，不让user事件提前把它加进队列。
			if (event.type === "message_end" && event.message.role === "assistant") {
				// 排入高优先级插话，马上到来的end决定不应消费它。
				agent.steer(queuedDuringResponse);
			}
		});

		// 启动并等待完整本地模拟运行；可能包含模型回复、工具及后续回合。
		await agent.prompt("start");

		// 正常end后steering仍在；清空它后再peek，后面的断言还检查follow-up未被消费。
		expect(agent.peekQueuedMessages()).toEqual([queuedDuringResponse]);
		// 清空插话队列，供下一次peek观察较低优先级follow-up；不是消费所有类型的消息。
		agent.clearSteeringQueue();
		// 插话清空后预览应选出follow-up，确认它尚未被本次运行消费；toEqual比较内容，不消费队列。
		expect(agent.peekQueuedMessages()).toEqual([followUp]);
	});

	// peek只预览下一批选中的消息：steering存在时优先，one-at-a-time只看第一条；重复peek不消费，清空插话后才看到follow-up。不运行模型。
	it("previews the next selected queued messages without consuming them", () => {
		// 创建本例真实Agent实例，接下来的选项配置本地模拟依赖；构造本身不执行prompt。
		const agent = new Agent({
			// 插话一次只选最早一条。
			steeringMode: "one-at-a-time",
			// 追问一次可选全部；本例只有一条追问，未独立证明多追问时全取。
			followUpMode: "all",
			// 满足必填streamFn但不调用它；若真的运行该空流而不终止，result会等待。
			streamFn: () => createAssistantMessageEventStream(),
		});
		// 创建第一条插话。
		const first = createUserMessage("first steering");
		// 创建第二条插话，排在第一条后面。
		const second = createUserMessage("second steering");
		// 建立独立的follow-up追问消息，先保存数据，具体投递时机由Agent入口及低层队列调度决定。
		const followUp = createUserMessage("follow-up");
		// 按顺序排第一条。
		agent.steer(first);
		// 再排第二条。
		agent.steer(second);
		// 把该消息加入follow-up队列，尚不立即追加到历史或启动新运行。
		agent.followUp(followUp);

		// 预览只返回first，既不混follow-up，也不越过one-at-a-time取second。
		expect(agent.peekQueuedMessages()).toEqual([first]);
		// 再次peek仍是first，说明第一次没消费；下面clearSteeringQueue同时移除两条插话。
		expect(agent.peekQueuedMessages()).toEqual([first]);
		// 清空插话队列，供下一次peek观察较低优先级follow-up；不是消费所有类型的消息。
		agent.clearSteeringQueue();
		// 插话清空后预览应选出follow-up，确认它尚未被本次运行消费；toEqual比较内容，不消费队列。
		expect(agent.peekQueuedMessages()).toEqual([followUp]);
	});

	// 检查原始provider事件观察器由AgentOptions透传给streamFn；mock主动await该回调并发送request_cost数据。不是测真实供应商事件解析或费用统计。
	it("forwards provider stream event observers through AgentOptions", async () => {
		// 用unknown数组记录观察器收到的数据，不强制所有原生供应商事件都符合这一个字段。
		const providerEvents: unknown[] = [];
		// 创建本例真实Agent实例，接下来的选项配置本地模拟依赖；构造本身不执行prompt。
		const agent = new Agent({
			// 配置接收数据的观察器，回调只收集，本例不处理第二个model参数。
			onProviderStreamEvent: (data) => {
				// 保留收到的数据对象引用，不格式化或复制它。
				providerEvents.push(data);
			},
			// 注入本地流函数，保留model供观察器回调参数使用，不连接供应商。
			streamFn: (model, _context, options) => {
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// async微任务先等待观察器，再发终值；queueMicrotask不管理其返回Promise，fixture依赖回调正常完成。
				queueMicrotask(async () => {
					// 可选链调用透传的观察器，传固定数据及本次model，await等它完成；没有回调则await undefined后继续。
					await options?.onProviderStreamEvent?.({ request_cost: 0.01 }, model);
					// 准备固定ok的完整回复对象。
					const message = createAssistantMessage("ok");
					// 把前面构造的message作为done终值；它会由真实低层循环转成message生命周期事件。
					stream.push({ type: "done", reason: "stop", message });
				});
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});

		// 等待这次prompt及其事件监听器收尾；返回void，回答和状态从Agent历史读取。
		await agent.prompt("hello");

		// 只要求观察器收到这一次固定数据，不据此宣称request_cost已合并进模型usage.cost。
		expect(providerEvents).toEqual([{ request_cost: 0.01 }]);
	});

	// 初始sessionId应透传到首轮options，修改实例字段后下一轮用新id；检查的是本地选项，不证明实际供应商缓存命中。
	it("forwards sessionId to streamFunction options", async () => {
		// 保存streamFn读到的可选sessionId，初始undefined。
		let receivedSessionId: string | undefined;
		// 创建本例真实Agent实例，接下来的选项配置本地模拟依赖；构造本身不执行prompt。
		const agent = new Agent({
			// 初始会话id固定session-abc。
			sessionId: "session-abc",
			// 注入本地流函数，只读取真实Agent转交的options，忽略模型和上下文；无实际模型请求。
			streamFn: (_model, _context, options) => {
				// 从每次真实Agent传给mock的options读取id，而非直接读agent.sessionId冒充透传测试。
				receivedSessionId = options?.sessionId;
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 把下面的模拟输出排到微任务，在当前同步调用栈结束后执行；不是等待真实模型。
				queueMicrotask(() => {
					// 准备固定ok的完整回复对象。
					const message = createAssistantMessage("ok");
					// 把前面构造的message作为done终值；它会由真实低层循环转成message生命周期事件。
					stream.push({ type: "done", reason: "stop", message });
				});
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});

		// 等待这次prompt及其事件监听器收尾；返回void，回答和状态从Agent历史读取。
		await agent.prompt("hello");
		// 首请求读到初始session-abc。
		expect(receivedSessionId).toBe("session-abc");

		// Test setter
		// 对实例公开字段赋新值，影响下一次createLoopConfig；不是给历史消息改id。
		agent.sessionId = "session-def";
		// 检查实例能读回新值。
		expect(agent.sessionId).toBe("session-def");

		// 再次请求同一Agent，沿用之前历史，观察更新后的选项。
		await agent.prompt("hello again");
		// 第二次mock收到新session-def。
		expect(receivedSessionId).toBe("session-def");
	});

	// 默认归因为Pi；显式acme覆盖归因并设置short，随后仅保留short时又使用Pi默认归因。逐请求合并，不会继承前一请求acme；不发送HTTP头。
	it("attributes requests to pi by default and merges a configured identity over it", async () => {
		// 数组元素是ClientIdentity或undefined，括号表示联合整体作为数组元素类型。保存各请求实际合并后的identity。
		const received: (ClientIdentity | undefined)[] = [];
		// 创建本例真实Agent实例，接下来的选项配置本地模拟依赖；构造本身不执行prompt。
		const agent = new Agent({
			// 注入本地流函数，只读取真实Agent转交的options，忽略模型和上下文；无实际模型请求。
			streamFn: (_model, _context, options) => {
				// 收集mock读到的identity引用；mergeClientIdentity每请求创建合并对象，本例未额外深复制。
				received.push(options?.identity);
				// 新建独立事件队列及最终结果Promise；此工厂不建立网络请求。
				const stream = createAssistantMessageEventStream();
				// 把下面的模拟输出排到微任务，在当前同步调用栈结束后执行；不是等待真实模型。
				queueMicrotask(() => {
					// 发布带固定ok回复的done终止事件，供真实Agent管线消费。
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				// 立即把可异步迭代的流对象返回，消费者稍后读取事件及最终result；不是直接返回回答文字。
				return stream;
			},
		});

		// 等待这次prompt及其事件监听器收尾；返回void，回答和状态从Agent历史读取。
		await agent.prompt("hello");
		// 固定acme归因对象只含名字和URL，URL是元数据而非要访问的地址。
		const acme = { name: "acme", url: "https://acme.example" };
		// 同时设置User-Agent模式short及acme归因；Agent随后逐字段覆盖默认身份。
		agent.identity = { userAgent: "short", attribution: acme };
		// 第二次请求应看到acme/short组合。
		await agent.prompt("hello again");
		// 以新对象替换实例identity，只给short；没有提供attribution时回落本轮默认Pi，不保留旧acme。
		agent.identity = { userAgent: "short" };
		// 第三次请求观察上述替换效果。
		await agent.prompt("and again");

		// 深比较三次mock收到的身份数据，验证默认值与本次显式字段的合并；不是对真实请求头做断言。
		expect(received).toEqual([
			// 首次没有自定义identity，只有Pi归因；User-Agent默认格式尚由更低层请求适配器决定。
			{ attribution: PI_ATTRIBUTION },
			// 第二次使用acme和short。
			{ attribution: acme, userAgent: "short" },
			// 第三次仍short，但归因回到Pi默认对象。
			{ attribution: PI_ATTRIBUTION, userAgent: "short" },
		]);
	});
});
