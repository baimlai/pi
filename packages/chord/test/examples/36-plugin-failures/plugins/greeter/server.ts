// 文件导读
// 所属包与目录：packages/chord/test/examples/36-plugin-failures/plugins/greeter，示例插件 @example/greeter 的 server facet。
// 演示什么：服务主机生命周期的 Greeting，文本来自同目录 label.ts。main.ts 通过破坏/修复 label 触发构建失败，
// 展示失败插件在重载时保留旧代码。
// 上游入口：createPlugins 发现/构建/求值（label.ts 被内联进构建）；host.load/reload 执行 default facet 的 setup。
// 下游依赖：@earendil-works/chord 的 constant/defineFacet/local/str；label.ts；package.json 的 name 是插件身份。
// 能力清单：Greeting 契约（local、空 params、成员 text: str）；default facet 登记返回 label 文本常量的工厂。
// 示例（真实签名）：defineFacet((host) => host.serve(Greeting, () => ({ text: constant(greeting) })));
// 典型运行：启动 running 中问候为 hello；第 2 幕构建失败报告 label.ts 的语法错误；修复并重载后依次变为 hi、hey。
// 建议阅读顺序：导入 -> Greeting 契约 -> default setup -> 工厂返回值。
// The greeter plugin's server facet: serves `Greeting` with the text of `label.ts`.

// defineFacet/local/str 声明 facet 与契约；greeting 是构建时从同目录 label.ts 内联的文本。
import { constant, defineFacet, local, str } from "@earendil-works/chord";
import { greeting } from "./label.ts";

// local 只供本主机访问，空 params 使对象具有主机生命周期；text 值由工厂提供。
const Greeting = local("example.greeting", { version: 1, params: {}, members: { text: str() } });

// setup 输入 host，只登记工厂；无参数工厂把导入的文本包装成常量状态，返回成员对象，无 I/O。
// 例如第一代引用读到原问候语；label 语法坏掉时构建会失败，setup 根本不会执行，旧代码保留。
// 工厂没有 self 参数；constant(greeting) 在每次激活时读的是本次构建内联的文本。
export default defineFacet((host) => host.serve(Greeting, () => ({ text: constant(greeting) })));
