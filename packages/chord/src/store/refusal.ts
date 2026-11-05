// A refused commit as Chord's owners take it (slice 6b D4, §1.4): the store rejects a step it rolled back with the
// step's own error, unchanged (Durable's Storage semantics); Chord classifies it: an `int` column's `CHECK` (a
// plugin's value out of range) fails only its transaction, any other refusal means memory and disk disagree.

// 文件导读
// 所属：packages/chord/src/store（store 层，提交拒绝分类）。
// 职责边界：把提交抛出的未知错误分成 check（只失败事务）、broken（对象也失败）或 undefined（store 自己的关闭/失败错误原样传播）；不改数据库。
// 上游：ChordStore 的提交路径在 catch 中调用 refusalOf。下游：Chord 对象按 Refusal.kind 决定是否进入 broken 状态；对外错误码为 invalid/args 或 unavailable。
// 能力清单：
// - Refusal：check|broken 的标签联合；
// - SQLITE_CONSTRAINT_CHECK：SQLite 扩展码 275；
// - refusalOf：分类入口，输入 unknown 错误与定位 label；
// - isCheck：识别 CHECK 拒绝，数字扩展码优先、消息片段兜底。
// 组合顺序：catch(error) -> refusalOf(error,label) -> undefined 原样抛；check 只拒绝本次事务；broken 同时标记对象 broken。
// 示例：refusalOf(new Error("CHECK constraint failed: n"), "notes.put") 返回 { kind: "check", error: invalid/args }。
// 建议阅读顺序：Refusal/常量 -> refusalOf -> isCheck。

import { ChordError, isChordError } from "../data/index.ts";

/** How a Chord commit ended that the store rejected: `check` fails the transaction only, `broken` its object too. */
export type Refusal =
	// kind 是判别字段；调用方先检查 check/broken，再决定只拒绝事务还是同时让拥有者失败。
	{ readonly kind: "check"; readonly error: ChordError } | { readonly kind: "broken"; readonly error: ChordError };

/** SQLite's extended result code `SQLITE_CONSTRAINT_CHECK`, which Node's binding reports as `errcode`. */
const SQLITE_CONSTRAINT_CHECK = 275;

/**
 * The refusal behind `error`, a store commit's rejection; `undefined` when it is the store's own (`released` at
 * admission or after close, `unavailable/storage_failed` once stopped), which the owner rethrows as it is.
 */
// 把 store 的提交拒绝归类给 Chord 对象：范围 CHECK 只影响事务，其余拒绝还使对象 broken。输入可以是任意抛出值；例如 SQLite errcode 275 得到 check。store 自身的关闭/失败错误返回 undefined，交给上层原样传播；本函数不改数据库。
export function refusalOf(error: unknown, label: string): Refusal | undefined {
	// released 以及 unavailable/storage_failed 已由 store 定义语义，不能再包装成一次普通写入拒绝。
	if (isChordError(error, "released") || (isChordError(error, "unavailable") && error.reason === "storage_failed")) {
		// undefined 表示本函数不重新分类，而不是表示提交成功。
		return undefined;
	}
	// error:unknown 必须先收窄才能读取 message；非 Error 的抛出值用 String 转成说明文本。
	const message = error instanceof Error ? error.message : String(error);
	// 依后端给出的扩展码或消息识别 CHECK；该边界处理的是驱动异常，不是已保证类型的本地参数。
	if (isCheck(error, message)) {
		// label 指出发生错误的拥有者/操作，原消息留在括号中便于定位列约束。
		const refused = `${label}: a value is out of its column's range (${message})`;
		return {
			kind: "check",
			// 对外使用 invalid/args；cause 只保存在本机错误链中，不会因此变成线协议字段。
			error: new ChordError({ code: "invalid", reason: "args", message: refused }, { cause: error }),
		};
	}
	// 未知的写入拒绝意味着对象内存所依据的约定可能和磁盘不同；保留原异常作为 cause。
	const refused = `${label}: the store refused the commit (${message})`;
	return { kind: "broken", error: new ChordError({ code: "unavailable", message: refused }, { cause: error }) };
}

/**
 * Whether a refusal is a `CHECK` failure: SQLite's extended code where the binding has one (Node), the message
 * otherwise (the Durable Object facade has no extended codes).
 */
// 读取驱动未知异常的 CHECK 标记并返回布尔值；例如数字码 275 为 true，有数字码却不是 275 时不会再按消息猜测。没有数字码时才匹配 Cloudflare 使用的消息片段，无外部副作用。
function isCheck(error: unknown, message: string): boolean {
	// as 只让 TS 允许尝试读取 errcode；?. 只跳过 null/undefined，不承担完整错误对象校验。
	const code = (error as { readonly errcode?: unknown } | undefined)?.errcode;
	// 驱动边界的数值码优先；typeof 在这里收窄 unknown，为缺少数字扩展码的后端保留下面的路径。
	if (typeof code === "number") return code === SQLITE_CONSTRAINT_CHECK;
	// 兜底仅判断消息是否包含固定片段，不解析约束表达式，也不验证其他错误形状。
	return message.includes("CHECK constraint failed");
}
