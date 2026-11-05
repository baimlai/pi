// 文件导读
// 所属：packages/chord/test/examples，Chord v2 示例 23，对应 slice 6a 的 keyed 文档与 watch。
// 演示内容：keyed 文档按 key 分别 watch；工厂里的 handle.at(key) 把某个 key 变成 watchable（本例作为 state 成员），
// key 缺席时它读 initial()。retire 到达时是一帧 initial() 且 retired: true，观察者据此区分“删除”与“改回空值”。
// 上游入口：命令行直接运行；纯内存文档，没有 store、不写文件、不需要数据库。
// 下游调用：defineState（keyed、非持久）、local/method/obj/str、createHost/defineFacet，以及 WatchHandle 的
// start/stop/closed 生命周期。结束时 host.close 让对象与它的 watch 一起结束。
// 失败行为：任何 await 拒绝都会使脚本非零退出；watch 监听器抛错会以 listener_error 终止该 watch，不会静默吞掉。
// 能力清单（按演示机制列出，本文件没有导出）：
// - Note：keyed 文档的值类型 { body: string }。
// - Notes：内存 keyed 文档定义，initial 给出空正文。
// - Notebook 契约：pinned state 成员（由 at 固定一个 key），write/remove 两个方法。
// - notes：模块级 KeyedHandle，示例用它从对象外部 watch 任意 key（真实应用应通过引用/成员观察）。
// - facet：激活时创建 keyed 句柄并返回 at("pinned")、write、remove 的实现。
// - 主流程：watch pinned 成员 → 写入 pinned → 观察缺失 key 返回 undefined → 写入 later → watch 它 → 两次 retire。
// 典型运行顺序：load（空 params 对象激活）→ get → 建立两个 watch → 写/删文档 → 等待异步帧 → close。
// 示例（真实签名）：
//   const handle = await notes.watch("later", ctx);   // Promise<WatchHandle<Note> | undefined>
//   handle?.start(async (call) => { if (call.kind === "value") console.log(call.value, call.retired); });
//   const member = notes.at("pinned");                // 仅工厂内；Watchable<Note>
// 阅读顺序：先看 Note/Notes/Notebook 定义，再看 facet 的 at/change/retire，最后看两个 watch 与 retire 帧的输出。
// 前置条件：Node 支持 --experimental-strip-types。在 packages/chord 下运行：
//   node --conditions=source --experimental-strip-types test/examples/23-keyed-watches.ts
// 预期输出（已实际运行核对；第一行末尾的空字符串参数会产生一个尾随空格）：
//   pinned: { body: 'buy milk' }
//   watch of an absent key: undefined
//   later: { body: '' } (retired)
//   pinned: { body: '' } (retired)
// 相关文档：packages/chord/docs/slice-6a.md（keyed 文档、watch 帧、retired 语义）；相关测试：test/documents/ 的 keyed/watch 用例。
// Keyed watches and `at(key)`: a keyed document is watched per key; `handle.at(key)` in the factory makes one key a
// watchable (a state member here) that reads `initial()` while absent. A retirement arrives as `initial()` with
// `retired: true`, so a watcher can tell "deleted" from "changed back".
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/23-keyed-watches.ts
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { local, method, obj, str } from "../../src/contracts/index.ts";
import { defineState, type KeyedHandle } from "../../src/documents/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";

// 后台上下文：本例没有取消需求；watch 的执行上下文也由 Chord 管理。
const context = BACKGROUND_CONTEXT;

// 类型别名只在编译期存在：描述 keyed 文档的值形状，供下面的 KeyedHandle<Note> 与 initial 的返回类型使用。
// 它与 defineState 的 schema 静态类型结构相同，但两者彼此独立；编译器检查一致性，运行期没有这个类型。
type Note = { body: string };

// 内存 keyed 文档（无 persist，所以不需要 store）：每个 key 一份 { body }，key 不存在时读 initial()。
// version 1 与 keyed: true 一起决定句柄类型和存储命名；type 注解 `(): Note` 让 initial 的返回值显式受检。
const Notes = defineState("notes", {
	schema: obj({ body: str() }),
	version: 1,
	initial: (): Note => ({ body: "" }),
	keyed: true,
});

// 契约：pinned 是普通 state 成员，但值来自 Notes 的 "pinned" key（见工厂）。
// write/remove 是方法；remove 的参数是单个字符串（key），结果仍为 null。
const Notebook = local("example.notebook", {
	version: 1,
	params: {},
	members: {
		// The note "pinned" as a state member: `initial()` while absent.
		pinned: obj({ body: str() }),
		write: method(obj({ id: str(), body: str() })),
		remove: method(str()),
	},
});

// The example's own window into the object: its keyed handle, to watch other keys from outside.
// 模块级变量是示例的“后门”：facet 工厂激活时把句柄存进来，主流程就能 watch 契约未暴露的 key。
// 类型带 | undefined，因为激活前它确实不存在；真实应用不应依赖模块级可变状态（多宿主会互相覆盖）。
let notes: KeyedHandle<Note> | undefined;

const facet = defineFacet((host) => {
	host.serve(Notebook, (_, self) => {
		// 创建（或取到已有）keyed 句柄；它是薄视图，不持有文档值。
		notes = self.state(Notes);
		// 赋给 const 局部变量：随后 TS 把它收窄为非 undefined，工厂内部无需反复用 `!`。
		// 注意不能直接用 notes：它是可变模块变量，闭包内的类型仍是 KeyedHandle<Note> | undefined。
		const handle = notes;
		return {
			// Pinned while this attempt lives, and loaded before the object goes live.
			// at 只能在工厂里调用：它把 key 固定为本次 attempt 的成员/依赖源，并在 hydrate 时加载。
			// key 缺席时读 initial()；之后若被 retire，成员读到 initial() 且 watch 收到 retired 帧。
			pinned: handle.at("pinned"),
			write: async ({ id, body }, ctx) => {
				// change 在一个事务里草拟指定 key 并执行回调；回调里对 draft 的赋值被追踪为变更。
				// 提交后草稿被撤销，不能保存 draft 到事务外；ctx 用于取消与封条检查。
				// 多行参数列表是格式化后的形态；运行期与单行调用完全相同。
				await handle.change(
					id,
					(draft) => {
						// 直接改 draft 属性；不需要返回值（回调结果会作为 change 的结果返回，这里未使用）。
						draft.body = body;
					},
					ctx,
				);
				// 方法没有结果 schema，返回 null。
				return null;
			},
			remove: async (id, ctx) => {
				// retire 在事务提交时把该 key 的文档退回 initial()；key 不存在时是 no-op（不报错）。
				// 观察该地址的 watch 会收到一帧 value：initial() 的值 + retired: true。
				await handle.retire(id, ctx);
				return null;
			},
		};
	});
});

// 无 store 的宿主：文档只在内存，随对象结束而消失。
// onError 接收后台错误（例如监听器抛出），避免未捕获拒绝让进程崩溃。
const host = createHost({ onError: (error) => console.error("background error:", error) });
// 空 params 的 Notebook 在 load 阶段激活；工厂执行后 notes 已被赋值。
await host.load([{ name: "@example/notebook", facet }], context);
// 取得 live 引用；Reference 把 pinned 映射成 Watchable<Note>，把方法映射成 async 函数。
const notebook = await host.get(Notebook, {}, context);

// A watch of the state member: every value call carries the value, its ops and the retired flag.
// watch 返回句柄；句柄的 .value 是获取时的值，start 之后只投递“变更帧”，不会补发这个初始值。
// 观察者可以从 .value 读取当前值，或等下一次变更。
const pinned = await notebook.pinned.watch(context);
// start 安装唯一监听器；回调必须返回 Promise（async 写法），且绝不会在 start 内同步调用。
// call 是可辨识联合：kind === "value" 时才可访问 value/ops/retired；failed 帧表示源暂时失败，watch 仍打开。
// 监听器运行期间到达的变更会被折叠，下一帧携带合并后的最新值。
pinned.start(async (call) => {
	// 三元表达式在未 retire 时追加空字符串，所以第一行末尾会有一个空格（console.log 用空格分隔参数）。
	if (call.kind === "value") console.log("pinned:", call.value, call.retired ? "(retired)" : "");
});

// 写入 pinned：change 的提交完成后，watch 才收到变更帧（异步投递，不阻塞 write 的 Promise）。
await notebook.write({ id: "pinned", body: "buy milk" }, context);
// A watch of one key; an absent key gives `undefined` (watch it once it exists, or pin it with `at`).
// notes 在 load 后必然已赋值，`!` 是非空断言：只影响编译期，运行期没有检查。
// 缺失 key 的 watch 返回 undefined 而不是抛错；要观察“将来才出现”的 key，用 at(key) 在工厂里固定它。
console.log("watch of an absent key:", await notes!.watch("later", context));
// 先让 key 存在，再建立 watch：这次返回 WatchHandle，末尾的 `!` 断言它非 undefined。
await notebook.write({ id: "later", body: "call Anna" }, context);
const later = (await notes!.watch("later", context))!;
// 与 pinned 相同的监听器形状；此时获取值 "call Anna" 已在 later.value，但不会作为帧打印。
later.start(async (call) => {
	if (call.kind === "value") console.log("later:", call.value, call.retired ? "(retired)" : "");
});
// retire later：下一帧 value 是 initial()（空正文），retired 为 true。
await notebook.remove("later", context);
// retire pinned：pinned 的 watch 已收到过 "buy milk"，再收到 retired 的 initial() 帧。
await notebook.remove("pinned", context);

// Frames are delivered after the commit, asynchronously: let them arrive before closing.
// 变更帧通过微任务投递；retire 的提交也在对象线上异步完成，所以先等 10ms 让回调跑完。
// 这是示例的简化：生产代码应 await 具体条件（如监听器里的 Promise 或 watch.closed），固定延时只是让输出稳定。
// new Promise((resolve) => setTimeout(resolve, 10)) 的泛型在此推断为 Promise<unknown>，await 丢弃其结果。
await new Promise((resolve) => setTimeout(resolve, 10));
// 关闭宿主会结束对象；它的 watch 也随之结束（closed resolve 为 ended）。
await host.close(context);
