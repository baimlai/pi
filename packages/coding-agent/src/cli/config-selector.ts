// 为 pi config 打开资源配置选择界面，关闭时清理终端与主题监听。
/**
 * TUI config selector for `pi config` command
 */

import { ProcessTerminal, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ConfigSelectorComponent, type ScopedResolvedPaths } from "../modes/interactive/components/config-selector.ts";
import { initTheme, stopThemeWatcher } from "../modes/interactive/theme/theme.ts";

export interface ConfigSelectorOptions {
	// 已经解析出的全局/项目资源路径；这里只选择启用状态，不重新定义资源格式。
	resolvedPaths: ScopedResolvedPaths;
	// 共享配置管理器，组件通过它读取和更新设置。
	settingsManager: SettingsManager;
	// 本次项目目录，供资源选择和项目配置定位使用。
	cwd: string;
	// Pi 配置目录，与项目源码目录可以不同。
	agentDir: string;
	// 字面量联合：选择写入全局设置或项目设置，没有第三种任意字符串。
	writeScope: "global" | "project";
	// 是否允许组件切换到项目设置范围。
	projectModeAvailable: boolean;
}

/** Show TUI config selector and return when closed */
/**
 * 显示资源配置界面并等待用户关闭，供 pi config 命令使用。
 * 输入包含资源列表、配置、目录和写入范围；返回 Promise<void>，无额外业务结果。
 * 流程：初始化主题 → 建 TUI/选择器 → 设置焦点 → 等关闭回调清理。
 * 例：writeScope="project" 时组件针对项目设置工作；退出回调可正常结束整个 CLI。
 */
export async function selectConfig(options: ConfigSelectorOptions): Promise<void> {
	// Initialize theme before showing TUI
	// 建立配置选择器使用的主题；放在构造 TUI 组件前，让组件读到正确颜色。
	initTheme(options.settingsManager.getTheme(), true);

	// 返回等待用户选择的 Promise；resolve 由组件回调触发，而不是构造界面后立即完成。
	return new Promise((resolve) => {
		// 创建主屏终端界面；TUI 是接口类型，实际运行对象是 TuiMainScreen，采用 regular 模式。
		const ui: TUI = new TuiMainScreen(
			// 通过终端适配器读输入、写控制序列，不是浏览器 DOM。
			new ProcessTerminal(),
			// 读取是否显示硬件光标的偏好。
			options.settingsManager.getShowHardwareCursor(),
			// 传入配置目录，供界面需要的资源/状态定位。
			options.agentDir,
		);
		// 终端界面缩小时按设置清除空出的区域，避免旧内容残留。
		ui.setClearOnShrink(options.settingsManager.getClearOnShrink());
		// 记录当前选择是否已完成，避免两个回调重复停止同一界面。
		let resolved = false;

		// 创建配置资源选择组件；下面传入数据、配置和交互回调。
		const selector = new ConfigSelectorComponent(
			// 显示已解析的资源列表，而不是在组件里重新扫描所有包。
			options.resolvedPaths,
			// 组件需要读取/更新配置时使用同一个管理器。
			options.settingsManager,
			// 用当前项目目录区分项目范围资源。
			options.cwd,
			// 传入配置目录，供界面需要的资源/状态定位。
			options.agentDir,
			// 把无参数函数作为回调传入；组件在关闭、取消或退出时才调用相应函数。
			() => {
				// 只让第一次完成操作生效；! 对布尔值取反。
				if (!resolved) {
					// 先标记完成，再清理并 resolve，防止同步回调重入。
					resolved = true;
					// 停止这个启动界面的终端处理；后面主聊天界面可以使用新的 TUI。
					ui.stop();
					// 配置选择器关闭后停止它启动的主题监听，避免监听器遗留。
					stopThemeWatcher();
					// 完成 Promise<void>，await selectConfig 的调用方可以继续启动流程。
					resolve();
				}
			},
			// 把无参数函数作为回调传入；组件在关闭、取消或退出时才调用相应函数。
			() => {
				// 停止这个启动界面的终端处理；后面主聊天界面可以使用新的 TUI。
				ui.stop();
				// 配置选择器关闭后停止它启动的主题监听，避免监听器遗留。
				stopThemeWatcher();
				// 用户明确退出时终止 CLI，0 是正常退出码；不只是关闭一个组件。
				process.exit(0);
			},
			// 组件内容变化时请求下一次渲染，而不是自己直接写终端。
			() => ui.requestRender(),
			// 使用当前终端行数设置组件可用高度。
			ui.terminal.rows,
			// 告知组件此次要写全局还是项目设置。
			options.writeScope,
			// 把项目模式的可用性传下去，组件据此控制切换入口。
			options.projectModeAvailable,
		);

		// 将组件加入界面组件树，后续渲染才会包含它。
		ui.addChild(selector);
		// 键盘焦点交给资源列表，按键才能操作当前列表。
		ui.setFocus(selector.getResourceList());
		// 开始终端界面事件处理；用户关闭组件前，上面的 Promise 保持未完成。
		ui.start();
	});
}
