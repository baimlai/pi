// Remote objects over one link: a server and a client host, a remote contract with two variants, a factory choosing
// the variant per principal over a shared local store, and the client's replicas following the server's commits.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/08-remote.ts
// 文件导读
// 所属包与示例系列：packages/chord/test/examples，Chord v2 示例 08，对应 slice 3a（host、链接、远端对象与变体）。
// 演示什么：用一个内存链路连接 server 与 client 两个宿主；远端契约按调用者的 principal 选择 editor/reader 变体；
//   两种变体共享 server 上同一个本地 store；client 拿到的是只读副本，server 的提交以一条状态消息同步过去；
//   最后展示关闭 server 与关闭 client 时引用和 watch 的不同结局。
// 上游/下游：文件顶部命令启动；下游使用 src/contracts 的 hostKind/remote/local、src/link 的 memoryLinkPair、
//   src/host 的 createHost/defineFacet/accept/connect/get/watch、src/state 的 mapShared。示例不发网络请求，
//   链路是进程内的 memoryLinkPair；输出全部是 console.log。
// 能力清单（按演示的机制）：
// - hostKind("server")：声明无参数宿主种类，remote 的 hostAddress 用它生成地址。
// - remote(...) 与 variants：同一对象按 principal 返回 editor（完整 Note + add）或 reader（脱敏 PublicNote）。
// - local 共享存储 NoteStore + defineState：server 侧唯一数据源，两个变体都从它派生视图。
// - createHost<P> + accept/connect：两端分别声明“对方是谁”的 principal；客户端先 connect 再 load。
// - 副本与 watch：client 的 notes/count 是远端引用成员；一次提交以一个 value 帧（含 ops）到达。
// - 变体窄化：TypeScript 依据 variant 收窄成员；reader 调用 add 在服务端会被拒绝。
// - 关闭语义：server.close 先关链路，client 引用转 loading 并保留最后值；client.close 让引用 ended、watch 结束。
// 典型运行顺序：创建 server（address/principal）-> load -> 建链路并 accept/connect -> client.load([]) ->
//   server.get 得到 editor 并写一条 -> client.get 得到 reader 并打印 -> watch notes -> 再写一条 -> 打印帧和 count ->
//   server.close 后观察 loading -> client.close 后观察 ended 与 watch.closed。
// 示例（符合真实签名）：
//   const Server = hostKind("server");
//   const Notes = remote("example.notes", {
//     version: 1,
//     params: { session: str() },
//     hostAddress: () => Server(),
//     variants: { reader: { state: { notes: arr(PublicNote), count: int() } } },
//   });
// 运行方式与环境：在 packages/chord 下执行文件顶部命令；纯进程内，无环境变量、无外部服务。
// 预期输出：guest variant: reader；guest notes: [{"text":"hello"}] count: 1；frame: [...]（ops 为列表插入补丁）；
//   count after the commit: 2；after the server closed: { kind: 'loading' } count: 2；after the client closed:
//   { kind: 'ended', ... } { kind: 'ended' }。错误对象会连带打印堆栈，属于预期展示。
// 对应测试与文档：packages/chord/test/remote/remote-object.test.ts、replica.test.ts、hold.test.ts、provider.test.ts；
//   slices.md 的 slice 3a；设计文档 §3（host/地址）与 §6（principal 与视图）。
// 建议阅读顺序：先看 P、hostKind、remote 契约与 variants，再看 NoteStore/NotesDoc/redact，随后看 serve 工厂如何按
//   principal 选变体，最后按 main 的编号步骤读 accept/connect、get、watch 与 close。
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { arr, hostKind, int, local, method, obj, remote, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import { mapShared } from "../../src/state/index.ts";

// 进程内后台上下文；所有异步操作显式传入。
const context = BACKGROUND_CONTEXT;

// The app's principals: who calls. Links stamp them; a caller never sets its own.
// P 是应用自定义的 principal 联合：owner、带会话的 guest、server；判别字段 kind 支持后续窄化。
// 链路两端在建立时分别声明“对端是谁”，之后每个远端对象身份都包含这个 principal。
type P = { kind: "owner" } | { kind: "guest"; session: string } | { kind: "server" };

// Note 是服务端保存的完整备注；PublicNote 是 reader 变体对外暴露的脱敏形状。
// obj 只生成 schema 与静态类型，不会在每次读取时重新校验对象。
const Note = obj({ text: str(), author: str() });
const PublicNote = obj({ text: str() });

// The server's host kind: every remote contract names the address of the host serving its objects.
// Server 是无参数 hostKind；Server() 生成 { kind:"server", params:{}, key:"server" } 形式的地址。
const Server = hostKind("server");

// A remote contract: one object per (type, params, principal key), in the variant its factory chooses.
// remote 声明跨宿主对象；hostAddress 从 params 计算服务宿主地址（这里忽略 params，固定返回 Server()）。
// variants 列出互斥实现：editor 暴露完整 notes 和 add，reader 只暴露脱敏 notes 与 count。
const Notes = remote("example.notes", {
	// 契约版本参与两侧匹配；变体成员变化也应提升版本。
	version: 1,
	// session 参与对象身份：同一会话的同一 principal 共享一个远端对象。
	params: { session: str() },
	// hostAddress 接收参数值并返回 Address；真实签名是 (params) => Address，示例用不到参数。
	hostAddress: () => Server(),
	variants: {
		// editor 的 state 是完整备注数组和数量；methods 里的 add 接收正文。
		editor: { state: { notes: arr(Note), count: int() }, methods: { add: method(obj({ text: str() })) } },
		// reader 没有方法，只能读脱敏备注与数量。
		reader: { state: { notes: arr(PublicNote), count: int() } },
	},
});

// The shared store: the notes of a session once, behind per-principal views (design §6). Local types never cross a link.
// 本地存储按 session 分实例，是唯一权威数据；远端变体都从它读，而不是各自保存一份。
const NoteStore = local("example.note-store", {
	version: 1,
	params: { session: str() },
	// notes 是状态成员；add 接收一条 Note，返回无结果（method 的 result 省略）。
	members: { notes: arr(Note), add: method(Note) },
});

// 每个 NoteStore 一份内存文档，根对象含 list 数组；初始为空列表。
const NotesDoc = defineState("notes", { schema: obj({ list: arr(Note) }), version: 1, initial: () => ({ list: [] }) });

// A redaction computed once per store element, so a reader's derive keeps unchanged notes identical.
// mapShared 按 input 对象身份缓存结果：未变化的备注在每次派生中保持同一个脱敏对象，差分只需报告新增项。
const redact = mapShared((note: { text: string; author: string }) => ({ text: note.text }));

// facet 用 principal 类型参数化；setup 里同时登记本地存储与远端契约的工厂。
const facet = defineFacet<P>((host) => {
	host.serve(NoteStore, (_, self) => {
		// 取得本对象的文档句柄；所有变体共享这份数据。
		const doc = self.state(NotesDoc);
		return {
			// notes 派生自文档列表；对象不可变，读取方应把返回值视为只读快照。
			notes: self.derive([doc], ([d]) => d.list),
			// add 在事务中追加一条备注；`void` 丢弃 push 返回的数字，让 change 回调不返回值。
			add: async (note, ctx) => {
				await doc.change((draft) => void draft.list.push(note), ctx);
				// 无结果的方法按契约返回 null。
				return null;
			},
		};
	});
	// A remote factory gets the principal its object is for and returns one variant with exactly its members.
	// 远端工厂签名是 (params, principal, self)：这里解构 session，并按 principal.kind 选择变体。
	host.serve(Notes, ({ session }, principal, self) => {
		// self.get 声明对本地存储的依赖；同一 session 共享存储实例。
		const store = self.get(NoteStore, { session });
		// 数量从 store.notes 派生，两个变体复用同一个 count 计算。
		const count = self.derive([store.notes], ([n]) => n.length);
		// guest 只能拿到 reader：notes 经 redact 脱敏，且没有 add 成员。
		if (principal.kind === "guest") {
			return { variant: "reader", members: { notes: self.derive([store.notes], ([n]) => redact(n)), count } };
		}
		// 其他 principal（本例是 server）得到 editor：完整 notes、count 和写方法。
		return {
			variant: "editor",
			members: {
				// 直接暴露 store 的派生状态，不复制列表。
				notes: store.notes,
				// 属性简写：count 变量同时作为成员名和值。
				count,
				// add 解构正文，把 author 记为 principal.kind（本例写入时是 "server"）。
				add: async ({ text }, ctx) => store.add({ text, author: principal.kind }, ctx),
			},
		};
	});
});

// 1. The server, at its address: it acts as `server` for its own requests.
// 创建 server 宿主：address 让别的宿主能按地址找到它；principal 是它处理自己本地请求时的身份。
const server = createHost<P>({
	address: Server(),
	principal: { kind: "server" },
	// onError 只打印后台错误，不吞掉主动调用返回的拒绝。
	onError: (error) => console.error("server:", error),
});
// 发布 facet；空参数的本地类型在 load 期间启动，远端 Notes 等首次访问才创建。
await server.load([{ name: "@example/notes", facet }], context);

// 2. A client (a tab): no principal of its own. The entry point authenticated it as a guest of S1 and stamps that on
// the link; the client connects before it loads (its plugins may reference server types).
// memoryLinkPair 返回 [up, down] 两端；解构取出后分别交给 server 与 client。
const [up, down] = memoryLinkPair();
// accept 同步登记子链路，不返回 Promise；principal 是 server 眼中的对端身份：S1 的 guest。
server.accept(up, { principal: { kind: "guest", session: "S1" } }, context);
// client 没有 facets；它的宿主 principal 配置此处未设置（客户端自己不拥有身份）。
const client = createHost<P>({ onError: (error) => console.error("client:", error) });
// connect 同步登记父链路；principal 是 client 眼中的对端身份：server。
client.connect(down, { principal: { kind: "server" } }, context);
// 空 facet 列表仍然要 load：建立宿主的生命周期，之后才能 get 远端类型。
await client.load([], context);

// 3. The server writes as an editor; the guest reads the redacted view over the link.
// 在 server 本地 get 远端契约：请求由 server 自己处理，principal 为 server，因此得到 editor 变体。
const own = await server.get(Notes, { session: "S1" }, context);
// variant 是判别字段；比较后才允许访问 editor 专属的 add。await 让写提交完成。
if (own.variant === "editor") await own.add({ text: "hello" }, context);
// client 经链路 get 同一会话；server 按 accept 时登记的 guest 身份选择 reader 变体。
const notes = await client.get(Notes, { session: "S1" }, context);
// 打印客户端看到的变体名，证明远端工厂的 principal 分支生效。
console.log("guest variant:", notes.variant);
// notes 引用的成员值已是同步副本；JSON.stringify 让数组以 JSON 形式显示，count 是普通数字。
console.log("guest notes:", JSON.stringify(notes.notes.value), "count:", notes.count.value);

// 4. A commit on the server reaches the client as one state message: both members change in the same batch.
// 对引用成员建立 watch；watch(context) 返回句柄，start 注册监听器。
const watch = await notes.notes.watch(context);
// start 的监听器接收 WatchCall 判别联合：value 分支含新值、差分 ops 和 retired 标记；failed 分支表示源失败。
// start 本身返回 void，因此这里不 await；监听器是异步函数，由 watch 串行调用。
watch.start(async (call) => {
	// 只在成功帧上读 value/ops；ops 描述列表如何变化（例如一次插入），避免重传整个数组。
	if (call.kind === "value") console.log("frame:", JSON.stringify(call.value), "ops:", JSON.stringify(call.ops));
});
// server 再写一条；这次内容变化会作为同一批次的一条状态消息发到 client。
if (own.variant === "editor") await own.add({ text: "world" }, context);
// 等待 10ms 让链路消息与 watch 回调完成；Promise 构造器接收 resolve 回调，setTimeout 到点调用它。
await new Promise((resolve) => setTimeout(resolve, 10));
// 同一批提交也更新了 count；读取引用成员的当前副本。
console.log("count after the commit:", notes.count.value);

// 5. TypeScript narrows on `variant`: a reader has no `add` (a forged call would fail `invalid/member` at the server).
// 运行时检查 variant 后，静态类型收窄为 reader 变体。
if (notes.variant === "reader") {
	// @ts-expect-error: `add` is not a member of the reader variant
	// 这一行故意触发类型错误并用指令压制；它不会被发送到服务端，只是证明 reader 没有 add。
	// 若在运行时伪造调用，服务端会按 invalid/member 拒绝。
	void notes.add;
}

// 6. Closing the server closes its links first: the client's reference goes loading and keeps its last values until
// a new link holds it again (10-drops.ts). Closing the client releases it and ends its watches.
// server.close 先关链路再结束对象；client 的引用因此进入 loading，但最后已知值仍可读。
await server.close(context);
// 等待链路断开的消息传播到 client。
await new Promise((resolve) => setTimeout(resolve, 10));
// state 是引用状态：此时为 loading；count 仍保留断开前的 2。
console.log("after the server closed:", notes.state.value, "count:", notes.count.value);
// client.close 释放引用并结束 watch；watch.closed 在终止时 resolve 终态。
await client.close(context);
// 引用状态变为 ended（错误 released/closed），watch 的终态是 { kind: "ended" }。
console.log("after the client closed:", notes.state.value, await watch.closed);
