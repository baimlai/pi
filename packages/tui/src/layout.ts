// 把组件树转换成一帧的坐标树与文本行，并提供鼠标命中、滚动条几何查询；本文件不直接写终端。
// 上游如 TuiAltScreen 调用 renderLayoutFrame，随后处理最终输出；下游调用组件 render、Stack 尺寸规则和 ScrollView 状态方法。ScrollView 这里只导入类型。
import type { ScrollView } from "./components/scroll-view.ts";
// 共用主轴尺寸分配与可见性规则，避免布局器和普通 Stack render 各定义一套配置含义。
import { allocateStackSizes, visibleStackEntries } from "./components/stack.ts";
// 读取组件可选的符号协议；有节点描述则递归布局，无描述则按叶子组件处理。
import { getLayoutNode } from "./layout-node.ts";
// 图片行可能含终端图片协议而非普通文字，需通过注册的元数据裁剪，不能直接按字符切片。
import { cropKittyImageLine, getKittyImageMetadata, getMaxKittyImageRows, isImageLine } from "./terminal-image.ts";
// Component 只用于类型检查；CURSOR_MARKER 标记光标行，compositeTuiLine 按终端列合成内容。
import { type Component, CURSOR_MARKER, compositeTuiLine } from "./tui.ts";
// 导入处理 ANSI 与显示列的工具；控制序列长度、字符串字符数、终端列宽是不同概念。
import {
	// 从指定字符串下标读取一个 ANSI 控制序列及其长度。
	extractAnsiCode,
	// 从 ANSI 前缀中恢复当前生效的背景设置。
	getActiveBackgroundAnsi,
	// 查询目标列所在字素占据的完整列范围，例如一个中文字符可能占两列。
	getGraphemeCellRange,
	// 按终端列裁取字符串，保留必要样式，并在严格模式下处理跨边界的宽字符。
	sliceByColumn,
	// 计算字符串实际占用的显示列数，忽略不占列的控制序列。
	visibleWidth,
} from "./utils.ts";

// 匹配行首连续的 OSC 133 A/B/C 区域标记，兼容 BEL 与 ST 结束符；绘制叶子行时移除这些开头标记。
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

// 坐标矩形的类型约定，单位为终端列/行；接口不会在运行时检查非负整数。
export interface LayoutRect {
	// 左边界的全帧列坐标。
	x: number;
	// 上边界的全帧行坐标，滚动后的内容可位于负行。
	y: number;
	// 矩形宽度，零宽表示没有可绘制列。
	width: number;
	// 矩形高度，零高表示没有可绘制行。
	height: number;
}

// 布局后的组件节点；区别于布局协议描述，它已经带有位置、裁剪与测量结果。
export interface LayoutBox {
	// 这个盒子对应的组件对象，用于后续事件派发和查找。
	component: Component;
	// 组件分配到的完整矩形，可能部分落在视口之外。
	rect: LayoutRect;
	// 与祖先可见区域相交后的矩形，限制可见性与命中查询。
	clip: LayoutRect;
	// 本次递归生成的子盒子，顺序也是后续递归绘制的顺序。
	children: LayoutBox[];
	// 可选父节点引用，便于从孩子向上访问；根节点没有父亲。
	parent?: LayoutBox;
	// 普通叶子 render 返回的文本行；readonly 限制通过这个属性写数组，不会深拷贝或冻结。
	lines?: readonly string[];
	// 叶子从哪一条原始文本行开始绘制，用于有限高度下保留光标所在行。
	lineOffset?: number;
	// 滚动节点关联的具体视图对象，供滚动条与事件查询使用。
	scrollView?: ScrollView;
	// 滚动内容的原始渲染行，支持查找视口上方仍跨入屏幕的图片等用途。
	scrollContentLines?: readonly string[];
	// 命中排序使用的层级，本文件新建盒子时都初始化为 0，不会自动按深度增加它。
	layer: number;
}

// 一帧完整布局结果；其中的 lines 尚不是已经写入终端的证明。
export interface LayoutFrame {
	// 完整盒子树的根。
	root: LayoutBox;
	// 规范后的全帧列宽。
	width: number;
	// 规范后的全帧行高。
	height: number;
	// 绘制得到的每行字符串，上游仍可做高亮、光标处理和最终宽度限制。
	lines: string[];
	// 可选的主要滚动视图引用，由递归布局过程选出。
	primaryScrollView?: ScrollView;
}

// 滚动条的几何信息，供绘制与鼠标拖动使用；所有位置是全帧坐标。
export interface ScrollbarGeometry {
	// 滚动条所在的列。
	column: number;
	// 整个轨道的起始行。
	trackTop: number;
	// 轨道占据的行数。
	trackHeight: number;
	// 滑块的起始行。
	thumbTop: number;
	// 滑块自身占据的行数。
	thumbHeight: number;
	// 内容可滚动到的最大 scrollTop，拖动时可把滑块位置映射回内容偏移。
	maxScrollTop: number;
}

// 仅在一次 renderLayoutFrame 中共享的上下文，不是跨帧缓存或全局状态。
interface LayoutContext {
	// 全帧视口尺寸；可见性回调收到的是它，而非每个孩子的局部矩形。
	viewport: { width: number; height: number };
	// 两层 Map：先按组件对象身份，再按列宽缓存 render 行数组；本帧内测量与绘制可复用同一次结果。
	renderCache: Map<Component, Map<number, string[]>>;
	// 由宿主提供的重画请求函数，布局器把它交给滚动状态保存使用。
	requestRender: () => void;
	// 递归过程中选出的主要滚动视图，尚未选出时为 undefined。
	primaryScrollView: ScrollView | undefined;
}

// 求两个矩形的交集，返回新矩形，不修改输入；不重叠的方向宽或高为 0。
// 例：横向范围 [0,5) 和 [3,8) 相交为 [3,5)，右边和下边都采用半开区间。
function intersect(a: LayoutRect, b: LayoutRect): LayoutRect {
	// 交集左边取两者更靠右的位置。
	const x = Math.max(a.x, b.x);
	// 交集上边取两者更靠下的位置。
	const y = Math.max(a.y, b.y);
	// 交集右边取两个右边界中更靠左的一个。
	const right = Math.min(a.x + a.width, b.x + b.width);
	// 交集下边取两个下边界中更靠上的一个。
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	// 返回新对象；差值小于 0 说明不相交，将该方向尺寸夹到 0。
	return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

// 按组件和规范列宽读取本帧缓存，缺失才调用 render 并缓存，返回原行数组引用；会修改 context 缓存，不写终端。
// 例：同一 Text 在本帧两次以 20 列测量只 render 一次；下帧会新建上下文。组件异常向上传播，结果不会深拷贝。
function renderCached(context: LayoutContext, component: Component, width: number): string[] {
	// 列宽先向下取整并至少为 1，缓存键与实际传给组件的参数一致。
	const safeWidth = Math.max(1, Math.floor(width));
	// 按组件对象身份查找内层宽度表。
	let widths = context.renderCache.get(component);
	// 这个组件在本帧还没有表时创建它。
	if (!widths) {
		// Map<number, string[]> 在编译期限定键值类型，不会校验组件返回的文本内容。
		widths = new Map<number, string[]>();
		// 将宽度表登记在当前帧，之后相同组件对象可复用。
		context.renderCache.set(component, widths);
	}
	// 查找此宽度下的行数组。
	let lines = widths.get(safeWidth);
	// 没有缓存结果才渲染；空数组是 truthy，已有空结果不会反复渲染。
	if (!lines) {
		// 这里实际执行组件渲染，返回行数组但不要求组件自己写终端。
		lines = component.render(safeWidth);
		// 保存这组数组引用供本帧后续测量/绘制使用。
		widths.set(safeWidth, lines);
	}
	// 返回测得或缓存的行数组。
	return lines;
}

// 测量组件在指定列宽下的自然高度，返回 render 行数，无额外绘制；可能填充本帧缓存。
// 例：render 返回三行就测得 3；组件异常经 renderCached 向上传播。
function measureHeight(context: LayoutContext, component: Component, width: number): number {
	// 复用本帧缓存，数组长度直接作为高度，不按字符串中隐藏内容重新计数。
	return renderCached(context, component, width).length;
}

// 测量组件各行的最大显示列宽，返回自然宽度；可能渲染并更新本帧缓存，不修改组件布局。
// 例：一行 "你好" 的宽度按终端列算，空数组返回 0；ANSI 样式不作为文字列数。
function measureWidth(context: LayoutContext, component: Component, width: number): number {
	// reduce 从 0 开始累计最大 visibleWidth，而不是求所有行的宽度和。
	return renderCached(context, component, width).reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}

// 给现有孩子盒子设置父引用并返回同一对象，不复制盒子。例：递归布局一个 Stack 孩子后用它建立向上链接；唯一副作用是修改 box.parent。
function withParent(box: LayoutBox, parent: LayoutBox): LayoutBox {
	// 记录所属父盒子。
	box.parent = parent;
	// 返回输入对象，方便嵌在 push 的表达式里。
	return box;
}

// 将盒子及所有后代的 y 坐标一起平移，无返回值；不改 clip，需要稍后另算。
// 例：scrollTop 新增 2 时 deltaY=-2，内容整棵子树上移两行；递归操作的是已有坐标对象。
function translateBox(box: LayoutBox, deltaY: number): void {
	// 直接累加当前盒子的纵坐标，横坐标和尺寸保持原值。
	box.rect.y += deltaY;
	// 每个孩子递归使用同样位移，保持它们相对父亲的位置。
	for (const child of box.children) translateBox(child, deltaY);
}

// 按新的祖先可见矩形递归重算 clip，无返回值；不改变 rect。
// 例：滚动内容平移后，用滚动窗口重新裁剪它与所有后代，避免旧裁剪坐标残留。
function updateClips(box: LayoutBox, parentClip: LayoutRect): void {
	// 当前可见矩形是自身完整矩形和父可见矩形的交集。
	box.clip = intersect(parentClip, box.rect);
	// 后代继续使用本层裁剪结果，因此所有祖先的限制都会向下传递。
	for (const child of box.children) updateClips(child, box.clip);
}

// 为一个组件构建带坐标的盒子树：探测协议后按普通叶子、滚动、竖排、横排分别处理，返回 LayoutBox。
// 输入含本帧上下文、组件、全帧起点、可用尺寸和祖先裁剪区；height 缺省表示取自然高度。会调用 render/可见性回调、修改缓存和滚动状态，不直接写终端，相关异常向上传播。
// 例：在 y=5 放一个高 3 的 VStack，它的孩子按分配行数从第 5 行向下排；放 ScrollView 时则按 scrollTop 上移其内容。
function layoutComponent(
	// 共享本帧缓存、全局视口和重画回调。
	context: LayoutContext,
	// 当前待布局的组件对象。
	component: Component,
	// 当前组件左边的全帧列坐标。
	x: number,
	// 当前组件上边的全帧行坐标，允许滚动导致负数。
	y: number,
	// 分配给当前组件的总列宽。
	width: number,
	// 限定高度或 undefined；不同节点分支据此决定自然高度或受限高度。
	height: number | undefined,
	// 祖先允许可见的矩形，不是当前组件自己的完整尺寸。
	clip: LayoutRect,
	// 返回当前节点及其子树，而非已经绘制的终端内容。
): LayoutBox {
	// 列宽向下取整且至少为 1，后续测量和矩形使用这个值。
	const safeWidth = Math.max(1, Math.floor(width));
	// 尝试调用组件的布局协议方法；缺少协议返回 undefined，不在这里验证节点的每个字段。
	const node = getLayoutNode(component);
	// 没有布局描述的普通组件作为叶子，例如 Text、Box 或 Loader。
	if (!node) {
		// 获取完整文本行，可能执行 render，也可能命中本帧缓存。
		const lines = renderCached(context, component, safeWidth);
		// 不限高度就用所有行数，否则向下取整并夹到非负。
		const allocatedHeight = height === undefined ? lines.length : Math.max(0, Math.floor(height));
		// 默认从原始文本第一行开始绘制。
		let lineOffset = 0;
		// 只有文本超高且仍有可见行时，才尝试为了光标向下移动观察起点。
		if (lines.length > allocatedHeight && allocatedHeight > 0) {
			// findIndex 找包含 CURSOR_MARKER 的第一行；不存在返回 -1，这不是找最后一个标记。
			const cursorLine = lines.findIndex((line) => line.includes(CURSOR_MARKER));
			// 光标行超出可用高度时，让它成为可见范围的最后一行；否则仍从顶部开始。
			if (cursorLine >= allocatedHeight) lineOffset = cursorLine - allocatedHeight + 1;
		}
		// 构造叶子盒子，保留完整文本和偏移供绘制阶段使用。
		return {
			// 保存当前组件引用。
			component,
			// 记录完整分配矩形，height 可能为 0。
			rect: { x, y, width: safeWidth, height: allocatedHeight },
			// 将叶子矩形与祖先可见区求交，供纵向绘制和命中查询使用。
			clip: intersect(clip, { x, y, width: safeWidth, height: allocatedHeight }),
			// 普通叶子没有由布局协议递归展开的孩子；即使组件内部自己有孩子，也由其 render 负责。
			children: [],
			// 保存原始渲染数组，不裁掉数组中的不可见行。
			lines,
			// 保存起始行偏移，绘制时再选择源行。
			lineOffset,
			// 初始化命中排序层为 0。
			layer: 0,
		};
	}

	// type 标签将联合类型收窄到滚动描述，此分支处理内容偏移和视口高度。
	if (node.type === "scroll") {
		// 先保存更新边界前的滚动偏移，后面需要修正已经排好的孩子位置。
		const previousScrollTop = node.state.scrollTop;
		// 让状态实现决定正文宽度；例如 always 滚动条在宽度大于 1 时预留右侧一列。
		const contentWidth = node.state.getContentWidth(safeWidth);
		// 先递归布局滚动内容，得到其自然高度；下面参数依次描述位置、宽度和祖先裁剪区。
		const childBox = layoutComponent(
			// 复用本帧共享状态和缓存。
			context,
			// 递归的是滚动内容组件，而非再次递归当前滚动壳。
			node.component,
			// 正文与滚动窗口从同一列开始。
			x,
			// 内容顶部减去旧 scrollTop，使滚走的行位于窗口上方。
			y - previousScrollTop,
			// 使用状态算出的正文宽度。
			contentWidth,
			// 内容高度不受窗口高度限制，先完整测出可滚动的范围。
			undefined,
			// 暂传祖先裁剪区，窗口自身的裁剪要等高度确定后再更新。
			clip,
		);
		// 布局子树的完整高度就是内容高度。
		const contentHeight = childBox.rect.height;
		// 不限高度时窗口等于内容高；显式高度则取非负整数。
		const viewportHeight = height === undefined ? contentHeight : Math.max(0, Math.floor(height));
		// 同步内容/视口边界，状态实现会夹取偏移或执行跟随末尾策略，并保存 requestRender，不在此直接写终端。
		node.state.updateLayout(contentHeight, viewportHeight, context.requestRender);
		// 如果边界更新使 scrollTop 改变，按“旧值减新值”整体平移子树；新值更大则内容继续上移。
		translateBox(childBox, previousScrollTop - node.state.scrollTop);
		// as 只改变 TypeScript 视角，不做 instanceof 检查，也不把任意对象变成 ScrollView；后续依赖实际实现符合协议。
		const scrollView = node.state as ScrollView;
		// 尚无主要视图时先采用它；显式 primary 可覆盖已有选择。选择发生在孩子递归之后，多个声明不会被拒绝，后遇到的声明可能覆盖先前值。
		if (node.state.primary || !context.primaryScrollView) context.primaryScrollView = scrollView;
		// 窗口本身不随内容偏移，仍使用当前起点和视口高度。
		const rect = { x, y, width: safeWidth, height: viewportHeight };
		// 窗口可见部分再与祖先限制求交。
		const childClip = intersect(clip, rect);
		// 建立滚动窗口盒子，内容子树挂在其下面。
		const box: LayoutBox = {
			// 保存窗口组件身份。
			component,
			// 保存窗口完整矩形。
			rect,
			// 把相交后的窗口矩形作为本层 clip。
			clip: childClip,
			// 单个内容盒子成为孩子。
			children: [childBox],
			// 保存具体滚动视图引用，稍后查询样式与几何。
			scrollView,
			// 另存正文组件按正文宽度 render 的原始行，本帧缓存可复用结果；用于视口上方图片回查等场景。
			scrollContentLines: renderCached(context, node.component, contentWidth),
			// 初始化命中排序层。
			layer: 0,
		};
		// 补上内容盒子的父指针。
		childBox.parent = box;
		// 前面平移只改 rect，现在用窗口可见区重算整棵内容子树的 clip。
		updateClips(childBox, childClip);
		// 滚动分支完成，返回窗口盒子。
		return box;
	}

	// 剩下的是堆叠节点；visible 回调收到全帧 context.viewport，不是当前分配区域的局部宽高。
	const entries = visibleStackEntries(node.entries, context.viewport);
	// n 个可见孩子之间只有 n-1 个间隔，空列表不产生负间距。
	const gapTotal = Math.max(0, entries.length - 1) * node.gap;
	// 竖排以高度为主轴，各孩子使用相同列宽。
	if (node.type === "vstack") {
		// 先为每个条目得到初始高度；map 结果顺序与 entries 一致。
		const intrinsicHeights = entries.map((entry) =>
			// 数字 basis 直接作为起点，省去这一步自然高度测量；否则按完整列宽测行数，递归实际布局仍会稍后执行。
			typeof entry.basis === "number" ? entry.basis : measureHeight(context, entry.component, safeWidth),
		);
		// 按父级可用高度、间距和每项约束分配高度；无法增长/收缩时可能留下空白或溢出。
		const sizes = allocateStackSizes(entries, intrinsicHeights, height, node.gap);
		// 分配高度之和加间距得到自然容器高度。
		const naturalHeight = sizes.reduce((sum, size) => sum + size, 0) + gapTotal;
		// 没有显式高度才使用自然值，否则容器本身采用非负整数高度。
		const allocatedHeight = height === undefined ? naturalHeight : Math.max(0, Math.floor(height));
		// 竖排容器矩形由起点、统一列宽和分配高度组成。
		const rect = { x, y, width: safeWidth, height: allocatedHeight };
		// 创建父盒子，孩子随后逐个追加。
		const box: LayoutBox = {
			// 保存竖排组件对象。
			component,
			// 保存完整矩形。
			rect,
			// 可见区取自身与祖先的交集。
			clip: intersect(clip, rect),
			// 初始化空孩子数组。
			children: [],
			// 初始化层为 0，不把深度直接写成 layer。
			layer: 0,
		};
		// 第一个孩子从容器顶部开始。
		let childY = y;
		// 按可见条目顺序逐个递归布局。
		for (let index = 0; index < entries.length; index++) {
			// 将本项最终盒子加入父亲的孩子列表。
			box.children.push(
				// 先为递归结果补父指针，再返回同一盒子给 push。
				withParent(
					// 在当前 childY 使用同列宽、对应分配高度和父可见区布局；! 是 TypeScript 非空断言，不生成检查。
					layoutComponent(context, entries[index]!.component, x, childY, safeWidth, sizes[index]!, box.clip),
					// 当前 box 是孩子的父亲。
					box,
				),
			);
			// 下一项起始行向下移动孩子高度与间距；最后一次增加不额外生成盒子。
			childY += sizes[index]! + node.gap;
		}
		// 返回完整竖排子树。
		return box;
	}

	// 走到这里就是横排；先逐项测量自然列宽。
	const intrinsicWidths = entries.map((entry) =>
		// 数字 basis 优先，否则按当前总列宽渲染并测出最长行的显示宽度。
		typeof entry.basis === "number" ? entry.basis : measureWidth(context, entry.component, safeWidth),
	);
	// 以总列宽为可用主轴空间，分配每个孩子的列数并扣除间距。
	const widths = allocateStackSizes(entries, intrinsicWidths, safeWidth, node.gap);
	// 宽度会影响换行高度，所以按分配后的列宽重新测高度。
	const intrinsicHeights = entries.map((entry, index) =>
		// 测量时至少给 1 列，即使某项分配到 0 列也会测一次高度；稍后它不会真正绘制。
		measureHeight(context, entry.component, Math.max(1, widths[index]!)),
	);
	// 决定横排容器高度，下面条件表达式区分自然高度与显式限制。
	const allocatedHeight =
		// 没有显式高度时取所有孩子自然高度中的最大值。
		height === undefined
			? // reduce 从 0 开始找最大行数，空孩子列表自然高度为 0。
				intrinsicHeights.reduce((max, childHeight) => Math.max(max, childHeight), 0)
			: // 有高度时仅夹到非负；这个分支本身没有像叶子/竖排分支那样调用 floor。
				Math.max(0, height);
	// 建立横排父容器的完整矩形。
	const rect = { x, y, width: safeWidth, height: allocatedHeight };
	// 孩子还未生成，先创建父盒子。
	const box: LayoutBox = {
		// 保存横排组件身份。
		component,
		// 保存完整矩形。
		rect,
		// 和祖先可见区域求交。
		clip: intersect(clip, rect),
		// 准备逐个添加孩子。
		children: [],
		// 层初始化为 0。
		layer: 0,
	};
	// 第一个孩子从容器左端开始。
	let childX = x;
	// 逐项换算交叉轴高度与位置。
	for (let index = 0; index < entries.length; index++) {
		// 取得前面测出的自然高度。
		const naturalChildHeight = intrinsicHeights[index]!;
		// stretch 将孩子高度设为容器高度；其他对齐方式只取不超过容器的自然高度。
		const childHeight = node.align === "stretch" ? allocatedHeight : Math.min(allocatedHeight, naturalChildHeight);
		// 默认顶部对齐，从父亲的 y 开始。
		let childY = y;
		// 居中时将剩余高度平分，并向下取整作为顶部偏移。
		if (node.align === "center") childY += Math.floor((allocatedHeight - childHeight) / 2);
		// 末端对齐时将全部剩余高度留在顶部；start/stretch 不增加偏移。
		else if (node.align === "end") childY += allocatedHeight - childHeight;
		// 取对应的主轴列宽。
		const childWidth = widths[index]!;
		// 零宽孩子保留树节点供结构查询，但不进入正常递归绘制。
		if (childWidth === 0) {
			// 创建一个没有可见区域的孩子盒子。
			box.children.push({
				// 仍保存原组件身份。
				component: entries[index]!.component,
				// 完整矩形宽为 0，高度保留已分配值。
				rect: { x: childX, y: childY, width: 0, height: childHeight },
				// clip 的宽高都为 0，命中与绘制时不产生可见单元。
				clip: { x: childX, y: childY, width: 0, height: 0 },
				// 这里不递归展开它的内部孩子。
				children: [],
				// 直接建立父引用。
				parent: box,
				// 层初始化为 0。
				layer: 0,
			});
			// 有可用列宽的孩子正常递归处理。
		} else {
			// 将递归得到并已补父指针的盒子加入数组。
			box.children.push(
				// withParent 只设置父引用，不复制递归结果。
				withParent(
					// 传入横向起点、对齐后的 y、分配宽高与父裁剪区；子组件的节点类型决定内部布局。
					layoutComponent(context, entries[index]!.component, childX, childY, childWidth, childHeight, box.clip),
					// 当前横排盒子作为父亲。
					box,
				),
			);
		}
		// 下一项起始列加上本项宽度和间距。
		childX += childWidth + node.gap;
	}
	// 返回完整横排盒子树。
	return box;
}

// 替换文本行上的一个滚动条单元，返回新行；图片行直接返回。输入含目标列、全帧宽度、替换符号和是否继承目标背景。
// 先按完整字素边界切开，再清理样式、补空格并嵌入符号。例：滚动条覆盖中文字符的第二列时，不能留下“半个字”，其余被占列改为空格；不修改原字符串。
function replaceScrollbarCell(
	// 原始行，可能包含 ANSI 或图片协议。
	line: string,
	// 要放置滚动条符号的终端列。
	column: number,
	// 目标行的总显示列数，限制保留的右侧范围。
	totalWidth: number,
	// 已经过滚动条样式回调处理的替换字符串。
	replacement: string,
	// true 表示恢复目标单元原背景，auto 覆盖正文时使用；always 预留列时不继承背景。
	preserveTargetBackground: boolean,
	// 返回拼接后的行字符串。
): string {
	// 图片行不可按普通单元替换，避免破坏终端图片控制序列。
	if (isImageLine(line)) return line;

	// 找目标列所属的完整字素范围，宽字符可能跨两列。
	const graphemeRange = getGraphemeCellRange(line, column);
	// 能找到字素时从其起始列切，否则直接用目标列。
	const start = graphemeRange?.start ?? column;
	// 切除到字素结束列；没有字素时按单列替换。
	const end = graphemeRange?.end ?? column + 1;
	// 保留目标字素左侧部分，true 启用严格列边界处理。
	const before = sliceByColumn(line, 0, start, true);
	// 取整个目标字素区域，用于找它生效的样式前缀。
	const target = sliceByColumn(line, start, end - start, true);
	// 保留字素右侧、总宽度以内的部分，长度不小于 0。
	const after = sliceByColumn(line, end, Math.max(0, totalWidth - end), true);

	// 收集目标片段开头连续的 ANSI 控制序列。
	let targetPrefix = "";
	// 字符串下标从片段起点开始，不是显示列坐标。
	let targetIndex = 0;
	// 逐个读取开头的控制序列，到普通文字就停止。
	while (targetIndex < target.length) {
		// 尝试在当前字符下标提取 ANSI 序列。
		const ansi = extractAnsiCode(target, targetIndex);
		// 当前位置不是序列就停止收集，不继续越过正文搜索。
		if (!ansi) break;
		// 拼入刚提取的控制代码。
		targetPrefix += ansi.code;
		// 按序列的字符串长度跳到下一位置。
		targetIndex += ansi.length;
	}
	// 原行太短时，把目标字素左侧缺少的列补齐到 start。
	const beforePadding = " ".repeat(Math.max(0, start - visibleWidth(before)));
	// 目标列位于宽字素内部时，用空格填掉它之前被删除的字素列。
	const cellPaddingBefore = " ".repeat(Math.max(0, column - start));
	// 同理补掉目标列之后剩余的字素列，确保整体列位置不因替换而错位。
	const cellPaddingAfter = " ".repeat(Math.max(0, end - column - 1));
	// 先重置 SGR 并关闭 OSC 8 超链接，再按开关仅恢复目标背景；避免正文前景/链接污染滚动条。
	const targetStyle = `\x1b[0m\x1b]8;;\x07${preserveTargetBackground ? getActiveBackgroundAnsi(targetPrefix) : ""}`;
	// 按左侧、空白、清理样式、目标前空格、符号、目标后空格、右侧顺序组成新行；模板插值不改变原字符串。
	return `${before}${beforePadding}${targetStyle}${cellPaddingBefore}${replacement}${cellPaddingAfter}${after}`;
}

// 计算滚动条轨道与滑块的位置，返回几何或 undefined，不修改盒子与滚动状态。
// 例：内容高 100、窗口高 10 时滑块最少占 2 行，位置随 scrollTop 成比例；includeHiddenAuto 只允许查询溢出但暂时隐藏的 auto 条，不强制显示 hidden 条。
export function getScrollbarGeometry(box: LayoutBox, includeHiddenAuto = false): ScrollbarGeometry | undefined {
	// 不是滚动节点，或尺寸没有正面积时，没有可用滚动条几何。
	if (!box.scrollView || box.rect.width <= 0 || box.rect.height <= 0) return undefined;

	// 优先从内容子盒子高度取值，缺失才用原始行数，再缺失取 0。
	const contentHeight = box.children[0]?.rect.height ?? box.scrollContentLines?.length ?? 0;
	// 整条轨道与滚动窗口一样高，后续绘制还会按 clip 跳过不可见行。
	const trackHeight = box.rect.height;
	// 只有请求包含隐藏 auto、模式确为 auto 且内容溢出时，才允许临时计算其几何。
	const canRevealHiddenAuto = includeHiddenAuto && box.scrollView.scrollbar === "auto" && contentHeight > trackHeight;
	// 实际不可见且不符合上面特例则不提供几何；查询本身不改变可见性状态。
	if (!box.scrollView.isScrollbarVisible && !canRevealHiddenAuto) return undefined;

	// 滑块通常至少 2 行，但不能比轨道本身高。
	const minThumbHeight = Math.min(2, trackHeight);
	// 滑块高度在下限和轨道高度之间取值，下面两项是 Math.max 的参数。
	const thumbHeight = Math.max(
		// 应用刚才计算的最小滑块高度。
		minThumbHeight,
		// 按视口占内容的比例估算 trackHeight²/contentHeight，四舍五入并限制不超过轨道；内容为 0 时 Infinity 会被轨道上限截住。
		Math.min(trackHeight, Math.round((trackHeight * trackHeight) / contentHeight)),
	);
	// 可滚动距离等于内容超出窗口的部分，最少为 0。
	const maxScrollTop = Math.max(0, contentHeight - trackHeight);
	// 滑块在轨道上可移动的总行数。
	const maxThumbTop = trackHeight - thumbHeight;
	// 不能滚动时偏移为 0，否则把 scrollTop 比例映射到滑块可移动范围并四舍五入。
	const thumbOffset = maxScrollTop === 0 ? 0 : Math.round((box.scrollView.scrollTop / maxScrollTop) * maxThumbTop);
	// 滚动条放在窗口的最右一列。
	const column = box.rect.x + box.rect.width - 1;
	// 这一列不在横向 clip 内就不提供几何；纵向裁剪留给绘制循环处理。
	if (column < box.clip.x || column >= box.clip.x + box.clip.width) return undefined;

	// 组装几何结果，不分配文本行。
	return {
		// 符号所在列。
		column,
		// 轨道从窗口顶部开始，可能仍部分位于屏幕外。
		trackTop: box.rect.y,
		// 轨道完整高度。
		trackHeight,
		// 窗口顶部加相对滑块偏移，得到全帧起始行。
		thumbTop: box.rect.y + thumbOffset,
		// 滑块占用行数。
		thumbHeight,
		// 同时返回可滚动上限，便于调用方把拖动转换成内容偏移。
		maxScrollTop,
	};
}

// 把滚动条叠加到 screen 行数组，原地修改对应行，无返回值；仅绘制可见几何，样式回调异常向上传播。
// 例：auto 条覆盖内容时保留目标背景，always 条占用专门一列；这只是内存行合成，没有终端写入。
function paintScrollbar(box: LayoutBox, screen: string[], totalWidth: number): void {
	// 按当前可见性获取轨道与滑块几何，不强制显示隐藏的 auto 条。
	const geometry = getScrollbarGeometry(box);
	// 没有几何或具体视图引用就不绘制。
	if (!geometry || !box.scrollView) return;

	// 逐行检查整个轨道，实际会跳过裁剪区或屏幕外的部分。
	for (let offset = 0; offset < geometry.trackHeight; offset++) {
		// 从相对轨道位置换成全帧行坐标。
		const row = geometry.trackTop + offset;
		// 不在纵向 clip 或 screen 数组范围内就跳过，避免读写不可见行。
		if (row < box.clip.y || row >= box.clip.y + box.clip.height || row < 0 || row >= screen.length) continue;
		// 半开区间判断这一行是否落在滑块内。
		const isThumb = row >= geometry.thumbTop && row < geometry.thumbTop + geometry.thumbHeight;
		// 按是否为滑块选择要绘制的样式字符串。
		const replacement = isThumb
			? // 滑块活跃时用实心块，否则用较细竖线，再调用视图提供的滑块着色函数。
				box.scrollView.scrollbarThumbStyle(box.scrollView.isScrollbarActive ? "█" : "┃")
			: // 非滑块行使用轨道符号并调用轨道样式函数。
				box.scrollView.scrollbarTrackStyle("│");
		// 替换目标单元，并把新字符串写回 screen 对应行。
		screen[row] = replaceScrollbarCell(
			// 该行尚未写内容时从空字符串开始。
			screen[row] ?? "",
			// 使用几何计算出的滚动条列。
			geometry.column,
			// 传入总列宽以保留右侧内容边界。
			totalWidth,
			// 传入已经加样式的符号。
			replacement,
			// 非 always 模式保留正文目标背景；always 预留列则清掉目标背景后绘制。
			box.scrollView.scrollbar !== "always",
		);
	}
}

// 把盒子树合成到 screen，原地修改字符串数组，无返回值：先绘叶子文本，再递归孩子，最后修补滚入视口的图片并画本层滚动条。
// 例：内容首行图片已滚到窗口上方，但下半部仍可见时，回查元数据并裁剪图片；不把普通文本行处理方式直接套在图片协议上。工具与样式回调错误向上传播。
function paintBox(box: LayoutBox, screen: string[], totalWidth: number): void {
	// 只有带 lines 的盒子才走文本绘制，布局容器本身通常只递归孩子。
	if (box.lines) {
		// 普通叶子默认从原数组第 0 行开始；有限高度为保留光标可能设置更大的偏移。
		const offset = box.lineOffset ?? 0;
		// 开始行取完整矩形、裁剪区与屏幕顶部三者中最靠下的位置。
		const firstRow = Math.max(box.rect.y, box.clip.y, 0);
		// 结束行取完整矩形底部、裁剪区底部和数组高度中最小值，不包含该行。
		const lastRow = Math.min(box.rect.y + box.rect.height, box.clip.y + box.clip.height, screen.length);
		// 只遍历纵向可见的目标行。
		for (let row = firstRow; row < lastRow; row++) {
			// 全帧行减盒子起点，再加源偏移，换成原始文本数组下标。
			const sourceLine = box.lines[offset + row - box.rect.y];
			// 盒子比分配内容更高时可能取不到源行，跳过即可。
			if (sourceLine === undefined) continue;
			// 移除行首 OSC 133 A/B/C 标记，避免这些区域标记进入这里的合成输出。
			let line = sourceLine.replace(OSC133_ZONE_PREFIX, "");
			// 查找已注册的 Kitty 图片元数据；没有注册信息时不在此猜图片高度。
			const imageMetadata = getKittyImageMetadata(line);
			// 有元数据才尝试按可见底部裁剪图片。
			if (imageMetadata) {
				// 可见底部不能超过屏幕或本盒子裁剪区。
				const clipBottom = Math.min(screen.length, box.clip.y + box.clip.height);
				// 本次能显示的图片行数不能超过元数据记录的总行数。
				const visibleRows = Math.min(imageMetadata.rows, clipBottom - row);
				// 图片底部越界时只保留从图片顶部开始的可见部分；cropKittyImageLine 返回裁剪后的协议行。
				if (visibleRows < imageMetadata.rows) line = cropKittyImageLine(line, 0, visibleRows);
			}
			// Fast path: a full-width box painting onto an untouched row can use the
			// source line reference directly. Compositing here would rebuild the row
			// string through ANSI/grapheme segmentation every frame; padding is
			// unnecessary because rows are written with erase-line and the final
			// width clamp still truncates over-wide lines.
			// 覆盖全帧宽且从第 0 列开始，同时是图片行或目标行还为空时，可直接写入，不必逐列合成。
			if (box.rect.x === 0 && box.rect.width >= totalWidth && (isImageLine(line) || !screen[row])) {
				// 直接使用源字符串，省掉切分与补空格；超宽普通行的最终限制由上游 TuiAltScreen 输出阶段完成，不是此快路径已截断。
				screen[row] = line;
				// 部分宽度或已有内容的行需要合成，不能直接覆盖整行。
			} else {
				// 按盒子的 x/width 合成到目标行，总宽为 totalWidth；该调用不是单独按 clip.x 再切一次。底层遇到已有图片行时采用它自身的图片保留规则。
				screen[row] = compositeTuiLine(screen[row] ?? "", line, box.rect.x, box.rect.width, totalWidth);
			}
		}
	}
	// 按孩子数组顺序递归合成，之后才画父滚动条，所以父条会覆盖对应单元。
	for (const child of box.children) paintBox(child, screen, totalWidth);

	// 只有滚动节点、有原始内容行、已向下滚动且窗口有高度时，才回查视口上方的跨界图片。
	if (box.scrollView && box.scrollContentLines && box.scrollView.scrollTop > 0 && box.rect.height > 0) {
		// Find the nearest image line above the viewport. Placeholder rows below an
		// image line may contain padding, borders, or side-by-side text, so the search
		// is bounded by the tallest registered image instead of by row content.
		// 取当前内容滚动偏移，作为原始行数组中的窗口顶部。
		const scrollTop = box.scrollView.scrollTop;
		// 回查距离不超过最高已注册图片的高度，避免按占位行文字内容猜图片边界。
		const minRow = Math.max(0, scrollTop - getMaxKittyImageRows());
		// 从视口上一行开始向上寻找最近图片行，最多查到 minRow。
		for (let imageRow = scrollTop - 1; imageRow >= minRow; imageRow--) {
			// 取原始行，超出数组时按空字符串处理。
			const imageLine = box.scrollContentLines[imageRow] ?? "";
			// 不是图片协议行就继续往上找。
			if (!isImageLine(imageLine)) continue;
			// 取这条图片行的注册元数据。
			const metadata = getKittyImageMetadata(imageLine);
			// 没有元数据就继续查，不能仅凭图片控制串完成精确裁剪。
			if (!metadata) continue;
			// 原图片头部到当前窗口顶部之间隐藏了多少行。
			const hiddenRows = scrollTop - imageRow;
			// 隐藏高度还没达到图片总高时，说明有剩余部分跨入窗口。
			if (hiddenRows < metadata.rows) {
				// 剩余可显示行数同时受窗口高度和图片余下高度限制。
				const visibleRows = Math.min(box.rect.height, metadata.rows - hiddenRows);
				// 丢掉 hiddenRows 个顶部图片行，只保留 visibleRows 行。
				const cropped = cropKittyImageLine(imageLine, hiddenRows, visibleRows);
				// 仅对从第 0 列开始且覆盖总宽的窗口，把裁剪后的图片头补到窗口首行；局部宽度此处不补。
				if (box.rect.x === 0 && box.rect.width >= totalWidth) screen[box.rect.y] = cropped;
			}
			// 遇到最近的有元数据图片后就停止，不论它是否还有可见部分，都不继续寻找更远图片。
			break;
		}
	}

	// 在本盒子内容及孩子之后绘制它自己的滚动条；没有视图或几何时内部直接返回。
	paintScrollbar(box, screen, totalWidth);
}

// 生成一帧布局结果，输入根组件、总列宽/行高、宿主重画回调；返回盒子树、文本行和可选主要滚动视图。
// 流程是规范尺寸、新建本帧缓存、递归布局、合成文本。例：renderLayoutFrame(root, 80, 24, requestRender) 以 80 列、24 行安排一帧，不直接写终端；会调用组件渲染、更新滚动边界，相关异常向上传播。
export function renderLayoutFrame(
	// 需要布局的根组件，可为普通叶子、Stack 或 ScrollView。
	root: Component,
	// 请求的全帧列数，下面会取整且至少为 1。
	width: number,
	// 请求的全帧行数，下面同样规范。
	height: number,
	// 传给滚动状态的后续重画通知，不在这里主动执行绘制。
	requestRender: () => void,
	// LayoutFrame 是编译期返回结构约束，不是运行时自动验证。
): LayoutFrame {
	// 向下取整列数，至少保留一列。
	const safeWidth = Math.max(1, Math.floor(width));
	// 向下取整行数，至少保留一行。
	const safeHeight = Math.max(1, Math.floor(height));
	// 每次调用创建新的共享上下文，因此 renderCache 不跨帧保留。
	const context: LayoutContext = {
		// 全帧宽高提供给可见性回调与布局过程。
		viewport: { width: safeWidth, height: safeHeight },
		// 新建组件身份到宽度表的缓存，类型由 LayoutContext 推导。
		renderCache: new Map(),
		// 对象属性简写保存宿主回调引用。
		requestRender,
		// 还没有选出主要滚动视图。
		primaryScrollView: undefined,
	};
	// 从原点递归布局根组件，并将全帧矩形作为初始裁剪范围。
	const rootBox = layoutComponent(context, root, 0, 0, safeWidth, safeHeight, {
		// 裁剪区左边界为第 0 列。
		x: 0,
		// 裁剪区上边界为第 0 行。
		y: 0,
		// 裁剪宽度等于规范后的全帧宽度。
		width: safeWidth,
		// 裁剪高度等于规范后的全帧高度。
		height: safeHeight,
	});
	// 预分配 safeHeight 个空字符串，每个元素是一条目标屏幕行。
	const lines = Array.from({ length: safeHeight }, () => "");
	// 按布局树写入这些内存行，包括文本、图片裁剪与滚动条。
	paintBox(rootBox, lines, safeWidth);
	// 返回本次新建的帧对象，调用方后续负责真正的终端输出。
	return {
		// 根盒子包含整棵坐标树，可供命中查询复用。
		root: rootBox,
		// 记录实际采用的列宽。
		width: safeWidth,
		// 记录实际采用的行高。
		height: safeHeight,
		// 保存合成完成的文本行数组。
		lines,
		// 条件对象展开：有主要滚动视图才添加属性，缺省时完全省略该键。
		...(context.primaryScrollView === undefined ? {} : { primaryScrollView: context.primaryScrollView }),
	};
}

// 判断全帧点是否落在矩形内，返回 boolean，不修改对象。例：[0,2) 内含列 0、1，不含 2；零宽或零高矩形无法命中。
function containsPoint(rect: LayoutRect, x: number, y: number): boolean {
	// 四个条件共同成立才命中；左上边界包含，右下边界排除。
	return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** Return the visual hit path from the deepest component to the layout root. */
// 按坐标收集可见盒子，优先返回更高 layer、同层更深的节点，不实际派发事件或修改布局。
// 例：点击嵌套容器里的 Text，会先得到更深的叶子，再得到相应祖先；若结构有重叠，会收集所有满足 clip 的分支，不强制只返回一条祖先链。
export function getLayoutBoxesAt(frame: LayoutFrame, x: number, y: number): LayoutBox[] {
	// 暂存盒子和递归深度，以便在收集完后排序。
	const result: Array<{ box: LayoutBox; depth: number }> = [];
	// 局部递归访问器，输入当前盒子和深度，无返回值；副作用仅是向 result 收集命中节点，不调用组件处理函数。
	const visit = (box: LayoutBox, depth: number): void => {
		// 点不在本层 clip 内则整棵子树都不用访问。
		if (!containsPoint(box.clip, x, y)) return;
		// 当前节点可见，记下它和深度。
		result.push({ box, depth });
		// 按孩子顺序递归，深度每层加一。
		for (const child of box.children) visit(child, depth + 1);
	};
	// 从根节点、深度 0 开始收集。
	visit(frame.root, 0);
	// 原地排序：先 layer 降序，差为 0 时再按深度降序；|| 选择第一个非零比较结果。
	result.sort((a, b) => b.box.layer - a.box.layer || b.depth - a.depth);
	// 去掉辅助深度字段，返回按优先级排列的盒子引用，不复制盒子。
	return result.map(({ box }) => box);
}

// 按滚动视图对象身份查找第一个对应盒子，返回它或 undefined，不修改树，也不要求盒子当前可见。
// 例：已持有某个 ScrollView 时可在当前帧找它的 rect；深度优先找到首个匹配便停止。
export function getScrollViewBox(frame: LayoutFrame, scrollView: ScrollView): LayoutBox | undefined {
	// 局部递归函数输入盒子，返回本层或后代中的首个匹配，没有则 undefined；只读查询，不派发事件。
	const visit = (box: LayoutBox): LayoutBox | undefined => {
		// 对象引用相同就立即返回当前盒子，而非比较字段内容。
		if (box.scrollView === scrollView) return box;
		// 按数组顺序检查孩子。
		for (const child of box.children) {
			// 递归查询一个孩子子树。
			const match = visit(child);
			// 得到结果就向上传递，不再访问后续兄弟。
			if (match) return match;
		}
		// 本层与所有孩子都没有匹配。
		return undefined;
	};
	// 从当前帧根部开始查找。
	return visit(frame.root);
}

// 按坐标收集可见的滚动视图并按深度从内到外返回，不滚动或派发事件。
// 例：点位于嵌套 ScrollView 内时，返回内层在前、外层在后，供上游决定滚轮传递；这里按深度排序，不按 layer。
export function getScrollViewsAt(frame: LayoutFrame, x: number, y: number): ScrollView[] {
	// 临时收集滚动视图引用与深度。
	const result: Array<{ scrollView: ScrollView; depth: number }> = [];
	// 局部递归访问器，输入盒子和深度，无返回值；只追加命中结果，未命中 clip 时剪掉整棵分支。
	const visit = (box: LayoutBox, depth: number): void => {
		// 点不在本层可见区内，后代也无需查询。
		if (!containsPoint(box.clip, x, y)) return;
		// 本层确实是滚动节点且点在完整矩形内才记录；前一条件已限制其可见范围。
		if (box.scrollView && containsPoint(box.rect, x, y)) result.push({ scrollView: box.scrollView, depth });
		// 继续查询孩子，嵌套滚动视图会有更大的深度。
		for (const child of box.children) visit(child, depth + 1);
	};
	// 根深度从 0 开始。
	visit(frame.root, 0);
	// 原地按深度降序排，最内层优先；不在这里执行 overscroll 策略。
	result.sort((a, b) => b.depth - a.depth);
	// 去掉辅助深度，只返回滚动视图对象引用数组。
	return result.map((entry) => entry.scrollView);
}
