/**
 * DOOM Component for overlay mode
 *
 * Renders DOOM frames using half-block characters (▀) with 24-bit color.
 * Height is calculated from width to maintain DOOM's aspect ratio.
 */

/**
 * 文件导读（doom-overlay 的 TUI 组件与渲染）
 *
 * 所属与用途：本文件属于 `doom-overlay` 示例，实现覆盖层组件：定时推进 DOOM、把 RGBA 帧
 * 转成带 24 位颜色的半块字符、处理键盘输入，并在退出时关闭定时器。它不加载 WASM、不查找 WAD。
 *
 * 上游如何进入：`index.ts` 的 `/doom-overlay` handler 通过 `ctx.ui.custom(...)` 创建
 * `DoomOverlayComponent`；TUI 负责调用 `render`、`handleInput`、`invalidate` 和 `dispose`。
 * 下游依赖：`DoomEngine`（tick、帧缓冲、pushKey）与 `doom-keys.ts`（按键映射），
 * 以及 pi-tui 的 `Component`/`TUI`/`isKeyRelease`。
 *
 * 能力清单：
 * - `renderHalfBlock`：纯函数，把 RGBA 帧最近邻采样成 ANSI 半块字符串行。
 * - `DoomOverlayComponent`：实现 `Component`，含构造、游戏循环、输入处理、渲染与清理。
 * - `wantsKeyRelease = true`：请求 TUI 把按键松开事件也送来，以支持按住移动。
 *
 * 典型运行顺序：构造（可选模拟 Pause 恢复）-> 启动 35 FPS 定时器 -> TUI 反复调用 render ->
 * 按键进入 handleInput -> 按 Q 或 WASM 抛错时 dispose + onExit -> TUI 关闭覆盖层。
 *
 * 示例（真实构造，需要已初始化的引擎）：
 *   const component = new DoomOverlayComponent(tui, engine, () => done(undefined), false);
 *   const lines = component.render(80); // 25 行图像 + 1 行页脚
 * 真实使用时不要手写构造，`ctx.ui.custom` 会管理生命周期。
 *
 * 建议阅读顺序：先看 `renderHalfBlock` 的颜色/采样，再看类字段与构造，随后是循环、输入、渲染。
 *
 * 边界：渲染高度只由宽度和最小 10 行决定，组件不知道终端实际高度；覆盖层的 `maxHeight`
 * 可能裁剪显示。`renderHalfBlock` 不做尺寸/长度校验，帧数据必须与 width/height 匹配。
 */

import type { Component } from "@earendil-works/pi-tui";
import { isKeyRelease, type TUI } from "@earendil-works/pi-tui";
import type { DoomEngine } from "./doom-engine.ts";
import { DoomKeys, mapKeyToDoom } from "./doom-keys.ts";

/**
 * 把 RGBA 帧最近邻采样成终端半块字符行。
 *
 * 输入：`rgba`（按 R/G/B/A 排列的字节）、源宽高、目标列数与目标行数。
 * 输出：`targetRows` 个字符串，每个字符串含 `targetCols` 个半块字符和 ANSI 颜色序列。
 * 副作用：无；不写终端、不修改输入数组。实际绘制由 TUI 读取返回值完成。
 * 错误路径：无显式校验。若 `rgba` 长度小于 `width*height*4`，越界索引得到 undefined，
 * 由 `?? 0` 兜底成黑色；若源尺寸或目标尺寸为 0，循环可能不执行，或索引落在 0，
 * 同样不会抛错。
 * 主要流程：按目标行列遍历 -> 每格映射到源图上下两个像素 -> 读取 RGB（忽略 alpha） ->
 * 用 `▀` 的上半像素前景色和下半像素背景色拼接 ANSI -> 行末重置颜色。
 *
 * 示例：`renderHalfBlock(rgba, 640, 400, 2, 1)` 返回一个字符串（1 行），其中包含 2 个 `▀`
 * 和每个半块的前景/背景色控制序列；不会返回换行符。
 */
function renderHalfBlock(
	// Uint8Array 按 R/G/B/A 顺序存字节；TS 类型不核对长度与尺寸是否匹配。
	rgba: Uint8Array,
	// 源图像每行像素数。
	width: number,
	// 源图像行数。
	height: number,
	// 输出每行的终端格数。
	targetCols: number,
	// 输出行数；每行利用上下半块表示两条采样线。
	targetRows: number,
): string[] {
	// 类型注解 string[] 只允许数组元素为字符串。
	const lines: string[] = [];
	// 每个目标列对应的源横向跨度。
	const scaleX = width / targetCols;
	// 每条半块像素线对应的源纵向跨度。
	const scaleY = height / (targetRows * 2);

	// 逐行构造输出。
	for (let row = 0; row < targetRows; row++) {
		// 当前行字符串会在内层循环累加，因此用 let。
		let line = "";
		// 向下取整得到上半块的源纵坐标，使用最近邻采样。
		const srcY1 = Math.floor(row * 2 * scaleY);
		// 下半块在同一终端行中的第二条采样线。
		const srcY2 = Math.floor((row * 2 + 1) * scaleY);

		// 逐列添加一个带颜色的半块。
		for (let col = 0; col < targetCols; col++) {
			// 把目标列映射到源列。
			const srcX = Math.floor(col * scaleX);
			// 行优先像素下标乘4得到上像素的红色字节地址。
			const idx1 = (srcY1 * width + srcX) * 4;
			// 同样计算下像素首字节。
			const idx2 = (srcY2 * width + srcX) * 4;
			// ?? 只在索引结果为 null/undefined 时补0；合法的颜色值0保留。
			const r1 = rgba[idx1] ?? 0,
				// 逗号连接同一 const 声明的绿色变量。
				g1 = rgba[idx1 + 1] ?? 0,
				// 上像素蓝色字节；alpha 未读取。
				b1 = rgba[idx1 + 2] ?? 0;
			// 读取下像素红色，越界时黑色兜底。
			const r2 = rgba[idx2] ?? 0,
				// 下像素绿色。
				g2 = rgba[idx2 + 1] ?? 0,
				// 下像素蓝色。
				b2 = rgba[idx2 + 2] ?? 0;
			// 38;2设置24位前景、48;2设置背景；模板插值写入上下颜色，再追加半块字符。
			// 每行末尾重置 ANSI，避免后续组件继承颜色。
			line += `\x1b[38;2;${r1};${g1};${b1}m\x1b[48;2;${r2};${g2};${b2}m▀`;
		}
		line += "\x1b[0m";
		// 完成当前行后加入结果；这里只处理图像本身，页脚由 render 另外追加。
		lines.push(line);
	}
	// 返回各行；实际终端绘制由 TUI 完成。
	return lines;
}

/**
 * 覆盖层组件：把 DOOM 引擎接入 Pi 的 TUI 生命周期。
 *
 * 职责：保存引擎与 TUI 引用；按 35 FPS 推进引擎并请求重绘；把输入翻译后交给引擎；
 * 在退出或异常时停止定时器并通知调用方。不负责引擎初始化和覆盖层布局。
 *
 * 错误处理：只有定时回调中的同步异常会被捕获并当作退出；`handleInput` 与 `render`
 * 内的异常由 TUI 调用方处理。
 * 示例：`new DoomOverlayComponent(tui, engine, () => done(undefined), true)` 会先模拟一次
 * Pause 键恢复游戏，再开始循环。
 */
export class DoomOverlayComponent implements Component {
	// 保存外部引擎引用，dispose 不销毁它，方便下次恢复。
	private engine: DoomEngine;
	// 保存 TUI 引用，用来请求重新渲染。
	private tui: TUI;
	// ReturnType<typeof setInterval> 从函数类型推导定时器句柄；null 表示无定时器。
	private interval: ReturnType<typeof setInterval> | null = null;
	// 无参数且返回void的退出回调，由外部负责关闭覆盖层。
	private onExit: () => void;

	// Opt-in to key release events for smooth movement
	// 允许 TUI 把 Kitty 松开事件交给本组件；否则默认会被上层过滤。
	wantsKeyRelease = true;

	/**
	 * 创建组件并启动游戏循环。
	 *
	 * 输入：`tui`（用于请求重绘）、已初始化但通常处于暂停状态的 `engine`、
	 * 无参退出回调 `onExit`、可选的 `resume`（默认 false）。
	 * 输出：实例。副作用：立即注册 35 FPS 定时器；`resume=true` 时还向引擎推入一次
	 * Pause 按下/松开（DOOM 的 Pause 是切换键，因此可解除上次暂停）。
	 * 错误路径：构造函数不初始化引擎，因此不会因 WASM 加载失败而抛错；`pushKey` 的同步异常
	 * 会直接向上抛。
	 * 示例：`new DoomOverlayComponent(tui, engine, () => done(undefined))` 不会恢复暂停，
	 * 适合第一次打开游戏的场景。
	 */
	constructor(tui: TUI, engine: DoomEngine, onExit: () => void, resume = false) {
		// 保存 TUI。
		this.tui = tui;
		// 保存共享引擎，构造函数本身不调用 init。
		this.engine = engine;
		// 保存调用方退出函数，之后异常或 Q 键会调用。
		this.onExit = onExit;

		// Unpause if resuming
		// 默认 false 不触发；true 才模拟切换暂停状态。
		if (resume) {
			// 先排入 Pause 按下。
			this.engine.pushKey(true, DoomKeys.KEY_PAUSE);
			// 紧接着排入松开。
			this.engine.pushKey(false, DoomKeys.KEY_PAUSE);
		}

		// 立即注册重复定时回调。
		this.startGameLoop();
	}

	/**
	 * 启动约 35 FPS 的推进/重绘循环。
	 *
	 * 输入/输出：无参数、无返回值。
	 * 副作用：设置 `this.interval`；每 1000/35 毫秒调用一次 `engine.tick()` 与 `tui.requestRender()`。
	 * 错误路径：定时回调内的任意同步异常都被捕获，随后 `dispose()` 并调用 `onExit()`；
	 * 异常对象被丢弃，不区分 WASM 退出与渲染错误。
	 * 流程：setInterval -> try tick+requestRender -> catch 清理并退出。
	 * 注意：方法本身不防止重复调用；正常只由构造函数调用一次。定时器不保证精确的 35 FPS，
	 * 终端或事件循环繁忙时会延迟。
	 * 示例：`component.startGameLoop()` 后约 28.6ms 执行第一次 tick（真实计时由事件循环决定）。
	 */
	private startGameLoop(): void {
		// setInterval 返回句柄保存在实例，回调箭头函数保留当前 this。
		this.interval = setInterval(() => {
			// 只捕获本次推进和 requestRender 的同步异常。
			try {
				// 推进引擎一次，可能改写 C 帧缓冲。
				this.engine.tick();
				// 安排 TUI 重绘，调用本身不是直接写一整帧到终端。
				this.tui.requestRender();
				// 不检查错误种类，所有同步异常都按退出处理。
			} catch {
				// WASM error (e.g., exit via DOOM menu) - treat as quit
				// 先停止后续定时调用；引擎本身仍留在 index.ts 的缓存中，下次可恢复。
				this.dispose();
				// 通知调用方结束覆盖层（handler 中的 await 随之返回）。
				this.onExit();
			}
			// 间隔以毫秒给出；事件循环调度不保证精确35FPS。
		}, 1000 / 35);
	}

	/**
	 * 处理 TUI 交付的一段键盘输入。
	 *
	 * 输入：`data`，原始终端字符串，可能是普通字符、转义序列或 Kitty 协议序列。
	 * 输出：无。副作用：向引擎按键队列推入事件；Q 会先推入 Pause 再停止循环并退出。
	 * 错误路径：不抛错；无法映射的输入直接忽略。Q 的识别只匹配裸 `"q"`/`"Q"` 的按下，
	 * 不处理 Kitty 编码的 q，因此某些终端下 Q 可能不会退出。
	 * 流程：Q 按下 -> 暂停并退出；否则映射键码 -> 根据 `isKeyRelease` 决定按下/松开 ->
	 * 逐个 `pushKey`。
	 * 示例：`handleInput("w")` 推入一次 KEY_UPARROW 按下；`handleInput("\x1b[119;...u")`
	 * 若被识别为松开，则推入松开事件。该函数不返回实际的 key 数组。
	 */
	handleInput(data: string): void {
		// Q to pause and exit (but not on release)
		// 只把非松开事件的裸 q/Q 当退出；这里没有通用 Kitty q 解析。
		if (!isKeyRelease(data) && (data === "q" || data === "Q")) {
			// Send DOOM's pause key before exiting
			// 退出前用 Pause 的按下/松开暂停引擎，以便下次恢复。
			this.engine.pushKey(true, DoomKeys.KEY_PAUSE);
			this.engine.pushKey(false, DoomKeys.KEY_PAUSE);
			this.dispose();
			this.onExit();
			// 不再将 Q 继续当普通游戏键处理。
			return;
		}

		// 一个输入可能映射多个键码，如大写 W 同时表示前进和 Shift。
		const doomKeys = mapKeyToDoom(data);
		// 没有映射结果就结束。
		if (doomKeys.length === 0) return;

		// 查询当前字符串是否为松开事件；不依赖前一次键盘解析的全局状态。
		const released = isKeyRelease(data);

		// 依次向引擎发送这一输入对应的所有键。
		for (const key of doomKeys) {
			// !released 把松开变为false，其余事件均当按下。
			this.engine.pushKey(!released, key);
		}
	}

	/**
	 * 生成当前帧的终端行。
	 *
	 * 输入：`width`，TUI 分配的终端列数（正整数预期）。
	 * 输出：`height` 行图像 + 1 行页脚，每行是含 ANSI 序列的字符串。
	 * 副作用：读取引擎当前帧并分配新数组/字符串；不直接写终端。
	 * 错误路径：不抛错；宽度很小（小于 10*3.2）时图像高度仍取 10 行，页脚可能被截断。
	 * 流程：按 640:200 的终端比例算高 -> 至少 10 行 -> 取 RGBA 帧 -> 半块渲染 ->
	 * 追加暗色页脚 -> 返回。
	 * 示例：`render(80)` 返回约 25 行图像（floor(80/3.2)=25）加 1 行页脚；
	 * 实际显示是否被覆盖层的 maxHeight 裁剪由 TUI 决定。
	 */
	render(width: number): string[] {
		// DOOM renders at 640x400 (1.6:1 ratio)
		// With half-block characters, each terminal row = 2 pixels
		// So effective ratio is 640:200 = 3.2:1 (width:height in terminal cells)
		// Add 1 row for footer
		// 每行两像素，640:400源图转成640:200终端格比例。
		const ASPECT_RATIO = 3.2;
		// 最小图像高为10个终端行。
		const MIN_HEIGHT = 10;
		// 先宽除比例向下取整，再取最小高度限制。
		const height = Math.max(MIN_HEIGHT, Math.floor(width / ASPECT_RATIO));

		// 从引擎复制出当前完整 RGBA 帧。
		const rgba = this.engine.getFrameRGBA();
		// 按输入宽高采样为半块图像行。
		const lines = renderHalfBlock(rgba, this.engine.width, this.engine.height, width, height);

		// Footer
		// 固定帮助文本，内容保持原示例。
		const footer = " DOOM | Q=Pause | WASD=Move | Shift+WASD=Run | Space=Use | F=Fire | 1-7=Weapons";
		// 超宽时按 JS 字符索引截取；此字符串为 ASCII，所以可直接用length作为列数。
		const truncatedFooter = footer.length > width ? footer.slice(0, width) : footer;
		lines.push(`\x1b[2m${truncatedFooter}\x1b[0m`);

		// 返回图像行加页脚。
		return lines;
	}

	/**
	 * 让 TUI 知道组件缓存失效。
	 *
	 * 输入/输出：无参数、无返回值。
	 * 副作用：无。本组件不缓存渲染结果，每帧都从引擎读取，因此不需要清理。
	 * 示例：TUI 调用 `invalidate()` 后仍会正常调用 `render(width)`；不会改变游戏状态。
	 */
	invalidate(): void {}

	/**
	 * 停止游戏循环。
	 *
	 * 输入/输出：无参数、无返回值。
	 * 副作用：清除定时器并把句柄设为 null；可重复调用。不会销毁或释放共享的 DOOM 引擎，
	 * 因此引擎状态（暂停位置）保留给下一次覆盖层使用。
	 * 错误路径：无。
	 * 示例：`component.dispose(); component.dispose();` 第二次是空操作。
	 */
	dispose(): void {
		// 只有持有定时器句柄时清理。
		if (this.interval) {
			// 取消后续定时回调。
			clearInterval(this.interval);
			// 重置句柄以标记已停止。
			this.interval = null;
		}
	}
}
