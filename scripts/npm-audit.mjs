// 文件导读
// 所属：仓库根 scripts/，是 CI 依赖审计的入口；.github/workflows/npm-audit.yml 直接运行 `node scripts/npm-audit.mjs`。
// 作用：执行 `npm audit --omit=dev --json`，只审视生产依赖（devDependencies 不发布给用户），
// 对达到 moderate 及以上的漏洞失败；允许一个显式白名单记录“已复核但不适用于本项目”的公告。
// 上游：GitHub Actions 的 npm-audit workflow；也可本地手动运行（需要网络访问 npm registry）。
// 下游：spawnSync 调 npm；本文件不写文件、不改 package.json、不自动修复。
// 能力清单：
//   auditLevel / severities        - 严重度顺序，用于阈值比较。
//   acceptedAdvisories             - 白名单表；每项必须写 package 与 reason，当前为空。
//   顶层流程                       - 运行 audit、解析 JSON、过滤 via、打印接受项/过期项、失败汇总。
// 输出与退出码：
//   - 正常且无未接受漏洞：stdout 打印 "No unaccepted advisories..."，退出 0。
//   - 有未接受漏洞：stderr 列出漏洞，退出 1。
//   - npm 不可执行、JSON 解析失败、npm audit 自身报错：退出 1。
//   - 白名单条目不再匹配：stdout 输出 GitHub Actions `::warning::`，但不失败。
// 幂等性：只读检查；结果取决于当前依赖树与 registry 公告数据库。
// 示例（真实命令行）：node scripts/npm-audit.mjs
// 阅读顺序：先看白名单与严重度常量，再看 audit 调用和通过 via 的循环。
// Runs `npm audit --omit=dev` and fails on advisories at or above the audit
// level, except for advisories that were reviewed and accepted below. Every
// accepted advisory must name the affected package and explain why it does not
// apply. Remove an entry once a fixed version is installed; the script warns
// about entries that no longer match.

import { spawnSync } from "node:child_process";

// 阈值：moderate 及以上（moderate/high/critical）视为失败；低于它的 info/low 只记录在报告中。
const auditLevel = "moderate";
// 严重度从低到高排列；indexOf 得到的下标越大越严重。
const severities = ["info", "low", "moderate", "high", "critical"];

// 白名单：键是 advisory id，值必须包含受影响的包名和接受理由。
// 当前没有需要接受的公告；添加条目意味着明确承担风险，CI 会打印并持续提醒。
/** @type {Record<string, { package: string; reason: string }>} */
const acceptedAdvisories = {};

// 同步运行 npm audit；--json 让结果可解析，maxBuffer 放宽到 64 MiB 以容纳大型依赖树报告。
const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
// spawn 本身失败（例如找不到 npm）时 result.error 存在，直接抛出。
if (result.error) {
	throw result.error;
}

let report;
try {
	// npm 在存在漏洞时仍可能以非零码退出，但 stdout 仍是 JSON；因此不检查 status，只解析 stdout。
	report = JSON.parse(result.stdout);
} catch {
	// 解析失败常因 npm 输出错误文本；把 stderr 和 stdout 都转给用户，便于诊断。
	process.stderr.write(result.stderr);
	process.stderr.write(result.stdout);
	console.error("npm audit did not produce a JSON report.");
	process.exit(1);
}

// npm 自己报告的错误（例如 registry 不可达、lockfile 损坏）放在 report.error。
if (report.error) {
	console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
	process.exit(1);
}

// 把阈值转成下标，后面用数值比较严重度。
const minimumSeverity = severities.indexOf(auditLevel);
const seenAccepted = new Set();
// failures 用 Map 去重：同一公告可能通过多个依赖路径出现多次。
const failures = new Map();

// report.vulnerabilities 以包名为键；每个包可能通过多条 via 记录指向不同公告。
for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
	for (const via of vulnerability.via) {
		// String entries point at another vulnerable package, which is reported on its own.
		// 字符串条目只是传递链上的包名，没有公告详情，跳过以避免重复报告。
		if (typeof via === "string") {
			continue;
		}
		// GitHub advisory URL 的最后一段是 id；没有 url 时退回数字 source。
		const id = via.url?.split("/").pop() ?? String(via.source);
		const accepted = acceptedAdvisories[id];
		// 只有 id 和包名都匹配才接受，防止同一公告影响多个包时误放行。
		if (accepted && accepted.package === via.name) {
			seenAccepted.add(id);
			continue;
		}
		// 未知严重度 indexOf 返回 -1，不会达到阈值；保持与 npm 新增级别时的保守行为。
		if (severities.indexOf(via.severity) >= minimumSeverity) {
			// key 同时含 id 与包名，避免不同包的相同公告 id 相互覆盖。
			failures.set(`${id}:${via.name}`, via);
		}
	}
}

// 打印本次实际命中的白名单条目，方便审计记录。
for (const id of seenAccepted) {
	console.log(`Accepted ${id} (${acceptedAdvisories[id].package}): ${acceptedAdvisories[id].reason}`);
}

// 白名单里不再出现的条目通常是漏洞已修复；用 Actions 警告提醒删除，但不让构建失败。
for (const id of Object.keys(acceptedAdvisories)) {
	if (!seenAccepted.has(id)) {
		console.log(`::warning::Accepted advisory ${id} no longer matches; remove it from scripts/npm-audit.mjs.`);
	}
}

// 有未接受漏洞时逐条列出包名、版本范围、严重度、标题和链接，便于定位。
if (failures.size > 0) {
	console.error(`\nFound ${failures.size} unaccepted advisories at or above ${auditLevel}:`);
	for (const via of failures.values()) {
		console.error(`- ${via.name} ${via.range} [${via.severity}] ${via.title} ${via.url}`);
	}
	process.exit(1);
}

console.log(`No unaccepted advisories at or above ${auditLevel}.`);
