// 描述MCP工具结果中的文本、图片、资源等内容，并把它们映射为模型可用的text/image形状。McpClient返回这些协议类型；coding-agent的MCP适配器再调用下方转换函数。
// 这里只作本地数据转换，没有模型请求、链接访问、图片验证或输出预算；coding-agent会在外围处理二进制保存与文字截断。interface/type是TS描述，不是运行时验证器。
// 内容的附加说明字段；可供上层消费，但下面toLlmContent不会保留这些说明或据此筛选受众。
export interface ContentAnnotations {
	// ?允许不提供受众；括号把"user" | "assistant"组成联合后再加[]，即元素只能是这两个字符串的数组，而非单个字符串。
	audience?: ("user" | "assistant")[];
	// 可选优先级数字；这里只声明number，不执行范围检查、排序或裁剪。
	priority?: number;
	// 可选修改时间文字；类型没有验证日期格式，也不把字符串转换成Date。
	lastModified?: string;
}

// 文本块的结构；以type字面量区分后，TS可在switch中确定text字段。
export interface TextContent {
	// 固定text标签，用来区分图片、音频等其他块。
	type: "text";
	// 文本正文；转换时原样使用，不解释为HTML或主动替换内容。
	text: string;
	// 可选受众/优先级/修改时间说明，类型复用上面的接口。
	annotations?: ContentAnnotations;
	// 可选额外元数据；Record<string, unknown>表示字符串键到未知值的映射，读取内部值前需要另行判断。
	_meta?: Record<string, unknown>;
}

// 图片块结构，数据约定为base64文本；声明本身不解码，也不检查图片是否有效。
export interface ImageContent {
	// 固定image标签。
	type: "image";
	// 图片编码文字；string只限制TS类型，不能证明base64合法。
	data: string;
	// 声明的媒体类型，例如image/png；下方直接沿用，不根据内容嗅探格式。
	mimeType: string;
	// 图片附加说明，转换出的简化对象会省略它。
	annotations?: ContentAnnotations;
	// 图片元数据，可有任意未知值，转换不会深复制它或传给模型。
	_meta?: Record<string, unknown>;
}

// 音频块与图片类似带data和mimeType，但此文件的模型输出联合不包含audio，所以转换时仅生成省略说明。
export interface AudioContent {
	// 固定audio标签。
	type: "audio";
	// 音频编码数据；下方不会解码、转写或把这一字段放入输出。
	data: string;
	// 声明的音频类型，例如audio/wav；仅用于占位说明文字。
	mimeType: string;
	// 可选音频附加说明，转换不保留。
	annotations?: ContentAnnotations;
	// 可选音频元数据，类型不负责验证具体字段。
	_meta?: Record<string, unknown>;
}

// 资源链接只给出地址与描述，不等于内嵌文件正文；本文件会把名称和URI拼成文本，不读取目标。
export interface ResourceLinkContent {
	// 固定resource_link标签，与下面resource内嵌块不同。
	type: "resource_link";
	// 资源地址，例如file:///a.txt；string没有检查URI语法、权限或可访问性。
	uri: string;
	// 资源名称，转换时与URI一起显示。
	name: string;
	// 可选显示标题；此处的基础转换没有使用它，coding-agent外围可采用更详细展示。
	title?: string;
	// 可选资源说明；下面的简化结果不含这个字段。
	description?: string;
	// 可选媒体类型声明；基础链接转换不据此下载或解码资源。
	mimeType?: string;
	// 可选大小信息；这里只记number，不实际读取文件测量，也不限制必须是非负整数。
	size?: number;
	// 可选资源说明元信息，转换不保留。
	annotations?: ContentAnnotations;
	// 可选协议元数据，转换不保留。
	_meta?: Record<string, unknown>;
}

// 已经嵌入响应的文本资源正文；与仅引用地址的ResourceLinkContent不同。
export interface TextResourceContents {
	// 这段正文所属的资源URI，仅作标识，本文件不沿地址读取。
	uri: string;
	// 可选媒体类型；有text字段时下面优先直接取文字，不依据该类型走图片分支。
	mimeType?: string;
	// 内嵌文本内容，转换为一个text块。
	text: string;
	// 资源自身的可选元数据，与外层内容块的_meta是两个不同位置。
	_meta?: Record<string, unknown>;
}

// 已经嵌入响应的二进制资源，用blob字符串携带数据；不是浏览器Blob对象。
export interface BlobResourceContents {
	// 资源标识地址；非图片二进制的占位说明会显示它。
	uri: string;
	// 可选媒体类型；下面只按大小写敏感的image/前缀判定是否走图片输出。
	mimeType?: string;
	// base64编码正文的字符串约定，转换不验证或重编码。
	blob: string;
	// 内嵌资源自身的可选元数据，输出时会舍弃。
	_meta?: Record<string, unknown>;
}

// resource内容块包装一份已给出的资源内容；外层有type标签，里面的资源通过text/blob字段区分。
export interface EmbeddedResourceContent {
	// 固定resource标签，表示内嵌资源。
	type: "resource";
	// 联合允许文字资源或二进制资源；TS的结构类型不排斥额外字段，运行时仍可能出现同时带text/blob的对象。
	resource: TextResourceContents | BlobResourceContents;
	// 内容块这一层的可选附加说明，不等同内层resource的字段。
	annotations?: ContentAnnotations;
	// 外层元数据，与resource._meta可同时存在；基础转换都不保留。
	_meta?: Record<string, unknown>;
}

// 五种块组成联合；判断共同字段type后，TS能缩小到对应接口。export使调用方可复用这些协议类型。
export type ContentBlock = TextContent | ImageContent | AudioContent | ResourceLinkContent | EmbeddedResourceContent;

// 一次tools/call响应的内容形状；它是业务结果，区别于JSON-RPC包裹层的result/error。
export interface CallToolResult {
	// 有序内容块数组；McpClient只检查该字段是否为数组/缺省，不逐块深验这些接口，外部输入并非因类型声明就已安全。
	content: ContentBlock[];
	/** Any JSON value, including arrays and `null` (MCP 2026-07-28; earlier revisions allowed only objects). */
	// 结构化结果以unknown承接，具体JSON结构由工具决定；协议约定可为数组/null等，unknown本身也可容纳循环对象、BigInt等不能正常JSON序列化的JS值。
	structuredContent?: unknown;
	// 可选工具错误标记；toLlmContent的入参没有选它，转换不会据此抛错或追加错误提示，上层适配器另行处理。
	isError?: boolean;
	// 工具结果层的可选元数据；简化的模型内容不会保留它。
	_meta?: Record<string, unknown>;
}

/**
 * Tool result content in the shape LLM APIs accept: text and base64 images. Matches the
 * `TextContent` and `ImageContent` types of `@earendil-works/pi-ai`.
 */
// 模型内容只接受文本或图片两种结构；分号分隔对象字段，|连接联合。它与pi-ai对应字段兼容，不代表已实际调用任何模型API。
export type LlmContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

// 把一个块转换成一个新text/image对象，依type分支选择正文或占位说明；输入是协议块，返回简化块，不改原对象，也不读URI或保存文件。例：resource_link(name:"a",uri:"file:///a")变成文字"a: file:///a"。
// 这不是完整输入校验：非法null块、错误的resource结构或抛错getter都可能导致异常；未知type只在确实到达default时才有占位兜底。
function blockToLlmContent(block: ContentBlock): LlmContent {
	// switch按type标签选分支；TS据此缩小联合类型，直接return使每个匹配分支结束，无须额外break。
	switch (block.type) {
		// 普通文本分支；即使文字为空也会保留一个text块。
		case "text":
			// 创建新对象，只拷贝标签和正文；annotations/_meta不随原块传出，原text字符串不作清洗或截断。
			return { type: "text", text: block.text };
		// 普通图片分支，不要求图像文件落盘。
		case "image":
			// 把data和mimeType原样交给新对象；不验证base64、不调整尺寸，也不确认该MIME与内容吻合。
			return { type: "image", data: block.data, mimeType: block.mimeType };
		// 音频分支，因为目标LlmContent没有audio成员，只输出说明。
		case "audio":
			// 模板字符串把媒体类型插入占位文字，音频data被省略；这是本地替代文字，没有转写或模型总结。
			return { type: "text", text: `[audio ${block.mimeType} omitted]` };
		// 仅地址的资源链接分支。
		case "resource_link":
			// 拼接name、冒号和URI形成一块文本，不跟随链接；title/description/size等其余字段在这份基础输出中省略。
			return { type: "text", text: `${block.name}: ${block.uri}` };
		// 内嵌资源分支的花括号为const提供块作用域，避免与其他case中的声明冲突。
		case "resource": {
			// 取原resource引用，const禁止重新绑定这个局部变量，不会冻结资源对象。
			const resource = block.resource;
			// 有text键就优先按文字处理；in会检查继承键，值是否为字符串不再验证，即使额外带blob或图片MIME也先返回此分支。
			if ("text" in resource) return { type: "text", text: resource.text };
			// ?.在mimeType为null/undefined时跳过startsWith；有字符串时只检查小写image/前缀，大小写敏感且不验证完整MIME格式。
			if (resource.mimeType?.startsWith("image/")) {
				// 图片资源的blob直接当图片data；标签和媒体类型一并返回，不做base64解码，也不使用资源URI。
				return { type: "image", data: resource.blob, mimeType: resource.mimeType };
			}
			// 其他二进制资源只生成说明对象，实际blob不发到模型内容里。
			return {
				// 输出标签为text，保证此分支按说明文字展示而不是音频或文件对象。
				type: "text",
				// 插入URI和媒体类型；??仅在null/undefined时换成unknown type，空字符串仍保留，不追加文件字节或正文。
				text: `[binary resource ${resource.uri} (${resource.mimeType ?? "unknown type"}) omitted]`,
			};
		}
		// 处理运行时落到联合类型之外的type；TS声明并不使任意外来JS对象自动符合这五种形状。
		default:
			// as断言让TS允许读取兜底type，不会执行验证或转换；模板生成不支持类型的占位。若block本身为null，前面读block.type时早已抛错。
			return { type: "text", text: `[unsupported MCP content ${(block as { type: string }).type}]` };
	}
}

/**
 * Convert a tool result to text and image content for a model. Text and images pass through,
 * embedded text resources become text, embedded image resources become images, and other blocks
 * (audio, resource links, binary resources) become a short text placeholder. A result without
 * content blocks but with `structuredContent` becomes its JSON, since servers should, but do not
 * always, mirror structured results as text.
 */
// 转换一份工具结果为模型内容数组：按序转换已有块，仅在结果数组为空且提供structuredContent时追加其JSON文本，最后返回新数组；不修改输入，无文件/网络副作用。例：content:[]加structuredContent:null得到text:"null"，有一块文本时则不会再追加结构化结果。
// Pick<T,K>只从CallToolResult选content和structuredContent两个字段，LlmContent[]声明返回块数组；这些TS类型不做运行时校验。JSON.stringify对循环值/BigInt或抛错getter可抛异常，函数不捕获；顶层函数/Symbol等非JSON值还可能得到undefined而非文本。
export function toLlmContent(result: Pick<CallToolResult, "content" | "structuredContent">): LlmContent[] {
	// ??让运行时缺省/null的content回退空数组，再map按顺序调用上面的转换函数；创建新数组和各块的新对象，非法非数组值仍可能在.map处抛错。
	const content = (result.content ?? []).map(blockToLlmContent);
	// 只有转换后没有块且结构化值不为undefined才走兜底；null、false、0均会保留，已有音频占位等任何块都会阻止这次追加。
	if (content.length === 0 && result.structuredContent !== undefined) {
		// JSON.stringify第二参数null表示不设替换器，第三参数2按两空格缩进；push只改新建的content数组。这里不截断长JSON，也不保证任意unknown都可编码。
		content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
	}
	// 返回转换所得的数组；它不携带isError、structuredContent原结构、annotations或_meta，后续适配器可以另行保留原结构并限制模型输出。
	return content;
}
