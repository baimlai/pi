// 所属：packages/durable/src/codemode，代码模式（codemode）面向模型的说明与工具目录渲染模块。
// 作用：生成两段纯文本：codemode 工具的固定 description（脚本运行环境与全局函数），以及系统提示词里的
// `codemode` 段（把脚本可调用的工具按命名空间列成 TypeScript 声明，并受 token 预算限制）。
// 职责边界：只渲染文本，不执行工具、不读写文件、不产生持久化状态。工具声明来自 ToolRegistration 的
// description/parameters/structuredOutputSchema；渲染失败会让异常原样向上传播，不在此吞掉。
// 上游：codemode.ts 的 createCodemodeTool 调用 codemodeDescription，createCodemodeExtension 的 section 调用
// codemodeSection；CodemodeCall.execute 用 sampleOf 生成脚本看到的工具描述，用 namespaceOf 给工具分组。
// 下游：@earendil-works/pi-codemode/declarations 的 renderToolSample/toCodemodeIdentifier，以及 pi-schema 类型。
// 能力清单（导出项）：
// - CodemodeNamespace：命名空间配置（name/description/instructions/prefix），prefix 决定工具归属。
// - DEFAULT_CODEMODE_INLINE_BUDGET：工具声明默认 token 预算 3000。
// - codemodeDescription(models)：工具固定说明；models=false 时省略 models.* 段。
// - declarationOf(tool)：把注册形状转成声明渲染器需要的形状；无输出 schema 时按 string 处理。
// - sampleOf(tool)：工具说明加 TypeScript 调用签名，供脚本目录与 DeclaredTool 使用。
// - namespaceOf(name, namespaces)：按最长前缀匹配命名空间，无匹配返回 undefined。
// - codemodeSection(tools, namespaces, budget)：生成系统提示词段；没有可调用工具时返回 undefined。
// 典型调用（与 codemode.ts 一致）：
//   const text = codemodeSection(
//     agent.callable.filter((tool) => !tool.name.startsWith("pi.codemode.") && tool.deferred !== true),
//     options.namespaces ?? [],
//     3000,
//   );
// 建议阅读顺序：先 CodemodeNamespace 与 codemodeDescription，再 declarationOf/sampleOf，然后 namespaceOf、
// renderToolSection 与 selectCatalog，最后读 codemodeSection 的组装流程。
/**
 * What the model reads about code mode, copied from the coding agent's code mode: the tool's fixed description (the
 * script environment and its globals), and the `codemode` prompt section, which lists the tools scripts can call as
 * TypeScript declarations, grouped by namespace and limited to a token budget. Tools that do not fit are found with
 * `searchTools()`. The section renders from the conversation's callable tools, so it changes with them; the tool's
 * description never does.
 */
import type { CodemodeJsonSchema } from "@earendil-works/pi-codemode";
import { renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import type { ToolRegistration } from "../harness/types.ts";
import { MODELS_DESCRIPTION } from "./models.ts";

// 这是给模型看的工具目录，不会执行工具。import type 在生成 JavaScript 时会被擦除。
// readonly 只限制通过此类型修改字段；? 表示字段可以缺省，prefix 用于判断工具属于哪个组。
/** A group of tools named by a common prefix, such as an MCP server's `mcp__github__`. */
export type CodemodeNamespace = {
	readonly name: string;
	readonly description?: string;
	readonly instructions?: string;
	/** Tool names starting with it belong to the namespace; the longest matching prefix wins. */
	readonly prefix: string;
};

/** Default token budget of the tool declarations in the `codemode` section, as in the coding agent. */
export const DEFAULT_CODEMODE_INLINE_BUDGET = 3000;
/** Characters per token when estimating the cost of a tool section. */
const CHARS_PER_TOKEN = 4;

const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };

const DESCRIPTION_INTRO = `Run JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level \`await\` and \`return\` work. No Node, file system, network, or timers.
- \`await tools.<name>({ ...args })\` resolves to a string, or an object if the tool's declaration says so, and rejects with an Error on failure. A tool whose declaration returns an object resolves on failure too when it returned that object; check its fields. Calls still running when the script ends are cancelled.
- The script survives a restart: it resumes where it was, without running finished calls again.
- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\``;

/** The code mode tool's description: the script environment and its globals, the same for every conversation. */
export function codemodeDescription(models: boolean): string {
	// 先准备固定的全局函数说明；这里只生成文字，不创建这些函数。
	const globals = [
		"Globals:",
		"- `text(value)`, `image(dataUrlOrImageBlock)`, `console.log(...)`, and top-level `return` add output; `exit()` ends the script. With several text items, each starts with a `==> text N/M <==` line, and `console` lines follow the other output in one `<console_output>` block. `image()` also saves the image to a temp file and the result names its path.",
		"- `store(key, value)` and `load(key)` keep JSON values across codemode calls.",
		"- `ALL_TOOLS`, `await searchTools(query, { limit?, namespace? })`, `await describeTool(name)`, `await describeNamespace(name)`: find tools the `codemode` section does not list.",
	];
	// models 为真才插入模型目录/付费能力说明；数组展开 ... 把可选段落接到同一层。
	// 例如传 false 时仍介绍 text/searchTools，但没有 models 段。无 I/O，拼接异常直接传播。
	return [
		DESCRIPTION_INTRO,
		globals.join("\n"),
		...(models ? [MODELS_DESCRIPTION] : []),
		"The `codemode` section of the system prompt lists the tools scripts can call, by namespace, as far as space allows.",
	].join("\n\n");
}

/** What a script sees of a tool: its declaration. Tools without an output schema resolve to their text output. */
export function declarationOf(tool: ToolRegistration): {
	name: string;
	description: string;
	inputSchema: CodemodeJsonSchema;
	outputSchema: CodemodeJsonSchema;
} {
	// 把 Durable 的注册形状转成声明渲染器的形状。as 仅说服 TS，不校验 JSON Schema。
	// 例没有 structuredOutputSchema 的 read，会被展示为返回 string；这里不会调用 read。
	return {
		// 保留原始工具名及说明，脚本标识符的转换交给渲染器。
		name: tool.name,
		description: tool.description,
		// 参数 schema 原样交给渲染器，它生成 TypeScript 文字而非运行时验证器。
		inputSchema: tool.parameters as CodemodeJsonSchema,
		// ?? 仅在 null/undefined 时取后面的字符串 schema。
		outputSchema: (tool.structuredOutputSchema as CodemodeJsonSchema | undefined) ?? TEXT_OUTPUT_SCHEMA,
	};
}

/** `toolSample` of a tool: its description and TypeScript declaration. */
export function sampleOf(tool: ToolRegistration): string {
	// 输入一份工具注册，返回说明和调用签名；例 read(args: ...): Promise<string>。
	// 不执行工具；声明渲染失败会直接抛给上层。
	return renderToolSample(declarationOf(tool));
}

/** The namespace of a tool: the one with the longest prefix its name starts with. */
export function namespaceOf(name: string, namespaces: readonly CodemodeNamespace[]): CodemodeNamespace | undefined {
	// 按名称前缀找最具体的命名空间，无匹配返回 undefined，无外部副作用。
	// 例 mcp__github__read 同时匹配 mcp__ 与 mcp__github__ 时选后者。
	let found: CodemodeNamespace | undefined;
	// 遍历只读数组；不排序或修改调用方的配置。
	for (const namespace of namespaces) {
		// 只替换为更长前缀，因此等长匹配保持先出现的配置。
		if (name.startsWith(namespace.prefix) && (found === undefined || namespace.prefix.length > found.prefix.length)) {
			// 保存的是同一个配置对象，并不复制。
			found = namespace;
		}
	}
	// 联合类型要求调用方处理未找到的情况。
	return found;
}

/** `### \`id\` (\`raw name\`)` followed by the tool's description and declaration. */
function renderToolSection(tool: ToolRegistration): string {
	// 生成一个工具的 Markdown 小节；例如 my-tool 的标题同时写 my_tool 和原名。
	// 返回文字，无工具调用或 I/O；渲染错误原样传播。
	const id = toCodemodeIdentifier(tool.name);
	// 名称发生映射时显示原名，便于模型把脚本拼写与注册名对应。
	const heading = id === tool.name ? `### \`${id}\`` : `### \`${id}\` (\`${tool.name}\`)`;
	// trim 只去掉样例的首尾空白，不修改工具注册。
	return `${heading}\n${sampleOf(tool).trim()}`;
}

// cost 是 section 的估算 token 数；这个类型只供编译期检查，不会自行算额度。
type CatalogEntry = { name: string; section: string; cost: number };
// namespace 为 undefined 表示不属于任何配置命名空间的工具组。
type CatalogGroup = { namespace: CodemodeNamespace | undefined; entries: CatalogEntry[] };

/**
 * Pick the tool sections that fit the budget: in each round every group (tools without a namespace first, then
 * namespaces by name) places its cheapest remaining tool; a group whose next tool does not fit drops out while the
 * others continue. Every namespace is represented before any namespace is complete.
 */
function selectCatalog(groups: readonly CatalogGroup[], budget: number): Set<string> {
	// 在总预算内轮流挑每组最便宜的小节，返回要展示的工具名集合；不改输入组。
	// 例两组各有工具且预算足够时先各选一个；预算耗尽不报错，只省略余下工具。
	const queues = groups.map((group) => [...group.entries].sort((a, b) => a.cost - b.cost));
	// 每组先复制再排序，因此 shift 只消耗本次选择用的队列。
	const shown = new Set<string>();
	// 剩余额度会随成功入选而递减。
	let remaining = budget;
	// 空组不参与轮流选择。
	let active = queues.filter((queue) => queue.length > 0);
	// 每轮每个活跃组最多选一个；没能放下最便宜项的组整组退出。
	while (active.length > 0) {
		active = active.filter((queue) => {
			// 活跃队列非空，! 是 TS 非空断言，不增加运行时判断。
			const next = queue[0]!;
			// 最便宜项都超预算，后续项也放不下。
			if (next.cost > remaining) return false;
			// 扣额度、记录名字、移除已经选中的第一项。
			remaining -= next.cost;
			shown.add(next.name);
			queue.shift();
			// 还有剩余项才参加下一轮。
			return queue.length > 0;
		});
	}
	// Set 支持后续按名称判断可见性；最终展示顺序仍由调用方决定。
	return shown;
}

/**
 * The `codemode` section: the tools scripts can call, grouped by namespace, with their declarations as far as the
 * budget allows. `undefined` without callable tools.
 */
export function codemodeSection(
	tools: readonly ToolRegistration[],
	namespaces: readonly CodemodeNamespace[],
	budget: number,
): string | undefined {
	// 以工具、命名空间和估算预算生成系统提示词段落；没有工具就不加段落。
	// 例如预算只够一个 GitHub 工具，会带 some tools not listed 提示；无 I/O。
	if (tools.length === 0) return undefined;
	// Map 先放一个未分组的组；空串键不会和带 ns: 前缀的键冲突。
	const groups = new Map<string, CatalogGroup>([["", { namespace: undefined, entries: [] }]]);
	for (const tool of tools) {
		// 按最长前缀把每个工具放进组中。
		const namespace = namespaceOf(tool.name, namespaces);
		const key = namespace ? `ns:${namespace.name}` : "";
		// 已有组复用数组，新组在此创建，再写回 Map。
		const group = groups.get(key) ?? { namespace, entries: [] };
		groups.set(key, group);
		// 每个工具只渲染一次；长度/4向上取整只是估算，未用 tokenizer。
		const section = renderToolSection(tool);
		group.entries.push({ name: tool.name, section, cost: Math.ceil(section.length / CHARS_PER_TOKEN) });
	}
	// 先未分组，再按命名空间名称排序；... 将迭代器转为可排序的数组。
	const ordered = [...groups.values()].sort((a, b) =>
		a.namespace === undefined ? -1 : b.namespace === undefined ? 1 : a.namespace.name.localeCompare(b.namespace.name),
	);
	// 预算只按工具小节 cost 扣除，并未把组标题/说明计进去。
	const shown = selectCatalog(ordered, budget);

	// 下文按组的展示顺序输出，而不是按选择时的廉价优先顺序。
	const toolSections = ["Tools scripts can call (`await tools.<name>(args)`):"];
	for (const { namespace, entries } of ordered) {
		// 初建的未分组组可能没有工具，直接跳过。
		if (entries.length === 0) continue;
		// 每组仅保留已被预算选择的工具。
		const visible = entries.filter((entry) => shown.has(entry.name));
		if (namespace) {
			// 三种标题后缀分别表示全展示、全省略、部分省略。
			const listing =
				visible.length === entries.length
					? ""
					: visible.length === 0
						? " (tools not listed)"
						: " (some tools not listed)";
			// ?. 允许 description 缺省；只展示去掉首尾空白后仍非空的描述。
			const description = namespace.description?.trim();
			toolSections.push(`## ${namespace.name}${listing}${description ? `\n${description}` : ""}`);
		} else if (visible.length < entries.length) {
			// 未分组工具被省略时，在目录里指向运行时 searchTools。
			toolSections.push("Some tools are not listed: find them with `searchTools()`.");
		}
		// 保留组内原工具顺序逐项追加。
		for (const entry of visible) toolSections.push(entry.section);
	}
	// 双换行分隔 Markdown 段落，返回最终字符串。
	return toolSections.join("\n\n");
}
