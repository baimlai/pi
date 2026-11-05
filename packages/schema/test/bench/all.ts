// 基准总入口按顺序起6个Node子进程，收各自临时JSON、删临时结果再写汇总；正常运行会启动完整基准并写文件，导入本模块即开始执行。
// Runs every benchmark, each in its own process, and writes the results as JSON next to the printed tables.
// Speed runs twice: normally and with code generation from strings disabled, as under a strict CSP.
// The children run with ATA_NO_NATIVE=1 (see candidates.ts).
// Run: npm run bench [-- --out <file>]   (default: pi-schema-bench-results.json in the temp directory)

// execFileSync同步等每个子程序，任一启动/非零退出等错误可终止本次编排，不是异步并行任务队列。
import { execFileSync } from "node:child_process";
// 同步文件API读取每份JSON、删除它并写总表；未设置通用finally清理失败残留。
import { readFileSync, rmSync, writeFileSync } from "node:fs";
// cpus仅用于报告首个逻辑CPU型号，tmpdir选择本机临时目录，不访问远端环境。
import { cpus, tmpdir } from "node:os";
// join按本机路径规则拼脚本和临时结果路径，不作为shell字符串引用函数。
import { join } from "node:path";

// import.meta.dirname是当前模块本机目录；子脚本据它定位，不依赖调用者cwd。
const dir = import.meta.dirname;
// 找第一个--out标记，没找到为-1，不实现完整参数解析。
const outIndex = process.argv.indexOf("--out");
// 指定就取下一项路径，否则写临时目录固定pi-schema-bench-results.json；未验证缺参数、建父目录或防同名覆盖。
const out = outIndex >= 0 ? process.argv[outIndex + 1] : join(tmpdir(), "pi-schema-bench-results.json");

// 每项是[汇总键,脚本名,额外Node旗标]三元组，外层再组成数组；TS元组类型分别约束三个位置，不在运行时验证脚本清单。
const runs: [string, string, string[]][] = [
	// 先跑规范符合性统计，不在父入口把“有结果”断言成所有规范通过。
	["conformance", "conformance.ts", []],
	// 普通热检查速度运行。
	["speed", "speed.ts", []],
	// 同一speed脚本再跑一遍，仅此项显式禁从字符串生成代码；结果用不同speedNoEval键保存。
	["speedNoEval", "speed.ts", ["--disallow-code-generation-from-strings"]],
	// 准备及最初检查耗时运行。
	["setup", "setup.ts", []],
	// 内存脚本自己还会逐库起--expose-gc子进程，这里只起它的父编排入口。
	["memory", "memory.ts", []],
	// 打包体积脚本本身会用esbuild打包和gzip；这里不在父进程直接测包大小。
	["size", "size.ts", []],
];

// 汇总对象先装环境元数据，再逐项加结果；unknown表示各指标形状不同，JSON.parse之后没有统一结构校验。
const results: Record<string, unknown> = {
	// 当前Node版本供读报告时定位运行环境，不是依赖版本锁定。
	node: process.version,
	// 取首个CPU型号，?.防空数组、??仅在缺值时用unknown；不等于测得实时频率或所有核完全相同。
	cpu: cpus()[0]?.model ?? "unknown",
	// 记录当前UTC ISO时间，是报告元数据而非计时起点。
	date: new Date().toISOString(),
};
// 解构每组三项并顺序执行，前一轮完成才走下一轮。
for (const [key, file, flags] of runs) {
	// 每键用固定临时文件名，无随机目录隔离；同时跑多份总基准可能共享这些名字，不是用户原始schema文件。
	const json = join(tmpdir(), `pi-schema-bench-${key}.json`);
	// 打印章节标题，只有有旗标时附旗标文字；不将这段文字作为执行命令。
	console.log(`\n## ${key}${flags.length > 0 ? ` (${flags.join(" ")})` : ""}\n`);
	// 直接起同一Node可执行文件，额外旗标位于脚本之前，--json/临时路径位于脚本之后；argv数组不经本机shell分词。
	execFileSync(process.execPath, [...flags, join(dir, file), "--json", json], {
		// 子进程stdio继承父终端，打印表格直接可见，返回值未拿来作JSON内容。
		stdio: "inherit",
		// 保留当前环境再覆盖ATA_NO_NATIVE=1，意图禁ATA可选原生addon；不修改本父进程process.env，也不是关闭所有库的JIT或禁所有原生代码。
		env: { ...process.env, ATA_NO_NATIVE: "1" },
	});
	// 子程序成功返回后同步读取它写出的文件再JSON.parse，结果归入当前key；读/解析失败直接抛，不在这里转为失败指标。
	results[key] = JSON.parse(readFileSync(json, "utf8"));
	// 只有上面读取/解析成功才删该临时文件；没有finally，前一步失败时它可能保留，rm失败也会终止后续运行。
	rmSync(json);
}
// 六轮都完成后同步写最终tab缩进JSON，可覆盖既有out；这里不输出Markdown报告文件或保留全部子临时JSON。
writeFileSync(out, JSON.stringify(results, null, "\t"));
// 最后打印总结果路径，表示写调用已成功返回，不是规范全部通过或持久化fsync保证。
console.log(`\nResults: ${out}`);
