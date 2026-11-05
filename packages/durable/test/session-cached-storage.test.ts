// 用计数内存后端检查发布时更新缓存、重叠读防陈旧值，以及活任务和等待结果的保留策略。
import type { JsonValue } from "@earendil-works/chord/json";
import { describe, expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import { CachedStorage } from "../src/session/cached-storage.ts";
import { MemoryStorage } from "../src/storage/memory.ts";
import { commitWrites } from "../src/testing/commit-writes.ts";
import type { ConversationId, StorageWrite, TaskId, TaskRecord } from "../src/types.ts";
import { context } from "./session-support.ts";

// 由数字 ID 和可选状态建立任务夹具；默认 pending，返回记录，不写入存储或运行任务。
// TaskRecord 的三个泛型位置分别是输入、检查点和结果类型；这里允许任意 JsonValue。
// 例如 task(2, "running") 是会话 1 中版本 1 的运行中测试任务，不是实际调度器调用。
function task(id: number, status: "pending" | "running" = "pending"): TaskRecord<JsonValue, JsonValue, JsonValue> {
	return {
		// idFromNumber 只加类型品牌；TaskId<JsonValue> 还在类型上记住结果为 JSON。
		id: idFromNumber<TaskId<JsonValue>>(id),
		conversationId: idFromNumber<ConversationId>(1),
		// kind/version 标识任务定义；本文件只读写记录，不注册或执行对应定义。
		kind: "test.task",
		version: 1,
		// null 是合法 JSON 输入；前台任务且没有取消意图。
		input: null,
		background: false,
		abortRequested: false,
		// 对象属性简写 status 使用参数；checkpoint 给出恢复阶段。
		state: { status, checkpoint: { phase: "run" } },
	};
}

// 继承真实内存存储，只统计穿过缓存的 task 调用；计数不等于数据库 I/O 次数。
class CountingStorage extends MemoryStorage {
	taskReads = 0;
	// Parameters<...> 提取父方法参数元组；...args 收集并原样转发，返回父方法的 Promise。
	// 每次调用累加次数；父类的关闭/读取错误仍会正常传播，例如两次未命中得到计数 2。
	override task(...args: Parameters<MemoryStorage["task"]>) {
		this.taskReads++;
		return super.task(...args);
	}
}

/** Stores `writes` as one batch, then publishes it, as the Session does. */
// 接收缓存和一批写入，先等待后端提交，再明确通知发布；成功无返回值。
// commitWrites 若拒绝，就不会执行 published；例如写入 task(2) 发布后才能从热缓存直接取得。
async function commit(storage: CachedStorage, writes: StorageWrite[]): Promise<void> {
	// commitWrites 将数组包装为单批，取得回执；发布与“后端已经存好”是两个步骤。
	await commitWrites(storage, writes, context);
	storage.published(writes);
}

// 注册七个纯内存用例；expect 的失败会使对应同步或异步回调失败。
describe("cached storage", () => {
	// 发布 pending 后读取，再发布 running 后读取；两次都应从缓存取得，无需后端 task 查询。
	it("serves a written record without a read and follows later writes", async () => {
		// backend 用来观察是否漏到后端；storage 是围绕它的实际缓存包装器。
		const backend = new CountingStorage();
		const storage = new CachedStorage(backend);
		// 先建立根会话，再写入任务；每次辅助 commit 都包含发布。
		await commit(storage, [{ type: "conversation", value: { id: idFromNumber<ConversationId>(1) } }]);
		await commit(storage, [{ type: "task", value: task(2) }]);
		// await 取得记录，?. 在找不到时产生 undefined，让断言明确失败。
		expect((await storage.task(idFromNumber<TaskId>(2), context))?.state.status).toBe("pending");
		await commit(storage, [{ type: "task", value: task(2, "running") }]);
		expect((await storage.task(idFromNumber<TaskId>(2), context))?.state.status).toBe("running");
		// 返回值正确还不够：计数 0 同时证明没有依靠后端重新读取。
		expect(backend.taskReads).toBe(0);
	});

	// 冷缓存读与更新并行启动，发布后必须保持新 running 记录，而非被先前读取的 pending 覆盖。
	it("keeps a read only when no commit overlapped it", async () => {
		const backend = new CountingStorage();
		// 直接在 backend 建立数据，因此稍后创建的缓存尚不知道任务 2。
		await commitWrites(
			backend,
			[
				{ type: "conversation", value: { id: idFromNumber<ConversationId>(1) } },
				{ type: "task", value: task(2) },
			],
			context,
		);
		const storage = new CachedStorage(backend);
		// 不立即 await，保留读 Promise，让写入在它完成的微任务之前启动。
		const overlapped = storage.task(idFromNumber<TaskId>(2), context);
		const written = commit(storage, [{ type: "task", value: task(2, "running") }]);
		// Promise.all 等待两者；不要求 overlapped 自身返回新状态，只要求缓存最终不陈旧。
		await Promise.all([overlapped, written]);
		expect((await storage.task(idFromNumber<TaskId>(2), context))?.state.status).toBe("running");
		// 再读一次仍应命中发布值，总后端读数只为最初的一次冷读。
		await storage.task(idFromNumber<TaskId>(2), context);
		expect(backend.taskReads).toBe(1);
	});

	// 598 个活任务超过终态表容量：活任务全保留，结束后只留下 256 个终态记录。
	it("keeps a bounded number of ended tasks, and every live one until it ends", async () => {
		const backend = new CountingStorage();
		const storage = new CachedStorage(backend);
		await commit(storage, [{ type: "conversation", value: { id: idFromNumber<ConversationId>(1) } }]);
		// 顺序 await 每次提交/发布，避免把容量行为和并发竞态混在一起。
		for (let id = 2; id < 600; id++) await commit(storage, [{ type: "task", value: task(id) }]);
		// More live tasks than the ended table holds: each one's next change finds it without a read.
		// toMatchObject 只检查列出的计数字段，不要求 sizes 没有其他字段。
		expect(storage.sizes).toMatchObject({ tasks: 0, liveTasks: 598 });
		// 读取全部活任务；下一行的后端计数证明它们未被普通容量淘汰。
		for (let id = 2; id < 600; id++) await storage.task(idFromNumber<TaskId>(id), context);
		expect(backend.taskReads).toBe(0);
		// 同一组任务依次转换成 terminal/completed；没有实际执行任务阶段。
		for (let id = 2; id < 600; id++) {
			// 对象展开沿用身份等字段，只换 state；as 恢复字面量被推宽后的 TaskRecord 类型，不做校验。
			const ended = { ...task(id), state: { status: "terminal", outcome: { status: "completed", result: null } } };
			await commit(storage, [{ type: "task", value: ended as TaskRecord<JsonValue, JsonValue, JsonValue> }]);
		}
		// 这里只核对条目计数，不测量堆字节数或逐条验证淘汰顺序。
		expect(storage.sizes).toMatchObject({ tasks: 256, liveTasks: 0 });
	});

	// 分离 commit 和 published：后端回执已来，缓存仍显示上次发布值，发布后才更新。
	it("applies a batch stored with commit when it is published, not at its receipt", async () => {
		const backend = new CountingStorage();
		const storage = new CachedStorage(backend);
		await commit(storage, [
			{ type: "conversation", value: { id: idFromNumber<ConversationId>(1) } },
			{ type: "task", value: task(2) },
		]);
		// 这批 running 写入故意不用辅助 commit，避免自动发布。
		const batch: StorageWrite[] = [{ type: "task", value: task(2, "running") }];
		const receipts: number[] = [];
		// 接收索引 0 的持久化回执，stored:1 只表示后端存好这一批。
		expect(await storage.commit([batch], (index) => receipts.push(index), context)).toEqual({ stored: 1 });
		expect(receipts).toEqual([0]);
		// Stored, not yet published: the cache still shows what was published.
		expect((await storage.task(idFromNumber<TaskId>(2), context))?.state.status).toBe("pending");
		// 显式发布才替换缓存内的 pending；之后同样不回读后端。
		storage.published(batch);
		expect((await storage.task(idFromNumber<TaskId>(2), context))?.state.status).toBe("running");
		expect(backend.taskReads).toBe(0);
	});

	// 同时读两个冷任务，仅任务 2 被发布更新；读取版本只在未完成读存在时保留。
	it("drops a read a publication of its record overlapped, and keeps versions only for reads in flight", async () => {
		const backend = new CountingStorage();
		await commitWrites(
			backend,
			[
				{ type: "conversation", value: { id: idFromNumber<ConversationId>(1) } },
				{ type: "task", value: task(2) },
				{ type: "task", value: task(3) },
			],
			context,
		);
		const storage = new CachedStorage(backend);
		// 两个调用先启动而不等待，才能在 Promise 完成前观察 readsInFlight。
		const overlapped = storage.task(idFromNumber<TaskId>(2), context);
		const untouched = storage.task(idFromNumber<TaskId>(3), context);
		expect(storage.readsInFlight).toBe(2);
		// A publication of another record does not drop the read of task 3.
		// 此用例直接模拟发布，没有把 running 更新提交到后端；只测试缓存竞态规则。
		storage.published([{ type: "task", value: task(2, "running") }]);
		await Promise.all([overlapped, untouched]);
		// 等待读完后版本表应清空；任务 2 保持发布值，任务 3 的旧读结果可以保留。
		expect(storage.readsInFlight).toBe(0);
		expect((await storage.task(idFromNumber<TaskId>(2), context))?.state.status).toBe("running");
		expect((await storage.task(idFromNumber<TaskId>(3), context))?.state.status).toBe("pending");
		expect(backend.taskReads).toBe(2);
	});

	// 等待者恢复后的第一个阶段仍要读结果，因此被等待的终态任务跨一次状态变化继续保留。
	// 任务 2 等待 3、4；其他终态任务挤满普通缓存后，3、4 仍无需后端查询；下一变化才释放。
	it("keeps the ended tasks a task waits on until it moved on from its wait", async () => {
		const backend = new CountingStorage();
		const storage = new CachedStorage(backend);
		await commit(storage, [{ type: "conversation", value: { id: idFromNumber<ConversationId>(1) } }]);
		// 构造完成任务，结果设为自身数字 ID；只生成对象，as 不是运行时 schema 校验。
		const ended = (id: number) =>
			({
				...task(id),
				state: { status: "terminal", outcome: { status: "completed", result: id } },
			}) as TaskRecord<JsonValue, JsonValue, JsonValue>;
		// 索引访问类型 ["state"] 取任务状态联合类型；用它替换任务 2 的 state，名称不限定总是 waiting。
		const waiting = (state: TaskRecord<JsonValue, JsonValue, JsonValue>["state"]) =>
			({ ...task(2), state }) as TaskRecord<JsonValue, JsonValue, JsonValue>;
		// map 给被等待的两个数字加任务 ID 品牌，供 waiting 状态的 on 使用。
		const on = [3, 4].map((id) => idFromNumber<TaskId>(id));
		await commit(storage, [
			{
				type: "task",
				value: waiting({ status: "waiting", checkpoint: { phase: "read" }, on, policy: "allSettled" }),
			},
		]);
		// 先发布等待记录，再将两个目标完成；缓存跟踪等待关系并保留它们的结果。
		await commit(storage, [
			{ type: "task", value: ended(3) },
			{ type: "task", value: ended(4) },
		]);
		// A burst of other ended tasks fills the bounded table.
		// 290 个无关终态任务足以超过普通 256 项容量，迫使测试依赖专门的等待保留机制。
		for (let id = 10; id < 300; id++) await commit(storage, [{ type: "task", value: ended(id) }]);
		expect(storage.sizes).toMatchObject({ awaited: 2, waits: 1 });
		// Resumed: still held for the phase that reads the outcomes.
		await commit(storage, [{ type: "task", value: waiting({ status: "running", checkpoint: { phase: "read" } }) }]);
		// 逐个读取等待目标，确认仍是终态；后端读数 0 证明结果由保留区提供。
		for (const id of on) expect((await storage.task(id, context))?.state.status).toBe("terminal");
		expect(backend.taskReads).toBe(0);
		expect(storage.sizes).toMatchObject({ awaited: 2, waits: 1 });
		// Its next change ends the hold: the records go back to the bounded table, and no wait is left.
		// 第二次变化进入 next 阶段，之前等待记录及其结果保留计数都应释放。
		await commit(storage, [{ type: "task", value: waiting({ status: "running", checkpoint: { phase: "next" } }) }]);
		expect(storage.sizes).toMatchObject({ awaited: 0, waits: 0, tasks: 256 });
		// A wait that ends with its task leaves nothing either.
		await commit(storage, [
			{
				type: "task",
				value: waiting({ status: "waiting", checkpoint: { phase: "read" }, on, policy: "allSettled" }),
			},
		]);
		expect(storage.sizes).toMatchObject({ awaited: 2, waits: 1 });
		// 再次等待后直接结束等待者，也必须释放，不能留下永久引用。
		await commit(storage, [{ type: "task", value: ended(2) }]);
		expect(storage.sizes).toMatchObject({ awaited: 0, waits: 0 });
	});

	// 直接发布的记录原位冻结并共享；toBe 比较引用身份，区别于内容相等的复制品。
	it("keeps the written record itself, frozen: no copy", async () => {
		const storage = new CachedStorage(new MemoryStorage());
		// 保留原始引用用于身份断言；这里不提交到 MemoryStorage，专门测试 published。
		const conversation = { id: idFromNumber<ConversationId>(1) };
		const record = task(2);
		storage.published([
			{ type: "conversation", value: conversation },
			{ type: "task", value: record },
		]);
		expect(await storage.task(idFromNumber<TaskId>(2), context)).toBe(record);
		expect(await storage.conversation(idFromNumber<ConversationId>(1), context)).toBe(conversation);
		// 检查 state 这个嵌套对象被冻结；readonly 类型本身不会做到运行时冻结。
		expect(Object.isFrozen(record.state)).toBe(true);
	});
});
