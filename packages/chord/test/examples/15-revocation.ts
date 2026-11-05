// Revocation: the app says which revocations apply to a principal (`revokedBy`, the same function on every host);
// `host.revoke(r)` ends that principal's objects at once, whatever references remain, closes its child links (tabs) and
// sends `revoke` down every route link, where each worker applies it with its own `revokedBy`. Nothing is replayed.
// What ends gets the error `forbidden` with reason `revoked` (a UI can say "access revoked"): holders get it in `gone`,
// running handlers in their aborted context.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/15-revocation.ts
// 文件导读
// 所属包与示例系列：packages/chord/test/examples，Chord v2 示例 15，对应 slice 4b（撤销、跨宿主传播）。
// 演示什么：应用用 revokedBy 定义“哪些撤销值作用于哪个 principal”；server.revoke 立即结束该 principal 的对象、
//   关闭其子链路（tab），并沿路由链路把 revoke 下发给 worker；worker 用自己的 revokedBy 应用。已被撤销的会话不会
//   补发给后来新建的 worker。运行中的处理器收到 forbidden/revoked 的中止原因，持有者看到引用状态改变。
// 上游/下游：文件顶部命令启动；下游使用 src/host 的 createHost/route/revoke/references、src/contracts 的
//   remote/local、src/link 的 memoryLinkPair。示例全在进程内运行，无外部服务。
// 能力清单（按演示的机制）：
// - revokedBy：(principal) => Revocation[]；guest 同时受 grant 与 session 两种撤销值约束，其他 principal 返回空数组。
// - createHost<P, Revocation>：第二个泛型参数固定撤销值类型；server 与每个 worker 传入同一个 revokedBy。
// - host.revoke(r, ctx)：撤销后目标 principal 的对象立即结束，剩余引用不能保活；server 关闭对应的 tab 链路。
// - 跨路由传播：revoke 沿 route 链路发送，worker 端再次用 revokedBy 计算并结束对象。
// - 错误呈现：处理器 context 以 forbidden/revoked 中止；调用方的挂起调用因链路关闭而 unavailable；
//   tab 的引用回到 loading，需要重新认证/建立链路才能再次访问。
// - host.references(Type)：按引用列出现存持有者，撤销前后数量与 principal 的变化可观察。
// - 不重放：撤销之后才 resolve 的 S2 worker 不会收到历史撤销，新对象正常 live。
// 典型运行顺序：建带 revokedBy 的 server 与路由 -> 三个 tab（两个 guest g1、一个 owner）并发创建 -> 各自 get S1 ->
//   guest 写一条并启动 follow -> 查看 worker 上 S1 的引用数 -> revoke {grant:"g1"} -> 观察 tab 状态、follow 拒绝、
//   owner 不受影响、引用列表只剩 owner -> owner 访问 S2（新 worker，live）-> 关闭所有宿主。
// 示例（符合真实签名）：
//   const revokedBy = (p: P): Revocation[] => p.kind === "guest" ? [{ grant: p.grant }, { session: p.session }] : [];
//   const server = createHost<P, Revocation>({ address: Server(), principal: { kind: "server" }, revokedBy, onError });
//   server.revoke({ grant: "g1" }, context); // guest g1 的对象、链路与远端绑定立即结束
// 运行方式与环境：在 packages/chord 下执行文件顶部命令；纯进程内、无环境变量；约几十毫秒完成。
// 预期输出：worker: Notes for guest g1；worker: Notes for owner（两个 guest tab 共享同一 principal 的对象，只激活一次）；
//   worker S1 references: 3；worker: guest's follow aborted: forbidden/revoked；guest tab: loading ...；
//   guest's follow call: unavailable；owner tab: live []；worker S1 references: [ 'owner' ]；
//   worker: Notes for owner（S2）；owner on S2: live。
// 对应测试与文档：packages/chord/test/host/revocation.test.ts、test/remote/host-link.test.ts；
//   slices.md 的 slice 4b；设计文档中关于 revokedBy 与 forbidden/revoked 的章节。
// 建议阅读顺序：先看 P/Revocation/revokedBy 与 Notes 契约，再看 notesFacet 的 follow（观察中止原因），
//   随后看 server 的 route 与 tab 辅助函数，最后按 2-4 步读撤销传播与不重放。
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { arr, hostKind, method, obj, remote, str } from "../../src/contracts/index.ts";
import type { ChordError } from "../../src/data/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, type Host } from "../../src/host/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";

// 后台上下文；revoke 与 get 都显式传入。
const context = BACKGROUND_CONTEXT;

/** The app's principals: a guest holds a grant to one session; the server and its workers act as themselves. */
// P 是四种 principal；guest 额外带 grant 与会话，撤销值可以按其中任一匹配。
type P =
	| { kind: "owner" }
	| { kind: "guest"; grant: string; session: string }
	| { kind: "server" }
	| { kind: "worker"; session: string };

/** What the app revokes: a grant, or everything of a session. */
// Revocation 是应用自定义的撤销值联合：按 grant 或按 session；判别靠存在哪些字段。
type Revocation = { grant: string } | { session: string };

/** The same function on every host: a guest is revoked by its grant and by its session. */
// revokedBy 接收 principal，返回适用于它的撤销值列表；非 guest 返回空数组。
// 三元表达式先按 kind 窄化，guest 分支才有 grant/session 字段。
const revokedBy = (p: P): Revocation[] => (p.kind === "guest" ? [{ grant: p.grant }, { session: p.session }] : []);

// Server 无参数；Session 以 id 为参数。
const Server = hostKind("server");
const Session = hostKind("session", { id: str() });

// Notes 远端契约：按 session 寻址，all 变体暴露 notes、add 与 follow。
const Notes = remote("example.notes", {
	version: 1,
	params: { session: str() },
	// hostAddress 把 session 映射为 Session 地址。
	hostAddress: ({ session }) => Session({ id: session }),
	variants: {
		all: { state: { notes: arr(str()) }, methods: { add: method(obj({ text: str() })), follow: method() } },
	},
});

// 每个 worker 一份内存文档；初始为空列表。
const NotesDoc = defineState("notes", { schema: obj({ list: arr(str()) }), version: 1, initial: () => ({ list: [] }) });

// notesFacet 是 worker 上的插件：所有 principal 共享同一变体，身份只用于日志与撤销。
const notesFacet = defineFacet<P>((host) => {
	host.serve(Notes, (_, principal, self) => {
		const doc = self.state(NotesDoc);
		// 模板字符串内嵌套三元表达式：guest 后追加 grant，其他 principal 留空；只影响日志。
		console.log(`  worker: Notes for ${principal.kind}${principal.kind === "guest" ? ` ${principal.grant}` : ""}`);
		return {
			variant: "all",
			members: {
				// notes 派生自文档列表。
				notes: self.derive([doc], ([d]) => d.list),
				// add 追加文本并返回 null；失败沿事务传播。
				add: async ({ text }, ctx) => {
					await doc.change((draft) => void draft.list.push(text), ctx);
					return null;
				},
				// A long-running call: it ends when its context is aborted, and says why.
				// follow 一直挂起，直到调用 context 被中止；resolve 直接作为 abort 监听器，忽略事件参数。
				follow: async (ctx) => {
					await new Promise((resolve) => ctx.abortSignal?.addEventListener("abort", resolve));
					// 中止后读取原因；非空断言告诉 TypeScript abortSignal 存在，运行时不检查。
					// as ChordError 只是为读取 code/reason，若实际不是 ChordError 会得到 undefined 字段。
					const { code, reason } = ctx.abortSignal!.reason as ChordError;
					// 打印处理器看到的中止原因：撤销场景为 forbidden/revoked。
					console.log(`  worker: ${principal.kind}'s follow aborted: ${code}/${reason}`);
					return null;
				},
			},
		};
	});
});

// 1. A server with `revokedBy`, routing sessions to in-process workers (trusted links) with the same `revokedBy`.
// server 宿主配置 revokedBy，并要求撤销值类型为 Revocation；onError 直接打印。
const server = createHost<P, Revocation>({
	address: Server(),
	principal: { kind: "server" },
	revokedBy,
	onError: console.error,
});
// 保存创建的 worker 宿主，便于最后统一关闭与读取引用。
const workers: Host<P, Revocation>[] = [];
server.route(
	Session,
	{
		// owner 可访问任意会话；guest 只能访问自己 session 的地址。
		authorize: (p, address) => p.kind === "owner" || (p.kind === "guest" && p.session === address.params.id),
		resolve: async (address) => {
			const [up, down] = memoryLinkPair();
			// worker 与 server 使用同一个 revokedBy，撤销值才能在两边按同一规则匹配。
			const worker = createHost<P, Revocation>({
				address,
				principal: { kind: "worker", session: address.params.id },
				revokedBy,
				onError: console.error,
			});
			// 注意本例 worker 用 up 作为父链路（connect），路由返回 down；两端方向对称即可。
			worker.connect(up, { principal: { kind: "server" }, trusted: true }, context);
			// 不等待 worker load；resolve 立即返回链路。
			void worker.load([{ name: "@example/notes", facet: notesFacet }], context);
			workers.push(worker);
			return { link: down, principal: { kind: "worker", session: address.params.id }, trusted: true };
		},
	},
	context,
);
await server.load([], context);

/** A tab whose link the server's entry point stamped with `principal`. */
// tab 辅助函数：创建客户端宿主并 load，然后建立链路：server 端登记 principal，客户端把对端视为 server。
// 与示例 12/13 不同，这里先 load 再 connect；空 facet 列表不依赖链路，因此顺序无碍。
async function tab(principal: P) {
	const host = createHost<P>({ onError: console.error });
	await host.load([], context);
	const [a, b] = memoryLinkPair();
	server.accept(a, { principal }, context);
	host.connect(b, { principal: { kind: "server" } }, context);
	return host;
}

// 2. Two tabs of guest grant g1 (one person, two windows) and the owner's tab, all on session S1.
// Promise.all 并发创建三个 tab；解构顺序与数组顺序一致：one、two 是同一 guest，owner 是 owner。
const [one, two, owner] = await Promise.all([
	tab({ kind: "guest", grant: "g1", session: "S1" }),
	tab({ kind: "guest", grant: "g1", session: "S1" }),
	tab({ kind: "owner" }),
]);
// 两个 guest tab 使用同一 principal（kind/grant/session 相同），因此共享一个 worker 上的 Notes 对象。
const guestNotes = await one.get(Notes, { session: "S1" }, context);
await two.get(Notes, { session: "S1" }, context);
// owner 是不同 principal，得到自己的对象。
const ownerNotes = await owner.get(Notes, { session: "S1" }, context);
// guest 成功写入一条，证明撤销前权限有效。
await guestNotes.add({ text: "from the guest" }, context);
// 启动长调用；catch 把错误转成 code 字符串，便于后面直接打印。
// 标注 error: ChordError 只是开发期假设；实际 rejection 来自链路层（unavailable）。
const following = guestNotes.follow(context).catch((error: ChordError) => error.code);
// The call reaches the worker and runs there.
// 等 10ms，让 follow 到达 worker 并开始运行。
await new Promise((resolve) => setTimeout(resolve, 10));
// references(Notes) 返回每个引用一条 Presence；两个 guest tab + owner = 3。
console.log("worker S1 references:", workers[0]!.references(Notes).value.length);

// 3. Revoke the grant: the worker gets `revoke { grant: "g1" }` and ends the guest's objects there (their running
// calls aborted with forbidden/revoked), and both guest tabs' links close.
// 撤销 grant g1；server 立即结束该 principal 的对象、关闭两个 guest tab 的子链路，并把 revoke 发给 worker。
server.revoke({ grant: "g1" }, context);
// 等撤销传播与状态回调完成。
await new Promise((resolve) => setTimeout(resolve, 10));
// guest tab 的引用因链路关闭而回到 loading；重新访问需要新的认证与链路。
console.log("guest tab:", guestNotes.state.value.kind, "(its link closed; a new one needs a new authentication)");
// follow 的调用方看到 unavailable（链路已关）；worker 侧处理器看到的是 forbidden/revoked。
console.log("guest's follow call:", await following);
// The owner's Notes is its own object (identities include the principal), untouched.
// owner 的引用仍 live，自己的文档内容不受 guest 写入影响（本例两个对象内容独立）。
console.log("owner tab:", ownerNotes.state.value.kind, ownerNotes.notes.value);
// 撤销后只剩 owner 的引用；map 读取每个 Presence 的 principal.kind。
console.log(
	"worker S1 references:",
	workers[0]!.references(Notes).value.map(({ principal }) => principal?.kind),
);

// 4. A worker resolved later gets no past revocation: its objects are new, and the revoked links are closed already.
// owner 访问 S2 触发新 worker；历史撤销不会重放，新对象正常 live。
const s2 = await owner.get(Notes, { session: "S2" }, context);
console.log("owner on S2:", s2.state.value.kind);

// 并发关闭三个 tab，再关 server 与所有 worker；Promise.all 只负责并行等待。
await Promise.all([one, two, owner].map((host) => host.close(context)));
await server.close(context);
await Promise.all(workers.map((worker) => worker.close(context)));
