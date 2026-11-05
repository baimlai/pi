// Tests of the archive part schema (slice 6a §13, rule 25): every part an export yields passes; a part with an
// unknown kind, a missing or extra field or a value of another type is refused, naming its position.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { checkPart } from "../../src/store/archive.ts";
import { archiveStore, exported } from "../support.ts";

// 此组检查归档单个 part 的运行时形状；跨 part 顺序、计数一致性由 import 测试另行覆盖。
describe("the archive part schema", () => {
	// 无业务输入；构造含表、迁移中状态和文档的内存 SQLite，再检查每个导出片段。
	// 例如合法 end 片段通过后仍返回原对象；Promise<void> 完成表示断言和关闭都已完成。
	it("takes every part an export yields", async () => {
		// archiveStore 会填入固定测试数据，包含两张表与文档修订；不会连接外部服务。
		const store = await archiveStore();
		// exported 消费异步导出迭代器，收集 manifest、各写入和 end。
		const parts = await exported(store);
		// entries() 给出从 0 起的位置和原片段；toBe 要求对象引用相同，证明检查没有复制。
		for (const [position, part] of parts.entries()) expect(checkPart(part, position, context)).toBe(part);
		// 关闭测试数据库；BACKGROUND_CONTEXT 不提供主动取消信号。
		await store.close(context);
	});

	// it.each 的类型参数规定每行是 [说明文字, 未知输入]；unknown 要求运行时校验后才能信任。
	// 每行调用同一测试函数，例如 {kind:"end"} 缺少 writes；函数返回 void，预期同步抛错。
	it.each<[string, unknown]>([
		// 这些值故意不声明为 ArchivePart，因此能模拟导入边界收到的错误外部数据。
		["an unknown kind", { kind: "blob" }],
		["a missing field", { kind: "end" }],
		["an extra field", { kind: "end", writes: 0, more: 1 }],
		["a negative count", { kind: "end", writes: -1 }],
		[
			"a column of an unknown type",
			{
				kind: "table",
				table: "a:b:c",
				version: 1,
				state: "ready",
				columns: { a: { type: "date" } },
				key: ["a"],
				fingerprint: "f",
			},
		],
		["a put at version 0", { kind: "put", table: "a:b:c", row: {}, version: 0, columns: {} }],
		[
			"a record without an id",
			{ kind: "document.create", record: { namespace: "n" }, base: { version: 1, fingerprint: "f", value: {} } },
		],
	])("refuses %s", (_, part) => {
		// _ 不使用说明参数；固定位置 4 用来检查错误是否保留定位信息，非真实文件行号。
		expect(() => checkPart(part, 4, context)).toThrow("import: part 4: not an archive part");
	});
});
