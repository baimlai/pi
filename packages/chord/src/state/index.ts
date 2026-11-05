// State for apps: watchables, constants, writables, observers of native sources, and the derive helper `mapShared`.

// 文件导读
// 所属包与模块：packages/chord/src/state 的应用入口，对应 Chord 状态层对插件/应用公开的 API。
// 职责边界：只做 re-export，不实现逻辑；把“应用可以安全使用”的状态能力与内部机制（Batch、Source、Derive）
// 隔开。上游是应用代码 import；下游是 host/ctx 把 constant、mapShared 的结果或 Writable 传给插件并最终被 watch。
// 结果与错误流向：本文件不抛错、不执行任何构造；错误只可能来自被转出函数被调用时的实现文件。
// 能力清单：
// - Watchable（类型）：可被 watch 的只读值契约，来自 ../watch.ts。
// - mapShared（函数）：派生映射工厂，对对象元素按身份缓存结果。
// - NativeObservation/NativeObserver（类型）：原生 source 的观察结果与观察者签名。
// - constant（函数）：创建永不变化的 watchable。
// - Writable（类型）：可 set 的进程内值接口（实现 WritableSource 在 internal.ts）。
// 组合关系与典型调用顺序：应用用 constant 包裹固定配置，用 mapShared 在 derive 中投影元素，
// 把 Writable 交给需要回写的回调；这些值随后进入 watch/derive/registry 的依赖链。
// 示例（真实签名）：const config = constant({ pageSize: 20 } as const);
// const views = mapShared((doc: Doc) => ({ id: doc.id }));
// 建议阅读顺序：先看本清单，再按需进入 derive.ts（mapShared）、watchable.ts（constant）、
// native-source.ts（观察者类型）、writable.ts（Writable）。

// 只转出类型 Watchable：它在编译期描述“可被 watch 的只读值”，运行时没有对应实现对象。
// 来源 ../watch.ts 而不是本目录，因为 watch 的公共契约由 host 层定义，状态层只负责实现。
export type { Watchable } from "../watch.ts";
// mapShared 是 derive 的便捷封装：对数组/对象元素做按身份共享的映射，适合把一组文档转成一组视图。
// 注意它只共享“同一引用”的结果，基本类型每次都会重新映射，见 derive.ts 的实现。
export { mapShared } from "./derive.ts";
// 两个类型都只有编译期意义：NativeObservation 是原生值的一次观测结果，NativeObserver 是接收观测回调的函数签名。
// 应用实现后者、传入原生 source，不会在这里做任何运行时校验。
export type { NativeObservation, NativeObserver } from "./native-source.ts";
// constant 创建一个永不变化的只读 watchable；对固定配置值使用它，可避免每次读取重新计算。
export { constant } from "./watchable.ts";
// Writable 是应用可以 set 的值的接口；具体实现 WritableSource 属于内部入口，不在应用入口暴露。
export type { Writable } from "./writable.ts";
