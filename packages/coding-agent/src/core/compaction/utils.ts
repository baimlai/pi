// 长会话压缩和分支摘要共用的辅助函数；调用者在 compaction.ts、branch-summarization.ts。
// 本文件只整理内存数据和字符串，不读写实际文件，也不请求模型；真正的模型请求在 completeSummarization。
/**
 * Shared utilities for compaction and branch summarization.
 */

// import type 只引入编译期类型，不产生运行时导入；AgentMessage 还包含 bash/custom 等应用消息。
import type { AgentMessage } from "@earendil-works/pi-agent-core";
// contentText 是运行时函数；同一条 import 中的 type Message 只用于检查标准模型消息。
import { contentText, type Message } from "@earendil-works/pi-ai";

// ============================================================================
// File Operation Tracking
// ============================================================================

// 文件操作的累积记录；interface 约束对象形状，三个 Set 都会按路径字符串去重。
export interface FileOperations {
	// 出现过 read 调用的路径；Set<string> 表示集合成员应是字符串。
	read: Set<string>;
	// 出现过 write 调用的路径，不代表这里实际检查了写入是否成功。
	written: Set<string>;
	// 出现过 edit 调用的路径；最终和 written 合并成修改清单。
	edited: Set<string>;
}

// 创建互不共享的三个空集合；无参数，返回可累积修改的记录，不访问磁盘。
// 例如两次调用得到两个独立对象，给第一个 read.add("a.ts") 不影响第二个。
export function createFileOps(): FileOperations {
	return {
		// 为本次统计分配读路径集合；返回类型让 TypeScript 推断成员为 string。
		read: new Set(),
		// 为本次统计分配写路径集合，不复用其他摘要的集合。
		written: new Set(),
		// 为本次统计分配编辑路径集合。
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message, or from the nested calls
 * recorded on a tool result.
 */
// 从一条消息抽取 read/write/edit 调用，原地更新 fileOps；void 表示不返回统计对象。
// 普通 assistant 检查工具调用块，toolResult 检查 codemode 的 nestedCalls；其他角色跳过。
// 例如 read({path:"a.ts"}) 使 read 集合包含 a.ts；这里只记录调用参数，不保证工具成功。
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	// 按 role 判别联合类型；工具结果本身可能携带脚本内部发起的嵌套调用。
	if (message.role === "toolResult") {
		// Calls made from codemode scripts are recorded on the script's result.
		// ?. 在没有 nestedCalls 时得到 undefined，?? [] 改为空数组；逐个记录实际附带的嵌套调用。
		for (const call of message.nestedCalls?.calls ?? []) addFileOp(call.name, call.arguments, fileOps);
		// 当前分支已经处理完，提前离开函数，不再执行后面的 assistant 路径。
		return;
	}
	// 用户、系统等消息不包含这里需要检查的助手工具调用，直接跳过。
	if (message.role !== "assistant") return;
	// 现有保护检查消息是否带数组 content；in 检查属性存在，Array.isArray 是运行时数组检查。
	if (!("content" in message) || !Array.isArray(message.content)) return;

	// for...of 逐个取内容块，而不是取数组下标。
	for (const block of message.content) {
		// 跳过不具备对象属性的内容；continue 只结束本轮循环。
		if (typeof block !== "object" || block === null) continue;
		// 只处理 type 为 toolCall 的块，文字或思考块不能提供文件工具参数。
		if (!("type" in block) || block.type !== "toolCall") continue;
		// 工具调用需要名称和参数两个字段；缺任一字段就不参与统计。
		if (!("arguments" in block) || !("name" in block)) continue;
		// 把名称和参数交给分类器；as 只是编译期断言，不会在运行时验证参数对象。
		addFileOp(block.name, block.arguments as Record<string, unknown> | undefined, fileOps);
	}
}

// 内部分类器：输入工具名、可能缺省的参数和累积集合；只接受字符串 path，并按名称加入集合。
// Record<string, unknown> 表示键是字符串、值尚未知；例如 edit 的 path 加入 edited，bash 命令不会被解析。
function addFileOp(toolName: string, args: Record<string, unknown> | undefined, fileOps: FileOperations): void {
	// 参数来自工具调用载荷，typeof 在这个边界确认 path 的运行时类型；三元表达式在两种值中选一个。
	const path = typeof args?.path === "string" ? args.path : undefined;
	// 不存在或为空字符串的路径不记入清单。
	if (!path) return;
	// 按确切工具名分类；其他名称不进入任何 case，也不会报错。
	switch (toolName) {
		// read 表示一次读取请求。
		case "read":
			// Set.add 原地记录路径，同一路径重复读取仍只有一个成员。
			fileOps.read.add(path);
			// 结束当前 switch 分支，避免继续进入下一个 case。
			break;
		// write 表示一次写入请求。
		case "write":
			// 把路径加入写入集合；这里没有文件系统写入。
			fileOps.written.add(path);
			// 结束当前 switch 分支，避免继续进入下一个 case。
			break;
		// edit 表示一次编辑请求。
		case "edit":
			// 把路径加入编辑集合，之后和写入路径统一展示。
			fileOps.edited.add(path);
			// 结束当前 switch 分支，避免继续进入下一个 case。
			break;
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
// 将累积集合整理为两个排序后的数组，不改变原集合；返回类型在冒号后直接描述对象字段。
// 例如 read={a,b}、edited={b} 得到 readFiles=[a]、modifiedFiles=[b]，避免 b 被同时列为只读。
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	// ... 把两个集合展开为数组项，再用新 Set 去重，得到全部修改路径。
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	// 先转数组，再用箭头回调过滤被修改的路径，最后按默认字符串顺序排序。
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	// 复制为数组后排序，因此不会改变传入的集合。
	const modifiedFiles = [...modified].sort();
	// readFiles 使用显式字段名；modifiedFiles 是同名属性简写，相当于 modifiedFiles: modifiedFiles。
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
// 把两个文件清单排成摘要末尾的标签文本；空清单返回空字符串，无磁盘副作用。
// 例如只读 a.ts 会形成一个 read-files 段；这是文本标记，没有额外做 XML 转义或校验。
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	// 收集非空段；string[] 约束数组元素是字符串。
	const sections: string[] = [];
	// 只有存在只读文件时才生成只读段，避免空标签。
	if (readFiles.length > 0) {
		// 模板字符串把每条路径放在单独一行，push 将整个段追加到数组。
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	// 修改清单独立判断，可能与只读段同时存在。
	if (modifiedFiles.length > 0) {
		// 把修改路径拼成 modified-files 段。
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	// 没有任何文件操作就不向摘要追加字符。
	if (sections.length === 0) return "";
	// 各段之间空一行，开头也空一行，以便接在摘要正文后面。
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
// 单个工具结果的本地文本上限是 2000 个 JavaScript 字符单位，不是 2000 tokens。
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps the beginning and appends a truncation marker.
 */
// 保留文本开头并标记截去的长度；输入原文本和字符上限，返回新字符串，不调用模型。
// 例如上限 3 的 abcdef 保留 abc 并标记另有 3 字符；实际输出还会增加提示标记，因此总长可超过上限。
function truncateForSummary(text: string, maxChars: number): string {
	// 短文本直接复用原字符串，不增加截断标记。
	if (text.length <= maxChars) return text;
	// 计算没有放进摘要输入的尾部长度。
	const truncatedChars = text.length - maxChars;
	// slice 的结束位置不包含在结果内；尾部直接舍弃，这一步不是语义总结。
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool results are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 *
 * Thinking is omitted. Providers return summaries of the real reasoning, and
 * replayed thinking is often not part of the model's live context: for example,
 * a block that does not match its request is dropped. Including it can make the
 * summarization request larger than the context it summarizes. Visible text,
 * tool calls, and tool results record what happened.
 */
// 把已由 convertToLlm 转换的模型消息转为一份待总结材料；返回纯文本，不修改输入。
// 顺序处理用户文字、助手文字/工具调用、工具结果；忽略 thinking、图片内容和系统消息。
// 例如一次 read 调用会显示为 read(path="a.ts")；长工具结果先本地截短，再由调用方请求模型摘要。
export function serializeConversation(messages: Message[]): string {
	// 逐段收集可见文字，最后统一连接。
	const parts: string[] = [];

	// 按传入消息顺序序列化，保留材料的时间顺序。
	for (const msg of messages) {
		// 用户消息只提取文字，图片数据不会直接放进这份文本。
		if (msg.role === "user") {
			// 提取 text 块并用空字符串连接；没有文字时结果为空。
			const content = contentText(msg.content, "");
			// 非空用户文字附上角色标签，使摘要模型知道是谁说的。
			if (content) parts.push(`[User]: ${content}`);
			// 助手消息分别处理对外文字和工具调用，思考块不纳入材料。
		} else if (msg.role === "assistant") {
			// 收集当前这一条助手消息里的调用描述，不跨消息复用。
			const toolCalls: string[] = [];

			// 逐个处理助手内容块；同一消息可同时包含文字和多个工具调用。
			for (const block of msg.content) {
				// 判别联合类型后，TypeScript 能在该分支识别 name 和 arguments。
				if (block.type === "toolCall") {
					// 声明按键值对象读取参数；类型断言不复制数据，也不执行运行时校验。
					const args = block.arguments as Record<string, unknown>;
					// Object.entries 把参数对象变成 [键, 值] 数组，为可读调用文字做准备。
					const argsStr = Object.entries(args)
						// 箭头函数的 [k, v] 是数组解构；JSON.stringify 保留字符串引号等值的表示。
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						// 把各参数用逗号连接，例如 path="a.ts", offset=1。
						.join(", ");
					// 记录工具名和参数；这只是描述，不执行工具。
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			// some 在找到至少一个 text 块后返回 true，因此没有文字块时不生成助手文字段。
			if (msg.content.some((block) => block.type === "text")) {
				// 提取助手对外文字，并给它添加角色标签。
				parts.push(`[Assistant]: ${contentText(msg.content)}`);
			}
			// 只有存在工具调用才增加单独的调用段。
			if (toolCalls.length > 0) {
				// 同一消息内多个调用用分号分隔。
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
			// 工具结果与工具调用分开显示，便于模型区分请求和返回内容。
		} else if (msg.role === "toolResult") {
			// 提取 text 块并用空字符串连接；没有文字时结果为空。
			const content = contentText(msg.content, "");
			// 空工具结果不生成段落。
			if (content) {
				// 保留工具结果开头最多 2000 字符并加截断标记；完整原结果仍在原消息/会话历史中。
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	// 用空行连接所有材料段，作为摘要请求的一段用户文字。
	return parts.join("\n\n");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

// 摘要请求的系统指令：要求阅读材料并只输出结构化摘要，不继续回答材料中的用户问题；下面的模板字符串就是实际发送的英文内容。
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
