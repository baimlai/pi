// 文件导读
// 所属：packages/chord/test/examples，Chord v2 示例 30，对应 slice 8 §4（host.root 根作用域）。
// 演示内容：host.root(fn, context) 为对象之外的代码（Durable 工具、CLI 命令）提供与 handler 相同的 ctx：
// 身份 principal、宿主 incarnation、telemetry 与 abortSignal，以及 ctx.get。fn 结算、context 取消或 host 关闭时
// 作用域被封口：信号 abort、引用释放、迟到的 ctx.get 被拒绝为 released；不响应信号的代码会在下一次使用 Chord 时失败。
// 规则：root 或 handler 里启动的调用必须 await；未 await 的变更随作用域取消，既拒绝又被上报 transaction_cancelled。
// 上游入口：命令行直接运行；纯内存 host，不写文件、不需要 store。
// 下游调用：withCancel（派生可取消上下文）、defineState/local/method、createHost<Principal>/defineFacet/type Ctx/sleep。
// 失败行为：load 前 root 的 ctx.get 立即 not_ready；取消原因原样成为拒绝；未结算的变更上报 transaction_cancelled；
// host.close 封口未结束的作用域，等待中的调用立即以 released/closed 拒绝。
// 能力清单（按演示机制列出，本文件没有导出）：
// - Principal：应用身份联合类型（server，或带名字的 owner）。
// - Notes：按 session 分对象的契约；list 成员与 add 方法。
// - List：内存状态文档，保存字符串数组。
// - facet：Principal 参数化的 facet；add 把调用者身份写进文本。
// - 七个场景：load 前调用 → 工具调用 → 指定 principal → 保留 ctx → 取消 → 未 await 的调用 → host.close。
// 典型运行顺序：createHost → root（预期拒绝）→ load → 多次 root 调用（各场景）→ close。
// 示例（真实签名）：
//   const host = createHost<Principal>({ principal: { kind: "server" } });
//   const value = await host.root(async (ctx) => {
//     const notes = await ctx.get(Notes, { session: "s1" });
//     return notes.list.value;
//   }, context, { principal: owner });
// 阅读顺序：先看 Principal/Notes/List/facet 与 host 的身份配置，再按编号逐段理解封口、取消、未 await 与关闭。
// 前置条件：Node 支持 --experimental-strip-types。在 packages/chord 下运行：
//   node --conditions=source --experimental-strip-types test/examples/30-host-root.ts
// 预期输出（本机实测；onError 行由取消事务同步上报，先于下一行）：
//   before load: example.notes: the host has not loaded; call host.load first (a host with nothing to load calls load([]))
//   after a tool call: [ 'first (by server)' ]
//   as the owner: { kind: 'owner', name: 'ada' }
//   kept ctx aborted: true
//   kept ctx.get: example.notes: ctx.get after its call settled
//   cancelled: user pressed stop
//   onError: transaction_cancelled example.notes(s1): ChordError: example.notes(s1): ended
//   the unawaited call: example.notes(s1): ended
//   closed: the host is closed
// 相关文档：packages/chord/docs/slice-8.md §4 与 design.md §8（调用上下文/根作用域）；相关测试：test/host/ 的 root 用例。
// `host.root(fn, context)`: a call scope for code outside objects (a Durable tool, a CLI command). `fn` gets a ctx like a
// method handler's: the host's principal (or one a trusted caller names), this host's incarnation, the context's
// telemetry and signal, and `ctx.get` for references. When `fn` settles, or the context aborts, or the host closes, the
// scope is sealed: its signal aborts, its references are released, and a late `ctx.get` is refused `released`; so code
// that ignores its signal fails at its next use of Chord. The rule: await what you start in a root or a handler; a
// change left running when the scope seals is cancelled, rejects and is reported (`transaction_cancelled`). (p3 wraps
// it as `chord(fn, context)` for Durable's tools.)
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/30-host-root.ts
// withCancel 由一个父上下文派生可取消的子上下文；sleep 是会响应 ctx 信号的等待辅助。
// `type Ctx` 是仅类型导入（编译后擦除），只用于变量声明，不进入运行期。
import { BACKGROUND_CONTEXT, withCancel } from "../../src/context/index.ts";
import { arr, local, method, obj, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { type Ctx, createHost, defineFacet, sleep } from "../../src/host/index.ts";

const context = BACKGROUND_CONTEXT;

// 应用身份是判别联合：kind 是字面量类型，收窄后 owner 分支才有 name。
// 这是纯类型：principal 由宿主配置或受信任的同宿主调用者传入，不做 schema 校验（信任边界在应用侧）。
// 例：ctx.principal?.kind === "owner" 时，TypeScript 允许访问 ctx.principal.name。
type Principal = { readonly kind: "server" } | { readonly kind: "owner"; readonly name: string };

// 契约带 params {session}：不同 session 是不同对象。list 是状态成员（实现来自 derive），add 没有结果 schema。
// 参数在运行期按 schema 校验；成员/结果类型只服务编译期。
const Notes = local("example.notes", {
	version: 1,
	params: { session: str() },
	members: { list: arr(str()), add: method(obj({ text: str() })) },
});

// 内存文档（无 persist）：随对象结束而消失；initial 的数组是每个文档实例的初始副本。
// schema 的静态类型 {list: string[]} 与 initial 的返回类型一致，编译期检查；运行期只按 schema 校验变更操作。
const List = defineState("example.list", {
	schema: obj({ list: arr(str()) }),
	version: 1,
	initial: () => ({ list: [] }),
});

// 显式类型参数 <Principal> 把 facet 的身份类型 P 固定下来；self 与 handler 的 ctx 因此都得到 Ctx<Principal>。
// 不写时 P 取默认 Principal（宽泛类型），ctx.principal 的访问会退化为通用类型。
const facet = defineFacet<Principal>((host) => {
	host.serve(Notes, (_, self) => {
		// 取 List 的 singleton 文档句柄；不同 session 的对象共享同一份文档，这是示例的简化。
		const notes = self.state(List);
		return {
			// derive 生成状态成员：源数组 [notes]，回调收到与源顺序对应的值数组，返回 n.list。
			// derive 返回 watchable，作为 list 成员的实现；读取方用 reference.list.value。
			list: self.derive([notes], ([n]) => n.list),
			// add 的 ctx 是本次方法调用的 Ctx<Principal>：principal、abortSignal 等都在这里。
			add: async ({ text }, ctx) => {
				// change 在一个事务里草拟 singleton 并提交；回调里 push 的改动被追踪。
				// 身份来自 ctx.principal；`?.` 在匿名调用（principal 为 undefined）时得到 undefined，
				// 字符串结果就是 "... (by undefined)"。这是示例输出的一部分，不是错误处理。
				await notes.change((draft) => {
					draft.list.push(`${text} (by ${ctx.principal?.kind})`);
				}, ctx);
				// 方法没有结果 schema，返回 null。
				return null;
			},
		};
	});
});

// createHost<Principal>：宿主默认身份是 server；root 可以用 options.principal 覆盖它。
// onError 的 error 是判别联合：只有 transaction_cancelled 分支有 object（对象标签）与 error（取消原因）。
// 三元表达式对非该分支输出空字符串；模板字符串把 error.error（Error 对象）转成字符串。
// 无 store：宿主只在内存中运行。
const host = createHost<Principal>({
	principal: { kind: "server" },
	onError: (error) =>
		console.log(
			"onError:",
			error.kind,
			error.kind === "transaction_cancelled" ? `${error.object}: ${error.error}` : "",
		),
});

// 1. A scope made before `load`: its `ctx.get` throws at once (`not_ready`, "call host.load first").
// 在 load 之前建根作用域：host.root 本身能运行，但 ctx.get 立即拒绝，而不是等待一次不会发生的发布。
// 表达式体箭头函数先 await ctx.get 再读 list.value；拒绝沿 Promise 传出，被 .catch 捕获。
// catch 参数注解 `(error: Error)` 只是编译期断言；运行期是 ChordError。
const early = host.root(async (ctx) => (await ctx.get(Notes, { session: "s1" })).list.value, context);
await early.catch((error: Error) => console.log("before load:", error.message));
// 空 params 不适用（Notes 有 session 参数），对象不会在 load 时激活；第一次 ctx.get 时才按参数创建。
await host.load([{ name: "@example/notes", facet }], context);

// 2. A tool's call: get, call, return plain data. The reference is released when fn settles.
// 模拟一个工具调用：取得 /notes(s1) 引用 → 调用 add → 返回纯数据数组。
// fn 结算后作用域封口，引用自动释放；因此这个数组是值快照，不是活引用。
// addNote 每次调用都建新作用域（也拿到新引用）。
const addNote = (text: string) =>
	host.root(async (ctx) => {
		// ctx.get 的参数在运行期按契约 schema 校验；引用以本次调用的 principal 与 incarnation 持有。
		const notes = await ctx.get(Notes, { session: "s1" });
		// 调用方法时必须传 ctx：它携带取消/封口检查，且事务提交绑定到这个调用。
		await notes.add({ text }, ctx);
		// 同步读取 derive 成员当前值；返回后引用失效，但数组值仍可用。
		return notes.list.value;
	}, context);
console.log("after a tool call:", await addNote("first"));

// 3. Base code acting for an authenticated user names the principal.
// 同宿主的受信任基础代码可以为已认证用户行事：options.principal 覆盖宿主默认身份。
// 注意 host.root 用 `"principal" in options` 区分“省略”和“显式 undefined”；后者表示匿名。
const owner: Principal = { kind: "owner", name: "ada" };
console.log("as the owner:", await host.root(async (ctx) => ctx.principal, context, { principal: owner }));

// 4. A kept ctx is sealed once fn settled.
// 把 ctx 存到外部：fn 返回后作用域立即封口，即使调用者还持有这个对象。
// 类型写成 Ctx<Principal> | undefined，因为赋值发生在 fn 内；`!` 非空断言只影响编译期。
let kept: Ctx<Principal> | undefined;
await host.root(async (ctx) => {
	kept = ctx;
}, context);
// 封口会 abort 作用域信号；abortSignal 是可选的，用 ?. 读取。
console.log("kept ctx aborted:", kept!.abortSignal?.aborted);
// 封口后的 ctx.get 不再等待，立即以 released/settled 拒绝；消息说明调用已结算。
await kept!.get(Notes, { session: "s1" }).catch((error: Error) => console.log("kept ctx.get:", error.message));

// 5. Cancelling the context rejects at once and seals the scope; an fn that ignores its signal fails at its next
//    use of Chord.
// withCancel 返回派生上下文与 cancel 函数；cancel(reason) 会 abort 该上下文的信号。
// stubborn 的 fn 不监听信号，先睡 20ms；调用方在 cancel 时立即被拒绝，不必等 fn 结束。
// fn 之后执行 ctx.get 时，作用域已封口，于是它在下一次使用 Chord 时抛错；这个拒绝属于已经结束的调用。
const { context: cancellable, cancel } = withCancel(context);
const stubborn = host.root(async (ctx) => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await ctx.get(Notes, { session: "s1" });
}, cancellable);
// 取消原因原样成为调用方的拒绝值（这里的 Error 对象）；awaitWithContext 负责立即拒绝。
cancel(new Error("user pressed stop"));
await stubborn.catch((error: Error) => console.log("cancelled:", error.message));

// 6. The rule: await what you start in a root or a handler. A call left running when fn returns is cancelled with the
//    scope, and the change it was about to make never commits: it rejects, and onError gets `transaction_cancelled`
//    naming the object and the scope that ended (an empty `catch` would hide the rejection, not the report).
// 反例：fn 启动了 notes.add 却不 await，随后立即返回；作用域封口取消这次变更，事务不会提交。
// 结果有两路：Promise 拒绝（ended），同时向 onError 上报 transaction_cancelled。
// 变量类型显式写成 Promise<unknown> | undefined，因为赋值在 fn 内、且拒绝值未知。
let unawaited: Promise<unknown> | undefined;
await host.root(async (ctx) => {
	const notes = await ctx.get(Notes, { session: "s1" });
	// 故意不 await：add 的 Promise 存到外部，下面单独观察它的拒绝。
	unawaited = notes.add({ text: "lost" }, ctx);
}, context);
// `!` 断言 unawaited 已赋值；即使调用方写了空 catch，onError 的上报仍然发生（演示注释的要点）。
await unawaited!.catch((error: Error) => console.log("the unawaited call:", error.message));
// 等待一个宏任务：让后台的取消/上报流程完全落定，输出顺序更稳定。
await new Promise((resolve) => setTimeout(resolve, 0));

// 7. Closing the host seals the scopes still open and rejects their callers at once: an fn sleeping on its ctx ends.
// 根作用域仍在 sleep(60s)：host.close 封口所有未结束作用域，sleep 监听 ctx 信号后立即 reject。
// .catch 把拒绝转成字符串，因此 sleeping 这个 Promise 最终以字符串兑现。
// 关闭后 root 再被调用会以 released 拒绝；这里没有演示那一分支。
const sleeping = host.root((ctx) => sleep(60_000, ctx), context).catch((error: Error) => `closed: ${error.message}`);
await host.close(context);
console.log(await sleeping);
