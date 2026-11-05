// 将MCP工具声明/结果适配为Pi工具与TUI渲染器；注册时构造定义，execute才获取客户端调用服务器。模型看到有限文本/图片，codemode拿去_meta的结构结果，两条路径截断规则不同。
/**
 * Adapts MCP tools to pi tool definitions.
 *
 * Results map onto pi's model-facing content (text and images). Text over 20KB keeps its start and
 * end with the middle cut out, like Codex does, and the full text is saved to a temp file the model
 * can read. Binary resources other than images are saved to temp files too, and resource links name
 * the `read_mcp_resource` tool. Codemode scripts receive the whole `CallToolResult` without `_meta`
 * (`content` blocks as sent by the server, `structuredContent`, `isError`), never truncated: it is
 * the tool's `structuredContent`, and every MCP tool declares a `CallToolResult` output schema. MCP
 * errors (`isError`) are error results for the model, but scripts still resolve to the result.
 */

// 哈希只用于缩短/区分工具名，不加密工具参数。
import { createHash } from "node:crypto";
// AgentToolResult泛型描述Pi工具的details，不是原MCP响应类型。
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
// 模型内容块和JSON结构类型，跨协议转换仍需下方实际代码。
import type { ImageContent, JsonValue, TextContent } from "@earendil-works/pi-ai";
// 复用MCP协议类型与基础内容转换。
import {
	// CallToolResult含content、可选结构结果和isError。
	type CallToolResult,
	// ContentBlock是text/image/audio/resource等标签联合。
	type ContentBlock,
	// 请求选项带取消、超时与进度。
	type McpRequestOptions,
	// 导入时用as给Tool类型起别名，避免与Pi工具定义重名。
	type Tool as McpTool,
	// 基础转换会把不支持内容降为文字占位，空content可取结构结果JSON。
	toLlmContent,
} from "@earendil-works/pi-mcp";
// 这些组件只负责显示，创建Text不运行MCP工具。
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
// TSchema是类型，下面双断言不会自动验证服务端schema。
import type { TSchema } from "typebox";
// Pi扩展工具公共契约，只导入类型。
import type {
	// 工具行为提示元数据。
	ToolAnnotations,
	// 工具定义含execute和显示方法。
	ToolDefinition,
	// Pi可达性策略与MCP四种策略不完全相同。
	ToolExposure,
	// 命名空间供codemode分组。
	ToolNamespace,
	// 工具调用/结果的渲染器接口。
	ToolRenderers,
} from "../../core/extensions/types.ts";
// 公共资源读取工具的名字常量。
import { READ_MCP_RESOURCE_TOOL } from "../../core/mcp-servers.ts";
// 共用参数格式/显示正文/tab处理，避免重复造渲染规则。
import { formatToolCallWithArgs, getTextOutput, replaceTabs } from "../../core/tools/render-utils.ts";
// 字节大小展示与保留首尾的截断函数。
import { formatSize, truncateMiddle } from "../../core/tools/truncate.ts";
// 从可配置按键生成展开提示，不把ctrl+o写死。
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
// 折叠结果按视觉行截断，不按源文本换行数。
import { VisualLinePreview } from "../../modes/interactive/components/visual-truncate.ts";
// 写受控临时输出文件，不自己猜资产目录。
import { writeOutputFile } from "../../utils/output-files.ts";
// MCP暴露配置的纯类型。
import type { McpExposure } from "./config.ts";

/**
 * Tool exposure of an MCP exposure. `codemode` and `deferred` both leave tools out of the codemode
 * description; they differ only in which tool the MCP extension activates to reach them.
 */
// 将MCP策略映射成Pi工具策略，返回字面量；例：MCP codemode变Pi deferred，以便不在codemode描述中逐项列工具。无注册/执行副作用，其他策略保持。
export function toToolExposure(exposure: McpExposure): ToolExposure {
	// 三元式只转换codemode，不能把两个同名策略的语义当成完全一致。
	return exposure === "codemode" ? "deferred" : exposure;
}

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
// 提供商工具名最大64个ASCII字符；清理后length就是该名字符数。
const MAX_TOOL_NAME_LENGTH = 64;
/** Model-facing text of an MCP result beyond this is cut in the middle. */
// 保留首尾原文的字节预算20KiB，省略标记、提示头和文件路径等附加文字不计入它。
export const MCP_OUTPUT_MAX_BYTES = 20 * 1024;
/** Visual (wrapped) result lines shown before the output is expanded. */
// 折叠TUI预览最多正文5个视觉行，提示行另加。
const OUTPUT_PREVIEW_LINES = 5;
/** Tool that reads the resources named by resource links. */
// 值重导出同一常量，不新建第二个工具。
export { READ_MCP_RESOURCE_TOOL };

// Pi侧工具结果details，供UI显示来源和完整输出路径。
export interface McpToolDetails {
	// 服务器名。
	server: string;
	// 服务器原工具名，非模型清理后名字。
	tool: string;
	/** Temp file with the full text output, when the model-facing text was truncated. */
	// 正文被裁且保存成功时可带临时文件路径；不是每个二进制资源路径汇总。
	fullOutputPath?: string;
}

/**
 * Saves the full text of a truncated result, or a binary resource, and returns the file path.
 * `extension` includes the dot, for example `.txt`.
 */
// 异步保存回调契约：文字或字节、带点后缀，返回路径Promise；类型不保证已落盘或路径可读，具体实现负责。
export type McpOutputSaver = (data: string | Uint8Array, extension: string) => Promise<string>;

// 把文字/字节交共用输出器写临时文件，返回路径Promise；例：后缀.txt。可能创建目录/写盘并拒绝，不读取用户指定源文件、不上传。
export function saveToTempFile(data: string | Uint8Array, extension: string): Promise<string> {
	// 固定pi-mcp命名前缀，实际文件名/清理由output-files处理。
	return writeOutputFile("pi-mcp", extension, data);
}

// 最小客户端能力接口，方便注入真实连接或测试替身，不要求必须某个类实例。
export interface McpToolCaller {
	// 调用原MCP工具名，参数对象及取消/进度选项，异步返回协议结果。
	callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions): Promise<CallToolResult>;
}

/**
 * `mcp__<server>__<tool>`, sanitized and shortened with a hash suffix when too long. Like Codex,
 * everything but `[A-Za-z0-9_]` becomes `_`, so the name is also the identifier codemode scripts
 * call it by. `isTaken` reports names used by a different MCP tool: sanitizing can map two tools to
 * one name (`a-b` and `a_b`), which then get the hash suffix.
 */
// 构造模型/codemode使用的安全名字，必要时截断加8位哈希；例：server=a-b会清成a_b。仅检查原清理名一次，哈希名不再次检查碰撞，不保证任意输入唯一；无注册/I/O。
export function createMcpToolName(
	// 服务器原身份，参与哈希。
	server: string,
	// 工具原身份，参与哈希。
	tool: string,
	// 可注入已占用判断，缺省总false；回调可抛，不由本函数捕获。
	isTaken: (name: string) => boolean = () => false,
): string {
	// 组合再把ASCII字母数字_之外字符全换_；虽然提供商可接受-，这里也清它以便代码标识符调用。
	const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	// 长度允许且未占用就直接返回；过长时&&短路不调用isTaken。
	if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
	// NUL分开原server/tool，SHA256十六进制取前8位，不是加密或无碰撞承诺。
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	// 前缀最多55字符，加_和8位hash，总长64；若原名短但占用，结果可能短于64。
	return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

// 从模型内容中取text块并以LF连接，返回string；例：[text A,image,text B]得A换行B。不解码图片，也不修改数组。
function textOf(content: readonly (TextContent | ImageContent)[]): string {
	// 开始只读数组处理链。
	return (
		content
			// 类型谓词让后续block收窄成TextContent，运行时判断依据type标签。
			.filter((block): block is TextContent => block.type === "text")
			// 抽出每块文字。
			.map((block) => block.text)
			// 块之间加LF，包含空文字块时也可能产生分隔符。
			.join("\n")
	);
}

/**
 * MCP content blocks as one compact type with the fields of text and image blocks, which scripts
 * read most (`image(block)` takes an image block as is). Rendered into every MCP tool's declaration.
 */
// 供codemode输出声明使用的简化内容schema，不是完整MCP协议校验器。
const CONTENT_BLOCK_SCHEMA = {
	// 块要求对象。
	type: "object",
	// 声明常见属性，未指定的允许作为额外字段。
	properties: {
		// type枚举五种类别，没把每类必需字段分别建联合。
		type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
		// 可选text字符串。
		text: { type: "string" },
		// 可选base64数据字符串，不验证编码。
		data: { type: "string" },
		// 可选MIME字符串，不解析媒体。
		mimeType: { type: "string" },
	},
	// 仅要求type，所以这个schema不能保证text块真的有text。
	required: ["type"],
	// 允许新协议字段透传。
	additionalProperties: true,
};

/** Keywords whose values are data, so a `$ref` key in them is not a reference. */
// 这些schema关键字下的值是示例/常量数据，里面长得像$ref的键不重定位；readonly只约束类型访问。
const SCHEMA_DATA_KEYWORDS: ReadonlySet<string> = new Set(["const", "enum", "default", "examples"]);
/** Keywords whose values map names to schemas, so their keys are names, not keywords. */
// 这些关键字下的对象是名字→子schema映射，键名可能刚好叫default/$ref，不能当关键字处理。
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
	// 属性名→schema。
	"properties",
	// 正则属性名→schema。
	"patternProperties",
	// 依赖字段→schema。
	"dependentSchemas",
	// 旧式dependencies，可能还包含属性名数组，递归规则按现有实现。
	"dependencies",
	// 新版局部定义表。
	"$defs",
	// 旧版局部定义表。
	"definitions",
]);

/**
 * `schema` as a subschema at the JSON pointer `pointer` (`#/properties/structuredContent`) of
 * another schema: its local references (`#`, `#/$defs/Item`) are rewritten to point below
 * `pointer`, so they resolve to the same subschemas as before.
 */
// 将schema嵌入新JSON位置时重写本地$ref，返回新结构或保留的数据引用；例：#/$defs/X加#/properties/structuredContent前缀。不解析远程引用、不按完整JSON Schema验证、无循环检测，循环对象会递归失败。
function relocateSchema(schema: unknown, pointer: string): unknown {
	// 数组逐项递归并新建数组，原标量项可复用。
	if (Array.isArray(schema)) return schema.map((item) => relocateSchema(item, pointer));
	// 标量/null直接返回，未要求每个输入一定schema对象。
	if (typeof schema !== "object" || schema === null) return schema;
	// 构造新对象收集字段。
	const relocated: Record<string, unknown> = {};
	// Object.entries只看可枚举自有键。
	for (const [key, value] of Object.entries(schema)) {
		// 只改字符串本地引用#或#/开头，不改远程URL/#anchor。
		if (key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))) {
			// 去旧#再拼新pointer，保留原JSON Pointer转义字符。
			relocated[key] = `${pointer}${value.slice(1)}`;
			// 常量/枚举等数据字段不往里面追引用。
		} else if (SCHEMA_DATA_KEYWORDS.has(key)) {
			// 直接保存其原值引用，不深克隆。
			relocated[key] = value;
			// 名字映射对象要单独遍历，排除null/数组。
		} else if (SCHEMA_MAP_KEYWORDS.has(key) && typeof value === "object" && value !== null && !Array.isArray(value)) {
			// 从条目重新构造映射对象。
			relocated[key] = Object.fromEntries(
				// 名字原样，只有每个子schema递归；解构[name,subschema]是元组读取。
				Object.entries(value).map(([name, subschema]) => [name, relocateSchema(subschema, pointer)]),
			);
		} else {
			// 其余字段按通用递归规则处理；没有schema语义识别所有新关键字。
			relocated[key] = relocateSchema(value, pointer);
		}
	}
	// 返回新外层对象，原schema未原地改写。
	return relocated;
}

/**
 * Output schema of every MCP tool: the `CallToolResult` scripts receive (without `_meta`, which
 * {@link convertMcpResult} drops), with the tool's own output schema as `structuredContent`.
 */
// 构造脚本收到的完整CallToolResult声明，嵌入服务端输出schema作为structuredContent；例：服务端没给schema则该值允许任意形状。返回TSchema断言，不在此验证真实输出值。
export function createMcpResultSchema(structuredContentSchema: Record<string, unknown> | undefined): TSchema {
	// 新建声明对象。
	return {
		// 结果要求对象。
		type: "object",
		// 输出字段表。
		properties: {
			// content为块数组，元素用上述简化schema。
			content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
			// Servers may send structured content without declaring a schema for it, and it may be any JSON value.
			// structuredContent声明可有服务端约束。
			structuredContent: structuredContentSchema
				? // 有schema时重定位本地引用，避免指到新根错误位置。
					relocateSchema(structuredContentSchema, "#/properties/structuredContent")
				: // 没有schema用{}允许任何JSON值，不要求object。
					{},
			// isError是可选布尔元数据。
			isError: { type: "boolean" },
		},
		// 只强制content存在，structuredContent本身不在required里。
		required: ["content"],
		// Fields newer protocol versions add.
		// 允许未来协议扩展字段。
		additionalProperties: true,
		// 双断言桥接到TypeBox类型，不改变运行值或编译schema。
	} as unknown as TSchema;
}

/**
 * Keep model-facing text within {@link MCP_OUTPUT_MAX_BYTES}. Longer text becomes one text block in
 * Codex's truncation format, followed by the path of the file with the full text; images follow it.
 */
// 限制模型可见的合并文字，超长保存全文并返回头尾预览/路径，图片保留；例：30KiB留下最多20KiB原文，再加省略标记和提示。文件保存失败变文字说明，不拒绝；最终总文本可超过20KiB。
export async function limitMcpContent(
	// 模型内容数组，正常未截断会返回同一引用。
	content: (TextContent | ImageContent)[],
	// 缺省保存到本机临时文件，可注入不落盘的测试回调。
	saveOutput: McpOutputSaver = saveToTempFile,
): Promise<{ content: (TextContent | ImageContent)[]; fullOutputPath?: string }> {
	// 把所有text块LF合并，图片不计入正文预算。
	const combined = textOf(content);
	// truncateMiddle按UTF-8字节切首尾并给统计，保留字符边界。
	const truncation = truncateMiddle(combined, MCP_OUTPUT_MAX_BYTES);
	// 未超预算连text合并也不改原内容排列/对象。
	if (!truncation.truncated) return { content };
	// 先声明可选路径，保存失败保持undefined。
	let fullOutputPath: string | undefined;
	// where在try/catch任一路径里赋值，后面保证有字符串。
	let where: string;
	// 只捕获保存这段全文的异常，前面转换/截断错误不在这个try中。
	try {
		// 传完整合并正文保存，扩展名固定.txt。
		fullOutputPath = await saveOutput(combined, ".txt");
		// 路径写入模型可读提示，不保证模型一定读它。
		where = `[Full output: ${fullOutputPath} (read it with offset/limit)]`;
		// 捕获Error及其他抛出值。
	} catch (error) {
		// 失败原因直接展示，没有统一脱敏，不补假路径。
		where = `[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
	}
	// 按原字节数/4近似token，仅展示，非供应商tokenizer计数。
	const tokens = Math.ceil(truncation.totalBytes / 4);
	// 模板串头含原始行数和估算token，再拼裁剪正文与文件说明；不进入其他模型调用。
	const text = `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${truncation.totalLines}\n\n${truncation.content}\n\n${where}`;
	// 构造新结果，不修改原content。
	return {
		// 截断后所有文字合成一块在前，原图片依原图片顺序跟后，原图文交错位置不再保持。
		content: [{ type: "text", text }, ...content.filter((block) => block.type === "image")],
		// 路径真值才作为属性返回，空串保存路径虽写进where但不作为fullOutputPath字段。
		...(fullOutputPath ? { fullOutputPath } : {}),
	};
}

// 内容转换配置，不是MCP连接配置。
export interface ConvertMcpResultOptions {
	/** Saves truncated text and binary resources. Default: a temp file. */
	// 回调用于截断文字和二进制资源保存，可缺省。
	saveOutput?: McpOutputSaver;
	/** Whether the server's resources can be read with `read_mcp_resource`, which resource links then name. */
	// 资源链接是否提示调用公共read工具，不会在转换时自动读取链接。
	readableResources?: boolean;
}

/** File extension for a saved binary resource: the one its URI ends in, else `.bin`. */
// 从URI路径末尾取1..8位字母数字扩展名，否则.bin；例：https://example/report.pdf?q=x取.pdf，普通相对文字report.pdf?q=x则.bin。不可解析文字直接当路径，无m标志，不执行文件类型探测。
function extensionOf(uri: string): string {
	// 合法URL只看pathname，query/hash不参与；其他字符串原样匹配。
	const path = URL.canParse(uri) ? new URL(uri).pathname : uri;
	// 可选链取匹配文字，??缺省.bin，不解码百分号后缀。
	return /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? ".bin";
}

/** Blobs of these types are shown as text. */
// 按MIME名决定blob是否当UTF-8文字，返回boolean；例：text/plain;charset=utf-8通过。只认text/、application/json、+json/+xml，不包括裸application/xml；不是内容嗅探或编码检查。
function isTextMimeType(mimeType: string | undefined): boolean {
	// 缺省/空串直接false。
	if (!mimeType) return false;
	// 去;后参数、trim并小写作匹配。
	const type = mimeType.split(";", 1)[0].trim().toLowerCase();
	// 四类任一命中即可，不检查服务端是否如实声明。
	return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type.endsWith("+xml");
}

/** Model-facing content of one block of `server`'s result. */
// 转换一个MCP内容块为模型text/image数组，可能保存二进制文件；例：resource_link变说明文字，不自动访问URI。保存失败就生成错误说明，其他转换/编码异常可拒绝。
async function blockToContent(
	// 服务器名仅供提示关联。
	server: string,
	// 带type标签的内容联合，分支后TS能读具体字段。
	block: ContentBlock,
	// 当前转换/保存选项。
	options: ConvertMcpResultOptions,
): Promise<(TextContent | ImageContent)[]> {
	// 资源链接优先自定义较详细的展示。
	if (block.type === "resource_link") {
		// 收集媒体类型和已提供size的格式文字，再filter(Boolean)去空值；0字节会先格式化为文字保留。
		const details = [block.mimeType, block.size === undefined ? undefined : formatSize(block.size)].filter(Boolean);
		// 可读资源开关只增加调用建议，不在此调用read工具。
		const read = options.readableResources ? `. Read it with ${READ_MCP_RESOURCE_TOOL} (server "${server}")` : "";
		// 真值description才附冒号说明，空串不加。
		const description = block.description ? `: ${block.description}` : "";
		// 结果数组可供通用扁平合并。
		return [
			// 此分支生成一块文本。
			{
				// 固定text标签。
				type: "text",
				// title仅null/undefined才回退name，空串标题保留；提示里的URI/描述原样拼入，不作XML/引号转义。
				text: `[Resource ${block.uri} "${block.title ?? block.name}"${details.length > 0 ? ` (${details.join(", ")})` : ""}${description}${read}]`,
			},
		];
	}
	// 内嵌blob且MIME不以小写image/开头才特殊处理；这一步大小写敏感，后面文字MIME判断会小写，两处规则不同。
	if (block.type === "resource" && "blob" in block.resource && !block.resource.mimeType?.startsWith("image/")) {
		// 解构资源元信息与base64。
		const { uri, mimeType, blob } = block.resource;
		// Node Buffer按base64解码，未在本函数做严格编码验证。
		const data = Buffer.from(blob, "base64");
		// 声明为文本类型则UTF-8解码，不按charset参数切换其他字符集。
		if (isTextMimeType(mimeType)) return [{ type: "text", text: data.toString("utf8") }];
		// 二进制提示用声明MIME或unknown type，加真实解码字节数。
		const kind = `${mimeType ?? "unknown type"}, ${formatSize(data.length)}`;
		// 文件后缀计算及保存异常转换为占位文字。
		try {
			// 优先注入保存器，否则临时文件；URI只用于提示/后缀，不直接用URI当本地写入路径。
			const path = await (options.saveOutput ?? saveToTempFile)(data, extensionOf(uri));
			// 保存成功返回可读路径说明，二进制本身不发给模型。
			return [{ type: "text", text: `[Binary resource ${uri} (${kind}) saved to ${path}]` }];
			// 保存失败只改变这一块说明。
		} catch (error) {
			// Error取message，其余String；没有统一脱敏。
			const reason = error instanceof Error ? error.message : String(error);
			// 返回失败描述，仍是正常内容数组而非throw/isError标记。
			return [{ type: "text", text: `[Binary resource ${uri} (${kind}) could not be saved: ${reason}]` }];
		}
	}
	// 其余交MCP通用转换：图片直传、音频占位、文本资源取正文；没有做图片缩放。
	return toLlmContent({ content: [block] });
}

/** Model-facing content of `server`'s content blocks, before the output limit. */
// 并发转换所有MCP块，按输入顺序合并成模型内容数组；例：二进制块可同时落盘，返回排列仍按原块顺序。Promise.all遇一个拒绝则整体拒绝，已开始的其他保存不会自动取消。
export async function toModelContent(
	// 服务器名传给各块生成提示。
	server: string,
	// readonly限制数组接口修改，不深冻结块。
	blocks: readonly ContentBlock[],
	// 默认空选项，不改外部配置。
	options: ConvertMcpResultOptions = {},
): Promise<(TextContent | ImageContent)[]> {
	// map启动每块async转换，await全完成，再flat一层去掉块级小数组。
	return (await Promise.all(blocks.map((block) => blockToContent(server, block, options)))).flat();
}

/** Convert an MCP result. `isError` results become error results that keep the structured result. */
// 组装Pi工具结果：先转模型内容/裁剪，再保留去顶层_meta的原结构给脚本；例：MCP isError=true仍resolve一个标错结果，不自动抛异常。没有按声明的outputSchema检查返回值，转换/JSON编码等失败仍可拒绝。
export async function convertMcpResult(
	// 服务器原名。
	server: string,
	// 服务器原工具名。
	tool: string,
	// 实际MCP协议结果，信任边界校验通常由MCP客户端完成，本函数不再完整校验。
	result: CallToolResult,
	// 可覆盖保存/资源提示选项。
	options: ConvertMcpResultOptions = {},
): Promise<AgentToolResult<McpToolDetails>> {
	// Without content blocks, toLlmContent falls back to the structured content as JSON.
	// converted明确只接受text/image，不保留模型不支持的audio块类型。
	const converted: (TextContent | ImageContent)[] =
		// content非空逐块处理；空content交基础函数将structuredContent序列化为JSON，可包含数组/null。
		result.content.length > 0 ? await toModelContent(server, result.content, options) : toLlmContent(result);
	// 有错误标记但转换后无文字时补说明；即使有图片，也会补错误文字。
	if (result.isError && textOf(converted) === "") {
		// push只改本次转换数组，语句不等于抛异常。
		converted.push({ type: "text", text: `MCP tool ${server}/${tool} returned an error` });
	}
	// 执行文字预算与可选全文保存，拿回模型内容及全文路径。
	const { content, fullOutputPath } = await limitMcpContent(converted, options.saveOutput);
	// 对象剩余解构只去顶层_meta，嵌套content块的_meta仍可能保留；原result不改。
	const { _meta: _ignored, ...scriptResult } = result;
	// 构造Pi标准结果。
	return {
		// 模型可见转换内容。
		content,
		// details记录原身份，有真值路径才带它。
		details: { server, tool, ...(fullOutputPath ? { fullOutputPath } : {}) },
		// 脚本获得原content/structuredContent/isError等结构，未套模型截断；断言JsonValue不是实际验证或深复制。
		structuredContent: scriptResult as unknown as JsonValue,
		// 原isError真值才加true，false或缺省不生成false字段。
		...(result.isError ? { isError: true } : {}),
	};
}

/**
 * Tool input schemas must be objects. MCP servers may omit `type`, and some providers reject object
 * schemas without `properties`.
 */
// 给MCP输入schema补缺省type/properties，返回TSchema视图；例：{}变object加空properties。已有非object type或null properties并不会被强制纠正，不编译schema或验证params。
function toParameters(schema: Record<string, unknown>): TSchema {
	// 构造新顶层对象。
	return {
		// 保留服务端其他schema字段，嵌套仍共享引用。
		...schema,
		// type缺省/null才回退object，不把显式array改成object。
		type: schema.type ?? "object",
		// 仅undefined时补properties={}，null等显式值保留。
		...(schema.properties === undefined ? { properties: {} } : {}),
		// 双断言桥接TypeBox接口，不转换成验证器实例。
	} as unknown as TSchema;
}

// as const保留四个提示键的字面量，便于安全索引；不是行为权限实现。
const ANNOTATION_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** The boolean hints of an MCP tool's annotations, or undefined when it has none. */
// 仅取工具注解中的四个布尔提示，返回新对象或undefined；例：readOnlyHint=false也保留。作者声明不证明工具真只读，不执行权限判断。
function toToolAnnotations(tool: McpTool): ToolAnnotations | undefined {
	// 初始空注解对象。
	const annotations: ToolAnnotations = {};
	// 按固定键列表遍历。
	for (const hint of ANNOTATION_HINTS) {
		// 可选链允许没有annotations；远端类型定义的索引也可能包含未知扩展值。
		const value = tool.annotations?.[hint];
		// 只把真实布尔值拷贝，字符串true不转换。
		if (typeof value === "boolean") annotations[hint] = value;
	}
	// 有任一已识别键才返回，否则undefined使定义省略注解。
	return Object.keys(annotations).length > 0 ? annotations : undefined;
}

// 创建可注册的Pi工具定义与渲染方法，不在此连接；execute时获取客户端→调用原名→转换结果。例：模型用清理后的name调用，客户端仍收到tool.name。公开schema只声明，不在工厂里编译校验，执行/渲染异常按各路径传播。
export function createMcpToolDefinition(options: {
	// 服务器名，供label/details。
	server: string;
	// MCP提供的原始工具元数据。
	tool: McpTool;
	// 上游已选的Pi/模型安全名称，不在此再次去重。
	name: string;
	// MCP暴露策略，将映射到Pi策略。
	exposure: McpExposure;
	// 工具命名空间元数据引用。
	namespace: ToolNamespace;
	// 工具请求超时毫秒；获取/连接客户端的等待不由此处单独套同一计时器。
	timeoutMs: number;
	// 无参异步取得客户端，可惰性连接或在测试中注入。
	getClient: () => Promise<McpToolCaller>;
	/** Whether `read_mcp_resource` can read the server's resources. */
	// 动态读资源能力，MCP调用返回后、转换最终结果前才读取，不固定捕获初值。
	readableResources?: () => boolean;
}): ToolDefinition<TSchema, McpToolDetails> {
	// 解构server/tool为当前引用；options其他字段仍在闭包中动态读取。
	const { server, tool } = options;
	// 优先tool.title，只有null/undefined才取注解title；空串不会取后者。
	const title = tool.title ?? tool.annotations?.title;
	// 提取有限布尔注解。
	const annotations = toToolAnnotations(tool);
	// 显示label保留服务器/原工具名，而非64字安全名。
	const label = `${server}/${tool.name}`;
	// 返回定义对象，真正注册由调用者完成。
	return {
		// 模型调用名字。
		name: options.name,
		// label属性简写。
		label,
		// description先trim取非空，再title，再默认说明；title空串也会走默认。
		description: tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`,
		// 输入schema补兼容字段。
		parameters: toParameters(tool.inputSchema),
		// 输出声明包住完整CallToolResult形状。
		outputSchema: createMcpResultSchema(tool.outputSchema),
		// MCP codemode转Pi deferred，具体发现工具由上游激活。
		exposure: toToolExposure(options.exposure),
		// 保存命名空间引用。
		namespace: options.namespace,
		// 有识别注解才展开annotations字段。
		...(annotations ? { annotations } : {}),
		// 展开新建的两种渲染回调，不立即绘制。
		...createMcpToolRenderers(label),
		// async execute是运行入口；_toolCallId故意未用，参数/取消/更新由Pi工具运行层传入。
		async execute(_toolCallId, params, signal, onUpdate) {
			// 先等客户端建立，失败直接拒绝，不执行后续调用。
			const client = await options.getClient();
			// 调用原tool.name；params空缺回退{}，as只声明字典，不在这行执行schema校验。
			const result = await client.callTool(tool.name, (params ?? {}) as Record<string, unknown>, {
				// 取消信号交MCP请求实现合作处理。
				signal,
				// 请求时限使用配置毫秒，进度通知可由客户端协议层重置超时。
				timeoutMs: options.timeoutMs,
				// 进度到来同步生成展示文字，不是最终结果。
				onProgress: (progress) => {
					// total只有undefined时省略，0也会显示/0。
					const total = progress.total === undefined ? "" : `/${progress.total}`;
					// message仅缺省才后备Progress文字，显式空串保留。
					const text = progress.message ?? `Progress ${progress.progress}${total}`;
					// 可选onUpdate输出一段文字和原身份details，不向MCP服务器回传该内容。
					onUpdate?.({ content: [{ type: "text", text }], details: { server, tool: tool.name } });
				},
			});
			// 最终结果按资源可读性转换，转换失败也会让execute拒绝；isError结果本身仍可正常resolve。
			return convertMcpResult(server, tool.name, result, { readableResources: options.readableResources?.() });
		},
	};
}

/** Renderers of calls to an MCP tool, labeled `server/tool`, also used before the tool is registered. */
// 构造调用/结果两种TUI渲染器，返回回调对象；例：恢复会话时工具尚未连上也能显示server/tool。只渲染数据，不再次调用execute；可复用对应槽组件。
export function createMcpToolRenderers(label: string): ToolRenderers {
	// 创建独立回调对象，每次工具定义可得到一份。
	return {
		// 调用区渲染：接未知args、主题和共享上下文，返回Text；例：未完成参数也可预览，格式化/主题失败向上传播。
		renderCall(args, theme, context) {
			// 有旧Text槽就复用，否则新建无留白Text；as不检查旧对象真是Text，遵守宿主槽约定。
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			// 格式化标题/参数，根据当前展开状态决定单行或详细，setText会使其显示缓存失效。
			component.setText(formatToolCallWithArgs(label, args, theme, context.expanded));
			// 返回组件供宿主布局，不直接写终端。
			return component;
		},
		// 结果区渲染：将结果文字按主题显示，折叠保留5视觉行；例：一条长JSON也会因换行折叠。这里只构造组件，不再执行MCP请求，异常不在本回调统一吞掉。
		renderResult(result, options, theme, context) {
			// 复用旧Container或创建新容器，不和调用区Text槽混用。
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			// 清掉上轮孩子，避免流式更新不断累加旧结果。
			component.clear();
			// 正文做显示清理/图片占位后trim；与模型20KiB裁剪是不同阶段。
			const output = getTextOutput(result, context.showImages).trim();
			// 空正文返回已清容器，不补空白行。
			if (!output) return component;
			// 按上下文isError选显示色，和协议异常抛出不同。
			const color = context.isError ? "error" : "toolOutput";
			// tab先变3空格，再逐行着色。
			const styled = replaceTabs(output)
				// 按LF拆成逻辑行。
				.split("\n")
				// 箭头回调用同一主题颜色处理每行。
				.map((line) => theme.fg(color, line))
				// 重新LF拼成有ANSI样式的文字。
				.join("\n");
			// 正文前加一行视觉留白。
			component.addChild(new Spacer(1));
			// 展开状态直接用Text显示全部已收到结果，不自动读取fullOutputPath原文。
			if (options.expanded) {
				// 完整显示这份styled，工具执行层原来的模型裁剪不在此撤销。
				component.addChild(new Text(styled, 0, 0));
			} else {
				// Limit wrapped lines, not logical ones: MCP results are often one long JSON line.
				// 折叠时添加视觉行预览组件。
				component.addChild(
					// 预览会按实际渲染宽度计算视觉行并缓存。
					new VisualLinePreview({
						// 原styled文字，保留其中终端样式。
						text: styled,
						// 最多5正文视觉行，隐藏提示另占一行。
						maxVisualLines: OUTPUT_PREVIEW_LINES,
						// 保留开头而非结尾。
						keep: "start",
						// 隐藏数回调生成提示，返回styled字符串。
						formatHint: (hidden) =>
							// 展开键从keyHint配置读取，不硬编码按键；多层模板是字符串拼接不是调用模型。
							`${theme.fg("muted", `... (${hidden} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
					}),
				);
				// details可能没有fullOutputPath，断言后可选链读它，不实际验证其他details字段。
				const fullOutputPath = (result.details as McpToolDetails | undefined)?.fullOutputPath;
				// 真值全文路径在折叠视图加一行提示，展开分支没有这条额外提示。
				if (fullOutputPath) component.addChild(new Text(theme.fg("muted", `Full output: ${fullOutputPath}`), 0, 0));
			}
			// 返回当前容器，宿主后续决定布局/绘制。
			return component;
		},
	};
}
