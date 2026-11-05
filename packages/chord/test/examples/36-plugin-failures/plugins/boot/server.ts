// The boot plugin's server facet: serves `Boot`. The example makes this module throw while it is evaluated.

import { constant, defineFacet, local, str } from "@earendil-works/chord";

// 本地、无身份参数的主机生命周期对象，mode 是字符串状态；应用声明的同名契约必须版本/指纹一致。
const Boot = local("example.boot", { version: 1, params: {}, members: { mode: str() } });

// setup 只登记工厂，工厂无输入业务数据，返回固定版本标签；无 I/O，也不捕获声明错误。
// 例如首次 mode.value 为第一代标签；main 在副本插入顶层 throw，模拟脚本求值失败而非工厂失败。
export default defineFacet((host) => host.serve(Boot, () => ({ mode: constant("v1") })));
