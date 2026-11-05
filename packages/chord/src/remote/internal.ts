// 本文件是 remote 模块给 Chord 其他层使用的内部出口；应用通过 Host 和引用间接使用这些实现。
//
// 所属模块：packages/chord/src/remote（Chord v2 远端层）的再导出入口，不定义运行时行为。
// 职责边界：只把各实现文件中的类与类型暴露给 host、route、jobs 与测试；应用代码不应直接导入本文件。
// 上游入口：host 层创建连接、路径与远端对象时从这里取得构造器；下游依赖是 ./hold.ts、./host-link.ts、./path.ts、./provider.ts、./remote-object.ts。
// 结果与错误流向：无自身逻辑；被导出类的错误由各自实现负责，export type 在编译后被擦除。
//
// 能力清单：
// - type HoldRequest：hold 消息中可转发的请求字段。
// - HostLink 与 type LinkRole：双向主机连接与 parent/child/route 角色。
// - Path、type PathEvent、type Upstream：跨连接路径、路径事件与持有者联合。
// - type ProviderSide：每个 origin 的提供端类型，实例由 HostLink 创建。
// - RemoteObject：消费端引用的远端对象实现。
//
// 组合关系：HostLink 内部创建 ConsumerSide/ProviderSide；Path 把 HostLink 与 RemoteObject/RelayedHold 串起来。
// 示例：import { HostLink, Path, RemoteObject } from "./remote/internal.ts";
// 建议阅读顺序：先浏览导出清单确认模块边界，再按 host-link.ts、consumer.ts、provider.ts、hold.ts、remote-object.ts 的顺序深入。
// Remote objects for Chord's layers: a host's links (both sides of each), the paths its upstream holds take, and the
// objects of its remote references.

// 只重新导出持有请求类型，运行时不会产生该类型的对象。
export type { HoldRequest } from "./hold.ts";
// 导出双向主机连接实现；type LinkRole 仅供 TypeScript 检查角色字符串。
export { HostLink, type LinkRole } from "./host-link.ts";
// 导出跨重连路径及其事件、持有者联合类型。
export { Path, type PathEvent, type Upstream } from "./path.ts";
// 这里只暴露提供端的类型，实例由 HostLink 创建。
export type { ProviderSide } from "./provider.ts";
// 导出本地引用所指向的远端对象实现。
export { RemoteObject } from "./remote-object.ts";
