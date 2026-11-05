// 主题候选列表的公共组件：浏览变化回传预览、确认回传名称；应用/持久化和取消恢复由宿主实现。
// 运行时容器/列表与仅编译期候选/布局类型混合命名导入。
import { Container, type SelectItem, SelectList, type SelectListLayoutOptions } from "@earendil-works/pi-tui";
// 主题目录 helper 可读内建/自定义文件并结合已注册主题；列表样式回调读取当前主题。
import { getAvailableThemes, getSelectListTheme } from "../theme/theme.ts";
// 用按 render 宽度计算的动态边框包列表。
import { DynamicBorder } from "./dynamic-border.ts";

// 主文字列宽的上下界配置，不是固定面板宽度。
const THEME_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	// 主列至少取 12 的目标，窄窗口时仍受可用列数限制。
	minPrimaryColumnWidth: 12,
	// 主列目标上限 32。
	maxPrimaryColumnWidth: 32,
};

/**
 * Component that renders a theme selector
 */
// 公开组件通过统一入口重导出；没有自己的键盘处理，调用者可聚焦内部 SelectList。
export class ThemeSelectorComponent extends Container {
	// 实际管理选择、鼠标和键盘的列表实例。
	private selectList: SelectList;
	// 预览回调独立于确认回调，组件不自己调用 setTheme。
	private onPreview: (themeName: string) => void;

	// 枚举可用主题→建候选→预选当前名→绑定确认/取消/浏览变化，返回新组件。
	// 例当前 dark，浏览 light 会调用 onPreview("light")，确认才调用 onSelect；构造的预选不会先触发预览。
	// 枚举可能读主题目录，异常可传播；不保存设置、不在取消时自动恢复旧主题，交给宿主回调处理。
	constructor(
		// 当前主题名，只用于标记/预选，不在此验证它必定存在。
		currentTheme: string,
		// 确认选中主题时同步回传名称。
		onSelect: (themeName: string) => void,
		// 取消时通知宿主，宿主可自行恢复已预览主题。
		onCancel: () => void,
		// 选择光标变化时预览，类型只承诺回调签名，不保证其无副作用。
		onPreview: (themeName: string) => void,
	) {
		// 初始化父容器。
		super();
		// 保存回调引用，后续浏览时执行。
		this.onPreview = onPreview;

		// Get available themes and create select items
		// 按 helper 的去重/来源/排序规则取得名称数组，属于创建时的一份目录结果。
		const themes = getAvailableThemes();
		// 将每个名称映成列表项，生成新数组，不修改名称列表。
		const themeItems: SelectItem[] = themes.map((name) => ({
			// 回调真正回传的选择值。
			value: name,
			// 显示标签与值相同。
			label: name,
			// 标记构造时的当前主题；预览移动不会在本类中更新这份标记。
			description: name === currentTheme ? "(current)" : undefined,
		}));

		// Add top border
		// 加入上/下边框组件，实际绘屏由宿主负责。
		this.addChild(new DynamicBorder());

		// Create selector
		// 最多显示 10 个候选行，另可能有滚动位置提示。
		this.selectList = new SelectList(themeItems, 10, getSelectListTheme(), THEME_SELECT_LIST_LAYOUT);

		// Preselect current theme
		// 按精确名称找当前主题下标，未找到为 -1。
		const currentIndex = themes.indexOf(currentTheme);
		// 只有目录中存在当前主题才设置预选。
		if (currentIndex !== -1) {
			// 直接设置下标，尚未绑定 onSelectionChange，也不会因此通知预览。
			this.selectList.setSelectedIndex(currentIndex);
		}

		// 确认回调只在用户确认/点击项时进入，不等于浏览预览。
		this.selectList.onSelect = (item) => {
			// 回传原名称，不在组件写配置。
			onSelect(item.value);
		};

		// 取消仅通知宿主。
		this.selectList.onCancel = () => {
			// 同步运行调用方逻辑，不保证自动恢复先前主题。
			onCancel();
		};

		// 导航或鼠标改变选中项后收到通知；与最终确认分开。
		this.selectList.onSelectionChange = (item) => {
			// 让宿主执行预览/刷新，本层不直接改全局主题。
			this.onPreview(item.value);
		};

		// 列表置于两条边框之间。
		this.addChild(this.selectList);

		// Add bottom border
		// 加入上/下边框组件，实际绘屏由宿主负责。
		this.addChild(new DynamicBorder());
	}

	// 返回内部列表引用，无副作用；例宿主据此聚焦或转发按键，不创建新列表。
	getSelectList(): SelectList {
		// 调用者拿到同一可变列表实例。
		return this.selectList;
	}
}
