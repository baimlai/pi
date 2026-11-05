// 资源包管理核心：CLI/ResourceLoader 交给它解析 npm/Git/本地来源、安装或更新、收集扩展/技能/提示词/主题。返回的是路径和启用状态，真正加载代码、解析技能或渲染主题由后续模块负责。
// 安装/更新可联网、启动子进程并改文件；resolve 也可能补装缺失包，不能把名字里的“解析”理解为纯计算。源码中项目存储有信任检查，词法路径检查与目录发现则不等于完整文件系统沙箱。
// 仅导入 Node 子进程类型；type 内容在执行 JS 中擦除，不会因为引用 ChildProcess 就启动进程。
import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
// SHA-256 用来给临时安装地址生成短标识，不用于校验下载内容或认证仓库。
import { createHash } from "node:crypto";
// 同步文件 API 直接在当前线程读写；下面逐项用于权限、发现、清理与配置写入。
import {
	// chmodSync 显式调整临时扩展根权限，失败可直接抛错。
	chmodSync,
	// existsSync 查询当前路径是否存在；检查和后续动作并非原子事务。
	existsSync,
	// globSync 依给定模式查找磁盘名字，返回路径字符串数组。
	globSync,
	// mkdirSync 创建包存储与临时目录。
	mkdirSync,
	// readdirSync 读取一层目录，传 withFileTypes 时拿到 Dirent。
	readdirSync,
	// readFileSync 读取环境/清单/忽略规则等正文。
	readFileSync,
	// realpathSync 跟随符号链接，npm --prefix 需要真实安装根。
	realpathSync,
	// rmSync 删除受管理安装或更新标记，部分调用带 recursive/force。
	rmSync,
	// statSync 跟随链接读取目标类型，目录发现用它区分文件与目录。
	statSync,
	// writeFileSync 写受管理 package.json/.gitignore/更新标记等，覆盖与异常由各调用处决定。
	writeFileSync,
} from "node:fs";
// os.homedir 提供系统主目录；本模块另有 HOME 环境优先规则。
import { homedir } from "node:os";

// 选择传给子进程的环境，无参数，返回 NodeJS.ProcessEnv；通常直接用 process.env，只有 Linux 且其自有键为空才尝试读 /proc/self/environ。
// 例如某 Linux 宿主清空了 process.env 时可从 NUL 分隔的进程环境正文重建。读取失败回退原对象；不是把缺失的个别变量补齐，也不修改 process.env。
function getEnv(): NodeJS.ProcessEnv {
	// 非 Linux 或环境中至少已有一个键就走普通分支，|| 按短路求值。
	if (process.platform !== "linux" || Object.keys(process.env).length > 0) {
		// 返回当前原环境对象引用，不创建快照。
		return process.env;
	}
	// 只捕获 Linux 备用读取与解析过程的同步错误。
	try {
		// 读取本进程 /proc 环境文字，没有启动 shell；此文件通常不是按换行分隔。
		const data = readFileSync("/proc/self/environ", "utf-8");
		// NodeJS.ProcessEnv 的键可对应 string/undefined；此处从空普通对象逐项填充。
		const env: NodeJS.ProcessEnv = {};
		// 按 NUL 字符拆项，for...of 处理每个环境条目。
		for (const entry of data.split("\0")) {
			// 只找第一个等号，后面的等号仍属于值。
			const idx = entry.indexOf("=");
			// 要求等号不在开头，空项/没有键名的项被忽略。
			if (idx > 0) {
				// 等号前作键、后面全部作值；动态方括号索引写入新环境对象。
				env[entry.slice(0, idx)] = entry.slice(idx + 1);
			}
		}
		// 返回重建环境，不与原 process.env 自动同步。
		return env;
		// 备用文件读不到或处理失败时安静回退。
	} catch {
		// 仍返回原环境，可能是空对象，不凭空补默认 PATH。
		return process.env;
	}
}

// 平台路径规则负责文件名、父目录、相对/绝对拼接；sep 是当前平台分隔符。
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
// Readable 是捕获 stdout/stderr 的类型，运行时不创建流。
import type { Readable } from "node:stream";
// ignore 解析 .gitignore 一类规则；递归发现时会把子目录规则加进同一个匹配器。
import ignore from "ignore";
// minimatch 只比较路径文字和 glob 模式；磁盘 glob 展开另用 Node globSync。
import { minimatch } from "minimatch";
// semver 提供版本合法性、范围和大小比较；不把版本标签如 latest 当作固定版本。
import { gt, maxSatisfying, rcompare, satisfies, valid, validRange } from "semver";
// 项目层包/资源目录统一使用应用配置目录名，默认 .pi。
import { CONFIG_DIR_NAME } from "../config.ts";
// 实际子进程启动经 Windows cross-spawn/其他平台 Node 封装，不能因为参数是数组就声称任何平台绝不经过 shell。
import { spawnProcess, spawnProcessSync } from "../utils/child-process.ts";
// GitSource 是类型，parseGitUrl 是实际字符串解析函数；两者都不代表这里已 clone 仓库。
import { type GitSource, parseGitUrl } from "../utils/git.ts";
// 共用路径处理工具，各行功能不同，避免把文字标准化与真实文件解析混为一谈。
import {
	// canonicalizePath 尝试 realpath，失败保留原输入。
	canonicalizePath,
	// getPathComparisonKey 生成绝对比较键，Windows 按本项目约定转小写，不跟随链接。
	getPathComparisonKey,
	// isLocalPath 排除已知非本地前缀，其余视为本地候选。
	isLocalPath,
	// markPathIgnoredByCloudSync 在 macOS/Linux 可同步调用 xattr/setfattr，结果不在该辅助函数中检查。
	markPathIgnoredByCloudSync,
	// normalizePath 可展开 ~、file URL 等，不保证结果绝对。
	normalizePath,
	// pathsEqual 按平台文字比较键比较，不自行 realpath。
	pathsEqual,
	// resolvePath 先规范输入再按基准变绝对路径，不检查目标存在性。
	resolvePath,
} from "../utils/paths.ts";
// stripBom 只删除已解码字符串首个 BOM，供 JSON 解析前使用。
import { stripBom } from "../utils/text.ts";
// 输出协议接管 stdout 时，让普通包管理命令改往 stderr，避免污染协议流。
import { isStdoutTakenOver } from "./output-guard.ts";
// PiManifest 只含已接受的清单资源字段；读取失败或缺少有效 pi 对象时 readPiManifest 返回 null。
import { type PiManifest, readPiManifest } from "./pi-manifest.ts";
// 设置类型只在开发期使用，传入 SettingsManager 实例才提供实际设置读取/排队保存。
import type { PackageSource, SettingsManager } from "./settings-manager.ts";
// builtin: 为合成标识；资源去重键对真实路径尝试 realpath，对合成标识保持原串。
import { BUILTIN_PATH_PREFIX, getResourcePathKey } from "./source-info.ts";

// 查询类子进程超时参数为 10000 毫秒；不是所有安装/拉取命令的总时间上限。
const NETWORK_TIMEOUT_MS = 10000;
// 版本可用性查询最多安排四个 worker，并非限制全部 npm 子进程只允许四个。
const UPDATE_CHECK_CONCURRENCY = 4;
// 配置 Git 更新任务的 worker 数上限；npm 用户/项目两个批次另行并行。
const GIT_UPDATE_CONCURRENCY = 4;

/** Whether PI_OFFLINE is set; package installs and updates then skip all network access. */
// 读取本模块离线开关，无参数，返回 boolean，无文件操作；例如 PI_OFFLINE=yes 返回 true，0 返回 false。只识别下列精确规则，不是所有非空值都开启。
// 调用方在自动缺失安装、更新/查询等路径使用它；直接 install/remove 本身未统一用这个开关挡住，不能据原英文概括成所有公共入口都绝不联网。
export function isOfflineModeEnabled(): boolean {
	// 每次调用实时读环境，不缓存离线状态。
	const value = process.env.PI_OFFLINE;
	// undefined 或空串都返回 false。
	if (!value) return false;
	// 1 精确匹配，true/yes 不分大小写；没有 trim，因此带两端空格的值不会自动识别。
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

// 判断可选版本文字是否被 semver.valid 接受为一个固定版本，返回布尔，无 I/O；例如 1.2.3 为 true，^1.2.3/undefined 为 false。
function isExactNpmVersion(version: string | undefined): boolean {
	// ?? 只把缺失值换空串，valid 返回规范版本或 null；这里只使用是否非 null，不替换原 spec。
	return valid(version ?? "") !== null;
}

// 把可选版本文字交 semver.validRange 得到规范范围或 undefined，无 I/O；例如 ^1.2.3 可返回范围，latest 通常不是 semver 范围。
function getNpmVersionRange(version: string | undefined): string | undefined {
	// 空值直接 undefined，无效范围的 null 用 ?? 转 undefined；没有在这里调用 registry 解析标签。
	return version ? (validRange(version) ?? undefined) : undefined;
}

// 资源来源元数据；它记录“由谁引入/在哪个作用域”，不是可信凭证或文件内容校验结果。
export interface PathMetadata {
	// 原来源或约定标签，如 npm:pkg、local、auto、builtin。
	source: string;
	// 用户/项目/临时作用域，由下方 SourceScope 联合限定。
	scope: SourceScope;
	// package 代表包内资源，top-level 代表顶层配置/自动发现；与 scope 是两个维度。
	origin: "package" | "top-level";
	// 可省略基准目录，供相对资源和界面归属使用；? 不等于运行时默认值。
	baseDir?: string;
	// 可选变更日志文件路径，本模块会对包日志执行内部归属与普通文件检查。
	changelogPath?: string;
	// 可选包根目录，文件入口资源未必具备。
	packageRoot?: string;
}

// 最终的一条资源路径及启用状态，加载器还需实际读/导入内容。
export interface ResolvedResource {
	// 可以是文件/目录入口或 builtin: 合成路径。
	path: string;
	// 发现但被配置禁用的资源仍可能以 enabled:false 返回。
	enabled: boolean;
	// 保留来源元数据对象，不代表资源内部逻辑已执行。
	metadata: PathMetadata;
}

// 四类资源结果；本类型本身不负责安装或执行资源。
export interface ResolvedPaths {
	// 扩展入口数组，成员不一定都是单个 .ts/.js 文件。
	extensions: ResolvedResource[];
	// 技能入口数组，可能来自 SKILL.md 或支持的单文件 Markdown。
	skills: ResolvedResource[];
	// 提示词模板路径数组。
	prompts: ResolvedResource[];
	// 主题 JSON 路径数组。
	themes: ResolvedResource[];
	/** Configured packages that were skipped because installing them failed. */
	// 可缺安装失败列表；当前 resolve/resolveExtensionSources 通常显式返回数组，包括空数组。
	installFailures?: PackageInstallFailure[];
}

/** A configured package that could not be installed while resolving resources. */
// 资源解析中补装失败的诊断记录；跳过/离线本身不一定产生此记录。
export interface PackageInstallFailure {
	// 尝试安装的实际来源，autoload delta 可能借用用户层来源。
	source: string;
	// 实际安装作用域，而非总是原项目覆盖项的 scope。
	scope: SourceScope;
	// 错误 message 或 String(error)，没有自动脱敏。
	message: string;
}

// 缺失包回调的三种决定：安装、跳过、让解析抛 Missing source 错误；字面量联合让 TS 限制返回值。
export type MissingSourceAction = "install" | "skip" | "error";

// 同步进度通知的数据形状，回调抛错可能影响操作本身。
export interface ProgressEvent {
	/**
	 * `start` is followed by exactly one `complete` or `error` for the same source.
	 * `progress` carries an intermediate message or warning.
	 * `result` reports an outcome outside that pairing, e.g. one changed package
	 * after update(): `npm:foo 1.2.0 -> 1.3.0`.
	 */
	// 事件阶段；正常回调下 withProgress 成功配 complete、失败配 error，若 start/complete/error 回调自身抛错则不保证原英文的严格一对一。
	type: "start" | "progress" | "complete" | "error" | "result";
	// 动作标签，和上面的阶段正交；pull 用于刷新临时 Git 来源。
	action: "install" | "remove" | "update" | "clone" | "pull";
	// 本事件关联的来源；批量 npm 更新也可用 user npm packages 这样的汇总标签。
	source: string;
	// 可省略文字，complete 通常没有，result 用来独立报告版本/commit 变化。
	message?: string;
}

// 函数类型表示同步接收一个事件且不以返回值调度；void 不保证实现绝不会抛异常。
export type ProgressCallback = (event: ProgressEvent) => void;

// 可用更新的提示条目，不含安装动作或最新版本正文。
export interface PackageUpdate {
	// 配置来源字符串。
	source: string;
	// 用于展示的包名或 Git host/path。
	displayName: string;
	// 只有 npm/Git 会提供更新查询，本地路径不在此联合。
	type: "npm" | "git";
	// Exclude 在开发期从作用域联合排除 temporary，结果是 user|project。
	scope: Exclude<SourceScope, "temporary">;
}

// 列出用户/项目已配置来源的结果，不扫描磁盘发现所有安装包。
export interface ConfiguredPackage {
	// 从字符串/对象设置提取的来源。
	source: string;
	// 来源所在设置层，列出时不会按身份去重。
	scope: "user" | "project";
	// 仅表示配置项采用对象形状，不保证它真的排除了某项资源。
	filtered: boolean;
	// 当前找到的安装路径，可缺；查用户 npm 路径可能触发旧全局布局的只读命令探测。
	installedPath?: string;
}

// 包管理器的公共结构契约；接口只做 TS 检查，实际副作用和错误由实现决定。
export interface PackageManager {
	// 解析所有已配置/自动发现资源，可通过异步 onMissing 决定缺失包动作；不等于纯只读查询。
	resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>;
	// 安装一个来源，local 选择项目范围；返回 Promise<void>，不自动写 packages 设置。
	install(source: string, options?: { local?: boolean }): Promise<void>;
	// 先安装成功再更新设置，不提供“安装和配置一并回滚”的事务。
	installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
	// 移除受管理安装；本地路径分支不删除原目录。
	remove(source: string, options?: { local?: boolean }): Promise<void>;
	// 移除后删除匹配配置，布尔反映配置项是否变化，不能反推安装目录操作是否发生。
	removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
	// 更新所有配置来源或指定身份；本实现跳过固定 npm 版本但仍可对齐指定 Git ref。
	update(source?: string): Promise<void>;
	// 同步列出配置和已找到路径，用户 npm 缺失受管理目录时可能查询旧全局安装根。
	listConfiguredPackages(): ConfiguredPackage[];
	// 解析显式传入来源列表，如 -e 参数；不顺便扫描所有用户/项目自动目录。
	resolveExtensionSources(
		// 每项仍需在实现中分类成 builtin/npm/Git/local。
		sources: string[],
		// temporary 比 local 优先决定作用域，两个可选布尔不在类型上互斥。
		options?: { local?: boolean; temporary?: boolean },
		// 异步返回同样四类资源和可选安装失败诊断。
	): Promise<ResolvedPaths>;
	// 按包身份新增或替换来源，返回内存配置是否变化；实际设置后端可稍后排队落盘。
	addSourceToSettings(source: string, options?: { local?: boolean }): boolean;
	// 按身份删除匹配配置，返回是否删到项，不在本方法卸载安装。
	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean;
	// 替换或清除同步进度回调，不自行触发事件。
	setProgressCallback(callback: ProgressCallback | undefined): void;
	// 找指定范围安装路径，存在不代表版本/内容有效，缺失返回 undefined。
	getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
}

// 默认实现的构造参数，调用方决定所用设置与基准目录。
interface PackageManagerOptions {
	// 项目 cwd，用于相对命令输入与 .pi 存储地址。
	cwd: string;
	// 用户数据根，传参使测试可用自建临时目录。
	agentDir: string;
	// 设置实例包含项目可信状态与存储后端，构造器不替它获取授权。
	settingsManager: SettingsManager;
	/** Names of built-in extensions, resolved as `builtin:<name>` extension resources. */
	// 已知内置扩展名字列表；这里不验证模块存在，资源加载器后续处理。
	builtinExtensions?: string[];
}

// 三种存储/资源范围的字符串联合，不是运行时 class 或权限对象。
type SourceScope = "user" | "project" | "temporary";

// npm 判别分支的数据；version 是原选择文字，range 是 semver 规范范围，两者含义不同。
type NpmSource = {
	// 字面量标签使 parsed.type===npm 时 TS 可收窄到本类型。
	type: "npm";
	// 去掉 npm: 后的原 npm spec，例如 @scope/pkg@^1.2.3。
	spec: string;
	// 解析出的包名，不含版本/ref。
	name: string;
	// 可选版本、范围或标签文字，保留原样供 npm 命令使用。
	version?: string;
	// 仅当 semver.validRange 接受时生成；latest 等标签可缺此字段。
	range?: string;
	// semver.valid 接受固定版本时为 true，不是只要写了 @ 就固定。
	pinned: boolean;
};

// 本地来源的数据形状，最终可指文件或目录。
type LocalSource = {
	// 本地判别标签。
	type: "local";
	// 原输入路径文字，基于 cwd/设置层的解析留给调用处。
	path: string;
};

// 联合类型用 type 区分三类，GitSource 的 pinned 表示有 ref，和 npm pinned 判定不同。
type ParsedSource = NpmSource | GitSource | LocalSource;

// 长期用户/项目安装范围，TS 类型层排除临时来源。
type InstalledSourceScope = Exclude<SourceScope, "temporary">;

// 一次更新的来源与作用域，不表示这项一定需要更新。
interface ConfiguredUpdateSource {
	// 原配置字符串，用于事件和失败提示。
	source: string;
	// 更新只处理长期安装存储。
	scope: InstalledSourceScope;
}

// extends 在接口中继承 source/scope，再添加 npm 查询结果。
interface NpmUpdateTarget extends ConfiguredUpdateSource {
	// 已解析的 npm spec/范围/固定标志。
	parsed: NpmSource;
	/** Version installed before the update, if any. */
	// 更新前受管理安装的版本，缺失/读失败时可 undefined。
	installedVersion?: string;
	/** Newer version reported by the registry, if the lookup succeeded. */
	// 查询成功时的候选版本，缺失时更新可能仍继续尝试。
	targetVersion?: string;
}

// Git 更新候选，同样继承配置来源与作用域。
interface GitUpdateTarget extends ConfiguredUpdateSource {
	// 解析出的 clone 地址与 ref 等，指定分支也可 pinned=true。
	parsed: GitSource;
}

/** A configured package whose installed npm version or git commit changed during update(). */
// 只在更新后观察到版本/commit 变化时建立的汇总条目。
interface UpdatedPackage extends ConfiguredUpdateSource {
	// 决定后面如何展示 from/to，Git commit 缩到七字符。
	type: "npm" | "git";
	/** npm version or git commit before the update; undefined if it was not installed. */
	// 先前版本/commit 可缺，读取失败也可能造成 undefined。
	from?: string;
	/** npm version or git commit after the update. */
	// 随后版本/commit 也可缺，不能据类型推断更新后一定可用。
	to?: string;
}

// 解析过程中的四类 Map，以原路径为键暂存第一条记录；最终还会排序并按真实路径键去重。
interface ResourceAccumulator {
	// 扩展路径到元数据/启用状态，Map 保留插入顺序。
	extensions: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	// 技能路径使用相同值结构，与扩展分别去重。
	skills: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	// 提示词路径独立维护，不与技能同名路径互相覆盖。
	prompts: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	// 主题路径的暂存容器。
	themes: Map<string, { metadata: PathMetadata; enabled: boolean }>;
}

/**
 * Compute a numeric precedence rank for a resource based on its metadata.
 * Lower rank = higher precedence. Used to sort resolved resources so that
 * name-collision resolution ("first wins") produces the correct outcome.
 *
 * Precedence (highest to lowest):
 *   0  project + settings entry (source: "local", scope: "project")
 *   1  project + auto-discovered (source: "auto", scope: "project")
 *   2  user + settings entry (source: "local", scope: "user")
 *   3  user + auto-discovered (source: "auto", scope: "user")
 *   4  package resource (origin: "package")
 */
// 为资源元数据计算数字优先级，输入 m，返回越小越优先的 rank，无 I/O；如项目显式路径为0、用户自动为3、包为4、内置为5。后续稳定排序保留同级插入先后，不在本函数解决技能名称冲突。
function resourcePrecedenceRank(m: PathMetadata): number {
	// Built-in extensions load after file and package extensions, whichever scope enables them.
	// builtin 标签优先识别，即使 origin/scope 不同仍排到5。
	if (m.source === "builtin") return 5;
	// 普通包资源排4，不按项目/用户再拆等级。
	if (m.origin === "package") return 4;
	// 项目顶层以0起，其余作用域以2起；临时顶层若非 builtin 也走后者。
	const scopeBase = m.scope === "project" ? 0 : 2;
	// local 标签加0，其余自动一类加1，返回最终数值。
	return scopeBase + (m.source === "local" ? 0 : 1);
}

// 包设置对象的局部资源筛选形状，不负责运行时 schema 检查。
interface PackageFilter {
	// false 表示只应用所列增量项；是否借用用户安装还依 project 同身份来源是否存在。
	autoload?: boolean;
	// 可选扩展模式列表；空数组与未指定在普通过滤中不同。
	extensions?: string[];
	// 可选技能筛选，SKILL.md 匹配还会考虑父目录。
	skills?: string[];
	// 可选提示词筛选列表。
	prompts?: string[];
	// 可选主题筛选列表。
	themes?: string[];
}

// 四种资源名的联合，供索引类型与 switch 使用。
type ResourceType = "extensions" | "skills" | "prompts" | "themes";

// 运行时遍历顺序；ResourceType[] 限定成员而不是把数组变成只读。
const RESOURCE_TYPES: ResourceType[] = ["extensions", "skills", "prompts", "themes"];

// Record 让每种资源都有对应 RegExp，未在此扫描文件。
const FILE_PATTERNS: Record<ResourceType, RegExp> = {
	// 扩展常规后缀仅小写 .ts/.js，点须转义，$ 要求到输入末尾，不忽略额外尾换行。
	extensions: /\.(ts|js)$/,
	// 技能通用后缀 .md；实际技能发现还另有目录级 SKILL.md 规则。
	skills: /\.md$/,
	// 提示词通用后缀 .md，大小写敏感。
	prompts: /\.md$/,
	// 主题通用后缀 .json，正则未使用 i/g 标志。
	themes: /\.json$/,
};

// 每层按此顺序加载三种忽略文件，后添加规则可影响匹配结果。
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

// ReturnType<typeof ignore> 取得工厂函数的返回类型，在运行时不会额外调用 ignore。
type IgnoreMatcher = ReturnType<typeof ignore>;

// 把当前平台分隔符变成 /，输入路径字符串，返回新字符串，无文件访问；例如 Windows 反斜杠可转换，POSIX 上不会把反斜杠当平台分隔符替换。
function toPosixPath(p: string): string {
	// split/join 仅替换 sep，不 resolve、去重复斜杠或解析 URL。
	return p.split(sep).join("/");
}

// 取本模块用于 ~ 与 .agents 自动发现的主目录，返回 HOME 非空值或系统 homedir，无写入；例如测试传 HOME 临时目录可隔离用户技能扫描。
function getHomeDir(): string {
	// || 把空串也当缺省，不 trim；此函数不自行创建或验证目录。
	return process.env.HOME || homedir();
}

// 确保 agentDir/tmp/extensions 存在并调整根权限，返回路径字符串；例如临时 npm/Git 来源在它下面建哈希子目录。会同步 mkdir/chmod，错误直接抛出，0o700 在不同平台的权限效果不同。
export function getExtensionTempFolder(agentDir: string): string {
	// 路径从注入的数据根拼出，不使用系统公共临时目录。
	const tempFolder = join(agentDir, "tmp", "extensions");
	// 递归创建根；mode 是八进制新建目录权限，父目录/已存在目录不因此全部改权限。
	mkdirSync(tempFolder, { recursive: true, mode: 0o700 });
	// 再对根显式 chmod，覆盖已存在根的权限；不是给整棵树逐项设置权限或防符号链接沙箱。
	chmodSync(tempFolder, 0o700);
	// 返回拼接路径，未再 realpath。
	return tempFolder;
}

// 把一条子目录忽略规则加上相对扫描根的前缀，输入原行与 prefix，返回规则或 null，无 I/O；例 prefix=sub/、!x 得 !sub/x。仅做这套文字改写，完整 gitignore 语义仍由 ignore 库负责。
function prefixIgnorePattern(line: string, prefix: string): string | null {
	// trim 结果仅用于空白/注释识别，正常规则仍保留原行而非全量 trim。
	const trimmed = line.trim();
	// 空白行不交给匹配器。
	if (!trimmed) return null;
	// 以 # 开头的 trim 后文字当注释忽略；转义 # 不以 # 开头，保留为规则。
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	// let 保存后面可逐步改写的原规则，包含原前后空格。
	let pattern = line;
	// 先假设普通规则，只有未转义的开头 ! 才设置反选标记。
	let negated = false;

	// 这里查原 pattern 的首字符，所以带前导空格的 ! 不会按此分支改写。
	if (pattern.startsWith("!")) {
		// 标记反选，稍后把 ! 放到添加前缀后的最前面。
		negated = true;
		// 暂时去掉一个 !，保留后面规则内容。
		pattern = pattern.slice(1);
		// 以反斜杠转义 ! 时走另一分支，不把它标成反选。
	} else if (pattern.startsWith("\\!")) {
		// 去掉首个反斜杠，剩下 ! 随后按本函数拼接规则转交；并非完整保留全部转义语义。
		pattern = pattern.slice(1);
	}

	// 去掉模式开头一个 /，把本目录锚定表达式转为扫描根相对形式。
	if (pattern.startsWith("/")) {
		// slice(1) 只删除一个字符，不循环清除所有斜杠。
		pattern = pattern.slice(1);
	}

	// 有前缀时直接拼接，调用者负责它已有结尾 /；空前缀保留当前 pattern。
	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	// 如果原来标反选则在结果前补 !，否则返回普通规则。
	return negated ? `!${prefixed}` : prefixed;
}

// 读取 dir 下三种忽略文件并加入传入匹配器，rootDir 为相对路径基准，返回 void；如 /root/sub 的规则先加 sub/。只忽略各文件读取/处理错误，不创建文件。共享匹配器会在递归中累积规则，不按离开目录时撤销。
function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	// 计算扫描根到当前目录的相对文字，不做 realpath。
	const relativeDir = relative(rootDir, dir);
	// 根目录本身用空前缀，子目录转换为 / 并添加结尾分隔符。
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	// 依 .gitignore/.ignore/.fdignore 顺序读取，非并发。
	for (const filename of IGNORE_FILE_NAMES) {
		// 当前忽略文件的路径。
		const ignorePath = join(dir, filename);
		// 不存在就跳下一种名字，不终止整个扫描。
		if (!existsSync(ignorePath)) continue;
		// 仅本文件读正文、改写规则和 ig.add 在这个 catch 里。
		try {
			// 同步 UTF-8 读取，没有调用 stripBom。
			const content = readFileSync(ignorePath, "utf-8");
			// 通过数组流水线生成可加入的规则列表，下几行属于同一表达式。
			const patterns = content
				// 按 LF 或 CRLF 分行，不处理所有 Unicode 换行符。
				.split(/\r?\n/)
				// map 对每行加当前相对目录前缀，空白/注释可能得到 null。
				.map((line) => prefixIgnorePattern(line, prefix))
				// Boolean 过滤空值；line is string 是类型谓词，让 TS 把结果收窄成 string[]。
				.filter((line): line is string => Boolean(line));
			// 至少有一条可用规则时才调用库。
			if (patterns.length > 0) {
				// 把规则加入同一个 ig；它们不是本次调用结束就自动消失的局部选项。
				ig.add(patterns);
			}
			// 空 catch 吞掉本文件的读取/规则处理异常，其他忽略文件仍会继续。
		} catch {}
	}
}

// 判断顶层设置项是否按模式处理，输入字符串返回布尔，无 I/O；例如 !a 或 *.ts 为 true，普通 a.ts 为 false。仅识别这些字符，括号/花括号本身不一定触发本分类。
function isPattern(s: string): boolean {
	// 三个覆盖前缀或任意位置的 * / ? 命中其一即可，未 trim 也未解析转义。
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-") || s.includes("*") || s.includes("?");
}

// 识别 !/+/- 三种覆盖项，无 I/O；例如 +extensions/a.ts 为 true，普通 *.ts 为 false。用于把 manifest 的发现入口与覆盖规则分开。
function isOverridePattern(s: string): boolean {
	// 只检查首字符，不看后续是否是有效路径/模式。
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

// 判断 manifest 入口是否需要磁盘 glob 展开，输入字符串返回布尔，无 I/O；例如 plugins/*/skills 为 true，仅含 {a,b} 不会因花括号独立触发展开。
function hasGlobPattern(s: string): boolean {
	// 只看 * 和 ?，实际 glob 规则交 Node API。
	return s.includes("*") || s.includes("?");
}

/** Glob entries discover visible paths; exact entries can target dot paths or symlinked trees. */
// 在包 root 下展开一个 glob、去掉含隐藏路径段的结果并按字符串排序，返回绝对路径数组；例如 extensions/*.ts 得排序的可见匹配。同步读磁盘，错误向上抛，不验证结果必须位于包内。
function expandPackageGlob(pattern: string, root: string): string[] {
	// root 作为 cwd，不启用 withFileTypes，得到名字字符串；glob 如何遍历链接遵循当前 Node 实现。
	return (
		globSync(pattern, { cwd: root })
			// 把每个匹配按 root 转绝对路径。
			.map((match) => resolve(root, match))
			// 为每个路径检查从 root 走过去的各段，filter 保留所有段都满足的项。
			.filter((path) =>
				// 相对路径可能包含 ..，下面刻意允许这类父目录段，不是禁止越界规则。
				relative(root, path)
					// 按当前平台 sep 拆分段。
					.split(sep)
					// 保留 .. 或不以 . 开头的段，因此隐藏目录/文件匹配会被排除。
					.every((segment) => segment === ".." || !segment.startsWith(".")),
			)
			// 显式比较字符顺序得到 -1/0/1，避免依赖 readdir/glob 返回顺序，不按语言区域排序。
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
	);
}

// 把顶层设置列表分成普通路径和模式两数组，返回新容器，无 I/O；例如 [extensions,!a.ts] 分到 plain/patterns，保留各类内相对顺序。
function splitPatterns(entries: string[]): { plain: string[]; patterns: string[] } {
	// 保存真正提供发现入口的普通路径。
	const plain: string[] = [];
	// 保存只影响启用状态的模式/覆盖规则。
	const patterns: string[] = [];
	// 依输入顺序判断每一项，不改变原数组。
	for (const entry of entries) {
		// 共用前面的有限字符分类，而非对所有 glob 语法做解析。
		if (isPattern(entry)) {
			// 识别为模式的项加入 patterns，不当成磁盘路径立即扫描。
			patterns.push(entry);
			// 其余项才是普通路径分支。
		} else {
			// 加入普通路径列表，是否存在留给后续检查。
			plain.push(entry);
		}
	}
	// 属性简写返回两数组，不深复制字符串或做去重。
	return { plain, patterns };
}

// 递归收集匹配后缀的可见文件，输入目录/正则及可选 node_modules 开关、共享忽略器/根目录，返回路径数组；例如主题目录下递归找 .json。同步读目录/stat/忽略文件，不执行文件。
// 会跟随符号链接判定目标类型并递归，但没有已访问真实目录集合；循环链接可能让递归异常/耗时。共享 ig 会累积子目录规则；单层读取/处理异常被吞掉，返回此前已收集部分，不保证完整扫描或稳定排序。
function collectFiles(
	// 当前递归目录，可以不是最初 root。
	dir: string,
	// 调用方提供的匹配正则，本模块常用无 g 的 FILE_PATTERNS。
	filePattern: RegExp,
	// 省略时默认跳过 node_modules，递归继续传同一个布尔值。
	skipNodeModules = true,
	// 可复用外部忽略器，让已收集规则作用到后续项。
	ignoreMatcher?: IgnoreMatcher,
	// 可复用最初扫描根，用于所有相对匹配路径。
	rootDir?: string,
): string[] {
	// 本次递归结果，异常时可能仅保留一部分。
	const files: string[] = [];
	// 目录路径不存在直接返回空数组。
	if (!existsSync(dir)) return files;

	// ?? 让首层以 dir 作根，后续递归沿用传入 rootDir。
	const root = rootDir ?? dir;
	// 未传忽略器时创建一个默认 ignore 实例，默认规则匹配不区分大小写，仍不是操作系统路径比较。
	const ig = ignoreMatcher ?? ignore();
	// 把当前目录忽略文件并入匹配器；函数本身不整体 try，文件内操作各自处理失败。
	addIgnoreRules(ig, dir, root);

	// 以下目录读取、遍历和递归调用受这一层 catch 保护。
	try {
		// 取得 Dirent 列表，类型判断初始根据目录项，不会先跟随链接。
		const entries = readdirSync(dir, { withFileTypes: true });
		// 依目录返回顺序处理，不先排序。
		for (const entry of entries) {
			// 跳过任何 . 开头的名字，包括隐藏目录及隐藏文件。
			if (entry.name.startsWith(".")) continue;
			// 开关为 true 才排除精确名字 node_modules。
			if (skipNodeModules && entry.name === "node_modules") continue;

			// 拼当前项路径，后续 stat 或递归实际使用它。
			const fullPath = join(dir, entry.name);
			// 先取目录项报告的目录标志，let 允许链接 stat 后改写。
			let isDir = entry.isDirectory();
			// 文件标志独立保存。
			let isFile = entry.isFile();

			// 符号链接需另外 stat 目标，否则 Dirent 自身不算普通文件/目录。
			if (entry.isSymbolicLink()) {
				// 只把当前链接 stat 包起来，断链/无权限时跳过它。
				try {
					// statSync 会跟随链接，未检查解析后目标仍位于扫描根内。
					const stats = statSync(fullPath);
					// 用链接目标目录属性更新标志。
					isDir = stats.isDirectory();
					// 用目标文件属性更新另一标志。
					isFile = stats.isFile();
					// 当前链接无法 stat 时进入。
				} catch {
					// 跳过当前项并扫描后续项。
					continue;
				}
			}

			// 以最初 root 算 / 风格相对名字，交 ignore 而不是用绝对路径匹配。
			const relPath = toPosixPath(relative(root, fullPath));
			// 目录加结尾 /，让忽略器按目录语义处理。
			const ignorePath = isDir ? `${relPath}/` : relPath;
			// 匹配为 ignored 就完全跳过，也不递归被排除目录。
			if (ig.ignores(ignorePath)) continue;

			// 确认目录目标后进入递归分支。
			if (isDir) {
				// 递归时传原 root 与同一 ig，把子结果展开追加；不对符号链接环做 visited 去重。
				files.push(...collectFiles(fullPath, filePattern, skipNodeModules, ig, root));
				// 只有普通文件且正则命中名字才收集；特殊设备等类型略过。
			} else if (isFile && filePattern.test(entry.name)) {
				// 保存当前完整路径，暂不 realpath/去重。
				files.push(fullPath);
			}
		}
		// 当前层任一步处理抛错会停止本层剩余遍历，并保留此前结果。
	} catch {
		// Ignore errors
	}

	// 返回本层加子层累积路径，可能包含重复真实文件。
	return files;
}

// 两种技能目录约定：pi 可接收根层单文件 md，agents 则只接收非根层普通 md；两者都优先 SKILL.md。
type SkillDiscoveryMode = "pi" | "agents";

// 按 pi/agents 两种约定递归找技能入口，输入当前目录、模式及可复用忽略器/根，返回路径列表；例如 foo/SKILL.md 一旦有效，就把 foo 当一个技能，不继续收它下面的嵌套技能。
// 每个目录先找精确名字 SKILL.md，再处理普通 Markdown/子目录。pi 仅收扫描根的普通 .md，agents 仅收非根的普通 .md；都排除隐藏名字/node_modules，跟随符号链接但不做已访问目录去重。读目录/处理异常返回已积累部分，没有验证 Markdown frontmatter 或执行技能。
function collectSkillEntries(
	// 当前目录，在递归过程中会变。
	dir: string,
	// 模式决定普通 .md 文件可在哪一层直接成为入口。
	mode: SkillDiscoveryMode,
	// 已有忽略规则实例，可跨层共享并追加。
	ignoreMatcher?: IgnoreMatcher,
	// 最初扫描根，用于相对规则和 pi/agents 层级判断。
	rootDir?: string,
): string[] {
	// 当前调用收集到的路径数组，不与调用方列表共享容器。
	const entries: string[] = [];
	// 路径不存在就返回空结果，不创建目录。
	if (!existsSync(dir)) return entries;

	// 首层缺省用 dir，递归保留原 root。
	const root = rootDir ?? dir;
	// 未提供时创建 ignore 匹配器，已有时保留其规则状态。
	const ig = ignoreMatcher ?? ignore();
	// 读取当前层忽略文件并追加，离开目录不会自动撤销这些规则。
	addIgnoreRules(ig, dir, root);

	// 目录读取与两轮遍历共用异常边界，某项处理异常可能使本层后续项不再扫描。
	try {
		// 一次取得 Dirent 数组，接下来用同一份结果分别找 SKILL.md 和普通内容。
		const dirEntries = readdirSync(dir, { withFileTypes: true });

		// 第一轮只看专用技能文件，确保它优先于其他 .md 与子目录。
		for (const entry of dirEntries) {
			// 名字必须大小写精确等于 SKILL.md。
			if (entry.name !== "SKILL.md") {
				// 当前不是专用文件名则继续检查下一条，不递归它。
				continue;
			}

			// 构造专用文件候选路径。
			const fullPath = join(dir, entry.name);
			// 初始文件标志来自目录项，链接的目标另查。
			let isFile = entry.isFile();
			// 链接本身不会被 isFile 认作普通文件，需 stat 跟随目标。
			if (entry.isSymbolicLink()) {
				// 只捕获这个目标 stat 的失败。
				try {
					// 检查链接目标是否文件；未限制链接目标仍在技能目录中。
					isFile = statSync(fullPath).isFile();
					// 断链/无权限等错误走本候选的跳过分支。
				} catch {
					// 继续第一轮其他候选。
					continue;
				}
			}

			// 转换成从原根出发的 / 分隔相对路径供 ignore 使用。
			const relPath = toPosixPath(relative(root, fullPath));
			// 必须是文件且未被忽略才把该目录视为专用技能。
			if (isFile && !ig.ignores(relPath)) {
				// 添加 SKILL.md 的路径，不读取其中内容。
				entries.push(fullPath);
				// 立即返回本目录唯一入口，不再进入第二轮或子目录。
				return entries;
			}
		}

		// 没有有效专用入口才第二次遍历，开始发现普通 Markdown 与子目录。
		for (const entry of dirEntries) {
			// 所有 . 开头项跳过，不让隐藏目录继续递归。
			if (entry.name.startsWith(".")) continue;
			// 始终跳过精确名字 node_modules，没有这里的关闭选项。
			if (entry.name === "node_modules") continue;

			// 当前候选的完整路径。
			const fullPath = join(dir, entry.name);
			// 可更新的目录标记，链接目标能改它。
			let isDir = entry.isDirectory();
			// 文件标记独立保存，不把非目录的一切当文件。
			let isFile = entry.isFile();

			// 针对链接额外读取目标类型。
			if (entry.isSymbolicLink()) {
				// 当前链接读不到只跳过它，不立即放弃整层。
				try {
					// 跟随链接读取 stat，没有 realpath visited 集合防止环。
					const stats = statSync(fullPath);
					// 用目标目录状态覆盖初值。
					isDir = stats.isDirectory();
					// 用目标普通文件状态覆盖初值。
					isFile = stats.isFile();
					// 本次链接 stat 异常被局部捕获。
				} catch {
					// 继续第二轮后面的项。
					continue;
				}
			}

			// 相对路径与忽略匹配根保持一致。
			const relPath = toPosixPath(relative(root, fullPath));
			// 多行布尔条件整体决定普通 Markdown 是否独立列为技能。
			const shouldIncludeMarkdownFile =
				// 首先要求目标为普通文件。
				isFile &&
				// 后缀是大小写敏感的 .md。
				entry.name.endsWith(".md") &&
				// 文件路径不得被当前累计忽略规则排除。
				!ig.ignores(relPath) &&
				// pi 只收根层普通 md，agents 只收非根层普通 md；SKILL.md 早已在上轮优先判断。
				((mode === "pi" && dir === root) || (mode === "agents" && dir !== root));
			// 所有条件满足才进入单文件技能分支。
			if (shouldIncludeMarkdownFile) {
				// 保存路径，不在此解析标题、元数据或脚本。
				entries.push(fullPath);
				// 当前文件处理完跳到下项，不走下面目录分支。
				continue;
			}

			// 其他非目录项不继续处理，包括模式不允许的普通 md。
			if (!isDir) continue;
			// 目录匹配时补 /；被忽略父目录不再访问子内容。
			if (ig.ignores(`${relPath}/`)) continue;

			// 传同样模式/忽略器/根继续递归，展开子结果追加。
			entries.push(...collectSkillEntries(fullPath, mode, ig, root));
		}
		// 本层读取或未局部处理的错误静默结束本层剩余扫描。
	} catch {
		// Ignore errors
	}

	// 返回当前已找到入口，可能并非完整列表或唯一真实文件集。
	return entries;
}

// 自动技能发现的薄包装，输入目录与模式，返回默认新忽略器/根策略下的路径列表；例如用户 .agents/skills 传 agents，无额外过滤或执行。
function collectAutoSkillEntries(dir: string, mode: SkillDiscoveryMode): string[] {
	// 只转交两个参数，剩余默认行为都由 collectSkillEntries 决定。
	return collectSkillEntries(dir, mode);
}

// 从 startDir 向上寻找最近含 .git 路径的目录，返回该目录或 null；例如 /repo/sub 发现 /repo/.git 就停。只查存在性，不运行 Git，也不验证 .git 必须是目录/有效仓库。
function findGitRepoRoot(startDir: string): string | null {
	// 按当前进程 cwd 把起点变绝对路径，未 realpath。
	let dir = resolve(startDir);
	// 循环逐层上行，找到 .git 或到根才退出。
	while (true) {
		// .git 作为文件（如 worktree）、目录或可访问链接都可能命中。
		if (existsSync(join(dir, ".git"))) {
			// 返回最近命中层，不继续找外部更大的仓库。
			return dir;
		}
		// 取当前目录的父目录。
		const parent = dirname(dir);
		// 文件系统根的 dirname 与自身相同，防止无限上行。
		if (parent === dir) {
			// 从起点到根都未发现标记时返回 null。
			return null;
		}
		// 推进到上一层，let 允许重赋。
		dir = parent;
	}
}

// 列出起点到最近仓库根（含根）之间每层 .agents/skills 候选，未发现仓库时一直到文件系统根；返回路径数组，只查 .git 来确定边界，不先验证技能目录存在。例 /repo/a 可依次给 /repo/a/.agents/skills、/repo/.agents/skills。
function collectAncestorAgentsSkillDirs(startDir: string): string[] {
	// 按距离由近到远保存候选目录。
	const skillDirs: string[] = [];
	// 起点绝对化，和后面 dirname/仓库根比较使用同一形式。
	const resolvedStartDir = resolve(startDir);
	// 先找到最近 .git 边界，无标记时得到 null。
	const gitRepoRoot = findGitRepoRoot(resolvedStartDir);

	// 上行游标从起点开始。
	let dir = resolvedStartDir;
	// 每次先记录当前层，再判断是否应结束。
	while (true) {
		// 拼接而不 mkdir/readdir，候选不存在也会先入数组。
		skillDirs.push(join(dir, ".agents", "skills"));
		// 有仓库根且已到达时结束，仓库根候选已经加入。
		if (gitRepoRoot && dir === gitRepoRoot) {
			// break 结束循环，不只跳过本次迭代。
			break;
		}
		// 没有到仓库边界就继续看父目录。
		const parent = dirname(dir);
		// 到文件系统根且没有更高层时结束。
		if (parent === dir) {
			// 防止 dirname(root) 反复返回 root。
			break;
		}
		// 游标上移，已有候选顺序不倒置。
		dir = parent;
	}

	// 返回候选列表，存在性/文件发现由后续 collectAutoSkillEntries 决定。
	return skillDirs;
}

// 自动发现提示词目录直属的可见 .md 文件，输入目录返回路径数组；例如 prompts/a.md 纳入，prompts/sub/b.md 不在本函数递归范围。读取忽略文件与链接 stat，错误时保留此前结果，不解析模板正文。
function collectAutoPromptEntries(dir: string): string[] {
	// 当前结果容器。
	const entries: string[] = [];
	// 目录缺失直接空列表。
	if (!existsSync(dir)) return entries;

	// 为这一提示词目录创建独立忽略匹配器。
	const ig = ignore();
	// 只加入此目录自己的三类忽略文件，不从其父目录继承规则。
	addIgnoreRules(ig, dir, dir);

	// 本轮读目录及遍历异常静默结束扫描。
	try {
		// 读取一层 Dirent，未递归子目录。
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		// 依读到的顺序逐项筛选。
		for (const entry of dirEntries) {
			// 隐藏名字一律略过。
			if (entry.name.startsWith(".")) continue;
			// node_modules 名字也略过，不检查内部文件。
			if (entry.name === "node_modules") continue;

			// 当前候选路径。
			const fullPath = join(dir, entry.name);
			// 先据目录项判断文件，链接另查目标。
			let isFile = entry.isFile();
			// 链接也能成为提示词文件，但必须指向普通文件。
			if (entry.isSymbolicLink()) {
				// 局部捕获链接 stat 错误，避免一个断链终止整层。
				try {
					// stat 跟随链接，未限制目标路径范围。
					isFile = statSync(fullPath).isFile();
					// 链接检查失败进入。
				} catch {
					// 仅跳当前项。
					continue;
				}
			}

			// 相对当前提示词根并转 /，给 ignore 比较。
			const relPath = toPosixPath(relative(dir, fullPath));
			// 被忽略的路径不纳入结果。
			if (ig.ignores(relPath)) continue;

			// 普通文件且小写 .md 后缀才收集；目录不会继续递归。
			if (isFile && entry.name.endsWith(".md")) {
				// 加入路径，不读取正文或验证 frontmatter。
				entries.push(fullPath);
			}
		}
		// 其他读取/匹配异常使本层扫描停止，已收集项保留。
	} catch {
		// Ignore errors
	}

	// 返回路径列表，未排序或 realpath 去重。
	return entries;
}

// 自动发现主题目录直属的可见 .json 文件，输入目录返回路径数组；例 themes/dark.json 纳入，子目录不递归。同步查询与忽略规则出错会被局部/整层捕获，不解析或验证 JSON 主题。
function collectAutoThemeEntries(dir: string): string[] {
	// 初始化本轮主题结果。
	const entries: string[] = [];
	// 路径不存在直接空结果。
	if (!existsSync(dir)) return entries;

	// 当前主题目录专用忽略器。
	const ig = ignore();
	// 读取该目录自己的忽略文件，以该目录作根。
	addIgnoreRules(ig, dir, dir);

	// 读取和遍历共用 try，失败返回已有部分。
	try {
		// 只读取直属 Dirent 项，不下钻子目录。
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		// 逐项处理，磁盘枚举顺序保持到结果中。
		for (const entry of dirEntries) {
			// 跳过隐藏主题/目录名。
			if (entry.name.startsWith(".")) continue;
			// 跳过 node_modules 名字。
			if (entry.name === "node_modules") continue;

			// 当前候选完整路径。
			const fullPath = join(dir, entry.name);
			// 初始按 Dirent 判为普通文件与否。
			let isFile = entry.isFile();
			// 链接需要 stat 目标才知道是否是文件。
			if (entry.isSymbolicLink()) {
				// 当前链接的局部失败边界。
				try {
					// 跟随符号链接，目标位置未在此限制。
					isFile = statSync(fullPath).isFile();
					// 链接不可读时进入。
				} catch {
					// 跳过断链等候选。
					continue;
				}
			}

			// 计算主题目录相对路径，转换为 ignore 使用的分隔形式。
			const relPath = toPosixPath(relative(dir, fullPath));
			// 忽略规则命中就不返回这个候选。
			if (ig.ignores(relPath)) continue;

			// 只收普通文件且 .json 后缀大小写精确匹配的项。
			if (isFile && entry.name.endsWith(".json")) {
				// 保存路径，此处没有 JSON.parse。
				entries.push(fullPath);
			}
		}
		// 其他扫描错误吞掉，返回可能不完整列表。
	} catch {
		// Ignore errors
	}

	// 仅返回发现路径，不执行主题加载或真实路径去重。
	return entries;
}

// 为一个扩展目录选择入口：先采用 package.json 中存在的 pi.extensions 路径，全部无效时回退 index.ts，再 index.js；返回非空数组或 null。例目录既有 index.ts 与 helper.ts，只选 index.ts；这是磁盘检查，不导入代码。
function resolveExtensionEntries(dir: string): string[] | null {
	// 拼清单路径。
	const packageJsonPath = join(dir, "package.json");
	// 清单存在时才调用解析器，坏 JSON 由 readPiManifest 返回 null。
	if (existsSync(packageJsonPath)) {
		// 只得到合法字符串数组字段的 PiManifest，未检查其中路径归属。
		const manifest = readPiManifest(packageJsonPath);
		// ?. 连续可选访问；只有非空 extensions 数组才进入。
		if (manifest?.extensions?.length) {
			// 保存真正存在的清单入口，不提前展开 glob。
			const entries: string[] = [];
			// 每个声明当作文字路径处理，此函数不是 collectFilesFromManifestEntries。
			for (const extPath of manifest.extensions) {
				// 按 dir resolve，绝对 extPath 可脱离 dir；这里不展开 ~ 或检查包根归属。
				const resolvedExtPath = resolve(dir, extPath);
				// 只要存在就收，不要求普通文件或特定后缀。
				if (existsSync(resolvedExtPath)) {
					// 保持清单列出顺序，暂不去重。
					entries.push(resolvedExtPath);
				}
			}
			// 只在至少一个清单路径存在时采用清单结果。
			if (entries.length > 0) {
				// 直接返回，跳过下面 index 回退。
				return entries;
			}
		}
	}

	// TypeScript 默认入口候选。
	const indexTs = join(dir, "index.ts");
	// JavaScript 默认入口候选。
	const indexJs = join(dir, "index.js");
	// 优先 index.ts，存在即可，不先 stat 文件类型。
	if (existsSync(indexTs)) {
		// 用单元素数组表示一个扩展入口。
		return [indexTs];
	}
	// TS 入口不存在才试 index.js。
	if (existsSync(indexJs)) {
		// 只返回 JS 候选，不与之前不存在的 TS 混合。
		return [indexJs];
	}

	// 没有可采用入口时用 null，区别于有空数组结果的普通资源扫描。
	return null;
}

// 自动发现一个目录内的扩展入口，输入目录返回路径列表；先把目录自身按清单/index 识别，成功就直接返回，否则取直属 .ts/.js 和有清单/index 的子目录。例 extensions/foo/index.ts 不会把 foo/helper.ts 也单独列出。
// 同步访问忽略文件/Dirent/stat，不递归随意深入所有目录，不导入/执行扩展。根目录的显式清单/index 成功时早于 ignores 处理；子目录只在父层通过过滤后查入口。
function collectAutoExtensionEntries(dir: string): string[] {
	// 保存普通发现模式的结果。
	const entries: string[] = [];
	// 目录不存在立即空列表。
	if (!existsSync(dir)) return entries;

	// First check if this directory itself has explicit extension entries (package.json or index)
	// 先看整个目录是否就是一个扩展包/入口，不先读忽略规则。
	const rootEntries = resolveExtensionEntries(dir);
	// 非 null 数组代表已找到至少一个可用入口。
	if (rootEntries) {
		// 直接采用显式根入口，忽略其他直属文件。
		return rootEntries;
	}

	// Otherwise, discover extensions from directory contents
	// 无根入口才建忽略器做普通目录发现。
	const ig = ignore();
	// 添加此层 .gitignore/.ignore/.fdignore，父目录规则不自动继承。
	addIgnoreRules(ig, dir, dir);

	// 目录遍历及子入口处理异常在此捕获，之前的根入口查询不在此 try。
	try {
		// 拿到直属文件类型列表。
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		// 逐项处理，不按名字排序。
		for (const entry of dirEntries) {
			// 隐藏名字不自动成为扩展。
			if (entry.name.startsWith(".")) continue;
			// node_modules 不作为普通自动扫描目录深入。
			if (entry.name === "node_modules") continue;

			// 完整候选路径。
			const fullPath = join(dir, entry.name);
			// 当前目录项是否目录，后续链接 stat 可覆盖。
			let isDir = entry.isDirectory();
			// 当前项是否普通文件，不能由不是目录直接推断。
			let isFile = entry.isFile();

			// 链接按它的目标类型处理。
			if (entry.isSymbolicLink()) {
				// 局部捕获断链等 stat 异常。
				try {
					// 跟随链接读取目标，不限制真实目标仍在根内。
					const stats = statSync(fullPath);
					// 更新目录标志。
					isDir = stats.isDirectory();
					// 更新文件标志。
					isFile = stats.isFile();
					// 当前链接读取失败时进入。
				} catch {
					// 跳当前链接继续下项。
					continue;
				}
			}

			// 把候选变为当前发现根的相对 / 路径。
			const relPath = toPosixPath(relative(dir, fullPath));
			// 目录名补 /，区分 ignore 的目录规则。
			const ignorePath = isDir ? `${relPath}/` : relPath;
			// 命中忽略规则则既不收集文件，也不检查子目录入口。
			if (ig.ignores(ignorePath)) continue;

			// 直属普通 .ts/.js 文件直接是入口，大小写敏感，不读模块内容。
			if (isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
				// 保存该文件路径。
				entries.push(fullPath);
				// 其他目录则只查其清单/index，不任意递归全部源码。
			} else if (isDir) {
				// 对子目录应用同样的入口选择优先级。
				const resolvedEntries = resolveExtensionEntries(fullPath);
				// 没有入口就略过这一子目录。
				if (resolvedEntries) {
					// 展开子目录显式入口数组，保持其顺序。
					entries.push(...resolvedEntries);
				}
			}
		}
		// 本层扫描异常静默吞掉，已有 entries 保留。
	} catch {
		// Ignore errors
	}

	// 返回找到的入口，不代表已运行或名字冲突已经解决。
	return entries;
}

/**
 * Collect resource files from a directory based on resource type.
 * Extensions use smart discovery (index.ts in subdirs), others use recursive collection.
 */
// 按资源类型选择目录收集策略，输入 dir/resourceType，返回路径列表；技能用 pi 模式、扩展用智能入口，其余用递归后缀查找。例包的 prompts 子目录可递归收 md，与自动顶层 prompts 仅一层不同。
function collectResourceFiles(dir: string, resourceType: ResourceType): string[] {
	// 技能需要 SKILL.md 与根层单文件语义，不能等同普通递归 md。
	if (resourceType === "skills") {
		// 直接转交 pi 模式技能收集。
		return collectSkillEntries(dir, "pi");
	}
	// 扩展目录要避免把子目录 helper 模块全部当入口。
	if (resourceType === "extensions") {
		// 转交清单/index 优先的自动扩展发现。
		return collectAutoExtensionEntries(dir);
	}
	// prompts/themes 用对应正则递归，默认跳过隐藏项/node_modules。
	return collectFiles(dir, FILE_PATTERNS[resourceType]);
}

// A `pi` object counts as an explicit resource manifest only when it lists resources. Packages whose
// `pi` object holds only metadata (changelogPath, gallery image/video) still use directory auto-discovery.
// 判断清单是否显式声明至少一种资源字段，返回布尔，无 I/O；例如仅 changelogPath 为 false，extensions:[] 为 true。它看字段是否 undefined，不要求非空或扫描出文件。
function hasManifestResourceFields(manifest: PiManifest): boolean {
	// some 任一资源字段存在即 true，空数组也满足；changelogPath 等元数据字段不算资源声明。
	return RESOURCE_TYPES.some((resourceType) => manifest[resourceType] !== undefined);
}

// 按路径文字判断 child 是否严格位于 parent 内，输入两路径返回布尔，无 I/O；例如 /a/b 在 /a 内，/a 本身为 false。真实路径链接是否已解析取决于调用方。
function isPathInside(parent: string, child: string): boolean {
	// 先求相对路径，跨盘可能返回绝对结果。
	const relativePath = relative(parent, child);
	// 下面所有 && 条件同时满足才认为严格在内部。
	return (
		// 排除同目录空串、父目录自身、以 ../ 开头与绝对结果；不是单纯字符串以 parent 开头就通过。
		relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
	);
}

// 选择包内变更日志候选路径，输入包根和可缺清单，返回已有普通文件地址或 undefined；例默认 CHANGELOG.md，显式空串则禁用。尝试 canonicalize 后要求严格在包内，失败时不另找默认回退；只检查存在/类型，不读取正文或保证后续可读。
function resolvePackageChangelogPath(packageRoot: string, manifest: PiManifest | null): string | undefined {
	// 仅 null/undefined 才用默认名字，空字符串会保留到下个判断。
	const changelogPath = manifest?.changelogPath ?? "CHANGELOG.md";
	// 显式空日志名直接返回无结果。
	if (!changelogPath) return undefined;

	// 按包根 resolve 清单文字，不做 ~ 展开。
	const resolvedPath = resolve(packageRoot, changelogPath);
	// 候选不存在就结束，不在清单路径无效后自动尝试默认 CHANGELOG.md。
	if (!existsSync(resolvedPath)) return undefined;

	// 尝试真实化包根，失败按辅助函数规则保留原路径。
	const canonicalPackageRoot = canonicalizePath(packageRoot);
	// 同样真实化日志目标，便于拒绝已知的包外链接。
	const canonicalChangelogPath = canonicalizePath(resolvedPath);
	// 要求两份比较路径严格内部；检查与随后 stat/实际读取仍有时序窗口，不是不可变文件句柄保证。
	if (!isPathInside(canonicalPackageRoot, canonicalChangelogPath)) return undefined;

	// 捕获最后 stat 的失败。
	try {
		// 目标为普通文件才返回原 resolvedPath，而非 canonicalChangelogPath；目录不作为日志文件。
		return statSync(resolvedPath).isFile() ? resolvedPath : undefined;
		// 权限/消失等 stat 错误转无结果。
	} catch {
		// 返回 undefined 让调用方清掉 metadata 中旧日志字段。
		return undefined;
	}
}

// 按 glob 测试一个资源是否命中任一模式，输入文件/模式数组/基准目录，返回布尔；对 SKILL.md 还匹配父目录名字与路径，如 !**/foo 可排 foo/SKILL.md。只计算字符串，不扫描磁盘。
function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	// 准备相对于资源基准的 / 路径。
	const rel = toPosixPath(relative(baseDir, filePath));
	// 准备文件本名，让 a.ts 这样的模式也可直接命中。
	const name = basename(filePath);
	// 准备完整 / 路径作为第三种可匹配形式。
	const filePathPosix = toPosixPath(filePath);
	// 只有精确 SKILL.md 文件名享有下面父目录匹配。
	const isSkillFile = name === "SKILL.md";
	// 是专用技能文件时取父目录，其他资源保留 undefined。
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	// 父目录相对路径；parentDir! 的非空断言依靠 isSkillFile 分支，不是运行时检查。
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	// 父目录本名，允许模式按技能目录名字匹配。
	const parentName = isSkillFile ? basename(parentDir!) : undefined;
	// 父目录完整 / 路径，仍不 realpath。
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	// some 按顺序找任意命中，成功即短路。
	return patterns.some((pattern) => {
		// 模式先走默认 normalizePath（含系统主目录 ~ 展开等）再转 /；此处未显式用 getHomeDir 的 HOME 注入。
		const normalizedPattern = toPosixPath(normalizePath(pattern));
		// 依次比较相对路径、本名、完整路径，任何一种通过即可。
		if (
			// 相对基准的模式匹配。
			minimatch(rel, normalizedPattern) ||
			// 文件名本身匹配，独立于模式是否包含目录部分。
			minimatch(name, normalizedPattern) ||
			// 完整路径匹配；第三方默认语义仍会解释 glob 特殊字符。
			minimatch(filePathPosix, normalizedPattern)
		) {
			// 文件自身任一形式命中即返回 true，不再看技能父目录。
			return true;
		}
		// 普通资源文件未命中就当前模式失败。
		if (!isSkillFile) return false;
		// 专用技能文件额外比较三个父目录表示形式。
		return (
			// 父目录的相对路径匹配。
			minimatch(parentRel!, normalizedPattern) ||
			// 技能目录名本身匹配。
			minimatch(parentName!, normalizedPattern) ||
			// 父目录完整路径匹配。
			minimatch(parentDirPosix!, normalizedPattern)
		);
	});
}

// 规范精确覆盖路径，输入模式文字返回 / 风格字符串，无 I/O；例 ./extensions/a.ts 去掉首个 ./。只删开头一组 ./ 或反斜杠形式，不把任意点段彻底折叠。
function normalizeExactPattern(pattern: string): string {
	// 两个前缀命中任一个就 slice(2)，其他文字原样保留。
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	// 再做默认 ~ /file URL/平台输入归一化，最后换当前平台分隔符；不调用路径 resolve。
	return toPosixPath(normalizePath(normalized));
}

// 判断资源是否命中任一精确路径，输入文件/列表/基准目录，返回布尔，无磁盘扫描；普通文件只对相对或完整路径，不支持仅本名隐式匹配，SKILL.md 另可精确指定父目录。例 +skills/foo 可命中该目录专用技能。
function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	// 空规则列表立即 false。
	if (patterns.length === 0) return false;
	// 资源的相对 / 路径。
	const rel = toPosixPath(relative(baseDir, filePath));
	// 取本名仅用于识别 SKILL.md，不作为一般精确比较候选。
	const name = basename(filePath);
	// 资源完整 / 路径。
	const filePathPosix = toPosixPath(filePath);
	// 精确专用技能名字决定是否额外考虑父目录。
	const isSkillFile = name === "SKILL.md";
	// 仅技能文件计算父目录。
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	// 技能父目录相对路径，非空断言不新增运行校验。
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	// 技能父目录完整路径。
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	// 任一精确模式成功即可，不依次改启用状态。
	return patterns.some((pattern) => {
		// 去单个 ./ 前缀并作输入归一化，仍不按 glob 解释。
		const normalized = normalizeExactPattern(pattern);
		// 只做字符串严格相等，没有文件名 basename 兜底或大小写统一。
		if (normalized === rel || normalized === filePathPosix) {
			// 文件路径命中返回 true。
			return true;
		}
		// 非专用技能文件在自身路径未命中后立即 false。
		if (!isSkillFile) return false;
		// 专用技能父目录任一种表示完全相等也算命中。
		return normalized === parentRel || normalized === parentDirPosix;
	});
}

// 从列表中保留三种覆盖前缀，返回新数组，无 I/O；例如普通 extensions 和 *.ts 被排除，只保留 !/+/- 条目。
function getOverridePatterns(entries: string[]): string[] {
	// filter 只看首字符，原规则内容和顺序保留。
	return entries.filter((pattern) => pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"));
}

// 为已自动发现的一个资源计算最终默认启用状态，输入路径/所有设置条目/基准，返回布尔；默认开，! 可关，+精确路径可开回，-精确路径最终关。例 !*.ts 与 +a.ts 同时存在时精确加回优先，不按它们在数组中的先后。
function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
	// 先忽略普通 include/发现路径，只处理覆盖标记。
	const overrides = getOverridePatterns(patterns);
	// 取 ! 组并删一个前缀，后续用 glob 匹配。
	const excludes = overrides.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	// 取 + 组并删前缀，后续只做精确匹配。
	const forceIncludes = overrides.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
	// 取 - 组并删前缀，最后拥有最强关闭优先级。
	const forceExcludes = overrides.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));

	// 自动发现资源默认启用，即使没有普通 include 模式。
	let enabled = true;
	// 有任一排除模式命中就先关闭。
	if (excludes.length > 0 && matchesAnyPattern(filePath, excludes, baseDir)) {
		// 更新局部布尔，未改原路径或设置。
		enabled = false;
	}
	// 精确强制包含可把上面的排除结果重新打开。
	if (forceIncludes.length > 0 && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
		// 设置 true，不表示磁盘文件因此新建或被执行。
		enabled = true;
	}
	// 精确强制排除最后处理，覆盖强制包含。
	if (forceExcludes.length > 0 && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) {
		// 最终关闭本资源。
		enabled = false;
	}
	// 返回本次计算状态，不改变模式数组。
	return enabled;
}

/**
 * Apply patterns to paths and return a Set of enabled paths.
 * Pattern types:
 * - Plain patterns: include matching paths
 * - `!pattern`: exclude matching paths
 * - `+path`: force-include exact path (overrides exclusions)
 * - `-path`: force-exclude exact path (overrides force-includes)
 */
// 从已经发现的 allPaths 中选择启用子集，输入模式与匹配基准，返回 Set<string>，无 I/O；例先包含 *.ts、!排除、+精确加回、-最终精确删除。+ 只能加回 allPaths 已有路径，不会发现新文件；四类优先级固定而非原列表顺序。
function applyPatterns(allPaths: string[], patterns: string[], baseDir: string): Set<string> {
	// 普通 include 模式集合。
	const includes: string[] = [];
	// 带 ! 的普通 glob 排除集合。
	const excludes: string[] = [];
	// 带 + 的精确加回集合。
	const forceIncludes: string[] = [];
	// 带 - 的精确最终删除集合。
	const forceExcludes: string[] = [];

	// 先按规则首字符分组，保留每组内部顺序。
	for (const p of patterns) {
		// + 前缀优先识别为精确强制包含。
		if (p.startsWith("+")) {
			// 删掉标记保存目标文字。
			forceIncludes.push(p.slice(1));
			// - 前缀对应精确强制排除。
		} else if (p.startsWith("-")) {
			// 保留不含标记的目标文字。
			forceExcludes.push(p.slice(1));
			// ! 前缀对应 glob 排除。
		} else if (p.startsWith("!")) {
			// 去掉首个 !，剩余交匹配器解释。
			excludes.push(p.slice(1));
			// 没有上述前缀就是普通 include。
		} else {
			// 普通规则原样保存，可含 glob。
			includes.push(p);
		}
	}

	// Step 1: Apply includes (or all if no includes)
	// 结果在后续几个步骤逐步被替换/追加。
	let result: string[];
	// 没有普通 include 并不意味着全禁，而是先包含所有候选。
	if (includes.length === 0) {
		// 展开复制数组容器，避免后面 push 直接改 allPaths。
		result = [...allPaths];
		// 存在普通 include 时先筛候选子集。
	} else {
		// 每个文件用 glob 任一模式匹配，不新增磁盘路径。
		result = allPaths.filter((filePath) => matchesAnyPattern(filePath, includes, baseDir));
	}

	// Step 2: Apply excludes
	// 有 ! 组才做排除遍历。
	if (excludes.length > 0) {
		// 留下未匹配排除模式的结果。
		result = result.filter((filePath) => !matchesAnyPattern(filePath, excludes, baseDir));
	}

	// Step 3: Force-include (add back from allPaths, overriding exclusions)
	// 若有强制包含则从完整候选集中查可加回项。
	if (forceIncludes.length > 0) {
		// 遍历所有已发现路径，不遍历文件系统。
		for (const filePath of allPaths) {
			// 尚未在结果内且精确命中 + 路径时才追加。
			if (!result.includes(filePath) && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
				// 加回结果尾部，因此顺序未必等于 allPaths 原顺序。
				result.push(filePath);
			}
		}
	}

	// Step 4: Force-exclude (remove even if included or force-included)
	// 最后执行 - 规则，不受此前 include/forceIncludes 影响。
	if (forceExcludes.length > 0) {
		// 精确强制排除的项移出结果。
		result = result.filter((filePath) => !matchesAnyExactPattern(filePath, forceExcludes, baseDir));
	}

	// 转 Set 去掉相同字符串，保留当前顺序；未 realpath 去重。
	return new Set(result);
}

// 为 autoload:false 增量配置计算显式提及资源的布尔映射，输入已发现路径/模式/基准，返回 Map，无 I/O；例 [a.ts,!a.ts] 后一条覆盖前条，未提及的路径完全不写入。与普通四组固定优先级不同，这里按原列表顺序更新。
function applyAutoloadDisabledPatterns(allPaths: string[], patterns: string[], baseDir: string): Map<string, boolean> {
	// 只存有规则匹配的路径及状态，不给所有候选自动补 false。
	const result = new Map<string, boolean>();
	// 逐条按原设置顺序处理，所以同一路径的后命中决定最终状态。
	for (const pattern of patterns) {
		// 计算去标记后的匹配目标，slice 的起点在下一行三元表达式里选择。
		const target = pattern.slice(
			// 三个覆盖标记都只剥一个字符，普通模式从0保留全部。
			pattern.startsWith("+") || pattern.startsWith("-") || pattern.startsWith("!") ? 1 : 0,
		);
		// ! 和 - 表示关闭，普通模式或 + 表示打开。
		const enabled = !pattern.startsWith("-") && !pattern.startsWith("!");
		// +/- 使用精确路径，!/普通模式使用 glob。
		const exact = pattern.startsWith("+") || pattern.startsWith("-");
		// 把当前模式应用到每个已发现路径，不额外发现文件。
		for (const filePath of allPaths) {
			// 条件整体由下面三元表达式决定。
			if (
				// 根据 exact 在精确与 glob 两套匹配中选一套；只计算选中分支。
				exact ? matchesAnyExactPattern(filePath, [target], baseDir) : matchesAnyPattern(filePath, [target], baseDir)
			) {
				// Map.set 覆盖同一路径此前状态，没命中则保持之前记录或缺席。
				result.set(filePath, enabled);
			}
		}
	}
	// 返回显式增量，调用方可与用户层默认资源叠加。
	return result;
}

// 默认实现保存目录、设置与进度状态，implements 只让 TS 检查接口形状；实例构造不立即安装包，调用 install/resolve/update 等才开始相应工作。
export class DefaultPackageManager implements PackageManager {
	// 项目绝对基准，private 是 TS 访问约束，不是 # 字段运行时隔离。
	private cwd: string;
	// 用户数据绝对基准，不一定是系统默认主目录。
	private agentDir: string;
	// 保存调用方设置实例，后续修改仍通过同一实例可见。
	private settingsManager: SettingsManager;
	// 内置扩展名字列表，当前不复制传入数组。
	private builtinExtensions: string[];
	// 缓存旧全局 npm 根，尚未查询时 undefined。
	private globalNpmRoot: string | undefined;
	// 缓存根对应的命令+参数文字键，命令配置变化时可失效。
	private globalNpmRootCommandKey: string | undefined;
	// 可省略同步事件处理函数，实例之间不共享此字段。
	private progressCallback: ProgressCallback | undefined;

	// 以 cwd/agentDir/设置和可选内置名构造管理器，保存状态，无安装/资源扫描；例 new DefaultPackageManager({cwd,agentDir,settingsManager})。路径归一化可因非法 file URL 等抛错，构造不自动创建安装目录。
	constructor(options: PackageManagerOptions) {
		// 把 cwd 按公共路径规则变绝对，未 realpath；后续相对命令输入以它为基准。
		this.cwd = resolvePath(options.cwd);
		// 同样规范用户数据根，省去每次拼接重新 resolve。
		this.agentDir = resolvePath(options.agentDir);
		// 保留设置对象引用，不克隆实例或替换它的存储后端。
		this.settingsManager = options.settingsManager;
		// 仅缺省时建空数组，传了数组就保留其引用；?? 不按一般真假值回退。
		this.builtinExtensions = options.builtinExtensions ?? [];
	}

	// 替换当前进度回调，输入函数或 undefined，返回 void，无即时事件；例如 CLI 安装一个打印回调，完成后传 undefined 清除。回调同步执行，异常不在此吞掉。
	setProgressCallback(callback: ProgressCallback | undefined): void {
		// 直接重写字段，后续 emitProgress 使用新函数。
		this.progressCallback = callback;
	}

	// 把来源新增或按身份替换到用户/项目 packages 设置，输入 source 与可选 local，返回配置是否发生变化；例同一 Git 仓库 v1→v2 替换 source，保留原对象的资源过滤字段。
	// 先规范本地地址为相应设置基准的相对路径，再匹配忽略 npm 版本/Git ref 的身份。只操作设置，不安装；设置 setter 可排队保存，本方法不 await flush，也不在后续写盘失败时撤销返回的 true。项目存储/写入受对应信任检查。
	addSourceToSettings(source: string, options?: { local?: boolean }): boolean {
		// local 真值选 project，省略或 false 选 user。
		const scope: SourceScope = options?.local ? "project" : "user";
		// 选择对应原始层设置，而非合并后的有效列表。
		const currentSettings =
			// 两 getter 都返回深复制，下面不会直接改 SettingsManager 内部数组。
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		// 缺省 packages 视为空数组。
		const currentPackages = currentSettings.packages ?? [];
		// 本地输入按本实例 cwd 解析后转为设置基准相对路径；npm/Git 原文字保留。
		const normalizedSource = this.normalizePackageSourceForSettings(source, scope);
		// findIndex 只取第一个同身份配置，未命中为 -1；本地设置相对设置基准，用户输入相对 cwd。
		const matchIndex = currentPackages.findIndex((existing) => this.packageSourcesMatch(existing, source, scope));
		// 找到已有同身份项则尝试替换，不再追加第二条。
		if (matchIndex !== -1) {
			// 取出已有字符串或筛选对象。
			const existing = currentPackages[matchIndex];
			// 旧来源文字已等于规范新来源时没有变化，过滤内容原样保留。
			if (this.getPackageSourceString(existing) === normalizedSource) {
				// 返回 false，不触发 setter。
				return false;
			}
			// 浅复制列表容器，避免直接改 currentPackages。
			const nextPackages = [...currentPackages];
			// 仅替换匹配位置，不调整列表顺序。
			nextPackages[matchIndex] =
				// 字符串直接换值；对象浅展开保留 autoload/过滤数组等字段，再覆盖 source。
				typeof existing === "string" ? normalizedSource : { ...existing, source: normalizedSource };
			// 根据之前确定作用域选择写入口。
			if (scope === "project") {
				// 更新项目层，未可信时 setter 可抛错；这里只触发其排队保存。
				this.settingsManager.setProjectPackages(nextPackages);
				// 否则写用户层。
			} else {
				// 更新全局 packages，未保证此行返回时已写磁盘。
				this.settingsManager.setPackages(nextPackages);
			}
			// 表示内存配置已提交修改，不是安装或持久化完整性结果。
			return true;
		}
		// 没有身份匹配项则把规范来源追加到列表末尾。
		const nextPackages = [...currentPackages, normalizedSource];
		// 新来源同样按 local 作用域保存。
		if (scope === "project") {
			// 向项目层写新列表。
			this.settingsManager.setProjectPackages(nextPackages);
			// 非项目转用户分支。
		} else {
			// 向用户层写新列表。
			this.settingsManager.setPackages(nextPackages);
		}
		// 返回本次配置有新增。
		return true;
	}

	// 从用户/项目 packages 删除所有同身份项，输入来源与可选 local，返回是否删到配置；例如输入 npm:foo 可匹配已配置 npm:foo@1.2.3。不卸载、不删源目录；setter 的排队保存/信任错误仍按 SettingsManager 处理。
	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean {
		// 决定所查设置层。
		const scope: SourceScope = options?.local ? "project" : "user";
		// 按层取当前配置深复制。
		const currentSettings =
			// 项目/用户 getter 的分支，不读取合并层以免删错作用域。
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		// 缺失列表当空列表。
		const currentPackages = currentSettings.packages ?? [];
		// filter 保留不匹配身份的项，可能一次移除多个重复身份。
		const nextPackages = currentPackages.filter((existing) => !this.packageSourcesMatch(existing, source, scope));
		// 按长度判断有没有删掉项，不比较对象内容。
		const changed = nextPackages.length !== currentPackages.length;
		// 没有匹配项则不用写设置。
		if (!changed) {
			// 返回 false，不代表安装目录不存在。
			return false;
		}
		// 有变化后才选择项目写入。
		if (scope === "project") {
			// 项目 setter 负责信任/队列，后续错误不在此统一回滚。
			this.settingsManager.setProjectPackages(nextPackages);
			// 其余作用域写全局层。
		} else {
			// 更新用户 packages 列表。
			this.settingsManager.setPackages(nextPackages);
		}
		// 返回已删到配置项；不等待磁盘 flush。
		return true;
	}

	// 寻找指定 user/project 范围当前存在的包路径，返回路径或 undefined；例如本地 ./foo 相对该设置层基准，而非命令输入 cwd。npm 用户层优先受管理目录，缺失可探测旧全局布局并启动只读命令；存在检查不校验版本/代码可用性。
	getInstalledPath(source: string, scope: "user" | "project"): string | undefined {
		// 先分类来源，不联网解析地址。
		const parsed = this.parseSource(source);
		// npm 判别分支让 parsed 收窄为 NpmSource。
		if (parsed.type === "npm") {
			// 优先管理路径，必要时查询旧 npm/pnpm 全局安装地址。
			const path = this.getNpmInstallPath(parsed, scope);
			// 只根据路径存在性返回，不要求目录/有效 package.json。
			return existsSync(path) ? path : undefined;
		}
		// Git 分支使用受管理 host/path 安装位置。
		if (parsed.type === "git") {
			// scope=project 时路径辅助函数会先检查项目可信。
			const path = this.getGitInstallPath(parsed, scope);
			// 目标存在才返回，未检查当前 ref/commit。
			return existsSync(path) ? path : undefined;
		}
		// 本地来源使用设置层相对语义。
		if (parsed.type === "local") {
			// user 是 agentDir，project 是 cwd/.pi 且检查信任。
			const baseDir = this.getBaseDirForScope(scope);
			// 解析本地输入，支持归一化规则如 ~ 和 file URL。
			const path = this.resolvePathFromBase(parsed.path, baseDir);
			// 只检查存在，不复制/安装原目录。
			return existsSync(path) ? path : undefined;
		}
		// 联合分支外的兜底结果；正确 TS 输入通常已经覆盖三种类型。
		return undefined;
	}

	// 同步派发一个进度事件，输入事件返回 void；例 callback 在 start 打印提示。未设置回调则无操作，不复制事件或捕获回调异常。
	private emitProgress(event: ProgressEvent): void {
		// 可选调用只在字段非 null/undefined 时执行，回调抛错会传播。
		this.progressCallback?.(event);
	}

	// 把一个异步操作包在进度通知中，输入动作、来源、开始文字与 operation，成功返回 Promise<void>，失败重抛；例如 install 正常通知 start→complete。
	// start 在 try 外，complete 在 try 内：start 回调抛错会阻止执行；complete 回调抛错也会进入 catch 发送 error；error 回调再抛可替换原错误。所以严格配对依赖回调正常工作。
	private async withProgress(
		// 索引访问类型取 ProgressEvent.action 的允许标签。
		action: ProgressEvent["action"],
		// 事件中的来源文字，可以是批次汇总标签。
		source: string,
		// 仅开始事件附带的提示。
		message: string,
		// 接收一个尚未执行、返回 Promise<void> 的函数，方便在 start 之后才开始。
		operation: () => Promise<void>,
	): Promise<void> {
		// 先同步发送 start，此行失败不进入下面 catch。
		this.emitProgress({ type: "start", action, source, message });
		// 开始捕获 operation 拒绝与 complete 派发异常。
		try {
			// 执行并等待实际工作，异步拒绝在当前 try 中捕获。
			await operation();
			// 操作正常结束才发 complete；没有 message 字段。
			this.emitProgress({ type: "complete", action, source });
			// 操作失败或 complete 回调失败都进入这里。
		} catch (error) {
			// Error 用 message，其他抛出值 String 化，没有脱敏/错误码归一化。
			const errorMessage = error instanceof Error ? error.message : String(error);
			// 同步发送 error，若这里又抛错会跳过下行原错误重抛。
			this.emitProgress({ type: "error", action, source, message: errorMessage });
			// 保留捕获的原抛出值，使调用方 await 拒绝。
			throw error;
		}
	}

	// 汇总配置包、顶层显式路径、自动目录和内置扩展，输入可选缺失包决策回调，返回四类带状态/来源的资源及补装失败；例同一仓库在项目/用户配置时通常项目优先，autoload:false 项目项则可作用户安装的增量覆盖。
	// 先收包，再显式本地，再自动目录/内置，最后排序并按路径键去重。可能补装 npm/Git、运行查询/安装命令、读写文件；部分补装失败记录后继续，onMissing=error/其他未捕获错误仍拒绝。只收入口不执行扩展，但会读取用户 .agents 及可信项目祖先目录。
	async resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths> {
		// 本次创建独立四类 Map，不复用上次发现结果。
		const accumulator = this.createAccumulator();
		// 读取用户原始设置快照，未与项目混合。
		const globalSettings = this.settingsManager.getGlobalSettings();
		// 读取已加载项目层快照，不可信实例通常为空项目层。
		const projectSettings = this.settingsManager.getProjectSettings();

		// Collect all packages with scope (project first so cwd resources win collisions)
		// 显式数组成员类型同时保留原设置项与来源作用域。
		const allPackages: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
		// 先加入项目包，使它们在去重/同路径首条保留中优先。
		for (const pkg of projectSettings.packages ?? []) {
			// 对象简写 pkg 保留原项，scope 标记 project。
			allPackages.push({ pkg, scope: "project" });
		}
		// 再加入用户包，默认空数组允许无配置。
		for (const pkg of globalSettings.packages ?? []) {
			// 标记 user，不在此安装。
			allPackages.push({ pkg, scope: "user" });
		}

		// Dedupe: project scope wins over global for same package identity
		// 按 npm 包名/Git host-path/本地比较路径身份去重，项目 autoload=false 与同身份用户项可同时保留。
		const packageSources = this.dedupePackages(allPackages);
		// 异步解析/必要时安装各来源，把找到资源写入 accumulator，接收明确补装失败列表。
		const installFailures = await this.resolvePackageSources(packageSources, accumulator, onMissing);

		// 用户顶层相对路径基准为 agentDir。
		const globalBaseDir = this.agentDir;
		// 项目顶层路径以 cwd/.pi 为基准，不以 cwd 直接解释设置项。
		const projectBaseDir = join(this.cwd, CONFIG_DIR_NAME);

		// 按四类资源分别解析顶层数组。
		for (const resourceType of RESOURCE_TYPES) {
			// 取得对应资源的暂存 Map，后面同原路径首先加入的记录不会被覆盖。
			const target = this.getTargetMap(accumulator, resourceType);
			// 缺失字段当空列表，as string[] 只是类型声明，不运行额外数组/成员验证。
			const globalEntries = (globalSettings[resourceType] ?? []) as string[];
			// 项目数组独立读取，避免先合并丢作用域。
			const projectEntries = (projectSettings[resourceType] ?? []) as string[];
			// 先处理项目显式路径与启用模式，不自行安装这些本地路径。
			this.resolveLocalEntries(
				// 本次项目资源条目。
				projectEntries,
				// 告诉辅助函数按哪种资源目录策略发现。
				resourceType,
				// 写入本类 Map。
				target,
				// 为本次显式来源构造元数据。
				{
					// local 标签表示顶层设置给的本地入口，不是用户原路径文字。
					source: "local",
					// 记录项目作用域。
					scope: "project",
					// 顶层入口不是包资源。
					origin: "top-level",
				},
				// 所有相对项目条目按项目配置目录解析。
				projectBaseDir,
			);
			// 再解析用户显式路径，原字符串同路径已有记录时 addResource 保留先前项。
			this.resolveLocalEntries(
				// 用户层的资源数组。
				globalEntries,
				// 同一资源类别。
				resourceType,
				// 写同一类 Map，后面统一排序/去重。
				target,
				// 创建用户显式来源元数据。
				{
					// 同样使用 local 标签，代表由设置条目引入。
					source: "local",
					// 记录用户作用域。
					scope: "user",
					// 顶层来源标记。
					origin: "top-level",
				},
				// 相对用户条目按 agentDir 解析。
				globalBaseDir,
			);
		}

		// 补充用户约定目录、用户 .agents 以及可信项目约定目录/祖先 .agents，应用相应覆盖规则。
		this.addAutoDiscoveredResources(accumulator, globalSettings, projectSettings, globalBaseDir, projectBaseDir);

		// Built-in extensions are enabled unless the user `extensions` setting excludes them, for example
		// with `-builtin:mcp`. A matching `+`, `-`, or `!` entry in the project setting overrides that.
		// 最后添加已知内置扩展名，不从目录扫描它们。
		for (const name of this.builtinExtensions) {
			// 组成 builtin:name 合成路径，不在文件系统 resolve。
			const path = `${BUILTIN_PATH_PREFIX}${name}`;
			// 用 autoload=false 同款逐条增量语义计算项目对这个内置项的明确决定。
			const projectEnabled = applyAutoloadDisabledPatterns(
				// 候选仅当前一个合成路径。
				[path],
				// 只取项目 !/+/-，普通发现条目不参与此内置覆盖。
				getOverridePatterns(projectSettings.extensions ?? []),
				// 项目配置目录作为模式相对基准。
				projectBaseDir,
				// 没有任何项目规则命中时 get 给 undefined，区别于显式 false。
			).get(path);
			// 把内置项写扩展 Map，保持统一去重/排序流程。
			this.addResource(
				// 内置扩展只属于 extensions，不加入其他三类。
				accumulator.extensions,
				// 保存合成路径原串。
				path,
				// 项目明确命中则标 project，否则 user；启用/禁用都算明确决定。
				{ source: "builtin", scope: projectEnabled === undefined ? "user" : "project", origin: "top-level" },
				// ?? 保留项目 false；无项目决定才按用户三组固定优先级计算默认状态。
				projectEnabled ?? isEnabledByOverrides(path, globalSettings.extensions ?? [], globalBaseDir),
			);
		}

		// 对象展开四类转换结果，再附补装失败数组；转换包含优先级排序与真实路径键去重。
		return { ...this.toResolvedPaths(accumulator), installFailures };
	}

	// 仅解析给定来源数组，输入 sources 和 local/temporary，返回四类资源及安装失败；例 -e builtin:mcp 生成启用的合成扩展，未知名字由资源加载器后续报。会补装缺失远端包或刷新临时来源，不自动扫描用户/项目约定目录，也不读取全部 packages。
	async resolveExtensionSources(
		// 来源原文字列表，可同时含 builtin、npm/Git 与本地地址。
		sources: string[],
		// 可选作用域开关，temporary 真时比 local 真优先。
		options?: { local?: boolean; temporary?: boolean },
	): Promise<ResolvedPaths> {
		// 为显式输入创建独立资源 Map。
		const accumulator = this.createAccumulator();
		// 嵌套三元表达式选择 temporary→project→user，后续存储基准和信任检查由该 scope 决定。
		const scope: SourceScope = options?.temporary ? "temporary" : options?.local ? "project" : "user";
		// `-e builtin:<name>` loads a built-in extension; the resource loader reports unknown names.
		// 先取所有 builtin: 前缀项，未验证名字是否已知。
		for (const source of sources.filter((source) => source.startsWith(BUILTIN_PATH_PREFIX))) {
			// 把合成扩展明确标启用，记录顶层来源；相同原串再次出现时保留首项。
			this.addResource(accumulator.extensions, source, { source: "builtin", scope, origin: "top-level" }, true);
		}
		// 剩余来源转换成 resolvePackageSources 需要的对象列表。
		const packageSources = sources
			// 排除已经处理过的内置项，避免把它们当磁盘包地址解析。
			.filter((source) => !source.startsWith(BUILTIN_PATH_PREFIX))
			// 每个字符串包一层 pkg/scope；as PackageSource 不验证输入或改变其实际字符串类型。
			.map((source) => ({ pkg: source as PackageSource, scope }));
		// 对这批来源执行本地/远端解析并记录可忽略的补装失败。
		const installFailures = await this.resolvePackageSources(packageSources, accumulator);
		// 转换 Map 后附诊断；不会因方法名 Extension 就删掉包中技能/提示词/主题。
		return { ...this.toResolvedPaths(accumulator), installFailures };
	}

	// 同步列出用户和项目已配置包，返回 ConfiguredPackage[]；例对象形式 npm:foo 会标 filtered=true，即便未设置任何筛选字段。只读设置/路径，但用户 npm 旧布局探测可能启动只读命令，不扫描所有已安装包、不做项目优先去重。
	listConfiguredPackages(): ConfiguredPackage[] {
		// 用户原始层快照。
		const globalSettings = this.settingsManager.getGlobalSettings();
		// 项目原始层快照，项目可信状态由管理器维护。
		const projectSettings = this.settingsManager.getProjectSettings();
		// 为展示构造独立列表，先用户后项目。
		const configuredPackages: ConfiguredPackage[] = [];

		// 逐项保留用户层配置顺序。
		for (const pkg of globalSettings.packages ?? []) {
			// 字符串直接使用，对象只提取 source。
			const source = typeof pkg === "string" ? pkg : pkg.source;
			// 组装一条描述，不安装缺失包。
			configuredPackages.push({
				// 来源字段简写。
				source,
				// 这条来自 user 设置层。
				scope: "user",
				// 仅按对象形状标记，不验证过滤是否实际排除资源。
				filtered: typeof pkg === "object",
				// 同步找存在的安装路径，可能触发用户 npm 全局根探测。
				installedPath: this.getInstalledPath(source, "user"),
			});
		}

		// 再保留项目配置项，不覆盖列表中同身份用户项。
		for (const pkg of projectSettings.packages ?? []) {
			// 同样从字符串或对象取来源。
			const source = typeof pkg === "string" ? pkg : pkg.source;
			// 追加项目描述。
			configuredPackages.push({
				// 保留项目原 source 字符串。
				source,
				// 记录 project。
				scope: "project",
				// 对象即 filtered，与具体模式是否生效无关。
				filtered: typeof pkg === "object",
				// 找项目范围安装地址，辅助函数会检查信任。
				installedPath: this.getInstalledPath(source, "project"),
			});
		}

		// 返回列表容器，不包含纯自动目录资源。
		return configuredPackages;
	}

	// 安装一个来源，输入 source 与可选 local，成功 Promise<void>，不保存配置；例 npm:foo 在 agentDir/npm 安装，local:true 改项目存储，本地 ./foo 则仅确认存在，不复制其内容。
	// 解析→选范围/检查项目可信→withProgress→按 npm/Git/local 分支执行。直接调用此入口没有统一 PI_OFFLINE 早返，可能联网/运行依赖脚本/写删安装目录；错误拒绝，不承诺所有种类都回滚。
	async install(source: string, options?: { local?: boolean }): Promise<void> {
		// 按前缀/路径规则分类，不联网验证包。
		const parsed = this.parseSource(source);
		// local 仅选项目作用域，不代表 parsed.type 必须 local。
		const scope: SourceScope = options?.local ? "project" : "user";
		// 项目范围不可信就先抛错，开始进度尚未发送。
		this.assertProjectTrustedForScope(scope);
		// 回调真正执行分支，外层等待整个进度包装完成。
		await this.withProgress("install", source, `Installing ${source}...`, async () => {
			// npm 标签收窄到具体 spec 数据。
			if (parsed.type === "npm") {
				// 安装到长期作用域根，第三参数 false 不使用临时目录；会建项目与启动包管理命令。
				await this.installNpm(parsed, scope, false);
				// npm 分支完成就结束 operation。
				return;
			}
			// Git 来源走 clone/对齐引用及依赖处理。
			if (parsed.type === "git") {
				// 等待真实 Git/包管理器流程，不在此额外捕获。
				await this.installGit(parsed, scope);
				// Git 完成不再落入本地分支。
				return;
			}
			// 本地来源不做复制安装。
			if (parsed.type === "local") {
				// 这里的用户命令输入以 this.cwd 解析，即使 local:true 也不是相对 .pi。
				const resolved = this.resolvePath(parsed.path);
				// 只看路径存在，不检查包清单或文件类型。
				if (!existsSync(resolved)) {
					// 不存在使 operation 拒绝并触发 error 进度。
					throw new Error(`Path does not exist: ${resolved}`);
				}
				// 存在就视为本地安装检查成功。
				return;
			}
			// 未知标签兜底报错；正常 ParsedSource 联合已覆盖三种。
			throw new Error(`Unsupported install source: ${source}`);
		});
	}

	// 先安装再修改来源设置，输入来源/local，返回 Promise<void>；例 npm:foo 安装成功后加入 packages。安装失败不写设置，但设置失败不会撤销安装，也不等待 SettingsManager.flush；名称 Persist 不表示磁盘事务已经完成。
	async installAndPersist(source: string, options?: { local?: boolean }): Promise<void> {
		// 安装与其进度完整结算后才能往下走。
		await this.install(source, options);
		// 忽略布尔结果，已有相同配置也可正常完成；排队保存错误按设置实例报告。
		this.addSourceToSettings(source, options);
	}

	// 移除用户/项目受管理来源，输入 source/local，返回 Promise<void>；npm 调卸载，Git 删受管理 checkout 和标记，本地分支保留原文件。例 remove ./plugin 只完成操作/进度，不删 ./plugin，也不在此移除 packages 配置。未可信项目提前拒绝，失败可能已造成部分磁盘修改。
	async remove(source: string, options?: { local?: boolean }): Promise<void> {
		// 先解析来源类型。
		const parsed = this.parseSource(source);
		// local 决定 project/user 卸载范围。
		const scope: SourceScope = options?.local ? "project" : "user";
		// 未可信项目不允许接触项目包存储。
		this.assertProjectTrustedForScope(scope);
		// withProgress 同步发 start，再异步等待具体删除。
		await this.withProgress("remove", source, `Removing ${source}...`, async () => {
			// npm 来源按包名卸载。
			if (parsed.type === "npm") {
				// 等待对应包管理器卸载命令，根缺失可直接完成。
				await this.uninstallNpm(parsed, scope);
				// 结束 npm 分支。
				return;
			}
			// Git 来源删受管理安装目录，不是用户任意克隆目录。
			if (parsed.type === "git") {
				// 等待路径清理与空父目录收缩；内部 rm 是同步副作用。
				await this.removeGit(parsed, scope);
				// 结束 Git 分支。
				return;
			}
			// 本地地址单独处理，避免删用户自己的源码目录。
			if (parsed.type === "local") {
				// 不做文件删除，正常结束 operation。
				return;
			}
			// 未认识标签兜底报错。
			throw new Error(`Unsupported remove source: ${source}`);
		});
	}

	// 先卸载再删对应层所有同身份配置，输入 source/local，返回配置是否变化的 Promise<boolean>；例目录被删而配置原本不存在时仍可返回 false。两阶段无事务或自动回滚，不 await 设置 flush。
	async removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean> {
		// 卸载失败会阻止配置删除，可能仍残留已做磁盘修改。
		await this.remove(source, options);
		// 直接返回同步配置修改布尔，由 async 包成 Promise 结果。
		return this.removeSourceFromSettings(source, options);
	}

	// 更新配置包全部或指定身份，source 可省略，成功 Promise<void>；例如 update npm:foo 会选用户/项目里同包名的配置，不要求其 @版本文字完全相同。
	// 收两层配置并按身份筛选，指定但没有匹配时给建议错误，然后委托批次更新。无来源不意味着扫描全部磁盘安装；固定 npm 版本跳过，Git ref 仍会对齐，本地路径没有更新动作。可联网/改文件/启动命令，不回滚已完成其他任务。
	async update(source?: string): Promise<void> {
		// 独立用户设置快照。
		const globalSettings = this.settingsManager.getGlobalSettings();
		// 独立项目设置快照。
		const projectSettings = this.settingsManager.getProjectSettings();
		// 有非空来源时按命令输入 cwd 计算身份；未传时不限制。
		const identity = source ? this.getPackageIdentity(source) : undefined;
		// 记录是否至少有配置项匹配，哪怕稍后因类型/固定版本而不执行更新。
		let matched = false;
		// 收集来源和实际层，未按项目优先去重。
		const updateSources: ConfiguredUpdateSource[] = [];

		// 先遍历用户配置，保持其顺序。
		for (const pkg of globalSettings.packages ?? []) {
			// 统一字符串/对象形式。
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			// 配置相对路径按 user 基准计算身份，和命令输入身份比较；非匹配跳过。
			if (identity && this.getPackageIdentity(sourceStr, "user") !== identity) continue;
			// 当前项匹配，避免下方误报缺失。
			matched = true;
			// 加入用户更新候选。
			updateSources.push({ source: sourceStr, scope: "user" });
		}
		// 再找项目层，允许同一个身份在两层各更新一次。
		for (const pkg of projectSettings.packages ?? []) {
			// 提取项目来源原文字。
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			// 配置身份使用 project 基准并可能检查信任。
			if (identity && this.getPackageIdentity(sourceStr, "project") !== identity) continue;
			// 项目有匹配也能满足命令要求。
			matched = true;
			// 保留 project 范围进入更新流程。
			updateSources.push({ source: sourceStr, scope: "project" });
		}

		// 只有显式要求来源而两层都无匹配才报错。
		if (source && !matched) {
			// 新建错误中嵌入可能的 npm:/git: 前缀建议。
			throw new Error(
				// 用所有配置来源查第一个可用建议，不联网搜索。
				this.buildNoMatchingPackageMessage(source, [
					// 先展开用户配置到建议输入数组。
					...(globalSettings.packages ?? []),
					// 再展开项目配置，避免两个列表变成嵌套数组。
					...(projectSettings.packages ?? []),
				]),
			);
		}

		// 等待实际更新流程；离线或空列表可在被调用方早返。
		await this.updateConfiguredSources(updateSources);
	}

	// 执行一组长期包更新，输入带 scope 的来源数组，返回 Promise<void>，可联网/安装/清理 checkout 并发送事件；例同作用域多个 npm 包合成一次 install，Git 则最多四个 worker 并行。
	// 先跳离线/空列表，筛固定 npm/本地，再并发查询 npm，按用户/项目分批与 Git 同时更新。各 Git 任务前后读 HEAD，全部正常后重读 npm 版本，再按 npm 候选和 Git 配置顺序报告变化；Promise.all 拒绝不取消已启动任务，不是全批事务或整体并发上限为4。
	private async updateConfiguredSources(sources: ConfiguredUpdateSource[]): Promise<void> {
		// 这里统一挡住 PI_OFFLINE 真值与无任务；不代表其他 install 公共入口同样受挡。
		if (isOfflineModeEnabled() || sources.length === 0) {
			// 直接结束，不派发更新事件。
			return;
		}

		// 保存可移动 npm 版本/范围/标签候选，固定精确版本不加入。
		const npmCandidates: NpmUpdateTarget[] = [];
		// 保存 Git 候选，包含带 ref 的 Git 来源。
		const gitCandidates: GitUpdateTarget[] = [];

		// 逐项分类，不先去重相同 npm/Git 存储身份。
		for (const entry of sources) {
			// 把原来源文字解析成判别联合。
			const parsed = this.parseSource(entry.source);
			// Pinned npm versions are fixed. Pinned git refs are configured checkout targets,
			// so include them to reconcile an existing clone when the configured ref changes.
			// npm 与 Git 的 pinned 含义不同，因此在两个分支分别决策。
			if (parsed.type === "npm") {
				// 只有非固定 npm 才参与更新，例如范围和 latest。
				if (!parsed.pinned) {
					// 浅展开 source/scope 并附 parsed，未在此开始请求。
					npmCandidates.push({ ...entry, parsed });
				}
				// Git ref 是待对齐的目标，不因为 pinned 就跳过实际 update。
			} else if (parsed.type === "git") {
				// 加入 Git 候选，原配置顺序保留。
				gitCandidates.push({ ...entry, parsed });
			}
		}

		// map 创建尚未运行的 async 任务函数，不在构造列表时就无限并发查询。
		const npmCheckTasks = npmCandidates.map((entry) => async () => {
			// 执行时读受管理版本/必要查询 registry，决定是否要安装。
			const check = await this.shouldUpdateNpmSource(entry.parsed, entry.scope);
			// 把判断与填充后的候选打包返回。
			return {
				// 保留原候选并附更新前版本/目标版本，可各自 undefined。
				entry: { ...entry, installedVersion: check.installedVersion, targetVersion: check.targetVersion },
				// 显式记录布尔，下面按它筛选。
				shouldUpdate: check.shouldUpdate,
			};
		});
		// 最多四个查询 worker，返回顺序按任务索引而非完成顺序。
		const npmCheckResults = await this.runWithConcurrency(npmCheckTasks, UPDATE_CHECK_CONCURRENCY);
		// 准备用户 npm 安装批次。
		const userNpmUpdates: NpmUpdateTarget[] = [];
		// 准备项目 npm 安装批次。
		const projectNpmUpdates: NpmUpdateTarget[] = [];
		// 只取 shouldUpdate 为 true 的查询结果。
		const npmUpdates = npmCheckResults.filter((result) => result.shouldUpdate);
		// 按原查询结果顺序分组。
		for (const result of npmUpdates) {
			// 用户范围加入用户批次。
			if (result.entry.scope === "user") {
				// 保留已扩充候选对象。
				userNpmUpdates.push(result.entry);
				// InstalledSourceScope 其余合法值为 project。
			} else {
				// 追加项目批次。
				projectNpmUpdates.push(result.entry);
			}
		}

		// 保存已经启动的 Promise，而不是待调度函数列表。
		const tasks: Promise<void>[] = [];
		// 用户批次非空才启动一次 npm 操作。
		if (userNpmUpdates.length > 0) {
			// 调用 async 函数马上开始执行直到其 await，再把 Promise 入列。
			tasks.push(this.updateNpmBatch(userNpmUpdates, "user"));
		}
		// 项目批次非空时也启动，不等待用户批次完成。
		if (projectNpmUpdates.length > 0) {
			// 项目与用户安装可以同时进行。
			tasks.push(this.updateNpmBatch(projectNpmUpdates, "project"));
		}
		// Git 变化记录会由并行回调 push，完成顺序未必配置顺序。
		const gitUpdates: UpdatedPackage[] = [];
		// 有 Git 候选才生成任务与 worker。
		if (gitCandidates.length > 0) {
			// 为每个 Git 来源创建一个任务函数。
			const gitTasks = gitCandidates.map(
				// async 箭头函数返回下面 withProgress Promise。
				(entry) => async () =>
					// 单包更新正常配 start/complete，失败派 error 后拒绝。
					this.withProgress("update", entry.source, `Updating ${entry.source}...`, async () => {
						// 按该来源 scope 算受管理 checkout，项目路径有信任检查。
						const targetDir = this.getGitInstallPath(entry.parsed, entry.scope);
						// 更新前读取 HEAD，目录缺失/命令失败可 undefined。
						const from = await this.getGitHead(targetDir);
						// 对齐/克隆所需 Git 引用，并处理依赖与标记。
						await this.updateGit(entry.parsed, entry.scope);
						// 更新后再读取 HEAD，不用命令是否退出0代替 commit 比较。
						const to = await this.getGitHead(targetDir);
						// 前后严格不等才报告变化；一侧读取失败也可能使它们不等。
						if (from !== to) {
							// 记录原来源、范围、类型与 from/to，不立即发 result。
							gitUpdates.push({ source: entry.source, type: "git", scope: entry.scope, from, to });
						}
					}),
			);
			// 最多四个 Git worker，其 Promise 正常后 then 返回 void；它与两 npm 批次在同一个 tasks 中并行。
			tasks.push(this.runWithConcurrency(gitTasks, GIT_UPDATE_CONCURRENCY).then(() => {}));
		}

		// 等待所有启动批次正常完成；任一拒绝就跳过后面的全批结果汇总，其他任务仍可能在运行。
		await Promise.all(tasks);

		// 按稳定报告顺序重新构造最终变化列表。
		const updated: UpdatedPackage[] = [];
		// 首先遍历所有决定更新的 npm 项，即使安装最终版本未达目标也要读实际结果。
		for (const { entry } of npmUpdates) {
			// 这里读受管理安装路径，不用旧全局路径回退。
			const installedPath = this.getManagedNpmInstallPath(entry.parsed, entry.scope);
			// 目录不存在或清单读不到都可能给 undefined。
			const to = existsSync(installedPath) ? this.getInstalledNpmVersion(installedPath) : undefined;
			// 只以实际读到版本与旧版本文字是否相等判断变化。
			if (to !== entry.installedVersion) {
				// 加入 npm 变化；to 可以 undefined，不声明已成功到达 targetVersion。
				updated.push({ source: entry.source, type: "npm", scope: entry.scope, from: entry.installedVersion, to });
			}
		}
		// Keep git results in configured order, independent of completion order.
		// Git 变化按候选配置顺序重新取，避免按并行完成顺序打印。
		for (const entry of gitCandidates) {
			// 按原来源文字和 scope 找第一条变化记录，不仅按仓库身份匹配。
			const update = gitUpdates.find((u) => u.source === entry.source && u.scope === entry.scope);
			// 只有找到变化才追加，未改变 HEAD 的任务不显示 result。
			if (update) updated.push(update);
		}

		// Report each changed package, e.g. "npm:foo 1.2.0 -> 1.3.0".
		// 依最终列表同步发送变化结果；这类 result 独立于开始/完成配对。
		for (const pkg of updated) {
			// 局部格式函数输入可能缺失的版本/commit，输出展示字符串，无 I/O。
			const format = (value: string | undefined) =>
				// undefined 显示 (none)，Git 只截前七字符，npm 文字原样；未验证 commit 格式。
				value === undefined ? "(none)" : pkg.type === "git" ? value.slice(0, 7) : value;
			// 项目项加展示后缀，用户项用空串。
			const scope = pkg.scope === "project" ? " (project)" : "";
			// 派发变化事件，回调可抛错；此前安装不会因此撤销。
			this.emitProgress({
				// 结果阶段，不再发一次 start。
				type: "result",
				// 动作仍是 update。
				action: "update",
				// 保留该项原配置来源。
				source: pkg.source,
				// 拼来源、范围和前后值，箭头只是普通提示文字。
				message: `${pkg.source}${scope} ${format(pkg.from)} -> ${format(pkg.to)}`,
			});
		}
	}

	// 读取已有 checkout 的 HEAD，输入目录返回 commit 文字或 undefined 的 Promise；例更新前后分别调用作变化对比。会启动 git rev-parse，目录缺失/命令错误/空输出都返回 undefined，不联网查远端。
	private async getGitHead(targetDir: string): Promise<string | undefined> {
		// 路径不存在就不启动 Git。
		if (!existsSync(targetDir)) return undefined;
		// 捕获命令启动、超时或非零退出等失败。
		try {
			// 捕获 git rev-parse HEAD 的 stdout。
			const head = await this.runCommandCapture("git", ["rev-parse", "HEAD"], {
				// 让 Git 在指定 checkout 执行。
				cwd: targetDir,
				// 给捕获命令十秒计时，它到时发 kill 并等待 close，不是硬性十秒返回。
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			// trim 后非空才返回，未校验40/64位十六进制。
			return head.trim() || undefined;
			// 任何命令处理错误转成缺失结果。
		} catch {
			// 不把失败升级为整个变化汇总异常。
			return undefined;
		}
	}

	// 决定一个长期 npm 来源是否需更新，输入解析来源/scope，返回布尔及可选旧/目标版本；例已装1.0.0、registry1.1.0 得 true。只读受管理目录与 registry 查询，不用旧全局目录作已安装依据；缺失版本直接 true，查询/比较失败也允许继续安装。
	private async shouldUpdateNpmSource(
		// 已排除固定 npm 的正常调用候选，但此辅助函数自身不再检查 pinned。
		source: NpmSource,
		// 长期 user/project 安装作用域。
		scope: InstalledSourceScope,
	): Promise<{ shouldUpdate: boolean; installedVersion?: string; targetVersion?: string }> {
		// 只看本应用管理目录，便于把 legacy 全局安装迁入受管理根。
		const installedPath = this.getManagedNpmInstallPath(source, scope);
		// 路径存在才读 package.json.version，错误/缺失可 undefined。
		const installedVersion = existsSync(installedPath) ? this.getInstalledNpmVersion(installedPath) : undefined;
		// 旧版本假值时跳过 registry 查询，直接视为需要安装。
		if (!installedVersion) {
			// 只给 shouldUpdate:true，不伪造当前/目标版本。
			return { shouldUpdate: true };
		}

		// 查询和 gt 比较同在 try，任一失败都走后备安装判断。
		try {
			// 指定版本/范围/标签则用原 spec；无 version 则按包名查；range 可辅助选数组中满足范围的最大版本。
			const targetVersion = await this.getLatestNpmVersion(source.version ? source.spec : source.name, source.range);
			// gt 只接受更大，不因相等或 registry 更旧而更新；返回观察到的两份文字。
			return { shouldUpdate: gt(targetVersion, installedVersion), installedVersion, targetVersion };
			// 查询失败或 semver 比较非法版本抛错时进入。
		} catch {
			// Preserve existing update behavior when version lookup fails.
			// 保持旧版本信息并让更新尝试继续，目标版本缺失使后续“未变化”警告无法生成。
			return { shouldUpdate: true, installedVersion };
		}
	}

	// 把同一 scope 的 npm 候选合成一次安装，输入候选和范围，Promise<void>；例两用户包用一个 npm install 命令。开始/完成通知按批次一对，之后逐项检查是否仍为旧版本并发送警告；不对每包提供独立事务。
	private async updateNpmBatch(sources: NpmUpdateTarget[], scope: InstalledSourceScope): Promise<void> {
		// 空批次不用构造标签或启动命令。
		if (sources.length === 0) {
			// async 空 return 正常结算。
			return;
		}

		// 单包用原来源作事件键，多包用 user/project npm packages 汇总标签。
		const sourceLabel = sources.length === 1 ? sources[0].source : `${scope} npm packages`;
		// 同样选择单包或批次开始文字。
		const message = sources.length === 1 ? `Updating ${sources[0].source}...` : `Updating ${scope} npm packages...`;
		// 有选择文字沿用 spec，无版本显式用 name@latest，避免 npm 保留已保存范围。
		const specs = sources.map((entry) => (entry.parsed.version ? entry.parsed.spec : `${entry.parsed.name}@latest`));

		// 一份 withProgress 包住本批真实安装。
		await this.withProgress("update", sourceLabel, message, async () => {
			// 等候同 scope 全 spec 的安装命令。
			await this.installNpmBatch(specs, scope);
		});

		// 只在上面的安装/complete 回调都正常后检查旧版本未变化；它只发 progress，不主动报失败。
		this.reportUnchangedNpmUpdates(sources, scope);
	}

	/**
	 * npm can resolve stale registry metadata shortly after a publish and install the old
	 * version without an error. Warn when an announced update did not change the installed version.
	 */
	// 检查已宣布候选的 npm 更新是否仍保留旧版本，输入候选/scope，返回 void；例如目标1.1.0、结果仍1.0.0时发送可能registry缓存陈旧的警告。这是原因提示，不证明故障一定来自缓存；旧/目标缺失或版本变了就不告警。
	private reportUnchangedNpmUpdates(sources: NpmUpdateTarget[], scope: InstalledSourceScope): void {
		// 每个候选独立检查。
		for (const entry of sources) {
			// 没有旧版本或目标版本就无法进行本条警告判断。
			if (!entry.installedVersion || !entry.targetVersion) {
				// 略过此项，不宣称已更新或未更新。
				continue;
			}
			// 获取当前受管理路径，不回退旧全局布局。
			const installedPath = this.getManagedNpmInstallPath(entry.parsed, scope);
			// 重新读实际清单版本。
			const versionAfter = this.getInstalledNpmVersion(installedPath);
			// 结果只要不同于旧版本就跳过，即使没有达到 targetVersion。
			if (versionAfter !== entry.installedVersion) {
				// 继续后续项。
				continue;
			}
			// 仅派中间/警告事件，不抛固定更新失败。
			this.emitProgress({
				// progress 用于这类建议，不当作 result 计变化数。
				type: "progress",
				// 归属 update 动作。
				action: "update",
				// 每条仍指向原包来源，不是批次标签。
				source: entry.source,
				// 提示旧/目标和重试建议，may be 明确是可能原因，代码没有真实检测registry缓存。
				message: `${entry.source} is still ${versionAfter} (registry reports ${entry.targetVersion}); npm registry metadata may be stale, try again in a few minutes`,
			});
		}
	}

	// 在一个长期范围执行多 spec 安装，输入 spec列表/scope，返回 Promise<void>；例用户批次写 agentDir/npm。确保目录/忽略标记/最小package.json，再启动配置的包管理命令；会改文件，依赖安装也可能有脚本或网络副作用。
	private async installNpmBatch(specs: string[], scope: InstalledSourceScope): Promise<void> {
		// false 选择长期安装根，不使用临时安装目录。
		const installRoot = this.getNpmInstallRoot(scope, false);
		// 创建所需目录/最小 npm 项目，并尝试 cloudsync 属性工具等副作用。
		this.ensureNpmProject(installRoot);
		// 按 npm/pnpm/bun 构造参数并等待命令，不在本辅助函数单独捕获失败。
		await this.runNpmCommand(this.getNpmInstallArgs(specs, installRoot));
	}

	// 查询已安装且未固定来源是否有更新，返回 PackageUpdate[] 的 Promise；例未固定 npm:foo 可根据 registry 比较版本产生一条展示信息，不直接安装新版本。
	// 离线直接空；项目优先去重后排本地、临时及 pinned（这里包括任何指定 Git ref），最多四任务并行查询。Git 用 ls-remote，不同于真正 update 可对齐 pinned Git；错误多在各查询辅助中转 false，空列表不能证明所有远端都成功检查。旧用户 npm 地址探测也可能启动只读命令。
	async checkForAvailableUpdates(): Promise<PackageUpdate[]> {
		// 查询入口先检查本模块离线真值。
		if (isOfflineModeEnabled()) {
			// 离线返回空数组，不发网络/查询命令。
			return [];
		}

		// 用户原始层快照。
		const globalSettings = this.settingsManager.getGlobalSettings();
		// 项目原始层快照。
		const projectSettings = this.settingsManager.getProjectSettings();
		// 暂存两层包与 scope。
		const allPackages: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
		// 先项目层确保同身份通常项目优先。
		for (const pkg of projectSettings.packages ?? []) {
			// 保留项目原配置。
			allPackages.push({ pkg, scope: "project" });
		}
		// 再用户层。
		for (const pkg of globalSettings.packages ?? []) {
			// 保留用户范围供查询定位。
			allPackages.push({ pkg, scope: "user" });
		}

		// 按身份去重，autoload:false 项目增量例外可留下同身份用户条目。
		const packageSources = this.dedupePackages(allPackages);
		// 准备后续受限并发的查询函数列表。
		const checks = packageSources
			// 过滤临时范围并让 TS 缩窄结果类型。
			.filter(
				// entry is ... 类型谓词承诺 scope 不再含 temporary，Array<{...}> 是对象数组类型。
				(entry): entry is { pkg: PackageSource; scope: Exclude<SourceScope, "temporary"> } =>
					// 实际运行判断只比较 scope 字符串。
					entry.scope !== "temporary",
			)
			// 每项生成返回 PackageUpdate 或 undefined 的 async 函数，尚未立即开始查询。
			.map((entry) => async (): Promise<PackageUpdate | undefined> => {
				// 提取原来源，不把过滤对象整个传 npm/git。
				const source = typeof entry.pkg === "string" ? entry.pkg : entry.pkg.source;
				// 分类为 npm/Git/本地。
				const parsed = this.parseSource(source);
				// 本地没有可查询版本，npm精确版本和Git任意指定ref都跳过。
				if (parsed.type === "local" || parsed.pinned) {
					// 用 undefined 表示本项无更新结果，稍后统一过滤。
					return undefined;
				}

				// npm 分支需要已安装版本才能比较。
				if (parsed.type === "npm") {
					// 找当前安装路径，用户可回退旧全局布局。
					const installedPath = this.getNpmInstallPath(parsed, entry.scope);
					// 未安装就不报告可用更新，不补装。
					if (!existsSync(installedPath)) {
						// 本项结果缺席。
						return undefined;
					}
					// 读取旧版本并查询目标，内部失败会转 false。
					const hasUpdate = await this.npmHasAvailableUpdate(parsed, installedPath);
					// 没有观察到更大版本就不产生条目。
					if (!hasUpdate) {
						// 同样用 undefined 统一表达无条目。
						return undefined;
					}
					// 有更新时创建展示描述，不包含安装计划或完整目标版本。
					return {
						// 原来源字段简写。
						source,
						// 用解析包名作展示名，不含 npm: 前缀/范围。
						displayName: parsed.name,
						// npm 分类标签。
						type: "npm",
						// 保留原长期 scope。
						scope: entry.scope,
					};
				}

				// 剩下合法分支是未固定 Git 来源，取 checkout 地址。
				const installedPath = this.getGitInstallPath(parsed, entry.scope);
				// 本地 checkout 不存在时不查询远端更新。
				if (!existsSync(installedPath)) {
					// 不把缺失安装作为可更新条目。
					return undefined;
				}
				// 比较本地HEAD和远端引用，可能执行 Git 网络命令。
				const hasUpdate = await this.gitHasAvailableUpdate(installedPath);
				// 查询失败/相同HEAD等都不返回条目。
				if (!hasUpdate) {
					// 留下无结果标记。
					return undefined;
				}
				// 观察到不同 commit 时返回 Git 描述。
				return {
					// 保留来源原串。
					source,
					// 展示解析出的 host/path，不含 ref。
					displayName: `${parsed.host}/${parsed.path}`,
					// Git 分类标签。
					type: "git",
					// 保留原配置层。
					scope: entry.scope,
				};
			});

		// 用四 worker 跑尚未执行的查询函数，结果按输入顺序保存。
		const results = await this.runWithConcurrency(checks, UPDATE_CHECK_CONCURRENCY);
		// 运行时去掉 undefined，类型谓词把返回数组收窄为 PackageUpdate[]。
		return results.filter((result): result is PackageUpdate => result !== undefined);
	}

	// 逐来源解析并把资源写进 accumulator，输入带作用域的包设置、累积Map及可选缺失决策，返回补装失败诊断数组；例项目autoload:false配置可使用已装用户包，只以项目元数据记录明确覆盖项。
	// 本地直接收路径；npm缺失/不满足范围才补装，临时非固定npm还可查新版本并尝试刷新，临时Git已有checkout也会尝试更新。仅实际补装异常转诊断，回调error/回调自身拒绝等仍可终止。安装返回后不统一重新验证所有包有效性，临时刷新失败也不能保证缓存完全未改。
	private async resolvePackageSources(
		// 原设置项可能是字符串或带 autoload/过滤字段的对象。
		sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
		// 传入的四Map会被直接追加，不返回新的累积容器。
		accumulator: ResourceAccumulator,
		// 可选异步回调只在需要补装且不离线时调用。
		onMissing?: (source: string) => Promise<MissingSourceAction>,
	): Promise<PackageInstallFailure[]> {
		// 累计明确捕获的补装失败，不包含所有“缺少资源”的原因。
		const installFailures: PackageInstallFailure[] = [];
		// 依列表顺序串行解析来源，解构 pkg/scope。
		for (const { pkg, scope } of sources) {
			// 统一提取展示来源原串。
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			// 对象设置本身就是筛选配置，字符串时 undefined。
			const filter = typeof pkg === "object" ? pkg : undefined;
			// 项目 autoload:false 如有同身份用户项，就找其实际安装基准。
			const deltaBase = this.findAutoloadDeltaBase(pkg, scope, sources);
			// 需要借用户包时改实际来源，?? 保留非缺省文字。
			const resolvedSource = deltaBase?.source ?? sourceStr;
			// 实际存储范围也可从 project 改 user。
			const resolvedScope = deltaBase?.scope ?? scope;
			// 按实际安装来源分类，原展示来源另外留在 metadata。
			const parsed = this.parseSource(resolvedSource);
			// 元数据保留原sourceStr/scope，因此用户目录的文件仍可标为项目覆盖项。
			const metadata: PathMetadata = { source: sourceStr, scope, origin: "package" };

			// 本地来源不经过远端补装。
			if (parsed.type === "local") {
				// 按实际存储scope选择本地路径基准，project会检查可信。
				const baseDir = this.getBaseDirForScope(resolvedScope);
				// 本地文件/目录解析直接改累积Map及metadata，可应用筛选。
				this.resolveLocalExtensionSource(parsed, accumulator, filter, metadata, baseDir);
				// 本地处理后继续下一来源。
				continue;
			}

			// 捕获当前parsed/来源/scope的局部安装函数；返回true只说明安装调用正常，不保证重新验证结果。
			const installMissing = async (): Promise<boolean> => {
				// 离线直接false，连onMissing也不调，不记录“安装失败”。
				if (isOfflineModeEnabled()) return false;
				// 有交互/策略回调才询问下一步。
				if (onMissing) {
					// 传实际resolvedSource，借用户包时不是项目原source文字。
					const action = await onMissing(resolvedSource);
					// skip直接false且不加入失败诊断。
					if (action === "skip") return false;
					// error在下面安装try外抛，调用方明确要求的错误不会被降级为可忽略补装失败。
					if (action === "error") throw new Error(`Missing source: ${resolvedSource}`);
				}
				// A source that cannot be installed (no network, missing package, failing git prepare step)
				// must not abort startup. Skip its resources, like offline mode does, and report the failure.
				// 只捕获具体安装流程拒绝，回调拒绝不在这个范围。
				try {
					// npm/Git按作用域安装，可能运行命令和依赖脚本。
					await this.installParsedSource(parsed, resolvedScope);
					// 调用正常就返回true，不重新检查所有资源/引用。
					return true;
					// 实际安装错误被收集后跳该来源，允许其他来源继续。
				} catch (error) {
					// 保存一条可供启动界面展示的失败。
					installFailures.push({
						// 记录真正尝试安装来源。
						source: resolvedSource,
						// 记录真正存储范围，可能与原项目覆盖项不同。
						scope: resolvedScope,
						// Error.message或其他抛出值文字，没有独立脱敏。
						message: error instanceof Error ? error.message : String(error),
					});
					// 返回false让调用方跳过本包资源，不回滚所有安装副作用。
					return false;
				}
			};

			// npm分支可能使用旧用户全局安装回退。
			if (parsed.type === "npm") {
				// let允许补装后重新选择路径。
				let installedPath = this.getNpmInstallPath(parsed, resolvedScope);
				// 按存在性与版本范围决定需要补装，两个条件是同一逻辑表达式。
				const needsInstall =
					// 没有目录就短路true；有目录才读版本并判断范围，标签无range时只要求读到版本。
					!existsSync(installedPath) || !(await this.installedNpmMatchesConfiguredVersion(parsed, installedPath));
				// 以下额外分支仅负责已有临时npm缓存的更新检查。
				if (
					// 必须当前安装已经存在且满足配置。
					!needsInstall &&
					// 只有temporary没有常规pi update入口，需要加载时刷新。
					resolvedScope === "temporary" &&
					// 精确固定版本跳过刷新。
					!parsed.pinned &&
					// 查询有更大版本才尝试安装；该辅助函数内部离线时false。
					(await this.npmHasAvailableUpdate(parsed, installedPath))
				) {
					// Temporary (-e) sources have no `pi update` path, so refresh unpinned ones on load like
					// temporary git sources. Like `pi update`, install `name@latest` for unversioned specs because a bare
					// `npm install name` keeps the range already saved in the temporary package.json.
					// 未指定选择文字时显式@latest，指定范围/标签则保留原spec。
					const spec = parsed.version ? parsed.spec : `${parsed.name}@latest`;
					// 临时刷新失败单独忽略，继续使用当前路径，不保证目录内容一字未改。
					try {
						// 浅展开替换spec，scope和temporary=true确定临时npm根。
						await this.installNpm({ ...parsed, spec }, resolvedScope, true);
						// 刷新拒绝不加入installFailures，不终止本包资源收集。
					} catch {
						// Keep the cached install if the refresh fails.
					}
				}
				// 首次判断需要补装时走局部安装决策。
				if (needsInstall) {
					// 离线/skip可给false，error或回调失败可直接抛。
					const installed = await installMissing();
					// 无法/不应安装则继续下一个来源，不扫描旧的不匹配npm包。
					if (!installed) continue;
					// 安装调用返回后重新计算路径，用户路径此时可从legacy转managed。
					installedPath = this.getNpmInstallPath(parsed, resolvedScope);
				}
				// 资源相对基准设为安装路径。
				metadata.baseDir = installedPath;
				// 把同一路径作为包根，供来源界面等使用。
				metadata.packageRoot = installedPath;
				// 按清单/约定和用户过滤收资源，不导入其中扩展。
				this.collectPackageResources(installedPath, accumulator, filter, metadata);
				// npm已处理完成，继续外层来源。
				continue;
			}

			// 剩下Git来源走受管理checkout。
			if (parsed.type === "git") {
				// 计算含host/path或临时ref哈希的地址，可能创建临时根。
				const installedPath = this.getGitInstallPath(parsed, resolvedScope);
				// 没有本地路径才补装，不在这里验证已有目录的repo/ref。
				if (!existsSync(installedPath)) {
					// 复用同一个缺失包回调/错误诊断规则。
					const installed = await installMissing();
					// 补装未进行或失败就跳过该包。
					if (!installed) continue;
					// 已有临时Git且非离线才加载时刷新，长期Git不会在resolve自动更新。
				} else if (resolvedScope === "temporary" && !isOfflineModeEnabled()) {
					// 刷新内部捕获失败并继续缓存路径，可能已有部分变动。
					await this.refreshTemporaryGitSource(parsed, resolvedSource, installedPath);
				}
				// 保存checkout为资源基准。
				metadata.baseDir = installedPath;
				// 保存包根给元数据。
				metadata.packageRoot = installedPath;
				// 读取清单/约定目录并加入资源Map，不执行扩展代码。
				this.collectPackageResources(installedPath, accumulator, filter, metadata);
			}
		}
		// 仅返回本次收集的补装失败诊断；累积资源已通过传参Map变更。
		return installFailures;
	}

	// 为项目autoload:false项寻找同身份用户包作为真实解析基准，输入当前pkg/scope与完整来源，返回用户source/scope或undefined；例项目禁用用户npm:foo的某个工具不需另装项目副本。只比较配置，不安装或验证用户包一定已存在。
	private findAutoloadDeltaBase(
		// 当前设置项可为字符串或对象。
		pkg: PackageSource,
		// 当前原作用域。
		scope: SourceScope,
		// 同一次解析的完整来源列表，查其中第一个同身份user项。
		sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
	): { source: string; scope: SourceScope } | undefined {
		// 只有project+对象+autoload严格false三条件全满足才查用户基准。
		if (scope !== "project" || typeof pkg !== "object" || pkg.autoload !== false) return undefined;
		// 计算项目项身份，本地路径以项目设置基准解析。
		const identity = this.getPackageIdentity(pkg.source, scope);
		// find按列表顺序返回首个命中项或undefined。
		const userEntry = sources.find(
			// 回调的多行&&确保范围和身份都匹配。
			(entry) =>
				// 用户项才可作增量基准。
				entry.scope === "user" &&
				// 其来源提取后按user基准计算身份；忽略npm版本/Git ref。
				this.getPackageIdentity(this.getPackageSourceString(entry.pkg), "user") === identity,
		);
		// 有用户项就返回它的原source且scope=user，后面元数据仍保留项目项原scope。
		return userEntry ? { source: this.getPackageSourceString(userEntry.pkg), scope: "user" } : undefined;
	}

	// 解析本地显式来源并填充资源Map，输入LocalSource/累积容器/可缺过滤/原元数据/基准目录，返回void；例单个任意现存文件直接作为启用扩展，目录则先按包资源清单或约定发现。只读磁盘与修改内存，不复制目录或执行代码。
	private resolveLocalExtensionSource(
		// 原本地地址文字，尚未按base解析。
		source: LocalSource,
		// 直接写入的累积Map。
		accumulator: ResourceAccumulator,
		// 配置对象的过滤，可undefined。
		filter: PackageFilter | undefined,
		// 调用方创建的元数据会在本函数追加字段，不新建完全独立副本。
		metadata: PathMetadata,
		// 按实际作用域选出的相对路径基准。
		baseDir: string,
	): void {
		// 展开输入并按base变绝对路径，非法file URL等错误在下方try外。
		const resolved = this.resolvePathFromBase(source.path, baseDir);
		// 不存在就不生成资源或安装失败诊断。
		if (!existsSync(resolved)) {
			// 安静结束当前来源。
			return;
		}

		// stat和资源收集异常在这里统一吞掉，可能已向Map加入部分项。
		try {
			// 跟随链接读文件类型，不限制真实目标仍在包根。
			const stats = statSync(resolved);
			// 普通文件直接视为扩展入口，不要求.ts/.js后缀。
			if (stats.isFile()) {
				// 文件入口的base是所在目录，未填packageRoot。
				metadata.baseDir = dirname(resolved);
				// 直接加入启用扩展，单文件路径不经过filter里的四类模式。
				this.addResource(accumulator.extensions, resolved, metadata, true);
				// 文件分支结束，不再做目录资源扫描。
				return;
			}
			// 普通目录才按包资源布局处理。
			if (stats.isDirectory()) {
				// 目录自身成为相对基准。
				metadata.baseDir = resolved;
				// 同时记录包根。
				metadata.packageRoot = resolved;
				// 按filter、manifest或约定目录收四类资源，布尔代表采用资源布局，不保证有非空结果。
				const resources = this.collectPackageResources(resolved, accumulator, filter, metadata);
				// 未发现包资源布局时把目录本身留给扩展加载器处理。
				if (!resources) {
					// 启用该目录扩展入口，不在这里保证它有index。
					this.addResource(accumulator.extensions, resolved, metadata, true);
				}
			}
			// 读取、收集等失败安静结束，但此前修改不会回滚。
		} catch {
			// 不向调用方提供该本地来源失败详情。
			return;
		}
	}

	// 按已解析类型执行缺失远端安装，输入parsed/scope，返回Promise<void>；例temporary npm调用临时安装根，Git调用checkout安装。本地分支无操作，本函数不发额外进度、不统一检查离线；调用方先做策略决定。
	private async installParsedSource(parsed: ParsedSource, scope: SourceScope): Promise<void> {
		// 判别收窄npm数据。
		if (parsed.type === "npm") {
			// temporary布尔由scope直接生成，决定npm根。
			await this.installNpm(parsed, scope, scope === "temporary");
			// npm完成后结束。
			return;
		}
		// Git来源委托Git安装。
		if (parsed.type === "git") {
			// 可能clone/对齐引用/安装依赖。
			await this.installGit(parsed, scope);
			// Git完成后结束，本地输入则落到函数末尾正常完成。
			return;
		}
	}

	// 从包配置字符串或对象中取source，输入PackageSource返回string，无I/O；例{source:"npm:foo",skills:[]}取其source，不验证运行时外部JSON字段。
	private getPackageSourceString(pkg: PackageSource): string {
		// typeof是联合两分支的分流，不把整个对象String化。
		return typeof pkg === "string" ? pkg : pkg.source;
	}

	// 为命令输入生成匹配身份，输入source返回字符串，无安装；例npm:foo@1与npm:foo@2同为npm:foo，本地相对地址按this.cwd。路径处理不是realpath，链接别名可能尚未等同。
	private getSourceMatchKeyForInput(source: string): string {
		// 先分类npm/Git/local。
		const parsed = this.parseSource(source);
		// npm按包名忽略版本范围/标签。
		if (parsed.type === "npm") {
			// 加npm:避免与其他类型同名混淆。
			return `npm:${parsed.name}`;
		}
		// Git按解析host/path忽略协议和ref，仍依解析器结果而非真正远端仓库身份认证。
		if (parsed.type === "git") {
			// 构造Git匹配键。
			return `git:${parsed.host}/${parsed.path}`;
		}
		// 本地以实例cwd规范成绝对，再平台比较键；不先跟随符号链接。
		return `local:${getPathComparisonKey(this.resolvePath(parsed.path))}`;
	}

	// 为设置中的来源生成匹配身份，输入source/scope返回字符串；npm/Git同上，本地则相对agentDir/cwd/.pi/临时cwd。例全局../plugin与命令./plugin可在不同基准解析到同路径后匹配。项目范围可因未可信而抛错。
	private getSourceMatchKeyForSettings(source: string, scope: SourceScope): string {
		// 先分类来源。
		const parsed = this.parseSource(source);
		// npm分支只按包名。
		if (parsed.type === "npm") {
			// 忽略已配版本选择文字。
			return `npm:${parsed.name}`;
		}
		// Git按规范host/path。
		if (parsed.type === "git") {
			// 不把ref放进身份键。
			return `git:${parsed.host}/${parsed.path}`;
		}
		// 剩下本地分支取作用域基准，project检查信任。
		const baseDir = this.getBaseDirForScope(scope);
		// 按该基准解析后取平台比较键，不访问真实路径。
		return `local:${getPathComparisonKey(this.resolvePathFromBase(parsed.path, baseDir))}`;
	}

	// 构造没有匹配包的提示，输入用户source和配置列表返回string，无I/O；例如裸foo可建议npm:foo。只给现有配置中的首个兼容建议，不自动纠正或重试操作。
	private buildNoMatchingPackageMessage(source: string, configuredPackages: PackageSource[]): string {
		// 从有限已配置来源中找建议。
		const suggestion = this.findSuggestedConfiguredSource(source, configuredPackages);
		// undefined/空建议就用基础文字。
		if (!suggestion) {
			// 保留用户source在错误信息中，不做转义或脱敏。
			return `No matching package found for ${source}`;
		}
		// 有建议时拼问句，不自动将source改掉。
		return `No matching package found for ${source}. Did you mean ${suggestion}?`;
	}

	// 找用户输入是否像缺了npm:/git:前缀的已配置来源，输入source/列表返回首条建议或undefined，无联网/安装；例foo对应npm:foo，Git host/path可带原ref。不是模糊编辑距离搜索，也不对本地路径建议。
	private findSuggestedConfiguredSource(source: string, configuredPackages: PackageSource[]): string | undefined {
		// 仅建议比较前trim用户输入，不改实际操作source。
		const trimmedSource = source.trim();
		// Set保留首次加入顺序并去掉完全相同建议文字。
		const suggestions = new Set<string>();

		// 按配置顺序扫描。
		for (const pkg of configuredPackages) {
			// 取原source字符串，建议返回它而不是重建短名。
			const sourceStr = this.getPackageSourceString(pkg);
			// 分类后分别比较已支持短名形式。
			const parsed = this.parseSource(sourceStr);
			// npm只认包名或完整spec（不含npm:）。
			if (parsed.type === "npm") {
				// 两种严格相等之一命中才建议，没有大小写折叠。
				if (trimmedSource === parsed.name || trimmedSource === parsed.spec) {
					// 加入原配置来源，例如npm:foo@^1。
					suggestions.add(sourceStr);
				}
				// npm分支处理完，不当Git再试。
				continue;
			}
			// Git分支提供host/path简写建议。
			if (parsed.type === "git") {
				// 无协议、无git:的主机路径文字。
				const shorthand = `${parsed.host}/${parsed.path}`;
				// 有ref时另给host/path@ref候选。
				const shorthandWithRef = parsed.ref ? `${shorthand}@${parsed.ref}` : undefined;
				// 只在用户输入严格等于这两种形式之一时加入建议。
				if (trimmedSource === shorthand || (shorthandWithRef && trimmedSource === shorthandWithRef)) {
					// 保留原SSH/HTTPS/git:配置拼法。
					suggestions.add(sourceStr);
				}
			}
		}

		// 取得Set首项值；空集合迭代结束时value为undefined，不对建议排序。
		return suggestions.values().next().value;
	}

	// 比较一条已配置来源与命令输入是否同身份，输入existing/inputSource/scope返回boolean；例更新ref仍匹配原Git项。本地两侧采用不同基准，可能触发项目可信检查，不检查远端或磁盘存在。
	private packageSourcesMatch(existing: PackageSource, inputSource: string, scope: SourceScope): boolean {
		// 配置侧先提取source，再按设置scope解释相对路径。
		const left = this.getSourceMatchKeyForSettings(this.getPackageSourceString(existing), scope);
		// 命令侧始终按实例cwd解释本地相对路径。
		const right = this.getSourceMatchKeyForInput(inputSource);
		// 严格比较生成键，未做模糊匹配。
		return left === right;
	}

	// 把命令来源变为适合相应设置层保存的文字，输入source/scope返回string；npm/Git原样，本地先按cwd绝对化再相对设置目录，完全同目录用点。例cwd/repo、agentDir/repo/.pi/agent下本地/repo/plugin可保存相对路径；不创建文件。
	private normalizePackageSourceForSettings(source: string, scope: SourceScope): string {
		// 分类来决定是否应进行路径变换。
		const parsed = this.parseSource(source);
		// npm/Git不重新编码或去掉原空白。
		if (parsed.type !== "local") {
			// 直接返回原source。
			return source;
		}
		// 本地才取作用域基准，项目检查信任。
		const baseDir = this.getBaseDirForScope(scope);
		// 命令输入以this.cwd解析，不是先按设置目录解析。
		const resolved = this.resolvePath(parsed.path);
		// relative生成从保存位置到目标的路径，跨Windows盘符可能仍是绝对形式。
		const rel = relative(baseDir, resolved);
		// 空相对结果改成点；本函数不保证添加./前缀，后续SettingsManager可另规范。
		return rel || ".";
	}

	// 把source分成npm/Git/local判别联合，输入字符串返回解析数据，无I/O；npm:foo@^1拆包名/范围，明确本地路径优先，否则试Git解析，失败仍保留为本地。分类不验证包名/仓库/文件存在或ref可访问。
	private parseSource(source: string): ParsedSource {
		// npm:在此是大小写敏感且不先trim的前缀检查。
		if (source.startsWith("npm:")) {
			// 去掉前缀后trim spec，不改原source变量。
			const spec = source.slice("npm:".length).trim();
			// 用本模块正则拆出name/version，未使用npm官方包名验证器。
			const { name, version } = this.parseNpmSpec(spec);
			// 返回npm标签与解析结果。
			return {
				// 运行时判别标签。
				type: "npm",
				// 保留去前缀trim后的完整spec。
				spec,
				// 包名字段简写。
				name,
				// 可缺版本选择文字，可能是范围或标签。
				version,
				// semver可接受的选择文字转规范range，标签等给undefined。
				range: getNpmVersionRange(version),
				// 只有semver.valid接受为固定版本才pinned=true。
				pinned: isExactNpmVersion(version),
			};
		}

		// 已知本地候选先返回，避免把./packages/a这类含斜杠地址误作Git。
		if (isLocalPath(source)) {
			// 路径字段仍保存原source，具体trim/~解析后面执行。
			return { type: "local", path: source };
		}

		// Try parsing as git URL
		// 尝试Git字符串解析，只识别支持形式，不运行git命令。
		const gitParsed = parseGitUrl(source);
		// 解析结果非null时采用。
		if (gitParsed) {
			// 直接返回GitSource，Git pinned含义是有ref而不是不可变commit。
			return gitParsed;
		}

		// 解析失败也作为本地候选，不在分类阶段抛“未知URL”错误。
		return { type: "local", path: source };
	}

	// 检查已装npm是否有版本并满足配置range，输入解析来源/安装路径，返回Promise<boolean>；例^1要求安装版本符合范围，latest无range时只需有真值version。方法虽async，正文只有同步读与比较，不查询registry/标签实际指向。
	private async installedNpmMatchesConfiguredVersion(source: NpmSource, installedPath: string): Promise<boolean> {
		// 从目标package.json读取version，缺失/读取解析错误可undefined。
		const installedVersion = this.getInstalledNpmVersion(installedPath);
		// 假值version视为不能匹配，未在此修复文件。
		if (!installedVersion) {
			// 返回false让调用方决定补装。
			return false;
		}
		// 有range用semver.satisfies，否则返回true；声明version为string不是对外部JSON的完整运行校验。
		return source.range ? satisfies(installedVersion, source.range) : true;
	}

	// 比较npm当前安装与registry候选，输入来源/安装路径，返回Promise<boolean>；例1.0.0→1.1.0为true。离线、缺失旧version或查询/比较失败都false，不安装包；“无更新”也可能是无法完成查询。
	private async npmHasAvailableUpdate(source: NpmSource, installedPath: string): Promise<boolean> {
		// 每次查询前实时检查离线。
		if (isOfflineModeEnabled()) {
			// 离线不运行npm view。
			return false;
		}

		// 同步读目标清单版本，不自动查旧全局根。
		const installedVersion = this.getInstalledNpmVersion(installedPath);
		// 没有真值旧版本就无法比较。
		if (!installedVersion) {
			// 缺版本不当成可更新条目，与shouldUpdateNpmSource的缺失就安装策略不同。
			return false;
		}

		// 把异步查询与semver比较放同一try。
		try {
			// 选择原spec或包名，range用于registry返回数组时选版本。
			const targetVersion = await this.getLatestNpmVersion(source.version ? source.spec : source.name, source.range);
			// 严格大于才true，不把不同但更旧的版本当更新。
			return gt(targetVersion, installedVersion);
			// 命令/JSON/semver异常都捕获。
		} catch {
			// 转false不给调用方查询错误详情。
			return false;
		}
	}

	// 同步读取安装目录package.json.version，输入安装路径，声明返回string或undefined；例版本缺失/文件坏JSON时无值。不验证version实际为合法字符串/semver，as只约束开发期，因此外部异常字段可能越过声明。
	private getInstalledNpmVersion(installedPath: string): string | undefined {
		// 拼清单地址，不在别处查包元数据。
		const packageJsonPath = join(installedPath, "package.json");
		// 缺失直接无值。
		if (!existsSync(packageJsonPath)) return undefined;
		// 捕获读文件/解析/属性访问失败。
		try {
			// UTF-8读整份清单。
			const content = readFileSync(packageJsonPath, "utf-8");
			// 去BOM解析后断言有可选version；断言不执行schema校验。
			const pkg = JSON.parse(stripBom(content)) as { version?: string };
			// 直接取字段，无trim/typeof/semver.valid检查。
			return pkg.version;
			// 坏JSON或null访问等抛错转无值。
		} catch {
			// 让上层按“版本缺失”策略处理。
			return undefined;
		}
	}

	// 用配置的npm命令执行view并解析候选版本，输入packageSpec与可选range，返回Promise<string>；例registry数组[1.0.0,1.2.0]配^1得到最大满足版本。会启动子进程/可能联网；空stdout、非接受JSON形状或数组无候选会抛错，字符串结果直接返回不另验semver。
	private async getLatestNpmVersion(packageSpec: string, range?: string): Promise<string> {
		// 取得有效设置层中的命令及包装参数，不一定是系统npm。
		const npmCommand = this.getNpmCommand();
		// 捕获stdout并等close，超时也通过该辅助函数处理。
		const stdout = await this.runCommandCapture(
			// 使用配置的可执行命令名。
			npmCommand.command,
			// 包装器参数先于view/spec/version/--json，数组展开保留每个argv项边界。
			[...npmCommand.args, "view", packageSpec, "version", "--json"],
			// 查询cwd固定为本实例项目，捕获命令给十秒计时。
			{ cwd: this.cwd, timeoutMs: NETWORK_TIMEOUT_MS },
		);
		// 再trim正文，捕获辅助函数本身也会trim。
		const raw = stdout.trim();
		// 空输出以明确错误拒绝，不返回空版本。
		if (!raw) throw new Error("Empty response from npm view");
		// 外部命令正文是信任边界，as unknown要求后续检查JSON形状。
		const parsed = JSON.parse(raw) as unknown;
		// 单字符串形状接受，不验证它满足range或为合法semver。
		if (typeof parsed === "string") {
			// 原字符串直接返回，后续gt可能因坏版本抛错。
			return parsed;
		}
		// 数组结果才走多版本选择，不接受任意对象。
		if (Array.isArray(parsed)) {
			// 保留非空字符串，类型谓词使TS得到string[]；不在这里过滤所有无效semver。
			const versions = parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
			// 有range用maxSatisfying，否则复制数组按semver倒序取首项；非法版本在比较时可能抛错。
			const latest = range ? maxSatisfying(versions, range) : [...versions].sort(rcompare)[0];
			// 有非空选定版本就返回。
			if (latest) return latest;
		}
		// 无可用候选或其他JSON形状都报意外响应。
		throw new Error("Unexpected response from npm view");
	}

	// 比较Git本地HEAD与远端参考，输入checkout目录返回Promise<boolean>；例远端默认分支commit不同则true。会启动本地Git及ls-remote网络查询，但不fetch/reset工作树；离线或任何查询失败false，仅比较是否不同不证明远端领先或可快进。
	private async gitHasAvailableUpdate(installedPath: string): Promise<boolean> {
		// 离线短路检查。
		if (isOfflineModeEnabled()) {
			// 不开始本地/远端Git命令。
			return false;
		}

		// 把本地和远端两步查询包在共同错误边界。
		try {
			// 读取本地HEAD文字。
			const localHead = await this.runCommandCapture("git", ["rev-parse", "HEAD"], {
				// 命令在checkout运行。
				cwd: installedPath,
				// 本地查询同样用十秒捕获超时参数。
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			// 先尝试origin上游分支，再根据实现回退origin HEAD；可能联网。
			const remoteHead = await this.getRemoteGitHead(installedPath);
			// trim后只比较文字不同，不做祖先关系或dirty工作树检查。
			return localHead.trim() !== remoteHead.trim();
			// 任一查询失败或解析错误捕获。
		} catch {
			// 返回false掩蔽具体错误，不等于远端已确认无更新。
			return false;
		}
	}

	// 确定origin上游或默认HEAD的远端40位commit，输入checkout目录返回Promise<string>；例当前跟踪origin/main则先ls-remote该ref。会联网，不写本地引用；已得到上游但其ls-remote命令拒绝时直接向外抛，不自动回退。
	private async getRemoteGitHead(installedPath: string): Promise<string> {
		// 本地读取当前分支上游，无法识别origin分支时可undefined。
		const upstreamRef = await this.getGitUpstreamRef(installedPath);
		// 有上游完整refs/heads名才先查它。
		if (upstreamRef) {
			// 通过禁交互提示的远端命令查询origin上游。
			const remoteHead = await this.runGitRemoteCommand(installedPath, ["ls-remote", "origin", upstreamRef]);
			// m允许从任一行首找40位小写十六进制+空白，不验证该行余下ref或支持64位SHA-256。
			const match = remoteHead.match(/^([0-9a-f]{40})\s+/m);
			// 可选访问捕获组，只有真值才采用。
			if (match?.[1]) {
				// 返回匹配到的commit文字。
				return match[1];
			}
		}

		// 没有上游或上游成功响应却无匹配时查询origin HEAD。
		const remoteHead = await this.runGitRemoteCommand(installedPath, ["ls-remote", "origin", "HEAD"]);
		// m让^/$按行边界匹配；40位小写hex后以\s+接HEAD，\s可含换行，因此这里不额外保证哈希和HEAD位于同一行。
		const match = remoteHead.match(/^([0-9a-f]{40})\s+HEAD$/m);
		// 捕获不到commit就不能继续比较。
		if (!match?.[1]) {
			// 以明确错误拒绝，上层gitHasAvailableUpdate可转false。
			throw new Error("Failed to determine remote HEAD");
		}
		// 返回第一个匹配的HEAD哈希。
		return match[1];
	}

	// 为现有未指定ref的checkout计算本地更新引用与精确fetch参数，输入目录，返回ref/head/fetchArgs；例origin/main产生@{upstream}及只更新该分支远端跟踪引用的refspec。会运行Git，本地上游识别失败时还会尝试remote set-head -a，可能联网并改origin/HEAD。
	// 优先当前origin上游；任一正常路径步骤失败则回退origin/HEAD。返回的head是在fetch之前读到的值，实际installGit/updateGit调用方主要使用ref/fetchArgs，ensureGitRef fetch后会重读目标commit，不能把此head当最终更新结果。
	private async getLocalGitUpdateTarget(
		// 已有checkout目录。
		installedPath: string,
	): Promise<{ ref: string; head: string; fetchArgs: string[] }> {
		// 第一条路径的上游读取、origin限制和HEAD读取都在同一try。
		try {
			// 取上游短名，例如origin/main；没有上游常会非零退出。
			const upstream = await this.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
				// 在当前checkout运行。
				cwd: installedPath,
				// 捕获查询设十秒。
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			// 去掉Git输出首尾空白。
			const trimmedUpstream = upstream.trim();
			// 只支持origin/前缀，其他remote上游走下面回退。
			if (!trimmedUpstream.startsWith("origin/")) {
				// 这个错误会被本函数catch吸收，触发origin HEAD备用路径。
				throw new Error(`Unsupported upstream remote: ${trimmedUpstream}`);
			}
			// 剥origin/前缀，得到可含斜杠的branch文字。
			const branch = trimmedUpstream.slice("origin/".length);
			// 空分支不可用。
			if (!branch) {
				// 同样抛到当前catch触发回退。
				throw new Error("Missing upstream branch name");
			}
			// 读取当前本地上游引用的commit，尚未fetch最新远端。
			const head = await this.runCommandCapture("git", ["rev-parse", "@{upstream}"], {
				// 仍在当前checkout执行。
				cwd: installedPath,
				// 查询十秒超时参数。
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			// 返回后续对齐需要的引用、查询结果与参数列表。
			return {
				// 稍后ensureGitRef用该表达式再解析commit。
				ref: "@{upstream}",
				// 保留捕获返回的head，未另外trim或校验。
				head,
				// 仅提供参数，当前尚未执行这个fetch。
				fetchArgs: [
					// fetch子命令。
					"fetch",
					// --prune清理已失效的远端跟踪引用，实际范围仍取决于Git参数语义。
					"--prune",
					// --no-tags避免自动抓标签带来的无关输出/内容。
					"--no-tags",
					// 使用名为origin的远端。
					"origin",
					// +refspec允许强制更新这个远端跟踪分支，branch直接插入单个argv，未启动shell拼串。
					`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
				],
			};
			// 上游不支持/命令失败等都退origin HEAD路径，原错误不保留给调用方。
		} catch {
			// 尝试联网更新origin/HEAD符号引用；失败用空catch忽略，这条runCommand没有传总超时/禁提示环境。
			await this.runCommand("git", ["remote", "set-head", "origin", "-a"], { cwd: installedPath }).catch(() => {});
			// 然后读取本地origin/HEAD，失败仍直接拒绝，没有再外层兜底。
			const head = await this.runCommandCapture("git", ["rev-parse", "origin/HEAD"], {
				// cwd为同一checkout。
				cwd: installedPath,
				// 捕获本地查询给十秒计时。
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			// 试取origin/HEAD符号引用对应的完整名字。
			const originHeadRef = await this.runCommandCapture("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
				// 在该仓库中执行。
				cwd: installedPath,
				// 给捕获步骤十秒。
				timeoutMs: NETWORK_TIMEOUT_MS,
				// 这一查询单独失败就用空串，使后面走直接HEAD refspec。
			}).catch(() => "");
			// trim再仅去开头refs/remotes/origin/；没有额外验证结果本来一定含该前缀。
			const branch = originHeadRef.trim().replace(/^refs\/remotes\/origin\//, "");
			// 有非空branch文字就构造精确分支fetch。
			if (branch) {
				// 返回默认远端HEAD更新计划。
				return {
					// ensureGitRef稍后以origin/HEAD解析目标。
					ref: "origin/HEAD",
					// 保留先前本地读到的head，不声明已经是远端最新。
					head,
					// 准备对应分支的fetch argv。
					fetchArgs: [
						// fetch命令。
						"fetch",
						// 启用prune。
						"--prune",
						// 关闭自动标签抓取。
						"--no-tags",
						// 远端origin。
						"origin",
						// 显式分支映射到同名origin跟踪分支。
						`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
					],
				};
			}
			// 无法取符号分支时使用远端HEAD直接映射。
			return {
				// 本地目标引用仍是origin/HEAD。
				ref: "origin/HEAD",
				// 附带已读head字段。
				head,
				// 把origin的HEAD强制抓到refs/remotes/origin/HEAD；不额外抓所有分支/标签。
				fetchArgs: ["fetch", "--prune", "--no-tags", "origin", "+HEAD:refs/remotes/origin/HEAD"],
			};
		}
	}

	// 读取当前origin上游分支的完整远端ref，输入checkout目录返回Promise<string|undefined>；例origin/feature/x转refs/heads/feature/x。只本地Git查询，不fetch；无上游/非origin/命令错误均无结果，不更新配置。
	private async getGitUpstreamRef(installedPath: string): Promise<string | undefined> {
		// 把查询和文字处理共同捕获。
		try {
			// 取上游短名，而非当前分支名。
			const upstream = await this.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
				// 当前仓库工作目录。
				cwd: installedPath,
				// 十秒捕获查询参数。
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			// 去首尾空白。
			const trimmed = upstream.trim();
			// 不是origin前缀则不能按本模块远端策略查询。
			if (!trimmed.startsWith("origin/")) {
				// 无结果让远端HEAD辅助函数回退。
				return undefined;
			}
			// 保留前缀后全部分支路径。
			const branch = trimmed.slice("origin/".length);
			// 非空才拼refs/heads，否则undefined。
			return branch ? `refs/heads/${branch}` : undefined;
			// 没有上游或Git错误等都安静降级。
		} catch {
			// 不把本地上游缺失当整个更新查询崩溃。
			return undefined;
		}
	}

	// 运行只用于远端查询的Git捕获命令，输入checkout/args返回stdout的Promise；例ls-remote。合并环境并设GIT_TERMINAL_PROMPT=0及十秒捕获超时，不保证所有SSH/凭证助手都绝不会交互，也不提供完整网络隔离。
	private runGitRemoteCommand(installedPath: string, args: string[]): Promise<string> {
		// 复用通用捕获逻辑，不在这里再解析stdout。
		return this.runCommandCapture("git", args, {
			// 用checkout的origin配置。
			cwd: installedPath,
			// 查询总计时参数传给子进程捕获。
			timeoutMs: NETWORK_TIMEOUT_MS,
			// 这是附加环境字典，spawnCaptureCommand后面与基础环境浅合并。
			env: {
				// 请求Git不要通过终端询问凭证，不等于主动删除现有认证环境。
				GIT_TERMINAL_PROMPT: "0",
			},
		});
	}

	// 受限并行执行延迟任务，输入返回Promise<T>的函数数组与limit，返回按输入顺序排列的T[]；例如五项limit=2由两个worker依次取未领任务。泛型T让调用方保留各结果类型，无I/O但任务自身可有副作用。
	// 每个worker在await前递增共享索引，单线程同步部分避免同一索引重复领取。任何任务拒绝使Promise.all拒绝，不取消其他worker/底层任务，它们仍可能继续取任务；调用处传正整数，不在此完整验证limit为有限整数。
	private async runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
		// 空数组时不用创建worker。
		if (tasks.length === 0) {
			// 直接得到正常空结果。
			return [];
		}

		// 预分配与任务数相同的结果槽，T[]是开发期声明，初始数组仍有空槽。
		const results: T[] = new Array(tasks.length);
		// 共享下一个尚未领取索引。
		let nextIndex = 0;
		// 按limit和任务数限制worker数量，正常输入至少1；未主动拒绝NaN/小数等异常数字。
		const workerCount = Math.max(1, Math.min(limit, tasks.length));

		// 每个worker不收参数/返回业务结果，只把任务结果填入共享results。
		const worker = async () => {
			// 持续领取直到索引越界或某任务抛错。
			while (true) {
				// 保存当前领取位置，避免await后再读到已变化索引。
				const index = nextIndex;
				// 在await前同步递增，其他worker随后会领不同位置。
				nextIndex += 1;
				// 索引达到任务数就没有工作。
				if (index >= tasks.length) {
					// 结束这个worker，不终止其他worker。
					return;
				}
				// 执行并等待这一任务，再按原索引写结果；拒绝会结束当前worker并传播。
				results[index] = await tasks[index]();
			}
		};

		// 创建若干worker立即启动并等它们；Array.from的回调返回各worker Promise，不创建真正并行JS线程。
		await Promise.all(Array.from({ length: workerCount }, () => worker()));
		// 正常都完成后返回按索引排列结果，不按完成顺序排序。
		return results;
	}

	/**
	 * Get a unique identity for a package, ignoring version/ref.
	 * Used to detect when the same package is in both global and project settings.
	 * For git packages, uses normalized host/path to ensure SSH and HTTPS URLs
	 * for the same repository are treated as identical.
	 */
	// 生成忽略版本/ref的包身份，输入source和可选scope，返回字符串；例Git SSH/HTTPS支持形式都可能得到git:host/path。没有scope本地按命令cwd，有scope按设置层基准，未realpath，不声称不同文字一定对应同一真实远端/链接。
	private getPackageIdentity(source: string, scope?: SourceScope): string {
		// 先按来源规则解析。
		const parsed = this.parseSource(source);
		// npm身份只保留解析包名。
		if (parsed.type === "npm") {
			// 忽略版本范围和标签。
			return `npm:${parsed.name}`;
		}
		// Git身份使用解析后host/path，不包含协议、账号或ref。
		if (parsed.type === "git") {
			// Use host/path for identity to normalize SSH and HTTPS
			// 字符串构造身份，不与远端确认仓库ID。
			return `git:${parsed.host}/${parsed.path}`;
		}
		// 显式scope表示来源来自某设置/存储层。
		if (scope) {
			// 本地设置基准选择可能触发项目可信检查。
			const baseDir = this.getBaseDirForScope(scope);
			// 按该基准解析成比较路径键，Windows按公共规则转小写。
			return `local:${getPathComparisonKey(this.resolvePathFromBase(parsed.path, baseDir))}`;
		}
		// 没有scope则用this.cwd解析用户命令输入，仍不跟随链接。
		return `local:${getPathComparisonKey(this.resolvePath(parsed.path))}`;
	}

	/**
	 * Dedupe packages: if same package identity appears in both global and project,
	 * keep only the project one (project wins). A project entry with autoload=false
	 * is a delta over the global entry, so both are kept (delta first).
	 */
	// 按身份归并配置项，输入带scope列表返回新数组，不安装或改设置；正常调用先项目后用户，项目覆盖同身份用户，autoload:false项目项则保留同身份用户作基准。例project delta禁一项时两条都留。相同scope的重复选择也由下面逐分支决定，不等于每个身份永远只剩一条。
	private dedupePackages(
		// 原项及scope一起处理，避免版本/ref剥离后丢过滤对象。
		packages: Array<{ pkg: PackageSource; scope: SourceScope }>,
	): Array<{ pkg: PackageSource; scope: SourceScope }> {
		// 结果容器，成员仍引用原entry对象。
		const result: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
		// Map保存每个身份在结果的主位置索引，额外保留的用户delta基准不另改这个索引。
		const seen = new Map<string, number>();
		// 按输入顺序处理，同级重复/项目后到分支以此为基础。
		for (const entry of packages) {
			// 身份计算忽略版本/ref，本地按各自scope解析。
			const identity = this.getPackageIdentity(this.getPackageSourceString(entry.pkg), entry.scope);
			// 未见身份返回undefined，0也会被正确当已有索引。
			const index = seen.get(identity);
			// 第一次遇到该身份时保留它。
			if (index === undefined) {
				// 索引设为push之前的结果长度。
				seen.set(identity, result.length);
				// 原entry对象入结果，不深拷贝。
				result.push(entry);
				// 继续下一配置，不走重复处理。
				continue;
			}
			// 取此前该身份的主记录。
			const existing = result[index];
			// 已有项目、后到用户时通常忽略用户项。
			if (existing?.scope === "project" && entry.scope === "user") {
				// 但项目对象autoload=false时追加用户基准；Map仍指原项目主记录。
				if (typeof existing.pkg === "object" && existing.pkg.autoload === false) result.push(entry);
				// 后到项目项可替换先前主记录，包含同scope项目重复时后项替换。
			} else if (entry.scope === "project") {
				// 保持原结果位置但换entry，不重排其他包。
				result[index] = entry;
			}
		}
		// 返回归并数组，未保证来源均存在或已安装。
		return result;
	}

	// 用有限正则拆npm spec，输入不含npm:的文字，返回name与可选version；例@scope/pkg@^1拆为包名和范围。没有做官方npm包名校验；无法匹配时把整串当name，不在此报错。
	private parseNpmSpec(spec: string): { name: string; version?: string } {
		// 捕获组1为允许可选@前缀的非@文字/可选路径，组2为最后版本文字；锚点无m要求整个输入，不能凭此式保证npm语义全部合法。
		const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
		// 正则没匹配时采取宽松回退。
		if (!match) {
			// 不强行丢掉或修复非法文字，留给后续npm处理。
			return { name: spec };
		}
		// 捕获组类型可能undefined，用原spec兜底。
		const name = match[1] ?? spec;
		// 可选@后文字，无该组时undefined。
		const version = match[2];
		// 对象属性简写返回，不把version解释为合法semver。
		return { name, version };
	}

	// 阻止未可信项目使用项目包存储，输入scope返回void或抛Error；例如project且settings.isProjectTrusted=false拒绝，user/temporary不受这个检查。只读取已有状态，不发授权提示、不开沙箱，也不保护所有可能来源文件访问。
	private assertProjectTrustedForScope(scope: SourceScope): void {
		// 只有project且当前内存信任为false才拒绝。
		if (scope === "project" && !this.settingsManager.isProjectTrusted()) {
			// 同步抛错使调用方中断，未在此修改信任状态。
			throw new Error("Project is not trusted; refusing to access project package storage");
		}
	}

	// 拆有效npmCommand设置为可执行命令和前置argv，返回对象；例如["mise","exec","--","npm"]拆command="mise"/args其余，无I/O。缺失/空数组用系统npm，首项为空时报错，不检查命令是否存在或受支持。
	private getNpmCommand(): { command: string; args: string[] } {
		// SettingsManager从有效合并层取argv副本，可信项目配置可能覆盖用户值。
		const configuredCommand = this.settingsManager.getNpmCommand();
		// 未配或空列表采用默认。
		if (!configuredCommand || configuredCommand.length === 0) {
			// 新建空args数组，不执行npm。
			return { command: "npm", args: [] };
		}
		// 数组解构取首命令和剩余参数的新数组。
		const [command, ...args] = configuredCommand;
		// 首项空串等假值拒绝，但没有trim纯空白文字。
		if (!command) {
			// 报无效设置错误，调用方决定如何展示。
			throw new Error("Invalid npmCommand: first array entry must be a non-empty command");
		}
		// 返回命令与前置参数，不拼成shell脚本字符串。
		return { command, args };
	}

	// 推断npmCommand实际包装的包管理器名，返回字符串，无I/O；例如npm exec -- pnpm选pnpm，corepack pnpm也可识别。先看最后--后项，再直接npm/pnpm/bun，再搜索参数中唯一已知名；多个候选抛歧义错误，不验证外部包装器实际执行什么。
	private getPackageManagerName(): string {
		// 读取命令及包装参数。
		const npmCommand = this.getNpmCommand();
		// 局部纯文字函数取basename并去末尾.cmd/.exe（不分扩展大小写）；不把整体命令名统一转小写。
		const normalizeCommandName = (command: string): string => basename(command).replace(/\.(cmd|exe)$/i, "");
		// 已知包管理器Set仅这三个名字，yarn不在这个识别集合中。
		const supportedPackageManagers = new Set(["npm", "pnpm", "bun"]);
		// 先规范直接可执行命令名，平台basename语义影响带反斜杠输入。
		const directCommand = normalizeCommandName(npmCommand.command);
		// 取最后一个--的位置，不是第一个。
		const separatorIndex = npmCommand.args.lastIndexOf("--");
		// 有分隔符时按其后一项优先，无需先验证它是已知包管理器。
		if (separatorIndex >= 0) {
			// 只取紧跟最后--的一个argv。
			const wrappedCommand = npmCommand.args[separatorIndex + 1];
			// 存在就规范后返回，无该项则回退外层命令名；不继续搜索前面的npm/pnpm候选。
			return wrappedCommand ? normalizeCommandName(wrappedCommand) : directCommand;
		}
		// 没有--且直接命令是已知名就优先采用，不理参数中其他已知名。
		if (supportedPackageManagers.has(directCommand)) return directCommand;

		// 未知外层命令才收集参数里的候选。
		const wrappedPackageManagers = [
			// Set去重，同一包管理器出现多次不算多个不同候选。
			...new Set(
				// 每项按文件名/后缀规范，再只保留npm/pnpm/bun，未分析参数实际语法。
				npmCommand.args
					.map(normalizeCommandName)
					.filter((command) => supportedPackageManagers.has(command)),
			),
		];
		// 两个以上不同已知名无法唯一推断。
		if (wrappedPackageManagers.length > 1) {
			// 抛出歧义而不是任意挑一个，未执行外部命令。
			throw new Error(`Ambiguous npmCommand package managers: ${wrappedPackageManagers.join(", ")}`);
		}
		// 唯一候选优先，否则退外层命令名。
		return wrappedPackageManagers[0] ?? directCommand;
	}

	// 异步执行配置包管理器命令，输入本次args与可选cwd，返回Promise<void>；例前置mise参数后拼install参数。会真实启动进程，非零/启动错误拒绝，没有本入口的离线/超时/依赖脚本限制。
	private async runNpmCommand(args: string[], options?: { cwd?: string }): Promise<void> {
		// 本次执行实时读命令设置，不缓存旧argv。
		const npmCommand = this.getNpmCommand();
		// 包装参数在前，本次参数在后，等待通用runCommand。
		await this.runCommand(npmCommand.command, [...npmCommand.args, ...args], options);
	}

	// 为Git包依赖安装选argv，返回新字符串数组，无I/O；例npm省dev并legacy-peer-deps，bun省dev/peer。参数是发送给外部工具的策略，不在本函数保证任意版本工具都遵从，也未统一禁安装脚本。
	private getGitDependencyInstallArgs(): string[] {
		// 按推断包管理器名switch，不按操作系统。
		switch (this.getPackageManagerName()) {
			// bun分支。
			case "bun":
				// 省开发依赖与peer安装，保留普通生产依赖。
				return ["install", "--omit=dev", "--omit=peer"];
			// pnpm分支。
			case "pnpm":
				// 返回pnpm专用列表。
				return [
					// 安装子命令。
					"install",
					// 生产依赖模式。
					"--prod",
					// 请求不自动安装peer。
					"--config.auto-install-peers=false",
					// 不以严格peer冲突中断。
					"--config.strict-peer-dependencies=false",
					// 关闭严格依赖构建策略对应检查，保持此源码既定选项。
					"--config.strict-dep-builds=false",
				];
			// npm分支。
			case "npm":
				// 省dev、沿用legacy peer处理并关闭audit/fund提示，没有--ignore-scripts。
				return ["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"];
			// 未知包管理器名采用最通用默认。
			default:
				// 只给install，不能声称此分支同样禁peer或dev。
				return ["install"];
		}
	}

	// 同步运行配置包管理器查询，输入本次argv返回trim文字；例root -g探测旧全局根。会阻塞当前线程并启动命令，没有这里的超时或cwd选项；失败向外抛。
	private runNpmCommandSync(args: string[]): string {
		// 取得当前有效命令配置。
		const npmCommand = this.getNpmCommand();
		// 前置包装参数与本次参数合并，结果由通用同步捕获函数决定。
		return this.runCommandSync(npmCommand.command, [...npmCommand.args, ...args]);
	}

	// 为受管理npm spec安装构造argv，输入spec数组和根返回参数列表；例npm install specs --prefix真实根 --legacy-peer-deps。会在已存在根上realpath，错误可抛；不在此真正安装，bun/pnpm分别选自己的根/peer选项。
	private getNpmInstallArgs(specs: string[], root: string): string[] {
		// npm writes broken nested package-lock.json paths when --prefix goes through a symlink.
		// 已存在路径先realpath避免符号链接--prefix造成锁文件路径问题；缺失时先原根，不在这里创建。
		const installRoot = existsSync(root) ? realpathSync(root) : root;
		// 根据配置包装器猜实际包管理器名称。
		const packageManagerName = this.getPackageManagerName();
		// Extension packages run inside pi and resolve pi APIs through loader aliases/virtual modules.
		// Disable peer dependency resolution for managed installs (npm's --legacy-peer-deps, and
		// equivalent bun/pnpm settings) so package managers do not install or solve host-provided
		// @earendil-works/pi-* peers. Stale auto-installed pi peers can otherwise block updates.
		// bun用自己的--cwd语法。
		if (packageManagerName === "bun") {
			// 展开所有spec，指定真实安装根并请求省peer。
			return ["install", ...specs, "--cwd", installRoot, "--omit=peer"];
		}
		// pnpm用prefix及对应peer/构建配置参数。
		if (packageManagerName === "pnpm") {
			// pnpm安装参数保持独立数组，不拼shell文字。
			return [
				// 安装子命令。
				"install",
				// 展开本批所有spec，每项保留一个argv。
				...specs,
				// pnpm使用--prefix指定安装项目。
				"--prefix",
				// 上面算出的真实根。
				installRoot,
				// 请求不自动安装peer。
				"--config.auto-install-peers=false",
				// 关闭严格peer依赖检查。
				"--config.strict-peer-dependencies=false",
				// 关闭严格依赖构建检查，沿用本实现现有策略。
				"--config.strict-dep-builds=false",
			];
		}
		// npm audit fix would run without --legacy-peer-deps and install pi peers, so skip audit advice.
		// npm及其他未单独识别工具走这套install/prefix/legacy参数，禁audit/fund提示但不禁生命周期脚本。
		return ["install", ...specs, "--prefix", installRoot, "--legacy-peer-deps", "--no-audit", "--no-fund"];
	}

	// 安装一个已解析npm来源，输入来源/scope/是否临时，返回Promise<void>；例如temporary=true写临时npm项目。先建根及最小项目，再启动配置命令；不自行检查离线，不保存packages设置或验证装后版本，失败可留下目录/清单。
	private async installNpm(source: NpmSource, scope: SourceScope, temporary: boolean): Promise<void> {
		// temporary参数先于scope决定根，调用方须协调两者。
		const installRoot = this.getNpmInstallRoot(scope, temporary);
		// 确保最小项目并设置忽略属性，可能启动xattr/setfattr。
		this.ensureNpmProject(installRoot);
		// 单个spec包装成数组传参数构造器，再等待真实安装。
		await this.runNpmCommand(this.getNpmInstallArgs([source.spec], installRoot));
	}

	// 卸载一个受管理npm包，输入来源/scope，返回Promise<void>；例user删除agentDir/npm中的包名，不会专门对legacy全局安装执行全局卸载。根不存在无操作，否则按工具选择argv，命令失败拒绝，未回滚部分改动/保存配置。
	private async uninstallNpm(source: NpmSource, scope: SourceScope): Promise<void> {
		// false表示长期根；本公共卸载路径正常只传user/project，scope=temporary也不自动选临时根。
		const root = this.getNpmInstallRoot(scope, false);
		// 受管理根缺失就不用启动命令。
		if (!existsSync(root)) {
			// 正常返回，不因包没装而报错。
			return;
		}
		// npm writes broken nested package-lock.json paths when --prefix goes through a symlink.
		// 根已存在先跟随链接为真实路径，失败向上传播。
		const installRoot = realpathSync(root);
		// 猜实际包管理器名，以便选择卸载参数。
		const packageManagerName = this.getPackageManagerName();
		// bun使用自己的--cwd规则。
		if (packageManagerName === "bun") {
			// 按包名卸载而非原版本spec，等待命令结果。
			await this.runNpmCommand(["uninstall", source.name, "--cwd", installRoot]);
			// bun分支结束，不再附npm参数。
			return;
		}
		// 其他工具先采用uninstall/name/--prefix/root基础参数。
		const args = ["uninstall", source.name, "--prefix", installRoot];
		// pnpm不加下面npm专用兼容参数。
		if (packageManagerName !== "pnpm") {
			// 非pnpm追加legacy peer与audit/fund参数，包含未知工具名回退。
			args.push("--legacy-peer-deps", "--no-audit", "--no-fund");
		}
		// 实际执行配置命令；没有这里的超时/离线保护。
		await this.runNpmCommand(args);
	}

	// 安装或对齐Git来源，输入已解析仓库/scope，返回Promise<void>；已有checkout按指定ref或上游目标fetch并对齐，不存在则clone→可选checkout→有package.json就安装依赖，具体参数按包管理器决定。例git:host/a/b@v2已有目录时仍会fetch指定ref。
	// 会联网、写受管理目录、运行Git/依赖脚本；新clone过程失败尝试删除目标及空父目录，已有checkout的失败不回滚。准备目录/标记清理在新clone的try外；清理自身抛错也可能遮住原错误，不承诺全程事务。
	private async installGit(source: GitSource, scope: SourceScope): Promise<void> {
		// 取长期host/path或临时含ref哈希路径，项目范围会检查信任。
		const targetDir = this.getGitInstallPath(source, scope);
		// 已有任意可识别路径就走对齐分支，不先证明它是正确有效仓库。
		if (existsSync(targetDir)) {
			// 指定ref时直接抓该目标，可是移动分支而非不可变commit。
			if (source.ref) {
				// fetch origin ref后用FETCH_HEAD作目标，ensureGitRef再解析为commit。
				await this.ensureGitRef(targetDir, ["fetch", "origin", source.ref], "FETCH_HEAD");
				// 已有指定ref分支完成，不走新clone。
				return;
			}
			// 无ref时选当前origin上游或默认HEAD，选择过程可能联网更新origin/HEAD。
			const target = await this.getLocalGitUpdateTarget(targetDir);
			// 用精确fetch参数对齐目标，未使用target.head作为最终commit。
			await this.ensureGitRef(targetDir, target.fetchArgs, target.ref);
			// 已有无ref路径处理完返回。
			return;
		}
		// 长期Git有共同存储根，临时Git返回undefined。
		const gitRoot = this.getGitInstallRoot(scope);
		// 只有长期根才放统一.gitignore。
		if (gitRoot) {
			// 确保根目录及全忽略.gitignore，已有忽略文件不覆盖。
			this.ensureGitIgnore(gitRoot);
		}
		// 先递归创建checkout父目录，不在clone失败try里面。
		mkdirSync(dirname(targetDir), { recursive: true });
		// 删除可能遗留的同名更新未完成标记，不删除checkout以外其他项。
		rmSync(this.getGitUpdateMarkerPath(targetDir), { force: true });

		// 只把clone、可选checkout、依赖安装置于这次清理错误边界。
		try {
			// 启动真实git clone，未设置浅克隆、禁交互或总超时。
			await this.runCommand("git", ["clone", source.repo, targetDir]);
			// 新clone后有指定ref才切换。
			if (source.ref) {
				// 在新目录checkout原ref文字，和已有目录fetch/FETCH_HEAD路径不同。
				await this.runCommand("git", ["checkout", source.ref], { cwd: targetDir });
			}
			// 只看仓库根package.json，不递归各子包。
			const packageJsonPath = join(targetDir, "package.json");
			// 有清单就尝试依赖安装，不先检查dependencies是否非空。
			if (existsSync(packageJsonPath)) {
				// 配置的npm/pnpm/bun安装参数不统一禁脚本，Git包代码/依赖可能因此运行。
				await this.runNpmCommand(this.getGitDependencyInstallArgs(), { cwd: targetDir });
			}
			// 新clone阶段任一步失败时尝试回收，原抛出值暂留error。
		} catch (error) {
			// 递归删除本次目标；删除失败会直接抛并遮住原错误。
			rmSync(targetDir, { recursive: true, force: true });
			// 再尝试删除长期根下空父目录，临时无installRoot则不做；此步也可能抛错。
			this.pruneEmptyGitParents(targetDir, gitRoot);
			// 清理正常完成后重抛原失败，不把安装失败当成功。
			throw error;
		}
	}

	// 更新一个Git受管理checkout，输入来源/scope，返回Promise<void>；缺失则委托installGit，已有则对齐配置ref或上游。例@main也会重新抓移动分支，不是因为pinned就跳过。会fetch/reset/清理和安装依赖，不保存配置或回滚工作树。
	private async updateGit(source: GitSource, scope: SourceScope): Promise<void> {
		// 计算对应checkout地址。
		const targetDir = this.getGitInstallPath(source, scope);
		// 没目标就用完整安装流程。
		if (!existsSync(targetDir)) {
			// 等待clone/checkout/依赖操作。
			await this.installGit(source, scope);
			// 首次安装后结束，不再立刻重复fetch。
			return;
		}

		// 有ref优先按它fetch。
		if (source.ref) {
			// fetch origin ref，再对齐FETCH_HEAD的commit，可能覆盖已有本地改动。
			await this.ensureGitRef(targetDir, ["fetch", "origin", source.ref], "FETCH_HEAD");
			// 指定ref处理完成。
			return;
		}

		// 无ref取origin上游/默认HEAD计划。
		const target = await this.getLocalGitUpdateTarget(targetDir);
		// 抓取并对齐目标，不直接使用计划中提前读到的head。
		await this.ensureGitRef(targetDir, target.fetchArgs, target.ref);
	}

	// 粗略检查Git包的直接生产依赖是否有路径缺失，输入checkout返回boolean，只读磁盘；例如dependencies.foo而node_modules/foo不存在为true。忽略dev/peer、版本与完整性、提升安装/包解析等语义，坏清单或读取错误false，不代表所有依赖已可用。
	private hasMissingGitDependencies(targetDir: string): boolean {
		// 检查根package.json。
		const packageJsonPath = join(targetDir, "package.json");
		// 没清单就当无待修依赖。
		if (!existsSync(packageJsonPath)) return false;

		// 读取、解析、遍历和路径存在性异常都转false。
		try {
			// 去BOM后解析，仅把dependencies字段视unknown，不校验整份清单。
			const manifest = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as { dependencies?: unknown };
			// 外部JSON边界过滤不能作为依赖字典的明显形状。
			if (
				// 缺失/null等假值不继续。
				!manifest.dependencies ||
				// 必须是对象而非字符串/数字。
				typeof manifest.dependencies !== "object" ||
				// 数组不作为依赖名字典接受。
				Array.isArray(manifest.dependencies)
			) {
				// 无可遍历依赖就false。
				return false;
			}

			// 把node_modules变为绝对词法地址。
			const nodeModulesDir = resolve(targetDir, "node_modules");
			// 只要任一自有依赖名对应路径缺失就true，依赖值本身未检查。
			return Object.keys(manifest.dependencies).some((name) => {
				// 依赖名按node_modules基准resolve，可能含上级或绝对文字。
				const dependencyPath = resolve(nodeModulesDir, name);
				// 超出node_modules词法子路径的名字不检查；未realpath跟随链接，因此不是完整文件系统隔离。
				if (!dependencyPath.startsWith(`${nodeModulesDir}${sep}`)) return false;
				// 直接!existsSync，未验证包入口、版本或链接实际安装方式。
				return !existsSync(dependencyPath);
			});
			// 坏JSON/null属性读取或其他异常安静转false。
		} catch {
			// 错误未变为需修复提示。
			return false;
		}
	}

	// 已有Git HEAD一致时只修明显缺失的直接依赖，输入checkout返回Promise<void>；例node_modules/foo被删后重装。不先git clean，不遍历包版本一致性；真实依赖安装可联网/执行脚本并拒绝。
	private async repairMissingGitDependencies(targetDir: string): Promise<void> {
		// 没有检测到缺失就无操作，false也可能来自读取失败。
		if (!this.hasMissingGitDependencies(targetDir)) return;
		// 用同一Git包依赖参数运行配置工具，不按npm ci锁定安装。
		await this.runNpmCommand(this.getGitDependencyInstallArgs(), { cwd: targetDir });
	}

	// 计算checkout旁的更新未完成标记路径，输入目录返回字符串，无I/O；例如git/host/a/repo对应同父目录的.repo.pi-update-incomplete，清工作树时它不放在仓库内部。
	private getGitUpdateMarkerPath(targetDir: string): string {
		// 取父目录和末段名字拼隐藏标记，不实际创建文件。
		return join(dirname(targetDir), `.${basename(targetDir)}.pi-update-incomplete`);
	}

	// 清checkout未跟踪内容并重装依赖，输入目标目录/标记路径，返回Promise<void>；例更新commit后git clean -fdx删除未跟踪和忽略内容，有package.json再跑依赖安装。
	// clean失败记录警告但仍可继续依赖安装，保留marker让以后重试；clean成功且依赖步骤正常后删除标记。不是只清node_modules，也不保证原用户改动保留；警告回调或依赖安装/删除标记失败仍可拒绝。
	private async cleanAndInstallGitDependencies(targetDir: string, markerPath: string): Promise<void> {
		// Clean untracked files (extensions should be pristine). On Windows, files loaded by
		// another process (e.g. a native module of this extension in another pi session) cannot
		// be deleted, so git clean fails. Still install dependencies for the new commit, but keep
		// the marker so the next update retries the clean.
		// 先假设clean成功，catch内改false。
		let cleaned = true;
		// 只捕获git clean本次失败。
		try {
			// -f强制、-d包含未跟踪目录、-x包括忽略文件，是真实删除操作，不是预览。
			await this.runCommand("git", ["clean", "-fdx"], { cwd: targetDir });
			// 失败后继续的策略不限Windows，任何clean错误都进入。
		} catch (error) {
			// 标记未完整清理，使最后不删marker。
			cleaned = false;
			// 转成可展示的错误文字，没有脱敏。
			const reason = error instanceof Error ? error.message : String(error);
			// 发送progress警告；此回调若抛错会阻止后面依赖安装。
			this.emitProgress({
				// 普通中间/警告阶段。
				type: "progress",
				// 属于update动作。
				action: "update",
				// source使用目标目录，不一定原git:字符串。
				source: targetDir,
				// may be只给文件占用的可能原因，代码没检测究竟哪个进程占用。
				message: `Could not remove all untracked files in ${targetDir} (${reason}). Files may be in use by another pi session; close it and run the update again.`,
			});
		}

		// 清理后重新看根清单。
		const packageJsonPath = join(targetDir, "package.json");
		// 清单存在才运行依赖安装。
		if (existsSync(packageJsonPath)) {
			// 等待包管理器，失败不会到下面移除标记。
			await this.runNpmCommand(this.getGitDependencyInstallArgs(), { cwd: targetDir });
		}
		// 只有clean确实成功且走到这里才可以结束标记生命周期。
		if (cleaned) {
			// force忽略标记不存在，其他错误仍可能抛，未回滚已重装依赖。
			rmSync(markerPath, { force: true });
		}
	}

	// 抓取并把现有checkout对齐目标commit，输入目录/fetch参数/ref表达式，返回Promise<void>；例FETCH_HEAD^{commit}与当前HEAD不同就先写未完成标记，再git reset --hard并clean/重装。会覆盖受管理工作树，非事务。
	// HEAD相同也可能因marker重试完整clean/安装，没marker则只修明显缺直接依赖。fetch本身仍先执行；本地查询给十秒捕获计时，而fetch/reset/clean等runCommand未在此设总超时或禁交互。失败可能发生在reset之后。
	private async ensureGitRef(targetDir: string, fetchArgs: string[], ref: string): Promise<void> {
		// Fetch only the ref we will reset to, avoiding unrelated branch/tag noise.
		// 真实fetch首先发生，参数由调用方给，不在本函数重写或限制所有网络行为。
		await this.runCommand("git", fetchArgs, { cwd: targetDir });

		// 抓取完成后读取当前checkout的HEAD。
		const localHead = await this.runCommandCapture("git", ["rev-parse", "HEAD"], {
			// 当前仓库目录。
			cwd: targetDir,
			// 本地捕获查询十秒计时。
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		// Git的^{commit}语法把tag/ref剥解到commit，插值仍是一个argv而非shell脚本。
		const commitRef = `${ref}^{commit}`;
		// 读取抓取之后的目标commit，避免用fetch前缓存head。
		const targetHead = await this.runCommandCapture("git", ["rev-parse", commitRef], {
			// 在同一个checkout解释ref。
			cwd: targetDir,
			// 目标查询也有十秒计时。
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		// 确定工作树旁的marker路径。
		const markerPath = this.getGitUpdateMarkerPath(targetDir);
		// trim后HEAD相同不需要reset，但仍检查上次未完成/依赖缺失。
		if (localHead.trim() === targetHead.trim()) {
			// marker存在表示此前对齐后的清理或安装尚未正常走完。
			if (existsSync(markerPath)) {
				// 重试clean与依赖安装，成功清理才删marker。
				await this.cleanAndInstallGitDependencies(targetDir, markerPath);
				// 没有marker时避免完整删除未跟踪文件。
			} else {
				// 仅检测直接dependencies缺失并必要时安装，不全面验证依赖。
				await this.repairMissingGitDependencies(targetDir);
			}
			// 相同HEAD路径处理结束。
			return;
		}

		// 不同HEAD先写空标记，后续失败可留下它提示重试，写失败则尚未reset。
		writeFileSync(markerPath, "", "utf-8");
		// 强制reset到目标commit，覆盖本地已跟踪修改，未提供回滚。
		await this.runCommand("git", ["reset", "--hard", commitRef], { cwd: targetDir });
		// 随后clean未跟踪内容并装依赖，清理异常可保留marker。
		await this.cleanAndInstallGitDependencies(targetDir, markerPath);
	}

	// 加载时刷新临时Git缓存，输入解析来源/展示原串/安装路径，返回Promise<void>；例@main每次可fetch，@abc1234若当前HEAD已匹配该hex前缀则直接复用。离线无操作，任何刷新异常静默保留使用该路径，但不保证此前reset/依赖变动被撤回。
	private async refreshTemporaryGitSource(source: GitSource, sourceStr: string, installedPath: string): Promise<void> {
		// 临时刷新入口再次检查离线。
		if (isOfflineModeEnabled()) {
			// 无网络/本地HEAD命令地结束。
			return;
		}
		// 包含本地HEAD查询和withProgress更新的整体错误边界。
		try {
			// A ref can name a moving branch, so refresh refs too. Skip the network call only when the
			// ref is a commit hash that is already checked out.
			// 7–64个hex（不分大小写）才按疑似commit优化，正则无m不会忽略多余尾换行；也可能是刚好hex拼成的分支名，未向Git证明它必为commit。
			if (source.ref && /^[0-9a-f]{7,64}$/i.test(source.ref)) {
				// 查询缓存checkout当前HEAD。
				const head = await this.runCommandCapture("git", ["rev-parse", "HEAD"], {
					// 使用传入installedPath，而后面的updateGit会按source重新计算对应临时路径。
					cwd: installedPath,
					// 捕获查询十秒计时。
					timeoutMs: NETWORK_TIMEOUT_MS,
				});
				// 双方转小写，HEAD前缀相同即可命中优化，不要求引用文字完整等于HEAD。
				if (head.trim().toLowerCase().startsWith(source.ref.toLowerCase())) {
					// 已有匹配commit前缀就不fetch。
					return;
				}
			}
			// 其余临时来源发送pull进度并等待更新；实际内部可能fetch/reset/重装而非git pull子命令。
			await this.withProgress("pull", sourceStr, `Refreshing ${sourceStr}...`, async () => {
				// 明确temporary范围，ref仍计入临时地址。
				await this.updateGit(source, "temporary");
			});
			// 本地查询/刷新/进度回调错误均在这里吞掉，不报installFailures。
		} catch {
			// Keep cached temporary checkout if refresh fails.
		}
	}

	// 删除受管理Git checkout及其marker，再向上删空父目录，输入来源/scope返回Promise<void>；例user来源删agentDir/git/host/path。正文实际用同步rm，错误拒绝；不保存配置、不删用户原始local目录或远端仓库。
	private async removeGit(source: GitSource, scope: SourceScope): Promise<void> {
		// 按来源和范围计算受管理目标，词法归属检查/项目信任由辅助函数负责。
		const targetDir = this.getGitInstallPath(source, scope);
		// 递归强制删除目标目录，force只忽略不存在等指定情况，不吞所有I/O错误。
		rmSync(targetDir, { recursive: true, force: true });
		// 再删除工作树旁标记，失败时目录可能已删。
		rmSync(this.getGitUpdateMarkerPath(targetDir), { force: true });
		// 长期根存在时收缩空父目录，临时根undefined则跳过此收缩。
		this.pruneEmptyGitParents(targetDir, this.getGitInstallRoot(scope));
	}

	// 从checkout父目录逐层删除空目录，到安装根之前停止，输入targetDir及可缺installRoot返回void；例删除host/user/repo后可清空user/host层。只对rm本次错误break，readdir等错误会传播；用字符串前缀而非realpath/分隔边界，本辅助函数依赖调用方传入受管理目标。
	private pruneEmptyGitParents(targetDir: string, installRoot: string | undefined): void {
		// temporary没有共同长期根，此处直接不做。
		if (!installRoot) return;
		// 安装根按进程cwd绝对化，不跟随链接。
		const resolvedRoot = resolve(installRoot);
		// 从目标父目录开始，不再次删checkout本身。
		let current = dirname(targetDir);
		// 只在文字前缀仍匹配且非根自身时循环；startsWith本身并非严格目录边界校验。
		while (current.startsWith(resolvedRoot) && current !== resolvedRoot) {
			// 这一层已不存在时继续向上，不调用readdir。
			if (!existsSync(current)) {
				// 推进至父层。
				current = dirname(current);
				// 跳本轮剩余步骤。
				continue;
			}
			// 同步列当前目录，失败不在下面rm的try中。
			const entries = readdirSync(current);
			// 只删空目录，含任何条目（包括隐藏项）则停。
			if (entries.length > 0) {
				// 不越过非空目录继续清更高层。
				break;
			}
			// 这里只围住删除操作。
			try {
				// 刚才确认空后递归rm，但检查到删除之间没有锁，不保证并发新文件不受影响。
				rmSync(current, { recursive: true, force: true });
				// 删除失败时不再上行。
			} catch {
				// 保留当前及祖先层。
				break;
			}
			// 正常删除后继续向父目录。
			current = dirname(current);
		}
	}

	// 确保受管理npm根具备最小项目，输入根返回void；例首次安装创建{name:"pi-extensions",private:true}及.gitignore。同步建目录/写文件并尝试云忽略属性，macOS/Linux会启动属性命令；不覆盖已有package.json，不校验现有项目内容，也不锁定并发创建。
	private ensureNpmProject(installRoot: string): void {
		// 安装根缺失才mkdir。
		if (!existsSync(installRoot)) {
			// 递归创建父层。
			mkdirSync(installRoot, { recursive: true });
		}
		// 尝试标记Dropbox/Apple等忽略属性，helper不检查命令退出状态，不是可靠云同步保证。
		markPathIgnoredByCloudSync(installRoot);
		// 确保目录中已有全忽略.gitignore，现有文件保留原样。
		this.ensureGitIgnore(installRoot);
		// 最小npm项目清单路径。
		const packageJsonPath = join(installRoot, "package.json");
		// 存在就不改、不做版本或形状修复。
		if (!existsSync(packageJsonPath)) {
			// private:true是npm项目元数据，避免普通发布操作，不是文件访问权限。
			const pkgJson = { name: "pi-extensions", private: true };
			// 两空格JSON写UTF-8，不追加换行；创建失败直接抛错。
			writeFileSync(packageJsonPath, JSON.stringify(pkgJson, null, 2), "utf-8");
		}
	}

	// 在目录不存在时创建它，并只在缺少.gitignore时写全忽略规则，输入目录返回void；例内容*加!.gitignore使忽略文件自身可见。已有规则不合并、不替换，错误直接抛出，没有并发锁。
	private ensureGitIgnore(dir: string): void {
		// 目录缺失才创建。
		if (!existsSync(dir)) {
			// 递归建立父目录链。
			mkdirSync(dir, { recursive: true });
		}
		// 拼隐藏规则文件路径。
		const ignorePath = join(dir, ".gitignore");
		// 只缺失时写，存在但内容不同也保留。
		if (!existsSync(ignorePath)) {
			// 第一行忽略所有名字，第二行反选.gitignore；LF是实际文件内容，不在模板内插注释。
			writeFileSync(ignorePath, "*\n!.gitignore\n", "utf-8");
		}
	}

	// 选择npm项目安装根，输入scope和temporary布尔返回路径；例project且非临时得cwd/.pi/npm。temporary=true优先调用临时目录计算并创建/ chmod临时根，其他仅拼路径；非临时project会检查信任，scope=temporary但布尔false会落用户根，调用方需一致传参。
	private getNpmInstallRoot(scope: SourceScope, temporary: boolean): string {
		// temporary开关在scope前优先决定路径。
		if (temporary) {
			// 临时npm根按固定prefix哈希，可能建agentDir/tmp/extensions。
			return this.getTemporaryDir("npm");
		}
		// 非临时project才走项目存储。
		if (scope === "project") {
			// 不可信就拒绝访问项目存储。
			this.assertProjectTrustedForScope(scope);
			// 仅返回cwd/配置目录/npm，不在本分支mkdir。
			return join(this.cwd, CONFIG_DIR_NAME, "npm");
		}
		// 其他scope回用户npm根。
		return join(this.agentDir, "npm");
	}

	// 查询并缓存旧全局npm安装根，返回字符串；例npm root -g，bun用pm bin -g推算global/node_modules。会同步启动只读命令，不安装；缓存按命令+args失效，不因PATH/其他环境变化自动失效，空输出也未完整验证为正确目录。
	private getGlobalNpmRoot(): string {
		// 读取配置命令与前置参数。
		const npmCommand = this.getNpmCommand();
		// 以NUL连接argv作键，避免普通空格分隔造成参数边界混淆。
		const commandKey = [npmCommand.command, ...npmCommand.args].join("\0");
		// 根为真值且命令键完全一致才复用；undefined/空串不算有效命中。
		if (this.globalNpmRoot && this.globalNpmRootCommandKey === commandKey) {
			// 直接返回实例缓存，不重查文件存在性。
			return this.globalNpmRoot;
		}
		// bun没有同样的root -g语法，单独推断。
		if (this.getPackageManagerName() === "bun") {
			// 同步执行配置包管理器pm bin -g，trim输出。
			const binDir = this.runNpmCommandSync(["pm", "bin", "-g"]).trim();
			// 从全局bin父目录拼install/global/node_modules，按此布局假设，不实际验证目录。
			this.globalNpmRoot = join(dirname(binDir), "install", "global", "node_modules");
			// 其他工具用root -g查询。
		} else {
			// 保存stdout/stderr回退后的trim文字，命令失败由runCommandSync抛出。
			this.globalNpmRoot = this.runNpmCommandSync(["root", "-g"]).trim();
		}
		// 只有查询正常走到这里才更新缓存对应键。
		this.globalNpmRootCommandKey = commandKey;
		// 返回得到的根文字，不自动create目录。
		return this.globalNpmRoot;
	}

	// 为pnpm从旧全局list JSON取指定包路径，输入包名返回路径或undefined；例dependencies.foo.path优先于简单root拼接。会同步运行查询，解析/形状异常直接抛给上层兼容回退，不改全局安装。
	private getPnpmGlobalPackagePath(packageName: string): string | undefined {
		// 推断工具不是精确pnpm则不运行list。
		if (this.getPackageManagerName() !== "pnpm") {
			// 让上层尝试普通全局根。
			return undefined;
		}

		// 调用配置包装器的list -g --depth 0 --json，不执行安装。
		const output = this.runNpmCommandSync(["list", "-g", "--depth", "0", "--json"]);
		// as声明期望数组/字典，未运行JSON schema验证，意外形状可使下面遍历或访问失败。
		const entries = JSON.parse(output) as Array<{ dependencies?: Record<string, { path?: string }> }>;
		// 依响应数组顺序找首个包。
		for (const entry of entries) {
			// 可选链只处理dependencies/具体项缺失，不验证path真是字符串或目标存在。
			const path = entry.dependencies?.[packageName]?.path;
			// 首个真值path直接返回。
			if (path) return path;
		}
		// 遍历完无项返回undefined。
		return undefined;
	}

	// 计算本应用管理的npm包目录，输入来源/scope返回路径；例user得agentDir/npm/node_modules/包名。temporary会确保临时扩展根，project先信任检查；不在这里验证包名路径归属或包已安装，npm路径不像Git统一走resolveManagedPath。
	private getManagedNpmInstallPath(source: NpmSource, scope: SourceScope): string {
		// 临时范围用共享临时npm项目。
		if (scope === "temporary") {
			// 包名放node_modules下，@scope/name可含路径分段。
			return join(this.getTemporaryDir("npm"), "node_modules", source.name);
		}
		// 项目范围走项目存储。
		if (scope === "project") {
			// 先拒绝未可信项目。
			this.assertProjectTrustedForScope(scope);
			// 拼cwd/.pi/npm/node_modules/name。
			return join(this.cwd, CONFIG_DIR_NAME, "npm", "node_modules", source.name);
		}
		// 用户范围拼agentDir/npm/node_modules/name。
		return join(this.agentDir, "npm", "node_modules", source.name);
	}

	// 尝试定位旧全局npm包路径，输入来源返回路径或undefined；先用pnpm特殊布局，再全局根拼包名。会运行同步只读工具查询，所有该try内错误转undefined，不在这里检查路径是否存在或卸载legacy包。
	private getLegacyGlobalNpmInstallPath(source: NpmSource): string | undefined {
		// 捕获工具查询/JSON/路径拼接等失败。
		try {
			// ??只在pnpm没有路径时才查询通用根；pnpm响应若直接抛错则不会在本次try内继续右侧。
			return this.getPnpmGlobalPackagePath(source.name) ?? join(this.getGlobalNpmRoot(), source.name);
			// 任何错误转缺失候选。
		} catch {
			// 不把legacy探测错误升级为解析启动失败。
			return undefined;
		}
	}

	// 选择实际npm包路径，输入来源/scope返回字符串，可能是尚不存在的受管理路径；例user管理路径缺失但旧全局路径存在则使用legacy。project/temporary不探测全局，用户回退可启动查询；存在不代表版本/内容正确。
	private getNpmInstallPath(source: NpmSource, scope: SourceScope): string {
		// 先算管理路径，temporary可创建临时根，project可因信任抛错。
		const managedPath = this.getManagedNpmInstallPath(source, scope);
		// 非user直接返回；user若管理目录存在也优先，即便清单缺失。
		if (scope !== "user" || existsSync(managedPath)) {
			// 不在此做最终exists验证。
			return managedPath;
		}
		// 只有user管理路径缺失时尝试旧全局位置。
		const legacyPath = this.getLegacyGlobalNpmInstallPath(source);
		// legacy是真值且存在才采用，否则仍给管理路径，供调用方决定补装。
		return legacyPath && existsSync(legacyPath) ? legacyPath : managedPath;
	}

	// 计算Git受管理checkout地址，输入解析来源/scope返回路径；例user为agentDir/git/host/path，temporary按host/path/ref生成哈希地址。长期忽略ref共用checkout，临时ref计入地址哈希；检查是词法归属，不跟随链接保证实际目标位置。
	private getGitInstallPath(source: GitSource, scope: SourceScope): string {
		// 临时Git使用独立缓存布局。
		if (scope === "temporary") {
			// Include the ref in the hash so each pinned ref gets its own checkout.
			// ref计入哈希输入，不直接作为目录名，因此不同分支文字可区分缓存；短哈希不承诺绝无碰撞。
			return this.getTemporaryDir(`git-${source.host}`, source.path, source.ref);
		}
		// 长期获取user/project共同安装根，project信任在辅助函数检查。
		const installRoot = this.getGitInstallRoot(scope);
		// 应有根却缺失时明确报错，防止按undefined拼路径。
		if (!installRoot) {
			// 同步错误拒绝当前定位/安装流程。
			throw new Error("Missing git install root");
		}
		// host/path在root下resolve并做分隔边界前缀检查，不realpath。
		return this.resolveManagedPath(installRoot, source.host, source.path);
	}

	// 取长期Git安装根，输入scope返回路径或undefined；temporary明确无共同长期根，project先信任检查。例user得agentDir/git；只拼地址，不mkdir。
	private getGitInstallRoot(scope: SourceScope): string | undefined {
		// 临时由getTemporaryDir单独布局。
		if (scope === "temporary") {
			// undefined也让清理父层函数跳过长期根收缩。
			return undefined;
		}
		// 项目安装存储受信任开关限制。
		if (scope === "project") {
			// 访问前查已有内存状态，不发交互询问。
			this.assertProjectTrustedForScope(scope);
			// 返回cwd/.pi/git。
			return join(this.cwd, CONFIG_DIR_NAME, "git");
		}
		// 其他合法scope即user。
		return join(this.agentDir, "git");
	}

	// 为临时来源计算稳定缓存路径，输入prefix/可选suffix/ref返回字符串，并创建/ chmod临时扩展总根；例Git suffix=user/repo、ref=v1以短哈希区分ref，npm无suffix用固定哈希。不是每调用都新建唯一随机目录，也不自动删除旧缓存。
	private getTemporaryDir(prefix: string, suffix?: string, ref?: string): string {
		// 先确保agentDir/tmp/extensions，再把prefix在其中做词法归属检查。
		const root = this.resolveManagedPath(getExtensionTempFolder(this.agentDir), prefix);
		// 创建SHA-256对象，后续链式输入/编码/截断。
		const hash = createHash("sha256")
			// 把prefix、suffix缺省空串和可选@ref拼输入；这是既定文字拼法，不是JSON无歧义序列化或内容校验。
			.update(`${prefix}-${suffix ?? ""}${ref ? `@${ref}` : ""}`)
			// 输出完整十六进制哈希文字。
			.digest("hex")
			// 只保留前8个hex字符作为短目录名，不能视为无碰撞身份或安全令牌。
			.slice(0, 8);
		// 根/短hash/suffix再resolve并检查词法归属，尚未为每个hash/suffix创建目录。
		return this.resolveManagedPath(root, hash, suffix ?? "");
	}

	// 把若干路径片段限制在指定根的词法范围，输入root和rest字符串数组返回绝对路径或抛错，无I/O；例root=/a、parts=../b拒绝，相同根允许。未realpath，因此不能防已存在符号链接把真实操作带到外面。
	private resolveManagedPath(root: string, ...parts: string[]): string {
		// 根先按当前进程cwd变绝对。
		const resolvedRoot = resolve(root);
		// ...parts为剩余参数数组，resolve后面的绝对项可重置基准，因此必须检查结果。
		const resolvedPath = resolve(resolvedRoot, ...parts);
		// 不等根且没有“根+分隔符”前缀就拒绝，避免/a和/ab混淆；根本来带分隔符等平台细节仍沿本式。
		if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
			// 抛拒绝越界错误，不创建/清理目标。
			throw new Error(`Refusing to use path outside package install root: ${resolvedPath}`);
		}
		// 返回已检查的词法绝对地址，不冻结文件系统状态。
		return resolvedPath;
	}

	// 选择设置/来源相对地址基准，输入scope返回路径；project=cwd/.pi且查信任，user=agentDir，temporary=cwd。只读内存/拼路径，不创建目录或证实可信来源内容。
	private getBaseDirForScope(scope: SourceScope): string {
		// 项目来源要解释成相对项目配置目录。
		if (scope === "project") {
			// 先拒绝未可信项目存储访问。
			this.assertProjectTrustedForScope(scope);
			// 返回项目配置目录。
			return join(this.cwd, CONFIG_DIR_NAME);
		}
		// 用户配置相对用户数据根。
		if (scope === "user") {
			// 返回构造时规范的agentDir。
			return this.agentDir;
		}
		// 临时显式来源则相对命令cwd。
		return this.cwd;
	}

	// 解析命令输入本地路径，输入字符串返回绝对地址，无磁盘读取；例./plugin基于this.cwd，~/plugin基于本模块HOME优先主目录。trim明确启用，真实文件名两端空白会因此被去掉，非法file URL可抛错。
	private resolvePath(input: string): string {
		// 委托公共resolvePath，显式homeDir覆盖其默认系统主目录，不跟随符号链接。
		return resolvePath(input, this.cwd, { homeDir: getHomeDir(), trim: true });
	}

	// 按指定设置/包基准解析本地路径，输入文字/baseDir返回绝对地址；与上面只在相对基准不同，仍trim并用HOME优先~展开，无I/O。例全局设置extensions/a.ts从agentDir出发。
	private resolvePathFromBase(input: string, baseDir: string): string {
		// 传显式基准与路径选项，结果未realpath/验证存在。
		return resolvePath(input, baseDir, { homeDir: getHomeDir(), trim: true });
	}

	// 从一个包根收四类资源并修改累积Map/元数据，输入包根、容器、可选过滤、来源信息，返回是否采用包资源布局；例有extensions目录即返回true，即使里面没有找到文件。它不是“非空资源数”的布尔。
	// 先计算包内日志，再优先按配置filter处理；无filter时，有任何清单资源字段就只按清单收，只有元数据的pi清单仍走约定四目录。同步读清单/目录，不执行资源；filter/清单分支即使空结果也true，异常可由调用层捕获或传播。
	private collectPackageResources(
		// 资源与清单的包根，未在本函数整体realpath。
		packageRoot: string,
		// 将被修改的四类Map。
		accumulator: ResourceAccumulator,
		// 设置对象可能只有source而无筛选字段，这也是真值filter。
		filter: PackageFilter | undefined,
		// 可变来源对象，本函数会更新/删除changelogPath，随后多资源可共享引用。
		metadata: PathMetadata,
	): boolean {
		// 读取并浅校验package.json.pi字段，坏清单或缺失可null。
		const manifest = readPiManifest(join(packageRoot, "package.json"));
		// 解析清单指定或默认的包内普通日志文件，不读取正文。
		const changelogPath = resolvePackageChangelogPath(packageRoot, manifest);
		// 只有找到可用日志路径才保存。
		if (changelogPath) {
			// 写入调用方metadata，已共用此引用的资源也可看到字段变化。
			metadata.changelogPath = changelogPath;
			// 找不到则避免旧日志字段残留。
		} else {
			// delete移除属性，而不是保留undefined值。
			delete metadata.changelogPath;
		}

		// 对象形状包配置优先走filter流程，即便没有实际列出某类筛选。
		if (filter) {
			// 逐类决定增量、普通筛选或默认收集。
			for (const resourceType of RESOURCE_TYPES) {
				// 当前资源的可选模式，空数组与undefined区分。
				const patterns = filter[resourceType];
				// 取得当前资源Map。
				const target = this.getTargetMap(accumulator, resourceType);
				// autoload严格false启用仅明确提及项的增量模式。
				if (filter.autoload === false) {
					// 未配该类模式当空增量，不自动收此类默认资源。
					this.applyPackageDeltaFilter(packageRoot, patterns ?? [], resourceType, target, metadata);
					// 普通模式下，明确传数组（包括[]）才采用用户筛选。
				} else if (patterns !== undefined) {
					// manifest先限制候选，再按用户模式设置enabled；[]显式禁用全部候选。
					this.applyPackageFilter(packageRoot, patterns, resourceType, target, metadata);
					// 未指定该类模式才使用该类默认清单/约定。
				} else {
					// 每类单独查清单或目录，和无filter整体显式清单分支的缺字段策略可不同。
					this.collectDefaultResources(packageRoot, resourceType, target, metadata);
				}
			}
			// 有filter即表示按包资源处理过，不保证返回任何资源。
			return true;
		}

		// 无filter且清单含至少一种资源字段时，显式清单决定四类，缺省字段不回退约定目录。
		if (manifest && hasManifestResourceFields(manifest)) {
			// 四类逐个取清单字段。
			for (const resourceType of RESOURCE_TYPES) {
				// 可为undefined或空数组，交辅助函数按显式规则处理。
				const entries = manifest[resourceType];
				// 收当前清单条目，只有启用的manifest候选加入Map。
				this.addManifestEntries(
					// 清单路径列表。
					entries,
					// 所有相对清单入口以包根为基准，非用户主目录~语义。
					packageRoot,
					// 当前资源类型决定目录扫描策略。
					resourceType,
					// 选对应累积Map。
					this.getTargetMap(accumulator, resourceType),
					// 各项保留同一来源对象引用。
					metadata,
				);
			}
			// 显式清单分支即使四数组都空也true，不再把整个目录当扩展fallback。
			return true;
		}

		// 无显式资源清单时记录是否存在任一约定资源路径。
		let hasAnyDir = false;
		// 依extensions/skills/prompts/themes顺序查约定项。
		for (const resourceType of RESOURCE_TYPES) {
			// 约定名直接拼到packageRoot下。
			const dir = join(packageRoot, resourceType);
			// 只查exists，不先要求该路径确是目录。
			if (existsSync(dir)) {
				// Collect all files from the directory (all enabled by default)
				// 按资源策略查文件，错误可能被各发现函数吞掉而给空列表。
				const files = collectResourceFiles(dir, resourceType);
				// 逐个加入找到的路径。
				for (const f of files) {
					// 默认enabled=true，但已有同原路径记录时不会覆盖先前状态。
					this.addResource(this.getTargetMap(accumulator, resourceType), f, metadata, true);
				}
				// 只因约定路径存在就true，空目录/扫描失败也可如此。
				hasAnyDir = true;
			}
		}
		// 告诉本地目录来源是否还需要退回“目录扩展入口”。
		return hasAnyDir;
	}

	// 收某一类包默认资源，输入根/类型/目标Map/metadata返回void；例manifest.skills=[]不回退目录，缺skills才扫skills约定目录。会同步读清单/目录，默认加入启用项，不执行内容或判断跨类名字冲突。
	private collectDefaultResources(
		// 当前包根。
		packageRoot: string,
		// 只处理此类别，其他类由外层循环处理。
		resourceType: ResourceType,
		// 原路径键到来源/状态的目标容器。
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		// 保留调用方来源信息。
		metadata: PathMetadata,
	): void {
		// 独立重读清单，未缓存前面collectPackageResources读取结果。
		const manifest = readPiManifest(join(packageRoot, "package.json"));
		// 可选链在无有效清单时给undefined。
		const entries = manifest?.[resourceType];
		// 数组即便空也为真值，所以显式[]进入清单分支。
		if (entries) {
			// 按清单收启用入口，[]就没有资源。
			this.addManifestEntries(entries, packageRoot, resourceType, target, metadata);
			// 只要有数组字段就不回退本类约定目录。
			return;
		}
		// 字段缺失时查包根/资源类型同名路径。
		const dir = join(packageRoot, resourceType);
		// 约定路径存在才发现。
		if (existsSync(dir)) {
			// Collect all files from the directory (all enabled by default)
			// 技能/扩展智能发现，prompts/themes递归。
			const files = collectResourceFiles(dir, resourceType);
			// 遍历所有候选。
			for (const f of files) {
				// 默认启用加入，Map已有原路径则保留先前状态。
				this.addResource(target, f, metadata, true);
			}
		}
	}

	// 在manifest候选上应用用户包过滤，输入根/模式/类型/Map/metadata返回void；例manifest排baz、用户再排bar，baz不在候选中，bar仍可记录enabled:false。空模式数组禁所有候选，不是默认全开。同步读磁盘/改Map，不执行资源。
	private applyPackageFilter(
		// 包根同时用作模式相对基准。
		packageRoot: string,
		// 用户本类模式，和undefined时默认路径区别。
		userPatterns: string[],
		// 当前资源类别。
		resourceType: ResourceType,
		// 结果目标Map，原路径首先加入者保留。
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		// 该配置来源元数据。
		metadata: PathMetadata,
	): void {
		// 解构只取manifest允许的allFiles，不使用另返回的Set；这些allFiles已可能被清单覆盖模式过滤。
		const { allFiles } = this.collectManifestFiles(packageRoot, resourceType);

		// 用户明确[]表示全禁此类型。
		if (userPatterns.length === 0) {
			// Empty array explicitly disables all resources of this type
			// 对每个允许候选保留一条禁用记录，方便界面展示。
			for (const f of allFiles) {
				// enabled=false而非从Map完全抹掉。
				this.addResource(target, f, metadata, false);
			}
			// 不用再调用普通applyPatterns（它的空模式默认全开）。
			return;
		}

		// Apply user patterns
		// 用普通include→exclude→forceInclude→forceExclude优先级计算用户启用集合，+不能找回manifest已排候选。
		const enabledByUser = applyPatterns(allFiles, userPatterns, packageRoot);

		// 所有候选都加入结果，包括用户禁用项。
		for (const f of allFiles) {
			// Set成员身份按原路径字符串判断。
			const enabled = enabledByUser.has(f);
			// 保留相应布尔状态和元数据。
			this.addResource(target, f, metadata, enabled);
		}
	}

	// 应用autoload:false包增量，输入根/用户模式/类别/Map/元数据返回void；例项目只写-extensions/foo.ts时只产生foo禁用记录，其他用户包资源可另由用户来源加入。同步发现候选，模式按原顺序后命中覆盖，不自动对全部未提及资源补false。
	private applyPackageDeltaFilter(
		// 包根可能是借用的用户安装，metadata仍可属于项目。
		packageRoot: string,
		// 本类增量模式列表。
		userPatterns: string[],
		// 当前类别。
		resourceType: ResourceType,
		// 结果Map沿用同路径首先保留规则。
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		// 原配置来源信息。
		metadata: PathMetadata,
	): void {
		// 没有显式增量不扫描也不加入任何项。
		if (userPatterns.length === 0) {
			// 空return不表示包不存在。
			return;
		}

		// 候选受manifest限制；没有资源清单/空字段时该辅助函数有约定目录回退规则。
		const { allFiles } = this.collectManifestFiles(packageRoot, resourceType);
		// 只得到明确匹配路径与true/false，不是所有文件完整启用表。
		const enabledByUser = applyAutoloadDisabledPatterns(allFiles, userPatterns, packageRoot);
		// Map迭代解构出路径和最终状态。
		for (const [filePath, enabled] of enabledByUser) {
			// 将明确覆盖写入累积，配合项目先入可胜过后加用户资源。
			this.addResource(target, filePath, metadata, enabled);
		}
	}

	/**
	 * Collect all files from a package for a resource type, applying manifest patterns.
	 * Returns { allFiles, enabledByManifest } where enabledByManifest is the set of files
	 * that pass the manifest's own patterns.
	 */
	// 收某类包资源候选并应用manifest自己的覆盖模式，输入包根/类别，返回allFiles数组与enabledByManifest集合；例清单[extensions,!baz.ts]返回只含剩余项的allFiles，不让用户+规则找回baz。同步读磁盘，不执行资源。
	// 本函数只有entries非空才用清单；entries=[]会回退约定目录，与collectDefaultResources对[]直接停的规则不同。这里allFiles在清单分支已转为启用集合数组，不是过滤前全部文件；按实际执行理解原英文。
	private collectManifestFiles(
		// 当前包根。
		packageRoot: string,
		// 只收当前一类。
		resourceType: ResourceType,
	): { allFiles: string[]; enabledByManifest: Set<string> } {
		// 重读并校验pi资源字段，不依赖外层缓存。
		const manifest = readPiManifest(join(packageRoot, "package.json"));
		// 取本类可选数组。
		const entries = manifest?.[resourceType];
		// 必须存在且length>0才视作此函数的清单发现分支。
		if (entries && entries.length > 0) {
			// 先按非覆盖入口收文件/目录或展开glob，得原候选。
			const allFiles = this.collectFilesFromManifestEntries(entries, packageRoot, resourceType);
			// 只把!/+/-项作为清单启用覆盖，普通入口已经用于发现。
			const manifestPatterns = entries.filter(isOverridePattern);
			// 计算manifest允许的路径Set，三元表达式下一行选择。
			const enabledByManifest =
				// 有覆盖模式用applyPatterns，否则全候选建Set并去同字符串重复。
				manifestPatterns.length > 0 ? applyPatterns(allFiles, manifestPatterns, packageRoot) : new Set(allFiles);
			// allFiles取已允许Set内容，因此清单禁项从候选中消失；同时返回该Set供其他用途。
			return { allFiles: Array.from(enabledByManifest), enabledByManifest };
		}

		// 无非空清单字段时按资源类别找约定路径。
		const conventionDir = join(packageRoot, resourceType);
		// 约定路径也不存在就空结果。
		if (!existsSync(conventionDir)) {
			// 空数组与空Set是不同容器但都没有候选。
			return { allFiles: [], enabledByManifest: new Set() };
		}
		// 按资源策略发现约定目录内容。
		const allFiles = collectResourceFiles(conventionDir, resourceType);
		// 数组保留发现结果，Set对同字符串去重；这里数组未统一去重。
		return { allFiles, enabledByManifest: new Set(allFiles) };
	}

	// 按manifest入口与覆盖规则把启用资源加入Map，输入可缺列表/包根/类别/目标Map/来源返回void；例[extensions,!foo.ts]不把foo作为disabled记录返回，而是只加入允许项。同步发现，不执行文件，[]无资源且不自动回退。
	private addManifestEntries(
		// undefined表示没有声明，[]表示显式空列表。
		entries: string[] | undefined,
		// 普通清单路径/glob以root为基准，不用settings基准。
		root: string,
		// 决定目录候选收集方式。
		resourceType: ResourceType,
		// 只把启用项写到此Map。
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		// 各项保留这个元数据引用。
		metadata: PathMetadata,
	): void {
		// 字段undefined立即结束；[]是真值，会继续算空候选。
		if (!entries) return;

		// 取非覆盖入口发现的文件，真正访问磁盘。
		const allFiles = this.collectFilesFromManifestEntries(entries, root, resourceType);
		// 只取!/+/-覆盖规则，不把普通路径再当include筛选一次。
		const patterns = entries.filter(isOverridePattern);
		// 应用固定组优先级决定可加入的Set。
		const enabledPaths = applyPatterns(allFiles, patterns, root);

		// 遍历原候选，保留发现先后顺序。
		for (const f of allFiles) {
			// 只有Set明确允许才加入，不建立禁用清单资源记录。
			if (enabledPaths.has(f)) {
				// 标true，重复原路径由addResource先项优先。
				this.addResource(target, f, metadata, true);
			}
		}
	}

	// 把manifest的非覆盖入口展开为文件列表，输入字符串数组/root/类别返回路径数组；例plugins/*/skills先glob目录再收技能，精确.hidden.ts则可直接存在性收集。会读磁盘，不执行内容；路径允许绝对或..，这里未统一限制所有入口在包根。
	private collectFilesFromManifestEntries(entries: string[], root: string, resourceType: ResourceType): string[] {
		// 去掉!/+/-，它们只负责启用覆盖，不提供发现入口。
		const sourceEntries = entries.filter((entry) => !isOverridePattern(entry));
		// flatMap将每个入口生成的数组拼为一层。
		const resolved = sourceEntries.flatMap((entry) => {
			// 仅在包含*或?时判为磁盘glob，其他glob语法未必触发展开。
			if (!hasGlobPattern(entry)) {
				// 普通入口resolve为绝对，~保持包相对文字，不走normalizePath主目录展开。
				return [resolve(root, entry)];
			}

			// glob展开可见匹配并排序，隐藏路径段会过滤；精确入口不走这层隐藏过滤。
			return expandPackageGlob(entry, root);
		});
		// 每个已有文件直接收，目录按资源智能/递归策略继续，缺失略过。
		return this.collectFilesFromPaths(resolved, resourceType);
	}

	// 解析顶层设置数组中的本地入口与模式，输入列表/类别/Map/元数据/基准返回void；例[extensions,!foo.ts]扫描普通入口并保留被排项enabled:false。只有模式没有普通入口时不自动发现新路径；自动目录由另一流程单独补。同步读磁盘，不导入资源。
	private resolveLocalEntries(
		// 设置条目列表，可含普通路径与覆盖/通配模式。
		entries: string[],
		// 资源类别决定目录发现策略。
		resourceType: ResourceType,
		// 累积目标Map。
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		// 顶层显式来源信息，scope此前已确定。
		metadata: PathMetadata,
		// 相对设置路径基准，用户agentDir/项目cwd/.pi。
		baseDir: string,
	): void {
		// 空列表不做任何发现或覆盖。
		if (entries.length === 0) return;

		// Collect all files from plain entries (non-pattern entries)
		// 把真正入口与只影响启用的模式分开。
		const { plain, patterns } = splitPatterns(entries);
		// 每个普通入口按基准解析，支持trim/~，错误可向上传播。
		const resolvedPlain = plain.map((p) => this.resolvePathFromBase(p, baseDir));
		// 按文件或目录找到已有候选，精确文件不验证资源后缀。
		const allFiles = this.collectFilesFromPaths(resolvedPlain, resourceType);

		// Determine which files are enabled based on patterns
		// 仅从这些候选计算启用Set，模式本身不扫描磁盘。
		const enabledPaths = applyPatterns(allFiles, patterns, baseDir);

		// Add all files with their enabled state
		// 遍历全部候选，不只启用集合。
		for (const f of allFiles) {
			// 加入true/false以保存被用户禁用的可见条目。
			this.addResource(target, f, metadata, enabledPaths.has(f));
		}
	}

	// 补充约定目录的自动资源，输入累积Map、两层设置和各自基准，返回void；例可信项目扫描cwd/.pi扩展/技能/直属提示词/主题及从cwd向上到最近Git根的.agents/skills，用户扫描agentDir四类和HOME/.agents/skills。
	// 先项目后用户，按各作用域覆盖模式算启用，路径第一条记录先保留；读取目录/忽略规则但不执行扩展。项目自动扫描受isProjectTrusted限制，用户扫描始终进行；祖先技能候选排除与用户.agents同文字比较键的目录，真实路径去重还在最终转换。
	private addAutoDiscoveredResources(
		// 直接填充已有四类Map。
		accumulator: ResourceAccumulator,
		// ReturnType<SettingsManager[...]>取得getter返回类型，运行时参数仍是已读取设置对象。
		globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>,
		// 项目原始层类型，不因此自动执行getter或信任校验。
		projectSettings: ReturnType<SettingsManager["getProjectSettings"]>,
		// 用户资源/规则基准。
		globalBaseDir: string,
		// 项目资源/规则基准。
		projectBaseDir: string,
	): void {
		// 用户自动来源元数据共用对象。
		const userMetadata: PathMetadata = {
			// auto标签区别于顶层设置local。
			source: "auto",
			// 用户作用域。
			scope: "user",
			// 自动目录也属于top-level，不是配置包origin。
			origin: "top-level",
			// 记录用户资源基准。
			baseDir: globalBaseDir,
		};
		// 项目自动来源元数据共用对象。
		const projectMetadata: PathMetadata = {
			// 同为auto标签。
			source: "auto",
			// 项目作用域优先级更高。
			scope: "project",
			// 顶层自动来源。
			origin: "top-level",
			// 项目.pi作为默认baseDir，.agents会下面单独改。
			baseDir: projectBaseDir,
		};

		// 从用户四数组准备覆盖规则输入，原普通入口稍后只被覆盖筛选辅助函数忽略。
		const userOverrides = {
			// 用户扩展条目，as不是运行校验。
			extensions: (globalSettings.extensions ?? []) as string[],
			// 用户技能条目。
			skills: (globalSettings.skills ?? []) as string[],
			// 用户提示词条目。
			prompts: (globalSettings.prompts ?? []) as string[],
			// 用户主题条目。
			themes: (globalSettings.themes ?? []) as string[],
		};
		// 项目覆盖规则与用户独立使用。
		const projectOverrides = {
			// 项目扩展条目。
			extensions: (projectSettings.extensions ?? []) as string[],
			// 项目技能条目。
			skills: (projectSettings.skills ?? []) as string[],
			// 项目提示词条目。
			prompts: (projectSettings.prompts ?? []) as string[],
			// 项目主题条目。
			themes: (projectSettings.themes ?? []) as string[],
		};

		// 用户四类约定目录地址字典，只拼路径。
		const userDirs = {
			// 用户extensions根。
			extensions: join(globalBaseDir, "extensions"),
			// 用户skills根。
			skills: join(globalBaseDir, "skills"),
			// 用户prompts根。
			prompts: join(globalBaseDir, "prompts"),
			// 用户themes根。
			themes: join(globalBaseDir, "themes"),
		};
		// 项目四类目录从cwd/.pi基准出发。
		const projectDirs = {
			// 项目extensions根。
			extensions: join(projectBaseDir, "extensions"),
			// 项目skills根。
			skills: join(projectBaseDir, "skills"),
			// 项目prompts根。
			prompts: join(projectBaseDir, "prompts"),
			// 项目themes根。
			themes: join(projectBaseDir, "themes"),
		};
		// 用户跨工具技能根用HOME优先，而非agentDir；构造器只换agentDir不会自动隔离这部分扫描。
		const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
		// 读当前内存项目可信状态，不在这里询问用户。
		const projectTrusted = this.settingsManager.isProjectTrusted();
		// 只有可信时才收项目祖先.agents候选。
		const projectAgentsSkillDirs = projectTrusted
			? // 从cwd到最近Git根或文件系统根，排除按平台文字比较等于用户.agents技能目录的候选，不realpath。
				collectAncestorAgentsSkillDirs(this.cwd).filter((dir) => !pathsEqual(dir, userAgentsSkillsDir))
			: // 未可信项目候选为空，不做祖先Git根扫描。
				[];

		// 局部辅助把一类已发现paths按覆盖规则加入Map，无返回数据；如自动foo.ts被!foo.ts标disabled。只计算状态/改Map，真正读磁盘已由调用参数中的发现函数完成。
		const addResources = (
			// 当前资源类别。
			resourceType: ResourceType,
			// 已经找到的路径列表，不在辅助函数内部再扫描。
			paths: string[],
			// 该批来源信息。
			metadata: PathMetadata,
			// 作用域的覆盖条目。
			overrides: string[],
			// 模式与路径比较基准。
			baseDir: string,
		) => {
			// 选出该类Map。
			const target = this.getTargetMap(accumulator, resourceType);
			// 逐条计算状态，保留发现顺序。
			for (const path of paths) {
				// 默认开，!关、+精确开、-精确关，普通include条目不在自动覆盖中限制全集。
				const enabled = isEnabledByOverrides(path, overrides, baseDir);
				// 保留已发现但禁用的资源；先前同原路径记录不覆盖。
				this.addResource(target, path, metadata, enabled);
			}
		};

		// 可信项目才自动查.pi扩展与技能。
		if (projectTrusted) {
			// Project extensions from .pi/
			// 先加入项目自动扩展。
			addResources(
				// 对应extensions类别。
				"extensions",
				// 读项目extensions目录，按清单/index策略发现入口。
				collectAutoExtensionEntries(projectDirs.extensions),
				// 使用项目auto元数据。
				projectMetadata,
				// 应用项目扩展覆盖项。
				projectOverrides.extensions,
				// 模式基准是项目.pi。
				projectBaseDir,
			);

			// Project skills from .pi/
			// 随后加入项目.pi技能。
			addResources(
				// skills类别。
				"skills",
				// pi模式允许根层普通md并优先SKILL.md。
				collectAutoSkillEntries(projectDirs.skills, "pi"),
				// 保留项目auto元数据。
				projectMetadata,
				// 应用项目技能覆盖。
				projectOverrides.skills,
				// 仍以项目.pi为比较基准。
				projectBaseDir,
			);
		}

		// Project skills from .agents/ (each with its own baseDir)
		// 按由近到远的祖先.agents目录逐个发现，列表未可信时为空。
		for (const agentsSkillsDir of projectAgentsSkillDirs) {
			// 每个skills的父目录.agents作为独立base，而非都按cwd/.pi。
			const agentsBaseDir = dirname(agentsSkillsDir); // the .agents directory
			// 为这一.agents新建外层元数据对象。
			const agentsMetadata: PathMetadata = {
				// 浅展开项目auto原字段。
				...projectMetadata,
				// 覆盖baseDir，其他scope/origin保持项目。
				baseDir: agentsBaseDir,
			};
			// 把该祖先层技能加入Map。
			addResources(
				// skills类别。
				"skills",
				// agents模式忽略根层普通md，但递归子层普通md并优先每层SKILL.md。
				collectAutoSkillEntries(agentsSkillsDir, "agents"),
				// 使用本层新元数据。
				agentsMetadata,
				// 仍应用项目设置里的技能覆盖条目。
				projectOverrides.skills,
				// 相对匹配基准改为本层.agents。
				agentsBaseDir,
			);
		}

		// 项目提示词/主题也只可信时自动扫描。
		if (projectTrusted) {
			// 加入项目自动提示词。
			addResources(
				// prompts类别。
				"prompts",
				// 只收项目prompts直属可见md，不递归其子目录。
				collectAutoPromptEntries(projectDirs.prompts),
				// 项目auto元数据。
				projectMetadata,
				// 项目提示词覆盖规则。
				projectOverrides.prompts,
				// 项目.pi基准。
				projectBaseDir,
			);
			// 再加入项目自动主题。
			addResources(
				// themes类别。
				"themes",
				// 只收项目themes直属可见json，不验证主题内容。
				collectAutoThemeEntries(projectDirs.themes),
				// 项目auto元数据。
				projectMetadata,
				// 项目主题覆盖规则。
				projectOverrides.themes,
				// 项目.pi基准。
				projectBaseDir,
			);
		}

		// User extensions from ~/.pi/agent/
		// 用户自动资源不依赖项目可信开关，接在项目之后。
		addResources(
			// 先用户extensions类别。
			"extensions",
			// 发现agentDir/extensions入口。
			collectAutoExtensionEntries(userDirs.extensions),
			// 用户auto元数据。
			userMetadata,
			// 应用用户扩展覆盖，不用项目覆盖改这些用户路径。
			userOverrides.extensions,
			// 用户agentDir基准。
			globalBaseDir,
		);

		// User skills from ~/.pi/agent/
		// 加入用户.pi/agent技能。
		addResources(
			// skills类别。
			"skills",
			// pi模式，根层md可当单文件技能。
			collectAutoSkillEntries(userDirs.skills, "pi"),
			// 用户auto元数据。
			userMetadata,
			// 用户技能覆盖。
			userOverrides.skills,
			// 用户agentDir相对基准。
			globalBaseDir,
		);

		// User skills from ~/.agents/ (with its own baseDir)
		// 用户跨工具技能的基准是HOME/.agents，不是skills子目录。
		const userAgentsBaseDir = dirname(userAgentsSkillsDir);
		// 为它创建单独元数据外层对象。
		const userAgentsMetadata: PathMetadata = {
			// 继承user/auto/top-level字段。
			...userMetadata,
			// 只替换baseDir为用户.agents。
			baseDir: userAgentsBaseDir,
		};
		// 加入用户.agents发现的技能。
		addResources(
			// skills类别。
			"skills",
			// agents模式忽略根层普通md，收子层技能。
			collectAutoSkillEntries(userAgentsSkillsDir, "agents"),
			// 使用跨工具用户元数据。
			userAgentsMetadata,
			// 仍用用户设置的技能覆盖。
			userOverrides.skills,
			// 相对规则按用户.agents解释。
			userAgentsBaseDir,
		);

		// 加入用户直属提示词。
		addResources(
			// prompts类别。
			"prompts",
			// 收agentDir/prompts直属md。
			collectAutoPromptEntries(userDirs.prompts),
			// 用户auto元数据。
			userMetadata,
			// 用户提示词覆盖。
			userOverrides.prompts,
			// agentDir基准。
			globalBaseDir,
		);
		// 最后加入用户直属主题。
		addResources(
			// themes类别。
			"themes",
			// 收agentDir/themes直属json。
			collectAutoThemeEntries(userDirs.themes),
			// 用户auto元数据。
			userMetadata,
			// 用户主题覆盖。
			userOverrides.themes,
			// agentDir基准。
			globalBaseDir,
		);
	}

	// 从明确给定路径收资源，输入路径数组/类型返回文件列表；现存普通文件不验后缀直接收，目录按资源策略发现。例精确指定.hidden.ts可通过，不等同自动目录隐藏过滤；逐项stat/目录收集错误忽略，路径可在包根外或跟随链接，不在此执行代码。
	private collectFilesFromPaths(paths: string[], resourceType: ResourceType): string[] {
		// 新结果数组，暂不排序/去重。
		const files: string[] = [];
		// 按入口列表顺序处理。
		for (const p of paths) {
			// 不存在的精确路径直接略过，不报安装失败。
			if (!existsSync(p)) continue;

			// 当前路径stat与收集异常局部捕获，不阻止后面其他入口。
			try {
				// stat跟随链接，目标类型决定分支。
				const stats = statSync(p);
				// 普通文件直接接收，不查FILE_PATTERNS。
				if (stats.isFile()) {
					// 保存传入路径拼法，不realpath。
					files.push(p);
					// 目录才使用目录发现规则。
				} else if (stats.isDirectory()) {
					// 将目录下各资源入口展开追加，重复真实文件可能仍存在。
					files.push(...collectResourceFiles(p, resourceType));
				}
				// 本路径错误安静忽略，已加部分内容不撤回。
			} catch {
				// Ignore errors
			}
		}
		// 返回所有已收路径，最后资源转换才统一按路径键去重。
		return files;
	}

	// 取某类累积Map原引用，输入容器/资源类型返回对应Map；例skills返回accumulator.skills，不新建/复制。只做内存分派，未知运行值抛错。
	private getTargetMap(
		// 本次解析使用的四容器。
		accumulator: ResourceAccumulator,
		// TS限定四种合法资源标签。
		resourceType: ResourceType,
	): Map<string, { metadata: PathMetadata; enabled: boolean }> {
		// switch按字符串标签选择，同一个调用只执行命中分支。
		switch (resourceType) {
			// 扩展类别。
			case "extensions":
				// 直接返回原扩展Map，调用方set会修改同容器。
				return accumulator.extensions;
			// 技能类别。
			case "skills":
				// 返回技能Map。
				return accumulator.skills;
			// 提示词类别。
			case "prompts":
				// 返回提示词Map。
				return accumulator.prompts;
			// 主题类别。
			case "themes":
				// 返回主题Map。
				return accumulator.themes;
			// 防止来自未类型约束运行值的未知标签静默得到undefined。
			default:
				// 报未知类别，不尝试猜测默认Map。
				throw new Error(`Unknown resource type: ${resourceType}`);
		}
	}

	// 在某类Map首次登记原路径，输入Map/path/metadata/enabled返回void；例先项目disabled、后用户enabled同原路径时保留项目记录。只按原字符串去重，不更新已有状态、不做realpath/优先级排序，空路径跳过。
	private addResource(
		// 待修改Map，值含来源和启用布尔。
		map: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		// 原始资源路径/合成标识文字。
		path: string,
		// 元数据按引用保存，不深复制。
		metadata: PathMetadata,
		// 调用方计算的状态，false也正常登记。
		enabled: boolean,
	): void {
		// 空串不作为有效键加入，未trim空白串。
		if (!path) return;
		// 只有完全相同路径字符串还没出现时才写。
		if (!map.has(path)) {
			// 新建外层记录对象，metadata仍引用传入对象。
			map.set(path, { metadata, enabled });
		}
	}

	// 创建空四类累积容器，无参数返回ResourceAccumulator，无I/O；例每次resolve都拿独立Map，避免上一轮来源状态残留。
	private createAccumulator(): ResourceAccumulator {
		// 新对象与四Map一并创建。
		return {
			// 空扩展Map，类型按返回上下文推断。
			extensions: new Map(),
			// 空技能Map。
			skills: new Map(),
			// 空提示词Map。
			prompts: new Map(),
			// 空主题Map，不与其他类别共用一个Map。
			themes: new Map(),
		};
	}

	// 把累积Map转四类结果数组，输入accumulator返回ResolvedPaths；例项目显式路径排序在用户自动路径前，同真实文件的链接路径只保留优先项。会尝试realpath生成去重键，失败回原路径；保留disabled项，不解决按技能名称的内容冲突，不附安装失败数组。
	private toResolvedPaths(accumulator: ResourceAccumulator): ResolvedPaths {
		// 局部函数把一类Map变为已排序/去路径重复的资源数组，返回新数组；metadata仍共享引用。
		const mapToResolved = (
			// 接受原路径键与状态记录，不在此改Map。
			entries: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		): ResolvedResource[] => {
			// Map.entries转数组，参数嵌套解构取path及记录字段，每项构造新资源外层对象。
			const resolved = Array.from(entries.entries()).map(([path, { metadata, enabled }]) => ({
				// 原路径拼法保留用于后续文件访问/展示。
				path,
				// 保留启用布尔，排序/去重不自动优先true。
				enabled,
				// 元数据原引用写入。
				metadata,
			}));
			// 原地稳定排序数字rank，低值优先；同rank保持插入顺序，未按名字另排。
			resolved.sort((a, b) => resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata));

			// 此类别专用去重集合，不跨扩展/技能/提示词/主题共用。
			const seen = new Set<string>();
			// 排序后遍历，优先项首先占据真实路径键。
			return resolved.filter((entry) => {
				// builtin/<...>合成标识保持原串，真实文件尝试realpath再按平台大小写比较。
				const pathKey = getResourcePathKey(entry.path);
				// 同键后项丢弃，即便它是enabled:true而前项false。
				if (seen.has(pathKey)) return false;
				// 先记录键，让后面的别名资源无法再进入。
				seen.add(pathKey);
				// 保留该条资源原路径与来源状态。
				return true;
			});
		};

		// 分别转换四类Map，不对调用方容器清空或重排。
		return {
			// 最终扩展列表。
			extensions: mapToResolved(accumulator.extensions),
			// 最终技能路径列表，名称冲突后续由技能加载器处理。
			skills: mapToResolved(accumulator.skills),
			// 最终提示词列表。
			prompts: mapToResolved(accumulator.prompts),
			// 最终主题列表。
			themes: mapToResolved(accumulator.themes),
		};
	}

	// 启动继承输出的包管理/Git子进程，输入命令/args/可选cwd，立即返回ChildProcess；例安装命令由上层监听exit。真正启动外部程序，stdout协议接管时改用stderr；不在此等退出、限制网络、捕获错误或设超时。
	private spawnCommand(command: string, args: string[], options?: { cwd?: string }): ChildProcess {
		// 取当前环境或Linux空环境备用读取结果。
		const env = getEnv();
		// 平台封装负责Windows命令兼容，options未显式shell不代表Windows包装永不调用cmd。
		return spawnProcess(command, args, {
			// 没cwd时底层默认当前进程工作目录，而非自动用this.cwd。
			cwd: options?.cwd,
			// 协议接管时stdin忽略、stdout/stderr都连接父fd2；否则三通道inherit，不由本函数收集输出。
			stdio: isStdoutTakenOver() ? ["ignore", 2, 2] : "inherit",
			// 原环境直接传下，不额外过滤凭证或PATH。
			env,
		});
	}

	// 启动捕获输出的子进程，输入命令/args及cwd/附加env，返回带stdout/stderr可读流的ChildProcess；例npm view。不等待结束，stdin忽略，环境额外键覆盖基础值；调用方负责监听错误/close与清理。
	private spawnCaptureCommand(
		// 可执行命令名。
		command: string,
		// 独立argv数组。
		args: string[],
		// 可选cwd和字符串环境覆盖字典。
		options?: { cwd?: string; env?: Record<string, string> },
	): ChildProcessByStdio<null, Readable, Readable> {
		// 读取基础环境，不修改原process.env。
		const baseEnv = getEnv();
		// 有覆盖时浅复制两对象，后者同名键胜出；没有覆盖则沿用原环境对象引用。
		const env = options?.env ? { ...baseEnv, ...options.env } : baseEnv;
		// 启动真实子进程，重载提供确定的管道类型。
		return spawnProcess(command, args, {
			// 未传cwd仍用底层默认，不自动取实例cwd。
			cwd: options?.cwd,
			// stdin=ignore意味着无父写入管道，另外两项pipe供后面data监听收集。
			stdio: ["ignore", "pipe", "pipe"],
			// 传本次合并环境，Git远端查询可在其中设GIT_TERMINAL_PROMPT。
			env,
		});
	}

	// 运行命令并捕获stdout，输入命令/args与可选cwd、超时、env，返回trim stdout的Promise；例git rev-parse成功close后得commit文字。会启动外部进程、持续累积两条输出，非零/信号/启动错误拒绝。
	// 超时回调只标记并发出child.kill请求，拒绝要等close，忽略kill布尔、无强制升级/后代树清理，因此不是硬性截止。按每块data.toString解码，不用StringDecoder，跨块UTF-8边界不保证保持；输出没有大小上限。error和close可都来，Promise只接受第一次结算。
	private runCommandCapture(
		// 可执行程序。
		command: string,
		// 参数列表，错误展示时会join空格但不等于真正执行时重新拆词。
		args: string[],
		// 可选总计时/工作目录/附加环境；timeoutMs类型约束不保证有限非负数。
		options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
	): Promise<string> {
		// Promise执行器同步启动并装监听，启动同步异常自动变为拒绝。
		return new Promise((resolvePromise, reject) => {
			// 把options中的cwd/env交给捕获启动函数，timeout由本函数单独处理。
			const child = this.spawnCaptureCommand(command, args, options);
			// stdout正文缓存在内存字符串，持续输出可增长。
			let stdout = "";
			// stderr单独保存，成功时不会作为返回正文。
			let stderr = "";
			// 记录计时器是否触发，区分真正超时和其他信号退出。
			let timedOut = false;
			// 保存可选Node计时器句柄。
			const timeout =
				// 原代码通过typeof判断有数字超时，不额外检查NaN/范围；这是实际分支说明，不新增检查。
				typeof options?.timeoutMs === "number"
					? // 设一次计时器，回调不直接reject Promise。
						setTimeout(() => {
							// 先标记，使后来的close优先报超时。
							timedOut = true;
							// 请求默认信号终止子进程，不等退出，不保证杀后代，返回布尔未检查。
							child.kill();
							// 延时按传入timeoutMs，Node自身处理非法/溢出数字规则。
						}, options.timeoutMs)
					: // 未提供数字时没有计时器，可能无限等close。
						undefined;

			// 每个stdout块到达时同步追加，本重载通常保证流存在但仍沿用可选链。
			child.stdout?.on("data", (data) => {
				// 单块toString默认UTF-8，分块边界可能切开多字节字符。
				stdout += data.toString();
			});
			// stderr安装独立data监听。
			child.stderr?.on("data", (data) => {
				// 同样逐块转文字累加，不实时输出到终端。
				stderr += data.toString();
			});
			// 启动/进程error只处理一次，不把它改成退出码。
			child.once("error", (error) => {
				// 已有超时计时器则清掉，防错误后再发kill。
				if (timeout) clearTimeout(timeout);
				// 用原错误对象拒绝，未主动移除其他监听/关闭输出流。
				reject(error);
			});
			// 等close而不是exit，尽量收齐已关闭输出流内容；继承管道未关可使close迟来。
			child.once("close", (code, signal) => {
				// 正常/异常close都取消计时器。
				if (timeout) clearTimeout(timeout);
				// 计时器曾触发则即使code0也按超时拒绝。
				if (timedOut) {
					// 构造包含命令/argv/时长的错误，没有脱敏或shell引号还原。
					reject(new Error(`${command} ${args.join(" ")} timed out after ${options?.timeoutMs}ms`));
					// 超时分支结束，不再判断退出码。
					return;
				}
				// 只有严格数字0成功，null不能视为0。
				if (code === 0) {
					// 只返回stdout并trim，stderr警告不作为正常结果。
					resolvePromise(stdout.trim());
					// 成功分支结束。
					return;
				}
				// null用signal文字展示，数值则写code，signal缺失以unknown兜底。
				const exitStatus = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
				// 非零/信号失败拒绝，优先附非空stderr否则stdout；正文未trim或脱敏。
				reject(new Error(`${command} ${args.join(" ")} failed with ${exitStatus}: ${stderr || stdout}`));
			});
		});
	}

	// 运行继承输出命令并等待主进程exit，输入命令/argv/可选cwd返回Promise<void>；例npm安装code0就完成，启动错误/其他code拒绝。不同于capture不等close、不收正文、不设超时/取消或后代清理，退出后管道收尾不由本函数保证。
	private runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void> {
		// 执行器同步启动子进程，抛错转拒绝。
		return new Promise((resolvePromise, reject) => {
			// 根据stdout接管状态选择继承通道，立即开始外部副作用。
			const child = this.spawnCommand(command, args, options);
			// 直接把Promise reject作为error回调，未清掉exit监听。
			child.on("error", reject);
			// 监听exit而非close，回调忽略signal参数。
			child.on("exit", (code) => {
				// 严格0才判成功。
				if (code === 0) {
					// void结果结算，不返回stdout或退出码。
					resolvePromise();
					// 非0包括null都走失败。
				} else {
					// 错误只展示code，信号退出可显示null，不附真实signal或捕获正文。
					reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
				}
			});
		});
	}

	// 同步执行并返回正文，输入命令/argv返回trim字符串；例npm root -g查询旧全局根。阻塞当前线程，stdout为空时回退stderr，非零/status=null/error抛错；没有cwd/超时参数，不把stderr出现一概当失败。
	private runCommandSync(command: string, args: string[]): string {
		// 读取环境，可能Linux下从/proc备用加载。
		const env = getEnv();
		// 平台同步进程封装，调用到返回期间阻塞当前JS执行。
		const result = spawnProcessSync(command, args, {
			// stdin忽略，stdout/stderr捕获到结果，不直接展示。
			stdio: ["ignore", "pipe", "pipe"],
			// 明确UTF-8使Node返回字符串输出类型。
			encoding: "utf-8",
			// 继承基础环境，不主动删凭证。
			env,
		});
		// 启动错误或退出状态非0都失败，信号退出的null同样拒绝。
		if (result.error || result.status !== 0) {
			// 创建新的Error，不保留cause字段。
			throw new Error(
				// 优先启动error.message，否则stderr再stdout；错误文字含原命令参数/正文，没有脱敏。
				`Failed to run ${command} ${args.join(" ")}: ${result.error?.message || result.stderr || result.stdout}`,
			);
		}
		// 正常时优先stdout，空才取stderr，二者都空返回空串；trim删除首尾空白，不验证目录/版本语义。
		return (result.stdout || result.stderr || "").trim();
	}
}
