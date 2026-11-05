/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是流式工作指示器。
 * 上游：session_start 时应用初始模式；用户输入 /working-indicator 命令切换模式。
 * 下游：ctx.ui.setWorkingIndicator(options) 配置流式期间显示的小动画，
 * ctx.ui.setStatus() 在页脚展示当前模式。不写文件、不发网络请求、不调用模型。
 *
 * 演示的机制：WorkingIndicatorOptions 有 frames（每个元素的字符串既可能是单个字符，也
 * 可以带 ANSI 颜色）和 intervalMs（换帧间隔）；frames: [] 完全隐藏指示器，省略参数则
 * 恢复 pi 默认动画。示例自己写 ANSI 真彩色序列，因为自定义帧不会自动上色。
 *
 * 能力清单：
 * - WorkingIndicatorMode：五种模式（dot/none/pulse/spinner/default）的联合类型。
 * - SPINNER_FRAMES、PASTEL_RAINBOW、RESET_FG：盲文帧、淡彩虹前景色、恢复默认前景色。
 * - HIDDEN_INDICATOR：frames 为空数组的“隐藏”配置。
 * - colorize(text, color)：给文字包上颜色与复位序列。
 * - getIndicator(mode)：把模式映射为 WorkingIndicatorOptions 或 undefined。
 * - describeMode(mode)：把模式映射为人类可读描述。
 * - 默认导出：注册启动监听和 /working-indicator 命令。
 *
 * 典型运行顺序：加载扩展 -> 页脚显示当前模式 -> 输入 /working-indicator pulse ->
 * 流式时显示自定义脉冲动画；输入 /working-indicator reset 恢复 pi 默认。
 *
 * 示例（真实签名）：
 *   ctx.ui.setWorkingIndicator({ frames: ["●"], intervalMs: 120 });
 *   单帧数组是静态圆点；不带参数调用则恢复默认。
 *
 * 建议阅读顺序：先看类型与常量，再看 getIndicator 的 switch，最后看命令参数校验与
 * applyIndicator。
 *
 * 前置条件：交互式 TUI 会话；无 UI 时设置不显示但不报错。
 */

/**
 * Working Indicator Extension
 *
 * Demonstrates `ctx.ui.setWorkingIndicator()` for customizing the inline
 * working indicator shown while pi is streaming a response.
 *
 * Usage:
 *   pi --extension examples/extensions/working-indicator.ts
 *
 * Commands:
 *   /working-indicator           Show current mode
 *   /working-indicator dot       Use a static dot indicator
 *   /working-indicator pulse     Use a custom animated indicator
 *   /working-indicator none      Hide the indicator entirely
 *   /working-indicator spinner   Restore an animated spinner
 *   /working-indicator reset     Restore pi's default spinner
 */

import type { ExtensionAPI, ExtensionContext, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";

// 五种模式的字符串联合；"default" 表示恢复 pi 默认，不对应自定义帧。
type WorkingIndicatorMode = "dot" | "none" | "pulse" | "spinner" | "default";

// 盲文帧素材；spinner 模式会把每个帧映射到一种淡彩色。
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// 六个 24 位真彩色前景色（38;2;R;G;B）；数组元素是完整转义序列字符串。
const PASTEL_RAINBOW = [
	"\x1b[38;2;255;179;186m",
	"\x1b[38;2;255;223;186m",
	"\x1b[38;2;255;255;186m",
	"\x1b[38;2;186;255;201m",
	"\x1b[38;2;186;225;255m",
	"\x1b[38;2;218;186;255m",
];
// 39m 只恢复默认前景色，不重置粗体等其他 SGR 属性。
const RESET_FG = "\x1b[39m";
// 空 frames 是官方约定的“隐藏指示器”写法；显式标注类型确保字段形状正确。
const HIDDEN_INDICATOR: WorkingIndicatorOptions = {
	frames: [],
};

// 给一段文字包上颜色和复位序列；输入输出都是普通字符串，不解析 ANSI。
function colorize(text: string, color: string): string {
	return `${color}${text}${RESET_FG}`;
}

// 把模式映射为设置对象；default 返回 undefined，表示“省略参数以恢复默认”。
function getIndicator(mode: WorkingIndicatorMode): WorkingIndicatorOptions | undefined {
	// switch 覆盖联合的每个成员；TypeScript 能检查是否遗漏，但没有运行时穷尽断言。
	switch (mode) {
		case "dot":
			return {
				frames: [colorize("●", PASTEL_RAINBOW[0])],
			};
		case "none":
			return HIDDEN_INDICATOR;
		case "pulse":
			// 四帧由小到大再缩小，120ms 一帧形成脉冲效果。
			return {
				frames: [
					colorize("·", PASTEL_RAINBOW[0]),
					colorize("•", PASTEL_RAINBOW[2]),
					colorize("●", PASTEL_RAINBOW[4]),
					colorize("•", PASTEL_RAINBOW[5]),
				],
				intervalMs: 120,
			};
		case "spinner":
			// 每帧取数组中不同颜色；取模避免索引越界，! 是开发者知道元素一定存在的非空断言。
			return {
				frames: SPINNER_FRAMES.map((frame, index) =>
					colorize(frame, PASTEL_RAINBOW[index % PASTEL_RAINBOW.length]!),
				),
				intervalMs: 80,
			};
		case "default":
			// undefined 传给 setWorkingIndicator 表示恢复内置默认动画。
			return undefined;
	}
}

// 生成给用户看的模式名；同样由 switch 覆盖所有模式。
function describeMode(mode: WorkingIndicatorMode): string {
	switch (mode) {
		case "dot":
			return "static dot";
		case "none":
			return "hidden";
		case "pulse":
			return "custom pulse";
		case "spinner":
			return "custom spinner";
		case "default":
			return "pi default spinner";
	}
}

// 扩展入口：mode 是闭包里的当前模式，初始为 5 帧慢速旋转。
export default function (pi: ExtensionAPI) {
	// 默认 spinner；用户命令会修改它。
	let mode: WorkingIndicatorMode = "spinner";

	// 把当前模式同时应用到工作指示器和页脚状态，供启动与命令复用。
	const applyIndicator = (ctx: ExtensionContext) => {
		// getIndicator 可能返回 undefined（default），这正是恢复默认所需的参数。
		ctx.ui.setWorkingIndicator(getIndicator(mode));
		// 页脚状态使用 dim 颜色，显示模式的中文/英文描述。
		ctx.ui.setStatus("working-indicator", ctx.ui.theme.fg("dim", `Indicator: ${describeMode(mode)}`));
	};

	// 每次会话启动都重新应用，避免宿主重建 UI 后丢失设置。
	pi.on("session_start", async (_event, ctx) => {
		applyIndicator(ctx);
	});

	// /working-indicator：无参数查询，带参数切换；非法参数只提示用法。
	pi.registerCommand("working-indicator", {
		description: "Set the streaming working indicator: dot, pulse, none, spinner, or reset.",
		handler: async (args, ctx) => {
			// 去空白并转小写，使 "DOT" 也能匹配；结果类型仍是 string。
			const nextMode = args.trim().toLowerCase();
			// 空参数表示查询当前模式。
			if (!nextMode) {
				ctx.ui.notify(`Working indicator: ${describeMode(mode)}`, "info");
				return;
			}

			// 手动枚举合法值，因为 nextMode 的静态类型只是 string，不能直接赋给联合类型。
			if (
				nextMode !== "dot" &&
				nextMode !== "none" &&
				nextMode !== "pulse" &&
				nextMode !== "spinner" &&
				nextMode !== "reset"
			) {
				ctx.ui.notify("Usage: /working-indicator [dot|pulse|none|spinner|reset]", "error");
				return;
			}

			// reset 在对外词汇里叫 reset，内部模式叫 default；三元表达式完成映射。
			mode = nextMode === "reset" ? "default" : nextMode;
			applyIndicator(ctx);
			ctx.ui.notify(`Working indicator set to: ${describeMode(mode)}`, "info");
		},
	});
}
