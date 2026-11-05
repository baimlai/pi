// 抽取消息文字并渲染 system 补丁；模型适配器和上下文估算复用这些函数，不在此调用模型。
// 只导入内容块与系统消息类型，运行时不为这些类型生成对象。
import type { ImageContent, SystemMessage, TextContent, ThinkingContent, ToolCall } from "../types.ts";

// 一块消息内容可以是文字、图片、思考或工具调用；| 表示其中一种。
type Content = TextContent | ImageContent | ThinkingContent | ToolCall;

/** Extract and join text from message content. */
// 用途：从内容中只取文字块并拼接。例 [文字 A, 图片, 文字 B] 默认得到 A 换行 B；字符串输入原样返回，不把思考/工具参数当正文。
export function contentText(content: string | readonly Content[], separator = "\n"): string {
	// 处理合法联合类型的字符串分支；剩下分支 TS 可知是内容块数组。
	if (typeof content === "string") return content;
	// 对数组依次筛选、映射和拼接，整个链最终返回字符串。
	return (
		content
			// 用 type 标签只保留 TextContent；TS 能据此收窄后续 block 的字段。
			.filter((block) => block.type === "text")
			// 从每个文字块取出 text 字符串，得到字符串数组。
			.map((block) => block.text)
			// 按指定分隔符连接；调用方可传空字符串实现无分隔拼接。
			.join(separator)
	);
}

/** Render a system message as a complete prompt: its content followed by its sections. */
// 用途：把一条系统消息正文和非删除章节拼成完整提示词。例正文“规则”加 sections.style="简短"，以空行分隔；不重放其他 system 消息。
export function getSystemMessageText(message: SystemMessage): string {
	// 先抽出该条消息自己的正文，作为第一段。
	const parts = [contentText(message.content)];
	// 遍历章节值；没提供 sections 时遍历空对象。
	for (const text of Object.values(message.sections ?? {})) {
		// null 代表章节删除标记，不应拼成正文；非 null 的字符串加入段落列表。
		if (text !== null) parts.push(text);
	}
	// 去掉空段，再用两个换行形成段落间隔。
	return parts.filter((part) => part.length > 0).join("\n\n");
}

/**
 * Render a later system message for APIs that accept system messages mid-conversation.
 * Section changes are framed by name so the model can relate them to the leading prompt.
 * This framing is request-time only and may change between versions.
 */
// 用途：给支持对话中途 system 的供应商生成带章节名的更新说明。例 sections.style=null 生成“删除 style 章节”的文字；不修改历史消息。
export function renderSystemMessageUpdate(message: SystemMessage): string {
	// 准备文字段落；string[] 是字符串数组类型。
	const parts: string[] = [];
	// 抽出这条更新消息附带的普通文字。
	const text = contentText(message.content);
	// 仅非空正文才加入，避免多出无意义空段。
	if (text.length > 0) parts.push(text);
	// 键值对解构，既需要章节名字，也需要该章节的新值或删除标记。
	for (const [name, value] of Object.entries(message.sections ?? {})) {
		// 每个章节变更变成一个完整说明段落。
		parts.push(
			// null 精确表示删除；空字符串则仍是一次更新，不是删除。
			value === null
				? // 删除分支用章节名说明哪一块规则失效；这是实际给模型看的英文内容，保持原样。
					`Removed system prompt section "${name}".`
				: // 更新分支同时写章节名与新规则，帮助模型把补丁关联到先前提示词。
					`Updated system prompt section "${name}":\n\n${value}`,
		);
	}
	// 各段用空行拼接，保留章节内容本身。
	return parts.join("\n\n");
}

/**
 * `text.slice(start, end)` as a string of its own. V8 represents a slice of 13 or more characters as a view that keeps
 * all of `text` alive, so a short excerpt kept from a large text (a 500-character error message cut from a megabyte
 * response body) would keep the whole text alive as long as the excerpt lives. Appending a character and slicing it off
 * again makes V8 copy just the slice.
 */
// 用途：截取并尽量让 V8 为结果拥有独立存储，避免短错误片段保留整个巨大响应体。例取 1MB 文本前 500 字；输出内容等同 text.slice(start,end)。
export function ownedSlice(text: string, start: number, end = text.length): string {
	// 先给片段追加一个空格再去掉最后一字，促使 V8 复制片段；-1 表示结尾前一个位置。
	return `${text.slice(start, end)} `.slice(0, -1);
}
