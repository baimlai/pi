// State for Chord's layers: the batch, sources (JSON and native), derives, constants and writables behind the
// app's watchables.

// 文件导读
// 所属包与模块：packages/chord/src/state 的内部入口，供 Chord 的 host/文档/注册表层使用。
// 职责边界：只做 re-export，把状态层内部原语暴露给兄弟模块；应用应改用 ./index.ts，避免依赖内部机制。
// 上游：host/root.ts、host/facet.ts、registries/* 等 import 本文件。下游：这些原语驱动 watch 回调、
// 文档读取和注册表值更新；本文件自身不创建对象、不订阅、不抛错。
// 能力清单：
// - Batch/BatchError/Delivered（类和类型）：同步发布批次、其错误联合与可投递接口。
// - Derive/DeriveInput/DeriveSource（类和类型）：惰性派生值及其输入/来源类型。
// - FollowedSource/NativeSource（类）：原生值来源的完整与最小实现。
// - NativeObservation/NativeObserver/NativeStart（类型）：原生观察与启动点形状。
// - Constant/Dependent/handedOut/Source/Subscriber/WatchStart（类、接口、函数、类型）：
//   常量、失效接收方、错误交出前的堆栈字符串化、JSON 来源基类、订阅者与 watch 起点。
// - WritableOwner/WritableSource（类型和类）：可写值的拥有者与实现。
// 组合关系与典型调用顺序：host 先建 Batch，再构造 Source/Derive/WritableSource；derive 通过 Dependent
// 接口接收失效；Source.deliver 在 Batch.commit 中被调用；handedOut 在跨层交出错误前使用。
// 示例（真实签名）：import { Batch, Derive } from "./state/internal.ts";
// const derive = new Derive([source], (values) => values[0] as number, batch);
// 建议阅读顺序：batch.ts -> watchable.ts -> native-source.ts -> derive.ts -> writable.ts；本文件仅是索引。

// Batch 是一次同步发布批次：adopt 变更、投递帧、运行 flush 都在同一批内完成，
// 同时提供 reentrancy 检查（running/computing）和 changed/flushing 查询。
// BatchError 是批次内监听器错误的判别联合，Delivered 是“能被批次投递”的最小接口。
export { Batch, type BatchError, type Delivered } from "./batch.ts";
// Derive 是惰性、拉取式的派生值；DeriveInput 是它可接受的输入联合（JSON source、常量、原生 source），
// DeriveSource 是可被派生读取的非原生来源。
export { Derive, type DeriveInput, type DeriveSource } from "./derive.ts";
// FollowedSource 管理“跟随一个原生观察者”的共享订阅；NativeSource 是原生（非 JSON）值的基类。
// NativeObservation/NativeObserver/NativeStart 均只在编译期约束回调形状。
export {
	FollowedSource,
	type NativeObservation,
	type NativeObserver,
	NativeSource,
	type NativeStart,
} from "./native-source.ts";
// Source 是 JSON 值来源的抽象基类：维护依赖者、watcher、订阅者，负责失效与投递。
// Constant 是固定值实现；Dependent 是“可被上游失效”的对象接口；handedOut 用于把一次读取中
// 直接交出的 source 压入强制投递栈；Subscriber 描述订阅者回调；WatchStart 是 watch 启动结果联合。
export { Constant, type Dependent, handedOut, Source, type Subscriber, type WatchStart } from "./watchable.ts";
// WritableSource 是应用可写的值实现；WritableOwner 描述谁拥有它（用于 seal/所有权判定）。
export { type WritableOwner, WritableSource } from "./writable.ts";
