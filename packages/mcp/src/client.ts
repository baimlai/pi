// MCP客户端的协议层：连接时先initialize，再发送initialized通知；随后按id管理请求Promise、超时、进度、取消和服务端反向请求。coding-agent的MCP运行层使用本类，具体I/O交给注入的McpTransport。
// 本类不自动重连同一实例，也不调用模型；握手/工具/资源只按下方局部规则校验。HTTP流恢复由传输处理，上层连接恢复通常新建client。
// import type只使用工具结果类型，不产生对应运行时导入；内容块转换在独立content.ts中。
import type { CallToolResult } from "./protocol/content.ts";
// 同时导入消息类型与实际执行的识别/错误函数；带type的条目只用于编译期。
import {
	// 识别字符串或有限数字编号，用于进度和取消的外部参数边界。
	isJsonRpcId,
	// 识别无id通知的局部guard。
	isJsonRpcNotification,
	// 识别带id和方法名的请求骨架。
	isJsonRpcRequest,
	// 识别成功/失败响应骨架；本类消息分发优先走它。
	isJsonRpcResponse,
	// 检查非null非数组对象，不要求普通对象，也不意味着嵌套字段已合法。
	isObject,
	// 复用JSON-RPC常见错误码。
	JSON_RPC_ERROR_CODES,
	// 请求编号的字符串/数字联合类型。
	type JsonRpcId,
	// 请求、通知、响应的消息联合类型。
	type JsonRpcMessage,
	// 带id/method的请求类型，用于构造发送对象和处理反向调用。
	type JsonRpcRequest,
	// 带result或error的响应联合类型。
	type JsonRpcResponse,
	// 本地请求取消异常，name为AbortError。
	McpAbortError,
	// 连接不可用/已关闭时使用的异常。
	McpConnectionClosedError,
	// 携带协议code/data的本地异常。
	McpError,
	// 保存等待超时毫秒数的异常；真正计时在armTimeout。
	McpTimeoutError,
	// 把未知抛出值转成Error供监听器接收，已有Error原样保留。
	toError,
} from "./protocol/jsonrpc.ts";
// 导入握手、能力、工具与资源协议形状及版本常量。
import {
	// 客户端能力类型，不自动安装能力对应方法。
	type ClientCapabilities,
	// 客户端/服务器名称版本信息的共用接口。
	type Implementation,
	// initialize业务结果类型，接收后仍需局部校验。
	type InitializeResult,
	// 默认提出的本地协议版本，非实时查询远端版本。
	LATEST_PROTOCOL_VERSION,
	// 资源单页结果类型。
	type ListResourcesResult,
	// 资源模板单页结果类型。
	type ListResourceTemplatesResult,
	// 进度回调接收的通知类型，运行时入口只检查其部分字段。
	type ProgressNotification,
	// 资源正文结果类型。
	type ReadResourceResult,
	// 单个资源描述类型。
	type Resource,
	// 单个资源模板描述类型。
	type ResourceTemplate,
	// 客户端声明的根资源类型，声明root不建立沙箱。
	type Root,
	// 服务器能力类型，握手只浅查capabilities对象。
	type ServerCapabilities,
	// 本地可接受的协商版本清单。
	SUPPORTED_PROTOCOL_VERSIONS,
	// 从版本清单推导的字符串字面量联合，用于配置约束。
	type SupportedProtocolVersion,
	// 远端工具定义类型，不包含本地execute实现。
	type Tool,
} from "./protocol/types.ts";
// 传输接口只描述start/send/close和事件订阅；本类不依赖具体HTTP/stdio构造器。
import type { McpTransport } from "./transports/transport.ts";

// 默认一次请求的等待窗口为30000毫秒；数字下划线只便于阅读，不改变数值。
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// 完整列表最多请求1000页，避免服务器持续给新游标导致无限翻页；不限制每页项目数或总字节数。
const MAX_LIST_PAGES = 1_000;

// 状态的字符串字面量联合，初始idle只允许首次连接，closed不会自动回到idle。
type ClientState = "idle" | "connecting" | "connected" | "closed";
// 通知监听器接收unknown参数，void表示调用方不使用返回值；此实现同步调用、不await，传入async回调的拒绝不会被同步try/catch捕获。
type NotificationListener = (params: unknown) => void;
// 错误监听器收一个Error；emitError直接调用它，监听器自己抛错可向外传播。
type ErrorListener = (error: Error) => void;
// 连接关闭回调不接参数，失败原因可从请求拒绝或错误通道了解。
type CloseListener = () => void;
// 反向请求处理器收到未知params和取消signal，可返回普通值或Promise；unknown联合意味着运行时没有保证结果可JSON编码。
type RequestHandler = (params: unknown, context: { signal: AbortSignal }) => unknown | Promise<unknown>;

// extends让配置继承Implementation必需的name/version和可选title；这里只扩充连接行为参数，不作运行时验证。
export interface McpClientOptions extends Implementation {
	// 可选客户端能力，握手时浅复制；声明能力不自动实现服务端反向方法。
	capabilities?: ClientCapabilities;
	// 可选首选版本，TS限制在支持清单中；缺省使用LATEST_PROTOCOL_VERSION。
	protocolVersion?: SupportedProtocolVersion;
	// 默认请求超时毫秒数，单次options.timeoutMs可覆盖；非有限/非正值在armTimeout中会关闭计时器。
	requestTimeoutMs?: number;
	// 根资源可直接给只读数组，也可给返回数组/Promise的函数；函数在每次roots/list请求时调用，readonly不深冻结成员。
	roots?: readonly Root[] | (() => readonly Root[] | Promise<readonly Root[]>);
}

// 单次协议请求选项；默认空对象不强制提供signal、时长或进度回调。
export interface McpRequestOptions {
	// 可选协作取消信号；本地拒绝等待并不证明远端已停止执行或撤销副作用。
	signal?: AbortSignal;
	// 本次等待窗口毫秒数；有进度通知时重新计时，不是不可续期的总执行时限。
	timeoutMs?: number;
	// 提供进度回调时才在参数_meta里添加progressToken；客户端会用有效关联进度续时后调用它。
	onProgress?: (progress: ProgressNotification) => void;
}

// 每个尚未结算请求的内部记录；pending用id找到它，从而完成/拒绝Promise并释放计时器和监听。
interface PendingRequest {
	// 兑现Promise的回调，可接受任何业务结果；方法级helper再做自己的浅校验。
	resolve: (value: unknown) => void;
	// 拒绝Promise的回调，原因可为未知值，不一定是Error实例。
	reject: (reason: unknown) => void;
	// 此请求最终选出的等待窗口，续时仍使用同一个值。
	timeoutMs: number;
	// ReturnType<typeof setTimeout>从函数类型提取返回值，Node下为计时器句柄；undefined表示尚未设置。
	timer: ReturnType<typeof setTimeout> | undefined;
	// 调用方signal或undefined；字段本身必需，但值允许为undefined，用于结算时移除监听。
	signal: AbortSignal | undefined;
	// 保存实际注册的abort回调引用，removeEventListener需要同一个函数。
	onAbort: () => void;
	/** Aborted when the request settles, so the transport does not dispatch (or retry) it afterwards. */
	// 请求结算时abort这个内部控制器，通知支持此signal的传输停止尚未发送/重试的动作；已发出的操作无法靠它回滚。
	sendController: AbortController;
	// 是否允许向服务器发送取消通知；initialize为false，但本地等待仍会超时/取消。
	cancellable: boolean;
	// 可选进度处理函数；双括号把整个函数类型与undefined联合，区别于只让返回值可undefined。
	onProgress: ((progress: ProgressNotification) => void) | undefined;
	// 关联进度的令牌；本实现用请求编号，有回调才登记。
	progressToken: JsonRpcId | undefined;
}

// 浅查initialize的未知结果，合格就返回原对象的类型视图，失败抛McpError(-32600)；例：有字符串版本、对象能力和name/version的serverInfo可通过。
// 只检查下面列出的字段，不验证能力子项/title或清洗额外键；属性访问可触发getter，类型断言不会再执行验证。
function validateInitializeResult(value: unknown): InitializeResult {
	// 多行if用||列出任何一个不合格条件，遇到首个true就进入失败分支。
	if (
		// 先排除非对象，后续条件才能读协议属性。
		!isObject(value) ||
		// 版本必须是字符串；是否属于本地支持版本稍后由connect另查。
		typeof value.protocolVersion !== "string" ||
		// capabilities只要求非null非数组对象，不逐项验证。
		!isObject(value.capabilities) ||
		// 服务器信息也先要求对象，再查下面name/version。
		!isObject(value.serverInfo) ||
		// 服务器自报名称必须为字符串，不检查非空或认证来源。
		typeof value.serverInfo.name !== "string" ||
		// 服务器版本必须为字符串，不解析版本号格式。
		typeof value.serverInfo.version !== "string" ||
		// instructions缺省/undefined允许；只在提供时要求string，null不会通过。
		(value.instructions !== undefined && typeof value.instructions !== "string")
	) {
		// 任何浅查失败就抛统一协议异常；调用方connect会进入自身catch关闭本次连接。
		throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid MCP initialize result");
	}
	// 先断言unknown再断言InitializeResult，只改变TS眼中的类型；仍是同一个输入对象，未复制或深冻结。
	return value as unknown as InitializeResult;
}

// 用指定文字构造invalidRequest协议异常并返回，便于校验器throw；例：throw invalid("bad page")。本函数自己不发送响应，也不自行抛出。
function invalid(message: string): McpError {
	// 创建McpError并赋固定错误码，message原样传入。
	return new McpError(JSON_RPC_ERROR_CODES.invalidRequest, message);
}

/** One page of a paginated list: the items under `key`, each checked by `isItem`. */
// 验证一页未知列表：按key取数组，逐项用isItem局部检查，再规范nextCursor，返回items/可选游标；出错抛McpError。例：resources键的一页缺省name仍可经对应回调通过。
// 不深复制输入项目、不做全schema校验；项目或游标属性的getter也可抛错。
function validateListPage(
	// 方法名仅用于错误说明，例如resources/list。
	method: string,
	// 结果数组所在键，例如resources；动态索引不是写死某种业务列表。
	key: string,
	// 外部返回的未知值，在这里检查对象与数组边界。
	value: unknown,
	// 回调输入已确认为对象的某项，返回布尔值决定此项是否合格；false使整页失败，不是过滤项目，也不是TS类型谓词。
	isItem: (item: Record<string, unknown>) => boolean,
	// 返回新包装对象，内部items仍指原数组；可选nextCursor为字符串。
): { items: Record<string, unknown>[]; nextCursor?: string } {
	// 只有对象才按key读候选数组，否则得到undefined；条件运算符避免对null等读属性。
	const items = isObject(value) ? value[key] : undefined;
	// 外层不是对象或候选不是数组便抛错；没有把异常值自动转换成空页。
	if (!isObject(value) || !Array.isArray(items)) throw invalid(`Invalid MCP ${method} result`);
	// for...of按数组顺序逐个检查，项目很多时仍需逐项遍历，没有在此设置总量限制。
	for (const item of items) {
		// 项目必须是非null非数组对象并通过业务回调；有一个失败就整页抛错，不是过滤掉坏项目。
		if (!isObject(item) || !isItem(item)) throw invalid(`Invalid entry in MCP ${method} result`);
	}
	// Some servers end pagination with `null` or `""` instead of omitting the cursor.
	// 把null和空字符串游标都视为结束；其他值暂存原样，下一行再验证类型。
	const nextCursor = value.nextCursor === null || value.nextCursor === "" ? undefined : value.nextCursor;
	// 非undefined游标必须为字符串；数字等不会被String强制转换。
	if (nextCursor !== undefined && typeof nextCursor !== "string") throw invalid(`Invalid MCP ${method} cursor`);
	// 对象展开有条件地加游标；结束时不生成该键，items仍沿用已检查的原数组。
	return { items, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

// 检查工具项目的最小骨架：输入对象，返回布尔值；例：name:"read"加inputSchema:{}通过。只查名称字符串与schema对象，不编译schema、不验outputSchema等字段，也不修改工具。
const isTool = (tool: Record<string, unknown>) => typeof tool.name === "string" && isObject(tool.inputSchema);
// `name` is required by the spec, but some servers omit it; the URI stands in.
// 检查资源项目骨架的箭头函数：uri须字符串，name可省略；例：{uri:"file:///a"}通过且稍后补名。输入对象不改，返回布尔值，额外字段不深验。
const isResource = (resource: Record<string, unknown>) =>
	// 名称为undefined或字符串均允许，空名称保留；null不通过。属性读取可含继承值。
	typeof resource.uri === "string" && (resource.name === undefined || typeof resource.name === "string");
// 检查资源模板骨架，规则对应资源但使用uriTemplate；例：{uriTemplate:"repo://{id}"}通过，不检查模板语法，返回布尔值且不修改。
const isResourceTemplate = (template: Record<string, unknown>) =>
	// 模板地址要求string，名称缺省或string；没有确认参数占位是否合法。
	typeof template.uriTemplate === "string" && (template.name === undefined || typeof template.name === "string");

// 把已浅查资源标准化成新对象并补名称；例：{uri:"file:///a"}得到name同URI。不改原项，浅复制可触发getter，嵌套值仍共享。
function toResource(item: Record<string, unknown>): Resource {
	// ...展开可枚举自有字段，再以name覆盖；??仅null/undefined才回退uri，空字符串保留。as Resource只是TS断言，不新增验证。
	return { ...item, name: item.name ?? item.uri } as Resource;
}

// 把资源模板标准化为新对象并补name；例：uriTemplate:"repo://{id}"且没name时以模板文字命名。不展开模板或访问资源，嵌套数据仍共享引用。
function toResourceTemplate(item: Record<string, unknown>): ResourceTemplate {
	// 浅展开原字段后覆盖name，缺省回退uriTemplate；类型断言不检查剩余属性。
	return { ...item, name: item.name ?? item.uriTemplate } as ResourceTemplate;
}

// 提取标准化页的可选游标为新对象；例：无游标返回{}，cursor:"2"返回{nextCursor:"2"}。不改输入，也不请求下一页。
function pageCursor(page: { nextCursor?: string }): { nextCursor?: string } {
	// 条件运算符在结束时完全省略nextCursor键，其余情况下保留原字符串。
	return page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor };
}

// 浅查readResource结果：须有contents数组，每项须对象、字符串uri及至少一个字符串text/blob；合格返回原值，否则抛协议异常。例：{contents:[{uri:"file:///a",text:"hi"}]}通过。
// 不验证MIME/base64/_meta，也不要求text和blob互斥，故不是完整资源schema验证。
function validateReadResourceResult(value: unknown): ReadResourceResult {
	// 先检查外层对象与contents数组，失败不进入后面的遍历。
	if (!isObject(value) || !Array.isArray(value.contents)) throw invalid("Invalid MCP resources/read result");
	// 逐项遍历contents；一个项目失败便拒绝整个结果。
	for (const contents of value.contents) {
		// 用多行if组合任一不合法条件。
		if (
			// 每项正文须为非null非数组对象。
			!isObject(contents) ||
			// uri须字符串，不判断目标地址是否合法或存在。
			typeof contents.uri !== "string" ||
			// text与blob都不是字符串才失败；任一个是字符串即可，另一个即使是非法额外值也不在这里检查。
			(typeof contents.text !== "string" && typeof contents.blob !== "string")
		) {
			// 抛invalidRequest异常，不返回部分已通过的正文。
			throw invalid("Invalid contents in MCP resources/read result");
		}
	}
	// 双重类型断言返回原对象，不复制、移除额外字段或解码blob。
	return value as unknown as ReadResourceResult;
}

/**
 * `content` is required by the spec, but servers that only return `structuredContent` omit it (the SDK defaults it too).
 * `structuredContent` may be any JSON value, as MCP 2026-07-28 allows.
 */
// 浅查tools/call业务结果：须对象，content若提供须数组；缺省时补空数组，否则原样返回。例：{structuredContent:{ok:true}}会补content:[]，content:null则失败。
// 不检查数组每个块、isError、structuredContent是否JSON值或outputSchema；这一步不能为后续转换器证明所有嵌套值合法。
function validateCallToolResult(value: unknown): CallToolResult {
	// 先排除非对象；content等于undefined视为缺省，其余情况只检查Array.isArray，空数组允许。
	if (!isObject(value) || (value.content !== undefined && !Array.isArray(value.content))) {
		// 不合格时抛带invalidRequest码的McpError。
		throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid MCP tools/call result");
	}
	// 缺省才浅复制并补空content；已是数组就返回原对象。as unknown as只给TS指定接口，不在运行时补其他字段。
	return (value.content === undefined ? { ...value, content: [] } : value) as unknown as CallToolResult;
}

// 管理一个传输生命周期的MCP客户端；职责是协议交互及请求关联，不是HTTP重试器、子进程管理器或模型执行器。
export class McpClient {
	// 公开只读配置引用；Readonly<T>只限制顶层TS字段，构造器也只浅冻结外层复制对象。
	readonly options: Readonly<McpClientOptions>;
	// 私有TS字段保存本地状态；private不等于JS的#硬私有语法。
	private state: ClientState = "idle";
	// 注入的传输接口，尚未connect或主动close摘除后为undefined。
	private transport: McpTransport | undefined;
	// 自增请求编号从1开始；不在此回收旧编号或实施安全整数上限。
	private nextRequestId = 1;
	// 最近一次写入的服务器身份引用；关闭时不会清空，不代表getter取到时仍在线。
	private serverInfoValue: Implementation | undefined;
	// 握手获得的能力原对象引用，不是持续查询远端的实时状态。
	private serverCapabilitiesValue: ServerCapabilities | undefined;
	// 服务器指引文字，初始化前可undefined，关闭后仍保留已写入值。
	private instructionsValue: string | undefined;
	// 协商得到的版本；在发送initialized通知前就写入，后续步骤失败也不会清空。
	private protocolVersionValue: string | undefined;
	// Map按请求id存等待记录，一个响应用此表找到相应Promise。
	private pending = new Map<JsonRpcId, PendingRequest>();
	// 进度令牌到请求id的映射，有进度回调的请求才登记。
	private progressRequests = new Map<JsonRpcId, JsonRpcId>();
	// 服务器反向请求的id到本地AbortController映射；与本地主动发出的pending方向相反。
	private incoming = new Map<JsonRpcId, AbortController>();
	// 每个方法名仅保留一个反向处理器，后注册会覆盖同名旧处理器。
	private requestHandlers = new Map<string, RequestHandler>();
	// 每种通知名对应一组监听器，Set会对同一函数引用去重。
	private notificationListeners = new Map<string, Set<NotificationListener>>();
	// 传输/协议/回调错误的同步监听器集合，不自动写日志。
	private errorListeners = new Set<ErrorListener>();
	// 关闭通知监听器集合，重复markClosed通过状态抑制再次发通知。
	private closeListeners = new Set<CloseListener>();
	// 保存传输事件的退订函数；(() => void)[]表示函数数组，不是返回数组的单个函数。
	private disposers: (() => void)[] = [];

	// 创建客户端：浅复制并冻结外层配置，装默认ping与可选roots/list处理器；不启动传输。例：new McpClient({name:"pi",version:"1"})后仍为idle，需另await connect。
	// roots函数等到服务端请求时才运行；构造不验证能力声明或访问根目录，Object.freeze仅作用于新的顶层配置。
	constructor(options: McpClientOptions) {
		// 先用对象展开复制可枚举自有配置，再浅冻结；嵌套capabilities/roots仍可能共享，展开时getter可执行或抛错。
		this.options = Object.freeze({ ...options });
		// 默认反向ping处理器返回空对象；箭头里的({})是对象表达式，不是函数体。
		this.requestHandlers.set("ping", () => ({}));
		// 保存当前roots引用供闭包使用，不在每次调用时重新读取options.roots。
		const roots = options.roots;
		// 有真值roots才注册；空数组在JS也是真值，因此可以提供一个返回空根列表的处理器。
		if (roots) {
			// 注册async反向处理器，最终返回{roots:...}；错误由handleRequest转成协议错误响应。
			this.requestHandlers.set("roots/list", async () => ({
				// 函数配置每次现调并await，数组配置直接使用；外层[...]复制数组但不深复制Root成员，函数可能抛错/拒绝。
				roots: [...(typeof roots === "function" ? await roots() : roots)],
			}));
		}
	}

	// 读取本地连接状态，无参数/副作用；例：构造后为idle、正常connect后为connected。它不主动探测远端是否仍可用。
	get connectionState(): ClientState {
		// getter语法使调用者用client.connectionState像属性一样读取state。
		return this.state;
	}

	// 取已写入的服务器身份引用，无参数/副作用；初始化前undefined，关闭后可能仍有旧信息，不是在线保证或深只读副本。
	get serverInfo(): Implementation | undefined {
		// 直接返回缓存引用，读取不会请求服务器。
		return this.serverInfoValue;
	}

	// 取握手能力引用，无参数/副作用；例如返回{tools:{}}，并非重新验证或刷新远端能力，关闭后也不清空。
	get serverCapabilities(): ServerCapabilities | undefined {
		// 原对象直接返回，接口没有深冻结其中的子字段。
		return this.serverCapabilitiesValue;
	}

	// 取服务器指引文字，无参数/副作用；例如"Use test tools."。是否送模型由使用方决定，关闭后不自动删除。
	get instructions(): string | undefined {
		// 返回最近写入的字符串或undefined，不加工空白。
		return this.instructionsValue;
	}

	// 取协商版本字符串，无参数/副作用；例：服务器选旧版时返回旧版，不必等于默认版本，也不表示当前已连接。
	get protocolVersion(): string | undefined {
		// 直接返回握手中已写入的版本值，不从传输实时查询。
		return this.protocolVersionValue;
	}

	// 启动一次传输并握手：只接受idle，订阅事件、start、initialize、浅查结果与版本、保存元数据、发送initialized后设connected并返回结果；失败通常先close再拒绝。例：await client.connect(memoryTransport)。
	// 同一实例closed后不能再connect；恢复由上层新建实例或传输自身流恢复处理。元数据在最后通知前已写入，失败/close不清；这里没有在每个await后重新检查并发close。事件注册在try外，注册器抛错不走下方catch。
	async connect(transport: McpTransport): Promise<InitializeResult> {
		// 非idle直接抛错；async方法会把抛出变为返回Promise的拒绝，禁止重复连接同一个实例。
		if (this.state !== "idle") throw new Error(`Cannot connect MCP client in ${this.state} state`);
		// 先切换connecting，普通request/notify尚不允许，只允许内部握手带allowConnecting调用。
		this.state = "connecting";
		// 保存调用方传入的传输，不在这里克隆或选择HTTP/stdio。
		this.transport = transport;
		// 收集三个事件订阅返回的清理函数，close时统一执行。
		this.disposers = [
			// 收到消息时交给协议分发器，回调本身同步执行。
			transport.onMessage((message) => this.handleMessage(message)),
			// Transport errors are reported only. Pending requests fail when the transport closes.
			// 传输错误只走错误通道，不立即拒绝所有等待请求；后续close、超时、取消或响应仍可决定请求结果。
			transport.onError((error) => this.emitError(error)),
			// 传输关闭则标记closed、拒绝在途等待并通知上层；不会在此自动重新握手。
			transport.onClose(() => this.handleTransportClose()),
		];

		// 从start开始的异步流程放在try内，以便失败时尝试关闭并保留原错误。
		try {
			// 启动实际I/O，具体传输可能启子进程或准备HTTP；此处await成功后才发initialize。
			await transport.start();
			// 浅复制客户端能力，缺省时得到空对象；不深复制嵌套能力声明。
			const capabilities: ClientCapabilities = { ...this.options.capabilities };
			// 有roots配置且未声明roots能力时补{}，表示提供根列表；若已声明则沿用，不自动开启listChanged。
			if (this.options.roots && capabilities.roots === undefined) capabilities.roots = {};
			// 等待initialize业务结果并调用前面的浅校验器；通过不等于版本已获支持。
			const result = validateInitializeResult(
				// 使用内部请求通路，所以同样有pending关联和默认超时机制。
				await this.requestInternal(
					// 固定握手方法名initialize。
					"initialize",
					// 组装握手业务参数对象，不直接把整个options发送给服务器。
					{
						// ??在协议版本缺省时采用本地默认；TS可限制配置文字，运行时这里不先验证配置值。
						protocolVersion: this.options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
						// 发送本轮整理后的客户端能力对象。
						capabilities,
						// 身份信息只选择下面三项，不包含roots函数或其他私有设置。
						clientInfo: {
							// 客户端自报名称。
							name: this.options.name,
							// 客户端自报版本文字。
							version: this.options.version,
							// 仅title不是undefined时展开该字段；空字符串标题仍会发送。
							...(this.options.title === undefined ? {} : { title: this.options.title }),
						},
					},
					// 本次握手不单独提供请求选项，因而使用客户端默认等待时长且没有调用方signal/进度回调。
					{},
					// true允许在connecting状态发送内部握手请求；不是表示跳过等待结果。
					true,
				),
			);
			// 先将只读版本元组在类型层面视为readonly string[]，以便includes接受返回的任意字符串；再实际检查是否属于清单。
			if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(result.protocolVersion)) {
				// 不支持服务器选定版本时抛普通Error，进入下面关闭/拒绝流程。
				throw new Error(`MCP server selected unsupported protocol version ${result.protocolVersion}`);
			}
			// 先记下协商版本；下方initialized发送失败也不会回滚这些已写入字段。
			this.protocolVersionValue = result.protocolVersion;
			// 保留原serverInfo对象引用，不深复制。
			this.serverInfoValue = result.serverInfo;
			// 保留服务器能力原对象。
			this.serverCapabilitiesValue = result.capabilities;
			// 保留服务器instructions，缺省可为undefined。
			this.instructionsValue = result.instructions;
			// 可选方法存在才把协商版本交给传输，例如用于后续HTTP协议头；?.调用不吞方法抛出的异常。
			transport.setProtocolVersion?.(result.protocolVersion);
			// 允许connecting状态发送initialized通知并等待传输send完成；通知本身没有JSON-RPC结果响应。
			await this.notifyInternal("notifications/initialized", undefined, true);
			// 最后直接写connected；不是一次原子握手，也没有在这一行重新确认期间是否被close。
			this.state = "connected";
			// 返回已经浅查的原握手结果，调用者可从中读取元数据。
			return result;
			// 捕获当前try调用栈中的同步抛错及await拒绝；独立触发的事件回调异常不由此统一兜底。
		} catch (error) {
			// 尝试close，关闭自身失败被空catch吞掉；仍会等待这次close返回，不改成成功连接。
			await this.close().catch(() => {});
			// 重新抛原错误，保留本轮连接失败的主要原因。
			throw error;
		}
	}

	// 发送一个通用协议请求并返回指定结果类型的Promise；例：request<{ok:boolean}>("custom",{})。输入method/可选对象params/选项，副作用是实际发送和登记等待，异常经Promise拒绝。
	// Result = unknown是默认泛型；调用方写Result只改变TS预期，不验证服务器结果，需特定helper或自行校验。
	request<Result = unknown>(
		// 方法名字符串，本通路不检查它是否在服务器能力声明里。
		method: string,
		// 可选参数对象，值可unknown；不自动按工具inputSchema验证。
		params?: Record<string, unknown>,
		// 选项缺省新空对象，用于signal/等待窗口/进度回调。
		options: McpRequestOptions = {},
		// Promise<Result>是异步结果类型，即使此方法本身没有async关键字也能返回Promise。
	): Promise<Result> {
		// false要求当前已connected；as Promise<Result>只断言类型，没有转换或深校验返回值。
		return this.requestInternal(method, params, options, false) as Promise<Result>;
	}

	// 发送一个不带id的通知，输入方法和可选对象参数，返回发送完成的Promise；例：notify("notifications/roots/list_changed")。不登记pending，不等远端JSON-RPC回复，连接/发送失败可拒绝。
	notify(method: string, params?: Record<string, unknown>): Promise<void> {
		// 复用内部通知通路，false禁止在普通外部调用中绕过connecting限制。
		return this.notifyInternal(method, params, false);
	}

	// 注册/替换服务端反向请求处理器，返回退订函数；例：setRequestHandler("custom",async(params,{signal})=>({ok:true}))。不立即执行handler；处理时错误由handleRequest转成响应。
	setRequestHandler(method: string, handler: RequestHandler): () => void {
		// Map.set以同名键覆盖旧处理器，不合并多个处理器。
		this.requestHandlers.set(method, handler);
		// 闭包捕获本次method/handler，供调用者日后注销。
		return () => {
			// 只有当前仍是这一个handler才删除，避免旧退订函数误删后注册的替代处理器。
			if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
		};
	}

	// 订阅某个通知，返回清理函数；例：onNotification("notifications/tools/list_changed",()=>refresh())。不向服务器发送订阅请求，回调仅在收到该名称时运行，同步异常转给错误通道。
	onNotification(method: string, listener: NotificationListener): () => void {
		// 已有Set就复用，没有就创建新Set；??只对null/undefined回退。
		const listeners = this.notificationListeners.get(method) ?? new Set<NotificationListener>();
		// 把该集合登记到通知名键下，后续分发通过名称取得它。
		this.notificationListeners.set(method, listeners);
		// 加入函数引用，相同引用重复加入不会重复存储。
		listeners.add(listener);
		// 返回闭包用于移除这一组中的监听器，不取消服务器端操作。
		return () => {
			// 从捕获的Set删除回调，重复delete通常无额外效果。
			listeners.delete(listener);
			// 该Set空时删除通知名称的映射；并非把其他通知的监听器一并清空。
			if (listeners.size === 0) this.notificationListeners.delete(method);
		};
	}

	// 订阅本地错误通道并返回清理函数；例：onError(error=>log(error.message))。不发网络消息，也不自动让pending失败；监听器自己抛错会向外传播。
	onError(listener: ErrorListener): () => void {
		// Set保存回调并按引用去重。
		this.errorListeners.add(listener);
		// 返回删除此回调的函数；实现返回delete的布尔值，但公开的void返回类型不要求调用者使用它。
		return () => this.errorListeners.delete(listener);
	}

	/** Called once when the connection closes, whether the transport dropped or `close()` was called. */
	// 注册关闭通知，返回清理函数；例：onClose(()=>showOffline())。不主动关闭，也不在已closed后立即补发通知；常规生命周期由markClosed抑制重复通知，回调失败转错误通道。
	onClose(listener: CloseListener): () => void {
		// 登记关闭回调，同引用去重。
		this.closeListeners.add(listener);
		// 返回按引用删除监听器的函数，不改连接状态。
		return () => this.closeListeners.delete(listener);
	}

	// 请求ping并仅等待成功，返回Promise<void>；例：await client.ping({timeoutMs:500})。发送失败/协议错误/超时会拒绝，不要求业务result必须是空对象。
	async ping(options: McpRequestOptions = {}): Promise<void> {
		// 发送无params的ping，await其结果但不返回业务值，复用单次请求选项。
		await this.request("ping", undefined, options);
	}

	// 拉取所有工具页并返回工具数组；例：await client.listTools()。会多次请求tools/list，有重复游标/页数超限或浅查失败则拒绝，不按schema验证实际工具执行。
	async listTools(options: McpRequestOptions = {}): Promise<Tool[]> {
		// listAll逐页检查name/inputSchema骨架再合并；双重断言把对象数组视为Tool[]，不因此深验注解等可选字段。
		return (await this.listAll("tools/list", "tools", isTool, options)) as unknown as Tool[];
	}

	/** Every resource, following `nextCursor` through all pages. */
	// 拉全资源描述并补缺省名称，返回Resource[]；例：服务端两页各一项时得到两项数组。实际访问列表可失败，正文读取需另call readResource。
	async listResources(options: McpRequestOptions = {}): Promise<Resource[]> {
		// 等全部分页完成后map生成标准化资源对象；只拿描述，不自动请求每个资源URI。
		return (await this.listAll("resources/list", "resources", isResource, options)).map(toResource);
	}

	/** One page of resources, starting at `cursor`. */
	// 取一页资源，输入可选cursor与请求选项，返回资源数组/下一游标；例：listResourcesPage("2")。只发这一页请求，失败拒绝，不自动取后续页。
	async listResourcesPage(cursor?: string, options: McpRequestOptions = {}): Promise<ListResourcesResult> {
		// 用resources/list和resources字段的最小项目校验器取页。
		const page = await this.listPage("resources/list", "resources", isResource, cursor, options);
		// 重建返回对象，成员经补名转换，并按pageCursor决定是否加游标；原页其他元数据不保留。
		return { resources: page.items.map(toResource), ...pageCursor(page) };
	}

	/** Every resource template, following `nextCursor` through all pages. */
	// 取完资源模板分页并补名称，返回模板数组；例：得到repo://{id}的模板描述。发列表请求可拒绝，不替换模板参数或读取实际资源。
	async listResourceTemplates(options: McpRequestOptions = {}): Promise<ResourceTemplate[]> {
		// 先等待所有页的原始对象列表。
		const templates = await this.listAll(
			// 协议方法为resources/templates/list。
			"resources/templates/list",
			// 结果数组键为resourceTemplates。
			"resourceTemplates",
			// 每项用模板地址/可选名称的浅校验器检查。
			isResourceTemplate,
			// 所有页复用请求选项，每页仍有自己的等待记录和超时窗口，不是整个翻页过程的总时限。
			options,
		);
		// 逐项浅复制并补name，保留数组次序。
		return templates.map(toResourceTemplate);
	}

	/** One page of resource templates, starting at `cursor`. */
	// 取资源模板的一页并返回可选下一游标；例：listResourceTemplatesPage("2")。只取当前页，不展开模板，发送/浅查失败经Promise拒绝。
	async listResourceTemplatesPage(
		// cursor可省略，表示首个请求不带cursor参数。
		cursor?: string,
		// 默认空选项，可传signal或单页等待窗口。
		options: McpRequestOptions = {},
		// 返回类型描述本页数组和可选nextCursor。
	): Promise<ListResourceTemplatesResult> {
		// 复用内部单页请求/校验流程。
		const page = await this.listPage(
			// 选择模板列表协议方法。
			"resources/templates/list",
			// 指定结果数组字段。
			"resourceTemplates",
			// 指定逐项校验器，不编译模板语法。
			isResourceTemplate,
			// 把调用方游标原样传给请求构造器。
			cursor,
			// 把调用方取消/超时/进度选项传入这一页请求。
			options,
		);
		// 标准化各项名称并仅保留模板数组/游标字段。
		return { resourceTemplates: page.items.map(toResourceTemplate), ...pageCursor(page) };
	}

	// 按URI请求一份资源结果，返回ReadResourceResult；例：readResource("file:///a")。只让远端执行resources/read，本地不直接读该路径；发送、取消、浅查失败会拒绝。
	async readResource(uri: string, options: McpRequestOptions = {}): Promise<ReadResourceResult> {
		// 等待响应后浅查contents骨架，保留原内容对象；不解码blob、不限制MIME或本地输出长度。
		return validateReadResourceResult(await this.request("resources/read", { uri }, options));
	}

	// 请求一页通用列表并调用validateListPage，返回items及标准化游标；例：method=tools/list、key=tools。实际发送/校验可能拒绝，不修改项目对象。
	private async listPage(
		// 远端方法名决定请求目标及错误说明。
		method: string,
		// 结果数组的键名，由对应公开helper固定传入。
		key: string,
		// 业务项目的最小字段检查函数，接收已确认的对象。
		isItem: (item: Record<string, unknown>) => boolean,
		// 显式string | undefined表示参数位置必需但允许值为undefined，和可省略参数写法不同。
		cursor: string | undefined,
		// 本页请求选项，交给request处理。
		options: McpRequestOptions,
		// Promise包裹新的页对象，items仍是服务端原数组引用。
	): Promise<{ items: Record<string, unknown>[]; nextCursor?: string }> {
		// 把请求完成结果交给页校验器；await失败会直接使本async方法拒绝。
		return validateListPage(
			// 方法名称给校验错误提供具体协议上下文。
			method,
			// 动态选择数组所在字段。
			key,
			// cursor为undefined时省掉整个params，其他字符串（包括调用方直接给的空串）会作为{cursor}发送。
			await this.request(method, cursor === undefined ? undefined : { cursor }, options),
			// 把逐项规则交给validateListPage，不在此重复遍历。
			isItem,
		);
	}

	/** Every item of a paginated list method. */
	// 逐页收集完整列表，返回合并数组；输入方法/字段/项目规则/选项，副作用是多次协议请求。例：页1游标"2"、页2无游标就返回两页项目。
	// 重复游标或超过1000页抛普通Error，不返回半成品；每页保留服务器顺序，不去重项目，不提供整个翻页过程的独立总超时。
	private async listAll(
		// 要连续请求的方法名。
		method: string,
		// 每页取项目的字段名。
		key: string,
		// 每页项目检查回调，不随页数改变。
		isItem: (item: Record<string, unknown>) => boolean,
		// 每次请求复用同一组选项，signal可取消后续请求。
		options: McpRequestOptions,
		// 返回Promise中的普通对象数组，由公开helper再标为工具或标准化为资源。
	): Promise<Record<string, unknown>[]> {
		// 创建累计结果数组，尚未发请求时为空。
		const items: Record<string, unknown>[] = [];
		// Set记录已经见过的后续游标，防止循环分页。
		const cursors = new Set<string>();
		// 首轮cursor为undefined，之后由nextCursor更新。
		let cursor: string | undefined;
		// for从0计数，最多执行1000轮；第1000页若无下一游标仍可正常返回。
		for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber++) {
			// 串行等这一页完成，不并行预取其他页。
			const page = await this.listPage(method, key, isItem, cursor, options);
			// 把本页项目按顺序展开追加，项目对象本身不复制；随后若游标异常这些局部累计值不会返回。
			items.push(...page.items);
			// 游标已规范为undefined代表结束，直接返回累计数组。
			if (page.nextCursor === undefined) return items;
			// 若后续游标已经出现，下一行抛错；不是按项目name查重。
			if (cursors.has(page.nextCursor))
				// 生成带方法名/重复游标的错误，停止取页。
				throw new Error(`MCP ${method} returned duplicate cursor: ${page.nextCursor}`);
			// 记录新游标以供后续重复检查。
			cursors.add(page.nextCursor);
			// 更新下一轮请求参数，let允许重新赋值。
			cursor = page.nextCursor;
		}
		// 用完页数仍有下一页则拒绝，不截断成看似完整的列表。
		throw new Error(`MCP ${method} exceeded ${MAX_LIST_PAGES} pages`);
	}

	// 调用远端工具并返回浅查后的结果；例：callTool("count",{n:3},{signal})。实际工具可能有副作用，客户端不在此自动重试或按input/output schema校验；协议错误拒绝，但结果isError:true仍可能正常兑现。
	async callTool(
		// 服务器工具的原始name，不是宿主展示名或命名空间别名。
		name: string,
		// 可选参数对象，undefined时省略arguments键，空对象会明确发送。
		args?: Record<string, unknown>,
		// 单次取消/等待/进度配置，缺省用{}。
		options: McpRequestOptions = {},
		// Promise<CallToolResult>是调用方看到的类型，不意味着所有内容块都深验过。
	): Promise<CallToolResult> {
		// 请求成功后仅执行validateCallToolResult的对象/数组层检查。
		return validateCallToolResult(
			// 组装{name,arguments?}后发送tools/call；有args才展开arguments，不执行参数schema。
			await this.request("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) }, options),
		);
	}

	// 主动关闭：先摘传输/退订，再拒绝等待并标closed，最后等传输close；无参数，返回Promise<void>。例：await client.close()后普通请求拒绝。
	// 第二次close没有旧传输可等，不共享首次关闭Promise；元数据/用户监听器不清空。退订/回调/关闭若抛错可使本方法拒绝，并可能阻断后续清理。
	async close(): Promise<void> {
		// 局部保留原传输，供稍后关闭；其他调用随后只看到字段已摘除。
		const transport = this.transport;
		// 立即清this.transport，防止新请求继续通过requireTransport。
		this.transport = undefined;
		// 执行传输事件退订，主动close时不再重复处理其关闭事件。
		this.disposeTransportListeners();
		// 标记关闭、结算pending、给incoming发abort，并通知关闭监听器。
		this.markClosed(new McpConnectionClosedError());
		// 有传输才await close，实际子进程/HTTP释放由传输负责；失败会向调用者传播，不自动重试。
		await transport?.close();
	}

	// 内部请求通路：检查连接/取消，建id与进度参数，登记Promise回调/监听/计时器，调用send，等响应或失败结算；输入方法/参数/选项与连接期许可。例：initialize用true，公开request用false。
	// 实际I/O由传输负责；本地取消/超时只结束等待并尝试通知，不证明远端工作停止。返回unknown，调用方泛型或helper才决定如何解释。
	private async requestInternal(
		// 协议方法名，也用于区分initialize不可向远端发送取消通知的规则。
		method: string,
		// 参数位置必需但值可undefined，对应不携带params的请求。
		params: Record<string, unknown> | undefined,
		// 单次请求的signal、timeoutMs及进度回调。
		options: McpRequestOptions,
		// 是否允许在connecting期间发内部握手；不是跳过连接检查。
		allowConnecting: boolean,
		// 返回Promise等待任意业务结果或拒绝原因。
	): Promise<unknown> {
		// 先按当前状态取得传输，失败立即使本async请求拒绝。
		const transport = this.requireTransport(allowConnecting);
		// 信号已取消就直接拒绝，尚不分配id或登记pending；异常文字使用默认值而非这里读取reason。
		if (options.signal?.aborted) throw new McpAbortError();
		// 后置++先取当前值作id再把计数加1，即首个请求id=1。
		const id = this.nextRequestId++;
		// 有进度回调才采用id作令牌，没有则undefined。
		const progressToken = options.onProgress ? id : undefined;
		// 接下来条件选择实际要发送的参数对象。
		const requestParams =
			// 没有令牌时走第一支，不需要添加_meta。
			progressToken === undefined
				? // 直接复用原params，不另浅复制。
					params
				: // 有令牌则浅复制params与合格的_meta对象，并写progressToken覆盖同名旧键；?._meta安全处理params缺省，非对象_meta被丢弃，不改原顶层对象。
					{ ...params, _meta: { ...(isObject(params?._meta) ? params._meta : {}), progressToken } };
		// 创建JSON-RPC请求对象，类型注解只供TS检查这些字段。
		const message: JsonRpcRequest = {
			// 固定协议标识。
			jsonrpc: "2.0",
			// 对象属性简写id等于id:id。
			id,
			// 方法名称也用属性简写。
			method,
			// 实际参数undefined则省略params键，其他情况加入整理后的参数对象。
			...(requestParams === undefined ? {} : { params: requestParams }),
		};
		// new Promise执行器会立即运行，resolve/reject保存在记录中，真正结算等后续响应/取消/超时；unknown是兑现值类型。
		return new Promise<unknown>((resolve, reject) => {
			// 为这一个请求创建等待记录。
			const entry: PendingRequest = {
				// 保存Promise兑现回调。
				resolve,
				// 保存Promise拒绝回调。
				reject,
				// ??依次选择单次时长、客户端时长、30000ms；0/负值不会被当缺省，后续会禁用计时器。
				timeoutMs: options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
				// 计时器尚未设置，armTimeout稍后负责创建。
				timer: undefined,
				// 保留调用方signal用于注册/清理监听。
				signal: options.signal,
				// The spec forbids cancelling `initialize`.
				// 箭头函数在未来abort时调用取消流程，不是构造记录时立刻取消。
				onAbort: () =>
					// 把本地拒绝和可选远端取消通知交给共用cancelPending。
					this.cancelPending(
						// 以id找到当前等待记录。
						id,
						// 本地拒绝原因是新McpAbortError，不直接使用signal.reason作为拒绝值。
						new McpAbortError(),
						// 只有方法不为initialize才允许远端取消通知；本地拒绝本身仍执行。
						method !== "initialize",
						// 取消通知的原因把signal.reason转String，null/undefined时用Aborted；对象自定义转换仍可能抛错。
						String(options.signal?.reason ?? "Aborted"),
					),
				// 单独控制传输send/重试的内部信号，与调用方signal不同；请求结算时统一abort它。
				sendController: new AbortController(),
				// 记录本方法是否允许远端取消，供超时分支复用。
				cancellable: method !== "initialize",
				// 保存用户进度回调，不立即调用。
				onProgress: options.onProgress,
				// 保存用于查进度路由的令牌。
				progressToken,
			};
			// 先存pending再发送，响应到来便能按id找到Promise。
			this.pending.set(id, entry);
			// 有令牌才建立progressToken到id的反向索引。
			if (progressToken !== undefined) this.progressRequests.set(progressToken, id);
			// signal存在才装一次性abort监听；正常响应等结算也会主动移除它，不只依赖once。
			options.signal?.addEventListener("abort", entry.onAbort, { once: true });
			// 按选定时长开始本地等待计时，进度到来可再重置。
			this.armTimeout(id, entry);
			// 使用已取得的传输，下面是同一个链式调用。
			transport
				// 发送时附内部signal，要求支持该选项的传输在结算后别再派发尚未发出的请求；已发送副作用不能因此撤销。
				.send(message, { signal: entry.sendController.signal })
				// 发送Promise拒绝时取消本地等待，false不再另向服务器发取消通知；原发送错误作为拒绝原因保留。
				.catch((error) => this.cancelPending(id, error, false));
		});
	}

	// 内部通知通路：检查连接并发送无id消息，输入方法/参数/是否许可connecting，返回Promise<void>。例：握手通知传true。没有pending或协议结果等待，发送失败仍拒绝。
	private async notifyInternal(
		// 通知方法名。
		method: string,
		// 显式允许undefined的参数位置，缺省时不加params。
		params: Record<string, unknown> | undefined,
		// 只为内部握手开放connecting许可，普通notify传false。
		allowConnecting: boolean,
		// async使连接检查抛错或send拒绝成为返回Promise的拒绝。
	): Promise<void> {
		// 先取传输再发消息，await只等send，不等对方执行完成的JSON-RPC响应。
		await this.requireTransport(allowConnecting).send({
			// 固定JSON-RPC版本。
			jsonrpc: "2.0",
			// 方法名字段，此对象刻意没有id。
			method,
			// 有参数才展开params键，undefined时完全省略。
			...(params === undefined ? {} : { params }),
		});
	}

	// 取得当前允许使用的传输，否则抛McpConnectionClosedError；输入连接期许可，返回原传输引用。例：connecting加false会失败，不会自行等待握手结束或重连。
	private requireTransport(allowConnecting: boolean): McpTransport {
		// 传输须存在，且状态为connected或被明确允许的connecting；仅state像在线但传输缺失也不通过。
		if (this.transport && (this.state === "connected" || (allowConnecting && this.state === "connecting"))) {
			// 返回保存在实例上的同一传输，不新建连接。
			return this.transport;
		}
		// 错误说明包含当前本地state；idle/connecting也可能使用该异常类型，不只closed。
		throw new McpConnectionClosedError(`MCP client is ${this.state}`);
	}

	// 按响应→请求→通知分发一条消息；输入JsonRpcMessage，正常无返回值，副作用交给各处理器。例：id/result配对pending，而无id的method走通知。
	// 仍用运行时guard，因为消息来自传输；形状可重叠，优先顺序决定归属。监听器异常可逸出，void反向处理器也不代表其Promise已被捕获。
	private handleMessage(message: JsonRpcMessage): void {
		// 优先检查响应骨架，带method的混合响应也可能先走此分支。
		if (isJsonRpcResponse(message)) {
			// 同步处理响应，结算对应的本地请求。
			this.handleResponse(message);
			// 这一条消息处理完就返回，不继续其他分支。
			return;
		}
		// 不是响应时再查带id的反向请求。
		if (isJsonRpcRequest(message)) {
			// 启动async处理但不await；内部多数业务错误会转成响应，仍可能有错误通道抛错等导致拒绝，void不会自动catch。
			void this.handleRequest(message);
			// 启动处理后立即结束本次消息回调，不阻塞其他消息等待该处理器。
			return;
		}
		// 最后检查无id通知形状。
		if (isJsonRpcNotification(message)) {
			// 将名称与未知params交给内置进度/取消及用户通知监听器。
			this.handleNotification(message.method, message.params);
			// 通知分发完成后返回。
			return;
		}
		// 没有通过任何guard则报告invalidRequest错误，不主动关闭或给未知消息回包。
		this.emitError(new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Received invalid JSON-RPC message"));
	}

	// 处理一份响应：用id查pending，移除资源后兑现result或拒绝协议error；例：id=2只结算2号等待。未知id仅报错，不把它当新请求；本函数不深验业务结果。
	private handleResponse(message: JsonRpcResponse): void {
		// Map用原始字符串/数字值匹配，数字1和字符串"1"是不同键。
		const entry = this.pending.get(message.id);
		// 找不到记录可能是超时/取消后的迟到响应，或服务器给了不存在的id。
		if (!entry) {
			// 通过错误通道报告未知请求，不重建pending或重放工具；错误监听器可抛错。
			this.emitError(new Error(`Received response for unknown MCP request ${String(message.id)}`));
			// 没有等待者时停止处理这条响应。
			return;
		}
		// 先清计时器/索引/监听并abort内部send信号，再结算Promise。
		this.removePending(message.id, entry);
		// error分支包装McpError以保留code/message/data；in判别也会看到继承键，与协议guard规则一致。
		if ("error" in message) entry.reject(new McpError(message.error.code, message.error.message, message.error.data));
		// 否则用result兑现Promise，保留原业务值引用，unknown不作转换。
		else entry.resolve(message.result);
	}

	// 处理服务器发来的带id请求：查注册方法，缺方法回-32601，有方法则创建signal、await处理并回复，失败尽量转error，finally移除incoming。例：默认roots/list返回声明的根列表。
	// 取消只给处理器发signal，不强制停止函数或禁止晚回复；本方法可能因异常规范化/错误监听器/传输等拒绝，而调用处void并未统一catch。这里也没拒绝服务端重复id。
	private async handleRequest(message: JsonRpcRequest): Promise<void> {
		// 先捕获当前传输引用，await期间实例可能关闭，但本次回复仍使用该旧引用。
		const transport = this.transport;
		// 没有传输就忽略请求，不新建连接或排队等connect。
		if (!transport) return;
		// 按方法名取唯一处理器，默认含ping和可选roots/list。
		const handler = this.requestHandlers.get(message.method);
		// 找不到方法时无需创建incoming记录，直接回协议错误。
		if (!handler) {
			// 等待错误响应发送，以便下面catch报告发送失败。
			await transport
				// 调用同一个传输send构造响应。
				.send({
					// 固定协议版本字段。
					jsonrpc: "2.0",
					// 把服务器请求的id原样带回，不使用本地主动请求计数器。
					id: message.id,
					// 错误码methodNotFound，说明文字包含未注册的方法名。
					error: { code: JSON_RPC_ERROR_CODES.methodNotFound, message: `Method not found: ${message.method}` },
				})
				// 发送拒绝交给错误通道；错误监听器再抛错仍可能让本方法拒绝。
				.catch((error) => this.emitError(error));
			// 缺方法响应尝试结束便返回，不执行后面的业务处理。
			return;
		}
		// 每次反向调用创建独立AbortController，让取消通知可以协作传给业务函数。
		const controller = new AbortController();
		// 以服务器id登记控制器；相同id再次到来会覆盖映射，没有在这里做重复id防护。
		this.incoming.set(message.id, controller);
		// try同时包围处理器执行和成功响应发送，二者失败都会进入catch。
		try {
			// 给handler传未知params和signal，await兼容普通值与Promise；signal不会自动中断它。
			const result = await handler(message.params, { signal: controller.signal });
			// 发送成功响应，null/undefined结果用{}替代，false/0/空串保留；不验证结果可JSON编码，发送失败也会进入catch。
			await transport.send({ jsonrpc: "2.0", id: message.id, result: result ?? {} });
			// 捕获业务执行或发送成功响应的错误，尝试生成一份错误响应。
		} catch (error) {
			// 下面条件表达式决定错误数据的code/message/data。
			const responseError =
				// 已是McpError则保留其协议字段，而不是统一改成内部错误。
				error instanceof McpError
					? // 直接取三项字段，data可能undefined。
						{ code: error.code, message: error.message, data: error.data }
					: // 其他抛出值先toError取message，使用internalError码；自定义字符串转换若抛错则这一规范化也会失败。
						{ code: JSON_RPC_ERROR_CODES.internalError, message: toError(error).message };
			// 尝试发送错误响应，不代表原业务副作用已回滚。
			await transport
				// 保留原id并把组装好的错误数据置于error键。
				.send({ jsonrpc: "2.0", id: message.id, error: responseError })
				// 错误回包的发送拒绝转错误通道，不继续重试；监听器抛错仍可传播为本async方法拒绝。
				.catch((sendError) => this.emitError(sendError));
			// finally无论上述try/catch正常返回或抛错都会执行，负责清理登记。
		} finally {
			// 删除当前id的incoming映射；正常唯一id情况下释放控制器索引，不是等待业务外所有后台操作完成。
			this.incoming.delete(message.id);
		}
	}

	// 分发一条通知：先处理内置进度/取消，再按名称调用用户监听；输入method/未知params，无返回值。例：progress会先续时再让用户同名订阅收到原参数。
	// 同步监听异常转错误通道，async返回值不等待，错误监听器自身异常仍可逸出；内置处理失败也可能阻止后续分发。
	private handleNotification(method: string, params: unknown): void {
		// 进度名称命中时先执行令牌关联、续时及onProgress。
		if (method === "notifications/progress") this.handleProgress(params);
		// 否则若为取消通知，就给对应本地反向请求的controller发abort。
		else if (method === "notifications/cancelled") this.handleCancelled(params);
		// 取该名称的Set，无订阅则用空数组遍历；这是活集合遍历，不做快照。
		for (const listener of this.notificationListeners.get(method) ?? []) {
			// 捕获单个通知回调的同步错误，尽量不让一个普通回调中断其他订阅。
			try {
				// 把原params直接传给用户，没有深复制或方法专属schema检查。
				listener(params);
				// 只捕获同步throw，不捕获async回调返回Promise的拒绝。
			} catch (error) {
				// 转报本地错误；此通道没有再包try/catch，错误监听器若抛可中断循环。
				this.emitError(error);
			}
		}
	}

	// 关联进度并重设等待窗口，再调用对应onProgress；输入未知params，无返回值，无效/迟到令牌忽略。例：50ms窗口在40ms收到关联进度后从此重算50ms，不保证总耗时≤50ms。
	// 只查对象、有效编号令牌和number进度，未验total/message或进度单调/有限；回调同步异常转错误通道，不因此直接拒绝请求。
	private handleProgress(params: unknown): void {
		// 用局部guard检查外部通知骨架；progress为NaN/Infinity仍满足typeof number，缺少回调令牌的请求也不会匹配。
		if (!isObject(params) || !isJsonRpcId(params.progressToken) || typeof params.progress !== "number") return;
		// 从progressToken查本地主动请求id，不按业务工具名关联。
		const requestId = this.progressRequests.get(params.progressToken);
		// 没有id则不查pending，否则取对应等待记录；条件运算符保持类型明确。
		const entry = requestId === undefined ? undefined : this.pending.get(requestId);
		// 未知令牌或已结算请求直接忽略，不再建计时器或调用回调。
		if (requestId === undefined || !entry) return;
		// 先清旧计时器并重新开始同一等待窗口，持续进度可反复续时，未设置总期限。
		this.armTimeout(requestId, entry);
		// 只在用户进度回调周围捕获同步异常。
		try {
			// 可选调用原回调；as unknown as ProgressNotification只改变TS视图，没有补验total/message，原params引用仍可能带额外字段。
			entry.onProgress?.(params as unknown as ProgressNotification);
			// 捕获回调同步抛出的值，不等待其返回Promise。
		} catch (error) {
			// 错误交给监听器，不主动把该请求判失败。
			this.emitError(error);
		}
	}

	// 处理远端取消通知，按requestId给本地incoming发abort；例：服务端取消id:"roots"会通知对应处理器。无记录则忽略，不停止本地主动pending或强制杀业务。
	private handleCancelled(params: unknown): void {
		// 只检查对象与有效请求id，?.表示无对应控制器时跳过；reason原样传给abort，不验证为string。
		if (isObject(params) && isJsonRpcId(params.requestId)) this.incoming.get(params.requestId)?.abort(params.reason);
	}

	// 为等待记录开始/重置超时计时器；输入id及记录，无返回值，副作用是清旧timer/设新timer。例：timeoutMs=0禁用，50则稍后调用cancelPending。
	// 这是本地等待窗口，不是远端执行限额；Node计时精度/32位延时边界仍由宿主计时器决定，这里没钳制超大正数。
	private armTimeout(id: JsonRpcId, entry: PendingRequest): void {
		// 已有timer先clearTimeout，进度续时时不会让旧timer继续正常到期。
		if (entry.timer) clearTimeout(entry.timer);
		// 非有限或≤0值不创建新计时器；NaN/Infinity在此禁用，而非回退默认30000ms。
		if (!Number.isFinite(entry.timeoutMs) || entry.timeoutMs <= 0) return;
		// 设置定时回调并保存句柄；没有unref，等待中的此timer可维持Node进程存活。
		entry.timer = setTimeout(() => {
			// 到期时用McpTimeoutError拒绝请求，并按cancellable决定是否发远端取消通知，initialize只本地拒绝。
			this.cancelPending(id, new McpTimeoutError(entry.timeoutMs), entry.cancellable, "Request timed out");
			// 传入原timeoutMs毫秒；Node对超大/小数延时的处理并未在这里覆盖。
		}, entry.timeoutMs);
	}

	// 结束某个本地主动请求的等待：取记录，清理资源，拒绝Promise，按需发送取消通知；输入id/拒绝原因/通知开关/可选说明，无返回值。例：abort触发它后迟到响应会作为未知id报告。
	// 通知是尽力发送且不await，不保证远端收到或停止；发送失败走错误通道，不恢复原等待。
	private cancelPending(id: JsonRpcId, error: unknown, notifyServer: boolean, reason?: string): void {
		// 先按id找pending；不同结算来源可能先后到达同一请求。
		const entry = this.pending.get(id);
		// 已经结算/不存在便返回，避免再次清理或发同一取消通知。
		if (!entry) return;
		// 移除pending及进度索引、计时器、abort监听，同时abort内部send信号。
		this.removePending(id, entry);
		// 用传入的原错误值拒绝请求，没有在这里统一包成McpError。
		entry.reject(error);
		// 仅允许通知且传输引用仍在时发送；不在这里重新检查state或建立新连接。
		if (notifyServer && this.transport) {
			// void不等待取消通知完成，调用者不受这次发送的往返延迟控制。
			void this.transport
				// 发送一条无顶层id的通知，原请求编号放在下面的params.requestId中。
				.send({
					// 固定JSON-RPC版本。
					jsonrpc: "2.0",
					// 固定取消通知方法名。
					method: "notifications/cancelled",
					// params里的requestId关联原请求；reason只有真值才加字段，空串被省略。
					params: { requestId: id, ...(reason ? { reason } : {}) },
				})
				// 取消通知发送拒绝转报错误通道，不改变已经拒绝的请求结果。
				.catch((sendError) => this.emitError(sendError));
		}
	}

	// 释放一条等待记录的本地资源，输入id/原entry，无返回值；响应、取消、关闭共用。例：响应到达后其进度令牌也失效。它不自行resolve/reject或发远端取消通知。
	private removePending(id: JsonRpcId, entry: PendingRequest): void {
		// 先从pending删id，后续重复响应不再找到等待者。
		this.pending.delete(id);
		// 若曾设置计时器就取消，字段不在这里重设undefined。
		if (entry.timer) clearTimeout(entry.timer);
		// 有进度令牌才删其反查索引，不能依赖真值判断，因为数字0也是允许的编号。
		if (entry.progressToken !== undefined) this.progressRequests.delete(entry.progressToken);
		// 用保存的同一函数引用移除调用方abort监听；signal缺省就跳过。
		entry.signal?.removeEventListener("abort", entry.onAbort);
		// abort内部发送控制器，支持该signal的传输应停止尚未派发/重试动作，已经执行的远端操作不回滚。
		entry.sendController.abort();
	}

	// 批量拒绝所有pending请求，输入共同原因，无返回值；关闭路径用它。例：两个等待请求一起收到连接关闭错误，逐条释放资源，不等待它们远端工作完成。
	private rejectPending(error: unknown): void {
		// for...of解构Map中的[id,entry]；循环里删除当前项仍可继续处理后续项。
		for (const [id, entry] of this.pending) {
			// 每条记录先按共用流程清理计时/索引/监听。
			this.removePending(id, entry);
			// 再用同一error值拒绝其Promise，不创建每请求新异常。
			entry.reject(error);
		}
	}

	// 响应传输close事件，无参数/返回；构造连接关闭错误并转markClosed。不在此摘传输/退订或重连，这与主动close的完整清理入口不同。
	private handleTransportClose(): void {
		// 把本次关闭原因交给统一状态/等待清理逻辑。
		this.markClosed(new McpConnectionClosedError());
	}

	/** Idempotent: rejects in-flight requests, aborts server requests we are serving, and flips the state. */
	// 标记关闭并清理协议等待：输入Error，写closed、拒绝pending、给incoming发abort、清其索引，首次状态转换再通知关闭回调。例：传输关闭后再主动close通常不重复通知。
	// 不清握手元数据/用户监听器，也不自动调用transport.close；不强制终止忽略signal的处理器。错误通道监听器抛错仍可中断关闭通知循环。
	private markClosed(error: Error): void {
		// 先记住旧state是否已经closed，供后面的重复通知抑制使用。
		const wasClosed = this.state === "closed";
		// 无论旧状态如何都写closed；没有把实例恢复idle供重连。
		this.state = "closed";
		// 让所有本地主动等待用此次error拒绝，并清理其timer/监听。
		this.rejectPending(error);
		// 给所有服务器反向调用的signal发abort，reason用同一个错误；这只是协作通知，不await处理器退出。
		for (const controller of this.incoming.values()) controller.abort(error);
		// 清掉控制器索引，不代表这些async业务函数已完成；迟到回调仍可能使用捕获的旧传输回复。
		this.incoming.clear();
		// 旧状态已经closed则不再次通知用户关闭回调，前面清理仍执行。
		if (wasClosed) return;
		// 复制关闭回调为数组快照，迭代期间新增/移除不会改变这份名单；已closed后新增也不会在这里补发。
		for (const listener of [...this.closeListeners]) {
			// 捕获单个关闭回调同步抛错，正常情况下继续下一个。
			try {
				// 无参数调用关闭监听器，不传error。
				listener();
				// 同步回调失败转到错误通道，async返回Promise仍不等待。
			} catch (listenerError) {
				// 若错误监听器自身抛错则会逸出本循环，不能保证剩余关闭监听器都执行。
				this.emitError(listenerError);
			}
		}
	}

	// 把未知错误规范成Error后同步报告所有错误监听器，无返回值；例：emitError("bad")让回调收到message为bad的Error。无监听器就不报告，不自动关闭或拒绝pending。
	// 没有包try/catch；toError字符串转换或某个监听器抛错都可能传播并阻断后续回调。
	private emitError(error: unknown): void {
		// 已有Error原样保留，其他值尝试String后创建Error，不做脱敏或结构化数据提取。
		const normalized = toError(error);
		// 直接遍历活Set逐个调用；并非快照，也不await异步回调返回值。
		for (const listener of this.errorListeners) listener(normalized);
	}

	// 清理传输的事件订阅，无参数/返回；例：主动close先调用它。splice取出并清空退订数组，再执行每个函数；不清用户订阅，退订器抛错可阻止后面的执行。
	private disposeTransportListeners(): void {
		// splice(0)先移走全部记录形成新数组，然后for...of逐个退订；即使中途抛错，原disposers也已经为空。
		for (const dispose of this.disposers.splice(0)) dispose();
	}
}
