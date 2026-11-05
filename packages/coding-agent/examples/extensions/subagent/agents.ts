/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions/subagent 的 agent 发现模块，主题是从用户级
 * 与项目级目录读取 Markdown 定义的子代理配置。
 * 上游：同目录 index.ts 的 discoverAgents(ctx.cwd, agentScope) 与 formatAgentList。
 * 下游：node:fs 读取目录/文件；getAgentDir() 定位用户级 agent 目录；CONFIG_DIR_NAME（".pi"）
 * 定位项目级目录；parseFrontmatter 解析 YAML frontmatter。
 *
 * 演示的机制：每个代理是一个 .md 文件，frontmatter 提供 name/description/tools/model，正文
 * 作为 systemPrompt。用户级目录固定为 <agent dir>/agents；项目级目录从 cwd 逐级向上查找最近的
 * .pi/agents。scope 为 "both" 时两者合并，同名项目级代理覆盖用户级。单个文件解析失败只跳过
 * 该文件，不影响同目录其他代理。
 *
 * 能力清单：
 * - AgentScope/AgentConfig/AgentDiscoveryResult：作用域、代理配置与发现结果。
 * - parseToolList(value)：兼容逗号字符串与 YAML 数组两种 tools 写法。
 * - loadAgentsFromDir(dir, source)：读取目录下所有 .md 代理。
 * - findNearestProjectAgentsDir(cwd)：向上查找项目级 agents 目录。
 * - discoverAgents(cwd, scope)：合并用户/项目代理并返回结果。
 * - formatAgentList(agents, maxItems)：生成一行代理摘要与剩余数量。
 *
 * 典型运行顺序：discoverAgents -> 读取用户目录 -> 查找项目目录 -> 合并去重 -> index.ts 按
 * 名称选择代理并启动子进程。
 *
 * 示例（真实签名）：
 *   discoverAgents("/repo", "both") // { agents: AgentConfig[], projectAgentsDir: string | null }
 *   代理文件示例 frontmatter：
 *   ---
 *   name: reviewer
 *   description: Reviews code
 *   tools: read, bash
 *   model: openai/gpt-5.2
 *   ---
 *   正文即 systemPrompt。
 *
 * 建议阅读顺序：先看类型与 parseToolList，再看 loadAgentsFromDir 的容错读取，然后看
 * findNearestProjectAgentsDir 与 discoverAgents 的合并顺序。
 *
 * 前置条件：无网络与模型调用；frontmatter 必须是合法 YAML，缺少 name/description 的文件会被
 * 静默跳过。目录遍历只向上到文件系统根，不会读取 home 之外的特殊位置。
 */

/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

// 发现范围：只读用户级、只读项目级，或两者合并。
export type AgentScope = "user" | "project" | "both";

// 一个已解析的代理；tools/model 可选，缺省时由调用方决定继承策略。
export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

// projectAgentsDir 为 null 表示没有找到项目级目录，用于日志/确认提示。
export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else (a number, a map, a nested list) yields no
 * tools rather than throwing: this runs inside agent discovery, where a single
 * bad file must not take down every other agent in the same directory.
 */
// frontmatter 的 tools 既可能是 "read, bash" 字符串，也可能是 [read, bash] 数组。
// 其他类型（数字、对象、嵌套数组）返回 undefined，而不是抛错。
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	// filter 类型谓词去掉非字符串元素；再 trim 并丢弃空串。
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

// 读取一个目录下的所有 .md 代理；任何单个文件失败都只跳过该文件。
function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	// 目录不存在是正常情况（用户可能只定义了项目级代理）。
	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		// withFileTypes 省去后续 stat；权限错误等异常直接返回空列表。
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		// 只接受 .md；其他扩展名忽略。
		if (!entry.name.endsWith(".md")) continue;
		// 允许符号链接，便于共享代理文件；目录/其他类型跳过。
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			// 单个文件不可读不影响其他代理。
			continue;
		}

		// parseFrontmatter 返回泛型 frontmatter 与正文；正文直接作为 systemPrompt。
		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

		// name 与 description 是必填字符串；缺失或类型不符则跳过。
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			// model 非字符串时返回 undefined，由调用方继承当前模型。
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

// stat 失败（不存在、权限）统一视为“不是目录”。
function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

// 从 cwd 向上逐级查找最近的 <dir>/.pi/agents；到根仍没有则返回 null。
// 只返回最近一层，不会合并祖先目录中的其他 agents 目录。
function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		// 到达文件系统根时 dirname 返回自身，用相等判断终止循环。
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

// 发现代理：根据 scope 决定读取哪些目录，并用 Map 按 name 去重。
// "both" 时先放用户级、再放项目级，因此同名项目级覆盖用户级。
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	// 不需要的范围直接给空数组，避免无谓的文件读取。
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	// set 相同 key 会覆盖旧值；插入顺序保留第一次出现的位置。
	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

// 生成一行代理列表：最多 maxItems 项，remaining 表示被省略的数量。
// 供错误消息或提示使用，不承担渲染职责。
export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
