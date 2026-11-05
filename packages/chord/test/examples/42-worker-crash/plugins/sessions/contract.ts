// A session lives in its own worker process: `Session({ id })` is its address.

// 文件导读
// 所属：packages/chord/test/examples/42-worker-crash/plugins/sessions/contract.ts，示例插件 @example/sessions
//   的契约文件，服务器 main.ts 与 worker facet 共用。
// 演示什么：在 41 的 Session/Greeting 基础上增加一个带方法的远程契约 Process：状态成员 pid，以及无参数的
//   crash 方法。方法让持有者能远程触发 worker 进程退出，用来演示崩溃后的失败状态与显式重试。
// 上游/下游：上游是 examples/42-worker-crash/main.ts（hold 与 crash 调用）和 plugins/sessions/worker.ts
//   （host.serve 的实现）；下游只依赖 `@earendil-works/chord` 的声明 API。模块加载时执行声明校验，没有 I/O。
// 能力清单：
// - Session：hostKind("session", { id: str() })，生成 "session|<id>" 地址。
// - Process：remote 契约，params { id }，hostAddress 指向 Session，variant main 有 state.pid 与 methods.crash。
// 组合关系：服务器 hold(Process, { id: "S1" }) -> hostAddress 得到 Session 地址 -> 路由 fork worker ->
//   worker 的 facet serve Process -> 引用读取 pid、调用 crash。
// 示例（示例，不是本文件的额外运行代码）：
//   const session = server.hold(Process, { id: "S1" }, ctx); // 同步得到引用
//   await session.crash(ctx);                               // 无参数方法只接收调用上下文
// 建议阅读顺序：先看 Session，再看 remote 的 params/hostAddress，最后看 variants.main 的 state 与 methods。
// 同目录 package.json（JSON，不能加注释）提供插件名 @example/sessions 和 ESM 类型，供 discoverPlugins 识别。
import { hostKind, int, method, remote, str } from "@earendil-works/chord";

// Session 只声明地址种类；调用 Session({ id }) 时只计算 key，参数值在路由时按 str() schema 校验。
export const Session = hostKind("session", { id: str() });

/** A session's process: its pid, and a way to make it crash. */
// remote 声明远程契约。variant main 分两组：
// - state.pid：状态成员，引用上的类型是 Watchable<number>，读取 .value；
// - methods.crash：方法成员，method() 表示无参数、结果为 null（NullSchema）。引用上的调用形式由参数决定：
//   无参数方法是 crash(context)，有参数方法是 crash(args, context)；返回值是 Promise，失败会 reject。
// version 与契约指纹参与绑定校验；hostAddress 只决定路由目标，不进入指纹。
export const Process = remote("example.process", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Session({ id }),
	variants: { main: { state: { pid: int() }, methods: { crash: method() } } },
});
