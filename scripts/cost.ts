#!/usr/bin/env node

// 文件导读
// 所属：仓库根 scripts/ 的本地费用统计脚本，不属于构建或 CI 检查，供开发者按项目查看历史花费。
// 职责：读取 ~/.pi/agent/sessions 下某个工作目录对应的会话 JSONL，按天、按 provider 汇总 assistant 消息里
//   usage.cost 的 total/input/output/cacheRead/cacheWrite 与请求数，打印明细和总计。
// 上游：手动执行 node scripts/cost.ts -d <工作目录> -n <天数>（Node 22+ 可直接类型剥离运行 .ts）。
// 输入：命令行 -d/--dir（必填，原始工作目录的绝对路径）与 -n/--days（必填，回看天数）；会话目录由 HOME 推导。
// 输出：stdout 表格；无数据时打印提示。退出码：0 = 成功或无数据/帮助；1 = 参数缺失或会话目录不存在。
// 副作用：只读会话文件（不联网、不写文件），不调用模型；重复执行结果一致，但会随会话文件增长而变化。
// 示例：
//   node scripts/cost.ts -d /Users/me/project -n 7        # 最近 7 天
//   node scripts/cost.ts --dir /Users/me/project --days 30
// 建议阅读顺序：先看参数解析与目录编码，再看 cutoff 与逐文件聚合，最后看两级汇总输出。

// fs 用于同步读目录/文件；path 用于跨平台拼接路径。
import * as fs from "fs";
import * as path from "path";

// Parse args
const args = process.argv.slice(2);
// 两个必填值先用 undefined 表示“未提供”；parseInt 结果可能是 NaN，后续 !days 也会拒绝。
let directory: string | undefined;
let days: number | undefined;

for (let i = 0; i < args.length; i++) {
	if (args[i] === "--dir" || args[i] === "-d") {
		// ++i 先自增再取值，因此下一个参数就是值；缺少值时得到 undefined。
		directory = args[++i];
	} else if (args[i] === "--days" || args[i] === "-n") {
		// 以 10 为基数解析，避免前导 0 被当作八进制。
		days = parseInt(args[++i], 10);
	} else if (args[i] === "--help" || args[i] === "-h") {
		console.log(`Usage: cost.ts -d <path> -n <days>
  -d, --dir <path>   Directory path (required)
  -n, --days <num>   Number of days to track (required)
  -h, --help         Show this help`);
		// 帮助是成功路径，立即以 0 结束，不继续要求参数。
		process.exit(0);
	}
}

// NaN 与 0 在布尔判断中都是假值，因此“--days abc”或“--days 0”都会走到这里。
if (!directory || !days) {
	console.error("Error: both --dir and --days are required");
	console.error("Run with --help for usage");
	process.exit(1);
}

// Encode directory path to session folder name
// 输入：工作目录绝对路径。输出：pi 会话目录使用的名称。
// 规则：去掉开头 /，把内部 / 换成 -，两端包 --。例：/Users/me/p → --Users-me-p--。
function encodeSessionDir(dir: string): string {
	// Remove leading slash, replace remaining slashes with dashes
	const normalized = dir.startsWith("/") ? dir.slice(1) : dir;
	return "--" + normalized.replace(/\//g, "-") + "--";
}

// HOME 由环境变量注入；这里用非空断言是脚本级约定，Windows 没有 HOME 时会得到 undefined 并在 join 处报错。
const sessionsBase = path.join(process.env.HOME!, ".pi/agent/sessions");
const encodedDir = encodeSessionDir(directory);
const sessionsDir = path.join(sessionsBase, encodedDir);

// 目录不存在通常意味着该工作目录从未运行过 pi，或 HOME 不对；给出明确路径便于排查。
if (!fs.existsSync(sessionsDir)) {
	console.error(`Sessions directory not found: ${sessionsDir}`);
	process.exit(1);
}

// Get cutoff date
const cutoff = new Date();
// setDate 能自动跨月/跨年；随后归零到当天 00:00:00，使“最近 N 天”按自然日包含今天。
cutoff.setDate(cutoff.getDate() - days);
cutoff.setHours(0, 0, 0, 0);

// 单日、单个 provider 的累计值；请求数单位是 assistant 消息条数，不是底层 HTTP 请求数。
interface DayCost {
	total: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	requests: number;
}

// 两级索引：stats[day][provider] = DayCost；索引签名让 day 与 provider 都是动态字符串键。
interface Stats {
	[day: string]: {
		[provider: string]: DayCost;
	};
}

const stats: Stats = {};

// Process session files
// 只处理 .jsonl；其他文件（如锁文件或子目录）忽略。
const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));

for (const file of files) {
	// Extract timestamp from filename: <timestamp>_<uuid>.jsonl
	// Format: 2025-12-17T08-25-07-381Z (dashes instead of colons)
	// 文件名时间戳是 ISO 8601 的“冒号替换成短横线”变体，用于避免 Windows 文件名限制。
	const timestamp = file.split("_")[0];
	// Convert back to valid ISO: replace T08-25-07-381Z with T08:25:07.381Z
	const isoTimestamp = timestamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, "T$1:$2:$3.$4Z");
	const fileDate = new Date(isoTimestamp);

	// 先按文件名时间快速跳过过期会话；文件内每条消息还会按自身时间戳分日。
	if (fileDate < cutoff) continue;

	const filepath = path.join(sessionsDir, file);
	const content = fs.readFileSync(filepath, "utf8");
	// trim 去掉末尾换行；按行切分后逐行解析（JSONL = 一行一个 JSON）。
	const lines = content.trim().split("\n");

	for (const line of lines) {
		// 空行（例如文件结尾多出的换行）直接跳过。
		if (!line) continue;

		try {
			const entry = JSON.parse(line);

			// 会话文件也含用户消息、工具结果等；只统计 assistant 且带 usage.cost 的消息。
			if (entry.type !== "message") continue;
			if (entry.message?.role !== "assistant") continue;
			if (!entry.message?.usage?.cost) continue;

			const { provider, usage } = entry.message;
			const { cost } = usage;
			// 分日使用消息自身时间戳（ISO 字符串 → Date），而不是文件名时间。
			const entryDate = new Date(entry.timestamp);
			const day = entryDate.toISOString().split("T")[0];

			// 懒初始化：只有真正出现数据才创建当天/该 provider 的桶。
			if (!stats[day]) stats[day] = {};
			if (!stats[day][provider]) {
				stats[day][provider] = {
					total: 0,
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					requests: 0,
				};
			}

			// 字段缺失时用 0 兜底；请求数直接加 1。
			stats[day][provider].total += cost.total || 0;
			stats[day][provider].input += cost.input || 0;
			stats[day][provider].output += cost.output || 0;
			stats[day][provider].cacheRead += cost.cacheRead || 0;
			stats[day][provider].cacheWrite += cost.cacheWrite || 0;
			stats[day][provider].requests += 1;
		} catch {
			// Skip malformed lines
			// 单行 JSON 损坏（例如写入中断）不应让整个统计失败；静默跳过。
		}
	}
}

// Sort days and output
// 键是 YYYY-MM-DD，字符串排序即时间顺序。
const sortedDays = Object.keys(stats).sort();

if (sortedDays.length === 0) {
	console.log(`No sessions found in the last ${days} days for: ${directory}`);
	// 无数据不是错误，以 0 退出，便于脚本串联。
	process.exit(0);
}

console.log(`\nCost breakdown for: ${directory}`);
console.log(`Period: last ${days} days (since ${cutoff.toISOString().split("T")[0]})`);
// 80 个等号作为分隔线；repeat 比手写长字符串更易读。
console.log("=".repeat(80));

let grandTotal = 0;
const providerTotals: { [p: string]: DayCost } = {};

for (const day of sortedDays) {
	console.log(`\n${day}`);
	console.log("-".repeat(40));

	let dayTotal = 0;
	const providers = Object.keys(stats[day]).sort();

	for (const provider of providers) {
		const s = stats[day][provider];
		dayTotal += s.total;

		// 跨天累计同一 provider 的总量；与逐日输出共用同一结构。
		if (!providerTotals[provider]) {
			providerTotals[provider] = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
		}
		providerTotals[provider].total += s.total;
		providerTotals[provider].input += s.input;
		providerTotals[provider].output += s.output;
		providerTotals[provider].cacheRead += s.cacheRead;
		providerTotals[provider].cacheWrite += s.cacheWrite;
		providerTotals[provider].requests += s.requests;

		// padEnd/padStart 对齐列；费用保留 4 位小数，cache 显示读+写合计。
		console.log(
			`  ${provider.padEnd(15)} $${s.total.toFixed(4).padStart(8)}  (${s.requests} reqs, in: $${s.input.toFixed(4)}, out: $${s.output.toFixed(4)}, cache: $${(s.cacheRead + s.cacheWrite).toFixed(4)})`
		);
	}

	console.log(`  ${"Day total:".padEnd(15)} $${dayTotal.toFixed(4).padStart(8)}`);
	grandTotal += dayTotal;
}

console.log("\n" + "=".repeat(80));
console.log("TOTALS BY PROVIDER");
console.log("-".repeat(40));

for (const provider of Object.keys(providerTotals).sort()) {
	const t = providerTotals[provider];
	console.log(
		`  ${provider.padEnd(15)} $${t.total.toFixed(4).padStart(8)}  (${t.requests} reqs, in: $${t.input.toFixed(4)}, out: $${t.output.toFixed(4)}, cache: $${(t.cacheRead + t.cacheWrite).toFixed(4)})`
	);
}

console.log("-".repeat(40));
console.log(`  ${"GRAND TOTAL:".padEnd(15)} $${grandTotal.toFixed(4).padStart(8)}`);
console.log();
