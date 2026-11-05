// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：接管用户在 pi 里用 `!` 提交的 bash 命令；当命令是 vim、htop、git rebase 等交互式程序时，
//   暂停 TUI、把真实终端交给子进程，结束后恢复 TUI，并把退出信息作为 BashResult 返回给会话。
// 上游：`pi -e examples/extensions/interactive-shell.ts` 加载；用户输入 `!vim file.txt` 触发 user_bash
//   事件（事件里的 command 已经去掉了开头的 `!`）。
// 下游：node:child_process.spawnSync 启动 $SHELL -c；ctx.ui.custom 提供 tui 句柄来 stop/start 终端。
//   只拦截用户 `!` 命令，不拦截模型调用 bash 工具；不写文件，命令本身的外部副作用由用户负责。
// 能力：
//   DEFAULT_INTERACTIVE_COMMANDS  内置的交互式命令前缀列表。
//   getInteractiveCommands()      合并环境变量增删项后的命令列表。
//   isInteractiveCommand()        判断一条命令是否命中列表（含管道后的命令）。
//   默认导出函数                  注册 user_bash 处理器并执行交互命令。
// 配置：INTERACTIVE_COMMANDS 追加逗号分隔命令；INTERACTIVE_EXCLUDE 排除逗号分隔命令（不区分大小写）。
// 运行：pi -e examples/extensions/interactive-shell.ts，然后输入 `!htop` 或 `!i any-command`。
// 典型顺序：加载 -> 用户 ! 命令 -> user_bash -> 识别前缀/命令 -> 非 TUI 直接返回错误结果 ->
//   TUI 中 stop 终端并 spawnSync -> start/重绘 -> done(退出码) -> 返回替换结果。
// 示例（真实命令行）：`!vim notes.txt` 会进入 vim，退出后 pi 显示 interactive command completed。
// 阅读顺序：先看 DEFAULT_INTERACTIVE_COMMANDS 与两个判断函数，再看默认导出里的 TUI 暂停/恢复流程。

/**
 * Interactive Shell Commands Extension
 *
 * Enables running interactive commands (vim, git rebase -i, htop, etc.)
 * with full terminal access. The TUI suspends while they run.
 *
 * Usage:
 *   pi -e examples/extensions/interactive-shell.ts
 *
 *   !vim file.txt        # Auto-detected as interactive
 *   !i any-command       # Force interactive mode with !i prefix
 *   !git rebase -i HEAD~3
 *   !htop
 *
 * Configuration via environment variables:
 *   INTERACTIVE_COMMANDS - Additional commands (comma-separated)
 *   INTERACTIVE_EXCLUDE  - Commands to exclude (comma-separated)
 *
 * Note: This only intercepts user `!` commands, not agent bash tool calls.
 * If the agent runs an interactive command, it will fail (which is fine).
 */

// spawnSync 同步启动子进程：它阻塞调用线程直到命令结束，正好适合“把终端借给交互程序”的场景。
import { spawnSync } from "node:child_process";
// type 导入只在编译期使用，运行时会被擦除，不会为了类型额外加载包。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Default interactive commands - editors, pagers, git ops, TUIs
// 每一项是命令前缀文本，而不是正则或可执行文件路径；判断函数会做“整条等于”或“以该项加空格开头”匹配，
// 所以 "git commit" 能命中 `git commit -m ...`，但不会命中 `git commit-tree`。
const DEFAULT_INTERACTIVE_COMMANDS = [
	// Editors
	"vim",
	"nvim",
	"vi",
	"nano",
	"emacs",
	"pico",
	"micro",
	"helix",
	"hx",
	"kak",
	// Pagers
	"less",
	"more",
	"most",
	// Git interactive
	"git commit",
	"git rebase",
	"git merge",
	"git cherry-pick",
	"git revert",
	"git add -p",
	"git add --patch",
	"git add -i",
	"git add --interactive",
	"git stash -p",
	"git stash --patch",
	"git reset -p",
	"git reset --patch",
	"git checkout -p",
	"git checkout --patch",
	"git difftool",
	"git mergetool",
	// System monitors
	"htop",
	"top",
	"btop",
	"glances",
	// File managers
	"ranger",
	"nnn",
	"lf",
	"mc",
	"vifm",
	// Git TUIs
	"tig",
	"lazygit",
	"gitui",
	// Fuzzy finders
	"fzf",
	"sk",
	// Remote sessions
	"ssh",
	"telnet",
	"mosh",
	// Database clients
	"psql",
	"mysql",
	"sqlite3",
	"mongosh",
	"redis-cli",
	// Kubernetes/Docker
	"kubectl edit",
	"kubectl exec -it",
	"docker exec -it",
	"docker run -it",
	// Other
	"tmux",
	"screen",
	"ncdu",
];

// 汇总可用的交互式命令前缀。输入：无（直接读 process.env）；输出：字符串数组。副作用：只读环境变量。
// 流程：解析 INTERACTIVE_COMMANDS 追加项 -> 解析 INTERACTIVE_EXCLUDE 排除项 -> 合并并过滤。
// 错误路径：环境变量未设置时 ?. 得到 undefined，?? [] 提供空数组；空字符串项被 filter(Boolean) 丢掉。
// 示例：INTERACTIVE_EXCLUDE="vim, top" 时，vim/top 即使在内置列表里也会被排除。
function getInteractiveCommands(): string[] {
	// ?. 可选链：只有当 INTERACTIVE_COMMANDS 不是 undefined 时才调用 split；?? 只在左侧为
	// null/undefined 时使用空数组，空字符串不会触发 ??。map 去空白，filter(Boolean) 去掉空项。
	const additional =
		process.env.INTERACTIVE_COMMANDS?.split(",")
			.map((s) => s.trim())
			.filter(Boolean) ?? [];
	// Set 提供 O(1) 的包含查询；排除项统一小写，后面用小写命令比较。?.split 后若为 undefined，
	// ?? [] 保证 map 可调用；整个表达式的结果再交给 new Set 去重。
	const excluded = new Set(process.env.INTERACTIVE_EXCLUDE?.split(",").map((s) => s.trim().toLowerCase()) ?? []);
	// 展开语法把两个数组拼成一个新数组，filter 保留未被排除的命令；返回数组是新分配，调用方修改不影响常量。
	return [...DEFAULT_INTERACTIVE_COMMANDS, ...additional].filter((cmd) => !excluded.has(cmd.toLowerCase()));
}

// 判断一条用户命令是否需要交给完整终端。输入：命令字符串；输出：true 表示交互式。
// 副作用：读取环境变量（通过 getInteractiveCommands）。错误路径：没有；空命令返回 false。
// 流程：转小写 -> 遍历命令表 -> 匹配开头或最后一个管道符之后的命令。
// 示例：isInteractiveCommand("cat a.txt | less") 为 true；isInteractiveCommand("ls -la") 为 false。
function isInteractiveCommand(command: string): boolean {
	// trim 去掉首尾空白，toLowerCase 统一大小写；只做文本比较，不解析引号或转义。
	const trimmed = command.trim().toLowerCase();
	// 每次判断都重新读取环境变量；列表不长，这样可避免模块级缓存与配置变化的同步问题。
	const commands = getInteractiveCommands();

	// for...of 依次取出数组元素，不在回调里，因此可以用 return 直接结束整个函数。
	for (const cmd of commands) {
		// 内置项也可能含大写（如 "git commit"），统一小写后比较。
		const cmdLower = cmd.toLowerCase();
		// Match at start
		// 三个条件分别对应：命令正好等于该项、后面跟空格、后面跟制表符；避免 "vimx" 误命中 "vim"。
		if (trimmed === cmdLower || trimmed.startsWith(`${cmdLower} `) || trimmed.startsWith(`${cmdLower}\t`)) {
			return true;
		}
		// Match after pipe: "cat file | less"
		// lastIndexOf 取最后一个管道符位置，简单支持 "cat file | less"；不处理带引号/转义的竖线。
		const pipeIdx = trimmed.lastIndexOf("|");
		if (pipeIdx !== -1) {
			// +1 跳过管道符本身，trim 去掉管道后空格；只检查管道后的命令部分。
			const afterPipe = trimmed.slice(pipeIdx + 1).trim();
			// 与开头匹配相同的规则，但不再检查管道后的制表符形式。
			if (afterPipe === cmdLower || afterPipe.startsWith(`${cmdLower} `)) {
				return true;
			}
		}
	}
	// 所有命令项都没命中，交回普通 bash 处理。
	return false;
}

// 扩展入口。输入：宿主注入的 ExtensionAPI；输出：无；副作用是登记 user_bash 处理器。
// 示例：加载本模块后，用户执行 `!htop` 会进入下面的处理器，而不是普通 bash 工具执行链。
export default function (pi: ExtensionAPI) {
	// user_bash 只由用户 `!`/`!!` 输入触发，模型调用 bash 工具不会走这里。handler 可以返回
	// { operations } 自定义执行后端，或返回 { result } 表示扩展已经执行完毕；此处采用后者。
	pi.on("user_bash", async (event, ctx) => {
		// event.command 已经去掉 `!`/`!!` 前缀，但仍保留用户输入的其它文字；let 因为下面可能改写它。
		let command = event.command;
		// 单独用布尔标记记录用户是否强制交互，避免把 "i " 当成命令内容后丢失意图。
		let forceInteractive = false;

		// Check for !i prefix (command comes without the leading !)
		// The prefix parsing happens before this event, so we check if command starts with "i "
		// `!i vim` 进入事件时是 "i vim"；这里识别 "i " 或 "i\t" 两种前缀形式。
		if (command.startsWith("i ") || command.startsWith("i\t")) {
			forceInteractive = true;
			// slice(2) 去掉 "i " 两个字符，trim 去掉可能的多余空白，得到真正要执行的命令。
			command = command.slice(2).trim();
		}

		// 短路或：已强制交互就不必再扫描命令表；否则按前缀/管道规则判断。
		const shouldBeInteractive = forceInteractive || isInteractiveCommand(command);
		if (!shouldBeInteractive) {
			return; // Let normal handling proceed
		}

		// No UI available (print mode, RPC, etc.)
		// ctx.mode 是 "tui" | "rpc" | "print" 等联合值；没有终端时无法暂停/恢复 TUI，直接返回失败结果。
		if (ctx.mode !== "tui") {
			// 返回 UserBashEventResult 的 { result } 分支：本扩展已经“执行”完，只是结果是错误。
			// BashResult 的 exitCode 允许 undefined，但这里明确给 1，表示失败。
			return {
				result: { output: "(interactive commands require TUI)", exitCode: 1, cancelled: false, truncated: false },
			};
		}

		// Use ctx.ui.custom() to get TUI access, then run the command
		// 泛型 <number | null> 表示 done(result) 的参数类型，也就决定 await 得到的 exitCode 类型。
		// 工厂参数依次是 tui 实例、主题、键位管理器、完成回调；这里只用到 tui 和 done。
		const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
			// Stop TUI to release terminal
			// 停止 TUI 渲染并恢复终端到可供外部程序使用的状态；不停止子进程或会话。
			tui.stop();

			// Clear screen
			// ANSI 序列 \x1b[2J 清屏，\x1b[H 把光标移到左上角；直接写 stdout 会绕过 TUI 的渲染层。
			process.stdout.write("\x1b[2J\x1b[H");

			// Run command with full terminal access
			// 优先使用用户的登录 shell；未设置 SHELL 时退回 /bin/sh。|| 对空字符串也生效。
			const shell = process.env.SHELL || "/bin/sh";
			// -c 让 shell 解释整条命令；stdio: "inherit" 把 stdin/stdout/stderr 直接接到当前终端，
			// 交互程序因此能读键盘。spawnSync 返回的 status 是退出码（被信号杀死时可能为 null）。
			const result = spawnSync(shell, ["-c", command], {
				stdio: "inherit",
				env: process.env,
			});

			// Restart TUI
			// 重新启动 TUI 并强制整体重绘，覆盖子进程留在屏幕上的内容。
			tui.start();
			tui.requestRender(true);

			// Signal completion
			// done 结束 ctx.ui.custom 的等待，把退出码作为 Promise 结果交回；每个 custom 只能完成一次。
			done(result.status);

			// Return empty component (immediately disposed since done() was called)
			// 即使已调用 done，也必须返回一个满足 Component 接口的对象；render/invalidate 都是空实现。
			return { render: () => [], invalidate: () => {} };
		});

		// Return result to prevent default bash handling
		// 三元表达式把退出码转成给模型/用户看的一行摘要；退出码 0 视为成功。
		const output =
			exitCode === 0
				? "(interactive command completed successfully)"
				: `(interactive command exited with code ${exitCode})`;

		// 返回 { result } 后宿主不会再执行默认 bash；这里没有真实输出，只报告状态。
		// exitCode ?? 1 把 null/undefined（例如被信号终止）统一成 1，避免下游拿到空值。
		return {
			result: {
				output,
				exitCode: exitCode ?? 1,
				cancelled: false,
				truncated: false,
			},
		};
	});
}
