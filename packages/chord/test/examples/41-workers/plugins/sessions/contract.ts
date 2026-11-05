// A session lives in its own worker process: `Session({ id })` is its address.

// 文件导读
// 所属：packages/chord/test/examples/41-workers/plugins/sessions/contract.ts，examples/41-workers 插件
//   @example/sessions 的契约文件，同时被服务器（main.ts）和 worker 的 facet（worker.ts）导入。
// 演示什么：声明一个 host kind 和一个远程契约。Session 表示“会话进程”的地址；Greeting 声明由该地址的宿主
//   服务的对象、它的参数、版本与状态成员。远程契约的 hostAddress 决定服务器把 hold/call 发到哪个地址。
// 上游/下游：上游是 examples/41-workers/main.ts 与 plugins/sessions/worker.ts 的 import；下游只依赖
//   `@earendil-works/chord` 的声明 API。这里没有 I/O、没有副作用，只有在模块加载时执行一次的声明与校验。
// 能力清单：
// - Session：hostKind("session", { id: str() }) 生成的地址工厂；Session({ id: "S1" }) 的 key 为 "session|S1"。
// - Greeting：remote 契约，params { id }，hostAddress 指向 Session，variant main 带 text、pid 状态成员。
// 组合关系：服务器按 Greeting.hostAddress 得到 Session 地址，再交给 createWorkers 注册的路由；worker 用
//   host.serve(Greeting, factory) 在同一个 Session 地址上服务它。
// 示例（示例，不是本文件运行时的额外调用）：
//   const address = Session({ id: "S1" });       // { kind: "session", params: { id: "S1" }, key: "session|S1" }
//   // 远程引用上的 state 成员是 Watchable：await server.get(Greeting, { id: "S1" }, ctx)，然后读 .text.value
// 建议阅读顺序：先看 Session 的 hostKind 参数，再看 remote 的 params 与 hostAddress，最后看 variants.main 的成员。
// 同目录 package.json（JSON，不能加注释）保存插件名 @example/sessions 与 type: "module"；discoverPlugins 用
//   插件名生成报告和 dirty 标记，ESM 类型决定 worker.ts 的解析方式。
import { hostKind, int, remote, str } from "@earendil-works/chord";
// 这些导入在插件构建时保持外部，由宿主提供实例；主程序从包名导入，需要 --conditions=source 才会解析到
// src 中的 TypeScript 源而不是 dist 构建产物。str()/int() 是运行时 schema 构造器，不只是类型标注。

// hostKind 的第一个参数是种类名，第二个参数是 params 的 schema。调用 Session({ id }) 只计算结果 key，
// 参数字面量在路由/hold 时按 schema 校验；TypeScript 在开发期约束字段名与值类型。
export const Session = hostKind("session", { id: str() });

/** A session's greeting, served by the worker at the session's address. */
// remote 声明“由其他宿主服务”的契约：
// - version 与指纹在两端绑定时必须匹配，否则 hold 得到 contract_mismatch；
// - params 既参与身份（同一 params 只有一个对象），也决定 hostAddress 的输入；
// - hostAddress 返回服务该对象的宿主地址，服务器据此把请求路由到对应 worker，它不进入契约指纹；
// - variants.main.state 的 text/pid 会变成引用上的 Watchable，读取 .value 得到当前值。
// 声明本身在模块加载时做运行时检查（名称、params、至少一个 variant、hostAddress 是函数等）。
export const Greeting = remote("example.greeting", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Session({ id }),
	variants: { main: { state: { text: str(), pid: int() } } },
});
