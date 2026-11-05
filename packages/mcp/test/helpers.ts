// 为HTTP/OAuth集成测试提供读正文、启动loopback服务和统一关闭的辅助函数。导入本文件只建空数组，不监听；显式listen会开真实端口，纯内存client/content测试没有调用它。
// createServer是运行时函数，IncomingMessage/Server/ServerResponse带type只参与TS检查。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

// 异步HTTP处理器的函数类型：输入请求流、响应及实际origin，返回Promise<void>；例：async(req,res)=>{res.end("ok")}。类型不会自动捕获异常或令同步抛错变Promise拒绝，listen只catch函数返回的Promise。
export type HttpHandler = (request: IncomingMessage, response: ServerResponse, origin: string) => Promise<void>;

// 模块级服务器数组，保存listen成功登记的实例，供closeServers批量清理；不是所有进程HTTP服务的全局清单。
const servers: Server[] = [];

// 把整个IncomingMessage异步流读成UTF-8字符串，输入请求返回正文Promise；例：多个UTF-8字节块合并后解码，避免逐块解码拆开字符。无大小限制/流式解析，流失败或Buffer转换失败会拒绝，不自动回HTTP错误。
export async function readBody(request: IncomingMessage): Promise<string> {
	// Buffer[]是字节缓冲数组，开始为空；还没拼成一份连续正文。
	const chunks: Buffer[] = [];
	// for await按异步迭代取得块，每块Buffer.from复制/转换后push；等待输入流结束而非只读首块，失败直接向外传播。
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	// 先concat为完整字节序列再UTF-8解码；大正文会同时占用块数组/合并缓冲/字符串内存，没有截断或JSON.parse。
	return Buffer.concat(chunks).toString("utf8");
}

/** Starts a loopback HTTP server and returns its origin. Call `closeServers` from `afterEach`. */
// 输入异步handler，启动127.0.0.1动态端口HTTP服务并返回origin Promise；例：返回http://127.0.0.1:12345供测试fetch。会真实监听并登记到数组，需afterEach(closeServers)；没有绑定error拒绝监听/通用失败清理，不能视作生产服务框架。
export async function listen(handler: HttpHandler): Promise<string> {
	// 先声明可变空origin供请求闭包引用，成功绑定后才填实际地址。
	let origin = "";
	// createServer登记每次请求的同步监听器，尚未调用listen；不自动读取body，由handler自行readBody。
	const server = createServer((request, response) => {
		// 调用handler后给其返回Promise接catch并void丢弃整条链，不等待HTTP事件回调结束；handler若同步throw，或catch里String/end再抛错，不会被这条catch兜住。
		void handler(request, response, origin).catch((error) => {
			// 异步处理拒绝时把响应状态设500；若此前头已发送，不保证能改浏览器已收到的状态。
			response.statusCode = 500;
			// 把抛出值String化作为完整响应正文，不截断/脱敏，也不设置Content-Type；String或end自身仍可抛错。
			response.end(String(error));
		});
	});
	// 用0请求系统分配端口并await成功回调，Promise执行器能捕获同步throw，但这里没有为异步error事件注册reject处理。
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	// 成功后读Node地址，TCP应为含port的对象，关闭/未绑定可null，IPC可string。
	const address = server.address();
	// 不接受空/字符串地址，抛固定Error；本分支没有finally把server关闭。
	if (!address || typeof address === "string") throw new Error("HTTP test server did not bind to TCP");
	// 拼实际IPv4 loopback origin，不含任何业务路径/查询。
	origin = `http://127.0.0.1:${address.port}`;
	// 绑定且取址成功才把server登记，之前失败的实例不会由这个数组自动找到。
	servers.push(server);
	// 返回字符串给测试拼资源路径，调用者获得的是地址而不是服务实例。
	return origin;
}

// 关闭本模块已登记全部HTTP服务，输入无参数返回void Promise；例：afterEach(closeServers)作为各用例的集中清理入口。先清数组，再并行强制关闭HTTP连接/停止监听；任何关闭失败会拒绝，空数组立即完成，失败条目不会自动重新入队。
export async function closeServers(): Promise<void> {
	// Promise.all并行等待所有关闭Promise，首个拒绝让整体失败，但不取消其他已开始的关闭。
	await Promise.all(
		// splice(0)一次取走所有登记实例并清原数组，再map创建每个关闭动作；不会包含以后才登记的服务。
		servers
			.splice(0)
			.map(
				// 箭头为每个取走的server生成关闭Promise，不复用同一个实例。
				(server) =>
					// Promise<void>等待Node关闭回调，执行器里的同步关闭错误也会变成拒绝。
					new Promise<void>((resolve, reject) => {
						// closeAllConnections强制关闭当前HTTP(S)连接，不保证关闭升级成WebSocket等连接；先调用它再close，不把此处顺序说成完全杜绝新连接竞态。
						server.closeAllConnections();
						// close停止监听并在关闭完成回调中按error拒绝/兑现；不能凭方法返回就说端口已释放。
						server.close((error) => (error ? reject(error) : resolve()));
					}),
			),
	);
}
