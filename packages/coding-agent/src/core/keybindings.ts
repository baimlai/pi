// 在TUI基础动作上加入Pi应用动作、平台默认键和旧配置名称迁移；管理器读取用户keybindings.json，再由界面实际匹配/执行动作。
// 声明合并只扩展TypeScript可用动作名，真正默认键来自运行时KEYBINDINGS；本文件读取/内存迁移配置，不把结果自动写回磁盘。
import {
	type Keybinding,
	type KeybindingDefinitions,
	type KeybindingsConfig,
	type KeyId,
	TUI_KEYBINDINGS,
	KeybindingsManager as TuiKeybindingsManager,
} from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Compile } from "typebox/compile";
import { getAgentDir } from "../config.ts";
import { stripBom } from "../utils/text.ts";
import { KeybindingValueSchema } from "./key-id-schema.ts";

// 输入平台及环境字典（默认真实进程值），返回是否采用Windows风格默认键，无文件/终端探测。
// 例如Linux有WSL_INTEROP采用Windows布局，只有WT_SESSION不采用；与utils/wsl.ts还读/proc的检测不同，不保证终端能区分每种组合键。
export function useWindowsKeybindings(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	// 原生Windows直接true，Linux仅看两个非空WSL标记；Boolean把字符串存在性转成布尔。
	return platform === "win32" || (platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP));
}

// 模块加载时固定这次环境判断，之后改process.env不会自动重建下面常量表。
const windowsKeybindings = useWindowsKeybindings();

// 每项含默认按键和说明；同一个键可用于多个页面动作，谁先响应由当前组件/模式决定，不在此统一驱逐“冲突”动作。
// as const保留键名/默认键字面量类型，satisfies检查表形状但不把变量宽化为任意字符串索引表；两者都不做运行时冻结。
const APP_KEYBINDINGS = {
	// Escape取消/中止，Ctrl+C清输入，Ctrl+D仅在输入为空时由界面解释为退出。
	"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
	"app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
	"app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
	"app.suspend": {
		// 原生Windows默认禁用挂起，WSL的process.platform仍是linux，故保留Ctrl+Z。
		defaultKeys: process.platform === "win32" ? [] : "ctrl+z",
		description: "Suspend to background",
	},
	"app.thinking.cycle": {
		// Shift+Tab轮换思考等级；这里只声明动作，不向模型发送参数。
		defaultKeys: "shift+tab",
		description: "Cycle thinking level",
	},
	"app.thinking.save": {
		// 在思考选择器把当前等级设为默认；Ctrl+S可在别的界面代表另一动作。
		defaultKeys: "ctrl+s",
		description: "Save thinking level",
	},
	"app.model.cycleForward": {
		// 默认Ctrl+P轮换到下一个模型，具体候选集合由会话界面维护。
		defaultKeys: "ctrl+p",
		description: "Cycle to next model",
	},
	"app.model.cycleBackward": {
		// Windows风格用Alt+P，否则Shift+Ctrl+P，避免部分终端组合键难以区分。
		defaultKeys: windowsKeybindings ? "alt+p" : "shift+ctrl+p",
		description: "Cycle to previous model",
	},
	// 模型选择器与工具输出折叠切换，绑定只是默认值，可由用户覆盖。
	"app.model.select": { defaultKeys: "ctrl+l", description: "Open model selector" },
	"app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
	"app.thinking.toggle": {
		// 控制思考块可见性，区别于上面切换模型思考等级。
		defaultKeys: "ctrl+t",
		description: "Toggle thinking blocks",
	},
	"app.session.toggleNamedFilter": {
		// 会话选择器切换只看命名会话的筛选状态。
		defaultKeys: "ctrl+n",
		description: "Toggle named session filter",
	},
	"app.editor.external": {
		// 打开外部编辑器的动作，编辑器命令/子进程由实际处理器决定。
		defaultKeys: "ctrl+g",
		description: "Open external editor",
	},
	"app.message.copy": {
		// 复制当前选区或最近助手消息，实际剪贴板适配不在本表执行。
		defaultKeys: "ctrl+x",
		description: "Copy selection or last assistant message",
	},
	"app.message.followUp": {
		// 将输入排为后续消息，Windows风格改用Ctrl+Q，否则Alt+Enter。
		defaultKeys: windowsKeybindings ? "ctrl+q" : "alt+enter",
		description: "Queue follow-up message",
	},
	"app.message.dequeue": {
		// 从队列取回待发送文字；Windows风格Alt+Q，其余Alt+Up。
		defaultKeys: windowsKeybindings ? "alt+q" : "alt+up",
		description: "Restore queued messages",
	},
	"app.clipboard.pasteImage": {
		// 动作名沿用pasteImage，实际界面还可粘文件路径/文字；Windows风格Alt+V，否则Ctrl+V。
		defaultKeys: windowsKeybindings ? "alt+v" : "ctrl+v",
		description: "Paste files on macOS, images, or text from clipboard",
	},
	// 空数组表示默认不分配按键，不代表功能不存在；用户仍可给新建/树/分叉/恢复动作绑定键。
	"app.session.new": { defaultKeys: [], description: "Start a new session" },
	"app.session.tree": { defaultKeys: [], description: "Open session tree" },
	"app.session.fork": { defaultKeys: [], description: "Fork current session" },
	"app.session.resume": { defaultKeys: [], description: "Resume a session" },
	"app.tree.foldOrUp": {
		// 会话树优先折叠当前可折叠项，否则沿可见父链跳分支段起点；macOS把Alt别名放前，其余把Ctrl放前。
		defaultKeys: process.platform === "darwin" ? ["alt+left", "ctrl+left"] : ["ctrl+left", "alt+left"],
		description: "Fold tree branch or move up",
	},
	"app.tree.unfoldOrDown": {
		// 当前折叠则展开，否则沿可见首子链跳分支段起点/末端；数组给同一动作提供多个别名。
		defaultKeys: process.platform === "darwin" ? ["alt+right", "ctrl+right"] : ["ctrl+right", "alt+right"],
		description: "Unfold tree branch or move down",
	},
	"app.tree.editLabel": {
		// Shift+L编辑树条目标签。
		defaultKeys: "shift+l",
		description: "Edit tree label",
	},
	"app.tree.toggleLabelTimestamp": {
		// Shift+T切换树标签的时间戳展示。
		defaultKeys: "shift+t",
		description: "Toggle tree label timestamps",
	},
	"app.session.togglePath": {
		// 会话选择界面切换路径展示，不是模型轮换；二者共享Ctrl+P由界面路由区分。
		defaultKeys: "ctrl+p",
		description: "Toggle session path display",
	},
	"app.session.toggleSort": {
		// 切换会话列表排序模式。
		defaultKeys: "ctrl+s",
		description: "Toggle session sort mode",
	},
	"app.session.rename": {
		// 重命名所选会话，实际落盘由会话处理器完成。
		defaultKeys: "ctrl+r",
		description: "Rename session",
	},
	"app.session.delete": {
		// 会话列表删除动作，不会因为注册这个键就立即删文件。
		defaultKeys: "ctrl+d",
		description: "Delete session",
	},
	"app.session.deleteNoninvasive": {
		// 查询为空时使用的删除动作，是否满足该条件由列表处理器判断。
		defaultKeys: "ctrl+backspace",
		description: "Delete session when query is empty",
	},
	"app.models.save": {
		// 模型选择/排序界面保存当前配置。
		defaultKeys: "ctrl+s",
		description: "Save model selection",
	},
	"app.models.enableAll": {
		// 模型列表全选、清空选择、按提供商批量切换三个不同动作。
		defaultKeys: "ctrl+a",
		description: "Enable all models",
	},
	"app.models.clearAll": {
		// 清空模型选择，默认Ctrl+X。
		defaultKeys: "ctrl+x",
		description: "Clear all models",
	},
	"app.models.toggleProvider": {
		// 对某提供商的模型组整体切换选中状态。
		defaultKeys: "ctrl+p",
		description: "Toggle all models for provider",
	},
	"app.models.reorderUp": {
		// 在候选模型顺序中上移当前项。
		defaultKeys: "alt+up",
		description: "Move model up in order",
	},
	"app.models.reorderDown": {
		// 在候选模型顺序中下移当前项。
		defaultKeys: "alt+down",
		description: "Move model down in order",
	},
	"app.tree.filter.default": {
		// 会话树默认筛选视图。
		defaultKeys: "ctrl+d",
		description: "Tree filter: default view",
	},
	"app.tree.filter.noTools": {
		// 隐藏工具结果的树视图，不删除会话里的工具记录。
		defaultKeys: "ctrl+t",
		description: "Tree filter: hide tool results",
	},
	"app.tree.filter.userOnly": {
		// 树中只展示用户消息条目。
		defaultKeys: "ctrl+u",
		description: "Tree filter: user messages only",
	},
	"app.tree.filter.labeledOnly": {
		// 树中只展示带标签的条目。
		defaultKeys: "ctrl+l",
		description: "Tree filter: labeled entries only",
	},
	"app.tree.filter.all": {
		// 树中展示全部条目，与默认筛选区分。
		defaultKeys: "ctrl+a",
		description: "Tree filter: show all entries",
	},
	"app.tree.filter.cycleForward": {
		// 向前轮换筛选模式，不改变磁盘历史。
		defaultKeys: "ctrl+o",
		description: "Tree filter: cycle forward",
	},
	"app.tree.filter.cycleBackward": {
		// 反向轮换筛选模式。
		defaultKeys: "shift+ctrl+o",
		description: "Tree filter: cycle backward",
	},
} as const satisfies KeybindingDefinitions;

// keyof typeof从运行时常量的类型提取所有应用动作名联合，再映射成值为true的接口占位字段。
export type AppKeybinding = keyof typeof APP_KEYBINDINGS;
export type AppKeybindings = { [K in AppKeybinding]: true };

// 模块扩充让TUI的Keybinding联合认识这些动作；这是类型声明，不会在运行时导入另一份注册表或自动给组件挂键盘监听。
declare module "@earendil-works/pi-tui" {
	interface Keybindings extends AppKeybindings {}
}

// 先展开TUI默认定义，再覆盖少数平台键，最后加入应用动作；后写同名属性覆盖先写值。
export const KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	"tui.editor.undo": {
		// 保留TUI动作说明，只替换键：Windows Ctrl+Z，WSL Alt+Z，其余Ctrl+-。
		...TUI_KEYBINDINGS["tui.editor.undo"],
		defaultKeys: process.platform === "win32" ? "ctrl+z" : windowsKeybindings ? "alt+z" : "ctrl+-",
	},
	"tui.altScreen.previousPrompt": {
		// Windows风格只给Ctrl+Up，其余保留Ctrl+Shift+Up和Ctrl+Up别名。
		...TUI_KEYBINDINGS["tui.altScreen.previousPrompt"],
		defaultKeys: windowsKeybindings ? "ctrl+up" : ["ctrl+shift+up", "ctrl+up"],
	},
	"tui.altScreen.nextPrompt": {
		// 跳到下一个提示点，键位策略与上一项相对。
		...TUI_KEYBINDINGS["tui.altScreen.nextPrompt"],
		defaultKeys: windowsKeybindings ? "ctrl+down" : ["ctrl+shift+down", "ctrl+down"],
	},
	"tui.altScreen.search": {
		// 全屏搜索在Windows风格用Ctrl+F，其他平台Ctrl+Shift+F。
		...TUI_KEYBINDINGS["tui.altScreen.search"],
		defaultKeys: windowsKeybindings ? "ctrl+f" : "ctrl+shift+f",
	},
	...APP_KEYBINDINGS,
} as const satisfies KeybindingDefinitions;

// 旧用户配置动作名→当前带命名空间的名字；只迁移名字，不改用户提供的按键值，也不是别名长期同时注册。
// 光标/编辑动作集中归tui.editor，输入提交归tui.input，列表选择归tui.select，其余Pi界面功能归app。
const KEYBINDING_NAME_MIGRATIONS = {
	cursorUp: "tui.editor.cursorUp",
	cursorDown: "tui.editor.cursorDown",
	cursorLeft: "tui.editor.cursorLeft",
	cursorRight: "tui.editor.cursorRight",
	cursorWordLeft: "tui.editor.cursorWordLeft",
	cursorWordRight: "tui.editor.cursorWordRight",
	cursorLineStart: "tui.editor.cursorLineStart",
	cursorLineEnd: "tui.editor.cursorLineEnd",
	jumpForward: "tui.editor.jumpForward",
	jumpBackward: "tui.editor.jumpBackward",
	pageUp: "tui.editor.pageUp",
	pageDown: "tui.editor.pageDown",
	deleteCharBackward: "tui.editor.deleteCharBackward",
	deleteCharForward: "tui.editor.deleteCharForward",
	deleteWordBackward: "tui.editor.deleteWordBackward",
	deleteWordForward: "tui.editor.deleteWordForward",
	deleteToLineStart: "tui.editor.deleteToLineStart",
	deleteToLineEnd: "tui.editor.deleteToLineEnd",
	// 删除记录粘回/撤销沿用编辑器动作，非系统剪贴板。
	yank: "tui.editor.yank",
	yankPop: "tui.editor.yankPop",
	undo: "tui.editor.undo",
	// 输入框的换行、提交、补全和复制旧名。
	newLine: "tui.input.newLine",
	submit: "tui.input.submit",
	tab: "tui.input.tab",
	copy: "tui.input.copy",
	// 选择列表方向、翻页、确认、取消旧名。
	selectUp: "tui.select.up",
	selectDown: "tui.select.down",
	selectPageUp: "tui.select.pageUp",
	selectPageDown: "tui.select.pageDown",
	selectConfirm: "tui.select.confirm",
	selectCancel: "tui.select.cancel",
	// 应用级中断、清空、退出、挂起；迁移只保留配置，动作语义由应用实现。
	interrupt: "app.interrupt",
	clear: "app.clear",
	exit: "app.exit",
	suspend: "app.suspend",
	// 思考等级/模型选择/工具显示/外部编辑器等交互动作旧名。
	cycleThinkingLevel: "app.thinking.cycle",
	cycleModelForward: "app.model.cycleForward",
	cycleModelBackward: "app.model.cycleBackward",
	selectModel: "app.model.select",
	expandTools: "app.tools.expand",
	toggleThinking: "app.thinking.toggle",
	toggleSessionNamedFilter: "app.session.toggleNamedFilter",
	externalEditor: "app.editor.external",
	// 消息排队与剪贴板粘贴动作旧名。
	followUp: "app.message.followUp",
	dequeue: "app.message.dequeue",
	pasteImage: "app.clipboard.pasteImage",
	// 会话创建、树、分叉、恢复入口旧名。
	newSession: "app.session.new",
	tree: "app.session.tree",
	fork: "app.session.fork",
	resume: "app.session.resume",
	// 会话树导航和标签动作旧名。
	treeFoldOrUp: "app.tree.foldOrUp",
	treeUnfoldOrDown: "app.tree.unfoldOrDown",
	treeEditLabel: "app.tree.editLabel",
	treeToggleLabelTimestamp: "app.tree.toggleLabelTimestamp",
	// 会话选择器路径、排序、改名和删除动作旧名。
	toggleSessionPath: "app.session.togglePath",
	toggleSessionSort: "app.session.toggleSort",
	renameSession: "app.session.rename",
	deleteSession: "app.session.delete",
	deleteSessionNoninvasive: "app.session.deleteNoninvasive",
} as const satisfies Record<string, Keybinding>;

// 输入字符串，返回它是否能通过in在迁移表找到；类型谓词让成功分支可索引表，无I/O。
// 例如cursorUp命中；in也查原型链，不能将本检查说成严格验证“自有且已声明的旧动作名”。
function isLegacyKeybindingName(key: string): key is keyof typeof KEYBINDING_NAME_MIGRATIONS {
	return key in KEYBINDING_NAME_MIGRATIONS;
}

// 模块加载时编译一次按键值schema，后续只Check值；不会把default键注入用户JSON或自动校验动作名称。
const validateKeybindingValue = Compile(KeybindingValueSchema);

// 输入原始键值对象，忽略$schema，仅把通过共享按键值规则的项收进新配置，返回值不写盘。
// 例如"ctrl+x"和[]有效，123无效被忽略；未知动作名若值有效仍可保留，最终TUI管理器只为自身定义的动作建立有效键表。
function toKeybindingsConfig(value: Record<string, unknown>): KeybindingsConfig {
	const config: KeybindingsConfig = {};
	// Object.entries只遍历自有可枚举项，binding为unknown，必须过JSON配置边界的schema检查。
	for (const [key, binding] of Object.entries(value)) {
		// 编辑器schema关联字段不是动作名，无需拿其URL当按键值检查。
		if (key === "$schema") continue;
		// Check同时收窄binding类型；不trim、规范修饰键顺序或修复坏值。
		if (validateKeybindingValue.Check(binding)) config[key] = binding;
	}
	return config;
}

// 输入原始动作配置，返回按标准顺序排列的新对象及是否发生名称迁移，保留未知键/值，不读写文件。
// 例如expandTools→app.tools.expand；若新旧名都存在，优先原对象自有的新名，即便新名的值之后会因无效被过滤。
// migrated只记录名字迁移/旧项舍弃，单纯重排或值过滤不代表迁移；此函数也不自行验证所有输入值。
export function migrateKeybindingsConfig(rawConfig: Record<string, unknown>): {
	config: Record<string, unknown>;
	migrated: boolean;
} {
	const config: Record<string, unknown> = {};
	let migrated = false;

	for (const [key, value] of Object.entries(rawConfig)) {
		// 三元表达式把已认识的旧名换新名，其他字符串原样；值对象/数组不会被深复制。
		const nextKey = isLegacyKeybindingName(key) ? KEYBINDING_NAME_MIGRATIONS[key] : key;
		if (nextKey !== key) {
			migrated = true;
		}
		// hasOwn只看原对象自有新名，避免旧项因遍历顺序覆盖显式新配置。
		if (key !== nextKey && Object.hasOwn(rawConfig, nextKey)) {
			migrated = true;
			continue;
		}
		// 动态键写入普通对象，后续统一排序；不在此写回keybindings.json。
		config[nextKey] = value;
	}

	// 对象属性简写migrated保留布尔结果，排序产生另一个外层对象。
	return { config: orderKeybindingsConfig(config), migrated };
}

// 输入配置对象，先按KEYBINDINGS声明顺序列出已知动作，再把剩余自有键按字符串排序，返回新对象，不改原值引用。
// 例如app.interrupt在默认表顺序位置，未知custom.foo排到末尾；排序便于输出稳定，不决定按键响应优先级。
function orderKeybindingsConfig(config: Record<string, unknown>): Record<string, unknown> {
	const ordered: Record<string, unknown> = {};
	for (const keybinding of Object.keys(KEYBINDINGS)) {
		// 只复制原配置确有的键，不用默认值补齐未配置动作。
		if (Object.hasOwn(config, keybinding)) {
			ordered[keybinding] = config[keybinding];
		}
	}

	const extras = Object.keys(config)
		// 排除已收集项，再默认按UTF-16字符串顺序排序其余键名。
		.filter((key) => !Object.hasOwn(ordered, key))
		.sort();
	for (const key of extras) {
		ordered[key] = config[key];
	}

	return ordered;
}

// 输入路径，同步读UTF8去BOM并JSON解析，非null对象返回，缺文件/解析读取异常/非对象返回undefined；不打印、不写盘。
// 例如损坏JSON使调用方退默认；这里只排除null和非对象，没有排除数组，数组元素仍可能被后续Object.entries当键值遍历。
function loadRawConfig(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		// JSON.parse结果先视为unknown，不能因as就假定外部配置符合预期。
		const parsed = JSON.parse(stripBom(readFileSync(path, "utf-8"))) as unknown;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		// 断言只告诉TS后续按记录访问，不增加运行时形状检查。
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

// 继承TUI的匹配/默认覆盖/冲突查询，额外提供Pi默认表与磁盘读取；不会自行注册键盘监听或执行动作。
export class KeybindingsManager extends TuiKeybindingsManager {
	// 可省略路径表示仅内存配置，reload此时无动作；private是TS访问限制，不是运行时安全隔离。
	private configPath: string | undefined;

	// 输入已提供的用户覆盖及可选重载路径，调用父类立即建立有效绑定；不在构造时读文件，示例new KeybindingsManager({"app.interrupt":"ctrl+x"})。
	constructor(userBindings: KeybindingsConfig = {}, configPath?: string) {
		// super必须在使用this前执行，父类合并KEYBINDINGS与覆盖；[]禁用动作，undefined沿用默认。
		super(KEYBINDINGS, userBindings);
		this.configPath = configPath;
	}

	// 输入可选agent配置目录，读keybindings.json并返回带该重载路径的实例；例如测试传临时目录，文件错误安静退默认，不落盘。
	static create(agentDir: string = getAgentDir()): KeybindingsManager {
		// 默认参数在调用时求值，和上面模块级windowsKeybindings一次求值不同。
		const configPath = join(agentDir, "keybindings.json");
		const userBindings = KeybindingsManager.loadFromFile(configPath);
		return new KeybindingsManager(userBindings, configPath);
	}

	// 无输入/返回值，有配置路径则重新读取并整体替换用户覆盖；例如文件损坏会恢复默认，不保留上次有效覆盖，也不写磁盘。
	reload(): void {
		if (!this.configPath) return;
		// 父类setUserBindings重建有效键表和冲突信息，已持有配置副本的调用方不会自动得到通知。
		this.setUserBindings(KeybindingsManager.loadFromFile(this.configPath));
	}

	// 无输入，返回当前所有已定义动作的有效配置新对象；例：默认+覆盖合并后的单键字符串/多键数组/无键[]，不含未知动作项。
	getEffectiveConfig(): KeybindingsConfig {
		// 父类为返回的多键数组复制容器，不把内部Map直接暴露给调用者。
		return this.getResolvedBindings();
	}

	// 输入配置路径，串起读取→旧名迁移/排序→值schema过滤，返回可交父类的覆盖表；例如旧interrupt在内存变app.interrupt，文件本身不变。
	private static loadFromFile(path: string): KeybindingsConfig {
		const rawConfig = loadRawConfig(path);
		// 缺失/坏文件用空覆盖，父类随后采用默认；不是把默认表写成一份用户配置。
		if (!rawConfig) return {};
		return toKeybindingsConfig(migrateKeybindingsConfig(rawConfig).config);
	}
}

// type转导出只供开发期使用，不会再创建这些类型的运行时对象。
export type { Keybinding, KeyId, KeybindingsConfig };
