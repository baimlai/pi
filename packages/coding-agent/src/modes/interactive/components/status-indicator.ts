// 把Loader动画适配为工作/重试/压缩/分支摘要状态，interactive-mode创建并负责替换销毁，custom-editor可把第一条正文嵌到边框；状态文字本身不执行这些业务。
import { type Component, Loader, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
// WorkingIndicatorOptions只描述可选帧/间隔，与Loader配置兼容；import type不加载扩展实现。
import type { WorkingIndicatorOptions } from "../../../core/extensions/index.ts";
// 共享theme提供默认颜色，倒计时只更新重试文案，keyText读取当前取消动作文字。
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { keyText } from "./keybinding-hints.ts";

// 四种字符串字面量组成联合类型，用于宿主识别状态；没有自动状态机转换。
export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary";

// 在Loader上增加kind及紧凑边框渲染；父类构造会刷新文字/启动动画，使用结束需dispose。
export class StatusIndicator extends Loader {
	// readonly限制kind在TS中重赋；kind不是远端业务当前状态的独立验证。
	readonly kind: StatusIndicatorKind;

	// 输入状态类别、宿主、两个颜色函数、文案及可选动画，构造可立即计时/请求重画；例working显示工作动画，不启动Agent请求。父类/回调失败会抛错。
	constructor(
		// 用合法类别标记这份显示对象。
		kind: StatusIndicatorKind,
		// 宿主负责安排真实终端绘制。
		ui: TUI,
		// 默认指示器着色回调，参数/返回均string。
		spinnerColorFn: (str: string) => string,
		// 消息着色回调，与指示器可不同色。
		messageColorFn: (str: string) => string,
		// 消息原文由Loader保存并按宽度折行。
		message: string,
		// 整个配置可省略；显式配置对象会让Loader帧按原样显示，不自动调用spinnerColorFn着色。
		indicator?: WorkingIndicatorOptions,
	) {
		// super先启动父类显示/可能的周期计时，再允许访问this。
		super(ui, spinnerColorFn, messageColorFn, message, indicator);
		// 保存显示类别，后面不会自动随消息改变。
		this.kind = kind;
	}

	// 返回可嵌进编辑器边框的一行文字，不改消息/定时器；例长消息只取正文首视觉行再截到width。父类排版或样式错误传播，不把所有折行拼回边框。
	renderInBorder(width: number): string {
		// 父类第0行是Loader额外空行，第1行是首正文；加2列补偿Text默认左右留白，无第1行时用空串。
		const line = super.render(width + 2)[1] ?? "";
		// 若确以普通空格开头去一位，再trimEnd去尾空白，按终端显示列截断；ANSI开头时不一定去掉内部左边距，不是统一剥样式。
		return truncateToWidth(line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(), width, "");
	}

	// 返回当前指示器的紧凑文字供极窄边框降级，例宽1只留能放下的动画；不附消息、不切帧或请求重画，颜色/宽度工具异常传播。
	renderSpinnerInBorder(width: number): string {
		// protected父类方法取得当前渲染帧，按显示列裁到width且不附省略号。
		return truncateToWidth(this.getRenderedIndicator(), width, "");
	}

	// 释放本指示器动画，返回void；例工作结束时调用，不取消业务、不清屏，也不发abort。
	dispose(): void {
		// 父类stop只清周期计时器，可重复调用，保留最后显示文字。
		this.stop();
	}
}

// 普通工作状态的默认外观，业务工作是否进行由宿主控制。
export class WorkingStatusIndicator extends StatusIndicator {
	// 输入宿主/消息/可选帧和统一颜色，构造并启动工作显示；例传自定义单帧可静态显示，结束后仍应dispose。颜色回调异常从父类传播。
	constructor(ui: TUI, message: string, indicator?: WorkingIndicatorOptions, colorFn?: (text: string) => string) {
		// 把通用配置转给状态基类。
		super(
			// 类别固定working。
			"working",
			// 沿用宿主TUI。
			ui,
			// 自定义颜色优先，否则指示器accent；箭头回调渲染时读取当前共享主题。
			colorFn ?? ((text) => theme.fg("accent", text)),
			// 同一自定义函数也用于消息，否则消息muted。
			colorFn ?? ((text) => theme.fg("muted", text)),
			// 消息原样交父类，不自动增加取消提示。
			message,
			// 动画配置传给Loader，可为空帧隐藏动画但仍留消息。
			indicator,
		);
	}
}

// 重试等待的显示类，同时有Loader切帧和CountdownTimer两个计时器；并不在倒计时到期时真正发起重试。
export class RetryStatusIndicator extends StatusIndicator {
	// 可选倒计时引用，到期/销毁时清空，类型提醒处理缺失。
	private countdown: CountdownTimer | undefined;

	// 构造重试文案并开倒计时，输入尝试次数/最大次数/延迟；例3000ms初显3s再逐tick降到0。只显示取消键，不接收取消输入，不校验次数/延迟有效性。
	constructor(ui: TUI, attempt: number, maxAttempts: number, delayMs: number) {
		// 局部文案函数捕获attempt/maxAttempts，每次调用重新读取中断键配置，返回文字，无业务重试。
		const retryMessage = (seconds: number) =>
			// 插入剩余秒和动作键，不把秒数当远端真正重试时间保证。
			`Retrying (${attempt}/${maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`;
		// 先启动基础Loader，接着才安装独立倒计时。
		super(
			// 类别retry，供宿主区分工作提示。
			"retry",
			// 同一宿主安排动画和倒计时刷新。
			ui,
			// 动画默认warning色。
			(spinner) => theme.fg("warning", spinner),
			// 消息muted色。
			(text) => theme.fg("muted", text),
			// 毫秒除1000向上取整；实际倒计时同规则，不是精确截止时刻计算。
			retryMessage(Math.ceil(delayMs / 1000)),
		);
		// 创建倒计时，构造里会立即调用一次onTick，再每秒定时更新。
		this.countdown = new CountdownTimer(
			// 延迟按毫秒输入，不设置网络/Agent重试策略。
			delayMs,
			// 倒计时也可请求相同TUI重画。
			ui,
			// tick回调接显示秒数，无返回结果。
			(seconds) => {
				// 更新Loader消息并请求重画；CountdownTimer随后也会请求重画，不在此去重。
				this.setMessage(retryMessage(seconds));
			},
			// 到期回调仅清引用，不发起重试，也不自动停止Loader动画。
			() => {
				// 倒计时自身先dispose，这里标记不再持有活动倒计时对象。
				this.countdown = undefined;
			},
		);
	}

	// 重写销毁：停倒计时、清引用，再停父动画；返回void。例切回工作状态后不会继续刷新旧重试文字；不取消实际请求。
	override dispose(): void {
		// 可选调用，让已到期/重复dispose也正常处理。
		this.countdown?.dispose();
		// 移除倒计时引用，不再依赖它的内部状态。
		this.countdown = undefined;
		// super.dispose停止Loader动画，不发abort。
		super.dispose();
	}
}

// 压缩原因的三值联合：手动、到阈值、上下文溢出，影响文案而不是此处压缩算法。
export type CompactionStatusReason = "manual" | "threshold" | "overflow";

// 压缩时的状态外观；真正摘要请求和取消在会话层处理。
export class CompactionStatusIndicator extends StatusIndicator {
	// 按压缩原因选择文案并开Loader，返回新实例；例overflow多显示检测到溢出，threshold走自动提示。可统一颜色，不在构造时执行压缩或注册取消键。
	constructor(ui: TUI, reason: CompactionStatusReason, colorFn?: (text: string) => string) {
		// 读取app.interrupt当前键位，只生成取消提示。
		const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
		// 本地label按三元分支选择说明。
		const label =
			// manual才采用手动压缩文案。
			reason === "manual"
				? // 手动分支包含取消键提示。
					`Compacting context... ${cancelHint}`
				: // 其余为自动；仅overflow再加溢出前缀，threshold不加。
					`${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
		// 用通用状态基类启动显示。
		super(
			// 类别固定compaction。
			"compaction",
			// 传宿主TUI。
			ui,
			// 可选统一颜色优先，否则默认动画accent。
			colorFn ?? ((spinner) => theme.fg("accent", spinner)),
			// 消息默认muted，统一颜色存在时两者相同。
			colorFn ?? ((text) => theme.fg("muted", text)),
			// 传已生成文案，不包含模型上下文正文。
			label,
		);
	}
}

// 分支摘要状态外观；不遍历会话分支，也不请求模型。
export class BranchSummaryStatusIndicator extends StatusIndicator {
	// 构造并启动默认摘要显示，输入TUI；例导航分支时显示Summarizing提示，完成需宿主dispose，颜色回调/父类异常传播。
	constructor(ui: TUI) {
		// 复用基础Loader启动和清理方式。
		super(
			// 类别branchSummary。
			"branchSummary",
			// 宿主负责重画。
			ui,
			// 动画accent色。
			(spinner) => theme.fg("accent", spinner),
			// 消息muted色。
			(text) => theme.fg("muted", text),
			// 当前中断键只显示在文案里，实际按键取消由宿主路由。
			`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
		);
	}
}

// 空闲占位组件，保留两行高度方便状态区稳定，不启动动画或计时器。
export class IdleStatus implements Component {
	// 无缓存的失效接口，返回void；例宿主统一失效组件时无需特殊处理，不直接请求绘制。
	invalidate(): void {
		// No cached state to invalidate.
	}

	// 返回两行指定宽度的空格，无副作用；例width20两行各20空格。number不保证有效宽度，repeat对负数/Infinity等可抛错，小数按JS规则处理。
	render(width: number): string[] {
		// 一次构造空白字符串供两行共用，字符串不可变无需复制。
		const emptyLine = " ".repeat(width);
		// 两个数组项提供占位高度，不是两次业务状态更新。
		return [emptyLine, emptyLine];
	}
}
