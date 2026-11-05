/**
 * 资源启停配置面板：CLI 先解析 global/project 两套资源快照，本文件把它们按来源分组，提供搜索、导航和范围切换。
 * 全局模式写用户层精确 +/- 规则，项目模式在继承/强制加载/强制不加载间循环；修改经 SettingsManager 更新内存并排队保存。
 * 例内置 mcp 全局禁用写 -builtin:mcp，项目再次显式加载写 +builtin:mcp；不删除包/文件，也不在此执行扩展或重载当前运行资源。
 * 界面 enabled、初始全局继承基线与实际重新解析后的结果要区分；取消只关闭，不回滚，保存完成/错误也未在本组件等待或展示。
 */
/**
 * TUI component for managing package resources (enable/disable)
 */

// 路径函数只算文件名/父目录/相对路径，不因 import 就扫描资源；后面的比较/配置表达式使用当前平台路径规则。
import { basename, dirname, join, relative } from "node:path";
// TUI 提供布局、输入、键位和显示列宽工具；type 标记的接口只参与 TS 检查，运行时擦除。
import {
	// Component 约定 render/invalidate 等方法，不自动赋予组件绘制能力。
	type Component,
	// Container 按子组件顺序组合输出，不自动把键盘事件发给子组件。
	Container,
	// Focusable 要求 focused 字段，供宿主传递焦点变化。
	type Focusable,
	// 读取当前可配置键位，而不是把所有动作绑定为固定按键。
	getKeybindings,
	// Input 管理搜索文字、编辑光标和粘贴状态。
	Input,
	// matchesKey 用于本文件保留的固定 Ctrl+C 退出判断。
	matchesKey,
	// Spacer 返回指定行数的空白。
	Spacer,
	// 按终端显示列截断，ANSI 颜色码不等于可见字符宽度。
	truncateToWidth,
	// visibleWidth 计算文字显示列数，和字符串的 UTF-16 length 不同。
	visibleWidth,
} from "@earendil-works/pi-tui";
// 统一的项目配置目录名，例如 .pi，来自部署兼容的配置模块。
import { CONFIG_DIR_NAME } from "../../../config.ts";
// 包管理器先解析出路径/开关/来源；import type 不在这里执行包解析或安装。
import type { PathMetadata, ResolvedPaths, ResolvedResource } from "../../../core/package-manager.ts";
// 包来源的字符串/对象联合和设置管理器仅作类型；具体实例由 CLI 传入。
import type { PackageSource, SettingsManager } from "../../../core/settings-manager.ts";
// builtin: 是合成标识；路径键帮助把真实路径按 realpath/平台大小写规则比较，不是授权检查。
import { BUILTIN_PATH_PREFIX, getResourcePathKey } from "../../../core/source-info.ts";
// 本地来源分类、路径绝对化与主目录显示缩写，职责不同，后面分别使用。
import { isLocalPath, resolvePath, shortenHomePath } from "../../../utils/paths.ts";
// 共享主题对象负责颜色样式，组件 render 时读取，不自行保存主题文件。
import { theme } from "../theme/theme.ts";
// 动态边框按当前主题输出，不由本文件写终端控制序列。
import { DynamicBorder } from "./dynamic-border.ts";
// keyHint 显示可配置动作键，rawKeyHint 显示传入的说明文字，后者不注册键位。
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

// 字符串字面量联合只允许四种资源键；它们也是设置对象中的数组字段名。
type ResourceType = "extensions" | "skills" | "prompts" | "themes";
// UI 的写入模式叫 global/project，不等同来源元数据中的 user/project。
type ConfigWriteScope = "global" | "project";
// 设置来源范围使用 user/project；临时来源在 getItemScope 中按 user 处理，并非新增 temporary 文件层。
type SettingsScope = "user" | "project";
// 项目覆盖三态：inherit 不指定、load 强制加载、unload 强制不加载；不是三个不同的资源文件。
type ProjectOverrideState = "inherit" | "load" | "unload";
// Record 映射要求 global 和 project 两套解析快照都存在；export type 不生成运行对象。
export type ScopedResolvedPaths = Record<ConfigWriteScope, ResolvedPaths>;

// as const 保留只读字面元组；satisfies 检查每项属于 ResourceType，二者都不执行冻结或运行验证。
const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const satisfies readonly ResourceType[];

// 为每一种资源类型提供英文标题，Record 要求四个键齐全；中文注释不会变成界面标签。
const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
	// 扩展分组的英文显示名。
	extensions: "Extensions",
	// 技能分组的英文显示名。
	skills: "Skills",
	// 提示词模板分组的英文显示名。
	prompts: "Prompts",
	// 主题分组的英文显示名。
	themes: "Themes",
};

// 资源行的 UI 数据，与包管理器资源对象分开建壳；metadata 仍引用传入的来源对象。
interface ResourceItem {
	// 实际资源路径或 builtin: 合成标识，不总是磁盘文件。
	path: string;
	// 当前行显示的有效启用值，切换后在本界面内更新，不证明运行时已经重载。
	enabled: boolean;
	// 来源包括 scope/origin/source 和可选 baseDir，供分组及生成保存模式使用。
	metadata: PathMetadata;
	// 四类资源之一，决定写哪个设置数组。
	resourceType: ResourceType;
	// 用于显示和搜索的名字，不总是 basename，例如技能显示父目录名。
	displayName: string;
	// 归属主组的拼接键，此字段在构建时保留，不是资源唯一身份的安全编码。
	groupKey: string;
	// 主组键再拼资源类型，表示归属子组；实际分组仍依对象结构遍历。
	subgroupKey: string;
}

// 同一来源组中的一类资源，例如某包的 Skills 子组。
interface ResourceSubgroup {
	// 子组的资源类型标签。
	type: ResourceType;
	// 英文子组标题。
	label: string;
	// 可变资源行数组，排序/切换会修改本次 UI 对象。
	items: ResourceItem[];
}

// 按来源形式、范围、source 和 baseDir 聚合的主组，内含四类子组。
interface ResourceGroup {
	// Map 分组键，不是磁盘目录名。
	key: string;
	// 展示标题，可能含包来源、范围或目录缩写。
	label: string;
	// 来源可为临时，但这不表示存在独立 temporary 设置文件。
	scope: "user" | "project" | "temporary";
	// package 表示包内资源，top-level 表示顶层路径/自动发现/内置资源。
	origin: "package" | "top-level";
	// 来源说明，例如 npm:pi-tools、auto、builtin 或 local。
	source: string;
	// 可变子组列表，稍后按固定资源类型顺序排列。
	subgroups: ResourceSubgroup[];
}

// formatBaseDir 把目录改成适合显示的“缩短主目录、统一斜线、末尾带 /”文字；输入路径、输出新字符串，无文件写入。例如主目录下 skills 目录可显示 ~/skills/。
function formatBaseDir(baseDir: string): string {
	// 先把主目录前缀缩为 ~，再用全局正则把每个反斜线变 /；只改变显示文字。
	const displayPath = shortenHomePath(baseDir).replace(/\\/g, "/");
	// 已有结尾 / 就保留，否则用模板插值追加；三元表达式只计算选中的分支。
	return displayPath.endsWith("/") ? displayPath : `${displayPath}/`;
}

// getGroupLabel 按包/内置/自动发现/显式设置分支返回标题，输入来源和用户配置目录，无保存副作用。例如 npm:x 的 user 组显示 npm:x (user)。
function getGroupLabel(metadata: PathMetadata, agentDir: string): string {
	// origin 优先于 source：包资源直接走包标题，不落入后面顶层来源分支。
	if (metadata.origin === "package") {
		// 把来源字符串与范围插入显示文字，不解析或验证 npm/git 语法。
		return `${metadata.source} (${metadata.scope})`;
	}
	// 非包资源且 source 恰好为 builtin 时使用专门标签。
	if (metadata.source === "builtin") {
		// user 显示普通内置标题，其他范围显示项目覆盖标题；此三元本身没有检查项目是否可信。
		return metadata.scope === "user" ? "Built-in" : "Built-in (project override)";
	}
	// Top-level resources
	// auto 表示自动发现来源，标题尽可能展示真实基准目录。
	if (metadata.source === "auto") {
		// baseDir 存在且为真值才使用；空字符串也会走下面兜底。
		if (metadata.baseDir) {
			// 按 user 与其他范围选择显示格式，不因此改变资源的实际来源。
			return metadata.scope === "user"
				? // 用户来源将给定 baseDir 格式化后展示。
					`User (${formatBaseDir(metadata.baseDir)})`
				: // 其他范围用 Project 标题，同样只生成字符串。
					`Project (${formatBaseDir(metadata.baseDir)})`;
		}
		// 缺 baseDir 时，user 用传入 agentDir，其他用配置目录名；这不是重新计算资源路径。
		return metadata.scope === "user" ? `User (${formatBaseDir(agentDir)})` : `Project (${CONFIG_DIR_NAME}/)`;
	}
	// 剩余顶层来源统一显示用户/项目设置标题，不把 source 原字符串展示出来。
	return metadata.scope === "user" ? "User settings" : "Project settings";
}

// buildGroups 将一套解析快照转为可排序 UI 组，输入 resolved/agentDir、输出新主组数组；不安装、扫描或执行资源，metadata 保留原引用。
// 流程是依次加入四类→按来源分组→整理显示名→排序。例如 /pkg/skills/search/SKILL.md 显示 search，包的扩展/技能仍在同一主组下。
function buildGroups(resolved: ResolvedPaths, agentDir: string): ResourceGroup[] {
	// 泛型 Map 指定字符串键与 ResourceGroup 值；每次调用新建独立分组表。
	const groupMap = new Map<string, ResourceGroup>();

	// addToGroup 闭包为一类资源逐项建行，捕获 groupMap/agentDir，返回 void 并修改当前 UI 分组；例如把全部 skills 加到已有包组。这里不复制资源正文。
	const addToGroup = (resources: ResolvedResource[], resourceType: ResourceType) => {
		// for...of 遍历传入的已解析数组，保留每个资源当前 enabled 值。
		for (const res of resources) {
			// 对象解构取路径、启用状态和来源，不修改原资源对象。
			const { path, enabled, metadata } = res;
			// 四个来源维度拼组键，baseDir 缺省用空串；分隔符不做转义，不把此键当安全或全局唯一编码。
			const groupKey = `${metadata.origin}:${metadata.scope}:${metadata.source}:${metadata.baseDir ?? ""}`;

			// 同键尚无主组才创建，后续同来源资源复用它。
			if (!groupMap.has(groupKey)) {
				// set 将新主组保存到 Map，字段在后续行逐个初始化。
				groupMap.set(groupKey, {
					// 属性 key 存分组键。
					key: groupKey,
					// 标题按实际来源分支生成。
					label: getGroupLabel(metadata, agentDir),
					// 保存来源范围，不改写成当前 UI 写入模式。
					scope: metadata.scope,
					// 保留 package/top-level 来源形式。
					origin: metadata.origin,
					// 保留原 source 说明。
					source: metadata.source,
					// 子组初始为空，遇到每类首个资源时才创建。
					subgroups: [],
				});
			}

			// ! 是 TS 非空断言，基于刚才已创建/已存在的组，不增加运行时查错逻辑。
			const group = groupMap.get(groupKey)!;
			// 子组键追加当前资源类型；主组可包含多个资源类型。
			const subgroupKey = `${groupKey}:${resourceType}`;

			// find 按类型找首个子组，找到即复用；let 允许缺失时换成新对象。
			let subgroup = group.subgroups.find((sg) => sg.type === resourceType);
			// 没找到该类子组才进入创建分支。
			if (!subgroup) {
				// 新子组对象先存入局部变量。
				subgroup = {
					// 类型标签与当前资源类型一致。
					type: resourceType,
					// 通过字典索引取得英文分类标题。
					label: RESOURCE_TYPE_LABELS[resourceType],
					// 资源行数组从空开始。
					items: [],
				};
				// 把新子组接到主组列表，后续资源就能 find 到。
				group.subgroups.push(subgroup);
			}

			// basename 提取最后一段文件名，仅字符串路径运算。
			const fileName = basename(path);
			// dirname 得父路径，basename 再取其末段，例如 search/SKILL.md 的父名是 search。
			const parentFolder = basename(dirname(path));
			// 声明稍后各分支都会赋值的 string，TS 检查类型，不生成默认字符串。
			let displayName: string;
			// 内置资源按 source 判断，不额外验证 path 是否真的带前缀。
			if (metadata.source === "builtin") {
				// 从前缀长度处截后缀，例如 builtin:mcp 显示 mcp；slice 不检查被截掉的内容。
				displayName = path.slice(BUILTIN_PATH_PREFIX.length);
				// 扩展若不是直接放在名为 extensions 的目录下，显示上一层目录帮助区分。
			} else if (resourceType === "extensions" && parentFolder !== "extensions") {
				// 用 父目录/文件名 展示扩展，例如 search/index.ts。
				displayName = `${parentFolder}/${fileName}`;
				// 技能的标准文件名恰为 SKILL.md 时显示其父目录名，大小写比较是严格相等。
			} else if (resourceType === "skills" && fileName === "SKILL.md") {
				// 把技能目录名当显示名，不读取文件内的 name 字段。
				displayName = parentFolder;
			} else {
				// 其他文件只显示最后一段名字。
				displayName = fileName;
			}
			// 把新资源行加入当前子组；后面的简写属性等价于同名 key:value。
			subgroup.items.push({
				// 路径值用于后续生成配置模式和搜索。
				path,
				// 保存解析时启用快照。
				enabled,
				// metadata 为来源对象引用，本函数没有深克隆它。
				metadata,
				// 保存资源类型。
				resourceType,
				// 保存刚算出的显示名。
				displayName,
				// 记录所属主组键。
				groupKey,
				// 记录所属子组键。
				subgroupKey,
			});
		}
	};

	// 先收扩展数组，缺少这些必需数组属于不满足类型契约的输入，不在这里兜底。
	addToGroup(resolved.extensions, "extensions");
	// 再收技能，主组仍复用同一 Map。
	addToGroup(resolved.skills, "skills");
	// 再收提示词模板。
	addToGroup(resolved.prompts, "prompts");
	// 最后收主题；最终顺序还会单独排序。
	addToGroup(resolved.themes, "themes");

	// Sort groups: packages first, then top-level; user before project
	// Array.from 将 Map 值转成新数组，接下来 sort 只改变这个数组及本次新组。
	const groups = Array.from(groupMap.values());
	// sort 比较器返回负/正数决定前后，原地改 groups。
	groups.sort((a, b) => {
		// 不同来源形式先排包和顶层。
		if (a.origin !== b.origin) {
			// a 是 package 就放前，否则放后。
			return a.origin === "package" ? -1 : 1;
		}
		// 同形式、不同范围时优先 user；对 project/temporary 两个非 user 的组合不构成对称完整排序，别从英文规则推额外保证。
		if (a.scope !== b.scope) {
			// 仅 a 为 user 时返回负数，否则正数；正常用户/项目输入下是用户在前。
			return a.scope === "user" ? -1 : 1;
		}
		// 形式/范围相同按来源字符串的本地化比较顺序排，不按文件修改时间。
		return a.source.localeCompare(b.source);
	});

	// Sort subgroups within each group by type order, and items by name
	// Record 将四种分类映到排序权重，数字越小越靠前。
	const typeOrder: Record<ResourceType, number> = { extensions: 0, skills: 1, prompts: 2, themes: 3 };
	// 逐组整理其子组与资源行，修改的是本次构建的 UI 数组。
	for (const group of groups) {
		// 用分类权重差按 extensions→skills→prompts→themes 排。
		group.subgroups.sort((a, b) => typeOrder[a.type] - typeOrder[b.type]);
		// 每个子组再独立排它的资源行。
		for (const subgroup of group.subgroups) {
			// 按 displayName 的 localeCompare 排序，不按完整路径或 enabled 状态排。
			subgroup.items.sort((a, b) => a.displayName.localeCompare(b.displayName));
		}
	}

	// 返回排好序的组数组，供 ResourceList 扁平化显示。
	return groups;
}

// 标签联合表示列表里三种不同行；检查 type 后 TS 才允许访问该分支的 item/group/subgroup 字段。
type FlatEntry =
	// 主组标题行带主组对象，不可作为资源切换。
	| { type: "group"; group: ResourceGroup }
	// 子组标题还带父组，项目模式据此渲染继承样式。
	| { type: "subgroup"; subgroup: ResourceSubgroup; group: ResourceGroup }
	// 真实资源行才有 item，对应导航和启停操作。
	| { type: "item"; item: ResourceItem };

// ConfigSelectorHeader 只生成两行标题/操作说明；implements 只是编译期契约，不自动接收键盘输入。
class ConfigSelectorHeader implements Component {
	// private 仅限制 TS 代码访问，当前写入模式会随 Tab 切换。
	private writeScope: ConfigWriteScope;
	// 是否显示模式切换提示的构造快照，不在此探测项目信任。
	private projectModeAvailable: boolean;

	// 构造标题组件，输入模式与切换能力，无文件操作；例如 project 模式显示 Project Local Resources，实际保存不由标题负责。
	constructor(writeScope: ConfigWriteScope, projectModeAvailable: boolean) {
		// 保存初始模式。
		this.writeScope = writeScope;
		// 保存是否可切换的布尔值，后续 render 直接读取。
		this.projectModeAvailable = projectModeAvailable;
	}

	// setWriteScope 只替换标题模式，返回 void；例如切到 project 后下一次 render 改标题，不主动请求重绘或保存。
	setWriteScope(writeScope: ConfigWriteScope): void {
		// 更新实例字段，不改变 ResourceList，外层会分别通知两者。
		this.writeScope = writeScope;
	}

	// invalidate 无缓存需要清理，空实现满足 Component；调用不会自行重画。
	invalidate(): void {}

	// render 接终端列宽、返回两行带主题样式的字符串，不写终端；流程为拼标题/提示→算间隔→截断。例如窄屏会截断提示，并不自动换行。
	render(width: number): string[] {
		// 模式决定标题英文，再套粗体样式。
		const title = theme.bold(this.writeScope === "project" ? "Project Local Resources" : "Global Resources");
		// 分隔符是带 muted 颜色的中点，两边空格用于分隔操作提示。
		const sep = theme.fg("muted", " · ");
		// 允许切换才展示实际配置的 Tab 动作键提示；否则空字符串。
		const switchHint = this.projectModeAvailable ? keyHint("tui.input.tab", "switch mode") + sep : "";
		// 根据模式生成空格操作说明，赋值表达式在下一行继续。
		const actionHint =
			// 项目为继承/+/-循环，全局为二态切换；rawKeyHint 仅显示提示，不实现按键逻辑。
			this.writeScope === "project" ? rawKeyHint("space", "cycle inherit/+/-") : rawKeyHint("space", "toggle");
		// 拼切换、操作和关闭提示，esc 这里是固定展示文字，实际取消仍由键位管理器判断。
		const hint = switchHint + actionHint + sep + rawKeyHint("esc", "close");
		// 去除 ANSI 影响后算标题/提示间空格，最少一个；宽度不足仍交后面截断。
		const spacing = Math.max(1, width - visibleWidth(title) - visibleWidth(hint));
		// 第二行是配置位置/继承说明，表达式跨行不是多条赋值。
		const scopeHint =
			// 三元按模式选择说明文字。
			this.writeScope === "project"
				? // 项目显示配置目录的 settings.json，并提醒全局继承项变暗。
					theme.fg("muted", `${CONFIG_DIR_NAME}/settings.json · inherited global resources are dimmed`)
				: // 全局显示默认 ~/.pi/agent 风格文字；这里未插入实际 agentDir，定制配置目录时不能把此提示当精确落盘路径。
					theme.fg("muted", `~/${CONFIG_DIR_NAME}/agent/settings.json`);

		// 数组包含两行，不是已写出的终端内容。
		return [
			// 拼左右内容并按显示列截断，空尾标记表示不追加省略号。
			truncateToWidth(`${title}${" ".repeat(spacing)}${hint}`, width, ""),
			// 配置说明也截到同一宽度。
			truncateToWidth(scopeHint, width, ""),
		];
	}
}

// ResourceList 管理分组/筛选/导航/启停；同时实现 Component 和 Focusable，焦点 setter 再传给搜索 Input。
class ResourceList implements Component, Focusable {
	// Record 保留两套 UI 组，切模式只换读取哪套，不重新解析资源。
	private groupsByScope: Record<ConfigWriteScope, ResourceGroup[]>;
	// 全部标题/资源按树遍历顺序摊平的可变行数组。
	private flatItems: FlatEntry[] = [];
	// 当前搜索结果行数组，包含匹配资源的父标题。
	private filteredItems: FlatEntry[] = [];
	// 选中的是扁平数组下标，标题占行但普通上下移动会跳过它们。
	private selectedIndex = 0;
	// 搜索输入组件保存文字和光标。
	private searchInput: Input;
	// 最多显示的扁平内容行数，构造后不随终端高度自动更新。
	private maxVisible: number;
	// 传入设置管理器负责内存更新/排队保存，本组件不直接写 JSON。
	private settingsManager: SettingsManager;
	// 项目目录用于相对路径基准，不等同 agentDir。
	private cwd: string;
	// 用户设置目录，用于用户层相对路径。
	private agentDir: string;
	// 当前写入模式，是选择设置层而非改变文件来源。
	private writeScope: ConfigWriteScope;
	// 按类型+资源路径键保存构造时全局 enabled，后续切换不更新此继承基线。
	private inheritedEnabledByKey: Map<string, boolean>;

	// 可选取消回调，?. 调用时未配置就忽略；通常由宿主关闭界面。
	public onCancel?: () => void;
	// 可选退出回调，区别于普通关闭；组件不直接 process.exit。
	public onExit?: () => void;
	// 切换成功路径通知资源/新 enabled；void 回调不会被 await，错误也不在此吞掉。
	public onToggle?: (item: ResourceItem, newEnabled: boolean) => void;
	// 可选模式切换回调，外层只有允许项目模式时安装。
	public onSwitchMode?: () => void;

	// 内部焦点初始 false，不自行从终端获取焦点。
	private _focused = false;
	// focused getter 返回保存的布尔值，无副作用；例如宿主读它不改变输入状态。
	get focused(): boolean {
		// 直接返回内部字段。
		return this._focused;
	}
	// focused setter 同时更新自身和搜索框，返回隐式 void；例如宿主聚焦 ResourceList 时 Input 才可发光标标记。
	set focused(value: boolean) {
		// 先保存本组件焦点。
		this._focused = value;
		// 同步传给 Input；不是切换终端/重新建立输入框。
		this.searchInput.focused = value;
	}

	// 构造列表：输入两套组、设置管理器、两个目录、可选高度/模式，结果为新组件；先捕获全局基线→建搜索框→算可见行→建扁平列表，不写设置。
	// 例如默认高度24、外壳8行算出16内容行；最少5行可能仍超出很矮的终端，不保证自适应所有高度。
	constructor(
		// 两种写入模式各有组数组，引用保存在实例中。
		groupsByScope: Record<ConfigWriteScope, ResourceGroup[]>,
		// 管理器参数是同一外部实例，不在这里另建存储。
		settingsManager: SettingsManager,
		// cwd 指项目配置的相对基准。
		cwd: string,
		// agentDir 指用户配置的相对基准。
		agentDir: string,
		// ? 允许未提供高度，后面回退24。
		terminalHeight?: number,
		// 默认参数只在 undefined 时用 global，不是读取设置默认值。
		writeScope: ConfigWriteScope = "global",
	) {
		// 保存组对象引用，不做深克隆。
		this.groupsByScope = groupsByScope;
		// 保存设置实例引用。
		this.settingsManager = settingsManager;
		// 保存项目目录字符串。
		this.cwd = cwd;
		// 保存用户配置目录字符串。
		this.agentDir = agentDir;
		// 保存初始模式。
		this.writeScope = writeScope;
		// 从 global 组构造独立 enabled Map；它是初始快照，不跟随之后全局模式的开关变化。
		this.inheritedEnabledByKey = this.buildInheritedEnabledMap(groupsByScope.global);
		// 创建独立空搜索框，默认提示前缀由 Input 自己提供。
		this.searchInput = new Input();
		// 8 lines of chrome: top spacer + top border + spacer + header (2 lines) + spacer + bottom spacer + bottom border
		// 外壳估算8行，不包含搜索框等所有可能实际输出行的严格测量。
		const chrome = 8;
		// 高度缺省24，减外壳后最少保留5行，Math.max 不保证实际终端足够高。
		this.maxVisible = Math.max(5, (terminalHeight ?? 24) - chrome);
		// 按当前模式构建扁平行并初始化选择。
		this.buildFlatList();
		// 展开复制数组外壳，各行/资源对象仍与 flatItems 共享。
		this.filteredItems = [...this.flatItems];
	}

	// setWriteScope 保存新模式→重建扁平行→按现有搜索重筛，返回 void，不保存配置；例如 Tab 后保留关键词但选择重置到首个匹配资源。
	setWriteScope(writeScope: ConfigWriteScope): void {
		// 替换模式字段。
		this.writeScope = writeScope;
		// 读取新模式的组重建行。
		this.buildFlatList();
		// 搜索文字不清空，筛选同时重新选首项。
		this.filterItems(this.searchInput.getValue());
	}

	// groups 是计算 getter，按当前模式返回对应原组数组，无复制/保存；例如 project 模式可包含继承全局来源。
	private get groups(): ResourceGroup[] {
		// Record 索引选两套组之一，不做动态扫描。
		return this.groupsByScope[this.writeScope];
	}

	// buildInheritedEnabledMap 遍历输入组的全部资源，输出按类型/路径键索引的启用快照，无保存；例如同路径后遇到的同类型项覆盖先前 Map 值。
	private buildInheritedEnabledMap(groups: ResourceGroup[]): Map<string, boolean> {
		// 新建字符串到布尔的 Map，不用对象原型键查找。
		const result = new Map<string, boolean>();
		// 遍历每个来源主组。
		for (const group of groups) {
			// 遍历该主组各资源分类。
			for (const subgroup of group.subgroups) {
				// 遍历具体资源行。
				for (const item of subgroup.items) {
					// 路径键可能尽量 realpath/规范大小写；相同类型与路径的后项覆盖前项 enabled。
					result.set(this.getResourceItemKey(item), item.enabled);
				}
			}
		}
		// 返回新 Map，资源对象以后变化不会自动更新其中的布尔值。
		return result;
	}

	// buildFlatList 按当前组树重建标题/子标题/资源行数组，并选首资源，返回 void；例如一个包两类资源保留层级标题，但列表里全是平铺行。
	private buildFlatList(): void {
		// 丢弃旧扁平数组，源组树保持。
		this.flatItems = [];
		// 按已经排好的主组顺序遍历。
		for (const group of this.groups) {
			// 追加主组标题行，type 字面量让后续分支可以收窄。
			this.flatItems.push({ type: "group", group });
			// 按子组顺序继续摊平。
			for (const subgroup of group.subgroups) {
				// 追加带父组的分类标题行。
				this.flatItems.push({ type: "subgroup", subgroup, group });
				// 每个资源仍用同一 ResourceItem 引用。
				for (const item of subgroup.items) {
					// 追加可选择资源行，不复制 item。
					this.flatItems.push({ type: "item", item });
				}
			}
		}
		// Start selection on first item (not header)
		// findIndex 返回首个资源下标，找不到为 -1，不能直接把标题当默认资源。
		this.selectedIndex = this.flatItems.findIndex((e) => e.type === "item");
		// 没有资源时回到下标0，后面用可选访问避免执行不存在资源。
		if (this.selectedIndex < 0) this.selectedIndex = 0;
	}

	// findNextItem 从给定下标向1/-1方向扫描资源行，返回新下标或原下标，不修改选择；例如下一个是标题就跳过，边缘不循环到另一端。
	private findNextItem(fromIndex: number, direction: 1 | -1): number {
		// 从相邻一行起扫描，direction 的字面量联合在 TS 中只允许 ±1。
		let idx = fromIndex + direction;
		// 只有候选下标仍在筛选数组范围内才继续。
		while (idx >= 0 && idx < this.filteredItems.length) {
			// 只接受 item 标签，跳过两种标题。
			if (this.filteredItems[idx].type === "item") {
				// 找到就立刻返回该下标。
				return idx;
			}
			// 按方向继续移动候选。
			idx += direction;
		}
		// 越界仍返回原位置，不环绕到另一端。
		return fromIndex; // Stay at current if no item found
	}

	// filterItems 按显示名/类型/路径的不区分大小写子串筛选，再保留父标题并重选首资源，返回 void；例如输入 skills 可匹配整类，非模糊拼音/分词检索。
	private filterItems(query: string): void {
		// trim 只用于判是否全空白；非空查询后面仍使用原字符串，首尾空格不会被实际删除。
		if (!query.trim()) {
			// 空查询恢复全部行的浅复制。
			this.filteredItems = [...this.flatItems];
			// 恢复全部时也重置选择，不保留原选中资源。
			this.selectFirstItem();
			// 空查询已处理，立即结束本方法。
			return;
		}

		// 查询统一小写，但不 trim；例如“ foo ”仍包含两边空格参与子串匹配。
		const lowerQuery = query.toLowerCase();
		// Set 用资源对象身份去重，匹配同一个 item 多个字段也只记录一次。
		const matchingItems = new Set<ResourceItem>();
		// 收集含匹配项的子组对象，后面保留分类标题。
		const matchingSubgroups = new Set<ResourceSubgroup>();
		// 收集含匹配项的主组对象，后面保留来源标题。
		const matchingGroups = new Set<ResourceGroup>();

		// 先遍历完整扁平行，只对资源行做文字匹配。
		for (const entry of this.flatItems) {
			// type 检查收窄为 item 分支，之后 entry.item 才是合法字段。
			if (entry.type === "item") {
				// 局部别名仍是同一资源对象，没有复制。
				const item = entry.item;
				// 多行 if 条件用 ||：任意一个字段包含查询即可命中。
				if (
					// 显示名统一小写后做子串 includes，不使用模糊评分。
					item.displayName.toLowerCase().includes(lowerQuery) ||
					// 资源类型英文键也可匹配，例如 prompts。
					item.resourceType
						.toLowerCase()
						.includes(lowerQuery) ||
					// 完整路径也参与搜索，但不检查文件正文或元数据 source 标签。
					item.path
						.toLowerCase()
						.includes(lowerQuery)
				) {
					// 把匹配的对象加入 Set，供下一轮按身份查找。
					matchingItems.add(item);
				}
			}
		}

		// Find which subgroups and groups contain matching items
		// 回到组树找匹配项的祖先，不能只保留孤立资源行。
		for (const group of this.groups) {
			// 每个主组检查各分类。
			for (const subgroup of group.subgroups) {
				// 逐项查它是否已被文字匹配。
				for (const item of subgroup.items) {
					// has 按对象引用判断，依赖扁平行仍引用原组内 item。
					if (matchingItems.has(item)) {
						// 记录分类标题需要保留。
						matchingSubgroups.add(subgroup);
						// 记录来源标题需要保留。
						matchingGroups.add(group);
					}
				}
			}
		}

		// 新筛选结果从空开始，不原地删除 flatItems。
		this.filteredItems = [];
		// 按原扁平顺序重新挑行，所以组/分类/资源顺序不因 Set 插入次序打乱。
		for (const entry of this.flatItems) {
			// 主组本身不按标题文字搜索，只因含匹配资源而保留。
			if (entry.type === "group" && matchingGroups.has(entry.group)) {
				// 保存原主组行对象。
				this.filteredItems.push(entry);
				// 子组同样只有包含命中项才保留。
			} else if (entry.type === "subgroup" && matchingSubgroups.has(entry.subgroup)) {
				// 保存原分类行对象。
				this.filteredItems.push(entry);
				// 资源行必须自己的 item 在匹配集合里。
			} else if (entry.type === "item" && matchingItems.has(entry.item)) {
				// 追加该资源行，不修改其 enabled。
				this.filteredItems.push(entry);
			}
		}

		// 每次筛选都把选择移到首个资源，找不到时用0。
		this.selectFirstItem();
	}

	// selectFirstItem 更新选择下标，无返回/设置写入；例如首两行是标题就选第3行，无资源时留0让后面可选访问处理。
	private selectFirstItem(): void {
		// findIndex 扫描当前筛选结果，未命中返回 -1。
		const firstItemIndex = this.filteredItems.findIndex((e) => e.type === "item");
		// 非负下标才采用，否则回退0；不是把 -1 当成末项。
		this.selectedIndex = firstItemIndex >= 0 ? firstItemIndex : 0;
	}

	// updateItem 将资源行和当前模式组中的首个同路径/同类型项更新为 enabled，返回 void，不负责保存或同步另一模式；例如切换后让当前勾选立即变化。
	updateItem(item: ResourceItem, enabled: boolean): void {
		// 先修改传入 item，同一对象的扁平/过滤视图也能看到新值。
		item.enabled = enabled;
		// Update in groups too
		// 再遍历当前模式组，不遍历 global/project 两套所有数据。
		for (const group of this.groups) {
			// 遍历分类寻找对应资源。
			for (const subgroup of group.subgroups) {
				// 用路径原字符串和资源类型严格相等找首项，这里不用 getResourcePathKey 的规范化比较。
				const found = subgroup.items.find((i) => i.path === item.path && i.resourceType === item.resourceType);
				// 找到才写入；未找到仍保留前面 item 的变化。
				if (found) {
					// 更新找到的组内行，可能本来就是 item 自己。
					found.enabled = enabled;
					// 首个匹配即返回，不同步同路径的全部重复项或继承基线 Map。
					return;
				}
			}
		}
	}

	// invalidate 为空：列表每次 render 现算内容，没有自有渲染缓存；不会顺便清空搜索 Input 的状态。
	invalidate(): void {}

	// render 输入显示列宽，返回搜索框+窗口行+可选滚动计数，不写终端或配置；例如中间项选中时窗口尽量居中，标题也占可见行预算。
	render(width: number): string[] {
		// 新建本次输出数组，元素都是完整的显示行字符串。
		const lines: string[] = [];

		// Search input
		// 展开 Input 返回的行追加，不把行数组当作单个元素。
		lines.push(...this.searchInput.render(width));
		// 搜索框后插入一行空白。
		lines.push("");

		// 筛选后连标题都没有时直接显示空结果提示。
		if (this.filteredItems.length === 0) {
			// 提示带 muted 颜色，不是一个可选择资源。
			lines.push(theme.fg("muted", "  No resources found"));
			// 空结果提前返回，不计算下标窗口或滚动计数。
			return lines;
		}

		// Calculate visible range
		// 窗口起点先算居中值，再夹到可用范围，Math.max 让起点不为负。
		const startIndex = Math.max(
			// 最小起点为0。
			0,
			// 最多从“总行数-窗口行数”开始，避免尾页向后留空；Math.floor 给选中项前留约半窗行。
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		// 结束下标左闭右开，最多到筛选数组长度。
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

		// 仅输出窗口中的行，i++ 逐行推进，标题同样算一行。
		for (let i = startIndex; i < endIndex; i++) {
			// 取当前扁平行；后面依循环范围和数组契约使用，不做运行形状验证。
			const entry = this.filteredItems[i];
			// 当前行下标是否等于选中位置，严格相等得到 boolean。
			const isSelected = i === this.selectedIndex;

			// 标签收窄为主组标题，不显示资源游标或勾选框。
			if (entry.type === "group") {
				// Main group header (no cursor)
				// 项目模式下、来源 user 的组展示为继承全局组。
				const inherited = this.writeScope === "project" && entry.group.scope === "user";
				// 给标题加继承提示并粗体；其他组不追加后缀。
				const label = theme.bold(`${entry.group.label}${inherited ? " · inherited global" : ""}`);
				// 继承组用 dim，其他用 accent；仅样式变化，不限制切换。
				const groupLine = theme.fg(inherited ? "dim" : "accent", label);
				// 加两格缩进、截到宽度，不显示省略尾标记。
				lines.push(truncateToWidth(`  ${groupLine}`, width, ""));
				// 分类标题走另一分支，仍不显示资源游标。
			} else if (entry.type === "subgroup") {
				// Subgroup header (indented, no cursor)
				// 项目继承分类用 dim，其余用 muted。
				const color = this.writeScope === "project" && entry.group.scope === "user" ? "dim" : "muted";
				// 对分类英文标题着色。
				const subgroupLine = theme.fg(color, entry.subgroup.label);
				// 分类缩进四格并截宽。
				lines.push(truncateToWidth(`    ${subgroupLine}`, width, ""));
			} else {
				// Resource item (cursor only on items)
				// 前两类已排除，TS 知道剩余 entry 为资源行。
				const item = entry.item;
				// 只有选中行显示 >，否则等宽两个空格。
				const cursor = isSelected ? "> " : "  ";
				// 是否变暗看资源是否继承且无项目显式覆盖，不直接由 enabled 决定。
				const dimmed = this.isDimmedItem(item);
				// 选中且不变暗才把名字粗体，变暗的选中资源仍有游标。
				const nameText = isSelected && !dimmed ? theme.bold(item.displayName) : item.displayName;
				// 需要变暗时套 dim 颜色，其他名字保持现有样式。
				const name = dimmed ? theme.fg("dim", nameText) : nameText;
				// 追加完整资源行，多行函数参数在后面组成一个字符串。
				lines.push(
					// 按显示宽度截断资源文字，不按字符串 length 截。
					truncateToWidth(
						// 拼游标、缩进、勾选框、名字和项目覆盖说明，不改变实际资源状态。
						`${cursor}    ${this.renderCheckbox(item)} ${name}${this.getItemSuffix(item)}`,
						// 传入宿主给定列宽。
						width,
						// 资源行过长用三个英文句点作截断后缀。
						"...",
					),
				);
			}
		}

		// Scroll indicator
		// 窗口之前/之后有隐藏行才显示滚动计数，判断包含标题行。
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			// 计数分母只数 item，排除主组与分类标题。
			const itemCount = this.filteredItems.filter((e) => e.type === "item").length;
			// 分子计算表达式在下一行，表示当前选中资源的1起始序号。
			const currentItemIndex =
				// 统计选中下标之前的资源数再加1，和包含标题的扁平下标不同。
				this.filteredItems.slice(0, this.selectedIndex).filter((e) => e.type === "item").length + 1;
			// 把资源序号/总数作为额外一行输出，不计入 maxVisible 内容窗口预算。
			lines.push(theme.fg("dim", `  (${currentItemIndex}/${itemCount})`));
		}

		// 返回整组显示行，终端写入由宿主 TUI 完成。
		return lines;
	}

	// handleInput 依次处理上下/翻页/取消/退出/模式切换/启停，其余交搜索，返回 void；例如空格直接切换当前资源，不能输入到搜索文字中。
	// 同步调用设置 setter/外部回调，异常向宿主传播，不 await 落盘；成功开关只更新当前解析快照，不在这里重载扩展。
	handleInput(data: string): void {
		// 每次读取当前键位管理器，运行时重配键位后可用新绑定。
		const kb = getKeybindings();

		// 向上动作优先匹配，不继续作为文本处理。
		if (kb.matches(data, "tui.select.up")) {
			// 往前找下一个资源行，边缘保持原位置。
			this.selectedIndex = this.findNextItem(this.selectedIndex, -1);
			// 已消费按键，结束本轮输入。
			return;
		}
		// 向下动作同样跳过标题。
		if (kb.matches(data, "tui.select.down")) {
			// 沿 +1 方向扫描并替换选中下标。
			this.selectedIndex = this.findNextItem(this.selectedIndex, 1);
			// 不再进入搜索框。
			return;
		}
		// 翻页按扁平行数跳，不按资源数量跳。
		if (kb.matches(data, "tui.select.pageUp")) {
			// Jump up by maxVisible, then find nearest item
			// 先向上减一窗，最小夹到0。
			let target = Math.max(0, this.selectedIndex - this.maxVisible);
			// 若落到标题则向后寻找最近资源；数组为空时不进循环。
			while (target < this.filteredItems.length && this.filteredItems[target].type !== "item") {
				// 逐行向后移候选，直到资源或越界。
				target++;
			}
			// 有合法候选才替换选择。
			if (target < this.filteredItems.length) {
				// 保存候选下标。
				this.selectedIndex = target;
			}
			// 翻页处理结束，即使没找到也不传给搜索框。
			return;
		}
		// 向下翻页与向上相反，先跳后向前找资源。
		if (kb.matches(data, "tui.select.pageDown")) {
			// Jump down by maxVisible, then find nearest item
			// 目标最多到最后一行；空结果时可能为 -1，后面范围判断处理。
			let target = Math.min(this.filteredItems.length - 1, this.selectedIndex + this.maxVisible);
			// 向前跳过标题，直到资源或小于0。
			while (target >= 0 && this.filteredItems[target].type !== "item") {
				// 递减候选下标。
				target--;
			}
			// 候选非负才可选。
			if (target >= 0) {
				// 保存新下标，不执行资源启停。
				this.selectedIndex = target;
			}
			// 结束本次按键。
			return;
		}
		// 配置的取消动作通知宿主关闭，组件本身不撤销已保存开关。
		if (kb.matches(data, "tui.select.cancel")) {
			// 可选回调只在存在时同步调用；回调抛错会向外传播。
			this.onCancel?.();
			// 取消键不进搜索输入。
			return;
		}
		// 固定 Ctrl+C 在可配置取消之后判断，原有判断保持；它的实际退出效果取决于 onExit。
		if (matchesKey(data, "ctrl+c")) {
			// 通知宿主退出，无回调时只消费按键。
			this.onExit?.();
			// 不再处理后续动作。
			return;
		}
		// 模式切换动作同样按当前键位识别。
		if (kb.matches(data, "tui.input.tab")) {
			// 只有外层安装了回调才切换；未允许项目模式时 Tab 被消费但无模式改变。
			this.onSwitchMode?.();
			// 不把 Tab 插入搜索。
			return;
		}
		// 字面空格或确认动作触发开关；检查优先级在搜索编辑之前。
		if (data === " " || kb.matches(data, "tui.select.confirm")) {
			// 读取当前行，空结果/越界时可能 undefined。
			const entry = this.filteredItems[this.selectedIndex];
			// ?. 先保护缺行；必须是资源，且项目模式可处理所有来源、全局模式只允许 getItemScope 为 user 的项。
			if (entry?.type === "item" && (this.writeScope === "project" || this.getItemScope(entry.item) === "user")) {
				// 尝试写设置并算新显示值，返回 undefined 表示该项目覆盖路径未完成。
				const newEnabled = this.toggleResource(entry.item);
				// !== undefined 会接受 false，所以关闭状态也算成功结果。
				if (newEnabled !== undefined) {
					// 按返回值更新当前模式 UI 行，不是重新向包管理器查询。
					this.updateItem(entry.item, newEnabled);
					// 可选通知供宿主请求重绘；若此回调抛错，之前设置/UI 变更没有回滚。
					this.onToggle?.(entry.item, newEnabled);
				}
			}
			// 无选中资源或无权限也消费确认/空格，不进入搜索。
			return;
		}

		// Pass to search input
		// 剩余输入才交 Input 处理编辑/粘贴等，Input 自己按配置规则过滤字符。
		this.searchInput.handleInput(data);
		// 读取完整搜索文字重新筛选，即使 Input 没改变文字也会重置选中项。
		this.filterItems(this.searchInput.getValue());
	}

	// toggleResource 按写入模式分派设置修改，返回新显示 enabled 或 undefined；例如全局 true→false，项目先按继承基线确定下一覆盖态，失败/异常不保证写入完成。
	private toggleResource(item: ResourceItem): boolean | undefined {
		// 项目模式不走下面全局二态逻辑。
		if (this.writeScope === "project") {
			// 从当前项目显式状态和初始全局基线计算下一态。
			const state = this.getNextOverrideState(item);
			// 对应修改器返回 false 时给 undefined；setter 自身抛错则直接传播。
			if (!this.setProjectResourceOverride(item, state)) return undefined;
			// 回到 inherit 用构造时全局基线，其余只有 load 为 true；这不是重新解析 glob 后的有效结果。
			return state === "inherit" ? this.getInheritedEnabled(item) : state === "load";
		}

		// 全局模式对当前 UI enabled 直接取反。
		const enabled = !item.enabled;
		// 顶层来源修改资源路径列表，包来源则修改包内部筛选列表。
		if (item.metadata.origin === "top-level") {
			// 顶层修改器返回 void，未在这里等待写盘。
			this.toggleTopLevelResource(item, enabled);
		} else {
			// 包修改器可能找不到来源而直接返回，本方法依然会返回目标 enabled，不能把 UI 更新等同存储成功确认。
			this.togglePackageResource(item, enabled);
		}
		// 返回要显示的新状态，外层据此更新勾选。
		return enabled;
	}

	// toggleTopLevelResource 读对应设置层副本→清理同目标的旧精确模式→追加 +/-→调用该类 setter，返回 void；例如内置 mcp 关闭追加 -builtin:mcp，不删除资源文件。
	// 只匹配生成模式的字面相等，不消除可能影响同资源的其他 glob；项目 setter 可因不可信抛错，保存错误由管理器队列处理。
	private toggleTopLevelResource(item: ResourceItem, enabled: boolean): void {
		// as 仅静态断言，不把 temporary 字符串转成 user；正常交互入口已限制全局可切换项。
		const scope = item.metadata.scope as "user" | "project";
		// 按来源 scope 选择原始设置层，而非读有效合并设置。
		const settings =
			// 两 getter 都给深副本；非 project 值走 global，尚未改管理器。
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();

		// 把已是 ResourceType 的字段断言为同一四项联合，不产生运行转换。
		const arrayKey = item.resourceType as "extensions" | "skills" | "prompts" | "themes";
		// 取该类数组，未配置用空数组；as 依类型契约，不验证每项是字符串。
		const current = (settings[arrayKey] ?? []) as string[];

		// Generate pattern for this resource
		// 算相对资源基准目录的模式；builtin 标识保留原文。
		const pattern = this.getResourcePattern(item);
		// 负号表示禁用这一个目标，字符串正文是保存数据。
		const disablePattern = `-${pattern}`;
		// 加号表示显式启用。
		const enablePattern = `+${pattern}`;

		// Filter out existing patterns for this resource
		// filter 返回新数组，仅移除与这个精确目标相等的旧条目。
		const updated = current.filter((p) => {
			// 若首字符是 !/+/- 就仅去掉一个字符，其他条目原样；不展开 glob。
			const stripped = p.startsWith("!") || p.startsWith("+") || p.startsWith("-") ? p.slice(1) : p;
			// 目标不同就保留，目标相同不论原先启停符号都删除。
			return stripped !== pattern;
		});

		// 按调用方期望状态选要追加的规则。
		if (enabled) {
			// 启用规则加到末尾，让精确规则顺序可被解析器使用。
			updated.push(enablePattern);
		} else {
			// 关闭时改加禁用规则，不删除目录/代码。
			updated.push(disablePattern);
		}

		// 来源是 project 才调用项目 setter，后者会再检查当前信任。
		if (scope === "project") {
			// 扩展类别写项目 extensions。
			if (arrayKey === "extensions") {
				// 传入新列表，立即改管理器视图并排队项目保存，不执行扩展。
				this.settingsManager.setProjectExtensionPaths(updated);
				// 技能类别写项目 skills。
			} else if (arrayKey === "skills") {
				// 排队技能路径设置保存，不读取 SKILL.md。
				this.settingsManager.setProjectSkillPaths(updated);
				// 模板类别写项目 prompts。
			} else if (arrayKey === "prompts") {
				// 保存模板路径，不解析模板正文。
				this.settingsManager.setProjectPromptTemplatePaths(updated);
				// 主题类别写项目 themes。
			} else if (arrayKey === "themes") {
				// 保存主题路径，不切换当前 TUI 主题。
				this.settingsManager.setProjectThemePaths(updated);
			}
		} else {
			// 非 project 走用户层，先判断是否扩展。
			if (arrayKey === "extensions") {
				// 修改用户 extensions 并排队保存；可信项目同名设置可能仍覆盖有效值。
				this.settingsManager.setExtensionPaths(updated);
				// 用户技能类别分支。
			} else if (arrayKey === "skills") {
				// 修改用户 skills 列表。
				this.settingsManager.setSkillPaths(updated);
				// 用户提示词模板分支。
			} else if (arrayKey === "prompts") {
				// 修改用户 prompts 列表。
				this.settingsManager.setPromptTemplatePaths(updated);
				// 用户主题分支。
			} else if (arrayKey === "themes") {
				// 修改用户 themes 列表，不立即重载资源。
				this.settingsManager.setThemePaths(updated);
			}
		}
	}

	// togglePackageResource 在来源设置副本中找包，把字符串升级为对象后改对应分类的精确 +/- 模式，再调用 packages setter；例如 npm:x 关闭 extensions/a.ts 后保存带 extensions 数组的对象。
	// 这里只用 source 字符串相等找首包，未找到就无写入返回；不解析本地来源等价路径、不安装包，管理器 setter 的排队与错误规则仍适用。
	private togglePackageResource(item: ResourceItem, enabled: boolean): void {
		// 断言来源只有 user/project，不进行运行值修正。
		const scope = item.metadata.scope as "user" | "project";
		// 先选择来源设置层副本。
		const settings =
			// project 与 global getter 返回隔离副本，避免直接改内部包对象。
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();

		// 再浅复制包数组；其中对象来自已经深复制过的 settings，包对象修改不会直接改原管理器。
		const packages = [...(settings.packages ?? [])] as PackageSource[];
		// findIndex 找首个 source 严格相等的包。
		const pkgIndex = packages.findIndex((pkg) => {
			// typeof 将字符串/对象联合收窄，分别取字符串本身或 source 字段。
			const source = typeof pkg === "string" ? pkg : pkg.source;
			// 原字符串比较，不规范路径或版本表达式。
			return source === item.metadata.source;
		});

		// 没找到包就返回 void，不补造包来源；上层仍可能更新 UI 勾选。
		if (pkgIndex === -1) return;

		// let 接当前包，允许下方把字符串换为对象。
		let pkg = packages[pkgIndex];

		// Convert string to object form if needed
		// 字符串形式不能挂分类过滤数组，所以先升级对象。
		if (typeof pkg === "string") {
			// 新对象只保留 source，其他分类随后按默认自动加载语义处理。
			pkg = { source: pkg };
			// 把对象替换回副本数组中对应位置。
			packages[pkgIndex] = pkg;
		}

		// Get the resource array for this type
		// 当前资源类型就是要修改的分类键。
		const arrayKey = item.resourceType as "extensions" | "skills" | "prompts" | "themes";
		// 缺该类筛选取空列表，用作清理/追加精确规则的起点，不代表整个包从空资源集开始。
		const current = (pkg[arrayKey] ?? []) as string[];

		// Generate pattern relative to package root
		// 模式相对 metadata.baseDir；无此目录时退回文件父目录，不保证始终是真正包根。
		const pattern = this.getPackageResourcePattern(item);
		// 构造禁用规则文本。
		const disablePattern = `-${pattern}`;
		// 构造显式启用规则文本。
		const enablePattern = `+${pattern}`;

		// Filter out existing patterns for this resource
		// 保留未指向本精确 pattern 的筛选条目。
		const updated = current.filter((p) => {
			// 仅剥首个 !/+/- 字符再比较，不做通配符匹配。
			const stripped = p.startsWith("!") || p.startsWith("+") || p.startsWith("-") ? p.slice(1) : p;
			// 与目标不相等的其他配置不动。
			return stripped !== pattern;
		});

		// 根据目标状态追加一条精确规则。
		if (enabled) {
			// 启用规则放末尾。
			updated.push(enablePattern);
		} else {
			// 禁用规则放末尾。
			updated.push(disablePattern);
		}

		// as Record 允许以动态键赋值，unknown 不证明字段内容已验证；非空列表保存，空列表设 undefined，但本路径前面必已 push 一条。
		(pkg as Record<string, unknown>)[arrayKey] = updated.length > 0 ? updated : undefined;

		// Clean up empty filter object
		// 检查四类字段是否还有任何非 undefined 筛选，some 遇到首个真值就停止。
		const hasFilters = ["extensions", "skills", "prompts", "themes"].some(
			// 这里空数组也算存在筛选，不用 length 判空；autoload 不参与这项判断。
			(k) => (pkg as Record<string, unknown>)[k] !== undefined,
		);
		// 四类全无筛选才把对象缩回字符串形式；正常本方法刚 push 规则时通常不会进入。
		if (!hasFilters) {
			// 断言具 source 后只保留来源字符串，此分支不会保留对象其他字段。
			packages[pkgIndex] = (pkg as { source: string }).source;
		}

		// 来源 scope 决定写项目还是用户包数组。
		if (scope === "project") {
			// 项目 packages setter 会检查信任，并先更新内存再排队保存。
			this.settingsManager.setProjectPackages(packages);
		} else {
			// 用户 packages setter 保存用户层，不安装/重载任何包。
			this.settingsManager.setPackages(packages);
		}
	}

	// renderCheckbox 读取模式和当前项目覆盖态返回带颜色的方框文字，无设置写入；例如显式 load 显示 [+]，继承态用 dim 的 [x]/[ ] 展示当前 UI enabled。
	private renderCheckbox(item: ResourceItem): string {
		// 项目模式先区分三态，而非只看 enabled。
		if (this.writeScope === "project") {
			// 从当前项目设置读精确覆盖态；与 enabled 快照可能不同来源。
			const state = this.getProjectOverrideState(item);
			// 显式加载用 success 颜色和加号。
			if (state === "load") return theme.fg("success", "[+]");
			// 显式不加载用 warning 颜色和减号。
			if (state === "unload") return theme.fg("warning", "[-]");
			// 继承状态显示勾选或空框并变暗；方框里的布尔来自行快照。
			return theme.fg("dim", item.enabled ? "[x]" : "[ ]");
		}
		// 全局只显示二态方框，不展示项目覆盖符号。
		return item.enabled ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
	}

	// getItemSuffix 读取项目覆盖态返回行尾说明，非项目模式返回空串，无保存；例如显式 unload 显示 project unload，inherit 且有全局来源才提示 inherited global。
	private getItemSuffix(item: ResourceItem): string {
		// 全局模式没有项目行尾提示，提前返回空字符串。
		if (this.writeScope !== "project") return "";
		// 项目模式读取当前设置中本资源的精确覆盖态。
		const state = this.getProjectOverrideState(item);
		// 显式加载时返回 muted 的英文说明。
		if (state === "load") return theme.fg("muted", "  project load");
		// 显式不加载时返回另一说明。
		if (state === "unload") return theme.fg("muted", "  project unload");
		// 其余为 inherit；只有判为全局继承资源才补变暗后缀，纯项目资源不补。
		return this.isInheritedGlobalItem(item) ? theme.fg("dim", "  inherited global") : "";
	}

	// isDimmedItem 判断资源名是否按继承项变暗，输入一行、返回 boolean，无设置写入；例如项目模式中的全局项无显式覆盖时为 true，与启用/禁用布尔无直接等价关系。
	private isDimmedItem(item: ResourceItem): boolean {
		// 多行 return 的括号把三个条件组成同一个表达式。
		return (
			// 先要求当前项目模式，否则 && 短路不再读取后续状态。
			this.writeScope === "project" &&
			// 再要求是用户来源或初始全局快照里存在的同类型/路径资源。
			this.isInheritedGlobalItem(item) &&
			// 最后要求没有项目显式 load/unload。
			this.getProjectOverrideState(item) === "inherit"
		);
	}

	// setProjectResourceOverride 按来源形式分派顶层或包的项目修改，返回其布尔结果，不捕获 setter 异常；例如包资源不写顶层 extensions 数组，而写 packages 内筛选。
	private setProjectResourceOverride(item: ResourceItem, state: ProjectOverrideState): boolean {
		// origin 恰是 top-level 时走第一分支。
		return item.metadata.origin === "top-level"
			? // 顶层修改器写项目资源路径列表。
				this.setProjectTopLevelOverride(item, state)
			: // 包修改器找/创建项目包覆盖来源，可能返回 false 表示未修改。
				this.setProjectPackageOverride(item, state);
	}

	// setProjectTopLevelOverride 取项目数组→移除本目标旧精确覆盖→按需补资源入口与 +/-→调用项目 setter，正常返回 true；例如项目强制加载全局普通文件时先写其路径入口再写 +路径。
	// inherit 清除针对该目标的精确覆盖，不删除资源文件、不展开/删除其他 glob；返回 true 不等于磁盘持久化成功，不可信项目可同步抛错。
	private setProjectTopLevelOverride(item: ResourceItem, state: ProjectOverrideState): boolean {
		// 按资源类型读项目层深副本中的原始列表，缺省空数组；不使用用户/项目合并列表。
		const current = (this.settingsManager.getProjectSettings()[item.resourceType] ?? []) as string[];
		// 继承资源采用原 path 作为覆盖目标；项目自有资源用对应范围下的相对模式。
		const pattern = this.isInheritedGlobalItem(item) ? item.path : this.getResourcePatternForScope(item, "project");
		// 收集可识别同目标的若干字面路径形式，供清理旧规则；不是通配符匹配器。
		const patterns = this.getTopLevelOverridePatterns(item, "project");
		// filter 建新列表，逐个检查原项目条目。
		const updated = current.filter((entry) => {
			// 剥掉一个可选首符号，得到用于精确比较的目标字符串。
			const target = this.getPatternEntryTarget(entry);
			// 只要是带 !/+/- 的规则且目标在候选集合里，就应删掉旧覆盖。
			if ((entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-")) && patterns.has(target))
				// false 表示不保留这个旧条目，不是把整个方法结果设 false。
				return false;
			// 回到 inherit 且是全局继承项时，也删掉直接等于 pattern 的无符号入口；其他未匹配项保留。
			return !(state === "inherit" && this.isInheritedGlobalItem(item) && target === pattern);
		});
		// load/unload 才追加显式覆盖，inherit 不追加新条目。
		if (state !== "inherit") {
			// Project entries name inherited files to override them. Built-in paths need no entry.
			// 全局继承的普通文件需有项目可解析入口，builtin 不需要；已含相同 pattern 时不重复加入口。
			if (this.isInheritedGlobalItem(item) && item.metadata.source !== "builtin" && !updated.includes(pattern))
				// 把入口本身放进项目列表，让解析器能找到要覆盖的资源。
				updated.push(pattern);
			// 再在末尾加 load 的 + 或 unload 的 - 规则，模板插值只构造保存文字。
			updated.push(`${state === "load" ? "+" : "-"}${pattern}`);
		}
		// 统一按类别调用项目设置 setter；此处不 await flush，也不重新解析资源。
		this.setProjectTopLevelPaths(item.resourceType, updated);
		// setter 正常返回就回 true，保存队列中的后续失败不会变成这里的 false。
		return true;
	}

	// setProjectTopLevelPaths 按资源类型把新路径数组转交对应项目 setter，返回 void；例如 skills 写项目 skills，不改用户设置，信任错误直接传播。
	private setProjectTopLevelPaths(key: ResourceType, paths: string[]): void {
		// 扩展字段交项目扩展路径 setter。
		if (key === "extensions") this.settingsManager.setProjectExtensionPaths(paths);
		// 技能字段交项目技能路径 setter。
		else if (key === "skills") this.settingsManager.setProjectSkillPaths(paths);
		// 提示词模板字段交项目模板路径 setter。
		else if (key === "prompts") this.settingsManager.setProjectPromptTemplatePaths(paths);
		// 前三种排除后剩 themes，交项目主题路径 setter；此分支依赖 ResourceType 契约，不运行任意字符串验证。
		else this.settingsManager.setProjectThemePaths(paths);
	}

	// setProjectPackageOverride 在项目包副本中找等价来源，必要时建 autoload:false 覆盖包，改一类精确模式，再清理空过滤对象并保存；返回是否走到 setter，异常不吞。
	// 例全局 npm:x 的 a.ts 从继承开切为关，会保存 {source:"npm:x",autoload:false,extensions:["-extensions/a.ts"]}；回到继承且无其他过滤时删除这份仅覆盖包，不卸载包目录。
	private setProjectPackageOverride(item: ResourceItem, state: ProjectOverrideState): boolean {
		// 读取项目设置深副本后复制数组外壳，避免直接突变管理器原数据。
		const packages = [...(this.settingsManager.getProjectSettings().packages ?? [])] as PackageSource[];
		// 找第一个匹配来源，let 允许后面新增包时改下标。
		let pkgIndex = packages.findIndex((pkg) =>
			// 来源比较器先看原字符串，再对双方本地来源按各自范围基准绝对化比较。
			this.packageSourceStringMatches(
				// 左来源来自当前资源 metadata。
				item.metadata.source,
				// 左基准取该资源来源范围，不是当前 project 写入模式。
				this.getItemScope(item),
				// 右来源可能是字符串或对象，typeof 在此收窄联合。
				typeof pkg === "string" ? pkg : pkg.source,
				// 右来源属于项目设置层，按项目 .pi 目录解析本地相对路径。
				"project",
			),
		);
		// 未找到项目包来源时，决定是否新增覆盖包。
		if (pkgIndex === -1) {
			// 要继承且项目没有此包就无可清理，返回 false，不造空覆盖。
			if (state === "inherit") return false;
			// 非继承时创建只显式选择资源的 autoload:false 来源；本地包 source 会换成项目基准下相对路径。
			packages.push(this.createPackageOverrideSource(item));
			// 新包在数组末尾，保存其下标供后续修改。
			pkgIndex = packages.length - 1;
		}
		// 读取已找到/新增的包项，let 允许字符串升级对象。
		let pkg = packages[pkgIndex];
		// 原实现保留 undefined 防护，此处直接返回 false，不触发 setter。
		if (pkg === undefined) return false;
		// 字符串包项需转对象后才能写分类过滤。
		if (typeof pkg === "string") {
			// 升级成只带 source 的对象，未写 autoload 即沿默认行为。
			pkg = { source: pkg };
			// 将升级对象放回当前项目副本数组。
			packages[pkgIndex] = pkg;
		}
		// 生成相对 metadata.baseDir 的单资源目标，无 baseDir 时以资源父目录兜底。
		const pattern = this.getPackageResourcePattern(item);
		// 从本包本资源分类的旧筛选构建新数组，缺省视空列表。
		const updated = ((pkg[item.resourceType] ?? []) as string[]).filter(
			// 剥一个 !/+/- 首符号后，移除精确同目标的条目；其他 glob 原样保留。
			(entry) => this.getPatternEntryTarget(entry) !== pattern,
		);
		// load/unload 时追加一条显式规则；inherit 不追加，让原来源/其他规则重新参与解析。
		if (state !== "inherit") updated.push(`${state === "load" ? "+" : "-"}${pattern}`);
		// 有条目保存数组，没有则把字段设 undefined；Record 断言只放宽动态键写法，不运行 schema 检验。
		(pkg as Record<string, unknown>)[item.resourceType] = updated.length > 0 ? updated : undefined;
		// 若四个分类字段都不存在，清理不再带筛选的对象；空数组仍算字段存在。
		if (!RESOURCE_TYPES.some((key) => (pkg as Record<string, unknown>)[key] !== undefined)) {
			// autoload:false 且无任何分类筛选时，本分支将它视为可移除的覆盖项，从项目来源数组删除，不删除磁盘包内容。
			if (pkg.autoload === false) packages.splice(pkgIndex, 1);
			// 其他包退回简单 source 字符串，沿默认自动加载，不保留原对象额外字段。
			else packages[pkgIndex] = pkg.source;
		}
		// 把完整新项目包列表交 setter；会同步验信任、更新内存、排队落盘。
		this.settingsManager.setProjectPackages(packages);
		// 成功分派保存返回 true，不证明写盘或资源重载完成。
		return true;
	}

	// getNextOverrideState 根据当前态与继承基线返回下一态，不写设置；继承开时循环 inherit→unload→load→inherit，继承关时循环 inherit→load→unload→inherit。
	private getNextOverrideState(item: ResourceItem): ProjectOverrideState {
		// 先读取当前精确项目覆盖态。
		const state = this.getProjectOverrideState(item);
		// 基线来自构造时 global Map，缺失时按 getInheritedEnabled 的规则兜底。
		const inheritedEnabled = this.getInheritedEnabled(item);
		// 从 inherit 先切到与继承值相反的显式状态，让第一次按空格看起来是翻转。
		if (state === "inherit") return inheritedEnabled ? "unload" : "load";
		// 当前 unload：继承开就再到 load，继承关就回 inherit。
		if (state === "unload") return inheritedEnabled ? "load" : "inherit";
		// 剩余当前 load：继承开回 inherit，继承关到 unload。
		return inheritedEnabled ? "inherit" : "unload";
	}

	// getProjectOverrideState 将项目设置里的精确目标规则解释为 inherit/load/unload，无写入；例如同目标 -a 后又 +a 会取最后 load。这里只识别候选字符串，不求完整 glob 的最终生效集合。
	private getProjectOverrideState(item: ResourceItem): ProjectOverrideState {
		// 不在项目模式时统一返回 inherit，避免把用户模式画成项目显式覆盖。
		if (this.writeScope !== "project") return "inherit";
		// 顶层资源从项目同类路径数组中分析。
		if (item.metadata.origin === "top-level") {
			// 委托规则扫描器，下面三个实参决定要比哪些目标以及空数组语义。
			return this.getOverrideStateFromEntries(
				// 读项目原始列表，没字段用空数组，不混入用户路径。
				(this.settingsManager.getProjectSettings()[item.resourceType] ?? []) as string[],
				// 候选包括原路径及多个相关相对写法，但不做广义模式匹配。
				this.getTopLevelOverridePatterns(item, "project"),
				// 顶层空数组不单独表示 unload，所以传 false。
				false,
			);
		}
		// 包资源先找项目中来源匹配的首个包配置。
		const pkg = this.findMatchingPackageSource(item, "project");
		// 无项或仅字符串包都没有分类精确覆盖，返回 inherit；可信类型中对象分支不含 null。
		if (typeof pkg !== "object") return "inherit";
		// 取当前分类字段，其他分类不影响该分类状态。
		const entries = pkg[item.resourceType];
		// 字段缺省视为继承，不将包默认自动加载等同显式 load。
		if (entries === undefined) return "inherit";
		// 有数组才分析这个分类，空数组还有下一项指定的特殊含义。
		return this.getOverrideStateFromEntries(
			// 传入此类筛选原列表。
			entries,
			// 包内只比单资源相对模式，不使用顶层路径候选集合。
			new Set([this.getPackageResourcePattern(item)]),
			// 普通自动加载包中显式空数组代表该类不加载；autoload:false 时空数组不在这里当 unload。
			pkg.autoload !== false,
		);
	}

	// getOverrideStateFromEntries 扫描与候选目标字面匹配的规则，返回最后一次精确状态，没命中为 inherit；例如 [-a,+a] 对目标 a 返回 load，不处理 a*.ts 是否覆盖 a.ts。
	private getOverrideStateFromEntries(
		// entries 是已类型化字符串数组，顺序参与结果。
		entries: string[],
		// patterns 是允许精确比较的目标集合，不是待编译正则或 glob。
		patterns: Set<string>,
		// 布尔标记只解释“数组为空”是否代表不加载，不改变非空扫描规则。
		emptyArrayIsUnload: boolean,
	): ProjectOverrideState {
		// 满足空数组特例立刻返回 unload，后面不再扫描。
		if (entries.length === 0 && emptyArrayIsUnload) return "unload";
		// 默认无覆盖，之后每个匹配条目可覆盖此局部变量。
		let state: ProjectOverrideState = "inherit";
		// 按原配置条目顺序处理，越后的同目标规则越晚赋值。
		for (const entry of entries) {
			// 不在候选 Set 里的目标跳过；Set.has 是字符串精确相等。
			if (!patterns.has(this.getPatternEntryTarget(entry))) continue;
			// ! 和 - 两种前缀都识别为显式不加载。
			if (entry.startsWith("!") || entry.startsWith("-")) state = "unload";
			// 其他匹配形式，包括 + 和无符号条目，识别为 load。
			else state = "load";
		}
		// 返回扫描后的最终态，不修改 entries/patterns。
		return state;
	}

	// getInheritedEnabled 查询初始全局启用快照，缺失时 user/临时映射项用当前 enabled、项目自有项默认 true；返回 boolean，不重新解析文件或设置。
	private getInheritedEnabled(item: ResourceItem): boolean {
		// 括号包住整个 ?? 表达式，保证作为一个返回值。
		return (
			// 按类型和路径键查 Map，false 也是有效值，不因 ?? 被替换。
			this.inheritedEnabledByKey.get(this.getResourceItemKey(item)) ??
			// 只有 Map 没值时走来源兜底；项目自有资源默认 true 是此界面三态基线规则，不是其真实加载保证。
			(this.getItemScope(item) === "user" ? item.enabled : true)
		);
	}

	// isInheritedGlobalItem 判断资源是否视为全局继承项，返回 boolean 无写入；例如项目解析结果将同一路径标为 project，但初始全局 Map 中有它，仍判继承项。
	private isInheritedGlobalItem(item: ResourceItem): boolean {
		// 用户/临时映射项先返回 true；其他按类型+规范路径是否存在于初始 Map 判断，不要求 enabled=true。
		return this.getItemScope(item) === "user" || this.inheritedEnabledByKey.has(this.getResourceItemKey(item));
	}

	// getTopLevelOverridePatterns 收集同资源的几种字面目标写法，返回新 Set；例原 path 为绝对路径，同时允许项目基准相对写法，不读取 glob 匹配结果或做安全检查。
	private getTopLevelOverridePatterns(item: ResourceItem, scope: SettingsScope): Set<string> {
		// 先选目标设置层基准目录：用户 agentDir 或项目 cwd/.pi。
		const baseDir = this.getTopLevelBaseDir(scope);
		// Set 自动合并相同字符串，下面三项可能重复。
		const patterns = new Set<string>([
			// 取本资源在指定范围下通常保存的模式。
			this.getResourcePatternForScope(item, scope),
			// 同时允许原路径完整字符串，builtin 标识也保留。
			item.path,
			// 加入从目标设置基准算出的相对写法，仅路径运算，不要求磁盘存在。
			relative(baseDir, item.path),
		]);
		// metadata.baseDir 为真值时再补该基准相对形式；空字符串不加入此分支。
		if (item.metadata.baseDir) patterns.add(relative(item.metadata.baseDir, item.path));
		// 返回精确目标集合，不把它转成模式引擎。
		return patterns;
	}

	// getResourcePatternForScope 按目标范围生成模式字符串，跨来源范围或 builtin 保留原 path，否则相对 metadata/范围基准；例如全局文件给项目覆盖时用原绝对路径，不改文件。
	private getResourcePatternForScope(item: ResourceItem, scope: SettingsScope): string {
		// 把元数据范围归成 user/project，temporary 也按 user 处理。
		const sourceScope = this.getItemScope(item);
		// 范围不一致时不能直接沿另一层相对路径；builtin 是合成标识，同样保持原文。
		if (scope !== sourceScope || item.metadata.source === "builtin") return item.path;
		// 同范围普通路径优先 metadata.baseDir，缺失才用该范围配置目录；?? 保留空字符串。
		const baseDir = item.metadata.baseDir ?? this.getTopLevelBaseDir(sourceScope);
		// relative 算相对模式，路径运算本身不规范 realpath/文件存在性。
		return relative(baseDir, item.path);
	}

	// createPackageOverrideSource 为新项目覆盖创建 source/autoload:false 数据，不安装包；例如用户来源 /shared/pkg 被改写成项目 .pi 目录下能指向它的相对路径。
	private createPackageOverrideSource(item: ResourceItem): PackageSource {
		// 取资源所属包的来源字符串，非资源文件路径。
		const source = item.metadata.source;
		// npm/git 等非本地来源保持原说明，autoload:false 表示从空资源集应用显式规则。
		if (!isLocalPath(source)) return { source, autoload: false };
		// 本地来源先去首尾空白、展开路径并按其原来源范围转绝对；不是 realpath，不验证包存在或信任。
		const sourcePath = resolvePath(source, this.getTopLevelBaseDir(this.getItemScope(item)), { trim: true });
		// 再改成项目配置目录的相对 source；同目录的空相对串用 || 回退 .，保留 autoload:false。
		return { source: relative(this.getTopLevelBaseDir("project"), sourcePath) || ".", autoload: false };
	}

	// packageSourceStringMatches 比较两范围的包来源，返回 boolean，无保存；先原文相同即 true，否则双方必须本地，分别绝对化后严格相等。例如同一 ./pkg 在两基准下可能指不同包。
	// 不解析软链接或统一大小写、不检查 npm 版本语义；尤其相同相对原文会在基准解析前直接匹配，不可把函数名理解成完整包身份比较。
	private packageSourceStringMatches(
		// 左来源字符串，例如资源 metadata.source。
		leftSource: string,
		// 左来源所在设置范围，决定相对路径基准。
		leftScope: SettingsScope,
		// 右来源字符串，例如项目包配置 source。
		rightSource: string,
		// 右来源所属范围，可能与左边不同。
		rightScope: SettingsScope,
	): boolean {
		// 原字符串完全一致立刻 true，即使同一相对文字在两层基准可指向不同路径。
		if (leftSource === rightSource) return true;
		// 任一方被分类为非本地且原文又不同，就不匹配；不做 npm/git 规范化。
		if (!isLocalPath(leftSource) || !isLocalPath(rightSource)) return false;
		// 左本地来源按左范围配置目录解析，并 trim 原输入。
		const left = resolvePath(leftSource, this.getTopLevelBaseDir(leftScope), { trim: true });
		// 右来源独立按右范围目录解析。
		const right = resolvePath(rightSource, this.getTopLevelBaseDir(rightScope), { trim: true });
		// 比较两绝对路径字符串，未 realpath，Windows 大小写也未另行折叠。
		return left === right;
	}

	// findMatchingPackageSource 在指定设置层副本中找首个匹配来源，返回字符串/对象或 undefined，不保存；例如查 project 不会退回全局包列表。
	private findMatchingPackageSource(item: ResourceItem, targetScope: SettingsScope): PackageSource | undefined {
		// 选择要查的原始设置层。
		const settings =
			// 目标范围是 project 时读取项目深副本。
			targetScope === "project"
				? // 项目 getter 不自动填全局默认包。
					this.settingsManager.getProjectSettings()
				: // 其他允许范围为 user，取用户设置深副本。
					this.settingsManager.getGlobalSettings();
		// 没 packages 按空数组，find 找到首项就停止；返回对象来自副本，不直接暴露管理器内部对象。
		return (settings.packages ?? []).find((pkg) =>
			// 比较器会处理双方范围基准，但其先原文相等规则仍适用。
			this.packageSourceStringMatches(
				// 左方来源为资源 metadata.source。
				item.metadata.source,
				// 左范围是资源原来源。
				this.getItemScope(item),
				// 右项可为字符串或对象，分别提取 source。
				typeof pkg === "string" ? pkg : pkg.source,
				// 右范围为当前查询的设置层。
				targetScope,
			),
		);
	}

	// getPatternEntryTarget 只去掉一个 !/+/- 首符号并返回字符串，不解析模式；例如 !!a 得 !a，普通 a 保持 a，无副作用。
	private getPatternEntryTarget(entry: string): string {
		// startsWith 三项任一为真就 slice(1)，否则原文，不递归剥离前缀。
		return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-") ? entry.slice(1) : entry;
	}

	// getResourceItemKey 拼资源类型和路径比较键，供初始全局继承 Map 使用；例如同路径的 skills/themes 是不同键，文件键可能尽量 realpath，合成路径原样。
	private getResourceItemKey(item: ResourceItem): string {
		// 模板插值组合 key；getResourcePathKey 对真实路径可探测 realpath，失败时使用其既定兜底，不是纯内容哈希或授权凭据。
		return `${item.resourceType}:${getResourcePathKey(item.path)}`;
	}

	// getItemScope 将元数据范围折成设置层范围，无保存；例 temporary 走 user，不表示 temporary 已获得信任或有独立保存层。
	private getItemScope(item: ResourceItem): SettingsScope {
		// 只对恰为 project 返回 project，其他两种来源值都返回 user。
		return item.metadata.scope === "project" ? "project" : "user";
	}

	// getTopLevelBaseDir 按设置范围返回路径字符串，无读写；例如项目 /work/app 得 /work/app/.pi，用户范围用实际 agentDir 而非写死主目录。
	private getTopLevelBaseDir(scope: "user" | "project"): string {
		// join 用当前平台分隔规则拼项目配置目录；user 直接返回构造传入目录。
		return scope === "project" ? join(this.cwd, CONFIG_DIR_NAME) : this.agentDir;
	}

	// getResourcePattern 为当前来源层生成顶层资源模式，builtin 保留合成 path，普通资源相对其 metadata.baseDir/配置目录；例如 agentDir/skills/a.md 得 skills/a.md，不改磁盘。
	private getResourcePattern(item: ResourceItem): string {
		// 内置路径无需 relative，保留 builtin: 以供后续解析器识别。
		if (item.metadata.source === "builtin") return item.path;
		// as 不做运行值转换；scope 非 project 时下方基准选择仍按用户分支处理。
		const scope = item.metadata.scope as "user" | "project";
		// 优先来源声明的基准目录，缺省才根据来源层兜底。
		const baseDir = item.metadata.baseDir ?? this.getTopLevelBaseDir(scope);
		// 返回相对字符串，目录外可带 ..，并非强制留在配置目录内的沙箱约束。
		return relative(baseDir, item.path);
	}

	// getPackageResourcePattern 将资源 path 相对 metadata.baseDir，缺基准时相对其父目录，返回规则文本，无扫描；例如包根 /pkg 的扩展文件得到 extensions/a.ts，缺 baseDir 则可能仅 a.ts。
	private getPackageResourcePattern(item: ResourceItem): string {
		// ?? 只在 null/undefined 回退 dirname(path)，不把空字符串当缺失。
		const baseDir = item.metadata.baseDir ?? dirname(item.path);
		// relative 返回平台风格的相对路径，不验证 metadata 真的是包根。
		return relative(baseDir, item.path);
	}
}

// ConfigSelectorComponent 组装标题/资源列表/边框，提供焦点透传和列表访问入口；CLI 聚焦 getResourceList()，外层 Container 自身没有 handleInput 自动转发。
export class ConfigSelectorComponent extends Container implements Focusable {
	// 标题组件实例，切模式时单独通知它。
	private header: ConfigSelectorHeader;
	// 资源列表实例，真正处理输入和写设置。
	private resourceList: ResourceList;
	// 外层保存一份当前模式，需与标题/列表同步。
	private writeScope: ConfigWriteScope;

	// 外层初始无焦点，private 仍仅为 TS 访问限制。
	private _focused = false;
	// focused getter 返回外层焦点标记，无状态修改；CLI 直接聚焦列表时这个外层标记不一定同步变 true。
	get focused(): boolean {
		// 读取外层字段，不反查内部列表焦点。
		return this._focused;
	}
	// focused setter 把外层焦点传给列表，再由列表传给 Input，返回隐式 void；例如宿主选择聚焦外层时也能传光标状态，但键盘仍需路由给列表。
	set focused(value: boolean) {
		// 先记录外层焦点。
		this._focused = value;
		// 触发 ResourceList 的焦点 setter，进一步更新搜索框。
		this.resourceList.focused = value;
	}

	// 构造完整配置面板，输入两套路径快照/管理器/目录/关闭退出重绘回调及可选高度模式；输出新组件，无资源重扫/执行/保存。
	// 流程：分别建两套组→标题→列表及回调→底边框。例如全局模式按 Tab 只切已有快照，projectModeAvailable 仅控制切换入口，真正项目写入信任由管理器检查。
	constructor(
		// 两套解析快照由宿主先算好，包含用户/项目覆盖下各自的 enabled。
		resolvedPaths: ScopedResolvedPaths,
		// 设置读写能力复用同一实例。
		settingsManager: SettingsManager,
		// 项目 cwd 供路径基准使用。
		cwd: string,
		// 实际用户配置目录，不要求默认 ~/.pi/agent。
		agentDir: string,
		// 关闭回调：取消不会回滚此前开关。
		onClose: () => void,
		// 退出回调：由 CLI 宿主决定是否结束进程。
		onExit: () => void,
		// 请求重绘的同步通知，不是渲染函数自身。
		requestRender: () => void,
		// 可选终端高度，缺省由 ResourceList 用24估算。
		terminalHeight?: number,
		// 缺模式时初始 global；显式 project 不会被下一布尔自动纠正。
		writeScope: ConfigWriteScope = "global",
		// 项目模式切换默认可用；宿主实际传 settingsManager.isProjectTrusted()，这里只接布尔，不运行信任判定。
		projectModeAvailable = true,
	) {
		// 派生类在访问 this 前必须 super()，初始化 Container 的 children 等字段。
		super();

		// 保存初始模式。
		this.writeScope = writeScope;
		// 新建两套组表，哪怕两个 resolved 输入是同一对象也各自重新构建 UI 行。
		const groupsByScope = {
			// 全局快照建独立组，用作全局模式和继承 enabled 基线。
			global: buildGroups(resolvedPaths.global, agentDir),
			// 项目快照也建独立组；后续修改 global 组不会自动同步这套 enabled。
			project: buildGroups(resolvedPaths.project, agentDir),
		};

		// Add header
		// 先加顶部空行，决定 Container 的输出顺序。
		this.addChild(new Spacer(1));
		// 加主题边框，不主动写终端。
		this.addChild(new DynamicBorder());
		// 标题前再留一行。
		this.addChild(new Spacer(1));
		// 标题接当前模式和可切换快照。
		this.header = new ConfigSelectorHeader(this.writeScope, projectModeAvailable);
		// 将标题纳入父 Container 渲染树。
		this.addChild(this.header);
		// 标题与资源列表之间加空白。
		this.addChild(new Spacer(1));

		// Resource list
		// 创建列表，真正的搜索/导航/设置操作都在其中。
		this.resourceList = new ResourceList(
			// 传两套已经分好组的数据。
			groupsByScope,
			// 传管理器引用，不创建新存储。
			settingsManager,
			// 传项目路径基准。
			cwd,
			// 传用户配置基准。
			agentDir,
			// 传可选高度，窗口大小只在列表构造时算一次。
			terminalHeight,
			// 传初始模式以同步外层/标题/列表。
			this.writeScope,
		);
		// 列表取消直接触发宿主关闭，没有撤销事务。
		this.resourceList.onCancel = onClose;
		// 列表退出交宿主实现，组件本身不决定退出码。
		this.resourceList.onExit = onExit;
		// 切换通知忽略 item/newEnabled 两参数，只请求重绘；回调不会等待设置队列。
		this.resourceList.onToggle = () => requestRender();
		// 只有允许项目模式才安装切换回调，不改初始 writeScope 本身。
		if (projectModeAvailable) {
			// 保存闭包，真正按模式切换键时才执行，不在构造时切换。
			this.resourceList.onSwitchMode = () => {
				// 同步更新外层、标题和列表模式，搜索保留但重新选首项。
				this.switchWriteScope();
				// 然后通知宿主绘制新视图。
				requestRender();
			};
		}
		// 把列表加到布局中；焦点仍需宿主主动设置。
		this.addChild(this.resourceList);

		// Bottom border
		// 列表后留空行。
		this.addChild(new Spacer(1));
		// 最后添加底边框完成面板。
		this.addChild(new DynamicBorder());
	}

	// switchWriteScope 在 global/project 之间切换并同步标题/列表，返回 void，不保存；例如 project→global 后使用保留搜索重建筛选，调用方另行 requestRender。
	private switchWriteScope(): void {
		// 三元表达式翻转当前模式，没有第三种模式。
		this.writeScope = this.writeScope === "global" ? "project" : "global";
		// 通知标题下次按新模式出文字。
		this.header.setWriteScope(this.writeScope);
		// 通知列表切组并按原搜索重新筛选，初始继承 Map 不重算。
		this.resourceList.setWriteScope(this.writeScope);
	}

	// getResourceList 返回实际内部列表对象，供 CLI 设置焦点/传输入，无复制或保存；例如 ui.setFocus(selector.getResourceList())。
	getResourceList(): ResourceList {
		// 返回原实例，外部可直接 handleInput，不是只读数据快照。
		return this.resourceList;
	}
}
