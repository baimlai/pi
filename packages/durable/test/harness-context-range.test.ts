// 验证扫描期间出现新提交时，保留的上下文范围不会跳过尚未读到的条目。
import { describe, expect, it } from "vitest";
import { advanceRange, readContext, readContextFrom } from "../src/harness/context.ts";
import { SessionImpl } from "../src/session/session.ts";
import { MemoryStorage } from "../src/storage/memory.ts";
import { context } from "./session-support.ts";

// describe 注册用例分组；回调只注册测试，真正的异步流程由 it 执行。
describe("kept context ranges", () => {
	// 无参数、无返回业务值；用两道 Promise 闸门固定读写交错，最后关闭 Session。
	// 例：读到 first 后暂停，提交 missed，再提交 last；复用范围仍须读出三条。
	// await 或 expect 失败会令测试失败；这里只用内存存储，没有真实模型请求。
	it("is not advanced when an entry was committed while its scan ran off the line", async () => {
		// <void> 表示闸门只传递“已到达”的信号，不传递业务数据。
		const entered = Promise.withResolvers<void>();
		// release 由测试主体放行，避免依靠定时器猜测扫描进度。
		const release = Promise.withResolvers<void>();
		// extends 继承内存存储；只在一次扫描返回前插入暂停，存储行为仍由父类完成。
		class PausedStorage extends MemoryStorage {
			// false 时正常扫描；测试会在准备好 first 后把它设为 true。
			pause = false;
			// 接收父方法相同的参数，返回同一页；override 让 TS 核对确实覆盖了父方法。
			// Parameters<...> 提取参数元组，...args 收集/转交它；不是运行时参数校验。
			// 例：pause=true 时，父类取完页后等待 release，外部可在此期间写入 missed。
			override async scanEntries(...args: Parameters<MemoryStorage["scanEntries"]>) {
				// 先真正读取快照；暂停期间的新条目不会倒流进已经取得的 page。
				const page = await super.scanEntries(...args);
				// 只有被测试主体点名的下一次扫描需要停住。
				if (this.pause) {
					// 先复位，防止后续补扫也卡在同一闸门。
					this.pause = false;
					// 通知测试：父类已经读完，但 readContextFrom 还没收到结果。
					entered.resolve();
					// 等主体提交 missed 后再继续返回。
					await release.promise;
				}
				// 不改页的内容，确保测试只制造调度顺序，不伪造记录。
				return page;
			}
		}
		// 每个用例独享内存数据，Session 用它串行提交。
		const storage = new PausedStorage();
		const session = new SessionImpl(storage);
		// commit 的回调在事务里创建没有拥有者的会话；context 传递取消/遥测上下文。
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		// 初始只有 first，下一次扫描会以它为已知尾部。
		await session.commit((tx) => tx.appendEntry(conversation.id, { kind: "first" }), context);
		// 只暂停随后这次读取。
		storage.pause = true;
		// 不立即 await：把正在扫描的 Promise 留住，才能并发提交 missed。
		// 两个 undefined 分别表示读取当前上下文、没有可复用的旧范围。
		const read = readContextFrom(session, storage, conversation.id, context, undefined, undefined);
		// 确认扫描页已经取得，再插入扫描尚未包含的记录。
		await entered.promise;
		await session.commit((tx) => tx.appendEntry(conversation.id, { kind: "missed" }), context);
		// 放行扫描，然后用解构只取返回对象里的 range。
		release.resolve();
		const { range } = await read;
		// ?. 是可选链；运行时检查范围被标记为非最新，而非仅靠 TS 类型。
		expect(range?.current).toBe(false);
		// 若错误地直接推进到 last，就会永远漏掉上面的 missed。
		const last = await session.commit((tx) => tx.appendEntry(conversation.id, { kind: "last" }), context);
		// Not current: left as it is, so the next read extends it from Storage instead of skipping "missed".
		// ! 仅消除 TS 的 undefined 提示，不生成校验；toBe 证明保留同一对象。
		expect(advanceRange(range!, [last])).toBe(range);
		// 再读时从存储补齐范围，另做一次从头读取作为对照。
		const again = await readContextFrom(session, storage, conversation.id, context, undefined, range);
		const fresh = await readContext(session, storage, conversation.id, context);
		// map 只抽 kind 比较顺序；toEqual 再比较完整派生视图。
		expect(again.view.entries.map((entry) => entry.kind)).toEqual(["first", "missed", "last"]);
		expect(again.view).toEqual(fresh);
		// 此次扫描期间无新提交，范围才可以用于增量推进。
		expect(again.range?.current).toBe(true);
		// 结束 Session 的资源生命周期，不销毁其他测试的数据。
		await session.close(context);
	});
});
