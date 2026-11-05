// 3D彩蛋的轻量入口：页头标识点击与/arminsayshi走这里，真正动画代码用动态import按需请求。
// 此层只同步决定是否接下这次播放请求，不等待加载、颜色探测或动画结束；不在普通滚动模式播放3D。
// TUI是擦除的类型，TuiAltScreen是真实类，下面instanceof用它判断当前渲染器是否为全屏实现。
import { type TUI, TuiAltScreen } from "@earendil-works/pi-tui";
// import type只取带kind标签的彩蛋参数结构，不因此求值整份3D动画模块。
import type { EasterEgg3d } from "./easter-egg-3d.ts";

/**
 * Plays a 3D easter egg (see easter-egg-3d.ts), which loads on first use. Only fullscreen mode can show it, because
 * it dissolves the rendered screen. The screen is captured before loading. Returns false when it cannot play.
 */
// 尝试接下播放请求，输入宿主与彩蛋参数，立即返回boolean；例普通TUI为false，让Armin调用方走内联版本。
// 全屏中已有可见浮层也返回true但不播放，以免调用方再叠内联动画；加载失败/实现晚些时候不播放，也不会把已返回的true改回false。
// 流程是检查全屏→检查浮层→保存上一帧行→异步加载并委托。浮层可见性回调/取屏幕等同步错误不在try内；import拒绝与动画实现的异步失败由不同Promise路径传播。
function playEasterEgg3d(tui: TUI, egg: EasterEgg3d): boolean {
	// instanceof沿原型链判断类归属，不验证全部字段或构造是否执行；单靠TUI类型注解不会给普通对象加上这个原型链。
	if (!(tui instanceof TuiAltScreen)) return false;
	// hasOverlay按宿主的可见浮层规则判断，命中就把请求视为已处理，不抓屏/加载实现；可见性回调异常仍可同步传播。
	if (tui.hasOverlay()) return true;
	// 取得上一帧逻辑行的数组浅副本，不重新render、不回读真实终端；在等待模块加载前固定这份画面数据。
	const screen = tui.getScreenLines();
	// 动态import返回模块Promise；这里每次仍调用表达式，实际求值/复用由运行时模块缓存决定，不能改为立即加载的普通import。
	import("./easter-egg-3d.ts").then(
		// 成功后交原宿主/快照/参数给实现；它另有playing/浮层门禁，可查颜色后建立动画。then采纳其Promise，本函数未等待，也不等动画被用户关闭。
		(module) => module.playEasterEgg3d(tui, screen, egg),
		// 此空拒绝回调只吞这次import的拒绝，不会吞成功回调内抛错或它返回的Promise拒绝；then派生Promise没有另挂catch。
		() => {},
	);
	// 此时仅安排了异步工作，true不是“动画已显示/已完成”的证明，接口也没有返回可await的动画Promise。
	return true;
}

/** Plays the 3D pi logo, lifting off the header logo whose top-left cell is at `column`, `row`. */
// 页头标识点击入口，接当前宿主与0基列/行，返回void；例(2,1)作为动画起飞位置，不在这里验证坐标范围或启动终端。
// 调用方不拿到布尔结果，因此普通模式未播放时也没有由本函数提供的回退；实现模块加载/动画仍在异步进行。
export function playPiLogo3d(tui: TUI, column: number, row: number): void {
	// 对象字面量给kind判别标签，column/row用属性简写；联合类型只在pi-logo分支要求两坐标。
	playEasterEgg3d(tui, { kind: "pi-logo", column, row });
}

/** Plays the 3D Armin. Returns false when it cannot play, so the caller can fall back to the inline version. */
// /arminsayshi入口，输入宿主立即返回是否由3D路径接下；false时InteractiveMode再创建内联ArminComponent。
// 例如全屏有浮层返回true且本次无动画；不能把返回值当成功播放保证，也不等待用户退出动画。
export function playArmin3d(tui: TUI): boolean {
	// armin联合分支只需要kind，不含标识起点坐标；直接返回辅助函数的同步布尔值。
	return playEasterEgg3d(tui, { kind: "armin" });
}
