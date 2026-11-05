// 文件导读
// 所属：packages/chord/test/examples/38-watch-and-rollout/plugins/tags，@example/tags 插件的 server facet。
// 作用：演示“成功修改的正常发布”。main.ts 第 5 步把本文件的 server 文本从 tags 改为 v2 版本，
// 与同一轮语法错误的 notes 对照：失败的 notes 保持脏，成功的 tags 被重建、发布，并在所有步骤后清除 dirty 标记。
// tags 还有 worker.ts；第 2 步会删除那个文件，所以第 3 步 worker 集合中不再有 tags，而本文件让 tags 仍是插件。
// 同目录 package.json 提供插件名 @example/tags；发现阶段读取清单的 name 并校验为合法包名，private 与 type 不参与发现。
// 上游：discover/build/evaluate；下游：@earendil-works/chord 与复制进来的 ../contracts/contract.ts。
// 输出：一个服务 example.label.tags 的 facet，成员 text 是常量；无 I/O。
// 能力清单：default export 是一个 setup；host.serve(labelOf("tags"), 工厂)。
// 示例（真实签名）：defineFacet((host) => host.serve(labelOf("tags"), () => ({ text: constant("...") })));
// 建议阅读顺序：看 main.ts 第 2 步删除 worker.ts、第 5 步编辑本文件，再看第 3、5 步的 rollout 输出。

// The tags plugin's server facet.

import { constant, defineFacet } from "@earendil-works/chord";
import { labelOf } from "../contracts/contract.ts";

// 第 5 步只替换字符串字面量；构建后脚本内容与 digest 改变，tags/server 因此有新的构建结果。
// 工厂忽略参数，constant 让 text 成为只读观察值。
export default defineFacet((host) => host.serve(labelOf("tags"), () => ({ text: constant("tags on the server") })));
