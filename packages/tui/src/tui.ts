// 定义组件/鼠标/浮层契约及公共TuiBase：负责输入、焦点、浮层布局、渲染调度和终端颜色查询。
// 普通主屏TuiMainScreen与全屏TuiAltScreen继承本类，真正绘制通过doRender钩子完成；这里的requestRender主要安排后续执行。
// 例键盘输入先被协议回复和监听器处理，再交焦点组件，最后排一个低延迟绘制；浮层关闭后按恢复状态决定焦点归属。
// 大多数类型声明只供TS检查，实际终端动作通过注入的Terminal执行；回调/终端写入可抛错，不统一吞异常或回滚状态。
/**
 * Minimal TUI implementation with differential rendering
 */

// 使用单调计时performance.now计算渲染间隔，不依赖可能被校时改变的墙上时钟。
import { performance } from "node:perf_hooks";
// 键匹配支持终端协议并可能更新键解析状态；isKeyRelease是输入子串启发式检测，不是完整协议验证。
import { isKeyRelease, matchesKey } from "./keys.ts";
// Terminal仅作为TS接口导入，运行时接收真实或内存测试实现，不在本文件直接构造ProcessTerminal。
import type { Terminal } from "./terminal.ts";
// 颜色解析函数处理收到的协议串，后面三个type导入在运行时擦除。
import {
	// 把OSC10/11/4颜色回复解成目标及可选RGB；不在此函数里拼接分片。
	parseOscColorResponse,
	// 解析深/浅主题通知，连续报告取最后一个。
	parseTerminalColorSchemeReport,
	// RgbColor约束r/g/b数字字段，不自动验证数值范围。
	type RgbColor,
	// TerminalColorScheme是dark/light字面量联合类型。
	type TerminalColorScheme,
	// TerminalColors允许前景、背景、完整调色板缺失，缺失不是默认黑色。
	type TerminalColors,
} from "./terminal-colors.ts";
// 能力检测冷缓存可能有tmux只读探测；isImageLine只认前缀，setCellDimensions更新共享像素尺寸缓存。
import { getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.ts";
// 这些助手处理ANSI、字素和显示列：切片/取两段/测宽/终端输出规范化都复用同一套规则。
import { extractSegments, normalizeTerminalOutput, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.ts";

/**
 * Component interface - all components must implement this
 */
// 鼠标事件名的字符串字面量联合，TS限制合法拼写；press/release是按下/松开，move/drag是移动/拖动，click是合成点击，wheel是滚轮。
export type TuiMouseEventType = "press" | "release" | "move" | "drag" | "click" | "wheel";
// 按钮名联合；none用于无按下按钮的移动等事件，不表示没有坐标。
export type TuiMouseButton = "left" | "middle" | "right" | "none";

/** Normalized cell-based mouse event. Coordinates are zero-based. */
// 规范化鼠标事件：坐标按终端格而非像素，通常从0计数；接口只声明结构，不负责解析原始鼠标报文。
export interface TuiMouseEvent {
	// 事件种类决定组件处理的动作，比如wheel使用wheelDelta。
	type: TuiMouseEventType;
	// 哪个按钮参与事件，键盘修饰位另列在下方。
	button: TuiMouseButton;
	/** Coordinates local to the receiving component. */
	// 接收组件内部的横向格坐标，嵌套分发时由屏幕坐标减组件原点计算。
	x: number;
	// 组件内部纵向行坐标，父容器会减掉此前子组件累计高度。
	y: number;
	/** Absolute terminal coordinates. */
	// 绝对终端列坐标，跨组件重定向时保持原值。
	screenX: number;
	// 绝对终端行坐标，不是文档逻辑行号。
	screenY: number;
	/** Current component bounds. */
	// 接收组件本次布局宽度，用于判断/换算局部位置。
	width: number;
	// 接收组件本次布局高度。
	height: number;
	// 鼠标事件是否带Shift修饰位。
	shift: boolean;
	// 是否带Alt修饰位。
	alt: boolean;
	// 是否带Ctrl修饰位；字段均是必需boolean，不能靠TS自动填默认。
	ctrl: boolean;
	/** Logical lines. Negative values scroll up. */
	// ?表示字段可省略；滚轮逻辑行数，负值向上，具体加速由上游处理。
	wheelDelta?: number;
	/** Consecutive click count when type is click. */
	// click事件的连续点击次数，例如1单击、2双击，由上游手势逻辑计算。
	clickCount?: number;
}

// 组件鼠标回调的可选结果字段；分发助手把capture/focus也视作已处理，单独render不会构成处理结果。
export interface TuiMouseEventResult {
	/** Stop propagation and suppress renderer-level fallback behavior. */
	// 真值表示已消费，阻止渲染器继续用自己的选择/滚动等退路。
	handled?: boolean;
	/** Route subsequent drag/release events to this component. Implies handled. */
	// 请求后续拖动/松开继续送同一目标；真正记录捕获由全屏分发方执行。
	capture?: boolean;
	/** Give keyboard focus to this component. Implies handled. */
	// 请求键盘焦点，可能保留给代收键盘的父容器而非被点击的最深子组件。
	focus?: boolean;
	/**
	 * Explicitly request or suppress a render. Move and release default to false;
	 * press, click, drag, and wheel default to true.
	 */
	// 显式true/false覆盖是否重绘；省略时全屏分发方按事件种类及焦点是否变化决定。
	render?: boolean;
}

/** Internal target metadata used by containers and alternate-screen dispatch. */
// 保存一次实际鼠标命中的组件及坐标变换，供拖动/松开重定向；这是运行数据的TS描述。
export interface TuiMouseDispatchTarget {
	// 实际接收鼠标的目标组件，可能与键盘focusTarget不同。
	component: Component;
	// 目标左边界的绝对终端列，用screenX-x恢复。
	originX: number;
	// 目标上边界的绝对终端行，用screenY-y恢复。
	originY: number;
	// 捕获时的目标宽度，后续重定向沿用它，不在此重新布局。
	width: number;
	// 捕获时目标高度。
	height: number;
}

/** Result of dispatching to a concrete component. */
// extends把鼠标结果字段纳入此接口，并强化handled为必需的字面量true。
export interface TuiMouseDispatchResult extends TuiMouseEventResult {
	// 已经确定被处理；TS字面量类型比一般boolean更窄，不会额外生成运行时断言。
	handled: true;
	// 命中目标与原点，供后续事件定位。
	target: TuiMouseDispatchTarget;
	/** Keyboard focus target, which may be a delegating parent container. */
	// 可选键盘焦点目标，例如SettingsList子菜单宿主继续代收键盘。
	focusTarget?: Component;
}

/**
 * Dispatch an event to a component and retain the exact target and coordinate
 * transform. Containers use this when forwarding events to nested children.
 */
// 把规范化event送给component.handleMouse，返回含实际目标的处理结果或undefined；可能执行用户回调/抛错，不自行setFocus或安排render。
// 叶子结果会补原点/宽高，容器已转发的结果保留子目标；若宿主还能handleInput且请求focus，则把键盘焦点留给宿主。
// 例如子菜单行被点击后关闭，保留宿主焦点可避免后续键盘还发给已移除的子列表。
export function dispatchMouseEvent(component: Component, event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
	// 可选调用?.在组件没提供handleMouse时得到undefined，否则同步调用一次。
	const result = component.handleMouse?.(event);
	// 没有结果就视为未处理，直接返回undefined。
	if (!result) return undefined;
	// in检测结果是否携带target（包括原型成员），这是项目内部“已经转发”的结构约定，不验证整个target形状。
	if ("target" in result) {
		// The component forwarded the event to a child it hosts. Like a delegating container, it routes
		// keys to that child itself, so it keeps keyboard focus. Focusing the child directly would leave
		// focus on a detached component once the host removes it, e.g. a closed settings submenu.
		// as把内部扩展结果告诉TS，不克隆对象或进行运行时类型转换。
		const forwarded = result as TuiMouseDispatchResult;
		// 请求焦点且当前宿主有键盘回调时，浅拷贝并覆盖focusTarget；否则直接返回同一个转发结果。
		return forwarded.focus && component.handleInput ? { ...forwarded, focusTarget: component } : forwarded;
	}
	// handled/capture/focus都不为真则忽略；仅返回{render:true}不算消费事件。
	if (!result.handled && !result.capture && !result.focus) return undefined;
	// 叶子组件的结果包装成带准确目标的对象。
	return {
		// 先展开原结果，保留render等附加决策；后写字段可覆盖同名值。
		...result,
		// 在capture/focus隐含处理的情形也统一补handled:true。
		handled: true,
		// 只有请求focus时才展开focusTarget字段，不传时展开空对象。
		...(result.focus ? { focusTarget: component } : {}),
		// 嵌套target对象描述实际鼠标接收者，不负责改变键盘焦点。
		target: {
			// 对象属性简写component沿用输入组件引用。
			component,
			// 绝对列减局部列求组件原点，供下一次鼠标事件换算。
			originX: event.screenX - event.x,
			// 绝对行减局部行求原点行。
			originY: event.screenY - event.y,
			// 保存事件所带布局宽度，不重新调用render。
			width: event.width,
			// 保存布局高度。
			height: event.height,
		},
	};
}

/** Recreate local coordinates for a previously dispatched mouse target. */
// 根据已保存target重新计算局部坐标并返回新event，不改原事件/目标、不触发回调；例如原点列10、screenX13得到x3，拖出边界时也可为负。
export function retargetMouseEvent(event: TuiMouseEvent, target: TuiMouseDispatchTarget): TuiMouseEvent {
	// 创建新对象，下面先保留通用事件字段再覆盖目标相关字段。
	return {
		// 展开原事件，包括screenX/screenY、按钮、修饰位与滚轮信息。
		...event,
		// 用绝对列减保存的原点列，未夹到组件宽度。
		x: event.screenX - target.originX,
		// 同理重新计算局部行，可用于组件外的拖动/松开。
		y: event.screenY - target.originY,
		// 重定向沿用捕获时宽度。
		width: target.width,
		// 重定向沿用捕获时高度。
		height: target.height,
	};
}

// 组件共同契约，规定render/invalidate及可选输入能力；interface只在编译时检查，不会替任意对象创建这些方法。
export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	// 按传入显示列宽返回行字符串数组；约定每行尊重宽度，可带ANSI，不等于此方法一定已写终端。
	render(width: number): string[];

	/** Optional handler for keyboard input when component has focus. */
	// 可选键盘方法，焦点组件通过它处理协议输入；返回void，实际回调可能修改状态或抛错。
	handleInput?(data: string): void;

	/** Optional normalized mouse handler. */
	// 可选鼠标方法，返回处理决策或undefined；原始终端报文已由上游规范化。
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	// 默认不接收识别出的松开事件，组件置true才放行；过滤发生在全局监听器/debug之后。
	wantsKeyRelease?: boolean;

	/**
	 * If true while focused, fullscreen viewport keys (`tui.altScreen.*` scrolling and prompt jumps) go to this
	 * component instead of scrolling the transcript, as they do for a focused overlay. Default is false.
	 */
	// 全屏焦点组件可声明接管视口滚动等键；普通基类只提供字段契约，具体路由在TuiAltScreen。
	capturesViewportInput?: boolean;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	// 使组件已有渲染缓存失效，不保证立刻绘制；调用方通常还要requestRender。
	invalidate(): void;
}

// 输入监听器可返回consume消费标记、data替换串或undefined；两个字段均可省略，consume先于data生效。
export type TuiInputListenerResult = { consume?: boolean; data?: string } | undefined;
// 函数类型别名：接收当前处理中的字符串、同步返回上面的决策；不支持Promise结果。
export type TuiInputListener = (data: string) => TuiInputListenerResult;
// 一次终端颜色查询的内部状态，排在队列中按DA1结束标记分组；不代表已经发回任何颜色。
type PendingTerminalColorQuery = {
	// 已返回的默认前景色；未返回/无法解析均可为undefined。
	foreground?: RgbColor;
	// 默认背景色同理，不在缺失时猜颜色。
	background?: RgbColor;
	// 16个槽位，每项RGB或undefined，全部可用时才公开为完整palette。
	palette: Array<RgbColor | undefined>;
	/** Targets that already replied, so duplicates do not count twice. */
	// 按目标名字/索引字符串去重，不能用收到报文总数决定是否齐全。
	replied: Set<string>;
	/**
	 * Receives the result: the promise's resolve until the timeout, then `onLateReply`. Unset once the
	 * query completed (on the DA1 reply or once every color replied); later replies are ignored.
	 */
	// 联合函数类型外加undefined：初始Promise resolve，超时后可换onLateReply，完成后清空防重复投递。
	deliver: ((colors: TerminalColors) => void) | undefined;
	// 本查询超时句柄，clearTimeout用于正常提前完成；stop只清渲染定时器，不遍历取消这些查询。
	timer: NodeJS.Timeout | undefined;
};

// 只请求ANSI调色板0到15共16色，不请求256色全部条目。
const TERMINAL_PALETTE_SIZE = 16;
/** OSC 10 and 11 plus OSC 4 for every palette color. */
// 预期前景/背景2项加16个调色板目标，共18种回复。
const TERMINAL_COLOR_REPLY_COUNT = 2 + TERMINAL_PALETTE_SIZE;
/**
 * Default colors, palette colors 0-15, and a trailing primary device attributes (DA1) request.
 * Every terminal answers DA1 and terminals answer in order, so the DA1 reply marks the end of
 * the color replies, including for terminals that ignore the color queries.
 */
// 模块初始化时生成查询串：OSC10问前景、OSC11问背景，Array.from的index回调依次生成OSC4的0..15询问并join无分隔，最后追加DA1请求。
// 模板插值在此只组字符串，不写终端；DA1按有序回复约定标记本轮结束，未回应时由timeoutMs兜底，不能保证每个终端一定回应。
const TERMINAL_COLOR_QUERY = `\x1b]10;?\x07\x1b]11;?\x07${Array.from(
	{ length: TERMINAL_PALETTE_SIZE },
	(_, index) => `\x1b]4;${index};?\x07`,
).join("")}\x1b[c`;
// 匹配单独一条CSI ?数字/分号 c的DA1回复，允许参数为空；它只是结束标记形状，不校验设备型号。
const DEVICE_ATTRIBUTES_RESPONSE_PATTERN = /^\x1b\[\?[\d;]*c$/;

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
// 可获得焦点的额外结构要求：组件暴露focused供TUI开关，用来决定是否输出硬件光标位置标记。
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	// 必需boolean字段由setFocusInternal切换；组件自己的render根据它决定是否发CURSOR_MARKER。
	focused: boolean;
}

/** Type guard to check if a component implements Focusable */
// 判断Component或null是否具备focused成员，返回类型谓词使真分支同时拥有Component与Focusable；例如Input可被收窄，不执行绘制。
export function isFocusable(component: Component | null): component is Component & Focusable {
	// 只排除null并检查成员存在（可继承），不检查字段当前值是否boolean；依赖项目组件契约而非完整运行时结构验证。
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
// 内部APC零宽标记，焦点组件放在目标显示列之前；渲染器提取后定位实际光标，标记自身不是可见字符。
export const CURSOR_MARKER = "\x1b_pi:c\x07";

/** Fake cursor markers - zero-width APC sequences around the text drawn as the cursor. See resolveFakeCursors(). */
// 伪光标包裹区起点，后面resolveFakeCursors把它变成SGR反色请求。
export const FAKE_CURSOR_START = "\x1b_pi:fc\x07";
// 包裹区终点，解析时关闭反色；不同于CURSOR_MARKER的真实光标定位。
export const FAKE_CURSOR_END = "\x1b_pi:/fc\x07";
// CURSOR_MARKER + FAKE_CURSOR_START + text + FAKE_CURSOR_END. Truncating the line right after the cursor cell drops the end.
// 捕获定位标记和其后伪光标文字，非贪婪匹配到结束标记或串尾；s允许.跨换行，无g所以每次replace只处理首个匹配。
const FOCUSED_FAKE_CURSOR = /(\x1b_pi:c\x07)\x1b_pi:fc\x07(.*?)(?:\x1b_pi:\/fc\x07|$)/s;

/** Wrap text in fake cursor markers. */
// 给text包裹伪光标标记并返回新串，不写终端/改焦点；例renderFakeCursor("a")待渲染时可变成反色a，不对text做转义。
export function renderFakeCursor(text: string): string {
	// 模板插值只连接起点+原文+终点，保留text中的已有控制串。
	return `${FAKE_CURSOR_START}${text}${FAKE_CURSOR_END}`;
}

// 从本模块重导出测显示宽度的同一函数，方便组件作者只导入TUI公共入口。
export { visibleWidth };

/**
 * Anchor position for overlays
 */
// 浮层锚点字符串联合：横/纵位置由后面的resolveAnchorRow/Col分别计算，TS不为字符串生成布局。
export type OverlayAnchor =
	// 可用区水平/垂直居中。
	| "center"
	// 靠左上。
	| "top-left"
	// 靠右上。
	| "top-right"
	// 靠左下。
	| "bottom-left"
	// 靠右下。
	| "bottom-right"
	// 上方水平居中。
	| "top-center"
	// 下方水平居中。
	| "bottom-center"
	// 左侧垂直居中。
	| "left-center"
	// 右侧垂直居中；每行前的|是同一个联合类型的续行。
	| "right-center";

/**
 * Margin configuration for overlays
 */
// 可分别指定四边留白，未提供的边按0处理；数字并未在类型中限定为整数/非负。
export interface OverlayMargin {
	// 顶部留出的终端行数。
	top?: number;
	// 右边留出的列数。
	right?: number;
	// 底部留出的行数。
	bottom?: number;
	// 左边留出的列数。
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
// 类型联合允许绝对number或带%后缀的模板字面量类型；这是TS字符串模式，不执行插值，某些静态允许的负数/指数格式会被后面运行时正则拒绝。
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
// 把可选绝对值/百分比按referenceSize换算，返回数字或undefined，无修改/IO；例"50%"和参考宽81得到40，number原样返回不取整。
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	// 没设置的值返回undefined，让调用方决定默认尺寸。
	if (value === undefined) return undefined;
	// 绝对数字直接返回，NaN/负值/小数也不在此统一校验。
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	// 运行时仅接受非负整数或带小数部分的十进制百分比，不接受负号、指数、空格；不限制百分比<=100。
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	// match成功才有捕获的数字文本。
	if (match) {
		// parseFloat把捕获转数字，乘参考尺寸除100后向下取整；例如33%乘10得到3。
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	// 不符合运行格式的字符串回退undefined，不抛布局格式错误。
	return undefined;
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
// 浮层配置的TS结构：几何按终端格，布局调用时读取；保存的是原options引用，类型不深冻结它。
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	// 宽度数字为列数，百分比以完整终端宽为参考；最终会按扣margin的可用宽夹住。
	width?: SizeValue;
	/** Minimum width in columns */
	// 最小宽度先提升请求值，之后仍受可用宽度上限约束，不能保证物理屏太窄时满足minWidth。
	minWidth?: number;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	// 最大行数或完整终端高的百分比，设置后截掉底部超出行；没设时不自动把浮层高度裁到屏高。
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	// 默认center；有显式row或col时分别覆盖对应轴锚点。
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	// 最终列坐标加offsetX，正数向右，之后还有边界夹取。
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	// 最终行坐标加offsetY，正数向下。
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	// 数字是绝对终端行；百分比作用于扣留白、扣浮层高度后的可移动距离，所以100%贴底而非把起点放到屏底之外。
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	// 列同理：100%按可移动宽度贴右，50%居中。
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	// 单个number应用四边，或分别给OverlayMargin；运行时将各边负数夹0，过大留白不保证还能完整放入物理屏。
	margin?: OverlayMargin | number;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	// 可见性同步回调，输入当前终端宽高，返回boolean；渲染/焦点查询等可多次调用，抛错向外传播。
	visible?: (termWidth: number, termHeight: number) => boolean;
	/** If true, don't capture keyboard focus when shown */
	// true只禁止显示时自动抢焦点；显式handle.focus仍可给它焦点并提升视觉顺序。
	nonCapturing?: boolean;
}

/** Options for {@link OverlayHandle.unfocus}. */
// unfocus可选参数对象的结构，传对象时target字段必须存在，不等同于完全省略options。
export interface OverlayUnfocusOptions {
	/** Explicit target to focus after releasing this overlay. */
	// 显式恢复目标，可为null；blocked临时替代组件仍活跃时会先记录此目标，待替代结束再恢复。
	target: Component | null;
}

/** Last rendered terminal-relative overlay rectangle. */
// 最近一次合成得到的可见浮层终端矩形；坐标0基，宽高为格，不是实时调用render重新计算。
export interface OverlayBounds {
	// 屏内起行，不是正文逻辑行。
	row: number;
	// 屏内起列。
	col: number;
	// 布局分配给浮层的宽度。
	width: number;
	// maxHeight截断后的实际行数。
	height: number;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
// showOverlay返回的控制句柄契约，方法闭包捕获对应条目；类型声明不等于每个操作都立即绘屏。
export interface OverlayHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	// 移除条目并按需要恢复焦点/请求绘制；已移除时hide本身无操作，不应再把此句柄当可重新显示的条目。
	hide(): void;
	/** Temporarily hide or show the overlay */
	// 临时隐藏/显示并更新焦点，通常仍保留栈条目；其可见性还受visible回调影响。
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	// 只读临时hidden标志，不综合visible回调或是否已经从栈移除。
	isHidden(): boolean;
	/** Focus this overlay and bring it to the visual front */
	// 条目仍在栈且可见才显式聚焦并提高focusOrder，请求绘制；nonCapturing不禁止显式聚焦。
	focus(): void;
	/** Release focus to the next visible capturing overlay or previous target, or to an explicit target when provided */
	// 释放焦点或调整待恢复策略；省略参数用候选浮层/preFocus，传target则使用显式目标，视觉顺序不因此重排。
	unfocus(options?: OverlayUnfocusOptions): void;
	/** Check if this overlay currently has focus */
	// 按当前焦点组件身份判断，未额外证明条目可见/在栈。
	isFocused(): boolean;
	/** Get the most recent rendered bounds for a visible overlay. */
	// 仅在仍在栈、可见且已有bounds时返回矩形浅副本；尚未绘制可能undefined。
	getBounds(): OverlayBounds | undefined;
}

// 内部浮层条目，把控制状态与实际组件关联，不要求组件继承Container。
type OverlayStackEntry = {
	// 浮层组件引用，可与children里的基础组件不同。
	component: Component;
	// 原配置对象，可选；不是固定时刻的布局结果。
	options?: OverlayOptions;
	// 创建浮层前的焦点，移除时用作回退；移除其他浮层时可能被重定向以免指向已卸载对象。
	preFocus: Component | null;
	// 显式临时隐藏标志，false时仍要检查visible回调。
	hidden: boolean;
	// 视觉/焦点优先序，创建或显式focus时递增，不等于数组插入位置。
	focusOrder: number;
	// 最近渲染矩形，可隐藏后缺失；由compositeOverlays建立。
	bounds?: OverlayBounds;
};

// 每轮已合成浮层的布局快照，按focusOrder排列，供鼠标命中使用。
type RenderedOverlayLayout = {
	// 对应原浮层条目，保留组件/选项关联。
	entry: OverlayStackEntry;
	// 本轮屏内起行。
	row: number;
	// 本轮屏内起列。
	col: number;
	// 本轮布局宽度。
	width: number;
	// 本轮截断后行数。
	height: number;
};

// 带status的判别联合：替代焦点结束后，要么restore-overlay恢复浮层，要么focus-target使用明确target（可null）；TS可据status收窄字段。
type OverlayBlockedFocusResume = { status: "restore-overlay" } | { status: "focus-target"; target: Component | null };
// eligible表示浮层有资格在输入前重新获得焦点，overlay保存具体条目。
type EligibleOverlayFocusRestoreState = { status: "eligible"; overlay: OverlayStackEntry };
// blocked表示浮层暂让给基础区的替代组件处理输入，等替代流程结束再按resume恢复。
type BlockedOverlayFocusRestoreState = {
	// 字面量status让TS在分支里知道blockedBy/resume必定存在。
	status: "blocked";
	// 仍保留恢复资格的浮层条目。
	overlay: OverlayStackEntry;
	// 当前拦住恢复的替代组件身份，避免其仍活跃时被浮层抢回输入。
	blockedBy: Component;
	// 替代结束后要做的恢复动作，不是立即执行的回调。
	resume: OverlayBlockedFocusResume;
};
// 活跃恢复状态是eligible或blocked，|表示类型联合。
type ActiveOverlayFocusRestoreState = EligibleOverlayFocusRestoreState | BlockedOverlayFocusRestoreState;
// 整套状态再加inactive无待恢复；不同分支有不同字段，不靠一组易混淆boolean组合。
type OverlayFocusRestoreState = { status: "inactive" } | ActiveOverlayFocusRestoreState;
// 内部setFocus策略：clear可清空常规恢复资格，preserve用于临时不可见时保留；blocked恢复有自己的优先分支。
type OverlayFocusRestorePolicy = "clear" | "preserve";

/**
 * Container - a component that contains other components
 */
// 纵向拼接子组件的基础容器，供主屏/全屏或普通嵌套组件继承；render按同宽串联行并记鼠标布局。
// 例两个子组件分别高2/3行，第二个鼠标局部y从父y减2得到；增删子组件只改数组，不自动请求渲染或清理焦点。
// implements在TS核对组件契约，运行时仍是普通类；回调render/handleMouse/invalidate异常不在容器里捕获。
export class Container implements Component {
	// 公开可变children数组按顺序决定渲染/鼠标布局，允许调用方直接修改，非不可变树。
	children: Component[] = [];
	// 缓存最近render的宽度与每个子组件高度；?允许尚未渲染，缓存不会因add/remove自动清除。
	private mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> };

	// 把component追加到末尾，返回void；例如先标题再输入框按此顺序渲染，不去重、不立即重绘。
	addChild(component: Component): void {
		// push修改原children数组，保留传入组件引用。
		this.children.push(component);
	}

	// 按对象身份移除第一个匹配子组件，找不到无操作，返回void；不递归查子树/不自动变更焦点或缓存。
	removeChild(component: Component): void {
		// indexOf用引用匹配，未找到为-1。
		const index = this.children.indexOf(component);
		// 必须确认索引有效，避免splice(-1,1)误删最后一个。
		if (index !== -1) {
			// 原数组从index删除1项，其余子组件顺序保留。
			this.children.splice(index, 1);
		}
	}

	// 清空基础子组件列表，返回void，无组件dispose/终端清屏；例聊天容器重新构建前调用，鼠标缓存和焦点另由调用方后续流程处理。
	clear(): void {
		// 给children换一个新空数组，外部若持有旧数组仍保留旧内容。
		this.children = [];
	}

	// 通知当前所有子组件缓存失效，返回void；例主题改变后逐个invalidate，不自动requestRender，子回调异常会中断后续遍历。
	invalidate(): void {
		// 按当前children顺序遍历。
		for (const child of this.children) {
			// 可选调用已有invalidate；接口要求此方法，原实现仍保留?.，不添加额外运行校验。
			child.invalidate?.();
		}
	}

	// 把鼠标按纵向布局转发给命中子组件，返回处理结果或undefined；不自行排render或调用setFocus。
	// 优先用相同宽度的最近render缓存，否则渲染各子组件测高度；例父y=3、子区从2起，传入子y=1。
	// 只检查父y范围、不检查x；命中一个子区后无论该子是否处理都结束，不继续穿透后续子区。
	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		// 父局部y在高度范围外直接未命中；捕获拖出边界等由其他分发路径处理。
		if (event.y < 0 || event.y >= event.height) return undefined;
		// 选择本次用于命中的子组件/高度列表，下面三元决定是否复用缓存。
		const mouseChildren =
			// 只有缓存存在且宽度相等才命中；不比较children版本或事件高度。
			this.mouseLayout?.width === event.width
				? // 复用此前render记录的组件引用/高度，增删后若未重绘可能仍是旧布局。
					this.mouseLayout.children
				: // 未命中缓存就逐子render(event.width)取行数；这些回调可有副作用，返回列表但此处不写回mouseLayout。
					this.children.map((component) => ({ component, height: component.render(event.width).length }));
		// 累计子区起行，从父区域第0行开始。
		let childY = 0;
		// 解构并把component重命名child、height重命名childHeight，避免与父事件字段混淆。
		for (const { component: child, height: childHeight } of mouseChildren) {
			// 左闭右开区间判定该子组件覆盖父y；高0的组件不会命中。
			if (event.y >= childY && event.y < childY + childHeight) {
				// 通过公共分发助手保留实际目标/原点及嵌套转发语义。
				const result = dispatchMouseEvent(child, {
					// 先复制绝对坐标、按钮、修饰位等其他字段。
					...event,
					// 父局部行减子区起行，得到子局部y；screenY保持不变。
					y: event.y - childY,
					// 子组件接收自己的高度，宽度沿用父事件。
					height: childHeight,
				});
				// 子结果请求focus且本容器能代收键盘时，把focusTarget改为容器；as只告诉TS可有可选handleInput，不创建此方法。
				if (result?.focus && (this as Component).handleInput) return { ...result, focusTarget: this };
				// 命中区的结果直接返回，undefined也表示此位置不继续尝试别的子组件。
				return result;
			}
			// 未命中本子区，累计其高度，准备下一个子区。
			childY += childHeight;
		}
		// 没有任何子区包含该y，返回未处理。
		return undefined;
	}

	// 按width渲染所有children，将行按顺序平铺返回，并保存这次每个子组件高度供鼠标命中；不写终端。
	// 例如[标题两行,正文三行]返回5行，新行数组不克隆字符串；子render抛错时不会完成新的mouseLayout缓存写入。
	render(width: number): string[] {
		// 新建最终行数组，避免把某个子组件原行数组当容器结果修改。
		const lines: string[] = [];
		// 记录每个子组件引用和它实际返回行数的数组，泛型Array<...>与...[]都是TS数组写法。
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		// 按children当前迭代顺序取子组件；重复引用不去重，回调修改列表时也没有额外快照隔离。
		for (const child of this.children) {
			// 所有直接子组件都收到同一width，不按剩余屏高裁剪。
			const childLines = child.render(width);
			// 把子组件对应高度记入本轮鼠标布局。
			mouseChildren.push({ component: child, height: childLines.length });
			// 逐条取子render返回的行字符串，不递归展开字符串自身字符。
			for (const line of childLines) {
				// 原字符串引用/值追加到新行数组，未做宽度验证或ANSI规范化。
				lines.push(line);
			}
		}
		// 全部子组件渲染完成才替换mouseLayout，供相同宽度的handleMouse复用。
		this.mouseLayout = { width, children: mouseChildren };
		// 返回平铺行，后续渲染器负责输出/浮层合成/光标处理。
		return lines;
	}
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
// 浮层片段之间用SGR0重置样式并用空OSC8关闭链接，防止底层/浮层样式互相泄漏；只是控制串常量。
const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

/** Composite overlay content into a terminal line at a fixed column. */
// 把overlayLine覆盖到baseLine的指定显示列区域，返回新串，无终端写入；例底行abcdef从列2覆盖宽2的XY得到abXYef。
// 按字素/ANSI拆出底行左右段，严格截浮层宽度、补空格、在两侧重置样式/链接，最后检查总宽并严格裁剪。
// 底行含图片前缀时整行直接保留，浮层不会覆盖；各参数按正常布局的格数使用，不额外验证NaN/任意负宽。
export function compositeTuiLine(
	// 含ANSI的基础行，原字符串不修改。
	baseLine: string,
	// 浮层某行的字符串，可带自身样式/链接。
	overlayLine: string,
	// 覆盖区左边界，0基显示列，不是UTF-16字符串下标。
	startCol: number,
	// 覆盖区域列数，浮层文本短时用空格占满这段。
	overlayWidth: number,
	// 最终终端总列宽，超出会在返回前裁剪。
	totalWidth: number,
): string {
	// 图片行直接返回原串，避免把图片报文当文字切断；isImageLine仅前缀识别。
	if (isImageLine(baseLine)) return baseLine;

	// 覆盖区域右边界为起列+宽度，右侧底行从此显示列开始取。
	const afterStart = startCol + overlayWidth;
	// 一次扫描获取底行左段/右段及实际宽度，右段严格边界；支持重建被覆盖区之后仍生效的样式。
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
	// 浮层从第0显示列严格截到指定宽，宽字放不下时整个排除，返回{text,width}。
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);
	// 底行过短或边界丢弃半个宽字时，补到覆盖区实际起列。
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	// 浮层文字不足声明宽时补空格，覆盖旧底行残余。
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	// 左区域实际占宽取起列与保留左段宽中较大值，后面计算右侧预算。
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	// 浮层实际区宽取声明宽/实际文本宽最大值，不假定切片结果一定恰好填满。
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	// 扣掉左区和浮层区，剩余右侧可用列至少为0。
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	// 右底行不足预算也补白，让整行覆盖之前的旧字符。
	const afterPad = Math.max(0, afterTarget - base.afterWidth);
	// 下面多行+共同拼一个结果，不是每行独立输出。
	const result =
		// 先接保留的左侧底行文字和它的原控制码。
		base.before +
		// 左段不足起列的格用空格填齐，repeat输入来自上方非负差值。
		" ".repeat(beforePad) +
		// 在浮层开始前关掉底行样式/链接。
		SEGMENT_RESET +
		// 接截好的浮层原文与它自己的控制码。
		overlay.text +
		// 补满浮层区域未用的显示格。
		" ".repeat(overlayPad) +
		// 离开浮层再重置，避免其样式/链接泄漏到右底行。
		SEGMENT_RESET +
		// 接右侧底行片段，extractSegments已附需要恢复的活动样式/链接。
		base.after +
		// 最后补足右侧预算格。
		" ".repeat(afterPad);

	// 测结果显示宽，不超则原样返回，超宽则严格按总宽裁片；字符串length不适合这个判断。
	return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
}

// 渲染模式的编译期联合：regular主屏/滚动历史，fullscreen备用屏/自管视口；不是两种不同终端协议版本。
export type TuiMode = "regular" | "fullscreen";

// 停止时的可选参数结构，实际解释由基类与具体屏幕钩子决定。
export interface TuiStopOptions {
	/** Leave renderer output in place for another TUI taking over the same terminal. */
	// true请求保留屏幕供下一TUI接管，仍会执行终端stop/显示光标等恢复操作，不承诺完全无输出。
	preserveScreen?: boolean;
}

// 公开TUI接口继承Component，额外规定生命周期、焦点、浮层和查询能力；接口本身不能new，TuiBase负责公共实现。
export interface TUI extends Component {
	// 只读模式属性，调用方可据字面量判断主屏/全屏；readonly不冻结整个TUI实例。
	readonly mode: TuiMode;
	// 基础子组件数组，浮层另存于内部栈。
	children: Component[];
	// 注入终端适配器，公开以便应用执行标题/进度等操作。
	terminal: Terminal;
	// 可选同步调试回调，固定调试键命中时触发，可能抛异常。
	onDebug?: () => void;
	// 已计整绘次数的只读视图，具体何时递增由渲染子类决定。
	readonly fullRedraws: number;
	// 追加基础组件，不直接画屏。
	addChild(component: Component): void;
	// 移除第一个相同引用的直接子组件，不自动调整焦点。
	removeChild(component: Component): void;
	// 清空基础children，不等于清浮层或清终端屏。
	clear(): void;
	// 读取硬件光标显示配置。
	getShowHardwareCursor(): boolean;
	// 改变硬件光标配置并请求绘制，关闭时运行状态下先隐藏。
	setShowHardwareCursor(enabled: boolean): void;
	// 读取内容缩短时是否整绘清理的配置。
	getClearOnShrink(): boolean;
	// 设置缩短策略，不在setter立即重绘。
	setClearOnShrink(enabled: boolean): void;
	// 指定键盘焦点或null，具体恢复状态可能将目标重定向；本方法自身不请求绘制。
	setFocus(component: Component | null): void;
	// 创建浮层条目/控制句柄，通常调整焦点并请求绘制。
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
	// 移除栈最后插入条目，不一定是focusOrder最高的视觉前景条目。
	hideOverlay(): void;
	// 是否至少有一个当前可见浮层，区别于内部hasOverlayEntries计所有条目。
	hasOverlay(): boolean;
	// 连接终端输入/resize回调并安排首轮绘制。
	start(): void;
	// 停止渲染调度、断开终端，具体输出清理由钩子负责；不统一取消所有异步查询。
	stop(options?: TuiStopOptions): void;
	// 同步尝试执行doRender，可选force先重置子类绘制缓存，方法不返回Promise。
	renderNow(force?: boolean): void;
	// 安排后续渲染，普通请求按最小间隔节流，force先重置并走nextTick低延迟路径。
	requestRender(force?: boolean): void;
	// 注册输入监听器并返回移除它的函数，调用返回函数才注销。
	addInputListener(listener: TuiInputListener): () => void;
	// 按回调引用显式注销一个输入监听器。
	removeInputListener(listener: TuiInputListener): void;
	// 注册深浅主题通知监听器，返回注销闭包；不会因此自动发送终端通知启用码。
	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void;
	// 启停终端主动深浅通知请求，收到合法报告的解析不以此开关作门禁。
	setTerminalColorSchemeNotifications(enabled: boolean): void;
	// 查询默认前/背景与16色板，返回Promise；options是调用参数对象的内联TS结构。
	queryTerminalColors(options: {
		// 等待本轮颜色的超时毫秒数，不是各颜色各自的截止时间。
		timeoutMs: number;
		// 超时先返回当前结果后，查询最终完成时可用此回调投递一次汇总晚回复，非每条颜色逐条调用。
		onLateReply?: (colors: TerminalColors) => void;
		// Promise泛型约束正常resolve值，未报告的颜色/不完整调色板可以缺省。
	}): Promise<TerminalColors>;
}

// Symbol.for使用进程全局符号注册表的同名键标识视口TUI能力，可跨同名包副本共享；不是用instanceof检查具体子类。
export const VIEWPORT_TUI = Symbol.for("@earendil-works/pi-tui/viewport");

// 视口TUI比基础TUI多一个符号标记及布局根设置能力，当前全屏实现使用。
export interface ViewportTUI extends TUI {
	// 计算属性名[VIEWPORT_TUI]以symbol为键，值必须字面量true，避免普通字符串字段撞名。
	readonly [VIEWPORT_TUI]: true;
	// 设置单独布局根或传undefined移除；实际布局/重绘由实现者完成。
	setLayoutRoot(component: Component | undefined): void;
}

// 检查tui是否带视口标记并作TS类型收窄，返回boolean，无布局/IO；例全屏实例带符号true则可访问setLayoutRoot。
export function isViewportTUI(tui: TUI): tui is ViewportTUI {
	// as Partial只放宽编译期字段读取，运行时仅比较标记===true，不验证方法是否存在或整个对象形状。
	return (tui as Partial<ViewportTUI>)[VIEWPORT_TUI] === true;
}

// 抽象TUI基类：继承Container的基础渲染，管理焦点/浮层/协议回复/输入和绘制时机，留doRender给主屏或全屏实现。
// 例如普通requestRender合并同一轮请求并按16ms目标间隔等待；焦点组件输入后用nextTick绕过节流等待，仍不是同步render。
// 不能直接new抽象类；它通过Terminal做实际IO，可接内存适配器。多数回调异常直接传播，只有进程exit兜底明确吞掉错误。
export abstract class TuiBase extends Container implements TUI {
	// 子类必须给出具体mode值；abstract成员没有此处的运行时初始化。
	abstract readonly mode: TuiMode;
	// 公开终端适配器引用，构造时赋值。
	public terminal: Terminal;
	// 当前键盘接收者，null代表没有；可以是基础组件或浮层组件。
	private focusedComponent: Component | null = null;
	// Set按函数引用去重并按插入顺序迭代，监听器可以消费或替换输入。
	private inputListeners = new Set<TuiInputListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	// 调试键全局回调，先于焦点组件的松开事件过滤；?允许未设置。
	public onDebug?: () => void;
	// 有一次待满足的绘制请求，连续普通requestRender以它合并。
	private renderRequested = false;
	// 是否已经排了即时nextTick回调，防止每个输入都追加一个同样绘制任务。
	private immediateRenderScheduled = false;
	// 普通节流渲染的setTimeout句柄，与终端颜色查询定时器分开。
	private renderTimer: NodeJS.Timeout | undefined;
	// 最近一次开始doRender的performance.now时间，失败的绘制尝试也可能已更新时间。
	private lastRenderAt = 0;
	// 类级常量16ms，控制普通帧启动间隔；不是承诺每秒稳定60帧或保证执行耗时。
	private static readonly MIN_RENDER_INTERVAL_MS = 16;
	// 默认隐藏硬件光标，组件可另用伪光标反色显示位置。
	private showHardwareCursor = false;
	// 默认不因内容变短主动整绘清屏，具体子类参考此配置。
	private clearOnShrink = false;
	// 子类可访问的整绘计数，本类只公开读取不在此递增。
	protected fullRedrawCount = 0;
	// 初始false，意味着未start也能显式renderNow尝试绘制；stop才置true，start可再次置false。
	protected stopped = false;
	/**
	 * Color queries waiting for their DA1 reply, oldest first. Terminals answer in order, so color
	 * replies belong to the oldest one. Queries stay here after a timeout to collect late replies.
	 */
	// 颜色查询FIFO队列；超时或18个目标完成仍不直接出队，直到DA1才shift，让晚回复继续归最早查询。
	private pendingTerminalColorQueries: PendingTerminalColorQuery[] = [];
	// 主题报告订阅者集合，重复注册同引用不会多一份。
	private terminalColorSchemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
	// 是否已请求终端发送深浅模式通知，和是否有监听器不是一回事。
	private terminalColorSchemeNotificationsEnabled = false;
	/** Directory for debug/crash logs. When undefined, debug logging is disabled and crash dumps fall back to the OS temp directory. */
	// 可选日志目录由具体渲染器使用，本基类保存原字符串；readonly只禁止字段重赋。
	protected readonly logDirectory: string | undefined;

	// Overlay stack for modal components rendered on top of base content
	// 每次创建/显式focus等提升时加1，值越大绘制越靠前，不因移除条目回退。
	private focusOrderCounter = 0;
	// 插入顺序保存的浮层条目，隐藏条目也仍占栈。
	private overlayStack: OverlayStackEntry[] = [];
	// 最近一次合成建立的可见布局，鼠标按此视觉顺序命中；不是每次输入即时重算。
	private renderedOverlayLayouts: RenderedOverlayLayout[] = [];

	// getter无参数返回是否有任何栈条目，不调用visible；例只剩隐藏浮层仍为true，无终端副作用。
	get hasOverlayEntries(): boolean {
		// 仅用数组长度判断；应用若要当前可见性应调用hasOverlay。
		return this.overlayStack.length > 0;
	}
	// 初始没有待恢复浮层，status判别联合让后面分支按状态读取合法字段。
	private overlayFocusRestore: OverlayFocusRestoreState = { status: "inactive" };

	// 构造时保存Terminal、可选硬件光标配置/日志目录，不注册输入/exit、不自动开始绘制；例由new TuiMainScreen传参走到这里，返回实例。
	constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string) {
		// 先构造父Container并初始化children；子类构造使用this前必须super。
		super();
		// 保留适配器引用，不检测是否是真终端或测试对象。
		this.terminal = terminal;
		// 保存日志路径，undefined表示由渲染器决定禁日志/崩溃回退策略。
		this.logDirectory = logDirectory;
		// 只在显式给了boolean时覆盖默认值，false也能正确进入赋值。
		if (showHardwareCursor !== undefined) {
			// 设置初始显示策略，不立即调用showCursor。
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	// 抽象protected钩子，子类实现真实一帧绘制，无参数/无返回值；例如主屏做行差量，全屏做视口输出，异常交上层调用栈。
	protected abstract doRender(): void;

	// 强制绘制前重置子类缓存的可覆写钩子，基类默认无操作/void；如主屏把旧尺寸设-1触发下帧清屏，不在基类自己发控制码。
	protected resetRenderState(): void {}

	// 终端start之前的可覆写钩子，基类空实现；全屏可借此发进入备用屏码，返回void，错误传播会中断start。
	protected beforeTerminalStart(): void {}

	// terminal.start之后的钩子，基类无操作；子类可执行需要输入已连接的初始化，void，不保证之前步骤失败时仍执行。
	protected afterTerminalStart(): void {}

	// terminal.stop之前的钩子，接收停止选项，基类不做事；例如主屏常规退出补换行，void，_参数名表示此默认实现未使用它。
	protected beforeTerminalStop(_options: TuiStopOptions): void {}

	// terminal.stop之后的钩子，基类空实现；例如全屏退出备用屏并可重放正文，返回void，不是finally清理保证。
	protected afterTerminalStop(_options: TuiStopOptions): void {}

	/** Mode resets written before the terminal's own resets when the process exits without stop(). */
	// 给进程exit兜底返回“终端自身复位前”的控制串，不立即发送；例通知已启用时先关2031再显示光标，子类可叠加自己的复位码。
	protected getExitRestorePrefix(): string {
		// 按开关可选插入通知关闭码，始终加光标显示码；模板字符串只生成数据。
		return `${this.terminalColorSchemeNotificationsEnabled ? "\x1b[?2031l" : ""}\x1b[?25h`;
	}

	/** Mode resets written after the terminal's own resets when the process exits without stop(). */
	// 返回“终端自身复位后”的额外控制串，基类为空、无IO；全屏等子类可覆写追加离开备用屏码。
	protected getExitRestoreSuffix(): string {
		// 空字符串表示无需后缀，不等于缺失函数。
		return "";
	}

	/**
	 * Last-resort restore for exit paths that skip stop(), e.g. a direct process.exit() (#11170).
	 * Hard kills and native aborts run no JavaScript and cannot be covered.
	 */
	// 绑定到实例的exit箭头回调，无参数/无返回值；进程正常JS退出但未stop时，尽力调用Terminal可选restoreOnExit。
	// 例应用直接process.exit时可恢复光标，硬杀/原生abort不运行此JS。整个兜底吞异常，不会补跑一般stop钩子或取消所有查询。
	private readonly exitRestoreHandler = (): void => {
		// 已经stop就不重复恢复，避免覆盖shell或下一TUI的状态。
		if (this.stopped) return;
		// 只在这条兜底路径用try/catch隔离退出恢复错误。
		try {
			// 有restoreOnExit才调用，前后缀由可覆写方法提供；适配器未实现则无动作。
			this.terminal.restoreOnExit?.(this.getExitRestorePrefix(), this.getExitRestoreSuffix());
			// 捕获同步恢复错误而不重新抛出，退出事件中尽量不制造二次故障。
		} catch {
			// Never throw from an exit handler.
		}
	};

	// 读取子类累计整绘次数的getter，无状态修改；例如调试重绘退路次数用tui.fullRedraws。
	get fullRedraws(): number {
		// 返回当前计数，不统计尚未执行的请求。
		return this.fullRedrawCount;
	}

	// 读取硬件光标显示设置，返回boolean，无终端IO；例如组件决定是否显示反色伪光标前可参考此配置。
	getShowHardwareCursor(): boolean {
		// 返回配置字段，不查询终端现在实际是否显示光标。
		return this.showHardwareCursor;
	}

	// 设置硬件光标策略，值改变时关光标可立即隐藏，然后排绘制，返回void；例false→true需下一帧按标记定位显示，错误不回滚已改配置。
	setShowHardwareCursor(enabled: boolean): void {
		// 配置相同直接跳过，避免重复排帧/隐藏动作。
		if (this.showHardwareCursor === enabled) return;
		// 先保存新策略，之后的终端动作若抛错不撤销。
		this.showHardwareCursor = enabled;
		// 关闭时尽快隐藏，打开时则由具体渲染器定位后显示。
		if (!enabled) {
			// 调用只在未stop时隐藏的助手，停止后不把shell光标再关掉。
			this.hideTerminalCursor();
		}
		// 请求后续绘制，让伪/真实光标显示随配置更新。
		this.requestRender();
	}

	// 读取内容缩短时整绘清理策略，无参数/副作用，返回boolean；例如主屏doRender据它决定是否清旧工作区。
	getClearOnShrink(): boolean {
		// 只返回配置，不判断当前帧是否缩短。
		return this.clearOnShrink;
	}

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true, empty rows are cleared when content shrinks.
	 * When false (default), empty rows remain (reduces redraws on slower terminals).
	 */
	// 保存缩短清理配置并返回void，不立即安排绘制；例setClearOnShrink(true)之后的主屏帧可整绘清掉旧尾部。
	setClearOnShrink(enabled: boolean): void {
		// 直接赋值，调用方若想当场刷新需另requestRender。
		this.clearOnShrink = enabled;
	}

	// 返回当前焦点组件引用或null，无副作用；例如模式切换保存焦点，不复制组件或校验挂载状态。
	getFocusedComponent(): Component | null {
		// 返回字段，不在此处理临时不可见浮层恢复。
		return this.focusedComponent;
	}

	// 公开焦点设置入口，传组件/null，返回void；交内部状态机并用clear常规策略，不立即render。例普通清焦点传null，但blocked替代流程可优先恢复浮层。
	setFocus(component: Component | null): void {
		// 对象属性简写传组件，字面量clear允许普通null清恢复资格；不是强制跳过所有blocked恢复规则。
		this.setFocusInternal({ component, overlayFocusRestore: "clear" });
	}

	// 统一焦点状态机：根据旧焦点、请求目标、浮层恢复资格/临时替代状态决定最终nextFocus，再切focused标志，返回void。
	// 参数是解构对象，overlayFocusRestore控制普通清空资格；例浮层暂让基础区选择器处理输入，选择器仍挂载时可继续把焦点转给它内部另一个组件。
	// 替代已卸载或显式unfocus指定了恢复target时，目标可能被恢复规则重定向；此函数不请求render，也不保证任意setFocus(x)最终一定是x。
	private setFocusInternal({
		// 从参数对象取请求焦点，允许null。
		component,
		// 取clear/preserve策略，而非取当前恢复状态本身。
		overlayFocusRestore,
		// 冒号之后是参数对象的内联TS类型声明，与前面的解构模式分开。
	}: {
		// 目标可以是任意Component引用或null，不要求此时已经挂载。
		component: Component | null;
		// 内部策略联合限制拼写，运行时没有额外配置解析。
		overlayFocusRestore: OverlayFocusRestorePolicy;
	}): void {
		// 记住旧焦点，用于识别当前临时替代者是否正在让出控制。
		const previousFocus = this.focusedComponent;
		// 最终目标先等于请求目标，下面分支可重定向，所以使用let。
		let nextFocus = component;
		// 先查旧焦点是否是仍可见浮层；下面三元避免无焦点时扫描。
		const previousFocusedOverlay = previousFocus
			? // find按组件身份与可见性找首条，visible回调可能执行。
				this.overlayStack.find((entry) => entry.component === previousFocus && this.isOverlayVisible(entry))
			: // 旧焦点空时不对应浮层条目。
				undefined;
		// 请求目标只要在浮层栈中就算浮层，不要求它当前可见；null则false。
		const nextFocusIsOverlay = nextFocus ? this.overlayStack.some((entry) => entry.component === nextFocus) : false;
		// 取当前有效可见恢复状态，暂不可见时返回inactive视图但保留底层资格。
		const restoreState = this.getVisibleOverlayFocusRestore();
		// 请求非空基础组件时，需要判断它是临时接管还是表示结束替代。
		if (nextFocus && !nextFocusIsOverlay) {
			// 若已有blocked状态且旧焦点正是记录的替代者，这次转移来自替代流程。
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				// 显式指定恢复target，或旧替代组件已从已识别挂载树移除时，认为该让出控制了。
				if (restoreState.resume.status === "focus-target" || !this.isComponentMounted(restoreState.blockedBy)) {
					// 按resume决定最终目标，可能恢复原浮层或明确target（含null），覆盖刚传的component。
					nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
				} else {
					// 否则旧替代仍挂载且默认恢复浮层，保持blocked，但把当前替代者换成请求目标。
					this.overlayFocusRestore = {
						// 状态继续是blocked，不立即抢回浮层。
						status: "blocked",
						// 仍然保留同一浮层作为将来恢复目标。
						overlay: restoreState.overlay,
						// 新基础组件成为当前挡住恢复的替代者。
						blockedBy: nextFocus,
						// 沿用将来的恢复动作对象，不新猜恢复目标。
						resume: restoreState.resume,
					};
				}
				// 若不是既有替代者转移，下面检查是否从当前有恢复资格的浮层进入新基础流程。
			} else if (
				// 旧焦点确实是可见浮层才适用。
				previousFocusedOverlay &&
				// 必须存在active恢复资格，避免无状态时读取overlay字段。
				restoreState.status !== "inactive" &&
				// 恢复资格对应的也必须是这个旧焦点浮层。
				restoreState.overlay === previousFocusedOverlay &&
				// 请求目标不是该浮层的preFocus祖先链成员时，视作新的临时替代，而非回到旧基础焦点。
				!this.isOverlayFocusAncestor(previousFocusedOverlay, nextFocus)
			) {
				// 创建新blocked状态，暂缓恢复原浮层。
				this.overlayFocusRestore = {
					// 字面量状态指定当前分支形状。
					status: "blocked",
					// 记录刚让出焦点的浮层。
					overlay: previousFocusedOverlay,
					// 把请求基础组件记作替代者，下一次转移据此判断是否结束。
					blockedBy: nextFocus,
					// 默认替代结束后恢复浮层，显式unfocus可随后把resume改成focus-target。
					resume: { status: "restore-overlay" },
				};
			}
			// 请求null时单独处理：可能结束blocked，也可能真正清焦点。
		} else if (nextFocus === null) {
			// 旧焦点正是当前替代者时，null表示退出该临时流程，恢复规则优先于clear策略。
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				// 把nextFocus从null改成resume结果；因此setFocus(null)在这个场景未必最终无焦点。
				nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
				// 非上述blocked退出且策略clear时，才清待恢复资格。
			} else if (overlayFocusRestore === "clear") {
				// 状态改inactive，防止下一输入把可见浮层又拉回焦点。
				this.clearOverlayFocusRestore();
			}
		}

		// 旧组件结构支持focused时，先关闭它的焦点显示标志。
		if (isFocusable(this.focusedComponent)) {
			// 即使最终目标与旧组件相同，也会先false再在下方true；属性setter若存在可观察到这些写入。
			this.focusedComponent.focused = false;
		}

		// 保存最终目标引用，不是最初请求目标的无条件直写。
		this.focusedComponent = nextFocus;

		// 最终目标支持focused才写它的标志；普通Component可以没有此成员。
		if (isFocusable(nextFocus)) {
			// 新焦点组件下一次render可据true输出CURSOR_MARKER。
			nextFocus.focused = true;
		}

		// 最后检查最终目标是否对应可见浮层，下面三元在null时跳过。
		const focusedOverlay = nextFocus
			? // 按身份和当前可见性查条目，可能再次调用visible。
				this.overlayStack.find((entry) => entry.component === nextFocus && this.isOverlayVisible(entry))
			: // null对应undefined，没有浮层资格升级。
				undefined;
		// 最终焦点是可见浮层时，建立其恢复资格。
		if (focusedOverlay) {
			// 状态变eligible，覆盖此前blocked等记录；此处不更改focusOrder视觉顺序。
			this.overlayFocusRestore = { status: "eligible", overlay: focusedOverlay };
		}
	}

	// 清空待恢复浮层状态，无参数/无返回值，不改变当前焦点或屏幕；例显式unfocus后防下一键恢复。
	private clearOverlayFocusRestore(): void {
		// 赋一个新的inactive判别对象，不需要保留旧状态字段。
		this.overlayFocusRestore = { status: "inactive" };
	}

	// 仅当active恢复状态属于给定overlay时清掉，返回void；例如隐藏A不应误清B的待恢复资格，不写终端。
	private clearOverlayFocusRestoreFor(overlay: OverlayStackEntry): void {
		// 先排除inactive，再按条目引用匹配，&&短路使TS可安全读overlay字段。
		if (this.overlayFocusRestore.status !== "inactive" && this.overlayFocusRestore.overlay === overlay) {
			// 实际清理委托统一助手。
			this.clearOverlayFocusRestore();
		}
	}

	// 解析一个已blocked的resume，返回组件/null；恢复浮层支只取组件，显式target支还会清资格。例unfocus({target:editor})后替代结束返回editor，不在此切focused标志。
	private resolveBlockedOverlayFocusResume(restoreState: BlockedOverlayFocusRestoreState): Component | null {
		// 默认恢复原浮层组件，调用者之后setFocusInternal会把它标eligible。
		if (restoreState.resume.status === "restore-overlay") return restoreState.overlay.component;
		// 明确目标意味着这次不再恢复旧浮层，先清状态。
		this.clearOverlayFocusRestore();
		// 按focus-target分支返回target，可为null；TS通过上面的status判断收窄。
		return restoreState.resume.target;
	}

	// 读取当前可见且仍在栈的恢复状态，无终端输出；例visible回调暂false时返回inactive视图，不覆盖保存状态，回调恢复true后仍可重获资格。
	private getVisibleOverlayFocusRestore(): OverlayFocusRestoreState {
		// 局部持有当前判别状态对象，下面分支基于这份快照检查。
		const restoreState = this.overlayFocusRestore;
		// 本来inactive直接返回原对象。
		if (restoreState.status === "inactive") return restoreState;
		// 条目不在栈或目前不可见时，调用方这次不应用它；可见性回调可能抛错。
		if (!this.overlayStack.includes(restoreState.overlay) || !this.isOverlayVisible(restoreState.overlay)) {
			// 仅返回临时inactive结果，没有this.overlayFocusRestore赋值。
			return { status: "inactive" };
		}
		// 有效时返回原eligible/blocked对象。
		return restoreState;
	}

	// 沿entry.preFocus及其他浮层的preFocus链判断component是否是焦点祖先，返回boolean，不查组件children。例回到创建浮层前编辑器不算新替代；visited避免这条链成环时死循环。
	private isOverlayFocusAncestor(entry: OverlayStackEntry, component: Component): boolean {
		// 记录此轮已访问组件身份，不跨调用缓存。
		const visited = new Set<Component>();
		// 从创建该浮层前的焦点开始，不从浮层自身开始。
		let current = entry.preFocus;
		// 链未结束且未重复访问时继续。
		while (current && !visited.has(current)) {
			// 先登记，防下一步遇到同一组件反复绕圈。
			visited.add(current);
			// 匹配请求目标就找到祖先，立即true。
			if (current === component) return true;
			// 当前若是另一浮层组件则追其preFocus，找不到或preFocus空就结束为null。
			current = this.overlayStack.find((overlay) => overlay.component === current)?.preFocus ?? null;
		}
		// 走完或遇环未命中，返回false。
		return false;
	}

	// 移除浮层前，把其他条目指向它组件的preFocus改为它自己的preFocus，返回void；例子浮层A先删，后来关B不应回到已删A，不直接移动当前焦点。
	private retargetOverlayPreFocus(removed: OverlayStackEntry): void {
		// 扫描所有栈条目，修改符合条件的恢复指针。
		for (const overlay of this.overlayStack) {
			// 排除即将移除的条目自己，仅重接直接指向其组件的其他条目。
			if (overlay !== removed && overlay.preFocus === removed.component) {
				// 跳过removed这一层，原preFocus可为null。
				overlay.preFocus = removed.preFocus;
			}
		}
	}

	// 返回识别挂载状态用的基础根列表，无修改；基类就是children，全屏子类可改为独立layoutRoot，readonly仅约束调用者不能经此类型改数组。
	protected getMountedRoots(): readonly Component[] {
		// 直接返回同一children引用，不复制/包含浮层栈。
		return this.children;
	}

	// 判断component是否位于已挂载基础根中，返回boolean；例替代选择器已从Container清掉时可恢复浮层，不搜索任意自定义包装器的私有children。
	private isComponentMounted(component: Component): boolean {
		// some找到一个包含目标的根就结束，containsComponent只递归本项目Container实例。
		return this.getMountedRoots().some((child) => this.containsComponent(child, component));
	}

	// 按Container.children关系递归找target，返回boolean，无修改/IO；例root===target立即true，非Container包装组件视为叶子，假设组件树不成环。
	private containsComponent(root: Component, target: Component): boolean {
		// 首先允许根组件本身就是目标。
		if (root === target) return true;
		// 不是Container就不能按已知children结构往下找；这是项目树的类型边界，不是通用DOM遍历。
		if (!(root instanceof Container)) return false;
		// 递归任何直接子树，找到就短路；这里没有visited，组件树循环不在此保证处理。
		return root.children.some((child) => this.containsComponent(child, target));
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	// 新增一个浮层条目，保存创建前焦点/原配置，按可见性和nonCapturing决定自动焦点，隐藏光标并排帧，返回控制句柄。
	// 例showOverlay(menu,{width:"50%"})创建半终端宽菜单；方法本身不先render出几何，getBounds要等合成后才有结果。
	// visible/终端操作抛错可留下已入栈状态；句柄方法捕获此entry，不是按组件名字再寻找另一条目，也不统一验证所有失效句柄操作。
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		// 创建本次浮层独立条目对象，符合内部OverlayStackEntry结构。
		const entry: OverlayStackEntry = {
			// 保存组件引用，允许同一组件被多次show产生不同条目，未自动去重。
			component,
			// 仅参数options存在时才展开该字段，保留原配置对象引用。
			...(options === undefined ? {} : { options }),
			// 捕获当前焦点作为关闭时的回退起点，不是永久不变的焦点祖先。
			preFocus: this.focusedComponent,
			// 初始不主动隐藏，实际可见还由visible决定。
			hidden: false,
			// 前置++先递增类实例计数再记录，默认新条目绘制在旧条目前。
			focusOrder: ++this.focusOrderCounter,
		};
		// 加入插入顺序栈；后面visible失败等异常不会自动撤回。
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		// 非被动浮层且当前可见才自动聚焦；&&短路使nonCapturing真时不在这一步问visible。
		if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
			// 通过统一状态机改变焦点，未在此单独调组件handleInput。
			this.setFocus(component);
		}
		// 运行中先隐藏真实光标，等下一帧根据标记定位；stop后助手不再隐藏。
		this.hideTerminalCursor();
		// 请求后续绘制，方法仍立即返回句柄，不等待真正终端画出浮层。
		this.requestRender();

		// Return handle for controlling this overlay
		// 返回多个箭头方法构成的对象，箭头捕获外层this/entry/component/options而不依赖句柄调用的this。
		return {
			// 句柄hide回调移除本entry，恢复相关指针/焦点并排帧，返回void；例关子菜单，不影响别的相同名组件条目，已删时无操作。
			hide: () => {
				// 按条目对象引用定位，避免用组件身份误删其他条目。
				const index = this.overlayStack.indexOf(entry);
				// 仍在栈才进行移除过程；重复hide不会再改变焦点。
				if (index !== -1) {
					// 清掉这个条目自己的待恢复状态，保留其他条目资格。
					this.clearOverlayFocusRestoreFor(entry);
					// 先把其他条目preFocus重接，防以后回退到即将移除的组件。
					this.retargetOverlayPreFocus(entry);
					// 从插入顺序栈删除恰好一个条目。
					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay had focus
					// 只有当前键盘焦点正是该组件才找替代，不因为删被动浮层就改变其他焦点。
					if (this.focusedComponent === component) {
						// 优先找仍可见且自动捕获的视觉最前浮层，nonCapturing不参与此自动回退。
						const topVisible = this.getTopmostVisibleOverlay();
						// 候选存在用其组件，否则回创建前焦点，可null；该目标仍经内部恢复状态机。
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					// 栈空时运行中隐藏光标，下一帧按基础组件标记重定位；停止后不隐藏shell光标。
					if (this.overlayStack.length === 0) this.hideTerminalCursor();
					// 移除后排帧，让画面去掉该浮层。
					this.requestRender();
				}
			},
			// 句柄setHidden回调切显式hidden并处理焦点，返回void；例暂藏菜单后再显示，条目仍保留。它没有检查entry是否已被永久hide，调用方应停止使用已移除句柄。
			setHidden: (hidden: boolean) => {
				// 隐藏值没变就无操作，不主动重新问visible或提升顺序。
				if (entry.hidden === hidden) return;
				// 先写标志，再处理下方焦点逻辑。
				entry.hidden = hidden;
				// Update focus when hiding/showing
				// 临时隐藏分支撤销此条目恢复资格。
				if (hidden) {
					// 显式隐藏不能像visible暂false那样保留自动恢复资格。
					this.clearOverlayFocusRestoreFor(entry);
					// If this overlay had focus, move focus to next visible or preFocus
					// 正是当前焦点组件才转移键盘归属。
					if (this.focusedComponent === component) {
						// 找其余可见捕获浮层中focusOrder最高者，已经hidden的自己会被排除。
						const topVisible = this.getTopmostVisibleOverlay();
						// 无可见捕获浮层时回preFocus，使用统一setFocus状态机。
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					// 重新显示捕获型浮层且visible为真时才自动聚焦；被动浮层不因此抢焦点。
					if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
						// 显示时给捕获浮层新的视觉前景序号，不把它挪到数组末尾。
						entry.focusOrder = ++this.focusOrderCounter;
						// 改变键盘归属并建立可见浮层eligible状态。
						this.setFocus(component);
					}
				}
				// 隐藏或显示改变都排一帧；若前面回调抛错则不会自动走到这里。
				this.requestRender();
			},
			// 句柄isHidden无参数返回entry.hidden，无修改；例visible回调为false但没显式隐藏时仍返回false。
			isHidden: () => entry.hidden,
			// 句柄focus无参数/void：在仍在栈且可见时提升顺序、设置焦点并排帧；例被动浮层可显式接管键盘。
			focus: () => {
				// 永久移除/临时隐藏/visible为false时无操作；includes先短路，移除条目不会再调用visible。
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
				// 即使已经是焦点也提升视觉顺序，让后来创建的被动浮层不再挡它。
				entry.focusOrder = ++this.focusOrderCounter;
				// 聚焦本浮层组件，标记eligible恢复状态。
				this.setFocus(component);
				// 排帧让新视觉顺序显示出来。
				this.requestRender();
			},
			// 句柄unfocus接可选target选项，释放当前/待恢复焦点并排帧，返回void，不隐藏条目或降低focusOrder。
			// 例浮层被基础选择器暂时接管时，unfocus({target:editor})只记录结束后回editor，选择器继续收完关闭输入；省略选项则取消待恢复。
			// 不在焦点且没有本条目待恢复状态时无操作，即使传target也不会无条件把焦点切过去。
			unfocus: (unfocusOptions) => {
				// 先按组件身份看它当前是否拥有键盘焦点。
				const isFocused = this.focusedComponent === component;
				// 读取原保存恢复状态，不先过滤临时visible变化。
				const restoreState = this.overlayFocusRestore;
				// active状态对应本entry时表示它仍有恢复资格，即使当前焦点被别的组件接管。
				const hasPendingRestore = restoreState.status !== "inactive" && restoreState.overlay === entry;
				// 两者都没有则此句柄不应改变现有焦点，直接结束。
				if (!isFocused && !hasPendingRestore) return;
				// 下面三个&&条件共同识别“本浮层正在被记录的替代组件挡住”这一特殊状态。
				if (
					// 必须是blocked，才有blockedBy/resume字段。
					restoreState.status === "blocked" &&
					// 阻塞状态必须属于本条目，不能改别的浮层恢复动作。
					restoreState.overlay === entry &&
					// 当前焦点仍是替代者时，不应在其关闭输入前抢走它的键盘。
					this.focusedComponent === restoreState.blockedBy
				) {
					// 调用者显式给了options对象则记录目标，target为null也合法；省略对象走下方取消资格分支。
					if (unfocusOptions) {
						// 替换为同一替代流程的新blocked记录，不立即调用setFocus。
						this.overlayFocusRestore = {
							// 仍保持blocked。
							status: "blocked",
							// 待恢复关联仍为本条目。
							overlay: entry,
							// 替代者不变，等它之后让出焦点。
							blockedBy: restoreState.blockedBy,
							// 把默认恢复浮层改成结束后聚焦显式target，含null清焦点。
							resume: { status: "focus-target", target: unfocusOptions.target },
						};
					} else {
						// 没显式目标则直接取消恢复资格，当前替代者继续保持焦点。
						this.clearOverlayFocusRestore();
					}
					// 状态变动排帧，未立即发送输入或执行恢复。
					this.requestRender();
					// 特殊blocked分支结束，避免下面立刻改焦点。
					return;
				}
				// 其余情况先清本条目恢复资格，避免下一键又被自动拉回。
				this.clearOverlayFocusRestoreFor(entry);
				// 当前确实有焦点，或调用者有显式目标时，才选择接下来的焦点。
				if (isFocused || unfocusOptions) {
					// 取视觉最前的可见捕获浮层，注意结果可能仍是本entry。
					const topVisible = this.getTopmostVisibleOverlay();
					// 若最前候选不是自己，采用它；否则用创建前焦点，不另扫描第二名。
					const fallbackTarget = topVisible && topVisible !== entry ? topVisible.component : entry.preFocus;
					// 显式目标优先于回退目标，交统一状态机设置。
					this.setFocus(unfocusOptions ? unfocusOptions.target : fallbackTarget);
				}
				// 普通释放流程也排帧，不改浮层可见性/几何。
				this.requestRender();
			},
			// 句柄isFocused只读组件身份比较，无副作用；同一组件多条目等场景不额外区分条目。
			isFocused: () => this.focusedComponent === component,
			// 句柄getBounds读取最近矩形或undefined，无重新布局/IO；例首帧前无bounds，拿到后修改返回对象不改内部缓存。
			getBounds: () => {
				// 仍在栈、可见且已有bounds才可读；这次可见性不等于它已经按最新尺寸重绘。
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry) || !entry.bounds) return undefined;
				// 对象展开浅拷贝四个数值字段，避免外部直接改内部bounds对象。
				return { ...entry.bounds };
			},
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	// 删除插入栈末条目，清恢复资格/重接preFocus，必要时转焦点并请求render，返回void；空栈无操作。
	// 例先show A再show B，随后focus A只改视觉顺序，hideOverlay仍删除后插入的B；与“删除视觉最前”不同。
	hideOverlay(): void {
		// 直接取数组最后项，不按focusOrder或可见性排序。
		const overlay = this.overlayStack[this.overlayStack.length - 1];
		// 空栈得到undefined就结束。
		if (!overlay) return;
		// 撤销该条目自己的待恢复状态。
		this.clearOverlayFocusRestoreFor(overlay);
		// 把别的条目preFocus接到被删条目的preFocus，避免悬空回退。
		this.retargetOverlayPreFocus(overlay);
		// pop修改原栈，移除最后项，忽略返回值。
		this.overlayStack.pop();
		// 只有被删组件正是当前焦点才执行自动回退。
		if (this.focusedComponent === overlay.component) {
			// Find topmost visible overlay, or fall back to preFocus
			// 在剩余条目中按最高focusOrder选可见捕获浮层。
			const topVisible = this.getTopmostVisibleOverlay();
			// 有候选优先它，否则回被删条目的原焦点，可为null。
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		// 栈清空后只在运行状态隐藏光标，stop后的shell光标保持可见。
		if (this.overlayStack.length === 0) this.hideTerminalCursor();
		// 排帧去掉浮层显示；本函数不直接清那块终端区域。
		this.requestRender();
	}

	/** Hide the cursor while running. After stop(), the shell owns the cursor and it must stay visible. */
	// 运行状态下请求Terminal隐藏光标，无参数/void；例关最后浮层时让下一帧重定位，stop后无操作，不修改硬件光标配置字段。
	private hideTerminalCursor(): void {
		// 以stopped作为门禁，避免已退出TUI再次隐藏shell光标。
		if (!this.stopped) this.terminal.hideCursor();
	}

	/** Check if there are any visible overlays */
	// 查询当前是否有可见浮层，返回boolean；例只有hidden条目为false。会执行visible回调，可能有用户副作用/异常，不缓存结果。
	hasOverlay(): boolean {
		// some遇首个可见项就true，否则false；不会因为nonCapturing而忽略可见被动浮层。
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** Check if the focused component is a visible overlay */
	// 判断当前焦点是否对应可见浮层，返回boolean，供全屏视口路由等使用；例菜单focused但visible=false返回false，回调异常传播。
	protected isOverlayFocused(): boolean {
		// 在栈中找任一满足下方回调的条目。
		return this.overlayStack.some(
			// 先身份匹配再检查visible，其他条目不必执行可见性回调。
			(entry) => entry.component === this.focusedComponent && this.isOverlayVisible(entry),
		);
	}

	/** Keep overlay containers as keyboard focus owners when a nested control is clicked. */
	// 把被点击的子组件提升到包含它的可见浮层宿主作为键盘目标，返回组件引用，不自行切焦点；例菜单内部Input点击后菜单仍代收键盘。
	protected resolveMouseFocusTarget(component: Component): Component {
		// 按插入栈倒序查宿主，不是按focusOrder排序；通常组件只属于一处浮层树。
		for (let index = this.overlayStack.length - 1; index >= 0; index--) {
			// 非空断言!只让TS相信循环索引在范围内，不插入运行时检查。
			const overlay = this.overlayStack[index]!;
			// 当前可见且Container子树包含目标时选择该浮层宿主；自定义非Container内部树不在此展开。
			if (this.isOverlayVisible(overlay) && this.containsComponent(overlay.component, component)) {
				// 返回浮层根组件，保留其键盘代理职责。
				return overlay.component;
			}
		}
		// 不属于任何已识别可见浮层则返回原目标。
		return component;
	}

	/** Dispatch to the visually topmost overlay under the pointer. */
	// 依据最近一次renderedOverlayLayouts，向指针下视觉最前浮层转发鼠标，返回是否命中以及可选处理结果。
	// 例上层矩形命中但组件不处理仍返回{hit:true}，阻止把同位置当成没浮层；不继续穿透下一浮层。
	// 使用最近渲染快照，不在此重新检查条目是否已移除/隐藏或重新布局，调用方须通过后续绘制刷新几何；回调异常传播。
	protected dispatchMouseToOverlay(event: TuiMouseEvent): { hit: boolean; result?: TuiMouseDispatchResult } {
		// 布局数组按focusOrder从低到高建立，倒序先找最后画出的视觉前景。
		for (let index = this.renderedOverlayLayouts.length - 1; index >= 0; index--) {
			// 非空断言只影响TS，按有效索引取最近矩形。
			const layout = this.renderedOverlayLayouts[index]!;
			// 下面四项任一成立表示指针在矩形外，使用左闭右开边界。
			if (
				// 列在左边界之外。
				event.screenX < layout.col ||
				// 列达到/越过右边界。
				event.screenX >= layout.col + layout.width ||
				// 行在上边界之外。
				event.screenY < layout.row ||
				// 行达到/越过底边界。
				event.screenY >= layout.row + layout.height
			) {
				// 不命中这一层，继续下一个视觉更低层。
				continue;
			}
			// 把事件送给命中的浮层组件，保留嵌套分发元数据。
			const result = dispatchMouseEvent(layout.entry.component, {
				// 先复制绝对坐标和通用事件字段。
				...event,
				// 绝对列减浮层列，得到浮层局部x。
				x: event.screenX - layout.col,
				// 绝对行减浮层行，得到浮层局部y。
				y: event.screenY - layout.row,
				// 传矩形布局宽度而非整终端宽度。
				width: layout.width,
				// 传实际浮层高度。
				height: layout.height,
			});
			// 按组件是否处理，返回带result或只有hit的对象；两支都表示矩形命中。
			return result
				? // 处理结果存在时构造命中及决策。
					{
						// 标记命中了浮层几何。
						hit: true,
						// 若请求焦点则把focusTarget固定为这个浮层宿主，即使鼠标实际target是子组件；否则保留原结果引用。
						result: result.focus ? { ...result, focusTarget: layout.entry.component } : result,
					}
				: // 未处理也返回hit:true，不尝试更低浮层/基础正文。
					{ hit: true };
		}
		// 所有最近矩形都未命中才hit:false。
		return { hit: false };
	}

	/** Check if an overlay entry is currently visible */
	// 根据entry.hidden及可选visible判断可见，返回boolean，无内部状态改动；例如hidden优先false，visible收到当前终端尺寸且可能抛错。
	private isOverlayVisible(entry: OverlayStackEntry): boolean {
		// 显式隐藏直接false，跳过用户visible回调。
		if (entry.hidden) return false;
		// 有visible函数才把几何相关可见性委托给调用者。
		if (entry.options?.visible) {
			// 每次用当前columns/rows同步调用，不复用上帧可见性。
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		// 没显式隐藏也无回调则默认可见。
		return true;
	}

	/** Find the visual-frontmost visible capturing overlay, if any */
	// 选择当前可见捕获型浮层中focusOrder最高者，无则undefined；例关菜单后优先回仍可见的前景捕获浮层，不让纯被动通知自动抢焦点。
	private getTopmostVisibleOverlay(): OverlayStackEntry | undefined {
		// 还未选出候选，联合undefined使空栈可自然返回。
		let topmost: OverlayStackEntry | undefined;
		// 扫描插入栈，但依据focusOrder评分，不靠插入索引决定结果。
		for (const overlay of this.overlayStack) {
			// nonCapturing或不可见直接跳过，||短路使被动条目无需在此问visible。
			if (overlay.options?.nonCapturing || !this.isOverlayVisible(overlay)) continue;
			// 首个可用候选或更高视觉顺序者替换；相同序号时保留先遇到的。
			if (!topmost || overlay.focusOrder > topmost.focusOrder) {
				// 记录条目原引用，不复制。
				topmost = overlay;
			}
		}
		// 返回当前最佳条目或undefined。
		return topmost;
	}

	// 覆写Container.invalidate：通知挂载基础根和所有浮层（含隐藏）缓存失效，无参数/void，不自动排帧；例主题改变让下次render重新算样式，回调异常中断后续遍历。
	override invalidate(): void {
		// 基类children或子类自定义layoutRoot都经getMountedRoots取得，再逐个invalidate。
		for (const root of this.getMountedRoots()) root.invalidate();
		// 浮层单独通知，不按当前可见性过滤，也不对重复组件去重。
		for (const overlay of this.overlayStack) overlay.component.invalidate();
	}

	// 启动输入/resize连接，注册进程exit兜底，执行子类前后钩子并隐藏光标，再启用可选主题通知、问图片格尺寸、排首帧，返回void。
	// 例主屏的terminal.start接上键盘后，真正首帧仍等待requestRender调度；初始stopped=false不意味着此输入连接已建立。
	// 重复start会先去重本实例exit监听，但不保证适配器start/子类钩子幂等；任一步抛错无统一回滚/finally。
	start(): void {
		// 先允许绘制/运行中的光标动作，后面初始化失败也不会自动改回true。
		this.stopped = false;
		// 移除本实例同一个exit回调，避免重复start积累重复注册。
		process.off("exit", this.exitRestoreHandler);
		// 重新注册进程退出时的同步尽力恢复。
		process.on("exit", this.exitRestoreHandler);
		// 在终端连接前让具体屏幕进入自己的模式，例如备用屏控制码。
		this.beforeTerminalStart();
		// 调用注入适配器start，传两个回调，实际系统TTY行为取决于适配器。
		this.terminal.start(
			// 收到一个完整输入块时进入公共输入链；箭头捕获实例this。
			(data) => this.handleTerminalInput(data),
			// 终端resize只请求后续绘制，不在resize回调里同步doRender。
			() => this.requestRender(),
		);
		// 终端连接完成后执行子类后置钩子。
		this.afterTerminalStart();
		// 初始先直接隐藏光标，具体下一帧再定位/显示。
		this.terminal.hideCursor();
		// 之前配置需要主题通知时，启动时发启用协议请求。
		if (this.terminalColorSchemeNotificationsEnabled) {
			// CSI ?2031h让支持的终端报告深浅变化，不保证终端实现该协议。
			this.terminal.write("\x1b[?2031h");
		}
		// 仅图片能力开启时询问每格像素宽高；冷能力探测可能同步查tmux，测试用PI_HYPERLINKS绕过。
		this.queryCellSize();
		// 排首帧，不返回等待画完的Promise。
		this.requestRender();
	}

	// 添加同步输入监听器并返回注销闭包；例const off=tui.addInputListener(fn)，off()才删除。按函数身份去重，无终端写入。
	addInputListener(listener: TuiInputListener): () => void {
		// Set.add保留插入顺序；同一回调重复加入仍一项。
		this.inputListeners.add(listener);
		// 此箭头是在未来注销时调用的函数，不在注册时立即运行。
		return () => {
			// 按原listener引用删除，重复注销无额外影响，忽略Set.delete的boolean结果。
			this.inputListeners.delete(listener);
		};
	}

	// 按原回调身份移除输入监听器，返回void；例无需保存注册返回函数时显式removeInputListener(fn)，不存在则无操作。
	removeInputListener(listener: TuiInputListener): void {
		// 不调用回调，不重新注册其他项。
		this.inputListeners.delete(listener);
	}

	// 注册深浅报告监听器并返回注销函数，不自动启终端通知；例收到light后调整应用主题，回调由输入解析路径同步调用。
	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void {
		// Set按回调引用去重，后续报告按集合顺序调用。
		this.terminalColorSchemeListeners.add(listener);
		// 返回闭包捕获该listener供未来注销，无立刻调用。
		return () => {
			// 从订阅集合删除同一函数，不影响通知协议开关。
			this.terminalColorSchemeListeners.delete(listener);
		};
	}

	// 设置是否请求终端主动报告深浅，运行时立即写启停码，返回void；例true启2031，未start但初始stopped=false时同样可能写，不解析当前主题。
	setTerminalColorSchemeNotifications(enabled: boolean): void {
		// 与已保存值相同就不重复写控制码。
		if (this.terminalColorSchemeNotificationsEnabled === enabled) {
			// 结束，无状态更新/绘制请求。
			return;
		}
		// 先保存开关，写失败时不回滚它。
		this.terminalColorSchemeNotificationsEnabled = enabled;
		// stop后只保存配置，不写终端，之后start会重新按开关启用。
		if (!this.stopped) {
			// 三元选择h启用/l关闭；这不控制consumeTerminalColorSchemeReport是否消费已收到的合法报告。
			this.terminal.write(enabled ? "\x1b[?2031h" : "\x1b[?2031l");
		}
	}

	// 按图片能力决定是否发送CSI16t询问终端格像素尺寸，返回void；例只画文本不问。它不等待回复/建立独立pending门禁，回复由输入链随时解析。
	private queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		// getCapabilities可能初始化共享能力缓存，images为null等假值时不查询。
		if (!getCapabilities().images) {
			// 无图片能力直接结束，不阻塞后续键盘输入。
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		// 实际向适配器写格尺寸查询；测试适配器只记录/模拟，不写用户真实终端。
		this.terminal.write("\x1b[16t");
	}

	// 停止：先置stopped、解绑exit/取消普通渲染定时器，再关主题通知、跑停前钩子、显光标、停终端、跑停后钩子，返回void。
	// 例主屏常规退出补换行，全屏按选项退出备用屏；这不是try/finally，前一步抛错后面步骤可能不执行。
	// 不清children/浮层/焦点/输入监听器，也不取消颜色查询队列与其超时；已排nextTick仍会运行但通常被stopped拦住。
	stop(options: TuiStopOptions = {}): void {
		// 从此调度/子类绘制通常停止，后续start可重新设false。
		this.stopped = true;
		// 不再在进程exit重复做本实例兜底恢复。
		process.off("exit", this.exitRestoreHandler);
		// 清的是渲染setTimeout，不是所有颜色查询timer。
		this.cancelRenderTimer();
		// 开关仍保存为true时，停前先发主题通知关闭码。
		if (this.terminalColorSchemeNotificationsEnabled) {
			// 只关闭终端协议，不把内部开关改false，重启可重新启用。
			this.terminal.write("\x1b[?2031l");
		}
		// 让子类在适配器停止前处理光标/鼠标/屏幕。
		this.beforeTerminalStop(options);
		// 向终端请求光标可见，避免shell看不到输入位置。
		this.terminal.showCursor();
		// 适配器解除输入/resize及自身终端协议，具体实现可能操作TTY。
		this.terminal.stop();
		// 让子类停后恢复屏幕等；前面步骤抛错时不会保证到达这里。
		this.afterTerminalStop(options);
	}

	// 同步执行一帧，force真先重置缓存，再消化待渲染标志/取消定时器、记录开始时刻并调用子类，返回void；例如测试tui.renderNow()直接生成输出，绘制异常同步向外抛。
	renderNow(force = false): void {
		// 强制路径只重置子类渲染状态，不重置组件值/焦点；实际是否清屏由子类决定。
		if (force) this.resetRenderState();
		// 本次将满足已有普通绘制请求，先清待处理标志。
		this.renderRequested = false;
		// 取消原定普通帧，避免它稍后重复画同一状态。
		this.cancelRenderTimer();
		// 记开始时间而非结束时间；耗时长的doRender也占用间隔。
		this.lastRenderAt = performance.now();
		// 直接调用虚方法，本方法自身不检查stopped，具体子类通常会在入口拦住。
		this.doRender();
	}

	// 请求以后绘制并合并重复请求，返回void不等画完；例连续多次requestRender只需一帧，force=true先重置再走即时nextTick，不直接同步渲染。
	requestRender(force = false): void {
		// force分支优先，即使已有普通请求也要重置缓存并抢占节流。
		if (force) {
			// 调用子类重置钩子，本基类默认无操作。
			this.resetRenderState();
			// 安排低延迟绘制任务，不通过普通16ms定时器。
			this.requestImmediateRender();
			// force已经处理，不再排普通路径。
			return;
		}
		// 已有待绘制标志则合并；不再增加一个nextTick。
		if (this.renderRequested) return;
		// 先置请求标志，后续请求看到它可合并。
		this.renderRequested = true;
		// 把scheduleRender箭头回调放Node下一轮nextTick队列，届时才根据时间差设置timeout。
		process.nextTick(() => this.scheduleRender());
	}

	// 安排输入/force触发的nextTick绘制，取消普通节流定时器且同轮只排一个即时回调，返回void；例连收3个键后画最终状态，未承诺每键都单独画。
	private requestImmediateRender(): void {
		// 先抢占已经排好的普通帧，降低输入显示延迟。
		this.cancelRenderTimer();
		// 仍用统一renderRequested表示有一帧待满足。
		this.renderRequested = true;
		// 已有即时回调就不再排第二个，但上面已保证请求标志为true。
		if (this.immediateRenderScheduled) return;
		// 记录已经排队，直到回调开始才清掉。
		this.immediateRenderScheduled = true;
		// 注册未来nextTick的箭头回调，构造闭包本身不执行doRender。
		process.nextTick(() => {
			// 回调开始先释放排队标志，后续输入可再排下一次。
			this.immediateRenderScheduled = false;
			// 已stop或这期间renderNow已满足请求时跳过；回调仍执行到了这里，不等于从队列撤销。
			if (this.stopped || !this.renderRequested) return;
			// A previously queued scheduleRender() can create a timer before this
			// callback runs. User input must preempt that throttled frame.
			// 再次取消可能被更早普通nextTick刚建的timer，避免即时绘制后紧接多画一帧。
			this.cancelRenderTimer();
			// 马上执行的这一帧满足请求，先清标志，让doRender内部新请求能重新标记。
			this.renderRequested = false;
			// 记录这次实际尝试绘制的起点。
			this.lastRenderAt = performance.now();
			// 运行子类doRender，异常会从nextTick回调向外传播，没有统一捕获。
			this.doRender();
		});
	}

	// 取消当前普通渲染timeout并清句柄，无参数/void；例即时输入抢占旧timer，不取消nextTick或颜色查询。
	private cancelRenderTimer(): void {
		// 没有timer就不需要清理。
		if (!this.renderTimer) return;
		// Node clearTimeout阻止尚未开始的定时回调，已在执行的函数不因此回滚。
		clearTimeout(this.renderTimer);
		// 清字段以允许后续scheduleRender建立新timer。
		this.renderTimer = undefined;
	}

	// 为待绘制请求按目标间隔计算timeout，无参数/void；例上帧5ms前启动则请求等约11ms，宿主计时取整/调度影响实际时刻，回调/绘制错误不吞。
	private scheduleRender(): void {
		// 已停止、已有timer、或没有待绘制请求时不重复安排。
		if (this.stopped || this.renderTimer || !this.renderRequested) {
			// 这些门禁成立就结束，renderRequested是否保留取决于之前流程。
			return;
		}
		// 当前单调时间减上次启动时间，计算已过间隔。
		const elapsed = performance.now() - this.lastRenderAt;
		// 16减已过时间，最少0；0也仍用异步setTimeout，不是同步调用。
		const delay = Math.max(0, TuiBase.MIN_RENDER_INTERVAL_MS - elapsed);
		// 保存新定时器，下面箭头体到时间才执行。
		this.renderTimer = setTimeout(() => {
			// 回调启动就清掉本次句柄，允许绘制期间新请求安排下一帧。
			this.renderTimer = undefined;
			// 等待期间stop或请求已被renderNow满足，就不再画。
			if (this.stopped || !this.renderRequested) {
				// 已过时的timer回调结束。
				return;
			}
			// 这次要满足待处理请求，先清标志。
			this.renderRequested = false;
			// 记本帧实际启动时间，不能保证timer刚好按delay准点执行。
			this.lastRenderAt = performance.now();
			// 运行子类绘制；若抛错，下方检查新请求不会执行。
			this.doRender();
			// doRender期间若又requestRender，新标志为真，安排后续一帧。
			if (this.renderRequested) {
				// 递归的是调度函数，不是直接递归doRender，下一帧仍由timer执行。
				this.scheduleRender();
			}
			// delay作为本次setTimeout等待参数，单位毫秒。
		}, delay);
	}

	// 输入公共链：先消费颜色回复/主题报告→依次输入监听器→格尺寸回复→调试键→修正浮层焦点→过滤松开→交焦点组件→即时排帧。
	// 例如键盘"x"通常送编辑器，有pending查询时OSC颜色回复先被消费；监听器可把其他输入改成另一串或consume全部。
	// 只对焦点组件的handleInput做松开过滤，监听器/debug在前；Ctrl+C也由焦点组件自行处理。同步回调异常传播，后续链/排帧可能不执行。
	private handleTerminalInput(data: string): void {
		// 有pending颜色查询时优先把对应回复归入最早查询，不让监听器/编辑器看到。
		if (this.consumeTerminalColorResponse(data)) {
			// 已消费颜色报文就结束，未自动因此请求重绘。
			return;
		}
		// 合法深浅主题报告同样先消费，哪怕没有监听器或未启通知开关。
		if (this.consumeTerminalColorSchemeReport(data)) {
			// 报告交订阅者后不再当普通键盘输入。
			return;
		}

		// 只有存在输入监听器才建立替换链；Set顺序就是注册顺序。
		if (this.inputListeners.size > 0) {
			// 当前流转字符串初始为原始data，后面监听器可以替换。
			let current = data;
			// 逐个同步调用监听器，后一个看前一个的改写结果；Set原地迭代，不复制监听器快照。
			for (const listener of this.inputListeners) {
				// 运行用户回调并保存可选决策，异常不在此捕获。
				const result = listener(current);
				// consume为真优先于同一结果的data替换。
				if (result?.consume) {
					// 立即消费整个输入，不再调用后续监听器/协议处理/焦点组件。
					return;
				}
				// 明确提供了data时才替换，空字符串也是有效改写值。
				if (result?.data !== undefined) {
					// 后续监听器收到新的current，未把整个结果对象当输入。
					current = result.data;
				}
			}
			// 替换链最终为空串表示无需再处理。
			if (current.length === 0) {
				// 空串直接结束，也不触发焦点组件绘制。
				return;
			}
			// 把链末文本写回本次局部参数data，不修改终端原始输入缓存。
			data = current;
		}

		// Consume terminal cell size responses without blocking unrelated input.
		// 改写后的字符串再检查格像素尺寸回复；未阻塞等待，所以普通Escape等可继续向下。
		if (this.consumeCellSizeResponse(data)) {
			// 完整尺寸回复（含非正数回复）被消费，不送编辑器。
			return;
		}

		// Global debug key handler (Shift+Ctrl+D)
		// 先匹配固定调试组合，再看onDebug是否存在；matchesKey可能改键解析全局状态且不排除release，原有固定键约定在这里保留。
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			// 命中且已注册就同步执行全局调试回调。
			this.onDebug();
			// 调试键结束，不再交焦点/不自动排即时帧。
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		// 按焦点组件身份找首个对应浮层，不先要求当前可见。
		const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
		// 浮层因resize/visible动态变化已不可见，需重定向当前输入。
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			// 优先找仍可见的捕获型视觉最前浮层，不让被动浮层自动抢输入。
			const topVisible = this.getTopmostVisibleOverlay();
			// 有其他可见捕获目标时直接聚焦它。
			if (topVisible) {
				// 统一状态机还会设置新浮层eligible。
				this.setFocus(topVisible.component);
			} else {
				// 没有候选则回当前浮层preFocus，用preserve保留临时不可见浮层日后恢复资格，和显式hide的清理不同。
				this.setFocusInternal({ component: focusedOverlay.preFocus, overlayFocusRestore: "preserve" });
			}
		}

		// 焦点若仍是栈中某浮层，下面的基础焦点恢复逻辑不执行；此处只按身份，不再查visible。
		const focusIsOverlay = this.overlayStack.some((o) => o.component === this.focusedComponent);
		// 当前基础组件或null才考虑自动恢复可见浮层。
		if (!focusIsOverlay) {
			// 获取当前有效可见的恢复状态，暂不可见只返回inactive视图。
			const restoreState = this.getVisibleOverlayFocusRestore();
			// eligible表示无临时替代者阻挡，可以在本次输入送达前恢复浮层。
			if (restoreState.status === "eligible") {
				// 把键盘焦点先交回该浮层，这个data随后由它处理。
				this.setFocus(restoreState.overlay.component);
				// blocked的替代者已不再是当前焦点，认为可以执行resume；替代者仍活跃时不抢输入。
			} else if (restoreState.status === "blocked" && restoreState.blockedBy !== this.focusedComponent) {
				// 默认恢复动作是回原浮层。
				if (restoreState.resume.status === "restore-overlay") {
					// 恢复该浮层组件并重建eligible。
					this.setFocus(restoreState.overlay.component);
				} else {
					// 显式focus-target动作先清旧浮层恢复资格。
					this.clearOverlayFocusRestore();
					// 按记录目标设置焦点，目标可null，不回旧浮层。
					this.setFocus(restoreState.resume.target);
				}
			}
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		// 最终焦点有handleInput才交键；没有则这块输入到此自然结束。
		if (this.focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			// 检测到松开标记且组件没明确wantsKeyRelease时过滤；粘贴块等由isKeyRelease的有限规则排除。
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				// 被过滤输入不交组件，也不排即时绘制。
				return;
			}
			// 同步运行最终焦点组件输入处理，包含Ctrl+C；它可改变焦点/组件树或抛错。
			this.focusedComponent.handleInput(data);
			// Keyboard input is latency-sensitive. Avoid the throttled timer path,
			// where even setTimeout(0) can take a full 16 ms tick on Windows.
			// 输入处理正常返回后安排nextTick绘制，不等普通timer间隔，让一次批量输入可合并成一帧。
			this.requestImmediateRender();
		}
	}

	// 尝试把data作为最早pending颜色查询的回复消费，返回boolean；例OSC11记录背景，DA1结束并移出队首。
	// 未pending或不像回复则false；重复/已完成查询的颜色串仍true吞掉，避免键入编辑器。用户晚回复回调可能抛错。
	// 计replied按实际收到的不同目标，不额外限定OSC4索引<=15；解析不了颜色也记已回复，完整palette仍须每槽有RGB。
	private consumeTerminalColorResponse(data: string): boolean {
		// 只处理队首查询；依赖终端按询问顺序返回及DA1分组，不按ID为并发查询乱序匹配。
		const query = this.pendingTerminalColorQueries[0];
		// 队列为空时不把颜色外壳保留为特殊输入。
		if (!query) {
			// 返回false让正常输入链继续；无pending的OSC色串可能交给普通监听器/组件。
			return false;
		}
		// DA1设备属性完整报文作为当前颜色查询结束标记，即使它没有实际返回全部颜色。
		if (DEVICE_ATTRIBUTES_RESPONSE_PATTERN.test(data)) {
			// 先从FIFO队列移出当前项，下一次回复归下一个查询。
			this.pendingTerminalColorQueries.shift();
			// 取消它的timeout、清deliver并投递当前已收到结果或晚回复汇总。
			this.completeTerminalColorQuery(query);
			// DA1已消费，不能传给编辑器。
			return true;
		}

		// 只解析单条完整OSC颜色回复，分片组合由Terminal/StdinBuffer等上游负责。
		const response = parseOscColorResponse(data);
		// 不像支持的OSC10/11/4报文就不是本分支能消费的数据。
		if (!response) {
			// 普通输入继续走监听器/后续协议处理。
			return false;
		}
		// 解构回复目标及RGB，rgb可能undefined但仍是一次回复。
		const { target, rgb } = response;
		// 前景/背景为字符串，调色板数字索引也String化，统一Set去重键。
		const key = String(target);
		// deliver已清或这个目标已回复时，丢弃重复/已完成的颜色，不再改查询结果。
		if (!query.deliver || query.replied.has(key)) {
			// 仍返回true消费，防重复回复流入编辑器。
			return true;
		}
		// 新目标记一次；即使索引>=16或颜色解析失败也计入集合。
		query.replied.add(key);
		// 目标为默认前景时存到专门字段。
		if (target === "foreground") {
			// 保存RGB或undefined，不代入默认色。
			query.foreground = rgb;
			// 目标为默认背景时存到背景字段。
		} else if (target === "background") {
			// 同样允许回复形状合法但色值不可解析。
			query.background = rgb;
			// 剩余目标是数字，仅小于16的索引写入请求的16槽调色板；解析器只给非负十进制索引。
		} else if (target < TERMINAL_PALETTE_SIZE) {
			// 按索引保存该色；不完整/坏色让最终palette仍undefined。
			query.palette[target] = rgb;
		}
		// 不同回复目标个数恰好18时提前完成；不是逐一核查这18个名字都为所请求集合。
		if (query.replied.size === TERMINAL_COLOR_REPLY_COUNT) {
			// 清deliver/timeout并投递，但此处不shift队列，继续消费晚来数据直到DA1。
			this.completeTerminalColorQuery(query);
		}
		// 识别出的颜色回复无论是否完备都算消费。
		return true;
	}

	// 把query当前记录投影成TerminalColors，无终端IO/查询状态修改；例只收到背景时前景与palette缺失，完整palette返回内部数组引用而非深拷贝。
	private terminalColorQueryResult(query: PendingTerminalColorQuery): TerminalColors {
		// every确认每个实际槽都非undefined后，as让TS将数组视为RgbColor[]；正常初始化是16个显式undefined，不靠稀疏空槽代表缺色。
		const palette = query.palette.every((color) => color !== undefined) ? (query.palette as RgbColor[]) : undefined;
		// 创建新结果外壳，但RGB对象/完整palette共用引用；超时返回结果不等于冻结后续查询状态。
		return { foreground: query.foreground, background: query.background, palette };
	}

	// 结束当前query的一次投递：清deliver/timeout后调用先前回调，返回void，不自行出队。例DA1或18目标触发，可交Promise resolve或晚回复汇总；回调抛错向外传但已清deliver。
	private completeTerminalColorQuery(query: PendingTerminalColorQuery): void {
		// 先保存当前投递函数，后面清字段使重入/重复完成不再二次投递。
		const deliver = query.deliver;
		// 先标完成，再调用外部函数；不是等回调成功才清理。
		query.deliver = undefined;
		// 取消尚未触发的本查询超时，字段本身仍保留原句柄值。
		clearTimeout(query.timer);
		// 有deliver才计算并投递当前结果；undefined时可选调用连实参求值也跳过。
		deliver?.(this.terminalColorQueryResult(query));
	}

	// 识别并分发深浅报告，返回是否消费；例连续dark/light报告按最后light通知所有监听器，不查enabled开关，不自动排render，订阅者抛错中断后续订阅者。
	private consumeTerminalColorSchemeReport(data: string): boolean {
		// 纯解析助手接受支持的整串报告，返回dark/light或undefined。
		const scheme = parseTerminalColorSchemeReport(data);
		// 非合法报告则交回正常输入链。
		if (!scheme) {
			// false表示没有消费此data。
			return false;
		}

		// 直接按Set迭代订阅者，没复制快照，回调可能增删订阅或抛错。
		for (const listener of this.terminalColorSchemeListeners) {
			// 同步传解析出的最后一个深浅模式；应用自行决定主题更新。
			listener(scheme);
		}
		// 即使没有订阅者，合法报告也算消费。
		return true;
	}

	// 识别CSI6;高;宽t格像素回复，合法正尺寸更新共享缓存、失效组件并排帧，返回是否消费；例20;10更新heightPx20/widthPx10。未要求此前pending查询，数字仅做>0检查，非正回复消费但不更新。
	private consumeCellSizeResponse(data: string): boolean {
		// Response format: ESC [ 6 ; height ; width t
		// 整串匹配两段十进制数字，高度在前宽度在后；不拼分片、不消费混合普通文字的串。
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		// 不像尺寸回复直接未消费。
		if (!match) {
			// false让后续debug/焦点组件继续看到普通输入。
			return false;
		}

		// 按十进制解析第一组为像素高；过长数字可变成Infinity，这里未检查finite/安全整数。
		const heightPx = parseInt(match[1], 10);
		// 第二组为像素宽，不是终端总列数。
		const widthPx = parseInt(match[2], 10);
		// 高度或宽度非正就不使用；正则确保有数字文本，但这个条件不是完整数值范围验证。
		if (heightPx <= 0 || widthPx <= 0) {
			// 形状是回复仍消费，不把0尺寸报文交编辑器。
			return true;
		}

		// 把尺寸写入terminal-image模块共享缓存，可能影响其他图片组件/渲染器。
		setCellDimensions({ widthPx, heightPx });
		// Invalidate all components so images re-render with correct dimensions.
		// 让所有已识别挂载根与浮层失效，图片下帧可据新格尺寸重算。
		this.invalidate();
		// 普通请求后续重绘，不在回复处理里同步画。
		this.requestRender();
		// 数据已消费，输入公共链到此结束。
		return true;
	}

	/**
	 * Resolve overlay layout from options.
	 * Returns { width, row, col, maxHeight } for rendering.
	 */
	// 把浮层options、测得内容高及终端尺寸换算成{width,row,col,maxHeight}，只计算，不render/输出，返回新对象。
	// 先处理留白→宽/可选最高→位置（显式坐标优先锚点）→偏移→边界夹取；例终端100列、width50%得到请求50，再受margin约束。
	// 数字未统一取整/finite验证；过大margin、未限高的超高内容、NaN等不保证最终矩形都在物理屏内，正常调用应使用合理格数。
	private resolveOverlayLayout(
		// 配置可缺省，内层用空对象代替。
		options: OverlayOptions | undefined,
		// 浮层已测到的行数；预计算宽度时可传0，最终布局再传实际截断后高度。
		overlayHeight: number,
		// 终端当前列数，宽度百分比以此完整尺寸为参考。
		termWidth: number,
		// 终端当前可见行数，maxHeight百分比以此为参考。
		termHeight: number,
		// 内联对象返回类型列明四个字段；maxHeight字段总在对象里，值可undefined。
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		// nullish合并只在null/undefined时用空配置，不复制原options。
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		// 把单值留白展开为四边对象，或读取独立边配置。
		const margin =
			// 数字分支包括小数/NaN等，后面只做Math.max夹负，不是完整配置校验。
			typeof opt.margin === "number"
				? // 同一个数分别放到top/right/bottom/left。
					{ top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: // 对象留白原样引用，未给则空对象；括号让??结果作为三元分支整体。
					(opt.margin ?? {});
		// 顶部未给按0，负数夹0。
		const marginTop = Math.max(0, margin.top ?? 0);
		// 右侧未给按0，负数夹0。
		const marginRight = Math.max(0, margin.right ?? 0);
		// 底部未给按0，负数夹0。
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		// 左侧未给按0，负数夹0；NaN仍会经Math.max变NaN而非变0。
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		// 扣左右留白后至少给1列预算；留白超屏时这1列不表示屏内真的还有空间。
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		// 扣上下留白后至少给1行，主要避免通常布局出现0尺寸。
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		// 先按完整终端宽解析width；无值/坏百分比默认min(80,可用宽)，并非无条件占满屏。
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		// 明确给minWidth时才抬高请求宽。
		if (opt.minWidth !== undefined) {
			// 二者取大，仍将在下一步受可用宽上限约束。
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		// 先不超可用宽，再至少1列；这是宽度夹取，不对所有异常数字做净化。
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		// 最高按完整终端高计算，undefined表示不设置截断上限。
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		// 仅显式解析出maxHeight时才夹取，不自动把没设置的上限补成availHeight。
		if (maxHeight !== undefined) {
			// 最高落在至少1、至多可用高的通常范围内；maxHeight=0会被抬成1。
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by maxHeight)
		// 位置计算使用截断后的有效高；未给maxHeight时仍按全部内容高，即使超出可用高度。
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === Resolve position ===
		// 声明待赋值行坐标，TS检查下面分支覆盖赋值。
		let row: number;
		// 声明待赋值列坐标，和行分别按配置决定。
		let col: number;

		// 显式row优先于anchor的纵向定位。
		if (opt.row !== undefined) {
			// 字符串走百分比语法，数字走绝对行。
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				// 仅非负十进制百分比格式；无空格/负号/指数，超过100的数稍后还会夹取。
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				// 有效百分比才用可移动距离插值。
				if (match) {
					// 可用高减浮层有效高是起点可移动范围，负时夹0。
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					// 捕获的百分数除100变比例，例如50→0.5。
					const percent = parseFloat(match[1]) / 100;
					// 从顶部留白起按范围比例向下移动并向下取整；100%通常让浮层底对齐可用区底。
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					// 字符串格式无效只在纵轴回中心，不采用配置中的其他anchor纵向值。
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				// 数字row作为绝对终端行，留白不直接相加，末尾统一夹边界。
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			// 未设置row时读anchor，缺省center。
			const anchor = opt.anchor ?? "center";
			// 由锚点、有效高、可用高与顶部留白算行。
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		// 显式col优先于anchor的横向定位，独立于row判断。
		if (opt.col !== undefined) {
			// 字符串用百分比定位，数字为绝对终端列。
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				// 横轴百分比用同一有限十进制语法。
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				// 有效匹配才按可移动宽计算。
				if (match) {
					// 扣除浮层宽的可用范围，避免把100%理解成起点放到最右列之外。
					const maxCol = Math.max(0, availWidth - width);
					// 百分数转比例，未在此把比例夹[0,1]。
					const percent = parseFloat(match[1]) / 100;
					// 以左留白为起点插值并向下取整。
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					// 无效字符串横坐标回水平中心，不抛格式错误。
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				// 绝对col直接采用，后面再夹到考虑留白的范围。
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			// 未给col时沿用anchor或center的横向部分。
			const anchor = opt.anchor ?? "center";
			// 计算锚点列，传本轮已确定宽度与可用宽度。
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		// 有offsetY就加到已计算行坐标，正下负上。
		if (opt.offsetY !== undefined) row += opt.offsetY;
		// 有offsetX就加列，正右负左；数字小数不在此取整。
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		// 行至少为marginTop、通常不超屏底减底留白减内容高；上下界冲突时Math.max保留下界，不能承诺超大留白/内容仍完整屏内。
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		// 列按左留白与右边界夹取；同样未处理NaN或冲突边界为专门错误。
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		// 对象属性简写返回计算结果，不写options/组件状态。
		return { width, row, col, maxHeight };
	}

	// 根据anchor的纵向部分返回屏内起行，不修改状态；例可用高20、内容高4、顶部2时center得到10，超高内容的最终夹取由调用方负责。
	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		// switch按字符串分组，多个case连续共用一条return。
		switch (anchor) {
			// 左上锚点属于顶部组。
			case "top-left":
			// 顶部居中也同一纵坐标。
			case "top-center":
			// 右上仍贴顶，水平差异由另一个函数计算。
			case "top-right":
				// 顶部组从顶部留白处起。
				return marginTop;
			// 左下属于底部组。
			case "bottom-left":
			// 底部居中使用同一底部行计算。
			case "bottom-center":
			// 右下也贴底。
			case "bottom-right":
				// 可用区末端减内容高，再加顶部起点得到贴底起行。
				return marginTop + availHeight - height;
			// 左侧居中属于垂直中心组。
			case "left-center":
			// 整体center也在中心组。
			case "center":
			// 右侧居中同一行。
			case "right-center":
				// 剩余高除2向下取整，再加顶部留白，奇数剩余时较多空白在下侧。
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	// 根据anchor横向部分返回起列，无IO/修改；例可用宽80、浮层20、左留白0时center列30，贴边/夹取由外层组合。
	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		// 横轴同样把九种锚点分成左/右/中三组。
		switch (anchor) {
			// 左上属于左组。
			case "top-left":
			// 左中也贴左。
			case "left-center":
			// 左下同样从左留白起。
			case "bottom-left":
				// 左组直接返回marginLeft。
				return marginLeft;
			// 右上属于右组。
			case "top-right":
			// 右中同一列计算。
			case "right-center":
			// 右下也贴右。
			case "bottom-right":
				// 可用区末端减浮层宽，加左起点。
				return marginLeft + availWidth - width;
			// 顶部居中属于水平中心组。
			case "top-center":
			// 整体居中同一横坐标。
			case "center":
			// 底部居中也使用中心列。
			case "bottom-center":
				// 剩余宽除2向下取整后加左留白，奇数多余格在右侧。
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
	// 将所有当前可见浮层按focusOrder由低到高覆盖到基础lines，返回新行数组并更新条目bounds/鼠标布局；不直接写终端。
	// 两遍布局：先用高度0求宽/最高→按宽render并截高→按实际高定坐标，再补足工作区并逐行合成；例后画菜单覆盖先画通知。
	// 栈空时返回原lines并清鼠标布局；有栈但全隐藏也可能补到终端高。只复用字符串，不修改原数组容器；visible/render异常可留下部分几何状态。
	protected compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		// 没有任何条目时不需要复制或补行。
		if (this.overlayStack.length === 0) {
			// 清掉旧的鼠标浮层矩形快照；前提是调用方确实调用了这个函数。
			this.renderedOverlayLayouts = [];
			// 直接返回输入数组原引用。
			return lines;
		}
		// 存在条目时浅复制基础行数组，后续覆盖不改输入容器。
		const result = [...lines];

		// 先清所有条目的旧bounds，隐藏条目本轮不会再建立矩形。
		for (const entry of this.overlayStack) entry.bounds = undefined;

		// Pre-render all visible overlays and calculate positions
		// 本轮待合成列表，保存条目、行数组、屏内行列及宽；内联对象数组类型只供TS检查。
		const rendered: { entry: OverlayStackEntry; overlayLines: string[]; row: number; col: number; w: number }[] = [];
		// 所需逻辑行数先至少容纳基础内容，浮层可能把它继续撑高。
		let minLinesNeeded = result.length;

		// 同步检查每个条目可见性，得到新数组，隐藏/visible=false排除。
		const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
		// 仅排序新可见数组，不改插入栈；focusOrder低先画、高后画。
		visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
		// 按视觉从后景到前景预渲染每层。
		for (const entry of visibleEntries) {
			// 解构组件与原配置，未克隆配置对象。
			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height)
			// 高度先用0只取width/maxHeight；这两项只由配置和终端尺寸决定，先忽略此遍的位置。
			const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			// 真正调用浮层render(width)，先把伪光标标记解成样式/按配置去掉焦点包裹，得到新数组。
			let overlayLines = this.resolveFakeCursors(component.render(width));

			// Apply maxHeight if specified
			// 只有设置了最高且实际返回行数超出才截。
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				// 保留前maxHeight行，直接丢底部行；不实现浮层内部滚动。
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// Get final row/col with actual overlay height
			// 用截断后实际高度再算最终row/col，居中/贴底需要这次高度。
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);
			// 保存终端相对矩形供句柄getBounds读取；它不是最终正文逻辑行号。
			entry.bounds = { row, col, width, height: overlayLines.length };

			// 记录这层的全部合成数据，width重命名w便于下方解构。
			rendered.push({ entry, overlayLines, row, col, w: width });
			// 工作区至少延伸到浮层屏内起行+实际高，超高内容可能增加逻辑工作区。
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}
		// map把本轮临时列表投影成鼠标矩形快照，箭头返回对象用({ ... })避免被当代码块。
		this.renderedOverlayLayouts = rendered.map(({ entry, row, col, w, overlayLines }) => ({
			// 保留原条目引用，命中时调用它的组件。
			entry,
			// 保存屏内行。
			row,
			// 保存屏内列。
			col,
			// 临时w映射到公开width字段。
			width: w,
			// 鼠标高度采用本轮实际行数。
			height: overlayLines.length,
		}));

		// Pad to at least terminal height so overlays have screen-relative positions.
		// Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing
		// inflation that pushed content into scrollback on terminal widen.
		// 工作区取基础行、终端高、浮层所需行最大值，不把历史maxLinesRendered带入以免越补越高。
		const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement or working area
		// 基础内容不足工作区时，逐行补空串。
		while (result.length < workingHeight) {
			// 只扩展新result，不向原lines追加。
			result.push("");
		}

		// 逻辑工作区最后termHeight行视为可见窗口，浮层row相对此窗口定位。
		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Composite each overlay
		// 按先前排序顺序逐层覆盖，后者可替换前者已合成文字。
		for (const { overlayLines, row, col, w } of rendered) {
			// 逐行处理这层内容。
			for (let i = 0; i < overlayLines.length; i++) {
				// 可见窗口逻辑起点+浮层屏内行+浮层内部行号，转换成result数组索引。
				const idx = viewportStart + row + i;
				// 索引必须在逻辑工作区内才合成；这不是完整物理屏行范围验证。
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					// 准备浮层这行文字，下面三元按其显示宽度决定是否严格截片。
					const truncatedOverlayLine =
						// 超声明宽才sliceByColumn，宽字跨边界整个丢弃；未超宽就保留原串。
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					// 将浮层行覆盖到指定列宽；底行若含图片，compositeTuiLine会保留图片行不覆盖。
					result[idx] = this.compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
				}
			}
		}

		// 返回合成后的工作区完整行数组，具体屏幕子类再做差量/视口输出。
		return result;
	}

	// 把普通行终端输出规范化并追加段重置，原地改lines并返回同一数组；例tab变固定空格、行尾关样式/链接，图片行完全跳过，无终端IO。
	protected applyLineResets(lines: string[]): string[] {
		// 复用SGR0+空OSC8常量，不每次重新构造协议文本。
		const reset = SEGMENT_RESET;
		// 遍历整份行数组并按索引更新，不创建新数组容器。
		for (let i = 0; i < lines.length; i++) {
			// 取当前原行，避免在下面重复访问数组项。
			const line = lines[i];
			// 含支持图片前缀的行跳过，避免修改图片载荷/协议；前缀识别不是完整验证。
			if (!isImageLine(line)) {
				// 先规范化Thai/Lao AM元音与可见tab，再追加样式/链接关闭串；不会改编辑器内部保存的逻辑文本。
				lines[i] = normalizeTerminalOutput(line) + reset;
			}
		}
		// 返回同一个已修改lines引用，调用方可继续赋值给newLines。
		return lines;
	}

	// 实例私有转发助手，把底行/浮层行/起列/覆盖宽/总宽交公共compositeTuiLine，返回字符串，无额外修改/IO；例基类合成浮层统一走同一ANSI和宽字边界规则。
	private compositeLineAt(
		// 底层一行，可以已有样式/链接或低层浮层。
		baseLine: string,
		// 当前更高层浮层一行。
		overlayLine: string,
		// 0基显示起列。
		startCol: number,
		// 此浮层声明覆盖列数。
		overlayWidth: number,
		// 终端总列数，防合成结果超宽。
		totalWidth: number,
	): string {
		// 原样转发五参数，不维护额外合成缓存。
		return compositeTuiLine(baseLine, overlayLine, startCol, overlayWidth, totalWidth);
	}

	/**
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	// 从lines底部可见height行由下往上找第一个含CURSOR_MARKER的行，计算其前缀显示宽并移除找到的一个标记，返回逻辑{row,col}或null。
	// 例行"中文<标记>x"得到col4；row是整个lines数组索引，不是屏内行。会原地改找到的行，不清其他标记/视口外标记，无终端写入。
	protected extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// Only scan the bottom `height` lines (visible viewport)
		// 只搜索末尾可见窗口，内容不足一屏时从0开始。
		const viewportTop = Math.max(0, lines.length - height);
		// 从最后行往上，优先底部的光标标记，找到即return。
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			// 当前行原始字符串，ANSI码不等于可见格。
			const line = lines[row];
			// indexOf取本行首个标记的UTF-16下标，不是显示列。
			const markerIndex = line.indexOf(CURSOR_MARKER);
			// 找到标记才计算/移除，否则继续上一行。
			if (markerIndex !== -1) {
				// Calculate visual column (width of text before marker)
				// 按码元切出标记之前的原文及ANSI，用于测它的实际显示位置。
				const beforeMarker = line.slice(0, markerIndex);
				// visibleWidth忽略支持的控制序列并按宽字/字素计列。
				const col = visibleWidth(beforeMarker);

				// Strip marker from the line
				// 把标记左右两段拼回原数组当前位置，只删除这一处标记，不改变其他行。
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				// 属性简写返回逻辑行索引与显示列，后续子类负责真正定位光标。
				return { row, col };
			}
		}
		// 可见范围未找到标记，返回null，渲染器通常据此隐藏硬件光标。
		return null;
	}

	/**
	 * Resolve fake cursor markers to reverse video. When the hardware cursor is shown, a fake cursor
	 * directly after CURSOR_MARKER is dropped because the terminal cursor is drawn there. Fake cursors
	 * of components without focus have no CURSOR_MARKER and stay visible.
	 */
	// 逐行把伪光标包裹转成反色样式并返回新数组，无IO；硬件光标显示时先去掉紧随真实定位标记的一处伪包裹，保留文字。例焦点Input用真实光标，非焦点Input仍反色，不修改原数组。
	protected resolveFakeCursors(lines: string[]): string[] {
		// map同步处理每个行字符串，构建独立数组。
		return lines.map((line) => {
			// 没有起始标记直接保留整行；孤立结束标记也不会在此快路径被替换。
			if (!line.includes(FAKE_CURSOR_START)) return line;
			// 硬件光标开时用捕获$1$2保留定位标记/文字、删除首个焦点伪包裹，串尾缺结束标记也支持；关时先保留原串。
			const resolved = this.showHardwareCursor ? line.replace(FOCUSED_FAKE_CURSOR, "$1$2") : line;
			// 剩余所有伪起点变SGR7反色、终点变SGR27关闭反色，未对输入标记配对进行完整验证。
			return resolved.replaceAll(FAKE_CURSOR_START, "\x1b[7m").replaceAll(FAKE_CURSOR_END, "\x1b[27m");
		});
	}

	/**
	 * Query the terminal's theme colors: the default foreground (OSC 10), the default background
	 * (OSC 11), and ANSI colors 0-15 (OSC 4), followed by a DA1 request that marks the end of the
	 * replies. Resolves when the DA1 reply or all color replies arrive, or when the timeout expires.
	 * Colors the terminal did not report are undefined; the palette is only set when all 16 arrived.
	 * @param timeoutMs Query timeout in milliseconds, for terminals that do not answer DA1 either.
	 * @param onLateReply Receives the replies if the query completes after the timeout, e.g. over slow links.
	 */
	// 发送默认前/背景与16色查询，返回Promise<TerminalColors>；遇DA1、18不同目标或timeout先resolve当前可得结果。
	// 例如超时只收到背景，Promise先得背景、palette缺失；随后继续收同轮回复，到DA1或回复数触发完成时再给可选onLateReply一次汇总。
	// 查询成为队首后保留直到DA1，没DA1可能持续阻挡后续查询归组；stop不清这些timer/队列。多次查询依赖终端有序回复，并无每条请求ID。
	// Promise执行器中write抛错会使Promise拒绝，但已建立的timer/队列不自动回滚；晚回复回调在普通输入栈执行，异常不由这个Promise接管。
	queryTerminalColors({
		// 从参数对象解构必需timeoutMs，单位毫秒；未设默认对象，调用方必须传配置。
		timeoutMs,
		// 取可选晚回复回调，未给时超时后deliver变undefined，后续颜色仍消费但不再更新。
		onLateReply,
		// 解构参数后单独标注内联对象类型；不是把后面的字段当函数体赋值。
	}: {
		// 必需数字timeoutMs，由Node setTimeout解释，未在此做非负/有限范围校验。
		timeoutMs: number;
		// 可选回调收最终汇总颜色，返回void；不是新的Promise resolve函数。
		onLateReply?: (colors: TerminalColors) => void;
		// 正常异步结果类型允许缺失颜色；函数没有async关键字，直接返回new Promise。
	}): Promise<TerminalColors> {
		// Promise执行器同步运行，resolve由宿主提供；先建状态再发查询，完成路径/超时会resolve，同步模拟终端也可在write期间立刻回送回复。
		return new Promise((resolve) => {
			// 为本轮查询建立独立状态对象，不复制旧查询已得颜色。
			const query: PendingTerminalColorQuery = {
				// Array.from实建16个undefined槽，箭头每次返回undefined；避免Array(16)稀疏槽被every跳过误当完整。
				palette: Array.from({ length: TERMINAL_PALETTE_SIZE }, () => undefined),
				// 新Set记录每个已回复目标一次，重复回复不增加计数。
				replied: new Set(),
				// 初始投递函数是此Promise的resolve，成功响应先完成Promise。
				deliver: resolve,
				// 句柄先占位undefined，下面安排定时器后回写。
				timer: undefined,
			};
			// Resolve with the replies so far, and keep collecting late replies for `onLateReply`.
			// 为整轮查询排一次超时，构造回调不立即投递；正常提前完成会clearTimeout。
			query.timer = setTimeout(() => {
				// 超时后把未来最终投递改为可选晚回复回调，不在此移出队列。
				query.deliver = onLateReply;
				// 先resolve目前已得快照外壳；后续字段不自动补到这个外壳，完整palette若已存在仍可能共享数组引用。
				resolve(this.terminalColorQueryResult(query));
				// timeoutMs是本查询等待参数，不是渲染节流时间。
			}, timeoutMs);
			// 入FIFO队列后才写查询，保证同步模拟终端回复也能找到pending。
			this.pendingTerminalColorQueries.push(query);
			// 向适配器一次写完整查询串，此时才实际发送；没有自动start或检查stopped。
			this.terminal.write(TERMINAL_COLOR_QUERY);
		});
	}
}
