import { describe, expect, it } from "vitest";
import { CodemodeJournalDoc, CodemodeRunDoc, CodemodeStoreDoc } from "../src/codemode/codemode.ts";
import { NestedCallDoc } from "../src/harness/tool.ts";
import { context, createConversation, openTestSession } from "./session-support.ts";

// 把内建文档的压缩策略放在同一组：checkpoint 是把增量合成完整 base，非任务阶段检查点。
describe("built-in document checkpoint policies", () => {
	// 直接调用三种 task 文档的策略，输入已有 1000 次增量，返回值应仍为 false。
	// 此同步测试只证明策略选择，不实际创建任务、存储或回收文档。
	it("keeps task-scoped documents as deltas until their task retires", () => {
		// 人为构造高计数，确认策略不因增量很多就改写完整基值。
		const info = { deltasSinceBase: 1000 };
		// 嵌套调用状态随任务退休，不触发这类 base 压缩。
		expect(NestedCallDoc.definition.checkpointWhen({}, [], info)).toBe(false);
		// Code Mode 单次运行文档采用同样的固定 false 策略。
		expect(CodemodeRunDoc.definition.checkpointWhen({}, [], info)).toBe(false);
		// 日志文档带最小合法 entries 数组，也不压缩。
		expect(CodemodeJournalDoc.definition.checkpointWhen({ entries: [] }, [], info)).toBe(false);
	});

	// 在内存会话中递增 counter，验证达到阈值后新 base 仍支持旧时点与分叉。
	// 例如第 32 条记录处应读到 32，即使当前已为 65；回调异步无返回值，失败经 finally 关闭会话。
	it("checkpoints the codemode store after 64 deltas without changing historical reads or forks", async () => {
		// 使用可记录原始写入的 ControlledStorage 与 SessionImpl，不接入模型。
		const { session, storage } = openTestSession();
		// 将后续断言包在 try/finally，保证异常时也释放会话。
		try {
			// 先提交一个无主对话，后续文档与记录均归它。
			const conversationId = await createConversation(session);
			// 初始化 counter=0 并追加标记记录，返回记录 ID 作为历史定位点。
			let cutoff = await session.commit(async (tx) => {
				// 取得事务可变文档，修改值由提交机制追踪为文档变化。
				(await tx.doc(CodemodeStoreDoc, conversationId)).values.counter = 0;
				// 追加 test.counter 记录；await 后提取其 id 作为事务结果。
				return (await tx.appendEntry(conversationId, { kind: "test.counter" })).id;
			}, context);
			// 按逻辑地址找到物理文档记录，用于后面直接检查存储的 base/delta。
			const record = await storage.findDocument(
				// 地址由文档种类与对话作用域构成。
				{ kind: CodemodeStoreDoc.definition.kind, scope: { kind: "conversation", conversationId } },
				// current 表示查询当前版本，而非历史时点。
				"current",
				context,
			);
			// 明确报出夹具未创建成功；这也把后续 record 缩窄为存在的类型。
			if (record === undefined) throw new Error("Expected codemode store");
			// 提交 64 次独立修改，循环值 1..64，测试阈值是在新修改之前检查旧计数。
			for (let counter = 1; counter <= 64; counter++) {
				// 每次事务改值并加记录，ID 可作时间标记。
				const entry = await session.commit(async (tx) => {
					// 把本轮数字写入追踪中的 values.counter。
					(await tx.doc(CodemodeStoreDoc, conversationId)).values.counter = counter;
					// 返回本轮记录 ID，而不是 counter 本身。
					return (await tx.appendEntry(conversationId, { kind: "test.counter" })).id;
				}, context);
				// 保存第 32 次修改的定位点，后续修改不再改变 cutoff。
				if (counter === 32) cutoff = entry;
			}
			// 确认此时仍有 64 次增量，尚未转为新 base。
			expect((await storage.document(record.id, "current", context))?.deltasSinceBase).toBe(64);
			// 再提交 counter=65；策略看到已有 64 个 delta，故这次存为 base。
			await session.commit(async (tx) => {
				// 在同一逻辑文档上更新值，存储策略决定实际写入格式。
				(await tx.doc(CodemodeStoreDoc, conversationId)).values.counter = 65;
			}, context);
			// 新 base 写入后增量计数归零。
			expect((await storage.document(record.id, "current", context))?.deltasSinceBase).toBe(0);
			// 检查最后一次写入确为版本 1 的完整 base，内容是 counter=65。
			expect(storage.commits.at(-1)).toContainEqual({
				type: "document.change",
				id: record.id,
				content: { kind: "base", version: 1, value: { values: { counter: 65 } } },
			});
			// 按第 32 条记录读历史快照，应仍得到旧值 32。
			// 新分叉当前值也应是 32，而不是源对话的 65。
			expect(await session.snapshotAsOf(CodemodeStoreDoc, conversationId, cutoff, context)).toEqual({
				values: { counter: 32 },
			});
			// 在 cutoff 处分叉出无主对话；文档定义 fork=asOf，使用那个时点的值。
			const fork = await session.commit(
				// 事务回调创建分叉，不执行生成或模型请求。
				(tx) => tx.forkConversation(conversationId, cutoff, { ownership: { kind: "ownerless" } }),
				context,
			);
			expect(await session.snapshot(CodemodeStoreDoc, fork.id, context)).toEqual({ values: { counter: 32 } });
			// 继续把源值改到 66，检查新 base 之后可以正常再记增量。
			await session.commit(async (tx) => {
				(await tx.doc(CodemodeStoreDoc, conversationId)).values.counter = 66;
			}, context);
			// 这次只新增一个 delta，未再次压缩。
			expect((await storage.document(record.id, "current", context))?.deltasSinceBase).toBe(1);
		} finally {
			// 无论断言通过或抛错都关闭会话。
			await session.close(context);
		}
	});
});
