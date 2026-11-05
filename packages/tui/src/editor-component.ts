// 自定义编辑器与交互应用之间的编译期契约；扩展工厂返回符合它的组件，interactive-mode把文字/回调/外观设置转交过去。
// 本文件只有类型声明，运行时不创建编辑器、不处理按键，也不自动提供默认实现；具体行为和异常由实现决定，宿主负责调用/回退。
// type仅导入补全服务契约，不启动文件扫描或补全任务。
import type { AutocompleteProvider } from "./autocomplete.ts";
// Component要求render/invalidate，并可提供鼠标等能力；这里只在类型层继承它。
import type { Component } from "./tui.ts";

/**
 * Interface for custom editor components.
 *
 * This allows extensions to provide their own editor implementation
 * (e.g., vim mode, emacs mode, custom keybindings) while maintaining
 * compatibility with the core application.
 */
// extends复用组件字段/方法，再要求编辑器能取文字、设置文字和处理输入；例：Vim式自定义编辑器也要能被宿主render。
// 接口本身不包含Focusable要求，是否有focused/硬件光标行为还需实现与宿主约定，声明不进行运行时结构校验。
export interface EditorComponent extends Component {
	// =========================================================================
	// Core text access (required)
	// =========================================================================

	/** Get the current text content */
	// 无参数读取当前编辑文字并返回string；例：切换编辑器前宿主用它保存当前草稿，不应只返回窗口内可见那几列。
	getText(): string;

	/** Set the text content */
	// 接收完整文字、替换编辑内容，返回void；例：宿主切换编辑器后用setText(currentText)恢复草稿，是否触发onChange/撤销记录由实现决定。
	setText(text: string): void;

	/** Handle raw terminal input (key presses, paste sequences, etc.) */
	// 接收一段终端输入并更新编辑状态，返回void；例：实现可解析回车/粘贴标记并通知提交，类型不会自动解码或过滤控制码。
	handleInput(data: string): void;

	// =========================================================================
	// Callbacks (required)
	// =========================================================================

	/** Called when user submits (e.g., Enter key) */
	// 可选提交回调，(text:string)=>void表示接收提交文字且不返回业务结果；例：宿主赋值后由编辑器在确认动作时调用，不因声明就自动触发。
	// ?表示字段可缺，虽然上方英文分组称required，TypeScript实际允许不设置回调；实现调用前应遵守这个可选约定。
	onSubmit?: (text: string) => void;

	/** Called when text changes */
	// 可选文字变化通知，接收实现提供的最新文本、返回void；例：普通编辑后调用让宿主更新UI，setText是否通知不能仅从此接口推断。
	onChange?: (text: string) => void;

	// =========================================================================
	// History support (optional)
	// =========================================================================

	/** Add text to history for up/down navigation */
	// 可选方法接收一条历史文字、返回void，供上下导航；例：宿主提交后可写历史，不要求每个自定义编辑器都维护历史，也不自动持久化。
	addToHistory?(text: string): void;

	// =========================================================================
	// Advanced text manipulation (optional)
	// =========================================================================

	/** Insert text at current cursor position */
	// 可选方法在当前光标处插入传入文本，返回void；例：附件路径插入依赖此能力，宿主通常用?.()调用，缺方法不会由接口补写文字。
	insertTextAtCursor?(text: string): void;

	/**
	 * Get text with any markers expanded (e.g., paste markers).
	 * Falls back to getText() if not implemented.
	 */
	// 可选无参数方法返回展开大段粘贴等标记后的完整文字；例：getText可能含折叠标记，宿主用getExpandedText?.() ?? getText()取得发送正文。
	// 回退发生在interactive-mode等调用方，不是这个声明提供的默认函数；调用产生的错误同样不会被接口捕获。
	getExpandedText?(): string;

	// =========================================================================
	// Autocomplete support (optional)
	// =========================================================================

	/** Set the autocomplete provider */
	// 可选方法接收补全提供者、返回void；例：宿主把组合命令/路径提供者交给编辑器，何时异步getSuggestions/取消由编辑器实现决定，设置不等于已发请求。
	setAutocompleteProvider?(provider: AutocompleteProvider): void;

	// =========================================================================
	// Appearance (optional)
	// =========================================================================

	/** Border color function */
	// 可选边框样式函数，输入字符串、输出带样式字符串；例：宿主复制默认边框函数，自定义实现渲染时再调用，不直接写终端。
	borderColor?: (str: string) => string;

	/** Set horizontal padding */
	// 可选方法设置左右内边距列数并返回void；例：宿主同步用户paddingX设置，number类型本身不保证非负整数，具体正规化由实现处理。
	setPaddingX?(padding: number): void;

	/** Set max visible items in autocomplete dropdown */
	// 可选方法设置补全菜单可见项数上限，返回void；例：宿主同步默认编辑器的菜单设置，不限制实际候选数组长度，也不自行发补全任务。
	setAutocompleteMaxVisible?(maxVisible: number): void;
}
