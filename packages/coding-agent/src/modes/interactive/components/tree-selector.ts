// 把同一会话的全历史画成可搜索、折叠、标记的树；组件只通知所选 id，导航、可选模型摘要和剪贴板写入由 InteractiveMode 宿主处理。
// 这里同时存在原始父链、过滤后的可见父链和屏幕行，修改显示缩进不会改写历史条目的 parentId。
import {
	// type 只导入接口，编译后擦除；下面的 implements 要求类提供对应方法，不自动实现这些方法。
	type Component,
	// Container 将子组件依加入顺序组合，外壳在树列表和标签编辑器之间切换内容。
	Container,
	// Focusable 是 focused 属性的约定，供宿主把输入法光标焦点传给标签输入框。
	type Focusable,
	// 读取当前键位配置，而不是把默认按键字节硬编码在组件里。
	getKeybindings,
	// Input 处理标签文字编辑；树搜索本身使用本文件的字符串字段，不使用这个输入框。
	Input,
	// Keybinding 是动作名类型，帮助提示也随用户配置读取对应按键。
	type Keybinding,
	// Spacer 提供空行，后面的 Text 负责普通说明文字的布局。
	Spacer,
	// sliceByColumn 按终端显示列切片并识别受支持的控制码，不按字符串 length 截取。
	sliceByColumn,
	Text,
	// truncateToWidth 按显示列保留前缀，超宽才添加省略符；第三参数空串表示不要省略符。
	truncateToWidth,
	// visibleWidth 计算估算终端列宽，颜色码不占列，宽字和 UTF-16 码元数量不同。
	visibleWidth,
	// wrapTextWithAnsi 为帮助文字换行，保持受支持样式，不在这里输出终端。
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
// 树节点接口来自 SessionManager.getTree：包装与 children 是新建的，但 entry 仍引用原条目；不是深复制历史。
import type { SessionTreeNode } from "../../../core/session-manager.ts";
// read 参数行号只做显示格式化，有限数值/数字字符串可显示范围，不替代真实工具参数校验。
import { formatReadLineRange } from "../../../core/tools/render-utils.ts";
// 把主目录内的绝对路径缩成 ~ 仅用于展示，不改变执行工具的真实路径。
import { shortenHomePath } from "../../../utils/paths.ts";
// 共享主题提供颜色、粗体、背景；同一次渲染读取当前主题。
import { theme } from "../theme/theme.ts";
// 横向边框只按宽度生成一行，不管理树状态。
import { DynamicBorder } from "./dynamic-border.ts";
// 按当前配置格式化按键提示；这些帮助函数不执行键盘动作。
import { formatKeyText, keyHint } from "./keybinding-hints.ts";

/** Gutter info: position (displayIndent where connector was) and whether to show │ */
// 祖先分支在某层是否还要延续竖线；这是显示信息，不是另一个真实节点。
interface GutterInfo {
	// 每层占三个显示位置，position 指层号，不是源字符串下标。
	position: number; // displayIndent level where the connector was shown
	// true 画竖线，false 留空，表示这个祖先分支已到最后一个兄弟。
	show: boolean; // true = show │, false = show spaces
}

/** Flattened tree node for navigation */
// 把树展开成列表后的包装；下面的视觉字段会在过滤后重新计算，node 保留原树包装引用。
interface FlatNode {
	// 引用 SessionTreeNode，能够回到原 entry 和 children；没有复制消息正文。
	node: SessionTreeNode;
	/** Indentation level (each level = 3 chars) */
	// 视觉缩进层数，一层占三列；单子链可以保持同一层，不等于真实树深度。
	indent: number;
	/** Whether to show connector (├─ or └─) - true if parent has multiple children */
	// 是否具有兄弟分叉连接线，虚拟根的直接孩子还会额外抑制这条线。
	showConnector: boolean;
	/** If showConnector, true = last sibling (└─), false = not last (├─) */
	// 同父顺序的末项用末端弯线，否则画还可继续的分叉线。
	isLast: boolean;
	/** Gutter info for each ancestor branch point */
	// 数组列出祖先分支应占据的竖线层；GutterInfo[] 是元素类型为接口的数组。
	gutters: GutterInfo[];
	/** True if this node is a root under a virtual branching root (multiple roots) */
	// 森林用一个仅供排版的虚拟根组织，这个标记识别它的直接孩子，不往历史插入真实根。
	isVirtualRootChild: boolean;
}

// 一行在横向裁剪前的结构；固定游标与可移动正文分开，方便保留导航位置。
interface HorizontalViewportRow {
	// 左侧固定两列游标区域，可带选中背景控制码。
	gutter: string;
	// 可横向平移的完整行主体，含缩进、标记、标签和内容。
	body: string;
	// 主体中缩进/标记结束处的显示列坐标，位置在标签和正文之前。
	anchorCol: number;
	// 完整 body 的估算显示列宽，不是 body.length。
	bodyWidth: number;
	// 本行是否选中，横向视口只依当前选中行的锚点决定是否左移。
	isSelected: boolean;
}

// 游标区域预留两列，主体的可用宽度需从总宽度减去它。
const TREE_GUTTER_WIDTH = 2;
// 希望锚点后至少留出四列；极窄视口不一定能真的满足这个期望。
const MIN_VISIBLE_ANCHOR_CONTENT_WIDTH = 4;
// 锚点后期望可见内容最多按二十列计算，不要求整段消息始终显示。
const MAX_VISIBLE_ANCHOR_CONTENT_WIDTH = 20;
// 左移时锚点前希望保留的上下文最少两列。
const MIN_ANCHOR_CONTEXT_WIDTH = 2;
// 上下文最多十二列，避免为了显示缩进而挤掉大量正文。
const MAX_ANCHOR_CONTEXT_WIDTH = 12;

/**
 * Render tree rows into a horizontally clipped viewport.
 *
 * The tree gutter is always kept visible. The row bodies are shifted left only
 * when the selected row's anchor (the start of its entry text after tree
 * indentation/markers) would otherwise be too far right to see useful content.
 */
// 输入当前可见行和总列宽，返回裁剪后的字符串行；无持久化滚动状态，不写终端。
// 先算主体容量和最宽行，再按选中锚点决定统一偏移，最后逐行裁剪；例：深分支前缀挤满屏幕时左移主体，但保留两列游标。
// 不是保证标签/正文一定可读：超长标签、极窄屏幕或宽字边界仍可能挤掉正文。
function renderHorizontalViewport(rows: HorizontalViewportRow[], width: number): string[] {
	// 主体容量至少为 0，宽度不足游标两列时仍由最终截断限制整行。
	const viewportWidth = Math.max(0, width - TREE_GUTTER_WIDTH);
	// reduce 从 0 起取这一批可见行的最大主体宽度，不扫描屏幕之外的条目。
	const maxBodyWidth = rows.reduce((max, row) => Math.max(max, row.bodyWidth), 0);
	// 只有主体比视口更宽才允许正向左移，不能移过最宽可见主体的末端。
	const maxHorizontalScroll = Math.max(0, maxBodyWidth - viewportWidth);
	// find 取第一个标为选中的行，没有则得到 undefined。
	const selectedRow = rows.find((row) => row.isSelected);

	// Only pan horizontally when needed to keep enough selected-row content visible after its anchor.
	// 每次渲染从零偏移重算，不保存用户手动横向滚动位置。
	let horizontalScroll = 0;
	// 必须有选中行且可见主体确实溢出，才尝试自动平移。
	if (selectedRow && maxHorizontalScroll > 0) {
		// 估算锚点后希望保留的内容列数，在下面的四到二十列范围内取值。
		const minVisibleAnchorContentWidth = Math.min(
			// 最外层 min 将期望内容上限限制为二十列。
			MAX_VISIBLE_ANCHOR_CONTENT_WIDTH,
			// 取视口三分之一向下取整，再用 max 保证期望至少四列。
			Math.max(MIN_VISIBLE_ANCHOR_CONTENT_WIDTH, Math.floor(viewportWidth / 3)),
		);
		// 锚点太靠右，导致其后剩余空间不足期望值时才移动；相等时不动。
		if (selectedRow.anchorCol > viewportWidth - minVisibleAnchorContentWidth) {
			// 为锚点前缀留下部分上下文，计算范围是二到十二列。
			const anchorContextWidth = Math.min(
				// 上下文上限为十二列。
				MAX_ANCHOR_CONTEXT_WIDTH,
				// 用视口四分之一向下取整，再抬到至少两列。
				Math.max(MIN_ANCHOR_CONTEXT_WIDTH, Math.floor(viewportWidth / 4)),
			);
			// 把锚点尽量移到上下文宽度处，但不能超过最宽可见主体所允许的偏移。
			horizontalScroll = Math.min(maxHorizontalScroll, selectedRow.anchorCol - anchorContextWidth);
		}
	}

	// Clip only the body; the fixed-width gutter remains visible as navigation context.
	// map 逐行生成新字符串数组，所有行共用同一个偏移，原 rows 不改。
	return rows.map((row) => {
		// 三元表达式拼出最终待裁剪行，固定游标始终在主体前面。
		const line =
			// 正偏移才切主体，零偏移保留完整主体给最后的截断处理。
			horizontalScroll > 0
				? // true 排除越过右边界的宽字，跨左边界的宽字也整字丢弃；末尾 SGR reset 关闭样式，不是全面清除所有终端控制状态。
					`${row.gutter}${sliceByColumn(row.body, horizontalScroll, viewportWidth, true)}\x1b[0m`
				: // 不需要平移时直接连接 gutter 和 body，之后仍限制总列宽。
					row.gutter + row.body;
		// 最终按总宽度裁剪，不加省略号；这一步也处理不足两列的极窄屏幕。
		return truncateToWidth(line, width, "");
	});
}

/** Filter mode for tree display */
// 字符串字面量联合类型限定五个筛选模式；只约束 TS 调用者，不会自动校验任意运行时字符串。all 仍受后面的通用隐藏规则约束。
export type FilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

/**
 * Tree list component with selection and ASCII art visualization
 */
/** Tool call info for lookup */
// 从 assistant 的工具调用块提取名称和参数，给 toolResult 行显示调用摘要；不是保存工具执行结果。
interface ToolCallInfo {
	// 工具名用于选用 read/bash 等不同显示格式。
	name: string;
	// Record<string, unknown> 表示字符串键到未知值，不能只凭类型断言每个参数都是字符串。
	arguments: Record<string, unknown>;
}

// 内部列表维护展开顺序、可见节点和选择；不继承 Container，render 自己拼行，handleInput 自己匹配动作。
class TreeList implements Component {
	// 所有展开包装，包含之后会被隐藏的条目；数组中的 node 仍是输入树包装引用。
	private flatNodes: FlatNode[] = [];
	// 过滤和折叠之后的包装列表；元素可与 flatNodes 共享，不是深复制。
	private filteredNodes: FlatNode[] = [];
	// 选中的是 filteredNodes 的 0 基下标，不是历史条目 id。
	private selectedIndex = 0;
	// string | null 联合表示构造时的真实叶子，可为无当前条目的空位置；之后不会自动追踪宿主变化。
	private currentLeafId: string | null;
	// 构造时固定的最大条目行数，不含状态/帮助等外壳行。
	private maxVisibleLines: number;
	// 显式类型只允许五种模式，默认隐藏设置类记录等内容。
	private filterMode: FilterMode = "default";
	// 搜索字符串从空串开始，按输入追加；没有独立 Input 光标或选区。
	private searchQuery = "";
	// Map 把工具调用 id 关联到显示所需信息；同 id 再次 set 会覆盖旧值。
	private toolCallMap: Map<string, ToolCallInfo> = new Map();
	// 是否有多个可见根；初始从完整树算，过滤重排后按可见森林更新。
	private multipleRoots = false;
	// 只控制标签时间显示，默认关闭，不改变标签数据。
	private showLabelTimestamps = false;
	// Set 存构造时叶子沿原父链的 id，渲染用它加活动路径圆点。
	private activePathIds: Set<string> = new Set();
	// 可见节点到最近可见父节点的索引，null 代表可见根，不一定是原历史根。
	private visibleParentMap: Map<string, string | null> = new Map();
	// 可见父 id 到子 id 数组；null 键专门存可见根列表。
	private visibleChildrenMap: Map<string | null, string[]> = new Map();
	// 记住最近有效选择的 id，临时空结果不会马上丢掉原位置。
	private lastSelectedId: string | null = null;
	// 已折叠节点的 id 集合，折叠不删除历史，搜索/切模式会清除此集合。
	private foldedNodes: Set<string> = new Set();

	// 可选选择回调只接收条目 id；=> void 表示此处不使用返回值，不等待宿主的 Promise。
	public onSelect?: (entryId: string) => void;
	// 可选取消回调由宿主关闭界面，列表不会自行从 TUI 移除。
	public onCancel?: () => void;
	// 复制回调收到完整可复制文本或 undefined；真正写剪贴板由宿主完成。
	public onCopy?: (text: string | undefined) => void;
	// 通知外壳打开标签编辑器，当前标签允许 undefined 表示未设置。
	public onLabelEdit?: (entryId: string, currentLabel: string | undefined) => void;

	// 根据输入树/叶子/行数建立显示状态：展开并索引工具调用，标出活动路径，过滤后定位初始选择；返回新列表，无文件或模型请求。
	// 例：目标 model_change 被默认隐藏时，游标沿原父链退到最近可见消息；找不到可见祖先则选最后可见项。
	// 节点预期构成正常无环树；这里用迭代避免深递归，但不做通用环检测，坏父链/孩子环仍可能不终止。
	constructor(
		// 根节点数组通常来自 SessionManager.getTree，可能是一棵树或多根森林。
		tree: SessionTreeNode[],
		// 真实当前叶子用于路径标记、分支优先排序、默认初选及无文字助手豁免，和用户移动的游标位置分开。
		currentLeafId: string | null,
		// 控制每次最多画多少条目行，外层根据构造时终端高度计算。
		maxVisibleLines: number,
		// 可选初始游标 id，例如取消摘要对话框后重新打开树时恢复所选位置。
		initialSelectedId?: string,
		// 可选模式只在 null/undefined 时回退 default；这里不运行额外模式验证。
		initialFilterMode?: FilterMode,
	) {
		// 保存当前叶子快照，不因后续 onSelect 自动改掉。
		this.currentLeafId = currentLeafId;
		// 保存一次传入的行数预算，后续终端尺寸变化不会自动重算该字段。
		this.maxVisibleLines = maxVisibleLines;
		// ?? 空值合并只回退 null/undefined，不把空字符串当作缺省。
		this.filterMode = initialFilterMode ?? "default";
		// 初步标记完整输入树是否多根，展开时据此计算连接线。
		this.multipleRoots = tree.length > 1;
		// 迭代展开所有条目，同时填充工具调用索引；不执行那些工具。
		this.flatNodes = this.flattenTree(tree);
		// 从叶子沿原父链建立活动路径 id 集合。
		this.buildActivePath();
		// 应用模式、搜索和折叠，再计算可见父子关系及排版。
		this.applyFilter();

		// Start with initialSelectedId if provided, otherwise current leaf
		// 显式初始 id 优先于真实叶子，二者都缺省时随后走末项回退。
		const targetId = initialSelectedId ?? currentLeafId;
		// 把目标 id 转成可见数组下标，隐藏的目标尝试向父节点寻找。
		this.selectedIndex = this.findNearestVisibleIndex(targetId);
		// 可选链保护空列表，?? null 记录当前没有有效选择。
		this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? null;
	}

	/**
	 * Find the index of the nearest visible entry, walking up the parent chain if needed.
	 * Returns the index in filteredNodes, or the last index as fallback.
	 */
	// 输入目标 id，返回 filteredNodes 中最近可见自身/祖先的下标，不改状态；无可见节点时返回占位 0。
	// 先建完整父链索引和可见下标索引，再向上走；例：B 被隐藏而父 A 可见时返回 A，目标缺失或一路不可见则返回末项。父链没有环检测。
	private findNearestVisibleIndex(entryId: string | null): number {
		// 空列表没有真实下标，0 只是调用者可保存的占位值。
		if (this.filteredNodes.length === 0) return 0;

		// Build a map for parent lookup
		// Map<string, FlatNode> 保存全树包装，允许穿过过滤掉的父节点。
		const entryMap = new Map<string, FlatNode>();
		// 遍历完整展开列表，不只遍历可见候选。
		for (const flatNode of this.flatNodes) {
			// 按条目 id 建索引，同 id 后写会覆盖先写，此处不校验唯一性。
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		// Build a map of visible entry IDs to their indices in filteredNodes
		// map 回调把每个可见 id 与其下标组成键值对，再由 Map 建查找表。
		const visibleIdToIndex = new Map<string, number>(this.filteredNodes.map((node, i) => [node.node.entry.id, i]));

		// Walk from entryId up to root, looking for a visible entry
		// let 游标可逐步改为父 id，初值允许 null。
		let currentId = entryId;
		// null 表示父链结束；每轮都先判断当前自身是否可见。
		while (currentId !== null) {
			// Map.get 未命中是 undefined，合法下标 0 也需要识别。
			const index = visibleIdToIndex.get(currentId);
			// 显式 !== undefined 不会把 0 误判为缺失。
			if (index !== undefined) return index;
			// 当前节点隐藏时，从全树索引查它原来的父 id。
			const node = entryMap.get(currentId);
			// 索引缺项便停止，不凭空补父节点。
			if (!node) break;
			// 沿原条目的 parentId 上移，?? null 统一空父位置。
			currentId = node.node.entry.parentId ?? null;
		}

		// Fallback: last visible entry
		// 没有可见自身/祖先时选择最后可见项，此时非空由函数入口保证。
		return this.filteredNodes.length - 1;
	}

	/** Build the set of entry IDs on the path from root to current leaf */
	// 清空并重建活动路径 Set，无参数/返回值，不改变原历史或游标。
	// 例：A→B→C 且 C 为真实叶子，三者都带活动路径标记；即使 B 被过滤，Set 仍可包含 B。缺失节点停止，未检测父链循环。
	private buildActivePath(): void {
		// clear 清掉上一次路径 id，复用 Set 实例。
		this.activePathIds.clear();
		// 没有真值叶子 id 时路径保持空，空字符串也走这里。
		if (!this.currentLeafId) return;

		// Build a map of id -> entry for parent lookup
		// 建立完整展开节点索引，用于原父链查询。
		const entryMap = new Map<string, FlatNode>();
		// 遍历所有包装，不依赖当前筛选结果。
		for (const flatNode of this.flatNodes) {
			// 把 id 对应到包装，后续只读其 entry.parentId。
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		// Walk from leaf to root
		// 显式联合类型允许游标由字符串最终变为 null。
		let currentId: string | null = this.currentLeafId;
		// 从叶子往根走，真值检查也会在空字符串处结束。
		while (currentId) {
			// 先记录 id 再查询节点，因此索引中缺失的初始叶子 id 也可能进入 Set。
			this.activePathIds.add(currentId);
			// 寻找当前 id 对应的完整树包装。
			const node = entryMap.get(currentId);
			// 缺少包装就停止，已加入的 id 不回滚。
			if (!node) break;
			// 原父节点成为下一轮游标，空值统一成 null。
			currentId = node.node.entry.parentId ?? null;
		}
	}

	// 输入根数组，返回先序排列的 FlatNode 新包装，同时重建本列表工具调用索引；输入 entry/children 不改。
	// 先自底向上标记哪个子树包含真实叶子，再把该根/分支稳定排前，显式栈展开并计算缩进/竖线。例：B/C 两分支中叶子在 C，界面先画 C，但原 children 仍保留原顺序。
	// 迭代能处理很深的正常树，不保证带环或重复节点的任意图安全；工具块仅做部分形状判断，类型断言不会补齐运行时字段。
	private flattenTree(roots: SessionTreeNode[]): FlatNode[] {
		// 结果数组装新 FlatNode，但其中 node 引用原 SessionTreeNode。
		const result: FlatNode[] = [];
		// 清旧工具调用映射，本次完整展开重新收集，不执行调用。
		this.toolCallMap.clear();

		// Indentation rules:
		// - At indent 0: stay at 0 unless parent has >1 children (then +1)
		// - At indent 1: children always go to indent 2 (visual grouping of subtree)
		// - At indent 2+: stay flat for single-child chains, +1 only if parent branches

		// Stack items: [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
		// 元组类型按位置规定七个字段，依次为节点、层数、刚分叉、连接线、末兄弟、祖先竖线、虚拟根孩子；不是任意长度数组。
		type StackItem = [SessionTreeNode, number, boolean, boolean, boolean, GutterInfo[], boolean];
		// 显式工作栈代替递归调用，pop 后进先出。
		const stack: StackItem[] = [];

		// Determine which subtrees contain the active leaf (to sort current branch first)
		// Use iterative post-order traversal to avoid stack overflow
		// Map 的键是节点对象身份，不是条目 id，值表示该子树含不含真实叶子。
		const containsActive = new Map<SessionTreeNode, boolean>();
		// 局部保存构造时的叶子 id，null 表示没有叶子。
		const leafId = this.currentLeafId;
		// 独立语句块只限定临时变量作用域，没有创建函数或异步任务。
		{
			// Build list in pre-order, then process in reverse for post-order effect
			// 先收集前序节点，倒序处理时孩子先于父节点。
			const allNodes: SessionTreeNode[] = [];
			// 展开运算符复制根数组容器，节点引用仍共享。
			const preOrderStack: SessionTreeNode[] = [...roots];
			// 只要还有待处理节点就继续迭代；没有 visited 集合来检测孩子环。
			while (preOrderStack.length > 0) {
				// pop 取栈顶，! 是编译期非空断言，依据 while 的非空条件，不增加运行时检查。
				const node = preOrderStack.pop()!;
				// 保留本次出栈顺序，稍后反向扫描。
				allNodes.push(node);
				// Push children in reverse so they're processed left-to-right
				// 孩子逆序入栈，使同父孩子之后按正向顺序出栈。
				for (let i = node.children.length - 1; i >= 0; i--) {
					// 压入实际孩子引用，不修改原 children 数组。
					preOrderStack.push(node.children[i]);
				}
			}
			// Process in reverse (post-order): children before parents
			// 倒序走已收集节点，相当于先算后代再算祖先。
			for (let i = allNodes.length - 1; i >= 0; i--) {
				// 读取当前节点对象，数组下标由循环边界约束。
				const node = allNodes[i];
				// 节点自身 id 等于真实叶子时先标为包含叶子；无叶子时初值 false。
				let has = leafId !== null && node.entry.id === leafId;
				// 再检查任一直接孩子是否已被标为包含叶子。
				for (const child of node.children) {
					// Map 查得 true 才进入，false 或 undefined 都不满足。
					if (containsActive.get(child)) {
						// 只要某孩子包含叶子，当前祖先也包含；这里不提前 break。
						has = true;
					}
				}
				// 存下当前节点的最终布尔值，后续其父节点和排序会读取。
				containsActive.set(node, has);
			}
		}

		// Add roots in reverse order, prioritizing the one containing the active leaf
		// If multiple roots, treat them as children of a virtual root that branches
		// 多个实际根按虚拟分叉根的孩子来排版，不在会话文件追加根条目。
		const multipleRoots = roots.length > 1;
		// 复制根数组再稳定排序：true 转 1、false 转 0，含叶子的根优先；同优先级保持输入顺序，非时间重排。
		const orderedRoots = [...roots].sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
		// 根逆序入工作栈，使排序后的首根最先处理。
		for (let i = orderedRoots.length - 1; i >= 0; i--) {
			// 末项布尔值依据排序后的兄弟位置，而非原数组位置。
			const isLast = i === orderedRoots.length - 1;
			// 多根初始缩进 1 且标记虚拟根孩子，单根缩进 0；七元组位置与上面的 StackItem 对应。
			stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, isLast, [], multipleRoots]);
		}

		// 不断弹出待展开节点，直到整个输入森林处理完。
		while (stack.length > 0) {
			// 数组解构一次取出七个工作字段；pop()! 断言栈不空只影响 TS。
			const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

			// Extract tool calls from assistant messages for later lookup
			// entry 保留原历史条目引用，不复制消息内容。
			const entry = node.entry;
			// 只有 assistant 消息可能提供本索引关注的工具调用块。
			if (entry.type === "message" && entry.message.role === "assistant") {
				// as 断言允许把 content 当 unknown 处理；不生成运行时类型转换或校验。
				const content = (entry.message as { content?: unknown }).content;
				// 实际判断 content 为数组后才遍历，其他内容不参与工具索引。
				if (Array.isArray(content)) {
					// 逐块查看，不触发工具执行或模型请求。
					for (const block of content) {
						// 先确认非 null 对象、有 type 且等于 toolCall；in 也能看见继承属性，并不要求自有键。
						if (typeof block === "object" && block !== null && "type" in block && block.type === "toolCall") {
							// 断言 id/name/arguments 的类型，没有再逐字段校验；损坏历史不因此被自动修正。
							const tc = block as { id: string; name: string; arguments: Record<string, unknown> };
							// 按工具调用 id 保存名称和参数引用，同 id 后出现覆盖先前值。
							this.toolCallMap.set(tc.id, { name: tc.name, arguments: tc.arguments });
						}
					}
				}
			}

			// 属性简写把当前视觉字段组成新包装，node 和 gutters 等引用未深复制。
			result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild });

			// 读取当前节点的实际孩子数组，后面的重排只创建新数组。
			const children = node.children;
			// 超过一个孩子才是直接分叉点，零/一个孩子都为 false。
			const multipleChildren = children.length > 1;

			// Order children so the branch containing the active leaf comes first
			// 立即调用的箭头函数 IIFE 只计算本节点孩子顺序，返回新数组并限制局部变量作用域。
			const orderedChildren = (() => {
				// 先收包含叶子的孩子，保持它们的原相对次序。
				const prioritized: SessionTreeNode[] = [];
				// 其余孩子放另一数组，同样不额外按时间排序。
				const rest: SessionTreeNode[] = [];
				// 按输入 children 顺序做稳定分组。
				for (const child of children) {
					// 该孩子子树含叶子时进入优先组。
					if (containsActive.get(child)) {
						// push 只改本地分组数组，不改原 children。
						prioritized.push(child);
					} else {
						// 其余孩子加入普通组。
						rest.push(child);
					}
				}
				// 两个数组展开拼接，优先组先出现在最终可见顺序。
				return [...prioritized, ...rest];
				// 结尾 () 立即执行刚定义的函数，不是注册稍后调用的回调。
			})();

			// Calculate child indent
			// let 声明稍后由三个排版分支赋值的层数。
			let childIndent: number;
			// 当前有多个孩子时，下一层要表现分叉。
			if (multipleChildren) {
				// Parent branches: children get +1
				// 分叉直接孩子比当前向右一层。
				childIndent = indent + 1;
				// 刚从分叉下来且当前层大于 0 时，即使只有一个孩子也再缩进一层作视觉分组。
			} else if (justBranched && indent > 0) {
				// First generation after a branch: +1 for visual grouping
				// 只有分叉后第一代额外加一，后续单子链不继续逐代右移。
				childIndent = indent + 1;
			} else {
				// Single-child chain: stay flat
				// 普通单子链保持层数，所以视觉缩进不等于历史父链长度。
				childIndent = indent;
			}

			// Build gutters for children
			// If this node showed a connector, add a gutter entry for descendants
			// Only add gutter if connector is actually displayed (not suppressed for virtual root children)
			// 虚拟根直接孩子的连接线被抑制，即使 showConnector 为 true 也不画。
			const connectorDisplayed = showConnector && !isVirtualRootChild;
			// When connector is displayed, add a gutter entry at the connector's position
			// Connector is at position (displayIndent - 1), so gutter should be there too
			// 多根视图整体减一层显示，最小为 0，和渲染时 displayIndent 的规则相同。
			const currentDisplayIndent = this.multipleRoots ? Math.max(0, indent - 1) : indent;
			// 连接线位于显示缩进之前一层，根附近用 0 作下界。
			const connectorPosition = Math.max(0, currentDisplayIndent - 1);
			// 条件表达式决定孩子是否新增一项祖先竖线信息。
			const childGutters: GutterInfo[] = connectorDisplayed
				? // 实际画过连接线才复制 gutters 并追加位置，非末兄弟的后代需要继续画竖线。
					[...gutters, { position: connectorPosition, show: !isLast }]
				: // 无连接线时共享已有 gutters 引用，下面只读它。
					gutters;

			// Add children in reverse order
			// 排序后的孩子逆序压栈，出栈时仍按优先顺序显示。
			for (let i = orderedChildren.length - 1; i >= 0; i--) {
				// 判断该孩子是不是新顺序中的最后兄弟。
				const childIsLast = i === orderedChildren.length - 1;
				// 为每个孩子构造下一轮七元组工作项。
				stack.push([
					// 第一项是原孩子节点引用。
					orderedChildren[i],
					// 第二项传刚算出的子层数。
					childIndent,
					// 第三项记录父节点这次是否分叉，供孩子下一代缩进规则使用。
					multipleChildren,
					// 第四项同样用父分叉标志，决定该孩子是否显示连接线。
					multipleChildren,
					// 第五项决定连接线是否是末端弯线。
					childIsLast,
					// 第六项携带沿祖先保留下来的竖线位置。
					childGutters,
					// 实际孩子都不是森林虚拟根的直接孩子，最后一项为 false。
					false,
				]);
			}
		}

		// 完整展开结果交给调用者保存，副作用仅是本列表重建了工具映射。
		return result;
	}

	// 重建可见数组并恢复选择，无参数/返回值；依次执行通用隐藏、模式、搜索、折叠、可见排版，再找原选择或祖先。
	// 例：从 assistant 切 user-only 时退到其最近可见 user；切到无标签的空结果再切回仍记得旧 id。只改变内存视图，不删除历史。
	// all 仍隐藏 usage 和通常无文字的 assistant；当前叶子只豁免无文字 assistant 检查，仍可能被模式/搜索隐藏。
	private applyFilter(): void {
		// Update lastSelectedId only when we have a valid selection (non-empty list)
		// This preserves the selection when switching through empty filter results
		// 只有旧可见列表非空才尝试更新记忆，防止切过空结果时丢掉位置。
		if (this.filteredNodes.length > 0) {
			// 有合法旧下标才取新 id，否则 ?? 保留先前记忆。
			this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
		}

		// 查询转小写，按一个或多个空白切词，再 filter(Boolean) 去空词；这是 AND 子串检索，不支持模糊分数、正则或引号短语语法。
		const searchTokens = this.searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

		// filter 创建新数组，元素仍是原 FlatNode 引用；回调返回 true 才保留。
		this.filteredNodes = this.flatNodes.filter((flatNode) => {
			// 局部取原历史条目，判别 type 后 TS 能收窄其联合类型。
			const entry = flatNode.node.entry;
			// usage 无论哪个模式都先隐藏，all 也不会显示它。
			if (entry.type === "usage") return false;
			// 真实叶子和当前游标位置不同，此标记仅用于下面的 assistant 豁免。
			const isCurrentLeaf = entry.id === this.currentLeafId;

			// Skip assistant messages with only tool calls (no text) unless error/aborted
			// Always show current leaf so active position is visible
			// 非当前叶子的 assistant 额外检查是否有内容；当前叶子只跳过此段，不跳过后面的筛选。
			if (entry.type === "message" && entry.message.role === "assistant" && !isCurrentLeaf) {
				// 宽松断言声明可选 stopReason/content，字段不存在时仍可能是 undefined。
				const msg = entry.message as { stopReason?: string; content?: unknown };
				// 真正查看有无非空文本；不是简单认为 content 数组非空就有文字。
				const hasText = this.hasTextContent(msg.content);
				// 实际条件是存在 truthy stopReason 且既非 stop 也非 toolUse；不限于错误/中止两个特定字符串。
				const isErrorOrAborted = msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";
				// Only hide if no text AND not an error/aborted message
				// 既没文字也不满足上述停止原因条件才隐藏。
				if (!hasText && !isErrorOrAborted) {
					// 这条通用隐藏发生在模式 switch 之前，all 不能重新救回已返回的节点。
					return false;
				}
			}

			// Apply filter mode
			// 先以 true 初始化，下面按模式重新决定。
			let passesFilter = true;
			// Entry types hidden in default view (settings/bookkeeping)
			// 设置/记账类条目的合并条件，只有这里列出的类型属于该组。
			const isSettingsEntry =
				// 标签变更是历史条目，和节点包装上解析后的 label 不同。
				entry.type === "label" ||
				// 上下文编辑条目也归入默认隐藏组，不在这里真正应用编辑。
				entry.type === "context_edit" ||
				// custom 是扩展状态条目，不等于可显示的 custom_message。
				entry.type === "custom" ||
				// 模型切换记录归入设置组。
				entry.type === "model_change" ||
				// 思考级别切换记录归入设置组。
				entry.type === "thinking_level_change" ||
				// 会话标题等信息记录归入设置组，|| 连接任一匹配即为 true。
				entry.type === "session_info";

			// switch 按当前模式选择规则，每个 break 只退出 switch，不退出外层 filter 回调。
			switch (this.filterMode) {
				// user-only 仅保留真实 user 消息，不含 custom_message。
				case "user-only":
					// Just user messages
					// 同时要求 message 条目和 user 角色，短路求值后才读 message.role。
					passesFilter = entry.type === "message" && entry.message.role === "user";
					break;
				// no-tools 在默认隐藏组之外，再排除 toolResult。
				case "no-tools":
					// Default minus tool results
					// ! 否定两组条件，不会删除磁盘工具结果，也不会重新显示先前隐藏的 assistant 工具调用行。
					passesFilter = !isSettingsEntry && !(entry.type === "message" && entry.message.role === "toolResult");
					break;
				// labeled-only 根据包装上的解析标签判断，不根据条目本身 type 判断。
				case "labeled-only":
					// Just labeled entries
					// 只要不是 undefined 就算带标签，空字符串也会通过，虽然渲染标签用的是真值条件。
					passesFilter = flatNode.node.label !== undefined;
					break;
				// all 只放宽这一层模式规则，前置隐藏、搜索和折叠仍生效。
				case "all":
					// Show everything
					// 这里直接设 true，不能撤销更早已经 return false 的条目。
					passesFilter = true;
					break;
				// default 分支包含正常 default，也会接住未经过运行时校验的其他模式值。
				default:
					// Default mode: hide settings/bookkeeping entries
					// 默认只排除上面列出的设置组，工具结果通常仍可显示。
					passesFilter = !isSettingsEntry;
					break;
			}

			// 模式未通过就停止检查本节点，不再生成搜索文本。
			if (!passesFilter) return false;

			// Apply search filter
			// 没有实际搜索词时跳过文本提取；仅空白 query 得到零词，但查询字符串本身仍非空。
			if (searchTokens.length > 0) {
				// 由条目类型取可搜索文本再转小写，不保证包含全部历史字段或全部正文。
				const nodeText = this.getSearchableText(flatNode.node).toLowerCase();
				// every 要求所有词都作为子串出现，词可分布在同节点拼接的不同字段中，不需要顺序相邻。
				return searchTokens.every((token) => nodeText.includes(token));
			}

			// 没有搜索词且已通过模式的节点保留。
			return true;
		});

		// Filter out descendants of folded nodes.
		// 折叠集合非空才额外扫描完整展开列表，避免仅按可见父子遗漏隐藏中间节点。
		if (this.foldedNodes.size > 0) {
			// Set 收集折叠节点的全部后代 id；仅自身折叠不会使它加入，但它若也属于另一个折叠节点的后代，仍会被隐藏。
			const skipSet = new Set<string>();
			// flatNodes 是父先子的展开顺序，因此父节点已进入 skipSet 时可继续向下传播。
			for (const flatNode of this.flatNodes) {
				// 对象解构同时拿真实 id 和原 parentId，不使用过滤后的视觉父链。
				const { id, parentId } = flatNode.node.entry;
				// 原父被折叠或已经属于隐藏后代，则该节点也需要隐藏；!= null 同时排除 null/undefined。
				if (parentId != null && (this.foldedNodes.has(parentId) || skipSet.has(parentId))) {
					// 记录后代 id，后续它的孩子也能根据 skipSet 被标记。
					skipSet.add(id);
				}
			}
			// 从已通过模式/搜索的候选再滤掉后代，保留原候选相对顺序。
			this.filteredNodes = this.filteredNodes.filter((flatNode) => !skipSet.has(flatNode.node.entry.id));
		}

		// Recalculate visual structure (indent, connectors, gutters) based on visible tree
		// 重建可见父子和视觉字段，不改 entry.parentId；空结果时这个函数提前返回并保留旧索引。
		this.recalculateVisualStructure();

		// Try to preserve cursor on the same node, or find nearest visible ancestor
		// 有记忆 id 时优先定位自身/最近可见原祖先，允许跨过被隐藏的中间条目。
		if (this.lastSelectedId) {
			// 查找失败会回退最后可见项，空列表则得到占位 0。
			this.selectedIndex = this.findNearestVisibleIndex(this.lastSelectedId);
			// 没有记忆 id 时才做下标上界检查；这里不是通用双向夹取，负下标不由这段修正。
		} else if (this.selectedIndex >= this.filteredNodes.length) {
			// Clamp index if out of bounds
			// 越过尾部则退到末项，空列表用 0 占位。
			this.selectedIndex = Math.max(0, this.filteredNodes.length - 1);
		}

		// Update lastSelectedId to the actual selection (may have changed due to parent walk)
		// 结果非空才更新最后有效选择的记忆。
		if (this.filteredNodes.length > 0) {
			// 实际选择可能因向上找祖先改变，保存它而不是永远保留最初目标；无有效下标则保留旧记忆。
			this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
		}
	}

	/**
	 * Recompute indentation/connectors for the filtered view
	 *
	 * Filtering can hide intermediate entries; descendants attach to the nearest visible ancestor.
	 * Keep indentation semantics aligned with flattenTree() so single-child chains don't drift right.
	 */
	// 按当前筛选结果重新计算视觉父子关系、缩进和连接线，更新共享 FlatNode 的视觉字段及本列表索引，无磁盘写入。
	// 例：A→隐藏 B→可见 C，C 在界面接到 A 下，但 C.entry.parentId 仍是 B；每个可见节点按原父链寻找最近可见祖先，再迭代排版。
	// 依赖正常无环父链；空结果直接返回，不清空上一次的可见父子 Map 或 multipleRoots。
	private recalculateVisualStructure(): void {
		// 没有节点就不重算，保留旧索引；后续操作仍需检查是否存在选中项。
		if (this.filteredNodes.length === 0) return;

		// Set 快速判断某个原父 id 是否在可见结果中，map 只提取 id。
		const visibleIds = new Set(this.filteredNodes.map((n) => n.node.entry.id));

		// Build entry map for efficient parent lookup (using full tree)
		// 完整树索引用来跨越已隐藏的父节点，不能只索引过滤结果。
		const entryMap = new Map<string, FlatNode>();
		// 遍历每个完整展开包装。
		for (const flatNode of this.flatNodes) {
			// 同 id 后写覆盖，仍不在这里校验树唯一性或有无环。
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		// Find nearest visible ancestor for a node
		// 局部箭头函数输入当前节点 id，返回最近可见祖先或 null；不包含节点自身，查找失败也返回 null。例：C 的父 B 隐藏则继续查 A。
		const findVisibleAncestor = (nodeId: string): string | null => {
			// 从真实父 id 开始，可选链和 ?? 在索引缺失时得到 null。
			let currentId = entryMap.get(nodeId)?.node.entry.parentId ?? null;
			// 逐层沿原父链上行，没有 visited 或固定深度限制。
			while (currentId !== null) {
				// 父 id 已在可见集合时，无需继续爬更远。
				if (visibleIds.has(currentId)) {
					// 第一个命中的就是最近可见祖先。
					return currentId;
				}
				// 父节点同样可能隐藏，继续取它的原 parentId，缺项结束。
				currentId = entryMap.get(currentId)?.node.entry.parentId ?? null;
			}
			// 一路到根也没命中时，将该可见节点当作视图根。
			return null;
		};

		// Build visible tree structure:
		// - visibleParent: nodeId → nearest visible ancestor (or null for roots)
		// - visibleChildren: parentId → list of visible children (in filteredNodes order)
		// 本轮新建可见父索引，不先直接清空当前实例旧索引。
		const visibleParent = new Map<string, string | null>();
		// null 键支持多根森林，每个父对应按可见列表顺序排列的子 id 数组。
		const visibleChildren = new Map<string | null, string[]>();
		// 先准备根列表，保证之后 get(null)! 有容器可取。
		visibleChildren.set(null, []); // root-level nodes

		// 按过滤后的既有顺序连视图父子，保留活动分支优先的相对次序。
		for (const flatNode of this.filteredNodes) {
			// 取当前候选的真实条目 id。
			const nodeId = flatNode.node.entry.id;
			// 从原父链找最近可见祖先，可能越过多个隐藏节点。
			const ancestorId = findVisibleAncestor(nodeId);
			// 保存视觉父关系，和原 entry.parentId 分开。
			visibleParent.set(nodeId, ancestorId);

			// 首次遇到某个可见父时，先为它准备子数组。
			if (!visibleChildren.has(ancestorId)) {
				// 设置空数组，然后下一句统一追加。
				visibleChildren.set(ancestorId, []);
			}
			// ! 表示上面已保证该键有数组；push 改本地数组，不改输入 children。
			visibleChildren.get(ancestorId)!.push(nodeId);
		}

		// Update multipleRoots based on visible roots
		// 读取已经收集的视图根，null 键是视图约定，不是真实条目。
		const visibleRootIds = visibleChildren.get(null)!;
		// 可见根多于一个时才用虚拟分叉根的排版方式，即使原输入本来只有一个实际根。
		this.multipleRoots = visibleRootIds.length > 1;

		// Build a map for quick lookup: nodeId → FlatNode
		// 可见 id 到包装的索引，供工作栈快速修改对应视觉字段。
		const filteredNodeMap = new Map<string, FlatNode>();
		// 只给当前过滤结果建索引。
		for (const flatNode of this.filteredNodes) {
			// 值仍是原 FlatNode 对象引用，修改它也能通过 flatNodes 看见。
			filteredNodeMap.set(flatNode.node.entry.id, flatNode);
		}

		// DFS over the visible tree using flattenTree() indentation semantics
		// Stack items: [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
		// 七元组和 flattenTree 的字段布局相同，但第一项换成字符串 id，后六项继续携带排版状态。
		type StackItem = [string, number, boolean, boolean, boolean, GutterInfo[], boolean];
		// 局部栈迭代可见森林，避免用递归遍历正常深树。
		const stack: StackItem[] = [];

		// Add visible roots in reverse order (to process in forward order via stack)
		// 根逆序入栈，以便出栈时按已有正向顺序处理。
		for (let i = visibleRootIds.length - 1; i >= 0; i--) {
			// 依据可见根列表判断最后一个根，而非全历史根的位置。
			const isLast = i === visibleRootIds.length - 1;
			// 构造本轮根节点工作项，各项不是实际历史字段。
			stack.push([
				// 根 id 用于从 filteredNodeMap 查包装。
				visibleRootIds[i],
				// 多根初始层数 1，单根 0；渲染时多根再整体左移一层。
				this.multipleRoots ? 1 : 0,
				// 多根相当于刚经过一个虚拟分叉，影响下一代缩进。
				this.multipleRoots,
				// 同时记录该根有虚拟父分叉，但实际连接线会被虚拟根孩子标记抑制。
				this.multipleRoots,
				// 根是否最后兄弟，控制后代竖线是否继续。
				isLast,
				// 根没有已知祖先竖线，传新空数组。
				[],
				// 最后标志注明它是虚拟根的直接孩子，多根才为 true。
				this.multipleRoots,
			]);
		}

		// 栈中还有视图节点便继续处理。
		while (stack.length > 0) {
			// 解构七项状态，非空断言仅说服 TS，不执行额外保护。
			const [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

			// 通过 id 找本轮可见包装。
			const flatNode = filteredNodeMap.get(nodeId);
			// 索引未命中时忽略这个工作项，继续下一个。
			if (!flatNode) continue;

			// Update this node's visual properties
			// 只改 FlatNode 的视觉缩进，不改 entry 的真实父关系。
			flatNode.indent = indent;
			// 保存可见兄弟分叉所需的连接线标志。
			flatNode.showConnector = showConnector;
			// 保存当前兄弟顺序中的末项标志。
			flatNode.isLast = isLast;
			// 保存祖先竖线数组引用，渲染阶段只读取它。
			flatNode.gutters = gutters;
			// 保存虚拟根孩子标记，使森林根不多画一层连接线。
			flatNode.isVirtualRootChild = isVirtualRootChild;

			// Get visible children of this node
			// 读取可见孩子；没有键时用空数组，不把被过滤孩子重新接回来。
			const children = visibleChildren.get(nodeId) || [];
			// 按可见孩子数量决定是否分叉，区别于全树孩子数量。
			const multipleChildren = children.length > 1;

			// Child indent follows flattenTree(): branch points (and first generation after a branch) shift +1
			// 声明待分支赋值的子层数，和首次展开采用同一排版规则。
			let childIndent: number;
			// 多个可见孩子会形成真正显示的分叉。
			if (multipleChildren) {
				// 分叉直接孩子向右一层。
				childIndent = indent + 1;
				// 刚从分叉下来的第一代且当前层大于 0 时，额外缩进作视觉分组。
			} else if (justBranched && indent > 0) {
				// 第一代额外右移，不表示所有单子链都要逐代增加层数。
				childIndent = indent + 1;
			} else {
				// 普通单子链保持同层，长对话不会仅因轮数增加而无限向右漂移。
				childIndent = indent;
			}

			// Child gutters follow flattenTree() connector/gutter rules
			// 只有实际显示连接线的节点才给后代增加对应祖先竖线。
			const connectorDisplayed = showConnector && !isVirtualRootChild;
			// 多根视图的 displayIndent 比存储层数少一，最小 0。
			const currentDisplayIndent = this.multipleRoots ? Math.max(0, indent - 1) : indent;
			// 连接线位置在该显示层之前，至少取 0。
			const connectorPosition = Math.max(0, currentDisplayIndent - 1);
			// 准备传给孩子的祖先竖线数组。
			const childGutters: GutterInfo[] = connectorDisplayed
				? // 有连接线时用展开复制再追加，非末兄弟才保留后代的竖线。
					[...gutters, { position: connectorPosition, show: !isLast }]
				: // 无连接线时沿用原数组引用，不为每层无谓复制。
					gutters;

			// Add children in reverse order (to process in forward order via stack)
			// 可见孩子逆序入栈，保证出栈后的视觉次序与索引数组一致。
			for (let i = children.length - 1; i >= 0; i--) {
				// 可见兄弟的末项标志，不根据隐藏的兄弟计算。
				const childIsLast = i === children.length - 1;
				// 构造孩子的七元组，传给下一轮迭代。
				stack.push([
					// 第一项是可见孩子 id，非原节点对象。
					children[i],
					// 第二项是刚计算的子缩进。
					childIndent,
					// 第三项注明它的父节点是否多子分叉。
					multipleChildren,
					// 第四项同样记录父分叉，决定是否画孩子连接线。
					multipleChildren,
					// 第五项是孩子是否最后一个可见兄弟。
					childIsLast,
					// 第六项是沿当前祖先传下来的竖线。
					childGutters,
					// 实际后代不属于虚拟根的直接孩子，最后一项为 false。
					false,
				]);
			}
		}

		// Store visible tree maps for ancestor/descendant lookups in navigation
		// 计算完成后一次替换可见父索引，供跳分支段和折叠资格查询使用。
		this.visibleParentMap = visibleParent;
		// 孩子索引与同轮父索引配套保存，仅描述当前视图，不持久化。
		this.visibleChildrenMap = visibleChildren;
	}

	/** Get searchable text content from a node */
	// 按条目类型拼出供子串搜索的文字，不改节点；字段之间用空格连接。
	// 例：带 checkpoint 标签的 user 节点能同时匹配 user 和 checkpoint；普通消息正文只取前 200 UTF-16 码元，custom_message 字符串和分支摘要则可用全文。
	// 它不是完整全文检索：compaction 只加入类型词，不加入摘要；provider、时间、工具参数等也不会自动全部索引。
	private getSearchableText(node: SessionTreeNode): string {
		// 读取原条目，switch 的 type 判别可让 TS 收窄后续字段。
		const entry = node.entry;
		// 用字符串数组逐项收集，最后统一 join，避免在每个分支重复拼空格。
		const parts: string[] = [];

		// 只把真值标签纳入搜索；空标签在 labeled-only 中可能通过，却不贡献这里的文本。
		if (node.label) {
			// 标签作为一个搜索片段，与正文共同匹配。
			parts.push(node.label);
		}

		// 每种条目只添加有意义的显示/类别字段；未列出的类型不额外贡献片段。
		switch (entry.type) {
			// case 后的独立语句块让 msg 局部变量不与其他分支重名。
			case "message": {
				// message 既可能是 user/assistant，也可能是工具结果或 bash 执行消息。
				const msg = entry.message;
				// 把角色名加入，因此即使正文不含 user 也能按 user 子串匹配。
				parts.push(msg.role);
				// 检查联合消息是否带 content 且为真值，随后只抽取文字，不索引图片数据。
				if ("content" in msg && msg.content) {
					// extractContent 先完整抽文字再截前 200 码元，不是取前 200 token 或显示列。
					parts.push(this.extractContent(msg.content));
				}
				// bash 执行消息还额外索引 command，而非只看 output。
				if (msg.role === "bashExecution") {
					// 类型断言只声明命令可选，不在运行时补 command。
					const bashMsg = msg as { command?: string };
					// 命令为真值才加入，命令这里没有 200 码元截断。
					if (bashMsg.command) parts.push(bashMsg.command);
				}
				// break 退出 switch，本函数之后仍 join 所有片段。
				break;
			}
			// custom_message 区别于 custom 状态记录，可带文字或内容块数组。
			case "custom_message": {
				// 扩展自定义消息类型也可被搜索。
				parts.push(entry.customType);
				// typeof 收窄内容联合类型的字符串分支。
				if (typeof entry.content === "string") {
					// 字符串正文完整加入，不调用截短 helper。
					parts.push(entry.content);
				} else {
					// 内容块路径抽文字并限制前 200 码元，和字符串路径存在差异。
					parts.push(this.extractContent(entry.content));
				}
				// 完成该类型片段后退出 switch。
				break;
			}
			// 压缩条目只按固定类型词查找，摘要正文不会进入本函数搜索文本。
			case "compaction":
				// 加入 compaction 关键字，不触发真实压缩或模型总结。
				parts.push("compaction");
				break;
			// 分支摘要与 compaction 的搜索范围不同。
			case "branch_summary":
				// 同时加入 branch summary 类型词及完整 summary 原文。
				parts.push("branch summary", entry.summary);
				break;
			// 会话信息主要用标题词和可选名字检索。
			case "session_info":
				// 即使标题为空也加入 title 类型词。
				parts.push("title");
				// 只有真值 name 才加标题正文，空串不加入。
				if (entry.name) parts.push(entry.name);
				break;
			// 模型切换索引 model 词和模型 id，未另外加入 provider。
			case "model_change":
				// push 的两个参数依次成为两个片段。
				parts.push("model", entry.modelId);
				break;
			// 思考级别切换索引 thinking 和具体级别。
			case "thinking_level_change":
				// 保留级别原文字，统一小写发生在调用方。
				parts.push("thinking", entry.thinkingLevel);
				break;
			// custom 状态条目只查类型名，不序列化它任意 data。
			case "custom":
				// 添加 custom 和扩展声明的 customType。
				parts.push("custom", entry.customType);
				break;
			// 上下文编辑按类型、操作和目标 id 检索，不索引替换正文。
			case "context_edit":
				// null replacement 显示 omit，其余为 replace；这只是查询文本，不在此执行隐藏或替换。
				parts.push("context edit", entry.replacement === null ? "omit" : "replace", entry.targetId);
				break;
			// 标签变更条目自身也有搜索文字，和节点包装的解析标签是两个来源。
			case "label":
				// ?? 仅在标签缺省时补空串，不用 cleared 文字作搜索词。
				parts.push("label", entry.label ?? "");
				break;
		}

		// 以空格连接片段，词可分布在不同片段中；函数不排序、不持久化索引。
		return parts.join(" ");
	}

	// 组件失效接口为空，当前无渲染行缓存要清；例如换主题后下一次 render 自然读取主题，不在此申请重画。
	invalidate(): void {}

	// 返回当前原始查询字符串，不 trim 或转小写，无状态变更；例如搜索提示行要保留用户输入的空格。
	getSearchQuery(): string {
		// 直接返回字段值，真正分词在 applyFilter 中。
		return this.searchQuery;
	}

	// 返回当前可见选中节点的原包装引用，空结果/非法下标为 undefined；例：切空 labeled-only 后外层可据此禁用操作，不复制数据。
	getSelectedNode(): SessionTreeNode | undefined {
		// 可选链避免空项时读取 .node，不能把返回值当作独立副本随意修改。
		return this.filteredNodes[this.selectedIndex]?.node;
	}

	// 把当前节点的完整可复制文本交给 onCopy，返回 void，本函数不写系统剪贴板；例如长消息预览截到 200 码元，复制仍可得到全文。回调同步错误照常传播。
	copySelected(): void {
		// 先读当前可见选择，可能没有节点。
		const node = this.getSelectedNode();
		// ?. 只在回调存在时执行，因此无回调时连参数中的取正文也不会执行；无节点时传 undefined。
		this.onCopy?.(node ? this.getEntryCopyText(node) : undefined);
	}

	// 更新首个匹配 id 的树包装标签和时间，无返回值、不写磁盘、不重新过滤或排版。
	// 例：保存 checkpoint 后文字预览使用新标签，但当前 labeled-only/搜索成员不会立刻重算；外壳另调宿主回调追加标签历史。
	updateNodeLabel(entryId: string, label: string | undefined, labelTimestamp?: string): void {
		// 扫描完整展开数组，包含当前隐藏的节点。
		for (const flatNode of this.flatNodes) {
			// 只更新 id 严格相等的包装。
			if (flatNode.node.entry.id === entryId) {
				// 设置 label 为给定字符串或 undefined，修改的是 getTree 包装字段，不是 entry 正文。
				flatNode.node.label = label;
				// 真值标签使用显式时间或当前 ISO 时间；空串/undefined 清时间，?? 不把显式空时间串当缺省。
				flatNode.node.labelTimestamp = label ? (labelTimestamp ?? new Date().toISOString()) : undefined;
				// 只改首个匹配项，找到后结束扫描。
				break;
			}
		}
	}

	// 根据当前模式和标签时间开关生成状态后缀，返回字符串，不改变视图；例：all 加开关时得到两个后缀，default 且关闭时为空。
	private getStatusLabels(): string {
		// 从空串累计，默认模式没有单独标签。
		let labels = "";
		// switch 只决定显示文案，不在此重新应用筛选规则。
		switch (this.filterMode) {
			// no-tools 用固定状态后缀提示当前模式。
			case "no-tools":
				// += 拼接字符串，不改变原 mode 值。
				labels += " [no-tools]";
				break;
			// user-only 状态使用简写 user。
			case "user-only":
				// 加上用户视图后缀。
				labels += " [user]";
				break;
			// labeled-only 状态使用 labeled 简写。
			case "labeled-only":
				// 追加带标签筛选提示，不统计标签数量。
				labels += " [labeled]";
				break;
			// all 后缀只是模式名，不表示前置隐藏规则已经关闭。
			case "all":
				// 追加 all 提示。
				labels += " [all]";
				break;
		}
		// 显示时间开关可与任意模式后缀同时存在。
		if (this.showLabelTimestamps) {
			// 追加 label time 后缀，即使当前没有带时间的标签也会显示开关状态。
			labels += " [+label time]";
		}
		// 返回累计文字，由 render 放在计数后面。
		return labels;
	}

	// 按总终端列宽生成可见节点行和状态行，无文件/模型/剪贴板操作；先取垂直窗口，再组树前缀、标记、标签、内容，最后统一横向平移裁剪。
	// 例：深分支的缩进占满屏幕时保留游标两列，所有可见主体一起左移；maxVisibleLines 只限制条目行，不含额外状态行和外壳帮助。
	// 节点正文的预处理、工具参数 JSON 序列化或主题回调仍可能抛错，此处没有兜底 catch；非法日期则可能显示 NaN 字样。
	render(width: number): string[] {
		// 每次渲染新建行数组，避免复用上次已输出的字符串容器。
		const lines: string[] = [];

		// 过滤/折叠后没有条目时画空态，不进入节点窗口循环。
		if (this.filteredNodes.length === 0) {
			// 空态也按总宽度裁剪，默认省略符由 truncateToWidth 决定。
			lines.push(truncateToWidth(theme.fg("muted", "  No entries found"), width));
			// 再画 0/0 和模式/时间开关后缀，宽度同样受限制。
			lines.push(truncateToWidth(theme.fg("muted", `  (0/0)${this.getStatusLabels()}`), width));
			// 返回两行空态结果，没有真实选中节点。
			return lines;
		}

		// 计算尽量围绕选择位置的垂直窗口起点。
		const startIndex = Math.max(
			// 起点下界 0，防止靠近列表开头时出现负数。
			0,
			// 同时限制尾部窗口，避免还有上方候选时末尾不足一页。
			Math.min(
				// 从选中下标向前退半页，floor 将项数取整。
				this.selectedIndex - Math.floor(this.maxVisibleLines / 2),
				// 尾部上限等于总项数减页面项数，项数不足时这个值可为负，再由外层 max 修正。
				this.filteredNodes.length - this.maxVisibleLines,
			),
		);
		// 右开终点不超过总项数，一行对应一个可见节点。
		const endIndex = Math.min(startIndex + this.maxVisibleLines, this.filteredNodes.length);

		// 先收集结构化行，再根据选中锚点计算统一横向偏移。
		const renderedRows: HorizontalViewportRow[] = [];
		// 遍历当前窗口，i 是 filteredNodes 下标，不是历史写入顺序。
		for (let i = startIndex; i < endIndex; i++) {
			// FlatNode 提供当前重算后的视觉层数与连接线信息。
			const flatNode = this.filteredNodes[i];
			// entry 仍是原历史对象，只读其类型和 id 等字段。
			const entry = flatNode.node.entry;
			// 当前行是否选中，和是否处于真实活动路径分开判断。
			const isSelected = i === this.selectedIndex;

			// Build line: cursor + prefix + path marker + label + content
			// 游标固定两列，选择行带强调色，其他行用两个空格占同样位置。
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";

			// If multiple roots, shift display (roots at 0, not 1)
			// 多根去掉虚拟根占的一层，确保可见根从最左侧开始。
			const displayIndent = this.multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;

			// Build prefix with gutters at their correct positions
			// Each gutter has a position (displayIndent where its connector was shown)
			// 先判是否存在实际连接线，用字符串的真值辅助定位；后面逐位置重建最终前缀，不直接拼这条 connector。
			const connector =
				// 有连接线且不是虚拟根孩子才生成，末兄弟用末端连接符。
				flatNode.showConnector && !flatNode.isVirtualRootChild ? (flatNode.isLast ? "└─ " : "├─ ") : "";
			// 连接线占缩进最后一层，无连接线用 -1 哨兵，后面的层不会匹配它。
			const connectorPosition = connector ? displayIndent - 1 : -1;

			// Build prefix char by char, placing gutters and connector at their positions
			// 一层占三个位置，后面逐位置生成祖先竖线/当前连接线/空格。
			const totalChars = displayIndent * 3;
			// 字符串片段数组避免每个条件都直接改整行，最后 join。
			const prefixChars: string[] = [];
			// 折叠状态按真实 id 查询，不根据是否恰有可见后代推断。
			const isFolded = this.foldedNodes.has(entry.id);
			// 这里的 let i 是内层块作用域变量，与外层条目下标 i 分开，不会覆盖外层循环值。
			for (let i = 0; i < totalChars; i++) {
				// floor(i/3) 求当前字符属于哪一层视觉缩进。
				const level = Math.floor(i / 3);
				// i%3 得层内第 0、1、2 个位置。
				const posInLevel = i % 3;

				// Check if there's a gutter at this level
				// 寻找当前层是否有祖先竖线信息，只取第一个同 position 的项。
				const gutter = flatNode.gutters.find((g) => g.position === level);
				// 祖先 gutter 优先于当前 connector，占用这一层的位置。
				if (gutter) {
					// 竖线只画在每层首个位置。
					if (posInLevel === 0) {
						// show=false 时也留一列空格，保持对齐。
						prefixChars.push(gutter.show ? "│" : " ");
					} else {
						// 该层其余两列补空白，不重复画竖线。
						prefixChars.push(" ");
					}
					// 无祖先 gutter 且当前层正是连接线层时，改画当前节点连接符。
				} else if (connector && level === connectorPosition) {
					// Connector at this level, with fold indicator
					// 层内第 0 位画分叉角。
					if (posInLevel === 0) {
						// 最后兄弟与普通兄弟选择不同角形。
						prefixChars.push(flatNode.isLast ? "└" : "├");
						// 第 1 位既能表示横线，也能显示可折叠/已折叠状态。
					} else if (posInLevel === 1) {
						// 是否可折叠依当前可见父子关系，不直接看原 children.length。
						const foldable = this.isFoldable(entry.id);
						// 三元表达式先判断已折叠，再判断可折叠，否则画普通横线。
						prefixChars.push(isFolded ? "⊞" : foldable ? "⊟" : "─");
					} else {
						// 第 2 位留空格，将前缀和条目内容分开。
						prefixChars.push(" ");
					}
				} else {
					// 既无祖先竖线也无连接线的缩进位置全部用空格占位。
					prefixChars.push(" ");
				}
			}
			// 把单字符片段拼成一个前缀字符串，不附加分隔符。
			const prefix = prefixChars.join("");

			// Fold marker for nodes without connectors (roots)
			// 判断本行是否已经能在连接线中显示折叠符。
			const showsFoldInConnector = flatNode.showConnector && !flatNode.isVirtualRootChild;
			// 无连接线的折叠节点另画标记；未折叠根不会仅因可折叠就显示这个额外符号。
			const foldMarker = isFolded && !showsFoldInConnector ? theme.fg("accent", "⊞ ") : "";

			// Active path marker - shown right before the entry text
			// 活动路径取构造时叶子的原父链，和当前游标/可见父链不同。
			const isOnActivePath = this.activePathIds.has(entry.id);
			// 处于活动路径才在条目文本前加圆点，不表示用户此刻选择了它。
			const pathMarker = isOnActivePath ? theme.fg("accent", "• ") : "";

			// 只有真值标签画方括号；labeled-only 的 !==undefined 规则则也接受空串。
			const label = flatNode.node.label ? theme.fg("warning", `[${flatNode.node.label}] `) : "";
			// 标签时间是独立片段，不是条目原始 timestamp。
			const labelTimestamp =
				// 开关开启、有真值标签且时间也为真值时才格式化。
				this.showLabelTimestamps && flatNode.node.label && flatNode.node.labelTimestamp
					? // 按本地时区将标签时间转为简洁显示文字并加空格。
						theme.fg("muted", `${this.formatLabelTimestamp(flatNode.node.labelTimestamp)} `)
					: // 条件不满足则不占正文位置。
						"";
			// 依据条目类型取预览文字，选中时该 helper 还会给内容加粗。
			const content = this.getEntryDisplayText(flatNode.node, isSelected);
			// 树前缀淡色，折叠/活动标记各保留自己主题颜色。
			const prefixPart = theme.fg("dim", prefix) + foldMarker + pathMarker;
			// 锚点恰在树前缀和标记之后、标签之前；超长标签仍可能挤走真正消息正文。
			const anchorCol = visibleWidth(prefixPart);
			// 游标与主体分开保存，允许左移主体而固定游标。
			let gutter = cursor;
			// 主体依序拼前缀、标签、标签时间和条目预览。
			let body = prefixPart + label + labelTimestamp + content;
			// 只给选中行添加 selectedBg 背景，不在这里补齐到总行宽。
			if (isSelected) {
				// 固定游标区域也要带选中背景。
				gutter = theme.bg("selectedBg", gutter);
				// 主体背景独立包裹，裁剪时仍可保留样式。
				body = theme.bg("selectedBg", body);
			}
			// 保存显示列宽和锚点等结构，属性简写复用同名局部值。
			renderedRows.push({ gutter, body, anchorCol, bodyWidth: visibleWidth(body), isSelected });
		}

		// 展开运算符把裁剪后的字符串行逐条 push，非把整个数组当一行。
		lines.push(...renderHorizontalViewport(renderedRows, width));
		// 条目行之后另附一行当前选择计数与模式信息。
		lines.push(
			// 状态行也受总宽度限制，使用默认省略符。
			truncateToWidth(
				// selectedIndex+1 是面向用户的序号，总数是过滤/折叠后的条目数量。
				theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredNodes.length})${this.getStatusLabels()}`),
				// 状态行用完整终端宽度，不减游标区域，因为它不是 HorizontalViewportRow。
				width,
			),
		);

		// 返回字符串行数组，实际输出/重画由宿主 TUI 调度。
		return lines;
	}

	// 输入树包装和选中标记，返回供条目行布局使用的主题预览字符串；只格式化，不执行工具或应用上下文编辑。
	// 例：user 取前 200 码元文字，toolResult 优先展示原调用名称/参数，compaction 只显示压缩前 token 数量；复制全文另走 getEntryCopyText。
	// 先按条目 type、再按消息 role 分支，最后选中项加粗；并非全面控制字符清洗，只有部分文字路径替换 LF/tab，标签、标题或工具参数等仍可能含原控制字符/换行，格式化异常可传播。
	private getEntryDisplayText(node: SessionTreeNode, isSelected: boolean): string {
		// 读取原条目，后续 switch 收窄 SessionEntry 联合。
		const entry = node.entry;
		// 声明最后要返回的字符串，各类型分支都会赋值，default 给空串。
		let result: string;

		// 局部箭头函数把 LF/tab 各换成一个空格并 trim 首尾；例如多行预览铺成一行，但内部 CR/任意 ANSI 不因此全部删除。
		const normalize = (s: string) => s.replace(/[\n\t]/g, " ").trim();

		// 按历史条目 type 选预览，不把所有条目都当用户/助手消息。
		switch (entry.type) {
			// case 块限定 msg/role 等局部变量作用域。
			case "message": {
				// 取得消息联合，可能含用户、助手、工具或 bash 角色。
				const msg = entry.message;
				// 局部 role 供后面的 if/else 分类。
				const role = msg.role;
				// 用户消息只提取文字，图片/工具等块不当正文显示。
				if (role === "user") {
					// 断言 content 为可选未知值，不产生实际值转换。
					const msgWithContent = msg as { content?: unknown };
					// 先完整抽文字并截前 200 码元，再单行正规化；这里没有自动追加省略号来表示 helper 的截断。
					const content = normalize(this.extractContent(msgWithContent.content));
					// 角色标签用强调色，原消息正文接在其后。
					result = theme.fg("accent", "user: ") + content;
					// assistant 预览还需考虑中止和错误回退。
				} else if (role === "assistant") {
					// 宽松断言说明这三字段可缺，不做运行时 schema 检查。
					const msgWithContent = msg as { content?: unknown; stopReason?: string; errorMessage?: string };
					// 同样先限制文字前 200 码元，再去 LF/tab 与首尾空白。
					const textContent = normalize(this.extractContent(msgWithContent.content));
					// 有非空预览文字时优先显示它，即使 stopReason/errorMessage 也存在。
					if (textContent) {
						// 助手角色前缀用成功色，这是角色配色，不是说明模型一定成功执行。
						result = theme.fg("success", "assistant: ") + textContent;
						// 没有文字且停止原因为 aborted 时才显示中止占位。
					} else if (msgWithContent.stopReason === "aborted") {
						// 占位只描述已保存消息，不在此触发取消。
						result = theme.fg("success", "assistant: ") + theme.fg("muted", "(aborted)");
						// 没有文字、也没命中 aborted，但有真值错误文字时显示错误预览。
					} else if (msgWithContent.errorMessage) {
						// 错误先正规化再截 80 UTF-16 码元，不是 80 token 或显示列。
						const errMsg = normalize(msgWithContent.errorMessage).slice(0, 80);
						// 错误片段单独错误色，助手前缀仍沿用角色色。
						result = theme.fg("success", "assistant: ") + theme.fg("error", errMsg);
					} else {
						// 既无文字也无中止/错误描述时显示无内容占位。
						result = theme.fg("success", "assistant: ") + theme.fg("muted", "(no content)");
					}
					// 工具结果在树中主要用调用摘要识别，不把完整工具输出塞进这一行。
				} else if (role === "toolResult") {
					// 读取可选调用 id 和工具名，断言不会自动补上缺失字段。
					const toolMsg = msg as { toolCallId?: string; toolName?: string };
					// 调用 id 为真值时查先前展开树建立的映射，否则不查。
					const toolCall = toolMsg.toolCallId ? this.toolCallMap.get(toolMsg.toolCallId) : undefined;
					// 找到原调用信息才能展示参数摘要。
					if (toolCall) {
						// 根据工具名格式化参数，工具结果正文不参与这一条预览。
						result = theme.fg("muted", this.formatToolCall(toolCall.name, toolCall.arguments));
					} else {
						// 没有匹配调用时只显示工具名，?? 保留显式空字符串，不一律替换为 tool。
						result = theme.fg("muted", `[${toolMsg.toolName ?? "tool"}]`);
					}
					// 手动 bash 执行消息与名为 bash 的工具结果是不同角色路径。
				} else if (role === "bashExecution") {
					// 只需取可选命令，不预览执行输出。
					const bashMsg = msg as { command?: string };
					// 缺命令补空串，LF/tab 单行化后显示，不在这里再做 50 码元限制。
					result = theme.fg("dim", `[bash]: ${normalize(bashMsg.command ?? "")}`);
				} else {
					// 其余消息角色显示方括号角色名，不自动序列化所有字段。
					result = theme.fg("dim", `[${role}]`);
				}
				// 退出 message 分支的 switch，不提前退出整个函数。
				break;
			}
			// custom_message 支持原字符串或内容块数组，和 custom 状态条目区分。
			case "custom_message": {
				// 三元表达式先把两种内容形态统一为文字。
				const content =
					// typeof 收窄 content 的字符串分支。
					typeof entry.content === "string"
						? // 字符串直接保留全文，最后才由外层视口裁剪。
							entry.content
						: // 数组路径从原内容块读取，不复制或改写块。
							entry.content
								// c is ... 是类型谓词，运行时只检查块的 type；它不单独验证 text 的运行时类型。
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								// map 提取筛选后块的 text，TS 根据前面的谓词认为它是 string。
								.map((c) => c.text)
								// 空分隔符拼块，不主动在相邻块间加换行，也不应用 200 码元 helper 限制。
								.join("");
				// 扩展类型标签用自定义消息配色，正文再单行化。
				result = theme.fg("customMessageLabel", `[${entry.customType}]: `) + normalize(content);
				// 当前类型已完成赋值，退出 switch。
				break;
			}
			// 压缩条目在树上只显示事件和压缩前数量，不在本组件请求模型。
			case "compaction": {
				// 除以 1000 再四舍五入成 k 单位，可能丢掉实际 token 精度。
				const tokens = Math.round(entry.tokensBefore / 1000);
				// 这不是摘要 token 大小，也不是本次节省量，而是记录的 tokensBefore。
				result = theme.fg("borderAccent", `[compaction: ${tokens}k tokens]`);
				// 结束压缩预览分支。
				break;
			}
			// 分支摘要显示 summary 正文，与 compaction 的简短事件行不同。
			case "branch_summary":
				// 正规化完整摘要，没有在本 helper 截 200 码元；外层按视口限制显示。
				result = theme.fg("warning", `[branch summary]: `) + normalize(entry.summary);
				break;
			// 模型变化只显示 modelId，不另外拼 provider。
			case "model_change":
				// 渲染历史模型信息，不切换当前模型。
				result = theme.fg("dim", `[model: ${entry.modelId}]`);
				break;
			// 思考级别变化只展示已保存级别。
			case "thinking_level_change":
				// 不在此修改模型请求的 thinkingLevel。
				result = theme.fg("dim", `[thinking: ${entry.thinkingLevel}]`);
				break;
			// custom 是状态记录，用 customType 识别，不读取任意 data。
			case "custom":
				// 输出类型占位，实际扩展状态由其他层恢复。
				result = theme.fg("dim", `[custom: ${entry.customType}]`);
				break;
			// 上下文编辑只显示操作和目标条目 id。
			case "context_edit":
				// replacement===null 对应 omit，其余为 replace；本函数不对历史应用替换。
				result = theme.fg("dim", `[context ${entry.replacement === null ? "omit" : "replace"}: ${entry.targetId}]`);
				break;
			// 标签操作条目显示这一条变更内容，不等于被标记节点当前的解析 label。
			case "label":
				// 标签 null/undefined 显示 cleared；显式空串仍显示空串，因为 ?? 不是 ||。
				result = theme.fg("dim", `[label: ${entry.label ?? "(cleared)"}]`);
				break;
			// 会话信息条目展示标题，有无名字走真值分支。
			case "session_info":
				// name 为空串时进入 empty 文案分支，未使用 ?? 保留空标题。
				result = entry.name
					? // 有标题时分段着色再 join，原 name 未经过 normalize 清洗。
						[theme.fg("dim", "[title: "), theme.fg("dim", entry.name), theme.fg("dim", "]")].join("")
					: // 无标题时给 empty 加斜体；两种分支都生成完整方括号字符串。
						[theme.fg("dim", "[title: "), theme.italic(theme.fg("dim", "empty")), theme.fg("dim", "]")].join("");
				// 当前类型结束，后面统一处理选中样式。
				break;
			// 没有单独预览分支的类型回退空内容。
			default:
				// 空字符串仍可能在外层带树前缀/标签/活动路径标记。
				result = "";
		}

		// 选中时给整个预览加粗，未选中返回原样式字符串，不改变原条目。
		return isSelected ? theme.bold(result) : result;
	}

	// 把时间字符串格式化成本地时区的简写，返回文字、不改数据；今天仅 HH:mm，同年加 M/D，跨年加两位年份。
	// 例：本地当天 09:05 显示 09:05；日期由 new Date 解析，未验证有效性，非法输入可能显示 NaN 字样，不承诺时区无关格式。
	private formatLabelTimestamp(timestamp: string): string {
		// 解析保存的时间串，ISO 带时区会转为同一时刻，getHours 等读取机器本地时间。
		const date = new Date(timestamp);
		// 每次调用取当前时间，因此跨午夜重画可能改变显示形式。
		const now = new Date();
		// 小时转十进制字符串并左补 0 至至少两位，不会把长异常文字截成两位。
		const hours = date.getHours().toString().padStart(2, "0");
		// 分钟同样补零。
		const minutes = date.getMinutes().toString().padStart(2, "0");
		// 模板字符串用冒号拼时分。
		const time = `${hours}:${minutes}`;

		// 以下 && 同时比较本地年/月/日，判定是否同一天。
		if (
			// 先判断本地年份相同。
			date.getFullYear() === now.getFullYear() &&
			// 月份 getter 从 0 开始，比较时两边采用同一规则。
			date.getMonth() === now.getMonth() &&
			// 最后比较月中日，不比较星期或时间戳差是否小于 24 小时。
			date.getDate() === now.getDate()
		) {
			// 当天只显示时分，不显示日期。
			return time;
		}

		// 展示月份时把 0–11 转成 1–12。
		const month = date.getMonth() + 1;
		// 取本地月中日期，按原数字显示不补零。
		const day = date.getDate();
		// 不同日但同一年时不再显示年份。
		if (date.getFullYear() === now.getFullYear()) {
			// 同年显示 M/D HH:mm。
			return `${month}/${day} ${time}`;
		}

		// 跨年取年份文字最后两个 UTF-16 码元，非严格固定世纪格式。
		const year = date.getFullYear().toString().slice(-2);
		// 返回 YY/M/D HH:mm；未检查日期有效性，也不通过本地化格式化器选择语言或日期顺序。
		return `${year}/${month}/${day} ${time}`;
	}

	// 从未知内容中抽取文字再截前 200 UTF-16 码元，无写入；例：很长助手正文只给树预览前缀，可能切开代理对，完整复制另用 helper。
	private extractContent(content: unknown): string {
		// 先调用全文抽取再 slice，因此限制的是结果，不代表只扫描前 200 码元的源块；不自动追加省略号。
		return this.extractFullContent(content).slice(0, 200);
	}

	// 把字符串或内容块数组中的 text 拼成全文，其他形态返回空串；不解码图片，不改变原块。
	// 例：text a、image、text b 得到 ab；未知块只检查对象/type，不完整验证 text，断言不会防止恶意 getter/错误类型的 JS 转换或异常。
	private extractFullContent(content: unknown): string {
		// 字符串原样返回，包括换行、空白和控制码，没有 normalize。
		if (typeof content === "string") return content;
		// 非数组且非字符串的未知内容一律忽略，返回空串。
		if (!Array.isArray(content)) return "";

		// 局部字符串累积结果。
		let result = "";
		// 按内容块原顺序遍历，不在块间加分隔符。
		for (const block of content) {
			// 确认非 null 对象、有 type=text；in 允许继承属性，不证明 text 是自有字符串。
			if (typeof block === "object" && block !== null && "type" in block && block.type === "text") {
				// as 只告诉 TS text 是 string，运行时 += 会按 JS 规则转换实际值；没有再检查 typeof text。
				result += (block as { text: string }).text;
			}
		}
		// 返回全部提取结果，是否截短/trim 由不同调用者另行决定。
		return result;
	}

	// 按条目类型取可复制原文，返回 string 或 undefined；不写剪贴板，不采用 200 码元预览限制。
	// 例：工具结果复制其完整 content，压缩条目复制 summary，bash 执行复制 command；没有文本/全空白返回 undefined，非空原文保留首尾空白。读取异常继续传播。
	private getEntryCopyText(node: SessionTreeNode): string | undefined {
		// 获取原历史条目，下面按 type 决定正文来源。
		const entry = node.entry;
		// let 允许分支赋值，未赋值的未知类型保持 undefined。
		let text: string | undefined;

		// 只列出有明确正文来源的类型，不把所有元数据序列化成 JSON。
		switch (entry.type) {
			// 普通消息再按 role/是否有 content 取文字。
			case "message":
				// bashExecution 优先复制命令，不复制执行输出。
				if (entry.message.role === "bashExecution") {
					// 直接保存 command 原文，不做单行替换。
					text = entry.message.command;
					// 其他带 content 的消息用全文提取，包括 user/assistant/toolResult。
				} else if ("content" in entry.message) {
					// 不走 extractContent，所以不会因预览长度上限丢掉后半段。
					text = this.extractFullContent(entry.message.content);
					// 助手提取结果为空串时才尝试错误文字；全空白字符串为真值，不进入此回退。
					if (!text && entry.message.role === "assistant") {
						// 错误说明可以缺省，最终统一判定有没有可复制文字。
						text = entry.message.errorMessage;
					}
				}
				// message 分支到此结束。
				break;
			// 自定义消息同样从 string/内容块提全文。
			case "custom_message":
				// 图片等非 text 内容不会变成可复制文字。
				text = this.extractFullContent(entry.content);
				break;
			// 压缩条目的摘要是复制目标，和树行显示的 token 事件文案不同。
			case "compaction":
				// 取完整摘要，不重新生成摘要。
				text = entry.summary;
				break;
			// 分支摘要也复制完整 summary 原文。
			case "branch_summary":
				// 不把前缀 branch summary 等 UI 文字混入复制结果。
				text = entry.summary;
				break;
		}

		// ?.trim() 仅用于判空，返回的仍是未 trim 原 text；undefined/空串/纯空白都变 undefined。
		return text?.trim() ? text : undefined;
	}

	// 判断未知内容是否含非空文字，返回 boolean，不改数据；例：仅工具调用块为 false，text 空白为 false，任一 text 有字即 true。
	// 只做部分块检查，断言后的 text 未验证字符串，非 JSON/损坏 JS 对象的 getter 或非字符串 .trim 仍可抛错。
	private hasTextContent(content: unknown): boolean {
		// 字符串 trim 后长度大于 0 才算文字，不会把纯空格当正文。
		if (typeof content === "string") return content.trim().length > 0;
		// 数组需要逐块扫描，数组非空本身不代表有文字。
		if (Array.isArray(content)) {
			// 按顺序查看，命中后立即返回 true。
			for (const c of content) {
				// 非 null 对象并有 type=text 才读取 text；in 并不限制自有属性。
				if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
					// as 声明可选字符串，但不会在运行时把数字等值变成字符串。
					const text = (c as { text?: string }).text;
					// 真值 text 再调用 trim；任一有非空字的块即成功，不继续扫剩余块。
					if (text && text.trim().length > 0) return true;
				}
			}
		}
		// 没有符合条件的文本，或内容形态非字符串/数组，返回 false。
		return false;
	}

	// 输入工具名及未知参数字典，返回树行中的调用摘要；只做展示，不执行命令/读文件。
	// 例：read(path=a.ts,offset=11,limit=5) 显示路径和 :11-15；bash 取正规化命令前 50 码元，其他工具 JSON 取前 40 码元。
	// String 转换、JSON.stringify 可执行对象转换/getter 或因循环、BigInt 等抛错；默认分支序列化两次，不能当作安全的任意对象预览器。
	private formatToolCall(name: string, args: Record<string, unknown>): string {
		// 局部箭头函数仅将主目录内绝对路径缩成 ~；HOME 真值优先，再 USERPROFILE，否则空目录就不缩短，不访问文件。
		const shortenPath = (p: string): string => shortenHomePath(p, process.env.HOME || process.env.USERPROFILE || "");

		// 按名称选择显示模板，不依据工具 schema 动态验证参数。
		switch (name) {
			// read 展示路径和可选行号范围。
			case "read": {
				// path 真值优先于 file_path，均无真值则空串；String 强制转换后才缩路径，和严格字符串校验不同。
				const path = shortenPath(String(args.path || args.file_path || ""));
				// 行号 helper 接受有限数字/数字串，仅给 limit 时缺 offset 以 1 起，两者都缺则无后缀，非法范围隐藏；不约束正整数或执行实际 read。
				return `[read: ${path}${formatReadLineRange(args.offset, args.limit)}]`;
			}
			// write 只显示目标路径，不展示写入正文。
			case "write": {
				// 沿用 path/file_path 的真值优先规则，数字 0/false 会被当缺省。
				const path = shortenPath(String(args.path || args.file_path || ""));
				// 返回写工具预览，不创建文件。
				return `[write: ${path}]`;
			}
			// edit 同样只标识目标路径，不展示替换文本。
			case "edit": {
				// 先把路径转为字符串，再只作主目录显示缩短。
				const path = shortenPath(String(args.path || args.file_path || ""));
				// 返回 edit 的方括号摘要。
				return `[edit: ${path}]`;
			}
			// bash 工具调用预览仅显示命令，不显示运行结果。
			case "bash": {
				// command 无真值则空串，其余值做 JS String 转换。
				const rawCmd = String(args.command || "");
				// 多行链式调用依次替换、trim、截断，rawCmd 仍保留原始转换结果。
				const cmd = rawCmd
					// 正则 g 将所有 LF/tab 各替为一个空格，不清理全部控制字符。
					.replace(/[\n\t]/g, " ")
					// 删除首尾空白，但不合并内部连续空格。
					.trim()
					// 取前 50 UTF-16 码元，可能切开代理对，不按终端列或 token 限制。
					.slice(0, 50);
				// 是否加省略号依据 rawCmd 原长度，不是正规化后长度；原文很长但几乎全是空白时也可能加点。
				return `[bash: ${cmd}${rawCmd.length > 50 ? "..." : ""}]`;
			}
			// grep 显示模式和搜索路径，不真正编译模式或搜索文件。
			case "grep": {
				// 模式转字符串，无真值时空串。
				const pattern = String(args.pattern || "");
				// 路径无真值时显示当前目录点号，主目录缩短只影响显示。
				const path = shortenPath(String(args.path || "."));
				// 斜杠是 UI 包装文字，不保证原 pattern 是合法正则，也没有进行正则转义。
				return `[grep: /${pattern}/ in ${path}]`;
			}
			// find 显示模式和路径，未在此解析 glob。
			case "find": {
				// 模式同样由 String 转换，保留原换行等内容。
				const pattern = String(args.pattern || "");
				// 路径默认点号，不推导实际执行 cwd 的绝对路径。
				const path = shortenPath(String(args.path || "."));
				// 返回查找调用提示，不执行目录遍历。
				return `[find: ${pattern} in ${path}]`;
			}
			// ls 只需要目录路径。
			case "ls": {
				// 默认点号和其他路径一样仅作显示缩短。
				const path = shortenPath(String(args.path || "."));
				// 返回目录列表工具标识，没有读取目录内容。
				return `[ls: ${path}]`;
			}
			// 未匹配内置名称时用自定义工具预览规则。
			default: {
				// Custom tool - show name and truncated JSON args
				// 先 JSON.stringify 全参数再取前 40 码元，限制的是显示前缀而不是序列化成本；循环/BigInt 或异常转换仍会抛出。
				const argsStr = JSON.stringify(args).slice(0, 40);
				// 再次序列化判断原长度是否超过 40，因此带 getter/toJSON 的对象两次结果甚至可能不同；没有在此 catch。
				return `[${name}: ${argsStr}${JSON.stringify(args).length > 40 ? "..." : ""}]`;
			}
		}
	}

	// 按配置顺序处理一段按键数据，修改游标/折叠/搜索/模式，或调用宿主选择、取消、复制、标签回调，返回 void。
	// 例：折叠键优先折当前可折叠节点，否则跳到上一段起点；搜索输入会清全部折叠；有查询时取消先清查询，再次取消才关闭。
	// 不直接写会话/请求模型，也不调用 requestRender；上下/下翻页空结果时可能留下 -1 等下标，确认仍先检查实际项，回调同步错误可传播。
	handleInput(keyData: string): void {
		// 每次获取共享键位管理器，支持用户覆盖而非仅默认键。
		const kb = getKeybindings();
		// 上移动作优先，和其他绑定冲突时先命中这一分支。
		if (kb.matches(keyData, "tui.select.up")) {
			// 首项绕到末项，其余减一；空列表的末项是 -1，此处不做空列表修复。
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredNodes.length - 1 : this.selectedIndex - 1;
			// 下移分支其次匹配。
		} else if (kb.matches(keyData, "tui.select.down")) {
			// 末项绕到首项，其余加一，使用当前过滤结果数量。
			this.selectedIndex = this.selectedIndex === this.filteredNodes.length - 1 ? 0 : this.selectedIndex + 1;
			// 折叠/上跳是同一动作的两种上下文行为，不是直接左移一个历史父节点。
		} else if (kb.matches(keyData, "app.tree.foldOrUp")) {
			// 可选链取得当前选择 id，空列表或非法下标为 undefined。
			const currentId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
			// 必须有真值 id、符合折叠资格、且尚未折叠，才优先折叠。
			if (currentId && this.isFoldable(currentId) && !this.foldedNodes.has(currentId)) {
				// Set 加入 id，节点自身仍保留，后代由 applyFilter 隐藏。
				this.foldedNodes.add(currentId);
				// 折叠后重建可见列表/关系并恢复选择。
				this.applyFilter();
			} else {
				// 不能新增折叠时沿可见父链跳上一分支段起点。
				this.selectedIndex = this.findBranchSegmentStart("up");
			}
			// 展开/下跳动作和上面对应。
		} else if (kb.matches(keyData, "app.tree.unfoldOrDown")) {
			// 读取当前选中 id，不用真实叶子代替选择。
			const currentId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
			// 只要该 id 已在折叠集合就优先展开，不再次检查 isFoldable。
			if (currentId && this.foldedNodes.has(currentId)) {
				// 删除折叠标志，嵌套其他节点的折叠标志仍保留。
				this.foldedNodes.delete(currentId);
				// 重新过滤以恢复本节点未被其他折叠隐藏的后代。
				this.applyFilter();
			} else {
				// 未折叠则沿可见首子链跳到下一段/叶端，非逐项下移。
				this.selectedIndex = this.findBranchSegmentStart("down");
			}
			// 编辑器左右动作在树视图中兼作翻页；也接受专门 pageUp 动作，两者都随配置匹配。
		} else if (kb.matches(keyData, "tui.editor.cursorLeft") || kb.matches(keyData, "tui.select.pageUp")) {
			// Page up
			// 上翻一页并夹下界 0，不绕到列表底部。
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisibleLines);
			// 右移或 pageDown 都按一页向后移动。
		} else if (kb.matches(keyData, "tui.editor.cursorRight") || kb.matches(keyData, "tui.select.pageDown")) {
			// Page down
			// 夹到最后可见项，空列表上界 -1，因此不保证结果非负。
			this.selectedIndex = Math.min(this.filteredNodes.length - 1, this.selectedIndex + this.maxVisibleLines);
			// 确认动作只发送当前条目 id，后续导航/摘要对话框由外层负责。
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			// 先取当前实际可见项，可能为 undefined。
			const selected = this.filteredNodes[this.selectedIndex];
			// 候选与回调都存在才通知，防止空列表凭空导航。
			if (selected && this.onSelect) {
				// 同步调用，不等待 async 宿主回调，也不更新 currentLeafId 快照。
				this.onSelect(selected.node.entry.id);
			}
			// 消息复制动作复用本列表的完整取文逻辑。
		} else if (kb.matches(keyData, "app.message.copy")) {
			// 转交 onCopy，不在这里操作系统剪贴板。
			this.copySelected();
			// 取消键根据搜索是否为真值决定清查询或关闭。
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			// 仅空白的非空字符串也为真值，因此也先清掉而不关闭。
			if (this.searchQuery) {
				// 清查询全文，没有独立编辑光标需要重置。
				this.searchQuery = "";
				// 同时清所有折叠标记，恢复此前折叠后代。
				this.foldedNodes.clear();
				// 恢复当前模式下无查询/无折叠视图。
				this.applyFilter();
			} else {
				// 查询为空才调用可选取消回调，?. 不会在未设置时抛未定义调用错误。
				this.onCancel?.();
			}
			// 直接切默认模式，不是 default 与其他模式间的开关。
		} else if (kb.matches(keyData, "app.tree.filter.default")) {
			// Direct filter: default
			// 设为 default 后仍保留查询字符串。
			this.filterMode = "default";
			// 模式变化统一展开所有折叠分支。
			this.foldedNodes.clear();
			// 按新模式、原查询重新构建视图。
			this.applyFilter();
			// noTools 动作在 no-tools 与 default 间切换。
		} else if (kb.matches(keyData, "app.tree.filter.noTools")) {
			// Toggle filter: no-tools ↔ default
			// 只有当前恰为 no-tools 才退 default，其他模式按此键都进入 no-tools。
			this.filterMode = this.filterMode === "no-tools" ? "default" : "no-tools";
			// 清折叠状态，但不清搜索文字。
			this.foldedNodes.clear();
			// 按结果重建可见列表和游标。
			this.applyFilter();
			// userOnly 动作也属于模式开关。
		} else if (kb.matches(keyData, "app.tree.filter.userOnly")) {
			// Toggle filter: user-only ↔ default
			// 当前为 user-only 则退默认，否则进入只看用户消息。
			this.filterMode = this.filterMode === "user-only" ? "default" : "user-only";
			// 避免旧折叠状态使新模式候选意外消失。
			this.foldedNodes.clear();
			// 重跑筛选，并按记忆 id 找最近可见祖先。
			this.applyFilter();
			// labeledOnly 动作切换带标签筛选。
		} else if (kb.matches(keyData, "app.tree.filter.labeledOnly")) {
			// Toggle filter: labeled-only ↔ default
			// 在 labeled-only/default 间切换，标签判断仍按 !==undefined。
			this.filterMode = this.filterMode === "labeled-only" ? "default" : "labeled-only";
			// 切换模式统一清折叠标志。
			this.foldedNodes.clear();
			// 标签模式无结果时仍保留最后有效 id 的记忆。
			this.applyFilter();
			// all 动作也可再次按下回默认。
		} else if (kb.matches(keyData, "app.tree.filter.all")) {
			// Toggle filter: all ↔ default
			// all 仅放宽模式层，通用 usage/无文字 assistant 隐藏仍存在。
			this.filterMode = this.filterMode === "all" ? "default" : "all";
			// 清折叠，不能借 all 恢复原折叠状态。
			this.foldedNodes.clear();
			// 搜索依旧存在，all 不表示清除所有筛选。
			this.applyFilter();
			// 反向轮换动作先于正向分支判断。
		} else if (kb.matches(keyData, "app.tree.filter.cycleBackward")) {
			// Cycle filter backwards
			// 显式 FilterMode[] 约束每项是合法模式，数组顺序定义轮换次序。
			const modes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
			// indexOf 找当前模式位置，正常内部状态保证它在数组中。
			const currentIndex = modes.indexOf(this.filterMode);
			// 减一再加长度后取余，实现 default 向后绕到 all。
			this.filterMode = modes[(currentIndex - 1 + modes.length) % modes.length];
			// 模式轮换也展开全部折叠。
			this.foldedNodes.clear();
			// 应用轮换后的视图，查询仍保留。
			this.applyFilter();
			// 正向轮换动作走相同的状态更新步骤。
		} else if (kb.matches(keyData, "app.tree.filter.cycleForward")) {
			// Cycle filter forwards: default → no-tools → user-only → labeled-only → all → default
			// 新建五模式数组，不把它当持久化设置或共享全局配置。
			const modes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
			// 求当前模式下标。
			const currentIndex = modes.indexOf(this.filterMode);
			// 加一再取余，all 之后绕回 default。
			this.filterMode = modes[(currentIndex + 1) % modes.length];
			// 清所有折叠以重新显示新模式可见后代。
			this.foldedNodes.clear();
			// 重算筛选和选择，不把新模式写入 SettingsManager。
			this.applyFilter();
			// 退格动作直接编辑查询尾部，而不是把输入交给 Input。
		} else if (kb.matches(keyData, "tui.editor.deleteCharBackward")) {
			// 只有查询字符串长度大于 0 才需要操作。
			if (this.searchQuery.length > 0) {
				// slice(0,-1) 删除最后一个 UTF-16 码元，可能把代理对拆半；不是按字素删除。
				this.searchQuery = this.searchQuery.slice(0, -1);
				// 查询变化时一律重置折叠。
				this.foldedNodes.clear();
				// 按新查询重建可见树。
				this.applyFilter();
			}
			// 标签编辑动作不会直接改条目标签，而是通知外壳打开输入框。
		} else if (kb.matches(keyData, "app.tree.editLabel")) {
			// 取当前可见包装作为编辑目标。
			const selected = this.filteredNodes[this.selectedIndex];
			// 候选和编辑回调都存在才操作。
			if (selected && this.onLabelEdit) {
				// 传真实条目 id 和当前解析标签，undefined 表示无标签。
				this.onLabelEdit(selected.node.entry.id, selected.node.label);
			}
			// 标签时间开关只影响显示，不改变标签时间数据。
		} else if (kb.matches(keyData, "app.tree.toggleLabelTimestamp")) {
			// 逻辑非将布尔值翻转，下次 render 使用新状态，不重筛候选。
			this.showLabelTimestamps = !this.showLabelTimestamps;
		} else {
			// 其余输入先检查控制字符；字符串展开按 Unicode 码点迭代，但下句 charCodeAt 仍只看该片段首个 UTF-16 码元。
			const hasControlChars = [...keyData].some((ch) => {
				// charCodeAt(0) 返回首码元数值，补充平面字符得到其高代理码元。
				const code = ch.charCodeAt(0);
				// 拒绝 C0、DEL、C1 码段；不是通用按键协议解码器，也不是完整输入净化器。
				return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
			});
			// 整段无上述控制码且非空才当普通搜索文字；带 ESC 的未匹配键序列不会直接加入。
			if (!hasControlChars && keyData.length > 0) {
				// 原样追加到尾部，不做粘贴帧重组、大小写转换或光标中间插入。
				this.searchQuery += keyData;
				// 新增搜索词时展开所有分支，避免折叠挡住匹配结果。
				this.foldedNodes.clear();
				// applyFilter 再负责小写、分词和 AND 子串匹配。
				this.applyFilter();
			}
		}
	}

	/**
	 * Whether a node can be folded. A node is foldable if it has visible children
	 * and is either a root (no visible parent) or a segment start (visible parent
	 * has multiple visible children).
	 */
	// 根据可见父子索引判断某 id 是否可折叠，返回 boolean、不改状态。
	// 必须有可见孩子，且是可见根或其可见父有多个孩子；例：单链中段不可折叠，分叉后的段首可折叠。它不是简单判断原 children 非空。
	private isFoldable(entryId: string): boolean {
		// 取该 id 在当前视图的直接可见孩子数组。
		const children = this.visibleChildrenMap.get(entryId);
		// 无索引或无孩子都不是可折叠节点。
		if (!children || children.length === 0) return false;
		// 查最近可见父，而不是原 entry.parentId。
		const parentId = this.visibleParentMap.get(entryId);
		// null 或未登记父都视作根，只要前面确认有孩子就可折叠。
		if (parentId === null || parentId === undefined) return true;
		// 有父则看父的可见孩子列表，也就是当前节点的可见兄弟。
		const siblings = this.visibleChildrenMap.get(parentId);
		// 必须确实有兄弟分叉，非分叉单链节点不能作为新的折叠起点。
		return siblings !== undefined && siblings.length > 1;
	}

	/**
	 * Find the index of the next branch segment start in the given direction.
	 * A segment start is the first child of a branch point.
	 *
	 * "up" walks the visible parent chain; "down" walks visible children
	 * (always following the first child).
	 */
	// 输入 up/down 字面量方向，返回分支段边界的可见下标，不改变游标/折叠。
	// 向下沿首个可见孩子走，遇分叉返回其首孩子，走到尽头返回末端；向上沿可见父链找更早的段首或根。例：当前在分支中段，上跳退到该段首，再上跳越到更高段。
	// 依赖可见索引一致且无环，! 不验证运行时 Map 命中，while(true) 由这些树关系终止。
	private findBranchSegmentStart(direction: "up" | "down"): number {
		// 读取当前选中 id，空列表或非法选择得到 undefined。
		const selectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
		// 无选择时原下标保持不变，不强行选择根。
		if (!selectedId) return this.selectedIndex;

		// 把当前可见 id 映射到下标，便于沿父子跳跃后转换成游标。
		const indexByEntryId = new Map(this.filteredNodes.map((node, i) => [node.node.entry.id, i]));
		// 当前游标 id 在循环中逐步变化，类型显式 string。
		let currentId: string = selectedId;
		// 向下与向上采用不同循环，不能理解为数组下标简单加减。
		if (direction === "down") {
			// 每轮由孩子情况决定返回还是继续，不设固定最大跳数。
			while (true) {
				// 缺少孩子索引时当作叶端，?? 只回退 null/undefined。
				const children: string[] = this.visibleChildrenMap.get(currentId) ?? [];
				// 没有孩子返回当前走到的末端下标，非空断言依赖索引一致性。
				if (children.length === 0) return indexByEntryId.get(currentId)!;
				// 遇到多个孩子，跳第一个孩子所开启的新分支段，而不是分叉父节点本身。
				if (children.length > 1) return indexByEntryId.get(children[0])!;
				// 只有一个孩子时继续沿这个链走到底或下一个分叉。
				currentId = children[0];
			}
		}

		// direction === "up"
		// 非 down 方向在类型约定下就是 up，沿可见父链逐层走。
		while (true) {
			// 未登记父统一作 null，表示本轮遇到可见根。
			const parentId: string | null = this.visibleParentMap.get(currentId) ?? null;
			// 根位置就是这条向上路径的终点，返回它的可见下标。
			if (parentId === null) return indexByEntryId.get(currentId)!;
			// 取得当前父的可见孩子，用来判断当前 id 是否段首。
			const children = this.visibleChildrenMap.get(parentId) ?? [];
			// 父有多个孩子时，当前节点是其中一个分支起点候选。
			if (children.length > 1) {
				// 取当前段首的下标，而非父分叉点下标。
				const segmentStart = indexByEntryId.get(currentId)!;
				// 只有该段首排在原选择之前才返回；原本已在段首则继续往上找更早段。
				if (segmentStart < this.selectedIndex) {
					// 返回找到的上一段起点，调用方决定是否把它保存成 selectedIndex。
					return segmentStart;
				}
			}
			// 还没找到可返回的更早段时，把当前 id 上移到可见父。
			currentId = parentId;
		}
	}
}

/** Component that displays the current search query */
// 只负责展示查询提示的子组件；真正搜索输入由 TreeList 接收，不在这里重复编辑。
class SearchLine implements Component {
	// 保存实际列表引用，render 每次读取它最新的查询字段。
	private treeList: TreeList;

	// 构造时保存已有列表，无额外查询副本或后台任务；例如树输入 abc 后，提示行下次 render 直接看到 abc。
	constructor(treeList: TreeList) {
		// 直接引用赋值，不克隆 TreeList 或节点。
		this.treeList = treeList;
	}

	// 无缓存的失效方法为空，主题/查询变化后仍由外层安排 render；无参数、返回或副作用。
	invalidate(): void {}

	// 按可用宽度返回一行查询提示，不修改搜索状态；例如 query=abc 显示提示加 abc，空查询只显示提示，两者都可能被裁剪。
	render(width: number): string[] {
		// 普通方法读取当前字符串，不在此分词或去空白。
		const query = this.treeList.getSearchQuery();
		// 真值查询才显示正文，纯空白非空串也进入此分支。
		if (query) {
			// 提示淡色、查询强调色，拼接后统一按总列宽裁剪。
			return [truncateToWidth(`  ${theme.fg("muted", "Type to search:")} ${theme.fg("accent", query)}`, width)];
		}
		// 空查询仍保留提示行，不从布局中消失。
		return [truncateToWidth(`  ${theme.fg("muted", "Type to search:")}`, width)];
	}

	// 故意不处理输入的空方法，_keyData 表示参数未使用；宿主聚焦外壳再转给 TreeList，不聚焦此提示行。
	handleInput(_keyData: string): void {}
}

/** Component that renders tree help as semantic rows with chunk-aware wrapping */
// 帮助组件把动作名称和当前键位组成语义块，尽量整块放在一行，过窄时再折行，不在尾部简单省略全部后续操作。
class TreeHelp implements Component {
	// 无渲染缓存需要失效，空方法满足 Component 约定，不自行重画。
	invalidate(): void {}

	// 输入列宽，返回主题着色的帮助行，无键位配置写入。
	// 先为每组动作取当前首个键，再按语义块装行，放不下时提交旧行并换行；例：窄屏仍能在多行看到 branch/copy/filter 等说明。
	// 内部宽度至少 1；宽度比一个宽字还窄时，底层换行也不能切半字，不保证任意输入都严格不超宽。
	render(width: number): string[] {
		// map 对帮助定义逐项解构 keys/label/labelFirst，生成每个语义块的显示文字。
		const items = TREE_HELP_ITEMS.map(({ keys, label, labelFirst }) => {
			// 按配置取该组动作的首个键并压缩共同修饰键前缀。
			const text = formatHelpKeys(keys);
			// 组内所有动作都没有键时仍保留功能标签，不显示 undefined 键名。
			if (!text) return label;
			// labelFirst 决定功能名在前还是键名在前，不修改真实绑定。
			return labelFirst ? `${label} ${text}` : `${text} ${label}`;
		});

		// 至少使用一列作为换行预算；即使调用方传 0，也不会生成零宽换行预算。
		const availableWidth = Math.max(1, width);
		// 通常每行起始留两个空格，放不下时可舍弃这层缩进。
		const indent = "  ";
		// 同一行语义块之间以中点隔开，只影响显示。
		const separator = " · ";
		// 累积已完成的帮助行，string[] 表示字符串数组。
		const lines: string[] = [];
		// 当前正在装配的行，let 允许后续替换或追加。
		let currentLine = "";

		// 按定义顺序放语义块，不按键名或字母排序。
		for (const item of items) {
			// 嵌套三元表达式构造尝试加入当前块的新行。
			const candidate = currentLine
				? // 已有行时在原行后追加分隔符和整块。
					`${currentLine}${separator}${item}`
				: // 空行时先检查带两空格缩进能否容纳这一整块。
					visibleWidth(`${indent}${item}`) <= availableWidth
					? // 能容纳则采用缩进版本。
						`${indent}${item}`
					: // 连缩进都使它超宽时先使用无缩进文字，后面换行器仍可处理长块。
						item;
			// 当前为空时先接收候选；有当前行时，只有拼接后未超预算才直接保留。
			if (!currentLine || visibleWidth(candidate) <= availableWidth) {
				// 候选变成正在组装的当前行。
				currentLine = candidate;
				// 这一块已放下，继续下一个帮助项。
				continue;
			}

			// 新块塞不下旧行时，trimEnd 后交带 ANSI 换行助手，展开结果逐行放进 lines。
			lines.push(...wrapTextWithAnsi(currentLine.trimEnd(), availableWidth));
			// 新块另起一行，带缩进能放下才保留缩进；超长块等下一次提交/尾部提交时再折行。
			currentLine = visibleWidth(`${indent}${item}`) <= availableWidth ? `${indent}${item}` : item;
		}

		// 循环结束仍有待提交的尾行，就不能漏掉它。
		if (currentLine) {
			// 和中途提交一样按显示列换行，不使用省略号截掉尾部操作。
			lines.push(...wrapTextWithAnsi(currentLine.trimEnd(), availableWidth));
		}

		// 最后给每一行加淡色，返回新数组，不在这里输出终端。
		return lines.map((line) => theme.fg("muted", line));
	}
}

// 帮助定义数组，每项包含动作名数组、功能文案和可选 labelFirst；Array<...> 与对象类型[] 等价，声明不注册动作。
const TREE_HELP_ITEMS: Array<{ keys: Keybinding[]; label: string; labelFirst?: boolean }> = [
	// 上下两个动作各展示自己的首个配置键，说明逐项移动。
	{ keys: ["tui.select.up", "tui.select.down"], label: "move" },
	// 提示左右翻页别名；handleInput 还接受专门 pageUp/pageDown，这里未逐个列出所有别名。
	{ keys: ["tui.editor.cursorLeft", "tui.editor.cursorRight"], label: "page" },
	// 折叠/上跳与展开/下跳合为 branch 语义块。
	{ keys: ["app.tree.foldOrUp", "app.tree.unfoldOrDown"], label: "branch" },
	// 复制动作使用 app.message.copy 的配置。
	{ keys: ["app.message.copy"], label: "copy" },
	// 标签编辑动作，不直接修改数据。
	{ keys: ["app.tree.editLabel"], label: "label" },
	// 标签时间显示开关，与标签编辑分开。
	{ keys: ["app.tree.toggleLabelTimestamp"], label: "label time" },
	// 这组定义把五个直接筛选动作放在同一功能块。
	{
		// keys 是动作名数组，不是硬编码实际 ctrl 键序列。
		keys: [
			// 默认视图动作。
			"app.tree.filter.default",
			// 隐藏工具结果视图动作。
			"app.tree.filter.noTools",
			// 仅用户消息视图动作。
			"app.tree.filter.userOnly",
			// 带标签视图动作。
			"app.tree.filter.labeledOnly",
			// all 模式动作；真实显示仍受通用隐藏规则限制。
			"app.tree.filter.all",
		],
		// 功能名 filters 是界面文字，不参与匹配按键。
		label: "filters",
		// true 让功能名先显示，再显示这一组压缩后的键名。
		labelFirst: true,
	},
	// 轮换方向两个动作同组，labelFirst 同样先显示 cycle。
	{ keys: ["app.tree.filter.cycleForward", "app.tree.filter.cycleBackward"], label: "cycle", labelFirst: true },
];

// 输入一组动作名，返回精简键名文字，无配置修改；每动作仅取当前首键，全部无键则空串。
// 例：ctrl+up/ctrl+down 先压缩修饰键再把方向词换为箭头，macOS 的 alt 由 formatKeyText 处理成 option。配置查询/格式化错误照常传播。
function formatHelpKeys(keybindings: Keybinding[]): string {
	// 收集真实配置得到的字符串键名，而不是保存动作名。
	const keys: string[] = [];
	// 依帮助定义顺序遍历每个动作。
	for (const keybinding of keybindings) {
		// getKeys 可能给多个别名，这里只选下标 0；每轮重新读取共享管理器。
		const key = getKeybindings().getKeys(keybinding)[0];
		// 严格区分 undefined 与有效字符串，只收有首键的动作。
		if (key !== undefined) keys.push(key);
	}
	// 无键直接返回空串，保证 compactRawKeys 正常调用至少有一个键。
	if (keys.length === 0) return "";

	// 先压缩共同修饰前缀，再做平台文案格式化，随后只替换下列精确大小写单词。
	return (
		formatKeyText(compactRawKeys(keys))
			// 正则 g 全部替换词边界内的 pageUp 为 pgup，不修改更长单词的一部分。
			.replace(/\bpageUp\b/g, "pgup")
			// pageDown 同样缩为 pgdn，规则区分大小写。
			.replace(/\bpageDown\b/g, "pgdn")
			// 方向 up 换成上箭头，只是显示文本转换。
			.replace(/\bup\b/g, "↑")
			// 方向 down 换成下箭头。
			.replace(/\bdown\b/g, "↓")
			// 方向 left 换成左箭头。
			.replace(/\bleft\b/g, "←")
			// 方向 right 换成右箭头，返回整个链式转换后的字符串。
			.replace(/\bright\b/g, "→")
	);
}

// 把非空键名数组压缩成同前缀简写，返回文字、不改数组；例：ctrl+left、ctrl+right 得 ctrl+left/right，前缀不同则各自完整保留。
// 只按最后一个 + 拆分，不校验键语法；调用方先处理空数组，这里直接读取 parts[0]!，绕过约定传空数组会出错。
function compactRawKeys(keys: string[]): string {
	// 单个键直接返回；! 仅是 TS 非空断言，长度判断支持正常数组下标存在。
	if (keys.length === 1) return keys[0]!;

	// 为每个键生成前缀/末段对象，map 创建新数组。
	const parts = keys.map((key) => {
		// lastIndexOf 找最后一个 +，因此 ctrl+shift+x 前缀是 ctrl+shift+。
		const separatorIndex = key.lastIndexOf("+");
		// 没找到分隔符时走无前缀分支。
		return separatorIndex === -1
			? // 无修饰键的普通键保留全文作为末段。
				{ prefix: "", suffix: key }
			: // 前缀保留最后的 +，末段取其后文字；slice 不改变原键名。
				{ prefix: key.slice(0, separatorIndex + 1), suffix: key.slice(separatorIndex + 1) };
	});
	// 以第一项前缀为比较基准，依赖调用方保证输入非空，不做运行时保护。
	const prefix = parts[0]!.prefix;
	// 必须有真值前缀且所有项前缀严格一致，才允许只展示一遍前缀。
	return prefix && parts.every((part) => part.prefix === prefix)
		? // 相同前缀只拼一次，末段用 / 分开，这是一种显示简写而非重新注册的实际按键串。
			`${prefix}${parts.map((part) => part.suffix).join("/")}`
		: // 不适合压缩时用 / 拼完整键名，不丢各自修饰键。
			keys.join("/");
}

/** Label input component shown when editing a label */
// 标签输入的小组件，同时满足渲染和焦点约定；不会自己写 SessionManager，确认交由外壳回调。
class LabelInput implements Component, Focusable {
	// 内部 Input 执行文字编辑/光标布局，组件只负责外层提示和确认取消。
	private input: Input;
	// 标签目标保存为条目 id，与当前输入值分开。
	private entryId: string;
	// 可选提交回调允许 undefined 表示删除标签；返回值在此不使用。
	public onSubmit?: (entryId: string, label: string | undefined) => void;
	// 可选取消回调只关闭编辑，不提交内容。
	public onCancel?: () => void;

	// Focusable implementation - propagate to input for IME cursor positioning
	// 本组件的焦点状态副本，private 只限制 TS 访问。
	private _focused = false;
	// get 访问器用属性语法读焦点，没有参数或副作用；例：labelInput.focused 读取布尔值，不加调用括号。
	get focused(): boolean {
		// 返回保存的布尔值，不从 Input 反查。
		return this._focused;
	}
	// set 访问器接收布尔值并同步内部输入焦点，无返回值；例：外壳设 focused=true，Input 才输出对应光标定位标记。
	set focused(value: boolean) {
		// 先保存自己的焦点状态。
		this._focused = value;
		// 再把同一状态转给真实输入框，供输入法/终端光标定位。
		this.input.focused = value;
	}

	// 输入目标 id 和当前标签，构造可编辑 Input，无文件写入；例：原标签 checkpoint 为真值时预填，undefined/空串留空。
	// Input.setValue 不在这里额外把光标移动到末尾，初始值显示不等于自动开始提交。
	constructor(entryId: string, currentLabel: string | undefined) {
		// 保存提交目标，编辑过程中不从树游标重新读取。
		this.entryId = entryId;
		// 新建输入框实例，焦点稍后由外壳传播。
		this.input = new Input();
		// 只预填真值标签；空串与未设置都用初始空输入。
		if (currentLabel) {
			// 把原标签交 Input 保存，不在此 trim 或转换大小写。
			this.input.setValue(currentLabel);
		}
	}

	// 空失效方法不清输入内容/光标，无参数、返回或主动重画；本外壳没有独立行缓存。
	invalidate(): void {}

	// 按列宽返回标题、输入行和按键帮助，不保存标签；例：宽 40 时在输入前留两空格，窄屏最后仍逐行裁剪。
	// availableWidth 未用 max 夹到正数，极窄宽度可把非正值传给 Input；不能把布局意图当作任意宽度下的强保证。
	render(width: number): string[] {
		// 新建字符串行数组，避免更改 Input 返回的数组容器。
		const lines: string[] = [];
		// 用两空格作为统一左缩进。
		const indent = "  ";
		// 输入框可用宽度扣掉这两列，字符串 indent.length 在这里等于两列 ASCII 空格。
		const availableWidth = width - indent.length;
		// 标题提示空输入可删标签，整体按总宽度截断。
		lines.push(truncateToWidth(`${indent}${theme.fg("muted", "Label (empty to remove):")}`, width));
		// 先渲染输入框，再给每行加缩进和总宽裁剪；... 将多个输入行分别加入结果。
		lines.push(...this.input.render(availableWidth).map((line) => truncateToWidth(`${indent}${line}`, width)));
		// 下面整条 push 添加一行保存/取消帮助。
		lines.push(
			// 帮助文字也使用总宽度裁剪，默认省略符。
			truncateToWidth(
				// keyHint 每次按当前配置取键名，两个功能提示中间留空格。
				`${indent}${keyHint("tui.select.confirm", "save")}  ${keyHint("tui.select.cancel", "cancel")}`,
				// 传总列宽，因为这一行已包含完整缩进。
				width,
			),
		);
		// 返回行数组，不直接写终端或改输入焦点。
		return lines;
	}

	// 按配置处理确认/取消，其余交 Input，返回 void；例：输入空白确认后提交 undefined 清标签，普通文字编辑只改变输入值。
	// 确认回调同步抛错直接传播；本组件未给 Input.onSubmit 注册独立提交处理，提交取决于这里是否匹配 select.confirm。
	handleInput(keyData: string): void {
		// 读取共享键位管理器，遵守用户绑定。
		const kb = getKeybindings();
		// select.confirm 优先，不把任何输入框默认提交路径都假定为此标签提交。
		if (kb.matches(keyData, "tui.select.confirm")) {
			// 取当前文本并 trim 首尾空白，因此不能保存只含空白或带首尾空白的标签。
			const value = this.input.getValue().trim();
			// 真值字符串作为新标签，空串转 undefined；可选回调没设置时不提交。
			this.onSubmit?.(this.entryId, value || undefined);
			// 取消匹配时不取/保存输入值。
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			// 有取消回调才调用，外壳随后恢复列表。
			this.onCancel?.();
		} else {
			// 其余按键由 Input 负责文字、光标、删除等操作，不同时进入树搜索。
			this.input.handleInput(keyData);
		}
	}
}

/**
 * Component that renders a session tree selector for navigation
 */
// 公开外壳组合树列表、提示和标签输入，Container 负责渲染，显式 handleInput 负责把焦点输入路由到当前模式。
export class TreeSelectorComponent extends Container implements Focusable {
	// 内部列表保留跨标签编辑的搜索、游标和折叠状态。
	private treeList: TreeList;
	// null 表示未编辑标签；LabelInput | null 是带空值的联合类型。
	private labelInput: LabelInput | null = null;
	// 标签编辑器占用的子容器，普通列表状态为空。
	private labelInputContainer: Container;
	// 树列表所在的子容器，进入标签编辑时只清这个容器，不销毁 treeList 对象。
	private treeContainer: Container;
	// 外部持久化回调可缺，组件更新包装不等于自动保存历史。
	private onLabelChangeCallback?: (entryId: string, label: string | undefined) => void;
	// 公开复制回调可在构造后设置，内部转发闭包在调用时读取最新字段。
	public onCopy?: (text: string | undefined) => void;

	// Focusable implementation - propagate to labelInput when active for IME cursor positioning
	// 外壳保存焦点状态，供稍后新建的 LabelInput 继承。
	private _focused = false;
	// 属性读取访问器返回外壳焦点，无状态修改；例：TUI 读取 selector.focused 判断焦点值。
	get focused(): boolean {
		// 返回自己的 _focused，不查树中哪行被选中。
		return this._focused;
	}
	// 属性赋值访问器保存焦点并传播给当前标签输入框，无返回值；例：切换 TUI 焦点时同时控制输入法光标定位。
	set focused(value: boolean) {
		// 始终保存状态，即使当前没有标签输入框。
		this._focused = value;
		// Propagate to labelInput when it's active
		// 仅有标签输入时才需要下传；TreeList 没有 focused 属性需要同步。
		if (this.labelInput) {
			// 下层 LabelInput 再继续把它传给真实 Input。
			this.labelInput.focused = value;
		}
	}

	// 输入树、真实叶子、终端高度及回调，创建完整树选择界面；先建列表和转发关系，再组装容器。
	// 例：InteractiveMode 取 getTree/getLeafId 快照传入，选中只回调 id，由宿主询问是否摘要并 navigateTree；标签保存另调 appendLabelChange。
	// 构造不会请求模型或改当前会话位置；空树安排 100ms 延后取消且没有取消句柄/dispose，提前关闭后仍可能迟到调用，其他构造/主题错误照常传播。
	constructor(
		// 完整会话树/森林，通常包含各分支及元数据，不只是模型当前可见消息。
		tree: SessionTreeNode[],
		// 真实叶子 id 快照用于路径标记、分支排序、默认初选和无文字助手豁免，不随用户移动选择而改变。
		currentLeafId: string | null,
		// 构造时的终端高度，用于条目页长，不订阅后续 resize。
		terminalHeight: number,
		// 选中回调只接收条目 id，返回值不等待；实际导航可由宿主 async 函数执行。
		onSelect: (entryId: string) => void,
		// 取消回调负责退出整个选择器，和取消标签输入回到列表不同。
		onCancel: () => void,
		// 可选标签变化回调接收目标 id 和标签/undefined，供宿主追加真实记录。
		onLabelChange?: (entryId: string, label: string | undefined) => void,
		// 显式初始选中 id 可覆盖真实叶子的初始定位。
		initialSelectedId?: string,
		// 可选模式是本列表的初值，不在此保存 SettingsManager 设置。
		initialFilterMode?: FilterMode,
	) {
		// 派生类先 super 初始化 Container，随后才能使用 this。
		super();

		// 保存外部标签回调引用，不立即调用。
		this.onLabelChangeCallback = onLabelChange;
		// 页长取终端高度一半向下取整且至少 5；还未扣外壳帮助高度，不能当作整个组件最多占半屏的保证。
		const maxVisibleLines = Math.max(5, Math.floor(terminalHeight / 2));

		// 新建 TreeList 时即完成展开、活动标记、过滤和初始选择。
		this.treeList = new TreeList(tree, currentLeafId, maxVisibleLines, initialSelectedId, initialFilterMode);
		// 确认回调直接转接，不额外检查选择是否等于当前叶子；宿主会再检查。
		this.treeList.onSelect = onSelect;
		// 普通取消直接交宿主，不负责持久化任何当前视图字段。
		this.treeList.onCancel = onCancel;
		// 箭头闭包在实际复制时才读 this.onCopy，因此构造后设置公开回调也能生效。
		this.treeList.onCopy = (text) => this.onCopy?.(text);
		// 列表请求编辑标签时，外壳创建编辑器而非立即保存。
		this.treeList.onLabelEdit = (entryId, currentLabel) => this.showLabelInput(entryId, currentLabel);

		// 新建树区域容器，和状态对象 treeList 的生命周期分开。
		this.treeContainer = new Container();
		// 树列表进入子容器，之后外壳可暂时把它移出显示。
		this.treeContainer.addChild(this.treeList);

		// 先建空标签区域，切换编辑模式时再放 Input 组件。
		this.labelInputContainer = new Container();

		// 整体顶部空一行，后续 addChild 顺序就是纵向布局顺序。
		this.addChild(new Spacer(1));
		// 顶部主题边框按实际渲染宽度生成。
		this.addChild(new DynamicBorder());
		// 标题 Text 用左右一列、上下零行内边距，原字符串还自带两个前导空格。
		this.addChild(new Text(theme.bold("  Session Tree"), 1, 0));
		// 帮助组件每次 render 读取当前首个配置键，而非固定默认文案。
		this.addChild(new TreeHelp());
		// 搜索提示持有同一个 treeList，能显示它最新查询。
		this.addChild(new SearchLine(this.treeList));
		// 标题帮助区域和条目区域之间再画分隔线。
		this.addChild(new DynamicBorder());
		// 列表前留一行空白。
		this.addChild(new Spacer(1));
		// 加入树区域容器，普通模式展示列表。
		this.addChild(this.treeContainer);
		// 加入标签区域，编辑时树区域空、这里显示标签输入。
		this.addChild(this.labelInputContainer);
		// 底部留一行空白。
		this.addChild(new Spacer(1));
		// 最后一个边框结束整个布局，不自动清理定时器或外部回调。
		this.addChild(new DynamicBorder());

		// 只看构造时输入根数组是否为空，不等于当前筛选无结果就自动取消。
		if (tree.length === 0) {
			// 闭包约 100ms 之后调用取消，不是精确时刻；没有保存句柄，也不检查选择器是否已关闭。
			setTimeout(() => onCancel(), 100);
		}
	}

	// 按条目 id 和原标签切入编辑模式，无返回值/文件写入；建 Input、接提交/取消回调、传焦点，再替换显示区域。
	// 例：保存 checkpoint 先改树包装，再调外部落盘回调，最后恢复列表；外部回调同步抛错时包装已改且编辑界面尚未关闭，没有自动回滚。异步回调返回值也不等待。
	private showLabelInput(entryId: string, currentLabel: string | undefined): void {
		// 每次打开新建 LabelInput，不复用上一次未提交输入内容。
		this.labelInput = new LabelInput(entryId, currentLabel);
		// 提交闭包接收编辑器 trim 后的标签和已保存目标 id。
		this.labelInput.onSubmit = (id, label) => {
			// 先修改内存树包装标签/时间，不重跑搜索、标签筛选或折叠排版。
			this.treeList.updateNodeLabel(id, label);
			// 再通知可选外部回调追加真实历史，未设置时只有本地包装变化。
			this.onLabelChangeCallback?.(id, label);
			// 外部同步返回后才恢复树列表，前一步抛错便不会执行这一句。
			this.hideLabelInput();
		};
		// 取消只恢复树列表，不提交当前输入或调用标签变更回调。
		this.labelInput.onCancel = () => this.hideLabelInput();

		// Propagate current focused state to the new labelInput
		// 新建输入继承外壳已保存的焦点布尔值，供下层 Input 输出光标标记。
		this.labelInput.focused = this._focused;

		// 清树区域的子组件数组，保留 this.treeList 对象和它当前状态。
		this.treeContainer.clear();
		// 清标签区域，避免同区域同时残留两个编辑器。
		this.labelInputContainer.clear();
		// 把新编辑器放进标签区域，外壳下一次 render 便显示它。
		this.labelInputContainer.addChild(this.labelInput);
	}

	// 退出标签编辑恢复原 TreeList，无参数/返回值，不保存标签或重筛节点；例：取消后查询和折叠仍保留，保存后的标签变化也不会在此重跑成员筛选。
	private hideLabelInput(): void {
		// 置 null 使输入路由恢复树列表，旧对象若被其他引用持有并不因此销毁。
		this.labelInput = null;
		// 移除标签区域的显示内容，Container.clear 不自动调用子组件 dispose。
		this.labelInputContainer.clear();
		// 清树区域防止重复加入列表实例。
		this.treeContainer.clear();
		// 把原 treeList 重新放回，当前选择和搜索并未重建。
		this.treeContainer.addChild(this.treeList);
	}

	// get 属性访问器告诉 TUI 当前是否由树接管视口导航，无状态修改；例：标签编辑期间返回 false，避免树导航语义干扰输入框。
	get capturesViewportInput(): boolean {
		// 只有没有标签编辑器时为 true，非根据外壳 focused 值判断。
		return this.labelInput === null;
	}

	// 路由一段输入给当前活动子组件，返回 void，不额外处理或等待异步回调；例：标签编辑时普通文字只改标签，列表状态下普通文字进入树搜索，子方法异常向外传播。
	handleInput(keyData: string): void {
		// 有编辑器就优先交它，避免同一次键盘输入进入两个模式。
		if (this.labelInput) {
			// 标签编辑器自行按配置处理确认/取消，其余交 Input。
			this.labelInput.handleInput(keyData);
		} else {
			// 非编辑状态的按键由 TreeList 处理移动、筛选、搜索等。
			this.treeList.handleInput(keyData);
		}
	}

	// 普通取值方法返回实际 TreeList 实例，无复制或副作用；例如测试通过它读取选中节点，返回对象与外壳内部状态相同，并非只读快照。
	getTreeList(): TreeList {
		// 直接返回内部引用，公开方法/回调仍可由调用者使用。
		return this.treeList;
	}
}
