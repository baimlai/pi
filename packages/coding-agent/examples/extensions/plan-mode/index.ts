/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是“计划模式：只读
 * 探索、生成计划、按步骤执行并跟踪进度”。
 * 上游：用户输入 /plan、按 Ctrl+Alt+P，或以 --plan flag 启动；模型调用 bash 时触发
 * tool_call 拦截；before_agent_start 注入计划/执行提示；turn_end 解析 [DONE:n]；
 * agent_end 提取 “Plan:” 段落并弹出下一步选择。
 * 下游：pi.setActiveTools/getActiveTools 切换工具集；pi.appendEntry("plan-mode", ...) 持久化；
 * pi.sendMessage/sendUserMessage 触发执行回合；ctx.ui.setStatus/setWidget/select/editor/notify
 * 更新界面；ctx.sessionManager.getEntries() 恢复状态；工具白名单逻辑来自 ./utils.ts。
 *
 * 演示的机制：计划模式把工具集限制为只读工具（read/bash/grep/find/ls/questionnaire），并拦截
 * 未列入白名单的 bash 命令；助手回复中 “Plan:” 下的编号列表被提取为 TodoItem；执行阶段模型
 * 在回复里写 [DONE:n] 来标记完成，状态写入会话条目，恢复时只重扫最近一次执行标记之后的消息，
 * 避免把旧计划的完成标记算进来。
 *
 * 能力清单：
 * - PlanModeState：持久化的 enabled/todos/executing/toolsBeforePlanMode。
 * - isAssistantMessage/getTextContent：安全读取助手文本。
 * - updateStatus：状态栏与待办 widget。
 * - uniqueToolNames/getPlanModeTools/getNormalModeTools：工具集合并与过滤。
 * - enablePlanModeTools/restoreNormalModeTools/persistState/togglePlanMode。
 * - 事件处理器：tool_call 拦截、context 清理、before_agent_start 注入、turn_end 进度、
 *   agent_end 计划提取与执行选择、session_start 恢复。
 *
 * 典型运行顺序：/plan 开启 -> 只读探索 -> 模型输出 Plan: 编号步骤 -> agent_end 弹出选择 ->
 * 选择执行 -> 恢复完整工具并注入剩余步骤 -> 模型逐步输出 [DONE:n] -> 全部完成后自动发完成
 * 消息并清空状态。
 *
 * 示例（真实签名）：
 *   pi.appendEntry<PlanModeState>("plan-mode", { enabled, todos, executing, toolsBeforePlanMode });
 *   const choice = await ctx.ui.select("Plan mode - what next?", ["Execute the plan (track progress)", ...]);
 *
 * 建议阅读顺序：先看 utils.ts 的 isSafeCommand/extractTodoItems，再看工具集切换与 toggle，
 * 然后看 tool_call 拦截与 before_agent_start 的两段上下文，最后看 agent_end 的执行流程。
 *
 * 前置条件：依赖同目录 ./utils.ts；不改外部文件，但会改变模型可见工具与系统提示。所有 UI
 * 调用都假设存在 UI；无 UI 时部分路径会提前返回，因此计划提取只在 ctx.hasUI 时进行。
 */

/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, built-in write tools are disabled.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.ts";

// Tools
// 计划模式允许的工具：只读/查询类；bash 仍会逐命令检查白名单。
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
// 正常模式的基础工具；edit/write 是计划模式明确禁用的两个。
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);
// 由本扩展管理的全部工具名；切换模式时据此排除残留项。
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

// 持久化结构；可选字段兼容旧条目。
interface PlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	toolsBeforePlanMode?: string[];
}

// Type guard for assistant messages
// 运行时检查 role 与 content 形状；AgentMessage 是消息联合类型。
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
// 只保留 text 块并用换行连接；工具调用等其他块被丢弃。
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

// 扩展入口：闭包保存两种模式与待办状态。
export default function planModeExtension(pi: ExtensionAPI): void {
	// planModeEnabled 表示只读探索阶段；executionMode 表示按计划执行阶段。
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	// 进入计划模式前的工具集合；退出时原样恢复，undefined 表示未保存。
	let toolsBeforePlanMode: string[] | undefined;

	// --plan 启动时开启计划模式；session_start 读取。
	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	// 更新状态栏与待办 widget；两种模式互斥显示。
	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
		if (executionMode && todoItems.length > 0) {
			// 执行阶段显示完成数/总数。
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			// 计划阶段用暂停图标提示只读。
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			// 传 undefined 清除该 key 的状态。
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Widget showing todo list
		// 执行阶段在编辑器上方显示待办；完成后变暗并加删除线。
		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			// 不在执行阶段时移除 widget。
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	// 用 Set 去重；顺序保留第一次出现的位置。
	function uniqueToolNames(toolNames: string[]): string[] {
		return [...new Set(toolNames)];
	}

	// 计划模式工具 = 当前工具去掉 edit/write，再加入计划工具。
	// filter 保留用户自定义的其他工具，避免误删。
	function getPlanModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS,
		]);
	}

	// 正常模式工具 = 基础工具 + 当前工具中不由本扩展管理的项。
	function getNormalModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...NORMAL_MODE_TOOLS,
			...activeToolNames.filter((name) => !PLAN_MANAGED_TOOLS.has(name)),
		]);
	}

	// 首次进入计划模式时保存原工具集；重复开启不覆盖快照。
	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
	}

	// 恢复快照；没有快照时按当前工具推导一个正常集合。
	function restoreNormalModeTools(): void {
		pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
		toolsBeforePlanMode = undefined;
	}

	// 把完整状态写入会话；字段都可序列化。
	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			toolsBeforePlanMode,
		});
	}

	// 切换计划模式：切换时清空执行状态与待办，避免跨计划污染。
	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		todoItems = [];

		if (planModeEnabled) {
			enablePlanModeTools();
			ctx.ui.notify("Plan mode enabled. Built-in write tools disabled.");
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
		persistState();
	}

	// /plan：切换只读计划模式。
	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	// /todos：用通知列出当前计划进度；不打开自定义 UI。
	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			// 序号 + 完成标记 + 文本；换行拼接后放入通知。
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	// Ctrl+Alt+P 快捷键与 /plan 等价；Key.ctrlAlt 生成可配置的键位 ID。
	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Block destructive bash commands in plan mode
	// tool_call 在工具执行前触发；返回 {block, reason} 会阻止本次调用。
	pi.on("tool_call", async (event) => {
		// 不在计划模式或不是 bash 时不干预。
		if (!planModeEnabled || event.toolName !== "bash") return;

		// command 在事件输入里是 unknown；bash 工具的 schema 保证是字符串。
		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// Filter out stale plan mode context when not in plan mode
	// 关闭计划模式后，历史中的注入上下文仍会留在会话里；这里在发给模型前过滤。
	pi.on("context", async (event) => {
		// 计划模式仍开启时保留，模型需要这些限制说明。
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				// 自定义上下文消息直接丢弃。
				if (msg.customType === "plan-mode-context") return false;
				// 非 user 消息不处理。
				if (msg.role !== "user") return true;

				// user 消息内容可能是字符串或内容块数组；两种都检查标记文本。
				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before a user prompt. Runs started by custom messages, such as
	// background task notifications, skip it: the context from the last prompt is still in the
	// conversation, and adding it again on every notification would only repeat it.
	// 只在真实用户提示触发的回合注入；自定义消息触发的回合沿用历史中的上下文。
	pi.on("before_agent_start", async (event) => {
		if (event.messageType !== "user") return;

		// 计划阶段：注入只读限制与 “Plan:” 编号格式。模板内容保持原样。
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Built-in edit and write tools are disabled
- Other currently active tools remain available
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the questionnaire tool.
Use brave-search skill via bash for web research.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
					display: false,
				},
			};
		}

		// 执行阶段：只列出未完成步骤，并说明用 [DONE:n] 标记完成。
		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
	});

	// Track progress after each turn
	// 每个回合结束扫描助手文本里的 [DONE:n]；只有状态真的变化才刷新 UI。
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		// markCompletedSteps 返回本回合发现的标记数量（不是新完成数）。
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
		}
		// 即使没有标记也持久化，保证条目顺序与最新状态一致。
		persistState();
	});

	// Handle plan completion and plan mode UI
	// agent_end 是较高层事件：一次代理运行结束时触发，可在这里做跨回合决策。
	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		// 执行阶段：全部完成则发完成消息并清空状态。
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				// 用 Markdown 删除线展示已完成项。
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					// triggerTurn: false 表示只显示消息，不再启动模型回合，避免循环。
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				updateStatus(ctx);
				persistState(); // Save cleared state so resume doesn't restore old execution mode
			}
			// 执行阶段无论是否完成都不再走计划提取。
			return;
		}

		// 计划提取需要 UI（稍后要弹选择框）；非计划模式直接返回。
		if (!planModeEnabled || !ctx.hasUI) return;

		// Extract todos from last assistant message
		// 反向遍历找最后一条助手消息；[...event.messages] 复制后避免修改事件数组。
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			// 只有提取到步骤才覆盖旧待办；否则保留之前的状态。
			if (extracted.length > 0) {
				todoItems = extracted;
			}
		}

		if (todoItems.length === 0) return;
		persistState();

		// Show plan steps and prompt for next action
		// 先构造可复用的计划消息，执行/refine 分支都会发送它。
		const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
		const planTodoListMessage = {
			customType: "plan-todo-list",
			content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
			display: true,
		};

		// select 返回用户选择的字符串或 undefined（取消）。
		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan (track progress)",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			const firstTodoItem = todoItems[0];
			// 空数组理论上不会到这里；显式返回避免非空断言。
			if (!firstTodoItem) return;

			// 进入执行阶段：关闭计划限制、恢复工具、更新 UI 与持久化。
			planModeEnabled = false;
			executionMode = true;
			restoreNormalModeTools();
			updateStatus(ctx);
			persistState();

			// 执行消息包含剩余步骤与起点；模板内保持原样。
			const remainingList = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");
			const execMessage = `Execute the plan.

Remaining steps:
${remainingList}

Start with: ${firstTodoItem.text}
After completing a step, include a [DONE:n] tag in your response.`;
			// 先发计划列表作为 followUp，再发执行指令并触发新回合。
			pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			// editor 返回编辑后的文本；取消时为 undefined。
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				// 先展示当前计划，再把用户修改作为后续用户消息发送。
				pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	// Restore state on session start/resume
	// 启动/恢复：--plan flag 优先，其次读取最后一条 plan-mode 自定义条目。
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		// filter + pop 取最后一条；类型断言给 data 一个可读结构。
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		// 每个字段用 ?? 保留当前值（可能来自 --plan flag）。
		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
		}

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		// 持久化的 todos 带有中断时的完成状态；但仍需重放执行期间的 [DONE:n] 以补齐
		// 最后一条状态条目之后发生的完成事件。
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			// Only scan messages after the execute marker
			// 收集标记之后的所有助手消息，拼成一段文本再统一匹配。
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				// "message" in entry 缩小联合类型；再经 isAssistantMessage 确认 content 是数组。
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		// 如果恢复后仍处于计划模式，重新应用只读工具集。
		if (planModeEnabled) {
			enablePlanModeTools();
		}
		updateStatus(ctx);
	});
}
