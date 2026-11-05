// 定义应用层消息和到模型消息的转换；被 Agent 请求边界及摘要流程复用。
/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

// 压缩摘要的模型可见前缀。下面反引号中的换行与标记属于实际发送内容，保持原文不插注释。
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

// 用 XML 风格闭标签结束摘要边界；这里只提供文本包装，不进行 XML 解析。
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

// 分支摘要的说明不同：它解释的是刚返回的另一分支，而非当前历史被压缩。
export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

// 与分支摘要前缀配套的结束标签。
export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * Message type for bash executions via the ! command.
 */
// 记录 !命令的执行信息；不是模型工具调用的 toolResult，进入模型前需转换成普通消息。
export interface BashExecutionMessage {
	// 字面量角色是联合类型的分辨字段，convertToLlm 可据此进入专属分支。
	role: "bashExecution";
	// 用户手动运行的命令原文，转换成模型文字时会显示它。
	command: string;
	// 捕获的命令输出文字，可能已受执行器输出上限限制。
	output: string;
	// 退出码可缺失，例如尚无正常退出结果；0 通常表示成功。
	exitCode: number | undefined;
	// 是否被取消；转换时优先说明取消，而非同时只报退出码。
	cancelled: boolean;
	// 输出是否截断，配合完整输出路径供模型后续回查。
	truncated: boolean;
	// 可选的完整输出文件位置；路径存在字段并不保证文件永久保留。
	fullOutputPath?: string;
	// 消息毫秒时间戳，模型消息转换时沿用，不重新生成发送时间。
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	// true 表示不发给模型，例如 !! 命令；不表示从用户会话记录或 UI 删除。
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
// 扩展自定义消息。泛型 T 描述详情形状，默认 unknown 要求使用者先了解类型再读取字段。
export interface CustomMessage<T = unknown> {
	// 固定角色，后续会转换为模型认识的 user。
	role: "custom";
	// 扩展消息分类，供 UI/扩展选择处理方式，不是供应商协议角色。
	customType: string;
	// 内容可为纯字符串，也可为文字/图片块数组；竖线表示两种可选形状。
	content: string | (TextContent | ImageContent)[];
	// 控制是否在 UI 展示；它不是禁止进入模型上下文的开关。
	display: boolean;
	// 可选的程序化详情，不作为这里 user 消息正文发出。
	details?: T;
	// 消息毫秒时间戳，模型消息转换时沿用，不重新生成发送时间。
	timestamp: number;
}

// 从其他会话分支回到当前分支时携带的摘要消息。
export interface BranchSummaryMessage {
	// 分支摘要专用标签，转换时会附加分支摘要的英文前后标记。
	role: "branchSummary";
	// 已经生成好的摘要文字；本模块只包装，不负责调用模型总结。
	summary: string;
	// 来源条目 id，null 表示类型允许没有来源；与完整消息 id 是不同概念。
	fromId: string | null;
	// 消息毫秒时间戳，模型消息转换时沿用，不重新生成发送时间。
	timestamp: number;
}

// 较早对话被压缩后的摘要消息，供有效上下文投影使用。
export interface CompactionSummaryMessage {
	// 压缩摘要专用标签，转换时加摘要前后缀并成为 user 消息。
	role: "compactionSummary";
	// 已经生成好的摘要文字；本模块只包装，不负责调用模型总结。
	summary: string;
	// 压缩前的 token 统计/估算，用于记录压缩背景；不在这里重新计算。
	tokensBefore: number;
	// 消息毫秒时间戳，模型消息转换时沿用，不重新生成发送时间。
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
// 声明合并：给另一个模块开放的 CustomAgentMessages 接口补类型成员；运行时不执行注册操作。
declare module "@earendil-works/pi-agent-core" {
	// 与 agent 包同名接口合并，使 AgentMessage 联合类型包含下面四类应用消息。
	interface CustomAgentMessages {
		// 键名对应自定义消息类别，值是该类别完整结构。
		bashExecution: BashExecutionMessage;
		// 让低层 Agent 在类型层面接受扩展自定义消息。
		custom: CustomMessage;
		// 让 Agent 的消息联合包含分支摘要。
		branchSummary: BranchSummaryMessage;
		// 让 Agent 的消息联合包含压缩摘要，之后仍需运行时转换才能发给供应商。
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
/**
 * 把已经执行过的 shell 记录格式化成给模型看的说明，不执行命令本身。
 * 流程：命令名 → 有围栏的输出/无输出占位 → 取消或退出码 → 截断文件位置。
 * 例：echo hi 的输出为 hi 时，模型看到命令和 hi；取消的命令另附取消说明。
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	// 先写执行的命令名，随后追加输出和状态说明。
	let text = `Ran \`${msg.command}\`\n`;
	// 有输出才放代码围栏；空输出会走另一分支显示明确占位。
	if (msg.output) {
		// 把原始输出放进 Markdown 代码围栏，只改变展示包装，不在这里重跑命令。
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		// 空输出也明确说明，避免模型误以为输出字段意外缺失。
		text += "(no output)";
	}
	// 取消信息优先；如果已取消，就不再走后面的非零退出码提示分支。
	if (msg.cancelled) {
		// 追加取消状态，让模型不要把被取消的命令当作正常完成。
		text += "\n\n(command cancelled)";
		// 只提示确实存在且非零的退出码；兼顾旧/外部输入可能出现的 null。
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		// 附上非零退出码；含义由命令定义，例如 grep 无匹配也可返回 1，不能仅据此断言程序异常。
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	// 既被截断又有完整输出位置，才给出后续回查提示。
	if (msg.truncated && msg.fullOutputPath) {
		// 给出可回查路径，不能仅凭被截断片段断言整份输出已经看完。
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	// 返回格式化正文，不在此执行 shell，也不修改原消息对象。
	return text;
}

/**
 * 包装分支摘要及来源，将存储时间字符串转为毫秒。没有模型调用或磁盘写入。
 * 例：summary="已修复登录"、fromId="entry-a"，返回 role 为 branchSummary 的消息。
 */
export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		// 保留应用层摘要角色，后面 convertToLlm 才转成 user。
		role: "branchSummary",
		// 对象字段简写，直接保存传入的摘要正文。
		summary,
		// 保留分支来源，方便会话层追踪。
		fromId,
		// 把存储中的时间字符串解析成毫秒数；本函数按调用方保证的时间格式使用，没有额外验证。
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * 包装已生成的历史摘要，保留压缩前 token 数，并转换时间戳。
 * 参数 summary 为摘要、tokensBefore 为压缩前记录值、timestamp 为存储时间；返回应用层消息。
 * 例：传入摘要和 12000，会记录 tokensBefore=12000，不会在此重新估算。
 */
export function createCompactionSummaryMessage(
	// 已经生成的摘要文字，不是在本函数里向模型索取的结果。
	summary: string,
	// 压缩前记录的 token 数，供历史和 UI 表示压缩规模。
	tokensBefore: number,
	// 存储层使用的时间字符串，返回消息使用毫秒时间戳。
	timestamp: string,
): CompactionSummaryMessage {
	return {
		// 把现成摘要包装成应用层压缩消息；不会再次调用模型。
		role: "compactionSummary",
		// 显式的属性名和值与 summary 简写效果相同，原写法保持不变。
		summary: summary,
		// 保留调用方提供的压缩前用量。
		tokensBefore,
		// 把存储中的时间字符串解析成毫秒数；本函数按调用方保证的时间格式使用，没有额外验证。
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
/**
 * 把会话中的扩展消息条目包装成 AgentMessage 能接收的 custom 结构。
 * 输入包括分类、正文、显示开关、详情和时间字符串；返回新消息对象，不执行扩展。
 * 例如 display=false 只表达 UI 显示偏好，convertToLlm 仍会把正文发送给模型。
 */
export function createCustomMessage(
	// 扩展定义的分类名称，例如任务通知；不等同于模型角色。
	customType: string,
	// 可以直接传文字，或包含图片的内容块数组。
	content: string | (TextContent | ImageContent)[],
	// 是否展示给人；模型转换并不因为 false 而过滤正文。
	display: boolean,
	// unknown 详情要由知道具体结构的扩展自己解释，可显式传 undefined。
	details: unknown | undefined,
	// 源记录中的时间字符串。
	timestamp: string,
): CustomMessage {
	return {
		// 构造扩展消息的固定角色标签。
		role: "custom",
		// 保存扩展自己的分类名。
		customType,
		// 保留字符串或块数组内容；不在此深复制图片数据。
		content,
		// 原样保存显示开关；后面的模型转换不依据它过滤内容。
		display,
		// 附带扩展详情，供程序或 UI 使用。
		details,
		// 把存储中的时间字符串解析成毫秒数；本函数按调用方保证的时间格式使用，没有额外验证。
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
/**
 * 把应用层消息数组转换为供应商支持的消息数组。不是 token 压缩，也不是网络请求。
 * 流程：按 role 处理 shell/custom/两类摘要 → 透传标准角色 → 过滤明确跳过的消息。
 * 例：excludeFromContext=true 的 bashExecution 被移除，display=false 的 custom 正文仍转换成 user。
 * 不改原数组，但若直接透传某条标准消息，结果数组与原数组仍共享那个消息对象。
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	// 开始数组转换链：先逐条 map 成模型消息或 undefined，再过滤不发送的消息。
	return (
		messages
			// 回调显式返回联合类型，允许某类消息产生 undefined 表示跳过。
			.map((m): Message | undefined => {
				// 用 role 收窄联合类型，进入不同分支后，TS 知道这个消息有哪些专属字段。
				switch (m.role) {
					// 把手动 shell 命令和结果转成说明文字，不伪造一个模型 toolCall。
					case "bashExecution":
						// Skip messages excluded from context (!! prefix)
						// 只在该标记为 true 时不发送，例如 !! 命令。
						if (m.excludeFromContext) {
							// 该消息不产生模型输入；最后 filter 会移除这个占位结果。
							return undefined;
						}
						return {
							// 供应商只接收其支持的角色，这些应用层内容统一作为 user 消息。
							role: "user",
							// 把命令/输出/取消等信息格式化为一个文字块。
							content: [{ type: "text", text: bashExecutionToText(m) }],
							// 保留原消息时间戳，不改变事件的时间含义。
							timestamp: m.timestamp,
						};
					// 花括号创建这个 case 的局部作用域，避免与其他分支的 const 名称冲突。
					case "custom": {
						// 字符串转成一个文字块；as const 保留 type 的字面量类型，已有块数组直接复用。
						const content =
							typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
						return {
							// 供应商只接收其支持的角色，这些应用层内容统一作为 user 消息。
							role: "user",
							// 保留字符串或块数组内容；不在此深复制图片数据。
							content,
							// 保留原消息时间戳，不改变事件的时间含义。
							timestamp: m.timestamp,
						};
					}
					// 分支摘要加专属前后缀，让模型知道正文来自另一分支的总结。
					case "branchSummary":
						return {
							// 供应商只接收其支持的角色，这些应用层内容统一作为 user 消息。
							role: "user",
							// 只拼摘要包装，不改写摘要内容、不在此重新总结。
							content: [
								{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX },
							],
							// 保留原消息时间戳，不改变事件的时间含义。
							timestamp: m.timestamp,
						};
					// 压缩摘要同理，但使用说明“之前对话已被压缩”的包装文字。
					case "compactionSummary":
						return {
							// 供应商只接收其支持的角色，这些应用层内容统一作为 user 消息。
							role: "user",
							// 模型内容块数组；这里虽然只有一块，也保留统一数组形状。
							content: [
								// 拼装原历史摘要的边界标记，避免模型误把它当成最新用户原话。
								{
									type: "text" as const,
									text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX,
								},
							],
							// 保留原消息时间戳，不改变事件的时间含义。
							timestamp: m.timestamp,
						};
					// 以下四种已是统一模型消息，连续 case 共用 return m。
					case "system":
					// 普通用户消息直接通过。
					case "user":
					// 模型输出消息直接通过，包括里面的工具调用块。
					case "assistant":
					// 工具结果消息直接通过，保留与调用 id 的配对。
					case "toolResult":
						// 复用原消息对象，未做深复制。
						return m;
					// 穷尽性检查分支；添加新消息种类后，若漏写转换，下面的 never 赋值会提示类型错误。
					default:
						// never 表示按类型本不应再有剩余消息；它是编译期提示，不是运行时异常抛出。
						// biome-ignore lint/correctness/noSwitchDeclarations: fine
						const _exhaustiveCheck: never = m;
						// 该消息不产生模型输入；最后 filter 会移除这个占位结果。
						return undefined;
				}
			})
			// 只去掉明确跳过的消息，得到供模型发送的 Message[]。
			.filter((m) => m !== undefined)
	);
}
