// 用显式毫秒时间测试滚轮行数转换，不读真实鼠标/时钟/平台，不移动终端；各用例回调无参数、正常返回 void，断言失败抛错。
// node:assert 提供数值/数组比较。
import assert from "node:assert";
// describe 注册分组，it 注册各场景回调。
import { describe, it } from "node:test";
// 导入真实有状态转换器，输入方向/时间，输出不带方向的正整数行数。
import { WheelScrollAccelerator } from "../src/wheel-scroll.ts";

// 批量喂时间给同一 accelerator，返回每次 next 的 number[]，会改该实例速度历史；例 [0,50] 在 auto/加速下得到 [1,2]，times 本身不改。
// direction:-1|1 是字面量联合，默认 1；TypeScript 限制调用写法，不在这里验证运行时数据。
function scroll(accelerator: WheelScrollAccelerator, times: number[], direction: -1 | 1 = 1): number[] {
	// map 依次传每个 time 给 next，保留顺序并返回行数数组；回调不读取 performance.now，测试可重现。
	return times.map((time) => accelerator.next(direction, time));
}

// #9758: fullscreen wheel scrolling was one line per notch on terminals that do not accelerate wheels.
// #9758 分组覆盖固定模式、自动模式、方向重置与小数结转；只在内存计算，不注册滚轮监听器。
describe("WheelScrollAccelerator", () => {
	// 固定行数例：时间快慢不影响 3 行，更新小数配置后至少仍为 1。
	it("uses fixed line counts regardless of timing", () => {
		// 第二参数显式 true，避免平台默认判断影响测试；固定数值路径本就不加速。
		const accelerator = new WheelScrollAccelerator(3, true);
		// 四个不等间隔事件都必须返回 3，deepStrictEqual 同时检顺序与数量。
		assert.deepStrictEqual(scroll(accelerator, [0, 10, 20, 1000]), [3, 3, 3, 3]);
		// 更新为 0.5 并清内部速度历史，此方法不滚动组件。
		accelerator.setLines(0.5);
		// 固定数值先 floor 再至少 1，因此不是返回 0。
		assert.strictEqual(accelerator.next(1, 2000), 1);
	});

	// 禁加速例：auto 配合 false 代表假定终端已加速，每事件只取 1 行。
	it("keeps one line per event in auto mode when the terminal already accelerates", () => {
		// 显式 false 绕过本机平台与 SSH 环境启发式。
		const accelerator = new WheelScrollAccelerator("auto", false);
		// 即使时间很密也都为 1；这些时间不会参与加速历史。
		assert.deepStrictEqual(scroll(accelerator, [0, 10, 20, 30]), [1, 1, 1, 1]);
	});

	// 速度例：用四组时间展示 150/50/20/10ms 间隔得到不同整数行数。
	it("scales auto mode with wheel velocity", () => {
		// auto,true 明确启用算法，不靠当前系统。
		const accelerator = new WheelScrollAccelerator("auto", true);
		// 150ms 大于参考 100ms，最小仍为 1。
		assert.deepStrictEqual(scroll(accelerator, [0, 150, 300, 450]), [1, 1, 1, 1]);
		// 与前组有长停顿，首事件重置为 1，随后 50ms 约 2 行。
		assert.deepStrictEqual(scroll(accelerator, [1000, 1050, 1100, 1150]), [1, 2, 2, 2]);
		// 新组 20ms 有效间隔约 5 行。
		assert.deepStrictEqual(scroll(accelerator, [2000, 2020, 2040, 2060]), [1, 5, 5, 5]);
		// 新组 10ms 算得速度更高，但 auto 基础上限为 6。
		assert.deepStrictEqual(scroll(accelerator, [3000, 3010, 3020, 3030]), [1, 6, 6, 6]);
	});

	// 密集突发例：3ms 间隔被视为一次轮齿/高分辨率突发，不给本层加速。
	it("does not accelerate bursts of events for a single notch", () => {
		// 创建独立实例，避免继承上一用例的平均间隔。
		const accelerator = new WheelScrollAccelerator("auto", true);
		// 全部间隔低于 5ms，所以每次 1；不代表被吞掉不滚动。
		assert.deepStrictEqual(scroll(accelerator, [0, 3, 6, 9]), [1, 1, 1, 1]);
	});

	// 重置例：换方向或长停顿开始新手势，第一事件回 1。
	it("resets acceleration on direction changes and pauses", () => {
		// 独立自动加速器。
		const accelerator = new WheelScrollAccelerator("auto", true);
		// 先用 20ms 同向事件建立每次 5 行的速度。
		assert.deepStrictEqual(scroll(accelerator, [0, 20, 40]), [1, 5, 5]);
		// 方向从默认正向改为 -1，返回的行数仍为正 1，不是 -1。
		assert.strictEqual(accelerator.next(-1, 60), 1);
		// 长停顿后先 1，再隔 20ms 恢复 5；辅助 scroll 使用默认正向。
		assert.deepStrictEqual(scroll(accelerator, [500, 520]), [1, 5]);
	});

	// 小数结转例：100/40=2.5，整数不足部分留给下次，不能每次都只 floor 成 2。
	it("carries fractional lines between events", () => {
		// 独立实例清除旧方向/小数。
		const accelerator = new WheelScrollAccelerator("auto", true);
		// 首事件 1，后续 2、3、2、3；本断言覆盖 carry 交替累计行为。
		assert.deepStrictEqual(scroll(accelerator, [0, 40, 80, 120, 160]), [1, 2, 3, 2, 3]);
	});
});
