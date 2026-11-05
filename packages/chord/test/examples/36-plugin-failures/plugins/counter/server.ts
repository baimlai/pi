// The counter plugin's server facet: serves `Counter`. The example makes its factory throw.

import { constant, defineFacet, int, local } from "@earendil-works/chord";

// 声明本主机 start 整数状态；int 的 TS 类型是 number，运行时 schema 另表达整数限制。
const Counter = local("example.counter", { version: 1, params: {}, members: { start: int() } });

// setup 只登记无业务输入的工厂，工厂返回整数常量；例如首次读取 start.value 是1，无真实计数写入。
// main 把副本工厂改成抛错，重载 staging 会发现它并保留旧 facet；错误在主机边界处理。
export default defineFacet((host) => host.serve(Counter, () => ({ start: constant(1) })));
