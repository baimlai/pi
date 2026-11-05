// 文件导读
// 所属：packages/chord/test/examples，Chord v2 示例 22，对应 slice 6a（store 表与版本迁移）。
// 演示内容：defineTable 声明表 v1；evolveTable 以链式编辑追加 v2、v3。数据步骤前的编辑是 rename/add/json，
// 数据步骤之后的编辑是 drop/index/dropIndex。对象激活时，store 里的旧版本会逐版本迁移，每批 100 行；
// 全新的 store 直接建最新版本。
// 上游入口：命令行直接运行；自建临时目录与 SQLite 文件，不依赖外部服务。
// 下游调用：defineTable/evolveTable/query（store 层）、openStore/sqliteBackend、createHost/defineFacet、local/method。
// 写入 <tmp>/chord-example-*/history.db；运行结束删除。
// 失败行为：任何 await 拒绝都会终止脚本并非零退出；迁移在 host.load 期间完成，失败会让 load 报告失败项。
// 能力清单（按演示机制列出，本文件没有导出）：
// - EditsV1：基准版本 v1，列 id/file/at，主键 id。
// - EditsV2：rename(file→path)、add(dir, default "")，再用 rows 数据步骤为每行计算 dir。
// - EditsV3：drop(dir)、index(by_path on path+at)。
// - History 契约：record 写入一行；dump 返回所有行 JSON 字符串的数组。
// - facetOf()：按“某个部署声明的最新表版本 + 写行函数”生成 facet。
// - deployment()：在指定数据库文件上开 host、load（触发迁移）、执行 work、关闭。
// - 主流程：v1 写入 3 行并打印；同一文件上的下一个部署声明 v3，激活时经历 v1→v2→v3，再写第 4 行并打印。
// 典型运行顺序：定义 v1 → evolve 出 v2/v3 → 定义契约与 facet 工厂 → 第一次部署写入 → 第二次部署迁移并写入。
// 示例（真实签名）：
//   const EditsV2 = evolveTable(EditsV1, (t) => t.rename("file", "path").add("dir", str({ default: "" }))
//     .rows((row) => ({ dir: row.path.slice(0, row.path.lastIndexOf("/")) })));
// 阅读顺序：先看三个版本定义与编辑顺序，再看 facetOf 如何用版本写行/读行，最后看两次部署与输出。
// 前置条件：Node 支持 --experimental-strip-types 与 node:sqlite。在 packages/chord 下运行：
//   node --conditions=source --experimental-strip-types test/examples/22-migrations.ts
// 预期输出（已实际运行核对；默认按主键升序，字段顺序即列声明顺序；Node 会按宽度换行打印数组）：
//   version 1: [
//     '{"id":"e0","file":"src/e0.ts","at":0}',
//     '{"id":"e1","file":"src/e1.ts","at":1}',
//     '{"id":"e2","file":"src/e2.ts","at":2}'
//   ]
//   version 3: [
//     '{"id":"e0","path":"src/e0.ts","at":0}',
//     '{"id":"e1","path":"src/e1.ts","at":1}',
//     '{"id":"e2","path":"src/e2.ts","at":2}',
//     '{"id":"e9","path":"lib/e9.ts","at":9}'
//   ]
// 相关文档：packages/chord/docs/slice-6a.md（§8 表演进、§9 json 单元格）；相关测试：test/store/ 下的迁移用例。
// Table migrations: `evolveTable` appends a version with its edits (rename, add, json before an optional data step;
// drop, index, dropIndex after it). An object whose store holds an older version migrates it when it activates, one
// version at a time, in chunks of 100 rows; a fresh store gets the newest version directly.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/22-migrations.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { arr, int, local, method, obj, str } from "../../src/contracts/index.ts";
import { createHost, defineFacet, type Reference } from "../../src/host/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import {
	defineTable,
	evolveTable,
	openStore,
	query,
	sqliteBackend,
	type TableDefinition,
} from "../../src/store/index.ts";

// 后台上下文：没有取消信号；本例所有 store/host 操作共享它。
const context = BACKGROUND_CONTEXT;

// Version 1, the base, written in full.
// defineTable 声明基准版本：列 schema 按声明顺序物化，key 指定主键列。
// 泛型 const K 把 ["id"] 保留为元组字面量，于是行键类型精确到列名；运行期还检查版本为正整数、主键列存在且非 opt。
const EditsV1 = defineTable("edits", { version: 1, columns: { id: str(), file: str(), at: int() }, key: ["id"] });
// Version 2: `file` becomes `path`, a `dir` column is added and filled from each row (the data step).
// evolveTable 返回新定义，不修改 EditsV1；版本自动变成字面量 2（类型层的 Next<V> 运算）。
// 编辑顺序有意义：rename/add 只能在数据步骤之前调用（drop/index 只能在之后）。
// 链式调用都返回同一个编辑器（edit 回调必须返回它），最后物化出新版本。
const EditsV2 = evolveTable(EditsV1, (t) =>
	t
		// rename 重命名列，并同步更新主键与索引中的列名；旧列名此后不可再用。
		.rename("file", "path")
		// add 新增列；非 opt 列必须带 default，这样已有行在新列上取 ""。
		// 编译期 AddedColumn 与运行期 add 检查都会验证这一点。
		.add("dir", str({ default: "" }))
		// rows 是数据步骤：按主键顺序、每 100 行一批执行 patch。
		// 入参 row 是“步骤时列形态”的行（path 已改名可用），返回值只包含要改的非主键列。
		// 这里 dir = path 去掉最后一个 / 之后的部分，例如 "src/e0.ts" → "src"。
		// 注意：patch 是同步纯函数，不能返回 Promise；它不在事务回调里，不能访问 ctx。
		.rows((row) => ({ dir: row.path.slice(0, row.path.lastIndexOf("/")) })),
);
// Version 3: `dir` is dropped again, an index is added. Data functions stay as deployed; history only grows.
// 数据步骤之后的编辑：drop 删除列、index 建索引（名字需匹配 [a-z0-9_]+）。
// rows 之后编辑器类型变为 TableTailEditor，只允许 after 阶段的编辑；在 rows 之后再 rename/add 会被类型和运行期同时拒绝。
// 这里 v2 刚填充的 dir 在 v3 被删除；它仍会被计算一次，因为迁移是逐版本执行的（v1→v2 完整跑完再 v2→v3）。
// 已发布的旧版本定义不回收：历史只增不改，旧 store 才能沿着同一链条迁到新版本。
const EditsV3 = evolveTable(EditsV2, (t) => t.drop("dir").index("by_path", ["path", "at"]));

// 契约与迁移无关：它只暴露 record/dump 两个方法，参数类型固定；表的版本由部署侧的 facet 决定。
// 空 params 给出稳定身份，表才能持久化在宿主 store 中。
const History = local("example.history", {
	version: 1,
	params: {},
	// record 的参数只有 id/at；其余列（file/path/dir）由部署的 row 函数补齐。
	// dump 参数为空对象，结果 schema 是 arr(str())，对应 string[]。
	members: { record: method(obj({ id: str(), at: int() })), dump: method(obj({}), arr(str())) },
});

/** The facet of one deployment: its newest table version, and how it writes a row. */
// 用途：为“某个部署”生成 facet。输入 definition（该部署声明的最新表定义）与 row（按 id/at 造整行）。
// 输出 defineFacet 的结果（一个 Facet），供 host.load 使用；没有副作用，不打开数据库。
// 设计意图：同一个源文件里演示两个部署——部署 A 用 v1，部署 B 用 v3；真实项目通常一次只声明最新版本。
// 类型说明：TableDefinition 不写泛型参数时默认 TableDefinition<Columns, readonly string[], number>，
// 是任意表版本的“擦除视图”；row 返回 Record<string, unknown>，由调用方保证与该版本的列匹配。
// 示例（真实签名）：const facet = facetOf(EditsV3, (id, at) => ({ id, path: `lib/${id}.ts`, at }));
function facetOf(definition: TableDefinition, row: (id: string, at: number) => Record<string, unknown>) {
	return defineFacet((host) => {
		host.serve(History, (_, self) => {
			// self.table 在对象激活时把 definition 声明到 store；同一对象内同名表只能声明一次。
			// 若 store 里是旧版本，激活过程会先完成迁移，再让对象 live（因此 load 之后读到的已是新版本）。
			const edits = self.table(definition);
			return {
				record: async ({ id, at }, ctx) => {
					// A deployment's rows match its own version (an example shortcut for two versions in one file).
					// tx.put 是整行 upsert；row(...) 产生当前版本需要的列。
					// `as never` 是类型断言：row 的返回类型是宽泛的 Record<string, unknown>，
					// 编译器无法证明它等于 PutRowOf<C>；never 可赋给任何类型，于是这里通过。
					// 这是示例的捷径；真实代码应让 row 返回与表定义精确对应的行类型，让编译器检查列。
					await self.tx(async (tx) => tx.put(edits, row(id, at) as never), ctx);
					// 结果 schema 省略（NullSchema），返回 null。
					return null;
				},
				dump: async (_, ctx) => {
					// lines 显式标注 string[]，避免空数组被推断成 never[]。
					const lines: string[] = [];
					// query(definition) 生成“无条件、按键升序”的查询；edits.rows 是异步可迭代，每页 100 行。
					// for await 逐行解码，JSON.stringify 保留列声明顺序；push 进数组后整体返回。
					for await (const row of edits.rows(query(definition), ctx)) lines.push(JSON.stringify(row));
					return lines;
				},
			};
		});
	});
}

/** A host on the store at `path` serving `facet`, run until `work` is done. */
// 用途：在指定 SQLite 文件上跑一个“部署”：开 store/host，load（可能触发迁移），执行 work，按顺序关闭。
// 输入：path（数据库文件）、facet（该部署的表版本与写入方式）、work（拿到 History 引用后的断言/打印）。
// 输出：Promise<void>；副作用：创建/更新数据库文件，迁移会改写存储格式。
// 错误路径：打开/迁移/load/get/work 失败都会向上传播；此时不执行 close，依赖进程退出清理。
// 主要流程：openStore → createHost → host.load（迁移在 resolve 前完成）→ host.get → work → host.close → store.close。
// 类型说明：ReturnType<typeof facetOf> 提取 facetOf 的返回类型（Facet），无需手写其复杂类型。
// 示例（真实签名）：await deployment("/tmp/h.db", facetOf(EditsV1, (id, at) => ({ id, file: id, at })), work);
async function deployment(
	path: string,
	facet: ReturnType<typeof facetOf>,
	work: (history: Reference<typeof History>) => Promise<void>,
) {
	// 数据库 → backend → store；每一步都 await，因为打开文件与初始化 store 都是异步 I/O。
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
	// onError 只记录后台错误；迁移失败会以激活失败的形式出现在 load 报告里。
	const host = createHost({ store, onError: (error) => console.error("background error:", error) });
	// Objects with empty params activate at load: the migration runs before `load` resolves.
	// 重要顺序：空参数对象在 load 内激活，表声明与迁移在 load resolve 前完成；
	// 因此 work 里的第一次读看到的是迁移后的表。
	await host.load([{ name: "@example/history", facet }], context);
	// 取对象引用；空 params 传 {}。引用 live 意味着表句柄可用。
	await work(await host.get(History, {}, context));
	// 先 host 后 store：让对象结束并排空提交，再关后端。
	await host.close(context);
	await store.close(context);
}

// 临时目录 + 数据库文件；两次 deployment 共用同一个 path，第二次才能看到第一次的旧版本数据。
const directory = await mkdtemp(join(tmpdir(), "chord-example-"));
const path = join(directory, "history.db");
try {
	// 部署 A：声明 v1。row 函数只产生 v1 的列 {id, file, at}。
	await deployment(
		path,
		facetOf(EditsV1, (id, at) => ({ id, file: `src/${id}.ts`, at })),
		async (history) => {
			// 循环写入 e0/e1/e2，at 分别为 0/1/2；每次 record 是一个事务。
			for (let i = 0; i < 3; i++) await history.record({ id: `e${i}`, at: i }, context);
			// dump 传空参数对象；默认按键升序，打印 v1 的三行 JSON。
			console.log("version 1:", await history.dump({}, context));
		},
	);
	// The next deployment declares version 3: the store goes through 2 (rename, add, rows) and 3 (drop, index).
	// 部署 B：同一个数据库文件上声明 v3。激活时迁移链 v1→v2→v3：
	// 1) v1→v2：物理改名 file→path；加 dir 列（旧行填 ""）；数据步骤按 path 计算 dir。
	// 2) v2→v3：删除 dir；建立 by_path(path, at) 索引。
	// 迁移按版本逐级执行，每级每批 100 行；旧行因此从 file 变成 path，值为 src/eX.ts。
	await deployment(
		path,
		facetOf(EditsV3, (id, at) => ({ id, path: `lib/${id}.ts`, at })),
		async (history) => {
			// 新行按 v3 的列写入：path 为 lib/e9.ts。
			await history.record({ id: "e9", at: 9 }, context);
			// 旧三行已迁移为 path；加上新行，共四行，按键升序 e0,e1,e2,e9。
			console.log("version 3:", await history.dump({}, context));
		},
	);
} finally {
	// 删除临时目录；force 让重复清理不抛错。
	await rm(directory, { recursive: true, force: true });
}
