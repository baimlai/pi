// 定义MCP使用的JSON-RPC消息形状、局部识别规则与错误对象。stdio/HTTP先解码JSON再调用本文件；McpClient用这些规则分发消息、关联请求与响应。
// 这些interface/type只参与TypeScript检查，不会在运行时过滤字段；下方guard才会执行检查，但也不是完整协议schema验证。
// export把别名提供给其他模块；string | number是联合类型。这里只描述ID的类型，实际入口isJsonRpcId还会拒绝非有限数字与null。
export type JsonRpcId = string | number;

// 带id的请求，需要对方用同一个id答复；例：{jsonrpc:"2.0",id:1,method:"ping"}。interface描述对象字段，不会创建对象。
export interface JsonRpcRequest {
	// 字面量类型要求此处写精确的"2.0"，并非任意string。
	jsonrpc: "2.0";
	// 调用编号把请求和结果配对；字段类型复用上面的JsonRpcId。
	id: JsonRpcId;
	// 要调用的方法名，例如tools/call；这里只要求字符串，不枚举可用方法。
	method: string;
	// ?表示字段可省略；unknown允许各种值，但读取其内部属性前应先缩小类型。这里没有限制params一定为对象或数组。
	params?: unknown;
}

// 通知只有方法和参数，按此消息形式不携带请求编号。TS结构类型本身不保证对象绝无额外id，实际识别时会用in检查。
export interface JsonRpcNotification {
	// 通知使用同样的协议版本字面量。
	jsonrpc: "2.0";
	// 通知名，例如notifications/initialized；是否支持它由调用方决定。
	method: string;
	// 可选通知数据；unknown不等于已经验证过其业务结构。
	params?: unknown;
}

// 协议错误载荷，用于响应中的error；它是数据对象，区别于下面继承Error的本地异常类。
export interface JsonRpcErrorObject {
	// 数字错误码；number在TS层面也包含NaN/Infinity，下面响应guard没有另作有限或整数校验。
	code: number;
	// 供调用方显示的错误说明文字。
	message: string;
	// 服务器可附额外信息，例如{retryable:false}；这里不限定结构，也不自动转换为Error.cause。
	data?: unknown;
}

// 成功响应携带result；例：{jsonrpc:"2.0",id:1,result:{ok:true}}。它仍须用请求ID找到等待者。
export interface JsonRpcSuccessResponse {
	// 固定JSON-RPC版本标签。
	jsonrpc: "2.0";
	// 回复哪一次请求；本地类型不包含某些JSON-RPC错误消息使用的null编号。
	id: JsonRpcId;
	// result字段必须存在，但值的TS类型unknown包含undefined；是否符合某个MCP方法的结果格式由上层另查。
	result: unknown;
}

// 失败响应携带error对象；例如id:1配上code:-32601，说明该请求的方法未找到。
export interface JsonRpcErrorResponse {
	// 错误响应也使用同一个协议版本。
	jsonrpc: "2.0";
	// 错误所属请求编号；不是错误码。
	id: JsonRpcId;
	// 嵌套错误数据，其code/message/data形状来自上面的接口。
	error: JsonRpcErrorObject;
}

// A | B表示响应可以采用成功或失败形状；这些结构类型没有禁止额外字段，不能只凭类型宣称分支完全互斥。
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
// 任一消息可以是请求、通知或响应；实际分发顺序很重要，McpClient.handleMessage先判响应、再判请求、最后通知。
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// 集中命名常用错误码，调用处可写JSON_RPC_ERROR_CODES.invalidRequest，避免直接散落数字。这里只创建对象，不抛错误。
export const JSON_RPC_ERROR_CODES = {
	// 表示JSON文本解析失败的常见编号；本文件parseJsonRpcMessage不负责JSON.parse，也不在失败时使用这一项。
	parseError: -32700,
	// 解码后的值不符合本地消息规则时使用的编号。
	invalidRequest: -32600,
	// 找不到请求的方法；客户端处理未注册的服务器反向请求时会使用它。
	methodNotFound: -32601,
	// 方法参数不合法的错误码；定义这个值并不代表这里执行参数schema检查。
	invalidParams: -32602,
	// 处理方法时出现内部错误的编号，例如上层捕获普通Error后生成响应。
	internalError: -32603,
	// as const把属性推导为只读的具体数字字面量；它是类型断言，不会执行Object.freeze。
} as const;

// 保存协议错误码和附加数据的本地异常；既可表示本地消息校验失败，也可由McpClient把远端error响应转换为等待请求的拒绝原因。
export class McpError extends Error {
	// readonly限制正常TS代码再次赋值code，不会在JS运行时把字段变成不可写。
	readonly code: number;
	// 附加值原样保存，unknown要求使用者自行判断结构；没有深复制或冻结。
	readonly data: unknown;

	// 构造协议异常：输入code/message和可选data，返回新实例；只初始化字段，不发送消息也不自行throw。例：new McpError(1234,"tool failed",{retryable:false})。
	constructor(code: number, message: string, data?: unknown) {
		// super调用父类Error构造器保存message；派生类使用this前必须先完成它。
		super(message);
		// 设置错误展示用的name；instanceof McpError检查的则是原型链。
		this.name = "McpError";
		// 把参数code存进当前实例，便于catch后按数字判断。
		this.code = code;
		// 保存原data引用；参数缺省时这里得到undefined，仍会执行字段赋值。
		this.data = data;
	}
}

// 表示连接当前不可用或已关闭的异常；关闭传输和拒绝pending请求是调用方负责的动作，不是这个类的副作用。
export class McpConnectionClosedError extends Error {
	// 接收可覆盖的说明，缺省时用给定英文文字；例：new McpConnectionClosedError("MCP client is idle")。返回异常实例，本身不关闭连接。
	constructor(message = "MCP connection closed") {
		// 用父类初始化message及Error自身信息。
		super(message);
		// 设置类对应的错误名，方便日志辨认。
		this.name = "McpConnectionClosedError";
	}
}

// 描述请求等待超时的异常。它只记录时长，McpClient.armTimeout才负责创建计时器和取消等待。
export class McpTimeoutError extends Error {
	// 记录超时毫秒数；readonly只作TS写入限制，没有检查数值是否大于0。
	readonly timeoutMs: number;

	// 输入timeoutMs并构造异常，不启动计时器；例：new McpTimeoutError(500)的说明包含500ms。参数类型number不保证有限或正数。
	constructor(timeoutMs: number) {
		// 模板字符串把毫秒值插入英文说明，再传给Error；此处的ms只是单位文字。
		super(`MCP request timed out after ${timeoutMs}ms`);
		// 日志中的错误名设为McpTimeoutError。
		this.name = "McpTimeoutError";
		// 把毫秒值保留给调用者检查；构造时不会取整或转换单位。
		this.timeoutMs = timeoutMs;
	}
}

// 表示请求被取消的异常；实际监听AbortSignal和停止等待由客户端完成，创建实例不会触发abort。
export class McpAbortError extends Error {
	// 接收可选说明并返回实例；例：new McpAbortError("stop")。省略或传undefined才采用默认英文文字，空串会保留。
	constructor(message = "MCP request aborted") {
		// 把取消原因文字交给Error保存。
		super(message);
		// name有意使用常见的AbortError；对象仍是McpAbortError实例，并不因此成为DOMException。
		this.name = "AbortError";
	}
}

// 把未知值缩小为非null、非数组的对象，供外部消息边界检查使用；例：{}为true，[]和null为false。无主动修改，不要求普通对象，Date/类实例也可能为true。
// value is Record<string, unknown>是类型谓词：返回true后TS允许按字符串键读取unknown值；它不说明每个键都实际存在，也不保证键是自有属性。
export function isObject(value: unknown): value is Record<string, unknown> {
	// &&短路依次排除基本类型、null和数组；typeof null也是object，所以必须单独排除。Proxy等特殊对象仍可能在后续读属性时抛异常。
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 统一待报告的异常值：Error实例原样返回，其他值先转成字符串再包装。例：toError("bad").message为"bad"；不复制原Error，也不把普通对象的字段提取为cause。
// instanceof依赖当前Error原型链；自定义String转换可能自己抛错，所以这不是对任意JS值都绝不抛错的包装器。
export function toError(value: unknown): Error {
	// 条件运算符按instanceof选择原值或new Error；String(value)能处理undefined、数字等，但对象可能运行自定义转换逻辑。
	return value instanceof Error ? value : new Error(String(value));
}

// 识别本地允许的请求编号并返回布尔值，同时为TS缩小类型；例：""、-1、1.5可通过，null、NaN和Infinity不能。无修改，也不限制安全整数或非空字符串。
export function isJsonRpcId(value: unknown): value is JsonRpcId {
	// 字符串直接通过；数字还须Number.isFinite，&&把该检查限制在number分支，避免隐式把字符串转数字。
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

// 判断未知值是否符合本地请求骨架；例：{jsonrpc:"2.0",id:1,method:"ping"}为true。只查对象/版本/编号/方法，不查params或额外字段，不复制输入。
// 读取属性可能访问继承值或getter；带method和result的混合对象也可能同时通过请求与响应guard，不能把true理解为完整协议认证。
export function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
	// 多行return用括号包住一个布尔表达式；这里返回检查结果，不创建JsonRpcRequest实例。
	return (
		// 按顺序短路：先保证可读属性，再核对版本、有限编号和字符串方法名；空方法字符串也会通过这条规则。
		isObject(message) && message.jsonrpc === "2.0" && isJsonRpcId(message.id) && typeof message.method === "string"
	);
}

// 判断无id的通知骨架；例：{jsonrpc:"2.0",method:"ping"}为true，额外id:undefined也会使它失败。无修改，不验证params内容，属性getter/Proxy仍可抛错。
export function isJsonRpcNotification(message: unknown): message is JsonRpcNotification {
	// !("id" in message)检查整个原型链是否存在id，不等同message.id===undefined，也不局限自有键；其余&&核对版本和方法类型。
	return isObject(message) && message.jsonrpc === "2.0" && !("id" in message) && typeof message.method === "string";
}

// 识别成功/失败响应并返回布尔值；例：id:1配result:null可通过，result和error同时存在则失败。这里只验证响应骨架，不检查result业务schema或error.data。
// 检查会访问属性与原型链；getter/Proxy可抛错。失败分支的code只要求number，与上面编号的有限数规则不同。
export function isJsonRpcResponse(message: unknown): message is JsonRpcResponse {
	// 非对象、版本不匹配或编号不合规则立即false；||遇到首个真值就停止，避免对普通非对象继续读字段。
	if (!isObject(message) || message.jsonrpc !== "2.0" || !isJsonRpcId(message.id)) return false;
	// 只要有result键就走成功分支，值可以undefined；同时存在error键便false。in也会看到继承键，返回前不检查method等额外字段。
	if ("result" in message) return !("error" in message);
	// 没有result时必须有非null且非数组的error对象；错误字段缺失或结构不符合就false。
	if (!("error" in message) || !isObject(message.error)) return false;
	// 只查code数字和message字符串；不限定整数/有限数字，因此直接传JS对象时NaN也可能通过，不代表它可原样编码为JSON数字。
	return typeof message.error.code === "number" && typeof message.error.message === "string";
}

// 接收已经解码的未知值，依次调用三个guard，通过便返回同一个对象，否则抛McpError(-32600)。例：传{jsonrpc:"2.0",id:1,result:0}可通过，传该对象的JSON字符串不行。
// 函数名中的parse不是JSON.parse：stdio/SSE调用方先解码文本，HTTP的数组响应由调用方拆项；这里不支持直接传一整个批量数组，也不做克隆、清洗或深校验。
export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
	// ||短路依次试请求、通知、响应，任一通过直接返回原引用；此顺序并不改变McpClient分发时优先判响应的规则。
	if (isJsonRpcRequest(value) || isJsonRpcNotification(value) || isJsonRpcResponse(value)) return value;
	// 全部失败则throw新异常，使用invalidRequest而非parseError；调用方需catch或把异常交给自己的错误通道。
	throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid JSON-RPC message");
}
