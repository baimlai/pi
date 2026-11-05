// 文件导读
// 所属：packages/chord/test/examples/38-watch-and-rollout/incoming/extra，示例 38 中“运行后才复制进插件根”的插件
// @example/extra 的 server facet。incoming/ 不在 watcher 的 roots 下，所以启动时发现不到它；main.ts 把整个
// extra/ 复制成 plugins/extra 后，删除/新增目录触发 set，下一次 build 的重新发现才会找到它。
// 同目录 package.json 提供插件名 @example/extra；发现阶段读取清单的 name 并校验为合法包名，private 与 type 不参与发现。
// 作用：演示一次发布中“新增插件”：server 步骤的 ReloadReport.added 会包含 @example/extra。
// 上游：插件组件的构建/求值；下游依赖：@earendil-works/chord 的 defineFacet/constant/local/str（构建时保持外部，
// 求值时使用宿主传入的本进程实例）。输出：一个服务 example.label.extra 的 facet，成员 text 是常量字符串。
// 能力清单：
// - Extra：本插件自己声明的 local 契约（版本 1、空 params、成员 text: str()）。
// - default export：setup 中 host.serve(Extra, 工厂)，工厂返回 { text: constant(...) }。
// 示例（真实签名）：const facet = defineFacet((host) => host.serve(Extra, () => ({ text: constant("hi") })));
// 上述工厂签名是 Chord 的真实 API；本文件的工厂忽略 params 与 self，因此写成无参函数。
// 建议阅读顺序：先读 Extra 的字段，再看 defineFacet 的 setup；它与 plugins/contracts/contract.ts 的
// labelOf("extra") 形状相同，但这里是插件自带的一份独立声明（相对导入的另一份契约会被复制进构建）。

// The extra plugin's server facet: not in plugins/ at first; the example copies the plugin in while the app runs. It
// declares its type itself (the same shape as `labelOf("extra")`).

import { constant, defineFacet, local, str } from "@earendil-works/chord";

// local 声明只在本主机使用的契约：名字是插件前缀形式的全局身份，版本参与兼容检查，params 为空表示主机生命周期对象。
// members 的 text 用 str() 描述字符串形状；这些类型信息在声明/加载检查中使用，不会在每次读取 constant 时重新校验。
const Extra = local("example.label.extra", { version: 1, params: {}, members: { text: str() } });

// setup 只做声明，不执行 I/O；host.serve 登记该类型的工厂，工厂在对象激活时返回成员。
// constant(value) 返回一个永不变化、永不发送 watch 帧的 Watchable，适合只读状态。
export default defineFacet((host) => host.serve(Extra, () => ({ text: constant("extra on the server") })));
