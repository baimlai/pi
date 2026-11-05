// The clock plugin's server facet: serves `Clock` with the time its script was evaluated. The example never edits
// this plugin, so a reload leaves it as it is: same script, same facet, same object.

import { constant, defineFacet } from "@earendil-works/chord";
import { Clock } from "../contracts/contract.ts";

// 模块求值时取得一次 UTC 时间字符串；它不会随每次读取自动更新。
const evaluatedAt = new Date().toISOString();

// setup 输入 host，只登记 Clock 的工厂；工厂无业务参数，返回常量状态，无 I/O。
// 例如读取 clock.evaluatedAt.value 得到上述求值时刻；重用同一个 facet 不会重算该时刻。
// defineFacet 返回带 setup 的对象，host.serve 的返回值是 void；加载/声明错误由调用它的主机处理。
export default defineFacet((host) => host.serve(Clock, () => ({ evaluatedAt: constant(evaluatedAt) })));
