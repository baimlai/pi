// 描述MCP握手、能力、工具、资源与通知的数据形状，供McpClient和上层适配器共用。interface/type只参与TS检查，运行时由client.ts里的各个局部校验器决定检查哪些字段。
// import type仅导入类型，执行JS时会擦除；内容类型分别表示内嵌二进制、说明信息和文本。
import type { BlobResourceContents, ContentAnnotations, TextResourceContents } from "./content.ts";
// 复用JSON-RPC的字符串/数字请求编号类型，避免在取消消息中另造编号规则。
import type { JsonRpcId } from "./jsonrpc.ts";

// 本实现默认请求的协议版本字符串，不通过日期计算自动更新；connect仍会接受下方清单中的其他版本。
export const LATEST_PROTOCOL_VERSION = "2025-11-25";
/**
 * Versions the client accepts from a server. Servers that do not support the requested version answer
 * with their own latest one, so older versions stay accepted for servers built on older SDKs.
 */
// 本地支持版本的精确清单；as const推导为只读字面量元组，而非任意string[]，运行时并不因此冻结数组。
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05"] as const;
// typeof在这里取得变量的TS类型；[number]索引元组所有数字位置，得到几个版本字符串的联合，供配置项限制取值。
export type SupportedProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

// 一端实现的身份说明，客户端配置与服务器握手结果都会复用；例如{name:"pi",version:"1.0.0"}。
export interface Implementation {
	// 实现名称，类型为字符串；不表示已认证身份。
	name: string;
	// 实现版本文字，未要求满足某种版本号格式。
	version: string;
	// ?使可读标题可省略；客户端发送自身信息时只有title不为undefined才加此字段。
	title?: string;
}

// 客户端声明给服务器的一项根资源；例如工作目录的file URI。声明root本身不是文件权限限制或沙箱。
export interface Root {
	// 资源地址字符串；此接口不检查URI协议、路径是否存在或可访问。
	uri: string;
	// 可选显示名，省略时仍可只携带URI。
	name?: string;
}

// 客户端握手声明的能力集合；字段可省略，传入这些声明不会自动安装对应方法的处理器。
export interface ClientCapabilities {
	// 扩展能力的字符串键映射；unknown表示每一项结构仍需由扩展解释。
	experimental?: Record<string, unknown>;
	// 可选roots能力对象；内部listChanged也可省略，说明是否支持对应列表变化通知，布尔声明本身不触发发送。
	roots?: { listChanged?: boolean };
	// 模型采样相关扩展数据；核心客户端未在此实现模型调用，可由上层通过setRequestHandler处理反向请求。
	sampling?: Record<string, unknown>;
	// 信息征询相关能力数据；这里只描述配置形状，不创建UI或验证其内部配置。
	elicitation?: Record<string, unknown>;
}

// 服务器握手声明的能力；client只浅查整个capabilities是非null非数组对象，不逐项验证这些可选字段。
export interface ServerCapabilities {
	// 服务器实验能力数据，键的含义由提供者定义。
	experimental?: Record<string, unknown>;
	// 日志能力声明；有此字段不等于客户端已主动调用logging/setLevel。
	logging?: Record<string, unknown>;
	// 提示词能力及可选列表变化声明；核心接口可通过通用request/通知订阅使用，不自动抓取提示词。
	prompts?: { listChanged?: boolean };
	// 资源能力可分别声明订阅和列表变化；这些可选布尔值不会自行启动订阅。
	resources?: { subscribe?: boolean; listChanged?: boolean };
	// 工具能力及工具列表变化声明；coding-agent适配器据是否声明tools来决定初次发现工具。
	tools?: { listChanged?: boolean };
	// 补全能力相关数据；客户端的类型描述不等于已经实现完整补全业务。
	completions?: Record<string, unknown>;
}

// initialize请求的参数形状；实际connect逐字段组装该对象，发送后再等响应。
export interface InitializeParams {
	// 提出的协议版本；此处为string，具体可配置版本由SupportedProtocolVersion约束，返回版本另由清单核对。
	protocolVersion: string;
	// 客户端愿意提供的能力信息。
	capabilities: ClientCapabilities;
	// 客户端名称/版本/可选标题；只作自报身份信息。
	clientInfo: Implementation;
}

// 服务器initialize响应的业务结果，外面仍由JSON-RPC的result包裹；客户端先浅查这些主要字段再核对版本。
export interface InitializeResult {
	// 服务器选择的版本字符串；返回为string不代表一定在本地接受清单内，connect会另行检查。
	protocolVersion: string;
	// 服务器声明的能力对象；接口不验证嵌套布尔值或各子对象。
	capabilities: ServerCapabilities;
	// 服务器实现信息；client会查name/version为字符串，title等额外字段不深验。
	serverInfo: Implementation;
	// 可选服务器指引文字；仅保留字符串，是否放入模型上下文由外围使用方决定。
	instructions?: string;
}

// 某个正在等待请求的进度通知；它不是工具完成响应，也没有在此计算百分比。
export interface ProgressNotification {
	// 关联请求使用的进度令牌，可为字符串或数字；client当前发起带回调的请求时用请求id作为令牌。
	progressToken: string | number;
	// 进度数值；接口不保证有限、非负或单调，client也只检查typeof为number。
	progress: number;
	// 可选总量；不要求与progress有某个比例，客户端进度入口没有另行校验此字段。
	total?: number;
	// 可选进度说明，接口不保证来自服务器的任意JS值都已按此类型验证。
	message?: string;
}

// 取消通知的数据形状；方向很重要：服务端发来时用于通知本地incoming处理器，本地主动取消则发往服务端。
export interface CancelledNotification {
	// 要取消的请求编号，不是progressToken；与对应方向的请求Map按值匹配。
	requestId: JsonRpcId;
	// 可选取消原因文字；取消只是协作信号，不保证对方已停止执行或撤销副作用。
	reason?: string;
}

// 工具描述中的提示信息，供宿主决策或展示；Hint意味着声明，不是安全证明，客户端不据此自动实施授权或重试。
export interface ToolAnnotations {
	// 可选人类可读标题，不是实际调用使用的工具name。
	title?: string;
	// 声明工具是否只读；true不在本接口中建立文件/网络访问限制。
	readOnlyHint?: boolean;
	// 声明是否可能有破坏性副作用；这里只保留布尔元信息。
	destructiveHint?: boolean;
	// 声明重复调用是否幂等，即多次执行是否可得到与一次执行相当的效果；此声明不让client自动重放工具。
	idempotentHint?: boolean;
	// 声明是否与开放的外部世界交互；这里不按它屏蔽网络或资源。
	openWorldHint?: boolean;
}

// 工具执行方式的附加元信息；本地类型提供taskSupport描述，但核心client没有自动启动任务协议流程。
export interface ToolExecution {
	// 字面量联合限制配置文字为forbidden/optional/required三者之一；运行时接收工具定义并未逐项检查它。
	taskSupport?: "forbidden" | "optional" | "required";
}

// tools/list返回的一项工具定义；它是远端工具的描述，不是带execute函数的本地AgentTool实例。
export interface Tool {
	// 真实调用名，callTool会把它放入tools/call参数；列表校验只要求字符串，没查非空或字符集合。
	name: string;
	// 可选展示标题，便于界面显示。
	title?: string;
	// 可选工具说明，宿主可用于模型工具描述；client不清洗内容或按长度截断。
	description?: string;
	// 输入JSON Schema的数据对象；Record只描述键和值，client的isTool仅确认它是非null非数组对象，不编译schema或验证调用参数。
	inputSchema: Record<string, unknown>;
	// 可选输出schema；client不会凭此验证tools/call返回内容。
	outputSchema?: Record<string, unknown>;
	// 可选工具行为提示，仍需宿主结合实际信任和策略判断。
	annotations?: ToolAnnotations;
	// 可选任务支持元信息；字段存在不代表这个client提供任务调度实现。
	execution?: ToolExecution;
	// 工具级附加元数据，可由外部适配器保留或解释。
	_meta?: Record<string, unknown>;
}

// 一页工具列表的形状；client.listTools会自行翻页并仅返回合并后的Tool[]，并非原样返回本接口。
export interface ListToolsResult {
	// 这一页的工具数组，顺序由服务器提供。
	tools: Tool[];
	// 可选下一页游标；client会把空串/null规范为结束，非空游标继续请求，并检测重复游标。
	nextCursor?: string;
	// 列表响应层的元数据；client的列表合并/标准化结果不会统一保留这些额外字段。
	_meta?: Record<string, unknown>;
}

/** A resource a server lists in `resources/list`. */
// resources/list的一项资源；只描述资源而不包含正文，实际正文需readResource取得。
export interface Resource {
	// 资源地址，client只查是字符串，未限制协议或存在性。
	uri: string;
	// 标准化后的显示名；远端缺省name时client会用uri补上，因此返回类型将name声明为必需。
	name: string;
	// 可选显示标题，与name可并存。
	title?: string;
	// 可选资源说明，不在client中自动加载为模型提示。
	description?: string;
	// 可选媒体类型声明；client不读取资源来核实格式。
	mimeType?: string;
	// 可选资源大小数字，接口没有运行时范围或整数检查。
	size?: number;
	// 复用内容说明类型，可带受众、优先级、修改时间。
	annotations?: ContentAnnotations;
	// 资源描述的附加元数据，client标准化时浅展开原对象可保留它。
	_meta?: Record<string, unknown>;
}

/** A family of resources, addressed by an RFC 6570 URI template, from `resources/templates/list`. */
// 一族资源的URI模板描述；例如repo://{owner}/{repo}。这里只描述模板，不替换占位参数或验证RFC规则。
export interface ResourceTemplate {
	// 地址模板字符串；与具体资源uri不同，需由使用方填入参数才形成目标地址。
	uriTemplate: string;
	// 标准化显示名，缺省时client用uriTemplate补上。
	name: string;
	// 可选展示标题。
	title?: string;
	// 可选模板说明，client不解析其中的语法。
	description?: string;
	// 模板生成资源的可选媒体类型声明。
	mimeType?: string;
	// 可选受众/优先级/修改时间信息。
	annotations?: ContentAnnotations;
	// 模板描述级的额外元数据，浅展开时可沿用原引用。
	_meta?: Record<string, unknown>;
}

// 一页资源列表结果；listResourcesPage返回此形状，listResources则跟游标取完再返回数组。
export interface ListResourcesResult {
	// 本页已标准化的资源描述数组，不是资源正文。
	resources: Resource[];
	// 可选下一页游标；缺省代表结束，client会省略该字段而不是特意写undefined。
	nextCursor?: string;
	// 协议上可有的页级元数据；当前client.listResourcesPage重建对象时只保留resources和nextCursor。
	_meta?: Record<string, unknown>;
}

// 一页资源模板结果，与完整模板数组接口区分。
export interface ListResourceTemplatesResult {
	// 本页模板描述数组，成员缺省name时由client标准化。
	resourceTemplates: ResourceTemplate[];
	// 可选下一页游标，分页请求会把它作为cursor传回服务器。
	nextCursor?: string;
	// 协议允许的页级元数据；当前client.listResourceTemplatesPage也只组装模板数组和游标。
	_meta?: Record<string, unknown>;
}

// resources/read得到的内嵌正文；这与resources/list中的描述信息不同，可能返回多份正文。
export interface ReadResourceResult {
	// 括号先把文本/二进制资源联合起来再加[]；client只查每项对象、字符串uri、text/blob至少一者为字符串，不深验MIME/base64/_meta。
	contents: (TextResourceContents | BlobResourceContents)[];
	// 读资源响应层的可选元数据；client返回通过浅校验的原对象，不在此移除或复制该字段。
	_meta?: Record<string, unknown>;
}
