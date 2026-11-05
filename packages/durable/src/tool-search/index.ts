// 所属：packages/durable/src/tool-search，`tool_search` 工具的公开入口，由 package.json 的 "./tool-search" 导出。
// 解决的问题：把工具发现相关 API 集中到一个子路径；本文件是纯重导出（barrel），不安装扩展、不创建注册表、
// 不执行搜索，除加载被重导出模块外没有运行时副作用。
// 上游：应用代码调用 registry.install(createToolSearchExtension())，或直接用 createToolSearchTool 组合自己的扩展；
// 下游：./tool-search.ts 中 defineTool/defineExtension 与 ../search.ts 的 BM25 排名。
// 能力清单：
// - createToolSearchExtension()：返回含 tool_search 的 Extension，交给 Registry.install。
// - createToolSearchTool()：返回单个 ToolRegistration，便于自定义扩展组合。
// - DEFAULT_TOOL_SEARCH_LIMIT：未传 limit 时的默认结果数（8）。
// - TOOL_SEARCH_TOOL_NAME：固定注册名 "tool_search"。
// - ToolSearchToolDetails：结果 details 形状 { loaded: string[] }。
// 组合与典型顺序：createToolSearchExtension() → registry.install() → 会话解析 deferred 工具 → 模型调用
// tool_search → control.addTools 写入 modelTools → 下一次请求提供已加载工具。
// 示例：import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
//       registry.install(createToolSearchExtension());
// 建议阅读顺序：本文件只列出公开面；参数 schema、执行流程和往返类型见 ./tool-search.ts。
// 公开工具发现的构造函数、默认上限和结果详情类型；这里只重导出，不安装扩展或执行搜索。
// export { ... } from 在一条语句里重新导出多个绑定；type 前缀表示 ToolSearchToolDetails 只作为类型重导出。
// 运行时实际导入的是 createToolSearchExtension/createToolSearchTool 及两个常量；类型会在编译后被擦除。
export {
	createToolSearchExtension,
	createToolSearchTool,
	DEFAULT_TOOL_SEARCH_LIMIT,
	TOOL_SEARCH_TOOL_NAME,
	type ToolSearchToolDetails,
} from "./tool-search.ts";
