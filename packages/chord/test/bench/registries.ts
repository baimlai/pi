// Benchmark of slice 8's registries and writables: a `writable.set` delivered to one watch, a set of the same value
// (one comparison), and one contribution of N (10, 100) changed while the registry is watched (one table build and one
// compose per set, over N entries). Median µs per operation over bursts, heap allocated per operation, and the
// registry's compose count per set (the cost guard: one).
// Run by hand from packages/chord (not in CI), pinned for comparisons:
//   taskset -c 6 node --conditions=source --experimental-strip-types --expose-gc test/bench/registries.ts
import { performance } from "node:perf_hooks";
import { GCProfiler } from "node:v8";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { int, local } from "../../src/contracts/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { defineRegistry } from "../../src/registries/index.ts";
import type { Writable } from "../../src/state/index.ts";

// 九轮正式测量加一轮预热；本脚本只使用内存主机、注册表和数字值。
const BURSTS = 9;

// as 与 ! 只改变 TypeScript 的类型看法，不会检查或添加 gc；运行时必须开启 --expose-gc。
const gc = (globalThis as { gc?: () => void }).gc!;

/** Median µs per operation over the bursts (after one warm-up burst), and heap bytes allocated per operation. */
// 把同步 operation(i) 重复 runs 次，返回九轮“每操作平均微秒数”的中位数及平均堆分配估计。
// 每轮会主动 GC、采集 GC 统计，并等待一个 setImmediate，让已排队的 watch 微任务也执行。
// 例：measure(100, i => writable.set(i)) 每轮改一百次。操作或计时设施抛错直接传播；这不是延迟上界。
async function measure(runs: number, operation: (i: number) => void): Promise<string> {
	// 保存正式轮每次操作的平均耗时；number[] 是开发期元素类型约束。
	const times: number[] = [];
	// 累计正式轮净堆增长与 GC 释放量之和，作为分配估计；不代表全部进程内存。
	let bytes = 0;
	// 正式测量的操作总数，与 bytes 对应，作为最后平均值的分母。
	let counted = 0;
	// 从 -1 的预热轮开始；预热仍实际执行但后面会跳过统计。
	for (let burst = -1; burst < BURSTS; burst++) {
		// 在计时前主动回收上一轮可释放的对象。
		gc();
		// 读取 V8 堆占用基线；外部缓冲区和完整 RSS 不在这个值里。
		const before = process.memoryUsage().heapUsed;
		// 每轮建立独立分析器，统计这一轮计时期间发生的 GC。
		const profiler = new GCProfiler();
		// 开始记录 GC 前后的堆数据。
		profiler.start();
		// 高精度时钟起点，单位毫秒。
		const started = performance.now();
		// 同步顺序调用每次操作；这里不 await 单次 set，因此忙监听器可能合并积压值。
		for (let i = 0; i < runs; i++) operation(i);
		// The watches' listeners run on microtasks: their work counts too.
		// resolve 交给 setImmediate，下一个事件循环阶段才继续；本轮计时包含之前的微任务处理。
		await new Promise((resolve) => setImmediate(resolve));
		// 总耗时包括操作、循环和让出事件循环的成本。
		const elapsed = performance.now() - started;
		// 读轮末仍存活的堆字节，和轮前用量相减求净增长。
		const after = process.memoryUsage().heapUsed;
		// 单独累积本轮各次 GC 释放的堆空间。
		let freed = 0;
		// 停止分析并解构每次 GC 前后的统计，补回净增长看不见的临时分配。
		for (const { beforeGC, afterGC } of profiler.stop().statistics) {
			// 用 GC 前后 usedHeapSize 之差近似该次释放量；结果会受收集器和统计噪声影响。
			freed += beforeGC.heapStatistics.usedHeapSize - afterGC.heapStatistics.usedHeapSize;
		}
		// 预热的统计不加入正式结果。
		if (burst < 0) continue;
		// 把毫秒转成微秒后除本轮 runs，得到一轮的每操作平均值。
		times.push((elapsed * 1000) / runs);
		// 把轮末净增长和已回收量都计入正式轮的分配估计。
		bytes += after - before + freed;
		// 累加正式轮的操作数。
		counted += runs;
	}
	// 按数值升序排列，以中间一轮作为中位样本。
	times.sort((a, b) => a - b);
	// 非空断言 ! 依赖固定的非空轮数；toFixed 格式化微秒，分配平均值四舍五入到字节。
	return `${times[Math.floor(times.length / 2)]!.toFixed(3)} µs, ${Math.round(bytes / counted)} B allocated`;
}

// defineRegistry<C,V> 的两个泛型分别是每个贡献的类型和组合后的值类型；这里都为 number。
const Sum = defineRegistry<number, number>("bench.sum", { version: 1 });

/** A host with `contributors` host-lifetime objects each contributing a writable number to `Sum`, watched. */
// 建立 contributors 个空参数贡献对象，每个持有可写数字，Sum 组合成总和并被观察。
// 返回主机、所有 writable、watch 以及读取累计 compose 指标的函数；调用方负责 stop 和 close。
// 例如 registryOf(10) 建十个初值为零的贡献者。工厂/load/watch 的错误直接向外传播；不会做运行时贡献 schema 检查。
async function registryOf(contributors: number) {
	// 内存遥测适配器保留计数样本，后面的 composes 从中统计 Chord 实际组合次数。
	const telemetry = new InMemoryTelemetryContext();
	// Writable<number>[] 保存工厂创建的可写句柄，供计时循环修改；它们是进程内值，不能直接作为契约状态。
	const writables: Writable<number>[] = [];
	// Array.from 按 contributors 长度创建各自独立的本地类型；(_, i) 忽略占位元素，只用索引命名。
	const types = Array.from({ length: contributors }, (_, i) =>
		// 每个类型 params={}，因此加载后即激活且随主机存活；n 是对外的数字状态。
		local(`bench.contributor-${i}`, { version: 1, params: {}, members: { n: int() } }),
	);
	// 把遥测适配器传给主机，后台错误仅打印种类。
	const host = createHost({ telemetry, onError: (error) => console.log("onError", error.kind) });
	// setup 先声明 Sum 提供者，再逐个声明贡献者的工厂。
	const facet = defineFacet((h) => {
		// compose 以 0 为起始值，解构每个表项的 value 累加；它每次遍历整个贡献表。
		h.serve(Sum, { compose: (table) => table.reduce((sum, { value }) => sum + value, 0) });
		// 为本轮生成的每个类型分别注册工厂，而不是复制一个对象实例。
		for (const Type of types) {
			// 工厂同步声明 writable、贡献和派生值；没有异步副作用。
			h.serve(Type, (_, self) => {
				// 初始数字 0；set 只按 === 判断值是否变化，不会为同值通知观察者。
				const value = self.writable(0);
				// 把当前工厂的句柄保存到外部数组，后面可选择中间一个贡献者。
				writables.push(value);
				// 将整个 writable 作为 Sum 的动态贡献；其值改变时该贡献表会被重建并重新组合。
				self.contribute(Sum, value);
				// 把 native writable 经 derive 转为 JSON Watchable 才能暴露为 n 状态；回调仅返回同一个数字。
				return { n: self.derive([value], ([n]) => n) };
			});
		}
	});
	// 加载并等待空参数对象的首轮激活，使各 writable 已被收集且贡献已发布。
	await host.load([{ name: "@bench/registries", facet }], context);
	// 取得 Sum 的组合值句柄；缺少可用提供者会等待到超时或因错误拒绝。
	const sum = await host.registry(Sum, context);
	// 观察 Sum，使每次贡献变化的 compose 在 flush 中执行，而不是等下一次懒读取。
	const watch = await sum.watch(context);
	// 安装空监听器，保留调度成本但不添加业务计算。
	// 空回调仍会接收 native 值；积压超过阈值时 watch 自身会折叠。
	watch.start(async () => {});
	// 返回零参数计数函数；读取当前遥测快照，筛选 compose 指标后累加值，不清空历史。
	const composes = (): number =>
		telemetry
			// 读取适配器已经记录的指标；这里不根据 set 次数猜测 compose 数量。
			.getMetrics()
			// 只留下 chord.registry.composes，排除其他内存主机指标。
			.filter(({ name }) => name === "chord.registry.composes")
			// 以 0 累加各系列/记录的数值，得到目前总组合次数。
			.reduce((n, { value }) => n + value, 0);
	// 返回的对象包含要清理的资源和计数闭包，资源生命周期交由调用方。
	return { host, writables, watch, composes };
}

// 先建一个贡献者，单独测 writable 的有变化 set、同值 set 和空循环成本。
const one = await registryOf(1);
// 索引 0 在 registryOf(1) 正常完成后存在；! 只消除类型中的 undefined。
const writable = one.writables[0]!;
// 额外直接观察 writable，除 Sum 已有的 watch 外再加入一个消费者。
const watch = await writable.watch(context);
watch.start(async () => {});
// 传入 i+1 让每轮第一项也不同于上一轮最后值，实际测有变化的 set。
console.log("writable.set, one watch:", await measure(20_000, (i) => writable.set(i + 1)));
// The listeners' backlogs dropped first: what follows measures the set alone.
// 先停直接 watch，再停 Sum watch；stop 丢弃积压，不等待正在执行的回调。
await watch.stop();
// 去掉组合值的观察，接下来的同值 set 不涉及活跃监听器。
await one.watch.stop();
// 先把值固定为 -1；下一项每次再设同值，只走可用性检查和 === 比较。
writable.set(-1);
// 测一百万次同值 set，另用空 operation 给出循环/调度基线。
console.log("writable.set of the same value:", await measure(1_000_000, () => writable.set(-1)));
console.log("an empty operation (the loop's own cost):", await measure(1_000_000, () => {}));
// 关闭第一组主机，释放 writable 和注册表资源。
await one.host.close(context);

// 分别比较十个和一百个贡献者时，更改其中一个的组合成本。
for (const contributors of [10, 100]) {
	// 解构当前规模的资源，每个规模独立创建主机。
	const { host, writables, watch, composes } = await registryOf(contributors);
	// 记录测量前已有的 compose 总数，以差值排除初始化工作。
	const before = composes();
	// 选择中间贡献者，! 依赖固定正数规模；只改它，其余贡献值保持为零。
	const target = writables[Math.floor(contributors / 2)]!;
	// 每轮正式/预热都做五千次 set。
	const sets = 5_000;
	// measure 共执行 BURSTS+1 轮，所以 compose 的分母也必须包含预热轮。
	const result = await measure(sets, (i) => target.set(i + 1));
	// 同时打印耗时/分配估计及每次 set 的真实 compose 平均数；这是测量结果，不是通过/失败断言。
	console.log(
		`one of ${contributors} contributions set, registry watched:`,
		result,
		`${((composes() - before) / (sets * (BURSTS + 1))).toFixed(2)} composes per set`,
	);
	// 每组测完停止组合值观察。
	await watch.stop();
	// 关闭当前规模主机后才开始下一组。
	await host.close(context);
}
