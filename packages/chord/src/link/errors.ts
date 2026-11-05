// Errors on the wire: a ChordError's JSON or a plugin's code, message and details; never a stack or a cause.

// 文件导读
// 所属模块：packages/chord/src/link 的错误线格式转换，连接 data 层错误类型与 message.ts 的 WireError。
// 职责与边界：把任意 throw 值投影成可传输数据（wireError），以及把收到的 WireError 重建为可再次 throw 的异常
// （errorFromWire）。只处理错误内容，不发送消息、不决定 failed/error 消息的 kind，也不包含堆栈/cause。
// 上游入口：remote/host 在构造 error、failed、gone 消息前调用 wireError；收到这些消息后调用 errorFromWire
// 交给调用方或业务代码。
// 下游依赖：data/index.ts 的 ChordError/isChordError/PluginError；data/internal.ts 的 chordErrorFromJson
// 负责校验 ChordError JSON 信封；json.ts 的 JsonValue 只用于类型。
// 结果与错误流向：wireError 总是返回 WireError；errorFromWire 对 plugin 分支返回 PluginError，
// 对 chord 分支返回 ChordError，畸形 envelope 由 chordErrorFromJson 抛出（协议错误，最终关闭链路）。
// 能力清单：
// - wireError：unknown -> WireError，ChordError 保真，PluginError 保留 code/message/details，
//   普通 Error 与任意值降级为 plugin/internal。
// - errorFromWire：WireError -> ChordError | PluginError，供消费方重新抛出。
// 典型调用顺序：catch (error) -> wireError(error) -> codec.encode({ kind: "error", error }) -> 网络
// -> codec.decode -> errorFromWire(message.error) -> throw/reject 给业务调用方。
// 示例：wireError(new PluginError("missing", "no such member")) 返回
//       { kind: "plugin", code: "missing", message: "no such member" }；
//       errorFromWire(that) 再得到等价的 PluginError 实例。
// 建议阅读顺序：先看 WireError 在 message.ts 的定义，再读 wireError 的三个分支，最后读 errorFromWire 的重建逻辑。
import { type ChordError, isChordError, PluginError } from "../data/index.ts";
import { chordErrorFromJson } from "../data/internal.ts";
import type { JsonValue } from "../json.ts";
import type { WireError } from "./message.ts";

/** What crosses for a thrown value: a ChordError, a PluginError, or anything else as the plugin code `internal`. */
// 把任意抛出值变成可传输错误数据；返回 Chord 或 plugin 分支，不发送消息、不包含堆栈和 cause。
// 例如 new Error("x") 得 {kind:"plugin",code:"internal",message:"x"}；PluginError 保留自身 code/details。
export function wireError(error: unknown): WireError {
	// unknown 先用实际 instanceof 谓词判断 ChordError；toJSON 只投影协议允许的字段。
	if (isChordError(error)) return { kind: "chord", error: error.toJSON() };
	// 第二种运行时类别是插件显式抛出的公开错误，不能仅靠 TS 类型判断外部 throw。
	if (error instanceof PluginError) {
		// 解构取出公开字段，details 保持引用，不深拷贝。
		const { code, message, details } = error;
		// 对象展开 ... 只在 details 存在时加字段；不存在时不生成 details:undefined。
		return { kind: "plugin", code, message, ...(details === undefined ? {} : { details }) };
	}
	// 普通 Error 用 message，其他抛出值转字符串；String 的自定义转换若抛错仍会向上传播。
	return { kind: "plugin", code: "internal", message: error instanceof Error ? error.message : String(error) };
}

/** The error a consumer rethrows. A malformed ChordError envelope throws (a protocol error). */
// 从已解码错误包装重建可 throw 的异常；返回两种类之一，既不抛出该业务错误也不打印它。
// 例如 plugin 的 code="missing" 变 PluginError；Chord 包装由 chordErrorFromJson 进一步校验，畸形则抛协议错误。
export function errorFromWire(error: WireError): ChordError | PluginError {
	// kind 是联合类型判别字段，TS 在分支内知道有 error 属性；callee 运行时检查 code/reason/message/额外字段。
	if (error.kind === "chord") return chordErrorFromJson(error.error);
	// Fresh JSON from the link: details are JSON.
	// 外层 schema 已检查 plugin 字段形状；as 只声明 fresh JSON 的 details 类型，不遍历/复制它。
	return new PluginError(error.code, error.message, error.details as JsonValue | undefined);
}
