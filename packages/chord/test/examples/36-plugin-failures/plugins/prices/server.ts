// The prices plugin's server facet: serves `Price`.

import { constant, defineFacet } from "@earendil-works/chord";
import { Price } from "./contract.ts";

// setup 输入 host 并登记 Price；无业务参数工厂返回固定250分状态，无外部副作用或显式错误处理。
// 例如 summary 的 derive 会看到这个数；main 破坏副本的括号以触发构建失败，旧价格仍继续服务。
export default defineFacet((host) => host.serve(Price, () => ({ cents: constant(250) })));
