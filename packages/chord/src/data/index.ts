// Data for apps: Chord's errors and plugin errors, principals, and how a plugin's open reports a broken configuration.

// 文件导读
// 所属包与模块：packages/chord/src/data 的应用入口，对应 Chord 数据层对插件/应用公开的 API。
// 职责边界：只转出错误类型、失败标记和身份类型；参数/地址/验证器等内部能力在 internal.ts。
// 上游：应用代码 import；下游：插件抛 ChordError/PluginError，用 broken 标记不可恢复的 open 失败，
// 用 Principal 声明调用方身份。
// 结果与错误流向：本文件不执行代码；转出的错误类型在应用抛出/捕获时生效。
// 能力清单：
// - ChordError/ChordErrorCode/ChordErrorReason（类型与构造器）：Chord 的统一错误。
// - isChordError（函数）：错误类型谓词。
// - PluginError（类）：插件自定义错误。
// - broken（函数）：标记 open 的 broken 失败。
// - FailureCause（类型）：transient/broken/waiting 三类原因。
// - Principal/PrincipalKeyFunction（类型）：应用身份与自定义键函数。
// 组合关系与典型调用顺序：插件 throw broken(...) 或 new PluginError(...)；调用方 catch 后用 isChordError
// 区分；身份类型用于 ctx 的 principal 参数。
// 示例（真实签名）：throw new PluginError("quota", "full", { limit: 10 });
// 建议阅读顺序：errors.ts -> failure.ts -> principal.ts；本文件仅是应用侧索引。

// 应用入口只公开错误、失败标记和身份类型；export type 的类型在运行时擦除，具体实现仍在对应文件。
export {
	ChordError,
	type ChordErrorCode,
	type ChordErrorReason,
	isChordError,
	PluginError,
} from "./errors.ts";
export { broken, type FailureCause } from "./failure.ts";
export type { Principal, PrincipalKeyFunction } from "./principal.ts";
