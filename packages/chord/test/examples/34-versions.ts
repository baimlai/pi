// 文件导读
// 所属：packages/chord/test/examples，Chord v2 示例 34，对应 slice 7b §7、§8（版本兼容与 accepts）。
// 演示内容：提供者升级而旧消费者继续工作，映射写在提供者一侧（Q10），共享契约只记录 evolve 的编辑历史。
// 本示例 server 的 notes 从 v1 升到 v2（note 增加 tag），仍连着 v1 的 tab：它的 hold 被保留，重新按
// accepts[1] 绑定，watch 收到一帧映射后的完整快照，之后只收到映射后的增量 diff；它调用 v1 add 时参数前向映射、
// 结果后向映射。job 也从 v1 升到 v2：v1 启动的运行继续在旧代码上完成，而新代码的 finish 收到前向映射的 args/result。
// 上游入口：命令行直接运行；server/tab 两个内存 host 加一个 worker host，不写文件、不联网。
// 下游调用：evolve、defineState、createHost/defineFacet/accept/connect/reload、memoryLinkPair、defineJob、self.job。
// 失败行为：未在 accepts 中列出的旧版本绑定会得到 contract_mismatch（本例未演示）；映射函数抛错会让读取/调用失败；
// 本例的 onError 为空，不打印后台错误。
// 能力清单（按演示机制列出，本文件没有导出）：
// - NotesV1/NotesV2：远程契约；v2 由 evolve 追加，notes 变为 {text,tag}，add 的参数和结果都变了。
// - List：v2 形状的状态文档，两个版本的 provider 共用。
// - serveV1/serveV2：两个 provider；serveV2 的 accepts[1] 提供 state/method 映射。
// - old/fresh：同一 tab 上分别按 v1/v2 契约取得的引用。
// - ExportV1/ExportV2：job 的两个版本，v2 的 accepts[1] 映射旧 args/result。
// - Exports：本地契约，start 返回运行 id，running 暴露未结算运行。
// - exportsPlugin(code, job)：用类型断言接受任一版本的 job 定义；run 等待 release，finish 打印结局。
// - 主流程：v1 两端 → server 升 v2、旧 tab 重绑 → 旧调用映射 → job v1 运行跨 reload → v2 finish 映射。
// 典型运行顺序：server/tab 建立并连接 → old.add("milk")、安装 notes watch → server.reload(v2) → old.add("eggs")
// → 取 v2 引用读 tags → worker 加载 v1 exports plugin、start 一个等待中的运行 → worker.reload(v2)
// → 读 running（已映射）→ release → 运行在旧代码完成、v2 finish 收到映射结果 → running 清空 → 关闭三个 host。
// 示例（真实签名）：
//   const NotesV2 = evolve(NotesV1, (e) => e.state("editor", "notes", arr(obj({ text: str(), tag: str() })))
//     .method("add", obj({ text: str(), tag: str() }), obj({ count: int() })));
//   host.serve(NotesV2, factory, { accepts: { 1: { state: { editor: { notes: (current) => ... } },
//     methods: { add: { args: (old) => ..., result: (current) => ... } } } } });
//   const ExportV2 = defineJob("example.export", { version: 2, args: ..., result: ...,
//     accepts: { 1: { args: (old) => ..., result: (old) => ... } } });
// 阅读顺序：先看 NotesV1/V2 与 evolve，再看 List 与 serveV2 的 accepts（对比 serveV1），然后按编号看 tab 的读取与调用，
// 最后看 job 的 accepts、exportsPlugin 的类型断言与 worker 的 reload 流程。
// 前置条件：Node 支持 --experimental-strip-types。在 packages/chord 下运行：
//   node --conditions=source --experimental-strip-types test/examples/34-versions.ts
// 预期输出（本机实测；运行 id 是随机 UUID，每次不同；watch 帧的先后随调度略变，状态结论不变）：
//   1. v1 everywhere: [ 'milk' ]
//      tab frame: [["r",["milk"]]]
//   2. server on v2; the old tab still reads [ 'milk' ] and its state: live
//      tab frame: [["p",[],1,0,["eggs"]]]
//   3. old add returned 2
//      a v2 consumer reads [{"text":"milk","tag":""},{"text":"eggs","tag":"untagged"}]
//   4. after the reload, running shows the v1 run mapped: [{"id":"<uuid>","version":1,"args":{"path":"notes","format":"md"},"phase":"running"}]
//      finish on v2 code: {"id":"<uuid>","args":{"path":"notes","format":"md"},"kind":"done","result":{"file":"notes.md"}}
//      running is empty again: []
// 关于两帧：[["r",...]] 是 reload 后按 accepts[1] 重绑时的一帧完整快照，[["p",[],1,0,["eggs"]]] 是其后 eggs
// 写入的映射增量；watch.start 本身不补发安装时的当前值（对照示例 31 的 follow 注释）。
// 相关文档：packages/chord/docs/slice-7b.md §7、§8 与 design.md §7；相关测试：test/host/ 的 accepts/版本用例、
// test/jobs/ 的 job 版本映射用例。
// Versions in use (slice 7b §7, §8): a provider keeps serving older consumers through `accepts`, written once with the
// provider, never in the shared contract (Q10). Here the server's notes go from v1 to v2 while an old tab, still on v1,
// stays connected: it reads the new state mapped back (as diffs, never the whole list per commit), and its calls are
// mapped forwards and their results back. A job goes from v1 to v2 too: a run started on v1 finishes on its old code,
// and the new `finish` gets its args and result mapped forwards.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/34-versions.ts
// 按来源分组 import：上下文、契约构造器（evolve/hostKind/remote 与 schema）、状态文档、host 入口、job 定义、内存链路。
// `type Context` 与 `type FacetHost` 是仅类型导入，编译后擦除。
import { BACKGROUND_CONTEXT, type Context } from "../../src/context/index.ts";
import { arr, evolve, hostKind, int, local, method, obj, remote, str, unknown } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, type FacetHost } from "../../src/host/index.ts";
import { defineJob } from "../../src/jobs/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";

// 整个脚本共用的后台上下文：没有调用者取消信号，watch/事务/调用都用它。
const context = BACKGROUND_CONTEXT;

// 身份是可辨识联合：判别字段 kind 为字面量类型；收窄后可安全读取对应分支的字段。
// 这里只用于类型，运行期 principal 字段由 createHost/accept/connect 的配置决定，不做 schema 校验。
type Principal = { readonly kind: "server" } | { readonly kind: "owner" };

// 宿主种类地址工厂：Server() 生成 {kind:"server", params:{}, key}，Notes 的 hostAddress 指向它。
// 地址决定远程对象放在哪台宿主上，不进入契约指纹。
const Server = hostKind("server");

// The shared contract, as every plugin bundles it: v1, then v2 where a note gained a tag.
// v1 远程契约：params 为空表示单一对象；唯一变体 editor 的 state 是 notes（字符串数组），
// 方法 add 接收 {text}、返回 int（列表长度）。version 参与绑定时的版本检查。
const NotesV1 = remote("example.notes", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { editor: { state: { notes: arr(str()) }, methods: { add: method(obj({ text: str() }), int()) } } },
});
// evolve 在 v1 的历史末尾追加 v2，并把编辑记进 history；它不生成、也不携带任何映射函数。
// e.state("editor","notes", ...) 替换该变体 notes 成员的 schema：v2 的 note 是 {text,tag}。
// e.method("add", ...) 同时替换 add 的参数和结果 schema：参数多出 tag，结果变成 {count}。
// 参数集合与变体集合不能改（改了要另起历史）；返回的是新的契约句柄，旧的 NotesV1 不受影响。
// 类型上 NotesV2 的版本是字面量 2，后续 accepts 表只允许键为更旧的版本（这里是 1）。
const NotesV2 = evolve(NotesV1, (e) =>
	e
		.state("editor", "notes", arr(obj({ text: str(), tag: str() })))
		.method("add", obj({ text: str(), tag: str() }), obj({ count: int() })),
);

// notes 的状态文档使用 v2 形状（note 带 tag），两个版本的 provider 共用同一份文档：
// v1 provider 读取时把对象映射成字符串、写入时把 tag 设为 ""；v2 provider 直接读写 {text,tag}。
// 所有远程 notes 对象共享这个单例文档（params 为空）；文档迁移不是本例重点，这里只有一种存储形状。
const List = defineState("example.list", {
	schema: obj({ notes: arr(obj({ text: str(), tag: str() })) }),
	version: 1,
	initial: () => ({ notes: [] }),
});

/** The server's notes plugin at v2: what a v1 consumer sees is the provider's `accepts[1]`. */
// 用途：在 server 的 facet 中服务 NotesV2，并为仍使用 v1 的消费者声明 accepts[1]。
// 输入：host（FacetHost<Principal>），只用于 host.serve；输出：void（setup 期间登记服务）。
// 副作用：登记对象服务与映射表；load/reload 的 checkAccepts 检查版本键和映射形状，但此时不调用映射函数。
// 错误路径：accepts 形状不合法会让 load/reload 失败；映射函数在旧消费者读取/调用时才执行，其抛错传给该操作。
// 主要流程：host.serve(NotesV2, 工厂, {accepts})；工厂提供 v2 的 notes 与 add；accepts 把 v1 视角接回 v2。
// 示例（真实签名）：host.serve(NotesV2, (_, _principal, self) => ({ ... }), { accepts: { 1: { ... } } });
function serveV2(host: FacetHost<Principal>): void {
	host.serve(
		NotesV2,
		(_, _principal, self) => {
			// 与 v1 provider 取同一份单例文档；换版本不换存储。
			const list = self.state(List);
			return {
				variant: "editor",
				members: {
					// v2 视图直接暴露 {text,tag} 数组；文档变化时远程旧消费者经 accepts 的映射得到 v1 形状。
					notes: self.derive([list], ([value]) => value.notes),
					// v2 方法：参数含 tag，提交后返回对象 {count}（结果 schema 是 obj({count:int()})）。
					add: async ({ text, tag }, ctx) => {
						await list.change((draft) => void draft.notes.push({ text, tag }), ctx);
						return { count: list.value.notes.length };
					},
				},
			};
		},
		// 第三个参数是 ServeOptions：accepts 表只列仍兼容的旧版本，且只列被编辑真正改动的成员。
		// 这张表属于 provider，不属于共享契约；没有它，v1 消费者在重新绑定时会得到 contract_mismatch。
		{
			accepts: {
				// 键 1 表示“仍接受按 v1 绑定的消费者”。键必须是严格更旧的版本，运行期检查形状。
				1: {
					// state 映射按变体 -> 成员分组，方向是“当前 v2 值 -> v1 值”。
					// current.map(({ text }) => text) 用对象解构取出 text，丢掉 v2 新增的 tag。
					state: { editor: { notes: (current) => current.map(({ text }) => text) } },
					// 方法映射：args 是 v1 参数 -> v2 参数（前向），result 是 v2 结果 -> v1 结果（后向）。
					// `{ ...old, tag: "untagged" }` 用展开复制旧参数，再补上 v1 缺失的 tag。
					// result 这里从 {count} 取出整数，恢复 v1 的 int 结果。
					methods: { add: { args: (old) => ({ ...old, tag: "untagged" }), result: (current) => current.count } },
				},
			},
		},
	);
}

/** The server's notes plugin at v1. */
// 用途：服务 NotesV1 本身（不是映射层）。输入输出的 host 同上；无返回值。
// 与 serveV2 的区别：这是真正按 v1 声明工作的代码，面向只认 v1 的消费者；serveV2 的 accepts 则让 v1 消费者
// 也能连到 v2 provider。两者共用 List，所以无论谁写，存储始终是 v2 形状。
// 示例（真实签名）：host.serve(NotesV1, (_, _principal, self) => ({ variant: "editor", members: { ... } }));
function serveV1(host: FacetHost<Principal>): void {
	host.serve(NotesV1, (_, _principal, self) => {
		// 同一个单例文档；v1 provider 自己负责 v1 视图与写入时的空 tag。
		const list = self.state(List);
		return {
			variant: "editor",
			members: {
				// v1 视图：把存储里的 {text,tag} 映射为字符串数组（这里 `map` 的箭头参数用解构取 text）。
				notes: self.derive([list], ([value]) => value.notes.map(({ text }) => text)),
				// v1 方法只接收 {text}；写入时为新增的 tag 字段补空字符串，保持文档满足 v2 schema。
				add: async ({ text }, ctx) => {
					await list.change((draft) => void draft.notes.push({ text, tag: "" }), ctx);
					return list.value.notes.length;
				},
			},
		};
	});
}

// 1. A server on v1 and a tab built against v1, connected.
// server 宿主：地址是 Server 种类，自身身份 server；onError 为空，不观察后台错误。
const server = createHost<Principal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
// 初始只加载 v1 facet。defineFacet(serveV1) 把 serveV1 当作 setup 函数：load 时执行它并登记 NotesV1。
await server.load([{ name: "@example/notes", facet: defineFacet<Principal>(serveV1) }], context);
// tab 是普通本地宿主（没有 address）：它自己没有插件，load([]) 仍要调用，表示宿主已完成发布。
const tab = createHost<Principal>({ onError: () => {} });
await tab.load([], context);
// 内存链路两端：server 接受 up，tab 连接 down。
const [up, down] = memoryLinkPair();
// accept 指定经这条链到达的请求身份为 owner；远程 notes 对象按 principal 区分，tab 与 server 侧看到同一实例。
server.accept(up, { principal: { kind: "owner" } }, context);
// tab 把 down 作为父链路连接：未在本地服务的远程类型经它转发；principal 是父方身份。
tab.connect(down, { principal: { kind: "server" } }, context);
// 按 v1 契约取远程引用；get 等待引用 live 后返回。old 的成员形状由 NotesV1 决定。
const old = await tab.get(NotesV1, {}, context);
// v1 调用：只传 text；v1 provider 写入 milk、tag 为空。
await old.add({ text: "milk" }, context);
// 安装 notes 成员 watch。watch 返回句柄；start 只安装监听，不补发安装时的当前值。
// call 是可辨识联合：kind 为 "value" 时才有 value/ops，其他分支（failed/ended）在这里被忽略。
// ops 是增量操作数组，JSON.stringify 把一帧压成一行，便于观察快照与 diff。
const watch = await old.notes.watch(context);
watch.start(async (call) => {
	if (call.kind === "value") console.log("   tab frame:", JSON.stringify(call.ops));
});
// .value 读到本地当前快照：字符串数组 ['milk']（v1 视图）。
console.log("1. v1 everywhere:", old.notes.value);

// 2. The server reloads to v2 with `accepts[1]`: the old tab's hold is kept; its version is an older one now, so it is
// bound again through the mapping (one snapshot), and from then on gets the mapped diffs.
// reload 传完整插件集：notes 换成新的 facet 对象（changed），并带 accepts[1]。
// 纯对象原地 swap；tab 的旧引用不结束，而是按 v1 版本重新绑定到 v2 provider 的映射视图。
await server.reload([{ name: "@example/notes", facet: defineFacet<Principal>(serveV2) }], context);
// 等 10ms，让重绑与 watch 快照帧送达。上面 watch 回调会打印一帧 ["r", ["milk"]]：
// r 表示整个值被替换为映射后的 v1 快照；之后的状态变化才以 p（数组切片）等增量形式到达。
await new Promise((resolve) => setTimeout(resolve, 10));
// old 仍是 v1 引用：notes.value 是映射后的字符串数组；state live 表示重绑成功。
console.log("2. server on v2; the old tab still reads", old.notes.value, "and its state:", old.state.value.kind);

// 3. The old tab calls v1's `add`: its args are mapped forwards, the v2 result mapped back to v1's count.
// 旧消费者只传 {text}；accepts[1].methods.add.args 先补成 {text, tag:"untagged"}，v2 实现执行后返回 {count:2}，
// 再由 result 映射回 v1 的 int 2。映射函数只在这个提供者的调用路径上执行。
console.log("3. old add returned", await old.add({ text: "eggs" }, context));
// 等 10ms，让远程状态变化经映射 derive 以 diff 帧送达 watch（上面会打印 ["p",[],1,0,["eggs"]]）。
await new Promise((resolve) => setTimeout(resolve, 10));
// A new tab (v2 code) on the same object sees the tags.
// 同一 tab 再按 v2 契约取同一远程对象（同 params/principal，共享实例），这次直接看到 v2 形状：
// milk 是 v1 写入的（tag 为空），eggs 是经 accepts 映射写入的（tag "untagged"）。
const fresh = await tab.get(NotesV2, {}, context);
console.log("   a v2 consumer reads", JSON.stringify(fresh.notes.value));

// 4. Jobs: `Export` v2 maps a v1 run's args and result forwards; a v1 run still running finishes on its old code.
// job 定义与对象契约是两套独立的版本：ExportV1/ExportV2 同名 "example.export"，版本分别为 1/2。
// job 的 accepts 只做前向映射：旧运行的 args -> 当前 args，旧运行的结果 -> 当前 finish 能读的结果。
// 这与契约方法映射的方向不同（那里旧消费者要把当前结果映射回旧形状），因为这里接收方是新代码。
const ExportV1 = defineJob("example.export", { version: 1, args: obj({ path: str() }), result: str() });
const ExportV2 = defineJob("example.export", {
	version: 2,
	args: obj({ path: str(), format: str() }),
	result: obj({ file: str() }),
	// accepts 的键必须是严格更旧的版本；两项函数都朝新版本映射。
	// args 用展开复制 {path} 后补 format；result 把 v1 的字符串包成 v2 的 {file}。
	accepts: {
		1: { args: (old: { path: string }) => ({ ...old, format: "md" }), result: (old: string) => ({ file: old }) },
	},
});
// Exports 是本地对象契约，其 version 与 job 版本无关，描述对象成员形状：
// start 的参数是 {path}，结果是运行 id（字符串）；running 是状态成员，用 arr(unknown()) 表示任意 JSON 数组，
// 因为条目随 job 版本不同。unknown() 的 schema 接受任意值；编译期元素类型也是 unknown，读取时需自行判断。
const Exports = local("example.exports", {
	version: 1,
	params: {},
	members: { start: method(obj({ path: str() }), str()), running: arr(unknown()) },
});
// run 把 Promise 的 resolve 存进 release；脚本借此让运行停在 running 阶段，跨过 reload 后再放行。
// 类型是 (() => void) | undefined：运行尚未开始时是 undefined，稍后用可选调用 release?.()。
let release: (() => void) | undefined;

/** The exports plugin with `job` (v1 or v2): its `run` waits for `release` once, its `finish` prints the outcome. */
// 用途：生成 exports 对象的 facet，并绑定给定版本的 job 定义（v1 或 v2）。
// 输入：code（打印用的代码标签）、job（typeof ExportV1 | typeof ExportV2 的联合）。
// 输出：Facet<Principal>；副作用：服务 Exports 并注册 job 实现。
// 错误路径：start 的拒绝原样交给调用者；run 抛错会记为 failed outcome；reload/加载错误由宿主报告。
// 主要流程：host.serve(Exports) -> self.job(job, {run, finish}) -> 返回 {start, running} 成员。
// 类型说明：两个 JobDefinition 的泛型参数不同，直接用 self.job 推断会冲突，所以示例用类型断言把调用点
// 收缩成一个宽松签名；运行时调用的仍是 self.job，没有类型转换。
// 示例（真实签名）：const facet = exportsPlugin("v2 code", ExportV2);
function exportsPlugin(code: string, job: typeof ExportV1 | typeof ExportV2) {
	return defineFacet<Principal>((host) =>
		host.serve(Exports, (_, self) => {
			// One handle for either version of the job (the two definitions' types differ).
			// 双重断言：as unknown 先擦除 self.job 的原类型，再声明本文件实际用到的宽松形状。
			// start 接受任意 args、返回 {id}；running 声明为 never——never 是最底层类型，可赋给任意成员类型，
			// 但运行时 handle.running 仍是 job 的真实 watchable。这只是为了让 v1/v2 两种定义共用一段代码。
			const handle = (
				self.job as unknown as (
					definition: unknown,
					implementation: unknown,
				) => {
					start(args: unknown, ctx: Context): Promise<{ readonly id: string }>;
					readonly running: never;
				}
			)(job, {
				// run 在事务之外执行；args 的类型写 {path}，本示例只读取 path（v2 的 format 被忽略）。
				// Promise 执行器同步运行，所以调用 run 后立刻就把 resolve 存进 release；随后 run 挂起，
				// 直到脚本调用 release?.()。这样运行能保持未结算状态跨过 reload。
				run: async (args: { path: string }) => {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					// job.version 是字面量 1 | 2 的联合；=== 1 收窄分支，返回 v1 的字符串或 v2 的对象。
					// 本例实际是 v1：返回 `${args.path}.md`，即 "notes.md"。
					return job.version === 1 ? `${args.path}.md` : { file: `${args.path}.out` };
				},
				// finish 在新代码里运行；reload 后新定义会把旧运行的 args/result 映射成新形状再传进来。
				// outcome 声明为 unknown，示例只做 JSON 打印；失败结局保留原错误，不做结果映射。
				finish: (outcome: unknown) => console.log(`   finish on ${code}:`, JSON.stringify(outcome)),
			});
			return {
				// start 成员：调用方只给 {path}；这里按 job 版本补上 v2 需要的 format，再把 id 字符串返回。
				// ctx 是对象方法的调用上下文，交给 job handle，使启动与本次调用共享取消/封口。
				start: async ({ path }: { path: string }, ctx: Context) =>
					(await handle.start(job.version === 1 ? { path } : { path, format: "html" }, ctx)).id,
				// 把 job 的 running watchable 直接作为对象成员暴露；类型层是 never，运行时是实时列表。
				running: handle.running,
			};
		}),
	);
}

// 第三个 host：只有 exports 插件，演示 job 的跨 reload 版本映射。onError 为空，不观察后台错误。
const worker = createHost<Principal>({ onError: () => {} });
// 先加载 v1 代码的插件；ExportV1 的 args/result 是 {path}/str。
await worker.load([{ name: "@example/exports", facet: exportsPlugin("v1 code", ExportV1) }], context);
// 取 exports 对象引用；空 params 的单例。
const exportsRef = await worker.get(Exports, {}, context);
// 启动运行：start 返回运行 id；run 随即挂起在 release 上，运行保持 running。
await exportsRef.start({ path: "notes" }, context);
// 等一个宏任务，确保 run 已经开始并把 resolve 写入 release（start 提交后才调度 run）。
await new Promise((resolve) => setTimeout(resolve, 0));
// reload 到 v2 代码：Exports 对象纯内存，旧的 v1 运行不重跑，而是交给新 attempt 收尾。
// 新定义 ExportV2 的 accepts[1] 让这个 version:1 的运行被视为可接管。
await worker.reload([{ name: "@example/exports", facet: exportsPlugin("v2 code", ExportV2) }], context);
// running 由新定义的 job 提供：条目仍标 version:1，但 args 已前向映射为 v2 的 {path,format:"md"}；
// phase 仍是 running（运行尚未结算）。
console.log("4. after the reload, running shows the v1 run mapped:", JSON.stringify(exportsRef.running.value));
// 放行挂起的运行：它在旧代码（v1 的 run）上完成并得到 "notes.md"；新代码的 finish 收到映射后的 args/result。
// 可选调用：release 在运行开始前可能是 undefined。
release?.();
await new Promise((resolve) => setTimeout(resolve, 10));
// 运行结算后从 running 列表删除；finish 已在上面的日志中打印映射结果。
console.log("   running is empty again:", JSON.stringify(exportsRef.running.value));

// 收尾：先关 worker（其 job/对象随之结束），再关 tab 与 server。
await worker.close(context);
await tab.close(context);
await server.close(context);
