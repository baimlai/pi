#!/usr/bin/env node

// 文件导读：统计每个 pi 会话的上下文占用、压缩次数、轮数、时长与 bash 命令，并按天/模型聚合。
// 所属：仓库根 `scripts/` 的会话分析脚本系列；与 read-tool-stats 共用 JSONL 与会话目录编码约定。
// 作用：读取会话 JSONL 中的 assistant usage、compaction 条目与工具调用，结合模型 contextWindow
//   计算最大上下文占用百分比，输出总量与按天/按模型的分布；默认 HTML，也可 --text/--json。
// 上游：手动运行 `node scripts/session-context-stats.mjs [options]`；无 npm script/CI 入口。
//   默认会话目录 `~/.pi/agent/sessions`，默认只统计 cwd 等于当前目录的会话（--all-cwds 关闭）。
// 下游：读取会话 JSONL、`packages/ai/src/models.generated.ts`（模型 contextWindow）与
//   `~/.pi/agent/models.json`（用户自定义模型覆盖）；不写任何文件，报告输出到 stdout。
// 副作用与错误：非法 --since、会话目录不存在/读取失败时由 main().catch 打印消息并以 1 退出；
//   单个 JSONL 行解析失败只计数，不中断。没有压缩或 usage 的会话相关字段保持 null。
// 能力清单：
//   - parseArgs/printHelp：CLI 选项（模型/前缀/bash 包含/cwd/since）与用法。
//   - loadContextWindows：从生成模型数据与用户配置建立 provider/model → contextWindow 映射。
//   - contextTokens：从 usage 推导一次请求的上下文 token 数。
//   - scanSessions：逐会话解析消息、压缩与 bash 命令。
//   - summarizeSessionGroup：会话级统计（均值、中位数、压缩率、超限占比）。
//   - buildSummary/buildTextReport/printHtmlReport：聚合与三种输出。
// 典型调用与预期：
//   示例 `node scripts/session-context-stats.mjs --text --model openai`；
//   打印扫描文件数、contextWindow 来源与按模型/天的统计，成功退出码 0。
// 阅读顺序：先看 loadContextWindows 与 contextTokens，再读 scanSessions 的字段累积，最后看 summarize/buildSummary。
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

// 默认扫描全部项目的会话根目录；会话子目录名由 cwd 编码而来。
const DEFAULT_SESSIONS_DIR = path.join(homedir(), ".pi/agent/sessions");
// 生成文件里有每个模型的 contextWindow；以运行时 cwd 为基准，因此需要在仓库根运行。
const MODELS_GENERATED_PATH = path.join(process.cwd(), "packages/ai/src/models.generated.ts");
// 用户配置可覆盖内置模型或添加自定义模型；文件不存在时静默跳过。
const MODELS_CONFIG_PATH = path.join(homedir(), ".pi/agent/models.json");
// 报告固定按柏林时区分天，与 read-tool-stats 保持一致。
const REPORT_TIME_ZONE = "Europe/Berlin";
// 文本条形图宽度（字符数）。
const CHART_WIDTH = 40;

// 解析 CLI 参数为选项对象；未知参数抛错，带值选项消费下一个 argv。
// 输入不含 node/脚本名；输出配置含默认值，默认 cwd 是 process.cwd()。
// 例：parseArgs(["--text","--cwd","/repo"]) → { text:true, cwd:"/repo", ... }。
function parseArgs(argv) {
	// 默认只统计当前 cwd 的会话；cwd 是值，undefined 表示不按 cwd 过滤。
	const options = { sessionsDir: DEFAULT_SESSIONS_DIR, json: false, text: false, allSessions: false, since: undefined, modelFilter: undefined, modelPrefixes: [], bashContains: [], cwd: process.cwd(), help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--text") options.text = true;
		else if (arg === "--sessions-dir") options.sessionsDir = argv[++i];
		else if (arg === "--since") options.since = argv[++i];
		// allSessions 目前只被记录，不影响扫描；真正的 cwd 过滤器由 --all-cwds 清空。
		else if (arg === "--all-sessions") options.allSessions = true;
		else if (arg === "--model") options.modelFilter = argv[++i];
		// 前缀可重复；push 保留多个条件，buildSummary 中任一枚举命中即可。
		else if (arg === "--model-prefix") options.modelPrefixes.push(argv[++i]);
		else if (arg === "--bash-contains") options.bashContains.push(argv[++i]);
		// 便捷开关：等价于同时传 --bash-contains "git commit" 与 --bash-contains "git push"。
		else if (arg === "--git-commit-or-push") options.bashContains.push("git commit", "git push");
		else if (arg === "--cwd") options.cwd = argv[++i];
		else if (arg === "--all-cwds") options.cwd = undefined;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

// 打印用法到 stdout；${...} 在模板字符串运行时替换为默认值。
function printHelp() {
	console.log(`Usage: node scripts/session-context-stats.mjs [options]

Options:
  --sessions-dir <path>  Sessions directory (default: ~/.pi/agent/sessions)
  --model <substring>    Filter provider/model by substring
  --model-prefix <p>     Include provider/model prefixes, repeatable, e.g. openai-codex/
  --bash-contains <text> Include only sessions with bash tool calls containing text, repeatable
  --git-commit-or-push   Shortcut for --bash-contains "git commit" --bash-contains "git push"
  --cwd <path>           Include only sessions whose cwd is this path (default: current cwd)
  --all-cwds             Include sessions from all cwd values
  --since <iso>          Only scan session files created at or after this ISO time
  --all-sessions         Scan all sessions (default already scans all)
  --json                 Print JSON instead of HTML report
  --text                 Print plain text instead of HTML report
  -h, --help             Show this help
`);
}

// 从会话文件名解析时间：文件名时间用 `-` 分隔时分秒，先还原 ISO 再 Date.parse。
// 解析失败返回 null；调用方会退回到条目时间或 0。
function parseSessionFileTimestamp(sessionFile) {
	const rawTimestamp = path.basename(sessionFile).split("_")[0];
	if (!rawTimestamp) return null;
	const ms = Date.parse(rawTimestamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z"));
	return Number.isFinite(ms) ? ms : null;
}

// 在固定报告时区取年月日字段；只用于按天分组，不返回小时。
function getTimeZoneParts(ms) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: REPORT_TIME_ZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(new Date(ms));
	// 丢弃 literal 分隔符，得到 {year, month, day}。
	return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

// 返回报告时区下的 `YYYY-MM-DD` 日期键。
function formatDay(ms) {
	const parts = getTimeZoneParts(ms);
	return `${parts.year}-${parts.month}-${parts.day}`;
}

// 千分位整数格式化；先四舍五入，避免小数进入 en-US 的 group 规则。
function formatInt(value) {
	return new Intl.NumberFormat("en-US").format(Math.round(value));
}

// 固定两位小数；非有限值输出 "n/a"。
function formatNumber(value) {
	return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

// 百分比保留一位小数；非有限值输出 "n/a"。
function formatPercent(value) {
	return Number.isFinite(value) ? `${value.toFixed(1)}%` : "n/a";
}

// 把百分比（0-100）映射为 40 字符条形图；先夹取到合法范围，非有限值按 0。
function bar(percent) {
	const clamped = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
	const filled = Math.round((clamped / 100) * CHART_WIDTH);
	return `${"█".repeat(filled)}${"░".repeat(CHART_WIDTH - filled)}`;
}

// 计算中位数：过滤非有限值、升序排序；空数组返回 null；偶数个取中间两数平均。
function median(values) {
	const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
	if (finite.length === 0) return null;
	const middle = Math.floor(finite.length / 2);
	return finite.length % 2 === 0 ? (finite[middle - 1] + finite[middle]) / 2 : finite[middle];
}

// 递归异步生成器：按名称顺序产出目录下所有 .jsonl 路径；读取失败向上抛错。
async function* walkJsonlFiles(dir) {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walkJsonlFiles(fullPath);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield fullPath;
	}
}

// 建立 provider/model → contextWindow 的映射，并返回实际读取到的来源路径列表。
// 两个来源：仓库内生成的 models.generated.ts（用正则扫描）与用户 models.json（JSON 解析）。
// 用户配置后读取，因此同名模型的 modelOverrides/models 会覆盖生成值。
// 两个来源都缺失时返回空映射，报告仍可运行，只是上下文百分比为 n/a。
async function loadContextWindows() {
	const windows = new Map();
	const sources = [];
	let text = "";
	try {
		text = await fs.readFile(MODELS_GENERATED_PATH, "utf8");
		sources.push(MODELS_GENERATED_PATH);
	} catch {
		// Optional in non-repo usage.
	}
	// 生成文件是 TypeScript 对象字面量，不是 JSON；用缩进模式抓 provider 块与其中的 contextWindow。
	const providerRegex = /\n\t"([^"]+)": \{([\s\S]*?\n\t)\},/g;
	let providerMatch;
	while ((providerMatch = providerRegex.exec(text)) !== null) {
		const provider = providerMatch[1];
		const body = providerMatch[2];
		// 每个 provider 块内再扫描两层缩进的 model 键及其 contextWindow 数字。
		const modelRegex = /\n\t\t"([^"]+)": \{[\s\S]*?contextWindow: (\d+),/g;
		let modelMatch;
		while ((modelMatch = modelRegex.exec(body)) !== null) {
			windows.set(`${provider}/${modelMatch[1]}`, Number(modelMatch[2]));
		}
	}

	try {
		const config = JSON.parse(await fs.readFile(MODELS_CONFIG_PATH, "utf8"));
		sources.push(MODELS_CONFIG_PATH);
		// 用户配置结构：providers[providerName].modelOverrides[modelId].contextWindow 或 .models[].contextWindow。
		const providers = config?.providers && typeof config.providers === "object" ? config.providers : {};
		for (const [providerName, provider] of Object.entries(providers)) {
			const overrides = provider?.modelOverrides && typeof provider.modelOverrides === "object" ? provider.modelOverrides : {};
			for (const [modelId, override] of Object.entries(overrides)) {
				if (typeof override?.contextWindow === "number") windows.set(`${providerName}/${modelId}`, override.contextWindow);
			}
			if (Array.isArray(provider?.models)) {
				for (const model of provider.models) {
					if (typeof model?.id === "string" && typeof model.contextWindow === "number") windows.set(`${providerName}/${model.id}`, model.contextWindow);
				}
			}
		}
	} catch {
		// Optional user config.
	}

	return { windows, sources };
}

// 从一条 assistant 消息的 usage 推导上下文 token 数。
// 优先用 totalTokens（若为正）；否则把 input/output/cacheRead/cacheWrite 相加。
// 无 usage、字段全空或结果非正时返回 null，调用方会跳过该消息。
function contextTokens(usage) {
	if (!usage || typeof usage !== "object") return null;
	const totalTokens = Number(usage.totalTokens ?? 0);
	if (Number.isFinite(totalTokens) && totalTokens > 0) return totalTokens;
	const input = Number(usage.input ?? 0);
	const output = Number(usage.output ?? 0);
	const cacheRead = Number(usage.cacheRead ?? 0);
	const cacheWrite = Number(usage.cacheWrite ?? 0);
	const value = input + output + cacheRead + cacheWrite;
	return Number.isFinite(value) && value > 0 ? value : null;
}

// 扫描会话目录并逐会话累积统计，返回 {sessions, meta}。
// sinceMs 按文件名时间过滤整个文件；cwdFilter 在解析完后按 session 条目里的 cwd 过滤。
// contextWindows 提供模型窗口；缺失时百分比字段为 null。只读文件。
async function scanSessions(sessionsDir, sinceMs, contextWindows, cwdFilter) {
	const windows = contextWindows.windows;
	const sessions = [];
	const meta = { sessionsDir, sessionFilesScanned: 0, sessionFilesIncluded: 0, sessionFilesSkippedOlderThanSince: 0, malformedLines: 0 };
	for await (const sessionFile of walkJsonlFiles(sessionsDir)) {
		meta.sessionFilesScanned++;
		// 文件名时间不可解析时返回 null，此类文件不会被 since 跳过。
		const fileTimestampMs = parseSessionFileTimestamp(sessionFile);
		if (sinceMs !== null && fileTimestampMs !== null && fileTimestampMs < sinceMs) {
			meta.sessionFilesSkippedOlderThanSince++;
			continue;
		}
		meta.sessionFilesIncluded++;
		// 一个 session 对象收集该文件的全部指标；start/end 先以文件名为初值，再由条目时间修正。
		const session = {
			sessionFile,
			cwd: null,
			startMs: fileTimestampMs ?? 0,
			endMs: fileTimestampMs ?? 0,
			providerModel: "[unknown]/[unknown]",
			assistantMessages: 0,
			userMessages: 0,
			compactions: 0,
			seenCompaction: false,
			maxPromptTokens: null,
			preFirstCompactionTokens: null,
			maxContextUsagePercent: null,
			preFirstCompactionUsagePercent: null,
			contextWindow: null,
			bashCommands: [],
			over80: false,
			over90: false,
			over100: false,
		};
		const input = createReadStream(sessionFile, { encoding: "utf8" });
		const rl = createInterface({ input, crlfDelay: Infinity });
		for await (const line of rl) {
			if (!line.trim()) continue;
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				meta.malformedLines++;
				continue;
			}
			// session 条目携带启动时的 cwd，用于 --cwd 过滤和报告分组。
			if (entry.type === "session" && typeof entry.cwd === "string") session.cwd = entry.cwd;
			// 条目时间戳参与会话时长；无法解析的条目不会改变起止时间。
			const entryMs = Date.parse(entry.timestamp ?? "");
			if (Number.isFinite(entryMs)) {
				if (!session.startMs || entryMs < session.startMs) session.startMs = entryMs;
				if (!session.endMs || entryMs > session.endMs) session.endMs = entryMs;
			}
			// compaction 条目表示上下文被压缩；tokensBefore 是压缩前 token 数，可作为上下文峰值。
			if (entry.type === "compaction") {
				session.compactions++;
				if (typeof entry.tokensBefore === "number") {
					session.maxPromptTokens = Math.max(session.maxPromptTokens ?? 0, entry.tokensBefore);
					// 只记录第一次压缩前的值，用于“首次压缩时上下文占比”。
					if (!session.seenCompaction) session.preFirstCompactionTokens = entry.tokensBefore;
				}
				session.seenCompaction = true;
				// compaction 不是 message，处理完直接进入下一行。
				continue;
			}
			// 其他非消息条目不影响本报告的统计。
			if (entry.type !== "message" || !entry.message) continue;
			const message = entry.message;
			// 从 assistant 的 toolCall 中提取 bash 命令原文，供 --bash-contains 过滤。
			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const block of message.content) {
					if (block?.type !== "toolCall" || block.name !== "bash") continue;
					const command = typeof block.arguments?.command === "string" ? block.arguments.command : "";
					if (command) session.bashCommands.push(command);
				}
			}
			if (message.role === "user") session.userMessages++;
			// 以下统计只针对 assistant 消息；user 计数后即返回循环顶部。
			if (message.role !== "assistant") continue;
			session.assistantMessages++;
			const provider = typeof message.provider === "string" ? message.provider : "[unknown]";
			const model = typeof message.model === "string" ? message.model : "[unknown]";
			// 会话的 providerModel 取最后一条 assistant 消息；同一会话中途换模型时以最后一次为准。
			session.providerModel = `${provider}/${model}`;
			const contextWindow = windows.get(session.providerModel) ?? null;
			if (contextWindow !== null) session.contextWindow = contextWindow;
			const tokens = contextTokens(message.usage);
			if (tokens !== null) {
				session.maxPromptTokens = Math.max(session.maxPromptTokens ?? 0, tokens);
				// 尚未发生压缩时，持续更新“首次压缩前”的峰值；压缩后不再覆盖。
				if (!session.seenCompaction) session.preFirstCompactionTokens = tokens;
			}
		}
		// 只有同时知道峰值 token 与窗口大小才能算占比；否则保持 null。
		if (session.maxPromptTokens !== null && session.contextWindow !== null) {
			session.maxContextUsagePercent = (session.maxPromptTokens / session.contextWindow) * 100;
			// 三个阈值标志供汇总时直接计数，避免在 summarize 里重复比较。
			session.over80 = session.maxContextUsagePercent >= 80;
			session.over90 = session.maxContextUsagePercent >= 90;
			session.over100 = session.maxContextUsagePercent >= 100;
		}
		if (session.preFirstCompactionTokens !== null && session.contextWindow !== null) {
			session.preFirstCompactionUsagePercent = (session.preFirstCompactionTokens / session.contextWindow) * 100;
		}
		// cwdFilter 为 undefined 时全部保留；否则比较 resolve 后的绝对路径（空 cwd 解析为当前目录）。
		if (!cwdFilter || path.resolve(session.cwd ?? "") === cwdFilter) sessions.push(session);
	}
	return { sessions, meta };
}

// 通用分组：keyFn 决定分组键，分组后交给 summarizeSessionGroup；结果按键升序。
function summarizeGroups(sessions, keyFn) {
	const groups = new Map();
	for (const session of sessions) {
		const key = keyFn(session);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(session);
	}
	return [...groups.entries()].map(([key, group]) => summarizeSessionGroup(key, group)).sort((a, b) => a.key.localeCompare(b.key));
}

// 把一个会话组汇总成一行统计：会话数、均值、中位数、压缩与阈值超限计数。
// 各指标只用“有该字段”的子集做均值，避免 null 被当作 0 拉低结果；
// group 为空时多数比例为 NaN，调用方只对非空组使用。
function summarizeSessionGroup(key, group) {
	// 三个过滤子集分别对应“已知上下文占比”“已知峰值 token”“已知首次压缩前占比”。
	const withUsage = group.filter((session) => session.maxContextUsagePercent !== null);
	const withTokens = group.filter((session) => session.maxPromptTokens !== null);
	const withPreCompactionUsage = group.filter((session) => session.preFirstCompactionUsagePercent !== null);
	const compactions = group.filter((session) => session.compactions > 0).length;
	const totalCompactions = group.reduce((sum, session) => sum + session.compactions, 0);
	// 去重后排序，得到该组涉及的所有 contextWindow 大小（通常只有一两个）。
	const contextWindows = [...new Set(group.map((session) => session.contextWindow).filter((value) => value !== null))].sort((a, b) => a - b);
	return {
		key,
		sessions: group.length,
		contextWindows,
		assistantMessages: group.reduce((sum, session) => sum + session.assistantMessages, 0),
		avgTurns: group.reduce((sum, session) => sum + session.userMessages, 0) / group.length,
		// 时长按毫秒差 / 60000 转分钟；负值（时间倒序/同时间）夹到 0。
		avgDurationMinutes: group.reduce((sum, session) => sum + Math.max(0, session.endMs - session.startMs) / 60000, 0) / group.length,
		avgMaxPromptTokens: withTokens.length === 0 ? null : withTokens.reduce((sum, session) => sum + (session.maxPromptTokens ?? 0), 0) / withTokens.length,
		medianMaxPromptTokens: median(withTokens.map((session) => session.maxPromptTokens)),
		avgMaxContextUsagePercent: withUsage.length === 0 ? null : withUsage.reduce((sum, session) => sum + (session.maxContextUsagePercent ?? 0), 0) / withUsage.length,
		medianMaxContextUsagePercent: median(withUsage.map((session) => session.maxContextUsagePercent)),
		medianPreFirstCompactionUsagePercent: median(withPreCompactionUsage.map((session) => session.preFirstCompactionUsagePercent)),
		contextKnownSessions: withUsage.length,
		sessionsWithCompaction: compactions,
		totalCompactions,
		// 压缩率是“发生过至少一次压缩的会话”占比，不是压缩次数占比。
		compactionRate: (compactions / group.length) * 100,
		over80: group.filter((session) => session.over80).length,
		over90: group.filter((session) => session.over90).length,
		over100: group.filter((session) => session.over100).length,
	};
}

// 应用模型子串/前缀与 bash 内容过滤，再生成总量、按天、按模型、按模型再按天的视图。
// 输入 sessions 是 scanSessions 的结果；meta 会附加 contextWindowSources 与 timezone。
// 过滤全部在内存中完成，不重新读文件。
function buildSummary(sessions, meta, options) {
	// 过滤词统一小写；模型过滤是包含匹配，前缀过滤要求 startsWith 任一前缀。
	const lowerPrefixes = options.modelPrefixes.map((prefix) => prefix.toLowerCase());
	const bashContains = options.bashContains.map((text) => text.toLowerCase());
	const filtered = sessions.filter((session) => {
		const providerModel = session.providerModel.toLowerCase();
		if (options.modelFilter && !providerModel.includes(options.modelFilter.toLowerCase())) return false;
		if (lowerPrefixes.length > 0 && !lowerPrefixes.some((prefix) => providerModel.startsWith(prefix))) return false;
		if (bashContains.length > 0) {
			// 任意一个 bash 命令包含任意一个过滤词即保留该会话。
			const commands = session.bashCommands.map((command) => command.toLowerCase());
			if (!bashContains.some((text) => commands.some((command) => command.includes(text)))) return false;
		}
		return true;
	});
	return {
		// cwd 输出为绝对路径，便于复现；未指定时为 null。
		filters: { model: options.modelFilter ?? null, modelPrefixes: options.modelPrefixes, bashContains: options.bashContains, cwd: options.cwd ? path.resolve(options.cwd) : null },
		scan: { ...meta, timezone: REPORT_TIME_ZONE },
		totals: summarizeSessionGroup("total", filtered),
		byDay: summarizeGroups(filtered, (session) => formatDay(session.startMs)),
		byModel: summarizeGroups(filtered, (session) => session.providerModel).sort((a, b) => b.sessions - a.sessions || a.key.localeCompare(b.key)),
		// byModelDay 在按模型汇总之外再为每个模型计算按天分布；先按会话数降序，再按键升序。
		byModelDay: summarizeGroups(filtered, (session) => session.providerModel).sort((a, b) => b.sessions - a.sessions || a.key.localeCompare(b.key)).map((model) => ({
			...model,
			byDay: summarizeGroups(
				filtered.filter((session) => session.providerModel === model.key),
				(session) => formatDay(session.startMs)
			),
		})),
	};
}

// 把一个分组渲染成单行文本；indent 允许在“按模型再按天”视图中缩进。
// 数字用 padStart 对齐；null 指标显示 n/a；末尾条形图使用最大上下文占比的中位数。
function lineForGroup(group, indent = "  ") {
	return `${indent}${group.key} sessions=${formatInt(group.sessions).padStart(4)} avgTurns=${formatNumber(group.avgTurns).padStart(5)} avgMin=${formatNumber(group.avgDurationMinutes).padStart(6)} avgMaxTok=${group.avgMaxPromptTokens === null ? "n/a" : formatInt(group.avgMaxPromptTokens).padStart(7)} medMaxCtx=${group.medianMaxContextUsagePercent === null ? "n/a" : formatPercent(group.medianMaxContextUsagePercent).padStart(6)} medPreCompactCtx=${group.medianPreFirstCompactionUsagePercent === null ? "n/a" : formatPercent(group.medianPreFirstCompactionUsagePercent).padStart(6)} avgCtx=${group.avgMaxContextUsagePercent === null ? "n/a" : formatPercent(group.avgMaxContextUsagePercent).padStart(6)} compact=${formatPercent(group.compactionRate).padStart(6)} over90=${formatInt(group.over90).padStart(3)} ${bar(group.medianMaxContextUsagePercent ?? 0)}`;
}

// 把 summary 渲染为纯文本报告（也是 HTML 页面的内容来源）。
// 包含扫描信息、过滤条件、指标说明，以及总计/按天/按模型/按模型再按天的表格。
function buildTextReport(summary) {
	const lines = [];
	lines.push(`Scanned ${formatInt(summary.scan.sessionFilesIncluded)} session files in ${summary.scan.sessionsDir}`);
	lines.push(`Report timezone: ${summary.scan.timezone} (CET/CEST)`);
	// contextWindowSources 是 main 在调用前注入的数组；为空说明没有找到模型窗口数据。
	lines.push(`Context window sources: ${summary.scan.contextWindowSources.join(", ") || "none"}`);
	if (summary.filters.model) lines.push(`Filters: model contains "${summary.filters.model}"`);
	if (summary.filters.modelPrefixes.length > 0) lines.push(`Filters: model prefixes = ${summary.filters.modelPrefixes.join(", ")}`);
	if (summary.filters.bashContains.length > 0) lines.push(`Filters: bash contains any of = ${summary.filters.bashContains.join(", ")}`);
	if (summary.filters.cwd) lines.push(`Filters: cwd = ${summary.filters.cwd}`);
	// 固定说明文本，解释 token 与百分比的计算口径，避免读者误解。
	lines.push("Context usage parses full session JSONL files. max context uses max assistant usage.totalTokens per session, falling back to input + output + cacheRead + cacheWrite, plus compaction tokensBefore. medPreCompactCtx uses the last assistant usage before the first compaction, or the first compaction tokensBefore when present, divided by model contextWindow from packages/ai/src/models.generated.ts when known.");
	lines.push("");
	lines.push("Totals");
	lines.push(lineForGroup(summary.totals));
	lines.push("");
	lines.push("By day");
	for (const group of summary.byDay) lines.push(lineForGroup(group));
	lines.push("");
	lines.push("By model");
	for (const group of summary.byModel) lines.push(lineForGroup(group));
	lines.push("");
	lines.push("By model, then by day");
	for (const model of summary.byModelDay) {
		lines.push("");
		// 同一模型可能配置了多个窗口；空数组显示 unknown。
		const contextWindowLabel = model.contextWindows.length === 0 ? "unknown" : model.contextWindows.map((value) => formatInt(value)).join(", ");
		lines.push(`${model.key} contextWindow=${contextWindowLabel}`);
		lines.push(lineForGroup(model, "  total "));
		for (const group of model.byDay) lines.push(lineForGroup(group, "  "));
	}
	// 仅在有解析失败时追加提示；正常情况下报告保持简洁。
	if (summary.scan.malformedLines > 0) {
		lines.push("");
		lines.push(`Malformed lines skipped: ${formatInt(summary.scan.malformedLines)}`);
	}
	return `${lines.join("\n")}\n`;
}

// HTML 转义，顺序为先 & 后 <>，防止已转义实体被二次处理。
function escapeHtml(text) {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// 输出最小 HTML 页面：整段纯文本报告放进 <pre>，只引入内联样式。
function printHtmlReport(summary) {
	// ${escapeHtml(buildTextReport(summary))} 是模板中唯一动态内容。
	console.log(`<!doctype html>
<meta charset="utf-8">
<title>Session context stats</title>
<style>
body { margin: 24px; background: #fff; color: #111; }
pre { font: 13px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
</style>
<pre>${escapeHtml(buildTextReport(summary))}</pre>`);
}

// CLI 入口：解析参数 → 校验 since → 加载 contextWindow 映射 → 扫描 → 汇总 → 选择输出格式。
// --json 输出完整 summary；--text 输出文本；默认 HTML。--help 正常返回。
// 会话目录不存在时 scanSessions 的 readdir 抛错，由 catch 转为退出码 1。
async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}
	// Date.parse 失败得到 NaN；显式传入非法 --since 时拒绝运行，而不是静默忽略过滤。
	const sinceMs = options.since ? Date.parse(options.since) : null;
	if (options.since && !Number.isFinite(sinceMs)) throw new Error(`Invalid --since value: ${options.since}`);
	const contextWindows = await loadContextWindows();
	// cwdFilter 为 undefined 表示不过滤（--all-cwds）；否则统一成绝对路径比较。
	const cwdFilter = options.cwd ? path.resolve(options.cwd) : undefined;
	const { sessions, meta } = await scanSessions(path.resolve(options.sessionsDir), sinceMs, contextWindows, cwdFilter);
	// 把 contextWindow 来源附加到 meta，供 buildTextReport 显示数据可信度。
	const summary = buildSummary(sessions, { ...meta, contextWindowSources: contextWindows.sources }, options);
	if (options.json) console.log(JSON.stringify(summary, null, 2));
	else if (options.text) console.log(buildTextReport(summary));
	else printHtmlReport(summary);
}

// 顶层错误处理：打印 message 并以 1 退出；不输出堆栈。
main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
