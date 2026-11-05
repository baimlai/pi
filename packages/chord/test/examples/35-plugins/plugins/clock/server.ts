// 文件导读
// 所属：packages/chord/test/examples/35-plugins/plugins/clock/server.ts，示例 35 的 @example/clock 插件 server facet（slice 7c）。
// 插件清单：同目录 package.json 只声明 name "@example/clock"、private 与 type:module；目录里只有 server.ts，
// 因此只出现在 server 的当前集合，worker 不装载它。清单名是插件身份，目录名不参与匹配。
// 演示内容：facet 文件默认导出一个 Facet；模块求值时取一次 UTC 时间，作为常量状态成员 evaluatedAt。
// 示例从不编辑本插件，构建摘要不变，runtime 在 reload 时复用同一 facet 对象，宿主视其为未变化，故对象不重启。
// 上游入口：createPlugins 发现本文件（kind server）→ buildFacet → evaluateFacet → server.load/reload。
// 下游调用：defineFacet 包住 setup；host.serve(Clock, 工厂) 登记对象；constant 生成永不变化的 watchable。
// 失败行为：模块求值/defineFacet/serve 的错误会在求值或装载阶段报告；本文件正常路径没有异步或 I/O。
// 能力清单：Clock 契约的 server 实现，仅 evaluatedAt 一个状态成员。
// 典型运行顺序：main.ts 首次 load(server) 时工厂执行一次 → get(Clock) → 后续 rollout 复用该 facet → 比较 evaluatedAt。
// 示例（真实签名）：
//   export default defineFacet((host) => host.serve(Clock, () => ({ evaluatedAt: constant(evaluatedAt) })));
// 阅读顺序：先看模块级 evaluatedAt 的求值时机，再看 defineFacet 的 setup 与 host.serve 的工厂。
// 运行方式：由 35-plugins/main.ts 发现并装载；不能单独运行。预期 clock untouched 行为 true（见 main 输出）。
// 相关文档：packages/chord/docs/slice-7c.md §3（求值）与 §5（rollout）；相关测试：test/node/plugins/ 的 runtime/e2e 用例。
// The clock plugin's server facet: serves `Clock` with the time its script was evaluated. The example never edits
// this plugin, so a reload leaves it as it is: same script, same facet, same object.

// 宿主包导入由求值器提供本进程实例；../contracts/contract.ts 会被 esbuild 内联进本 facet 的脚本。
import { constant, defineFacet } from "@earendil-works/chord";
import { Clock } from "../contracts/contract.ts";

// 模块求值时取得一次 UTC 时间字符串；它不会随每次读取自动更新。
const evaluatedAt = new Date().toISOString();

// setup 输入 host，只登记 Clock 的工厂；工厂无业务参数，返回常量状态，无 I/O。
// 例如读取 clock.evaluatedAt.value 得到上述求值时刻；重用同一个 facet 不会重算该时刻。
// defineFacet 返回带 setup 的对象，host.serve 的返回值是 void；加载/声明错误由调用它的主机处理。
// 默认导出必须是 facet：evaluateFacet 会检查，否则把该 facet 报为求值失败（main 的 load 报告会体现）。
export default defineFacet((host) => host.serve(Clock, () => ({ evaluatedAt: constant(evaluatedAt) })));
