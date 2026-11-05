// 检查内存存储的公共契约、预备提交隔离，以及中途应用失败后仍有效的前缀回执。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { idFromNumber, seqFromNumber } from "../src/ids.ts";
import { MemoryStorage } from "../src/storage/memory.ts";
import { commitWrites } from "../src/testing/commit-writes.ts";
import { type EntryId, ROOT_CONVERSATION_ID, type Seq, type StorageWrite } from "../src/types.ts";

// 将 Vitest 接口交给公共契约套件；每例由 use 获取新的内存实例，返回它的 Promise 供框架等待。
registerStorageConformance({ describe, expect, it }, "MemoryStorage", (use) => use(new MemoryStorage()));

// 建立根会话，预备一个含 nested:[1] 的条目：修改公开预备值必须抛错，两次 apply 只应用一次。
// 无输入和外部服务；断言失败由 Vitest 报告。这个例子同时检查深层数组不能通过预备写入被篡改。
it("does not expose retained state through a prepared commit", async () => {
	// 创建独立存储，提交根会话消耗序号 1；BACKGROUND_CONTEXT 提供调用上下文。
	const storage = new MemoryStorage();
	await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT);
	// <EntryId> 加静态品牌，运行时仍是数字 2，不校验 ID 是否存在。
	const entryId = idFromNumber<EntryId>(2);
	// 准备阶段校验、复制并冻结写入；没有调用 apply 前尚未写入可观察状态。
	const prepared = storage.prepareCommit([
		{
			// type 判别字段指定 entry 分支；value 给出 ID、所属会话、应用类别和 JSON 数据。
			type: "entry",
			value: {
				id: entryId,
				conversationId: ROOT_CONVERSATION_ID,
				kind: "test",
				data: { nested: [1] },
			},
		},
	]);
	// 从预备结果取回第一条写入，模拟调用方试图改动其中数据。
	const exposed = prepared.writes[0];
	// 判别检查缩窄联合类型；测试夹具若不再是 entry，立即给出明确错误。
	if (exposed.type !== "entry") throw new Error("Expected an entry write");
	// as 只是静态形状断言，push 是真实数组修改；冻结使它在运行时抛错。
	expect(() => (exposed.value.data as { nested: number[] }).nested.push(2)).toThrow();

	// 根之后的提交是序号 2；重复 apply 返回同一序号，不再写入第二次。
	expect(prepared.apply()).toBe(seqFromNumber(2));
	expect(prepared.apply()).toBe(seqFromNumber(2));
	// ?. 允许缺失时产生 undefined；内容比较证明失败修改未污染存储。
	expect((await storage.entry(entryId, BACKGROUND_CONTEXT))?.entry.data).toEqual({ nested: [1] });
});

// 注入第二批 apply 失败，验证第一批回执仍被发送且第一批数据保留，最终 Promise 拒绝同一个错误。
// 例如根序号为 1 时，本应提交序号 2、3；3 失败后只存在序号 2 的条目，不涉及真实磁盘故障。
it("delivers the receipts of the batches applied before one whose apply throws, then rejects", async () => {
	// 保存错误对象，让后续 toBe 检查身份而非仅检查错误文字。
	const failure = new Error("apply failed");
	// extends 继承真实存储；测试子类只替换指定序号的 apply，其他路径使用父类实现。
	class FailingApply extends MemoryStorage {
		// 联合类型表示故障点尚未设定或已指定一个序号。
		failAt: Seq | undefined;
		// override 由 TS 检查重写关系；readonly 约束参数数组的写法，seq? 表示可省略。
		// 输入同父类，先准备真实写入，再覆盖故障点；这里准备成功不等于 apply 成功。
		override prepareCommit(writes: readonly StorageWrite[], seq?: Seq) {
			const prepared = super.prepareCommit(writes, seq);
			// 非故障点原样返回父类准备结果。
			if (prepared.seq !== this.failAt) return prepared;
			// 对象展开保留 seq/writes，只覆盖 apply，不会调用原 apply。
			return {
				...prepared,
				// 声明 Seq 返回类型不妨碍直接抛错；此路径永不成功返回。
				apply: (): Seq => {
					throw failure;
				},
			};
		}
	}
	// 根会话通过同一真实提交机制建立，获取基准序号。
	const storage = new FailingApply();
	const root = await commitWrites(
		storage,
		[{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }],
		BACKGROUND_CONTEXT,
	);
	// 解构两个新候选 ID；分配并不意味着条目已经写入。
	const [first, second] = [await storage.mintId<EntryId>(), await storage.mintId<EntryId>()];
	// 第二个待提交批次故障；算术后用 seqFromNumber 恢复品牌类型。
	storage.failAt = seqFromNumber(root + 2);
	// 元组数组保存 [批次索引, 提交序号]，每次回执追加一项。
	const receipts: [number, Seq][] = [];
	// await 等待拒绝断言完成；expect 接收的是实际提交返回的 Promise。
	await expect(
		storage.commit(
			// map 为每个 ID 构造一个独立批次，因此第一批可保留，不是单批原子回滚。
			[first, second].map((id) => [
				{ type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "m" } },
			]),
			// 同步收集 commit 在 finally 路径发送的已应用前缀回执。
			(index, seq) => receipts.push([index, seq]),
			BACKGROUND_CONTEXT,
		),
	).rejects.toBe(failure);
	// 故障不撤销第一批：回执与读回序号都确认第一条，第二条不存在。
	expect(receipts).toEqual([[0, root + 1]]);
	expect((await storage.entry(first, BACKGROUND_CONTEXT))?.commitSeq).toBe(root + 1);
	expect(await storage.entry(second, BACKGROUND_CONTEXT)).toBeUndefined();
});
