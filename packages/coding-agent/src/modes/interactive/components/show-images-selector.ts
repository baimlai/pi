// 图片显示开关的公共选择组件；只回传选择，实际保存设置/切换图片显示由调用方负责。
// 运行时导入布局/列表，type 项只约束候选及列宽选项，编译后擦除。
import { Container, type SelectItem, SelectList, type SelectListLayoutOptions } from "@earendil-works/pi-tui";
// 获取读取当前主题的列表着色回调。
import { getSelectListTheme } from "../theme/theme.ts";
// 上下边框按 render 传入宽度生成。
import { DynamicBorder } from "./dynamic-border.ts";

// 列表主文字列宽配置；只影响有足够说明列空间时的排版，不是整个面板宽度。
const SHOW_IMAGES_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	// 主列下限 12，实际窄窗口布局仍会进一步限制。
	minPrimaryColumnWidth: 12,
	// 主列上限 32，为旁边说明留空间。
	maxPrimaryColumnWidth: 32,
};

/**
 * Component that renders a show images selector with borders
 */
// 继承纵向容器；本类没有自己的 handleInput，宿主可将 getSelectList() 的结果设为键盘焦点。
export class ShowImagesSelectorComponent extends Container {
	// 保存实际选择列表，供构造时绑定回调及宿主取得。
	private selectList: SelectList;

	// 创建两项列表并预选当前值，选择时将 yes/no 转 boolean 通知宿主，取消则回调，无显式返回数据。
	// 例 currentValue=false 预选 No，选 Yes 调 onSelect(true)；不检查终端图片能力、不写设置，回调/样式错误会传播。
	constructor(currentValue: boolean, onSelect: (show: boolean) => void, onCancel: () => void) {
		// 先初始化父容器孩子列表。
		super();

		// 显式候选项数组；value 用于业务回传，label/description 用于显示。
		const items: SelectItem[] = [
			// Yes 表示希望显示内联图片，实际是否能画图仍由终端能力决定。
			{ value: "yes", label: "Yes", description: "Show images inline in terminal" },
			// No 表示使用文字占位，不会删除工具结果中的原图片。
			{ value: "no", label: "No", description: "Show text placeholder instead" },
		];

		// Add top border
		// 上下各加入一个按宽度绘制的边框；没有在这里写终端。
		this.addChild(new DynamicBorder());

		// Create selector
		// 列表可显示最多 5 个候选行，但这里只有 2 项；引用同一 items 与布局配置。
		this.selectList = new SelectList(items, 5, getSelectListTheme(), SHOW_IMAGES_SELECT_LIST_LAYOUT);

		// Preselect current value
		// true 选第一项，否则第二项；直接设置下标不触发选择/预览回调。
		this.selectList.setSelectedIndex(currentValue ? 0 : 1);

		// 绑定真正确认后的回调，移动光标不会进入这里。
		this.selectList.onSelect = (item) => {
			// 精确 yes 才回传 true；组件自身不会持久化该布尔值。
			onSelect(item.value === "yes");
		};

		// 将取消意图交调用方，不在此自动关闭/移除容器。
		this.selectList.onCancel = () => {
			// 同步执行无参取消回调，异常不捕获。
			onCancel();
		};

		// 把列表排在上下边框之间。
		this.addChild(this.selectList);

		// Add bottom border
		// 上下各加入一个按宽度绘制的边框；没有在这里写终端。
		this.addChild(new DynamicBorder());
	}

	// 返回内部列表原引用，无副作用；例宿主用它设置键盘焦点，也可读取当前项，不会复制或重新创建列表。
	getSelectList(): SelectList {
		// 直接返回同一实例，外部可通过其公共方法修改选择状态。
		return this.selectList;
	}
}
