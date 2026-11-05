// 长会话压缩的算法与独立模型请求；AgentSession 决定何时执行，SessionManager 负责追加历史及重建上下文。
// “压缩”替换的是下一次发给模型的旧上下文，不是从 JSONL 中删除旧消息；近期尾部按估算 token 保留。
/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	contentText,
	getCurrentSystemMessage,
	normalizeContext,
	type RetryCallbacks,
	type RetryPolicy,
	retryAssistantCall,
	uuidv7,
} from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	Model,
	SimpleStreamOptions,
	SystemMessage,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "../messages.ts";
import {
	buildSessionProjection,
	type CompactionEntry,
	type ProjectedSessionEntry,
	type SessionEntry,
	type SessionProjection,
	sessionEntryToContextMessages,
} from "../session-manager.ts";
import { combineUsage } from "../usage-totals.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
// pi 内置压缩保存在 details 的文件追踪结构；扩展可使用自己的 details，所以读取旧值前还要确认来源。
export interface CompactionDetails {
	// 仅被读取、未被记录为修改的路径数组。
	readFiles: string[];
	// read/write/edit 工具声明中累计的修改路径，不是磁盘 diff 的验证结果。
	modifiedFiles: string[];
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
// 收集本次被总结消息中的文件工具调用，并继承上次内置压缩的文件清单。
// 输入消息、投影对应原条目和旧压缩位置；返回独立集合，不访问磁盘。例如旧摘要修改 a、新消息读 b，返回两者记录。
function extractFileOperations(
	// 按时间排序的待处理消息；具体是历史或半轮前缀由当前函数用途决定。
	messages: AgentMessage[],
	// 当前函数使用的原始会话条目；它不是 JSON 字符串，也不是最终模型消息数组。
	entries: SessionEntry[],
	// 上一有效压缩条目在 entries 中的位置，-1 表示没有旧摘要可继承。
	prevCompactionIndex: number,
): FileOperations {
	// 为本次压缩分配独立的 read/written/edited 集合，避免跨请求共享可变状态。
	const fileOps = createFileOps();

	// Collect from previous compaction's details (if pi-generated)
	// 只有存在旧压缩节点时才尝试继承其文件追踪信息。
	if (prevCompactionIndex >= 0) {
		// 索引由准备阶段找到；as 告知 TypeScript 此处预期压缩条目，不产生运行时转换。
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		// 扩展摘要的 details 不一定是文件清单，因此只继承 pi 自己生成的格式。
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook field kept for session file compatibility
			// 将未知元数据按预期结构读取；下面数组检查是持久化数据边界上的实际运行时判断。
			const details = prevCompaction.details as CompactionDetails;
			// 兼容缺字段或旧格式清单，不把类型断言当成数据验证。
			if (Array.isArray(details.readFiles)) {
				// 把旧摘要的读取路径逐个并入集合，同路径自动去重。
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			// 单独检查旧摘要的修改列表。
			if (Array.isArray(details.modifiedFiles)) {
				// 继承为 edited 即可让最终修改清单包含它，无需实际重新编辑文件。
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// Extract from tool calls in messages
	// 扫描当前要总结的消息，而不是重新扫描整个磁盘会话。
	for (const msg of messages) {
		// 从助手工具调用和工具结果的 nestedCalls 中识别 read/write/edit 路径。
		extractFileOpsFromMessage(msg, fileOps);
	}

	// 返回可继续累积的集合，后续统一转换成清单。
	return fileOps;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
// 取一个投影条目中的对话消息，排除旧压缩正文和系统状态；输入已应用 context_edit 的条目，返回筛选数组。
// 例如系统提示词不会作为普通聊天材料再总结，它由 SessionManager 的 systemMessage 检查点保存。
function getMessagesFromProjectedEntryForCompaction(entry: ProjectedSessionEntry): AgentMessage[] {
	// 旧摘要会通过 previousSummary 单独送入更新请求，避免在历史材料里重复。
	if (entry.sourceEntry.type === "compaction") return [];
	// System messages are prompt state, not conversation; the compaction entry carries their replay.
	// 系统消息是提示词/工具状态，不参与自然语言会话总结；filter 返回新数组。
	return entry.messages.filter((message) => message.role !== "system");
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
// 生成阶段返回值，不等于已落盘的 CompactionEntry；T 是扩展元数据类型，默认 unknown 要求先确认再使用。
export interface CompactionResult<T = unknown> {
	// 模型生成并附加文件清单后的摘要文字。
	summary: string;
	// 压缩后仍以原文重放的近期尾部起点 id；更早内容由摘要代替进入模型上下文。
	firstKeptEntryId: string;
	// 压缩前投影上下文的估算 token 数，不是摘要请求自己的消耗。
	tokensBefore: number;
	// 可选的压缩后估算值；本模块 compact 返回时并不主动填入它。
	estimatedTokensAfter?: number;
	/** Usage from the LLM call(s) that generated this summary, if available */
	// 本次摘要模型请求的消耗；分轮摘要时可为多次请求合并值。
	usage?: Usage;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	// 扩展或内置摘要的附加元数据，不因泛型存在就自动获得运行时校验。
	details?: T;
}

// ============================================================================
// Types
// ============================================================================

// 自动触发与保留范围的设置；保留近期按估算 token 预算，不是固定轮数。
export interface CompactionSettings {
	// shouldCompact 的自动判断开关，不等于禁止所有显式调用 compact 的入口。
	enabled: boolean;
	// 触发阈值从模型窗口中预留的余量，和近期原文保留量是两个概念。
	reserveTokens: number;
	// 挑选近期原文尾部时的近似预算，为工具调用/结果配对可超出。
	keepRecentTokens: number;
}

// 默认自动压缩开启，预留 16384，近期原文目标约 20000 tokens；只是默认设置对象。
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	// 默认启用自动阈值判断，上层仍可覆盖设置。
	enabled: true,
	// 窗口还剩约16384 tokens 时触发，而非等到完全溢出。
	reserveTokens: 16384,
	// 近期原文目标约20000 tokens，边界对齐后不保证恰好这个数量。
	keepRecentTokens: 20000,
};

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
// 从服务端 usage 取一个上下文占用基线；优先 totalTokens，否则相加各分量，纯计算无副作用。
// 例如 totalTokens 为 0 时使用 input+output+cacheRead+cacheWrite；不代表重新执行 tokenizer。
export function calculateContextTokens(usage: Usage): number {
	// || 在左侧为假值时取右侧；这里 0 会触发分量求和。
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted, error, and all-zero usage messages as they don't have valid usage data.
 */
// 检查单条消息是否有可用助手 usage；返回该对象或 undefined，不修改消息。
// 中断、错误和全零记录不能充当估算基线，例如失败请求附带零 usage 会被跳过。
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	// 角色与属性判断后，才按助手响应读取 stopReason 和 usage。
	if (msg.role === "assistant" && "usage" in msg) {
		// 类型断言只影响编译期访问，不修复或复制消息。
		const assistantMsg = msg as AssistantMessage;
		if (
			// 排除用户取消导致的不完整响应记录。
			assistantMsg.stopReason !== "aborted" &&
			// 排除错误响应，避免把失败尝试当作完整上下文计量。
			assistantMsg.stopReason !== "error" &&
			// 要求 usage 存在；这是沿用现有消息保护条件。
			assistantMsg.usage &&
			// 至少有正的计量才可用作基线。
			calculateContextTokens(assistantMsg.usage) > 0
		) {
			// 返回原 usage 引用，不累计或写入费用。
			return assistantMsg.usage;
		}
	}
	// 这条消息不具备可用助手计量，让调用方继续向前找或改走本地估算。
	return undefined;
}

/**
 * Find the last valid assistant message usage from session entries.
 */
// 从旧到新保存的原始条目中反向找最后一个有效助手用量；找不到返回 undefined，不访问磁盘。
// 例如最后一次助手报错时继续向前查找上一条成功响应，而不是直接使用零 usage。
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	// 从最新条目向旧条目扫描，优先最新的可用记录。
	for (let i = entries.length - 1; i >= 0; i--) {
		// 用下标取得当前条目，后续先按 type 判断其内容。
		const entry = entries[i];
		// 只有普通消息条目可能是助手 usage 基线；独立 usage 记账条目不参与这里的估算。
		if (entry.type === "message") {
			// 复用单条助手记录的有效性筛选。
			const usage = getAssistantUsage(entry.message);
			// 命中后立即返回，避免误用更早的用量。
			if (usage) return usage;
		}
	}
	// 全部条目都无有效助手 usage，交给上层估算当前内容。
	return undefined;
}

// 解释估算由哪两部分组成：最近 usage 基线，加上其后尚无 usage 的消息估算。
export interface ContextUsageEstimate {
	// 本次用于比较窗口阈值的总估算量。
	tokens: number;
	// 采用的助手 usage 基线；全部按字符估算时为 0。
	usageTokens: number;
	// 基线之后的消息估算；无基线时就是全部估算。
	trailingTokens: number;
	// 基线在消息数组中的位置，null 表示没有采用助手 usage。
	lastUsageIndex: number | null;
}

// 在消息数组中反向找有效 usage，并带回下标；无匹配返回 undefined，没有外部副作用。
// 例如下标 4 是最后一次成功响应，调用方只需补估 5 之后的新增消息。
function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	// 从最近消息开始检查，不假定最后一条一定是助手。
	for (let i = messages.length - 1; i >= 0; i--) {
		// 跳过用户、工具结果以及失败/取消的助手用量。
		const usage = getAssistantUsage(messages[i]);
		// 对象返回 usage 与它所在消息位置，后面才能划定尾部。
		if (usage) return { usage, index: i };
	}
	// 没有找到有效基线，调用方需要估算整个消息数组。
	return undefined;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
// 估算消息数组当前占用；有有效 usage 就用它作历史基线，加估其后消息，否则估算全部。
// 例如上次助手 usage=1000，后续工具结果估为200，就返回1200；它本身不判断基线后是否发生上下文编辑。
// 这是本地预算估算而非精确 tokenizer；修改/压缩后的基线失效由 estimateProjectedContextTokens 处理。
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	// 先找最近的有效助手记录及下标，决定走基线模式还是全估算模式。
	const usageInfo = getLastAssistantUsageInfo(messages);

	// 没有任何可用计量时，逐消息估算整个输入。
	if (!usageInfo) {
		// 全量估算的累加器，初始为空上下文 0。
		let estimated = 0;
		// 遍历输入数组的每条消息。
		for (const message of messages) {
			// 按当前支持的角色/内容规则加上近似大小。
			estimated += estimateTokens(message);
		}
		return {
			// 总量全部来自本地估算。
			tokens: estimated,
			// 没有服务端 usage 基线。
			usageTokens: 0,
			// 为统一返回结构，把全量估算放在 trailingTokens。
			trailingTokens: estimated,
			// 明确没有基线位置，调用方不能拿它当有效数组下标。
			lastUsageIndex: null,
		};
	}

	// 使用最后一次成功助手 usage 的上下文计量作为基线。
	const usageTokens = calculateContextTokens(usageInfo.usage);
	// 单独累计基线之后新增的材料。
	let trailingTokens = 0;
	// 从基线下一条开始，不把基线之前内容重复相加。
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		// 补估尚未被之后成功响应计入的消息。
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		// 总估算由历史基线和新增尾部组成。
		tokens: usageTokens + trailingTokens,
		// 对象属性简写，返回已采用的服务端计量基线。
		usageTokens,
		// 返回该基线之后新增消息的近似大小。
		trailingTokens,
		// 保存所用基线位置，供投影感知估算检查失效边界。
		lastUsageIndex: usageInfo.index,
	};
}

/** Estimate projected context without trusting usage captured before a later edit or compaction. */
// 估算当前投影，并拒用后续 context_edit/compaction 已使其过时的助手 usage。
// 输入投影和原分支条目，返回结构化估算，不修改会话。比如删掉旧大工具结果后，旧 usage 仍很大，就改为估算当前可见内容。
export function estimateProjectedContextTokens(
	// 已应用最新压缩边界和内容编辑的规范投影，仍带每条消息的来源。
	projection: SessionProjection,
	// 当前原始根到叶路径，用于比较 usage 基线是否早于后续编辑/压缩。
	branchEntries: SessionEntry[],
): ContextUsageEstimate {
	// 先取得普通估算，再验证它采用的基线是否仍对应当前上下文。
	const estimate = estimateContextTokens(projection.messages);
	// 只有采用了服务端基线时才需要追踪它对应哪个原条目。
	if (estimate.lastUsageIndex !== null) {
		// 投影一条原条目可能贡献多条消息，用累计消息下标映射回来源。
		let projectedMessageIndex = 0;
		// 记录基线所属原条目的 id，找不到时保持 undefined。
		let usageEntryId: string | undefined;
		// 遍历带来源的投影条目，不能直接把消息下标当原条目下标。
		for (const entry of projection.entries) {
			// 计算当前来源贡献结束后的下标；空投影不占消息位置。
			const nextMessageIndex = projectedMessageIndex + entry.messages.length;
			// 基线位置落在当前来源的消息范围中。
			if (estimate.lastUsageIndex < nextMessageIndex) {
				// 把消息位置换成稳定条目 id，便于去原始分支定位。
				usageEntryId = entry.sourceEntry.id;
				break;
			}
			// 当前范围未命中，游标移到下一来源的起点。
			projectedMessageIndex = nextMessageIndex;
		}

		// findIndex 按 id 定位原分支位置；没有来源或找不到时使用 -1。
		const usageEntryIndex = usageEntryId ? branchEntries.findIndex((entry) => entry.id === usageEntryId) : -1;
		// 没有编辑/压缩失效边界时以 -1 表示它早于所有正常条目。
		let latestInvalidatingEntryIndex = -1;
		// 反向找最近一次改变上下文构成的条目。
		for (let i = branchEntries.length - 1; i >= 0; i--) {
			// 取原分支条目，检查的是追加顺序，不是投影后消息顺序。
			const entry = branchEntries[i];
			// 编辑可替换/隐藏内容，压缩可替换历史，这两种操作会使之前的用量不再代表当前投影。
			if (entry.type === "context_edit" || entry.type === "compaction") {
				// 记住最近一次失效操作的位置，然后结束查找。
				latestInvalidatingEntryIndex = i;
				break;
			}
		}
		// 基线严格晚于最近失效操作才继续信任；否则下面按当前投影重估。
		if (usageEntryIndex > latestInvalidatingEntryIndex) return estimate;
	}

	// 折叠系统状态，取得当前实际系统提示词/工具状态，而不是把所有历史系统增量都重复计算。
	const currentSystem = getCurrentSystemMessage(projection.messages);
	// 有当前系统状态就先估它，否则从 0 开始。
	let tokens = currentSystem ? estimateTokens(currentSystem) : 0;
	// 其余只遍历当前模型可见消息，已隐藏内容不应再计入。
	for (const message of projection.messages) {
		// 系统状态已单独估过，其余角色逐条累加。
		if (message.role !== "system") tokens += estimateTokens(message);
	}
	// 标明这次全凭当前投影估算，未采用旧 usage。
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

/**
 * Check if compaction should trigger based on context usage.
 */
// 只判断是否超过自动压缩阈值；输入当前估算量、模型窗口和设置，返回布尔值，不发模型请求。
// 例如窗口100、预留20时，81触发、80不触发；选择压缩内容和真正调用模型是之后的独立步骤。
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	// 关闭自动判断就直接返回 false。
	if (!settings.enabled) return false;
	// 严格大于“窗口减预留量”才触发，并非只有完全溢出窗口才开始压缩。
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ============================================================================
// Cut point detection
// ============================================================================

// 图片用固定 4800 等效字符粗估，随后除以4约为1200 tokens；不读取实际像素或模型视觉计价。
const ESTIMATED_IMAGE_CHARS = 4800;

// 把字符串或文本/图片内容块近似换算为字符量；返回数字，不调用模型、不读取图片。
// 例如一段8字符文字加一张图按4808字符估算，其他未识别块不计入。
function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	// 这里输入类型允许字符串或数组，typeof 区分联合的两个合法分支。
	if (typeof content === "string") {
		// 字符串 length 是 JavaScript UTF-16 单位数，并不是精确 token 数。
		return content.length;
	}

	// 累计等效字符量，图片也会折算进这个值。
	let chars = 0;
	// 已经排除字符串分支，此处 TypeScript 可按数组遍历。
	for (const block of content) {
		// 只把存在且非空的文本字段计入。
		if (block.type === "text" && block.text) {
			// 文字按长度累计；具体语言的 token 比例可能不同。
			chars += block.text.length;
			// 图片不解析编码大小，而使用固定占位估算。
		} else if (block.type === "image") {
			// 每张图片加入同样的等效字符数。
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	// 交回字符量，由调用方再做 chars/4。
	return chars;
}

/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
// 按消息角色提取文字、思考、工具参数等长度，再用字符/4向上取整；无外部副作用。
// 例如8字符纯文字估为2 tokens；图片用固定值。这是预算启发式，不保证对中文、工具 schema、供应商封装总是高估。
// 它和 serializeConversation 的材料不同：这里会计入 thinking，而序列化摘要时会主动省略 thinking。
export function estimateTokens(message: AgentMessage): number {
	// 累计等效字符量，图片也会折算进这个值。
	let chars = 0;

	// 按判别联合的 role 字段选择估算规则，没有识别到的角色最终返回0。
	switch (message.role) {
		// 系统状态除正文外，还可能包含分段提示词和新增工具 schema。
		case "system": {
			// 明确以系统消息类型访问 sections、toolsAdded。
			const system = message as SystemMessage;
			// 先估系统正文的等效字符长度。
			chars = estimateTextAndImageContentChars(system.content);
			// 系统状态若有分段内容，逐个加入非空段。
			if (system.sections) {
				// Object.values 只取字段值，不把段名称本身计入。
				for (const section of Object.values(system.sections)) {
					// 跳过 null/空串等假值，累计实际段文字。
					if (section) chars += section.length;
				}
			}
			// 把新增工具 schema 的 JSON 表示纳入估算；此处不另外计 toolsRemoved。
			if (system.toolsAdded) chars += JSON.stringify(system.toolsAdded).length;
			// Math.ceil 向上取整，避免不足4字符被估成0；仍只是近似。
			return Math.ceil(chars / 4);
		}
		// 用户消息可以是纯文字，也可以由文本和图片块组成。
		case "user": {
			// 把用户内容交给统一文本/图片估算器，下面的多行是同一次调用。
			chars = estimateTextAndImageContentChars(
				// 断言只关注该估算器需要的 content 形状，不执行内容转换。
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			// Math.ceil 向上取整，避免不足4字符被估成0；仍只是近似。
			return Math.ceil(chars / 4);
		}
		// 助手消息计入对外文字、思考文字和工具调用参数。
		case "assistant": {
			// 为内容块判别和字段读取提供助手消息类型。
			const assistant = message as AssistantMessage;
			// 一条助手响应可能包含多个不同种类的内容块。
			for (const block of assistant.content) {
				// 普通文字块直接按 text 长度估算。
				if (block.type === "text") {
					// 文字按长度累计；具体语言的 token 比例可能不同。
					chars += block.text.length;
					// 估上下文时计入 thinking；摘要序列化另有省略规则。
				} else if (block.type === "thinking") {
					// 累计思考文本长度，不把它直接输出到摘要正文。
					chars += block.thinking.length;
					// 工具调用的名称与参数也占用模型输入/输出空间。
				} else if (block.type === "toolCall") {
					// 参数 JSON 化后估长度，不执行工具，也不按工具结果内容推算。
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			// Math.ceil 向上取整，避免不足4字符被估成0；仍只是近似。
			return Math.ceil(chars / 4);
		}
		// 自定义消息与工具结果共享文本/图片估算规则。
		case "custom":
		// 工具结果可能很大，后面切分边界会考虑它的估算量。
		case "toolResult": {
			// 估算完整内容；摘要材料实际序列化时可能再把长工具结果截短。
			chars = estimateTextAndImageContentChars(message.content);
			// Math.ceil 向上取整，避免不足4字符被估成0；仍只是近似。
			return Math.ceil(chars / 4);
		}
		// 应用层 bash 执行记录包含命令和输出两个文本字段。
		case "bashExecution": {
			// 将命令和输出都计入，不在这里重新执行命令。
			chars = message.command.length + message.output.length;
			// Math.ceil 向上取整，避免不足4字符被估成0；仍只是近似。
			return Math.ceil(chars / 4);
		}
		// 已有的分支摘要和压缩摘要按摘要文字长度估算。
		case "branchSummary":
		// 压缩后的检查点是一段摘要，不重新展开原历史。
		case "compactionSummary": {
			// 仅统计摘要正文，不再估被替代的原始消息。
			chars = message.summary.length;
			// Math.ceil 向上取整，避免不足4字符被估成0；仍只是近似。
			return Math.ceil(chars / 4);
		}
	}

	// 未匹配到支持的角色时估为0，不表示模型侧必然零消耗。
	return 0;
}

// 判断某消息能否成为保留尾部的起点；输入消息，返回布尔值，无副作用。
// 用户/助手等可做切点，toolResult 不可，避免直接保留结果却丢掉它前面的助手调用；系统消息也不做切点。
function isCutPointMessage(message: AgentMessage): boolean {
	// 按 role 判断是否属于允许的角色组，返回布尔值；这两个判断不估算 token。
	switch (message.role) {
		case "user":
		case "assistant":
		case "bashExecution":
		// 扩展消息作为用户式输入，可作为边界起点。
		case "custom":
		// 以前的摘要消息也可作为用户式上下文起点。
		case "branchSummary":
		case "compactionSummary":
			// 上面一组连续 case 共用此返回值：该角色允许成为当前判定的起点。
			return true;
		case "toolResult":
			// 该角色/条目不符合起点规则；若在 switch 外，则表示未匹配任何允许角色。
			return false;
	}
	// 该角色/条目不符合起点规则；若在 switch 外，则表示未匹配任何允许角色。
	return false;
}

// 判断是否是新一轮的用户式起点；助手和工具结果不是。
// 例如 user→assistant→toolResult 中只有 user 开新轮；bash/custom/摘要也按用户式起点处理，纯判断不修改消息。
function isTurnStartMessage(message: AgentMessage): boolean {
	// 按 role 判断是否属于允许的角色组，返回布尔值；这两个判断不估算 token。
	switch (message.role) {
		case "user":
		case "bashExecution":
		// 扩展消息作为用户式输入，可作为边界起点。
		case "custom":
		// 以前的摘要消息也可作为用户式上下文起点。
		case "branchSummary":
		case "compactionSummary":
			// 上面一组连续 case 共用此返回值：该角色允许成为当前判定的起点。
			return true;
		case "assistant":
		case "toolResult":
			// 该角色/条目不符合起点规则；若在 switch 外，则表示未匹配任何允许角色。
			return false;
	}
	// 该角色/条目不符合起点规则；若在 switch 外，则表示未匹配任何允许角色。
	return false;
}

// 把条目转成可见消息后判断是否开新轮；压缩状态条目直接排除。
// 例如标签条目没有消息，some 返回 false；不访问磁盘。
function isTurnStartEntry(entry: SessionEntry): boolean {
	// 压缩记录是边界/检查点，不被当作新的用户请求。
	if (entry.type === "compaction") {
		// 该角色/条目不符合起点规则；若在 switch 外，则表示未匹配任何允许角色。
		return false;
	}
	// 一条原条目可能投影成多条消息，只需其中一条满足就视为轮起点。
	return sessionEntryToContextMessages(entry).some(isTurnStartMessage);
}

/**
 * Find valid cut points: indices of context-visible user-like or assistant messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 */
// 在 [startIndex,endIndex) 中枚举可保留的起点，返回升序原条目下标数组。
// 跳过压缩节点和只有工具结果的节点；例如 assistant 调用与随后结果一起保留，不修改输入。
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	// 保存允许的边界下标，后面从预算位置寻找最近合法起点。
	const cutPoints: number[] = [];
	// 半开区间扫描，endIndex 本身不包含在范围内。
	for (let i = startIndex; i < endIndex; i++) {
		// 用下标取得当前条目，后续先按 type 判断其内容。
		const entry = entries[i];
		// 压缩记录是边界/检查点，不被当作新的用户请求。
		if (entry.type === "compaction") {
			continue;
		}
		// 元数据没有可见消息，工具结果不能开头，其他允许角色才产生候选。
		if (sessionEntryToContextMessages(entry).some(isCutPointMessage)) {
			// 记录原条目位置，不是转换后的消息位置。
			cutPoints.push(i);
		}
	}
	// 候选按扫描顺序排列，天然是升序。
	return cutPoints;
}

/**
 * Find the context-visible user-role message that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 */
// 从给定条目向前找到所在轮的起点下标；包含两个端点，找不到返回 -1，没有副作用。
// 例如给工具结果的下标，会跨过助手追到前面的用户请求。
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	// 向旧方向扫描，包括当前条目和允许范围的首条。
	for (let i = entryIndex; i >= startIndex; i--) {
		// 找到用户式消息的原条目就停止继续向前。
		if (isTurnStartEntry(entries[i])) {
			// 返回当前命中的原条目下标。
			return i;
		}
	}
	// -1 是未找到的约定值，不能直接当正常数组下标。
	return -1;
}

// 保留边界及是否切断一轮的信息；用于把被切开的前半轮另外总结。
export interface CutPointResult {
	/** Index of first entry to keep */
	// 保留原文的首条位置，索引的是传入的条目数组。
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	// 切断轮的起点；未切轮或无法定位时按约定使用 -1。
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	// 切点不在用户式起点且能找到该轮起点时为 true。
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
// 按近似 keepRecentTokens 从尾部反向累计，再对齐合法切点；返回保留起点和分轮信息。
// 输入原条目、半开范围和近期预算，不修改历史。比如大工具结果超预算，仍要带上其前的助手调用，而非从结果中间切。
// 因此保留量不是精确 token 数，也不是固定最近几轮；相邻不贡献上下文的元数据会一并带上。
export function findCutPoint(
	// 当前函数使用的原始会话条目；它不是 JSON 字符串，也不是最终模型消息数组。
	entries: SessionEntry[],
	// 参与选择的起始下标，包含这个位置。
	startIndex: number,
	// 参与选择的结束下标，不包含这个位置，即半开区间。
	endIndex: number,
	// 近期原文的近似 token 目标；合法边界/工具配对可使实际保留量偏离它。
	keepRecentTokens: number,
): CutPointResult {
	// 先求合法起点，再估算预算，避免把任意 JSONL 行都当作可切位置。
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	// 范围中没有合法对话起点时，返回范围起点和非分轮状态。
	if (cutPoints.length === 0) {
		// 明确的退化结果；调用方仍需确认起点条目存在和是否有内容可总结。
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// Walk backwards from newest, accumulating estimated message sizes
	// 从尾部开始累加近期原文大小。
	let accumulatedTokens = 0;
	// 未达到预算时默认全保留范围中的对话；let 允许之后改为更靠后的合法切点。
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	// 从范围内最后一条往前扫描，优先保留最近内容。
	for (let i = endIndex - 1; i >= startIndex; i--) {
		// 用下标取得当前条目，后续先按 type 判断其内容。
		const entry = entries[i];
		// 同一条目可产生多条消息，reduce 将各消息估算相加。
		const messageTokens = sessionEntryToContextMessages(entry).reduce(
			// 箭头回调用上轮 sum 加本条消息的近似 token 量。
			(sum, message) => sum + estimateTokens(message),
			// reduce 的初始累加值是0，空消息数组也能得到0。
			0,
		);
		// 无可见内容或估算为0的条目不推进预算，但可在之后随元数据一起保留。
		if (messageTokens === 0) continue;
		// 计入这条候选前后范围里的消息量。
		accumulatedTokens += messageTokens;

		// Check if we've exceeded the budget
		// 达到近期保留目标后停止向更早历史扩展；这只是估算目标。
		if (accumulatedTokens >= keepRecentTokens) {
			// Prefer the closest valid cut point at or after this entry. If trailing
			// tool results exceed the budget by themselves, keep their preceding
			// assistant tool call instead of falling back to the first message.
			// 优先当前或之后最近合法点；没有更后候选才用最后合法点，例如末尾大工具结果前的助手调用。
			cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
			break;
		}
	}

	// Scan backwards from cutIndex to include adjacent metadata entries that do not affect context.
	// 把切点前紧邻的纯元数据一起纳入，直到遇到有上下文内容的条目或压缩边界。
	while (cutIndex > startIndex) {
		// 检查保留起点的前一条原始条目。
		const prevEntry = entries[cutIndex - 1];
		// Stop at compaction boundaries or context-visible entries.
		// 遇到压缩边界或实际消息就不能再无条件向前移动。
		if (prevEntry.type === "compaction" || sessionEntryToContextMessages(prevEntry).length > 0) {
			break;
		}
		// 把前一条纯元数据并入保留区域，下轮继续检查。
		cutIndex--;
	}

	// Determine if this is a split turn
	// 取最终保留起点对应的条目。
	const cutEntry = entries[cutIndex];
	// 判断最终起点是否就是用户式轮起点。
	const startsTurn = isTurnStartEntry(cutEntry);
	// 若从半轮开始，另找这一轮原始请求，供前缀摘要使用；整轮起点不需要。
	const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		// 返回最终保留原文起点。
		firstKeptEntryIndex: cutIndex,
		// 带回被切轮的用户式起点，未切轮时为 -1。
		turnStartIndex,
		// 只有确实切在轮中且找到对应轮起点，才走分轮摘要路径。
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

// 首次摘要的实际提示词：按目标、约束、进度、决策、下一步、关键上下文分节；下方模板字符串不能混入源码注释。
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

// 增量摘要要求：保留旧重要信息，加入新进展，更新完成项和下一步，并允许去掉已无关内容；由模型判断如何改写。
const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

// 有 previousSummary 时采用的提示词，插入上面的更新要求；并不是把原摘要原封不动拼进最终结果。
const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

/**
 * Returns an error message when a summarization response cannot safely be persisted.
 * A length stop contains partial text and must not become a session checkpoint.
 */
// 检查响应是否因 error 或 length 不能保存为完整摘要；返回带 label 的错误说明或 undefined，不抛错、不改响应。
// 例如服务端达到输出上限时即使有部分文字，也应判定失败；aborted 的处理由具体调用者另行负责。
export function getSummarizationFailure(response: AssistantMessage, label: string): string | undefined {
	// 服务端/请求层明确报告错误时，不能使用其可能附带的文本。
	if (response.stopReason === "error") {
		// 优先保留真实错误信息，没有时使用兜底说明。
		return `${label} failed: ${response.errorMessage || "Unknown error"}`;
	}
	// 长度上限意味着摘要可能缺段，不能作为完整上下文检查点。
	if (response.stopReason === "length") {
		// 向调用者说明是生成被截断，而不是原始工具结果的本地截短。
		return `${label} failed: generation hit the token cap and the summary is incomplete`;
	}
	// 未命中 error/length，不由本函数判为失败；取消仍需调用者另行判断。
	return undefined;
}

// 把模型凭据、请求头、环境、取消信号、推理等级和路由 id 组装成请求配置；无网络副作用。
// 例如 thinkingLevel=off 时不写 reasoning；没有在这里把 reserveTokens 设置成输出上限。
function createSummarizationOptions(
	// 摘要使用的实际模型描述；Model 泛型保留不同 API 的配置类型，这里沿用现有 any 参数。
	model: Model<any>,
	// 上层解析好的模型凭据；string | undefined 要求这个位置存在，但允许传 undefined。
	apiKey: string | undefined,
	// 可选请求头字典，Record<string,string> 将每个头的键和值约束为字符串。
	headers: Record<string, string> | undefined,
	// 本次 provider 专用的环境值，不在这里改全局 process.env。
	env: Record<string, string> | undefined,
	// 可选取消信号，向请求/重试流程传递用户中止意图；不在这里创建 AbortController。
	signal: AbortSignal | undefined,
	// 可选推理等级；只有模型支持 reasoning 且不为 off 才写入请求选项。
	thinkingLevel: ThinkingLevel | undefined,
	// 可选请求路由 id，传递它不等于重新开启摘要缓存写入。
	sessionId: string | undefined,
): SimpleStreamOptions {
	// 同名字段简写组装新对象，不修改调用者的配置。
	const options: SimpleStreamOptions = { signal, apiKey, headers, env, sessionId };
	// 只向支持推理且实际启用的模型传 reasoning。
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		// 为本次独立摘要请求设置推理强度。
		options.reasoning = thinkingLevel;
	}
	// 返回组装结果，是否重试/发请求由公共入口决定。
	return options;
}

/**
 * Shared choke point for every compaction/branch-summary summarization call. Wraps the
 * single LLM call in {@link retryAssistantCall} so transient stream drops (e.g.
 * `terminated`, socket close) honor the configured retry policy instead of failing
 * the whole compaction on the first attempt. Deterministic errors and aborts return
 * immediately (see {@link retryAssistantCall}).
 */
// 两种摘要共享的真正模型请求入口：输入模型、摘要上下文、选项，可注入会话 streamFn 和重试策略。
// 返回最终 AssistantMessage；它等待流结果，不进入普通 Agent 工具循环，也不改主 Agent 状态或保存会话。
// 例如注入 SDK streamFn 时沿用其请求行为；未注入时调用 compat.completeSimple。瞬时失败可重试，底层异常仍可能向外抛。
export async function completeSummarization(
	// 摘要使用的实际模型描述；Model 泛型保留不同 API 的配置类型，这里沿用现有 any 参数。
	model: Model<any>,
	// 已经规范化的摘要请求上下文，包含系统摘要指令和待总结材料。
	context: TranscriptContext,
	// 本次摘要请求选项，公共入口会复制后设置摘要专用的缓存/路由项。
	options: SimpleStreamOptions,
	// 可选会话请求函数，保持 SDK 请求行为，同时不进入主 Agent 的消息/工具事件循环。
	streamFn?: StreamFn,
	// 可选瞬时失败重试策略，由 completeSummarization 的重试器使用。
	retry?: RetryPolicy,
	// 可选重试通知回调，帮助界面显示等待/重试状态，不作为模型输入。
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	// Avoid cache writes for one-off summaries. Reuse caller-supplied routing when available;
	// callers without a session ID, including branch summaries, receive a fresh routing ID.
	// 复制选项后覆盖摘要专用项，避免直接改调用者传入的对象。
	const requestOptions: SimpleStreamOptions = {
		// 对象展开复制现有可枚举字段；后写的字段覆盖同名旧值。
		...options,
		// 本次摘要不请求保留缓存写入；不是对所有供应商缓存命中的绝对保证。
		cacheRetention: "none",
		// 调用者提供路由 id 就复用，否则生成新 id；?? 只在 null/undefined 时取右侧。
		sessionId: options.sessionId ?? uuidv7(),
	};
	// 创建一次请求的异步函数交给重试器，每次重试都会重新执行它。
	const produce = async (): Promise<AssistantMessage> =>
		// 三元条件优先选择调用者提供的会话流函数。
		streamFn
			? // 先等待取得流对象，再等待 result() 汇总最终响应，不在这里转发普通聊天事件。
				(await streamFn(model, context, requestOptions)).result()
			: // 没有注入流函数时，走兼容层注册的模型完成 API。
				completeSimple(model, context, requestOptions);
	// 公共重试器负责重试范围、退避、取消和回调；这行返回其 Promise。
	return retryAssistantCall(produce, retry, requestOptions.signal, callbacks);
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
// 只需要摘要文字的薄包装：输入历史及模型请求配置，调用带 usage 的版本后返回 text。
// _reserveTokens 保留参数位置但不再控制输出上限；例如已有摘要时将交给模型更新。它会发模型请求，失败可抛错。
export async function generateSummary(
	// 本次待总结的新历史消息；仍要原文保留的近期尾部不传进这个参数。
	currentMessages: AgentMessage[],
	// 摘要使用的实际模型描述；Model 泛型保留不同 API 的配置类型，这里沿用现有 any 参数。
	model: Model<any>,
	// Unused. Kept for existing callers; summaries use the model's output limit (#9512).
	// 旧调用约定保留的位置参数，当前实现不使用它限制输出；显式 undefined 也合法。
	_reserveTokens: number | undefined,
	// 上层解析好的模型凭据；string | undefined 要求这个位置存在，但允许传 undefined。
	apiKey: string | undefined,
	// 可选请求头字典，Record<string,string> 将每个头的键和值约束为字符串。
	headers?: Record<string, string>,
	// 可选取消信号，向请求/重试流程传递用户中止意图；不在这里创建 AbortController。
	signal?: AbortSignal,
	// 可选摘要关注点；普通压缩追加到默认模板，分支摘要还受 replaceInstructions 控制。
	customInstructions?: string,
	// 上一次压缩的摘要文字，有值时请求模型更新已有检查点。
	previousSummary?: string,
	// 可选推理等级；只有模型支持 reasoning 且不为 off 才写入请求选项。
	thinkingLevel?: ThinkingLevel,
	// 可选会话请求函数，保持 SDK 请求行为，同时不进入主 Agent 的消息/工具事件循环。
	streamFn?: StreamFn,
	// 本次 provider 专用的环境值，不在这里改全局 process.env。
	env?: Record<string, string>,
	// 可选瞬时失败重试策略，由 completeSummarization 的重试器使用。
	retry?: RetryPolicy,
	// 可选重试通知回调，帮助界面显示等待/重试状态，不作为模型输入。
	callbacks?: RetryCallbacks,
	// 可选请求路由 id，传递它不等于重新开启摘要缓存写入。
	sessionId?: string,
): Promise<string> {
	return (
		await generateSummaryWithUsage(
			currentMessages,
			model,
			_reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			// 上次压缩文字检查点，供更新提示词继承旧目标/决策/进度。
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
			callbacks,
			sessionId,
		)
	).text;
	// await 完成后仅取 text 字段；usage 在这个兼容包装中被省略。
}

/** Build the provider context for a standalone summary request. */
// 把整段待总结文字包装成独立的系统指令加用户消息；返回规范化上下文，不发请求。
// 例如原来的十轮聊天在这里成为一条 user 材料消息，而不是继续那十轮对话。
function buildSummarizationContext(promptText: string): TranscriptContext {
	// 统一使用模型层的上下文格式，系统指令由下方固定摘要角色提供。
	return normalizeContext({
		// 指示模型只总结材料，不回答材料中原来的问题。
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		// 摘要请求只需要这一组新建的材料消息。
		messages: [
			{
				// 把材料作为新请求的用户输入，原角色已由序列化标签表达。
				role: "user",
				// 实际请求正文是文本块，不携带原会话图片的二进制数据。
				content: [{ type: "text", text: promptText }],
				// 给这条临时模型输入记录当前毫秒时间戳。
				timestamp: Date.now(),
			},
		],
	});
}

/** Generate or update a conversation summary and return its provider usage. */
// 生成或更新历史摘要，并返回 {text,usage}；输入待替代的消息、可选旧摘要及模型请求配置。
// 流程：选初始/更新提示词→应用自定义关注点→会话转文本→独立调用模型→拒绝 error/length/工具调用。
// 例如先前摘要记录“选方案A”，新增消息改变选择时，模型按更新规则合并；此函数不删原历史、不保存结果，失败会抛 Error。
export async function generateSummaryWithUsage(
	// 本次待总结的新历史消息；仍要原文保留的近期尾部不传进这个参数。
	currentMessages: AgentMessage[],
	// 摘要使用的实际模型描述；Model 泛型保留不同 API 的配置类型，这里沿用现有 any 参数。
	model: Model<any>,
	// Unused. Kept for existing callers; summaries use the model's output limit (#9512).
	// 旧调用约定保留的位置参数，当前实现不使用它限制输出；显式 undefined 也合法。
	_reserveTokens: number | undefined,
	// 上层解析好的模型凭据；string | undefined 要求这个位置存在，但允许传 undefined。
	apiKey: string | undefined,
	// 可选请求头字典，Record<string,string> 将每个头的键和值约束为字符串。
	headers?: Record<string, string>,
	// 可选取消信号，向请求/重试流程传递用户中止意图；不在这里创建 AbortController。
	signal?: AbortSignal,
	// 可选摘要关注点；普通压缩追加到默认模板，分支摘要还受 replaceInstructions 控制。
	customInstructions?: string,
	// 上一次压缩的摘要文字，有值时请求模型更新已有检查点。
	previousSummary?: string,
	// 可选推理等级；只有模型支持 reasoning 且不为 off 才写入请求选项。
	thinkingLevel?: ThinkingLevel,
	// 可选会话请求函数，保持 SDK 请求行为，同时不进入主 Agent 的消息/工具事件循环。
	streamFn?: StreamFn,
	// 本次 provider 专用的环境值，不在这里改全局 process.env。
	env?: Record<string, string>,
	// 可选瞬时失败重试策略，由 completeSummarization 的重试器使用。
	retry?: RetryPolicy,
	// 可选重试通知回调，帮助界面显示等待/重试状态，不作为模型输入。
	callbacks?: RetryCallbacks,
	// 可选请求路由 id，传递它不等于重新开启摘要缓存写入。
	sessionId?: string,
): Promise<{ text: string; usage: Usage }> {
	// Use update prompt if we have a previous summary, otherwise initial prompt
	// 有非空旧摘要就使用更新模板，否则生成首份摘要。
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	// 调用者有额外关注点时附加，不改变默认主体格式。
	if (customInstructions) {
		// 追加自定义关注点到摘要指令，而非改原会话消息。
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	// Serialize conversation to text so model doesn't try to continue it
	// Convert to LLM messages first (handles custom types like bashExecution, custom, etc.)
	// 将 bash/custom/摘要等应用消息转换成标准模型角色。
	const llmMessages = convertToLlm(currentMessages);
	// 转为待总结的文字材料；省略 thinking/图片，并截短单个长工具结果。
	const conversationText = serializeConversation(llmMessages);

	// Build the prompt with conversation wrapped in tags
	// 用 conversation 标签明确这段是材料；模板字符串插值只做字符串拼接。
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	// 已有旧摘要时额外提供它，不需要从磁盘重新取已压缩的原文。
	if (previousSummary) {
		// 让模型同时看到旧检查点和新增材料，生成更新后的摘要。
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	// 最后追加执行指令，使材料和要求分开组织。
	promptText += basePrompt;

	// 组装网络与推理配置，不在这一步执行请求。
	const completionOptions = createSummarizationOptions(model, apiKey, headers, env, signal, thinkingLevel, sessionId);

	// 等待公共摘要模型请求；以下多行是这同一次调用的实参。
	const response = await completeSummarization(
		model,
		// 用当前材料构造独立摘要上下文，不复用主会话的继续生成状态。
		buildSummarizationContext(promptText),
		completionOptions,
		streamFn,
		retry,
		callbacks,
	);

	// 拒绝服务端错误或达到输出上限的不完整摘要。
	const failure = getSummarizationFailure(response, "Summarization");
	// 公共校验返回错误说明时不继续提取正文。
	if (failure) {
		// 抛出失败，让上层停止保存这次压缩结果。
		throw new Error(failure);
	}
	// 摘要只允许给出结果，意外工具调用不执行，直接按失败处理。
	if (response.content.some((block) => block.type === "toolCall")) {
		// 把不符合摘要请求预期的输出报告给上层。
		throw new Error("Summarization attempted to call a tool");
	}

	// 提取可见文字，忽略模型的 thinking 等非文字块。
	const textContent = contentText(response.content);

	// 分别返回摘要文字和实际请求消耗，便于持久化与计费。
	return { text: textContent, usage: response.usage };
}

// ============================================================================
// Compaction Preparation (for extensions)
// ============================================================================

// 纯准备阶段输出，扩展可查看或接管；“discarded”指不再重放进模型上下文，原磁盘条目仍保留。
export interface CompactionPreparation {
	/** UUID of first entry to keep */
	// 压缩后仍以原文重放的近期尾部起点 id；更早内容由摘要代替进入模型上下文。
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	// 要由历史摘要替代的完整旧轮消息，已应用上下文编辑。
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	// 切断某一轮时，该轮保留起点之前的前半段，需要另一份前缀摘要。
	turnPrefixMessages: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	// 切点不在用户式起点且能找到该轮起点时为 true。
	isSplitTurn: boolean;
	// 压缩前投影上下文的估算 token 数，不是摘要请求自己的消耗。
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	// 上次压缩检查点，供模型增量更新，而非反复展开全部旧原文。
	previousSummary?: string;
	/** File operations extracted from messagesToSummarize */
	// 旧摘要和本次材料累计的文件记录。
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	// 准备时采用的设置快照引用，供上层扩展查看。
	settings: CompactionSettings;
}

// 按编辑后的可见消息判定轮起点；返回布尔值，无副作用。
// 例如原用户消息被 context_edit 隐藏后，不能再按原内容把它当成当前可见起点。
function isProjectedTurnStart(entry: ProjectedSessionEntry): boolean {
	// 压缩检查点本身不代表新的用户轮。
	if (entry.sourceEntry.type === "compaction") return false;
	// 只检查实际投影的消息，空投影得到 false。
	return entry.messages.some(isTurnStartMessage);
}

// 在投影条目中向前找轮起点，返回条目下标或 -1；不更改输入。
// 与原条目版的区别是尊重被隐藏/替换后的消息，例如删掉的失败尝试不再贡献可见上下文。
function findProjectedTurnStartIndex(entries: ProjectedSessionEntry[], entryIndex: number, startIndex: number): number {
	// 向旧方向扫描，包括当前条目和允许范围的首条。
	for (let i = entryIndex; i >= startIndex; i--) {
		// 找到最近的可见用户式起点就返回。
		if (isProjectedTurnStart(entries[i])) return i;
	}
	// -1 是未找到的约定值，不能直接当正常数组下标。
	return -1;
}

// 在实际模型投影上选择近期保留边界，并识别恢复尝试末尾的隐藏片段；输入投影范围和近似预算，返回 CutPointResult。
// 例如已发送请求后的失败助手尝试被隐藏，可把该请求纳入前缀摘要；普通元数据不能让尚未发送输入越过原文保留边界。
// 不改原历史，工具结果仍不能独立成为切点。
function findProjectedCutPoint(
	// 当前函数使用的原始会话条目；它不是 JSON 字符串，也不是最终模型消息数组。
	entries: ProjectedSessionEntry[],
	// 参与选择的起始下标，包含这个位置。
	startIndex: number,
	// 参与选择的结束下标，不包含这个位置，即半开区间。
	endIndex: number,
	// 近期原文的近似 token 目标；合法边界/工具配对可使实际保留量偏离它。
	keepRecentTokens: number,
): CutPointResult {
	// 保存允许的边界下标，后面从预算位置寻找最近合法起点。
	const cutPoints: number[] = [];
	// 半开区间扫描，endIndex 本身不包含在范围内。
	for (let i = startIndex; i < endIndex; i++) {
		// 用下标取得当前条目，后续先按 type 判断其内容。
		const entry = entries[i];
		// 只把非压缩且仍有合法可见消息的条目记为候选，隐藏条目不能开保留尾部。
		if (entry.sourceEntry.type !== "compaction" && entry.messages.some(isCutPointMessage)) cutPoints.push(i);
	}
	// 范围中没有合法对话起点时，返回范围起点和非分轮状态。
	if (cutPoints.length === 0) {
		// 明确的退化结果；调用方仍需确认起点条目存在和是否有内容可总结。
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// 从尾部开始累加近期原文大小。
	let accumulatedTokens = 0;
	// 记录此次是否确实触及近期预算，恢复尾部的特别处理以此为前提。
	let exceededBudget = false;
	// 预算足够时默认从最早合法点保留。
	let cutIndex = cutPoints[0];
	// 从范围内最后一条往前扫描，优先保留最近内容。
	for (let i = endIndex - 1; i >= startIndex; i--) {
		// 只累计投影后真实保留的消息；被隐藏内容不再按原大小占预算。
		const messageTokens = entries[i].messages.reduce((sum, message) => sum + estimateTokens(message), 0);
		// 无可见内容或估算为0的条目不推进预算，但可在之后随元数据一起保留。
		if (messageTokens === 0) continue;
		// 计入这条候选前后范围里的消息量。
		accumulatedTokens += messageTokens;
		// 达到近期保留目标后停止向更早历史扩展；这只是估算目标。
		if (accumulatedTokens >= keepRecentTokens) {
			// 已经达到预算，后续允许检查末尾是否是恢复隐藏片段。
			exceededBudget = true;
			// 优先当前或之后最近合法点；没有更后候选才用最后合法点，例如末尾大工具结果前的助手调用。
			cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
			break;
		}
	}

	// A recovery attempt and its omission edits are context-invisible after the last
	// visible input. Advance only for a closed suffix containing an omitted assistant
	// attempt; arbitrary metadata must not move the cut past unsent input.
	// 取切点之后到范围末尾的投影条目，slice 不改变原数组。
	const suffix = entries.slice(cutIndex + 1, endIndex);
	// 局部箭头判定：如果忽略 context_edit，原条目本来是否能贡献消息。
	const isIntrinsicallyVisible = (entry: ProjectedSessionEntry): boolean =>
		// 编辑记录本身不算可见原消息；原条目能转成消息才有“被隐藏”的含义。
		entry.sourceEntry.type !== "context_edit" && sessionEntryToContextMessages(entry.sourceEntry).length > 0;
	// 局部判定：本来可见但现在投影为空，才称为被隐藏。
	const isOmitted = (entry: ProjectedSessionEntry): boolean =>
		// 普通标签等天然空条目不被误算为隐藏消息。
		isIntrinsicallyVisible(entry) && entry.messages.length === 0;
	// 记录末尾被隐藏原消息的 id，检查替换编辑是否指向这段之外。
	const omittedSuffixIds = new Set(suffix.filter(isOmitted).map((entry) => entry.sourceEntry.id));
	// 检查末尾是否有针对外部消息的非空替换；有的话不能当作封闭恢复片段处理。
	const hasExternalReplacement = suffix.some(
		(entry) =>
			// 只关注上下文编辑条目。
			entry.sourceEntry.type === "context_edit" &&
			// 非 null 表示替换内容；null 只隐藏，不带新内容。
			entry.sourceEntry.replacement !== null &&
			// 目标不在末尾被隐藏集合中，说明编辑影响了片段之外的上下文。
			!omittedSuffixIds.has(entry.sourceEntry.targetId),
	);
	// 以下 && 合取必须全部满足，才认定为可跨过的恢复隐藏尾部。
	const isRecoveryOmissionSuffix =
		// 确实达到保留预算，而不是任意空尾部都移动边界。
		exceededBudget &&
		// 不能包含影响末尾之外的内容替换。
		!hasExternalReplacement &&
		// 末尾至少存在一次被隐藏的助手尝试，避免把任意元数据当恢复流程。
		suffix.some(
			(entry) =>
				// 恢复尝试必须是普通助手消息且现在确实被隐藏。
				entry.sourceEntry.type === "message" && entry.sourceEntry.message.role === "assistant" && isOmitted(entry),
		) &&
		// 还要求整个末尾都是允许的隐藏/天然不可见条目。
		suffix.every(
			// 不允许跨过压缩检查点，也不允许跨过仍可见的真实消息。
			(entry) => entry.sourceEntry.type !== "compaction" && (!isIntrinsicallyVisible(entry) || isOmitted(entry)),
		);
	// 满足封闭恢复尾部时将起点向后一格；普通尾部不做此移动。
	if (isRecoveryOmissionSuffix) cutIndex++;

	// 把切点前紧邻的当前不可见条目一并纳入；它们可以是元数据，也可以是已隐藏的旧消息。
	while (cutIndex > startIndex) {
		// 检查前一条在当前投影是否不贡献消息。
		const previous = entries[cutIndex - 1];
		// 遇到检查点或可见消息就停止向前包含元数据。
		if (previous.sourceEntry.type === "compaction" || previous.messages.length > 0) break;
		// 将当前不可见的前一条并入保留范围，下轮继续检查。
		cutIndex--;
	}
	// 按当前可见投影判断最终起点是否为轮起点。
	const startsTurn = isProjectedTurnStart(entries[cutIndex]);
	// 若切在半轮，则定位可见原请求，后面单独总结前缀。
	const turnStartIndex = startsTurn ? -1 : findProjectedTurnStartIndex(entries, cutIndex, startIndex);
	return {
		// 返回最终保留原文起点。
		firstKeptEntryIndex: cutIndex,
		// 带回被切轮的用户式起点，未切轮时为 -1。
		turnStartIndex,
		// 只有确实切在轮中且找到对应轮起点，才走分轮摘要路径。
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
}

// 纯准备入口：输入当前根到叶子的原始路径和设置，返回可压缩计划或 undefined，不请求模型、不读写磁盘。
// 先构建规范投影、继承旧摘要、估算当前大小，再决定近期原文起点，并把旧完整轮与当前半轮前缀分开。
// 例如尾部保留从 assistant 开始时，其 user 请求会进入 turnPrefixMessages；真正摘要生成和落盘由后续调用承担。
export function prepareCompaction(
	// 当前原始根到叶路径；prepareCompaction 会先构建投影再选材料。
	pathEntries: SessionEntry[],
	// 本次压缩配置，keepRecentTokens 决定原文保留目标，reserveTokens 影响自动触发阈值。
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	// 刚压缩完还没有追加其他条目时，不立即对同一个检查点再次压缩。
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		// 刚追加的是压缩节点，没有新的可总结材料，停止本次准备。
		return undefined;
	}

	// 按最新压缩边界和 context_edit 构建模型实际可见内容，原磁盘历史不变。
	const projection = buildSessionProjection(pathEntries);
	// 保留每段消息对应的原条目，之后边界用稳定 id 表示。
	const projectedEntries = projection.entries;
	// 取投影来源数组，供旧摘要文件元数据提取使用。
	const sourceEntries = projectedEntries.map((entry) => entry.sourceEntry);
	// The newest compaction is projected first. Older compaction entries can still
	// occur in its retained raw range, but their projected contribution is empty.
	// 寻找当前仍有效且有投影消息的压缩检查点，不误用保留区里被屏蔽的更旧压缩节点。
	const prevCompactionIndex = projectedEntries.findIndex(
		// 必须是压缩来源且实际有消息贡献，才是本轮继承的旧摘要。
		(entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
	);

	// 没有旧检查点时保持 undefined，后续使用初始摘要模板。
	let previousSummary: string | undefined;
	// 默认从整个投影开头选可总结历史。
	let boundaryStart = 0;
	// 有有效旧检查点时继承摘要，并从它之后的近期原文继续选择本次材料。
	if (prevCompactionIndex >= 0) {
		// 取得旧摘要文字，稍后与新增材料一起交给模型更新。
		previousSummary = (projectedEntries[prevCompactionIndex].sourceEntry as CompactionEntry).summary;
		// The canonical projection has already selected the previous compaction's retained tail.
		// 旧摘要自己不再算作新历史，从它后面的已保留尾部开始选择。
		boundaryStart = prevCompactionIndex + 1;
	}
	// 当前范围结束位置为数组长度，后续 slice 不包含这个位置。
	const boundaryEnd = projectedEntries.length;
	// 估当前投影，并避免用编辑/压缩之前的过期助手 usage 作基线。
	const tokensBefore = estimateProjectedContextTokens(projection, pathEntries).tokens;
	// 按近期预算选择合法切点，尊重隐藏编辑与工具调用配对。
	const cutPoint = findProjectedCutPoint(projectedEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

	// ?. 处理退化边界没有实际条目的情况，避免直接访问 undefined.sourceEntry。
	const firstKeptEntry = projectedEntries[cutPoint.firstKeptEntryIndex]?.sourceEntry;
	// 无法得到稳定保留 id 就不生成压缩计划。
	if (!firstKeptEntry?.id) return undefined;
	// 记住近期原文起点，SessionManager 之后用它重建上下文。
	const firstKeptEntryId = firstKeptEntry.id;
	// 切半轮时完整旧历史止于该轮开始，否则止于保留起点。
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// 以下链式调用提取被历史摘要替代的完整旧轮消息。
	const messagesToSummarize = projectedEntries
		// 取旧摘要之后、完整历史结束之前的条目；不包括 end 位置。
		.slice(boundaryStart, historyEnd)
		// 每条目转零或多条对话消息，再摊平成一个数组，排除系统状态和旧检查点。
		.flatMap(getMessagesFromProjectedEntryForCompaction);
	// 只在切半轮时收集当前轮前缀，整轮边界用空数组。
	const turnPrefixMessages = cutPoint.isSplitTurn
		? // 三元表达式为真分支继续从投影条目截取前缀。
			projectedEntries
				// 前缀从原请求开始，到保留原文起点之前结束，不包含仍会原文重放的尾部。
				.slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex)
				// 将前缀条目映射为真实可见对话消息。
				.flatMap(getMessagesFromProjectedEntryForCompaction)
		: // 没有切半轮就没有额外前缀摘要材料。
			[];

	// 没有任何可替代内容时不调用模型生成空压缩。
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;

	// Extract file operations from edited model-visible messages and the previous compaction.
	// 先继承旧内置压缩清单，再从本次旧历史中记录文件操作。
	const fileOps = extractFileOperations(messagesToSummarize, sourceEntries, prevCompactionIndex);

	// Also extract file ops from turn prefix if splitting
	// 切半轮时，前缀材料里的文件操作也应跟随摘要留下。
	if (cutPoint.isSplitTurn) {
		// 逐个检查前缀中已投影后的消息。
		for (const msg of turnPrefixMessages) {
			// 从助手工具调用和工具结果的 nestedCalls 中识别 read/write/edit 路径。
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		// 稳定的近期原文起点 id，准备/生成阶段都沿用同一边界，不靠行号推测。
		firstKeptEntryId,
		// 需要由历史摘要替代的旧完整轮材料，不包含仍要原文保留的尾部。
		messagesToSummarize,
		// 当前被切轮的前半段材料，只有分轮时需要单独摘要。
		turnPrefixMessages,
		// 把边界判定传给生成阶段，它决定需要一次还是多段摘要。
		isSplitTurn: cutPoint.isSplitTurn,
		// 本次压缩前的上下文估算，用于比较压缩规模，不是摘要调用费用。
		tokensBefore,
		// 上次压缩文字检查点，供更新提示词继承旧目标/决策/进度。
		previousSummary,
		// 本轮累计文件操作集合，稍后转为正文和 details 的清单。
		fileOps,
		// 返回准备阶段采用的设置，便于扩展检查本次计划。
		settings,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

// 半轮前缀的实际提示词：只总结已给出的请求/进展/继续所需上下文，不猜测另存的后半轮。
const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 * @param sessionId - Optional routing session ID forwarded without enabling prompt caching
 */
// 执行准备好的压缩计划；输入计划、模型和请求配置，返回摘要、保留 id、压缩前估算及 usage/details。
// 非分轮通常调用一次模型；分轮可分别更新完整历史摘要、生成当前轮前缀摘要，再拼成一份结果。
// 例如 user→assistant→toolResult 切在 assistant，前面的 user 用前缀摘要解释，后半段继续原文保留。
// 这个函数会发模型请求并可能抛错，但不修改 SessionManager、不删除 JSONL；AgentSession 校验成功后再追加压缩节点。
export async function compact(
	// prepareCompaction 的准备结果，包含待总结旧历史、可选半轮前缀和原文保留起点。
	preparation: CompactionPreparation,
	// 摘要使用的实际模型描述；Model 泛型保留不同 API 的配置类型，这里沿用现有 any 参数。
	model: Model<any>,
	// 上层解析好的模型凭据；string | undefined 要求这个位置存在，但允许传 undefined。
	apiKey: string | undefined,
	// 可选请求头字典，Record<string,string> 将每个头的键和值约束为字符串。
	headers?: Record<string, string>,
	// 可选摘要关注点；普通压缩追加到默认模板，分支摘要还受 replaceInstructions 控制。
	customInstructions?: string,
	// 可选取消信号，向请求/重试流程传递用户中止意图；不在这里创建 AbortController。
	signal?: AbortSignal,
	// 可选推理等级；只有模型支持 reasoning 且不为 off 才写入请求选项。
	thinkingLevel?: ThinkingLevel,
	// 可选会话请求函数，保持 SDK 请求行为，同时不进入主 Agent 的消息/工具事件循环。
	streamFn?: StreamFn,
	// 本次 provider 专用的环境值，不在这里改全局 process.env。
	env?: Record<string, string>,
	// 可选瞬时失败重试策略，由 completeSummarization 的重试器使用。
	retry?: RetryPolicy,
	// 可选重试通知回调，帮助界面显示等待/重试状态，不作为模型输入。
	callbacks?: RetryCallbacks,
	// 可选请求路由 id，传递它不等于重新开启摘要缓存写入。
	sessionId?: string,
): Promise<CompactionResult> {
	const {
		// 稳定的近期原文起点 id，准备/生成阶段都沿用同一边界，不靠行号推测。
		firstKeptEntryId,
		// 需要由历史摘要替代的旧完整轮材料，不包含仍要原文保留的尾部。
		messagesToSummarize,
		// 当前被切轮的前半段材料，只有分轮时需要单独摘要。
		turnPrefixMessages,
		isSplitTurn,
		// 本次压缩前的上下文估算，用于比较压缩规模，不是摘要调用费用。
		tokensBefore,
		// 上次压缩文字检查点，供更新提示词继承旧目标/决策/进度。
		previousSummary,
		// 本轮累计文件操作集合，稍后转为正文和 details 的清单。
		fileOps,
		// 从准备结果取生成需要的字段，没有重新从磁盘加载或改变准备对象。
	} = preparation;

	// Generate summaries and merge into one
	// 最终摘要稍后在分轮或普通分支中赋值。
	let summary: string;
	// 累计本次摘要请求用量，不是主会话历史用量。
	let summaryUsage: Usage;

	// 有实际前缀材料才执行分轮路径，避免多发无内容的模型请求。
	if (isSplitTurn && turnPrefixMessages.length > 0) {
		// 没有新增完整历史时直接沿用旧摘要；完全没有旧历史时用固定说明。
		let historyText = previousSummary ?? "No prior history.";
		// 只有确实为完整历史请求了模型才产生这部分 usage。
		let historyUsage: Usage | undefined;
		// 完整旧历史非空时才生成/更新这一部分摘要。
		if (messagesToSummarize.length > 0) {
			// 先等完整历史摘要生成；下方实参保持本次请求的路由、重试和取消配置。
			const historyResult = await generateSummaryWithUsage(
				// 需要由历史摘要替代的旧完整轮材料，不包含仍要原文保留的尾部。
				messagesToSummarize,
				model,
				undefined,
				apiKey,
				headers,
				signal,
				customInstructions,
				// 上次压缩文字检查点，供更新提示词继承旧目标/决策/进度。
				previousSummary,
				thinkingLevel,
				streamFn,
				env,
				retry,
				callbacks,
				sessionId,
			);
			// 以模型更新后的文字替换先前的旧摘要/空历史说明。
			historyText = historyResult.text;
			// 记录本次完整历史请求消耗，稍后与前缀请求相加。
			historyUsage = historyResult.usage;
		}
		// 再独立请求当前半轮前缀摘要，不让模型重构仍保留的后半轮。
		const turnPrefixResult = await generateTurnPrefixSummary(
			// 当前被切轮的前半段材料，只有分轮时需要单独摘要。
			turnPrefixMessages,
			model,
			apiKey,
			headers,
			env,
			signal,
			thinkingLevel,
			streamFn,
			retry,
			callbacks,
			sessionId,
			customInstructions,
		);
		// Merge into single summary
		// 用分隔线连接完整历史检查点和半轮上下文，组成一份最终摘要。
		summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.text}`;
		// 发生两次请求就合并各 token/费用字段，只发生前缀请求则直接用它的 usage。
		summaryUsage = historyUsage ? combineUsage(historyUsage, turnPrefixResult.usage) : turnPrefixResult.usage;
	} else {
		// Just generate history summary
		// 没有分轮时只请求一份历史摘要；存在旧检查点时按更新模板合并。
		const result = await generateSummaryWithUsage(
			// 需要由历史摘要替代的旧完整轮材料，不包含仍要原文保留的尾部。
			messagesToSummarize,
			model,
			undefined,
			apiKey,
			headers,
			signal,
			customInstructions,
			// 上次压缩文字检查点，供更新提示词继承旧目标/决策/进度。
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
			callbacks,
			sessionId,
		);
		// 接收实际模型生成文字，而不是简单截取旧消息。
		summary = result.text;
		// 接收这次摘要请求的真实用量记录。
		summaryUsage = result.usage;
	}

	// Compute file lists and append to summary
	// 将累积集合去重、分类、排序，正文和 details 使用同一份清单。
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	// 将文件清单以标签文本追加到摘要末尾。
	summary += formatFileOperations(readFiles, modifiedFiles);

	// 持久化检查点必须有稳定保留起点；缺失可能说明旧会话尚未正确迁移。
	if (!firstKeptEntryId) {
		// 没有起点就拒绝返回可保存结果，避免无法重建压缩后的尾部。
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	return {
		// 返回最终生成文字；文件清单已在模型返回后追加。
		summary,
		// 稳定的近期原文起点 id，准备/生成阶段都沿用同一边界，不靠行号推测。
		firstKeptEntryId,
		// 本次压缩前的上下文估算，用于比较压缩规模，不是摘要调用费用。
		tokensBefore,
		// 把一次或两次摘要消耗交给上层记账。
		usage: summaryUsage,
		// 内置 details 为文件清单；as 只声明预期类型，字段值来自上面的真实计算。
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
// 专门生成被切开一轮的前半段摘要；输入前缀消息、模型配置和可选关注点，返回文字和 usage。
// 先转文本，再用前缀专用模板独立调用模型；例如保留工具结果后续处理时，摘要交代此前用户要求及已完成步骤。
// 不保存结果，不推断未给出的后半轮，error/length/工具调用会导致抛错。
async function generateTurnPrefixSummary(
	// 按时间排序的待处理消息；具体是历史或半轮前缀由当前函数用途决定。
	messages: AgentMessage[],
	// 摘要使用的实际模型描述；Model 泛型保留不同 API 的配置类型，这里沿用现有 any 参数。
	model: Model<any>,
	// 上层解析好的模型凭据；string | undefined 要求这个位置存在，但允许传 undefined。
	apiKey: string | undefined,
	// 可选请求头字典，Record<string,string> 将每个头的键和值约束为字符串。
	headers?: Record<string, string>,
	// 本次 provider 专用的环境值，不在这里改全局 process.env。
	env?: Record<string, string>,
	// 可选取消信号，向请求/重试流程传递用户中止意图；不在这里创建 AbortController。
	signal?: AbortSignal,
	// 可选推理等级；只有模型支持 reasoning 且不为 off 才写入请求选项。
	thinkingLevel?: ThinkingLevel,
	// 可选会话请求函数，保持 SDK 请求行为，同时不进入主 Agent 的消息/工具事件循环。
	streamFn?: StreamFn,
	// 可选瞬时失败重试策略，由 completeSummarization 的重试器使用。
	retry?: RetryPolicy,
	// 可选重试通知回调，帮助界面显示等待/重试状态，不作为模型输入。
	callbacks?: RetryCallbacks,
	// 可选请求路由 id，传递它不等于重新开启摘要缓存写入。
	sessionId?: string,
	// 可选摘要关注点；普通压缩追加到默认模板，分支摘要还受 replaceInstructions 控制。
	customInstructions?: string,
): Promise<{ text: string; usage: Usage }> {
	// 将前缀的应用消息转为标准模型消息再序列化。
	const llmMessages = convertToLlm(messages);
	// 转为待总结的文字材料；省略 thinking/图片，并截短单个长工具结果。
	const conversationText = serializeConversation(llmMessages);
	// 把前缀材料和只总结前缀的要求分节组合成一条模型输入。
	let promptText = `# Conversation\n${conversationText}\n\n# Instructions\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	// 调用者有额外关注点时附加，不改变默认主体格式。
	if (customInstructions) {
		// 自定义关注点追加在专用前缀指令后，不替换原有约束。
		promptText = `${promptText}\n\nAdditional focus: ${customInstructions}`;
	}

	// 等待公共摘要模型请求；以下多行是这同一次调用的实参。
	const response = await completeSummarization(
		model,
		// 用当前材料构造独立摘要上下文，不复用主会话的继续生成状态。
		buildSummarizationContext(promptText),
		// 沿用同一请求的凭据、推理强度和路由 id，取消信号仍可中止等待。
		createSummarizationOptions(model, apiKey, headers, env, signal, thinkingLevel, sessionId),
		streamFn,
		retry,
		callbacks,
	);

	// 前缀也必须是完整摘要，不能因只是半轮就接受长度截断。
	const failure = getSummarizationFailure(response, "Turn prefix summarization");
	// 公共校验返回错误说明时不继续提取正文。
	if (failure) {
		// 抛出失败，让上层停止保存这次压缩结果。
		throw new Error(failure);
	}
	// 摘要只允许给出结果，意外工具调用不执行，直接按失败处理。
	if (response.content.some((block) => block.type === "toolCall")) {
		// 拒绝模型输出的工具请求，不执行它。
		throw new Error("Turn prefix summarization attempted to call a tool");
	}

	return {
		// 仅返回可见摘要文字，忽略 thinking。
		text: contentText(response.content),
		// 返回前缀请求本身的用量。
		usage: response.usage,
	};
}
