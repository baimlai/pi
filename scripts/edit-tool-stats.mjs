#!/usr/bin/env node

// 文件导读
// 所属：仓库根 scripts/ 的本地会话分析脚本，统计内建 edit 工具的调用质量；不参与构建或 CI，手动运行。
// 职责：流式读取 ~/.pi/agent/sessions 下的 JSONL 会话，配对 assistant 的 edit toolCall 与 toolResult，
//   计算成功/失败、single 与 multi-edit 模式、参数风格、按 provider/model 与文件扩展名的分布，
//   以及“上下文膨胀比”（edit 载荷总字节 / 实际改动核心字节）的分布、同文件重复编辑聚类和最差样例。
// 上游：手动执行 node scripts/edit-tool-stats.mjs [options]。
// 输入：命令行选项（见 printHelp）；默认会话目录 ~/.pi/agent/sessions。
// 输出：默认打印人类可读报告；--json 输出 JSON 摘要，--include-records 额外附带每条过滤后的记录。
// 退出码：0 成功（含 --help）；1 参数错误、会话目录不存在/不可访问、--since 无效或扫描异常。
// 副作用：只读会话文件与 --auto-since-path 的 stat；不联网、不写文件。幂等，但结果随会话增长变化。
// 自动 since：默认用 ~/.pi/agent/extensions/edit.ts 的创建时间，只扫描该文件出现后的会话；
//   文件不存在时退化为扫描全部；--all-sessions 关闭该过滤。
// 示例：
//   node scripts/edit-tool-stats.mjs --failed-only --top 10
//   node scripts/edit-tool-stats.mjs --model sonnet --ext .ts --json > stats.json
// 建议阅读顺序：parseArgs/printHelp → 时间与文件遍历 → analyzeReplacement（膨胀比核心）→
//   analyzeToolArguments → summarize/buildSummary → scanSessions（流式配对）→ main。

// createReadStream 用于逐文件流式读取；promises.fs 提供 async 的 stat/readdir/access。
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
// readline 把流按行切分，避免一次性把大会话文件读进内存。
import { createInterface } from "node:readline";

// 默认值全部从 HOME 推导；--sessions-dir/--auto-since-path 可覆盖。
const DEFAULT_SESSIONS_DIR = path.join(homedir(), ".pi/agent/sessions");
const DEFAULT_ACTIVE_EDIT_EXTENSION_PATH = path.join(homedir(), ".pi/agent/extensions/edit.ts");
const DEFAULT_TOP = 20;

// 输入：process.argv.slice(2)。输出：带默认值的 options 对象；未知参数或非法 --top 抛出。
// 副作用：无。值选项缺少值时把 undefined 存入字段，后续访问会自然得到假值/默认行为。
function parseArgs(argv) {
	const options = {
		sessionsDir: DEFAULT_SESSIONS_DIR,
		json: false,
		includeRecords: false,
		failedOnly: false,
		modelFilter: undefined,
		extFilter: undefined,
		top: DEFAULT_TOP,
		help: false,
		allSessions: false,
		since: undefined,
		autoSincePath: DEFAULT_ACTIVE_EDIT_EXTENSION_PATH,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else if (arg === "--json") {
			options.json = true;
		} else if (arg === "--include-records") {
			options.includeRecords = true;
		} else if (arg === "--failed-only") {
			options.failedOnly = true;
		} else if (arg === "--model") {
			options.modelFilter = argv[++i];
		} else if (arg === "--ext") {
			// 扩展名统一小写，与 getPathExtension 的输出对齐。
			options.extFilter = argv[++i]?.toLowerCase();
		} else if (arg === "--top") {
			// 先按十进制解析再校验；NaN、0、负数都拒绝，避免 slice(0, top) 行为异常。
			const value = Number.parseInt(argv[++i] ?? "", 10);
			if (!Number.isFinite(value) || value <= 0) {
				throw new Error("--top must be a positive integer");
			}
			options.top = value;
		} else if (arg === "--sessions-dir") {
			options.sessionsDir = argv[++i];
		} else if (arg === "--all-sessions") {
			options.allSessions = true;
		} else if (arg === "--since") {
			options.since = argv[++i];
		} else if (arg === "--auto-since-path") {
			options.autoSincePath = argv[++i];
		} else {
			// 严格拒绝未知参数，避免拼写错误静默改变统计范围。
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return options;
}

// 打印用法；DEFAULT_TOP 插值进帮助文本，默认值变化时文档同步。
function printHelp() {
	console.log(`Usage: node scripts/edit-tool-stats.mjs [options]

Options:
  --sessions-dir <path>  Sessions directory (default: ~/.pi/agent/sessions)
  --model <substring>    Filter provider/model by substring
  --ext <extension>      Filter by file extension, e.g. .ts
  --failed-only          Include only failed edit calls
  --top <n>              Number of examples to show (default: ${DEFAULT_TOP})
  --since <iso>          Only scan session files created at or after this ISO time
  --all-sessions         Disable the automatic since filter
  --auto-since-path <p>  Use birth time of this file for the automatic since filter
  --json                 Print JSON summary instead of human report
  --include-records      Include raw records in JSON output
  -h, --help             Show this help
`);
}

// 输入：会话文件路径。输出：毫秒时间戳；文件名不符合约定时返回 null。
// 文件名形如 2025-12-17T08-25-07-381Z_<uuid>.jsonl；冒号被短横线替换以兼容文件系统。
function parseSessionFileTimestamp(sessionFile) {
	const base = path.basename(sessionFile);
	const rawTimestamp = base.split("_")[0];
	if (!rawTimestamp) return null;
	// 只替换末尾的完整时间部分，避免误改文件名中的其他片段；$ 锚定结尾。
	const isoTimestamp = rawTimestamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
	const ms = Date.parse(isoTimestamp);
	// Date.parse 失败返回 NaN；Number.isFinite 统一处理。
	if (!Number.isFinite(ms)) return null;
	return ms;
}

// 毫秒 → ISO 字符串，用于报告中的 since 时间。
function formatIso(ms) {
	return new Date(ms).toISOString();
}

// 输入：options。输出：{ms, source} 或 null（不过滤）。
// 优先级：--all-sessions（关闭）> --since（用户显式时间）> 自动路径的 birthtime/mtime。
async function resolveAutoSinceMs(options) {
	if (options.allSessions) return null;
	if (options.since) {
		const ms = Date.parse(options.since);
		if (!Number.isFinite(ms)) {
			throw new Error(`Invalid --since value: ${options.since}`);
		}
		return { ms, source: `--since ${options.since}` };
	}
	if (!options.autoSincePath) return null;
	try {
		const stats = await fs.stat(options.autoSincePath);
		// 某些文件系统 birthtimeMs 为 0 或不可用，此时退回 mtime。
		const birthtimeMs = Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
		if (!Number.isFinite(birthtimeMs) || birthtimeMs <= 0) return null;
		return { ms: birthtimeMs, source: `birth time of ${options.autoSincePath}` };
	} catch {
		// 自动路径不存在是正常情况（用户没装该扩展），不报错，退化为扫描全部。
		return null;
	}
}

// 异步生成器：深度优先遍历目录，按名称排序以保证输出稳定，只产出 .jsonl 文件。
async function* walkJsonlFiles(dir) {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	entries.sort((a, b) => a.name.localeCompare(b.name));

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			// yield* 把子生成器的产出逐个转发给调用方。
			yield* walkJsonlFiles(fullPath);
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			yield fullPath;
		}
	}
}

// 输入：文件路径。输出：小写扩展名、点文件全名或 [no_ext]/[unknown]。
// 这只做字符串分类，不访问文件系统。
function getPathExtension(filePath) {
	if (typeof filePath !== "string" || filePath.length === 0) return "[unknown]";
	const ext = path.extname(filePath).toLowerCase();
	if (ext) return ext;
	// 形如 .gitignore 的点文件没有 extname，返回文件名本身作为“扩展名”。
	const base = path.basename(filePath);
	if (base.startsWith(".") && !base.slice(1).includes(".")) return base.toLowerCase();
	return "[no_ext]";
}

// 输入：字符串或 undefined。输出：UTF-8 字节数；undefined 视为空串。
// 费用/膨胀统计按字节而非字符，避免把中文等多字节文本低估。
function utf8Bytes(value) {
	return Buffer.byteLength(value ?? "", "utf8");
}

// 输入：两个字符串。输出：共同前缀的字符数。
function longestCommonPrefixLength(a, b) {
	const max = Math.min(a.length, b.length);
	let index = 0;
	while (index < max && a[index] === b[index]) index++;
	return index;
}

// 输入：两个字符串。输出：共同后缀的字符数；从末尾反向比较。
function longestCommonSuffixLength(a, b) {
	const max = Math.min(a.length, b.length);
	let index = 0;
	while (index < max && a[a.length - 1 - index] === b[b.length - 1 - index]) index++;
	return index;
}

// 输入：edit 的 oldText/newText。输出：字节统计与膨胀比，描述“为改核心内容需要重复多少上下文”。
// 算法：先剥离共同前缀，再在剩余部分剥离共同后缀；中间剩下的 oldCore/newCore 才是真正改动。
// 例：old="foo bar" new="foo baz" → prefix="foo ba"，核心 old="r"、new="z"，上下文重复在载荷中占大头。
function analyzeReplacement(oldText, newText) {
	const prefixChars = longestCommonPrefixLength(oldText, newText);
	const oldRemainder = oldText.slice(prefixChars);
	const newRemainder = newText.slice(prefixChars);
	// 后缀必须在剥离前缀后的剩余串上计算，否则前缀与后缀可能重叠。
	const suffixChars = longestCommonSuffixLength(oldRemainder, newRemainder);
	const oldCore = suffixChars > 0 ? oldRemainder.slice(0, -suffixChars) : oldRemainder;
	const newCore = suffixChars > 0 ? newRemainder.slice(0, -suffixChars) : newRemainder;
	const prefix = oldText.slice(0, prefixChars);
	const suffix = suffixChars > 0 ? oldRemainder.slice(-suffixChars) : "";

	const oldBytes = utf8Bytes(oldText);
	const newBytes = utf8Bytes(newText);
	const sharedPrefixBytes = utf8Bytes(prefix);
	const sharedSuffixBytes = utf8Bytes(suffix);
	const sharedContextBytes = sharedPrefixBytes + sharedSuffixBytes;
	const coreOldBytes = utf8Bytes(oldCore);
	const coreNewBytes = utf8Bytes(newCore);
	const coreBytes = coreOldBytes + coreNewBytes;
	// totalEditBytes 是模型实际发送的载荷大小；coreBytes 是语义改动大小。
	const totalEditBytes = oldBytes + newBytes;
	const wrapperPayloadBytes = totalEditBytes - coreBytes;
	// coreBytes 为 0 表示只改上下文/无实际变化，比值无意义，用 null 表示。
	const inflationRatio = coreBytes === 0 ? null : totalEditBytes / coreBytes;

	return {
		oldBytes,
		newBytes,
		totalEditBytes,
		sharedPrefixBytes,
		sharedSuffixBytes,
		sharedContextBytes,
		coreOldBytes,
		coreNewBytes,
		coreBytes,
		wrapperPayloadBytes,
		inflationRatio,
		noCoreChange: coreBytes === 0,
	};
}

// 中位数是 0.5 分位的特例。
function median(numbers) {
	return quantile(numbers, 0.5);
}

// 输入：数值数组与分位 q（0..1）。输出：线性插值分位数；无有限值返回 null。
function quantile(numbers, q) {
	// 过滤 NaN/Infinity 后升序排序；不修改调用方数组（sort 作用在新数组上）。
	const finite = numbers.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
	if (finite.length === 0) return null;
	if (finite.length === 1) return finite[0];
	// position 位于 [0, length-1]，lower/upper 之间按小数部分加权。
	const position = (finite.length - 1) * q;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	if (lower === upper) return finite[lower];
	const weight = position - lower;
	return finite[lower] * (1 - weight) + finite[upper] * weight;
}


// 千分位整数，便于阅读大数。
function formatInt(value) {
	return new Intl.NumberFormat("en-US").format(value);
}

// 百分比，保留 1 位；分母为 0 时输出 n/a。
function formatPercent(part, total) {
	if (total === 0) return "n/a";
	return `${((part / total) * 100).toFixed(1)}%`;
}

// 膨胀比格式化：null 表示无核心改动；Infinity 用 ∞；按数量级选择小数位。
function formatRatio(value) {
	if (value === null) return "no-core-change";
	if (!Number.isFinite(value)) return "∞";
	if (value >= 100) return `${value.toFixed(0)}x`;
	if (value >= 10) return `${value.toFixed(1)}x`;
	return `${value.toFixed(2)}x`;
}

// 字节数转 B/KB/MB；10KB 以上不再显示小数，避免表格过宽。
function formatBytes(value) {
	if (value < 1024) return `${value}B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)}KB`;
	return `${(value / (1024 * 1024)).toFixed(1)}MB`;
}

// 输入：消息 content（字符串或多模态块数组）。输出：拼接后的文本；非文本块被忽略。
function extractTextContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

// 输入：工具结果文本、isError 标志、是否匹配到调用。输出：错误分类键或 null（成功）。
// 分类依赖内建 edit 工具的固定错误措辞；措辞变化会落入 other，不影响总体成功/失败统计。
function classifyErrorKind(text, isError, matchedResult) {
	// 没有对应 toolResult（会话中断等）单独算一类，而不是“成功”。
	if (!matchedResult) return "missing_result";
	if (!isError) return null;
	const normalized = text.toLowerCase();
	if (normalized.includes("file not found")) return "file_not_found";
	if (normalized.includes("could not find the exact text")) return "not_found_exact_text";
	if (normalized.includes("found multiple occurrences") || /^found \d+ occurrences/m.test(normalized)) {
		return "multiple_occurrences";
	}
	if (normalized.includes("no changes made")) return "no_changes_made";
	if (normalized.includes("input is invalid")) return "invalid_input";
	if (normalized.includes("must not overlap")) return "overlapping_edits";
	if (normalized.includes("aborted")) return "aborted";
	return "other";
}

// 输入：toolCall 的 arguments。输出：参数风格标签。
// 内建 edit 工具同时兼容旧版 oldText/newText 与 Claude 风格的 old_string/new_string，以及批量 edits。
function getArgStyle(args) {
	const hasEdits = Array.isArray(args?.edits);
	const hasOldText = typeof args?.oldText === "string" || typeof args?.newText === "string";
	const hasOldString = typeof args?.old_string === "string" || typeof args?.new_string === "string";
	if (hasEdits) return "edits";
	if (hasOldText && hasOldString) return "mixed";
	if (hasOldText) return "oldText/newText";
	if (hasOldString) return "old_string/new_string";
	return "unknown";
}

// 输入：toolCall arguments（来自 JSONL，运行时形状不受类型保证）。输出：统一的编辑分析记录。
// multi 模式把每次 replacement 的字节相加，再整体计算膨胀比；同时保留 perEdit 供后续统计。
function analyzeToolArguments(args) {
	// 参数是外部 JSON，这里做运行时形状校验；非对象按空对象处理。
	const normalizedArgs = args && typeof args === "object" ? args : {};
	const filePath = typeof normalizedArgs.path === "string" ? normalizedArgs.path : "";
	const extension = getPathExtension(filePath);
	const argStyle = getArgStyle(normalizedArgs);

	if (Array.isArray(normalizedArgs.edits)) {
		const perEdit = normalizedArgs.edits.map((edit) =>
			analyzeReplacement(typeof edit?.oldText === "string" ? edit.oldText : "", typeof edit?.newText === "string" ? edit.newText : "")
		);
		// null（无核心改动）不参与 ratio 的 median/max，但保留在 noCoreChangeCount 中。
		const inflations = perEdit.map((edit) => edit.inflationRatio).filter((value) => value !== null);
		// reduce 累加所有字节字段；noCoreChangeCount 统计没有实际改动的子编辑个数。
		const totals = perEdit.reduce(
			(acc, edit) => ({
				oldBytes: acc.oldBytes + edit.oldBytes,
				newBytes: acc.newBytes + edit.newBytes,
				totalEditBytes: acc.totalEditBytes + edit.totalEditBytes,
				sharedPrefixBytes: acc.sharedPrefixBytes + edit.sharedPrefixBytes,
				sharedSuffixBytes: acc.sharedSuffixBytes + edit.sharedSuffixBytes,
				sharedContextBytes: acc.sharedContextBytes + edit.sharedContextBytes,
				coreOldBytes: acc.coreOldBytes + edit.coreOldBytes,
				coreNewBytes: acc.coreNewBytes + edit.coreNewBytes,
				coreBytes: acc.coreBytes + edit.coreBytes,
				wrapperPayloadBytes: acc.wrapperPayloadBytes + edit.wrapperPayloadBytes,
				noCoreChangeCount: acc.noCoreChangeCount + (edit.noCoreChange ? 1 : 0),
			}),
			{
				oldBytes: 0,
				newBytes: 0,
				totalEditBytes: 0,
				sharedPrefixBytes: 0,
				sharedSuffixBytes: 0,
				sharedContextBytes: 0,
				coreOldBytes: 0,
				coreNewBytes: 0,
				coreBytes: 0,
				wrapperPayloadBytes: 0,
				noCoreChangeCount: 0,
			}
		);
		return {
			path: filePath,
			extension,
			mode: "multi",
			argStyle,
			editsCount: normalizedArgs.edits.length,
			...totals,
			// 整体膨胀比用总载荷/总核心；median/max 则看单个子编辑。
			inflationRatio: totals.coreBytes === 0 ? null : totals.totalEditBytes / totals.coreBytes,
			medianEditInflationRatio: median(inflations),
			maxEditInflationRatio: inflations.length > 0 ? Math.max(...inflations) : null,
			perEdit,
		};
	}

	// 单次编辑：兼容两套字段名，空串表示字段缺失。
	const oldText = typeof normalizedArgs.oldText === "string" ? normalizedArgs.oldText : typeof normalizedArgs.old_string === "string" ? normalizedArgs.old_string : "";
	const newText = typeof normalizedArgs.newText === "string" ? normalizedArgs.newText : typeof normalizedArgs.new_string === "string" ? normalizedArgs.new_string : "";
	const replacement = analyzeReplacement(oldText, newText);
	return {
		path: filePath,
		extension,
		mode: "single",
		argStyle,
		editsCount: 1,
		...replacement,
		// single 模式的“子编辑”指标就是整体指标。
		medianEditInflationRatio: replacement.inflationRatio,
		maxEditInflationRatio: replacement.inflationRatio,
		perEdit: [replacement],
	};
}

// 输入：记录数组与取键函数。输出：Map<键, 次数>；用于参数风格、失败类型等简单分布。
function groupCounts(records, keyFn) {
	const counts = new Map();
	for (const record of records) {
		const key = keyFn(record);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

// 收集非 null 的膨胀比；null 表示无核心改动，会单独统计。
function collectInflations(records) {
	return records.map((record) => record.inflationRatio).filter((value) => value !== null);
}

// 输入：记录、分组键函数。输出：按调用数降序的分组统计数组。
// resolved 只统计已有 toolResult 的调用；unresolved 不进入成功率分母。
function summarizeGroups(records, keyFn) {
	const groups = new Map();
	for (const record of records) {
		const key = keyFn(record);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(record);
	}

	return [...groups.entries()]
		.map(([key, group]) => {
			const resolved = group.filter((record) => record.success !== null);
			const success = resolved.filter((record) => record.success).length;
			const failed = resolved.filter((record) => record.success === false).length;
			const multi = group.filter((record) => record.mode === "multi").length;
			const inflations = collectInflations(group);
			return {
				key,
				calls: group.length,
				resolved: resolved.length,
				success,
				failed,
				unresolved: group.length - resolved.length,
				multi,
				multiRate: group.length === 0 ? null : multi / group.length,
				successRate: resolved.length === 0 ? null : success / resolved.length,
				medianInflation: quantile(inflations, 0.5),
				p95Inflation: quantile(inflations, 0.95),
			};
		})
		.sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));
}

// 输入：记录数组。输出：同一 assistant 消息内对同一文件多次 edit 的聚类统计。
// 用途：衡量模型是“多次小 edit 同一文件”还是“一次 multi-edit”，两者对上下文成本不同。
function buildSameFileClusterStats(records) {
	const groups = new Map();
	for (const record of records) {
		// 聚类键包含会话文件、assistant 消息 id 与文件路径；同一消息多次 edit 同一文件才成簇。
		const key = `${record.sessionFile}::${record.assistantEntryId}::${record.path}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(record);
	}

	const clusters = [...groups.values()].filter((group) => group.length >= 2);
	// 用 Set 去重到“assistant 消息”粒度。
	const assistantMessagesWithCluster = new Set(clusters.map((group) => `${group[0].sessionFile}::${group[0].assistantEntryId}`));
	const assistantMessagesWithMultiEdit = new Set(
		records
			.filter((record) => record.mode === "multi" && record.editsCount > 1)
			.map((record) => `${record.sessionFile}::${record.assistantEntryId}`)
	);
	const callsInsideClusters = clusters.reduce((sum, group) => sum + group.length, 0);

	return {
		clustersCount: clusters.length,
		assistantMessagesWithCluster: assistantMessagesWithCluster.size,
		assistantMessagesWithMultiEdit: assistantMessagesWithMultiEdit.size,
		callsInsideClusters,
		averageCallsPerCluster: clusters.length === 0 ? null : callsInsideClusters / clusters.length,
		// 比值 >1 说明同文件多调用比 multi-edit 更常见；分母为 0 时无意义。
		ratioClusterAssistantMessagesToMultiEditAssistantMessages:
			assistantMessagesWithMultiEdit.size === 0 ? null : assistantMessagesWithCluster.size / assistantMessagesWithMultiEdit.size,
	};
}

// 输入：记录数组。输出：按膨胀比分桶后的计数与失败率。
// 分桶边界固定，便于跨时间比较；no-core-change 单独成桶。
function buildInflationBuckets(records) {
	const buckets = [
		{ key: "no_core_change", label: "no-core-change", test: (record) => record.inflationRatio === null },
		{ key: "lt4", label: "<4x", test: (record) => record.inflationRatio !== null && record.inflationRatio < 4 },
		{ key: "4to10", label: "4-10x", test: (record) => record.inflationRatio !== null && record.inflationRatio >= 4 && record.inflationRatio < 10 },
		{ key: "10to25", label: "10-25x", test: (record) => record.inflationRatio !== null && record.inflationRatio >= 10 && record.inflationRatio < 25 },
		{ key: "gte25", label: "25x+", test: (record) => record.inflationRatio !== null && record.inflationRatio >= 25 },
	];

	return buckets.map((bucket) => {
		const bucketRecords = records.filter(bucket.test);
		const resolved = bucketRecords.filter((record) => record.success !== null);
		const failed = resolved.filter((record) => record.success === false).length;
		return {
			key: bucket.key,
			label: bucket.label,
			count: bucketRecords.length,
			resolved: resolved.length,
			failed,
			failureRate: resolved.length === 0 ? null : failed / resolved.length,
		};
	});
}

// 输入：记录数组。输出：超过 1KB/4KB/16KB/64KB 载荷的调用数。
// 阈值覆盖“普通编辑 / 大段粘贴 / 接近工具上限”的区间。
function buildHugeReplacementStats(records) {
	const thresholds = [1024, 4096, 16384, 65536];
	return thresholds.map((threshold) => ({
		threshold,
		count: records.filter((record) => record.totalEditBytes > threshold).length,
	}));
}

// 输入：记录与 top N。输出：按膨胀比降序（null 视为无穷大）的最差样例摘要。
// 同分时按载荷字节降序，再按路径字典序，保证输出稳定。
function buildWorstExamples(records, top) {
	const scored = [...records].sort((a, b) => {
		const aScore = a.inflationRatio === null ? Number.POSITIVE_INFINITY : a.inflationRatio;
		const bScore = b.inflationRatio === null ? Number.POSITIVE_INFINITY : b.inflationRatio;
		if (aScore !== bScore) return bScore - aScore;
		if (a.totalEditBytes !== b.totalEditBytes) return b.totalEditBytes - a.totalEditBytes;
		return a.path.localeCompare(b.path);
	});

	// 只输出摘要字段，不带完整 old/new 文本，避免报告泄漏代码内容或过大。
	return scored.slice(0, top).map((record) => ({
		providerModel: record.providerModel,
		extension: record.extension,
		path: record.path,
		inflationRatio: record.inflationRatio,
		totalEditBytes: record.totalEditBytes,
		coreBytes: record.coreBytes,
		mode: record.mode,
		editsCount: record.editsCount,
		failed: record.success === false,
		errorKind: record.errorKind,
		sessionFile: record.sessionFile,
	}));
}


// 输入：已过滤记录、扫描元信息、命令行选项。输出：JSON 可序列化的完整摘要对象。
// 纯计算，无副作用；人类报告与 --json 共用这一结构，保证两种输出口径一致。
function buildSummary(records, meta, options) {
	// 一条 assistant 消息可含多个 edit toolCall；这里按消息去重。
	const uniqueAssistantMessages = new Set(records.map((record) => `${record.sessionFile}::${record.assistantEntryId}`)).size;
	// 只有拿到 toolResult 的调用才算 resolved，进入成功率分母。
	const resolved = records.filter((record) => record.success !== null);
	const success = resolved.filter((record) => record.success).length;
	const failed = resolved.filter((record) => record.success === false).length;
	const unresolved = records.length - resolved.length;
	const single = records.filter((record) => record.mode === "single").length;
	const multi = records.filter((record) => record.mode === "multi").length;
	// single/multi 两种模式各自统计成功与失败，避免整体成功率掩盖差异。
	const modeStats = ["single", "multi"].map((mode) => {
		const modeRecords = records.filter((record) => record.mode === mode);
		const modeResolved = modeRecords.filter((record) => record.success !== null);
		const modeSuccess = modeResolved.filter((record) => record.success).length;
		const modeFailed = modeResolved.filter((record) => record.success === false).length;
		return {
			mode,
			calls: modeRecords.length,
			resolved: modeResolved.length,
			success: modeSuccess,
			failed: modeFailed,
			unresolved: modeRecords.length - modeResolved.length,
			successRate: modeResolved.length === 0 ? null : modeSuccess / modeResolved.length,
			failureRate: modeResolved.length === 0 ? null : modeFailed / modeResolved.length,
		};
	});
	// 把 multi-edit 按 edits.length 分成 1、2、3+ 三桶，观察批量大小与成功率的关系。
	const multiEditLengthBuckets = [
		{ key: "1", label: "edits.length === 1", test: (record) => record.mode === "multi" && record.editsCount === 1 },
		{ key: "2", label: "edits.length === 2", test: (record) => record.mode === "multi" && record.editsCount === 2 },
		{ key: "3plus", label: "edits.length >= 3", test: (record) => record.mode === "multi" && record.editsCount >= 3 },
	].map((bucket) => {
		const bucketRecords = records.filter(bucket.test);
		const bucketResolved = bucketRecords.filter((record) => record.success !== null);
		const bucketSuccess = bucketResolved.filter((record) => record.success).length;
		const bucketFailed = bucketResolved.filter((record) => record.success === false).length;
		return {
			key: bucket.key,
			label: bucket.label,
			calls: bucketRecords.length,
			resolved: bucketResolved.length,
			success: bucketSuccess,
			failed: bucketFailed,
			unresolved: bucketRecords.length - bucketResolved.length,
			successRate: bucketResolved.length === 0 ? null : bucketSuccess / bucketResolved.length,
			failureRate: bucketResolved.length === 0 ? null : bucketFailed / bucketResolved.length,
		};
	});
	// Map 转数组后按次数降序，次数相同按风格名排序。
	const argStyles = [...groupCounts(records, (record) => record.argStyle).entries()]
		.map(([style, count]) => ({ style, count }))
		.sort((a, b) => b.count - a.count || a.style.localeCompare(b.style));
	const providerStats = summarizeGroups(records, (record) => record.providerModel);
	const extensionStats = summarizeGroups(records, (record) => record.extension);
	const inflations = collectInflations(records);
	const noCoreChange = records.filter((record) => record.inflationRatio === null).length;
	// 病理阈值只看“载荷至少是核心的 N 倍”，其余分位统计见 inflation。
	const pathologicalThresholds = [10, 25, 100].map((threshold) => ({
		threshold,
		count: records.filter((record) => record.inflationRatio !== null && record.inflationRatio >= threshold).length,
	}));
	// 失败类型只统计 success === false；missing_result 不在其中（它属于 unresolved）。
	const failureKinds = [...groupCounts(records.filter((record) => record.success === false), (record) => record.errorKind ?? "other").entries()]
		.map(([kind, count]) => ({ kind, count }))
		.sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

	return {
		// filters 记录生效的过滤条件，便于比较不同报告。
		filters: {
			model: options.modelFilter ?? null,
			extension: options.extFilter ?? null,
			failedOnly: options.failedOnly,
		},
		// scan 记录扫描范围与解析异常，区分“没有失败”与“没有读到数据”。
		scan: {
			sessionsDir: meta.sessionsDir,
			sessionFilesScanned: meta.sessionFilesScanned,
			sessionFilesIncluded: meta.sessionFilesIncluded,
			sessionFilesSkippedOlderThanSince: meta.sessionFilesSkippedOlderThanSince,
			sessionFilesWithEditCalls: meta.sessionFilesWithEditCalls,
			since: meta.since ? { ms: meta.since.ms, iso: formatIso(meta.since.ms), source: meta.since.source } : null,
			malformedLines: meta.malformedLines,
			unmatchedToolResults: meta.unmatchedToolResults,
		},
		counts: {
			assistantMessagesWithEditCalls: uniqueAssistantMessages,
			totalEditCalls: records.length,
			resolvedEditCalls: resolved.length,
			success,
			failed,
			unresolved,
			single,
			multi,
			noCoreChange,
		},
		modeStats,
		multiEditLengthBuckets,
		argStyles,
		providerStats,
		extensionStats,
		inflation: {
			median: quantile(inflations, 0.5),
			p90: quantile(inflations, 0.9),
			p95: quantile(inflations, 0.95),
			p99: quantile(inflations, 0.99),
			pathologicalThresholds,
			hugeReplacements: buildHugeReplacementStats(records),
			failureByBucket: buildInflationBuckets(records),
		},
		sameFileClusters: buildSameFileClusterStats(records),
		failureKinds,
		worstExamples: buildWorstExamples(records, options.top),
	};
}

// 输入：标题、分组数组、单组格式化函数。输出：无。副作用：打印非空分组。
// 空数组直接不打印，避免报告出现只有标题的空段。
function printGroupTable(title, groups, formatter) {
	if (groups.length === 0) return;
	console.log(`\n${title}`);
	for (const group of groups) {
		console.log(formatter(group));
	}
}

// 输入：buildSummary 的结果。输出：无。副作用：按固定章节打印人类可读报告。
function printHumanReport(summary) {
	const { scan, counts, modeStats, multiEditLengthBuckets, argStyles, providerStats, extensionStats, inflation, sameFileClusters, failureKinds, worstExamples, filters } = summary;
	console.log(`Scanned ${formatInt(scan.sessionFilesIncluded)} session files in ${scan.sessionsDir}`);
	if (scan.since) {
		console.log(`Session filter: files created at or after ${scan.since.iso} (${scan.since.source})`);
		console.log(`Skipped older session files: ${formatInt(scan.sessionFilesSkippedOlderThanSince)} of ${formatInt(scan.sessionFilesScanned)}`);
	}
	console.log(`Found ${formatInt(counts.totalEditCalls)} edit tool calls in ${formatInt(counts.assistantMessagesWithEditCalls)} assistant messages`);
	if (filters.model || filters.extension || filters.failedOnly) {
		const filterParts = [];
		if (filters.model) filterParts.push(`model contains \"${filters.model}\"`);
		if (filters.extension) filterParts.push(`extension = ${filters.extension}`);
		if (filters.failedOnly) filterParts.push("failed only");
		console.log(`Filters: ${filterParts.join(", ")}`);
	}

	console.log("\nSuccess rate");
	console.log(`  success:    ${formatInt(counts.success)}  ${formatPercent(counts.success, counts.resolvedEditCalls)}`);
	console.log(`  failed:     ${formatInt(counts.failed)}  ${formatPercent(counts.failed, counts.resolvedEditCalls)}`);
	console.log(`  unresolved: ${formatInt(counts.unresolved)}`);

	console.log("\nMode usage");
	console.log(`  single replacement: ${formatInt(counts.single)}  ${formatPercent(counts.single, counts.totalEditCalls)}`);
	console.log(`  multi-edit (edits): ${formatInt(counts.multi)}  ${formatPercent(counts.multi, counts.totalEditCalls)}`);

	console.log("\nFailures by edit type");
	for (const mode of modeStats) {
		console.log(
			`  ${mode.mode.padEnd(6)} calls=${formatInt(mode.calls).padStart(4)} success=${mode.successRate === null ? "n/a" : formatPercent(mode.success, mode.resolved).padStart(6)} failed=${mode.failureRate === null ? "n/a" : formatPercent(mode.failed, mode.resolved).padStart(6)} unresolved=${formatInt(mode.unresolved)}`
		);
	}

	console.log("\nMulti-edit bucket split");
	for (const bucket of multiEditLengthBuckets) {
		console.log(
			`  ${bucket.label.padEnd(20)} ${formatInt(bucket.calls).padStart(4)} calls  success=${bucket.successRate === null ? "n/a" : formatPercent(bucket.success, bucket.resolved).padStart(6)} failed=${bucket.failureRate === null ? "n/a" : formatPercent(bucket.failed, bucket.resolved).padStart(6)}`
		);
	}

	console.log("\nArgument style");
	for (const entry of argStyles) {
		console.log(`  ${entry.style.padEnd(22)} ${formatInt(entry.count).padStart(8)}  ${formatPercent(entry.count, counts.totalEditCalls)}`);
	}

	printGroupTable("By provider/model", providerStats, (group) => {
		return [
			`  ${group.key}`,
			`    calls: ${formatInt(group.calls)}`,
			`    success: ${group.successRate === null ? "n/a" : formatPercent(group.success, group.resolved)}`,
			`    multi-edit: ${group.multiRate === null ? "n/a" : formatPercent(group.multi, group.calls)}`,
			`    median inflation: ${formatRatio(group.medianInflation)}`,
			`    p95 inflation: ${formatRatio(group.p95Inflation)}`,
		].join("\n");
	});

	printGroupTable("By file extension", extensionStats, (group) => {
		return `  ${group.key.padEnd(10)} calls=${formatInt(group.calls).padStart(6)}  success=${group.successRate === null ? "n/a" : formatPercent(group.success, group.resolved).padStart(6)}  medianInflation=${formatRatio(group.medianInflation)}`;
	});

	console.log("\nContext inflation");
	console.log(`  median inflation: ${formatRatio(inflation.median)}`);
	console.log(`  p90 inflation:    ${formatRatio(inflation.p90)}`);
	console.log(`  p95 inflation:    ${formatRatio(inflation.p95)}`);
	console.log(`  p99 inflation:    ${formatRatio(inflation.p99)}`);
	console.log(`  no-core-change:   ${formatInt(counts.noCoreChange)}`);

	console.log("\nHuge replacements");
	for (const entry of inflation.hugeReplacements) {
		console.log(`  >${formatBytes(entry.threshold).padEnd(6)} ${formatInt(entry.count).padStart(8)}`);
	}

	console.log("\nPathological wrappers");
	for (const entry of inflation.pathologicalThresholds) {
		console.log(`  inflation >= ${String(entry.threshold).padEnd(3)}x ${formatInt(entry.count).padStart(8)}`);
	}

	console.log("\nSame-file multi-call behavior");
	console.log(`  assistant msgs with 2+ edit calls to same file: ${formatInt(sameFileClusters.assistantMessagesWithCluster)}`);
	console.log(`  total same-file clusters:                      ${formatInt(sameFileClusters.clustersCount)}`);
	console.log(`  calls inside those clusters:                  ${formatInt(sameFileClusters.callsInsideClusters)}`);
	console.log(`  average calls per cluster:                    ${sameFileClusters.averageCallsPerCluster === null ? "n/a" : sameFileClusters.averageCallsPerCluster.toFixed(2)}`);
	console.log(`  assistant msgs using one multi-edit call:     ${formatInt(sameFileClusters.assistantMessagesWithMultiEdit)}`);
	console.log(`  ratio multi-call / multi-edit assistant msgs: ${sameFileClusters.ratioClusterAssistantMessagesToMultiEditAssistantMessages === null ? "n/a" : sameFileClusters.ratioClusterAssistantMessagesToMultiEditAssistantMessages.toFixed(2)}`);

	console.log("\nFailures by kind");
	if (failureKinds.length === 0) {
		console.log("  none");
	} else {
		for (const failure of failureKinds) {
			console.log(`  ${failure.kind.padEnd(22)} ${formatInt(failure.count).padStart(8)}`);
		}
	}

	console.log("\nFailure rate by inflation bucket");
	for (const bucket of inflation.failureByBucket) {
		console.log(`  ${bucket.label.padEnd(14)} ${bucket.failureRate === null ? "n/a" : formatPercent(bucket.failed, bucket.resolved).padStart(6)}  (${formatInt(bucket.count)} calls)`);
	}

	console.log(`\nWorst ${formatInt(worstExamples.length)} examples`);
	for (let i = 0; i < worstExamples.length; i++) {
		const example = worstExamples[i];
		console.log(
			`  ${i + 1}. ${example.providerModel} ${example.extension} inflation=${formatRatio(example.inflationRatio)} failed=${example.failed ? example.errorKind : "false"}`
		);
		console.log(`     path: ${example.path}`);
		console.log(`     totalEditBytes=${formatBytes(example.totalEditBytes)} coreBytes=${formatBytes(example.coreBytes)} mode=${example.mode} edits=${example.editsCount}`);
	}

	if (scan.malformedLines > 0 || scan.unmatchedToolResults > 0) {
		console.log("\nParser notes");
		if (scan.malformedLines > 0) console.log(`  malformed lines skipped: ${formatInt(scan.malformedLines)}`);
		if (scan.unmatchedToolResults > 0) console.log(`  unmatched edit tool results: ${formatInt(scan.unmatchedToolResults)}`);
	}
}

// 输入：会话根目录与 since 过滤（null 表示不过滤）。输出：{records, meta}。
// 主流程：遍历 .jsonl → 按文件名时间跳过旧文件 → 逐行解析 → assistant edit toolCall 建记录 →
//   toolResult 回填成功/失败 → 文件结束后把未匹配调用标记为 unresolved。
// 内存：单文件逐行流式读取；records 会保留整个扫描范围内所有 edit 调用。
async function scanSessions(sessionsDir, since) {
	const records = [];
	const meta = {
		sessionsDir,
		sessionFilesScanned: 0,
		sessionFilesIncluded: 0,
		sessionFilesSkippedOlderThanSince: 0,
		sessionFilesWithEditCalls: 0,
		since,
		malformedLines: 0,
		unmatchedToolResults: 0,
	};

	for await (const sessionFile of walkJsonlFiles(sessionsDir)) {
		meta.sessionFilesScanned++;
		const sessionTimestampMs = parseSessionFileTimestamp(sessionFile);
		// 文件名时间不可解析时保守地包含该文件，而不是静默丢弃。
		if (since && sessionTimestampMs !== null && sessionTimestampMs < since.ms) {
			meta.sessionFilesSkippedOlderThanSince++;
			continue;
		}
		meta.sessionFilesIncluded++;
		// 同一文件内按 toolCallId 等待对应的 toolResult；跨文件不会配对。
		const pending = new Map();
		let fileHadEditCall = false;
		const input = createReadStream(sessionFile, { encoding: "utf8" });
		// crlfDelay: Infinity 让 \r\n 被当作单个换行，避免 Windows 会话行尾残留 \r。
		const rl = createInterface({ input, crlfDelay: Infinity });

		for await (const line of rl) {
			if (!line.trim()) continue;
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				// 坏行计数并继续；会话是追加写入的，最后一行可能不完整。
				meta.malformedLines++;
				continue;
			}

			if (entry?.type !== "message" || !entry.message) continue;
			const message = entry.message;

			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const block of message.content) {
					// 只关心内建 edit 的 toolCall；其他工具忽略。
					if (block?.type !== "toolCall" || block.name !== "edit") continue;
					fileHadEditCall = true;
					const analysis = analyzeToolArguments(block.arguments);
					const record = {
						sessionFile,
						assistantEntryId: entry.id,
						toolCallId: typeof block.id === "string" ? block.id : "",
						timestamp: entry.timestamp,
						api: typeof message.api === "string" ? message.api : null,
						// provider/model 是会话数据（外部输入），缺失时用占位符保证分组键稳定。
						provider: typeof message.provider === "string" ? message.provider : "[unknown]",
						model: typeof message.model === "string" ? message.model : "[unknown]",
						providerModel: `${typeof message.provider === "string" ? message.provider : "[unknown]"}/${typeof message.model === "string" ? message.model : "[unknown]"}`,
						success: null,
						errorKind: null,
						errorText: "",
						resultSummary: "",
						matchedResult: false,
						...analysis,
					};
					records.push(record);
					// 没有 id 的调用无法配对，留待文件结束后标记为 missing_result。
					if (record.toolCallId) pending.set(record.toolCallId, record);
				}
			}

			if (message.role === "toolResult" && message.toolName === "edit") {
				const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
				const record = pending.get(toolCallId);
				if (!record) {
					// 结果先于调用或来自被截断的会话；计数但不创建记录。
					meta.unmatchedToolResults++;
					continue;
				}
				const text = extractTextContent(message.content);
				record.matchedResult = true;
				// isError 明确为 true 才算失败；缺失或 false 都按成功处理。
				record.success = message.isError === true ? false : true;
				record.resultSummary = text;
				record.errorText = message.isError === true ? text : "";
				record.errorKind = classifyErrorKind(text, message.isError === true, true);
				pending.delete(toolCallId);
			}
		}

		// 文件读完仍未等到结果（中断/崩溃）：success 保持 null，单独分类。
		for (const record of pending.values()) {
			record.matchedResult = false;
			record.success = null;
			record.errorKind = classifyErrorKind("", false, false);
		}

		if (fileHadEditCall) meta.sessionFilesWithEditCalls++;
	}

	return { records, meta };
}

// 输入：记录与 options。输出：过滤后的新数组。
// 顺序：model 子串（大小写不敏感）→ 扩展名精确匹配（已在 parseArgs 小写）→ failedOnly。
function applyFilters(records, options) {
	return records.filter((record) => {
		if (options.modelFilter && !record.providerModel.toLowerCase().includes(options.modelFilter.toLowerCase())) {
			return false;
		}
		if (options.extFilter && record.extension !== options.extFilter) {
			return false;
		}
		// failedOnly 只保留明确失败；unresolved（success === null）不算失败。
		if (options.failedOnly && record.success !== false) {
			return false;
		}
		return true;
	});
}

// 主入口：解析参数 → 帮助短路 → 解析并确认会话目录 → 计算 since → 扫描 → 过滤 → 汇总 → 输出。
// 错误通过 reject 传播到文件底部的 catch。
async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}

	const sessionsDir = path.resolve(options.sessionsDir);
	// access 在目录不存在或无权限时抛出，随后由 catch 打印消息并退出 1。
	await fs.access(sessionsDir);
	const since = await resolveAutoSinceMs(options);

	const { records, meta } = await scanSessions(sessionsDir, since);
	const filteredRecords = applyFilters(records, options);
	// meta 记录的是过滤前扫描范围；filters/counts 来自过滤后记录。
	const summary = buildSummary(filteredRecords, meta, options);

	if (options.json) {
		// --include-records 才附带原始记录（可能很大）；默认只输出摘要。
		const output = options.includeRecords ? { summary, records: filteredRecords } : { summary };
		console.log(JSON.stringify(output, null, 2));
		return;
	}

	printHumanReport(summary);
}

// 顶层兜底：把异常转成一行 stderr 并以 1 退出；正常路径返回 0。
main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
