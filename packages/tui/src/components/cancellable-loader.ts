// 在 Loader 动画上增加可供业务观察的取消信号；按键入口由宿主调用，异步任务仍须主动接收或转发 signal。
// 这里读取可配置按键动作，而不是把取消固定绑定到某个按键字节。
import { getKeybindings } from "../keybindings.ts";
// 继承动画、文本及构造参数；构造父类时就会启动显示，销毁时只在本类 dispose 中停止动画。
import { Loader } from "./loader.ts";

/**
 * Loader that can be cancelled with Escape.
 * Extends Loader with an AbortSignal for cancelling async operations.
 *
 * @example
 * const loader = new CancellableLoader(tui, cyan, dim, "Working...");
 * loader.onAbort = () => done(null);
 * doWork(loader.signal).then(done);
 */
// 没有显式 constructor 时使用继承的构造参数；super 完成后才初始化本类字段。取消不等于强制中断任意 Promise。
export class CancellableLoader extends Loader {
	// 每个实例创建一个控制器；abort 后不重建，因此同一实例的取消状态不会自动复位。
	private abortController = new AbortController();

	/** Called when user presses Escape */
	// 可选的同步通知函数，无参数、无返回值；使用方自行挂接收尾逻辑，反复按取消会反复调用它。
	onAbort?: () => void;

	/** AbortSignal that is aborted when user presses Escape */
	// 只读访问器，返回本实例稳定的 AbortSignal，不创建新信号。例：把 loader.signal 交给支持取消的 doWork，任务自己响应 abort；读取本身无副作用。
	get signal(): AbortSignal {
		// 暴露控制器的信号，不暴露控制器本身，外部通过该属性不能直接调用 abort。
		return this.abortController.signal;
	}

	/** Whether the loader was aborted */
	// 只读访问器，返回是否已经发出取消，无副作用。例：首次取消后为 true，后续 start 动画不会把它改回 false。
	get aborted(): boolean {
		// 读取控制器信号的 aborted 标志。
		return this.abortController.signal.aborted;
	}

	// 处理宿主传入的按键数据，无返回值；匹配取消动作时先 abort，再同步通知 onAbort，不匹配则不操作。
	// 例：默认常用 Escape，也可以由键位配置改变；不停止动画、不移除组件。onAbort 抛错向上传播，任务是否中止取决于它是否观察信号。
	handleInput(data: string): void {
		// 每次取当前键位配置，使运行中的配置变化也有机会被采用。
		const kb = getKeybindings();
		// 按配置动作匹配输入，而不是直接比较固定的 Escape 字符。
		if (kb.matches(data, "tui.select.cancel")) {
			// 通知所有观察此 signal 的任务；重复 abort 不会重置或创建新信号。
			this.abortController.abort();
			// ?.() 表示存在才调用；没有检查 aborted，所以重复取消按键仍会重复调用回调。
			this.onAbort?.();
		}
	}

	// 释放动画资源，无参数、无返回值；只调用父类 stop，不 abort 信号、不清理用户回调。例：正常完成时 dispose 可停动画而不把任务标成已取消。
	dispose(): void {
		// 停止计时器，当前显示文字与已取消状态都保留。
		this.stop();
	}
}
