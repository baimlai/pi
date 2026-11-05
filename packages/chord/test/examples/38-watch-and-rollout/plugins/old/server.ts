// 文件导读
// 所属：packages/chord/test/examples/38-watch-and-rollout/plugins/old，@example/old 插件的 server facet。
// 作用：这个插件只演示“删除”。main.ts 第 2 步对 plugins/old 执行递归 rm，删除它的 server.ts 和 package.json；
// 下一次发现不再包含它，第 3 步 build 的 removed 与 server 重载报告的 removed 都会列出 @example/old。
// 它没有 label.ts，文本直接写在工厂里；也没有 worker facet。
// 同目录 package.json 提供插件名 @example/old；发现阶段读取清单的 name 并校验为合法包名，private 与 type 不参与发现。
// 上游：插件组件的 discover/build/evaluate；下游：@earendil-works/chord 的 defineFacet/constant 和复制进来的
// ../contracts/contract.ts（共享契约的修改也会让它变脏，即使之后整个目录被删除）。
// 输出：一个服务 example.label.old 的 facet，成员 text 是常量 "old on the server"；无 I/O。
// 能力清单：default export 是一个 setup；host.serve(labelOf("old"), 工厂)。
// 示例（真实签名）：defineFacet((host) => host.serve(labelOf("old"), () => ({ text: constant("...") })));
// 建议阅读顺序：先看 main.ts 第 2 步的 rm，再看第 3 步打印的 built.removed 与 rollout 报告。

// The old plugin's server facet; the example deletes the plugin's directory.

import { constant, defineFacet } from "@earendil-works/chord";
import { labelOf } from "../contracts/contract.ts";

// 契约名由插件短名 "old" 生成；它与 tags/notes 的标签形状相同，但名字不同，不会互相覆盖。
// 工厂不关心 params 和 self；constant 表示该值永远不会变化，宿主不会收到 watch 帧。
export default defineFacet((host) => host.serve(labelOf("old"), () => ({ text: constant("old on the server") })));
