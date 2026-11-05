// 比较规则和已保留验证器的V8 heapUsed差值：父入口逐库起子进程，--child入口暖身、四次读取堆用量并保留对象；导入即运行，不是无副作用的指标定义文件。
// Retained heap of 3,200 distinct compiled schemas per candidate. Each candidate runs in its own process with
// --expose-gc: the schemas and values are built before the baseline, every library's returned validator is kept,
// and the heap is read after forced collections, once after compiling and once after checking each value 3 times
// (when libraries that compile lazily, like omptype, have compiled).
// Run: node test/bench/memory.ts [--json <file>]

// execFileSync同步启动每个候选的独立Node子进程并捕获stdout，非异步并发池；失败会抛，不在本文件自动重试。
import { execFileSync } from "node:child_process";
// 只供父入口的--json可选结果导出；子measure通过console输出JSON文字。
import { writeFileSync } from "node:fs";
// 真实候选表及去掉展示后缀的名称索引；导入会加载适配层/第三方库，并非只加载类型。
import { byName, candidates } from "./candidates.ts";
// 生成确定seed的规则和值，新对象图供准备/检查保留，不读取线上schema。
import { corpus } from "./corpus.ts";

// 环境COUNT缺省3200，Number只做转换，不验证正整数/有限值；同COUNT通过子进程环境继续传递。
const COUNT = Number(process.env.COUNT ?? 3200);

/** MB retained by the schemas themselves, and by each candidate after compiling and after checking. */
// 父入口的结果形状；字段叫MB，实际下方除1024²，数值单位是MiB，且只是V8 heapUsed差，不含所有原生/外部缓冲/RSS。
export interface MemoryResults {
	// count是请求的语料数，不是当前瞬间全部活对象数量；readonly只限制TS写入。
	readonly count: number;
	// schemasMB为生成schema、值及语料容器的heap差；父入口每收一个子进程就覆盖为该次报告，非各库平均或累计。
	readonly schemasMB: number;
	// candidates字典仍可增加条目；compiledMB是准备后减base，checkedMB是检查后减同一base，后者包含准备阶段保留量，不是只检查新增量。
	readonly candidates: Record<string, { readonly compiledMB: number; readonly checkedMB: number }>;
}

// 查第一个--child参数下标，缺省-1；下一项未做完整CLI验证。
const child = process.argv.indexOf("--child");
// 有--child就当前进程测一个名字；缺名字时实际取undefined，byName查不到后抛，类型标string不补运行时参数。
if (child >= 0) measure(process.argv[child + 1]);
// 否则进入父编排，启动各候选子进程；两支不会都执行。
else run();

// 父入口run无参数，读COUNT/argv，逐库启动--expose-gc子进程→解析stdout JSON→汇总表/可选文件，正常返回void。例node memory.ts --json out.json；会阻塞等待子进程并写console/可能写盘，启动/JSON/文件错误直出，无统一清理重试。
function run(): void {
	// 初始化结果对象与可变候选字典；readonly不深冻结，下面Object.assign仍会在运行时更新schemasMB。
	const results: MemoryResults = { count: COUNT, schemasMB: 0, candidates: {} };
	// 普通候选列表之外再加显式TypeBox interpreter，按名字逐个运行，不把两种引擎混作一个结果。
	const names = [...candidates.map((c) => c.name), "typebox interpreter"];
	// 各库顺序启动，不在同一个子进程轮换多库；父进程自身仍已导入候选模块。
	for (const name of names) {
		// 同一个Node可执行文件重新跑本脚本，显式开gc并指定--child/name；不自动继承父process.execArgv中的所有其他旗标。
		const output = execFileSync(process.execPath, ["--expose-gc", import.meta.filename, "--child", name], {
			// stdout以UTF-8文字返回，用于JSON.parse；未指定inherit来混入表格输出。
			encoding: "utf8",
			// 保留现有环境并覆盖COUNT文字；这里不单独设置ATA_NO_NATIVE，通常由all.ts父入口传下。
			env: { ...process.env, COUNT: String(COUNT) },
		});
		// 解析整个子stdout JSON，无字段shape校验；子程序混额外日志或坏JSON会使父入口抛。
		const result = JSON.parse(output);
		// Object.assign实际改results.schemasMB，即使接口标readonly；每次覆盖，不计算多次测量的中位数。
		Object.assign(results, { schemasMB: result.schemasMB });
		// 保留该库的两个报告数值，没做非负/有限检查；堆差受GC/引擎状态影响，不保证必然为正。
		results.candidates[name] = { compiledMB: result.compiledMB, checkedMB: result.checkedMB };
	}
	// 展示最终保存的语料heap差并声明表中未算它；toFixed(1)只是输出舍入。
	console.log(`${COUNT} distinct schemas take ${results.schemasMB.toFixed(1)} MB themselves (not counted below).\n`);
	// 打印准备后/检查后两列名称，后者仍使用base作基准。
	console.log("| candidate | after compiling | after checking |");
	// Markdown表格分隔线，不是测量或文件内容。
	console.log("|---|---:|---:|");
	// 按结果字典已有顺序逐库打印，name为库名而非远端机器。
	for (const [name, r] of Object.entries(results.candidates)) {
		// 两列都保留1位小数，字段名MB沿用旧格式，实际换算为MiB。
		console.log(`| ${name} | ${r.compiledMB.toFixed(1)} MB | ${r.checkedMB.toFixed(1)} MB |`);
	}
	// 找可选--json开关，不检查开关后是否真的有路径。
	const out = process.argv.indexOf("--json");
	// 有标记就同步写tab缩进JSON，写失败会抛；无标记则只有console输出，不默认写结果文件。
	if (out >= 0) writeFileSync(process.argv[out + 1], JSON.stringify(results, null, "\t"));
}

// 子入口measure接库名，在当前--expose-gc进程暖身→empty→生成语料/base→准备/compiled→检查/checked→保留引用并打印JSON，返回void。例--child pi-schema；会调用库、GC、读heap、改globalThis.keep，不启动另一个子进程，无全部内存成本/稳定GC保证。
function measure(name: string): void {
	// 从当前进程候选索引查对象，索引本身不重新导入一个库。
	const candidate = byName.get(name);
	// 未知名字立即抛，不选默认库掩盖CLI错误。
	if (candidate === undefined) throw new Error(`Unknown candidate ${name}`);
	// as仅允许TS读取可选gc属性，不创建gc或验证属性确实是函数；实际Node --expose-gc负责提供。
	const gc = (globalThis as { gc?: () => void }).gc;
	// 缺gc就明确失败，不把普通heap快照冒充经过强制回收的结果。
	if (gc === undefined) throw new Error("Run with --expose-gc");
	// 局部heap无参，先请求GC四次再取heapUsed。返回当前V8堆字节快照，无外部I/O；四次请求不证明全部资源都释放或每次测量完全可复现。
	const heap = () => {
		// 同步重复调用当前gc函数四次，不是创建四个并行回收任务。
		for (let i = 0; i < 4; i++) gc();
		// 只取process.memoryUsage().heapUsed，忽略rss/external/arrayBuffers等其他指标。
		return process.memoryUsage().heapUsed;
	};
	// Warm the library's own code on another corpus, so its lazily compiled functions are not counted.
	// seed7的100份规则先暖库代码；意在让公共/懒执行成本先发生，但不保证所有后续懒状态在基准前已稳定。
	for (const { schema, value } of corpus(100, 7)) {
		// 准备暖身规则，取check，准备对象不加入下面正式prepared数组。
		const { check } = candidate.prepare(schema, { draft: "2020-12" });
		// 每份暖身值检查4次，返回布尔被忽略，不是规范符合性断言。
		for (let i = 0; i < 4; i++) check(value);
	}
	// empty是暖身之后的heap快照，不是全新进程刚启动的零库基线。
	const empty = heap();
	// 正式语料seed42，包含规则、合法值和条目数组；COUNT未在此再做边界校验。
	const items = corpus(COUNT, 42);
	// base已包含这些输入容器，后面库保留差值都减它。
	const base = heap();
	// map保每份prepare完整返回对象，含check及validator，防只留函数漏掉库返回的所有者对象；此行会有额外容器/包装开销。
	const prepared = items.map(({ schema }) => candidate.prepare(schema, { draft: "2020-12" }));
	// 准备后GC/heap快照；编译是候选prepare实际完成的工作，首次check才懒编译的成本可能稍后才出现。
	const compiled = heap();
	// 每个正式值用对应prepared检查3次，嵌套循环不是把不同schema混用；返回值未核对正确性，可能触发库的懒状态。
	for (let i = 0; i < items.length; i++) for (let k = 0; k < 3; k++) prepared[i].check(items[i].value);
	// 检查后再取heap，包含准备与这三次检查后仍保留的状态，非累计分配次数。
	const checked = heap();
	// 把items/prepared放强全局引用，后续仍会用到它们的意图防优化/GC过早判死；as不冻结或复制。会覆盖进程原keep字段，当前脚本未恢复/清理此引用，通常随子进程结束释放。
	(globalThis as { keep?: unknown }).keep = [items, prepared];
	// mb把字节除1048576转MiB，例1048576得到1；纯数值换算，不额外测堆或修正负数。
	const mb = (bytes: number) => bytes / 1048576;
	// 子入口只输出一份JSON，父入口用整个stdout解析。
	console.log(
		// 语料差base-empty；准备差compiled-base；检查后总保留差checked-base，并非checked-compiled。JSON未带完整四个原快照，也不等同整个库的RSS。
		JSON.stringify({ schemasMB: mb(base - empty), compiledMB: mb(compiled - base), checkedMB: mb(checked - base) }),
	);
}
