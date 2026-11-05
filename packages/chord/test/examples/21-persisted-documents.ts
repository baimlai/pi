// 文件导读
// 所属：packages/chord/test/examples，Chord v2 示例 21，对应 slice 6a（store 与持久化文档）。
// 演示内容：defineState({ persist: true }) 把对象的文档存进宿主的 store。第一个 host 写入后关闭；
// 在同一个 SQLite 文件上新建 host，文档从 store 恢复。checkpointWhen 决定一次提交存整份 base，还是只存增量 delta。
// 上游入口：从命令行直接运行本文件；它自己创建临时目录、SQLite 文件、宿主与 facet，不依赖外部服务。
// 下游调用：openNodeSqliteDatabase/sqliteBackend/openStore（store 层）、createHost/defineFacet（宿主层）、
// defineState（文档定义）、local/method/obj/arr/str（契约层）。写入 <tmp>/chord-example-*/notebook.db，运行结束删除。
// 失败行为：任一 await 拒绝都会让脚本以非零退出码结束；finally 仍会清理临时目录，不会留下半开数据库文件。
// 能力清单（按演示的机制列出，本文件没有导出）：
// - Tags：持久化 singleton 文档；每累计 20 条 delta 就存一次新 base。
// - Notes：持久化 keyed 文档；每个 key 首次读取时加载，checkpointWhen 恒为 false（只存 delta）。
// - Notebook 契约：state 成员 tags，方法 write/read；空 params 给出稳定身份，持久化才被允许。
// - facet：定义工厂，在对象激活时声明两个状态句柄与两个方法实现。
// - session()：打开指定路径的 store 与 host，运行 work，再按 host → store 的顺序关闭。
// - 主流程：第一个 host 写入两条笔记；第二个 host 从同一文件读回 tags 与 standup 内容。
// 典型运行顺序：定义文档与契约 → 注册 facet 工厂 → 第一个 session 写入并打印 → 第二个 session 读取并打印。
// 示例（真实签名，省略与本例相同的字段）：
//   const Tags = defineState("tags", { schema: obj({ tags: arr(str()) }), version: 1,
//     initial: () => ({ tags: [] }), persist: true, checkpointWhen: () => false });
// 阅读顺序：先看两个 defineState 与 Notebook 契约，再看 facet 里的 self.state/self.tx，最后看 session 与两次运行。
// 前置条件：Node 需支持 --experimental-strip-types 与 node:sqlite（Node 22+）。在 packages/chord 下运行：
//   node --conditions=source --experimental-strip-types test/examples/21-persisted-documents.ts
// 预期输出（顺序固定）：
//   first host, tags: [ 'home', 'work' ]
//   second host, tags: [ 'home', 'work' ]
//   second host, standup: demo the store
// 相关文档：packages/chord/docs/slice-6a.md（§1 文档、§10 持久化、§11 指纹/版本）；相关测试：test/store/ 与 test/documents/。
// Persisted documents: `persist: true` keeps an object's documents in the host's store, so a new host on the same
// store finds them again; `checkpointWhen` decides when a change is stored as a new base instead of a delta.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/21-persisted-documents.ts
// 导入分三组：Node 标准库（临时目录与文件路径）、Chord 公开模块（context/contracts/documents/host/sqlite/store）。
// 所有导入都是顶层 ESM 导入；`type Reference` 只导入类型，编译后不产生运行期绑定。
// test/examples 下的文件直接以 .ts 后缀导入 src，配合 --conditions=source 读取源码而不是 dist 产物。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { arr, local, method, obj, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, type Reference } from "../../src/host/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { openStore, sqliteBackend } from "../../src/store/index.ts";

// BACKGROUND_CONTEXT 是永不取消、没有 principal 的后台上下文；测试与示例用它代替调用方上下文。
// 真实服务应传请求自己的 Context，这样超时/取消能中断等待中的 store 操作。
const context = BACKGROUND_CONTEXT;

// A persisted singleton: loaded once when its object activates; every 20th stored change is a new base.
// 声明持久化 singleton 文档。类型参数由 schema 推断：DocumentOf<S> = { tags: string[] }，无需手写泛型。
// 字段含义：schema 是运行期数据形状；version 参与存储版本判定；initial 生成缺席值；
// persist: true 走第二个重载，因此必须同时提供 checkpointWhen（类型层强制，运行期也检查）。
// 注意这份代码只描述定义，不创建文档；文档在对象激活时由 self.state(Tags) 声明并水合。
const Tags = defineState("tags", {
	// obj/arr/str 是 schema 构造器：编译期给出静态类型，运行期首次 initial() 会校验一次返回值。
	schema: obj({ tags: arr(str()) }),
	// 版本从 1 开始；读取旧版本必须提供 migrate，否则访问被拒绝但数据保留。
	version: 1,
	// initial 每次调用都应返回新对象；这里是空数组，写入后由文档保存当前值。
	initial: () => ({ tags: [] }),
	// 持久化开关；只有 local 契约且 params 为空的对象才允许（稳定身份，重启后能找到同一文档）。
	persist: true,
	// checkpointWhen 只在“修改已有文档”的提交上被询问。deltasSinceBase 是 base 之后已存的 delta 条数，
	// 达到 20 就返回 true，把整根文档存成新 base，缩短以后重放 delta 的链。
	// `_value`/`_ops` 前缀下划线表示本回调不使用这两个参数；解构第三个参数的 deltasSinceBase 是 TS 语法。
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 20,
});
// A persisted keyed document: each key loaded on its first read, then cached until idle for ten minutes.
// 声明持久化 keyed 文档：一个对象持有任意多个同形状文档，每个用字符串 key 区分（例如每条笔记一个 key）。
// keyed 在类型层把 K 从 false 变为 true，于是 self.state(Notes) 返回 KeyedHandle 而不是 SingletonHandle。
const Notes = defineState("notes", {
	schema: obj({ body: str() }),
	version: 1,
	// keyed 文档在 key 缺席时也调用 initial()；这里给出空正文。
	initial: () => ({ body: "" }),
	// keyed: true 让定义按 key 存储；运行期 handler 根据它选择 Keyed 句柄实现。
	keyed: true,
	// 持久化 keyed 文档：每个 key 的文档在第一次读取时从 store 加载，之后驻留内存直至闲置约十分钟。
	persist: true,
	// 恒返回 false：修改只存 delta，从不主动换 base。创建新 key 或版本变化仍会强制存 base（框架规则）。
	checkpointWhen: () => false,
});

// 声明 local 契约：name + version + params + members。local 表示对象只在本宿主内存在（与 remote 相对）。
// params: {} 是空对象类型——同宿主只有一个实例，而且这是持久化的前提（稳定身份）。
// members 的每一项由运行期类型自动分流：普通 schema 是 state 成员，method(...) 是方法。
const Notebook = local("example.notebook", {
	// 契约版本；方法或状态形状变化时应升级版本，让引用方按版本绑定。
	version: 1,
	// 空参数对象表示单例；调用 host.get(Notebook, {}) 时参数必须与它匹配。
	params: {},
	members: {
		// 状态成员：调用方以 watchable 方式读取，值类型为 { tags: string[] }。
		tags: obj({ tags: arr(str()) }),
		// 方法：第一个 schema 描述参数（对象），省略结果 schema 表示结果类型为 null。
		// 方法参数在对象端按 schema 校验；结果不会被运行期校验。
		write: method(obj({ id: str(), body: str(), tag: str() })),
		// 两个位置分别传参 schema 与结果 schema：read(id: string): string。
		read: method(str(), str()),
	},
});

// defineFacet 定义一个插件模块：setup 回调在每次对象激活时同步执行，用 host.serve 登记类型工厂。
// 这里只登记一个契约；宿主 load 时先运行 setup，再激活空参数对象（Notebook 恰好是空参数）。
const facet = defineFacet((host) => {
	// Persisted documents need a stable identity, as tables do: a local type with empty params.
	// host.serve 的工厂签名由契约决定：参数是契约 params 的解构结果，self 是声明接口。
	// 这里 params 为空，所以第一个形参是空对象（`_` 表示不使用）；params 为空时 self 是 StoreSelf<P>，
	// 它比普通 Self 多出 table/contribute，并允许 persist: true。
	host.serve(Notebook, (_, self) => {
		// self.state 返回的句柄类型由 HandleOf 在编译期选择：Tags 非 keyed → SingletonHandle。
		// 句柄是“薄视图”：读取委托给槽，写入变成对象事务；它不直接持有文档值。
		const tags = self.state(Tags);
		// Notes 是 keyed → KeyedHandle；这里只是声明，具体 key 的文档在首次 get/change 时加载。
		const notes = self.state(Notes);
		// 返回对象就是方法实现；state 成员直接交回句柄，Chord 会解析到槽本身供观察。
		return {
			tags,
			write: async ({ id, body, tag }, ctx) => {
				// Both documents commit in one store step, or neither does.
				// self.tx 把回调登记为一个对象事务：回调内只能 await tx.*，不能再开 self.tx，也不能调用其他对象。
				// 两个 draft 修改与事务一起提交到 store；任一抛错则整笔丢弃，不会只写一半。
				await self.tx(async (tx) => {
					// tx.draft(notes, id) 取 keyed 文档的草稿；同一事务内同一文档多次 draft 得到同一个对象。
					// 冷 key 会先触发一次加载；赋值经过 draft 追踪，提交时变成一条 delta。
					(await tx.draft(notes, id)).body = body;
					// singleton 草稿不需要 key；这里读取当前 tags 数组。
					const draft = await tx.draft(tags);
					// includes 去重后再 push：同一 tag 只保留第一次出现。
					// push 是数组变更，同样被草稿追踪；没有变更时提交不会产生写入。
					if (!draft.tags.includes(tag)) draft.tags.push(tag);
				}, ctx);
				// 方法声明没有结果 schema（NullSchema），所以返回 null 符合静态类型。
				return null;
			},
			// read 不经过事务：notes.get 是读操作，冷持久文档会在对象线上加载，然后返回当前值或 undefined。
			// `?.` 可选链处理 undefined，`?? "(none)"` 在 null/undefined 时给兜底字符串。
			read: async (id, ctx) => (await notes.get(id, ctx))?.body ?? "(none)",
		};
	});
});

/** A host on the store at `path`, run until `work` is done with the notebook. */
// 用途：用固定路径的 SQLite 文件建立 store 与 host，加载 facet，把 Notebook 引用交给 work，最后关闭两者。
// 输入：path（数据库文件路径）、work（拿到引用后执行的异步回调）。
// 输出：Promise<void>；没有返回值。副作用：打开/关闭数据库文件，host 生命周期内可能写入文档。
// 错误路径：openStore/openNodeSqliteDatabase/host.load/host.get/work 任一拒绝都会向上传播；此时后面的 close 不会执行，
// 本例依赖进程退出与临时目录清理，生产代码应把 close 放进 try/finally。
// 主要流程：数据库 → backend → store → host → load → get → work → host.close → store.close。
// 示例（真实签名）：await session("/tmp/n.db", async (notebook) => console.log(notebook.tags.value));
// 注意 Reference<typeof Notebook> 是类型层映射：状态成员变成可读 watchable，方法变成 async 函数。
async function session(path: string, work: (notebook: Reference<typeof Notebook>) => Promise<void>) {
	// openNodeSqliteDatabase 用 Node 内置 node:sqlite 打开文件（不存在则创建）；
	// sqliteBackend 把它适配成 Chord 的 Backend 接口；openStore 包上提交队列与文档编解码。
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
	// createHost：store 让持久化文档有落盘处；onError 接收后台错误（例如未被 await 的监听器抛错），
	// 这里只打印，不改变调用方看到的拒绝。若省略 store，persist: true 的文档会在声明时被拒绝。
	const host = createHost({ store, onError: (error) => console.error("background error:", error) });
	// load 接收插件列表：name 是插件身份，facet 是它的声明模块。load 返回后空参数对象已激活过一次，
	// 但对象激活失败不会让 load 拒绝（报告里给出失败项）；本例没有检查 LoadReport。
	await host.load([{ name: "@example/notebook", facet }], context);
	// host.get 取（必要时创建并等待）Notebook 实例；空 params 传 {}。返回的 Reference 已 live。
	await work(await host.get(Notebook, {}, context));
	// 先关 host：让对象结束、把挂起提交排空；再关 store：等待进行中的提交并关闭后端。
	// 顺序反过来会让 host 在已关闭的 store 上继续写，因此不能交换。
	await host.close(context);
	await store.close(context);
}

// mkdtemp 在系统临时目录下创建唯一子目录（前缀 chord-example-），避免并发运行互相覆盖。
// 顶层 await 是 ESM 特性：模块会等到 Promise 结算再继续；失败则模块执行失败、进程退出码非零。
const directory = await mkdtemp(join(tmpdir(), "chord-example-"));
// join 拼出数据库文件路径；文件此时还不存在，由 node:sqlite 在打开时创建。
const path = join(directory, "notebook.db");
// try/finally 保证测试数据清理：即使写入或断言抛错，也删除整个临时目录。
try {
	// 第一个宿主：两次 write 各在一个事务里更新 notes[id] 与 tags，然后读取内存中的 tags 值。
	await session(path, async (notebook) => {
		// 方法参数是对象；运行时按契约 schema 校验 id/body/tag 都是字符串。
		await notebook.write({ id: "groceries", body: "oat milk", tag: "home" }, context);
		// 第二次写入把 work 追加到 tags；checkpointWhen 尚未达到 20 条 delta，所以只存增量。
		await notebook.write({ id: "standup", body: "demo the store", tag: "work" }, context);
		// tags 是状态成员，.value 同步读取当前值；打印数组得到 [ 'home', 'work' ]。
		console.log("first host, tags:", notebook.tags.value.tags);
	});
	// A new host on the same file: the documents come back from the store.
	// 第二个宿主复用同一个数据库文件：singleton 在激活时从 store 水合，keyed 文档在第一次读时加载。
	// 这就是持久化的核心断言——进程内存在与否不影响数据。
	await session(path, async (notebook) => {
		// 从 store 恢复的 tags 顺序与写入顺序一致。
		console.log("second host, tags:", notebook.tags.value.tags);
		// read 触发 notes 的冷加载：standup 的正文来自上一宿主写入的 delta。
		console.log("second host, standup:", await notebook.read("standup", context));
	});
} finally {
	// recursive: true 删除目录及内容；force: true 在路径已不存在时不抛错，保证清理幂等。
	await rm(directory, { recursive: true, force: true });
}
