#!/usr/bin/env node

// 文件导读：统计 pi 会话中 `read` 工具调用的“整文件读取 vs 局部读取”比例，并生成趋势报告。
// 所属：仓库根 `scripts/` 的会话分析脚本系列；不是构建或发布链的一部分。
// 作用：遍历会话目录下的所有 .jsonl，找出 assistant 消息里的 `read` toolCall，按 provider/model、
//   时间桶（天/周）与时点聚合；默认输出可直接浏览的 HTML，也可输出纯文本或 JSON。
// 上游：手动运行 `node scripts/read-tool-stats.mjs [options]`；没有 npm script 或 CI 入口。
//   默认扫描 `~/.pi/agent/sessions`，可用 `--sessions-dir` 覆盖。
// 下游：只读取本地会话 JSONL 与 `--auto-since-path` 指定文件的 stat；不写任何文件，报告打印到 stdout。
//   数据格式依赖 coding-agent 的会话条目：`{type:"message", message:{role, content:[{type:"toolCall", name:"read", arguments}]}}`。
// 副作用与错误：无效参数、目录不存在、`--since` 非法时由 main 的 catch 打印错误并以 1 退出；
//   个别 JSONL 行解析失败只计入 malformedLines，不中断。
// 能力清单：
//   - parseArgs/printHelp：解析 CLI 选项并打印用法。
//   - parseSessionFileTimestamp：从会话文件名解析创建时间。
//   - walkJsonlFiles：递归枚举 .jsonl。
//   - classifyRead：判断一次 read 是 full 还是 partial（带 offset/limit）。
//   - summarizeGroups/summarizeNormalizedTimeBucketsByKey/buildSummary：按维度聚合。
//   - printHumanReport/printHtmlReport：文本与 HTML 输出；buildHumanReport 捕获 console.log 复用文本渲染。
//   - scanSessions/applyFilters/main：扫描、过滤与入口。
// 典型调用与预期：
//   示例 `node scripts/read-tool-stats.mjs --text --since 2026-01-01T00:00:00Z`；
//   打印扫描文件数、full/partial 比例与按周/时段的分布，进程成功退出码 0。
// 阅读顺序：先看选项与时间工具，再读 summarize* 的聚合形状，最后看 scanSessions 如何从 JSONL 产生 record。
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

// 默认扫描 pi 自己的会话根目录；每个项目的会话在子目录中。
const DEFAULT_SESSIONS_DIR = path.join(homedir(), ".pi/agent/sessions");
// 自动 since 过滤使用该文件的 birthtime；默认是当前仓库的 read 工具源码，
// 意图是“只看 read 工具最近一次被修改之后的会话”。
const DEFAULT_ACTIVE_READ_TOOL_PATH = path.join(process.cwd(), "packages/coding-agent/src/core/tools/read.ts");
// examples 数组默认保留前 20 条原始 read 记录。
const DEFAULT_TOP = 20;
// 文本条形图总宽度（字符数）。
const CHART_WIDTH = 40;
// 报告固定按 Europe/Berlin 时区分桶，避免运行机器时区不同导致趋势图变化。
const REPORT_TIME_ZONE = "Europe/Berlin";

// 把命令行参数解析成选项对象；未知参数、非法数字或非法 --bucket 直接抛错。
// 输入 argv 是不含 node 与脚本名的参数数组；输出为带默认值的配置对象，不做 I/O。
// 例：parseArgs(["--text","--top","5"]) → { text:true, top:5, ...其余默认值 }。
function parseArgs(argv) {
	// 所有选项先给默认值；后续分支只覆盖出现的选项。
	const options = {
		sessionsDir: DEFAULT_SESSIONS_DIR,
		json: false,
		text: false,
		includeRecords: false,
		modelFilter: undefined,
		top: DEFAULT_TOP,
		help: false,
		allSessions: false,
		since: undefined,
		autoSincePath: DEFAULT_ACTIVE_READ_TOOL_PATH,
		bucket: "week",
	};

	// 手写循环而不是解析库：每个带值选项都用 ++i 消费下一个参数。
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--text") options.text = true;
		else if (arg === "--include-records") options.includeRecords = true;
		else if (arg === "--model") options.modelFilter = argv[++i];
		else if (arg === "--top") {
			// 缺失值用空字符串参与 parseInt，得到 NaN 后走同一条错误路径。
			const value = Number.parseInt(argv[++i] ?? "", 10);
			if (!Number.isFinite(value) || value <= 0) throw new Error("--top must be a positive integer");
			options.top = value;
		} else if (arg === "--sessions-dir") options.sessionsDir = argv[++i];
		else if (arg === "--all-sessions") options.allSessions = true;
		else if (arg === "--since") options.since = argv[++i];
		else if (arg === "--auto-since-path") options.autoSincePath = argv[++i];
		else if (arg === "--bucket") {
			// 只允许 day/week；其他值立即失败，避免后面生成未知格式的桶键。
			const value = argv[++i];
			if (value !== "day" && value !== "week") throw new Error("--bucket must be day or week");
			options.bucket = value;
		} else throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

// 打印 CLI 用法到 stdout；纯输出，不校验其他参数。
function printHelp() {
	// 一个多行模板字符串；其中 ${DEFAULT_TOP} 在运行时替换为默认条数。
	console.log(`Usage: node scripts/read-tool-stats.mjs [options]

Options:
  --sessions-dir <path>  Sessions directory (default: ~/.pi/agent/sessions)
  --model <substring>    Filter provider/model by substring
  --top <n>              Number of examples to show (default: ${DEFAULT_TOP})
  --since <iso>          Only scan session files created at or after this ISO time
  --all-sessions         Disable the automatic since filter
  --auto-since-path <p>  Use birth time of this file for the automatic since filter
  --bucket <day|week>    Time bucket for trend chart (default: week)
  --json                 Print JSON summary instead of HTML report
  --text                 Print plain text report instead of HTML
  --include-records      Include raw records in JSON output
  -h, --help             Show this help
`);
}

// 从会话文件名解析创建时间。文件名形如 `2026-01-02T03-04-05-678Z_<id>.jsonl`：
// 时间部分用 `-` 分隔时分秒，需要先还原成 ISO 的 `:` 与毫秒点号再 Date.parse。
// 无法解析或时间非法时返回 null（调用方把它当作未知时间，而不是 0）。
function parseSessionFileTimestamp(sessionFile) {
	const base = path.basename(sessionFile);
	const rawTimestamp = base.split("_")[0];
	if (!rawTimestamp) return null;
	// 正则末尾锚定 Z，只转换文件名开头的这种精确格式；replace 无匹配时返回原串。
	const isoTimestamp = rawTimestamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
	const ms = Date.parse(isoTimestamp);
	return Number.isFinite(ms) ? ms : null;
}

// 把毫秒时间戳格式化为 UTC ISO 字符串；仅用于报告中的 since 说明。
function formatIso(ms) {
	return new Date(ms).toISOString();
}

// 用 Intl 在固定时区（Europe/Berlin）取出年月日、小时与星期，返回字符串字段对象。
// 这样跨夏令时/时区运行也能得到一致的报告分桶；非法 ms 会得到 NaN 字段，调用方一般已先过滤。
function getTimeZoneParts(ms) {
	// en-CA 的日期格式天然是 YYYY-MM-DD；hourCycle h23 避免出现 24 点。
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: REPORT_TIME_ZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hourCycle: "h23",
		weekday: "short",
	}).formatToParts(new Date(ms));
	// formatToParts 返回带 type 的片段；去掉分隔符文字，再转成普通对象。
	return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

// 返回报告时区下的 `YYYY-MM-DD` 日期键。
function formatDay(ms) {
	const parts = getTimeZoneParts(ms);
	return `${parts.year}-${parts.month}-${parts.day}`;
}

// 计算报告时区中该时间所在周的周一（以 UTC 毫秒近似本地午夜）。
// 注意：用 Date.UTC 构造“本地日期”再做减法，跨夏令时的周边界会有一小时偏差；
// 这是报告分桶的既有近似，不影响按天统计。
function startOfReportTimeZoneWeek(ms) {
	const parts = getTimeZoneParts(ms);
	// 星期字符串转 0..6；未知/缺失时回退到 0（周一）。
	const dayIndex = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday ?? "Mon");
	// 把年月日当作 UTC 午夜，再减去 weekday 天数的毫秒数。
	const localMidnightAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
	return localMidnightAsUtc - Math.max(dayIndex, 0) * 24 * 60 * 60 * 1000;
}

// 按 bucket 返回分组键：day 用日期，week 用该周周一日期；非法时间统一为 `[unknown]`。
function getTimeBucket(ms, bucket) {
	if (!Number.isFinite(ms)) return "[unknown]";
	if (bucket === "day") return formatDay(ms);
	return formatDay(startOfReportTimeZoneWeek(ms));
}

// 返回报告时区下的小时键，如 `"09:00"`；非法时间同样归入 `[unknown]`。
function getHourOfDayBucket(ms) {
	if (!Number.isFinite(ms)) return "[unknown]";
	return `${getTimeZoneParts(ms).hour}:00`;
}

// 决定扫描时的 since 下界，返回 {ms, source} 或 null（不过滤）。
// 优先级：--all-sessions 关闭过滤 > --since 显式值 > 自动取 autoSincePath 的 birthtime。
// 文件不存在或 stat 失败时静默返回 null；--since 格式非法则抛错。
async function resolveAutoSinceMs(options) {
	if (options.allSessions) return null;
	if (options.since) {
		const ms = Date.parse(options.since);
		if (!Number.isFinite(ms)) throw new Error(`Invalid --since value: ${options.since}`);
		return { ms, source: `--since ${options.since}` };
	}
	if (!options.autoSincePath) return null;
	try {
		// birthtimeMs 在部分文件系统为 0，此时退回 mtime；两者都不可用则不过滤。
		const stats = await fs.stat(options.autoSincePath);
		const ms = Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
		return Number.isFinite(ms) && ms > 0 ? { ms, source: `birth time of ${options.autoSincePath}` } : null;
	} catch {
		return null;
	}
}

// 递归异步生成器：按名称排序遍历目录，产出所有 .jsonl 文件的完整路径。
// 排序让扫描顺序稳定，报告可复现；目录读取失败会向上抛错。
async function* walkJsonlFiles(dir) {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		// yield* 把子生成器的路径逐个转发给调用方的 for await。
		if (entry.isDirectory()) yield* walkJsonlFiles(fullPath);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield fullPath;
	}
}

// 千分位整数格式化，如 12345 → "12,345"。
function formatInt(value) {
	return new Intl.NumberFormat("en-US").format(value);
}

// 百分比格式化；total 为 0 时返回 "n/a"，避免除零得到 NaN%。
function formatPercent(part, total) {
	return total === 0 ? "n/a" : `${((part / total) * 100).toFixed(1)}%`;
}

// 比率保留两位小数；非有限值输出 "n/a"。
function formatRate(value) {
	return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

// 计算有限数字的中位数：先过滤非有限值并升序排序；空数组返回 null；
// 偶数个元素取中间两个的平均，奇数个取正中。
function median(numbers) {
	const finite = numbers.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
	if (finite.length === 0) return null;
	const middle = Math.floor(finite.length / 2);
	return finite.length % 2 === 0 ? (finite[middle - 1] + finite[middle]) / 2 : finite[middle];
}

// 生成固定宽度 40 字符的文本条形图：实心块表示 part/total，其余用空心块填充。
function bar(part, total) {
	const filled = total === 0 ? 0 : Math.round((part / total) * CHART_WIDTH);
	return `${"█".repeat(filled)}${"░".repeat(CHART_WIDTH - filled)}`;
}

// 从消息 content 提取纯文本：字符串原样返回；数组只保留 type=text 且有 text 的块；
// 其他形状返回空字符串。读取 toolCall 时用于后续分类，不修改输入。
function extractTextContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	// 过滤器排除非文本块，map 取 text，最后用换行拼接；空结果自然得到 ""。
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

// 把一次 `read` toolCall 的参数分类为 full 或 partial。
// 输入通常是已解析的 arguments 对象（可能是 undefined）；输出 {path, offset, limit, mode}。
// 只要显式出现 offset 或 limit（且不为 undefined/null）就算 partial，即使值等于 0。
function classifyRead(args) {
	// 非对象参数统一视为空对象，后续属性访问安全。
	const normalizedArgs = args && typeof args === "object" ? args : {};
	// Object.hasOwn 只看自有属性，避免把原型链上的同名属性误认为参数。
	const hasOffset = Object.hasOwn(normalizedArgs, "offset") && normalizedArgs.offset !== undefined && normalizedArgs.offset !== null;
	const hasLimit = Object.hasOwn(normalizedArgs, "limit") && normalizedArgs.limit !== undefined && normalizedArgs.limit !== null;
	return {
		path: typeof normalizedArgs.path === "string" ? normalizedArgs.path : "",
		offset: hasOffset ? normalizedArgs.offset : null,
		limit: hasLimit ? normalizedArgs.limit : null,
		mode: hasOffset || hasLimit ? "partial" : "full",
	};
}

// 按时间桶聚合，并按桶键（日期）升序返回数组；用于时间趋势表。
function summarizeTimeBuckets(records, bucket) {
	return summarizeGroups(records, (record) => getTimeBucket(record.timestampMs, bucket)).sort((a, b) => a.key.localeCompare(b.key));
}

// 按时间桶做“会话归一化”聚合：先按会话求 partial 比例，再在桶内取中位数，避免单个长会话主导整体比例。
function summarizeNormalizedTimeBuckets(records, bucket) {
	return summarizeNormalizedTimeBucketsByKey(records, (record) => getTimeBucket(record.timestampMs, bucket));
}

// 通用会话归一化聚合：keyFn 决定桶键；每个桶内再按 sessionFile 分组。
// 输出按 key 升序，每项含会话数、读取数、每会话平均读取，以及各会话 partial 比例的中位数。
function summarizeNormalizedTimeBucketsByKey(records, keyFn) {
	// 第一层：桶键 → 该桶的所有 read 记录。
	const bucketGroups = new Map();
	for (const record of records) {
		const bucketKey = keyFn(record);
		if (!bucketGroups.has(bucketKey)) bucketGroups.set(bucketKey, []);
		bucketGroups.get(bucketKey).push(record);
	}

	// 第二层：桶内按会话文件分组，先算每个会话的 partialRate，再汇总桶级指标。
	return [...bucketGroups.entries()]
		.map(([key, bucketRecords]) => {
			const sessionGroups = new Map();
			for (const record of bucketRecords) {
				if (!sessionGroups.has(record.sessionFile)) sessionGroups.set(record.sessionFile, []);
				sessionGroups.get(record.sessionFile).push(record);
			}
			// 每个会话的 reads/full/partial 与比例；partialRate 用作后续中位数的样本。
			const sessions = [...sessionGroups.values()].map((sessionRecords) => {
				const full = sessionRecords.filter((record) => record.mode === "full").length;
				const partial = sessionRecords.length - full;
				return { reads: sessionRecords.length, full, partial, partialRate: sessionRecords.length === 0 ? null : partial / sessionRecords.length };
			});
			const reads = bucketRecords.length;
			const full = bucketRecords.filter((record) => record.mode === "full").length;
			const partial = reads - full;
			const sessionCount = sessions.length;
			const medianSessionPartialRate = median(sessions.map((session) => session.partialRate));
			return {
				key,
				sessions: sessionCount,
				reads,
				full,
				partial,
				readsPerSession: sessionCount === 0 ? null : reads / sessionCount,
				fullPerSession: sessionCount === 0 ? null : full / sessionCount,
				partialPerSession: sessionCount === 0 ? null : partial / sessionCount,
				medianSessionPartialRate,
			};
		})
		.sort((a, b) => a.key.localeCompare(b.key));
}

// 按任意 keyFn 聚合原始 read 记录：统计 reads、来自多少条 assistant 消息，以及 full/partial 数量与比例。
// 未归一化，适合看总量；先按 reads 降序，再按键升序打破并列。
function summarizeGroups(records, keyFn) {
	const groups = new Map();
	for (const record of records) {
		const key = keyFn(record);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(record);
	}
	// 会话文件 + assistant 条目 id 唯一标识一条 assistant 消息；同一消息可以有多次 read。
	return [...groups.entries()]
		.map(([key, group]) => {
			const full = group.filter((record) => record.mode === "full").length;
			const partial = group.length - full;
			const assistantMessages = new Set(group.map((record) => `${record.sessionFile}::${record.assistantEntryId}`)).size;
			return { key, reads: group.length, assistantMessages, full, partial, fullRate: group.length === 0 ? null : full / group.length, partialRate: group.length === 0 ? null : partial / group.length };
		})
		.sort((a, b) => b.reads - a.reads || a.key.localeCompare(b.key));
}

// 汇总所有聚合视图，返回可被 JSON 序列化或交给文本/HTML 渲染的对象。
// 输入 records（已过滤的 read 记录）、meta（扫描统计）与 options（桶/模型/top）。
// 纯计算，不读文件；时间字段保留毫秒并在输出时转 ISO。
function buildSummary(records, meta, options) {
	// 全局 full/partial 计数；partial 由总数减 full 得到，保证两者相加等于总数。
	const full = records.filter((record) => record.mode === "full").length;
	const partial = records.length - full;
	// 四个顶层视图：按 provider/model、按时间桶、按一天中的小时；后两者各有普通与会话归一化版本。
	const providerStats = summarizeGroups(records, (record) => record.providerModel);
	const timeStats = summarizeTimeBuckets(records, options.bucket);
	const normalizedTimeStats = summarizeNormalizedTimeBuckets(records, options.bucket);
	const timeOfDayStats = summarizeGroups(records, (record) => getHourOfDayBucket(record.timestampMs)).sort((a, b) => a.key.localeCompare(b.key));
	const normalizedTimeOfDayStats = summarizeNormalizedTimeBucketsByKey(records, (record) => getHourOfDayBucket(record.timestampMs));
	// 每个 provider/model 再展开同样的时间/小时视图；记录量不大，这里对每个 provider 重新过滤一次。
	const timeStatsByProvider = providerStats.map((provider) => ({
		providerModel: provider.key,
		...provider,
		timeStats: summarizeTimeBuckets(
			records.filter((record) => record.providerModel === provider.key),
			options.bucket
		),
		normalizedTimeStats: summarizeNormalizedTimeBuckets(
			records.filter((record) => record.providerModel === provider.key),
			options.bucket
		),
		timeOfDayStats: summarizeGroups(
			records.filter((record) => record.providerModel === provider.key),
			(record) => getHourOfDayBucket(record.timestampMs)
		).sort((a, b) => a.key.localeCompare(b.key)),
		normalizedTimeOfDayStats: summarizeNormalizedTimeBucketsByKey(
			records.filter((record) => record.providerModel === provider.key),
			(record) => getHourOfDayBucket(record.timestampMs)
		),
	}));
	return {
		// filters 记录本次运行的筛选条件，JSON 消费者可据此解释数据。
		filters: { model: options.modelFilter ?? null, bucket: options.bucket },
		// scan 保留扫描阶段的元数据；since 有值时才带 ms/iso/source。
		scan: {
			sessionsDir: meta.sessionsDir,
			sessionFilesScanned: meta.sessionFilesScanned,
			sessionFilesIncluded: meta.sessionFilesIncluded,
			sessionFilesSkippedOlderThanSince: meta.sessionFilesSkippedOlderThanSince,
			sessionFilesWithReadCalls: meta.sessionFilesWithReadCalls,
			since: meta.since ? { ms: meta.since.ms, iso: formatIso(meta.since.ms), source: meta.since.source } : null,
			malformedLines: meta.malformedLines,
		},
		// counts 是过滤后的总体结果；assistantMessagesWithReadCalls 用去重集合计数。
		counts: {
			assistantMessagesWithReadCalls: new Set(records.map((record) => `${record.sessionFile}::${record.assistantEntryId}`)).size,
			totalReadCalls: records.length,
			full,
			partial,
			fullRate: records.length === 0 ? null : full / records.length,
			partialRate: records.length === 0 ? null : partial / records.length,
		},
		providerStats,
		timeStats,
		normalizedTimeStats,
		timeOfDayStats,
		normalizedTimeOfDayStats,
		timeStatsByProvider,
		// examples 只保留前 top 条，避免 JSON 报告过大；顺序是扫描顺序。
		examples: records.slice(0, options.top),
	};
}

// 捕获文本报告输出为字符串：临时替换 console.log 收集每行，再恢复原函数。
// 这样 printHumanReport 无需感知输出目标，文本报告与 HTML 内嵌 <pre> 共用同一份渲染逻辑。
function buildHumanReport(summary) {
	const lines = [];
	const originalLog = console.log;
	// 默认参数 "" 对应 console.log() 空行；String 保证非字符串值也能 push。
	console.log = (line = "") => lines.push(String(line));
	try {
		printHumanReport(summary);
	} finally {
		// 即使渲染抛错也恢复 console.log，避免污染调用方。
		console.log = originalLog;
	}
	return lines.join("\n") + "\n";
}

// 转义 HTML 特殊字符，防止扫描出的文件名/模型名破坏页面结构；先转 & 避免二次转义。
function escapeHtml(text) {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// 打印一个最小 HTML 页面，把纯文本报告放进 <pre>；不引入外部资源。
function printHtmlReport(summary) {
	// 先得到整段纯文本，再整体转义，避免在 HTML 模板中逐行处理。
	const text = buildHumanReport(summary);
	// 多行模板字符串生成文档；${escapeHtml(text)} 是唯一动态内容。
	console.log(`<!doctype html>
<meta charset="utf-8">
<title>Read tool stats</title>
<style>
body { margin: 24px; background: #fff; color: #111; }
pre { font: 13px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
</style>
<pre>${escapeHtml(text)}</pre>`);
}

// 把 summary 打印成人类可读的纯文本：概览、full/partial、按时间、按时段、
// 再按 provider/model 展开同样的视图；所有动态值用 padStart 对齐列。
function printHumanReport(summary) {
	const { scan, counts, timeStats, normalizedTimeStats, timeOfDayStats, normalizedTimeOfDayStats, timeStatsByProvider, filters } = summary;
	console.log(`Scanned ${formatInt(scan.sessionFilesIncluded)} session files in ${scan.sessionsDir}`);
	console.log(`Report timezone: ${REPORT_TIME_ZONE} (CET/CEST)`);
	// since 过滤生效时补充显示下界与此前跳过的文件数。
	if (scan.since) {
		console.log(`Session filter: files created at or after ${scan.since.iso} (${scan.since.source})`);
		console.log(`Skipped older session files: ${formatInt(scan.sessionFilesSkippedOlderThanSince)} of ${formatInt(scan.sessionFilesScanned)}`);
	}
	console.log(`Found ${formatInt(counts.totalReadCalls)} read tool calls in ${formatInt(counts.assistantMessagesWithReadCalls)} assistant messages`);
	if (filters.model) console.log(`Filters: model contains "${filters.model}"`);

	// 全局 full/partial 对比；条形图按各自数量占总读取数的比例绘制。
	console.log("\nFull vs partial reads");
	console.log(`  full:    ${formatInt(counts.full).padStart(8)}  ${formatPercent(counts.full, counts.totalReadCalls).padStart(6)}  ${bar(counts.full, counts.totalReadCalls)}`);
	console.log(`  partial: ${formatInt(counts.partial).padStart(8)}  ${formatPercent(counts.partial, counts.totalReadCalls).padStart(6)}  ${bar(counts.partial, counts.totalReadCalls)}`);

	// 按天/周的普通聚合；每行显示该桶内 partial 的占比条。
	console.log(`\nBy ${filters.bucket}`);
	for (const group of timeStats) {
		console.log(
			`  ${group.key} reads=${formatInt(group.reads).padStart(5)} full=${formatPercent(group.full, group.reads).padStart(6)} partial=${formatPercent(group.partial, group.reads).padStart(6)} ${bar(group.partial, group.reads)}`
		);
	}

	// 按时点（0-23 点）的普通聚合。
	console.log("\nBy time of day");
	for (const group of timeOfDayStats) {
		console.log(
			`  ${group.key} reads=${formatInt(group.reads).padStart(5)} full=${formatPercent(group.full, group.reads).padStart(6)} partial=${formatPercent(group.partial, group.reads).padStart(6)} ${bar(group.partial, group.reads)}`
		);
	}

	// 会话归一化视图：比例条使用各会话 partial 比例的中位数。
	console.log("\nBy time of day, session-normalized");
	for (const group of normalizedTimeOfDayStats) {
		console.log(
			`  ${group.key} sessions=${formatInt(group.sessions).padStart(4)} reads/session=${formatRate(group.readsPerSession).padStart(5)} full/session=${formatRate(group.fullPerSession).padStart(5)} partial/session=${formatRate(group.partialPerSession).padStart(5)} medianSessionPartial=${group.medianSessionPartialRate === null ? "n/a" : formatPercent(group.medianSessionPartialRate, 1).padStart(6)} ${bar(group.medianSessionPartialRate ?? 0, 1)}`
		);
	}

	console.log(`\nBy ${filters.bucket}, session-normalized`);
	for (const group of normalizedTimeStats) {
		console.log(
			`  ${group.key} sessions=${formatInt(group.sessions).padStart(4)} reads/session=${formatRate(group.readsPerSession).padStart(5)} full/session=${formatRate(group.fullPerSession).padStart(5)} partial/session=${formatRate(group.partialPerSession).padStart(5)} medianSessionPartial=${group.medianSessionPartialRate === null ? "n/a" : formatPercent(group.medianSessionPartialRate, 1).padStart(6)} ${bar(group.medianSessionPartialRate ?? 0, 1)}`
		);
	}

	// 每个 provider/model 单独成段，段内重复上述四种视图。
	console.log(`\nBy provider/model, then by ${filters.bucket}`);
	for (const group of timeStatsByProvider) {
		console.log(`\n${group.providerModel}`);
		console.log(`  total reads=${formatInt(group.reads)} assistantMessages=${formatInt(group.assistantMessages)}`);
		console.log(`  total full    ${formatInt(group.full).padStart(8)} ${formatPercent(group.full, group.reads).padStart(6)} ${bar(group.full, group.reads)}`);
		console.log(`  total partial ${formatInt(group.partial).padStart(8)} ${formatPercent(group.partial, group.reads).padStart(6)} ${bar(group.partial, group.reads)}`);
		console.log(`  By ${filters.bucket}`);
		for (const bucket of group.timeStats) {
			console.log(
				`    ${bucket.key} reads=${formatInt(bucket.reads).padStart(5)} full=${formatPercent(bucket.full, bucket.reads).padStart(6)} partial=${formatPercent(bucket.partial, bucket.reads).padStart(6)} ${bar(bucket.partial, bucket.reads)}`
			);
		}
		console.log(`  By ${filters.bucket}, session-normalized`);
		for (const bucket of group.normalizedTimeStats) {
			console.log(
				`    ${bucket.key} sessions=${formatInt(bucket.sessions).padStart(4)} reads/session=${formatRate(bucket.readsPerSession).padStart(5)} full/session=${formatRate(bucket.fullPerSession).padStart(5)} partial/session=${formatRate(bucket.partialPerSession).padStart(5)} medianSessionPartial=${bucket.medianSessionPartialRate === null ? "n/a" : formatPercent(bucket.medianSessionPartialRate, 1).padStart(6)} ${bar(bucket.medianSessionPartialRate ?? 0, 1)}`
			);
		}
		console.log("  By time of day");
		for (const bucket of group.timeOfDayStats) {
			console.log(
				`    ${bucket.key} reads=${formatInt(bucket.reads).padStart(5)} full=${formatPercent(bucket.full, bucket.reads).padStart(6)} partial=${formatPercent(bucket.partial, bucket.reads).padStart(6)} ${bar(bucket.partial, bucket.reads)}`
			);
		}
		console.log("  By time of day, session-normalized");
		for (const bucket of group.normalizedTimeOfDayStats) {
			console.log(
				`    ${bucket.key} sessions=${formatInt(bucket.sessions).padStart(4)} reads/session=${formatRate(bucket.readsPerSession).padStart(5)} full/session=${formatRate(bucket.fullPerSession).padStart(5)} partial/session=${formatRate(bucket.partialPerSession).padStart(5)} medianSessionPartial=${bucket.medianSessionPartialRate === null ? "n/a" : formatPercent(bucket.medianSessionPartialRate, 1).padStart(6)} ${bar(bucket.medianSessionPartialRate ?? 0, 1)}`
			);
		}
	}

	// 只有解析失败时才输出 Parser notes，正常情况下保持报告整洁。
	if (scan.malformedLines > 0) {
		console.log("\nParser notes");
		console.log(`  malformed lines skipped: ${formatInt(scan.malformedLines)}`);
	}
}

// 扫描会话目录，返回 {records, meta}：records 是每次 read toolCall 的扁平记录，
// meta 记录扫描/跳过/解析失败等计数。since 为 null 时不按文件时间过滤。
// 只读文件；逐行流式读取，避免一次性把大 JSONL 全部载入内存。
async function scanSessions(sessionsDir, since) {
	const records = [];
	// meta 的计数字段在这里初始化，后面每个阶段递增；since 原样保留供 buildSummary 输出。
	const meta = { sessionsDir, sessionFilesScanned: 0, sessionFilesIncluded: 0, sessionFilesSkippedOlderThanSince: 0, sessionFilesWithReadCalls: 0, since, malformedLines: 0 };

	for await (const sessionFile of walkJsonlFiles(sessionsDir)) {
		meta.sessionFilesScanned++;
		// 文件名时间只用于按 since 跳过整个文件；无法解析(null)的文件仍会扫描。
		const sessionTimestampMs = parseSessionFileTimestamp(sessionFile);
		if (since && sessionTimestampMs !== null && sessionTimestampMs < since.ms) {
			meta.sessionFilesSkippedOlderThanSince++;
			continue;
		}
		meta.sessionFilesIncluded++;
		let fileHadReadCall = false;
		// createReadStream + readline 按行消费；crlfDelay Infinity 让 \r\n 也被视为一个换行。
		const input = createReadStream(sessionFile, { encoding: "utf8" });
		const rl = createInterface({ input, crlfDelay: Infinity });

		for await (const line of rl) {
			if (!line.trim()) continue;
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				// 单行损坏不影响其他会话；只计数，不输出原始内容（可能很大）。
				meta.malformedLines++;
				continue;
			}
			// 只关心有 message 的消息条目；其他类型（session/compaction 等）跳过。
			if (entry?.type !== "message" || !entry.message) continue;
			const message = entry.message;
			// read 只可能出现在 assistant 的结构化 content 数组中。
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				// 兼容旧/新格式：toolCall 块的 name 必须是 read；非 read 工具忽略。
				if (block?.type !== "toolCall" || block.name !== "read") continue;
				fileHadReadCall = true;
				// 每条记录带上会话、消息与模型信息，后续可直接分组，不再回读文件。
				records.push({
					sessionFile,
					assistantEntryId: entry.id,
					toolCallId: typeof block.id === "string" ? block.id : "",
					timestamp: entry.timestamp,
					// 优先用条目时间；失败时退回文件名时间；两者都没有则 0（会被归入 [unknown]）。
					timestampMs: Date.parse(entry.timestamp) || sessionTimestampMs || 0,
					api: typeof message.api === "string" ? message.api : null,
					provider: typeof message.provider === "string" ? message.provider : "[unknown]",
					model: typeof message.model === "string" ? message.model : "[unknown]",
					providerModel: `${typeof message.provider === "string" ? message.provider : "[unknown]"}/${typeof message.model === "string" ? message.model : "[unknown]"}`,
					// 展开分类结果，得到 path/offset/limit/mode 四个字段。
					...classifyRead(block.arguments),
				});
			}
		}
		// 至少有一条 read 才计入“有 read 调用的会话文件”。
		if (fileHadReadCall) meta.sessionFilesWithReadCalls++;
	}
	return { records, meta };
}

// 按 --model 子串过滤记录；provider/model 与过滤词都转小写，大小写不敏感。
// 没有过滤词时原样返回所有记录（filter 仍会创建新数组）。
function applyFilters(records, options) {
	return records.filter((record) => !options.modelFilter || record.providerModel.toLowerCase().includes(options.modelFilter.toLowerCase()));
}

// CLI 入口：解析参数 → 校验会话目录 → 确定 since → 扫描 → 过滤 → 汇总 → 选择输出格式。
// 默认 HTML；--json 输出 {summary[, records]}；--text 输出纯文本。
// 错误由末尾的 main().catch 打印消息并以 1 退出；--help 正常返回退出码 0。
async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}
	// resolve 把相对路径转绝对；access 在目录不存在或无权限时抛错，由 catch 处理。
	const sessionsDir = path.resolve(options.sessionsDir);
	await fs.access(sessionsDir);
	const since = await resolveAutoSinceMs(options);
	const { records, meta } = await scanSessions(sessionsDir, since);
	const filteredRecords = applyFilters(records, options);
	const summary = buildSummary(filteredRecords, meta, options);
	if (options.json) {
		// --include-records 把原始 read 记录一并放进 JSON；否则只输出汇总。
		console.log(JSON.stringify(options.includeRecords ? { summary, records: filteredRecords } : { summary }, null, 2));
		return;
	}
	if (options.text) {
		printHumanReport(summary);
		return;
	}
	printHtmlReport(summary);
}

// 顶层错误处理：只打印 message，不打印堆栈；process.exit(1) 标记失败。
main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
