// 组成全屏聊天布局：上方是可滚动的记录，下方是输入/状态/插件/页脚组成的底部区域（dock）；只创建组件树，不启动终端或执行模型。
// 带type的接口在JS中擦除，ScrollView/VStack是实际构造器，分别保存滚动状态和竖向布局规则。
import { type Component, ScrollView, type ScrollViewScrollbar, VStack } from "@earendil-works/pi-tui";

// 宿主先建好各区域组件再传进来；readonly只禁止TS重赋配置属性，不深冻结组件。
export interface ChatViewportOptions {
	// 聊天记录正文，包进唯一的ScrollView内容，不包含下面固定输入区。
	readonly document: Component;
	// 等待发送的消息区域，放dock最上方，可收缩到零高度。
	readonly pendingMessages: Component;
	// 运行/重试/压缩等状态区域，真正状态内容由宿主组件决定。
	readonly status: Component;
	// 输入编辑器，布局最小高度配置为三行；极小屏幕仍受外层可用区域裁剪，不保证总能完整看见三行。
	readonly editor: Component;
	// 输入区最后一项页脚，是否为空由组件自身render决定。
	readonly footer: Component;
	// 可省略的输入框上方扩展区域；缺省时不往数组插占位项。
	readonly widgetsAbove?: Component;
	// 可省略的输入框下方扩展区域，位置在页脚前。
	readonly widgetsBelow?: Component;
	// 可选滚动条策略，函数缺省采用auto，区别于ScrollView自身的hidden默认值。
	readonly scrollbar?: ScrollViewScrollbar;
	// 可选轨道符号样式回调，创建时只保存，实际布局绘制时才调用。
	readonly scrollbarTrackStyle?: (text: string) => string;
	// 可选滑块符号样式回调，不在这里向系统发送滚动事件。
	readonly scrollbarThumbStyle?: (text: string) => string;
}

// 返回布局根及独立滚动句柄；宿主把root交全屏TUI，并可用transcript.scrollToEnd等控制记录位置。
export interface ChatViewport {
	// 组件树根，类型只需Component，实际本函数创建VStack。
	readonly root: Component;
	// 与root内第一个孩子是同一个ScrollView，不是复制的状态对象。
	readonly transcript: ScrollView;
}

/** Shared fullscreen transcript and fixed input-dock layout. */
// 创建记录滚动壳→组输入dock→把二者竖排，返回root/transcript。例：只提供五个必需区域时没有扩展项，记录跟随末尾、输入至少按三行参与分配；只保存引用/布局，不渲染、落盘或安装输入监听。
export function createChatViewport(options: ChatViewportOptions): ChatViewport {
	// document作为唯一内容，ScrollView的普通render仍返回全部记录，真正有限视口裁剪由TUI布局器负责。
	const transcript = new ScrollView(options.document, {
		// 配置末尾跟随能力，用户向上滚动可暂停，布局获知新高度后才定位实际末尾。
		follow: "end",
		// 标为主要滚动区，供TUI选择默认/兜底滚动目标，不强制全树只有一个primary。
		primary: true,
		// 表达越界向外链传的策略；ScrollView返回未消耗量，真正路由由TUI完成。
		overscroll: "chain",
		// ??仅null/undefined回auto，显式hidden或always保留；auto在交互后暂显并非永远占一列。
		scrollbar: options.scrollbar ?? "auto",
		// 有函数才展开此属性，缺省让ScrollView采用自己的默认轨道样式；不立即执行回调。
		...(options.scrollbarTrackStyle === undefined ? {} : { scrollbarTrackStyle: options.scrollbarTrackStyle }),
		// 滑块同理；对象展开只复制属性，函数引用仍是调用方那一个。
		...(options.scrollbarThumbStyle === undefined ? {} : { scrollbarThumbStyle: options.scrollbarThumbStyle }),
	});
	// dock内按数组顺序从上到下排，默认basis:auto按自然高度起步；shrink是收缩权重，不是最终固定行数。
	const dock = new VStack([
		// 排队消息可在空间不足时收缩，下限0允许完全不占行。
		{ component: options.pendingMessages, shrink: 1, minSize: 0 },
		// 状态区也可收缩至0，不代表取消底层任务或销毁组件。
		{ component: options.status, shrink: 1, minSize: 0 },
		// 条件数组展开：缺省展开[]，有区域则展开一个条目，避免把undefined当组件加入。
		...(options.widgetsAbove === undefined ? [] : [{ component: options.widgetsAbove, shrink: 1, minSize: 0 }]),
		// 编辑器参与同样的加权收缩，但本条目自身下限3；所有最小值无法同时满足时不能推断总布局必适配屏幕。
		{ component: options.editor, shrink: 1, minSize: 3 },
		// 扩展下方区夹在编辑器与页脚之间，可收缩为0。
		...(options.widgetsBelow === undefined ? [] : [{ component: options.widgetsBelow, shrink: 1, minSize: 0 }]),
		// 页脚最后排，必要时也可隐藏于0高度，并非绝对定位屏幕最后一行。
		{ component: options.footer, shrink: 1, minSize: 0 },
	]);
	// 返回新包装对象，里面组件仍是前面构造/宿主传入的原引用。
	return {
		// 属性简写将transcript句柄暴露给宿主。
		transcript,
		// 外层同样竖排，上方记录、下方dock；输入区不放进记录滚动内容里。
		root: new VStack([
			// 记录基础0，拿剩余空间的增长权重1，下限1；basis不是文档总行数，文档在其内部滚动。
			{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			// dock自然高度起步、不主动分剩余空间，但允许收缩且外层下限1；具体高度由布局器结合孩子测量决定。
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]),
	};
}
