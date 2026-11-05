// Documents and transactions: an object's in-memory JSON state, written atomically.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/02-documents.ts
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { arr, int, local, method, obj, opt, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";

// 后台上下文没有取消信号，本例所有异步文档操作仍显式传它。
const context = BACKGROUND_CONTEXT;

// A singleton document: one per object, `initial()` until written.
// 定义待办单例文档：每个拥有它的对象各有一份；本例没有 persist，因此只保存在内存。
const Todos = defineState("todos", {
	// obj/arr/int/str 构造 JSON schema，同时推导 draft 的开发期类型；不会在每次提交时重验整个文档。
	schema: obj({ items: arr(obj({ id: int(), text: str() })), next: int() }),
	version: 1,
	// 无参数的初始化回调返回全新初值；首次结果按 schema 校验，例如第一个待办会使用 id=1。
	initial: () => ({ items: [], next: 1 }),
});
// A keyed document: many per object, one per string key, absent until written.
// 定义按字符串键区分的备注；读取不存在的键不会自动创建文档。
const Notes = defineState("notes", {
	// 每份备注的根是含字符串 body 的对象。
	schema: obj({ body: str() }),
	version: 1,
	// 为缺失键的草稿提供空正文，只有草稿发生变化才创建记录。
	initial: () => ({ body: "" }),
	// 字面量 true 让返回句柄的类型要求读写时传 key，而不是单例的 value。
	keyed: true,
});

// 声明空参数的本地存储对象，随宿主存在；members 是外部可读状态与可调用方法。
const Store = local("example.todos", {
	version: 1,
	params: {},
	members: {
		todos: obj({ items: arr(obj({ id: int(), text: str() })), next: int() }),
		// text 必填、note 可省略，返回整数 id；opt 允许缺字段，并不自动补默认值。
		add: method(obj({ text: str(), note: opt(str()) }), int()),
		// 查询方法接收数字 id，向外返回字符串而不是文档句柄。
		note: method(obj({ id: int() }), str()),
		// 无参数无结果的方法在调用时只传 ctx，实际实现用 null 表示无结果。
		clear: method(),
	},
});

// setup 接收声明接口，登记 Store 工厂并返回 void；load 才执行 setup。
const facet = defineFacet((host) => {
	// 工厂忽略空参数 _，用 self 声明自有文档和方法；无 I/O，返回契约要求的实现。
	host.serve(Store, (_, self) => {
		// 取得单例句柄，value 可读已提交值，change/retire 进入本对象的事务队列。
		const todos = self.state(Todos);
		// 取得 keyed 句柄；每个 String(id) 对应不同备注。
		const notes = self.state(Notes);
		return {
			// A singleton handle is a watchable, so it can be a state member as it is.
			// 属性简写暴露同一个单例句柄，调用者通过 store.todos 读取和观察。
			todos,
			// add 接收正文、可选备注和调用上下文；事务提交后返回新 id。
			// 流程是同时修改待办和备注；回调抛错或提交前取消时两者都不采用，例如带备注的第一项返回 1。
			add: async ({ text, note }, ctx) => {
				// One transaction over two documents: both change together, or neither does.
				// self.tx 串行化本对象写入；异步回调的返回值只有成功提交后才交给外层。
				const id = await self.tx(async (tx) => {
					// 等待待办草稿；修改草稿记录操作，不会立即改对外可读值。
					const draft = await tx.draft(todos);
					// 后缀 ++ 先取旧 next 作为 id，再把草稿中的 next 加一。
					const id = draft.next++;
					// 向草稿列表追加含 id、text 的对象；两项属性采用变量同名简写。
					draft.items.push({ id, text });
					// 只有调用者传了 note 才草拟备注；String(id) 把数字变成键，空字符串备注也会写入。
					if (note !== undefined) (await tx.draft(notes, String(id))).body = note;
					// Return plain values: drafts are revoked once the transaction settles.
					// 返回普通数字，不把事务结束后会被撤销的草稿泄漏出去。
					return id;
				}, ctx);
				// 返回普通数字，不把事务结束后会被撤销的草稿泄漏出去。
				return id;
			},
			// Read keyed documents outside transactions; an absent one is `undefined`.
			// 查询回调按字符串键异步读取；?. 在缺文档时停止访问，?? 仅在缺值时返回 (none)，空正文不会被替换。
			note: async ({ id }, ctx) => (await notes.get(String(id), ctx))?.body ?? "(none)",
			// clear 无业务参数，只接收 ctx；先退休单例，再逐键退休备注，返回 null。
			// 这些是多个独立事务，因此它们并非一个整体原子清空；任何失败向调用者传播。
			clear: async (ctx) => {
				// Shorthands for one document: retire resets a singleton to `initial()`.
				// 单例退休后读回 initial()，待办变空且 next 回到 1。
				await todos.retire(ctx);
				// for await 消费异步键迭代器，每轮等待当前键删除完再处理下一项。
				for await (const key of notes.keys(ctx)) await notes.retire(key, ctx);
				// 返回无结果方法约定的 null；async 会把它包装成已完成的 Promise。
				return null;
			},
		};
	});
});

// 创建宿主，把后台故障写 stderr；调用失败仍由对应 await 抛出。
const host = createHost({ onError: (error) => console.error("background error:", error) });
// 加载插件声明并等待 Store 的首次启动结果。
await host.load([{ name: "@example/todos", facet }], context);
// 获取已就绪的 Store 引用，后面只经公开方法改文档。
const store = await host.get(Store, {}, context);

// 提交第一项和其备注，保存返回 id 供随后查询。
const first = await store.add({ text: "buy milk", note: "the oat one" }, context);
// 第二项省略 note，因此不会创建对应备注键。
await store.add({ text: "call Anna" }, context);
// 读取提交后的待办列表，此值应按不可变约定使用。
console.log("todos:", store.todos.value.items);
// 调用公开查询方法，打印第一项的备注正文。
console.log("note of", first, "->", await store.note({ id: first }, context));

// 等待多个清理步骤完成，再观察结果。
await store.clear(context);
// 展示空待办初值和已不存在的备注对应的 (none)。
console.log("after clear:", store.todos.value, await store.note({ id: first }, context));

// 结束宿主；内存文档随对象消失。
await host.close(context);
