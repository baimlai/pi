// Jobs: owned work a call starts that outlives the call, in Durable's sandwich: intent (`start`, one transaction), run
// (any effect, outside transactions) and finish (one transaction on the current code, with the cleanup). Here a shell
// job of a shared chat store: its state document carries the output, throttled by the author and flushed in a
// `finally`, so the last output reaches `outcome.state` after an abort too; `running` is ordinary state, which
// per-principal views filter (a guest sees no output); `finish` records an entry and chains a second job.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/19-jobs.ts
// 文件导读
// 所属包与示例系列：packages/chord/test/examples，Chord v2 示例 19，对应 slice 5（routines and jobs 中的 jobs）。
// 演示什么：作业（job）是“一次调用启动、但比调用活得久”的工作，按 Durable 的三段式组织：
//   intent（start，一个事务校验参数、去重、检查并发并创建运行记录）、run（事务之外执行副作用）、
//   finish（对当前代码执行一个事务，带上清理）。本例是共享 chat store 的 shell 作业：运行状态文档保存输出，
//   作者按 50ms 节流提交，并在 finally 里做最后一次刷新，因此即使运行被 abort，最后一段输出也会进入
//   outcome.state；running 是普通可观察状态，按 principal 的远端变体过滤（guest 看不到 output）；
//   finish 在同一个事务里追加条目并链式启动第二个 notify 作业。
// 上游/下游：文件顶部命令启动；下游使用 src/jobs 的 defineJob、src/output.ts 的 OutputBuffer/Progress、
//   src/state 的 mapShared、src/host 的 createHost/defineFacet/sleep、src/documents 的 defineState、
//   src/link 的 memoryLinkPair。示例全在进程内运行，不访问网络，也没有真实的子进程。
// 能力清单（按演示的机制）：
// - defineJob：version、args/result schema、state 文档、concurrency；args 在每次 start 时按 schema 校验。
// - self.job(Job, { run, finish })：run 在事务外执行，拿到 ctx.jobId 与 ctx.state；finish 收到 outcome 与 tx。
// - RunState.change：每次都是运行状态文档上的独立小事务；运行结算前（包括 abort 之后）仍被接受。
// - OutputBuffer：必须给出 maxBytes/maxLines/retain；这里保留尾部，超出部分被丢弃并计数。
// - Progress：mark() 按最小间隔节流提交，返回的字节数再按 100 KiB/s 摊开下一次提交时间；stop() 等待在途提交。
// - key 去重：同一未结算运行的 key 直接返回原 Run，不比较 args；运行 id 与 key 不同。
// - concurrency：running + finishing 都占名额；超过限额以 unavailable/busy 拒绝，只影响该次调用。
// - running：Watchable<readonly RunningEntry[]>，条目按 phase 分为 running/finishing 或 blocked。
// - 按 principal 的视图：owner 变体含 output，guest 变体经 mapShared 去掉 output。
// - finish 链式启动：tx.start(notify, …) 与 outcome 的处理同一次提交，二者都成功或都回滚。
// - abort 是请求：标记运行并触发 run 的 ctx 信号，run 在下一个 sleep 处停止，finish 记录 interrupted。
// 典型运行顺序：server load -> owner/guest 两个 tab -> 启动 r1 并重发（去重）-> 100ms 后观察两边的 running ->
//   第二个命令因并发限额被拒 -> 300ms 后第一个运行完成，entries 出现 shell 摘要与 notify 结果 ->
//   启动长任务 r3 -> 100ms 后 abort -> entries 出现 interrupted 摘要与 notify 结果 -> running 为空 -> 关闭。
// 示例（符合真实签名）：
//   const ShellJob = defineJob("example.shell", {
//     version: 1,
//     args: obj({ command: str(), lines: int() }),
//     result: obj({ exit: int(), output: str() }),
//     state: ShellState,
//     concurrency: 1,
//   });
//   const shell = self.job(ShellJob, { run: async ({ lines }, ctx) => { /* … */ }, finish: async (outcome, tx) => { /* … */ } });
//   const run = await shell.start({ command: "npm test", lines: 5 }, ctx, { key: "r1" });
//   await shell.abort(run.id, ctx); // Promise<"marked" | "terminal">
// 运行方式与环境：在 packages/chord 下执行文件顶部命令；无环境变量、无外部服务；约 1 秒完成。
// 预期输出（运行 id、输出行数与 console.log 的换行方式因运行而异）：
//   a resent request returns the same run: true
//   owner sees: 一条 { id: '…', phase: 'running', command: 'npm test', output: 'line 1\nline 2\n' }
//   guest sees: 同一条但去掉 output 字段
//   （对象经 util.inspect 打印，终端宽度不足时会分成多行。）
//   second run refused: example.chat-store job example.shell: at its concurrency limit (1)
//   entries after the first run: [ 'npm test: exit 0, 5 lines', 'notified: npm test' ]
//   entries after the abort: [ …, 'tail -f log: interrupted (aborted), 3 lines kept', 'notified: tail -f log' ]
//   running now: []
// 对应测试与文档：packages/chord/test/jobs/job.test.ts、run.test.ts、running.test.ts、definition.test.ts、
//   records.test.ts、persisted.test.ts；slices.md 的 slice 5；design.md 关于作业三段式、running、去重与并发的章节。
// 建议阅读顺序：先看三个 schema 与两个 defineJob，再看 runProcess，随后看 facet 里的 run/write/Progress/finish，
//   接着看 toShell 与 owner/guest 视图，最后按 3-5 步读去重、并发拒绝与 abort。
import { BACKGROUND_CONTEXT, type Context } from "../../src/context/index.ts";
// 契约构造器：obj/arr/str/int 描述 JSON 形状，local/remote 声明对象类型，method 声明调用，hostKind 声明地址。
import { arr, hostKind, int, local, method, obj, remote, type Static, str } from "../../src/contracts/index.ts";
// 文档定义：每个 shell 运行与共享 entries 各有一份文档。
import { defineState } from "../../src/documents/index.ts";
// 宿主、facet 与 sleep（runProcess 用它模拟外部进程的节奏）。
import { createHost, defineFacet, sleep } from "../../src/host/index.ts";
// defineJob 声明作业；self.job 在对象工厂里绑定实现。
import { defineJob } from "../../src/jobs/index.ts";
// 内存链路对：server 的入口端与 tab 的客户端端。
import { memoryLinkPair } from "../../src/link/index.ts";
// 共享输出工具：OutputBuffer 是有界缓冲，Progress 节流并合并状态提交。
import { OutputBuffer, Progress } from "../../src/output.ts";
// mapShared 按输入对象缓存映射结果，保证视图对象身份稳定。
import { mapShared } from "../../src/state/index.ts";

// 后台上下文：start、abort、get 与关闭都显式传入。
const context = BACKGROUND_CONTEXT;

// P 是三种 principal：owner 能跑命令，guest 只看运行列表，server 是宿主自身。
type P = { kind: "owner" } | { kind: "guest" } | { kind: "server" };

// 1. The job: closed args (checked at every start), a result, a state document per run, one run at a time.
// ShellState 是每次运行独立的状态文档，初值为空输出；运行结算后文档退役。
const ShellState = defineState("example.shell.state", {
	schema: obj({ output: str() }),
	version: 1,
	initial: () => ({ output: "" }),
});
// defineJob 的 args/result 都是 schema：start 时校验 args（非法参数以 invalid/args 拒绝），result 描述 run 的返回值。
// state 指定每次运行的状态文档；concurrency: 1 限制同一时刻的未结算运行数。
const ShellJob = defineJob("example.shell", {
	version: 1,
	args: obj({ command: str(), lines: int() }),
	result: obj({ exit: int(), output: str() }),
	state: ShellState,
	// 并发限额把 running 与 finishing 的运行一起计数；finish 尚未结束时也占名额。
	concurrency: 1,
});
/** A second job `finish` chains: it announces a finished command. */
// NotifyJob 只接收 text 并返回字符串；它自己没有 state，用来演示 finish 里链式启动。
const NotifyJob = defineJob("example.notify", { version: 1, args: obj({ text: str() }), result: str() });

// Entries 是共享聊天记录文档；finish 把完成或中断摘要追加到 list。
const Entries = defineState("example.entries", {
	schema: obj({ list: arr(str()) }),
	version: 1,
	initial: () => ({ list: [] }),
});

/** A shell as its owner sees it; a guest's view has no output. */
// 两个 schema 是视图形状：owner 版本含 output，guest 版本不含；Static<typeof …> 在编译期取出对应 TS 类型。
const Shell = obj({ id: str(), phase: str(), command: str(), output: str() });
const GuestShell = obj({ id: str(), phase: str(), command: str() });

/** The shared store: the entries and the shells once, whoever views them (§6). */
// ChatStore 是 local 契约、params 为空，因此每个宿主只有一个对象；所有视图共享同一份数据。
const ChatStore = local("example.chat-store", {
	version: 1,
	params: {},
	members: {
		entries: arr(str()),
		shells: arr(Shell),
		runShell: method(obj({ command: str(), lines: int(), requestId: str() }), str()),
		abortShell: method(obj({ id: str() })),
	},
});

// The server's host kind: a remote contract's `hostAddress` names the host serving its objects.
// 无参数 hostKind；Chat 的 hostAddress 固定指向它。
const Server = hostKind("server");

/** Per-principal views: the owner runs shells and sees their output, a guest sees which shells run. */
// 远端契约按 principal 选择变体：owner 有 state 与两个方法，guest 只有 state，且 shell 形状不含 output。
const Chat = remote("example.chat", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		owner: {
			state: { entries: arr(str()), shells: arr(Shell) },
			methods: {
				runShell: method(obj({ command: str(), lines: int(), requestId: str() }), str()),
				abortShell: method(obj({ id: str() })),
			},
		},
		guest: { state: { entries: arr(str()), shells: arr(GuestShell) } },
	},
});

/** A fake process: one line every 30 ms; `sleep` rejects when the run is aborted. */
// runProcess 模拟外部进程：每 30ms 产出一行并通过 onLine 上报；正常结束返回退出码 0。
// 输入：行数 lines、运行上下文 ctx、逐行回调 onLine；输出：Promise<number>（退出码）。
// 错误路径：ctx 被中止时 sleep 立即拒绝，异常沿 await 抛给 run 的调用方，不在这里吞掉。
// 副作用：按节奏调用 onLine；不直接写文档，写文档由 run 的回调决定。
async function runProcess(lines: number, ctx: Context, onLine: (line: string) => void): Promise<number> {
	// 从第 1 行到第 lines 行，逐行产出。
	for (let n = 1; n <= lines; n++) {
		// 等待 30ms；运行被 abort 时这里抛错，循环立即结束。
		await sleep(30, ctx);
		// 把带换行的一行交给调用方；缓冲区与节流提交都在回调里完成。
		onLine(`line ${n}\n`);
	}
	// 正常结束的退出码；中断路径不会执行到这里。
	return 0;
}

// facet 在 server 上登记两个类型：共享存储与按 principal 的视图。
const facet = defineFacet<P>((host) => {
	host.serve(ChatStore, (_, self) => {
		// 共享文档句柄；所有视图通过 derive 读取它。
		const entries = self.state(Entries);
		// self.job 返回作业句柄；run 在事务外执行，finish 在单个事务里执行（可带清理）。
		const notify = self.job(NotifyJob, {
			// 简单作业：直接把 text 包装成结果字符串。
			run: async ({ text }) => `notified: ${text}`,
			// finish 只处理成功结果；failed 的 notify 不会写条目。
			finish: async (outcome, tx) => {
				// done 分支下 TypeScript 窄化出 outcome.result（字符串）。
				if (outcome.kind === "done") (await tx.draft(entries)).list.push(outcome.result);
			},
		});
		// shell 句柄：run 执行假进程并节流写入状态文档；finish 记录摘要并链式启动 notify。
		const shell = self.job(ShellJob, {
			run: async ({ lines }, ctx) => {
				// The output's bounds are required: a tail of at most 2,000 lines and 64 KiB.
				// OutputBuffer 的三个选项都必填：最多 64 KiB、最多 2000 行、保留尾部；超出时丢弃头部并记账。
				const out = new OutputBuffer({ maxBytes: 64 * 1024, maxLines: 2_000, retain: "tail" });
				// Every state change is a commit and, while watched, a message: the author throttles them (50 ms here).
				// write 读取当前快照写入运行状态文档，并返回写入的字符数：Progress 用这个数字安排下一次提交时间。
				// 每次 ctx.state.change 都是独立小事务；运行结算前（包括 abort 之后）都继续接受。
				const write = async () => {
					const text = out.snapshot().text;
					await ctx.state.change((draft) => {
						draft.output = text;
					}, ctx);
					return text.length;
				};
				// Progress 以 50ms 为最小间隔合并 mark；返回的字节数还会按 100 KiB/s 摊开下一次提交时间。
				// 第二个参数是提交失败时的回调；示例直接打印，不中断运行。
				const progress = new Progress(write, (error) => console.error("progress failed:", error), 50);
				try {
					// runProcess 每产出一行：先放入有界缓冲，再标记需要提交（是否真的提交由节流决定）。
					const exit = await runProcess(lines, ctx, (line) => {
						out.push(line);
						progress.mark();
					});
					// 正常结束时返回退出码与最终快照；Outcome 会把它与 args/state 一起交给 finish。
					return { exit, output: out.snapshot().text };
				} finally {
					// The last output reaches `outcome.state`, also after an abort (changes are taken until run settles).
					// stop() 停止调度并等待在途提交；返回尚未 settle 的 waiter 数组——本例只用 mark()，
					// 没有 waiter，最后一次写入由下一行显式执行。
					await progress.stop();
					// 最终刷新不属于节流：确保 abort 后已产出的行也进入 state，并进入 finish 的 outcome。
					await write();
				}
			},
			finish: async (outcome, tx) => {
				// outcome 携带 args、state 与 done/failed 判别；整个 finish 在同一个事务 tx 中。
				const { command } = outcome.args;
				// 用换行数得到已保留的行数；末尾换行使 split 多出一项，因此减 1。
				const lines = outcome.state.output.split("\n").length - 1;
				// done 与 failed 使用不同摘要；failed 的 error.kind 是 aborted、threw 或 restart_limit。
				const text =
					outcome.kind === "done"
						? `${command}: exit ${outcome.result.exit}, ${lines} lines`
						: `${command}: interrupted (${outcome.error.kind}), ${lines} lines kept`;
				// tx.draft 只在该事务内草稿；条目追加与运行记录的删除同一次提交。
				(await tx.draft(entries)).list.push(text);
				// Chaining: the next job starts atomically with this outcome (both commit or neither).
				// tx.start 在同一事务里启动 notify：本事务提交则 notify 已创建，回滚则两者都不发生。
				tx.start(notify, { text: command });
			},
		});
		// What the views read: one object per run, kept while the run's entry is the same object (`mapShared`).
		// toShell 把 running 条目映射成视图行。blocked 条目不含 args/state（可能来自旧版本代码），
		// 因此命令用 "?"、输出为空；其他 phase 才能安全读取 args 与 state。
		// mapShared 用 WeakMap 按条目对象缓存结果：条目对象不变时复用同一个视图对象，下游不会把它当成变化。
		// 类型说明：(typeof shell.running.value)[number] 是数组元素类型；Static<typeof Shell> 是 schema 的 TS 值类型。
		const toShell = mapShared(
			(entry: (typeof shell.running.value)[number]): Static<typeof Shell> =>
				entry.phase === "blocked"
					? { id: entry.id, phase: entry.phase, command: "?", output: "" }
					: { id: entry.id, phase: entry.phase, command: entry.args.command, output: entry.state.output },
		);
		return {
			// entries 是文档列表的派生视图。
			entries: self.derive([entries], ([d]) => d.list),
			// shells 派生自 running：每次运行列表变化时用 toShell 生成稳定身份的视图数组。
			shells: self.derive([shell.running], ([running]) => toShell(running)),
			// runShell 用 requestId 作为 start 的 key：同一未结算运行的重发请求返回同一个 Run（不比较 args）。
			// 返回的是运行 id（uuidv7），不是去重 key，供客户端后续 abort。
			runShell: async ({ command, lines, requestId }, ctx) =>
				(await shell.start({ command, lines }, ctx, { key: requestId })).id,
			abortShell: async ({ id }) => {
				// abort 是请求：标记运行并触发 run 的 ctx 信号；这里用后台 context，且不等待结果。
				// void 丢弃 Promise<"marked" | "terminal">；远程调用立即返回 null，运行在下一个 sleep 处停止。
				void shell.abort(id, context);
				return null;
			},
		};
	});
	// Chat 的工厂按 principal 选择变体；两个变体共享同一个 ChatStore 引用。
	host.serve(Chat, (_, principal, self) => {
		// local 契约、空 params：身份稳定，两个变体拿到同一个共享对象。
		const store = self.get(ChatStore, {});
		if (principal.kind !== "owner") {
			// A guest sees no output: the view drops it (computed once per variant in a real store, §12).
			// strip 只保留 guest 允许看到的字段；同样按输入对象缓存结果对象。
			const strip = mapShared(
				(s: Static<typeof Shell>): Static<typeof GuestShell> => ({ id: s.id, phase: s.phase, command: s.command }),
			);
			return {
				variant: "guest",
				// entries 共享；shells 在 store.shells 的派生上再做一次映射，去掉 output。
				members: { entries: store.entries, shells: self.derive([store.shells], ([list]) => strip(list)) },
			};
		}
		// owner 直接复用共享 store 的成员；方法转发时保留调用方传入的 ctx。
		return {
			variant: "owner",
			members: {
				entries: store.entries,
				shells: store.shells,
				runShell: (args, ctx) => store.runShell(args, ctx),
				abortShell: (args, ctx) => store.abortShell(args, ctx),
			},
		};
	});
});

// 2. A server and two tabs, the owner's and a guest's.
// server 宿主带地址与 server principal；onError 打印后台错误（包括作业报告）。
const server = createHost<P>({
	address: Server(),
	principal: { kind: "server" },
	onError: (error) => console.error(error),
});
await server.load([{ name: "@example/chat", facet }], context);
// tab 辅助函数：创建客户端宿主、load、建立内存链路，最后返回 Chat 引用。
// principal 由 server.accept 登记，决定工厂返回 owner 还是 guest 变体。
async function tab(principal: P) {
	const host = createHost<P>({ onError: (error) => console.error(error) });
	await host.load([], context);
	// 内存链路对：a 给 server 的入口，b 给客户端；两端方向相反。
	const [a, b] = memoryLinkPair();
	server.accept(a, { principal }, context);
	host.connect(b, { principal: { kind: "server" } }, context);
	return host.get(Chat, {}, context);
}
// 两个 tab 的 principal 不同，因此拿到不同变体。
const owner = await tab({ kind: "owner" });
const guest = await tab({ kind: "guest" });
// 运行时检查并窄化引用类型；若声明与工厂返回不一致，这里立即失败，而不是继续使用错误变体。
if (owner.variant !== "owner") throw new Error("expected the owner's variant");

// 3. The owner runs a command; its request id dedupes a resent request (the same run comes back).
// 启动一个 5 行的假命令，返回运行 id；requestId=r1 是去重键。
const id = await owner.runShell({ command: "npm test", lines: 5, requestId: "r1" }, context);
// 重发同一 requestId（同一 args）：返回同一未结算运行，而不是第二个作业。
const again = await owner.runShell({ command: "npm test", lines: 5, requestId: "r1" }, context);
// 两次返回的 id 相同，证明去重发生在 start 事务内。
console.log("a resent request returns the same run:", again === id);
// 等约 3 行输出（每 30ms 一行）；具体行数受调度影响。
await sleep(100, context);
// owner 变体含 output；此时运行尚未结算，phase 为 running。
console.log("owner sees:", owner.shells.value);
// guest 变体没有 output 字段；mapShared 已把它去掉。
console.log("guest sees:", guest.shells.value);

// 4. One run at a time: a second command is refused while the first runs.
// concurrency: 1 且第一个运行仍在 running，第二次 start 以 unavailable/busy 拒绝；消息带作业名与限额。
try {
	await owner.runShell({ command: "npm run build", lines: 1, requestId: "r2" }, context);
} catch (error) {
	// 运行期错误按 Error 读取 message；这里只做展示，不依赖具体错误类型。
	console.log("second run refused:", (error as Error).message);
}
// 5 行 * 30ms = 150ms，300ms 足够让 run 完成、finish 提交并链式运行 notify。
await sleep(300, context);
// entries 中先有 shell 摘要，再有 notify 的 finish 写入的结果。
console.log("entries after the first run:", owner.entries.value);

// 5. Abort is a request: the run stops at its next `sleep`, its last output is flushed, `finish` records it.
// 长任务 100 行；100ms 后只产出约 3 行，此时请求 abort。
const long = await owner.runShell({ command: "tail -f log", lines: 100, requestId: "r3" }, context);
await sleep(100, context);
// abortShell 立即返回；标记与信号传播在后台进行。
await owner.abortShell({ id: long }, context);
// 等待 abort 传播、run 在下一个 sleep 拒绝、finish 写入摘要与 notify。
await sleep(100, context);
// 中断摘要来自 failed/aborted，行数是 finally 最终刷新时保留的行数。
console.log("entries after the abort:", owner.entries.value);
// 所有运行已结算，running 列表为空。
console.log("running now:", owner.shells.value);
await server.close(context);
