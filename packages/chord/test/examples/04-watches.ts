// Watches: follow a state member from its current value through the commits that change it; a busy listener gets
// what changed meanwhile folded into one call; a derive that throws gives a `failed` call, the watch stays open, and
// its next value arrives as a root replacement (it heals on a later change).
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/04-watches.ts
// 文件导读
// 所属包与示例系列：packages/chord/test/examples，Chord v2 示例 04，对应 slice 1（watches，design §11/§12）。
// 演示什么：观察一个状态成员从获取时的当前值开始，按提交顺序异步收到增量。监听器不重叠；忙的监听器会把期间的变化
//   折叠进下一次调用（最新值 + 自上次以来的 ops）。派生计算抛错产生 failed 通知，观察保持打开；恢复后的第一条值
//   以根替换（"r"）到达。取消上下文结束单个观察，释放引用结束经该引用创建的全部观察，退休单例发布根替换。
// 上游/下游：文件顶部命令启动；下游使用 src/context 的 withCancel、src/documents 的 defineState、src/host 的
//   createHost/defineFacet、src/contracts 的 local/method/schema。示例全在进程内运行，无网络。
// 能力清单（按演示的机制）：
// - watchable.watch(ctx)：原子取得当前值并开始缓冲；返回带 value/start/closed 的观察句柄。
// - start(listener)：监听器收到 { kind: "value", value, ops } 或 { kind: "failed", error }；异步、有序、不重叠。
// - ops：从上一值到新值的增量（"s" set，"r" 根替换）；观察者据此更新副本。
// - 折叠：慢监听器忙碌期间的多个提交合并为一次调用，值是最新值，ops 是折叠后的变化。
// - 派生失败：half 在奇数时抛错，onError 按失败阶段报告一次 derive_failed；观察不结束，恢复时根替换。
// - withCancel(context)：派生子上下文；cancel() 使该观察以 aborted 结束。
// - counter.release()：释放引用，结束经该引用创建的全部观察（kind: "ended"）。
// - retire：单例重置为 initial()，观察者收到根替换，不结束观察。
// 典型运行顺序：load -> get Counter -> 建立 count/double/half/slow 四个观察 -> bump 三次（观察异步打印）->
//   reset -> cancel 子上下文 -> 读 double 的结束原因 -> 释放 counter -> 读 count 的结束原因 -> close。
// 示例（符合真实签名）：
//   const watch = await counter.count.watch(context);
//   console.log(watch.value); // 获取时的快照
//   watch.start(async (call) => {
//     if (call.kind === "value") console.log(call.value, call.ops);
//   });
//   const { context: cancellable, cancel } = withCancel(context);
//   const doubled = await counter.double.watch(cancellable);
//   console.log(await doubled.closed); // { kind: "aborted" }
// 运行方式与环境：在 packages/chord 下执行文件顶部命令；无环境变量、无网络；约 0.15 秒完成。
// 预期输出（监听器异步执行，行的先后可能因调度略有不同）：
//   acquired: { n: 0 }
//   reported: example.counter.half: Error: 1 has no half
//   count frame: { n: 1 } [["s",["n"],1]]
//   slow frame: { n: 1 } [["s",["n"],1]]
//   double frame: 2 [["r",2]]
//   half failed: 1 has no half
//   …随后 n=2 恢复、n=3 再失败、reset 后各观察收到 { n: 0 } 的根替换…
//   double watch: { kind: 'aborted' }
//   count watch: { kind: 'ended' }
// 对应测试与文档：packages/chord/test/state/watchable.test.ts、batch.test.ts、derive.test.ts；
//   packages/chord/test/host/follow.test.ts；slices.md 的 slice 1；design.md 的 §11/§12。
// 建议阅读顺序：先看 Count/Counter 与工厂里的 double/half 派生，再看四个 watch 与监听器，最后按 bump、reset、
//   cancel、release 理解结束原因。
import { BACKGROUND_CONTEXT, withCancel } from "../../src/context/index.ts";
import { int, local, method, obj } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";

// 后台上下文不主动取消；下面另派生一个可取消上下文演示观察生命周期。
const context = BACKGROUND_CONTEXT;

// Count 是内存单例文档，初值 n=0；initial 无参数且首次结果按 schema 检查。
const Count = defineState("count", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
// 空参数计数器公开文档、两个派生值和两个方法；状态 schema 不代表每次读都会校验。
const Counter = local("example.counter", {
	version: 1,
	params: {},
	members: { count: obj({ n: int() }), double: int(), half: int(), bump: method(), reset: method() },
});

// setup 只登记 Counter 工厂，返回 void；load 时执行声明。
const facet = defineFacet((host) => {
	// 工厂忽略空参数，用 self 声明计数文档与派生；返回与契约同名的实现。
	host.serve(Counter, (_, self) => {
		// 取得计数文档句柄，change/retire 会通过本对象事务修改它。
		const count = self.state(Count);
		return {
			// 将单例句柄原样暴露为可观察状态。
			count,
			// 纯计算回调从源数组解构当前计数，再返回两倍数值。
			double: self.derive([count], ([c]) => c.n * 2),
			// half 回调接收当前文档值；偶数返回一半，奇数主动抛错以演示派生成员可恢复失败。
			// 例：n=1 产生 failed 通知，n=2 之后重新计算恢复；不改 Count 文档。
			half: self.derive([count], ([c]) => {
				// 取余为1时抛错，本例从0递增所以覆盖正奇数；失败归属于 half，其他状态仍可用。
				if (c.n % 2 === 1) throw new Error(`${c.n} has no half`);
				// 通过检查后返回除二结果。
				return c.n / 2;
			}),
			// bump 无业务参数，接收 ctx，经一次事务把 n 加一；提交失败向调用者传播，成功返回 null。
			bump: async (ctx) => {
				// 等待单文档 change 提交；内部回调同步改草稿，不写对外共享值。
				await count.change((draft) => {
					// 草稿 n 增加1，并由 Delta 记录修改操作。
					draft.n++;
				}, ctx);
				// 方法没有业务结果，使用 null。
				return null;
			},
			// reset 接收 ctx，退休计数单例并返回 null；退休通知仍会送达观察者，观察不会因此结束。
			reset: async (ctx) => {
				// 把单例重置为 initial()，发布带退休标记的根替换。
				await count.retire(ctx);
				// 方法没有业务结果，使用 null。
				return null;
			},
		};
	});
});

// A derive whose compute throws is reported once per failure episode (`derive_failed`).
// 创建宿主，以下 onError 回调专门区分派生错误和其他后台错误。
const host = createHost({
	// 后台错误回调无返回值；kind 是联合类型标签，分支内 TypeScript 才允许读取对应字段。
	onError: (error) => {
		// 派生计算的一个失败阶段报告一次，打印对象、成员和原因。
		if (error.kind === "derive_failed") console.log(`reported: ${error.object}.${error.member}: ${error.error}`);
		// 其余错误写 stderr，便于发现非预期问题。
		else console.error("background error:", error);
	},
});
// 加载声明并等待 Counter 的首次启动结果。
await host.load([{ name: "@example/counter", facet }], context);
// 等待取得已就绪引用，然后才能安全读取其初始状态。
const counter = await host.get(Counter, {}, context);

// A watch holds the value at acquisition; its listener then gets the changes, asynchronously and in order, never
// overlapping itself. A listener that keeps up gets one call per commit: the new value and the ops that turn the
// previous value into it.
// 原子取得当前值并开始缓冲后续变化；start 安装监听器之前也不会漏掉中间提交。
const watch = await counter.count.watch(context);
// 打印获取观察句柄时的快照，并非额外一条 listener 通知。
console.log("acquired:", watch.value);
// 监听器接收带 kind 的通知并返回 Promise<void>；仅 value 分支打印最新值与增量操作。
watch.start(async (call) => {
	// 收窄后才能访问 value/ops；JSON.stringify 只为展示操作数组。
	if (call.kind === "value") console.log("count frame:", call.value, JSON.stringify(call.ops));
});

// A derive's frame carries the diff of its old and new value.
// 对象解构把 context 字段重命名为 cancellable，另取 cancel；取消子上下文不改变原 context。
const { context: cancellable, cancel } = withCancel(context);
// 用子上下文观察 double，后面的 cancel 会结束这一观察。
const doubled = await counter.double.watch(cancellable);
// double 的异步监听器只显示值通知，不修改来源文档。
doubled.start(async (call) => {
	// 显示派生值和由旧值到新值的差异，而非原 count 草稿操作。
	if (call.kind === "value") console.log("double frame:", call.value, JSON.stringify(call.ops));
});

// A failing derive: one `failed` call per failure, the watch stays open; the next value replaces the root.
// 在 half 当前有效时取得观察；后续计算失败仍保留此句柄。
const half = await counter.half.watch(context);
// half 监听器区分可恢复失败和值；回调本身若抛错才会结束观察。
half.start(async (call) => {
	// 本例知道 half 抛 Error，使用 as 作开发期断言；as 不会检查或转换运行时错误。
	if (call.kind === "failed") console.log("half failed:", (call.error as Error).message);
	// 恢复后的第一条值通知使用根替换，避免沿失败阶段继续应用旧增量。
	else console.log("half frame:", call.value, JSON.stringify(call.ops));
});

// A slow listener: commits made while it is busy fold into its next call, with the newest value and the ops since
// its previous call (an `s` on one path replaces the one before it).
// 第二个 count 观察者独立缓冲，故意等待来演示合并通知。
const slow = await counter.count.watch(context);
// 慢监听器先忽略失败，再打印并等待20ms；同一监听器调用不重叠，期间变化折叠到下一次通知。
slow.start(async (call) => {
	// 提前返回排除失败分支，并让后面 call 类型收窄到值通知。
	if (call.kind !== "value") return;
	// 打印此批最新值和上次通知以来折叠后的操作。
	console.log("slow frame:", call.value, JSON.stringify(call.ops));
	// Promise 执行器登记计时器，resolve 到时让监听器继续；20ms 是请求等待时间，不是精确调度保证。
	await new Promise((resolve) => setTimeout(resolve, 20));
});

// 等待一次自增提交；监听器异步执行，因此这里不承诺它们已经处理完。
await counter.bump(context);
// 让出事件循环，让首条异步监听有机会开始；0并不表示同步立即执行。
await new Promise((resolve) => setTimeout(resolve, 0));
// 等待一次自增提交；监听器异步执行，因此这里不承诺它们已经处理完。
await counter.bump(context);
// 等待一次自增提交；监听器异步执行，因此这里不承诺它们已经处理完。
await counter.bump(context);
// 留出观察日志展示时间；它是演示等待，不是针对所有机器的完成证明。
await new Promise((resolve) => setTimeout(resolve, 50));
// Retiring the singleton resets it to initial(): watches get a root replacement.
// 退休单例后仍继续观察，并可看到重置为0的通知。
await counter.reset(context);
// 留出观察日志展示时间；它是演示等待，不是针对所有机器的完成证明。
await new Promise((resolve) => setTimeout(resolve, 50));

// Cancelling the watch's context ends it; stop() ends it too. Releasing the reference ends the watches taken through it.
// 触发子上下文取消，结束 doubled；其他用后台上下文创建的观察仍继续。
cancel();
// 等待 double 的最终结束原因，而不是等待下一条值。
console.log("double watch:", await doubled.closed);
// 释放引用，结束经该引用创建的全部观察；空参数对象本身继续随宿主存活。
counter.release();
// 打印 count 观察因引用释放而结束的结果。
console.log("count watch:", await watch.closed);

// 结束宿主及其仍存活的对象。
await host.close(context);
