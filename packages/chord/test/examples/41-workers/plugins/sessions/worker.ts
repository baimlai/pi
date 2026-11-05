// The sessions plugin's worker facet: each worker greets with its process id.

// 文件导读
// 所属：packages/chord/test/examples/41-workers/plugins/sessions/worker.ts，插件 @example/sessions 的 worker
//   facet。discoverPlugins 把插件目录里名为 worker.ts 的文件识别为 kind "worker" 的入口。
// 演示什么：facet 只做声明——在宿主上 serve Greeting，工厂在对象激活时返回 variant 与成员实现。每个 worker
//   进程只服务启动消息里那个 Session 地址，所以 text 里的 id 就是该会话的 id。
// 上游/下游：上游是 createWorkers 的启动消息与 workerMain 里的 plugins.load（服务器构建后运来本脚本）；下游
//   调用 Chord 的 defineFacet、host.serve、constant 以及同目录 contract.ts 的 Greeting。对象激活时工厂运行，
//   更新文本或 pid 都会作为状态变更发给引用方。
// 能力清单：
// - default export：defineFacet 创建的 Facet，plugins 运行时要求插件的 facet 入口有默认导出。
// - 工厂：返回 { variant: "main", members: { text, pid } }；text/pid 都是 constant Watchable。
// 组合关系：main.ts 的 server.get -> 路由 fork worker -> plugins.load 求值本脚本 -> host.serve 注册 Greeting ->
//   host 激活对象时调用工厂 -> 引用拿到状态成员。
// 示例（示例，不是本文件的运行代码）：
//   host.serve(Greeting, ({ id }) => ({ variant: "main", members: { text: constant(`hi ${id}`) } }));
// 同目录 package.json（JSON，不能加注释）提供插件名 @example/sessions 与 ESM 类型；插件名出现在加载报告、
//   dirty 标记和 rollout 结果里。
// 建议阅读顺序：先看 contract.ts 的 Greeting，再看 defineFacet 的回调，最后看 constant 的返回值如何变成
//   Watchable 状态成员。
import { constant, defineFacet } from "@earendil-works/chord";
import { Greeting } from "./contract.ts";

// defineFacet 的回调在每次 load/reload 时执行一次，只允许声明（serve/contribute），不能创建文档、例程或
// native；因此 facet 在 load 之后不会失败。回调的 host 是受限的 FacetHost，只有 serve 和 references。
// host.serve 的第一个参数是契约，第二个是工厂：远程契约的工厂签名是 (params, principal, self)，本地契约是
// (params, self)。这里只需要 params.id，其余参数忽略。工厂必须返回 contract 中声明的变体名与成员实现；
// TypeScript 会检查 variant 名与成员名，运行时不重新校验返回形状。
export default defineFacet((host) =>
	host.serve(Greeting, ({ id }) => ({
		variant: "main",
		members: { text: constant(`hello from session ${id}`), pid: constant(process.pid) },
	})),
);
// constant(value) 创建一个永不变化的 Watchable：读取 .value 得到该值，watch 不会收到更新，只能被 stop 或
// 取消结束。text 是普通字符串，pid 是当前 worker 进程的 pid；它们会随对象状态一起同步给引用方。
