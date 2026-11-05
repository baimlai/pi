// 所属：packages/durable/src/harness，Durable harness 的 agent 状态与解析层。
// 解决的问题：把“会话存储的选择（模型/思考级别/工具/扩展/指令）”“注册表里的扩展对象”“宿主设置”合成为一次请求
// 可用的 Agent，并保证默认策略、包装顺序和包装失败隔离在各个会话间一致。
// 职责边界：只解析与组装，不发请求、不执行工具、不运行钩子；文档变化必须由调用方在事务里提交。
// AgentState 只保存名称和选择，不保存扩展/工具对象本身；真正的对象由注册表快照和设置解析得到。
// 上游：Conversation.configure/agent、createConversation、任务运行时的 runtime.agent()。下游：generation 用 Agent
// 决定模型、工具、提示词段和钩子，pi.usage 记录模型花费，注册表提供扩展对象。
// 能力清单：
// - DEFAULT_RETRY_POLICY/DEFAULT_COMPACTION_POLICY/DEFAULT_PROGRESS_POLICY：会话级策略缺省值；
// - INSTRUCTIONS_KEY：settings.instructions 渲染成的保留段 key；
// - AgentDoc：pi.agent 文档（rewindable 历史 + asOf 分叉）；
// - DEFAULT_RESTART_LIMIT：任务连续被切断的默认上限；
// - resolveSettings：把可选 HarnessSettings 展开成必填 Settings；
// - configure/addTools：在事务里应用一次 AgentChange、追加工具名到加载状态；
// - createAgent：会话创建钩子，复制拥有者 agent 或从空状态开始；
// - agentHooks/sectionExtension/toolExtension：按任务名/段 key/工具名定位扩展，用于执行与错误归因；
// - resolveAgent：合成工具、段、钩子、扩展并应用包装，包装失败按扩展报告并丢弃目标。
// 典型顺序：createAgent（创建会话时）→ configure/addTools（运行前修改）→ resolveAgent(state, snapshot, settings, report)
//   → agentHooks 或 Agent 字段供 generation 使用。
// 示例：const settings = resolveSettings(options.settings);
//   const agent = resolveAgent(state, registry.snapshot(), settings, (error, extension) => report(error, extension));
//   示例展示解析调用形状；configure/createAgent 等异步函数必须在事务里 await。
// 建议阅读顺序：先读默认常量与 AgentDoc，再读 resolveSettings/configure/addTools，随后 resolveAgent，最后
//   agentHooks/sectionExtension/toolExtension 三个定位函数。
import type { Draft } from "@earendil-works/chord/delta";
import { copyJson } from "@earendil-works/chord/json";
import { defineDoc } from "../documents.ts";
import { documentRetention, persistWithin } from "../session/session.ts";
import type { ConversationId, ConversationRecord, Tx } from "../types.ts";
import type {
	Agent,
	AgentChange,
	AgentState,
	CompactionPolicy,
	ConversationRetryPolicy,
	Extension,
	HarnessSettings,
	ProgressPolicy,
	PromptSection,
	RegistrySnapshot,
	Settings,
	ToolRegistration,
} from "./types.ts";

// 会话级重试策略默认值；ConversationRetryPolicy 的字段在编译期约束，Settings 合并时数字不做运行时范围校验。
// 例：settings.retry = { maxRetries: 5 } 只覆盖 maxRetries，其余字段沿用这里的默认值。
export const DEFAULT_RETRY_POLICY: ConversationRetryPolicy = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
	maxAgentDelayMs: 60000,
};

// 自动压缩默认值：reserveTokens 是给回答预留的空间，keepRecentTokens 是摘要后原样保留的近期上下文，
// backgroundTokens 是后台压缩触发线相对阻塞线的间距（0 关闭后台压缩）。
export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	backgroundTokens: 32768,
};

// 进度提交的三个默认节流值：助手消息和工具输出各 100ms，延迟持久化最多 1s。
export const DEFAULT_PROGRESS_POLICY: ProgressPolicy = {
	partialIntervalMs: 100,
	outputIntervalMs: 100,
	persistWithinMs: 1_000,
};

// 保留的提示词段键；settings.instructions 会被渲染成这个 key 的段，排在扩展段之后。
/** The reserved section key of the agent's `instructions`. */
export const INSTRUCTIONS_KEY = "instructions";

// AgentDoc 是内置的 pi.agent 文档：history: "rewindable" 保留可回溯历史，fork: "asOf" 让分叉复制分叉点处的值。
// initial 返回空对象，表示所有字段未设置；checkpointWhen 恒为 true，每次变更都可成为完整检查点。
// defineDoc 只创建带类型的令牌；运行时会核对文档的 scope/history/fork 与定义一致。
/** Built-in agent document; rewindable so forks start from the agent at their fork entry. */
export const AgentDoc = defineDoc<AgentState>({
	kind: "pi.agent",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({}),
	checkpointWhen: () => true,
});

// 十分钟：空闲会话记住上次上下文读取的默认时长。
/** Default `settings.contextRetentionMs`: ten minutes. */
const DEFAULT_CONTEXT_RETENTION_MS = 600_000;

// 重启上限默认 5 次；Infinity 表示不因重启结束任务。
/** Default `settings.restartLimit`. */
export const DEFAULT_RESTART_LIMIT = 5;

// restartLimit 只接受“数字且 >= 1”的输入并向下取整；这是设置解析里的运行时校验，其他类型或负数回退到默认值。
// 例：5.9 得 5，0 得 5，Infinity 得 Infinity（不结束任务）。
/** A restart limit as given when it is a number of restarts, `1` or more, rounded down (`Infinity`: no task ends for restarts); else the default. */
function restartLimit(limit: number | undefined): number {
	return typeof limit === "number" && limit >= 1 ? Math.floor(limit) : DEFAULT_RESTART_LIMIT;
}

// resolveSettings 把 HarnessSettings（全部可选）展开成 Settings（必填）；对象字段逐项合并，未给字段用内置默认值。
// 每个字段单独写而不是整体展开，是为了让“显式 undefined”和“缺省”都保持默认值（?? 只对 null/undefined 生效）。
// 例：resolveSettings(undefined) 返回全套默认值；extensions 在未提供时保持 absent，表示选择所有已安装扩展。
// 本函数不抛错；数值合法性由 documentRetention()、persistWithin()、restartLimit() 等辅助函数在运行时收敛。
/** Resolve the host settings: every field over its built-in default, object fields merged. */
// settings?.extensions 先做可选链；只有真正提供时才把 extensions 放进结果，保持“absent 表示全部”的语义。
export function resolveSettings(settings: HarnessSettings | undefined): Settings {
	const extensions = settings?.extensions;
	return {
		...(extensions === undefined ? {} : { extensions }),
		stream: { ...settings?.stream },
		retry: { ...DEFAULT_RETRY_POLICY, ...settings?.retry },
		compaction: { ...DEFAULT_COMPACTION_POLICY, ...settings?.compaction },
		// 这里刻意逐字段解析而不是 {...defaults, ...settings.progress}：对象展开会把显式 undefined 覆盖到默认值上。
		// Field by field, so an explicitly undefined interval keeps its default.
		progress: {
			partialIntervalMs: settings?.progress?.partialIntervalMs ?? DEFAULT_PROGRESS_POLICY.partialIntervalMs,
			outputIntervalMs: settings?.progress?.outputIntervalMs ?? DEFAULT_PROGRESS_POLICY.outputIntervalMs,
			// persistWithin() 把非法值回退为默认 1000ms，Infinity 表示只在下一次读写该文档或关闭时持久化。
			persistWithinMs: persistWithin(settings?.progress?.persistWithinMs),
		},
		// ?? 只替换 null/undefined；空字符串等非法值会原样保留，因为这里没有运行时枚举校验。
		toolExecution: settings?.toolExecution ?? "parallel",
		steeringMode: settings?.steeringMode ?? "one-at-a-time",
		followUpMode: settings?.followUpMode ?? "one-at-a-time",
		contextRetentionMs: settings?.contextRetentionMs ?? DEFAULT_CONTEXT_RETENTION_MS,
		documentRetentionMs: documentRetention(settings?.documentRetentionMs),
		afterFailedRun: settings?.afterFailedRun ?? "keep",
		restartLimit: restartLimit(settings?.restartLimit),
	};
}

// configure 在事务里读取 pi.agent 草稿并应用一次变更；它不提交，调用方的 commitWith 决定事务边界。
// AgentChange 的字段语义：给定值替换、null 清除、undefined 不改（见 applyChange）。
// 例：configure(tx, id, { model: null }) 删除已存模型；configure(tx, id, {}) 什么也不改。
/** Apply one change to `pi.agent`: a given field replaces the stored one, `null` clears it, `undefined` changes nothing. */
export async function configure(tx: Tx, conversationId: ConversationId, change: AgentChange): Promise<void> {
	const state = await tx.doc(AgentDoc, conversationId);
	applyChange(state, change);
}

// addTools 把工具名加到工具的加载状态里，让下一次请求提供它们；它只处理名称，不检查注册表里是否存在该工具。
// 对 tools：数组表示“精确启用这些”，对象表示“从默认选择里移除”；未设置表示全部启用，无需追加。
// 对 modelTools：数组表示“精确提供这些”，对象表示“默认提供 + add 延迟工具 - remove”；未设置或对象都会追加到 add。
// 例：addTools(tx, id, ["search"]) 在 modelTools 为 { add: [] } 时得到 { add: ["search"] }；重复名称不会重复添加。
/**
 * `addTools` of a tool round, applied to `tools` and `modelTools`, so the next request offers the tools: an array gets
 * each name it lacks appended, and `{ remove }` loses the names. An unset `tools` already enables every tool, so nothing
 * is written for it. An unset or object `modelTools` also gets each name appended to its `add`, which loads deferred
 * tools and has no effect for others. By name, without the registry: a tool that is not registered now, such as one of
 * an MCP server that is reconnecting, is offered once it is again.
 */
export async function addTools(tx: Tx, conversationId: ConversationId, added: readonly string[]): Promise<void> {
	// 读取当前状态草稿；后续原地修改，不需要写回，Chord 会跟踪变更。
	const state = await tx.doc(AgentDoc, conversationId);
	// 数组分支：按名称追加缺失项；includes 是 O(n)，这里数量是工具名列表，不构成热路径问题。
	const tools = state.tools;
	if (Array.isArray(tools)) {
		for (const name of added) if (!tools.includes(name)) tools.push(name);
		// 对象分支只在 remove 里确实包含新增名称时才重写，避免无意义的文档变更。
	} else if (tools?.remove.some((name) => added.includes(name))) {
		// 过滤掉新增名称后重新构造 { remove }；若结果为空数组，仍保留 remove: []（与 stored 形状一致）。
		state.tools = { remove: tools.remove.filter((name) => !added.includes(name)) };
	}
	// modelTools 的处理与 tools 不同：它还有一个 add 列表，用于延迟工具。
	const modelTools = state.modelTools;
	// 数组表示精确提供，直接追加缺失名称后提前返回，不再构造对象。
	if (Array.isArray(modelTools)) {
		for (const name of added) if (!modelTools.includes(name)) modelTools.push(name);
		return;
	}
	// Assigned whole; a document write of an equal value records no change.
	// 从 remove 中剔除新增名称，再复制 add；?? [] 处理字段缺省。
	const remove = (modelTools?.remove ?? []).filter((name) => !added.includes(name));
	// 展开复制，避免直接修改 settings 或调用方传入的数组引用。
	const add = [...(modelTools?.add ?? [])];
	// 逐个加入 add，重复名称跳过。
	for (const name of added) if (!add.includes(name)) add.push(name);
	// remove 为空时省略该字段；add 总是写出，即使为空数组。
	// 整体赋值；写入相等值不会产生变更（Chord 的比较语义）。
	state.modelTools = { ...(remove.length === 0 ? {} : { remove }), add };
}

// applyChange 把公开的 AgentChange（只含名称/值）转成存储的 AgentState；它负责 null 清除、undefined 不变。
function applyChange(state: Draft<AgentState>, change: AgentChange): void {
	// 泛型 K extends keyof AgentState 让 key 与 value 类型关联；内层箭头函数让每个字段复用同一套 null/undefined 语义。
	const set = <K extends keyof AgentState>(key: K, value: AgentState[K] | null | undefined) => {
		// undefined：调用者没有提到这个字段，保持原值。
		if (value === undefined) return;
		// null：调用者要清除字段，delete 让 JSON 文档里不再有该键。
		if (value === null) delete state[key];
		// 其他值：写入草稿；as 是编译期断言，因为 set 的 value 已按 AgentState[K] 关联。
		else state[key] = value as Draft<AgentState>[K];
	};
	// model 对象要浅复制，避免把调用方对象引用直接存进文档；null/undefined 原样交给 set 处理。
	set("model", change.model === undefined || change.model === null ? change.model : { ...change.model });
	set("thinkingLevel", change.thinkingLevel);
	// 扩展变更的三种输入：数组（精确选择）、对象（在默认选择上增删）、null（清除）；这里构造存储用的名称数组。
	const extensions = change.extensions;
	set(
		"extensions",
		extensions === undefined || extensions === null
			? extensions
			: // isList 是类型谓词；对象分支再用 names() 提取 name 字段。三元表达式在运行时按数组/对象判别。
				isList(extensions)
				? names(extensions)
				: {
						...(extensions.add === undefined ? {} : { add: names(extensions.add) }),
						...(extensions.remove === undefined ? {} : { remove: names(extensions.remove) }),
					},
	);
	// tools 只有数组或 { remove } 两种形状，没有 add；对象分支只保留 remove 名称。
	const tools = change.tools;
	set(
		"tools",
		tools === undefined || tools === null ? tools : isList(tools) ? names(tools) : { remove: names(tools.remove) },
	);
	// modelTools 同时支持 remove 和 add；对象字段缺省时省略，避免存入无意义空数组。
	const modelTools = change.modelTools;
	set(
		"modelTools",
		modelTools === undefined || modelTools === null
			? modelTools
			: isList(modelTools)
				? names(modelTools)
				: {
						...(modelTools.remove === undefined ? {} : { remove: names(modelTools.remove) }),
						...(modelTools.add === undefined ? {} : { add: names(modelTools.add) }),
					},
	);
	// instructions 和 cwd 是普通字符串；null 清除，undefined 不变。
	set("instructions", change.instructions);
	set("cwd", change.cwd);
	// maxTurns 是唯一带运行时校验的字段：必须是安全整数且 >= 1，否则抛 RangeError；null/undefined 放行给 set。
	const maxTurns = change.maxTurns;
	// Number.isSafeInteger 同时排除 NaN、小数和超出安全整数范围的值；String(maxTurns) 只用于错误消息。
	if (maxTurns !== undefined && maxTurns !== null && !(Number.isSafeInteger(maxTurns) && maxTurns >= 1)) {
		throw new RangeError(`maxTurns must be an integer 1 or more, got ${String(maxTurns)}`);
	}
	set("maxTurns", maxTurns);
}

// isList 的谓词签名让调用分支把 readonly T[] | object 收窄为 readonly T[]。
function isList<T>(value: readonly T[] | object): value is readonly T[] {
	return Array.isArray(value);
}

// names 把带 name 字段的对象数组投影为字符串数组；map 保持顺序，不查重。
function names(items: readonly { readonly name: string }[]): string[] {
	return items.map((item) => item.name);
}

// createAgent 是“创建或分叉会话”提交里的内置钩子：分叉保留 asOf 复制值，新任务会话复制拥有者会话的 agent，无主会话从空开始。
// 参数 conversation 是新会话记录；函数直接修改该会话的 pi.agent 文档草稿，不返回 Agent 对象。
// 例：从父会话分叉时 parent !== undefined，函数立即返回，分叉逻辑已复制 asOf 状态。
/**
 * Built-in part of every Harness commit that creates or forks a conversation, for `pi.agent`: a fork keeps its `asOf`
 * copy; a new task-owned conversation copies the stored agent of its owner task's conversation; a new ownerless one
 * starts empty.
 */
export async function createAgent(tx: Tx, conversation: ConversationRecord): Promise<void> {
	// 分叉会话的 agent 已在 forkConversation 中按 asOf 复制；这里不再覆盖。
	if (conversation.parent !== undefined) return;
	// 读取新会话的文档；它可能已有内容（例如分叉复制），后续只在有 owner 时覆盖。
	const agent = await tx.doc(AgentDoc, conversation.id);
	// 无主会话（应用创建的独立会话）从空状态开始；这也是 initial() 的结果，无需复制。
	if (conversation.owner === undefined) return;
	// 任务拥有的会话复制拥有者任务所在会话的 agent 状态，使子代理继承模型、工具与指令。
	const owner = await tx.doc(AgentDoc, conversation.owner.conversationId);
	// copyJson 深复制 owner 的 JSON 值，再整体赋给新文档；as AgentState 是编译期断言。
	Object.assign(agent, copyJson(owner) as AgentState);
}

// agentHooks 按任务名收集所选扩展的钩子，保持扩展声明顺序；返回扩展名用于错误报告定位。
// 只匹配 hook.task 字符串，不执行钩子，也不验证 handlers 的函数形状。
/** Handlers of the selected extensions' hooks for a task name, in extension order. */
export function agentHooks(
	agent: Agent,
	taskName: string,
): { readonly extension: string; readonly handlers: object }[] {
	const handlers: { readonly extension: string; readonly handlers: object }[] = [];
	// extensions 是 resolveAgent() 已选好的扩展数组；hooks 缺省视为没有钩子。
	for (const extension of agent.extensions) {
		for (const hook of extension.hooks ?? []) {
			// 每个匹配项带扩展名；同一扩展内多个 handler 按数组顺序返回。
			if (hook.task === taskName) handlers.push({ extension: extension.name, handlers: hook.handlers });
		}
	}
	return handlers;
}

// sectionExtension 找出负责某提示词段的最后一个扩展：它提供该段或包装该段。用于把渲染错误归因到扩展。
// 选择“最后一个”与 resolveAgent() 的覆盖顺序一致：后选的扩展覆盖前面的同名段。
/** The extension whose code a section of `agent` runs: the last selected one that provides or wraps it. */
// found 在循环中不断被覆盖，最终保留最后一个匹配项；没有匹配则返回 undefined。
export function sectionExtension(agent: Agent, key: string): string | undefined {
	let found: string | undefined;
	for (const extension of agent.extensions) {
		// provides/wraps 都显式比较 === true，避免 some 返回 undefined 时进入条件。
		const provides = extension.sections?.some((section) => section.key === key) === true;
		// "section" in wrap 是判别联合收窄：只有段包装分支才有 section 字段。
		const wraps = extension.wraps?.some((wrap) => "section" in wrap && wrap.section === key) === true;
		if (provides || wraps) found = extension.name;
	}
	return found;
}

// toolExtension 与 sectionExtension 对称，按工具名找提供或包装它的最后一个扩展。
/** The extension whose code a tool of `agent` runs: the last selected one that provides or wraps it. */
export function toolExtension(agent: Agent, name: string): string | undefined {
	let found: string | undefined;
	for (const extension of agent.extensions) {
		const provides = extension.tools?.some((tool) => tool.name === name) === true;
		const wraps = extension.wraps?.some((wrap) => "tool" in wrap && wrap.tool === name) === true;
		if (provides || wraps) found = extension.name;
	}
	return found;
}

// resolveAgent 把存储状态、注册表快照和设置合成为一个可用的 Agent；包装器在合成后按顺序应用。
// state 缺省表示所有字段未设置；snapshot 提供扩展对象；settings 决定默认扩展选择。
// report 接收包装器抛错或重命名错误，带上包装扩展的名字；包装失败的项会被丢弃而不是让整个解析失败。
// 例：扩展 A 提供 read 工具，扩展 B 包装 read；结果里的 read 是 B 的包装版本，sectionExtension/toolExtension 指向 B。
/**
 * Resolve an agent from its stored state (absent: every field unset), a registry snapshot, and resolved settings. A
 * wrapper that throws or renames drops its target and is reported; a wrapper without a target does nothing.
 */
export function resolveAgent<Tool extends ToolRegistration>(
	state: Readonly<AgentState> | undefined,
	snapshot: RegistrySnapshot<Tool>,
	settings: Settings,
	/** Gets a wrapper's failure with the name of the wrapper's extension. */
	report: (error: unknown, extension: string) => void,
): Agent<Tool> {
	// 先确定选中的扩展数组；state.extensions 是名称选择，snapshot/settings 提供实际对象。
	const extensions = selectExtensions(state?.extensions, snapshot, settings);

	// composed 保存“工具名 -> 工具对象”；后提供的同名工具覆盖前面的。
	const composed = new Map<string, Tool>();
	for (const extension of extensions) for (const tool of extension.tools ?? []) composed.set(tool.name, tool);
	// sections 保存“段 key -> 段对象”；同样后选覆盖先选。
	const sections = new Map<string, PromptSection<Tool>>();
	for (const extension of extensions) {
		for (const section of extension.sections ?? []) sections.set(section.key, section);
	}
	// 包装按扩展选择顺序应用；每个扩展可以同时包装工具和段。
	for (const extension of extensions) {
		for (const wrap of extension.wraps ?? []) {
			// 闭包捕获当前扩展名，让 report 的第二个参数指向正确的扩展；每个包装回调用独立闭包。
			const wrapReport = (error: unknown) => report(error, extension.name);
			// "tool" in wrap 判别分支；applyWrap 的 nameOf 回调用于检查包装后是否改名。
			if ("tool" in wrap)
				applyWrap(
					composed,
					wrap.tool,
					(tool) => wrap.wrap(tool),
					(tool) => tool.name,
					wrapReport,
				);
			else
				applyWrap(
					sections,
					wrap.section,
					(section) => wrap.wrap(section),
					(section) => section.key,
					wrapReport,
				);
		}
	}

	// 先按 state.tools 过滤启用工具，再按 callers 区分模型可调用与工具可调用。
	const enabled = filterTools([...composed.values()], state?.tools);
	// callableBy 返回谓词；callers 缺省表示模型和工具都可以调用。
	const callableBy = (caller: "model" | "tools") => (tool: Tool) =>
		tool.callers === undefined || tool.callers.includes(caller);
	// modelCallable 是“启用且模型可调用”的工具，后续再按 modelTools 决定实际提供给模型的列表。
	const modelCallable = enabled.filter(callableBy("model"));
	// offeredTools 处理 modelTools 数组/对象/缺省三种情况，并加入已加载的延迟工具。
	const tools = offeredTools(modelCallable, state?.modelTools);
	const offered = new Set(tools);
	// deferred 是“模型可调用、已启用、但当前未提供”的延迟工具，供 tool_search 之类机制加载。
	const deferred = modelCallable.filter((tool) => tool.deferred === true && !offered.has(tool));
	// callable 是嵌套调用（executeTool）可解析的工具集合，不受 modelTools 影响。
	const callable = enabled.filter(callableBy("tools"));

	// instructions 是预留段文本；它排在所有扩展段之后。
	const instructions = state?.instructions;
	// 展平段 map 的值；顺序是第一次插入的顺序，后面的同名 set 不会改变位置。
	const agentSections = [...sections.values()];
	// 把 instructions 包装成 key 为 "instructions" 的段；render 是闭包，返回固定字符串。
	if (instructions !== undefined) agentSections.push({ key: INSTRUCTIONS_KEY, render: () => instructions });

	// 构造 Agent 对象；可用字段才写出，保持“optional 即未设置”的形状。
	const agent: Agent<Tool> = {
		// 条件展开避免把 model: undefined 存进结果；思考级别缺省为 "off"。
		...(state?.model === undefined ? {} : { model: state.model }),
		thinkingLevel: state?.thinkingLevel ?? "off",
		extensions,
		tools,
		callable,
		deferred,
		sections: agentSections,
		// instructions 同时保留在 Agent.instructions 字段和 sections 里，方便调用方直接读取。
		...(instructions === undefined ? {} : { instructions }),
		...(state?.cwd === undefined ? {} : { cwd: state.cwd }),
		...(state?.maxTurns === undefined ? {} : { maxTurns: state.maxTurns }),
	};
	return agent;
}

// offeredTools 生成实际提供给模型的列表：数组精确选择；对象表示默认非延迟工具 + add 中已加载的延迟工具。
// 输入 tools 是模型可调用的启用工具；filter 是存储的 modelTools。
// 例：filter 为 { add: ["search"] } 时，结果是非延迟工具加 search（若 search 是已注册的延迟工具）。
/** The tools offered to the model, as `AgentState.modelTools` describes. */
function offeredTools<Tool extends ToolRegistration>(tools: Tool[], filter: AgentState["modelTools"]): Tool[] {
	// 数组分支复用 filterTools：只保留指定名称，顺序按数组。
	if (Array.isArray(filter)) return filterTools(tools, filter);
	// 对象分支先处理 remove；Set 提供 O(1) 查找。
	const removed = new Set(filter?.remove ?? []);
	// 默认列表排除延迟工具和显式移除项；延迟工具必须通过 add 才会出现。
	const kept = tools.filter((tool) => tool.deferred !== true && !removed.has(tool.name));
	// Loaded deferred tools follow in load order, so loading one appends to the declared tools.
	// byName 让 add 中的名称能找回工具对象；Map 构建一次，后续查找 O(1)。
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	// new Set 去重 add 顺序，flatMap 把“找到的延迟工具”展开；未注册、非延迟或被 remove 的名称不产生项。
	const loaded = [...new Set(filter?.add ?? [])].flatMap((name) => {
		const tool = byName.get(name);
		return tool?.deferred === true && !removed.has(name) ? [tool] : [];
	});
	// 默认工具在前，加载的延迟工具按 add 顺序在后。
	return [...kept, ...loaded];
}

// filterTools 把存储的启用过滤器应用到工具列表：undefined 全启用；数组精确选择；对象只移除。
/** `tools` through a stored filter: an array selects exactly its names, in its order; `{ remove }` drops names. */
// 参数 filter 来自 AgentState["tools"]，类型包含 undefined。
function filterTools<Tool extends ToolRegistration>(tools: Tool[], filter: AgentState["tools"]): Tool[] {
	if (filter === undefined) return tools;
	// 数组分支同样用 Map 恢复对象；new Set 去重并保持首次出现顺序。
	if (Array.isArray(filter)) {
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		return [...new Set(filter)].flatMap((name) => {
			const tool = byName.get(name);
			return tool === undefined ? [] : [tool];
		});
	}
	// 对象分支在存储形状里只有 remove；as 断言让编译器接受，运行时若缺 remove，new Set(undefined) 会抛 TypeError。
	const removed = new Set((filter as { remove: string[] }).remove);
	return tools.filter((tool) => !removed.has(tool.name));
}

// selectExtensions 把存储的扩展选择解析成扩展对象数组：数组表示精确名称列表，对象表示在默认选择上增删。
// settings.extensions 是宿主默认选择；没有则用快照里所有已安装扩展，保持安装顺序。
// 未安装的名称会被跳过，因此返回数组可能比选择列表短；重复名称用 Set 去重。
/** Selected installed extensions: the stored array, or the default selection edited by `{ add, remove }`. */
function selectExtensions<Tool extends ToolRegistration>(
	stored: AgentState["extensions"],
	snapshot: RegistrySnapshot<Tool>,
	settings: Settings,
): Extension<Tool>[] {
	// selected 先存名称；数组分支直接使用调用方提供的顺序。
	let selected: string[];
	if (Array.isArray(stored)) selected = stored;
	else {
		// 默认选择：设置里显式给出的扩展，否则注册表全部扩展；map 只取 name。
		const base = settings.extensions?.map((extension) => extension.name) ?? snapshot.installed().map((e) => e.name);
		// 对象分支按 { add?, remove? } 读取；as 只是把联合类型收窄到对象分支的编译期断言。
		const edit = stored as { add?: string[]; remove?: string[] } | undefined;
		const removed = new Set(edit?.remove ?? []);
		// 先拼接默认选择与 add，再用 remove 过滤；顺序保持默认在前、新增在后。
		selected = [...base, ...(edit?.add ?? [])].filter((name) => !removed.has(name));
	}
	// extensions 只收集 snapshot 里确实存在的对象；未安装名称被静默跳过。
	const extensions: Extension<Tool>[] = [];
	// new Set(selected) 去重且保持插入顺序；重复选择不会让扩展运行两次。
	for (const name of new Set(selected)) {
		const extension = snapshot.extension(name);
		if (extension !== undefined) extensions.push(extension);
	}
	return extensions;
}

// applyWrap 对 map 中的目标应用一个包装：目标不存在时什么也不做；包装抛错或改名时删除目标并报告。
// 删除而不是保留原对象，意味着包装失败会让该工具/段从结果中消失，这是“包装器负责该项”的语义。
function applyWrap<T>(
	items: Map<string, T>,
	target: string,
	wrap: (item: T) => T,
	nameOf: (item: T) => string,
	report: (error: unknown) => void,
): void {
	// items.get 返回 undefined 有两种可能：目标未提供，或前一个包装失败已删除；两者都直接返回。
	const item = items.get(target);
	if (item === undefined) return;
	// try 只包住包装调用和名称检查；report 在 catch 里调用，report 自身抛错会向外传播（调用方负责报告安全）。
	try {
		const wrapped = wrap(item);
		// 包装可以改变实现，但不允许改变名称/键，否则后续按名称的引用会失配；这里主动抛错。
		if (nameOf(wrapped) !== target) throw new Error(`Wrapper renamed ${target} to ${nameOf(wrapped)}`);
		items.set(target, wrapped);
		// 删除目标并报告错误；catch 同时捕获包装器抛出的任意值，不区分 Error 类型。
	} catch (error) {
		items.delete(target);
		report(error);
	}
}
