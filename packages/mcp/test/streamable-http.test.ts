// 验证SSE解析与MCP HTTP传输的测试：前一组用内存ReadableStream，后一组会真实监听127.0.0.1动态端口，不请求外部模型。
// 每个it只证明自己列出的断言；导入/登记测试本身不调用listen，HTTP辅助函数在用例运行时才启动服务。
// import type只引用Node请求/响应的静态类型，不因这一行创建HTTP服务。
import type { IncomingMessage, ServerResponse } from "node:http";
// Vitest提供分组/断言/用例及全局替身管理；afterEach只登记清理函数，不在这里执行清理。
import { afterEach, describe, expect, it, vi } from "vitest";
// 从本包公开入口取客户端、传输与协议常量，带type的项目在生成JS时擦除。
import {
	// 固定握手版本用于模拟响应及请求头断言，不在测试中猜版本文字。
	LATEST_PROTOCOL_VERSION,
	// 认证异常仅作Partial类型约束；真正判断由下面toMatchObject读取运行值。
	type McpAuthRequiredError,
	// 客户端负责initialize、请求编号、等待结果和取消；HTTP类只负责传输。
	McpClient,
	// 注入fetch的函数契约，satisfies检查兼容性，不代替网络调用。
	type McpFetch,
	// 已建立会话收到404时的专用异常类，供instanceof断言。
	McpSessionExpiredError,
	// 实际HTTP传输，构造/start不发HTTP，send才发请求。
	StreamableHttpTransport,
} from "../src/index.ts";
// 直接引用纯SSE消费器和事件类型，便于不启动HTTP就测试字节流解析。
import { consumeSseStream, type SseEvent } from "../src/transports/streamable-http.ts";
// 本地helper负责读完整请求正文、显式监听和收尾；import它只建立空服务清单。
import { closeServers, listen, readBody } from "./helpers.ts";

// 记录模拟服务实际观察到的请求，不是生产传输内部日志；接口只约束TS开发期。
interface RecordedRequest {
	// 原始方法文字，例如POST/GET/DELETE。
	method: string;
	// 索引访问类型取IncomingMessage的headers字段类型；保存的是Node头对象引用。
	headers: IncomingMessage["headers"];
	// 可选已解码消息；unknown值要进一步检查/断言才能读取具体业务字段。
	message?: Record<string, unknown>;
}

// 启动一台本机MCP模拟服务，输入异步handler，返回/mcp地址和共享请求记录数组。
// 例：startServer(protocolHandler)建立loopback端口，后续由afterEach(closeServers)关闭；同步异常/已拒绝的等待会向外拒绝，helper没给异步listen错误安装reject监听，不是通用启动容错器。
async function startServer(
	// 回调接Node请求/响应及同一数组，返回Promise<void>；闭包把记录容器交每次请求处理。
	handler: (request: IncomingMessage, response: ServerResponse, requests: RecordedRequest[]) => Promise<void>,
	// Promise兑现值的对象形状：url是字符串，requests是可被处理器继续push的数组。
): Promise<{ url: string; requests: RecordedRequest[] }> {
	// 每台服务独立的新数组，const只固定绑定，不禁止push。
	const requests: RecordedRequest[] = [];
	// await实际绑定端口；箭头把前两个参数转交调用方并额外附requests，不自行记录所有请求。
	const origin = await listen((request, response) => handler(request, response, requests));
	// 属性简写返回requests原引用，模板只拼/mcp文字，不额外发请求。
	return { url: `${origin}/mcp`, requests };
}

// 默认模拟协议处理器：GET记入数组并回405，DELETE记入并回200，其余按消息回握手/工具列表JSON或固定hello的SSE。
// 输入可带已经读好的body，避免请求流二次消费；副作用是push记录和写HTTP响应，读取/JSON错误会拒绝。
// 例：tools/call无论工具名或参数都返回hello，不实际执行echo或校验工具schema，也不代表完整MCP服务端。
async function protocolHandler(
	// Node输入流和请求头/方法所在对象。
	request: IncomingMessage,
	// 向客户端写状态、头和正文的响应对象。
	response: ServerResponse,
	// 由startServer共享的可变记录数组。
	requests: RecordedRequest[],
	// 可选已解析对象；?允许省略，??只在它为null/undefined时另读请求流。
	body?: Record<string, unknown>,
	// 异步处理无业务返回值，HTTP正文通过response写出。
): Promise<void> {
	// GET用于服务器主动消息流；默认模拟器明确不支持它。
	if (request.method === "GET") {
		// 保存GET及原headers引用，没有业务message字段。
		requests.push({ method: "GET", headers: request.headers });
		// 405表示此端点不提供GET流，传输应停止该后台流而非关闭整个client。
		response.statusCode = 405;
		// 结束空正文响应，避免连接一直等待。
		response.end();
		// 结束本次请求处理，不再读GET正文或发工具结果。
		return;
	}
	// DELETE代表客户端尽力清理已知会话，本模拟器不验证会话ID是否真实存在。
	if (request.method === "DELETE") {
		// 单独记录DELETE及其认证/会话头，供关闭测试检查。
		requests.push({ method: "DELETE", headers: request.headers });
		// 回应200成功状态，不维护真正服务端会话表。
		response.statusCode = 200;
		// 结束DELETE响应，不返回JSON-RPC消息。
		response.end();
		// DELETE处理到此返回。
		return;
	}
	// 有body直接复用，否则完整读取UTF-8正文再JSON.parse；as只声明对象视图，不验证JSON一定为该结构。
	const message = body ?? (JSON.parse(await readBody(request)) as Record<string, unknown>);
	// 记录方法/头/原消息引用；method缺省用空串，??不会替换已有空串。
	requests.push({ method: request.method ?? "", headers: request.headers, message });
	// in检查整个属性链是否有id；缺id按通知处理，不是完整JSON-RPC分类验证。
	if (!("id" in message)) {
		// 通知无需JSON-RPC业务答复，回HTTP202确认。
		response.statusCode = 202;
		// 结束通知的空正文确认。
		response.end();
		// 通知不继续进入握手/工具分支。
		return;
	}
	// 只按方法文字识别握手，没有检查客户端版本或能力声明。
	if (message.method === "initialize") {
		// 握手成功状态和两个响应头一次写出。
		response.writeHead(200, {
			// 声明JSON响应，使HTTP传输走response.json分支。
			"content-type": "application/json",
			// 固定会话ID让后续POST/GET/DELETE能携带它，模拟器不生成随机会话。
			"mcp-session-id": "session-1",
		});
		// 把下方序列化握手结果写入并结束响应。
		response.end(
			// JSON.stringify把内存对象转成HTTP正文，不执行里面的字段。
			JSON.stringify({
				// 协议版本标识固定2.0。
				jsonrpc: "2.0",
				// 原样回显请求id，客户端靠编号匹配pending等待。
				id: message.id,
				// result承载握手业务数据，不放在error分支。
				result: {
					// 返回本包最新支持的协议文字。
					protocolVersion: LATEST_PROTOCOL_VERSION,
					// 声明提供工具能力，{}没有具体工具列表。
					capabilities: { tools: {} },
					// 固定模拟服务器身份，不从请求/环境读取。
					serverInfo: { name: "http-fixture", version: "1.0.0" },
				},
			}),
		);
		// 握手响应完成后返回，避免再写下面SSE。
		return;
	}
	// 工具枚举用JSON回应，与普通工具调用的SSE分开。
	if (message.method === "tools/list") {
		// 为此响应标JSON类型。
		response.setHeader("content-type", "application/json");
		// 发送并结束工具列表正文。
		response.end(
			// 编码下方JSON-RPC结果对象。
			JSON.stringify({
				// 工具列表同样使用协议2.0。
				jsonrpc: "2.0",
				// 回显此次列表请求编号，而不是固定复用握手编号。
				id: message.id,
				// 只提供echo及开放object参数schema；本模拟器不按该schema检查工具调用参数。
				result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
			}),
		);
		// 列表处理完即返回。
		return;
	}
	// 剩余带id方法统一回SSE，不只限tools/call，因此不是未知方法拒绝实现。
	response.writeHead(200, { "content-type": "text/event-stream" });
	// 先写事件ID字段，还未写空行，客户端会把它与随后data归为同一事件。
	response.write("id: tool-result\n");
	// 写最后的data行和空行，随后关闭本次HTTP正文。
	response.end(
		// 模板将固定hello结果JSON放进data；id取原请求编号，末尾两个LF结束事件，未根据传入text计算回复。
		`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "hello" }] } })}\n\n`,
	);
}

// 每个已执行用例后清理helper登记的服务；只跑内存流用例时数组为空，不会监听或关闭其他服务。
afterEach(closeServers);

// 纯内存SSE解析分组，无HTTP地址、fetch或端口。
describe("consumeSseStream", () => {
	// 把一个CRLF事件拆成两块，断言注释被忽略、id保留且两条data用LF合并；不在此JSON.parse data，也不测所有SSE字段/编码边界。
	it("parses chunked CRLF events, comments, IDs, and multiline data", async () => {
		// TextEncoder把固定测试文字编码UTF-8字节。
		const encoder = new TextEncoder();
		// 第一块在首条data结束后断开，第二块补下一data与空行；这是同一事件跨块，不是把一个多字节字符或单条字段拆开。
		const chunks = [': keepalive\r\nid: 7\r\ndata: {"one":\r\n', "data: 1}\r\n\r\n"];
		// 泛型规定每块为Uint8Array，创建内存ReadableStream，不连接网络。
		const stream = new ReadableStream<Uint8Array>({
			// 流构造时同步调用start，输入controller；把固定块入队再关闭，不使用定时器。
			start(controller) {
				// for...of按顺序编码/enqueue两块；enqueue只入队，不代表消费器已经处理。
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				// 标记入队完成，已有块仍由reader依次读出。
				controller.close();
			},
		});
		// 新事件数组，SseEvent只约束存储形状，不验证data是JSON。
		const events: SseEvent[] = [];
		// await读完流；同步onEvent把事件对象原引用push进数组，返回数组长度被void接口忽略。
		await consumeSseStream(stream, { onEvent: (event) => events.push(event) });
		// 深比较恰一事件：ID字符串7、正文内一个LF，无注释文字或额外event属性；不证明所有字段排列都可解析。
		expect(events).toEqual([{ id: "7", data: '{"one":\n1}' }]);
	});

	// 持续生成有LF却没有空行的data字段，断言累积data超过256字节及时拒绝；sent<100是此样本的工作量哨兵，不是通用内存/复杂度上界。
	it("rejects events whose data lines exceed the limit without a blank line", async () => {
		// 编码ASCII测试行，UTF-8每个x只占1字节。
		const encoder = new TextEncoder();
		// 可变发送次数从0起，包含pull被调用时的后置自增。
		let sent = 0;
		// 构造按需求提供数据的内存流，不预先分配1000行正文。
		const stream = new ReadableStream<Uint8Array>({
			// pull在流要求更多数据时执行，输入controller，无自身网络/计时；拒绝后释放reader锁不等于主动cancel底层流。
			pull(controller) {
				// Never sends a blank line, so the event is never dispatched.
				// 安全终止条件先比较旧sent再加1；测试预期在远早于此条件时已超预算，不靠1000次尾部关闭才发现错误。
				if (sent++ > 1000) controller.close();
				// 否则推一条16个x的data行，只有单LF，所以当前事件始终未遇空行分发。
				else controller.enqueue(encoder.encode("data: xxxxxxxxxxxxxxxx\n"));
			},
		});
		// 设data预算256并用空onEvent；rejects等待Promise拒绝，若意外触发onEvent此空回调不会主动让测试失败。
		await expect(consumeSseStream(stream, { maxEventBytes: 256, onEvent: () => {} })).rejects.toThrow(
			// 精确错误子串应指出256 bytes，排除依赖流自然结束才返回成功。
			"MCP SSE event exceeds 256 bytes",
		);
		// 检查生产端pull计数小于100，允许流自身预取，不要求精确等于某个data行数。
		expect(sent).toBeLessThan(100);
	});
});

// HTTP传输分组各用例会显式startServer；使用本机真实HTTP但固定数据，不调用外部OAuth/模型。
describe("StreamableHttpTransport", () => {
	// 一例串起initialize→JSON列表→SSE固定工具结果→close，断言会话/协议头与GET/DELETE出现；不证明GET真有可消费消息或模拟器实际执行echo。
	it("handles JSON and SSE responses with session and protocol headers", async () => {
		// 解构拿本机url与共享记录数组，创建真实监听资源。
		const { url, requests } = await startServer(protocolHandler);
		// 构造传输仅解析URL/保存配置，此时尚未发POST。
		const transport = new StreamableHttpTransport({ url });
		// 构造客户端身份，未连接时不登记请求timer。
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		// 等待initialize及initialized通知发送完成；后台GET不一定在connect兑现前完成。
		await client.connect(transport);
		// 检查握手响应头捕获的会话ID。
		expect(transport.sessionId).toBe("session-1");
		// 请求列表并深比较唯一echo描述，覆盖JSON结果分支。
		expect(await client.listTools()).toEqual([{ name: "echo", inputSchema: { type: "object" } }]);
		// 发带text参数工具调用，等待SSE关联响应；回复固定hello，并非服务端回显行为证明。
		expect(await client.callTool("echo", { text: "hello" })).toEqual({
			// 精确预期一个text内容块及hello字符串。
			content: [{ type: "text", text: "hello" }],
		});
		// await关闭，当前有session-1会尽力DELETE，并向后台GET发共享取消信号；不等于统一await所有后台任务结束。
		await client.close();

		// find只取第一条tools/list记录，可选链在缺message时给undefined。
		const listRequest = requests.find((entry) => entry.message?.method === "tools/list");
		// 可选链使没找到记录也断言失败，而不是访问undefined直接抛；检查列表携session头。
		expect(listRequest?.headers["mcp-session-id"]).toBe("session-1");
		// 检查列表携协商协议版本，不对所有请求逐条做此断言。
		expect(listRequest?.headers["mcp-protocol-version"]).toBe(LATEST_PROTOCOL_VERSION);
		// some只要求至少一条GET，不验证其数量或长连接已建立。
		expect(requests.some((entry) => entry.method === "GET")).toBe(true);
		// 至少一条DELETE说明关闭尝试了会话清理，不证明远端生产服务一定删除状态。
		expect(requests.some((entry) => entry.method === "DELETE")).toBe(true);
	});

	// 模拟握手HTTP401，断言异常局部字段及原挑战文字；resource_metadata仅作为字符串保存，不访问example.com或启动OAuth。
	it("classifies authentication failures", async () => {
		// 启动本机总回401的处理器，输入请求/响应。
		const { url } = await startServer(async (request, response) => {
			// 完整消费请求正文，不检查JSON方法，避免只针对某条业务。
			await readBody(request);
			// 给401与固定WWW-Authenticate头，挑战URL不在此被跟随。
			response.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="https://example.com/meta"' });
			// 错误正文固定login required，传输会将它保存在认证异常中。
			response.end("login required");
		});
		// 新建客户端，与上一用例状态隔离。
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		// 连接Promise应拒绝；toMatchObject只要求列出字段符合，不验证整个异常对象精确等同。
		await expect(client.connect(new StreamableHttpTransport({ url }))).rejects.toMatchObject({
			// 核对运行时name字段，不直接以此行执行instanceof。
			name: "McpAuthRequiredError",
			// 预期分类状态固定401。
			status: 401,
			// 核对读取的HTTP正文摘录。
			body: "login required",
			// 核对未解码的挑战原文，包括resource_metadata。
			wwwAuthenticate: 'Bearer resource_metadata="https://example.com/meta"',
			// satisfies Partial只检查预期对象的TS字段兼容性，不自动验证实际异常或补其余字段。
		} satisfies Partial<McpAuthRequiredError>);
	});

	// 同时保留slow等待与返回坏JSON的broken，断言broken失败、slow仍成功且错误通道只收一次。坏事件被报告后EOF无答复转对应请求错误，不应把它说成关闭整个连接。
	it("fails only the request whose SSE stream breaks", async () => {
		// 先占位为无操作函数，之后Promise执行器把真正resolve赋给它。
		let releaseSlow = () => {};
		// 创建可手动放行的Promise<void>，执行器立即运行，不靠固定延时模拟慢工具。
		const slowGate = new Promise<void>((resolve) => {
			// 保存resolve为releaseSlow；调用它只兑现闸门，不直接写HTTP响应。
			releaseSlow = resolve;
		});
		// 本机handler解析工具名后区分slow/broken，其余委派默认模拟器。
		const { url } = await startServer(async (request, response, requests) => {
			// GET/DELETE等非POST直接用默认处理器，return转交其Promise使异常继续传播。
			if (request.method !== "POST") return protocolHandler(request, response, requests);
			// 读完整POST正文后类型断言为消息对象，没有schema验证。
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			// 断言params可有name并用?.读它；as不转换真实params形状。
			const name = (message.params as { name?: string } | undefined)?.name;
			// 工具名broken走故障响应。
			if (name === "broken") {
				// HTTP仍200/SSE，故这里要测试的是事件正文解析失败而非HTTP状态失败。
				response.writeHead(200, { "content-type": "text/event-stream" });
				// 发送无法JSON.parse的data事件后结束流，不给合法关联结果。
				response.end("data: not json\n\n");
				// 坏流分支返回，不再发送默认hello。
				return;
			}
			// slow分支await闸门，其他名字不会等待它。
			if (name === "slow") await slowGate;
			// 放行后把已读message交默认处理器，避免再次读取已消费的输入流。
			await protocolHandler(request, response, requests, message);
		});
		// 构造独立客户端等待两次请求。
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		// 收集实际错误通道的Error引用。
		const errors: Error[] = [];
		// 登记同步监听器，把每次错误push记录，不抛新错。
		client.onError((error) => errors.push(error));
		// 禁用后台GET，避免服务器消息流干扰此请求流隔离样本。
		await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));

		// 先启动slow但不await，令它与broken请求同时在途。
		const slow = client.callTool("slow");
		// broken应因响应流没合法答复而拒绝，错误文字与流失败分类对应。
		await expect(client.callTool("broken")).rejects.toThrow("MCP response stream failed");
		// 失败断言后才放行slow，确保坏流没有把它一并结束。
		releaseSlow();
		// slow能得到固定hello；不比较两请求响应具体到达时刻。
		expect(await slow).toEqual({ content: [{ type: "text", text: "hello" }] });
		// 只有坏JSON走一次错误报告；对应JSON-RPC错误拒绝broken不另增加此数组。
		expect(errors).toHaveLength(1);
		// 显式关闭客户端，helper的afterEach另外释放本机服务。
		await client.close();
	});

	// 记录方法顺序，断言GET晚于initialized通知，且这轮没有续传头。虽然标题提resuming，此例本身没有触发重连，实际续传在后续用例单测。
	it("opens the GET stream after initialization and sends Last-Event-ID only when resuming", async () => {
		// 记录实际进入handler的顺序，不是客户端函数调用时间线。
		const order: string[] = [];
		// 启动带额外顺序记录的本机服务。
		const { url, requests } = await startServer(async (request, response, requests) => {
			// POST正文需先解码才能提取JSON-RPC方法。
			if (request.method === "POST") {
				// 读取并解码一条消息；as仍不是运行时guard。
				const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
				// String把method转文字后push；即使它缺失也会记字符串undefined。
				order.push(String(message.method));
				// 委派已解码对象，默认处理器按具体方法写响应。
				return protocolHandler(request, response, requests, message);
			}
			// 非POST记录HTTP方法，缺省空串。
			order.push(request.method ?? "");
			// GET/DELETE交默认分支，GET会405结束，故此例不会长期挂流。
			return protocolHandler(request, response, requests);
		});
		// 创建新客户端，不复用前一用例计数。
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		// 正常握手允许initialized后后台GET启动。
		await client.connect(new StreamableHttpTransport({ url }));
		// 再调用一次工具取得SSE结果，增加初始化后的活动。
		await client.callTool("echo");
		// 再枚举工具取得JSON结果。
		await client.listTools();
		// 显式close使已知会话DELETE写入记录。
		await client.close();
		// 比较第一次GET与initialized在order中的索引；indexOf缺项会给-1，此断言至少不能把“缺GET”当晚于已存在通知。
		expect(order.indexOf("GET")).toBeGreaterThan(order.indexOf("notifications/initialized"));
		// every要求当前所有已记录请求都没Last-Event-ID；空数组会真，但前面已经通过正常协议记录多条请求。
		expect(requests.every((entry) => entry.headers["last-event-id"] === undefined)).toBe(true);
	});

	// POST先给id:1和空data后断流，期望GET携Last-Event-ID:1取到工具结果；不重发tools/call，服务将其答复写为固定id2。
	it("resumes a response stream the server closed before answering", async () => {
		// 记录续传GET实际携的头值，数组元素允许undefined以兼容Node头断言视图。
		const resumeHeaders: (string | undefined)[] = [];
		// 本机服务为带续传头的GET提供特殊结果，其余沿默认协议。
		const { url } = await startServer(async (request, response, requests) => {
			// 只把GET且真值Last-Event-ID视作本例恢复；并未全面验证任意续传头格式。
			if (request.method === "GET" && request.headers["last-event-id"]) {
				// Node头可能string|string[]，as string只按本样本预期收窄，不转换数组。
				resumeHeaders.push(request.headers["last-event-id"] as string);
				// 用SSE响应恢复GET，HTTP成功不等最终消息编号正确。
				response.writeHead(200, { "content-type": "text/event-stream" });
				// 发送并结束恢复事件正文。
				response.end(
					// 事件ID改为2，业务响应id也固定数字2，对应首次握手后这次callTool的请求编号；结果文字resumed。
					`id: 2\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "resumed" }] } })}\n\n`,
				);
				// 恢复分支完成，不继续读取无正文GET。
				return;
			}
			// 其他GET/DELETE使用默认405/200处理。
			if (request.method !== "POST") return protocolHandler(request, response, requests);
			// 读取POST JSON消息，供辨别工具请求。
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			// 除tools/call外使用正常握手/通知/列表响应。
			if (message.method !== "tools/call") return protocolHandler(request, response, requests, message);
			// Priming event (ID, no data) and a retry hint, then the server drops the stream.
			// 工具调用故意只回续传预备SSE，不给JSON-RPC结果。
			response.writeHead(200, { "content-type": "text/event-stream" });
			// id:1立即更新游标，retry:5提示毫秒等待；空data会形成空事件但上层忽略正文，随后end造成恢复GET。
			response.end("id: 1\nretry: 5\ndata:\n\n");
		});
		// 创建独立客户端，首个initialize id1，首个工具请求id2。
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		// 收集错误通道，成功恢复不应报告错误。
		const errors: Error[] = [];
		// 把报告的Error原引用加入数组。
		client.onError((error) => errors.push(error));
		// 关闭常驻GET功能，但不禁止单个POST响应流的GET续传。
		await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
		// 工具Promise应最终从恢复GET得到resumed，而非等默认超时。
		expect(await client.callTool("echo")).toEqual({ content: [{ type: "text", text: "resumed" }] });
		// 恰一条恢复头值1，排除无头重开或额外恢复次数。
		expect(resumeHeaders).toEqual(["1"]);
		// 错误数组仍空；不是证明所有网络故障都能无错恢复。
		expect(errors).toEqual([]);
		// 关闭带session-1的客户端并尽力DELETE。
		await client.close();
	});

	// 工具SSE只有注释并EOF，无事件ID可恢复，断言专用流结束错误而非等5000ms超时；不以此证明所有无回复情况都同路径。
	it("fails a request whose response stream ends without an answer", async () => {
		// 启动本机带缺答复分支的模拟器。
		const { url } = await startServer(async (request, response, requests) => {
			// 非POST委派默认handler。
			if (request.method !== "POST") return protocolHandler(request, response, requests);
			// 解码POST正文消息。
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			// 非工具调用仍正常握手/确认，确保失败集中在tools/call。
			if (message.method !== "tools/call") return protocolHandler(request, response, requests, message);
			// 工具响应声明SSE/HTTP200，不是HTTP错误。
			response.writeHead(200, { "content-type": "text/event-stream" });
			// 只写一条SSE注释和空行；没有data、没有id，正文结束时请求仍未回答。
			response.end(": nothing here\n\n");
		});
		// 本轮独立客户端。
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		// 禁用后台GET；本工具响应无ID，所以也不会GET续传。
		await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
		// 给5000ms单次等待上限作为兜底；期待实际失败文字不是timeout错误，没有单独断言耗时。
		await expect(client.callTool("echo", {}, { timeoutMs: 5_000 })).rejects.toThrow(
			// 精确流结束原因应为stream ended without a response。
			"MCP response stream failed: stream ended without a response",
		);
		// 请求拒绝后显式close。
		await client.close();
	});

	// 常驻GET第一次给g1并结束，第二次给g2保持打开；等收到第二条通知再断言重开头为g1。此例不测POST响应流恢复或重试耗尽。
	it("reconnects the GET stream after it drops", async () => {
		// 可变GET次数从0起。
		let gets = 0;
		// 保存每次GET的Last-Event-ID，联合数组用括号避免误读成string与数组的联合。
		const lastEventIds: (string | undefined)[] = [];
		// 启动能为GET单独分支的本机服务。
		const { url } = await startServer(async (request, response, requests) => {
			// POST/DELETE仍委派默认协议，只有GET使用下面逻辑。
			if (request.method !== "GET") return protocolHandler(request, response, requests);
			// 每次GET到达时先增加计数。
			gets++;
			// 记录头原值并作string|undefined断言，不在此校验多个同名头数组。
			lastEventIds.push(request.headers["last-event-id"] as string | undefined);
			// 为GET立即发出SSE响应头。
			response.writeHead(200, { "content-type": "text/event-stream" });
			// 固定无id工具列表变更通知，不会结算本地主动请求pending。
			const notification = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
			// 只在第一次GET分支主动结束连接。
			if (gets === 1) {
				// 事件g1携通知，end让后台循环走退避恢复。
				response.end(`id: g1\ndata: ${JSON.stringify(notification)}\n\n`);
				// 第一轮结束后return，不接着写g2。
				return;
			}
			// 后续GET写g2事件但不end，等待client.close或helper清理；不是在此立即兑现整个响应流。
			response.write(`id: g2\ndata: ${JSON.stringify(notification)}\n\n`);
		});
		// 构造独立客户端。
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		// 收到的工具变更通知次数。
		let changes = 0;
		// 创建等第二条通知的闸门，执行器立即登记监听。
		const secondChange = new Promise<void>((resolve) => {
			// 按确切通知名登记回调，无手动取消函数保留；client实例随后不再使用。
			client.onNotification("notifications/tools/list_changed", () => {
				// 前置自增后恰为2才resolve，不是第一条到达即放行。
				if (++changes === 2) resolve();
			});
		});
		// 配置本地初始重连等待1ms用于缩短样本，不保证毫秒精准，也没设置server retry。
		await client.connect(new StreamableHttpTransport({ url, reconnect: { initialDelayMs: 1 } }));
		// 等通知回调真达到第二次，不靠固定sleep猜GET是否已重开。
		await secondChange;
		// 第一次无续传头、第二次携g1，深比较同时检查顺序/数量。
		expect(lastEventIds).toEqual([undefined, "g1"]);
		// close中止共享fetch信号以取消第二条未end的GET，再尽力DELETE；没有逐个await所有后台消费任务。
		await client.close();
	});

	// 工具请求HTTP202但无JSON-RPC答复应立即拒绝，不把接受处理视作工具完成；与无data的SSE EOF是不同分支。
	it("rejects a request the server accepts without a response", async () => {
		// 本机服务为tools/call准备202分支。
		const { url } = await startServer(async (request, response, requests) => {
			// 非POST仍正常处理。
			if (request.method !== "POST") return protocolHandler(request, response, requests);
			// 完整解析POST消息后读method。
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			// 初始化/通知等其他方法保持正常协议路径。
			if (message.method !== "tools/call") return protocolHandler(request, response, requests, message);
			// 工具调用被接受但没有业务结果，HTTP202。
			response.statusCode = 202;
			// 结束空正文，客户端send检查此状态后拒绝请求。
			response.end();
		});
		// 独立客户端。
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		// 正常握手且禁用常驻GET，以便只观察工具202分支。
		await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
		// 断言工具Promise拒绝文字含without a response，不要求异常完整结构。
		await expect(client.callTool("echo")).rejects.toThrow("without a response");
		// 失败后关闭客户端。
		await client.close();
	});

	// 模拟HTTP400带短正文，断言通用错误message包含状态和正文；这一个短样本不覆盖长正文截取、Unicode或敏感数据处理。
	it("includes the response body in HTTP errors", async () => {
		// 创建本机总回400的处理器。
		const { url } = await startServer(async (request, response) => {
			// 完整读取请求，未校验Accept是否真有问题；错误文字仅由模拟器固定提供。
			await readBody(request);
			// 设置HTTP400失败状态。
			response.statusCode = 400;
			// 固定正文供checkResponse读取与describeHttpFailure拼预览。
			response.end("Invalid Accept header");
		});
		// 新客户端，connect失败会尝试自己的close。
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		// 等待连接拒绝，不将失败当握手结果。
		await expect(client.connect(new StreamableHttpTransport({ url }))).rejects.toThrow(
			// 预期错误包含400及服务端正文；toThrow匹配的是message内容。
			"MCP HTTP request failed with status 400: Invalid Accept header",
		);
	});

	// 握手旧token遭401→提供者改new，工具new遭insufficient_scope403→改admin，断言两次恢复上下文含实际被拒token。只模拟改字符串，不实现OAuth发现/刷新/权限批准。
	it("hands 401 and insufficient-scope 403 responses to the auth provider with the rejected token", async () => {
		// 记录status与可选token字段；数组保存恢复回调构造的对象。
		const seen: { status: number; token?: string }[] = [];
		// 共享token变量驱动下一轮请求头，初始old。
		let token = "old";
		// 启动按方法和Authorization分支的本机服务。
		const { url } = await startServer(async (request, response, requests) => {
			// 非POST仍默认GET/DELETE行为，不读取其业务正文。
			if (request.method !== "POST") return protocolHandler(request, response, requests);
			// 解析POST消息，用于区分握手和tools/call。
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			// 任何带Bearer old的POST都先拒绝为401。
			if (request.headers.authorization === "Bearer old") {
				// 链式writeHead返回response，随后end结束同一响应；Bearer头没有scope要求。
				response.writeHead(401, { "www-authenticate": "Bearer" }).end();
				// 拒绝后return，不发送默认JSON/SSE成功结果。
				return;
			}
			// 只有tools/call携new才拒绝为403，初始化携new可正常成功。
			if (message.method === "tools/call" && request.headers.authorization === "Bearer new") {
				// 明确error=insufficient_scope和admin挑战，触发HTTP传输允许的403恢复分类。
				response.writeHead(403, { "www-authenticate": 'Bearer error="insufficient_scope", scope="admin"' }).end();
				// 403处理后return，不误接成功结果。
				return;
			}
			// 其他授权文字如admin不做真实校验，直接默认成功。
			return protocolHandler(request, response, requests, message);
		});
		// 创建测试客户端。
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		// 等待带自定义认证提供者的传输握手。
		await client.connect(
			// 构造传输并传入下面配置。
			new StreamableHttpTransport({
				// 对象简写url指向本机/mcp。
				url,
				// 不额外开后台GET，令认证恢复顺序只受本例POST影响。
				openGetStream: false,
				// 注入简单AuthProvider对象，不使用持久化OAuth provider。
				authProvider: {
					// async getter每次兑现当前token文字，不读取磁盘/真实凭证。
					token: async () => token,
					// 恢复回调参数解构，并把token重命名为rejected，避免遮住外层可变token。
					onUnauthorized: async ({ response, token: rejected }) => {
						// 记录HTTP状态与此次失败请求携带的令牌快照，不以当前外层新值替代。
						seen.push({ status: response.status, token: rejected });
						// 401使下一轮取token得到new。
						if (response.status === 401) token = "new";
						// 本例其余恢复即403，改为admin；没有按scope字符串计算授权。
						else token = "admin";
					},
				},
			}),
		);
		// 工具调用应在恢复后拿固定hello结果，不证明admin在外部服务器真实有效。
		expect(await client.callTool("echo")).toEqual({ content: [{ type: "text", text: "hello" }] });
		// 深比较两次恢复按先401后403发生，且无其他上下文记录。
		expect(seen).toEqual([
			// 第一次失败上下文必须是旧old。
			{ status: 401, token: "old" },
			// 第二次失败上下文必须是新new，而不是更新后的admin。
			{ status: 403, token: "new" },
		]);
		// 关客户端，DELETE会复用最近取到的admin而不再运行恢复。
		await client.close();
	});

	// #10598: a request cancelled or timed out while waiting for a shared refresh must not be retried.
	// 三个工具请求共享被闸门卡住的模拟认证恢复；一个主动abort、一个200ms超时，放行后只kept可再次派发执行。此例共享Promise由假提供者实现，不证明HTTP传输自动合并任意认证提供者，也不撤销已经发过的旧token POST。
	it("does not retry requests that were cancelled while authorization was recovering", async () => {
		// 初始旧token仅测试字符串。
		let token = "old";
		// 记录到达允许执行分支的工具名字；unknown[]本身不验证元素。
		const executed: unknown[] = [];
		// 本机服务拒绝旧token工具请求，但允许握手和其他消息。
		const { url } = await startServer(async (request, response, requests) => {
			// 非POST委派默认分支。
			if (request.method !== "POST") return protocolHandler(request, response, requests);
			// 先消费并解码POST正文。
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			// 只有tools/call且带old才触发401，初始握手也用old但会成功。
			if (message.method === "tools/call" && request.headers.authorization === "Bearer old") {
				// 旧工具POST返回Bearer挑战和空正文。
				response.writeHead(401, { "www-authenticate": "Bearer" }).end();
				// 结束该处理器调用，旧token请求不加入executed。
				return;
			}
			// 允许通过的tools/call才记录params.name，as是假定该测试客户端传合格对象，不是服务端输入校验。
			if (message.method === "tools/call") executed.push((message.params as { name: string }).name);
			// 其他情况用默认结果处理；取消通知无id时回202，不加入executed。
			return protocolHandler(request, response, requests, message);
		});
		// 保存未来闸门resolve的占位函数，初始无操作。
		let releaseRefresh = () => {};
		// 创建共享恢复等待Promise，无定时自动放行。
		const refreshGate = new Promise<void>((resolve) => {
			// 保存resolve以供测试最后手动结束恢复。
			releaseRefresh = resolve;
		});
		// 用于合并恢复的Promise尚未创建，联合undefined表达这个状态。
		let refresh: Promise<void> | undefined;
		// 记录真正创建共享刷新Promise的次数，不等于onUnauthorized调用次数。
		let refreshes = 0;
		// 记录进入恢复回调的工具请求数。
		let waiting = 0;
		// 保存等三请求到齐的resolve，先用空函数占位。
		let allWaiting = () => {};
		// 创建三请求都在等待恢复的闸门。
		const waitingGate = new Promise<void>((resolve) => {
			// 保存它的resolve回调，不在此立即兑现。
			allWaiting = resolve;
		});
		// 构造新客户端，所有工具请求共用它的传输/提供者。
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		// 先完成握手，再发下面三个工具请求。
		await client.connect(
			// 构造HTTP传输配置。
			new StreamableHttpTransport({
				// url简写传本机地址。
				url,
				// 禁用常驻GET，排除额外认证读token/恢复干扰。
				openGetStream: false,
				// 这个对象自己实现并发恢复合并，不调用真实OAuth。
				authProvider: {
					// 每次取当前共享token值，old在闸门放开前保持不变。
					token: async () => token,
					// 恢复回调返回Promise，await共享闸门期间其他请求仍可进入同一回调。
					onUnauthorized: async () => {
						// 首次进入时refresh尚空，后两次复用已有Promise。
						if (!refresh) {
							// 只有首次为真正创建计数加1。
							refreshes++;
							// 在闸门兑现后才更新token，保存then返回的共享Promise。
							refresh = refreshGate.then(() => {
								// 新token仅为测试文字new，不发刷新HTTP。
								token = "new";
							});
						}
						// 每次恢复回调进入都增加waiting，恰三次时放行等待测试步骤。
						if (++waiting === 3) allWaiting();
						// 三个回调各自await同一refresh，取消某业务等待不会取消这个共享Promise。
						await refresh;
					},
				},
			}),
		);
		// 创建仅供aborted这个调用使用的取消控制器。
		const controller = new AbortController();
		// 开始第一个请求并保留Promise，signal主动取消只结束其本地等待及后续重试派发许可。
		const aborted = client.callTool("aborted", {}, { signal: controller.signal });
		// 第二个请求用200ms本地超时，数字不是整个OAuth共享恢复的超时。
		const timedOut = client.callTool("timed-out", {}, { timeoutMs: 200 });
		// 第三个不额外设signal/时长，沿客户端默认等待。
		const kept = client.callTool("kept");
		// 先确认三请求都进入恢复，避免取消发生在旧token请求发出之前而漏测迟到重试。
		await waitingGate;
		// 此时abort第一个调用；共享refreshGate保持未兑现。
		controller.abort();
		// 确认第一个业务Promise拒绝为AbortError，不代表已经发出的旧POST在服务端被撤销。
		await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
		// 等第二个业务Promise超时拒绝，恢复闸门仍卡住；toMatchObject只比较name。
		await expect(timedOut).rejects.toMatchObject({ name: "McpTimeoutError" });
		// 两个已放弃后才放行共享恢复，使它们有机会错误地迟到重发，因此断言具备针对性。
		releaseRefresh();
		// 仍等待的kept应成功得到hello，说明共享认证没有被其他调用取消。
		expect(await kept).toEqual({ content: [{ type: "text", text: "hello" }] });
		// 只有kept进入允许执行分支；旧token的三个失败POST本来已发过，未记在此数组。
		expect(executed).toEqual(["kept"]);
		// 断言假提供者只建一份共享刷新Promise，不是所有恢复回调只调用一次。
		expect(refreshes).toBe(1);
		// 最后显式关闭客户端/会话。
		await client.close();
	});

	// #10565: the auth provider may refresh over the network, which closing must not wait for.
	// 认证token getter每次生成新文字，记录close前次数，再断言DELETE复用最后取值且没有再问提供者。没有挂起真实刷新，也不直接测close耗时上界。
	it("closes the session with the last request's token, without asking the auth provider", async () => {
		// 正常模拟器记录所有请求，以便从中筛DELETE。
		const { url, requests } = await startServer(protocolHandler);
		// 可变token getter调用次数。
		let calls = 0;
		// 构造客户端身份。
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		// 用下面认证配置正常握手。
		await client.connect(
			// 构造带提供者的HTTP传输。
			new StreamableHttpTransport({
				// 本机url简写。
				url,
				// 禁用后台GET，避免它额外取token导致记录时序干扰。
				openGetStream: false,
				// async每次前置自增并生成token-N；这只是固定内存函数，没有实际凭据刷新。
				authProvider: { token: async () => `token-${++calls}` },
			}),
		);
		// 记录显式close开始前已调用次数，而不硬编码握手必恰两次。
		const before = calls;
		// await尽力DELETE及传输关闭事件。
		await client.close();
		// close过程不得增加token getter调用次数。
		expect(calls).toBe(before);
		// filter得到所有实际收到的DELETE，不只find第一条。
		const deletes = requests.filter((entry) => entry.method === "DELETE");
		// 数组深比较要求恰一DELETE且Authorization对应close前最后一次取值。
		expect(deletes.map((entry) => entry.headers.authorization)).toEqual([`Bearer token-${before}`]);
		// 检查该DELETE同时携session-1，缺DELETE时?.会给undefined令断言失败。
		expect(deletes[0]?.headers["mcp-session-id"]).toBe("session-1");
	});

	// #10188: Cloudflare Workers reject the platform fetch when called with a receiver other than globalThis.
	// 用严格接收者替身分别验证显式fetch与缺省全局fetch的调用方式；仍真实访问本机服务，不是Cloudflare运行环境验证。恢复回调还会走context.fetch，覆盖两条转发通路。
	it("calls fetch without a receiver", async () => {
		// 先保存真实宿主fetch引用，替身内部调用它而不递归引用被替换的全局变量。
		const realFetch = globalThis.fetch;
		// 普通function可观察动态this；this:unknown是TS伪参数，运行时不占第一个实参，input/init为真实请求参数。
		const strictFetch = function (this: unknown, input: string | URL, init?: RequestInit) {
			// 只允许裸调用undefined或平台globalThis接收者，传输/context对象接收者会抛Illegal invocation。
			if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
			// 调用捕获的realFetch发真实本机HTTP，不是返回内存Response。
			return realFetch(input, init);
			// satisfies检查参数/返回与McpFetch兼容，保留当前函数类型，不运行或包装它。
		} satisfies McpFetch;
		// 启动本机无Authorization的POST回401的模拟器。
		const { url } = await startServer(async (request, response, requests) => {
			// 只有未带认证头的POST拒绝，context.fetch的GET仍进入默认405。
			if (request.method === "POST" && request.headers.authorization === undefined) {
				// 拒绝前完整读取POST正文。
				await readBody(request);
				// 发送401 Bearer挑战，触发注入提供者恢复回调。
				response.writeHead(401, { "www-authenticate": "Bearer" }).end();
				// 拒绝分支结束，不再给握手成功正文。
				return;
			}
			// 其他请求委派默认handler，包括恢复后带token的POST和关闭DELETE。
			return protocolHandler(request, response, requests);
		});
		// 局部connect辅助接显式fetch或undefined，正常握手/列工具/关闭，返回void Promise；例connect(strictFetch)能查传输及context转发是否错误绑定this。失败直接拒绝，服务由外层afterEach收尾。
		const connect = async (fetch: McpFetch | undefined) => {
			// 每次helper调用有独立未定义token，确保两次都能触发401恢复。
			let token: string | undefined;
			// 每次helper新客户端，避免复用closed实例。
			const client = new McpClient({ name: "http-test", version: "1.0.0" });
			// 等待这轮握手恢复完成。
			await client.connect(
				// new传输捕获显式fetch或此刻的globalThis.fetch，构造时不会调用它。
				new StreamableHttpTransport({
					// 传同一本机服务URL，两轮共用模拟服务但不共用客户端状态。
					url,
					// 属性简写fetch；值undefined时构造器才选全局fetch。
					fetch,
					// 关闭常驻GET，仍保留认证回调内手动GET及POST响应SSE。
					openGetStream: false,
					// 注入仅存局部token的简单提供者。
					authProvider: {
						// token getter返回当前可选文字，不进行I/O。
						token: async () => token,
						// 恢复回调接上下文，其中fetch是HTTP传输对底层fetch的裸调用包装。
						onUnauthorized: async (context) => {
							// 先await手动GET到本机，再可选取消正文并await；没有在这行检查Response.ok，405也可以消费后继续。
							await (await context.fetch(url)).body?.cancel();
							// 手动请求返回后把token设固定文字，使握手重试可以通过。
							token = "token";
						},
					},
				}),
			);
			// 检查恢复后能列表，固定echo结果说明协议成功继续，不单靠没有抛Illegal invocation判断。
			expect(await client.listTools()).toEqual([{ name: "echo", inputSchema: { type: "object" } }]);
			// helper成功路径显式关闭客户端，异常路径没有独立finally关此实例。
			await client.close();
		};

		// 先测试构造参数显式传strictFetch的情况。
		await connect(strictFetch);
		// 再替换全局fetch为同一严格函数；它内部已捕获原函数，因此不递归。
		vi.stubGlobal("fetch", strictFetch);
		// 替换成功后进入try/finally，保护后续失败也恢复全局。
		try {
			// 传undefined迫使构造器取当前已被替换的全局fetch。
			await connect(undefined);
			// 第二轮成功或失败都进finally。
		} finally {
			// 恢复Vitest保存的全部全局替身，不只本地名为fetch的变量。
			vi.unstubAllGlobals();
		}
	});

	// 模拟第三个及以后的POST回404：initialize/initialized成功后listTools应分类为会话过期。仅本例用已知session-1，没有测未建立会话的普通404路径。
	it("classifies an expired established session", async () => {
		// 已观察POST数，GET/DELETE由于&&短路不增加。
		let posts = 0;
		// 创建按POST次数分支的本机服务。
		const { url } = await startServer(async (request, response, requests) => {
			// 后置++先比较旧值：第1/2个POST通过，第3个开始404；只有左侧是POST才执行计数。
			if (request.method === "POST" && posts++ >= 2) {
				// 失败前完整读掉该POST正文，不解码其方法。
				await readBody(request);
				// HTTP404在传输已存会话时会变McpSessionExpiredError。
				response.statusCode = 404;
				// 给固定gone正文，异常会保存其摘录，此用例未断言该body字段。
				response.end("gone");
				// 失败分支return，不再走默认成功结果。
				return;
			}
			// 头两POST仍正常完成握手并保存session-1，DELETE仍按默认200处理。
			await protocolHandler(request, response, requests);
		});
		// 独立客户端。
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		// 连接时恰好正常initialize请求与initialized通知两个POST，禁用常驻GET。
		await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
		// 第三次POST的listTools应拒绝为专用异常，instanceof验证类而非仅name文字。
		await expect(client.listTools()).rejects.toBeInstanceOf(McpSessionExpiredError);
		// 会话过期不自动证明客户端已close，所以此处仍显式关闭并尽力DELETE。
		await client.close();
	});
});
