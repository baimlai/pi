/**
 * 项目信任选择面板：分别展示命中的已保存决定与当前会话可信状态，让用户浏览并提交持久化选项。
 * 交互模式宿主提供 savedDecision/projectTrusted，确认后接收 trusted 和 updates，再负责写 trust.json、关闭并提示重启。
 * 例 Trust parent folder 会提交“父目录 true、删除当前目录独立记录”的两条更新；本文件只交回数据，不自行更改当前会话信任或加载项目资源。
 * 箭头代表浏览位置，勾选代表原先保存的目标；取消仅通知宿主，不自动提交不信任决定。
 */
// Container 负责子组件布局；键位管理器判断可配置动作；Spacer/Text 生成空行和文字，不在这里直接读写终端。
import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
// 从信任管理模块取实际选项工厂及两个 type 接口；type 导入在运行 JS 中擦除。
import {
	// 此函数把 cwd 归一化后生成当前目录/父目录的保存选项，不读取已有信任决定或保存选择。
	getProjectTrustOptions,
	// 每个选项包含英文 label、本次 trusted 结果、批量 updates 和可选保存目标 savedPath。
	type ProjectTrustOption,
	// 已有命中记录可能来自祖先目录，包含 path 与布尔 decision，不一定对应 cwd 本身。
	type ProjectTrustStoreEntry,
} from "../../../core/trust-manager.ts";
// 共享主题对象为文字加样式，本组件不修改主题设置。
import { theme } from "../theme/theme.ts";
// 动态边框读取主题，作为普通子组件输出。
import { DynamicBorder } from "./dynamic-border.ts";
// keyHint 显示当前动作绑定，rawKeyHint 仅显示给定文字；提示不是按键处理器。
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

// Pick<T,K> 只挑选 trusted 和 updates 两字段；回调拿结果与更新指令，不拿 label/savedPath，TS 类型不会自动落盘。
export type TrustSelection = Pick<ProjectTrustOption, "trusted" | "updates">;

// 构造参数由交互宿主提供，保存决定和本次会话状态是两份独立输入，不要混同。
export interface TrustSelectorOptions {
	// 当前项目目录，显示保留传入文字，生成选项时工厂另做路径归一化。
	cwd: string;
	// 当前命中的已保存决定；联合 null 表示未找到，不等同保存了 false。
	savedDecision: ProjectTrustStoreEntry | null;
	// 本会话正在使用的项目可信布尔，仅用于 Current session 显示，不用于选项初始光标判断。
	projectTrusted: boolean;
	// 确认通知同步返回 void；宿主负责保存和关闭，组件不 await 或吞回调错误。
	onSelect: (selection: TrustSelection) => void;
	// 取消通知无参数，由宿主决定如何关闭和重绘；不写一个“拒绝”记录。
	onCancel: () => void;
}

// formatDecision 将当前目录的保存目标与已有命中记录格式化为英文文字，返回字符串，无存储操作；例如命中 /work 而当前目标 /work/app 时展示 inherited from /work。
function formatDecision(trustPath: string | undefined, decision: ProjectTrustStoreEntry | null): string {
	// 必须是 null 才表示“没有保存决定”，false 决定存在于对象字段中，不走本分支。
	if (decision === null) {
		// 返回英文 none，表示没有命中的已保存决定。
		return "none";
	}
	// 按 decision 布尔选可信/不可信标签，不按对象是否存在推断可信。
	const label = decision.decision ? "trusted" : "untrusted";
	// 有当前保存目标且与记录 path 原字符串不同时显示继承；这里只做严格字符串比较，不验证真实祖先关系或平台路径等价。
	if (trustPath !== undefined && decision.path !== trustPath) {
		// 模板插入命中的路径，路径可来自祖先目录，保持原字符串。
		return `${label} (inherited from ${decision.path})`;
	}
	// 目标相同或没有可比目标时显示普通“标签 (路径)”格式。
	return `${label} (${decision.path})`;
}

// TrustSelectorComponent 组装项目信任选择界面，继承 Container 的渲染/失效机制，自行实现键盘；没有 Focusable setter 或全局信任状态。
export class TrustSelectorComponent extends Container {
	// 当前浏览光标的数组下标，会随上下键变化，不代表已经保存。
	private selectedIndex: number;
	// readonly 禁止 TS 中重绑列表容器，但容器仍可通过 clear/addChild 修改其子组件。
	private readonly listContainer: Container;
	// 构造时生成的选项数组引用，后续不重算 cwd/选项；readonly 字段不冻结数组或选项对象。
	private readonly trustOptions: ProjectTrustOption[];
	// 保留传入的已保存决定对象引用，并非深快照；初始标题已格式化，列表勾选会在重建时再读这个对象。
	private readonly savedDecision: ProjectTrustStoreEntry | null;
	// 保存确认回调引用，真正持久化逻辑在宿主，不在此类。
	private readonly onSelectCallback: (selection: TrustSelection) => void;
	// 保存取消回调，取消不等价于选“Do not trust”。
	private readonly onCancelCallback: () => void;

	// 构造界面：输入 cwd/已存决定/当前会话状态和回调，结果为新组件；先生成持久化选项→按保存决定定位→拼说明与提示→建列表，不保存或改变会话可信值。
	// 例命中直接父目录 true 时定位 Trust parent folder；命中更远祖先时仍显示继承说明，但没有恰好同 savedPath 的选项就默认第一项 Trust，而非按当前 projectTrusted 选中。
	constructor(options: TrustSelectorOptions) {
		// 派生类访问 this 前先 super()，建立 Container 的子列表/布局基础。
		super();

		// 保存已有决定引用，未复制或重新读取 trust.json。
		this.savedDecision = options.savedDecision;
		// 未传 includeSessionOnly，工厂只生成持久化 Trust、可用的 Trust parent folder、Do not trust；根目录没有父目录选项。
		this.trustOptions = getProjectTrustOptions(options.cwd);
		// 把查找到的下标夹到至少0，findIndex 未命中的 -1 因此变第一项。
		this.selectedIndex = Math.max(
			// 下标下界为0，不是自动按“当前会话可信”选项定位。
			0,
			// 按 isSavedOption 同时比较 savedPath/决定找首项，谓词回调只读已有选项。
			this.trustOptions.findIndex((option) => this.isSavedOption(option)),
		);
		// 保留外部确认函数；赋值不会立刻执行。
		this.onSelectCallback = options.onSelect;
		// 保留外部取消函数。
		this.onCancelCallback = options.onCancel;

		// 顶部动态边框作为首个子组件。
		this.addChild(new DynamicBorder());
		// 边框与标题之间空一行。
		this.addChild(new Spacer(1));
		// 标题套粗体/accent，Text 后两个参数是左右内边距1、上下内边距0。
		this.addChild(new Text(theme.fg("accent", theme.bold("Project trust")), 1, 0));
		// 显示传入 cwd 的 muted 文字，未做主目录缩写。
		this.addChild(new Text(theme.fg("muted", options.cwd), 1, 0));
		// 目录与状态说明之间留空行。
		this.addChild(new Spacer(1));
		// 将“已存决定”文字加入布局，下面多行构造合成一个 Text。
		this.addChild(
			// Text 负责按布局宽度渲染这段文字，不在构造时执行终端输出。
			new Text(
				// 给整段保存状态说明设置颜色。
				theme.fg(
					// 状态说明使用 muted 样式键。
					"muted",
					// 首选项的 savedPath 对应归一化当前目录；?. 允许数组意外无首项时得到 undefined，formatDecision 据此处理显示。
					`Saved decision: ${formatDecision(this.trustOptions[0]?.savedPath, options.savedDecision)}`,
				),
				// Text 左右内边距为1列。
				1,
				// 上下内边距为0行，实际布局留白由 Spacer 控制。
				0,
			),
		);
		// 另加独立的当前会话状态行，和已保存决定可以不同。
		this.addChild(
			// 只展示构造传入 projectTrusted 的布尔结果；此 Text 的字符串不会随之后信任保存自动变化。
			new Text(theme.fg("muted", `Current session: ${options.projectTrusted ? "trusted" : "untrusted"}`), 1, 0),
		);
		// 状态与可选项列表之间空一行。
		this.addChild(new Spacer(1));

		// 创建专门放可重建选项行的子容器，更新列表不会清空顶部说明。
		this.listContainer = new Container();
		// 把该列表容器接到父布局。
		this.addChild(this.listContainer);
		// 选项列表后加空白。
		this.addChild(new Spacer(1));
		// 把操作提示作为一段 Text 加入，提示组合在后面跨行完成。
		this.addChild(
			// 一个 Text 含整行导航/确认/取消提示。
			new Text(
				// ↑↓ 是固定展示文字，实际导航还支持当前配置动作及 j/k；rawKeyHint 不创建绑定。
				rawKeyHint("↑↓", "navigate") +
					// 导航与确认提示用两个空格分隔。
					"  " +
					// 确认提示读取可配置确认动作，英文 save 只作说明，保存由外部回调完成。
					keyHint("tui.select.confirm", "save") +
					// 再加两个空格分隔取消提示。
					"  " +
					// 取消动作提示读取当前键位，英文 cancel 不会自动调用取消回调。
					keyHint("tui.select.cancel", "cancel"),
				// 提示文字左右留1列。
				1,
				// 提示文字上下不再额外留行。
				0,
			),
		);
		// 底边框前空一行。
		this.addChild(new Spacer(1));
		// 最后追加动态边框。
		this.addChild(new DynamicBorder());

		// 按初始光标/保存决定生成选项文字，构造本身不触发回调。
		this.updateList();
	}

	// isSavedOption 判断一项是否恰好对应已保存决定，返回 boolean，无写入；例如父目录 true 只勾选同 savedPath 的父目录选项，不因为当前会话 true 就勾所有 Trust。
	private isSavedOption(option: ProjectTrustOption): boolean {
		// 括号内三个 && 组成同一个返回条件，前项不成立时短路。
		return (
			// 选项必须有保存目标，避免把会话临时选项当作已保存项。
			option.savedPath !== undefined &&
			// 可选访问在没有 savedDecision 时得到 undefined，与选项 boolean 不相等，后项不再执行。
			this.savedDecision?.decision === option.trusted &&
			// 已有记录的 path 还必须和选项目标原字符串严格相等；不是模糊祖先或 realpath 等价比较。
			this.savedDecision.path === option.savedPath
		);
	}

	// updateList 清空列表容器后按选项次序重建文字行，返回 void，无保存/自动重绘；例如上下浏览只移动箭头，已存决定的勾选仍留原项。
	private updateList(): void {
		// 只清空 listContainer 的子组件，不清整个面板，也不修改 trustOptions。
		this.listContainer.clear();
		// 按数组下标逐项处理，i++ 使顺序保持工厂的构造顺序。
		for (let i = 0; i < this.trustOptions.length; i++) {
			// 取当前选项，原实现下方保留缺项判断。
			const option = this.trustOptions[i];
			// 缺项时跳过，避免读取其 label/savedPath。
			if (!option) {
				// continue 开始下一轮循环，不结束整个列表更新。
				continue;
			}

			// 光标是否位于本行，和保存勾选是两个独立布尔。
			const isSelected = i === this.selectedIndex;
			// 勾选基于已保存决定，不基于光标或当前会话 projectTrusted。
			const isCurrent = this.isSavedOption(option);
			// 命中保存决定才显示原字符串中的勾选符号，否则补等宽空格；不进行保存动作。
			const currentMarker = isCurrent ? theme.fg("accent", "✓ ") : "  ";
			// 当前光标行显示原字符串中的箭头，否则补空格。
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			// 选中项文字用 accent，其他 text 颜色；不是把已存勾选项自动设为当前选择。
			const label = isSelected ? theme.fg("accent", option.label) : theme.fg("text", option.label);
			// 把箭头/保存标记/英文标签拼成新 Text，左右内边距1、上下0，不更新标题中的已存状态文字。
			this.listContainer.addChild(new Text(`${prefix}${currentMarker}${label}`, 1, 0));
		}
	}

	// handleInput 按上下/确认/取消顺序处理，返回 void；例如 j 只移光标、LF 确认当前选项，回调异常直接传播，不在此保存、关闭或请求渲染。
	handleInput(keyData: string): void {
		// 每次取当前键位，不缓存构造时的绑定。
		const kb = getKeybindings();
		// 配置向上动作或字面 k 均可向上，两个条件 || 任一满足即可。
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			// 下标减1并夹到0，边界不环绕。
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			// 立即重建可视选项行，实际终端重绘由宿主输入处理流程安排。
			this.updateList();
			// 只有前面没匹配时再看向下动作或字面 j。
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			// 下标加1，上界为最后一项；工厂实际至少有 Trust 和 Do not trust，不在这里构造空选项特例。
			this.selectedIndex = Math.min(this.trustOptions.length - 1, this.selectedIndex + 1);
			// 重建箭头和勾选样式。
			this.updateList();
			// 确认动作或原始 LF 触发选择；LF 是额外显式支持，不只限默认回车绑定。
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			// 读取当前选项，下方判断防止缺项访问。
			const selected = this.trustOptions[this.selectedIndex];
			// 有选项才通知宿主；不会自动改 savedDecision/selectedIndex 或阻止重复确认。
			if (selected) {
				// 新建结果对象但 updates 数组沿用选项引用；宿主交给 trustStore.setMany 并提示重启，组件不更新本会话可信开关，也不 await 回调。
				this.onSelectCallback({ trusted: selected.trusted, updates: selected.updates });
			}
			// 前面都没命中才判断取消动作，没有硬编码 Ctrl+C 的独立退出分支。
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			// 调用宿主取消，无选择结果/文件写入；其他未匹配输入直接忽略。
			this.onCancelCallback();
		}
	}
}
