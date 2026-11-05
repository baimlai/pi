// Fixture plugin (slice 7c): the server facet, serving `Index` with the same label.

import { constant, defineFacet } from "@earendil-works/chord";
import { Index } from "../contracts/contract.ts";
import { label } from "./label.ts";

// 把 Index 的工厂注册到宿主；调用工厂时用导入的 label 构造恒定状态，没有业务参数或文件写入。
// 例如当前 label 是 v1，Index.label.value 读到 v1；热重载后由新 facet 的工厂使用新模块标签。
export default defineFacet((host) => host.serve(Index, () => ({ label: constant(label) })));
