// 扩展单行输入面板；焦点传给 Input，可选倒计时触发取消意图，宿主负责关闭和 dispose。
/**
 * Simple text input component for extensions.
 */

// 混合运行时布局/输入/键位函数与编译期 Focusable/TUI 类型，类型不会自动做焦点路由。
import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
// 标题/说明采用当前主题样式。
import { theme } from "../theme/theme.ts";
// 本地按秒递减的显示倒计时，到期调用传入回调，不自行中断业务。
import { CountdownTimer } from "./countdown-timer.ts";
// 根据父宽绘制上下边框。
import { DynamicBorder } from "./dynamic-border.ts";
// 帮助文案读当前配置，实际匹配在 handleInput。
import { keyHint } from "./keybinding-hints.ts";

// 可选面板配置，类型声明不自动验证 timeout 有限性或安装定时器。
export interface ExtensionInputOptions {
	// 可选刷新宿主；必须同时提供正 timeout 才启动倒计时。
	tui?: TUI;
	// 超时毫秒，按 ceil(timeout/1000) 后每秒递减；不是精确墙钟截止时间。
	timeout?: number;
	// 可选初值，构造只在真值时调用 Input.setValue。
	initialValue?: string;
	// 可选说明文字。
	description?: string;
}

// 容器负责排版并实现焦点接口，宿主对话框流程负责回调后移除与清理。
export class ExtensionInputComponent extends Container implements Focusable {
	// 真正保存单行输入值/光标的组件。
	private input: Input;
	// 提交回传当前完整字符串，不在此 trim 或写会话。
	private onSubmitCallback: (value: string) => void;
	// 取消/倒计时到期共同使用的宿主通知。
	private onCancelCallback: () => void;
	// 可被倒计时更新的标题显示。
	private titleText: Text;
	// 保留原始标题，避免每次 tick 在旧秒数后重复追加。
	private baseTitle: string;
	// 条件满足时持有计时器，dispose 停止它；无配置时为空。
	private countdown: CountdownTimer | undefined;

	// Focusable implementation - propagate to input for IME cursor positioning
	// 记录外层焦点，默认 false。
	private _focused = false;
	// 返回外层焦点标记，无副作用；例 TUI 查询面板是否聚焦，不改变输入。
	get focused(): boolean {
		// 直接读取字段。
		return this._focused;
	}
	// 保存焦点并传给内部 Input，无返回值；例面板聚焦后输入法能定位实际输入光标，不自动提交。
	set focused(value: boolean) {
		// 更新面板焦点状态。
		this._focused = value;
		// 让 Input 按焦点决定是否发硬件光标位置标记。
		this.input.focused = value;
	}

	// 创建标题/说明/输入/帮助与边框；可选正 timeout+tui 时启动倒计时，返回新面板。
	// 例 initialValue="draft" 会预填；placeholder 参数当前未使用。提交/取消只回调，宿主需调用 dispose 并移除面板。
	// 构建/主题/回调错误会传播，计时器不会因组件失去引用自动停止。
	constructor(
		// 原始面板标题。
		title: string,
		// 兼容形参当前未读取，不传给 Input，所以不会出现该占位文字。
		_placeholder: string | undefined,
		// 确认时接收输入全文，空串也可回传。
		onSubmit: (value: string) => void,
		// 主动取消或倒计时到期时通知。
		onCancel: () => void,
		// 初值、说明与倒计时设置可整体省略。
		opts?: ExtensionInputOptions,
	) {
		// 初始化父容器。
		super();

		// 保存提交函数。
		this.onSubmitCallback = onSubmit;
		// 保存取消函数。
		this.onCancelCallback = onCancel;
		// 记录不带秒数的原始标题。
		this.baseTitle = title;

		// 上/下边框作为独立孩子按父宽渲染。
		this.addChild(new DynamicBorder());
		// 在面板元素之间加入一行空白。
		this.addChild(new Spacer(1));

		// 标题强调色，左右各 1 列、上下 0 行内边距。
		this.titleText = new Text(theme.fg("accent", title), 1, 0);
		// 标题实例放入容器，倒计时以后只更新其文字。
		this.addChild(this.titleText);
		// 可选链避免缺配置时报错；非空说明才显示。
		if (opts?.description) {
			// 说明前加一行。
			this.addChild(new Spacer(1));
			// 说明用普通 Text，不作为模型消息或 Markdown 解析。
			this.addChild(new Text(theme.fg("text", opts.description), 1, 0));
		}
		// 在面板元素之间加入一行空白。
		this.addChild(new Spacer(1));

		// 必须 timeout 为真值且大于 0、有 TUI；未检查有限性，Infinity 可进入并永不正常递减到期。
		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			// 构造会立即调用一次 tick 更新标题，再安装每秒计时器。
			this.countdown = new CountdownTimer(
				// 传原毫秒数，由 CountdownTimer 向上取整为秒。
				opts.timeout,
				// 每次 tick 后用于请求重画的宿主。
				opts.tui,
				// tick 接收剩余秒数，重建标题字符串，不重复追加上一次标题。
				(s) => this.titleText.setText(theme.fg("accent", `${this.baseTitle} (${s}s)`)),
				// 到期只执行取消回调，是否移除面板取决于宿主。
				() => this.onCancelCallback(),
			);
		}

		// 创建默认 Input，没有传入上面的 placeholder。
		this.input = new Input();
		// 真值初值直接保存；Input.setValue 不自动把光标移到末尾，新输入框光标通常仍为 0。
		if (opts?.initialValue) this.input.setValue(opts.initialValue);
		// 把真实输入框放到标题/说明之后。
		this.addChild(this.input);
		// 在面板元素之间加入一行空白。
		this.addChild(new Spacer(1));
		// 加入显示提交/取消键的帮助 Text。
		this.addChild(
			// 提示跟随动作配置，但本组件还单独接受 LF 提交。
			new Text(`${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "cancel")}`, 1, 0),
		);
		// 在面板元素之间加入一行空白。
		this.addChild(new Spacer(1));
		// 上/下边框作为独立孩子按父宽渲染。
		this.addChild(new DynamicBorder());
	}

	// 按确认或 LF 提交→按取消通知→其余交 Input 编辑，返回 void；例空输入确认也回传空串，不清值或自动 dispose。
	// 匹配/回调同步执行，错误传播；本方法无终态标志，多次输入仍可重复通知，宿主负责移除。
	handleInput(keyData: string): void {
		// 每次输入读取共享键位。
		const kb = getKeybindings();
		// 确认动作或明确 LF 优先，即使取消动作同键也先提交。
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			// 取当前完整字符串回传，不 trim、不调用 Input 自己的提交回调。
			this.onSubmitCallback(this.input.getValue());
			// 不是确认时再匹配取消。
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			// 只发取消意图，不在此停止倒计时。
			this.onCancelCallback();
		} else {
			// 其余键编辑正文；Input 内部仍有自己的输入/提交键规则，但本面板未绑定其 onSubmit。
			this.input.handleInput(keyData);
		}
	}

	// 停止可选倒计时，可重复调用，无返回值；例宿主完成/取消后清理，既不触发取消回调也不移除面板。
	dispose(): void {
		// 有计时器才清 interval；保留引用和标题文字，未设置 finished 标志。
		this.countdown?.dispose();
	}
}
