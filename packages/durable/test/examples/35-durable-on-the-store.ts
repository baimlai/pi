// 文件导读
// 所属：packages/durable/test/examples 的 35-durable-on-the-store.ts，Durable 示例系列第 35 个，
// 演示“Durable 运行在 Chord store 上”。
// 演示内容：一个 Chord local 对象 example.chat 在自己的 notes 表之外，用 StoreStorage 在同一 store、同一 owner 名下
// 打开一个 Durable Harness；两次调用分别产生一个 Chord 提交与一个 Durable 提交，各占一个 seq；
// 一次 store.export 同时导出两边的表与文档；关闭重开后仍能按 root 会话读到 Durable 条目。
// 上游入口：node 直接运行本文件；sqlite 文件在临时目录；无网络；模型目录与注册表都是空的，不运行生成。
// 下游依赖：Chord 的 createHost/defineFacet/defineTable/local/method/openStore/sqliteBackend/str、
// Chord sqlite 的 openNodeSqliteDatabase，Durable 的 Harness/StoreStorage/createRegistry/ROOT_CONVERSATION_ID。
// 能力清单：Notes 表；Chat local 契约；facet 的 serve 与 self.open；StoreStorage.open 的 owner；
// note 的 Chord 提交；say 的 Durable write 提交；lastSeq 差值；export 按 owner/kind 计数；重开后的 scanEntries。
// 典型顺序：声明表与契约 -> 定义 facet -> 打开 store/加载 host -> 取对象 -> 两次调用 -> 统计 seq ->
// 遍历 export -> 关闭 host 与 store -> 重开并扫描条目 -> 清理。
// 前置条件：Node 内置 sqlite 可用；无需 API key；这里不启动 agent 生成，只写一条 Durable 记录。
// 预期输出：seqs taken: 2；manifest 的 lastSeq/nextId；按 owner 与 kind 的计数（table 7、put 12、document.create 5）；
// 重开后 Durable entries 为 [example.said]；具体计数随实现可能变化，示例只展示归属关系。
// 阅读顺序：先看 Notes/Chat 与 facet 的 serve，理解 self.open 里的 StoreStorage；再看两次提交与 export；
// 最后看重开扫描如何证明 Durable 数据确实落在同一个 store。
// Durable on the store: a session's worker keeps everything in one store. Durable's Session (a Harness) opens
// `StoreStorage` over the host's store under its object's type name, next to a Chord object's own table and documents;
// both commit through the store's one commit queue (one seq each), one id allocator numbers them all, and one export
// carries both.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/35-durable-on-the-store.ts
// 临时 sqlite 目录在示例末尾删除；没有 finally，前面的失败会跳过清理。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	// createHost 建立 Chord 宿主：它拥有 store、加载 facet，并管理 local 对象的激活与关闭。
	createHost,
	// facet 是插件声明模块：load 时执行 setup，用 host.serve 登记它提供的契约。
	defineFacet,
	// defineTable 声明 store 表的结构、版本与主键；真正的建表发生在宿主或 StoreStorage 打开时。
	defineTable,
	// local 声明本进程内的对象契约：有方法成员，没有远程地址；空 params 的实例可随宿主长期存在。
	local,
	// method(str()) 表示“一个 string 参数、无结果”的方法；note/say 的返回值因此是 null。
	method,
	// openStore 在给定后端上打开 Chord store；后续所有提交共用它的提交队列与 id 分配器。
	openStore,
	// sqliteBackend 把 sqlite 执行器包装成 store 后端；示例用文件路径，重开时能读回同一份数据。
	sqliteBackend,
	// str() 是 Chord 的字符串列 schema，用于表列与契约成员的类型声明。
	str,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
// openNodeSqliteDatabase 使用 Node 内置 sqlite 驱动打开文件；不需要额外 npm 依赖。
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
// ROOT_CONVERSATION_ID 是 Harness.root() 使用的保留根会话 ID；重开后仍按它读取同一条会话。
import { createRegistry, Harness, ROOT_CONVERSATION_ID } from "../../src/index.ts";
// StoreStorage 是 Durable Storage 的 Chord store 实现：表与文档都落在传入的 store 上，close 不关闭 store。
import { StoreStorage } from "../../src/storage/store/index.ts";

const context = BACKGROUND_CONTEXT;

// 声明 notes 表：id 与 text 两列，id 是主键；version 用于将来表结构迁移。
// 这是 Chord 自己的表，由下面的 self.table 按对象 owner 名解析出实际表名。
const Notes = defineTable("notes", { version: 1, columns: { id: str(), text: str() }, key: ["id"] });

// The harness object: local with empty params, so it lives as long as the host and may persist (P3).
// 声明 local 契约 example.chat：version 1、空 params、两个方法 note(text) 与 say(text)。
// local 对象没有远程地址，生命周期与宿主一致；空 params 让它只有一个实例，可以跨重开持久存在。
// 例：host.get(Chat, {}, context) 取到该实例，调用 chat.note("hello", context)。
const Chat = local("example.chat", {
	version: 1,
	// 空 params 表示单例：没有用于区分实例的身份参数；传给 host.get 的 {} 必须满足它。
	params: {},
	// 两个方法都接收一个字符串、返回 null；方法体在 serve 工厂里实现，返回值必须是 JSON 值。
	members: { note: method(str()), say: method(str()) },
});

// facet 的 setup 在 host.load 时同步执行，只做声明；serve 工厂在对象每次激活时才运行。
const facet = defineFacet((host) => {
	// serve 声明本 facet 提供 Chat；工厂第一个参数是对象身份（空 params 时用不上），第二个是对象 API。
	host.serve(Chat, (_, self) => {
		// Its own table, under its type name ...
		// 在对象 owner（example.chat）下取得 notes 表句柄；实际表名会渲染成 owner:notes。
		const notes = self.table(Notes);
		// ... and Durable's records under the same owner name: claims per table and per document namespace.
		// 声明一个 native 资源：激活时打开，尝试结束或宿主关闭时按相反顺序关闭。
		// open 回调收到取消时会被中止的 context；close 回调收到已打开的值、关闭原因与关闭用 context。
		// 返回的句柄用 harness.value 读取；未打开或已释放时读取会抛错。
		const harness = self.open(
			// 形参名 open 实际是 Activation context，不是打开函数；下面把它传给 StoreStorage.open 与 Harness.open。
			async (open) => {
				// 在同一个 store 上打开 Durable Storage 与 Harness；这一层 Harness 与 Chord 对象共享 store 的提交队列。
				const opened = await Harness.open(
					// owner 用 Chat.name（example.chat）：Durable 的六张表与文档命名空间都登记在这个 owner 下，
					// 与 Chord 的 notes 表同属一个 owner，但表名与命名空间由 claims 保证不冲突。
					await StoreStorage.open(store, Chat.name, open),
					// 空模型目录与注册表足够：示例只写记录，不运行 agent 生成。
					{ models: createModels(), registry: createRegistry() },
					open,
				);
				// 创建保留根会话；它会在 store 中写入会话、提交与文档记录，后面的重开扫描依赖它。
				await opened.root(open);
				return opened;
			},
			// 关闭回调：h 是打开好的 Harness，_reason 是 end/close/reload，第三个参数是关闭用 context；
			// 这里把关闭工作交给 Harness.close，示例不区分关闭原因。
			(h, _reason, close) => h.close(close),
		);
		return {
			// note 方法实现：在一个 Chord 事务里写入 notes 表；ctx 是本次调用的上下文。
			note: async (text, ctx) => {
				// self.tx 把回调作为该对象的一个事务提交；tx.put 按主键 id 插入或覆盖行。
				// id 只由文本长度生成，长度相同的不同文本会互相覆盖，示例不关心这一点。
				await self.tx(async (tx) => tx.put(notes, { id: `n${text.length}`, text }), ctx);
				// 方法结果必须是 JSON；null 表示没有返回值，与 method(str()) 声明的无结果一致。
				return null;
			},
			// say 方法实现：通过已打开的 Durable Harness 向根会话写一条记录。
			say: async (text, ctx) => {
				// harness.value 读取 native 的实际值；conversation 返回 Conversation | undefined，根会话一定存在，下面用 !。
				const root = await harness.value.conversation(ROOT_CONVERSATION_ID, ctx);
				// write 提交只追加条目、不启动 run：kind 是自定义显示类型，data 进入条目内容。
				// 这一次接纳会作为 Durable 的一个提交占用 store 的一个 seq。
				await root!.submit({ type: "write", entry: { kind: "example.said", data: { text } } }, ctx);
				return null;
			},
		};
	});
});

// 创建临时目录；前缀里的 26 是历史编号，和本示例的编号无关。
const directory = await mkdtemp(join(tmpdir(), "chord-example-26-"));
// 同一个 sqlite 文件先被第一次运行使用，关闭后再用于重开验证。
const path = join(directory, "session.sqlite");
// 1. The worker's start code opens the store and gives it to its host.
// 先打开 sqlite 执行器，再包成 store 后端；openStore 完成建库与 store 元数据初始化。
const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
// 宿主接管 store 与对象生命周期；onError 只打印 HostError 的 kind，真实应用应记录完整错误与上下文。
const host = createHost({ store, onError: (error) => console.log("onError", error.kind) });
// 加载 facet：setup 立即执行并登记 served 契约；第一个字段只是插件名，用于错误定位。
await host.load([{ name: "@example/core", facet }], context);
// 取得 Chat 的本地实例；首次激活会执行 serve 工厂，进而打开 Durable Harness 并创建根会话。
const chat = await host.get(Chat, {}, context);

// 2. Chord's commit and Durable's commit, each one seq of the same store.
// 记录当前 store 的最后一个提交序号；lastSeq 是整个 store 共用的，不分 Chord 或 Durable。
const before = store.lastSeq;
// note 走 Chord 事务：写入 notes 表，提交一次，占用一个 seq。
await chat.note("hello", context);
// say 走 Durable write 提交：追加 example.said 条目，同样提交一次，占用下一个 seq。
await chat.say("hello, Durable", context);
// 两次提交都经过 store 的同一个提交队列，因此差值应为 2；这正是示例要展示的共享 seq。
console.log("seqs taken:", store.lastSeq - before);

// 3. One archive holds both: Chord's table, Durable's tables and documents, all under the owner name.
const owners = new Map<string, number>();
// store.export 按固定顺序异步产出归档部件：manifest、各表的 table/put/index、文档 create/revision、end。
for await (const part of store.export(context)) {
	// 从部件推断它属于哪个 owner：Chord 的表名是 owner:table，Durable 的文档创建记录直接带 owner。
	// table 与 put 部件带 table 字段，split(":")[0] 取出 owner（例如 example.chat）；
	// document.create 用 record.owner，同样挂在 example.chat 下；index、revision、manifest、end 不计数。
	const owner =
		part.kind === "table" || part.kind === "put"
			? part.table.split(":")[0]
			: part.kind === "document.create"
				? part.record.owner
				: undefined;
	// 按 owner 与部件种类累计数量；?? 0 处理第一次出现，Map 的 get 返回 undefined。
	if (owner !== undefined) owners.set(`${owner} ${part.kind}`, (owners.get(`${owner} ${part.kind}`) ?? 0) + 1);
	// manifest 记录导出点的全局 seq 与 id 分配器下一个值；nextId 被 Chord 与 Durable 共用。
	if (part.kind === "manifest") console.log("manifest:", { lastSeq: part.lastSeq, nextId: part.nextId });
}
// 把 Map 转成普通对象打印；计数依赖实现细节，示例只说明两边记录能在一次导出中同时出现。
console.log("parts by owner and kind:", Object.fromEntries(owners));

// 4. The app closes the host, then the store; a reopen finds both.
// 关闭宿主：结束 local 对象尝试，触发 native 的 close 回调，从而关闭 Durable Harness。
await host.close(context);
// 关闭 store 与底层 sqlite；此时所有写入都已落盘，可以安全重开同一文件。
await store.close(context);
// 用同一路径重新打开 store；这一步模拟 worker 重启后重新连接持久存储。
const reopened = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
// 以同一个 owner 重新打开 Durable Storage；打开时会检查 claims、准备表并抬高 id 分配器。
const storage = await StoreStorage.open(reopened, Chat.name, context);
// 直接扫描根会话的原始条目（默认最新在前）；这里只有 say 写入的一条 example.said。
const page = await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 10, undefined, context);
// 打印条目的 kind 列表，证明 Durable 数据确实保存在刚刚重开的同一个 store 中；
// map 只提取 kind，输出预期为 [ 'example.said' ]。
console.log(
	"Durable entries after reopen:",
	page.items.map((entry) => entry.kind),
);
// Storage.close 只释放表与命名空间 claim，不关闭宿主 store；因此接下来还要单独关闭 reopened。
await storage.close(context);
// 关闭重开的 store 与 sqlite 连接；之后删除临时目录。
await reopened.close(context);
// 递归删除临时 sqlite 目录；示例没有 finally，异常路径不会自动执行到这里。
await rm(directory, { recursive: true, force: true });
