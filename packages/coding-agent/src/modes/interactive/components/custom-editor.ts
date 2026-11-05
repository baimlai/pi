// 主对话编辑器：在 TUI 多行 Editor 上增加应用快捷键优先级和可选状态顶边框，业务操作由宿主回调执行。
// Editor 处理多行编辑/补全，visibleWidth 按显示列测 ANSI 字符串；type 项编译后擦除。
import { Editor, type EditorOptions, type EditorTheme, type TUI, visibleWidth } from "@earendil-works/pi-tui";
// 应用动作名和键位管理器类型，运行实例由宿主传入，不在本文件读配置。
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
// 状态指示器仅作参数类型；本组件不负责启动/销毁其动画。
import type { StatusIndicator } from "./status-indicator.ts";

// 交叉类型在基础编辑器选项上增加边框状态显示开关；不会自动改变父类逻辑。
export type CustomEditorOptions = EditorOptions & {
	/** Render working, compaction, summarization, and retry status in the editor's top border. */
	// 可省略，默认 false；开启后仍需提供具体状态指示器。
	embedWorkingStatus?: boolean;
};

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
// 继承文字编辑/历史/补全能力，在其前面加应用快捷键路由，并可重画顶边框。
export class CustomEditor extends Editor {
	// 保存宿主传入管理器用于本层匹配；父 Editor 自己读取共享全局管理器，正常宿主让它们使用一致配置。
	private keybindings: KeybindingsManager;
	// 当前可选状态引用，替换时不自动 dispose 旧对象。
	private workingStatusIndicator: StatusIndicator | undefined;
	// public 供宿主探测是否支持嵌入；readonly 只限制 TS 重赋，不是运行时冻结。
	public readonly embedWorkingStatus: boolean;
	// 应用动作→无参回调的可变 Map；按插入顺序匹配，给同动作 set 新回调会替换值但不移动位置。
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	// 可选动态中断回调，优先于 Map 中的 app.interrupt。
	public onEscape?: () => void;
	// 可选动态退出回调，仅编辑器完全空串时使用；字段名描述默认键，真实匹配按配置。
	public onCtrlD?: () => void;
	// 图片粘贴意图回调，组件自身不读取系统剪贴板。
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	// 扩展输入拦截器最先执行，返回 true 表示消费，false 才继续应用/编辑器流程。
	public onExtensionShortcut?: (data: string) => boolean;

	// 创建基础多行编辑器并保存应用键位/状态开关；例传 {embedWorkingStatus:true} 后仍需 setWorkingStatusIndicator 才有状态文字。
	// 输入宿主、样式、键位和可选配置，返回实例；不执行模型请求，父类构建错误传播。
	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		// 父类先保存宿主/主题并规范自身边距等选项，之后才能使用 this。
		super(tui, theme, options);
		// 保存管理器引用，后续匹配读取其当前配置。
		this.keybindings = keybindings;
		// ?. 处理缺选项，?? 只在空缺时用 false，显式 true 才进入嵌入路径。
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
	}

	// 替换或移除边框状态引用，无返回值；例传 undefined 恢复普通边框，不在这里刷新/销毁旧动画，宿主管生命周期。
	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		// 只存引用，下次 renderTopBorder 才读取它。
		this.workingStatusIndicator = indicator;
	}

	// 生成顶边框字符串：无状态则用父类，有状态尽量和居中的隐藏行数并排，放不下则降级只显示旋转符。
	// 例 20 列可显示工作文案，极窄宽度只留能放下的图标/横线；参数沿用父 Editor 的有效列宽约定，样式异常传播，不写终端。
	// protected 供类及子类使用，override 要求父类确有该方法；hiddenLineCount 指上方未显示的编辑折行数。
	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		// 未开启、没提供状态或宽度非正时直接沿用父逻辑；这里不额外清理指示器。
		if (!this.embedWorkingStatus || !this.workingStatusIndicator || width <= 0) {
			// 父类负责纯边框或滚动提示，不在此复制其规则。
			return super.renderTopBorder(width, hiddenLineCount);
		}

		// 先为两侧横线/空白预留 5 列，状态至少给 1 列，取紧凑正文首行。
		let status = this.workingStatusIndicator.renderInBorder(Math.max(1, width - 5));
		// 按终端显示列测宽，不把 ANSI 转义计入长度，let 允许降级后重新计算。
		let statusWidth = visibleWidth(status);
		// 指示器没有可见文字时不用嵌入布局，返回父边框。
		if (statusWidth === 0) return super.renderTopBorder(width, hiddenLineCount);

		// 只有上方有隐藏折行才显示箭头/计数，带空格用于和横线分隔。
		const overflowLabel = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
		// 有提示才测显示列，没有则宽 0。
		const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
		// 计算提示居中后的左端列，floor 消除半列。
		const overflowStart = Math.floor((width - overflowLabelWidth) / 2);
		// 无参闭包读取最新 statusWidth，判断状态左块与居中提示能否同时放下；状态降级后再调用会得到新结论。
		const canFitOverflow = () =>
			// 必须有提示、提示两侧有余量、并且前面的 3 列前缀+状态+1 空格之后还留至少 1 列横线。
			overflowLabel !== undefined && overflowLabelWidth + 2 <= width && overflowStart - (3 + statusWidth + 1) >= 1;

		// 有滚动提示但完整状态塞不下，先尝试只用旋转符。
		if (overflowLabel && !canFitOverflow()) {
			// 降级不带状态文案，仍按当前宽度裁图标。
			status = this.workingStatusIndicator.renderSpinnerInBorder(width);
			// 以降级结果重新测宽，供后续 canFitOverflow 计算。
			statusWidth = visibleWidth(status);
		}

		// 若现在能同时容纳，保留居中滚动提示及左侧状态。
		if (canFitOverflow()) {
			// 左块由 "── " 三列、状态及其后一空格组成。
			const leftBlockWidth = 3 + statusWidth + 1;
			// 将几段带样式字符串连接，返回一行，不添加 LF。
			return (
				// 边框前缀使用编辑器当前 borderColor，状态本身保留自己的样式。
				this.borderColor("── ") +
				// 拼接状态文本或降级图标。
				status +
				// 剩余横线/滚动提示统一按边框颜色着色。
				this.borderColor(
					// 状态后先一空格，横线补到提示起点，再加居中标签与右侧剩余横线；前面的 fit 判断约束这些数量。
					` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(width - overflowStart - overflowLabelWidth)}`,
				)
			);
		}

		// 不放滚动提示的路径中，完整状态还能容纳就保留它。
		if (width >= statusWidth + 5) {
			// 前缀 3 列加状态加空格，再用横线补到父宽。
			return this.borderColor("── ") + status + this.borderColor(` ${"─".repeat(width - statusWidth - 4)}`);
		}

		// 仍放不下时仅显示能容纳的图标，放弃完整文案/滚动标签。
		status = this.workingStatusIndicator.renderSpinnerInBorder(width);
		// 重新测最终图标宽度。
		statusWidth = visibleWidth(status);
		// 剩余空间最多给左侧 3 列横线，至少 0。
		const prefixWidth = Math.min(3, Math.max(0, width - statusWidth));
		// 将极窄布局的前缀、图标及后缀拼为单行。
		return (
			// 按刚算出的列数生成左边横线。
			this.borderColor("─".repeat(prefixWidth)) +
			// 保留最终旋转符自己的样式。
			status +
			// 剩余非负列数补右边横线；不把颜色控制符当显示列。
			this.borderColor("─".repeat(Math.max(0, width - prefixWidth - statusWidth)))
		);
	}

	/**
	 * Register a handler for an app action.
	 */
	// 登记应用动作回调，无返回值；例 onAction("app.model.cycleForward",fn) 等待匹配输入才执行，同名动作替换旧回调。
	onAction(action: AppKeybinding, handler: () => void): void {
		// Map 只存函数引用，不立即调用；运行时不另校验动作字符串。
		this.actionHandlers.set(action, handler);
	}

	// 按顺序分派输入：扩展拦截→打开菜单的翻页→图片粘贴→中断/空编辑器退出→历史导航→其余应用动作→父编辑器。
	// 例补全打开且 Ctrl+V 同为下翻页/粘贴图时先翻页；显式历史 Ctrl+P 优先于模型切换。
	// 可修改文本/菜单并同步触发回调，不返回处理值；回调异常传播，不保证每个匹配动作都有已注册处理器。
	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		// 可选调用最先运行；返回真值就不让同一输入再进入本层/父层动作。
		if (this.onExtensionShortcut?.(data)) {
			// 当前分支已消费输入，立即结束，不再匹配后面的动作。
			return;
		}

		// Selection page keys move an open autocomplete menu before app actions run.
		// This lets users bind Ctrl+V even though it pastes images by default.
		// 下面跨行条件用于补全菜单导航优先级。
		if (
			// 只有菜单已打开才优先转发翻页，等待建议请求尚未显示不算。
			this.isShowingAutocomplete() &&
			// 本层管理器识别上/下翻页任一个，键位共享冲突时在粘贴/应用动作前处理。
			(this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.select.pageDown"))
		) {
			// 把原输入交父 Editor 处理，例如菜单导航/取消或普通编辑，不在本行猜测固定键字节。
			super.handleInput(data);
			// 当前分支已消费输入，立即结束，不再匹配后面的动作。
			return;
		}

		// Check for clipboard paste keybinding
		// 图片粘贴动作只做意图分派，优先于后面的其他应用动作。
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			// 有回调才执行；没有回调也会在随后 return 消费此键，不转成普通文本。
			this.onPasteImage?.();
			// 当前分支已消费输入，立即结束，不再匹配后面的动作。
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		// 按配置识别中断动作，字段 onEscape 不代表只匹配固定 Escape。
		if (this.keybindings.matches(data, "app.interrupt")) {
			// 菜单关闭时才尝试应用层中断处理器。
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				// 动态回调优先；?? 只在它缺省时回退 Map。
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				// 实际有处理器才由应用层消费。
				if (handler) {
					// 同步调用，业务可能取消请求/清文字，异常直接传播。
					handler();
					// 已执行应用中断，不再交父层重复处理。
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			// 把原输入交父 Editor 处理，例如菜单导航/取消或普通编辑，不在本行猜测固定键字节。
			super.handleInput(data);
			// 当前分支已消费输入，立即结束，不再匹配后面的动作。
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		// 退出动作仅空编辑器时在本层截获；非空时继续后面的历史/应用/父层处理。
		if (this.keybindings.matches(data, "app.exit")) {
			// 严格空串才算空，只有空格的草稿长度非 0，不会在此退出。
			if (this.getText().length === 0) {
				// 动态退出回调优先于注册的退出动作。
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				// 回调可缺；即使没有也会消费空输入框上的退出键。
				if (handler) handler();
				// 空编辑器退出分支到此结束，不继续执行删除字符等父行为。
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		// 下面跨行条件让编辑历史导航优先于其余应用动作。
		if (
			// 历史上一项先于其余应用动作；与模型循环键重叠时历史优先。
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			// 历史下一项同理，真正历史状态由父 Editor 维护。
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			// 把原输入交父 Editor 处理，例如菜单导航/取消或普通编辑，不在本行猜测固定键字节。
			super.handleInput(data);
			// 当前分支已消费输入，立即结束，不再匹配后面的动作。
			return;
		}

		// Check all other app actions
		// 按 Map 插入顺序解构动作/回调，多个动作同键时第一个匹配者获胜。
		for (const [action, handler] of this.actionHandlers) {
			// 中断/退出已单独处理，这里排除它们，再匹配其他注册动作。
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				// 实际触发该应用回调，不自动修改任何特定模型/会话设置。
				handler();
				// 当前应用动作已执行，结束分派，不再交父编辑器。
				return;
			}
		}

		// Pass to parent for editor handling
		// 其余输入交基础 Editor 编辑/补全/提交；父层还会按它的共享键位配置分派。
		super.handleInput(data);
	}
}
