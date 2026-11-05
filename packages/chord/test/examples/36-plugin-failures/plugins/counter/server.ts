// 文件导读
// 所属包与目录：packages/chord/test/examples/36-plugin-failures/plugins/counter，示例插件 @example/counter 的 server facet。
// 演示什么：服务随宿主存活的 Counter（start 整数状态）。main.ts 把副本的工厂改成抛错，演示“构建成功但 staging
// 阶段工厂抛错”的每插件失败：宿主保留旧代码并把插件列入报告。
// 上游入口：createPlugins 发现/构建/求值，host.load/reload 执行 default facet 的 setup。
// 下游依赖：@earendil-works/chord 的 constant/defineFacet/int/local；同目录 package.json 的 name 是插件身份。
// 能力清单：Counter 契约（local、空 params、成员 start: int）；default facet 登记无参工厂。
// 示例（真实签名）：const facet = defineFacet((host) => host.serve(Counter, () => ({ start: constant(value) })));
// 典型运行：启动 running 中 counter 为 1；第 2 幕构建结果仍是 script，但 reload 报告失败 "counter: no seed"；
// 修复并重载后 running 中变为 2。
// 建议阅读顺序：导入 -> Counter 契约 -> default setup -> 工厂返回值。
// The counter plugin's server facet: serves `Counter`. The example makes its factory throw.

// constant 包装固定值；defineFacet 声明 facet；int/local 声明整数成员与本地契约。
import { constant, defineFacet, int, local } from "@earendil-works/chord";

// 声明本主机 start 整数状态；int 的 TS 类型是 number，运行时 schema 另表达整数限制。
const Counter = local("example.counter", { version: 1, params: {}, members: { start: int() } });

// setup 只登记无业务输入的工厂，工厂返回整数常量；例如首次读取 start.value 是1，无真实计数写入。
// main 把副本工厂改成抛错，重载 staging 会发现它并保留旧 facet；错误在主机边界处理。
// 工厂的 self 参数被省略：本对象不声明依赖、派生或 native。
export default defineFacet((host) => host.serve(Counter, () => ({ start: constant(1) })));
