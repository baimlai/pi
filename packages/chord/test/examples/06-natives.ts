// Natives: values an object opens during activation and closes when it ends (a file watcher, a connection, a timer).
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/06-natives.ts
// 文件导读
// 所属包与示例系列：packages/chord/test/examples，Chord v2 示例 06，对应 slices.md 的 slice 2（原生资源与失败）。
// 演示什么：对象激活时按声明顺序打开原生资源（这里是配置对象、定时器、socket/worker 的抽象），对象结束时按逆序关闭；
//   同时展示延迟读取（not_ready）、关闭原因（end/close）、单个关闭失败或超时不会阻塞其他关闭，以及宿主如何汇报。
// 上游/下游：上游是文件顶部的 node 命令；下游调用 src/host 的 createHost/defineFacet/self.open、src/contracts 的
//   local/method、src/data 的 isChordError。本示例只打印日志，不写文件、不发网络请求。
// 能力清单（按演示的机制）：
// - local 契约与 self.open：在工厂里声明资源；open 返回的值经 handle.value 读取。
// - 打开顺序：后声明的资源可以读取先声明资源的值，激活按声明顺序执行。
// - not_ready：工厂执行期间读取尚未打开的 value 会抛 ChordError，本示例用 isChordError 捕获并打印。
// - 关闭顺序与原因：最后一个引用释放后对象结束，natives 逆序关闭，reason.kind 为 "end"；host.close 时为 "close"。
// - closeTimeout 与失败隔离：一个 close 抛错、另一个挂起超时，其余 close 仍然执行；超时经 onError 报告，
//   抛出的关闭错误让 host.close 以 AggregateError 拒绝。
// 典型运行顺序：load -> host.get(Clock, vienna) -> 两次 now 调用 -> release（触发逆序关闭）-> 获取 tokyo ->
//   host.close（关闭 tokyo，并处理 Leaky 的抛错/超时）-> catch AggregateError 打印每个错误消息。
// 示例（符合真实签名）：
//   const config = self.open(
//     async () => ({ prefix: "[vienna]" }),
//     (value, reason) => console.log(reason.kind),
//   );
//   config.value.prefix; // 只有 open 完成后才能读取
// 运行方式与环境：需要 Node 的 strip-types 支持（见文件顶部命令，在 packages/chord 下执行）；无环境变量、无外部服务。
// 预期输出：依次出现 open config / open ticker / now: [vienna] starting / now: [vienna] ticking /
//   close ticker (end) / close config (end) / tokyo 的打开与关闭 (close) / close_timeout 报告 /
//   host.close: [ 'socket close failed' ]。时间与调度细节可能略有差异，但关闭顺序和报告内容稳定。
// 对应测试与文档：packages/chord/test/host/native.test.ts；规范见 packages/chord/docs/slices.md 的 slice 2 部分。
// 建议阅读顺序：先看两个 local 契约和两个 serve 工厂，再看 self.open 的声明顺序与延迟读取，随后看 vienna 的
//   release 关闭顺序，最后看 Leaky 与 host.close 的失败聚合。
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { int, local, method, str } from "../../src/contracts/index.ts";
import { isChordError } from "../../src/data/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { constant } from "../../src/state/index.ts";

// 后台上下文没有取消信号；所有 await 显式传入，便于示例聚焦生命周期而非取消。
const context = BACKGROUND_CONTEXT;

// Clock 按 zone 参数区分实例；zone 是只读状态，now 是无参数、返回字符串的方法。
// local 表示只在当前宿主可见；params 的每个不同取值对应一个独立对象。
const Clock = local("example.clock", {
	// 契约版本参与提供者与调用者的匹配；结构变化时应提升版本。
	version: 1,
	// 参数 schema 在 host.get 时做运行时校验；zone 必须是字符串。
	params: { zone: str() },
	// members 声明对外成员：zone 状态和 now 方法；method(undefined, str()) 表示无参数、返回字符串。
	members: { zone: str(), now: method(undefined, str()) },
});
// Leaky 用来演示关闭失败：空参数、只有一个状态成员 n；工厂里会打开两个“坏”资源。
const Leaky = local("example.leaky", { version: 1, params: {}, members: { n: int() } });

// facet 是一个宿主上的插件声明集合；setup 只登记工厂，真正的资源打开发生在对象激活时。
const facet = defineFacet((host) => {
	// Clock 工厂接收参数和 self（声明接口）；返回契约要求的实现对象。
	host.serve(Clock, ({ zone }, self) => {
		// `self.open(open, close)` declares a native; it opens after the references are live, in declaration order.
		// 声明第一个原生资源：open 返回前缀对象；close 在对象结束/宿主关闭时收到值和一个原因联合。
		// 这里的 open 是 async 函数，因此 value 要等到它 resolve 后才可读。
		const config = self.open(
			async () => {
				// 打印打开时机，帮助观察“先打开、后对外 live”的顺序。
				console.log(`${zone}: open config`);
				// 返回一个普通对象作为资源值；框架只保存它，不复制、不冻结。
				return { prefix: `[${zone}]` };
			},
			// 关闭回调的第一个参数是打开时的值，第二个是 {kind:"end"|"close"|"reload"} 判别联合。
			(_config, reason) => console.log(`${zone}: close config (${reason.kind})`),
		);
		// A later opener reads an earlier native's value. Its context is aborted if the object ends while it opens.
		// 后声明的 ticker 在 open 期间可以读取 config.value，因为前一个资源已按顺序打开。
		// 如果对象在打开途中结束，open 收到的 context 会被中止（本例未使用 ctx 参数）。
		const ticker = self.open(
			async () => {
				// 读取前一个原生资源的值，证明打开顺序；prefix 来自 config 的 open 结果。
				console.log(`${zone}: open ticker, config ${config.value.prefix}`);
				// 资源值是带计数器和定时器的对象；箭头回调每 10ms 递增 ticks。
				// 对象在初始化期间被自己的回调引用，但回调只在之后运行，因此不会读到未初始化值。
				const ticker = { ticks: 0, timer: setInterval(() => ticker.ticks++, 10) };
				// 返回资源对象，框架在关闭时把它交回 close。
				return ticker;
			},
			// 关闭时先停定时器，再打印原因，避免事件循环中继续递增。
			(ticker, reason) => {
				clearInterval(ticker.timer);
				console.log(`${zone}: close ticker (${reason.kind})`);
			},
		);
		// The factory only declares: a value is there once its open resolved.
		// try/catch 展示工厂阶段读取资源：此时 open 还没完成，value 抛 not_ready。
		try {
			// 故意在工厂内读取；这一行若成功反而说明框架提前暴露了值。
			config.value;
		} catch (error) {
			// 只处理代码为 not_ready 的 ChordError；其他错误继续向外传播（本例不会出现）。
			if (isChordError(error, "not_ready")) console.log(`${zone}: in the factory, ${error.message}`);
		}
		// 返回对象实现：zone 用 constant 包装成不可变 watchable；now 是异步方法。
		return {
			zone: constant(zone),
			// now 读取两个资源的最新值；首次调用通常 ticks 仍为 0，显示 starting，sleep 后显示 ticking。
			now: async () => `${config.value.prefix} ${ticker.value.ticks > 0 ? "ticking" : "starting"}`,
		};
	});
	// Closes that throw or hang: they never stop the other closes.
	// Leaky 故意让两个 close 出问题：一个同步抛错，一个永远不 settle 并设置 50ms 关闭超时。
	host.serve(Leaky, (_, self) => {
		self.open(
			async () => "socket",
			// 同步抛出的关闭错误会被框架收集，最终让 host.close 的 Promise 拒绝。
			() => {
				throw new Error("socket close failed");
			},
		);
		self.open(
			async () => "worker",
			// 返回一个永不 resolve 的 Promise，模拟挂起的关闭；框架在 closeTimeout 后放弃等待并报告超时。
			() => new Promise<void>(() => {}),
			// options 只影响等待时长，不会强制终止插件里的 close 工作。
			{ closeTimeout: 50 },
		);
		// 返回唯一状态成员；该对象本身没有方法。
		return { n: constant(1) };
	});
});

// onError gets what fails in the background: here a close past its closeTimeout.
// onError 接收后台错误；本例只打印 kind，并用 `in` 缩小联合后读取 object 字段（只有部分分支有该字段）。
const host = createHost({
	onError: (error) => console.log("reported:", error.kind, "object" in error ? error.object : ""),
});
// 发布 facet 并等待空参数对象（Leaky）启动；带参数的 Clock 等首次 get 才创建。
await host.load([{ name: "@example/natives", facet }], context);

// 首次获取 vienna 时钟：参数触发实例创建，返回 live 引用。
const vienna = await host.get(Clock, { zone: "vienna" }, context);
// 立即调用 now：timers 还未触发，通常打印 starting。
console.log("now:", await vienna.now(context));
// 等待 30ms，让 setInterval 至少触发一次；这只是示例的观察手段。
await sleep(30);
// 再次调用 now：ticks 已大于 0，打印 ticking。
console.log("now:", await vienna.now(context));

// The last reference gone, the object ends: natives close in reverse order, with reason `end`.
// 释放最后一个引用，对象结束；natives 按与打开相反的顺序关闭，原因是 end。
vienna.release();
// 让出事件循环，等待异步关闭日志在下一轮执行；sleep(0) 不保证所有关闭都完成，仅用于观察顺序。
await sleep(0);

// host.close ends every object at once and closes their natives with reason `close`; it rejects with every close
// that threw.
// 获取 tokyo 时钟并在 host.close 时一并结束；close 会同时关闭所有对象。
await host.get(Clock, { zone: "tokyo" }, context);
// try/catch 捕获关闭阶段的聚合错误；AggregateError.errors 保存每个抛出的原始错误。
try {
	await host.close(context);
} catch (error) {
	// instanceof 是运行时检查，用来确认错误是 AggregateError（TypeScript 不会仅凭类型断言保证）。
	if (error instanceof AggregateError)
		console.log(
			"host.close:",
			// map 把每个错误转成消息；回调参数显式标注 Error，便于学习类型注解。
			error.errors.map((e: Error) => e.message),
		);
}
