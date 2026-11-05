// 所属：packages/durable/src/harness，Durable Harness 的系统提示词与工具清单准备模块。
// 解决的问题：一次请求要把扩展提供的提示词段按顺序渲染出来，并让工具清单与目标完全一致；
// 为避免每个请求都重写整份上下文，模块把“当前已展示的段/工具”与“目标值”的差异规划成少量 pi.system 条目。
// 职责边界：只计算文本与写入计划，不提交事务、不调用模型、不持久化；调用方负责把 SystemDraft 追加为条目。
// 上游：generation.ts 的请求准备阶段读取当前 ContextView，调用 renderSections/planSystemEntries。
// 下游：pi-ai 的 Message/SystemMessage/Tool 类型与 transcript 工具函数、SystemEntry 条目定义、ContextView。
// 结果与错误：renderSections 返回目标段 Map，单个段抛错会被报告并保留旧文本（取消后除外）；
// planSystemEntries 同步返回要追加的草稿数组，空数组表示无需写入。
// 能力清单：
// - replaySections：按顺序重放 system 消息里的 sections，set 覆盖、null 删除、重新加入追加到末尾。
// - renderSections：按顺序渲染段，处理 undefined 省略、tag 包装、异常报告与取消传播。
// - planSystemEntries：比较重放结果、工具清单和目标值，规划最少（或必要的整序重写）pi.system 条目。
// 组合与顺序：先 renderSections 得到目标 Map → planSystemEntries(view, desired, tools, timestamp) 读当前视图 →
// 返回若干 SystemDraft → 调用方在事务中追加；工具变化会附在最后一个段补丁条目上，或单独成条目。
// 示例：const desired = await renderSections(agent.sections, input, replaySections(view.messages), report, ctx);
//   const drafts = planSystemEntries(view, desired, agent.tools, now);
//   // drafts 为空表示无需新条目；否则逐条 tx.appendEntry(SystemEntry, conversationId, draft)
// 建议阅读顺序：先看 replaySections 理解“当前已展示”的状态，再看 renderSections 的目标状态，
// 然后看 planSystemEntries 的基线/顺序重写/最小补丁三种分支，最后看 planTools、planSections、systemEntry 三个助手。
// 测试：test/harness-prompt.test.ts 覆盖渲染顺序、tag/wrapper、异常、取消、重放、最小补丁、顺序重写与 head 基线。
// Context 是渲染上下文的类型；这里不直接调用它的方法，只透传给 section.render。
import type { Context } from "@earendil-works/chord/context";
// Message 是 transcript 消息联合；SystemMessage 是其中带 sections/tools 字段的系统消息；
// Tool 是提供给模型的工具声明；ToolReference 是移除工具时只带 name 的引用。
import type { Message, SystemMessage, Tool, ToolReference } from "@earendil-works/pi-ai";
// declarationsEqual 比较两份工具声明的顺序/内容，getCurrentTools 从消息历史还原当前工具清单，
// toToolDeclaration 把运行期 Tool 转成可写入系统消息的声明。
import { declarationsEqual, getCurrentTools, toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
// SystemEntry 是 pi.system 条目定义，TypedEntryDraft 是追加条目时使用的类型化草稿。
import { SystemEntry } from "../entries.ts";
// ContextEdit/TypedEntryDraft 是条目编辑计划与草稿的公共类型。
import type { ContextEdit, TypedEntryDraft } from "../types.ts";
// ContextView/PromptInput/PromptSection/ToolRegistration 是本模块的输入输出与扩展段接口。
import type { ContextView, PromptInput, PromptSection, ToolRegistration } from "./types.ts";

/** Sections in effect after replaying system messages in order: set in place, `null` deletes, re-adding appends. */
// 输入模型消息数组，输出 key -> 当前文本的 Map；不改消息、不渲染段，只重放已提交的 sections 变更。
// 例如先 {a:"1",b:"2"} 再 {a:null} 再 {a:"3"}，结果是 b:"2"、a:"3"（a 因删除后重加而排到末尾）。
// 只有 role 为 system 且带 sections 的消息参与；其他消息（user/assistant/toolResult）直接跳过。
export function replaySections(messages: readonly Message[]): Map<string, string> {
	// Map 保留插入顺序；这正是“重新添加排到末尾”的顺序语义来源。
	const shown = new Map<string, string>();
	for (const message of messages) {
		// 联合类型收窄：先排除非 system 角色，再排除没有 sections 字段的系统消息。
		if (message.role !== "system" || message.sections === undefined) continue;
		// Object.entries 只遍历自有可枚举字符串键；值为 string 表示设置，null 表示删除。
		for (const [key, value] of Object.entries(message.sections)) {
			if (value === null) shown.delete(key);
			else shown.set(key, value);
		}
	}
	return shown;
}

/**
 * Render the agent's sections in order. `undefined` omits a section; tagged text is wrapped as `<key>\n...\n</key>`. A
 * section that throws keeps its shown text, if any, and is reported; errors after `context` is aborted propagate.
 */
// 输入：按顺序排列的段、渲染输入、当前已展示文本、错误报告回调、取消上下文；输出：本次目标段 Map。
// 副作用：逐个 await section.render，并调用 report(error, section) 报告单个段失败；不写存储、不提交事务。
// 错误：context 已取消时错误直接向上抛；未取消时该段被报告，并保留 shown 里的旧文本（若有），继续后面的段。
// 流程：render → 成功则 undefined 省略、否则按 tag 包装 → 失败则判断取消、报告并回退旧值。
// 例：section.render 返回 "You are helpful." 且 tag 未设为 false 时，目标是 "<preamble>\nYou are helpful.\n</preamble>"。
export async function renderSections<Tool extends ToolRegistration>(
	sections: readonly PromptSection<Tool>[],
	input: PromptInput<Tool>,
	shown: ReadonlyMap<string, string>,
	report: (error: unknown, section: PromptSection<Tool>) => void,
	context: Context,
): Promise<Map<string, string>> {
	// 目标 Map 保持段顺序；planSections 会用它和目标顺序比较。
	const desired = new Map<string, string>();
	for (const section of sections) {
		// 先声明为 string | undefined：render 的返回类型允许同步或异步返回 undefined。
		let text: string | undefined;
		try {
			// await 同时兼容同步返回值和 Promise；context 让渲染方可以感知取消。
			text = await section.render(input, context);
		} catch (error) {
			// 取消后的错误不是段自身的问题，必须让调用链感知，而不是被当作可报告失败吞掉。
			if (context.abortSignal?.aborted) throw error;
			report(error, section);
			// 失败段保留上一版文本，避免一次临时渲染错误把已有提示词段从上下文中删除。
			const kept = shown.get(section.key);
			if (kept !== undefined) desired.set(section.key, kept);
			continue;
		}
		// undefined 表示本段本次不出现；注意这与“渲染为空字符串”不同。
		if (text === undefined) continue;
		// tag === false 时原样写入；其余情况包一层 <key>...</key>，key 已由注册表校验。
		desired.set(section.key, section.tag === false ? text : `<${section.key}>\n${text}\n</${section.key}>`);
	}
	return desired;
}

// SystemDraft 把条目模型消息固定为 SystemMessage；never 表示这类草稿不携带自定义数据。
type SystemDraft = TypedEntryDraft<never>;

// 工具变化：被移除的只记录 name（ToolReference），新增的记录完整声明（Tool）。
type ToolChanges = { readonly toolsRemoved: ToolReference[]; readonly toolsAdded: Tool[] };

/**
 * Plan the `pi.system` entries that make the replayed sections and tools of `view` equal `desired` and `tools` in values
 * and order.
 *
 * - A head marker with no later `pi.system` entry in context: one complete baseline that omits every retained earlier
 *   `pi.system` entry, written even when it restates the replayed values.
 * - Otherwise, when a minimal section patch would leave a different order: remove every shown section, then re-add
 *   every desired section in order.
 * - Otherwise the minimal patch of changed values and `null` removals, or nothing.
 *
 * Tool changes ride on the last planned entry, or on one entry of their own.
 */
// 输入：当前上下文视图、目标段 Map、目标工具声明、时间戳；输出：按顺序追加的 pi.system 草稿数组。
// 副作用：无（纯规划）；不读存储、不调用 render，只读 view 里的已提交消息。
// 错误：依赖的 helper 不抛业务错误；返回空数组表示当前上下文已经满足目标。
// 流程：
// 1. 若有 head 标记且其后没有任何 pi.system 条目，写一条完整基线：对 view.entries（标记及其后的活动条目）
//    中的每个 pi.system 条目生成 omit，再完整给出 sections 与全部工具；即使重放值已经等于目标也写，
//    保证被标记切掉的旧增量不会让重放结果缺段。
// 2. 否则计算最小段补丁；若补丁会改变顺序，则先删除全部旧段再按目标顺序重新添加。
// 3. 工具变化：没有变化时每个段补丁单独成条目；有变化时附在最后一个段补丁上，或没有段补丁时单独成条目。
// 例：目标段没变但新增工具 c 时，返回一个只含 toolsAdded:[c] 的条目。
export function planSystemEntries(
	view: ContextView,
	desired: ReadonlyMap<string, string>,
	tools: readonly Tool[],
	timestamp: number,
): SystemDraft[] {
	const head = view.head;
	// 基线条件：存在 head 标记，且标记之后没有更新的 pi.system 条目。
	// 没有 head 时的重放从上下文起点开始，所以普通补丁就足够；有 head 时标记前的增量不再参与重放。
	if (head !== undefined && !view.entries.some((entry) => SystemEntry.is(entry) && entry.id > head.id)) {
		// 对所有现存 pi.system 条目生成 omit 编辑；基线会把它们的值重新写一遍。
		const edits: ContextEdit[] = view.entries
			.filter((entry) => SystemEntry.is(entry))
			.map((entry) => ({ target: entry.id, action: "omit" }));
		// Object.fromEntries(desired) 把 Map 转回与 SystemMessage.sections 兼容的普通对象。
		// 工具部分：不删除任何现有工具，全部目标工具作为新增声明写入；重放会把它们接在已有工具之后。
		const baseline = systemEntry(
			Object.fromEntries(desired),
			{ toolsRemoved: [], toolsAdded: tools.map(toToolDeclaration) },
			timestamp,
		);
		// 没有旧系统条目时不需要 edits 字段；有则把 omit 编辑与基线放在同一条草稿里。
		return [edits.length === 0 ? baseline : { ...baseline, edits }];
	}
	// 普通路径：从消息重放当前段，再算最小补丁；工具同理。
	const sections = planSections(replaySections(view.messages), desired);
	const changes = planTools(getCurrentTools(view.messages), tools);
	// 工具没有变化：每个段补丁各成一条，全部不需要时返回 []。
	if (changes.toolsRemoved.length === 0 && changes.toolsAdded.length === 0) {
		return sections.map((patch) => systemEntry(patch, undefined, timestamp));
	}
	// 只有工具变化：单独一条条目，sections 字段省略。
	if (sections.length === 0) return [systemEntry(undefined, changes, timestamp)];
	// 两者都有：工具变化附在最后一条段补丁上，避免多写一条条目。
	return sections.map((patch, index) =>
		systemEntry(patch, index === sections.length - 1 ? changes : undefined, timestamp),
	);
}

/**
 * Tool changes from `offered` to `desired`. A changed declaration is removed and re-added. Replay keeps retained tools
 * in place and appends additions; when that would not yield the desired order, every offered tool is removed and
 * every desired tool re-added in order.
 */
// 输入当前提供的工具与目标工具声明；输出 { toolsRemoved, toolsAdded } 两组变化。
// 纯函数，无副作用；不抛业务错误。声明相同（declarationsEqual）的工具才可保留，否则删掉再加。
// 关键：重放规则是“保留原位 + 新增追加”，所以若追加后的顺序与目标不同，只能整体删除再整体添加。
// 例：当前 [a,b]，目标 [b,a] 时返回移除 a、b，再按 b、a 添加。
function planTools(offered: readonly Tool[], desired: readonly Tool[]): ToolChanges {
	// 目标名称索引；同名工具以目标为准，声明是否变化由 declarationsEqual 判断。
	const wanted = new Map(desired.map((tool) => [tool.name, tool]));
	// 只有“存在且声明相等”的工具可以留在原位；声明变化等价于删除旧声明再新增。
	const kept = offered.filter((tool) => {
		const next = wanted.get(tool.name);
		return next !== undefined && declarationsEqual(tool, next);
	});
	// 保留工具的名称集合，用于计算真正的新增项。
	const keptNames = new Set(kept.map((tool) => tool.name));
	// 目标里不在保留集合中的都是新增（包括声明变化的同名工具）。
	const added = desired.filter((tool) => !keptNames.has(tool.name));
	// 这是重放后的顺序：保留项保持当前相对顺序，新增项统一追加。
	const replayed = [...kept, ...added];
	// 逐一比较名称即可；长度不同或某个位置的名字不同都说明顺序无法靠追加修正。
	if (replayed.some((tool, index) => tool.name !== desired[index]!.name)) {
		// 整体重写：移除当前全部工具，再按目标顺序添加全部声明。
		return {
			toolsRemoved: offered.map((tool) => ({ name: tool.name })),
			toolsAdded: desired.map(toToolDeclaration),
		};
	}
	// 顺序无需重写：只移除未保留项，只新增真正的新目标项。
	return {
		toolsRemoved: offered.filter((tool) => !keptNames.has(tool.name)).map((tool) => ({ name: tool.name })),
		toolsAdded: added.map(toToolDeclaration),
	};
}

/** Section patches: none, the minimal patch, or a remove-all/re-add-all pair when the order would differ. */
// 输入当前已展示段与目标段，输出补丁对象数组（每个对象是 key -> string | null）。
// 无副作用；null 表示删除。顺序检查与 planTools 相同：重放会保留旧位置并追加新 key。
// 例：shown {a,b}、desired {b,c} 时补丁为 {a:null, c:...}；仅值变化时为 {b:新值}。
function planSections(
	shown: ReadonlyMap<string, string>,
	desired: ReadonlyMap<string, string>,
): Record<string, string | null>[] {
	// 最小补丁后的重放顺序：保留仍存在的旧 key（原顺序），再接上目标里的新 key（目标顺序）。
	const patchedOrder = [
		...[...shown.keys()].filter((key) => desired.has(key)),
		...[...desired.keys()].filter((key) => !shown.has(key)),
	];
	// 目标顺序用于逐位比较。
	const desiredOrder = [...desired.keys()];
	// 任一位置不同都说明只改值不够，需要先清空再按目标顺序重加。
	if (patchedOrder.some((key, index) => key !== desiredOrder[index])) {
		// 第一项删除所有当前段，第二项按目标顺序完整设置。
		return [Object.fromEntries([...shown.keys()].map((key) => [key, null])), Object.fromEntries(desired)];
	}

	// 顺序一致：收集值变化、删除和新增。
	const patch: Record<string, string | null> = {};
	for (const [key, value] of shown) {
		// 目标没有该 key（next 为 undefined）或值不同时写入补丁；next ?? null 把缺失变成删除。
		const next = desired.get(key);
		if (next !== value) patch[key] = next ?? null;
	}
	// 目标中新增的 key 直接设置；顺序此时已经验证与目标一致。
	for (const [key, value] of desired) if (!shown.has(key)) patch[key] = value;
	// 空补丁不产生条目；否则只产生一条补丁。
	return Object.keys(patch).length === 0 ? [] : [patch];
}

// 构造一条 pi.system 草稿：SystemMessage 的 content 固定为空串，真正内容在 sections/tools 字段里。
// 输入可选的段补丁、工具变化与时间戳；返回 { model: [message] } 形式的条目草稿。
// 无可选字段时用条件展开省略键，而不是写 undefined，保持消息 JSON 形状干净。
function systemEntry(
	sections: Record<string, string | null> | undefined,
	tools: ToolChanges | undefined,
	timestamp: number,
): SystemDraft {
	// 显式标注 SystemMessage，让 role/content 等必填字段在编译期得到检查。
	const message: SystemMessage = {
		role: "system",
		content: "",
		// 三个条件展开：只有存在内容时才加入对应字段；空工具变化不写空数组。
		...(sections === undefined ? {} : { sections }),
		...(tools === undefined || tools.toolsRemoved.length === 0 ? {} : { toolsRemoved: tools.toolsRemoved }),
		...(tools === undefined || tools.toolsAdded.length === 0 ? {} : { toolsAdded: tools.toolsAdded }),
		timestamp,
	};
	// 条目草稿的 model 是消息数组；这里永远只有一条系统消息。
	return { model: [message] };
}
