// 把 CLI 的启动选择/输入界面适配给项目信任机制；没有 UI 时不会自动同意。
import chalk from "chalk";
import type { ProjectTrustContext } from "../core/extensions/types.ts";
import type { AppMode } from "../core/project-trust.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { showStartupInput, showStartupSelector } from "./startup-ui.ts";

/**
 * 组装 ProjectTrustContext，将当前目录、模式和受模式限制的 UI 操作提供给信任机制。
 * 返回对象中的回调只在调用时弹界面；创建对象本身不会询问用户。
 * 例：print 模式 hasUI=false 时 confirm 返回 false、input/select 返回 undefined；interactive 且有 UI 时才展示启动对话。
 * 副作用在回调执行阶段：可打开终端 TUI，非交互通知会写 stderr。
 */
// 创建给信任决策使用的上下文适配器，具体能力依据本次 CLI 模式开放。
export function createProjectTrustContext(options: {
	// 被判断是否信任的项目目录。
	cwd: string;
	// 运行模式为 interactive/print/json/rpc；只有 interactive 可在这里打开终端选择器。
	mode: AppMode;
	// 启动界面需要配置管理器来读取主题和终端偏好。
	settingsManager: SettingsManager;
	// 调用方明确说明是否具备 UI；即使模式是 interactive，也要同时满足这个条件。
	hasUI: boolean;
	// 返回接口规定的上下文对象，不在此执行所有选择/输入动作。
}): ProjectTrustContext {
	// 返回数据和函数组成的对象；select/confirm/input/notify 都是稍后才调用的回调。
	return {
		// 保留本次项目目录。
		cwd: options.cwd,
		// 把应用层 interactive 名称映射为扩展上下文使用的 tui，其余模式保持原值。
		mode: options.mode === "interactive" ? "tui" : options.mode,
		// 原样报告 UI 可用性，不因对象里有 ui 字段就假装支持弹窗。
		hasUI: options.hasUI,
		// 把几种交互操作收在 ui 对象中，便于信任机制只依赖这一组接口。
		ui: {
			// 供用户从字符串选项中选择；返回选中的字符串或 undefined。
			select: async (title, selectOptions) => {
				// 没有 UI 时不发起终端交互，直接给调用方“没有选择”的结果。
				if (!options.hasUI) {
					// 表示没有选择/输入，不会默认同意信任。
					return undefined;
				}
				// 非交互模式不打开启动 TUI，防止脚本/RPC 的输入输出被提示界面打乱。
				if (options.mode !== "interactive") {
					// 表示没有选择/输入，不会默认同意信任。
					return undefined;
				}
				// 符合 UI 条件后，才调用真正的启动选择界面。
				return showStartupSelector(
					// 把当前配置传给界面构造器。
					options.settingsManager,
					// 使用调用者提供的标题，不在这里替换信任问题含义。
					title,
					// 显示文字与返回值都采用原字符串；箭头函数括号内的对象直接返回。
					selectOptions.map((option) => ({ label: option, value: option })),
				);
			},
			// 二选一确认；结果为布尔值，没有 UI 或取消时按 false 处理。
			confirm: async (title, message) => {
				// 没有 UI 时不发起终端交互，直接给调用方“没有选择”的结果。
				if (!options.hasUI) {
					// 不能交互时保守返回 false，不自动授予信任。
					return false;
				}
				// 非交互模式不打开启动 TUI，防止脚本/RPC 的输入输出被提示界面打乱。
				if (options.mode !== "interactive") {
					// 不能交互时保守返回 false，不自动授予信任。
					return false;
				}
				// 下面的 await 与 ?? 共同把取消的 undefined 归为 false。
				return (
					// 标题和正文显示在选择器里；这里等待真实选择结果。
					(await showStartupSelector(options.settingsManager, `${title}\n${message}`, [
						// 显示 Yes，选中时返回布尔 true，不是字符串。
						{ label: "Yes", value: true },
						// 显示 No，选中时返回 false。
						{ label: "No", value: false },
						// 取消或无结果时退回 false；?? 不会覆盖用户明确选择的 false。
					])) ?? false
				);
			},
			// 文本输入操作；placeholder 保留并向下透传，当前输入组件没有显示它。
			input: async (title, placeholder) => {
				// 没有 UI 时不发起终端交互，直接给调用方“没有选择”的结果。
				if (!options.hasUI) {
					// 表示没有选择/输入，不会默认同意信任。
					return undefined;
				}
				// 非交互模式不打开启动 TUI，防止脚本/RPC 的输入输出被提示界面打乱。
				if (options.mode !== "interactive") {
					// 表示没有选择/输入，不会默认同意信任。
					return undefined;
				}
				// 具备交互能力时才等待真实输入或取消结果。
				return showStartupInput(options.settingsManager, title, placeholder);
			},
			// 通知默认为 info；这个适配器在非交互模式输出 stderr，不弹启动界面。
			notify: (message, type = "info") => {
				// 非交互模式不打开启动 TUI，防止脚本/RPC 的输入输出被提示界面打乱。
				if (options.mode !== "interactive") {
					// 三元表达式按通知级别选颜色函数，并未修改消息原文。
					const color = type === "error" ? chalk.red : type === "warning" ? chalk.yellow : chalk.cyan;
					// stderr 与正常 stdout 分开，避免通知污染 JSON/RPC 正常输出通道。
					console.error(color(message));
				}
			},
		},
	};
}
