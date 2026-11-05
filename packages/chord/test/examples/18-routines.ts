// Routines: an object's standing behaviour, declared in its factory. `self.on(source, fn)` reconciles from a value: the
// first call gets the current value (`[["r", value]]`), then one call per change, never overlapping; a call that
// throws is reported (`routine_failed`) and called again with the whole current value after a backoff (1 s doubling to
// 60 s), or at once when the source changes. `self.onLive(fn)` runs once the object is live: a loop with `sleep` is a
// periodic task; its ctx is aborted when the object ends, which `sleep` turns into a rejection, so nothing is left
// running.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/18-routines.ts
// 文件导读
// 所属包与示例系列：packages/chord/test/examples，Chord v2 示例 18，对应 slice 5（routines：self.on 与 self.onLive）。
// 演示什么：对象工厂里声明常驻行为。self.on 从某个 watchable 的当前值开始对账（首次调用是根替换 op），
//   之后每次变化调用一次且永不重叠；处理函数抛错会以 routine_failed 上报，并按 1s 翻倍到 60s 的退避重试，
//   重试携带完整当前值；源再次变化时立即调用。self.onLive 在对象 live 后启动一个循环，用 sleep 做周期任务，
//   对象结束时 ctx 被中止，sleep 以拒绝结束循环，不留下后台工作。
// 上游/下游：文件顶部命令启动；下游使用 src/host 的 createHost/defineFacet/sleep、src/documents 的 defineState、
//   src/contracts 的 local/map。示例不访问网络，所有“远端超时”是人为抛出的一次性错误。
// 能力清单（按演示的机制）：
// - self.on(source, fn)：声明对账 routine；source 是 watchable（这里是依赖引用的 state 成员）。
// - 首次根替换与增量 ops：第一次 ops 为 [["r", value]]，后续为 map 的 set op。
// - routine_failed：处理函数抛错时上报 { kind, position } 与原始 error；框架负责退避重试。
// - 幂等对账：每次从当前完整值出发，关闭已归档会话的 forward；重试不会重复已完成的步骤。
// - self.onLive(fn) + sleep(ms, ctx)：周期任务；ctx 中止时 sleep 拒绝，循环自然退出。
// - 关闭语义：host.close 中止 routine；周期循环在 sleep 处结束，不会额外上报失败。
// 典型运行顺序：load -> 首次 on 调用（s1、s2 都未归档，无事可做）-> onLive 每 400ms 记录一次 cleanup ->
//   archive s2 -> on 收到增量 -> 第一次关闭抛错（flaky）-> routine_failed 上报 -> 约 1s 后整值重试 -> 成功关闭 s2 ->
//   打印 open forwards 与 cleanups -> host.close 结束循环。
// 示例（符合真实签名）：
//   self.on(catalog.sessions, async ({ value: sessions, ops }, ctx) => {
//     // 从完整 sessions 与当前文档对账；抛错会触发退避重试
//   });
//   self.onLive(async (ctx) => {
//     for (;;) { await sleep(400, ctx); /* 周期工作 */ }
//   });
// 运行方式与环境：在 packages/chord 下执行文件顶部命令；无环境变量、无外部服务；约 1.5 秒完成。
// 预期输出：on: [["r",{"s1":{"archived":false},"s2":{"archived":false}}]]；archiving s2；
//   on: [["s",["s2","archived"],true]]；example.forwards on #1 failed: closing the forward of s2 timed out；
//   约 1.1s 后 on: [["r",{…"s2":{"archived":true}}]] 并 closed the forward of s2；
//   open forwards: [ 's1' ]；periodic cleanups so far: [ '0.4s', '0.8s', '1.2s' ]；closed; nothing left running。
// 对应测试与文档：packages/chord/test/host/routines.test.ts、sleep.test.ts、follow.test.ts；
//   slices.md 的 slice 5；设计文档中关于 routine 退避与对象结束的章节。
// 建议阅读顺序：先看 Catalog/ForwardStore 与两个 defineState，再看 at/onError 与 flaky，随后看两个 serve 工厂里的
//   self.on / self.onLive，最后按 4-5 步读归档、重试与关闭。
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { arr, bool, local, map, method, obj, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, sleep } from "../../src/host/index.ts";

// 后台上下文；archive、sleep 与关闭都显式传入。
const context = BACKGROUND_CONTEXT;

/** The catalog of sessions: another owner's state, which the forwards reconcile from. */
// Catalog 是另一个“所有者”的会话目录：sessions 是字符串键到 {archived} 的映射，archive 标记归档。
// map(...) 的 schema 表示任意字符串键、固定值形状的对象。
const Catalog = local("example.catalog", {
	version: 1,
	params: {},
	members: { sessions: map(obj({ archived: bool() })), archive: method(obj({ session: str() })) },
});

/** Port forwards per session; a forward of an archived session must be closed (an invariant across owners, §9). */
// ForwardStore 保存打开的 forwarding 会话与周期清理记录；两者都是字符串数组。
const ForwardStore = local("example.forwards", {
	version: 1,
	params: {},
	members: { open: arr(str()), cleanups: arr(str()) },
});

// Sessions 文档的初值：s1、s2 都未归档；每次对象激活各有一份。
const Sessions = defineState("example.sessions", {
	schema: obj({ sessions: map(obj({ archived: bool() })) }),
	version: 1,
	initial: () => ({ sessions: { s1: { archived: false }, s2: { archived: false } } }),
});

// Forwards 文档的初值：s1、s2 的 forward 都打开，cleanups 为空。
const Forwards = defineState("example.forward-list", {
	schema: obj({ open: arr(str()), cleanups: arr(str()) }),
	version: 1,
	initial: () => ({ open: ["s1", "s2"], cleanups: [] }),
});

// 记录示例起点；at() 返回保留一位小数的秒数，便于观察退避与周期。
const started = Date.now();
const at = () => `${Math.round((Date.now() - started) / 100) / 10}s`;

// 1. The host reports background failures: a routine call that threw arrives as `routine_failed`.
// onError 只处理 routine_failed；其他后台错误直接打印。error.routine 是 { kind, position }。
const host = createHost({
	onError: (error) => {
		if (error.kind === "routine_failed") {
			// 解构 kind（"on"）与 position（第几个声明的同类 routine）。
			const { kind, position } = error.routine;
			// error.error 类型是 unknown；断言为 Error 只为读取 message，运行时不校验。
			console.log(`  [${at()}] ${error.object} ${kind} #${position} failed: ${(error.error as Error).message}`);
		} else console.error(error);
	},
});

// flaky 是模块级一次性开关：第一次关闭抛错，之后成功，用来演示退避重试。
let flaky = true;
// facet 的 setup 登记两个本地类型；self.on/onLive 在工厂内声明。
const facet = defineFacet((h) => {
	h.serve(Catalog, (_, self) => {
		const doc = self.state(Sessions);
		return {
			// sessions 派生自文档；读取方看到映射的当前值。
			sessions: self.derive([doc], ([d]) => d.sessions),
			// archive 在事务中把指定会话标记为已归档；属性赋值会替换该键的值。
			archive: async ({ session }, ctx) => {
				await doc.change((d) => {
					d.sessions[session] = { archived: true };
				}, ctx);
				return null;
			},
		};
	});
	h.serve(ForwardStore, (_, self) => {
		const forwards = self.state(Forwards);
		// 依赖 Catalog，供 self.on 监听它的 sessions 状态。
		const catalog = self.get(Catalog, {});
		// 2. Reconcile: close every forward of an archived session. Idempotent, from the current value; the first close
		// fails once (a flaky remote), and the retry comes with the whole value.
		// self.on 声明对账 routine：源是依赖引用的 sessions 成员；处理函数接收 { value, ops } 与 ctx。
		// 解构时把 value 重命名为 sessions；ops 只用于日志。
		self.on(catalog.sessions, async ({ value: sessions, ops }, ctx) => {
			// 打印本次调用的 ops：首次是根替换 "r"，变化时是增量（例如 map 的 set "s"）。
			console.log(`  [${at()}] on: ${JSON.stringify(ops)}`);
			// 遍历当前打开的 forward（读取文档当前值，不是草稿）。
			for (const session of forwards.value.open) {
				// ?. 处理映射中不存在的键；!archived 则跳过。
				if (!sessions[session]?.archived) continue;
				// 一次性失败：第一次遇到归档会话时抛错，框架上报并退避重试。
				if (flaky) {
					flaky = false;
					throw new Error(`closing the forward of ${session} timed out`);
				}
				// 从打开的列表中过滤掉该会话；filter 返回新数组，documents 需要替换整个数组。
				await forwards.change((d) => {
					d.open = d.open.filter((open) => open !== session);
				}, ctx);
				// 成功关闭后打印；重试时会再次从完整值出发，已关闭的会话不在 open 中，因此幂等。
				console.log(`  [${at()}] closed the forward of ${session}`);
			}
		});
		// 3. A periodic task: a loop with `sleep`, ended by the object's end (the abort rejects `sleep`).
		// onLive 在对象 live 后启动；ctx 随对象结束而中止。
		self.onLive(async (ctx) => {
			// for (;;) 是无限循环；退出依赖 sleep 在 ctx 中止时抛出的拒绝。
			for (;;) {
				// sleep 等待 400ms；ctx 已中止时立即拒绝，循环随之结束。
				await sleep(400, ctx);
				// 记录一次清理时间；`void` 丢弃 push 的返回值。
				await forwards.change((d) => void d.cleanups.push(at()), ctx);
			}
		});
		return {
			// 两个只读派生状态分别暴露 open 与 cleanups。
			open: self.derive([forwards], ([d]) => d.open),
			cleanups: self.derive([forwards], ([d]) => d.cleanups),
		};
	});
});
await host.load([{ name: "@example/forwards", facet }], context);
// 获取两个本地引用；ForwardStore 的工厂在此激活并声明 routines。
const store = await host.get(ForwardStore, {}, context);
const catalog = await host.get(Catalog, {}, context);
// 先等 50ms，让首次 on 调用与第一个周期步骤有机会执行。
await sleep(50, context);

// 4. Archive s2: the routine's call throws once, is retried after 1 s with the whole value, and closes the forward.
// 归档 s2，触发 Catalog.sessions 变化，从而调用 ForwardStore 的 on 处理函数。
console.log("archiving s2");
await catalog.archive({ session: "s2" }, context);
// 等待超过 1.3s，覆盖一次失败 + 1s 退避重试 + 周期心跳。
await sleep(1_300, context);
// s2 的 forward 已关闭；周期记录约为 0.4/0.8/1.2s。
console.log("open forwards:", store.open.value);
console.log("periodic cleanups so far:", store.cleanups.value);

// 5. Closing the host aborts the routines: the periodic loop ends in its `sleep`, nothing is reported.
// 关闭宿主会中止 routine ctx；sleep 拒绝使循环退出，不会产生 routine_failed。
await host.close(context);
console.log("closed; nothing left running");
