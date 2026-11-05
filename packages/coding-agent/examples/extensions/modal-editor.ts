// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：演示 ctx.ui.setEditorComponent 与 CustomEditor 子类，实现 vim 风格的模式切换：插入模式下
//   正常输入；Normal 模式下 hjkl/0/$/x 映射为编辑动作，i/a 返回插入模式，Escape 在 Normal 模式交回
//   宿主（用于中止 Agent 等）。
// 上游：`pi --extension ./examples/extensions/modal-editor.ts` 加载；session_start 时把编辑器工厂交给 UI。
// 下游：继承 CustomEditor（基于 pi-tui Editor），未处理的按键调用 super.handleInput；render 在底边框
//   追加 NORMAL/INSERT 标识。不改输入内容之外的状态，不写文件。
// 能力：
//   NORMAL_KEYS        Normal 模式按键到转义序列的映射表。
//   ModalEditor        自定义编辑器类：mode 状态、handleInput 路由、render 模式标识。
//   默认导出函数        在会话启动时安装编辑器工厂。
// 运行：加载后在输入框按 Escape 进入 Normal，按 i 回到 Insert；输入文字或移动光标验证行为。
// 示例：Normal 下按 l，等价于向右方向键；按 Escape 再把按键交给宿主。
// 阅读顺序：先看 NORMAL_KEYS 的转义序列含义，再看 ModalEditor.handleInput 的分支顺序，最后看 render。

/**
 * Modal Editor - vim-like modal editing example
 *
 * Usage: pi --extension ./examples/extensions/modal-editor.ts
 *
 * - Escape: insert → normal mode (in normal mode, aborts agent)
 * - i: normal → insert mode
 * - hjkl: navigation in normal mode
 * - ctrl+c, ctrl+d, etc. work in both modes
 */

// 同时导入运行时值 CustomEditor 和类型 ExtensionAPI；type 修饰只作用于后者。
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
// matchesKey 按配置识别按键，visibleWidth 按终端显示列测宽（不算 ANSI），truncateToWidth 安全裁剪。
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Normal mode key mappings: key -> escape sequence (or null for mode switch)
// Record<string, string | null> 表示键是任意字符串、值是转义序列或 null；null 留给 i/a 这类只切模式的键。
// 转义序列是终端方向键的常见编码：\x1b[D 左、\x1b[B 下、\x1b[A 上、\x1b[C 右；
// \x01 是 Ctrl+A（行首），\x05 是 Ctrl+E（行尾），\x1b[3~ 是 Delete。
const NORMAL_KEYS: Record<string, string | null> = {
	h: "\x1b[D", // left
	j: "\x1b[B", // down
	k: "\x1b[A", // up
	l: "\x1b[C", // right
	"0": "\x01", // line start
	$: "\x05", // line end
	x: "\x1b[3~", // delete char
	i: null, // insert mode
	a: null, // append (insert + right)
};

// 自定义编辑器。输入：父类构造参数 tui/theme/keybindings 由宿主传入；输出：可渲染组件。
// 状态只有 mode；副作用来自按键处理（可能修改输入文本），不主动发请求。
// 示例：new ModalEditor(tui, theme, keybindings) 后由宿主放进输入区。
class ModalEditor extends CustomEditor {
	// 字符串字面量联合限制 mode 只能是两个值；初始为插入模式，用户无需切换即可正常打字。
	private mode: "normal" | "insert" = "insert";

	// 处理一个终端按键批次。输入：data 可能是单个字符或整段转义序列；输出/副作用：修改编辑状态或转交父类。
	// 流程：Escape 特殊处理 -> 插入模式全部交给父类 -> Normal 模式查映射表 -> 其他控制键交父类。
	// 示例：Normal 下传入 "j"，父类收到 "\x1b[B"，光标下移。
	handleInput(data: string): void {
		// Escape toggles to normal mode, or passes through for app handling
		// matchesKey 使用宿主的键位配置判断 escape，而不是直接比较字符串。
		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				// 插入模式下 Escape 只切模式，不交给父类，避免顺带触发中止等应用动作。
				this.mode = "normal";
			} else {
				// Normal 模式下的 Escape 交回父类，保留“中止 Agent”等宿主行为。
				super.handleInput(data); // abort agent, etc.
			}
			return;
		}

		// Insert mode: pass everything through
		// 插入模式不拦截任何按键，完全沿用父类的编辑/快捷键逻辑。
		if (this.mode === "insert") {
			super.handleInput(data);
			return;
		}

		// Normal mode: check mapped keys
		// `in` 运算符检查对象自有/继承属性键；这里 NORMAL_KEYS 是普通对象，等价于查找映射。
		if (data in NORMAL_KEYS) {
			// 索引访问得到 string | null；noUncheckedIndexedAccess 场景下类型仍可能含 undefined，else if (seq) 兜底。
			const seq = NORMAL_KEYS[data];
			if (data === "i") {
				// i 只切回插入模式，不移动光标。
				this.mode = "insert";
			} else if (data === "a") {
				// a 是 append：先切插入模式，再发右方向键把光标移到当前字符之后。
				this.mode = "insert";
				super.handleInput("\x1b[C"); // move right first
			} else if (seq) {
				// 其余映射把一个字母翻译成父类认识的方向/编辑转义序列。
				super.handleInput(seq);
			}
			// 命中映射表后无论是否可打印都结束，避免字母落入输入文本。
			return;
		}

		// Pass control sequences (ctrl+c, etc.) to super, ignore printable chars
		// 长度为 1 且码点 >= 32 的是可打印字符；Normal 模式下忽略它们，防止误输入。
		if (data.length === 1 && data.charCodeAt(0) >= 32) return;
		// 其余是控制序列（Ctrl+C、方向键等），交给父类保留应用快捷键。
		super.handleInput(data);
	}

	// 在父类渲染结果的底边框右侧追加模式标识。输入：宽度；输出：行数组。
	// 副作用：无；只在底行足够宽时才改写，避免覆盖已有边框内容。
	render(width: number): string[] {
		// 先让父类完成全部编辑内容与边框渲染，再在其结果上做后处理。
		const lines = super.render(width);
		// 空结果直接返回，后面会访问 lines[last]，需要先排除。
		if (lines.length === 0) return lines;

		// Add mode indicator to bottom border
		// 三目表达式选择带空格的标签，保证与边框有间隔。
		const label = this.mode === "normal" ? " NORMAL " : " INSERT ";
		// 最后一行是底边框；数组下标从 0 开始，因此长度减 1。
		const last = lines.length - 1;
		// 非空断言 ! 告诉 TS 该元素存在（上面已保证非空数组）；运行时不会去除 undefined。
		if (visibleWidth(lines[last]!) >= label.length) {
			// 预留标签宽度后裁剪原底行，再拼上标签；替换字符串空串表示不额外加省略号。
			lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
		}
		// 返回新的行数组；父类可能缓存了自己的结果，这里只改副本中的字符串。
		return lines;
	}
}

// 扩展入口。输入：宿主 ExtensionAPI；输出：无；副作用是注册 session_start 处理器。
// 示例：加载后输入区立即变成模态编辑器；不传 ctx.ui.setEditorComponent 的组件工厂时使用内建编辑器。
export default function (pi: ExtensionAPI) {
	// 每次会话启动都安装一次工厂；工厂本身在 UI 真正需要编辑器时才被调用。
	pi.on("session_start", (_event, ctx) => {
		// 工厂参数顺序固定为 (tui, theme, keybindings)；ModalEditor 构造函数把三者原样交给 CustomEditor。
		ctx.ui.setEditorComponent((tui, theme, kb) => new ModalEditor(tui, theme, kb));
	});
}
