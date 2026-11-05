// 文件导读
// 所属：packages/chord/test/examples/35-plugins/plugins/notes/server.ts，示例 35 的 @example/notes 插件 server facet（slice 7c）。
// 插件清单：同目录 package.json 只声明 name "@example/notes"、private 与 type:module；目录同时有 server.ts 与
// worker.ts，因此同一插件在两个 kind 各有一个 facet。清单名是插件身份；两个 facet 是同一插件的不同入口。
// 演示内容：server facet 只服务本地 Index，label 来自共享的 label.ts；server 上的引用读这个对象。
// worker facet（notes/worker.ts）才服务远程 Notes，所以编辑 label.ts 会同时重建两个入口，并分别更新两个对象。
// 上游入口：createPlugins 发现本文件（kind server）→ buildFacet → evaluateFacet → server.load。
// 下游调用：defineFacet 包 setup；host.serve(Index, 工厂) 登记对象；constant 生成常量 watchable。
// 失败行为：模块求值/defineFacet/serve 的错误在求值或装载阶段报告；本文件无异步、无 I/O。
// 能力清单：Index 契约的 server 实现，仅 label 一个状态成员。
// 典型运行顺序：server.load 时工厂执行一次 → main 读 index.label（v1）→ label.ts 改动后重新构建并 reload → 变成 v2。
// 示例（真实签名）：
//   export default defineFacet((host) => host.serve(Index, () => ({ label: constant(label) })));
// 阅读顺序：先看两个导入来源，再看 host.serve 的工厂；worker.ts 的 Count/Notes 是另一条独立路径。
// 运行方式：由 35-plugins/main.ts 发现并装载，不能单独运行；预期 index 从 v1 变为 v2。
// 相关文档：packages/chord/docs/slice-7c.md §2、§3、§5；相关测试：test/node/plugins/ 的 runtime/e2e 用例。
// The notes plugin's server facet: serves `Index` with the same label.

// 宿主包导入由求值器提供本进程实例；相对导入（契约与 label）由 esbuild 内联进本 facet 的脚本。
import { constant, defineFacet } from "@earendil-works/chord";
import { Index } from "../contracts/contract.ts";
import { label } from "./label.ts";

// setup 只用 host 登记 Index 工厂，工厂返回 label 的不可写观察值，没有异步步骤或 I/O。
// 例如 v1 脚本的 index.label.value 是 "v1"；重新打包的 v2 工厂才会提供 "v2"。
// defineFacet 本身只包住 setup；声明错误在 host.load/reload 执行 setup 时向主机传播。
// 默认导出必须是 facet（evaluateFacet 检查）；工厂返回的 label 是常量 watchable，不会在对象生命周期内发新帧。
// 新版本要等重新构建脚本并 reload 后才会出现：旧 facet 的闭包捕获的是旧 label。
export default defineFacet((host) => host.serve(Index, () => ({ label: constant(label) })));
