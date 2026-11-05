// The notes plugin's server facet.

// 文件导读
// 所属：packages/chord/test/examples/43-rollout/plugins/notes/server.ts，插件 @example/notes 的 server facet；
//   discoverPlugins 把插件目录里的 server.ts 识别为 kind "server" 的入口。
// 演示什么：在服务器宿主上服务本地契约 Banner。工厂返回扁平 members（local 不需要 variant），text 用
//   constant 包裹共享的 label 字符串。rollout 重载服务器后，Banner 对象的新代码会重新计算 text。
// 上游/下游：上游是 plugins.load(server, { kind: "server", ... }) 与后续 rollout 的 reload；下游是
//   defineFacet、host.serve、constant、contract.ts 的 Banner 与 label.ts。没有 I/O。
// 能力清单：
// - default export：defineFacet 创建的 Facet，必须有默认导出才会被插件运行时接受。
// - 工厂：返回 { text: constant(`server: ${label}`) }。
// 组合关系：server.get(Banner, {}) -> 宿主激活本地单例 -> 工厂读 label -> 引用读取 text.value。
// 示例（示例，不是本文件的额外运行代码）：
//   host.serve(Banner, () => ({ text: constant("server: v1") }));
// 同目录 package.json（JSON，不能加注释）提供插件名 @example/notes 与 ESM 类型；本示例的 dirty 标记和
//   rollout 报告都使用这个插件名。
// 建议阅读顺序：先看 contract.ts 的 Banner，再看本文件，最后对比 worker.ts 的远程工厂形状。
import { constant, defineFacet } from "@earendil-works/chord";
import { Banner } from "./contract.ts";
import { label } from "./label.ts";

// defineFacet 的回调在 load/reload 时同步执行，只能声明。本地契约的工厂签名是 (params, self)，示例只需
// 返回成员表：Banner 没有 variant，members 就是契约里的 members。
// constant 的值在每次激活/重载时重新读取 label；label 本身在构建时已打包进本脚本。
export default defineFacet((host) => host.serve(Banner, () => ({ text: constant(`server: ${label}`) })));
