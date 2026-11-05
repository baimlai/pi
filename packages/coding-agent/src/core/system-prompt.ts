// 系统提示词的组装层：ResourceLoader 先读取文件/技能元信息，AgentSession 把这些资源及工具说明交给这里构建系统状态。
// 此文件不扫描项目、不读取技能正文、不请求模型；它把已加载材料组织为可独立更新的 sections，供模型 transcript 重放。
/**
 * System prompt construction and project context loading
 */

// 共享渲染器按模型 transcript 的规则拼系统正文，避免本地预览与真实请求各写一套。
import { getSystemMessageText } from "@earendil-works/pi-ai";
// 通过 config 获取安装后的文档路径，兼容源码仓库、npm 和独立程序。
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
// 运行时函数只生成技能目录；type Skill 仅参与类型检查，不把完整 SKILL.md 自动塞进提示词。
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

// 调用方提供的原始组装参数；? 表示字段可缺省，只有 cwd 是必填。
export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces the default prefix). */
	// 替换默认前言，并跳过默认工具/规则/文档段；其他追加段、项目上下文、技能、cwd 仍可加入。
	customPrompt?: string;
	/** Exact full prompt replacement set by a before_agent_start handler. */
	// 完整强制替换值；即使空字符串也能生效，并绕过全部结构化分段。
	forceSystemPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write]. */
	// 当前选择工具名；缺省采用 read/bash/edit/write，不在这里加载或执行工具。
	selectedTools?: string[];
	/**
	 * Selected tools whose declarations requests leave out (`prepareLoadout` hidden declarations).
	 * They are reachable only through another tool, so the tool list and rules leave them out too.
	 */
	// 已选择但声明被隐藏的工具，从直接工具说明/规则中排除；工具仍可能由 codemode 等间接调用。
	hiddenTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	// 工具名到简短说明的字典；Record 两个类型参数限定键和值。
	toolSnippets?: Record<string, string>;
	/** Guideline bullets contributed by each tool, keyed by tool name. */
	// 各工具贡献的规则数组，只有直接声明工具的规则会被组装。
	toolGuidelines?: Record<string, string[]>;
	/** Additional guideline bullets appended to the default system prompt rules. */
	// 调用方额外的规则条目，默认规则模式下追加并去重。
	promptGuidelines?: string[];
	/** Text appended from user configuration before project context, skills, and cwd. */
	// 配置追加文字，排在项目上下文、技能和工作目录前面；不覆盖默认前言。
	appendSystemPrompt?: string;
	/** Additional XML-wrapped prompt sections keyed by tag name. */
	// 调用方命名段，可覆盖同名内置段；段名需满足小写标识规则且不能是 preamble。
	sections?: Record<string, string>;
	/** Working directory. */
	// 工作目录展示值，最终将 Windows 反斜杠统一为正斜杠。
	cwd: string;
	/** Pre-loaded context files. */
	// 已加载项目说明数组；Array<对象类型> 描述每项同时带来源路径和正文。
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	// 已发现的技能元信息，模型目录只展示名称、描述和文件位置。
	skills?: Skill[];
}

// & 为交叉类型：保留原选项，再把集合字段收窄为已补齐默认值的必填字段，便于扩展修改。
export type NormalizedBuildSystemPromptOptions = BuildSystemPromptOptions & {
	selectedTools: string[];
	hiddenTools: string[];
	toolSnippets: Record<string, string>;
	toolGuidelines: Record<string, string[]>;
	promptGuidelines: string[];
	appendSystemPrompt: string;
	sections: Record<string, string>;
	contextFiles: Array<{ path: string; content: string }>;
	skills: Skill[];
};

/**
 * Ordered system prompt sections, keyed by name. `preamble` is untagged text; every other
 * section is wrapped in a tag of the same name so the model can match later updates to it.
 * These become `SystemMessage.sections` in the transcript.
 */
// 按插入顺序保存各段的字典；preamble 无标签，其他段的值已经包上同名标签。
export type SystemPromptSections = Record<string, string>;

// 自定义段名必须小写字母开头，之后只允许小写字母、数字、下划线和横线，避免拼出任意标签名。
const SYSTEM_PROMPT_SECTION_NAME = /^[a-z][a-z0-9_-]*$/;
/** Normalize prompt input into the mutable, collection-complete shape exposed to extensions. */
// 将可选集合补齐并复制为扩展可修改的形状；输入原配置，返回新对象，不读文件、不改输入集合。
// 例如未提供 selectedTools 时得到四个默认工具；空数组则明确保持为空，?? 只处理 null/undefined。
// 这里是规范形状与浅复制，不是对所有字符串/工具名执行 schema 验证。
export function normalizeBuildSystemPromptOptions(input: BuildSystemPromptOptions): NormalizedBuildSystemPromptOptions {
	return {
		// 保留自定义前言选择，不在规范化阶段判断是否使用。
		customPrompt: input.customPrompt,
		// 保留完整强制替换值，之后由状态入口判断 undefined 与空串的差别。
		forceSystemPrompt: input.forceSystemPrompt,
		// ?? 提供默认工具，... 复制数组容器，防止扩展 push 影响调用者的数组。
		selectedTools: [...(input.selectedTools ?? ["read", "bash", "edit", "write"])],
		// 缺省隐藏列表为空，复制后供扩展调整。
		hiddenTools: [...(input.hiddenTools ?? [])],
		// 对象展开复制工具说明字典，后续写键不改变原字典。
		toolSnippets: { ...(input.toolSnippets ?? {}) },
		// 将规则字典拆成条目再重建，连每个规则数组也单独复制。
		toolGuidelines: Object.fromEntries(
			// [name,guidelines] 是数组解构；每条映射回 [键,新数组] 供 fromEntries 建字典。
			Object.entries(input.toolGuidelines ?? {}).map(([name, guidelines]) => [name, [...guidelines]]),
		),
		// 复制额外规则列表，缺省为空。
		promptGuidelines: [...(input.promptGuidelines ?? [])],
		// 缺省追加正文为空串，保留显式提供的字符串。
		appendSystemPrompt: input.appendSystemPrompt ?? "",
		// 复制额外段字典；这里没有先对正文做标签转义。
		sections: { ...(input.sections ?? {}) },
		// 工作目录原值先保留，到渲染阶段才统一分隔符。
		cwd: input.cwd,
		// 复制数组及每个文件描述对象，正文字符串本身无需深复制。
		contextFiles: (input.contextFiles ?? []).map((file) => ({ ...file })),
		// 复制技能描述对象；属于浅复制，嵌套 sourceInfo 仍可能共享。
		skills: (input.skills ?? []).map((skill) => ({ ...skill })),
	};
}

// 把预加载项目说明包装成带路径的材料段，输入文件描述数组，返回字符串，无文件 I/O。
// 例如 AGENTS.md 正文放在 project_instructions 标签中；这里只拼文本，没有把路径/正文作 XML 转义或执行其内容。
function renderProjectContext(contextFiles: Array<{ path: string; content: string }>): string {
	return [
		"Project-specific instructions and guidelines:",
		// 每份上下文文件先单独生成一段，再展开进前面说明文字所在的数组。
		...contextFiles.map(
			// 参数解构取路径和正文；模板插值记录来源，但标签本身不是权限隔离。
			({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
		),
		// 用空行连接说明及各份文件材料。
	].join("\n\n");
}

// 根据直接声明工具和额外规则生成项目符号列表；输入工具名/各工具规则/额外规则，返回文字，不执行工具。
// 先加入适用的 shell 使用提示，再按工具选择顺序加规则，最后加通用简洁/路径规则；规则按 trim 后全文去重。
// 例如同时选择 bash 和独立 grep 时，不额外提示用 bash 代替所有查找工具。
function buildRules(
	selectedTools: string[],
	toolGuidelines: Record<string, string[]>,
	promptGuidelines: string[],
): string {
	// 按添加顺序收集最终规则。
	const rules: string[] = [];
	// Set 记录已加入的完整规则文字，不按主题/语义去重。
	const seen = new Set<string>();
	// 局部追加函数会修剪空白、忽略空规则和重复项，原地更新 rules/seen，不返回值。
	const addRule = (rule: string): void => {
		// 只去掉首尾空白，不改写规则内部词句。
		const normalized = rule.trim();
		// 空规则或相同全文直接跳过；内容相近但文字不同仍会保留。
		if (!normalized || seen.has(normalized)) return;
		// 先登记，后续完全相同文字不再重复。
		seen.add(normalized);
		// 按首次出现顺序加入规则。
		rules.push(normalized);
	};

	// 检查当前直接工具集合是否含 bash。
	const hasBash = selectedTools.includes("bash");
	// 同样检查 PowerShell，后面据可用 shell 选择提示文字。
	const hasPowerShell = selectedTools.includes("powershell");
	// 独立 grep 存在时不把所有查找都引向 shell。
	const hasGrep = selectedTools.includes("grep");
	// 检查独立 find 工具是否已经可用。
	const hasFind = selectedTools.includes("find");
	// 检查独立 ls 工具是否已经可用。
	const hasLs = selectedTools.includes("ls");

	// 有 shell 且三个独立查找/列目录工具都没有时，才添加 shell 文件操作提示。
	if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
		// 两个 shell 都有时提示可任选一个。
		if (hasBash && hasPowerShell) {
			addRule("Use bash or PowerShell for file operations like listing, searching, and finding files");
			// 只有 PowerShell 时不提示不存在的 bash。
		} else if (hasPowerShell) {
			addRule("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addRule("Use bash for file operations like ls, rg, find");
		}
	}

	// 按直接工具的给定顺序汇入各自规则。
	for (const name of selectedTools) {
		// 缺该工具规则就用空数组；逐条经同一个去重函数处理。
		for (const rule of toolGuidelines[name] ?? []) addRule(rule);
	}
	// 调用方规则排在工具规则后，但相同全文不会重复。
	for (const rule of promptGuidelines) addRule(rule);
	// 最后加入通用简洁回答要求，也参与全文去重。
	addRule("Be concise in your responses");
	// 最后加入清楚展示文件路径的通用要求。
	addRule("Show file paths clearly when working with files");
	// 每条前加 Markdown 项目符号，用换行组成规则正文。
	return rules.map((rule) => `- ${rule}`).join("\n");
}

/** Build the ordered, independently replaceable sections of the structured system prompt. */
// 构建可独立替换的有序系统段，输入原配置，返回已包装的段字典，不发模型请求。
// 流程：补默认→检查自定义段名→过滤隐藏工具→默认/自定义前言→追加项目/技能/cwd→同名自定义覆盖→包装标签。
// 例如 customPrompt 只换默认前言相关段，forceSystemPrompt 的完整替换由另一个入口处理；非法段名抛 Error。
export function buildSystemPromptSections(input: BuildSystemPromptOptions): SystemPromptSections {
	// 先给扩展形状补齐集合，后面不再反复判断 undefined。
	const options = normalizeBuildSystemPromptOptions(input);
	const {
		customPrompt,
		selectedTools,
		hiddenTools,
		toolSnippets,
		toolGuidelines,
		promptGuidelines,
		appendSystemPrompt,
		// 对象解构重命名：把 options.sections 存入 customSections，避免与最终返回变量重名。
		sections: customSections,
		cwd,
		contextFiles,
		skills,
	} = options;

	// 在写入任何自定义段前检查全部键名。
	for (const name of Object.keys(customSections)) {
		// 正则不合法或试图使用保留前言名均拒绝；其他内置段名允许被覆盖。
		if (!SYSTEM_PROMPT_SECTION_NAME.test(name) || name === "preamble") {
			// 明确报告哪个自定义键无效，不静默生成坏标签。
			throw new Error(`Invalid system prompt section name: ${name}`);
		}
	}

	// 只保留请求会直接声明的工具，用于工具说明与行为规则。
	const declaredTools = selectedTools.filter((name) => !hiddenTools.includes(name));
	// 按后续赋值的插入顺序积累段正文，此时还没有包装标签。
	const promptSections: Record<string, string> = {};
	// 只有非空自定义前言才走自定义模式，空串会回退默认模式。
	if (customPrompt) {
		// 采用调用者自定义前言，跳过下面默认工具/规则/文档段。
		promptSections.preamble = customPrompt;
	} else {
		// 默认模式下设置编码助手身份；下一行字符串是实际给模型的提示词。
		promptSections.preamble =
			"You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";
		// 只展示有非空简短说明的直接工具；!! 把值转为布尔判断。
		const visibleTools = declaredTools.filter((name) => !!toolSnippets[name]);
		// 下面三元式将可展示工具列成项目符号；无工具说明时用固定占位文字。
		const tools =
			// 按选择顺序展示工具名和说明，不自行枚举所有注册工具。
			visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n") : "(none)";
		// 把工具目录作为单独 tools 段；额外工具仍可能由其他机制提供。
		promptSections.tools = `${tools}\n\nAdditional tools may be available.`;
		// 只按直接声明工具组规则，不误提示隐藏工具可直接调用。
		promptSections.rules = buildRules(declaredTools, toolGuidelines, promptGuidelines);
		// 文档说明段的实际模型文字；路径由配置助手插值，下方多行都是字符串内容。
		promptSections.docs = `Pi documentation (read only when the user asks about the harness itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${getReadmePath()}
- Additional docs: ${getDocsPath()}
- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), packages (docs/packages.md), environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md), codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)
- Before implementing harness changes, read the relevant docs and examples in full, following related cross-references.`;
	}

	// 非空配置追加文字独立成 addendum 段，不覆盖前言。
	if (appendSystemPrompt) promptSections.addendum = appendSystemPrompt;
	// 项目说明由已加载内容渲染；这里不再判断来源信任，由资源加载层决定给哪些文件。
	if (contextFiles.length > 0) promptSections.project_context = renderProjectContext(contextFiles);
	// A hidden reader is still reachable through another tool, so skills stay but the hint names no tool.
	// 只把 read/bash 视为技能文件读取能力；as const 保留两个工具名的字面量类型。
	const readers = ["read", "bash"] as const;
	// 先找直接读工具，再判断是否有隐藏但间接可达的读能力。
	const skillFileReadTool =
		// 优先直接 read，其次直接 bash；都没有时才取右侧结果。
		readers.find((tool) => declaredTools.includes(tool)) ??
		// 选中集合仍有隐藏读能力时用 indirect，不在提示词中指名直接工具；全无则 undefined。
		(readers.some((tool) => selectedTools.includes(tool)) ? "indirect" : undefined);
	// 具备读技能能力且有技能目录时才增加技能段。
	if (skillFileReadTool && skills.length > 0) {
		// 只排技能元信息，disableModelInvocation 技能由格式化器过滤，未加载完整正文。
		const skillsPrompt = formatSkillsForPrompt(skills, skillFileReadTool).trim();
		// 过滤后仍非空才写 skills 段。
		if (skillsPrompt) promptSections.skills = skillsPrompt;
	}
	// 仅统一展示分隔符，不在这里改变进程工作目录。
	promptSections.cwd = cwd.replace(/\\/g, "/");
	// 最后遍历自定义段；同名字段覆盖前面内置正文，其他字段按插入顺序追加。
	for (const [name, content] of Object.entries(customSections)) {
		// 只有非空正文才覆盖/新增，空串不会删除已有内置段。
		if (content) promptSections[name] = content;
	}

	// 返回对象先放无标签前言，保证它在所有命名段前。
	const sections: SystemPromptSections = { preamble: promptSections.preamble };
	// 遍历已确定的正文，统一为命名段加标签。
	for (const [name, content] of Object.entries(promptSections)) {
		// 前言保持裸文本，其他段的名称成为标签；正文按原样插入。
		if (name !== "preamble") sections[name] = `<${name}>\n${content}\n</${name}>`;
	}
	// 返回有序段状态，调用方可存入 SystemMessage.sections 以便增量更新。
	return sections;
}

/**
 * The complete prompt state for `input`. A forced prompt is opaque and lives in `content`
 * with no sections; otherwise `content` is empty and the structured sections carry the prompt.
 */
// 构建完整系统状态，输入配置，返回正文和可选 sections；纯计算，不读文件。
// 例如 forceSystemPrompt="" 仍明确强制空正文；未强制时正文为空、实际内容放在结构化段。
export function buildSystemPromptState(input: BuildSystemPromptOptions): {
	// 系统消息的裸正文；强制替换时全部内容放在这里。
	content: string;
	// 非强制模式携带可更新的分段状态，强制模式不返回此字段。
	sections?: SystemPromptSections;
} {
	// 与 truthy 检查不同，空字符串也走完整替换，不构建任何其他段。
	if (input.forceSystemPrompt !== undefined) return { content: input.forceSystemPrompt };
	// 结构化模式使用空裸正文，并附上规范段状态。
	return { content: "", sections: buildSystemPromptSections(input) };
}

/** Build the system prompt text, rendered exactly as the transcript's system message replays it. */
// 把同一系统状态按 transcript 规则渲染成完整文字，输入配置，返回字符串，无副作用。
// 例如调试显示的系统提示词与真正 SystemMessage 重放使用同一个 getSystemMessageText，不另手工连接。
export function buildSystemPrompt(input: BuildSystemPromptOptions): string {
	// 构造临时系统消息交共享渲染器，timestamp=0 只是渲染输入，不追加会话历史。
	return getSystemMessageText({ role: "system", ...buildSystemPromptState(input), timestamp: 0 });
}

/**
 * Diff the sections the model currently has (replayed from the transcript, so never null)
 * against the desired ones. Returns a `SystemMessage.sections` patch, or undefined when
 * nothing changed.
 */
// 计算命名系统段的差异补丁，输入先前状态与新状态，返回变更字典或 undefined，无副作用。
// 例如 rules 改文字就返回新值，旧 skills 消失就返回 skills:null；它只比较完整字符串，不做语义差异或模型摘要。
export function diffSystemPromptSections(
	// 旧状态允许 null 表示先前删除标记；调用者应提供实际重放出的状态。
	previous: Record<string, string | null>,
	// 当前期望的全部命名段，值是完整字符串。
	current: SystemPromptSections,
): Record<string, string | null> | undefined {
	// 补丁中字符串表示设置/替换该段，null 表示删除。
	const patch: Record<string, string | null> = {};
	// 遍历新状态，找新增或文本已变化的键。
	for (const [name, text] of Object.entries(current)) {
		// 严格字符串不相等才加入补丁，没有逐词 diff。
		if (previous[name] !== text) patch[name] = text;
	}
	// 再看旧键，找已从新状态移除的段。
	for (const name of Object.keys(previous)) {
		// 缺失新字段明确写 null，不能只省略否则旧段会继续保留。
		if (current[name] === undefined) patch[name] = null;
	}
	// 无任何变化返回 undefined，调用者可避免追加无意义系统更新。
	return Object.keys(patch).length > 0 ? patch : undefined;
}
