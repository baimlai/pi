// 工具参数进入执行前的真实运行时校验边界；开发期 TypeScript 类型不能保证模型发来的 JSON 已经合法。
// compile 是运行时函数，CoercingValidator 是类型；coercing 指按 schema 尝试转换输入形状。
import { type CoercingValidator, compile } from "@earendil-works/pi-schema";
// 提供 schema 中 format 关键字的实际校验实现。
import { formats } from "@earendil-works/pi-schema/formats";
// 工具定义带 parameters schema；工具调用带模型生成的 arguments 与可选解析错误。
import type { Tool, ToolCall } from "../types.ts";

// One compiled validator per schema object: tool schemas are long-lived, so the WeakMap drops entries with their tools.
// 按 schema 对象身份缓存编译结果；WeakMap 不阻止 schema 随工具一起被垃圾回收。
const validatorCache = new WeakMap<object, CoercingValidator>();

// 用途：获取某份参数 schema 的已编译校验器，首次调用才 compile。例同一 readSchema 对象被多轮复用，只需编译一次；会填入本模块缓存。
function getValidator(schema: Tool["parameters"]): CoercingValidator {
	// 按对象引用查缓存，不是按 JSON 字符串查找结构相同的另一个对象。
	const cached = validatorCache.get(schema);
	// 已经编译过就立即复用。
	if (cached) {
		// 避免每次工具调用重复分析 schema。
		return cached;
	}
	// A $ref that names nothing (a dangling definition in an MCP server's schema) rejects only values at its place,
	// instead of making every call of the tool fail.
	// 打开转换，如 schema 数字字段可把字符串数字转成数；找不到的 $ref 只让对应位置拒绝，不使所有调用都无法编译。
	const validator = compile(schema, { formats, coerce: true, unresolvedRefs: "reject" });
	// 保存这份 schema 对应的校验器供之后使用。
	validatorCache.set(schema, validator);
	// 把实际校验器交给参数处理函数。
	return validator;
}

/** A pi-schema error path (a JSON Pointer) as the dotted path the model sees: `/edits/0/oldText` -> `edits.0.oldText`. */
// 用途：将 JSON Pointer 错误路径转成给模型看的点分路径。例 /edits/0/oldText 变 edits.0.oldText；只是展示，不用这条字符串访问对象。
function formatValidationPath(pointer: string): string {
	// 空 JSON Pointer 指整个根值，显示为 root。
	if (pointer === "") return "root";
	// 通过下面的连续转换还原路径片段。
	return (
		pointer
			// 移除 JSON Pointer 开头的斜杠。
			.slice(1)
			// 按路径分隔符拆分，例如 edits、0、oldText。
			.split("/")
			// 按 JSON Pointer 的转义规则还原斜杠和波浪线，顺序不能随意反过来。
			.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
			// 把片段用点连接，生成可读错误位置。
			.join(".")
	);
}

/**
 * Finds a tool by name and validates the tool call arguments against its JSON Schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
// 用途：先按名字找工具，再校验参数。例模型请求 read 时匹配 tools 中 name=read；找不到工具或参数不合法就抛错，交给 Agent 转成错误结果。原 any 是既有宽类型，不代表跳过运行时校验。
export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
	// find 返回第一个同名工具，找不到则为 undefined。
	const tool = tools.find((t) => t.name === toolCall.name);
	// 模型可能给出未注册工具名，必须在执行前明确拒绝。
	if (!tool) {
		// 把模型实际请求的工具名写入错误说明。
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	// 工具已找到，复用下面同一套解析错误和 schema 校验流程。
	return validateToolArguments(tool, toolCall);
}

/**
 * Validates tool call arguments against the tool's JSON Schema (any JSON Schema: pi-schema's builders, TypeBox, plain
 * objects). The arguments are coerced first (pi-schema's `parse()`): models often send `"42"` for a number, a single
 * value for an array, or `null` for an omitted optional property.
 * @param tool The tool definition with its JSON Schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
// 用途：校验并返回可执行参数，必要时按 schema 转换。先拦已知 JSON 解析错误，再拷贝参数给校验器；例字符串 "42" 可按数字 schema 转成 42，不改历史中的原始 toolCall。
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	// 完整工具参数 JSON 若之前解析失败，不应拿补出的空对象当正常参数执行。
	if (toolCall.argumentsError) {
		// 保留解析器记录的具体错误，下一轮模型可以据此修正 JSON。
		throw new Error(`Invalid arguments for tool "${toolCall.name}": ${toolCall.argumentsError}`);
	}
	// A copy, so tools that modify their arguments never modify the tool call in the transcript.
	// 深拷贝隔离工具和历史；parse 同时进行约定转换与 schema 验证，返回 ok/value 或错误列表。
	const result = getValidator(tool.parameters).parse(structuredClone(toolCall.arguments));
	// ok 标签让 TS 知道成功分支具有 value。
	if (result.ok) {
		// 交给真正工具实现的是校验/转换后的参数，而非模型原始对象。
		return result.value;
	}

	// 把每一处错误转换成带路径的说明，再按行拼接，便于模型一次看全。
	const errors = result.errors.map((error) => `  - ${formatValidationPath(error.path)}: ${error.message}`).join("\n");

	// 同时附上失败原因与原始参数；JSON.stringify 的第三参数 2 表示两空格缩进。
	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

	// 失败通过异常交给上层工具管线；这里不擅自执行工具或请求模型重试。
	throw new Error(errorMessage);
}
