// 模型工具参数的JSON处理：流式中间片段允许临时预览，完整调用结束时则必须重新严格解析并报告错误。
// 导入第三方容错解析函数并改名，区分它与标准JSON.parse；它可能抛异常或解析不完整前缀。
import { parse as partialParse } from "partial-json";
// 使用工具调用的arguments/argumentsError类型，不创建工具调用实例。
import type { ToolCall } from "../types.ts";

// JSON短转义允许的反斜杠后字符集合；Unicode的u需要另查后面4位十六进制。
const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

// 用途：识别JSON字符串中需要转义的U+0000到U+001F控制字符。例真实换行为true，普通字母为false；只判断单个传入字符。
function isControlCharacter(char: string): boolean {
	// 取首个Unicode码点，空字符串可能得到undefined。
	const codePoint = char.codePointAt(0);
	// 同时验证存在和范围，0x是十六进制数字写法。
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

// 用途：把原始控制字符变成JSON可接受的转义文本。例真实换行变两个字符反斜杠+n，其他控制字符用四位Unicode转义。
function escapeControlCharacter(char: string): string {
	// 常见控制字符用短转义，其他字符走default。
	switch (char) {
		// 退格字符的短转义分支。
		case "\b":
			// 字符串字面量的双反斜杠表示返回一个真实反斜杠。
			return "\\b";
		// 换页控制字符分支。
		case "\f":
			// 返回JSON中的反斜杠f文本。
			return "\\f";
		// 这里匹配真实换行，不是字符n。
		case "\n":
			// 把真实换行改成JSON字符串中的合法短转义。
			return "\\n";
		// 回车字符也要转义。
		case "\r":
			// 返回反斜杠r文本。
			return "\\r";
		// 制表符分支。
		case "\t":
			// 返回反斜杠t文本。
			return "\\t";
		// 没有专用分支时，使用后面的通用处理。
		default:
			// 转十六进制并左补0至四位，?.处理缺失码点，??提供0000兜底。
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 */
// 用途：只修字符串内部的原始控制符和无效转义，不保证修好任意JSON。例模型给路径中的无效反斜杠转义，会把反斜杠保留为字面文字；不调用模型纠错。
export function repairJson(json: string): string {
	// 逐段累加输出，输入json字符串保持不变。
	let repaired = "";
	// 记录当前是否位于双引号字符串中；字符串外不改控制字符。
	let inString = false;

	// 逐个UTF-16码元扫描，某些合法转义会在内部额外推进index。
	for (let index = 0; index < json.length; index++) {
		// 取当前字符；index由循环范围保证在字符串内。
		const char = json[index];

		// 字符串外的对象标点、数字等不在本函数修复范围。
		if (!inString) {
			// 原样保留当前字符，或在字符串内保留关闭引号。
			repaired += char;
			// 遇到未作为转义消费的双引号，会开始或结束字符串。
			if (char === '"') {
				// 从现在起按照JSON字符串内容解释后续字符。
				inString = true;
			}
			// 本字符已处理，跳到下一次扫描，避免继续落进其他分支。
			continue;
		}

		// 遇到未作为转义消费的双引号，会开始或结束字符串。
		if (char === '"') {
			// 原样保留当前字符，或在字符串内保留关闭引号。
			repaired += char;
			// 未转义双引号结束字符串，后续回到结构/数字的原样复制。
			inString = false;
			// 本字符已处理，跳到下一次扫描，避免继续落进其他分支。
			continue;
		}

		// 反斜杠可能开启短转义或Unicode转义，需检查下一个字符。
		if (char === "\\") {
			// 查看后继字符，不立即推进index。
			const nextChar = json[index + 1];
			// 末尾孤立反斜杠无法构成合法转义。
			if (nextChar === undefined) {
				// 补成JSON文本中的双反斜杠，表示一个字面反斜杠。
				repaired += "\\\\";
				// 本字符已处理，跳到下一次扫描，避免继续落进其他分支。
				continue;
			}

			// Unicode转义必须有4个十六进制数字，不能只看一个u就认定有效。
			if (nextChar === "u") {
				// 取反斜杠u后最多四个字符，slice终点不含在内。
				const unicodeDigits = json.slice(index + 2, index + 6);
				// ^和$限制整个候选恰好是4位合法十六进制，不接受半段。
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					// 有效Unicode转义原样保留，而不是在这里解码成字符。
					repaired += `\\u${unicodeDigits}`;
					// 当前位置是反斜杠，额外跳过u和4位数字，循环末尾还会再加1。
					index += 5;
					// 本字符已处理，跳到下一次扫描，避免继续落进其他分支。
					continue;
				}
			}

			// 短转义在允许集合中时，作为一对整体保留。
			if (VALID_JSON_ESCAPES.has(nextChar)) {
				// 保留合法短转义文本，例如反斜杠n。
				repaired += `\\${nextChar}`;
				// 短转义的后一个字符已经消费，避免下次重复处理。
				index += 1;
				// 本字符已处理，跳到下一次扫描，避免继续落进其他分支。
				continue;
			}

			// 补成JSON文本中的双反斜杠，表示一个字面反斜杠。
			repaired += "\\\\";
			// 本字符已处理，跳到下一次扫描，避免继续落进其他分支。
			continue;
		}

		// 普通字符串字符原样保留，真实控制字符换成JSON转义。
		repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
	}

	// 返回候选修复文本；仍可能有缺括号等其他语法错误。
	return repaired;
}

// 用途：先标准JSON解析，失败时仅尝试上述有限修复。例原始换行破坏字符串时可修；泛型T只是调用者声称的结果类型，不验证业务schema。
export function parseJsonWithRepair<T>(json: string): T {
	try {
		// 先走完整JSON标准语法；as T不会验证解析值实际结构。
		return JSON.parse(json) as T;
		// 保留第一次解析错误，若文本完全无法修复则原样重抛。
	} catch (error) {
		// 尝试修复字符串内容的问题，不做任意“猜结构”。
		const repairedJson = repairJson(json);
		// 文本确实改变时才值得再解析一次。
		if (repairedJson !== json) {
			// 修复后的完整JSON仍不合法就继续抛异常，由调用者处理。
			return JSON.parse(repairedJson) as T;
		}
		// 没有任何可修变化时保留原始错误，而非静默返回空对象。
		throw error;
	}
}

/**
 * Parses the model's complete arguments text of a finished tool call.
 *
 * Unlike {@link parseStreamingJson}, this never keeps a partially parsed prefix: once the call is
 * finished, text that is not a valid JSON object means the model sent malformed arguments. In that
 * case `arguments` is `{}` and `argumentsError` describes the problem, including the text the
 * model sent, so tool validation can report it back to the model.
 */
// 用途：完整工具调用结束后的参数解析。空文本视为空参数；非对象、数组、坏JSON都会返回{}并附argumentsError，供执行前明确失败，避免把残缺前缀当完整参数。
export function parseToolCallArguments(json: string | undefined): Pick<ToolCall, "arguments" | "argumentsError"> {
	// 无参数/纯空白得到空对象；?.允许未提供字符串。
	if (!json?.trim()) return { arguments: {} };
	try {
		// 索引访问类型复用ToolCall的参数形状，但远端真实JSON仍要在下一行检查。
		const parsed = parseJsonWithRepair<ToolCall["arguments"] | null>(json);
		// 信任边界：完整工具参数必须是JSON对象，null和数组虽然typeof为object仍不可执行。
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			// 把非对象结果归为明确解析问题，随后由catch整理给模型。
			throw new Error("Tool arguments must be a JSON object");
		}
		// 语法与顶层对象形状合格；具体必填字段/类型仍由validation.ts按工具schema检查。
		return { arguments: parsed };
		// 保留第一次解析错误，若文本完全无法修复则原样重抛。
	} catch (error) {
		return {
			// 失败时清空参数，不能保留一部分看似可执行的前缀。
			arguments: {},
			// 同时保留错误文字与完整原输入，下一轮模型能看见需要修正哪段。
			argumentsError: `${error instanceof Error ? error.message : String(error)}\n\nReceived arguments:\n${json}`,
		};
	}
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
// 用途：流式展示期间尽力解析不完整JSON，所有尝试失败才给空对象。例只到 {"path":"a 可先预览已有字段；不能用这份预览直接执行最终工具。T默认是字符串键未知值字典。
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	// 尚未收到参数字符时，给调用方稳定的空预览。
	if (!partialJson || partialJson.trim() === "") {
		// 这里是容错兜底断言，不能证明空对象符合任意调用者指定的T。
		return {} as T;
	}

	try {
		// 先尝试完整解析和有限字符串修复，成功则不必走第三方部分解析。
		return parseJsonWithRepair<T>(partialJson);
	} catch {
		try {
			// 标准解析失败，再让第三方解析器读不完整前缀；此过程也可能失败。
			const result = partialParse(partialJson);
			// 部分解析没有值时退为空对象，泛型断言本身不做schema检查。
			return (result ?? {}) as T;
		} catch {
			try {
				// 最后尝试先修字符串再做部分解析，尽量维持流式可见内容。
				const result = partialParse(repairJson(partialJson));
				// 部分解析没有值时退为空对象，泛型断言本身不做schema检查。
				return (result ?? {}) as T;
			} catch {
				// 这里是容错兜底断言，不能证明空对象符合任意调用者指定的T。
				return {} as T;
			}
		}
	}
}
