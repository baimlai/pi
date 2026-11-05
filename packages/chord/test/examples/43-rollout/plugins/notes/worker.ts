// The notes plugin's worker facet.

// 文件导读
// 所属：packages/chord/test/examples/43-rollout/plugins/notes/worker.ts，插件 @example/notes 的 worker facet；
//   discoverPlugins 把插件目录里的 worker.ts 识别为 kind "worker" 的入口。
// 演示什么：在每个会话的 worker 进程里服务远程契约 Label。工厂拿到 params.id，返回 variant main 与
//   text 成员；rollout 把新的 worker 脚本发给运行中的 worker 后，Label 对象重载并显示新 label。
// 上游/下游：上游是 createWorkers 的启动脚本与 workers.step 的 reload；下游是 defineFacet、host.serve、
//   constant、contract.ts 的 Label 与 label.ts。没有 I/O。
// 能力清单：
// - default export：defineFacet 创建的 Facet，作为 worker 种类入口。
// - 工厂：返回 { variant: "main", members: { text: constant(`${id}: ${label}`) } }。
// 组合关系：main.ts 的 get(Label, { id: "S1" }) -> 路由到 S1 的 worker -> 激活对象 -> 工厂拼出 "S1: v1"；
//   rollout 后同一引用读到 "S1: v2"。
// 示例（示例，不是本文件的额外运行代码）：
//   host.serve(Label, ({ id }) => ({ variant: "main", members: { text: constant(`${id}: v1`) } }));
// 同目录 package.json（JSON，不能加注释）提供插件名 @example/notes 与 ESM 类型，供发现、报告与 dirty 标记使用。
// 建议阅读顺序：先看 contract.ts 的 Label，再对比本文件的远程工厂与 server.ts 的本地工厂。
import { constant, defineFacet } from "@earendil-works/chord";
import { Label } from "./contract.ts";
import { label } from "./label.ts";

// defineFacet 回调只做声明。远程契约的工厂签名是 (params, principal, self)；这里解构 params 的 id，
// 忽略 principal 与 self。返回对象必须包含契约声明的 variant 名和该变体的全部成员。
// constant 让 text 成为不可变 Watchable；模板字符串把会话 id 与构建时读到的 label 拼接起来。
export default defineFacet((host) =>
	host.serve(Label, ({ id }) => ({ variant: "main", members: { text: constant(`${id}: ${label}`) } })),
);
