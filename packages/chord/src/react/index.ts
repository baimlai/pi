// Chord v2's React bindings (`@earendil-works/chord/react`; slice 11 §3): optional, non-React apps never load them.
// 统一转出 hooks 与外部 store 适配器；这里没有渲染调用，应用需要 HostProvider 与 hook 才会取得/监听资源。
// 所属：@earendil-works/chord/react 包的公共出口；只包含 React 绑定，没有样式或组件。
// 边界：纯重导出，导入本身无副作用；应用必须自行创建 HostProvider 并管理 host 生命周期。
// 导出：六个 hooks；ExternalStore 类型与 watchStore 适配器。
// 组合：HostProvider/useHost → useHold/useRegistry → useWatch/watchStore；useRefState 是 useWatch 的便捷包装。
// 示例：import { HostProvider, useHold } from "@earendil-works/chord/react";
// 阅读顺序：hooks → stores。

export { HostProvider, useHold, useHost, useRefState, useRegistry, useWatch } from "./hooks.ts";
export { type ExternalStore, watchStore } from "./stores.ts";
