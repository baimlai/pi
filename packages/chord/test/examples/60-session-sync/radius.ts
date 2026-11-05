// 文件导读
// 所属：packages/chord/test/examples/60-session-sync，示例 60（会话同步）的服务器端替身。
// 作用：这是一个用内存模拟 Radius（Durable Object + R2）的 STAND-IN，不是 Chord API。按会话 id 保存：
//   - replica：SQLite :memory: 中的副本 store（相当于 DO 的 SQLite）；
//   - log：提交日志（相当于 R2；副本 outbox 中新增的提交被搬进这里并从 outbox 裁剪）；
//   - epoch 与 driver：谁在驱动、第几代，用于 S7 的 epoch 围栏。
// 上游：main.ts 创建并调用；sync.ts 通过 handshake/upload/bootstrap/pull 与它交互。
// 下游：Chord 真实的 store/importStore/applyBatch；JSON 与 JSONL 是“线缆”格式。
// 能力清单：Known/Batch/Uploaded 类型；RadiusStandIn 的 handshake/upload/bootstrap/takeOver/drive/handBack/
//   pull/replica/logRange/close；内部 #create/#entry/#moveToLog；openReplica。
// 典型流程：upload（JSON 批次）→ applyBatch 写入 replica（同一事务）→ #moveToLog（outbox → log，再 trim）；
//   bootstrap（JSONL 归档）→ importStore → 以导入的 lastSeq 作为 logFloor；
//   takeOver/handBack 只改 epoch 与 driver；drive/work 期间临时打开 host 写 replica。
// 阅读顺序：先看类型，再看 handshake/upload/bootstrap，然后 takeOver/drive/handBack/pull，最后 #moveToLog。
// 运行方式：由 main.ts 使用；不能单独运行。
// 信任边界：批次以 JSON 字符串到达，archive 以 JSONL 字节到达。JSON.parse 只解析结构；各提交的形状、
//   序号连续性和写入合法性由 applyBatch 校验（失败整批回滚）。本替身本身不校验信封字段类型。
// 说明：checkEpochs=false 只用于演示“没有 epoch 围栏时会静默分叉”；默认开启。

// STAND-IN for Radius, not a Chord API: what example 60 needs of the server side of session sync, in memory. Per
// session id it keeps a replica store (SQLite in memory, as a Durable Object's SQLite would be), the commit log (what
// R2 would hold; the replica's outbox is moved into it and trimmed after every change), the driver and its epoch.
// Batches and archives cross a "wire" as JSON and JSONL bytes, so the replica checks them as a trust boundary.
// `checkEpochs = false` turns the epoch fence off, to show what the gap analysis warned about.
import { Readable } from "node:stream";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { ChordError } from "../../../src/data/index.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
// Internal: the sync layer's batch apply (exported from `chord` marked internal) takes the `ChordStore` that
// `openStore` returns behind the app-facing `Store` type.
// applyBatch 是内部入口（文件路径直接导入）：校验整批信封/写入，并在一笔后端事务中重放。
import { applyBatch } from "../../../src/store/apply-batch.ts";
import {
	decodeJsonl,
	importStore,
	type OutboxCommit,
	openStore,
	type Store,
	sqliteBackend,
} from "../../../src/store/index.ts";
// 应用层看到的 Store 是接口；applyBatch 需要具体实现 ChordStore。运行时 openStore 返回的正是 ChordStore，
// 因此这里的 as 只是把这一既有事实告诉类型系统，不会在运行时检查。
import type { ChordStore } from "../../../src/store/store.ts";

/** What the handshake reports per session: Radius's applied head, the epoch and who drives. */
// 握手结果（每个会话一条）：Radius 已应用的 lastSeq、当前 epoch、当前 driver。
// lastSeq 是副本最后一条已提交的 seq；driver 是写者身份（"laptop" / "radius"）。
export type Known = { readonly lastSeq: number; readonly epoch: number; readonly driver: string };

/** A batch as it travels: the commits `from..to` and the uploader's epoch (S5: every batch carries `from` and `to`). */
// 上传批次：提交区间 from..to、上传者的 epoch，以及按 seq 顺序排列的提交。
// 这些字段来自“线缆”，upload 不会逐字段做 schema 校验；applyBatch 会检查提交本身及序号连续性。
export type Batch = {
	readonly from: number;
	readonly to: number;
	readonly epoch: number;
	readonly commits: readonly OutboxCommit[];
};

/** An upload's answer: applied (the new head is the acknowledgement) or refused, for an old epoch or by the replica. */
// 上传结果的可辨识联合：applied 携带新头（即确认）；refused 分为 epoch 过期与批次被副本拒绝两种。
// 判别字段是 kind（第二层再按 reason），调用方 switch 后 TypeScript 才能访问对应字段。
export type Uploaded =
	| { readonly kind: "applied"; readonly lastSeq: number; readonly epoch: number }
	| { readonly kind: "refused"; readonly reason: "epoch"; readonly epoch: number }
	| { readonly kind: "refused"; readonly reason: "batch"; readonly message: string };

// 每个会话在“Radius”上的全部状态。
// replica 是副本 store；log 只保存 logFloor 之后的提交（R2 的部分）；epoch/driver 决定谁有权写。
// logFloor 是引导时的 seq：bootstrap 导入的归档已覆盖到该位置，之后的提交才进 log。
type Entry = {
	readonly replica: Store;
	/** The commit log (R2's part): every commit after `logFloor` (the seq it was bootstrapped at). */
	readonly log: OutboxCommit[];
	readonly logFloor: number;
	epoch: number;
	driver: string;
};

/** The stand-in: sessions by id, for one owner. */
// 服务器替身：一个 Map 保存所有会话，键是会话 id。示例只有一个 owner，不做多租户隔离。
export class RadiusStandIn {
	/** The epoch fence (S7); off only to show the divergence without it. */
	// 是否执行 epoch 围栏（S7）。关闭只用于 5b 步演示反例；正常路径保持 true。
	checkEpochs = true;
	// #sessions：会话 id -> Entry。私有的运行时字段，外部只能通过方法访问。
	readonly #sessions = new Map<string, Entry>();

	/** The handshake: every session Radius has, with its `lastSeq`, epoch and driver. */
	// 握手：返回 Radius 已知的每个会话及其 lastSeq/epoch/driver。纯读取，无副作用。
	// 客户端据此判断：未知 → 需 bootstrap；已知落后 → 上传 outbox；已知领先 → 需要 pull。
	handshake(): Record<string, Known> {
		// 普通对象作为记录；id 来自应用（本示例固定为 s1、s2、s1~split@6）。
		const known: Record<string, Known> = {};
		// 解构 Map 值的字段；replica.lastSeq 是副本最后一次提交的 seq（store 在内存中维护）。
		for (const [id, { replica, epoch, driver }] of this.#sessions)
			known[id] = { lastSeq: replica.lastSeq, epoch, driver };
		return known;
	}

	/** Applies an uploaded batch (JSON) to the session's replica; a first batch from seq 1 makes the session. */
	// 应用一个上传批次。输入：会话 id、上传者（driver）、JSON 字符串；输出 Uploaded。
	// 副作用：可能创建会话/replica、把提交写入副本与副本 outbox、搬入 log 并裁剪 outbox。
	// 错误路径：未知会话且不是从 1 开始 → refused/batch；epoch 不符 → refused/epoch；
	//   applyBatch 的 ChordError（序号不连续、写入非法等）→ refused/batch；其他错误原样抛出。
	// 流程：JSON.parse → 首次创建 → epoch 围栏 → applyBatch（整批一笔事务）→ 搬 log。
	async upload(id: string, driver: string, wire: string): Promise<Uploaded> {
		// JSON.parse 是信任边界：畸形 JSON 会直接抛出（示例的上传方总是生成合法 JSON）。
		// as Batch 只是编译期断言；信封字段没有运行时 schema 校验，提交内容由 applyBatch 检查。
		const batch = JSON.parse(wire) as Batch;
		let entry = this.#sessions.get(id);
		// 第一个批次（from 恰好为 1）可以创建会话：空副本 + outbox 开启，logFloor=0。
		// 注意这会先创建 entry，再做 epoch 检查；示例的第一个批次 epoch 总是 1。
		if (entry === undefined && batch.from === 1) entry = this.#create(id, driver, await openReplica());
		// 未知会话且不是“从 1 开始”：必须先用归档 bootstrap，不能凭空应用中间批次。
		if (entry === undefined) return { kind: "refused", reason: "batch", message: "unknown session: bootstrap first" };
		// S7 的 epoch 围栏：上传者的代数与服务器不一致（例如服务器已被接管）即拒绝，且不写任何数据。
		if (this.checkEpochs && batch.epoch !== entry.epoch)
			return { kind: "refused", reason: "epoch", epoch: entry.epoch };
		try {
			// applyBatch 校验整批并在一笔后端事务中应用；成功后副本的 lastSeq 推进到 to，
			// 提交同时写入副本 outbox（因为副本以 outbox:true 打开）。
			// as ChordStore：Store 接口 -> 具体类，运行时同一个对象（见文件头的说明）。
			await applyBatch(entry.replica as ChordStore, batch.commits, context);
		} catch (error) {
			// ChordError 是 store 的公开拒绝（invalid/args、diverged 等）；转成批次拒绝。
			// 其他错误（例如存储/编程错误）不是“可拒绝的输入”，继续向上抛出。
			if (!(error instanceof ChordError)) throw error;
			return { kind: "refused", reason: "batch", message: error.message };
		}
		// 把副本 outbox 里的新提交搬进 log（R2），然后把 outbox 裁到 lastSeq。
		await this.#moveToLog(entry);
		// 新头即确认：上传方据此推进 acked 并裁剪自己的 outbox。
		return { kind: "applied", lastSeq: entry.replica.lastSeq, epoch: entry.epoch };
	}

	/** Makes the session from an archive (JSONL bytes): its replica imported, the log starting at its `lastSeq`. */
	// 引导：用归档（JSONL 字节）创建会话。输入 id、driver、字节；输出 Known。
	// 流程：新建内存 SQLite → importStore（一笔事务导入，outbox 从导入后的 lastSeq 起算）→ #create。
	// 副作用：创建会话与副本；返回的 lastSeq 是归档覆盖到的位置，之后的上传从 lastSeq+1 继续。
	async bootstrap(id: string, driver: string, bytes: Uint8Array): Promise<Known> {
		const backend = sqliteBackend(await openNodeSqliteDatabase(":memory:"));
		// decodeJsonl 把字节流解码为归档部件流；importStore 校验并导入。
		// { outbox: true }：outbox 从现在（导入后的 lastSeq）开始记录，导入的历史不会再重复上传。
		const replica = await importStore(backend, decodeJsonl(Readable.from([bytes])), context, { outbox: true });
		// #create 把 logFloor 设为 replica.lastSeq；epoch 重置为 1，driver 为上传者。
		// 本替身不检查 id 是否已存在：协议上 bootstrap 只用于未知会话或日志已不覆盖的情形。
		const entry = this.#create(id, driver, replica);
		return { lastSeq: replica.lastSeq, epoch: entry.epoch, driver };
	}

	/** "Continue on Radius": a new epoch, Radius drives; an upload at the old epoch is refused from now on. */
	// “在 Radius 上继续”：epoch +1，driver 改为 radius，返回新 epoch。
	// 从这一刻起，旧 epoch 的上传都会被 epoch 围栏拒绝（S7），旧副本不会被回滚。
	takeOver(id: string): number {
		const entry = this.#entry(id);
		entry.epoch += 1;
		entry.driver = "radius";
		return entry.epoch;
	}

	/** Radius as the driver: `work` writes on the replica (a host on it, closed again), its commits go to the log. */
	// 由 Radius 驱动：先检查 driver 必须是 "radius"，再执行 work（示例里临时打开一个 host 写副本），
	// 最后把新提交搬进 log。work 中的 host 关闭后，副本的 claim 释放，之后才能安全 applyBatch。
	async drive(id: string, work: (replica: Store) => Promise<void>): Promise<void> {
		const entry = this.#entry(id);
		// 错误的驱动者调用会直接抛普通 Error（示例只会在 takeOver 之后调用）。
		if (entry.driver !== "radius") throw new Error(`radius: ${id} is driven by ${entry.driver}`);
		await work(entry.replica);
		await this.#moveToLog(entry);
	}

	/** "Back to the laptop": a new epoch for `driver`; Radius stops writing. */
	// “交回笔记本”：epoch +1，driver 改为给定值，返回新 epoch。Radius 之后不再主动写；
	// 笔记本先 pull 补齐，再用新 epoch 继续上传。
	handBack(id: string, driver: string): number {
		const entry = this.#entry(id);
		entry.epoch += 1;
		entry.driver = driver;
		return entry.epoch;
	}

	/** The log's commits after `afterSeq` (JSON), for a pull. */
	// 拉取：返回 log 中 seq > afterSeq 的提交（JSON 字符串）。
	// afterSeq 早于 logFloor 时抛错：更早的提交已被裁剪，拉取方应先 bootstrap。
	pull(id: string, afterSeq: number): string {
		const entry = this.#entry(id);
		if (afterSeq < entry.logFloor) throw new Error(`radius: ${id}'s log starts after ${entry.logFloor}`);
		// filter 保持 seq 顺序；JSON.stringify 序列化 OutboxCommit 数组（示例的数据只有表与文档）。
		return JSON.stringify(entry.log.filter((commit) => commit.seq > afterSeq));
	}

	/** The session's replica, to read it in the example. */
	// 暴露副本以便示例用 describe 读取（只读用途）。未知会话由 #entry 抛出。
	replica(id: string): Store {
		return this.#entry(id).replica;
	}

	/** The seqs the log holds, as `from..to`. */
	// 日志范围的可读形式：空日志显示 `empty after <logFloor>`，否则 `首seq..尾seq`。
	logRange(id: string): string {
		const { log, logFloor } = this.#entry(id);
		// 非空断言：log.length 为 0 的分支已在三元的另一支处理。
		return log.length === 0 ? `empty after ${logFloor}` : `${log[0]!.seq}..${log.at(-1)!.seq}`;
	}

	/** Closes every replica. */
	// 关闭所有副本（每个 store.close 释放 SQLite 等资源）。示例在 finally 中调用。
	async close(): Promise<void> {
		for (const { replica } of this.#sessions.values()) await replica.close(context);
	}

	// 创建会话记录：log 为空，logFloor 取当前副本 lastSeq（已含的数据不再进 log），epoch 从 1 开始。
	#create(id: string, driver: string, replica: Store): Entry {
		const entry: Entry = { replica, log: [], logFloor: replica.lastSeq, epoch: 1, driver };
		this.#sessions.set(id, entry);
		return entry;
	}

	// 查找会话；不存在时抛普通 Error（调用方都是示例内部、已知存在的路径）。
	#entry(id: string): Entry {
		const entry = this.#sessions.get(id);
		if (entry === undefined) throw new Error(`radius: no session ${id}`);
		return entry;
	}

	/** The replica's new commits into the log (the DO writing its commit log to R2), then trimmed from its outbox. */
	// 把副本 outbox 中 floor 之后的新提交搬进 log，然后把 outbox 裁到副本 lastSeq。
	// 等价于 Durable Object 把提交日志写到 R2 后清空本地积压；read 的 10_000 是单次上限，
	// 超过时这里只搬前 10_000 条（示例数据量远小于该上限）。
	async #moveToLog(entry: Entry): Promise<void> {
		// `!`：本文件的副本总是以 outbox:true 打开（bootstrap 或 openReplica）。
		const outbox = entry.replica.outbox!;
		// read(floor, limit)：返回 floor 之后最多 limit 条提交；floor 等于 lastSeq 时返回空数组。
		entry.log.push(...(await outbox.read(outbox.floor, 10_000, context)));
		// 搬完即裁：这些提交已由 log（R2）持久保存，不再需要留在 outbox。
		await outbox.trim(entry.replica.lastSeq, context);
	}
}

/** A replica as Radius makes it for a session uploaded from seq 1: empty, its outbox on. */
// 从 seq 1 上传而新建的会话：空副本，outbox 开启（floor 0），之后批次写入的提交也会记录进 outbox。
async function openReplica(): Promise<Store> {
	return openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context, { outbox: true });
}
