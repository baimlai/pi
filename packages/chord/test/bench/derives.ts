// Benchmark of a retirement through derives (slice 6a rule 21): a singleton under a diamond of 40 derives (13 layers of
// two derives joined by a third, 2^13 paths from the top to the bottom), its bottom watched; each step retires the
// document and creates it again in one transaction, so every step carries the `retired` flag through the diamond.
// Median and p95 per step over several bursts. The flag reaches each derive once per retirement, not once per path.
// Run by hand from packages/chord (not in CI):
//   node --conditions=source --experimental-strip-types --expose-gc test/bench/derives.ts
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { arr, int, local, method, obj, str } from "../../src/contracts/index.ts";
import { defineState, type SingletonHandle } from "../../src/documents/index.ts";
import { createHost, defineFacet, type Self } from "../../src/host/index.ts";
import type { Watchable } from "../../src/watch.ts";

// 每轮执行一千次“退休并重新写入”，七轮正式测量之外另跑一轮预热。
const STEPS = 1_000;
const RUNS = 7;
const LAYERS = 13;

// 单例文档的根是对象，items 才是字符串列表；initial 每次创建空列表。此定义没有 persist，只在内存中。
const List = defineState("bench.list", {
	schema: obj({ items: arr(str()) }),
	version: 1,
	initial: () => ({ items: [] }),
});
// 空参数本地对象随主机存活；对外暴露菱形链底部的数字与空 touch 方法。
const Diamond = local("bench.diamond", { version: 1, params: {}, members: { bottom: int(), touch: method() } });

/** The diamond over `list`: its bottom derive. */
// 构造依赖 list 的菱形派生图，返回底部 Watchable<number>，不会自行开启 watch 或事务。
// self 是对象的声明接口；list 是该对象的单例文档句柄。先取列表长度，再逐层分叉、汇合，共 1+13×3=40 个 derive。
// 例：某一层输入 n=2，左右为 3、4，汇合值为 7；这是演算示例。计算出错由 Chord 的 derive 机制处理。
function diamond(self: Self, list: SingletonHandle<{ items: string[] }>): Watchable<number> {
	// Watchable<number> 只限制可观察值类型；回调解构文档值，最上层把列表长度变成数字。
	let previous: Watchable<number> = self.derive([list], ([value]) => value.items.length);
	// 创建十三层，每层新增两个分支和一个汇合；previous 在每次迭代后指向新汇合点。
	for (let layer = 0; layer < LAYERS; layer++) {
		// 左分支只依赖上一层，返回上一层数字加一。
		const left = self.derive([previous], ([n]) => n + 1);
		// 右分支共享同一个输入，返回上一层数字加二；因此形成两条汇入下一层的路径。
		const right = self.derive([previous], ([n]) => n + 2);
		// 解构左右值后相加并对一千取余，使数字保持有界；退休标记仍沿依赖图传播。
		previous = self.derive([left, right], ([a, b]) => (a + b) % 1_000);
	}
	// 返回最后的汇合点；调用方 watch 它，才会让整个上游图被主动观察。
	return previous;
}

/** Per-step times (ms) of `RUNS` bursts of `STEPS` retire-and-recreate transactions, after one warm-up burst. */
// 运行预热和七轮样本，返回每笔事务毫秒耗时的中位数与第 95 百分位样本。
// 每轮独立建主机和派生图，计时只围住退休/重建事务；会写内存状态并开启/停止 watch，异常直接传播。
// 例如 median=0.01 表示样本中间那笔约 0.01ms，不代表所有事务都不超过它。
async function bursts(): Promise<{ readonly median: number; readonly p95: number }> {
	// number[] 收集每一笔正式轮事务的耗时，而非每轮平均数。
	const times: number[] = [];
	// run=-1 预热，后七轮才计入统计。
	for (let run = -1; run < RUNS; run++) {
		// | undefined 表示工厂运行之前还拿不到句柄；泛型记录实际文档形状。
		let list: SingletonHandle<{ items: string[] }> | undefined;
		// 暂存工厂收到的声明/事务接口，供该基准在外部发起事务；! 不进行运行时校验。
		let self: Self | undefined;
		// 创建仅用于当前轮的主机；空 onError 忽略后台报告，不等于断言没有错误。
		const host = createHost({ onError: () => {} });
		// 声明插件 setup，其箭头函数直接返回 serve 的结果；实际声明在 load 里执行。
		const facet = defineFacet((h) =>
			// 注册 Diamond 工厂；declared 是对象自己的 self，参数为空所以忽略第一个值。
			h.serve(Diamond, (_, declared) => {
				// 把运行时对象接口保存给计时循环，后续事务使用同一对象的线。
				self = declared;
				// 声明当前对象拥有的 List 文档，并把句柄保存给事务循环。
				list = declared.state(List);
				// 建立四十个 derive，并返回与契约对应的 bottom 和无业务操作的 touch。
				return { bottom: diamond(declared, list), touch: async () => null };
			}),
		);
		// 发布插件并等空参数对象的首轮结果；这里的正常路径会完成所有初始 derive 计算。
		await host.load([{ name: "@bench/derives", facet }], context);
		// 取就绪引用以访问底部派生值；引用本身不是文档。
		const reference = await host.get(Diamond, {}, context);
		// 原子取得 bottom 当前值并建立观察；整条派生链因这个观察进入提交发布路径。
		const watch = await reference.bottom.watch(context);
		// 监听器不做业务处理；测量仍包含标记、计算、diff 和排队工作。
		watch.start(async () => {});
		// 每轮做一千笔串行事务，避免不同事务重叠而混淆单笔延迟。
		for (let step = 0; step < STEPS; step++) {
			// 开始该笔事务计时，单位毫秒。
			const before = performance.now();
			// 在一个事务回调内完成两步；! 仅声明此前工厂已经给 self 赋值，不是运行时防御。
			await self!.tx(async (tx) => {
				// 把旧单例退休；后续对相同文档的 draft 从初值开始，退休语义与写入一起发布。
				await tx.retire(list!);
				// await 取得事务草稿后追加当前步骤的字符串；写入的是草稿，提交成功才公开。
				(await tx.draft(list!)).items.push(`${step}`);
			}, context);
			// 只记录正式轮的单笔总耗时；预热依然执行同样的写入。
			if (run >= 0) times.push(performance.now() - before);
		}
		// 每轮结束先停观察，避免下一轮保留此图的监听。
		await watch.stop();
		// 释放外部引用；空参数对象仍由主机寿命保留。
		reference.release();
		// 关闭当前轮主机，结束它拥有的文档和派生图。
		await host.close(context);
	}
	// 数字升序排列后才能按位置取分位样本。
	times.sort((a, b) => a - b);
	// 使用 floor(length/2) 与 floor(length×0.95) 的样本，不插值；! 依赖本脚本固定的非空轮数。
	return { median: times[Math.floor(times.length / 2)]!, p95: times[Math.floor(times.length * 0.95)]! };
}

// 实际执行基准，解构毫秒结果；下面打印时乘一千转为微秒，图节点数由 LAYERS 计算。
const { median, p95 } = await bursts();
console.log(
	`retire + recreate under a ${1 + 3 * LAYERS}-derive diamond: ${(median * 1000).toFixed(1)} µs median, ${(p95 * 1000).toFixed(1)} µs p95`,
);
