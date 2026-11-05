// 文件导读
// 所属：packages/chord/test/examples/60-session-sync，示例 60 被同步的会话定义与会话辅助函数。
// 作用：定义一台 host 上的会话对象：
//   - messages 表：n（序号，同时是主键）、role、text；
//   - title 持久化单例文档（persist: true）：初始 "untitled"，每次 rename 修改；
//   - local 契约 example.session：title 状态成员、say/rename/transcript 三个方法；
//   - withSession：在 store 上短暂打开一台 host 执行 work，结束即关闭（同一 store 同时只能有一台打开的 host）；
//   - describe：读取标题与全部消息并拼成一行，用于比较笔记本与 Radius 两台副本。
// 上游：main.ts 安排同步步骤；radius.ts 的 drive 也在副本上用 withSession 写入。
// 下游：Chord 真实 API：contracts 的 local/method/obj/arr/str/int、documents 的 defineState、store 的
//   defineTable/query、host 的 createHost/defineFacet。
// 能力清单：Messages、Title、Session、facet、withSession、describe。
// 运行方式：由 main.ts 使用；不能单独执行。
// 预期：无命令行输出；describe 返回形如 `"Fix the parser" [1 user: ... | 2 assistant: ...]` 的一行。
// 提交与序号：首次在空 store 上激活 host 会先写一次 messages 表定义（seq 1）；之后每条 say 一次提交，
//   每次 rename 一次提交（title 的首次修改会创建文档）。示例第 1 步就是 1 次激活 + rename + 2 条消息 = lastSeq 4。
// 校验边界：方法参数在提供方按编译后的封闭 schema 校验（say/rename/transcript）；state 的初始值在 hydration
//   时按 schema 校验；state 值与方法返回值不做运行时校验。类型由 schema 推导，跨进程时依赖双方版本一致。
// 注意：say 的 n = count + 1 不是原子操作；并发 say 可能拿到同一个 n，最终由主键冲突拒绝其中一次。
//   示例按顺序调用，避免这种竞争。
// 阅读顺序：先看 Messages/Title 定义，再看 Session 契约、withSession、describe。

// The session example 60 syncs: one object per host with a persisted title document and a `messages` table, and a
// helper running a host on a store for the length of some work (one open host per store; a closed host holds no
// claims, so a batch may apply to its store afterwards).
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
// 契约构造器：local 定义对象契约；method 的方法参数/返回值 schema；obj/arr/str/int 是 schema 叶子/组合。
import { arr, int, local, method, obj, str } from "../../../src/contracts/index.ts";
// defineState：声明一个文档（这里是持久化单例 state）。
import { defineState } from "../../../src/documents/index.ts";
// createHost：客户端/服务端通用的宿主；defineFacet：把一组服务打包成可 load 的 facet；Reference 仅类型。
import { createHost, defineFacet, type Reference } from "../../../src/host/index.ts";
// defineTable/query：store 中的表定义与查询构造；Store 仅类型。
import { defineTable, query, type Store } from "../../../src/store/index.ts";

// messages 表：版本 1；列 n/role/text；主键 ["n"]（顺序即复合主键的列序）。
// 表定义会被 host 在首次激活时写入 store（版本与列计划用于之后的兼容检查），这也是一次提交。
const Messages = defineTable("messages", {
	version: 1,
	columns: { n: int(), role: str(), text: str() },
	key: ["n"],
});

// title：一个持久化单例文档。name "title" 是受限制的名称；schema 决定值形状；version 参与存储校验；
// initial 只在不存在时使用；persist: true 要求同时给出 checkpointWhen。
// checkpointWhen 返回 false：除首次创建（和版本升级）外，每次修改只存 delta，不整根存 base。
// 示例的标题很小，存 delta 足够；真实应用可按修改累积量选择检查点（W9 不做自动压缩）。
const Title = defineState("title", {
	schema: obj({ text: str() }),
	version: 1,
	initial: () => ({ text: "untitled" }),
	persist: true,
	checkpointWhen: () => false,
});

/** The session's contract: its title, a message (one commit each), a rename (one commit) and the transcript. */
// 会话契约：name 与 version 一起构成跨进程的类型/兼容身份；params 为空表示地址只有默认对象。
// members.title 是状态成员（服务端以 self.state(Title) 提供）；成员名与状态名可以不同（这里都叫 title）：
//   契约成员 `title: obj(...)` 对外暴露值的形状，服务端仍可从不同名字的 Title 文档提供它。
// say 的参数由 obj({role,text}) 校验，返回 int；rename 接收 str 并返回 null；transcript 参数为空对象，返回 str 数组。
export const Session = local("example.session", {
	version: 1,
	params: {},
	members: {
		title: obj({ text: str() }),
		say: method(obj({ role: str(), text: str() }), int()),
		rename: method(str()),
		transcript: method(obj({}), arr(str())),
	},
});

// facet 工厂：host.load 时执行一次；host.serve 为该对象注册 Session 契约的服务实现。
// 服务回调的第二个参数 self 是“本对象”的服务 API：self.table/self.state 取得表与状态句柄，
// self.tx 执行提交；第一个参数是地址（本示例不需要）。
const facet = defineFacet((host) => {
	host.serve(Session, (_, self) => {
		// self.table 返回表句柄（读写行）；self.state 返回状态句柄（读 value、change、watch）。
		const messages = self.table(Messages);
		const title = self.state(Title);
		// 可复用的查询：messages 全表按 n 升序。query 只描述查询，不执行；每次 count/rows 传入它。
		const all = query(Messages).orderBy((m) => m.n, "asc");
		return {
			// title 状态成员：对外暴露 { text } 的当前值（状态更新会推送）。
			title,
			// say：读当前行数再 +1 作为 n，然后在一笔事务里 put 一行。返回 n 给调用方。
			// 注意 count 与 put 不在同一原子步骤：示例顺序调用，所以没有并发竞争。
			say: async ({ role, text }, ctx) => {
				const n = (await messages.count(all, ctx)) + 1;
				// self.tx 把回调里的写入合成一次提交；tx.put 的参数是 (表句柄, 行)。ctx 传递取消与追踪。
				await self.tx(async (tx) => tx.put(messages, { n, role, text }), ctx);
				return n;
			},
			// rename：修改持久化文档 title。change 的回调拿到可变的 draft（副本），回调成功后生成一次提交；
			// 方法本身返回 null（契约未声明返回值时 void/null 皆可，这里显式返回）。
			rename: async (text, ctx) => {
				await title.change((draft) => {
					draft.text = text;
				}, ctx);
				return null;
			},
			// transcript：遍历查询结果（按 n 升序），每行格式化成 "n role: text" 返回。
			// rows 返回 AsyncIterable，逐行读取，不一次性保留全部行；示例数据量小。
			transcript: async (_, ctx) => {
				const lines: string[] = [];
				for await (const m of messages.rows(all, ctx)) lines.push(`${m.n} ${m.role}: ${m.text}`);
				return lines;
			},
		};
	});
});

/** Runs a host serving the session on `store` until `work` is done, then closes the host (the store stays open). */
// 函数说明：在给定 store 上打开一台 host，加载会话 facet，取得 Session 引用交给 work，最后关闭 host。
// 输入：store（保持打开）、work（接收 Reference<typeof Session> 的异步函数）。
// 输出：work 的返回值；错误原样传播。副作用：创建/关闭 host（关闭会释放 store claim，但 store 仍可用）。
// 流程：createHost → load facet → get Session → await work → finally 关闭 host。
// 示例：await withSession(store, async (s) => { await s.say({...}, ctx) })
// 说明：一个 store 同时只能被一台打开的 host 持有 claim；sync/pull 的 applyBatch 要求没有打开的 host，
//   因此示例总在 withSession 返回后再同步。
export async function withSession<T>(
	store: Store,
	work: (session: Reference<typeof Session>) => Promise<T>,
): Promise<T> {
	// onError 接收后台错误（例如状态推送/订阅处理中的异常）；这里只打印，不中断示例。
	const host = createHost({ store, onError: (error) => console.error("background error:", error) });
	try {
		// load 的 facet 条目：name 是客户端可见的模块名；facet 是上面的工厂。load 完成前不能 get。
		await host.load([{ name: "@example/session", facet }], context);
		// get 取得本地（同 host）契约的引用；等待引用 ready 后执行 work。
		return await work(await host.get(Session, {}, context));
	} finally {
		// 无论 work 成功/失败都关闭 host：释放对象、claim 与后台任务；store 由调用方负责关闭。
		await host.close(context);
	}
}

/** The session as one line: its title and its messages. */
// 函数说明：用一台临时 host 读取会话并拼成一行。输入 store；输出 Promise<string>。
// 流程：withSession → transcript 方法 → 读 title 状态成员的当前值 → 标题加引号，消息用 " | " 连接。
// 示例：`"Fix the parser" [1 user: the parser drops comments | 2 assistant: found it in lexer.ts]`
// 副作用：短暂打开 host（若 store 已被另一台 host 打开，会因 claim 冲突失败）。
export function describe(store: Store): Promise<string> {
	return withSession(store, async (session) => {
		// transcript 是远程方法（本地 host 时也经过契约调用边界，参数按 schema 校验）。
		const lines = await session.transcript({}, context);
		// title 是状态成员：`.value` 是当前快照（本示例读取时 host 已收到最新状态）。
		return `"${session.title.value.text}" [${lines.join(" | ")}]`;
	});
}
