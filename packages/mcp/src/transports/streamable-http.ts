// 实现MCP Streamable HTTP传输：POST发送消息，接JSON或SSE结果；初始化后可开GET接服务器消息，流中断时按事件ID/重试规则恢复，关闭时尽力DELETE会话。McpClient负责业务请求Promise，本文件负责HTTP与流。
// 认证提供者/注入fetch只作为类型导入，不在这里选择凭证存储或开浏览器；实际token/恢复调用在authorizedFetch中，可能有网络副作用。
import type { AuthProvider, McpFetch } from "../auth-provider.ts";
// 导入局部消息识别、协议异常与错误规范化；它们不代替方法参数/结果的完整schema检查。
import {
	// 判断发出的消息是否为带id请求，以决定是否必须读响应正文。
	isJsonRpcRequest,
	// 识别流内响应，用id判断某次请求是否已收到答复。
	isJsonRpcResponse,
	// 无法恢复某请求的响应流时，用内部错误码构造该请求的error响应。
	JSON_RPC_ERROR_CODES,
	// 复用字符串/数字编号类型，实际匹配采用===而不转字符串。
	type JsonRpcId,
	// 单条JSON-RPC消息的TS联合类型。
	type JsonRpcMessage,
	// 调用方已结束等待时，阻止认证恢复后的迟到派发所用异常。
	McpAbortError,
	// 传输尚未start或已经close的异常。
	McpConnectionClosedError,
	// 检查JSON.parse后的单条消息骨架，不解析原文本，也不验证业务schema。
	parseJsonRpcMessage,
	// 把异常值规范为Error读取说明，自定义String转换仍可能抛错。
	toError,
} from "../protocol/jsonrpc.ts";
// 复用公共传输常量、接口与事件底座。
import {
	// 默认SSE数据/未完成行上限16MiB；不自动限制普通JSON响应正文。
	DEFAULT_MAX_MESSAGE_BYTES,
	// 传输方法及事件订阅的TS契约。
	type McpTransport,
	// send可选signal的类型，实际只在派发前读取，不用作每次fetch的独立取消信号。
	type McpTransportSendOptions,
	// 同步事件分发基类，监听器可抛错且多数分发没有隔离catch。
	TransportEvents,
} from "./transport.ts";

// 名字带BYTES，但实际用于字符串.slice，截的是8192个UTF-16码元；checkResponse先读完正文才截取，不能把它当网络/内存字节上限。
const MAX_ERROR_BODY_BYTES = 8 * 1024;
// HTTP错误message中的正文预览最多500个UTF-16码元，含需要时的三个省略点；不包含外面的状态说明前缀。
const ERROR_MESSAGE_BODY_CHARS = 500;
// 无服务器retry提示时，指数退避的初始间隔默认1000ms。
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 1_000;
// 本地指数退避最大间隔默认30000ms；服务器指定的retry会绕过这个上限。
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
// 流恢复计数默认上限5；具体检查/重置顺序在两个循环里，不是整个客户端一生只能重试5次。
const DEFAULT_RECONNECT_MAX_RETRIES = 5;

// 一份解析后的SSE事件形状，不是JSON-RPC消息；data还需要上层JSON.parse及骨架校验。
export interface SseEvent {
	// 可选事件名称；当前dispatch仅在名称真值时加字段，空名称会省略。
	event?: string;
	// 多条data字段用LF连接的文字，可能为空；不保证有效JSON。
	data: string;
	// 本事件遇到的可选ID；onId另可接到空串ID，dispatch在ID空串时不会放进此字段。
	id?: string;
}

// 通用SSE字节流解析选项，只控制解析和回调，不包含URL、凭证或自动重连。
export interface ConsumeSseOptions {
	// 数据字段累积/未完成行的可选字节上限，配置没有正整数运行时校验。
	maxEventBytes?: number;
	// 每次有data字段的事件分发时同步调用；void不表示await或捕获异步回调拒绝。
	onEvent(event: SseEvent): void;
	/** Called for every `id` field, including events without data (for example resumption priming events). */
	// 每个合法id字段出现时立即调用，即使尚无data/空行；空串也会传入，含NUL的值被忽略。
	onId?(id: string): void;
	/** Called for every valid `retry` field, in milliseconds. */
	// 全为数字字符的retry值转number后传入；没进一步检查转换后是否有限或适合Node计时器范围。
	onRetry?(delayMs: number): void;
}

// 读取Uint8Array流并解析SSE，输入流和回调选项，返回读取结束的Promise；按LF/CRLF拆行、空行分事件、EOF处理残尾，finally释放reader锁。例：分两块来的data字段会拼回完整事件。
// 这里只解析文本，不建立HTTP、不JSON.parse、不自动重连；读流/回调/超限可拒绝。错误时释放锁而不主动reader.cancel，构造reader/decoder在try之前，不由后面的finally覆盖。
export async function consumeSseStream(stream: ReadableStream<Uint8Array>, options: ConsumeSseOptions): Promise<void> {
	// 取得并锁住流的默认reader；流已锁等情况可抛错，没有在这里另取reader兜底。
	const reader = stream.getReader();
	// 默认UTF-8 TextDecoder支持跨chunk保留不完整字节，缺省非fatal解码可使用替代字符。
	const decoder = new TextDecoder();
	// 保存尚未拆出LF的文字；string.length与下面Buffer.byteLength的计量不同。
	let buffered = "";
	// 保存当前事件名，缺省undefined，每次dispatch后重置。
	let eventName: string | undefined;
	// 保存当前事件里的id，重置不等于清上层cursor.lastEventId，后者通过onId单独维护。
	let eventId: string | undefined;
	// 累计当前事件所有data字段，空data值也会作为一个空字符串元素进入数组。
	let dataLines: string[] = [];
	// Bytes of the pending event's data, including the "\n" joins, so events streamed as many
	// short `data:` lines without a terminating blank line cannot grow without bound.
	// 计数解码文字重新按UTF-8计算的data字节与连接LF，不包含每行data:前缀或其他SSE字段。
	let dataBytes = 0;
	// 配置缺省时用16MiB；0/负值不会被??换成默认，也没钳制异常数值。
	const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_MESSAGE_BYTES;

	// 把当前data数组发成一事件并重置局部状态，无参数/返回；例：两条data:"a"/"b"输出data含一行LF。没有data时只清事件名/id，不广播；onEvent同步抛错会打断重置并让外层解析拒绝。
	const dispatch = () => {
		// 没有data字段就不构造事件；单独id/retry仍已通过各自回调通知上层。
		if (dataLines.length === 0) {
			// 清掉没有正文事件的名称，不让它带到下一份事件。
			eventName = undefined;
			// 清掉局部事件ID；上层续传游标不依赖这个局部值持久化。
			eventId = undefined;
			// 本次分发到此结束，保持无事件输出。
			return;
		}
		// 用一个LF连接各data值，不额外追加末尾LF；即使只有空data也会得到空串事件。
		const data = dataLines.join("\n");
		// 回调得到新事件对象；event/id只在真值时展开，data总有。?.不用于onEvent，因此它是必需回调，当前实现也不await其返回值。
		options.onEvent({ ...(eventName ? { event: eventName } : {}), data, ...(eventId ? { id: eventId } : {}) });
		// 正常回调返回后重置事件名，准备后续事件。
		eventName = undefined;
		// 重置本事件ID而非上层续传ID。
		eventId = undefined;
		// 换成新空数组，已拼出的data字符串不会受后续追加影响。
		dataLines = [];
		// 当前事件数据计数归0，重新计算下一事件的data预算。
		dataBytes = 0;
	};

	// 处理一条已去LF的文字行，无返回值；输入rawLine，去单个尾CR、识别空行/注释/字段，更新闭包事件状态并调用相应回调。例："data: hello"保存hello，不包含data:前缀；回调或预算错误会向外传播。
	const processLine = (rawLine: string) => {
		// 只去末尾一个CR以兼容CRLF；没有LF的纯CR分隔不会由外层当多行拆开。
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		// 空行代表当前事件结束。
		if (line === "") {
			// 同步触发dispatch，有data才输出事件。
			dispatch();
			// 空行不继续按字段解析。
			return;
		}
		// 首字符是冒号的注释/心跳行忽略，不调用onEvent。
		if (line.startsWith(":")) return;
		// 找首个冒号，后续冒号属于值；无冒号得到-1。
		const colon = line.indexOf(":");
		// 有冒号则之前部分为字段名，无冒号整行作字段名；匹配大小写敏感。
		const field = colon < 0 ? line : line.slice(0, colon);
		// 有冒号取之后的值，否则空串；let因为下一步可能移除一个空格。
		let value = colon < 0 ? "" : line.slice(colon + 1);
		// 仅移除值开头一个普通空格，不trim全部空白或制表符。
		if (value.startsWith(" ")) value = value.slice(1);
		// data字段进入累积正文路径。
		if (field === "data") {
			// 按UTF-8字节计正文值，再为与已有data的LF连接加1；不是按value.length码元计算，也不是原始网络总字节数。
			dataBytes += Buffer.byteLength(value) + (dataLines.length > 0 ? 1 : 0);
			// 累计严格超限就抛Error，未把超限data追加成完整事件。
			if (dataBytes > maxEventBytes) throw new Error(`MCP SSE event exceeds ${maxEventBytes} bytes`);
			// 保存这一条正文值，下一data字段继续累积。
			dataLines.push(value);
			// event字段覆盖当前事件名；这一行本身不触发事件分发。
		} else if (field === "event") eventName = value;
		// id不能含NUL，其余文字包括空字符串允许；没有在这里要求数字或非空。
		else if (field === "id" && !value.includes("\0")) {
			// 保存当前事件ID供dispatch可选展示。
			eventId = value;
			// 可选onId立即收到原值，所以只有id没有data的消息也能给外层准备续传位置。
			options.onId?.(value);
			// retry须整串为至少一个ASCII数字才接受，Number转成毫秒数交回调；很长数字可变Infinity，这里没加范围校验，未知字段则自然忽略。
		} else if (field === "retry" && /^\d+$/.test(value)) options.onRetry?.(Number(value));
	};

	// 保护读取循环及EOF处理，确保正常完成/循环内抛错后都释放reader锁。
	try {
		// 持续读直到done，或读流/回调/预算错误使Promise拒绝。
		while (true) {
			// await读取一块并解构done/value；不会并行预取多个reader.read。
			const { done, value } = await reader.read();
			// 流结束就跳出，不把结束返回值作为正文处理。
			if (done) break;
			// stream:true跨chunk延迟处理不完整UTF-8字符，先把整块解码追加后再做行预算检查，因此瞬时分配仍可超预算。
			buffered += decoder.decode(value, { stream: true });
			// 按字符串中的LF找完整行；这是已解码后的码元位置。
			let newline = buffered.indexOf("\n");
			// 循环消化本chunk提供的全部完整行。
			while (newline >= 0) {
				// 切出不含LF的行交内部解析器；其中仍可带尾CR。
				processLine(buffered.slice(0, newline));
				// 丢掉这行与LF，保留未完成尾部。
				buffered = buffered.slice(newline + 1);
				// 重新找剩余文本的下一LF，以便继续当前while。
				newline = buffered.indexOf("\n");
			}
			// 完整行处理后，再限制未完成尾行的UTF-8字节数，防没有换行的一行无限累积。
			if (Buffer.byteLength(buffered) > maxEventBytes)
				// 尾部超限就抛，不等待服务端最终补LF，也不输出被截断的事件。
				throw new Error(`MCP SSE event exceeds ${maxEventBytes} bytes`);
		}
		// EOF时flush decoder内部残留，缺省可为不完整序列产生替代字符；此处没有再单独对这段flush尾部执行外层尾行预算检查。
		buffered += decoder.decode();
		// 还有非空文字就作为最后一行处理，即使网络末尾没有LF。
		if (buffered) processLine(buffered);
		// EOF也尝试分发已累计data，不要求最后一定出现空行；没有data则不输出。
		dispatch();
		// 读取/回调异常同样进入finally，异常并未因此变成成功。
	} finally {
		// 只释放读锁，不主动cancel底层流；未等待的其他资源由上层传输/宿主负责。
		reader.releaseLock();
	}
}

// 可选流恢复参数；这里只声明number字段，没有在构造器验证正值/整数或设置总截止时间。
export interface StreamableHttpReconnectOptions {
	/** Delay before the first reconnection attempt, unless the server sent a `retry` field. Default: 1000. */
	// 本地退避初始毫秒数，缺省1000；server retry存在时优先用服务器值。
	initialDelayMs?: number;
	/** Upper bound for the exponential backoff. Default: 30000. */
	// 本地指数退避上限，缺省30000；不限制服务端retry提示。
	maxDelayMs?: number;
	/** Consecutive failed attempts before giving up on a stream. Default: 5. */
	// 循环内尝试计数上限，缺省5；收到/正常维持流时可按具体循环重置，实际计数顺序看consumeResponseStream/runGetStream。
	maxRetries?: number;
}

// HTTP传输的配置接口，不在这里自动做URL信任、认证流程或schema验证。
export interface StreamableHttpTransportOptions {
	// 服务器MCP入口，构造器用new URL转为对象；无效地址会在构造时抛错。
	url: string | URL;
	// 附加请求头，构造器复制表；后面额外协议头/token可覆盖同名项。
	headers?: Record<string, string>;
	// 可注入兼容请求函数，缺省globalThis.fetch；便于宿主路由或内存模拟，不会因声明这个字段自行发请求。
	fetch?: McpFetch;
	/** Open the server-to-client GET stream after initialization. Default: true. */
	// 只有严格false才禁用初始化后的GET服务器消息流；禁用不影响POST结果中的SSE响应流。
	openGetStream?: boolean;
	// SSE解析使用的上限；JSON响应仍走response.json完整读取，不在此施加同一预算。
	maxMessageBytes?: number;
	// 可选认证提供者，HTTP请求构造头时await token，指定挑战后最多恢复一次；关闭DELETE不再次取令牌。
	authProvider?: AuthProvider;
	/** Reconnection of dropped SSE streams (the GET stream, and response streams that carry event IDs). */
	// GET流和有事件ID的请求响应流的恢复参数，不是自动重放所有tools/call或重做initialize的策略。
	reconnect?: StreamableHttpReconnectOptions;
}

// 保存HTTP失败状态与正文摘录的异常，不会在构造时发送请求或自动重试。
export class McpHttpError extends Error {
	// readonly在TS层限制赋值，运行时不是不可写属性的保证。
	readonly status: number;
	// 正文摘录字符串，可能有服务端敏感文字，本类不脱敏。
	readonly body: string;

	// 输入status/message与可选body并构造Error实例；例：new McpHttpError(500,"failed","detail")。仅保存数据，不验证状态码范围或抛出自己。
	constructor(status: number, message: string, body = "") {
		// 初始化Error.message，派生类访问this前先调用super。
		super(message);
		// 设置日志展示名称。
		this.name = "McpHttpError";
		// 保留输入HTTP状态数字，不转换为协议错误码。
		this.status = status;
		// 保存正文文字，缺省为空字符串。
		this.body = body;
	}
}

// 认证失败专用HTTP异常，checkResponse在最终401时创建；403若恢复后仍失败会落通用McpHttpError，不都变成本类。
export class McpAuthRequiredError extends McpHttpError {
	// 保存WWW-Authenticate挑战头或null，字段声明不解析OAuth信息。
	readonly wwwAuthenticate: string | null;

	// 输入失败Response及正文摘录，构造固定401异常；例：缺挑战头时wwwAuthenticate=null。只读取头，不消费正文或启动登录。
	constructor(response: Response, body = "") {
		// 调用父类保存固定401/说明/body，未直接使用response.status作本类状态。
		super(401, "MCP server requires authentication", body);
		// 改为专用错误名，便于上层按instanceof或name识别。
		this.name = "McpAuthRequiredError";
		// 从原Response读取挑战原文，缺省null，不在此执行认证发现。
		this.wwwAuthenticate = response.headers.get("www-authenticate");
	}
}

// 已知有会话时收到404所用异常，便于上层重建会话；这个类本身不会重新initialize。
export class McpSessionExpiredError extends McpHttpError {
	// 输入可选正文，构造固定404异常；例：new McpSessionExpiredError("gone")。不清传输缓存、不发请求、不保证任意404都表示会话过期，由调用处决定何时使用。
	constructor(body = "") {
		// 固定状态和错误说明交父类保存。
		super(404, "MCP session expired", body);
		// 设置专用错误名。
		this.name = "McpSessionExpiredError";
	}
}

// 取得归一化响应媒体类型，输入Response，返回小写类型或undefined；例："Application/JSON; charset=utf-8"变application/json。不读正文，缺头不抛专用错误。
function contentType(response: Response): string | undefined {
	// ?.跳过缺省头；split最多取首段，再trim/toLowerCase，不做完整MIME语法解析。
	return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

/** 401, or 403 with an `insufficient_scope` bearer challenge (step-up authorization). */
// 按本地规则判断是否尝试认证恢复，输入Response，返回boolean；例：401总为true，403需头含相应error片段。不读取正文、不验证挑战一定属于标准Bearer格式。
function needsAuthorization(response: Response): boolean {
	// 401立即允许恢复，不要求一定有WWW-Authenticate头。
	if (response.status === 401) return true;
	// 除403外的其他状态都false，普通500不会在这里触发认证恢复。
	if (response.status !== 403) return false;
	// 忽略大小写匹配头里的error=insufficient_scope片段，允许部分引号写法；这是正则片段识别，不是完整认证挑战解析或scope授权保证。
	return /(?:^|[\s,])error="?insufficient_scope"?/i.test(response.headers.get("www-authenticate") ?? "");
}

/** Statuses worth retrying when a stream fails to (re)open. */
// 判断流恢复是否值得再试，输入status，返回boolean；408/429以及任何≥500值为true。只作分类，不sleep或重发原工具；例如404为false。
function isTransientStatus(status: number): boolean {
	// ||依次比较两个特例和下界，没有显式≤599上界或整数校验。
	return status === 408 || status === 429 || status >= 500;
}

// 尽力取消响应正文，输入Response，返回Promise<void>；例：通知的HTTP确认正文不需要解析就丢弃。无body立即兑现，cancel拒绝被吞，不保证服务端任务已取消。
function discard(response: Response): Promise<void> {
	// ?.在无body时得到undefined，再?? Promise.resolve；有body则取消并catch忽略拒绝，不按JSON读取内容。
	return response.body?.cancel().catch(() => {}) ?? Promise.resolve();
}

// 生成带状态码的HTTP错误说明，输入status/body，返回字符串；例：500加" detail "得到带detail的说明。只处理文字、不修改响应，预览按UTF-16码元而非字节截取。
function describeHttpFailure(status: number, body: string): string {
	// 先去掉正文两端空白，内部空白保持。
	const text = body.trim();
	// 超过500码元时保留前497再加三个点；恰好500不加点，可能切断代理项对，不保证用户可见字形完整。
	const snippet = text.length > ERROR_MESSAGE_BODY_CHARS ? `${text.slice(0, ERROR_MESSAGE_BODY_CHARS - 3)}...` : text;
	// 有真值预览才追加冒号与内容；完整message长度还包括状态码前缀，不限于500码元。
	return `MCP HTTP request failed with status ${status}${snippet ? `: ${snippet}` : ""}`;
}

// 一条SSE消费/恢复任务的游标状态，GET后台流与每个请求响应流各建一份，不混用它们的最后事件ID。
interface StreamCursor {
	// 最近onId值，可含空串；undefined表示尚无ID，续传请求按它决定是否带Last-Event-ID。
	lastEventId: string | undefined;
	// 最近onRetry毫秒数，可能绕过本地退避上限；字段不在每次重连后清空。
	retryMs: number | undefined;
	/** Whether the stream delivered any event since it was (re)opened. */
	// onEvent曾被调用即true，空data事件或被上层忽略的其他事件名也可计为收到；只有id没有data不调用onEvent，因而不单凭id置true。
	received: boolean;
}

// 继承事件分发并实现McpTransport；构造/start本身不发initialize，McpClient发请求后才真正POST，SSE恢复也不等于新建MCP会话。
export class StreamableHttpTransport extends TransportEvents implements McpTransport {
	// 解析后的URL对象，readonly只限制该属性重新赋值，不冻结URL内部可变属性。
	readonly url: URL;
	// 公开配置的浅只读视图，构造器也只冻结外层副本，headers副本/认证提供者等未深冻结。
	readonly options: Readonly<StreamableHttpTransportOptions>;
	// 实际请求函数包装器，保持调用原fetch时没有错误的this接收者。
	private fetch: McpFetch;
	// 整个传输共享的取消控制器，close用它取消使用该signal的fetch/重试等待；单次请求signal不替代它。
	private controller = new AbortController();
	// 是否已start，初始false，设true后不复位供重复启动。
	private started = false;
	// 是否主动closed，关闭后send拒绝；不因每次HTTP失败自动变true。
	private closed = false;
	// 最近真值Mcp-Session-Id响应头，缺头时不清旧值；关闭也不清，所以getter不表示当前会话仍有效。
	private sessionIdValue: string | undefined;
	// McpClient协商后设置的版本，用于后续协议请求头。
	private protocolVersion: string | undefined;
	// 初始化后GET后台流只尝试启动一次的标记；恢复耗尽后也不重置供再次startGetStream。
	private getStreamStarted = false;
	/** Access token of the latest request, which `close()` reuses instead of asking the auth provider. */
	// 最近headers()取得的token缓存，关闭复用；保存发生在派发/成功响应之前，因此不是“最近成功请求”的保证。
	private lastToken: string | undefined;

	// 构造HTTP传输：初始化事件底座、浅复制配置/headers、解析URL并包装fetch，返回实例；例：new StreamableHttpTransport({url:"https://example.test/mcp"})不会立即联网。URL/配置getter等异常可直接抛。
	constructor(options: StreamableHttpTransportOptions) {
		// 先调用基类，初始化事件Set与关闭去重标记。
		super();
		// 外层freeze不深冻结headers新副本或authProvider/reconnect引用；仅headers真值时复制。
		this.options = Object.freeze({ ...options, headers: options.headers ? { ...options.headers } : undefined });
		// new URL接收字符串/URL并创建新对象，无效地址抛错；不在此限制网络协议或目标主机。
		this.url = new URL(options.url);
		// 捕获显式fetch或全局fetch，之后全局被替换也不会自动换掉此捕获引用。
		const fetch = options.fetch ?? globalThis.fetch;
		// Call fetch without a receiver. `this.fetch(...)` and `context.fetch(...)` would pass the transport or
		// the auth context as `this`, which Cloudflare Workers reject for the platform fetch ("Illegal invocation").
		// 箭头转发时用局部变量fetch(input,init)，避免作为对象方法调用把this传给平台fetch；不自动给认证fetch加额外授权头。
		this.fetch = (input, init) => fetch(input, init);
	}

	// 取缓存sessionId，无参数/副作用，返回字符串或undefined；例：首次成功HTTP头写入后可读取。关闭后仍保旧值，不主动探测服务器是否保留会话。
	get sessionId(): string | undefined {
		// 直接返回字段，不作网络读取或清除。
		return this.sessionIdValue;
	}

	// 标记传输已启动，无参数，返回Promise<void>；例：await transport.start()后仍未做HTTP握手。重复启动或已关闭会拒绝，不支持同实例重新开始。
	async start(): Promise<void> {
		// 先查重复start，再查closed；如果两者都true优先报already started。
		if (this.started) throw new Error("MCP Streamable HTTP transport already started");
		// 已close但尚未start也不能复用。
		if (this.closed) throw new McpConnectionClosedError();
		// 只设置标记，没有socket连接或远端initialize动作。
		this.started = true;
	}

	// 记下协商协议版本，输入string，无返回值；例：McpClient传"2025-11-25"供后续HTTP头。只存字段，不验证是否在支持清单，也不发送请求。
	setProtocolVersion(version: string): void {
		// 原样保存版本字符串，供buildHeaders按真值添加后续请求头；这行本身不发送网络请求。
		this.protocolVersion = version;
	}

	// 通过POST发一条消息，输入JSON-RPC消息及可选派发signal，返回Promise<void>：构造JSON、认证fetch、查状态/保存会话，再按通知/JSON/SSE分支处理。例：tools/list的JSON结果会广播给McpClient匹配pending。
	// 发送/解码/回调失败可拒绝；SSE分支后台消费后立即返回，不等工具完成。signal只在认证之后、派发之前检查，不单独中止已开始的fetch或SSE，超时/取消的业务等待由McpClient负责。
	async send(message: JsonRpcMessage, { signal }: McpTransportSendOptions = {}): Promise<void> {
		// 尚未启动或已主动关闭则拒绝，不自动start/重连。
		if (!this.started || this.closed) throw new McpConnectionClosedError();
		// 调用带认证恢复的fetch，并等待HTTP Response对象，不一定等整个正文读完。
		const response = await this.authorizedFetch(
			// 固定POST方法，所有请求/通知/客户端回复都走这个入口。
			"POST",
			// 构造传给authorizedFetch的头与正文数据。
			{
				// Accept允许JSON/SSE响应，Content-Type声明发出正文为JSON；后面buildHeaders仍会合并用户头。
				headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
				// 实际JSON编码消息，循环/BigInt等可在派发前抛错；没有发送体大小限额。
				body: JSON.stringify(message),
			},
			// 传入单次派发signal，独立于整个传输的controller.signal。
			signal,
		);
		// 检查最终HTTP状态，不ok时读正文并抛分类错误；这里不是检查JSON-RPC error业务结果。
		await this.checkResponse(response);
		// 状态通过后记录本响应真值会话头，后续请求使用；失败状态不走此行。
		this.captureSession(response);

		// 发出的消息不是本地请求骨架时，当通知/响应确认处理；骨架判断不等于完整协议校验。
		if (!isJsonRpcRequest(message)) {
			// Notifications and responses are acknowledged with 202 and carry no reply; ignore any body.
			// 丢弃正文，不核实状态一定是202，也不尝试将正文误当另一次JSON-RPC结果。
			await discard(response);
			// The server-to-client stream may only open once the session is initialized.
			// 只有发出initialized通知后才考虑启动GET流，且startGetStream还检查选项/关闭状态；它不等待GET流建立完成。
			if ("method" in message && message.method === "notifications/initialized") this.startGetStream();
			// 本次通知/回复的POST发送处理结束，不登记McpClient pending。
			return;
		}
		// 带id请求却收到202/204没有业务答复，则视为错误，不能无限等没有正文的结果。
		if (response.status === 202 || response.status === 204) {
			// 抛带对应HTTP状态的错误，消息说明被接受但无响应；不在此重放工具。
			throw new McpHttpError(response.status, `MCP server accepted request ${message.method} without a response`);
		}
		// 取标准化响应媒体类型，忽略charset等参数。
		const type = contentType(response);
		// JSON类型走完整JSON正文解析路径。
		if (type === "application/json") {
			// response.json读取并解码整个正文为unknown，不套SSE字节上限，异常会让send拒绝。
			const body: unknown = await response.json();
			// 若正文是数组就逐项骨架检查/广播，否则只处理一项；这层有局部批量拆分，但不能推广为所有MCP入口都完整支持JSON-RPC batch。坏项/监听器抛错会阻止后续项，本行不核对id一定匹配原请求。
			for (const item of Array.isArray(body) ? body : [body]) this.emitMessage(parseJsonRpcMessage(item));
			// JSON处理完结束send，原请求结果由广播后的McpClient结算。
			return;
		}
		// 声明为SSE且body存在时启动后台响应流消费。
		if (type === "text/event-stream" && response.body) {
			// void忽略consumeResponseStream返回Promise，不等流结束；大部分流错误会转该请求的error消息，但void本身不会捕获剩余拒绝。
			void this.consumeResponseStream(response.body, message.id);
			// send至此即可兑现，客户端pending仍可继续等待流里结果。
			return;
		}
		// 其他类型/缺流正文先尽力取消body，不把它当默认JSON。
		await discard(response);
		// 抛不支持媒体类型的HTTP异常；??仅缺类型时用missing，空字符串类型仍保留。
		throw new McpHttpError(response.status, `Unsupported MCP response content type: ${type ?? "missing"}`);
	}

	// 关闭传输，输入无参数，返回Promise<void>：先closed/abort共享信号，再有会话时尽力DELETE，最后发关闭事件。例：close复用已取到的lastToken，不等待新的认证刷新。
	// 第二次close立即返回，不共享首次关闭Promise；不等待所有后台SSE/认证Promise结束，不清sessionId缓存。DELETE异常被吞，关闭监听器异常仍可使close拒绝。
	async close(): Promise<void> {
		// 已关闭便直接返回，避免重复DELETE和关闭广播，也不等待首轮DELETE。
		if (this.closed) return;
		// 先禁止新send，后续清理未必已经完成。
		this.closed = true;
		// 取消共享fetch及sleep信号；认证提供者的独立刷新不一定绑定它，不能保证所有异步活动都立刻停。
		this.controller.abort();
		// 只有start过且已有真值sessionId才尝试DELETE，缺会话直接跳到emitClose。
		if (this.started && this.sessionIdValue) {
			// Best effort: the session expires on the server anyway. The auth provider may refresh tokens
			// over the network, so it is not asked here and closing never waits for a refresh.
			// DELETE阶段try做尽力清理，不让请求/头构造/取消body错误阻止后面关闭事件。
			try {
				// 直接用fetch而不是authorizedFetch，避免再调用token或执行挑战恢复。
				const response = await this.fetch(this.url, {
					// 用DELETE请求结束远端会话，不在这里核验Response.ok或要求服务器真的清掉会话。
					method: "DELETE",
					// buildHeaders仍合并用户/会话/版本头，但令牌只用缓存lastToken。
					headers: this.buildHeaders({}, this.lastToken),
					// 给这次DELETE单独约1000ms取消信号；依赖fetch实现遵守signal，不能保证忽略signal的注入函数在1秒内完成。
					signal: AbortSignal.timeout(1_000),
				});
				// 返回Response后尽力取消其正文，不做JSON解析。
				await discard(response);
				// DELETE的失败被忽略，不重新抛到McpClient或重试。
			} catch {}
		}
		// 完成尽力DELETE后才发关闭事件，基类至多开始广播一次；监听器自己抛错仍可能逸出。
		this.emitClose();
	}

	/**
	 * Fetch with auth headers. A 401 (or a 403 asking for more scope) is handed to the auth provider
	 * once, and the request is retried with whatever credentials it left behind.
	 *
	 * `signal` only stops dispatch: getting a token or the authorization recovery can take a while, and a
	 * request its sender gave up on in the meantime must not reach the server. It does not abort the shared
	 * recovery, which other requests may wait for.
	 */
	// 发GET/POST并处理最多一次认证恢复，输入方法、头/可选正文、可选派发signal，返回最终Response。例：401先onUnauthorized更新凭证，再重新取token重发一次。
	// 不做普通500/网络失败通用重试，不检查Response.ok；恢复/取token/fetch可拒绝。单次signal只阻止等待认证后的迟到派发，不用于取消共享认证或已开始fetch，后者绑定传输controller。
	private async authorizedFetch(
		// 字面量联合只允许GET或POST，此函数不负责关闭的DELETE。
		method: "GET" | "POST",
		// 头是字符串映射，body可省略；不在这里自动JSON.stringify输入对象。
		init: { headers: Record<string, string>; body?: string },
		// 请求发送者的可选signal，缺省GET后台恢复没有这个单次信号。
		signal?: AbortSignal,
		// Promise返回Response对象而非已解析JSON-RPC结果。
	): Promise<Response> {
		// 可选方法存在则bind到提供者保留this；没有恢复方法时不自行构造OAuth流程。
		const onUnauthorized = this.options.authProvider?.onUnauthorized?.bind(this.options.authProvider);
		// attempt从0起，下面条件使正常流程最多发原始一次加恢复后一次；不是无限认证重试。
		for (let attempt = 0; ; attempt++) {
			// 每轮先await token并构造头，可能等待磁盘/网络或共享刷新；尚未检查单次signal，所以已取消也可能先读凭证。
			const { headers, token } = await this.headers(init.headers);
			// 取完头再查发送者是否已结束等待，取消则拒绝并避免这一轮fetch；不抹掉前面headers写入的lastToken。
			if (signal?.aborted) throw new McpAbortError();
			// 实际发HTTP，调用方超时并不把这里signal换成它自己的signal。
			const response = await this.fetch(this.url, {
				// 传固定方法字符串。
				method,
				// 传已合并的Headers对象，包括可能的Bearer凭证。
				headers,
				// 正文原字符串，GET通常undefined，不在此重编码。
				body: init.body,
				// 整传输共享signal用于主动close；单次请求取消不直接abort此fetch。
				signal: this.controller.signal,
			});
			// 第二轮不再恢复；没处理器或非指定挑战也直接返回Response，让调用方checkResponse处理错误。
			if (attempt > 0 || !onUnauthorized || !needsAuthorization(response)) return response;
			// 仅首轮指定挑战才进入提供者恢复，finally负责丢弃本轮失败响应正文。
			try {
				// 把原Response/服务器URL/请求函数/本轮令牌快照交提供者，await其完成；不保证它一定刷新成功或不要求用户登录。
				await onUnauthorized({ response, serverUrl: this.url, fetch: this.fetch, token });
				// 恢复成功或拒绝都进入finally，原错误通常继续传播。
			} finally {
				// 取消旧响应正文后，成功恢复才回循环重新headers/fetch；不重用失败Response充当成功。
				await discard(response);
			}
		}
	}

	// 取得提供者token并生成本轮请求头，输入可选额外头，返回{headers,token?}；例：真值token:"x"会生成Bearer x。可有凭证读取/刷新副作用，失败拒绝；缓存先于HTTP成功写入。
	private async headers(extra: Record<string, string> = {}): Promise<{ headers: Headers; token?: string }> {
		// 有提供者才调用token，缺省await undefined仍得到undefined，不在此跳过所有头合并。
		const token = await this.options.authProvider?.token();
		// 保存最近一次取值，包括undefined/空串；并非最近成功发出请求的凭证保证，并发headers可按各自完成次序覆盖。
		this.lastToken = token;
		// 总带Headers，真值token才加返回对象token字段；空串/undefined不携带字段，后面buildHeaders也不主动覆盖原用户Authorization。
		return { headers: this.buildHeaders(extra, token), ...(token ? { token } : {}) };
	}

	// 按优先级构造Headers，输入额外头与令牌，返回新对象，无网络；例：用户Accept可被本次extra覆盖，真值token最终覆盖用户Authorization。非法头值可使Headers构造/set抛错，不改原头表。
	private buildHeaders(extra: Record<string, string>, token: string | undefined): Headers {
		// 先以配置头建Headers，保留宿主Headers的名称归一化规则。
		const headers = new Headers(this.options.headers);
		// 再按自有可枚举额外键逐项set同名覆盖，通知/GET的Accept等在此生效。
		for (const [name, value] of Object.entries(extra)) headers.set(name, value);
		// 已有会话才设Mcp-Session-Id，覆盖用户同名值；缺省不会删除用户自己给的同名头。
		if (this.sessionIdValue) headers.set("Mcp-Session-Id", this.sessionIdValue);
		// 已记协议版本才设对应头；空字符串时不覆盖配置值。
		if (this.protocolVersion) headers.set("MCP-Protocol-Version", this.protocolVersion);
		// 真值token才设置Bearer；未取到token不表示最终请求头一定没有Authorization，因为配置头可能已包含它。
		if (token) headers.set("Authorization", `Bearer ${token}`);
		// 返回新Headers实例，不冻结供fetch使用。
		return headers;
	}

	// 从Response保存真值会话ID，无返回值；例：session-1替换旧缓存。缺头/空串保持旧值，不在这里验证会话有效性或负责清空。
	private captureSession(response: Response): void {
		// 读取响应头，缺省为null。
		const sessionId = response.headers.get("mcp-session-id");
		// 仅真值字符串才赋值，关闭或其他响应不自动撤销缓存。
		if (sessionId) this.sessionIdValue = sessionId;
	}

	// 检查HTTP状态，输入Response，成功返回Promise<void>，失败读正文后抛分类异常；例：已有会话的404变McpSessionExpiredError。只分类，不重连，不验证JSON-RPC业务error。
	private async checkResponse(response: Response): Promise<void> {
		// ok为真就直接返回，不需要先读取正文；它是HTTP 2xx范围判断。
		if (response.ok) return;
		// A copy, not a slice: V8 slices keep the whole body alive, and the error keeps this excerpt.
		// 先response.text完整读取，读取拒绝用空串；再截前8192个UTF-16码元，并用追加/去掉空格的写法试图避免大正文切片引用驻留。不是读到8KiB便停止网络，也不保证JS引擎内部存储策略。
		const body = `${(await response.text().catch(() => "")).slice(0, MAX_ERROR_BODY_BYTES)} `.slice(0, -1);
		// 最终401变认证专用异常，保存挑战头；这里不再主动执行认证恢复。
		if (response.status === 401) throw new McpAuthRequiredError(response, body);
		// 只有缓存会话存在的404才分类会话过期，否则走普通HTTP错误。
		if (response.status === 404 && this.sessionIdValue) throw new McpSessionExpiredError(body);
		// 其他状态带通用message预览及较长body摘录抛出；不脱敏服务端正文。
		throw new McpHttpError(response.status, describeHttpFailure(response.status, body), body);
	}

	// 把一段SSE流转换为协议消息并更新外部cursor，输入流/游标/可选消息观察器，返回消费结束Promise；例：onId先记位置，随后合法data消息广播。读流/预算/部分回调异常可拒绝，JSON坏事件通常报错误后忽略继续。
	private async consumeSse(
		// 字节流由HTTP Response.body提供，本方法不再发fetch。
		stream: ReadableStream<Uint8Array>,
		// 原游标对象会被回调直接修改，供外面的重连循环复用。
		cursor: StreamCursor,
		// 可选观察器先于广播调用，用于标记某个请求id已被回答，不替代所有消息监听器。
		onMessage?: (message: JsonRpcMessage) => void,
		// Promise在整段consumeSseStream完成后才结束，不是首条消息到达就结束。
	): Promise<void> {
		// 复用通用SSE解析器，传递下面计数及回调规则。
		await consumeSseStream(stream, {
			// 配置maxMessageBytes用于SSE事件/残行预算，缺省16MiB，不是所有HTTP正文总量上限。
			maxEventBytes: this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
			// 每个合法id字段回调，包括空串与没有data的预备事件。
			onId: (id) => {
				// 直接记最新ID，下一次开流可用作Last-Event-ID；不等JSON解析或业务结果成功才保存。
				cursor.lastEventId = id;
			},
			// 服务器retry字段的回调，不对间隔再钳制。
			onRetry: (delayMs) => {
				// 保存提示，后面重连优先用它，流重开不会自动清空。
				cursor.retryMs = delayMs;
			},
			// 仅有data字段的事件才走此回调，普通纯注释/只id不触发。
			onEvent: (event) => {
				// 先标received，再检查空data/事件名/JSON，所以无效或被忽略事件也可能使恢复计数视为有收到事件。
				cursor.received = true;
				// Events without data prime resumption; other event types are not JSON-RPC.
				// 全空白data或明确非message事件直接忽略；只记录游标和received，不当协议消息广播。
				if (!event.data.trim() || (event.event !== undefined && event.event !== "message")) return;
				// 先声明后赋值的消息变量，类型不自动执行校验。
				let message: JsonRpcMessage;
				// try只包住JSON解码与骨架检查，观察器/广播在此try之后。
				try {
					// 先解析data文字，再检查单条消息形状；数组在这个入口不会像JSON响应分支那样拆项。
					message = parseJsonRpcMessage(JSON.parse(event.data));
					// 捕获坏JSON/不合法消息骨架，准备错误报告。
				} catch (error) {
					// 错误监听器同步执行，若它再抛错可让整个消费Promise拒绝。
					this.emitError(error);
					// 错误通道正常返回后跳过此事件，继续读后面的SSE事件。
					return;
				}
				// 可选观察器先执行，抛错不会被上面JSON catch捕获。
				onMessage?.(message);
				// 再同步广播原消息，监听器异常可向外传播导致流消费失败。
				this.emitMessage(message);
			},
		});
	}

	/**
	 * Read the SSE stream answering one request. When the stream ends or breaks before the response
	 * arrives and the server assigned event IDs, resume it with GET and `Last-Event-ID`, as the
	 * server may close response streams at will. Otherwise only this request fails.
	 */
	// 消费某请求的SSE结果，输入body及requestId，返回后台Promise：读流并观察匹配响应，未答复时只有已得事件ID且错误可重试/额度允许才GET续传，最终无法恢复则广播该id的error。例：id:1预备位置后断流，可用Last-Event-ID:1重新GET。
	// 不重新POST原工具，不给整个client自动close；某请求取消也不会直接取消本后台流。匹配答复只设answered，当前reader仍可能读到流结束才退出，void调用处不统一捕获所有拒绝。
	private async consumeResponseStream(body: ReadableStream<Uint8Array>, requestId: JsonRpcId): Promise<void> {
		// 每个请求建独立游标，初始没有续传ID/提示。
		const cursor: StreamCursor = { lastEventId: undefined, retryMs: undefined, received: false };
		// 记录是否见过同id响应，不与McpClient.pending是否仍存在自动同步。
		let answered = false;
		// 消息观察器只更新闭包标记，不自行resolve业务Promise。
		const onMessage = (message: JsonRpcMessage) => {
			// 必须是响应且编号严格相等才算答复；数字1和字符串"1"不同，看到答复也不马上cancel reader。
			if (isJsonRpcResponse(message) && message.id === requestId) answered = true;
		};
		// 初次使用POST返回body；重开失败可置undefined，让下一轮仅做重试等待/开流。
		let stream: ReadableStream<Uint8Array> | undefined = body;
		// 存最近一次流/开流错误，undefined也用来表示自然读完。
		let failure: unknown;
		// 恢复循环初始attempt=0，增量放在下面安排退避时；不限总耗时而按状态/次数退出。
		for (let attempt = 0; ; ) {
			// 当前有流才尝试消费，没有则直接走恢复判定。
			if (stream) {
				// 捕获这一整段流消费的拒绝，保留给恢复分类。
				try {
					// 等该流完全结束/失败，过程中消息已被广播；不等于只等首个匹配响应。
					await this.consumeSse(stream, cursor, onMessage);
					// 正常读完把旧failure清成undefined，区别于异常断流。
					failure = undefined;
					// 接住consumeSse拒绝，不在这里立即关闭传输。
				} catch (error) {
					// 原错误存入failure，后面按isRetryable分类。
					failure = error;
				}
			}
			// 已见匹配响应或传输关闭就结束恢复；此检查在整段流退出之后，不会使仍挂着的reader提前返回。
			if (answered || this.closed) return;
			// 有明确失败且分类不可重试则停止，例如认证/会话专用HTTP错误不会在这里无限恢复。
			if (failure !== undefined && !this.isRetryable(failure)) break;
			// 没有任何事件ID，或计数已到上限，就不再重开；上限检查发生在下一行received重置计数之前。
			if (cursor.lastEventId === undefined || attempt >= this.maxRetries()) break;
			// 额度尚允许且本轮曾触发onEvent时计数重置0，不要求那事件一定是合法JSON-RPC回复。
			if (cursor.received) attempt = 0;
			// 清received以便衡量后续流是否实际给过事件。
			cursor.received = false;
			// 按当前attempt算退避后自增；sleep在close时返回false，此处立即退出，不发最终失败回包。
			if (!(await this.sleep(this.reconnectDelay(attempt++, cursor.retryMs)))) return;
			// 等待结束后尝试用GET重开，不重新POST工具调用。
			try {
				// 把当前最后ID交给openSseStream，服务端405时可能得到undefined而不是抛错。
				stream = await this.openSseStream(cursor.lastEventId);
				// GET打开失败进入这一catch并记录原因。
			} catch (error) {
				// 覆盖failure为最近开流错误，供最终说明使用。
				failure = error;
				// 开流错误不可重试就停止，后面给这个请求构造error响应。
				if (!this.isRetryable(error)) break;
				// 可重试错误清stream，下一轮不会重复消费旧body。
				stream = undefined;
			}
		}
		// 循环退出后若已close就不再主动生成该请求失败消息。
		if (this.closed) return;
		// 自然结束且无新错误用固定说明；有错误取toError.message，自定义转换仍可能抛错。
		const reason = failure === undefined ? "stream ended without a response" : toError(failure).message;
		// 把恢复失败包装成一条协议error消息广播，McpClient按id拒绝对应pending；如果该等待已取消/超时，那里可能只报告未知id。
		this.emitMessage({
			// 固定JSON-RPC版本。
			jsonrpc: "2.0",
			// 沿用原requestId，只影响这个关联响应，不给所有pending统一拒绝。
			id: requestId,
			// 内部错误码加流失败说明，不携带原Error对象或HTTP状态结构。
			error: { code: JSON_RPC_ERROR_CODES.internalError, message: `MCP response stream failed: ${reason}` },
		});
	}

	// 初始化通知后启动一次GET后台任务，无参数/返回；例：openGetStream:false使它完全不启动。只记录尝试标记，不等建立成功；后台拒绝仍可能因未兜错误监听器异常而逸出。
	private startGetStream(): void {
		// 显式禁用、已经启动过或已closed任一成立便返回，不额外开第二个后台任务。
		if (this.options.openGetStream === false || this.getStreamStarted || this.closed) return;
		// 启动前置标记，失败/耗尽后也不复位；单纯再次调用不会重启已停任务。
		this.getStreamStarted = true;
		// void不await后台runGetStream，也不自动catch最终拒绝；普通连接/读流错误主要由其中的循环处理。
		void this.runGetStream();
	}

	/** Keep the server-to-client stream open, reconnecting with backoff when it drops. */
	// 维持服务器主动消息的GET流，输入无参数，返回后台Promise：开流、消费、按正常活跃情况重置计数，异常分类后退避重开，405或关闭结束，耗尽/不可重试错误报告后停。例：g1后断流，再开GET带Last-Event-ID:g1。
	// 这是同传输流恢复，不重建client或重做initialize；停止时通常只emitError，不emitClose或拒绝全部pending。关闭依靠共享signal，认证提供者的独立等待不保证立即退出。
	private async runGetStream(): Promise<void> {
		// 本后台任务持有一份游标贯穿多次GET，与请求响应流的游标分开。
		const cursor: StreamCursor = { lastEventId: undefined, retryMs: undefined, received: false };
		// 每轮开始前查closed，计数在安排重试时自增，正常活跃流可重置。
		for (let attempt = 0; !this.closed; ) {
			// 捕获开GET和消费流的错误，分别交后面的重试分类。
			try {
				// 使用最后ID重开服务器消息流，无单次请求signal，只绑定传输共享关闭信号。
				const stream = await this.openSseStream(cursor.lastEventId);
				// The server does not offer a GET stream.
				// 405得到undefined就结束后台任务，表示服务器不提供GET；不是报认证失败或关闭整个client。
				if (!stream) return;
				// 记录流刚打开的本机时间，用于自然结束后判断维持时间。
				const openedAt = Date.now();
				// 一直消费到流自然结束或拒绝，消息在过程中同步广播。
				await this.consumeSse(stream, cursor);
				// A stream that stayed up for a while counts as healthy, even if it was idle.
				// 只有await正常结束才到此：收到过onEvent或存活严格超过maxDelay就归零计数；若读流throw，即使曾收到事件也跳过这一行。
				if (cursor.received || Date.now() - openedAt > this.maxDelay()) attempt = 0;
				// 处理开流/消费拒绝，不把所有失败都当正常自然结束。
			} catch (error) {
				// 关闭触发的失败直接结束，不再报重连错误。
				if (this.closed) return;
				// 不可重试错误停止后台任务，例如最终认证/会话错误状态。
				if (!this.isRetryable(error)) {
					// 通过错误通道报告原错误，监听器抛错可使本后台Promise拒绝。
					this.emitError(error);
					// 错误报告正常完成后返回，不在此额外发close事件。
					return;
				}
			}
			// 准备下一轮时把received归false，但lastEventId/retryMs继续保留。
			cursor.received = false;
			// 到达配置次数上限就停止，不保证恰是所有语义上的“连续失败”事件计数，实际重置按上方分支。
			if (attempt >= this.maxRetries()) {
				// 报告无法重开的普通Error，不把它伪造成某工具的业务结果。
				this.emitError(new Error("MCP server-to-client stream dropped and could not be reopened"));
				// 结束该后台任务，getStreamStarted依然true。
				return;
			}
			// 退避等待，当前attempt用于计算后再自增；close使sleep返回false便结束。
			if (!(await this.sleep(this.reconnectDelay(attempt++, cursor.retryMs)))) return;
		}
	}

	/** Open a GET SSE stream. Resolves to undefined when the server answers 405 (no GET stream). */
	// 请求/重开GET SSE流，输入可选最后事件ID，返回流或405时undefined；例：传"g1"会加Last-Event-ID:g1。会取认证token并发网络请求，HTTP/媒体类型错误可拒绝，不在这里消费流。
	private async openSseStream(lastEventId: string | undefined): Promise<ReadableStream<Uint8Array> | undefined> {
		// 用认证通路发GET，无单次派发signal实参，采用整体传输controller控制fetch。
		const response = await this.authorizedFetch("GET", {
			// 构造本次GET附加头，之后还会合并配置与会话头。
			headers: {
				// Accept要求服务器返回SSE。
				accept: "text/event-stream",
				// 仅ID不是undefined才带续传头；空字符串ID仍显式发送，不因真值判断被忽略。
				...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
			},
		});
		// 405专门表示此GET方式不支持，先于通用HTTP错误检查。
		if (response.status === 405) {
			// 尽力丢弃405正文，不解析其中内容。
			await discard(response);
			// 用undefined表示没有流，交两种调用循环各自决定结束/后续行为。
			return undefined;
		}
		// 其他状态先经过通用HTTP分类，失败抛错误而非返回空流。
		await this.checkResponse(response);
		// 状态通过才捕获可能的新会话头，缺省仍保留旧值。
		this.captureSession(response);
		// 归一化响应媒体类型。
		const type = contentType(response);
		// 不是text/event-stream或没有body都视为不支持此响应，不尝试用JSON替代GET流。
		if (type !== "text/event-stream" || !response.body) {
			// 先尽力取消不支持的body，避免把不用正文继续当消息流读。
			await discard(response);
			// 抛带状态和媒体类型说明的HTTP异常；HTTP状态即使是200也可能因格式不合失败。
			throw new McpHttpError(response.status, `Unsupported MCP GET response content type: ${type ?? "missing"}`);
		}
		// 返回Response原body，后续consumer取得reader并消费，不在这里复制或缓存整个流。
		return response.body;
	}

	/**
	 * Network failures and transient statuses are retried; auth, session, and protocol errors are not.
	 * `fetch` reports network failures, including a connection dropped mid-body, as `TypeError`.
	 */
	// 判断流失败是否可重试，输入unknown错误，返回boolean；例：new McpHttpError(503,"busy")为true、401错误为false，普通TypeError也为true。只分类不等待/重发；任意JS对象读取code的getter仍可能抛错。
	private isRetryable(error: unknown): boolean {
		// HTTP异常按状态特例/≥500判断，不把所有McpHttpError都当永久失败。
		if (error instanceof McpHttpError) return isTransientStatus(error.status);
		// TypeError一概归可重试，既可能来自fetch网络，也可能来自上层回调，不能反推出一定是网络断线。
		if (error instanceof TypeError) return true;
		// 可选链容忍null/undefined，as只向TS描述code字段，不做实际shape校验或保证getter不抛。
		const code = (error as { code?: unknown } | undefined)?.code;
		// code须字符串且以E或UND_ERR开头便允许重试；UND_ERR本不以E开头，两个前缀规则并列，不枚举实际系统错误表。
		return typeof code === "string" && (code.startsWith("E") || code.startsWith("UND_ERR"));
	}

	// 算重开等待毫秒数，输入当前attempt和可选服务器提示，返回number；例：默认attempt=1得2000。无sleep副作用；服务器提示优先且不按maxDelay钳制，也没验证结果有限/正数。
	private reconnectDelay(attempt: number, serverDelayMs: number | undefined): number {
		// serverDelayMs只要不是undefined就原样返回，0也采用，不走指数退避。
		if (serverDelayMs !== undefined) return serverDelayMs;
		// 本地初始间隔缺省用1000，0/负数/NaN等配置未被??替换。
		const initial = this.options.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
		// 指数2**attempt后取本地上限；这是数学数值计算，真正计时精度/32位边界仍由Node setTimeout决定。
		return Math.min(initial * 2 ** attempt, this.maxDelay());
	}

	// 读取本地退避上限，无参数/副作用，返回配置值或30000；例：配置0就返回0，不验证其范围或改写配置。
	private maxDelay(): number {
		// ??仅null/undefined回退，配置的特殊number值原样保留。
		return this.options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
	}

	// 读取重试次数上限，无参数/副作用，返回配置或5；例：配置0会阻止正常恢复次数，不取整或做正数校验。
	private maxRetries(): number {
		// 按可选链读取reconnect对象，缺字段才回退默认5。
		return this.options.reconnect?.maxRetries ?? DEFAULT_RECONNECT_MAX_RETRIES;
	}

	/** Resolves false when the transport closed while waiting. */
	// 可被传输close提前结束的退避等待，输入ms，返回Promise<boolean>：计时到为true，关闭signal为false。例：等待1000ms期间close会清timer并返回false；不启动HTTP，也不取消别人的认证Promise。
	// 计时器unref使这一等待单独不会维持Node进程；时长合法性/钳制由宿主决定，不是严格毫秒准点承诺。
	private sleep(ms: number): Promise<boolean> {
		// 使用整个传输共享的关闭signal，而非某个McpClient请求自己的signal。
		const signal = this.controller.signal;
		// 已经关闭就返回兑现false的Promise，不创建新计时器或监听器。
		if (signal.aborted) return Promise.resolve(false);
		// 创建Promise并立即登记后面的timer和abort回调，后续事件决定布尔结果。
		return new Promise((resolve) => {
			// 关闭回调捕获timer引用，触发时它已在正常同步初始化中建立。
			const onAbort = () => {
				// 清掉尚未到期的计时器，避免关闭后继续正常唤醒重连。
				clearTimeout(timer);
				// 兑现false，调用循环据此直接结束等待/恢复。
				resolve(false);
			};
			// 设宿主计时器，ms超大/负数/非整数的行为由Node处理，这里不另校验。
			const timer = setTimeout(() => {
				// 正常计时到达时先移除abort监听，避免它残留到以后close。
				signal.removeEventListener("abort", onAbort);
				// 兑现true表示本次等待按计时完成，不代表后续开流必成功。
				resolve(true);
				// 把输入ms作为延时参数，括号结束计时器注册而非立刻执行回调。
			}, ms);
			// A reconnect wait alone does not keep the process alive.
			// 有unref方法才调用，让这个timer本身不阻止进程自然退出；不会因此自动结束Promise。
			timer.unref?.();
			// once在首次abort后自动移除监听，正常计时完成则上面手动移除；注册不立即调用onAbort。
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}
