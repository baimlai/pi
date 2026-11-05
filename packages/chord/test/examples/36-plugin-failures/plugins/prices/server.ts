// 文件导读
// 所属包与目录：packages/chord/test/examples/36-plugin-failures/plugins/prices，示例插件 @example/prices 的 server facet。
// 演示什么：服务主机生命周期的 Price，返回固定金额。main.ts 先在副本里删掉一个右括号制造构建失败，再修复并把金额
// 改成 300，用来观察 provider 与其消费者的闭包规则和后续应用。
// 上游入口：createPlugins 发现/构建/求值（contract.ts 同目录导入并内联）；host.load/reload 执行 default facet 的 setup。
// 下游依赖：@earendil-works/chord 的 constant/defineFacet；./contract.ts；package.json 的 name 是插件身份。
// 能力清单：default facet 登记 Price 的无参工厂，返回 { cents: constant(amount) }。
// 示例（真实签名）：defineFacet((host) => host.serve(Price, () => ({ cents: constant(amount) })));
// 典型运行：启动 running 中摘要为 price v1: 250 cents；第 2 幕构建失败，旧价格继续服务；修复后摘要变为
// "price v2: 300 cents"。
// 建议阅读顺序：导入 -> default setup -> 工厂返回值。
// The prices plugin's server facet: serves `Price`.

// constant 包装固定金额；defineFacet 声明 facet；Price 是本插件契约文件导出的令牌。
import { constant, defineFacet } from "@earendil-works/chord";
import { Price } from "./contract.ts";

// setup 输入 host 并登记 Price；无业务参数工厂返回固定250分状态，无外部副作用或显式错误处理。
// 例如 summary 的 derive 会看到这个数；main 破坏副本的括号以触发构建失败，旧价格仍继续服务。
// 工厂在每次激活时重新返回常量；金额变化会成为新的状态值，消费者 derive 随之重算。
export default defineFacet((host) => host.serve(Price, () => ({ cents: constant(250) })));
