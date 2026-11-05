// Tables: an object's rows in the host's store, declared with `defineTable`, written in transactions (with the
// object's documents, if it has any), read by key, by page with cursors, and counted.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/20-tables.ts
// 文件导读
// 所属包与示例系列：packages/chord/test/examples，Chord v2 示例 20，对应 slice 6a（the store：表、查询、写入与持久化）。
// 演示什么：对象把自己的行放在宿主的 store 里。defineTable 声明扁平列、默认值、主键与索引；应用打开 SQLite store
//   并交给一个宿主；对象工厂用 self.table 取得只读表句柄，所有写入通过 self.tx 与文档写入一起提交。
//   查询是不可变的 query(...).where(...).orderBy(...)；读取支持按主键 get、用不透明游标分页 page、以及 count。
//   写入示例覆盖 put（整行，默认列可省略）、update（按键，用表达式自增）和 updateWhere（一条语句更新所有匹配行）。
// 上游/下游：文件顶部命令启动；下游使用 src/store 的 defineTable/query/eq/prefix/add/openStore/sqliteBackend、
//   src/sqlite/node.ts 的 openNodeSqliteDatabase、src/host 的 createHost/defineFacet。数据库是进程内 :memory:，
//   不访问网络、不写文件；关闭连接即丢弃数据。
// 能力清单（按演示的机制）：
// - defineTable：version、扁平 columns（str/int/bool/opt）、default、key（非 opt 的 str/int 列）、命名 indexes。
//   声明在构造时检查（名称、版本、键、索引、默认值），错误是同步抛出的开发者错误。
// - openStore + sqliteBackend + openNodeSqliteDatabase：应用打开后端并把 store 交给一个宿主；store 由应用关闭。
// - self.table(Def)：只读表句柄，只能在 local、空 params 的对象工厂里声明（一个宿主一份表）；写入只能走事务。
// - query：不可变；where 编译条件，orderBy 限定排序，未显式包含的主键列自动作为 tie-break，保证分页全序。
// - tx.put / tx.update / tx.updateWhere：在 self.tx 中同步暂存，回调成功后一次提交；坏行在暂存时即抛错。
// - 表达式写入：update 的 set 可以是 (e) => ({ hits: add(e.hits, 1) })，由 store 计算，避免读改写竞争。
// - 读取：get 按键返回行或 undefined；page 用 limit 与不透明 after 游标，返回 items 与可选 next；count 统计行数。
// - 默认值与可选列：hits/done 省略时由默认值填充；opt(str()) 的 note 未写入时读取对象里没有该属性。
// - updateWhere 影响的行数随写入记录，便于同步层核对（示例只展示其结果通过后续查询可见）。
// 典型运行顺序：定义 Edits 与 History -> 在工厂里 self.table 并构建一次 open 查询 -> 打开 :memory: store ->
//   创建宿主、load facet、get History -> 写入 5 行（路径交替 src/a、src/b）-> e1 自增两次 ->
//   finish("src/a") 把该前缀的行标记 done -> 依次打印 hits、两页 open 查询结果、finished 计数 -> 关闭宿主与 store。
// 示例（符合真实签名）：
//   const Edits = defineTable("edits", {
//     version: 1,
//     columns: { id: str(), path: str(), at: int(), hits: int({ default: 0 }), done: bool({ default: false }), note: opt(str()) },
//     key: ["id"],
//     indexes: { by_path: ["path", "at"] },
//   });
//   const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
//   const edits = self.table(Edits);
//   await self.tx(async (tx) => tx.put(edits, row), context);
//   const page = await edits.page(query(Edits).where((e) => eq(e.done, false)).orderBy((e) => e.at, "desc"), 1, context);
// 运行方式与环境：在 packages/chord 下执行文件顶部命令；需要 Node 内置 SQLite 驱动；无环境变量、无网络；瞬时完成。
// 预期输出：
//   hits of e1: 2
//   open, first page: [ 'e3' ]
//   open, next page: [ 'e1' ]
//   finished: 3
// 对应测试与文档：packages/chord/test/store/table.test.ts、columns.test.ts、query.test.ts、expression.test.ts、
//   table-handle.test.ts、table-writes.test.ts、store.test.ts；slices.md 的 slice 6a；design.md 关于 store、表与查询的章节。
// 建议阅读顺序：先看 Edits 的列/默认值/键/索引与 History 契约，再看工厂里的 open 查询与五个方法，
//   随后看 store 的打开与宿主装配，最后按写入、分页、计数三段读输出。
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
// 契约构造器：arr/bool/int/obj/opt/str 描述形状，local 声明本地类型，method 声明调用。
import { arr, bool, int, local, method, obj, opt, str } from "../../src/contracts/index.ts";
// 宿主与 facet；store 通过 createHost 的选项注入。
import { createHost, defineFacet } from "../../src/host/index.ts";
// Node 内置 SQLite 数据库驱动；示例用 :memory:，不落地文件。
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
// store 层入口：表定义、查询/表达式、打开 store 与 SQLite 后端适配。
import { add, defineTable, eq, openStore, prefix, query, sqliteBackend } from "../../src/store/index.ts";

// 后台上下文：打开 store、事务、读取与关闭都显式传入。
const context = BACKGROUND_CONTEXT;

// Flat columns (str, int, num, bool, opt(...), json(...)), defaults, a key of non-opt str or int columns, and
// indexes, which end with the key.
// 扁平列声明：id/path 是非 opt 字符串，at 是非 opt 整数，hits/done 带默认值，note 是可选字符串。
// key 只能由非 opt 的 str/int 列组成；by_path 索引在渲染时会把未出现的主键列追加到末尾。
const Edits = defineTable("edits", {
	version: 1,
	columns: {
		id: str(),
		path: str(),
		at: int(),
		// default 让 put 可以省略该列，由行编解码器在写入时填入。
		hits: int({ default: 0 }),
		done: bool({ default: false }),
		// opt 表示可空/可省略；读取 NULL 时该属性不出现，而不是得到 null。
		note: opt(str()),
	},
	key: ["id"],
	// 索引名受限；每个索引以主键列收尾，查询排序才能形成全序。
	indexes: { by_path: ["path", "at"] },
});

// History 是本例对象的契约：写入、自增、批量完成、点查、分页与计数。
// 参数与返回值都用 schema 描述；open 的 next 是可选字符串，对应“没有下一页时省略”。
const History = local("example.history", {
	version: 1,
	params: {},
	members: {
		record: method(obj({ id: str(), path: str(), at: int() })),
		hit: method(str()),
		finish: method(str()),
		hits: method(str(), int()),
		open: method(obj({ after: opt(str()) }), obj({ ids: arr(str()), next: opt(str()) })),
		finished: method(obj({}), int()),
	},
});

const facet = defineFacet((host) => {
	// Tables need a stable identity: a local type with empty params (one object per host).
	// 一个宿主只有一个 History 对象；表只在 local、空 params 的工厂里声明，才能有稳定归属。
	host.serve(History, (_, self) => {
		// self.table 返回只读表句柄；写入必须通过该对象的事务。
		const edits = self.table(Edits);
		// A query of the table: a condition and an order (the key is the tie-break); immutable, built once.
		// 查询不可变：where 编译为条件，orderBy 指定 at 降序；主键 id 自动补作 tie-break，保证分页顺序唯一。
		const open = query(Edits)
			.where((e) => eq(e.done, false))
			.orderBy((e) => e.at, "desc");
		return {
			record: async (row, ctx) => {
				// Writes are staged synchronously (a bad row throws here) and commit together in one step.
				// 回调里 tx.put 只暂存整行写入；row 的类型是 PutRowOf：hits/done 有默认值可省略，note 可省略。
				// 未知列、类型错误或缺主键在暂存阶段就抛错，事务不会提交。
				await self.tx(async (tx) => tx.put(edits, row), ctx);
				return null;
			},
			hit: async (id, ctx) => {
				// A set is values or an expression over the row's columns, computed by the store.
				// 按键更新，set 用表达式 add(e.hits, 1)：由 store 计算新值，避免先读后写的竞争。
				await self.tx(async (tx) => tx.update(edits, { id }, (e) => ({ hits: add(e.hits, 1) })), ctx);
				return null;
			},
			finish: async (path, ctx) => {
				// One statement for every matching row; its count is recorded with the write.
				// prefix(e.path, path) 是字符串前缀匹配；一条 UPDATE 覆盖所有匹配行，影响行数随写入记录。
				await self.tx(async (tx) => tx.updateWhere(edits, (e) => prefix(e.path, path), { done: true }), ctx);
				return null;
			},
			// 按键读取已提交的行；行不存在时 get 返回 undefined，?? 0 把“没有行”映射为 0 次命中。
			hits: async (id, ctx) => (await edits.get({ id }, ctx))?.hits ?? 0,
			open: async ({ after }, ctx) => {
				// limit 为 1 以便演示多页；after 是不透明游标，已绑定表、排序列与方向。
				// 用条件展开避免把 next: undefined 显式放进结果（契约里它是可选字段）。
				const page = await edits.page(open, 1, ctx, after === undefined ? {} : { after });
				// items 是行数组；这里只暴露 id，并在有下一页时附上 next 游标。
				return { ids: page.items.map((row) => row.id), ...(page.next === undefined ? {} : { next: page.next }) };
			},
			// count 与 page 使用同一查询类型；这里统计所有 done=true 的行。
			finished: async (_, ctx) =>
				edits.count(
					query(Edits).where((e) => eq(e.done, true)),
					ctx,
				),
		};
	});
});

// A store over SQLite (`:memory:` here, a file in an app): the app opens it, gives it to one host, and closes it.
// sqliteBackend 适配已打开的数据库；:memory: 数据库随连接存在，关闭后数据消失。
// 一个 store 只能交给一个宿主；应用负责最终关闭顺序。
const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
// store 通过 createHost 选项注入；后台错误（包括表读写失败）由 onError 打印。
const host = createHost({ store, onError: (error) => console.error("background error:", error) });
await host.load([{ name: "@example/history", facet }], context);
// History 是空 params 的 local 类型，因此每个宿主只有一个对象；get 在首次使用时激活工厂。
const history = await host.get(History, {}, context);

// 写入 5 行：at 依次为 0..4，路径在 src/a.ts 与 src/b.ts 之间交替；hits/done 使用默认值。
for (let i = 0; i < 5; i++) {
	await history.record({ id: `e${i}`, path: `src/${i % 2 === 0 ? "a" : "b"}.ts`, at: i }, context);
}
// e1 自增两次：两次独立的 update 事务，结果应为 2。
await history.hit("e1", context);
await history.hit("e1", context);
// 把 path 以 src/a 开头的行（e0、e2、e4）标记为完成。
await history.finish("src/a", context);

// 点查已提交的 e1；结果为 2。
console.log("hits of e1:", await history.hits("e1", context));
// Pages continue from an opaque cursor.
// 第一次查询 done=false 的行，按 at 降序：e3（at 3）在 e1（at 1）之前，页大小为 1。
const first = await history.open({}, context);
console.log("open, first page:", first.ids);
// 把上一页的 next 原样传回；游标由存储层校验并解码，返回下一页。
console.log("open, next page:", (await history.open({ after: first.next }, context)).ids);
// 统计 done=true 的行：e0、e2、e4，共 3 行。
console.log("finished:", await history.finished({}, context));

// 先关闭宿主：等待在途事务与对象清理结束；再关闭 store：等待提交步骤并关闭后端。
await host.close(context);
await store.close(context);
