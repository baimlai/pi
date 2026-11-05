// Benchmark of the paths slice 8 touched under every object (no registries involved): a local method call (its ctx),
// a commit through a watched derive (the batch, a derive's compute) and activation churn (an object with params made,
// live and ended per get: its attempt's declarations). Median µs per operation over bursts, and heap allocated per
// operation (growth plus what the collections during the burst freed). Runs on HEAD as it is (copy it there).
// Run by hand from packages/chord (not in CI), pinned for comparisons:
//   taskset -c 6 node --conditions=source --experimental-strip-types --expose-gc test/bench/calls.ts
import { performance } from "node:perf_hooks";
import { GCProfiler } from "node:v8";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { int, local, method, obj } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";

// 本脚本直接执行内存主机基准；没有网络或模型。九轮正式测量之外还会跑一轮预热。
const BURSTS = 9;

// as 只告诉 TypeScript 全局可能有 gc；末尾 ! 只消除类型中的 undefined，并不创建或校验函数。
// 必须按上方命令启用 --expose-gc，否则下面调用会抛错。
const gc = (globalThis as { gc?: () => void }).gc!;

// 声明每个 Store 对象自己的计数文档；initial 回调返回新对象，首次使用时由 defineState 的运行时 schema 检查验证。
const Counter = defineState("bench.counter", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
// local 声明同一主机上的契约；空 params 使 Store 随主机存活。状态成员是可观察值，method 是可调用方法。
const Store = local("bench.store", {
	version: 1,
	params: {},
	members: { doubled: int(), bump: method(), set: method(int()) },
});
// id 是对象身份参数；同一 id 复用对象，最后一个外部引用释放后对象结束，适合测量激活与回收路径。
const Item = local("bench.item", { version: 1, params: { id: int() }, members: { n: int() } });

// 创建主机并只打印后台错误的种类；这个回调并没有把错误转换成测试断言。
const host = createHost({ onError: (error) => console.log("onError", error.kind) });
// 加载唯一插件：setup 同步声明类型，load 等待空参数 Store 的首轮激活结果。失败可能在报告或后台出现。
await host.load(
	[
		{
			name: "@bench/calls",
			// setup 收到声明用的 h。它只注册工厂；工厂及方法由 Chord 在相应生命周期执行。
			facet: defineFacet((h) => {
				// Store 的参数为空，所以忽略第一个形参；self 提供该对象拥有的文档和派生值。
				h.serve(Store, (_, self) => {
					// 取得该对象的计数文档句柄；初值为 { n: 0 }，句柄本身可作为 derive 的输入。
					const counter = self.state(Counter);
					// 返回实现必须符合 Store 契约；TypeScript 检查签名，Chord 在激活时核对成员种类。
					return {
						// 数组解构 [c] 读取 counter 的当前值；该纯回调返回 n 的两倍。被 watch 后，提交触发的计算计入基准。
						doubled: self.derive([counter], ([c]) => c.n * 2),
						// 无参数方法只返回已完成的 Promise<null>；它不增加计数，测的是调用框架本身。
						bump: async () => null,
						// set 接收契约检查过的整数及调用上下文；等待写入完成后返回 null，错误直接向调用者传播。
						// 例如 set(3, ctx) 提交 n=3，doubled 随后为 6；本脚本实际传入递增整数。
						set: async (n, ctx) => {
							// change 在该对象的事务线上取得草稿并执行同步回调；await 包含提交和派生值同步发布的耗时。
							await counter.change((draft) => {
								// 赋值只写事务草稿；提交成功才替换公开文档，回调或提交抛错会使 set 拒绝。
								draft.n = n;
							}, ctx);
							// 事务已经完成，返回无业务结果；调用者仍可通过状态成员读到最新值。
							return null;
						},
					};
				});
				// Item 工厂声明对 Store 的依赖并派生 d+id；例如 id=2 且 doubled=6 时 n 为 8。
				// 工厂没有读取尚未激活的 doubled.value，而是把可观察成员交给 derive，待依赖就绪后计算。
				h.serve(Item, ({ id }, self) => ({ n: self.derive([self.get(Store, {}).doubled], ([d]) => d + id) }));
			}),
		},
	],
	context,
);

// 取得已经激活且状态已装载的 Store 引用；这里没有远程链路，方法调用仍经过 Chord 的上下文和参数检查。
const store = await host.get(Store, {}, context);
// watch 原子取得当前值并缓冲后续变化；它让 doubled 在提交发布时主动计算。
const watch = await store.doubled.watch(context);
// 安装空异步监听器。业务处理为空，但 watch 排队和调度仍属于这项测量的工作。
watch.start(async () => {});

/** Median µs per operation over the bursts (after one warm-up burst), and heap bytes allocated per operation. */
// 按 runs 次重复调用 operation(i)，返回每次操作的中位微秒耗时及平均堆分配估计字符串。
// 先预热一轮，再测九轮；会主动触发 GC、读进程内存并写分析器状态。操作拒绝或 GC 不可用会直接抛错。
// 例：measure(100, i => store.set(i, context)) 会每轮写一百次；这不是保证每次调用都低于中位数。
async function measure(runs: number, operation: (i: number) => Promise<unknown>): Promise<string> {
	// number[] 限定计时样本为数字；只存正式轮的每操作平均时间。
	const times: number[] = [];
	// 累计正式轮估计分配的堆字节，包含存活增长与 GC 期间释放的字节。
	let bytes = 0;
	// 累计正式测量的操作次数，最后用于把字节总量平均到每次操作。
	let counted = 0;
	// burst=-1 是预热；0 到 8 是九轮正式样本。每轮串行等待操作，不测并发吞吐。
	for (let burst = -1; burst < BURSTS; burst++) {
		// 轮前主动收集，减少上一轮残留；GC 本身发生在开始计时之前。
		gc();
		// 记录本轮开始时 V8 堆用量；这不是进程 RSS，也不包含所有 ArrayBuffer 外部内存。
		const before = process.memoryUsage().heapUsed;
		// 每轮建立独立 GC 分析器，以便把轮内回收的字节补回分配估计。
		const profiler = new GCProfiler();
		// 开始收集本轮 GC 统计，随后计时的操作可能触发回收。
		profiler.start();
		// 用高精度时钟记起点，单位为毫秒。
		const started = performance.now();
		// 按 i=0..runs-1 顺序 await 每项操作；失败会中断整项测量，本函数没有 try/finally 清理分析器。
		for (let i = 0; i < runs; i++) await operation(i);
		// 停止计时；循环开销、Promise 调度和操作本身都包含在毫秒差值中。
		const elapsed = performance.now() - started;
		// 读取本轮结束时仍占用的堆大小，需与 GC 释放量一起估算本轮分配。
		const after = process.memoryUsage().heapUsed;
		// 初始化轮内已释放堆字节的累计数。
		let freed = 0;
		// stop 停止分析；解构每次 GC 前后的统计，逐次补算回收量。
		for (const { beforeGC, afterGC } of profiler.stop().statistics) {
			// GC 前占用减 GC 后占用加入 freed；这是观测估计，可能受堆统计噪声影响。
			freed += beforeGC.heapStatistics.usedHeapSize - afterGC.heapStatistics.usedHeapSize;
		}
		// 预热轮也实际执行和采样，但不进入最终的时间或字节汇总。
		if (burst < 0) continue;
		// 毫秒乘一千变微秒，再除本轮操作数；每个样本是一整轮的平均耗时。
		times.push((elapsed * 1000) / runs);
		// 把净堆增长与轮内回收量相加，作为该轮分配总量。
		bytes += after - before + freed;
		// 只有正式轮加入分母，因此和 bytes 的测量范围一致。
		counted += runs;
	}
	// 数值升序排序；默认 sort 按字符串排序，不适合这里的数字中位数。
	times.sort((a, b) => a - b);
	// 取九个样本的中间项；! 是编译期非空断言，toFixed 保留两位。字节取平均后四舍五入。
	return `${times[Math.floor(times.length / 2)]!.toFixed(2)} µs, ${Math.round(bytes / counted)} B allocated`;
}

// 实际执行三类基准并打印：空方法、文档写入到被观察派生值、带参数对象的创建/就绪/释放。
console.log("local method call:", await measure(20_000, () => store.bump(context)));
console.log("commit through a watched derive:", await measure(10_000, (i) => store.set(i + 1, context)));
console.log(
	"activation churn (get, live, release):",
	await measure(2_000, async (i) => (await host.get(Item, { id: i }, context)).release()),
);
// 停止监听并丢弃积压帧；stop 不等待一个已在执行的监听回调。
await watch.stop();
// 关闭主机，结束 Store、Item 和剩余引用；关闭失败会让顶层 await 拒绝。
await host.close(context);
