// 文件导读
// 所属：packages/chord/test/examples/59-chat/plugins/chat，聊天插件的 worker facet（目录插件）。
// 同目录 package.json 是插件清单：name @chat/chat、private、type module；server.ts 与 worker.ts
// 以文件名为 facet 种类。清单由 app kit 的插件发现/构建器读取，本文件不解析它。
// 作用：在每个频道的 worker 进程里实现聊天数据：
//   - `Messages` 表保存该频道全部消息（持久化在 worker 的 store 中）；
//   - 本地 Store 对象持有最新 100 条消息的实时窗口，负责追加与历史分页；
//   - 远程 Room 对象按 principal 暴露同一份数据：发消息时作者取自登录名，附件通过本 worker 的
//     Files 契约分块上传，消息里只保存附件元数据。
// 上游：worker 启动时服务器下发的脚本被求值，本 facet 的 setup 在 worker host 中执行。
// 下游：@chat/app/v1 的表/契约/schema，@chat/app/v1/worker 的 Files。
// 能力清单：
// - `Messages` 表、`NEWEST` 查询、`PAGE` 常量；
// - `Store` 本地契约：messages 状态 + add/history 方法；
// - 默认 facet：serve Store（表 + 内存窗口）与 Room（每 principal 视图）；
// - `attachment` 辅助函数。
// 典型流程：
//   Room.post("hi") → Store.add → self.tx(tx.put(Messages)) → 提交后更新窗口 → 订阅者看到新消息；
//   Room.history({ before }) → Store.history → 表分页 → 倒序返回（旧→新）。
// 示例：Room.post("hi") 追加一条消息；Room.history({ before: n }) 读取更早的记录。
// 阅读顺序：先看表定义与 NEWEST，再看 Store 工厂里的 open/add/history，最后看 Room 的成员映射。
// 运行方式：随 worker 插件加载；不能单独执行。数据目录由 kit 按 worker 地址隔离。
// 设计要点：表没有 watch，因此实时窗口由唯一写者自己维护；读者看到的是 derive 出的状态成员。

// The chat plugin on a channel's worker: the room's messages in a table of the worker's store (every message kept),
// written and read by one local object. Tables have no watch, so the object keeps the live window itself: the newest
// 100 messages, read at activation and appended to after each post (it is the only writer); older ones are read by
// page on request. Each principal's `Room` posts as them and shares files through the kit's `Files` of this worker.

import {
	Attachment,
	arr,
	defineFacet,
	defineTable,
	int,
	json,
	local,
	lt,
	Message,
	method,
	num,
	obj,
	opt,
	query,
	Room,
	str,
} from "@chat/app/v1";
import { Files } from "@chat/app/v1/worker";

/** Every message of the channel, by its number. */
// defineTable 声明 SQL 表结构：
// - version 是表版本，结构变化时配合 evolveTable 迁移；
// - columns 是扁平列：标量直接映射，json(schema, {version}) 把一处 JSON 存成带版本/迁移的列；
// - key 指定主键列，id 唯一，因此 tx.put 重复 id 是更新而非插入。
// 列 schema 在声明与读写边界参与校验；表名/列名会拼进 SQL，声明期会检查名称规则。
const Messages = defineTable("chat.messages", {
	version: 1,
	columns: { id: int(), author: str(), text: str(), at: num(), file: opt(json(Attachment, { version: 1 })) },
	key: ["id"],
});

/** The messages, newest first. */
// query 是类型安全的查询构造器；orderBy 的访问器拿到行类型，second 参数是 "asc" | "desc"。
// NEWEST 只是一个查询描述（纯值），每次 page/where 时编译成 SQL。
const NEWEST = query(Messages).orderBy((message) => message.id, "desc");

/** How many messages the live window and a page of history hold. */
const PAGE = 100;

// local 契约：只在当前宿主（worker）内可见，没有 principal；params 为空表示每主机一个、
// 与宿主同生命周期的对象。持久化数据只能放在这种 local 空参数对象里（表在工厂中打开）。
// members.messages 是状态成员（数组 schema）；add/history 是方法，参数在调用边界校验。
const Store = local("chat.store", {
	version: 1,
	params: {},
	members: {
		messages: arr(Message),
		add: method(obj({ author: str(), text: str(), file: opt(Attachment) })),
		// before 可选：无值时取最新页，有值时取该 id 之前的一页（更旧）。
		history: method(obj({ before: opt(int()) }), arr(Message)),
	},
});

// facet setup 必须同步且只做声明；这里服务两个对象类型：本地 Store 与远程 Room。
export default defineFacet((host) => {
	// serve(localType, factory)：factory 返回成员对象本身，不需要 variant 包装。
	// _params 为空（工厂第二参是 self）；表句柄、可写状态等都在激活阶段由 self 提供。
	host.serve(Store, (_params, self) => {
		// self.table 返回表句柄；所有读写都要带 ctx，事务里则用 tx。
		const messages = self.table(Messages);
		// The newest messages (oldest first) and the next message's number: read once, then kept here.
		// self.writable 创建对象私有、可同步 set 的状态；初值 [] 是普通 JSON 值（按约定不可变）。
		const window = self.writable<Message[]>([]);
		// 下一个消息编号：进程内单调递增，避免查询 MAX(id)；初始化时由最新一页推导。
		let next = 1;
		// self.open 在激活阶段运行异步初始化（相当于原生资源打开），返回的关闭函数这里为空。
		// opener 成功前对象不会 live；失败会使对象进入失败状态并走重试规则。
		self.open(
			async (ctx) => {
				// page(查询, 条数, ctx) 返回 { items, next? }；NEWEST 是倒序，items[0] 是最新一条。
				const { items } = await messages.page(NEWEST, PAGE, ctx);
				// 窗口按“旧→新”保存，便于直接作为界面顺序；reverse 复制后反转，不修改 items。
				window.set([...items].reverse());
				// 下一编号 = 最新 id + 1；表为空时 ?? 0 得到 1。可选链避免 items[0] 不存在时访问 id。
				next = (items[0]?.id ?? 0) + 1;
			},
			// close 回调接收打开结果（此处无资源），对象结束/重试时调用；空实现即可。
			() => {},
		);
		return {
			// 状态成员必须是 Watchable；derive 订阅 window 并重新暴露，读者不能直接 set。
			messages: self.derive([window], ([value]) => value),
			// add 是 Store 的方法实现：参数已由 Chord 按 schema 校验，返回 null 表示没有结果。
			add: async ({ author, text, file }, ctx) => {
				// 条件展开：file 为 undefined 时不生成 file 字段，避免把 undefined 写进 JSON 列。
				const message = { id: next++, author, text, at: Date.now(), ...(file === undefined ? {} : { file }) };
				// self.tx 在对象自己的行上执行事务：tx.put 把整行写入/覆盖；提交后才是对其他读者可见。
				await self.tx(async (tx) => tx.put(messages, message), ctx);
				// In number order: two posts may commit in either order.
				// 两次 post 的提交完成顺序可能不同；按 id 升序排序保证窗口始终有序，再保留最后 PAGE 条。
				// window.set 是同步的，提交后的读者会收到一次状态更新。
				window.set([...window.value, message].sort((a, b) => a.id - b.id).slice(-PAGE));
				return null;
			},
			// history：before 为空取最新页；否则用 where(lt(...)) 追加 id < before 的条件。
			// lt 是查询表达式构造器，不是普通比较；where 返回新的 Query，不修改 NEWEST。
			history: async ({ before }, ctx) => {
				const older = before === undefined ? NEWEST : NEWEST.where((message) => lt(message.id, before));
				const { items } = await messages.page(older, PAGE, ctx);
				// 表按 desc 返回；reverse 后按“旧→新”交给调用方。
				return [...items].reverse();
			},
		};
	});
	// serve(remoteType, factory)：factory 接收 (params, principal, self)，返回 { variant, members }。
	// 每个 principal 得到自己的 Room 实例；实例工厂里声明的引用会随对象结束自动释放。
	host.serve(Room, (_params, principal, self) => {
		// self.get 声明依赖：Store 与 Files 都是本宿主对象；激活会等它们 live（并在需要时水合）。
		const store = self.get(Store, {});
		const files = self.get(Files, {});
		// 作者名只存在于 user principal；owner 没有 name，退回 kind 字符串。
		// 这里的 as 是编译期断言：运行时仍是原对象；principal 由认证链路产生，不是网络任意输入。
		const author = (principal as { readonly name?: string }).name ?? principal.kind;
		return {
			variant: "main",
			members: {
				// 把本地 Store 的状态重新暴露给远程读者；derive 在值变化时推送一次 diff。
				messages: self.derive([store.messages], ([messages]) => messages),
				// 方法委托：参数形状与 Room 契约一致，ctx 由 Chord 传入（调用者的取消与对象结束信号）。
				history: (page, ctx) => store.history(page, ctx),
				post: (text, ctx) => store.add({ author, text }, ctx),
				// 分块上传：begin/append 直接使用本 worker 的 Files；finish 后才产生正式附件 id。
				begin: (file, ctx) => files.begin(file, ctx),
				append: (chunk, ctx) => files.append(chunk, ctx),
				share: async ({ upload, text }, ctx) => {
					// finish 结束上传并返回文件 id；随后读取 Files 当前索引取得元数据。
					const id = await files.finish(upload, ctx);
					return store.add({ author, text, file: attachment(files.list.value, id) }, ctx);
				},
				// attachment 只查索引元数据，不读字节；找不到时抛错（服务器路由会映射成 404）。
				attachment: async (id) => attachment(files.list.value, id),
				// read 直接委托 Files.read：offset/length 由契约校验，单次最多 4 MiB（Files 实现上限）。
				read: (range, ctx) => files.read(range, ctx),
			},
		};
	});
});

// 函数说明：attachment 从文件索引中查 id。输入索引数组与附件 id；输出 Attachment（不含 created）。
// 错误：不存在时抛 Error（同宿主直接抛，跨链路会成为调用错误）。
// 示例：attachment(files.list.value, "f_123") → { id, name, mime, size }
// 说明：返回新对象而不是索引项引用，消息因此只携带稳定元数据，不包含存储细节。
/** The attachment `id` of the channel's files; throws when there is none. */
function attachment(list: readonly Attachment[], id: string): Attachment {
	// find 返回第一个匹配项；索引按约定不可变，这里不修改它。
	const file = list.find((each) => each.id === id);
	if (file === undefined) throw new Error(`no file ${id}`);
	// 显式挑字段：id 用参数而不是 file.id（两者应相同），并丢弃 created 等索引专用字段。
	return { id, name: file.name, mime: file.mime, size: file.size };
}
