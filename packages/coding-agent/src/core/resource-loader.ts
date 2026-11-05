// 资源协调入口：SDK/启动层构造后 await reload，才能拿到扩展、技能、模板、主题、AGENTS说明和系统前言。
// 包管理器先决定来源/路径/启用/信任，技能、模板、主题正文按数据解析；扩展初始化、包安装和宿主回调都可能执行代码，来源标签不是沙箱。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { detectCapabilities, getTerminalColorMode, type TerminalColorMode } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME } from "../config.ts";
import { loadThemeFromPath, type Theme } from "../modes/interactive/theme/theme.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";

export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.ts";

import { canonicalizePath, isLocalPath, isPathWithin, pathsEqual, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { createEventBus, type EventBus } from "./event-bus.ts";
import {
	clearExtensionCache,
	createExtensionRuntime,
	loadExtensionFromFactory,
	loadExtensionsCached,
} from "./extensions/loader.ts";
import type {
	Extension,
	ExtensionFactory,
	ExtensionRuntime,
	InlineExtension,
	LoadExtensionsResult,
} from "./extensions/types.ts";
import { findGitPaths } from "./footer-data-provider.ts";
import {
	DefaultPackageManager,
	type PackageInstallFailure,
	type PathMetadata,
	type ResolvedResource,
} from "./package-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { loadPromptTemplates } from "./prompt-templates.ts";
import { SettingsManager } from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
import { loadSkills } from "./skills.ts";
import {
	BUILTIN_PATH_PREFIX,
	createSourceInfo,
	getResourcePathKey,
	getSyntheticPathSource,
	isSyntheticPath,
	type SourceInfo,
} from "./source-info.ts";
import { resetTimings } from "./timings.ts";

// 扩展运行时额外贡献的技能/模板/主题路径，每项带来源元数据；不在这个接口里贡献新的扩展代码。
export interface ResourceExtensionPaths {
	skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
	promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
	themePaths?: Array<{ path: string; metadata: PathMetadata }>;
}

// 重载时可提供项目授权回调，先加载可用于信任判断的用户/临时扩展，再决定是否启用项目资源。
export interface ResourceLoaderReloadOptions {
	// 可选异步回调接收预信任扩展结果，返回项目是否可信；函数类型本身不执行授权。
	resolveProjectTrust?: (input: { extensionsResult: LoadExtensionsResult }) => Promise<boolean>;
}

// 宿主已经提供这些运行时包；扩展若再作为 dependencies 安装一份，可能产生重复模块身份，下面据此警告。
const HOST_PROVIDED_EXTENSION_PACKAGES = new Set([
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@mariozechner/pi-agent-core",
	"@mariozechner/pi-ai",
	"@mariozechner/pi-coding-agent",
	"@mariozechner/pi-tui",
	"@sinclair/typebox",
	"typebox",
]);

// 从启用扩展的包根读取 package.json，检查宿主包是否被错误写入 dependencies，返回路径/警告列表。
// 输入扩展路径和包元数据索引，包根先去重；例如 pi-ai 应以 peerDependency 共享宿主，而非单独安装运行时。
// 此函数同步读文件且 JSON/I/O 错误可向外抛；只检查 dependencies 名称，不全面验证 peerDependencies 的范围。
function collectExtensionPackageWarnings(
	extensionPaths: string[],
	metadataByPath: Map<string, PathMetadata>,
): Array<{ path: string; warning: string }> {
	// 本次收集的可展示警告，Array<对象类型> 指每项同时有路径与文字。
	const warnings: Array<{ path: string; warning: string }> = [];
	// 多个扩展可来自同一包，Set 让同包 manifest 只读一次。
	const packageRoots = new Set(
		extensionPaths
			// 从已解析来源元数据中找包根；?. 允许不是包资源的路径没有这项。
			.map((extensionPath) => metadataByPath.get(extensionPath)?.packageRoot)
			// 类型谓词滤掉缺值，把结果收窄为字符串数组。
			.filter((packageRoot): packageRoot is string => packageRoot !== undefined),
	);
	// 逐个检查实际关联的扩展包，而不是扫描全部 node_modules。
	for (const packageRoot of packageRoots) {
		// 构建包声明路径。
		const packageJsonPath = join(packageRoot, "package.json");
		// 缺少 manifest 不生成这类依赖警告，继续检查其他包。
		if (!existsSync(packageJsonPath)) continue;
		// 同步读取并去 BOM 后解析 JSON；as 只声明预期形状，dependencies 仍按 unknown 检查。
		const manifest = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as { dependencies?: unknown };
		if (
			// 外部 package.json 的 dependencies 必须是对象才能枚举包名。
			typeof manifest.dependencies !== "object" ||
			// typeof null 也是 object，需要单独排除。
			manifest.dependencies === null ||
			// 数组也不属于合法依赖字典，已有保护检查在此跳过它。
			Array.isArray(manifest.dependencies)
		) {
			continue;
		}
		// 只取依赖包名，不读取依赖实现或安装它们。
		const hostDependencies = Object.keys(manifest.dependencies)
			// 筛出与宿主运行时重复的包名。
			.filter((name) => HOST_PROVIDED_EXTENSION_PACKAGES.has(name))
			// 排序使警告中的包名顺序稳定，便于阅读和测试。
			.sort();
		// 没有重复宿主包就无需给该 manifest 生成警告。
		if (hostDependencies.length === 0) continue;
		// 把问题作为来源路径关联的 warning 保存，不自动改 package.json。
		warnings.push({
			path: packageJsonPath,
			warning: `Host-provided extension packages must be declared in peerDependencies with a "*" range, not dependencies: ${hostDependencies.join(", ")}. Installed copies can bypass the extension loader and create duplicate runtime modules.`,
		});
	}
	// 返回收集结果，是否显示由资源加载器/界面决定。
	return warnings;
}

/** Describe a package that was skipped because it could not be installed, including how to drop it. */
// 把包解析时的安装失败转换成说明与移除提示；输入失败来源/作用域/原因，返回字符串，不安装或删除包。
// 例如 project 失败提示 remove --local，temporary 只建议检查来源重试，因为它不在持久设置里。
function describePackageInstallFailure(failure: PackageInstallFailure): string {
	// 按持久或临时来源选择可操作的说明文字。
	const hint =
		// 临时 CLI 资源不一定被写入 settings.json，不能统一建议从设置删除。
		failure.scope === "temporary"
			? "Check the source and try again."
			: `Run "${APP_NAME} remove ${failure.source}${failure.scope === "project" ? " --local" : ""}" to remove it from settings.json.`;
	// 把实际安装失败原因与对应建议组合，不丢掉原始原因。
	return `failed to install (${failure.message}). ${hint}`;
}

/** One-line startup warning for a package that could not be installed. */
// 为启动界面格式化一条包失败警告，输入失败记录，返回带来源名的单行文字，无副作用。
// 例如 npm:demo 的失败会保留包名和是否需要 --local 的建议，不自动重试。
export function formatPackageInstallWarning(failure: PackageInstallFailure): string {
	// 调用统一详情格式，启动输出与扩展诊断保持同一种移除建议。
	return `Extension package "${failure.source}": ${describePackageInstallFailure(failure)}`;
}

// 合并多批可选安装失败，返回扩展警告形状数组，不发网络请求；例如设置包和临时 -e 包都可贡献诊断。
// ...failures 是剩余参数，每个实参可为失败数组或 undefined。
function collectPackageInstallWarnings(
	// 剩余参数收集为数组，允许某批次没有 installFailures 字段。
	...failures: Array<PackageInstallFailure[] | undefined>
): Array<{ path: string; warning: string }> {
	// 每批失败先映射，再 flatMap 摊成一维警告数组。
	return failures.flatMap((entries) =>
		// 缺省批次用空数组，path 这里是包来源标识，不一定是磁盘文件路径。
		(entries ?? []).map((failure) => ({ path: failure.source, warning: describePackageInstallFailure(failure) })),
	);
}

// 将新增警告合入扩展加载结果，按 path 去重并原地更新 result.warnings，无返回。
// 例如同一包路径多次产生警告时后面的文字覆盖旧值；它不是按“路径+警告内容”保留多条。
function mergeExtensionWarnings(
	result: LoadExtensionsResult,
	warnings: Array<{ path: string; warning: string }>,
): void {
	// 用新数组替换结果里的警告集合，不修改传入 warnings 数组。
	result.warnings = [
		// 旧项在前、新项在后，以 path 为 Map 键；后值覆盖同键但首次键插入顺序保留。
		...new Map([...(result.warnings ?? []), ...warnings].map((warning) => [warning.path, warning])).values(),
	];
}

// Exclude 从联合类型中排除裸工厂函数，得到带名称/标记的对象形式；只在类型检查期存在。
type BuiltinExtension = Exclude<InlineExtension, ExtensionFactory>;

/** Built-in extensions supply the code of `builtin:<name>` extension paths (see `InlineExtension`). */
// 判别内联资源是否为带 builtin=true 的对象，返回类型谓词，不加载扩展。
// 例如裸 factory 函数返回 false，命名内置对象为 true；谓词成立后可安全读取 name/factory。
export function isBuiltinExtension(input: InlineExtension): input is BuiltinExtension {
	// 先区分合法联合中的函数和对象，再严格检查布尔内置标志。
	return typeof input !== "function" && input.builtin === true;
}

/**
 * Leave out replaceable extensions (see `InlineExtension`) that share a tool, command, or flag name
 * with another extension. For example, a third-party MCP extension that registers `/mcp` replaces
 * the built-in MCP extension instead of both connecting the same servers.
 */
// 过滤被非 replaceable 扩展占用名称的可替换扩展，输入已加载扩展与可选警告容器，返回保留数组。
// 按工具/命令/flag 三种名称空间比对；例如第三方非可替换 /mcp 出现时，内置可替换 MCP 被整项排除。
// 两个都标 replaceable 的扩展不会互相占 taken；此时初始化代码已执行，过滤不等于撤销它已经产生的副作用。
function omitReplacedExtensions(
	extensions: Extension[],
	warnings?: Array<{ path: string; warning: string }>,
): Extension[] {
	// 局部箭头函数把扩展注册项转成带种类前缀的占用键，不把 tool:foo 与 command:foo 混为一类。
	const names = (extension: Extension) => [
		// Map.keys 先展开数组，再把每个工具名加 tool: 前缀。
		...[...extension.tools.keys()].map((name) => `tool:${name}`),
		// 命令名独立加 command: 前缀参与替换判定。
		...[...extension.commands.keys()].map((name) => `command:${name}`),
		// 命令行 flag 独立加 flag: 前缀。
		...[...extension.flags.keys()].map((name) => `flag:${name}`),
	];
	// 只登记不可替换扩展占用的键，可替换扩展稍后检查是否撞上它们。
	const taken = new Map(
		extensions
			// 普通/第三方等未标可替换项成为占位者。
			.filter((extension) => !extension.replaceable)
			// 每个键映射所属扩展；as const 保持二元组形状供 Map 推断。
			.flatMap((extension) => names(extension).map((name) => [name, extension] as const)),
	);
	// 创建保留数组，不就地 splice 原扩展列表。
	return extensions.filter((extension) => {
		// 非可替换项即使重名也保留，其他冲突诊断另处理。
		if (!extension.replaceable) return true;
		// 检查本可替换扩展注册的任一名字是否已被占用。
		const replacement = names(extension)
			// 把注册键与可能占用者配成对象。
			.map((name) => ({ name, extension: taken.get(name) }))
			// find 返回首个实际占用者；类型谓词让后面可直接访问 replacement.extension。
			.find((value): value is { name: string; extension: Extension } => value.extension !== undefined);
		// 没有碰撞则仍加载该可替换扩展。
		if (!replacement) return true;
		// 被替换的是内置路径时补专门用户提示；其他可替换扩展同样被过滤但不加这条提示。
		if (extension.path.startsWith(BUILTIN_PATH_PREFIX)) {
			// 去掉 builtin: 前缀取得内置显示名。
			const builtinName = extension.path.slice(BUILTIN_PATH_PREFIX.length);
			// 数组解构拿注册种类和名字，最多分两段。
			const [kind, rawName] = replacement.name.split(":", 2);
			// 命令展示 /，flag 展示 --，工具名直接展示。
			const registeredName = kind === "command" ? `/${rawName}` : kind === "flag" ? `--${rawName}` : rawName;
			// 只有调用者提供警告数组才追加；?. 避免未提供时访问 push。
			warnings?.push({
				path: extension.path,
				warning: `Extension ${replacement.extension.path} registers ${kind} \`${registeredName}\`, so built-in extension \`${builtinName}\` was not loaded. To use \`${builtinName}\`, run \`pi config\` and make sure it is enabled under Built-in extensions, then disable or remove the existing extension. We recommend only having one or the other loaded at a time.`,
			});
		}
		// 当前可替换项被其他不可替换项占用名称，最终保留列表排除它。
		return false;
	});
}

// 上层依赖的资源查询/重载接口；get 返回已加载快照，reload 才执行发现和扩展初始化。
export interface ResourceLoader {
	getExtensions(): LoadExtensionsResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
	getSystemPrompt(): string | undefined;
	getSystemPromptSource(): { path: string } | undefined;
	getAppendSystemPrompt(): string[];
	getAppendSystemPromptSources(): Array<{ path: string }>;
	extendResources(paths: ResourceExtensionPaths): void;
	reload(options?: ResourceLoaderReloadOptions): Promise<void>;
}

// 把系统提示词输入按“若路径存在则读文件，否则当正文”解释，输入可缺省文字和警告描述，返回正文或 undefined。
// 例如 input=hello 且无同名路径，就直接作为提示词；读文件失败会警告并回退原 input，而不是统一抛错。
// 这里没有按 cwd 解析相对路径，existsSync/readFileSync 采用进程的文件路径语义。
function resolvePromptInput(input: string | undefined, description: string): string | undefined {
	// 缺值或空串在这一资源输入入口视为未提供。
	if (!input) {
		return undefined;
	}

	// 只有当前存在的路径才尝试读取，同名普通正文若恰好是文件名也会被当作文件。
	if (existsSync(input)) {
		try {
			// 读整个文件并去掉 BOM，不去 YAML 头，也不在这里生成摘要。
			return stripBom(readFileSync(input, "utf-8"));
		} catch (error) {
			// 读取失败直接输出黄色警告；这与返回结构化 ResourceDiagnostic 的资源加载路径不同。
			console.error(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`));
			// 未读成文件就保留原输入作为文字，调用方可能继续把它用于系统提示词。
			return input;
		}
	}

	// 未读成文件就保留原输入作为文字，调用方可能继续把它用于系统提示词。
	return input;
}

// 在一个目录内按固定候选顺序找首个可读项目说明，返回路径/全文或 null；同步读取，不判断项目信任。
// 例如 AGENTS.override.md 优先于 AGENTS.md，再考虑大小写变体和 CLAUDE.md；同目录只采用一个成功候选，不合并全部文件。
function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	// 候选顺序就是同目录优先级，override 存在且可读就遮住其他候选。
	const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	// 按明确候选顺序查找，不依赖 readdir 的不确定顺序。
	for (const filename of candidates) {
		// 拼本层上下文文件路径。
		const filePath = join(dir, filename);
		// 存在才尝试 stat/读取，不对缺省候选制造警告。
		if (existsSync(filePath)) {
			try {
				// 目录等同名项不是上下文文件，继续尝试下一候选。
				if (!statSync(filePath).isFile()) {
					continue;
				}
				return {
					path: filePath,
					// 保留说明全文，去 BOM；不解析 Markdown 或把文字当代码执行。
					content: stripBom(readFileSync(filePath, "utf-8")),
				};
			} catch (error) {
				// 某候选失败只警告，仍可尝试这个目录的下一候选。
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	return null;
}

/**
 * The main repo's context file that a nested linked worktree's own copy shadows: both
 * occupy the same logical repository scope, so loading both applies that context twice. Returns
 * undefined when nothing is shadowed, leaving normal ancestor inheritance alone.
 *
 * Returned canonicalized (realpath), because `git worktree add` writes the `.git`
 * file's `gitdir:` target in realpath form while cwd may still be symlinked
 * (macOS `/tmp` -> `/private/tmp`).
 */
// 识别嵌套 linked worktree 对主仓库同作用域说明的遮蔽，输入 cwd，返回应跳过的主仓库文件路径或 undefined。
// 例如 repo/feature 是 repo 的 worktree，feature 自有 AGENTS.md 时不再同时继承 repo 同名文件；普通仓库/兄弟 worktree 不跳过祖先说明。
// 使用实际路径处理符号链接，并排除 bare/submodule 布局；会读 Git 元信息和上下文候选，非修改操作。
function findShadowedContextFile(cwd: string): string | undefined {
	// 向祖先找 .git 文件/目录，并解析 worktree 的 gitdir/commondir。
	const gitPaths = findGitPaths(cwd);
	// 不在可识别仓库内就不应用这个特例。
	if (!gitPaths) return undefined;
	// 解析 Git 公共目录的真实路径，读取失败时助手会回退原路径。
	const commonGitDir = canonicalizePath(gitPaths.commonGitDir);
	// 将当前 worktree 根也规范到实际路径，避免 /tmp 等别名比较失配。
	const worktreeRoot = canonicalizePath(gitPaths.repoDir);
	// 普通布局下公共 .git 的父目录是主工作树根；下面还要进一步验证布局。
	const mainRepoRoot = dirname(commonGitDir);
	// False for an ordinary repo, where the two are the same dir, and for a sibling
	// worktree (`git worktree add ../feat`), whose main repo is not an ancestor.
	// 只有严格嵌套到主根之下的另一工作树才可能重复继承同作用域说明。
	if (!isPathWithin(mainRepoRoot, worktreeRoot) || pathsEqual(worktreeRoot, mainRepoRoot)) return undefined;
	// dirname of the common git dir is the main worktree root only when that dir is
	// itself checked out from the same repo. In a bare layout (`proj/.bare` +
	// `proj/main`) it is just the directory holding `.bare`, which tracks nothing; a
	// submodule's gitdir has no `commondir`, so it lands under `.git/modules`.
	// 确认主根自己的 .git 确实对应公共目录，排除 bare 等不成立的推断。
	if (!pathsEqual(canonicalizePath(join(mainRepoRoot, ".git")), commonGitDir)) return undefined;
	// worktree 自己必须有可读说明，才存在遮蔽主根同名候选的问题。
	const worktreeContextFile = loadContextFileFromDir(worktreeRoot);
	// 用 worktree 实际采用候选的文件名定位主根要跳过的同名说明。
	return worktreeContextFile ? join(mainRepoRoot, basename(worktreeContextFile.path)) : undefined;
}

// 收集系统提示词的说明文件，输入 cwd/agentDir，返回路径和全文数组；同步读文件，不作模型调用。
// 先用户 agentDir 说明，再从文件系统根到 cwd 的各祖先说明，每层只取首个成功候选，并处理嵌套 worktree 遮蔽。
// 例如根/仓库/子目录三层说明都可进入材料；此函数不自行检查 projectTrusted，也不把这些文本当作扩展代码执行。
export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
}): Array<{ path: string; content: string }> {
	// 把传入 cwd 解析为绝对起点，之后沿父目录回溯到文件系统根。
	const resolvedCwd = resolvePath(options.cwd);
	// 用户级说明根是 agent 配置目录，不是当前项目目录。
	const resolvedAgentDir = resolvePath(options.agentDir);

	// 按最终重放顺序收集全文材料，类型约束每项含来源路径和内容。
	const contextFiles: Array<{ path: string; content: string }> = [];
	// 按已记录的路径字符串去重，不泛化为任意符号链接都只读一次。
	const seenPaths = new Set<string>();

	// 先找用户级 AGENTS/CLAUDE 候选。
	const globalContext = loadContextFileFromDir(resolvedAgentDir);
	// 可读用户说明放在祖先/项目说明之前。
	if (globalContext) {
		// 先加入用户说明，后面祖先链说明追加其后。
		contextFiles.push(globalContext);
		// 记录该路径，避免回溯目录恰好命中同一文字路径时重复。
		seenPaths.add(globalContext.path);
	}

	// 单独收集祖先链，回溯时用 unshift 恢复根到近目录的顺序。
	const ancestorContextFiles: Array<{ path: string; content: string }> = [];

	// 预先算嵌套 worktree 该排除的同作用域主仓库说明。
	const shadowedContextFile = findShadowedContextFile(resolvedCwd);
	// 从最靠近当前任务的位置开始向父目录找。
	let currentDir = resolvedCwd;

	// 一直回溯，直到 dirname 返回自身即文件系统根。
	while (true) {
		// 当前层只取一份成功说明，缺少则继续向祖先找。
		const contextFile = loadContextFileFromDir(currentDir);
		// Compare the directory's real path, not the file's: a worktree AGENTS.md that
		// symlinks to the main repo's file resolves to the shadowed path itself.
		// 判断本层文件是否属于前面识别的主仓库遮蔽位置。
		const isShadowed =
			// 只有确实存在遮蔽规则时才可能跳过。
			shadowedContextFile !== undefined &&
			// 当前层也必须实际找到文件。
			contextFile !== null &&
			// 比较目录真实路径加文件名，不能直接 realpath 文件，否则 worktree 链接到主文件会被误排除。
			pathsEqual(join(canonicalizePath(currentDir), basename(contextFile.path)), shadowedContextFile);
		// 存在、非遮蔽、未按该路径记录时才继承此说明。
		if (contextFile && !isShadowed && !seenPaths.has(contextFile.path)) {
			// 回溯方向是近到远，插入开头使最终顺序成为远到近。
			ancestorContextFiles.unshift(contextFile);
			// 登记已收录路径，避免与用户级根恰好重合。
			seenPaths.add(contextFile.path);
		}

		// 计算上一层目录，不执行 git 命令。
		const parentDir = dirname(currentDir);
		// 文件系统根的父目录还是自身，到这里结束回溯。
		if (parentDir === currentDir) break;
		// 将游标移到祖先，继续查该层候选。
		currentDir = parentDir;
	}

	// 用户说明之后展开加入从根到 cwd 的各层说明。
	contextFiles.push(...ancestorContextFiles);

	// 交给系统提示词渲染层包装，未在资源发现阶段生成模型回答。
	return contextFiles;
}

// 默认资源加载器配置；显式路径、禁用发现开关、内联工厂和各资源覆盖回调分别控制不同阶段。
export interface DefaultResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	settingsManager?: SettingsManager;
	eventBus?: EventBus;
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	extensionFactories?: InlineExtension[];
	noExtensions?: boolean;
	/** Built-in extensions not to load, by name (such as `mcp`), even when settings or `-e` enable them. */
	disabledBuiltinExtensions?: string[];
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

// 默认协调器整合包管理器、扩展执行、技能/模板/主题及说明文件；构造仅初始化状态，reload 才真正发现资源。
// 来源标签用于追踪；扩展初始化会运行代码，技能/模板读取只解析材料，不应混为同一个安全或执行边界。
export class DefaultResourceLoader implements ResourceLoader {
	// 当前项目工作目录，普通显式资源相对路径以它为解析基准。
	private cwd: string;
	// 用户级agent配置根，承载全局设置及默认资源子目录。
	private agentDir: string;
	// 共享设置实例，决定当前项目可信状态和资源配置；未注入时构造文件后端实例。
	private settingsManager: SettingsManager;
	// 扩展共享事件总线，便于同一会话中的扩展互相通信。
	private eventBus: EventBus;
	// 包/本地/自动资源发现解析器，先产出路径、来源和enabled，再交具体加载器。
	private packageManager: DefaultPackageManager;
	// 显式CLI扩展来源，可为文件或npm/git等包源，临时解析不写持久配置。
	private additionalExtensionPaths: string[];
	// 额外技能文件/目录，排在已选CLI/常规技能路径后，noSkills仍保留这类明确输入。
	private additionalSkillPaths: string[];
	// 额外模板路径，实际读取Markdown正文，参数等输入命令时才替换。
	private additionalPromptTemplatePaths: string[];
	// 额外主题JSON/目录，关闭常规发现也不移除明确来源。
	private additionalThemePaths: string[];
	// 普通内联扩展工厂列表，初始化会执行代码，并以人工路径追踪来源。
	private extensionFactories: InlineExtension[];
	// 宿主可用内置工厂的name索引，builtin:name只有最终加载阶段才执行。
	private builtinExtensions: Map<string, BuiltinExtension>;
	// 关闭常规扩展发现；明确CLI -e项仍可加载，内置禁用另有名字集合。
	private noExtensions: boolean;
	// 显式禁止内置名的集合，优先于设置与CLI启用该内置项。
	private disabledBuiltinExtensions: Set<string>;
	// 关闭常规技能发现，明确CLI/额外技能路径仍会处理。
	private noSkills: boolean;
	// 关闭常规模板发现，不表示忽略全部显式模板路径。
	private noPromptTemplates: boolean;
	// 关闭常规主题发现，明确主题路径仍可读取。
	private noThemes: boolean;
	// 显式关闭用户/祖先AGENTS等说明材料，不与扩展代码加载开关混用。
	private noContextFiles: boolean;
	// 构造时保存的系统输入来源，重载时才按现存文件或文字解析。
	private systemPromptSource?: string;
	// 构造时保存的追加来源数组，空数组也能明确阻止默认追加文件发现。
	private appendSystemPromptSource?: string[];
	private extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	private skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	private promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	private themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	private agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	private systemPromptOverride?: (base: string | undefined) => string | undefined;
	private appendSystemPromptOverride?: (base: string[]) => string[];

	// 本批成功扩展、错误、警告与共享runtime，getter返回同一结果引用。
	private extensionsResult: LoadExtensionsResult;
	// 已解析技能元信息目录，不含完整SKILL.md正文；完整说明后续按需读。
	private skills: Skill[];
	// 本批技能文件/字段问题与名称碰撞诊断。
	private skillDiagnostics: ResourceDiagnostic[];
	// 本批按命令名去重后的模板正文与元信息，尚未替换参数。
	private prompts: PromptTemplate[];
	// 本批模板读取/解析/名称碰撞问题。
	private promptDiagnostics: ResourceDiagnostic[];
	// 已按当前颜色模式构建并按名字去重的主题对象。
	private themes: Theme[];
	// 本批主题读取、JSON构建和名称碰撞问题。
	private themeDiagnostics: ResourceDiagnostic[];
	// 按用户说明→远祖先→近项目顺序保存的路径和全文材料。
	private agentsFiles: Array<{ path: string; content: string }>;
	// 本批解析/覆盖后的自定义前言，不等于已拼项目/技能的最终系统消息。
	private systemPrompt?: string;
	// 原输入确实对应现存文件时记录来源路径，覆盖回调不重新推断来源。
	private systemPromptSourcePath?: string;
	// 本批解析/覆盖后的追加正文数组，供上层按顺序加入系统提示。
	private appendSystemPrompt: string[];
	// 追加输入中实际存在的文件路径列表，纯文字来源不在其中。
	private appendSystemPromptSourcePaths: string[];
	// 最近一次完整技能路径顺序，extendResources以它为基础继续合并。
	private lastSkillPaths: string[];
	// 扩展贡献技能的根路径→来源索引，子文件可继承首个匹配根。
	private extensionSkillSourceInfos: Map<string, SourceInfo>;
	// 扩展贡献模板来源，优先于通用包元数据索引。
	private extensionPromptSourceInfos: Map<string, SourceInfo>;
	// 扩展贡献主题来源，后续补到构建的Theme对象。
	private extensionThemeSourceInfos: Map<string, SourceInfo>;
	// 包管理器本批给出的路径元数据，保存到实例供extendResources继续查来源。
	private resourceMetadataByPath: Map<string, PathMetadata>;
	// 最近一批模板路径，额外扩展贡献不必重做全部包解析。
	private lastPromptPaths: string[];
	// 最近一批主题路径，后续贡献会重建这一类主题列表。
	private lastThemePaths: string[];
	// 是否走完过一次reload，用于下一轮是否清扩展缓存，不代表每个资源都成功。
	private loaded: boolean;

	// 初始化加载器及依赖，输入 cwd/agentDir 和可选资源开关/覆盖函数；无返回，尚不加载扩展或解析全部资源。
	// 例如未传 SettingsManager 时创建文件设置实例，可能读取设置；技能数组此时为空，要 await reload 才有本批结果。
	constructor(options: DefaultResourceLoaderOptions) {
		// 保存绝对工作目录，后续显式资源相对路径以它为基准。
		this.cwd = resolvePath(options.cwd);
		// 保存用户级 agent 数据根，默认资源位于其各子目录。
		this.agentDir = resolvePath(options.agentDir);
		// 优先复用注入设置，缺省才创建文件存储设置；?? 不覆盖已传对象。
		// 保存调用方选项：共享设置实例，决定当前项目可信状态和资源配置；未注入时构造文件后端实例。
		this.settingsManager = options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
		// 优先使用注入事件总线，让本批扩展共享同一通信对象。
		// 保存调用方选项：扩展共享事件总线，便于同一会话中的扩展互相通信。
		this.eventBus = options.eventBus ?? createEventBus();
		// 内联/内置工厂输入缺省为空，后面分为两类调度。
		const factories = options.extensionFactories ?? [];
		// 普通内联扩展之后按工厂加载；内置项先不放进这个数组。
		this.extensionFactories = factories.filter((input) => !isBuiltinExtension(input));
		// 按内置名索引工厂，以后 builtin:name 路径可取其代码；重名 Map 最后输入覆盖前值。
		this.builtinExtensions = new Map(factories.filter(isBuiltinExtension).map((input) => [input.name, input]));
		// 创建资源来源解析器，它负责设置包/自动目录/资源开关，可能在 resolve 阶段安装缺包。
		this.packageManager = new DefaultPackageManager({
			// 向下传同一绝对工作目录，不改变进程 cwd。
			cwd: this.cwd,
			// 向下传同一用户数据目录，保证不同资源类型采用一致根。
			agentDir: this.agentDir,
			// 包解析器与加载器共享设置和 projectTrusted 状态。
			settingsManager: this.settingsManager,
			// 只把可用内置名字告诉包解析器，不在构造时执行其工厂。
			builtinExtensions: [...this.builtinExtensions.keys()],
		});
		// 保存调用方选项：显式CLI扩展来源，可为文件或npm/git等包源，临时解析不写持久配置。
		this.additionalExtensionPaths = options.additionalExtensionPaths ?? [];
		// 保存调用方选项：额外技能文件/目录，排在已选CLI/常规技能路径后，noSkills仍保留这类明确输入。
		this.additionalSkillPaths = options.additionalSkillPaths ?? [];
		// 保存调用方选项：额外模板路径，实际读取Markdown正文，参数等输入命令时才替换。
		this.additionalPromptTemplatePaths = options.additionalPromptTemplatePaths ?? [];
		// 保存调用方选项：额外主题JSON/目录，关闭常规发现也不移除明确来源。
		this.additionalThemePaths = options.additionalThemePaths ?? [];
		// 保存调用方选项：关闭常规扩展发现；明确CLI -e项仍可加载，内置禁用另有名字集合。
		this.noExtensions = options.noExtensions ?? false;
		// 把显式禁止内置项的名字存成 Set，undefined 输入会创建空集合。
		this.disabledBuiltinExtensions = new Set(options.disabledBuiltinExtensions);
		// 保存调用方选项：关闭常规技能发现，明确CLI/额外技能路径仍会处理。
		this.noSkills = options.noSkills ?? false;
		// 保存调用方选项：关闭常规模板发现，不表示忽略全部显式模板路径。
		this.noPromptTemplates = options.noPromptTemplates ?? false;
		// 保存调用方选项：关闭常规主题发现，明确主题路径仍可读取。
		this.noThemes = options.noThemes ?? false;
		// 保存调用方选项：显式关闭用户/祖先AGENTS等说明材料，不与扩展代码加载开关混用。
		this.noContextFiles = options.noContextFiles ?? false;
		// 保存调用方选项：构造时保存的系统输入来源，重载时才按现存文件或文字解析。
		this.systemPromptSource = options.systemPrompt;
		// 保存调用方选项：构造时保存的追加来源数组，空数组也能明确阻止默认追加文件发现。
		this.appendSystemPromptSource = options.appendSystemPrompt;
		this.extensionsOverride = options.extensionsOverride;
		this.skillsOverride = options.skillsOverride;
		this.promptsOverride = options.promptsOverride;
		this.themesOverride = options.themesOverride;
		this.agentsFilesOverride = options.agentsFilesOverride;
		this.systemPromptOverride = options.systemPromptOverride;
		this.appendSystemPromptOverride = options.appendSystemPromptOverride;

		// 创建空结果和运行时，查询可以先得到空状态，而不是隐式触发加载。
		this.extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
		this.skills = [];
		this.skillDiagnostics = [];
		this.prompts = [];
		this.promptDiagnostics = [];
		this.themes = [];
		this.themeDiagnostics = [];
		this.agentsFiles = [];
		this.appendSystemPrompt = [];
		this.appendSystemPromptSourcePaths = [];
		this.lastSkillPaths = [];
		this.extensionSkillSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();
		// 新一轮重新建立来源索引，实例保存供之后 extendResources 复用。
		this.resourceMetadataByPath = new Map();
		this.lastPromptPaths = [];
		this.lastThemePaths = [];
		// 记录是否已成功完成过 reload，用于下一次是否清扩展缓存。
		this.loaded = false;
	}

	// 查询当前已加载扩展结果，无输入/读盘；例如 reload 前是空扩展和初始 runtime，返回内部对象引用。
	getExtensions(): LoadExtensionsResult {
		// 不复制结果，调用方需遵守共享对象约定。
		return this.extensionsResult;
	}

	// 查询本批技能元信息/诊断，不读正文；例如文件变化后需 reload 或 extendResources 才更新，返回数组引用。
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		// 新建外层结果对象，内部数组仍共享。
		return { skills: this.skills, diagnostics: this.skillDiagnostics };
	}

	// 查询已解析模板及诊断，无 I/O；例如返回模板正文仍含 $1，实际输入时才展开参数。
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		// 返回当前模板/诊断数组引用，不重新扫描文件。
		return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
	}

	// 查询已构建主题与诊断，无输入/扫描；例如资源冲突时返回去重后主题及胜败诊断。
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		// 返回共享主题对象和诊断数组，未深复制。
		return { themes: this.themes, diagnostics: this.themeDiagnostics };
	}

	// 查询已读取的用户/祖先说明全文，无 I/O；例如系统提示词构建器用这些 path/content 包装材料段。
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
		// 只包装当前已加载数组，未在查询时验证信任或读新文件。
		return { agentsFiles: this.agentsFiles };
	}

	// 返回解析/覆盖后的自定义系统前言文字，可能未设置；无 I/O，不等于已经拼上项目/技能的最终系统消息。
	getSystemPrompt(): string | undefined {
		// 读取本批缓存的自定义系统提示文字。
		return this.systemPrompt;
	}

	// 查询系统提示来自哪个实际文件，文字直接输入则可能无来源路径；不会再次读取内容。
	getSystemPromptSource(): { path: string } | undefined {
		// 只有记录了实际存在的来源文件才返回路径对象。
		return this.systemPromptSourcePath ? { path: this.systemPromptSourcePath } : undefined;
	}

	// 查询已解析附加系统文字数组；例如多个显式追加来源按输入顺序保留，无读取副作用。
	getAppendSystemPrompt(): string[] {
		// 直接返回内部数组引用，后续是否拼接由上层负责。
		return this.appendSystemPrompt;
	}

	// 查询附加文字中的实际文件来源，纯文字项不产生文件路径；返回新描述数组，无 I/O。
	getAppendSystemPromptSources(): Array<{ path: string }> {
		// 把保存路径映射为新对象，不暴露内部路径数组本身。
		return this.appendSystemPromptSourcePaths.map((path) => ({ path }));
	}

	// 在已有资源基础上加入扩展贡献路径，输入带来源的技能/模板/主题路径，无返回。
	// 先规范路径和记元数据，再与最近一批路径合并、同步重新解析对应资源；例如扩展新增技能目录立即更新技能列表。
	// 不会重新执行扩展加载或全量 reload；文件 I/O/覆盖回调可能抛错。
	extendResources(paths: ResourceExtensionPaths): void {
		// 每类输入先统一为绝对路径及规范 baseDir，缺省列表为空。
		const skillPaths = this.normalizeExtensionPaths(paths.skillPaths ?? []);
		// 模板贡献与技能分开追踪，避免类型间混用路径。
		const promptPaths = this.normalizeExtensionPaths(paths.promptPaths ?? []);
		// 主题贡献也独立规范化。
		const themePaths = this.normalizeExtensionPaths(paths.themePaths ?? []);

		// 记录扩展贡献技能来源，以后子路径匹配也可追溯到这个来源。
		for (const entry of skillPaths) {
			// 路径为键保存 SourceInfo，后续同路径贡献覆盖该来源记录。
			this.extensionSkillSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		// 同样记录模板贡献来源。
		for (const entry of promptPaths) {
			// 模板来源独立保存，不借用技能的映射表。
			this.extensionPromptSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		// 记录主题贡献来源。
		for (const entry of themePaths) {
			// 主题文件来源后续补到构建出的 Theme 对象。
			this.extensionThemeSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}

		// 没有新技能路径时不重复解析技能，其他资源各自判断。
		if (skillPaths.length > 0) {
			// 以之前路径为主、新贡献在后，按规范实际路径键去重。
			this.lastSkillPaths = this.mergePaths(
				this.lastSkillPaths,
				// 只取规范化路径，来源已在前面的 Map 里单独登记。
				skillPaths.map((entry) => entry.path),
			);
			// 用合并后全部技能路径重新解析/去重，再按来源映射补元数据。
			this.updateSkillsFromPaths(this.lastSkillPaths, this.resourceMetadataByPath);
		}

		// 只在确实有模板贡献时重建模板列表。
		if (promptPaths.length > 0) {
			// 保留之前模板优先顺序，再追加未出现的新路径。
			this.lastPromptPaths = this.mergePaths(
				this.lastPromptPaths,
				// 抽出模板路径供实际文件加载。
				promptPaths.map((entry) => entry.path),
			);
			// 重新读模板并解决名称冲突，来源元数据沿本轮索引补齐。
			this.updatePromptsFromPaths(this.lastPromptPaths, this.resourceMetadataByPath);
		}

		// 只对本次实际新增主题贡献触发主题重建。
		if (themePaths.length > 0) {
			// 合并旧主题路径和新贡献，路径重复时旧位置优先。
			this.lastThemePaths = this.mergePaths(
				this.lastThemePaths,
				// 取主题路径字段，不把来源对象当文件名。
				themePaths.map((entry) => entry.path),
			);
			// 按当前终端颜色模式重新构建主题与诊断。
			this.updateThemesFromPaths(this.lastThemePaths, this.resourceMetadataByPath);
		}
	}

	// 为项目信任流程做引导加载，先强制不信任项目并重读设置，再加载用户/临时与普通内联扩展，返回结果。
	// 例如全局提供信任确认界面的扩展可先注册，项目自己的包/自动扩展暂不参与；加载扩展会执行初始化代码，不是只列目录。
	async loadProjectTrustExtensions(): Promise<LoadExtensionsResult> {
		// Force untrusted project settings for the bootstrap pass. This keeps project-local
		// extensions/packages out while still loading user/global and temporary CLI extensions.
		// 主动关闭项目设置层，避免项目通过设置包参与自己的信任引导。
		this.settingsManager.setProjectTrusted(false);
		// 先等待设置排队写入，再重读当前信任状态可用的设置；引导时项目层被排除。
		await this.settingsManager.reload();
		// 引导批次包含普通内联工厂，内置扩展仍等最终项目开关明确后再加载。
		return this.loadCurrentExtensionSet({ includeInlineFactories: true });
	}

	// 异步全量重建资源，输入可选信任回调，无返回；更新本实例结果、可能安装包/读取文件/执行扩展。
	// 先清旧缓存→可选引导扩展与项目信任→重读设置→解析包和CLI资源→加载最终扩展→技能/模板/主题→说明文件和系统文字。
	// 例如 -e 资源排在设置资源前，noSkills 关闭常规发现但保留显式技能；失败诊断可局部保留，未被捕获异常仍会拒绝 Promise。
	async reload(options?: ResourceLoaderReloadOptions): Promise<void> {
		// 重置扩展加载计时指标，不重置已保存用户设置。
		resetTimings("extensions");

		// 已经加载过才在新一轮清扩展模块缓存，首次无需清理。
		if (this.loaded) {
			// 让重载重新求值扩展代码；它不承诺自动撤销旧扩展已产生的外部副作用。
			clearExtensionCache();
		}

		// 可选保存信任引导阶段已执行的扩展，最终阶段复用，避免重复初始化。
		let preTrustExtensions: LoadExtensionsResult | undefined;
		// 仅上层提供授权回调时才做两阶段引导流程。
		if (options?.resolveProjectTrust) {
			// 先以项目不可信状态初始化允许的扩展，结果交回调使用。
			preTrustExtensions = await this.loadProjectTrustExtensions();
			// 等待上层决定信任；本模块不根据文件名/来源标签自动授权。
			const projectTrusted = await options.resolveProjectTrust({ extensionsResult: preTrustExtensions });
			// 同步设置新的项目开关，后续设置读取和包自动发现按它执行。
			this.settingsManager.setProjectTrusted(projectTrusted);
		}

		// reload() preserves SettingsManager.projectTrusted and reloads settings for that trust state.
		// 先等待设置排队写入，再重读当前信任状态可用的设置；引导时项目层被排除。
		await this.settingsManager.reload();
		// 解析设置包/本地/自动资源；包管理器可能安装缺失依赖，并返回逐资源 enabled 和来源。
		const resolvedPaths = await this.packageManager.resolve();
		// 单独解析 CLI -e 来源，包不仅可能贡献扩展，还能贡献技能/模板/主题。
		const cliExtensionPaths = await this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {
			// CLI 资源标为临时作用域，不写入持久包设置。
			temporary: true,
		});
		// 把设置与CLI包安装失败统一转成扩展诊断，成功资源仍可继续。
		const installWarnings = collectPackageInstallWarnings(
			resolvedPaths.installFailures,
			cliExtensionPaths.installFailures,
		);
		// Kept on the instance so post-reload passes (extendResources) can still resolve package metadata.
		// 新一轮重新建立来源索引，实例保存供之后 extendResources 复用。
		this.resourceMetadataByPath = new Map();
		// 局部别名指向同一 Map，后续写入也能被扩展贡献阶段看到。
		const metadataByPath = this.resourceMetadataByPath;

		this.extensionSkillSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();

		// Helper to extract enabled paths and store metadata
		// 局部筛选器先记所有来源，再返回启用资源；未启用项也可保留来源追踪，不会被加载。
		const getEnabledResources = (resources: ResolvedResource[]): ResolvedResource[] => {
			// 逐项处理包管理器已经解析的路径，不在这里再次解析包源。
			for (const r of resources) {
				// 同一路径的首次来源优先，后续不无条件覆盖。
				if (!metadataByPath.has(r.path)) {
					// 登记来源，后面的技能子文件也可用路径归属匹配它。
					metadataByPath.set(r.path, r.metadata);
				}
			}
			// 只有 enabled=true 的资源进入加载列表，不把诊断索引等同于启用。
			return resources.filter((r) => r.enabled);
		};

		// 另一个局部箭头函数将启用资源进一步映射成路径数组。
		const getEnabledPaths = (resources: ResolvedResource[]): string[] =>
			// 复用上面的元数据登记，再只取各路径。
			getEnabledResources(resources).map((r) => r.path);
		// 启用的设置/默认扩展路径。
		const enabledExtensions = getEnabledPaths(resolvedPaths.extensions);
		// 技能暂保留元数据对象，因为自动/包目录可能要映射到 SKILL.md。
		const enabledSkillResources = getEnabledResources(resolvedPaths.skills);
		// 启用的常规模板路径。
		const enabledPrompts = getEnabledPaths(resolvedPaths.prompts);
		// 启用的常规主题路径。
		const enabledThemes = getEnabledPaths(resolvedPaths.themes);

		// 包/自动技能目录有 SKILL.md 时改为该文件入口并继承来源，避免无意扫描整个包目录。
		const enabledSkills = enabledSkillResources.map((resource) => this.mapSkillPath(resource, metadataByPath));

		// Add CLI paths metadata
		// 为额外CLI扩展路径补元数据，后面再筛是否启用。
		for (const r of cliExtensionPaths.extensions) {
			// 同一路径的首次来源优先，后续不无条件覆盖。
			if (!metadataByPath.has(r.path)) {
				// 没有既有来源时用临时顶层 CLI 元信息，不覆盖先前已登记项。
				metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
			}
		}
		// CLI 来源也可能包含技能，给它们同样临时标记。
		for (const r of cliExtensionPaths.skills) {
			// 同一路径的首次来源优先，后续不无条件覆盖。
			if (!metadataByPath.has(r.path)) {
				// 没有既有来源时用临时顶层 CLI 元信息，不覆盖先前已登记项。
				metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
			}
		}

		// 只加载CLI包中实际启用的扩展。
		const cliEnabledExtensions = getEnabledPaths(cliExtensionPaths.extensions);
		// 同样选CLI技能，作为优先路径部分。
		const cliEnabledSkills = getEnabledPaths(cliExtensionPaths.skills);
		// 选CLI模板，后面与常规和显式路径合并。
		const cliEnabledPrompts = getEnabledPaths(cliExtensionPaths.prompts);
		// 选CLI主题。
		const cliEnabledThemes = getEnabledPaths(cliExtensionPaths.themes);

		// 扩展优先CLI路径；noExtensions 只排常规发现，不移除明确CLI启用项。
		const extensionPaths =
			// 开启常规加载时按CLI→常规合并并对实际路径键去重。
			(this.noExtensions ? cliEnabledExtensions : this.mergePaths(cliEnabledExtensions, enabledExtensions)).filter(
				(path) =>
					// 普通磁盘扩展不受禁用内置名单影响。
					!path.startsWith(BUILTIN_PATH_PREFIX) ||
					// 内置路径取名字，显式禁用名单优先于设置或CLI启用。
					!this.disabledBuiltinExtensions.has(path.slice(BUILTIN_PATH_PREFIX.length)),
			);

		// 对即将加载的包扩展检查宿主运行时依赖重复问题。
		const packageWarnings = collectExtensionPackageWarnings(extensionPaths, metadataByPath);
		// 复用引导阶段已加载项，按最终路径顺序补其余扩展并处理替换/冲突。
		const extensionsResult = await this.loadFinalExtensionSet(extensionPaths, preTrustExtensions);
		// 把安装/依赖问题附入扩展加载结果，按路径采用后值覆盖去重。
		mergeExtensionWarnings(extensionsResult, [...installWarnings, ...packageWarnings]);
		// 对显式CLI本地扩展输入补缺路径诊断，包标识不按磁盘路径查存在性。
		for (const p of this.additionalExtensionPaths) {
			// 仅对本地写法补这条存在性诊断；非本地来源不在这个分支按文件检查。
			if (isLocalPath(p)) {
				// 以本加载器 cwd 规范化资源路径，synthetic 路径保持原样。
				const resolved = this.resolveResourcePath(p);
				// 额外本地输入确实不存在时给用户明确错误。
				if (!existsSync(resolved)) {
					// 错误只加入诊断，不在这里终止其他资源加载。
					extensionsResult.errors.push({ path: resolved, error: `Extension path does not exist: ${resolved}` });
				}
			}
		}
		// 最后允许上层覆盖整个扩展结果，这种回调可以改变默认加载器的结果约定。
		this.extensionsResult = this.extensionsOverride ? this.extensionsOverride(extensionsResult) : extensionsResult;
		// 把最终扩展来源传播到其工具和命令，便于显示/追踪。
		this.applyExtensionSourceInfo(this.extensionsResult.extensions, metadataByPath);

		// noSkills 时保留CLI包与显式技能路径；否则常规技能插在CLI之后、额外路径之前。
		const skillPaths = this.noSkills
			? // 只关闭常规发现，明确指定技能仍可用。
				this.mergePaths(cliEnabledSkills, this.additionalSkillPaths)
			: // 以给定顺序去重路径，名称冲突再由 loadSkills 首项优先处理。
				this.mergePaths([...cliEnabledSkills, ...enabledSkills], this.additionalSkillPaths);

		// 保存本批完整路径顺序，extendResources 在此基础上继续追加。
		this.lastSkillPaths = skillPaths;
		// 实际读取技能头、名称去重和来源补齐。
		this.updateSkillsFromPaths(skillPaths, metadataByPath);
		// 对额外技能本地路径补用户可见的缺失错误。
		for (const p of this.additionalSkillPaths) {
			// 仅对本地写法补这条存在性诊断；非本地来源不在这个分支按文件检查。
			if (isLocalPath(p)) {
				// 以本加载器 cwd 规范化资源路径，synthetic 路径保持原样。
				const resolved = this.resolveResourcePath(p);
				// 同路径加载器已报过问题时不再补重复缺失诊断。
				if (!existsSync(resolved) && !this.skillDiagnostics.some((d) => d.path === resolved)) {
					// 保留明确错误级别，区别于底层扫描可能给出的 warning。
					this.skillDiagnostics.push({ type: "error", message: "Skill path does not exist", path: resolved });
				}
			}
		}

		// 模板也采用关闭常规但保留显式资源的规则。
		const promptPaths = this.noPromptTemplates
			? // 禁用自动/设置模板时，只保留CLI包与显式模板。
				this.mergePaths(cliEnabledPrompts, this.additionalPromptTemplatePaths)
			: // 正常路径顺序CLI→常规→额外，路径去重后再解决名字碰撞。
				this.mergePaths([...cliEnabledPrompts, ...enabledPrompts], this.additionalPromptTemplatePaths);

		// 保存模板路径，之后扩展贡献可继续合并。
		this.lastPromptPaths = promptPaths;
		// 同步读取模板正文/YAML头、按名称首项优先去重并补来源。
		this.updatePromptsFromPaths(promptPaths, metadataByPath);
		// 额外模板输入若是本地路径，也应有明确缺文件诊断。
		for (const p of this.additionalPromptTemplatePaths) {
			// 仅对本地写法补这条存在性诊断；非本地来源不在这个分支按文件检查。
			if (isLocalPath(p)) {
				// 以本加载器 cwd 规范化资源路径，synthetic 路径保持原样。
				const resolved = this.resolveResourcePath(p);
				// 仅没被底层同路径诊断覆盖时追加错误。
				if (!existsSync(resolved) && !this.promptDiagnostics.some((d) => d.path === resolved)) {
					this.promptDiagnostics.push({
						type: "error",
						message: "Prompt template path does not exist",
						path: resolved,
					});
				}
			}
		}

		// 主题采用同一发现开关语义，显式路径不因 noThemes 全部被移除。
		const themePaths = this.noThemes
			? // 关闭常规主题发现时仍保留明确来源。
				this.mergePaths(cliEnabledThemes, this.additionalThemePaths)
			: // 常规情况下CLI主题先于设置/默认与额外路径，名字冲突首项保留。
				this.mergePaths([...cliEnabledThemes, ...enabledThemes], this.additionalThemePaths);

		// 记住当前主题路径给后续资源扩展使用。
		this.lastThemePaths = themePaths;
		// 按终端颜色能力构建主题并处理重名。
		this.updateThemesFromPaths(themePaths, metadataByPath);
		// 显式主题作为本地路径处理并补缺失诊断。
		for (const p of this.additionalThemePaths) {
			// 以本加载器 cwd 规范化资源路径，synthetic 路径保持原样。
			const resolved = this.resolveResourcePath(p);
			// 已有同路径诊断不重复追加。
			if (!existsSync(resolved) && !this.themeDiagnostics.some((d) => d.path === resolved)) {
				// 保留缺主题位置，其他主题仍可用。
				this.themeDiagnostics.push({ type: "error", message: "Theme path does not exist", path: resolved });
			}
		}

		// 说明文件另外加载，不属于会执行的扩展代码集合。
		const agentsFiles = {
			// noContextFiles 可显式关闭用户/祖先说明收集，这个分支没有额外 projectTrusted 判断。
			agentsFiles: this.noContextFiles
				? []
				: // 开启时读取用户与祖先链说明，规则见独立函数，不只读 .pi 目录。
					loadProjectContextFiles({
						// 向下传同一绝对工作目录，不改变进程 cwd。
						cwd: this.cwd,
						// 向下传同一用户数据目录，保证不同资源类型采用一致根。
						agentDir: this.agentDir,
					}),
		};
		// 允许上层替换说明材料集合，默认发现规则可被明确覆盖。
		const resolvedAgentsFiles = this.agentsFilesOverride ? this.agentsFilesOverride(agentsFiles) : agentsFiles;
		// 保存最终说明全文列表，系统提示词层之后包装它。
		this.agentsFiles = resolvedAgentsFiles.agentsFiles;

		// 显式系统输入优先，未提供才发现项目/用户 SYSTEM.md；?? 使显式空串阻止自动发现。
		const systemPromptSource = this.systemPromptSource ?? this.discoverSystemPromptFile();
		// 存在路径则读文件，否则把输入当文字，解析发生在 reload 而非构造时。
		const baseSystemPrompt = resolvePromptInput(systemPromptSource, "system prompt");
		// 最后允许系统文字覆盖回调，自定义前言还不是完整最终系统消息。
		this.systemPrompt = this.systemPromptOverride ? this.systemPromptOverride(baseSystemPrompt) : baseSystemPrompt;
		// 仅在原来源确实存在于磁盘时记文件来源，便于展示。
		this.systemPromptSourcePath =
			// 直接文字输入没有文件来源；检查存在不保证先前读取一定成功。
			systemPromptSource && existsSync(systemPromptSource) ? resolvePath(systemPromptSource) : undefined;

		// 明确追加来源数组优先；空数组也表示明确不自动发现。
		let appendSources = this.appendSystemPromptSource;
		// 只有没有显式数组时才寻找 APPEND_SYSTEM.md，而非长度为0时。
		if (!appendSources) {
			// 自动追加来源在项目可信时优先项目，否则回退用户文件。
			const discoveredAppendSystemPromptFile = this.discoverAppendSystemPromptFile();
			// 自动发现最多选一份追加文件，并非项目与用户同时合并。
			appendSources = discoveredAppendSystemPromptFile ? [discoveredAppendSystemPromptFile] : [];
		}
		// 逐个把追加来源解释为文件或文字，保留输入顺序。
		const baseAppend = appendSources
			// 本批重载时读取实际文件；错误可警告并回退原输入文字。
			.map((s) => resolvePromptInput(s, "append system prompt"))
			// 类型谓词去掉没有正文的来源，使结果类型收窄为 string[]。
			.filter((s): s is string => s !== undefined);
		// 允许最终覆盖整个追加文字数组。
		this.appendSystemPrompt = this.appendSystemPromptOverride
			? // 有回调就采用其返回值，上层可明确改变默认组合。
				this.appendSystemPromptOverride(baseAppend)
			: // 无覆盖时保存逐来源解析的文字。
				baseAppend;
		// 来源追踪保留原输入中实际存在的文件，不从回调返回文字倒推路径。
		this.appendSystemPromptSourcePaths = appendSources
			// 纯文字或不存在路径不列为文件来源。
			.filter((source) => existsSync(source))
			// 把可列来源路径规范成绝对值。
			.map((source) => resolvePath(source));
		// 全部走到这里才标记成功完成过加载；下一轮会清扩展缓存。
		this.loaded = true;
	}

	// 加载当前设置状态允许的非内置扩展，用于信任引导；输入是否连普通内联工厂一起加载，返回扩展/runtime/诊断。
	// 例如项目不信任时包管理器不读项目配置，用户和临时CLI仍可初始化；内置扩展必须等待最终项目禁用开关确定。
	// 会解析包并执行扩展代码，单扩展错误可进入结果，未捕获包/文件错误仍可抛出。
	private async loadCurrentExtensionSet(options: { includeInlineFactories: boolean }): Promise<LoadExtensionsResult> {
		// 解析设置包/本地/自动资源；包管理器可能安装缺失依赖，并返回逐资源 enabled 和来源。
		const resolvedPaths = await this.packageManager.resolve();
		// 单独解析 CLI -e 来源，包不仅可能贡献扩展，还能贡献技能/模板/主题。
		const cliExtensionPaths = await this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {
			// CLI 资源标为临时作用域，不写入持久包设置。
			temporary: true,
		});
		// 从当前设置结果取启用的非CLI路径。
		const enabledExtensions = resolvedPaths.extensions.filter((r) => r.enabled).map((r) => r.path);
		// CLI来源依旧临时且可优先。
		const cliEnabledExtensions = cliExtensionPaths.extensions.filter((r) => r.enabled).map((r) => r.path);
		// Built-in extensions wait for the final pass: project settings can disable them, and a loaded
		// extension cannot be unloaded.
		// 扩展优先CLI路径；noExtensions 只排常规发现，不移除明确CLI启用项。
		const extensionPaths =
			// 开启常规加载时按CLI→常规合并并对实际路径键去重。
			(this.noExtensions ? cliEnabledExtensions : this.mergePaths(cliEnabledExtensions, enabledExtensions))
				// 信任引导一律暂不执行内置工厂，因为后面的项目设置可能禁用它且已执行扩展无法简单卸载。
				.filter((path) => !path.startsWith(BUILTIN_PATH_PREFIX));
		// 此引导步骤建立本地元数据表，仅用来检查扩展包依赖问题。
		const metadataByPath = new Map(
			[...resolvedPaths.extensions, ...cliExtensionPaths.extensions].map((resource) => [
				resource.path,
				resource.metadata,
			]),
		);
		// 对即将加载的包扩展检查宿主运行时依赖重复问题。
		const packageWarnings = collectExtensionPackageWarnings(extensionPaths, metadataByPath);
		// 把设置与CLI包安装失败统一转成扩展诊断，成功资源仍可继续。
		const installWarnings = collectPackageInstallWarnings(
			resolvedPaths.installFailures,
			cliExtensionPaths.installFailures,
		);
		// 等待顺序加载并初始化磁盘扩展，共享事件总线与返回 runtime。
		const extensionsResult = await loadExtensionsCached(extensionPaths, this.cwd, this.eventBus);
		// 把安装/依赖问题附入扩展加载结果，按路径采用后值覆盖去重。
		mergeExtensionWarnings(extensionsResult, [...installWarnings, ...packageWarnings]);
		// 只需磁盘路径结果时直接返回，避免额外执行内联工厂。
		if (!options.includeInlineFactories) {
			return extensionsResult;
		}

		// 内联工厂使用同一个 runtime 初始化，和磁盘扩展处于同一批执行环境。
		const inlineExtensions = await this.loadExtensionFactories(extensionsResult.runtime);
		// 成功内联扩展排在本批磁盘扩展之后。
		extensionsResult.extensions.push(...inlineExtensions.extensions);
		// 内联失败并入诊断，不伪装成成功扩展。
		extensionsResult.errors.push(...inlineExtensions.errors);
		// 收集可替换内置等被占名时产生的说明。
		const replacementWarnings: Array<{ path: string; warning: string }> = [];
		// 按注册名字排除被替换项，不是依据来源目录盲目覆盖所有扩展。
		extensionsResult.extensions = omitReplacedExtensions(extensionsResult.extensions, replacementWarnings);
		// 将替换解释加入结果警告，按路径保持一份。
		mergeExtensionWarnings(extensionsResult, replacementWarnings);
		return extensionsResult;
	}

	// 规范扩展加载路径，输入字符串，返回路径；builtin:/内联等合成来源不经文件路径 resolve。
	// 例如普通相对路径以 cwd 解析并规范 Unicode 空格；无 I/O。
	private resolveExtensionLoadPath(path: string): string {
		// 合成标识原样保留，只有真实文件输入才做绝对路径解析。
		return isSyntheticPath(path) ? path : resolvePath(path, this.cwd, { normalizeUnicodeSpaces: true });
	}

	// 获得用于扩展复用/去重的键，输入原路径，返回规范实际文件键或合成原标识，无加载副作用。
	// 例如符号链接指向同一扩展会得到相同键，避免信任两遍重复初始化。
	private getExtensionPathKey(path: string): string {
		// 先处理输入路径形式，再跟随可解析真实路径并按平台大小写规则取得比较键。
		return getResourcePathKey(this.resolveExtensionLoadPath(path));
	}

	/** Load extension paths: files from disk and `builtin:<name>` paths from the built-in extensions. */
	// 加载最终扩展路径：磁盘路径交缓存加载器，builtin:name 从内置 Map 取工厂执行；返回扩展/runtime/诊断。
	// 例如未知 builtin 名只记错误，其他项继续；可复用引导 runtime，初始化异常会转单扩展错误。
	private async loadExtensionPaths(paths: string[], runtime?: ExtensionRuntime): Promise<LoadExtensionsResult> {
		// 局部纯谓词区分合成内置路径与磁盘模块路径。
		const isBuiltinPath = (path: string) => path.startsWith(BUILTIN_PATH_PREFIX);
		// 先等待普通文件扩展，保证有可共享 runtime 后再初始化内置工厂。
		const result = await loadExtensionsCached(
			// 只把非内置路径交文件加载器，不能对 builtin: 当磁盘文件读取。
			paths.filter((path) => !isBuiltinPath(path)),
			this.cwd,
			this.eventBus,
			runtime,
		);
		// 按输入内置顺序逐个初始化，最终排序还会恢复整个 extensionPaths 顺序。
		for (const path of paths.filter(isBuiltinPath)) {
			// 按 builtin: 后面的名字找宿主提供工厂。
			const builtin = this.builtinExtensions.get(path.slice(BUILTIN_PATH_PREFIX.length));
			// 没有注册该内置名就记录错误，不凭名字推测代码位置。
			if (!builtin) {
				// 保留未知合成路径诊断便于用户修正配置。
				result.errors.push({ path, error: `Unknown built-in extension: ${path}` });
				continue;
			}
			try {
				// 调用初始化器真正执行内置工厂，可能注册事件、工具、命令等。
				const extension = await loadExtensionFromFactory(
					builtin.factory,
					this.cwd,
					this.eventBus,
					result.runtime,
					path,
				);
				// 内置扩展不在常规启动资源列表中展示；不是使它停止运行或隐藏所有行为。
				extension.hidden = true;
				// 只显式 true 才允许之后被不可替换扩展占用注册名时排除。
				extension.replaceable = builtin.replaceable === true;
				// 把成功初始化内置加入结果。
				result.extensions.push(extension);
			} catch (error) {
				// 单个工厂异常记录为错误，不阻止后续内置工厂尝试。
				result.errors.push({ path, error: error instanceof Error ? error.message : "failed to load extension" });
			}
		}
		return result;
	}

	// 把信任引导结果与最终扩展路径合成一批有序结果；输入最终路径和可选预加载批次，返回最终加载结果。
	// 复用已经成功或失败的引导路径避免二次执行，补未加载项并复用同一 runtime；内联已执行项也复用。
	// 例如信任确认后仅新增项目扩展，原全局扩展不再初始化一次；最后按最终路径顺序处理替换并记录工具/flag 冲突。
	private async loadFinalExtensionSet(
		extensionPaths: string[],
		preTrustExtensions: LoadExtensionsResult | undefined,
	): Promise<LoadExtensionsResult> {
		// Without a pre-trust pass nothing is preloaded, and inline extensions load here.
		// 没有引导阶段就从空集合开始；有的话复用已成功初始化对象。
		const preloaded = preTrustExtensions?.extensions ?? [];
		// 只索引可按资源路径复用的非普通内联扩展。
		const preloadedByPath = new Map(
			preloaded
				// 普通内联工厂另按专门分支复用，不能把人工路径当磁盘模块去查。
				.filter((extension) => !extension.path.startsWith("<inline:"))
				// 成功项以实际 resolvedPath 的规范键索引。
				.map((extension) => [getResourcePathKey(extension.resolvedPath), extension]),
		);
		// 引导已失败的路径也记住，最终阶段不再立即重复执行同一路径。
		const failedPreloadPaths = new Set(
			// 把错误路径也规范成相同键，兼容合成标识与真实文件路径。
			(preTrustExtensions?.errors ?? []).map((error) => this.getExtensionPathKey(error.path)),
		);
		// 最终路径中只筛出引导阶段尚未成功/失败处理过的部分。
		const remainingPaths = extensionPaths.filter((path) => {
			// 按相同规范规则比较，避免路径写法不同导致重复初始化。
			const pathKey = this.getExtensionPathKey(path);
			// 引导成功或失败都不再加载，其诊断会合并保留。
			return !preloadedByPath.has(pathKey) && !failedPreloadPaths.has(pathKey);
		});
		// 补加载剩余扩展；有引导 runtime 时沿用，不再分出另一运行时。
		const remainingExtensions = await this.loadExtensionPaths(remainingPaths, preTrustExtensions?.runtime);
		// 复制成功项索引容器，预加载对象仍共享。
		const loadedByPath = new Map(preloadedByPath);
		// 把这次新成功项补入统一索引。
		for (const extension of remainingExtensions.extensions) {
			// 按真实来源键保存，供最终恢复顺序。
			loadedByPath.set(getResourcePathKey(extension.resolvedPath), extension);
		}

		// 引导已经执行普通内联工厂就复用；完全没有引导才在此执行。
		const inlineExtensions = preTrustExtensions
			? // 从已成功项挑普通内联，旧错误稍后统一合并而非重复生成。
				{ extensions: preloaded.filter((extension) => extension.path.startsWith("<inline:")), errors: [] }
			: // 无预加载时用本批 runtime 初始化普通内联。
				await this.loadExtensionFactories(remainingExtensions.runtime);
		// 按最终选定资源路径顺序重新排列，不能直接按先引导后新增的执行时序展示/处理优先级。
		const orderedExtensions = extensionPaths
			// 每个最终路径从统一成功索引取对象。
			.map((path) => loadedByPath.get(this.getExtensionPathKey(path)))
			// 失败/缺失项不进入成功列表，类型谓词收窄数组元素。
			.filter((extension): extension is Extension => extension !== undefined);
		// 普通内联扩展统一放到最终磁盘/内置路径之后。
		orderedExtensions.push(...inlineExtensions.extensions);

		// 收集可替换内置等被占名时产生的说明。
		const replacementWarnings: Array<{ path: string; warning: string }> = [];
		// 组装最终批次，保留成功扩展、所有来源错误/警告和同一运行时。
		const extensionsResult: LoadExtensionsResult = {
			// 先过滤可替换项，后面的普通冲突检查不把被替换项再当成冲突者。
			extensions: omitReplacedExtensions(orderedExtensions, replacementWarnings),
			// 合并引导、新增和内联失败，不把引导失败静默丢失。
			errors: [...(preTrustExtensions?.errors ?? []), ...remainingExtensions.errors, ...inlineExtensions.errors],
			// 先保留旧/新批次警告，替换警告接着按路径合并。
			warnings: [...(preTrustExtensions?.warnings ?? []), ...(remainingExtensions.warnings ?? [])],
			// 后续扩展工具/事件共享同一实际 runtime。
			runtime: remainingExtensions.runtime,
		};
		// 将替换解释加入结果警告，按路径保持一份。
		mergeExtensionWarnings(extensionsResult, replacementWarnings);
		// 可替换处理后，再对普通扩展保留项产生注册冲突诊断。
		this.addExtensionConflictDiagnostics(extensionsResult);
		return extensionsResult;
	}

	// 把已保留扩展间的工具/flag 名冲突附到 errors，输入结果原地修改，无返回；不会卸载任一冲突扩展。
	// 例如两个普通扩展都注册 read，会保留加载对象并给后者一条诊断；命令冲突不由这个 detect 实现检查。
	private addExtensionConflictDiagnostics(extensionsResult: LoadExtensionsResult): void {
		// Detect extension conflicts (tools, commands, flags with same names from different extensions)
		// Keep all extensions loaded. Conflicts are reported as diagnostics, and precedence is handled by load order.
		// 检测函数实际扫描 tools 与 flags，不因上面旧英文概述而推断还扫描 commands。
		const conflicts = this.detectExtensionConflicts(extensionsResult.extensions);
		// 每个冲突产生对应路径的可展示错误。
		for (const conflict of conflicts) {
			// 只附诊断，真正调用优先级依消费注册列表的上层逻辑。
			extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
		}
	}

	// 把自动/包资源的技能根缩到 SKILL.md 文件入口，输入资源与可变元数据索引，返回路径。
	// 例如包目录有 SKILL.md 时只读这一技能并保留包来源；显式普通路径或 stat 失败按原路径返回，不报此处错误。
	private mapSkillPath(resource: ResolvedResource, metadataByPath: Map<string, PathMetadata>): string {
		// 不是自动发现也不是包资源时，不替调用者改目录入口。
		if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") {
			// 保留原资源路径，实际发现函数之后决定文件/目录如何解析。
			return resource.path;
		}
		try {
			// 只为需映射的自动/包路径查类型。
			const stats = statSync(resource.path);
			// 已是文件入口无需改成子文件。
			if (!stats.isDirectory()) {
				// 保留原资源路径，实际发现函数之后决定文件/目录如何解析。
				return resource.path;
			}
		} catch {
			// 保留原资源路径，实际发现函数之后决定文件/目录如何解析。
			return resource.path;
		}
		// 仅尝试该技能根的规范声明文件，不递归猜其他入口。
		const skillFile = join(resource.path, "SKILL.md");
		// 存在规范文件时允许缩小入口，实际文件可读性仍交技能加载器判断。
		if (existsSync(skillFile)) {
			// 不覆盖之前已有的更明确文件来源。
			if (!metadataByPath.has(skillFile)) {
				// 目录来源继承给映射后的文件，防止来源链丢失。
				metadataByPath.set(skillFile, resource.metadata);
			}
			// 优先用明确声明入口，避免从包根继续发现额外 Markdown。
			return skillFile;
		}
		// 保留原资源路径，实际发现函数之后决定文件/目录如何解析。
		return resource.path;
	}

	// 规范扩展贡献的路径和可选 baseDir，输入路径/元数据数组，返回新描述数组，不读资源正文。
	// 例如相对 path/baseDir 都以 loader.cwd 解析；没有 baseDir 的元数据原对象继续复用。
	private normalizeExtensionPaths(
		entries: Array<{ path: string; metadata: PathMetadata }>,
	): Array<{ path: string; metadata: PathMetadata }> {
		// map 创建新的路径描述对象，避免原地覆盖贡献者传入的数组项。
		return entries.map((entry) => {
			// 只有带基准目录时才浅复制元数据并改成绝对目录。
			const metadata = entry.metadata.baseDir
				? // 对象展开保留包来源等字段，只覆盖 baseDir。
					{ ...entry.metadata, baseDir: this.resolveResourcePath(entry.metadata.baseDir) }
				: // 没有基准目录则保持原元数据引用。
					entry.metadata;
			return {
				// 资源路径本身总按同一加载器基准解析。
				path: this.resolveResourcePath(entry.path),
				metadata,
			};
		});
	}

	// 从本批路径重建技能列表/诊断，输入路径和可选包来源表，无返回，读取 Markdown 并更新实例。
	// 禁用且无显式路径才直接空结果；其余用 loadSkills(includeDefaults=false)，确保只加载上层已经选择的路径。
	// 例如来源先取扩展贡献/包索引，再已有 Skill 标签，最后按目录推默认；skillsOverride 可明确改结果。
	private updateSkillsFromPaths(skillPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		// 先声明默认加载结果，稍后按开关赋空或实际解析。
		let skillsResult: { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
		// 关闭常规技能且没有明确剩余入口时不读取文件。
		if (this.noSkills && skillPaths.length === 0) {
			// 设置明确空资源结果，覆盖旧批次状态。
			skillsResult = { skills: [], diagnostics: [] };
		} else {
			// 调用元信息解析器，不执行技能正文。
			skillsResult = loadSkills({
				// 向下传同一绝对工作目录，不改变进程 cwd。
				cwd: this.cwd,
				// 向下传同一用户数据目录，保证不同资源类型采用一致根。
				agentDir: this.agentDir,
				skillPaths,
				// 默认/设置资源路径已由包管理器选过，此处禁止独立加载器再扫默认目录导致顺序改变。
				includeDefaults: false,
			});
		}
		// 加载后给明确覆盖回调机会，回调输出仍参与后面的来源补齐。
		const resolvedSkills = this.skillsOverride ? this.skillsOverride(skillsResult) : skillsResult;
		// 创建新技能描述对象并补 sourceInfo，原正文仍不会加载进目录。
		this.skills = resolvedSkills.skills.map((skill) => ({
			// 保留已解析名称/描述等元信息，只在下面覆盖来源字段。
			...skill,
			sourceInfo:
				// 优先从扩展贡献/包来源索引寻找这个技能的真实来源。
				this.findSourceInfoForPath(skill.filePath, this.extensionSkillSourceInfos, metadataByPath) ??
				// 未匹配到索引时沿用解析器已有标签。
				skill.sourceInfo ??
				// 最后才按路径所在默认资源根推断标签；这不是授权检查。
				this.getDefaultSourceInfoForPath(skill.filePath),
		}));
		// 替换本批技能诊断，不累积已经过时的旧批次问题。
		this.skillDiagnostics = resolvedSkills.diagnostics;
	}

	// 重建模板列表/诊断：输入上层选定路径及可选元数据，读取文件、按命令名首项优先去重并补来源。
	// 例如两份 review.md 只采用路径顺序中先发现者，败者保留 collision 诊断；不会在加载时替换 $1。
	private updatePromptsFromPaths(promptPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		// 保存本轮模板结果，避免无资源时遗留旧模板。
		let promptsResult: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
		// 只有禁用且无显式路径时完全跳过模板读取。
		if (this.noPromptTemplates && promptPaths.length === 0) {
			// 清空当前模板结果和诊断。
			promptsResult = { prompts: [], diagnostics: [] };
		} else {
			// 调用 Markdown/YAML 读取器，主加载器自己掌握来源顺序。
			const loaded = loadPromptTemplates({
				// 向下传同一绝对工作目录，不改变进程 cwd。
				cwd: this.cwd,
				// 向下传同一用户数据目录，保证不同资源类型采用一致根。
				agentDir: this.agentDir,
				promptPaths,
				// 默认/设置资源路径已由包管理器选过，此处禁止独立加载器再扫默认目录导致顺序改变。
				includeDefaults: false,
			});
			// 底层可返回同名模板，此处统一按先到者保留。
			const deduped = this.dedupePrompts(loaded.templates);
			promptsResult = {
				// 只把去重后的模板暴露给命令展开。
				prompts: deduped.prompts,
				// 同时保留文件解析和同名碰撞问题。
				diagnostics: [...loaded.diagnostics, ...deduped.diagnostics],
			};
		}
		// 显式覆盖回调可替换默认模板列表及诊断。
		const resolvedPrompts = this.promptsOverride ? this.promptsOverride(promptsResult) : promptsResult;
		// 建立带最终来源的模板描述，正文不在此再次改写。
		this.prompts = resolvedPrompts.prompts.map((prompt) => ({
			// 保留名称、描述、参数提示和模板全文。
			...prompt,
			sourceInfo:
				// 先查扩展贡献/包元数据的来源。
				this.findSourceInfoForPath(prompt.filePath, this.extensionPromptSourceInfos, metadataByPath) ??
				// 其次使用模板解析器给出的来源。
				prompt.sourceInfo ??
				// 仍无来源才按路径默认目录分类。
				this.getDefaultSourceInfoForPath(prompt.filePath),
		}));
		// 更新本批诊断，旧批次不继续混入。
		this.promptDiagnostics = resolvedPrompts.diagnostics;
	}

	// 按当前终端颜色能力加载/去重主题并更新实例；输入路径与来源表，无返回，会读 JSON、构建主题。
	// 例如 trueColor 覆盖设置参与构建，但为主题无需探测 tmux 超链接；重名首项保留、无效文件变诊断。
	// Theme 来源字段在原主题对象上更新，和技能/模板浅复制方式不同。
	private updateThemesFromPaths(themePaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		// 保存本批主题结果与问题。
		let themesResult: { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
		// 禁用且没有显式主题才直接采用空集合。
		if (this.noThemes && themePaths.length === 0) {
			// 避免关闭主题发现后继续暴露上批结果。
			themesResult = { themes: [], diagnostics: [] };
		} else {
			// Theme construction only needs trueColor, so skip the unrelated tmux hyperlink probe.
			// 把探测能力和设置覆盖组合为实际主题颜色模式。
			const colorMode = getTerminalColorMode({
				// 传入固定 false 的 tmux 链接探测回调，跳过与主题构造无关的外部探测。
				...detectCapabilities(() => false),
				// 设置覆盖写在后面，同名能力字段优先于自动探测值。
				...this.settingsManager.getTerminalCapabilityOverrides(),
			});
			// 只加载给定路径，不在这一步又扫默认目录。
			const loaded = this.loadThemes(themePaths, false, colorMode);
			// 按主题名首项优先去重。
			const deduped = this.dedupeThemes(loaded.themes);
			// 把加载错误与主题同名碰撞诊断汇总。
			themesResult = { themes: deduped.themes, diagnostics: [...loaded.diagnostics, ...deduped.diagnostics] };
		}
		// 默认结果可被明确覆盖回调替换。
		const resolvedThemes = this.themesOverride ? this.themesOverride(themesResult) : themesResult;
		// 逐主题补来源，map 返回同一主题对象，不创建深副本。
		this.themes = resolvedThemes.themes.map((theme) => {
			// 主题构造器可能记录文件路径，内置/人工主题可能没有。
			const sourcePath = theme.sourcePath;
			// 有文件路径才尝试从资源索引匹配来源；无路径就维持已有值。
			theme.sourceInfo = sourcePath
				? // 有路径优先显式贡献和包元数据。
					(this.findSourceInfoForPath(sourcePath, this.extensionThemeSourceInfos, metadataByPath) ??
					// 其次保留主题已有来源信息。
					theme.sourceInfo ??
					// 最后才按默认资源根推断。
					this.getDefaultSourceInfoForPath(sourcePath))
				: // 没有文件路径时不假设主题来自某个磁盘根。
					theme.sourceInfo;
			// 返回已经补来源的同一主题对象。
			return theme;
		});
		// 替换本批主题诊断。
		this.themeDiagnostics = resolvedThemes.diagnostics;
	}

	// 原地给最终扩展及其命令/工具补同一来源，输入扩展列表与来源索引，无返回，不重新执行代码。
	// 例如资源界面点某工具可追溯它属于哪个包；flags 不在这里逐项传播 sourceInfo。
	private applyExtensionSourceInfo(extensions: Extension[], metadataByPath: Map<string, PathMetadata>): void {
		// 遍历最终保留扩展，不给已过滤替换项补注册来源。
		for (const extension of extensions) {
			// 优先资源索引匹配，找不到则按合成路径或默认目录分类。
			extension.sourceInfo =
				// 扩展本身没有独立 extraSourceInfos，直接使用解析元数据。
				this.findSourceInfoForPath(extension.path, undefined, metadataByPath) ??
				// 内联/builtin 标签在这里按合成路径识别，不当成文件路径。
				this.getDefaultSourceInfoForPath(extension.path);
			// 扩展所有命令沿用所属扩展来源。
			for (const command of extension.commands.values()) {
				// 这是来源引用赋值，不赋予新的执行权限。
				command.sourceInfo = extension.sourceInfo;
			}
			// 工具也沿用所属扩展来源。
			for (const tool of extension.tools.values()) {
				// 便于工具列表与扩展包一致展示来源。
				tool.sourceInfo = extension.sourceInfo;
			}
		}
	}

	// 按资源路径找最适用来源，输入路径、可选扩展贡献映射、包元数据，返回 SourceInfo 或 undefined。
	// 优先合成标识→扩展贡献的首个祖先匹配→包索引精确匹配→包索引首个祖先；不是最长路径匹配算法。
	// 例如技能子文件继承贡献目录来源时复制来源对象并换 path，不修改原映射值，不做信任授权。
	private findSourceInfoForPath(
		resourcePath: string,
		extraSourceInfos?: Map<string, SourceInfo>,
		metadataByPath?: Map<string, PathMetadata>,
	): SourceInfo | undefined {
		// 空资源路径没有可匹配来源。
		if (!resourcePath) {
			return undefined;
		}

		// builtin:/内联标识不是磁盘路径，直接走合成来源分类。
		if (isSyntheticPath(resourcePath)) {
			// 合成源会标临时顶层作用域，不调用 stat 读取不存在的人工路径。
			return this.getDefaultSourceInfoForPath(resourcePath);
		}

		// 用 node:path 计算绝对写法；这里不 realpath，也不一定等同去重键。
		const normalizedResourcePath = resolve(resourcePath);
		// 先检查扩展显式贡献来源，它优先于通用包索引。
		if (extraSourceInfos) {
			// 按 Map 插入顺序找首个包含资源的根，没有另排序到最深根。
			for (const [sourcePath, sourceInfo] of extraSourceInfos.entries()) {
				// 平台路径比较确认资源位于该来源根或等于该根。
				if (isPathWithin(sourcePath, normalizedResourcePath)) {
					// 保留来源身份/baseDir，返回描述的 path 改成实际资源，而不覆盖映射中的原对象。
					return { ...sourceInfo, path: resourcePath };
				}
			}
		}

		// 有包/发现元数据时先试精确键，再试目录祖先。
		if (metadataByPath) {
			// 兼容索引存的规范写法或原资源写法，精确匹配优先。
			const exact = metadataByPath.get(normalizedResourcePath) ?? metadataByPath.get(resourcePath);
			// 找到精确信息就不再用更泛目录来源。
			if (exact) {
				// 把包解析元数据投影成对外 SourceInfo。
				return createSourceInfo(resourcePath, exact);
			}

			// 按索引插入顺序寻找第一个目录归属，不保证选择最长祖先。
			for (const [sourcePath, metadata] of metadataByPath.entries()) {
				// 平台路径比较确认资源位于该来源根或等于该根。
				if (isPathWithin(sourcePath, normalizedResourcePath)) {
					// 继承匹配根的包/作用域身份，path 仍指当前资源。
					return createSourceInfo(resourcePath, metadata);
				}
			}
		}

		return undefined;
	}

	// 没有显式来源时按合成标识和默认资源目录推断标签，输入路径，返回来源对象。
	// 例如 agentDir/skills 下归 local/user，cwd/.pi 下归 local/project，其他文件归 local/temporary。
	// 真实未知路径会 stat 判目录/父目录，因此可能抛 I/O 错误；标签不是授权决策。
	private getDefaultSourceInfoForPath(filePath: string): SourceInfo {
		// builtin:name 得 builtin，<inline:name> 得 inline，普通文件得 undefined。
		const syntheticSource = getSyntheticPathSource(filePath);
		// 合成资源不应送到文件属性查询。
		if (syntheticSource) {
			return {
				path: filePath,
				// 记录内置/内联等合成身份。
				source: syntheticSource,
				// 合成或未归入默认根的资源按临时作用域描述。
				scope: "temporary",
				// 顶层路径来源，与包内部资源 origin=package 区分。
				origin: "top-level",
			};
		}

		// 默认归属按绝对路径比较，不在这里转 realpath 去重。
		const normalizedPath = resolve(filePath);
		// 用户级四类默认资源根，路径落入其中就标 user。
		const agentRoots = [
			join(this.agentDir, "skills"),
			join(this.agentDir, "prompts"),
			join(this.agentDir, "themes"),
			join(this.agentDir, "extensions"),
		];
		// 项目 .pi 下四类默认根，标 project。
		const projectRoots = [
			join(this.cwd, CONFIG_DIR_NAME, "skills"),
			join(this.cwd, CONFIG_DIR_NAME, "prompts"),
			join(this.cwd, CONFIG_DIR_NAME, "themes"),
			join(this.cwd, CONFIG_DIR_NAME, "extensions"),
		];

		// 先判断用户根，避免重叠路径时优先级不明确。
		for (const root of agentRoots) {
			// 使用本类字符串边界比较，不把相似目录名前缀混淆。
			if (this.isUnderPath(normalizedPath, root)) {
				// 用户默认根为来源基准，不因当前项目 cwd 不同而改归属。
				return { path: filePath, source: "local", scope: "user", origin: "top-level", baseDir: root };
			}
		}

		// 未匹配用户根才判断当前项目默认根。
		for (const root of projectRoots) {
			// 使用本类字符串边界比较，不把相似目录名前缀混淆。
			if (this.isUnderPath(normalizedPath, root)) {
				// 标明项目来源以便展示，信任控制发生在更早的设置/包发现阶段。
				return { path: filePath, source: "local", scope: "project", origin: "top-level", baseDir: root };
			}
		}

		return {
			path: filePath,
			// 真实文件路径归类本地，包来源未匹配时不凭路径猜某个 npm 包名。
			source: "local",
			// 合成或未归入默认根的资源按临时作用域描述。
			scope: "temporary",
			// 顶层路径来源，与包内部资源 origin=package 区分。
			origin: "top-level",
			// 未知来源目录以自身为基准，文件以父目录为基准；路径不存在会抛错，不承诺无异常。
			baseDir: statSync(normalizedPath).isDirectory() ? normalizedPath : resolve(normalizedPath, ".."),
		};
	}

	// 按 primary→additional 合并规范路径、实际文件去重，输入两个数组，返回新数组，不改输入。
	// 例如相对路径和指向同文件的链接只有首次出现位置保留；合成路径按原标识比较，不把它解析到 cwd。
	private mergePaths(primary: string[], additional: string[]): string[] {
		// 收集去重后路径，顺序决定后续同名资源首项优先。
		const merged: string[] = [];
		// 保存资源比较键而非原始输入字符串。
		const seen = new Set<string>();

		// 数组展开生成合并遍历顺序，原 primary/额外数组都不被排序或改写。
		for (const p of [...primary, ...additional]) {
			// 以本加载器 cwd 规范化资源路径，synthetic 路径保持原样。
			const resolved = this.resolveResourcePath(p);
			// 真实文件尽量 canonicalize 后按平台大小写取键，合成标识原样。
			const pathKey = getResourcePathKey(resolved);
			// 重复实际资源跳过，不把同文件经两个入口加载两遍。
			if (seen.has(pathKey)) continue;
			// 先登记比较键。
			seen.add(pathKey);
			// 返回的是规范加载路径，不是仅用于比较的大小写折叠键。
			merged.push(resolved);
		}

		// 返回首次出现顺序，名称冲突另由对应资源解析器处理。
		return merged;
	}

	// 规范普通资源输入，输入路径，返回合成原标识或基于 cwd 的绝对路径，无正文读取。
	// 例如 skills/x.md 以 loader.cwd 解析并 trim 两端，builtin:read 保持原样。
	private resolveResourcePath(p: string): string {
		// 只对真实路径做规范化；合成标识不应变成 /cwd/builtin:read。
		return isSyntheticPath(p) ? p : resolvePath(p, this.cwd, { trim: true });
	}

	// 发现并解析主题 JSON，输入路径、是否扫默认目录、颜色模式，返回主题/诊断。
	// 可选默认 user→project，再显式路径；目录只扫直接 .json 文件，不递归；例如坏JSON转 warning，其余主题继续。
	private loadThemes(
		paths: string[],
		includeDefaults: boolean,
		colorMode: TerminalColorMode,
	): {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	} {
		// 收集成功构建的主题对象，此函数尚不按名称去重。
		const themes: Theme[] = [];
		// 收集当前类型的读取/解析警告或去重冲突。
		const diagnostics: ResourceDiagnostic[] = [];
		// 只有显式开启时才补默认主题目录；主 updateThemesFromPaths 传 false。
		if (includeDefaults) {
			// 独立扫描默认顺序先用户后项目，主资源解析路径顺序另由包管理器提供。
			const defaultDirs = [join(this.agentDir, "themes"), join(this.cwd, CONFIG_DIR_NAME, "themes")];

			// 逐默认目录收集直接 JSON 文件。
			for (const dir of defaultDirs) {
				// 目录加载器原地追加到当前数组/诊断，不返回另一套结果。
				this.loadThemesFromDir(dir, themes, diagnostics, colorMode);
			}
		}

		// 再按输入路径顺序处理单文件或目录。
		for (const p of paths) {
			// 以本加载器 cwd 规范化资源路径，synthetic 路径保持原样。
			const resolved = this.resolveResourcePath(p);
			// 额外本地输入确实不存在时给用户明确错误。
			if (!existsSync(resolved)) {
				// 不存在的主题路径记录 warning，不能当作成功主题。
				diagnostics.push({ type: "warning", message: "theme path does not exist", path: resolved });
				continue;
			}

			try {
				// 确认实际路径种类，外部文件系统错误转成诊断。
				const stats = statSync(resolved);
				// 目录作为多个主题入口，非递归收集其直接子文件。
				if (stats.isDirectory()) {
					// 将目录内主题加入同一候选列表，名称去重在上层。
					this.loadThemesFromDir(resolved, themes, diagnostics, colorMode);
					// 单主题要求普通文件且小写 .json 后缀。
				} else if (stats.isFile() && resolved.endsWith(".json")) {
					// 读取/解析/构建主题，不执行扩展工厂。
					this.loadThemeFromFile(resolved, themes, diagnostics, colorMode);
				} else {
					// 其余现存路径类型给明确说明。
					diagnostics.push({ type: "warning", message: "theme path is not a json file", path: resolved });
				}
			} catch (error) {
				// 将显式主题属性查询等异常转可展示文字。
				const message = error instanceof Error ? error.message : "failed to read theme path";
				// 记录出错的规范路径，其余主题继续加载。
				diagnostics.push({ type: "warning", message, path: resolved });
			}
		}

		// 返回候选主题与读取问题，尚未统一解决名字重复。
		return { themes, diagnostics };
	}

	// 非递归加载目录直接 JSON 主题，输入目录、可变结果数组/诊断及颜色模式，无返回。
	// 例如主题目录里的子目录不递归，符号链接跟随到文件；坏链接跳过，目录读取失败记录 warning。
	private loadThemesFromDir(
		dir: string,
		themes: Theme[],
		diagnostics: ResourceDiagnostic[],
		colorMode: TerminalColorMode,
	): void {
		// 默认可选主题目录不存在就直接结束，不作为错误。
		if (!existsSync(dir)) {
			return;
		}

		try {
			// 读取目录项类型，普通文件无需单独 stat。
			const entries = readdirSync(dir, { withFileTypes: true });
			// 按文件系统枚举顺序读候选，没有额外排序保证。
			for (const entry of entries) {
				// 暂存文件类型，链接分支会根据目标改值。
				let isFile = entry.isFile();
				// 链接需跟随目标才能确认它是不是可读主题文件。
				if (entry.isSymbolicLink()) {
					try {
						// 坏链接 stat 抛错后跳过，目录链接不作为普通文件。
						isFile = statSync(join(dir, entry.name)).isFile();
					} catch {
						continue;
					}
				}
				// 目录与其他非常规文件类型不读取。
				if (!isFile) {
					continue;
				}
				// 仅小写 .json 文件作为主题候选。
				if (!entry.name.endsWith(".json")) {
					continue;
				}
				// 每个合格文件独立解析，错误转当前结果里的诊断。
				this.loadThemeFromFile(join(dir, entry.name), themes, diagnostics, colorMode);
			}
		} catch (error) {
			// 读取目录失败时保留具体异常或固定说明。
			const message = error instanceof Error ? error.message : "failed to read theme directory";
			// 标注目录位置，与单文件JSON错误区分。
			diagnostics.push({ type: "warning", message, path: dir });
		}
	}

	// 读取并构建一个主题，输入路径、累积数组/诊断和颜色模式，无返回，成功 push，失败 warning。
	// 例如主题 JSON 不符合构造器要求时不加入 themes；该加载器不会运行任意扩展代码。
	private loadThemeFromFile(
		filePath: string,
		themes: Theme[],
		diagnostics: ResourceDiagnostic[],
		colorMode: TerminalColorMode,
	): void {
		try {
			// 真正读 JSON 并由主题模块校验/构建颜色对象，推入共享结果数组。
			themes.push(loadThemeFromPath(filePath, colorMode));
		} catch (error) {
			// 单文件读取/主题校验异常转说明文字。
			const message = error instanceof Error ? error.message : "failed to load theme";
			// 记录失败文件，不抛出影响剩余主题。
			diagnostics.push({ type: "warning", message, path: filePath });
		}
	}

	// 按顺序初始化普通内联工厂，输入共享 runtime，返回成功扩展和失败列表，会执行用户代码。
	// 命名工厂保留 hidden/replaceable 设置，裸函数用1开始序号构造人工路径；例如 <inline:demo> 可用于来源展示但不是文件。
	private async loadExtensionFactories(runtime: ExtensionRuntime): Promise<{
		extensions: Extension[];
		errors: Array<{ path: string; error: string }>;
	}> {
		// 收集本批成功初始化的内联扩展对象。
		const extensions: Extension[] = [];
		// 按人工路径记录工厂初始化失败。
		const errors: Array<{ path: string; error: string }> = [];

		// entries 返回索引/值二元组，解构后按输入顺序等待每个工厂。
		for (const [index, input] of this.extensionFactories.entries()) {
			// 合法联合类型分支：命名对象与裸工厂函数。
			const isNamed = typeof input !== "function";
			// 命名对象取 factory，裸函数直接作为工厂。
			const factory = isNamed ? input.factory : input;
			// 稳定描述命名来源或从1开始序号，合成路径后面不会送到 stat。
			const extensionPath = `<inline:${isNamed ? input.name : index + 1}>`;
			try {
				// 真正执行扩展初始化，让其注册工具/命令/事件，可能抛错。
				const extension = await loadExtensionFromFactory(factory, this.cwd, this.eventBus, runtime, extensionPath);
				// 只有命名对象可提供启动资源展示隐藏偏好。
				extension.hidden = isNamed && input.hidden;
				// 只有命名对象显式 true 才标记可被其他不可替换项占名替换。
				extension.replaceable = isNamed && input.replaceable === true;
				// 保存成功初始化对象，保留执行顺序。
				extensions.push(extension);
			} catch (error) {
				// 工厂可抛任意值，转换为统一错误文字。
				const message = error instanceof Error ? error.message : "failed to load extension";
				// 单工厂失败保留人工来源位置，后续工厂仍继续尝试。
				errors.push({ path: extensionPath, error: message });
			}
		}

		// 返回成功和失败两类结果，调用方再合并到主加载结果。
		return { extensions, errors };
	}

	// 按命令名去重模板，输入已解析数组，返回首项保留的数组和碰撞诊断，不读文件、不改原模板。
	// 例如先遇 review A 后遇 review B，A胜B败；同一真实文件路径去重由 mergePaths 等更早阶段负责。
	private dedupePrompts(prompts: PromptTemplate[]): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		// 按模板 name 保存先遇到项，Map 插入顺序保留优先级。
		const seen = new Map<string, PromptTemplate>();
		// 收集当前类型的读取/解析警告或去重冲突。
		const diagnostics: ResourceDiagnostic[] = [];

		// 依加载顺序处理模板，不在这里排序来源。
		for (const prompt of prompts) {
			// 完全相同命令名才冲突，不做语义或大小写匹配。
			const existing = seen.get(prompt.name);
			// 已有首项时只产生碰撞诊断，不覆盖其正文。
			if (existing) {
				diagnostics.push({
					// 结构化名称冲突诊断，区别于文件读/解析 warning。
					type: "collision",
					// 模板以 /命令 形式展示重名。
					message: `name "/${prompt.name}" collision`,
					// 后出现模板文件为当前诊断位置。
					path: prompt.filePath,
					collision: {
						// 碰撞对象属于提示词模板类别。
						resourceType: "prompt",
						// 保留实际命令标识，未自动改名规避冲突。
						name: prompt.name,
						// 先出现模板继续作为命令展开胜者。
						winnerPath: existing.filePath,
						// 后出现路径保留为未采用来源。
						loserPath: prompt.filePath,
					},
				});
			} else {
				// 只有首次出现该名字才加入最终 Map。
				seen.set(prompt.name, prompt);
			}
		}

		// 按首次接受顺序返回模板，诊断仍含被跳过项信息。
		return { prompts: Array.from(seen.values()), diagnostics };
	}

	// 按主题名字首项保留，输入主题对象数组，返回去重结果与诊断，不读文件或深复制对象。
	// 例如两个主题都叫 dark，先加载者保留；没有 name 时统一用 unnamed 参与碰撞。
	private dedupeThemes(themes: Theme[]): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		// 主题名索引保留首个成功对象。
		const seen = new Map<string, Theme>();
		// 收集当前类型的读取/解析警告或去重冲突。
		const diagnostics: ResourceDiagnostic[] = [];

		// 按候选加载顺序决定胜者。
		for (const t of themes) {
			// 缺名字使用同一占位名；空字符串不被 ?? 视为缺值。
			const name = t.name ?? "unnamed";
			// 查找已有同名主题。
			const existing = seen.get(name);
			// 已有同名主题时只记碰撞，不替换先前构建的主题对象。
			if (existing) {
				diagnostics.push({
					// 结构化名称冲突诊断，区别于文件读/解析 warning。
					type: "collision",
					// 记录被占用的主题名称。
					message: `name "${name}" collision`,
					// 后出现主题若有文件来源，用它定位诊断。
					path: t.sourcePath,
					collision: {
						// 明确是主题碰撞，不与技能/模板名称互相冲突。
						resourceType: "theme",
						name,
						// 无文件来源的已采用主题用内置占位路径说明。
						winnerPath: existing.sourcePath ?? "<builtin>",
						// 败者也可为人工/内置主题，不假造文件路径。
						loserPath: t.sourcePath ?? "<builtin>",
					},
				});
			} else {
				// 名字首次出现才保存，不替换先前对象。
				seen.set(name, t);
			}
		}

		// 返回首项顺序的主题列表及所有名字碰撞信息。
		return { themes: Array.from(seen.values()), diagnostics };
	}

	// 自动寻找系统前言文件：可信项目 .pi/SYSTEM.md 优先，否则用户 SYSTEM.md，返回路径或 undefined。
	// 只检查存在，不读取内容；例如项目不可信时跳过它，但显式输入路径另由调用方授权语境处理。
	private discoverSystemPromptFile(): string | undefined {
		// 项目自动系统前言候选。
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "SYSTEM.md");
		// 项目可信且候选存在才采用；检查存在不保证它可读或是普通文件。
		if (this.settingsManager.isProjectTrusted() && existsSync(projectPath)) {
			// 采用项目候选后不再同时加载全局同类文件。
			return projectPath;
		}

		// 项目候选未采用时回退用户级系统前言。
		const globalPath = join(this.agentDir, "SYSTEM.md");
		// 用户文件存在就作为输入，读取失败处理在 resolvePromptInput。
		if (existsSync(globalPath)) {
			// 自动发现只返回一条来源，不合并项目和用户正文。
			return globalPath;
		}

		return undefined;
	}

	// 自动寻找追加系统文字文件：可信项目 APPEND_SYSTEM.md 优先，再回退用户文件，返回路径或 undefined。
	// 例如两处都存在时只用项目这一份，不是全部追加；读取时机在 reload 的 resolvePromptInput。
	private discoverAppendSystemPromptFile(): string | undefined {
		// 项目自动追加文字候选，和 SYSTEM.md 是独立文件。
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
		// 项目可信且候选存在才采用；检查存在不保证它可读或是普通文件。
		if (this.settingsManager.isProjectTrusted() && existsSync(projectPath)) {
			// 采用项目候选后不再同时加载全局同类文件。
			return projectPath;
		}

		// 用户级追加候选，仅在项目未采用时考虑。
		const globalPath = join(this.agentDir, "APPEND_SYSTEM.md");
		// 用户文件存在就作为输入，读取失败处理在 resolvePromptInput。
		if (existsSync(globalPath)) {
			// 自动发现只返回一条来源，不合并项目和用户正文。
			return globalPath;
		}

		return undefined;
	}

	// 用绝对根和目录分隔符前缀判断来源归属，输入目标/根，返回布尔值，无 I/O。
	// 例如 /skills2 不在 /skills 下；它是字面路径比较，不是 realpath、最长根匹配或权限验证。
	private isUnderPath(target: string, root: string): boolean {
		// 根先转换成绝对路径，目标由调用方提前规范。
		const normalizedRoot = resolve(root);
		// 目标就是根时归属成立。
		if (target === normalizedRoot) {
			// 目标恰好等于根目录，本次路径归属判断成立。
			return true;
		}
		// 加分隔符边界，防止相似目录名前缀误匹配。
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		// 判断完整目录边界前缀，不自动折叠平台大小写。
		return target.startsWith(prefix);
	}

	// 检测不同扩展注册的工具/flag 重名，输入最终保留列表，返回诊断数组，不卸载扩展、不执行工具。
	// 例如 A/B 都提供工具 x，则B报与A冲突；实际只扫描 tools/flags，命令名用于前面的可替换处理但不在这里检查。
	private detectExtensionConflicts(extensions: Extension[]): Array<{ path: string; message: string }> {
		// 累积后出现扩展与已有注册者的冲突说明。
		const conflicts: Array<{ path: string; message: string }> = [];

		// Track which extension registered each tool and flag
		// 工具名→首次登记扩展路径，不与 flag 名共用命名空间。
		const toolOwners = new Map<string, string>();
		// 命令行 flag 名→首次登记扩展路径。
		const flagOwners = new Map<string, string>();

		// 按最终加载顺序检查，首个名字持有者被记录为比较对象。
		for (const ext of extensions) {
			// Check tools
			// 枚举扩展注册工具名，不执行其处理函数。
			for (const toolName of ext.tools.keys()) {
				// 查看之前是否已有另一扩展提供同名工具。
				const existingOwner = toolOwners.get(toolName);
				// 只有不同扩展路径才报跨扩展冲突，同一路径不在这里重复报。
				if (existingOwner && existingOwner !== ext.path) {
					// 诊断保留后出现扩展路径，前一个持有者路径放在说明文字里。
					conflicts.push({
						path: ext.path,
						// 给出工具名与原持有扩展来源。
						message: `Tool "${toolName}" conflicts with ${existingOwner}`,
					});
				} else {
					// 首次遇到该工具名才登记原持有者，发生冲突时不覆盖它。
					toolOwners.set(toolName, ext.path);
				}
			}

			// Check flags
			// 独立枚举 flag 注册名。
			for (const flagName of ext.flags.keys()) {
				// 查原 flag 持有者，与工具登记表分开。
				const existingOwner = flagOwners.get(flagName);
				// 只有不同扩展路径才报跨扩展冲突，同一路径不在这里重复报。
				if (existingOwner && existingOwner !== ext.path) {
					// 诊断保留后出现扩展路径，前一个持有者路径放在说明文字里。
					conflicts.push({
						path: ext.path,
						// 以 --flag 展示命令行选项碰撞。
						message: `Flag "--${flagName}" conflicts with ${existingOwner}`,
					});
				} else {
					// 登记首次 flag 持有者供后面比较。
					flagOwners.set(flagName, ext.path);
				}
			}
		}

		// 返回检测结果，调用者只追加错误诊断，未在此决定工具调用覆盖行为。
		return conflicts;
	}
}
