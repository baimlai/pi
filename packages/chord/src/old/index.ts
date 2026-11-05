// Chord v1 (`@earendil-works/chord/old`), unchanged: the runtime p2 runs on, removed once p2 runs on Chord v2. It
// re-exports the foundations it was built with; new code imports them from `/context`, `/json`, `/delta`, `/watch`.
// 这是仍供 p2 使用的 Chord v1 公共入口，只有重导出，没有对象工厂或宿主启动流程。
// 示例：从 @earendil-works/chord/old 导入 remote、createHost；这不会自动创建宿主或连接网络。

// export type 只在开发时提供类型，运行时会擦除；以下基础类型/工具来自 v2 也使用的 context、delta、json、watch 模块。
export type { Context, ContextKey } from "../context/index.ts";
export type { Draft } from "../delta/index.ts";
export { type CopyJsonOptions, copyJson, isJsonValue, type JsonRepresentation, type JsonValue } from "../json.ts";
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
export type { EventOf, Resource, ResourceDeclaration, Subscribable, ValueOf } from "./declare.ts";
export { ChordError, type ChordErrorCode, forbidden, invalid, isChordError } from "./errors.ts";
export type { ConnectOptions, PrincipalMatch, PrincipalPattern, Route } from "./host.ts";
// 宿主负责对象生命周期、根调用、插件安装和热重载；defineFacet 只声明插件，createHost 才建立运行时。
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
export { defineRegistry, type Registry, type RegistryTable, type RegistryView } from "./registry.ts";
export type { ReloadOptions, ReloadReport } from "./reload.ts";
// replicatedState 是可独立于宿主使用的可观察状态；同组类型区分可写模式和外部权威源附着模式。
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
export type { Ctx, GetOptions, Readable, RefStatus, Shape, StateEvent } from "./types.ts";
export { acceptWebSockets, type WebSocketAcceptOptions, type WebSocketServerLike } from "./websocket.ts";
export { type Frame, PROTOCOL_VERSION } from "./wire.ts";
