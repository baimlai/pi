/**
 * Reusable countdown timer for dialog components.
 */

// 对话框/重试状态复用的显示倒计时；外层传tick与到期动作，本类只递减秒数并按需通知TUI重画，不自动中断请求。type导入只描述宿主接口。
import type { TUI } from "@earendil-works/pi-tui";

// 实例持有一个setInterval；用完需dispose，不会通过垃圾回收自动取消计时器。
export class CountdownTimer {
	// ReturnType<typeof setInterval>取得计时器返回类型，联合undefined表示尚未设置/已清理。
	private intervalId: ReturnType<typeof setInterval> | undefined;
	// 显示的剩余秒数，逐tick减1，不按Date.now重新计算真实截止时间。
	private remainingSeconds: number;
	// 可没有TUI，例如只消费onTick的宿主；可选链在更新时跳过重画。
	private tui: TUI | undefined;
	// 每次接收显示秒数的同步回调，构造里也会调用一次。
	private onTick: (seconds: number) => void;
	// 到期后的同步动作由调用方决定；可以清引用/关闭对话框，不等于本类必做这些事。
	private onExpire: () => void;

	// 保存回调→毫秒向上取整成秒→立即tick→每1000ms减1，到<=0先停再到期通知。例1500ms显示2、1、0，正常调度约2秒到期；0/负值也等第一次tick，未验证NaN/Infinity，回调异常不在这里吞掉。
	constructor(timeoutMs: number, tui: TUI | undefined, onTick: (seconds: number) => void, onExpire: () => void) {
		// 保存可选重画宿主引用。
		this.tui = tui;
		// 保存每步更新函数，不复制宿主状态。
		this.onTick = onTick;
		// 保存到期函数，稍后条件满足才调用。
		this.onExpire = onExpire;
		// Math.ceil向上取整；这份数值在每个interval回调里递减，不会补偿事件循环延迟。
		this.remainingSeconds = Math.ceil(timeoutMs / 1000);
		// 初值立即通知；本行不单独requestRender，onTick可自行刷新。若抛错，构造终止，后面还没安装计时器。
		this.onTick(this.remainingSeconds);

		// 安装每秒回调并保存句柄；未调用unref，所以使用后需清理以免持续占着事件循环。
		this.intervalId = setInterval(() => {
			// 每次tick只减1，调度延迟几秒也不会一次扣对应几秒。
			this.remainingSeconds--;
			// 先通知新的数字，即使已经0/负数；回调抛错会跳过后面的重画/到期检查。
			this.onTick(this.remainingSeconds);
			// 有宿主才请求重画，宿主回调异常同样会阻断下面检查。
			this.tui?.requestRender();

			// 只在tick之后判到期，不在构造刚得初值时立刻判；NaN永远不满足，Infinity递减仍Infinity。
			if (this.remainingSeconds <= 0) {
				// 先清计时器，让正常到期只触发一次onExpire。
				this.dispose();
				// 调用到期动作，不等待异步返回；函数类型void不承诺动作本身不会抛错。
				this.onExpire();
			}
			// 1000是interval间隔毫秒，Node调度不保证精确墙钟秒。
		}, 1000);
	}

	// 清理周期任务，返回void，可重复调用；例用户提前关对话框时dispose，不会触发onExpire或改变remainingSeconds，也不发取消信号。
	dispose(): void {
		// 句柄truthy才需要清理，未安装/已清理直接结束。
		if (this.intervalId) {
			// 移除以后尚未执行的周期tick，无法撤销已执行的回调副作用。
			clearInterval(this.intervalId);
			// 标成undefined，后面重复dispose无需再clear。
			this.intervalId = undefined;
		}
	}
}
