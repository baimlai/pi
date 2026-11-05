// 会话树导航的分支摘要：AgentSession 收集离开路径，调用本模块生成文字，再由 SessionManager 保存。
// 区别于长会话滚动压缩，这里总结的是被离开的探索分支；旧历史仍在追加式 JSONL 中。
/**
 * Branch summarization for tree navigation.
 *
 * When navigating to a different point in the session tree, this generates
 * a summary of the branch being left so context isn't lost.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { RetryCallbacks, RetryPolicy } from "@earendil-works/pi-ai";
import { contentText, normalizeContext } from "@earendil-works/pi-ai";
import type { Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import {
	type ContextEditEntry,
	projectContextEntry,
	type ReadonlySessionManager,
	type SessionEntry,
} from "../session-manager.ts";
import { completeSummarization, estimateTokens, getSummarizationFailure } from "./compaction.ts";
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
// Types
// ============================================================================

// 分支摘要的返回对象；? 表示字段可缺省。调用方先检查 aborted/error，再使用 summary 和 usage。
export interface BranchSummaryResult {
	// 成功时的摘要文字；空历史也可能返回固定说明，而不是请求模型。
	summary?: string;
	// 实际摘要请求的 token/费用记录，不是原分支的累计消耗。
	usage?: Usage;
	// 只读取、未记为修改的路径清单。
	readFiles?: string[];
	// write/edit 调用及继承摘要里累计的修改路径。
	modifiedFiles?: string[];
	// 模型响应以 aborted 结束时返回取消标记。
	aborted?: boolean;
	// 可识别的失败原因；底层异常仍可能抛出，不能只靠此字段捕获所有异常。
	error?: string;
}

/** Details stored in BranchSummaryEntry.details for file tracking */
// 与摘要一起保存的文件追踪元数据；自然语言正文之外，下一次分支摘要还能继续合并它。
export interface BranchSummaryDetails {
	// 仅在读取集合且不在修改集合中的文件路径。
	readFiles: string[];
	// 去重并排序后的修改路径；不等于检查过磁盘差异。
	modifiedFiles: string[];
}

// type 重导出只公开编译期类型，运行时不会创建同名值。
export type { FileOperations } from "./utils.ts";

// 生成模型请求前的准备结果：选中的消息、累计文件记录及这些消息的近似 token 数。
export interface BranchPreparation {
	/** Messages extracted for summarization, in chronological order */
	// 已按时间从旧到新排好的消息；这里只选取分支摘要使用的消息种类。
	messages: AgentMessage[];
	/** File operations extracted from tool calls */
	// 可变 Set 记录对象，后续 computeFileLists 将其转换为摘要末尾的数组清单。
	fileOps: FileOperations;
	/** Total estimated tokens in messages */
	// estimateTokens 的估算总和，不是模型 tokenizer 的精确测量。
	totalTokens: number;
}

// 离开旧分支时的收集结果；不包含共同祖先本身，因为它仍属于目标路径。
export interface CollectEntriesResult {
	/** Entries to summarize, in chronological order */
	// 旧分支独有的原始条目，时间顺序从旧到新。
	entries: SessionEntry[];
	/** Common ancestor between old and new position, if any */
	// 两条路径最深的公共节点 id；没有共同节点时为 null。
	commonAncestorId: string | null;
}

// 摘要请求的配置；model/signal 必填，其余按 ? 标成可缺省，未提供时由这里或请求层决定。
export interface GenerateBranchSummaryOptions {
	/** Model to use for summarization */
	// 实际用于生成摘要的模型描述；这里沿用现有 Model<any>，不是在本函数里自动选择模型。
	model: Model<any>;
	/** API key for the model */
	// 调用方解析好的凭据；这里只向请求层转交，不负责获取登录信息。
	apiKey?: string;
	/** Request headers for the model */
	// 请求头字典；Record 的两个类型参数分别约束键和值。
	headers?: Record<string, string>;
	/** Provider-scoped environment values for the model */
	// 本次 provider 使用的环境值，由请求路径向下传递。
	env?: Record<string, string>;
	/** Abort signal for cancellation */
	// 取消信号必填，允许用户中断等待或请求；本函数不创建控制器。
	signal: AbortSignal;
	/** Thinking level for reasoning-capable models */
	// 模型支持 reasoning 且级别不为 off 时才会设置请求选项。
	thinkingLevel?: ThinkingLevel;
	/** Optional custom instructions for summarization */
	// 额外摘要关注点；默认追加在结构化提示词后面。
	customInstructions?: string;
	/** If true, customInstructions replaces the default prompt instead of being appended */
	// 为真且有 customInstructions 时，用自定义指令完全替换默认摘要格式。
	replaceInstructions?: boolean;
	/** Tokens reserved when selecting branch history (default 16384) */
	// 从模型上下文窗口里预留的空间；影响选取多少历史，不直接成为输出 maxTokens。
	reserveTokens?: number;
	/** Optional session stream function. Used to preserve SDK request behavior without mutating agent state. */
	// 可注入当前会话的请求函数，以沿用 SDK 超时/请求头等行为，同时不运行普通 Agent 对话循环。
	streamFn?: StreamFn;
	/** Retry policy for transient summarization errors. Reuses coding-agent's `settings.retry`. */
	// 瞬时摘要失败的重试策略，最终由 completeSummarization 统一执行。
	retry?: RetryPolicy;
	/** Optional callbacks for retry reporting (e.g. TUI retry indicators). */
	// 重试状态回调，可用于界面展示；回调不是摘要正文。
	callbacks?: RetryCallbacks;
}

// ============================================================================
// Entry Collection
// ============================================================================

/**
 * Collect entries that should be summarized when navigating from one position to another.
 *
 * Walks from oldLeafId back to the common ancestor with targetId, collecting entries
 * along the way. Does NOT stop at compaction boundaries - those are included and their
 * summaries become context.
 *
 * @param session - Session manager (read-only access)
 * @param oldLeafId - Current position (where we're navigating from)
 * @param targetId - Target position (where we're navigating to)
 * @returns Entries to summarize and the common ancestor
 */
// 收集离开旧叶子后会丢失的那段分支；输入只读会话、旧叶子和目标，返回旧分支条目与共同祖先，不改树。
// 例如 A→B→C 与 A→D，离开 C 去 D 时返回 [B,C]、共同祖先 A；旧 compaction 也会作为材料保留。
export function collectEntriesForBranchSummary(
	// 只暴露查询 API 的会话接口，收集分支时不应通过它追加/改写历史。
	session: ReadonlySessionManager,
	// 离开前的树位置，null 表示还没有旧分支。
	oldLeafId: string | null,
	// 导航目标条目的 id，用来找两条路径最近共同祖先。
	targetId: string,
): CollectEntriesResult {
	// If no old position, nothing to summarize
	// 尚无旧位置就没有需要携带走的分支信息。
	if (!oldLeafId) {
		// 返回明确的空结果，不继续查询目标路径。
		return { entries: [], commonAncestorId: null };
	}

	// Find common ancestor (deepest node that's on both paths)
	// getBranch 给出根到旧叶子的路径；map 取 id，Set 用于快速判断某节点是否也在旧路径。
	const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
	// 取得根到目标的路径，之后从末尾寻找最深共同节点。
	const targetPath = session.getBranch(targetId);

	// targetPath is root-first, so iterate backwards to find deepest common ancestor
	// 联合类型 string | null 同时表示找到的 id 和尚未找到；let 允许后续改值。
	let commonAncestorId: string | null = null;
	// 从目标向根扫描，第一次命中的公共节点就是最近共同祖先。
	for (let i = targetPath.length - 1; i >= 0; i--) {
		// 检查目标路径当前节点是否也出现在旧路径。
		if (oldPath.has(targetPath[i].id)) {
			// 保存祖先 id，不把它当作需要再次总结的旧分支内容。
			commonAncestorId = targetPath[i].id;
			// 已找到最深共同祖先，停止向根继续搜索。
			break;
		}
	}

	// Collect entries from old leaf back to common ancestor
	// 收集离开部分的原始条目，不会删除或改写磁盘历史。
	const entries: SessionEntry[] = [];
	// 用当前 id 沿 parentId 链回溯，根节点的 parentId 是 null。
	let current: string | null = oldLeafId;

	// 到共同祖先之前停止；祖先本身不加入收集结果。
	while (current && current !== commonAncestorId) {
		// 通过会话索引按 id 找节点，而不是按 JSONL 的相邻行猜父子关系。
		const entry = session.getEntry(current);
		// 父链节点缺失时结束回溯，保留已收集部分。
		if (!entry) break;
		// 先按叶子到祖先的方向收集节点。
		entries.push(entry);
		// 将游标移到父节点，下一轮继续向上。
		current = entry.parentId;
	}

	// Reverse to get chronological order
	// 原地倒序，让返回值恢复从旧到新的时间顺序。
	entries.reverse();

	// 对象属性简写返回两个同名局部变量。
	return { entries, commonAncestorId };
}

// ============================================================================
// Entry to Message Conversion
// ============================================================================

/**
 * Extract AgentMessage from a session entry.
 * Similar to getMessageFromEntry in compaction.ts but also handles compaction entries.
 */
// 把一个原始条目转成分支摘要材料；可选 edit 会隐藏或替换旧内容，返回 undefined 表示没有材料。
// 这里特意跳过 toolResult，仅携带助手调用说明；例如 read 的调用会保留，但整个大文件结果不会直接送入分支摘要。
// 自定义消息、旧分支摘要、旧压缩摘要会转换为应用消息；不改原始条目、不读写磁盘。
function getMessageFromEntry(entry: SessionEntry, edit?: ContextEditEntry): AgentMessage | undefined {
	// type 是条目联合类型的判别字段，各 case 内可访问对应字段。
	switch (entry.type) {
		// 普通对话条目持有实际的 AgentMessage。
		case "message":
			// Skip tool results - context is in assistant's tool call
			// 分支摘要这条路径直接跳过工具结果，区别于普通压缩的工具结果序列化。
			if (entry.message.role === "toolResult") return undefined;
			// 有编辑就使用投影后的首条消息；隐藏后数组为空，[0] 得到 undefined；否则复用原消息。
			return edit ? projectContextEntry(entry, edit)[0] : entry.message;

		// 扩展注入上下文的消息可以作为分支摘要材料。
		case "custom_message":
			// 同样尊重扩展消息上最新的上下文替换或隐藏。
			if (edit) return projectContextEntry(entry, edit)[0];
			// 用原内容和元数据构造应用消息；display 控制界面，不等于是否进入模型材料。
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);

		// 以前离开其他分支生成的摘要也属于可总结的上下文。
		case "branch_summary":
			// 将持久化分支摘要包装为应用层摘要消息。
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		// 旧压缩记录携带更早历史的摘要，不能因为跨过压缩边界就丢掉。
		case "compaction":
			// 只取摘要内容等信息，不把压缩前完整历史重新展开。
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);

		// These don't contribute to conversation content
		// 下面这些条目记录设置、扩展状态或标签，不是对话材料。
		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
		case "session_info":
			// 没有对应消息时返回 undefined；调用方将跳过此条目。
			return undefined;
	}
}

/**
 * Prepare entries for summarization with token budget.
 *
 * Walks entries from NEWEST to OLDEST, adding messages until we hit the token budget.
 * This ensures we keep the most recent context when the branch is too long.
 *
 * Also collects file operations from:
 * - Tool calls in assistant messages
 * - Existing branch_summary entries' details (for cumulative tracking)
 *
 * @param entries - Entries in chronological order
 * @param tokenBudget - Maximum tokens to include (0 = no limit)
 */
// 选择可装入摘要请求的近期分支内容；输入按时间排序的条目和近似预算，返回选中消息、文件记录和估算量。
// 先继承所有旧分支摘要文件清单，再取每个目标的最新 context_edit，最后从新往旧选材料。0 表示不限制。
// 例如预算只够最后三条，较早普通消息不再进入模型输入；旧摘要有特殊容纳规则，可能使估算超出预算。
export function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation {
	// 选中消息倒着扫描、向前插入，最终仍按时间正序交给模型。
	const messages: AgentMessage[] = [];
	// 本次准备使用独立的文件操作集合。
	const fileOps = createFileOps();
	// 累计已选择消息的近似 token 数，不把提示词、网络封装等当成精确计费。
	let totalTokens = 0;

	// First pass: collect file ops from ALL entries (even if they don't fit in token budget)
	// This ensures we capture cumulative file tracking from nested branch summaries
	// Only extract from pi-generated summaries (fromHook !== true), not extension-generated ones
	// 按原顺序扫描条目；不同遍历分别用于继承清单与记录最新编辑。
	for (const entry of entries) {
		// 只把 pi 自己生成的旧分支摘要 details 当作已知文件清单；扩展 details 结构可能不同。
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			// 断言预期元数据类型；下方数组检查才是对持久化数据的运行时检查。
			const details = entry.details as BranchSummaryDetails;
			// 会话/扩展元数据可能不符合预期，在这个数据边界确认它是数组。
			if (Array.isArray(details.readFiles)) {
				// 把旧摘要记录的读取路径并入集合，同一路径只保留一份。
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			// 修改清单也单独检查，避免缺少一个字段就丢弃整个旧摘要。
			if (Array.isArray(details.modifiedFiles)) {
				// Modified files go into both edited and written for proper deduplication
				// 逐个继承旧摘要中的修改路径。
				for (const f of details.modifiedFiles) {
					// 加入 edited 足以让最终修改清单去重；这里实际没有同时加入 written。
					fileOps.edited.add(f);
				}
			}
		}
	}

	// Context edits hide or replace earlier entries in model context; honor the latest edit per target.
	// Map 用目标 id 索引编辑条目，值是最新扫描到的 context_edit。
	const edits = new Map<string, ContextEditEntry>();
	// 按原顺序扫描条目；不同遍历分别用于继承清单与记录最新编辑。
	for (const entry of entries) {
		// 同一 targetId 后写入的 Map 值覆盖旧值，实现最后一次编辑生效。
		if (entry.type === "context_edit") edits.set(entry.targetId, entry);
	}

	// Second pass: walk from newest to oldest, adding messages until token budget
	// 先选最新消息，预算不足时优先保住近期探索。
	for (let i = entries.length - 1; i >= 0; i--) {
		// 取当前候选条目，文件和消息逻辑均依据它的实际内容。
		const entry = entries[i];
		// 以最新编辑后的投影为材料，被隐藏的消息不会进入摘要输入。
		const message = getMessageFromEntry(entry, edits.get(entry.id));
		// 纯元数据、工具结果或被隐藏条目跳过，不占消息估算预算。
		if (!message) continue;

		// Extract file ops from assistant messages (tool calls)
		// 在预算检查之前记录当前候选的工具调用，所以刚好超预算的这一候选也可能贡献文件路径。
		extractFileOpsFromMessage(message, fileOps);

		// 按字符/4 等规则近似估算，未调用真实模型 tokenizer。
		const tokens = estimateTokens(message);

		// Check budget before adding
		// 只有正预算才启用上限；下一条普通消息放不下就停止更早历史的选择。
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// If this is a summary entry, try to fit it anyway as it's important context
			// 旧摘要代表更早的大段历史，允许在接近上限时有一次例外。
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				// 当前尚未达到预算九成时，即使摘要本身过大也会加入；这是软预算，不保证请求必定装得下。
				if (totalTokens < tokenBudget * 0.9) {
					// 把更旧的消息插到数组开头，避免逆序改变会话含义。
					messages.unshift(message);
					// 把实际选入的消息估算量累加进去。
					totalTokens += tokens;
				}
			}
			// Stop - we've hit the budget
			// 达到预算后停止选择，不再越过这条去寻找更小的旧消息。
			break;
		}

		// 把更旧的消息插到数组开头，避免逆序改变会话含义。
		messages.unshift(message);
		// 把实际选入的消息估算量累加进去。
		totalTokens += tokens;
	}

	// 返回准备结果；尚未执行模型请求，也未向 SessionManager 追加摘要。
	return { messages, fileOps, totalTokens };
}

// ============================================================================
// Summary Generation
// ============================================================================

// 固定前言说明这份材料来自离开的另一条分支；以下模板字符串是实际摘要文字的一部分。
const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

// 默认分支摘要格式包含目标、偏好、进度、决策、下一步；以下英文模板原样发给模型。
const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * Generate a summary of abandoned branch entries.
 *
 * @param entries - Session entries to summarize (chronological order)
 * @param options - Generation options
 */
// 生成离开分支的摘要；输入原始分支条目和模型配置，返回摘要/用量或可识别的取消、错误状态。
// 流程是选材料→转成一段文字→独立请求模型→校验结束原因→附加文件清单；不会自己移动会话叶子或落盘。
// AgentSession 成功后再调用 branchWithSummary 保存。例如从尝试方案 B 返回方案 A，摘要会挂到 A 所在的新位置。
// async 返回 Promise；底层请求或回调仍可能抛异常，需要上层处理。
export async function generateBranchSummary(
	// 当前函数使用的原始会话条目；它不是 JSON 字符串，也不是最终模型消息数组。
	entries: SessionEntry[],
	// 分支摘要请求配置，字段含义见 GenerateBranchSummaryOptions；这里使用传入模型而不自行选择。
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	// 对象解构按字段名取请求配置；reserveTokens 在解构时提供默认值，其他字段继续保持调用者的选择。
	const {
		model,
		apiKey,
		headers,
		env,
		signal,
		thinkingLevel,
		customInstructions,
		replaceInstructions,
		// 只有该字段是 undefined 时采用 16384；这不是固定要求模型输出这么多 tokens。
		reserveTokens = 16384,
		streamFn,
		retry,
		callbacks,
		// 解构的来源是调用者传入的 options 对象，没有修改它。
	} = options;

	// Token budget = context window minus reserved space for prompt + response
	// 采用模型声明的窗口；为 0 或缺省等假值时回退到 128000。
	const contextWindow = model.contextWindow || 128000;
	// 为指令和回答留出空间后，把剩余部分作为历史选择预算；仍只是近似预算。
	const tokenBudget = contextWindow - reserveTokens;

	// 从准备结果中只取消息和文件集合，后续不把 totalTokens 当作服务端计费。
	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	// 没有可总结材料时无需调用模型，也就没有本次模型 usage。
	if (messages.length === 0) {
		// 用固定说明表示空材料，而不是让模型凭空编造摘要。
		return { summary: "No content to summarize" };
	}

	// Transform to LLM-compatible messages, then serialize to text
	// Serialization prevents the model from treating it as a conversation to continue
	// 把 bash/custom/摘要等应用消息转成模型可接受的角色消息。
	const llmMessages = convertToLlm(messages);
	// 再转成带角色标签的纯文本，作为被总结的材料，而不是普通多轮续聊请求。
	const conversationText = serializeConversation(llmMessages);

	// Build prompt
	// 先声明稍后赋值的字符串变量，用三个分支确定最终摘要指令。
	let instructions: string;
	// 只有替换开关为真且确实有自定义指令，才完全替换默认格式。
	if (replaceInstructions && customInstructions) {
		// 这一分支不再自动附带默认分节格式，调用者需要自行写清要求。
		instructions = customInstructions;
		// 只有自定义关注点、没有开启替换时，保留默认摘要格式。
	} else if (customInstructions) {
		// 在默认提示词后追加关注点，模板插值只是拼字符串。
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	} else {
		// 没有额外要求就使用完整默认格式。
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	// 用标签隔开待总结材料与执行指令；这只是文本约定，不是运行时权限隔离。
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	// 创建独立摘要请求的一条用户消息，不直接复用原会话作为当前对话。
	const summarizationMessages = [
		{
			// as const 保留字面量类型 "user"，避免数组推断把它放宽为任意 string。
			role: "user" as const,
			// 同样把内容块 type 固定为 text，正文就是上面组合的材料与摘要要求。
			content: [{ type: "text" as const, text: promptText }],
			// 为这条新请求消息记录毫秒时间戳，区别于磁盘条目的 ISO 时间字符串。
			timestamp: Date.now(),
		},
	];

	// Call LLM for summarization. Prefer the session stream function so SDK
	// request behavior (timeouts, retries, attribution headers) stays consistent
	// without running through agent state/events. Retried via completeSummarization
	// so transient stream drops reuse the configured retry policy.
	// normalizeContext 将系统指令与用户消息整理成摘要模型请求上下文。
	const context = normalizeContext({ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages });
	// 构造请求选项并向下传递凭据、头、环境和取消信号；同名字段使用属性简写。
	const requestOptions: SimpleStreamOptions = { apiKey, headers, env, signal };
	// 只有模型声明支持推理且调用者开启时，才传 reasoning 选项。
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		// 设置本次摘要请求的推理级别，不修改主 Agent 的长期设置。
		requestOptions.reasoning = thinkingLevel;
	}
	// 这里真正等待模型总结；公共入口会选择注入的 streamFn 或兼容 API，并应用瞬时失败重试。
	const response = await completeSummarization(model, context, requestOptions, streamFn, retry, callbacks);

	// Check if aborted or errored
	// 模型响应明确报告取消时，不使用可能只有一半的文字。
	if (response.stopReason === "aborted") {
		// 把取消状态交给 AgentSession，使它停止导航摘要保存。
		return { aborted: true };
	}
	// 检查服务端 error 和输出长度上限截断；后一种不能作为完整检查点保存。
	const failure = getSummarizationFailure(response, "Branch summarization");
	// 只要公共校验给出失败说明，就走错误返回。
	if (failure) {
		// 返回可展示的原因，此时没有成功摘要。
		return { error: failure };
	}
	// 摘要请求只需要文字，若模型试图调用工具就拒绝；此处不会执行该工具。
	if (response.content.some((block) => block.type === "toolCall")) {
		// 把意外工具调用当作摘要失败交给上层。
		return { error: "Branch summarization attempted to call a tool" };
	}

	// 只提取模型对外文字，不将 thinking 等内容写进摘要。
	let summary = contentText(response.content);

	// Prepend preamble to provide context about the branch summary
	// 加前言，提醒后续对话这是另一条探索分支的信息。
	summary = BRANCH_SUMMARY_PREAMBLE + summary;

	// Compute file lists and append to summary
	// 把累计 Set 整理成排序数组，供正文追加和元数据保存共同使用。
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	// 正文末尾附上文件清单；没有文件时追加空字符串。
	summary += formatFileOperations(readFiles, modifiedFiles);

	return {
		// 返回最终文字，假值时提供兜底；由于已加前言，通常即使模型正文空也不会触发此兜底。
		summary: summary || "No summary generated",
		// 将这次模型请求用量原样交给调用方记账。
		usage: response.usage,
		// 返回只读路径数组，供持久化 details。
		readFiles,
		// 返回修改路径数组，不在这里写回文件内容。
		modifiedFiles,
	};
}
