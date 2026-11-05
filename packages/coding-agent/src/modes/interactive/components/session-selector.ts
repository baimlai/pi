/**
 * 恢复会话选择面板：宿主提供当前目录/全部会话加载器，组件维护缓存与进度、树形/文字筛选、选择、重命名和二次确认删除。
 * 例当前目录按 Tab 切全部时可立即展示已缓存部分列表；All迟到完成只更新它自己的缓存，不强行切回All画面。
 * 名字/消息搜索基于整份文件的 SessionInfo 概览，不是当前会话分支投影；真正恢复/名称条目保存交宿主，删除则在本文件试 trash 再永久 unlink。
 * 取消加载依控制器身份和合作信号；选择器没有通用关闭/任务序号保护来取消已发改名或删除，迟到变更回调仍可能重载。注释区分UI快照、文件副作用和实际完成。
 */
// 删除时同步启动 trash 命令；spawnSync 会阻塞当前线程，不因文件中其他函数 async 就自动变为非阻塞。
import { spawnSync } from "node:child_process";
// existsSync 查询目标是否仍存在，不能证明由哪个进程/工具移除了它。
import { existsSync } from "node:fs";
// unlink 是异步永久删除路径入口，区别于系统回收站，由下面的删除处理流程调用。
import { unlink } from "node:fs/promises";
// TUI 提供布局、输入、键位和显示列宽；type 项只在开发期约束。
import {
	// Component 要求 render/invalidate，不自动创建终端事件监听。
	type Component,
	// Container 按 children 排版，本文件自己处理键盘路由。
	Container,
	// Focusable 的 focused 字段由宿主设置，再传给当前输入组件。
	type Focusable,
	// 读共享键位管理器，部分动作另用构造传入的 manager。
	getKeybindings,
	// Input 管理搜索和重命名文字，setValue 不自动把光标移到末尾。
	Input,
	// Spacer 生成空行。
	Spacer,
	// Text 把标题/重命名提示按宽度折行。
	Text,
	// 按终端显示列截断字符串，ANSI 控制码不等于文字列宽。
	truncateToWidth,
	// 计算可见列数，区别于 UTF-16 length。
	visibleWidth,
} from "@earendil-works/pi-tui";
// 应用键位类可从配置文件 create，组件也允许宿主提供现成实例。
import { KeybindingsManager } from "../../../core/keybindings.ts";
// 概览/进度类型不在此导入运行 SessionManager；实际扫描由传入 loader 执行。
import type { SessionInfo, SessionListProgress } from "../../../core/session-manager.ts";
// 路径键尽量 realpath 后按平台比较，显示缩主目录是另一职责，不用于访问路径替换。
import { canonicalizePath, getPathComparisonKey, shortenHomePath } from "../../../utils/paths.ts";
// 共享主题用于每次 render/update 生成样式。
import { theme } from "../theme/theme.ts";
// 边框是普通布局组件，不直接启动终端。
import { DynamicBorder } from "./dynamic-border.ts";
// keyHint 生成带说明的动作帮助，keyText 只取配置键文字，不注册动作。
import { keyHint, keyText } from "./keybinding-hints.ts";
// 搜索/名字判定是实际函数，NameFilter/SortMode 的 type 导入擦除。
import { filterAndSortSessions, hasSessionName, type NameFilter, type SortMode } from "./session-selector-search.ts";

// 列表范围只有当前目录与全部；目录扫描范围/归属由各自 loader 决定，不由字符串标签自动保证。
type SessionScope = "current" | "all";

// formatSessionDate 用当前墙钟把输入 Date 转相对年龄文字，无文件写入；例如3分钟前得3m、8天约1w。以固定天数近似周/月/年，不按日历月或时区边界计算。
function formatSessionDate(date: Date): string {
	// 每次调用重新取当前 Date，列表不靠本函数安装定时刷新。
	const now = new Date();
	// 差值为毫秒，未来时间会是负数，Invalid Date 会产生 NaN，未另校验。
	const diffMs = now.getTime() - date.getTime();
	// 除60000向下取整得分钟，不四舍五入。
	const diffMins = Math.floor(diffMs / 60000);
	// 固定每小时3600000毫秒。
	const diffHours = Math.floor(diffMs / 3600000);
	// 固定每天86400000毫秒，不处理日历夏令时天长差异。
	const diffDays = Math.floor(diffMs / 86400000);

	// 不到1分钟显示 now，未来时间的负分钟也满足此条件。
	if (diffMins < 1) return "now";
	// 不到60分钟显示整分钟加 m。
	if (diffMins < 60) return `${diffMins}m`;
	// 不到24小时显示 h。
	if (diffHours < 24) return `${diffHours}h`;
	// 不到7天显示 d。
	if (diffDays < 7) return `${diffDays}d`;
	// 不到30天用7天一周近似，向下取整。
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	// 不到365天用30天一月近似，非自然月差。
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	// 其余按365天一年；无效日期可能显示 NaNy，类型 Date 不证明有效。
	return `${Math.floor(diffDays / 365)}y`;
}

/** Comparison key for a session file path; follows symlinks and ignores case on Windows. */
// getSessionPathKey 接文件路径，尽量跟随软链后生成比较键，返回字符串；例如两个现存软链别名可识别同一活动会话。会做同步 realpath 尝试，失败留原路径再绝对化，不证明文件仍存在。
function getSessionPathKey(path: string): string {
	// 从内到外：canonicalizePath 尽力 realpath，getPathComparisonKey 绝对化并在 Windows 折小写，仅供比较。
	return getPathComparisonKey(canonicalizePath(path));
}

// 标题组件保存展示状态，输出三行帮助；不自己扫描/删除/恢复会话。
class SessionSelectorHeader implements Component {
	// 当前显示范围标签。
	private scope: SessionScope;
	// 排序模式标签，和列表实际排序由外层分别同步。
	private sortMode: SortMode;
	// 是否仅有名会话的展示模式。
	private nameFilter: NameFilter;
	// 状态超时到期时通知外部重画的回调。
	private requestRender: () => void;
	// 初始不加载；设置时总会重置下方进度。
	private loading = false;
	// 对象联合 null 表示进度未知，loaded/total 是候选处理数，不保证等于有效会话数。
	private loadProgress: { loaded: number; total: number } | null = null;
	// 是否显示路径的提示状态，与列表另存一份。
	private showPath = false;
	// 非 null 表示确认删除状态，不是已经执行删除。
	private confirmingDeletePath: string | null = null;
	// 信息/错误状态对象或 null，文字展示不改变操作成败。
	private statusMessage: { type: "info" | "error"; message: string } | null = null;
	// ReturnType 从 setTimeout 的类型取句柄，null 表示未装或已清，不把泛型当运行时调用。
	private statusTimeout: ReturnType<typeof setTimeout> | null = null;
	// 重命名帮助默认不显示，是否可重命名仍由外层 callback 判断。
	private showRenameHint = false;

	// 构造接范围/排序/名字过滤与重绘回调，保存引用后返回新标题，无计时器/磁盘副作用；例如 current 显示当前目录标题，但不在此读取 cwd。
	constructor(scope: SessionScope, sortMode: SortMode, nameFilter: NameFilter, requestRender: () => void) {
		// 保存初始范围。
		this.scope = scope;
		// 保存初始排序标签。
		this.sortMode = sortMode;
		// 保存初始名字筛选标签。
		this.nameFilter = nameFilter;
		// 保存回调而不立即执行。
		this.requestRender = requestRender;
	}

	// setScope 只更新范围字段、返回 void，不加载或重绘；例如 Tab 切换时外层同时通知标题与列表。
	setScope(scope: SessionScope): void {
		// 直接替换范围标签。
		this.scope = scope;
	}

	// setSortMode 只改标题排序标签，无排序副作用/返回值；例如 recent 使下次 render 显示 Recent。
	setSortMode(sortMode: SortMode): void {
		// 保存排序模式。
		this.sortMode = sortMode;
	}

	// setNameFilter 只改标题名字筛选标签，返回 void；例如 named 显示 Named，不在此过滤数组。
	setNameFilter(nameFilter: NameFilter): void {
		// 替换标签字段。
		this.nameFilter = nameFilter;
	}

	// setLoading 保存加载布尔并清进度，返回 void，不发起请求；例如正在加载切换回来再次调用 true，旧计数也会被清空直到下一进度回调。
	setLoading(loading: boolean): void {
		// 保存新加载状态，值相同也继续后续清理。
		this.loading = loading;
		// Progress is scoped to the current load; clear whenever the loading state is set
		// 清上次计数，避免新加载沿用旧进度，不是把会话缓存清空。
		this.loadProgress = null;
	}

	// setProgress 接两个计数，保存新对象、返回 void，不自行重绘；例如5/10只是处理候选数，不等于5份有效会话。
	setProgress(loaded: number, total: number): void {
		// 对象简写存两个数，未验证范围/大小关系。
		this.loadProgress = { loaded, total };
	}

	// setShowPath 更新路径帮助开关，无返回/文件操作；例如列表切路径显示时同步标题的 on/off。
	setShowPath(showPath: boolean): void {
		// 只替换布尔字段。
		this.showPath = showPath;
	}

	// setShowRenameHint 控制是否加重命名帮助，无返回；例如 CLI --resume 不提供 rename 回调且隐藏说明，不在此禁用其他输入。
	setShowRenameHint(show: boolean): void {
		// 保存展示开关。
		this.showRenameHint = show;
	}

	// setConfirmingDeletePath 设置/清除确认标志，返回 void，不删除；例如 path 非 null 时标题先显示 Delete session?。
	setConfirmingDeletePath(path: string | null): void {
		// 保存原路径或 null，用存在性决定提示，不验证路径。
		this.confirmingDeletePath = path;
	}

	// clearStatusTimeout 停掉旧自动隐藏任务并清句柄，无返回；例如新错误替换旧成功提示前先停表，不改消息文字或移除组件。
	private clearStatusTimeout(): void {
		// 没有句柄直接返回；这里的真值判断按定时器句柄契约使用。
		if (!this.statusTimeout) return;
		// 停止尚未触发的 timeout，不等待已触发的重绘完成。
		clearTimeout(this.statusTimeout);
		// 清句柄引用。
		this.statusTimeout = null;
	}

	// setStatusMessage 先停旧计时→换状态→可选装自动隐藏，返回 void；例如 error配3000会稍后清消息并请求重绘。此方法本次赋值不主动重绘，0/省略不装超时，异常不吞。
	setStatusMessage(msg: { type: "info" | "error"; message: string } | null, autoHideMs?: number): void {
		// 避免旧 timer 把新消息提前清掉。
		this.clearStatusTimeout();
		// 保存对象原引用，没有深拷贝。
		this.statusMessage = msg;
		// 无消息或 autoHideMs 为假值就结束；负数为真值会沿 setTimeout 规则处理，并非统一验证正数。
		if (!msg || !autoHideMs) return;

		// 创建异步定时闭包，尚未立刻清消息；未 unref，宿主应按退出路径清理。
		this.statusTimeout = setTimeout(() => {
			// 到期移除展示状态。
			this.statusMessage = null;
			// 句柄设 null 表示已完成。
			this.statusTimeout = null;
			// 通知外部渲染新状态；回调抛错不在本类保护。
			this.requestRender();
			// 延迟毫秒传入系统定时器，调度不保证精确时点。
		}, autoHideMs);
	}

	// invalidate 无自有渲染缓存需要清理，空实现满足接口，不等于重新加载会话。
	invalidate(): void {}

	// render 接显示列宽，拼标题/范围/名字/排序及两行状态帮助，返回三行不写终端；例如删除确认优先于错误/普通帮助，窄屏分别截断。
	render(width: number): string[] {
		// 范围决定英文标题，不显示真实目录名。
		const title = this.scope === "current" ? "Resume Session (Current Folder)" : "Resume Session (All)";
		// 标题套粗体。
		const leftText = theme.bold(title);

		// threaded/recent/relevance 分别显示 Threaded/Recent/Fuzzy，最后是UI标签而非另一套排序值。
		const sortLabel = this.sortMode === "threaded" ? "Threaded" : this.sortMode === "recent" ? "Recent" : "Fuzzy";
		// 拼排序说明和强调模式。
		const sortText = theme.fg("muted", "Sort: ") + theme.fg("accent", sortLabel);

		// 名字筛选开关映成 All/Named。
		const nameLabel = this.nameFilter === "all" ? "All" : "Named";
		// 拼名字说明，不实际筛选概览。
		const nameText = theme.fg("muted", "Name: ") + theme.fg("accent", nameLabel);

		// let 声明后由各个加载/范围分支赋字符串。
		let scopeText: string;
		// 加载状态先于当前范围的普通选中标记。
		if (this.loading) {
			// 有计数就 loaded/total，否则省略号；未推断有效会话数量。
			const progressText = this.loadProgress ? `${this.loadProgress.loaded}/${this.loadProgress.total}` : "...";
			// 加载时保留 Current Folder 文案并显示 Loading，不代表 loader 一定是当前目录而非 all。
			scopeText = `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", `Loading ${progressText}`)}`;
			// 不加载且 current，强调当前目录。
		} else if (this.scope === "current") {
			// 选中/未选中符号只是展示，不是单独可点击选项。
			scopeText = `${theme.fg("accent", "◉ Current Folder")}${theme.fg("muted", " | ○ All")}`;
		} else {
			// 否则强调 All。
			scopeText = `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", "◉ All")}`;
		}

		// 先截右侧范围/筛选/排序信息，空尾标记不补省略号。
		const rightText = truncateToWidth(`${scopeText}  ${nameText}  ${sortText}`, width, "");
		// 右侧优先占宽，左标题最多剩余列减一个间隔，最小0。
		const availableLeft = Math.max(0, width - visibleWidth(rightText) - 1);
		// 按剩余宽度截左标题，可能全被截掉。
		const left = truncateToWidth(leftText, availableLeft, "");
		// 两侧间空白夹到非负，避免 repeat 收负数。
		const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(rightText));

		// Build hint lines - changes based on state (all branches truncate to width)
		// 第一行操作/状态帮助稍后按优先级赋值。
		let hintLine1: string;
		// 第二行帮助可为空，但最终数组仍保留该行。
		let hintLine2: string;
		// 非 null 确认标志最高优先，不展示普通操作列表。
		if (this.confirmingDeletePath !== null) {
			// 帮助使用配置确认/取消键，未把待删路径插进标题文字。
			const confirmHint = `Delete session? ${keyHint("tui.select.confirm", "confirm")} · ${keyHint("tui.select.cancel", "cancel")}`;
			// 先裁宽再着错误色，过长追加省略符。
			hintLine1 = theme.fg("error", truncateToWidth(confirmHint, width, "…"));
			// 确认状态下第二帮助行留空。
			hintLine2 = "";
			// 没有删除确认时才展示已有信息/错误。
		} else if (this.statusMessage) {
			// 错误用 error，普通信息用 accent。
			const color = this.statusMessage.type === "error" ? "error" : "accent";
			// 状态文字裁宽后着色，不做额外控制字符清理。
			hintLine1 = theme.fg(color, truncateToWidth(this.statusMessage.message, width, "…"));
			// 状态消息占第一帮助行，第二行清空。
			hintLine2 = "";
		} else {
			// 正常帮助先得到路径显示 on/off 标记。
			const pathState = this.showPath ? "(on)" : "(off)";
			// 操作之间用带 muted 色的中点分隔。
			const sep = theme.fg("muted", " · ");
			// 第一帮助行是范围切换与搜索语法，赋值在下一行继续。
			const hint1 =
				// re:和双引号短语说明只是帮助文字，解析在搜索模块中。
				keyHint("tui.input.tab", "scope") + sep + theme.fg("muted", 're:<pattern> regex · "phrase" exact');
			// 第二行各动作先收成数组，之后 join。
			const hint2Parts = [
				// 排序切换动作帮助。
				keyHint("app.session.toggleSort", "sort"),
				// 有名过滤动作帮助。
				keyHint("app.session.toggleNamedFilter", "named"),
				// 删除动作帮助，实际还需确认。
				keyHint("app.session.delete", "delete"),
				// 路径显示动作包含当前 on/off。
				keyHint("app.session.togglePath", `path ${pathState}`),
			];
			// 允许显示重命名帮助时才追加，不在此检查回调是否真的存在。
			if (this.showRenameHint) {
				// 动作名仍由共享键位格式化。
				hint2Parts.push(keyHint("app.session.rename", "rename"));
			}
			// 用分隔符把帮助段连成一串。
			const hint2 = hint2Parts.join(sep);
			// 第一行截到终端宽度。
			hintLine1 = truncateToWidth(hint1, width, "…");
			// 第二行同样截宽。
			hintLine2 = truncateToWidth(hint2, width, "…");
		}

		// 返回主标题行和两帮助行，字符串数组不代表已输出终端。
		return [`${left}${" ".repeat(spacing)}${rightText}`, hintLine1, hintLine2];
	}
}

/** A session tree node for hierarchical display */
// 树节点保留原 SessionInfo 引用及本次构造的子节点，不等于单会话内的消息树。
interface SessionTreeNode {
	// 某份会话文件概览。
	session: SessionInfo;
	// 由 parentSessionPath 关联到的派生会话列表。
	children: SessionTreeNode[];
	// 自己与全部后代 modified 的最大毫秒值，用于整棵子树排序。
	latestActivity: number;
}

/** Flattened node for display with tree structure info */
// 扁平展示节点把树关系转换为一行所需信息，不复制概览正文。
interface FlatSessionNode {
	// 原会话概览引用。
	session: SessionInfo;
	// 深度0为根，递增决定树形缩进。
	depth: number;
	// 是否本兄弟列表末项，决定画 └─ 或 ├─。
	isLast: boolean;
	/** For each ancestor level, whether there are more siblings after it */
	// 各祖先层是否仍有后续兄弟，用于竖线，不是祖先文件路径数组。
	ancestorContinues: boolean[];
}

/**
 * Build a tree structure from sessions based on parentSessionPath.
 * Returns root nodes sorted by modified date (descending).
 */
// buildSessionTree 按路径键建节点→按 parentSessionPath 挂父→递归算子树活跃时间→根/兄弟排序，返回根数组；例如旧父有新孩子，会整棵排到较新处，而非只按父 modified。
// 路径键会尽力 realpath；不验证父环/去重输入别名/限制递归深度。纯环没有根可被遗漏，重复规范路径可能重复挂同一节点，不能把输入当已校验无环树。
function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
	// 每次新建路径键到节点的 Map，不以会话 id 作树身份。
	const byPath = new Map<string, SessionTreeNode>();

	// 第一轮只创建节点，便于父文件出现在数组后面也可被查到。
	for (const session of sessions) {
		// 路径归一化比较可能做同步 realpath。
		const sessionPath = getSessionPathKey(session.path);
		// 同键后项覆盖 Map 值，但第二轮仍会遍历所有输入项；children 初始空，latest 先用自身时间。
		byPath.set(sessionPath, { session, children: [], latestActivity: session.modified.getTime() });
	}

	// 根列表新建为空，找不到父或无父的节点才放入。
	const roots: SessionTreeNode[] = [];

	// 第二轮按输入顺序建立边。
	for (const session of sessions) {
		// 重新计算此项路径键，未缓存两轮结果。
		const sessionPath = getSessionPathKey(session.path);
		// ! 非空断言依赖第一轮建过节点，不增加运行检查。
		const node = byPath.get(sessionPath)!;
		// 父路径真值才算键，空串视作没父；父可不在当前筛选结果中。
		const parentPath = session.parentSessionPath ? getSessionPathKey(session.parentSessionPath) : undefined;

		// 只有父键存在于这套节点表才挂孩子，不读取父正文来补全。
		if (parentPath && byPath.has(parentPath)) {
			// 直接向父 children 追加当前节点，没有自引用/环判断。
			byPath.get(parentPath)!.children.push(node);
		} else {
			// 缺父时按根展示，不报文件已损坏。
			roots.push(node);
		}
	}

	// updateLatestActivity 闭包递归返回并写入节点子树最大 modified，输入节点、输出毫秒数；例如父1/孩子3算3，无递归深度/环保护。
	const updateLatestActivity = (node: SessionTreeNode): number => {
		// 从节点自身时间起算，Date 无效可把后续 Math.max 变 NaN。
		let latestActivity = node.session.modified.getTime();
		// 递归所有子节点，不只取第一个。
		for (const child of node.children) {
			// 先取得孩子整棵最大值，再和当前最大值比较。
			latestActivity = Math.max(latestActivity, updateLatestActivity(child));
		}
		// 写回本次树节点，不改 SessionInfo.modified。
		node.latestActivity = latestActivity;
		// 把最大值返回上层父节点。
		return latestActivity;
	};

	// 每个根独立计算整棵子树活跃时间。
	for (const root of roots) {
		// 递归计算不是惰性渲染时才做，建树阶段即遍历。
		updateLatestActivity(root);
	}

	// Sort children and roots by latest activity in each subtree (descending)
	// sortNodes 对输入兄弟数组按 latestActivity 降序原地排序，再递归每个孩子数组，返回 void；例如活跃后代能同时影响根和其所在兄弟组顺序。
	const sortNodes = (nodes: SessionTreeNode[]): void => {
		// 排序差值新先旧后，等值保持引擎稳定排序的原序，不额外按名字打破平局。
		nodes.sort((a, b) => b.latestActivity - a.latestActivity);
		// 当前层排好后逐节点处理下一层。
		for (const node of nodes) {
			// 递归排序孩子，修改本次新建 children 数组。
			sortNodes(node.children);
		}
	};
	// 先从根列表启动整棵排序。
	sortNodes(roots);

	// 返回根节点集合，不把未连到根的环补回结果。
	return roots;
}

/**
 * Flatten tree into display list with tree structure metadata.
 */
// flattenSessionTree 接根数组，深度优先展平成行元数据，返回新数组；例如根/孩子/孙子依次出现，祖先续线列表供 render 使用。递归无深度/环守卫，不修改原概览。
function flattenSessionTree(roots: SessionTreeNode[]): FlatSessionNode[] {
	// 本次扁平结果为空。
	const result: FlatSessionNode[] = [];

	// walk 闭包输入节点/深度/祖先续线/本层末项标志，先追加自己再递归孩子，返回 void；会追加 result，例两个兄弟分别带不同 isLast。
	const walk = (node: SessionTreeNode, depth: number, ancestorContinues: boolean[], isLast: boolean): void => {
		// 新建行壳但复用 session/当前 ancestorContinues 引用；后面给孩子新建祖先数组。
		result.push({ session: node.session, depth, isLast, ancestorContinues });

		// 按已排序的孩子顺序遍历。
		for (let i = 0; i < node.children.length; i++) {
			// 最后一个孩子标 true，用于该孩子自己的弯角符号。
			const childIsLast = i === node.children.length - 1;
			// Only show continuation line for non-root ancestors
			// 根层不画祖先续线，非根层按自己是否还有兄弟决定继续竖线。
			const continues = depth > 0 ? !isLast : false;
			// 孩子深度+1，展开复制并追加本层续线；! 依循环范围，不验证节点图。
			walk(node.children[i]!, depth + 1, [...ancestorContinues, continues], childIsLast);
		}
	};

	// 按根顺序递归，每棵从深度0开始。
	for (let i = 0; i < roots.length; i++) {
		// 根无祖先数组，最后一个根也带 isLast，但根行自身不画分支角。
		walk(roots[i]!, 0, [], i === roots.length - 1);
	}

	// 返回已平铺的行，保留深度/续线数据而不是直接返回字符串。
	return result;
}

/**
 * Custom session list component with multi-line items and search
 */
// SessionList 管理搜索/树形或平铺显示/光标与删除确认，记录来自外层 loader；不自己加载磁盘概览。
class SessionList implements Component, Focusable {
	// getSelectedSessionPath 读当前过滤项路径，返回字符串或 undefined，无状态修改；例如空结果确认前不会伪造一个路径。
	public getSelectedSessionPath(): string | undefined {
		// 下标可能越界，普通数组读取得 undefined。
		const selected = this.filteredSessions[this.selectedIndex];
		// ?. 只在存在选中项时取概览路径，不返回规范化比较键。
		return selected?.session.path;
	}
	// 输入会话列表原引用，后面 setSessions 可替换。
	private allSessions: SessionInfo[] = [];
	// 过滤后显示行，可包含树形深度信息。
	private filteredSessions: FlatSessionNode[] = [];
	// 选中0起始下标；部分空结果导航能改成 -1，筛选函数只夹上界，并非始终非负。
	private selectedIndex: number = 0;
	// 是否进入普通导航/搜索等处理，控制增量加载是否尝试保留原选择；某些上方专用动作不设置它。
	private selectionTouched = false;
	// 搜索 Input 保存原查询与光标。
	private searchInput: Input;
	// 是否显示 cwd，外层用 all 范围时为 true，但本字段不是扫描范围本身。
	private showCwd = false;
	// 初始 threaded，无查询时展示会话父子树。
	private sortMode: SortMode = "threaded";
	// 初始不过滤无名字会话。
	private nameFilter: NameFilter = "all";
	// 传入键位实例仅部分操作直接使用；多数动作每次读共享 getKeybindings。
	private keybindings: KeybindingsManager;
	// 是否在每行右侧显示会话文件路径。
	private showPath = false;
	// 删除确认的原路径或 null，确认期间先拦截所有输入。
	private confirmingDeletePath: string | null = null;
	// 构造时当前活动会话的比较键，仅保护这一份活动路径快照，不动态跟随外部切会话。
	private currentSessionPathKey?: string;
	// 可选选择通知，交宿主真正恢复会话。
	public onSelect?: (sessionPath: string) => void;
	// 可选关闭通知，不自动删除或保存。
	public onCancel?: () => void;
	// 退出回调有空函数默认值，但本类 handleInput 没有直接调用 onExit 的分支；不要从字段名推 Ctrl+C 必走退出。
	public onExit: () => void = () => {};
	// 切 current/all 的外部通知。
	public onToggleScope?: () => void;
	// 切排序模式的外部通知。
	public onToggleSort?: () => void;
	// 切有名筛选的外部通知。
	public onToggleNameFilter?: () => void;
	// 切路径显示时通知标题同步。
	public onTogglePath?: (showPath: boolean) => void;
	// 确认目标变化时通知标题提示。
	public onDeleteConfirmationChange?: (path: string | null) => void;
	// 异步删除由外层安装，handleInput 用 void 发起，不等待或统一捕获其拒绝。
	public onDeleteSession?: (sessionPath: string) => Promise<void>;
	// 重命名通知传所选原路径，能否重命名由外层判断。
	public onRenameSession?: (sessionPath: string) => void;
	// 列表级错误提示，例如禁止删活动会话，不是一个全局异常捕获器。
	public onError?: (message: string) => void;
	// 窗口最多10份会话行，搜索框/状态/滚动提示另外占行。
	private maxVisible: number = 10; // Max sessions visible (one line each)

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	// 内部焦点初始 false。
	private _focused = false;
	// focused getter 返回焦点标记，无副作用，例如宿主读它不会修改搜索。
	get focused(): boolean {
		// 直接读字段。
		return this._focused;
	}
	// focused setter 同时更新搜索 Input，返回隐式 void；例如宿主聚焦列表时给 IME 定位，不改变当前会话。
	set focused(value: boolean) {
		// 保存列表焦点。
		this._focused = value;
		// 透传给搜索框。
		this.searchInput.focused = value;
	}

	// 构造接初始概览、cwd显示、排序/名字过滤、键位和可选活动路径，保存引用→建搜索→算活动键→初筛→装提交回调；无异步加载/删除。例如空列表仍可先展示搜索框。
	constructor(
		// 初始会话数组，直接保留引用。
		sessions: SessionInfo[],
		// 右侧是否显示 cwd，不在此验证概览属于当前目录。
		showCwd: boolean,
		// 初始排序模式。
		sortMode: SortMode,
		// 初始名字筛选。
		nameFilter: NameFilter,
		// 应用键位实例，与共享 manager 可能不是同一对象。
		keybindings: KeybindingsManager,
		// 活动路径可缺省，缺省则此列表无法保护某份当前会话。
		currentSessionFilePath?: string,
	) {
		// 保存原数组，不逐项复制。
		this.allSessions = sessions;
		// 显示结果先空，稍后根据模式生成。
		this.filteredSessions = [];
		// 创建搜索输入框，未自动取得焦点。
		this.searchInput = new Input();
		// 保存 cwd 显示开关。
		this.showCwd = showCwd;
		// 保存排序模式。
		this.sortMode = sortMode;
		// 保存名字过滤模式。
		this.nameFilter = nameFilter;
		// 保存传入键位实例。
		this.keybindings = keybindings;
		// 有真值路径才计算活动比较键；文件之后变化不会自动重新设当前键。
		this.currentSessionPathKey = currentSessionFilePath ? getSessionPathKey(currentSessionFilePath) : undefined;
		// 空查询初筛，threaded 会建树，不发选择通知。
		this.filterSessions("");

		// Handle Enter in search input - select current item
		// 搜索 Input 识别自己的提交键时也可选择当前项；例如未被外层确认分支消费的 LF。
		this.searchInput.onSubmit = () => {
			// 当前下标有项才处理。
			if (this.filteredSessions[this.selectedIndex]) {
				// 取当前行，不捕获构造时首会话。
				const selected = this.filteredSessions[this.selectedIndex];
				// 只有宿主安装了选择回调才调用。
				if (this.onSelect) {
					// 回传原 session.path，不在列表里打开会话文件。
					this.onSelect(selected.session.path);
				}
			}
		};
	}

	// setSortMode 更新模式后按当前查询重筛，返回 void；例如切 threaded 且无查询才建树，不自动重置查询或发送选择。
	setSortMode(sortMode: SortMode): void {
		// 替换模式字段。
		this.sortMode = sortMode;
		// 读取完整搜索值，重建过滤/树行。
		this.filterSessions(this.searchInput.getValue());
	}

	// setNameFilter 更新名字开关并用原查询重筛，返回 void；例如 named 排除 trim 后空名，不重扫文件或更新全列表。
	setNameFilter(nameFilter: NameFilter): void {
		// 替换名字过滤标签。
		this.nameFilter = nameFilter;
		// 重新生成显示结果，选中下标只按过滤逻辑夹上界。
		this.filterSessions(this.searchInput.getValue());
	}

	// setSessions 替换加载快照/显示范围，按原查询重筛，再按操作状态调整光标，返回 void；例如用户尚未触摸列表时新批次到来总选首项，触摸后尽量按原路径保留，不执行会话恢复。
	setSessions(sessions: SessionInfo[], showCwd: boolean): void {
		// 已触摸才捕获当前所选原路径，未操作时不锁定某个还在变化的增量结果。
		const selectedPath = this.selectionTouched ? this.getSelectedSessionPath() : undefined;
		// 保留新数组引用，不合并旧列表或复制会话对象。
		this.allSessions = sessions;
		// 同步右侧 cwd 显示开关。
		this.showCwd = showCwd;
		// 用现有搜索/模式重建结果，过程中会夹下标上界。
		this.filterSessions(this.searchInput.getValue());
		// 未进入普通操作时，增量列表仍以新首项为默认。
		if (!this.selectionTouched) {
			// 强制0，空列表也为0但读取仍可能 undefined。
			this.selectedIndex = 0;
			// 已操作且先前确有路径才尝试恢复同项。
		} else if (selectedPath) {
			// 用原路径字符串严格相等，不用软链比较键；找不到就沿当前夹过的数字下标。
			const selectedIndex = this.filteredSessions.findIndex((node) => node.session.path === selectedPath);
			// 找到的非负下标才采用，不把 -1 作为末项。
			if (selectedIndex >= 0) this.selectedIndex = selectedIndex;
		}
	}

	// filterSessions 先按名字筛→threaded空查询建树，否则调用搜索并包装平铺行→夹光标上界，返回 void；例如 typed查询时 threaded 也不显示父树，只显示相关度匹配项。
	private filterSessions(query: string): void {
		// trim 仅用于判断有没有有效查询，搜索 helper 自己再解析原 query。
		const trimmed = query.trim();
		// 名字筛选在建树前执行，去掉父后其仍保留孩子可作为根。
		const nameFiltered =
			// all 复用原数组；named 以 trim 后非空名字判断，不依据文件名。
			this.nameFilter === "all" ? this.allSessions : this.allSessions.filter((session) => hasSessionName(session));

		// 只有 threaded 且查询全空白才建树。
		if (this.sortMode === "threaded" && !trimmed) {
			// Threaded mode without search: show tree structure
			// 按 parentSessionPath 和子树最近活跃时间构建节点。
			const roots = buildSessionTree(nameFiltered);
			// 深度优先转成带缩进元数据的显示列表。
			this.filteredSessions = flattenSessionTree(roots);
		} else {
			// Other modes or with search: flat list
			// 其他模式/非空查询走搜索 helper，名字已滤过所以传 all，避免重复名字筛选。
			const filtered = filterAndSortSessions(nameFiltered, query, this.sortMode, "all");
			// 匹配项包装成新的平铺行，不改概览字段。
			this.filteredSessions = filtered.map((session) => ({
				// 保留原 SessionInfo 引用。
				session,
				// 每项深度0，不画嵌套树枝。
				depth: 0,
				// 平铺项统一视作末项，但深度0本来也不画弯角。
				isLast: true,
				// 每项单独空祖先列表。
				ancestorContinues: [],
			}));
		}
		// 只把下标上界限制到至少0的尾下标；原下标若为 -1 仍保留 -1，不是双侧夹紧。
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredSessions.length - 1));
	}

	// setConfirmingDeletePath 保存确认目标并同步通知外部，返回 void；例如设 null 让标题退出确认，不删除文件也不自动回滚其他状态。
	private setConfirmingDeletePath(path: string | null): void {
		// 保存原路径/null。
		this.confirmingDeletePath = path;
		// 可选回调同步通知，异常直接传播，之前字段已改变。
		this.onDeleteConfirmationChange?.(path);
	}

	// startDeleteConfirmationForSelectedSession 取当前项→阻止构造时活动路径→设置确认目标，返回 void，无文件删除；例如活动会话的软链别名也按比较键阻止，保护不是运行时全局活动状态校验。
	private startDeleteConfirmationForSelectedSession(): void {
		// 当前下标取行，空列表或 -1 可得 undefined。
		const selected = this.filteredSessions[this.selectedIndex];
		// 无项就不显示确认提示。
		if (!selected) return;

		// Prevent deleting current session
		// 按尽力规范的路径键识别当前活动文件，不按会话 id 或标题比较。
		if (this.isCurrentSessionPath(selected.session.path)) {
			// 通知错误提示，未安装回调就只消费操作。
			this.onError?.("Cannot delete the currently active session");
			// 活动项不进入确认状态。
			return;
		}

		// 保存所选原路径，真正删除需下一次配置确认动作。
		this.setConfirmingDeletePath(selected.session.path);
	}

	// isCurrentSessionPath 接候选路径，返回是否等于构造时活动比较键；例如同现存软链目标为 true，可能做 realpath I/O，失败回退规则不保证识别所有别名。
	private isCurrentSessionPath(path: string): boolean {
		// 没有活动键则全部判非当前，不推测默认首项为当前会话。
		if (!this.currentSessionPathKey) return false;
		// 候选每次重新生成键，与保留的活动键严格比较；文件在两次操作间可改变，不是原子安全锁。
		return getSessionPathKey(path) === this.currentSessionPathKey;
	}

	// invalidate 不缓存列表文字，空实现不重新扫描或重建搜索 Input。
	invalidate(): void {}

	// render 输入显示列宽，返回搜索框/最多10会话行/滚动提示，依名字或首用户消息展示，右侧为计数/年龄/可选目录路径；只生成显示行，不恢复会话或写终端，活动路径比较可尝试 realpath。
	// 例如有名会话用 warning，活动会话 accent、待删项 error 优先；最后整行裁宽，前面给消息最少10列不保证窄屏仍完整显示右侧。
	render(width: number): string[] {
		// 本次输出行数组初始空。
		const lines: string[] = [];

		// Render search input
		// 展开搜索框渲染结果追加，不把子数组直接当一行。
		lines.push(...this.searchInput.render(width));
		// 搜索框后空行，不算会话窗口名额。
		lines.push(""); // Blank line after search

		// 无显示会话时使用空结果分支，不计算滚动窗口。
		if (this.filteredSessions.length === 0) {
			// 空提示稍后按名字筛选/cwd显示赋值。
			let emptyMessage: string;
			// named 优先给出取消有名筛选的提示，未区分是搜索过滤为空还是源列表无名。
			if (this.nameFilter === "named") {
				// 读取当前名字筛选动作的键文字，而非固定写快捷键。
				const toggleKey = keyText("app.session.toggleNamedFilter");
				// showCwd 在正常 all 范围为真，空提示据此选文案。
				if (this.showCwd) {
					// 全部范围的有名空结果提示。
					emptyMessage = `  No named sessions found. Press ${toggleKey} to show all.`;
				} else {
					// 当前目录的有名空结果还建议 Tab；这段 Tab 文字固定，实际范围动作仍可重绑。
					emptyMessage = `  No named sessions in current folder. Press ${toggleKey} to show all, or Tab to view all.`;
				}
				// 不是 named 且 showCwd 时，使用全范围空提示。
			} else if (this.showCwd) {
				// "All" scope - no sessions anywhere that match filter
				// 显示普通无会话文字。
				emptyMessage = "  No sessions found";
			} else {
				// "Current folder" scope - hint to try "all"
				// 当前目录空结果提示固定写 Tab，不自动匹配配置改名。
				emptyMessage = "  No sessions in current folder. Press Tab to view all.";
			}
			// 裁宽再着 muted 色，不画可选择的假会话。
			lines.push(theme.fg("muted", truncateToWidth(emptyMessage, width, "…")));
			// 提前返回当前输出数组。
			return lines;
		}

		// Calculate visible range with scrolling
		// 窗口尽量围绕光标居中，同时夹到有效起点。
		const startIndex = Math.max(
			// 起点最少0。
			0,
			// 往前留半窗，尾页最多从总项数减窗口开始；外层 Math.max 处理列表不足窗口的负值。
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredSessions.length - this.maxVisible),
		);
		// 结束下标不含自身，最多列表长度。
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredSessions.length);

		// Render visible sessions (one line each with tree structure)
		// 仅遍历可见窗口，行顺序保持建树/搜索结果。
		for (let i = startIndex; i < endIndex; i++) {
			// ! 基于循环上下界与数组契约，不运行结构校验。
			const node = this.filteredSessions[i]!;
			// 局部别名仍引用原概览。
			const session = node.session;
			// 按数字下标判当前浏览行，可能和活动会话是两行。
			const isSelected = i === this.selectedIndex;
			// 待删样式按原路径字符串比较，不按规范键。
			const isConfirmingDelete = session.path === this.confirmingDeletePath;
			// 活动样式按规范比较键，和上项规则不同。
			const isCurrent = this.isCurrentSessionPath(session.path);

			// Build tree prefix
			// 由深度/祖先续线生成树枝前缀，平铺深度0为空。
			const prefix = this.buildTreePrefix(node);

			// Session display text (name or first message)
			// !! 转布尔但不 trim；空格名字算有名样式，和 named 筛选的 trim 判定不同。
			const hasName = !!session.name;
			// ?? 仅在名字 null/undefined 时用首消息；显式空字符串也保留，不回退首消息。
			const displayText = session.name ?? session.firstMessage;
			// 把每个 C0/DEL 字符换成空格并 trim，不是通用 ANSI 解析或 C1 过滤；连续控制符可产生多个空格。
			const normalizedMessage = displayText.replace(/[\x00-\x1f\x7f]/g, " ").trim();

			// Right side: message count and age
			// 根据 modified 算近似年龄，创建时间不参与这段显示。
			const age = formatSessionDate(session.modified);
			// 将所有 message 条目计数转文字，不等于用户轮次或消息可见行数。
			const msgCount = String(session.messageCount);
			// 右侧先放计数和年龄，let 允许后面加目录/路径。
			let rightPart = `${msgCount} ${age}`;
			// 允许显示 cwd 且其真值非空才加工作目录。
			if (this.showCwd && session.cwd) {
				// 只为显示缩主目录，不用缩写结果访问文件。
				rightPart = `${shortenHomePath(session.cwd)} ${rightPart}`;
			}
			// 路径显示开关独立于 cwd 是否显示。
			if (this.showPath) {
				// 把会话文件路径放到右侧最前，仍保留计数/年龄。
				rightPart = `${shortenHomePath(session.path)} ${rightPart}`;
			}

			// Cursor
			// 当前浏览行有强调游标，其他用两空格对齐。
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";

			// Calculate available width for message
			// 树形前缀的终端列宽，不用字符串码元数。
			const prefixWidth = visibleWidth(prefix);
			// 右侧宽度额外预留两列间距。
			const rightWidth = visibleWidth(rightPart) + 2; // +2 for spacing
			// 整行宽度再扣两列游标，得到消息理论剩余空间，可为负。
			const availableForMsg = width - 2 - prefixWidth - rightWidth; // -2 for cursor

			// 消息先用至少10列裁剪，窄屏可能超预算，下面整行再截断兜到 width。
			const truncatedMsg = truncateToWidth(normalizedMessage, Math.max(10, availableForMsg), "…");

			// Style message
			// 消息色用字面量联合或 null，后者代表保持原文字颜色。
			let messageColor: "error" | "warning" | "accent" | null = null;
			// 待删除样式最高优先。
			if (isConfirmingDelete) {
				// 消息用 error 色。
				messageColor = "error";
				// 未待删才看活动会话状态。
			} else if (isCurrent) {
				// 活动消息用 accent。
				messageColor = "accent";
				// 其余有真值名字的行用特殊名字颜色。
			} else if (hasName) {
				// warning 是名字样式，不代表该会话有错误。
				messageColor = "warning";
			}
			// 有颜色才套主题，否则原截断消息；let 允许选中后再加粗。
			let styledMsg = messageColor ? theme.fg(messageColor, truncatedMsg) : truncatedMsg;
			// 选中项不论何种消息色都加粗。
			if (isSelected) {
				// 粗体叠到已有颜色串，不改变活动/确认状态。
				styledMsg = theme.bold(styledMsg);
			}

			// Build line
			// 游标+变暗树枝+消息形成左半行。
			const leftPart = cursor + theme.fg("dim", prefix) + styledMsg;
			// 算完整左半行可见宽度。
			const leftWidth = visibleWidth(leftPart);
			// 左右至少一格间距，空间不足不压成负数；整行后面统一裁宽。
			const spacing = Math.max(1, width - leftWidth - visibleWidth(rightPart));
			// 待删时右侧同样用 error，否则 dim。
			const styledRight = theme.fg(isConfirmingDelete ? "error" : "dim", rightPart);

			// 把左右文字拼成候选整行。
			let line = leftPart + " ".repeat(spacing) + styledRight;
			// 选中浏览行再加背景色，活动会话未选中不因此获得该背景。
			if (isSelected) {
				// 给整行加 selectedBg，仍需最后裁宽。
				line = theme.bg("selectedBg", line);
			}
			// 按全宽裁整行，默认截断尾标由 helper 决定，可能裁掉部分右侧。
			lines.push(truncateToWidth(line, width));
		}

		// Add scroll indicator if needed
		// 窗口外还有会话才显示计数。
		if (startIndex > 0 || endIndex < this.filteredSessions.length) {
			// 序号用1起始下标/当前过滤会话数，不是加载候选数。
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredSessions.length})`;
			// 先裁宽再着 muted，空尾标不补省略号。
			const scrollInfo = theme.fg("muted", truncateToWidth(scrollText, width, ""));
			// 滚动提示另占一行，不在10会话预算内。
			lines.push(scrollInfo);
		}

		// 返回行数组，外部 TUI 安排写终端。
		return lines;
	}

	// buildTreePrefix 按扁平节点生成树枝文字，无副作用；例如根无前缀，末孩子用 └─，有后续祖先兄弟时保留竖线，返回串未着色。
	private buildTreePrefix(node: FlatSessionNode): string {
		// 深度0根项不显示分支符号。
		if (node.depth === 0) {
			// 直接返回空串。
			return "";
		}

		// 每个祖先标志映成竖线+空格或三空格，不按真实文件路径推断层级。
		const parts = node.ancestorContinues.map((continues) => (continues ? "│  " : "   "));
		// 本层末兄弟选弯角，其他选分叉。
		const branch = node.isLast ? "└─ " : "├─ ";
		// 连接各祖先段后加当前分支，深度大时前缀也长，没有此方法的宽度预算。
		return parts.join("") + branch;
	}

	// handleInput 先独占删除确认，再处理范围/排序/名字/路径/删除/重命名等专用动作，最后导航/搜索/选择/取消；返回 void，回调异常不吞，异步删除用 void 发起不等待。
	// 例如确认模式下 Tab/普通文字都忽略，确认先清状态再调删除；查询非空的非侵入删除别名交 Input 删除文字，不触发会话删除。没有独立 onExit 调用分支。
	handleInput(keyData: string): void {
		// 大多数动作读当前共享 manager，而非保存的 this.keybindings。
		const kb = getKeybindings();

		// Handle delete confirmation state first - intercept all keys
		// 确认状态先于全部其他动作，避免删除过程中误导航到另一目标。
		if (this.confirmingDeletePath !== null) {
			// 配置确认动作才发起删除，不额外把所有 LF 都当确认。
			if (kb.matches(keyData, "tui.select.confirm")) {
				// 先捕获原目标路径，因为下一行会清字段。
				const pathToDelete = this.confirmingDeletePath;
				// 退出确认并通知标题，再开始删除，不等待文件操作完毕才恢复其他键。
				this.setConfirmingDeletePath(null);
				// 可选异步删除通知，void 不捕获拒绝或等待；回调抛同步异常仍向外传播。
				void this.onDeleteSession?.(pathToDelete);
				// 确认键不再选择会话或输入搜索。
				return;
			}
			// 确认状态下取消只退出确认，不关闭整个选择器。
			if (kb.matches(keyData, "tui.select.cancel")) {
				// 清目标并通知外部标题。
				this.setConfirmingDeletePath(null);
				// 消费取消动作。
				return;
			}
			// Ignore all other keys while confirming
			// 其他所有键在确认状态下都忽略，不输入搜索或触摸 selectionTouched。
			return;
		}

		// 范围切换动作优先于普通导航。
		if (kb.matches(keyData, "tui.input.tab")) {
			// 有外部回调才切模式。
			if (this.onToggleScope) {
				// 同步通知外部，由它切缓存/启动 loader。
				this.onToggleScope();
			}
			// 无回调也消费动作，selectionTouched 不改。
			return;
		}

		// 排序动作交外部按既定周期切换。
		if (kb.matches(keyData, "app.session.toggleSort")) {
			// 可选调用，不在这里直接写 sortMode。
			this.onToggleSort?.();
			// 消费后不进搜索。
			return;
		}

		// 名字筛选动作特意使用构造传入的 manager，可能与共享配置实例不同。
		if (this.keybindings.matches(keyData, "app.session.toggleNamedFilter")) {
			// 通知外层同时同步标题和列表筛选。
			this.onToggleNameFilter?.();
			// 结束本次输入。
			return;
		}

		// Ctrl+P: toggle path display
		// 路径显示按配置动作匹配，原英文是默认快捷键说明，不是硬编码判断。
		if (kb.matches(keyData, "app.session.togglePath")) {
			// 本地布尔取反，立即影响下次 render。
			this.showPath = !this.showPath;
			// 通知外层标题同步路径提示。
			this.onTogglePath?.(this.showPath);
			// 不把动作送进搜索框。
			return;
		}

		// Ctrl+D: initiate delete confirmation (useful on terminals that don't distinguish Ctrl+Backspace from Backspace)
		// 主删除动作即使搜索非空也能启动确认。
		if (kb.matches(keyData, "app.session.delete")) {
			// 检查当前项/活动保护后设置待删目标，不立刻删除。
			this.startDeleteConfirmationForSelectedSession();
			// 消费动作，不标普通选择已触摸。
			return;
		}

		// Rename selected session
		// 重命名动作不等于在此保存名称，只回传路径。
		if (kb.matches(keyData, "app.session.rename")) {
			// 取当前过滤行。
			const selected = this.filteredSessions[this.selectedIndex];
			// 有行才通知外层。
			if (selected) {
				// 未装 rename 回调就无操作；外层还会检查范围加载中是否允许。
				this.onRenameSession?.(selected.session.path);
			}
			// 动作不进入搜索或设置 selectionTouched 的阶段。
			return;
		}

		// Ctrl+Backspace: non-invasive convenience alias for delete
		// Only triggers deletion when the query is empty; otherwise it is forwarded to the input
		// 非侵入删除别名是否删会话取决于原搜索串是否完全为空。
		if (kb.matches(keyData, "app.session.deleteNoninvasive")) {
			// 按 length>0 判断，只有空白的搜索也视为有输入，不按 trim 后内容判空。
			if (this.searchInput.getValue().length > 0) {
				// 有查询时送 Input 处理文字删除，不启动确认。
				this.searchInput.handleInput(keyData);
				// 按处理后查询重新过滤，选中下标只夹上界。
				this.filterSessions(this.searchInput.getValue());
				// 结束这次别名操作。
				return;
			}

			// 查询真为空才走会话删除确认。
			this.startDeleteConfirmationForSelectedSession();
			// 不继续普通导航/搜索流程。
			return;
		}

		// 进入以下常规处理即标已触摸，包含选择/取消/未知输入，并不只指上下移动。
		this.selectionTouched = true;
		// Up arrow
		// 上移动作按共享配置判断。
		if (kb.matches(keyData, "tui.select.up")) {
			// 减1并夹0，空结果也可能把 -1 修回0。
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		}
		// Down arrow
		// 下移动作与上移互斥。
		else if (kb.matches(keyData, "tui.select.down")) {
			// 只夹上界，空数组时上界 -1，可令下标变 -1；后面可选访问防止选中不存在项。
			this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + 1);
		}
		// Page up - jump up by maxVisible items
		// 向上翻一窗10项。
		else if (kb.matches(keyData, "tui.select.pageUp")) {
			// 向前减 maxVisible 并夹0，不环绕。
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
		}
		// Page down - jump down by maxVisible items
		// 向下翻一窗。
		else if (kb.matches(keyData, "tui.select.pageDown")) {
			// 同样只夹到末下标，空列表可能为 -1。
			this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + this.maxVisible);
		}
		// Enter
		// 确认可恢复当前行，删除确认已在上方独占处理。
		else if (kb.matches(keyData, "tui.select.confirm")) {
			// 取当前过滤行，越界/负下标得 undefined。
			const selected = this.filteredSessions[this.selectedIndex];
			// 有行且有选择回调才执行。
			if (selected && this.onSelect) {
				// 同步传路径给宿主，不在此加载会话内容；异步宿主结果不会被 await。
				this.onSelect(selected.session.path);
			}
		}
		// Escape - cancel
		// 普通取消通知外部关闭，和上方删除确认取消不同。
		else if (kb.matches(keyData, "tui.select.cancel")) {
			// 没装取消回调就只忽略，不调用 onExit 兜底。
			if (this.onCancel) {
				// 外层通常清状态/取消加载后关闭。
				this.onCancel();
			}
		}
		// Pass everything else to search input
		else {
			// 其他按键交 Input，Input 的提交回调也可能触发选择。
			this.searchInput.handleInput(keyData);
			// 按完整查询重新筛选，未改文字的输入也能重建树/列表。
			this.filterSessions(this.searchInput.getValue());
		}
	}
}

// 函数类型定义 loader 的可选进度/信号和 Promise<概览数组>；只是 TS 契约，不保证实现一定响应取消或按时间排序。
type SessionsLoader = (onProgress?: SessionListProgress, signal?: AbortSignal) => Promise<SessionInfo[]>;

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink
 */
// deleteSessionFile 接路径、同步试 trash→若未成功且文件仍在则 await unlink，返回方法/成败/可选错误对象；例如没装 trash 会转永久删除，不承诺一定可从回收站找回。
// 本函数不检查当前活动会话或要求二次确认，保护在列表入口；spawnSync/existsSync 位于 unlink 的 try 外，若自身同步抛错会让 async Promise 拒绝，不总是返回 ok:false。
async function deleteSessionFile(
	// 原路径用于命令参数和 unlink，不转换成显示用 ~ 缩写。
	sessionPath: string,
	// 返回接口不是按 ok 判别的联合，TS 不保证失败必有 error；调用方用 ?? 提示兜底。
): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
	// Try `trash` first (if installed)
	// 路径以 - 开头时加 -- 防 trash 把它当选项，其余直接作为一个 argv，不经 shell 拼接。
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	// 同步执行 PATH 中的 trash 并取 UTF-8 输出；未设置超时，不先安装工具，可能阻塞 UI。
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	// getTrashErrorHint 闭包从已完成的 trash 结果拼简短提示，返回 string/null；例如缺程序错误与 stderr 首行合并，诊断本体取前200个 UTF-16 单元再加前缀，不再执行命令。
	const getTrashErrorHint = (): string | null => {
		// 提示片段数组初始空。
		const parts: string[] = [];
		// 有启动错误才读 message，常见是命令缺失。
		if (trashResult.error) {
			// 保留启动错误文字，不重新包装 Error。
			parts.push(trashResult.error.message);
		}
		// stderr 可缺，用可选链 trim 后判断是否有内容。
		const stderr = trashResult.stderr?.trim();
		// 非空 stderr 才加入提示。
		if (stderr) {
			// 只取按 LF 分的首行，?? 兜底原 stderr；不附完整多行日志。
			parts.push(stderr.split("\n")[0] ?? stderr);
		}
		// 没有任何提示片段返回 null。
		if (parts.length === 0) return null;
		// 中点连接后 slice 到200码元，再加 trash: 前缀，最终总长度可超过200；可能截断代理对，不是字节预算。
		return `trash: ${parts.join(" · ").slice(0, 200)}`;
	};

	// If trash reports success, or the file is gone afterwards, treat it as successful
	// 退出码0或此刻文件看起来不存在就算成功；|| 短路，成功码不额外检查文件，缺失也不能证明它确被移入回收站。
	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		// 返回 method:trash 表示走该成功判定路径，不是回收站内容验证。
		return { ok: true, method: "trash" };
	}

	// Fallback to permanent deletion
	// 只有永久删除步骤包在 try/catch 中。
	try {
		// 异步 unlink 原路径，通常移除目录项；成功不会经过回收站，可拒绝。
		await unlink(sessionPath);
		// 正常完成返回 ok:true/method:unlink。
		return { ok: true, method: "unlink" };
		// 捕获 unlink 失败，不直接向上抛该原错误。
	} catch (err) {
		// Error 取 message，其余拒绝值 String 化。
		const unlinkError = err instanceof Error ? err.message : String(err);
		// 需要报告永久删除失败时才补之前 trash 的诊断。
		const trashErrorHint = getTrashErrorHint();
		// 有 trash 诊断就括号拼入，没有就只用 unlink 错误。
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		// 返回失败对象和组合说明，不在此弹 UI 或重试。
		return { ok: false, method: "unlink", error };
	}
}

/**
 * Component that renders a session selector
 */
// SessionSelectorComponent 组合标题/列表、维护两范围加载缓存和重命名面板，实际会话扫描/改名由宿主 loader/callback 注入；构造即启动 current 加载。
export class SessionSelectorComponent extends Container implements Focusable {
	// capturesViewportInput getter 在列表模式要求接收全屏视口键，重命名模式让出该接管标记，返回 boolean；不改变焦点或键位。
	get capturesViewportInput(): boolean {
		// 只按内部 mode 判断，未检查是否真正 focused，宿主负责使用此能力字段。
		return this.mode !== "rename";
	}

	// handleInput 按 list/rename 模式路由，返回 void；例如 rename 下取消只退出改名，不关闭列表。改名提交由 Input 回调后台发起，回调异常/拒绝未统一吞掉。
	handleInput(data: string): void {
		// 重命名模式走单独输入路径。
		if (this.mode === "rename") {
			// 取消键按当前共享配置判断。
			const kb = getKeybindings();
			// 重命名取消优先，不把动作交 Input 或普通列表。
			if (kb.matches(data, "tui.select.cancel")) {
				// 恢复原列表布局并请求重画，不保存本次文字。
				this.exitRenameMode();
				// 消费取消动作。
				return;
			}
			// 其余改名输入交 Input，含它支持的提交/编辑键。
			this.renameInput.handleInput(data);
			// 不再把同一输入发给会话搜索列表。
			return;
		}

		// 普通列表模式直接转交内部 SessionList，真正动作优先级在它的 handleInput。
		this.sessionList.handleInput(data);
	}

	// 构造时最终按是否有改名回调赋值，主要给默认重命名帮助使用；真正入口仍检查捕获的 callback。
	private canRename = true;
	// 实际负责搜索/导航/确认的内部列表。
	private sessionList: SessionList;
	// 标题保存范围/排序/提示状态，与列表分开同步。
	private header: SessionSelectorHeader;
	// 应用键位对象，缺省构造时可读磁盘配置；多数输入仍用共享 manager。
	private keybindings: KeybindingsManager;
	// 当前选择范围初始 current。
	private scope: SessionScope = "current";
	// 初始无查询显示父子树。
	private sortMode: SortMode = "threaded";
	// 初始展示全部名字状态。
	private nameFilter: NameFilter = "all";
	// 当前目录概览缓存，null 表示未加载/已失效，空数组表示已加载但无结果。
	private currentSessions: SessionInfo[] | null = null;
	// 全部范围独立缓存，也可能在后台加载时存部分列表。
	private allSessions: SessionInfo[] | null = null;
	// 当前目录 loader 引用，不在字段声明中执行。
	private currentSessionsLoader: SessionsLoader;
	// 全部范围 loader 引用，可与当前加载同时存在。
	private allSessionsLoader: SessionsLoader;
	// 重绘回调引用，不表示调用后同步已画完。
	private requestRender: () => void;
	// 可选异步改名接口；参数名虽叫 currentName，confirmRename 实际传的是用户输入的新名，宿主 appendSessionInfo 负责持久化。
	private renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
	// 当前目录加载控制器或 null，既发合作取消信号，也作为任务身份判定。
	private currentLoad: AbortController | null = null;
	// 全部范围独立控制器；切到另一范围并不自动取消它。
	private allLoad: AbortController | null = null;

	// 外层路由模式初始列表，重命名时换布局并路由到另一个 Input。
	private mode: "list" | "rename" = "list";
	// 构造字段时就创建复用的重命名框，不在每次改名重建 Input。
	private renameInput = new Input();
	// 当前改名原文件路径，null 表示没有目标，不用会话名字充当文件身份。
	private renameTargetPath: string | null = null;

	// Focusable implementation - propagate to sessionList for IME cursor positioning
	// 外层焦点初始 false，宿主需明确设置。
	private _focused = false;
	// focused getter 仅返回标记，无副作用；例如不保证内部两个 Input 的标记一定都与之相同，因为 enterRenameMode 也可直接设焦点。
	get focused(): boolean {
		// 读本组件字段。
		return this._focused;
	}
	// focused setter 将同一布尔同时传列表和改名框，无返回；例如宿主失焦时两者都清掉，不取消加载/改名 Promise。
	set focused(value: boolean) {
		// 保存外层标记。
		this._focused = value;
		// 列表再传其搜索框，不按 mode 只聚焦其中一份。
		this.sessionList.focused = value;
		// 重命名框也赋同一值，未展示时仍可保留标记。
		this.renameInput.focused = value;
		// 值为 true 且改名模式时，原实现再显式设改名焦点。
		if (value && this.mode === "rename") {
			// 再次置 true，不创建独立终端焦点请求。
			this.renameInput.focused = true;
		}
	}

	// buildBaseLayout 清父布局→加边框/可选标题→插内容→底边框，返回 void；例如改名面板传 showHeader:false 隐藏恢复列表标题，不销毁原列表/取消加载或清状态计时器。
	private buildBaseLayout(content: Component, options?: { showHeader?: boolean }): void {
		// 只清 Container 子组件数组，现有 header/sessionList 对象仍由字段保留。
		this.clear();
		// 顶端空行。
		this.addChild(new Spacer(1));
		// 边框样式回调输入边框文字、返回 accent 串，渲染时才调用。
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		// 顶边框后空一行。
		this.addChild(new Spacer(1));
		// 可选链与 ?? 令 showHeader 缺省 true，显式 false 保留。
		if (options?.showHeader ?? true) {
			// 需要时插入同一标题对象，不复制其状态。
			this.addChild(this.header);
			// 标题后空行。
			this.addChild(new Spacer(1));
		}
		// 插入传入内容组件，可能是列表或临时改名面板。
		this.addChild(content);
		// 内容后空行。
		this.addChild(new Spacer(1));
		// 底边框也用 accent 回调。
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
	}

	// 构造接两loader、选择/取消/退出/重绘回调和可选改名/键位/活动路径，建标题列表→装事件→立刻启动 current 加载，返回新组件；例如 CLI 可不提供改名功能。
	// 会读取默认键位配置或调用外部 loader/requestRender；不自行 await 初始加载。选择/取消包装只取消当前扫描，不取消已经开始的删除/改名任务，也无公开 dispose 总清理入口。
	constructor(
		// 当前目录 loader 可报进度并响应传入 signal，契约不强制其实现合作取消。
		currentSessionsLoader: SessionsLoader,
		// 全部范围 loader 同签名，宿主可能选择默认全项目或自定义会话目录。
		allSessionsLoader: SessionsLoader,
		// 选中路径交宿主恢复会话；void 签名不让本组件等待宿主 async 结果。
		onSelect: (sessionPath: string) => void,
		// 取消交宿主关闭界面。
		onCancel: () => void,
		// 退出回调会被存到列表包装，但当前列表无独立直接调用 onExit 的输入分支。
		onExit: () => void,
		// 请求重绘通知，构造加载开始时即可能调用。
		requestRender: () => void,
		// 可选能力配置对象，不是运行模式标签联合。
		options?: {
			// 可选改名 callback 第二参数声明名虽旧，实际应按新名字接收；返回 Promise 由 confirmRename 等待。
			renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
			// 独立控制帮助是否可见，设 true 也不能替代真正改名 callback。
			showRenameHint?: boolean;
			// 可注入键位实例，测试提供纯内存 manager 避免读用户配置。
			keybindings?: KeybindingsManager;
		},
		// 可选活动会话文件路径，传给列表做禁止删除快照。
		currentSessionFilePath?: string,
	) {
		// 派生类先初始化 Container，字段初始化也按语言规则完成。
		super();
		// 有显式 manager 则复用，缺省才 create 读配置，不自动设共享 getKeybindings 单例。
		this.keybindings = options?.keybindings ?? KeybindingsManager.create();
		// 保存当前 loader 引用。
		this.currentSessionsLoader = currentSessionsLoader;
		// 保存全部 loader 引用。
		this.allSessionsLoader = allSessionsLoader;
		// 保存外部刷新函数。
		this.requestRender = requestRender;
		// 标题初始使用 current/threaded/all 与同一刷新回调。
		this.header = new SessionSelectorHeader(this.scope, this.sortMode, this.nameFilter, this.requestRender);
		// 局部 const 捕获构造时改名函数，后面入口闭包使用它判断是否提供能力。
		const renameSession = options?.renameSession;
		// 实例也保存该函数，真正提交阶段从此字段读取。
		this.renameSession = renameSession;
		// 函数存在则 canRename=true，构造默认 true 被替换。
		this.canRename = !!renameSession;
		// 帮助开关显式值优先，未提供时跟随是否有改名能力；两者可独立。
		this.header.setShowRenameHint(options?.showRenameHint ?? this.canRename);

		// Create session list (starts empty, will be populated after load)
		// 创建初始空列表，下面初始加载完成/进度才填入。
		this.sessionList = new SessionList(
			// 初始没有会话概览。
			[],
			// 初始 current 范围不显示 cwd。
			false,
			// 传初始排序模式。
			this.sortMode,
			// 传初始名字筛选。
			this.nameFilter,
			// 传应用键位实例。
			this.keybindings,
			// 传构造时活动会话路径，之后不自动更换。
			currentSessionFilePath,
		);

		// 先建立可显示的列表布局，不等初始扫描。
		this.buildBaseLayout(this.sessionList);

		// 改名 Input 提交时异步调用 confirmRename，无返回结果给 Input；比如回车发起保存，不锁住重复提交。
		this.renameInput.onSubmit = (value) => {
			// void 不捕获 confirmRename 的拒绝，失败虽 finally 退出改名，仍可能产生未处理拒绝。
			void this.confirmRename(value);
		};

		// Ensure header status timeouts are cleared when leaving the selector
		// clearStatusMessage 闭包清标题消息及旧timeout，返回 void；例选择/取消/显式调用列表onExit前执行，不会停止改名或删除本身。
		const clearStatusMessage = () => this.header.setStatusMessage(null);
		// 选择包装接路径，先清提示/取消扫描，再通知宿主，无等待宿主结果。
		this.sessionList.onSelect = (sessionPath) => {
			// 停状态自动隐藏 timer 并清消息。
			clearStatusMessage();
			// 取消两范围尚在跑的加载身份/信号。
			this.cancelLoads();
			// 通知宿主，路径原样传递。
			onSelect(sessionPath);
		};
		// 取消包装无参数，先清提示/加载再交外部关闭；不把取消当选首项。
		this.sessionList.onCancel = () => {
			// 清状态 timeout。
			clearStatusMessage();
			// 使未完成 loader 的迟到回调失效。
			this.cancelLoads();
			// 外部决定移除/stop TUI，不在这里删除文件。
			onCancel();
		};
		// 退出包装提供同样清理后再调用外部 onExit；实际输入是否触发应看 SessionList，而非这段赋值本身。
		this.sessionList.onExit = () => {
			// 清标题状态及其 timer。
			clearStatusMessage();
			// 取消尚在加载的扫描。
			this.cancelLoads();
			// 交外部实现退出效果，不在本类 process.exit。
			onExit();
		};
		// 模式切换通知用箭头保持 this，真正调用在按键触发时发生。
		this.sessionList.onToggleScope = () => this.toggleScope();
		// 排序切换同样委托外层方法。
		this.sessionList.onToggleSort = () => this.toggleSortMode();
		// 有名筛选切换委托外层方法。
		this.sessionList.onToggleNameFilter = () => this.toggleNameFilter();
		// 改名入口接当前路径、检查能力和当前范围加载状态，再显示输入面板，返回 void；例如 loader 尚未完成时不进入改名。
		this.sessionList.onRenameSession = (sessionPath) => {
			// 构造没给改名函数就直接忽略，即使帮助被强制显示。
			if (!renameSession) return;
			// 只检查当前范围加载控制器，另一范围后台加载不阻止改名。
			if (this.scope === "current" ? this.currentLoad : this.allLoad) return;

			// 按当前范围取缓存，null 用空数组，不临时读文件。
			const sessions = this.scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
			// 原路径严格相等找概览当前名字，不用软链键。
			const session = sessions.find((s) => s.path === sessionPath);
			// 即使没找到缓存项也可进入，名字 undefined 使输入初始空。
			this.enterRenameMode(sessionPath, session?.name);
		};

		// Sync list events to header
		// 路径显示回调接新布尔，同步标题并请求重画，返回 void，不保存偏好到设置文件。
		this.sessionList.onTogglePath = (showPath) => {
			// 标题提示开关与列表对齐。
			this.header.setShowPath(showPath);
			// 安排重绘。
			this.requestRender();
		};
		// 删除确认变化回调同步标题目标并重绘，无实际删除；例如进入/取消确认都通知一次。
		this.sessionList.onDeleteConfirmationChange = (path) => {
			// 更新标题确认标志。
			this.header.setConfirmingDeletePath(path);
			// 马上请求画确认/普通帮助。
			this.requestRender();
		};
		// 错误通知将文字作为3秒标题状态，返回 void；例如活动会话禁止删除，不处理任意异步任务拒绝。
		this.sessionList.onError = (msg) => {
			// 新状态会替换/停止旧timeout。
			this.header.setStatusMessage({ type: "error", message: msg }, 3000);
			// 本次也请求重绘，计时到期后标题另会请求一次。
			this.requestRender();
		};

		// Handle session deletion
		// 删除回调 await 真正文件操作，成功先移缓存行再全量刷新当前范围，失败显示诊断，返回 Promise<void>；例如 trash 不可用时可能永久 unlink，UI 文案按 helper 返回方法选择。
		// 无组件关闭/任务序号保护；删除中选择器若关闭，迟到完成仍可能更新/重新加载布局。此 async 回调由列表 void 调用，文件 helper 自身拒绝并未统一 catch。
		this.sessionList.onDeleteSession = async (sessionPath: string) => {
			// await 文件helper，可能产生永久删除副作用，列表上方确认和活动保护不在此重验。
			const result = await deleteSessionFile(sessionPath);

			// 成功与否用 ok 布尔，不按返回对象是否存在判断。
			if (result.ok) {
				// 已缓存当前列表才做本地移除。
				if (this.currentSessions) {
					// 只按原路径精确删除缓存项，不同步所有软链别名键。
					this.currentSessions = this.currentSessions.filter((s) => s.path !== sessionPath);
				}
				// 全部列表缓存若存在也单独过滤。
				if (this.allSessions) {
					// 相同原路径项从另一缓存移除，其他项保留原引用。
					this.allSessions = this.allSessions.filter((s) => s.path !== sessionPath);
				}

				// 根据此刻 scope 选要刷新的可见缓存，未缓存用空数组，不固定操作开始时范围。
				const sessions = this.scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
				// all 才显示 cwd。
				const showCwd = this.scope === "all";
				// 先让列表显示移除后的快照，再等待重新扫描。
				this.sessionList.setSessions(sessions, showCwd);

				// trash 文案按 helper 的成功判定，不证明文件确在回收站；unlink 用普通删除文案。
				const msg = result.method === "trash" ? "Session moved to trash" : "Session deleted";
				// 安排约2秒后自动清成功提示，实际调度可延迟，计时在重新扫描之前开始。
				this.header.setStatusMessage({ type: "info", message: msg }, 2000);
				// 取消旧加载、清两缓存，再等当前范围重载；不会 await 另一范围加载。
				await this.refreshSessionsAfterMutation();
			} else {
				// 失败对象没有错误字段时用 Unknown error，返回类型未强制存在。
				const errorMessage = result.error ?? "Unknown error";
				// 错误状态显示3秒，不在这里重试文件操作。
				this.header.setStatusMessage({ type: "error", message: `Failed to delete: ${errorMessage}` }, 3000);
			}

			// 操作/刷新结束后再请求重画；前面异常逸出则此行不执行。
			this.requestRender();
		};

		// Start loading current sessions immediately
		// 构造末尾立即进入 current 加载直到首个 await，void 不等扫描完成；未包住 try 外初始化错误的拒绝。
		void this.loadScope("current");
	}

	// cancelLoads 对尚有控制器的两范围发 abort、清身份与对应缓存，返回 void；例如关闭后旧 onProgress/resolve 不能再通过身份检查。已完成缓存没有控制器时保留，不取消删除/改名或保证后端 I/O 立刻停。
	private cancelLoads(): void {
		// 只有当前范围还持有控制器才处理。
		if (this.currentLoad) {
			// 发合作取消信号，不等待 loader 拒绝。
			this.currentLoad.abort();
			// 清控制器身份，使旧闭包 isActive=false。
			this.currentLoad = null;
			// 清正在加载的部分/缓存数据，完成缓存不进入这分支。
			this.currentSessions = null;
		}
		// 全部范围独立做同样处理。
		if (this.allLoad) {
			// 发全部加载取消。
			this.allLoad.abort();
			// 失效旧全部任务身份。
			this.allLoad = null;
			// 清其未完成缓存。
			this.allSessions = null;
		}
	}

	// enterRenameMode 接目标路径/当前名字，切模式、预填 Input、换无标题布局并重绘，返回 void；例如 Old 预填后光标仍由 Input.setValue 保留/夹紧，新的字符不保证自动加在末尾。
	private enterRenameMode(sessionPath: string, currentName: string | undefined): void {
		// 外层键盘从此转给 renameInput。
		this.mode = "rename";
		// 保存原文件路径作提交目标。
		this.renameTargetPath = sessionPath;
		// 名字缺省用空串，setValue 不清完整撤销/编辑状态。
		this.renameInput.setValue(currentName ?? "");
		// 直接设改名 Input focused=true，不同步外层 _focused 或清列表焦点标记。
		this.renameInput.focused = true;

		// 为本次改名建临时布局容器，复用同一 Input。
		const panel = new Container();
		// 加 Rename Session 粗体标题，左右1列、上下0行。
		panel.addChild(new Text(theme.bold("Rename Session"), 1, 0));
		// 标题与输入间空白。
		panel.addChild(new Spacer(1));
		// 加入预填输入框。
		panel.addChild(this.renameInput);
		// 输入后留空行。
		panel.addChild(new Spacer(1));
		// 追加确认/取消帮助的多行构造。
		panel.addChild(
			// Text 负责显示文字，不自行注册保存处理器。
			new Text(
				// 两个键名按共享配置取，显示 save/cancel，实际提交由 Input 解释自己的绑定。
				theme.fg("muted", `${keyText("tui.select.confirm")} to save · ${keyText("tui.select.cancel")} to cancel`),
				// 左右留1列。
				1,
				// 上下留0行。
				0,
			),
		);

		// 替换父布局并隐藏会话选择标题，原 sessionList 仍在实例字段中保存状态。
		this.buildBaseLayout(panel, { showHeader: false });
		// 请求重画改名面板。
		this.requestRender();
	}

	// exitRenameMode 切回列表、清目标并重建正常布局/重画，返回 void，不保存名称/取消已发 Promise/清输入值；例如 Escape 丢当前输入，但此前开始的保存仍可完成。
	private exitRenameMode(): void {
		// 路由改回列表。
		this.mode = "list";
		// 清当前改名目标，不撤回已被 confirmRename 局部捕获的 target。
		this.renameTargetPath = null;

		// 重新接入原列表/标题对象，保留查询和选择。
		this.buildBaseLayout(this.sessionList);

		// 通知宿主重画。
		this.requestRender();
	}

	// confirmRename 接用户文字，trim 后非空才调用异步改名并刷新列表，最终退出改名，返回 Promise<void>；例如输入 XOld 把它作为新名传 callback，不传原名。
	// 无提交忙标志/取消信号，重复确认可并发保存；非空路径中的失败会在 finally 退出后继续拒绝，不自动显示错误提示，取消画面也不取消已发保存。
	private async confirmRename(value: string): Promise<void> {
		// 去掉名字首尾空白，不修改会话正文。
		const next = value.trim();
		// 空名直接返回，仍留改名模式，不能靠此UI提交空串清除名字。
		if (!next) return;
		// 捕获当前目标，后续退出改名清字段不改变这个局部字符串。
		const target = this.renameTargetPath;
		// 缺目标则没有可改会话。
		if (!target) {
			// 恢复列表布局。
			this.exitRenameMode();
			// 提前结束，不发回调。
			return;
		}

		// Find current name for callback
		// 从实例再取改名函数，局部 const 让 await 前后保持同一引用。
		const renameSession = this.renameSession;
		// 函数缺失也退出改名，不自行实现文件编辑兜底。
		if (!renameSession) {
			// 恢复列表。
			this.exitRenameMode();
			// 无实际保存返回。
			return;
		}

		// try 覆盖外部保存与刷新，finally 总尝试回列表，不提供 catch 吞错。
		try {
			// 第二实参是 trim 后的新名，虽然签名参数名叫 currentName；宿主通常 appendSessionInfo 追加名称条目，不重命名 JSONL 文件。
			await renameSession(target, next);
			// 保存正常返回后才失效缓存并重载当前范围。
			await this.refreshSessionsAfterMutation();
			// 外部保存或刷新失败也进入 finally。
		} finally {
			// 退出改名不是保存成功证明，finally 的重绘异常也可能影响拒绝结果。
			this.exitRenameMode();
		}
	}

	// loadScope 接 current/all，若该范围已在加载则直接完成，否则登记新控制器→设标题加载→运行 loader→按身份处理进度/结果/错误，返回 Promise<void>；例如 All 后台完成只填缓存，不把已切回Current的画面改回All。
	// 身份检查与 signal 分开，能忽略不合作 loader 的迟到结果；try 只从 loader 调用开始，前面的 header/requestRender 异常不在其 catch 内，也不因函数 async 自动保证全部清理。
	private async loadScope(scope: SessionScope): Promise<void> {
		// 同范围已有控制器就不再发起，也不返回那次 loader 的共同 Promise；这是本次 async 的早返。
		if (scope === "current" ? this.currentLoad : this.allLoad) return;

		// 此次 all 任务的结果显示 cwd，current 不显示。
		const showCwd = scope === "all";
		// 新控制器既提供取消信号，又是闭包任务身份。
		const controller = new AbortController();
		// 根据参数范围登记到独立槽，不修改外层 this.scope。
		if (scope === "current") {
			// 记录 current 任务身份。
			this.currentLoad = controller;
		} else {
			// 记录 all 任务身份。
			this.allLoad = controller;
		}
		// 开始任务时标题设参数范围；调用方通常已同步 this.scope，但此行不替它改外层范围字段。
		this.header.setScope(scope);
		// 设置 loading=true 同时清旧进度计数。
		this.header.setLoading(true);
		// 先请求加载画面，这行在下面 try 之外。
		this.requestRender();

		// isActive 闭包返回对应控制器槽是否仍等于本次对象，无副作用；例如取消/重启后旧对象即使 signal 未被合作观察也不再活跃，不等同检查当前显示范围。
		const isActive = () => (scope === "current" ? this.currentLoad : this.allLoad) === controller;
		// onProgress 接候选计数/可选部分列表，缓存活跃任务的部分结果，仅当前可见范围更新列表/标题，返回 void；例如 All 后台仍可接收部分缓存，但不重画Current。
		const onProgress: SessionListProgress = (loaded, total, partialSessions) => {
			// 任务身份已失效就忽略全部进度，不按名字猜是哪一次请求。
			if (!isActive()) return;
			// 有部分列表时才更新数据，空数组也是真值；只报计数的进度保留原部分缓存。
			if (partialSessions) {
				// 复制 readonly 数组外壳，概览项仍共享引用，不深克隆正文。
				const sessions = [...partialSessions];
				// 按任务参数范围写对应缓存。
				if (scope === "current") {
					// 更新 current 部分结果。
					this.currentSessions = sessions;
				} else {
					// 更新 all 部分结果。
					this.allSessions = sessions;
				}
				// 只有正在看的范围才把部分数据送列表，不把后台任务强行切到前台。
				if (scope === this.scope) this.sessionList.setSessions(sessions, showCwd);
			}
			// 非可见范围到此退出，不更新标题计数或重绘。
			if (scope !== this.scope) return;
			// 可见任务更新 loaded/total，未把它当有效概览行数。
			this.header.setProgress(loaded, total);
			// 请求进度画面，错误可能从 loader 的回调调用处传播。
			this.requestRender();
		};

		// try 覆盖 loader 同步调用/拒绝以及下面成功处理；并非从登记控制器之前开始。
		try {
			// 按参数范围调用对应 loader 并 await 结果，保留单次 onProgress/controller.signal。
			const sessions = await (scope === "current"
				? // current loader 接可选进度/信号，让 SessionManager 扫当前项目。
					this.currentSessionsLoader(onProgress, controller.signal)
				: // all loader 同契约，宿主决定是默认全目录还是自定义共享目录。
					this.allSessionsLoader(onProgress, controller.signal));
			// 返回后先查身份，已取消/被新任务替代则不写缓存、不改画面。
			if (!isActive()) return;

			// 当前任务仍活跃，按范围保存最终数组。
			if (scope === "current") {
				// current 缓存保留 loader 返回原数组，不再复制。
				this.currentSessions = sessions;
				// 清 current 控制器，之后旧 onProgress 不再被视为活跃。
				this.currentLoad = null;
			} else {
				// all 保存最终缓存。
				this.allSessions = sessions;
				// 清 all 控制器。
				this.allLoad = null;
			}

			// 用户已切走时仅缓存就结束，不碰别范围 loading 状态。
			if (scope !== this.scope) return;
			// 可见任务停止标题加载并清计数。
			this.header.setLoading(false);
			// 把最终数组送列表，选择保留规则由 setSessions 决定。
			this.sessionList.setSessions(sessions, showCwd);
			// 请求最终重绘；此时控制器已清，若这里或前面列表处理抛错，catch 的 isActive 会是 false 而忽略，不保证这些UI异常会显示为加载错误。
			this.requestRender();
			// 捕获 loader 调用/等待/成功处理异常，先用身份区分是否还应处理。
		} catch (err) {
			// 取消或成功路径已清控制器后，此 catch 直接返回，不重新设置错误。
			if (!isActive()) return;
			// 仍活跃的失败任务清自己的身份与缓存，不触及另一范围。
			if (scope === "current") {
				// current 不再在加载。
				this.currentLoad = null;
				// current 缓存变未知，后续切换可再加载。
				this.currentSessions = null;
			} else {
				// all 清加载身份。
				this.allLoad = null;
				// all 缓存失效。
				this.allSessions = null;
			}
			// 后台范围失败不改当前标题，不因此把前台结果清空。
			if (scope !== this.scope) return;

			// Error 取 message，其他值 String 化，未自动脱敏诊断。
			const message = err instanceof Error ? err.message : String(err);
			// 停止可见加载状态/计数。
			this.header.setLoading(false);
			// 显示4秒错误状态，timer 到期另请求重画。
			this.header.setStatusMessage({ type: "error", message: `Failed to load sessions: ${message}` }, 4000);
			// 可见列表清空，原 query/模式仍保留。
			this.sessionList.setSessions([], showCwd);
			// 请求显示错误；这个 catch 里的 UI 回调若再抛错不在同一 catch 二次保护。
			this.requestRender();
		}
	}

	// toggleSortMode 按 threaded→recent→relevance→threaded 切换并同步标题/列表/重画，返回 void；例如有查询时 threaded 也用平铺相关度，不强制建树或重新扫描文件。
	private toggleSortMode(): void {
		// Cycle: threaded -> recent -> relevance -> threaded
		// 嵌套三元实现固定三态循环。
		this.sortMode = this.sortMode === "threaded" ? "recent" : this.sortMode === "recent" ? "relevance" : "threaded";
		// 标题换英文排序标签。
		this.header.setSortMode(this.sortMode);
		// 列表按原查询重筛/重建，初始数据缓存不改变。
		this.sessionList.setSortMode(this.sortMode);
		// 请求新排序画面。
		this.requestRender();
	}

	// toggleNameFilter 在 all/named 间切并同步标题/列表，返回 void；例如排除空名后可能把缺父孩子显示为树根，不改会话文件名字。
	private toggleNameFilter(): void {
		// 翻转名字筛选标签。
		this.nameFilter = this.nameFilter === "all" ? "named" : "all";
		// 同步标题 Name 提示。
		this.header.setNameFilter(this.nameFilter);
		// 用原查询重筛列表。
		this.sessionList.setNameFilter(this.nameFilter);
		// 请求重绘。
		this.requestRender();
	}

	// refreshSessionsAfterMutation 取消未完加载、清两缓存、只重载此刻范围，返回 Promise<void>；例如保存新名后重新从宿主取概览，不靠本地直接改 name。无已关闭标志，迟到删除/改名也可重新发起扫描。
	private async refreshSessionsAfterMutation(): Promise<void> {
		// 失效两范围未完任务身份，分别发出合作取消信号。
		this.cancelLoads();
		// 即使 current 已完成也强制清缓存。
		this.currentSessions = null;
		// all 已完成缓存也失效，下次切过去再加载。
		this.allSessions = null;
		// 等当前范围这次 loadScope 完成，不预加载另一范围。
		await this.loadScope(this.scope);
	}

	// toggleScope 在 current/all 间切，先用缓存/部分结果画面，未缓存且没在加载才发新任务，返回 void；例如 All还在跑时反复Tab复用同一次任务，不取消另一范围或等待完成。
	private toggleScope(): void {
		// 先更新外层当前范围。
		this.scope = this.scope === "current" ? "all" : "current";
		// 读新范围缓存，null 与已加载空数组有不同含义。
		const sessions = this.scope === "current" ? this.currentSessions : this.allSessions;
		// 检查该范围是否仍有控制器，不要求它此时正返回进度。
		const loading = (this.scope === "current" ? this.currentLoad : this.allLoad) !== null;
		// 标题切范围。
		this.header.setScope(this.scope);
		// 标题 loading 按新范围任务判断，并无条件清旧进度；之后新回调再补计数。
		this.header.setLoading(loading);
		// 有缓存/部分数组就显示它，null 用空列表，cwd显示跟随范围。
		this.sessionList.setSessions(sessions ?? [], this.scope === "all");
		// 先渲染已有状态，避免必须等完整扫描才响应切换。
		this.requestRender();
		// 缓存未知且未加载才后台发新任务；[] 表示已加载空，不因此反复重扫。
		if (sessions === null && !loading) void this.loadScope(this.scope);
	}

	// getSessionList 返回真实内部列表，供 CLI 直接设焦点/传输入，无复制/保存；例如 CLI 不提供改名时可只聚焦搜索列表，交互宿主则聚焦外层以路由改名。
	getSessionList(): SessionList {
		// 返回原对象，不是只读列表快照。
		return this.sessionList;
	}
}
