// 文件导读
// 所属：packages/chord/test/examples/38-watch-and-rollout/plugins/notes，notes 插件的 worker facet（worker.ts）。
// 作用：与 server.ts 服务同一个契约名但文本后缀不同，用来区分同一插件在不同 kind 上的构建和发布；示例第 4 步
// 在 edge 步骤拒绝后不执行 worker 步骤，worker facet 没被发布，因此 notes 保持脏。
// 上游：插件组件的 discover/build/evaluate；下游：@earendil-works/chord 与复制进来的契约、label.ts。
// 能力清单：default export 是 setup；host.serve(labelOf("notes"), 工厂) 返回 { text: constant("... on the worker") }。
// 示例（真实签名）：const facet = defineFacet((host) => host.serve(labelOf("notes"), () => ({ text: constant("x") })));
// 建议阅读顺序：与 server.ts 对照阅读；两者唯一的差别是文件名的 kind 和文本后缀。

// The notes plugin's worker facet: its label.

import { constant, defineFacet } from "@earendil-works/chord";
import { labelOf } from "../contracts/contract.ts";
import { label } from "./label.ts";

// 文件名已经决定这是 worker kind；setup 仍只做声明，不区分构建平台（平台由组件的 kinds 配置决定）。
// 工厂返回常量观察值；这里不读取 host 或 self，因此没有额外副作用。
export default defineFacet((host) =>
	host.serve(labelOf("notes"), () => ({ text: constant(`${label} on the worker`) })),
);
