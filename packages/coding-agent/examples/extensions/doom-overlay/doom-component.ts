/**
 * DOOM Component for overlay mode
 *
 * Renders DOOM frames using half-block characters (▀) with 24-bit color.
 * Height is calculated from width to maintain DOOM's aspect ratio.
 */

import type { Component } from "@earendil-works/pi-tui";
import { isKeyRelease, type TUI } from "@earendil-works/pi-tui";
import type { DoomEngine } from "./doom-engine.ts";
import { DoomKeys, mapKeyToDoom } from "./doom-keys.ts";

// 把 RGBA 帧缩放成终端半块字符行，输入源尺寸和目标列/行数，返回带 ANSI 颜色的 string[]。
// 每格采样上下两个像素，用前景/背景色绘制 ▀，忽略 alpha；纯计算且不写终端。
// 例：目标2列1行得到一条含2个半块的字符串，外加颜色控制序列；尺寸未在这里校验。
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
		// 完成当前行后加入结果。
		// 以 ANSI 暗色追加页脚并恢复样式。
		lines.push(line);
	}
	// 返回各行；实际终端绘制由 TUI 完成。
	return lines;
}

// implements 让 TS 检查 Component 所需方法；实例负责定时推进、输入转译与帧渲染。
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

	// 输入 TUI、已准备的引擎、退出回调和可选恢复标记；保存引用，必要时切换暂停，再启动定时循环。
	// 构造立即产生定时器副作用；例：resume=true 时模拟一次 Pause 按下/松开，以恢复上次暂停的游戏。
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

	// 无参数和返回值，启动约35次/秒定时推进并请求重绘；异常视作退出并清定时器。
	// 例：引擎菜单触发 WASM 异常时关闭覆盖层；该方法未防止重复启动，正常只由构造调用一次。
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
				// 先停止后续定时调用。
				// 清理定时器，引擎仍留在外部缓存。
				this.dispose();
				// 通知调用方结束覆盖层。
				// 完成覆盖层的外部退出回调。
				this.onExit();
			}
			// 间隔以毫秒给出；事件循环调度不保证精确35FPS。
		}, 1000 / 35);
	}

	// 输入终端原始字符串，无返回；Q按下会发暂停并退出，其余键映射成 C 键码事件。
	// 例：w 排入向上按下，Kitty 的 w 松开排入对应松开；未识别输入忽略。
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

	// 输入可用终端列宽，返回带颜色帧和页脚的行数组；会读取帧并分配缩放输出，不写终端。
	// 按3.2比例计算高且至少10行；例：width=64时图像20行，再加1行页脚，没有按终端高度再次裁剪。
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

	// 无缓存需要失效，空实现满足 Component 接口；无输入、返回或副作用。
	invalidate(): void {}

	// 无参数、无返回，清定时器且把句柄重置为空；重复调用安全，不释放共享引擎。
	// 例：退出覆盖层后游戏暂停留存，下次新建组件使用同一引擎。
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
