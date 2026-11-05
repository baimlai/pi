// 用成对内存传输检验McpClient握手、分页、资源/工具、续时、取消及反向请求；不建HTTP服务/子进程，也不读取真实凭据。此处createServer是本文件模拟器，别与test/helpers.ts真实loopback服务混淆。
// afterEach/describe/it组织测试，expect断言，vi提供计时器与调用记录替身；多数计时用真实短定时器，续时一例改用虚拟计时。
import { afterEach, describe, expect, it, vi } from "vitest";
// 从主入口使用公共API，type项只是类型，值项用于真正构造/断言。
import {
	// 请求/通知/响应消息联合，供记录数组和测试传输使用。
	type JsonRpcMessage,
	// 带id与method的请求形状，类型断言不会自动检查字段。
	type JsonRpcRequest,
	// 当前本地默认协议版本，模拟初始化响应与请求断言使用同一常量。
	LATEST_PROTOCOL_VERSION,
	// 本地取消错误类，后面用instanceof断言。
	McpAbortError,
	// 被测客户端类，实际协议流程依赖它而非另写假客户端。
	McpClient,
	// 协议错误类，模拟服务器把它的code/message/data编码回响应。
	McpError,
	// 本地等待超时错误类，不代表服务端任务已经停止。
	McpTimeoutError,
} from "../src/index.ts";
// 创建一对未启动内存端点，消息structuredClone后排微任务，无真实网络；InMemoryTransport只用于TS接口字段。
import { createInMemoryTransportPair, type InMemoryTransport } from "../src/testing/index.ts";

// 本文件假服务端的接口，只描述传输、消息历史和可替换方法表，不是完整MCP服务框架。
interface TestServer {
	// 服务器端内存端点，可发消息/模拟关闭/错误。
	transport: InMemoryTransport;
	// 收到的所有消息按顺序留存，既含请求也含通知/反向响应，供断言观察。
	messages: JsonRpcMessage[];
	// setHandler按method登记回调，接收请求、可同步/异步返回未知结果；void只指登记本身，不返回处理结果。
	setHandler(method: string, handler: (request: JsonRpcRequest) => unknown | Promise<unknown>): void;
}

// 无参数创建模拟服务器，返回客户端端点与server包装的Promise。先成对绑定→监听消息→启动server端→默认initialize；例：随后server.setHandler("tools/list",...)就可用。只在内存中模拟，未知方法回-32601，处理错误回协议错误；不实现生产服务的取消/鉴权/参数schema检查。
async function createServer(): Promise<{ clientTransport: InMemoryTransport; server: TestServer }> {
	// 工厂返回client/server两个原对象，未启动client；两者通过peer引用互相投递。
	const pair = createInMemoryTransportPair();
	// Map按方法名保存处理函数，泛型约束键/函数签名，不生成运行时校验。
	const handlers = new Map<string, (request: JsonRpcRequest) => unknown | Promise<unknown>>();
	// 新建本服务器消息历史，不同测试有各自数组。
	const messages: JsonRpcMessage[] = [];
	// 注册服务端消息监听器，运行时收到消息才执行箭头；返回的退订函数没有保存在这里。
	pair.server.onMessage((message) => {
		// 先记录每条消息，再决定是否响应；数组保留已接收复制对象的引用。
		messages.push(message);
		// 只同时有id和method才继续当请求处理；in可查继承键，这是测试局部筛选，不是完整JSON-RPC guard。
		if (!("id" in message) || !("method" in message)) return;
		// as声明这是请求，让TS能读method/id，不增加字段验证/拷贝。
		const request = message as JsonRpcRequest;
		// 收到消息此刻就取handler引用，之后微任务执行时不会重新读Map。
		const handler = handlers.get(request.method);
		// 再排一个async微任务处理；queueMicrotask不采纳回调返回Promise，catch中再发送失败可成为未处理拒绝，别当作通用服务异常框架。
		queueMicrotask(async () => {
			// try覆盖未知方法、handler调用/await及成功响应send。
			try {
				// 没处理函数就抛method-not-found协议错误，稍后转错误响应，不关闭连接。
				if (!handler) throw new McpError(-32601, `Method not found: ${request.method}`);
				// 先await业务handler，再send带相同id的成功响应；send只代表内存检查/复制/排队，不是客户端已处理完。
				await pair.server.send({ jsonrpc: "2.0", id: request.id, result: await handler(request) });
				// 任何上述失败都进这里，错误不一定是Error实例。
			} catch (error) {
				// 已有McpError保留code/data，其他抛出值String化并包-32603；String本身也可抛错。
				const mcpError = error instanceof McpError ? error : new McpError(-32603, String(error));
				// 用服务器端发送错误响应，若此send再失败这里无第二层catch。
				await pair.server.send({
					// JSON-RPC固定版本标记。
					jsonrpc: "2.0",
					// 复用原请求id，使客户端找到pending。
					id: request.id,
					// 错误对象只选code/message/data，data即使undefined也可在内存对象中存在，与真实JSON编码不完全相同。
					error: { code: mcpError.code, message: mcpError.message, data: mcpError.data },
				});
			}
		});
	});
	// 先启动server端以便收到client.connect发来的initialize；不建监听端口。
	await pair.server.start();
	// 创建TestServer形状的新包装，TS注解检查这些成员能被测试使用。
	const server: TestServer = {
		// 暴露原server端点供测试主动发通知/关闭等。
		transport: pair.server,
		// 属性简写暴露同一个历史数组，不复制快照。
		messages,
		// 登记/替换处理器，输入method/handler，无返回值；例：替换initialize可模拟旧版本。方法本身不执行handler、不提供退订。
		setHandler(method, handler) {
			// Map.set覆盖同名方法，其他方法保持不变。
			handlers.set(method, handler);
		},
	};
	// 默认初始化处理器返回普通对象；箭头后({})表示直接返回对象，而非代码块。
	server.setHandler("initialize", () => ({
		// 模拟服务器选择本地最新版本，不计算真实服务版本。
		protocolVersion: LATEST_PROTOCOL_VERSION,
		// 声明tools列表可变化能力；不是立即发送列表变化通知。
		capabilities: { tools: { listChanged: true } },
		// 模拟服务器自报名称和版本，无身份认证。
		serverInfo: { name: "test-server", version: "1.0.0" },
		// 固定指引文字作为待断言数据，不是把本测试送给模型。
		instructions: "Use test tools.",
	}));
	// 返回尚未启动的client端和已启动的server包装，调用方后续负责client连接/关闭。
	return { clientTransport: pair.client, server };
}

// 无参数便捷建立已握手客户端，返回{client,server}Promise；例：用例await connect后直接callTool。步骤是内存服务→客户端→connect，异常拒绝；不自动在断言失败后finally关闭。
async function connect(): Promise<{ client: McpClient; server: TestServer }> {
	// await服务器工厂后解构两个对象。
	const { clientTransport, server } = await createServer();
	// 构造被测客户端，名称版本用于initialize请求，不立即启动I/O。
	const client = new McpClient({ name: "test-client", version: "2.0.0" });
	// 客户端启动自己的端点，完成initialize响应/initialized通知后才兑现；元数据内部何时可读需看真实connect逻辑。
	await client.connect(clientTransport);
	// 属性简写返回原对象引用给用例。
	return { client, server };
}

// 每个用例结束恢复真实计时器（包括失败后的hook），无参数回调不返回业务值；此hook不代替client.close或自动清理所有内存对象。
afterEach(() => {
	// 移除vi安装的虚拟计时器并丢弃其未触发任务，后续用例不沿用虚拟时钟。
	vi.useRealTimers();
});

// 把13个it归入McpClient测试组；每个用例使用自己的模拟器/客户端。
describe("McpClient", () => {
	// 验证connect兑现后的状态/元数据和收到的握手消息顺序，例initialize(id1)后initialized通知。没有在connecting中途读字段，不能由标题推出中途所有信息一直undefined；错误由断言抛出，正常末尾close。
	it("initializes the connection before exposing server information", async () => {
		// 建立默认内存连接，得到同次测试的客户端与消息记录器。
		const { client, server } = await connect();
		// toBe按原始值比较，确认connect已结束为connected。
		expect(client.connectionState).toBe("connected");
		// 确认客户端保存服务器选择的版本。
		expect(client.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
		// toEqual深比较服务器信息，不要求同一对象引用。
		expect(client.serverInfo).toEqual({ name: "test-server", version: "1.0.0" });
		// 确认能力字段保留tools.listChanged声明，不执行能力本身。
		expect(client.serverCapabilities).toEqual({ tools: { listChanged: true } });
		// 确认初始化指引文字可读取。
		expect(client.instructions).toBe("Use test tools.");
		// 深比较整个收到数组，验证正好这两条按序消息，不只是包含某项。
		expect(server.messages).toEqual([
			// 第一条预期为带id的初始化请求对象。
			{
				// 预期协议包版本固定2.0，与MCP日期版本不是同一字段。
				jsonrpc: "2.0",
				// 初始化占第一个本地请求编号1。
				id: 1,
				// 方法名预期initialize。
				method: "initialize",
				// 请求业务参数的预期形状。
				params: {
					// 提出默认MCP协议版本。
					protocolVersion: LATEST_PROTOCOL_VERSION,
					// 未配置额外能力时发空对象。
					capabilities: {},
					// 使用connect helper给的客户端身份，不是服务器serverInfo。
					clientInfo: { name: "test-client", version: "2.0.0" },
				},
			},
			// 第二条无id/params，是初始化完成通知，不期待业务响应。
			{ jsonrpc: "2.0", method: "notifications/initialized" },
		]);
		// 正常断言结束主动关闭客户端及对端，不由afterEach代劳。
		await client.close();
	});

	// 模拟两页工具并验证合并顺序/描述/schema/注解及空游标结束；例search后read。只检查此两页路径，不覆盖循环游标/1000页上限或schema语义编译，正常末尾close。
	it("paginates tools and preserves protocol tool definitions", async () => {
		// 创建全新内存连接，不复用前例消息历史。
		const { client, server } = await connect();
		// 为tools/list登记本地回调，每次请求返回一页。
		server.setHandler("tools/list", (request) => {
			// 把params断言为可选cursor对象再?.取值；as不验证输入，缺params时得到undefined。
			const cursor = (request.params as { cursor?: string } | undefined)?.cursor;
			// 仅按是否undefined选页，不逐字确认游标一定是page-2。
			return cursor === undefined
				? // 第一次无cursor的分支返回第一页对象。
					{
						// 第一项search带说明和输入schema，schema只是一份协议数据。
						tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
						// 非空下一页游标要求客户端继续请求。
						nextCursor: "page-2",
					}
				: // 任意已定义cursor在这个模拟器里都走第二页。
					{
						// 第二页tools数组，本例只有一个定义。
						tools: [
							// read定义的字段分别用于验证保留。
							{
								// 工具名read，不实际读取文件。
								name: "read",
								// 输入schema保留，不在此编译/执行验证。
								inputSchema: { type: "object" },
								// 输出schema也应原样保留在返回定义中。
								outputSchema: { type: "object" },
								// readOnlyHint是元数据声明，不把假工具变成真实权限受限工具。
								annotations: { readOnlyHint: true },
							},
						],
						// Some servers end pagination with an empty cursor instead of omitting it.
						// 显式空串应被客户端规范为分页结束，不再无限拿第二页。
						nextCursor: "",
					};
		});
		// 调用真实listTools后await结果，再深比较合并数组。
		expect(await client.listTools()).toEqual([
			// 预期第一页search排第一，说明/schema仍在。
			{ name: "search", description: "Search", inputSchema: { type: "object" } },
			// 预期第二页read排第二。
			{
				// 保留原工具名称。
				name: "read",
				// 保留输入schema对象字段。
				inputSchema: { type: "object" },
				// 保留可选输出schema。
				outputSchema: { type: "object" },
				// 保留只读提示注解，不据此增加客户端策略。
				annotations: { readOnlyHint: true },
			},
		]);
		// 断言通过后关闭当前连接。
		await client.close();
	});

	// 验证资源自动翻页/缺名补URI、模板列表、单页游标和读取正文，并对两种坏结构断言拒绝。例file:///b未给name，结果补同URI。URI只是内存样本，没有真实文件读取，错误是客户端浅校验而非完整schema证明。
	it("lists and reads resources", async () => {
		// 先建立默认握手，随后给资源方法装处理器。
		const { client, server } = await connect();
		// 注册资源列表的分页返回函数。
		server.setHandler("resources/list", (request) =>
			// 断言params形状并按有无cursor分两页，不对游标文本做通用解析。
			(request.params as { cursor?: string } | undefined)?.cursor === undefined
				? // 第一页含已命名a和下一页标记2。
					{ resources: [{ uri: "file:///a", name: "a", mimeType: "text/plain" }], nextCursor: "2" }
				: // 第二页b故意缺name，用于验证客户端补名。
					{ resources: [{ uri: "file:///b" }] },
		);
		// 模板列表方法直接返回一页对象，不替换模板占位符。
		server.setHandler("resources/templates/list", () => ({
			// repo模板和名称只是字符串数据，不访问仓库。
			resourceTemplates: [{ uriTemplate: "repo://{owner}/{repo}", name: "repo" }],
		}));
		// 资源读取处理器把请求uri放回正文项，返回固定hello。
		server.setHandler("resources/read", (request) => ({
			// as取uri只为TS，不验证地址/文件存在，contents里的text是本地固定值。
			contents: [{ uri: (request.params as { uri: string }).uri, text: "hello" }],
		}));
		// A missing name falls back to the URI.
		// listResources应跟游标合并两页并标准化名称。
		expect(await client.listResources()).toEqual([
			// 预期a保留已有name/MIME。
			{ uri: "file:///a", name: "a", mimeType: "text/plain" },
			// 预期b的name回退uri。
			{ uri: "file:///b", name: "file:///b" },
		]);
		// 完整模板列表返回模板数组，定义字段保持。
		expect(await client.listResourceTemplates()).toEqual([{ uriTemplate: "repo://{owner}/{repo}", name: "repo" }]);
		// Single pages pass the cursor through.
		// 无cursor单页只返回第一页包装，不自动取完所有页。
		expect(await client.listResourcesPage()).toEqual({
			// 单页资源也应标准化为数组。
			resources: [{ uri: "file:///a", name: "a", mimeType: "text/plain" }],
			// 保留非空nextCursor供调用方再请求。
			nextCursor: "2",
		});
		// 明确传2得到模拟第二页，返回结束时不生成nextCursor属性。
		expect(await client.listResourcesPage("2")).toEqual({ resources: [{ uri: "file:///b", name: "file:///b" }] });
		// readResource返回固定hello及原uri，未触文件系统。
		expect(await client.readResource("file:///a")).toEqual({ contents: [{ uri: "file:///a", text: "hello" }] });

		// 替换read处理器，故意返回既无text也无blob的正文项。
		server.setHandler("resources/read", () => ({ contents: [{ uri: "file:///a" }] }));
		// rejects等待Promise拒绝，toThrow匹配本地检查错误文字，不断言所有非法资源形状。
		await expect(client.readResource("file:///a")).rejects.toThrow("Invalid contents in MCP resources/read result");
		// 替换列表处理器，故意缺必需uri。
		server.setHandler("resources/list", () => ({ resources: [{ name: "no uri" }] }));
		// 整页列表应拒绝，不悄悄丢坏项目或补uri。
		await expect(client.listResources()).rejects.toThrow("Invalid entry in MCP resources/list result");
		// 关闭本测试连接。
		await client.close();
	});

	// 模拟正常结构化工具结果与McpError失败，验证count传参和错误字段；例count3返回count3，fail回code1234。不是实际执行外部工具，异常经测试服务编码后由客户端重建，正常末尾close。
	it("returns structured tool content and surfaces JSON-RPC errors", async () => {
		// 新建连接并配置本例tools/call。
		const { client, server } = await connect();
		// 同一方法处理器根据工具名区分两种返回。
		server.setHandler("tools/call", (request) => {
			// 把未知params视为name/可选arguments对象，Record值仍为unknown，断言不执行验证。
			const params = request.params as { name: string; arguments?: Record<string, unknown> };
			// 工具名fail时抛带自定义code/data的McpError，假服务捕获转协议错误响应。
			if (params.name === "fail") throw new McpError(1234, "tool failed", { retryable: false });
			// 其他名字返回正常结果对象。
			return {
				// 固定文本ok供对比，不请求模型。
				content: [{ type: "text", text: "ok" }],
				// 读取可选arguments里的count，缺参数可undefined，保存在structuredContent中。
				structuredContent: { count: params.arguments?.count },
			};
		});
		// callTool把工具名与参数编码进tools/call，期望成功业务结果。
		expect(await client.callTool("count", { count: 3 })).toEqual({
			// 普通内容数组应保留。
			content: [{ type: "text", text: "ok" }],
			// 结构化count应来自传入的3，不被文本转换替换。
			structuredContent: { count: 3 },
		});
		// 对fail的Promise拒绝作部分对象匹配，不要求异常无其他字段/同一引用。
		await expect(client.callTool("fail")).rejects.toMatchObject({
			// 客户端重建错误的name应是McpError。
			name: "McpError",
			// 服务端code1234应保留，不替换成通用内部码。
			code: 1234,
			// 原message应保留。
			message: "tool failed",
			// 附加data也应保留，本测试没有据retryable自动重试。
			data: { retryable: false },
		});
		// 正常末尾关闭连接。
		await client.close();
	});

	// 验证有进度可续50ms等待窗口：虚拟t40发进度，t80才回结果仍成功；无续时本应t50失败。onProgress应得到id2的进度对象，不证明无限总执行预算或真实时钟精度；末尾关闭，hook恢复真实计时。
	it("renews the timeout on progress", async () => {
		// 用vi替换后续timer/时钟为虚拟实现，不实际睡80ms。
		vi.useFakeTimers();
		// 虚拟计时下也先完成内存握手，initialize使用请求id1。
		const { client, server } = await connect();
		// tools/call改成异步处理器，先设进度timer再等结果timer。
		server.setHandler("tools/call", async (request) => {
			// 双重as只按客户端已附_meta结构读，Record<string,unknown>内部值仍unknown。
			const token = // 取progressToken并断言number，本例来自请求编号，不进行Number转换。
				((request.params as Record<string, unknown>)._meta as Record<string, unknown>).progressToken as number;
			// 排一个40ms虚拟定时回调来发进度。
			setTimeout(() => {
				// void丢弃send Promise，不是await客户端处理完进度；正常内存传输用微任务投递。
				void server.transport.send({
					// 固定JSON-RPC版本。
					jsonrpc: "2.0",
					// 进度是通知，无id，不是最终tools/call响应。
					method: "notifications/progress",
					// 把先前token关联回请求，progress1/total2只作数据，不在测试服务计算百分比。
					params: { progressToken: token, progress: 1, total: 2 },
				});
				// 虚拟40ms到时触发进度，早于50ms初始超时窗口。
			}, 40);
			// 处理器另等80ms虚拟timer完成，等待的是Promise，不阻塞同步线程。
			await new Promise((resolve) => setTimeout(resolve, 80));
			// t80返回最终done内容，假服务才发原请求成功响应。
			return { content: [{ type: "text", text: "done" }] };
		});
		// vi.fn创建可记录被调用参数/次数的空替身，不生成真实进度UI。
		const progress = vi.fn();
		// 发请求但先不await，保存其Promise以便推进虚拟时间；单次timeout50覆盖默认值，并启用progressToken。
		const result = client.callTool("slow", {}, { timeoutMs: 50, onProgress: progress });
		// 异步推进虚拟40ms，处理这期间timer与相关异步步骤，触发进度并续到约t90。
		await vi.advanceTimersByTimeAsync(40);
		// 再推进40ms到约t80，使工具结果先于续后的超时到达。
		await vi.advanceTimersByTimeAsync(40);
		// await原请求必须得到done而不是超时拒绝。
		expect(await result).toEqual({ content: [{ type: "text", text: "done" }] });
		// toHaveBeenCalledWith确认至少一次收到该对象，不等于断言只调一次；请求id1已被initialize使用，所以progressToken2。
		expect(progress).toHaveBeenCalledWith({ progressToken: 2, progress: 1, total: 2 });
		// 关闭连接，清其剩余pending计时/监听。
		await client.close();
	});

	// 验证本地AbortSignal拒绝与取消通知，以及另一次短超时拒绝；例abort("stop")使id2发notifications/cancelled。假服务故意永不兑现，不证明远端工作停止或副作用回滚，末尾关闭。
	it("cancels aborted and timed-out requests", async () => {
		// 默认真实计时器环境的新连接。
		const { client, server } = await connect();
		// 处理器返回永远pending的Promise，模拟无业务响应；Promise本身不等于持续占用端口/计时器。
		server.setHandler("tools/call", () => new Promise(() => {}));
		// 新建本次请求取消控制器，构造时未取消。
		const controller = new AbortController();
		// 传signal发起请求后保存Promise，尚未await。
		const aborted = client.callTool("wait", {}, { signal: controller.signal });
		// 同步触发取消并附原因stop，客户端拒绝等待并尽力通知服务器。
		controller.abort("stop");
		// 断言本地错误类型McpAbortError，不直接用原reason字符串作为异常对象。
		await expect(aborted).rejects.toBeInstanceOf(McpAbortError);
		// 等待一次0ms真实timer，让已排微任务/通知有机会到达；不是强制终止服务器处理器。
		await new Promise((resolve) => setTimeout(resolve, 0));
		// 只要求历史中包含预期通知，不要求历史只有这条或所有消息的完整顺序。
		expect(server.messages).toContainEqual({
			// 取消通知仍用JSON-RPC2.0。
			jsonrpc: "2.0",
			// 方法名为notifications/cancelled，不是tools/call错误响应。
			method: "notifications/cancelled",
			// 参数指向被取消id2并保留原因stop。
			params: { requestId: 2, reason: "stop" },
		});

		// 另发wait请求，5ms窗口后应McpTimeoutError；这里未单独断言这次timeout的取消通知内容。
		await expect(client.callTool("wait", {}, { timeoutMs: 5 })).rejects.toBeInstanceOf(McpTimeoutError);
		// 关闭客户端与内存对端。
		await client.close();
	});

	// 验证单独错误事件不等于连接关闭：挂起调用时emitError，稍后正常响应仍成功，错误监听器收到文字。只模拟这一错误事件路径，不保证所有真实I/O错误都可恢复；正常结束close。
	it("reports transport errors without failing pending requests", async () => {
		// 先建模拟服务而非便捷connect，以便保留clientTransport引用发错误。
		const { clientTransport, server } = await createServer();
		// 本例显式用1.0.0客户端版本，与默认helper2.0.0不同。
		const client = new McpClient({ name: "test-client", version: "1.0.0" });
		// 真实客户端逻辑完成内存握手。
		await client.connect(clientTransport);
		// Error[]记录监听器收到的错误对象。
		const errors: Error[] = [];
		// 注册回调push错误，void契约不使用push返回的数组长度。
		client.onError((error) => errors.push(error));
		// 先置空响应函数，后面处理器进入后再替换成真正resolve闭包。
		let respond = () => {};
		// 给tools/call登记一个可由测试手动放行的异步结果。
		server.setHandler(
			// 只处理这个协议方法名。
			"tools/call",
			// 每次请求返回新Promise，尚未完成。
			() =>
				// Promise执行器同步运行并拿到resolve。
				new Promise((resolve) => {
					// 把respond改为兑现本次结果的函数，调用时给content空数组。
					respond = () => resolve({ content: [] });
				}),
		);
		// 发wait并保留Promise，让它处在pending状态。
		const call = client.callTool("wait");
		// 等一个0ms回合，确保处理器已设置respond，而不是调用最早空函数。
		await new Promise((resolve) => setTimeout(resolve, 0));
		// 直接对客户端内存端发错误事件，不同时close或伪造业务响应。
		clientTransport.emitError(new Error("stray log line"));
		// 手动兑现假服务的业务结果，随后它发送tools/call响应。
		respond();
		// 原请求仍应成功，说明这个error事件没批量拒绝pending。
		expect(await call).toEqual({ content: [] });
		// 把监听到的Error取message比较，恰好这一条文字，不检查Error引用身份。
		expect(errors.map((error) => error.message)).toEqual(["stray log line"]);
		// 正常结束关闭连接。
		await client.close();
	});

	// 分别模拟支持清单里的旧版本和不支持的1999版本，前者连接成功保存协商值，后者拒绝并closed。不是任意旧日期都接受，也不测自动升级/降级重连；每次用独立实例。
	it("accepts servers that answer with an older protocol version", async () => {
		// 创建默认服务，再替换initialize响应。
		const { clientTransport, server } = await createServer();
		// 旧服务器的初始化处理器返回下列固定值。
		server.setHandler("initialize", () => ({
			// 2024-11-05在本地SUPPORTED_PROTOCOL_VERSIONS清单内。
			protocolVersion: "2024-11-05",
			// 能力空对象仍符合浅初始化校验。
			capabilities: {},
			// 旧服务器自报信息，版本0.1.0只是样本字符串。
			serverInfo: { name: "old-server", version: "0.1.0" },
		}));
		// 构造第一个被测客户端。
		const client = new McpClient({ name: "test-client", version: "1.0.0" });
		// await握手应成功，因为返回版本受支持。
		await client.connect(clientTransport);
		// 确认实际保存返回旧版本而不是强行改回默认最新版本。
		expect(client.protocolVersion).toBe("2024-11-05");
		// 关闭第一份正常连接，再创建下一份场景。
		await client.close();

		// 独立内存对端，避免重用已经closed的客户端/传输。
		const unsupported = await createServer();
		// 替换第二份初始化处理器为不支持版本。
		unsupported.server.setHandler("initialize", () => ({
			// 1999-01-01不在清单中，但其string类型本身不会阻止传输。
			protocolVersion: "1999-01-01",
			// 仍给合法能力对象，聚焦版本分支。
			capabilities: {},
			// 仍给合法serverInfo形状，避免先因结构错误失败。
			serverInfo: { name: "ancient-server", version: "0.1.0" },
		}));
		// 创建第二个客户端，变量rejected是对象不是拒绝Promise。
		const rejected = new McpClient({ name: "test-client", version: "1.0.0" });
		// connect应拒绝，toThrow匹配说明中的unsupported protocol version片段。
		await expect(rejected.connect(unsupported.clientTransport)).rejects.toThrow("unsupported protocol version");
		// connect catch已关闭该客户端，状态应closed，不会留connecting。
		expect(rejected.connectionState).toBe("closed");
	});

	// 验证工具结果缺content时补[]但非法字符串content拒绝；例只给structuredContent:{ok:true}可成功。不证明逐个内容块深验证或outputSchema验证，正常末尾close。
	it("defaults missing tool result content to an empty list", async () => {
		// 新建默认连接。
		const { client, server } = await connect();
		// 假工具只返回结构化值，故意省略content键。
		server.setHandler("tools/call", () => ({ structuredContent: { ok: true } }));
		// 客户端应浅补空列表，保留structuredContent。
		expect(await client.callTool("structured")).toEqual({ content: [], structuredContent: { ok: true } });
		// 替换处理器给非数组content，聚焦局部结构失败。
		server.setHandler("tools/call", () => ({ content: "not a list" }));
		// 调用应拒绝为Invalid MCP tools/call result，而非把非法字符串默认为空。
		await expect(client.callTool("broken")).rejects.toThrow("Invalid MCP tools/call result");
		// 关闭连接。
		await client.close();
	});

	// #10416: MCP 2026-07-28 allows any JSON value as structured content.
	// 验证五类非普通对象structuredContent样本可原样返回：数组/null/字符串/数字/布尔。只证明这些具体值，没有枚举任意JSON或循环/BigInt等JS边界，正常末尾close。
	it("accepts structured content that is not an object", async () => {
		// 新建默认连接，每轮复用这同一连接更换处理器。
		const { client, server } = await connect();
		// for...of按顺序取五种异形结构化值；数组里首项本身又是对象数组，不是逐个枚举其id。
		for (const structuredContent of [[{ id: 1 }, { id: 2 }], null, "text", 3, false]) {
			// 属性简写把本轮值放进结果，content明确给[]。
			server.setHandler("tools/call", () => ({ content: [], structuredContent }));
			// 每轮await调用并深比较值，null/false/3不会因假值而丢失。
			expect(await client.callTool("structured")).toEqual({ content: [], structuredContent });
		}
		// 全部五轮成功后关闭连接。
		await client.close();
	});

	// initialize永不响应时应本地超时，且禁止发取消通知；例默认请求窗口5ms。只断言该初始化路径无notifications/cancelled，不等于初始化不会被本地中止。
	it("does not send notifications/cancelled for a timed-out initialize", async () => {
		// 创建内存服务/客户端端点，尚未连接。
		const { clientTransport, server } = await createServer();
		// 覆盖initialize为永远不兑现的Promise，制造等待超时。
		server.setHandler("initialize", () => new Promise(() => {}));
		// 本例通过构造选项把所有默认请求等待窗口设5ms。
		const client = new McpClient({ name: "test-client", version: "1.0.0", requestTimeoutMs: 5 });
		// connect的初始化等待应以McpTimeoutError拒绝，其失败路径会关闭连接。
		await expect(client.connect(clientTransport)).rejects.toBeInstanceOf(McpTimeoutError);
		// 留一个0ms回合观察可能排队的通知。
		await new Promise((resolve) => setTimeout(resolve, 0));
		// 断言历史里不存在指定取消通知，而不是要求完全没消息。
		expect(
			// some短路查任一method等于通知名，in先让TS允许读method，也会看继承键。
			server.messages.some((message) => "method" in message && message.method === "notifications/cancelled"),
			// 没有任何匹配项应得到false。
		).toBe(false);
	});

	// 从服务端关闭内存对端，验证pending拒绝/状态closed及重复主动close不再多发关闭事件。例挂起wait后断连，listener应只调一次；不证明真实TCP/子进程关闭时序或所有监听异常都安全。
	it("notifies close listeners once when the transport drops", async () => {
		// 先建一份已握手连接。
		const { client, server } = await connect();
		// vi.fn记录关闭回调次数，初始未调用。
		const closed = vi.fn();
		// 订阅关闭事件，不在注册时立刻回调。
		client.onClose(closed);
		// 假工具挂起，保证关闭时客户端仍有pending。
		server.setHandler("tools/call", () => new Promise(() => {}));
		// 发请求保存Promise，供关闭后断言其失败。
		const pending = client.callTool("wait");
		// 等待一回合让请求到达假服务，处理器保持pending。
		await new Promise((resolve) => setTimeout(resolve, 0));
		// 关服务端内存传输先发服务端自己的关闭事件，再递归关client端点，触发客户端状态更新；这是内存peer关系，不是真实网络断连。
		await server.transport.close();
		// 被挂起调用应拒绝并含固定连接关闭文字。
		await expect(pending).rejects.toThrow("MCP connection closed");
		// 公开状态此刻应closed。
		expect(client.connectionState).toBe("closed");
		// 随后显式client.close再次清理，不应重复分发关闭事件。
		await client.close();
		// 精确断言一次回调，区别于仅断言调用过。
		expect(closed).toHaveBeenCalledTimes(1);
	});

	// 验证服务端反向roots/list请求和列表变化通知分发；例返回file:///workspace根并通知监听器接undefined。根只是声明，未检查/授权真实目录，也没触发真实工具重新加载，正常末尾close。
	it("answers roots/list and dispatches notifications", async () => {
		// 创建模拟服务并保留其传输供主动发反向请求。
		const { clientTransport, server } = await createServer();
		// 构造客户端时配置roots，使其安装roots/list处理器并补能力。
		const client = new McpClient({
			// 客户端名称样本。
			name: "test-client",
			// 客户端版本样本。
			version: "1.0.0",
			// 根列表是本地固定描述，file URI不会被此测试打开。
			roots: [{ uri: "file:///workspace", name: "workspace" }],
		});
		// 先完成握手再发反向请求/通知。
		await client.connect(clientTransport);
		// 记录列表变化回调参数，不自动实现重新列工具。
		const changed = vi.fn();
		// 按精确通知名注册监听器。
		client.onNotification("notifications/tools/list_changed", changed);
		// 服务器发字符串id为roots的请求，客户端需回同一id响应；不会因此访问workspace目录。
		await server.transport.send({ jsonrpc: "2.0", id: "roots", method: "roots/list" });
		// 再发无params通知，客户端监听器应收到undefined。
		await server.transport.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		// 等待一回合，让内存微任务和反向处理Promise结算后有消息可观察。
		await new Promise((resolve) => setTimeout(resolve, 0));
		// 历史应包含预期roots响应，不约束其他握手/通知消息顺序。
		expect(server.messages).toContainEqual({
			// 响应仍用JSON-RPC2.0。
			jsonrpc: "2.0",
			// 服务端原字符串请求ID应被保留，不换成本地数字编号。
			id: "roots",
			// 结果按配置返回根列表，名称和URI都保持。
			result: { roots: [{ uri: "file:///workspace", name: "workspace" }] },
		});
		// 至少一次回调入参为undefined；本断言没要求只调一次。
		expect(changed).toHaveBeenCalledWith(undefined);
		// 正常结束关闭连接。
		await client.close();
	});
});
