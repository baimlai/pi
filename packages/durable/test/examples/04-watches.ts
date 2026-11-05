// 文件导读
// 所属：packages/durable 的 test/examples 系列第 04 个示例，演示文档 watch 的串行投递与变更合并。
// 演示内容：先建会话并写入 Notes 初值，再 watchDoc 获取句柄；监听器第一次调用故意阻塞（模拟慢消费者），
//   期间连续提交三次；三次变更被折叠进第二次调用，最后打印监听器调用次数并 stop。
// 上游入口：从 packages/durable 目录直接运行；下游调用 Session.watchDoc、DocumentWatch.start/stop、
//   Tx.doc。没有模型/网络；结果只打印到 stdout。
// 能力清单（按演示机制）：
// - Session.watchDoc(token, conversationId, context)：返回 WatchHandle<Readonly<T>>；文档不存在时返回 undefined。
// - handle.value：start 之前是获取时的值；开始投递后是最新已投递值（failed 帧不改变它）。
// - handle.start(async (call, context) => ...)：安装唯一监听器；首次投递异步发生，回调之间绝不重叠。
// - WatchCall：{kind:"value", value, ops, retired} 与 {kind:"failed", error} 组成的判别联合。
// - handle.stop()：幂等停止后续回调，返回最终的 WatchEnd；示例忽略返回值。
// - 合并规则：监听器忙时到达的提交不单独投递；下一次调用给出最新值，以及把上一值变成该值所需的 ops；
//   积压超过 10,000 个 op 时改用整值替换 [["r", value]]。
// 典型运行顺序：建会话+初值 → watchDoc → 打印 baseline → start → 四次提交 → 解除阻塞 → 打印 calls → stop → close。
// 示例（真实运行命令）：
//   cd packages/durable
//   node --conditions=source --experimental-strip-types test/examples/04-watches.ts
// 实际输出：
//   watch baseline: { text: 'first' }
//   watch update: { text: 'observed' } [["s",["text"],"observed"]]
//   watch update: { text: 'observed asynchronously, folded!' } [["a",["text"]," asynchronously, folded!"]]
//   listener calls: 2
// 阅读顺序：先看 watchDoc 的返回值和 undefined 分支，再看监听器里对 call.kind 的收窄，最后看 busy/done
//   两个 Promise 如何制造“忙时合并”的时序。
// Serialize asynchronous document work with a watch.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/04-watches.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
// createSession/defineDoc/MemoryStorage 来自包根；watchDoc 是 Session 实例方法，不是单独导出。
import { createSession, defineDoc, MemoryStorage } from "../../src/index.ts";

// 共享上下文；watch 的 context 用于取消，BACKGROUND_CONTEXT 永不取消。
const context = BACKGROUND_CONTEXT;
// 内存存储，进程结束即丢弃。
const session = createSession(new MemoryStorage());

// 与 01/02 相同的 Notes 文档定义；本示例不关心 fork，只关心它每次提交都会产生 ops。
const Notes = defineDoc<{ text: string }>({
	checkpointWhen: () => false,
	kind: "example.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ text: "" }),
});
// 建会话与写初值放在同一提交：提交完成后 watchDoc 才能看到文档存在。
// 回调返回 conversation，因此外层 chat 是 ConversationRecord。
const chat = await session.commit(async (tx) => {
	const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
	(await tx.doc(Notes, conversation.id)).text = "first";
	return conversation;
}, context);

// A watch starts from one stable acquisition revision. Callbacks never overlap:
// commits made while one runs arrive folded into the next call, which gets the
// newest value and ops that turn the previously delivered value into it (one
// full-value replacement `[["r", value]]` once more than 10,000 ops pile up).
// watchDoc 的第三个参数是 context；它只在挂接阶段用于取消，之后监听器收到的 context 是投递上下文。
// 返回 undefined 表示该会话还没有这份文档；watch 不会顺便创建文档。
const notesWatch = await session.watchDoc(Notes, chat.id, context);
// 显式排除 undefined 后，TypeScript 把 notesWatch 收窄为 WatchHandle<Readonly<{text: string}>>。
if (notesWatch === undefined) throw new Error("notes are absent");
// value 是获取 watch 那一刻的稳定值，也就是提交里的 "first"。
console.log("watch baseline:", notesWatch.value);
// Promise.withResolvers<T>() 返回 { promise, resolve, reject }；泛型 T 是 promise 的解决值类型。
// 这里不用值，只用“挂起/放行”信号：busy 阻塞第一次回调，done 通知第二次回调已到达。
const busy = Promise.withResolvers<void>();
const done = Promise.withResolvers<void>();
// 计数器在回调外声明；回调每次被投递时递增，最后用来证明只发生了两次调用。
let calls = 0;
// 监听器是一个 async 函数：输入是 call（值帧或失败帧）和该帧的投递 context，返回 Promise<void>。
// start 只安装监听器，不会同步调用它；watch 保证上一回调完成后才投递下一帧。
notesWatch.start(async (call, _deliveryContext) => {
	// Calls are tagged: a `failed` call is a failure a source recovers from, which Durable never sends (its failures
	// end the watch, see `closed`).
	// call 是判别联合；先比较 kind 再访问 value/ops，TypeScript 才能在分支内收窄到 value 帧。
	// Durable 的可恢复失败不会以 failed 帧出现，所以这里直接忽略非 value 帧。
	if (call.kind !== "value") return;
	// 解构出最新值与增量操作；ops 的类型是 readonly Op[]，示例只打印不应用。
	const { value, ops } = call;
	// JSON.stringify 把 ops 渲染成可读文本；数组/字符串等 JSON 值可直接序列化。
	console.log("watch update:", value, JSON.stringify(ops));
	// The first call stays busy, as a slow consumer would, while three more commits land.
	// 前缀 ++calls 先自增再比较；第一次调用进入分支并 await，回调因此保持“忙”状态。
	// 后续提交不会打断它，而是排队并折叠，等这个 promise 解决后合并成下一帧。
	if (++calls === 1) await busy.promise;
	// 第二次调用（或更晚的调用）会解决 done，告诉主流程可以继续。
	else done.resolve();
});
// 第一次提交产生 "observed"；如果监听器尚未开始，watch 会把它作为首帧投递。
await session.commit(async (tx) => {
	(await tx.doc(Notes, chat.id)).text = "observed";
}, context);
// for...of 依次等待三次提交；它们都发生在第一次回调阻塞期间，因此会被折叠。
// 字符串 += 逐段追加：结果是 "observed asynchronously, folded!"。
for (const more of [" asynchronously", ", folded", "!"]) {
	await session.commit(async (tx) => {
		(await tx.doc(Notes, chat.id)).text += more;
	}, context);
}
// 放行第一次回调；watch 随即把积压的三次变更合并成第二帧投递。
busy.resolve();
// 等待第二次回调明确执行到 done.resolve()；仅靠 busy.resolve() 不能保证它已运行。
await done.promise;
// 输出 2：首帧（含第一次提交）与折叠帧各一次，而不是四次提交四次调用。
console.log("listener calls:", calls);
// stop 幂等：停止后续回调并返回 WatchEnd；示例不检查是 stopped 还是其他终止原因。
await notesWatch.stop();

// 先显式停止 watch，再关闭 Session；即使不 stop，close 也会以 ended 结束 watch，但显式收尾更清楚。
await session.close(context);
