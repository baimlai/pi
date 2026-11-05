// The notes' contracts: a label on the server, and one in each session's worker.

// 文件导读
// 所属：packages/chord/test/examples/43-rollout/plugins/notes/contract.ts，插件 @example/notes 的契约文件，
//   被 main.ts、server.ts facet 与 worker.ts facet 导入。
// 演示什么：同时声明一个 local 契约和一个 remote 契约。Banner 由服务器自己服务（local），Label 由每个会话的
//   worker 服务（remote，hostAddress 指向 Session）。两者都只含一个 text 状态成员，便于观察 rollout 后更新。
// 上游/下游：上游是示例的三个入口；下游只依赖 `@earendil-works/chord` 的声明 API。模块加载时执行声明校验，
//   没有 I/O 或副作用。
// 能力清单：
// - Session：hostKind("session", { id: str() })，生成 "session|<id>" 地址。
// - Banner：local("example.banner", version 1, params {}, members.text)。
// - Label：remote("example.label", version 1, params { id }, hostAddress -> Session，variant main 的 state.text)。
// 组合关系：server.get(Banner, {}) 在服务器本地激活；server.get(Label, { id }) 经 hostAddress 路由到 worker。
// 示例（示例，不是本文件的额外运行代码）：
//   const banner = await server.get(Banner, {}, ctx);   // 本地：返回服务器上的实例
//   const label = await server.get(Label, { id: "S1" }, ctx); // 远程：需要 S1 的 worker
// 建议阅读顺序：先看 Session，再比较 local 与 remote 的声明形状（local 是扁平 members，remote 是 variants），
//   最后读 label.ts 与两个 facet 如何消费同一个 label 字符串。
import { hostKind, local, remote, str } from "@earendil-works/chord";

// Session 是远程契约 Label 的路由目标；调用时只计算地址 key。
export const Session = hostKind("session", { id: str() });

/** The label as the server shows it. */
// local 契约只有一份扁平 members：裸 schema 表示状态成员，method(...) 表示方法，keyed(...) 表示按键的文档。
// params 为空表示服务器上只有一个 Banner 实例；它由加载了 server facet 的宿主自己服务，不需要 hostAddress。
// members.text 是 Watchable<string>，读取 .value 得到当前值。
export const Banner = local("example.banner", { version: 1, params: {}, members: { text: str() } });

/** The label as a session's worker shows it. */
// remote 契约用 variants 描述不同身份看到的成员集合；这里只有一个 main 变体。
// hostAddress 把 params.id 映射成 Session 地址，服务器据此把 hold 交给 createWorkers 注册的路由。
// version 与契约指纹必须与服务方一致，否则绑定时报 contract_mismatch。
export const Label = remote("example.label", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Session({ id }),
	variants: { main: { state: { text: str() } } },
});
