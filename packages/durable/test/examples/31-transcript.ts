// 文件导读
// 所属：packages/durable/test/examples 的 31-transcript.ts，Durable 示例系列第 31 个，演示“客户端会话记录拼接”。
// 演示内容：在已有 200 条记录后挂载 min=10、max=20 的 watch 窗口，用 ConversationTranscript 合并每个窗口值，
// 保留窗口裁掉的旧条目，并在顶部显示“加载更早”；实时追加 15 条后上翻一页；停掉 watch 期间写 40 条再重连，
// 让记录出现空洞，再按页填洞；最后演示只错过 3 条时 resume 直接衔接、不产生空洞。
// 上游入口：node 直接运行本文件；MemoryStorage 与空模型目录/注册表，不创建 agent，也不访问网络。
// 下游依赖：Durable 的 Harness/Conversation.watch/Conversation.entries/ConversationTranscript，
// 以及 Chord 的 BACKGROUND_CONTEXT 和 watch 句柄（value、start、stop）。
// 能力清单：chat(n) 逐条提交；settle 让出一轮事件循环；render 把 items 压成区间并标注 gap/earlier；
// firstGap 类型谓词；attach 基线；实时合并；loadEarlier；断线 resume 与 gap；fillGap 循环；短掉线无洞重连。
// 典型顺序：写 200 条 -> 建 transcript -> 取窗口首帧并 merge -> 启动监听 -> 追加 15 条并查看 -> 上翻一页 ->
// 停 watch、写 40 条、带 resume 重连 -> 看到 gap 并逐页填 -> 再停、写 3 条、带 resume 重连 -> 关闭。
// 前置条件：无需 API key；示例里的条目 ID 恰好连续，但拼接器不假设连续，只比较排他边界。
// 预期输出：attach 为 [load earlier] 191..200；实时后 191..215；上翻后 171..215；重连后
// [load earlier] 171..215 [load more] 246..255；两次填洞后 171..255；短掉线窗口 3 条，最终 171..258。
// 阅读顺序：先看 render 如何把 items 转成一行，再看 attach/实时/上翻，最后看 resume 的 gap 与 fillGap 循环。
// A client's transcript over the windowed conversation view: `ConversationTranscript` merges every value of a watch
// into the client's whole transcript, marks entries a stall skipped as a gap, and loads them, and earlier pages, on
// demand. A client that drops resumes after the newest entry it has.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/31-transcript.ts
// BACKGROUND_CONTEXT 是不带取消信号的后台根上下文；本示例所有调用都用它，没有超时或外部取消源。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	// ConversationTranscript 与两个视图类型都从包入口导出；type 修饰符只引入类型，编译擦除后不产生运行时导入。
	ConversationTranscript,
	createRegistry,
	Harness,
	MemoryStorage,
	type TranscriptItem,
	type TranscriptView,
} from "../../src/index.ts";

// 顶层步骤按 await 顺序执行，失败直接传播；下面所有调用都共享同一个 context。
const context = BACKGROUND_CONTEXT;
// Harness.open 接收存储、模型目录与扩展注册表，返回同时充当 Session 的 Harness；本例不启动调度器执行 agent。
const harness = await Harness.open(
	// MemoryStorage 把会话、条目、任务与文档都放在进程内存里；进程结束即丢弃，适合自包含示例。
	new MemoryStorage(),
	// 空模型目录与空注册表足够：本例只提交原始 chat 条目，不创建 agent，也不运行生成任务。
	{ models: createModels(), registry: createRegistry() },
	context,
);
// root() 返回保留的根会话；没有 agent 配置时也能创建，仅作为提交与观察的目标。
const root = await harness.root(context);
// 行号计数器：data 写入 "line N"，render 再从 data 反解 N 做区间压缩。
let count = 0;
// 提交 n 条 chat 记录，每条一次独立 commit；输入 n，输出 Promise<void>。
// 副作用：逐条写存储；每次成功提交都会让 watch 收到一帧，失败时异常直接向外传播。
// 例：chat(3) 依次追加 line 1、line 2、line 3；它不是批量提交，因此观察者可能看到中间帧。
/** Commit `n` chat lines, one entry each. */
const chat = async (n: number): Promise<void> => {
	// 逐条提交而不是一个事务：示例要模拟真实流式写入，让窗口和监听器在每个条目后推进。
	for (let index = 0; index < n; index++) {
		// tx.appendEntry 在 root 会话追加一条 kind 为 "chat" 的记录；++count 是前缀自增，先加一再格式化。
		// commit 成功返回后条目才对观察者可见；回调里只做一次写操作。
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "chat", data: `line ${++count}` }), context);
	}
};
// setTimeout(0) 让出一轮宏任务，给 watch 的异步投递排到队尾的机会；它只是示例用的粗略等待，不是严格屏障。
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// 把一帧 TranscriptView 压成一行：连续的 entry 显示为区间，gap 显示 [load more]，earlier 显示 [load earlier]。
// 输入：标签与视图；输出：无（直接打印）；副作用：只读 view.items，不修改 transcript 或视图。
// 例：items 为 earlier 与 191..200 的条目时输出 "attach    [load earlier] 191..200"。
/** One line per item: ranges of entries, gaps, and the "load earlier" marker. */
function render(label: string, view: TranscriptView): void {
	// 收集本行要打印的片段；最后用空格连接成一个字符串。
	const rows: string[] = [];
	// 元组表示当前连续条目区间的 [首行号, 末行号]；undefined 表示上一项不是 entry，或还没有开始区间。
	let run: [number, number] | undefined;
	// 结束当前连续区间：单条打印一个数字，多条打印首..尾；调用后清空 run，避免重复输出。
	const flush = () => {
		// run[0] === run[1] 时输出单值，否则输出闭区间；模板字符串在这里只做格式化。
		if (run !== undefined) rows.push(run[0] === run[1] ? `${run[0]}` : `${run[0]}..${run[1]}`);
		run = undefined;
	};
	// items 已按条目 ID 升序，且 entry/gap/earlier 交错；顺序由 ConversationTranscript 维护。
	for (const item of view.items) {
		// 判别字段 kind 在这里把 item 收窄为 entry 行，后续可直接访问 item.entry。
		if (item.kind === "entry") {
			// 示例约定 data 是字符串 "line N"：String 是运行时转换（data 静态类型是 JsonValue），slice 去掉前缀，
			// Number 解析行号。这只是演示用的反解，真实客户端应直接渲染 data，不依赖其内部格式。
			const line = Number(String(item.entry.data).slice("line ".length));
			// run 为 undefined 时开启新区间，否则把末行号推到当前行；连续性由提交顺序保证。
			run = run === undefined ? [line, line] : [run[0], line];
			// entry 行只累积区间，不立即输出；跳过本轮的 flush 与行片段追加。
			continue;
		}
		// 遇到 gap 或 earlier 前先结束当前区间，保证输出顺序与 items 顺序一致。
		flush();
		// gap 表示 after 与 upTo 之间缺条目，earlier 表示上方还有更早记录；这里只打印占位文本，
		// 真实 UI 会提供点击加载。
		rows.push(item.kind === "gap" ? "[load more]" : "[load earlier]");
	}
	// 循环结束再冲刷一次，输出最后一段连续区间；没有进行中的区间时 flush 不打印任何内容。
	flush();
	// padEnd(28) 让标签列对齐，rows 用空格连接；这是示例的输出格式，不代表视图结构。
	console.log(`${label.padEnd(28)} ${rows.join(" ")}`);
}

// 返回 items 中第一个 gap 行，没有则 undefined；填洞循环每轮都重新调用它。
// 类型谓词让 find 的结果在编译期收窄为 Gap，下面可直接把 gap 传给 fillGap；
// Extract 从 TranscriptItem 联合中挑出 kind 为 "gap" 的成员，运行时仍只执行 item.kind === "gap" 比较。
const firstGap = (view: TranscriptView) =>
	view.items.find((item): item is Extract<TranscriptItem, { kind: "gap" }> => item.kind === "gap");

// 先写 200 条（line 1..200），再挂载窗口：这样首帧只包含最新 10 条，上方一定还有更早记录。
await chat(200);

// Attach: the window holds the newest `min` entries; the transcript shows "load earlier" above them.
// loader 闭包绑定 root 会话，并把 cursor 固定为 undefined；ConversationTranscript 用 maxEntryId/minEntryId 表达
// 排他边界，不依赖续页游标。第二个参数是分页选项。
const transcript = new ConversationTranscript((query, limit, ctx) => root.entries(query, limit, undefined, ctx), {
	// 每次 loadEarlier/fillGap 取 20 条；这与窗口 min=10/max=20 无关：一个是客户端补页大小，一个是观察窗口容量。
	pageSize: 20,
});
// 窗口参数：首帧取最新 min=10 条；随后追加，一旦超过 max=20 就一次裁回 10 条并推进 before。
// 没有给 from，所以首帧从最新记录开始。
const window = { min: 10, max: 20 };
// root.watch 返回句柄：value 是挂载时的首帧，start 之前不会投递后续帧；context 的取消信号在挂载后登记，
// 会终止 watch。
let watch = await root.watch(context, window);
// 第一次 merge 把首帧并入记录：items 顶部先放 earlier（因为 before 指向 line 190），随后是 191..200。
let view = transcript.merge(watch.value);
// 预期输出：attach 行显示 [load earlier] 191..200。
render("attach", view);
// start 注册串行监听器：每帧一个 call，监听器返回的 Promise 完成后才投递下一帧。
// 这里只在内存里合并视图而不逐帧打印，否则 15 次追加会刷出十几行；打印留给下面的检查点。
watch.start(async (call) => {
	// call 是 value/failed 判别联合；本例忽略 failed 帧，真实客户端应处理它（例如提示连接失败）。
	if (call.kind !== "value") return;
	// 从 value 帧取出窗口视图；failed 分支已在上一行返回，因此这里访问 value 是类型安全的。
	const { value } = call;
	// 每帧都 merge：窗口丢弃旧条目时 before 前进，merge 仍保留已持有的旧记录；新增条目按 ID 归并。
	view = transcript.merge(value);
});

// Live: appends. The window drops its oldest past `max`; the transcript keeps them.
// 实时追加 15 条（201..215）；窗口从 10 条涨到 20 条后裁回 10 条，transcript 保留被裁掉的 191..200。
await chat(15);
// 等待监听器消费完这批帧；settle 只保证让出一轮事件循环，不保证很慢的源一定已完成。
await settle();
// 预期输出：15 more, live 行显示 [load earlier] 191..215。
render("15 more, live", view);

// The user scrolls up: one page.
// 向更早翻一页（20 条），返回新视图；若已到记录起点，items 顶部的 earlier 会消失，否则保留。
view = await transcript.loadEarlier(context);
// 预期输出：load earlier 行显示 [load earlier] 171..215；上方仍有 line 1..170，所以 earlier 还在。
render("load earlier", view);

// A drop: the client misses 40 entries, more than `max`, and resumes after the newest it has. The window starts at the
// newest `min` again, and `before` shows the transcript a gap.
// 停止 watch，模拟客户端掉线；stop 返回 WatchEnd，示例不检查它的 kind。停止后不再收到帧，但 transcript 状态保留。
await watch.stop();
// 掉线期间写入 40 条（216..255），没有观察者看到；这超过窗口 max=20，因此重连无法一次覆盖全部遗漏。
await chat(40);
// 展开顺序很重要：window 提供 min/max，transcript.resume 提供 from=newest+1（216）。
// loadWindow 只有在 from 起不超过 max 条时才从 from 开始；这里遗漏 40 条，超过 20，于是退回最新 10 条
// 246..255，before=245，正好让客户端知道 216..245 缺失。
watch = await root.watch(context, { ...window, ...transcript.resume });
// merge 发现 before=245 大于已知上界 215，于是在两者之间建一个 gap；gap 的 after/upTo 是排他边界。
view = transcript.merge(watch.value);
// 预期输出：resume after 40 missed 行显示 [load earlier] 171..215 [load more] 246..255。
render("resume after 40 missed", view);
// 重新注册监听器，处理重连后的后续帧；首帧已由上面的 merge 手动并入，所以这里不会再补一次。
watch.start(async (call) => {
	// 与第一次相同：只处理 value 帧，failed 帧被忽略。
	if (call.kind !== "value") return;
	// 取出重连窗口的视图。
	const { value } = call;
	// 后续每帧继续归并；此时记录里可能仍有 gap，merge 只追加/去重，不会自动填洞。
	view = transcript.merge(value);
});

// "load more" fills the gap a page at a time.
// 每轮重新取第一个 gap：fillGap 后旧 gap 对象可能已被更小的 gap 取代，继续用旧对象会填错区间；
// firstGap(view) 每次从最新视图读取，循环在无 gap 时结束。
for (let gap = firstGap(view); gap !== undefined; gap = firstGap(view)) {
	// 从洞的起点向后取一页（20 条），返回新视图；fillGap 只缩小或移除该洞，不会同时处理其他洞。
	view = await transcript.fillGap(gap, context);
	// 预期两轮：先 [load earlier] 171..235 [load more] 246..255，再 [load earlier] 171..255。
	render("fill gap", view);
}

// A short drop resumes without a gap: the window starts right after the newest entry.
// 再次停止 watch，准备一次较短的掉线。
await watch.stop();
// 只错过 3 条（256..258），少于窗口 max=20。
await chat(3);
// resume 仍给出 from=256；从 256 起只有 3 条，未超过 max，因此首帧就是 256..258，before=255，
// 与已知上界衔接。
watch = await root.watch(context, { ...window, ...transcript.resume });
// 直接读取首帧窗口长度验证为 3；watch.value 在 start 之前就可用，示例用 padEnd 对齐标签。
console.log(`${"resume after 3 missed".padEnd(28)} window: ${watch.value.entries.length} entries`);
// 合并这 3 条；before=255 正好等于已知上界，因此不产生 gap。
view = transcript.merge(watch.value);
// 空标签仍然 padEnd；预期输出 [load earlier] 171..258（171..255 加 256..258 连续）。
render("", view);

// 停止最后一个 watch；此后不会再收到帧。
await watch.stop();
// 关闭 Harness 管理的会话、任务与视图挂载；MemoryStorage 随进程结束丢弃，无需额外清理。
await harness.close(context);
