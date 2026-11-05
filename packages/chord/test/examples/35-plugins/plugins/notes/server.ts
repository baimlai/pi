// The notes plugin's server facet: serves `Index` with the same label.

import { constant, defineFacet } from "@earendil-works/chord";
import { Index } from "../contracts/contract.ts";
import { label } from "./label.ts";

// setup 只用 host 登记 Index 工厂，工厂返回 label 的不可写观察值，没有异步步骤或 I/O。
// 例如 v1 脚本的 index.label.value 是 "v1"；重新打包的 v2 工厂才会提供 "v2"。
// defineFacet 本身只包住 setup；声明错误在 host.load/reload 执行 setup 时向主机传播。
export default defineFacet((host) => host.serve(Index, () => ({ label: constant(label) })));
