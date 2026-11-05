// 按规范套件章节比较各库的布尔裁决，拒绝编译/检查抛错计未通过；这是统计脚本，不是Vitest完整通过证明，导入即运行并输出表格。
// Conformance of every candidate on the vendored JSON-Schema-Test-Suite (drafts 2020-12 and 7), by section:
// core, optional and optional/format. Every candidate gets the remote documents and meta-schemas; format tests run
// with pi-schema's format checks (the other libraries check formats on their own or not at all). Zod goes through
// z.fromJSONSchema, which refuses some keywords and every remote $ref: a schema it refuses fails all its tests.
// Run: node test/bench/conformance.ts [--json <file>]

// 只在指定--json时同步导出统计，不下载规范或远程schema。
import { writeFileSync } from "node:fs";
// Pi内建格式检查表供format章节传选项，各候选是否使用/怎样使用由实际适配层决定，不代表统一调用这张表。
import { formats } from "../../src/formats/index.ts";
// suiteFiles读取本地vendored用例，suiteSchemas建本地URI→规则表；“remote”在这里是本地提供的引用文档，不发网络请求。
import { suiteFiles, suiteSchemas } from "../suite.ts";
// 候选适配层会加载真实验证器，prepare/check可有库内部状态；本脚本用catch把这些失败纳入统计，不隔离进程。
import { candidates } from "./candidates.ts";

/** Passed and total tests by section ("draft2020-12 core", ...) and candidate name. */
// 按章节名保存总规范数据数及各库通过数；不是按Vitest测试文件计数，Record类型不自动核对计数范围。
export type ConformanceResults = Record<string, { total: number; passed: Record<string, number> }>;

// 结果字典从空开始，按首次遇到章节的顺序填入。
const results: ConformanceResults = {};
// 同步遍历本地suite文件，文件读取/解析若在迭代器里抛出不属于下面prepare/check的catch。
for (const file of suiteFiles()) {
	// 先看路径是否包含optional/format，优先于更宽的optional分类。
	const kind = file.name.includes("/optional/format/")
		? // 匹配时分类format。
			"format"
		: // 否则再匹配optional子目录。
			file.name.includes("/optional/")
			? // 可选非format章节归optional。
				"optional"
			: // 剩余都归core；依赖suite文件名的当前布局，不逐条看schema关键字归类。
				"core";
	// 章节键由路径首段draft目录和kind组成；只用/分割，未在此统一Windows路径分隔符。
	const section = `${file.name.split("/")[0]} ${kind}`;
	// ??=仅章节尚无值才建总数0和各库0的表；map把候选名字变成键，重复名字不会形成两列独立计数。
	results[section] ??= { total: 0, passed: Object.fromEntries(candidates.map((c) => [c.name, 0])) };
	// 每个规范group共用一个schema及多份带valid期望的数据。
	for (const group of file.groups) {
		// 先把该group所有数据加入公共total，候选编译失败时这些数据仍在分母，不被当作跳过而删除。
		results[section].total += group.tests.length;
		// 每个候选分别准备这份group规则，不复用其他库的validator。
		for (const candidate of candidates) {
			// check未取得前是undefined；一旦prepare失败就continue，后续仅在成功路径调用。
			let check: ((v: unknown) => boolean) | undefined;
			// try包含structuredClone、选项求值、prepare和check属性访问，catch并非只能代表库内部编译失败。
			try {
				// 逐库深克隆当前schema，避免候选直接改同一份group规则；clone自身也可能抛，而不是无条件保证任何schema都可复制。
				check = candidate.prepare(structuredClone(group.schema), {
					// 使用该文件的draft选项，不根据用例名称猜。
					draft: file.draft,
					// 每次prepare都调用suiteSchemas取得本地引用表，候选是否复制/缓存/登记它由适配层决定。
					schemas: suiteSchemas(),
					// 仅format分类传formats，否则显式undefined；这是传参策略，不强制各库格式实现相同。
					formats: kind === "format" ? formats : undefined,
					// suite=true通知候选采用规范适配分支，例如Zod走fromJSONSchema，不是打开联网模式。
					suite: true,
					// 只取准备对象的check函数，不在这里运行样本。
				}).check;
				// 任何准备阶段抛值都进入本catch，不只EvalError。
			} catch {
				// 跳过这个库的整组检查，total已计入而passed不增，相当于该库这组全部未通过；并非Vitest it.skip。
				continue; // A schema the library cannot compile fails all its tests.
			}
			// 准备成功才逐规范数据检查，test.valid是规范要求接受还是拒绝的boolean。
			for (const test of group.tests) {
				// 每一份check及比较/计数都单独catch，一份失败不阻断同组其他数据。
				try {
					// 严格===比较布尔裁决；应拒绝的值被正确拒绝也计通过，不是仅check返回true才算通过。
					if (check(test.data) === test.valid) results[section].passed[candidate.name]++;
					// check或本try内其他异常都记为这份未通过，不往通过计数加1。
				} catch {
					// A throw while checking fails the test.
				}
			}
		}
	}
}

// 固定候选列顺序，和结果章节顺序分别管理。
const names = candidates.map((c) => c.name);
// 打印章节、总数以及各库名的表头。
console.log(`| section | tests | ${names.join(" | ")} |`);
// 生成各列右对齐的Markdown分隔线，不属于裁决运行。
console.log(`|---|---:|${names.map(() => "---:").join("|")}|`);
// 按结果已有章节枚举，数字都已在上面累计。
for (const [section, r] of Object.entries(results)) {
	// 每行展示公共total和各库passed，未自动计算比例或强制全部通过；某些库不支持的用例仍在分母。
	console.log(`| ${section} | ${r.total} | ${names.map((n) => r.passed[n]).join(" | ")} |`);
}
// 找可选--json开关，不实现复杂参数解析。
const out = process.argv.indexOf("--json");
// 有标记才同步写下一参数路径，结果JSON用tab缩进；写失败不在前面的候选catch范围，无标记则只console。
if (out >= 0) writeFileSync(process.argv[out + 1], JSON.stringify(results, null, "\t"));
