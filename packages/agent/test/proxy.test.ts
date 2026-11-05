// 用内存Response检查代理事件重建、EOF收尾和大工具参数预览；每例替换全局fetch，无真实代理/模型请求。
// 只导入消息/事件/模型类型，类型参数不会建立供应商连接。
import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
// normalizeContext将旧顶层提示词和工具折到消息；此文件传空提示词/历史，得到空规范轨迹。
import { normalizeContext } from "@earendil-works/pi-ai";
// afterEach清理stub，vi创建全局替身；it回调为async，让Vitest等待流消费完成。
import { afterEach, describe, expect, it, vi } from "vitest";
// 导入真实代理适配器及线路事件类型；真实请求函数使用被每例替换的fetch。
import { type ProxyAssistantMessageEvent, streamProxy } from "../src/proxy.ts";

// 固定模型元数据fixture，泛型把api限定为openai-responses；不是读取实时模型目录，也不说明这些数字现在由供应商保证。
const model: Model<"openai-responses"> = {
	// 模型id只放进代理请求和输出元数据。
	id: "gpt-5.4",
	// 可读模型名称。
	name: "GPT-5.4",
	// 协议标签与Model泛型相对应。
	api: "openai-responses",
	// 供应商标签，不在此创建OpenAI SDK客户端。
	provider: "openai",
	// 测试数据中的供应商地址；streamProxy实际访问proxyUrl，且该fetch已被替换，不会访问这里。
	baseUrl: "https://api.openai.com/v1",
	// 声明支持思考的模型元数据，不要求本例必须收到thinking事件。
	reasoning: true,
	// 输入能力只列文字；测试没有上传图片。
	input: ["text"],
	// 费用全部置零，只便于固定fixture，不代表实际模型免费。
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	// 固定上下文窗口元数据，不在此断言或压测40万token。
	contextWindow: 400000,
	// 固定最大输出元数据，不产生对应规模的模型输出。
	maxTokens: 128000,
};

// 索引访问类型复用AssistantMessage的usage结构；此对象供模拟终止事件报告统计。
const usage: AssistantMessage["usage"] = {
	// 模拟输入token数为0。
	input: 0,
	// 模拟输出token数为0。
	output: 0,
	// 模拟缓存读取token为0。
	cacheRead: 0,
	// 模拟缓存写入token为0。
	cacheWrite: 0,
	// 模拟总token为0，不根据后面字符串长度自动计数。
	totalTokens: 0,
	// 各费用分项和合计都设为0，不是真实计费记录。
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// 每例结束后恢复由vi.stubGlobal登记的原全局值；这是清理钩子，不测试代理网络关闭行为。
afterEach(() => {
	// 恢复包括fetch在内的所有已登记全局stub；不等同恢复所有mock函数/模块。
	vi.unstubAllGlobals();
});

// 代理流分组包含四个纯内存回归场景；协议JSON仍由真实streamProxy解析，不mock其内部事件处理函数。
describe("streamProxy", () => {
	// 模拟namespace直到toolcall_end才出现，检查结束事件和最终内容都保留它；不执行lookup工具。
	it("preserves tool-call metadata received only on toolcall_end", async () => {
		// 类型化的线路事件数组按先start、工具增量、工具结束、done排序。
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			// 开始消息，尚无内容。
			{ type: "start" },
			// 在内容索引0建立lookup工具块，id包含竖线也只是字符串。
			{ type: "toolcall_start", contentIndex: 0, id: "call_test|fc_test", toolName: "lookup" },
			// 参数片段是完整小JSON，此时还没有namespace。
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"value":"hello"}' },
			{
				// 声明完整工具块结束事件。
				type: "toolcall_end",
				// 定位同一个内容块0。
				contentIndex: 0,
				// 服务端终值ToolCall会浅合并进当前工具块。
				toolCall: {
					// 内容块标签用toolCall，与事件名toolcall_end拼写不同。
					type: "toolCall",
					// 终值保留原调用id。
					id: "call_test|fc_test",
					// 终值工具名仍lookup。
					name: "lookup",
					// 最终参数是对象，不是JSON文本。
					arguments: { value: "hello" },
					// 只在结束事件加入动态工具命名空间，专门覆盖易被漏掉的元数据。
					namespace: "dynamic_tools",
				},
			},
			// 正常终止原因toolUse表示请求工具；usage用属性简写引用上面的固定对象。
			{ type: "done", reason: "toolUse", usage },
		];
		// map把各事件JSON编码成data行加双换行，再join成单个模拟SSE响应体；这不模拟任意网络字节分片。
		const body = proxyEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		// 登记全局fetch替身，随后真实适配器调用的就是它。
		vi.stubGlobal(
			// 要替换的全局属性名为fetch。
			"fetch",
			// vi.fn包装async函数，忽略请求参数并返回内存Response，状态200；没有进行HTTP连接。
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		// 创建真实代理流；空context经normalize后发送，函数同步返回可异步迭代的事件流。
		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			// 固定测试认证字符串；不会用真实API密钥。
			authToken: "test-token",
			// 代理URL仅供请求组装，fetch替身不会访问它。
			proxyUrl: "https://proxy.example.com",
		});
		// 初始化空数组收集统一事件，而不是线路上精简事件。
		const events: AssistantMessageEvent[] = [];
		// for await逐个消费直到流结束，push是数组追加，不是再次发布事件。
		for await (const event of stream) events.push(event);
		// result等待最终AssistantMessage；错误结果也可能resolve，成败需看stopReason。
		const result = await stream.result();
		// find取第一个工具结束事件，缺失会返回undefined并导致下面的匹配失败。
		const endEvent = events.find((event) => event.type === "toolcall_end");

		// toMatchObject只匹配给出的子集，不要求结束事件只能有这两个键。
		expect(endEvent).toMatchObject({
			// 确认确为工具结束事件。
			type: "toolcall_end",
			// 确认结束事件内的toolCall保留命名空间。
			toolCall: { namespace: "dynamic_tools" },
		});
		// 检查最终消息的第一个内容块也带这份终值；不逐字段比较整条AssistantMessage。
		expect(result.content[0]).toMatchObject({
			// 最终块应为工具调用。
			type: "toolCall",
			// 最终参数仍为value:hello。
			arguments: { value: "hello" },
			// namespace不能只出现在结束事件而遗漏最终历史内容。
			namespace: "dynamic_tools",
		});
	});

	// Regression tests for https://github.com/earendil-works/pi/issues/8996
	// 回归#8996：最后done行没有换行仍应处理其终止原因和实际思考级别；固定内存体，不覆盖所有SSE规则。
	it("processes terminal metadata when the event is not newline-terminated", async () => {
		// start行正常以两个换行结束。
		const start = `data: ${JSON.stringify({ type: "start" })}\n\n`;
		// done行故意没有尾换行，携带providerThinkingLevel:high，要求读取EOF后处理残留缓冲。
		const done = `data: ${JSON.stringify({ type: "done", reason: "stop", usage, providerThinkingLevel: "high" })}`;
		// 本例再次安装fetch替身，不依赖上例遗留状态。
		vi.stubGlobal(
			// 替换全局fetch。
			"fetch",
			// Response体直接串接start与done，无真实传输分片或代理服务。
			vi.fn(async () => new Response(start + done, { status: 200 })),
		);

		// 调用实际流解析器，空规范上下文和模拟选项与前例一致。
		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			// 固定测试token。
			authToken: "test-token",
			// 模拟代理地址。
			proxyUrl: "https://proxy.example.com",
		});
		// 保存本例收到的统一事件。
		const events: AssistantMessageEvent[] = [];
		// 等待并收集全部事件，直到done关闭迭代。
		for await (const event of stream) events.push(event);
		// 获取终值消息供字段断言。
		const result = await stream.result();

		// map投影事件类型，深比较顺序恰为start/done；不单独限制事件上其余元数据。
		expect(events.map((event) => event.type)).toEqual(["start", "done"]);
		// 消息应标stop，不能因缺换行被误当中途断开。
		expect(result.stopReason).toBe("stop");
		// 终止行的思考级别应保留为high。
		expect(result.providerThinkingLevel).toBe("high");
	});

	// 只发start后关闭响应，检查适配器生成error并让迭代/result都能完成；不是测试真实服务超时或取消。
	it("emits an error instead of hanging when the stream ends without a terminal event", async () => {
		// 响应仅有开始事件，不含done/error终止协议事件。
		const body = `data: ${JSON.stringify({ type: "start" })}\n\n`;
		// 为缺终止事件场景安装独立fetch替身。
		vi.stubGlobal(
			// 替换的是全局fetch函数。
			"fetch",
			// 内存Response正常EOF，HTTP状态仍200；因此失败是协议不完整而非HTTP错误。
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		// 真实适配器读取固定响应，应该把干净EOF与模型协议成功区分开。
		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			// 使用固定测试认证值。
			authToken: "test-token",
			// 仅供组装的代理地址。
			proxyUrl: "https://proxy.example.com",
		});
		// 收集事件以检查错误是否被实际发出。
		const events: AssistantMessageEvent[] = [];
		// 若流一直挂起，测试也无法越过此await循环，最终受Vitest超时限制；本行自身没有超时器。
		for await (const event of stream) events.push(event);
		// result应resolve带错误状态的消息，并非Promise必须reject。
		const result = await stream.result();

		// 事件顺序应是开始后补一条错误终止。
		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		// 确认最终消息状态error。
		expect(result.stopReason).toBe("error");
		// toContain检查错误消息含断开提示，不强制完整错误文案相等。
		expect(result.errorMessage).toContain("Connection closed by proxy server");
	});

	// #9265
	// 回归#9265：大参数按32个UTF-16码元拆增量，检查消费时可见预览的长度/前缀、块键、最终内容及耗时阈值。
	// 内存Response并未强制每条SSE单独分块，事件还共享partial引用，消费者未必看到每片生成当时的快照。单一规模10秒上限不能严格证明渐近线性复杂度。
	it("shows growing partial arguments without keeping the raw text on the block, in linear time", async () => {
		// 重复含引号、反斜杠和真实换行的文本两万次，迫使JSON编码产生转义，覆盖分片切在转义中间的预览行为。
		const content = 'line "quoted" \\ end\n'.repeat(20_000);
		// JSON.stringify生成工具参数全文，content用属性简写；path:a.ts只是文本，不创建文件。
		const text = JSON.stringify({ path: "a.ts", content });
		// 先准备开始与工具开始两个事件，后面再推入大量delta。
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			// 消息开始标签。
			{ type: "start" },
			// 在索引0建write工具调用块，但不真正调用写文件工具。
			{ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "write" },
		];
		// 按JS字符串length每32个UTF-16码元推进，最后一片可不足32；不是按token或网络字节数拆。
		for (let index = 0; index < text.length; index += 32) {
			// slice截取本片并append到事件数组，未在此对每个前缀重新JSON.parse。
			proxyEvents.push({ type: "toolcall_delta", contentIndex: 0, delta: text.slice(index, index + 32) });
		}
		// 全部delta之后一次push两个收尾事件，维持工具先结束、消息再done的顺序。
		proxyEvents.push(
			{
				// 先发布完整工具结束事件。
				type: "toolcall_end",
				// 结束块下标仍0。
				contentIndex: 0,
				// 终值直接给原始完整content与path对象，避免依赖预览推测作为最终参数。
				toolCall: { type: "toolCall", id: "call_1", name: "write", arguments: { path: "a.ts", content } },
			},
			// 消息以toolUse结束并带固定用量。
			{ type: "done", reason: "toolUse", usage },
		);
		// 将全部线路事件转成SSE数据行，计时尚未开始，所以构造大fixture和这次JSON序列化不在10秒预算内。
		const body = proxyEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		// 设置本例专用fetch替身。
		vi.stubGlobal(
			// 全局目标名fetch。
			"fetch",
			// 读取内存字符串体，不请求地址也不执行写文件工具。
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		// 用单调时钟记录起点，预算覆盖streamProxy创建、消费和本例随后的断言，不是精确单测某个解析函数的CPU时间。
		const started = performance.now();
		// 启动真实代理适配器并立即取得流，异步体从mock fetch读数据。
		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			// 仍使用固定测试token。
			authToken: "test-token",
			// 仍使用不连接的代理fixture地址。
			proxyUrl: "https://proxy.example.com",
		});
		// 保存上一份有效content预览的UTF-16长度，初始0。
		let shown = 0;
		// 计数只统计取到字符串content的工具增量，用于减少昂贵前缀比较频率。
		let deltas = 0;
		// 异步遍历实际发布的统一事件。
		for await (const event of stream) {
			// 不是工具参数delta就跳过，不把start/end/done计入预览采样。
			if (event.type !== "toolcall_delta") continue;
			// 读取事件共享的累计草稿第0块；若生产者已同步处理同一响应块里的后续行，这里可能已是较晚甚至最终状态，不是此delta生成时的独立快照。
			const block = event.partial.content[0];
			// 非空断言!只影响TS，Object.keys实际仍会因缺块抛错；排序后精确检查四个自有可枚举字符串键，不检查符号/非枚举属性或解析器Map。
			expect(Object.keys(block!).sort()).toEqual(["arguments", "id", "name", "type"]);
			// 可选链与标签判断先确认工具块，再从参数对象取content；否则给undefined，TS不会因此把未知值自动转字符串。
			const partial = block?.type === "toolCall" ? block.arguments.content : undefined;
			// 只有真实字符串预览才进行长度/前缀断言；尚未解析出content的阶段跳过。
			if (typeof partial !== "string") continue;
			// Comparing the whole text on every delta would make this test itself quadratic.
			// 后置++先用旧deltas取模再递增，因此第0、500、1000次等有效预览检查完整前缀；避免每片都作长串比较。
			if (deltas++ % 500 === 0) expect(content.startsWith(partial)).toBe(true);
			// 要求预览长度不回退；长度相等也允许，不要求每32码元片都带来可见增长。
			expect(partial.length).toBeGreaterThanOrEqual(shown);
			// 更新上一份已展示长度，供下次比较。
			shown = partial.length;
		}
		// 取到终值后，下面检查预览接近完整且最终参数正确。
		const result = await stream.result();

		// 只要求最后有效预览距全文不足64个码元，不要求在toolcall_delta阶段就达到全文完全一致。
		expect(shown).toBeGreaterThan(content.length - 64);
		// 深比较最终content数组，最终工具参数必须完整，不再采用容忍少量尾巴的预览标准。
		expect(result.content).toEqual([
			// 结果为单个write调用及原始path/content；数组里没有额外文字块。
			{ type: "toolCall", id: "call_1", name: "write", arguments: { path: "a.ts", content } },
		]);
		// Re-parsing the accumulated 520 KB of arguments on each of its 16,000 deltas took minutes.
		// 当前固定规模总耗时须小于10000毫秒；这个阈值及既有英文历史数字是回归线索，不是所有机器/输入规模的性能保证。
		expect(performance.now() - started).toBeLessThan(10_000);
	});
});
