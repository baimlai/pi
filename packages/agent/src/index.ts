// 包的公开入口，仅集中转发导出，不在这里初始化会话或请求模型。export * 不会把未导出的私有辅助函数变成公开 API。
// 暴露有状态的 Agent 类与创建选项；应用通常从这里开始使用本包。
export * from "./agent.ts";
// 暴露低层模型/工具循环，供需要自行管理状态和事件的宿主使用。
export * from "./agent-loop.ts";
// 暴露经过自建服务器转发模型请求的 streamProxy 及其类型。
export * from "./proxy.ts";
// 只公开设置默认函数的能力；读取兜底函数仍是包内实现细节。
export { setDefaultStreamFn } from "./stream-fn.ts";
// 暴露消息、工具、事件与回调契约；type/interface 在运行时被擦除。
export * from "./types.ts";
