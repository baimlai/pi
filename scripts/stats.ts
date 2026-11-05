#!/usr/bin/env node

// 文件导读：按本地日历天统计某个项目的 token 用量与费用，数据来自 pi 会话 JSONL。
// 所属：仓库根 `scripts/` 的会话分析脚本系列；这个脚本按 cwd 只看一个项目的会话。
// 作用：读取 `~/.pi/agent/sessions/<encoded cwd>/*.jsonl` 中 assistant 消息的 usage，
//   汇总最近 N 天的 input/output/cacheRead/cacheWrite/totalTokens 与 cost，并按天、按 provider 输出。
// 上游：手动运行 `node scripts/stats.ts [-n days] [-d cwd] [--sessions-base dir]`；
//   默认 7 天、当前 cwd、`~/.pi/agent/sessions`。
// 下游：只读会话文件；stdout 打印表格。没有 JSON/HTML 输出，也不写文件。
// 输出与错误：会话目录不存在时抛错，Node 以未捕获异常退出（退出码 1）；--help 打印用法并 exit(0)。
//   单行 JSON 解析失败静默跳过；没有 usage 的 assistant 消息不计入。
// 能力清单：
//   - createTotals/createDayStats/addUsage：累计 token 与费用。
//   - encodeSessionDir：cwd → 会话目录名。
//   - localDayKey/parseArgs：本地日期键与 CLI 解析。
//   - printTotals：对齐输出一行统计。
// 典型调用与预期：
//   示例 `node scripts/stats.ts --days 3 --cwd /Users/me/repo`；
//   打印 `Usage for ...`、每天与每个 provider 的 token/费用行，最后一行 TOTAL。
// 阅读顺序：先看类型与 createTotals，再看 addUsage 的累加字段，最后读文件末尾的顶层统计循环。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// 费用明细；所有字段可选，因为旧会话可能只记录部分成本。
interface UsageCost {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	total?: number;
}

// 一次 assistant 请求的 usage：token 计数与可选费用。interface 只是编译期形状，
// 运行时仍直接读取 JSON 字段；下面用 `?? 0` 兜底缺失值。
interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: UsageCost;
}

// 会话 JSONL 中 message 字段的最小视图；role 用来筛 assistant，provider 用来分组。
interface AssistantMessage {
	role?: string;
	provider?: string;
	usage?: Usage;
	timestamp?: number;
}

// 会话条目的外层结构：只声明统计需要的字段；type 用于筛 message。
interface SessionEntry {
	type?: string;
	timestamp?: string;
	message?: AssistantMessage;
}

// 一组累计值：token、费用、assistant 消息数与涉及会话文件集合。
// sessions 用 Set 去重，因此同一会话的多条消息只计一次会话。
interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	costTotal: number;
	assistantMessages: number;
	sessions: Set<string>;
}

// 一天的统计在 Totals 基础上再按 provider 拆分；extends 让 DayStats 拥有全部累计字段。
interface DayStats extends Totals {
	providers: Map<string, Totals>;
}

// 解析后的 CLI 参数；resolve 已在 parseArgs 中完成，这里都是绝对路径。
interface Args {
	days: number;
	cwd: string;
	sessionsBase: string;
}

// 返回一份全零的累计对象；每次新建 Set，避免不同天共享同一个集合。
function createTotals(): Totals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		costInput: 0,
		costOutput: 0,
		costCacheRead: 0,
		costCacheWrite: 0,
		costTotal: 0,
		assistantMessages: 0,
		sessions: new Set<string>(),
	};
}

// 新建一天的统计：展开 Totals 的全零字段，再加空的 provider→Totals 映射。
function createDayStats(): DayStats {
	return {
		...createTotals(),
		providers: new Map<string, Totals>(),
	};
}

// 把一条 usage 累加到 totals：缺失字段按 0 处理，消息数加一，sessionFile 加入去重集合。
// 该函数有可变副作用；同一 usage 会被同时累加到 day、provider 与 grandTotal 三个对象。
function addUsage(totals: Totals, usage: Usage, sessionFile: string): void {
	const cost = usage.cost ?? {};
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.totalTokens += usage.totalTokens ?? 0;
	totals.costInput += cost.input ?? 0;
	totals.costOutput += cost.output ?? 0;
	totals.costCacheRead += cost.cacheRead ?? 0;
	totals.costCacheWrite += cost.cacheWrite ?? 0;
	totals.costTotal += cost.total ?? 0;
	totals.assistantMessages += 1;
	totals.sessions.add(sessionFile);
}

// 把 cwd 编码为会话目录名：去掉开头 `/`，把剩余 `/` 换成 `-`，两端加 `--`。
// 例：encodeSessionDir("/Users/me/repo") → "--Users-me-repo--"。
function encodeSessionDir(cwd: string): string {
	const normalized = cwd.startsWith("/") ? cwd.slice(1) : cwd;
	return `--${normalized.replace(/\//g, "-")}--`;
}

// 用本地时区（而非 UTC）生成 YYYY-MM-DD 键；月份补零，保证字符串排序等于日期排序。
function localDayKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

// 解析 CLI：默认 7 天、当前 cwd、~/.pi/agent/sessions。
// 带值选项只有在下一个参数存在时才消费；--help 立即打印用法并 exit(0)。
// 返回前校验 days 为正整数，否则抛错（顶层未捕获，退出码 1）。
function parseArgs(): Args {
	const args = process.argv.slice(2);
	let days = 7;
	let cwd = process.cwd();
	let sessionsBase = join(homedir(), ".pi", "agent", "sessions");

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if ((arg === "--days" || arg === "-n") && args[i + 1]) {
			// ++i 前移到值，for 再自增时跳过值；parseInt 遇到非数字得到 NaN，后续校验拒绝。
			days = Number.parseInt(args[++i], 10);
		} else if ((arg === "--cwd" || arg === "--dir" || arg === "-d") && args[i + 1]) {
			cwd = resolve(args[++i]);
		} else if (arg === "--sessions-base" && args[i + 1]) {
			sessionsBase = resolve(args[++i]);
		} else if (arg === "--help" || arg === "-h") {
			// 用法模板字符串；${...} 无动态值，打印后立即正常退出。
			console.log(`Usage: scripts/stats.ts [options]

Options:
  -n, --days <days>         Number of local calendar days to include (default: 7)
  -d, --dir, --cwd <path>   Project cwd to inspect (default: current cwd)
  --sessions-base <path>    Sessions base directory (default: ~/.pi/agent/sessions)
  -h, --help                Show this help`);
			process.exit(0);
		}
	}

	// Number.isInteger 同时排除 NaN、小数与负数；不合法直接抛错。
	if (!Number.isInteger(days) || days <= 0) {
		throw new Error("--days must be a positive integer");
	}

	return { days, cwd: resolve(cwd), sessionsBase };
}

// 千分位整数：先四舍五入，再用 en-US 规则加逗号。
function formatInt(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

// 费用固定 4 位小数并加美元符号；不处理货币单位换算。
function formatCost(value: number): string {
	return `$${value.toFixed(4)}`;
}

// 打印一行统计：label 左对齐 16 列，各数字右对齐；provider 行通过 label 前缀缩进。
function printTotals(label: string, totals: Totals): void {
	console.log(
		`${label.padEnd(16)} messages: ${String(totals.assistantMessages).padStart(5)}  sessions: ${String(totals.sessions.size).padStart(3)}  ` +
			`input: ${formatInt(totals.input).padStart(12)}  output: ${formatInt(totals.output).padStart(10)}  ` +
			`cache read: ${formatInt(totals.cacheRead).padStart(13)}  cache write: ${formatInt(totals.cacheWrite).padStart(10)}  ` +
			`total: ${formatInt(totals.totalTokens).padStart(13)}  cost: ${formatCost(totals.costTotal).padStart(10)}`,
	);
}

// 以下是顶层执行代码（没有 main 包装）：parseArgs 出错会作为未捕获异常让进程以 1 退出。
const { days, cwd, sessionsBase } = parseArgs();
const sessionsDir = join(sessionsBase, encodeSessionDir(cwd));

// 目录不存在说明该 cwd 没有会话记录；直接抛错比输出空表更明确。
if (!existsSync(sessionsDir)) {
	throw new Error(`Sessions directory not found: ${sessionsDir}`);
}

// 统计区间是“今天往前 days-1 天”的本地日历日，含今天。
// start 是第一天 00:00，end 是明天 00:00（左闭右开，避免把明天零点算进来）。
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
start.setDate(start.getDate() - days + 1);
const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

// stats 以本地日期为键；grandTotal 独立累加所有天。
const stats = new Map<string, DayStats>();
const grandTotal = createTotals();

for (const file of readdirSync(sessionsDir)) {
	if (!file.endsWith(".jsonl")) continue;

	const path = join(sessionsDir, file);
	// 一次读入整个文件并按行拆分；会话文件通常不大，这里没有流式处理。
	const lines = readFileSync(path, "utf8").split("\n");
	for (const line of lines) {
		if (!line.trim()) continue;

		let entry: SessionEntry;
		try {
			entry = JSON.parse(line) as SessionEntry;
		} catch {
			// 单行损坏跳过；统计脚本不必因一条坏记录失败。
			continue;
		}

		// 只统计有 usage 的 assistant 消息；工具结果、user 消息与无 usage 的条目都跳过。
		if (entry.type !== "message" || entry.message?.role !== "assistant" || !entry.message.usage) continue;

		// 优先使用消息内 timestamp（毫秒数字）；否则解析条目的 ISO timestamp；都没有则 epoch 0。
		const timestamp = entry.message.timestamp !== undefined ? new Date(entry.message.timestamp) : new Date(entry.timestamp ?? 0);
		// 左闭右开区间；不在最近 days 天内的记录忽略。
		if (timestamp < start || timestamp >= end) continue;

		const dayKey = localDayKey(timestamp);
		// 第一次遇到某天时创建 DayStats；Map 保留插入顺序，但输出前会排序。
		let dayStats = stats.get(dayKey);
		if (!dayStats) {
			dayStats = createDayStats();
			stats.set(dayKey, dayStats);
		}

		const provider = entry.message.provider ?? "unknown";
		// 每个 provider 在当天有独立 Totals；没有 provider 字段归为 unknown。
		let providerStats = dayStats.providers.get(provider);
		if (!providerStats) {
			providerStats = createTotals();
			dayStats.providers.set(provider, providerStats);
		}

		// 同一条 usage 累加三次：当天总计、当天该 provider、全局总计。
		addUsage(dayStats, entry.message.usage, file);
		addUsage(providerStats, entry.message.usage, file);
		addUsage(grandTotal, entry.message.usage, file);
	}
}

console.log(`Usage for ${cwd}`);
console.log(`Sessions: ${sessionsDir}`);
// end 是明天零点，减 1ms 得到今天最后一刻，用于显示区间结束日期。
console.log(`Period: ${localDayKey(start)} through ${localDayKey(new Date(end.getTime() - 1))} (${days} local days)`);
console.log("".padEnd(160, "="));

// 按日期键排序后输出每一天，并在其下按 provider 名称排序输出明细。
for (const day of [...stats.keys()].sort()) {
	const dayStats = stats.get(day)!;
	printTotals(day, dayStats);
	for (const provider of [...dayStats.providers.keys()].sort()) {
		printTotals(`  ${provider}`, dayStats.providers.get(provider)!);
	}
}

// 分隔线后输出全局总计。
console.log("".padEnd(160, "-"));
printTotals("TOTAL", grandTotal);
