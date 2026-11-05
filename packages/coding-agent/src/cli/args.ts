// 解析 CLI 选项和显示帮助；main 读取结果后才开始装配会话与执行任务。
/**
 * CLI argument parsing and help display
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR } from "../config.ts";
import type { ExtensionFlag } from "../core/extensions/types.ts";
import { getToolListError, type TuiMode } from "../core/settings-manager.ts";

// type 定义类型别名；竖线表示只能取三种字符串之一，不会生成一个运行时枚举对象。
export type Mode = "text" | "json" | "rpc";

// CLI 的结构化解析结果。字段后的 ? 表示可以不提供；接口不会替命令行输入做运行时验证。
export interface Args {
	// 模型供应商的名字，例 openai；只是解析后的选择，不是模型连接本身。
	provider?: string;
	// 用户给出的模型 id 或匹配表达式，后面由模型解析器决定具体模型。
	model?: string;
	// 本次显式提供的认证 key；这里只保存参数，不在此验证或使用凭证。
	apiKey?: string;
	// 替换默认 system 规则的文字或文件参数，具体解析在后续主流程。
	systemPrompt?: string;
	// 附加 system 材料的列表，同一选项可出现多次。
	appendSystemPrompt?: string[];
	// 请求的思考级别；ThinkingLevel 是有限字符串联合类型。
	thinking?: ThinkingLevel;
	// 请求接续当前目录最近的会话，不是在参数解析器里立即恢复。
	continue?: boolean;
	// 请求显示会话选择器，由用户选择要恢复的记录。
	resume?: boolean;
	// 请求输出帮助，由主流程读取此标记后决定是否退出。
	help?: boolean;
	// 请求输出版本号，解析器只记录意图。
	version?: boolean;
	// 输出模式 text/json/rpc；Mode 限定这些合法字符串。
	mode?: Mode;
	// 会话显示名；与保存路径、模型名是不同概念。
	name?: string;
	// 请求临时会话、不保存磁盘日志。
	noSession?: boolean;
	// 要打开的会话路径或 id，后续主流程查找对应记录。
	session?: string;
	// 当前目录内指定的会话 id，后续选择已存在或新建的会话。
	sessionId?: string;
	// 从指定会话建立分支副本的路径或 id。
	fork?: string;
	// 覆盖会话记录的存放/查找目录。
	sessionDir?: string;
	// 用于切换模型的匹配表达式列表，不是已经解析完成的 Model 对象。
	models?: string[];
	// 工具允许列表，或对默认工具列表做 +name/-name 的修饰项。
	tools?: string[];
	// 要禁用的工具名/模式；主流程将其应用在允许列表之后。
	excludeTools?: string[];
	// 默认不启用任何工具，包括内置与扩展；显式工具选择的组合在后续处理。
	noTools?: boolean;
	// 默认禁用内置工具，保留扩展/自定义工具的默认选择。
	noBuiltinTools?: boolean;
	// 显式加载的扩展路径或 builtin: 名称列表。
	extensions?: string[];
	// 禁用扩展自动发现；显式 -e 的处理由后续加载逻辑决定。
	noExtensions?: boolean;
	// 请求禁用内置 MCP 接入，不是删除 MCP 库。
	noMcp?: boolean;
	// 非交互方式处理输入并退出，不进入常驻聊天界面。
	print?: boolean;
	// 待导出的会话文件路径，主流程再执行 HTML 导出。
	export?: string;
	// 禁用技能自动发现。
	noSkills?: boolean;
	// 显式指定的技能文件或目录，可重复提供。
	skills?: string[];
	// 显式提示词模板文件或目录列表。
	promptTemplates?: string[];
	// 禁用提示词模板自动发现。
	noPromptTemplates?: boolean;
	// 显式主题路径列表，用来加载主题，不等于已选定某主题。
	themes?: string[];
	// 本次启动要选择的主题名。
	useTheme?: string;
	// 禁用主题自动发现。
	noThemes?: boolean;
	// 请求不自动加载项目 AGENTS.md/CLAUDE.md。
	noContextFiles?: boolean;
	// true 表示列全部可用模型，字符串表示用该模式筛选；string | true 不接受 false。
	listModels?: string | true;
	// 禁用启动阶段的网络操作，不等于所有后续模型请求都自动变成本地推理。
	offline?: boolean;
	// 终端界面采用 regular 或 fullscreen。
	tuiMode?: TuiMode;
	// 要求详细启动输出，可覆盖安静启动设置。
	verbose?: boolean;
	// 本次是否信任项目文件：true/false 是明确决定，undefined 表示沿用信任流程。
	projectTrustOverride?: boolean;
	// 位置参数形成的用户问题数组，后续按顺序交给会话。
	messages: string[];
	// 去掉 @ 前缀的附带文件路径列表，随后由 file-processor 读取。
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	// 暂存潜在扩展参数的 Map；key 是参数名，value 是字符串或无值开关 true。
	unknownFlags: Map<string, boolean | string>;
	// 解析时累计的 warning/error，留给主流程统一展示和决定是否继续。
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

// as const 将数组元素保持为具体字符串字面量，并在类型层面标为只读；运行时仍是普通数组。
const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * 验证外部字符串是否属于支持的思考级别，并用类型谓词让调用处获得类型收窄。
 * 输入如 "high" 返回 true，"fast" 返回 false；不检查某个具体模型是否支持该级别。
 */
export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	// 真正的成员判断由 includes 执行；as ThinkingLevel 只让类型匹配，不会把任意文字变成合法级别。
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

/**
 * 清理会话显示名，返回有效名字或 undefined；没有 I/O 和会话保存副作用。
 * 例如 "  review  " 变为 "review"，"   " 变为 undefined。
 */
export function normalizeSessionName(value: string): string | undefined {
	// 去掉显示名两端空白；中间的空格保留。
	const name = value.trim();
	// 三元表达式：有实际文字就返回名称，全空白则表示没有名称。
	return name.length > 0 ? name : undefined;
}

/**
 * 将 shell 传来的字符串数组变成结构化 CLI 选项，不在这里读文件、请求模型或恢复会话。
 * 流程：逐词识别开关 → 消费选项值 → 收集问题/@file/潜在扩展参数 → 返回结果与诊断。
 * 例如 ["-p","解释 README","--tools","read,grep"] 会设置 print、messages、tools。
 * 遇到某些非法值会累计 diagnostics；它不是会自动 process.exit 的完整命令执行器。
 */
export function parseArgs(args: string[]): Args {
	// 建立本次解析结果；先初始化必须存在的容器，可选字段按遇到的选项逐步填入。
	const result: Args = {
		// 位置参数形成的用户问题数组，后续按顺序交给会话。
		messages: [],
		// 去掉 @ 前缀的附带文件路径列表，随后由 file-processor 读取。
		fileArgs: [],
		// 暂存潜在扩展参数的 Map；key 是参数名，value 是字符串或无值开关 true。
		unknownFlags: new Map(),
		// 解析时累计的 warning/error，留给主流程统一展示和决定是否继续。
		diagnostics: [],
	};

	// 按位置扫描参数。i 可以在分支中额外前移，用来消费某个选项后面的值。
	for (let i = 0; i < args.length; i++) {
		// 取当前词，例如 --model；shell 已经完成引号分组，这里收到的是字符串数组。
		const arg = args[i];

		// 双短横线结束选项解析；它后面即使以 - 开头也作为位置参数处理。
		if (arg === "--") {
			// 取 -- 后的所有词逐个处理；slice 生成新数组，不修改原 args。
			for (const positionalArg of args.slice(i + 1)) {
				// -- 后依然识别 @file；只有参数选项解析停止，不是所有特殊输入形式都停止。
				if (positionalArg.startsWith("@")) {
					// 移除开头的 @ 再保存路径，例如 @a.md 变成 a.md。
					result.fileArgs.push(positionalArg.slice(1));
				} else {
					// 其余词保留为独立用户输入，支持以短横线开头的问题。
					result.messages.push(positionalArg);
				}
			}
			// 已消费 -- 后所有词，退出外层参数扫描，避免重复处理。
			break;
			// 识别 --help 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--help" || arg === "-h") {
			// 记录明确的 true 标记；这里只保存调用意图。请求输出帮助，由主流程读取此标记后决定是否退出。
			result.help = true;
			// 识别 --version 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--version" || arg === "-v") {
			// 记录明确的 true 标记；这里只保存调用意图。请求输出版本号，解析器只记录意图。
			result.version = true;
			// 识别 --mode 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--mode") {
			// 先查看后一个词，不立刻移动下标，以便确认它是不是合法选项值。
			const mode = args[i + 1];
			// 缺值或下一个又是开关时，给出缺少 mode 的诊断，保留后续开关继续解析。
			if (mode === undefined || mode.startsWith("-")) {
				// 错误写进 diagnostics；解析器不在这里打印/退出。
				result.diagnostics.push({ type: "error", message: "--mode requires text, json, or rpc" });
				// 跳到下一次参数扫描；这是 for 的继续，不是对话的 continue API。
				continue;
			}
			// 消费刚确认属于当前选项的后一个词；for 末尾还会再前移到下一组选项。
			i++;
			// 命令行输入是外部字符串，必须运行时验证；TS 的 Mode 类型不能替用户检查输入。
			if (mode !== "text" && mode !== "json" && mode !== "rpc") {
				// 将多字段诊断对象加入数组，调用方之后统一展示。
				result.diagnostics.push({
					// 错误级诊断通常让调用方拒绝继续，具体策略由主流程决定。
					type: "error",
					// 模板字符串把用户实际输入带入错误信息，帮助定位错误。
					message: `Invalid mode "${mode}". Valid values: text, json, rpc`,
				});
				// 跳到下一次参数扫描；这是 for 的继续，不是对话的 continue API。
				continue;
			}
			// 上面的分支已经排除非法值，TS 也把 mode 收窄为三种合法字符串之一。
			result.mode = mode;
			// 识别 --continue 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--continue" || arg === "-c") {
			// 记录明确的 true 标记；这里只保存调用意图。请求接续当前目录最近的会话，不是在参数解析器里立即恢复。
			result.continue = true;
			// 识别 --resume 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--resume" || arg === "-r") {
			// 记录明确的 true 标记；这里只保存调用意图。请求显示会话选择器，由用户选择要恢复的记录。
			result.resume = true;
			// 识别 --provider 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--provider" && i + 1 < args.length) {
			// 消费紧跟的一个参数值；++i 先移动下标再取值。模型供应商的名字，例 openai；只是解析后的选择，不是模型连接本身。
			result.provider = args[++i];
			// 识别 --model 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--model" && i + 1 < args.length) {
			// 消费紧跟的一个参数值；++i 先移动下标再取值。用户给出的模型 id 或匹配表达式，后面由模型解析器决定具体模型。
			result.model = args[++i];
			// 识别 --api-key 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--api-key" && i + 1 < args.length) {
			// 消费紧跟的一个参数值；++i 先移动下标再取值。本次显式提供的认证 key；这里只保存参数，不在此验证或使用凭证。
			result.apiKey = args[++i];
			// 识别 --system-prompt 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			// 消费紧跟的一个参数值；++i 先移动下标再取值。替换默认 system 规则的文字或文件参数，具体解析在后续主流程。
			result.systemPrompt = args[++i];
			// 识别 --append-system-prompt 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--append-system-prompt" && i + 1 < args.length) {
			// 第一次出现时创建列表；之后复用已有列表，保证可重复追加。
			result.appendSystemPrompt = result.appendSystemPrompt ?? [];
			// ++i 先移动再取值，消费紧跟选项的附加规则，push 保留多次出现的顺序。
			result.appendSystemPrompt.push(args[++i]);
			// 识别 --name 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--name" || arg === "-n") {
			// 检查是否还存在一个值；这个名称分支不额外检查值是否以 - 开头。
			if (i + 1 < args.length) {
				// 消费紧跟的一个参数值；++i 先移动下标再取值。会话显示名；与保存路径、模型名是不同概念。
				result.name = args[++i];
			} else {
				// 缺少名称值时明确记录，而不是默默当作空名称。
				result.diagnostics.push({ type: "error", message: "--name requires a value" });
			}
			// 识别 --no-session 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--no-session") {
			// 记录明确的 true 标记；这里只保存调用意图。请求临时会话、不保存磁盘日志。
			result.noSession = true;
			// 识别 --session 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--session" && i + 1 < args.length) {
			// 消费紧跟的一个参数值；++i 先移动下标再取值。要打开的会话路径或 id，后续主流程查找对应记录。
			result.session = args[++i];
			// 识别 --session-id 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--session-id" && i + 1 < args.length) {
			// 消费紧跟的一个参数值；++i 先移动下标再取值。当前目录内指定的会话 id，后续选择已存在或新建的会话。
			result.sessionId = args[++i];
			// 识别 --fork 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--fork" && i + 1 < args.length) {
			// 消费紧跟的一个参数值；++i 先移动下标再取值。从指定会话建立分支副本的路径或 id。
			result.fork = args[++i];
			// 识别 --session-dir 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--session-dir" && i + 1 < args.length) {
			// 消费紧跟的一个参数值；++i 先移动下标再取值。覆盖会话记录的存放/查找目录。
			result.sessionDir = args[++i];
			// 识别 --models 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--models" && i + 1 < args.length) {
			// 消费模型列表原文，下面继续按逗号拆开和清理。
			result.models = args[++i]
				// 按逗号拆模型匹配模式；shell 引号分组在进入这个解析器前已经完成。
				.split(",")
				// map 将每项替换为去掉两端空白的新字符串。
				.map((s) => s.trim())
				// filter 去掉空项，例如连续逗号产生的空字符串。
				.filter((pattern) => pattern.length > 0);
			// 识别 --no-tools 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--no-tools" || arg === "-nt") {
			// 记录明确的 true 标记；这里只保存调用意图。默认不启用任何工具，包括内置与扩展；显式工具选择的组合在后续处理。
			result.noTools = true;
			// 识别 --no-builtin-tools 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--no-builtin-tools" || arg === "-nbt") {
			// 记录明确的 true 标记；这里只保存调用意图。默认禁用内置工具，保留扩展/自定义工具的默认选择。
			result.noBuiltinTools = true;
		} else if ((arg === "--tools" || arg === "-t") && i + 1 < args.length) {
			// 先消费这组工具选择，确认合法后才写入结果。
			const tools = args[++i]
				// 按逗号拆工具名或修饰项，例如 read,grep 变成两项。
				.split(",")
				// map 将每项替换为去掉两端空白的新字符串。
				.map((s) => s.trim())
				// 移除空工具名，避免把多余逗号误作工具。
				.filter((name) => name.length > 0);
			// 检查工具列表写法，例如不能把普通允许项和 +name/-name 修饰项混用。
			const error = getToolListError(tools);
			// 有明确错误说明就记录诊断，不采用本次 tools 列表。
			if (error) {
				// 同时注明是哪一个开关及其列表规则出错。
				result.diagnostics.push({ type: "error", message: `${arg}: ${error}` });
			} else {
				// 仅在列表语法校验通过后保存；这一步还不检查对应工具最终有没有注册。
				result.tools = tools;
			}
		} else if ((arg === "--exclude-tools" || arg === "-xt") && i + 1 < args.length) {
			// 消费要排除的工具列表，也按逗号拆分、去空白/空项。
			result.excludeTools = args[++i]
				// 按逗号拆待排除的工具名/模式，再清理空白与空项。
				.split(",")
				// map 将每项替换为去掉两端空白的新字符串。
				.map((s) => s.trim())
				// 移除空工具名，避免把多余逗号误作工具。
				.filter((name) => name.length > 0);
			// 识别 --thinking 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--thinking" && i + 1 < args.length) {
			// 消费思考级别字符串，下面通过专门的谓词验证。
			const level = args[++i];
			// 返回类型 level is ThinkingLevel 会让 TS 在真分支认定 level 已是合法联合类型。
			if (isValidThinkingLevel(level)) {
				// 保存请求的级别；实际模型是否支持该级别还要由后续模型逻辑约束。
				result.thinking = level;
			} else {
				// 将多字段诊断对象加入数组，调用方之后统一展示。
				result.diagnostics.push({
					// 非法思考级别在此按 warning 处理，与错误级 mode 诊断不同。
					type: "warning",
					// 列出合法值，调用方可以保留默认级别并展示警告。
					message: `Invalid thinking level "${level}". Valid values: ${VALID_THINKING_LEVELS.join(", ")}`,
				});
			}
			// 识别 --print 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--print" || arg === "-p") {
			// 记录明确的 true 标记；这里只保存调用意图。非交互方式处理输入并退出，不进入常驻聊天界面。
			result.print = true;
			// 预览后一个词以决定它是不是当前选项的值，不在此自动消费。
			const next = args[i + 1];
			// -p 可紧跟一句问题；不吞 @file 或普通开关，同时允许 --- 开头的文字作为问题。
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				// 把紧跟 -p 的文字记成用户消息；接着前移 i，防止后面再次作为位置参数加入。
				result.messages.push(next);
				// 消费刚确认属于当前选项的后一个词；for 末尾还会再前移到下一组选项。
				i++;
			}
			// 识别 --export 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--export" && i + 1 < args.length) {
			// 消费紧跟的一个参数值；++i 先移动下标再取值。待导出的会话文件路径，主流程再执行 HTML 导出。
			result.export = args[++i];
		} else if ((arg === "--extension" || arg === "-e") && i + 1 < args.length) {
			// 第一次显式 -e 时创建扩展列表；以后继续累计。
			result.extensions = result.extensions ?? [];
			// 保存一个扩展来源参数，真正的发现和加载发生在资源层。
			result.extensions.push(args[++i]);
			// 识别 --no-extensions 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--no-extensions" || arg === "-ne") {
			// 记录明确的 true 标记；这里只保存调用意图。禁用扩展自动发现；显式 -e 的处理由后续加载逻辑决定。
			result.noExtensions = true;
			// 识别 --no-mcp 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--no-mcp") {
			// 记录明确的 true 标记；这里只保存调用意图。请求禁用内置 MCP 接入，不是删除 MCP 库。
			result.noMcp = true;
			// 识别 --skill 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--skill" && i + 1 < args.length) {
			// 显式技能可出现多次，先准备累积数组。
			result.skills = result.skills ?? [];
			// 消费并保存这次技能来源，不在这里执行技能正文。
			result.skills.push(args[++i]);
			// 识别 --prompt-template 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--prompt-template" && i + 1 < args.length) {
			// 多个显式模板来源累计在同一数组。
			result.promptTemplates = result.promptTemplates ?? [];
			// 保存模板来源，后续资源加载器负责读取/解析。
			result.promptTemplates.push(args[++i]);
			// 识别 --theme 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--theme" && i + 1 < args.length) {
			// 为多个主题文件准备累积数组。
			result.themes = result.themes ?? [];
			// 保存主题路径，和 --use-theme 选择主题名是两种职责。
			result.themes.push(args[++i]);
			// 识别 --use-theme 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--use-theme") {
			// 查看主题名，需先确认不是缺值或下一个开关。
			const themeName = args[i + 1];
			// 缺少主题名时不吞掉后续开关。
			if (themeName === undefined || themeName.startsWith("-")) {
				// 记录缺少主题名的错误，交给主流程展示。
				result.diagnostics.push({ type: "error", message: "--use-theme requires a theme name" });
			} else {
				// 采用用户指定主题名，再消费一个参数位置。
				result.useTheme = themeName;
				// 消费刚确认属于当前选项的后一个词；for 末尾还会再前移到下一组选项。
				i++;
			}
			// 识别 --no-skills 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--no-skills" || arg === "-ns") {
			// 记录明确的 true 标记；这里只保存调用意图。禁用技能自动发现。
			result.noSkills = true;
			// 识别 --no-prompt-templates 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--no-prompt-templates" || arg === "-np") {
			// 记录明确的 true 标记；这里只保存调用意图。禁用提示词模板自动发现。
			result.noPromptTemplates = true;
			// 识别 --no-themes 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--no-themes") {
			// 记录明确的 true 标记；这里只保存调用意图。禁用主题自动发现。
			result.noThemes = true;
			// 识别 --no-context-files 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--no-context-files" || arg === "-nc") {
			// 记录明确的 true 标记；这里只保存调用意图。请求不自动加载项目 AGENTS.md/CLAUDE.md。
			result.noContextFiles = true;
			// 识别 --list-models 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--list-models") {
			// Check if next arg is a search pattern (not a flag or file arg)
			// --list-models 的搜索词可省略；后一个若是开关/@file，就不要吞掉它。
			if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
				// 消费搜索词字符串；++i 先移动下标再取值，后续只列匹配的可用模型。
				result.listModels = args[++i];
			} else {
				// 无搜索词时使用字面量 true，表示列全部可用模型；此类型不使用 false 表示另一种模式。
				result.listModels = true;
			}
			// 识别 --tui-mode 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--tui-mode") {
			// 先查看后一个词，不立刻移动下标，以便确认它是不是合法选项值。
			const mode = args[i + 1];
			// TUI 模式只允许这两种值，运行时确认后类型也随之收窄。
			if (mode === "regular" || mode === "fullscreen") {
				// 保存终端布局模式，不要与 text/json/rpc 的输出模式混淆。
				result.tuiMode = mode;
				// 消费刚确认属于当前选项的后一个词；for 末尾还会再前移到下一组选项。
				i++;
				// 没有 TUI 值时只记录错误，留待下一轮解析后续开关。
			} else if (mode === undefined || mode.startsWith("-")) {
				// 缺值诊断明确提示两种合法模式。
				result.diagnostics.push({ type: "error", message: "--tui-mode requires regular or fullscreen" });
			} else {
				// 消费刚确认属于当前选项的后一个词；for 末尾还会再前移到下一组选项。
				i++;
				// 将多字段诊断对象加入数组，调用方之后统一展示。
				result.diagnostics.push({
					// 错误级诊断通常让调用方拒绝继续，具体策略由主流程决定。
					type: "error",
					// 用户给了一个不合法的值时，指出具体输入。
					message: `Invalid TUI mode "${mode}". Valid values: regular, fullscreen`,
				});
			}
			// 识别 --verbose 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--verbose") {
			// 记录明确的 true 标记；这里只保存调用意图。要求详细启动输出，可覆盖安静启动设置。
			result.verbose = true;
			// 识别 --approve 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--approve" || arg === "-a") {
			// 记录明确的 true 标记；这里只保存调用意图。本次是否信任项目文件：true/false 是明确决定，undefined 表示沿用信任流程。
			result.projectTrustOverride = true;
			// 识别 --no-approve 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--no-approve" || arg === "-na") {
			// 记录明确的 false 标记；这里只保存调用意图。本次是否信任项目文件：true/false 是明确决定，undefined 表示沿用信任流程。
			result.projectTrustOverride = false;
			// 识别 --offline 分支；仅匹配这里列出的开关写法，再按本分支消费值或设置标记。
		} else if (arg === "--offline") {
			// 记录明确的 true 标记；这里只保存调用意图。禁用启动阶段的网络操作，不等于所有后续模型请求都自动变成本地推理。
			result.offline = true;
		} else if (arg.startsWith("@")) {
			// 一般位置的 @file 也去掉 @ 后保存；文件读取稍后统一执行。
			result.fileArgs.push(arg.slice(1)); // Remove @ prefix
		} else if (arg.startsWith("--")) {
			// 未知长选项可能写成 --name=value，先找等号位置；没有则返回 -1。
			const eqIndex = arg.indexOf("=");
			// 带等号的参数不用再消费下一个词。
			if (eqIndex !== -1) {
				// 把 --name=value 拆成 Map 中的 name→value，去掉前导 --。
				result.unknownFlags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
			} else {
				// 无等号时只去掉 --，得到潜在扩展参数的名字。
				const flagName = arg.slice(2);
				// 预览后一个词以决定它是不是当前选项的值，不在此自动消费。
				const next = args[i + 1];
				// 把普通后续词当该未知选项的值；开关/@file 留给外层，不消费。
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					// 保存带值扩展参数；扩展后续负责声明/解释它是否有效。
					result.unknownFlags.set(flagName, next);
					// 消费刚确认属于当前选项的后一个词；for 末尾还会再前移到下一组选项。
					i++;
				} else {
					// 没有跟值的长选项以 true 表示布尔开关，不用字符串 "true"。
					result.unknownFlags.set(flagName, true);
				}
			}
		} else if (arg.startsWith("-") && !arg.startsWith("--")) {
			// 未知短选项不当作扩展长参数，直接记录错误。
			result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
		} else if (!arg.startsWith("-")) {
			// 普通位置词成为一条用户消息；多条消息在之后按顺序运行。
			result.messages.push(arg);
		}
	}

	// 返回累计的值和诊断；调用方再决定模式、读取文件以及启动会话。
	return result;
}

/**
 * 打印主命令的帮助文字，附加扩展注册的参数说明；返回 void，副作用是写 stdout。
 * 例如扩展声明 plan:boolean，会在 Extension CLI Flags 中出现 --plan。
 * 下面的大段模板字符串就是用户实际看到的帮助，不能往字符串行内插入源码注释。
 */
export function printHelp(extensionFlags?: ExtensionFlag[]): void {
	// 先拼可选的扩展参数段落，再插入下面固定帮助正文；没有扩展参数时使用空字符串。
	const extensionFlagsText =
		// && 短路求值：参数存在且非空才计算右侧模板。
		extensionFlags && extensionFlags.length > 0
			? `\n${chalk.bold("Extension CLI Flags:")}\n${extensionFlags
					// 每个扩展参数变成一行帮助，随后用换行连接。
					.map((flag) => {
						// 字符串参数需要值，占位写成 <value>；布尔参数只显示开关名。
						const value = flag.type === "string" ? " <value>" : "";
						// 扩展未提供说明时，用来源路径说明这个参数在哪里注册。
						const description = flag.description ?? `Registered by ${flag.extensionPath}`;
						// padEnd 补空格到至少 30 个字符，将说明列大致对齐；不截断长名称。
						return `  --${flag.name}${value}`.padEnd(30) + description;
					})
					.join("\n")}\n`
			: "";
	// 模板中的 ${...} 会在运行时求值；其余行是帮助正文，保持原内容避免改变 CLI 输出。
	console.log(`${chalk.bold(APP_NAME)} - AI coding assistant with read, bash, edit, write tools

${chalk.bold("Usage:")}
  ${APP_NAME} [options] [--] [@files...] [messages...]

${chalk.bold("Commands:")}
  ${APP_NAME} install <source> [-l]     Install extension source and add to settings
  ${APP_NAME} remove <source> [-l]      Remove extension source from settings
  ${APP_NAME} uninstall <source> [-l]   Alias for remove
  ${APP_NAME} update [source|self|pi]   Update pi, extensions, or model catalogs
  ${APP_NAME} list                      List installed extensions from settings
  ${APP_NAME} config [-l]               Open TUI to enable/disable package resources (Tab switches scope)
  ${APP_NAME} auth <command>            Print credentials or check provider readiness
  ${APP_NAME} mcp <command>             Manage MCP servers
  ${APP_NAME} <command> --help          Show help for install/remove/uninstall/update/list/config/auth/mcp

${chalk.bold("Options:")}
  --provider <name>              Provider to search for --model (requires --model)
  --model <pattern>              Model pattern or ID (supports "provider/id" and optional ":<thinking>")
  --api-key <key>                API key (defaults to env vars)
  --system-prompt <text>         System prompt (default: coding assistant prompt)
  --append-system-prompt <text>  Append text or file contents to the system prompt (can be used multiple times)
  --mode <mode>                  Output mode: text (default), json, or rpc
  --print, -p                    Non-interactive mode: process prompt and exit
  --continue, -c                 Continue the most recent session for the current directory
  --resume, -r                   Pick a session to resume
  --session <path|id>            Open a session by file path or full/partial ID
  --session-id <id>              Use the current directory's existing session with the ID, creating it otherwise
  --fork <path|id>               Fork a session by file path or full/partial ID into the current directory
  --session-dir <dir>            Directory for session storage and lookup
  --no-session                   Don't save session (ephemeral)
  --name, -n <name>              Set session display name
  --models <patterns>            Comma-separated model patterns for Ctrl+P cycling
                                 Supports globs (anthropic/*, *sonnet*) and fuzzy matching
  --no-tools, -nt                Disable all tools by default (built-in and extension)
  --no-builtin-tools, -nbt       Disable built-in tools by default but keep extension/custom tools enabled
  --tools, -t <tools>            Comma-separated allowlist of tool names or patterns (*) to enable
                                 Keeps MCP tools unless an entry starts with mcp__
                                 Only +name/-name entries add to or remove from the defaults
  --exclude-tools, -xt <tools>   Comma-separated denylist of tool names or patterns (*) to disable
                                 Applies to all tools, MCP tools included
  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh, max
  --extension, -e <path>         Load an extension file or builtin:<name> (can be used multiple times)
  --no-extensions, -ne           Disable extension discovery and built-in extensions (explicit -e paths still work)
  --no-mcp                       Disable built-in MCP support: no servers connect and no MCP tools
  --skill <path>                 Load a skill file or directory (can be used multiple times)
  --no-skills, -ns               Disable skills discovery and loading
  --prompt-template <path>       Load a prompt template file or directory (can be used multiple times)
  --no-prompt-templates, -np     Disable prompt template discovery and loading
  --theme <path>                 Load a theme file or directory (can be used multiple times)
  --use-theme <name[/name]>      Set the initial interactive theme for this run
  --no-themes                    Disable theme discovery and loading
  --no-context-files, -nc        Disable AGENTS.md and CLAUDE.md discovery and loading
  --export <file> [output]       Export session file to HTML and exit
  --list-models [search]         List available models (with optional fuzzy search)
  --verbose                      Force verbose startup (overrides quietStartup setting)
  --tui-mode <mode>              TUI mode: fullscreen (default) or regular
  --approve, -a                  Trust project-local files for this run
  --no-approve, -na              Ignore project-local files for this run
  --offline                      Disable startup network operations (same as PI_OFFLINE=1)
  --                             End option parsing; treat remaining arguments as messages/files
  --help, -h                     Show this help
  --version, -v                  Show version number

Extensions can register additional flags (e.g., --plan from plan-mode extension).${extensionFlagsText}

${chalk.bold("Examples:")}
  # Print a provider API key for an external client
  ${APP_NAME} auth print-api-key --provider openai

  # Print an OAuth bearer token for an external client (refreshes if expired)
  ${APP_NAME} auth print-bearer-token --provider openai-codex

  # Interactive mode
  ${APP_NAME}

  # Interactive mode with initial prompt
  ${APP_NAME} "List all .ts files in src/"

  # Include files in initial message
  ${APP_NAME} @prompt.md @image.png "What color is the sky?"

  # Non-interactive mode (process and exit)
  ${APP_NAME} -p "List all .ts files in src/"

  # Prompt beginning with a dash
  ${APP_NAME} -p -- "- Summarize these points"

  # Multiple messages (interactive)
  ${APP_NAME} "Read package.json" "What dependencies do we have?"

  # Continue previous session
  ${APP_NAME} --continue "What did we discuss?"

  # Start a named session
  ${APP_NAME} --name "Refactor auth module"

  # Use different model
  ${APP_NAME} --provider openai --model gpt-4o-mini "Help me refactor this code"

  # Use model with provider prefix (no --provider needed)
  ${APP_NAME} --model openai/gpt-4o "Help me refactor this code"

  # Use model with thinking level shorthand
  ${APP_NAME} --model sonnet:high "Solve this complex problem"

  # Limit model cycling to specific models
  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o

  # Limit to a specific provider with glob pattern
  ${APP_NAME} --models "github-copilot/*"

  # Cycle models with fixed thinking levels
  ${APP_NAME} --models sonnet:high,haiku:low

  # Start with a specific thinking level
  ${APP_NAME} --thinking high "Solve this complex problem"

  # Read-only mode (no file modifications possible)
  ${APP_NAME} --tools read,grep,find,ls -p "Review the code in src/"

  # Add codemode to the default tools
  ${APP_NAME} --tools +codemode

  # Codemode with only the tools of one MCP server
  ${APP_NAME} --tools read,bash,codemode,'mcp__radius__*'

  # Disable one tool while keeping the rest available
  ${APP_NAME} --exclude-tools ask_question

  # Export a session file to HTML
  ${APP_NAME} --export ~/${CONFIG_DIR_NAME}/agent/sessions/--path--/session.jsonl
  ${APP_NAME} --export session.jsonl output.html

${chalk.bold("Environment Variables:")}
  ANTHROPIC_AUTH_TOKEN             - Anthropic bearer auth token
  ANTHROPIC_API_KEY                - Anthropic Claude API key
  ANTHROPIC_OAUTH_TOKEN            - Anthropic OAuth token (alternative to API key)
  ANT_LING_API_KEY                 - Ant Ling API key
  OPENAI_API_KEY                   - OpenAI GPT API key
  AZURE_OPENAI_API_KEY             - Azure OpenAI API key
  AZURE_OPENAI_BASE_URL            - Azure OpenAI/Cognitive Services base URL (e.g. https://{resource}.openai.azure.com)
  AZURE_OPENAI_RESOURCE_NAME       - Azure OpenAI resource name (alternative to base URL)
  AZURE_OPENAI_API_VERSION         - Azure OpenAI API version (default: v1)
  AZURE_OPENAI_DEPLOYMENT_NAME_MAP - Azure OpenAI model=deployment map (comma-separated)
  DEEPSEEK_API_KEY                 - DeepSeek API key
  NVIDIA_API_KEY                   - NVIDIA NIM API key
  GEMINI_API_KEY                   - Google Gemini API key
  GROQ_API_KEY                     - Groq API key
  CEREBRAS_API_KEY                 - Cerebras API key
  XAI_API_KEY                      - xAI Grok API key
  FIREWORKS_API_KEY                - Fireworks API key
  TOGETHER_API_KEY                 - Together AI API key
  BASETEN_API_KEY                  - Baseten API key
  OPENROUTER_API_KEY               - OpenRouter API key
  AI_GATEWAY_API_KEY               - Vercel AI Gateway API key
  ZAI_API_KEY                      - ZAI Coding Plan API key (Global)
  ZAI_CODING_CN_API_KEY            - ZAI Coding Plan API key (China)
  MISTRAL_API_KEY                  - Mistral API key
  MINIMAX_API_KEY                  - MiniMax API key
  MOONSHOT_API_KEY                 - Moonshot AI API key
  OPENCODE_API_KEY                 - OpenCode Zen/OpenCode Go API key
  KIMI_API_KEY                     - Kimi For Coding API key
  META_API_KEY                     - Meta Model API key
  CLOUDFLARE_API_KEY               - Cloudflare API token (Workers AI and AI Gateway)
  CLOUDFLARE_ACCOUNT_ID            - Cloudflare account id (required for both)
  CLOUDFLARE_GATEWAY_ID            - Cloudflare AI Gateway slug (required for AI Gateway)
  QWEN_TOKEN_PLAN_API_KEY          - Qwen Token Plan API key (international region)
  QWEN_TOKEN_PLAN_CN_API_KEY       - Qwen Token Plan API key (China region)
  XIAOMI_API_KEY                   - Xiaomi MiMo API key (api.xiaomimimo.com billing)
  XIAOMI_TOKEN_PLAN_CN_API_KEY     - Xiaomi MiMo Token Plan API key (China region)
  XIAOMI_TOKEN_PLAN_AMS_API_KEY    - Xiaomi MiMo Token Plan API key (Amsterdam region)
  XIAOMI_TOKEN_PLAN_SGP_API_KEY    - Xiaomi MiMo Token Plan API key (Singapore region)
  AWS_PROFILE                      - AWS profile for Amazon Bedrock
  AWS_ACCESS_KEY_ID                - AWS access key for Amazon Bedrock
  AWS_SECRET_ACCESS_KEY            - AWS secret key for Amazon Bedrock
  AWS_BEARER_TOKEN_BEDROCK         - Bedrock API key (bearer token)
  AWS_REGION                       - AWS region for Amazon Bedrock (e.g., us-east-1)
  ${ENV_AGENT_DIR.padEnd(32)} - Config directory (default: ~/${CONFIG_DIR_NAME}/agent)
  ${ENV_SESSION_DIR.padEnd(32)} - Session storage directory (overridden by --session-dir)
  PI_PACKAGE_DIR                   - Override package directory (for Nix/Guix store paths)
  PI_OFFLINE                       - Disable startup network operations when set to 1/true/yes
  PI_SELF_UPDATE_COMMAND           - Command pi update runs to update pi itself ({packageName}, {version}, {installSpec})
  PI_TELEMETRY                     - Override install telemetry when set to 1/true/yes or 0/false/no
  PI_SHARE_VIEWER_URL              - Base URL for /share command (default: https://pi.dev/session/)

${chalk.bold("Built-in Tool Names:")}
  read       - Read file contents
  bash       - Execute bash commands
  powershell - Execute PowerShell commands on Windows
  edit       - Edit files with find/replace
  write      - Write files (creates/overwrites)
  grep       - Search file contents (read-only, off by default)
  find       - Find files by glob pattern (read-only, off by default)
  ls         - List directory contents (read-only, off by default)
`);
}
