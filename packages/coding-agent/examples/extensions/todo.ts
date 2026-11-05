/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是“用会话条目做状态管理”。
 * 上游：模型调用 todo 工具（list/add/toggle/clear）时进入 execute；用户输入 /todos 时
 * 打开自定义列表组件。下游：ctx.sessionManager.getBranch() 读取当前分支历史，
 * ctx.ui.custom() 显示 TodoListComponent，matchesKey/truncateToWidth 处理按键与宽度。
 *
 * 演示的机制：状态不写外部文件，而是每次工具结果都带完整 todos/nextId 到 details；
 * 会话恢复或切换分支时，扫描当前分支中该工具的 toolResult 消息，最后一个结果即为状态。
 * 因此分支导航会自动回到该历史点的待办列表。
 *
 * 能力清单：
 * - Todo：单条待办（id/text/done）。
 * - TodoDetails：工具结果 details（action、完整 todos、nextId、可选 error）。
 * - TodoParams：action 为 StringEnum 的字面量联合，text/id 可选。
 * - TodoListComponent：实现 handleInput/render/invalidate 的只读展示组件，Esc 关闭。
 * - 默认导出：注册 todo 工具与 /todos 命令，并在 session_start/session_tree 重建状态。
 *
 * 典型运行顺序：模型 add 两条待办 -> 再 toggle 一条 -> 用户输入 /todos 查看；重启并
 * 恢复同一分支后待办仍在；切换到添加之前的节点时列表回到当时状态。
 *
 * 示例（真实签名）：
 *   // 工具调用由模型发起，真实参数形如
 *   { action: "add", text: "Write tests" }
 *   返回 content 文本与 details；示例不持久化到外部文件。
 *
 * 建议阅读顺序：先看 Todo/TodoDetails/TodoParams 三个类型，再看 reconstructState，
 * 然后看 execute 的四个分支，最后看渲染与 /todos 命令。
 *
 * 前置条件：/todos 需要 TUI 模式；工具本身可在任意模式调用。不产生模型费用（除非模型
 * 主动调用工具）。
 */

/**
 * Todo Extension - Demonstrates state management via session entries
 *
 * This extension:
 * - Registers a `todo` tool for the LLM to manage todos
 * - Registers a `/todos` command for users to view the list
 *
 * State is stored in tool result details (not external files), which allows
 * proper branching - when you branch, the todo state is automatically
 * correct for that point in history.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// 单条待办：id 自增且只在当前状态下唯一，text 是用户/模型给的描述，done 表示完成。
interface Todo {
	id: number;
	text: string;
	done: boolean;
}

// 每次工具结果都携带完整状态，恢复时取最后一个结果即可；action 记录这次做了什么。
interface TodoDetails {
	action: "list" | "add" | "toggle" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

// action 用 StringEnum 生成 {type:"string",enum:[...]}，兼顾供应商兼容性与 TS 字面量联合。
const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear"] as const),
	// text 只在 add 时需要，id 只在 toggle 时需要；运行时校验不表达这种条件依赖。
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

/**
 * UI component for the /todos command
 */
// 只读列表组件：缓存按宽度失效，宽度不变时直接复用上次渲染结果。
class TodoListComponent {
	// 传入的数组引用；组件不修改 todos。
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;
	// 缓存键与缓存行；? 表示尚未渲染过。
	private cachedWidth?: number;
	private cachedLines?: string[];

	// 构造函数只保存引用，不启动定时器或 I/O；显式字段赋值是 Node 只擦除语法的要求。
	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	// 终端输入入口：Esc 或 Ctrl+C 关闭；其他按键忽略。
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	// 渲染给定宽度的多行文本；所有行都经 truncateToWidth 防止超宽换行。
	render(width: number): string[] {
		// 宽度相同才复用；终端 resize 后缓存失效。
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		// th 是局部别名，减少重复的 this.theme。
		const th = this.theme;

		lines.push("");
		// 标题两侧用边框色画横线；Math.max(0, ...) 防止窄终端出现负重复次数。
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		// 空列表给出如何产生待办的提示。
		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`, width));
		} else {
			// filter(...).length 统计完成数；total 用数组长度。
			const done = this.todos.filter((t) => t.done).length;
			const total = this.todos.length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${total} completed`)}`, width));
			lines.push("");

			for (const todo of this.todos) {
				// 三元表达式分别选择完成/未完成的图标与文字颜色。
				const check = todo.done ? th.fg("success", "✓") : th.fg("dim", "○");
				const id = th.fg("accent", `#${todo.id}`);
				const text = todo.done ? th.fg("dim", todo.text) : th.fg("text", todo.text);
				lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		// 写入缓存后返回；调用方不应修改返回数组。
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	// 清空缓存；下一次 render 会重新构建。
	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// 扩展入口：内存状态由会话历史重建；每次执行都会把新状态写进工具结果。
export default function (pi: ExtensionAPI) {
	// In-memory state (reconstructed from session on load)
	// 运行时状态；重建前为空数组，nextId 从 1 开始。
	let todos: Todo[] = [];
	let nextId = 1;

	/**
	 * Reconstruct state from session entries.
	 * Scans tool results for this tool and applies them in order.
	 */
	// 从当前分支恢复：先清空，再按时间顺序遍历，最后一个 todo 结果覆盖之前状态。
	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

		// getBranch 只返回当前分支，因此不会读入其他分支的旧待办。
		for (const entry of ctx.sessionManager.getBranch()) {
			// 只关心消息条目；自定义条目等其他类型跳过。
			if (entry.type !== "message") continue;
			const msg = entry.message;
			// 同时检查角色与工具名，避免误读其他工具的结果。
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			// details 是 unknown，需要断言；没有 details 的旧结果直接忽略。
			const details = msg.details as TodoDetails | undefined;
			if (details) {
				// 每次都整体替换，因为每条结果都携带完整快照。
				todos = details.todos;
				nextId = details.nextId;
			}
		}
	};

	// Reconstruct state on session events
	// 启动/恢复与树导航时重建；两个回调都返回 void。
	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// Register the todo tool for the LLM
	// 工具定义：所有分支都返回 content + details，错误也用文本表达而不是抛异常。
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage a todo list. Actions: list, add (text), toggle (id), clear",
		parameters: TodoParams,

		// 参数已由 schema 校验过 action/text/id 的形状；这里再检查业务上必需的条件。
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// switch 对 action 联合做收窄，每个 case 内 params.action 是字面量类型。
			switch (params.action) {
				case "list":
					// todos 非空时逐条格式化，否则给 "No todos"。
					return {
						content: [
							{
								type: "text",
								text: todos.length
									? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
									: "No todos",
							},
						],
						// [...todos] 复制数组，避免把内部可变引用写进历史后被后续修改。
						details: { action: "list", todos: [...todos], nextId } as TodoDetails,
					};

				case "add": {
					// text 在 schema 中可选，但 add 在业务上必须提供；空串也视为缺失。
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { action: "add", todos: [...todos], nextId, error: "text required" } as TodoDetails,
						};
					}
					// nextId++ 先用当前值创建，再自增；新待办默认未完成。
					const newTodo: Todo = { id: nextId++, text: params.text, done: false };
					todos.push(newTodo);
					return {
						content: [{ type: "text", text: `Added todo #${newTodo.id}: ${newTodo.text}` }],
						details: { action: "add", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "toggle": {
					// id 是可选数字；0 是合法 id，因此用 === undefined 而不是假值判断。
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for toggle" }],
							details: { action: "toggle", todos: [...todos], nextId, error: "id required" } as TodoDetails,
						};
					}
					// find 返回第一个匹配项；未找到时 undefined。
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "toggle",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					// 取反完成状态；修改的是内部对象，随后用复制后的数组写入历史。
					todo.done = !todo.done;
					return {
						content: [{ type: "text", text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}` }],
						details: { action: "toggle", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "clear": {
					// 先保存数量用于提示，再重置数组与 id 计数器。
					const count = todos.length;
					todos = [];
					nextId = 1;
					return {
						content: [{ type: "text", text: `Cleared ${count} todos` }],
						details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
					};
				}

				default:
					// schema 已限制 action 取值，正常不会到这里；保留兜底以防直接调用 execute 或 schema 变更。
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: {
							action: "list",
							todos: [...todos],
							nextId,
							error: `unknown action: ${params.action}`,
						} as TodoDetails,
					};
			}
		},

		// 调用行显示 action，以及可选的 text/id；不执行任何逻辑。
		renderCall(args, theme, _context) {
			// theme.bold 与 fg 返回带 ANSI 的字符串，直接拼接。
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			// id 可能为 0，所以用 !== undefined 而不是真值判断。
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		// 结果行根据 details.action 切换布局；expanded 控制 list 是否显示全部条目。
		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				// 没有 details 时退回原始文本块。
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			// 错误优先显示为红色，不进入各 action 布局。
			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const todoList = details.todos;

			switch (details.action) {
				case "list": {
					if (todoList.length === 0) {
						return new Text(theme.fg("dim", "No todos"), 0, 0);
					}
					let listText = theme.fg("muted", `${todoList.length} todo(s):`);
					// 未展开时只显示前 5 条；展开时全部显示。
					const display = expanded ? todoList : todoList.slice(0, 5);
					for (const t of display) {
						const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
						const itemText = t.done ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
						listText += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					// 折叠状态提示还有多少条未显示。
					if (!expanded && todoList.length > 5) {
						listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "add": {
					// 新待办总是追加在末尾，因此取最后一个元素；空数组时这里会抛错，正常 add 结果不会为空。
					const added = todoList[todoList.length - 1];
					return new Text(
						theme.fg("success", "✓ Added ") +
							theme.fg("accent", `#${added.id}`) +
							" " +
							theme.fg("muted", added.text),
						0,
						0,
					);
				}

				case "toggle": {
					// toggle 的细节由 execute 的文本结果给出，这里直接复用。
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);

				default:
					// 未识别 action 用错误色显示原始文案。
					return new Text(
						result.content[0]?.type === "text" ? theme.fg("error", result.content[0].text) : "",
						0,
						0,
					);
			}
		},
	});

	// Register the /todos command for users
	// /todos：仅 TUI；custom 会阻塞直到组件调用 done()。
	pi.registerCommand("todos", {
		description: "Show all todos on the current branch",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			// 泛型 void 表示不返回选择结果；关闭时 done() 不带参数。
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				// 组件拿到当前 todos 引用与主题；Esc 时回调 done()。
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}
