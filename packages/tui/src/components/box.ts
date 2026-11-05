// Box 将孩子按行顺序连接，再加留白与背景；也把鼠标坐标换算到命中的孩子。上层 TUI 决定何时 render 和何时真正绘制。
// 混合导入中 type 标记的名字只用于编译期检查，dispatchMouseEvent 是运行时调用的事件分发函数。
import { type Component, dispatchMouseEvent, type TuiMouseDispatchResult, type TuiMouseEvent } from "../tui.ts";
// flattenLines 整理缓存字符串的底层存储，visibleWidth 按终端显示列而非字符数测量。
import { flattenLines, visibleWidth } from "../utils.ts";

// 私有渲染缓存的数据形状；type 只约束开发时字段，不创建运行时校验器。
type RenderCache = {
	// 尚未加 Box 留白和背景的子组件原始行，用于判断正文是否改变。
	childLines: string[];
	// 这组结果对应的请求宽度。
	width: number;
	// 背景函数对固定样本的输出；无函数时为 undefined，用于检测部分背景变化。
	bgSample: string | undefined;
	// 已经加好留白、背景的最终行数组，缓存命中时原样返回。
	lines: string[];
};

/**
 * Box component - a container that applies padding and background to all children
 */
// 实现 Component 的容器；主要副作用是更新孩子列表、缓存和鼠标布局记录，不直接写终端。
export class Box implements Component {
	// 公开可变的孩子数组，按添加顺序渲染；Component[] 表示元素需符合组件接口。
	children: Component[] = [];
	// 左右各留多少列；private 限制 TypeScript 代码的外部访问。
	private paddingX: number;
	// 上下各留多少行，构造时保存，渲染时生成对应空行。
	private paddingY: number;
	// 可选背景函数，接收整行并返回加样式后的字符串。
	private bgFn?: (text: string) => string;

	// Cache for rendered output
	// 最近一次完整结果，可缺省；? 意味着读取时还要考虑 undefined。
	private cache?: RenderCache;
	// 记录上次正文宽度与各孩子高度，供鼠标定位；Array<{...}> 表示对象元素数组，不是新的组件副本。
	private mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> };

	// 创建空 Box，输入水平、垂直留白和可选背景函数，无返回值；只存配置，不立即渲染。
	// 例：new Box(1, 0) 给之后添加的正文左右留空，不增加上下行；传入的边距应是适合 repeat 与布局的数值。
	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		// 保存水平留白。
		this.paddingX = paddingX;
		// 保存垂直留白。
		this.paddingY = paddingY;
		// 保存背景回调引用，此时不执行它。
		this.bgFn = bgFn;
	}

	// 把组件添加到末尾，无返回值；清除自己的结果缓存，不调用孩子 render 或请求宿主重画。
	// 例：先 addChild(title) 再 addChild(body)，输出时标题行排在正文前。
	addChild(component: Component): void {
		// push 修改现有数组，保留孩子对象引用；同一个对象可以被重复添加。
		this.children.push(component);
		// 列表变了，旧结果不能继续复用。
		this.invalidateCache();
	}

	// 按对象引用移除第一个匹配项，无返回值；不存在则不操作，也不销毁组件。例：removeChild(title) 后下一次 render 不再包含该项。
	removeChild(component: Component): void {
		// indexOf 查找第一个相同对象，未找到返回 -1。
		const index = this.children.indexOf(component);
		// 只有找到了才修改数组与缓存。
		if (index !== -1) {
			// splice 原地删除一项，不会把所有重复引用一起删除。
			this.children.splice(index, 1);
			// 移除后让完整输出缓存失效。
			this.invalidateCache();
		}
	}

	// 清空孩子列表和自己的渲染缓存，无返回值；不 dispose 孩子，也不主动请求重画。例：重新填充面板前 clear()。
	clear(): void {
		// 用一个新数组替换列表；原数组的外部引用不会被清空。
		this.children = [];
		// 清除旧结果。
		this.invalidateCache();
	}

	// 替换或移除背景回调，无返回值；不立即清缓存，render 时用固定样本检测输出变化。
	// 例：setBgFn(undefined) 移除背景；两个函数若对 "test" 输出相同，仍可能复用旧缓存，这不是完整的函数语义比较。
	setBgFn(bgFn?: (text: string) => string): void {
		// 仅保存新回调引用或 undefined。
		this.bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	// 修改水平留白并清除本容器缓存，无返回值；下次 render 使用新正文宽度，不在此调用孩子 invalidate。例：setPaddingX(0) 去掉水平边距。
	setPaddingX(paddingX: number): void {
		// 记录新值，没有额外取整或范围检查。
		this.paddingX = paddingX;
		// 清除已应用旧边距的结果。
		this.invalidateCache();
	}

	// 内部缓存清理方法，无参数、无返回值；只放弃最终输出记录，不触及孩子或鼠标布局。例：addChild 后调用它让下一次 render 重新组合。
	private invalidateCache(): void {
		// undefined 表示没有可复用的完整结果；不会修改已返回给调用者的行数组。
		this.cache = undefined;
	}

	// 比较宽度、背景样本与各子行，返回是否可复用缓存；不修改任何记录。
	// 例：孩子 render 仍产出同样字符串时可复用最终行，即使 childLines 是新数组；字符串 === 比较的是值。
	private matchCache(width: number, childLines: string[], bgSample: string | undefined): boolean {
		// 先保存字段到局部变量，后续访问与类型收窄都针对同一缓存记录。
		const cache = this.cache;
		// 括号包住跨行逻辑与表达式；必须全部条件成立才返回 true。
		return (
			// !! 将缓存是否存在转成 boolean，并让后续访问位于存在的分支中。
			!!cache &&
			// 请求宽度必须完全相同。
			cache.width === width &&
			// 背景样本必须相同，undefined 也参与比较。
			cache.bgSample === bgSample &&
			// 行数不同可以直接判定正文改变。
			cache.childLines.length === childLines.length &&
			// every 逐项比较行文本；箭头函数中的 i 是下标，相同行值才算命中，不要求两个数组相同。
			cache.childLines.every((line, i) => line === childLines[i])
		);
	}

	// 向整个孩子列表传播缓存失效，无返回值；先清本层，再调用各孩子的 invalidate，异常不在此捕获。
	// 例：主题改变后统一 invalidate；它本身不直接请求终端重画。
	invalidate(): void {
		// 先清自己的组合结果。
		this.invalidateCache();
		// 按顺序遍历当前孩子。
		for (const child of this.children) {
			// 可选调用存在的 invalidate 方法；不会调用孩子 render。
			child.invalidate?.();
		}
	}

	// 接收相对 Box 的鼠标事件，扣掉留白后找到对应孩子，再分发改写后的坐标；返回分发结果，未命中返回 undefined。
	// 例：paddingY 为 1 时，Box 内 y=1 对应第一个孩子的 y=0；必要时调用孩子 render 测高度，错误向上传播，不写终端。
	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		// 扣掉两侧留白，正文宽度至少为 1；这是事件携带宽度下的正文区域。
		const contentWidth = Math.max(1, event.width - this.paddingX * 2);
		// 减去上边距，换成正文内的行坐标。
		const contentY = event.y - this.paddingY;
		// 减去左边距，换成正文内的列坐标。
		const contentX = event.x - this.paddingX;
		// 上方、左方与正文右侧范围外直接不分发；底部是否命中由下面各孩子的行范围决定。
		if (contentY < 0 || contentX < 0 || contentX >= contentWidth) return undefined;

		// 选择用于命中测试的孩子高度表；下面三行构成一个条件表达式。
		const mouseChildren =
			// 最近 render 记录的正文宽度相同就复用；这里只检查宽度，没有单独验证孩子列表的新旧。
			this.mouseLayout?.width === contentWidth
				? // 条件成立，直接使用已记录的组件引用和高度。
					this.mouseLayout.children
				: // 否则实时 render 各孩子取得行数；map 返回新表，简写属性 component 保存该组件引用。
					this.children.map((component) => ({ component, height: component.render(contentWidth).length }));
		// 当前孩子在正文中的起始行，初始为 0。
		let childY = 0;
		// 解构时把 component 改名为 child，把 height 改名为 childHeight，便于区分变量用途。
		for (const { component: child, height: childHeight } of mouseChildren) {
			// 半开区间：起始行算命中，结束行属于下一个孩子。
			if (contentY >= childY && contentY < childY + childHeight) {
				// 找到后立即分发并返回；dispatchMouseEvent 负责结合孩子的处理结果构造分发信息。
				return dispatchMouseEvent(child, {
					// ...event 复制原事件各属性，下面的坐标和尺寸覆盖原值。
					...event,
					// 孩子内的列坐标已经扣掉 Box 左边距。
					x: contentX,
					// 再减当前孩子起始行，得到孩子内的行坐标。
					y: contentY - childY,
					// 传给孩子它自己的可用正文宽度。
					width: contentWidth,
					// 传给孩子本次测得的行数。
					height: childHeight,
				});
			}
			// 未命中这一项，下一项的起始行向下移动相应高度。
			childY += childHeight;
		}
		// 遍历完仍未命中，返回 undefined，不把事件强制交给某个孩子。
		return undefined;
	}

	// 按请求宽度生成行数组：渲染所有孩子并记录高度，比较缓存，再补上下空白和每行背景。
	// 例：一个两行孩子配 paddingY=1 会得到四行；不直接写终端，孩子和背景回调抛错会向上传播。即使缓存命中，前面的孩子渲染仍会执行。
	render(width: number): string[] {
		// 没有孩子就直接不占任何行，Box 自身留白也不绘制。
		if (this.children.length === 0) {
			// 返回新的空数组；此分支不会更新鼠标布局记录。
			return [];
		}

		// 扣掉两侧留白后至少给孩子一列；不像 Text，这里不会自动缩小配置的左右边距。
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		// 生成左侧空格；配置过大时可能超出总宽度，这里没有自动截断。
		const leftPad = " ".repeat(this.paddingX);

		// Render all children. Keep the child lines unpadded: children usually return the same string
		// objects every frame, so the cache check below is a cheap identity comparison per line.
		// Padding here would create new strings that must be compared character by character.
		// 收集孩子的原始行，先不补 Box 边距，方便后面比较缓存。
		const childLines: string[] = [];
		// 带元素类型的高度表，用于随后的鼠标定位。
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		// 按孩子添加顺序渲染。
		for (const child of this.children) {
			// 孩子可能复用自己的缓存；Box 读取返回行数和文本。
			const lines = child.render(contentWidth);
			// 记录组件引用及其高度，不复制组件对象。
			mouseChildren.push({ component: child, height: lines.length });
			// 逐行展开这个孩子的结果。
			for (const line of lines) {
				// 将原始字符串存入总正文数组。
				childLines.push(line);
			}
		}
		// 即使稍后命中结果缓存，也把本次高度表保存下来。
		this.mouseLayout = { width: contentWidth, children: mouseChildren };

		// 所有孩子都没有输出行时，容器同样不绘制上下留白。
		if (childLines.length === 0) {
			// 直接返回空结果。
			return [];
		}

		// Check if bgFn output changed by sampling
		// 实际调用一次背景函数处理固定字符串 "test"；只用该输出比较背景，不检查函数内部逻辑。
		const bgSample = this.bgFn ? this.bgFn("test") : undefined;

		// Check cache validity
		// 宽度、样本和原始正文全部一致时可复用组合结果。
		if (this.matchCache(width, childLines, bgSample)) {
			// ! 是非空断言，仅影响类型检查；matchCache 成立说明缓存存在，因此读取其行数组，不会生成副本。
			return this.cache!.lines;
		}

		// Apply background and padding
		// 缓存未命中，开始创建这次完整结果。
		const result: string[] = [];

		// Top padding
		// 生成顶部留白行，次数由配置直接决定。
		for (let i = 0; i < this.paddingY; i++) {
			// 空文本经 applyBg 补满宽度并加背景。
			result.push(this.applyBg("", width));
		}

		// Content
		// 遍历已经收集好的孩子正文。
		for (const line of childLines) {
			// 先加左边距，再由 applyBg 补右侧剩余宽度与背景；超宽文字不在这里裁剪。
			result.push(this.applyBg(leftPad + line, width));
		}

		// Bottom padding
		// 生成同样数量的底部留白行。
		for (let i = 0; i < this.paddingY; i++) {
			// 底部空白也应用背景。
			result.push(this.applyBg("", width));
		}

		// Update cache
		// 整理拼接字符串的内部存储，不改变文字内容或行顺序。
		flattenLines(result);
		// 对象属性简写保存原始行、请求宽度、背景样本及最终结果，供后续调用比较。
		this.cache = { childLines, width, bgSample, lines: result };

		// 返回本次结果数组；调用方应把缓存数组当作只读结果使用。
		return result;
	}

	// 把一行补到至少 width 列，再可选应用背景，返回新字符串；输入超宽时不会截断。
	// 例：applyBg("a", 3) 会先得到 "a  "；可选回调会被实际执行，抛错继续向上传播。
	private applyBg(line: string, width: number): string {
		// 计算可见列数，ANSI 样式本身不占显示列。
		const visLen = visibleWidth(line);
		// 不足才补，已经足够宽则补 0 列。
		const padNeeded = Math.max(0, width - visLen);
		// 把需要的右侧空格接在行后。
		const padded = line + " ".repeat(padNeeded);
		// Already padded to width, so apply the background directly instead of measuring the line again.
		// 有背景函数时直接调用并返回，否则返回补齐后的纯文本；避免再次计算行宽。
		return this.bgFn ? this.bgFn(padded) : padded;
	}
}
