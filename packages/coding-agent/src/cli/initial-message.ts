// 把 stdin、@file 文字和第一句 CLI 提问合成一次起始输入；后续提问保留在 messages 中。
// import type 只让 TypeScript 检查形状，运行时会擦除，不会为这些名字生成取值代码。
import type { ImageContent } from "@earendil-works/pi-ai";
// Args 定义参数解析结果；它不是解析函数，真正解析发生在 args.ts。
import type { Args } from "./args.ts";

// interface 描述对象有哪些字段，不会在运行时 new 出对象或验证命令行输入。
export interface InitialMessageInput {
	// 必填的解析结果；函数会消费其中第一条 messages，因此有可观察的数组修改。
	parsed: Args;
	// ? 表示可不传；@file 处理后的文字已包括文件边界标记。
	fileText?: string;
	// 图片内容块数组；图片不会先转成普通字符串再拼接。
	fileImages?: ImageContent[];
	// stdin 可是空字符串；undefined 才表示没有这份输入。
	stdinContent?: string;
}

// 没有输入时返回的两个字段可为 undefined，并非自动生成一条空 user 消息。
export interface InitialMessageResult {
	// 拼好后供 session.prompt 使用的文字。
	initialMessage?: string;
	// 独立的图片内容块，在 prompt 的 images 选项中传递。
	initialImages?: ImageContent[];
}

/**
 * Combine stdin content, @file text, and the first CLI message into a single
 * initial prompt for non-interactive mode.
 */
/**
 * 按 stdin → 文件文字 → 第一条 CLI 消息的顺序拼起始输入。
 * 返回文字和图片；会用 shift() 从 parsed.messages 移除第一条消息，调用方随后逐条处理剩余消息。
 * 例：stdin="A"、fileText="B"、messages=["C","D"]，得到 initialMessage="ABC"，队列剩 ["D"]。
 * 注意：join("") 不自动插入换行；分隔符必须由输入本身提供。
 */
export function buildInitialMessage({
	// 对象解构：调用方传一个对象，函数直接取出这些同名字段。
	parsed,
	// @file 文本，可不提供。
	fileText,
	// @file 图片，可不提供。
	fileImages,
	// 管道输入文字，可不提供。
	stdinContent,
	// 冒号后的接口约束上面的整个参数对象，末尾接口约束函数返回值。
}: InitialMessageInput): InitialMessageResult {
	// string[] 表示字符串数组；const 固定变量绑定，但数组本身仍可以 push。
	const parts: string[] = [];
	// !== undefined 会保留显式传入的空 stdin，区别于“根本没有 stdin”。
	if (stdinContent !== undefined) {
		// push 在数组尾部追加一个元素，保留输入顺序。
		parts.push(stdinContent);
	}
	// 此处按字符串真假判断，空的 fileText 会跳过；与上面的 stdin 判断略有不同。
	if (fileText) {
		// 文件正文在用户的第一句提问之前，使模型先看到附带材料。
		parts.push(fileText);
	}

	// CLI 可以有多句消息，只把第一句并入初始输入。
	if (parsed.messages.length > 0) {
		// 下标从 0 开始，第 0 项就是第一句。
		parts.push(parsed.messages[0]);
		// shift 修改原数组并移除头部；避免调用方后来重复发送第一句。
		parsed.messages.shift();
	}

	// 返回一个对象，文字与图片分开存放。
	return {
		// 三元表达式：有片段才拼接，否则表示没有初始文字。
		initialMessage: parts.length > 0 ? parts.join("") : undefined,
		// 既要存在数组也要非空；这里复用图片数组，没有深复制图片数据。
		initialImages: fileImages && fileImages.length > 0 ? fileImages : undefined,
	};
}
