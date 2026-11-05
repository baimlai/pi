// 文件导读
// 所属：packages/chord/test/examples/60-session-sync，示例 60 的“笔记本端同步层”替身（STAND-IN，不是 Chord API）。
// 作用：实现已定的同步协议：
//   - sync：握手（问 Radius 每个会话的 lastSeq/epoch），必要时用归档 bootstrap，否则把 outbox 中
//     lastSeq+1 之后的提交整批上传，成功后裁剪到服务器确认的位置；
//   - push：不重新握手，直接上传上次确认之后的提交（S5 的急切上传/重试）；旧 epoch 被拒时产生 split；
//   - bootstrap：把整库归档（JSONL）交给 Radius 导入；
//   - pull：取回 Radius 日志中本地 lastSeq 之后的提交，用 applyBatch 应用到本地 store；
//   - archiveOf：把 store.export 的部件编码成 JSONL 字节。
// 上游：main.ts 的六个步骤调用。
// 下游：radius.ts 的 handshake/upload/bootstrap/pull/takeOver；Chord 真实的 store.outbox.read/trim、
//   store.export、encodeJsonl、importStore/applyBatch。
// 能力清单：LocalSession、Synced、sync、push、bootstrap（内部）、pull、archiveOf。
// 关键概念：floor 是 outbox 仍保留的最早 seq（更早的已裁剪）；acked 是 Radius 最后确认的 seq；
//   epoch 是驱动代数（服务器接管时递增），只有 upload 的 epoch 围栏会检查它。
// 运行方式：由 main.ts 使用；不能单独执行。
// 校验边界：pull 收到的 JSON 在这里 parse 成 OutboxCommit[]（编译期断言），提交的形状/序号连续性由
//   applyBatch 校验；upload 的 JSON 由 radius.upload 解析。协议字段 epoch/from/to 未做运行时 schema 校验。
// 说明：applyBatch 要求目标 store 上没有打开的 host（打开的 host 持有 claim）；示例总在 host 关闭后同步。
// 阅读顺序：先看 LocalSession/Synced 类型，再看 sync/push/pull/archiveOf 的协议步骤。

// STAND-IN for the laptop's sync layer, not a Chord API: the decided handshake (ask Radius for `lastSeq`, send the
// outbox from `lastSeq + 1`, trim through the answer), the bootstrap from an archive, the eager upload of new commits
// after the last acknowledgement (S5), the split on an old epoch (S7) and the pull of Radius's commits. Built on
// Chord's real pieces: `store.outbox.read`/`trim`, `store.export`, `encodeJsonl`, and `applyBatch` (internal).
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
// applyBatch：内部入口，按整批校验与事务重放提交（见 radius.ts 的说明）。
import { applyBatch } from "../../../src/store/apply-batch.ts";
// encodeJsonl：把归档部件编码为 JSONL 字节流；OutboxCommit 是 outbox 提交的类型；Store 仅类型。
import { encodeJsonl, type OutboxCommit, type Store } from "../../../src/store/index.ts";
// Store 是应用层接口；applyBatch 需要具体 ChordStore。运行时是同一对象，as 只是编译期断言。
import type { ChordStore } from "../../../src/store/store.ts";
import type { Batch, RadiusStandIn } from "./radius.ts";

/** A session on the laptop: its id, store, the epoch it drives in (a new session: 1) and the `lastSeq` Radius last acknowledged. */
// 本地会话：id 标识映射到 Radius 的哪条会话；store 必须开启 outbox（sync/push/pull 都用它）；
// epoch 是本地认为的驱动代数；acked 是最后确认的 seq；origin 只出现在 split 出来的新会话上。
// 这些字段可在同步过程中被原地更新（epoch/acked），id/store/origin 只读。
export type LocalSession = {
	readonly id: string;
	readonly store: Store;
	epoch: number;
	acked: number;
	/** A split-off copy's origin: the session it was and the last seq they share (S7). */
	readonly origin?: { readonly id: string; readonly seq: number };
};

/** What a sync or a push did. */
// 同步结果的可辨识联合：
//   uploaded    上传了 from..to，Radius 新头为 lastSeq（本地 outbox 已裁剪）；
//   nothing     没有可上传的提交（本地与已确认位置一致）；
//   bootstrapped 上传整库归档，Radius 导入到 lastSeq，bytes 是归档大小；
//   behind      Radius 比本地领先，需先 pull；
//   split       旧 epoch 被拒，产生新会话对象（同一 store，新的 id/epoch/acked）；
//   refused     批次内容被 Radius 拒绝（例如序号不连续）。
// shown() 依赖判别字段 kind 穷尽 switch。
export type Synced =
	| { readonly kind: "uploaded"; readonly from: number; readonly to: number; readonly lastSeq: number }
	| { readonly kind: "nothing"; readonly lastSeq: number }
	| { readonly kind: "bootstrapped"; readonly lastSeq: number; readonly bytes: number }
	| { readonly kind: "behind"; readonly lastSeq: number }
	| { readonly kind: "split"; readonly session: LocalSession }
	| { readonly kind: "refused"; readonly message: string };

// 本示例只有一个写者身份；上传时作为 driver 传给 Radius（服务器记录当前驱动者）。
const DRIVER = "laptop";

/** The handshake, then the outbox from Radius's `lastSeq + 1`; an archive when Radius has less than the outbox. */
// 函数说明：一次完整同步。输入本地会话与 Radius 替身；输出 Synced。
// 副作用：可能 bootstrap（上传归档）、trim 本地 outbox、上传批次并推进 acked/epoch。
// 流程：握手 → 两种 bootstrap 条件 → “服务器领先”判断 → 对齐 acked/裁剪 → push。
// 示例：Radius 无此会话且 floor 为 0 → push 从 seq 1 创建会话；
//   已知 lastSeq 6 而本地 outbox floor 6 → 没有可发提交，返回 nothing。
export async function sync(session: LocalSession, radius: RadiusStandIn): Promise<Synced> {
	const { store } = session;
	// outbox 必须已开启；`!` 是示例前提（openStore 时传了 outbox:true，或事后开启）。
	const outbox = store.outbox!;
	// 握手返回所有已知会话；按 id 取本会话，未知为 undefined。
	const known = radius.handshake()[session.id];
	// 情况 A：Radius 没有此会话，而本地 outbox 已不是从 1 开始（floor > 0）。更早的提交已裁剪，
	// 无法用批次补齐，只能上传整库归档让 Radius 从某个 lastSeq 开始。
	if (known === undefined && outbox.floor > 0) return bootstrap(session, radius);
	// 情况 B：Radius 已知，但其头早于本地 outbox 的起点（中间有缺口）——同样只能 bootstrap。
	if (known !== undefined && known.lastSeq < outbox.floor) return bootstrap(session, radius);
	// Radius ahead: a pull-back (S3, same epoch) or a split (S7); step 6 pulls explicitly.
	// 情况 C：Radius 的头比本地 lastSeq 大（服务器上有本地没有的提交）。这里不自动 pull，
	// 只报告 behind；第 6 步先 handBack 再显式 pull（自动 pull 需要先确定 epoch 归属）。
	if (known !== undefined && known.lastSeq > store.lastSeq) return { kind: "behind", lastSeq: known.lastSeq };
	// 到这里 Radius 未知（floor=0，从头上传）或已知且不领先：服务器确认位置取 known.lastSeq（未知为 0）。
	session.acked = known?.lastSeq ?? 0;
	// 把本地 outbox 裁到确认位置（已上传的历史不再保留）；trim 到 floor 之前不会发生（上面的检查保证）。
	await outbox.trim(session.acked, context);
	// 上传 acked 之后的所有提交；没有则返回 nothing。
	return push(session, radius);
}

/** Uploads the outbox after the last acknowledgement, without asking first (an eager or resubmitted upload, S5). */
// 函数说明：不重新握手，直接把 acked 之后的 outbox 提交作为一个批次上传。输入会话与 Radius；输出 Synced。
// 副作用：成功时推进 acked/epoch（服务器可能返回更高 epoch）并裁剪 outbox；epoch 被拒时返回 split。
// 流程：read 出提交 → 组 Batch（from/to 取实际首尾 seq）→ upload → 按 applied/refused 分支处理。
// 示例：step 5 的 stale 会话 acked=6、本地有 seq 7，push 直接发送 from=7,to=7。
export async function push(session: LocalSession, radius: RadiusStandIn): Promise<Synced> {
	const { store } = session;
	// 单次最多读 10_000 条；示例数据量远小于此。read 要求 afterSeq 位于 outbox 的 floor..lastSeq 之间。
	const commits = await store.outbox!.read(session.acked, 10_000, context);
	// 没有新提交：本地已全部确认（或尚未产生提交）。
	if (commits.length === 0) return { kind: "nothing", lastSeq: session.acked };
	// from/to 用实际首尾提交的 seq，而不是 acked+1/lastSeq：读取可能受 limit 限制，批次只覆盖读到的范围。
	// JSON.stringify 把 Batch 变成“线缆”字符串；epoch 告诉服务器上传者认为的驱动代数。
	const batch: Batch = { from: commits[0]!.seq, to: commits.at(-1)!.seq, epoch: session.epoch, commits };
	const answer = await radius.upload(session.id, DRIVER, JSON.stringify(batch));
	switch (answer.kind) {
		case "applied":
			// 服务器的新头即确认位置；epoch 以服务器返回为准（正常情况下与本地相同）。
			session.acked = answer.lastSeq;
			session.epoch = answer.epoch;
			// 已确认的提交可以从 outbox 裁掉；保留的是 lastSeq 之后（尚未产生或未上传）的部分。
			await store.outbox!.trim(answer.lastSeq, context);
			return { kind: "uploaded", from: batch.from, to: batch.to, lastSeq: answer.lastSeq };
		case "refused":
			// 批次内容本身被拒（未知会话/序号不连续等）：不改 acked，也不裁剪，等待人工或下次重试。
			if (answer.reason === "batch") return { kind: "refused", message: answer.message };
			// S7: no rollback; this copy goes on as a new session that shares the old one's commits through `acked`.
			// epoch 过期：本地这批提交不能写入原会话（服务器已被接管）。不回滚本地 store；
			// 而是生成一个新会话对象：同一 store、新 id（带分叉点）、epoch 重置 1、acked 0、origin 记录来源。
			// 随后对这个新 id 调 sync 时，因 Radius 未知且 floor > 0，会整库 bootstrap，把分叉历史保存为新会话。
			return {
				kind: "split",
				session: {
					// id 形如 s1~split@6：原会话 s1、双方最后一个共同的 seq 6。
					id: `${session.id}~split@${session.acked}`,
					store,
					epoch: 1,
					acked: 0,
					origin: { id: session.id, seq: session.acked },
				},
			};
	}
}

/** Uploads the store's archive; Radius imports it and batches go on from its `lastSeq`. */
// 函数说明（内部）：把整库归档上传给 Radius 引导新会话。输入会话与 Radius；输出 bootstrapped。
// 副作用：读取并序列化整库（期间提交队列被持有）、Radius 新建副本、本地 acked/epoch 更新并裁剪 outbox。
// 说明：bootstrap 不检查 Radius 是否已有该 id；协议上只对未知会话或日志不覆盖的情形调用。
async function bootstrap(session: LocalSession, radius: RadiusStandIn): Promise<Synced> {
	// 归档是 store 的一致快照（export 在读取期间持有提交队列）；jsonl 字节数即返回的 bytes。
	const bytes = await archiveOf(session.store);
	const known = await radius.bootstrap(session.id, DRIVER, bytes);
	// 导入覆盖到的新头即确认位置；epoch 由 Radius 返回（新引导为 1）。
	session.acked = known.lastSeq;
	session.epoch = known.epoch;
	// outbox 中已包含在归档里的提交不再需要上传；裁到导入位置。
	await session.store.outbox!.trim(known.lastSeq, context);
	return { kind: "bootstrapped", lastSeq: known.lastSeq, bytes: bytes.length };
}

/** Applies Radius's commits after the local `lastSeq` (no host may be open on the store: its claims refuse a batch). */
// 函数说明：拉取 Radius 日志中本地 lastSeq 之后的提交，并用 applyBatch 应用到本地 store。
// 输入会话与 Radius；输出实际应用的范围 { from, to }。
// 前提：store 上没有打开的 host（打开的 host 持有 store claim，applyBatch 会拒绝）；本地 outbox 已开启
//   （applyBatch 应用时也会把提交写进本地 outbox，随后被裁剪）。
// 说明：afterSeq 早于 Radius 日志起点时 radius.pull 会抛错（需要改走 bootstrap）。
//   若没有新提交，返回的 from 会是 lastSeq+1、to 是 lastSeq（示例只在已知落后时拉取，因此总有提交）。
export async function pull(session: LocalSession, radius: RadiusStandIn): Promise<{ from: number; to: number }> {
	// 线缆信任边界：JSON.parse 只做结构解析；as OutboxCommit[] 是编译期断言，提交内容由 applyBatch 校验。
	const commits = JSON.parse(radius.pull(session.id, session.store.lastSeq)) as OutboxCommit[];
	// 记录应用前的 lastSeq，用于计算范围起点；真正的写入在下一行。
	const from = session.store.lastSeq + 1;
	// as ChordStore：运行时同一个对象。applyBatch 要求提交首尾连续衔接本地 lastSeq，并在一笔事务中应用。
	await applyBatch(session.store as ChordStore, commits, context);
	// Batch apply writes the commits to this store's outbox too; Radius has them, so they are acknowledged.
	// 应用后的 lastSeq 即 Radius 的确认位置；这些提交已在 Radius 日志中，裁掉本地 outbox 副本。
	session.acked = session.store.lastSeq;
	await session.store.outbox!.trim(session.acked, context);
	return { from, to: session.store.lastSeq };
}

/** The store's archive as JSONL bytes (the commit queue held while it is read). */
// 函数说明：把整个 store 导出为 JSONL 字节。输入 store；输出拼好的 Uint8Array。
// 流程：store.export(context) 产生归档部件（读取期间持有提交队列，得到一致快照）→ encodeJsonl 编码 →
//   for await 收集 → Buffer.concat 合并（Buffer 是 Uint8Array 子类）。
// 副作用：读取期间写提交会排队等待；示例在 host 关闭时调用，不会与写入并发。
export async function archiveOf(store: Store): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	// encodeJsonl 接受 export 的部件迭代并按行编码，产出的仍是异步字节流。
	for await (const part of encodeJsonl(store.export(context))) parts.push(part);
	return Buffer.concat(parts);
}
