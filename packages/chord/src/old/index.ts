// Chord v1 (`@earendil-works/chord/old`), unchanged: the runtime p2 runs on, removed once p2 runs on Chord v2. It
// re-exports the foundations it was built with; new code imports them from `/context`, `/json`, `/delta`, `/watch`.
// 这是仍供 p2 使用的 Chord v1 公共入口，只有重导出，没有对象工厂或宿主启动流程。
// 示例：从 @earendil-works/chord/old 导入 remote、createHost；这不会自动创建宿主或连接网络。
/**
 * Chord v1 旧实现：公共入口（`@earendil-works/chord/old`）。
 *
 * 所属包与功能模块：packages/chord/src/old/index.ts，是 Chord v1 对外唯一的聚合导出文件。
 * p2 运行在 v1 上；p2 迁移到 Chord v2 后整个 old/ 目录会被删除。
 *
 * 解决什么问题：应用不应该记住每个类型/函数在哪个文件，也不应该依赖内部目录结构。本文件把 v1 的
 * 契约、宿主、链路、对象、状态、注册表、重载、错误和线协议集中在一个稳定入口；同时把 v1 也使用的
 * 基础模块（context/delta/json/watch）一并导出，让应用只 import 一次。
 *
 * 职责边界：本文件只有重导出，没有运行时逻辑。导入它不会创建宿主、启动网络、注册插件或执行任何声明；
 * 这些动作分别由 createHost、host.accept/connect、host.load 触发。`export type` 在编译后完全擦除，
 * 混在值导出中的 `type X` 说明符也只影响类型层。
 *
 * 上游入口：应用代码 `import { ... } from "@earendil-works/chord/old"`；测试也通过本入口构造内存链路。
 * 下游依赖：../context、../delta、../json、../watch（v2 共用的基础模块），以及 ./cell、./connection、
 * ./contract、./declare、./errors、./host、./link、./object、./registry、./reload、./state、./types、
 * ./websocket、./wire。
 *
 * 能力清单（按导出组）：
 * - context/delta/json/watch：Context、ContextKey、Draft、JSON 值工具、Watch/NativeWatch 家族。
 * - cell/connection：Cell 类型、LinkOptions/AcceptOptions（链路与 accept 配置）。
 * - contract：remote/local/method/opaque/hostNamed/hostFamily、bind/coverage、契约推导类型
 *   （AnyContract/Ref/InputOf/Description/Placement 等）。
 * - declare/errors：工厂资源与事件声明类型；ChordError、错误码与 forbidden/invalid/isChordError 运行时辅助。
 * - host：createHost（建立运行时）、defineFacet（声明插件）、Host/Facet/HostOptions 等类型。
 * - link：memoryLinkPair（离线测试）、ipcLink、webSocketLink、Link 类型、PACK_THRESHOLD/inflateMessage。
 * - object：Self、Factory、ServeOptions、Lifetime、StateInit/StateOptions 等对象声明类型。
 * - registry/reload：defineRegistry 与 Registry/RegistryView/ReloadOptions/ReloadReport。
 * - state：replicatedState 与可写/附着/投递等类型。
 * - types/websocket/wire：Ctx/GetOptions/Readable/RefStatus/Shape/StateEvent、acceptWebSockets、
 *   Frame/PROTOCOL_VERSION。
 *
 * 组合关系与典型调用顺序：
 * 1. createHost({ name, self }) 建立本进程的宿主；
 * 2. defineFacet(setup) 声明插件（setup 中通过 self.serve/self.get 等注册对象）；
 * 3. host.load(facet) 安装插件（或 host.reload 热重载）；
 * 4. 客户端/子 host 通过 memoryLinkPair、ipcLink 或 webSocketLink 建立链路，再 host.accept/connect；
 * 5. 业务代码通过 Ctx.get 拿引用，订阅状态或调用方法；错误用 ChordError/isChordError 处理。
 *
 * 示例（真实签名形状）：
 *   import { createHost, defineFacet } from "@earendil-works/chord/old";
 *
 *   const host = createHost<{ user: string }>({
 *     name: "session:S1",
 *     self: { user: "server" },
 *   });
 *   const facet = defineFacet<{ user: string }>((api) => {
 *     // 在这里用 api.serve(...) 声明对象；defineFacet 只收集声明，不启动对象。
 *   });
 *   // 之后再由 host.load([facet]) 安装；本入口的导入本身不产生副作用。
 *
 * 建议阅读顺序：先读 ./types（Ctx/Readable/RefBase）和 ./contract（Ref 的推导），建立对象模型；
 * 再读 ./host 与 ./link、./connection 理解宿主和链路；最后读 ./state、./registry、./reload。
 * 只使用 API 的读者可以先看 createHost/defineFacet 的签名，再按需查阅其余类型。
 */

// export type 只在开发时提供类型，运行时会擦除；以下基础类型/工具来自 v2 也使用的 context、delta、json、watch 模块。
// context：Context/ContextKey 与 v2 共用的调用上下文基础类型。
// ContextKey 是带类型的键，用于把应用值挂到 Context 上；这里只导出类型，运行时值在 ../context 实现。
export type { Context, ContextKey } from "../context/index.ts";
export type { Draft } from "../delta/index.ts";
export { type CopyJsonOptions, copyJson, isJsonValue, type JsonRepresentation, type JsonValue } from "../json.ts";
// watch：Watch/NativeWatch 是 v1 与 v2 共用的可观察原语。
// Watch 家族提供句柄与结束原因；NativeWatch 用于包装原生资源。
// 同一导出列表中混用 `type` 说明符（type Watchable 等），表示这些名字只存在于类型层。
export {
	NativeWatch,
	type NativeWatchable,
	type NativeWatchCall,
	type NativeWatchHandle,
	Watch,
	type Watchable,
	type WatchCall,
	type WatchEnd,
	type WatchHandle,
} from "../watch.ts";
// 单元格、连接参数供应用描述状态和链路配置；同组导出中的 type 也表示仅类型名称。
export type { Cell } from "./cell.ts";
export type { AcceptOptions, LinkOptions } from "./connection.ts";
// 契约声明和绑定：区分本地/远程对象、方法与不透明原生值，Ref 等类型由声明推导调用接口。
// contract：契约声明与引用类型推导的核心 API。
// - remote/local 声明对象类型；method/opaque 声明方法与不透明值；hostNamed/hostFamily 描述寻址；
// - bind/coverage 绑定并检查版本适配；Ref/InputOf 等类型由契约推导，不产生运行时代码。
// 注意：remote/local 等是运行时函数，会创建契约对象并计算指纹；仅在类型位置使用不会触发它们。
export {
	type Accepts,
	type Adapter,
	type AnyContract,
	bind,
	coverage,
	type Description,
	type HostFamily,
	type HostNamed,
	hostFamily,
	hostNamed,
	type ImplementationOf,
	type InputOf,
	type LocalContract,
	local,
	method,
	opaque,
	type Placement,
	type PlacementFor,
	type Ref,
	type RemoteContract,
	remote,
} from "./contract.ts";
// 工厂资源/事件声明只导出类型；错误辅助函数则是可在运行时调用的值。
// declare：对象工厂可声明的资源/事件类型（Resource、Subscribable、EventOf 等）。
// 这些名字只存在于类型层；真正的资源打开/关闭由 object.ts 的 Self 实现执行。
export type { EventOf, Resource, ResourceDeclaration, Subscribable, ValueOf } from "./declare.ts";
// errors：ChordError 与错误辅助函数是运行时代码。
// isChordError 用于跨模块/跨链路的错误识别；forbidden/invalid 构造带稳定 code 的错误，便于应用分支处理。
export { ChordError, type ChordErrorCode, forbidden, invalid, isChordError } from "./errors.ts";
export type { ConnectOptions, PrincipalMatch, PrincipalPattern, Route } from "./host.ts";
// 宿主负责对象生命周期、根调用、插件安装和热重载；defineFacet 只声明插件，createHost 才建立运行时。
// host：createHost 建立宿主运行时，defineFacet 只声明插件。
// 典型顺序：createHost -> defineFacet -> host.load；HostOptions 控制名字、self、principalKey、超时、linger 等。
// 注意：host.accept/connect 才会建立连接；createHost 本身不监听端口。
export {
	createHost,
	defineFacet,
	type Facet,
	type FacetApi,
	type FacetDefinition,
	type FacetLoader,
	type Host,
	type HostOptions,
	type LoadOptions,
	type PluginRef,
	type RootOptions,
} from "./host.ts";
// 传输层将内存、Node IPC 或 WebSocket 统一成 Link；内存对常用于离线测试，压缩辅助供转发端使用。
// link：把内存、Node IPC、WebSocket 统一成 Link。
// memoryLinkPair 常用于离线测试（一对内存端点）；ipcLink/webSocketLink 用于真实进程/浏览器；
// PACK_THRESHOLD 与 inflateMessage 供传输层打包/解包大消息，应用通常不需要直接调用。
export {
	type IpcChannel,
	inflateMessage,
	ipcLink,
	type Link,
	memoryLinkPair,
	PACK_THRESHOLD,
	type WebSocketLike,
	type WebSocketLinkOptions,
	webSocketLink,
} from "./link.ts";
// Self 是对象工厂拿到的声明接口；这些类型约束工厂和生命周期选项，不会自行执行声明或校验。
// object：对象工厂与生命周期声明类型。
// Self 是工厂拿到的声明接口；Factory/ServeOptions/StateInit 等约束工厂返回值与状态初始化。
// 这些类型不会自行执行声明；运行时行为在 object.ts 的 ObjectImpl/RefImpl。
export type {
	Factory,
	HostServeOptions,
	Lifetime,
	ReferencedServeOptions,
	Self,
	ServeOptions,
	ServeOptionsFor,
	StateInit,
	StateOptions,
} from "./object.ts";
// 注册表描述以及重载报告类型；实际注册表由宿主按代码版本维护。
// registry/reload：注册表定义与热重载报告。
// defineRegistry 声明一个可贡献/组合的注册表；实际表由宿主按代码版本维护（见 host.reload）。
// ReloadOptions/ReloadReport 描述重载输入与结果；重载失败的原因会出现在 report 中。
export { defineRegistry, type Registry, type RegistryTable, type RegistryView } from "./registry.ts";
export type { ReloadOptions, ReloadReport } from "./reload.ts";
// replicatedState 是可独立于宿主使用的可观察状态；同组类型区分可写模式和外部权威源附着模式。
// state：replicatedState 是独立于宿主也可使用的可观察状态。
// 可写模式（MutableReplicatedState）与外部权威源附着模式（AttachedReplicatedState）在类型上区分；
// replicatedState(...) 是运行时工厂。
export {
	type AttachedReplicatedState,
	type MutableReplicatedState,
	type ReplicatedState,
	type ReplicatedStateDelivery,
	type ReplicatedStateSource,
	type ReplicatedStateSourceAttachment,
	type ReplicatedStateSourceFrame,
	type ReplicatedStateSourceOptions,
	replicatedState,
} from "./state.ts";
// 公共上下文/引用状态类型、WebSocket 服务端接入器与帧协议；此入口本身不做认证。
// types/websocket/wire：应用直接接触的公共类型与线协议。
// Ctx/GetOptions/Readable/RefStatus/Shape/StateEvent 来自 ./types；
// acceptWebSockets 用于把 WebSocket 服务端接入为 Link；Frame/PROTOCOL_VERSION 是线协议与会话版本。
// 注意：acceptWebSockets 只做协议接入，不做认证；principal 由应用在 accept 时决定。
export type { Ctx, GetOptions, Readable, RefStatus, Shape, StateEvent } from "./types.ts";
export { acceptWebSockets, type WebSocketAcceptOptions, type WebSocketServerLike } from "./websocket.ts";
export { type Frame, PROTOCOL_VERSION } from "./wire.ts";
