/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions/plan-mode 的辅助模块，主题是计划模式的
 * 纯函数：bash 白名单判定、计划步骤提取与 [DONE:n] 进度标记。
 * 上游：同目录 index.ts 在 tool_call 里调用 isSafeCommand，在 agent_end/session_start 里调用
 * extractTodoItems 与 markCompletedSteps。
 * 下游：不读写文件、不调用扩展 API，只做字符串/正则处理，因此可以直接单元测试。
 *
 * 演示的机制：安全命令判定采用“双重条件”：必须命中 SAFE_PATTERNS 的前缀白名单，且不能命中
 * DESTRUCTIVE_PATTERNS 的破坏性模式。正则都是启发式，不是沙箱；复杂 shell 语法（管道、
 * 子命令、变量展开）可能绕过或误伤。计划提取只识别 “Plan:” 标题后的编号列表，并清理
 * Markdown 标记、常见动词前缀与过长文本。
 *
 * 能力清单：
 * - DESTRUCTIVE_PATTERNS/SAFE_PATTERNS：破坏性与只读命令的正则列表。
 * - isSafeCommand(command)：同时满足“非破坏性”和“命中安全前缀”才返回 true。
 * - TodoItem：步骤号、文本与完成状态。
 * - cleanStepText(text)：去 Markdown、去动词前缀、压缩空白、截断到 50 字符。
 * - extractTodoItems(message)：从 Plan: 段落提取编号步骤。
 * - extractDoneSteps(message)：提取所有 [DONE:n] 编号。
 * - markCompletedSteps(text, items)：把编号对应步骤标记为完成，返回标记数量。
 *
 * 典型运行顺序：计划模式拦截 bash -> isSafeCommand 判定 -> 模型生成 Plan: 列表 ->
 * extractTodoItems 建立待办 -> 执行阶段回复含 [DONE:n] -> markCompletedSteps 更新进度。
 *
 * 示例（真实签名）：
 *   isSafeCommand("git status")            // true：命中 git status 白名单
 *   isSafeCommand("rm -rf build")          // false：命中 rm 破坏性模式
 *   extractDoneSteps("done [DONE:2] and [DONE:5]") // [2, 5]
 *
 * 建议阅读顺序：先看两组正则与 isSafeCommand，再看 cleanStepText/extractTodoItems，最后看
 * extractDoneSteps/markCompletedSteps。
 *
 * 前置条件：无外部依赖；正则行为与大小写、命令开头空白相关，修改时需同步测试 index.ts 的
 * 拦截路径。
 */

/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */

// Destructive commands blocked in plan mode
// 这些模式在整个命令字符串中搜索，不要求出现在开头；`echo hi && rm x` 也会命中 rm。
// 注意：重定向正则允许 `>`（但不是 `>>`），因此单纯写文件也会被拦截。
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Safe read-only commands allowed in plan mode
// 安全模式都锚定在命令开头（^\\s*），因此 `cd dir && ls` 这类复合命令不会命中 ls 白名单；
// 需要复合执行时可拆成多条命令或先退出计划模式。
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

// 纯判定：先看是否命中任一破坏性模式，再看是否命中任一安全前缀。
// 两个条件同时满足才放行，因此“安全但不在白名单”的命令（如自定义脚本）也会被拒绝。
export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

// 一个计划步骤；step 从 1 开始，与 [DONE:n] 的 n 对应。
export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

// 清理步骤文本：去掉 Markdown 粗体/斜体/行内代码、常见动词前缀与多余空白。
export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
		.replace(/`([^`]+)`/g, "$1") // Remove code
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	// 首字母大写；空串时跳过，避免 charAt(0) 返回空。
	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	// 超过 50 字符时截断到 47 再加省略号，保持总长 50。
	if (cleaned.length > 50) {
		cleaned = `${cleaned.slice(0, 47)}...`;
	}
	return cleaned;
}

// 从助手消息中提取 “Plan:” 标题之后的编号列表。
export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	// 标题允许带 Markdown 粗体标记；\s*\n 要求标题后换行。
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	// 只扫描标题之后的文本，避免把前面的编号列表也算进来。
	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	// 行首编号 + . 或 ) + 空白 + 可选粗体；gm 让 ^ 匹配每一行。
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		// 去掉尾部粗体标记与空白；match[2] 是捕获的步骤文本。
		const text = match[2]
			.trim()
			.replace(/\*{1,2}$/, "")
			.trim();
		// 过滤过短、代码块开头、路径开头、列表符号开头的行。
		if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			const cleaned = cleanStepText(text);
			// 清理后仍太短则丢弃；步骤号由数组长度重新编号，而不是用原始编号。
			if (cleaned.length > 3) {
				items.push({ step: items.length + 1, text: cleaned, completed: false });
			}
		}
	}
	return items;
}

// 提取所有 [DONE:n] 标记（大小写不敏感），返回数字数组。
export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		// 捕获组只含数字，Number 结果总是有限；保留检查以表达意图。
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

// 把文本中标记的步骤设为完成；返回标记数量而不是新完成数量（重复标记会重复计数）。
export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		// 找不到对应步骤时静默忽略，可能是旧计划或模型写错的编号。
		const item = items.find((t) => t.step === step);
		if (item) item.completed = true;
	}
	return doneSteps.length;
}
