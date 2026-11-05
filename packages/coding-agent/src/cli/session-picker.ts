// 为 --resume 显示会话列表，选择后返回路径，取消时返回 null。
/**
 * TUI session selector for --resume flag
 */

import { setKeybindings } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.ts";
import { createStartupTui, startStartupTui } from "./startup-ui.ts";

// 函数类型：加载器可接进度回调/取消信号，异步返回会话信息数组；这里只定义契约，不加载记录。
type SessionsLoader = (onProgress?: SessionListProgress, signal?: AbortSignal) => Promise<SessionInfo[]>;

/** Show TUI session selector and return selected session path or null if cancelled */
/**
 * 显示启动会话选择器，用于恢复某份历史；本函数不自己恢复 Agent 的消息。
 * 两个加载器分别提供当前目录和全部会话；配置决定主题、终端行为、按键。
 * 选中路径 → stop/resolve(path)；取消 → stop/resolve(null)；退出 → process.exit(0)。
 * 例如选中 /tmp/session.jsonl，调用方 await 后得到该路径，再交给会话管理层加载。
 */
export async function selectSession(
	// 用于加载当前目录会话的函数，组件按需要再调用它。
	currentSessionsLoader: SessionsLoader,
	// 用于加载全部目录会话的函数，包含当前目录，供切换全部会话视图。
	allSessionsLoader: SessionsLoader,
	// 读取启动主题、终端偏好和按键设置的配置管理器。
	settingsManager: SettingsManager,
	// 选中时返回会话文件路径，取消时返回 null；调用方需要先 await 再判断结果。
): Promise<string | null> {
	// 先完成启动界面的主题/能力准备，再创建选择或输入组件。
	const ui = await createStartupTui(settingsManager);
	// 返回等待用户选择的 Promise；resolve 由组件回调触发，而不是构造界面后立即完成。
	return new Promise((resolve) => {
		// 加载可配置按键映射，避免把选择/取消键直接硬编码在调用方。
		const keybindings = KeybindingsManager.create();
		// 让 TUI 的按键匹配逻辑采用这份键位配置。
		setKeybindings(keybindings);
		// 记录当前选择是否已完成，避免两个回调重复停止同一界面。
		let resolved = false;

		// 创建会话选择组件；下面回调区分选中、取消和退出整个进程。
		const selector = new SessionSelectorComponent(
			// 传函数引用，组件可在需要展示当前目录会话时加载。
			currentSessionsLoader,
			// 传另一个加载器，供切换全部会话视图。
			allSessionsLoader,
			// 用户选中会话后得到路径，冒号是 TypeScript 参数类型标注。
			(path: string) => {
				// 只让第一次完成操作生效；! 对布尔值取反。
				if (!resolved) {
					// 先标记完成，再清理并 resolve，防止同步回调重入。
					resolved = true;
					// 停止这个启动界面的终端处理；后面主聊天界面可以使用新的 TUI。
					ui.stop();
					// 返回用户选中的会话路径，后续主流程再恢复它。
					resolve(path);
				}
			},
			// 把无参数函数作为回调传入；组件在关闭、取消或退出时才调用相应函数。
			() => {
				// 只让第一次完成操作生效；! 对布尔值取反。
				if (!resolved) {
					// 先标记完成，再清理并 resolve，防止同步回调重入。
					resolved = true;
					// 停止这个启动界面的终端处理；后面主聊天界面可以使用新的 TUI。
					ui.stop();
					// 返回明确的取消值，不随便选择第一个会话。
					resolve(null);
				}
			},
			// 把无参数函数作为回调传入；组件在关闭、取消或退出时才调用相应函数。
			() => {
				// 停止这个启动界面的终端处理；后面主聊天界面可以使用新的 TUI。
				ui.stop();
				// 用户明确退出时终止 CLI，0 是正常退出码；不只是关闭一个组件。
				process.exit(0);
			},
			// 组件内容变化时请求下一次渲染，而不是自己直接写终端。
			() => ui.requestRender(),
			// 隐藏重命名提示，并把同一份可配置键位交给组件。
			{ showRenameHint: false, keybindings },
		);

		// 将组件加入界面组件树，后续渲染才会包含它。
		ui.addChild(selector);
		// 把键盘焦点放到会话列表，避免按键送错组件。
		ui.setFocus(selector.getSessionList());
		// 启动界面并异步查询终端颜色；不必等颜色到达才响应选择。
		startStartupTui(ui, settingsManager);
	});
}
