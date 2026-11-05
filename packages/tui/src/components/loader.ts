// Loader 在 Text 的文字渲染之上增加定时切帧和重画请求；构造就会启动，调用方结束使用后需 stop。
// TUI 仅作为编译期类型导入；实例负责安排真正的终端绘制。
import type { TUI } from "../tui.ts";
// 复用 Text 的折行、边距和缓存实现。
import { Text } from "./text.ts";

// 动画外观配置的接口；只在编译期约束字段，运行时的默认处理写在 setIndicator 中。
export interface LoaderIndicatorOptions {
	/** Animation frames. Use an empty array to hide the indicator. */
	// 可选帧数组，每项是一帧字符串；[] 表示隐藏指示器，单帧表示静态显示。
	frames?: string[];
	/** Frame interval in milliseconds for animated indicators. */
	// 可选切帧间隔，单位毫秒；这里声明为 number，不保证它为有限正数。
	intervalMs?: number;
}

// 默认十帧点字动画；常量绑定不可重赋值，数组本身并没有被冻结。
const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// 未配置有效正间隔时使用 80 毫秒。
const DEFAULT_INTERVAL_MS = 80;

/**
 * Loader component that updates with an optional spinning animation.
 */
// 继承 Text 的文字行为；自己的定时器只改变显示字符串并请求重画，不代表任何业务操作已完成。
export class Loader extends Text {
	// ... 复制默认数组，避免当前实例直接复用并修改默认数组容器。
	private frames = [...DEFAULT_FRAMES];
	// 当前间隔，初始化为默认值，setIndicator 可覆盖。
	private intervalMs = DEFAULT_INTERVAL_MS;
	// 当前帧下标，从第一帧开始。
	private currentFrame = 0;
	// Node 的计时器句柄或 null；联合类型提醒 stop 处理未启动状态。
	private intervalId: NodeJS.Timeout | null = null;
	// 保存重画宿主引用；字段初始为 null，构造时才赋值。
	private ui: TUI | null = null;
	// 是否原样使用帧字符串；显式传 indicator 对象后不再自动调用旋转符号着色函数。
	private renderIndicatorVerbatim = false;
	// 输入帧文字并返回带样式文字的函数；private 是编译期访问限制。
	private spinnerColorFn: (str: string) => string;
	// 消息着色回调，更新显示时会实际执行。
	private messageColorFn: (str: string) => string;
	// 保存消息原文，不是已经着色后的文本。
	private message: string = "Loading...";

	// 创建并立即启动加载显示；参数是宿主、两种着色函数、消息和可选帧配置，无返回值。
	// 例：new Loader(ui, cyan, dim, "读取中") 会请求重画，默认多帧还会安装定时器；回调抛错会向上传播。结束后 stop()，不然定时器可能继续让进程保持运行。
	constructor(
		// ui 参数提供 requestRender，由宿主安排实际绘制。
		ui: TUI,
		// spinnerColorFn 处理默认指示器的样式。
		spinnerColorFn: (str: string) => string,
		// messageColorFn 处理消息样式。
		messageColorFn: (str: string) => string,
		// 不传消息时使用默认字符串；默认参数是在调用时选择的值。
		message: string = "Loading...",
		// ? 表示可省略整个配置对象；传 {} 与不传在自动着色行为上不同。
		indicator?: LoaderIndicatorOptions,
	) {
		// 先构造父类：空原文、左右各 1 列、上下 0 行；子类之后自己额外添加上方空行。
		super("", 1, 0);
		// 保存宿主，不在这一行请求绘制。
		this.ui = ui;
		// 保存指示器着色回调引用。
		this.spinnerColorFn = spinnerColorFn;
		// 保存消息着色回调引用。
		this.messageColorFn = messageColorFn;
		// 保存消息原文。
		this.message = message;
		// 设置帧并调用 start：这一步就会更新显示、请求重画，并按需启动动画，不是被动注册。
		this.setIndicator(indicator);
	}

	// 给加载文本上方添加一个空行，输入宽度后返回行数组，无终端写入。例：即使父类返回 []，这里仍返回 [""]；父类渲染异常向上传播。
	render(width: number): string[] {
		// super.render 调用 Text 的实现，... 展开其行；总是在最前面多放一个空字符串行。
		return ["", ...super.render(width)];
	}

	// 刷新当前帧并重新安排动画，无参数、无返回值；重复 start 不会累加多个本实例计时器。
	// 例：stop 后 start 会从保存的帧下标继续；只有 setIndicator 会把下标重置为 0。
	start(): void {
		// 立即生成当前显示文本并请求宿主重画。
		this.updateDisplay();
		// 停止旧计时器，再根据帧数决定是否安装新的。
		this.restartAnimation();
	}

	// 停止本实例的动画计时器，无参数、无返回值；不隐藏文字、不取消业务请求、不触发重画。例：业务完成后 stop() 清理动画。
	stop(): void {
		// 仅在存在句柄时清理，重复 stop 可直接结束。
		if (this.intervalId) {
			// clearInterval 阻止后续周期切帧。
			clearInterval(this.intervalId);
			// 把句柄设回 null，表示当前没有计时器。
			this.intervalId = null;
		}
	}

	// 替换消息并立即更新显示，无返回值；即使消息相同也会请求宿主重画。例：setMessage("已处理 3 项") 不改变帧配置或重启动画。
	setMessage(message: string): void {
		// 保存新消息原文。
		this.message = message;
		// 沿用当前帧生成显示文本。
		this.updateDisplay();
	}

	// 重写缓存失效方法：先清 Text 缓存，再重建显示并请求重画，无返回值。
	// 例：主题改变后 invalidate 使着色回调重新执行；override 由 TypeScript 检查父类确有该方法，不会自动重启动画。
	override invalidate(): void {
		// 调用父类清除文字渲染缓存。
		super.invalidate();
		// 重新调用着色函数并安排重画，计时器状态保持不变。
		this.updateDisplay();
	}

	// 替换帧与间隔后从第 0 帧重新启动，无返回值；即使之前 stop 过也会再次启动。
	// 例：setIndicator({frames: ["."]}) 显示静态点，{frames: []} 隐藏指示器但仍显示消息；传配置对象时帧按原样使用，不经过 spinnerColorFn。
	setIndicator(indicator?: LoaderIndicatorOptions): void {
		// 显式提供对象就启用原样帧模式，包括空对象 {}；undefined 才沿用默认着色模式。
		this.renderIndicatorVerbatim = indicator !== undefined;
		// ?. 在对象缺省时得到 undefined；显式帧数组复制一份，否则复制默认数组，避免保留外部数组容器。
		this.frames = indicator?.frames !== undefined ? [...indicator.frames] : [...DEFAULT_FRAMES];
		// 间隔需为 truthy 且大于 0 才采用，否则回退默认值；并未检查有限性，实际 setInterval 仍按 Node 的规则处理数值。
		this.intervalMs = indicator?.intervalMs && indicator.intervalMs > 0 ? indicator.intervalMs : DEFAULT_INTERVAL_MS;
		// 配置变化后从第一帧重来。
		this.currentFrame = 0;
		// 立即刷新显示，并停止旧计时器、按新配置决定是否创建计时器。
		this.start();
	}

	// 内部重新安装动画，无参数、无返回值；先 stop，零或单帧不计时，多帧按间隔轮换。
	// 例：换成一帧会清掉先前的动画；回调只更新显示，Node 定时调度不保证精确毫秒间隔。
	private restartAnimation(): void {
		// 确保本实例不会同时保留两个周期计时器。
		this.stop();
		// 空帧不需要动画，单帧显示固定符号，也不需要计时器。
		if (this.frames.length <= 1) {
			// 提前返回，不创建句柄。
			return;
		}
		// 注册周期回调并保存句柄；这个回调之后才由计时器执行，不是注册时就切到下一帧。
		this.intervalId = setInterval(() => {
			// 每次 tick 加一并对帧数取余，从最后一帧循环回第一帧。
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			// 用新下标刷新消息文本并请求重画；回调异常在这里没有被捕获。
			this.updateDisplay();
			// 间隔参数作为 setInterval 的第二个参数；没有调用 unref，使用后需 stop 清理。
		}, this.intervalMs);
	}

	// 取得本次指示器字符串，无参数；protected 允许子类定制，不改帧下标。
	// 例：默认帧先经过 spinnerColorFn，自定义配置则原样返回；着色回调可能抛错。
	protected getRenderedIndicator(): string {
		// ?? 在帧不存在时提供空字符串，不把合法的 "" 当成缺失。
		const frame = this.frames[this.currentFrame] ?? "";
		// 原样模式直接返回帧，否则调用指示器着色函数。
		return this.renderIndicatorVerbatim ? frame : this.spinnerColorFn(frame);
	}

	// 生成完整文字并请求宿主重画，无参数、无返回值；顺序是取指示器、拼消息、更新 Text、通知宿主。
	// 例：帧为 "."、消息为 "读取中" 时组成 ". 读取中" 后再由 Text 折行；回调错误向上传播，不会在此被吞掉。
	private updateDisplay(): void {
		// 通过可重写方法获得当前帧的最终样式字符串。
		const renderedFrame = this.getRenderedIndicator();
		// 字符串长度大于 0 才附加分隔空格；这里不是可见列宽判断，仅含 ANSI 的字符串也会满足条件。
		const indicator = renderedFrame.length > 0 ? `${renderedFrame} ` : "";
		// 模板字符串插入指示器与着色消息，再调用父类 setText；文本完全相同时父类可保留折行缓存。
		this.setText(`${indicator}${this.messageColorFn(this.message)}`);
		// 宿主引用已存在时才发出通知。
		if (this.ui) {
			// 请求一次后续绘制，由 TUI 安排执行；这不是直接把文本写入终端。
			this.ui.requestRender();
		}
	}
}
