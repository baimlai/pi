// 把终端字节串识别成快捷键或文本字符；StdinBuffer 负责先切分输入，terminal 负责协商协议，本文件不直接读 stdin。
// 三条主要入口：matchesKey 回答“是否这个键”，parseKey 给出可识别的键名，decodePrintableKey 提取编码报文里的文本；它们并非互为逆运算。
// 协议开关是模块共享状态，Kitty 解析还写最近事件类型；匹配同一字符串也可能因模式/Windows Terminal 环境而不同。
// 读码示例：ESC[99;5u 中，99 是 c 的码点，5 减去协议偏移 1 得 Ctrl 位4；matchesKey(data, "ctrl+c") 因此能匹配。
// CSI 表示 ESC+[，SS3 表示 ESC+O；这些是终端转义序列的开头，不是用户真的打入字母 ESC。
/**
 * Keyboard input handling for terminal applications.
 *
 * Supports both legacy terminal sequences and Kitty keyboard protocol.
 * See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
 * Reference: https://github.com/sst/opentui/blob/7da92b4088aebfe27b9f691c04163a48821e49fd/packages/core/src/lib/parse.keypress.ts
 *
 * Symbol keys are also supported, however some ctrl+symbol combos
 * overlap with ASCII codes, e.g. ctrl+[ = ESC.
 * See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/#legacy-ctrl-mapping-of-ascii-keys
 * Those can still be * used for ctrl+shift combos
 *
 * API:
 * - matchesKey(data, keyId) - Check if input matches a key identifier
 * - parseKey(data) - Parse input and return the key identifier
 * - Key - Helper object for creating typed key identifiers
 * - setKittyProtocolActive(active) - Set global Kitty protocol state
 * - isKittyProtocolActive() - Query global Kitty protocol state
 */

// =============================================================================
// Global Kitty Protocol State
// =============================================================================

// 模块级共享 Kitty 开关，初始 false；不是每个组件/终端实例各持一份。它影响歧义旧序列解释，不禁止解析 CSI-u。
let _kittyProtocolActive = false;

/**
 * Set the global Kitty keyboard protocol state.
 * Called by ProcessTerminal after detecting protocol support.
 */
// 保存协议协商结果，返回 void；例：terminal 确认支持后传 true，退出时设 false。
// 只改本模块布尔值，不向终端发送启用序列，也不重置最近事件类型。
export function setKittyProtocolActive(active: boolean): void {
	// 直接赋值，后续所有使用本模块的组件共享新模式。
	_kittyProtocolActive = active;
}

/**
 * Query whether Kitty keyboard protocol is currently active.
 */
// 读取模块开关，返回 boolean；无 I/O/修改，例：false 只表示本模块未设 active，不是探测终端能力。
export function isKittyProtocolActive(): boolean {
	// 返回已保存的值，不发查询报文。
	return _kittyProtocolActive;
}

// =============================================================================
// Type-Safe Key Identifiers
// =============================================================================

// 字面量联合列出小写拉丁字母；这是编译期允许值集合，不是运行时正则或数组。
type Letter =
	// 允许字母 a 作为基本键；这一项只是联合类型的一员。
	| "a"
	// 允许字母 b 作为基本键；这一项只是联合类型的一员。
	| "b"
	// 允许字母 c 作为基本键；这一项只是联合类型的一员。
	| "c"
	// 允许字母 d 作为基本键；这一项只是联合类型的一员。
	| "d"
	// 允许字母 e 作为基本键；这一项只是联合类型的一员。
	| "e"
	// 允许字母 f 作为基本键；这一项只是联合类型的一员。
	| "f"
	// 允许字母 g 作为基本键；这一项只是联合类型的一员。
	| "g"
	// 允许字母 h 作为基本键；这一项只是联合类型的一员。
	| "h"
	// 允许字母 i 作为基本键；这一项只是联合类型的一员。
	| "i"
	// 允许字母 j 作为基本键；这一项只是联合类型的一员。
	| "j"
	// 允许字母 k 作为基本键；这一项只是联合类型的一员。
	| "k"
	// 允许字母 l 作为基本键；这一项只是联合类型的一员。
	| "l"
	// 允许字母 m 作为基本键；这一项只是联合类型的一员。
	| "m"
	// 允许字母 n 作为基本键；这一项只是联合类型的一员。
	| "n"
	// 允许字母 o 作为基本键；这一项只是联合类型的一员。
	| "o"
	// 允许字母 p 作为基本键；这一项只是联合类型的一员。
	| "p"
	// 允许字母 q 作为基本键；这一项只是联合类型的一员。
	| "q"
	// 允许字母 r 作为基本键；这一项只是联合类型的一员。
	| "r"
	// 允许字母 s 作为基本键；这一项只是联合类型的一员。
	| "s"
	// 允许字母 t 作为基本键；这一项只是联合类型的一员。
	| "t"
	// 允许字母 u 作为基本键；这一项只是联合类型的一员。
	| "u"
	// 允许字母 v 作为基本键；这一项只是联合类型的一员。
	| "v"
	// 允许字母 w 作为基本键；这一项只是联合类型的一员。
	| "w"
	// 允许字母 x 作为基本键；这一项只是联合类型的一员。
	| "x"
	// 允许字母 y 作为基本键；这一项只是联合类型的一员。
	| "y"
	// 允许字母 z 作为基本键；这一项只是联合类型的一员。
	| "z";

// 十个数字键的字面量联合，字符串 "1" 与数字 1 是不同类型。
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

// 快捷键接受的标点字符集合；每个 | 增加一个可选字面量，反斜杠需在字符串中转义。
type SymbolKey =
	// 允许反引号作为基本键的类型成员。
	| "`"
	// 允许横杠/减号作为基本键的类型成员。
	| "-"
	// 允许等号作为基本键的类型成员。
	| "="
	// 允许左方括号作为基本键的类型成员。传统 Ctrl+[ 与 Escape 的字节重叠，要看匹配分支。
	| "["
	// 允许右方括号作为基本键的类型成员。
	| "]"
	// 允许反斜杠作为基本键的类型成员。源码字符串用双反斜杠表示一个实际反斜杠。
	| "\\"
	// 允许分号作为基本键的类型成员。
	| ";"
	// 允许单引号作为基本键的类型成员。
	| "'"
	// 允许逗号作为基本键的类型成员。
	| ","
	// 允许句点作为基本键的类型成员。
	| "."
	// 允许正斜杠作为基本键的类型成员。
	| "/"
	// 允许感叹号作为基本键的类型成员。
	| "!"
	// 允许at 符号作为基本键的类型成员。
	| "@"
	// 允许井号作为基本键的类型成员。
	| "#"
	// 允许美元符号作为基本键的类型成员。
	| "$"
	// 允许百分号作为基本键的类型成员。
	| "%"
	// 允许脱字符作为基本键的类型成员。
	| "^"
	// 允许与号作为基本键的类型成员。
	| "&"
	// 允许星号作为基本键的类型成员。
	| "*"
	// 允许左圆括号作为基本键的类型成员。
	| "("
	// 允许右圆括号作为基本键的类型成员。
	| ")"
	// 允许下划线作为基本键的类型成员。传统 Ctrl+_ 与 Ctrl+- 共用控制码31。
	| "_"
	// 允许加号作为基本键的类型成员。组合写法如 ctrl++，最后的 + 是键本身。
	| "+"
	// 允许竖线作为基本键的类型成员。
	| "|"
	// 允许波浪号作为基本键的类型成员。
	| "~"
	// 允许左花括号作为基本键的类型成员。
	| "{"
	// 允许右花括号作为基本键的类型成员。
	| "}"
	// 允许冒号作为基本键的类型成员。
	| ":"
	// 允许小于号作为基本键的类型成员。
	| "<"
	// 允许大于号作为基本键的类型成员。
	| ">"
	// 允许问号作为基本键的类型成员。
	| "?";

// 命名特殊键联合；escape/esc、enter/return 是匹配层支持的别名，pageUp 保留驼峰写法。
type SpecialKey =
	// Escape的类型名字是 "escape"。
	| "escape"
	// Escape 的短别名的类型名字是 "esc"。与对应长名字进入同一匹配分支。
	| "esc"
	// Enter的类型名字是 "enter"。
	| "enter"
	// Enter 的另一个名字的类型名字是 "return"。与对应长名字进入同一匹配分支。
	| "return"
	// Tab的类型名字是 "tab"。
	| "tab"
	// 空格的类型名字是 "space"。
	| "space"
	// 向后退格的类型名字是 "backspace"。
	| "backspace"
	// Delete的类型名字是 "delete"。
	| "delete"
	// Insert的类型名字是 "insert"。
	| "insert"
	// Clear的类型名字是 "clear"。
	| "clear"
	// Home的类型名字是 "home"。
	| "home"
	// End的类型名字是 "end"。
	| "end"
	// 向上一页的类型名字是 "pageUp"。匹配器会将输入标识转小写，但解析输出保留这里的驼峰名。
	| "pageUp"
	// 向下一页的类型名字是 "pageDown"。匹配器会将输入标识转小写，但解析输出保留这里的驼峰名。
	| "pageDown"
	// 上方向的类型名字是 "up"。
	| "up"
	// 下方向的类型名字是 "down"。
	| "down"
	// 左方向的类型名字是 "left"。
	| "left"
	// 右方向的类型名字是 "right"。
	| "right"
	// F1 功能键的类型名字是 "f1"。
	| "f1"
	// F2 功能键的类型名字是 "f2"。
	| "f2"
	// F3 功能键的类型名字是 "f3"。
	| "f3"
	// F4 功能键的类型名字是 "f4"。
	| "f4"
	// F5 功能键的类型名字是 "f5"。
	| "f5"
	// F6 功能键的类型名字是 "f6"。
	| "f6"
	// F7 功能键的类型名字是 "f7"。
	| "f7"
	// F8 功能键的类型名字是 "f8"。
	| "f8"
	// F9 功能键的类型名字是 "f9"。
	| "f9"
	// F10 功能键的类型名字是 "f10"。
	| "f10"
	// F11 功能键的类型名字是 "f11"。
	| "f11"
	// F12 功能键的类型名字是 "f12"。
	| "f12";

// 联合类型 | 合并四组基本键；运行时不会自动创建这些键的集合。
type BaseKey = Letter | Digit | SymbolKey | SpecialKey;
// 四种可配置修饰键；super 对应 Command/Windows 键，类型不包括 Kitty 的 Hyper/Meta。
type ModifierName = "ctrl" | "shift" | "alt" | "super";

// 递归泛型生成不重复修饰键的排列；Key 为待修饰键，RemainingModifiers 缺省是四种修饰键。
type ModifiedKeyId<Key extends string, RemainingModifiers extends ModifierName = ModifierName> = {
	// 映射类型逐个取 M；模板字面量类型拼“修饰键+键”，Exclude 每次去掉已用 M，让递归有限终止。
	[M in RemainingModifiers]: `${M}+${Key}` | `${M}+${ModifiedKeyId<Key, Exclude<RemainingModifiers, M>>}`;
	// 用联合键索引映射对象，把每个属性的值类型合成联合；剩余 never 时结果也是 never。
}[RemainingModifiers];

/**
 * Union type of all valid key identifiers.
 * Provides autocomplete and catches typos at compile time.
 */
// 基本键或任意不重复的修饰键排列；只给 TS 自动补全/报错，运行时字符串仍需 parseKeyId 检查。
export type KeyId = BaseKey | ModifiedKeyId<BaseKey>;

/**
 * Helper object for creating typed key identifiers with autocomplete.
 *
 * Usage:
 * - Key.escape, Key.enter, Key.tab, etc. for special keys
 * - Key.backtick, Key.comma, Key.period, etc. for symbol keys
 * - Key.ctrl("c"), Key.alt("x"), Key.super("k") for single modifiers
 * - Key.ctrlShift("p"), Key.ctrlAlt("x"), Key.ctrlSuper("k") for combined modifiers
 */
// 常量对象提供键名及构造函数；as const 保留各属性字面量类型并限制编译期写入，不会 Object.freeze。
// 下面每个修饰函数只拼接字符串，无发送/监听/协议检查；例：Key.ctrl("c") 得到 "ctrl+c"。
export const Key = {
	// Special keys
	// Key.escape 提供Escape的字符串值 "escape"，供快捷键声明引用。
	escape: "escape" as const,
	// Key.esc 提供Escape 的短别名的字符串值 "esc"，供快捷键声明引用。
	esc: "esc" as const,
	// Key.enter 提供Enter的字符串值 "enter"，供快捷键声明引用。
	enter: "enter" as const,
	// Key.return 提供Enter 的另一个名字的字符串值 "return"，供快捷键声明引用。
	return: "return" as const,
	// Key.tab 提供Tab的字符串值 "tab"，供快捷键声明引用。
	tab: "tab" as const,
	// Key.space 提供空格的字符串值 "space"，供快捷键声明引用。
	space: "space" as const,
	// Key.backspace 提供向后退格的字符串值 "backspace"，供快捷键声明引用。
	backspace: "backspace" as const,
	// Key.delete 提供Delete的字符串值 "delete"，供快捷键声明引用。
	delete: "delete" as const,
	// Key.insert 提供Insert的字符串值 "insert"，供快捷键声明引用。
	insert: "insert" as const,
	// Key.clear 提供Clear的字符串值 "clear"，供快捷键声明引用。
	clear: "clear" as const,
	// Key.home 提供Home的字符串值 "home"，供快捷键声明引用。
	home: "home" as const,
	// Key.end 提供End的字符串值 "end"，供快捷键声明引用。
	end: "end" as const,
	// Key.pageUp 提供向上一页的字符串值 "pageUp"，供快捷键声明引用。
	pageUp: "pageUp" as const,
	// Key.pageDown 提供向下一页的字符串值 "pageDown"，供快捷键声明引用。
	pageDown: "pageDown" as const,
	// Key.up 提供上方向的字符串值 "up"，供快捷键声明引用。
	up: "up" as const,
	// Key.down 提供下方向的字符串值 "down"，供快捷键声明引用。
	down: "down" as const,
	// Key.left 提供左方向的字符串值 "left"，供快捷键声明引用。
	left: "left" as const,
	// Key.right 提供右方向的字符串值 "right"，供快捷键声明引用。
	right: "right" as const,
	// Key.f1 提供F1 功能键的字符串值 "f1"，供快捷键声明引用。
	f1: "f1" as const,
	// Key.f2 提供F2 功能键的字符串值 "f2"，供快捷键声明引用。
	f2: "f2" as const,
	// Key.f3 提供F3 功能键的字符串值 "f3"，供快捷键声明引用。
	f3: "f3" as const,
	// Key.f4 提供F4 功能键的字符串值 "f4"，供快捷键声明引用。
	f4: "f4" as const,
	// Key.f5 提供F5 功能键的字符串值 "f5"，供快捷键声明引用。
	f5: "f5" as const,
	// Key.f6 提供F6 功能键的字符串值 "f6"，供快捷键声明引用。
	f6: "f6" as const,
	// Key.f7 提供F7 功能键的字符串值 "f7"，供快捷键声明引用。
	f7: "f7" as const,
	// Key.f8 提供F8 功能键的字符串值 "f8"，供快捷键声明引用。
	f8: "f8" as const,
	// Key.f9 提供F9 功能键的字符串值 "f9"，供快捷键声明引用。
	f9: "f9" as const,
	// Key.f10 提供F10 功能键的字符串值 "f10"，供快捷键声明引用。
	f10: "f10" as const,
	// Key.f11 提供F11 功能键的字符串值 "f11"，供快捷键声明引用。
	f11: "f11" as const,
	// Key.f12 提供F12 功能键的字符串值 "f12"，供快捷键声明引用。
	f12: "f12" as const,

	// Symbol keys
	// Key.backtick 提供反引号的字符串值 "`"，供快捷键声明引用。
	backtick: "`" as const,
	// Key.hyphen 提供横杠/减号的字符串值 "-"，供快捷键声明引用。
	hyphen: "-" as const,
	// Key.equals 提供等号的字符串值 "="，供快捷键声明引用。
	equals: "=" as const,
	// Key.leftbracket 提供左方括号的字符串值 "["，供快捷键声明引用。
	leftbracket: "[" as const,
	// Key.rightbracket 提供右方括号的字符串值 "]"，供快捷键声明引用。
	rightbracket: "]" as const,
	// Key.backslash 提供反斜杠的字符串值 "\\"，供快捷键声明引用。
	backslash: "\\" as const,
	// Key.semicolon 提供分号的字符串值 ";"，供快捷键声明引用。
	semicolon: ";" as const,
	// Key.quote 提供单引号的字符串值 "'"，供快捷键声明引用。
	quote: "'" as const,
	// Key.comma 提供逗号的字符串值 ","，供快捷键声明引用。
	comma: "," as const,
	// Key.period 提供句点的字符串值 "."，供快捷键声明引用。
	period: "." as const,
	// Key.slash 提供正斜杠的字符串值 "/"，供快捷键声明引用。
	slash: "/" as const,
	// Key.exclamation 提供感叹号的字符串值 "!"，供快捷键声明引用。
	exclamation: "!" as const,
	// Key.at 提供at 符号的字符串值 "@"，供快捷键声明引用。
	at: "@" as const,
	// Key.hash 提供井号的字符串值 "#"，供快捷键声明引用。
	hash: "#" as const,
	// Key.dollar 提供美元符号的字符串值 "$"，供快捷键声明引用。
	dollar: "$" as const,
	// Key.percent 提供百分号的字符串值 "%"，供快捷键声明引用。
	percent: "%" as const,
	// Key.caret 提供脱字符的字符串值 "^"，供快捷键声明引用。
	caret: "^" as const,
	// Key.ampersand 提供与号的字符串值 "&"，供快捷键声明引用。
	ampersand: "&" as const,
	// Key.asterisk 提供星号的字符串值 "*"，供快捷键声明引用。
	asterisk: "*" as const,
	// Key.leftparen 提供左圆括号的字符串值 "("，供快捷键声明引用。
	leftparen: "(" as const,
	// Key.rightparen 提供右圆括号的字符串值 ")"，供快捷键声明引用。
	rightparen: ")" as const,
	// Key.underscore 提供下划线的字符串值 "_"，供快捷键声明引用。
	underscore: "_" as const,
	// Key.plus 提供加号的字符串值 "+"，供快捷键声明引用。如 Key.ctrl(Key.plus) 构造 ctrl++。
	plus: "+" as const,
	// Key.pipe 提供竖线的字符串值 "|"，供快捷键声明引用。
	pipe: "|" as const,
	// Key.tilde 提供波浪号的字符串值 "~"，供快捷键声明引用。
	tilde: "~" as const,
	// Key.leftbrace 提供左花括号的字符串值 "{"，供快捷键声明引用。
	leftbrace: "{" as const,
	// Key.rightbrace 提供右花括号的字符串值 "}"，供快捷键声明引用。
	rightbrace: "}" as const,
	// Key.colon 提供冒号的字符串值 ":"，供快捷键声明引用。
	colon: ":" as const,
	// Key.lessthan 提供小于号的字符串值 "<"，供快捷键声明引用。
	lessthan: "<" as const,
	// Key.greaterthan 提供大于号的字符串值 ">"，供快捷键声明引用。
	greaterthan: ">" as const,
	// Key.question 提供问号的字符串值 "?"，供快捷键声明引用。
	question: "?" as const,

	// Single modifiers
	// ctrl 只拼接 ctrl+ 前缀；例：Key.ctrl("c") 返回 "ctrl+c"。K extends BaseKey 约束参数，模板类型保留精确结果；无运行时校验/副作用。
	ctrl: <K extends BaseKey>(key: K): `ctrl+${K}` => `ctrl+${key}`,
	// shift 只拼接 shift+ 前缀；例：Key.shift("c") 返回 "shift+c"。K extends BaseKey 约束参数，模板类型保留精确结果；无运行时校验/副作用。
	shift: <K extends BaseKey>(key: K): `shift+${K}` => `shift+${key}`,
	// alt 只拼接 alt+ 前缀；例：Key.alt("c") 返回 "alt+c"。K extends BaseKey 约束参数，模板类型保留精确结果；无运行时校验/副作用。
	alt: <K extends BaseKey>(key: K): `alt+${K}` => `alt+${key}`,
	// super 只拼接 super+ 前缀；例：Key.super("c") 返回 "super+c"。K extends BaseKey 约束参数，模板类型保留精确结果；无运行时校验/副作用。
	super: <K extends BaseKey>(key: K): `super+${K}` => `super+${key}`,

	// Combined modifiers
	// ctrlShift 只拼接 ctrl+shift+ 前缀；例：Key.ctrlShift("c") 返回 "ctrl+shift+c"。K extends BaseKey 约束参数，模板类型保留精确结果；无运行时校验/副作用。
	ctrlShift: <K extends BaseKey>(key: K): `ctrl+shift+${K}` => `ctrl+shift+${key}`,
	// shiftCtrl 只拼接 shift+ctrl+ 前缀；例：Key.shiftCtrl("c") 返回 "shift+ctrl+c"。K extends BaseKey 约束参数，模板类型保留精确结果；无运行时校验/副作用。
	shiftCtrl: <K extends BaseKey>(key: K): `shift+ctrl+${K}` => `shift+ctrl+${key}`,
	// ctrlAlt 只拼接 ctrl+alt+ 前缀；例：Key.ctrlAlt("c") 返回 "ctrl+alt+c"。K extends BaseKey 约束参数，模板类型保留精确结果；无运行时校验/副作用。
	ctrlAlt: <K extends BaseKey>(key: K): `ctrl+alt+${K}` => `ctrl+alt+${key}`,
	// altCtrl 只拼接 alt+ctrl+ 前缀；例：Key.altCtrl("c") 返回 "alt+ctrl+c"。K extends BaseKey 约束参数，模板类型保留精确结果；无运行时校验/副作用。
	altCtrl: <K extends BaseKey>(key: K): `alt+ctrl+${K}` => `alt+ctrl+${key}`,
	// shiftAlt 只拼接 shift+alt+ 前缀；例：Key.shiftAlt("c") 返回 "shift+alt+c"。K extends BaseKey 约束参数，模板类型保留精确结果；无运行时校验/副作用。
	shiftAlt: <K extends BaseKey>(key: K): `shift+alt+${K}` => `shift+alt+${key}`,
	// altShift 只拼接 alt+shift+ 前缀；例：Key.altShift("c") 返回 "alt+shift+c"。K extends BaseKey 约束参数，模板类型保留精确结果；无运行时校验/副作用。
	altShift: <K extends BaseKey>(key: K): `alt+shift+${K}` => `alt+shift+${key}`,
	// ctrlSuper 只拼接 ctrl+super+ 前缀；例：Key.ctrlSuper("c") 返回 "ctrl+super+c"。K extends BaseKey 约束参数，模板类型保留精确结果；无运行时校验/副作用。
	ctrlSuper: <K extends BaseKey>(key: K): `ctrl+super+${K}` => `ctrl+super+${key}`,
	// superCtrl 只拼接 super+ctrl+ 前缀；例：Key.superCtrl("c") 返回 "super+ctrl+c"。K extends BaseKey 约束参数，模板类型保留精确结果；无运行时校验/副作用。
	superCtrl: <K extends BaseKey>(key: K): `super+ctrl+${K}` => `super+ctrl+${key}`,
	// shiftSuper 只拼接 shift+super+ 前缀；例：Key.shiftSuper("c") 返回 "shift+super+c"。K extends BaseKey 约束参数，模板类型保留精确结果；无运行时校验/副作用。
	shiftSuper: <K extends BaseKey>(key: K): `shift+super+${K}` => `shift+super+${key}`,
	// superShift 只拼接 super+shift+ 前缀；例：Key.superShift("c") 返回 "super+shift+c"。K extends BaseKey 约束参数，模板类型保留精确结果；无运行时校验/副作用。
	superShift: <K extends BaseKey>(key: K): `super+shift+${K}` => `super+shift+${key}`,
	// altSuper 只拼接 alt+super+ 前缀；例：Key.altSuper("c") 返回 "alt+super+c"。K extends BaseKey 约束参数，模板类型保留精确结果；无运行时校验/副作用。
	altSuper: <K extends BaseKey>(key: K): `alt+super+${K}` => `alt+super+${key}`,
	// superAlt 只拼接 super+alt+ 前缀；例：Key.superAlt("c") 返回 "super+alt+c"。K extends BaseKey 约束参数，模板类型保留精确结果；无运行时校验/副作用。
	superAlt: <K extends BaseKey>(key: K): `super+alt+${K}` => `super+alt+${key}`,

	// Triple modifiers
	// ctrlShiftAlt 只拼接 ctrl+shift+alt+ 前缀；例：Key.ctrlShiftAlt("c") 返回 "ctrl+shift+alt+c"。K extends BaseKey 约束参数，模板类型保留精确结果；无运行时校验/副作用。
	ctrlShiftAlt: <K extends BaseKey>(key: K): `ctrl+shift+alt+${K}` => `ctrl+shift+alt+${key}`,
	// ctrlShiftSuper 只拼接 ctrl+shift+super+ 前缀；例：Key.ctrlShiftSuper("c") 返回 "ctrl+shift+super+c"。K extends BaseKey 约束参数，模板类型保留精确结果；无运行时校验/副作用。
	ctrlShiftSuper: <K extends BaseKey>(key: K): `ctrl+shift+super+${K}` => `ctrl+shift+super+${key}`,
} as const;

// =============================================================================
// Constants
// =============================================================================

// 运行时标点 Set，与上面的 SymbolKey 类型分别存在；has 用于判断报文码点/键名是否是已知符号。
const SYMBOL_KEYS = new Set([
	// 把反引号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"`",
	// 把横杠/减号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"-",
	// 把等号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"=",
	// 把左方括号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"[",
	// 把右方括号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"]",
	// 把反斜杠加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"\\",
	// 把分号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	";",
	// 把单引号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"'",
	// 把逗号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	",",
	// 把句点加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	".",
	// 把正斜杠加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"/",
	// 把感叹号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"!",
	// 把at 符号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"@",
	// 把井号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"#",
	// 把美元符号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"$",
	// 把百分号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"%",
	// 把脱字符加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"^",
	// 把与号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"&",
	// 把星号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"*",
	// 把左圆括号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"(",
	// 把右圆括号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	")",
	// 把下划线加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"_",
	// 把加号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"+",
	// 把竖线加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"|",
	// 把波浪号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"~",
	// 把左花括号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"{",
	// 把右花括号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"}",
	// 把冒号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	":",
	// 把小于号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"<",
	// 把大于号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	">",
	// 把问号加入运行时符号成员；命名键匹配和逻辑 Shift 符号查询都用这张集合。
	"?",
]);

// 这些符号通常已经消耗了物理 Shift，例如 + 来自 Shift+=；供 modifyOtherKeys 逻辑字符匹配使用。
const SHIFTED_SYMBOL_KEYS = new Set("~!@#$%^&*()_+|{}:<>?");

// 解析 keyId 前缀时逐个检查的四个名字；as const 也让后面能提取精确元素类型。
const MODIFIER_NAMES = ["shift", "alt", "ctrl", "super"] as const;

// 内部位掩码：每个修饰键占独立二进制位，| 可合并，& 可检查。协议线上发送的是掩码再加 1。
const MODIFIERS = {
	// Shift 占最低位 1。
	shift: 1,
	// Alt/Option 占第 2 位 2。
	alt: 2,
	// Ctrl 占第 3 位 4。
	ctrl: 4,
	// Super/Command/Windows 占第 4 位 8。
	super: 8,
} as const;

// 锁定状态占 64/128；快捷键匹配通常忽略它们，~LOCK_MASK 可清这两位，不清 Hyper/Meta。
const LOCK_MASK = 64 + 128; // Caps Lock + Num Lock

// 常用键的实际码点；大多是 ASCII，小键盘 Enter 使用 Kitty 私用区专用码。
const CODEPOINTS = {
	// Escape 是 ASCII ESC 27，传统 Ctrl+[ 也可能是同一个字节。
	escape: 27,
	// Tab 对应 HT 9，传统 Ctrl+I 也重叠。
	tab: 9,
	// Enter 使用 CR 13；LF 10 的歧义会在模式分支里处理。
	enter: 13,
	// 空格码点 32，也是可打印字符的下界。
	space: 32,
	// Backspace 的显式码点用 DEL 127；原始 BS 8 另走平台启发规则。
	backspace: 127,
	// Kitty 小键盘 Enter 57414，匹配时与普通 Enter 一起尝试。
	kpEnter: 57414, // Numpad Enter (Kitty protocol)
} as const;

// 负数是本文件自己给导航键的内部标识，不是 Unicode 码点，也不是线上直接发送的编号。
const ARROW_CODEPOINTS = {
	// 内部 -1 表示上方向。
	up: -1,
	// 内部 -2 表示下方向。
	down: -2,
	// 内部 -3 表示右方向。
	right: -3,
	// 内部 -4 表示左方向。
	left: -4,
} as const;

// 其他功能键也用负数内部标识，避免与正常 Unicode 文本码点混淆。
const FUNCTIONAL_CODEPOINTS = {
	// delete 的内部功能标识为右侧负数，线上 CSI 编号之后会映射到它。
	delete: -10,
	// insert 的内部功能标识为右侧负数，线上 CSI 编号之后会映射到它。
	insert: -11,
	// pageUp 的内部功能标识为右侧负数，线上 CSI 编号之后会映射到它。
	pageUp: -12,
	// pageDown 的内部功能标识为右侧负数，线上 CSI 编号之后会映射到它。
	pageDown: -13,
	// home 的内部功能标识为右侧负数，线上 CSI 编号之后会映射到它。
	home: -14,
	// end 的内部功能标识为右侧负数，线上 CSI 编号之后会映射到它。
	end: -15,
	// f1 的内部功能标识为右侧负数，线上 CSI 编号之后会映射到它。
	f1: -21,
	// f2 的内部功能标识为右侧负数，线上 CSI 编号之后会映射到它。
	f2: -22,
	// f3 的内部功能标识为右侧负数，线上 CSI 编号之后会映射到它。
	f3: -23,
	// f4 的内部功能标识为右侧负数，线上 CSI 编号之后会映射到它。
	f4: -24,
	// f5 的内部功能标识为右侧负数，线上 CSI 编号之后会映射到它。
	f5: -25,
	// f6 的内部功能标识为右侧负数，线上 CSI 编号之后会映射到它。
	f6: -26,
	// f7 的内部功能标识为右侧负数，线上 CSI 编号之后会映射到它。
	f7: -27,
	// f8 的内部功能标识为右侧负数，线上 CSI 编号之后会映射到它。
	f8: -28,
	// f9 的内部功能标识为右侧负数，线上 CSI 编号之后会映射到它。
	f9: -29,
	// f10 的内部功能标识为右侧负数，线上 CSI 编号之后会映射到它。
	f10: -30,
	// f11 的内部功能标识为右侧负数，线上 CSI 编号之后会映射到它。
	f11: -31,
	// f12 的内部功能标识为右侧负数，线上 CSI 编号之后会映射到它。
	f12: -32,
} as const;

// Kitty reserves this Private Use Area range for functional keys (F13-F35,
// media keys, modifier keys, ...). CSI-u codepoints in it are never text.
// 功能键私用码点的起点；未映射到文本的小键盘/功能事件不应直接插入编辑器。
const KITTY_FUNCTIONAL_PUA_START = 57344;
// 区间终点含在判断内；这是 Kitty 功能区范围，不是所有 Unicode 私用区的全集。
const KITTY_FUNCTIONAL_PUA_END = 63743;

// Map 将可用的小键盘 Kitty 编号归一化为普通数字/符号/内部导航码；未列出的保留原值。
const KITTY_FUNCTIONAL_KEY_EQUIVALENTS = new Map<number, number>([
	// 小键盘编号 57399 归一化为字符 "0"（码点 48），使它可复用普通键匹配/文本解码。
	[57399, 48], // KP_0 -> 0
	// 小键盘编号 57400 归一化为字符 "1"（码点 49），使它可复用普通键匹配/文本解码。
	[57400, 49], // KP_1 -> 1
	// 小键盘编号 57401 归一化为字符 "2"（码点 50），使它可复用普通键匹配/文本解码。
	[57401, 50], // KP_2 -> 2
	// 小键盘编号 57402 归一化为字符 "3"（码点 51），使它可复用普通键匹配/文本解码。
	[57402, 51], // KP_3 -> 3
	// 小键盘编号 57403 归一化为字符 "4"（码点 52），使它可复用普通键匹配/文本解码。
	[57403, 52], // KP_4 -> 4
	// 小键盘编号 57404 归一化为字符 "5"（码点 53），使它可复用普通键匹配/文本解码。
	[57404, 53], // KP_5 -> 5
	// 小键盘编号 57405 归一化为字符 "6"（码点 54），使它可复用普通键匹配/文本解码。
	[57405, 54], // KP_6 -> 6
	// 小键盘编号 57406 归一化为字符 "7"（码点 55），使它可复用普通键匹配/文本解码。
	[57406, 55], // KP_7 -> 7
	// 小键盘编号 57407 归一化为字符 "8"（码点 56），使它可复用普通键匹配/文本解码。
	[57407, 56], // KP_8 -> 8
	// 小键盘编号 57408 归一化为字符 "9"（码点 57），使它可复用普通键匹配/文本解码。
	[57408, 57], // KP_9 -> 9
	// 小键盘编号 57409 归一化为字符 "."（码点 46），使它可复用普通键匹配/文本解码。
	[57409, 46], // KP_DECIMAL -> .
	// 小键盘编号 57410 归一化为字符 "/"（码点 47），使它可复用普通键匹配/文本解码。
	[57410, 47], // KP_DIVIDE -> /
	// 小键盘编号 57411 归一化为字符 "*"（码点 42），使它可复用普通键匹配/文本解码。
	[57411, 42], // KP_MULTIPLY -> *
	// 小键盘编号 57412 归一化为字符 "-"（码点 45），使它可复用普通键匹配/文本解码。
	[57412, 45], // KP_SUBTRACT -> -
	// 小键盘编号 57413 归一化为字符 "+"（码点 43），使它可复用普通键匹配/文本解码。
	[57413, 43], // KP_ADD -> +
	// 小键盘编号 57415 归一化为字符 "="（码点 61），使它可复用普通键匹配/文本解码。
	[57415, 61], // KP_EQUAL -> =
	// 小键盘编号 57416 归一化为字符 ","（码点 44），使它可复用普通键匹配/文本解码。
	[57416, 44], // KP_SEPARATOR -> ,
	// 小键盘导航码映射到 left 的内部功能标识，和普通导航键共用匹配流程。
	[57417, ARROW_CODEPOINTS.left],
	// 小键盘导航码映射到 right 的内部功能标识，和普通导航键共用匹配流程。
	[57418, ARROW_CODEPOINTS.right],
	// 小键盘导航码映射到 up 的内部功能标识，和普通导航键共用匹配流程。
	[57419, ARROW_CODEPOINTS.up],
	// 小键盘导航码映射到 down 的内部功能标识，和普通导航键共用匹配流程。
	[57420, ARROW_CODEPOINTS.down],
	// 小键盘导航码映射到 pageUp 的内部功能标识，和普通导航键共用匹配流程。
	[57421, FUNCTIONAL_CODEPOINTS.pageUp],
	// 小键盘导航码映射到 pageDown 的内部功能标识，和普通导航键共用匹配流程。
	[57422, FUNCTIONAL_CODEPOINTS.pageDown],
	// 小键盘导航码映射到 home 的内部功能标识，和普通导航键共用匹配流程。
	[57423, FUNCTIONAL_CODEPOINTS.home],
	// 小键盘导航码映射到 end 的内部功能标识，和普通导航键共用匹配流程。
	[57424, FUNCTIONAL_CODEPOINTS.end],
	// 小键盘导航码映射到 insert 的内部功能标识，和普通导航键共用匹配流程。
	[57425, FUNCTIONAL_CODEPOINTS.insert],
	// 小键盘导航码映射到 delete 的内部功能标识，和普通导航键共用匹配流程。
	[57426, FUNCTIONAL_CODEPOINTS.delete],
]);

// 按表归一化功能码点并返回 number；例：57400 变字符 1 的码点 49。纯查表，无 I/O/状态变化。
function normalizeKittyFunctionalCodepoint(codepoint: number): number {
	// get 没命中才 ?? 原值，0 这样的已映射值也不会被误丢弃。
	return KITTY_FUNCTIONAL_KEY_EQUIVALENTS.get(codepoint) ?? codepoint;
}

// 带 Shift 的 ASCII 大写码点转成小写身份，返回 number；例：E(69)+Shift→e(101)，Shift 位仍由调用方保留。
// 只处理 ASCII A..Z，不实现整个 Unicode 的大小写转换，也不改变模块状态。
function normalizeShiftedLetterIdentityCodepoint(codepoint: number, modifier: number): number {
	// &~ 清 Caps/Num Lock，再据有效修饰键判断 Shift。位运算按 JS 32 位整数规则计算。
	const effectiveModifier = modifier & ~LOCK_MASK;
	// 必须有 Shift 且码点在 A..Z；普通大写或其他字符不改。
	if ((effectiveModifier & MODIFIERS.shift) !== 0 && codepoint >= 65 && codepoint <= 90) {
		// ASCII 大小写相差 32，返回对应小写码点。
		return codepoint + 32;
	}
	// 不符合条件保持原码点。
	return codepoint;
}

// 从已报告的 Shift 字符构造逻辑符号候选；例：Shift+= 报 shiftedKey 为 + 时得到“+ 且去掉 Shift”。
// 输入码点可缺，allowedSymbols 限定本分支接受的符号；成功返回新对象，否则 undefined，无外部修改。
function getLogicalShiftedSymbolCandidate(
	// 可能没有 shiftedKey，所以类型与 undefined 联合。
	codepoint: number | undefined,
	// 内部修饰位掩码，不是线上加 1 后的字段。
	modifier: number,
	// ReadonlySet 只限制通过此类型修改集合，不会在运行时冻结。
	allowedSymbols: ReadonlySet<string>,
	// 返回对象包含逻辑码点和扣掉隐含 Shift 的修饰位，或者无候选。
): { codepoint: number; modifier: number } | undefined {
	// 缺码点或没按 Shift 都不把字符当“消耗 Shift 的符号”。
	if (codepoint === undefined || (modifier & MODIFIERS.shift) === 0) return undefined;
	// 先把可映射小键盘码点换成普通文本/内部功能码。
	const normalizedCodepoint = normalizeKittyFunctionalCodepoint(codepoint);
	// fromCharCode 转 UTF-16 单元供集合查询；不是完整码点合法性校验，allowedSymbols 限定实际能接受的 ASCII 符号。
	if (!allowedSymbols.has(String.fromCharCode(normalizedCodepoint))) return undefined;
	// 新对象保留其他修饰位，仅清 Shift；原始 parsed 对象不改。
	return { codepoint: normalizedCodepoint, modifier: modifier & ~MODIFIERS.shift };
}

// 无修饰旧终端编码表：每个数组允许同一键多种 CSI/SS3/历史形式；数组保存实际 ESC 字节串。
const LEGACY_KEY_SEQUENCES = {
	// up 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	up: ["\x1b[A", "\x1bOA"],
	// down 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	down: ["\x1b[B", "\x1bOB"],
	// right 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	right: ["\x1b[C", "\x1bOC"],
	// left 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	left: ["\x1b[D", "\x1bOD"],
	// home 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	home: ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"],
	// end 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	end: ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"],
	// insert 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	insert: ["\x1b[2~"],
	// delete 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	delete: ["\x1b[3~"],
	// pageUp 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	pageUp: ["\x1b[5~", "\x1b[[5~"],
	// pageDown 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	pageDown: ["\x1b[6~", "\x1b[[6~"],
	// clear 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	clear: ["\x1b[E", "\x1bOE"],
	// f1 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	f1: ["\x1bOP", "\x1b[11~", "\x1b[[A"],
	// f2 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	f2: ["\x1bOQ", "\x1b[12~", "\x1b[[B"],
	// f3 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	f3: ["\x1bOR", "\x1b[13~", "\x1b[[C"],
	// f4 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	f4: ["\x1bOS", "\x1b[14~", "\x1b[[D"],
	// f5 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	f5: ["\x1b[15~", "\x1b[[E"],
	// f6 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	f6: ["\x1b[17~"],
	// f7 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	f7: ["\x1b[18~"],
	// f8 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	f8: ["\x1b[19~"],
	// f9 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	f9: ["\x1b[20~"],
	// f10 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	f10: ["\x1b[21~"],
	// f11 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	f11: ["\x1b[23~"],
	// f12 接受本数组列出的无修饰旧编码，数组项完整匹配，不能只比较最后一个字母。
	f12: ["\x1b[24~"],
} as const;

// 旧 rxvt 风格的 Shift 编码：小写方向后缀或 $ 结尾，不能把这些字面量当普通文本插入。
const LEGACY_SHIFT_SEQUENCES = {
	// Shift+up 对应这组旧编码；只在恰好 Shift 的旧表分支使用。
	up: ["\x1b[a"],
	// Shift+down 对应这组旧编码；只在恰好 Shift 的旧表分支使用。
	down: ["\x1b[b"],
	// Shift+right 对应这组旧编码；只在恰好 Shift 的旧表分支使用。
	right: ["\x1b[c"],
	// Shift+left 对应这组旧编码；只在恰好 Shift 的旧表分支使用。
	left: ["\x1b[d"],
	// Shift+clear 对应这组旧编码；只在恰好 Shift 的旧表分支使用。
	clear: ["\x1b[e"],
	// Shift+insert 对应这组旧编码；只在恰好 Shift 的旧表分支使用。
	insert: ["\x1b[2$"],
	// Shift+delete 对应这组旧编码；只在恰好 Shift 的旧表分支使用。
	delete: ["\x1b[3$"],
	// Shift+pageUp 对应这组旧编码；只在恰好 Shift 的旧表分支使用。
	pageUp: ["\x1b[5$"],
	// Shift+pageDown 对应这组旧编码；只在恰好 Shift 的旧表分支使用。
	pageDown: ["\x1b[6$"],
	// Shift+home 对应这组旧编码；只在恰好 Shift 的旧表分支使用。
	home: ["\x1b[7$"],
	// Shift+end 对应这组旧编码；只在恰好 Shift 的旧表分支使用。
	end: ["\x1b[8$"],
} as const;

// 旧 rxvt 风格的 Ctrl 编码：SS3 小写方向或 ^ 结尾；只对应这里列出的键。
const LEGACY_CTRL_SEQUENCES = {
	// Ctrl+up 对应这组旧编码；和 Shift 表有相同键集合。
	up: ["\x1bOa"],
	// Ctrl+down 对应这组旧编码；和 Shift 表有相同键集合。
	down: ["\x1bOb"],
	// Ctrl+right 对应这组旧编码；和 Shift 表有相同键集合。
	right: ["\x1bOc"],
	// Ctrl+left 对应这组旧编码；和 Shift 表有相同键集合。
	left: ["\x1bOd"],
	// Ctrl+clear 对应这组旧编码；和 Shift 表有相同键集合。
	clear: ["\x1bOe"],
	// Ctrl+insert 对应这组旧编码；和 Shift 表有相同键集合。
	insert: ["\x1b[2^"],
	// Ctrl+delete 对应这组旧编码；和 Shift 表有相同键集合。
	delete: ["\x1b[3^"],
	// Ctrl+pageUp 对应这组旧编码；和 Shift 表有相同键集合。
	pageUp: ["\x1b[5^"],
	// Ctrl+pageDown 对应这组旧编码；和 Shift 表有相同键集合。
	pageDown: ["\x1b[6^"],
	// Ctrl+home 对应这组旧编码；和 Shift 表有相同键集合。
	home: ["\x1b[7^"],
	// Ctrl+end 对应这组旧编码；和 Shift 表有相同键集合。
	end: ["\x1b[8^"],
} as const;

// 反向表把旧字节串直接变成键名；Record 是 TS 字典类型，实际对象仍有普通对象原型，查表处不是 hasOwn。
const LEGACY_SEQUENCE_KEY_IDS: Record<string, KeyId> = {
	// 左侧完整字节串在 parseKey 反向查表时得到 "up"；这一查表不受 Kitty active 开关限制。
	"\x1bOA": "up",
	// 左侧完整字节串在 parseKey 反向查表时得到 "down"；这一查表不受 Kitty active 开关限制。
	"\x1bOB": "down",
	// 左侧完整字节串在 parseKey 反向查表时得到 "right"；这一查表不受 Kitty active 开关限制。
	"\x1bOC": "right",
	// 左侧完整字节串在 parseKey 反向查表时得到 "left"；这一查表不受 Kitty active 开关限制。
	"\x1bOD": "left",
	// 左侧完整字节串在 parseKey 反向查表时得到 "home"；这一查表不受 Kitty active 开关限制。
	"\x1bOH": "home",
	// 左侧完整字节串在 parseKey 反向查表时得到 "end"；这一查表不受 Kitty active 开关限制。
	"\x1bOF": "end",
	// 左侧完整字节串在 parseKey 反向查表时得到 "clear"；这一查表不受 Kitty active 开关限制。
	"\x1b[E": "clear",
	// 左侧完整字节串在 parseKey 反向查表时得到 "clear"；这一查表不受 Kitty active 开关限制。
	"\x1bOE": "clear",
	// 左侧完整字节串在 parseKey 反向查表时得到 "ctrl+clear"；这一查表不受 Kitty active 开关限制。
	"\x1bOe": "ctrl+clear",
	// 左侧完整字节串在 parseKey 反向查表时得到 "shift+clear"；这一查表不受 Kitty active 开关限制。
	"\x1b[e": "shift+clear",
	// 左侧完整字节串在 parseKey 反向查表时得到 "insert"；这一查表不受 Kitty active 开关限制。
	"\x1b[2~": "insert",
	// 左侧完整字节串在 parseKey 反向查表时得到 "shift+insert"；这一查表不受 Kitty active 开关限制。
	"\x1b[2$": "shift+insert",
	// 左侧完整字节串在 parseKey 反向查表时得到 "ctrl+insert"；这一查表不受 Kitty active 开关限制。
	"\x1b[2^": "ctrl+insert",
	// 左侧完整字节串在 parseKey 反向查表时得到 "shift+delete"；这一查表不受 Kitty active 开关限制。
	"\x1b[3$": "shift+delete",
	// 左侧完整字节串在 parseKey 反向查表时得到 "ctrl+delete"；这一查表不受 Kitty active 开关限制。
	"\x1b[3^": "ctrl+delete",
	// 左侧完整字节串在 parseKey 反向查表时得到 "pageUp"；这一查表不受 Kitty active 开关限制。
	"\x1b[[5~": "pageUp",
	// 左侧完整字节串在 parseKey 反向查表时得到 "pageDown"；这一查表不受 Kitty active 开关限制。
	"\x1b[[6~": "pageDown",
	// 左侧完整字节串在 parseKey 反向查表时得到 "shift+up"；这一查表不受 Kitty active 开关限制。
	"\x1b[a": "shift+up",
	// 左侧完整字节串在 parseKey 反向查表时得到 "shift+down"；这一查表不受 Kitty active 开关限制。
	"\x1b[b": "shift+down",
	// 左侧完整字节串在 parseKey 反向查表时得到 "shift+right"；这一查表不受 Kitty active 开关限制。
	"\x1b[c": "shift+right",
	// 左侧完整字节串在 parseKey 反向查表时得到 "shift+left"；这一查表不受 Kitty active 开关限制。
	"\x1b[d": "shift+left",
	// 左侧完整字节串在 parseKey 反向查表时得到 "ctrl+up"；这一查表不受 Kitty active 开关限制。
	"\x1bOa": "ctrl+up",
	// 左侧完整字节串在 parseKey 反向查表时得到 "ctrl+down"；这一查表不受 Kitty active 开关限制。
	"\x1bOb": "ctrl+down",
	// 左侧完整字节串在 parseKey 反向查表时得到 "ctrl+right"；这一查表不受 Kitty active 开关限制。
	"\x1bOc": "ctrl+right",
	// 左侧完整字节串在 parseKey 反向查表时得到 "ctrl+left"；这一查表不受 Kitty active 开关限制。
	"\x1bOd": "ctrl+left",
	// 左侧完整字节串在 parseKey 反向查表时得到 "shift+pageUp"；这一查表不受 Kitty active 开关限制。
	"\x1b[5$": "shift+pageUp",
	// 左侧完整字节串在 parseKey 反向查表时得到 "shift+pageDown"；这一查表不受 Kitty active 开关限制。
	"\x1b[6$": "shift+pageDown",
	// 左侧完整字节串在 parseKey 反向查表时得到 "shift+home"；这一查表不受 Kitty active 开关限制。
	"\x1b[7$": "shift+home",
	// 左侧完整字节串在 parseKey 反向查表时得到 "shift+end"；这一查表不受 Kitty active 开关限制。
	"\x1b[8$": "shift+end",
	// 左侧完整字节串在 parseKey 反向查表时得到 "ctrl+pageUp"；这一查表不受 Kitty active 开关限制。
	"\x1b[5^": "ctrl+pageUp",
	// 左侧完整字节串在 parseKey 反向查表时得到 "ctrl+pageDown"；这一查表不受 Kitty active 开关限制。
	"\x1b[6^": "ctrl+pageDown",
	// 左侧完整字节串在 parseKey 反向查表时得到 "ctrl+home"；这一查表不受 Kitty active 开关限制。
	"\x1b[7^": "ctrl+home",
	// 左侧完整字节串在 parseKey 反向查表时得到 "ctrl+end"；这一查表不受 Kitty active 开关限制。
	"\x1b[8^": "ctrl+end",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f1"；这一查表不受 Kitty active 开关限制。
	"\x1bOP": "f1",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f2"；这一查表不受 Kitty active 开关限制。
	"\x1bOQ": "f2",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f3"；这一查表不受 Kitty active 开关限制。
	"\x1bOR": "f3",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f4"；这一查表不受 Kitty active 开关限制。
	"\x1bOS": "f4",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f1"；这一查表不受 Kitty active 开关限制。
	"\x1b[11~": "f1",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f2"；这一查表不受 Kitty active 开关限制。
	"\x1b[12~": "f2",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f3"；这一查表不受 Kitty active 开关限制。
	"\x1b[13~": "f3",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f4"；这一查表不受 Kitty active 开关限制。
	"\x1b[14~": "f4",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f1"；这一查表不受 Kitty active 开关限制。
	"\x1b[[A": "f1",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f2"；这一查表不受 Kitty active 开关限制。
	"\x1b[[B": "f2",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f3"；这一查表不受 Kitty active 开关限制。
	"\x1b[[C": "f3",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f4"；这一查表不受 Kitty active 开关限制。
	"\x1b[[D": "f4",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f5"；这一查表不受 Kitty active 开关限制。
	"\x1b[[E": "f5",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f5"；这一查表不受 Kitty active 开关限制。
	"\x1b[15~": "f5",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f6"；这一查表不受 Kitty active 开关限制。
	"\x1b[17~": "f6",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f7"；这一查表不受 Kitty active 开关限制。
	"\x1b[18~": "f7",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f8"；这一查表不受 Kitty active 开关限制。
	"\x1b[19~": "f8",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f9"；这一查表不受 Kitty active 开关限制。
	"\x1b[20~": "f9",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f10"；这一查表不受 Kitty active 开关限制。
	"\x1b[21~": "f10",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f11"；这一查表不受 Kitty active 开关限制。
	"\x1b[23~": "f11",
	// 左侧完整字节串在 parseKey 反向查表时得到 "f12"；这一查表不受 Kitty active 开关限制。
	"\x1b[24~": "f12",
	// 左侧完整字节串在 parseKey 反向查表时得到 "alt+left"；这一查表不受 Kitty active 开关限制。
	"\x1bb": "alt+left",
	// 左侧完整字节串在 parseKey 反向查表时得到 "alt+right"；这一查表不受 Kitty active 开关限制。
	"\x1bf": "alt+right",
	// 左侧完整字节串在 parseKey 反向查表时得到 "alt+up"；这一查表不受 Kitty active 开关限制。
	"\x1bp": "alt+up",
	// 左侧完整字节串在 parseKey 反向查表时得到 "alt+down"；这一查表不受 Kitty active 开关限制。
	"\x1bn": "alt+down",
} as const;

// typeof 先取得 Shift 表的类型，keyof 得到共同可查的键名联合，用于 Shift/Ctrl 旧表查询。
type LegacyModifierKey = keyof typeof LEGACY_SHIFT_SEQUENCES;

// 判断 data 是否与数组某一条完整相等，返回 boolean；例：上方向两种编码任一命中。readonly 限制本函数写数组，无外部副作用。
const matchesLegacySequence = (data: string, sequences: readonly string[]): boolean => sequences.includes(data);

// 只匹配恰好 Shift 或恰好 Ctrl 的旧修饰编码；输入键名来自两张表共同字段，返回 boolean。
// 例：Shift+Home 用 Shift 表；Ctrl+Shift 不由这两张表识别，交给 Kitty 等后续分支。无状态修改。
const matchesLegacyModifierSequence = (data: string, key: LegacyModifierKey, modifier: number): boolean => {
	// 必须掩码完全等于 Shift，不能混有 Ctrl/Alt 等位。
	if (modifier === MODIFIERS.shift) {
		// 按键名取 Shift 编码数组，完整比较。
		return matchesLegacySequence(data, LEGACY_SHIFT_SEQUENCES[key]);
	}
	// 第二个允许的单修饰组合是恰好 Ctrl。
	if (modifier === MODIFIERS.ctrl) {
		// 取 Ctrl 编码数组进行完整比较。
		return matchesLegacySequence(data, LEGACY_CTRL_SEQUENCES[key]);
	}
	// 其他修饰组合在旧表中不匹配。
	return false;
};

// =============================================================================
// Kitty Protocol Parsing
// =============================================================================

/**
 * Event types from Kitty keyboard protocol (flag 2)
 * 1 = key press, 2 = key repeat, 3 = key release
 */
// 三个事件类型的字面量联合；协议数字 1/2/3 会由 parseEventType 转换。
export type KeyEventType = "press" | "repeat" | "release";

// 本地解析结果，不是原始协议全文；数字字段按报文转整数，类型本身不证明其在合法 Unicode 范围。
interface ParsedKittySequence {
	// 主要码点，功能键可能已经变为本文件的负数标识。
	codepoint: number;
	// 可选 Shift 结果码点；缺省时不推算键盘布局。
	shiftedKey?: number; // Shifted version of the key (when shift is pressed)
	// 可选标准 PC-101 物理位置对应键，非拉丁布局回退时可能使用。
	baseLayoutKey?: number; // Key in standard PC-101 layout (for non-Latin layouts)
	// 已减掉线上偏移 1 的修饰位，可包含锁键或其他未支持位。
	modifier: number;
	// 本报文的按下/重复/松开类型，匹配键身份时不会自动排除 release。
	eventType: KeyEventType;
}

// xterm modifyOtherKeys 只有这里需要的码点/修饰位，不记录独立事件类型。
interface ParsedModifyOtherKeysSequence {
	// 报文最后一个数字字段转成的字符码点。
	codepoint: number;
	// 报文修饰字段减 1 的位掩码。
	modifier: number;
}

// Store the last parsed event type for isKeyRelease() to query
// 保留原来的模块级最近事件变量；当前实现只在成功解析 Kitty 时赋值，isKeyRelease/isKeyRepeat 实际不读取它，而是检查传入字符串。
let _lastEventType: KeyEventType = "press";

/**
 * Check if the last parsed key event was a key release.
 * Only meaningful when Kitty keyboard protocol with flag 2 is active.
 */
// 检查本次字符串是否含松开事件标记，返回 boolean；例：CSI 99;5:3u 可判 true。
// 先排除含粘贴起始标记的内容，再做子串检测，不验证整个报文，不要求全局 Kitty active，也不读写 _lastEventType。
export function isKeyRelease(data: string): boolean {
	// Don't treat bracketed paste content as key release, even if it contains
	// patterns like ":3F" (e.g., bluetooth MAC addresses like "90:62:3F:A5").
	// Terminal.ts re-wraps paste content with bracketed paste markers before
	// passing to TUI, so pasted data will always contain \x1b[200~.
	// 粘贴块即使含 :3F 等普通文字也不当按键松开。
	if (data.includes("\x1b[200~")) {
		// 有粘贴起始标记就 false，不继续看事件后缀。
		return false;
	}

	// Quick check: release events with flag 2 contain ":3"
	// Format: \x1b[<codepoint>;<modifier>:3u
	// 下面用 || 逐个识别支持的结束字母；任一子串命中即 true，不检查是否位于整串末尾。
	if (
		// 检查是否包含事件片段 :3u；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":3u") ||
		// 检查是否包含事件片段 :3~；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":3~") ||
		// 检查是否包含事件片段 :3A；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":3A") ||
		// 检查是否包含事件片段 :3B；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":3B") ||
		// 检查是否包含事件片段 :3C；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":3C") ||
		// 检查是否包含事件片段 :3D；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":3D") ||
		// 检查是否包含事件片段 :3H；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":3H") ||
		// 检查是否包含事件片段 :3F；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":3F") ||
		// 检查是否包含事件片段 :3P；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":3P") ||
		// 检查是否包含事件片段 :3Q；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":3Q") ||
		// 检查是否包含事件片段 :3S；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":3S")
	) {
		// 发现任一种松开标记。
		return true;
	}
	// 没有这些标记，按非松开处理。
	return false;
}

/**
 * Check if the last parsed key event was a key repeat.
 * Only meaningful when Kitty keyboard protocol with flag 2 is active.
 */
// 检查本次字符串是否含重复事件标记，返回 boolean；例：CSI 99;1:2u 判 true。
// 规则与松开检查相似：排粘贴、查子串；不是读取上一次解析结果，也不验证完整 Kitty 语法，无状态修改。
export function isKeyRepeat(data: string): boolean {
	// Don't treat bracketed paste content as key repeat, even if it contains
	// patterns like ":2F". See isKeyRelease() for details.
	// 粘贴起始标记优先排除，避免把文字 :2F 当重复事件。
	if (data.includes("\x1b[200~")) {
		// 粘贴数据直接 false。
		return false;
	}

	// 任一重复事件后缀片段出现即可命中。
	if (
		// 检查是否包含事件片段 :2u；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":2u") ||
		// 检查是否包含事件片段 :2~；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":2~") ||
		// 检查是否包含事件片段 :2A；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":2A") ||
		// 检查是否包含事件片段 :2B；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":2B") ||
		// 检查是否包含事件片段 :2C；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":2C") ||
		// 检查是否包含事件片段 :2D；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":2D") ||
		// 检查是否包含事件片段 :2H；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":2H") ||
		// 检查是否包含事件片段 :2F；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":2F") ||
		// 检查是否包含事件片段 :2P；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":2P") ||
		// 检查是否包含事件片段 :2Q；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":2Q") ||
		// 检查是否包含事件片段 :2S；includes 是子串检测，当前不命中时，|| 才继续试其他结束形式。
		data.includes(":2S")
	) {
		// 检测到支持的重复标记。
		return true;
	}
	// 否则判非重复。
	return false;
}

// 将可选协议事件数字转为字面量，返回 press/repeat/release；例："2"→repeat，缺省或未知→press。
// 使用 parseInt 而非严格完整数字验证；这里调用方给的是正则捕获的数字串，无外部状态变化。
function parseEventType(eventTypeStr: string | undefined): KeyEventType {
	// 缺省或空串按普通按下。
	if (!eventTypeStr) return "press";
	// 按十进制解析数字。
	const eventType = parseInt(eventTypeStr, 10);
	// 2 对应按住后的重复。
	if (eventType === 2) return "repeat";
	// 3 对应松开。
	if (eventType === 3) return "release";
	// 包括 1 和其他数字的剩余情况都回退 press。
	return "press";
}

// 依次识别 CSI-u、修饰方向键、~ 功能键、Home/End、F1/F2/F4，返回结构或 null。
// 例：CSI 99;5:3u→码点99、Ctrl位4、release。成功分支写 _lastEventType，即使后续键匹配失败也已发生赋值。
// 不读取 active 开关，不完整实现 Kitty associated-text 等所有扩展，也不全面检查数字范围；不是无状态纯解析器。
function parseKittySequence(data: string): ParsedKittySequence | null {
	// CSI u format with alternate keys (flag 4):
	// \x1b[<codepoint>u
	// \x1b[<codepoint>;<mod>u
	// \x1b[<codepoint>;<mod>:<event>u
	// \x1b[<codepoint>:<shifted>;<mod>u
	// \x1b[<codepoint>:<shifted>:<base>;<mod>u
	// \x1b[<codepoint>::<base>;<mod>u (no shifted key, only base)
	//
	// With flag 2, event type is appended after modifier colon: 1=press, 2=repeat, 3=release
	// With flag 4, alternate keys are appended after codepoint with colons
	// 锚定整串的 CSI-u 子集；五组依次是主码点、可空 shifted、base、修饰数字、事件数字，未接收额外文本字段。
	const csiUMatch = data.match(/^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/);
	// 该形状通过后优先返回，不再尝试其他编码。
	if (csiUMatch) {
		// ! 是非空断言，匹配成功且第一组必填；不会在运行时增加校验。
		const codepoint = parseInt(csiUMatch[1]!, 10);
		// shifted 组可以省或为空，只有非空才转整数。
		const shiftedKey = csiUMatch[2] && csiUMatch[2].length > 0 ? parseInt(csiUMatch[2], 10) : undefined;
		// base 组有数字才解析，否则 undefined。
		const baseLayoutKey = csiUMatch[3] ? parseInt(csiUMatch[3], 10) : undefined;
		// 修饰字段缺省线上值 1，也就是内部无修饰 0。
		const modValue = csiUMatch[4] ? parseInt(csiUMatch[4], 10) : 1;
		// 将可选事件数字转为本地标签。
		const eventType = parseEventType(csiUMatch[5]);
		// 写最近类型；与本次实际要匹配哪一个键无关。
		_lastEventType = eventType;
		// 对象简写保留三种码点，modifier 减 1 解出位掩码。
		return { codepoint, shiftedKey, baseLayoutKey, modifier: modValue - 1, eventType };
	}

	// Arrow keys with modifier: \x1b[1;<mod>A/B/C/D or \x1b[1;<mod>:<event>A/B/C/D
	// 修饰方向键要求 CSI 1;数字 后跟可选事件及 A/B/C/D；普通无修饰短序列在旧表处理。
	const arrowMatch = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/);
	// 形状命中方向键分支。
	if (arrowMatch) {
		// 必填修饰字段转十进制。
		const modValue = parseInt(arrowMatch[1]!, 10);
		// 可选事件缺省 press。
		const eventType = parseEventType(arrowMatch[2]);
		// A/B/C/D 依次对应内部上/下/右/左负数标识。Record 只负责静态字典值类型。
		const arrowCodes: Record<string, number> = { A: -1, B: -2, C: -3, D: -4 };
		// 成功解析更新模块最近事件类型。
		_lastEventType = eventType;
		// 按捕获字母查内部码，两个 ! 只向 TS 声明本分支捕获/查表一定有值。
		return { codepoint: arrowCodes[arrowMatch[3]!]!, modifier: modValue - 1, eventType };
	}

	// Functional keys: \x1b[<num>~ or \x1b[<num>;<mod>~ or \x1b[<num>;<mod>:<event>~
	// 识别数字功能键 ~ 形式，允许省修饰和附带事件；接下来仍须确认数字在已知表中。
	const funcMatch = data.match(/^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?~$/);
	// 形状命中后读功能键编号。
	if (funcMatch) {
		// 这是终端功能编号，不直接当 Unicode 文本码点。
		const keyNum = parseInt(funcMatch[1]!, 10);
		// 修饰字段缺省 1，即内部 0。
		const modValue = funcMatch[2] ? parseInt(funcMatch[2], 10) : 1;
		// 解析可选事件字段。
		const eventType = parseEventType(funcMatch[3]);
		// 编号到内部功能码的表，仅列本实现支持的键。
		const funcCodes: Record<number, number> = {
			// 左侧终端数字编号映射为 insert 的内部负数标识。
			2: FUNCTIONAL_CODEPOINTS.insert,
			// 左侧终端数字编号映射为 delete 的内部负数标识。
			3: FUNCTIONAL_CODEPOINTS.delete,
			// 左侧终端数字编号映射为 pageUp 的内部负数标识。
			5: FUNCTIONAL_CODEPOINTS.pageUp,
			// 左侧终端数字编号映射为 pageDown 的内部负数标识。
			6: FUNCTIONAL_CODEPOINTS.pageDown,
			// 左侧终端数字编号映射为 home 的内部负数标识。
			7: FUNCTIONAL_CODEPOINTS.home,
			// 左侧终端数字编号映射为 end 的内部负数标识。
			8: FUNCTIONAL_CODEPOINTS.end,
			// 左侧终端数字编号映射为 f1 的内部负数标识。
			11: FUNCTIONAL_CODEPOINTS.f1,
			// 左侧终端数字编号映射为 f2 的内部负数标识。
			12: FUNCTIONAL_CODEPOINTS.f2,
			// 左侧终端数字编号映射为 f3 的内部负数标识。
			13: FUNCTIONAL_CODEPOINTS.f3,
			// 左侧终端数字编号映射为 f4 的内部负数标识。
			14: FUNCTIONAL_CODEPOINTS.f4,
			// 左侧终端数字编号映射为 f5 的内部负数标识。
			15: FUNCTIONAL_CODEPOINTS.f5,
			// 左侧终端数字编号映射为 f6 的内部负数标识。
			17: FUNCTIONAL_CODEPOINTS.f6,
			// 左侧终端数字编号映射为 f7 的内部负数标识。
			18: FUNCTIONAL_CODEPOINTS.f7,
			// 左侧终端数字编号映射为 f8 的内部负数标识。
			19: FUNCTIONAL_CODEPOINTS.f8,
			// 左侧终端数字编号映射为 f9 的内部负数标识。
			20: FUNCTIONAL_CODEPOINTS.f9,
			// 左侧终端数字编号映射为 f10 的内部负数标识。
			21: FUNCTIONAL_CODEPOINTS.f10,
			// 左侧终端数字编号映射为 f11 的内部负数标识。
			23: FUNCTIONAL_CODEPOINTS.f11,
			// 左侧终端数字编号映射为 f12 的内部负数标识。
			24: FUNCTIONAL_CODEPOINTS.f12,
		};
		// 根据终端编号查内部标识，未知编号可能 undefined。
		const codepoint = funcCodes[keyNum];
		// 只有已知功能编号才算解析成功。
		if (codepoint !== undefined) {
			// 已知编号分支才更新最近类型。
			_lastEventType = eventType;
			// 返回功能码和已减偏移的修饰位。
			return { codepoint, modifier: modValue - 1, eventType };
		}
	}

	// Home/End with modifier: \x1b[1;<mod>H/F or \x1b[1;<mod>:<event>H/F
	// Home/End 修饰编码末尾为 H/F，同样允许事件字段。
	const homeEndMatch = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([HF])$/);
	// 匹配到这个形状才处理。
	if (homeEndMatch) {
		// 必填修饰字段十进制解析。
		const modValue = parseInt(homeEndMatch[1]!, 10);
		// 读取可选事件，缺省按下。
		const eventType = parseEventType(homeEndMatch[2]);
		// H 是 Home，F 是 End，转内部负数标识。
		const codepoint = homeEndMatch[3] === "H" ? FUNCTIONAL_CODEPOINTS.home : FUNCTIONAL_CODEPOINTS.end;
		// 写最近事件类型，不能把本函数视为绝对无状态。
		_lastEventType = eventType;
		// 返回结构化 Home/End 事件。
		return { codepoint, modifier: modValue - 1, eventType };
	}

	// F1, F2, F4: \x1b[P/Q/S or \x1b[1;<mod>P/Q/S or \x1b[1;<mod>:<event>P/Q/S
	// F3 is sent as \x1b[13~ because \x1b[1;<mod>R collides with cursor position reports.
	// P/Q/S 形式支持 F1/F2/F4，修饰段整体可省；不把 R 当 F3，避免和光标位置回复冲突。
	const fKeyMatch = data.match(/^\x1b\[(?:1;(\d+)(?::(\d+))?)?([PQS])$/);
	// 匹配后按这组索引读取字段。
	if (fKeyMatch) {
		// 修饰组缺省 1，即无修饰。
		const modValue = fKeyMatch[1] ? parseInt(fKeyMatch[1], 10) : 1;
		// 事件可省，缺省 press。
		const eventType = parseEventType(fKeyMatch[2]);
		// 结束字母转功能码的本地小表。
		const fKeyCodes: Record<string, number> = {
			// P 对应 F1。
			P: FUNCTIONAL_CODEPOINTS.f1,
			// Q 对应 F2。
			Q: FUNCTIONAL_CODEPOINTS.f2,
			// S 对应 F4。
			S: FUNCTIONAL_CODEPOINTS.f4,
		};
		// 成功时写最近事件类型。
		_lastEventType = eventType;
		// 返回查得的功能键，modifier 仍按线上值减 1。
		return { codepoint: fKeyCodes[fKeyMatch[3]!]!, modifier: modValue - 1, eventType };
	}

	// 所有支持形状都失败则 null，不重置最近事件变量。
	return null;
}

// 比较一条报文与预期码点/修饰位，返回 boolean；例：CSI 99;5u 匹配 Ctrl+C。
// 依次比较归一化身份、Shift 逻辑符号、非拉丁布局回退，忽略锁位；会经 parseKittySequence 写最近事件类型，且不排除松开事件。
function matchesKittySequence(data: string, expectedCodepoint: number, expectedModifier: number): boolean {
	// 先完整解析支持的协议形状，可能产生模块状态赋值。
	const parsed = parseKittySequence(data);
	// 解析失败立即 false。
	if (!parsed) return false;
	// 实际修饰位去掉 Caps/Num Lock；其他位仍保留。
	const actualMod = parsed.modifier & ~LOCK_MASK;
	// 预期也清锁位，确保开锁状态不阻断常规快捷键。
	const expectedMod = expectedModifier & ~LOCK_MASK;

	// 实际码点先归一化小键盘，再归一化带 Shift 的 ASCII 大写身份。
	const normalizedCodepoint = normalizeShiftedLetterIdentityCodepoint(
		// 小键盘数字/导航映射到对应普通内部码。
		normalizeKittyFunctionalCodepoint(parsed.codepoint),
		// 原修饰位供大写身份判断，Shift 并未从匹配位中自动删除。
		parsed.modifier,
	);
	// 预期码点应用同样的身份归一化。
	const normalizedExpectedCodepoint = normalizeShiftedLetterIdentityCodepoint(
		// 预期若使用小键盘等价码也查同一表。
		normalizeKittyFunctionalCodepoint(expectedCodepoint),
		// 预期修饰位控制是否将 A..Z 换为 a..z。
		expectedModifier,
	);

	// Physical match: primary codepoint and every reported modifier match.
	// 身份与全部有效修饰位同时相等即可，eventType 不参与比较。
	if (actualMod === expectedMod && normalizedCodepoint === normalizedExpectedCodepoint) return true;

	// Logical match: Kitty reports symbols such as "+" as Shift plus the physical "=" key.
	// Bindings name the produced symbol, so consume that implicit Shift while preserving
	// Ctrl, Alt, and Super. The physical "shift+=" spelling remains valid through the match above.
	// 有 shiftedKey 时尝试将 Shift 消耗为逻辑标点；例：shift+= 也能匹配 +。
	const logicalShiftedSymbol = getLogicalShiftedSymbolCandidate(parsed.shiftedKey, actualMod, SYMBOL_KEYS);
	// 只有候选存在、剩余修饰相同、逻辑码点相同三项全满足才成功。
	if (
		// && 先保证候选不是 undefined，使后面 TS 可安全读字段。
		logicalShiftedSymbol &&
		// 逻辑符号扣除 Shift 后再去锁位，保留 Ctrl/Alt/Super 的区别。
		(logicalShiftedSymbol.modifier & ~LOCK_MASK) === expectedMod &&
		// 逻辑符号与预期的普通/小键盘等价码比较。
		logicalShiftedSymbol.codepoint === normalizeKittyFunctionalCodepoint(expectedCodepoint)
	) {
		// 逻辑符号匹配成功。
		return true;
	}

	// 前两条没成功且修饰位不同，就不允许拿物理位置挽救。
	if (actualMod !== expectedMod) return false;

	// Alternate match: use base layout key for non-Latin keyboard layouts.
	// This allows Ctrl+С (Cyrillic) to match Ctrl+c (Latin) when terminal reports
	// the base layout key (the key in standard PC-101 layout).
	//
	// Only fall back to base layout key when the codepoint is NOT already a
	// recognized Latin letter (a-z) or symbol (e.g., /, -, [, ;, etc.).
	// When the codepoint is a recognized key, it is authoritative regardless
	// of physical key position. This prevents remapped layouts (Dvorak, Colemak,
	// xremap, etc.) from causing false matches: both letters and symbols move
	// to different physical positions, so Ctrl+K could falsely match Ctrl+V
	// (letter remapping) and Ctrl+/ could falsely match Ctrl+[ (symbol remapping)
	// if the base layout key were always considered.
	// 仅当终端提供的 base 正好等于预期码点，才考虑非拉丁布局回退。
	if (parsed.baseLayoutKey !== undefined && parsed.baseLayoutKey === expectedCodepoint) {
		// 取已经归一化的主要身份供排除判断。
		const cp = normalizedCodepoint;
		// a..z 是已知拉丁字母，主要身份优先于物理位置。
		const isLatinLetter = cp >= 97 && cp <= 122; // a-z
		// 已知 ASCII 标点也优先；这里不像 formatParsedKey 那样额外排除数字。
		const isKnownSymbol = SYMBOL_KEYS.has(String.fromCharCode(cp));
		// 两类都不是才接受 base；不会无条件让所有键都按 QWERTY 物理位置匹配。
		if (!isLatinLetter && !isKnownSymbol) return true;
	}

	// 所有身份/逻辑符号/布局回退均不命中。
	return false;
}

// 解析 xterm CSI 27;修饰;码点~，返回结构或 null；例：CSI 27;5;99~ 表示 Ctrl+C。
// 只检查这个数字报文形状，不查 active、不验证完整 Unicode 范围、不写最近事件状态。
function parseModifyOtherKeysSequence(data: string): ParsedModifyOtherKeysSequence | null {
	// 正则 ^/$ 锚定整串，固定 27 前缀与两个必填十进制字段。
	const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
	// 未命中返回 null。
	if (!match) return null;
	// 第一组是线上修饰值，! 只消除 TS 的可空提示。
	const modValue = parseInt(match[1]!, 10);
	// 第二组是字符码点。
	const codepoint = parseInt(match[2]!, 10);
	// 修饰值减 1 得到内部位掩码。
	return { codepoint, modifier: modValue - 1 };
}

/**
 * Match xterm modifyOtherKeys format: CSI 27 ; modifiers ; keycode ~
 * This is used by terminals when Kitty protocol is not enabled.
 * Modifier values are 1-indexed: 2=shift, 3=alt, 5=ctrl, etc.
 */
// 严格比较 modifyOtherKeys 的码点和修饰位，返回 boolean；例：Ctrl+Enter 比较 13 与位4。
// 不做 Shift 符号消耗、大小写或锁位归一化，这些更复杂规则由可打印键专用函数处理；无状态修改。
function matchesModifyOtherKeys(data: string, expectedKeycode: number, expectedModifier: number): boolean {
	// 尝试支持的 modifyOtherKeys 形状。
	const parsed = parseModifyOtherKeysSequence(data);
	// 解析失败为 false。
	if (!parsed) return false;
	// 两个数字必须完全相同，不读取全局 Kitty 开关。
	return parsed.codepoint === expectedKeycode && parsed.modifier === expectedModifier;
}

// 按环境变量启发判断本地 Windows Terminal，返回 boolean；不查询系统，也不检查 process.platform。
// 例：WT_SESSION 非空且三个 SSH 标记都为空时为 true；这是为了消解 BS 的歧义，不保证识别真实连接拓扑。
function isWindowsTerminalSession(): boolean {
	// 返回下面四个环境条件的逻辑与。
	return (
		// WT_SESSION 要真值；任一 SSH 标记非空都排除，空串与未定义均被 ! 当作无标记。
		Boolean(process.env.WT_SESSION) && !process.env.SSH_CONNECTION && !process.env.SSH_CLIENT && !process.env.SSH_TTY
	);
}

/**
 * Raw 0x08 (BS) is ambiguous in legacy terminals.
 *
 * - Windows Terminal uses it for Ctrl+Backspace.
 * - Some legacy terminals and tmux setups send it for plain Backspace.
 *
 * Prefer explicit Kitty / CSI-u / modifyOtherKeys sequences whenever they are
 * available. Fall back to a Windows Terminal heuristic only for raw BS bytes.
 */
// 解释原始 DEL/BS 是否是指定修饰 Backspace，返回 boolean；例：本地 WT 的 BS 匹配 Ctrl+Backspace。
// 不解析扩展协议，不访问 native 键状态；依赖当前环境启发，BS 仍可能同时匹配 Ctrl+H。
function matchesRawBackspace(data: string, expectedModifier: number): boolean {
	// DEL 127 只匹配无修饰 Backspace。
	if (data === "\x7f") return expectedModifier === 0;
	// 不是 DEL 也不是 BS 8 就不是本函数识别的退格。
	if (data !== "\x08") return false;
	// BS 在本地 WT 按 Ctrl 位处理，其他环境按无修饰处理。
	return isWindowsTerminalSession() ? expectedModifier === MODIFIERS.ctrl : expectedModifier === 0;
}

// =============================================================================
// Generic Key Matching
// =============================================================================

/**
 * Get the control character for a key.
 * Uses the universal formula: code & 0x1f (mask to lower 5 bits)
 *
 * Works for:
 * - Letters a-z → 1-26
 * - Symbols [\]_ → 27, 28, 29, 31
 * - Also maps - to same as _ (same physical key on US keyboards)
 */
// 求有限几种旧 Ctrl 编码，返回单字符或 null；例：c→ETX(3)，- 与 _ 都→31。
// 只看 lower-case 后首单元及指定符号，不是所有键都可用此公式，无外部副作用。
function rawCtrlChar(key: string): string | null {
	// 先转小写，使调用方大写字母也能使用同一 ASCII 公式。
	const char = key.toLowerCase();
	// 取第一个 UTF-16 单元值；不是 Unicode 全字符解码。
	const code = char.charCodeAt(0);
	// 仅 a..z 或列出的四个符号进入通用控制字符公式。
	if ((code >= 97 && code <= 122) || char === "[" || char === "\\" || char === "]" || char === "_") {
		// &0x1f 保留低 5 位，例如 c(99)&31=3。
		return String.fromCharCode(code & 0x1f);
	}
	// Handle - as _ (same physical key on US keyboards)
	// 额外把横杠当美式键盘同键的下划线处理。
	if (char === "-") {
		// 返回码 31，与 Ctrl+_ 重叠。
		return String.fromCharCode(31); // Same as Ctrl+_
	}
	// 其他字符没有本函数支持的传统 Ctrl 表示。
	return null;
}

// 用字符串顺序比较判断数字范围，返回 boolean；例：单字符 "5" 为 true、"a" 为 false。
// 调用方会先确保单字符，因此这里不是任意字符串的严格数字验证器。无修改。
function isDigitKey(key: string): boolean {
	// 上下界含 0 和 9；多字符字符串也可能处于该字典序区间。
	return key >= "0" && key <= "9";
}

// 比较可打印 modifyOtherKeys 身份，返回 boolean；例：Shift+E 的大写码点仍可匹配 shift+e，Ctrl+Shift++ 可匹配 ctrl++。
// 先比修饰/大小写身份，再尝试消耗 Shift 的符号；不写 Kitty 事件状态，不统一清锁位。
function matchesPrintableModifyOtherKeys(data: string, expectedKeycode: number, expectedModifier: number): boolean {
	// 解析 modifyOtherKeys 数字结构。
	const parsed = parseModifyOtherKeysSequence(data);
	// 形状不符即 false。
	if (!parsed) return false;
	// 先计算物理身份条件，两行续接的是同一个 &&/=== 表达式。
	const physicalMatch =
		// 原修饰位必须完全一致。
		parsed.modifier === expectedModifier &&
		// 实际带 Shift 大写码点可归一化为小写身份。
		normalizeShiftedLetterIdentityCodepoint(parsed.codepoint, parsed.modifier) ===
			// 与同样归一化的预期身份比较。
			normalizeShiftedLetterIdentityCodepoint(expectedKeycode, expectedModifier);
	// 物理身份命中就无需逻辑符号回退。
	if (physicalMatch) return true;
	// 尝试消耗 Shift 以匹配已经产生的符号。
	const logicalShiftedSymbol = getLogicalShiftedSymbolCandidate(
		// modifyOtherKeys 没有 shiftedKey 字段，所以用主码点作为候选。
		parsed.codepoint,
		// 传当前原修饰位。
		parsed.modifier,
		// 只允许这张 Shift 结果符号表，不把所有普通符号都消耗 Shift。
		SHIFTED_SYMBOL_KEYS,
	);
	// 可选链判候选修饰位；&& 成功后读其码点，无候选则整个结果 false。
	return logicalShiftedSymbol?.modifier === expectedModifier && logicalShiftedSymbol.codepoint === expectedKeycode;
}

// 给已知键名加修饰前缀，返回字符串或 undefined；例：位5 + p→shift+ctrl+p。
// 去掉锁位、拒绝其余未知修饰，再按固定 Shift/Ctrl/Alt/Super 顺序拼接；无外部副作用，不检查 keyName 本身是否合法。
function formatKeyNameWithModifiers(keyName: string, modifier: number): string | undefined {
	// 局部字符串数组收集前缀。
	const mods: string[] = [];
	// 忽略 Caps/Num Lock，保留其他位。
	const effectiveMod = modifier & ~LOCK_MASK;
	// | 合并本应用能表达的四种修饰位。
	const supportedModifierMask = MODIFIERS.shift | MODIFIERS.ctrl | MODIFIERS.alt | MODIFIERS.super;
	// 有 Hyper/Meta 等支持集合外的位就无法格式化。
	if ((effectiveMod & ~supportedModifierMask) !== 0) return undefined;
	// & 检查 Shift 位，非零就加入 shift。
	if (effectiveMod & MODIFIERS.shift) mods.push("shift");
	// 其次加入 ctrl，输出顺序不依赖输入 keyId 的排列。
	if (effectiveMod & MODIFIERS.ctrl) mods.push("ctrl");
	// 然后加入 alt。
	if (effectiveMod & MODIFIERS.alt) mods.push("alt");
	// 最后加入 super。
	if (effectiveMod & MODIFIERS.super) mods.push("super");
	// 有前缀用 + 连接并附键名，没有则直接返回键名。
	return mods.length > 0 ? `${mods.join("+")}+${keyName}` : keyName;
}

// 拆快捷键标识为键名和四个布尔位，失败 null；例：ctrl++ 的最终键名是 +。
// 循环消耗任意顺序的已知前缀，拒绝重复修饰和残留的非单独 +；只做结构检查，不完整验证 BaseKey 集合。无外部修改。
function parseKeyId(
	// 输入是待解析字符串；公开入口用 KeyId 在编译期另加限制。
	keyId: string,
	// 返回匿名对象类型或 null；super 是对象属性名，不是此处的变量。
): { key: string; ctrl: boolean; shift: boolean; alt: boolean; super: boolean } | null {
	// 统一小写，故匹配时 pageUp 会变成 pageup。
	let key = keyId.toLowerCase();
	// typeof 取只读元组类型，再 [number] 得元素联合；Set 记录已出现的修饰名。
	const modifiers = new Set<(typeof MODIFIER_NAMES)[number]>();
	// 反复剥离前缀直到找不到；每轮成功都会缩短 key，循环能前进。
	while (true) {
		// find 按四个名字查 name+ 是否正好在开头，不把最终 + 键拆成普通分隔片段。
		const modifier = MODIFIER_NAMES.find((name) => key.startsWith(`${name}+`));
		// 没有已知前缀就结束循环，剩余串当键名。
		if (!modifier) break;
		// 重复的 ctrl+ctrl 等结构直接拒绝。
		if (modifiers.has(modifier)) return null;
		// 记录这次修饰键，Set 不保留重复项。
		modifiers.add(modifier);
		// 去掉名字和紧接的 +，保留剩余串继续解析。
		key = key.slice(modifier.length + 1);
	}
	// 必须剩键名；内部含 + 只能是单独 +，所以 ctrl++ 可行而 ctrl+a+b 不行。
	if (!key || (key.includes("+") && key !== "+")) return null;
	// 返回结构字段，后面公开匹配器还要确认键名是否支持。
	return {
		// 键名原局部值的属性简写。
		key,
		// 是否出现 Ctrl 前缀。
		ctrl: modifiers.has("ctrl"),
		// 是否出现 Shift 前缀。
		shift: modifiers.has("shift"),
		// 是否出现 Alt 前缀。
		alt: modifiers.has("alt"),
		// 是否出现 Super 前缀。
		super: modifiers.has("super"),
	};
}

/**
 * Match input data against a key identifier string.
 *
 * Supported key identifiers:
 * - Single keys: "escape", "tab", "enter", "backspace", "delete", "home", "end", "space"
 * - Arrow keys: "up", "down", "left", "right"
 * - Ctrl combinations: "ctrl+c", "ctrl+z", etc.
 * - Shift combinations: "shift+tab", "shift+enter"
 * - Alt combinations: "alt+enter", "alt+backspace"
 * - Super combinations: "super+k", "super+enter"
 * - Combined modifiers: "shift+ctrl+p", "ctrl+alt+x", "ctrl+super+k"
 *
 * Use the Key helper for autocomplete: Key.ctrl("c"), Key.escape, Key.ctrlShift("p"), Key.super("k")
 *
 * @param data - Raw input data from terminal
 * @param keyId - Key identifier (e.g., "ctrl+c", "escape", Key.ctrl("c"))
 */
// 判断一段终端输入是否代表指定键，返回 boolean；例：ETX 字节可匹配 ctrl+c。
// 先拆 keyId/合修饰位，再按键种尝试旧编码、Kitty、modifyOtherKeys；具体分支接受的兼容编码不同，不是统一转换后字符串相等。
// 读取全局 Kitty 模式和 WT/SSH 环境；走 Kitty 解析时可写 _lastEventType。不会排除 release/repeat，调用者如 TUI 要先过滤松开事件。
export function matchesKey(data: string, keyId: KeyId): boolean {
	// 先做 keyId 的结构检查，不把 TS 类型当作运行时验证。
	const parsed = parseKeyId(keyId);
	// 重复前缀等结构错误立即 false。
	if (!parsed) return false;

	// 对象解构；super 属性重命名为可用局部变量 superModifier。
	const { key, ctrl, shift, alt, super: superModifier } = parsed;
	// 从无修饰位开始累加。
	let modifier = 0;
	// |= 是按位或后写回，将 Shift 位加入。
	if (shift) modifier |= MODIFIERS.shift;
	// 有 Alt 标记就加入 Alt 位。
	if (alt) modifier |= MODIFIERS.alt;
	// 有 Ctrl 标记就加入 Ctrl 位。
	if (ctrl) modifier |= MODIFIERS.ctrl;
	// 有 Super 标记就加入 Super 位。
	if (superModifier) modifier |= MODIFIERS.super;

	// 按小写键名分派；每个 return 都直接结束本次匹配，不继续比较其他键种。
	switch (key) {
		// escape 与 esc 两个标签共用下一段；这里只允许无修饰 Escape，即使 KeyId 类型可拼修饰也不代表每个组合都实现。
		case "escape":
		case "esc":
			// Escape 若带任何修饰直接拒绝。
			if (modifier !== 0) return false;
			// 无修饰 Escape 接受下面三个编码入口，|| 命中即短路。
			return (
				// 直接 ESC 字节命中，不再解析 Kitty，因而也不更新最近事件类型。
				data === "\x1b" ||
				// 尝试显式 Kitty/CSI-u 的 Escape 码27、无修饰。
				matchesKittySequence(data, CODEPOINTS.escape, 0) ||
				// 最后尝试 modifyOtherKeys 编码的 Escape。
				matchesModifyOtherKeys(data, CODEPOINTS.escape, 0)
			);

		// 空格有旧 Ctrl/Alt 歧义编码，其余仍需比较准确修饰位。
		case "space":
			// 只有未启用 Kitty 时才使用这两个旧歧义形式。
			if (!_kittyProtocolActive) {
				// NUL 0 在此解释为旧 Ctrl+Space。
				if (modifier === MODIFIERS.ctrl && data === "\x00") {
					// Ctrl+Space 的旧形式成功。
					return true;
				}
				// ESC 后接空格在此解释为旧 Alt+Space。
				if (modifier === MODIFIERS.alt && data === "\x1b ") {
					// Alt+Space 的旧形式成功。
					return true;
				}
			}
			// 无修饰空格可额外直接接受普通空格字节。
			if (modifier === 0) {
				// 无修饰分支比较原文、Kitty、modifyOtherKeys 三种表示。
				return (
					// 单个普通空格是最直接的输入。
					data === " " ||
					// 比较 Kitty 的 CODEPOINTS.space 与零修饰位；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, CODEPOINTS.space, 0) ||
					// 比较 space 的 modifyOtherKeys 主码点及完整修饰位，不能隐含省掉修饰。
					matchesModifyOtherKeys(data, CODEPOINTS.space, 0)
				);
			}
			// 其他修饰组合不接受原始空格，只看携带修饰信息的报文。
			return (
				// 比较 Kitty 的 CODEPOINTS.space 与合并后的modifier位；解析可能写最近事件类型，键身份比较本身不排除松开。
				matchesKittySequence(data, CODEPOINTS.space, modifier) ||
				// 比较 space 的 modifyOtherKeys 主码点及完整修饰位，不能隐含省掉修饰。
				matchesModifyOtherKeys(data, CODEPOINTS.space, modifier)
			);

		// Tab 将 Shift 分支单独处理，因为很多终端发送专门的反向 Tab 编码。
		case "tab":
			// 必须恰好 Shift，不把 Ctrl+Shift 也送入这条兼容分支。
			if (modifier === MODIFIERS.shift) {
				// Shift+Tab 接受旧反向 Tab、Kitty、modifyOtherKeys。
				return (
					// CSI Z 是传统 Shift+Tab，不是普通字符 Z。
					data === "\x1b[Z" ||
					// 比较 Kitty 的 CODEPOINTS.tab 与Shift位1；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, CODEPOINTS.tab, MODIFIERS.shift) ||
					// 比较 tab 的 modifyOtherKeys 主码点及完整修饰位，不能隐含省掉修饰。
					matchesModifyOtherKeys(data, CODEPOINTS.tab, MODIFIERS.shift)
				);
			}
			// 无修饰 Tab 走更窄的两种匹配。
			if (modifier === 0) {
				// 原始 HT 或 Kitty Tab；这里没有另试无修饰 modifyOtherKeys，不能从其他分支推断所有格式都支持。
				return data === "\t" || matchesKittySequence(data, CODEPOINTS.tab, 0);
			}
			// 其余修饰的 Tab 交给两个显式协议比较。
			return (
				// 比较 Kitty 的 CODEPOINTS.tab 与合并后的modifier位；解析可能写最近事件类型，键身份比较本身不排除松开。
				matchesKittySequence(data, CODEPOINTS.tab, modifier) ||
				// 比较 tab 的 modifyOtherKeys 主码点及完整修饰位，不能隐含省掉修饰。
				matchesModifyOtherKeys(data, CODEPOINTS.tab, modifier)
			);

		// enter/return 两个别名进入同一段，普通 Enter 和小键盘 Enter 部分格式共用身份。
		case "enter":
		case "return":
			// Shift+Enter 先试显式报文，最后才按 Kitty active 解释自定义旧映射。
			if (modifier === MODIFIERS.shift) {
				// CSI u sequences (standard Kitty protocol)
				// 普通 Enter 或小键盘 Enter 任一显式 Shift 事件可命中。
				if (
					// 比较 Kitty 的 CODEPOINTS.enter 与Shift位1；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.shift) ||
					// 比较 Kitty 的 CODEPOINTS.kpEnter 与Shift位1；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.shift)
				) {
					// 显式 Shift+Enter 匹配成功。
					return true;
				}
				// xterm modifyOtherKeys format (fallback when Kitty protocol not enabled)
				// modifyOtherKeys 的支持不由全局 active 阻止；此处仍直接尝试其 Shift+Enter。
				if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.shift)) {
					// modifyOtherKeys 形式成功。
					return true;
				}
				// When Kitty protocol is active, legacy sequences are custom terminal mappings
				// \x1b\r = Kitty's "map shift+enter send_text all \e\r"
				// \n = Ghostty's "keybind = shift+enter=text:\n"
				// 只有 active 模式才把这些歧义字节视为终端自定义 Shift+Enter。
				if (_kittyProtocolActive) {
					// ESC+CR 或 LF 被映射成 Shift+Enter；并不是已收到独立 Shift 状态。
					return data === "\x1b\r" || data === "\n";
				}
				// 非 active 模式且没有显式 Shift 报文，不猜测 Shift+Enter。
				return false;
			}
			// Alt+Enter 使用另一组与模式有关的旧兼容规则。
			if (modifier === MODIFIERS.alt) {
				// CSI u sequences (standard Kitty protocol)
				// 先尝试两个 Enter 身份的显式 Alt 事件。
				if (
					// 比较 Kitty 的 CODEPOINTS.enter 与Alt位2；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.alt) ||
					// 比较 Kitty 的 CODEPOINTS.kpEnter 与Alt位2；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.alt)
				) {
					// 显式 Alt+Enter 命中。
					return true;
				}
				// xterm modifyOtherKeys format (fallback when Kitty protocol not enabled)
				// 再试 modifyOtherKeys 的 Alt+Enter，不在这里要求协议开关为 false。
				if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.alt)) {
					// 该报文命中。
					return true;
				}
				// \x1b\r is alt+enter only in legacy mode (no Kitty protocol)
				// When Kitty protocol is active, alt+enter comes as CSI u sequence
				// 只有旧模式才把 ESC+CR 当 Alt+Enter；active 时该串已经留给 Shift。
				if (!_kittyProtocolActive) {
					// 完整比较 ESC+CR。
					return data === "\x1b\r";
				}
				// active 下未命中显式格式就不是 Alt+Enter。
				return false;
			}
			// 无修饰 Enter 支持原始 CR、部分旧 LF/SS3 及两种 Kitty Enter 码。
			if (modifier === 0) {
				// 逐个尝试这些兼容表示，遇到真值即短路。
				return (
					// CR 始终可表示无修饰 Enter。
					data === "\r" ||
					// LF 只有非 active 才是普通 Enter，active 下此前作为 Shift+Enter。
					(!_kittyProtocolActive && data === "\n") ||
					// SS3 M 是部分终端小键盘 Enter 的旧编码。
					data === "\x1bOM" || // SS3 M (numpad enter in some terminals)
					// 比较 Kitty 的 CODEPOINTS.enter 与零修饰位；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, CODEPOINTS.enter, 0) ||
					// 比较 Kitty 的 CODEPOINTS.kpEnter 与零修饰位；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, CODEPOINTS.kpEnter, 0)
				);
			}
			// 其他修饰组合走显式协议；这里的无修饰分支并没有通用 modifyOtherKeys 兜底。
			return (
				// 比较 Kitty 的 CODEPOINTS.enter 与合并后的modifier位；解析可能写最近事件类型，键身份比较本身不排除松开。
				matchesKittySequence(data, CODEPOINTS.enter, modifier) ||
				// 比较 Kitty 的 CODEPOINTS.kpEnter 与合并后的modifier位；解析可能写最近事件类型，键身份比较本身不排除松开。
				matchesKittySequence(data, CODEPOINTS.kpEnter, modifier) ||
				// 比较 Enter 的 modifyOtherKeys 主码点13与指定修饰位；这是严格数字比较，不消耗隐含Shift。
				matchesModifyOtherKeys(data, CODEPOINTS.enter, modifier)
			);

		// 退格区分原始 DEL/BS、Alt 前缀和显式协议；旧 BS 有 Windows Terminal 特殊启发。
		case "backspace":
			// 恰好 Alt 的退格先保留常见 ESC 前缀形式。
			if (modifier === MODIFIERS.alt) {
				// ESC+DEL 或 ESC+BS 都当 Alt+Backspace，active 下也接受这两个形式。
				if (data === "\x1b\x7f" || data === "\x1b\b") {
					// 旧 Alt+Backspace 命中。
					return true;
				}
				// 旧形式不符再试显式 Alt 报文。
				return (
					// 比较 Kitty 的 CODEPOINTS.backspace 与Alt位2；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.alt) ||
					// 比较 backspace 的 modifyOtherKeys 主码点及完整修饰位，不能隐含省掉修饰。
					matchesModifyOtherKeys(data, CODEPOINTS.backspace, MODIFIERS.alt)
				);
			}
			// 恰好 Ctrl 时允许平台启发解释原始 BS。
			if (modifier === MODIFIERS.ctrl) {
				// Legacy raw 0x08 is ambiguous: it can be Ctrl+Backspace on Windows
				// Terminal or plain Backspace on other terminals, while also
				// overlapping with Ctrl+H.
				// DEL 不会匹配此分支；本地 WT 的 BS 可命中，其余环境还要继续协议比较。
				if (matchesRawBackspace(data, MODIFIERS.ctrl)) return true;
				// 再比较两种显式 Ctrl+Backspace 报文。
				return (
					// 比较 Kitty 的 CODEPOINTS.backspace 与Ctrl位4；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.ctrl) ||
					// 比较 backspace 的 modifyOtherKeys 主码点及完整修饰位，不能隐含省掉修饰。
					matchesModifyOtherKeys(data, CODEPOINTS.backspace, MODIFIERS.ctrl)
				);
			}
			// 没有修饰时用原始字节启发及显式无修饰报文。
			if (modifier === 0) {
				// 依次尝试三种退格表示。
				return (
					// DEL 或非本地 WT 的 BS 可代表普通退格。
					matchesRawBackspace(data, 0) ||
					// 比较 Kitty 的 CODEPOINTS.backspace 与零修饰位；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, CODEPOINTS.backspace, 0) ||
					// 比较 backspace 的 modifyOtherKeys 主码点及完整修饰位，不能隐含省掉修饰。
					matchesModifyOtherKeys(data, CODEPOINTS.backspace, 0)
				);
			}
			// Shift、组合修饰等剩余情况不猜原始字节，只试显式协议。
			return (
				// 比较 Kitty 的 CODEPOINTS.backspace 与合并后的modifier位；解析可能写最近事件类型，键身份比较本身不排除松开。
				matchesKittySequence(data, CODEPOINTS.backspace, modifier) ||
				// 比较 backspace 的 modifyOtherKeys 主码点及完整修饰位，不能隐含省掉修饰。
				matchesModifyOtherKeys(data, CODEPOINTS.backspace, modifier)
			);

		// Insert 先查无修饰旧表，带修饰可查 rxvt Shift/Ctrl 表，最后比较 Kitty 内部功能码。
		case "insert":
			// insert 的无修饰分支：可接受对应旧表与显式零修饰报文。
			if (modifier === 0) {
				// 返回下面 insert 编码比较的逻辑或；命中前项就不执行后续解析。
				return (
					// 完整查 insert 无修饰编码数组，接受该数组明确列出的历史形式。
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.insert) ||
					// 比较 Kitty 的 FUNCTIONAL_CODEPOINTS.insert 与零修饰位；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.insert, 0)
				);
			}
			// 先查 insert 的旧 Shift/Ctrl 表，仅单一这两种修饰可命中。
			if (matchesLegacyModifierSequence(data, "insert", modifier)) {
				// 此 insert 兼容分支匹配成功，结束本次检查。
				return true;
			}
			// 比较 Kitty 的 FUNCTIONAL_CODEPOINTS.insert 与合并后的modifier位；解析可能写最近事件类型，键身份比较本身不排除松开。
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.insert, modifier);

		// Delete 使用其自身旧表和内部功能码，结构与 Insert 相同。
		case "delete":
			// delete 的无修饰分支：可接受对应旧表与显式零修饰报文。
			if (modifier === 0) {
				// 返回下面 delete 编码比较的逻辑或；命中前项就不执行后续解析。
				return (
					// 完整查 delete 无修饰编码数组，接受该数组明确列出的历史形式。
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.delete) ||
					// 比较 Kitty 的 FUNCTIONAL_CODEPOINTS.delete 与零修饰位；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.delete, 0)
				);
			}
			// 先查 delete 的旧 Shift/Ctrl 表，仅单一这两种修饰可命中。
			if (matchesLegacyModifierSequence(data, "delete", modifier)) {
				// 此 delete 兼容分支匹配成功，结束本次检查。
				return true;
			}
			// 比较 Kitty 的 FUNCTIONAL_CODEPOINTS.delete 与合并后的modifier位；解析可能写最近事件类型，键身份比较本身不排除松开。
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.delete, modifier);

		// Clear 只支持这里的旧表及单 Shift/Ctrl 表，没有额外 Kitty 码点回退。
		case "clear":
			// 无修饰 Clear 查普通旧编码。
			if (modifier === 0) {
				// 只比较 clear 的两个旧串，不把 CSI-u 的任何码点猜成 Clear。
				return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.clear);
			}
			// 有修饰时只有单 Shift 或单 Ctrl 的旧表可能成功。
			return matchesLegacyModifierSequence(data, "clear", modifier);

		// Home 兼容多种无修饰旧编码，再查旧修饰表或显式 Kitty。
		case "home":
			// home 的无修饰分支：可接受对应旧表与显式零修饰报文。
			if (modifier === 0) {
				// 返回下面 home 编码比较的逻辑或；命中前项就不执行后续解析。
				return (
					// 完整查 home 无修饰编码数组，接受该数组明确列出的历史形式。
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.home) ||
					// 比较 Kitty 的 FUNCTIONAL_CODEPOINTS.home 与零修饰位；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.home, 0)
				);
			}
			// 先查 home 的旧 Shift/Ctrl 表，仅单一这两种修饰可命中。
			if (matchesLegacyModifierSequence(data, "home", modifier)) {
				// 此 home 兼容分支匹配成功，结束本次检查。
				return true;
			}
			// 比较 Kitty 的 FUNCTIONAL_CODEPOINTS.home 与合并后的modifier位；解析可能写最近事件类型，键身份比较本身不排除松开。
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.home, modifier);

		// End 与 Home 分开使用各自编码/标识，不按光标位置推断。
		case "end":
			// end 的无修饰分支：可接受对应旧表与显式零修饰报文。
			if (modifier === 0) {
				// 返回下面 end 编码比较的逻辑或；命中前项就不执行后续解析。
				return (
					// 完整查 end 无修饰编码数组，接受该数组明确列出的历史形式。
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.end) ||
					// 比较 Kitty 的 FUNCTIONAL_CODEPOINTS.end 与零修饰位；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.end, 0)
				);
			}
			// 先查 end 的旧 Shift/Ctrl 表，仅单一这两种修饰可命中。
			if (matchesLegacyModifierSequence(data, "end", modifier)) {
				// 此 end 兼容分支匹配成功，结束本次检查。
				return true;
			}
			// 比较 Kitty 的 FUNCTIONAL_CODEPOINTS.end 与合并后的modifier位；解析可能写最近事件类型，键身份比较本身不排除松开。
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.end, modifier);

		// 输入 keyId 先转小写，故 pageUp 在 switch 中以 pageup 标签出现。
		case "pageup":
			// pageup 的无修饰分支：可接受对应旧表与显式零修饰报文。
			if (modifier === 0) {
				// 返回下面 pageup 编码比较的逻辑或；命中前项就不执行后续解析。
				return (
					// 完整查 pageup 无修饰编码数组，接受该数组明确列出的历史形式。
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.pageUp) ||
					// 比较 Kitty 的 FUNCTIONAL_CODEPOINTS.pageUp 与零修饰位；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageUp, 0)
				);
			}
			// 先查 pageup 的旧 Shift/Ctrl 表，仅单一这两种修饰可命中。
			if (matchesLegacyModifierSequence(data, "pageUp", modifier)) {
				// 此 pageup 兼容分支匹配成功，结束本次检查。
				return true;
			}
			// 比较 Kitty 的 FUNCTIONAL_CODEPOINTS.pageUp 与合并后的modifier位；解析可能写最近事件类型，键身份比较本身不排除松开。
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageUp, modifier);

		// 同理 pageDown 变为 pagedown，查表时仍用原属性名 pageDown。
		case "pagedown":
			// pagedown 的无修饰分支：可接受对应旧表与显式零修饰报文。
			if (modifier === 0) {
				// 返回下面 pagedown 编码比较的逻辑或；命中前项就不执行后续解析。
				return (
					// 完整查 pagedown 无修饰编码数组，接受该数组明确列出的历史形式。
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.pageDown) ||
					// 比较 Kitty 的 FUNCTIONAL_CODEPOINTS.pageDown 与零修饰位；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageDown, 0)
				);
			}
			// 先查 pagedown 的旧 Shift/Ctrl 表，仅单一这两种修饰可命中。
			if (matchesLegacyModifierSequence(data, "pageDown", modifier)) {
				// 此 pagedown 兼容分支匹配成功，结束本次检查。
				return true;
			}
			// 比较 Kitty 的 FUNCTIONAL_CODEPOINTS.pageDown 与合并后的modifier位；解析可能写最近事件类型，键身份比较本身不排除松开。
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageDown, modifier);

		// 上方向的旧 Alt 编码是 ESC+p；和 Alt+p 字母编码重叠，这是兼容规则，不保证一字节串只匹配一个 KeyId。
		case "up":
			// 恰好 Alt+Up 优先尝试旧别名。
			if (modifier === MODIFIERS.alt) {
				// ESC+p 或显式 Kitty 上方向+Alt 任一成立。
				return data === "\x1bp" || matchesKittySequence(data, ARROW_CODEPOINTS.up, MODIFIERS.alt);
			}
			// up 的无修饰分支：可接受对应旧表与显式零修饰报文。
			if (modifier === 0) {
				// 返回下面 up 编码比较的逻辑或；命中前项就不执行后续解析。
				return (
					// 完整查 up 无修饰编码数组，接受该数组明确列出的历史形式。
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.up) ||
					// 比较 Kitty 的 ARROW_CODEPOINTS.up 与零修饰位；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, ARROW_CODEPOINTS.up, 0)
				);
			}
			// 先查 up 的旧 Shift/Ctrl 表，仅单一这两种修饰可命中。
			if (matchesLegacyModifierSequence(data, "up", modifier)) {
				// 此 up 兼容分支匹配成功，结束本次检查。
				return true;
			}
			// 比较 Kitty 的 ARROW_CODEPOINTS.up 与合并后的modifier位；解析可能写最近事件类型，键身份比较本身不排除松开。
			return matchesKittySequence(data, ARROW_CODEPOINTS.up, modifier);

		// 下方向的旧 Alt 编码是 ESC+n，也可能与字母 Alt+n 重叠。
		case "down":
			// 恰好 Alt+Down 使用这个兼容分支。
			if (modifier === MODIFIERS.alt) {
				// ESC+n 或显式下方向+Alt 任一命中。
				return data === "\x1bn" || matchesKittySequence(data, ARROW_CODEPOINTS.down, MODIFIERS.alt);
			}
			// down 的无修饰分支：可接受对应旧表与显式零修饰报文。
			if (modifier === 0) {
				// 返回下面 down 编码比较的逻辑或；命中前项就不执行后续解析。
				return (
					// 完整查 down 无修饰编码数组，接受该数组明确列出的历史形式。
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.down) ||
					// 比较 Kitty 的 ARROW_CODEPOINTS.down 与零修饰位；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, ARROW_CODEPOINTS.down, 0)
				);
			}
			// 先查 down 的旧 Shift/Ctrl 表，仅单一这两种修饰可命中。
			if (matchesLegacyModifierSequence(data, "down", modifier)) {
				// 此 down 兼容分支匹配成功，结束本次检查。
				return true;
			}
			// 比较 Kitty 的 ARROW_CODEPOINTS.down 与合并后的modifier位；解析可能写最近事件类型，键身份比较本身不排除松开。
			return matchesKittySequence(data, ARROW_CODEPOINTS.down, modifier);

		// 左方向保留多组 Alt/Ctrl 兼容形式，大写 B 别名受 active 开关限制，小写 b 不受限制。
		case "left":
			// 恰好 Alt+Left 时逐个比较兼容串。
			if (modifier === MODIFIERS.alt) {
				// 下面四种表示任一匹配就返回 true。
				return (
					// 带数字修饰的 CSI 左方向，线上3表示内部Alt位2。
					data === "\x1b[1;3D" ||
					// ESC+B 只在非 active 下作为左移旧别名。
					(!_kittyProtocolActive && data === "\x1bB") ||
					// ESC+b 在两种模式下都兼容为 Alt+Left。
					data === "\x1bb" ||
					// 比较 Kitty 的 ARROW_CODEPOINTS.left 与Alt位2；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.alt)
				);
			}
			// 恰好 Ctrl+Left 的专门兼容分支。
			if (modifier === MODIFIERS.ctrl) {
				// 先比较常见字面 CSI，再查 rxvt 与 Kitty，短路会影响是否执行解析状态赋值。
				return (
					// 线上5对应内部Ctrl位4的左移序列。
					data === "\x1b[1;5D" ||
					// 比较 left 的旧单修饰编码；该函数不推断组合修饰。
					matchesLegacyModifierSequence(data, "left", MODIFIERS.ctrl) ||
					// 比较 Kitty 的 ARROW_CODEPOINTS.left 与Ctrl位4；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.ctrl)
				);
			}
			// left 的无修饰分支：可接受对应旧表与显式零修饰报文。
			if (modifier === 0) {
				// 返回下面 left 编码比较的逻辑或；命中前项就不执行后续解析。
				return (
					// 完整查 left 无修饰编码数组，接受该数组明确列出的历史形式。
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.left) ||
					// 比较 Kitty 的 ARROW_CODEPOINTS.left 与零修饰位；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, ARROW_CODEPOINTS.left, 0)
				);
			}
			// 先查 left 的旧 Shift/Ctrl 表，仅单一这两种修饰可命中。
			if (matchesLegacyModifierSequence(data, "left", modifier)) {
				// 此 left 兼容分支匹配成功，结束本次检查。
				return true;
			}
			// 比较 Kitty 的 ARROW_CODEPOINTS.left 与合并后的modifier位；解析可能写最近事件类型，键身份比较本身不排除松开。
			return matchesKittySequence(data, ARROW_CODEPOINTS.left, modifier);

		// 右方向镜像使用 C/F/f 编码；仍要按各条件实际接受，不能按名字推断与左边完全同字节。
		case "right":
			// 恰好 Alt+Right 的兼容分支。
			if (modifier === MODIFIERS.alt) {
				// 四种可接受表示逐个比较。
				return (
					// 带数字修饰的 CSI 右方向，线上3是Alt。
					data === "\x1b[1;3C" ||
					// ESC+F 只在非 active 模式作为旧右移别名。
					(!_kittyProtocolActive && data === "\x1bF") ||
					// ESC+f 在两种模式都可作为 Alt+Right。
					data === "\x1bf" ||
					// 比较 Kitty 的 ARROW_CODEPOINTS.right 与Alt位2；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.alt)
				);
			}
			// 恰好 Ctrl+Right 的专门分支。
			if (modifier === MODIFIERS.ctrl) {
				// 比较字面 CSI、旧 Ctrl 表及 Kitty。
				return (
					// 线上5是Ctrl，C是右方向。
					data === "\x1b[1;5C" ||
					// 比较 right 的旧单修饰编码；该函数不推断组合修饰。
					matchesLegacyModifierSequence(data, "right", MODIFIERS.ctrl) ||
					// 比较 Kitty 的 ARROW_CODEPOINTS.right 与Ctrl位4；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.ctrl)
				);
			}
			// right 的无修饰分支：可接受对应旧表与显式零修饰报文。
			if (modifier === 0) {
				// 返回下面 right 编码比较的逻辑或；命中前项就不执行后续解析。
				return (
					// 完整查 right 无修饰编码数组，接受该数组明确列出的历史形式。
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.right) ||
					// 比较 Kitty 的 ARROW_CODEPOINTS.right 与零修饰位；解析可能写最近事件类型，键身份比较本身不排除松开。
					matchesKittySequence(data, ARROW_CODEPOINTS.right, 0)
				);
			}
			// 先查 right 的旧 Shift/Ctrl 表，仅单一这两种修饰可命中。
			if (matchesLegacyModifierSequence(data, "right", modifier)) {
				// 此 right 兼容分支匹配成功，结束本次检查。
				return true;
			}
			// 比较 Kitty 的 ARROW_CODEPOINTS.right 与合并后的modifier位；解析可能写最近事件类型，键身份比较本身不排除松开。
			return matchesKittySequence(data, ARROW_CODEPOINTS.right, modifier);

		// F1..F12 标签共用下面代码块；不支持的 F13 等不在 KeyId/此分支中。
		case "f1":
		case "f2":
		case "f3":
		case "f4":
		case "f5":
		case "f6":
		case "f7":
		case "f8":
		case "f9":
		case "f10":
		case "f11":
		// 最后一个标签打开局部块，供下面声明 functionKey，不影响其他 case 的变量作用域。
		case "f12": {
			// as 将已被 case 限定的键断言为两张表共同的 keyof 交集，便于索引；不做运行时转换。
			const functionKey = key as keyof typeof LEGACY_KEY_SEQUENCES & keyof typeof FUNCTIONAL_CODEPOINTS;
			// 无修饰且旧功能键数组命中时直接成功。
			if (modifier === 0 && matchesLegacySequence(data, LEGACY_KEY_SEQUENCES[functionKey])) {
				// 不再解析 Kitty，最近事件变量保持此前值。
				return true;
			}
			// 否则用对应内部功能标识比较完整修饰位，包含事件的报文也只比较键身份。
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS[functionKey], modifier);
		}
	}

	// Handle single letter/digit keys and symbols
	// 命名键都未返回后，仅接受长度1的 a..z、数字、已列标点；不把任意 Unicode 文字当快捷键名。
	if (key.length === 1 && ((key >= "a" && key <= "z") || isDigitKey(key) || SYMBOL_KEYS.has(key))) {
		// 已知都是 ASCII 基本键，取首 UTF-16 值即所需码点。
		const codepoint = key.charCodeAt(0);
		// 预计算可用的传统 Ctrl 字符，某些标点会得到 null。
		const rawCtrl = rawCtrlChar(key);
		// 记录是否拉丁字母，稍后可用大写表示 Shift。
		const isLetter = key >= "a" && key <= "z";
		// 记录是否数字，供旧 Alt 字符分支使用。
		const isDigit = isDigitKey(key);

		// 只对非 active 模式且可用 rawCtrl 的 Ctrl+Alt 组合尝试 ESC+控制字符；独立位用加法也可合并。
		if (modifier === MODIFIERS.ctrl + MODIFIERS.alt && !_kittyProtocolActive && rawCtrl) {
			// Legacy: ctrl+alt+key is ESC followed by the control character.
			// If that legacy form does not match, continue so CSI-u and
			// modifyOtherKeys sequences from tmux can still be recognized.
			// 命中该旧形式即 true；不符仍继续，不能让此分支屏蔽 tmux 等发来的显式报文。
			if (data === `\x1b${rawCtrl}`) return true;
		}

		// 非 active 的单 Alt+可打印基本键尝试 ESC 前缀；active 时跳过该猜测。
		if (modifier === MODIFIERS.alt && !_kittyProtocolActive && (isLetter || isDigit || SYMBOL_KEYS.has(key))) {
			// Legacy: alt+printable key is ESC followed by the key
			// 完整比较 ESC+键名字串，不合适就继续后面的协议分支。
			if (data === `\x1b${key}`) return true;
		}

		// 单 Ctrl 既可用旧控制字节，也可用显式协议；这一旧 Ctrl 判断没有要求 active 为 false。
		if (modifier === MODIFIERS.ctrl) {
			// Legacy: ctrl+key sends the control character
			// rawCtrl 非空且字节相同就成功，例如 Ctrl+H 与 BS 重叠仍可命中。
			if (rawCtrl && data === rawCtrl) return true;
			// 旧字节没命中时比较 Kitty 和可打印 modifyOtherKeys。
			return (
				// 比较 Kitty 的 当前单字符码点 与Ctrl位4；解析可能写最近事件类型，键身份比较本身不排除松开。
				matchesKittySequence(data, codepoint, MODIFIERS.ctrl) ||
				// 对当前可打印键比较 modifyOtherKeys，允许其专用的Shift大小写身份/逻辑符号规则。
				matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.ctrl)
			);
		}

		// 恰好 Shift+Ctrl 不使用旧单 Ctrl 字节，以免丢掉 Shift 区别。
		if (modifier === MODIFIERS.shift + MODIFIERS.ctrl) {
			// 两种显式格式都交给可处理 Shift 身份的比较器。
			return (
				// 比较 Kitty 的 当前单字符码点 与Shift位1 + Ctrl位4；解析可能写最近事件类型，键身份比较本身不排除松开。
				matchesKittySequence(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl) ||
				// 对当前可打印键比较 modifyOtherKeys，允许其专用的Shift大小写身份/逻辑符号规则。
				matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl)
			);
		}

		// 只有单 Shift 时可额外从大写拉丁字母推断。
		if (modifier === MODIFIERS.shift) {
			// Legacy: shift+letter produces uppercase
			// 例如 key 为 a 且输入 A 就成功；数字/标点不在这里猜 Shift 键位。
			if (isLetter && data === key.toUpperCase()) return true;
			// 否则仍尝试显式 Shift 格式。
			return (
				// 比较 Kitty 的 当前单字符码点 与Shift位1；解析可能写最近事件类型，键身份比较本身不排除松开。
				matchesKittySequence(data, codepoint, MODIFIERS.shift) ||
				// 对当前可打印键比较 modifyOtherKeys，允许其专用的Shift大小写身份/逻辑符号规则。
				matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.shift)
			);
		}

		// 剩下任何非零组合（含 Super、Alt 等）都必须由显式协议保留修饰信息。
		if (modifier !== 0) {
			// 按已经合好的 modifier 比较这两种协议。
			return (
				// 比较 Kitty 的 当前单字符码点 与合并后的modifier位；解析可能写最近事件类型，键身份比较本身不排除松开。
				matchesKittySequence(data, codepoint, modifier) ||
				// 对当前可打印键比较 modifyOtherKeys，允许其专用的Shift大小写身份/逻辑符号规则。
				matchesPrintableModifyOtherKeys(data, codepoint, modifier)
			);
		}

		// Check both raw char and Kitty sequence (needed for release events)
		// 无修饰基本键最后比较原始字符或显式报文；能匹配松开事件，不负责过滤它。
		return (
			// 三个 || 完整表达式：原始文本相等先成功，否则两种报文都按零修饰比较。
			data === key || matchesKittySequence(data, codepoint, 0) || matchesPrintableModifyOtherKeys(data, codepoint, 0)
		);
	}

	// 未知键名或所有支持表示均失败则 false。
	return false;
}

/**
 * Parse input data and return the key identifier if recognized.
 *
 * @param data - Raw input data from terminal
 * @returns Key identifier string (e.g., "ctrl+c") or undefined
 */
// 将解析后的码点/修饰位格式化为键名，必要时使用 baseLayoutKey；例：非拉丁码点且 base=99 得 c 身份。
// 先归一化小键盘/ASCII Shift 身份，再优先主要拉丁字母/数字/符号，否则允许 base 回退；不支持的身份或修饰位返回 undefined。无状态修改。
// 上面的原英文仍用 data 描述旧接口，本函数实际接收数字；原始字节串入口是下方 parseKey。
function formatParsedKey(codepoint: number, modifier: number, baseLayoutKey?: number): string | undefined {
	// 小键盘逻辑等价表可能把主要码点变为字符或内部导航负数。
	const normalizedCodepoint = normalizeKittyFunctionalCodepoint(codepoint);
	// 再把带 Shift 的 ASCII 大写换为小写键身份，保留修饰位另处理。
	const identityCodepoint = normalizeShiftedLetterIdentityCodepoint(normalizedCodepoint, modifier);

	// Use base layout key only when codepoint is not a recognized Latin
	// letter (a-z), digit (0-9), or symbol (/, -, [, ;, etc.). For those,
	// the codepoint is authoritative regardless of physical key position.
	// This prevents remapped layouts (Dvorak, Colemak, xremap, etc.) from
	// reporting the wrong key name based on the QWERTY physical position.
	// 主要身份是 a..z 时不让物理 base 改写它。
	const isLatinLetter = identityCodepoint >= 97 && identityCodepoint <= 122; // a-z
	// 数字 0..9 同样作为主要身份优先；这与匹配函数 base 回退的排除项有差别。
	const isDigit = identityCodepoint >= 48 && identityCodepoint <= 57; // 0-9
	// 已知标点优先；fromCharCode 不是 Unicode 合法性验证。
	const isKnownSymbol = SYMBOL_KEYS.has(String.fromCharCode(identityCodepoint));
	// 选择后续格式化的有效身份。
	const effectiveCodepoint =
		// 三类已知身份保留原值，否则 base 有值则用它，没有再回主身份；?? 不把0误当缺省。
		isLatinLetter || isDigit || isKnownSymbol ? identityCodepoint : (baseLayoutKey ?? identityCodepoint);

	// 先允许键名缺省，下面按范围/表确定能否给出名字。
	let keyName: string | undefined;
	// ESC 码27的标准输出名为 escape。
	if (effectiveCodepoint === CODEPOINTS.escape) keyName = "escape";
	// HT 码9的标准名为 tab。
	else if (effectiveCodepoint === CODEPOINTS.tab) keyName = "tab";
	// CR或小键盘Enter均输出 enter，丢掉两种Enter来源的区别。
	else if (effectiveCodepoint === CODEPOINTS.enter || effectiveCodepoint === CODEPOINTS.kpEnter) keyName = "enter";
	// 码32输出命名空格 space，不直接输出空白。
	else if (effectiveCodepoint === CODEPOINTS.space) keyName = "space";
	// 显式DEL码输出 backspace。
	else if (effectiveCodepoint === CODEPOINTS.backspace) keyName = "backspace";
	// 内部Delete负数标识输出 delete。
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.delete) keyName = "delete";
	// 内部Insert标识输出 insert。
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.insert) keyName = "insert";
	// 内部Home标识输出 home。
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.home) keyName = "home";
	// 内部End标识输出 end。
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.end) keyName = "end";
	// 内部PageUp标识保留输出名 pageUp 的驼峰。
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.pageUp) keyName = "pageUp";
	// 内部PageDown标识输出 pageDown。
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.pageDown) keyName = "pageDown";
	// F1..F12内部编号从-21递减到-32，用闭区间判断。
	else if (effectiveCodepoint <= FUNCTIONAL_CODEPOINTS.f1 && effectiveCodepoint >= FUNCTIONAL_CODEPOINTS.f12)
		// 用F1标识减当前值再加1恢复功能键序号，例如-21减-22加1得到2。
		keyName = `f${FUNCTIONAL_CODEPOINTS.f1 - effectiveCodepoint + 1}`;
	// 内部上方向输出 up。
	else if (effectiveCodepoint === ARROW_CODEPOINTS.up) keyName = "up";
	// 内部下方向输出 down。
	else if (effectiveCodepoint === ARROW_CODEPOINTS.down) keyName = "down";
	// 内部左方向输出 left。
	else if (effectiveCodepoint === ARROW_CODEPOINTS.left) keyName = "left";
	// 内部右方向输出 right。
	else if (effectiveCodepoint === ARROW_CODEPOINTS.right) keyName = "right";
	// ASCII 数字恢复成一个数字字符。
	else if (effectiveCodepoint >= 48 && effectiveCodepoint <= 57) keyName = String.fromCharCode(effectiveCodepoint);
	// a..z恢复成小写字符；非拉丁文本不在这个键名范围。
	else if (effectiveCodepoint >= 97 && effectiveCodepoint <= 122) keyName = String.fromCharCode(effectiveCodepoint);
	// 最后接受运行时集合中已列符号，恢复其单字符名字。
	else if (SYMBOL_KEYS.has(String.fromCharCode(effectiveCodepoint))) keyName = String.fromCharCode(effectiveCodepoint);

	// 无法命名就 undefined，不随便把所有 Unicode 都变成快捷键。
	if (!keyName) return undefined;
	// 添加规范顺序的修饰前缀；若包含不支持修饰位，此函数还可能返回 undefined。
	return formatKeyNameWithModifiers(keyName, modifier);
}

// 尝试把一次输入转成键标识，返回 string 或 undefined；例：CSI 99;5u→ctrl+c，原始 A 最后直接返回 A。
// 依次 Kitty、modifyOtherKeys、模式映射、旧表/字节；不是 matchesKey 的严格逆函数，别名/大小写和接受范围不完全对称。
// 读共享 active 和 WT/SSH 环境，Kitty 成功解析时写最近事件变量；不读取 stdin、不滤 release，最终类型是 string 也不是 KeyId。
export function parseKey(data: string): string | undefined {
	// Kitty 支持形状优先解析，无论 active 开关是否启用。
	const kitty = parseKittySequence(data);
	// 一旦解析成功就从该分支返回，不再拿旧编码兜底；格式化也可能 undefined。
	if (kitty) {
		// 如果存在 shiftedKey 符号则优先选择消耗 Shift 的逻辑字符。
		const logicalShiftedSymbol = getLogicalShiftedSymbolCandidate(kitty.shiftedKey, kitty.modifier, SYMBOL_KEYS);
		// 将最终身份/修饰/base交给统一数字格式化函数。
		return formatParsedKey(
			// 候选存在用其符号码点，否则用原主码点；?. 和 ?? 不把0判成缺省。
			logicalShiftedSymbol?.codepoint ?? kitty.codepoint,
			// 逻辑候选已扣 Shift，否则保留全部原修饰位。
			logicalShiftedSymbol?.modifier ?? kitty.modifier,
			// 保留可选物理布局回退值。
			kitty.baseLayoutKey,
		);
	}

	// Kitty形状未识别才试 modifyOtherKeys，这个解析不改最近事件类型。
	const modifyOtherKeys = parseModifyOtherKeysSequence(data);
	// 识别后同样在本分支结束。
	if (modifyOtherKeys) {
		// 对已经由Shift产生的符号尝试逻辑消耗。
		const logicalShiftedSymbol = getLogicalShiftedSymbolCandidate(
			// modifyOtherKeys没有shiftedKey字段，使用主码点。
			modifyOtherKeys.codepoint,
			// 传该报文的内部修饰位。
			modifyOtherKeys.modifier,
			// 只从 SHIFTED_SYMBOL_KEYS 选择，不使用全部标点集合。
			SHIFTED_SYMBOL_KEYS,
		);
		// 复用格式化，不传base，因为该协议形状没有布局字段。
		return formatParsedKey(
			// 有逻辑符号优先，否则原码点。
			logicalShiftedSymbol?.codepoint ?? modifyOtherKeys.codepoint,
			// 逻辑符号去掉隐含Shift，否则保留报文修饰。
			logicalShiftedSymbol?.modifier ?? modifyOtherKeys.modifier,
		);
	}

	// Mode-aware legacy sequences
	// When Kitty protocol is active, ambiguous sequences are interpreted as custom terminal mappings:
	// - \x1b\r = shift+enter (Kitty mapping), not alt+enter
	// - \n = shift+enter (Ghostty mapping)
	// 剩下旧编码时，active开关只对特定歧义映射生效。
	if (_kittyProtocolActive) {
		// ESC+CR或LF在active模式优先命名为shift+enter。
		if (data === "\x1b\r" || data === "\n") return "shift+enter";
	}

	// 用完整字符串索引普通对象旧表，不是hasOwn；原型继承键也可能取到非预期值，不应将任意外部字符串都视为已验证键名。
	const legacySequenceKeyId = LEGACY_SEQUENCE_KEY_IDS[data];
	// 查到真值直接返回；例如小写ESC+b在active下仍会得到alt+left。
	if (legacySequenceKeyId) return legacySequenceKeyId;

	// Legacy sequences (used when Kitty protocol is not active, or for unambiguous sequences)
	// 原始ESC命名escape，不命名ctrl+[，因为两者传统编码相同。
	if (data === "\x1b") return "escape";
	// FS控制码28命名ctrl+反斜杠。
	if (data === "\x1c") return "ctrl+\\";
	// GS控制码29命名ctrl+]。
	if (data === "\x1d") return "ctrl+]";
	// US控制码31规范选择ctrl+-，与ctrl+_的歧义不能从原字节分开。
	if (data === "\x1f") return "ctrl+-";
	// 双ESC作为Ctrl+Alt+[的兼容表示；本行不检查active。
	if (data === "\x1b\x1b") return "ctrl+alt+[";
	// ESC+FS命名Ctrl+Alt+反斜杠，同样不受active开关限制。
	if (data === "\x1b\x1c") return "ctrl+alt+\\";
	// ESC+GS命名ctrl+alt+]。
	if (data === "\x1b\x1d") return "ctrl+alt+]";
	// ESC+US规范选择ctrl+alt+-。
	if (data === "\x1b\x1f") return "ctrl+alt+-";
	// 原始HT优先为tab，不继续命名ctrl+i。
	if (data === "\t") return "tab";
	// CR/SS3小键盘Enter都命名enter；LF只有非active才作普通Enter。
	if (data === "\r" || (!_kittyProtocolActive && data === "\n") || data === "\x1bOM") return "enter";
	// NUL直接命名ctrl+space，这一parse分支没有active限制，和matchesKey的该旧编码分支不同。
	if (data === "\x00") return "ctrl+space";
	// 普通空格返回命名space。
	if (data === " ") return "space";
	// DEL返回backspace。
	if (data === "\x7f") return "backspace";
	// BS按实时WT/SSH启发选择ctrl+backspace或backspace，而非命名ctrl+h。
	if (data === "\x08") return isWindowsTerminalSession() ? "ctrl+backspace" : "backspace";
	// CSI Z固定命名shift+tab。
	if (data === "\x1b[Z") return "shift+tab";
	// 非active的ESC+CR命名alt+enter；active已在前面命名shift+enter。
	if (!_kittyProtocolActive && data === "\x1b\r") return "alt+enter";
	// 非active才将ESC+空格命名alt+space。
	if (!_kittyProtocolActive && data === "\x1b ") return "alt+space";
	// ESC+DEL或ESC+BS都命名alt+backspace，不受active限制。
	if (data === "\x1b\x7f" || data === "\x1b\b") return "alt+backspace";
	// 大写ESC+B只在非active作为alt+left。
	if (!_kittyProtocolActive && data === "\x1bB") return "alt+left";
	// 大写ESC+F只在非active作为alt+right。
	if (!_kittyProtocolActive && data === "\x1bF") return "alt+right";
	// 非active且恰有两个UTF-16单元、首单元ESC，才按旧Alt前缀进一步解析。
	if (!_kittyProtocolActive && data.length === 2 && data[0] === "\x1b") {
		// 取第二单元值，不实现多字节/代理对的Alt文本解析。
		const code = data.charCodeAt(1);
		// 传统控制码1..26可命名Ctrl+Alt+字母，前面Tab/CR等兼容分支可能已优先返回。
		if (code >= 1 && code <= 26) {
			// 加96回到ASCII小写字母，拼ctrl+alt+前缀。
			return `ctrl+alt+${String.fromCharCode(code + 96)}`;
		}
		// Legacy alt+letter/digit/symbol (ESC followed by the key)
		// 恢复第二单元的字符给符号集合查询。
		const key = String.fromCharCode(code);
		// 只接受小写字母、数字或已知标点，不把任意第二单元都当可识别快捷键。
		if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57) || SYMBOL_KEYS.has(key)) {
			// 返回Alt修饰键名。
			return `alt+${key}`;
		}
	}
	// 无修饰CSI A输出up。
	if (data === "\x1b[A") return "up";
	// 无修饰CSI B输出down。
	if (data === "\x1b[B") return "down";
	// 无修饰CSI C输出right。
	if (data === "\x1b[C") return "right";
	// 无修饰CSI D输出left。
	if (data === "\x1b[D") return "left";
	// CSI H或SS3 H输出home；SS3形式通常已在反向表命中。
	if (data === "\x1b[H" || data === "\x1bOH") return "home";
	// CSI F或SS3 F输出end。
	if (data === "\x1b[F" || data === "\x1bOF") return "end";
	// 旧CSI 3~输出delete；通常已由前面的功能键解析器识别。
	if (data === "\x1b[3~") return "delete";
	// 旧CSI 5~输出pageUp。
	if (data === "\x1b[5~") return "pageUp";
	// 旧CSI 6~输出pageDown。
	if (data === "\x1b[6~") return "pageDown";

	// Raw Ctrl+letter
	// 最后只对单个UTF-16单元考虑原始Ctrl字节或ASCII字符。
	if (data.length === 1) {
		// 取首单元编号，长度条件不允许普通代理对走这个分支。
		const code = data.charCodeAt(0);
		// 控制码1..26映射回Ctrl+A..Z；先前Tab/Enter/BS等分支已有优先级。
		if (code >= 1 && code <= 26) {
			// 编号加96还原小写字母并加ctrl+。
			return `ctrl+${String.fromCharCode(code + 96)}`;
		}
		// ASCII可打印范围32..126原样返回；空格已早返回space。
		if (code >= 32 && code <= 126) {
			// 例如A返回A，并不自动变shift+a，因此parse与matches不是互为逆运算。
			return data;
		}
	}

	// 没有可识别名字则undefined；普通中文输入也不在这个快捷键命名范围。
	return undefined;
}

// =============================================================================
// Kitty CSI-u Printable Decoding
// =============================================================================

// 文本解码用同一CSI-u子集形状，含可选Shift/base/事件，但不接受额外associated-text字段。
const KITTY_CSI_U_REGEX = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;
// 只允许Shift与Caps/Num Lock的位，不能将Ctrl/Alt/Super组合误插入文本。
const KITTY_PRINTABLE_ALLOWED_MODIFIERS = MODIFIERS.shift | LOCK_MASK;

/**
 * Decode a Kitty CSI-u sequence into a printable character, if applicable.
 *
 * When Kitty keyboard protocol flag 1 (disambiguate) is active, terminals send
 * CSI-u sequences for all keys, including plain printable characters. This
 * function extracts the printable character from such sequences.
 *
 * Only accepts plain or Shift-modified keys. Rejects Ctrl, Alt, and unsupported
 * modifier combinations (those are handled by keybinding matching instead).
 * Prefers the shifted keycode when Shift is held and a shifted key is reported.
 *
 * @param data - Raw input data from terminal
 * @returns The printable character, or undefined if not a printable CSI-u sequence
 */
// 从完整CSI-u报文取单个字符，失败undefined；例：CSI 97:65;2u优先返回A。
// 检查修饰、码点下界、未映射Kitty功能区并尝试fromCodePoint；不看active、不写最近事件，也不按事件类型过滤release/repeat。
// 原英文把flag1概括为所有键都编码，但协议另有flag8报告全部键；本函数仅处理已经收到的这种格式，不保证终端会怎样发送。
// 这里不是所有控制符/Unicode标量的完整过滤器：DEL/C1及代理区未被专门排除，调用链的输入分发/控件还需各自处理。
export function decodeKittyPrintable(data: string): string | undefined {
	// 对整段输入匹配CSI-u形状，不做流式拼包。
	const match = data.match(KITTY_CSI_U_REGEX);
	// 不符就undefined，调用者可继续其他文本或协议路径。
	if (!match) return undefined;

	// CSI-u groups: <codepoint>[:<shifted>[:<base>]];<mod>[:<event>]u
	// 主码点组用十进制解析；??空串只是缺组后备，不代表空串是有效数字。
	const codepoint = Number.parseInt(match[1] ?? "", 10);
	// 拒绝NaN/Infinity等非有限主码点，未在此限定Unicode上界。
	if (!Number.isFinite(codepoint)) return undefined;

	// 可空shifted组只有非空才解析；可能得到非有限数字，后面最终码点还会检查。
	const shiftedKey = match[2] && match[2].length > 0 ? Number.parseInt(match[2], 10) : undefined;
	// 修饰线上值缺省1，即无修饰。
	const modValue = match[4] ? Number.parseInt(match[4], 10) : 1;
	// Modifiers are 1-indexed in CSI-u; normalize to our bitmask.
	// 有限修饰值减1；非有限值这里反而回退0，不是拒绝整报文。
	const modifier = Number.isFinite(modValue) ? modValue - 1 : 0;

	// Only accept printable CSI-u input for plain or Shift-modified text keys.
	// Reject unsupported modifier bits (e.g. Super/Meta) to avoid inserting
	// characters from modifier-only terminal events.
	// 32位位运算拒绝允许集合外的位，不是对任意大数字的完整范围验证。
	if ((modifier & ~KITTY_PRINTABLE_ALLOWED_MODIFIERS) !== 0) return undefined;
	// 再明确拒绝Alt/Ctrl组合；前一条在通常合法掩码下已经会排除它们。
	if (modifier & (MODIFIERS.alt | MODIFIERS.ctrl)) return undefined;

	// Prefer the shifted keycode when Shift is held.
	// 先采用主码点，let允许下方Shift分支改写。
	let effectiveCodepoint = codepoint;
	// 带Shift且有数字shifted字段才优先采用；类型检查也会让NaN通过，所以后面还验有限性。
	if (modifier & MODIFIERS.shift && typeof shiftedKey === "number") {
		// 替换局部有效码点，不修改原输入。
		effectiveCodepoint = shiftedKey;
	}
	// 将可打印小键盘映射成普通数字/符号；导航映射会变负数而被下界拒绝。
	effectiveCodepoint = normalizeKittyFunctionalCodepoint(effectiveCodepoint);
	// Drop control characters or invalid codepoints.
	// 只排非有限值和小于32的码点；DEL127/C1并不在这条范围排除内。
	if (!Number.isFinite(effectiveCodepoint) || effectiveCodepoint < 32) return undefined;
	// Drop unmapped Kitty functional keys (F13-F35, media keys, ...).
	// 尚未映射掉且仍落Kitty功能私用区的码点不能直接当文字。
	if (effectiveCodepoint >= KITTY_FUNCTIONAL_PUA_START && effectiveCodepoint <= KITTY_FUNCTIONAL_PUA_END) {
		// 功能事件无可插入字符。
		return undefined;
	}

	// fromCodePoint可能因超过0x10FFFF等范围问题抛错，局部catch将它转为解码失败。
	try {
		// 按完整Unicode码点生成字符串，补充平面会产生两个UTF-16单元；孤立代理区值未另行排除。
		return String.fromCodePoint(effectiveCodepoint);
		// 只接住这次字符构造的异常，不抛给编辑器输入处理。
	} catch {
		// 返回无字符，供调用者决定后备路径。
		return undefined;
	}
}

// 解码可打印modifyOtherKeys字符，返回字符串或undefined；例：CSI 27;2;69~→E。
// 先解析、清锁位、只许Shift，再检查码点并构造；不计算键盘大小写、不看active、不改模块状态，也非全部控制符过滤器。
function decodeModifyOtherKeysPrintable(data: string): string | undefined {
	// 读取modifyOtherKeys码点与内部修饰位。
	const parsed = parseModifyOtherKeysSequence(data);
	// 形状不符直接undefined。
	if (!parsed) return undefined;
	// 忽略Caps/Num Lock，仅针对剩下的修饰位限制。
	const modifier = parsed.modifier & ~LOCK_MASK;
	// 非Shift的任意剩余位都拒绝，位运算使用JS32位规则。
	if ((modifier & ~MODIFIERS.shift) !== 0) return undefined;
	// 主码点必须有限且至少32；未专门过滤DEL/C1/代理区或Kitty私用编号。
	if (!Number.isFinite(parsed.codepoint) || parsed.codepoint < 32) return undefined;

	// 将字符构造的范围异常局部转成undefined。
	try {
		// 直接按报文主码点生成字符，不因Shift自动转大写；终端应报告实际字符码。
		return String.fromCodePoint(parsed.codepoint);
		// 超出fromCodePoint范围等异常走这里。
	} catch {
		// 无法构造字符则解码失败。
		return undefined;
	}
}

// 统一解码两种显式文本报文；例：CSI-u或modifyOtherKeys的E均可返回E。
// 先Kitty再modifyOtherKeys，返回字符或undefined，不接受普通原始文本作兜底；无I/O/状态修改，不负责release过滤。
export function decodePrintableKey(data: string): string | undefined {
	// ?? 仅在第一解码器没结果时再运行第二个，两个函数都只解码各自支持形状。
	return decodeKittyPrintable(data) ?? decodeModifyOtherKeysPrintable(data);
}
