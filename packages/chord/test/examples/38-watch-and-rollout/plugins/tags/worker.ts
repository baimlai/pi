// 文件导读
// 所属：packages/chord/test/examples/38-watch-and-rollout/plugins/tags，@example/tags 插件的 worker facet。
// 作用：演示“插件还在，但某个 kind 的 facet 消失”。main.ts 第 2 步删除本文件；文件布局变化让 tags 在下一轮被重建，
// 但 worker 集合里不再有 tags，所以 worker 宿主的重载会移除它；server facet 不受影响，tags 插件继续存在。
// 上游：discover/build/evaluate；下游：@earendil-works/chord 与复制进来的 ../contracts/contract.ts。
// 输出：一个服务 example.label.tags 的 worker facet，成员 text 是常量；无 I/O。
// 能力清单：default export 是一个 setup；host.serve(labelOf("tags"), 工厂)。
// 示例（真实签名）：defineFacet((host) => host.serve(labelOf("tags"), () => ({ text: constant("...") })));
// 建议阅读顺序：与 tags/server.ts 对照，再看 main.ts 第 2 步 rm 与第 3 步两次 rollout 的差异。

// The tags plugin's worker facet.

import { constant, defineFacet } from "@earendil-works/chord";
import { labelOf } from "../contracts/contract.ts";

// 同样的契约名在 worker kind 上提供不同文本；facet 的 kind 来自文件名，不由这个模块内容决定。
// 删除本文件后，这个声明不再进入构建；已加载的旧对象要等 worker host 重载才消失。
export default defineFacet((host) => host.serve(labelOf("tags"), () => ({ text: constant("tags on the worker") })));
