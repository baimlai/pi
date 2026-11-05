// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：继承 CustomEditor，在输入框渲染时把 “ultrathink” 的每个字母染成彩虹色，并用定时帧让高光
//   在字母间移动；文本包含该词时启动动画，删除后停止。
// 上游：`pi --extension ./examples/extensions/rainbow-editor.ts` 加载；session_start 安装编辑器工厂。
// 下游：super.render 得到普通编辑器行，再对每行做正则替换，注入 24 位真彩色 ANSI；this.tui.requestRender
//   驱动动画帧。只影响显示，getText 仍是纯文本，不改变输入内容。
// 能力：
//   COLORS / RESET       七个基础 RGB 与样式重置序列。
//   brighten()           按系数把颜色向白色提亮并返回 SGR 序列。
//   colorize()           逐字符上色并叠加高光。
//   RainbowEditor        自定义编辑器：检测关键词、启动/停止动画、渲染时着色。
//   默认导出函数          在 session_start 安装编辑器工厂。
// 典型顺序：加载 -> 输入 ultrathink -> handleInput 检测到关键词 -> 启动 60ms 定时器 -> 每帧重绘 ->
//   删除关键词 -> 停止定时器。
// 示例：输入 “ultrathink” 后字母呈彩虹色，高光每 60ms 向右移动；删除后恢复普通文字。
// 阅读顺序：先看颜色工具函数，再看动画生命周期，最后看 render 的后处理。

/**
 * Rainbow Editor - highlights "ultrathink" with animated shine effect
 *
 * Usage: pi --extension ./examples/extensions/rainbow-editor.ts
 */

// CustomEditor 是宿主提供的 Editor 子类基类；ExtensionAPI 仅作类型使用。
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Base colors (coral → yellow → green → teal → blue → purple → pink)
// 元组数组类型 [number, number, number][] 保证每个元素恰好三个分量；
// 值按字符下标取模循环，所以长单词会重复颜色序列。
const COLORS: [number, number, number][] = [
	[233, 137, 115], // coral
	[228, 186, 103], // yellow
	[141, 192, 122], // green
	[102, 194, 179], // teal
	[121, 157, 207], // blue
	[157, 134, 195], // purple
	[206, 130, 172], // pink
];
// SGR 0 重置所有样式，避免颜色泄漏到后续文本。
const RESET = "\x1b[0m";

// 提亮颜色并生成前景色 SGR。输入：RGB 元组、0..1 系数；输出：`\x1b[38;2;r;g;b m` 字符串（无分号前空格）。
// 公式 c + (255 - c) * factor 让每个分量向白色插值；factor=0 保持原色，1 变成白色。
// 纯函数，无副作用。示例：brighten([0,0,0], 0.7) 得到较亮的灰色前景序列。
function brighten(rgb: [number, number, number], factor: number): string {
	// map 返回 number[]，解构为三个分量；Math.round 避免小数进入 SGR。
	const [r, g, b] = rgb.map((c) => Math.round(c + (255 - c) * factor));
	// 38;2 表示 24 位真彩色前景，后接 R;G;B。
	return `\x1b[38;2;${r};${g};${b}m`;
}

// 给一段文字逐字符上色。输入：text、高光位置 shinePos（-1 表示无高光）；输出：带 ANSI 的字符串。
// [...text] 按码点拆分，避免把 emoji 的代理对拆成两个字符；下标用于选基础色和计算高光距离。
// 示例：colorize("ultrathink", 0) 让第一个字母最亮、第二个略亮，其余为原色。
function colorize(text: string, shinePos: number): string {
	return (
		[...text]
			.map((c, i) => {
				// 颜色循环：i 与 7 取模；! 是非空断言，索引始终在范围内。
				const baseColor = COLORS[i % COLORS.length]!;
				// 3-letter shine: center bright, adjacent dimmer
				// 高光有三格：中心 0.7，左右相邻 0.35，其余不额外提亮。
				let factor = 0;
				if (shinePos >= 0) {
					const dist = Math.abs(i - shinePos);
					if (dist === 0) factor = 0.7;
					else if (dist === 1) factor = 0.35;
				}
				// 每个字符前插入自己的前景色；字符本身不转义。
				return `${brighten(baseColor, factor)}${c}`;
			})
			.join("") + RESET
	);
}

// 彩虹编辑器。状态：animationTimer 非空表示动画运行中；frame 用于计算高光位置。
// 继承 CustomEditor 后，输入/光标/提交等行为沿用父类，只额外拦截渲染与按键检测。
class RainbowEditor extends CustomEditor {
	private animationTimer?: ReturnType<typeof setInterval>;
	private frame = 0;

	// 检查输入框纯文本是否含关键词（忽略大小写）。getText 返回原始文本，不含渲染用的 ANSI。
	// 正则没有 g 标志，test 不会在多次调用间保留 lastIndex。
	private hasUltrathink(): boolean {
		return /ultrathink/i.test(this.getText());
	}

	// 启动动画；已有定时器时直接返回，避免重复 interval。
	// 每 60ms 增帧并请求重绘（约 16 FPS），实际节奏受事件循环影响。
	private startAnimation(): void {
		if (this.animationTimer) return;
		this.animationTimer = setInterval(() => {
			this.frame++;
			this.tui.requestRender();
		}, 60);
	}

	// 停止动画并清空引用；重复调用安全。
	private stopAnimation(): void {
		if (this.animationTimer) {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}
	}

	// 每次按键先交给父类完成编辑，再根据最新文本决定启动或停止动画。
	// 副作用：可能创建/清除定时器；不改变按键本身的行为。
	handleInput(data: string): void {
		super.handleInput(data);
		if (this.hasUltrathink()) {
			this.startAnimation();
		} else {
			this.stopAnimation();
		}
	}

	// 渲染并着色。输入：宽度；输出：父类行数组的副本（map 生成新数组）。
	// cycle 0..19：前 10 帧高光位置 0..9，后 10 帧 shinePos=-1 暂停，形成移动后停顿的循环。
	// 正则 /ultrathink/gi 在每行内全局替换；若单词被换行拆开，跨行部分不会被着色。
	render(width: number): string[] {
		// Cycle: 10 shine positions + 10 pause frames
		const cycle = this.frame % 20;
		const shinePos = cycle < 10 ? cycle : -1; // -1 means no shine (pause)
		return super.render(width).map((line) => line.replace(/ultrathink/gi, (m) => colorize(m, shinePos)));
	}
}

// 扩展入口。输入：宿主 API；输出：无；副作用是注册 session_start 处理器。
// 每个会话启动时安装编辑器工厂；工厂在 UI 需要编辑器时创建 RainbowEditor。
export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		// 工厂参数顺序固定 (tui, theme, keybindings)，原样传给父类构造。
		ctx.ui.setEditorComponent((tui, theme, kb) => new RainbowEditor(tui, theme, kb));
	});
}
