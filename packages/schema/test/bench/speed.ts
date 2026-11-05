// 比较已准备规则的热检查耗时：先核对固定正反样本、校准次数，再轮换候选顺序取每轮均值的中位数；脚本导入即运行，不测模型/网络速度。
// Hot validation speed: ns per check for each case and candidate, after warm-up. Each round times every
// candidate once, in a rotated order; the result is the median of the rounds.
// Run: node test/bench/speed.ts [--json <file>]   (add --disallow-code-generation-from-strings for no eval)

// 只为--json可选结果导出提供同步写文件，不在计时循环里写盘。
import { writeFileSync } from "node:fs";
// 加载候选接口与真实库适配，候选准备和库全局状态都在当前进程，不另建隔离进程。
import { candidates } from "./candidates.ts";
// 使用9份固定正/反数据，案例名与schema不是在这里随机生成。
import { cases } from "./cases.ts";

// 环境ROUNDS缺省15，经Number转换但未验证；正常正整数决定采样轮数，不自动钳制异常值。
const ROUNDS = Number(process.env.ROUNDS ?? 15);
// 每轮校准目标缺省30毫秒；Number/??不校验非空正数，目标并不保证实际调度恰30毫秒。
const ROUND_MS = Number(process.env.ROUND_MS ?? 30);
// 把成功检查次数累积到sink，让布尔结果实际被消费；不按它生成性能结论。
let sink = 0;

// time接check、一个值和调用次数n，返回该段平均纳秒/次；例总1000ns/n=1000得1ns。会反复调用check并改本模块sink，check异常直出，计时包含循环/分支/累加开销。
function time(check: (v: unknown) => boolean, value: unknown, n: number): number {
	// hrtime.bigint读取单调高分辨率纳秒起点，不使用受校时影响的墙钟。
	const start = process.hrtime.bigint();
	// 调用n次，仅真值才递增sink；所以合法/非法样本分支开销也可能不同，不是空循环扣除后的纯函数耗时。
	for (let i = 0; i < n; i++) if (check(value)) sink++;
	// bigint作差后转number再除n，得到本段均值，不是单次最快值；不为n=0单独设保护。
	return Number(process.hrtime.bigint() - start) / n;
}

// median接样本数组返回排序中间项，复制后排序不改原数组；奇数取中间，偶数取偏右项而非两项平均。例[3,1,2]得2，空数组实际得undefined而非有效中位数。
function median(values: number[]): number {
	// 数字比较器避免默认字符串排序，>>1对正常小轮数相当于floor(length/2)，是JS32位位运算。
	return [...values].sort((a, b) => a - b)[values.length >> 1];
}

/**
 * Median ns per check, by case name, input ("valid"/"invalid") and candidate name; null where the candidate cannot
 * compile the schema (Ajv without eval).
 */
// 按case名→valid/invalid→库名三层保存数值或null；Record/字面量联合是静态约束，null表示prepare阶段捕获到EvalError，并非所有失败都转null。
export type SpeedResults = Record<string, Record<"valid" | "invalid", Record<string, number | null>>>;

// 新建结果字典，后续逐案例填充，不在这里冻结输出。
const results: SpeedResults = {};
// 每份case独立测两类输入；各输入还会独立调用prepare，不复用另一输入的准备对象。
for (const c of cases) {
	// 先建valid/invalid空结果表，后面用计算键填库名。
	results[c.name] = { valid: {}, invalid: {} };
	// as const让TS把两项保留为文字类型，便于c[input]；它不冻结这个运行时数组。
	for (const input of ["valid", "invalid"] as const) {
		// 按当前标签取得正或反样本引用，不复制/转换它。
		const value = c[input];
		// runs只保存这次能准备且通过样本裁决核对的候选，后面轮换在这个列表内进行。
		const runs: {
			// typeof在此取静态数组类型，再[number]取元素类型，不在运行时访问一个叫number的属性。
			candidate: (typeof candidates)[number];
			// check是unknown输入→boolean输出的函数类型，不在运行时检查某库是否守约。
			check: (v: unknown) => boolean;
			// n为本候选当前输入的自适应循环次数，各库可能不同。
			n: number;
			// samples收每轮time的均值，单位纳秒/次。
			samples: number[];
		}[] = [];
		// 先逐候选prepare和校准，这部分不写进最终samples，但会暖相关执行代码。
		for (const candidate of candidates) {
			// 先声明check，只有prepare成功后才给后面使用。
			let check: (v: unknown) => boolean;
			// try范围仅包含prepare与check属性取得，不含后面的首次检查/校准/采样。
			try {
				// 传2020-12默认draft；某规则自身$schema是否优先由候选实现决定，不在此强改schema。
				check = candidate.prepare(c.schema, { draft: "2020-12" }).check;
				// 捕获准备阶段抛出的任意值，下一行才决定是否可记为失败。
			} catch (error) {
				// 只有本realm EvalError才吞；其他异常重抛终止脚本，并非所有不支持规则都记null。
				if (!(error instanceof EvalError)) throw error;
				// 此库此case此input记null，输出时显示fails。
				results[c.name][input][candidate.name] = null;
				// 跳过这个候选，不往runs放采样任务。
				continue;
			}
			// 首次check须严格等于标签期待的boolean，否则直接抛；这一断言不在prepare的catch里，也不验证所有可能输入。
			if (check(value) !== (input === "valid")) throw new Error(`${candidate.name} gets ${c.name} (${input}) wrong`);
			// 校准从1000次调用起，不是直接以最终ROUNDS当调用数。
			let n = 1000;
			// time均值乘n估本段总纳秒，与毫秒目标×1e6比较，未达就倍增n。左侧time先运行；n<1e8只是本轮倍增条件，最后n可能倍增越过1e8，非严格上限。
			while (time(check, value, n) * n < ROUND_MS * 1e6 && n < 1e8) n *= 2;
			// 用同名属性简写保存候选、函数、校准n和新样本数组；time调用在后续轮次继续。
			runs.push({ candidate, check, n, samples: [] });
		}
		// 正常ROUNDS正整数时采对应轮数；此处不保证0/负数等异常配置仍有样本。
		for (let round = 0; round < ROUNDS; round++) {
			// 每轮覆盖runs中的每个候选一次，没有候选时循环不进，也就不执行余数运算。
			for (let i = 0; i < runs.length; i++) {
				// 按轮次偏移i再取模，轮换首个被计时的库，不是随机打乱或并行测量。
				const run = runs[(i + round) % runs.length];
				// 按各自n测一次段均值并存入samples；检查对象/值复用，没有在这一段重新prepare。
				run.samples.push(time(run.check, value, run.n));
			}
		}
		// 每库取轮均值的中间项写结果；不是将所有单次检查混一起求中位数。
		for (const run of runs) results[c.name][input][run.candidate.name] = median(run.samples);
	}
}

// 保留候选原顺序输出列，和测量时轮换顺序分开。
const names = candidates.map((c) => c.name);
// 先打印表头；模板插值只是生成文字，不改变已经测好的结果。
console.log(`| case | input | ${names.join(" | ")} |`);
// 每库一列Markdown数值对齐标记。
console.log(`|---|---|${names.map(() => "---:").join("|")}|`);
// 枚举每个case的两份输入结果。
for (const [name, inputs] of Object.entries(results)) {
	// 逐valid/invalid结果打印，ns是库名→耗时字典，并非单个纳秒值。
	for (const [input, ns] of Object.entries(inputs)) {
		// 按固定names列顺序format每项，null映失败；输出格式化在计时之后。
		console.log(`| ${name} | ${input} | ${names.map((n) => format(ns[n])).join(" | ")} |`);
	}
}
// 只找第一个--json开关，不校验其后路径参数。
const out = process.argv.indexOf("--json");
// 有开关才同步写tab缩进JSON，缺路径/写失败会抛，无开关时不写盘。
if (out >= 0) writeFileSync(process.argv[out + 1], JSON.stringify(results, null, "\t"));
// sink从0仅递增，正常执行这个负数分支不会打印；仍让累计结果被最终代码读取，不是另一个性能指标。
if (sink < 0) console.log(sink);

// format接纳秒均值或null返回显示文字；例1500→1.5 µs，null→fails。只格式化不重测，不验证有限数值，输入异常可能格式化失败。
function format(ns: number | null): string {
	// 只有严格null显示fails，0不是失败。
	if (ns === null) return "fails";
	// >=1000换微秒；>=10000ns微秒保0位，否则保1位，小于1000保0位纳秒。toFixed是文字舍入，不改变原结果数值。
	return ns >= 1000 ? `${(ns / 1000).toFixed(ns >= 10000 ? 0 : 1)} µs` : `${ns.toFixed(0)} ns`;
}
