// 扩展字符串选项面板：自己画列表、处理上下与确认/取消，可选倒计时；选择结果和清理由宿主处理。
/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

// 运行时排版与键位函数，TUI 仅约束倒计时刷新宿主的类型。
import { Container, getKeybindings, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
// 标题/选中项/普通文字采用当前主题。
import { theme } from "../theme/theme.ts";
// 倒计时按 tick 减秒，非精确墙钟 deadline，到期只通知取消。
import { CountdownTimer } from "./countdown-timer.ts";
// 根据父宽输出面板上下边框。
import { DynamicBorder } from "./dynamic-border.ts";
// keyHint 查动作配置，rawKeyHint 仅美化原始文字，不能反推实际绑定。
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

// 面板可选配置，不会仅因声明接口而创建计时器或监听器。
export interface ExtensionSelectorOptions {
	// 有正 timeout 且有宿主时才能计时/请求刷新。
	tui?: TUI;
	// 毫秒输入，helper 按秒向上取整且逐 tick 减 1；这里不检查有限性。
	timeout?: number;
	// 可选在面板打开时切换背后工具展开状态的回调。
	onToggleToolsExpanded?: () => void;
	// 可选额外说明，真值时展示。
	description?: string;
}

// 用 Text 自己渲染全部字符串项，不是 SelectList，因此没有它的分页/循环导航/鼠标选择实现。
export class ExtensionSelectorComponent extends Container {
	// 保留原选项数组引用，不复制或保证名称唯一。
	private options: string[];
	// 初始选首项；空数组时之后向下可能变 -1，不单独修正为空状态。
	private selectedIndex = 0;
	// 候选文字的子容器，移动选中时清空重画。
	private listContainer: Container;
	// 确认回传所选字符串，空字符串因后面真值判断不会触发。
	private onSelectCallback: (option: string) => void;
	// 取消/倒计时共同调用的宿主函数。
	private onCancelCallback: () => void;
	// 可更新秒数的标题组件。
	private titleText: Text;
	// 不带倒计时的原标题。
	private baseTitle: string;
	// 可选 interval 所有者，宿主关闭时需 dispose。
	private countdown: CountdownTimer | undefined;
	// 函数类型与 undefined 的联合，括号确保它表示可缺函数，不是返回值可缺。
	private onToggleToolsExpanded: (() => void) | undefined;

	// 保存选项/回调→建标题/可选说明和倒计时→建列表/帮助→绘初始选择。
	// 例 ["Yes","No"] 默认第一项，按下移到 No；没有 options 时仍建空列表，确认不会回传有效值。
	// 构造可安装定时器和请求刷新，普通回调/样式错误传播；选择不自动保存、移除或 dispose。
	constructor(
		// 面板标题。
		title: string,
		// 显示顺序沿用该数组，原数组之后被外部修改也会影响后续重画。
		options: string[],
		// 确认时接非空选中字符串。
		onSelect: (option: string) => void,
		// 取消或到期通知。
		onCancel: () => void,
		// 额外说明、倒计时和工具展开回调可省略。
		opts?: ExtensionSelectorOptions,
	) {
		// 先建立父容器。
		super();

		// 保存数组引用而非 [...options] 副本。
		this.options = options;
		// 保存确认回调。
		this.onSelectCallback = onSelect;
		// 保存取消回调。
		this.onCancelCallback = onCancel;
		// 缺配置时保留 undefined，匹配动作仍会消费按键。
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;
		// 保存原标题用于每秒重建。
		this.baseTitle = title;

		// 上下分别添加动态边框，不直接绘屏。
		this.addChild(new DynamicBorder());
		// 在面板内容之间加一行空白。
		this.addChild(new Spacer(1));

		// 标题加粗并套强调色，左右留 1 列。
		this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		// 把同一标题实例加入容器，倒计时修改其文字。
		this.addChild(this.titleText);
		// 非空真值说明才展示，不做 Markdown 解析。
		if (opts?.description) {
			// 说明前加一行间距。
			this.addChild(new Spacer(1));
			// 普通前景色显示说明，左右各 1 列。
			this.addChild(new Text(theme.fg("text", opts.description), 1, 0));
		}
		// 在面板内容之间加一行空白。
		this.addChild(new Spacer(1));

		// 三个条件满足才启动；Infinity 虽通过 >0，但倒计时可能永不到期。
		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			// 构造立即 tick 更新标题，再安装每秒回调。
			this.countdown = new CountdownTimer(
				// 传毫秒输入，helper 内部 ceil 为秒。
				opts.timeout,
				// 计时器用此宿主请求重绘。
				opts.tui,
				// tick 每次从原标题重新拼秒数并加粗，避免重复尾缀。
				(s) => this.titleText.setText(theme.fg("accent", theme.bold(`${this.baseTitle} (${s}s)`))),
				// 到期只通知取消，面板实际关闭由宿主实现。
				() => this.onCancelCallback(),
			);
		}

		// 创建专门存候选 Text 的容器。
		this.listContainer = new Container();
		// 把候选区放在标题/说明之后。
		this.addChild(this.listContainer);
		// 在面板内容之间加一行空白。
		this.addChild(new Spacer(1));
		// 将下面的导航/确认/取消帮助加入布局。
		this.addChild(
			// 帮助是 Text，不会自行绑定键或触发选择。
			new Text(
				// 这里只显示原始上下箭头文案，实际还按配置匹配并额外支持 j/k。
				rawKeyHint("↑↓", "navigate") +
					// 两个空格分隔各动作提示。
					"  " +
					// 确认动作提示跟随共享配置。
					keyHint("tui.select.confirm", "select") +
					// 两个空格分隔各动作提示。
					"  " +
					// 取消动作提示同样读取配置。
					keyHint("tui.select.cancel", "cancel"),
				// 帮助水平左右各留 1 列。
				1,
				// 帮助上下不额外留白，外层 Spacer 统一处理。
				0,
			),
		);
		// 在面板内容之间加一行空白。
		this.addChild(new Spacer(1));
		// 上下分别添加动态边框，不直接绘屏。
		this.addChild(new DynamicBorder());

		// 按初始下标建立每一项文字，不发送选择回调。
		this.updateList();
	}

	// 清空候选区并为每个选项画一个 Text，选中项加箭头/强调色；例下标从 0 变 1 后重画箭头。
	// 显示全部选项，没有滚动窗口；只修改组件树，无返回值，样式/构造错误传播，不请求 TUI 绘制。
	private updateList(): void {
		// 移除上次候选 Text，避免每次导航重复堆积。
		this.listContainer.clear();
		// 按当前原数组顺序遍历所有项。
		for (let i = 0; i < this.options.length; i++) {
			// 只在当前下标对应位置显示选中样式。
			const isSelected = i === this.selectedIndex;
			// 三元选择有箭头的强调文字或普通缩进文字。
			const text = isSelected
				? // 选中箭头和正文都采用强调色。
					theme.fg("accent", "→ ") + theme.fg("accent", this.options[i])
				: // 未选中用两空格对齐，正文采用普通色。
					`  ${theme.fg("text", this.options[i])}`;
			// 每项左右留 1 列，长项可能自动折行，不保持固定一行高度。
			this.listContainer.addChild(new Text(text, 1, 0));
		}
	}

	// 按优先级处理展开工具→上/下导航→确认→取消，其余忽略；例 j 下移但在末项停住，不循环。
	// 只更新下标/组件树或同步通知宿主，错误传播；没有完成锁或自动 dispose，关闭/刷新由外层对话框流程处理。
	handleInput(keyData: string): void {
		// 每次输入读取当前共享配置。
		const kb = getKeybindings();
		// 工具展开动作优先，若与导航等共用键会先消费。
		if (kb.matches(keyData, "app.tools.expand")) {
			// 可选调用宿主展开逻辑；没有函数时本分支仍消费输入。
			this.onToggleToolsExpanded?.();
			// 配置的上移动作或额外固定 k 都上移，保留原有快捷输入。
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			// 向上最多到 0，不绕到末项。
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			// 重建所有候选 Text，不直接请求绘屏。
			this.updateList();
			// 配置的下移动作或固定 j 都下移。
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			// 向下最多末项；空数组长度 0 时这里可设为 -1。
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			// 重建所有候选 Text，不直接请求绘屏。
			this.updateList();
			// 确认动作或 LF 提交，导航分支优先于此分支。
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			// 取当前字符串，越界/空列表为 undefined。
			const selected = this.options[this.selectedIndex];
			// 只有真值字符串才回传；合法数组中的空字符串也会被跳过。
			if (selected) this.onSelectCallback(selected);
			// 以上都未命中才处理取消动作。
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			// 同步通知宿主，不在此移除自身或停止计时器。
			this.onCancelCallback();
		}
	}

	// 只停止可选倒计时，无返回值且可重复；例宿主收到选择/取消后调用，既不发取消也不移除 UI。
	dispose(): void {
		// 可选链忽略未配置计时器；计时器字段与标题仍保留。
		this.countdown?.dispose();
	}
}
