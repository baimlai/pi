// Tests of claims (slice 6b "owner names and claims", "claims per table and per document namespace"): a table by its
// SQL name and documents by owner and namespace, once per store; released by their claimant's end; none taken while a
// batch applies.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { int, local, obj, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { Claims } from "../../src/store/claims.ts";
import { defineTable } from "../../src/store/table.ts";
import { loaded, memoryStore } from "../support.ts";

// claim 是同一 store 内的独占占用记录；比较 claimant 对象引用，label 仅用于错误文字。
describe("claims", () => {
	// 输入两个 claimant，检查同资源重复占用、不同资源共存和释放；仅修改局部 Claims。
	// 例如 A 两次占用 x:edits 可接受，B 同时占用该表应被拒绝，A 释放后 B 可接手。
	it("refuse a second claimant of a table or of an owner's namespace; one claimant may claim again", () => {
		// 创建空占用表，table 与 documents 使用不同的内部 key 前缀。
		const claims = new Claims();
		// A/B 是不同对象身份，label 是给诊断消息使用的可读名字。
		const a = { label: "A" };
		// 第二个 claimant 用于模拟另一个正在持有自己内存状态的 owner。
		const b = { label: "B" };
		// 首次登记表占用；再次由同一个 a 请求也是允许的，不增加第二个 owner。
		claims.table("x:edits", a);
		// 首次登记表占用；再次由同一个 a 请求也是允许的，不增加第二个 owner。
		claims.table("x:edits", a);
		// 文档资源的键包含 owner 与 namespace，与同 owner 的表占用互不混淆。
		claims.documents("x", "chord", a);
		// 不同 claimant 请求同一表，运行时错误应指出当前持有人 A。
		expect(() => claims.table("x:edits", b)).toThrow("claimed by A");
		// 同 owner 同 namespace 的文档也不允许第二个 claimant。
		expect(() => claims.documents("x", "chord", b)).toThrow("claimed by A");
		// Another namespace of the same owner, another table: no collision.
		// 不同 namespace 不冲突，允许 B 占用 x/session。
		claims.documents("x", "session", b);
		// 不同 SQL 表名可被 B 独立占用。
		claims.table("x:entries", b);
		// held 只表示至少存在一项占用，不表示具体有多少表或 namespace。
		expect(claims.held).toBe(true);
		// 按 claimant 一次释放它的所有资源，B 自己的资源仍保留。
		claims.release(a);
		// A 释放后，B 现在可以接手原先冲突的表。
		claims.table("x:edits", b);
		// 释放 B 及它后来接手的资源。
		claims.release(b);
		// 所有占用清空；锁定状态本身不算资源占用。
		expect(claims.held).toBe(false);
	});

	// 取得 lock 返回的解锁函数，验证锁内不许新增占用，解锁后恢复；无异步或磁盘操作。
	// 例如 applyBatch 期间锁住 store，避免 owner 读取旧内存状态后再被复制数据改写。
	it("are refused while locked (a batch applies), taken again once unlocked", () => {
		// 创建空占用表，table 与 documents 使用不同的内部 key 前缀。
		const claims = new Claims();
		// 这个 owner 只作为占用身份和诊断标签。
		const owner = { label: "A" };
		// lock 设置禁止占用标志并返回 () => void；调用返回函数才会解除。
		const unlock = claims.lock();
		// 即使没有现有持有人，批量应用锁仍然拒绝表占用。
		expect(() => claims.table("x:edits", owner)).toThrow("while a batch applies");
		// 文档 namespace 同样受该锁保护。
		expect(() => claims.documents("x", "chord", owner)).toThrow("while a batch applies");
		// 所有占用清空；锁定状态本身不算资源占用。
		expect(claims.held).toBe(false);
		// 执行闭包撤销锁定，无需给它传 owner。
		unlock();
		// 解锁后同一请求可以登记，后续 held 应变 true。
		claims.table("x:edits", owner);
		// held 只表示至少存在一项占用，不表示具体有多少表或 namespace。
		expect(claims.held).toBe(true);
	});

	// 把持久化文档和表声明在无参数 local 对象内，检查激活占用与关闭释放。
	// 例子中 notes.store 关闭后 other 可接手表；Promise<void> 等待宿主加载、获取和关闭。
	it("an object claims its tables and documents when it declares them, and releases them at its end", async () => {
		// 创建此测试独有的 SQLite 内存 store，再交给 host 使用。
		const store = await memoryStore();
		// 定义持久化单例 {n:0}；initial 回调每次需要初始值时创建对象，首次结果会被校验。
		const Note = defineState("note", {
			schema: obj({ n: int() }),
			version: 1,
			initial: () => ({ n: 0 }),
			// 要求文档写入 store；checkpointWhen 恒 true，意味着改变时存完整 base，当前例子未做写入。
			persist: true,
			checkpointWhen: () => true,
		});
		// 定义只含 id 的表，self.table 会在该对象名下准备它。
		const Edits = defineTable("edits", { version: 1, columns: { id: str() }, key: ["id"] });
		// params:{} 使 local 对象随 host 存活，满足持久化需要稳定身份的要求。
		const Notes = local("notes.store", { version: 1, params: {}, members: {} });
		// loaded 将下面 setup 包装成测试 facet，并把 store 接到新 host。
		const { host } = await loaded(
			// setup 收到声明用 host；回调的主体返回 serve 的结果，不在此打开外部资源。
			(h) =>
				// 对象工厂收到空 params（_ 忽略）与 self，声明数据并返回空成员对象。
				h.serve(Notes, (_, self) => {
					// 声明文档时占用 notes.store/chord namespace。
					self.state(Note);
					// 声明表时占用 notes.store:edits，并在激活时准备表结构。
					self.table(Edits);
					// 合同没有公开成员，所以工厂返回空对象；不是把文档或表暴露给调用方。
					return {};
				}),
			// 选项简写等价于 {store:store}，loaded 会把该存储传给 createHost。
			{ store },
		);
		// 等待 notes.store 可用；这里获取引用是为了确认激活完成。
		await host.get(Notes, {}, context);
		// 已激活对象仍占用表，外部 claimant 的请求应被拒绝。
		// 新 claimant 能登记原表；本例结尾没有显式关闭 store 或释放这项测试占用。
		expect(() => store.claims.table("notes.store:edits", { label: "other" })).toThrow("claimed by notes.store");
		// 同一对象声明的持久化 namespace 也仍被占用。
		expect(() => store.claims.documents("notes.store", "chord", { label: "other" })).toThrow("claimed");
		// 关闭宿主会结束对象并释放它的 claims；host 本身不负责关闭 app 提供的 store。
		await host.close(context);
		// 检查对象结束后没有留下占用。
		expect(store.claims.held).toBe(false);
		// 新 claimant 能登记原表；本例结尾没有显式关闭 store 或释放这项测试占用。
		store.claims.table("notes.store:edits", { label: "other" });
	});
});
