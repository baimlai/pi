// 用户/可信项目设置的读取、旧字段迁移、有效视图及带锁排队保存；ResourceLoader、SDK和界面通过getter/setter使用。
// 类型来自settings-schema，但JSON加载不执行完整schema校验；读取默认/局部验证、立即内存修改和稍后文件落盘是不同步骤。
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ScrollViewScrollbar, TerminalCapabilities, WheelScrollLines } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";
import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";
import type {
	CacheWarmingMode,
	CompactionModelOverride,
	DefaultProjectTrust,
	FullscreenExitOutput,
	MermaidRenderingMode,
	PackageSource,
	QuietStartup,
	SessionShareDestination,
	Settings,
	ThinkingBudgetsSettings,
	TransportSetting,
	TuiMode,
	WarningSettings,
} from "./settings-schema.ts";

export type {
	BranchSummarySettings,
	CacheWarmingMode,
	CodemodeMode,
	CodemodeSettings,
	CompactionModelOverride,
	CompactionSettings,
	DefaultProjectTrust,
	FullscreenExitOutput,
	ImageSettings,
	MarkdownSettings,
	MermaidRenderingMode,
	PackageSource,
	ProviderRetrySettings,
	QuietStartup,
	RetrySettings,
	SessionShareDestination,
	Settings,
	TerminalSettings,
	ThinkingBudgetsSettings,
	TransportSetting,
	TuiMode,
	WarningSettings,
} from "./settings-schema.ts";
/** Cache-warming profile. "idle" also warms between agent runs. */
// as const 保留三个字面量和只读元组类型；satisfies 检查它们符合缓存模式数组，不改变运行时数组值。
export const CACHE_WARMING_MODES = ["off", "streaming", "idle"] as const satisfies readonly CacheWarmingMode[];

// Required 把模型覆盖中的可选预算改成必填，作为两个预算读取器的最终默认表。
const DEFAULT_COMPACTION_TOKEN_SETTINGS: Required<CompactionModelOverride> = {
	reserveTokens: SETTINGS_DEFAULTS.compaction.reserveTokens,
	keepRecentTokens: SETTINGS_DEFAULTS.compaction.keepRecentTokens,
};

// 判断外部未知值能否按普通对象递归合并，返回类型谓词，无副作用。
// 例如数组不做逐项合并，直接当覆盖值；null 虽 typeof=object 仍排除，类实例等非数组对象并未全面限制。
function isMergeableObject(value: unknown): value is Record<string, unknown> {
	// 仅对象、非null、非数组才进入递归合并；这不是完整设置 schema 验证。
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 递归合并设置字典，输入基础值和高优先覆盖，返回新顶层对象，不主动改输入字典。
// 例如 {a:{x:1,y:2}} 加 {a:{x:3}} 得到 x=3,y=2；数组/标量整体覆盖，undefined 覆盖项忽略。
// 未触及的嵌套对象可能继续共享引用，不能把此算法当深克隆。
function deepMergeObjects(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	// 先浅复制基础对象，后面逐键处理覆盖项。
	const result = { ...base };

	// 只遍历覆盖对象自己的可枚举字符串键。
	for (const key of Object.keys(overrides)) {
		// 读取当前高优先层值，unknown 需要通过下面的对象判定才能递归。
		const overrideValue = overrides[key];
		// undefined 不覆盖基础值，null 则会作为明确值覆盖。
		if (overrideValue === undefined) {
			continue;
		}

		// 取同键基础值，只有两侧都可合并时才向下递归。
		const baseValue = base[key];
		// 将该键的新值写进新结果，输入 base 本身不被就地写键。
		result[key] =
			// 只有两个非null非数组对象才按子键递归。
			isMergeableObject(baseValue) && isMergeableObject(overrideValue)
				? // 嵌套字典继续用相同优先级规则合并。
					deepMergeObjects(baseValue, overrideValue)
				: // 其他类型由高优先层整项替换，不对数组按索引拼接。
					overrideValue;
	}

	// 返回本次合并字典，默认值仍由具体 getter 按需补充。
	return result;
}

/** Tools enabled at startup when `defaultTools` does not change them. */
// 没有 defaultTools 选择时使用的四个工具；readonly 是编译期数组写入限制，不等于运行时 Object.freeze。
export const DEFAULT_TOOL_NAMES: readonly string[] = ["read", "bash", "edit", "write"];

/** Whether a tool selection entry is a `+name` or `-name` modifier. */
// 判断未知工具选择项是否以 + 或 - 开头，输入任意值，返回布尔值，不验证实际工具是否存在。
// 例如 +grep 是修饰项，grep 是普通名字；单独 + 也满足这一步，但应用时空名字不添加。
export function isToolModifier(entry: unknown): boolean {
	// 先在外部配置边界确认字符串，再识别前导修饰符。
	return typeof entry === "string" && (entry.startsWith("+") || entry.startsWith("-"));
}

/**
 * Validate a tool list from `--tools` or the SDK `tools` option. It is either an allowlist of plain
 * names and patterns or a list of only `+name`/`-name` entries with exact names. Returns the
 * problem, or undefined when the list is valid.
 */
// 校验 CLI/SDK 工具列表是否混用普通名与修饰符、或修饰项包含 *，返回问题文字或 undefined。
// 例如 [read,+grep] 拒绝混用，[+gr*] 拒绝模式；它不检查每个工具名是否已注册，也不直接抛错。
export function getToolListError(entries: readonly string[]): string | undefined {
	// filter 取所有修饰项，原数组不改。
	const modifiers = entries.filter(isToolModifier);
	// 全是普通名字/模式的列表通过这组规则。
	if (modifiers.length === 0) return undefined;
	// 有修饰项但并非全是修饰项，调用者应选择一种模式。
	if (modifiers.length < entries.length) return "tool names cannot be mixed with +name or -name entries";
	// 修饰项必须精确名，所以找第一个含 * 的错误项。
	const pattern = modifiers.find((entry) => entry.includes("*"));
	// 把实际问题项放进错误说明，不在这里修改列表。
	if (pattern) return `+name and -name entries take exact tool names, not patterns: ${pattern}`;
	return undefined;
}

/**
 * Apply the `+name` and `-name` entries of `entries` to `base` in order: `+name` adds a tool and
 * `-name` removes one. Other entries are ignored.
 */
// 把 +name/-name 按顺序应用到基础工具列表，返回新数组，忽略普通项，不改输入。
// 例如 [read,bash] 应用 [-bash,+grep,+read] 得 [read,grep]；重复添加不增重复项，空 + 不添加。
export function applyToolModifiers(base: readonly string[], entries: readonly string[]): string[] {
	// 复制基础数组，splice/push 只改变本函数结果。
	const tools = [...base];
	// 修饰项顺序有意义，后面的增删可抵消前面的操作。
	for (const entry of entries) {
		// 普通名字不在此处理，它们由选择解析器负责基础集合。
		if (!isToolModifier(entry)) continue;
		// 去掉开头 + 或 -，剩余是精确工具名。
		const name = entry.slice(1);
		// 查当前结果中是否已存在此名，-1 表示不存在。
		const index = tools.indexOf(name);
		// 只添加非空且尚未出现的名字，不验证工具注册可用性。
		if (entry.startsWith("+") && index === -1 && name) tools.push(name);
		// 移除已存在项；splice 原地改的是本函数新数组。
		else if (entry.startsWith("-") && index !== -1) tools.splice(index, 1);
	}
	// 返回已应用完全部增删后的选择。
	return tools;
}

/**
 * Merge `defaultTools` of two settings layers. A list with plain tool names replaces the inherited
 * one; a list of only `+name`/`-name` entries is appended, so it modifies the inherited selection.
 */
// 专门合并两层 defaultTools，输入可缺省列表，返回继承/替换/拼接结果，无 I/O。
// 例如基础 [read] 配项目 [+grep] 合成 [read,+grep]，项目 [grep] 则完整替换；此时修饰符还未实际执行。
function mergeDefaultTools(base: string[] | undefined, overrides: string[] | undefined): string[] | undefined {
	// 高优先层没设置就继承基础列表引用。
	if (overrides === undefined) return base;
	// Settings files are not validated; a malformed value replaces instead of throwing here.
	// 设置文件未完整校验；非法形状或含普通名字的覆盖整体替换，只有两侧数组且全修饰项才追加。
	if (!Array.isArray(base) || !Array.isArray(overrides) || !overrides.every(isToolModifier)) return overrides;
	// 保留继承选择，再追加高优先增删操作，最终顺序解释由 resolveDefaultTools 完成。
	return [...base, ...overrides];
}

/**
 * Resolve a merged `defaultTools` list: plain names replace `DEFAULT_TOOL_NAMES`, then `+name` adds
 * and `-name` removes a tool, in list order.
 */
// 把已合并的工具选择变成最终名字数组，输入可混合继承产生的普通名/修饰项，返回新数组。
// 例如只有 [+grep] 时从四个内置默认工具开始加；空数组明确选零个工具，不回退默认。
function resolveDefaultTools(entries: string[]): string[] {
	// 普通名字决定基础集合；修饰项随后按原列表顺序执行。
	const plain = entries.filter((entry) => !isToolModifier(entry));
	// 有普通名或显式空列表用它们，否则从默认四工具开始，再应用增删。
	return applyToolModifiers(plain.length > 0 || entries.length === 0 ? plain : DEFAULT_TOOL_NAMES, entries);
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
// 合并两层设置并特殊处理 defaultTools，输入基础与高优先层，返回有效对象，不落盘。
// 例如 global.compaction 与可信 project.compaction 按子键合并，工具纯修饰列表则追加继承操作；不做完整 schema 校验。
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	// 静态断言允许通用字典算法读取 Settings；as 不验证磁盘值的真实形状。
	const merged = deepMergeObjects(base as Record<string, unknown>, overrides as Record<string, unknown>) as Settings;
	// 工具列表的继承语义不同于普通数组整体覆盖，单独计算。
	const defaultTools = mergeDefaultTools(base.defaultTools, overrides.defaultTools);
	// 有工具选择才覆盖通用合并结果的同名字段；否则直接返回通用结果。
	return defaultTools === undefined ? merged : { ...merged, defaultTools };
}

// 读取一个外部超时设置：输入未知值和诊断名，返回毫秒/undefined，存在但无效则抛 Error，无 I/O。
// 例如 disabled 或0转换成0，缺省undefined仍缺省；空串/负数/无穷不伪装成默认值。
function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	// 共用解析器支持数值/数字字符串/disabled，并拒绝非有限负值。
	const timeoutMs = parseHttpIdleTimeoutMs(value);
	// 0 是合法禁用值，用 !==undefined 而不是 truthy 判断。
	if (timeoutMs !== undefined) {
		// 返回解析出的超时毫秒。
		return timeoutMs;
	}
	// 只有调用方确实配置了却解析失败时才报错，未设置可让 getter 回退默认。
	if (value !== undefined) {
		// 错误包含具体配置名与原值，便于定位 JSON 问题。
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return undefined;
}

// 两个持久化作用域的字面量联合，避免随意把不存在作用域传给存储。
export type SettingsScope = "global" | "project";

// 创建选项显式携带项目是否可信；缺省 true 是兼容上层已经决定信任的调用约定。
export interface SettingsManagerCreateOptions {
	// false 时项目设置完全不读取/合并，且项目写入被拒绝。
	projectTrusted?: boolean;
}

// 设置存储抽象；withLock 回调接收当前原始文字，返回文字表示要写入、undefined 表示只读。
export interface SettingsStorage {
	// 同步接口没有 Promise；具体文件实现负责锁和 I/O，内存实现只模拟同一读改写契约。
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

// 用于报告和 drain 的存储错误，区别于同步 getter 对非法值直接抛出的错误。
export interface SettingsError {
	// 出错的 global/project 层，不误把项目 JSON 问题归到全局。
	scope: SettingsScope;
	// 可选真实文件路径，抽象/内存后端可没有。
	path?: string;
	// 统一包装后的错误对象，便于界面读取 message。
	error: Error;
}

// Record 约束两种作用域的路径值，Partial 允许某作用域没有实际文件位置。
type SettingsPaths = Partial<Record<SettingsScope, string>>;

// 把任意异常归一为含作用域/可选路径/Error的记录，返回新对象，无 I/O。
// 例如存储抛字符串时包成 Error(String(value))；真实 Error 则保留原对象。
function toSettingsError(scope: SettingsScope, error: unknown, path?: string): SettingsError {
	return {
		scope,
		// 只有非空路径才添加可选字段，不生成无意义空路径。
		...(path ? { path } : {}),
		// instanceof 检查外部异常，保留原 Error 或将其他值转成错误文字。
		error: error instanceof Error ? error : new Error(String(error)),
	};
}

// 文件后端把用户 settings.json 和 cwd/.pi/settings.json 分开读改写，已有文件在读取前加锁。
// 这个锁是协作文件锁，不是原子文件替换；writeFileSync 失败可能已经截断/部分写入。
export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	// 输入项目 cwd 和用户 agentDir，计算两层 JSON 路径，不在构造时创建文件或加锁。
	// 例如项目设置独立于用户设置，目录路径先通过 resolvePath 统一为绝对写法。
	constructor(cwd: string, agentDir: string) {
		// 规范项目基准路径，避免相对 cwd 之后指向别处。
		const resolvedCwd = resolvePath(cwd);
		// 规范用户级数据目录。
		const resolvedAgentDir = resolvePath(agentDir);
		// 用户设置文件直接位于 agent 配置根。
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		// 项目设置文件位于 cwd 下 .pi 配置目录。
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
	}

	// 同步获取设置文件协作锁，输入目标路径，成功返回释放函数；最多10次，只对 ELOCKED 重试。
	// 例如另一会话暂持锁，每次忙等20ms再试；这段会阻塞线程，不是异步 sleep，其他错误立即抛出。
	private acquireLockSyncWithRetry(path: string): () => void {
		// 包括首次尝试在内最多10次，避免永久等锁。
		const maxAttempts = 10;
		// 两次锁尝试间隔20毫秒，保持现有同步调用契约。
		const delayMs = 20;
		// 保存最近锁占用异常，unknown 不假定所有抛出值都是 Error。
		let lastError: unknown;

		// 从1计数直到最大尝试次数。
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				// proper-lockfile 返回同步释放函数；false 允许目标文件尚不存在时也使用给定路径锁。
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				// 从外部异常安全提取可能存在的 code，后面只把 ELOCKED 视为可重试。
				const code =
					// 异常信任边界：先确认对象且有属性，再读取错误码。
					typeof error === "object" && error !== null && "code" in error
						? // 将错误码统一为字符串便于比较，as 只是字段形状断言。
							String((error as { code?: unknown }).code)
						: undefined;
				// 非锁占用或次数用尽立即交给上层，不对权限/路径错误盲目重试。
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					// 继续抛原始异常，存储调用方决定是否转成 SettingsError。
					throw error;
				}
				// 保留此次占锁问题供最终兜底。
				lastError = error;
				// 记录本次同步等待开始的毫秒时间。
				const start = Date.now();
				// 忙等直到达到20ms；循环没有让出事件循环。
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		// 极端控制流兜底抛最近错误；as 不把任意值真的转换成 Error。
		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	// 同步读改写一个文件层，输入作用域和回调，无返回；已有文件先锁后读，回调返回undefined则不写。
	// 例如读取缺省文件不会建目录，真的写入才创建目录/加锁；目标原先不存在时回调在拿锁前算过，不承诺所有初次创建竞态都重读合并。
	// 回调/JSON/I/O异常向外抛，finally释放已取得锁；不是原子rename保存。
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		// 按作用域选文件，项目数据不能误写全局文件。
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		// 写入前可能需要创建目标文件父目录。
		const dir = dirname(path);

		// 保存可选锁释放回调，函数类型 () => void 表示无参无返回。
		let release: (() => void) | undefined;
		try {
			// Only create directory and lock if file exists or we need to write
			// 首次检查文件存在性；已有文件在回调前锁读，缺失文件写入前才建目录/加锁。
			const fileExists = existsSync(path);
			// 已有文件必须先获取锁再读当前文字。
			if (fileExists) {
				// 成功拿到释放函数，finally 保证后续读/回调/写失败也尝试释放。
				release = this.acquireLockSyncWithRetry(path);
			}
			// 已有文件读当前原文，缺失文件向回调传 undefined；没有自动 JSON 解析。
			const current = fileExists ? readFileSync(path, "utf-8") : undefined;
			// 执行调用者同步读改写回调，返回 undefined 表示本次只读。
			const next = fn(current);
			// 即使返回空串也表示写入，不能用 truthy 判断。
			if (next !== undefined) {
				// Only create directory when we actually need to write
				// 只有真正写入时才按需创建目录，普通缺省读取不制造空配置目录。
				if (!existsSync(dir)) {
					// 同步创建父目录链，I/O 失败会抛错。
					mkdirSync(dir, { recursive: true });
				}
				// 目标原本不存在时，这里才加锁；注意回调先计算过，不会在加锁后重新读新出现的文件。
				if (!release) {
					// 成功拿到释放函数，finally 保证后续读/回调/写失败也尝试释放。
					release = this.acquireLockSyncWithRetry(path);
				}
				// 同步覆盖目标文字，不是追加，不采用临时文件rename原子替换。
				writeFileSync(path, next, "utf-8");
			}
		} finally {
			// 只有成功获取锁才执行释放。
			if (release) {
				// 同步释放协作锁，finally 中执行以覆盖异常路径。
				release();
			}
		}
	}
}

// 内存后端保存两层原始 JSON 字符串，模拟 withLock 回调契约，无磁盘和真实跨进程锁。
// 例如测试可用同一 SettingsManager 逻辑验证合并/排队保存，而不创建设置文件。
export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	// 同步运行内存读改写回调，输入层和转换函数，无返回，不使用真实文件锁。
	// 例如回调返回undefined只读、空串则写空串；异常直接向外传，和文件后端共享接口形状。
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		// 按作用域取当前内存文字，缺省值保持 undefined。
		const current = scope === "global" ? this.global : this.project;
		// 执行调用者同步读改写回调，返回 undefined 表示本次只读。
		const next = fn(current);
		// 即使返回空串也表示写入，不能用 truthy 判断。
		if (next !== undefined) {
			// 按作用域选择要更新/清理的全局分支，项目层单独处理。
			if (scope === "global") {
				// 将回调的新文字存进用户层内存槽。
				this.global = next;
			} else {
				// 将回调的新文字存进项目层内存槽。
				this.project = next;
			}
		}
	}
}

// 管理“用户层→可信项目层→临时覆盖”的有效设置，并跟踪本会话改过的键以合并写回。
// JSON 加载只做解析和旧字段迁移，不会自动执行 SettingsSchema 的完整校验；各 getter 只按各自规则补默认/检查值。
// set 方法立即改变内存，磁盘动作排入 writeQueue；需 await flush 后再用 drainErrors 判断是否真的保存成功。
export class SettingsManager {
	// 同步存储后端，文件/内存实现使用相同回调契约。
	private storage: SettingsStorage;
	// 未与项目合并的用户层，所有普通setter修改它。
	private globalSettings: Settings;
	// 当前允许读取的项目层；不可信状态下为空，项目setter单独更新。
	private projectSettings: Settings;
	// 对调用者生效的合并视图；applyOverrides只写这一层，后续重新合并会重置临时覆盖。
	private settings: Settings;
	// 项目设置读写开关，由上层信任流程决定，不通过项目JSON自授信任。
	private projectTrusted: boolean;
	// 用户层脏顶层键；keyof把成员限制为Settings字段名，Set自动去重。
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	// 用户层对象字段→脏子键集合，持久化时尽量保留其他会话修改的未触及子项。
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	// 项目层脏顶层键，与用户层独立写回。
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	// 项目层脏子键索引，值为独立Set容器。
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	// 用户JSON读/解析失败时保留错误标记，阻止局部setter把原坏文件覆盖成新文。
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	// 项目层独立的加载错误写保护。
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	// 初始已完成Promise，每次save在其后串接任务，保证本实例的写入顺序。
	private writeQueue: Promise<void> = Promise.resolve();
	// 保存尚未被drainErrors取出的加载/存储错误。
	private errors: SettingsError[];
	// 作用域到真实文件路径的可选映射，抽象后端不一定有路径。
	private settingsPaths: SettingsPaths;

	// 统一内部构造，输入存储、两层初始设置、加载错误/路径及信任状态，保存状态并计算有效合并。
	// 不在此构造阶段重新读文件；例如 fromStorage 先捕获每层错误再注入，避免一份坏 JSON 阻止另一层可用。
	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		projectTrusted = true,
		settingsPaths: SettingsPaths = {},
	) {
		// 保存后端抽象，之后持久化不用绑定某种文件实现。
		this.storage = storage;
		// 保留用户层原始设置对象，与有效合并结果分开。
		this.globalSettings = initialGlobal;
		// 保留本次可信条件下已加载的项目层对象，不直接与用户层混写。
		this.projectSettings = initialProject;
		// 记录项目开关供读取、延迟写入前二次检查和资源发现使用。
		this.projectTrusted = projectTrusted;
		// 记住坏全局JSON状态，后续 setter 不应静默覆盖原坏文件。
		this.globalSettingsLoadError = globalLoadError;
		// 项目层加载失败同样单独保护，避免误写。
		this.projectSettingsLoadError = projectLoadError;
		// 复制待展示错误容器，保留错误对象本身。
		this.errors = [...initialErrors];
		// 保存可选实际路径，错误记录可指向具体配置文件。
		this.settingsPaths = settingsPaths;
		// 项目层覆盖同名用户值，嵌套字典递归合并；临时 overrides 在重新合并后不会自动保留。
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Create a SettingsManager that loads from files */
	// 从实际 JSON 文件创建管理器，输入 cwd/默认或指定 agentDir/信任选项，返回实例。
	// 例如 projectTrusted=false 时只读取用户层，项目文件即使存在也不读；加载错误记录在实例，不在这里直接覆盖坏文件。
	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsManager {
		// 规范项目基准路径，避免相对 cwd 之后指向别处。
		const resolvedCwd = resolvePath(cwd);
		// 规范用户级数据目录。
		const resolvedAgentDir = resolvePath(agentDir);
		// 建立文件后端，路径统一之后再读取两层。
		const storage = new FileSettingsStorage(resolvedCwd, resolvedAgentDir);
		// 统一加载并附上路径，便于后续错误展示。
		return SettingsManager.fromStorageWithPaths(storage, options, {
			// 全局错误附用户 JSON 路径。
			global: join(resolvedAgentDir, "settings.json"),
			// 项目错误附当前 cwd 下配置路径。
			project: join(resolvedCwd, CONFIG_DIR_NAME, "settings.json"),
		});
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	// 从任意同步后端创建管理器，输入后端/可选项目可信开关，返回加载结果实例。
	// 例如测试提供自定义 withLock 观察读改写；没有实际文件路径时错误记录可以不带 path。
	static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
		// 复用统一两层加载流程，不复制合并算法。
		return SettingsManager.fromStorageWithPaths(storage, options);
	}

	/** Create a manager while retaining optional file paths for reported storage errors. */
	// 内部加载两层设置并保留错误来源，输入后端/信任选项/可选路径字典，返回管理器。
	// 用户层无条件尝试，项目层仅可信时尝试；例如一层坏JSON会变空设置加错误，另一层仍可生效。
	private static fromStorageWithPaths(
		storage: SettingsStorage,
		options: SettingsManagerCreateOptions,
		settingsPaths: SettingsPaths = {},
	): SettingsManager {
		// 未显式指定时沿用 true 默认；资源引导流程会明确传/切换 false。
		const projectTrusted = options.projectTrusted ?? true;
		// 全局设置不受项目可信开关过滤。
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		// 项目不可信时内部直接返回空字典，不访问该层后端。
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project", projectTrusted);
		// 收集本次启动两层读/解析问题，不抛错中断所有设置。
		const initialErrors: SettingsError[] = [];
		// 全局读失败就留下可展示错误与写保护标记。
		if (globalLoad.error) {
			// 错误归属用户层，路径来自外部可选字典。
			initialErrors.push(toSettingsError("global", globalLoad.error, settingsPaths.global));
		}
		// 项目读失败与全局问题独立记录。
		if (projectLoad.error) {
			// 附项目路径，不误指向用户 JSON。
			initialErrors.push(toSettingsError("project", projectLoad.error, settingsPaths.project));
		}

		// 把已经加载/捕获的两层结果与错误统一交内部构造器保存。
		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
			settingsPaths,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	// 创建无文件 I/O 的设置实例，输入部分设置和信任选项，返回同样合并/排队 API 的实例。
	// 先 structuredClone 再迁移并序列化到内存全局槽；例如测试传 compaction.enabled=false 不需写真实用户目录。
	static inMemory(settings: Partial<Settings> = {}, options: SettingsManagerCreateOptions = {}): SettingsManager {
		// 只使用内存 JSON 槽，不创建目录或文件。
		const storage = new InMemorySettingsStorage();
		// 深复制输入以防迁移 delete/赋值改变调用者对象；断言只帮助通用字典访问。
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		// 把初始数据按两空格 JSON 写入内存后端的全局层。
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		// 沿同样读取路径创建最终实例，测试与文件后端共享逻辑。
		return SettingsManager.fromStorage(storage, options);
	}

	// 同步从一层存储读取并解析/迁移，输入后端、作用域、项目可信开关，返回设置对象；异常交上层捕获。
	// 例如项目不可信完全不读取文件；有JSON正文则去BOM解析，不做完整schema校验，迁移也不立即写回。
	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope, projectTrusted = true): Settings {
		// 信任边界在读之前生效，不能先解析项目设置再假装忽略它。
		if (scope === "project" && !projectTrusted) {
			return {};
		}

		// 保存后端交出的原始JSON文字。
		let content: string | undefined;
		// 以同步只读回调取当前文字，后端可按需要加文件锁。
		storage.withLock(scope, (current) => {
			// 保存到外层局部变量供锁回调之后解析。
			content = current;
			return undefined;
		});

		// 缺文件或空文字都视作空设置，尚未尝试 JSON.parse。
		if (!content) {
			return {};
		}
		// 仅验证JSON语法并去BOM，不验证 SettingsSchema；根形状不符合迁移需求也可能抛错。
		const settings = JSON.parse(stripBom(content));
		// 原地迁移已解析对象后返回，默认值仍由各 getter 补。
		return SettingsManager.migrateSettings(settings);
	}

	// 容错读取一层设置，输入后端/作用域/可信开关，返回 {settings,error} 而非直接抛出读取失败。
	// 例如坏JSON得到空字典和错误对象，调用者保留旧内存或启动另一层；取消/其他异常也被此同步边界捕获。
	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): { settings: Settings; error: Error | null } {
		try {
			// 成功明确 error=null，返回迁移后的实际设置。
			return { settings: SettingsManager.loadFromStorage(storage, scope, projectTrusted), error: null };
		} catch (error) {
			// 失败返回空设置；as Error 只断言，真正报告时 toSettingsError 还会处理非Error值。
			return { settings: {}, error: error as Error };
		}
	}

	/** Migrate old settings format to new format */
	// 原地迁移旧字段并返回当前预期形状，不直接写存储、不做完整运行时 schema 校验。
	// 依次处理 queueMode→steeringMode、websockets→transport、旧 skills 对象和 retry.maxDelayMs；例如显式新字段已存在时优先新字段。
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		// Migrate queueMode -> steeringMode
		// 只有旧队列名存在且新名未提供时迁移，避免覆盖用户新配置。
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			// 原值搬到新字段，不在迁移时验证它属于何种模式。
			settings.steeringMode = settings.queueMode;
			// 在这个实际执行的迁移分支删除旧键。
			delete settings.queueMode;
		}

		// Migrate legacy websockets boolean -> transport enum
		// 缺新 transport 且旧值确实为布尔时才迁移。
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			// 旧true映射websocket，旧false映射sse，不使用auto。
			settings.transport = settings.websockets ? "websocket" : "sse";
			// 完成该迁移后删除旧布尔字段。
			delete settings.websockets;
		}

		// Migrate old skills object format to new array format
		if (
			// 先确认旧技能配置字段存在，再检查对象形状。
			"skills" in settings &&
			// 旧格式应为对象，数组已经是新格式，不走旧对象迁移。
			typeof settings.skills === "object" &&
			// 显式排除 null，它不能读取 enableSkillCommands 等属性。
			settings.skills !== null &&
			// 数组保持新格式原样，不误当旧对象。
			!Array.isArray(settings.skills)
		) {
			// 断言旧对象中可能存在的两个字段；customDirectories 仍视为 unknown，后面再判断。
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			// 只有新顶层技能命令设置未提供时继承旧对象中的值。
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				// 把旧值提升到当前顶层字段，避免新字段被覆盖。
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			// 旧自定义目录必须是非空数组才成为新 skills 列表；此处没有逐项验证字符串。
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				// 新格式 skills 直接保存路径数组，不保留旧对象包装。
				settings.skills = skillsSettings.customDirectories;
			} else {
				// 没有可迁移目录时删除旧对象字段，让默认发现逻辑继续工作。
				delete settings.skills;
			}
		}

		// Migrate retry.maxDelayMs -> retry.provider.maxRetryDelayMs
		if (
			// 只在确实有旧重试对象时尝试迁移子字段。
			"retry" in settings &&
			// 旧/新 retry 需要非数组对象形状才能搬移配置。
			typeof settings.retry === "object" &&
			// 避免 null 被当普通配置字典读取。
			settings.retry !== null &&
			// 数组不是 retry 配置对象，跳过该迁移。
			!Array.isArray(settings.retry)
		) {
			// 外部JSON子对象按未知字典读取，不凭静态 Settings 类型相信所有字段。
			const retrySettings = settings.retry as Record<string, unknown>;
			// 查找可能已有 provider 子对象，以便保留其他配置。
			const providerSettings =
				// 这里沿用现有条件仅检查非null对象，没有额外排除数组。
				typeof retrySettings.provider === "object" && retrySettings.provider !== null
					? // 有对象则按字典读取 maxRetryDelayMs。
						(retrySettings.provider as Record<string, unknown>)
					: undefined;
			if (
				// 只有真实数字旧延迟才尝试搬迁。
				typeof retrySettings.maxDelayMs === "number" &&
				// 新字段没值或为null时才使用旧值，不覆盖已有有效/无效非空新配置。
				(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
			) {
				// 创建保留已有provider字段的新对象并添加迁移值。
				retrySettings.provider = {
					// 已有供应商超时/重试字段继续保留。
					...(providerSettings ?? {}),
					// 把旧延迟归入provider最大等待，而非Agent重试上限。
					maxRetryDelayMs: retrySettings.maxDelayMs,
				};
			}
			// 迁移检查后移除旧名，即使新值已存在也不再重复保留旧键。
			delete retrySettings.maxDelayMs;
		}

		// 最终只是静态断言为当前类型，不表示已经经过完整SettingsSchema验证。
		return settings as Settings;
	}

	/** A copy of the effective settings: global and project settings merged, with overrides. */
	// 返回有效设置的深复制，包含当前全局/可信项目合并与临时覆盖，无I/O。
	// 例如调用方改副本主题不会直接突变管理器；本方法不会把所有缺省项自动填入对象。
	getSettings(): Settings {
		// structuredClone 隔离嵌套数组/对象，而非仅浅复制顶层。
		return structuredClone(this.settings);
	}

	// 返回用户层深复制，未与项目或临时覆盖混合，无I/O；例如包管理器需分别知道来源作用域。
	getGlobalSettings(): Settings {
		// 复制用户原始设置，未指定字段保持缺省，不插入getter默认。
		return structuredClone(this.globalSettings);
	}

	// 返回已加载项目层深复制，不可信时通常为空字典；例如项目包来源不能混进用户设置文件。
	getProjectSettings(): Settings {
		// 复制项目层原始数据，不返回有效合并层。
		return structuredClone(this.projectSettings);
	}

	// 查询当前管理器项目可信开关，无I/O；例如资源自动发现用它决定是否纳入项目扩展和SYSTEM.md。
	isProjectTrusted(): boolean {
		// 返回内存信任状态，不在查询时弹确认或读取信任数据库。
		return this.projectTrusted;
	}

	// 切换项目可信状态，输入布尔值，无返回；改变有效设置，信任时同步读取项目JSON，不写文件。
	// 例如从true改false立即清空项目层和修改标记；从false改true重新加载项目，错误进入报告队列。
	// 此方法本身不获取用户授权，调用方需先做决定；已排队项目写入在实际执行前还会复查。
	setProjectTrusted(trusted: boolean): void {
		// 同状态直接返回，不重复读取项目文件或清理状态。
		if (this.projectTrusted === trusted) {
			return;
		}

		// 保存新状态，后续项目写入检查以它为准。
		this.projectTrusted = trusted;
		// 清空项目顶层脏字段，避免旧可信状态下的未保存选择继续沿用。
		this.modifiedProjectFields.clear();
		// 同步清空项目嵌套修改追踪。
		this.modifiedProjectNestedFields.clear();

		// 撤销项目参与后，当前有效视图只剩用户层。
		if (!trusted) {
			// 排除项目设置，不把已读项目值继续留在有效层。
			this.projectSettings = {};
			// 清除项目层加载错误标记，后续写入不再因旧加载错误被拦住。
			this.projectSettingsLoadError = null;
			// 项目层覆盖同名用户值，嵌套字典递归合并；临时 overrides 在重新合并后不会自动保留。
			this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
			return;
		}

		// 新信任后才真正尝试读取项目层。
		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", trusted);
		// 采用本次加载结果；失败时这里会得到空字典。
		this.projectSettings = projectLoad.settings;
		// 保留项目错误状态，防止setter覆盖坏文件。
		this.projectSettingsLoadError = projectLoad.error;
		// 项目读失败与全局问题独立记录。
		if (projectLoad.error) {
			// 归一错误并加入可drain队列，供界面显示。
			this.recordError("project", projectLoad.error);
		}
		// 项目层覆盖同名用户值，嵌套字典递归合并；临时 overrides 在重新合并后不会自动保留。
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	// 先等待排队写入，再重读允许的两层设置并清修改追踪，返回Promise<void>；不主动写新默认值。
	// 例如某层重读坏JSON时保留该层原内存并记录错误；成功才替换。当前临时applyOverrides会被新的两层合并重置。
	async reload(): Promise<void> {
		// 等待之前setter排队动作完成；队列错误已被记录，不保证await会因保存失败拒绝。
		await this.writeQueue;
		// 重新尝试用户层，而非直接使用有效合并值当源。
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		// 读取成功才替换旧用户内存，失败保留可用旧值。
		if (!globalLoad.error) {
			// 刷新为最新迁移后的用户JSON。
			this.globalSettings = globalLoad.settings;
			// 成功重读解除该层写保护。
			this.globalSettingsLoadError = null;
		} else {
			// 记录新读错误，后续save不覆盖这份坏用户文件。
			this.globalSettingsLoadError = globalLoad.error;
			// 错误加入可展示队列，加载仍可使用旧内存。
			this.recordError("global", globalLoad.error);
		}

		// 清除用户顶层修改记录；新一轮setter会重新标记。
		this.modifiedFields.clear();
		// 同步清除用户嵌套键追踪。
		this.modifiedNestedFields.clear();
		// 清空项目顶层脏字段，避免旧可信状态下的未保存选择继续沿用。
		this.modifiedProjectFields.clear();
		// 同步清空项目嵌套修改追踪。
		this.modifiedProjectNestedFields.clear();

		// 按当前可信状态重读项目，不可信时返回空层且不读文件。
		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", this.projectTrusted);
		// 成功才刷新项目层，失败保留旧层并记录错误。
		if (!projectLoad.error) {
			// 采用本次加载结果；失败时这里会得到空字典。
			this.projectSettings = projectLoad.settings;
			// 清除项目层加载错误标记，后续写入不再因旧加载错误被拦住。
			this.projectSettingsLoadError = null;
		} else {
			// 保留项目错误状态，防止setter覆盖坏文件。
			this.projectSettingsLoadError = projectLoad.error;
			// 归一错误并加入可drain队列，供界面显示。
			this.recordError("project", projectLoad.error);
		}

		// 项目层覆盖同名用户值，嵌套字典递归合并；临时 overrides 在重新合并后不会自动保留。
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Apply additional overrides on top of current settings */
	// 只给当前有效视图再叠加临时覆盖，输入部分设置，无返回、不持久化也不改两层原始配置。
	// 例如SDK指定临时主题可立即生效；下次reload或setter触发save重新合并两层时，这份临时覆盖不会自动重放。
	applyOverrides(overrides: Partial<Settings>): void {
		// 覆盖在当前有效结果之上，不写globalSettings/projectSettings。
		this.settings = deepMergeSettings(this.settings, overrides);
	}

	/** Mark a global field as modified during this session */
	// 登记用户层已改顶层/可选嵌套键，无I/O；保存时只把这些键合并到最新文件，减少覆盖其他会话设置。
	// 例如只改compaction.enabled，就记录顶层compaction与子键enabled；keyof Settings 限制顶层名来自接口。
	private markModified(field: keyof Settings, nestedKey?: string): void {
		// Set按字段名去重，表示本会话改过这一顶层字段。
		this.modifiedFields.add(field);
		// 非空嵌套键才单独追踪，未传表示整项覆盖。
		if (nestedKey) {
			// 第一次编辑这个对象子键时创建对应集合。
			if (!this.modifiedNestedFields.has(field)) {
				// Map 的值是此顶层字段下已修改子键集合。
				this.modifiedNestedFields.set(field, new Set());
			}
			// !是非空断言，上面已确保集合存在；运行时不增加自动检查。
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** Mark a project field as modified during this session */
	// 登记项目层已改键，和用户层追踪独立，无I/O；例如setProjectPackages不会标记用户packages。
	// 可选嵌套集合用于只写具体项目子项，目前简单项目setter多标整项。
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		// 登记项目顶层脏字段，不混用全局修改集合。
		this.modifiedProjectFields.add(field);
		// 非空嵌套键才单独追踪，未传表示整项覆盖。
		if (nestedKey) {
			// 项目子键第一次被编辑时独立分配集合。
			if (!this.modifiedProjectNestedFields.has(field)) {
				// 建立项目字段→子键集合关系。
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			// 把项目子键加入已保证存在的集合；!只影响类型检查。
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	// 拒绝不可信项目写入，成功无返回，失败抛Error，无文件I/O。
	// 例如排队期间用户撤回项目信任，执行写任务前再次调用会阻止该任务落盘。
	private assertProjectTrustedForWrite(): void {
		// 没有项目授权就不能借设置API写项目文件。
		if (!this.projectTrusted) {
			// 明确错误由同步项目setter或排队写入错误处理路径报告。
			throw new Error("Project is not trusted; refusing to write project settings");
		}
	}

	// 将一项存储错误带作用域/可选路径加入错误队列，无返回；例如flush后界面调用drainErrors展示它。
	private recordError(scope: SettingsScope, error: unknown): void {
		// 统一处理非Error值，并按scope查对应真实文件路径。
		this.errors.push(toSettingsError(scope, error, this.settingsPaths[scope]));
	}

	// 清除指定层修改追踪，输入global/project，无返回无I/O；在已排队任务成功执行后调用。
	// 例如global写完成只清用户集合，项目脏字段仍独立保存。
	private clearModifiedScope(scope: SettingsScope): void {
		// 按作用域选择要更新/清理的全局分支，项目层单独处理。
		if (scope === "global") {
			// 清除用户顶层修改记录；新一轮setter会重新标记。
			this.modifiedFields.clear();
			// 同步清除用户嵌套键追踪。
			this.modifiedNestedFields.clear();
			return;
		}

		// 清空项目顶层脏字段，避免旧可信状态下的未保存选择继续沿用。
		this.modifiedProjectFields.clear();
		// 同步清空项目嵌套修改追踪。
		this.modifiedProjectNestedFields.clear();
	}

	// 把同步存储任务串到Promise队尾，输入作用域与任务，无返回；将来微任务执行I/O。
	// 项目任务实际执行前复查信任，成功清该层追踪；失败记录SettingsError并吞队列拒绝，确保后续任务还能继续。
	// 例如setter先立即改内存，await flush只等队列，保存是否成功还要drainErrors检查。
	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		// 复用前一任务Promise，后续then形成顺序队列，不同时改写同一后端。
		this.writeQueue = this.writeQueue
			// 前面任务结束后才执行本次同步写动作。
			.then(() => {
				// 项目任务需要在执行时再次验证当前信任，不能只信排队时状态。
				if (scope === "project") {
					// 没有当前项目信任就抛出，阻止后面的项目更新/落盘。
					this.assertProjectTrustedForWrite();
				}
				// 执行调用者捕获好的快照持久化函数，可能抛出锁/JSON/I/O错误。
				task();
				// 只有任务成功执行到这里才清追踪。
				this.clearModifiedScope(scope);
			})
			// 错误转成报告而不保持队列拒绝状态；下一次then仍可运行。
			.catch((error) => {
				// 保存失败信息供drain，不直接打印或再次抛出到flush。
				this.recordError(scope, error);
			});
	}

	// 复制顶层→子键Map及每个Set，输入追踪表，返回独立快照，无I/O。
	// 例如任务排队后新的子键修改不会混入旧任务快照；只复制集合，不复制整份设置。
	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		// 新Map隔离之后对原Map的清理或新增字段。
		const snapshot = new Map<keyof Settings, Set<string>>();
		// 解构每个字段与其Set，逐组复制。
		for (const [key, value] of source.entries()) {
			// Set内容为字符串，复制成员即可隔离可变容器。
			snapshot.set(key, new Set(value));
		}
		// 返回供排队闭包捕获的修改追踪快照。
		return snapshot;
	}

	// 在锁回调中把“此次修改键快照”合并进当前最新JSON，输入层/设置快照/脏键与嵌套追踪，无返回。
	// 例如别的会话刚改主题，本次只改retry.enabled，会先读它新主题再仅覆盖enabled，降低整文件旧快照覆盖风险。
	// 会解析JSON/迁移并格式化写出，异常交排队catch记录；不是完整schema验证或原子文件事务。
	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		// 后端负责锁和当前文字读取；回调返回下一版JSON字符串。
		this.storage.withLock(scope, (current) => {
			// 锁内以真正当前文字为基础，避免直接把旧内存全量覆盖。
			const currentFileSettings = current
				? // 现存JSON先去BOM/解析/迁移；解析失败会抛错并保留报告，而非强行覆盖坏文。
					SettingsManager.migrateSettings(JSON.parse(stripBom(current)) as Record<string, unknown>)
				: // 没有当前正文时从空设置开始。
					{};
			// 浅复制最新文件顶层，准备只覆盖改过的键。
			const mergedSettings: Settings = { ...currentFileSettings };
			// 只有此次快照声明改过的顶层字段才写入，其他磁盘键保持。
			for (const field of modifiedFields) {
				// 取排队时设置快照，不读取任务执行时可能已变化的共享内存。
				const value = snapshotSettings[field];
				// 有子键追踪且快照值是非null对象时按子键合并；这里未额外排除数组。
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					// 已由has保证存在，!告诉TypeScript这是Set而非undefined。
					const nestedModified = modifiedNestedFields.get(field)!;
					// 当前文件已有子字典优先，没有则空对象；as不验证其真实结构。
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					// 快照子值按字符串键读取，不执行运行时类型转换。
					const inMemoryNested = value as Record<string, unknown>;
					// 保留别的会话修改的未触及子键。
					const mergedNested = { ...baseNested };
					// 仅遍历本次明确改过的子键。
					for (const nestedKey of nestedModified) {
						// 对应值若undefined，随后JSON.stringify会省略该键，形成删除效果。
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					// 把合并子字典写回新结果，动态键访问需要通用Record断言。
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					// 无子键追踪则整项替换；undefined值最终序列化时省略，清除该字段。
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			// 回调返回两空格缩进JSON，后端据此同步覆盖，不在这里保留旧格式/注释。
			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	// 用户setter共用保存入口，先立即重建有效视图，再为用户层快照排队落盘，无返回。
	// 例如内存主题先更新，磁盘在微任务队列里保存；原全局JSON读坏时仅更新内存不覆盖文件，错误应由drainErrors查看。
	private save(): void {
		// 项目层覆盖同名用户值，嵌套字典递归合并；临时 overrides 在重新合并后不会自动保留。
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		// 坏用户文件有写保护，不把新默认/局部修改静默写成整份替代JSON。
		if (this.globalSettingsLoadError) {
			return;
		}

		// 对排队前用户数据做深快照，后来的setter不改这次任务值。
		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		// 复制本次需保存的顶层脏键。
		const modifiedFields = new Set(this.modifiedFields);
		// 连子键集合也复制，防止队列之后清除影响当前任务。
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		// 只排用户层任务，不把有效项目值回写到用户JSON。
		this.enqueueWrite("global", () => {
			// 执行时以最新文件为基础合并本次用户修改快照。
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	// 保存项目层新对象，输入完整项目数据，立即检查信任/更新内存，再快照排队，无返回。
	// 例如setProjectSkillPaths只改项目JSON；原项目文件读坏时停止落盘防止覆盖，执行时还会复查信任。
	private saveProjectSettings(settings: Settings): void {
		// 没有当前项目信任就抛出，阻止后面的项目更新/落盘。
		this.assertProjectTrustedForWrite();
		// 隔离调用方对象，防止之后对它修改影响内部项目设置。
		this.projectSettings = structuredClone(settings);
		// 项目层覆盖同名用户值，嵌套字典递归合并；临时 overrides 在重新合并后不会自动保留。
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		// 项目JSON存在加载错误时不尝试覆盖它，内存合并仍已更新。
		if (this.projectSettingsLoadError) {
			return;
		}

		// 捕获这次项目数据，后续setter不会污染已排队快照。
		const snapshotProjectSettings = structuredClone(this.projectSettings);
		// 项目脏键单独复制，不与global集合混用。
		const modifiedFields = new Set(this.modifiedProjectFields);
		// 项目嵌套键追踪也独立快照。
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		// 提交项目队列，实际执行前会再次检查项目可信。
		this.enqueueWrite("project", () => {
			// 最新项目文件加本次修改，而非把global有效值写到项目。
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	// 项目setter共用包装，输入要标记的顶层键和修改副本的回调，无返回；不可信同步抛错。
	// 先克隆当前项目层、执行回调、标记修改再saveProjectSettings；例如只更新packages，不写入用户列表。
	private updateProjectSettings(field: keyof Settings, update: (settings: Settings) => void): void {
		// 没有当前项目信任就抛出，阻止后面的项目更新/落盘。
		this.assertProjectTrustedForWrite();
		// 给回调独立项目副本，不让它突变当前有效合并对象。
		const projectSettings = structuredClone(this.projectSettings);
		// 调用具体项目setter的局部修改函数，不在这里执行包安装或技能读取。
		update(projectSettings);
		// 该包装按整个顶层字段标记，后面持久化整项合并。
		this.markProjectModified(field);
		// 统一保存副本并重建有效层、排队项目落盘。
		this.saveProjectSettings(projectSettings);
	}

	// 等待已排队保存全部完成，返回Promise<void>，不启动额外保存；例如测试setter后await flush再读文件。
	// 队列catch已记录失败，因此flush通常不会因存储失败拒绝，调用方还需drainErrors判断。
	async flush(): Promise<void> {
		// 等待之前setter排队动作完成；队列错误已被记录，不保证await会因保存失败拒绝。
		await this.writeQueue;
	}

	// 取出并清空累积存储错误，返回新数组，无I/O；例如flush后界面展示一次，第二次drain不重复旧错误。
	drainErrors(): SettingsError[] {
		// 复制错误数组容器，保留Error对象引用。
		const drained = [...this.errors];
		// 替换内部队列，后续新错误单独累积。
		this.errors = [];
		// 调用方取得本次全部待报告问题。
		return drained;
	}

	// 读取上次已读的 pi 更新日志版本，无输入，返回字符串或undefined；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如版本 1.0 写入后下次可判断是否展示新日志。
	getLastChangelogVersion(): string | undefined {
		// 从有效层读取上次已读的 pi 更新日志版本；未配置可保持undefined，这个直接返回不会深复制对象/数组。
		return this.settings.lastChangelogVersion;
	}

	// 记录已读pi更新日志版本，输入版本字符串，无返回；只改用户层并排队保存，不检查版本大小关系。
	// 例如启动看过1.0后记录它，下次上层自行比较是否展示更新；写入完成需flush，错误用drainErrors。
	setLastChangelogVersion(version: string): void {
		// 更新用户层的上次已读的 pi 更新日志版本；这里只改内存，后面的save才排队落盘。
		this.globalSettings.lastChangelogVersion = version;
		// 标记用户层上次已读的 pi 更新日志版本已改；保存时只合并这个顶层字段。
		this.markModified("lastChangelogVersion");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 按扩展身份key取有效已读版本，返回字符串或undefined，无I/O；例如未看过的扩展没有记录。
	// ?.[key]同时处理整张字典缺省，key本身不在此解析成包来源。
	getExtensionChangelogVersion(key: string): string | undefined {
		// 从有效层读取每个扩展包已读日志版本的字典；未配置可保持undefined，这个直接返回不会深复制对象/数组。
		return this.settings.extensionChangelogVersions?.[key];
	}

	// 更新用户层某扩展已读版本，输入key/版本，无返回；浅复制字典保留其他项，按该子键标脏后排队。
	// 例如A扩展更新不覆盖磁盘里B扩展刚保存的版本；它只存记录，不加载扩展日志。
	setExtensionChangelogVersion(key: string, version: string): void {
		// 扩展日志字典按需浅复制，保留其他扩展key。
		this.globalSettings.extensionChangelogVersions = {
			// 展开用户层已有日志映射，缺省空对象。
			...(this.globalSettings.extensionChangelogVersions ?? {}),
			// 计算属性名以参数key为真实字典键，只改这一扩展版本。
			[key]: version,
		};
		// 标记用户层每个扩展包已读日志版本的字典已改，并精确追踪这个子键，写回时保留其他子项。
		this.markModified("extensionChangelogVersions", key);
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取会话保存目录，无输入，返回字符串或undefined；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如路径开头的 ~ 在读取时可规范化。
	getSessionDir(): string | undefined {
		// 从有效层取会话目录原文字，不在这里创建目录或会话文件。
		const sessionDir = this.settings.sessionDir;
		// 非空目录处理~等输入，undefined/空串保持原值，不强制解析成项目绝对路径。
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	// 读取默认模型供应商，无输入，返回字符串或undefined；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如只保存 provider 名，不在设置层验证凭据。
	getDefaultProvider(): string | undefined {
		// 从有效层读取默认模型供应商；未配置可保持undefined，这个直接返回不会深复制对象/数组。
		return this.settings.defaultProvider;
	}

	// 读取默认模型 id，无输入，返回字符串或undefined；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如与默认 provider 配合选择启动模型。
	getDefaultModel(): string | undefined {
		// 从有效层读取默认模型 id；未配置可保持undefined，这个直接返回不会深复制对象/数组。
		return this.settings.defaultModel;
	}

	// 更新用户层的默认模型供应商，输入 provider 字符串，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如只保存 provider 名，不在设置层验证凭据。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setDefaultProvider(provider: string): void {
		// 更新用户层的默认模型供应商；这里只改内存，后面的save才排队落盘。
		this.globalSettings.defaultProvider = provider;
		// 标记用户层默认模型供应商已改；保存时只合并这个顶层字段。
		this.markModified("defaultProvider");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 更新用户层的默认模型 id，输入 modelId 字符串，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如与默认 provider 配合选择启动模型。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setDefaultModel(modelId: string): void {
		// 更新用户层的默认模型 id；这里只改内存，后面的save才排队落盘。
		this.globalSettings.defaultModel = modelId;
		// 标记用户层默认模型 id已改；保存时只合并这个顶层字段。
		this.markModified("defaultModel");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 一起更新用户默认provider/model，输入两个标识，无返回；两键同时标记后只调用一次save。
	// 例如切换默认到另供应商时避免拆成两次独立保存；此处不验证目录模型存在/凭据，项目覆盖仍可优先。
	setDefaultModelAndProvider(provider: string, modelId: string): void {
		// 更新用户层的默认模型供应商；这里只改内存，后面的save才排队落盘。
		this.globalSettings.defaultProvider = provider;
		// 更新用户层的默认模型 id；这里只改内存，后面的save才排队落盘。
		this.globalSettings.defaultModel = modelId;
		// 标记用户层默认模型供应商已改；保存时只合并这个顶层字段。
		this.markModified("defaultProvider");
		// 标记用户层默认模型 id已改；保存时只合并这个顶层字段。
		this.markModified("defaultModel");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取中途引导消息的出队模式，无输入，返回签名中的选择值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如one-at-a-time 表示逐条交给 Agent。
	getSteeringMode(): "all" | "one-at-a-time" {
		// 从有效层读取中途引导消息的出队模式；||会在空串等假值时使用默认。
		return this.settings.steeringMode || SETTINGS_DEFAULTS.steeringMode;
	}

	// 更新用户层的中途引导消息的出队模式，输入 mode，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如one-at-a-time 表示逐条交给 Agent。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		// 更新用户层的中途引导消息的出队模式；这里只改内存，后面的save才排队落盘。
		this.globalSettings.steeringMode = mode;
		// 标记用户层中途引导消息的出队模式已改；保存时只合并这个顶层字段。
		this.markModified("steeringMode");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取后续排队消息的出队模式，无输入，返回签名中的选择值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如all 表示一次交出当前待处理消息。
	getFollowUpMode(): "all" | "one-at-a-time" {
		// 从有效层读取后续排队消息的出队模式；||会在空串等假值时使用默认。
		return this.settings.followUpMode || SETTINGS_DEFAULTS.followUpMode;
	}

	// 更新用户层的后续排队消息的出队模式，输入 mode，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如all 表示一次交出当前待处理消息。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		// 更新用户层的后续排队消息的出队模式；这里只改内存，后面的save才排队落盘。
		this.globalSettings.followUpMode = mode;
		// 标记用户层后续排队消息的出队模式已改；保存时只合并这个顶层字段。
		this.markModified("followUpMode");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取有效theme原始字符串，非字符串返回undefined，无I/O；例如light/dark配对文字也保留。
	// 设置文件没有完整schema校验，所以这里按运行时类型判断，不在此构建主题。
	getThemeSetting(): string | undefined {
		// 读取未经完整schema验证的theme值，所以下一步确认真实字符串类型。
		const value = this.settings.theme;
		// 合法文字原样返回，允许后面的主题层解释light/dark配对。
		if (typeof value === "string") return value;
		return undefined;
	}

	// 读取仅适合单主题的设置，返回字符串/undefined，无I/O；包含/就返回undefined，交颜色自适应逻辑另行处理。
	// 例如light/dark配对不误当一个普通主题名，但没有在此验证配对格式是否完整。
	getTheme(): string | undefined {
		// 先复用原始主题字符串读取规则，避免重复外部数据检查。
		const theme = this.getThemeSetting();
		// 含斜杠的配对主题不作为普通单名返回；?.允许缺值时不调用includes。
		return theme?.includes("/") ? undefined : theme;
	}

	// 更新用户层的界面主题选择文字，输入 theme 字符串，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如light/dark 形式由主题上层按颜色环境选择。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setTheme(theme: string): void {
		// 更新用户层的界面主题选择文字；这里只改内存，后面的save才排队落盘。
		this.globalSettings.theme = theme;
		// 标记用户层界面主题选择文字已改；保存时只合并这个顶层字段。
		this.markModified("theme");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取默认推理等级，无输入，返回推理等级或undefined；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如level=off 保存关闭推理偏好。
	getDefaultThinkingLevel(): ThinkingLevel | undefined {
		// 从有效层读取默认推理等级；未配置可保持undefined，这个直接返回不会深复制对象/数组。
		return this.settings.defaultThinkingLevel;
	}

	// 更新用户层的默认推理等级，输入 level，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如level=off 保存关闭推理偏好。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setDefaultThinkingLevel(level: ThinkingLevel): void {
		// 更新用户层的默认推理等级；这里只改内存，后面的save才排队落盘。
		this.globalSettings.defaultThinkingLevel = level;
		// 标记用户层默认推理等级已改；保存时只合并这个顶层字段。
		this.markModified("defaultThinkingLevel");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 按精确provider/modelId键读取有效推理覆盖，输入两个标识，返回等级或undefined，无I/O。
	// 例如不同provider的同名模型属于不同键；不在此回退默认等级，由调用方决定。
	getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined {
		// 从有效层读取按 provider/modelId 索引的推理等级覆盖；未配置可保持undefined，这个直接返回不会深复制对象/数组。
		return this.settings.modelThinkingLevels?.[`${provider}/${modelId}`];
	}

	// 返回全部有效模型推理等级字典的浅复制，缺省为空，无I/O。
	// 例如调用方删除返回副本中的键不会直接删管理器字段；值为等级字符串无需深复制。
	getAllModelThinkingLevels(): Record<string, ThinkingLevel> {
		// 缺省空字典，对象展开复制容器；各值为等级字符串，修改返回字典不改内部表。
		return { ...(this.settings.modelThinkingLevels ?? {}) };
	}

	// 更新用户层的按 provider/modelId 索引的推理等级覆盖，输入 provider、modelId、level，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如不同模型可分别保存 high 与 off。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setModelThinkingLevel(provider: string, modelId: string, level: ThinkingLevel): void {
		// 用户层首次保存某模型等级时先建立字典，项目字典不直接写进这里。
		if (!this.globalSettings.modelThinkingLevels) {
			// 用户层还没有按 provider/modelId 索引的推理等级覆盖对象，先分配空字典以便写子键。
			this.globalSettings.modelThinkingLevels = {};
		}
		// 用模板字符串组成精确provider/modelId键；只改这份用户表，不在这里请求模型。
		this.globalSettings.modelThinkingLevels[`${provider}/${modelId}`] = level;
		// 标记用户层按 provider/modelId 索引的推理等级覆盖已改；保存时只合并这个顶层字段。
		this.markModified("modelThinkingLevels");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 从用户层删除指定provider/modelId推理覆盖，无返回；空字典也移除后标整字段并排队保存。
	// 例如只删用户覆盖后有效值仍可来自可信项目；用户层原本没有字典则不保存。
	removeModelThinkingLevel(provider: string, modelId: string): void {
		// 用户层没有任何等级覆盖就无需删除/保存；项目层覆盖不因此被删。
		if (!this.globalSettings.modelThinkingLevels) return;
		// 仅移除指定模型键，不删除其他模型等级。
		delete this.globalSettings.modelThinkingLevels[`${provider}/${modelId}`];
		// 最后一个用户覆盖删掉后，整张空表也从用户配置移除。
		if (Object.keys(this.globalSettings.modelThinkingLevels).length === 0) {
			// undefined/缺键后序列化省略该字段，项目层值可能继续生效。
			delete this.globalSettings.modelThinkingLevels;
		}
		// 标记用户层按 provider/modelId 索引的推理等级覆盖已改；保存时只合并这个顶层字段。
		this.markModified("modelThinkingLevels");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取模型传输方式偏好，无输入，返回签名中的选择值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如auto 由后面的请求层决定合适传输。
	getTransport(): TransportSetting {
		// 从有效层读取模型传输方式偏好；??只在缺值时回退，false和0仍保留。
		return this.settings.transport ?? SETTINGS_DEFAULTS.transport;
	}

	// 更新用户层的模型传输方式偏好，输入 transport，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如auto 由后面的请求层决定合适传输。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setTransport(transport: TransportSetting): void {
		// 更新用户层的模型传输方式偏好；这里只改内存，后面的save才排队落盘。
		this.globalSettings.transport = transport;
		// 标记用户层模型传输方式偏好已改；保存时只合并这个顶层字段。
		this.markModified("transport");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取会话分享目的地偏好，无输入，返回签名中的选择值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如auto 的认证路由由分享层处理。
	getSessionShareDestination(): SessionShareDestination {
		// 读取有效分享偏好，后面只接受两种显式目的地，其他值回退auto。
		const destination = this.settings.sessionShareDestination;
		// 只有这两种文字原样作为显式目的地返回。
		return destination === "gist" || destination === "radius"
			? // 三元表达式真分支采用有效显式选择。
				destination
			: // 包括auto/缺值/非法值均使用内置默认auto。
				SETTINGS_DEFAULTS.sessionShareDestination;
	}

	// 更新用户层的会话分享目的地偏好，输入 destination，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如auto 的认证路由由分享层处理。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setSessionShareDestination(destination: SessionShareDestination): void {
		// 更新用户层的会话分享目的地偏好；这里只改内存，后面的save才排队落盘。
		this.globalSettings.sessionShareDestination = destination;
		// 标记用户层会话分享目的地偏好已改；保存时只合并这个顶层字段。
		this.markModified("sessionShareDestination");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取自动压缩开关，返回有效compaction.enabled或默认true，无输入/I/O。
	// 例如false关闭上层自动判断，不是在此禁止一切显式compact调用。
	getCompactionEnabled(): boolean {
		// 从有效层读取长会话压缩设置；??只在缺值时回退，false和0仍保留。
		return this.settings.compaction?.enabled ?? SETTINGS_DEFAULTS.compaction.enabled;
	}

	// 更新用户层的长会话压缩设置，输入 enabled 布尔开关，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如enabled=false 关闭自动阈值判断，保留预算另行配置。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setCompactionEnabled(enabled: boolean): void {
		if (!this.globalSettings.compaction) {
			// 用户层还没有长会话压缩设置对象，先分配空字典以便写子键。
			this.globalSettings.compaction = {};
		}
		// 更新用户层的长会话压缩设置子键 enabled；这里只改内存，后面的save才排队落盘。
		this.globalSettings.compaction.enabled = enabled;
		// 标记用户层长会话压缩设置已改，并精确追踪这个子键，写回时保留其他子项。
		this.markModified("compaction", "enabled");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取指定压缩预算，输入reserveTokens/keepRecentTokens和可选模型，返回非负安全整数或抛非法设置错误。
	// 优先精确provider/id覆盖→普通预算→内置默认；即使有模型覆盖，普通预算若非法也先报错。
	// 例如模型覆盖reserveTokens不影响普通keepRecentTokens，不按模型名模式匹配，无I/O。
	private getCompactionTokenSetting(
		field: keyof CompactionModelOverride,
		model?: Pick<Model<string>, "provider" | "id">,
	): number {
		// 从有效层读取压缩配置，每个预算再逐项验证和回退。
		const compaction = this.settings.compaction;
		// ?.允许没有压缩对象，方括号用参数选择预算键。
		const ordinary = compaction?.[field];
		// 外部配置预算只能是非负安全整数；普通值即使将被模型覆盖也先验证。
		if (ordinary !== undefined && (typeof ordinary !== "number" || !Number.isSafeInteger(ordinary) || ordinary < 0)) {
			throw new Error(
				`Invalid compaction.${field} setting: ${String(ordinary)}. Expected a non-negative safe integer.`,
			);
		}

		// 模型键精确包含供应商和id，不按展示名/通配符匹配。
		const modelKey = model ? `${model.provider}/${model.id}` : undefined;
		// 没指定模型就不读取任何模型专属覆盖。
		const entry = modelKey !== undefined ? compaction?.modelOverrides?.[modelKey] : undefined;
		// 模型覆盖存在时必须是非null非数组对象，否则抛配置错误。
		if (entry !== undefined && !isMergeableObject(entry)) {
			throw new Error(
				`Invalid compaction.modelOverrides["${modelKey}"] setting: ${String(entry)}. Expected an object.`,
			);
		}
		// 只读当前预算子键，未覆盖这一项不影响另一项回退。
		const override = entry?.[field];
		// 模型预算也用同一非负安全整数规则，NaN/Infinity/小数都拒绝。
		if (override !== undefined && (typeof override !== "number" || !Number.isSafeInteger(override) || override < 0)) {
			throw new Error(
				`Invalid compaction.modelOverrides["${modelKey}"].${field} setting: ${String(override)}. Expected a non-negative safe integer.`,
			);
		}
		// 逐项优先模型覆盖→普通配置→共享默认；0合法，不能用||回退。
		return override ?? ordinary ?? DEFAULT_COMPACTION_TOKEN_SETTINGS[field];
	}

	// 读取模型适用的压缩预留预算，输入可选provider/id，返回非负安全整数；非法值可抛错，无I/O。
	// 例如模型单独预留更多空间时使用其精确键覆盖，没有就回退普通值/16384默认。
	getCompactionReserveTokens(model?: Pick<Model<string>, "provider" | "id">): number {
		return this.getCompactionTokenSetting("reserveTokens", model);
	}

	// 读取模型适用的近期原文保留预算，输入可选模型，返回数字；非法设置抛错，无I/O。
	// 例如某模型配置保留10000，其他模型仍走普通预算/20000默认，不是固定轮数。
	getCompactionKeepRecentTokens(model?: Pick<Model<string>, "provider" | "id">): number {
		return this.getCompactionTokenSetting("keepRecentTokens", model);
	}

	/** Resolve each token setting through model override, ordinary setting, then built-in default. */
	// 组合自动压缩开关和模型适用两个预算，输入可选模型，返回新设置对象，无I/O。
	// 例如模型只覆盖reserveTokens，keepRecentTokens逐项走自己回退链；非法预算仍可抛错。
	getCompactionSettings(model?: Pick<Model<string>, "provider" | "id">): {
		enabled: boolean;
		reserveTokens: number;
		keepRecentTokens: number;
	} {
		return {
			// 自动触发开关单独读取，不受某模型预算覆盖影响。
			enabled: this.getCompactionEnabled(),
			// 此模型的预留空间，与近期保留原文量分开解析。
			reserveTokens: this.getCompactionReserveTokens(model),
			// 此模型的原文尾部近似token预算，不是固定轮数。
			keepRecentTokens: this.getCompactionKeepRecentTokens(model),
		};
	}

	// 读取分支摘要预留空间/是否跳过确认，返回新对象，无输入/I/O；缺字段分别回退默认。
	// 例如skipPrompt=true意味着上层不询问且默认不摘要，不等于自动发模型摘要；这里只逐字段取值，不做预算校验。
	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			// 分支摘要预算仅按缺值回退，不像压缩模型预算读取器额外校验非负安全整数。
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? SETTINGS_DEFAULTS.branchSummary.reserveTokens,
			// false作为显式选择保留；这里不弹对话框或执行摘要。
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? SETTINGS_DEFAULTS.branchSummary.skipPrompt,
		};
	}

	// 读取分支摘要保留空间和确认偏好，无输入，返回布尔值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如skipPrompt=true 表示跳过询问并默认不摘要。
	getBranchSummarySkipPrompt(): boolean {
		// 从有效层读取分支摘要保留空间和确认偏好；??只在缺值时回退，false和0仍保留。
		return this.settings.branchSummary?.skipPrompt ?? SETTINGS_DEFAULTS.branchSummary.skipPrompt;
	}

	// 读取Agent层自动重试开关，返回有效retry.enabled或默认true，无输入/I/O。
	// 例如false不自动改供应商SDK自己的重试设置，两层请求策略分别读取。
	getRetryEnabled(): boolean {
		// 从有效层读取Agent 与 provider 重试配置；??只在缺值时回退，false和0仍保留。
		return this.settings.retry?.enabled ?? SETTINGS_DEFAULTS.retry.enabled;
	}

	// 更新用户层的Agent 与 provider 重试配置，输入 enabled 布尔开关，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如Agent 重试次数和 provider 最大等待分别读取。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setRetryEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			// 用户层还没有Agent 与 provider 重试配置对象，先分配空字典以便写子键。
			this.globalSettings.retry = {};
		}
		// 更新用户层的Agent 与 provider 重试配置子键 enabled；这里只改内存，后面的save才排队落盘。
		this.globalSettings.retry.enabled = enabled;
		// 标记用户层Agent 与 provider 重试配置已改，并精确追踪这个子键，写回时保留其他子项。
		this.markModified("retry", "enabled");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 组合Agent重试开关、次数、基础退避、最大Agent等待，返回新对象，无输入/I/O。
	// 例如provider重试超时不从这个对象读取，由getProviderRetrySettings另处理；缺值逐字段回退。
	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number; maxAgentDelayMs: number } {
		return {
			// 组合Agent层重试开关，返回对象时不启动重试。
			enabled: this.getRetryEnabled(),
			// 没配置才用Agent默认次数；0不会被替换成默认。
			maxRetries: this.settings.retry?.maxRetries ?? SETTINGS_DEFAULTS.retry.maxRetries,
			// Agent指数退避的基础毫秒数，与provider网络超时不同。
			baseDelayMs: this.settings.retry?.baseDelayMs ?? SETTINGS_DEFAULTS.retry.baseDelayMs,
			// Agent最大等待单独回退，不从旧provider最大等待混用。
			maxAgentDelayMs: this.settings.retry?.maxAgentDelayMs ?? SETTINGS_DEFAULTS.retry.maxAgentDelayMs,
		};
	}

	// 读取HTTP空闲超时并解析，返回毫秒，无输入/I/O；缺省采用默认，配置存在却非法时抛错。
	// 例如disabled返回0而非默认超时，数字字符串由共享解析器处理。
	getHttpIdleTimeoutMs(): number {
		// 解析成功0仍保留禁用；真正缺省才回退共享HTTP默认空闲超时。
		return parseTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs") ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	}

	// 保存用户HTTP空闲超时，输入有限非负数字，无返回；非法数同步抛错，合法值向下取整后标记/排队。
	// 例如12.9存12，0保留禁用含义；此setter不接受disabled字符串，文件getter解析可接受。
	setHttpIdleTimeoutMs(timeoutMs: number): void {
		// 数值类型仍允许NaN/Infinity/负数，所以按配置策略额外拒绝这些值。
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			// 非法setter输入同步抛出，不等排队写盘才发现。
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		}
		// 更新用户层的HTTP 头/正文空闲超时毫秒数；这里只改内存，后面的save才排队落盘。
		this.globalSettings.httpIdleTimeoutMs = Math.floor(timeoutMs);
		// 标记用户层HTTP 头/正文空闲超时毫秒数已改；保存时只合并这个顶层字段。
		this.markModified("httpIdleTimeoutMs");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	/** Read from global settings only because warming costs money. */
	// 只从用户层取缓存预热模式并检查三种允许值，缺省/非法回退默认，无输入/I/O。
	// 例如项目JSON和临时有效覆盖不能在这里开启付费预热；读取模式不会实际请求模型。
	getCacheWarmingMode(): CacheWarmingMode {
		// 费用敏感偏好只看用户原始层，项目值和仅作用于有效视图的临时覆盖不参与。
		const mode = this.globalSettings.cacheWarming;
		// 严格允许off/streaming/idle，缺失或非法文字统一回退默认。
		return mode !== undefined && CACHE_WARMING_MODES.includes(mode) ? mode : SETTINGS_DEFAULTS.cacheWarming;
	}

	// 保存用户层缓存预热模式，输入off/streaming/idle，无返回；标记全局字段并排队。
	// 例如off只存偏好，不在这里发预热请求；getCacheWarmingMode只读用户层，项目同名值不会改变其结果。
	setCacheWarmingMode(mode: CacheWarmingMode): void {
		// 更新用户层的缓存预热模式；这里只改内存，后面的save才排队落盘。
		this.globalSettings.cacheWarming = mode;
		// 标记用户层缓存预热模式已改；保存时只合并这个顶层字段。
		this.markModified("cacheWarming");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取provider级超时/次数/最大重试等待，返回新对象，无输入/I/O。
	// 例如timeoutMs与maxRetries未设置就保留undefined，让具体SDK决定，而maxRetryDelayMs有内置默认。
	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
		return {
			// 供应商SDK超时未设时保持undefined，由后续请求层/SDK选择。
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			// 供应商内部重试次数与Agent重试次数分别存取。
			maxRetries: this.settings.retry?.provider?.maxRetries,
			// 下面继续读取provider最大等待，字段名单独一行只是同一对象属性声明。
			maxRetryDelayMs:
				// 缺值采用共享provider等待默认，不再读已迁移旧maxDelayMs字段。
				this.settings.retry?.provider?.maxRetryDelayMs ?? SETTINGS_DEFAULTS.retry.provider.maxRetryDelayMs,
		};
	}

	// 读取并解析WebSocket建连超时，返回毫秒或undefined，无I/O；存在但非法配置抛错。
	// 例如disabled返回0，没配返回undefined而不强行使用HTTP空闲超时默认。
	getWebSocketConnectTimeoutMs(): number | undefined {
		// WebSocket建连缺省仍返回undefined，不强行采用HTTP空闲超时默认。
		return parseTimeoutSetting(this.settings.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
	}

	// 读取界面是否隐藏模型思考块，无输入，返回布尔值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如true 改显示偏好，不在这里删模型消息。
	getHideThinkingBlock(): boolean {
		// 从有效层读取界面是否隐藏模型思考块；??只在缺值时回退，false和0仍保留。
		return this.settings.hideThinkingBlock ?? SETTINGS_DEFAULTS.hideThinkingBlock;
	}

	// 读取是否显示缓存未命中等用量通知，无输入，返回布尔值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如false 可关闭该类通知显示。
	getShowCacheMissNotices(): boolean {
		// 从有效层读取是否显示缓存未命中等用量通知；??只在缺值时回退，false和0仍保留。
		return this.settings.showCacheMissNotices ?? SETTINGS_DEFAULTS.showCacheMissNotices;
	}

	// 按有效非空外部编辑器→VISUAL→EDITOR→平台默认选择命令，返回字符串，不启动程序。
	// 例如Windows最终默认notepad，其他平台nano；配置trim只用于判非空，返回仍保留原命令文字。
	getExternalEditorCommand(): string {
		// 取有效显式命令，配置文件可能不是字符串需在下一步判断。
		const configuredEditor = this.settings.externalEditor;
		// 实际字符串且非纯空白才优先采用；trim不改返回正文。
		if (typeof configuredEditor === "string" && configuredEditor.trim() !== "") {
			// 原命令文字原样返回，空格/参数解释交启动编辑器的上层。
			return configuredEditor;
		}
		// 显式配置未采用时，VISUAL优先于EDITOR，空串按||视为未配。
		const environmentEditor = process.env.VISUAL || process.env.EDITOR;
		// 有非空环境选择时不用平台默认。
		if (environmentEditor) {
			// 返回环境命令，未在读取设置时执行它。
			return environmentEditor;
		}
		// 最后回退Windows记事本，其他平台nano，不检查程序是否已安装。
		return process.platform === "win32" ? "notepad" : "nano";
	}

	// 更新用户层的界面是否隐藏模型思考块，输入 hide 布尔开关，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如true 改显示偏好，不在这里删模型消息。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setHideThinkingBlock(hide: boolean): void {
		// 更新用户层的界面是否隐藏模型思考块；这里只改内存，后面的save才排队落盘。
		this.globalSettings.hideThinkingBlock = hide;
		// 标记用户层界面是否隐藏模型思考块已改；保存时只合并这个顶层字段。
		this.markModified("hideThinkingBlock");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 更新用户层的是否显示缓存未命中等用量通知，输入 show 布尔开关，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如false 可关闭该类通知显示。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setShowCacheMissNotices(show: boolean): void {
		// 更新用户层的是否显示缓存未命中等用量通知；这里只改内存，后面的save才排队落盘。
		this.globalSettings.showCacheMissNotices = show;
		// 标记用户层是否显示缓存未命中等用量通知已改；保存时只合并这个顶层字段。
		this.markModified("showCacheMissNotices");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取自定义 shell 可执行路径，无输入，返回字符串或undefined；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如读取时可展开 ~，本层不启动 shell。
	getShellPath(): string | undefined {
		// 有效shell路径原文，是否真的可执行在其他模块判断。
		const shellPath = this.settings.shellPath;
		// 非空路径处理~等输入，但不在此启动shell或强制相对cwd解析。
		return shellPath ? normalizePath(shellPath) : shellPath;
	}

	// 更新用户层的自定义 shell 可执行路径，输入 path，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如读取时可展开 ~，本层不启动 shell。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setShellPath(path: string | undefined): void {
		// 更新用户层的自定义 shell 可执行路径；这里只改内存，后面的save才排队落盘。
		this.globalSettings.shellPath = path;
		// 标记用户层自定义 shell 可执行路径已改；保存时只合并这个顶层字段。
		this.markModified("shellPath");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取启动输出简化模式，无输入，返回签名中的选择值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如header 只保留启动头部。
	getQuietStartup(): QuietStartup {
		// 启动输出偏好可能来自未完整验证的JSON。
		const value = this.settings.quietStartup;
		// 仅true和header为显式非默认模式，其余（含false）回退默认false。
		return value === true || value === "header" ? value : SETTINGS_DEFAULTS.quietStartup;
	}

	// 更新用户层的启动输出简化模式，输入 quiet，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如header 只保留启动头部。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setQuietStartup(quiet: QuietStartup): void {
		// 更新用户层的启动输出简化模式；这里只改内存，后面的save才排队落盘。
		this.globalSettings.quietStartup = quiet;
		// 标记用户层启动输出简化模式已改；保存时只合并这个顶层字段。
		this.markModified("quietStartup");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 只读用户层默认项目信任偏好，返回always/never或默认ask，无输入/I/O。
	// 例如项目自己不能通过本地settings把默认信任改成always；这不是当前项目可信状态isProjectTrusted。
	getDefaultProjectTrust(): DefaultProjectTrust {
		// 默认信任政策只能由用户层设置，不能由项目自己控制它的默认授权。
		const value = this.globalSettings.defaultProjectTrust;
		// 显式always/never原样返回，其他选择包括ask统一用默认ask。
		return value === "always" || value === "never" ? value : SETTINGS_DEFAULTS.defaultProjectTrust;
	}

	// 保存用户层默认新项目信任政策，输入ask/always/never，无返回；标记并排队，不立即授权当前项目。
	// 例如设never不调用setProjectTrusted，当前项目状态仍由独立信任流程决定；getter只读用户层。
	setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): void {
		// 更新用户层的新项目默认信任策略；这里只改内存，后面的save才排队落盘。
		this.globalSettings.defaultProjectTrust = defaultProjectTrust;
		// 标记用户层新项目默认信任策略已改；保存时只合并这个顶层字段。
		this.markModified("defaultProjectTrust");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取每条 shell 命令的前缀文字，无输入，返回字符串或undefined；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如本层保存前缀，不执行它。
	getShellCommandPrefix(): string | undefined {
		// 从有效层读取每条 shell 命令的前缀文字；未配置可保持undefined，这个直接返回不会深复制对象/数组。
		return this.settings.shellCommandPrefix;
	}

	// 更新用户层的每条 shell 命令的前缀文字，输入 prefix，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如本层保存前缀，不执行它。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setShellCommandPrefix(prefix: string | undefined): void {
		// 更新用户层的每条 shell 命令的前缀文字；这里只改内存，后面的save才排队落盘。
		this.globalSettings.shellCommandPrefix = prefix;
		// 标记用户层每条 shell 命令的前缀文字已改；保存时只合并这个顶层字段。
		this.markModified("shellCommandPrefix");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取npm 命令 argv 数组，无输入，返回字符串数组或undefined；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如可用 [wrapper,npm] 指定包装器而非拼 shell 命令。
	getNpmCommand(): string[] | undefined {
		// 从有效层读取npm命令argv，未配置则保持undefined；下行只浅复制数组，不是深复制任意配置对象。
		// 返回新的argv数组容器，调用方push不会改内部列表；无配置返回undefined。
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	// 更新用户层的npm 命令 argv 数组，输入 command，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如可用 [wrapper,npm] 指定包装器而非拼 shell 命令。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setNpmCommand(command: string[] | undefined): void {
		// 更新用户层的npm 命令 argv 数组；这里只改内存，后面的save才排队落盘。
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		// 标记用户层npm 命令 argv 数组已改；保存时只合并这个顶层字段。
		this.markModified("npmCommand");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取是否折叠启动更新日志，无输入，返回布尔值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如true 使用简略显示偏好。
	getCollapseChangelog(): boolean {
		// 从有效层读取是否折叠启动更新日志；??只在缺值时回退，false和0仍保留。
		return this.settings.collapseChangelog ?? SETTINGS_DEFAULTS.collapseChangelog;
	}

	// 更新用户层的是否折叠启动更新日志，输入 collapse 布尔开关，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如true 使用简略显示偏好。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setCollapseChangelog(collapse: boolean): void {
		// 更新用户层的是否折叠启动更新日志；这里只改内存，后面的save才排队落盘。
		this.globalSettings.collapseChangelog = collapse;
		// 标记用户层是否折叠启动更新日志已改；保存时只合并这个顶层字段。
		this.markModified("collapseChangelog");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取安装/更新匿名版本通知偏好，无输入，返回布尔值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如保存开关不会在本函数里发送统计。
	getEnableInstallTelemetry(): boolean {
		// 从有效层读取安装/更新匿名版本通知偏好；??只在缺值时回退，false和0仍保留。
		return this.settings.enableInstallTelemetry ?? SETTINGS_DEFAULTS.enableInstallTelemetry;
	}

	// 更新用户层的安装/更新匿名版本通知偏好，输入 enabled 布尔开关，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如保存开关不会在本函数里发送统计。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setEnableInstallTelemetry(enabled: boolean): void {
		// 更新用户层的安装/更新匿名版本通知偏好；这里只改内存，后面的save才排队落盘。
		this.globalSettings.enableInstallTelemetry = enabled;
		// 标记用户层安装/更新匿名版本通知偏好已改；保存时只合并这个顶层字段。
		this.markModified("enableInstallTelemetry");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取分析数据分享选择，无输入，返回布尔值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如首次启用时可额外生成 trackingId。
	getEnableAnalytics(): boolean {
		// 从有效层读取分析数据分享选择；??只在缺值时回退，false和0仍保留。
		return this.settings.enableAnalytics ?? SETTINGS_DEFAULTS.enableAnalytics;
	}

	// 读取分析追踪标识，无输入，返回字符串或undefined；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如未启用前可能还没有这个 id。
	getTrackingId(): string | undefined {
		// 从有效层读取分析追踪标识；未配置可保持undefined，这个直接返回不会深复制对象/数组。
		return this.settings.trackingId;
	}

	/** Set the analytics opt-in preference; generates a tracking identifier on first opt-in */
	// 保存用户分析数据分享开关，输入布尔值，无返回；首次开启且缺trackingId时生成UUID并一起标记保存。
	// 例如关闭不会清旧追踪id，本函数只保存偏好，不发送网络数据；保存失败仍通过队列报告。
	setEnableAnalytics(enabled: boolean): void {
		// 更新用户层的分析数据分享选择；这里只改内存，后面的save才排队落盘。
		this.globalSettings.enableAnalytics = enabled;
		// 标记用户层分析数据分享选择已改；保存时只合并这个顶层字段。
		this.markModified("enableAnalytics");
		// 仅从关闭/无id状态首次启用时生成追踪标识，关闭不自动删旧id。
		if (enabled && !this.globalSettings.trackingId) {
			// 更新用户层的分析追踪标识；这里只改内存，后面的save才排队落盘。
			this.globalSettings.trackingId = randomUUID();
			// 标记用户层分析追踪标识已改；保存时只合并这个顶层字段。
			this.markModified("trackingId");
		}
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	/**
	 * Stable ID of this installation, e.g. sent to OpenAI as its agent host ID.
	 * Created on first use. Project settings are ignored so a committed project
	 * settings file cannot give every clone the same ID.
	 */
	// 获取用户安装稳定id，缺省时生成UUID、标记并排队保存后返回，因此它不是纯查询。
	// 例如两次调用复用同一内存id，项目层deviceId被忽略；需flush后才能确认落盘，错误用drainErrors。
	getOrCreateDeviceId(): string {
		// 只在用户层没有非空设备id时生成，忽略项目层伪造的同名值。
		if (!this.globalSettings.deviceId) {
			// 更新用户层的当前安装的稳定设备标识；这里只改内存，后面的save才排队落盘。
			this.globalSettings.deviceId = randomUUID();
			// 标记用户层当前安装的稳定设备标识已改；保存时只合并这个顶层字段。
			this.markModified("deviceId");
			// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
			this.save();
		}
		// 返回稳定用户设备id；前面新建时已排队，返回不代表磁盘保存成功。
		return this.globalSettings.deviceId;
	}

	// 读取资源包来源列表，无输入，返回新的包来源数组；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如包可用字符串或带资源筛选的对象表示。
	getPackages(): PackageSource[] {
		// 新数组隔离列表增删；包配置对象成员仍是浅共享，不是深克隆。
		return [...(this.settings.packages ?? [])];
	}

	// 更新用户层的资源包来源列表，输入 packages，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如包可用字符串或带资源筛选的对象表示。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setPackages(packages: PackageSource[]): void {
		// 更新用户层的资源包来源列表；这里只改内存，后面的save才排队落盘。
		this.globalSettings.packages = packages;
		// 标记用户层资源包来源列表已改；保存时只合并这个顶层字段。
		this.markModified("packages");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 更新项目层的资源包来源列表，输入 packages，无返回；不可信项目会同步抛错，成功先改内存再排队写项目JSON。
	// 例如包可用字符串或带资源筛选的对象表示。await flush 等待完成，再drainErrors检查写入失败；不会顺便解析/执行资源。
	setProjectPackages(packages: PackageSource[]): void {
		// 经统一项目包装先检查信任、克隆项目层，再执行这个只改对应字段的回调。
		this.updateProjectSettings("packages", (settings) => {
			// 只在项目副本中替换资源包来源列表，不把有效合并列表写到用户层。
			settings.packages = packages;
		});
	}

	// 读取本地扩展路径/筛选列表，无输入，返回新的路径数组；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如真正解析并执行扩展发生在 ResourceLoader。
	getExtensionPaths(): string[] {
		// 复制有效扩展路径数组，缺省为空，不在这里加载模块。
		return [...(this.settings.extensions ?? [])];
	}

	// 更新用户层的本地扩展路径/筛选列表，输入 paths 字符串数组，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如真正解析并执行扩展发生在 ResourceLoader。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setExtensionPaths(paths: string[]): void {
		// 更新用户层的本地扩展路径/筛选列表；这里只改内存，后面的save才排队落盘。
		this.globalSettings.extensions = paths;
		// 标记用户层本地扩展路径/筛选列表已改；保存时只合并这个顶层字段。
		this.markModified("extensions");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 更新项目层的本地扩展路径/筛选列表，输入 paths 字符串数组，无返回；不可信项目会同步抛错，成功先改内存再排队写项目JSON。
	// 例如真正解析并执行扩展发生在 ResourceLoader。await flush 等待完成，再drainErrors检查写入失败；不会顺便解析/执行资源。
	setProjectExtensionPaths(paths: string[]): void {
		// 经统一项目包装先检查信任、克隆项目层，再执行这个只改对应字段的回调。
		this.updateProjectSettings("extensions", (settings) => {
			// 只在项目副本中替换本地扩展路径/筛选列表，不把有效合并列表写到用户层。
			settings.extensions = paths;
		});
	}

	// 读取技能路径列表，无输入，返回新的路径数组；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如只在资源重载时扫描技能，不在设置 setter 内读 SKILL.md。
	getSkillPaths(): string[] {
		// 复制有效技能路径数组，发现/读Markdown发生在资源加载器。
		return [...(this.settings.skills ?? [])];
	}

	// 更新用户层的技能路径列表，输入 paths 字符串数组，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如只在资源重载时扫描技能，不在设置 setter 内读 SKILL.md。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setSkillPaths(paths: string[]): void {
		// 更新用户层的技能路径列表；这里只改内存，后面的save才排队落盘。
		this.globalSettings.skills = paths;
		// 标记用户层技能路径列表已改；保存时只合并这个顶层字段。
		this.markModified("skills");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 更新项目层的技能路径列表，输入 paths 字符串数组，无返回；不可信项目会同步抛错，成功先改内存再排队写项目JSON。
	// 例如只在资源重载时扫描技能，不在设置 setter 内读 SKILL.md。await flush 等待完成，再drainErrors检查写入失败；不会顺便解析/执行资源。
	setProjectSkillPaths(paths: string[]): void {
		// 经统一项目包装先检查信任、克隆项目层，再执行这个只改对应字段的回调。
		this.updateProjectSettings("skills", (settings) => {
			// 只在项目副本中替换技能路径列表，不把有效合并列表写到用户层。
			settings.skills = paths;
		});
	}

	// 读取提示词模板路径列表，无输入，返回新的路径数组；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如实际 Markdown 解析和参数替换由模板模块完成。
	getPromptTemplatePaths(): string[] {
		// 复制模板路径列表，不触发正文解析或$1替换。
		return [...(this.settings.prompts ?? [])];
	}

	// 更新用户层的提示词模板路径列表，输入 paths 字符串数组，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如实际 Markdown 解析和参数替换由模板模块完成。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setPromptTemplatePaths(paths: string[]): void {
		// 更新用户层的提示词模板路径列表；这里只改内存，后面的save才排队落盘。
		this.globalSettings.prompts = paths;
		// 标记用户层提示词模板路径列表已改；保存时只合并这个顶层字段。
		this.markModified("prompts");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 更新项目层的提示词模板路径列表，输入 paths 字符串数组，无返回；不可信项目会同步抛错，成功先改内存再排队写项目JSON。
	// 例如实际 Markdown 解析和参数替换由模板模块完成。await flush 等待完成，再drainErrors检查写入失败；不会顺便解析/执行资源。
	setProjectPromptTemplatePaths(paths: string[]): void {
		// 经统一项目包装先检查信任、克隆项目层，再执行这个只改对应字段的回调。
		this.updateProjectSettings("prompts", (settings) => {
			// 只在项目副本中替换提示词模板路径列表，不把有效合并列表写到用户层。
			settings.prompts = paths;
		});
	}

	// 读取主题资源路径列表，无输入，返回新的路径数组；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如主题 JSON 读取/颜色构建发生在资源加载阶段。
	getThemePaths(): string[] {
		// 复制主题路径列表，不读取JSON或改终端色彩。
		return [...(this.settings.themes ?? [])];
	}

	// 更新用户层的主题资源路径列表，输入 paths 字符串数组，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如主题 JSON 读取/颜色构建发生在资源加载阶段。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setThemePaths(paths: string[]): void {
		// 更新用户层的主题资源路径列表；这里只改内存，后面的save才排队落盘。
		this.globalSettings.themes = paths;
		// 标记用户层主题资源路径列表已改；保存时只合并这个顶层字段。
		this.markModified("themes");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 更新项目层的主题资源路径列表，输入 paths 字符串数组，无返回；不可信项目会同步抛错，成功先改内存再排队写项目JSON。
	// 例如主题 JSON 读取/颜色构建发生在资源加载阶段。await flush 等待完成，再drainErrors检查写入失败；不会顺便解析/执行资源。
	setProjectThemePaths(paths: string[]): void {
		// 经统一项目包装先检查信任、克隆项目层，再执行这个只改对应字段的回调。
		this.updateProjectSettings("themes", (settings) => {
			// 只在项目副本中替换主题资源路径列表，不把有效合并列表写到用户层。
			settings.themes = paths;
		});
	}

	// 读取是否注册技能斜杠命令，无输入，返回布尔值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如false 控制 /skill:name 注册偏好，不是删除技能文件。
	getEnableSkillCommands(): boolean {
		// 从有效层读取是否注册技能斜杠命令；??只在缺值时回退，false和0仍保留。
		return this.settings.enableSkillCommands ?? SETTINGS_DEFAULTS.enableSkillCommands;
	}

	// 更新用户层的是否注册技能斜杠命令，输入 enabled 布尔开关，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如false 控制 /skill:name 注册偏好，不是删除技能文件。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setEnableSkillCommands(enabled: boolean): void {
		// 更新用户层的是否注册技能斜杠命令；这里只改内存，后面的save才排队落盘。
		this.globalSettings.enableSkillCommands = enabled;
		// 标记用户层是否注册技能斜杠命令已改；保存时只合并这个顶层字段。
		this.markModified("enableSkillCommands");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取各推理等级的自定义 token 预算，无输入，返回预算对象或undefined；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如minimal/low/medium/high 可分别指定。
	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		// 从有效层读取各推理等级的自定义 token 预算；未配置可保持undefined，这个直接返回不会深复制对象/数组。
		return this.settings.thinkingBudgets;
	}

	// 将有效terminal配置映射成能力覆盖对象，返回新Partial，无输入/I/O，不重新探测终端。
	// 例如images=false映射images:null，auto/缺省不写字段；trueColor/hyperlinks只在真实布尔值时覆盖。
	getTerminalCapabilityOverrides(): Partial<TerminalCapabilities> {
		// 有效终端设置可能缺省，下面只将已识别的显式值转成能力覆盖。
		const terminal = this.settings.terminal;
		// 协议能力选择和showImages显示偏好分开；undefined/auto后面不产生覆盖。
		const images = terminal?.images;
		return {
			// 显式协议名覆盖探测，false变为null禁用图片能力，auto/缺省不写这个字段。
			...(images === "kitty" || images === "iterm2" ? { images } : images === false ? { images: null } : {}),
			// 只有真实布尔值才覆盖真彩色探测，字符串auto不覆盖。
			...(typeof terminal?.trueColor === "boolean" ? { trueColor: terminal.trueColor } : {}),
			// 超链接能力也仅接受显式布尔覆盖，不执行终端探测。
			...(typeof terminal?.hyperlinks === "boolean" ? { hyperlinks: terminal.hyperlinks } : {}),
		};
	}

	// 读取终端是否显示图片，返回有效布尔配置或共享默认，无输入/I/O。
	// 例如false只隐藏终端展示，不等于停止向模型发送图片；后者看blockImages。
	getShowImages(): boolean {
		// 从有效层读取终端能力和显示设置；??只在缺值时回退，false和0仍保留。
		return this.settings.terminal?.showImages ?? SETTINGS_DEFAULTS.terminal.showImages;
	}

	// 保存用户层终端图片展示开关，输入show布尔值，无返回；按terminal.showImages子键标记并排队。
	// 例如设false仍保留trueColor等其他终端设置，项目同名配置可继续优先；flush/drainErrors确认保存。
	setShowImages(show: boolean): void {
		if (!this.globalSettings.terminal) {
			// 用户层还没有终端能力和显示设置对象，先分配空字典以便写子键。
			this.globalSettings.terminal = {};
		}
		// 更新用户层的终端能力和显示设置子键 showImages；这里只改内存，后面的save才排队落盘。
		this.globalSettings.terminal.showImages = show;
		// 标记用户层终端能力和显示设置已改，并精确追踪这个子键，写回时保留其他子项。
		this.markModified("terminal", "showImages");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取终端图片宽度，非法/非有限数回退默认，合法向下取整且至少1，返回数字，无I/O。
	// 例如0或负数读取为1；这里没有设置最大宽度，别与发送给模型图片的像素缩放混淆。
	getImageWidthCells(): number {
		// 终端图片宽度以字符格为单位，区别于模型图片像素尺寸。
		const width = this.settings.terminal?.imageWidthCells;
		// 未设置、非数字、NaN/Infinity都回退默认，防止产生无意义布局。
		if (typeof width !== "number" || !Number.isFinite(width)) {
			// 采用共享终端图片宽度默认。
			return SETTINGS_DEFAULTS.terminal.imageWidthCells;
		}
		// 合法数向下取整并至少1，未设置上限。
		return Math.max(1, Math.floor(width));
	}

	// 更新用户层的终端能力和显示设置，输入 width，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如设为80时只改 imageWidthCells，保留 showImages 等其他子项。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setImageWidthCells(width: number): void {
		if (!this.globalSettings.terminal) {
			// 用户层还没有终端能力和显示设置对象，先分配空字典以便写子键。
			this.globalSettings.terminal = {};
		}
		// 更新用户层的终端能力和显示设置子键 imageWidthCells；这里只改内存，后面的save才排队落盘。
		this.globalSettings.terminal.imageWidthCells = Math.max(1, Math.floor(width));
		// 标记用户层终端能力和显示设置已改，并精确追踪这个子键，写回时保留其他子项。
		this.markModified("terminal", "imageWidthCells");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取输出变短时是否清空余行，优先显式terminal设置→PI_CLEAR_ON_SHRINK=1→默认，无I/O。
	// 例如设置false会覆盖环境变量true；不因false是假值就跳过它。
	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		// 这里只判断是否为undefined，没有运行时布尔校验；正常布尔false也应优先于环境变量。
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			// 原样返回显式配置，不再读取环境回退；若JSON中误写null或字符串，这个分支也不会纠正它。
			return this.settings.terminal.clearOnShrink;
		}
		// 未显式设置才用环境变量1启用，其他文字不作为true。
		if (process.env.PI_CLEAR_ON_SHRINK === "1") return true;
		// 配置和启用环境均缺省则使用共享默认false。
		return SETTINGS_DEFAULTS.terminal.clearOnShrink;
	}

	// 更新用户层的终端能力和显示设置，输入 enabled 布尔开关，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如设为false时只改 clearOnShrink，保留 showImages 等其他子项。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setClearOnShrink(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			// 用户层还没有终端能力和显示设置对象，先分配空字典以便写子键。
			this.globalSettings.terminal = {};
		}
		// 更新用户层的终端能力和显示设置子键 clearOnShrink；这里只改内存，后面的save才排队落盘。
		this.globalSettings.terminal.clearOnShrink = enabled;
		// 标记用户层终端能力和显示设置已改，并精确追踪这个子键，写回时保留其他子项。
		this.markModified("terminal", "clearOnShrink");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取是否输出终端进度提示的有效开关，返回布尔值，缺省采用共享默认，无输入/I/O。
	// 例如true只是偏好，由界面输出OSC进度，而非本getter发控制码。
	getShowTerminalProgress(): boolean {
		// 从有效层读取终端能力和显示设置；??只在缺值时回退，false和0仍保留。
		return this.settings.terminal?.showTerminalProgress ?? SETTINGS_DEFAULTS.terminal.showTerminalProgress;
	}

	// 保存用户层终端进度开关，输入enabled，无返回；只标记terminal.showTerminalProgress子键并排队。
	// 例如开启后不覆盖用户其他终端能力字段，实际显示由界面消费该值。
	setShowTerminalProgress(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			// 用户层还没有终端能力和显示设置对象，先分配空字典以便写子键。
			this.globalSettings.terminal = {};
		}
		// 更新用户层的终端能力和显示设置子键 showTerminalProgress；这里只改内存，后面的save才排队落盘。
		this.globalSettings.terminal.showTerminalProgress = enabled;
		// 标记用户层终端能力和显示设置已改，并精确追踪这个子键，写回时保留其他子项。
		this.markModified("terminal", "showTerminalProgress");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取交互界面模式，无输入，返回签名中的选择值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如regular 与 fullscreen 控制界面布局。
	getTuiMode(): TuiMode {
		// 仅显式regular保留regular，缺省或其他值都回退共享默认模式。
		return this.settings.tuiMode === "regular" ? "regular" : SETTINGS_DEFAULTS.tuiMode;
	}

	// 更新用户层的交互界面模式，输入 mode，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如regular 与 fullscreen 控制界面布局。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setTuiMode(mode: TuiMode): void {
		// 更新用户层的交互界面模式；这里只改内存，后面的save才排队落盘。
		this.globalSettings.tuiMode = mode;
		// 标记用户层交互界面模式已改；保存时只合并这个顶层字段。
		this.markModified("tuiMode");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取全屏退出后留下的输出形式，无输入，返回签名中的选择值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如resume-hint 留恢复提示而非全部 transcript。
	getFullscreenExitOutput(): FullscreenExitOutput {
		// 仅显式resume-hint保留该值；缺省或其他值采用共享默认输出形式。
		return this.settings.fullscreenExitOutput === "resume-hint"
			? "resume-hint"
			: SETTINGS_DEFAULTS.fullscreenExitOutput;
	}

	// 更新用户层的全屏退出后留下的输出形式，输入 output，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如resume-hint 留恢复提示而非全部 transcript。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setFullscreenExitOutput(output: FullscreenExitOutput): void {
		// 更新用户层的全屏退出后留下的输出形式；这里只改内存，后面的save才排队落盘。
		this.globalSettings.fullscreenExitOutput = output;
		// 标记用户层全屏退出后留下的输出形式已改；保存时只合并这个顶层字段。
		this.markModified("fullscreenExitOutput");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取全屏滚动条显示方式，无输入，返回签名中的选择值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如always/hidden 之外回退 auto 默认。
	getFullscreenScrollbar(): ScrollViewScrollbar {
		// 滚动条模式从有效设置取，下面允许值之外回退auto。
		const mode = this.settings.fullscreenScrollbar;
		// always/hidden为显式模式，auto及其他值采用默认auto。
		return mode === "always" || mode === "hidden" ? mode : SETTINGS_DEFAULTS.fullscreenScrollbar;
	}

	// 更新用户层的全屏滚动条显示方式，输入 mode，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如always/hidden 之外回退 auto 默认。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setFullscreenScrollbar(mode: ScrollViewScrollbar): void {
		// 更新用户层的全屏滚动条显示方式；这里只改内存，后面的save才排队落盘。
		this.globalSettings.fullscreenScrollbar = mode;
		// 标记用户层全屏滚动条显示方式已改；保存时只合并这个顶层字段。
		this.markModified("fullscreenScrollbar");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取全屏选中文本时是否复制，无输入，返回布尔值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如保存选择偏好，不在这里访问系统剪贴板。
	getFullscreenCopyOnSelect(): boolean {
		// 从有效层读取全屏选中文本时是否复制；??只在缺值时回退，false和0仍保留。
		return this.settings.fullscreenCopyOnSelect ?? SETTINGS_DEFAULTS.fullscreenCopyOnSelect;
	}

	// 更新用户层的全屏选中文本时是否复制，输入 enabled 布尔开关，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如保存选择偏好，不在这里访问系统剪贴板。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setFullscreenCopyOnSelect(enabled: boolean): void {
		// 更新用户层的全屏选中文本时是否复制；这里只改内存，后面的save才排队落盘。
		this.globalSettings.fullscreenCopyOnSelect = enabled;
		// 标记用户层全屏选中文本时是否复制已改；保存时只合并这个顶层字段。
		this.markModified("fullscreenCopyOnSelect");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取全屏滚轮行数，有限数字向下取整并夹到1至100，其余回退默认auto，无I/O。
	// 例如200读成100，auto保留默认自动行为；不实际滚动终端。
	getFullscreenWheelScrollLines(): WheelScrollLines {
		// 滚轮行数允许数字或auto，外部值还需检查有限性。
		const lines = this.settings.fullscreenWheelScrollLines;
		// 只有有限数字进入手动行数分支，auto/缺值/非法值走默认。
		return typeof lines === "number" && Number.isFinite(lines)
			? // 先向下取整，再夹到1至100。
				Math.max(1, Math.min(100, Math.floor(lines)))
			: // 非数值选择回退共享默认auto。
				SETTINGS_DEFAULTS.fullscreenWheelScrollLines;
	}

	// 更新用户层的全屏滚轮每次滚动行数，输入 lines，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如数值限制到1至100，auto 保持自动模式。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setFullscreenWheelScrollLines(lines: WheelScrollLines): void {
		// 此赋值的右侧在下一行选择auto或限制后的数值。
		this.globalSettings.fullscreenWheelScrollLines =
			// 显式auto原样保存，数值转换成1至100整数。
			lines === "auto" ? lines : Math.max(1, Math.min(100, Math.floor(lines)));
		// 标记用户层全屏滚轮每次滚动行数已改；保存时只合并这个顶层字段。
		this.markModified("fullscreenWheelScrollLines");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取发给模型前是否自动缩放图片的有效开关，返回布尔值，缺省共享默认，无输入/I/O。
	// 例如关闭后本getter不自行处理像素，图片处理层以后按此偏好决定。
	getImageAutoResize(): boolean {
		// 从有效层读取发送给模型的图片处理配置；??只在缺值时回退，false和0仍保留。
		return this.settings.images?.autoResize ?? SETTINGS_DEFAULTS.images.autoResize;
	}

	// 更新用户images.autoResize开关，输入enabled，无返回；初始化对象、标记该子键并排队保存。
	// 例如false不改images.blockImages，两者分别控制缩放与完全不发送图片。
	setImageAutoResize(enabled: boolean): void {
		if (!this.globalSettings.images) {
			// 用户层还没有发送给模型的图片处理配置对象，先分配空字典以便写子键。
			this.globalSettings.images = {};
		}
		// 更新用户层的发送给模型的图片处理配置子键 autoResize；这里只改内存，后面的save才排队落盘。
		this.globalSettings.images.autoResize = enabled;
		// 标记用户层发送给模型的图片处理配置已改，并精确追踪这个子键，写回时保留其他子项。
		this.markModified("images", "autoResize");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取是否阻止向模型发送图片的有效开关，返回布尔值，缺省共享默认，无输入/I/O。
	// 例如true与终端showImages无关，后面的模型上下文转换负责执行这个偏好。
	getBlockImages(): boolean {
		// 从有效层读取发送给模型的图片处理配置；??只在缺值时回退，false和0仍保留。
		return this.settings.images?.blockImages ?? SETTINGS_DEFAULTS.images.blockImages;
	}

	// 更新用户images.blockImages，输入blocked布尔值，无返回；标记此子键、立即合并并排队。
	// 例如true只保存阻止图片的偏好，不在setter里删除历史图片或修改文件。
	setBlockImages(blocked: boolean): void {
		if (!this.globalSettings.images) {
			// 用户层还没有发送给模型的图片处理配置对象，先分配空字典以便写子键。
			this.globalSettings.images = {};
		}
		// 更新用户层的发送给模型的图片处理配置子键 blockImages；这里只改内存，后面的save才排队落盘。
		this.globalSettings.images.blockImages = blocked;
		// 标记用户层发送给模型的图片处理配置已改，并精确追踪这个子键，写回时保留其他子项。
		this.markModified("images", "blockImages");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取模型轮换候选匹配模式，无输入，返回字符串数组或undefined；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如保存模型名模式，不在这里请求模型目录。
	getEnabledModels(): string[] | undefined {
		// 从有效层读取模型轮换候选匹配模式；未配置可保持undefined，这个直接返回不会深复制对象/数组。
		return this.settings.enabledModels;
	}

	/** The resolved `defaultTools` selection, or undefined when no settings layer sets it. */
	// 把有效defaultTools规范成启动工具名字数组，未设置返回undefined，无I/O。
	// 先在未验证配置边界仅保留字符串，再处理普通名替换与+/-增删；例如[]明确选零工具，不等于缺省。
	getDefaultTools(): string[] | undefined {
		// 读取各层已合并、尚未最终执行增删的工具选择列表。
		const tools = this.settings.defaultTools;
		// 未配置与明确空数组不同，undefined让上层使用默认选择。
		if (tools === undefined) return undefined;
		// 外部JSON未完整验证，先只保留字符串；非法非数组视为空选择，再按普通名/修饰符解释。
		return resolveDefaultTools(Array.isArray(tools) ? tools.filter((tool) => typeof tool === "string") : []);
	}

	// 更新用户层的模型轮换候选匹配模式，输入 patterns，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如保存模型名模式，不在这里请求模型目录。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setEnabledModels(patterns: string[] | undefined): void {
		// 更新用户层的模型轮换候选匹配模式；这里只改内存，后面的save才排队落盘。
		this.globalSettings.enabledModels = patterns;
		// 标记用户层模型轮换候选匹配模式已改；保存时只合并这个顶层字段。
		this.markModified("enabledModels");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取空编辑器双 Escape 行为，无输入，返回签名中的选择值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如fork/tree/none 决定上层响应。
	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		// 从有效层读取空编辑器双 Escape 行为；??只在缺值时回退，false和0仍保留。
		return this.settings.doubleEscapeAction ?? SETTINGS_DEFAULTS.doubleEscapeAction;
	}

	// 更新用户层的空编辑器双 Escape 行为，输入 action，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如fork/tree/none 决定上层响应。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		// 更新用户层的空编辑器双 Escape 行为；这里只改内存，后面的save才排队落盘。
		this.globalSettings.doubleEscapeAction = action;
		// 标记用户层空编辑器双 Escape 行为已改；保存时只合并这个顶层字段。
		this.markModified("doubleEscapeAction");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取会话树默认筛选模式，无输入，返回签名中的选择值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如user-only 只展示用户类条目的视图偏好。
	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		// 读取会话树视图筛选偏好，后面按允许集合验证文字。
		const mode = this.settings.treeFilterMode;
		// 此getter实际允许的五个模式，不凭任意字符串创建新筛选行为。
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		// 必须非空且在允许集合中，否则回退共享默认。
		return mode && valid.includes(mode) ? mode : SETTINGS_DEFAULTS.treeFilterMode;
	}

	// 更新用户层的会话树默认筛选模式，输入 mode，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如user-only 只展示用户类条目的视图偏好。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		// 更新用户层的会话树默认筛选模式；这里只改内存，后面的save才排队落盘。
		this.globalSettings.treeFilterMode = mode;
		// 标记用户层会话树默认筛选模式已改；保存时只合并这个顶层字段。
		this.markModified("treeFilterMode");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取硬件光标显示偏好，显式有效设置优先，否则看PI_HARDWARE_CURSOR是否为1，返回布尔值，无I/O。
	// 例如配置false覆盖环境启用；这里只决定偏好，不在这里发送终端控制码。
	getShowHardwareCursor(): boolean {
		// 从有效层读取是否显示终端硬件光标；??只在缺值时回退，false和0仍保留。
		return this.settings.showHardwareCursor ?? process.env.PI_HARDWARE_CURSOR === "1";
	}

	// 更新用户层的是否显示终端硬件光标，输入 enabled 布尔开关，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如未设置时可由 PI_HARDWARE_CURSOR=1 启用。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setShowHardwareCursor(enabled: boolean): void {
		// 更新用户层的是否显示终端硬件光标；这里只改内存，后面的save才排队落盘。
		this.globalSettings.showHardwareCursor = enabled;
		// 标记用户层是否显示终端硬件光标已改；保存时只合并这个顶层字段。
		this.markModified("showHardwareCursor");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取输入编辑器水平留白，无输入，返回数字；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如数值写入前限制到0至3的整数。
	getEditorPaddingX(): number {
		// 从有效层读取输入编辑器水平留白；??只在缺值时回退，false和0仍保留。
		return this.settings.editorPaddingX ?? SETTINGS_DEFAULTS.editorPaddingX;
	}

	// 更新用户层的输入编辑器水平留白，输入 padding，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如数值写入前限制到0至3的整数。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setEditorPaddingX(padding: number): void {
		// 更新用户层的输入编辑器水平留白；这里只改内存，后面的save才排队落盘。
		this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		// 标记用户层输入编辑器水平留白已改；保存时只合并这个顶层字段。
		this.markModified("editorPaddingX");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取对话输出水平留白，无输入，返回签名中的选择值；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如只接受0或1的类型选择。
	getOutputPad(): 0 | 1 {
		// 仅数字0保留0；缺省或其他值采用共享默认留白1，不会返回undefined。
		return this.settings.outputPad === 0 ? 0 : SETTINGS_DEFAULTS.outputPad;
	}

	// 更新用户层的对话输出水平留白，输入 padding，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如只接受0或1的类型选择。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setOutputPad(padding: 0 | 1): void {
		// 更新用户层的对话输出水平留白；这里只改内存，后面的save才排队落盘。
		this.globalSettings.outputPad = padding;
		// 标记用户层对话输出水平留白已改；保存时只合并这个顶层字段。
		this.markModified("outputPad");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取补全弹出框最大可见项数，无输入，返回数字；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如写入前限制为3至20的整数。
	getAutocompleteMaxVisible(): number {
		// 从有效层读取补全弹出框最大可见项数；??只在缺值时回退，false和0仍保留。
		return this.settings.autocompleteMaxVisible ?? SETTINGS_DEFAULTS.autocompleteMaxVisible;
	}

	// 更新用户层的补全弹出框最大可见项数，输入 maxVisible，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如写入前限制为3至20的整数。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setAutocompleteMaxVisible(maxVisible: number): void {
		// 更新用户层的补全弹出框最大可见项数；这里只改内存，后面的save才排队落盘。
		this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		// 标记用户层补全弹出框最大可见项数已改；保存时只合并这个顶层字段。
		this.markModified("autocompleteMaxVisible");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取Markdown代码块缩进文字，返回字符串，缺省共享默认，无输入/I/O。
	// 例如默认两空格由SETTINGS_DEFAULTS统一提供，不在这里格式化实际代码。
	getCodeBlockIndent(): string {
		// 从有效层读取Markdown 渲染设置；??只在缺值时回退，false和0仍保留。
		return this.settings.markdown?.codeBlockIndent ?? SETTINGS_DEFAULTS.markdown.codeBlockIndent;
	}

	// 读取Mermaid渲染策略，返回off/final/默认streaming，无输入/I/O。
	// 例如final表示完成后渲染偏好，不代表图语法经过校验或保证能成功渲染。
	getMermaidRenderingMode(): MermaidRenderingMode {
		// Mermaid显示模式与图语法是否合法是不同问题，这里只读渲染策略。
		const mode = this.settings.markdown?.mermaid;
		// off/final保留显式值，streaming或缺省/非法值采用默认streaming。
		return mode === "off" || mode === "final" ? mode : SETTINGS_DEFAULTS.markdown.mermaid;
	}

	// 保存用户Markdown的mermaid策略，输入mode，无返回；??=初始化字典、标记子键并排队。
	// 例如final不覆盖codeBlockIndent，真正渲染图形由Markdown层完成。
	setMermaidRenderingMode(mode: MermaidRenderingMode): void {
		// ??=只在null/undefined时初始化字典，方便写mermaid子键。
		this.globalSettings.markdown ??= {};
		// 更新用户层的Markdown 渲染设置子键 mermaid；这里只改内存，后面的save才排队落盘。
		this.globalSettings.markdown.mermaid = mode;
		// 标记用户层Markdown 渲染设置已改，并精确追踪这个子键，写回时保留其他子项。
		this.markModified("markdown", "mermaid");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}

	// 读取分类警告开关字典，无输入，返回新的警告字典；从当前有效合并层取值，不在此启动对应功能或写存储。
	// 例如单项缺省时可由具体警告消费方决定默认显示。
	getWarnings(): WarningSettings {
		// 复制警告开关字典；缺省空对象，不自动补全每一种警告默认值。
		return { ...(this.settings.warnings ?? {}) };
	}

	// 更新用户层的分类警告开关字典，输入 warnings，无返回；标记修改并调用save，立即重建有效视图、稍后排队保存。
	// 例如单项缺省时可由具体警告消费方决定默认显示。可信项目同名设置仍可能覆盖此全局值；保存失败进入错误队列，需flush/drainErrors检查。
	setWarnings(warnings: WarningSettings): void {
		// 更新用户层的分类警告开关字典；这里只改内存，后面的save才排队落盘。
		this.globalSettings.warnings = { ...warnings };
		// 标记用户层分类警告开关字典已改；保存时只合并这个顶层字段。
		this.markModified("warnings");
		// 立即重新合并用户/可信项目层，并捕获当前修改快照排入写队列；此行返回不表示磁盘已保存成功。
		this.save();
	}
}
