// Routes: host kinds and addresses, a contract's host address, a server routing a session's objects to an in-process
// worker (one `resolve` per address, `authorize` per principal), a guest's `ctx.get` on the server reaching the worker
// as the guest, and a worker that drops and is resolved again.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/12-routes.ts
// 文件导读
// 所属包与示例系列：packages/chord/test/examples，Chord v2 示例 12，对应 slice 4a（host 种类、地址、路由）。
// 演示什么：给 session 声明 hostKind 与地址；remote 契约的 hostAddress 按 session 计算地址；server 用 route 把
//   地址解析到进程内 worker（每个地址只 resolve 一次）；authorize 按 principal 决定谁能进入哪个会话；
//   server 上的 handler 用 ctx.get 代表调用者访问 worker；worker 掉线后路由立即重新 resolve，引用自动重绑。
// 上游/下游：文件顶部命令启动；下游使用 src/contracts 的 hostKind/remote/local、src/host 的 createHost/route/
//   accept/connect、src/link 的 memoryLinkPair。示例全部在进程内运行，不启动真实子进程或网络服务。
// 能力清单（按演示的机制）：
// - hostKind("server") / hostKind("session", { id: str() })：地址由种类和参数构成，key 形如 session|S1。
// - hostAddress: ({ session }) => Session({ id: session })：调用方在 hold/get 时计算目标地址。
// - host.route(kind, { authorize, resolve }, context)：authorize(principal, address) 返回布尔；resolve(address)
//   返回 { link, principal, trusted }，同一地址只在首次需要时调用一次。
// - worker 生命周期：resolve 中创建宿主，先 connect 再 load（不等待 load 完成），立即把链路交给路由。
// - ctx.get：server 上的 handler 以调用者身份获取远端对象；跨路由后 worker 看到的 principal 仍是 guest。
// - 掉线与重新 resolve：worker 链路关闭后引用转 loading，路由因链路已完成握手而立即再次 resolve，引用重新 live。
// 典型运行顺序：创建 server 并注册 route（须在 load 前）-> load server -> owner tab get S1（resolve #1）-> 写一条 ->
//   共享同一 worker -> guest tab 读 S1（reader）-> guest get S2 被 forbidden 拒绝（不再 resolve）-> 经 lobby 的 ctx.get
//   再访问 S1 -> 关闭 worker 链路并等待 loading → live（resolve #2）-> 关闭两个 tab 与 server 宿主。
// 示例（符合真实签名）：
//   server.route(Session, {
//     authorize: (principal, address) => principal.kind === "owner",
//     resolve: async (address) => ({ link, principal: { kind: "worker", session: address.params.id }, trusted: true }),
//   }, context);
// 运行方式与环境：在 packages/chord 下执行文件顶部命令；纯进程内、无环境变量；约 100ms 完成（含轮询等待）。
// 预期输出：server: resolving session|S1 (resolve #1)；owner: editor [ 'milk' ] resolves so far: 1；
//   guest: reader [ 'milk' ] acts as {"kind":"guest","session":"S1"}；guest, S2: forbidden resolves so far: 1；
//   guest via the lobby: reader variant, {"kind":"guest","session":"S1"}；server: resolving session|S1 (resolve #2)；
//   after the drop: loading → live notes: [] resolves: 2。
// 对应测试与文档：packages/chord/test/host/route.test.ts、test/remote/path.test.ts、test/remote/relay.test.ts；
//   slices.md 的 slice 4a；地址与路由的设计见 design.md §3。
// 建议阅读顺序：先看 P、两个 hostKind 与三个契约，再看 workerFacet 的变体选择与 serverFacet 的 ctx.get，
//   随后看 server.route 的 authorize/resolve 与 tabAs 辅助函数，最后按 2-5 步读访问与掉线重连。
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { arr, hostKind, int, local, method, obj, remote, str } from "../../src/contracts/index.ts";
import { isChordError } from "../../src/data/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, type Host } from "../../src/host/index.ts";
import { type Link, memoryLinkPair } from "../../src/link/index.ts";

// 进程内后台上下文；启动 worker 与关闭宿主都显式传入。
const context = BACKGROUND_CONTEXT;

// P 覆盖四种 principal：owner、绑定 session 的 guest、server、绑定 session 的 worker。
// 判别字段 kind 让 authorize 与工厂可以窄化读取 session。
type P =
	| { kind: "owner" }
	| { kind: "guest"; session: string }
	| { kind: "server" }
	| { kind: "worker"; session: string };

// Kinds of addressable hosts; `Session({ id: "S1" })` is an address, its key `session|S1`.
// Server 无参数；Session 需要 id 字符串。地址是普通数据，比较只看拼好的 key。
const Server = hostKind("server");
const Session = hostKind("session", { id: str() });

// Notes live on their session's worker: the caller computes the address and sends it with its hold.
// hostAddress 从 params.session 生成会话地址；server 收到 hold 后按地址路由。
const Notes = remote("example.notes", {
	version: 1,
	params: { session: str() },
	// 地址工厂的真实签名是 (params) => Address；这里把 session 映射为 Session({ id: session })。
	hostAddress: ({ session }) => Session({ id: session }),
	variants: {
		// editor 有 add 与 whoami。
		editor: {
			state: { notes: arr(str()) },
			methods: { add: method(obj({ text: str() }), int()), whoami: method(undefined, str()) },
		},
		// reader 只读 notes，另有 whoami。
		reader: { state: { notes: arr(str()) }, methods: { whoami: method(undefined, str()) } },
	},
});

// The lobby lives on the server: its handler gets notes for whoever calls it.
// Lobby 固定在 server 地址；visitor 变体只有一个 peek 方法，演示 ctx.get。
const Lobby = remote("example.lobby", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { visitor: { methods: { peek: method(obj({ session: str() }), str()) } } },
});

// The worker's own store of its session's notes, shared by every principal's `Notes` object.
// worker 上的本地存储；list 状态与 add 方法供 Notes 的两个变体复用。
const NoteStore = local("example.note-store", {
	version: 1,
	params: {},
	members: { list: arr(str()), add: method(obj({ text: str() }), int()) },
});

// 每个 worker 宿主一份内存文档；保存字符串列表。
const NotesDoc = defineState("notes", { schema: obj({ list: arr(str()) }), version: 1, initial: () => ({ list: [] }) });

/** The worker's facet: an owner edits, anyone else reads; `whoami` shows whom a call acts for. */
// workerFacet 登记本地存储与 Notes 远端契约；同一 worker 上多个 principal 的 Notes 共享 NoteStore。
const workerFacet = defineFacet<P>((host) => {
	host.serve(NoteStore, (_, self) => {
		const doc = self.state(NotesDoc);
		return {
			// list 派生自文档；读取方看到不可变数组。
			list: self.derive([doc], ([d]) => d.list),
			// add 追加文本并返回当前长度；`void` 丢弃 push 的返回值。
			add: async ({ text }, ctx) => {
				await doc.change((draft) => void draft.list.push(text), ctx);
				return doc.value.list.length;
			},
		};
	});
	host.serve(Notes, (_, principal, self) => {
		// 依赖本 worker 的存储；每个 Notes 实例各声明一次引用。
		const store = self.get(NoteStore, {});
		// whoami 只读取 ctx.principal 并序列化；参数类型此处显式写出结构，便于学习。
		const whoami = async (ctx: { readonly principal: P | undefined }) => JSON.stringify(ctx.principal);
		// 非 owner（guest、worker）得到 reader：可读列表与身份，没有 add。
		if (principal.kind !== "owner") return { variant: "reader", members: { notes: store.list, whoami } };
		// owner 得到 editor：add 转调本地存储，identity 仍是调用方 principal。
		return { variant: "editor", members: { notes: store.list, add: (args, ctx) => store.add(args, ctx), whoami } };
	});
});

// serverFacet 只登记 Lobby；它的 handler 在 server 宿主上执行。
const serverFacet = defineFacet<P>((host) => {
	host.serve(Lobby, () => ({
		variant: "visitor",
		members: {
			// `ctx.get` acts as the caller: over the route, the worker sees the guest, not the server.
			// peek 解构 session，并用调用者的 ctx.get 获取 Notes；身份随调用链传播，而不是变成 server。
			peek: async ({ session }, ctx) => {
				const notes = await ctx.get(Notes, { session });
				// 返回变体与 whoami 结果，外层拼接成一行字符串。
				return `${notes.variant} variant, ${await notes.whoami(ctx)}`;
			},
		},
	}));
});

// 1. The server: an address, and a route for sessions. `resolve` starts an in-process worker over a memory link and
// returns the link at once (the worker connects first, then loads, W6). `authorize` admits owners everywhere and a
// guest only into its own session.
// server 宿主带地址与 server principal；route 必须在 load 之前注册，每种 host kind 只注册一次。
const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError: console.error });
// resolves 统计 resolve 被调用的次数，用来证明同一地址只解析一次、掉线后会再次解析。
let resolves = 0;
// 保存最近一次 worker 链路的 server 端，供第 5 步主动关闭。
let workerLink: Link | undefined;
server.route(
	Session,
	{
		// authorize 在每个 hold 到达时调用：owner 可进任意会话，guest 只能进自己 session 的地址。
		// 返回 false 时调用方得到 forbidden，且不会触发 resolve。
		authorize: (principal, address) =>
			principal.kind === "owner" || (principal.kind === "guest" && principal.session === address.params.id),
		resolve: async (address) => {
			// 打印解析次数与地址 key；同一地址的后续 hold 复用这次结果。
			console.log(`server: resolving ${address.key} (resolve #${++resolves})`);
			// 创建内存链路两端：server 端 up 交给路由，worker 端 down 交给新宿主。
			const [up, down] = memoryLinkPair();
			// worker 宿主以会话地址为自己的 address，principal 带 session。
			const worker = createHost<P>({
				address,
				principal: { kind: "worker", session: address.params.id },
				onError: console.error,
			});
			// worker 先 connect（把对端视为 server，trusted 放宽分片限额），再 load。
			worker.connect(down, { principal: { kind: "server" }, trusted: true }, context);
			// void 表示故意不等待 load；路由返回链路后，worker 的加载与后续请求并行进行。
			void worker.load([{ name: "@example/worker", facet: workerFacet }], context);
			// 保存 server 端链路；新 worker 时会被覆盖。
			workerLink = up;
			// resolve 的结果：链路、worker 的 principal、以及是否信任该链路。
			return { link: up, principal: { kind: "worker", session: address.params.id }, trusted: true };
		},
	},
	context,
);
// 发布 server 的 facet；此时 Lobby 可用，但 worker 尚未创建。
await server.load([{ name: "@example/server", facet: serverFacet }], context);

/** A tab on the server, stamped as `principal` by the server's entry point. */
// tabAs 辅助函数：创建一条到 server 的内存链路，accept 时登记对端 principal，返回已 load 的 tab 宿主。
async function tabAs(principal: P): Promise<Host<P>> {
	const [up, down] = memoryLinkPair();
	// server 眼中的调用者身份由这里盖章，后续远端对象身份都包含它。
	server.accept(up, { principal }, context);
	const tab = createHost<P>({ onError: console.error });
	tab.connect(down, { principal: { kind: "server" } }, context);
	await tab.load([], context);
	return tab;
}

// 2. The owner's tab gets S1's notes: tab → server (relays) → route → worker. A second get shares the worker.
// owner tab 按 session 计算地址；server 中继到 route，最终由 worker 提供对象。
const owner = await tabAs({ kind: "owner" });
const notes = await owner.get(Notes, { session: "S1" }, context);
// owner 得到 editor，因此可以写；variant 窄化后才允许访问 add。
if (notes.variant === "editor") await notes.add({ text: "milk" }, context);
// 第二次 get 命中同一 worker 与同一对象；resolves 仍为 1。
const again = await owner.get(Notes, { session: "S1" }, context);
console.log("owner:", notes.variant, again.notes.value, "resolves so far:", resolves);

// 3. A guest of S1 reads S1 and is refused S2 by `authorize` (no worker is started for it).
// guest 绑定 S1；读 S1 得到 reader 变体，whoami 显示 guest 身份。
const guest = await tabAs({ kind: "guest", session: "S1" });
const read = await guest.get(Notes, { session: "S1" }, context);
console.log("guest:", read.variant, read.notes.value, "acts as", await read.whoami(context));
// 访问 S2 被 authorize 拒绝；catch 里用 isChordError 读取 code（forbidden），resolves 保持 1。
await guest.get(Notes, { session: "S2" }, context).catch((error) => {
	console.log("guest, S2:", isChordError(error) ? error.code : error, "resolves so far:", resolves);
});

// 4. The guest calls the lobby on the server; its handler's `ctx.get` goes over the route as the guest.
// lobby 在 server 上；peek 内的 ctx.get 仍以 guest 身份路由到 S1 的 worker。
const lobby = await guest.get(Lobby, {}, context);
console.log("guest via the lobby:", await lobby.peek({ session: "S1" }, context));

// 5. The worker drops: references go loading, the route resolves the address again at once (its link had completed
// its handshake), and the new worker (a fresh run, empty notes here) binds them again.
// 收集引用状态序列，观察掉线与重新绑定。
const states: string[] = [];
const watch = await notes.state.watch(context);
watch.start(async (call) => {
	// 原生 value 帧的 call.value 是 RefState；只记录 kind。
	if (call.kind === "value") states.push(call.value.kind);
});
// 让 watch 的初始状态先入队（0ms 定时器）。
await new Promise((resolve) => setTimeout(resolve, 0));
// 非空断言 `!` 告诉 TypeScript workerLink 已赋值；运行时不检查，未赋值会抛错。
workerLink!.close();
// 轮询直到看到至少两个状态且最后一个是 live；每次等待 50ms。这是示例的观察循环，不是框架 API。
while (states.length < 2 || states.at(-1) !== "live") await new Promise((resolve) => setTimeout(resolve, 50));
// 新 worker 是全新运行，文档为空；resolves 变为 2。
console.log("after the drop:", states.join(" → "), "notes:", notes.notes.value, "resolves:", resolves);

// 先关两个 tab，再关 server；worker 宿主随链路与 server 关闭而结束。
await owner.close(context);
await guest.close(context);
await server.close(context);
