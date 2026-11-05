// 将滚轮事件的时间间隔换成“本次滚几行”；TuiAltScreen 传 direction 和 performance.now()，再把返回的正数乘方向送给滚动视图。这里不读取鼠标、不移动内容、不请求重画。
/** Lines moved per mouse-wheel event, or `"auto"` to accelerate fast wheel spins. */
// 联合类型允许固定数值或字符串 "auto"；TypeScript 限制调用写法，运行时仍由 next 决定数字规范规则。
export type WheelScrollLines = number | "auto";

// Several events closer than this belong to one physical notch (Ghostty emits them ~4 ms apart)
// or come from a high-resolution source. They move one line each and do not accelerate.
// 相邻事件间隔严格小于 5 毫秒视作密集突发，每个只滚一行，不参与这一步加速平均。
const BURST_GAP_MS = 5;
// A pause longer than this ends a scroll gesture.
// 相邻事件间隔大于 200 毫秒就结束同一手势，等于 200 仍允许延续。
const GESTURE_GAP_MS = 200;
// Average event gap that maps to one line per event. Faster events scale up proportionally.
// 参考速度为每 100 毫秒一次；平均 50 毫秒对应约每次两行。
const REFERENCE_GAP_MS = 100;
// 自动加速的基础行数上限是 6，固定数值模式不受这个上限约束。
const MAX_AUTO_LINES = 6;

/**
 * Local macOS terminals receive wheel and trackpad deltas that the OS has already accelerated,
 * and they emit one event per line. Other platforms, and SSH sessions where the client platform
 * is unknown, usually send one event per wheel notch.
 */
// 按平台与 SSH 环境启发式判断终端是否已加速，无参数，返回 boolean；不探测硬件能力，不修改环境。
// 例：本地 macOS 且三个 SSH 变量都未定义时返回 true；空字符串也算变量已定义，因此仍按远程/未知处理。
function terminalAcceleratesWheel(): boolean {
	// 读取进程环境对象引用，不复制或打印环境内容。
	const env = process.env;
	// 下面所有逻辑与条件都满足才判为终端已加速。
	return (
		// 只对 macOS 采用本地终端已加速假设。
		process.platform === "darwin" &&
		// SSH_CONNECTION 必须没有定义，不是仅检查其真假值。
		env.SSH_CONNECTION === undefined &&
		// SSH_CLIENT 也必须未定义。
		env.SSH_CLIENT === undefined &&
		// SSH_TTY 同样要求未定义。
		env.SSH_TTY === undefined
	);
}

/**
 * Converts wheel events into line counts.
 *
 * In `"auto"` mode on terminals that do not accelerate wheel input, the count follows event
 * velocity: an isolated notch moves one line, while a fast spin moves up to six lines per event.
 * For example, notches 100 ms apart move 1 line each, 50 ms apart move 2, and 20 ms apart move 5.
 */
// 有状态的事件速度转换器；配置改变或方向/停顿结束手势时重置历史，返回值本身不带正负方向。
export class WheelScrollAccelerator {
	// 当前固定/自动行数配置，可通过 setLines 更新。
	private lines: WheelScrollLines;
	// 是否允许本层自动加速，readonly 仅限制 TypeScript 中重新赋值。
	private readonly accelerate: boolean;
	// 用负无穷表示还没发生事件，第一次 now-lastTime 为无穷，不能延续旧手势。
	private lastTime = Number.NEGATIVE_INFINITY;
	// 上次方向，初始化 0 与合法的 -1/1 区分。
	private lastDirection = 0;
	// 平滑后的间隔；undefined 表示尚无可用于加速的间隔样本。
	private averageGap: number | undefined;
	// 上次小数行的余量，留到之后事件累计，减少长期向下取整损失。
	private carry = 0;

	// 创建转换器，输入行数模式和可选加速开关，只保存配置，无显式返回语句。
	// 例：new WheelScrollAccelerator("auto", true) 按事件速度加速；缺省开关取环境启发式的反值。调用方也可能显式传固定 1，因此类默认 auto 不代表全屏模式一定启用 auto。
	constructor(lines: WheelScrollLines = "auto", accelerate = !terminalAcceleratesWheel()) {
		// 保存模式，不在构造时验证或计算事件速度。
		this.lines = lines;
		// 保存加速开关，构造后不会随环境变化自动重新判定。
		this.accelerate = accelerate;
	}

	// 替换行数模式并清除速度历史，无返回值，不产生滚动。例：setLines(3) 后下一次始终返回规范后的固定行数；即使配置相同也重置手势。
	setLines(lines: WheelScrollLines): void {
		// 先采用新配置。
		this.lines = lines;
		// 清空时间、方向、平均和小数余量，避免旧速度影响新设置。
		this.reset();
	}

	/** Return the positive line count for a wheel event in `direction` at time `now` (milliseconds). */
	// 给一次方向为 -1/1、时间为毫秒的事件计算正整数行数；会更新手势历史，不移动视图。
	// 流程先固定模式/禁加速提前返回，再按方向与时间判断手势，跳过超密突发，平滑间隔并累积小数。例：自动加速、间隔连续 40ms 时可依次返回 1、2、3、2；now 预期使用递增时钟，这里不校验时间倒退或 NaN。
	next(direction: -1 | 1, now: number): number {
		// 非 auto 就处理固定数值：有限数向下取整且至少为 1，NaN/Infinity 回退 1；提前返回不更新手势历史。
		if (this.lines !== "auto") return Number.isFinite(this.lines) ? Math.max(1, Math.floor(this.lines)) : 1;
		// 自动模式但关闭加速时也只返回 1，不计算时间。
		if (!this.accelerate) return 1;

		// 计算与上一事件的毫秒间隔。
		const gap = now - this.lastTime;
		// 方向相同且间隔不超过 200ms 才延续；没有额外验证 gap 非负。
		const sameGesture = direction === this.lastDirection && gap <= GESTURE_GAP_MS;
		// 记录本次时间，即使后面被判为突发事件也会更新。
		this.lastTime = now;
		// 记录本次方向。
		this.lastDirection = direction;
		// 首次、转向或长停顿都会开启新手势。
		if (!sameGesture) {
			// 新手势没有平均间隔。
			this.averageGap = undefined;
			// 清掉旧小数余量。
			this.carry = 0;
			// 新手势第一事件滚一行。
			return 1;
		}
		// 极短间隔事件只滚一行，但前面已更新 lastTime/lastDirection；不会清旧平均或 carry，也不在此继续累加它们。
		if (gap < BURST_GAP_MS) return 1;

		// 首个有效间隔直接采用，之后取“旧平均与新间隔”的均值，偏向近期，不是所有历史样本的算术平均。
		this.averageGap = this.averageGap === undefined ? gap : (this.averageGap + gap) / 2;
		// 按 100/平均间隔求速度倍率，夹在 1..6 后加上旧小数余量。
		const lines = Math.min(MAX_AUTO_LINES, Math.max(1, REFERENCE_GAP_MS / this.averageGap)) + this.carry;
		// 取整数部分作为本次行数。
		const whole = Math.floor(lines);
		// 小数部分留给下一次有效加速事件，正常数据下位于 [0,1)。
		this.carry = lines - whole;
		// 只返回正行数，方向由调用方另行相乘。
		return whole;
	}

	// 内部重置手势历史，无参数/返回值，不改当前模式和 accelerate。例：setLines 调用后第一次 auto 事件重新从一行开始。
	private reset(): void {
		// 重置时间哨兵。
		this.lastTime = Number.NEGATIVE_INFINITY;
		// 重置方向哨兵。
		this.lastDirection = 0;
		// 清除平均间隔记录。
		this.averageGap = undefined;
		// 清除未兑现的小数行。
		this.carry = 0;
	}
}
