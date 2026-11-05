// 把提示词和工具变化保存在system消息中，并按顺序重放成各供应商需要的请求；历史记录与当前工具集合由同一条轨迹导出。
// Context可含顶层旧提示词/工具，TranscriptContext只携带规范消息；Tool是声明形状，不含执行函数要求。
import type { Context, Message, SystemMessage, Tool, ToolReference, TranscriptContext } from "../types.ts";
// 复用内容块抽文和单条系统消息章节渲染，不把JSON对象直接拼作提示词。
import { contentText, getSystemMessageText } from "./text.ts";

// 类型重导出方便调用方使用；运行时不会因此创建上下文实例。
export type { TranscriptContext } from "../types.ts";

/**
 * Build the leading system message for a prompt and tool set. Returns undefined when
 * both are empty, so an empty transcript stays empty.
 */
// 用途：把顶层提示词/工具变成首条system。例提示词为空但有read工具仍生成system；两者都空返回undefined，不把空对话改成一条无用系统消息。
export function createInitialSystemMessage(
	// 可没有系统提示词；空字符串也算没有实际正文。
	systemPrompt: string | undefined,
	// 可没有工具；即使提示词为空，非空工具声明仍需告诉模型。
	tools: Tool[] | undefined,
	// 返回完整系统消息或缺失；调用者据此决定是否前插消息。
): SystemMessage | undefined {
	// 明确检查正文存在且非空。
	const hasSystemPrompt = systemPrompt !== undefined && systemPrompt.length > 0;
	// 只有实际有工具项才需要工具声明字段。
	const hasTools = tools !== undefined && tools.length > 0;
	// 没有任何初始信息时保持空轨迹。
	if (!hasSystemPrompt && !hasTools) return undefined;
	return {
		// 用system角色承载提示词/工具状态变化，不混成用户指令。
		role: "system",
		// 工具独立存在时，正文仍规范为字符串空值。
		content: systemPrompt ?? "",
		// 条件展开：有工具才带toolsAdded，避免无用空字段。
		...(hasTools ? { toolsAdded: tools } : {}),
		// 初始合成消息使用0时间，不冒充某次用户真实输入的时间。
		timestamp: 0,
	};
}

/**
 * Fold `Context.systemPrompt` and `Context.tools` into a leading system message.
 * This is the only entry point that produces a {@link TranscriptContext}; every
 * provider-facing function expects the result.
 */
// 用途：兼容顶层systemPrompt/tools输入，将其折入首条system。例{systemPrompt:"规则",messages:[user]}变为[system,user]；这不是摘要压缩，不删除后续消息。
export function normalizeContext(context: Context): TranscriptContext {
	// 先根据可选顶层字段构造必要的初始系统消息。
	const initialMessage = createInitialSystemMessage(context.systemPrompt, context.tools);
	// 需要时前插system；否则直接复用原消息数组。
	const messages = initialMessage ? [initialMessage, ...context.messages] : context.messages;
	// as标记规范化边界完成，运行时仍是只带messages的普通对象。
	return { messages } as TranscriptContext;
}

/**
 * Any message list. The replay helpers only read entries whose role is `"system"`, so
 * agent transcripts that carry custom message roles can be passed without filtering.
 */
// 回放只需要先识别角色，所以允许带应用自定义角色的只读消息列表；不要求预先过滤成Message[]。
export type TranscriptMessages = readonly { role: string }[];

// 用途：从轨迹中识别system并收窄类型。例自定义custom角色会跳过；依赖宿主轨迹的消息协议，不是外部JSON完整schema验证。
function isSystemMessage(message: { role: string }): message is SystemMessage {
	// 以role标签决定分支，message is告诉TS分支内可读sections/toolsAdded等字段。
	return message.role === "system";
}

/** Return the leading system message, if the transcript starts with one. */
// 用途：只取开头那条system。例[user,system]返回undefined，不能把中途补丁误当原始首条提示词；不修改列表。
export function getInitialSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
	// 空数组首项为undefined。
	const first = messages[0];
	// 同时检查存在和角色，三元表达式决定是否返回原对象。
	return first && isSystemMessage(first) ? first : undefined;
}

/** Drop the leading system message for APIs that carry the prompt outside the message list. */
// 用途：供应商把首条提示词放请求单独字段时，从消息数组中去掉首条system。例[system,user]得到[user]；无首条system时复用原数组，不移除中途system。
export function withoutInitialSystemMessage(messages: Message[]): Message[] {
	// slice(1)返回去首项的新数组，原历史不变。
	return getInitialSystemMessage(messages) ? messages.slice(1) : messages;
}

/** Resolve the tools available after applying every transcript delta in order. */
// 用途：按顺序重放system里的工具增删，得到当前工具声明。例先加read后删read，最后集合没有read；同名新增会替换定义，不执行工具。
export function getCurrentTools(messages: TranscriptMessages): Tool[] {
	// 以工具名为键，Map同时保留稳定迭代顺序。
	const tools = new Map<string, Tool>();
	// 按历史因果顺序读消息，后面的变更可以覆盖前面的状态。
	for (const message of messages) {
		// 用户/assistant/custom等内容不直接改变系统工具集合。
		if (!isSystemMessage(message)) continue;
		// 每条system先移除指定名字，没有列表时当空数组。
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		// 再添加/替换定义；同一条里先删后加可表达重定义。
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	// 把当前Map值展开成数组，返回声明，不包含历史上已删除工具。
	return [...tools.values()];
}

/**
 * Replay every system message into one leading system message holding the current
 * prompt and tools. Later `content` is appended to the base prompt, `sections` are
 * patched by name, and tools are resolved with {@link getCurrentTools}.
 */
// 用途：重放所有system，得到当前完整提示词和工具。正文按序追加、sections按名称更新/删除，工具另由getCurrentTools求出；例style从详细改简短后只保留简短章节。
export function getCurrentSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
	// 累计各条system里的非空正文，不会用后面正文直接抹掉前面正文。
	const content: string[] = [];
	// 章节按名字保存当前有效值，null变更会删除。
	const sections = new Map<string, string>();
	// 记录第一条system的时间；没有任何system时保持undefined。
	let timestamp: number | undefined;
	// 按历史因果顺序读消息，后面的变更可以覆盖前面的状态。
	for (const message of messages) {
		// 用户/assistant/custom等内容不直接改变系统工具集合。
		if (!isSystemMessage(message)) continue;
		// ??=仅在尚未记录时赋值，因此保留首次system时间而不是最后更新时间。
		timestamp ??= message.timestamp;
		// 从system内容块抽取普通文字。
		const text = contentText(message.content);
		// 非空正文才累计，减少最后拼出的空段落。
		if (text.length > 0) content.push(text);
		// 按章节名称应用每条system补丁；对象解构同时取得名字和新值。
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			// null明确撤销该章节，旧规则不再进入当前完整提示词。
			if (value === null) sections.delete(name);
			// 普通字符串更新或新增章节，空字符串也仍是明确值。
			else sections.set(name, value);
		}
	}
	// 工具状态与正文/章节分开回放，但依据同一份轨迹。
	const tools = getCurrentTools(messages);
	// 没有system信息也没有工具时，不制造空完整system。
	if (timestamp === undefined && tools.length === 0) return undefined;
	return {
		// 用system角色承载提示词/工具状态变化，不混成用户指令。
		role: "system",
		// 正文段落用空行合并，保持历史追加的顺序。
		content: content.join("\n\n"),
		// 有效章节非空才转成普通对象附带，方便后续渲染/序列化。
		...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
		// 重放结果以完整当前工具集表示，不再输出历史增删过程。
		...(tools.length > 0 ? { toolsAdded: tools } : {}),
		// 有system时保留首次时间，否则使用合成基线0。
		timestamp: timestamp ?? 0,
	};
}

/** Render the current system prompt text after replaying every system message. */
// 用途：取得当前完整系统提示词字符串。先重放system，再渲染正文+有效章节；例删除style后字符串里不再出现该章节内容。
export function getCurrentSystemPrompt(messages: TranscriptMessages): string {
	// 先得到当前合成system，避免仅渲染第一条漏掉后续补丁。
	const message = getCurrentSystemMessage(messages);
	// 没有系统消息时返回空字符串，不抛“没提示词”错误。
	return message ? getSystemMessageText(message) : "";
}

/**
 * Rebuild the transcript for APIs without mid-conversation system messages: the replayed
 * system message leads, and every later system message is dropped.
 */
// 用途：给不支持对话中途system的API，把全部system重放成首条并移除其他system。用户/assistant/toolResult相对顺序保持；返回新上下文，不改原轨迹。
export function collapseSystemMessages(context: TranscriptContext): TranscriptContext {
	// 生成包含全部当前规则与工具的合成头部。
	const head = getCurrentSystemMessage(context.messages);
	// 过滤掉旧system补丁，避免规则重复发送。
	const messages = context.messages.filter((message) => message.role !== "system");
	// 有合成头就前插，否则只保留非system消息，断言维持规范上下文标记。
	return { messages: head ? [head, ...messages] : messages } as TranscriptContext;
}

/** Keep later system messages in place when the model accepts them; otherwise collapse them. */
// 用途：按供应商能力决定保留中途system还是折叠。例supportsMidConvoSystemMessages=true直接复用轨迹，false/undefined则合并；能力选择由适配器传入。
export function resolveTranscript(
	// 规范化后的消息上下文，没有顶层旧systemPrompt/tools待合并。
	context: TranscriptContext,
	// 布尔能力标志也可缺失，缺失按不支持处理。
	supportsMidConvoSystemMessages: boolean | undefined,
): TranscriptContext {
	// 支持时保持原对象和时间顺序，不支持时用合并结果兼容协议。
	return supportsMidConvoSystemMessages ? context : collapseSystemMessages(context);
}

/** Strip executable and display-only fields from a tool before transcript comparison or persistence. */
// 用途：取模型真正关心的工具声明，丢掉可执行/展示等额外字段。例AgentTool有execute，但输出只有name/description/parameters/采样约束；schema经JSON往返复制，可能因非JSON数据抛错。
export function toToolDeclaration(tool: Tool): Tool {
	return {
		// 工具名是模型调用和结果配对时用的公开名字。
		name: tool.name,
		// 工具用途说明会影响模型何时选择该工具。
		description: tool.description,
		// JSON往返得到普通schema，去掉不可枚举元数据/undefined等，并隔离原对象；as只复用字段类型。
		parameters: JSON.parse(JSON.stringify(tool.parameters)) as Tool["parameters"],
		// 保留明确的采样约束，未提供时不加字段，使声明比较形状稳定。
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
	};
}

/**
 * Whether two tools declare the same interface to the model.
 *
 * Both sides go through {@link toToolDeclaration} first: its JSON round-trip drops the
 * schema metadata keys (TypeBox's non-enumerable kind marks) and `undefined` fields that a structural comparison would see, and
 * builds both objects with the same key order, so comparing the serialized declarations
 * is exact. This avoids a deep-equal dependency in a browser-safe package.
 */
// 用途：比较两个工具给模型看的接口是否相同。两边先经统一声明清洗和字段顺序再JSON比较；例如只是execute函数换了但声明没变，结果仍相等。
export function declarationsEqual(left: Tool, right: Tool): boolean {
	// 比较声明序列化结果，而非对象引用；schema内部顺序仍按其JSON序列化结果参与比较。
	return JSON.stringify(toToolDeclaration(left)) === JSON.stringify(toToolDeclaration(right));
}

// 完整工具状态之间的变化，供Agent在system消息中声明。
export interface ToolStateChanges {
	// 新加入或定义变更后需重新声明的完整工具。
	toolsAdded: Tool[];
	// 移除或即将重定义的旧工具，仅需名字引用。
	toolsRemoved: ToolReference[];
}

/** Compare two complete tool states. A changed definition is a removal followed by an addition. */
// 用途：比较前后两个完整工具集。例同名read描述变化，既返回旧read移除又返回新read添加；只返回差异，不修改输入列表。
export function getToolStateChanges(previous: readonly Tool[], current: readonly Tool[]): ToolStateChanges {
	// 旧列表按名字建索引，避免每个当前工具都线性查旧列表。
	const previousTools = new Map(previous.map((tool) => [tool.name, tool]));
	// 当前列表同样建索引，便于反向查删除项。
	const currentTools = new Map(current.map((tool) => [tool.name, tool]));
	return {
		// 新增/变更列表按当前工具顺序产生。
		toolsAdded: current
			// 仅保留另一侧不存在或声明不同的工具，不把所有工具每轮都重发。
			.filter((tool) => {
				// 查同名旧定义。
				const previousTool = previousTools.get(tool.name);
				// 旧名不存在即新增；同名但声明不同即重新添加。
				return previousTool === undefined || !declarationsEqual(previousTool, tool);
			})
			// 输出经过清洗的模型声明，不把运行时执行对象直接写进轨迹。
			.map(toToolDeclaration),
		// 删除/变更列表按旧工具顺序产生。
		toolsRemoved: previous
			// 仅保留另一侧不存在或声明不同的工具，不把所有工具每轮都重发。
			.filter((tool) => {
				// 查这个旧工具在当前是否仍存在。
				const currentTool = currentTools.get(tool.name);
				// 当前不存在即删除；同名接口变化也先删除旧定义。
				return currentTool === undefined || !declarationsEqual(tool, currentTool);
			})
			// 移除引用只需名字，不把旧schema重复附上。
			.map((tool) => ({ name: tool.name })),
	};
}

/** Every definition referenced by transcript tool state, in first-declaration order. */
// 用途：收集轨迹中曾被声明过的工具，按名字保留最新定义。它不同于当前工具集：后续移除不会把历史声明删掉；用于需要预先知道定义的传输处理。
export function getDeclaredTools(messages: TranscriptMessages): Tool[] {
	// 按名字去重，首次插入顺序维持，后续同名set替换值。
	const definitions = new Map<string, Tool>();
	// 按历史因果顺序读消息，后面的变更可以覆盖前面的状态。
	for (const message of messages) {
		// 用户/assistant/custom等内容不直接改变系统工具集合。
		if (!isSystemMessage(message)) continue;
		// 只看新增/重定义，刻意不应用toolsRemoved。
		for (const tool of message.toolsAdded ?? []) definitions.set(tool.name, tool);
	}
	// 返回每个曾声明名字的最后定义。
	return [...definitions.values()];
}

/**
 * Whether a tool name was declared twice with different definitions. A transport that can
 * only reference previously declared tools by name cannot replay such a history.
 *
 * @deprecated No built-in transport needs this anymore: Anthropic expresses redefinitions with
 * inline `tool_definition` blocks. Kept for API compatibility and will be removed in a future release.
 */
// 用途：检测同名工具是否先后出现不同声明。例read第一次参数A、第二次参数B返回true；此旧兼容助手已标deprecated，不应把它当当前所有供应商都必需的路径。
export function hasToolRedefinitions(messages: TranscriptMessages): boolean {
	// 记录目前已看到的每个名字的定义。
	const declared = new Map<string, Tool>();
	// 按历史因果顺序读消息，后面的变更可以覆盖前面的状态。
	for (const message of messages) {
		// 用户/assistant/custom等内容不直接改变系统工具集合。
		if (!isSystemMessage(message)) continue;
		// 逐条检查系统消息中的声明，不按工具执行结果判断。
		for (const tool of message.toolsAdded ?? []) {
			// 同名过去声明可能不存在。
			const previous = declared.get(tool.name);
			// 找到一处同名且不同接口即可确定有重定义。
			if (previous !== undefined && !declarationsEqual(previous, tool)) return true;
			// 没发现变化则更新这个名字的最新定义，继续扫描。
			declared.set(tool.name, tool);
		}
	}
	// 遍历完未命中需要的变更形状，返回否。
	return false;
}

/** Whether tool history contains a removal or same-name redeclaration that an addition-only transport cannot replay. */
// 用途：检测只有“新增工具”能力的传输是否无法原样表达轨迹。删除或同名再次声明都算非追加变化；例移除read直接返回true。
export function hasNonAdditiveToolChanges(messages: TranscriptMessages): boolean {
	// 先只取system，再看是否找到非追加变化下标。
	return findLastNonAdditiveToolChange(messages.filter(isSystemMessage)) >= 0;
}

/** Index of the last system message with a removal or same-name redeclaration, or -1. */
// 用途：返回最后一条含删除或名字重宣的system下标，未发生则-1。即便重宣内容一样也记录，以兼容按名字处理的传输行为；不与declarationsEqual规则混淆。
function findLastNonAdditiveToolChange(systemMessages: readonly SystemMessage[]): number {
	// A name declared before counts as a redeclaration even after its removal: Kimi K3 ignores a
	// removed tool that a later tool message declares again (verified October 2026).
	// 记住历史上出现过的名字，删除后也不从这里移除。
	const declared = new Set<string>();
	// -1表示尚未见到不支持的变化。
	let last = -1;
	// 按system消息下标推进，记录最后一次特殊变更位置。
	for (let index = 0; index < systemMessages.length; index++) {
		// 取当前system，其工具变更可能为空。
		const message = systemMessages[index];
		// 有任何删除就必须折叠到至少这一条之后。
		if ((message.toolsRemoved?.length ?? 0) > 0) last = index;
		// 逐条检查系统消息中的声明，不按工具执行结果判断。
		for (const tool of message.toolsAdded ?? []) {
			// 名字曾出现过就算再次声明，不因中间删除而忘记。
			if (declared.has(tool.name)) last = index;
			// 将该名字记入历史集合，供后续判断。
			declared.add(tool.name);
		}
	}
	// 返回最后命中位置，后面决定需要折叠多少条system。
	return last;
}

/**
 * How a transport can express tool changes after the first request.
 *
 * - `"none"`: only the top-level tool list exists; it always holds the current tools.
 * - `"additions"`: tools can be added at a later message, but not removed or redefined.
 * - `"changes"`: every tool, including the initial ones, is declared in place, and a later
 *   declaration under the same name replaces the earlier one. Removals are not expressible on
 *   the wire, so the transport announces them as text and the removed tools stay declared.
 */
// 传输表达能力：none只能顶层当前工具，additions能中途加，changes能中途重定义；不是是否允许调用工具的权限设置。
export type TranscriptToolSupport = "none" | "additions" | "changes";

// 适配器使用的工具分配结果，区分请求顶层与消息原位声明。
export interface TranscriptTools {
	/** Tools sent in the top-level request field. */
	// 应放到供应商请求顶层tools字段的工具列表。
	requestTools: Tool[];
	/**
	 * Number of leading system messages whose tool changes `requestTools` already holds. Every
	 * later system message carries its own tool changes in place.
	 */
	// 前多少条system的变化已经折入顶层，后续system再各自原位表达。
	foldedSystemMessages: number;
}

/**
 * Split tool declarations between the top-level request field and in-place changes.
 *
 * With `"changes"`, the top-level list stays empty and every system message, including the
 * leading one, declares its tools in place: an in-place declaration can replace an earlier
 * in-place one, but not a top-level one. With `"additions"`, a removal or redefinition cannot be
 * expressed in place, so the top-level list becomes the tool state after the last such change;
 * later additions stay anchored, and the cached prefix is invalidated once per removal instead
 * of on every later addition. With `"none"`, the top-level list is the current tool set.
 */
// 用途：按传输能力拆分工具声明。例只支持additions的API遇到一次删除，就把截至最后删除/重宣的状态折到顶层，之后新增仍原位发送，减少反复改前缀。
export function resolveTranscriptTools(messages: TranscriptMessages, support: TranscriptToolSupport): TranscriptTools {
	// 工具声明只由system承载，先取得这部分子序列。
	const systemMessages = messages.filter(isSystemMessage);
	// 不能在消息中表达工具变更，只能每次发送完整当前工具列表。
	if (support === "none") {
		// 全部system变更均视为已折到顶层，避免适配器再重复发原位工具块。
		return { requestTools: getCurrentTools(systemMessages), foldedSystemMessages: systemMessages.length };
	}
	// 支持原位重定义时，所有工具都在各system原位声明，顶层列表留空。
	if (support === "changes") return { requestTools: [], foldedSystemMessages: 0 };
	// 剩余是仅追加模式；确定至少要折叠到哪里。
	const folded = Math.max(
		// 若有初始system，至少把第一条的工具放入顶层。
		getInitialSystemMessage(messages) ? 1 : 0,
		// 最后删除/重宣下标加1转换为包含该条的前缀长度。
		findLastNonAdditiveToolChange(systemMessages) + 1,
	);
	// 只重放必须折叠的system前缀；后面的新增保持原位，不每次重写全部工具前缀。
	return { requestTools: getCurrentTools(systemMessages.slice(0, folded)), foldedSystemMessages: folded };
}
