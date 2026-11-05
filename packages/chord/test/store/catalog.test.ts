// The catalog (slice 6a §8): the store's records of its tables, read once at open, changed after COMMIT returned.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { int, str } from "../../src/contracts/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { sqliteBackend } from "../../src/store/backend.ts";
import type { StagedWrite } from "../../src/store/step.ts";
import { type ChordStore, openStore } from "../../src/store/store.ts";
import { defineTable } from "../../src/store/table.ts";
import { stageTable } from "../../src/store/table-writes.ts";
import { memoryStore, tableIn } from "../support.ts";

// 此表定义用于两个测试：字符串主键 id、整数 at，by_at 是声明索引，不会在这一行建数据库表。
const Edits = defineTable("edits", {
	version: 1,
	columns: { id: str(), at: int() },
	key: ["id"],
	indexes: { by_at: ["at"] },
});
// 真实 SQL 名是 owner:table；这次 owner 固定为 app.store，不含 host kind。
const TABLE = "app.store:edits";

// catalog 指 store 内存里保存的表定义目录，而非表中业务行。
describe("the catalog", () => {
	// 在临时文件建表、关闭并重开，核对结构元数据恢复；Promise 完成前清理该临时目录。
	// 例子中的 by_at 索引应在新 store 对象里仍可查到；此例不统计实际读取次数。
	it("is read once at open: a reopened store knows its tables", async () => {
		// mkdtemp 在系统临时目录下建立唯一目录，避免多个测试共用同一数据库文件。
		const directory = await mkdtemp(join(tmpdir(), "chord-catalog-"));
		// join 按系统路径规则拼接本测试的 SQLite 文件名。
		const path = join(directory, "store.sqlite");
		// 从数据库到 backend 再到 store 分层打开；as ChordStore 只暴露测试所需内部 table() 接口。
		const first = (await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context)) as ChordStore;
		// 创建声明的表与索引并等待提交，确保关闭前结构已持久化。
		await tableIn(first, Edits);
		// 关闭第一实例，随后打开同一文件，排除直接复用原内存目录的情况。
		await first.close(context);
		// 用新的连接/对象重开该文件，openStore 会读取已存表目录。
		const second = (await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context)) as ChordStore;
		// 比较名称、版本、ready 状态、列、主键、指纹与索引；此断言检查完整记录内容。
		expect(second.table(TABLE)).toEqual({
			table: TABLE,
			version: 1,
			state: "ready",
			columns: Edits.record,
			key: ["id"],
			fingerprint: Edits.fingerprint,
			indexes: { by_at: ["at"] },
		});
		// 先关连接，避免删除仍打开的文件。
		await second.close(context);
		// recursive 删除本测试创建的目录内容；force 允许目标已不存在，不影响其他目录。
		await rm(directory, { recursive: true, force: true });
	});

	// 把建表和故障写入放同一 commit，验证失败事务没有提前修改内存 catalog。
	// 例如 SQL 访问不存在的表时 commit 拒绝，app.store:edits 仍不应出现在内存目录。
	it("changes in memory only after COMMIT returned", async () => {
		// memoryStore 使用 SQLite :memory:，不是自制 JS 内存 backend。
		const store = await memoryStore();
		// 对象解构把 record 重命名为 columns，供后面构造 table write。
		const { version, record: columns, key, fingerprint } = Edits;
		// StagedWrite 在执行步骤中返回记录的 StoreWrite[]；此测试对象只用于注入 SQL 错误。
		const failing: StagedWrite = {
			// order 决定暂存写入在 commit 中的次序；这里不是释放旧文档地址的 retire 类写入。
			order: "write",
			// apply 收到事务步骤并返回 Promise；run 失败会让它拒绝，后面的 then 不会运行。
			apply: (step) =>
				step
					// 实际失败点：SQLite 找不到表，整步应该回滚。
					.run("INSERT INTO no_such_table VALUES (1)")
					// 若 SQL 成功会返回一条虚构记录，但此路径预期不可达；不是已经执行了 DROP INDEX。
					.then(() => [{ kind: "dropIndex", table: TABLE, name: "x" }]),
		};
		// 把表定义转成暂存写入，此刻不向内存目录发布。
		const table = stageTable({ kind: "table", table: TABLE, version, state: "ready", columns, key, fingerprint });
		// admit 始终允许入队，adopt 为空回调；rejects 等待 Promise 失败后匹配消息。
		await expect(store.commit([table, failing], { admit: () => true, adopt: () => {} }, context)).rejects.toThrow(
			"no such table",
		);
		// 提交失败后查目录，必须为 undefined，证明表没有提前可见。
		expect(store.table(TABLE)).toBeUndefined();
		// 测试结束关闭 store；没有在这里断言后续新 commit 能否成功。
		await store.close(context);
	});
});
