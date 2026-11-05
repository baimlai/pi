// Input 管理单行输入值、光标、粘贴、删除恢复与撤销，再返回带光标标记的一条文本行；宿主负责焦点、输入分发与终端重画。
// 键位通过管理器匹配动作，不在每个编辑分支固定具体按键。
import { getKeybindings } from "../keybindings.ts";
// 解码 Kitty CSI-u 文字按键；必须在普通控制字符过滤前处理，否则序列里的 ESC 会被拒绝。
import { decodeKittyPrintable } from "../keys.ts";
// 删除记录环支持 kill/yank：成段删除保存文本，之后粘回或轮换旧记录，不等同于系统剪贴板。
import { KillRing } from "../kill-ring.ts";
// 下面混合导入类型与运行时值，type 项在去类型后的 JavaScript 中消失。
import {
	// 基础组件约定要求 render 与 invalidate。
	type Component,
	// 零宽硬件光标位置标记，宿主提取并移除后安排终端光标/输入法位置。
	CURSOR_MARKER,
	// 可聚焦接口要求 focused 字段，接口本身不自动赋值或注册组件。
	type Focusable,
	// 把文字包进模拟光标标记；此函数本身不直接输出反色或写终端，宿主稍后解析这些标记。
	renderFakeCursor,
	// 鼠标事件的编译期形状，x/y 是组件内坐标。
	type TuiMouseEvent,
	// 鼠标返回意图，交给宿主安排处理、焦点与重画。
	type TuiMouseEventResult,
} from "../tui.ts";
// 泛型撤销栈保存深复制快照，读取后恢复文字与光标；本 Input 没有 redo 接口。
import { UndoStack } from "../undo-stack.ts";
// 共享字素分段器、空白判定和按显示列截取/测量；字符串下标与终端列坐标不能混用。
import { getGraphemeSegmenter, isWhitespaceChar, sliceByColumn, truncateToWidth, visibleWidth } from "../utils.ts";
// 按 Unicode 词段与标点边界查找前后移动位置，不修改文本。
import { findWordBackward, findWordForward } from "../word-navigation.ts";

// 复用 Intl.Segmenter 的字素分段器，一个用户看到的字符可能由多个 UTF-16 单元组成。
const segmenter = getGraphemeSegmenter();

// 撤销快照的类型，只包含文字与光标，不包含删除记录环、焦点或粘贴缓冲。
interface InputState {
	// 快照中的完整输入字符串。
	value: string;
	// 快照中的 UTF-16 字符串下标，不是终端显示列数。
	cursor: number;
}

// 构造选项的接口，字段均可省略；运行时默认值在构造函数中选择。
export interface InputOptions {
	// 输入前缀，默认 "> "；显示时按其真实终端列宽扣空间。
	prompt?: string;
	// 输入值为空时显示的占位文字，不成为 getValue 的值。
	placeholder?: string;
	// 占位文字样式函数，接收片段、返回样式字符串；未提供时原样返回。
	placeholderStyle?: (text: string) => string;
}

/**
 * Input component - single-line text input with horizontal scrolling
 */
// 同时实现 Component 和 Focusable 的编译期要求，不会因 implements 自动处理输入或获得焦点。
export class Input implements Component, Focusable {
	// 真正输入值，初始为空，private 仅限制 TypeScript 中的外部访问。
	private value: string = "";
	// value 内部的 UTF-16 下标；字素移动通常按完整字素长度改变它。
	private cursor: number = 0; // Cursor position in the value
	// 创建后固定的提示前缀，readonly 不会在运行时冻结实例。
	private readonly prompt: string;
	// 创建后固定的占位文字。
	private readonly placeholder: string;
	// 创建后固定的占位样式回调引用。
	private readonly placeholderStyle: (text: string) => string;
	// 最近普通文字渲染窗口从完整输入的哪一显示列开始，供鼠标定位使用；不是字符串下标。
	private renderedStartColumn = 0;
	// 可选提交回调，接收原始当前值，返回 void；组件不自行清空输入或执行命令。
	public onSubmit?: (value: string) => void;
	// 可选取消通知，无参数/返回值，不会自动关闭或销毁输入框。
	public onEscape?: () => void;

	/** Focusable interface - set by TUI when focus changes */
	// 由宿主设置的焦点标志；true 时额外输出硬件光标位置标记，但模拟光标片段仍由宿主决定怎样显示。
	focused: boolean = false;

	// Bracketed paste mode buffering
	// 跨输入分片累积括号粘贴内容，尚未插进 value。
	private pasteBuffer: string = "";
	// 是否正处在完整粘贴开始/结束标记之间。
	private isInPaste: boolean = false;

	// Kill ring for Emacs-style kill/yank operations
	// 每个 Input 独有的删除记录环，可存多次独立成段删除，普通退格不写入它。
	private killRing = new KillRing();
	// 有限状态联合类型：连续删除可累积，连续 yank 可轮换，连续输入可合并撤销；null 表示当前不延续这些链。
	private lastAction: "kill" | "yank" | "type-word" | null = null;

	// Undo support
	// UndoStack<InputState> 的泛型把本实例快照元素限定为文字/光标结构，不做运行时结构验证。
	private undoStack = new UndoStack<InputState>();

	// 创建空输入组件，输入可选提示/占位配置，只保存默认或自定义值，不触发绘制。
	// 例：new Input({prompt:"",placeholder:"搜索"}) 不显示默认前缀；构造无显式返回语句，value/cursor 使用字段初值。
	constructor(options: InputOptions = {}) {
		// ?? 仅对 null/undefined 使用默认前缀，空字符串可显式去掉前缀。
		this.prompt = options.prompt ?? "> ";
		// 缺省占位为空。
		this.placeholder = options.placeholder ?? "";
		// 保存自定义函数，或创建恒等回调 text => text；这行只保存函数，渲染占位时才调用。
		this.placeholderStyle = options.placeholderStyle ?? ((text) => text);
	}

	// 读取完整输入值，返回字符串，无副作用。例：即使屏幕只显示中间几列，getValue() 仍返回整段文字，placeholder 不算输入。
	getValue(): string {
		// 直接返回内部字符串值，不按可见窗口截取。
		return this.value;
	}

	// 直接替换值并把旧光标上限夹到新长度，返回 void，不创建撤销点或请求重画。
	// 例：新实例 setValue("hello") 的光标仍在 0，不会自动移到末尾；不清空旧撤销/删除记录/lastAction，也不清理换行或对齐字素边界。
	setValue(value: string): void {
		// 原样保存调用方字符串，没有走普通按键的控制字符过滤。
		this.value = value;
		// 仅限制到字符串长度上限；String.length 是 UTF-16 长度，不是可见列或字素数。
		this.cursor = Math.min(this.cursor, value.length);
	}

	// 处理宿主送来的一段终端输入，无返回值；先累积完整粘贴，再按配置执行取消/撤销/提交/编辑/移动，最后解码 Kitty 或接受普通文字。
	// 例：分两次收到粘贴内容也先缓冲到结束标记才插入；提交只通知 onSubmit，不清空值。会修改编辑状态、撤销与删除记录并同步调用用户回调，错误向上传播，不直接写终端。
	handleInput(data: string): void {
		// Handle bracketed paste mode
		// Start of paste: \x1b[200~
		// End of paste: \x1b[201~

		// Check if we're starting a bracketed paste
		// 本片段包含完整开始标记才开始或重新开始粘贴；这里不额外缓冲跨片段拆开的开始标记。
		if (data.includes("\x1b[200~")) {
			// 设置粘贴模式，后面先走粘贴缓冲分支。
			this.isInPaste = true;
			// 清空旧粘贴缓冲；嵌套开始标记也会重置旧缓冲。
			this.pasteBuffer = "";
			// replace 只去掉首个匹配的开始标记，剩余 data 随后加入缓冲。
			data = data.replace("\x1b[200~", "");
		}

		// If we're in a paste, buffer the data
		// 粘贴期间不把正文当成快捷键处理。
		if (this.isInPaste) {
			// Check if this chunk contains the end marker
			// 将本分片追加到缓冲，结束标记即使分片到达也可在合并后被找到。
			this.pasteBuffer += data;

			// 找缓冲中的第一个完整结束标记，未找到为 -1。
			const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
			// 标记完整才提交粘贴，否则继续等待后续输入。
			if (endIndex !== -1) {
				// Extract the pasted content
				// 只取结束标记之前的内容作为这次粘贴正文。
				const pasteContent = this.pasteBuffer.substring(0, endIndex);

				// Process the complete paste
				// 一次性清理并插入粘贴，形成一个撤销单元。
				this.handlePaste(pasteContent);

				// Reset paste state
				// 结束粘贴模式，下面的剩余字符恢复普通处理。
				this.isInPaste = false;

				// Handle any remaining input after the paste marker
				// 跳过结束控制序列的 6 个字符串单元，保留同分片后续输入。
				const remaining = this.pasteBuffer.substring(endIndex + 6); // 6 = length of \x1b[201~
				// 已取出正文和尾部，清空粘贴缓冲。
				this.pasteBuffer = "";
				// 尾部有内容才继续处理。
				if (remaining) {
					// 递归调用同一入口，可处理后续普通按键或另一段完整粘贴；不是异步请求。
					this.handleInput(remaining);
				}
			}
			// 这一分片已经被粘贴逻辑处理或缓冲，不再继续命中普通按键分支。
			return;
		}

		// 读取当前可配置键位，以下动作按顺序优先匹配。
		const kb = getKeybindings();

		// Escape/Cancel
		// 取消动作优先，具体键由配置决定。
		if (kb.matches(data, "tui.select.cancel")) {
			// 设置了回调才同步执行，不在此清空文字或重置编辑链。
			if (this.onEscape) this.onEscape();
			// 取消分支结束本次处理，防止把控制字节当文字。
			return;
		}

		// Undo
		// 识别撤销动作。
		if (kb.matches(data, "tui.editor.undo")) {
			// 弹出最近文字/光标快照并恢复；空栈不操作。
			this.undo();
			// 撤销后不继续尝试其他输入动作。
			return;
		}

		// Submit
		// 配置提交键或单独 LF 都触发提交；因此 LF 不作为普通输入文字加入。
		if (kb.matches(data, "tui.input.submit") || data === "\n") {
			// 若提供回调就传当前完整字符串，提交不自动清空内容或创建撤销快照。
			if (this.onSubmit) this.onSubmit(this.value);
			// 本次提交事件处理完成。
			return;
		}

		// Deletion
		// 匹配向后删一个字素的动作，常见为退格，但按键可改。
		if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			// 调用按字素边界删除的辅助方法，通常先记录撤销。
			this.handleBackspace();
			// 避免同一个按键继续落到文字插入分支。
			return;
		}

		// 匹配向前删一个字素的动作。
		if (kb.matches(data, "tui.editor.deleteCharForward")) {
			// 删除光标后的完整字素，光标本身保持原下标。
			this.handleForwardDelete();
			// 结束当前事件处理。
			return;
		}

		// 匹配向后删词。
		if (kb.matches(data, "tui.editor.deleteWordBackward")) {
			// 按词/标点边界删除并写入删除记录环。
			this.deleteWordBackwards();
			// 删除动作完成后返回。
			return;
		}

		// 匹配向前删词。
		if (kb.matches(data, "tui.editor.deleteWordForward")) {
			// 删除到下一词边界，并保存可 yank 的删除文字。
			this.deleteWordForward();
			// 不再尝试后续分支。
			return;
		}

		// 匹配删除到行首。
		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			// 删除光标前整段、保存记录并移光标到开头。
			this.deleteToLineStart();
			// 结束本次处理。
			return;
		}

		// 匹配删除到行尾。
		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			// 删除光标后整段，保持当前位置并保存删除记录。
			this.deleteToLineEnd();
			// 结束本次处理。
			return;
		}

		// Kill ring actions
		// 匹配 yank，即粘回删除环当前条目，不读取系统剪贴板。
		if (kb.matches(data, "tui.editor.yank")) {
			// 辅助方法在当前光标处插入记录并登记撤销。
			this.yank();
			// 结束本次处理。
			return;
		}
		// 匹配 yankPop，只有紧接 yank 链且有多条删除记录才有效。
		if (kb.matches(data, "tui.editor.yankPop")) {
			// 把刚粘回的一段替换成环中的另一条。
			this.yankPop();
			// 即使没有可替换项，也不把该按键当普通文本。
			return;
		}

		// Cursor movement
		// 匹配按字素向左移动。
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			// 移动打断连续删/粘回/输入合并链，不创建撤销点。
			this.lastAction = null;
			// 不是开头才有可移动的左侧内容。
			if (this.cursor > 0) {
				// 取光标左侧子串，slice 按 UTF-16 下标切。
				const beforeCursor = this.value.slice(0, this.cursor);
				// 将字素分段迭代结果展开成数组，便于找最后一项。
				const graphemes = [...segmenter.segment(beforeCursor)];
				// 左侧最后一个字素就是本次越过的单位。
				const lastGrapheme = graphemes[graphemes.length - 1];
				// 按字素所占字符串长度减下标；意外没有分段结果时回退减 1，不按终端列减。
				this.cursor -= lastGrapheme ? lastGrapheme.segment.length : 1;
			}
			// 移动分支完成，不改 value。
			return;
		}

		// 匹配按字素向右移动。
		if (kb.matches(data, "tui.editor.cursorRight")) {
			// 同样打断编辑合并链。
			this.lastAction = null;
			// 光标还没到字符串末尾才移动。
			if (this.cursor < this.value.length) {
				// 取右侧子串，分段器看到的是局部文本。
				const afterCursor = this.value.slice(this.cursor);
				// 展开分段结果以取首字素。
				const graphemes = [...segmenter.segment(afterCursor)];
				// 当前光标后的第一个字素是要跨越的对象。
				const firstGrapheme = graphemes[0];
				// 按它的 UTF-16 长度加下标，缺省回退 1。
				this.cursor += firstGrapheme ? firstGrapheme.segment.length : 1;
			}
			// 移动分支结束，不插入内容。
			return;
		}

		// 匹配跳行首。
		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			// 打断前一个编辑动作链。
			this.lastAction = null;
			// 字符串起始下标为 0。
			this.cursor = 0;
			// 返回，无文字变更。
			return;
		}

		// 匹配跳行尾。
		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			// 打断编辑链。
			this.lastAction = null;
			// 末尾光标可以等于 value.length，此时没有实际字符，用空格显示模拟光标。
			this.cursor = this.value.length;
			// 返回，不提交或插入换行。
			return;
		}

		// 匹配向后按词移动。
		if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			// 委托统一词边界逻辑，不手工按 ASCII 空格切词。
			this.moveWordBackwards();
			// 结束本次处理。
			return;
		}

		// 匹配向前按词移动。
		if (kb.matches(data, "tui.editor.cursorWordRight")) {
			// 委托向前边界逻辑。
			this.moveWordForwards();
			// 返回，不继续把序列当文字。
			return;
		}

		// Kitty CSI-u printable character (e.g. \x1b[97u for 'a').
		// Terminals with Kitty protocol flag 1 (disambiguate) send CSI-u for all keys,
		// including plain printable characters. Decode before the control-char check
		// since CSI-u sequences contain \x1b which would be rejected.
		// 尝试把整个输入解析成 Kitty CSI-u 文字序列；不符合其允许规则时返回 undefined。
		const kittyPrintable = decodeKittyPrintable(data);
		// 解码成功才走专门插入路径，避免原序列里的 ESC 被后面的普通字符过滤拒绝。
		if (kittyPrintable !== undefined) {
			// 插入解码后的字符串，撤销合并规则与普通文字一致。
			this.insertCharacter(kittyPrintable);
			// 该序列已消费，不再运行下面的原始文字控制字符检查。
			return;
		}

		// Regular character input - accept printable characters including Unicode,
		// but reject control characters (C0: 0x00-0x1F, DEL: 0x7F, C1: 0x80-0x9F)
		// 将普通 data 按 Unicode 码点展开，只要有一个控制字符就拒绝整段；这是原始终端文字输入的实际过滤边界，不是 TypeScript 字符串类型保证。
		const hasControlChars = [...data].some((ch) => {
			// 读取当前字符的首个 UTF-16 单元；ASCII/C0/C1 都在该范围内可直接比较。
			const code = ch.charCodeAt(0);
			// 拒绝 C0、DEL 与 C1 控制码数值区间；其他普通 Unicode 文字可以通过。
			return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		});
		// 仅当整段没有这些控制字符才视为普通插入。
		if (!hasControlChars) {
			// 一次插入 data 整段，可能是多个字符，不一定每次只有一个键对应的字符。
			this.insertCharacter(data);
		}
	}

	// 把左键首行按下位置映射到 value 的字素下标，返回处理/焦点意图或 undefined；会改 cursor 与 lastAction，不改值、不写终端。
	// 例：默认前缀宽 2，点击 x=4 对应输入正文约第 2 列。当前代码固定减 2，不按自定义 prompt 的真实宽度减；水平窗口偏移依赖最近一次普通文字 render 的记录。
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// 仅接收左键 press 且 y=0，其他事件不在这里移动光标。
		if (event.type !== "press" || event.button !== "left" || event.y !== 0) return undefined;
		// 固定扣两列默认前缀，并夹到至少 0；自定义提示宽不同时不会自动校正这一常数。
		const visibleColumn = Math.max(0, event.x - 2);
		// 加上最近绘制窗口起点，得到完整输入中的目标显示列。
		const targetColumn = this.renderedStartColumn + visibleColumn;
		// 遍历时累计终端列数，从 0 开始。
		let currentColumn = 0;
		// 先默认定位末尾；点击超过所有文字时保留此位置。
		this.cursor = this.value.length;
		// 按完整输入的字素逐项查找，grapheme.index 是原字符串 UTF-16 下标。
		for (const grapheme of segmenter.segment(this.value)) {
			// 用每个字素显示宽度累计下一边界，中文常占两列。
			const nextColumn = currentColumn + visibleWidth(grapheme.segment);
			// 目标还在这个字素列范围内时，把光标放到它的开头。
			if (targetColumn < nextColumn) {
				// 保存字素的字符串起始下标，不把列数直接写入 cursor。
				this.cursor = grapheme.index;
				// 找到后停止遍历。
				break;
			}
			// 继续向下一个字素累计列宽。
			currentColumn = nextColumn;
		}
		// 鼠标定位也打断连续编辑链。
		this.lastAction = null;
		// 告诉宿主已处理且希望聚焦；没有直接调用宿主绘制。
		return { handled: true, focus: true };
	}

	// 在当前下标插入字符串，无返回值；按空白与 lastAction 决定是否先建撤销点，再拼接文字、前移光标。
	// 例：连续输入 hello 共用一个撤销快照，输入空格前另建快照，随后 world 与前面空格可合并；char 允许一整段，isWhitespaceChar 只判断是否含空白，不是完整单词解析器。
	private insertCharacter(char: string): void {
		// Undo coalescing: consecutive word chars coalesce into one undo unit
		// 输入含空白或上次不是连续输入时，开启新的撤销单元。
		if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
			// 保存修改前的 value/cursor，不包含本次插入。
			this.pushUndo();
		}
		// 标记为输入链，即使本段含空白也采用这个标记，后续非空白可能继续合并。
		this.lastAction = "type-word";

		// 用左右切片夹住插入内容，新字符串替换旧值。
		this.value = this.value.slice(0, this.cursor) + char + this.value.slice(this.cursor);
		// 按插入串的 UTF-16 长度更新下标，不按可见列数更新。
		this.cursor += char.length;
	}

	// 向后删除一个字素，无参数/返回值；打断编辑链、有左侧内容才存撤销快照并删除，不写删除记录环。
	// 例：组合表情可作为一整个字素移除，开头不删；删除和光标下标使用 UTF-16 长度。
	private handleBackspace(): void {
		// 普通退格不延续 kill/yank/输入合并链。
		this.lastAction = null;
		// 开头没有左侧字素可删。
		if (this.cursor > 0) {
			// 先保存删除前的快照。
			this.pushUndo();
			// 取光标左侧所有文字。
			const beforeCursor = this.value.slice(0, this.cursor);
			// 展开左侧字素分段结果。
			const graphemes = [...segmenter.segment(beforeCursor)];
			// 选择最后一个完整字素。
			const lastGrapheme = graphemes[graphemes.length - 1];
			// 确定要移除的 UTF-16 长度，缺失回退 1。
			const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
			// 保留该字素之前与光标之后的文字，拼成新值。
			this.value = this.value.slice(0, this.cursor - graphemeLength) + this.value.slice(this.cursor);
			// 光标向左移过被删的字符串长度。
			this.cursor -= graphemeLength;
		}
	}

	// 向前删除一个字素，无参数/返回值；记录撤销后移除光标右侧字素，光标下标不变，也不写删除记录环。
	// 例："a|你好" 删除后为 "a|好"，竖线只是例子中的光标记号，不是实际文本。
	private handleForwardDelete(): void {
		// 打断前一个编辑链。
		this.lastAction = null;
		// 不在末尾才有可删内容。
		if (this.cursor < this.value.length) {
			// 保存删除前快照。
			this.pushUndo();
			// 取光标起始的后半段。
			const afterCursor = this.value.slice(this.cursor);
			// 按字素切分后半段。
			const graphemes = [...segmenter.segment(afterCursor)];
			// 当前光标下的首字素就是要删的项。
			const firstGrapheme = graphemes[0];
			// 取该项字符串长度，缺失回退 1。
			const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;
			// 把光标左侧与被删字素之后部分拼接，保持 cursor 不变。
			this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + graphemeLength);
		}
	}

	// 删除光标到行首整段，无参数/返回值；存撤销、把删文存入 kill ring，更新值并移到 0。
	// 例："abc|def" 变 "|def"，随后 yank 可粘回 abc；连续 kill 会把向后删除的文本前置累积，开头无动作。
	private deleteToLineStart(): void {
		// 已在开头直接返回，也不改 lastAction。
		if (this.cursor === 0) return;
		// 保存修改前的文字/光标。
		this.pushUndo();
		// 取光标之前整段作为删文。
		const deletedText = this.value.slice(0, this.cursor);
		// prepend:true 表示累积时放到旧记录前面，accumulate 仅上次同为 kill 时开启。
		this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
		// 本次结束后标记为成段删除链。
		this.lastAction = "kill";
		// 留下光标右侧所有文字。
		this.value = this.value.slice(this.cursor);
		// 删到开头后光标位于 0。
		this.cursor = 0;
	}

	// 删除光标到行尾整段，无参数/返回值；存撤销、把删文追加到连续 kill 记录，值保留左侧，光标不变。
	// 例："abc|def" 变 "abc|"，yank 可恢复 def；末尾无动作，不直接请求重画。
	private deleteToLineEnd(): void {
		// 已到末尾没有后段可删。
		if (this.cursor >= this.value.length) return;
		// 保存删除前快照。
		this.pushUndo();
		// 光标到末尾的子串就是删文。
		const deletedText = this.value.slice(this.cursor);
		// 向前删除使用 prepend:false，连续 kill 时拼到旧记录后面，保持文本原顺序。
		this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
		// 标记 kill 链。
		this.lastAction = "kill";
		// 保留光标左侧，cursor 原值恰为新末尾。
		this.value = this.value.slice(0, this.cursor);
	}

	// 按词边界向后删，无参数/返回值；先记旧 kill 状态，用词移动求删除起点，恢复旧光标再切掉这段，写撤销和删除记录。
	// 例："foo.bar|" 可先删 bar 留 "foo.|"，具体词/标点分段由 word-navigation 决定；连续删除按原文顺序前置累积。
	private deleteWordBackwards(): void {
		// 在开头就返回，不创建空删除记录。
		if (this.cursor === 0) return;

		// Save lastAction before cursor movement (moveWordBackwards resets it)
		// 移动辅助方法会清 lastAction，所以先保存是否延续 kill。
		const wasKill = this.lastAction === "kill";

		// 保存修改前快照。
		this.pushUndo();

		// 暂存删除前光标位置。
		const oldCursor = this.cursor;
		// 仅借移动方法计算前一个词/标点边界，它本身不删文本。
		this.moveWordBackwards();
		// 把移动后位置保存为删除起点。
		const deleteFrom = this.cursor;
		// 恢复旧光标，便于下面读取原删除区间。
		this.cursor = oldCursor;

		// 取 [deleteFrom, cursor) 这段删文。
		const deletedText = this.value.slice(deleteFrom, this.cursor);
		// 将删文前置累积或新建删除记录，使用移动前保存的 wasKill。
		this.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
		// 恢复为 kill 动作状态。
		this.lastAction = "kill";

		// 跳过整个删除区间，拼接两侧保留内容。
		this.value = this.value.slice(0, deleteFrom) + this.value.slice(this.cursor);
		// 光标停在删除起点。
		this.cursor = deleteFrom;
	}

	// 按词边界向前删除，无参数/返回值；存快照、计算终点、恢复光标后删区间，将删文追加累积到删除环。
	// 例："|foo.bar" 先删 foo 留 "|.bar"；光标下标保持原位置，不直接绘制。
	private deleteWordForward(): void {
		// 已在末尾无动作。
		if (this.cursor >= this.value.length) return;

		// Save lastAction before cursor movement (moveWordForwards resets it)
		// 提前保存原 kill 链状态，避免词移动方法把它清掉。
		const wasKill = this.lastAction === "kill";

		// 保存删除前快照。
		this.pushUndo();

		// 暂存原始光标。
		const oldCursor = this.cursor;
		// 向前移动到词/标点边界，仅用来求删除终点。
		this.moveWordForwards();
		// 记录求出的终点。
		const deleteTo = this.cursor;
		// 恢复原位置，后面从这里删除。
		this.cursor = oldCursor;

		// 取原光标到终点的删文。
		const deletedText = this.value.slice(this.cursor, deleteTo);
		// 向前删除用后置累积，并沿用移动前的 kill 状态。
		this.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
		// 标记本次仍是 kill 链。
		this.lastAction = "kill";

		// 删掉区间后拼接保留部分，不改 cursor。
		this.value = this.value.slice(0, this.cursor) + this.value.slice(deleteTo);
	}

	// 把删除环当前记录插到光标处，无参数/返回值；空环不操作，非空先存撤销，再改值/光标并开启 yank 链。
	// 例：此前删过 "word"，在 "hello |world" 执行 yank 得 "hello word|world"；不读取系统剪贴板。
	private yank(): void {
		// peek 只读取当前环尾记录，不移除它。
		const text = this.killRing.peek();
		// 没有非空文本就结束，不创建撤销点。
		if (!text) return;

		// 保存插入前快照。
		this.pushUndo();

		// 在光标两侧插入当前删除记录。
		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		// 光标移到新插入文本末尾，按 UTF-16 长度计算。
		this.cursor += text.length;
		// 记录为 yank，允许随后 yankPop 轮换。
		this.lastAction = "yank";
	}

	// 轮换刚 yank 的文本，无参数/返回值；仅 yank 链且环有多条时，保存撤销、删旧段、转环并插新段。
	// 例：刚粘回 SECOND 后轮换成 FIRST，替换的是紧挨光标前的旧记录长度；它依赖编辑链没有被其他方法打断，不会搜索定位文本，也不自动检查外部 setValue 是否改过内容。
	private yankPop(): void {
		// 不是 yank 链或只有一条记录时不操作。
		if (this.lastAction !== "yank" || this.killRing.length <= 1) return;

		// 记录替换前完整文字与光标，供一次撤销恢复。
		this.pushUndo();

		// Delete the previously yanked text (still at end of ring before rotation)
		// 先读轮换前当前文本，缺失用空串；正常由上面的环长度条件保证有记录。
		const prevText = this.killRing.peek() || "";
		// 移除光标前对应旧记录长度的区间，保留后半段。
		this.value = this.value.slice(0, this.cursor - prevText.length) + this.value.slice(this.cursor);
		// 光标回到刚删除区间的起点。
		this.cursor -= prevText.length;

		// Rotate and insert new entry
		// 将环尾移到环首，使下一条旧记录成为新的环尾。
		this.killRing.rotate();
		// 读轮换后的当前条目，缺失回退空串。
		const text = this.killRing.peek() || "";
		// 把新条目插回当前位置。
		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		// 光标前移到新条目末尾。
		this.cursor += text.length;
		// 保持 yank 状态，允许继续轮换多次。
		this.lastAction = "yank";
	}

	// 保存一份可撤销快照，无参数/返回值；UndoStack 内部 structuredClone，把文字与下标和之后的改动隔开。
	// 例：删除前 pushUndo，后续 undo 恢复这两个字段；不保存 killRing、焦点或粘贴模式，克隆错误向上传播。
	private pushUndo(): void {
		// 对象属性显式保存当前值与光标，并交给泛型栈深复制存储。
		this.undoStack.push({ value: this.value, cursor: this.cursor });
	}

	// 恢复并消费最近快照，无参数/返回值；空栈不操作，有则覆盖 value/cursor 并打断编辑链，没有 redo。
	// 例：连续输入 hello 共享一快照时撤销回输入前；删除环和 pasteBuffer 不一起回退。
	private undo(): void {
		// pop 移除并返回最近保存的独立快照。
		const snapshot = this.undoStack.pop();
		// 没有快照则直接返回。
		if (!snapshot) return;
		// 恢复原文字。
		this.value = snapshot.value;
		// 恢复原光标字符串下标。
		this.cursor = snapshot.cursor;
		// 下一次文字或 kill 不接着已撤销动作合并。
		this.lastAction = null;
	}

	// 向后按词边界移动，无参数/返回值；非开头时打断编辑链并采用工具求得的下标，不改文字或撤销栈。
	// 例："foo.bar|" 可移到 "foo.|bar"，具体 Unicode 词段与标点规则由工具决定；已在开头则连 lastAction 也不变。
	private moveWordBackwards(): void {
		// 开头无可移动的左侧范围。
		if (this.cursor === 0) return;
		// 确实进入移动路径时清合并状态。
		this.lastAction = null;
		// 纯函数读取文字与下标并返回前一边界，本实例保存该结果。
		this.cursor = findWordBackward(this.value, this.cursor);
	}

	// 向前按词边界移动，无参数/返回值；未到末尾时清编辑链并更新下标，不改文字。
	// 例："|foo.bar" 可移到 "foo|.bar"；工具先跳过前导空白再走一个词/标点段，末尾不操作。
	private moveWordForwards(): void {
		// 已在末尾直接结束，不重置 lastAction。
		if (this.cursor >= this.value.length) return;
		// 移动打断编辑链。
		this.lastAction = null;
		// 保存工具返回的下一词边界。
		this.cursor = findWordForward(this.value, this.cursor);
	}

	// 把完整括号粘贴当一个编辑单元插入，无返回值；清编辑链、存快照、删换行/回车并把 tab 变四空格后拼接。
	// 例：粘贴 "a\nb\tc" 插入 "ab    c"，不是换行变空格；只做这些明确替换，不执行普通字符入口的控制字符过滤，异常向上传播。
	private handlePaste(pastedText: string): void {
		// 粘贴与之前连续输入/删除/粘回分开。
		this.lastAction = null;
		// 无论粘贴清理后是否为空，都先保存一次快照。
		this.pushUndo();

		// Clean the pasted text - remove newlines and carriage returns
		// g 表示全量替换：先删 CRLF，再删独立 CR/LF，最后把每个 tab 换成四空格；不同于 Text 的三空格策略。
		const cleanText = pastedText.replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, "").replace(/\t/g, "    ");

		// Insert at cursor position
		// 将清理结果插在当前字符串下标，保留左右文字。
		this.value = this.value.slice(0, this.cursor) + cleanText + this.value.slice(this.cursor);
		// 光标按实际插入串长度前移。
		this.cursor += cleanText.length;
	}

	// 实现缓存失效通知，无参数/返回值；本类每次 render 重新算行，没有行缓存可清。例：主题改变后宿主调用它不会清空输入、撤销或粘贴缓冲。
	invalidate(): void {
		// No cached state to invalidate currently
	}

	// 按总列宽返回一条带提示与模拟光标标记的文本，不写终端；先处理占位，再按显示列决定水平窗口并拼光标。
	// 例：长中文输入中间移动光标时，只显示附近窗口，value 仍完整；focused 才发硬件位置标记，模拟光标由宿主解析。会更新 renderedStartColumn，但占位/前缀占满分支不更新它；样式/列宽工具错误向上传播。
	render(width: number): string[] {
		// Calculate visible window
		// 从总列宽扣掉提示前缀的真实显示宽度，剩余空间供文字与光标使用。
		const availableWidth = width - visibleWidth(this.prompt);

		// 前缀已经占满或超出可用宽度时不绘正文与光标。
		if (availableWidth <= 0) {
			// 只返回按列截断的提示，不加省略符；此提前返回不会重设上次 renderedStartColumn。
			return [truncateToWidth(this.prompt, width, "")];
		}

		// 值为空且有占位文案时走专门的显示路径，placeholder 不写入 value。
		if (this.value.length === 0 && this.placeholder) {
			// 占位文字先直接截到可用列宽，不加省略符。
			const placeholder = truncateToWidth(this.placeholder, availableWidth, "");
			// 对占位字符串按字素分段，普通文字中的组合表情不会按单个 UTF-16 单元拆开；这里不是专门解析 ANSI 控制序列。
			const graphemes = [...segmenter.segment(placeholder)];
			// 首字素作为模拟光标覆盖内容，缺省用一个空格。
			const atCursor = graphemes[0]?.segment ?? " ";
			// 剩下占位文字从首字素字符串长度之后截取。
			const afterCursor = placeholder.slice(atCursor.length);
			// 只有 focused 时放零宽硬件光标位置标记。
			const marker = this.focused ? CURSOR_MARKER : "";
			// 先给首字素上占位样式，再包模拟光标标记；不是此函数直接画反色。
			const cursorChar = renderFakeCursor(this.placeholderStyle(atCursor));
			// 组合硬件标记、模拟光标片段和其余占位样式文字。
			const textWithCursor = marker + cursorChar + this.placeholderStyle(afterCursor);
			// 测实际可见宽度后把剩余列补空格，控制标记本身不占列。
			const padding = " ".repeat(Math.max(0, availableWidth - visibleWidth(textWithCursor)));
			// 拼前缀并返回单行，占位分支不更新 renderedStartColumn。
			return [this.prompt + textWithCursor + padding];
		}

		// 准备保存当前窗口内真正显示的 value 子串。
		let visibleText = "";
		// 未滚动时光标局部下标就是完整 cursor；后面滚动路径会换算成子串下标。
		let cursorDisplay = this.cursor;
		// 普通文字路径先重置可见起始列为 0。
		this.renderedStartColumn = 0;
		// 计算完整输入的终端显示列宽，不是字符串长度。
		const totalWidth = visibleWidth(this.value);

		// 严格小于可用列数才算全放得下，留一个空格显示末尾光标。
		if (totalWidth < availableWidth) {
			// Everything fits (leave room for cursor at end)
			// 无需水平窗口裁切，完整 value 作为可见文字。
			visibleText = this.value;
		} else {
			// Need horizontal scrolling
			// Reserve one column for cursor if it's at the end
			// 光标在末尾时额外预留 1 列给空格光标，位于字中时可占现有字素位置。
			const scrollWidth = this.cursor === this.value.length ? availableWidth - 1 : availableWidth;
			// 把 cursor 前文字的显示宽度作为光标终端列位置。
			const cursorCol = visibleWidth(this.value.slice(0, this.cursor));

			// 正文仍有正列数时才选择可见窗口。
			if (scrollWidth > 0) {
				// 半个窗口宽度向下取整，尽量把中间光标放居中。
				const halfWidth = Math.floor(scrollWidth / 2);
				// 先默认从内容第 0 列开始。
				let startCol = 0;

				// 光标靠近开头时无需向右滚动。
				if (cursorCol < halfWidth) {
					// Cursor near start
					// 窗口起点保持 0。
					startCol = 0;
					// 光标靠近内容末端时将窗口贴到右端。
				} else if (cursorCol > totalWidth - halfWidth) {
					// Cursor near end
					// 总宽减窗口宽得到末端窗口起点，不小于 0。
					startCol = Math.max(0, totalWidth - scrollWidth);
					// 其余为光标在中间的情况。
				} else {
					// Cursor in middle
					// 把起点设为光标列减半窗口，确保不为负。
					startCol = Math.max(0, cursorCol - halfWidth);
				}

				// 保存这个显示列起点，随后鼠标点击用它映射回完整值。
				this.renderedStartColumn = startCol;
				// 严格按显示列切片，边界跨宽字素时不保留越界半字，结果可能含必要 ANSI。
				visibleText = sliceByColumn(this.value, startCol, scrollWidth, true);
				// 从同一起点另切到光标前，得到窗口内的左半段；长度参数不得为负。
				const beforeCursor = sliceByColumn(this.value, startCol, Math.max(0, cursorCol - startCol), true);
				// 使用该片段的字符串长度作为 visibleText 内的光标下标，不把显示列数直接当 slice 下标。
				cursorDisplay = beforeCursor.length;
				// 只有末尾光标且空间极窄等情况下，正文窗口可能无正列数。
			} else {
				// 不显示正文子串，仍可在后面显示一个空格光标。
				visibleText = "";
				// 局部光标下标设为 0。
				cursorDisplay = 0;
			}
		}

		// Build line with fake cursor
		// Insert cursor character at cursor position
		// 对局部光标之后的文字按字素分段，准备选择模拟光标覆盖单位。
		const graphemes = [...segmenter.segment(visibleText.slice(cursorDisplay))];
		// 取首字素，位于末尾时可能没有。
		const cursorGrapheme = graphemes[0];

		// 截取局部光标前面的可见文字。
		const beforeCursor = visibleText.slice(0, cursorDisplay);
		// 当前字素作为光标内容，末尾没有分段结果则用空格；?? 仅对 null/undefined 回退，不做 || 那样的真假值判断。
		const atCursor = cursorGrapheme?.segment ?? " "; // Character at cursor, or space if at end
		// 把当前光标覆盖字素之后的文字作为右侧部分。
		const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);

		// Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
		// 焦点决定是否给宿主硬件位置标记；没焦点时字符串为空。
		const marker = this.focused ? CURSOR_MARKER : "";

		// TUI draws the fake cursor in reverse video, or omits it when the hardware cursor is shown
		// 给光标文字包专用零宽标记，反色或硬件光标模式由后续 TUI 解析处理。
		const cursorChar = renderFakeCursor(atCursor);
		// 依次连接左侧、位置标记、模拟光标片段与右侧。
		const textWithCursor = beforeCursor + marker + cursorChar + afterCursor;

		// Calculate visual width
		// 计算整段正文显示列宽，忽略标记和 ANSI 控制码。
		const visualLength = visibleWidth(textWithCursor);
		// 不足 availableWidth 就在右侧补空格，超出时不在这一行另行截断。
		const padding = " ".repeat(Math.max(0, availableWidth - visualLength));
		// 加回固定提示前缀，得到完整行。
		const line = this.prompt + textWithCursor + padding;

		// 用单元素数组返回，符合 Component 的多行接口；Input 自己每次只生成这一条行字符串。
		return [line];
	}
}
