/**
 * 顶层登录菜单的 Radius 动画装饰：保留普通 ExtensionSelector 的选择逻辑，只在渲染结果里尝试替换一条选中行。
 * 例选择 Sign in with Radius 时，四种品牌色按时间流过该文字；其他候选仍用普通主题，不调用 Radius 认证服务。
 * 是否替换依“期望首行字符串能否在父输出找到”，不是独立的选中身份判断；计时器只请求重绘，选择/取消/宿主 dispose 负责停表。
 */
/**
 * The `/login` menu with the animated "Sign in with Radius" option. Internal to the interactive mode: the shimmer
 * is Radius-only and is not exposed to other selectors.
 */

// Color/TUI 只作类型，其他是颜色编码/混色/解析与文字组件的运行值；不因导入就调用认证或网络。
import { type Color, foregroundAnsi, mixColors, parseColor, Text, type TUI } from "@earendil-works/pi-tui";
// 共享主题提供当前 ANSI 色彩模式和普通菜单样式。
import { theme } from "../theme/theme.ts";
// 普通字符串选择器负责输入/布局/选择回调，本类只加动画并管理自己的 interval。
import { ExtensionSelectorComponent } from "./extension-selector.ts";

/** The four colors of the Radius logo, in the order they stream across the text. */
// 四个十六进制颜色在模块加载时 map 成 Color；readonly 仅限制 TS 数组写入，parseColor 的颜色值有自身构造规则，不把整个数组自动冻结。
const RADIUS_COLORS: readonly Color[] = ["#4d9abf", "#83ccd2", "#f1be57", "#f09082"].map((hex) => parseColor(hex));
/** Width of each color band, in characters. */
// 每个色带占4个 for...of 字符位置，即 Unicode 码点，不是终端显示列数或完整字素数。
const CHARS_PER_COLOR = 4;
// 每秒相位移动10个上述字符位置，不是每秒重绘10帧。
const CHARS_PER_SECOND = 10;
// 每50毫秒检查一次是否需请求绘制，约20次/秒；调度/终端绘制不保证严格20 FPS。
const ANIMATION_FRAME_MS = 50;

/** Color `text` with the Radius logo colors flowing left to right; `elapsedMs` is the animation time. */
// radiusShimmer 输入文字/经过毫秒，逐码点给相邻色带混色并返回 ANSI 字符串，无终端写入；例如一个英文标题的每个字母取不同相位，末尾只恢复默认前景色，不恢复所有外层样式。
function radiusShimmer(text: string, elapsedMs: number): string {
	// 按当前主题取 truecolor/256color 模式，不在此重新探测终端。
	const mode = theme.getColorMode();
	// 总周期为4色×4位置=16个字符位置，后面模运算让相位循环。
	const cycle = RADIUS_COLORS.length * CHARS_PER_COLOR;
	// 毫秒转秒乘速度，时间流逝时相位继续移动，不靠每帧累加避免丢帧就减速。
	const offset = (elapsedMs / 1000) * CHARS_PER_SECOND;
	// 累积输出字符串，每个码点前带颜色码。
	let result = "";
	// 0起始码点位置；不同于 text.length 的 UTF-16 码元长度。
	let index = 0;
	// for...of 按 Unicode 码点迭代，组合字素仍可拆多次，已有 ANSI 序列也不会被当整体跳过；宿主通常传 Sign in with... 这样的显示文字，本函数不额外验证。
	for (const char of text) {
		// index-offset 可能为负，双重取模把正常有限数归到0..cycle之间；字符位置随 offset 增长呈向右流动。
		const position = (((index - offset) % cycle) + cycle) % cycle;
		// 除4后取整得到当前色带数组下标。
		const band = Math.floor(position / CHARS_PER_COLOR);
		// 去掉整数部分，得到当前色带内0..1之间的相位 t。
		const t = position / CHARS_PER_COLOR - band;
		// Smoothstep keeps each band recognizable while still blending into the next one.
		// smoothstep 的 t²(3-2t) 使两端混色变化平滑，不是线性时间直接混到下一色。
		const amount = t * t * (3 - 2 * t);
		// as Color 只让 TS 接受已按周期算出的数组项，不验证下标或生成新颜色。
		const from = RADIUS_COLORS[band] as Color;
		// 下一色带用模颜色数回到首色，让最后一种色平滑连接第一种。
		const to = RADIUS_COLORS[(band + 1) % RADIUS_COLORS.length] as Color;
		// 在编码后的 sRGB 通道插值，再按主题模式生成前景 ANSI，最后拼当前码点；不是物理线性光混色。
		result += foregroundAnsi(mixColors(from, to, amount, "srgb"), mode) + char;
		// 码点位置加1；宽字符仍只加1，不按其终端占列数加。
		index++;
	}
	// 尾部 SGR39 仅恢复默认前景色，不关闭粗体/背景或恢复之前 accent 色。
	return `${result}\x1b[39m`;
}

/** The "Sign in with Radius" option: `label` is the full option, starting with the animated `text`. */
// label 是完整菜单字符串，text 是预期要着动画的开头；类型不证明 label.startsWith(text)，后面仅按 text.length 切后缀。
type RadiusOption = { label: string; text: string };

/**
 * Swaps the line `ExtensionSelectorComponent` draws for the selected Radius option with the animated one. When the
 * selector's row style changes or the label wraps, the line no longer matches and the option renders normally.
 */
// 子类继承普通选择/取消/导航，用 render 重写装饰父输出；private 只是 TS 访问限制，不在运行时隔离实例字段。
class RadiusLoginMenuComponent extends ExtensionSelectorComponent {
	// 保存 Radius 描述对象引用，readonly 禁字段重绑，不复制/冻结 label/text 所属对象。
	private readonly radiusOption: RadiusOption;
	// 用单调时钟记录构造期起点；未选中时仍计经过时间，重新选中不会从首色重开。
	private readonly animationStart = performance.now();
	// ReturnType<typeof setInterval> 从函数类型取实际句柄类型，|undefined 表示尚未建立或已清；不是泛型执行定时器。
	private animationTimer: ReturnType<typeof setInterval> | undefined;
	// 最近一次 render 是否找到了可替换行，初始 false，因此首次 render 前 interval 不请求刷新。
	private animating = false;

	// 构造接宿主、标题/字符串选项、Radius 描述和选择/取消回调；先把“停表再通知”的包装交给父类，再保存描述、建定时器，返回新选择器。不在此登录/打开网址。
	constructor(
		// 宿主只用于定时请求重画，不接管真实认证。
		tui: TUI,
		// 标题交普通选择器显示。
		title: string,
		// 选项原数组交父类，父类保留引用，不要求字符串唯一。
		options: string[],
		// 含完整标签和普通动画前缀的数据，需与实际选项文字约定一致。
		radiusOption: RadiusOption,
		// 确认通知给外部，不 await 异步结果。
		onSelect: (option: string) => void,
		// 取消通知给外部，停表后即使回调抛错也不重启 interval。
		onCancel: () => void,
	) {
		// super 构造父菜单，传入包装函数而非马上调用选择/取消回调。
		super(
			// 父类显示该标题。
			title,
			// 父类按给定字符串顺序显示候选。
			options,
			// 确认包装接父类回传的非空所选字符串，返回 void；例如选 Radius 时先停动画，再让宿主开始登录。
			(option) => {
				// 先清自己的 interval，避免外部关闭/抛错后还发动画刷新。
				this.stopAnimation();
				// 同步回传原字符串，真实认证由宿主负责。
				onSelect(option);
			},
			// 取消包装同样先停自己的 interval，后通知宿主，无选择值返回。
			() => {
				// 取消前停止动画请求。
				this.stopAnimation();
				// 执行宿主取消函数，本类不自行从组件树移除。
				onCancel();
			},
		);
		// 保存 Radius 描述引用；父构造已建好普通候选列表。
		this.radiusOption = radiusOption;
		// 每50毫秒调一次闭包，真正画动画在 render，不在 interval 回调拼行。
		this.animationTimer = setInterval(() => {
			// 只在上次 render 匹配到行时请求 TUI 重绘；未匹配仍有定时器运行，只是不请求绘制。
			if (this.animating) tui.requestRender();
			// 50ms 是调度间隔，不是强制渲染 deadline。
		}, ANIMATION_FRAME_MS);
		// 有 unref 能力就调用，允许 Node 在仅剩此计时器时退出；不等于清掉定时器，停表仍需 clearInterval。
		this.animationTimer.unref?.();
	}

	// render 先取普通菜单行→构造期望 Radius 选中标签首行→按字符串查找→替换一行，返回新输出数组；例如未匹配样式则保持普通菜单，不修改父类候选 Text 本身。
	// 这里只比 Text.render(width)[0]，不是独立检查 Radius 项身份/完整折行；窄屏折行后仍可能首行匹配，只替换首行，重复候选首行也可能先匹配到其他行，不能把原英文理解为必然安全退回普通整项。
	// override 在 TS 中要求这确实覆盖父方法；运行时仍按普通方法动态派发，super.render 才显式调用父实现。
	override render(width: number): string[] {
		// Container 的父渲染先生成菜单输出；后面改的是此数组，不直接改父候选组件的文本字段。
		const lines = super.render(width);
		// 解构描述对象当时的 label/text，外部改对象字段会影响下一次 render。
		const { label, text } = this.radiusOption;
		// 按父选择器的选中样式构造临时 Text，只取第一行作为精确查找目标；长标签可能有其他行，但此处未取。
		const selectedLine = new Text(theme.fg("accent", "→ ") + theme.fg("accent", label), 1, 0).render(width)[0];
		// 首行缺失用 -1，否则在父行数组按字符串严格相等找第一次出现，不是按组件对象身份查找。
		const index = selectedLine === undefined ? -1 : lines.indexOf(selectedLine);
		// 记录是否找到，供之后 interval 判断是否请求绘制。
		this.animating = index >= 0;
		// 找到一行就尝试动画，未找到保留父输出。
		if (this.animating) {
			// 用“当前单调时间-构造起点”算色彩，不以当前选中持续时长计算。
			const shimmer = radiusShimmer(text, performance.now() - this.animationStart);
			// 动画只给 text 前缀，后缀按 UTF-16 text.length 从 label 切出；未验证前缀一致或过滤 text 内控制序列。
			const animatedLine = theme.fg("accent", "→ ") + shimmer + label.slice(text.length);
			// 用同宽度 Text 渲染动画行且只取首行，缺失兜底空串；父标签折出的其他行仍保留，没有整项替换。
			lines[index] = new Text(animatedLine, 1, 0).render(width)[0] ?? "";
		}
		// 返回这次菜单行数组，不在这里写终端或启动认证。
		return lines;
	}

	// stopAnimation 清计时器并重置字段，返回 void，可重复调用；例如确认/取消先停表，之后宿主 dispose 再停也无妨。之后手动 render 仍可计算颜色，但不会自动重新装 interval。
	private stopAnimation(): void {
		// clearInterval 接已是 undefined 也无操作，不等待已执行的 requestRender 完成。
		clearInterval(this.animationTimer);
		// 丢掉句柄引用，方便再次清理保持无定时器状态。
		this.animationTimer = undefined;
		// 停止请求动画刷新标记，后续 render 可再改它，但句柄不会自动恢复。
		this.animating = false;
	}

	// dispose 停本类 interval 再调用父类清理，返回 void；例如宿主切走菜单时释放计时器，不发选择/取消回调或移除面板本身。
	// override 校验重写关系；宿主即使按父类类型持有对象，调用 dispose 仍进入这个子类实现。
	override dispose(): void {
		// 停止自己的动画资源。
		this.stopAnimation();
		// 父类负责它可能有的倒计时清理；此构造没传倒计时配置，调用仍保持完整继承清理链。
		super.dispose();
	}
}

/** Top-level `/login` selector whose Radius option shimmers in the Radius logo colors while it is selected. */
// createLoginMenuSelector 是工厂入口，接普通菜单参数和 Radius 描述，返回父类接口但实际创建动画子类；例如宿主统一调用 selector.dispose() 仍会动态派发到子类停表。构造有计时器副作用，不自动开始登录。
export function createLoginMenuSelector(
	// TUI 宿主引用只供刷新。
	tui: TUI,
	// 菜单标题原文。
	title: string,
	// 候选字符串数组，选中后原文回传。
	options: string[],
	// Radius 特定的完整 label 与动画 text 约定。
	radiusOption: RadiusOption,
	// 选中回调在停表后执行。
	onSelect: (option: string) => void,
	// 取消回调同样停表后执行。
	onCancel: () => void,
): ExtensionSelectorComponent {
	// 返回新子类实例，静态类型写父类以便与普通 ExtensionSelector 一起用；不会擦掉子类 render/dispose 的运行时重写。
	return new RadiusLoginMenuComponent(tui, title, options, radiusOption, onSelect, onCancel);
}
