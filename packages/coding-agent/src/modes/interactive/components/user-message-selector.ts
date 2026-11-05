// 展示供分叉的历史用户消息；只把选中条目的 id 交给宿主，不在此复制会话、写文件或发送模型请求。
// InteractiveMode 从所有分支收集用户文字并聚焦内部列表；宿主默认 fork(before) 保留该问题之前的路径，把问题文字回填编辑器。
import {
	// type 仅导入组件接口，编译后擦除；implements 用它检查下面的列表是否提供组件方法。
	type Component,
	// Container 按顺序组合子组件；本文件外壳借用其渲染和失效传播。
	Container,
	// 读取当前共享键位配置，避免把方向键或 Enter 的字节写死在组件中。
	getKeybindings,
	// 翻页助手只计算目标下标，不自动改变列表选择。
	getSelectPageIndex,
	// Spacer 产生空行，Text 显示带样式文字，truncateToWidth 按终端显示列裁剪。
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
// 主题负责颜色和粗体；这些控制序列不等于可见文字的列宽。
import { theme } from "../theme/theme.ts";
// 边框在渲染时读取主题，构造边框实例本身不启动动画或定时器。
import { DynamicBorder } from "./dynamic-border.ts";

// 单个候选项的开发期结构约束；接口不会在运行时验证外部数据或执行排序。
interface UserMessageItem {
	// 会话树条目 id，确认时原样回传；不是列表下标或会话文件 id。
	id: string; // Entry ID in the session
	// 待预览的原始文字；完整内容仍由宿主根据条目 id 查询。
	text: string; // The message text
	// ? 表示可以缺省；本文件实际不读取或显示这个时间字段。
	timestamp?: string; // Optional timestamp if available
}

/**
 * Custom user message list component with selection
 */
class UserMessageList implements Component {
	// 告诉 TUI 本列表接收视口导航输入；readonly 只限制 TS 再赋值，不冻结实例。
	readonly capturesViewportInput: boolean = true;
	// 私有字段存原数组引用，UserMessageItem[] 表示元素为上面接口的数组。
	private messages: UserMessageItem[] = [];
	// 0 基下标：下标 0 对应界面上的第 1 条；空列表初始仍用 0，但没有实际条目。
	private selectedIndex: number = 0;
	// 可选回调：接收条目 id，=> void 表示此处不使用回调返回值，也不会等待异步宿主。
	public onSelect?: (entryId: string) => void;
	// 可选无参数取消回调，列表自身没有关闭整个选择界面的能力。
	public onCancel?: () => void;
	// 最多显示 10 个消息项，每项占文字、序号、空白三行；不是总高度限制。
	private maxVisible: number = 10; // Max messages visible

	// 保存候选项并确定初始选择，无文件或模型副作用；参数顺序应已从旧到新，此处不排序也不复制。
	// 例：[a,b,c] 未给 id 时选 c，给 b 则选 b，给不存在的 id 仍选 c；空数组取下标 0 供空态渲染。
	constructor(messages: UserMessageItem[], initialSelectedId?: string) {
		// Store messages in chronological order (oldest to newest)
		// 直接保留调用者的引用，所以调用者后来修改数组也会影响后续读取。
		this.messages = messages;
		// 三元表达式按 id 是否为真值决定查找；findIndex 回调逐项比较 id，找不到返回 -1。
		const initialIndex = initialSelectedId ? messages.findIndex((message) => message.id === initialSelectedId) : -1;
		// Start with selected message if provided, else default to the most recent
		// 找到目标则用它，否则取末项；Math.max 防止空数组的 length-1 作为初始下标。
		this.selectedIndex = initialIndex >= 0 ? initialIndex : Math.max(0, messages.length - 1);
	}

	// 满足组件失效接口，没有缓存可清，无输入输出或副作用；例如父容器 invalidate 时调用后仍按当前状态重画。
	invalidate(): void {
		// No cached state to invalidate currently
	}

	// 根据可用终端列宽返回新行数组，不写终端、不移动选择；先处理空态，再取以选中项附近为中心的窗口。
	// 例如 20 项选第 11 项时只画其中 10 项，每项三行并加滚动计数；元数据/空态没有统一宽度裁剪，窄屏不保证所有行都适配。
	render(width: number): string[] {
		// string[] 是字符串数组类型，局部缓冲每次调用重新创建。
		const lines: string[] = [];

		// 空数组没有消息可取，直接生成提示，不进入后面的窗口计算。
		if (this.messages.length === 0) {
			// 按主题添加前景色及可能的 dim 样式；这条空态文字没有 truncateToWidth。
			lines.push(theme.fg("muted", "  No user messages found"));
			// 提前结束，返回包含空态的一行数组。
			return lines;
		}

		// Calculate visible range with scrolling
		// 起点尽量在选中项前半页，同时不能低于 0 或让末尾留出不足一页的空窗。
		const startIndex = Math.max(
			// 外层下界保证不足 10 项时也从首项开始。
			0,
			// 内层较小值限制靠近尾部时的起点；floor 对半页项数向下取整。
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.messages.length - this.maxVisible),
		);
		// 终点不包含 endIndex，最多画 maxVisible 项，也不能读到数组末尾之后。
		const endIndex = Math.min(startIndex + this.maxVisible, this.messages.length);

		// Render visible messages (2 lines per message + blank line)
		// let 允许递增 i；只遍历窗口内的消息，原数组和 selectedIndex 都不改变。
		for (let i = startIndex; i < endIndex; i++) {
			// 按下标读取当前候选对象，复用对象而不是深复制。
			const message = this.messages[i];
			// 严格相等结果是 boolean，后面据此决定游标和粗体。
			const isSelected = i === this.selectedIndex;

			// Normalize message to single line
			// 正则 g 替换全部 LF 换行，trim 再去首尾空白；不全面过滤内部 CR、tab 或 ANSI 控制码。
			const normalizedMessage = message.text.replace(/\n/g, " ").trim();

			// First line: cursor + message
			// 选中项用带强调色的两列游标，其余用两个空格占位。
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
			// 预留游标两列；极窄 width 可得到非正值，下层截断函数会返回空正文。
			const maxMsgWidth = width - 2; // Account for cursor (2 chars)
			// 按显示列取前缀，超宽时默认加三个点；与按 UTF-16 码元的 slice 不同。
			const truncatedMsg = truncateToWidth(normalizedMessage, maxMsgWidth);
			// + 拼接游标与正文，只给选中正文加粗；整条拼接结果没有再次按 width 裁剪。
			const messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);

			// 第一行进入结果，TUI 稍后统一负责把它输出到终端。
			lines.push(messageLine);

			// Second line: metadata (position in history)
			// 将数组下标换成用户熟悉的 1 基序号，不表示时间戳或树深度。
			const position = i + 1;
			// 模板字符串 ${...} 将当前序号和总项数插入提示文字。
			const metadata = `  Message ${position} of ${this.messages.length}`;
			// 序号只着色，不截断；timestamp 可选字段在这里也未使用。
			const metadataLine = theme.fg("muted", metadata);
			// 第二行显示这条消息在完整候选数组中的位置。
			lines.push(metadataLine);
			// 空字符串占一行，把相邻消息项隔开，最后一个消息项后也保留。
			lines.push(""); // Blank line between messages
		}

		// Add scroll indicator if needed
		// 窗口前后只要还有未显示的项，就额外显示当前选中序号/总数。
		if (startIndex > 0 || endIndex < this.messages.length) {
			// 这条计数也没有按 width 截断，不能把它当作精确适配任意窄屏的输出。
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.messages.length})`);
			// 计数附在全部可见消息项之后。
			lines.push(scrollInfo);
		}

		// 返回渲染结果，不在组件内部请求重画或写入会话。
		return lines;
	}

	// 处理一段终端按键数据，更新下标或调用确认/取消回调，返回 void；没有文字搜索输入。
	// 例：3 项时从首项按上移会选末项，确认只发送该项 id；实际 fork 由宿主异步完成，回调同步抛错会向外传播。
	// 上下移动没有空列表保护，空列表下标可能变成 -1 等值；确认分支仍检查条目存在，不能据下标认为一定有候选。
	handleInput(keyData: string): void {
		// 每次读取共享配置，用户覆盖键位后按动作匹配，而非只认默认箭头字节。
		const kb = getKeybindings();
		// 预先询问是否翻页：非翻页返回 undefined，空列表翻页可返回 0，调用方仍需检查项数。
		const pageIndex = getSelectPageIndex(kb, keyData, this.selectedIndex, this.messages.length, this.maxVisible);
		// Up arrow - go to previous (older) message, wrap to bottom when at top
		// if/else if 顺序决定多个动作绑定同一按键时先命中哪个分支。
		if (kb.matches(keyData, "tui.select.up")) {
			// 首项绕到末项，其余减一；空数组的 length-1 是 -1，这里不另行修复。
			this.selectedIndex = this.selectedIndex === 0 ? this.messages.length - 1 : this.selectedIndex - 1;
		}
		// Down arrow - go to next (newer) message, wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			// 末项绕到首项，其余加一；这里同样没有判空或单独夹住非法下标。
			this.selectedIndex = this.selectedIndex === this.messages.length - 1 ? 0 : this.selectedIndex + 1;
		}
		// Page up/down
		else if (pageIndex !== undefined) {
			// 用 !== undefined 接受合法下标 0，再单独拒绝空列表的翻页结果。
			if (this.messages.length === 0) return;
			// 保存助手已经按页面大小和首尾边界算好的目标下标。
			this.selectedIndex = pageIndex;
		}
		// Enter - select message and branch
		else if (kb.matches(keyData, "tui.select.confirm")) {
			// 空数组或非法下标读得 undefined，不凭确认键猜一个 id。
			const selected = this.messages[this.selectedIndex];
			// && 短路要求候选和回调都存在，再进入真正通知宿主的分支。
			if (selected && this.onSelect) {
				// 只通知选择；不 await 回调，也不在这里修改当前会话树。
				this.onSelect(selected.id);
			}
		}
		// Escape - cancel
		else if (kb.matches(keyData, "tui.select.cancel")) {
			// 可选回调未设置时取消键无副作用。
			if (this.onCancel) {
				// 调用宿主的关闭流程；组件自己不移除已加入的子组件。
				this.onCancel();
			}
		}
	}
}

/**
 * Component that renders a user message selector for branching
 */
export class UserMessageSelectorComponent extends Container {
	// private 仅限制 TS 访问，下面的取值方法仍会把同一个列表实例交给宿主聚焦；它是普通方法，并非 get 访问器。
	private messageList: UserMessageList;

	// 创建标题、边框和内部列表，把确认/取消回调接给列表；返回新组件，构造过程会确定初始下标，但不会自动创建会话。
	// 例：宿主把 [{id:"u1",text:"解释 TS"}] 传入，聚焦 getMessageList() 后确认才回调 u1；默认 fork(before) 会把该问题留给编辑器重发。
	// 空数组会安排约 100ms 之后取消，无定时器句柄或 dispose；即使外部提前关闭，回调仍可能迟到，错误交由定时器执行环境处理。
	constructor(
		// 候选按调用者提供的顺序显示；当前宿主收集全历史各分支 user 消息，而非只取活动路径。
		messages: UserMessageItem[],
		// 选择回调接收条目 id；签名不要求 Promise，因此本组件不等待宿主的异步 fork。
		onSelect: (entryId: string) => void,
		// 取消回调不带原因，普通取消和空列表延时取消都用它。
		onCancel: () => void,
		// ? 可省略，找不到对应 id 时内部列表默认选最后一项。
		initialSelectedId?: string,
	) {
		// 派生类先初始化 Container，随后才能通过 this 添加子组件。
		super();

		// Add header
		// 顶部先空一行；addChild 维护显示顺序，不立刻输出终端。
		this.addChild(new Spacer(1));
		// Text 参数 1/0 是水平/垂直内边距，标题正文按主题加粗。
		this.addChild(new Text(theme.bold("Fork from Message"), 1, 0));
		// 把说明文字组件加入外壳，多行调用整体仍是一条 addChild 语句。
		this.addChild(
			// Text 负责文字换行与布局；这段提示不实现实际路径复制逻辑。
			new Text(
				// 原界面提示按所选位置描述分叉；宿主实际默认在该用户问题之前分叉并回填问题。
				theme.fg("muted", "Select a user message to copy the active path up to that point into a new session"),
				// 左右各留一列内边距。
				1,
				// 不额外添加上下内边距。
				0,
			),
		);
		// 说明下先留空行，再画上边框和框内首行空白。
		this.addChild(new Spacer(1));
		// 动态边框依当前主题和传入渲染宽度生成分隔线。
		this.addChild(new DynamicBorder());
		// 列表与上边框之间隔开一行。
		this.addChild(new Spacer(1));

		// Create message list
		// 创建内部可交互列表，决定初始下标但不触发 onSelect。
		this.messageList = new UserMessageList(messages, initialSelectedId);
		// 直接保存回调引用，确认由内部列表转发。
		this.messageList.onSelect = onSelect;
		// 取消同样直接转发，无关闭状态或重复调用保护。
		this.messageList.onCancel = onCancel;

		// 将列表纳入容器渲染；焦点仍须由宿主单独设置到这个列表。
		this.addChild(this.messageList);

		// Add bottom border
		// 底部先空一行，再结束边框布局。
		this.addChild(new Spacer(1));
		// 下边框与上边框是两个独立组件实例。
		this.addChild(new DynamicBorder());

		// Auto-cancel if no messages
		// 只有构造时为空才安排取消；之后数组变空不会因此自动新增这个定时器。
		if (messages.length === 0) {
			// 箭头闭包延迟调用原回调；100 是最早调度延时而非精确截止时间，句柄没有保存供取消。
			setTimeout(() => onCancel(), 100);
		}
	}

	// 返回实际列表实例供宿主设为输入焦点，无复制/写盘；例如 showSelector 的 focus 使用此结果，外壳本身不转发 handleInput。
	getMessageList(): UserMessageList {
		// 公开内部对象意味着调用者可以通过其公共回调和方法与同一列表交互。
		return this.messageList;
	}
}
