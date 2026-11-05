// 这是评测自用的本地 HTTP 假供应商：只返回固定字符串，不连接真实模型。
// openai 模式用 SSE（以 data: 行发送事件），stream 模式用 NDJSON（每行一个 JSON）。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

// 这些固定标识、探测提示词和预期答案由场景、服务端和测试共同引用；不是生产凭证。
export const OPENAI_PROVIDER_ID = "acme";
export const OPENAI_MODEL_ID = "acme-chat";
export const OPENAI_PROBE_PROMPT = "Reply with ACME_OK.";
export const OPENAI_PROBE_RESPONSE = "ACME_OK";
export const STREAM_PROVIDER_ID = "acme-stream";
export const STREAM_MODEL_ID = "acme-stream-chat";
export const STREAM_PROBE_PROMPT = "Reply with ACME_STREAM_OK.";
export const STREAM_PROBE_RESPONSE = "ACME_STREAM_OK";

// 把手写 API 说明转成带缩进的 JSON 文本，作为工作区夹具交给被评测代理阅读。
// 这里的模板字符串内容必须原样保留；示例 Hello 不代表真实请求一定发送 Hello。
export const STREAM_API_DOCUMENTATION = `${JSON.stringify(
	{
		name: "Acme Streaming API",
		request: {
			method: "POST",
			path: "/generate",
			headers: { "content-type": "application/json", "x-acme-key": "resolved credential" },
			body: { model: STREAM_MODEL_ID, messages: [{ role: "user", content: "Hello" }], stream: true },
		},
		response: {
			contentType: "application/x-ndjson",
			events: [
				{ type: "text_delta", text: "Hello" },
				{ type: "usage", input_tokens: 3, output_tokens: 2 },
				{ type: "done", reason: "stop" },
			],
		},
	},
	null,
	2,
)}\n`;

// 字面量联合类型只允许两种模式，TypeScript 编译时检查；不会在运行时自动验证外部值。
type ServerMode = "openai" | "stream";

// 在 JSON 信任边界判断值是不是非空、非数组对象；输入 unknown，返回布尔值并帮助 TS 收窄类型。
// 例如 {} 通过、[] 不通过；Record<string, unknown> 的字段仍须各自校验，不保证内容结构。
function isRecord(value: unknown): value is Record<string, unknown> {
	// typeof 排除原始值，null 需另排除（typeof null 也是 object），Array.isArray 排除数组。
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 给已知 HTTP 响应写状态与纯文本错误并结束；输入响应对象、状态码、消息，无返回值。
// 例如无效密钥返回 401；写响应的异常向调用方传播，不负责销毁服务器。
function rejectRequest(response: ServerResponse, status: number, message: string): void {
	// 发送状态和响应类型；对象中的连字符属性名须用引号。
	response.writeHead(status, { "content-type": "text/plain" });
	// 写最后一段文本并结束本次响应。
	response.end(message);
}

// 异步读完请求体后解析 JSON；输入可异步迭代的 IncomingMessage，返回 Promise<unknown>。
// 会读取网络流，解析或读取错误向外抛；例如正文 {"a":1} 解析成对象，类型并未因此自动可信。
async function readJson(request: IncomingMessage): Promise<unknown> {
	// let 保存之后要追加的字符串；没有设置请求体大小上限。
	let body = "";
	// for await 依次等待流块，把每块转字符串后拼接；不是逐条 JSON 流解析。
	for await (const chunk of request) body += chunk.toString();
	// JSON.parse 可能抛 SyntaxError；本函数把结果以 unknown 暴露给后续校验。
	return JSON.parse(body);
}

// 工厂返回的操作接口；方法签名只约束 TS 调用者，Promise<void> 表示等待操作结束但无业务返回值。
export type AcmeServer = {
	start(): Promise<void>;
	stop(): Promise<void>;
	reset(): void;
	origin(): string;
	baseUrl(): string;
	validRequestReceived(): boolean;
};

// 创建两种模式之一的假服务控制器；输入模式，返回 start/stop 等方法，创建时尚未监听端口。
// 每个实例闭包保存服务器、地址和探测标记；例如 start 后 baseUrl 可供 OpenAI 兼容客户端调用。
// 请求处理先校验路径、方法、JSON 和凭证，再发固定分片；start/stop 的监听错误通过 Promise 拒绝。
export function createAcmeServer(mode: ServerMode): AcmeServer {
	// Server | undefined 表示尚未启动或已经停止；不使用非空断言假定一直存在。
	let server: Server | undefined;
	// 监听成功后才填入 http://127.0.0.1:随机端口，初始是空字符串。
	let serverOrigin = "";
	// 标记最近一次通过业务校验的请求是否恰为探测提示词；不是累计计数。
	let receivedValidRequest = false;

	// 处理一次请求，无业务返回值；参数来自 Node HTTP 回调，副作用是写响应及更新探测标记。
	// 例如路径错误立即 404；readJson 的错误转 400，其他未捕获异常仍可能使这个 Promise 拒绝。
	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		// 三元表达式按实例模式选择唯一合法路径；不接受查询串等其他 URL。
		const expectedPath = mode === "openai" ? "/v1/chat/completions" : "/generate";
		// 提前 return 在发送错误后终止该处理函数；rejectRequest 返回 void。
		if (request.url !== expectedPath) return rejectRequest(response, 404, "Unknown endpoint");
		// 只允许 POST，其他方法在读取请求体之前结束。
		if (request.method !== "POST") return rejectRequest(response, 405, "Expected POST");
		// 可选链处理头缺失；这里只检查 application/json 前缀，因此带 charset 的值也可通过。
		if (!request.headers["content-type"]?.startsWith("application/json")) {
			// 头类型不符返回 415，不继续解析正文。
			return rejectRequest(response, 415, "Expected application/json");
		}
		// unknown 强制后续先进行运行时校验，不能直接信任 JSON 的字段。
		let payload: unknown;
		// 只把读取/解析 JSON 这一段放进 try，catch 不会包住下面全部业务处理。
		try {
			// 等待整个请求体解析；await 失败进入紧接着的 catch。
			payload = await readJson(request);
		// 省略错误变量，因为响应只需要固定的解析失败说明。
		} catch {
			// 解析失败返回 400 并退出，不泄露解析器内部错误。
			return rejectRequest(response, 400, "Invalid JSON");
		}
		// 请求 JSON 的外部输入边界：原始值、null 和数组不能当请求对象。
		if (!isRecord(payload)) return rejectRequest(response, 422, "Expected a JSON object");
		// messages 不是数组就按空数组处理，随后找不到 user 消息会导致业务校验失败。
		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		// find 只取第一条匹配的 user 消息，不检查所有历史消息是否有效。
		const userMessage = messages.find(
			// 回调的 message is ... 是类型谓词；运行时同时检查对象形状与 role 字段。
			(message): message is Record<string, unknown> => isRecord(message) && message.role === "user",
		);
		// content 必须是字符串；没有该字段或传内容块数组都变为 undefined。
		const prompt = typeof userMessage?.content === "string" ? userMessage.content : undefined;

		// 自定义流协议走此分支，成功后 return，避免再执行 OpenAI 分支。
		if (mode === "stream") {
			// 在本地假协议的认证边界精确比较固定测试密钥，不进行真实账号认证。
			if (request.headers["x-acme-key"] !== "resolved-stream-key") {
				// 密钥不匹配时返回 401；不会更新探测标记。
				return rejectRequest(response, 401, "Invalid Acme Stream credential");
			}
			// 模型必须匹配、提示词必须存在、stream 必须严格为 true；其余请求字段未在这里完整验证。
			if (payload.model !== STREAM_MODEL_ID || prompt === undefined || payload.stream !== true) {
				// 业务字段不符返回 422，与 JSON 语法错误的 400 区分。
				return rejectRequest(response, 422, "Invalid Acme Stream request");
			}
			// 成功请求会覆盖标记：普通 hello 请求可成功，但该标记为 false。
			receivedValidRequest = prompt === STREAM_PROBE_PROMPT;
			// 声明逐行 JSON 响应；write 多次不保证在网络上对应同样数量的接收块。
			// SSE 用 text/event-stream，no-cache 仅为响应头，不实现持久连接重试。
			response.writeHead(200, { "content-type": "application/x-ndjson" });
			// 第一条文本事件写入 ACME_，末尾换行分隔 JSON 记录。
			response.write(`${JSON.stringify({ type: "text_delta", text: "ACME_" })}\n`);
			// 第二条文本事件补齐 STREAM_OK，客户端须自己合并 text_delta。
			response.write(`${JSON.stringify({ type: "text_delta", text: "STREAM_OK" })}\n`);
			// 再写固定输入/输出用量；这不是服务端实际计算 token。
			response.write(`${JSON.stringify({ type: "usage", input_tokens: 4, output_tokens: 3 })}\n`);
			// 最后写 done 事件并结束响应，reason 为 stop。
			response.end(`${JSON.stringify({ type: "done", reason: "stop" })}\n`);
			// 自定义协议已经完成，不落入下面兼容协议。
			return;
		}

		// OpenAI 兼容模式用 Authorization: Bearer 的固定夹具密钥。
		if (request.headers.authorization !== "Bearer resolved-acme-key") {
			// 错误密钥提前结束，保留原探测标记。
			return rejectRequest(response, 401, "Invalid Acme credential");
		}
		// 这一路同样要求准确模型名、字符串提示词及流开关。
		if (payload.model !== OPENAI_MODEL_ID || prompt === undefined || payload.stream !== true) {
			// 模型或输入/stream 不符合最小协议时返回 422。
			return rejectRequest(response, 422, "Invalid OpenAI-compatible request");
		}
		// 只有完全相同探测文本才标 true；不要求普通成功请求必须用探测文本。
		receivedValidRequest = prompt === OPENAI_PROBE_PROMPT;
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		// 写第一条 SSE data 记录：JSON 对象带 assistant 角色、固定答案，finish_reason 仍为 null。
		// 下方对象和模板字符串是实际协议载荷，双换行是事件分隔。
		response.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-acme",
				object: "chat.completion.chunk",
				created: 0,
				model: OPENAI_MODEL_ID,
				choices: [{ index: 0, delta: { role: "assistant", content: OPENAI_PROBE_RESPONSE }, finish_reason: null }],
			})}\n\n`,
		);
		// 第二条事件不再补文本，finish_reason=stop 并附固定 usage，供客户端汇总结果。
		response.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-acme",
				object: "chat.completion.chunk",
				created: 0,
				model: OPENAI_MODEL_ID,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 3, completion_tokens: 2 },
			})}\n\n`,
		);
		// SSE 结束哨兵不是 JSON；客户端必须单独识别 [DONE]。
		response.end("data: [DONE]\n\n");
	}

	// 返回闭包方法，共享本次工厂调用的状态；下面的方法调用才触发监听和清理。
	return {
		// 启动环回地址的临时端口，成功后记录 origin；无参数、返回 Promise<void>。
		// 例如 await server.start() 后再取 URL；未防止重复 start，调用者负责生命周期。
		async start() {
			// Node 不等待 async 请求回调，因此用 void 显式丢弃 handle 的 Promise；这不会捕获其拒绝。
			server = createServer((request, response) => void handle(request, response));
			// 用 Promise 把事件式监听完成转换成可 await 的结果。
			await new Promise<void>((resolve, reject) => {
				// 监听一次 error 后 reject；可选链在 server 缺失时不会执行。
				server?.once("error", reject);
				// 端口 0 交由系统分配，只绑定 127.0.0.1；resolve 接收监听成功通知。
				server?.listen(0, "127.0.0.1", resolve);
			});
			// 读取真正监听的地址；Node 的返回类型也可能是字符串或 null。
			const address = server.address();
			// Node 地址 API 的运行时分支：必须得到带 port 的 TCP 地址对象，否则抛错。
			if (!address || typeof address === "string") throw new Error("Acme fixture server did not bind a TCP port.");
			// 把实际端口拼成后续客户端使用的 origin。
			serverOrigin = `http://127.0.0.1:${address.port}`;
		},
		// 关闭当前服务器，无参数、返回 Promise<void>；未启动时直接完成，close 错误向外拒绝。
		// 例如 afterAll 中 await stop()，成功后清除 server 引用但保留上次 origin 文本。
		async stop() {
			// 没有服务器时无需调用 close。
			if (!server) return;
			// close 的错误优先 reject，否则 resolve；等待活动连接结束的语义来自 Node。
			await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
			// 只在 close 成功之后清空引用，失败会跳过这一步。
			server = undefined;
		},
		// 把探测布尔标记恢复 false，无参数或返回值，不重启服务或清除地址；例如 beforeEach 隔离用例。
		reset() {
			// 修改本实例闭包状态，不影响其他 createAcmeServer 实例。
			receivedValidRequest = false;
		},
		// 三个箭头 getter 无副作用：分别返回 origin、附 /v1 的 base URL、当前探测标记。
		// 例如 openai 客户端再在 baseUrl 后加 /chat/completions；启动前地址仍为空。
		origin: () => serverOrigin,
		baseUrl: () => `${serverOrigin}/v1`,
		validRequestReceived: () => receivedValidRequest,
	};
}
