// Failures: how an activation fails (transient or broken), how Chord retries it, and what getters see.
// Run from packages/chord (takes about 3 s: the retries wait 1 s, then 2 s):
//   node --conditions=source --experimental-strip-types test/examples/07-failures.ts
// 文件导读
// 所属包与示例系列：packages/chord/test/examples，Chord v2 示例 07，对应 slice 2（失败分类、重试、停车）。
// 演示什么：对象激活失败时如何区分 transient（可重试）与 broken（重试无意义）；退避重试的时间表；readyTimeout 如何
//   放弃一个迟迟不 live 的尝试；依赖失败时上层对象如何“停车”等待，以及 get 最终向调用者抛出什么。
// 上游/下游：文件顶部命令启动；下游使用 src/host 的 createHost/defineFacet/self.get/self.derive、src/data 的 broken/
//   isChordError。示例只打印时间线，不访问网络，所谓“连接被拒绝”是人为抛出的错误。
// 能力清单（按演示的机制）：
// - 失败分类：open 抛普通错误 = transient，按 1s、2s、4s…（上限 60s）退避重试；抛 broken(error) = broken，不重试。
// - onError 报告：每次失败尝试以 HostError kind "activation_failed" 上报，含对象标签与 failure.kind/error。
// - readyTimeout：宿主级 500ms 与单次 get 的 700ms 覆盖值；超时尝试被放弃并记为 transient 失败。
// - 依赖停车：Inbox 通过 self.get 依赖 Remote；Remote 失败时 Inbox 不运行自己的重试计时器，等 Remote live 后继续。
// - get 的错误：失败对象让 get 拒绝为 ChordError code "unavailable"，message 带对象标签和原因。
// 典型运行顺序：load（等待空参数 Remote 的首次结果）-> get(Mirror) 立即失败 -> get(Stuck) 等 700ms 后失败 ->
//   get(Inbox) 等待 Remote 的第 3 次尝试成功 -> close。
// 示例（符合真实签名）：
//   self.open(async () => { throw broken(new Error("no mirror configured")); }, () => {});
//   try { await host.get(Mirror, { id: 1 }, context); }
//   catch (error) { if (isChordError(error)) console.log(error.code); } // "unavailable"
// 运行方式与环境：在 packages/chord 下执行文件顶部命令；无环境变量、无外部服务；约 3 秒后退出。
// 预期输出：0.0s remote attempt 1 与 transient 报告、loaded、mirror 的 broken 报告与 unavailable 拒绝、
//   0.5s stuck 的 transient 报告、0.7s stuck 拒绝与 inbox 工厂日志、1.0s remote attempt 2、3.0s remote attempt 3、
//   最后 inbox: mario: connected。时间戳允许少量调度误差。
// 对应测试与文档：packages/chord/test/host/backoff.test.ts、attempt.test.ts、parked.test.ts；
//   slices.md 的 slice 2；停车依赖的更多细节见示例 31-parked-dependencies.ts。
// 建议阅读顺序：先看四个 local 契约和 serve 工厂（尤其 broken 与永不完成的 open），再看 onError/attempt 辅助函数，
//   最后按 main 中的调用顺序读时间线。
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { int, local, str } from "../../src/contracts/index.ts";
import { broken, isChordError } from "../../src/data/index.ts";
import { createHost, defineFacet, type HostError } from "../../src/host/index.ts";
import { constant } from "../../src/state/index.ts";

// 后台上下文没有取消信号；get 的等待由 readyTimeout 控制。
const context = BACKGROUND_CONTEXT;
// 记录示例起点，用于把日志时间换算成相对秒数。
const start = Date.now();
// at() 返回“距起点多少秒”的字符串；toFixed(1) 固定一位小数，只是展示用途。
const at = (): string => `${((Date.now() - start) / 1000).toFixed(1)} s`;

// A connection to a remote service, which is down for the first two attempts.
// Remote 没有参数，因此随宿主生命周期存在；load 会等待它的首次结果。
const Remote = local("example.remote", { version: 1, params: {}, members: { status: str() } });
// An inbox per user, which needs the connection.
// Inbox 按 user 区分实例，通过依赖引用使用 Remote 的状态。
const Inbox = local("example.inbox", { version: 1, params: { user: str() }, members: { status: str() } });
// A mirror whose configuration is missing: retrying cannot help.
// Mirror 用来演示 broken：配置缺失是确定性错误，重试没有意义。
const Mirror = local("example.mirror", { version: 1, params: { id: int() }, members: { status: str() } });
// A service whose open never finishes.
// Stuck 的 open 永不 resolve，用来触发 readyTimeout。
const Stuck = local("example.stuck", { version: 1, params: { id: int() }, members: { status: str() } });

// attempts 是跨对象共享的计数器：每次 Remote 工厂执行就加一，用来决定前两次是否抛错。
let attempts = 0;
// facet 登记四个工厂；所有日志都在激活/重试时打印。
const facet = defineFacet((host) => {
	host.serve(Remote, (_, self) => {
		// ++attempts 先自增再返回，因此第一次尝试 attempt 为 1；这个值被闭包捕获。
		// 注意：transient 重试会重新执行整个工厂，因此每次尝试都会得到新的 attempt。
		const attempt = ++attempts;
		self.open(
			async () => {
				// 打印本次尝试的时刻与序号，观察退避间隔。
				console.log(`${at()}: remote, attempt ${attempt}`);
				// A throwing open is transient: Chord retries it after 1 s, then 2 s, 4 s, ... up to 60 s.
				// 前两次抛出普通 Error，框架将其归类为 transient；第三次返回成功值。
				if (attempt <= 2) throw new Error("connection refused");
				return { connected: true };
			},
			// 关闭回调什么也不做；示例只关心激活阶段。
			() => {},
		);
		// 状态成员声明为恒定的 "connected"；真正的就绪与否由激活是否成功决定。
		return { status: constant("connected") };
	});
	host.serve(Inbox, ({ user }, self) => {
		// A dependency that fails parks this object (`failed { waiting }`, no timer of its own, the factory not run
		// again); it goes on the moment the dependency is live (31-parked-dependencies.ts).
		// self.get 声明对 Remote 的依赖：Chord 负责获取并持有该引用，失败时让 Inbox 停车等待。
		// 停车期间不会重新运行工厂，也没有独立的重试计时器；Remote live 后从这里继续。
		const remote = self.get(Remote, {});
		// 工厂只运行一次；日志用于观察它相对 Remote 重试的时间点。
		console.log(`${at()}: inbox ${user}, attempt`);
		// derive 以 Remote 的 status 为源；依赖未就绪时派生不会计算，get 也就不会返回。
		return { status: self.derive([remote.status], ([status]) => `${user}: ${status}`) };
	});
	host.serve(Mirror, (_, self) => {
		self.open(
			async () => {
				// broken(error) says retrying is pointless: no retry, and getters are rejected at once.
				// broken 包装错误并标记为不可重试；框架不会安排下一次尝试。
				throw broken(new Error("no mirror configured"));
			},
			() => {},
		);
		return { status: constant("mirroring") };
	});
	host.serve(Stuck, (_, self) => {
		self.open(
			// 永远不 settle 的 Promise：激活一直处于进行中，直到 readyTimeout 放弃本次尝试。
			() => new Promise(() => {}),
			() => {},
		);
		return { status: constant("never") };
	});
});

// Every failed attempt is reported, with its object and cause.
// onError 的参数类型是 HostError 联合；先比较 kind 才能安全读取 activation_failed 分支的字段。
const onError = (error: HostError): void => {
	// 只处理激活失败；其他后台错误（例如关闭失败）在本例中忽略。
	if (error.kind === "activation_failed") {
		// object 是带参数的标签（如 example.mirror(1)）；failure 含 kind（transient/broken）和原始 error。
		console.log(`${at()}: reported ${error.object}, ${error.failure.kind}: ${error.failure.error.message}`);
	}
};

/** Prints how a get ended. */
// attempt 辅助函数：执行一次 get 并打印结果或错误；输入是标签和返回引用的异步函数。
// 这样三个场景可以复用同一段 try/catch，而不改变各自的 get 选项。
async function attempt(label: string, work: () => Promise<{ status: { value: string } }>): Promise<void> {
	// try 里等待 work 返回引用；成功则读取状态成员的当前值。
	try {
		const reference = await work();
		console.log(`${at()}: ${label}: ${reference.status.value}`);
	} catch (error) {
		// isChordError(error) 不带 code 时只判断“是否是 Chord 错误”；随后读取 code 和 message。
		if (isChordError(error)) console.log(`${at()}: ${label}: ${error.code} - ${error.message}`);
	}
}

// Every attempt must be live within readyTimeout (here 500 ms); getters wait up to it too, unless they say otherwise.
// 宿主级 readyTimeout 为 500ms：每次激活尝试若在该时间内没有 live 就被放弃并记为 transient。
const host = createHost({ onError, readyTimeout: 500 });
// The start barrier: load resolves once the remote (empty params: it lives as long as the host) had its first outcome.
// load 的启动屏障：空参数对象必须产生首次结果（成功或失败）后才 resolve；这里 Remote 第一次失败，因此 load 在 0.0s 返回。
await host.load([{ name: "@example/failures", facet }], context);
console.log(`${at()}: loaded`);

// A broken failure rejects the get at once.
// Mirror 的 broken 立即让 get 拒绝，不经过等待与重试。
await attempt("mirror", () => host.get(Mirror, { id: 1 }, context));

// An attempt not live within readyTimeout is abandoned and fails transient; this get waits longer (700 ms) and then
// rejects with the last failure's error.
// 单次 get 的 options 覆盖宿主 readyTimeout：等待 700ms，比 500ms 的激活上限长，因此能看到超时后的拒绝。
await attempt("stuck", () => host.get(Stuck, { id: 1 }, context, { readyTimeout: 700 }));

// Transient failures keep a get waiting through the retries, up to its deadline: the inbox goes live with the remote.
// Inbox 的 get 给足 10 秒；它依赖的 Remote 在第 3 次尝试（约 3.0s）成功，随后 Inbox 一次就绪。
await attempt("inbox", () => host.get(Inbox, { user: "mario" }, context, { readyTimeout: 10_000 }));

// 关闭宿主；本例没有需要特殊清理的原生资源。
await host.close(context);
