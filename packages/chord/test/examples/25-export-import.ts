// 文件导读
// 所属：packages/chord/test/examples，Chord v2 示例 25，对应 slice 6a §13（store 导出/导入）。
// 演示内容：store.export(ctx) 把 store 状态以 ArchivePart 异步流导出（无损：表定义/版本/行、存活文档），
// 迭代期间占住提交队列；encodeJsonl 把部件编码为 JSONL。importStore 逐部件校验，并在一个后端事务里建出新 store。
// 上游入口：命令行直接运行；自建临时目录与两个 SQLite 文件，不依赖外部服务。
// 下游调用：defineTable/defineState、openStore、store.export/encodeJsonl/decodeJsonl/importStore、
// Node 的 fs 流与 stream/promises.pipeline。写入 <tmp>/chord-example-*/{a.db,archive.jsonl,b.db}，运行结束删除。
// 失败行为：导出/解码/导入任一 await 拒绝都会终止脚本；导入被拒绝时后端保持为空并被关闭；
// export 从第一次 next() 起占住提交队列，迭代结束（或抛错/关闭/context 中止）后释放。
// 能力清单（按演示机制列出，本文件没有导出）：
// - Visits：持久化表，主键 page，count 记录访问次数。
// - Title：持久化 singleton 文档，checkpointWhen 恒 false。
// - Site 契约：title 状态成员；visit(page) 返回新计数；rename(text) 改标题。
// - facet：声明表与文档句柄，实现两个方法。
// - serve()：在给定 store 上开 host、load、执行 work、关闭 host（store 由调用方关闭）。
// - 主流程：a.db 写入数据 → export + encodeJsonl 写 archive.jsonl → importStore 导入 b.db → 在副本上继续访问。
// 典型运行顺序：建原 store → 写入标题与三次访问 → 导出为 JSONL → 关闭原 store → 导入新后端 → 读标题并再访问一次。
// 示例（真实签名）：
//   await pipeline(encodeJsonl(store.export(ctx)), createWriteStream(path));
//   const copy = await importStore(backend, decodeJsonl(createReadStream(path)), ctx);
// 阅读顺序：先看 Visits/Title/Site 与 facet，再看 serve 的 host 生命周期，最后看导出→导入→验证三段。
// 前置条件：Node 支持 --experimental-strip-types、node:sqlite 与 node:stream/promises。在 packages/chord 下运行：
//   node --conditions=source --experimental-strip-types test/examples/25-export-import.ts
// 预期输出（本机实测；字节数可能随归档格式版本变化，seq 与计数是真正断言）：
//   archive: 772 bytes at seq 5
//   imported at seq 5
//   title: Chord - next visit of /: 3
// 相关文档：packages/chord/docs/slice-6a.md（§13 归档、规则 12/24/25）；相关测试：test/store/ 的 export/import 用例。
// Export and import: `store.export(ctx)` yields the store's state as archive parts (lossless: tables with their rows
// and versions, the live documents), holding the commit queue while it runs; `encodeJsonl` turns them into JSONL.
// `importStore` checks an archive part by part and makes a new store from it in one backend transaction.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/25-export-import.ts
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { int, local, method, obj, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, type Reference } from "../../src/host/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import {
	decodeJsonl,
	defineTable,
	encodeJsonl,
	importStore,
	openStore,
	type Store,
	sqliteBackend,
} from "../../src/store/index.ts";

// 后台上下文：导出/导入都没有取消需求；传入可中止的 context 可以让停滞的导入被取消。
const context = BACKGROUND_CONTEXT;

// 基准版本表：page 为主键，count 是整数；这张表的内容会完整进入归档。
const Visits = defineTable("visits", { version: 1, columns: { page: str(), count: int() }, key: ["page"] });
// 持久化 singleton 文档：标题。checkpointWhen 恒 false，修改只存 delta；
// 导出时先写一条 document.create 记录，再按 seq 顺序写该文档保留的每条 document.revision，导入端重放它们恢复当前值。
const Title = defineState("title", {
	schema: obj({ text: str() }),
	version: 1,
	initial: () => ({ text: "untitled" }),
	persist: true,
	checkpointWhen: () => false,
});

// 契约：title 是状态成员；visit 接收 page 并返回新计数；rename 接收文本、结果为 null。
const Site = local("example.site", {
	version: 1,
	params: {},
	members: {
		title: obj({ text: str() }),
		visit: method(str(), int()),
		rename: method(str()),
	},
});

const facet = defineFacet((host) => {
	host.serve(Site, (_, self) => {
		// 表句柄：读写在事务里通过 tx.get/tx.put 完成；这里只声明，不访问数据库。
		const visits = self.table(Visits);
		// 持久化文档句柄；作为 title 成员交给调用方读取。
		const title = self.state(Title);
		return {
			title,
			// 表达式箭头函数直接返回 self.tx(...) 的 Promise；tx 回调的结果就是方法结果（int）。
			visit: async (page, ctx) =>
				self.tx(async (tx) => {
					// tx.get 读取“事务视角”的行：同一事务里先前的 put/update 已叠加；缺行时 undefined。
					// `?.count ?? 0` 在缺行或 count 为 null/undefined 时取 0，再 +1。
					const count = ((await tx.get(visits, { page }))?.count ?? 0) + 1;
					// put 是整行 upsert；提交时与事务内其他写入一起落盘。
					tx.put(visits, { page, count });
					// 返回新计数；参数 page 会在运行时按 str() 校验，而结果不按 int() 做运行期校验。
					return count;
				}, ctx),
			rename: async (text, ctx) => {
				// 文档修改走事务：change 草拟 singleton，回调里赋值，提交后 watch 收到 delta。
				// 多行回调只是格式化结果，行为与单行相同。
				await title.change((draft) => {
					draft.text = text;
				}, ctx);
				return null;
			},
		};
	});
});

/** A host on `store` serving the site, run until `work` is done. */
// 用途：在已有 store 上开 host、加载 facet、把 Site 引用交给 work，最后关闭 host。
// 输入：store（原库或导入副本）、work（执行读写）。
// 输出：Promise<void>；不关闭 store —— 关闭责任留给调用方（原库导出后要显式 close，副本验证后也要 close）。
// 错误路径：load/get/work/close 任一拒绝都会向上传播；此时 store 仍需由调用方在 finally 中关闭（本例依赖临时目录清理）。
// 主要流程：createHost({store}) → load → get(Site, {}) → work → host.close。
// 示例（真实签名）：await serve(store, async (site) => console.log(site.title.value.text));
// 注意 host 关闭会排空挂起的文档/表提交，因此 work 里的写入在 close 后已持久化到 store。
async function serve(store: Store, work: (site: Reference<typeof Site>) => Promise<void>) {
	// createHost 接收 store 后，persist 文档与 self.table 才可用；onError 只记录后台错误。
	const host = createHost({ store, onError: (error) => console.error("background error:", error) });
	// 加载插件；空 params 的 Site 在 load 内激活，title 文档也从 store 水合。
	await host.load([{ name: "@example/site", facet }], context);
	// 取引用并运行调用方逻辑；引用保证 live。
	await work(await host.get(Site, {}, context));
	// 只关 host：让对象结束、提交排空。store 的提交队列与后端仍由调用方管理。
	await host.close(context);
}

// 临时目录存放三样东西：原库 a.db、归档 archive.jsonl、导入库 b.db。
const directory = await mkdtemp(join(tmpdir(), "chord-example-"));
try {
	// 原库：SQLite 文件 a.db；openStore 会在空后端上建目录表。
	const original = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(directory, "a.db"))), context);
	// 写入：标题一次、"/" 两次（计数 1→2）、"/docs" 一次。每次方法调用都是一个事务/提交。
	await serve(original, async (site) => {
		await site.rename("Chord", context);
		await site.visit("/", context);
		await site.visit("/", context);
		await site.visit("/docs", context);
	});
	// Export to a local file (then upload it, if needed): the queue is held only while the parts are read.
	// 归档文件路径；export 返回 ArchivePart 异步迭代器，encodeJsonl 把它变成 JSONL 字节流。
	// pipeline 负责背压：读端慢时暂停上游，写完自动关闭目标流；出错时销毁两端并 reject。
	// export 从第一次 next() 起占住提交队列，迭代结束（pipeline 完成）后释放；lastSeq 是最后一次提交的序号。
	const archive = join(directory, "archive.jsonl");
	await pipeline(encodeJsonl(original.export(context)), createWriteStream(archive));
	// stat 读取文件大小；把字节数与 seq 一起打印，便于确认归档非空且包含全部提交。
	console.log("archive:", (await stat(archive)).size, "bytes at seq", original.lastSeq);
	// 原库导出完毕，显式关闭：等待提交、关闭后端。之后不再使用 original。
	await original.close(context);

	// Import into an empty backend: every part is checked; a refused archive leaves the backend empty.
	// decodeJsonl 边读文件边解析：createReadStream 产出 Buffer（Uint8Array 子类），跨块的 UTF-8 字符会被拼回。
	// importStore 的信任边界：每个部件都按归档 schema/顺序/内容校验，全部写入一个后端事务；
	// b.db 是全新目录，若已存在 store 会以 invalid/args 拒绝；拒绝或中止时后端被关闭、保持为空。
	const parts = decodeJsonl(createReadStream(archive));
	const copy = await importStore(sqliteBackend(await openNodeSqliteDatabase(join(directory, "b.db"))), parts, context);
	// 副本的 lastSeq 应与原库一致（本机实测 seq 5）。
	console.log("imported at seq", copy.lastSeq);
	// 在副本上继续使用：标题来自归档；"/" 的计数从 2 增加到 3，证明表行也被完整导入。
	await serve(copy, async (site) => {
		console.log("title:", site.title.value.text, "- next visit of /:", await site.visit("/", context));
	});
	// 关闭副本；之后再删除临时目录。
	await copy.close(context);
} finally {
	// 清理数据库与归档文件；force 让重复清理不抛错。
	await rm(directory, { recursive: true, force: true });
}
