// ChordError: Chord's one error type, its codes and reasons (link protocol) and its wire form; and PluginError, what a
// plugin throws to give its callers a code of its own.

// 文件导读
// 所属包与模块：packages/chord/src/data 的错误模块（layer-1），是 Chord 错误类型与链路错误协议的唯一定义处。
// 职责边界：定义代码/原因表、判别联合的 ChordError、插件自定义错误、构造帮助函数，以及链路错误信封的
// 信任边界校验；不决定何时抛出（调用方决定），不序列化堆栈或 cause 到线上。
// 上游：任何 Chord 层构造/抛出 ChordError；link 解码后把 unknown 交给 chordErrorFromJson。
// 下游：错误经 toJSON 变成线上信封；isChordError 供调用方按 code 收窄；PluginError 由消费者重新抛出。
// 错误流向：chordErrorFromJson 对非法信封抛普通 Error（不是 ChordError），由协议层关闭连接；
// 其他函数只构造或返回错误，不主动抛出。
// 能力清单：
// - PROTOCOL_VERSION（常量）：错误代码/原因表的链路协议版本。
// - CHORD_ERROR_REASONS（常量表）：每个 code 允许的 reason 列表。
// - ChordErrorCode/ChordErrorReason（类型）：从表推导的代码与原因联合。
// - ChordError（类型 + 构造器）：可跨链路的错误，按 code 收窄 reason。
// - isChordError（函数）：类身份与可选 code 的类型谓词。
// - PluginError（类）：插件自定义 code/message/details 的错误。
// - invalid（函数）：构造 invalid/<reason> 的便捷函数。
// - asChordError（函数）：把任意抛出值统一为 ChordError。
// - chordErrorFromJson（函数）：从链路 JSON 信封重建并校验错误。
// 组合关系与典型调用顺序：抛出方 invalid/asChordError -> link 调 toJSON -> 对端 chordErrorFromJson ->
// isChordError 收窄 -> 业务处理。PluginError 由插件抛出，传输层编码，消费者重建。
// 示例（真实签名）：throw invalid("args", "expected an object", { path: "/" });
// const error = chordErrorFromJson(decoded); if (isChordError(error, "invalid")) use(error.reason);
// 建议阅读顺序：先 CHORD_ERROR_REASONS 与两个推导类型，再看 ErrorFields/ChordErrorJson，然后类和 toJSON，
// 接着 isChordError/invalid/asChordError，最后 chordErrorFromJson 与 ENVELOPE_KEYS。

import type { JsonValue } from "../json.ts";

/** Version of the error table below on links; adding or moving a code or reason bumps it. */
// 错误代码/原因属于链路协议；该常量是协议版本，当前值仍为 1，此注释不更改协商规则。
export const PROTOCOL_VERSION = 1;

/** Every code with the reasons it may carry. `invalid` requires a reason; every other code may omit it. */
// 每个 code 对应合法 reason 的只读字面量表；as const 让 TS 保留精确字符串，但不深冻结运行时数组。
export const CHORD_ERROR_REASONS = {
	invalid: ["args", "params", "member", "host_address", "reentrant", "read_after_bulk", "cycle"],
	contract_mismatch: ["updating"],
	forbidden: ["revoked"],
	gone: [],
	not_ready: [],
	// No reason: released by its holder. `ended`: its object ended; `closed`: its host, store or native closed;
	// `settled`: used after the call or run it belonged to settled; `version`: an old handle after a migration;
	// `discarded`: a transaction cut at the seal.
	released: ["ended", "closed", "settled", "version", "discarded"],
	too_large: ["part"],
	// `undeclared`: a registry no plugin serves on this host.
	unavailable: ["locked", "park_timeout", "busy", "storage_failed", "undeclared"],
	aborted: [],
} as const;

// keyof typeof 从上表取所有键组成联合，如 "invalid" | "released"，不创建运行时列表。
export type ChordErrorCode = keyof typeof CHORD_ERROR_REASONS;

// 先按代码 C 索引原因元组，再用 [number] 取元素联合；没有原因的空元组得到 never。
export type ChordErrorReason<C extends ChordErrorCode = ChordErrorCode> = (typeof CHORD_ERROR_REASONS)[C][number];

/** The wire form of a ChordError and its constructor argument: one member per code, so wrong pairings fail to type. */
// 映射类型为每个 code 构造一种字段组合，再索引得到联合，使 invalid 必须带自己的 reason。
type ChordErrorJson = { [C in ChordErrorCode]: ErrorFields<C> }[ChordErrorCode];

// 交叉类型把公共字段和条件 reason 字段合并；[T] extends [never] 用元组避免联合分发。
type ErrorFields<C extends ChordErrorCode> = {
	readonly code: C;
	readonly message: string;
	readonly details?: JsonValue;
} & (C extends "invalid"
	? { readonly reason: ChordErrorReason<C> }
	: [ChordErrorReason<C>] extends [never]
		? { readonly reason?: undefined }
		: { readonly reason?: ChordErrorReason<C> });

// 实际运行的 Error 子类保存错误字段；下面导出的构造签名把这些实例补充为可按 code 收窄的联合。
class ChordErrorClass extends Error {
	readonly code: ChordErrorCode;
	readonly reason: ChordErrorReason | undefined;
	readonly details: JsonValue | undefined;

	// 由结构化 init 创建 Error，保存 message/code/reason/details，可传原生 cause 选项；例如 invalid+args。
	// 不在此验证来自网络的 init，网络入口必须先走 chordErrorFromJson；只创建对象，没有 I/O。
	constructor(init: ChordErrorJson, options?: ErrorOptions) {
		// 调用 Error 构造器建立 message/可选 cause 和堆栈。
		super(init.message, options);
		// 将错误名称改成 ChordError，方便本地显示；网络只发送 toJSON 的字段。
		this.name = "ChordError";
		// 保留代码，后续可用 code 判别具体错误组合。
		this.code = init.code;
		// 保留可选原因，省略时就是 undefined。
		this.reason = init.reason;
		// 保留 JSON 详情原引用，不递归复制或验证。
		this.details = init.details;
	}

	/** The wire form; stack and cause never cross a link. */
	// 提取可跨链路的字段，返回普通对象而非 Error；例如无 reason/details 就省略这两个键。
	// 无 I/O，不包含 stack/cause；解构不会深复制 details。
	toJSON(): ChordErrorJson {
		// 一次读取本地错误的四个公开数据字段。
		const { code, reason, message, details } = this;
		// The fields were copied from a ChordErrorJson, so the pairing holds.
		// 组装新的错误信封；末尾断言复用构造时已建立的代码/原因对应关系。
		return {
			code,
			// 对象展开只在 reason 有值时加入该键，使 JSON 外形不携带 undefined。
			...(reason === undefined ? {} : { reason }),
			message,
			// details 同样按是否为 undefined 决定是否加入，null 仍会保留。
			...(details === undefined ? {} : { details }),
		} as ChordErrorJson;
	}
}

/** A Chord failure. Narrowing on `code` narrows `reason`. */
// 实例类型与字段判别联合相交：保留 Error 方法，也能在 if(code===...) 后收窄 reason。
export type ChordError = ChordErrorClass & ChordErrorJson;

/**
 * Creates a ChordError: `new ChordError({ code: "invalid", reason: "args", message })`. A class cannot declare its
 * instances as a tagged union; this constructor signature does.
 */
// 把运行时同一个类暴露成带判别联合的 new 签名；as 不会生成另一类或增加校验。
export const ChordError = ChordErrorClass as new (init: ChordErrorJson, options?: ErrorOptions) => ChordError;

/** Whether `error` is a ChordError, optionally with the given code. */
// 判断任意抛出值是否为此 ChordError 类，并可选匹配 code；返回类型谓词供 TS 收窄。
// 例如 isChordError(e,"invalid") 成功后可读 invalid 的 reason；不解析普通 JSON 错误信封，也不修改输入。
export function isChordError<C extends ChordErrorCode = ChordErrorCode>(
	error: unknown,
	code?: C,
): error is Extract<ChordError, { readonly code: C }> {
	// 先验类身份，且传了 code 才要求相等；instanceof 适用于 unknown 错误边界。
	return error instanceof ChordError && (code === undefined || error.code === code);
}

/**
 * An error a plugin throws for its callers: its own `code`, a message and JSON `details`. Only these cross a link
 * (never a stack or a cause); a consumer rethrows it as a PluginError.
 */
// 插件自定义错误保存任意字符串 code 与可选 JSON details，区别于 Chord 固定代码表。
export class PluginError extends Error {
	readonly code: string;
	readonly details: JsonValue | undefined;

	// 创建插件错误，输入 code/message/可选详情，返回实例；例如 new PluginError("quota","full")。
	// 只保存字段，不做网络发送，也不检查 code 是否属于某插件命名规范。
	constructor(code: string, message: string, details?: JsonValue) {
		// 原生 Error 保存 message 和本地堆栈。
		super(message);
		// 设置可读的本地错误类名称。
		this.name = "PluginError";
		// 保存插件自定代码，传输层决定如何编码插件错误。
		this.code = code;
		// 按原引用保存可选 JSON 数据，无深拷贝。
		this.details = details;
	}
}

/** An `invalid` error with the given reason. */
// 便捷创建 invalid 错误，输入合法 reason/文字/可选详情，返回静态类型已收窄的 ChordError。
// 例如 invalid("params","missing id")；此函数创建并返回错误而不直接 throw，调用者决定是否抛出。
export function invalid(
	reason: ChordErrorReason<"invalid">,
	message: string,
	details?: JsonValue,
): Extract<ChordError, { readonly code: "invalid" }> {
	// The constructor's return type cannot narrow on its argument.
	// 构造器类型无法按实参收窄返回类实例，这里的断言只向 TS 说明固定代码确为 invalid。
	return new ChordError({ code: "invalid", reason, message, details }) as Extract<ChordError, { code: "invalid" }>;
}

/** `error` itself when it is a ChordError, otherwise an `unavailable` error naming `label`, with `error` as cause. */
// 将任意错误统一成 ChordError：已有的直接返回，其余包成 unavailable 并保留 cause。
// 例如 Error("disk") 配 label="open" 得消息 "open: disk"；不抛出所创建的错误，无 I/O。
export function asChordError(error: unknown, label: string): ChordError {
	// 保留原 ChordError 的代码、原因、对象身份，不重复包装。
	if (isChordError(error)) return error;
	// unknown 可能是字符串等任意抛出值；原生 Error 取 message，其余调用 String。
	const message = error instanceof Error ? error.message : String(error);
	// 为外来错误补标签并存本地 cause，toJSON 不会把 cause 发送出去。
	return new ChordError({ code: "unavailable", message: `${label}: ${message}` }, { cause: error });
}

/**
 * Rebuilds a ChordError from a link. Checks the envelope only: a known code, a reason allowed for it (required for
 * `invalid`), a string message, no other keys. `details` is kept by reference.
 */
// 从已解码的 unknown 信封重建错误，检查对象/自有键/代码/原因/文字，失败抛普通 Error。
// 例如 {code:"invalid",reason:"args",message:"bad"} 可重建，缺 reason 则拒绝；details 原引用保留。
// 这是链路输入信任边界，不能用 TypeScript 类型替代检查；不递归校验 details 或进行 I/O。
export function chordErrorFromJson(raw: unknown): ChordError {
	// Trust boundary: `raw` is fresh JSON from the link decoder.
	// 拒绝 null、数组和非对象，先建立可读取信封字段的基本外形。
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw envelopeError("not an object");
	// 把经过对象外形检查的值视作 unknown 字段表，字段内容仍需下方逐项校验。
	const json = raw as Record<string, unknown>;
	// 枚举收到的可枚举自有键，未知键立即拒绝，不静默忽略扩展字段。
	for (const key of Object.keys(json)) if (!ENVELOPE_KEYS.has(key)) throw envelopeError(`unknown key "${key}"`);
	// 读取三个协议字段；details 故意不遍历，仅透传引用。
	const { code, reason, message } = json;
	// 代码必须为字符串且确为表的自有键，避免把对象原型名字当合法代码。
	if (typeof code !== "string" || !Object.hasOwn(CHORD_ERROR_REASONS, code)) throw envelopeError("unknown code");
	// 代码已检查后才能按代码安全取得合法原因列表；断言只补 TS 对跨字段事实的认识。
	const reasons: readonly string[] = CHORD_ERROR_REASONS[code as ChordErrorCode];
	// invalid 缺原因则拒绝；其他代码可省略原因，提供时必须在该代码列表内。
	if (reason === undefined ? code === "invalid" : !reasons.includes(reason as string)) {
		// 向解码方返回信封格式错误，后续链路层可据此关闭协议连接。
		throw envelopeError(`reason not allowed for ${code}`);
	}
	// 消息必须是字符串；不把其他值自动转换成文字。
	if (typeof message !== "string") throw envelopeError("message is not a string");
	// The checks above establish the pairing.
	// 通过上述边界检查后重建实例，不复制 details，断言不会执行额外遍历。
	return new ChordError(json as ChordErrorJson);
}

// 信封只接受这四个可枚举字段；stack 和 cause 不属于线上错误格式。
const ENVELOPE_KEYS = new Set(["code", "reason", "message", "details"]);

// 将信封问题组合成普通 Error 返回；例如 unknown code 得固定前缀，调用者负责抛出，无 I/O。
function envelopeError(problem: string): Error {
	// 只构造错误，避免把不可信的完整错误对象或堆栈拼进文字。
	return new Error(`Invalid ChordError JSON: ${problem}`);
}
