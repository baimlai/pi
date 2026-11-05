// 用纯内存记录检查会话尾部缓存：首次读取、提交更新、分叉、head 截止点和数量上限。
import { describe, expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import { ConversationTails, type HeadMarker } from "../src/session/conversation-tails.ts";
import type { ConversationId, EntryId, EntryRecord, StorageWrite } from "../src/types.ts";

// 把测试数字标为会话 ID；<ConversationId> 是泛型类型实参，不在运行时验证数字。例如 conversation(1) 仍是数字 1。
const conversation = (id: number) => idFromNumber<ConversationId>(id);
// 同样给条目 ID 加静态品牌，防止开发时把两种 ID 混用；没有存储或分配副作用。
const entryId = (id: number) => idFromNumber<EntryId>(id);

// 用条目号、会话号及可选 head 构造一次写入，不实际提交。
// 例如 entry(11, 1, 10) 表示会话 1 中条目 11 把上下文起点设为 10；head? 可省略，不检查引用是否存在。
function entry(id: number, conversationId: number, head?: number): StorageWrite {
	// EntryRecord 注解检查对象字段；readonly 只限制 TypeScript 写法，不会自动冻结对象。
	const value: EntryRecord = {
		// 分别转换两种 ID；运行时仍然是原来的数字。
		id: entryId(id),
		conversationId: conversation(conversationId),
		// note 是测试使用的条目类别，不携带模型消息。
		kind: "note",
		// 展开运算符只在提供 head 时添加该字段；省略字段与显式 undefined 不同。
		...(head === undefined ? {} : { head: entryId(head) }),
	};
	// type 是 StorageWrite 联合类型的判别字段，value 才是缓存读取的条目。
	return { type: "entry", value };
}

// 哨兵读取函数：每次调用都返回拒绝的 Promise，借此发现本不该发生的存储读取。
// Promise<never> 表示没有成功返回值；只有被调用才产生 Error("read")，声明本身不会拒绝。
const never = (): Promise<never> => Promise.reject(new Error("read"));

// describe 的同步回调注册五个用例，不连接数据库；断言失败会由 Vitest 报告。
describe("conversation tails", () => {
	// 用读取计数器证明首次读取一次，随后命中缓存；再模拟提交让尾 ID 从 5 前进到 9。
	it("reads once, then follows the commits", async () => {
		// 每个用例独立创建缓存，避免其他用例的条目污染结果。
		const tails = new ConversationTails();
		// let 允许异步读取回调累加次数。
		let reads = 0;
		// 假存储读取：返回已知的尾 ID 5；async 自动将返回值包装为 Promise。
		const read = async () => {
			reads++;
			return entryId(5);
		};
		// 第一次委托 read，第二次复用已知尾部；await 等待各次查找完成。
		expect(await tails.latest(conversation(1), read)).toBe(5);
		expect(await tails.latest(conversation(1), read)).toBe(5);
		// 不只验证返回值，还验证底层读取未重复执行。
		expect(reads).toBe(1);
		// apply 直接模拟 Session 发布条目，不经过真实 Storage.commit。
		tails.apply([entry(9, 1)]);
		// never 若被调用会让用例失败；因此同时证明提交后无需回读。
		expect(await tails.latest(conversation(1), never)).toBe(9);
	});

	// 根会话能直接判断为空；分叉会话可能继承父历史，要交给读取函数决定。
	it("knows a new root conversation is empty, and a fork only once read or written", async () => {
		const tails = new ConversationTails();
		// 一批中建立根 2 和从父 2 的条目 4 分出的子会话 3。
		tails.apply([
			{ type: "conversation", value: { id: conversation(2) } },
			{
				type: "conversation",
				value: { id: conversation(3), parent: { conversationId: conversation(2), at: entryId(4) } },
			},
		]);
		// 根会话的最新条目和 head 均不存在，且不能触发哨兵读取。
		expect(await tails.latest(conversation(2), never)).toBeUndefined();
		expect(await tails.marker(conversation(2), undefined, never)).toBeUndefined();
		// 假读取提供继承尾部 4；这里只证明缓存允许读取，不验证父链的真实存储扫描。
		expect(await tails.latest(conversation(3), async () => entryId(4))).toBe(4);
	});

	// 最新 head 只能回答不早于它的截止点；早期查询结果不能覆盖最新 marker 的缓存。
	it("answers a cutoff from the newest marker only at or after it", async () => {
		const tails = new ConversationTails();
		// 条目 11 带 head=10，因此最新 marker 是 11，而非 head 指向的 10。
		tails.apply([{ type: "conversation", value: { id: conversation(1) } }, entry(10, 1), entry(11, 1, 10)]);
		// as 是静态断言，不会检查 undefined；本用例的上一行已建立 marker。
		const marker = (await tails.marker(conversation(1), undefined, never)) as HeadMarker;
		expect(marker.id).toBe(11);
		// 截止点 12 晚于 marker 11，直接命中；?. 避免结果为空时访问 id 抛错。
		expect((await tails.marker(conversation(1), entryId(12), never))?.id).toBe(11);
		// An older cutoff may have an older marker: read, and not kept.
		// 用回调返回 undefined 模拟截止点 10 之前没有 head；每次调用都计数。
		let reads = 0;
		const older = async () => {
			reads++;
			return undefined;
		};
		// 两次相同的旧查询均读取，而不是把旧查询的“没有 marker”当成全局最新结果。
		expect(await tails.marker(conversation(1), entryId(10), older)).toBeUndefined();
		expect(await tails.marker(conversation(1), entryId(10), older)).toBeUndefined();
		expect(reads).toBe(2);
		// 不带截止点仍然读到原有最新 marker，证明旧查询没有冲掉它。
		expect((await tails.marker(conversation(1), undefined, never))?.id).toBe(11);
	});

	// 写入超过容量的会话，验证保留数量；这里不逐项验证淘汰顺序或堆内存字节数。
	it("keeps a bounded number of conversations, fewer with markers", () => {
		const tails = new ConversationTails();
		// 每个会话两条条目，第二条带 head；乘二确保测试条目号互不冲突。
		for (let id = 1; id <= 5000; id++) tails.apply([entry(2 * id, id), entry(2 * id + 1, id, 2 * id)]);
		// 尾部只存 ID，容量较大；marker 存完整记录，独立限制为 256 个。
		expect(tails.size).toBe(4096);
		expect(tails.markers).toBe(256);
	});

	// apply 保留 marker 时会冻结传入记录本身；这里用 Object.isFrozen 检查顶层冻结。
	it("freezes the markers it keeps", () => {
		const tails = new ConversationTails();
		const write = entry(2, 1, 1);
		// 因为 head 存在，该写入会进入 marker 缓存并触发冻结。
		tails.apply([write]);
		// 断言只帮助 TS 取 value，不做运行时转换；此用例没有验证深层子对象冻结。
		expect(Object.isFrozen((write as { value: object }).value)).toBe(true);
	});
});
