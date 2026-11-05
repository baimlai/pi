// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列中的浮层 UI 测试示例。
// 作用：注册一组 /overlay-* 命令，用真实终端手动检查浮层（overlay）的锚点、边距、堆叠、宽度溢出、
//   百分比定位、maxHeight、响应式可见性、显示/隐藏、焦点循环、非捕获浮层与流式重绘。
// 上游：`pi --extension ./examples/extensions/overlay-qa-tests.ts` 加载；用户在 TUI 中输入命令触发 handler。
// 下游：ctx.ui.custom 以 overlay: true 显示组件；组件实现 Component.handleInput/render，返回给 pi-tui 渲染；
//   部分命令用 child_process.spawn 生成假流式输出。测试本身不写文件、不发网络。
// 能力：
//   默认导出函数                     注册 13 个 /overlay-* 命令。
//   sleep()                          可 await 的延时辅助。
//   BaseOverlay                      提供主题和画框的抽象基类。
//   AnchorTestComponent              九个锚点循环。
//   MarginTestComponent              margin/offset 循环。
//   StackOverlayComponent            三层堆叠浮层。
//   StreamingOverflowComponent       真实子进程长行/ANSI 输出与滚动。
//   EdgeTestComponent                终端边缘定位。
//   PercentTestComponent             百分比 row/col。
//   MaxHeightTestComponent           超出 maxHeight 的截断。
//   SidepanelComponent               百分比宽度与 visible 回调。
//   AnimationDemoComponent           ~30 FPS 动画与 FPS 计数。
//   ToggleDemoComponent              OverlayHandle.setHidden 显示/隐藏。
//   PassiveDemoController            nonCapturing 浮层与输入计数。
//   TimerPanel                       非捕获浮层里的计时器。
//   FocusDemoController/FocusPanel   多浮层焦点循环、输入路由、逐个关闭。
//   StreamingInputController/Panel   多个输入面板 + 模拟流式输出。
//   hslToRgb()                      动画颜色循环用的 HSL→RGB 转换。
// 典型顺序：加载 -> /overlay-anchors 等命令 -> ctx.ui.custom 等待 done -> 组件按键结束 -> handler 提示结果。
// 运行：加载后用命令列表逐个执行；按 Esc 关闭，部分命令用 Space/→ 切换。
// 阅读顺序：先看默认导出了解命令清单，再看 BaseOverlay，最后按需阅读某一个测试组件；组件之间结构相似。

/**
 * Overlay QA Tests - comprehensive overlay positioning and edge case tests
 *
 * Usage: pi --extension ./examples/extensions/overlay-qa-tests.ts
 *
 * Commands:
 *   /overlay-animation  - Real-time animation demo (~30 FPS, proves DOOM-like rendering works)
 *   /overlay-anchors    - Cycle through all 9 anchor positions
 *   /overlay-margins    - Test margin and offset options
 *   /overlay-stack      - Test stacked overlays
 *   /overlay-overflow   - Test width overflow with streaming process output
 *   /overlay-edge       - Test overlay positioned at terminal edge
 *   /overlay-percent    - Test percentage-based positioning
 *   /overlay-maxheight  - Test maxHeight truncation
 *   /overlay-sidepanel  - Responsive sidepanel (hides when terminal < 100 cols)
 *   /overlay-toggle     - Toggle visibility demo (demonstrates OverlayHandle.setHidden)
 *   /overlay-passive    - Non-capturing overlay demo (passive info panel alongside active overlay)
 *   /overlay-focus      - Focus cycling, input routing, dismissal, and rendering order with overlays
 *   /overlay-streaming  - Multiple input panels with simulated streaming (Tab to cycle focus)
 */

// ExtensionCommandContext 比普通上下文多命令安全方法；Theme 供组件颜色函数使用，均为类型导入。
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
// OverlayAnchor 限制九个锚点值；TUI 提供 showOverlay/requestRender 等能力。
import type { Component, OverlayAnchor, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
// Input 是内置单行输入组件；matchesKey 按配置匹配按键；truncateToWidth/visibleWidth 处理 ANSI 宽度。
import { Input, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
// spawn 异步启动子进程，用于演示连续流式输出，不阻塞事件循环。
import { spawn } from "child_process";

// Global handle for toggle demo (in real code, use a more elegant pattern)
// 模块级变量保存当前浮层句柄；组件按键时通过它调用 setHidden。null 表示没有活动浮层。
let globalToggleHandle: OverlayHandle | null = null;

// 扩展入口。输入：宿主 ExtensionAPI；输出：无；副作用是注册一批命令（注册时不创建浮层）。
// 示例：输入 /overlay-toggle 后按 t，浮层隐藏一秒再出现。
export default function (pi: ExtensionAPI) {
	// Animation demo - proves overlays can handle real-time updates (like pi-doom would need)
	// 命令 handler 接收参数和命令上下文；_args 未使用。ctx.ui.custom<void> 表示不返回数据，
	// 组件通过 done() 关闭；overlayOptions 交给宿主定位。
	pi.registerCommand("overlay-animation", {
		description: "Test real-time animation in overlay (~30 FPS)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new AnimationDemoComponent(tui, theme, done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: 50, maxHeight: 20 },
			});
		},
	});

	// Test all 9 anchor positions
	// 循环展示九个锚点：每次 custom 返回 "next" 就换下一个，"confirm" 提示后退出，"cancel" 直接退出。
	pi.registerCommand("overlay-anchors", {
		description: "Cycle through all anchor positions",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			// 显式标注 OverlayAnchor[]，保证每个字面量都在允许的锚点联合内；顺序就是循环顺序。
			const anchors: OverlayAnchor[] = [
				"top-left",
				"top-center",
				"top-right",
				"left-center",
				"center",
				"right-center",
				"bottom-left",
				"bottom-center",
				"bottom-right",
			];

			// index 指向当前锚点；while(true) 靠 break 退出，await 让每次浮层交互串行。
			let index = 0;
			while (true) {
				// 泛型 "next" | "confirm" | "cancel" 约束 done 的参数，也就是 result 的类型。
				// anchors[index]! 非空断言：index 始终由取模保持在数组范围内。
				const result = await ctx.ui.custom<"next" | "confirm" | "cancel">(
					(_tui, theme, _kb, done) => new AnchorTestComponent(theme, anchors[index]!, done),
					{
						overlay: true,
						overlayOptions: { anchor: anchors[index], width: 40 },
					},
				);

				// 用户按 Space/→ 返回 next：取模循环到下一个锚点，continue 进入下一轮 while。
				if (result === "next") {
					index = (index + 1) % anchors.length;
					continue;
				}
				// 用户按 Enter：提示当前选择，然后 break 结束整个命令。
				if (result === "confirm") {
					ctx.ui.notify(`Selected: ${anchors[index]}`, "info");
				}
				break;
			}
		},
	});

	// Test margins and offsets
	// 每个配置是一组 OverlayOptions；数组元素类型显式写出，让 name/options 两个字段都受检查。
	pi.registerCommand("overlay-margins", {
		description: "Test margin and offset options",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const configs: { name: string; options: OverlayOptions }[] = [
				{ name: "No margin (top-left)", options: { anchor: "top-left", width: 35 } },
				{ name: "Margin: 3 all sides", options: { anchor: "top-left", width: 35, margin: 3 } },
				{
					name: "Margin: top=5, left=10",
					options: { anchor: "top-left", width: 35, margin: { top: 5, left: 10 } },
				},
				{ name: "Center + offset (10, -3)", options: { anchor: "center", width: 35, offsetX: 10, offsetY: -3 } },
				{ name: "Bottom-right, margin: 2", options: { anchor: "bottom-right", width: 35, margin: 2 } },
			];

			let index = 0;
			while (true) {
				const result = await ctx.ui.custom<"next" | "close">(
					(_tui, theme, _kb, done) => new MarginTestComponent(theme, configs[index]!, done),
					{
						overlay: true,
						overlayOptions: configs[index]!.options,
					},
				);

				if (result === "next") {
					index = (index + 1) % configs.length;
					continue;
				}
				break;
			}
		},
	});

	// Test stacked overlays
	// 连续打开三个浮层，不 await 前两个的 Promise，而是先保存 p1/p2/p3，最后 Promise.all 一起等待。
	// 这样三个浮层同时存在，能验证堆叠顺序与各自偏移。
	pi.registerCommand("overlay-stack", {
		description: "Test stacked overlays",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			// Three large overlays that overlap in the center area
			// Each offset slightly so you can see the stacking

			// notify 只是提示；随后立即创建第一个 custom，返回 Promise 暂存到 p1。
			ctx.ui.notify("Showing overlay 1 (back)...", "info");
			const p1 = ctx.ui.custom<string>(
				(_tui, theme, _kb, done) => new StackOverlayComponent(theme, 1, "back (red border)", done),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: 50, offsetX: -8, offsetY: -4, maxHeight: 15 },
				},
			);

			await sleep(400);

			ctx.ui.notify("Showing overlay 2 (middle)...", "info");
			const p2 = ctx.ui.custom<string>(
				(_tui, theme, _kb, done) => new StackOverlayComponent(theme, 2, "middle (green border)", done),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: 50, offsetX: 0, offsetY: 0, maxHeight: 15 },
				},
			);

			await sleep(400);

			ctx.ui.notify("Showing overlay 3 (front)...", "info");
			const p3 = ctx.ui.custom<string>(
				(_tui, theme, _kb, done) => new StackOverlayComponent(theme, 3, "front (blue border)", done),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: 50, offsetX: 8, offsetY: 4, maxHeight: 15 },
				},
			);

			// Wait for all to close
			// Promise.all 等三个 custom 都 done；结果按 p1/p2/p3 的数组顺序返回，不是关闭先后。
			const results = await Promise.all([p1, p2, p3]);
			ctx.ui.notify(`Closed in order: ${results.join(", ")}`, "info");
		},
	});

	// Test width overflow scenarios (original crash case) - streams real process output
	// 组件内部会 spawn 一个持续输出的 bash 进程，用于验证超长行/ANSI 颜色在浮层宽度内不会崩溃。
	pi.registerCommand("overlay-overflow", {
		description: "Test width overflow with streaming process output",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new StreamingOverflowComponent(tui, theme, done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: 90, maxHeight: 20 },
			});
		},
	});

	// Test overlay at terminal edge
	// margin: { right: 0 } 让右边缘贴住终端边界，检查边框是否对齐。
	pi.registerCommand("overlay-edge", {
		description: "Test overlay positioned at terminal edge",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new EdgeTestComponent(theme, done), {
				overlay: true,
				overlayOptions: { anchor: "right-center", width: 40, margin: { right: 0 } },
			});
		},
	});

	// Test percentage-based positioning
	// row/col 可以传数字（绝对行/列）或带 % 的字符串；这里演示百分比定位。
	pi.registerCommand("overlay-percent", {
		description: "Test percentage-based positioning",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const configs = [
				{ name: "rowPercent: 0 (top)", row: 0, col: 50 },
				{ name: "rowPercent: 50 (middle)", row: 50, col: 50 },
				{ name: "rowPercent: 100 (bottom)", row: 100, col: 50 },
				{ name: "colPercent: 0 (left)", row: 50, col: 0 },
				{ name: "colPercent: 100 (right)", row: 50, col: 100 },
			];

			let index = 0;
			while (true) {
				const config = configs[index]!;
				const result = await ctx.ui.custom<"next" | "close">(
					(_tui, theme, _kb, done) => new PercentTestComponent(theme, config, done),
					{
						overlay: true,
						overlayOptions: {
							width: 30,
							row: `${config.row}%`,
							col: `${config.col}%`,
						},
					},
				);

				if (result === "next") {
					index = (index + 1) % configs.length;
					continue;
				}
				break;
			}
		},
	});

	// Test maxHeight
	// 组件故意渲染超过 maxHeight 的行，宿主应只显示前 10 行（底边框会被裁掉）。
	pi.registerCommand("overlay-maxheight", {
		description: "Test maxHeight truncation",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new MaxHeightTestComponent(theme, done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: 50, maxHeight: 10 },
			});
		},
	});

	// Test responsive sidepanel - only shows when terminal is wide enough
	// width: "25%" 是终端宽度百分比；minWidth 保证至少 30 列。
	pi.registerCommand("overlay-sidepanel", {
		description: "Test responsive sidepanel (hides when terminal < 100 cols)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new SidepanelComponent(tui, theme, done), {
				overlay: true,
				overlayOptions: {
					anchor: "right-center",
					width: "25%",
					minWidth: 30,
					margin: { right: 1 },
					// Only show when terminal is wide enough
					// visible 每次布局时按终端宽度回调；返回 false 只是隐藏浮层，不结束 custom。
					visible: (termWidth) => termWidth >= 100,
				},
			});
		},
	});

	// Test toggle overlay - demonstrates OverlayHandle.setHidden() via onHandle callback
	// 浮层显示后宿主把 OverlayHandle 传给 onHandle；组件通过模块级 globalToggleHandle 访问它。
	pi.registerCommand("overlay-toggle", {
		description: "Test overlay toggle (press 't' to toggle visibility)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new ToggleDemoComponent(tui, theme, done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: 50 },
				// onHandle callback provides access to the OverlayHandle for visibility control
				onHandle: (handle) => {
					// Store handle globally so component can access it
					// (In real code, you'd use a more elegant pattern like a store or event emitter)
					globalToggleHandle = handle;
				},
			});
			// custom 结束（浮层关闭）后清空引用，避免组件继续操作已失效的句柄。
			globalToggleHandle = null;
		},
	});

	// Non-capturing overlay demo - passive info panel that doesn't steal focus
	// 进入前清空编辑器，避免误导用户在编辑器中输入；真正的输入会路由到活动的 custom 组件。
	pi.registerCommand("overlay-passive", {
		description: "Test non-capturing overlay (passive info panel alongside active overlay)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.setEditorText("");
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new PassiveDemoController(tui, theme, done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: 48 },
			});
		},
	});

	// Focus cycling demo - demonstrates focus(), input routing, per-panel dismissal, and rendering order
	// 控制器本身是 active 浮层，另外创建三个 nonCapturing 面板，用 handle.focus()/hide() 手动管理。
	pi.registerCommand("overlay-focus", {
		description: "Test focus cycling, input routing, dismissal, and rendering order with overlays",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.setEditorText("");
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new FocusDemoController(tui, theme, done), {
				overlay: true,
				overlayOptions: { anchor: "bottom-center", width: 55, margin: { bottom: 1 } },
			});
		},
	});

	// Test multiple input panels with simulated streaming
	// 底部控制器 + 左侧三个非捕获输入面板；setInterval 每 500ms 追加一行模拟流式输出。
	pi.registerCommand("overlay-streaming", {
		description: "Multiple input panels with simulated streaming (Tab to cycle focus)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.setEditorText("");
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new StreamingInputController(tui, theme, done), {
				overlay: true,
				overlayOptions: { anchor: "bottom-center", width: 60, margin: { bottom: 1 } },
			});
		},
	});
}

// 返回一个在 ms 毫秒后 resolve 的 Promise；用于制造浮层出现的时间差。副作用：启动一个定时器。
// 示例：await sleep(400) 暂停约 0.4 秒；不保证精确到毫秒。
function sleep(ms: number): Promise<void> {
	// Promise 构造函数里的 resolve 在 setTimeout 触发时调用，从而让 await 继续。
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Base overlay component with common rendering
// 所有测试组件的共同基类：保存主题，提供画边框/标题的 box()，以及空的 invalidate/dispose。
// abstract 表示不能直接实例化，只供 extends 使用。
abstract class BaseOverlay {
	// protected 允许子类读取，外部不能访问；保存引用而非复制。
	protected theme: Theme;

	// 输入主题并保存；没有其他副作用。
	constructor(theme: Theme) {
		this.theme = theme;
	}

	// 把若干内容行包成带圆角边框和可选标题的字符串数组。输入：内容行、总宽度、可选标题。
	// 输出：每个元素是一整行（含 ANSI 样式）；副作用：无。
	// 流程：计算内部宽度 -> 居中标题 -> 画上边框 -> 逐行裁剪并加左右边框 -> 画下边框。
	// 示例：box(["hi"], 10, "Demo") 返回三行以上的框，标题在顶边中间。
	protected box(lines: string[], width: number, title?: string): string[] {
		// 局部别名减少重复；th 与 this.theme 是同一个对象。
		const th = this.theme;
		// 左右各占一列边框，内部宽度至少为 1，防止终端极窄时 repeat 负数。
		const innerW = Math.max(1, width - 2);
		const result: string[] = [];

		// 标题两侧加空格；truncateToWidth 按显示列裁剪，不会把宽字符截成半个。
		const titleStr = title ? truncateToWidth(` ${title} `, innerW) : "";
		// visibleWidth 忽略 ANSI 转义，只计算可见列。
		const titleW = visibleWidth(titleStr);
		// 标题左侧横线数量取一半（向下取整）；repeat 次数不会是负数，因为 titleW <= innerW。
		const topLine = "─".repeat(Math.floor((innerW - titleW) / 2));
		// 右侧补足剩余宽度；Math.max(0, ...) 防御取整造成的差一错误。
		const topLine2 = "─".repeat(Math.max(0, innerW - titleW - topLine.length));
		// 分别给左框、标题、右框着色后拼接；标题用 accent 色突出。
		result.push(th.fg("border", `╭${topLine}`) + th.fg("accent", titleStr) + th.fg("border", `${topLine2}╮`));

		// 每行内容先按内部宽度裁剪；第四个参数 true 表示用空格补齐到 innerW，保证右边框对齐。
		// ANSI 样式由 truncateToWidth 内部保留，不受第四个参数影响。
		for (const line of lines) {
			result.push(th.fg("border", "│") + truncateToWidth(line, innerW, "...", true) + th.fg("border", "│"));
		}

		// 底边框固定用 innerW 个横线；内容超长已在上面裁剪。
		result.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return result;
	}

	// 组件接口要求的重绘失效钩子；本基类没有缓存，因此空实现。
	invalidate(): void {}
	// 组件销毁钩子；基类没有资源要释放，子类可 override。
	dispose(): void {}
}

// Anchor position test
// 显示当前锚点并让用户按键推进。输入：主题、当前锚点、完成回调；输出：可渲染组件。
// 状态：只有传入的 anchor（组件本身不切换，切换由命令 handler 重新创建组件完成）。
// 示例：anchor 为 "center" 时浮层在屏幕中央，按 Space 后 done("next")。
class AnchorTestComponent extends BaseOverlay {
	private anchor: OverlayAnchor;
	// 保存完成回调；组件不直接操作 UI 生命周期，而是把结果交回 ctx.ui.custom。
	private done: (result: "next" | "confirm" | "cancel") => void;

	// 调用 super(theme) 初始化基类，再保存本组件字段；没有副作用。
	constructor(theme: Theme, anchor: OverlayAnchor, done: (result: "next" | "confirm" | "cancel") => void) {
		super(theme);
		this.anchor = anchor;
		this.done = done;
	}

	// 处理按键：Esc/Ctrl+C 取消，Enter 确认，Space/→ 下一个。输入 data 是原始按键序列。
	// 副作用：调用 done 一次；调用后宿主会销毁组件。
	handleInput(data: string): void {
		// || 短路：任一按键匹配即执行取消。
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done("cancel");
		} else if (matchesKey(data, "return")) {
			this.done("confirm");
		} else if (matchesKey(data, "space") || matchesKey(data, "right")) {
			this.done("next");
		}
	}

	// 生成浮层内容。输入：可用宽度；输出：带边框的行数组。
	// 示例：宽度 40 时 box 会按 38 列内部宽度裁剪文字。
	render(width: number): string[] {
		const th = this.theme;
		return this.box(
			[
				"",
				// 当前锚点用 accent 色突出；this.anchor 是九个字面量之一。
				` Current: ${th.fg("accent", this.anchor)}`,
				"",
				// 提示文字统一用 dim 弱化；→ 是普通 Unicode 字符。
				` ${th.fg("dim", "Space/→ = next anchor")}`,
				` ${th.fg("dim", "Enter = confirm")}`,
				` ${th.fg("dim", "Esc = cancel")}`,
				"",
			],
			width,
			"Anchor Test",
		);
	}
}

// Margin/offset test
// 显示当前 margin/offset 配置名；真正的位置由命令 handler 传给 ctx.ui.custom 的 overlayOptions 决定。
// 示例：配置名为 "Margin: 3 all sides" 时浮层四边各留 3 行/列。
class MarginTestComponent extends BaseOverlay {
	private config: { name: string; options: OverlayOptions };
	// "next" 让 handler 展示下一组；"close" 结束循环。
	private done: (result: "next" | "close") => void;

	// 保存配置对象引用与回调；不复制 options。
	constructor(
		theme: Theme,
		config: { name: string; options: OverlayOptions },
		done: (result: "next" | "close") => void,
	) {
		super(theme);
		this.config = config;
		this.done = done;
	}

	// Esc/Ctrl+C 关闭，Space/→ 切换下一组；其他按键忽略。
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done("close");
		} else if (matchesKey(data, "space") || matchesKey(data, "right")) {
			this.done("next");
		}
	}

	// 渲染当前配置名；options 本身不展示，观察浮层位置即可。
	render(width: number): string[] {
		const th = this.theme;
		return this.box(
			[
				"",
				` ${th.fg("accent", this.config.name)}`,
				"",
				` ${th.fg("dim", "Space/→ = next config")}`,
				` ${th.fg("dim", "Esc = close")}`,
				"",
			],
			width,
			"Margin Test",
		);
	}
}

// Stacked overlay test
// 每层用不同边框颜色和偏移展示堆叠；按 Enter/Esc 关闭当前层，返回 "Overlay N"。
// 示例：第 2 层边框为绿色，关闭后 Promise.all 结果数组里对应位置是 "Overlay 2"。
class StackOverlayComponent extends BaseOverlay {
	private num: number;
	private position: string;
	// 完成时返回字符串标签，而不是联合字面量；handler 只用它拼接提示。
	private done: (result: string) => void;

	// 保存层号、描述文字和回调；颜色由层号在 render 中计算。
	constructor(theme: Theme, num: number, position: string, done: (result: string) => void) {
		super(theme);
		this.num = num;
		this.position = position;
		this.done = done;
	}

	// 三种“关闭”键都返回当前层标签；没有其他按键处理。
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "return")) {
			this.done(`Overlay ${this.num}`);
		}
	}

	// 手动画一个更高的框，方便观察三层重叠；不同层使用不同颜色。
	render(width: number): string[] {
		const th = this.theme;
		// Use different colors for each overlay to show stacking
		// as const 让数组元素类型收窄为三个颜色名字面量；索引取模循环使用。
		const colors = ["error", "success", "accent"] as const;
		// non-null 断言：取模结果一定在 0..length-1 之间。
		const color = colors[(this.num - 1) % colors.length]!;
		// 内部宽度与基类 box 一致，左右各留一列边框。
		const innerW = Math.max(1, width - 2);
		// 两个局部箭头函数：border 给任意字符上当前层颜色，padLine 按内部宽度裁剪。
		const border = (char: string) => th.fg(color, char);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const lines: string[] = [];

		// 顶边、标题行、层描述行；每行左右都用当前层颜色的边框字符包住。
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + padLine(` Overlay ${th.fg("accent", `#${this.num}`)}`) + border("│"));
		lines.push(border("│") + padLine(` Layer: ${th.fg(color, this.position)}`) + border("│"));
		lines.push(border("│") + padLine("") + border("│"));
		// Add extra lines to make it taller
		// 额外填充 5 行阴影块，让三个浮层重叠时更容易看清层级。
		for (let i = 0; i < 5; i++) {
			lines.push(border("│") + padLine(` ${"░".repeat(innerW - 2)} `) + border("│"));
		}
		lines.push(border("│") + padLine("") + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " Press Enter/Esc to close")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}
}

// Streaming overflow test - spawns real process with colored output (original crash scenario)
// 用真实子进程持续输出超长行、OSC 8 超链接和 ANSI 颜色，检查浮层裁剪与滚动不会崩溃。
// 状态：lines 累积输出，scrollOffset 控制可视窗口，disposed 防止进程回调在销毁后继续改状态。
// 示例：/overlay-overflow 打开后每 0.3 秒出现一行长路径，按 ↑/↓ 滚动，Esc 关闭并 kill 进程。
class StreamingOverflowComponent extends BaseOverlay {
	private tui: TUI;
	private lines: string[] = [];
	// ReturnType<typeof spawn> 让类型跟随 Node 的 ChildProcess 定义，无需显式导入类型。
	private proc: ReturnType<typeof spawn> | null = null;
	private scrollOffset = 0;
	private maxVisibleLines = 15;
	private finished = false;
	// 组件销毁后 stdout/stderr/close 回调仍可能触发，用此标记提前返回。
	private disposed = false;
	private done: () => void;

	// 保存 tui/done 后立即启动子进程；构造期间就会产生副作用（spawn）。
	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;
		this.startProcess();
	}

	// 启动 bash 子进程。输入：无；输出：无；副作用：创建进程并注册三个事件监听器。
	// 注意内嵌脚本模板字符串的内容是运行时 shell 输入，本注释不修改其中的文本。
	private startProcess(): void {
		// Run a command that produces many lines with ANSI colors
		// Using find with -ls produces file listings, or use ls --color
		this.proc = spawn("bash", [
			"-c",
			`
			echo "Starting streaming overflow test (30+ seconds)..."
			echo "This simulates subagent output with colors, hyperlinks, and long paths"
			echo ""
			for i in $(seq 1 100); do
				# Simulate long file paths with OSC 8 hyperlinks (clickable) - tests width overflow
				DIR="/Users/nicobailon/Documents/development/pi-mono/packages/coding-agent/src/modes/interactive"
				FILE="\${DIR}/components/very-long-component-name-that-exceeds-width-\${i}.ts"
				echo -e "\\033]8;;file://\${FILE}\\007▶ read: \${FILE}\\033]8;;\\007"

				# Add some colored status messages with long text
				if [ $((i % 5)) -eq 0 ]; then
					echo -e "  \\033[32m✓ Successfully processed \${i} files in /Users/nicobailon/Documents/development/pi-mono\\033[0m"
				fi
				if [ $((i % 7)) -eq 0 ]; then
					echo -e "  \\033[33m⚠ Warning: potential issue detected at line \${i} in very-long-component-name-that-exceeds-width.ts\\033[0m"
				fi
				if [ $((i % 11)) -eq 0 ]; then
					echo -e "  \\033[31m✗ Error: file not found /some/really/long/path/that/definitely/exceeds/the/overlay/width/limit/file-\${i}.ts\\033[0m"
				fi
				sleep 0.3
			done
			echo ""
			echo -e "\\033[32m✓ Complete - 100 files processed in 30 seconds\\033[0m"
			echo "Press Esc to close"
			`,
		]);

		// stdout 是可选的（取决于 spawn 配置与进程状态），?. 避免没有流时抛错；data 是 Buffer。
		// 事件回调属于异步副作用，必须自行检查 disposed，因为 dispose 之后流仍可能推数据。
		this.proc.stdout?.on("data", (data: Buffer) => {
			if (this.disposed) return; // Guard against callbacks after dispose
			// Buffer.toString 默认 UTF-8；chunk 边界可能切断一行，这里简化处理，不做跨 chunk 拼接。
			const text = data.toString();
			const newLines = text.split("\n");
			for (const line of newLines) {
				// 空行也跳过，避免一次 chunk 末尾的换行产生空条目。
				if (line) this.lines.push(line);
			}
			// Auto-scroll to bottom
			// 每次新数据都把视口移到底部；Math.max(0, ...) 防止行数不足时出现负偏移。
			this.scrollOffset = Math.max(0, this.lines.length - this.maxVisibleLines);
			// 通知 TUI 重绘；不等待渲染完成。
			this.tui.requestRender();
		});

		// stderr 按一行处理并用 error 色显示；同样要防销毁后回调。
		this.proc.stderr?.on("data", (data: Buffer) => {
			if (this.disposed) return; // Guard against callbacks after dispose
			this.lines.push(this.theme.fg("error", data.toString().trim()));
			this.tui.requestRender();
		});

		// close 表示进程结束（不一定成功）；标记 finished 改变状态栏显示。
		this.proc.on("close", () => {
			if (this.disposed) return; // Guard against callbacks after dispose
			this.finished = true;
			this.tui.requestRender();
		});
	}

	// 按键：Esc/Ctrl+C 结束并杀进程，↑/↓ 调整滚动偏移。副作用：修改状态并请求重绘。
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			// 先 kill 子进程再 done，避免 custom 结束后进程还在写终端/回调里 requestRender。
			this.proc?.kill();
			this.done();
		} else if (matchesKey(data, "up")) {
			// 向上滚动一行，下限 0。
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender(); // Trigger re-render after scroll
		} else if (matchesKey(data, "down")) {
			// 向下滚动一行，上限为“总行数 - 可视行数”；Math.max(0, ...) 处理总行数不足一屏。
			this.scrollOffset = Math.min(Math.max(0, this.lines.length - this.maxVisibleLines), this.scrollOffset + 1);
			this.tui.requestRender(); // Trigger re-render after scroll
		}
	}

	// 绘制固定高度窗口：标题、滚动指示、可视行、状态行、底边框。输入：宽度；输出：字符串行。
	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const border = (c: string) => th.fg("border", c);

		const result: string[] = [];
		// 标题包含当前累计行数，便于确认流式仍在追加。
		const title = truncateToWidth(` Streaming Output (${this.lines.length} lines) `, innerW);
		// 标题右侧用横线补满内部宽度，再拼右上角。
		const titlePad = Math.max(0, innerW - visibleWidth(title));
		result.push(border("╭") + th.fg("accent", title) + border(`${"─".repeat(titlePad)}╮`));

		// Scroll indicators
		// canScrollUp 由偏移决定；canScrollDown 比较偏移与最大可滚动位置。
		const canScrollUp = this.scrollOffset > 0;
		const canScrollDown = this.scrollOffset < this.lines.length - this.maxVisibleLines;
		// 显示上方已隐藏行数与下方剩余行数；Math.max 防止负数。
		const scrollInfo = `↑${this.scrollOffset} | ↓${Math.max(0, this.lines.length - this.maxVisibleLines - this.scrollOffset)}`;

		// 可滚动时显示指示行，否则留空；padLine 保证行宽一致。
		result.push(
			border("│") + padLine(canScrollUp || canScrollDown ? th.fg("dim", ` ${scrollInfo}`) : "") + border("│"),
		);

		// Visible lines - truncate long lines to fit within border
		// slice 只取窗口内行；超长行由 padLine 裁剪，不会撑破边框。
		const visibleLines = this.lines.slice(this.scrollOffset, this.scrollOffset + this.maxVisibleLines);
		for (const line of visibleLines) {
			result.push(border("│") + padLine(` ${line}`) + border("│"));
		}

		// Pad to maxVisibleLines
		// 行数不足时补空行，保证浮层高度稳定、状态行位置不跳动。
		for (let i = visibleLines.length; i < this.maxVisibleLines; i++) {
			result.push(border("│") + padLine("") + border("│"));
		}

		// finished 由 close 事件设置；三目表达式选择完成或运行中样式。
		const status = this.finished ? th.fg("success", "✓ Done") : th.fg("warning", "● Running");
		result.push(border("│") + padLine(` ${status} ${th.fg("dim", "| ↑↓ scroll | Esc close")}`) + border("│"));
		result.push(border(`╰${"─".repeat(innerW)}╯`));

		return result;
	}

	// 组件销毁时设置标记并 kill 进程；幂等（重复 kill 已结束进程通常无害）。
	dispose(): void {
		this.disposed = true;
		this.proc?.kill();
	}
}

// Edge position test
// 只负责显示说明文字；位于右边缘由命令 handler 的 anchor/margin 决定。
// 示例：按 Esc 后 done() 使 custom 结束。
class EdgeTestComponent extends BaseOverlay {
	private done: () => void;

	// 保存主题与关闭回调；无其他副作用。
	constructor(theme: Theme, done: () => void) {
		super(theme);
		this.done = done;
	}

	// Esc 或 Ctrl+C 结束浮层；其他按键不处理。
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
		}
	}

	// 渲染边缘测试说明；文字里提示用户检查右框是否贴齐。
	render(width: number): string[] {
		const th = this.theme;
		return this.box(
			[
				"",
				" This overlay is at the",
				" right edge of terminal.",
				"",
				` ${th.fg("dim", "Verify right border")}`,
				` ${th.fg("dim", "aligns with edge.")}`,
				"",
				` ${th.fg("dim", "Press Esc to close")}`,
				"",
			],
			width,
			"Edge Test",
		);
	}
}

// Percentage positioning test
// 显示当前百分比配置名；位置由 handler 拼成 `${row}%` / `${col}%` 传给 overlayOptions。
// 示例：row=50、col=50 时浮层大致位于终端中心。
class PercentTestComponent extends BaseOverlay {
	private config: { name: string; row: number; col: number };
	private done: (result: "next" | "close") => void;

	// 保存配置引用与回调；row/col 只用于显示，定位仍由 handler 读取同一对象完成。
	constructor(
		theme: Theme,
		config: { name: string; row: number; col: number },
		done: (result: "next" | "close") => void,
	) {
		super(theme);
		this.config = config;
		this.done = done;
	}

	// 与 margin 测试相同的快捷键：Space/→ 下一组，Esc/Ctrl+C 关闭。
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done("close");
		} else if (matchesKey(data, "space") || matchesKey(data, "right")) {
			this.done("next");
		}
	}

	// 渲染配置名与操作提示。
	render(width: number): string[] {
		const th = this.theme;
		return this.box(
			[
				"",
				` ${th.fg("accent", this.config.name)}`,
				"",
				` ${th.fg("dim", "Space/→ = next")}`,
				` ${th.fg("dim", "Esc = close")}`,
				"",
			],
			width,
			"Percent Test",
		);
	}
}

// MaxHeight test - renders 20 lines, truncated to 10 by maxHeight
// 故意渲染超过 maxHeight 的内容，验证宿主只显示前若干行（底边框会被裁掉）。
// 示例：maxHeight=10 时只看到顶边框、提示和 Line 1..6，下方没有底边框。
class MaxHeightTestComponent extends BaseOverlay {
	private done: () => void;

	// 保存主题与关闭回调；截断行为由宿主按 overlayOptions.maxHeight 完成，组件不感知。
	constructor(theme: Theme, done: () => void) {
		super(theme);
		this.done = done;
	}

	// Esc/Ctrl+C 关闭；没有滚动功能，因为本测试关注截断。
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
		}
	}

	// 总共渲染 21 行：2 行提示 + 空行 + 14 行编号 + 空行 + 1 行提示，再加 box 的顶/底边框。
	render(width: number): string[] {
		const th = this.theme;
		// Intentionally render 21 lines - maxHeight: 10 will truncate to first 10
		// You should see header + lines 1-6, with bottom border cut off
		const contentLines: string[] = [
			th.fg("warning", " ⚠ Rendering 21 lines, maxHeight: 10"),
			th.fg("dim", " Lines 11-21 truncated (no bottom border)"),
			"",
		];

		// 循环 1..14（含 14），逐行加入编号，验证行号在截断后仍可辨认。
		for (let i = 1; i <= 14; i++) {
			contentLines.push(` Line ${i} of 14`);
		}

		// push 可一次加入多个元素；最后的提示位于内容末尾，通常被 maxHeight 裁掉。
		contentLines.push("", th.fg("dim", " Press Esc to close"));

		// box 会再加顶/底边框，因此总行数比 contentLines.length 多 2。
		return this.box(contentLines, width, "MaxHeight Test");
	}
}

// Responsive sidepanel - demonstrates percentage width and visibility callback
// 侧边菜单：↑/↓ 移动选中项，Enter 预留动作，Esc 关闭；终端宽度不足 100 列时整个浮层由 visible 隐藏。
// 示例：把终端缩窄到 99 列，面板消失；拉宽后重新出现。
class SidepanelComponent extends BaseOverlay {
	private tui: TUI;
	private items = ["Dashboard", "Messages", "Settings", "Help", "About"];
	private selectedIndex = 0;
	private done: () => void;

	// 保存 TUI（用于选择变化后重绘）、菜单项和关闭回调；selectedIndex 从第一项开始。
	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;
	}

	// 上/下移动选中项并用 Math.max/min 夹在合法索引范围内；Enter 目前只触发重绘。
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
		} else if (matchesKey(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "down")) {
			// items.length - 1 是最后一项索引；Math.min 防止越界。
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "return")) {
			// Could trigger an action here
			// 示例只重绘，不执行菜单动作；真实实现可在这里调用业务回调。
			this.tui.requestRender();
		}
	}

	// 手动画带分隔线的菜单框；选中项用 → 前缀和 accent 色标记。
	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const border = (c: string) => th.fg("border", c);
		const lines: string[] = [];

		// Header
		// 顶边、标题、分隔线；├ ┤ 是中间分隔符。
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + padLine(th.fg("accent", " Responsive Sidepanel")) + border("│"));
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));

		// Menu items
		// 下标访问 items[i] 后非空断言；i 由 for 条件限制在范围内。
		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i]!;
			// 只比较索引，不修改选中项对象。
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? th.fg("accent", "→ ") : "  ";
			const text = isSelected ? th.fg("accent", item) : item;
			lines.push(border("│") + padLine(`${prefix}${text}`) + border("│"));
		}

		// Footer with responsive behavior info
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		lines.push(border("│") + padLine(th.fg("warning", " ⚠ Resize terminal < 100 cols")) + border("│"));
		lines.push(border("│") + padLine(th.fg("warning", "   to see panel auto-hide")) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " Uses visible: (w) => w >= 100")) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " ↑↓ navigate | Esc close")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}
}

// Animation demo - proves overlays can handle real-time updates like pi-doom
// 用 setInterval 每约 33ms 增加帧号并请求重绘，展示浮层可以承载实时动画。
// 状态：frame 驱动动画，fps 每秒统计一次，interval 必须在 dispose 中清理。
// 示例：打开后条块左右移动、旋转符变化；状态栏显示约 30 FPS。
class AnimationDemoComponent extends BaseOverlay {
	private tui: TUI;
	private frame = 0;
	private interval: ReturnType<typeof setInterval> | null = null;
	private fps = 0;
	// 上一次 FPS 统计时间和上一秒内累计帧数。
	private lastFpsUpdate = Date.now();
	private framesSinceLastFps = 0;
	private done: () => void;

	// 构造时立即启动动画；构造期间的副作用是建立 interval。
	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;
		this.startAnimation();
	}

	// 启动约 30 FPS 的定时器。副作用：持续请求重绘，直到 dispose 调用 clearInterval。
	private startAnimation(): void {
		// Run at ~30 FPS (same as DOOM target)
		// 1000/30 ≈ 33.3ms；setInterval 实际精度受事件循环与终端负载影响。
		this.interval = setInterval(() => {
			// 每帧递增帧号，并累积本秒帧数。
			this.frame++;
			this.framesSinceLastFps++;

			// Update FPS counter every second
			const now = Date.now();
			// 距上次统计满 1000ms 时结算：把累计帧数记为 fps，再清零并记录新时间。
			if (now - this.lastFpsUpdate >= 1000) {
				this.fps = this.framesSinceLastFps;
				this.framesSinceLastFps = 0;
				this.lastFpsUpdate = now;
			}

			// 请求重绘；不等待，TUI 合并多次请求。
			this.tui.requestRender();
		}, 1000 / 30);
	}

	// Esc/Ctrl+C 时先停定时器再结束，避免 custom 结束后 interval 继续运行。
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.dispose();
			this.done();
		}
	}

	// 按当前帧号绘制动画。输入：宽度；输出：行数组；无副作用（只读字段）。
	// 三处动态内容：往返移动的条块、旋转符、按色相循环的背景色块。
	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const border = (c: string) => th.fg("border", c);

		const lines: string[] = [];
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + padLine(th.fg("accent", " Animation Demo (~30 FPS)")) + border("│"));
		lines.push(border("│") + padLine(``) + border("│"));
		lines.push(border("│") + padLine(` Frame: ${th.fg("accent", String(this.frame))}`) + border("│"));
		lines.push(border("│") + padLine(` FPS: ${th.fg("success", String(this.fps))}`) + border("│"));
		lines.push(border("│") + padLine(``) + border("│"));

		// Animated content - bouncing bar
		// 条块至少 12 列；Math.sin 产生 -1..1 的平滑往复运动，再映射到可用偏移。
		const barWidth = Math.max(12, innerW - 4); // Ensure enough space for bar
		const pos = Math.max(0, Math.floor(((Math.sin(this.frame / 10) + 1) * (barWidth - 10)) / 2));
		// 左侧空格 + 10 格实心块 + 右侧补空格，保证总宽恰为 barWidth。
		const bar = " ".repeat(pos) + th.fg("accent", "██████████") + " ".repeat(Math.max(0, barWidth - 10 - pos));
		lines.push(border("│") + padLine(` ${bar}`) + border("│"));

		// Spinning character
		// 四个字符按帧号取模循环；non-null 断言表示索引必在范围内。
		const spinChars = ["◐", "◓", "◑", "◒"];
		const spin = spinChars[this.frame % spinChars.length];
		lines.push(border("│") + padLine(` Spinner: ${th.fg("warning", spin!)}`) + border("│"));

		// Color cycling
		// 每帧增加 3 度色相，% 360 回绕；转成 0..1 的色相后调用辅助函数。
		const hue = (this.frame * 3) % 360;
		const rgb = hslToRgb(hue / 360, 0.8, 0.5);
		// 24 位真彩色背景 ANSI：48;2;R;G;B，20 个空格形成色块，\x1b[0m 重置样式。
		const colorBlock = `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m${"  ".repeat(10)}\x1b[0m`;
		lines.push(border("│") + padLine(` Color: ${colorBlock}`) + border("│"));

		lines.push(border("│") + padLine(``) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " This proves overlays can handle")) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " real-time game-like rendering.")) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " (pi-doom uses same approach)")) + border("│"));
		lines.push(border("│") + padLine(``) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " Press Esc to close")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	// 清理定时器；幂等，interval 已为 null 时不再操作。
	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}
}

// HSL to RGB helper for color cycling animation
// 把色相 h、饱和度 s、亮度 l（均为 0..1）转成 0..255 的 RGB 三元组。
// 纯函数，无副作用。采用标准 HSL→RGB 公式；示例：hslToRgb(0, 0.8, 0.5) 得到偏红的颜色。
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	// 三个分量先声明，后面在两个分支中赋值；元组返回类型限定恰好三个数字。
	let r: number, g: number, b: number;
	// 饱和度为 0 时是灰度，三个分量都等于亮度。
	if (s === 0) {
		r = g = b = l;
	} else {
		// 内部辅助函数把色相偏移 t 映射到 0..1 并计算通道值；t 越界时先回绕。
		const hue2rgb = (p: number, q: number, t: number) => {
			if (t < 0) t += 1;
			if (t > 1) t -= 1;
			// 三个分段对应 HSL 的六个色相区间。
			if (t < 1 / 6) return p + (q - p) * 6 * t;
			if (t < 1 / 2) return q;
			if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
			return p;
		};
		// q 与 p 是标准公式中的两个中间量；l < 0.5 与 >= 0.5 使用不同计算。
		const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
		const p = 2 * l - q;
		// 三个通道的色相分别偏移 +1/3、0、-1/3 圈。
		r = hue2rgb(p, q, h + 1 / 3);
		g = hue2rgb(p, q, h);
		b = hue2rgb(p, q, h - 1 / 3);
	}
	// 0..1 浮点值四舍五入到 0..255 的整数，作为元组返回。
	return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// Toggle demo - demonstrates OverlayHandle.setHidden() via onHandle callback
// 按 t 调用句柄隐藏浮层 1 秒再显示，验证 OverlayHandle 的可见性控制。
// 状态：isToggling 防止隐藏期间重复触发；toggleCount 只用于展示次数。
// 示例：按 t 后浮层消失约 1 秒（屏幕内容重新绘制），随后恢复。
class ToggleDemoComponent extends BaseOverlay {
	private tui: TUI;
	private toggleCount = 0;
	private isToggling = false;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;
	}

	// Esc/Ctrl+C 结束；t 在句柄可用且不在切换中时触发隐藏演示。
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
		} else if (matchesKey(data, "t") && globalToggleHandle && !this.isToggling) {
			// Demonstrate toggle by hiding for 1 second then showing again
			// (In real usage, a global keybinding would control visibility)
			// 先置标志，防止 1 秒内连续按 t 产生多个 setTimeout。
			this.isToggling = true;
			this.toggleCount++;
			globalToggleHandle.setHidden(true);

			// Auto-restore after 1 second to demonstrate the API
			// 延时回调再次检查句柄；若 custom 已结束，globalToggleHandle 可能已被清空。
			setTimeout(() => {
				if (globalToggleHandle) {
					globalToggleHandle.setHidden(false);
					this.isToggling = false;
					// 恢复可见后请求重绘，让内容立即出现。
					this.tui.requestRender();
				}
			}, 1000);
		}
	}

	// 渲染说明文字与当前切换次数。输入：可用宽度；输出：带边框的行数组；无副作用。
	// 示例：按两次 t 后这里显示 Toggle count: 2。
	render(width: number): string[] {
		const th = this.theme;
		// box() 统一加左右边框并把标题放在顶边框上；数组元素就是框内每一行。
		return this.box(
			[
				"",
				th.fg("accent", " Toggle Demo"),
				"",
				" This overlay demonstrates the",
				" onHandle callback API.",
				"",
				` Toggle count: ${th.fg("accent", String(this.toggleCount))}`,
				"",
				th.fg("dim", " Press 't' to hide for 1 second"),
				th.fg("dim", " (demonstrates setHidden API)"),
				"",
				th.fg("dim", " In real usage, a global keybinding"),
				th.fg("dim", " would toggle visibility externally."),
				"",
				th.fg("dim", " Press Esc to close"),
				"",
			],
			width,
			"Toggle Demo",
		);
	}
}

// === Non-capturing passive overlay demo ===

// 非捕获浮层演示的控制器。它本身是 custom 的主面板，同时用 showOverlay 在右上角叠加一个
// nonCapturing（不抢焦点、不阻塞主输入）的计时器面板，用来验证两个组件可以同时接收输入/重绘。
// 状态：typed 累积输入文字，inputCount/lastInputDebug 记录路由到主面板的按键。
// 示例：在计时器跳动时向主面板打字，两类更新互不阻塞；按 Esc 同时关闭主面板与计时器。
class PassiveDemoController extends BaseOverlay {
	focused = false;
	private tui: TUI;
	private typed = "";
	private timerComponent: TimerPanel;
	private timerHandle: OverlayHandle | null = null;
	private interval: ReturnType<typeof setInterval> | null = null;
	private inputCount = 0;
	private lastInputDebug = "";
	private done: () => void;

	// 构造时立即创建计时器浮层并启动秒表。输入：宿主 TUI、主题、结束回调；副作用：showOverlay + setInterval。
	// 示例：控制器出现时右上角同时出现 Timer，秒数每秒加一。
	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;
		this.timerComponent = new TimerPanel(theme);
		// nonCapturing 让计时器不抢焦点；anchor/margin 把它固定在右上角。
		this.timerHandle = this.tui.showOverlay(this.timerComponent, {
			nonCapturing: true,
			anchor: "top-right",
			width: 22,
			margin: { top: 1, right: 2 },
		});
		// 计时器状态由控制器推进：tick 只改数字，requestRender 才让 TUI 重新绘制。
		this.interval = setInterval(() => {
			this.timerComponent.tick();
			this.tui.requestRender();
		}, 1000);
	}

	// 主面板的按键处理。输入：终端按键批次；副作用：更新计数/文本或清理后结束。
	// 只接受单字符可打印输入；方向键、功能键等被忽略（长度 > 1 或控制码 < 32）。
	// 示例：按 a 显示 a；按 Backspace 删除最后一个字符；按 Esc 关闭两个面板。
	handleInput(data: string): void {
		this.inputCount++;
		// charCodeAt(0) 让演示能直接看到按键编码，便于确认路由到了哪个组件。
		this.lastInputDebug = `len=${data.length} c0=${data.charCodeAt(0)}`;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.cleanup();
			this.done();
		} else if (matchesKey(data, "backspace")) {
			// slice(0, -1) 去掉最后一个 UTF-16 码元；示例不处理多码元 emoji 的完整删除。
			this.typed = this.typed.slice(0, -1);
		} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
			// 码点 >= 32 排除控制字符，只把可打印字符追加到文本。
			this.typed += data;
		}
	}

	// 渲染主面板：显示 focus 状态、输入次数、最后一个按键和当前文本。
	render(width: number): string[] {
		const th = this.theme;
		// 没有输入时显示占位提示，占位文字使用 dim 色。
		const display = this.typed.length > 0 ? this.typed : th.fg("dim", "(type here)");
		return this.box(
			[
				"",
				` ${th.fg("dim", `focused=${this.focused} inputs=${this.inputCount}`)}`,
				` ${th.fg("dim", `last: ${this.lastInputDebug || "none"}`)}`,
				"",
				` > ${display}`,
				"",
				th.fg("dim", " Type to prove input goes here."),
				th.fg("dim", " Press Esc to close both."),
				"",
			],
			width,
			"Non-Capturing Demo",
		);
	}

	// 释放计时器：清 interval、隐藏并丢弃浮层句柄；重复调用安全（字段置空后再次进入直接跳过）。
	private cleanup(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
		// ?. 在句柄已为空时不调用 hide。
		this.timerHandle?.hide();
		this.timerHandle = null;
	}

	// 组件被宿主销毁时的兜底清理，防止 custom 因其他路径结束时计时器仍在跑。
	override dispose(): void {
		this.cleanup();
	}
}

// 右上角的秒表浮层。状态只有秒数；由 PassiveDemoController 每秒调用 tick 推进，
// 自己不做定时，因此销毁由控制器负责。
class TimerPanel extends BaseOverlay {
	private seconds = 0;

	// 秒数加一；不触发重绘，调用方需自行 requestRender。
	tick(): void {
		this.seconds++;
	}

	// 把秒数格式化为 mm:ss。输入：面板宽度；输出：带边框行；无副作用。
	// 示例：65 秒显示 01:05；Math.floor 取分钟，% 60 取余秒；padStart 补足两位。
	render(width: number): string[] {
		const th = this.theme;
		const mins = Math.floor(this.seconds / 60);
		const secs = this.seconds % 60;
		const time = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
		return this.box([` ${th.fg("accent", time)}`, th.fg("dim", " nonCapturing: true")], width, "Timer");
	}
}

// === Focus cycling demo ===

// 颜色只允许主题里的三个配色名；字符串字面量联合在编译期限制取值。
type FocusPanelColor = "error" | "success" | "accent";
// 单个浮层的配置：显示标签、边框颜色、交给 showOverlay 的定位选项。
type FocusPanelConfig = { label: string; color: FocusPanelColor; options: OverlayOptions };
// 控制器保存“组件 + 句柄”的配对，后续 focus/hide 都通过句柄操作。
type FocusPanelEntry = { panel: FocusPanel; handle: OverlayHandle };

// 三个互相重叠的浮层，row/col 故意错开以观察焦点顺序。
// satisfies 只在编译期检查这些字面量符合 FocusPanelConfig[]，不会像 as 那样把类型改成更宽的数组。
const FOCUS_PANEL_CONFIGS = [
	{ label: "Alpha", color: "error", options: { row: 2, col: 4, width: 34 } },
	{ label: "Beta", color: "success", options: { row: 5, col: 28, width: 34 } },
	{ label: "Gamma", color: "accent", options: { row: 8, col: 52, width: 34 } },
] satisfies FocusPanelConfig[];

// 焦点循环演示的控制器。构造时创建三个 nonCapturing 浮层面板并给第一个焦点；
// 按键在面板间循环 Tab/Shift+Tab，Esc/Ctrl+D 逐个关闭，Ctrl+C 全部关闭。
// 句柄的 focus()/hide() 是原始 API，面板组件不自己管理可见性。
// 示例：焦点在 Beta 时按 Tab 到 Gamma；在 Gamma 按 Esc 后焦点回到 Alpha。
class FocusDemoController extends BaseOverlay {
	private readonly tui: TUI;
	private entries: FocusPanelEntry[] = [];
	private readonly done: () => void;
	private closed = false;

	// 批量创建面板并保存组件/句柄对。输入：TUI、主题、结束回调；副作用：showOverlay × 3。
	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;

		for (const config of FOCUS_PANEL_CONFIGS) {
			const panel = new FocusPanel({ theme, config, controller: this });
			// 展开 config.options 提供 row/col/width；nonCapturing 让三个浮层都能按需获得焦点。
			const handle = this.tui.showOverlay(panel, { nonCapturing: true, ...config.options });
			this.entries.push({ panel, handle });
		}

		this.focusFirstOpenPanel();
	}

	// 在仍打开的面板之间循环焦点。输入：当前面板、方向（1 下一个 / -1 上一个）。
	// 副作用：调用目标句柄 focus() 并请求重绘；当前面板未打开时抛错（调用方状态不一致）。
	// 示例：唯一面板时 direction 无论正负都回到自己；两个面板时 1 与 -1 分别前/后移动。
	focusNext(current: FocusPanel, direction: 1 | -1 = 1): void {
		const openEntries = this.openEntries();
		const currentOpenPosition = openEntries.findIndex((entry) => entry.panel === current);
		if (currentOpenPosition === -1) throw new Error(`Panel ${current.label} is not open`);
		// 加 openEntries.length 再取模，保证 -1 时不出现负下标。
		const nextOpenPosition = (currentOpenPosition + direction + openEntries.length) % openEntries.length;
		this.focusEntryAt(openEntries, nextOpenPosition);
	}

	// 关闭指定面板并把焦点移到剩余面板；最后一个关闭时结束整个 custom。
	// 输入：要关闭的面板；输出：无；副作用：标记 closed、隐藏句柄、可能调用 done。
	dismiss(panel: FocusPanel): void {
		const openEntries = this.openEntries();
		const currentOpenPosition = openEntries.findIndex((candidate) => candidate.panel === panel);
		// 面板已关闭（重复按键）时直接返回，避免重复 hide 或错误聚焦。
		if (currentOpenPosition === -1) return;
		const entry = openEntries[currentOpenPosition];
		if (!entry) throw new Error(`Invalid focus panel index ${currentOpenPosition}`);
		const remainingEntries = openEntries.filter((candidate) => candidate.panel !== panel);

		entry.panel.closed = true;
		entry.handle.hide();
		if (remainingEntries.length === 0) {
			this.close();
			return;
		}

		// 用原位置对新长度取模，关闭中间面板后焦点落到其后的面板（到尾部则回到开头）。
		this.focusEntryAt(remainingEntries, currentOpenPosition % remainingEntries.length);
	}

	// 关闭所有面板并结束 custom。closed 标志保证幂等：先 close 再 dispose 时不会重复 done；
	// 若 dispose 先运行，则 marked closed 后不再调用 done（此时 custom 已由宿主结束）。
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.hidePanels();
		this.done();
	}

	// 控制器自身获得输入时的处理（没有面板被聚焦时）：Ctrl+C/Esc 全关，Tab 重新聚焦第一个面板。
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
		} else if (matchesKey(data, "tab")) {
			this.focusFirstOpenPanel();
		}
	}

	// 渲染控制器信息面板，并通过 isFocused() 实时显示当前焦点属于哪个面板。
	render(width: number): string[] {
		const th = this.theme;
		// find 找不到时 ?. 与 ?? 回退到 Controller，表示焦点在控制器自身。
		const focused = this.entries.find((entry) => entry.handle.isFocused())?.panel.label ?? "Controller";
		return this.box(
			[
				"",
				` Current focus: ${th.fg("accent", focused)}`,
				"",
				" Three overlapping panels above are",
				` ${th.fg("accent", "nonCapturing")} overlays controlled with`,
				" raw OverlayHandle.focus()/hide().",
				"",
				" Type in the focused panel's input.",
				" Focused panel renders on top.",
				"",
				th.fg("dim", " Tab/Shift+Tab = cycle panels"),
				th.fg("dim", " Esc/Ctrl+D = dismiss panel"),
				th.fg("dim", " Ctrl+C = close all"),
				"",
			],
			width,
			"Focus + Input Demo",
		);
	}

	// 宿主销毁时的清理：与 close 不同，这里不再调用 done（custom 已在结束流程中）。
	override dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.hidePanels();
	}

	// 把焦点给第一个仍打开的面板；全部关闭时什么也不做。
	private focusFirstOpenPanel(): void {
		const firstOpen = this.openEntries()[0];
		if (firstOpen) {
			firstOpen.handle.focus();
			this.tui.requestRender();
		}
	}

	// 聚焦给定打开列表中的第 index 个面板。越界说明调用方传入了过期下标，直接抛错。
	private focusEntryAt(entries: FocusPanelEntry[], index: number): void {
		const entry = entries[index];
		if (!entry) throw new Error(`Invalid focus panel index ${index}`);
		entry.handle.focus();
		this.tui.requestRender();
	}

	// 隐藏所有尚未关闭的面板并清空列表；供 close 与 dispose 共用。
	private hidePanels(): void {
		for (const entry of this.entries) {
			if (!entry.panel.closed) {
				entry.panel.closed = true;
				entry.handle.hide();
			}
		}
		this.entries = [];
	}

	// 返回仍打开的面板项（新数组）；焦点循环只在这个子集上进行。
	private openEntries(): FocusPanelEntry[] {
		return this.entries.filter((entry) => !entry.panel.closed);
	}
}

// 焦点演示中的一个输入面板。它不是 custom 主组件，而是 showOverlay 的组件：
// 只有被句柄 focus() 后才收到 handleInput；focused 由 OverlayHandle 设置/读取。
// input 是 pi-tui 的 Input 组件，负责光标与文本编辑；inputs 记录最近按键用于展示。
// 示例：Alpha 获得焦点后按 right，光标右移且 Keys 行出现 →。
class FocusPanel extends BaseOverlay {
	focused = false;
	closed = false;
	readonly label: string;
	private readonly color: FocusPanelColor;
	private readonly controller: FocusDemoController;
	private readonly input = new Input();
	private inputs: string[] = [];

	// 用对象参数接收依赖，避免多个同类型字符串/对象位置混淆。
	// 输入：theme、config（label/color/options）、controller；输出：面板实例；无额外副作用。
	constructor({
		theme,
		config,
		controller,
	}: {
		theme: Theme;
		config: FocusPanelConfig;
		controller: FocusDemoController;
	}) {
		super(theme);
		this.label = config.label;
		this.color = config.color;
		this.controller = controller;
	}

	// 只处理被聚焦面板收到的按键。输入：按键批次；副作用：切换焦点、关闭面板或修改 input 文本。
	// Tab/Shift+Tab 交给控制器循环；Esc/Ctrl+D 关闭自己；Ctrl+C 关闭全部。
	// Return/上下键只记录不转发（演示“拦截”），左右/退格/普通字符既记录又交给 Input 编辑。
	// 示例：按 a 后 input 中出现 a，Keys 行记录 "\"a\""；按 Tab 焦点移到下一个面板。
	handleInput(data: string): void {
		if (matchesKey(data, "tab")) {
			this.controller.focusNext(this);
		} else if (matchesKey(data, "shift+tab")) {
			// 第二个参数 -1 表示反向循环；默认参数为 1。
			this.controller.focusNext(this, -1);
		} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+d")) {
			this.controller.dismiss(this);
		} else if (matchesKey(data, "ctrl+c")) {
			this.controller.close();
		} else if (matchesKey(data, "return")) {
			this.inputs.push("Enter");
		} else if (matchesKey(data, "up")) {
			this.inputs.push("↑");
		} else if (matchesKey(data, "down")) {
			// 上下键不转给 Input（单行输入没有纵向移动），只留下记录。
			this.inputs.push("↓");
		} else if (matchesKey(data, "left")) {
			this.input.handleInput(data);
			this.inputs.push("←");
		} else if (matchesKey(data, "right")) {
			this.input.handleInput(data);
			this.inputs.push("→");
		} else if (matchesKey(data, "backspace")) {
			this.input.handleInput(data);
			this.inputs.push("Backspace");
		} else {
			// 其余按键原样交给 Input；JSON.stringify 让空白/控制字符在记录里可见（如换行显示为 \n）。
			this.input.handleInput(data);
			this.inputs.push(JSON.stringify(data));
		}
	}

	// 绘制带边框的面板。输入：可用宽度；输出：行数组；无副作用（除同步 input.focused）。
	// 边框颜色随焦点变化：聚焦时用面板配置色，否则 dim；每行补齐到内宽，保证右边框对齐。
	render(width: number): string[] {
		const th = this.theme;
		// 左右各一列边框，内宽至少 1，避免负数宽度。
		const innerW = Math.max(1, width - 2);
		const border = (c: string) => th.fg(this.focused ? this.color : "dim", c);
		// 第四个参数 true 让结果补齐到 innerW，否则短行会让 │ 右边框错位。
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		// 只展示最近 6 个按键，防止历史记录无限撑宽；空时显示 (none)。
		const recent = this.inputs.length === 0 ? "(none)" : this.inputs.slice(-6).join(" ");
		const lines: string[] = [];

		// Input 的 focused 字段控制其光标显示；面板未聚焦时内嵌输入框也不显示光标。
		this.input.focused = this.focused;
		// render 返回行数组；解构默认值 "" 处理空数组，避免下面拼接 undefined。
		const [inputLine = ""] = this.input.render(Math.max(1, innerW - 8));
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(
			border("│") +
				padLine(
					` ${th.fg(this.color, this.label)} ${this.focused ? th.fg("success", "FOCUSED") : th.fg("dim", "visible")}`,
				) +
				border("│"),
		);
		lines.push(border("│") + padLine("") + border("│"));
		lines.push(border("│") + padLine(` Input: ${inputLine}`) + border("│"));
		lines.push(border("│") + padLine(` Keys: ${recent}`) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " Tab/Shift+Tab focus")) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " Esc/Ctrl+D dismiss")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}
}

// === Streaming input panel test (/overlay-streaming) ===

// 流式输出 + 输入路由演示的控制器。它创建三个纵向排列的 nonCapturing 输入面板，
// 同时用 interval 模拟流式输出；Tab 在“控制器 → 面板 A → B → C → 控制器”之间轮换焦点。
// focusIndex = -1 表示主面板持有焦点，0..2 对应三个浮层；句柄数组与面板数组一一对应。
// 示例：Tab 两次后焦点在 Panel B，向 B 打字只修改 B 的文本；Simulated streaming 仍每 500ms 追加一行。
class StreamingInputController extends BaseOverlay {
	private tui: TUI;
	private panels: StreamingInputPanel[] = [];
	private handles: OverlayHandle[] = [];
	private focusIndex = -1; // -1 = controller focused, 0-2 = panel focused
	private streamLines: string[] = [];
	private streamInterval: ReturnType<typeof setInterval> | null = null;
	private lineCount = 0;
	private done: () => void;

	// 创建三个面板浮层并启动模拟流。输入：TUI、主题、结束回调；副作用：showOverlay × 3 + setInterval。
	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;

		// Create 3 input panels as non-capturing overlays
		// as const 让两个数组的元素类型收窄为字面量元组，下面的颜色参数才能匹配联合类型。
		const colors = ["error", "success", "accent"] as const;
		const labels = ["Panel A", "Panel B", "Panel C"];

		for (let i = 0; i < 3; i++) {
			const panel = new StreamingInputPanel(
				theme,
				labels[i]!,
				colors[i]!,
				() => this.cycleFocus(),
				() => this.close(),
			);
			// 每块面板高度约 9 行，row 依次错开；col 固定 2，形成左侧一列。
			const handle = this.tui.showOverlay(panel, {
				nonCapturing: true,
				row: 1 + i * 9,
				col: 2,
				width: 35,
			});
			// 面板需要句柄判断自己是否聚焦（isFocused），showOverlay 返回后再回填。
			panel.handle = handle;
			this.panels.push(panel);
			this.handles.push(handle);
		}

		// Start with controller focused (focusIndex = -1)

		// Start simulated streaming
		// 每 500ms 生成一行带本地时间的文本；只保留最近 8 行，模拟滚动窗口。
		this.streamInterval = setInterval(() => {
			this.lineCount++;
			const timestamp = new Date().toLocaleTimeString();
			this.streamLines.push(`[${timestamp}] Streaming line ${this.lineCount}...`);
			if (this.streamLines.length > 8) {
				this.streamLines.shift();
			}
			this.tui.requestRender();
		}, 500);
	}

	// 轮换焦点：先释放当前面板，再推进下标（2 之后回到 -1），最后聚焦新面板。
	// 副作用：handle.unfocus()/focus() 与一次重绘；无返回值。
	private cycleFocus(): void {
		// Unfocus current panel if any
		// 只有焦点在某个浮层上时才需要 unfocus；控制器自己不需要。
		if (this.focusIndex >= 0 && this.focusIndex < this.handles.length) {
			this.handles[this.focusIndex]!.unfocus();
		}

		// Cycle: -1 (controller) → 0 → 1 → 2 → -1 ...
		this.focusIndex++;
		if (this.focusIndex >= this.handles.length) {
			this.focusIndex = -1; // Back to controller
		}

		// Focus new panel if any
		// -1 表示回到控制器，没有浮层句柄需要聚焦。
		if (this.focusIndex >= 0) {
			this.handles[this.focusIndex]!.focus();
		}

		this.tui.requestRender();
	}

	// 清理并结束：停止流、隐藏全部浮层、清空数组，最后调用 done 结束 custom。
	// 无防重入标志；若 dispose 与 Esc 同时触发，第二次调用时 interval 已为 null、数组已空，但 done 可能被调用两次。
	private close(): void {
		if (this.streamInterval) {
			clearInterval(this.streamInterval);
			this.streamInterval = null;
		}
		for (const handle of this.handles) handle.hide();
		this.handles = [];
		this.panels = [];
		this.done();
	}

	// 控制器自身获得焦点时的按键：Esc/Ctrl+C 全关，Tab 进入第一个面板。
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
		} else if (matchesKey(data, "tab")) {
			this.cycleFocus();
		}
	}

	// 渲染控制器面板：焦点标签、模拟流最后 8 行、固定分隔线与操作提示。
	// 输入：宽度；输出：行数组；无副作用。
	render(width: number): string[] {
		const th = this.theme;
		// focusIndex 为 -1 时显示控制器；否则查面板数组，理论上不会越界。
		const focusedLabel =
			this.focusIndex === -1
				? th.fg("success", "Controller (this panel)")
				: (this.panels[this.focusIndex]?.label ?? "?");

		const lines = [
			"",
			` Current focus: ${th.fg("accent", focusedLabel)}`,
			"",
			" Simulated streaming output:",
			th.fg("dim", " ─".repeat((width - 2) / 2)),
		];

		// 按时间顺序追加当前保留的流式行；旧行已在 interval 中被 shift 掉。
		for (const line of this.streamLines) {
			lines.push(` ${th.fg("dim", line)}`);
		}

		// 补空行到固定高度，避免流式行数变化导致下方提示上下跳动。
		while (lines.length < 12) {
			lines.push("");
		}

		lines.push(th.fg("dim", " ─".repeat((width - 2) / 2)));
		lines.push("");
		lines.push(` Three ${th.fg("accent", "nonCapturing")} input panels on the left.`);
		lines.push(" Tab cycles: Controller → Panel A → B → C → Controller");
		lines.push(" Type in each panel to test input routing.");
		lines.push("");
		lines.push(th.fg("dim", " Tab = cycle focus | Esc = close all"));
		lines.push("");

		return this.box(lines, width, "Streaming + Input Test");
	}

	// 宿主销毁兜底：与 close 相同，确保 interval 与浮层都不会残留。
	override dispose(): void {
		this.close();
	}
}

// 流式演示中的一个简单输入浮层。实现 pi-tui 的 Component 接口（handleInput/render/invalidate），
// 不继承 BaseOverlay，因此自己画边框；焦点状态来自控制器回填的 OverlayHandle。
// 与 FocusPanel 的区别：这里不内嵌 Input 组件，只保存一个字符串，行为更容易预期。
// 示例：Panel B 获得焦点后按 x，只有 B 的 typed 变为 x，另外两块保持原样。
class StreamingInputPanel implements Component {
	handle: OverlayHandle | null = null;
	private theme: Theme;
	private typed = "";
	readonly label: string;
	private color: "error" | "success" | "accent";
	private onTab: () => void;
	private onClose: () => void;

	// 通过回调把 Tab/Esc 上抛给控制器，面板本身不决定焦点顺序。
	// 输入：theme、label、color、onTab、onClose；输出：组件实例；无副作用。
	constructor(
		theme: Theme,
		label: string,
		color: "error" | "success" | "accent",
		onTab: () => void,
		onClose: () => void,
	) {
		this.theme = theme;
		this.label = label;
		this.color = color;
		this.onTab = onTab;
		this.onClose = onClose;
	}

	// 只有聚焦面板会收到输入。Tab 交给 onTab 继续轮换；Esc/Ctrl+C 关闭全部；
	// Backspace 删除末尾字符；其余只接受单字符可打印输入。
	// 示例：输入 "ab" 后按 Backspace，typed 回到 "a"；方向键（多字节序列）被忽略。
	handleInput(data: string): void {
		if (matchesKey(data, "tab")) {
			this.onTab();
		} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		} else if (matchesKey(data, "backspace")) {
			this.typed = this.typed.slice(0, -1);
		} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.typed += data;
		}
	}

	// 绘制面板。输入：宽度；输出：行数组；无副作用。
	// 边框始终使用配置主题色，聚焦时用 ●/○ 与说明文字区分，便于同时观察多块面板。
	render(width: number): string[] {
		const th = this.theme;
		// handle 在构造后由控制器回填；isFocused() 每次渲染时读取实时状态。
		const focused = this.handle?.isFocused() ?? false;
		const innerW = Math.max(1, width - 2);
		const border = (c: string) => th.fg(this.color, c);
		// 只补空格不截断：调用方需保证传入文本不超过 innerW（label/提示都是短文本）。
		const padLine = (s: string) => {
			const w = visibleWidth(s);
			return s + " ".repeat(Math.max(0, innerW - w));
		};

		// 无输入时显示占位；有输入时显示原文。
		const inputDisplay = this.typed.length > 0 ? this.typed : th.fg("dim", "(type here)");
		// 输入行可能很长，截断到内宽并用 pad=true 补齐，保证右边框对齐。
		const truncatedInput = truncateToWidth(` > ${inputDisplay}`, innerW, "...", true);

		const lines: string[] = [];
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + padLine(` ${th.fg("accent", this.label)}`) + border("│"));
		lines.push(border("│") + padLine("") + border("│"));
		if (focused) {
			lines.push(border("│") + padLine(th.fg("success", " ● FOCUSED")) + border("│"));
			lines.push(border("│") + padLine(th.fg("dim", " (receiving input)")) + border("│"));
		} else {
			lines.push(border("│") + padLine(th.fg("dim", " ○ unfocused")) + border("│"));
			lines.push(border("│") + padLine("") + border("│"));
		}
		lines.push(border("│") + padLine(truncatedInput) + border("│"));
		lines.push(border("│") + padLine("") + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " Tab | Esc")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	// Component 接口要求的方法：本组件每次 render 都从字段现算，没有缓存需要清空。
	invalidate(): void {}
}
