// 把动作名映射到默认或用户配置的按键，并提供匹配、冲突查询；Input/Editor/列表读取这些动作，TuiAltScreen 按当前模式路由。
// KeyId 是编译期合法按键字符串类型，matchesKey 负责运行时终端序列解析，不是简单字符串相等。
import { type KeyId, matchesKey } from "./keys.ts";

/**
 * Global keybinding registry.
 * Downstream packages can add keybindings via declaration merging.
 */
// 可通过声明合并扩展的动作名接口；例如 coding-agent 声明 AppKeybindings 扩充它。这里只声明允许的键，true 是类型占位，不代表已启用或已经绑定按键。
export interface Keybindings {
	// Editor navigation and editing
	// 编辑区向上一行的动作名。
	"tui.editor.cursorUp": true;
	// 编辑区向下一行。
	"tui.editor.cursorDown": true;
	// 前一条输入历史，具体组件决定怎样切换。
	"tui.editor.historyPrevious": true;
	// 后一条输入历史。
	"tui.editor.historyNext": true;
	// 向左移动光标，Input/Editor 通常按字素处理。
	"tui.editor.cursorLeft": true;
	// 向右移动光标。
	"tui.editor.cursorRight": true;
	// 向左按词边界移动。
	"tui.editor.cursorWordLeft": true;
	// 向右按词边界移动。
	"tui.editor.cursorWordRight": true;
	// 移到当前行起点。
	"tui.editor.cursorLineStart": true;
	// 移到当前行终点。
	"tui.editor.cursorLineEnd": true;
	// 开始向前找指定字符的编辑动作。
	"tui.editor.jumpForward": true;
	// 开始向后找指定字符。
	"tui.editor.jumpBackward": true;
	// 编辑区向上翻页，区别于后面的全屏视口滚动。
	"tui.editor.pageUp": true;
	// 编辑区向下翻页。
	"tui.editor.pageDown": true;
	// 删除光标左侧字符的动作。
	"tui.editor.deleteCharBackward": true;
	// 删除光标右侧字符。
	"tui.editor.deleteCharForward": true;
	// 向后删词，组件可把删文加入删除记录环。
	"tui.editor.deleteWordBackward": true;
	// 向前删词。
	"tui.editor.deleteWordForward": true;
	// 删到行首。
	"tui.editor.deleteToLineStart": true;
	// 删到行尾。
	"tui.editor.deleteToLineEnd": true;
	// 从删除记录环粘回文本，非系统剪贴板操作。
	"tui.editor.yank": true;
	// 轮换刚粘回的删除记录。
	"tui.editor.yankPop": true;
	// 撤销一次或一组编辑，合并粒度由组件决定。
	"tui.editor.undo": true;
	// Generic input actions
	// 插入换行；单行 Input 不一定采用多行 Editor 的换行处理。
	"tui.input.newLine": true;
	// 提交输入，由组件调用自己的提交回调。
	"tui.input.submit": true;
	// Tab/补全动作，如何补全由组件决定。
	"tui.input.tab": true;
	// 复制选择内容，真正的复制逻辑在上游。
	"tui.input.copy": true;
	// Generic selection actions
	// 选择列表向上移项。
	"tui.select.up": true;
	// 选择列表向下移项。
	"tui.select.down": true;
	// 选择列表向上翻一页。
	"tui.select.pageUp": true;
	// 选择列表向下翻一页。
	"tui.select.pageDown": true;
	// 确认当前选择。
	"tui.select.confirm": true;
	// 取消当前选择或面板。
	"tui.select.cancel": true;
	// Alternate-screen viewport navigation
	// 全屏内容视口向上滚一页。
	"tui.altScreen.pageUp": true;
	// 全屏视口向下滚一页。
	"tui.altScreen.pageDown": true;
	// 全屏视口向上滚半页。
	"tui.altScreen.halfPageUp": true;
	// 全屏视口向下滚半页。
	"tui.altScreen.halfPageDown": true;
	// 全屏视口向上滚一行。
	"tui.altScreen.lineUp": true;
	// 全屏视口向下滚一行。
	"tui.altScreen.lineDown": true;
	// 跳到前一个语义提示位置，不是切换编辑历史。
	"tui.altScreen.previousPrompt": true;
	// 跳到后一个语义提示位置。
	"tui.altScreen.nextPrompt": true;
	// 在主要滚动区域搜索。
	"tui.altScreen.search": true;
	// 选择下一个搜索命中。
	"tui.altScreen.searchNext": true;
	// 选择上一个搜索命中。
	"tui.altScreen.searchPrevious": true;
	// 关闭全屏内容搜索。
	"tui.altScreen.searchClose": true;
	// 滚到主要视口的顶部。
	"tui.altScreen.top": true;
	// 滚到主要视口的底部。
	"tui.altScreen.bottom": true;
}

// keyof 提取接口全部属性名组成字符串联合；声明合并后下游动作也进入该类型，不会自动进入运行时定义表。
export type Keybinding = keyof Keybindings;

// 一个动作的默认定义，接口只约束形状，是否被组件使用还取决于具体输入处理分支。
export interface KeybindingDefinition {
	// 可给单个 KeyId 或多个别名数组；[] 表示默认不绑定任何键。
	defaultKeys: KeyId | KeyId[];
	// 可选说明供配置/帮助界面显示，不执行行为。
	description?: string;
}

// Record 表示按字符串索引的定义表，不要求运行时每个名字都已经在 Keybindings 接口中声明。
export type KeybindingDefinitions = Record<string, KeybindingDefinition>;
// 用户覆盖表：一项可为单键、多键或 undefined；管理器里 undefined 回退默认，[] 才是明确禁用，原对象可能仍包含未知动作名。
export type KeybindingsConfig = Record<string, KeyId | KeyId[] | undefined>;

// 运行时默认表，单独的 interface 声明不会生成它。以下每项 defaultKeys 定义输入别名，description 是人类说明；多动作允许共享一个键，优先级由当前模式/组件分支决定。
export const TUI_KEYBINDINGS = {
	// 编辑向上默认 Up，描述说明它移动编辑光标。
	"tui.editor.cursorUp": { defaultKeys: "up", description: "Move cursor up" },
	// 编辑向下默认 Down。
	"tui.editor.cursorDown": { defaultKeys: "down", description: "Move cursor down" },
	// 前一条历史动作的定义。
	"tui.editor.historyPrevious": {
		// 默认空数组，所以仅声明动作、不开箱绑定。
		defaultKeys: [],
		// 说明用于展示“选择上一条历史”，不自动执行选择。
		description: "Select previous prompt history entry",
	},
	// 后一条历史动作的定义。
	"tui.editor.historyNext": {
		// 同样默认无按键。
		defaultKeys: [],
		// 展示用说明为“选择下一条历史”。
		description: "Select next prompt history entry",
	},
	// 编辑左移可使用箭头或 Emacs 风格别名。
	"tui.editor.cursorLeft": {
		// 两个独立按键别名 Left/Ctrl+B，匹配任一即可触发。
		defaultKeys: ["left", "ctrl+b"],
		// 左移的显示说明。
		description: "Move cursor left",
	},
	// 编辑右移的定义。
	"tui.editor.cursorRight": {
		// Right 与 Ctrl+F 都可匹配。
		defaultKeys: ["right", "ctrl+f"],
		// 右移说明。
		description: "Move cursor right",
	},
	// 向左按词移动的定义。
	"tui.editor.cursorWordLeft": {
		// Alt+Left、Ctrl+Left、Alt+B 三种默认别名，实际终端序列由 matchesKey 识别。
		defaultKeys: ["alt+left", "ctrl+left", "alt+b"],
		// 按词左移说明。
		description: "Move cursor word left",
	},
	// 向右按词移动的定义。
	"tui.editor.cursorWordRight": {
		// Alt+Right、Ctrl+Right、Alt+F 是等价入口。
		defaultKeys: ["alt+right", "ctrl+right", "alt+f"],
		// 按词右移说明。
		description: "Move cursor word right",
	},
	// 行首动作定义。
	"tui.editor.cursorLineStart": {
		// Home 与 Ctrl+A 共同作为默认别名。
		defaultKeys: ["home", "ctrl+a"],
		// 说明展示移到行首。
		description: "Move to line start",
	},
	// 行尾动作定义。
	"tui.editor.cursorLineEnd": {
		// End 与 Ctrl+E 共同作为默认别名。
		defaultKeys: ["end", "ctrl+e"],
		// 说明展示移到行尾。
		description: "Move to line end",
	},
	// 开始向前找字符的动作。
	"tui.editor.jumpForward": {
		// 默认 Ctrl+]，此处是按键标识文字，不是原始终端字节。
		defaultKeys: "ctrl+]",
		// 展示说明为向前跳到字符。
		description: "Jump forward to character",
	},
	// 开始向后找字符的动作。
	"tui.editor.jumpBackward": {
		// 默认 Ctrl+Alt+]。
		defaultKeys: "ctrl+alt+]",
		// 向后找字符的展示说明。
		description: "Jump backward to character",
	},
	// 编辑翻上页默认 PageUp 或 Ctrl+PageUp；是否交给全屏视口由宿主先决定。
	"tui.editor.pageUp": { defaultKeys: ["pageUp", "ctrl+pageUp"], description: "Page up" },
	// 编辑翻下页默认 PageDown 或 Ctrl+PageDown。
	"tui.editor.pageDown": { defaultKeys: ["pageDown", "ctrl+pageDown"], description: "Page down" },
	// 向后删除字符的定义。
	"tui.editor.deleteCharBackward": {
		// 默认 Backspace。
		defaultKeys: "backspace",
		// 后删字符的显示说明。
		description: "Delete character backward",
	},
	// 向前删除字符的定义。
	"tui.editor.deleteCharForward": {
		// Delete 与 Ctrl+D 是默认别名。
		defaultKeys: ["delete", "ctrl+d"],
		// 前删字符的显示说明。
		description: "Delete character forward",
	},
	// 向后删词定义。
	"tui.editor.deleteWordBackward": {
		// Ctrl+W 或 Alt+Backspace，组件自己决定分词与删除记录。
		defaultKeys: ["ctrl+w", "alt+backspace"],
		// 后删词说明。
		description: "Delete word backward",
	},
	// 向前删词定义。
	"tui.editor.deleteWordForward": {
		// Alt+D 或 Alt+Delete。
		defaultKeys: ["alt+d", "alt+delete"],
		// 前删词说明。
		description: "Delete word forward",
	},
	// 删除到行首的定义。
	"tui.editor.deleteToLineStart": {
		// 默认 Ctrl+U。
		defaultKeys: "ctrl+u",
		// 删到行首的说明。
		description: "Delete to line start",
	},
	// 删除到行尾的定义。
	"tui.editor.deleteToLineEnd": {
		// 默认 Ctrl+K。
		defaultKeys: "ctrl+k",
		// 删到行尾的说明。
		description: "Delete to line end",
	},
	// yank 默认 Ctrl+Y，从组件的删除记录环粘回。
	"tui.editor.yank": { defaultKeys: "ctrl+y", description: "Yank" },
	// yank-pop 默认 Alt+Y，通常必须接着 yank 使用。
	"tui.editor.yankPop": { defaultKeys: "alt+y", description: "Yank pop" },
	// 撤销默认 Ctrl+-，coding-agent 可在它自己的组合定义表按平台覆盖。
	"tui.editor.undo": { defaultKeys: "ctrl+-", description: "Undo" },
	// 换行有 Shift+Enter 与 Ctrl+J 两个默认入口。
	"tui.input.newLine": { defaultKeys: ["shift+enter", "ctrl+j"], description: "Insert newline" },
	// 提交默认 Enter，与选择确认共享键不构成自动排他关系。
	"tui.input.submit": { defaultKeys: "enter", description: "Submit input" },
	// Tab 默认用于 Tab/自动补全动作。
	"tui.input.tab": { defaultKeys: "tab", description: "Tab / autocomplete" },
	// 复制默认 Ctrl+C，与选择取消共享键，路由上下文决定执行哪一种。
	"tui.input.copy": { defaultKeys: "ctrl+c", description: "Copy selection" },
	// 列表上移默认 Up，保留编辑 Up 绑定，不会从别的动作里驱逐它。
	"tui.select.up": { defaultKeys: "up", description: "Move selection up" },
	// 列表下移默认 Down。
	"tui.select.down": { defaultKeys: "down", description: "Move selection down" },
	// 列表上翻页默认 PageUp。
	"tui.select.pageUp": { defaultKeys: "pageUp", description: "Selection page up" },
	// 列表下翻页的定义。
	"tui.select.pageDown": {
		// 默认 PageDown。
		defaultKeys: "pageDown",
		// 向下翻选择页的说明。
		description: "Selection page down",
	},
	// 列表确认默认 Enter，输入提交被用户改绑后不会因此自动取消本绑定。
	"tui.select.confirm": { defaultKeys: "enter", description: "Confirm selection" },
	// 选择取消定义。
	"tui.select.cancel": {
		// Escape 或 Ctrl+C 均可取消，具体语义由当前组件决定。
		defaultKeys: ["escape", "ctrl+c"],
		// 展示说明为取消选择。
		description: "Cancel selection",
	},
	// These intentionally shadow the unmodified editor bindings in fullscreen mode.
	// 全屏视口上翻页定义，宿主可先于普通编辑器消费同键。
	"tui.altScreen.pageUp": {
		// 默认未加修饰的 PageUp。
		defaultKeys: "pageUp",
		// 说明为视口向上滚一页。
		description: "Scroll viewport up one page",
	},
	// 全屏视口下翻页定义。
	"tui.altScreen.pageDown": {
		// 默认 PageDown。
		defaultKeys: "pageDown",
		// 说明为视口向下滚一页。
		description: "Scroll viewport down one page",
	},
	// 视口向上半页定义。
	"tui.altScreen.halfPageUp": {
		// 默认无键，可由用户显式配置。
		defaultKeys: [],
		// 半页上滚说明。
		description: "Scroll viewport up half a page",
	},
	// 视口向下半页定义。
	"tui.altScreen.halfPageDown": {
		// 默认同样不绑定。
		defaultKeys: [],
		// 半页下滚说明。
		description: "Scroll viewport down half a page",
	},
	// 视口向上一行定义。
	"tui.altScreen.lineUp": {
		// 默认不绑定专用键。
		defaultKeys: [],
		// 逐行上滚说明。
		description: "Scroll viewport up one line",
	},
	// 视口向下一行定义。
	"tui.altScreen.lineDown": {
		// 默认不绑定。
		defaultKeys: [],
		// 逐行下滚说明。
		description: "Scroll viewport down one line",
	},
	// 前一语义提示位置定义。
	"tui.altScreen.previousPrompt": {
		// Ctrl+Shift+Up 与 Ctrl+Up 两个默认别名。
		defaultKeys: ["ctrl+shift+up", "ctrl+up"],
		// 展示说明，真正位置由终端语义标记/布局计算。
		description: "Jump to previous semantic prompt",
	},
	// 后一语义提示位置定义。
	"tui.altScreen.nextPrompt": {
		// Ctrl+Shift+Down 与 Ctrl+Down。
		defaultKeys: ["ctrl+shift+down", "ctrl+down"],
		// 跳到后续提示位置的说明。
		description: "Jump to next semantic prompt",
	},
	// 全屏搜索入口定义。
	"tui.altScreen.search": {
		// 默认 Ctrl+Shift+F，具体应用可在外层组合定义中覆盖。
		defaultKeys: "ctrl+shift+f",
		// 搜索目标说明为主要滚动视图。
		description: "Search the primary scroll view",
	},
	// 搜索下一项的定义。
	"tui.altScreen.searchNext": {
		// 搜索模式下 Enter 或 Ctrl+G，路由不同于普通输入提交。
		defaultKeys: ["enter", "ctrl+g"],
		// 下一命中的说明。
		description: "Select the next search match",
	},
	// 搜索上一项的定义。
	"tui.altScreen.searchPrevious": {
		// Shift+Enter 或 Ctrl+Shift+G。
		defaultKeys: ["shift+enter", "ctrl+shift+g"],
		// 上一命中的说明。
		description: "Select the previous search match",
	},
	// 关闭搜索的定义。
	"tui.altScreen.searchClose": {
		// 默认 Escape。
		defaultKeys: "escape",
		// 关闭内容搜索的说明。
		description: "Close transcript search",
	},
	// 视口顶部默认 Ctrl+Home。
	"tui.altScreen.top": { defaultKeys: "ctrl+home", description: "Scroll viewport to top" },
	// 视口底部默认 Ctrl+End。
	"tui.altScreen.bottom": { defaultKeys: "ctrl+end", description: "Scroll viewport to bottom" },
	// as const 保留精确字面量并产生只读类型，satisfies 检查结构符合定义表而不抹掉具体键名；二者都不会在运行时冻结对象或验证用户配置。
} as const satisfies KeybindingDefinitions;

// 一个显式用户键位冲突的结果结构，报告而不自动修复。
export interface KeybindingConflict {
	// 被多个动作同时显式声明的同一 KeyId 字符串。
	key: KeyId;
	// 声明它的动作名列表；不包含只使用默认键产生的重叠。
	keybindings: string[];
}

// 把可选单键/键数组变成去重后的新数组，返回 KeyId[]，不改输入。
// 例：["enter","enter"] 变 ["enter"]，undefined 变 []；按原字符串相等去重，不把 ctrl+shift+x 与 shift+ctrl+x 等写法归一成同一语义键。
function normalizeKeys(keys: KeyId | KeyId[] | undefined): KeyId[] {
	// 缺失输入返回新空数组；是否缺失意味着回退默认由调用处决定。
	if (keys === undefined) return [];
	// 区分联合类型中数组和单键两种合法形式；单键包成一项数组，不是验证任意外部字符串合法性。
	const keyList = Array.isArray(keys) ? keys : [keys];
	// Set 按键字符串记录已出现项。
	const seen = new Set<KeyId>();
	// 新结果数组，不直接返回调用方的数组。
	const result: KeyId[] = [];
	// 保持原配置顺序逐个检查。
	for (const key of keyList) {
		// 没出现过才追加。
		if (!seen.has(key)) {
			// 先登记到去重集合。
			seen.add(key);
			// 再保留一次到结果。
			result.push(key);
		}
	}
	// 返回规范后的独立数组容器。
	return result;
}

// 管理某份定义及用户覆盖，不自行读写配置文件或注册键盘监听；每次覆盖重建映射与冲突报告，实际动作执行在调用方。
export class KeybindingsManager {
	// 保存原定义表引用，getDefinition 也会返回其中对象，不深复制。
	private definitions: KeybindingDefinitions;
	// 保存当前原用户配置对象引用。
	private userBindings: KeybindingsConfig;
	// 从动作名到规范按键数组的运行时 Map，供 matches 快速查表。
	private keysById = new Map<Keybinding, KeyId[]>();
	// 当前显式用户配置的冲突记录；共享默认键不会自动算冲突或被驱逐。
	private conflicts: KeybindingConflict[] = [];

	// 创建管理器，输入定义表与可选用户覆盖，保存引用后立刻 rebuild，无显式返回语句。
	// 例：某动作配置 [] 可禁用它，但不会删除另一动作共享的 Enter；不做终端输入读取，定义/配置需已由调用层按约定提供。
	constructor(definitions: KeybindingDefinitions, userBindings: KeybindingsConfig = {}) {
		// 保存原定义表，不复制各定义对象。
		this.definitions = definitions;
		// 保存原用户覆盖对象。
		this.userBindings = userBindings;
		// 立即计算解析表与冲突，而非等到第一次按键再建。
		this.rebuild();
	}

	// 重建按键映射和冲突报告，无参数/返回值；先清旧数据，收集显式用户同键声明，再为所有定义采用覆盖或默认。
	// 例：submit 与 confirm 都显式配置 Ctrl+X 会报告冲突，但两者仍保留此绑定；未知动作的用户项不进入解析表，也不因它驱逐其他键。
	private rebuild(): void {
		// 清旧动作到键数组 Map。
		this.keysById.clear();
		// 更换为空冲突数组，旧调用者拿到的查询副本不受影响。
		this.conflicts = [];

		// 临时 Map 以按键字符串为键、动作名 Set 为值，仅跟踪显式用户项。
		const userClaims = new Map<KeyId, Set<Keybinding>>();
		// Object.entries 取得用户表自有可枚举的键值对，解构为动作名与键配置。
		for (const [keybinding, keys] of Object.entries(this.userBindings)) {
			// 动作不在定义表就忽略它的冲突声明；in 还会查原型链，不是完整外部输入结构校验。
			if (!(keybinding in this.definitions)) continue;
			// 规范并去重这一动作的用户键；undefined/[] 都不会产生用户声明。
			for (const key of normalizeKeys(keys)) {
				// 读取此键的声明集合，不存在时创建新的 Set。
				const claimants = userClaims.get(key) ?? new Set<Keybinding>();
				// 把当前动作加入集合；as Keybinding 只补充类型信息，不会向接口或定义表注册动作。
				claimants.add(keybinding as Keybinding);
				// 保存更新后的声明集合，多个动作可共享它。
				userClaims.set(key, claimants);
			}
		}

		// 遍历每个显式使用的键及其声明集合。
		for (const [key, keybindings] of userClaims) {
			// 同一键由两个及以上不同动作显式配置，才记录冲突。
			if (keybindings.size > 1) {
				// 保存键和展开后的动作名数组，不删改任一动作键位。
				this.conflicts.push({ key, keybindings: [...keybindings] });
			}
		}

		// 再遍历定义表的全部自有可枚举条目，每个动作都会有解析结果。
		for (const [id, definition] of Object.entries(this.definitions)) {
			// 读取该动作的用户覆盖，未提供时为 undefined。
			const userKeys = this.userBindings[id];
			// undefined 才回退默认键；显式 [] 保持无键，单键/数组都统一去重为新数组。
			const keys = userKeys === undefined ? normalizeKeys(definition.defaultKeys) : normalizeKeys(userKeys);
			// 写 Map，as 断言不进行动作名运行时验证；定义表允许下游扩展动作。
			this.keysById.set(id as Keybinding, keys);
		}
	}

	// 判断输入 data 是否匹配某个动作任一已解析按键，返回 boolean，不修改本管理器配置。
	// 例：cursorLeft 的 Left/Ctrl+B 任一匹配即 true；不知道该动作或没绑键则 false。委托 matchesKey 支持终端协议/平台规则，其 Kitty 解析会更新 keys.ts 的最近事件类型，不能把整个调用视为绝对无外部状态影响的纯函数。
	matches(data: string, keybinding: Keybinding): boolean {
		// 查该动作的键数组，没有则按空数组处理。
		const keys = this.keysById.get(keybinding) ?? [];
		// 按配置顺序逐个别名尝试。
		for (const key of keys) {
			// 第一个匹配就返回 true，不继续试后面的别名，也不执行动作本身。
			if (matchesKey(data, key)) return true;
		}
		// 所有别名都未匹配，或列表本就为空，返回 false。
		return false;
	}

	// 读取动作的规范键列表，返回独立数组，无副作用。例：修改 getKeys 的返回数组不会改变内部映射；不存在动作返回 []。
	getKeys(keybinding: Keybinding): KeyId[] {
		// 展开内部数组复制容器，键是字符串值，不需要深复制。
		return [...(this.keysById.get(keybinding) ?? [])];
	}

	// 读取原动作定义对象，无配置改动，也不做存在性校验。例：读取 defaultKeys/description；正常调用需让动作确实存在于本管理器定义表中，返回对象不是副本，编译期返回类型不能替代这一约定。
	getDefinition(keybinding: Keybinding): KeybindingDefinition {
		// 直接按动作名索引原表；运行时若传入本表没有的扩展动作会得到 undefined，尽管声明返回类型未包含它。
		return this.definitions[keybinding];
	}

	// 返回冲突记录的副本，无参数/配置副作用；外层记录和其中动作名数组均复制，避免调用者改动报告缓存。例：getConflicts() 可用于展示提示，但管理器不强制解决冲突。
	getConflicts(): KeybindingConflict[] {
		// map 创建新记录，...conflict 复制字段，内层 ... 再复制 keybindings 数组；键字符串不可变。
		return this.conflicts.map((conflict) => ({ ...conflict, keybindings: [...conflict.keybindings] }));
	}

	// 整体替换用户覆盖并立即重建，无返回值，不合并旧覆盖或持久化配置。例：setUserBindings({}) 恢复各动作默认，而不是保留之前定制。
	setUserBindings(userBindings: KeybindingsConfig): void {
		// 保存新配置对象引用，不复制嵌套键数组。
		this.userBindings = userBindings;
		// 立即重新解析键数组与冲突状态。
		this.rebuild();
	}

	// 读取当前用户覆盖的浅副本，无参数、不重建。例：更改返回对象的某个顶层键不会替换内部顶层键，但数组值仍与原用户配置共享，不能误认为深复制。
	getUserBindings(): KeybindingsConfig {
		// 对象展开只复制一层；包括未知动作项和显式 undefined，不是规范后的运行时键表。
		return { ...this.userBindings };
	}

	// 导出当前所有已定义动作的有效键配置，返回新对象，不修改内部映射。
	// 例：一键输出字符串，多键输出新数组，无键输出 []；未知用户动作不在结果内，适合查看合并后的配置而非原始用户覆盖。
	getResolvedBindings(): KeybindingsConfig {
		// 创建本次结果表，类型允许字符串或数组值。
		const resolved: KeybindingsConfig = {};
		// 只遍历定义表动作，不遍历未知用户项。
		for (const id of Object.keys(this.definitions)) {
			// 取该动作当前规范键，缺省用空数组；as 只补类型。
			const keys = this.keysById.get(id as Keybinding) ?? [];
			// 单项用字符串简写，其他情况复制数组；! 是非空断言，由 length===1 支持正常数组下标存在。
			resolved[id] = keys.length === 1 ? keys[0]! : [...keys];
		}
		// 返回构造好的有效配置对象。
		return resolved;
	}
}

// 模块级共享管理器，初始为 null，getKeybindings 懒创建；多个组件在同一模块实例中使用这个引用。
let globalKeybindings: KeybindingsManager | null = null;

// 替换共享键位管理器，无返回值，不合并或重建传入对象。例：应用构造带自身动作定义的管理器后 setKeybindings，之后各组件 getKeybindings 读取它；不会主动重画或通知已持有旧引用的对象。
export function setKeybindings(keybindings: KeybindingsManager): void {
	// 直接替换模块变量，后续读取采用新实例。
	globalKeybindings = keybindings;
}

// 取得共享管理器，无参数，首次缺省时创建默认实例并缓存，之后返回同一个对象。例：普通 Input 不用传 manager，也可通过它使用应用配置；第一次会计算映射，不监听键盘。
export function getKeybindings(): KeybindingsManager {
	// 尚未设置/初始化时才创建。
	if (!globalKeybindings) {
		// 用运行时 TUI 默认定义构造，不会凭声明合并自动把下游动作的默认定义加入进来。
		globalKeybindings = new KeybindingsManager(TUI_KEYBINDINGS);
	}
	// 返回当前共享引用，不复制管理器。
	return globalKeybindings;
}

/**
 * Returns the selection index after a `tui.select.pageUp` or `tui.select.pageDown` key, moved by `pageSize` and
 * clamped to `0..itemCount - 1`. Returns undefined when `data` is not a selection page key, and 0 for a page key on
 * an empty list, so callers must still check that the list has items before selecting.
 */
// 对列表翻页键计算新下标，返回 number 或 undefined，不修改选中状态；会调用管理器匹配。
// 例：当前下标 2、共 12 项、页长 5，PageDown 得 7；空列表翻页得到 0，调用方仍须检查有没有项。不是翻页键返回 undefined，PageUp 优先于 PageDown。
export function getSelectPageIndex(
	// 用于按当前配置判断翻页动作的管理器。
	keybindings: KeybindingsManager,
	// 一段完整终端按键数据，通常由 StdinBuffer 先拆分。
	data: string,
	// 当前 0 基选中下标。
	selectedIndex: number,
	// 列表总项数，用来限制首末边界。
	itemCount: number,
	// 每页移动的项数，预期有效数值，这里不额外取整或检查符号。
	pageSize: number,
): number | undefined {
	// 局部方向仅在匹配后赋值，let 允许两种分支赋不同符号。
	let direction: number;
	// 上翻页方向为 -1，优先检查。
	if (keybindings.matches(data, "tui.select.pageUp")) direction = -1;
	// 否则检查下翻页，方向为 +1。
	else if (keybindings.matches(data, "tui.select.pageDown")) direction = 1;
	// 都不匹配时立即返回 undefined，后面不读取未赋值 direction。
	else return undefined;
	// 按一页量移动后夹到 0..itemCount-1；空项时内层上限为 -1，外层 Math.max 最终给 0，不代表存在第 0 项。
	return Math.max(0, Math.min(itemCount - 1, selectedIndex + direction * pageSize));
}
