// Registries for apps: tokens, what a provider serves them with, the table `compose` gets and its helpers, and the
// composed value readers follow.

// 文件导读
// 所属包与模块：packages/chord/src/registries 的应用入口，对应 Chord 注册表层对插件/应用公开的 API。
// 职责边界：只做 re-export，不实现逻辑；把 token 定义、provider/表/值类型与表辅助函数暴露给应用，
// 内部记录（RegistryRecord/RegistryContribution）留在 internal.ts。
// 上游：应用/插件 import；下游：host 为每个 token 建立记录，合成结果经 RegistryValue 进入 watch 与读取路径。
// 结果与错误流向：本文件不执行代码、不抛错；错误来自 defineRegistry 的检查或被转出函数被调用时。
// 能力清单：
// - keyedEntries/orderedEntries（函数）：compose 用的键值表与有序列表辅助函数。
// - TableItem（类型）：带来源信息的表项。
// - ComposeContext（类型）：compose 的 report 上下文。
// - Contribution（类型）：直接值/JSON watchable/原生 watchable 三种贡献。
// - defineRegistry（函数）：创建 token 的唯一运行时入口。
// - Registry（类型）：带 name/version 的 token。
// - RegistryAccepts（类型）：旧版本 contribution/value 适配表。
// - RegistryConflict（类型）：冲突描述。
// - RegistryEntry/RegistryTable（类型）：表项与只读表。
// - RegistryProvider（类型）：定义者插件提交的 compose 与 accepts。
// - RegistryValue（类型）：读者看到的已合成原生 watchable。
// 组合关系与典型调用顺序：defineRegistry -> host.serve(provider) -> 贡献者提交 Contribution ->
// compose 使用 keyedEntries/orderedEntries -> 读者使用 RegistryValue。
// 示例（真实签名）：const R = defineRegistry<Route, RouteTable>("routes", { version: 1 });
// 建议阅读顺序：先 registry.ts（token 与 provider），再 entries.ts（表辅助），最后按需查看 record/value 的内部文档。

// keyedEntries/orderedEntries：把贡献条目按稳定规则排成表项的辅助函数，表项统一为 TableItem。
// 规则（同名插件先到者胜、重复上报、orderOf 稳定排序）在 entries.ts 中实现。
export { keyedEntries, orderedEntries, type TableItem } from "./entries.ts";
export {
	// ComposeContext 是 compose 回调收到的上下文（host、当前表、汇报错误的出口等）。
	type ComposeContext,
	// Contribution 是“一个插件可能提供的值”：直接值、JSON watchable 或原生 watchable。
	type Contribution,
	// defineRegistry 是唯一在运行时创建 token 的函数。
	defineRegistry,
	// Registry 是 token 类型：带名称和版本，可被跨插件共享。
	type Registry,
	// RegistryAccepts 描述旧版本读者如何把新值适配回来。
	type RegistryAccepts,
	// RegistryConflict 是同一键被不同插件提供时的回报形状。
	type RegistryConflict,
	// RegistryEntry 是表中的一项：键、贡献者、版本、值。
	type RegistryEntry,
	// RegistryProvider 是插件注册到某个 token 时提交的提供者对象。
	type RegistryProvider,
	// RegistryTable 是 compose 看到的只读表。
	type RegistryTable,
	// RegistryValue 是读方拿到的已合成值，可 observe。
	type RegistryValue,
} from "./registry.ts";
