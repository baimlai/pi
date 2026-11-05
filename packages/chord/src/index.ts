// Chord (`@earendil-works/chord`, v2, experimental): every layer's API for apps, and the store's surface for adapters
// (Durable's `StoreStorage`), marked internal. The Node components and the client surfaces are subpaths (`/http`,
// `/workers`, `/plugins`, `/app`, `/surfaces`, `/web`, `/react`, `/tui`); Chord v1 is `/old`.
//
// 文件导读
// 所属：packages/chord 的包根入口（package.json 的 "." 导出），汇总各层公共 API。
// 职责边界：本文件不实现逻辑，只决定公开面：哪些层整体再导出、哪些 store 适配器接口以 @internal 暴露。
// 上游是应用或存储适配器的 `import ... from "@earendil-works/chord"`；下游是各目录的 index.ts。
// 结果与错误都不在这里转换：导入的符号保持原签名，运行时错误由被导出的函数自己抛出。
// 能力清单（按导出组）：
// - contracts/data/documents/host/jobs/link/registries/state：各层的公共类型与入口函数，用 export * 整体转发。
// - store/adapter.ts：DecodedRow、OwnerTable、StoreOwnerTables，供存储适配器编码/解码行。
// - store/apply-batch.ts：applyBatch，同步层批量应用入口。
// - store/claims.ts：Claimant，声明/租约相关类型。
// - store/engine.ts：文档存取、内容加载、历史与记录的实现接口（均为 @internal）。
// - store/expression.ts / rows.ts / sql.ts / step.ts / store.ts：查询表达式、编码行、排序、批量步骤与 ChordStore 类型。
// - surfaces/index.ts：客户端 surface 的公共 API（web/react/tui 共享）。
// 组合与顺序：应用通常先导入 contracts 的类型，再用 host 创建 host/link，最后按需使用 store 适配器接口；
// 适配器通常只导入 @internal 的 store 符号。
// 示例：`import { applyBatch } from "@earendil-works/chord";` 或
// `import type { ChordStore } from "@earendil-works/chord";`
// 阅读顺序：先看 contracts 与 host 的 index，再看 store/index 与 adapter；只有实现存储适配器时才需要读 @internal 项。
// 注意：`export *` 转发所有命名导出（不含 default）；标 @internal 的导出不是稳定公共 API。

// 分层 API：契约、数据/参数、文档、host、后台任务、链接、注册表、状态。
export * from "./contracts/index.ts";
export * from "./data/index.ts";
export * from "./documents/index.ts";
export * from "./host/index.ts";
export * from "./jobs/index.ts";
export * from "./link/index.ts";
export * from "./registries/index.ts";
export * from "./state/index.ts";
// 以下是 store 层面向适配器的接口。`type` 修饰符让 DecodedRow 只作为类型导出，运行时不存在；
// OwnerTable/StoreOwnerTables 是真实值导出。
/** @internal The store's surface for adapters (slice 6b §2.1). */
export { type DecodedRow, OwnerTable, StoreOwnerTables } from "./store/adapter.ts";
/** @internal The sync layer's batch apply (slice 6b §1.6). */
export { applyBatch } from "./store/apply-batch.ts";
/** @internal */
export type { Claimant } from "./store/claims.ts";
/** @internal */
export {
	type DocumentAddress,
	type DocumentContent,
	type DocumentEntry,
	type DocumentHistory,
	type DocumentPoint,
	type DocumentRecord,
	type DocumentScope,
	findDocument,
	findDocumentEntry,
	insertDocument,
	listDocumentEntries,
	listDocuments,
	loadContent,
	loadDocument,
	type OwnedDocumentEntry,
	readDocument,
	readDocumentEntry,
	retireRecord,
	type StoredDocument,
	writeContent,
} from "./store/engine.ts";
/** @internal */
export type { WhereNode } from "./store/expression.ts";
export * from "./store/index.ts";
/** @internal */
export type { EncodedRow } from "./store/rows.ts";
/** @internal */
export type { Order } from "./store/sql.ts";
/** @internal */
export type { StagedWrite, Step } from "./store/step.ts";
/** @internal */
export type { ChordStore, SeriesCommit, SeriesResult } from "./store/store.ts";
export * from "./surfaces/index.ts";
