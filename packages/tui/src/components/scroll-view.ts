// ScrollView 保存纵向滚动偏移与跟随策略，通过符号协议交给 layout.ts 做视口裁剪；普通 render 路径只返回完整内容。
// LAYOUT_NODE 是运行时协议键，ScrollLayoutNode 是仅编译期使用的结构类型。
import { LAYOUT_NODE, type ScrollLayoutNode } from "../layout-node.ts";
// 继承 Container 以兼容组件树和事件路由；Component 仅用于约束传入孩子。
import { type Component, Container } from "../tui.ts";

// 滚动条模式的字符串联合类型：隐藏、交互后暂显、始终显示；声明不进行运行时校验。
export type ScrollViewScrollbar = "hidden" | "auto" | "always";

// 构造选项的接口，? 表示字段可以省略；下面默认值由构造逻辑真正采用。
export interface ScrollViewOptions {
	// 只支持纵向；类型层仅允许 "vertical"，构造时还会拒绝显式传入的其他运行时值。
	axis?: "vertical";
	// 是否在内容增长时跟随末尾，默认 none；这是能力配置，不等于此刻必定正在跟随。
	follow?: "none" | "end";
	// 声明主要滚动视图供布局器选择，不保证所有组件中只有一项为 true。
	primary?: boolean;
	// 给上游的越界策略；当前 routeWheel 遇 contain 会停止命中视图的祖先遍历，但之后仍有主要视图兜底路径，本字段本身不拦截事件。
	overscroll?: "chain" | "contain";
	// 滚动条显示模式，默认 hidden。
	scrollbar?: ScrollViewScrollbar;
	// 给轨道符号加样式的函数，实际由布局绘制阶段调用。
	scrollbarTrackStyle?: (text: string) => string;
	// 给滑块符号加样式的函数。
	scrollbarThumbStyle?: (text: string) => string;
	// auto 条非活跃后多久隐藏，单位毫秒；构造会取整并夹到非负。
	scrollbarHideDelayMs?: number;
}

// 一次绝对滚动调用的可选策略，不改变实例原本是否支持 followEnd。
export interface ScrollViewScrollToOptions {
	/** Keep follow-end disabled even when the target is the current content end. */
	// true 且落在当前末尾时，暂时压住自动跟随，避免下一次布局立刻重新启用；后续滚动操作或离开末尾可改变这个状态。
	disableFollow?: boolean;
}

// 固定只管理一个孩子的滚动壳；配置、偏移、临时条状态都留在实例中，实际几何来自布局器。
export class ScrollView extends Container {
	// 保存唯一内容组件引用；readonly 禁止本字段重赋值，不冻结组件本身。
	private readonly child: Component;
	// 是否配置了末尾跟随能力，创建后固定。
	readonly followEnd: boolean;
	// 主要滚动区域声明，布局器读取。
	readonly primary: boolean;
	// 越界传递策略，本类返回剩余量，上游决定是否继续传。
	readonly overscroll: "chain" | "contain";
	// 轨道样式函数引用；readonly 限制重赋值而非禁止调用。
	readonly scrollbarTrackStyle: (text: string) => string;
	// 滑块样式函数引用。
	readonly scrollbarThumbStyle: (text: string) => string;
	// 当前显示模式可通过 setScrollbar 修改。
	private currentScrollbar: ScrollViewScrollbar;
	// 暂显条隐藏延迟，创建时规范后固定。
	private readonly scrollbarHideDelayMs: number;
	// 当前滚走的顶部行数，0 表示内容顶部。
	private currentScrollTop = 0;
	// 最近布局告诉本层的完整内容高度。
	private contentHeight = 0;
	// 最近布局得到的窗口可见高度。
	private currentViewportHeight = 0;
	// 当前是否正在跟随末尾，可因用户向上滚动而暂停，与固定 followEnd 配置不同。
	private followingEnd: boolean;
	// 即使位于末尾，也先不自动恢复跟随的标记，支持搜索或明确的定位操作。
	private followSuppressedAtEnd = false;
	// 布局器提供的重画请求回调，首次布局前可能没有；函数类型外加 undefined 构成联合类型。
	private requestRenderCallback: (() => void) | undefined;
	// auto 模式交互后是否仍处于暂显阶段。
	private transientScrollbarVisible = false;
	// 是否正在操作滚动条，例如拖动时保持可见并使用活跃滑块。
	private scrollbarActive = false;
	// auto 隐藏任务的句柄，未安排任务时为 undefined。
	private scrollbarHideTimer: NodeJS.Timeout | undefined;

	// 创建单内容滚动组件，输入孩子与可选策略，只保存状态，不立即渲染或滚动。
	// 例：new ScrollView(body, {follow:"end", scrollbar:"auto"}) 初始准备跟随末尾，实际位置需下一次 updateLayout 得到内容高度后确定；不支持的 axis 抛错，构造无显式返回语句。
	constructor(component: Component, options: ScrollViewOptions = {}) {
		// 先初始化 Container 的 children 等字段。
		super();
		// 对运行时选项执行本类已定义的轴策略检查；缺省也允许，只接受显式 vertical。
		if (options.axis !== undefined && options.axis !== "vertical") {
			// 抛出错误终止构造，不静默按其他轴运行。
			throw new Error(`Unsupported ScrollView axis: ${options.axis}`);
		}
		// 保存唯一内容对象。
		this.child = component;
		// 直接加入继承的 children 列表，绕过本类下面会抛错的 addChild 方法。
		this.children.push(component);
		// 缺省 none；只在 follow 为 end 时启用跟随能力。
		this.followEnd = (options.follow ?? "none") === "end";
		// 当前跟随状态初始与能力相同，后面可因交互变化。
		this.followingEnd = this.followEnd;
		// 主要视图默认 false。
		this.primary = options.primary ?? false;
		// 越界默认 chain，允许上游继续处理未消耗滚动量。
		this.overscroll = options.overscroll ?? "chain";
		// 缺省隐藏滚动条，内容仍可由方法滚动。
		this.currentScrollbar = options.scrollbar ?? "hidden";
		// 采用自定义轨道样式，缺省箭头回调把输入符号包成灰色字符串并恢复前景；此行只构造函数，尚未画符号。
		this.scrollbarTrackStyle = options.scrollbarTrackStyle ?? ((text) => `\x1b[90m${text}\x1b[39m`);
		// 同理为默认滑块准备白色样式回调，实际调用在布局绘制中发生。
		this.scrollbarThumbStyle = options.scrollbarThumbStyle ?? ((text) => `\x1b[37m${text}\x1b[39m`);
		// 隐藏延迟缺省 1000，向下取整并夹为非负；不额外检查 NaN/Infinity，定时器仍遵循 Node 行为。
		this.scrollbarHideDelayMs = Math.max(0, Math.floor(options.scrollbarHideDelayMs ?? 1000));
	}

	// 只读访问器返回当前内容偏移，无副作用。例：scrollTop=3 表示顶部三行在窗口上方，不是光标下标。
	get scrollTop(): number {
		// 读取内部保存的偏移值。
		return this.currentScrollTop;
	}

	// 读取当前跟随状态，无副作用；例：配置 followEnd=true 但向上滚动后，此值可为 false。
	get isFollowingEnd(): boolean {
		// 返回动态跟随标志，不返回固定能力开关。
		return this.followingEnd;
	}

	// 读取最近的视口高度，无副作用；例：布局前初始化为 0，updateLayout 后才知道真实行数。
	get viewportHeight(): number {
		// 返回内部高度记录。
		return this.currentViewportHeight;
	}

	// 读取当前滚动条模式，无副作用；例：setScrollbar("always") 后此属性变成 always。
	get scrollbar(): ScrollViewScrollbar {
		// 通过访问器暴露可读模式，不直接暴露赋值入口。
		return this.currentScrollbar;
	}

	// 计算现在是否应画滚动条，返回 boolean，不修改状态。
	// 例：always 有正视口高度就显示；auto 还需内容溢出且暂显标志为真，hidden 则不显示。
	get isScrollbarVisible(): boolean {
		// 始终显示模式也要求可见高度大于 0，不要求内容溢出。
		if (this.scrollbar === "always") return this.currentViewportHeight > 0;
		// 其他模式使用下面的逻辑与条件。
		return (
			// auto、确实溢出、暂显阶段三者共同成立才显示。
			this.scrollbar === "auto" && this.contentHeight > this.currentViewportHeight && this.transientScrollbarVisible
		);
	}

	// 读取滑块是否活跃，无副作用；例：拖动开始调用 setScrollbarActive(true) 后，布局器可使用更宽实心滑块符号。
	get isScrollbarActive(): boolean {
		// 返回交互状态，不代表内容必定发生了移动。
		return this.scrollbarActive;
	}

	// 切换显示模式，返回 void；同模式跳过，否则更新、调整暂显任务并可选请求重画。
	// 例：always 切 auto 时若仍活跃则立即暂显；非活跃时不会凭切换自动启动暂显，首次布局前可能还没有重画回调。
	setScrollbar(scrollbar: ScrollViewScrollbar): void {
		// 模式没变就不重排任务或请求绘制。
		if (scrollbar === this.currentScrollbar) return;
		// 保存新模式。
		this.currentScrollbar = scrollbar;
		// 离开 auto 时关闭暂显标志并清计时器。
		if (scrollbar !== "auto") this.hideTransientScrollbar();
		// 进入 auto 且仍在操作滑块时，按溢出状态标记为可见；不活跃时此分支不执行。
		else if (this.scrollbarActive) this.markScrollbarActivity();
		// 回调存在才请求宿主重画，不直接写终端。
		this.requestRenderCallback?.();
	}

	// 根据当前条模式计算内容列宽，输入总宽、返回列数，无状态修改。
	// 例：always 且总宽 10 返回 9；宽度只有 1 时不再预留，auto 覆盖正文而不占专门一列。
	getContentWidth(width: number): number {
		// 只有始终显示且宽大于 1 才扣一列，其余原样返回。
		return this.scrollbar === "always" && width > 1 ? width - 1 : width;
	}

	// 标记 auto 条发生交互，返回 void：需溢出才暂显，清旧任务，活跃时保持显示，不活跃时重新计时。
	// 例：连续滚动刷新隐藏倒计时；本方法不立即请求重画，调用方负责通知，定时回调会请求一次。
	private markScrollbarActivity(): void {
		// 不是 auto 或内容没超出窗口就不更改暂显任务。
		if (this.scrollbar !== "auto" || this.contentHeight <= this.currentViewportHeight) return;
		// 进入暂显阶段，下一帧可绘制该条。
		this.transientScrollbarVisible = true;
		// 存在旧倒计时才清理。
		if (this.scrollbarHideTimer) {
			// 取消旧隐藏任务，防止先前任务过早收起滚动条。
			clearTimeout(this.scrollbarHideTimer);
			// 清空句柄记录。
			this.scrollbarHideTimer = undefined;
		}
		// 拖动等活跃状态下保持显示，不安排自动隐藏任务。
		if (this.scrollbarActive) return;
		// 注册延时回调，真正隐藏发生在之后；无参回调只清句柄、关暂显并通知重画，异常不在此捕获。
		this.scrollbarHideTimer = setTimeout(() => {
			// 执行任务时先把句柄清空，表示已经没有待运行的隐藏任务。
			this.scrollbarHideTimer = undefined;
			// 结束 auto 暂显阶段。
			this.transientScrollbarVisible = false;
			// 可选通知宿主刷新屏幕。
			this.requestRenderCallback?.();
			// 使用构造时配置的隐藏延迟。
		}, this.scrollbarHideDelayMs);
		// 这个定时器本身不阻止 Node 退出；unref 不等于取消任务。
		this.scrollbarHideTimer.unref();
	}

	// 立即清理暂显标志与未触发的隐藏任务，无参数、无返回值，不主动请求重画。
	// 例：切到 hidden 或内容不再溢出时调用；不会改滚动偏移或活跃标志。
	private hideTransientScrollbar(): void {
		// 无论是否有定时器，先结束暂显阶段。
		this.transientScrollbarVisible = false;
		// 没有句柄就无需再取消任务。
		if (!this.scrollbarHideTimer) return;
		// 取消延时隐藏回调。
		clearTimeout(this.scrollbarHideTimer);
		// 放弃旧句柄引用。
		this.scrollbarHideTimer = undefined;
	}

	// 改变滑块活跃标志，返回 void；相同值跳过，否则更新 auto 显示/倒计时并请求重画。
	// 例：从 true 改 false 会重新开始非活跃隐藏倒计时；不直接滚动内容，回调异常向上传播。
	setScrollbarActive(active: boolean): void {
		// 状态相同则不重复通知。
		if (active === this.scrollbarActive) return;
		// 保存新的交互状态。
		this.scrollbarActive = active;
		// auto 且溢出时决定保持显示或延迟隐藏。
		this.markScrollbarActivity();
		// 首次布局后通常已有此回调，存在才调用。
		this.requestRenderCallback?.();
	}

	// 按绝对顶部行定位，无返回值；规范输入、夹到范围并计算跟随状态，变化时保存状态和通知。
	// 例：内容 100 行、窗口 10 行，scrollTo(200) 夹到 90；{disableFollow:true} 可在末尾暂时停跟随。只改变内存和回调，不写终端；通知异常向上传播且已写状态不会回滚。
	scrollTo(scrollTop: number, options: ScrollViewScrollToOptions = {}): void {
		// 有限数向 0 取整，非有限数沿用当前偏移；负数随后由范围夹取处理。
		const requested = Number.isFinite(scrollTop) ? Math.trunc(scrollTop) : this.currentScrollTop;
		// 最大偏移等于内容超出窗口的部分，最少为 0。
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		// 夹住绝对请求位置到 0..maxScrollTop。
		const next = Math.max(0, Math.min(maxScrollTop, requested));
		// 只有明确 disableFollow=true 且落在末尾，才设“末尾抑制跟随”标志。
		const nextFollowSuppressedAtEnd = options.disableFollow === true && next === maxScrollTop;
		// 未受抑制、支持跟随且已经到末尾，才让下一状态为跟随。
		const nextFollowingEnd = !nextFollowSuppressedAtEnd && this.followEnd && next === maxScrollTop;
		// 三个状态都完全相同才跳过，下面是跨行逻辑与判断。
		if (
			// 比较偏移是否没变。
			next === this.currentScrollTop &&
			// 比较动态跟随状态是否没变。
			nextFollowingEnd === this.followingEnd &&
			// 比较抑制标志是否没变。
			nextFollowSuppressedAtEnd === this.followSuppressedAtEnd
		) {
			// 没有任何状态变化就结束，不请求重画。
			return;
		}
		// 单独记录是否真正移动，只有移动才触发滚动条活动。
		const moved = next !== this.currentScrollTop;
		// 写新偏移。
		this.currentScrollTop = next;
		// 写新跟随状态。
		this.followingEnd = nextFollowingEnd;
		// 写新抑制标志。
		this.followSuppressedAtEnd = nextFollowSuppressedAtEnd;
		// 真实移动时刷新 auto 条活动时间。
		if (moved) this.markScrollbarActivity();
		// 即使仅跟随标志改变，也会请求一次重画。
		this.requestRenderCallback?.();
	}

	// 按相对行数滚动并返回未消耗量，供外层滚动链使用；正数向下、负数向上，更新偏移与跟随状态并按需通知。
	// 例：最多还能下移 2 行而请求 5，返回 3；overscroll 策略由上游决定是否把 3 继续传出去。非有限量按 0，不直接绘制，回调异常向上传播。
	scrollBy(lines: number): number {
		// 有效数向 0 取整；无效数值不产生移动请求。
		const requested = Number.isFinite(lines) ? Math.trunc(lines) : 0;
		// 零请求立即返回 0，不在此顺便改变跟随或抑制标志。
		if (requested === 0) return 0;
		// 基于最近布局尺寸求当前最大偏移。
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		// 正在跟随时从最新末尾算起，否则从已保存偏移算起。
		const start = this.followingEnd ? maxScrollTop : this.currentScrollTop;
		// 将目标位置夹在当前滚动边界内。
		const next = Math.max(0, Math.min(maxScrollTop, start + requested));
		// 实际消耗的行数，方向与请求相同或为 0。
		const moved = next - start;
		// 保存旧动态跟随状态，用于判断是否需要通知。
		const wasFollowingEnd = this.followingEnd;
		// 更新偏移到可达位置。
		this.currentScrollTop = next;
		// 若配置允许且抵达末尾，就恢复动态跟随；其他位置暂停。
		this.followingEnd = this.followEnd && next === maxScrollTop;
		// 相对滚动解除先前“末尾抑制”标记，即使本次碰到边界没有实际移动。
		this.followSuppressedAtEnd = false;
		// 有真实移动才更新 auto 条活动状态。
		if (moved !== 0) this.markScrollbarActivity();
		// 实际移动或跟随状态改变才通知；单独解除抑制标记而前两者不变时不通知。
		if (moved !== 0 || this.followingEnd !== wasFollowingEnd) this.requestRenderCallback?.();
		// 总请求减已消耗量，剩余可以交给父滚动视图，不在此自动传递。
		return requested - moved;
	}

	// 跳到内容开头并按是否全部可见设置跟随，返回 void；状态变化时更新滚动条并通知。
	// 例：内容溢出且 followEnd=true 时跳顶部会暂停跟随；内容完全可见时顶部也是末尾，可继续跟随。始终清除抑制标志，但该标志的单独变化不算 changed。
	scrollToStart(): void {
		// 判断是否要通知，下面两个条件任一成立即视为变化。
		const changed =
			// 原偏移不是顶部。
			this.currentScrollTop !== 0 ||
			// 原动态跟随状态不同于“支持跟随且内容不溢出”。
			this.followingEnd !== (this.followEnd && this.contentHeight <= this.currentViewportHeight);
		// 偏移设为 0。
		this.currentScrollTop = 0;
		// 顶部同时也是末尾时才保持跟随能力的动态状态。
		this.followingEnd = this.followEnd && this.contentHeight <= this.currentViewportHeight;
		// 解除末尾抑制标记。
		this.followSuppressedAtEnd = false;
		// 只有刚才定义的 changed 才发通知。
		if (changed) {
			// 即使偏移未动但跟随变化，也会尝试更新 auto 条活动。
			this.markScrollbarActivity();
			// 可选请求重画。
			this.requestRenderCallback?.();
		}
	}

	// 跳到最近布局所知的末尾，返回 void；恢复配置允许的跟随、解除抑制，偏移/跟随变化时通知。
	// 例：支持 followEnd 时调用后新内容追加会继续跟到底；不支持时只定位一次。抑制标记单独变化仍不计入 changed。
	scrollToEnd(): void {
		// 求当前末尾的顶部偏移。
		const next = Math.max(0, this.contentHeight - this.currentViewportHeight);
		// 只比较偏移与动态跟随是否需要变化。
		const changed = this.currentScrollTop !== next || this.followingEnd !== this.followEnd;
		// 保存末尾位置。
		this.currentScrollTop = next;
		// 动态跟随恢复为固定能力值，不会给 followEnd=false 的实例新增能力。
		this.followingEnd = this.followEnd;
		// 解除先前的末尾抑制。
		this.followSuppressedAtEnd = false;
		// 偏移或跟随变化才执行下面的活动与重画。
		if (changed) {
			// 更新 auto 条暂显状态与倒计时。
			this.markScrollbarActivity();
			// 通知宿主。
			this.requestRenderCallback?.();
		}
	}

	// 由布局器同步尺寸并保存后续重画回调，无返回值；规范高度后跟随末尾或夹取旧偏移，必要时恢复跟随、清理暂显条。
	// 例：内容从 10 行增至 12、窗口 5，正在跟随时 scrollTop 从 5 变 7；此方法本身不调用 requestRender，避免在正在布局时反复请求绘制。
	updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		// 内容高度向下取整且至少为 0，写入本实例。
		this.contentHeight = Math.max(0, Math.floor(contentHeight));
		// 同样记录规范后的视口高度。
		this.currentViewportHeight = Math.max(0, Math.floor(viewportHeight));
		// 保存传来的函数引用，不在这一行执行它。
		this.requestRenderCallback = requestRender;
		// 新尺寸下的最大滚动偏移。
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		// 当前已在跟随就直接移动到新末尾。
		if (this.followingEnd) this.currentScrollTop = maxScrollTop;
		// 不跟随时仍需把旧偏移夹到新边界，内容缩短时不会保留越界位置。
		else this.currentScrollTop = Math.max(0, Math.min(this.currentScrollTop, maxScrollTop));
		// 位置已经不在末尾时解除“末尾抑制”，让以后自然到末尾时可恢复跟随。
		if (this.currentScrollTop < maxScrollTop) this.followSuppressedAtEnd = false;
		// 能力已配置、当前到末尾且未受抑制时，允许动态跟随重新开启。
		if (this.followEnd && this.currentScrollTop === maxScrollTop && !this.followSuppressedAtEnd) {
			// 写入重新开启的状态。
			this.followingEnd = true;
		}
		// 内容完全可见就关闭 auto 暂显并取消它的计时器；always 可见性仍由访问器独立判断。
		if (this.contentHeight <= this.currentViewportHeight) this.hideTransientScrollbar();
	}

	// 禁止额外添加孩子：输入仅为兼容父类签名，始终抛错、无正常返回。例：scroll.addChild(extra) 会失败，内容必须在构造时一次指定。
	override addChild(_component: Component): void {
		// 显式错误维护单内容约束，不把新项追加进去。
		throw new Error("ScrollView has exactly one child");
	}

	// 禁止移除内容，输入参数不使用，始终抛错。例：removeChild(body) 不会清掉 children；override 让 TypeScript 检查父类确有此方法。
	override removeChild(_component: Component): void {
		// 抛错而不是静默忽略，唯一孩子保留。
		throw new Error("ScrollView child cannot be removed");
	}

	// 禁止清空孩子，无参数，始终抛错。例：clear() 不能使 ScrollView 变为空壳，也不会顺便清计时器。
	override clear(): void {
		// 明确拒绝父类的清空操作。
		throw new Error("ScrollView child cannot be cleared");
	}

	// 普通组件渲染入口：按正文列宽渲染唯一孩子，预留条列时给每行补一个空格并返回，不执行滚动裁剪。
	// 例：always 总宽 10 时孩子用 9 列、结果每行再加空格；真正的有限视口偏移/裁剪由 layout.ts 读取下面符号节点完成，孩子异常向上传播。
	override render(width: number): string[] {
		// 按模式决定是否为始终显示的条扣一列。
		const contentWidth = this.getContentWidth(width);
		// 实际调用孩子 render，得到完整内容数组，不按 scrollTop 切片。
		const lines = this.child.render(contentWidth);
		// 不预留时原样返回同数组；预留时 map 创建新数组，各行右侧追加一个空格，不在此画轨道字符。
		return contentWidth === width ? lines : lines.map((line) => `${line} `);
	}

	// 提供布局协议描述，无参数，返回 scroll 节点，不渲染、不修改偏移。
	// 例：getLayoutNode(scroll) 得到其唯一内容和 state=this，布局器随后调用 updateLayout；返回的是描述对象而非已裁剪文本。
	[LAYOUT_NODE](): ScrollLayoutNode {
		// 固定标签供联合类型分支识别，component 指内容对象，state 指当前 ScrollView 实例。
		return { type: "scroll", component: this.child, state: this };
	}
}
