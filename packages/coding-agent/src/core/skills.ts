// 技能 Markdown 的发现、元信息校验与模型目录格式化；ResourceLoader 负责组合包/项目/用户路径并控制信任边界。
// 发现阶段读文件提取 YAML，但返回 Skill 不保留正文；模型目录只列名称/描述/位置，完整说明由读工具按需加载。
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import ignore from "ignore";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { isPathWithin, resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { createSyntheticSourceInfo, getResourcePathKey, type SourceInfo } from "./source-info.ts";

/** Max name length per spec */
// 技能名长度约束是64个 JavaScript 字符单位，超长产生警告，不直接拒绝技能。
const MAX_NAME_LENGTH = 64;

/** Max description length per spec */
// 描述长度上限用于诊断；超长但非空的描述仍可加载。
const MAX_DESCRIPTION_LENGTH = 1024;

// 每层扫描尝试读取这三种忽略文件，按这个顺序把规则加入同一匹配器。
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

// typeof 取得 ignore 工厂的类型，ReturnType 提取它返回的匹配器类型，只参与编译期检查。
type IgnoreMatcher = ReturnType<typeof ignore>;

// 把路径分隔符转成 / 以供 ignore 匹配；输入路径文字，返回新字符串，不解析绝对路径或访问磁盘。
// 例如 Windows 的 a\b 转成 a/b；POSIX 本来使用 / 时保持路径段。
function toPosixPath(p: string): string {
	// 按当前平台 sep 拆分再用 / 连接，不盲目替换所有反斜杠文字。
	return p.split(sep).join("/");
}

// 给某目录的一条忽略规则加相对扫描根的前缀，输入原行和前缀，返回规则或 null，无 I/O。
// 先跳过空行/注释，再暂取开头否定符、去掉前导 /，补前缀后恢复 !；例如子目录 foo 的 /bar 转成 foo/bar。
// 这是本实现的规则转换，不是完整 shell/glob 解析，最终匹配语义仍由 ignore 包处理。
function prefixIgnorePattern(line: string, prefix: string): string | null {
	// trim 仅用于判断空行/注释；后面的规则本体仍从原始 line 开始。
	const trimmed = line.trim();
	// 纯空白没有有效规则，返回 null 供上层过滤。
	if (!trimmed) return null;
	// 修剪后以#开头的是注释行；转义前缀不按普通注释处理，规则本体仍保留原始行。
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	// 保留原行规则，后面只调整需要挂到扫描根的前导部分。
	let pattern = line;
	// 记住是否为 ! 否定规则，不能让目录前缀把这个标记移到中间。
	let negated = false;

	// 以 ! 开头时先剥离否定标记，稍后加回到最终规则最前面。
	if (pattern.startsWith("!")) {
		// 记录这是一条取消忽略的规则。
		negated = true;
		// 移除当前已识别的一个前导字符，不递归解析余下规则。
		pattern = pattern.slice(1);
		// 转义感叹号分支只去掉前导反斜杠，具体最终匹配仍由ignore包解释。
	} else if (pattern.startsWith("\\!")) {
		// 移除当前已识别的一个前导字符，不递归解析余下规则。
		pattern = pattern.slice(1);
	}

	// 目录锚定规则先去前导 /，再由 prefix 表达相对根的位置。
	if (pattern.startsWith("/")) {
		// 移除当前已识别的一个前导字符，不递归解析余下规则。
		pattern = pattern.slice(1);
	}

	// 子目录规则加上相对前缀；扫描根规则没有前缀则直接使用。
	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	// 否定规则的 ! 放在加前缀后的整条规则前，交给 ignore 包解释。
	return negated ? `!${prefixed}` : prefixed;
}

// 读取本层三个忽略文件并原地扩展匹配器；输入匹配器、当前目录和扫描根，无返回，读取失败静默跳过。
// 例如根下 docs 的规则 x.md 会加上 docs/ 前缀；递归共用同一匹配器，所以每层新增规则需带所属目录前缀。
function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	// 计算当前目录相对于本次扫描根的位置，未做 realpath。
	const relativeDir = relative(rootDir, dir);
	// 子目录前缀统一 / 并以 / 结尾，根目录前缀为空串。
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	// 按 .gitignore/.ignore/.fdignore 顺序读取本层规则。
	for (const filename of IGNORE_FILE_NAMES) {
		// 拼当前忽略文件路径，不扫描其他全局 Git 排除配置。
		const ignorePath = join(dir, filename);
		// 可选忽略文件不存在就读下一个。
		if (!existsSync(ignorePath)) continue;
		try {
			// 同步读取规则文件；权限等错误由本层空 catch 吞掉，扫描继续。
			const content = readFileSync(ignorePath, "utf-8");
			// 规则文件按行拆分、加前缀、去掉空结果后再批量加入。
			const patterns = content
				// 兼容 LF 和 CRLF 行结束，不将整份文件当作一个规则。
				.split(/\r?\n/)
				// 箭头回调把每一行转换到扫描根坐标。
				.map((line) => prefixIgnorePattern(line, prefix))
				// 类型谓词移除 null/空值，让后面静态类型收窄为 string[]。
				.filter((line): line is string => Boolean(line));
			// 只有有效规则非空才更新匹配器。
			if (patterns.length > 0) {
				// ignore.add 会修改当前匹配器；同一个扫描树的后续目录沿用这些规则。
				ig.add(patterns);
			}
		} catch {}
	}
}

// SKILL.md YAML 头的预期类型；解析器的泛型断言不会自动校验外部 YAML。
export interface SkillFrontmatter {
	// 可选技能名，缺省/空串回退父目录名。
	name?: string;
	// 描述可在类型中缺省，但实际加载必须提供非空字符串才接受技能。
	description?: string;
	// 仅真实布尔值 true 才阻止技能出现在模型目录；字符串 "true" 不等价。
	"disable-model-invocation"?: boolean;
	// 索引签名允许额外 YAML 字段，值未知；不表示所有字段已被理解或执行。
	[key: string]: unknown;
}

// 已发现技能元信息，不保存完整正文；模型先看描述和路径，匹配任务后再读文件。
export interface Skill {
	// 技能命令标识，同名冲突时前面已接受的项保留。
	name: string;
	// 模型目录里的任务匹配描述，来自 YAML 头，不自动摘要正文。
	description: string;
	// 技能 Markdown 路径，后续需要时由读工具加载实际说明。
	filePath: string;
	// 技能文件父目录，用于解释技能内相对资源路径。
	baseDir: string;
	// user/project/temporary 及包等来源信息，仅元数据，不是运行权限检查。
	sourceInfo: SourceInfo;
	// 为真时不在自动技能目录展示；技能仍可能通过显式 /skill:name 调用。
	disableModelInvocation: boolean;
}

// 技能发现结果和可展示诊断；有警告不代表所有技能都被拒绝。
export interface LoadSkillsResult {
	// 成功接受的技能元信息数组，不含正文内容。
	skills: Skill[];
	// 语法/字段警告和名称冲突等诊断记录。
	diagnostics: ResourceDiagnostic[];
}

/**
 * Validate skill name per Agent Skills spec.
 * Returns array of validation error messages (empty if valid).
 */
// 检查技能名的长度/字符/横线规则，输入名称，返回全部问题数组，不抛错、不直接决定是否加载。
// 例如 Bad--Name 同时触发大小写字符和连续横线警告；此文件不会要求名称必须等于父目录名。
function validateName(name: string): string[] {
	// 累计独立校验问题，可能一次返回多条。
	const errors: string[] = [];

	// 超长只记录问题，后续其他规则继续检查。
	if (name.length > MAX_NAME_LENGTH) {
		// 诊断同时给上限和实际长度，便于修复 YAML 名称。
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	// 只允许至少一个小写字母、数字或横线，因此空串也无法通过该规则。
	if (!/^[a-z0-9-]+$/.test(name)) {
		// 名称中有其他字符就记录一条说明，不在这里自动改名。
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}

	// 横线允许在中间，但不允许开头或结尾。
	if (name.startsWith("-") || name.endsWith("-")) {
		// 保留具体命名问题供诊断展示。
		errors.push(`name must not start or end with a hyphen`);
	}

	// 即使字符集合法，连续横线也单独提示。
	if (name.includes("--")) {
		// 记录连续横线问题，不中止其他技能发现。
		errors.push(`name must not contain consecutive hyphens`);
	}

	// 返回全部问题，空数组表示这组规则没有发现问题。
	return errors;
}

/**
 * Validate description per Agent Skills spec.
 */
// 检查外部 YAML 描述是否是非空文字及长度，返回诊断文字数组，无副作用/异常。
// 例如缺描述与纯空白都提示 required；超过1024字符只警告，真正是否接受还由加载器判断 hasDescription。
function validateDescription(description: unknown): string[] {
	// 累计独立校验问题，可能一次返回多条。
	const errors: string[] = [];

	// description 来自未验证 YAML，因此在边界检查实际字符串类型和非空白。
	if (typeof description !== "string" || description.trim() === "") {
		// 非字符串或纯空白不能作为模型选择技能的描述。
		errors.push("description is required");
		// 合法非空文字再检查长度，没有在这里截短。
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		// 超长描述仍原样保留，诊断交给用户修正。
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	// 返回全部问题，空数组表示这组规则没有发现问题。
	return errors;
}

// 单目录发现选项，来源字符串用于元信息，不替代外层信任决策。
export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	// 本次发现的起始目录，可以是技能根或包含多个技能的目录。
	dir: string;
	/** Source identifier for these skills */
	// 调用方约定的来源标识，例如 user/project/path 或包来源名。
	source: string;
}

// 把简化来源标识转成 SourceInfo；输入文件、父目录和来源，返回元信息，不读文件或验证信任。
// 例如 source=user 得到 local/user；path 使用默认 temporary，包名等其他来源按原字符串保留。
function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	// 对三个约定本地来源做特殊映射，其他字符串走 default。
	switch (source) {
		// 用户技能记录为本地资源、user 作用域。
		case "user":
			// 创建来源对象，不会加载或执行技能说明正文。
			return createSyntheticSourceInfo(filePath, {
				// 这些约定路径归类 local；与 npm/git 包身份区分。
				source: "local",
				// 元信息归用户级，默认模板/技能目录来源之一。
				scope: "user",
				// 对象属性简写，保留技能文件的父目录作为相对路径基准。
				baseDir,
			});
		// 项目技能记录为本地资源、project 作用域。
		case "project":
			// 创建来源对象，不会加载或执行技能说明正文。
			return createSyntheticSourceInfo(filePath, {
				// 这些约定路径归类 local；与 npm/git 包身份区分。
				source: "local",
				// 元信息归项目级；是否允许扫描它应由上层信任/资源发现控制。
				scope: "project",
				// 对象属性简写，保留技能文件的父目录作为相对路径基准。
				baseDir,
			});
		// 显式普通路径不强行归属项目或用户，使用构造器默认作用域。
		case "path":
			// 创建来源对象，不会加载或执行技能说明正文。
			return createSyntheticSourceInfo(filePath, {
				// 这些约定路径归类 local；与 npm/git 包身份区分。
				source: "local",
				// 对象属性简写，保留技能文件的父目录作为相对路径基准。
				baseDir,
			});
		default:
			// 非约定来源名原样记录，缺省 scope/origin 由构造器补齐。
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

/**
 * Load skills from a directory.
 *
 * Discovery rules:
 * - if a directory contains SKILL.md, treat it as a skill root and do not recurse further
 * - otherwise, load direct .md children in the root
 * - recurse into subdirectories to find SKILL.md
 */
// 从目录发现技能，输入目录及来源，返回元信息和诊断；会同步读目录/Markdown/忽略文件，不请求模型。
// 根目录可接受直接 .md 文件，递归子目录主要找 SKILL.md；例如一旦某目录找到未忽略 SKILL.md，就把它视作技能根，不再向下递归。
export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	// 对象解构按字段名取得扫描目录与来源。
	const { dir, source } = options;
	// 初始层允许直接 .md 文件，递归子层会把此开关设 false。
	return loadSkillsFromDirInternal(dir, source, true);
}

// 递归技能发现核心：输入当前目录、来源、是否接受根直接 .md，以及可共享忽略器/根目录，返回累积结果。
// 先加载本层忽略规则、优先寻找 SKILL.md；若找到即返回（即使文件解析失败），否则扫描子目录/允许的根文件。
// 例如隐藏目录、node_modules、被忽略路径跳过；会跟随目录链接但这里没有通用循环检测，I/O 多数按尽力发现跳过。
function loadSkillsFromDirInternal(
	dir: string,
	source: string,
	includeRootFiles: boolean,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): LoadSkillsResult {
	// 收集当前子树的成功元信息，不保存文件正文。
	const skills: Skill[] = [];
	// 收集可报告的加载警告/字段问题，部分目录异常可能被静默跳过。
	const diagnostics: ResourceDiagnostic[] = [];

	// 不存在目录视为没有资源，默认目录可缺省。
	if (!existsSync(dir)) {
		// 返回当前已收集结果；技能根识别后也会直接返回而不继续递归。
		return { skills, diagnostics };
	}

	// 首层将自己设为扫描根，递归层沿用同一个 root 来计算忽略相对路径。
	const root = rootDir ?? dir;
	// 首层创建忽略匹配器，递归复用；?? 只在缺值时创建。
	const ig = ignoreMatcher ?? ignore();
	// 本层忽略规则按目录前缀加入匹配器，不读其他工作树的全局规则。
	addIgnoreRules(ig, dir, root);

	try {
		// 读取直接目录项及类型，下面两遍分别查 SKILL.md 和常规遍历。
		const entries = readdirSync(dir, { withFileTypes: true });

		// 遍历当前目录项，不能从这个顺序推导稳定的字典排序。
		for (const entry of entries) {
			// 第一遍只找大小写精确的 SKILL.md。
			if (entry.name !== "SKILL.md") {
				continue;
			}

			// 拼当前候选完整路径，后续必要时跟随符号链接 stat。
			const fullPath = join(dir, entry.name);

			// 保存是否普通文件，链接分支会以目标属性覆盖。
			let isFile = entry.isFile();
			// 符号链接需要跟随到目标，Dirent 的 isFile/isDirectory 不足以判定目标。
			if (entry.isSymbolicLink()) {
				try {
					// 确认 SKILL.md 链接目标是文件，坏链接交给 catch 跳过。
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			// ignore 需要相对扫描根、使用 / 的路径，不传绝对路径。
			const relPath = toPosixPath(relative(root, fullPath));
			// 不是文件或已被规则忽略的 SKILL.md 不构成技能根。
			if (!isFile || ig.ignores(relPath)) {
				continue;
			}

			// 读取候选 Markdown 的头部元数据，不执行技能内容。
			const result = loadSkillFromFile(fullPath, source);
			// 只有具备有效非空描述的加载结果才加入技能数组。
			if (result.skill) {
				// 保存元信息对象，文件正文留给后续按需读取。
				skills.push(result.skill);
			}
			// 展开追加该文件问题，不把某文件警告升级为整次发现失败。
			diagnostics.push(...result.diagnostics);
			// 返回当前已收集结果；技能根识别后也会直接返回而不继续递归。
			return { skills, diagnostics };
		}

		// 遍历当前目录项，不能从这个顺序推导稳定的字典排序。
		for (const entry of entries) {
			// 常规递归遍历跳过点开头目录/文件，避免无意扫描隐藏配置树。
			if (entry.name.startsWith(".")) {
				continue;
			}

			// Skip node_modules to avoid scanning dependencies
			// 明确跳过依赖目录，避免发现第三方依赖内部技能并扩大扫描量。
			if (entry.name === "node_modules") {
				continue;
			}

			// 拼当前候选完整路径，后续必要时跟随符号链接 stat。
			const fullPath = join(dir, entry.name);

			// For symlinks, check if they point to a directory and follow them
			// 普通目录可直接识别，链接目标可能覆盖该值。
			let isDirectory = entry.isDirectory();
			// 保存是否普通文件，链接分支会以目标属性覆盖。
			let isFile = entry.isFile();
			// 符号链接需要跟随到目标，Dirent 的 isFile/isDirectory 不足以判定目标。
			if (entry.isSymbolicLink()) {
				try {
					// 跟随链接取实际目标属性，目标不存在时跳过。
					const stats = statSync(fullPath);
					// 决定链接能否递归进入。
					isDirectory = stats.isDirectory();
					// 同时决定链接目标能否作为直接 Markdown 文件加载。
					isFile = stats.isFile();
				} catch {
					// Broken symlink, skip it
					continue;
				}
			}

			// ignore 需要相对扫描根、使用 / 的路径，不传绝对路径。
			const relPath = toPosixPath(relative(root, fullPath));
			// 目录路径带结尾 /，让 ignore 的目录规则按预期匹配。
			const ignorePath = isDirectory ? `${relPath}/` : relPath;
			// 被忽略的目录不会进入，文件也不会继续读。
			if (ig.ignores(ignorePath)) {
				continue;
			}

			// 对未忽略的目录递归找技能根。
			if (isDirectory) {
				// 递归共享忽略器与根；false 表示子层不接受任意直接 .md，只认 SKILL.md 或继续向下。
				const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root);
				// 汇入子树成功技能，保持扫描顺序。
				skills.push(...subResult.skills);
				// 同时汇入子树报告的问题。
				diagnostics.push(...subResult.diagnostics);
				continue;
			}

			// 只有当前允许根文件、目标确实是文件且小写 .md 后缀时才按普通技能文件尝试。
			if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) {
				continue;
			}

			// 读取候选 Markdown 的头部元数据，不执行技能内容。
			const result = loadSkillFromFile(fullPath, source);
			// 只有具备有效非空描述的加载结果才加入技能数组。
			if (result.skill) {
				// 保存元信息对象，文件正文留给后续按需读取。
				skills.push(result.skill);
			}
			// 展开追加该文件问题，不把某文件警告升级为整次发现失败。
			diagnostics.push(...result.diagnostics);
		}
	} catch {}

	// 返回当前已收集结果；技能根识别后也会直接返回而不继续递归。
	return { skills, diagnostics };
}

// 读取 Markdown 并提取技能头部，输入文件路径/来源，返回技能或 null 及诊断；同步 I/O，不执行正文。
// SKILL.md 是明确声明，解析/缺描述会报告问题；普通 .md 若没有非空描述就静默跳过。
// 名称非法/描述超长仅警告仍可载入，缺描述一定拒绝；例如 name 缺省使用父目录名，最终 Skill 不包含正文。
function loadSkillFromFile(
	filePath: string,
	source: string,
): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
	// 收集可报告的加载警告/字段问题，部分目录异常可能被静默跳过。
	const diagnostics: ResourceDiagnostic[] = [];
	// 只按文件名精确判断是否明确声明技能，用于决定错误是否应公开诊断。
	const isDeclaredSkill = basename(filePath) === "SKILL.md";

	// 先读完整 Markdown，后面只提取元数据，不保留正文到 Skill 对象。
	let rawContent: string;
	try {
		// 同步读取文件；中文按 UTF-8 解码，解析器另外处理 BOM/换行。
		rawContent = readFileSync(filePath, "utf-8");
	} catch (error) {
		// 外部异常可能不是 Error，用实际错误文字或固定说明。
		const message = error instanceof Error ? error.message : "failed to read skill file";
		// 诊断附上文件位置，供资源界面定位问题。
		diagnostics.push({ type: "warning", message, path: filePath });
		// 拒绝当前文件但保留诊断，调用方可继续发现其他技能。
		return { skill: null, diagnostics };
	}

	// 声明预期头部形状，但泛型解析结果本身没有 schema 运行时校验。
	let frontmatter: SkillFrontmatter;
	try {
		// 只取 YAML 头；<SkillFrontmatter> 是类型参数，不执行字段校验，外层括号表示解构赋值。
		({ frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent));
	} catch (error) {
		// 普通 Markdown 不一定是技能，所以只有明确 SKILL.md 的 YAML 解析错误才警告。
		if (isDeclaredSkill) {
			// 生成头部解析失败说明，不把坏 YAML 当普通正文强行接受。
			const message = error instanceof Error ? error.message : "failed to parse skill file";
			// 诊断附上文件位置，供资源界面定位问题。
			diagnostics.push({ type: "warning", message, path: filePath });
		}
		// 拒绝当前文件但保留诊断，调用方可继续发现其他技能。
		return { skill: null, diagnostics };
	}

	// 实际 description 仍需检查类型和空白，不能仅相信泛型接口。
	const description = frontmatter.description;
	// 只有运行时字符串且非纯空白才能进入模型目录。
	const hasDescription = typeof description === "string" && description.trim() !== "";
	// 无描述普通 .md 不是技能，静默跳过，不为任意说明文档制造错误。
	if (!isDeclaredSkill && !hasDescription) {
		// 拒绝当前文件但保留诊断，调用方可继续发现其他技能。
		return { skill: null, diagnostics };
	}

	// 技能基准目录是 Markdown 的父目录。
	const skillDir = dirname(filePath);
	// 目录名用于未提供技能 name 时的回退，不从普通文件名取技能名。
	const parentDirName = basename(skillDir);

	// Validate description
	// 描述缺失/超长诊断先收集，最终拒绝条件仍是 hasDescription。
	const descErrors = validateDescription(description);
	// 可能有一个描述问题，逐条转成资源 warning。
	for (const error of descErrors) {
		// 保留原问题文字及路径，名称问题也复用同一诊断形状。
		diagnostics.push({ type: "warning", message: error, path: filePath });
	}

	// Use name from frontmatter, or fall back to parent directory name
	// 外部 YAML name 只接受真实字符串，其他值按缺省处理。
	const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	// 空字符串也回退目录名；只含空格的名称非空，会保留并被命名规则警告。
	const name = frontmatterName || parentDirName;

	// Validate name
	// 名称格式不符合规则只生成警告，不直接阻止加载。
	const nameErrors = validateName(name);
	// 将各条名称问题追加到资源诊断。
	for (const error of nameErrors) {
		// 保留原问题文字及路径，名称问题也复用同一诊断形状。
		diagnostics.push({ type: "warning", message: error, path: filePath });
	}

	// Still load the skill even with warnings, unless description is missing or empty.
	// 明确 SKILL.md 也必须有非空描述，否则不向模型展示无法匹配任务的技能。
	if (!hasDescription) {
		// 拒绝当前文件但保留诊断，调用方可继续发现其他技能。
		return { skill: null, diagnostics };
	}

	return {
		// 成功只构造元信息，不把 rawContent 或正文放入返回对象。
		skill: {
			name,
			description,
			filePath,
			// 相对文件引用应以这个技能目录解释。
			baseDir: skillDir,
			// 补上作用域/来源基准，供上层展示和来源追踪。
			sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
			// 严格等于布尔 true 才隐藏自动目录，字符串或其他 truthy 值不触发。
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		},
		diagnostics,
	};
}

/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per Agent Skills standard.
 * See: https://agentskills.io/integrate-skills
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 *
 * `fileReadTool` names the tool that loads skill files; `indirect` names none, for a reader that
 * is reachable only through another tool.
 */
// 把技能元信息排成模型可见目录，输入技能及读取工具提示类型，返回字符串，不读技能正文。
// 过滤禁止模型自行调用的技能，再按名称/描述/绝对位置输出 XML 文本；例如 indirect 不指名直接工具，避免提示隐藏 read 可直接调用。
// 没有可见技能返回空串，显式 /skill:name 是否可用由上层命令注册处理。
export function formatSkillsForPrompt(skills: Skill[], fileReadTool: "read" | "bash" | "indirect" = "read"): string {
	// 不修改原数组，筛掉只能显式调用的技能。
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

	// 过滤后为空就不增加无意义目录段。
	if (visibleSkills.length === 0) {
		// 没有技能目录可展示，不生成任何模型提示文字。
		return "";
	}

	// 按固定说明和逐技能目录行组织最终文字，下方英语字符串都是实际模型指令。
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		// 读取能力直接为 read 时给出 read 提示，否则继续判断 bash/间接能力。
		fileReadTool === "read"
			? "Use the read tool to load a skill's file when the task matches its description."
			: // 有直接 bash 时可以用它加载说明文件；再否则不点名工具。
				fileReadTool === "bash"
				? "Use bash to load a skill's file when the task matches its description."
				: "Load a skill's file when the task matches its description.",
		"Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
		"",
		"<available_skills>",
	];

	// 按传入的已去重顺序输出目录，不在格式化阶段重新解决名称冲突。
	for (const skill of visibleSkills) {
		// 为当前技能打开一条目录记录。
		lines.push("  <skill>");
		// 技能名称经 XML 字符转义后放入 name 标签，避免名称字符破坏结构。
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		// 任务匹配描述也要转义，不把尖括号直接当目录结构。
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		// 告诉模型去哪里按需读完整技能，不在目录中塞入全部正文。
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		// 完成这一技能目录记录；这行生成输出内容而非控制发现流程。
		lines.push("  </skill>");
	}

	// 为整个目录补结束标签。
	lines.push("</available_skills>");

	// 合成最终系统段文字，不写任何文件。
	return lines.join("\n");
}

// 把目录动态字段中的五种 XML 特殊字符转成实体；输入任意字符串，返回新串，无其他副作用。
// 例如 a<b 变成 a&lt;b；先替换 & 避免随后新生成的实体再次被转义。
function escapeXml(str: string): string {
	// 链式 replace 依次返回新字符串，不就地修改传入值。
	return (
		str
			// 先转义原有 &，后面生成的 &lt; 等实体不会再次走本行。
			.replace(/&/g, "&amp;")
			// 小于号转成实体，避免形成动态开始标签。
			.replace(/</g, "&lt;")
			// 大于号转成实体。
			.replace(/>/g, "&gt;")
			// 双引号也转成实体。
			.replace(/"/g, "&quot;")
			// 最后将单引号转成实体；这只影响模型目录动态字段，不修改技能源文件。
			.replace(/'/g, "&apos;")
	);
}

// 独立技能加载器配置：默认全局/项目目录可选，显式路径总会单独尝试；这里不自行作项目信任判断。
export interface LoadSkillsOptions {
	/** Working directory for project-local skills. */
	// 工作目录，也是显式相对技能路径解析的基准。
	cwd: string;
	/** Agent config directory for global skills. */
	// 用户级 agent 配置目录，全局技能默认在 skills 子目录。
	agentDir: string;
	/** Explicit skill paths (files or directories) */
	// 调用方显式提供的技能文件/目录路径，上层也可传入包管理器已解析资源。
	skillPaths: string[];
	/** Include default skills directories. */
	// 是否额外扫描全局和项目 .pi 默认目录，不等价于是否信任项目。
	includeDefaults: boolean;
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation diagnostics.
 */
// 合并默认及显式技能并解决同名/同文件重复，输入配置，返回接受的元信息和诊断；有文件 I/O，无模型请求。
// 独立调用默认顺序为 user→project→显式，首个同名成功项保留；例如全局和项目都叫 review 时此顺序全局胜出。
// 主 ResourceLoader 传 includeDefaults=false，路径已由包管理器排优先级，不能把这份默认顺序泛化成所有入口。
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	// 解构所需配置，cwd 另在下一步规范化。
	const { agentDir, skillPaths, includeDefaults } = options;

	// Resolve agentDir - if not provided, use default from config
	// 解析工作目录为绝对路径，供显式相对输入使用。
	const resolvedCwd = resolvePath(options.cwd);
	// 未提供 agentDir 的运行时情况回退配置助手；?? 不把空串当未传。
	const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir());

	// 按技能名保存首个被接受项，用于名称冲突判定。
	const skillMap = new Map<string, Skill>();
	// 记录已接受文件的规范路径键，跟随符号链接并按平台大小写规则去重。
	const realPathSet = new Set<string>();
	// 收集读取/字段/路径问题，最后再附名称冲突诊断。
	const allDiagnostics: ResourceDiagnostic[] = [];
	// 名称相同但来自不同文件时保存胜者与败者路径。
	const collisionDiagnostics: ResourceDiagnostic[] = [];

	// 局部汇总函数原地更新 skillMap/已接受文件集合/诊断，输入一批加载结果，无返回。
	// 例如同一真实文件经符号链接再出现会静默跳过；另一文件同名则报警且保留原胜者，不执行技能。
	function addSkills(result: LoadSkillsResult) {
		// 先保留这批文件自己的校验警告，即使之后技能因冲突未采用。
		allDiagnostics.push(...result.diagnostics);
		// 依批次顺序尝试接受技能，因此输入路径顺序决定同名胜者。
		for (const skill of result.skills) {
			// Resolve symlinks to detect duplicate files
			// 真实文件按 canonicalizePath 与平台路径比较键去重；无法 realpath 时助手会回退原路径。
			const realPath = getResourcePathKey(skill.filePath);

			// Skip silently if we've already loaded this exact file (via symlink)
			// 已接受过同一文件就静默跳过，不制造重复名称警告。
			if (realPathSet.has(realPath)) {
				continue;
			}

			// 按确切名称找已接受项，没有语义或大小写折叠去重。
			const existing = skillMap.get(skill.name);
			// 另一个文件同名时进入冲突诊断，当前文件不替换旧项。
			if (existing) {
				// 生成结构化冲突详情，供资源界面展示谁被采用/谁被跳过。
				collisionDiagnostics.push({
					// 诊断类型是名称碰撞，不是技能执行错误。
					type: "collision",
					// 简短说明冲突名称，原技能名不自动改写。
					message: `name "${skill.name}" collision`,
					// 当前败者路径是诊断主位置。
					path: skill.filePath,
					// 附带可供界面定位双方来源的结构化信息。
					collision: {
						// 明确资源种类，避免与模板/主题同名冲突混淆。
						resourceType: "skill",
						// 保持发生冲突的真实技能名。
						name: skill.name,
						// 先接受的文件继续作为胜者。
						winnerPath: existing.filePath,
						// 当前后出现文件作为败者，不加入 skillMap。
						loserPath: skill.filePath,
					},
				});
			} else {
				// 名称尚未占用才接受这个技能元信息。
				skillMap.set(skill.name, skill);
				// 只有被接受的文件登记路径键；名称冲突败者不会在这里登记。
				realPathSet.add(realPath);
			}
		}
	}

	// 独立加载开启默认目录时，按下面 user 再 project 的顺序扫描。
	if (includeDefaults) {
		// 先扫描用户默认技能根，允许该根直接 Markdown。
		addSkills(loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true));
		// 再扫描项目 .pi/skills，发生同名时已有用户项先占位。
		addSkills(loadSkillsFromDirInternal(resolve(resolvedCwd, CONFIG_DIR_NAME, "skills"), "project", true));
	}

	// 用户技能根也用于关闭默认扫描时给显式路径补来源标签。
	const userSkillsDir = join(resolvedAgentDir, "skills");
	// 项目技能根同样参与来源归类，不在此新建目录。
	const projectSkillsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "skills");

	// 局部来源判定回调只返回三种字面量，按路径归属分类，不负责权限或覆盖。
	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		// 默认目录未扫描时，显式落在这两个目录下的文件仍能标记原本作用域。
		if (!includeDefaults) {
			// 按平台路径边界判断用户根归属，不在这里跟随链接决定信任。
			if (isPathWithin(userSkillsDir, resolvedPath)) return "user";
			// 匹配项目根则补 project 来源。
			if (isPathWithin(projectSkillsDir, resolvedPath)) return "project";
		}
		// 其他显式来源使用普通 path 分类，之后默认归 temporary。
		return "path";
	};

	// 按上层给定顺序处理显式技能路径；可以是单文件或目录。
	for (const rawPath of skillPaths) {
		// 先修剪输入两端空白，再以 cwd 解析相对路径/展开 ~ 等写法。
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		// 不存在显式技能路径会报警，不静默当空目录。
		if (!existsSync(resolvedPath)) {
			// 诊断记录解析后的路径，便于定位设置/CLI 指向哪里。
			allDiagnostics.push({ type: "warning", message: "skill path does not exist", path: resolvedPath });
			continue;
		}

		try {
			// 读取外部路径类型，异常会被下面 catch 转成 warning。
			const stats = statSync(resolvedPath);
			// 为该显式来源选择 user/project/path 元信息。
			const source = getSource(resolvedPath);
			// 目录使用统一递归规则，首层允许直接 .md。
			if (stats.isDirectory()) {
				// 将目录子树的技能与诊断经过统一同名/同文件去重。
				addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));
				// 显式单文件必须是普通文件且小写 .md 后缀。
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				// 单独解析文件的技能元信息，正文不被执行。
				const result = loadSkillFromFile(resolvedPath, source);
				// 只有具备有效非空描述的加载结果才加入技能数组。
				if (result.skill) {
					// 成功单文件也经过统一去重，避免绕开名称冲突规则。
					addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
				} else {
					// 先保留这批文件自己的校验警告，即使之后技能因冲突未采用。
					allDiagnostics.push(...result.diagnostics);
				}
			} else {
				// 其他现存路径类型不作为技能，记录可展示诊断。
				allDiagnostics.push({ type: "warning", message: "skill path is not a markdown file", path: resolvedPath });
			}
		} catch (error) {
			// 读取显式路径/目录时的异常用实际错误或兜底说明。
			const message = error instanceof Error ? error.message : "failed to read skill path";
			// 出错只影响本路径，其余显式路径仍继续。
			allDiagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	return {
		// 把最终按首次接受顺序保存的元信息转换为数组。
		skills: Array.from(skillMap.values()),
		// 普通问题在前、名称碰撞在后，不根据数量自动改变加载成功状态。
		diagnostics: [...allDiagnostics, ...collisionDiagnostics],
	};
}
