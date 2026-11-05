// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；复制到 ~/.pi/agent/extensions/ 或项目 .pi/extensions/ 后加载。
// 演示内容：session_start 时递归扫描项目 .claude/rules/ 下的 Markdown 文件，before_agent_start 时把相对路径清单追加到系统提示，让模型按需用 read 工具读取规则。
// 上下游：上游是宿主生命周期事件 session_start/before_agent_start；下游只用 node:fs/node:path 读取目录，不读取规则内容、不调用模型。返回的 systemPrompt 只影响本次 agent run，不写配置文件。
// 能力清单：
// - findMarkdownFiles(dir, basePath="")：递归收集 .md 普通文件，返回相对路径数组；目录不存在返回空数组。
// - 默认导出 claudeRulesExtension(pi: ExtensionAPI)：保存 ruleFiles/rulesDir，注册扫描与提示追加两个回调。
// 典型运行顺序：创建 .claude/rules/testing.md -> 启动会话 -> session_start 扫描并通知数量 -> 每次 agent 开始前把清单追加到系统提示 -> 模型 read 具体规则文件。
// 示例（真实签名）：
//   .claude/rules/testing.md
//   .claude/rules/backend/api.md
//   // ruleFiles 为 ["testing.md", "backend/api.md"]，提示中以 "- " 开头的相对路径列出
// 阅读顺序：先看 findMarkdownFiles 的递归与过滤，再看 session_start 保存状态，最后看 before_agent_start 的提示拼接。
// 前置与副作用：规则目录不存在或没有 .md 时静默（不通知）；扩展只读目录，不读文件内容；权限错误会让 readdirSync 抛出，未捕获。目录顺序由文件系统决定，提示清单可能不按字母排序；符号链接目录/文件会被 isDirectory()/isFile() 排除。规则清单会随每次 agent run 重新拼接到宿主提示后，扩展加载多次可能重复追加。
/**
 * Claude Rules Extension
 *
 * Scans the project's .claude/rules/ folder for rule files and lists them
 * in the system prompt. The agent can then use the read tool to load
 * specific rules when needed.
 *
 * Best practices for .claude/rules/:
 * - Keep rules focused: Each file should cover one topic (e.g., testing.md, api-design.md)
 * - Use descriptive filenames: The filename should indicate what the rules cover
 * - Use conditional rules sparingly: Only add paths frontmatter when rules truly apply to specific file types
 * - Organize with subdirectories: Group related rules (e.g., frontend/, backend/)
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Create .claude/rules/ folder in your project root
 * 3. Add .md files with your rules
 */

// 使用 node: 前缀引用内置模块，避免被解析成同名 npm 包；fs/path 只用于读目录和拼路径。
import * as fs from "node:fs";
import * as path from "node:path";
// import type 只引入类型，编译后擦除；ExtensionAPI 用来标注扩展入口。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Recursively find all .md files in a directory
 */
// 递归收集 dir 下所有 .md 文件，返回相对于 dir 的路径；basePath 是当前层相对前缀，默认空串。
// 输入 dir/basePath，输出 string[]，只读目录、无其他副作用。目录不存在返回空数组；权限错误会从 readdirSync 抛出。
// 示例：findMarkdownFiles("/repo/.claude/rules") -> ["testing.md", "backend/api.md"]（顺序取决于 readdir）。
function findMarkdownFiles(dir: string, basePath: string = ""): string[] {
	// 每次递归调用都创建自己的结果数组；返回后由上层展开合并。
	const results: string[] = [];

	// existsSync 对不存在的路径返回 false；它可能把部分权限问题也当成 false，且不会抛 ENOENT。
	if (!fs.existsSync(dir)) {
		return results;
	}

	// withFileTypes:true 让每个元素是 Dirent，可直接判断目录/文件；readdirSync 仍会抛权限或 I/O 错误。
	const entries = fs.readdirSync(dir, { withFileTypes: true });

	// 遍历顺序由文件系统决定，通常不排序，因此最终提示中的规则顺序可能变化。
	for (const entry of entries) {
		// 相对路径统一用 "/" 连接；这是 URL 风格的展示路径，不是 path.join 的平台相关分隔符。
		const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

		// 目录才递归；符号链接目录的 isDirectory() 为 false，因此不会跟随链接。
		if (entry.isDirectory()) {
			// 递归传入新的绝对目录和当前相对前缀；展开运算符把子数组元素逐个 push 到 results。
			results.push(...findMarkdownFiles(path.join(dir, entry.name), relativePath));
			// 只匹配普通文件且扩展名小写 .md；.MD 和符号链接文件会跳过。
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			// 保存相对路径而不是绝对路径，提示更短且不暴露本机目录结构。
			results.push(relativePath);
		}
	}

	return results;
}

// 扩展入口：保存扫描结果并注册两个事件；加载时不访问磁盘。
export default function claudeRulesExtension(pi: ExtensionAPI) {
	// 空数组表示尚未扫描或没有规则；before_agent_start 用它决定是否修改提示。
	let ruleFiles: string[] = [];
	// rulesDir 只用于记录扫描目录；真正生成清单的是相对路径。
	let rulesDir: string = "";

	// session_start 在启动、恢复、分叉、/new 后都会触发；每次重新扫描，避免沿用旧目录。
	// Scan for rules on session start
	pi.on("session_start", async (_event, ctx) => {
		// path.join(ctx.cwd, ".claude", "rules") 生成绝对目录；ctx.cwd 是会话工作目录，不是扩展文件所在目录。
		rulesDir = path.join(ctx.cwd, ".claude", "rules");
		// 同步递归扫描；规则很多时会阻塞事件循环，示例未做异步或缓存。
		ruleFiles = findMarkdownFiles(rulesDir);

		// 只有找到文件才通知；没有目录/没有 .md 时静默，避免每次启动都打扰。
		if (ruleFiles.length > 0) {
			// 通知只给数量，不列文件名；具体清单在系统提示中交给模型。
			ctx.ui.notify(`Found ${ruleFiles.length} rule(s) in .claude/rules/`, "info");
		}
	});

	// before_agent_start 每次 agent run 前触发；返回对象会参与本次 run 的系统提示组装。
	// Append available rules to system prompt
	pi.on("before_agent_start", async (event) => {
		// 没有规则时返回 undefined，表示不修改系统提示；不是返回空对象。
		if (ruleFiles.length === 0) {
			return;
		}

		// map 给每个相对路径加 "- " 前缀，join 成多行文本；没有排序或转义。
		const rulesList = ruleFiles.map((f) => `- .claude/rules/${f}`).join("\n");

		// 返回新的完整 systemPrompt：event.systemPrompt 是宿主已组装的提示，这里在其后追加规则区块；只返回该字段，其他字段由宿主保留默认。
		// 下方模板字符串从空行和 Markdown 标题开始，并在运行时插入 rulesList；模板内容保持原样，不能在其中加注释。
		return {
			systemPrompt:
				event.systemPrompt +
				`

## Project Rules

The following project rules are available in .claude/rules/:

${rulesList}

When working on tasks related to these rules, use the read tool to load the relevant rule files for guidance.
`,
		};
	});
}
