// 提示词模板的文件发现、Markdown/YAML 解析和 /命令 参数展开；ResourceLoader 负责主加载顺序与最终名称去重。
// 模板正文加载时读入，参数调用时才替换；整个模块不调用模型，也不执行正文或 shell。
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join, resolve, sep } from "path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";

/**
 * Represents a prompt template loaded from a markdown file
 */
// 一个已读入的 Markdown 提示词模板；它保存正文，不会在加载时替换参数或调用模型。
export interface PromptTemplate {
	// 命令名来自文件名去掉 .md，例如 review.md 对应 /review。
	name: string;
	// 供命令列表展示的描述，优先 frontmatter.description，否则取正文首个非空行的前60字符。
	description: string;
	// 可选 argument-hint 元数据，用于界面提示参数，不改变参数解析语法。
	argumentHint?: string;
	// 去掉 YAML 头后的模板正文；参数占位符等到 expandPromptTemplate 时才替换。
	content: string;
	// 资源来源元信息，用于展示/追踪；标为 project 或 user 不等于在此进行了信任授权。
	sourceInfo: SourceInfo;
	// 模板绝对路径，供冲突诊断、来源展示；正文不是通过 filePath 延迟读取的。
	filePath: string; // Absolute path to the template file
}

/**
 * Parse command arguments respecting quoted strings (bash-style)
 * Returns array of arguments
 */
// 按空白和成对单双引号拆命令参数，输入参数尾串，返回字符串数组，不运行 shell。
// 例如 a "b c" "" 得到 [a,b c,空串]；引号本身去掉，未闭合引号会把剩余文字归入该参数，不报错。
// 它只是简化的 bash 风格引号处理，没有 shell 的变量展开、命令替换或反斜杠转义解释。
export function parseCommandArgs(argsString: string): string[] {
	// 依次收集完整参数，string[] 在开发期约束每项是字符串。
	const args: string[] = [];
	// 保存当前参数累计文字，引号内空格也加入这里。
	let current = "";
	// Tracks whether a token has started, so quoted empty strings ("" or '') are kept as arguments
	// 区分“尚无参数”和“已出现空引号参数”，从而保留显式空字符串。
	let hasToken = false;
	// 记录当前是单引号、双引号还是不在引号中；联合类型允许 null 状态。
	let inQuote: string | null = null;

	// 逐字符扫描，不委托 shell 或第三方命令解析器。
	for (let i = 0; i < argsString.length; i++) {
		// 取当前字符，后面依据引号状态判断其含义。
		const char = argsString[i];

		// 引号内只识别相同结束引号，其他字符含空白原样进入参数。
		if (inQuote) {
			// 只有与开头相同的引号才结束当前引用，另一种引号被当正文。
			if (char === inQuote) {
				// 离开引号模式，不把结束引号加入结果。
				inQuote = null;
			} else {
				// 把当前字符加到该参数正文，不进行变量或占位符解释。
				current += char;
			}
			// 非引用状态遇到单双引号就进入相应引用模式。
		} else if (char === '"' || char === "'") {
			// 记住这次引用的结束符类型。
			inQuote = char;
			// 即使当前文字为空也已开始一个参数，确保 "" 不丢失。
			hasToken = true;
			// 非引用状态的空白才分隔参数；正则包括空格、制表、换行等。
		} else if (/\s/.test(char)) {
			// 只有真正开始过参数才输出，连续空白不制造额外空参数。
			if (hasToken) {
				// 把当前参数（允许显式空串）加入结果，保持输入顺序。
				args.push(current);
				// 当前参数已结束，清空文字准备下一个。
				current = "";
				// 回到尚未开始参数的状态，连续空白只跳过。
				hasToken = false;
			}
		} else {
			// 把当前字符加到该参数正文，不进行变量或占位符解释。
			current += char;
			// 即使当前文字为空也已开始一个参数，确保 "" 不丢失。
			hasToken = true;
		}
	}

	// 只有真正开始过参数才输出，连续空白不制造额外空参数。
	if (hasToken) {
		// 把当前参数（允许显式空串）加入结果，保持输入顺序。
		args.push(current);
	}

	// 返回拆分结果；字符串里的占位符留给模板替换层处理。
	return args;
}

/**
 * Substitute argument placeholders in template content
 * Supports:
 * - $1, $2, ... for positional args
 * - $@ and $ARGUMENTS for all args
 * - ${N:-default} for positional arg N with default when missing/empty
 * - ${@:-default} and ${ARGUMENTS:-default} for all args with a default when empty
 * - ${@:N} for args from Nth onwards (bash-style slicing)
 * - ${@:N:L} for L args starting from Nth
 *
 * Note: Replacement happens on the template string only. Argument and default values
 * containing patterns like $1, $@, or $ARGUMENTS are NOT recursively substituted.
 */
// 一次性替换模板里的位置/全部参数/默认值/切片占位符，返回新正文，不修改模板或参数。
// 例如 content="看 $1：${2:-无}"、args=[a] 得到“看 a：无”；${@:2:2} 取第2、3参数。
// 只扫描原模板一次，参数或默认文字里再含 $1 不会递归替换；这是字符串替换，不执行 shell。
export function substituteArgs(content: string, args: string[]): string {
	// 所有参数用空格拼接；拆参时的原始引号和多重空格不会恢复。
	const allArgs = args.join(" ");

	// 对原模板执行一次全局正则替换，每个匹配交下面回调生成文字。
	return content.replace(
		// 正则三个分支分别捕获带默认值、参数切片、简写位置/全部参数；g 表示替换所有匹配。
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		// replace 的捕获组按顺序成为回调参数；不同语法只填对应的那几组。
		(_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
			// 先处理 ${N:-默认值} 或全部参数带默认值形式。
			if (defaultTarget) {
				// 下面三元式区分全部参数与单个从1开始的位置参数。
				const value =
					// @/ARGUMENTS 取拼接串，数字以十进制解析后减1映射到数组下标。
					defaultTarget === "@" || defaultTarget === "ARGUMENTS" ? allArgs : args[parseInt(defaultTarget, 10) - 1];
				// 缺参或显式空串都采用默认文字；这里用 truthy，而不是仅对 undefined 回退。
				return value ? value : defaultValue;
			}

			// 切片形式按用户从1开始的位置取参数，允许可选长度。
			if (sliceStart) {
				// 将文本中的位置转为数组从0开始下标，let 允许下一步修正0位置。
				let start = parseInt(sliceStart, 10) - 1; // Convert to 0-indexed (user provides 1-indexed)
				// Treat 0 as 1 (bash convention: args start at 1)
				// 用户写 ${@:0} 时按从第1个参数开始处理。
				if (start < 0) start = 0;

				// 指定长度时，切片结束位置由起点加长度确定；捕获值是字符串，"0" 也会进入。
				if (sliceLength) {
					// 显式十进制解析参数个数，不把它当字符长度。
					const length = parseInt(sliceLength, 10);
					// slice 不修改原数组，结束下标不包含；选中的参数重新用空格连接。
					return args.slice(start, start + length).join(" ");
				}
				// 没写长度就取起点到末尾的所有参数。
				return args.slice(start).join(" ");
			}

			// 处理不带默认值/切片的全部参数简写。
			if (simple === "ARGUMENTS" || simple === "@") {
				// 返回预先拼接的全部参数，避免每个占位符重复 join。
				return allArgs;
			}

			// 剩余简写只可能是数字位置，将 $1 映射到 args[0]。
			const index = parseInt(simple, 10) - 1;
			// 不存在的位置变为空串；显式空参也保持为空，不报错。
			return args[index] ?? "";
		},
	);
}

// 同步读一份模板并解析 YAML 头，输入文件路径和来源元数据，返回模板或 null 及诊断。
// 例如 description 缺失就用正文首行摘要，argument-hint 只接受字符串；读/解析错误转 warning，不执行正文或替换参数。
// 文件名决定命令名；YAML 解析成功不代表所有字段都经过 schema 验证。
function loadTemplateFromFile(
	filePath: string,
	sourceInfo: SourceInfo,
): { template: PromptTemplate | null; diagnostics: ResourceDiagnostic[] } {
	// 收集本次加载的警告或上层汇总的资源诊断，不直接终止全部加载。
	const diagnostics: ResourceDiagnostic[] = [];
	// 先声明原始文件文字，读取成功后再解析。
	let rawContent: string;
	try {
		// 同步读取完整 Markdown，失败进入 catch 并返回可汇总 warning。
		rawContent = readFileSync(filePath, "utf-8");
	} catch (error) {
		// 外部 I/O 异常不保证是 Error，使用 instanceof 取真实信息，否则用固定说明。
		const message = error instanceof Error ? error.message : "failed to read prompt template file";
		// 保留失败说明及来源路径，供资源加载界面展示。
		diagnostics.push({ type: "warning", message, path: filePath });
		// 这份模板不可用，但诊断交给调用方继续处理其他模板。
		return { template: null, diagnostics };
	}

	// YAML 元数据的值先视作 unknown，读取描述/参数提示时再判断真实类型。
	let frontmatter: Record<string, unknown>;
	// 保存去掉 YAML 头的正文，不在这里做模型总结。
	let body: string;
	try {
		// 对象解构赋值需要外层括号，避免被解析为代码块；解析器也规范 BOM/换行。
		({ frontmatter, body } = parseFrontmatter(rawContent));
	} catch (error) {
		// YAML 语法错误转成 warning，这个类型断言/解析过程不是模板执行。
		const message = error instanceof Error ? error.message : "failed to parse prompt template file";
		// 保留失败说明及来源路径，供资源加载界面展示。
		diagnostics.push({ type: "warning", message, path: filePath });
		// 这份模板不可用，但诊断交给调用方继续处理其他模板。
		return { template: null, diagnostics };
	}

	// 仅移除结尾 .md，命令名不取 frontmatter.name。
	const name = basename(filePath).replace(/\.md$/, "");

	// Get description from frontmatter or first non-empty line
	// 在外部 YAML 数据边界确认 description 是字符串，其他类型视为未提供。
	let description = typeof frontmatter.description === "string" ? frontmatter.description : "";
	// 缺描述或空串时才从正文第一条非空行生成预览。
	if (!description) {
		// 按行找首个修剪后非空者；保留的仍是该行原文本，不解析 Markdown 标题。
		const firstLine = body.split("\n").find((line) => line.trim());
		// 正文确实有非空行才生成描述，否则描述保持空串。
		if (firstLine) {
			// Truncate if too long
			// 本地字符截短用于列表预览，不是模型语义摘要。
			description = firstLine.slice(0, 60);
			// 只有真的被截短才附上省略标记，最终描述可能超过60字符。
			if (firstLine.length > 60) description += "...";
		}
	}

	// 带横线键使用方括号访问；只接受字符串，不用它限制实际参数数量。
	const argumentHint = typeof frontmatter["argument-hint"] === "string" ? frontmatter["argument-hint"] : undefined;
	return {
		// 成功结果里的模板对象，外层另带诊断数组。
		template: {
			name,
			description,
			// 条件对象展开，有非空参数提示才添加该字段。
			...(argumentHint && { argumentHint }),
			// 只保存去掉头部后的正文，$1 等占位符保持原样，等调用时展开。
			content: body,
			sourceInfo,
			filePath,
		},
		diagnostics,
	};
}

/**
 * Scan a directory for .md files (non-recursive) and load them as prompt templates.
 */
// 非递归扫描一个目录的直接 .md 文件，输入目录和来源回调，返回模板与诊断集合。
// 例如 prompts/review.md 会读入，prompts/sub/review.md 不自动递归；符号链接仅跟随到文件，坏链接跳过。
// 目录不可读时返回已经收集的结果，不抛给所有资源加载。
function loadTemplatesFromDir(dir: string, getSourceInfo: (filePath: string) => SourceInfo): LoadPromptTemplatesResult {
	// 依发现顺序收集模板，此层不按名称去重或排序。
	const templates: PromptTemplate[] = [];
	// 收集本次加载的警告或上层汇总的资源诊断，不直接终止全部加载。
	const diagnostics: ResourceDiagnostic[] = [];

	// 目录不存在视为空集合，不为默认可选目录制造警告。
	if (!existsSync(dir)) {
		// 返回已收集模板与诊断；目录出错时也可能是部分结果。
		return { templates, diagnostics };
	}

	try {
		// 取 Dirent 判断文件/链接类型，避免为每个普通文件再 stat。
		const entries = readdirSync(dir, { withFileTypes: true });

		// 按文件系统返回顺序扫描直接子项，没有承诺字典排序。
		for (const entry of entries) {
			// 拼出当前候选完整路径，尚未确认它可作为模板。
			const fullPath = join(dir, entry.name);

			// For symlinks, check if they point to a file
			// 普通文件可直接识别，let 允许链接分支覆盖结果。
			let isFile = entry.isFile();
			// 链接需要 stat 跟随目标，Dirent 本身只说明它是链接。
			if (entry.isSymbolicLink()) {
				try {
					// 读取链接目标属性，坏链接会抛出并跳过。
					const stats = statSync(fullPath);
					// 只有目标为普通文件才可作为 Markdown 模板。
					isFile = stats.isFile();
				} catch {
					// Broken symlink, skip it
					continue;
				}
			}

			// 仅加载小写 .md 后缀文件，不把目录或任意其他扩展名当模板。
			if (isFile && entry.name.endsWith(".md")) {
				// 先用回调生成来源，再读文件/解析头；同目录各模板有独立结果。
				const result = loadTemplateFromFile(fullPath, getSourceInfo(fullPath));
				// 只有成功解析结果才加入模板列表。
				if (result.template) {
					// 保留模板对象供后续命令展开，未在此消除同名冲突。
					templates.push(result.template);
				}
				// ... 将该次加载诊断逐条汇入集合，而非嵌套成数组。
				diagnostics.push(...result.diagnostics);
			}
		}
	} catch {
		// 返回已收集模板与诊断；目录出错时也可能是部分结果。
		return { templates, diagnostics };
	}

	// 返回已收集模板与诊断；目录出错时也可能是部分结果。
	return { templates, diagnostics };
}

// 模板发现选项；全局/项目默认目录可关闭，显式路径仍单独处理。
export interface LoadPromptTemplatesOptions {
	/** Working directory for project-local templates. */
	// 项目工作目录，显式相对路径以此为基准。
	cwd: string;
	/** Agent config directory for global templates. */
	// 用户级 agent 数据目录，全局模板位于其 prompts 子目录。
	agentDir: string;
	/** Explicit prompt template paths (files or directories). */
	// 显式模板文件/目录路径；可以来自 CLI、设置或上层包资源解析。
	promptPaths: string[];
	/** Include default prompt directories. */
	// 是否扫描 agentDir/prompts 与 cwd/.pi/prompts；不是安全/信任判定。
	includeDefaults: boolean;
}

// 加载结果保留全部成功模板及诊断；名称冲突通常由 ResourceLoader 再统一处理。
export interface LoadPromptTemplatesResult {
	// 按加载顺序返回的模板对象数组，可含同名项。
	templates: PromptTemplate[];
	// 警告或冲突等资源诊断，加载代码使用 warning 汇报单文件失败。
	diagnostics: ResourceDiagnostic[];
}

/**
 * Load all prompt templates from:
 * 1. Global: agentDir/prompts/
 * 2. Project: cwd/{CONFIG_DIR_NAME}/prompts/
 * 3. Explicit prompt paths
 */
// 加载默认目录及显式模板，输入选项，返回全部成功项/诊断，不生成模型请求。
// 本独立函数顺序为全局→项目→显式，且不按名字去重；例如同名模板可全部返回，expand 的 find 会取首项。
// 主 ResourceLoader 关闭这里的默认扫描，使用包管理器排好的路径并去重，不能把本函数顺序当整个产品永远的覆盖规则。
export function loadPromptTemplates(options: LoadPromptTemplatesOptions): LoadPromptTemplatesResult {
	// 规范为绝对工作目录，作为显式相对路径解析基准。
	const resolvedCwd = resolvePath(options.cwd);
	// 规范用户配置目录，不在这里创建目录。
	const resolvedAgentDir = resolvePath(options.agentDir);
	// 读取显式路径列表，本函数不会改原数组。
	const promptPaths = options.promptPaths;
	// 保存是否启用默认目录的开关。
	const includeDefaults = options.includeDefaults;

	// 依发现顺序收集模板，此层不按名称去重或排序。
	const templates: PromptTemplate[] = [];
	// 收集本次加载的警告或上层汇总的资源诊断，不直接终止全部加载。
	const diagnostics: ResourceDiagnostic[] = [];
	// 局部汇总回调原地追加模板/诊断，不判定名字冲突，也无返回值。
	const addResult = (result: LoadPromptTemplatesResult): void => {
		// 展开本批模板，保持各批次及内部原有顺序。
		templates.push(...result.templates);
		// ... 将该次加载诊断逐条汇入集合，而非嵌套成数组。
		diagnostics.push(...result.diagnostics);
	};

	// 用户级默认模板目录，不需要与当前项目处于同一路径。
	const globalPromptsDir = join(resolvedAgentDir, "prompts");
	// 项目默认模板目录为工作目录下配置子目录的 prompts。
	const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");

	// 局部路径归属判断按字符串边界比较，不跟随符号链接，也不判断项目是否可信。
	const isUnderPath = (target: string, root: string): boolean => {
		// 先把根路径转绝对形式，供相等和前缀判断。
		const normalizedRoot = resolve(root);
		// 根目录本身也属于该资源根。
		if (target === normalizedRoot) {
			// 命中同一根路径，直接返回归属成立。
			return true;
		}
		// 补目录分隔符，避免 /a/prompts-other 被误认为 /a/prompts 的子路径。
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		// 比较带分隔符前缀；这里不是平台大小写折叠的 pathsEqual。
		return target.startsWith(prefix);
	};

	// 按资源位置创建来源标签，返回 SourceInfo，不授予运行权限或决定覆盖顺序。
	const getSourceInfo = (resolvedPath: string): SourceInfo => {
		// 落在用户默认根的资源标为 user。
		if (isUnderPath(resolvedPath, globalPromptsDir)) {
			// 用来源构造器补 scope/origin 等默认字段，不读取模板正文。
			return createSyntheticSourceInfo(resolvedPath, {
				// 说明资源来自本地路径，区别于 npm/git 包身份。
				source: "local",
				// 归属用户级配置；仅来源说明，不等于本函数验证了信任。
				scope: "user",
				// 全局模板以用户 prompts 目录作为来源基准。
				baseDir: globalPromptsDir,
			});
		}
		// 落在项目默认根则标为 project，和用户级来源区分。
		if (isUnderPath(resolvedPath, projectPromptsDir)) {
			// 用来源构造器补 scope/origin 等默认字段，不读取模板正文。
			return createSyntheticSourceInfo(resolvedPath, {
				// 说明资源来自本地路径，区别于 npm/git 包身份。
				source: "local",
				// 标为项目资源，是否允许发现它由上层资源/信任流程决定。
				scope: "project",
				// 项目模板来源基准设为项目 prompts 目录。
				baseDir: projectPromptsDir,
			});
		}
		// 用来源构造器补 scope/origin 等默认字段，不读取模板正文。
		return createSyntheticSourceInfo(resolvedPath, {
			// 说明资源来自本地路径，区别于 npm/git 包身份。
			source: "local",
			// 其他显式来源的目录作为基准，文件则取父目录；stat 失败可能交给外层 catch 处理。
			baseDir: statSync(resolvedPath).isDirectory() ? resolvedPath : dirname(resolvedPath),
		});
	};

	// 仅打开默认扫描时，按下方明确顺序合并两处目录。
	if (includeDefaults) {
		// 先加载用户默认目录，因此独立函数的同名首项可能是全局模板。
		addResult(loadTemplatesFromDir(globalPromptsDir, getSourceInfo));
		// 再加载项目默认目录，不在此自动替换已有同名项。
		addResult(loadTemplatesFromDir(projectPromptsDir, getSourceInfo));
	}

	// 3. Load explicit prompt paths
	// 最后逐个处理显式路径，既允许目录也允许单个 Markdown 文件。
	for (const rawPath of promptPaths) {
		// 以项目 cwd 解析相对路径，trim 清理路径输入两端空白，支持规范化 ~ 等写法。
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		// 不存在的显式模板路径在本层静默跳过；主 ResourceLoader 会补缺路径错误。
		if (!existsSync(resolvedPath)) {
			continue;
		}

		try {
			// 判定现存显式路径是目录还是文件；外部 I/O 错误会变为诊断。
			const stats = statSync(resolvedPath);
			// 显式目录也只扫描直接 .md 子文件。
			if (stats.isDirectory()) {
				// 合并该目录结果，继续保留输入路径顺序。
				addResult(loadTemplatesFromDir(resolvedPath, getSourceInfo));
				// 显式单文件必须是普通文件并以 .md 结尾。
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				// 读取该文件并附来源标签，失败只影响这个结果。
				const result = loadTemplateFromFile(resolvedPath, getSourceInfo(resolvedPath));
				// 只有成功解析结果才加入模板列表。
				if (result.template) {
					// 保留模板对象供后续命令展开，未在此消除同名冲突。
					templates.push(result.template);
				}
				// ... 将该次加载诊断逐条汇入集合，而非嵌套成数组。
				diagnostics.push(...result.diagnostics);
			}
		} catch (error) {
			// 对发现/来源计算阶段抛出的异常生成可展示文字。
			const message = error instanceof Error ? error.message : "failed to read prompt template path";
			// 给显式路径诊断保留实际解析后的文件位置。
			diagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	// 返回已收集模板与诊断；目录出错时也可能是部分结果。
	return { templates, diagnostics };
}

/**
 * Expand a prompt template if it matches a template name.
 * Returns the expanded content or the original text if not a template.
 */
// 把以 /命令 开头的输入匹配到模板并替换参数，输入用户文字和已加载模板，返回展开正文或原输入。
// 例如 /review "a b" 匹配 review 后把 a b 作为 $1；只取 templates 中首个同名项，不展开嵌套命令、不执行模板。
// 名称不存在/格式不匹配时原样返回，由上层继续按普通输入或其他命令处理。
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
	// 没有斜杠命令前缀无需解析，保留普通用户文字。
	if (!text.startsWith("/")) return text;

	// 正则取无空白命令名及可跨行参数尾串；match 无匹配时为 null。
	const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	// 只有斜杠等不构成命令的输入不作模板展开。
	if (!match) return text;

	// 第1捕获组是命令名，不包含开头的 /。
	const templateName = match[1];
	// 没有参数时使用空串，之后解析为空数组。
	const argsString = match[2] ?? "";

	// find 返回首个精确同名模板，大小写不做额外归一化。
	const template = templates.find((t) => t.name === templateName);
	// 仅命中模板才解析参数并替换正文。
	if (template) {
		// 按本文件简化引号规则拆参，不交给 shell。
		const args = parseCommandArgs(argsString);
		// 参数替换的对象是原模板正文，结果不再递归作为模板命令执行。
		return substituteArgs(template.content, args);
	}

	// 未匹配模板就保留原输入，给其他命令/正常对话处理。
	return text;
}
