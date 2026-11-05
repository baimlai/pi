// 文件导读（Durable 存储基准：确定性数据集与读写场景）
//
// 所属模块：packages/durable/src/testing，经 "./testing" 导出；实际运行入口是
// packages/durable/test/storage.bench.ts（vitest bench）与 test/storage-memory.ts。
// 上游：基准脚本创建 MemoryStorage/sqlite/store/jsonl 后端后调用本文件的 seed 与场景；
// 下游：Storage 公共接口（src/types.ts）与同目录的 commitWrites。
//
// 职责边界：只用公开 Storage 契约生成数据，不访问后端内部结构，也不计时；计时由基准 runner
// 完成。数据必须确定：ID 由 mintId 分配，场景的 expected() 必须与 seed 生成的值一致，
// 基准脚本会先校验 run() === expected() 再计时。本文件不清理存储，也不关闭后端。
//
// 能力清单：
// - StorageBenchmarkScale / STORAGE_MEMORY_SCALES / TIMING_SCALE：规模定义（条目/任务/文档数量）。
// - storageBenchmarkPrimaryRecordCount(scale)：主记录总数（用于报告或内存预算）。
// - StorageBenchmarkDataset：seed 返回的定位坐标（首条目、文档 ID、历史序号等）。
// - seedStorageBenchmark(storage, scale?)：写入条目、任务、文档、回放尾巴、历史文档和 8 层 fork。
// - StorageReadBenchmark / STORAGE_READ_BENCHMARKS：读场景及期望值。
// - StorageWriteBenchmark / STORAGE_WRITE_BENCHMARKS：写场景及期望返回值。
// - seedStorageWriteBenchmark(storage)：写基准的前置状态（根会话 + 100 条基线条目）。
//
// 典型用法（来自 test/storage.bench.ts）：
//   const dataset = await seedStorageBenchmark(storage);
//   for (const scenario of STORAGE_READ_BENCHMARKS) {
//     strictEqual(await scenario.run(storage, dataset), scenario.expected(dataset));
//   }
// 先跑期望校验再交给 bench，能避免把错误数据当成性能结果。
//
// 建议阅读顺序：规模与常量 → StorageBenchmarkDataset → seedStorageBenchmark 的五段数据 →
// STORAGE_READ_BENCHMARKS → seedStorageWriteBenchmark 与 STORAGE_WRITE_BENCHMARKS。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
// 仅类型导入：Storage 的查询/记录类型只在编译期使用；BACKGROUND_CONTEXT 是运行时的空根上下文，
// 表示这些基准写入不绑定取消信号或追踪。
import type {
	ConversationId,
	DocumentCreate,
	DocumentId,
	EntryId,
	Seq,
	Storage,
	StorageWrite,
	SubmissionId,
	TaskId,
	TaskRecord,
} from "../types.ts";
// 根会话固定使用保留 ID 1；后面的条目、任务和文档都挂在它下面。
import { ROOT_CONVERSATION_ID } from "../types.ts";
import { commitWrites } from "./commit-writes.ts";

// 一档基准规模：条目、任务、文档三类主数据的数量。name 用于报告/describe 标签。
// 三个字段都是 readonly 的普通数字，没有运行时校验；调用方传负数会生成空数据并让后续断言失败。
export type StorageBenchmarkScale = {
	readonly name: string;
	readonly entryCount: number;
	readonly taskCount: number;
	readonly documentCount: number;
};

// 内存基准使用的两档规模。10k 档约是 1k 档的 10 倍，用于观察随数据量增长的内存占用。
// 任务和文档各取条目数的 20%，这是为了覆盖索引/扫描路径而不是追求与条目同量级。
export const STORAGE_MEMORY_SCALES: readonly StorageBenchmarkScale[] = [
	{ name: "1k", entryCount: 1_000, taskCount: 200, documentCount: 200 },
	{ name: "10k", entryCount: 10_000, taskCount: 2_000, documentCount: 2_000 },
];

// 默认计时规模：未显式传 scale 时 seedStorageBenchmark 使用它（1k 条目、300 任务、300 文档）。
export const TIMING_SCALE: StorageBenchmarkScale = {
	name: "timing",
	entryCount: 1_000,
	taskCount: 300,
	documentCount: 300,
};

// 回放文档的尾巴长度：0、16、128、1024 条 delta。读取 current 时要重放各自数量的增量。
// 历史文档先写 128 条 delta，再写一个 base checkpoint，然后再写 128 条 delta；
// 这样既能测"在新 base 之前"的历史读，也能测"在新 base 之后"的历史读。
// fork 链深 8 层，每层 32 条条目；BATCH_SIZE 是每批写入的记录数，避免单次提交过大。
const REPLAY_TAILS = [0, 16, 128, 1_024] as const;
const HISTORY_SEGMENT_LENGTH = 128;
const FORK_DEPTH = 8;
const ENTRIES_PER_FORK = 32;
const BATCH_SIZE = 100;

// 计算一档规模产生的主记录数，用于报告或估算内存。
// 组成：1 个根会话 + entryCount 条目 + taskCount 任务 + documentCount 文档
//     + REPLAY_TAILS.length 个回放文档 + 1 个历史文档
//     + FORK_DEPTH * (每层 1 个会话 + ENTRIES_PER_FORK 条条目)。
// 注意：回放/历史文档后续的 delta 或 base 提交不增加记录数，只增加历史/提交数；
// 因此这里是"主记录"而不是总写入次数。
export function storageBenchmarkPrimaryRecordCount(scale: StorageBenchmarkScale): number {
	return (
		1 +
		scale.entryCount +
		scale.taskCount +
		scale.documentCount +
		REPLAY_TAILS.length +
		1 +
		FORK_DEPTH * (1 + ENTRIES_PER_FORK)
	);
}

// TaskRecord 的三个泛型参数分别是 input、checkpoint、result 的 JSON 类型；
// 基准统一用 JsonValue，避免为测试夹具定义具体类型。
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

// seed 返回的定位坐标：基准场景用这些 ID/Seq 做精确查询或按范围扫描，而不是重新猜顺序。
// firstEntryId：根会话的第一条条目，带有 head 标记。
// filteredTaskCount：同时满足 kind=benchmark.filtered、status=pending、background=true 的任务数。
// exactDocumentId：最后一个 benchmark.family 文档；exactDocumentKey 是它对应的 family key。
// replayDocumentIds：尾巴长度 -> 文档 ID，用于按不同 delta 数量测重放。
// historicalDocumentId/ancientAt/recentAt：跨 base 的历史读坐标。
// deepestConversationId：fork 链最深层会话；ancestorHeadEntryId：它的祖先中最新的 head 标记。
export type StorageBenchmarkDataset = {
	readonly firstEntryId: EntryId;
	readonly filteredTaskCount: number;
	readonly exactDocumentId: DocumentId;
	readonly exactDocumentKey: string;
	readonly replayDocumentIds: Readonly<Record<(typeof REPLAY_TAILS)[number], DocumentId>>;
	readonly historicalDocumentId: DocumentId;
	readonly ancientAt: Seq;
	readonly recentAt: Seq;
	readonly deepestConversationId: ConversationId;
	readonly ancestorHeadEntryId: EntryId;
};

// 构造一个确定性的任务记录，index 决定状态和若干过滤字段。
// statuses 用 as const 保留字面量联合；index % 3 循环产生 pending/running/terminal。
// 每 4 个任务有 1 个 kind=benchmark.filtered，其余为 benchmark.other；
// 每 5 个任务有 1 个 background=true，每 7 个有 1 个 abortRequested=true。
// terminal 分支没有 checkpoint，但有 outcome；其他状态必须带 checkpoint。
// 返回对象用 satisfies StoredTask 校验形状，同时不把对象拓宽成更宽的类型。
// 内部 spread common 复用公共字段；checkpoint.payload 用 64 个 x 模拟真实检查点大小。
function task(id: TaskId<JsonValue>, index: number): StoredTask {
	const statuses = ["pending", "running", "terminal"] as const;
	const status = statuses[index % statuses.length];
	const common = {
		id,
		conversationId: ROOT_CONVERSATION_ID,
		kind: index % 4 === 0 ? "benchmark.filtered" : "benchmark.other",
		version: 1,
		input: { index },
		background: index % 5 === 0,
		abortRequested: index % 7 === 0,
	};
	if (status === "terminal") {
		return { ...common, state: { status, outcome: { status: "completed", result: { index } } } };
	}
	return { ...common, state: { status, checkpoint: { index, payload: "x".repeat(64) } } };
}

// 向存储写入一整套确定性基准数据，并返回后续场景需要的定位坐标。
// 输入：storage（任何实现 Storage 的后端）、scale（默认 TIMING_SCALE）。
// 输出：StorageBenchmarkDataset；数据已按批次持久化。
// 副作用：只通过 Storage.commit 写入；不关闭存储，不删除既有数据。
// 错误：若 scale 的条目数或文档数为 0，后面会抛 Error（见下方运行期检查）；
//       Storage 的拒绝/异常会原样冒泡。
// 主流程：根会话 → 条目 → 任务 → 普通文档 → 回放文档 → 历史文档 → fork 链 → 汇总坐标。
// 例子：const dataset = await seedStorageBenchmark(storage, { name: "tiny", entryCount: 4, taskCount: 0, documentCount: 1 });
/** Seed deterministic representative data through only the public `Storage` contract. */
export async function seedStorageBenchmark(
	storage: Storage,
	scale: StorageBenchmarkScale = TIMING_SCALE,
): Promise<StorageBenchmarkDataset> {
	// 先写根会话；所有条目/任务都引用 ROOT_CONVERSATION_ID，因此这是后续写入的前置条件。
	await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT);

	// 记录根会话的第一条条目 ID，供历史/fork 场景和 ancestorHeadEntryId 使用。
	// type 断言不是必须的；undefined 表示 scale.entryCount 为 0，函数末尾会检查并报错。
	let firstEntryId: EntryId | undefined;
	// 条目按 BATCH_SIZE=100 分批写入：每批一个 Storage.commit，减少往返次数。
	for (let start = 0; start < scale.entryCount; start += BATCH_SIZE) {
		const writes: StorageWrite[] = [];
		// 最后一批可能不足 100，用 min 截断；start 是该批第一条在全部条目中的全局下标。
		for (let index = start; index < Math.min(start + BATCH_SIZE, scale.entryCount); index++) {
			// 每个条目 ID 都由存储的全局命名空间分配，保证跨表唯一且单调。
			const id = await storage.mintId<EntryId>();
			// 只记住第一轮的第一个 ID；它同时用作条目 head 标记。
			if (index === 0) firstEntryId = id;
			writes.push({
				// 条目记录：kind 固定；第一条带 head（指向自己），表示活动上下文的起点；
				// data.text 为 96 个 x，模拟真实条目负载，让基准的序列化成本有代表性。
				// index === 0 ? { head: id } : {} 用条件展开，避免给其他条目写入 undefined 字段。
				type: "entry",
				value: {
					id,
					conversationId: ROOT_CONVERSATION_ID,
					kind: "benchmark.entry",
					...(index === 0 ? { head: id } : {}),
					data: { index, text: `entry-${index}-${"x".repeat(96)}` },
				},
			});
		}
		// 一批条目一次性提交；commitWrites 在拒绝时抛错，seed 会因此失败而不是生成半套数据。
		await commitWrites(storage, writes, BACKGROUND_CONTEXT);
	}

	// 任务同样按 100 条分批；task() 根据 index 决定状态和过滤属性。
	for (let start = 0; start < scale.taskCount; start += BATCH_SIZE) {
		const writes: StorageWrite[] = [];
		for (let index = start; index < Math.min(start + BATCH_SIZE, scale.taskCount); index++) {
			// 每个任务仍先 mintId；任务表与条目表共享同一个全局 ID 命名空间。
			writes.push({ type: "task", value: task(await storage.mintId<TaskId<JsonValue>>(), index) });
		}
		await commitWrites(storage, writes, BACKGROUND_CONTEXT);
	}

	// exactDocumentId 会在循环里被覆盖；循环结束时保留最后一个文档的 ID。
	let exactDocumentId: DocumentId | undefined;
	// 普通文档按批创建，每个都是 session 作用域的 family 成员，key 为 key-<index>。
	for (let start = 0; start < scale.documentCount; start += BATCH_SIZE) {
		const writes: StorageWrite[] = [];
		for (let index = start; index < Math.min(start + BATCH_SIZE, scale.documentCount); index++) {
			const id = await storage.mintId<DocumentId>();
			// 每次覆盖；最终值就是 key-${scale.documentCount - 1} 对应文档。
			// 若 documentCount 为 0，它保持 undefined，函数末尾会报错。
			exactDocumentId = id;
			// record 提供逻辑地址：kind 固定、key 区分 family 成员、scope 为 session。
			writes.push({
				type: "document.create",
				// 每个文档的初始 base 是 version 1，value 带 index 和 128 字节文本，体积足够触发真实存储路径。
				record: { id, kind: "benchmark.family", key: `key-${index}`, scope: { kind: "session" } },
				content: { kind: "base", version: 1, value: { index, text: "x".repeat(128) } },
			});
		}
		await commitWrites(storage, writes, BACKGROUND_CONTEXT);
	}

	// 先并发申请 4 个回放文档的 ID；每个 async 闭包内部等待 mintId，Promise.all 收集结果。
	// 并发只是为了减少等待，不依赖分配顺序；tail 决定后续写入多少条 delta。
	const replayEntries = await Promise.all(
		REPLAY_TAILS.map(async (tail) => {
			const id = await storage.mintId<DocumentId>();
			return { tail, id };
		}),
	);
	// 一个批次创建全部回放文档。map 结果中的 as const 让 type/kind/history/fork 保持字面量类型，
	// 满足 StorageWrite 判别联合的编译期要求；spread 不影响运行时数据。
	await commitWrites(
		storage,
		// record 使用 rewindable + asOf：保留历史，且 fork 时可从指定提交读取；scope 是根会话。
		replayEntries.map(({ tail, id }) => ({
			type: "document.create" as const,
			record: {
				id,
				kind: "benchmark.replay",
				key: String(tail),
				scope: { kind: "conversation" as const, conversationId: ROOT_CONVERSATION_ID },
				history: "rewindable" as const,
				fork: "asOf" as const,
			},
			// 初始内容 count=0，文本 64 字节；后续 delta 只改 count。
			content: { kind: "base" as const, version: 1, value: { count: 0, text: "x".repeat(64) } },
		})),
		BACKGROUND_CONTEXT,
	);
	// 从 1 写到最大尾巴 1024。每轮只给 tail >= count 的文档追加一条 delta：
	// 因此 tail=0 的文档永远不会变，tail=16 的文档最后 count=16，依此类推。
	// 这样同一套数据可以测"少量重放"和"长尾重放"。
	for (let count = 1; count <= REPLAY_TAILS.at(-1)!; count++) {
		await commitWrites(
			storage,
			// 过滤出本轮需要更新的文档；tail=0 的文档在 count=1 时就被排除。
			replayEntries
				.filter(({ tail }) => count <= tail)
				.map(({ id }) => ({
					type: "document.change" as const,
					id,
					// 操作是 Chord 的短路操作编码：['s', path, value] 表示 set。
					// as const 让元组保持固定长度/字面量类型，匹配 Op 联合。
					content: { kind: "delta" as const, version: 1, ops: [["s", ["count"], count] as const] },
				})),
			BACKGROUND_CONTEXT,
		);
	}

	// 历史文档：先创建 base，再写 128 条 delta，然后写一个新 base（checkpoint），再写 128 条 delta。
	const historicalDocumentId = await storage.mintId<DocumentId>();
	// 与回放文档一样使用 rewindable/asOf，才能按序号读取历史值。
	const historicalRecord = {
		id: historicalDocumentId,
		kind: "benchmark.history",
		scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
		history: "rewindable",
		fork: "asOf",
	} satisfies DocumentCreate;
	// 初始 base count=0；ancientAt 会落在第一段 delta 的末尾。
	await commitWrites(
		storage,
		[
			{
				type: "document.create",
				record: historicalRecord,
				content: { kind: "base", version: 1, value: { count: 0 } },
			},
		],
		BACKGROUND_CONTEXT,
	);
	// ancientAt 保存第一段 128 条 delta 之后的提交序号；TypeScript 不知道循环一定执行，
	// 所以先声明为 Seq | undefined。
	let ancientAt: Seq | undefined;
	// 第一段：128 条 delta，把 count 从 1 写到 HISTORY_SEGMENT_LENGTH。
	for (let count = 1; count <= HISTORY_SEGMENT_LENGTH; count++) {
		// 每轮 commit 都返回新序号；循环结束后 ancientAt 指向 count=128 的那次提交。
		ancientAt = await commitWrites(
			storage,
			[
				{
					type: "document.change",
					id: historicalDocumentId,
					content: { kind: "delta", version: 1, ops: [["s", ["count"], count]] },
				},
			],
			BACKGROUND_CONTEXT,
		);
	}
	// 写一个完整 base 作为 checkpoint，值为 count=128；这是历史读的"新 base"分界线。
	// base 之后，早期 delta 仍保留，供 ancientAt 处的历史读使用。
	await commitWrites(
		storage,
		[
			{
				type: "document.change",
				id: historicalDocumentId,
				content: { kind: "base", version: 1, value: { count: HISTORY_SEGMENT_LENGTH } },
			},
		],
		BACKGROUND_CONTEXT,
	);
	// 运行期检查：循环必然执行，但 TypeScript 只看到 Seq | undefined；
	// 这里也防止未来把 HISTORY_SEGMENT_LENGTH 改为 0 时静默生成错误坐标。
	if (ancientAt === undefined) throw new Error("Benchmark history seed produced no commits");
	// recentAt 从 ancientAt 起步；下面的第二段 delta 会把它推进到最新提交。
	let recentAt = ancientAt;
	// 第二段：128 条 delta，把 count 从 129 写到 256，全部发生在新 base 之后。
	for (let count = HISTORY_SEGMENT_LENGTH + 1; count <= HISTORY_SEGMENT_LENGTH * 2; count++) {
		recentAt = await commitWrites(
			storage,
			[
				{
					type: "document.change",
					id: historicalDocumentId,
					content: { kind: "delta", version: 1, ops: [["s", ["count"], count]] },
				},
			],
			BACKGROUND_CONTEXT,
		);
	}

	// 运行期检查 scale 至少产生一条条目；否则 firstEntryId 未定义，fork 无法挂载。
	if (firstEntryId === undefined) throw new Error("Benchmark scale must create entries");
	// fork 链的起点是根会话与它的第一条条目；每一层都把父指针推进到当前层最后一条条目。
	let parentConversationId = ROOT_CONVERSATION_ID;
	let parentAt = firstEntryId;
	let deepestConversationId = ROOT_CONVERSATION_ID;
	// 循环 FORK_DEPTH 次，每次创建一个子会话并写入 ENTRIES_PER_FORK 条条目。
	for (let depth = 0; depth < FORK_DEPTH; depth++) {
		// 子会话的 ID 仍来自全局命名空间。
		const conversationId = await storage.mintId<ConversationId>();
		// conversation.parent 指向父会话和父会话中的某条条目；at 是 fork 点。
		await commitWrites(
			storage,
			[
				{
					type: "conversation",
					value: { id: conversationId, parent: { conversationId: parentConversationId, at: parentAt } },
				},
			],
			BACKGROUND_CONTEXT,
		);
		// 一次性并发申请 32 个条目 ID；Promise.all 保持返回顺序与数组顺序一致，
		// 因此 ids[index] 与下面的 index 对应。
		const ids = await Promise.all(Array.from({ length: ENTRIES_PER_FORK }, () => storage.mintId<EntryId>()));
		// 32 条条目在同一个批次写入；kind 和 data 记录深度/序号，便于区分来源。
		await commitWrites(
			storage,
			ids.map((id, index) => ({
				type: "entry" as const,
				value: {
					id,
					conversationId,
					kind: "benchmark.fork",
					data: { depth, index },
				},
			})),
			BACKGROUND_CONTEXT,
		);
		// 下一层的父会话变成刚创建的子会话，fork 点变成这层最后一条条目。
		// deepestConversationId 每轮覆盖，循环结束后就是最深层会话。
		parentConversationId = conversationId;
		parentAt = ids.at(-1)!;
		deepestConversationId = conversationId;
	}

	// 运行期检查 documentCount 至少为 1；否则 exactDocumentId 未定义，读基准会拿错坐标。
	if (exactDocumentId === undefined) throw new Error("Benchmark scale must create documents");
	// 汇总返回。filteredTaskCount 的计算：同时满足 index % 4 == 0（kind）、index % 3 == 0
	// （pending）、index % 5 == 0（background）的下标是 60 的倍数；数量为 ceil(taskCount/60)，
	// 再与 50 取小，因为读场景最多返回 50 条。
	return {
		firstEntryId,
		filteredTaskCount: Math.min(50, Math.ceil(scale.taskCount / 60)),
		exactDocumentId,
		exactDocumentKey: `key-${scale.documentCount - 1}`,
		// Object.fromEntries 产生运行时字符串键；类型断言把它标成 Record<tail, DocumentId>，
		// 让场景里用数字 tail 索引时类型正确。
		replayDocumentIds: Object.fromEntries(replayEntries.map(({ tail, id }) => [tail, id])) as Record<
			(typeof REPLAY_TAILS)[number],
			DocumentId
		>,
		historicalDocumentId,
		ancientAt,
		recentAt,
		deepestConversationId,
		// 根会话第一条条目带 head，是最深层 fork 能看到的最新 head 标记（子层条目没有 head）。
		ancestorHeadEntryId: firstEntryId,
	};
}

// 一个读基准场景：run 执行读并返回一个可比较的数字/ID；expected 计算同一数据下的期望值。
// 两者都是纯函数式契约；基准脚本会先断言相等，再重复调用 run 计时。
export type StorageReadBenchmark = {
	readonly name: string;
	run(storage: Storage, dataset: StorageBenchmarkDataset): Promise<number>;
	expected(dataset: StorageBenchmarkDataset): number;
};

// 读场景覆盖：精确条目、条目分页、过滤任务、精确文档地址、四种重放尾巴、
// 跨 base 的新旧历史读、深 fork 的条目扫描和 head 标记查找。
export const STORAGE_READ_BENCHMARKS: readonly StorageReadBenchmark[] = [
	// 精确条目查找：直接按 ID 读，返回条目标识；-1 表示数据缺失。
	{
		name: "exact entry lookup",
		async run(storage, dataset) {
			return (await storage.entry(dataset.firstEntryId, BACKGROUND_CONTEXT))?.entry.id ?? -1;
		},
		expected: ({ firstEntryId }) => firstEntryId,
	},
	{
		// 条目分页扫描：从根会话最新条目往前取 100 条，返回实际条数。
		name: "entry page scan (100)",
		async run(storage) {
			return (
				await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 100, undefined, BACKGROUND_CONTEXT)
			).items.length;
		},
		expected: () => 100,
	},
	{
		// 过滤任务扫描：三个过滤条件同时命中，最多 50 条。
		// 期望值由 seed 的索引公式算出，而不是在基准里重新扫描。
		name: "filtered task scan (50)",
		async run(storage) {
			return (
				await storage.scanTasks(
					{ kind: "benchmark.filtered", status: "pending", background: true },
					50,
					undefined,
					BACKGROUND_CONTEXT,
				)
			).items.length;
		},
		expected: ({ filteredTaskCount }) => filteredTaskCount,
	},
	{
		// 精确文档地址：在大量 family 成员中按 kind+key+scope 定位。
		name: "exact document address among many",
		async run(storage, dataset) {
			return (
				(
					await storage.findDocument(
						{ kind: "benchmark.family", key: dataset.exactDocumentKey, scope: { kind: "session" } },
						"current",
						BACKGROUND_CONTEXT,
					)
				)?.id ?? -1
			);
		},
		expected: ({ exactDocumentId }) => exactDocumentId,
	},
	// 为每个回放尾巴生成一个场景；读取 current 时存储要重放对应数量的 delta。
	...REPLAY_TAILS.map(
		(tail): StorageReadBenchmark => ({
			name: `document replay tail (${tail})`,
			// Number(...) 把 JsonValue 形态的 count 转成数字；缺失时为 NaN，会让期望校验失败。
			async run(storage, dataset) {
				return Number(
					(await storage.document(dataset.replayDocumentIds[tail], "current", BACKGROUND_CONTEXT))?.value.count,
				);
			},
			expected: () => tail,
		}),
	),
	// 历史读 1：ancientAt 处的值在新 base 之前，应重放第一段 128 条 delta。
	{
		name: "ancient historical read before newer base",
		async run(storage, dataset) {
			return Number(
				(await storage.document(dataset.historicalDocumentId, dataset.ancientAt, BACKGROUND_CONTEXT))?.value.count,
			);
		},
		expected: () => HISTORY_SEGMENT_LENGTH,
	},
	{
		// 历史读 2：recentAt 处的新 base 之后，应在新 base 上再重放第二段 128 条 delta。
		name: "recent historical read after newer base",
		async run(storage, dataset) {
			return Number(
				(await storage.document(dataset.historicalDocumentId, dataset.recentAt, BACKGROUND_CONTEXT))?.value.count,
			);
		},
		expected: () => HISTORY_SEGMENT_LENGTH * 2,
	},
	{
		// 深 fork 条目扫描：每层最多 32 条，跨 8 层，limit=100 应取满。
		name: "fork-depth history scan (100)",
		async run(storage, dataset) {
			return (
				await storage.scanEntries(
					{ conversationId: dataset.deepestConversationId },
					100,
					undefined,
					BACKGROUND_CONTEXT,
				)
			).items.length;
		},
		expected: () => 100,
	},
	{
		// 深 fork 的 head 查找：子层条目没有 head，最新标记来自根会话第一条条目。
		name: "fork-depth head lookup",
		async run(storage, dataset) {
			return (
				(await storage.findLatestHeadMarker(dataset.deepestConversationId, undefined, BACKGROUND_CONTEXT))?.id ?? -1
			);
		},
		expected: ({ ancestorHeadEntryId }) => ancestorHeadEntryId,
	},
];

// 一个写基准场景：run 执行写入并返回写入条数；expected 是该返回值的固定期望。
// 写基准每次使用独立的、已 seedStorageWriteBenchmark 的存储，避免样本互相污染。
export type StorageWriteBenchmark = {
	readonly name: string;
	readonly expected: number;
	run(storage: Storage): Promise<number>;
};

// 写基准的前置状态：一个根会话加 100 条基线条目。
// 这里不返回坐标，因为写场景只关心提交成本；ID 顺序也不影响结果。
/** Seed the common state expected by every write benchmark sample. */
export async function seedStorageWriteBenchmark(storage: Storage): Promise<void> {
	// 先创建根会话，之后所有写入都引用它。
	await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT);
	// 100 条条目用 Promise.all 并发申请 ID 并构造写入，然后作为一个批次提交。
	// 并发 mintId 允许后端内部串行化；数组顺序由 Array.from 保证。
	await commitWrites(
		storage,
		await Promise.all(
			Array.from({ length: 100 }, async (_, index) => ({
				type: "entry" as const,
				value: {
					id: await storage.mintId<EntryId>(),
					conversationId: ROOT_CONVERSATION_ID,
					kind: "benchmark.baseline",
					data: { index },
				},
			})),
		),
		BACKGROUND_CONTEXT,
	);
}

// 写场景：单条条目、100 条条目、以及条目/任务/提交/文档混合批次。
// 混合场景验证不同表在一次 commit 中的组合成本。
export const STORAGE_WRITE_BENCHMARKS: readonly StorageWriteBenchmark[] = [
	{
		// 单条条目：mintId + 一次单批 commit；返回 1 供期望校验。
		name: "commit one entry",
		expected: 1,
		async run(storage) {
			const id = await storage.mintId<EntryId>();
			await commitWrites(
				storage,
				[
					{
						type: "entry",
						value: {
							id,
							conversationId: ROOT_CONVERSATION_ID,
							kind: "benchmark.write",
							data: { text: "x".repeat(128) },
						},
					},
				],
				BACKGROUND_CONTEXT,
			);
			return 1;
		},
	},
	{
		// 100 条条目：与 seedStorageWriteBenchmark 类似的批量构造，但每次样本都写新数据。
		name: "commit 100 entries",
		expected: 100,
		async run(storage) {
			const writes = await Promise.all(
				Array.from(
					{ length: 100 },
					async (_, index): Promise<StorageWrite> => ({
						type: "entry",
						value: {
							id: await storage.mintId<EntryId>(),
							conversationId: ROOT_CONVERSATION_ID,
							kind: "benchmark.write",
							data: { index, text: "x".repeat(128) },
						},
					}),
				),
			);
			await commitWrites(storage, writes, BACKGROUND_CONTEXT);
			return writes.length;
		},
	},
	{
		// 混合写入：每种类型各一条，共 4 条，验证跨表提交路径。
		name: "commit mixed entry/task/submission/document",
		expected: 4,
		async run(storage) {
			const entryId = await storage.mintId<EntryId>();
			const taskId = await storage.mintId<TaskId<JsonValue>>();
			const submissionId = await storage.mintId<SubmissionId>();
			const documentId = await storage.mintId<DocumentId>();
			const writes: readonly StorageWrite[] = [
				{
					type: "entry",
					value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: "benchmark.mixed" },
				},
				// 复用 task()；taskId 是品牌数字，作为 index 传入即可生成确定的状态。
				{ type: "task", value: task(taskId, taskId) },
				{
					// type: "write" 的提交不需要 entry 生命周期；状态直接 done，并引用同批的 entry。
					type: "submission",
					value: {
						id: submissionId,
						conversationId: ROOT_CONVERSATION_ID,
						requestId: `benchmark-${submissionId}`,
						type: "write",
						status: "done",
						entry: entryId,
					},
				},
				// 文档使用 session scope 的 family key；内容是前面 entry/task 的 ID，说明同批写入可互相引用。
				{
					type: "document.create",
					record: { id: documentId, kind: "benchmark.mixed", key: String(documentId), scope: { kind: "session" } },
					content: { kind: "base", version: 1, value: { entryId, taskId } },
				},
			];
			await commitWrites(storage, writes, BACKGROUND_CONTEXT);
			return writes.length;
		},
	},
];
