/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是交互式启停工具。
 * 上游：用户输入 /tools；session_start 与 session_tree（会话树导航）时恢复状态。
 * 下游：pi.getAllTools()/getActiveTools()/setActiveTools() 读取和修改模型可见工具，
 * pi.appendEntry() 把选择写入会话日志，ctx.ui.custom() 打开 SettingsList 组件。
 *
 * 演示的机制：工具选择持久化在自定义会话条目 "tools-config" 中，而不是外部文件。恢复
 * 时只扫描当前分支（getBranch()），因此切换分支会得到该历史点对应的工具集合；保存时
 * 过滤掉已不存在的工具名，避免旧配置引用已删除工具。
 *
 * 能力清单：
 * - ToolsState：持久化结构，仅含 enabledTools 字符串数组。
 * - toolsExtension(pi)：扩展入口，维护 enabledTools/allTools 闭包状态。
 * - persistState()：把当前启用集合写入会话条目。
 * - applyTools()：调用 pi.setActiveTools() 立即生效。
 * - restoreFromBranch(ctx)：从当前分支最后一条 tools-config 恢复，否则同步当前 active。
 * - /tools 命令：TUI 模式下打开可上下选择、切换 enabled/disabled 的列表。
 *
 * 典型运行顺序：加载扩展 -> 输入 /tools -> 列表显示每个工具当前状态 -> 切换某项立即
 * 生效并持久化 -> 重启/恢复会话后选择仍在；在会话树切换到旧分支时恢复该分支的选择。
 *
 * 示例（真实签名）：
 *   pi.setActiveTools(["read", "bash"]);          // 只向模型声明这两个工具
 *   pi.appendEntry("tools-config", { enabledTools: ["read", "bash"] });
 *   真实运行时 appendEntry 只记录状态，不会自动改变 active 集合。
 *
 * 建议阅读顺序：先看 ToolsState 与两个闭包变量，再看 restoreFromBranch 的分支扫描，
 * 最后看 /tools 中 SettingsList 的构建与 onChange。
 *
 * 前置条件：需要 TUI 模式（ctx.mode === "tui"）才能打开自定义列表；其他模式会提示错误。
 * 不产生模型费用，不写外部文件；状态写入会话日志。
 */

/**
 * Tools Extension
 *
 * Provides a /tools command to enable/disable tools interactively.
 * Tool selection persists across session reloads and respects branch navigation.
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /tools to open the tool selector
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";

// State persisted to session
// 持久化数据的形状：只有工具名数组，恢复时再与当前工具目录求交集。
interface ToolsState {
	enabledTools: string[];
}

// 扩展入口：Set 便于 O(1) 增删与去重；allTools 缓存当前工具目录供列表渲染。
export default function toolsExtension(pi: ExtensionAPI) {
	// Track enabled tools
	// 当前启用的工具名集合；恢复/切换时整体替换。
	let enabledTools: Set<string> = new Set();
	// 工具元数据列表；/tools 打开前刷新，列表项从这里生成。
	let allTools: ToolInfo[] = [];

	// Persist current state
	// 把 Set 转成数组写入自定义会话条目；Array.from 复制当前元素，之后修改 Set 不会改到已写入的数据。
	function persistState() {
		pi.appendEntry<ToolsState>("tools-config", {
			enabledTools: Array.from(enabledTools),
		});
	}

	// Apply current tool selection
	// 立即把选择同步给宿主；setActiveTools 不会执行任何工具，只改变对模型声明的集合。
	function applyTools() {
		pi.setActiveTools(Array.from(enabledTools));
	}

	// Find the last tools-config entry in the current branch
	// 从当前分支恢复：只向前读取到当前节点为止的条目，因此分支导航后状态随之变化。
	function restoreFromBranch(ctx: ExtensionContext) {
		// 每次恢复都重新拉取目录，避免使用过期工具列表。
		allTools = pi.getAllTools();

		// Get entries in current branch only
		// getBranch 返回当前分支上的会话条目数组。
		const branchEntries = ctx.sessionManager.getBranch();
		// undefined 表示本分支从未保存过选择。
		let savedTools: string[] | undefined;

		// 顺序遍历，后面的同名条目覆盖前面的，最终得到最后一条。
		for (const entry of branchEntries) {
			// type === "custom" 是本扩展写入的条目；customType 区分用途。
			if (entry.type === "custom" && entry.customType === "tools-config") {
				// 条目 data 在类型上是 unknown，需要断言；?. 防御没有 data 的旧条目。
				const data = entry.data as ToolsState | undefined;
				if (data?.enabledTools) {
					savedTools = data.enabledTools;
				}
			}
		}

		// 有保存记录：只保留当前仍存在的工具，防止旧分支引用已删除工具。
		if (savedTools) {
			// Restore saved tool selection (filter to only tools that still exist)
			const allToolNames = allTools.map((t) => t.name);
			// includes 的 O(n) 查找在小工具集上足够；t 的显式 string 注解可读性辅助。
			enabledTools = new Set(savedTools.filter((t: string) => allToolNames.includes(t)));
			applyTools();
		} else {
			// No saved state - sync with currently active tools
			// 首次使用：以宿主当前 active 集合为起点，不擅自改变默认。
			enabledTools = new Set(pi.getActiveTools());
		}
	}

	// Register /tools command
	// /tools：仅 TUI 可用，打开自定义列表；await 会等到 done() 关闭界面才继续。
	pi.registerCommand("tools", {
		description: "Enable/disable tools",
		handler: async (_args, ctx) => {
			// ctx.mode 是字符串联合；比较 "tui" 后其余模式不满足条件。
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires TUI mode", "error");
				return;
			}

			// Refresh tool list
			allTools = pi.getAllTools();

			// custom 的泛型由 done 的参数决定；这里 done(undefined) 表示只关心关闭，不返回选择值。
			await ctx.ui.custom((tui, theme, _kb, done) => {
				// Build settings items for each tool
				// 每个工具映射为 SettingItem：id/label 用工具名，currentValue 反映当前状态。
				const items: SettingItem[] = allTools.map((tool) => ({
					id: tool.name,
					label: tool.name,
					currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
					// values 定义可切换的取值；SettingsList 默认在它们之间循环。
					values: ["enabled", "disabled"],
				}));

				// Container 按顺序纵向组合子组件。
				const container = new Container();
				// 匿名类实现最小 Component：render 返回两行标题，invalidate 无缓存可清。
				container.addChild(
					new (class {
						render(_width: number) {
							return [theme.fg("accent", theme.bold("Tool Configuration")), ""];
						}
						invalidate() {}
					})(),
				);

				// SettingsList 参数：项、最多可见行、主题、值变化回调、取消回调。
				const settingsList = new SettingsList(
					items,
					// 列表项数 + 2，但最多 15 行，避免占满终端。
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						// Update enabled state and apply immediately
						// 字符串取值决定增删；随后立即生效并持久化。
						if (newValue === "enabled") {
							enabledTools.add(id);
						} else {
							enabledTools.delete(id);
						}
						applyTools();
						persistState();
					},
					() => {
						// Close dialog
						// 取消/关闭时结束 custom() 的等待。
						done(undefined);
					},
				);

				container.addChild(settingsList);

				// 包装组件：把渲染与输入转发给 container/settingsList，并报告需要抢占视口输入。
				const component = {
					// Let PageUp/PageDown page the list instead of scrolling the fullscreen transcript.
					capturesViewportInput: settingsList.capturesViewportInput,
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						// handleInput 在接口上可选，用 ?. 调用；随后请求重绘以显示新选中项。
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};

				return component;
			});
		},
	});

	// Restore state on session start
	// 会话启动（新建或恢复）时恢复工具选择。
	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	// Restore state when navigating the session tree
	// 在会话树中切换位置后，分支不同，必须重新恢复。
	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
}
