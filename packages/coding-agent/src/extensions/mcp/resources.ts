/**
 * MCP resources, through the tools Codex and opencode use: `list_mcp_resources`,
 * `list_mcp_resource_templates`, and `read_mcp_resource`. They take a `server` argument and cover
 * every connected server with resources, so models trained on those tools use them unchanged.
 *
 * Listings are JSON, as in Codex: `{ server?, resources: [{ server, ...resource }], nextCursor? }`.
 * With a `server`, one page is listed and `cursor` continues it; without, every page of every server.
 * MCP App resources (`ui://` URIs and `profile=mcp-app` HTML) are left out, since they are user
 * interfaces for hosts that render them, and so are icons. Read resources become text and images for
 * the model; binary resources are saved to temp files. Scripts get the JSON payloads.
 */

// 给模型/脚本提供三个资源工具，不是连接管理器：列资源、列 URI 模板、按 URI 读内容。上游 MCP 扩展注册这些定义，执行时再通过 servers() 取得当前可用服务器。
// 例：list_mcp_resources({server:"docs"}) 只读一页；不传 server 则并发拉每台的全页；拿 URI 后 read_mcp_resource 负责转换文字/图像或保存二进制临时文件。
// 这里的 import type 只提供编译期结构；真正请求由 runtime.ts 实现的 McpResourceServer 接口发出。
import type { ImageContent, JsonValue, TextContent } from "@earendil-works/pi-ai";
import type {
	ContentBlock,
	ListResourcesResult,
	ListResourceTemplatesResult,
	McpRequestOptions,
	ReadResourceResult,
	Resource,
	ResourceTemplate,
} from "@earendil-works/pi-mcp";
// TSchema/ToolDefinition 描述工具声明和执行签名；as 关联类型不会在运行时自动检查 schema。
import type { TSchema } from "typebox";
import type { ToolAnnotations, ToolDefinition } from "../../core/extensions/types.ts";
// 三个公共工具名来自统一常量，避免注册和模型名称拼错。
import {
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	LIST_MCP_RESOURCES_TOOL,
	READ_MCP_RESOURCE_TOOL,
} from "../../core/mcp-servers.ts";
// exposure 决定直接暴露还是交给代码调用；tools.ts 复用内容转换、截断及暴露方式映射。
import type { McpExposure } from "./config.ts";
import { limitMcpContent, type McpToolDetails, toModelContent, toToolExposure } from "./tools.ts";

// 重新导出名称，供本模块消费者共用；没有在此创建工具或发网络请求。
export { LIST_MCP_RESOURCE_TEMPLATES_TOOL, LIST_MCP_RESOURCES_TOOL, READ_MCP_RESOURCE_TOOL };

/** A connected server that offers resources. */
/** 资源服务的最小能力接口，实际连接类实现它；接口本身不校验远端协议，也不自动连接。 */
export interface McpResourceServer {
	// 配置中的服务器名称，用来路由用户/模型指定的 server。
	name: string;
	// 请求超时毫秒数；全量分页的每页可各用一次，不是整张目录的总时限。
	timeoutMs: number;
	// 单页资源列表，cursor 是服务器给的游标，调用方不拆解它。
	resourcesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourcesResult>;
	// 单页 URI 模板列表，未实现的方法在 runtime 层可降级为空页。
	resourceTemplatesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourceTemplatesResult>;
	// 全量资源列表，实际 client 会迭代所有页，并限制重复游标/最大页数。
	allResources(options: McpRequestOptions): Promise<Resource[]>;
	// 同理获取全部模板，模板只是 URI 格式，还需填具体参数后读取。
	allResourceTemplates(options: McpRequestOptions): Promise<ResourceTemplate[]>;
	// 按确切 URI 读远端内容，返回一个或多个文本/二进制条目。
	readResource(uri: string, options: McpRequestOptions): Promise<ReadResourceResult>;
}

/** MCP App user interfaces, which only hosts that render them can use. */
// 按 URI 前缀或 MIME profile 识别需要 UI 宿主的 MCP App 资源，用于隐藏列表项；不是完整 MIME 解析/访问授权。
function isMcpAppResource(item: { uri?: string; uriTemplate?: string; mimeType?: string }): boolean {
	// ?? 优先选 uri，其次 uriTemplate；显式空 uri 不会退到模板字段。
	const uri = item.uri ?? item.uriTemplate ?? "";
	// ui:// 大小写敏感；正则 i 只影响 MIME 检查，模式匹配片段且未限定值结束，不能当严格 profile 等值校验。
	return uri.startsWith("ui://") || /;\s*profile\s*=\s*"?mcp-app"?/i.test(item.mimeType ?? "");
}

/** A listed resource or template without `_meta` and icons, tagged with its server. */
// 去顶层 _meta/icons 并加 server 标签；泛型 extends 只要求类型可能有 _meta，不表示深度清洗未知字段。
function listed<T extends { _meta?: unknown }>(server: string, item: T): Record<string, unknown> {
	// 解构把两个字段取出不用，...rest 浅收集其余自有可枚举字段；交叉类型 T & {icons?:unknown} 只让 TS 允许解构 icons。
	const { _meta, icons: _icons, ...rest } = item as T & { icons?: unknown };
	// 展开顺序是 server 在前、rest 在后；远端额外自带的 server 字段可能覆盖标签，这里未强制重写，嵌套 _meta 也保留。
	return { server, ...rest };
}

// 简短箭头函数返回字符串字段的 JSON Schema 片段；括号使 { ... } 被解释为对象表达式，而不是函数体。
const stringProperty = (description: string) => ({ type: "string", description });
// server 是可选列表过滤项，描述文字是给模型看的提示，不是运行时分支。
const SERVER_FILTER = stringProperty("MCP server name. Omit to list every server with resources.");
// cursor 只在指定同一服务器时允许；不由主机解析成页码。
const CURSOR = stringProperty("Opaque cursor from a previous call with the same server; omit for the first page.");
// 列表输入声明：对象，有可选 server/cursor，不允许其他键；是否执行 schema 检查取决于宿主调用通道，下面仍从 unknown 取参数。
const LIST_PARAMETERS = {
	// JSON Schema 的 type 字段是普通运行字符串，与 TS 的类型注解不是同一机制。
	type: "object",
	// 只在 properties 列字段而没 required，所以两个字段都可省略。
	properties: { server: SERVER_FILTER, cursor: CURSOR },
	// 声明不接受额外参数，不会仅因创建这个对象就自动删掉输入多余键。
	additionalProperties: false,
};
// 读资源输入需要确切 server 和 uri；本文件不记录“此前列过哪些 URI”的白名单。
const READ_PARAMETERS = {
	// 输入根值声明为 object。
	type: "object",
	// properties 的每个属性是自己的 schema 片段。
	properties: {
		// server 的描述要求与配置名一致，真正查找在 findServer。
		server: stringProperty(
			"MCP server name exactly as configured. Must match the 'server' field returned by list_mcp_resources.",
		),
		// 描述建议用列表返回的 URI，但 execute 不检查历史列表成员，也不在此校验 URI 方案。
		uri: stringProperty("Resource URI to read. Must be one of the URIs returned by list_mcp_resources."),
	},
	// required 声明两项必填，和仅写 properties 不同。
	required: ["server", "uri"],
	// 读资源也声明不接受其他输入键。
	additionalProperties: false,
};

// 名字 optionalString 只是复用字符串 schema；是否可省略由外层 required 决定，片段本身没 optional 魔法。
const optionalString = { type: "string" };
// 跨服务器全量列表可部分失败，errors 数组用于报告哪些服务器没列出；指定单服务器失败直接抛错。
const LISTING_ERRORS = {
	// 数组中每个元素的结构由 items 约束。
	type: "array",
	// 说明错误列表用途，不是实际错误文字。
	description: "Servers that could not be listed",
	// 每条错误是对象。
	items: {
		type: "object",
		// 记录配置名和可展示异常文字，没有堆栈或自动脱敏。
		properties: { server: { type: "string" }, error: { type: "string" } },
		// 一条错误的两个字段都必填。
		required: ["server", "error"],
	},
};
// 资源列表输出声明，实际 payload 直接交给 jsonResult；本函数没有据此再运行一个输出 validator。
const LIST_OUTPUT_SCHEMA = {
	// 输出根为对象。
	type: "object",
	// 根字段如下，可选项不在 required 中。
	properties: {
		// 单服务器分页才附根 server；全量结果靠每项 server 区分。
		server: optionalString,
		// 资源项数组，可能为空。
		resources: {
			// 每个资源不是另一个分页对象，而是平铺条目。
			type: "array",
			// items 描述单条资源。
			items: {
				// 单条也是对象。
				type: "object",
				properties: {
					// 来源服务器标签；listed 的实际展开顺序不保证远端同名额外字段无法覆盖。
					server: { type: "string" },
					// 资源的实际 URI，不是主机本地路径保证。
					uri: { type: "string" },
					// 人类可读名称，MCP client 可在远端缺失时用 URI 补。
					name: { type: "string" },
					// 可选显示标题。
					title: optionalString,
					// 可选文字描述。
					description: optionalString,
					// 可选 MIME 类型，不保证资源内容就是该类型的完整有效文件。
					mimeType: optionalString,
					// 可选 size 数字只是远端元数据，不在此重新读取内容核对。
					size: { type: "number" },
				},
				// 资源项声明必填服务器、URI、名称；没有 additionalProperties:false 限制全部输出附加字段。
				required: ["server", "uri", "name"],
			},
		},
		// 单页结果可能有下一页游标。
		nextCursor: optionalString,
		// 全量列表可附失败列表。
		errors: LISTING_ERRORS,
	},
	// 只要求根 resources，总为空数组也属于有结果。
	required: ["resources"],
};
// 模板列表与资源列表平行，但返回 uriTemplate；这里不会自动展开 RFC6570 模板。
const LIST_TEMPLATES_OUTPUT_SCHEMA = {
	// 根对象。
	type: "object",
	properties: {
		// 单台分页时的服务器名。
		server: optionalString,
		// 模板数组字段，不混入普通 resources。
		resourceTemplates: {
			// 数组可为空。
			type: "array",
			// 每条模板的 schema。
			items: {
				// 模板条目为对象。
				type: "object",
				properties: {
					// 每条的来源标签，实际映射方式见 listed。
					server: { type: "string" },
					// URI 模板字符串，例如 docs://{name}；只声明文字，不在此实现模板插值。
					uriTemplate: { type: "string", description: "RFC 6570 URI template" },
					// 模板名称。
					name: { type: "string" },
					// 可选标题。
					title: optionalString,
					// 可选描述。
					description: optionalString,
					// 模板资源可能的 MIME 声明。
					mimeType: optionalString,
				},
				// 模板项必填服务器、模板和名称。
				required: ["server", "uriTemplate", "name"],
			},
		},
		// 指定单服务器时可能继续下一页。
		nextCursor: optionalString,
		// 全量模板列表也可部分失败。
		errors: LISTING_ERRORS,
	},
	// 根必须有 resourceTemplates。
	required: ["resourceTemplates"],
};
// 读取结果的结构化输出声明，脚本可收到完整文本或 base64，模型内容另行转换/截断。
const READ_OUTPUT_SCHEMA = {
	// 读取结果根为对象。
	type: "object",
	properties: {
		// 从哪个配置服务器读取。
		server: { type: "string" },
		// 此次请求的 URI，条目内部 URI 仍可能不同。
		uri: { type: "string" },
		// 服务器一次可返回多个 contents。
		contents: {
			// 内容集合是数组。
			type: "array",
			// 每项允许下列两种结构之一。
			items: {
				// anyOf 表示至少符合一种，不是恰好一种的 oneOf；这里不以它执行运行时分派。
				anyOf: [
					{
						// 文本内容结构。
						type: "object",
						// URI、可选 MIME 和实际 text。
						properties: { uri: { type: "string" }, mimeType: optionalString, text: { type: "string" } },
						// 文本项须有 URI 与 text，MIME 可省略。
						required: ["uri", "text"],
					},
					{
						// 二进制内容结构。
						type: "object",
						properties: {
							// 二进制项的来源 URI。
							uri: { type: "string" },
							// 可选 MIME，用于后续决定图像/文字/存文件转换。
							mimeType: optionalString,
							// blob 是 base64 字符串；描述 base64 不等于做解码有效性检查或加密。
							blob: { type: "string", description: "base64" },
						},
						// 二进制项须有 URI 与 blob。
						required: ["uri", "blob"],
					},
				],
			},
		},
	},
	// 读取结果三个根字段都声明必填。
	required: ["server", "uri", "contents"],
};

// 从 unknown 参数边界取一个可选字符串：null/缺失/空白都视为未给，非字符串报错；不验证整个对象的所有键。
function stringArgument(params: unknown, key: string): string | undefined {
	// as 只影响 TS，?. 只跳过 null/undefined 参数；普通属性读取可能读到继承字段，没有 hasOwn 检查。
	const value = (params as Record<string, unknown> | undefined)?.[key];
	// 显式 null 也降级为缺失。
	if (value === undefined || value === null) return undefined;
	// 值来自 unknown 边界，所以需要实际 typeof 判断；不能把数字默默转成字符串。
	if (typeof value !== "string") throw new Error(`${key} must be a string`);
	// 去首尾空白，空串再用 || 转成 undefined；URI 的外层空白也会被去掉。
	return value.trim() || undefined;
}

// 把跨服务器失败转成文字，Error 取 message，其余 String；不自动清洗敏感内容或保留堆栈。
function errorMessage(error: unknown): string {
	// unknown 收窄后才能读 message。
	return error instanceof Error ? error.message : String(error);
}

// 把列表 payload 包装成工具结果：给模型一段可能截断的 JSON 文字，脚本另得完整结构化对象，UI details 带可选全文路径。
async function jsonResult(
	// 公共工具名写入 details，不是远端服务器内某个自定义工具名。
	tool: string,
	// 跨服务器列表没有单一 server，用 undefined 表示。
	server: string | undefined,
	// payload 是要序列化的对象，不在这里验证 JSON 完整可序列化性。
	payload: Record<string, unknown>,
	// 返回 Promise 的对象类型，同时描述模型 content、展示 details 与脚本 structuredContent。
): Promise<{ content: (TextContent | ImageContent)[]; details: McpToolDetails; structuredContent: JsonValue }> {
	// JSON.stringify 可抛错；limitMcpContent 只限制模型正文，过长时尝试存全文，截断标记/路径还会增加实际输出字节。
	const { content, fullOutputPath } = await limitMcpContent([{ type: "text", text: JSON.stringify(payload) }]);
	// 组装新工具结果对象。
	return {
		// 模型看到的已处理 content。
		content,
		// 缺单一服务器用空字符串；有全文路径才展开加这个键，不用 undefined 假装路径存在。
		details: { server: server ?? "", tool, ...(fullOutputPath ? { fullOutputPath } : {}) },
		// 双重 as 仅跨越 TS 类型关系，不做深拷贝、脱敏或 JSON schema 检查，脚本拿到原 payload 引用。
		structuredContent: payload as unknown as JsonValue,
	};
}

/**
 * The three resource tools. `servers` returns the servers whose resources they reach, at call time.
 */
/**
 * 构造三份资源工具定义，创建时不连接服务器；execute 时才读取动态 servers() 并请求。
 * 例：server="docs",cursor="next" 获取 docs 的一页；不指定 server 时并发拉全页并收集局部错误。
 * 只读是用途提示，不能强制远端没有副作用；转换二进制/长输出可能写本机临时文件，错误可向执行器传播。
 */
export function createMcpResourceToolDefinitions(options: {
	// 沿用扩展暴露策略，codemode 会在 toToolExposure 映射为宿主 deferred。
	exposure: McpExposure;
	// 函数返回只读数组视图；readonly 限制 TS 修改数组，不冻结服务器对象或保证它们一定已连接。
	servers: () => readonly McpResourceServer[];
}): ToolDefinition<TSchema, McpToolDetails>[] {
	// 三工具共享 readOnlyHint 声明，这不是权限沙箱，也不会自动拦截写入操作。
	const readOnly: ToolAnnotations = { readOnlyHint: true };

	// 按名字精确查当前服务器，找不到则报告可选名字；不尝试自动补全、忽略大小写或创建新配置。
	const findServer = (name: string): McpResourceServer => {
		// 每次调用重新取当前集合，不把构造工具时的列表永远缓存。
		const servers = options.servers();
		// find 取第一个名字相等的项；重名行为由上游配置约束。
		const server = servers.find((candidate) => candidate.name === name);
		// 有结果直接返回同一个对象引用。
		if (server) return server;
		// 为错误文字拼可用服务器名。
		const available = servers.map((candidate) => candidate.name).join(", ");
		// 没有匹配就抛，包含当前候选；这不是一个普通空列表。
		throw new Error(
			`MCP server "${name}" has no resources${available ? `. Servers with resources: ${available}` : ""}`,
		);
	};

	/** One page of one server, or every page of every server. */
	// 通用列表闭包：T 保留资源/模板条目类型，用 page/all 回调复用两套协议；有 server 取单页，无 server 汇总全量，单台错误的处理方式不同。
	const list = async <T extends { _meta?: unknown }>(
		// 原始工具参数，逐字段由 stringArgument 解析。
		params: unknown,
		// 取消信号继续下传，Promise.allSettled 本身不会主动取消其余请求。
		signal: AbortSignal | undefined,
		// 字面量联合控制输出对象的数组字段名。
		key: "resources" | "resourceTemplates",
		// page 是单页请求回调，接服务器、游标和请求设置。
		page: (
			server: McpResourceServer,
			// 首屏可用 undefined，后续原样传服务器给的游标。
			cursor: string | undefined,
			// 请求级信号与超时。
			options: McpRequestOptions,
		) => Promise<{
			// 两种列表都映射成内部统一 items 数组。
			items: T[];
			// 可省略 nextCursor，没有下一页时不出现。
			nextCursor?: string;
		}>,
		// all 是全页回调，返回 T[]，具体如何分页由服务实现。
		all: (server: McpResourceServer, options: McpRequestOptions) => Promise<T[]>,
	): Promise<Record<string, unknown>> => {
		// 读取并裁剪服务器参数；没有或全空白就进入跨服务器模式。
		const serverName = stringArgument(params, "server");
		// 同样读取游标，纯空白游标被当缺失。
		const cursor = stringArgument(params, "cursor");
		// 排除 UI 资源；as 只告诉 TS 可能有哪些字段，不补字段、不检查 MIME 的运行时类型。
		const visible = (item: T) => !isMcpAppResource(item as { uri?: string; uriTemplate?: string; mimeType?: string });
		// 有服务器名走单台分页，不因为过滤后为空就自动追下一页。
		if (serverName) {
			// 找不到直接抛错。
			const server = findServer(serverName);
			// 这一页使用该服务器请求超时；失败不转成 errors 数组。
			const result = await page(server, cursor, { signal, timeoutMs: server.timeoutMs });
			// 返回一页的对象。
			return {
				// 根 server 使用实际匹配的配置名。
				server: server.name,
				// [key] 是计算属性名；先过滤 UI 资源，再浅去元数据并附 server 标签。
				[key]: result.items.filter(visible).map((item) => listed(server.name, item)),
				// 只在 undefined 时省略游标，其他值保留，具体 MCP client 会将 null/空串规范化为无游标。
				...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
			};
		}
		// 不指定服务器却传非空游标属于歧义输入，拒绝而不是把它发给所有服务器。
		if (cursor) throw new Error("cursor can only be used when a server is specified");
		// 先浅复制再按 localeCompare 排序，避免改变上游数组顺序；不是固定 ASCII 排序。
		const servers = [...options.servers()].sort((a, b) => a.name.localeCompare(b.name));
		// 等待所有请求落定，保留每台的 fulfilled/rejected，不因单台失败立刻整体失败。
		const results = await Promise.allSettled(
			// map 同时发起各台全量请求，每台内部页可以顺序获取；同一个 signal/各自 timeout 继续传递。
			servers.map((server) => all(server, { signal, timeoutMs: server.timeoutMs })),
		);
		// 累计成功条目，按排序后的服务器顺序，不按网络先返回的顺序。
		const items: Record<string, unknown>[] = [];
		// 另外累计失败文字，成功空结果不算失败。
		const errors: { server: string; error: string }[] = [];
		// allSettled 保持输入顺序，所以 index 可对应 servers。
		results.forEach((result, index) => {
			// 错误与条目用同一个配置名路由标签。
			const server = servers[index].name;
			// status 是标签联合，fulfilled 分支才有 value，rejected 分支才有 reason。
			if (result.status === "fulfilled")
				// 展开参数把该台过滤后的数组逐项推入，服务器很多/内容很大仍会在内存中汇总。
				items.push(...result.value.filter(visible).map((item) => listed(server, item)));
			// 异常变普通数据放 errors；用户取消导致某台拒绝也可被收成这里的局部错误。
			else errors.push({ server, error: errorMessage(result.reason) });
		});
		// 数组字段一直存在，只有确实有失败才附 errors。
		return { [key]: items, ...(errors.length > 0 ? { errors } : {}) };
	};

	// 声明普通资源列表工具，泛型把参数 schema 与展示 details 的类型接到宿主接口。
	const listResources: ToolDefinition<TSchema, McpToolDetails> = {
		// 模型/脚本调用的固定名称。
		name: LIST_MCP_RESOURCES_TOOL,
		// UI 标签沿用名称。
		label: LIST_MCP_RESOURCES_TOOL,
		// description 是实际给模型的文字，保持原字符串不变。
		description:
			"Lists resources provided by MCP servers. Resources allow servers to share data that provides context to language models, such as files, database schemas, or application-specific information. Prefer resources over web search when possible.",
		// 双重断言接上 TSchema 类型，不在赋值时编译或执行验证器。
		parameters: LIST_PARAMETERS as unknown as TSchema,
		// 输出结构声明，不是模型正文一定等于完整 JSON 的保证（正文可能截断）。
		outputSchema: LIST_OUTPUT_SCHEMA as unknown as TSchema,
		// 决定直接/延迟暴露。
		exposure: toToolExposure(options.exposure),
		// 共享只读提示对象。
		annotations: readOnly,
		/** 执行一次列资源请求，返回模型文字+完整结构化值；工具调用 ID 此处不用，signal 继续传。 */
		async execute(_toolCallId, params, signal) {
			// 调用通用列表逻辑，以下提供普通资源的单页/全页适配函数。
			const payload = await list(
				// 原始参数由通用逻辑解析。
				params,
				// 外部取消继续下传。
				signal,
				// 输出 JSON 数组键为 resources。
				"resources",
				// 单页回调把具体接口结果适配为通用形状。
				async (server, cursor, requestOptions) => {
					// 发起一页请求。
					const result = await server.resourcesPage(cursor, requestOptions);
					// 资源数组重命名为 items，保留下一页游标。
					return { items: result.resources, nextCursor: result.nextCursor };
				},
				// 没指定 server 时调用全页版本。
				(server, requestOptions) => server.allResources(requestOptions),
			);
			// 包装结果，重新读 server 仅用于 details，不额外请求网络。
			return jsonResult(LIST_MCP_RESOURCES_TOOL, stringArgument(params, "server"), payload);
		},
	};

	// 声明 URI 模板列表工具；它列格式，不读取每个模板代表的资源。
	const listTemplates: ToolDefinition<TSchema, McpToolDetails> = {
		// 模板列表公共名称。
		name: LIST_MCP_RESOURCE_TEMPLATES_TOOL,
		// 展示标签。
		label: LIST_MCP_RESOURCE_TEMPLATES_TOOL,
		// 模型说明，保留原字符串字节。
		description:
			"Lists resource templates provided by MCP servers. Parameterized resource templates allow servers to share data that takes parameters and provides context to language models, such as files, database schemas, or application-specific information. Prefer resource templates over web search when possible.",
		// 复用和普通列表相同的输入声明。
		parameters: LIST_PARAMETERS as unknown as TSchema,
		// 输出字段改为 resourceTemplates。
		outputSchema: LIST_TEMPLATES_OUTPUT_SCHEMA as unknown as TSchema,
		// 暴露策略与普通资源一致。
		exposure: toToolExposure(options.exposure),
		// 只读提示。
		annotations: readOnly,
		/** 列 URI 模板，单服务器一页/无服务器全量，结果包装规则与普通列表相同。 */
		async execute(_toolCallId, params, signal) {
			// 共用列表闭包，避免两套分页/错误处理逐渐不一致。
			const payload = await list(
				// 传原始参数。
				params,
				// 传取消信号。
				signal,
				// 计算属性名选择模板数组。
				"resourceTemplates",
				// 模板单页适配回调。
				async (server, cursor, requestOptions) => {
					// runtime 可把方法不存在降级为空模板列表。
					const result = await server.resourceTemplatesPage(cursor, requestOptions);
					// 把模板结果映射成通用 items/nextCursor。
					return { items: result.resourceTemplates, nextCursor: result.nextCursor };
				},
				// 全量模板回调交服务实现分页。
				(server, requestOptions) => server.allResourceTemplates(requestOptions),
			);
			// 给模型 JSON 文字，给脚本完整结构化对象。
			return jsonResult(LIST_MCP_RESOURCE_TEMPLATES_TOOL, stringArgument(params, "server"), payload);
		},
	};

	// 声明按 URI 读内容的工具，不把服务器资源直接当可执行工具代码。
	const readResource: ToolDefinition<TSchema, McpToolDetails> = {
		// 公共读取名称。
		name: READ_MCP_RESOURCE_TOOL,
		// 展示名称。
		label: READ_MCP_RESOURCE_TOOL,
		// 描述建议先用列表，不在下面实现 URI 历史白名单。
		description: "Read a specific resource from an MCP server given the server name and resource URI.",
		// 必需 server/uri 的输入声明。
		parameters: READ_PARAMETERS as unknown as TSchema,
		// 输出包含 text/blob 的结构声明。
		outputSchema: READ_OUTPUT_SCHEMA as unknown as TSchema,
		// 读取工具同样按设置映射暴露方式。
		exposure: toToolExposure(options.exposure),
		// 只读用途提示，内容转换仍可能写临时文件。
		annotations: readOnly,
		/** 路由到服务器读 URI → 多内容加标签 → 转模型块并截断 → 返回完整脚本载荷；不先列目录核验 URI，也不套列表中的 UI 资源过滤。 */
		async execute(_toolCallId, params, signal) {
			// 取并 trim 服务器名。
			const serverName = stringArgument(params, "server");
			// 取并 trim URI 文本，不把它自动拼成本地路径。
			const uri = stringArgument(params, "uri");
			// 空缺服务器是输入错误。
			if (!serverName) throw new Error("server must be provided");
			// 空缺 URI 也报错，不发送空资源请求。
			if (!uri) throw new Error("uri must be provided");
			// 精确找当前可用资源服务器。
			const server = findServer(serverName);
			// 真正发 MCP resources/read，使用本台请求时限和外部取消信号。
			const result = await server.readResource(uri, { signal, timeoutMs: server.timeoutMs });
			// Several contents (for example a directory) are labeled with their URIs.
			// flatMap 将每个内容的“可选标签+资源块”扁平展开，保持返回顺序。
			const blocks: ContentBlock[] = result.contents.flatMap((contents) => [
				// 只有总条数大于1时在每项前加 URI 标签；as const 防止 type 被推成一般 string。
				...(result.contents.length > 1 ? [{ type: "text" as const, text: `${contents.uri}:` }] : []),
				// 将原内容嵌成资源块，真正文字/图像/二进制转换由 tools.ts 实现。
				{ type: "resource" as const, resource: contents },
			]);
			// 可把二进制保存临时文件，返回路径提示；不会仅因 URI 是 http 就自动另外 fetch 该链接。
			const converted = await toModelContent(server.name, blocks);
			// 再限制模型文本，必要时保存全文；图像不按这段文字预算缩放。
			const { content, fullOutputPath } = await limitMcpContent(
				// 转换完全没有块才补“空资源”文字；不是检查每个文本块非空。
				converted.length > 0 ? converted : [{ type: "text", text: `Resource ${uri} is empty.` }],
			);
			// 脚本内容仅去每条顶层 _meta，其余字段保留（含可能的 icons/嵌套元数据），不递归净化。
			const contents = result.contents.map(({ _meta: _ignored, ...rest }) => rest);
			// 同一结果同时承载模型正文、UI details、脚本结构化数据。
			return {
				// 给模型的已转换、可能截断内容。
				content,
				// details 供展示/全文路径引用，不混入远端协议结构。
				details: {
					// 真实路由到的配置服务器名。
					server: server.name,
					// 读取公共工具名。
					tool: READ_MCP_RESOURCE_TOOL,
					// 只有生成了文本全文路径才附加；二进制路径提示可能已在 content 中。
					...(fullOutputPath ? { fullOutputPath } : {}),
				},
				// 脚本拿请求 URI 与原内容值，不受模型正文截断影响；双重断言不加密、不深复制、不验证 JSON。
				structuredContent: { server: server.name, uri, contents } as unknown as JsonValue,
			};
		},
	};

	// 固定返回三个工具，创建定义本身不连服务器；本工具的列表/读取请求在 execute 中发起，服务器也可能早已由会话启动流程连接。
	return [listResources, listTemplates, readResource];
}
