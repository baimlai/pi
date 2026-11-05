// 比较各验证器准备新schema与最初检查的平均耗时：先暖库代码，再逐规则计时；导入就执行基准，console输出表格，--json才写结果文件。
// Setup cost: compiling a schema the library has not seen, and the time of its first checks. Uses distinct
// schemas from the corpus after warming each library's own code, so it measures a new schema, not a new process.
// Run: node test/bench/setup.ts [--json <file>]

// 同步文件写入只用于可选--json输出；不写schema或被测用户文件。
import { writeFileSync } from "node:fs";
// 加载真实候选适配层，prepare会调用各库；本文件不隔离库模块状态或创建新进程。
import { candidates } from "./candidates.ts";
// corpus按seed生成规则与合法值，不从线上取工具样本。
import { corpus } from "./corpus.ts";

// COUNT缺省1000，??只在环境项缺省时兜底，Number会转换空串等；没有验证整数/非负/有限，异常输入会影响循环与除法结果。
const COUNT = Number(process.env.COUNT ?? 1000);

/** Mean µs per schema: compile, then each of the first three checks and the mean of checks 4-10. */
// Record按库名存指标对象；checkUs元组四槽依次是第1/2/3次检查、4到10次单次均值，静态类型不添加单位换算或保证数值有限。
export type SetupResults = Record<string, { compileUs: number; checkUs: [number, number, number, number] }>;

// 结果可变字典，const禁止变量换引用，不禁止写每个库的条目。
const results: SetupResults = {};
// 逐个候选在同一进程里运行；候选的真实prepare/check异常未被本脚本catch，会终止这一运行。
for (const candidate of candidates) {
	// 先用seed7的200份schema暖库代码，与下面seed99的正式样本分开；每库重建同内容语料，不是重启进程清空所有库缓存。
	for (const { schema, value } of corpus(200, 7)) {
		// prepare接规则与draft，解构取布尔check；此暖身准备耗时不计入compile指标。
		const { check } = candidate.prepare(schema, { draft: "2020-12" });
		// 每个暖身值检查10次，返回布尔被忽略，未在此独立核对样本正确性。
		for (let i = 0; i < 10; i++) check(value);
	}
	// 正式语料每库都以相同COUNT/seed99重建，产生新schema对象；同内容/相同seed不等于共享对象身份。
	const items = corpus(COUNT, 99);
	// 累积准备阶段的纳秒，变量名compile还包括候选prepare包装与解构开销，不仅某库内部某一个函数。
	let compile = 0;
	// 四个数值累加槽，对应输出元组的四种检查时点。
	const checks = [0, 0, 0, 0];
	// 逐份新规则准备后立即测它的最初检查；不是先编完全部规则再统一检查。
	for (const { schema, value } of items) {
		// 高分辨率单调时钟返回bigint纳秒，避免拿墙钟Date.now做微秒差。
		let start = process.hrtime.bigint();
		// 这次prepare及check取出落在start与下一次时钟读数之间。
		const { check } = candidate.prepare(schema, { draft: "2020-12" });
		// 差先用bigint计算，再Number累计；转换不代表任意极长时间差永远精确，当前用于短段测量。
		compile += Number(process.hrtime.bigint() - start);
		// 前三次分别计时，k=0/1/2不是一次总计后除3。
		for (let k = 0; k < 3; k++) {
			// 为当前一次检查重新取起点，复用let变量。
			start = process.hrtime.bigint();
			// 同一配套值跑check，布尔结果未校验/存储。
			check(value);
			// 把第k次耗时加到对应槽，循环/时钟/调用开销也影响观测。
			checks[k] += Number(process.hrtime.bigint() - start);
		}
		// 第4到10次检查作为一个整体计时段。
		start = process.hrtime.bigint();
		// k从3跑到9共7次，check(value)内容相同。
		for (let k = 3; k < 10; k++) check(value);
		// 七次总差先除7再累加第四槽，因此输出是单次均值，不是七次总和或只第4次。
		checks[3] += Number(process.hrtime.bigint() - start) / 7;
	}
	// 局部us把累计纳秒除COUNT求每schema平均，再除1000换微秒；例2000ns/2=1微秒。闭包读取COUNT，只返回数值，无I/O或修正异常COUNT。
	const us = (ns: number) => ns / COUNT / 1000;
	// 以candidate.name为键记录本库结果，重复名字会覆盖旧值。
	results[candidate.name] = {
		// 准备耗时按规则数取平均。
		compileUs: us(compile),
		// 四槽分别换算，前三次是独立时点均值，第四是4到10次的单次均值；不是中位数。
		checkUs: [us(checks[0]), us(checks[1]), us(checks[2]), us(checks[3])],
	};
}

// 表头输出到console，单位由下方表格字符串标注。
console.log("| candidate | compile | check 1 | check 2 | check 3 | checks 4-10 |");
// 打印Markdown表格对齐线，不属于测量阶段。
console.log("|---|---:|---:|---:|---:|---:|");
// Object.entries按结果已有键枚举库名/指标。
for (const [name, r] of Object.entries(results)) {
	// 每库输出一行，多行调用只是排版。
	console.log(
		// compile保留1位、各check保留2位微秒，map只格式化四槽；四舍五入的文字不是更多测量精度。
		`| ${name} | ${r.compileUs.toFixed(1)} µs | ${r.checkUs.map((x) => `${x.toFixed(2)} µs`).join(" | ")} |`,
	);
}
// 找第一个--json参数下标，没找到为-1，不做完整CLI解析。
const out = process.argv.indexOf("--json");
// 存在标记就同步写下一项路径，JSON用tab缩进；未检查是否缺路径、建父目录或捕获写失败，未给标记则仅console。
if (out >= 0) writeFileSync(process.argv[out + 1], JSON.stringify(results, null, "\t"));
