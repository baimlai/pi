// 文件导读
// 所属：packages/chord/test/examples/60-session-sync，Chord 示例 60（会话同步）的端到端演示入口。
// 作用：用真实 Chord store 组件 + 两个替身（radius.ts 模拟服务器，sync.ts 模拟笔记本同步层）演示已定的同步协议：
//   1. 在内存 store（outbox 开启）上写一个会话 s1：rename + 两条消息；
//   2. 第一次 sync：握手发现 Radius 没有 s1，整段 outbox 1..4 上传并裁剪；
//   3. 再写两条消息，第二次 sync 只传尾部 5..6；两边 describe 结果相同；
//   4. s2 先在未开 outbox 的 store 上写（文件库），再开启 outbox 并 sync：因 outbox 从 lastSeq 3 才开始，
//      必须先上传整库归档（737 字节）；之后的写入从 seq 4 继续按批次同步；
//   5. “在 Radius 上继续”：Radius 接管（epoch 2）并写入 seq 7；一个错过接管的旧副本用旧 epoch 上传，
//      被 epoch 围栏拒绝并 split 成新会话 s1~split@6（不回滚，整库归档上传为新会话）；
//   5b. 关闭 epoch 围栏的同一场景：上传因“序号不连续”被拒（未覆盖 Radius 的 seq 7），但随后的握手指向
//      两边相同的 lastSeq，sync 据此裁剪并丢弃本地提交，造成静默分叉（两边都是 lastSeq 7，内容不同）；
//   6. 交回笔记本（epoch 3）：先 pull Radius 的 7..7，两边一致；再写一条并上传 8..8，两边仍一致。
// 上游：radius.ts（Radius 替身）、session.ts（会话定义与 withSession/describe）、sync.ts（sync/push/pull）；
//   以下 Chord 真实 API：openStore/sqliteBackend/openNodeSqliteDatabase、importStore/decodeJsonl、store.export。
// 下游：内存/文件 SQLite、临时目录、控制台输出；不启动网络服务。
// 能力清单：shown、copyOf、atRadius 三个辅助函数；六个编号步骤；顶层 try/finally。
// 前置条件：Node 能运行 TypeScript（无需沙箱/网络）；运行时在系统临时目录建一个子目录。
// 运行方式（在 packages/chord 下）：
//   node --conditions=source --experimental-strip-types test/examples/60-session-sync/main.ts
// 预期输出：编号 1-6 的日志，包括 lastSeq、log 范围、epoch/driver、归档字节数、两次 "same values: true"。
// 副作用：创建并删除临时目录（s2 的 SQLite 文件）；所有 store/副本使用内存 SQLite；无外部请求。
// 阅读顺序：先看 shown/copyOf/atRadius，再按步骤 1→6 读；每步注释给出该步的 lastSeq/归档/拒绝原因。
// 校验边界：上传批次与 pull 的 JSON 在替身中 parse；提交形状、序号连续性、写入合法性由 applyBatch 校验，
//   失败整批回滚。lastSeq/epoch 等协议字段由示例代码直接使用，没有额外运行时 schema 校验。
// 说明：`!` 非空断言、`as` 断言都是编译期写法；失败时异常传播，finally 仍会关闭 Radius 并删除临时目录，
//   但已经打开的笔记本 store 可能未关闭（进程结束会回收）。

// Session sync as decided (decisions S3, S5, S7, W9, "The outbox is optional, internal and versioned", "p3 meeting,
// 2026-11-02"), played with Chord's real pieces: a laptop store with an outbox, `store.outbox.read`/`trim`,
// `store.export` with `encodeJsonl`, `importStore`, and batch apply, `applyBatch` (internal: exported from
// `chord` marked internal, imported here from `src/store/apply-batch.ts`; it takes the `ChordStore` behind
// `openStore`'s `Store`). Radius and the laptop's sync client are stand-ins written for this example (`radius.ts`,
// `sync.ts`), not Chord APIs: the sync layer is not built yet (slices.md, "The sync layer").
// Steps: 1. a session on the laptop; 2. the handshake and a first upload; 3. a second sync moves only the tail;
// 4. a bootstrap from an archive for a session whose outbox was turned on late; 5. "continue on Radius" and the epoch
// fence (the split), then the same without the fence (silent divergence); 6. back to the laptop with a pull.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/60-session-sync/main.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Readable.from([bytes])：把整块字节包成 importStore 需要的异步可读流。
import { Readable } from "node:stream";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
// openStore：打开 store（options.outbox 开启提交积压）；sqliteBackend：把 SQLite 句柄包装成 store 后端；
// importStore/decodeJsonl：从 JSONL 归档导入整库；Store 仅类型。
import { decodeJsonl, importStore, openStore, type Store, sqliteBackend } from "../../../src/store/index.ts";
import { RadiusStandIn } from "./radius.ts";
import { describe, withSession } from "./session.ts";
import { archiveOf, type LocalSession, pull, push, type Synced, sync } from "./sync.ts";

// 一个进程内的 Radius 替身，保存所有副本与日志；示例结束时 finally 中关闭。
const radius = new RadiusStandIn();
// 唯一的临时目录：只放 s2 的文件库；结束时递归删除。
const directory = await mkdtemp(join(tmpdir(), "chord-sync-"));

/** One sync's result as a line. */
// 函数说明：把 Synced 联合转成一行日志。输入 result；输出字符串；无副作用。
// 用 switch 的穷尽性：六种 kind 都有分支，TypeScript 因此知道函数总有返回值。
function shown(result: Synced): string {
	switch (result.kind) {
		case "uploaded":
			return `uploaded ${result.from}..${result.to}, Radius at ${result.lastSeq}, trimmed through it`;
		case "nothing":
			return `nothing to send, Radius at ${result.lastSeq}`;
		case "bootstrapped":
			return `archive uploaded (${result.bytes} bytes), Radius imported it at ${result.lastSeq}`;
		case "behind":
			return `Radius is ahead at ${result.lastSeq}`;
		case "split":
			return `refused for an old epoch: this copy is now ${result.session.id}`;
		case "refused":
			return `refused: ${result.message}`;
	}
}

/** A new in-memory store (outbox on) imported from archive bytes. */
// 函数说明：从归档字节复制出一个新的内存 store（outbox 开启），模拟“另一台笔记本/旧副本”。
// 输入 bytes；输出 Store。副作用：新建内存 SQLite 与 store。
// 说明：importStore 导入后 lastSeq 等于归档头；outbox 从该位置开始（floor = 导入的 lastSeq），
//   之后的本地写入才会进入 outbox。调用方负责 close。
async function copyOf(bytes: Uint8Array): Promise<Store> {
	const backend = sqliteBackend(await openNodeSqliteDatabase(":memory:"));
	// decodeJsonl 把字节流解码成归档部件；outbox:true 与笔记本原始 store 的配置一致。
	return importStore(backend, decodeJsonl(Readable.from([bytes])), context, { outbox: true });
}

/** Radius's view of a session as a line. */
// 函数说明：读 Radius 的握手并拼出一行状态。输入会话 id；输出字符串。
// `!` 非空断言：调用点都保证该 id 已存在（示例内部约定），否则会在 undefined 上取字段。
function atRadius(id: string): string {
	const known = radius.handshake()[id]!;
	// logRange 显示日志覆盖的 seq 范围；epoch 后的括号是当前 driver。
	return `Radius ${id}: lastSeq ${known.lastSeq}, log ${radius.logRange(id)}, epoch ${known.epoch} (${known.driver})`;
}

try {
	// 1. The laptop: SQLite in memory with the outbox on from its first commit; one session, a few commits.
	// 打开笔记本 store：内存 SQLite，outbox:true 表示从第一个提交起就记录提交（floor 0）。
	// outbox 是 store 的可选部分：开启后 store.outbox 存在，提供 floor/read/trim。
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context, { outbox: true });
	// 本地会话记录：id s1；epoch 1（无接管）；acked 0（尚未被服务器确认）。
	const s1: LocalSession = { id: "s1", store, epoch: 1, acked: 0 };
	// 短暂打开 host 写入三项：rename、两条 say。withSession 结束时关闭 host，释放 store claim。
	// 首次在空 store 上激活 host 会先写一次 messages 表定义（seq 1）；rename 首次修改 title 会创建持久文档（seq 2）；
	// 两条 say 各提交一次（seq 3、4）。所以下面打印 lastSeq 4、outbox floor 0。
	await withSession(store, async (session) => {
		await session.rename("Fix the parser", context);
		await session.say({ role: "user", text: "the parser drops comments" }, context);
		await session.say({ role: "assistant", text: "found it in lexer.ts" }, context);
	});
	console.log("1. laptop s1: lastSeq", store.lastSeq, "outbox floor", store.outbox!.floor);

	// 2. The handshake: Radius has no s1 (lastSeq 0), so the whole outbox goes, 1..lastSeq; then trimmed.
	// sync 流程：握手空 → known undefined 且 floor 0（不是情况 A/B）→ 不 bootstrap；acked=0；trim(0)；
	// push 读取 outbox floor 0 之后的 4 条提交，组批 from 1 to 4 epoch 1；Radius 因 from===1 新建副本并应用；
	// 成功后本地 acked=4、epoch 1，outbox 裁到 4。日志因此是 "uploaded 1..4" 且 floor 4。
	console.log("2. sync:", shown(await sync(s1, radius)));
	// Radius 的日志保存了 1..4（副本 outbox 搬入 log 后裁剪）；driver 仍为 laptop，epoch 1。
	console.log("  ", atRadius("s1"), "- laptop outbox floor", store.outbox!.floor);

	// 3. Two more commits; the next sync sends only them.
	// 再次打开 host 写两条消息：表定义已就绪，激活本身不再提交；两条 say 产生 seq 5、6。
	await withSession(store, async (session) => {
		await session.say({ role: "user", text: "and strings too" }, context);
		await session.say({ role: "assistant", text: "fixed both" }, context);
	});
	// 第二次 sync：握手返回 lastSeq 4；4 不小于 floor 4，也不大于本地 lastSeq 6；acked=4；trim(4)；
	// push 只读到 5、6，上传后 Radius 到 6，本地 outbox 裁到 6。
	console.log("3. laptop s1: lastSeq", store.lastSeq, "- sync:", shown(await sync(s1, radius)));
	console.log("  ", atRadius("s1"));
	// 两边各用 describe 打开一台临时 host 读取（title 状态 + 全部消息）。表已就绪、文档已存在，
	// 这些读取不会再产生提交；两个字符串相同，说明已同步的数据一致。
	console.log("   laptop:", await describe(store));
	console.log("   Radius:", await describe(radius.replica("s1")));

	// 4. Session s2 ran without an outbox (a file here, since it is reopened), then sync was turned on: the outbox starts
	// after its lastSeq, so Radius, which has nothing, needs an archive first; batches go on from there.
	// 用文件库模拟“先离线用过、后来才启用同步”的会话；文件路径在临时目录中。
	const path = join(directory, "s2.sqlite");
	// 第一次打开：不传 outbox（默认关闭）。此时 store 不保留提交积压。
	const before = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
	// 写入：表定义（seq 1）、rename 创建 title（seq 2）、say（seq 3）；关闭后 lastSeq 为 3。
	await withSession(before, async (session) => {
		await session.rename("Release notes", context);
		await session.say({ role: "user", text: "draft the notes for 1.4" }, context);
	});
	await before.close(context);
	// 重新打开同一文件库并开启 outbox。关键：outbox 从“当前 lastSeq”开始记录（floor=3），
	// 已存在的 1..3 不会补进 outbox，因此无法用批次从 1 补齐。
	const store2 = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context, { outbox: true });
	// 新的本地会话记录：id s2；epoch 1；acked 0（服务器尚不认识它）。
	const s2: LocalSession = { id: "s2", store: store2, epoch: 1, acked: 0 };
	console.log(
		"4. laptop s2: lastSeq",
		store2.lastSeq,
		"outbox floor",
		store2.outbox!.floor,
		"- sync:",
		shown(await sync(s2, radius)),
	);
	// sync 判断：known undefined 且 floor 3 > 0 → bootstrap；archiveOf 导出整库为 737 字节 JSONL；
	// radius.bootstrap 用 importStore 导入新副本（lastSeq 3，outbox floor 3，logFloor 3，epoch 1）；
	// 本地 acked=3，outbox 裁到 3。之后新写入从 seq 4 开始，按普通批次上传。
	await withSession(store2, async (session) => {
		await session.say({ role: "assistant", text: "here is a draft" }, context);
	});
	// 第二次 sync：握手 lastSeq 3；floor 3；本地 lastSeq 4（不落后）；acked=3；trim(3)；
	// push 只读到 4，上传后 Radius 到 4，日志 4..4（日志只保存 bootstrap 之后的提交）。
	console.log("   laptop s2: lastSeq", store2.lastSeq, "- sync:", shown(await sync(s2, radius)));
	console.log("  ", atRadius("s2"));
	// 消息行的 n 由 say 的 count+1 计算，与提交 seq 无关：导入的历史行是 n=1，新行是 n=2。
	console.log("   Radius:", await describe(radius.replica("s2")));
	await store2.close(context);

	// 5. "Continue on Radius": the laptop uploads its tail (nothing left here), Radius bumps the epoch and drives,
	// writing a commit on its replica. The laptop keeps its copy as a replica and writes nothing.
	// 交接前把笔记本 s1 当前（seq 6）整库导出为归档；稍后用它复制出一个“错过接管的旧进程”。
	// archiveOf 读取期间持有提交队列，因此快照一致。
	const handoff = await archiveOf(store);
	console.log(
		"5. laptop s1 sync:",
		shown(await sync(s1, radius)),
		"- Radius takes over, epoch",
		radius.takeOver("s1"),
	);
	// 这次 sync 没有新提交（本地 outbox floor 6、Radius 也在 6）→ nothing；takeOver 把 epoch 改为 2、
	// driver 改为 radius，返回新 epoch。注意本地 s1.epoch 仍是 1——旧客户端不会自动得知接管。
	await radius.drive("s1", (replica) =>
		// drive 临时在 Radius 副本上打开 host 写入一条消息：表已就绪，激活不产生提交；say 产生 seq 7。
		// host 关闭后 drive 的 #moveToLog 把副本 outbox 中的 7 搬进日志（log 1..7）。
		withSession(replica, async (session) => {
			await session.say({ role: "assistant", text: "(on Radius) added a test" }, context);
		}),
	);
	console.log("  ", atRadius("s1"));
	// A laptop process that missed the handoff (here a copy of the laptop's store at it, so the laptop itself can take
	// the session back in step 6) writes at epoch 1 and uploads the new commit after its last acknowledgement.
	// stale 模拟“没看到接管通知的旧进程”：从交接时的归档复制（lastSeq 6，outbox floor 6），
	// 仍认为 epoch 1、服务器确认到 6。真实笔记本 store 保留在 seq 6，供第 6 步拉取 Radius 的提交。
	const stale: LocalSession = { id: "s1", store: await copyOf(handoff), epoch: 1, acked: 6 };
	// 旧进程本地写入一条不同的消息 → 副本的 seq 7；这条提交进入本地 outbox（floor 6）。
	await withSession(stale.store, async (session) => {
		await session.say({ role: "assistant", text: "(stale laptop) added a different test" }, context);
	});
	// 不重新握手，直接 push：发送 from 7 to 7、epoch 1。radius.upload 发现会话当前 epoch 2 → refused/epoch。
	// push 因此返回 split（不回滚本地 store）。
	const fenced = await push(stale, radius);
	console.log("   stale laptop: lastSeq", stale.store.lastSeq, "- push:", shown(fenced));
	// The split (S7): no rollback; the copy is a new session with its origin, synced on its own from an archive.
	// 类型收窄：fenced.kind === "split" 后才能访问 fenced.session。
	if (fenced.kind === "split") {
		const split = fenced.session;
		console.log(
			"   split",
			split.id,
			"origin",
			JSON.stringify(split.origin),
			"- sync:",
			shown(await sync(split, radius)),
		);
		// 新会话 id 为 s1~split@6，与原会话共享到 seq 6；它复用同一 store（含本地分叉提交 7）。
		// 对它 sync：Radius 没有该 id 且 outbox floor 6 > 0 → bootstrap 整个 store（1289 字节，含 1..7）；
		// Radius 导入到 7，日志从 7 之后开始（即空），epoch 1、driver laptop。
		console.log("  ", atRadius(split.id));
	}
	// 关闭这个临时副本；原会话 s1 在 Radius 上保持不变。
	await stale.store.close(context);

	// 5b. The same without the epoch fence: the stale upload of seq 7 does not follow Radius's 7 and is refused, so far
	// so good; but the next handshake finds both at 7, sends nothing and trims the laptop's commit 7 as acknowledged.
	// 关闭 epoch 围栏，模拟缺少 S7 检查的服务器。另一个同样的旧副本：从交接归档复制（lastSeq 6、floor 6），
	// epoch 1、acked 6，然后本地写入自己的 seq 7。
	radius.checkEpochs = false;
	const unfenced: LocalSession = { id: "s1", store: await copyOf(handoff), epoch: 1, acked: 6 };
	await withSession(unfenced.store, async (session) => {
		await session.say({ role: "assistant", text: "(stale laptop) added a different test" }, context);
	});
	// push：没有 epoch 检查，applyBatch 真正执行；副本 lastSeq 已是 7（Radius 自己的提交），
	// 批次的第 0 条提交 seq 7 不等于期望的 lastSeq+1=8 → ChordError "does not follow seq 7" → refused/batch。
	// 也就是说，即使没有 epoch 围栏，序号连续性仍阻止了覆盖；失败整批回滚，副本未被修改。
	console.log("5b. no epoch check - stale push:", shown(await push(unfenced, radius)));
	// 但随后的 sync 只看握手 lastSeq：两边都是 7，于是 acked=7、trim(7) 把本地那条从未被服务器接受的提交
	// 当作已确认丢掉；push 无提交可发 → nothing。结果：两边 lastSeq 都是 7，内容却不同（静默分叉）。
	// 这就是 epoch 围栏存在的原因：仅靠 lastSeq 无法区分两段不同的历史。
	console.log("   stale sync:", shown(await sync(unfenced, radius)), "- outbox floor", unfenced.store.outbox!.floor);
	// stale 的 5 条消息含它自己的分叉提交；Radius 的 5 条含 "(on Radius) added a test"。
	console.log("   stale: ", await describe(unfenced.store));
	console.log("   Radius:", await describe(radius.replica("s1")));
	await unfenced.store.close(context);
	// 恢复围栏，供第 6 步的正常路径使用。
	radius.checkEpochs = true;

	// 6. Back to the laptop: it takes the epoch (Radius stops driving), pulls Radius's commits after its lastSeq
	// (batch apply on the laptop's store; no host open on it), and drives again.
	// handBack：epoch 3、driver 改回 laptop，返回新 epoch。sync 不会自动采用握手里的 epoch
	// （只在一次上传被应用（applied）或 bootstrap 时更新），所以必须显式赋给本地会话。
	s1.epoch = radius.handBack("s1", "laptop");
	// pull：Radius 日志 1..7 中 seq > 本地 lastSeq(6) 的提交 = [7]；from 先算作 7；
	// applyBatch 在笔记本 store（无打开的 host）上应用 seq 7（一笔事务），同时写入本地 outbox；
	// acked 设为 7，outbox 裁到 7。返回 {from:7,to:7}。
	const pulled = await pull(s1, radius);
	console.log(`6. laptop takes epoch ${s1.epoch}, pulls ${pulled.from}..${pulled.to}: lastSeq ${store.lastSeq}`);
	// 两边读取：笔记本现在也有 Radius 的提交；它从未有过 stale 副本里的分叉提交，所以两边一致。
	const [laptopView, radiusView] = [await describe(store), await describe(radius.replica("s1"))];
	console.log("   laptop:", laptopView);
	console.log("   Radius:", radiusView);
	console.log("   same values:", laptopView === radiusView);
	// 再在笔记本上写一次 rename（title 已存在，delta 提交 seq 8）；sync 时 epoch 3 匹配，上传 8..8。
	// Radius 日志变为 1..8，outbox 裁到 8；最后一次比较仍为 true。
	await withSession(store, async (session) => {
		await session.rename("Fix the parser (done)", context);
	});
	console.log("   laptop writes, sync:", shown(await sync(s1, radius)));
	console.log("  ", atRadius("s1"));
	console.log("   same values:", (await describe(store)) === (await describe(radius.replica("s1"))));

	// 正常结束：关闭笔记本主 store。若上面的步骤抛错，这一行不会执行；finally 仍会关闭 Radius 并删除临时目录。
	await store.close(context);
} finally {
	// 关闭 Radius 的所有副本（内存 SQLite），并递归删除临时目录（s2 的文件库）。
	// finally 保证即使中间失败也清理这两项；未显式关闭的笔记本 store 由进程退出回收。
	await radius.close();
	await rm(directory, { recursive: true, force: true });
}
