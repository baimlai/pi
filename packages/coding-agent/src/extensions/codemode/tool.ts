/**
 * The `codemode` tool: the model writes JavaScript that calls other tools. Scripts use `tools`,
 * `ALL_TOOLS`, `text()`, `image()`, `exit()`, `store()`/`load()`, `console.*`, and `return <value>`,
 * may start with a `// @options:` line, and reach the model catalog, classifiers, and image models
 * through `models.*`. Results start with a "Script completed" or "Script failed" header.
 *
 * Scripts can call the agent loop's nested tools: active `direct` tools and every `codemode` or
 * `deferred` tool. Nested calls run through the agent loop's tool pipeline (`ctx.executeTool`), so
 * validation, `tool_call`/`tool_result` hooks, and permission checks apply exactly as for direct
 * calls. Only the script's output reaches the model; nested results do not.
 *
 * Nested results are handed to the script as follows:
 * - A tool that declares `outputSchema` resolves to its `structuredContent`, also for error
 *   results that carry one.
 * - Any other tool resolves to its text content as one string.
 * - A failed, blocked, or invalid call rejects with an Error carrying the tool's error text.
 *
 * A script that fails returns a normal error result that keeps its partial output, followed by
 * "Script error:" and the error. `store(key, value)` and `load(key)` keep JSON values across
 * calls; successful scripts append their writes to the session as `codemode-store` custom entries,
 * so each branch sees the values written on its own path.
 */

// codemode 的工具声明/模型说明入口；真正执行延迟交 execute.ts，本文件还负责决定哪些工具说明内嵌、哪些直接声明隐藏。
// 例：模型生成 const a=await tools.read({path:"a.txt"}); text(a);，宿主执行器把read交原工具管线，模型只收到脚本显式输出。
// 成功脚本的store写入可由appendEntry保存在当前会话分支；这不是自动写入长期记忆或改模型上下文压缩。
import { join } from "node:path";
// import type只用作结构检查，不会在运行时创建Agent。
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CodemodeJsonSchema, CodemodeTool } from "@earendil-works/pi-codemode";
// 声明渲染器把schema画成TS类型文字供模型参考；不会因此让运行中的脚本变成TypeScript或自动验证返回值。
import { renderToolOutputType, renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
// 语法约束描述原始JS输入外形和可选首行指令，不验证JS逻辑安全/正确。
import { CODEMODE_SOURCE_GRAMMAR } from "@earendil-works/pi-codemode/source";
// Type创建参数schema，Static根据这个值推导编译期输入类型。
import { type Static, Type } from "typebox";
// 包内文档位置通过config辅助解析，适配源码、npm和独立二进制。
import { getDocsPath } from "../../config.ts";
// 类型分别描述扩展工具、当前工具配置视图、修改结果和命名空间元数据。
import type { ToolDefinition, ToolLoadout, ToolLoadoutChanges, ToolNamespace } from "../../core/extensions/types.ts";
// 模型运行接口在execute.ts才真正使用，本文件仅抽取它的部分方法。
import type { ModelRegistry } from "../../core/model-registry.ts";
// 默认模式/预算与设置保持统一。
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import type { CodemodeMode } from "../../core/settings-manager.ts";
// 兼容普通AgentTool的包装器保留扩展定义所需的验证/执行适配，不在创建时运行工具。
import { type TypeBoxAgentTool, wrapToolDefinition } from "../../core/tools/tool-definition-wrapper.ts";
// 动态加载运行层，避免启动时就加载worker/QuickJS。
import { loadCodemodeExecutor } from "./execute.lazy.ts";
// 渲染器只负责显示调用/结果，和execute职责分开。
import { codemodeRenderers } from "./renderer.ts";

// 公共工具名称，用来排除脚本嵌套启动自身。
export const CODEMODE_TOOL_NAME = "codemode";

/** Custom entry type holding one script's `store()` writes: {@link CodemodeStoreEntryData}. */
// 会话自定义条目类型，里面只保存一次成功脚本对store的变更。
export const CODEMODE_STORE_ENTRY_TYPE = "codemode-store";

/** 单次store变更集：set是要写的键值，delete是要删的键；回放当前分支时按条目顺序应用。 */
export interface CodemodeStoreEntryData {
	// Record<string,unknown>允许任意键；可序列化等约束在沙箱JSON边界实现，不是unknown自动保证。
	set: Record<string, unknown>;
	// delete在这里是属性名，可用于对象字段，不是在执行delete操作符。
	delete: string[];
}

/** The part of the model registry that scripts reach through `models`. */
/** 只开放模型目录查询、分类和图片生成这些方法；不是把ModelRegistry整个对象原样传进沙箱。 */
export type CodemodeModelRuntime = Pick<
	// Pick第一个类型是原对象，第二个联合列出可用方法名。
	ModelRegistry,
	"getModelsOfType" | "getAvailableOfType" | "getModelOfType" | "classify" | "generateImages"
>;

/** 宿主依赖与展示配置，通过回调按需要读取；不提供某回调就采用对应默认/省略能力。 */
export interface CodemodeToolOptions {
	/** Namespace of a tool, for `searchTools()` ranking and its `namespace` filter. */
	// 按工具名查询当前命名空间，搜索可据它过滤/排名。
	getToolNamespace?: (toolName: string) => ToolNamespace | undefined;
	/** Prompt guidelines of every tool, by tool name, shown with declarations by `describeTool()` and `ALL_TOOLS`. */
	// ReadonlyMap与readonly数组是编译期只读视图，供模型说明拼接，不代表运行时冻结。
	getToolGuidelines?: () => ReadonlyMap<string, readonly string[]>;
	/**
	 * Expose the `models` namespace to scripts, backed by the session's model registry
	 * (`ctx.modelRegistry`). Without it, `models` is not declared.
	 */
	// 仅控制是否声明/提供models辅助，真正能运行还需要执行时有session context。
	models?: boolean;
	/**
	 * Persists `store()` writes as a session custom entry. Without it, writes last only for the
	 * current script; `load()` still reads entries already on the branch.
	 */
	// 成功脚本的store变更由宿主持久化；没给则写入只在当前脚本里可见，不自动写文件。
	appendEntry?: (customType: string, data: CodemodeStoreEntryData) => void;
	/** How the tool presents the loadout while active (the `codemode.mode` setting). Default: `on`. */
	// 模式在每次准备loadout时读取，不把构造时设置永远缓存。
	getMode?: () => CodemodeMode;
	/** Token budget for tool declarations in the description. Default: {@link DEFAULT_CODEMODE_INLINE_BUDGET}. */
	// 回调可返回undefined，后续采用统一默认预算；0是有意义的“不内嵌工具片段”。
	getInlineBudget?: () => number | undefined;
}

// 没有outputSchema的工具按文字结果提供给脚本，所以声明输出string；不是在此将所有返回值强制转string。
const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };

/** 输入schema只要求code字符串；原始JS/首行选项的解析和执行在延迟加载的执行器里进行。 */
export const codemodeSchema = Type.Object({
	// 参数名code，模型受约束时可直接输出原始JS，适配层再构造成这个形状。
	code: Type.String({
		// 描述只是给模型/工具文档的提示文字。
		description: "Raw JavaScript source.",
	}),
});

// typeof取schema变量的静态类型，Static推导{code:string}，不执行运行时typeof。
export type CodemodeToolInput = Static<typeof codemodeSchema>;

// 嵌套调用状态联合，执行器按流程更新；cancelled不保证远端操作已撤销。
export type CodemodeNestedCallStatus = "running" | "ok" | "error" | "cancelled";

/** 终端展示的一条嵌套调用记录，含简化参数/错误和可选成本；不是完整工具调用审计日志。 */
export interface CodemodeNestedCall {
	/** Tool call id of the nested call, `<codemode call id>/<n>`. */
	// 记录开始时可能临时为父id/?，工具管线返回后才填实际ID；models调用有独立后缀。
	id: string;
	// 工具或models辅助方法名称。
	name: string;
	/** Compact JSON of the arguments, truncated for display. */
	// 已截断的JSON预览，不是原始输入；可能因不可序列化而为空。
	args: string;
	// 当前执行状态。
	status: CodemodeNestedCallStatus;
	// 从执行器记录的毫秒耗时，可能含并发限额排队。
	durationMs?: number;
	/** Error text, truncated for display. */
	// 执行器截断过的错误预览。
	error?: string;
	/** Cost in USD of a `models.*` call that reported usage. */
	// 模型调用返回usage时的USD费用，0也可能是合法值；不是账单查询。
	cost?: number;
}

/** codemode工具详情供UI展示嵌套进度及可能的全文保存路径。 */
export interface CodemodeToolDetails {
	// 所有嵌套调用预览，执行器在更新时做浅快照。
	calls: CodemodeNestedCall[];
	/** Temp file with the full text output, when the output was truncated. */
	// 输出正文过长时保存的临时文本文件，可能写入失败而没有路径。
	fullOutputPath?: string;
}

/** 给系统提示的简短用途和规则；as const保留字面量/只读类型，不在运行时深冻结对象。 */
export const codemodeToolSystemPromptContribution = {
	// 工具简短用途，用于系统提示工具列表。
	snippet: "Run JavaScript that calls other tools",
	// 可单独合入系统提示的规则数组，字符串保持原样。
	guidelines: [
		"Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls.",
	],
} as const;

/** The reference for scripts: globals, tool results, `store()`, the `models` API, and limits. */
// 脚本文档的实际路径，通过统一资产helper解析；不是从__dirname硬编码。
export const CODEMODE_DOCS_PATH = join(getDocsPath(), "codemode.md");

// 完整模型提示包含多行模板字串；它说明JS异步函数体、可用工具与首行选项。注释只放外面，字符串行本身全是运行时提示。
// 脚本不能直接用Node/网络，但可通过获准的宿主工具间接读写/联网；取消信号也不等于回滚已完成副作用。
const DESCRIPTION_INTRO = `Run JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level \`await\` and \`return\` work. No Node, file system, network, or timers.
- \`await tools.<name>({ ...args })\` resolves to a string, or an object if the tool's declaration says so, and rejects with an Error on failure. A tool whose declaration returns an object resolves on failure too when it returned that object; check its fields. Calls still running when the script ends are cancelled.
- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\``;

/** One line per global. The details live in {@link CODEMODE_DOCS_PATH}. */
// 按models开关生成辅助函数说明文字，不创建这些函数、不发模型请求；详细运行实现见execute.ts。
function describeGlobals(models: boolean): string {
	// 先放共同说明，再按需要追加models。
	const lines = [
		// 显示说明块的标题。
		"Globals:",
		// 输出、图像、控制台与return的说明；image落临时文件由执行器完成，不是沙箱直接取得fs权限。
		"- `text(value)`, `image(dataUrlOrImageBlock)`, `console.log(...)`, and top-level `return` add output; `exit()` ends the script. With several text items, each starts with a `==> text N/M <==` line, and `console` lines follow the other output in one `<console_output>` block. `image()` also saves the image to a temp file and the result names its path.",
		// 跨脚本store需要成功结果及宿主appendEntry配合，不是函数名本身保证永久保存。
		"- `store(key, value)` and `load(key)` keep JSON values across codemode calls.",
		// 发现辅助要await；它们由宿主返回Promise，而不是同步全局JS对象方法。
		"- `ALL_TOOLS`, `await searchTools(query, { limit?, namespace? })`, `await describeTool(name)`, `await describeNamespace(name)`: find unlisted tools, such as MCP tools.",
	];
	// 只有开models时添加对应说明。
	if (models) {
		// 文档路径插入提示，帮助模型获取实际API用法。
		lines.push(`- \`models\`: classifiers and image generation. Read ${CODEMODE_DOCS_PATH} first.`);
	}
	// 按LF拼成一个说明字符串。
	return lines.join("\n");
}

/** Default for {@link CodemodeDescriptionOptions.inlineBudget}, in estimated tokens. */
// 设置提供的默认工具片段预算，单位估算token；不直接限制脚本输出。
export const DEFAULT_CODEMODE_INLINE_BUDGET = SETTINGS_DEFAULTS.codemode.inlineBudget;
/** Characters per token when estimating the cost of a tool section. */
// 按JS字符串代码单元数/4估算，不调用模型分词器，中文/特殊字符误差可能较大。
const CHARS_PER_TOKEN = 4;

/**
 * What a script sees of a tool: its description followed by its prompt guidelines, which the system
 * prompt only has for declared tools. Tools without an output schema resolve to their text output.
 */
/** 将普通工具转成脚本可读声明数据，不含execute。例参数schema转TS参考文字，规则在描述后用项目符号附加；没有输出schema默认string。 */
export function toCodemodeDeclaration(
	// AgentTool<any>在这里不限定具体参数schema类型；此函数只提取定义，不执行输入验证。
	tool: AgentTool<any>,
	// 没给规则用空数组，不修改原数组。
	guidelines: readonly string[] = [],
	// Omit仅在类型上去掉execute键，返回对象确实也没放执行回调。
): Omit<CodemodeTool, "execute"> {
	// trim后空规则丢弃；flatMap同时完成过滤和添加“- ”前缀。
	const bullets = guidelines.flatMap((guideline) => (guideline.trim() ? [`- ${guideline.trim()}`] : []));
	// 构造新声明对象，schema对象仍按引用复用。
	return {
		// 保留原名，脚本标识符另外渲染。
		name: tool.name,
		// 有规则时先trim原说明再附加；无规则时原说明连首尾空白也保留。
		description: bullets.length > 0 ? `${tool.description.trim()}\n\n${bullets.join("\n")}` : tool.description,
		// 类型断言只对齐结构，不将TypeBox对象运行时转换/验证成另一份schema。
		inputSchema: tool.parameters as CodemodeJsonSchema,
		// 缺输出schema默认文字string，显式false等schema不会因??被替换；实际返回结构值还须原tool.outputSchema为真值且结果带structuredContent，详见execute.ts/toScriptValue。
		outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? TEXT_OUTPUT_SCHEMA,
	};
}

/** Tools a script may call: every given tool except the codemode tool itself. */
/** 只排除名为codemode的工具并返回新数组；其他可调用资格已由调用方loadout/ctx.tools决定，这里不另查exposure或active。 */
export function getCodemodeCallableTools(tools: readonly AgentTool<any>[]): AgentTool<any>[] {
	// filter不修改输入列表，工具对象本身仍共用引用。
	return tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
}

/** 模型说明构造选项，控制内嵌工具片段；这些展示选择不直接授予脚本新权限。 */
export interface CodemodeDescriptionOptions {
	/** Declare the `models` namespace; only for tools created with model access. */
	// 只加models说明，真实执行仍受上下文/实现控制。
	models?: boolean;
	/** Namespace of each tool, by tool name. Tools of one namespace are listed under one heading. */
	// 工具名→命名空间，便于分组标题。
	namespaces?: ReadonlyMap<string, ToolNamespace>;
	/** Tools that are callable but never listed with their declaration (`deferred` exposure). */
	// deferred工具完全不参与本描述（包括命名空间标题），避免后来连接导致描述反复变化。
	deferred?: ReadonlySet<string>;
	/** Prompt guidelines of each tool, by tool name, listed after its description. */
	// 工具名→额外提示规则。
	guidelines?: ReadonlyMap<string, readonly string[]>;
	/**
	 * Estimated tokens (characters / 4) the tool sections may use. Tools that do not fit are left
	 * out, like deferred tools. Unset lists every tool that is not deferred.
	 */
	// 只算工具section长度；总说明的intro、globals、namespace标题/描述等不包含在这个片段预算中。
	inlineBudget?: number;
}

/** `### \`id\` (\`raw name\`)` followed by the tool's description and declaration. */
// 把声明渲染成Markdown工具片段：标题用脚本标识符，若原名不同再附原名；不执行生成的TS参考声明。
function renderToolSection(declaration: Omit<CodemodeTool, "execute">): string {
	// 例如my-tool变my_tool；这是名称映射，不证明没有同名碰撞，实际沙箱注册还有规则。
	const id = toCodemodeIdentifier(declaration.name);
	// 用三元表达式选两种标题形式，反引号在模板内需转义。
	const heading = id === declaration.name ? `### \`${id}\`` : `### \`${id}\` (\`${declaration.name}\`)`;
	// 声明渲染器带输出类型和输入schema文字；trim仅整理呈现。
	return `${heading}\n${renderToolSample(declaration).trim()}`;
}

// 目录条目是预渲染片段及其估算成本。
interface CatalogEntry {
	// 工具原名作选择集合键。
	name: string;
	// 完整Markdown片段。
	section: string;
	// ceil(section.length/4)得到估算token。
	cost: number;
}

// 一个命名空间组或无命名空间的默认组。
interface CatalogGroup {
	// undefined表示普通工具组。
	namespace: ToolNamespace | undefined;
	// 该组内工具条目，收集顺序供最终显示使用。
	entries: CatalogEntry[];
}

/**
 * Pick the tool sections that fit the budget, like OpenCode's catalog: in each round every group
 * (tools without a namespace first, then namespaces by name) places its cheapest remaining tool; a
 * group whose next tool does not fit drops out while the others continue. Every namespace is
 * represented before any namespace is complete.
 */
// 按预算轮流从每组取当前最便宜项，某组最便宜项都放不下则退出。例预算只够一部分组时不会保证每组必有工具；未设预算全选。
function selectCatalog(groups: readonly CatalogGroup[], budget: number | undefined): Set<string> {
	// undefined不限制，flatMap取所有名称再用Set去重。
	if (budget === undefined) return new Set(groups.flatMap((group) => group.entries.map((entry) => entry.name)));
	// 每组浅复制条目数组再按成本升序，避免改变原组的显示顺序。
	const queues = groups.map((group) => [...group.entries].sort((a, b) => a.cost - b.cost));
	// 选择结果用Set判断名称是否已显示。
	const shown = new Set<string>();
	// let保存剩余预算，可为0；直接调用本函数不在这里验证预算有限/非负。
	let remaining = budget;
	// 初始去掉空组。
	let active = queues.filter((queue) => queue.length > 0);
	// 还有可选组就继续轮流取一个。
	while (active.length > 0) {
		// filter边处理每组边保留仍有条目且本轮放得下的组。
		active = active.filter((queue) => {
			// 队头是这组最便宜的剩余项。
			const next = queue[0];
			// 连最便宜都超剩余预算，此组退出后不再考虑；别组仍继续。
			if (next.cost > remaining) return false;
			// 扣除本条成本。
			remaining -= next.cost;
			// 记录名称；没有向模型发送动作，仅计算展示集合。
			shown.add(next.name);
			// 移掉已选队头，下一轮看下一便宜项。
			queue.shift();
			// 还有条目才继续参与。
			return queue.length > 0;
		});
	}
	// 返回名称集合，不直接返回已排序片段。
	return shown;
}

/**
 * Model-facing description: the helper list, guidance for finding tools that are not listed, the
 * `models` API, and one section per listed tool, grouped by namespace. Deferred tools are never
 * listed and do not affect the description at all, so it stays the same while tools are registered
 * late (for example by MCP servers that connect). Tool sections are limited to `inlineBudget`.
 */
/** 构造模型侧完整codemode描述：排自身/deferred→按命名空间分组→预算挑片段→按组拼说明。例inlineBudget:0仍可能显示命名空间标题，不能说整个描述0token。 */
export function createCodemodeDescription(
	// 输入供展示的工具集合，实际执行时工具由ctx.tools确定；传入此处不等于赋执行权限。
	tools: readonly AgentTool<any>[],
	// 参数对象默认{}，字段可独立省略。
	options: CodemodeDescriptionOptions = {},
): string {
	// 先排除自身，避免生成脚本调用自身的参考条目。
	const declarations = getCodemodeCallableTools(tools)
		// 可选Set无此工具或没有Set时保留；deferred被完整排除。
		.filter((tool) => !options.deferred?.has(tool.name))
		// 每条取对应规则转成声明数据。
		.map((tool) => toCodemodeDeclaration(tool, options.guidelines?.get(tool.name)));
	// 空键表示无命名空间组，初始就存在但可能没有工具。
	const groups = new Map<string, CatalogGroup>([["", { namespace: undefined, entries: [] }]]);
	// 逐声明收集目录，未做联网发现。
	for (const declaration of declarations) {
		// 名称查分组元数据。
		const namespace = options.namespaces?.get(declaration.name);
		// 有命名空间用ns:前缀避免和默认空键混淆。
		const key = namespace ? `ns:${namespace.name}` : "";
		// 取已有组，否则新建；同名命名空间后来的描述不会替换首个已存元数据。
		const group = groups.get(key) ?? { namespace, entries: [] };
		// 把组放回Map，已有组是同一对象。
		groups.set(key, group);
		// 每工具先完整渲染，之后才按预算挑选，不是先估小数据再懒渲染。
		const section = renderToolSection(declaration);
		// 记录成本按UTF-16长度/4向上取整，只用于片段选择。
		group.entries.push({ name: declaration.name, section, cost: Math.ceil(section.length / CHARS_PER_TOKEN) });
	}
	// 对Map值浅复制再排序。
	const ordered = [...groups.values()].sort((a, b) =>
		// 默认组优先，其他按namespace.name的localeCompare，不是ASCII固定顺序。
		a.namespace === undefined ? -1 : b.namespace === undefined ? 1 : a.namespace.name.localeCompare(b.namespace.name),
	);
	// 调用轮流挑选，不保证预算不足时每组都有代表。
	const shown = selectCatalog(ordered, options.inlineBudget);

	// 固定intro+globals先进入说明，不占selectCatalog那份预算。
	const sections = [DESCRIPTION_INTRO, describeGlobals(options.models === true)];
	// 没有非deferred工具时直接返回这两块，仍可有models说明。
	if (declarations.length === 0) return sections.join("\n\n");

	// 有工具声明才添加Nested tools标题。
	const toolSections = ["Nested tools:"];
	// 按组顺序输出，组内仍沿原收集顺序，不按成本显示。
	for (const { namespace, entries } of ordered) {
		// 只有选中名称进入visible。
		const visible = entries.filter((entry) => shown.has(entry.name));
		// 命名空间存在时即使visible为空也显示标题；默认组没有独立namespace标题。
		if (namespace) {
			// Only tools that did not fit the budget are counted as not listed here.
			// 按该组哪些片段未放下给提示，不把一开始排掉的deferred计入这里的缺失数。
			const listing =
				visible.length === entries.length
					? ""
					: visible.length === 0
						? " (tools not listed)"
						: " (some tools not listed)";
			// 命名空间description可在标题下显示，instructions此处不内嵌，由describeNamespace按需给。
			const description = namespace.description?.trim();
			// 这些组标题/描述本身没算进片段预算。
			toolSections.push(`## ${namespace.name}${listing}${description ? `\n${description}` : ""}`);
		}
		// 依原顺序追加可见section。
		for (const entry of visible) toolSections.push(entry.section);
	}
	// 工具块用空行连接，保留易读的Markdown。
	sections.push(toolSections.join("\n\n"));
	// 最后把intro、globals和工具块再用空行合成。
	return sections.join("\n\n");
}

/**
 * The field names of an object schema, `{ output, exit_code, full_output_path? }`, with the fields of
 * object-typed fields `depth` levels deep: `{ content, structuredContent?: { results } }`, and the
 * value of `const` fields: `{ action: "start", id }`. Undefined for other schemas.
 */
// 提取对象schema的简短字段预览。例depth=1可显示{data:{id}}，只看显式type/object/properties/required/const，不展开$ref/所有约束，也不验证数据。
function describeFields(schema: unknown, depth: number): string | undefined {
	// unknown边界只收对象，数组虽可过这一行，但下一行字段条件再决定是否提取。
	if (typeof schema !== "object" || schema === null) return undefined;
	// as让TS允许读字段，实际形状由下方有限检查处理。
	const { type, properties, required } = schema as Record<string, unknown>;
	// 必须显式type="object"且properties为非null对象；这里没有排除数组形式properties。
	if (type !== "object" || typeof properties !== "object" || properties === null) return undefined;
	// required是数组才建必填名称Set，不验证每个元素是不是字符串。
	const requiredNames = new Set(Array.isArray(required) ? required : []);
	// 枚举字段按对象自身顺序，不在这里字母排序。
	const fields = Object.entries(properties).map(([name, field]) => {
		// 可选链取字段的const值，类型断言不验证每个field是schema对象。
		const constValue = (field as Record<string, unknown> | null)?.const;
		// 先显示const，否则深度允许才递归。
		const nested =
			constValue !== undefined
				? // 常量值转JSON文字，可能因不可序列化输入抛错。
					JSON.stringify(constValue)
				: depth > 0
					? // 每向内一层depth减1，预览不无限展开嵌套。
						describeFields(field, depth - 1)
					: // 深度耗尽只显示字段名，不显示字段类型。
						undefined;
		// 不在required里加?；nested非空才附冒号内容，字段名原样拼接，不把这段当可执行TS。
		return `${name}${requiredNames.has(name) ? "" : "?"}${nested ? `: ${nested}` : ""}`;
	});
	// 逗号连接字段，空properties会得到{  }。
	return `{ ${fields.join(", ")} }`;
}

/**
 * What a script call resolves to, in one line: `a string`, the field names of an object (see
 * {@link describeFields}), the field names of each object in a union, the rendered type when it
 * fits on one line, or a pointer to `describeTool()` for anything longer. The full type of a large
 * schema would otherwise be sent with every request (#11501).
 */
// 为直接工具说明生成一行输出提示：优先string/字段预览/一行类型，太长的多行类型改为指向describeTool；不严格限制字符数。
function describeOutput(name: string, schema: CodemodeJsonSchema | undefined): string {
	// 先用底层schema渲染器得到TS参考类型；这一步可能涉及本地$ref展开，不代表运行时验证。
	const type = renderToolOutputType(schema);
	// 恰好string就用自然语言a string。
	if (type === "string") return "a string";
	// 先试对象字段，再试对象联合字段，??只在前者没结果时调用后者。
	const fields = describeFields(schema, 1) ?? describeUnionFields(schema);
	// 字段预览有值就用它，不再附完整长类型。
	if (fields) return `\`${fields}\``;
	// 单行类型即使很长也原样内嵌，这不是严格token上限。
	if (!type.includes("\n")) return `\`${type}\``;
	// 多行复杂类型仅给按需查询提示，用JSON.stringify让工具名成为带引号字符串字面展示。
	return `a value; \`await describeTool(${JSON.stringify(name)})\` shows its type`;
}

/**
 * The field names of each variant of an `anyOf`/`oneOf` whose variants are all objects, joined by
 * `|`.
 */
// 若anyOf/oneOf的每项都能提取为对象字段，就合成简短联合预览；混有string等分支返回undefined交其他展示路径。
function describeUnionFields(schema: unknown): string | undefined {
	// 只做根值形状筛选。
	if (typeof schema !== "object" || schema === null) return undefined;
	// 取两个可能的联合关键字。
	const { anyOf, oneOf } = schema as Record<string, unknown>;
	// anyOf非null/undefined就优先，哪怕它不是有效数组也不退到oneOf。
	const variants = anyOf ?? oneOf;
	// 无有效非空数组就不产生预览。
	if (!Array.isArray(variants) || variants.length === 0) return undefined;
	// 每项只提顶层字段，depth=0不继续展示嵌套对象细节。
	const described = variants.map((variant) => describeFields(variant, 0));
	// 全部成功才用|连接；任何一项undefined就整体放弃这个简写。
	return described.every((fields) => fields !== undefined) ? described.join(" | ") : undefined;
}

/**
 * A declared tool's description followed by how scripts call it and what the call resolves to. The
 * arguments are the tool's declared parameters, so they are not repeated.
 */
// 给直接声明的工具追加脚本调用说明；只生成文字，不改execute或参数schema，具体脚本值转换见execute.ts/toScriptValue。
function describeScriptCall(tool: AgentTool<any>): string {
	// 模板中同时嵌入原说明、映射名称与简短输出类型；保持字符串逻辑不变。
	return `${tool.description.trim()}\n\nCodemode: \`tools.${toCodemodeIdentifier(tool.name)}(args)\` resolves to ${describeOutput(tool.name, toCodemodeDeclaration(tool).outputSchema)}.`;
}

/**
 * How the codemode tool presents tools that are both declared and callable from scripts:
 * - `on`: their descriptions say how scripts call them, and the codemode description
 *   lists only the callable tools without `direct` exposure.
 * - `only`: the codemode description lists every callable tool, and requests leave out the
 *   declarations of active `direct` tools.
 *
 * Listed tools carry their prompt guidelines, which the system prompt only has for declared tools.
 *
 * Listing by exposure, not by the active set, keeps the codemode description unchanged when
 * `tool_search` loads a tool, so loads do not redeclare codemode.
 */
// 准备工具配置的展示修改：on给直接工具附脚本用法、仅内嵌间接工具；only内嵌可调用工具，并隐藏其中已声明direct工具。实际资格仍来自loadout。
function prepareCodemodeLoadout(loadout: ToolLoadout, options: CodemodeToolOptions): ToolLoadoutChanges {
	// 动态模式回调可省略，缺失取设置默认。
	const mode = options.getMode?.() ?? SETTINGS_DEFAULTS.codemode.mode;
	// 本地单参闭包按loadout查询exposure，不用活动集合代替暴露方式。
	const isDirect = (tool: AgentTool) => loadout.getExposure(tool.name) === "direct";
	// 调用方的callable已决定可脚本调用的集合，这里再排自身。
	const callable = getCodemodeCallableTools(loadout.callable);
	// Set加速判定直接声明工具是否也可脚本调用。
	const callableNames = new Set(callable.map((tool) => tool.name));
	// 只收集本次要覆盖的描述，不原地改工具实现。
	const descriptions: Record<string, string> = {};
	// on模式保留直接工具声明，附上脚本调用提示。
	if (mode === "on") {
		// 遍历当前给模型声明的工具。
		for (const tool of loadout.declared) {
			// 只有同时可脚本调用的才加提示，model-only等不因此获得脚本入口。
			if (callableNames.has(tool.name)) descriptions[tool.name] = describeScriptCall(tool);
		}
	}
	// only选择全部callable；on选择非direct的callable，随后deferred仍会被描述构造器排除。
	const listed = mode === "only" ? callable : callable.filter((tool) => !isDirect(tool));
	// 构建仅供内嵌候选使用的命名空间表。
	const namespaces = new Map(
		// flatMap让无命名空间条目产空数组，起到过滤作用。
		listed.flatMap((tool) => {
			// 通过loadout拿当前工具命名空间。
			const namespace = loadout.getNamespace(tool.name);
			// as const保住二元组类型供Map构造，空数组表示不存这一条。
			return namespace ? [[tool.name, namespace] as const] : [];
		}),
	);
	// 相同方式收集规则；规则会跟随被内嵌/按需描述的工具。
	const guidelines = new Map(listed.map((tool) => [tool.name, loadout.getPromptGuidelines(tool.name)] as const));
	// codemode自己的描述也用动态工具目录重建。
	descriptions[CODEMODE_TOOL_NAME] = createCodemodeDescription(listed, {
		// 严格true才加入models说明。
		models: options.models === true,
		// 属性简写传命名空间表。
		namespaces,
		// 属性简写传规则表。
		guidelines,
		// 将deferred候选列成完整排除集合，不以当前是否已激活决定是否内嵌。
		deferred: new Set(
			// 从候选逐项查暴露方式后取名称。
			listed
				.filter((tool) => loadout.getExposure(tool.name) === "deferred")
				.map((tool) => tool.name),
		),
		// 动态预算缺失就取统一默认，0会保留。
		inlineBudget: options.getInlineBudget?.() ?? DEFAULT_CODEMODE_INLINE_BUDGET,
	});
	// 记录原本给模型声明过的名称，only只隐藏那部分直接工具。
	const declaredNames = new Set(loadout.declared.map((tool) => tool.name));
	// 返回修改描述/隐藏声明的建议，宿主再把它应用到本次loadout。
	return {
		// 按工具名覆盖说明文字。
		descriptions,
		// 隐藏的是模型声明，不是删除工具或执行权限。
		hiddenDeclarations:
			mode === "only"
				? // 仅only模式列出同时direct、callable、declared的名称。
					callable
						.filter((tool) => isDirect(tool) && declaredNames.has(tool.name))
						.map((tool) => tool.name)
				: // on模式不隐藏这些声明。
					[],
	};
}

/** Script globals that list or look up tools and namespaces, which the script may then call by any name. */
// 按源码文字搜发现辅助词，\b为ASCII词边界；这不是JS语法树解析，注释/字符串中的词也可能命中。
const DISCOVERY_GLOBALS = /\b(searchTools|describeNamespace|describeTool|ALL_TOOLS)\b/;

/**
 * The tools a script may call (`ToolDefinition.reachesTools`): every tool when it uses a discovery
 * global, else the words of its source, so `tools.mcp__docs__search` and
 * `tools["mcp__docs__" + name]` both name the `mcp__docs` namespace.
 */
// 粗略声明脚本可能触及的服务器范围，让MCP先等所需服务器就绪；不是执行权限校验。例源码含ALL_TOOLS就返回all，否则返回ASCII词数组。
function getScriptReach(code: unknown): "all" | readonly string[] {
	// code来自输入边界，不是字符串时表示没有可识别依赖词。
	if (typeof code !== "string") return [];
	// 正则匹配发现词则all，否则\w+取ASCII字母数字下划线；不做变量数据流/动态字符串求值。
	return DISCOVERY_GLOBALS.test(code) ? "all" : (code.match(/\w+/g) ?? []);
}

/** 创建扩展工具定义，不立刻运行脚本。流程钩子准备描述/声明、reachesTools提示等待范围、执行时lazy加载QuickJS运行层；例code="return 1+1"。 */
export function createCodemodeToolDefinition(
	// options闭包供显示与执行共用，不在此克隆。
	options: CodemodeToolOptions = {},
): ToolDefinition<typeof codemodeSchema, CodemodeToolDetails | undefined> {
	// 返回完整工具定义。
	return {
		// 公共工具名。
		name: CODEMODE_TOOL_NAME,
		// UI显示标签。
		label: CODEMODE_TOOL_NAME,
		// Replaced with the declarations of the callable tools when the tool is activated.
		// 初始没有嵌套目录，宿主激活/准备loadout时会替换说明。
		description: createCodemodeDescription([], { models: options.models === true }),
		// 简短系统提示贡献。
		promptSnippet: codemodeToolSystemPromptContribution.snippet,
		// 展开成新规则数组，不修改常量数组。
		promptGuidelines: [...codemodeToolSystemPromptContribution.guidelines],
		// 参数schema连接宿主验证入口。
		parameters: codemodeSchema,
		// Scripts must not start other scripts.
		// model-only阻止脚本嵌套调用codemode自身；它仍可由模型直接使用。
		exposure: "model-only",
		// 每次由宿主根据loadout准备描述/隐藏建议。
		prepareLoadout: (loadout) => prepareCodemodeLoadout(loadout, options),
		// input.code的源码词扫描只为readiness提示，不执行脚本。
		reachesTools: (input) => getScriptReach(input.code),
		// Capable models write the script as raw text instead of a JSON-escaped string.
		// 支持对应grammar的提供商可输出原始JS；这是输入形状约束，不证明脚本业务正确/无副作用。
		constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
		// The sandbox (worker, QuickJS wasm) loads on the first call, not at startup.
		// 箭头execute异步加载模块，加载失败也会拒绝到工具管线。
		execute: async (toolCallId, params, signal, onUpdate, ctx) =>
			// 原参数/信号/进度/context继续传执行器，options补在最后；不在此吞错误。
			(await loadCodemodeExecutor()).executeCodemode(toolCallId, params, signal, onUpdate, ctx, options),
		// 把展示回调展开到定义，执行和渲染各自独立。
		...codemodeRenderers,
	};
}

/**
 * Create the codemode tool as an AgentTool. The description lists the given tools; the script can
 * call whatever tools the agent loop provides at execution time.
 */
/** 给普通Agent用户创建兼容工具：定义→包装→赋初始说明。传tools只影响初始描述，实际能调用什么仍取执行时上下文。 */
export function createCodemodeTool(
	// 默认空目录不意味着脚本运行时永久没有工具。
	tools: readonly AgentTool<any>[] = [],
	// 可选宿主能力与模式/预算回调。
	options: CodemodeToolOptions = {},
): TypeBoxAgentTool<typeof codemodeSchema> {
	// 创建扩展形态定义，尚未执行脚本。
	const definition = createCodemodeToolDefinition(options);
	// 适配成普通TypeBox AgentTool，包装器决定缺上下文等行为。
	const tool = wrapToolDefinition(definition);
	// Object.assign原地补tool这几个展示字段，返回的仍是同一tool对象。
	Object.assign(tool, {
		// 用输入目录构造初始说明，不给execute额外绑定这份列表。
		description: createCodemodeDescription(tools, { models: options.models === true }),
		// 保留简短提示。
		promptSnippet: definition.promptSnippet,
		// 沿用规则数组引用。
		promptGuidelines: definition.promptGuidelines,
	});
	// 返回已包装的工具。
	return tool;
}
