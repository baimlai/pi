// Calls over a link: results, bytes as raw segments, ChordErrors and plugin errors, the caller's principal and
// incarnation in `ctx`, cancellation, and release rejecting the calls made through a reference.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/09-calls.ts
// 文件导读
// 所属包与示例系列：packages/chord/test/examples，Chord v2 示例 09，对应 slice 3a（通过链接的调用与错误）。
// 演示什么：远端方法的返回值、二进制 bytes 作为原始分片传输、调用方身份（principal/incarnation）、参数校验错误、
//   插件自定义错误、调用取消，以及释放引用时挂起调用如何被拒绝、服务端处理器如何被中止。
// 上游/下游：文件顶部命令启动；下游使用 src/contracts 的 remote/bytes/method、src/data 的 PluginError/isChordError、
//   src/context 的 withCancel、src/link 的 memoryLinkPair、src/host 的 createHost。示例只在进程内通信，不写文件。
// 能力清单（按演示的机制）：
// - remote 契约 + 单一 owner 变体：无参数对象，声明 whoami/upload/download/quota/slow 五个方法。
// - bytes() 叶子：参数和结果作为原始分片随 JSON 部分一起传输，不做 base64。
// - ctx.principal / ctx.incarnation：服务端处理器看到链路盖章的调用方身份与宿主实例标识。
// - 错误两类：参数不匹配在提供方变成 ChordError code "invalid"；插件抛 PluginError 保留 code/message/details。
// - 取消：withCancel 产生可取消 context；调用方立即拒绝，服务端处理器收到 abort。
// - 释放：ref.release() 让通过该引用发出的挂起调用以 released 拒绝，并中止对应处理器。
// 典型运行顺序：建 server/client 链路 -> get Files -> whoami -> upload/download 1 MiB -> 触发 invalid 与 plugin error ->
//   取消 slow -> 释放引用后再触发一次 slow -> 关闭 client 与 server。
// 示例（符合真实签名）：
//   const { context: cancellable, cancel } = withCancel(context);
//   const pending = files.slow(cancellable);
//   cancel(new Error("the user gave up")); // pending 以该原因拒绝
// 运行方式与环境：在 packages/chord 下执行文件顶部命令；纯进程内、无环境变量、无外部服务；约几十毫秒完成。
// 预期输出：whoami: owner from …；uploaded bytes: 1048576；downloaded: 1048576 bytes, a Uint8Array；
//   refused: args args/name: expected string, got integer；plugin error: quota the store is full { limit: 1 }；
//   server: slow aborted: call N: aborted by its caller；client: slow rejected: the user gave up；
//   server: slow aborted: hold N: released；client: pending call: example.files: released。
// 对应测试与文档：packages/chord/test/remote/calls.test.ts；slices.md 的 slice 3a；二进制分片的编解码实现见 src/link。
// 建议阅读顺序：先看 Files 契约与 bytes 方法，再看 serve 工厂里的五个方法（尤其 slow 的 ctx.abortSignal），
//   随后按 main 的 1-5 步读调用、错误、取消与释放。
import { BACKGROUND_CONTEXT, withCancel } from "../../src/context/index.ts";
import { bytes, hostKind, int, method, obj, remote, str } from "../../src/contracts/index.ts";
import { isChordError, PluginError } from "../../src/data/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";

// 进程内后台上下文；可取消的场景另行派生 context。
const context = BACKGROUND_CONTEXT;

// P 是两端 principal 的联合：owner 调用、server 提供服务；判别字段 kind 用于窄化。
type P = { kind: "owner" } | { kind: "server" };

// The server's host kind: a remote contract's `hostAddress` names the host serving its objects.
// 声明无参数 host 种类；Server() 生成地址，供 remote 的 hostAddress 返回。
const Server = hostKind("server");

// Files 是远端契约：单一 owner 变体，包含身份查询、上传/下载、错误演示和可取消的慢方法。
const Files = remote("example.files", {
	version: 1,
	// 空参数：整个 server 宿主上只有一个 Files 对象。
	params: {},
	// hostAddress 的真实签名是 (params) => Address；这里忽略参数，固定指向 Server()。
	hostAddress: () => Server(),
	variants: {
		owner: {
			methods: {
				// method(undefined, str())：没有参数，结果是字符串；调用时只传 ctx。
				whoami: method(undefined, str()),
				// A `bytes()` leaf: the argument and result travel as raw segments, never base64.
				// upload 接收 name 与二进制 data，返回字节数；bytes() 让 data 作为原始分片传输。
				upload: method(obj({ name: str(), data: bytes() }), int()),
				// download 接收文件名，返回 bytes 叶子；结果同样走原始分片。
				download: method(obj({ name: str() }), bytes()),
				// quota 无参数无结果，用来抛插件错误。
				quota: method(),
				// slow 无参数无结果，用来演示取消与释放。
				slow: method(),
			},
		},
	},
});

// 服务端内存存储：文件名到字节数组；Map 的泛型参数声明键和值类型，运行时不校验。
const stored = new Map<string, Uint8Array>();

// facet 的工厂忽略参数与 self，直接返回 owner 变体的成员实现。
const facet = defineFacet<P>((host) => {
	host.serve(Files, () => ({
		// 明确返回变体名，框架据此选择成员集合。
		variant: "owner",
		members: {
			// ctx.principal is the caller as its link stamped it; ctx.incarnation the calling host's run (R20).
			// 方法没有业务参数，因此实现收到的第一个参数就是 ctx；principal 可能为 undefined，故用 ?. 读取。
			// incarnation 是宿主实例的 uuid 字符串，slice(0, 8) 只截取前缀用于展示。
			whoami: async (ctx) => `${ctx.principal?.kind} from ${ctx.incarnation.slice(0, 8)}…`,
			// upload 解构 name/data；data 在提供方是 Uint8Array。
			upload: async ({ name, data }) => {
				// 直接保存数组引用；示例不复制，调用方之后修改 data 会影响这里的值。
				stored.set(name, data);
				// byteLength 是字节长度（1 MiB 数据返回 1048576）。
				return data.byteLength;
			},
			// download 查表；?? 只在 undefined 时返回新的空数组，空数组本身不会被替换。
			download: async ({ name }) => stored.get(name) ?? new Uint8Array(),
			// A PluginError crosses with its code, message and details; any other throw as code `internal`.
			// 抛 PluginError；跨链路后调用方仍能按 instanceof 识别，并读到 code/message/details。
			quota: async () => {
				throw new PluginError("quota", "the store is full", { limit: 1 });
			},
			// A handler's context is aborted when its caller cancels or releases the reference.
			// slow 没有业务参数，收到的是 ctx；返回一个在 abort 时才 resolve 的 Promise。
			slow: (ctx) =>
				new Promise((resolve) =>
					// abortSignal 可能为 undefined，用 ?. 安全登记监听器；reason 类型是 unknown，断言为 Error 只为读 message。
					ctx.abortSignal?.addEventListener("abort", () => {
						// 打印服务端观察到的中止原因；消息由框架生成（call N / hold N）。
						console.log("server: slow aborted:", (ctx.abortSignal?.reason as Error).message);
						// 结束挂起的处理器；调用方此时已经收到拒绝，不再需要结果。
						resolve(null);
					}),
				),
		},
	}));
});

// server 宿主：address 供路由寻址，principal 是它处理本地请求时的身份。
const server = createHost<P>({
	address: Server(),
	principal: { kind: "server" },
	onError: (error) => console.error("server:", error),
});
// 发布 facet；Files 等首次访问才创建。
await server.load([{ name: "@example/files", facet }], context);
// 创建内存链路两端；accept/connect 是同步登记，不返回 Promise。
const [up, down] = memoryLinkPair();
// server 眼中的对端是 owner；这个身份会成为远端调用的 ctx.principal。
server.accept(up, { principal: { kind: "owner" } }, context);
// client 宿主没有自己的 facets；connect 声明它眼中的对端是 server。
const client = createHost<P>({ onError: (error) => console.error("client:", error) });
client.connect(down, { principal: { kind: "server" } }, context);
// 先 load 再 get；空 facet 列表也会建立宿主生命周期。
await client.load([], context);

// 取得远端 Files 引用；首次 get 触发 server 上的对象激活。
const files = await client.get(Files, {}, context);

// 1. A call resolves with its result; a method without arguments takes only the context.
// 无参数方法只传 context；结果字符串经链路返回。
console.log("whoami:", await files.whoami(context));

// 2. Bytes: 1 MiB goes out as one raw segment next to the JSON part.
// 构造 1 MiB 的数组并填充 7；fill 原地修改并返回同一个数组。
const data = new Uint8Array(1024 * 1024).fill(7);
// upload 的参数对象同时含字符串和 bytes 叶子；返回值是服务端计算的字节数。
console.log("uploaded bytes:", await files.upload({ name: "chart.png", data }, context));
// 下载同一文件；返回的 back 在客户端被还原为 Uint8Array。
const back = await files.download({ name: "chart.png" }, context);
// 打印长度和运行时构造函数名，验证原始字节往返。
console.log("downloaded:", back.byteLength, "bytes, a", back.constructor.name);

// 3. Errors: arguments are checked at the provider (a ChordError); a plugin's own error keeps its code.
// 第一个 try 展示参数校验：name 故意传数字，静态错误被 @ts-expect-error 允许，运行时由提供方拒绝。
try {
	// @ts-expect-error: `name` must be a string
	await files.upload({ name: 1, data }, context);
} catch (error) {
	// 只处理 code 为 invalid 的 ChordError；reason 为 args，message 指出具体字段。
	if (isChordError(error, "invalid")) console.log("refused:", error.reason, error.message);
}
// 第二个 try 展示插件错误：PluginError 的 code 原样跨链路，客户端 catch 到的是同类实例。
try {
	await files.quota(context);
} catch (error) {
	// instanceof 是运行时检查；details 是插件提供的 JSON 数据。
	if (error instanceof PluginError) console.log("plugin error:", error.code, error.message, error.details);
}

// 4. Cancellation: the caller is rejected at once, the provider aborts the handler.
// withCancel 派生一个可取消 context，并返回 cancel 函数；解构时把 context 重命名为 cancellable。
const { context: cancellable, cancel } = withCancel(context);
// 发起慢调用；它会在服务端一直挂起，直到调用被取消或引用被释放。
const slow = files.slow(cancellable);
// 5ms 后以 Error 作为原因取消；cancel 会让调用方的 Promise 立即拒绝。
setTimeout(() => cancel(new Error("the user gave up")), 5);
// catch 回调参数显式标为 unknown（严格模式下 catch 变量是 unknown）；断言为 Error 只为读取 message。
await slow.catch((error: unknown) => console.log("client: slow rejected:", (error as Error).message));

// 5. Release rejects the calls made through the reference; the provider aborts their handlers.
// 用不可取消的后台 context 再发一个慢调用，验证释放引用本身也能中止挂起调用。
const pending = files.slow(context);
// 等待 5ms，让调用确实已经发出并在服务端挂起。
await new Promise((resolve) => setTimeout(resolve, 5));
// release 同步释放引用；挂起调用会以 ChordError code/reason released 拒绝。
files.release();
// 捕获拒绝并打印消息；错误来自框架而不是服务端处理器。
await pending.catch((error: unknown) => console.log("client: pending call:", (error as Error).message));
// 再等 5ms，让服务端的 abort 日志有机会输出。
await new Promise((resolve) => setTimeout(resolve, 5));

// 先关 client 再关 server；两端都没有需要额外清理的资源。
await client.close(context);
await server.close(context);
