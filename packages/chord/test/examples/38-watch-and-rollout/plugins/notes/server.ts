// 文件导读
// 所属：packages/chord/test/examples/38-watch-and-rollout/plugins/notes，notes 插件的 server facet（文件名 server.ts
// 就是 facet kind）。示例用它观察一次正常编辑如何重建并发布，也借它导入的 label.ts 制造语法错误让构建失败。
// 同目录 package.json 提供插件名 @example/notes；发现阶段读取清单的 name 并校验为合法包名，private 与 type 不参与发现。
// 作用：声明并服务 local 契约 example.label.notes，成员 text 是常量标签；文本来自本插件被内联的 label.ts 和
// 共享契约（相对导入的 contract.ts 会被复制进构建）。
// 上游：插件组件的 discover/build/evaluate；下游：@earendil-works/chord 的 defineFacet/constant，以及复制进来的
// ../contracts/contract.ts 和 ./label.ts。输出：一个 host 生命周期对象（params 为空）。
// 能力清单：default export 是 defineFacet 的 setup；setup 内 host.serve(labelOf("notes"), 工厂)，工厂返回
// { text: constant(模板字符串) }。
// 示例（真实签名）：defineFacet((host) => host.serve(labelOf("notes"), () => ({ text: constant("...") })));
// 工厂在对象激活时执行；本示例没有文档、方法或异步步骤。
// 建议阅读顺序：先读 import 的三个来源，再读 defineFacet 的工厂返回。

// The notes plugin's server facet: its label.

import { constant, defineFacet } from "@earendil-works/chord";
import { labelOf } from "../contracts/contract.ts";
import { label } from "./label.ts";

// defineFacet 只包装 setup，不执行它；setup 在 host.load/reload 时运行，这里只登记声明。
// host.serve 的第一个参数是契约，工厂忽略 params/principal/self，返回成员表。
// 模板字符串在工厂执行（激活）时求值：构建已把此时的 label 内联进脚本，所以文本对应本次构建的源码版本。
export default defineFacet((host) =>
	host.serve(labelOf("notes"), () => ({ text: constant(`${label} on the server`) })),
);
