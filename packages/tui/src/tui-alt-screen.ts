// 全屏备用屏渲染器：用LayoutFrame掌管可见窗口，支持滚动、正文搜索、鼠标选择、滚动条、浮层和Kitty图片复用。
// 上游应用挂载组件并start；TuiBase管理公共焦点/输入/调度，本类注册视口输入监听器并实现doRender/启动停止钩子。
// 例聊天记录100行而窗口20行时，只画当前20行，滚动改变scrollTop；退出时可重新render全文到主屏，不依赖终端自身滚动历史。
// 实际IO通过Terminal或注入回调，OSC52复制只是请求，缓存不代表终端确认；输出/用户回调失败无统一回滚。
import {
	// 搜索栏组件，显示输入和上下项按钮。
	AltScreenSearchComponent,
	// 按正文行/查询维护匹配索引，复用未变搜索结果。
	AltScreenSearchIndex,
	// type导入只用于TS，匹配记录用多个行/列片段表示跨行结果。
	type AltScreenSearchMatch,
	// 从匹配位置生成稳定键，正文改变后尽量找回此前选中项。
	getAltScreenSearchMatchKey,
} from "./alt-screen-search.ts";
// 管理短暂提示及其到期计时器，本类把提示行叠到右上方。
import { AltScreenFlashContainer } from "./components/alt-screen-flash.ts";
// 可滚动组件，保存scrollTop/跟随末尾/滚动条状态，scrollBy返回未消耗行数。
import { ScrollView } from "./components/scroll-view.ts";
// 取当前可配置键位管理器，避免把视口动作写死成某一种键盘编码。
import { getKeybindings } from "./keybindings.ts";
// 识别松开事件的有限子串规则；视口动作消费松开但不重复执行。
import { isKeyRelease } from "./keys.ts";
// 布局助手给出坐标、裁剪、滚动节点与最终屏幕行，下面type字段均为编译期结构。
import {
	// 按屏幕点返回可见盒子，优先高层/深层，供鼠标组件命中。
	getLayoutBoxesAt,
	// 计算滚动条轨道/滑块几何，可请求包含暂时隐藏的auto轨道。
	getScrollbarGeometry,
	// 按ScrollView引用找当前布局盒子及其完整内容行。
	getScrollViewBox,
	// 找指针下的滚动视图，按嵌套深度由内向外排序。
	getScrollViewsAt,
	// LayoutFrame包括布局树、可见行及可选primaryScrollView，不是终端确认画面。
	type LayoutFrame,
	// 运行组件布局/渲染，生成内存屏幕并更新滚动边界，不直接写终端。
	renderLayoutFrame,
	// 滚动条几何含列、轨道高、滑块位置及最大滚动范围。
	type ScrollbarGeometry,
} from "./layout.ts";
// 识别Stack/ScrollView等组件的布局节点，区分真正布局树与普通纵向Container。
import { getLayoutNode } from "./layout-node.ts";
// Terminal仅是类型，运行时由调用方注入适配器；测试使用内存终端。
import type { Terminal } from "./terminal.ts";
// Kitty协议助手主要生成/解析字符串，能力冷探测可能查tmux；本类最终统一把控制串交Terminal。
import {
	// 生成删除所有可见Kitty图并释放数据的命令。
	deleteAllKittyImages,
	// 只删除放置保留图片数据，便于随后仅发placement重新显示。
	deleteAllKittyPlacements,
	// 按ID生成删除及释放该图数据的命令，缓存淘汰时使用。
	deleteKittyImage,
	// 读取共享终端能力，初次环境探测不保证真实硬件支持。
	getCapabilities,
	// 从已登记元数据的图片行提取代次/成本及仅放置替换串，不询问终端上传状态。
	getKittyImagePlacement,
	// 读取图片放置覆盖行数，供WezTerm交叠行重画判断。
	getKittyImagePlacementRows,
	// 图片协议类型为kitty/iterm2/null。
	type ImageProtocol,
	// 判断行内已知图片前缀，不是完整图片报文验证。
	isImageLine,
	// 改写共享能力缓存；iTerm2全屏期间临时关闭图片生成能力。
	setCapabilities,
	// 能力结构还包括真彩/超链接，临时覆盖时保留其他字段。
	type TerminalCapabilities,
} from "./terminal-image.ts";
// 公共TUI工具负责焦点、浮层、鼠标结果和光标标记；type项只供TS检查。
import {
	// Component是render/invalidate及可选输入能力契约。
	type Component,
	// 普通纵向Container，隐式文档委托它串联children。
	Container,
	// 焦点组件输出的内部真实光标定位标记。
	CURSOR_MARKER,
	// 按显示列合成一行并重置两侧样式/链接。
	compositeTuiLine,
	// 调用组件鼠标处理器并保留真正目标/坐标原点。
	dispatchMouseEvent,
	// 浮层控制句柄，搜索栏通过它关闭和读取最近矩形。
	type OverlayHandle,
	// 用保存的目标原点重算拖动/松开局部坐标。
	retargetMouseEvent,
	// 运行时基类，提供输入处理链和渲染调度等实现。
	TuiBase,
	// 按钮名类型，区别于原始SGR编码的位掩码。
	type TuiMouseButton,
	// 已处理结果，包含实际target和可选键盘focusTarget。
	type TuiMouseDispatchResult,
	// 保存组件与原点/宽高，持续手势可复用。
	type TuiMouseDispatchTarget,
	// 规范化鼠标事件类型，坐标以终端格计数。
	type TuiMouseEvent,
	// 停止选项，preserveScreen决定退出时是否重放正文。
	type TuiStopOptions,
	// 运行时全局symbol标记本实例支持独立布局根。
	VIEWPORT_TUI,
	// 视口TUI契约，要求symbol标记及setLayoutRoot。
	type ViewportTUI,
} from "./tui.ts";
// 文本工具按ANSI/字素/显示列处理，不能把这些列直接当字符串下标。
import {
	// 从UTF-16位置取可识别ANSI控制串，避免高亮时把它拆开。
	extractAnsiCode,
	// 给定显示格找到完整字素的列区间，选择边界吸附到整字。
	getGraphemeCellRange,
	// 查某显示列处生效的OSC8链接，点击释放时可交openUrl回调。
	getOsc8LinkAtColumn,
	// 取共享Intl词分段器，不是按空格简单split。
	getWordSegmenter,
	// 严格按显示列切片，边界放不下完整宽字时排除它。
	sliceByColumn,
	// 移除已识别终端控制序列，提取选择文字/分词用。
	stripTerminalSequences,
	// 按列宽截提示/按钮文字，可用空省略号表示直接截。
	truncateToWidth,
	// 测显示列数而非UTF-16码元数。
	visibleWidth,
} from "./utils.ts";
// 滚轮策略对象维护固定/auto加速状态；WheelScrollLines只作类型导入，构造策略不会主动滚动终端。
import { WheelScrollAccelerator, type WheelScrollLines } from "./wheel-scroll.ts";

// CSI ?1049h请求进入备用屏，通常保留原主屏；能力与实际行为由终端实现。
const ENTER_ALT_SCREEN = "\x1b[?1049h";
// CSI ?1049l退出备用屏，回主屏。
const EXIT_ALT_SCREEN = "\x1b[?1049l";
// 关闭自动折行，避免按绝对坐标画满宽时意外换行。
const DISABLE_AUTOWRAP = "\x1b[?7l";
// 停止/恢复时重新启用自动折行。
const ENABLE_AUTOWRAP = "\x1b[?7h";
// 启普通鼠标、按键拖动、焦点通知及SGR编码，不要求发送所有无按钮移动。
const ENABLE_BUTTON_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";
// 在前一组基础上启1003，接收所有指针移动，便于hover。
const ENABLE_ALL_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
// 退出时逆向关闭SGR编码、焦点/移动/按钮跟踪。
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
// 终端窗口获焦报告，不是某个Component.focused字段变化。
const FOCUS_IN = "\x1b[I";
// 终端窗口失焦报告，用于终止未完成手势/悬停。
const FOCUS_OUT = "\x1b[O";
// 同步输出开始请求，减少多行更新闪烁，不提供JS事务回滚。
const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
// 同步输出结束请求，由终端决定是否支持。
const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";
// 只去行首连续OSC133的A/B/C段，接受BEL或ST结尾，不清行中所有标记。
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
// 提示跳转只认行首OSC133 A，它在布局内容行中保留，发终端前才剥离。
const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;
// 整页滚动保留4行重叠，小视口至少移动1行。
const PAGE_SCROLL_OVERLAP = 4;
// Alt滚轮在策略算出的行数上再乘5。
const ALT_WHEEL_SCROLL_MULTIPLIER = 5;
// 最多保留16个屏外已上传图记录；可见图不计入这个淘汰配额。
const MAX_CACHED_OFFSCREEN_KITTY_IMAGES = 16;
// 屏外图传输成本估算上限32MiB，来源是控制串传输段码元数，通常ASCII近似字节，不是测量实际终端内存。
const MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES = 32 * 1024 * 1024;
// 屏外图解码成本按宽×高×4估算，合计上限64MiB；可见图不被此配额自动淘汰。
const MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES = 64 * 1024 * 1024;
// 连续点击判定500ms，计时用Date.now而不是按下次数永久累加。
const DOUBLE_CLICK_INTERVAL_MS = 500;
// 复制失败提示显示5000ms，成功提示使用flash默认时长。
const COPY_ERROR_FLASH_DURATION_MS = 5000;
// Regular mode delegates double-click selection to the terminal emulator. Fullscreen owns mouse selection,
// so it uses iTerm2's default "characters considered part of a word" set:
// https://github.com/gnachman/iTerm2/blob/7f4ff739721f95d0b93003d8701c4523a7edf261/sources/Settings/iTermPreferences.m#L743
// 这些独立分词片段可把相邻可选单词连成路径/带连字符词，例如foo/bar-baz；不把所有标点都当连接符。
const TERMINAL_WORD_SELECTION_JOINERS = new Set(["/", "-", "+", "\\", "~", "_", "."]);
// 模块初始化拿词分段器引用，后续按需segment，不读取系统剪贴板。
const wordSegmenter = getWordSegmenter();

// 单张Kitty图在本实例中的上传估计记录，不含像素/载荷，也没有远端确认消息。
interface CachedKittyImage {
	// 本地元数据传输代次，相同ID但代次变化仍需重新传输。
	transmissionGeneration: number;
	// 传输段长度成本，用于屏外缓存配额。
	transmissionBytes: number;
	// 解码RGBA成本估值，用于另一项配额。
	estimatedDecodedBytes: number;
}

// 选择点，row/col均为格坐标；有scrollView时row指其完整内容行，无时指屏幕行。
interface SelectionPoint {
	// 内容或屏幕0基行，具体坐标系由scrollView决定。
	row: number;
	// 0基显示列，不是UTF-16偏移。
	col: number;
	// ?允许省略，指定该点所属的滚动内容；两端不同ScrollView不组成有效选择。
	scrollView?: ScrollView;
	/** Whether this point lies between terminal cells rather than on a cell. */
	// true表示列是格之间的排他边界，例如词选择末端；缺省点表示落在某格上，末端需纳入整个字素。
	boundary?: boolean;
}

// 选择区间保存两端点，使用时再按前后次序规范化。
interface SelectionRange {
	// 区间起点，词/行选择通常是包含边界。
	start: SelectionPoint;
	// 区间终点可携boundary:true表示排他末界。
	end: SelectionPoint;
}

// 字符串字面量联合决定逐格/整词/整行扩展选择，TS限制状态拼写，不会生成额外运行枚举。
type SelectionGranularity = "character" | "word" | "line";

// 最近一次正文词点击位置/时间，供同一词范围内双击/三击判定。
interface ClickTarget {
	// 最近点击的墙钟毫秒时间。
	timestamp: number;
	// 连续次数1..3循环，下一次相符点击从3回1。
	count: number;
	// 所属内容/屏幕行，需和下一次相同。
	row: number;
	// 滚动视图身份，防不同内容区同坐标被当成连续点击。
	scrollView?: ScrollView;
	// 该词显示起列，允许第二次点词内不同字符。
	wordStart: number;
	// 该词显示末界，用范围相同判断同一个词。
	wordEnd: number;
}

// 原始SGR鼠标解析结果，仍保留按钮/修饰/移动位，随后才转规范化事件。
interface SgrMouseEvent {
	// 数值位掩码，低2位按钮，4/8/16修饰，32移动，64滚轮。
	button: number;
	// 已把协议从1计数的列减1，未夹终端范围。
	x: number;
	// 同理0基行，随后具体流程按需要夹取。
	y: number;
	// 小写m代表release，大写M代表其他鼠标动作。
	release: boolean;
}

// 已识别的垂直滚轮事件，水平滚轮不作为这个结构返回。
interface WheelEvent {
	// -1向上、1向下的数值字面量联合。
	direction: -1 | 1;
	// 事件屏幕0基列。
	x: number;
	// 事件屏幕0基行。
	y: number;
	// 原始button值，保留Alt等修饰位用于倍率/规范化。
	button: number;
}

// 活动滚动条拖拽状态，松开时清掉，不等同于正文文字选择。
interface ScrollbarDrag {
	// 当前拖动的滚动视图引用。
	scrollView: ScrollView;
	// 按下点距滑块顶部偏移，拖动时保持抓住相同位置。
	grabOffset: number;
}

// 鼠标下可用滚动条的滚动对象与几何，不修改ScrollView。
interface ScrollbarTarget {
	// 命中的滚动对象。
	scrollView: ScrollView;
	// 轨道/滑块屏幕矩形与滚动比例参数。
	geometry: ScrollbarGeometry;
}

// 跳到末尾提示的最近命中范围，只有一行高。
interface ScrollToEndIndicatorRect {
	// 提示所在屏幕行。
	row: number;
	// 提示第一列。
	column: number;
	// 可点击文字显示宽度，不包含整行空白。
	width: number;
}

// 搜索选中策略：query从锚点挑结果，retain尽量保留，next/previous循环跳项；类型联合不执行搜索。
type SearchSelectionMode = "query" | "retain" | "next" | "previous";

// 活动搜索状态，关闭后整对象丢弃；组件/索引分别负责交互与匹配。
interface ActiveSearch {
	// 搜索栏组件，显示查询与结果计数。
	component: AltScreenSearchComponent;
	// 当前搜索缓存索引，按原始渲染行/查询更新。
	index: AltScreenSearchIndex;
	// 搜索栏showOverlay返回的句柄，创建过程先建状态再赋句柄，因此可省略。
	overlay?: OverlayHandle;
	// 用户查询字符串，实际匹配会做搜索模块的空白/大小写规范化。
	query: string;
	// 全部匹配，按正文位置有序，用于二分定位和屏内高亮。
	matches: AltScreenSearchMatch[];
	// 当前匹配数组索引，-1表示没有选中。
	selectedIndex: number;
	// 选中匹配的位置键，正文更新后尝试重新找相同位置。
	selectedKey?: string;
	// 新查询选择匹配时偏好的正文锚点行，通常当前选择首行或主视口顶部。
	anchorRow: number;
	// 下一次refreshSearch要采用的策略，刷新后通常改retain。
	selectionMode: SearchSelectionMode;
}

// 搜索匹配在某屏幕行的高亮范围，只记录列与是否当前结果。
interface SearchHighlightRange {
	// 左闭显示列。
	startCol: number;
	// 右开显示列。
	endCol: number;
	// true使用当前匹配样式，false用其他匹配样式。
	current: boolean;
}

// 全屏实例配置，?字段可省略，回调在实际事件/渲染时执行；TS接口不自动验证实现/数值。
export interface TuiAltScreenOptions {
	/**
	 * Logical lines moved for each mouse-wheel event (default: 1). `"auto"` accelerates fast wheel
	 * spins on terminals that send one event per notch. Alt+wheel moves five times as far.
	 */
	// 固定每事件行数或auto加速，默认1；可由setter动态改，Alt另乘5。
	wheelScrollLines?: WheelScrollLines;
	/** Capture mouse events for viewport scrolling and application-owned text selection. */
	// 默认true，决定启动/停止发送鼠标启停控制码，不是handleViewportInput接收鼠标串的硬门禁。
	mouse?: boolean;
	/** Style a non-current transcript search match. */
	// 其他匹配文字着色回调，默认下划线，输入可能被ANSI边界拆成多段。
	searchMatchStyle?: (text: string) => string;
	/** Style the current transcript search match. */
	// 当前匹配样式，默认粗体+反色；回调需保留合理显示宽，异常会中断绘制。
	searchCurrentMatchStyle?: (text: string) => string;
	/** Style a transcript search navigation button. */
	// 搜索箭头按钮样式，hovered标识悬停；默认原文。
	searchNavigationButtonStyle?: (text: string, hovered: boolean) => string;
	/**
	 * Render a clickable jump-to-end label. It is centered on the last row of a follow-end
	 * primary scroll view while that view is scrolled away from its end.
	 */
	// 回主区末尾按钮的动态文案，仅主ScrollView支持follow且当前离末尾才显示；构造时不调用。
	scrollToEndIndicator?: () => string;
	/** Open an OSC 8 hyperlink activated with a primary-button click. */
	// 点击有效OSC8链接时的同步宿主回调，可能实际打开浏览器；本类只调用注入者，不直接联网。
	openUrl?: (url: string) => void;
	/** Handle an unmodified secondary-button press for clipboard paste. Currently enabled on Windows only. */
	// 仅Windows、非VSCode、无修饰右键按下时调用的同步粘贴动作；本类对它的同步抛错作尽力忽略。
	onRightClickPaste?: () => void;
	/** Automatically copy selected text to the clipboard on mouse release (default: true). */
	// 默认true，鼠标完成选择时尝试复制；false仍保留可见选择，可手动调用copyActiveSelectionToClipboard。
	copyOnSelect?: boolean;
	/**
	 * Copy selected text to the system clipboard. Return `true` on success, an error message to
	 * display on failure, or `false` for a generic error. When omitted, the selection is copied
	 * via an OSC 52 write.
	 */
	// 异步复制回调，只有严格true算成功，string显示失败详情，false通用失败；缺省用OSC52写出并直接报告发送成功，不验证系统剪贴板。
	copySelection?: (text: string) => Promise<boolean | string>;
}

/** Alternate-screen TUI with a scrollable, application-owned viewport. */
// 全屏实现继承TuiBase，使用独立布局根或把children包进隐式主ScrollView；例如聊天正文滚动、编辑器dock固定。
// 生命周期钩子负责备用屏/鼠标/图片模式，doRender负责布局及合成后绝对坐标写行，输入监听器负责视口和鼠标。
// 缓存/选择/搜索都保存在实例，图片能力临时覆盖是模块共享状态；写终端失败可能已有本地状态更新，不能当成事务。
export class TuiAltScreen extends TuiBase implements ViewportTUI {
	// readonly/as const只约束TS，mode类型收窄为fullscreen字面量。
	readonly mode = "fullscreen" as const;
	// symbol计算属性名标记视口能力，字面量true供isViewportTUI识别。
	readonly [VIEWPORT_TUI] = true as const;
	// 上一帧处理后的屏幕行，作为差量比较与无滚动区选择来源；不是终端回读。
	private previousScreen: string[] = [];
	// 退出时重render出的全文缓存，不是持续记录所有历史输出。
	private lastDocument: string[] = [];
	// 上一帧列数，初始0让首帧整绘。
	private previousScreenWidth = 0;
	// 上一帧行高，resize后整绘。
	private previousScreenHeight = 0;
	// 可选独立布局根，有它时不以children隐式滚动区作为屏幕根。
	private layoutRoot: Component | undefined;
	// 最近成功写出后保存的布局帧，供输入命中/选择坐标换算。
	private currentLayout: LayoutFrame | undefined;
	// 把父Container的render/鼠标/失效包装成普通组件，作为隐式滚动内容。
	private readonly implicitDocument: Component;
	// 未设置layoutRoot时使用的跟随末尾主滚动区，也是找不到主区时的回退对象。
	private readonly implicitScrollView: ScrollView;
	// 提示栈组件，管理每条flash到期任务。
	private readonly flashes: AltScreenFlashContainer;
	// 是否已经执行进入备用屏钩子；doRender在未激活时直接跳过。
	private altScreenActive = false;
	// 启动时记下图片协议，即使iTerm2临时关闭共享图片能力仍保存iterm2以处理原始报文。
	private imageProtocol: ImageProtocol = null;
	// iTerm2启动前共享能力原引用，正常退出时恢复，异常不保证跑到恢复步骤。
	private savedCapabilities?: TerminalCapabilities;
	// ID→本地上传估计Map，按删除再插入维护最近可见顺序；readonly禁止重绑Map，内容可修改。
	private readonly uploadedKittyImages = new Map<number, CachedKittyImage>();
	// 文字选择锚点，可属于某滚动内容坐标系。
	private selectionAnchor?: SelectionPoint;
	// 当前拖拽/选择另一端，getSelectionBounds再规范两端顺序。
	private selectionFocus?: SelectionPoint;
	// 初始按字格选择，双击/三击切词/行。
	private selectionGranularity: SelectionGranularity = "character";
	// 词/行选择最初完整范围，拖动向前向后扩展时用它保留初选。
	private selectionInitialRange?: SelectionRange;
	// 正文连续点击历史，和组件自管点击计数分开。
	private lastClick?: ClickTarget;
	// 边缘自动滚动时保留的最后屏幕指针位置；?表示当前没有拖动任务。
	private selectionDragPointer?: { x: number; y: number };
	// 自动滚动方向，0停，-1上，1下。
	private selectionAutoScrollDirection: -1 | 0 | 1 = 0;
	// 50ms重复滚动计时器，停止选择/生命周期会清理，unref避免单独阻止进程退出。
	private selectionAutoScrollTimer?: NodeJS.Timeout;
	// 正文选择是否仍有有效按下，防失焦/松开后的孤立拖动继续延伸。
	private selectionPressActive = false;
	// 当前滚动条拖拽对象/抓取偏移。
	private scrollbarDrag?: ScrollbarDrag;
	// 正在悬停激活的滚动条对象，用来延长auto显示。
	private scrollbarHover?: ScrollView;
	// 最近绘制的末尾提示命中矩形，每次合成提示先清再重建。
	private scrollToEndIndicatorRect?: ScrollToEndIndicatorRect;
	// 活动正文搜索，undefined表示搜索栏关闭。
	private activeSearch?: ActiveSearch;
	// 按下时所在OSC8链接，拖动会清除，松开仍是点击才可能打开。
	private pressedUrl?: string;
	// 这次正文按下后是否发生过拖动，阻止拖后误开链接。
	private selectionDragged = false;
	// 组件请求持续捕获的实际鼠标目标，拖出原矩形仍定向此处。
	private mouseCapture?: TuiMouseDispatchTarget;
	// 组件按下命中目标，即使未明确capture也用于把释放/点击送回原处。
	private mousePressTarget?: TuiMouseDispatchTarget;
	// 组件按下绝对坐标，松开同点且未移动才合成click。
	private mousePressPoint?: { x: number; y: number };
	// 组件手势是否离开过按下点，离开后再返回仍不算点击。
	private mousePressMoved = false;
	// 组件自管连续点击历史，与按词范围识别的正文lastClick不同。
	private lastComponentClick?: {
		// 上一次点击时间戳。
		timestamp: number;
		// 次数1到3循环。
		count: number;
		// 实际鼠标目标组件身份，不按显示文案匹配。
		component: Component;
		// 必须同一个绝对列才继续组件连续点击。
		x: number;
		// 也须同一个绝对行。
		y: number;
	};
	// 轮滚策略实例，固定或auto模式内部有时序状态。
	private readonly wheelScroll: WheelScrollAccelerator;
	// 保存是否发送鼠标启停控制码，构造后不可重赋；仍可能解析人为送入的鼠标报文。
	private readonly mouseEnabled: boolean;
	// 其他搜索结果的样式函数。
	private readonly searchMatchStyle: (text: string) => string;
	// 当前搜索结果样式函数。
	private readonly searchCurrentMatchStyle: (text: string) => string;
	// 搜索按钮hover样式函数。
	private readonly searchNavigationButtonStyle: (text: string, hovered: boolean) => string;
	// 可选末尾提示生成器，绘制时才调用。
	private readonly scrollToEndIndicator?: () => string;
	// 可选宿主链接动作，本类会捕获其同步抛错。
	private readonly openUrl?: (url: string) => void;
	// 可选Windows右键粘贴动作，不直接读取系统剪贴板。
	private readonly onRightClickPaste?: () => void;
	// 可动态更改的鼠标选完自动复制开关。
	private copyOnSelect: boolean;
	// 可选异步宿主复制函数；拒绝的Promise没有被自动转换成false。
	private readonly copySelection?: (text: string) => Promise<boolean | string>;

	// 构造全屏实例，接终端/硬件光标/日志目录与选项，建立隐式文档、滚动/提示/滚轮对象并注册视口输入监听，不立即进入备用屏。
	// 例new TuiAltScreen(terminal,undefined,undefined,{copyOnSelect:false})只建立状态，start才写启屏控制码。
	// 回调仅保存或作为未来监听器闭包，不在构造时执行复制/打开URL；后续副作用取决于注入Terminal和宿主函数。
	constructor(
		// 注入的Terminal可是真终端或内存适配器。
		terminal: Terminal,
		// 可选硬件光标配置转给基类，缺省使用基类默认隐藏。
		showHardwareCursor?: boolean,
		// 可选日志目录由基类保存。
		logDirectory?: string,
		// 没有options才用新空对象，按字段??提供默认，false/0等不会被当缺省。
		options: TuiAltScreenOptions = {},
	) {
		// 先初始化公共TuiBase/Container，之后才允许访问this。
		super(terminal, showHardwareCursor, logDirectory);
		// 创建普通Component包装器，委托基类以children生成整份文档。
		this.implicitDocument = {
			// 未来render(width)时调用父Container实现，避免递归回本类override render。
			render: (width) => super.render(width),
			// 未来鼠标事件委托父容器纵向命中，返回处理结果。
			handleMouse: (event) => super.handleMouse(event),
			// 失效回调未来逐子invalidate，返回void，无自动绘制。
			invalidate: () => {
				// 遍历当前children，不在此深克隆/释放组件。
				for (const child of this.children) child.invalidate();
			},
		};
		// 构造隐式主区，follow:end初始跟末尾，primary:true供主要滚动/搜索选择。
		this.implicitScrollView = new ScrollView(this.implicitDocument, { follow: "end", primary: true });
		// 提示增删/超时调用这个requestRender闭包，只安排帧不当场画。
		this.flashes = new AltScreenFlashContainer(() => this.requestRender());
		// 默认每轮滚动1行，配置交给策略类规范化/加速。
		this.wheelScroll = new WheelScrollAccelerator(options.wheelScrollLines ?? 1);
		// 默认发送鼠标启停请求，显式false保留。
		this.mouseEnabled = options.mouse ?? true;
		// 默认给非当前匹配加下划线后关闭下划线；箭头只生成字符串。
		this.searchMatchStyle = options.searchMatchStyle ?? ((text) => `\x1b[4m${text}\x1b[24m`);
		// 默认当前匹配粗体+反色，结尾关闭粗体/反色；可能叠加原文本ANSI，后续处理保留控制串。
		this.searchCurrentMatchStyle = options.searchCurrentMatchStyle ?? ((text) => `\x1b[1;7m${text}\x1b[22;27m`);
		// 没有自定义按钮样式时使用恒等回调，不添加控制码。
		this.searchNavigationButtonStyle = options.searchNavigationButtonStyle ?? ((text) => text);
		// 保存生成器，undefined代表不画末尾提示。
		this.scrollToEndIndicator = options.scrollToEndIndicator;
		// 保存URL回调，不直接开启浏览器。
		this.openUrl = options.openUrl;
		// 保存右键粘贴回调，不主动调用。
		this.onRightClickPaste = options.onRightClickPaste;
		// 默认自动复制，显式false关闭。
		this.copyOnSelect = options.copyOnSelect ?? true;
		// 保存异步复制函数，没有时后续走OSC52。
		this.copySelection = options.copySelection;
		// 注册到基类输入监听链，未来收到输入才运行handleViewportInput；没有保存注销函数，随实例复用。
		this.addInputListener((data) => this.handleViewportInput(data));
	}

	// getter返回当前主滚动区scrollTop，无参数/修改；例内容10行窗口4行跟末尾时是6，未完成布局时可能还是初始偏移。
	get viewportTop(): number {
		// 优先当前布局标出的主区，找不到则隐式主区。
		return this.getPrimaryScrollView().scrollTop;
	}

	// 读取主区是否正跟随输出末尾，返回boolean，无IO；例用户向上滚后false，回底后可true，区别于是否配置了followEnd。
	get isFollowingOutput(): boolean {
		// 返回动态isFollowingEnd状态，不仅看构造选项。
		return this.getPrimaryScrollView().isFollowingEnd;
	}

	// 动态设置轮滚固定行数/auto模式，返回void；例由1改3影响下一次轮滚，不立即滚动/排帧，策略类处理输入规范化。
	setWheelScrollLines(lines: WheelScrollLines): void {
		// 转给已有WheelScrollAccelerator，不创建新滚动视图。
		this.wheelScroll.setLines(lines);
	}

	// 读取鼠标选择后是否自动复制的开关，返回boolean无副作用；例设置菜单显示当前值。
	getCopyOnSelect(): boolean {
		// 只读配置，不判断当下是否有可复制选择。
		return this.copyOnSelect;
	}

	// 设置自动复制开关，返回void，不清选择/排帧；例关闭后鼠标松开仍保留高亮，之后手动复制仍可用。
	setCopyOnSelect(enabled: boolean): void {
		// 保存新boolean，不在此调用复制函数。
		this.copyOnSelect = enabled;
	}

	/** Whether the fullscreen viewport has a non-empty active text selection. */
	// 查询是否有非空可提取选择，返回boolean；例两端相同为false，可能遍历选择行/剥ANSI，不改变选择或读系统剪贴板。
	hasActiveSelection(): boolean {
		// 通过实际提取结果判断，只有空格被trimEnd后也可能无可复制文本。
		return this.getActiveSelectionText() !== undefined;
	}

	/** Copy the active fullscreen text selection, if any, using the configured selection clipboard path. */
	// 提取当前选择并调用复制路径，返回Promise<boolean>；无非空文本false，有值走注入回调或OSC52。例copyOnSelect=false时手动触发，回调拒绝/写入异常会使Promise拒绝而非必然false。
	async copyActiveSelectionToClipboard(): Promise<boolean> {
		// 先按当前屏幕/滚动内容快照构造纯文本，不直接使用高亮串原样复制。
		const text = this.getActiveSelectionText();
		// 没有非空选择立即以async返回false。
		if (!text) return false;
		// 返回复制Promise，async会采纳它的完成/拒绝；OSC52默认true仅表明已写出请求。
		return this.copyTextToClipboard(text);
	}

	/** Drop the text selection and multi-click history, e.g. before the host replaces the transcript. */
	// 清文字选择与正文多击历史，返回void；例如宿主替换整段聊天前调用，不清组件捕获/搜索，也不自动请求一帧。
	resetTextSelection(): void {
		// 清选择端点/自动滚动/链接按下等局部状态。
		this.clearTextSelection();
		// 清正文双/三击计数，下一次从1开始；lastComponentClick另存未动。
		this.lastClick = undefined;
	}

	/** The lines of the last rendered frame, one per terminal row, as written to the terminal. */
	// 返回上一帧逻辑屏幕行浅副本，无重绘/终端回读；例诊断可见文字，不含全文历史。图片行可能保留原传输串，而实际写终端已换仅放置串，不是最终write缓冲的逐字副本。
	getScreenLines(): string[] {
		// 展开数组复制容器，字符串值不可变，无需逐字符复制。
		return [...this.previousScreen];
	}

	// 设置独立布局根或undefined退回隐式主区，返回void；引用改变时丢旧布局并排帧，不清children/搜索/选择。例固定dock用VStack根。
	setLayoutRoot(component: Component | undefined): void {
		// 同引用无操作，不重复清布局/排帧。
		if (this.layoutRoot === component) return;
		// 保存组件引用，允许未挂children的完整布局树。
		this.layoutRoot = component;
		// 旧几何暂不可用于命中，等下一次成功绘制建立。
		this.currentLayout = undefined;
		// 请求新布局帧，未立即render组件。
		this.requestRender();
	}

	// 返回完整逻辑文档行：有layoutRoot用其render，没则父容器串children；无直接终端写入。例退出全屏时按宽重新render全文，和屏内renderLayoutFrame不同，组件异常传播。
	override render(width: number): string[] {
		// 可选调用避免无根时访问；??只在结果null/undefined时回退，正常空数组仍是有效结果。
		return this.layoutRoot?.render(width) ?? super.render(width);
	}

	// 供基类失效/挂载检查返回基础根列表，无修改/IO；例独立根不在children也能被遍历，返回TS readonly并不深冻结组件。
	protected override getMountedRoots(): readonly Component[] {
		// 有根创建单元素数组，否则原children引用，不包含浮层栈。
		return this.layoutRoot ? [this.layoutRoot] : this.children;
	}

	// 从最近成功帧找primaryScrollView，缺省回隐式主区，返回对象引用无修改；例键位/搜索滚动针对主聊天区。
	private getPrimaryScrollView(): ScrollView {
		// 可选链处理尚无布局，??不把一个真实ScrollView当缺省。
		return this.currentLayout?.primaryScrollView ?? this.implicitScrollView;
	}

	// 终端start前清手势/提示/缓存状态，保存图片协议，iTerm2时临时关闭共享图片生成，再写进入备用屏/关闭自动折行/启鼠标/清屏/隐藏光标，返回void。
	// 例如tmux环境不启所有无按钮移动以减流量；此函数会改共享能力、写终端，后续失败无finally保证恢复。
	// options.mouse只控制发送启停码，false不阻止本类解析后来人为送入的鼠标串。
	protected override beforeTerminalStart(): void {
		// 取消可能残留的选择边缘自动滚动interval。
		this.stopSelectionAutoScroll();
		// 没有继续中的正文按下。
		this.selectionPressActive = false;
		// 结束auto滚动条hover激活状态。
		this.stopScrollbarHover();
		// 结束滚动条拖拽状态。
		this.stopScrollbarDrag();
		// 清所有旧flash及其timer，不永久禁以后提示。
		this.flashes.dispose();
		// 先标激活；如果随后写失败也不会自动还原此字段。
		this.altScreenActive = true;
		// 读共享能力，冷缓存可触发tmux只读查询，测试显式PI_HYPERLINKS=0绕过。
		const capabilities = getCapabilities();
		// 记启动时协议，用于后续图片清理/缓存分支。
		this.imageProtocol = capabilities.images;
		// 丢本实例旧上传估计，不在此发送逐图删除。
		this.uploadedKittyImages.clear();
		// iTerm2图片在备用屏不可靠，临时让正常Image组件生成文字回退。
		if (capabilities.images === "iterm2") {
			// 保存原能力对象引用供正常停后恢复。
			this.savedCapabilities = capabilities;
			// 新对象保留真彩/链接等其他字段、只把images设null；这是模块共享能力修改，可能影响同进程其他消费者。
			setCapabilities({ ...capabilities, images: null });
			// 使组件缓存失效，下帧重新依据临时能力渲染。
			this.invalidate();
		}
		// 清旧退出全文缓存。
		this.lastDocument = [];
		// 清旧文字选择锚点。
		this.selectionAnchor = undefined;
		// 清选择另一端。
		this.selectionFocus = undefined;
		// 选择粒度回逐格。
		this.selectionGranularity = "character";
		// 清词/行初始区间。
		this.selectionInitialRange = undefined;
		// 正文多击计数清空。
		this.lastClick = undefined;
		// 没有待点击打开的链接。
		this.pressedUrl = undefined;
		// 新手势尚未拖动。
		this.selectionDragged = false;
		// 清组件鼠标捕获/按下目标与移动标志。
		this.clearComponentMouseGesture();
		// 清组件多击历史，不与正文历史混用。
		this.lastComponentClick = undefined;
		// 清上一屏/尺寸/布局，为首帧整绘建立起点。
		this.resetRenderState();
		// 读取TERM并小写，未定义用空串，不做真正终端检测。
		const term = process.env.TERM?.toLowerCase() ?? "";
		// Multiplexers can lag when every pointer movement is forwarded. Button-motion
		// tracking preserves clicks, wheel events, selections, and scrollbar dragging.
		// 下面多行||识别常见复用器信号，再用三元选较少或全部移动报告。
		const mouseSequence =
			// TMUX只要定义（空串也算）就选按钮拖动模式。
			process.env.TMUX !== undefined ||
			// ZELLIJ同样按是否定义判断，"0"也算。
			process.env.ZELLIJ !== undefined ||
			// STY是Screen环境信号。
			process.env.STY !== undefined ||
			// TERM以tmux开头也触发复用器模式。
			term.startsWith("tmux") ||
			// TERM以screen开头同理；||任一为真即可。
			term.startsWith("screen")
				? // 复用器少发无按钮移动事件，仍保留按钮拖动/点击/滚轮/焦点通知。
					ENABLE_BUTTON_MOTION_MOUSE
				: // 其他环境启所有指针移动，支持滚动条hover等交互。
					ENABLE_ALL_MOTION_MOUSE;
		// 实际调用终端write，下面模板把整个进入序列一次组好；不是等待能力协商确认。
		this.terminal.write(
			// 依次备用屏、禁自动折行、可选鼠标模式、清屏、回原点、隐藏光标；模板正文保持控制串原样。
			`${ENTER_ALT_SCREEN}${DISABLE_AUTOWRAP}${this.mouseEnabled ? mouseSequence : ""}\x1b[2J\x1b[H\x1b[?25l`,
		);
	}

	// 终端stop前关闭搜索/手势/提示，已激活则删Kitty图、关鼠标、启自动折行，返回void；例普通stop先复位输入相关模式，离备用屏留afterTerminalStop，异常中断无统一finally。
	protected override beforeTerminalStop(_options: TuiStopOptions): void {
		// 关闭活动搜索栏并取消其浮层；可能请求绘制，但基类stop已置stopped阻止新帧实际运行。
		this.closeSearch();
		// 停止选择自动滚动interval。
		this.stopSelectionAutoScroll();
		// 按下状态无效，孤立释放不再延伸旧选择。
		this.selectionPressActive = false;
		// 结束hover滚动条激活。
		this.stopScrollbarHover();
		// 清滚动条拖拽。
		this.stopScrollbarDrag();
		// 清组件持续鼠标手势，后续release不再路由旧组件。
		this.clearComponentMouseGesture();
		// 取消所有提示到期任务并清提示列表。
		this.flashes.dispose();
		// 尚未激活备用屏则不发送本类复位串，但前面状态清理仍执行。
		if (!this.altScreenActive) return;
		// 向终端发送一段同步输出包裹的复位码，可能抛错。
		this.terminal.write(
			// 拼开始→按协议删Kitty图→可选关鼠标→启自动折行→结束；并不在这里退出备用屏。
			`${BEGIN_SYNCHRONIZED_OUTPUT}${this.deleteKittyImages()}${this.mouseEnabled ? DISABLE_MOUSE : ""}${ENABLE_AUTOWRAP}${END_SYNCHRONIZED_OUTPUT}`,
		);
		// 复位码write正常返回才清本地上传估计；没有向终端确认是否真的已删。
		this.uploadedKittyImages.clear();
	}

	// 终端stop之后离开备用屏，preserveScreen真只退出，假则重新render整份文档输出到主屏，最后恢复临时图片能力，返回void。
	// 例退出聊天留下全部正文历史；这份正文是此刻组件重新render的结果，不是旧屏幕逐帧拼接，也不含通用浮层/flash合成。
	// 会写终端/执行组件回调，失败不会保证能力恢复；全文缓冲是一个大字符串，没有主屏BoundedTerminalWriter分块。
	protected override afterTerminalStop(options: TuiStopOptions): void {
		// 未激活就不退出/重放，跳过本函数其余步骤。
		if (!this.altScreenActive) return;
		// 先记已离开活动状态，后面写失败也不自动改回true。
		this.altScreenActive = false;
		// preserveScreen用于另一个TUI接管，同样会发退出备用屏码。
		if (options.preserveScreen) {
			// 包同步输出、退出备用屏、显光标，不重放文档。
			this.terminal.write(`${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`);
		} else {
			// 输出全文使用当前终端至少1列宽，未在本行floor尺寸。
			const width = Math.max(1, this.terminal.columns);
			// 调用本类render取完整逻辑文档，再解析伪光标；随后map逐行剥行首OSC133。
			const documentLines = this.resolveFakeCursors(this.render(width)).map((line) =>
				// 只替换行首A/B/C区段，不是清除任意位置的所有OSC。
				line.replace(OSC133_ZONE_PREFIX, ""),
			);
			// 先map移掉每行所有真实光标标记，再规范化/补样式重置，最后map按宽截普通行；结果保存lastDocument。
			this.lastDocument = this.applyLineResets(documentLines.map((line) => line.replaceAll(CURSOR_MARKER, ""))).map(
				// 图片行原样保留，普通行超显示宽才严格裁剪，防退出正文意外折行；此时iTerm2共享能力尚未恢复。
				(line) => (isImageLine(line) || visibleWidth(line) <= width ? line : sliceByColumn(line, 0, width, true)),
			);
			// 新建一次性输出缓冲：开始同步输出→回主屏→禁自动折行，后面追加全文。
			let buffer = `${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}${DISABLE_AUTOWRAP}`;
			// 按逻辑文档顺序输出全部行，不限当前视口高度。
			for (let row = 0; row < this.lastDocument.length; row++) {
				// 首行前不额外CRLF，其余行之间换行，底部可进入主屏滚动历史。
				if (row > 0) buffer += "\r\n";
				// 每行回第0列、擦整行后写正文，缺项回空串。
				buffer += `\r\x1b[2K${this.lastDocument[row] ?? ""}`;
			}
			// 全文末尾重置SGR、启自动折行、补换行/显光标、结束同步输出。
			buffer += `\x1b[0m${ENABLE_AUTOWRAP}\r\n\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`;
			// 一次write整段全文，不等待终端实际绘制确认。
			this.terminal.write(buffer);
		}
		// 正常完成离屏输出后，有临时能力快照才恢复。
		if (this.savedCapabilities) {
			// 把原能力对象重新设回共享模块缓存，可能影响其他组件的后续渲染。
			setCapabilities(this.savedCapabilities);
			// 释放本实例保存引用，避免重复按旧快照恢复。
			this.savedCapabilities = undefined;
		}
	}

	// 为未stop直接JS退出提供前缀控制串，返回string不立即发送；例活动全屏先结束同步输出/关鼠标/启折行，再接基类通知关闭/光标恢复，Terminal.restoreOnExit实际写。
	protected override getExitRestorePrefix(): string {
		// 取基类的主题通知与光标复位码。
		const prefix = super.getExitRestorePrefix();
		// 未激活备用屏只需基类前缀。
		if (!this.altScreenActive) return prefix;
		// 活动时在基类前加本模式复位，仍未退出备用屏，以便先让终端自身弹出屏相关键盘协议栈。
		return `${END_SYNCHRONIZED_OUTPUT}${this.mouseEnabled ? DISABLE_MOUSE : ""}${ENABLE_AUTOWRAP}${prefix}`;
	}

	// 返回终端自身键盘复位之后执行的全屏后缀，无IO；例活动时再退出备用屏并显光标，非活动仅返回基类后缀，未承诺硬杀可执行。
	protected override getExitRestoreSuffix(): string {
		// Kitty keyboard flags are per screen, so the terminal pops them before the alternate screen is left.
		// 模板按活动状态追加EXIT_ALT_SCREEN+显示光标；内层模板仅组串，不改altScreenActive。
		return `${super.getExitRestoreSuffix()}${this.altScreenActive ? `${EXIT_ALT_SCREEN}\x1b[?25h` : ""}`;
	}

	// 按启动协议生成删全部Kitty图及数据的控制串，返回string无实际发送；例kitty时停前清图，iterm2/null返回空串，不清本地Map。
	private deleteKittyImages(): string {
		// 只在协议严格为kitty时调用编码助手，?:只计算选中一边。
		return this.imageProtocol === "kitty" ? deleteAllKittyImages() : "";
	}

	// 准备一帧Kitty输出：解析登记图片行、按ID/代次决定是否换成小的placement串，更新最近可见Map，再按屏外三项配额淘汰，返回新行数组及待发送删除串。
	// 例同ID/同代次第二次进入视口不用重传base64；刚离屏的图仍可保留，但屏外超过16张/估传输32MiB/估解码64MiB就按旧顺序删除。
	// 可见图不计配额，本地先更新缓存才真正write，不能当远端确认或总进程内存上限；输入screen数组不改，解析只处理每行首个可识别登记图。
	private prepareKittyScreen(screen: string[]): { lines: string[]; evictedImageDeletion: string } {
		// 本轮识别到的可见ID集合，供后面屏外计数/淘汰排除。
		const visibleImageIds = new Set<number>();
		// map为输出创建新数组，每行决定保留传输还是改仅放置；过程中也修改实例Map。
		const lines = screen.map((line) => {
			// 从首段Kitty报文及登记元数据提取placement，不在此验证动作一定是上传；缺ID元数据/不完整分块则undefined。
			const placement = getKittyImagePlacement(line);
			// 不可识别行保留原样，不加入上传复用表。
			if (!placement) return line;
			// 识别到的图算可见，即使后面终端write失败也暂已归入本轮集合。
			visibleImageIds.add(placement.imageId);

			// 按图片ID查旧本地上传估计，未命中就要保留传输。
			const cachedImage = this.uploadedKittyImages.get(placement.imageId);
			// 创建该图本轮新的成本/代次记录，不复制图片数据。
			const nextCachedImage = {
				// 保存登记代次；元数据变化可强制同ID重新上传。
				transmissionGeneration: placement.transmissionGeneration,
				// 保存本行提取的传输段成本，不是网络层实际发包字节。
				transmissionBytes: placement.transmissionBytes,
				// 保存像素宽高按RGBA估算值，不是解码后实测。
				estimatedDecodedBytes: placement.estimatedDecodedBytes,
			};
			// 已有记录先删再插，利用Map插入顺序把最近可见图移到末端。
			if (cachedImage) this.uploadedKittyImages.delete(placement.imageId);
			// 记录新估计，此时尚未调用Terminal.write。
			this.uploadedKittyImages.set(placement.imageId, nextCachedImage);

			// 只有旧记录代次与本轮完全相等才复用；可选链未命中得到undefined。
			return cachedImage?.transmissionGeneration === placement.transmissionGeneration
				? // 复用时保留图前后文本但把传输段替换成a=p仅放置命令。
					placement.replacementLine
				: // 未命中/代次变更保留原传输行，需要真正发送载荷。
					line;
		});

		// 屏外图数量先归0，下面只统计不在本轮可见集合的项。
		let cachedOffscreenImageCount = 0;
		// 屏外传输段估计总量。
		let cachedOffscreenTransmissionBytes = 0;
		// 屏外解码成本估值总量。
		let cachedOffscreenDecodedBytes = 0;
		// 按Map顺序遍历ID与记录，数组解构取两项。
		for (const [imageId, cachedImage] of this.uploadedKittyImages) {
			// 可见图不计入屏外配额，不因单图很大就被此策略淘汰。
			if (visibleImageIds.has(imageId)) continue;
			// 累计屏外图数量。
			cachedOffscreenImageCount += 1;
			// 累计屏外传输成本。
			cachedOffscreenTransmissionBytes += cachedImage.transmissionBytes;
			// 累计屏外解码估值。
			cachedOffscreenDecodedBytes += cachedImage.estimatedDecodedBytes;
		}

		// 积攒待发送的删除控制串，空表示本轮无淘汰。
		let evictedImageDeletion = "";
		// 再次从Map最早顺序扫描，优先淘汰较久未可见的屏外图。
		for (const [imageId, cachedImage] of this.uploadedKittyImages) {
			// 三项预算全部满足才能停止淘汰，&&要求同时成立。
			if (
				// 屏外数量不超16。
				cachedOffscreenImageCount <= MAX_CACHED_OFFSCREEN_KITTY_IMAGES &&
				// 屏外传输成本不超32MiB预算。
				cachedOffscreenTransmissionBytes <= MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES &&
				// 屏外解码估值不超64MiB预算。
				cachedOffscreenDecodedBytes <= MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES
			) {
				// 预算已满足，后面更晚的记录无需继续考虑。
				break;
			}
			// 即使预算超限也跳过当前可见图，只淘汰屏外项。
			if (visibleImageIds.has(imageId)) continue;
			// 生成释放这个ID及图数据的命令，尚未发送。
			evictedImageDeletion += deleteKittyImage(imageId);
			// 先从本地Map删除，write失败不会自动恢复记录。
			this.uploadedKittyImages.delete(imageId);
			// 屏外计数随删除减少1。
			cachedOffscreenImageCount -= 1;
			// 扣除此图估传输成本。
			cachedOffscreenTransmissionBytes -= cachedImage.transmissionBytes;
			// 扣除此图估解码成本，供下一轮是否停止判断。
			cachedOffscreenDecodedBytes -= cachedImage.estimatedDecodedBytes;
		}
		// 返回准备后新行及删除串，调用方把二者排进实际终端输出。
		return { lines, evictedImageDeletion };
	}

	// 强制重绘用的缓存重置钩子，无参数/void；例requestRender(true)使下帧按空旧屏整绘，不清选择/搜索/上传图Map，后者仍可复用。
	protected override resetRenderState(): void {
		// 清差量基准屏幕行。
		this.previousScreen = [];
		// 上帧宽回0。
		this.previousScreenWidth = 0;
		// 上帧高回0。
		this.previousScreenHeight = 0;
		// 旧布局几何失效，输入临时找不到主帧时回隐式区。
		this.currentLayout = undefined;
	}

	// 主滚动区相对滚动并排帧，返回void；例scrollBy(-3)向上3行，ScrollView会夹范围/返回余量，但此公开包装器忽略余量，不向外滚动。
	scrollBy(lines: number): void {
		// 调用主区滚动，可能触发其已绑定重画回调。
		this.getPrimaryScrollView().scrollBy(lines);
		// 本层再请求一帧，基类会合并重复请求。
		this.requestRender();
	}

	// 主区滚到起点并排帧，无参数/void；例跳历史开头，不清选择或改变正文。
	scrollToTop(): void {
		// ScrollView按当前内容/窗口状态处理到起点。
		this.getPrimaryScrollView().scrollToStart();
		// 安排新视口显示。
		this.requestRender();
	}

	// 主区滚到末尾并排帧，无参数/void；例用户点Jump to end，支持followEnd的主区可恢复跟随。
	scrollToBottom(): void {
		// 调用ScrollView.scrollToEnd，不通过终端滚动历史命令。
		this.getPrimaryScrollView().scrollToEnd();
		// 排后续绘制。
		this.requestRender();
	}

	// 按direction(-1前/1后)从主区当前顶部相邻行扫描OSC133 A提示起点，找到就滚动并排帧，返回void；例跨用户消息跳转，未有布局/没有标记时无操作，不环绕列表。
	private scrollToPrompt(direction: -1 | 1): void {
		// 无最近布局无法取得文档提示行，直接结束。
		if (!this.currentLayout) return;
		// 定位当前主滚动区引用。
		const scrollView = this.getPrimaryScrollView();
		// 从对应布局盒子取完整内容行，尚未剥OSC133，可能undefined。
		const lines = getScrollViewBox(this.currentLayout, scrollView)?.scrollContentLines;
		// 无内容来源不继续扫描。
		if (!lines) return;

		// 从当前scrollTop+方向开始，避免再次命中当前首行；每次按方向增减，保持数组范围。
		for (let row = scrollView.scrollTop + direction; row >= 0 && row < lines.length; row += direction) {
			// 只认行首A标记，普通行/B/C区段跳过。
			if (!OSC133_PROMPT_START.test(lines[row] ?? "")) continue;
			// 按命中内容行定位，ScrollView可能把接近末尾的目标夹住。
			scrollView.scrollTo(row);
			// 请求显示找到提示所在区域。
			this.requestRender();
			// 找到最近一个即结束，不继续找更远提示。
			return;
		}
	}

	// 切换正文搜索栏，无参数/void；已有则关闭，否则创建索引/组件/浮层并聚焦，实际匹配留doRender刷新。例按配置搜索键开启，用户回调/浮层异常不统一回滚。
	private toggleSearch(): void {
		// 已经活动则把同一快捷键当关闭动作。
		if (this.activeSearch) {
			// 移除搜索浮层并清活动状态。
			this.closeSearch();
			// 关闭后不再创建新搜索对象。
			return;
		}
		// 构造搜索栏，传查询变化与按钮样式回调，不在此执行查询。
		const component = new AltScreenSearchComponent(
			// 用户编辑搜索串时把新query交本实例updateSearchQuery。
			(query) => this.updateSearchQuery(query),
			// 按钮渲染样式使用构造时保存回调。
			this.searchNavigationButtonStyle,
		);
		// 建立一份活动搜索结构，句柄稍后再写入。
		const search: ActiveSearch = {
			// 关联刚创建的组件。
			component,
			// 每次新打开搜索建立独立索引缓存。
			index: new AltScreenSearchIndex(),
			// 初始查询为空，无匹配。
			query: "",
			// 匹配列表初始空数组。
			matches: [],
			// -1表示没有当前项。
			selectedIndex: -1,
			// 以当前主区顶部为首轮查询选择匹配的锚点，不无条件挑全文第一处。
			anchorRow: this.getPrimaryScrollView().scrollTop,
			// 首轮按query策略挑结果。
			selectionMode: "query",
		};
		// 先保存活动状态，使后续组件回调能找到本轮搜索。
		this.activeSearch = search;
		// showOverlay创建句柄并排帧，通常给搜索栏键盘焦点。
		search.overlay = this.showOverlay(component, {
			// 搜索浮层靠右上。
			anchor: "top-right",
			// 请求宽为终端40%。
			width: "40%",
			// 优先不少于32列，但最终仍被可用宽夹住。
			minWidth: 32,
			// 四边留1格，实际几何由基类布局决定。
			margin: 1,
		});
	}

	// 关闭搜索并请求绘制，无参数/void；例Escape让浮层句柄移除搜索栏，并按基类规则恢复其他浮层或之前的焦点，不改变主区当前滚动位置。
	private closeSearch(): void {
		// 先局部保存活动搜索，方便清字段后仍操作原句柄。
		const search = this.activeSearch;
		// 没有活动搜索就是无操作。
		if (!search) return;
		// 先置undefined，避免hide恢复焦点时仍认为搜索活动。
		this.activeSearch = undefined;
		// 已有句柄就移除浮层，若创建未完成没有句柄则跳过。
		search.overlay?.hide();
		// 排帧移除高亮/栏位，重复请求会合并。
		this.requestRender();
	}

	// 保存新query并设置下一帧重新选结果，返回void；例从foo改bar，以旧选中首行作锚点，不在此同步全文搜索，当前计数先清。
	private updateSearchQuery(query: string): void {
		// 获取当前搜索引用。
		const search = this.activeSearch;
		// 已关闭或字符串完全不变则不排新查询。
		if (!search || query === search.query) return;
		// 按旧selectedIndex取旧匹配，-1/越界时undefined。
		const selected = search.matches[search.selectedIndex];
		// 旧结果有首片段用其内容行作锚点，否则当前主区顶部；可选链逐层处理无值。
		search.anchorRow = selected?.segments[0]?.row ?? this.getPrimaryScrollView().scrollTop;
		// 保存原查询文字，规范化由搜索索引处理。
		search.query = query;
		// 下一帧以query策略从锚点选合适项。
		search.selectionMode = "query";
		// 先让搜索栏计数显示无当前结果/0，实际结果下一帧更新。
		search.component.setResult(-1, 0);
		// 请求更新匹配和画面。
		this.requestRender();
	}

	// 记录向前/向后搜索导航请求并排帧，返回void；例Enter选下一项，真正更新索引/揭示位置留refreshSearch，空查询或未打开则无操作。
	private navigateSearch(direction: -1 | 1): void {
		// 取活动搜索。
		const search = this.activeSearch;
		// query空串不导航；只有空白的非空串会先进入，但刷新时trim后仍无结果。
		if (!search?.query) return;
		// -1选previous，1选next，暂未改变selectedIndex。
		search.selectionMode = direction < 0 ? "previous" : "next";
		// 排下一帧执行这一选择模式。
		this.requestRender();
	}

	// 按绝对x/y判断是否在最近搜索栏箭头按钮上，返回-1/1/undefined，无导航副作用；例栏中其他边框不算按钮，依赖句柄已有bounds。
	private getSearchNavigationDirectionAt(x: number, y: number): -1 | 1 | undefined {
		// 取活动搜索对象。
		const search = this.activeSearch;
		// 可选链读取搜索浮层最近矩形，未合成/不可见时undefined。
		const bounds = search?.overlay?.getBounds();
		// 没有搜索或矩形就不可能命中。
		if (!search || !bounds) return undefined;
		// 先把点击限制在整个搜索栏左闭右开矩形，避免正文画框误当按钮。
		if (x < bounds.col || x >= bounds.col + bounds.width || y < bounds.row || y >= bounds.row + bounds.height) {
			// 范围外返回undefined。
			return undefined;
		}
		// 转成栏局部行/列后让组件判断箭头控件；参数顺序是row再col。
		return search.component.getNavigationDirectionAt(y - bounds.row, x - bounds.col);
	}

	// 处理搜索箭头hover及左键按下，返回是否真正导航消费；例指针移入只改hover可排帧但false让后续流程继续，回调异常传播。
	private handleSearchMouseEvent(event: SgrMouseEvent): boolean {
		// 取活动搜索。
		const search = this.activeSearch;
		// 未开搜索就false。
		if (!search) return false;
		// 按最近矩形查按钮方向。
		const direction = this.getSearchNavigationDirectionAt(event.x, event.y);
		// 悬停方向变化才排帧，undefined会取消旧hover。
		if (search.component.setHoveredNavigationDirection(direction)) this.requestRender();
		// 非按钮、松开、移动位或非左键都不执行导航；修饰位并没有在此全部排除。
		if (direction === undefined || event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) {
			// 返回false表示让其他鼠标处理继续，不等同于hover没变。
			return false;
		}
		// 有效左键按下记录对应导航并排帧。
		this.navigateSearch(direction);
		// 本次鼠标已处理，不再进入正文选择。
		return true;
	}

	// 按layout主区完整内容刷新搜索，更新匹配/选中键/计数，必要时滚动揭示结果，返回scrollTop是否变化供doRender决定再布局一次。
	// 例新query从锚点二分挑最近后方项，没有则回首项；next/previous循环，retain尽量保留相同位置，普通文档更新不强拉滚动。
	// 会修改搜索组件/ScrollView并可能请求后续帧，不直接写终端；匹配高于视口时按首片段约置于窗口上方1/3，不保证超长跨行匹配完整可见。
	private refreshSearch(layout: LayoutFrame): boolean {
		// 获取活动搜索。
		const search = this.activeSearch;
		// 没开搜索不需要刷新或重布局。
		if (!search) return false;
		// 使用传入本轮布局主区而不是旧currentLayout主区，无标记时仍隐式回退。
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		// 找到这一滚动视图的布局盒子。
		const box = getScrollViewBox(layout, scrollView);
		// 搜索来源是盒子完整内容，不只当前屏内文本，也不搜索一般浮层/提示。
		const lines = box?.scrollContentLines;
		// 没有可搜索内容或查询trim后为空时清结果。
		if (!lines || !search.query.trim()) {
			// 匹配清空。
			search.matches = [];
			// 当前索引回-1。
			search.selectedIndex = -1;
			// 旧选中键也清空，避免日后误保持。
			search.selectedKey = undefined;
			// 本轮无需重复query揭示，回retain。
			search.selectionMode = "retain";
			// 同步更新搜索栏计数为无结果。
			search.component.setResult(-1, 0);
			// 没有滚动变化，不要求第二次布局。
			return false;
		}

		// 只有明确query/next/previous模式才尝试揭示选中项，retain刷新不抢用户滚动。
		const shouldRevealSelection = search.selectionMode !== "retain";
		// 搜索索引可复用未变行/查询，返回matches与changed标记。
		const result = search.index.search(lines, search.query);
		// 局部引用这次匹配数组，不克隆结果。
		const matches = result.matches;
		// 保存最新匹配供高亮使用。
		search.matches = matches;
		// 结果没变且只需retain时不再重选/滚动。
		if (!result.changed && search.selectionMode === "retain") return false;

		// 结果变更时按旧位置键重新定位，没变就保留索引；下面是嵌套三元。
		const exactIndex = result.changed
			? // 有旧selectedKey才尝试身份键查找。
				search.selectedKey
				? // findIndex找首个位置键相同的匹配，无则-1。
					matches.findIndex((match) => getAltScreenSearchMatchKey(match) === search.selectedKey)
				: // 没有旧键无法精确找回，使用-1。
					-1
			: // 结果未变沿用旧selectedIndex。
				search.selectedIndex;
		// 新选中索引先设-1，没有任何结果时保留它。
		let selectedIndex = -1;
		// 有结果才运行下方模式计算，避免对0长度取模。
		if (matches.length > 0) {
			// 新query优先挑首片段行不早于锚点的匹配。
			if (search.selectionMode === "query") {
				// 二分左界0。
				let low = 0;
				// 二分排他右界为匹配数。
				let high = matches.length;
				// 收缩半开区间，找lower_bound式首个合适位置。
				while (low < high) {
					// 中点在两界之间，向下取整避免小数索引。
					const middle = low + Math.floor((high - low) / 2);
					// 匹配首片段早于锚点则左界越过中点；!只影响TS，缺首段按0行。
					if ((matches[middle]!.segments[0]?.row ?? 0) < search.anchorRow) low = middle + 1;
					// 否则保留中点及左半边，右界收至middle。
					else high = middle;
				}
				// 有后方结果选low，全都在锚点前则环回第0项。
				selectedIndex = low < matches.length ? low : 0;
				// next从精确找回或夹住的旧索引前进一步。
			} else if (search.selectionMode === "next") {
				// 优先exactIndex，否则把旧索引最多夹在新末项，仍可能是-1。
				const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
				// 无基项选首项，有基项加1再对长度取模，实现末项回首。
				selectedIndex = baseIndex < 0 ? 0 : (baseIndex + 1) % matches.length;
				// previous反向循环。
			} else if (search.selectionMode === "previous") {
				// 同样先选精确找回或不超末尾的旧基索引。
				const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
				// 无基项选最后项，否则减1并加长度避免负数后取模。
				selectedIndex = baseIndex < 0 ? matches.length - 1 : (baseIndex - 1 + matches.length) % matches.length;
			} else {
				// retain不主动前后移动，下面表达式保留或夹旧选项。
				selectedIndex =
					// 精确键命中优先，否则旧索引夹0到新末项，结果变化时尽量保持附近位置。
					exactIndex >= 0 ? exactIndex : Math.min(Math.max(0, search.selectedIndex), matches.length - 1);
			}
		}

		// 保存最终当前索引。
		search.selectedIndex = selectedIndex;
		// 有选中项生成位置键，否则undefined；非空断言基于上面索引约定，无运行校验。
		search.selectedKey = selectedIndex >= 0 ? getAltScreenSearchMatchKey(matches[selectedIndex]!) : undefined;
		// 模式重置retain，下帧没新导航不反复跳转。
		search.selectionMode = "retain";
		// 让搜索栏更新1基显示计数/总数等，索引接口仍0基。
		search.component.setResult(selectedIndex, matches.length);
		// retain路径不揭示结果，即使匹配数组发生变化也不强制滚视口。
		if (!shouldRevealSelection) return false;

		// 取选中项，无项时undefined。
		const selected = matches[selectedIndex];
		// 取首个跨行匹配片段定位起行。
		const firstSegment = selected?.segments[0];
		// 取最后片段定位终行。
		const lastSegment = selected?.segments[selected.segments.length - 1];
		// 无盒子/有效片段/正视口高就不能滚动揭示。
		if (!box || !firstSegment || !lastSegment || scrollView.viewportHeight <= 0) return false;
		// 记录滚动前顶部，最后用差值决定是否重布局。
		const before = scrollView.scrollTop;
		// 当前可见内容末行，索引包括末界。
		const visibleBottom = before + scrollView.viewportHeight - 1;
		// 目标初始不动。
		let target = before;
		// 匹配首行在上方或末行在下方，认为当前未完整覆盖选择。
		if (firstSegment.row < before || lastSegment.row > visibleBottom) {
			// 把首匹配行放在视口约1/3处，ScrollView稍后夹边界；匹配过高仍可能看不全。
			target = firstSegment.row - Math.floor(scrollView.viewportHeight / 3);
		}
		// 即使target未动也调用scrollTo，并显式禁止落末尾时恢复follow，保持搜索导航的手动视口语义。
		scrollView.scrollTo(target, { disableFollow: true });
		// 只以最终顶部是否变化返回true，跟随标志变化不触发此处第二次布局判断。
		return scrollView.scrollTop !== before;
	}

	/** Show a transient message in the alternate-screen flash stack. */
	// 把message及可选时长交提示栈，返回void；例flash("已复制")默认约1秒，立即排帧、到期再排帧，宿主回调异常不吞。
	flash(message: string, durationMs?: number): void {
		// 组件管理独立计时器与行文本，本类后面合成到右上角。
		this.flashes.flash(message, durationMs);
	}

	/** Focused overlays and components that capture viewport input receive viewport keys instead of the transcript. */
	// 判断视口键是否应留给当前焦点组件，返回boolean；例聚焦列表接PageDown，搜索栏是例外仍允许正文滚动，capturesViewportInput优先于搜索例外。
	private shouldDeferViewportInput(): boolean {
		// 组件明确接管视口键则true，无论是不是浮层。
		if (this.getFocusedComponent()?.capturesViewportInput) return true;
		// 其他可见焦点浮层默认接管，只有当前搜索浮层自己获焦时允许视口键继续到正文。
		return this.isOverlayFocused() && this.activeSearch?.overlay?.isFocused() !== true;
	}

	// 清组件鼠标捕获/按下状态，无参数/void、不清正文选择或多击历史；例失焦/组件释放后终止向旧target继续派发，不主动重画。
	private clearComponentMouseGesture(): void {
		// 释放显式capture目标。
		this.mouseCapture = undefined;
		// 清按下时记的target。
		this.mousePressTarget = undefined;
		// 清同点点击判定的起点。
		this.mousePressPoint = undefined;
		// 移动历史复位，下一手势重新计算。
		this.mousePressMoved = false;
	}

	// 作为基类输入监听器优先处理窗口焦点、滚轮/鼠标与可配置视口键，返回{consume:true}阻止后续普通输入，undefined放行给基类/焦点组件。
	// 例PageUp滚主区、普通字母交编辑器；搜索键优先于defer判定，所以即使焦点列表接管滚动也可切搜索。
	// 会改选择/滚动/浮层状态并排帧，调用用户组件/回调；不直接执行系统剪贴板操作，解析人工输入鼠标串不受mouseEnabled门禁。
	private handleViewportInput(data: string): { consume?: boolean } | undefined {
		// 终端窗口失焦，不等于Component焦点切换。
		if (data === FOCUS_OUT) {
			// 记当时是否有正文按下仍在进行。
			const hadActiveSelection = this.selectionPressActive;
			// 只有活动按下且两端构成非零区间才需要为取消高亮重绘；不是按复制文本是否非空判断。
			const hadNonEmptyActiveSelection = hadActiveSelection && this.getSelectionBounds() !== undefined;
			// 取消正文按下，后续孤立drag/release不再延伸。
			this.selectionPressActive = false;
			// 终止边缘自动滚动。
			this.stopSelectionAutoScroll();
			// 结束滚动条hover状态。
			this.stopScrollbarHover();
			// 取消搜索按钮hover，确有样式状态变化才排帧。
			if (this.activeSearch?.component.setHoveredNavigationDirection(undefined)) this.requestRender();
			// 清滚动条拖动。
			this.stopScrollbarDrag();
			// 取消未完成链接点击。
			this.pressedUrl = undefined;
			// 拖动标志复位。
			this.selectionDragged = false;
			// 清组件持续手势目标。
			this.clearComponentMouseGesture();
			// 组件多击计数失效。
			this.lastComponentClick = undefined;
			// 只清仍在按下过程的正文选择，已完成的选择跨窗口焦点变化保留。
			if (hadActiveSelection) {
				// 移除活动选择起点。
				this.selectionAnchor = undefined;
				// 移除活动选择末点。
				this.selectionFocus = undefined;
				// 粒度回逐格。
				this.selectionGranularity = "character";
				// 清初始词/行范围。
				this.selectionInitialRange = undefined;
				// 只有取消非零活动选择才为此原因重画，空点击失焦不多画。
				if (hadNonEmptyActiveSelection) this.requestRender();
			}
			// 正文多击历史也清，避免焦点回来后沿用旧计数。
			this.lastClick = undefined;
			// 失焦报文已处理，不作为文本交组件。
			return { consume: true };
		}
		// 获焦报告只消费，不自动清/恢复选择或排帧。
		if (data === FOCUS_IN) return { consume: true };

		// 先尝试垂直轮滚，兼容SGR/X10两类报文。
		const wheelEvent = this.parseWheelEvent(data);
		// 识别出垂直方向才走滚动链。
		if (wheelEvent) {
			// 策略按方向与当前单调时刻给固定/加速行数；这里读取Node全局performance。
			const lines = this.wheelScroll.next(wheelEvent.direction, performance.now());
			// SGR mouse button codes use bit 3 (value 8) for the Alt modifier.
			// 计算带方向的滚动量，下面续行合成一次表达式。
			const wheelDelta =
				// 向上负、向下正；button & 8识别Alt（从0计数第3位），额外乘5，不按Shift/Ctrl加速。
				wheelEvent.direction * ((wheelEvent.button & 8) !== 0 ? lines * ALT_WHEEL_SCROLL_MULTIPLIER : lines);
			// 生成规范化wheel事件，button名为none但保留修饰位与wheelDelta。
			const event = this.createMouseEvent("wheel", wheelEvent.button, wheelEvent.x, wheelEvent.y, { wheelDelta });
			// 先派给最近可见浮层矩形，可能命中但组件未处理。
			const overlay = this.dispatchMouseToOverlay(event);
			// 有浮层处理结果用它；浮层命中但无结果不再试基础布局组件，无命中才向布局分发。
			const result = overlay.result ?? (overlay.hit ? undefined : this.dispatchMouseToLayout(event));
			// 组件明确处理滚轮就不走默认滚动区链。
			if (result) {
				// 应用focus/capture等决策，返回需画才排帧。
				if (this.applyMouseDispatchResult(event, result)) this.requestRender();
				// 已消费，不交基类焦点键盘回调。
				return { consume: true };
			}
			// 没人处理则默认路由指针下滚动区，剩余量可落主区；浮层未处理也允许这个退路。
			this.routeWheel(wheelEvent, wheelDelta);
			// 滚轮即使没有实际移动也消费为鼠标输入。
			return { consume: true };
		}
		// 未识别为垂直轮滚时再尝试普通SGR鼠标事件。
		const mouseEvent = this.parseSgrMouseEvent(data);
		// SGR形状合法就交手势流程。
		if (mouseEvent) {
			// 组件捕获、搜索按钮、滚动条、文字选择等在这个方法中按顺序处理。
			this.handleMouseEvent(mouseEvent);
			// SGR报文消费，不让编辑器把控制串当文字。
			return { consume: true };
		}
		// 其他仍像鼠标序列的报文（如X10非滚轮）也吞掉，不支持的动作不漏成键盘文本。
		if (this.isMouseSequence(data)) return { consume: true };

		// 读取当前键位对象，运行时setKeybindings替换可生效，不固化构造时版本。
		const keybindings = getKeybindings();
		// 记录本串是否松开，匹配动作时松开也消费但不执行状态变化。
		const isRelease = isKeyRelease(data);
		// 搜索切换键优先于焦点组件的视口接管。
		if (keybindings.matches(data, "tui.altScreen.search")) {
			// 按下/重复可切换，松开不再开关一次。
			if (!isRelease) this.toggleSearch();
			// 匹配搜索动作的输入已消费。
			return { consume: true };
		}
		// 搜索栏当前有焦点才把搜索导航/关闭动作当其快捷键。
		if (this.activeSearch?.overlay?.isFocused()) {
			// 按当前键位匹配下一搜索结果。
			if (keybindings.matches(data, "tui.altScreen.searchNext")) {
				// 不是松开才记录向后导航。
				if (!isRelease) this.navigateSearch(1);
				// 导航键已消费。
				return { consume: true };
			}
			// 匹配上一个搜索结果动作。
			if (keybindings.matches(data, "tui.altScreen.searchPrevious")) {
				// 按下/重复记录向前导航。
				if (!isRelease) this.navigateSearch(-1);
				// 匹配则消费，即使松开不执行。
				return { consume: true };
			}
			// 匹配搜索关闭动作。
			if (keybindings.matches(data, "tui.altScreen.searchClose")) {
				// 非松开关闭搜索并恢复焦点。
				if (!isRelease) this.closeSearch();
				// 关闭键不再交原搜索组件。
				return { consume: true };
			}
		}
		// 焦点组件/普通浮层应接管视口键时返回undefined，让基类继续派给它；搜索相关键已在前面优先处理。
		if (this.shouldDeferViewportInput()) return undefined;
		// 匹配向上整页动作。
		if (keybindings.matches(data, "tui.altScreen.pageUp")) {
			// 只在非松开时滚动，松开仍在下面消费。
			if (!isRelease) {
				// 向上移动视口高减4行，至少1行；负号代表上滚。
				this.scrollBy(-Math.max(1, this.getPrimaryScrollView().viewportHeight - PAGE_SCROLL_OVERLAP));
			}
			// 消费上页动作报文。
			return { consume: true };
		}
		// 匹配向下整页。
		if (keybindings.matches(data, "tui.altScreen.pageDown")) {
			// 非松开才执行。
			if (!isRelease) {
				// 下滚同样保留4行重叠，小窗口至少1行。
				this.scrollBy(Math.max(1, this.getPrimaryScrollView().viewportHeight - PAGE_SCROLL_OVERLAP));
			}
			// 下页键消费。
			return { consume: true };
		}
		// 匹配上半页动作。
		if (keybindings.matches(data, "tui.altScreen.halfPageUp")) {
			// 视口高/2向下取整、至少1，取负向上。
			if (!isRelease) this.scrollBy(-Math.max(1, Math.floor(this.getPrimaryScrollView().viewportHeight / 2)));
			// 消费半页上键。
			return { consume: true };
		}
		// 匹配下半页动作。
		if (keybindings.matches(data, "tui.altScreen.halfPageDown")) {
			// 同样计算半页距离，正向下。
			if (!isRelease) this.scrollBy(Math.max(1, Math.floor(this.getPrimaryScrollView().viewportHeight / 2)));
			// 消费半页下键。
			return { consume: true };
		}
		// 匹配向上一行动作。
		if (keybindings.matches(data, "tui.altScreen.lineUp")) {
			// 非松开主区上移1行。
			if (!isRelease) this.scrollBy(-1);
			// 行上动作消费。
			return { consume: true };
		}
		// 匹配向下一行动作。
		if (keybindings.matches(data, "tui.altScreen.lineDown")) {
			// 非松开主区下移1行。
			if (!isRelease) this.scrollBy(1);
			// 行下动作消费。
			return { consume: true };
		}
		// 匹配上一个语义提示起点。
		if (keybindings.matches(data, "tui.altScreen.previousPrompt")) {
			// 非松开向前扫描OSC133 A行。
			if (!isRelease) this.scrollToPrompt(-1);
			// 提示跳转键消费。
			return { consume: true };
		}
		// 匹配下一个语义提示起点。
		if (keybindings.matches(data, "tui.altScreen.nextPrompt")) {
			// 非松开向后扫描。
			if (!isRelease) this.scrollToPrompt(1);
			// 下一提示键消费。
			return { consume: true };
		}
		// 匹配主区跳顶部动作，不是无条件拦截裸Home。
		if (keybindings.matches(data, "tui.altScreen.top")) {
			// 非松开才滚主区到顶。
			if (!isRelease) this.scrollToTop();
			// 顶部动作消费，松开也不传编辑器。
			return { consume: true };
		}
		// 匹配主区到底动作。
		if (keybindings.matches(data, "tui.altScreen.bottom")) {
			// 非松开滚到底，支持followEnd时可恢复跟随输出。
			if (!isRelease) this.scrollToBottom();
			// 底部动作消费。
			return { consume: true };
		}
		// 以上都不是本类负责的动作，放行给基类后续监听器/焦点键盘处理。
		return undefined;
	}

	// 从原button低2位返回left/middle/right/none，无副作用；例0或32低位0都叫left，移动/修饰/滚轮由调用方另外处理，不验证完整SGR。
	private decodeMouseButton(button: number): TuiMouseButton {
		// &3只保留二进制低两位。
		switch (button & 3) {
			// 低位0映射主按钮。
			case 0:
				// 返回left，不保留数值修饰位。
				return "left";
			// 低位1为中键。
			case 1:
				// 返回middle。
				return "middle";
			// 低位2为右键。
			case 2:
				// 返回right。
				return "right";
			// 低位3落默认，通常是无按钮/通用释放编码。
			default:
				// 返回none，是否release由原报文另记。
				return "none";
		}
	}

	// 把种类、原按钮位、绝对格坐标及可选滚轮/点击数构成新规范化事件，无分发/IO；例wheel按钮名固定none但Alt位保留，x/y初始与screenX/Y相同，后续派发再局部换算。
	private createMouseEvent(
		// 索引访问类型TuiMouseEvent["type"]复用合法种类联合，不取运行对象字段。
		type: TuiMouseEvent["type"],
		// 原始button数字位掩码。
		button: number,
		// 0基终端绝对列，未在此夹屏幕。
		x: number,
		// 0基终端绝对行。
		y: number,
		// Pick只取wheelDelta/clickCount两字段，Partial让它们都可省略；默认新空对象，仅编译期结构约束。
		extra: Partial<Pick<TuiMouseEvent, "wheelDelta" | "clickCount">> = {},
		// 返回类型为规范化事件，不建立运行时schema验证。
	): TuiMouseEvent {
		// 创建新事件对象，原参数不修改。
		return {
			// 属性简写保存事件种类。
			type,
			// 轮滚不当普通按键按钮，其他种类按低位解码。
			button: type === "wheel" ? "none" : this.decodeMouseButton(button),
			// 尚未派入子组件，局部x先等于屏幕x。
			x,
			// 局部y同理。
			y,
			// 绝对列供重定向/布局命中。
			screenX: x,
			// 绝对行。
			screenY: y,
			// 事件初始区域宽至少1，派入具体组件时替换；不在此对NaN/小数统一规范。
			width: Math.max(1, this.terminal.columns),
			// 初始区域高至少1。
			height: Math.max(1, this.terminal.rows),
			// 位值4判断Shift，!==0得到boolean。
			shift: (button & 4) !== 0,
			// 位值8判断Alt。
			alt: (button & 8) !== 0,
			// 位值16判断Ctrl。
			ctrl: (button & 16) !== 0,
			// wheelDelta存在才展开字段，0也会保留；缺省不制造undefined键。
			...(extra.wheelDelta === undefined ? {} : { wheelDelta: extra.wheelDelta }),
			// 点击数同样按是否undefined决定是否添加。
			...(extra.clickCount === undefined ? {} : { clickCount: extra.clickCount }),
		};
	}

	// 按最近布局将event派给优先命中组件，返回首个已处理结果或undefined；例HStack不能再借普通纵向Container误命中另一列。会调用handleMouse，异常传播，不自行setFocus/排帧。
	private dispatchMouseToLayout(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		// 尚无成功布局就不能按组件几何派发。
		if (!this.currentLayout) return undefined;
		// 本次已尝试组件引用Set，布局多盒对应同组件时不重复调用。
		const visited = new Set<Component>();
		// 取指针下可见盒子，按层级/深度排序，可能含多个重叠分支。
		const boxes = getLayoutBoxesAt(this.currentLayout, event.screenX, event.screenY);
		// 依优先级逐个尝试。
		for (const box of boxes) {
			// 同组件本轮已经调用过则跳过。
			if (visited.has(box.component)) continue;
			// 布局节点且仍用原Container纵向鼠标处理时跳过，布局树已负责空间命中；自定义覆盖handleMouse仍允许。
			if (getLayoutNode(box.component) && box.component.handleMouse === Container.prototype.handleMouse) continue;
			// 实际尝试前登记，避免同引用后面再试。
			visited.add(box.component);
			// 用公共助手派发并保留实际子目标/原点。
			const result = dispatchMouseEvent(box.component, {
				// 复制事件种类、绝对位置、修饰等字段。
				...event,
				// 屏幕列减盒子左界变局部列。
				x: event.screenX - box.rect.x,
				// 屏幕行减盒子顶部变局部行。
				y: event.screenY - box.rect.y,
				// 局部范围使用盒子全宽，不是clip宽。
				width: box.rect.width,
				// 高度也用完整盒子高，命中收集已考虑clip。
				height: box.rect.height,
			});
			// 首个已处理结果立即返回，后续盒子不再尝试。
			if (result) return result;
		}
		// 所有候选未处理，返回undefined让渲染器使用选择等默认退路。
		return undefined;
	}

	// 应用鼠标结果的焦点/捕获副作用并返回是否需要画，自己不排帧；例press默认画，纯move默认不画，显式render:false可压过焦点变化默认值。setFocus异常不回滚此前状态。
	private applyMouseDispatchResult(event: TuiMouseEvent, result: TuiMouseDispatchResult): boolean {
		// 先取显式focusTarget或实际target组件，再提升到包含它的可见浮层宿主，保留宿主键盘代理。
		const focusTarget = this.resolveMouseFocusTarget(result.focusTarget ?? result.target.component);
		// 记录“明确请求focus且目标不同”的意图，setFocus内部状态机仍可能重定向最终焦点。
		const focusChanged = result.focus === true && this.getFocusedComponent() !== focusTarget;
		// 真值focus才切焦点，不因存在focusTarget字段就自动切。
		if (result.focus) this.setFocus(focusTarget);
		// 请求capture就保存实际鼠标目标，键盘宿主与鼠标目标可不同。
		if (result.capture) this.mouseCapture = result.target;
		// 下面整个表达式返回boolean，??优先采用显式render。
		return (
			// render为false也保留，不用||把它误当缺省。
			result.render ??
			// 未明确render时，焦点目标变化意图会要求画。
			(focusChanged ||
				// press默认画。
				event.type === "press" ||
				// click默认画。
				event.type === "click" ||
				// drag默认画。
				event.type === "drag" ||
				// wheel默认画；move/release无焦点变化则默认false。
				event.type === "wheel")
		);
	}

	// 把event重定向到已记录target，返回处理结果/undefined；例拖出控件仍减原点得到负局部坐标，调用组件但不重命中布局、不验证目标仍挂载，异常传播。
	private dispatchMouseToTarget(
		// 本次新事件的屏幕位置/按钮信息。
		event: TuiMouseEvent,
		// 前一次保存的实际组件与原点宽高。
		target: TuiMouseDispatchTarget,
	): TuiMouseDispatchResult | undefined {
		// 先retarget重算局部事件，再dispatch给该组件，保持嵌套代理返回规则。
		return dispatchMouseEvent(target.component, retargetMouseEvent(event, target));
	}

	// 为组件自管click计算并保存1/2/3循环次数，返回number；例同组件同绝对点500ms内连续释放得到1、2、3、1，读墙钟/改lastComponentClick，不发终端。
	private getComponentClickCount(target: TuiMouseDispatchTarget, x: number, y: number): number {
		// 读取当前墙钟毫秒，系统时间调整可影响此启发式。
		const now = Date.now();
		// 取上次组件点击记录。
		const previous = this.lastComponentClick;
		// 下面条件共同决定是否续计。
		const count =
			// 必须有上次记录，&&同时让TS收窄。
			previous &&
			// 间隔不大于500ms；没有额外检查差值必须非负。
			now - previous.timestamp <= DOUBLE_CLICK_INTERVAL_MS &&
			// 实际目标组件引用相同。
			previous.component === target.component &&
			// 绝对列相同，区别于正文同词内不同列也可续计。
			previous.x === x &&
			// 绝对行也相同。
			previous.y === y
				? // 符合条件用余数循环到下一个1..3值。
					(previous.count % 3) + 1
				: // 否则重新计1。
					1;
		// 保存新时间/次数/目标/绝对点，后续click参考。
		this.lastComponentClick = { timestamp: now, count, component: target.component, x, y };
		// 返回本次次数，不负责真正合成click事件。
		return count;
	}

	// 清正文选择/自动滚动/链接手势，返回void无排帧；例组件press成功后不应同时留下正文选择。它不清正文lastClick或组件捕获，调用方按需要另清。
	private clearTextSelection(): void {
		// 取消50ms自动滚动任务并清方向/指针。
		this.stopSelectionAutoScroll();
		// 正文按下流程停止。
		this.selectionPressActive = false;
		// 清锚点。
		this.selectionAnchor = undefined;
		// 清另一端。
		this.selectionFocus = undefined;
		// 粒度回character。
		this.selectionGranularity = "character";
		// 清词/行初始区间。
		this.selectionInitialRange = undefined;
		// 取消按下链接。
		this.pressedUrl = undefined;
		// 拖动标记归false。
		this.selectionDragged = false;
	}

	// 处理单条SGR鼠标：先给已捕获/按下目标→搜索按钮→浮层/末尾提示/滚动条→基础组件→Windows右键粘贴→正文选择，返回void。
	// 例按钮按下后拖出范围仍送原target；同点松开且没离开过会再合成click，离开后回原点也不算。
	// 会改焦点/捕获/选择并按结果排帧，鼠标组件回调异常传播；只有URL/右键宿主动作的特定分支明确吞同步异常。
	private handleMouseEvent(raw: SgrMouseEvent): void {
		// 位值32表示指针移动，低位按钮决定move或drag。
		const isMotion = (raw.button & 32) !== 0;
		// 嵌套三元给原始事件选规范化类型，release优先于移动位。
		const type: TuiMouseEvent["type"] = raw.release
			? // 小写m总按release处理。
				"release"
			: // 否则有移动位再判断是否带按钮。
				isMotion
				? // 低两位解成none时是无按钮移动。
					this.decodeMouseButton(raw.button) === "none"
					? // 生成move种类。
						"move"
					: // 带按钮移动生成drag。
						"drag"
				: // 无release/移动位则按press，即使其他原始高位还存在。
					"press";
		// 创建屏幕坐标事件，具体派发路径再局部换算。
		const event = this.createMouseEvent(type, raw.button, raw.x, raw.y);

		// 已有显式capture或记住的press目标时，本轮优先定向它，不再找新浮层/滚动条。
		if (this.mouseCapture || this.mousePressTarget) {
			// capture优先，否则取press目标；!只向TS声明根据外层条件该值存在。
			const target = this.mouseCapture ?? this.mousePressTarget!;
			// 已有按下点且指针任一轴变化就认为发生移动。
			if (this.mousePressPoint && (raw.x !== this.mousePressPoint.x || raw.y !== this.mousePressPoint.y)) {
				// 一旦true本手势不再改回false，返回原点仍不成click。
				this.mousePressMoved = true;
				// 移动也取消组件连续点击历史。
				this.lastComponentClick = undefined;
			}
			// 累计本次是否需要重画，先false，后面release与click结果可合并。
			let render = false;
			// 把原event送给原目标，即使坐标已出边界。
			const targetResult = this.dispatchMouseToTarget(event, target);
			// 处理结果存在就应用焦点/捕获并取得画面需求。
			if (targetResult) render = this.applyMouseDispatchResult(event, targetResult);
			// release之后尝试合成点击，然后清手势。
			if (raw.release) {
				// 必须从未移动且按下/松开同一绝对点；可选链防没有按下点时误读x。
				if (!this.mousePressMoved && this.mousePressPoint?.x === raw.x && this.mousePressPoint.y === raw.y) {
					// 在原目标上另造click，按钮数值沿用释放事件。
					const clickEvent = this.createMouseEvent("click", raw.button, raw.x, raw.y, {
						// 计算组件连续次数，和正文按词多击逻辑不同。
						clickCount: this.getComponentClickCount(target, raw.x, raw.y),
					});
					// release回调之后再向同一保存target送click，不在此验证目标是否被release回调移除。
					const clickResult = this.dispatchMouseToTarget(clickEvent, target);
					// 应用click结果；||合并已有render，任一次要求画就画，click回调仍先执行。
					if (clickResult) render = this.applyMouseDispatchResult(clickEvent, clickResult) || render;
				}
				// release结束清capture/press点，不清lastComponentClick。
				this.clearComponentMouseGesture();
			}
			// 确有需求才排帧，无操作move可以不重绘。
			if (render) this.requestRender();
			// 定向手势已处理，不穿透正文/其他组件。
			return;
		}

		// 搜索箭头有效按下优先消费，hover可更新但未消费时继续。
		if (this.handleSearchMouseEvent(raw)) return;

		// 依据最近一次浮层布局派发，结果中hit与是否handled分开。
		const overlay = this.dispatchMouseToOverlay(event);
		// 无浮层矩形命中才允许处理正文上的末尾按钮/滚动条。
		if (!overlay.hit) {
			// 点击末尾提示会直接滚主区到底并排帧，处理则结束。
			if (this.handleScrollToEndIndicatorMouseEvent(raw)) return;
			// 尝试滚动条按下/拖拽，保存是否消费。
			const scrollbarHandled = this.handleScrollbarMouseEvent(raw);
			// 不在拖动滚动条时更新指针hover，可能激活暂隐auto条。
			if (!this.scrollbarDrag) this.updateScrollbarHover(raw.x, raw.y);
			// 滚动条已经处理就不再开始正文选择。
			if (scrollbarHandled) return;
		} else {
			// 指针在浮层上时取消滚动条hover，不让底层条保持活动。
			this.stopScrollbarHover();
		}

		// 使用浮层处理结果；浮层几何命中但不处理时不再派基础组件，无浮层命中才派基础布局。
		const result = overlay.result ?? (overlay.hit ? undefined : this.dispatchMouseToLayout(event));
		// 组件已处理按它的决策执行，默认选择/粘贴退路跳过。
		if (result) {
			// 应用focus/capture，返回本次画面需求。
			const render = this.applyMouseDispatchResult(event, result);
			// 组件press成功才建立该组件完整手势。
			if (type === "press") {
				// 开始组件交互时清正文选择，避免同一按下同时拖正文。
				this.clearTextSelection();
				// 记实际鼠标target，不把键盘宿主误当持续事件接收者。
				this.mousePressTarget = result.target;
				// 保存绝对按下点用于同点click判定。
				this.mousePressPoint = { x: raw.x, y: raw.y };
				// 新手势尚未移动。
				this.mousePressMoved = false;
			}
			// 按组件要求/默认事件规则排帧。
			if (render) this.requestRender();
			// 已处理不走宿主右键或正文选择。
			return;
		}

		// 没人处理时再尝试特定平台右键粘贴，成功消费即结束。
		if (this.handleRightClickPaste(raw)) return;
		// 其余事件交正文选择；浮层命中但未处理也可能进入这个退路，但选择的滚动区判定会考虑hasOverlay。
		this.handleSelectionMouseEvent(raw);
	}

	// 解析垂直轮滚，支持SGR及固定6码元X10，返回方向/坐标/原按钮或undefined，无IO/状态修改；例SGR64上滚、65下滚，66/67水平不在本函数返回垂直轮滚。
	private parseWheelEvent(data: string): WheelEvent | undefined {
		// 先整串匹配SGR数字字段与M/m结尾，释放结尾也被此解析器接受，不另验证有限范围。
		const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
		// SGR形状成立按下面按钮位判断垂直轮滚。
		if (sgr) {
			// 第一组十进制转button，可能同时含修饰位。
			const button = Number.parseInt(sgr[1], 10);
			// 没有64轮滚位就不是这里负责的事件。
			if ((button & 64) === 0) return undefined;
			// 低两位取方向代码。
			const direction = button & 3;
			// 只接受0/1垂直方向，其他undefined，调用方可能再按其他鼠标形状消费。
			if (direction !== 0 && direction !== 1) return undefined;
			// 返回独立轮滚结构。
			return {
				// 方向0变-1向上，1变1向下。
				direction: direction === 0 ? -1 : 1,
				// 协议列减1变0基，不夹到屏内。
				x: Number.parseInt(sgr[2], 10) - 1,
				// 协议行同理。
				y: Number.parseInt(sgr[3], 10) - 1,
				// 保留原button用于Alt倍数。
				button,
			};
		}
		// SGR不匹配才尝试长度恰6且ESC[M开头的旧X10编码。
		if (data.length === 6 && data.startsWith("\x1b[M")) {
			// 按钮码偏移32，先减回来；charCodeAt按单个UTF-16码元读取。
			const button = data.charCodeAt(3) - 32;
			// 旧编码同样要求轮滚位。
			if ((button & 64) === 0) return undefined;
			// 低两位提方向。
			const direction = button & 3;
			// 水平代码不作为垂直轮滚返回。
			if (direction !== 0 && direction !== 1) return undefined;
			// 构造旧编码解析结果。
			return {
				// 统一方向为-1/1。
				direction: direction === 0 ? -1 : 1,
				// 坐标码偏移32且协议从1计数，合计减33。
				x: data.charCodeAt(4) - 33,
				// 行坐标同样减33。
				y: data.charCodeAt(5) - 33,
				// 保存原按钮位掩码。
				button,
			};
		}
		// 两种轮滚都不识别返回undefined，不主动修改/吞输入。
		return undefined;
	}

	// 按指针下ScrollView由内向外分配delta，再把剩余量回退到尚未经过的主区，更新hover并排帧，返回void。
	// 例内层最多下移2而请求5，余3传外层；overscroll:contain只中断指针命中链，主区若没在seen中仍可接剩余量，并非全面阻止主区滚动。
	// 依赖最近布局/ScrollView边界，不写终端滚动历史；scrollBy回调异常向外传播。
	private routeWheel(event: WheelEvent, delta: number): void {
		// 待消耗量初始为本次带方向delta。
		let remaining = delta;
		// 记录已访问滚动对象，防主区被指针链与最后回退重复滚动。
		const seen = new Set<ScrollView>();
		// 有布局才找指针下内外滚动区，没有则空列表，仍可走后面的隐式主区回退。
		for (const scrollView of this.currentLayout ? getScrollViewsAt(this.currentLayout, event.x, event.y) : []) {
			// 在尝试滚动前登记该对象。
			seen.add(scrollView);
			// scrollBy返回未消耗量而非实际移动量，下一个区域只接余量。
			remaining = scrollView.scrollBy(remaining);
			// 余量0或此区contain则退出指针链；不把remaining设0，后面的主区退路仍有条件执行。
			if (remaining === 0 || scrollView.overscroll === "contain") break;
		}
		// 取主要滚动对象，可能不在指针下。
		const primary = this.getPrimaryScrollView();
		// 有余量且主区没试过才滚它，忽略主区再返回的余量，不无限往外传。
		if (remaining !== 0 && !seen.has(primary)) primary.scrollBy(remaining);
		// 滚动后更新指针所在滚动条hover状态。
		this.updateScrollbarHover(event.x, event.y);
		// 即使没实际移动也请求一帧，基类合并请求。
		this.requestRender();
	}

	// 把完整SGR报文解析成button/x/y/release或undefined，无副作用；例ESC[<0;2;3M得到列1行2的press候选，只校验数字形状不校验button语义/有限范围。
	private parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
		// 捕获按钮、列、行以及大小写结束符，必须匹配整个data。
		const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
		// 不匹配则不返回事件。
		if (!match) return undefined;
		// 构造原始鼠标结构，后续handleMouseEvent再规范种类。
		return {
			// 按钮十进制数值仍含全部高位。
			button: Number.parseInt(match[1], 10),
			// 列从1基改0基，0文本可得到-1，未在解析器拒绝。
			x: Number.parseInt(match[2], 10) - 1,
			// 行同理。
			y: Number.parseInt(match[3], 10) - 1,
			// 只有小写m标release，大写M为false。
			release: match[4] === "m",
		};
	}

	// 仅适合的Windows右键按下调用注入粘贴动作，返回是否消费；例win32且TERM_PROGRAM不是vscode、button正好2时触发，抓同步抛错仍算消费，不执行系统剪贴板API本身。
	private handleRightClickPaste(event: SgrMouseEvent): boolean {
		// 下面任一拒绝条件成立就false。
		if (
			// 没有宿主动作不处理。
			!this.onRightClickPaste ||
			// 仅Windows启用，其他平台交其他鼠标逻辑。
			process.platform !== "win32" ||
			// VSCode终端自管右键，忽略大小写后匹配vscode时不触发。
			process.env.TERM_PROGRAM?.toLowerCase() === "vscode" ||
			// 松开不触发粘贴。
			event.release ||
			// 必须button严格等2，无修饰/移动高位，避免拖动或带修饰右键误粘贴。
			event.button !== 2
		) {
			// 不满足条件则未消费。
			return false;
		}
		// 仅围住宿主同步回调的尽力处理，不等待Promise。
		try {
			// 执行注入的动作，真实应用可在此读剪贴板，测试只计数。
			this.onRightClickPaste();
			// 同步抛错被吞，若违反void约定返回拒绝Promise不由此catch异步接住。
		} catch {
			// Clipboard paste is best-effort.
		}
		// 即使宿主同步抛错也返回true，避免同一右键又落别的处理。
		return true;
	}

	// 处理末尾提示文字内的左键按下，命中则滚主区到底并返回true；例点提示旁空格false，不检查所有修饰位，不直接复制/打开链接。
	private handleScrollToEndIndicatorMouseEvent(event: SgrMouseEvent): boolean {
		// 读取最近绘制矩形，未显示时undefined。
		const rect = this.scrollToEndIndicatorRect;
		// 无矩形/松开/移动/非左键都不触发，低位0带修饰仍可进。
		if (!rect || event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
		// 必须同一行且列落在文字左闭右开范围，不把整行当按钮。
		if (event.y !== rect.row || event.x < rect.column || event.x >= rect.column + rect.width) return false;
		// 滚到底并请求后续帧，恢复跟随取决于主区配置。
		this.scrollToBottom();
		// 命中已处理。
		return true;
	}

	// 按x/y找最近布局中可用滚动条目标，返回对象或undefined，无滚动；例includeHiddenAuto=true用于hover唤醒auto条，但任一可见浮层存在就禁底层条命中。
	private getScrollbarTargetAt(x: number, y: number, includeHiddenAuto = false): ScrollbarTarget | undefined {
		// 有可见浮层或无布局时不向底层滚动条派发，即使浮层没盖住该点。
		if (this.hasOverlay() || !this.currentLayout) return undefined;
		// 按指针下滚动区的嵌套深度由内到外寻找。
		for (const scrollView of getScrollViewsAt(this.currentLayout, x, y)) {
			// 取对应盒子完整几何/内容。
			const box = getScrollViewBox(this.currentLayout, scrollView);
			// 有盒子才算条几何，可选包含溢出但暂隐的auto条；不直接显示条。
			const geometry = box ? getScrollbarGeometry(box, includeHiddenAuto) : undefined;
			// 下面&&要求有几何且点落它的轨道列/行范围。
			if (
				// 几何必须存在，让TS收窄后可读字段。
				geometry &&
				// 滚动条单列，x必须恰等其column。
				x === geometry.column &&
				// 行不在轨道顶部以上。
				y >= geometry.trackTop &&
				// 行严格小于轨道排他末界。
				y < geometry.trackTop + geometry.trackHeight
			) {
				// 返回首个命中滚动对象及几何引用。
				return { scrollView, geometry };
			}
		}
		// 无轨道命中返回undefined。
		return undefined;
	}

	// 切换hover滚动区并激活/取消它的auto条保持显示，返回void；例从A移B先关A再开B，无直接终端写，ScrollView可通知排帧，异常不回滚字段。
	private setScrollbarHover(scrollView: ScrollView | undefined): void {
		// 引用没变不重复重启活跃状态。
		if (scrollView === this.scrollbarHover) return;
		// 旧hover存在才通知它不再活动。
		this.scrollbarHover?.setScrollbarActive(false);
		// 保存新引用，可undefined。
		this.scrollbarHover = scrollView;
		// 新hover存在才激活；auto条显示/隐藏由ScrollView处理。
		this.scrollbarHover?.setScrollbarActive(true);
	}

	// 按指针坐标刷新hover，返回void；例移到隐藏auto轨道时includeHiddenAuto使它可被找到，再激活显示，不在此滚动。
	private updateScrollbarHover(x: number, y: number): void {
		// 找不到目标取undefined，相当取消旧hover。
		this.setScrollbarHover(this.getScrollbarTargetAt(x, y, true)?.scrollView);
	}

	// 结束当前hover，无参数/void；例如窗口失焦调用，委托setter取消旧条active状态，不直接清绘屏。
	private stopScrollbarHover(): void {
		// undefined表示没有任何悬停对象。
		this.setScrollbarHover(undefined);
	}

	// 把拖拽指针行按轨道比例映射为scrollTop，返回void；例轨道可移8格、指针对应4格则滚到最大偏移一半，考虑抓取偏移，ScrollView通知排帧，不直接写终端。
	private scrollScrollbarToPointer(
		// 要修改的滚动视图。
		scrollView: ScrollView,
		// 当前布局滚动条几何，可能与按下时滑块高度不同。
		geometry: ScrollbarGeometry,
		// 绝对终端指针行。
		pointerY: number,
		// 指针相对滑块上缘的抓取距离。
		grabOffset: number,
	): void {
		// 滑块可移动行数=轨道高减滑块高。
		const maxThumbOffset = geometry.trackHeight - geometry.thumbHeight;
		// 指针减轨道起行及grabOffset得到目标滑块偏移，再夹轨道范围。
		const thumbOffset = Math.max(0, Math.min(maxThumbOffset, pointerY - geometry.trackTop - grabOffset));
		// 无可移距离直接0，否则按比例乘最大滚动量并四舍五入。
		const scrollTop = maxThumbOffset === 0 ? 0 : Math.round((thumbOffset / maxThumbOffset) * geometry.maxScrollTop);
		// scrollTo再规范/夹内容范围，可能改跟随状态和触发回调。
		scrollView.scrollTo(scrollTop);
	}

	// 处理滚动条现有拖拽或新左键按下，返回是否消费；例点滑块保抓取点，点轨道把滑块中心移到指针再开始拖动。新按下会清正文选择并把hover切到目标，通过ScrollView安排重画，异常传播。
	private handleScrollbarMouseEvent(event: SgrMouseEvent): boolean {
		// 已有拖拽时不重命中，持续操作保存的scrollView。
		if (this.scrollbarDrag) {
			// release终止滚动条手势。
			if (event.release) {
				// 清拖拽记录，不复制文字。
				this.stopScrollbarDrag();
				// 松开已消费。
				return true;
			}
			// 拖动阶段从当前布局取这条滚动对象的新几何。
			const box = this.currentLayout
				? // 有布局才能找对应盒子。
					getScrollViewBox(this.currentLayout, this.scrollbarDrag.scrollView)
				: // 布局暂失效时无盒子，仍保留拖拽直到释放。
					undefined;
			// 正常可见条才提供几何，不强制包含隐藏auto。
			const geometry = box ? getScrollbarGeometry(box) : undefined;
			// 有几何才按本次指针更新scrollTop。
			if (geometry) {
				// 多行实参共同调用比例换算函数。
				this.scrollScrollbarToPointer(
					// 继续拖同一个滚动视图。
					this.scrollbarDrag.scrollView,
					// 用本次几何。
					geometry,
					// 本次指针y，不限制必须仍在原轨道范围，换算会夹住。
					event.y,
					// 用按下时记的抓取偏移。
					this.scrollbarDrag.grabOffset,
				);
			}
			// 有活动拖拽即消费，就算这帧暂时无几何。
			return true;
		}

		// 新拖拽只从左键按下开始，排除释放/移动和低位非0；未排除所有键盘修饰。
		if (event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
		// 根据当前指针找到可见条目标。
		const target = this.getScrollbarTargetAt(event.x, event.y);
		// 未命中不消费，后续可启动文字选择。
		if (!target) return false;
		// 开始滚动条时停止正文边缘滚动。
		this.stopSelectionAutoScroll();
		// 正文按下结束。
		this.selectionPressActive = false;
		// 清正文选择起点。
		this.selectionAnchor = undefined;
		// 清末点。
		this.selectionFocus = undefined;
		// 粒度复位。
		this.selectionGranularity = "character";
		// 清词/行原范围。
		this.selectionInitialRange = undefined;
		// 正文多击计数清空。
		this.lastClick = undefined;
		// 取消待打开链接。
		this.pressedUrl = undefined;
		// 正文拖动标记清空。
		this.selectionDragged = false;
		// 激活目标滚动条hover，让auto条在拖动期间可保持。
		this.setScrollbarHover(target.scrollView);
		// 下面范围判断是否按在滑块本体，而不只是轨道空区。
		const onThumb =
			// 滑块顶部包含、底部排除。
			event.y >= target.geometry.thumbTop && event.y < target.geometry.thumbTop + target.geometry.thumbHeight;
		// 按本体保留真实抓点，轨道空区则用滑块高度一半作为抓点。
		const grabOffset = onThumb ? event.y - target.geometry.thumbTop : Math.floor(target.geometry.thumbHeight / 2);
		// 按轨道空区立即跳比例位置；按本体先不移动，等待后续drag。
		if (!onThumb) this.scrollScrollbarToPointer(target.scrollView, target.geometry, event.y, grabOffset);
		// 记录持续滚动条手势。
		this.scrollbarDrag = {
			// 保存目标滚动视图引用。
			scrollView: target.scrollView,
			// 保存后续指针换算所需偏移。
			grabOffset,
		};
		// 新滚动条按下已处理。
		return true;
	}

	// 清滚动条拖动记录，无参数/void、无直接重绘；例release/失焦/stop结束手势，不自动改变当前scrollTop。
	private stopScrollbarDrag(): void {
		// 赋undefined即可断开当前拖拽对象。
		this.scrollbarDrag = undefined;
	}

	// 把屏幕x/y映射到指定scrollView内容选择点，返回点或undefined，无状态修改；例区顶部屏幕2、scrollTop10、指针y3得到内容行11，拖出边缘时夹到可见部分。
	private getScrollSelectionPoint(scrollView: ScrollView, x: number, y: number): SelectionPoint | undefined {
		// 没布局无法知道滚动区屏幕矩形。
		if (!this.currentLayout) return undefined;
		// 按对象身份找布局盒子。
		const box = getScrollViewBox(this.currentLayout, scrollView);
		// 无盒子或完整高/裁剪高非正则无有效选择区域。
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) return undefined;
		// 可见起行取屏顶0、盒子顶部、clip顶部最大值。
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		// 可见末行用下方三个包含边界中的最小值。
		const visibleBottom = Math.min(
			// 不能超终端最后一行。
			this.terminal.rows - 1,
			// 不能超滚动窗口矩形底。
			box.rect.y + box.rect.height - 1,
			// 不能超祖先裁剪底。
			box.clip.y + box.clip.height - 1,
		);
		// 上下界倒置说明区域完全不可见。
		if (visibleBottom < visibleTop) return undefined;
		// 指针y夹到可见起末行，拖在屏外也可选边缘行。
		const pointerRow = Math.max(visibleTop, Math.min(visibleBottom, y));
		// 内容末索引按完整行数组长度，缺内容暂按至少一行，再夹不负。
		const maxContentRow = Math.max(0, (box.scrollContentLines?.length ?? 1) - 1);
		// 返回这个滚动内容坐标系的选择点。
		return {
			// scrollTop+屏内相对窗口偏移得到内容行，再夹实际内容范围。
			row: Math.max(0, Math.min(maxContentRow, scrollView.scrollTop + pointerRow - box.rect.y)),
			// x减盒子左界得到内容列，只夹盒子宽，未单独按横向clip夹边界。
			col: Math.max(0, Math.min(box.rect.width - 1, x - box.rect.x)),
			// 记录scrollView引用，使后续拖动/复制继续用同一完整内容。
			scrollView,
		};
	}

	// 为鼠标取选择点，优先指定滚动区映射、失败回退屏幕坐标，返回点无修改；例没命中ScrollView的静态区域按屏幕行选，具体选择状态由调用方保存。
	private getSelectionPoint(event: SgrMouseEvent, scrollView?: ScrollView): SelectionPoint {
		// 调用方提供内容区才尝试内容坐标。
		if (scrollView) {
			// 按该区最近几何换算并夹取。
			const point = this.getScrollSelectionPoint(scrollView, event.x, event.y);
			// 映射成功就返回带scrollView的点。
			if (point) return point;
		}
		// 否则返回不带scrollView的屏幕点。
		return {
			// 行夹到当前终端0..rows-1，按正常正尺寸使用。
			row: Math.max(0, Math.min(this.terminal.rows - 1, event.y)),
			// 列同样夹屏幕范围，尚未按实际行字素吸附。
			col: Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
		};
	}

	// 读取point所属完整内容/旧屏某行，返回字符串，无修改；例滚动内容行20不必当前可见，找不到来源/越界回空串，几何缺失时可回退旧屏索引。
	private getSelectionSourceLine(point: SelectionPoint): string {
		// 有滚动身份且仍有当前布局时优先内容来源。
		if (point.scrollView && this.currentLayout) {
			// 取对应布局盒子的完整原始行，可能含ANSI/语义标记。
			const lines = getScrollViewBox(this.currentLayout, point.scrollView)?.scrollContentLines;
			// 内容数组存在时按内容row读取，越界空串，不再回旧屏。
			if (lines) return lines[point.row] ?? "";
		}
		// 不能取滚动内容则按同row索引旧屏，未证明这是同坐标系的精确替代。
		return this.previousScreen[point.row] ?? "";
	}

	// 按词分段器和路径连接符取point所在整段选择范围，返回区间/undefined，无选择状态修改；例双击foo/bar-baz里的bar可连选整路径，非可选空白本段也可返回但不与旁词合并。
	private getWordSelection(point: SelectionPoint): SelectionRange | undefined {
		// 先取来源行再去终端控制串，按纯文字分词；不是清除业务原文或写回组件。
		const line = stripTerminalSequences(this.getSelectionSourceLine(point));
		// 每个分段记录显示起/末列、可连接资格及是否连接符，字段由内联TS类型约束。
		const segments: Array<{ start: number; end: number; selectable: boolean; joiner: boolean }> = [];
		// 累计显示列起点从0开始，不使用Intl给的UTF-16 index直接当列。
		let start = 0;
		// wordSegmenter按当前宿主词规则迭代segment，可能有词/空白/标点。
		for (const segment of wordSegmenter.segment(line)) {
			// 分段显示宽加当前起列得到排他末界。
			const end = start + visibleWidth(segment.segment);
			// 只有整分段恰好在指定连接符Set里才joiner=true。
			const joiner = TERMINAL_WORD_SELECTION_JOINERS.has(segment.segment);
			// 词样片段或连接符可参与连接；空白等仍被记录，但selectable通常false。
			segments.push({ start, end, selectable: segment.isWordLike === true || joiner, joiner });
			// 推进下一分段显示起点。
			start = end;
		}
		// findIndex寻找指针显示列所在的第一分段，下一行是匹配回调。
		const clickedSegmentIndex = segments.findIndex(
			// 按左闭右开显示范围命中，末尾之外无分段。
			(segment) => point.col >= segment.start && point.col < segment.end,
		);
		// 没命中返回undefined，不制造0长度词区。
		if (clickedSegmentIndex < 0) return undefined;

		// 局部canJoin回调判断相邻两段能否连选，返回boolean无副作用；例word加斜杠能连，两个普通相邻词段没joiner不在此强连。
		const canJoin = (
			// 左片段只需可选/连接符两个布尔字段，结构类型允许原segment多带起末列。
			left: { selectable: boolean; joiner: boolean },
			// 右片段同一结构。
			right: { selectable: boolean; joiner: boolean },
			// 两边都须selectable，且至少一边是连接符；&&/||按括号表达整条连接规则。
		): boolean => left.selectable && right.selectable && (left.joiner || right.joiner);
		// 起点先取鼠标所处片段，不要求它本身是wordLike。
		let selectionStart = segments[clickedSegmentIndex].start;
		// 末界先取本片段完整范围。
		let selectionEnd = segments[clickedSegmentIndex].end;
		// 从点击片段向左，只要相邻可连就逐段扩展，遇不相连/首段停。
		for (let index = clickedSegmentIndex; index > 0 && canJoin(segments[index - 1], segments[index]); index--) {
			// 把最左起列更新为前一片段起点。
			selectionStart = segments[index - 1].start;
		}
		// 多行for独立做向右扩展，与上面向左扫描互不改原segments。
		for (
			// 右扫也从最初点击段开始。
			let index = clickedSegmentIndex;
			// 还有下一段且两者可连接才继续。
			index < segments.length - 1 && canJoin(segments[index], segments[index + 1]);
			// 本轮后向右推进一个分段索引。
			index++
		) {
			// 末界扩到下一段末尾，保持完整片段。
			selectionEnd = segments[index + 1].end;
		}
		// 返回新SelectionRange，原point不修改。
		return {
			// 保留所属行/scrollView等字段，覆盖起点列。
			start: { ...point, col: selectionStart },
			// 末端列是排他边界，boundary:true避免后面再把它视作需包含的一个格。
			end: { ...point, col: selectionEnd, boundary: true },
		};
	}

	// 生成point所在整行选择范围，返回新对象无选择状态改动；例三击一行得到列0到该来源行显示宽，末端标boundary，无直接复制/IO。
	private getLineSelection(point: SelectionPoint): SelectionRange {
		// 创建区间外壳。
		return {
			// 起列改0，其余来源/行字段沿用point，未主动删除point原boundary字段。
			start: { ...point, col: 0 },
			// 来源行显示宽作排他末界，终端ANSI不占列，标boundary:true。
			end: { ...point, col: visibleWidth(this.getSelectionSourceLine(point)), boundary: true },
		};
	}

	// 按当前粒度把拖动点扩成新的选择末端并必要时反转锚点，返回void不排帧；例从初选词向左拖，会固定初词末端为锚、让新词起点为focus，保证初词不被截断。
	private updateSelectionFocus(point: SelectionPoint): void {
		// 逐格选择或没有初选区间时，直接用当前点。
		if (this.selectionGranularity === "character" || !this.selectionInitialRange) {
			// 只更新focus，不改锚点。
			this.selectionFocus = point;
			// 简单点模式结束。
			return;
		}
		// 词粒度重算当前词范围，其他非character粒度按整行；三元只调用所选一方。
		const range = this.selectionGranularity === "word" ? this.getWordSelection(point) : this.getLineSelection(point);
		// 词分段无法命中就保持旧选择，不强造区间。
		if (!range) return;
		// 初次双/三击的范围，外层已确认存在。
		const initial = this.selectionInitialRange;
		// 下面按行优先、同列次之判断新范围是否位于初选前面。
		const targetBeforeInitial =
			// 新起行更早就向前扩。
			range.start.row < initial.start.row ||
			// 同行时比较起列，不按UTF-16索引比较。
			(range.start.row === initial.start.row && range.start.col < initial.start.col);
		// 向前拖动，把初选末端固定住。
		if (targetBeforeInitial) {
			// 锚点切初选排他末端。
			this.selectionAnchor = initial.end;
			// 另一端为新范围起点，之后getSelectionBounds规范前后。
			this.selectionFocus = range.start;
		} else {
			// 向后/同初选位置则固定初选起点。
			this.selectionAnchor = initial.start;
			// focus取新词/行末界，保留整段。
			this.selectionFocus = range.end;
		}
	}

	// 按同一来源/行/词范围及500ms间隔计算正文多击数并保存历史，返回1..3；例同词里点不同字也能双击，无word时清历史并给1，非组件同点计数。
	private getClickCount(point: SelectionPoint, word: SelectionRange | undefined): number {
		// 读取墙钟毫秒，不保证系统校时后差值仍非负。
		const now = Date.now();
		// 保存上一次正文点击记录供比较。
		const previous = this.lastClick;
		// 下方条件决定是否延续计数。
		const count =
			// 本次必须命中某个完整词分段区间。
			word &&
			// 之前也须有记录。
			previous &&
			// 距上次不超过500ms，未额外要求>=0。
			now - previous.timestamp <= DOUBLE_CLICK_INTERVAL_MS &&
			// 内容行相同。
			previous.row === point.row &&
			// 滚动视图身份同一，两个undefined都属于屏幕坐标系。
			previous.scrollView === point.scrollView &&
			// 词起列同一，不要求原点击col同一。
			previous.wordStart === word.start.col &&
			// 词排他末界也同一。
			previous.wordEnd === word.end.col
				? // 上次count对3取余再加1，实现1→2→3→1。
					(previous.count % 3) + 1
				: // 任一条件不满足，本次按1。
					1;
		// 只有本次存在word才保存新历史，否则置undefined。
		this.lastClick = word
			? // 构造新点击记录。
				{
					// 本次时间戳。
					timestamp: now,
					// 本次累计次数。
					count,
					// 来源行。
					row: point.row,
					// 来源滚动区，可undefined。
					scrollView: point.scrollView,
					// 词起列。
					wordStart: word.start.col,
					// 词末界。
					wordEnd: word.end.col,
				}
			: // 无词区间时取消连续计数。
				undefined;
		// 返回次数给调用者决定逐格/词/行选择。
		return count;
	}

	// 根据拖动点相对滚动区可见边缘启停50ms自动滚动，返回void；例指针停顶部边缘继续上滚并延伸选择，只有选择锚点带ScrollView才支持，不直接改复制文本。
	private updateSelectionAutoScroll(event: SgrMouseEvent): void {
		// 跟随锚点所属滚动区，不随鼠标跨到其他区就切来源。
		const scrollView = this.selectionAnchor?.scrollView;
		// 无滚动来源/当前布局时不能边缘滚动。
		if (!scrollView || !this.currentLayout) {
			// 取消可能已有interval并清方向/指针。
			this.stopSelectionAutoScroll();
			// 结束无可滚动来源路径。
			return;
		}
		// 按同一ScrollView找最近布局盒。
		const box = getScrollViewBox(this.currentLayout, scrollView);
		// 没有盒子/矩形高或裁剪高非正时停自动滚动。
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) {
			// 释放interval，避免无效几何下循环。
			this.stopSelectionAutoScroll();
			// 结束。
			return;
		}
		// 屏顶/盒顶/clip顶最大者是可见顶部。
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		// 取下方三个包含末界最小者作为可见底部。
		const visibleBottom = Math.min(
			// 终端末行。
			this.terminal.rows - 1,
			// 滚动盒子末行。
			box.rect.y + box.rect.height - 1,
			// clip末行。
			box.clip.y + box.clip.height - 1,
		);
		// 保存本次绝对指针，interval没有新鼠标事件时仍用它换算延伸点。
		this.selectionDragPointer = { x: event.x, y: event.y };
		// 顶部或更上选-1，底部或更下选1，中间0；若上下边界重叠，三元顶部判断优先。
		this.selectionAutoScrollDirection = event.y <= visibleTop ? -1 : event.y >= visibleBottom ? 1 : 0;
		// 指针离开边缘，自动滚动应停止。
		if (this.selectionAutoScrollDirection === 0) {
			// 清任务、方向和保存的指针。
			this.stopSelectionAutoScroll();
			// 不再新建interval。
			return;
		}
		// 已有任务就复用，新方向/指针已在上方更新，避免每个drag都重建计时器。
		if (this.selectionAutoScrollTimer) return;
		// 注册每约50ms调用autoScrollSelection的回调，不立即滚一格，宿主调度可更晚。
		this.selectionAutoScrollTimer = setInterval(() => this.autoScrollSelection(), 50);
		// unref让该任务不单独阻止Node退出，不表示已取消。
		this.selectionAutoScrollTimer.unref();
	}

	// 自动滚动interval的一步：按方向试移1行，无消耗则停，有移动则按保存指针更新选择并排帧，返回void；例停顶边每轮扩上一行，ScrollView/回调异常不吞。
	private autoScrollSelection(): void {
		// 读取当前选择来源滚动区，可能已被其他操作清掉。
		const scrollView = this.selectionAnchor?.scrollView;
		// 读取最后drag指针，没新事件也能继续。
		const pointer = this.selectionDragPointer;
		// 当前方向-1/0/1。
		const direction = this.selectionAutoScrollDirection;
		// 状态不再满足自动滚动条件则取消任务。
		if (!scrollView || !pointer || direction === 0) {
			// 统一清interval/方向/指针。
			this.stopSelectionAutoScroll();
			// 结束这一步。
			return;
		}
		// 请求方向1行，scrollBy返回未消耗量。
		const remaining = scrollView.scrollBy(direction);
		// 返回量与原方向完全相同表示一行都没滚，已经到边界。
		if (remaining === direction) {
			// 到边界停止，避免无意义周期排帧。
			this.stopSelectionAutoScroll();
			// 边界路径结束。
			return;
		}
		// 滚动偏移更新后按同屏幕指针重新映射内容行。
		const point = this.getScrollSelectionPoint(scrollView, pointer.x, pointer.y);
		// 有有效点就按词/行/逐格规则延伸选择。
		if (point) this.updateSelectionFocus(point);
		// 请求绘制新的视口/高亮。
		this.requestRender();
	}

	// 停止选择自动滚动，无参数/void；例松开或失焦时调用，取消interval并清方向/指针，不清选择端点、不直接画屏。
	private stopSelectionAutoScroll(): void {
		// 有计时器才执行取消。
		if (this.selectionAutoScrollTimer) {
			// clearInterval阻止未来回调，不回滚已经滚过的内容。
			clearInterval(this.selectionAutoScrollTimer);
			// 清句柄允许以后新建。
			this.selectionAutoScrollTimer = undefined;
		}
		// 方向归0代表不滚动。
		this.selectionAutoScrollDirection = 0;
		// 释放最后指针状态。
		this.selectionDragPointer = undefined;
	}

	// 处理默认正文选择：按下建立锚点/双三击范围，拖动延伸并边缘滚动，松开可开链接/派click/自动复制后排帧，返回void。
	// 例鼠标从“alpha”拖到“beta”松开可复制两行纯文字；默认OSC52只写协议，注入copySelection可执行宿主复制。
	// 只接受左键或通用释放低位3；未完成手势失焦后孤立drag/release忽略。自动复制使用void丢Promise，不捕获异步拒绝。
	private handleSelectionMouseEvent(event: SgrMouseEvent): void {
		// 低两位取按钮，不把修饰/移动位混进按钮名。
		const button = event.button & 3;
		// 左键0可处理，或release且低位3容许通用松开；其他按钮直接结束。
		if (button !== 0 && !(event.release && button === 3)) return;
		// 旧锚点有滚动身份时，用同来源映射本次位置。
		const anchorScrollView = this.selectionAnchor?.scrollView;
		// 准备本次点，未指定来源则先用屏幕坐标，按下分支后面会重新选来源。
		const point = this.getSelectionPoint(event, anchorScrollView);
		// 松开分支优先于移动位。
		if (event.release) {
			// 没有仍活动的按下就忽略孤立释放，不延伸旧已完成选择。
			if (!this.selectionPressActive) return;
			// 本次按下过程结束，但端点可继续保留高亮。
			this.selectionPressActive = false;
			// 停止边缘滚动，松开后不应继续自动滚。
			this.stopSelectionAutoScroll();
			// 锚点已无效就结束，没有可复制来源。
			if (!this.selectionAnchor) return;
			// 按释放位置最后更新一次选择范围。
			this.updateSelectionFocus(point);
			// 下面共同判断这是原点单击而非拖选。
			const isClick =
				// 整个手势从未发生移动。
				!this.selectionDragged &&
				// 释放点与锚点的来源ScrollView一致。
				this.selectionAnchor.scrollView === point.scrollView &&
				// 同一内容/屏幕行。
				this.selectionAnchor.row === point.row &&
				// 显示列也完全同一；词/行范围锚点不一定等原点击列，所以双/三击走选择而非单击开链接。
				this.selectionAnchor.col === point.col;
			// 仅单击才保留按下时记录的URL，拖动/区间选择不打开。
			const clickedUrl = isClick ? this.pressedUrl : undefined;
			// 无论后续走哪条分支，清待开链接状态。
			this.pressedUrl = undefined;
			// 有非空URL且宿主提供openUrl才处理链接动作。
			if (clickedUrl && this.openUrl) {
				// 开链接时取消正文选择起点。
				this.selectionAnchor = undefined;
				// 取消选择末点。
				this.selectionFocus = undefined;
				// 仅围住同步宿主打开动作，尽力执行。
				try {
					// 把原OSC8 URL交宿主，不在此做协议安全白名单/网络请求，策略由宿主决定。
					this.openUrl(clickedUrl);
					// 同步抛错吞掉；若违规返回拒绝Promise，不由这个同步catch等待处理。
				} catch {
					// URL activation is best-effort.
				}
				// 排帧去掉刚清的选择高亮。
				this.requestRender();
				// 链接动作不再派组件click或复制。
				return;
			}
			// 没有开链接的单击还可交仅处理click的鼠标组件。
			if (isClick) {
				// 合成click事件，原始释放位掩码仍传入规范化。
				const clickEvent = this.createMouseEvent("click", event.button, event.x, event.y, {
					// 沿用正文多击次数，缺记录默认1。
					clickCount: this.lastClick?.count ?? 1,
				});
				// 先命中最近浮层矩形并派发。
				const overlay = this.dispatchMouseToOverlay(clickEvent);
				// 浮层未命中才派基础布局；命中但未处理不穿透组件树。
				const result = overlay.result ?? (overlay.hit ? undefined : this.dispatchMouseToLayout(clickEvent));
				// 有组件click结果就让它接管。
				if (result) {
					// 应用焦点/捕获与默认是否画决策。
					const render = this.applyMouseDispatchResult(clickEvent, result);
					// 组件处理后清正文选择相关状态。
					this.clearTextSelection();
					// 组件需要时才排帧。
					if (render) this.requestRender();
					// 已派click，不再自动复制。
					return;
				}
			}
			// 开关真就发起异步复制；void只表示忽略Promise值，不等于await或catch，注入回调拒绝可成为未处理拒绝。
			if (this.copyOnSelect) void this.copySelectionToClipboard();
			// 松开后请求显示保留的选择/可能的提示，复制Promise可能尚未完成。
			this.requestRender();
			// 释放流程结束。
			return;
		}
		// 未释放且有32移动位，视为左键拖动。
		if ((event.button & 32) !== 0) {
			// 必须有有效活动按下和锚点，否则忽略孤立drag。
			if (!this.selectionPressActive || !this.selectionAnchor) return;
			// 标记拖动，后面即使回原点也不当单击开链接。
			this.selectionDragged = true;
			// 拖动取消正文连续点击。
			this.lastClick = undefined;
			// 拖动取消按下URL。
			this.pressedUrl = undefined;
			// 按当前point更新选择另一端，可能按词/行扩展。
			this.updateSelectionFocus(point);
			// 按屏幕边缘决定是否启停自动滚动。
			this.updateSelectionAutoScroll(event);
			// 请求当前拖选高亮。
			this.requestRender();
			// 拖动处理完成。
			return;
		}
		// 新按下先终止上次边缘滚动。
		this.stopSelectionAutoScroll();
		// 标记正文按下有效。
		this.selectionPressActive = true;
		// 新按下决定选哪一个坐标系，下面三元找滚动区或纯屏幕。
		const scrollView =
			// 没有任何可见浮层且有布局时才建立滚动内容选择。
			!this.hasOverlay() && this.currentLayout
				? // 优先指针下最内层ScrollView，不是无条件主区。
					getScrollViewsAt(this.currentLayout, event.x, event.y)[0]
				: // 有浮层或无布局则不绑定ScrollView，选择屏幕行。
					undefined;
		// 按选定来源重新映射按下锚点。
		const anchor = this.getSelectionPoint(event, scrollView);
		// 取点击词/空白分段，供连续点击与双击区间。
		const word = this.getWordSelection(anchor);
		// 计算并保存正文连续次数，按同词而非同点续计。
		const clickCount = this.getClickCount(anchor, word);
		// 2次选词、3次选整行，其他只初始单点；嵌套三元只调用选中分支。
		const range = clickCount === 2 ? word : clickCount === 3 ? this.getLineSelection(anchor) : undefined;
		// 有区间按次数设word/line，否则character，避免没词却强设词粒度。
		this.selectionGranularity = range ? (clickCount === 2 ? "word" : "line") : "character";
		// 保留最初整词/整行范围供向前向后拖选。
		this.selectionInitialRange = range;
		// 区间起点优先，无区间用单点anchor。
		this.selectionAnchor = range?.start ?? anchor;
		// 区间排他末界优先，无区间起末同点暂不构成非零选择。
		this.selectionFocus = range?.end ?? anchor;
		// 新手势尚未拖动。
		this.selectionDragged = false;
		// 有词/行区间就不记开链接候选，单点才查OSC8。
		this.pressedUrl = range
			? // 区间选择的pressedUrl清空。
				undefined
			: // 从实际旧屏可见行/列查链接，不从全文内容行直接猜。
				getOsc8LinkAtColumn(
					// 屏幕行夹到当前终端范围，旧屏缺项用空串。
					this.previousScreen[Math.max(0, Math.min(this.terminal.rows - 1, event.y))] ?? "",
					// 屏幕列同样夹范围，助手按完整字素列/活动OSC8查找。
					Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
				);
		// 按下状态改变也排帧，即使暂时没有非零选择。
		this.requestRender();
	}

	// 把选择端点按行/列排序成非零同来源范围，返回引用组成的新对象或undefined，无修改；例反向拖动会交换start/end，端点同row/col则无区间，不单独比较boundary。
	private getSelectionBounds(): { start: SelectionPoint; end: SelectionPoint } | undefined {
		// 任一端缺失没有选择。
		if (!this.selectionAnchor || !this.selectionFocus) return undefined;
		// 两个不同ScrollView或一个屏幕一个内容区不能拼成统一范围。
		if (this.selectionAnchor.scrollView !== this.selectionFocus.scrollView) return undefined;
		// 下面行优先、同列次之，判断锚点是否在focus之前。
		const anchorBeforeFocus =
			// 更早行即在前。
			this.selectionAnchor.row < this.selectionFocus.row ||
			// 同行按显示列严格小于排序。
			(this.selectionAnchor.row === this.selectionFocus.row && this.selectionAnchor.col < this.selectionFocus.col);
		// 下面两条件共同判断端点位置完全相同。
		if (
			// 行相等。
			this.selectionAnchor.row === this.selectionFocus.row &&
			// 显示列也相等，boundary差异不在此构成非零选择。
			this.selectionAnchor.col === this.selectionFocus.col
		) {
			// 位置相同返回undefined，不复制任何字符。
			return undefined;
		}
		// 按比较结果选正向或反向对象，端点仍是原引用。
		return anchorBeforeFocus
			? // 锚点在前则原顺序。
				{ start: this.selectionAnchor, end: this.selectionFocus }
			: // 否则交换，使后续逐行循环始终由早到晚。
				{ start: this.selectionFocus, end: this.selectionAnchor };
	}

	// 计算某行落入selection的显示列半开区间并夹min/max，返回{start,end}无修改；例点在两列汉字任一格时起点吸到汉字左、普通格末点包含整个字素，boundary末点直接排他。
	private getSelectionColumns(
		// 原始行可含ANSI，用显示宽/字素区间计算。
		line: string,
		// 本行在selection所用坐标系的行号。
		row: number,
		// 已经规范前后顺序的选择两端。
		selection: { start: SelectionPoint; end: SelectionPoint },
		// 可选最左允许列，缺省0，用于屏内选择裁剪。
		minColumn = 0,
		// 最右排他列缺省为整行显示宽，默认表达式每次调用按本次line计算。
		maxColumn = visibleWidth(line),
		// 返回类型只约束字段为number，不保证start<end，调用方要判断空交集。
	): { start: number; end: number } {
		// 测原行显示列宽。
		const lineWidth = visibleWidth(line);
		// 中间行默认从允许最左列开始，至少不负。
		let start = Math.max(0, minColumn);
		// 中间行默认到行尾/允许最右列较小值。
		let end = Math.min(lineWidth, maxColumn);
		// 选择起行需按起点字素吸附，不能直接从行首选起。
		if (row === selection.start.row) {
			// 起点所处格的字素取左界，没字素则最多行宽处；??保留有效0。
			start = getGraphemeCellRange(line, selection.start.col)?.start ?? Math.min(selection.start.col, lineWidth);
		}
		// 选择末行需计算末点包含范围。
		if (row === selection.end.row) {
			// 末端是格间排他边界时，不额外纳入下一个字素。
			end = selection.end.boundary
				? // boundary末列只夹行宽。
					Math.min(selection.end.col, lineWidth)
				: // 普通格末端取整个字素右界，无字素则尝试col+1并夹行尾，保证通常含鼠标指着的格。
					(getGraphemeCellRange(line, selection.end.col)?.end ?? Math.min(selection.end.col + 1, lineWidth));
		}
		// 最终再夹允许横向范围，可能出现end<=start，由调用方跳过/截空。
		return { start: Math.max(minColumn, start), end: Math.min(maxColumn, end) };
	}

	// 从选择范围提取纯文本，返回非空string或undefined，不改端点/输入；逐行严格切列、去ANSI、trimEnd后用LF拼接。
	// 例拖两行得到alpha、换行、beta，行尾空白不复制，不直接访问系统剪贴板。
	private getActiveSelectionText(): string | undefined {
		// 先规范选择范围。
		const selection = this.getSelectionBounds();
		// 无非零同来源范围立即undefined。
		if (!selection) return undefined;
		// 无ScrollView来源时从上一帧可见屏行取，readonly约束本函数不修改数组。
		let sourceLines: readonly string[] = this.previousScreen;
		// 有滚动来源就必须找对应完整内容，允许复制已滚出可见区的选择。
		if (selection.start.scrollView) {
			// 布局已失效就放弃，而不是按内容row误读屏幕行。
			if (!this.currentLayout) return undefined;
			// 查此ScrollView在当前帧的盒子。
			const box = getScrollViewBox(this.currentLayout, selection.start.scrollView);
			// 没有完整内容行不生成复制文本。
			if (!box?.scrollContentLines) return undefined;
			// 改用完整内容引用，不先做全量数组复制。
			sourceLines = box.scrollContentLines;
		}
		// 只收本次选择涉及行的文本。
		const lines: string[] = [];
		// 含首末行逐行提取，多行选择保留中间换行。
		for (let row = selection.start.row; row <= selection.end.row; row++) {
			// 来源越界行按空字符串。
			const line = sourceLines[row] ?? "";
			// 计算本行选择起/末列，含字素吸附。
			const columns = this.getSelectionColumns(line, row, selection);
			// 把下方处理后的单行文字追加结果。
			lines.push(
				// 切片后剥已识别控制序列，输出纯文字。
				stripTerminalSequences(
					// 按显示列严格切本段，长度至少0，避免截半个宽字。
					sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true),
					// trimEnd去这一行末尾JS空白，包含空格/tab等；不去行首空白。
				).trimEnd(),
			);
		}
		// 选中行用LF连接，不还原终端软折行对应的原始业务段落。
		const text = lines.join("\n");
		// 整个结果空串则undefined；只含跨行LF等非零长度时仍可返回文本。
		return text.length === 0 ? undefined : text;
	}

	// 内部自动复制包装器，返回Promise<boolean>；先提取当前选择，无内容false，有内容委托具体复制路径。例鼠标释放触发，拒绝/写入异常不在这里捕获。
	private async copySelectionToClipboard(): Promise<boolean> {
		// 按当前最新布局/屏幕快照取纯选择文本。
		const text = this.getActiveSelectionText();
		// 没有非空文本就不显示Copied提示或写OSC52。
		if (!text) return false;
		// 返回并采纳下游Promise，async不等于自动吞掉失败。
		return this.copyTextToClipboard(text);
	}

	// 复制给定text并给flash反馈，返回Promise<boolean>；优先await宿主copySelection，只有true成功，失败string/false显示详细/通用错误。
	// 缺宿主回调则把UTF-8文本base64封装OSC52写终端，直接提示Copied并返回true；这只能确认write没同步抛错，不能证明系统剪贴板实际更新。
	// 回调拒绝、write/flash异常会使Promise拒绝，没有通用catch；例如测试可注入数组push回调替代真实系统操作。
	private async copyTextToClipboard(text: string): Promise<boolean> {
		// Prefer an injected clipboard implementation (native clipboard + platform tools with a
		// verified success path) when the host app provides one. A bare OSC 52 write can show
		// "Copied!" while leaving the system clipboard untouched (e.g. macOS Terminal.app, tmux
		// without OSC 52 clipboard passthrough), so only report success when it actually copies.
		// 存在注入实现就不再使用OSC52备用路径。
		if (this.copySelection) {
			// await等待宿主完成，返回string是失败说明，拒绝会中断而不是自动退OSC52。
			const result = await this.copySelection(text);
			// 严格true才算ok，非空字符串不会因真值而误当成功。
			const ok = result === true;
			// 发起提示，提示本身改内存栈并排帧，不是打印独立console日志。
			this.flash(
				// 成功固定Copied，失败string原样显示，其他结果用Copy failed；不对错误文案做转义。
				ok ? "Copied!" : typeof result === "string" ? result : "Copy failed",
				// 成功undefined沿用flash默认时长，失败用5000ms。
				ok ? undefined : COPY_ERROR_FLASH_DURATION_MS,
			);
			// 返回宿主确认对应的boolean。
			return ok;
		}
		// 缺回调时实际向Terminal写OSC52;c;base64 BEL，Buffer.from默认UTF-8，测试Terminal只收进内存。
		this.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		// 没有读取终端确认就显示成功提示，这是备用协议路径的实际语义。
		this.flash("Copied!");
		// write/flash正常返回即true，不表示系统已验证复制成功。
		return true;
	}

	// 对匹配text的普通文字片段调用当前/非当前搜索样式，保留ANSI原串并返回新string，无终端IO；例彩色文字按控制序列分段着色，用户style异常传播，扫描下标是UTF-16但不在普通文字内部切字素高亮边界。
	private applySearchTextHighlight(text: string, current: boolean): string {
		// 根据current选择构造时保存的样式函数，不在此调用它。
		const style = current ? this.searchCurrentMatchStyle : this.searchMatchStyle;
		// 累积新结果。
		let result = "";
		// 尚未着色的普通片段起始码元下标。
		let plainStart = 0;
		// 当前扫描位置，按UTF-16码元推进。
		let index = 0;
		// 扫描到字符串末尾，控制串作为整体越过。
		while (index < text.length) {
			// 判断当前位置是否有支持的完整ANSI序列。
			const ansi = extractAnsiCode(text, index);
			// 普通码元先只移动index，不逐码元调用style。
			if (!ansi) {
				// 继续累计普通片段。
				index += 1;
				// 到下一轮找控制串或末尾。
				continue;
			}
			// 遇ANSI前若有普通文字，整体交style一次，可保留普通片段中成对代理/组合字。
			if (index > plainStart) result += style(text.slice(plainStart, index));
			// 控制串原样拼回，不把样式函数包进ANSI载荷。
			result += ansi.code;
			// 越过整串ANSI长度。
			index += ansi.length;
			// 下一普通片段从控制串后开始。
			plainStart = index;
		}
		// 末尾剩余普通片段再着色一次。
		if (plainStart < text.length) result += style(text.slice(plainStart));
		// 返回着色串，未保证外部style保持原显示宽。
		return result;
	}

	// 把活动搜索匹配投影成屏内列区间并着色，返回原screen或浅复制新数组，不写终端；二分跳过屏前结果、按clip/滚动条裁剪、每行从右向左加高亮，图片行跳过。例跨行结果各片段分别显示，回调异常传播。
	private applySearchHighlights(screen: string[], layout: LayoutFrame): string[] {
		// 获取搜索状态。
		const search = this.activeSearch;
		// 没有有效选中/匹配则无需着色，返回原数组。
		if (!search || search.selectedIndex < 0 || search.matches.length === 0) return screen;
		// 本轮主ScrollView优先，不用旧currentLayout。
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		// 取主区盒子定位内容到屏幕坐标。
		const box = getScrollViewBox(layout, scrollView);
		// 主区没盒子不猜高亮位置。
		if (!box) return screen;

		// Map按屏幕行组织若干搜索区间，便于一行一次合成。
		const rangesByRow = new Map<number, SearchHighlightRange[]>();
		// 可见滚动条列作为高亮右侧排他界，避免覆盖条。
		const scrollbarColumn = getScrollbarGeometry(box)?.column;
		// 可画顶部取屏幕0/盒顶/clip顶最大值。
		const minRow = Math.max(0, box.rect.y, box.clip.y);
		// 可画末行使用排他边界，取屏幕行数、盒底、clip底最小。
		const maxRow = Math.min(screen.length, box.rect.y + box.rect.height, box.clip.y + box.clip.height);
		// 可画最左列取屏幕0/盒左/clip左最大。
		const minColumn = Math.max(0, box.rect.x, box.clip.x);
		// 最右排他列由下面四项共同限制。
		const maxColumn = Math.min(
			// 不超终端列数。
			this.terminal.columns,
			// 不超盒子右界。
			box.rect.x + box.rect.width,
			// 不超祖先clip右界。
			box.clip.x + box.clip.width,
			// 有滚动条就避开它，无则Infinity不额外限制。
			scrollbarColumn ?? Number.POSITIVE_INFINITY,
		);
		// 把屏内可画顶部映射成完整内容首行。
		const minContentRow = scrollView.scrollTop + minRow - box.rect.y;
		// 屏内排他末界转为内容包含末行。
		const maxContentRow = scrollView.scrollTop + maxRow - box.rect.y - 1;
		// 二分搜索左界0。
		let low = 0;
		// 右界为全部匹配长度，不含此索引。
		let high = search.matches.length;
		// 找第一个终片段没有早于可见内容首行的匹配，避免每帧扫全文旧结果。
		while (low < high) {
			// 计算整型中点。
			const middle = low + Math.floor((high - low) / 2);
			// !仅声明中点有效，取匹配引用。
			const match = search.matches[middle]!;
			// 末片段行代表该结果最晚涉及行，空片段按-1。
			const lastRow = match.segments[match.segments.length - 1]?.row ?? -1;
			// 结果全在视口上方，左界越过它。
			if (lastRow < minContentRow) low = middle + 1;
			// 否则右界保留middle，继续找更早候选。
			else high = middle;
		}
		// 从二分结果开始向后遍历可能可见匹配。
		for (let matchIndex = low; matchIndex < search.matches.length; matchIndex++) {
			// 按有效索引取一项，类型非空断言不生成运行时检查。
			const match = search.matches[matchIndex]!;
			// 首片段已越过可见内容末行，后续有序结果也不用再看。
			if ((match.segments[0]?.row ?? 0) > maxContentRow) break;
			// 跨行匹配每个片段单独投影/裁剪。
			for (const segment of match.segments) {
				// 盒子屏内起行+片段内容行-scrollTop=屏幕行。
				const row = box.rect.y + segment.row - scrollView.scrollTop;
				// 屏外或clip外的行跳过。
				if (row < minRow || row >= maxRow) continue;
				// 内容列加盒子左界，夹最左允许列。
				const startCol = Math.max(minColumn, box.rect.x + segment.startCol);
				// 同理末列夹到右允许界，避滚动条。
				const endCol = Math.min(maxColumn, box.rect.x + segment.endCol);
				// 横向无正交集就跳过。
				if (endCol <= startCol) continue;
				// 取这一屏幕行已收区间，首次新建数组。
				const ranges = rangesByRow.get(row) ?? [];
				// 保存裁剪后左右界及是否当前选中结果，决定样式。
				ranges.push({ startCol, endCol, current: matchIndex === search.selectedIndex });
				// 把新建/追加后的数组记回Map。
				rangesByRow.set(row, ranges);
			}
		}

		// 浅复制screen，输入数组容器不修改。
		const result = [...screen];
		// 逐行取高亮区间列表。
		for (const [row, ranges] of rangesByRow) {
			// 取该行原文，缺项空串。
			let line = result[row] ?? "";
			// 图片报文不切片/着色。
			if (isImageLine(line)) continue;
			// 记录原行显示宽度，正常样式回调应不改变它。
			const lineWidth = visibleWidth(line);
			// 区间按起列降序原地排序，从右向左处理，先加的ANSI不改变左区显示定位。
			for (const range of ranges.sort((a, b) => b.startCol - a.startCol)) {
				// 起列最多原行宽，防超行尾。
				const startCol = Math.min(range.startCol, lineWidth);
				// 末列同样最多行宽。
				const endCol = Math.min(range.endCol, lineWidth);
				// 夹完无内容就不加空样式。
				if (endCol <= startCol) continue;
				// 严格取高亮之前的左片段。
				const before = sliceByColumn(line, 0, startCol, true);
				// 严格取目标列范围的文字/必要前置ANSI。
				const highlighted = sliceByColumn(line, startCol, endCol - startCol, true);
				// 取右片段，剩余长度不负。
				const after = sliceByColumn(line, endCol, Math.max(0, lineWidth - endCol), true);
				// 左原文+按current样式处理的匹配段+右原文构成新行；不是更新业务文本。
				line = `${before}${this.applySearchTextHighlight(highlighted, range.current)}${after}`;
			}
			// 把这一行最终高亮结果写到新数组。
			result[row] = line;
		}
		// 返回新屏幕行，后续浮层/选择仍可再覆盖。
		return result;
	}

	// 给选择text持续加反色，遇任何识别出的以m结束控制串再补反色，返回新string无IO；例原文SGR0会关反色，补SGR7让剩余选择继续亮，不验证任意控制串的完整SGR语义。
	private applySelectionHighlight(text: string): string {
		// 先开启反色。
		let result = "\x1b[7m";
		// 扫描下标是UTF-16码元。
		let index = 0;
		// 普通码元原样拼，完整ANSI整体保留。
		while (index < text.length) {
			// 查当前是否支持的控制序列。
			const ansi = extractAnsiCode(text, index);
			// 不是ANSI就复制一个码元，完整循环通常会把代理对两码元都按原序带回。
			if (!ansi) {
				// 追加当前普通码元，不把index误作显示列。
				result += text[index];
				// 推进一码元。
				index += 1;
				// 继续扫描后续。
				continue;
			}
			// ANSI原样带回结果。
			result += ansi.code;
			// 以m结尾就重开SGR7，包括SGR27关闭伪光标之后；判断比严格“只匹配SGR复位”更宽。
			if (ansi.code.endsWith("m")) result += "\x1b[7m";
			// 按整段控制序列长度前进。
			index += ansi.length;
		}
		// 结尾SGR27关闭选择反色，不改输入text。
		return `${result}\x1b[27m`;
	}

	// 将当前选择映射到screen对应屏内区域并加反色，返回原数组或新数组，无终端写入；layout默认取调用时currentLayout，doRender可传本轮新布局。
	// 例滚动内容第10行选择，scrollTop8且盒顶2时高亮屏幕第4行；按盒子/clip裁剪，图片行跳过，端点吸附完整字素。
	// 只改变显示字符串，不改变组件原始文本/选择端点；后面flash仍可盖住选择高亮，超出可见窗口的选择仅复制时读完整内容。
	private applySelection(screen: string[], layout = this.currentLayout): string[] {
		// 取得非零同来源、已按行列排序的选择。
		const selection = this.getSelectionBounds();
		// 无选择直接返回screen原引用。
		if (!selection) return screen;
		// 纯屏幕选择可直接用端点，滚动来源则在下面转换为新屏幕端点。
		let screenSelection = selection;
		// 默认可高亮最早屏幕行0。
		let minRow = 0;
		// 默认包含末行是screen.length-1。
		let maxRow = screen.length - 1;
		// 默认最左显示列0。
		let minColumn = 0;
		// 默认最右排他列为终端宽。
		let maxColumn = this.terminal.columns;
		// 选择属于滚动内容时需要本轮几何才能定位。
		if (selection.start.scrollView) {
			// 布局失效时不猜位置，保持原屏字符串。
			if (!layout) return screen;
			// 按选择来源ScrollView找盒子，不无条件用主区。
			const box = getScrollViewBox(layout, selection.start.scrollView);
			// 这个ScrollView已不在本帧时不画其旧选择。
			if (!box) return screen;
			// 顶部高亮界取屏顶、盒顶、clip顶最大值。
			minRow = Math.max(0, box.rect.y, box.clip.y);
			// 底部包含界取屏末/盒末/clip末最小值。
			maxRow = Math.min(screen.length - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
			// 最左显示列受屏幕/盒子/clip约束。
			minColumn = Math.max(0, box.rect.x, box.clip.x);
			// 最右排他列受三者约束；这里未像搜索高亮单独排除滚动条列。
			maxColumn = Math.min(this.terminal.columns, box.rect.x + box.rect.width, box.clip.x + box.clip.width);
			// 创建新屏幕坐标选择，不回写内容端点。
			screenSelection = {
				// 转换起点。
				start: {
					// 保留原点的scrollView/boundary等元数据。
					...selection.start,
					// 盒顶+起内容行-scrollTop得到屏幕行。
					row: box.rect.y + selection.start.row - selection.start.scrollView.scrollTop,
					// 盒左+内容显示列得到屏幕列。
					col: box.rect.x + selection.start.col,
				},
				// 转换末点。
				end: {
					// 保留末端排他边界标志等字段。
					...selection.end,
					// 同一来源scrollTop映射末内容行。
					row: box.rect.y + selection.end.row - selection.start.scrollView.scrollTop,
					// 末列也平移盒子左界。
					col: box.rect.x + selection.end.col,
				},
			};
		}
		// map新建行数组，回调对每个screen行决定保留/高亮。
		return screen.map((line, row) => {
			// 下方||任一成立都跳过本行，不进入文本切片。
			if (
				// 在来源可见区域上方。
				row < minRow ||
				// 在来源可见区域下方。
				row > maxRow ||
				// 在选择起行之前。
				row < screenSelection.start.row ||
				// 在选择末行之后。
				row > screenSelection.end.row ||
				// 行内含图片前缀，不能用普通反色文本处理。
				isImageLine(line)
			) {
				// 保留原行字符串。
				return line;
			}
			// 测该屏幕行的显示宽供右片段长度。
			const lineWidth = visibleWidth(line);
			// 取得本行选择列，并夹本来源横向可见范围。
			const columns = this.getSelectionColumns(line, row, screenSelection, minColumn, maxColumn);
			// 无正列区间就不追加空反色序列。
			if (columns.end <= columns.start) return line;
			// 严格保留选择前文本/必要ANSI。
			const before = sliceByColumn(line, 0, columns.start, true);
			// 严格提取所选列，跨边界放不下的宽字整体跳过。
			const selected = sliceByColumn(line, columns.start, columns.end - columns.start, true);
			// 取选择后剩余文本，长度至少0。
			const after = sliceByColumn(line, columns.end, Math.max(0, lineWidth - columns.end), true);
			// 只给selected部分加持续反色，再拼左右片段，新串不写回源组件。
			return `${before}${this.applySelectionHighlight(selected)}${after}`;
		});
	}

	// 识别仍像SGR或固定长度X10鼠标外壳的串，返回boolean无IO/解析状态修改；例不支持的X10按钮也可吞掉，避免控制串进编辑器，不验证所有按钮数值语义。
	private isMouseSequence(data: string): boolean {
		// SGR要求完整数字形状，或恰6码元且ESC[M开头；||命中短路，X10不核查后3码元的合法范围。
		return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || (data.length === 6 && data.startsWith("\x1b[M"));
	}

	// 必要时将跳到末尾文案合成在主区clip最末行中间，返回原screen或浅复制新数组并更新点击矩形；例用户上滚离末尾时出现，回底消失，无终端IO，文案回调可抛错。
	private compositeScrollToEndIndicator(screen: string[], layout: LayoutFrame, width: number): string[] {
		// 每次先清旧点击区，即使下面提前返回也不会沿用旧按钮矩形。
		this.scrollToEndIndicatorRect = undefined;
		// 本轮布局主区优先，缺省隐式区。
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		// 没配置文案、不支持followEnd、或已跟末尾都不用显示。
		if (!this.scrollToEndIndicator || !scrollView.followEnd || scrollView.isFollowingEnd) return screen;
		// 取主区布局盒子。
		const box = getScrollViewBox(layout, scrollView);
		// 只在盒子当前裁剪可见区放按钮。
		const clip = box?.clip;
		// 没有正宽高clip就无位置，保持原screen。
		if (!clip || clip.width <= 0 || clip.height <= 0) return screen;
		// 提示所在行是clip底部包含行。
		const row = clip.y + clip.height - 1;
		// 行超screen或已是图片行则不覆盖；未统一验证所有异常负几何。
		if (row >= screen.length || isImageLine(screen[row] ?? "")) return screen;
		// 可见滚动条列作右界，避免按钮文字/点击遮住它。
		const scrollbarColumn = box ? getScrollbarGeometry(box)?.column : undefined;
		// 调用动态文案并先截到完整clip宽，空省略号不添加额外字符。
		const label = truncateToWidth(this.scrollToEndIndicator(), clip.width, "");
		// 测第一遍文案实际显示宽。
		const labelWidth = visibleWidth(label);
		// 按完整clip居中，所以auto滚动条出现/隐藏不会改变居中参考；奇数差向下取整。
		const column = clip.x + Math.floor((clip.width - labelWidth) / 2);
		// 有滚动条就以其列为排他右界，否则clip右界。
		const rightEdge = scrollbarColumn ?? clip.x + clip.width;
		// 从已算起列到右界的可用宽至少0。
		const availableWidth = Math.max(0, rightEdge - column);
		// 再裁到不侵入滚动条的实际可用宽，保持起列不重新居中。
		const text = truncateToWidth(label, availableWidth, "");
		// 取得最后实际可点击文字宽。
		const textWidth = visibleWidth(text);
		// 没有可见文字就不建立矩形。
		if (textWidth === 0) return screen;
		// 复制数组容器，只修改提示所在行。
		const result = [...screen];
		// 按固定显示起列/文字宽合成，左右样式隔离由compositeTuiLine处理。
		result[row] = compositeTuiLine(result[row] ?? "", text, column, textWidth, width);
		// 保存最终文字命中区，不把整行空白也当按钮。
		this.scrollToEndIndicatorRect = { row, column, width: textWidth };
		// 返回叠提示后的新屏。
		return result;
	}

	// 把最新能放进height的flash提示右对齐叠到屏顶，返回原screen或新数组，无终端IO；例两条提示从上到下叠，过多时丢较旧显示行但其计时器仍由提示栈管理，图片底行由合成器保护。
	private compositeFlashes(screen: string[], width: number, height: number): string[] {
		// 先让提示组件按width渲染，再取末height条，也就是最新一组，不在这里删除提示记录。
		const flashLines = this.flashes.render(width).slice(-height);
		// 没有提示行直接返回原屏。
		if (flashLines.length === 0) return screen;
		// 复制数组容器以免改输入screen。
		const result = [...screen];
		// 不足屏高补空行，便于按row合成。
		while (result.length < height) result.push("");
		// 留下的提示从屏幕第0行起按原追加顺序显示。
		for (let row = 0; row < flashLines.length; row++) {
			// !是已知循环范围的TS非空断言，取提示行。
			const line = flashLines[row]!;
			// 测这一提示实际显示宽，不用码元长度。
			const flashWidth = visibleWidth(line);
			// 零宽提示不合成。
			if (flashWidth === 0) continue;
			// 起列=终端宽-提示宽，右对齐覆盖相应列区，含图片的底行会被公共合成器保留。
			result[row] = compositeTuiLine(result[row] ?? "", line, width - flashWidth, flashWidth, width);
		}
		// 返回新合成数组，提示可能盖住搜索/选择等前一层画面。
		return result;
	}

	// 生成并输出全屏一帧：布局→刷新搜索必要时再布局→伪光标/搜索/末尾提示/浮层/选择/flash合成→提光标/规范截宽→决定整绘或变行/图片重绘→一次write→保存成功帧。
	// 例普通光标闪动只改少数行，滚动让整窗口行变化；WezTerm有Kitty图时先擦行/写文字再放图，避免后写文字擦掉已放图。
	// 会调用组件/样式回调、修改ScrollView和图片本地估计、写终端；部分状态在write前已改，无失败回滚或远端确认。
	// 与主屏不同，此处拼一个完整buffer再一次write，不分块；即使没有正文变化仍可能输出同步开关/光标码，不是零IO保证。
	protected override doRender(): void {
		// 已stop或尚未执行进入备用屏钩子就不画；只new不start时renderNow会走到此门禁。
		if (this.stopped || !this.altScreenActive) return;
		// 终端宽至少1，真正renderLayoutFrame内部还会floor；正常适配器给整数正尺寸。
		const width = Math.max(1, this.terminal.columns);
		// 终端高同理，后续按这个height循环。
		const height = Math.max(1, this.terminal.rows);
		// 独立layoutRoot优先，否则隐式跟末尾ScrollView包children。
		const root = this.layoutRoot ?? this.implicitScrollView;
		// 生成本轮布局/可见行，回调未来请求下一帧；此调用本身可运行组件render、更新滚动边界。
		let nextLayout = renderLayoutFrame(root, width, height, () => this.requestRender());
		// 搜索导航若实际改变scrollTop，需要按新位置再布局。
		if (this.refreshSearch(nextLayout)) {
			// 本帧最多这里再做一次renderLayoutFrame，没有无限循环直到所有状态稳定。
			nextLayout = renderLayoutFrame(root, width, height, () => this.requestRender());
		}
		// Resolve fake cursors before highlighting and compositing, which only track SGR codes
		// 先逐行剥行首OSC133，再把伪光标标记转SGR/按设置去包裹；不在此处理浮层自身行首标记。
		let screen = this.resolveFakeCursors(nextLayout.lines.map((line) => line.replace(OSC133_ZONE_PREFIX, "")));
		// 主区搜索结果高亮作为较底层内容。
		screen = this.applySearchHighlights(screen, nextLayout);
		// 主区跳到末尾按钮再覆盖在内容上。
		screen = this.compositeScrollToEndIndicator(screen, nextLayout, width);
		// 通用浮层覆盖之后，隐藏/非捕获规则由基类处理，也更新最近鼠标浮层矩形。
		screen = this.compositeOverlays(screen, width, height);
		// 通用浮层工作区可能被撑高，最后只保留末height行作为全屏画面。
		if (screen.length > height) screen = screen.slice(screen.length - height);
		// 按本轮布局投影选择再反色，顺序在浮层之后，纯屏幕选择可涉及浮层文字。
		screen = this.applySelection(screen, nextLayout);
		// 短暂提示最上层，仍受图片行保护。
		screen = this.compositeFlashes(screen, width, height);

		// 提取并删除可见底部首个光标标记，得到0基屏幕行/显示列；不清所有其他标记。
		const cursorPos = this.extractCursorPosition(screen, height);
		// 先原地规范普通行并加重置，再map给超宽普通行裁剪，构建最终比较数组。
		screen = this.applyLineResets(screen).map((line) => {
			// 图片报文/已不超宽普通行直接保留，不对图片载荷按显示列切。
			if (isImageLine(line) || visibleWidth(line) <= width) return line;
			// 超宽普通行严格取前width列，丢放不下的宽字；不是主屏那样写崩溃日志抛超宽错误。
			return sliceByColumn(line, 0, width, true);
		});

		// 下面多行条件决定是否清屏整绘，与是否有某一行正文变化分开。
		const fullRedraw =
			// 旧屏空、列变或行高变任一成立即整绘；强制reset清旧屏也会进入。
			this.previousScreen.length === 0 || this.previousScreenWidth !== width || this.previousScreenHeight !== height;
		// 逐行比较最终原始串，ANSI差异也算变化；这里长度通常为布局屏高。
		const changedRows = screen.map((line, row) => line !== this.previousScreen[row]);
		// 判断变化行是否本身新/旧含图片锚点，下一行是some回调。
		const imageAnchorsNeedRedraw = screen.some(
			// 行变化且任一侧是图片行就需要重放图片；旧数组缺项按空串。
			(line, row) => changedRows[row] && (isImageLine(line) || isImageLine(this.previousScreen[row] ?? "")),
		);
		// 按WEZTERM_PANE真值或TERM_PROGRAM小写精确名识别，空环境值与未定义不同但Boolean空串为false，不向终端探测。
		const isWezTerm = Boolean(process.env.WEZTERM_PANE) || process.env.TERM_PROGRAM?.toLowerCase() === "wezterm";
		// 额外检查WezTerm中图片覆盖的非锚点行是否变化，下面&&全部满足才扫描。
		const imageCellsNeedRedraw =
			// 锚点已要求重绘就不用再算覆盖区。
			!imageAnchorsNeedRedraw &&
			// 只启用WezTerm专用行为。
			isWezTerm &&
			// 只针对启动协议kitty。
			this.imageProtocol === "kitty" &&
			// 至少一行变化才需要额外覆盖扫描，some(Boolean)只测变更布尔值。
			changedRows.some(Boolean) &&
			// 扫描屏幕图片行对应的覆盖区域。
			screen.some((line, row) => {
				// 读头部r或已登记行数，不扫描图像载荷。
				const placementRows = getKittyImagePlacementRows(line);
				// 无可识别行数就不认为有覆盖区。
				if (placementRows === undefined) return false;
				// 从锚点行到row+覆盖行数前逐行检查，可能超屏数组末尾，越界changedRows值自然undefined。
				for (let coveredRow = row; coveredRow < row + placementRows; coveredRow++) {
					// 任意被图覆盖的行发生文字等变化，就需要重放图片。
					if (changedRows[coveredRow]) return true;
				}
				// 本图覆盖区没有变化，some继续下一行。
				return false;
			});
		// 锚点变或WezTerm覆盖格变任一足以触发图片重绘。
		const imagesNeedRedraw = imageAnchorsNeedRedraw || imageCellsNeedRedraw;
		// 整绘也必须处理图片，所以与imagesNeedRedraw再取或。
		const redrawImages = fullRedraw || imagesNeedRedraw;
		// 在prepare修改Map前记录是否曾有本地上传图，决定整绘清放置还是释放全部。
		const hadUploadedKittyImages = this.uploadedKittyImages.size > 0;
		// 选择本轮用于实际写出的图片行及淘汰删除串。
		const preparedKittyScreen =
			// 只有要重绘图片且协议kitty时才运行上传复用准备。
			redrawImages && this.imageProtocol === "kitty"
				? // 可能把完整传输行换placement，并在write前更新本地Map/淘汰。
					this.prepareKittyScreen(screen)
				: // 其他情况直接用screen原引用及空删除串，不操作上传估计。
					{ lines: screen, evictedImageDeletion: "" };

		// 建立整帧buffer，先包同步输出开始码；不同于主屏分块写入。
		let buffer = BEGIN_SYNCHRONIZED_OUTPUT;
		// 整绘路径需要清可见屏，并处理旧图片。
		if (fullRedraw) {
			// 先累计整绘尝试，write失败不会扣回。
			this.fullRedrawCount += 1;
			// 下面三元决定图清理策略。
			const clearImages =
				// kitty且准备前已有上传记录，说明可尝试保留数据复用。
				this.imageProtocol === "kitty" && hadUploadedKittyImages
					? // 仅删所有放置，不释放数据，后面重放a=p。
						deleteAllKittyPlacements()
					: // 否则按协议删全部Kitty图/数据或空串；首帧kitty可发全删。
						this.deleteKittyImages();
			// 先图清理再CSI2J擦屏，不像主屏这里不清滚动历史也不单独home，后面逐行绝对定位。
			buffer += `${clearImages}\x1b[2J`;
			// 没有整绘但图片受变化影响，也要处理旧放置后重画。
		} else if (imagesNeedRedraw) {
			// iTerm2无法像Kitty仅清放置，因此擦屏；正常Image生成能力在全屏已临时关闭，但原始行仍可能有图。
			if (this.imageProtocol === "iterm2") buffer += "\x1b[2J";
			// kitty则只删放置保留数据，后面prepared行可复用。
			else if (this.imageProtocol === "kitty") buffer += deleteAllKittyPlacements();
		}
		// 追加屏外淘汰图的数据删除串，排在本轮新绘制前。
		buffer += preparedKittyScreen.evictedImageDeletion;

		// WezTerm erases intersecting Kitty image cells when a later row write touches a covered row.
		// Draw image placements after every clear and text write so nothing later intersects them; preserve
		// the existing interleaved output for text-only frames and every other terminal.
		// 下面条件决定WezTerm图片放到文字之后的三遍输出策略。
		const drawKittyImagesLast =
			// 必须本轮要重画图、kitty协议、当前屏有图片前缀且识别为WezTerm。
			redrawImages && this.imageProtocol === "kitty" && screen.some(isImageLine) && isWezTerm;
		// 专用路径先擦全部相关行，再文字、最后图片，避免后写覆盖格抹掉图。
		if (drawKittyImagesLast) {
			// 第一遍逐个视口行发绝对定位/擦行，不画文字。
			for (let row = 0; row < height; row++) {
				// 保留通用跳未变条件；此专用分支进入时redrawImages已真，正常帧fullRedraw/imagesNeedRedraw至少一真，故会处理全部视口行。
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
				// 0基row加1变协议行号，列1起，CSI2K擦整行。
				buffer += `\x1b[${row + 1};1H\x1b[2K`;
			}
			// 第二遍画非图片行。
			for (let row = 0; row < height; row++) {
				// 沿用同一未变跳过条件，与第一遍范围一致。
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
				// 图片报文暂跳过，留到第三遍最后再放。
				if (isImageLine(preparedKittyScreen.lines[row] ?? "")) continue;
				// 绝对定位写文字，缺screen行按空串，擦行已在第一遍完成。
				buffer += `\x1b[${row + 1};1H${preparedKittyScreen.lines[row] ?? ""}`;
			}
			// 第三遍最后放图片。
			for (let row = 0; row < height; row++) {
				// 仍采用同一范围条件。
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
				// 这遍只保留图片行，普通文字已画过。
				if (!isImageLine(preparedKittyScreen.lines[row] ?? "")) continue;
				// 定位图片锚点后写传输/仅放置报文及该行附带文字，避免后续文本行交叠它。
				buffer += `\x1b[${row + 1};1H${preparedKittyScreen.lines[row] ?? ""}`;
			}
		} else {
			// 普通终端/无图等路径按行交错擦+写，不启WezTerm三遍策略。
			for (let row = 0; row < height; row++) {
				// 不需整绘/图重绘且此行原串未变则跳过，减少终端正文写入。
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
				// 每个要写的行绝对定位、擦行、追加prepared内容；缺项空串清掉旧残留。
				buffer += `\x1b[${row + 1};1H\x1b[2K${preparedKittyScreen.lines[row] ?? ""}`;
			}
		}

		// 有真实光标定位标记才指定行列；提取发生在最终超宽裁剪之前。
		if (cursorPos) {
			// 行/列转1基；这里列先min(width,col)再+1，因此col=width可请求width+1，最终边界行为由终端处理，不等于严格夹到最后一列。
			buffer += `\x1b[${cursorPos.row + 1};${Math.min(width, cursorPos.col) + 1}H`;
			// 按配置发显示或隐藏光标码，定位与是否可见是两件事。
			buffer += this.getShowHardwareCursor() ? "\x1b[?25h" : "\x1b[?25l";
		} else {
			// 没标记则隐藏光标，不猜编辑器位置。
			buffer += "\x1b[?25l";
		}
		// 整帧末尾加同步输出结束码。
		buffer += END_SYNCHRONIZED_OUTPUT;
		// 一次把完整buffer写给Terminal，可能已包含大图片载荷，无分块/远端ack/异常回滚。
		this.terminal.write(buffer);

		// write正常返回后才保存最终逻辑screen，图片行可仍含原传输串而不是实际prepared替换串。
		this.previousScreen = screen;
		// 保存本帧列数供下次整绘判断。
		this.previousScreenWidth = width;
		// 保存本帧高度。
		this.previousScreenHeight = height;
		// 最后保存成功帧布局供后续命中/选择/滚轮使用；布局构建时的ScrollView变化可能更早已发生。
		this.currentLayout = nextLayout;
	}
}
