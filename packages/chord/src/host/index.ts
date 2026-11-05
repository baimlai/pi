// Hosts for apps: creating a host, facets, factories, natives, references and the ctx of method handlers, routines and
// their waiting helpers, revocation, presence and keep-alive counts, root scopes.

// 所属：packages/chord/src/host 的公共 barrel（host 层对应用代码的出口，经包根 @earendil-works/chord 再导出）。
// 职责边界：本文件没有运行时逻辑，只决定应用能看见哪些名字。上游是应用代码；下游是 host/ 各实现文件。
// 结果与错误不在这里产生：export type 在编译后擦除，值导出直接指向原实现（createHost、defineFacet、sleep、untilAborted）。
// 能力清单（按导出来源，每项一句）：
// - ActivityCounts：活跃计数快照（链接 hold、运行中调用、任务、linger 对象）。
// - Factory/Self/StoreSelf：对象工厂签名与激活时传给插件的 self 接口。
// - Ctx：方法处理器、routine 与 ctx.get 的调用上下文。
// - defineFacet/Facet/FacetHost/FacetSelf/ServeOptions：把插件 setup 声明为可加载 facet。
// - FollowAttach/FollowAttachment/FollowObserver：跨实例跟随的观察者接口。
// - createHost/Host/HostOptions/HostError/GetOptions/LinkOptions/Position：宿主实例、配置、错误与操作选项。
// - LoadReport/ReloadReport/ReloadedObject/ReloadOptions/CommittedReload/PluginFailure：load/reload 的报告与选项。
// - Native/NativeCloseReason/NativeOptions：self.open 返回的原生资源句柄及关闭原因。
// - Presence：host.references(Type) 列表中的一项（params、principal、incarnation）。
// - RefState：引用状态 loading/live/failed/ended。
// - Held/Reference/RefIn：同步持有的引用、等待就绪的引用、引用成员输入。
// - RevokedBy：应用提供的撤销判定函数（给定 principal 与撤销值，回答是否被撤销）。
// - RootOptions：host.root 的 principal 选择。
// - RouteHandle/RouteOptions：host.route 返回的地址控制（retry/suspend）与路由选项。
// - OnHandler/OnLiveHandler/OnNativeHandler/RoutineDeclarations：对象声明的 routine 处理器与声明表。
// - sleep/untilAborted：可取消的 sleep 与只等待取消的辅助函数。
// - PluginFacet：load/reload 接受的插件 facet 形状。
// 组合与典型调用顺序：defineFacet 声明插件 -> createHost({ onError }) 建立宿主 -> host.load([facet], context) 发布声明
// -> host.get/hold/root/registry 使用对象与注册表 -> host.close(context) 逆序回收。
// 示例：import { createHost, defineFacet } from "@earendil-works/chord";
//       const host = createHost({ onError: (error) => console.error(error) });
//       await host.load([defineFacet<AppPrincipal>((h) => h.serve(Counter, factory))], context);
//       const counter = await host.get(Counter, { name: "a" }, context);
// 建议阅读顺序：先读本清单定位入口；再读 host.ts 的 Host 接口与 load；插件视角读 facet.ts/attempt.ts；
// 调用方视角读 reference.ts；最后读 object.ts 理解对象跨尝试状态机。

// 活跃计数：链接进来的 hold、运行中的调用、任务与 linger 对象；实现见 activity.ts。
export type { ActivityCounts } from "./activity.ts";
// 工厂与激活时的 self 接口：插件实现对象时接触到的表面。
export type { Factory, Self, StoreSelf } from "./attempt.ts";
// 方法处理器、routine 和 ctx.get 拿到的调用上下文。
export type { Ctx } from "./ctx.ts";
// defineFacet 是运行时函数（把一个 setup 包装成 Facet）；其余是 facet 声明相关的类型。
export { defineFacet, type Facet, type FacetHost, type FacetSelf, type ServeOptions } from "./facet.ts";
// 引用成员跟随（follow）的观察者接口，供上层做跨实例跟随。
export type { FollowAttach, FollowAttachment, FollowObserver } from "./follow.ts";
export {
	type CommittedReload,
	createHost,
	type GetOptions,
	type Host,
	type HostError,
	type HostOptions,
	type LinkOptions,
	type LoadReport,
	type PluginFailure,
	type Position,
	type ReloadedObject,
	type ReloadOptions,
	type ReloadReport,
} from "./host.ts";
// createHost 是建构宿主实例的运行时入口；HostOptions/Host 等类型描述 `load`、`get`、`hold`、`route` 的契约。
// 原生资源句柄及其关闭原因；`self.open` 返回 Native。
export type { Native, NativeCloseReason, NativeOptions } from "./native.ts";
// `host.references(Type)` 列表中的一项：params、principal 与 incarnation。
export type { Presence } from "./presence.ts";
// `ref.state` 的取值：loading、live、failed 或 ended。
export type { RefState } from "./ref-state.ts";
// 引用（Reference）、立即返回的引用（Held）以及引用成员的输入类型。
export type { Held, Reference, RefIn } from "./reference.ts";
// 应用的撤销判定函数：给定 principal 和撤销值，回答是否被撤销。
export type { RevokedBy } from "./revocation.ts";
// `host.root(fn, ctx, options)` 的选项（例如显式指定 principal）。
export type { RootOptions } from "./root.ts";
// `host.route` 返回的地址控制（retry、suspend）及其选项。
export type { RouteHandle, RouteOptions } from "./route.ts";
// 对象声明的 routine 处理器与声明表。
export type { OnHandler, OnLiveHandler, OnNativeHandler, RoutineDeclarations } from "./routines.ts";
// 两个运行时辅助函数：可取消的 sleep 与 untilAborted。
export { sleep, untilAborted } from "./sleep.ts";
// `load`/`reload` 接收的插件 facet 形状。
export type { PluginFacet } from "./staging.ts";
