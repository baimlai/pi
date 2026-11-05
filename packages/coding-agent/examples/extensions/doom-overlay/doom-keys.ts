/**
 * DOOM key codes (from doomkeys.h)
 */

/**
 * 文件导读（doom-overlay 的按键映射层）
 *
 * 所属与用途：本文件属于 `packages/coding-agent/examples/extensions/doom-overlay` 示例，
 * 只负责把终端收到的原始按键数据翻译成 DOOM 引擎认识的按键码。它不启动 DOOM、不渲染、不读文件。
 *
 * 上游如何进入：`doom-component.ts` 的 `handleInput` 在收到 TUI 输入时调用 `mapKeyToDoom`，
 * 再把返回的每个数字传给 `DoomEngine.pushKey`；DOOM 每帧从自己的队列取按键。
 * 下游依赖：`@earendil-works/pi-tui` 的 `Key`、`matchesKey`、`parseKey`，用于同时识别传统终端
 * 序列和 Kitty 键盘协议；不依赖 coding-agent 的其他模块。
 *
 * 能力清单：
 * - `DoomKeys`：从 doomgeneric 的 `doomkeys.h` 抄来的按键码常量（只收录示例用到的键）。
 * - `mapKeyToDoom`：输入一段终端输入字符串，输出零个或多个 DOOM 按键码。
 *   例如大写 W 需要同时按下“前进”和“右 Shift”两个键码。
 *
 * 典型调用顺序（示例）：
 *   const keys = mapKeyToDoom("w");      // [DoomKeys.KEY_UPARROW]
 *   keys.forEach((k) => engine.pushKey(true, k));
 * 真实运行时由 DoomOverlayComponent 对按下和释放事件分别调用；本函数只做映射，不区分按下/释放。
 *
 * 输入格式：传统终端会发 `\x1b[A` 这样的转义序列，Kitty 协议会发更长的 CSI-u 序列；
 * `matchesKey` 负责两种形式。普通字符通常就是单个字符。
 *
 * 建议阅读顺序：先看 `DoomKeys` 的命名与编码规律，再按 `mapKeyToDoom` 的分支顺序阅读。
 *
 * 边界：未知输入返回空数组；函数不做 I/O，也不会抛错。`parseKey` 对无法解析的输入返回 undefined。
 */

/**
 * DOOM 引擎使用的按键码。
 *
 * 这些数值来自 C 头文件 `doomkeys.h`，不是 Unicode 码点；例如方向键是 0xac-0xaf，
 * 而字母 W 的 87 并不直接对应“前进”。`as const` 让每个属性成为只读字面量类型，
 * 编译期不能赋值修改；运行时对象本身仍是普通可变对象（没有 `Object.freeze`）。
 *
 * 示例：`DoomKeys.KEY_USE` 的类型是字面量 `162`，`DoomKeys.KEY_ESCAPE` 是 `27`。
 */
export const DoomKeys = {
	KEY_RIGHTARROW: 0xae,
	KEY_LEFTARROW: 0xac,
	KEY_UPARROW: 0xad,
	KEY_DOWNARROW: 0xaf,
	KEY_STRAFE_L: 0xa0,
	KEY_STRAFE_R: 0xa1,
	KEY_USE: 0xa2,
	KEY_FIRE: 0xa3,
	KEY_ESCAPE: 27,
	KEY_ENTER: 13,
	KEY_TAB: 9,
	KEY_F1: 0x80 + 0x3b,
	KEY_F2: 0x80 + 0x3c,
	KEY_F3: 0x80 + 0x3d,
	KEY_F4: 0x80 + 0x3e,
	KEY_F5: 0x80 + 0x3f,
	KEY_F6: 0x80 + 0x40,
	KEY_F7: 0x80 + 0x41,
	KEY_F8: 0x80 + 0x42,
	KEY_F9: 0x80 + 0x43,
	KEY_F10: 0x80 + 0x44,
	KEY_F11: 0x80 + 0x57,
	KEY_F12: 0x80 + 0x58,
	KEY_BACKSPACE: 127,
	KEY_PAUSE: 0xff,
	KEY_EQUALS: 0x3d,
	KEY_MINUS: 0x2d,
	KEY_RSHIFT: 0x80 + 0x36,
	KEY_RCTRL: 0x80 + 0x1d,
	KEY_RALT: 0x80 + 0x38,
} as const;

// 从 TUI 包导入按键匹配工具。ES 模块的导入声明虽然写在这里，仍会在模块求值前提升生效；
// `DoomKeys` 在导入之前导出并不会导致运行时问题，只是阅读顺序上不太常见。
import { Key, matchesKey, parseKey } from "@earendil-works/pi-tui";

/**
 * Map terminal key input to DOOM key codes
 * Supports both raw terminal input and Kitty protocol sequences
 */
/**
 * 把一段终端按键输入翻译成 DOOM 按键码数组。
 *
 * 输入：`data`，终端交付的原始字符串。可能是单个字符（"w"）、传统转义序列（`\x1b[A`）、
 * Kitty 协议的 CSI-u 序列，或多个字符的组合。
 * 输出：`number[]`。空数组表示不映射；有些键要返回两个码（例如 Shift+W 同时按前进和右 Shift）。
 * 副作用：无；不修改输入，也不保存状态。
 * 错误路径：无显式错误；无法识别时返回空数组。`parseKey` 对未知序列返回 undefined，由可选链处理。
 * 主要流程：方向键 -> WASD（含 Shift）-> F 开火 -> 空格使用 -> 菜单键 -> Ctrl 兼容 -> 数字武器
 * -> 加减号 -> Y/N -> 其他可打印字符 -> 放弃。
 *
 * 示例：`mapKeyToDoom("w")` 返回 `[173]`；`mapKeyToDoom("W")` 返回 `[173, 182]`；
 * `mapKeyToDoom("\x1b[A")` 在传统终端中也返回 `[173]`。
 * 真实运行时，同一按键的按下与释放都调用本函数；释放事件由组件另行处理。
 *
 * 注意：本函数只识别单字符或 TUI 工具认识的序列；普通多字符串通常落到最后的空数组，
 * 但下面的数字判断使用字符串比较，存在多字符输入被误判的可能（见该分支注释）。
 */
export function mapKeyToDoom(data: string): number[] {
	// Arrow keys
	// `matchesKey` 同时理解传统方向键序列和 Kitty 协议；Key.up 是描述符，不是键码。
	if (matchesKey(data, Key.up)) return [DoomKeys.KEY_UPARROW];
	if (matchesKey(data, Key.down)) return [DoomKeys.KEY_DOWNARROW];
	if (matchesKey(data, Key.right)) return [DoomKeys.KEY_RIGHTARROW];
	if (matchesKey(data, Key.left)) return [DoomKeys.KEY_LEFTARROW];

	// WASD - check both raw char and Kitty sequences
	// 小写字母同时检查裸字符和匹配器；返回只含方向键码。
	if (data === "w" || matchesKey(data, "w")) return [DoomKeys.KEY_UPARROW];
	// 大写形式额外附加 KEY_RSHIFT，使 DOOM 进入奔跑状态。
	if (data === "W" || matchesKey(data, Key.shift("w"))) return [DoomKeys.KEY_UPARROW, DoomKeys.KEY_RSHIFT];
	if (data === "s" || matchesKey(data, "s")) return [DoomKeys.KEY_DOWNARROW];
	if (data === "S" || matchesKey(data, Key.shift("s"))) return [DoomKeys.KEY_DOWNARROW, DoomKeys.KEY_RSHIFT];
	// A/D 是横向平移（strafe），不是转向。
	if (data === "a" || matchesKey(data, "a")) return [DoomKeys.KEY_STRAFE_L];
	if (data === "A" || matchesKey(data, Key.shift("a"))) return [DoomKeys.KEY_STRAFE_L, DoomKeys.KEY_RSHIFT];
	if (data === "d" || matchesKey(data, "d")) return [DoomKeys.KEY_STRAFE_R];
	if (data === "D" || matchesKey(data, Key.shift("d"))) return [DoomKeys.KEY_STRAFE_R, DoomKeys.KEY_RSHIFT];

	// Fire - F key
	// F 与 Shift+F 都只映射到开火，不附加 Shift 码。
	if (data === "f" || data === "F" || matchesKey(data, "f") || matchesKey(data, Key.shift("f"))) {
		return [DoomKeys.KEY_FIRE];
	}

	// Use/Open
	if (data === " " || matchesKey(data, Key.space)) return [DoomKeys.KEY_USE];

	// Menu/UI keys
	// 这些键只返回菜单所需的键码；具体菜单行为由 DOOM 引擎决定。
	if (matchesKey(data, Key.enter)) return [DoomKeys.KEY_ENTER];
	if (matchesKey(data, Key.escape)) return [DoomKeys.KEY_ESCAPE];
	if (matchesKey(data, Key.tab)) return [DoomKeys.KEY_TAB];
	if (matchesKey(data, Key.backspace)) return [DoomKeys.KEY_BACKSPACE];

	// Ctrl keys (except Ctrl+C) = fire (legacy support)
	// `parseKey` 把输入规整成 "ctrl+x" 之类的字符串；无法识别时返回 undefined。
	const parsed = parseKey(data);
	// 保留 Ctrl+C 给宿主退出/中断，不用作开火。
	if (parsed?.startsWith("ctrl+") && parsed !== "ctrl+c") {
		return [DoomKeys.KEY_FIRE];
	}
	// 传统终端里 Ctrl 字母常以单个控制字符（<32）到达；同样排除 Ctrl+C 的 \x03。
	if (data.length === 1 && data.charCodeAt(0) < 32 && data !== "\x03") {
		return [DoomKeys.KEY_FIRE];
	}

	// Weapon selection (0-9)
	// 字符串比较按字典序，且没有先检查 `data.length === 1`；像 "5x" 这样以 0-8 开头的
	// 多字符串也可能进入该分支，只取第一个字符的码点。正常单键输入不受影响。
	if (data >= "0" && data <= "9") return [data.charCodeAt(0)];

	// Plus/minus for screen size
	// 加号与等号都映射到同一个 DOOM 键；减号单独一个。
	if (data === "+" || data === "=") return [DoomKeys.KEY_EQUALS];
	if (data === "-") return [DoomKeys.KEY_MINUS];

	// Y/N for prompts
	// 无论大小写都返回小写字母码点；Shift 信息在这里被丢弃。
	if (data === "y" || data === "Y" || matchesKey(data, "y") || matchesKey(data, Key.shift("y"))) {
		return ["y".charCodeAt(0)];
	}
	if (data === "n" || data === "N" || matchesKey(data, "n") || matchesKey(data, Key.shift("n"))) {
		return ["n".charCodeAt(0)];
	}

	// Other printable characters (for cheats)
	// 其他单个可打印字符统一转小写后返回码点，供 DOOM 的作弊码识别。
	if (data.length === 1 && data.charCodeAt(0) >= 32) {
		return [data.toLowerCase().charCodeAt(0)];
	}

	// 未识别的输入（例如未知转义序列）不产生按键。
	return [];
}
