// 延迟重建主题文字的Text子类，供交互模式的提示/标题使用；普通Text缓存已着色字符串，本类在invalidate后用build重新取得颜色，不监听主题事件本身。
import { Text } from "@earendil-works/pi-tui";

/**
 * Text whose content applies theme colors. Plain `Text` keeps the colors its string was built with, so
 * a theme change, or the system theme receiving the terminal's colors, would leave it stale. This
 * rebuilds the string from `build` after every invalidation, which the UI performs on theme changes.
 *
 * `build` must return the same content each time, apart from colors. Snapshot changing data before
 * creating the component, or call `invalidate()` after changing state that `build` reads.
 */
// extends继承Text的留白、折行、背景和宽度缓存；build应保持内容稳定，数据变化由外层主动invalidate。
export class ThemedText extends Text {
	// 无参数构建函数返回完整ANSI文字；readonly只防止重赋函数引用，闭包读取的数据仍可变化。
	private readonly build: () => string;
	// 初始为过期，第一次render才执行build，构造不会提前计算文字。
	private stale = true;

	// 保存build并以空文字初始化父类，返回新实例；例闭包返回theme.fg("accent","hello")，首次渲染才套当前颜色。padding默认左右1列/上下1行，不注册计时器或请求重画。
	constructor(build: () => string, paddingX = 1, paddingY = 1) {
		// super先保存空串与留白，继承类再设置自己的字段。
		super("", paddingX, paddingY);
		// 仅保存函数引用，不调用它，避免创建组件时就固定主题颜色。
		this.build = build;
	}

	// 重写缓存失效：先清父类折行缓存，再标记下次重建正文，返回void；例换主题后调用。override由TS检查父类有同名方法，不自动触发渲染。
	override invalidate(): void {
		// 清父类文本/宽度/行数组缓存，不修改父类保存的原文。
		super.invalidate();
		// 下一次render重新调用build，即使width没变也重建。
		this.stale = true;
	}

	// 输入列宽返回主题文字行：过期时build/setText，再用父类折行缓存。例连续同宽render只build一次，换宽度会重折行却不重build；构建/渲染错误直接传播。
	override render(width: number): string[] {
		// 只有初次或主动invalidate后才重建，主题变量改变本身不会自动被发现。
		if (this.stale) {
			// 先清stale再build；若build抛错，下次render不会自动重试，需再次invalidate。
			this.stale = false;
			// 同步调用build取得正文后setText；没有await异步构建，也不请求TUI重画。
			this.setText(this.build());
		}
		// 委托Text按width布局/补边距，返回缓存数组时仍沿用其引用，不做深拷贝。
		return super.render(width);
	}
}
