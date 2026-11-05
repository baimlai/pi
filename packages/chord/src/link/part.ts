// Parts on links (R1, R2, Q2, §22): a value as it crosses a link (JSON text at its origin, its bytes once received, or
// deflated by its origin), the size limits per part, compression at the origin, and opening a part where it is owned:
// its size checked before anything is parsed or inflated, a deflated part inflated within the decoded limit.

// 文件导读
// 所属模块：packages/chord/src/link 的载荷（Part）模型与大小/压缩策略。
// 职责与边界：定义跨链路的三种 Part 形态、每 part 的线上与解压后上限、origin 端压缩、owner 端打开与解压。
// 不解析 JSON（那是 values.ts 的事），不做流控窗口与消息 schema 检查。
// 上游入口：values.ts 生成 JSON 文本或字节后作为 Part 传入；host 配置 compression 时由 originPart 决定是否压缩；
// 编解码器把 Part 原样写入线格式。
// 下游依赖：Context 的遥测计数；data/index.ts 的 ChordError；Web 的 DecompressionStream（异步解压路径）。
// 结果与错误流向：originPart 返回 string/Uint8Array/DeflatedPart；openPart 返回可解析的文本或字节；
// 超过上限抛 ChordError(too_large/part)，没有解压能力或 deflate 数据损坏抛普通 Error（协议错误）。
// 能力清单：
// - Part：JSON 文本、UTF-8 字节或压缩包的联合类型。
// - Inflated：异步/同步解压的三种结果（bytes/too_large/corrupt）。
// - DeflatedPart：压缩 Part 的运行时包装类，可缓存异步解压结果。
// - Compression：同步 deflate/inflate 接口，由 host 注入。
// - PartLimits / Limits：调用方设置的上限与生效后的上限。
// - linkLimits：按链路信任级别合并默认值（不可信 16 MiB/64 MiB，可信无限）。
// - COMPRESS_ABOVE：origin 压缩阈值（16 KiB）。
// - originPart：在 origin 决定文本、字节或压缩形态。
// - oversized：只检查线上大小。
// - openPart：owner 端按先线上、后解码的顺序检查并解压。
// - inflateAsync：用 DecompressionStream 提前异步解压，结果写回 DeflatedPart。
// 典型调用顺序：originPart -> codec.encode -> codec.decode -> (可选 inflateAsync) -> openPart -> parsePart。
// 示例：const part = originPart('{"a":1}', compression, context);
//       const closed = openPart(part, linkLimits(false), compression, context); // 得到可 JSON.parse 的文本/字节
//       若 part 是超大输入，openPart 抛 new ChordError({ code: "too_large", reason: "part", ... })。
// 建议阅读顺序：Part/Inflated/DeflatedPart 类型 -> Limits/linkLimits -> originPart -> oversized/openPart -> inflateAsync -> sizeOf。

import type { Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";

/**
 * A part (R1): a value as JSON text at its origin (and after a text decode), its UTF-8 bytes once a binary codec
 * received it (or at an origin that encoded it already), or those bytes deflated by an origin that compresses. Opaque
 * on the way: only the end that owns it opens and parses it, while handling its message (a malformed part is a protocol
 * error then), so a relay forwards it unparsed and still deflated.
 */
// Part 是三类值的联合：字符串（origin 的 JSON 文本或文本解码结果）、字节（二进制接收结果/已编码文本）、
// 或 DeflatedPart（origin 压缩后的对象）。中继只搬运不解析，因此压缩状态能保留到最终 owner。
export type Part = string | Uint8Array | DeflatedPart;

/** What inflating a deflated part gave: its JSON bytes, more than the decoded limit, or data that is no raw deflate. */
// 解压结果用可辨识联合表达三种结局，kind 是字面量标签：
// - bytes：成功，附带解压后的 JSON 字节；
// - too_large：输出超过 decoded 上限（只有该标签，无需错误对象）；
// - corrupt：不是合法 raw deflate 流，附带底层错误。
// 消费方 switch(kind) 后 TS 会自动收窄；运行时只是普通对象字段。
export type Inflated =
	| { readonly kind: "bytes"; readonly bytes: Uint8Array }
	| { readonly kind: "too_large" }
	| { readonly kind: "corrupt"; readonly error: unknown };

/**
 * A JSON part deflated (raw deflate) by its origin. A host without a synchronous compressor inflates it before its
 * owner handles the message (`inflateAsync`) and keeps the outcome here for the owner to open.
 */
// 压缩 part 的运行时载体：用类实例而不是普通对象，便于 instanceof 与未压缩的 Uint8Array 区分。
// 实例只保存压缩字节和可选的预解压结果，不持有压缩器/上下文。
export class DeflatedPart {
	// 压缩后的原始字节（raw deflate）；readonly 只是编译期限制，运行时可写但不复制。
	readonly bytes: Uint8Array;
	/** The asynchronous inflate's outcome; `undefined` until one ran. */
	// 异步解压（没有同步压缩器的 host）提前算出的结果；undefined 表示还没解压，
	// openPart 时可能改用同步 compression 或干脆报错。字段公开可写，因为 inflateAsync 与 openPart 在不同阶段写/读。
	inflated: Inflated | undefined;

	// 构造只保存字节引用；不做拷贝、不校验是否为合法 deflate，也不触发解压。
	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
	}
}

/**
 * A synchronous compressor (`createHost({ compression })`; `nodeCompression` for Node). `deflate` is raw deflate at
 * level 1. `inflate` gives at most `limit` bytes (`Infinity`: no limit; 0 allowed), `too_large` when the output would
 * be larger, `corrupt` for data that is no raw deflate stream.
 */
// 同步压缩器接口，由 host 配置注入（Node 提供 nodeCompression）。两个方法都可能抛错：
// deflate 的输出应小于输入才有收益；inflate 必须遵守 limit，不能先无限解压再检查。
// 这是普通 interface，运行时不会验证传入对象的方法形状，调用错误会在使用处暴露。
export interface Compression {
	deflate(bytes: Uint8Array): Uint8Array;
	inflate(bytes: Uint8Array, limit: number): Inflated;
}

/** A link's limits per part as `accept`, `connect` and `resolve` take them, in bytes. */
// 用户/调用方传入的“可缺省”上限：两个字段都可省略，缺省值由 linkLimits 按信任级别补。
// 单位是字节；readonly 只约束 TS 侧，不冻结运行时对象。
export type PartLimits = {
	/** A part's size on the wire. */
	readonly part?: number;
	/** A part's size after inflating it. */
	readonly decoded?: number;
};

/** A link's limits in force; `Infinity` for none. */
// 生效后的上限：两个字段都必然存在。用 Infinity 表示“无限”，这样检查逻辑无需额外可选分支。
export type Limits = { readonly part: number; readonly decoded: number };

const MiB = 1024 * 1024;

/** The limits of untrusted links unless set (Q2); trusted links (IPC) have none. */
// 不可信链路默认：线上 16 MiB、解压后 64 MiB。4:1 的比例允许合理压缩，同时限制解压炸弹。
const UNTRUSTED: Limits = { part: 16 * MiB, decoded: 64 * MiB };

// 可信链路（IPC）默认无限制。Number.POSITIVE_INFINITY 与 number 比较永远为 false（除非同为 Infinity），
// 因此下面的 size > limit 检查自然通过。
const NONE: Limits = { part: Number.POSITIVE_INFINITY, decoded: Number.POSITIVE_INFINITY };

/** The limits of a link: the ones set, the defaults of its trust for the others. */
// 合并调用方设置与信任级别默认值：显式值优先，否则用默认。
// `limits: PartLimits = {}` 是默认参数，调用时可省略；?? 只对 undefined/null 生效，
// 所以显式传 0 会被保留（0 表示只允许空 part，而不会被当成“未设置”）。
// 例：linkLimits(false, { part: 1024 }) -> { part: 1024, decoded: 64 MiB }。
export function linkLimits(trusted: boolean, limits: PartLimits = {}): Limits {
	const defaults = trusted ? NONE : UNTRUSTED;
	return { part: limits.part ?? defaults.part, decoded: limits.decoded ?? defaults.decoded };
}

/** JSON parts above this many UTF-8 bytes are compressed at their origin (a protocol constant). */
// 压缩阈值：超过 16 KiB UTF-8 字节才考虑 deflate。小载荷压缩后可能更大，且浪费 CPU。
// 这是协议常量，编解码两端和测试都依赖同一数值。
export const COMPRESS_ABOVE = 16 * 1024;

// 共享 TextEncoder；encode 无跨调用状态，可安全复用。
const UTF8 = new TextEncoder();

/**
 * A JSON part at its origin: deflated when the host compresses, its UTF-8 bytes are above `COMPRESS_ABOVE` and
 * deflating made it smaller; otherwise the text, or its bytes once they were encoded (never encoded twice). Counts one
 * deflate (`chord.link.deflates`).
 */
// 在 origin 生成最终 Part：
// - 没有压缩器：直接返回 JSON 文本；
// - 文本可能很短（UTF-16 长度 ×3 仍不超过阈值）：不编码，直接返回文本，省一次 UTF-8 转换；
// - 编码后超过阈值：尝试 deflate，只有压缩更小才用 DeflatedPart，否则返回原字节。
// 计数只在真正调用 deflate 时增加；返回类型是 Part 联合，调用方无需区分具体分支。
export function originPart(json: string, compression: Compression | undefined, context: Context): Part {
	// A UTF-16 unit is at most three UTF-8 bytes: a text this short is within the threshold without encoding it.
	// 一个 UTF-16 码元最多编码成 3 个 UTF-8 字节，因此 length*3 是 UTF-8 字节数的上界；
	// 上界都不超过阈值时无需 encode，直接返回文本。
	if (compression === undefined || json.length * 3 <= COMPRESS_ABOVE) return json;
	// 真正编码后再用精确字节数判断，避免把接近阈值的文本误压缩。
	const bytes = UTF8.encode(json);
	if (bytes.byteLength <= COMPRESS_ABOVE) return bytes;
	// 只有进入 deflate 才计一次压缩；没有 metrics 的遥测实现用 ?. 跳过。
	context.telemetry.metrics?.counter("chord.link.deflates").add(1);
	const deflated = compression.deflate(bytes);
	// 压缩后必须严格更小才值得传输；否则保留原始字节（不是文本），后续仍按普通 Part 处理。
	return deflated.byteLength < bytes.byteLength ? new DeflatedPart(deflated) : bytes;
}

/**
 * The `too_large/part` error of a part whose size on the wire (its UTF-8 bytes; a deflated part's deflated bytes) is
 * above `limit`; `undefined` within it. Nothing is parsed or inflated.
 */
// 检查 part 的线上大小：无限上限直接通过；否则用 sizeOf 计算（字符串按 UTF-8 字节数，不真正编码），
// 超过就返回 ChordError（code=too_large, reason=part），未超过返回 undefined。
// 返回错误对象而不是抛异常，便于调用方决定如何处理；openPart 会立即抛出它。
export function oversized(part: Part, limit: number): ChordError | undefined {
	if (limit === Number.POSITIVE_INFINITY) return undefined;
	const size = sizeOf(part);
	// 严格大于才超限；等于上限是允许的。
	return size > limit ? tooLarge(size, limit, "wire") : undefined;
}

/**
 * The JSON of a part its owner is about to parse: its size checked against `limits.part` first, then its decoded size
 * against `limits.decoded`, a deflated part inflated within it (synchronously with `compression`, or by the
 * asynchronous inflate that ran ahead of its owner). Throws `too_large/part` past a limit; throws a plain error for a
 * deflated part nothing inflated or that is no raw deflate stream (a protocol error). Counts one synchronous inflate
 * (`chord.link.inflates`).
 */
// owner 端打开 Part，返回可解析的 JSON 文本或字节。顺序很重要：
// 1) 先查线上大小（压缩字节也算线上大小），防止在解压前就消耗内存；
// 2) 未压缩 part 的解码大小等于自身大小，再查 decoded 上限；
// 3) 压缩 part 优先使用 inflateAsync 的结果，否则用同步 compression 解压，并检查三种结局。
// 错误：超过上限抛 ChordError(too_large/part)；没有解压能力或数据损坏抛普通 Error（协议错误）。
export function openPart(
	part: Part,
	limits: Limits,
	compression: Compression | undefined,
	context: Context,
): string | Uint8Array {
	const wire = oversized(part, limits.part);
	// 线上大小已超限时直接抛，后面的解码/解压都不会发生。
	if (wire !== undefined) throw wire;
	if (!(part instanceof DeflatedPart)) {
		// Not deflated: its decoded size is its size.
		// 未压缩时“解码后大小”就是自身大小；无限上限时跳过计算以省一次 UTF-8 扫描。
		const size = limits.decoded === Number.POSITIVE_INFINITY ? 0 : sizeOf(part);
		if (size > limits.decoded) throw tooLarge(size, limits.decoded, "decoded");
		return part;
	}
	// 异步预解压可能已经完成；先读取，避免重复解压。
	let inflated = part.inflated;
	if (inflated === undefined) {
		// 没有预解压且 host 没有同步压缩器：无法安全打开，按协议错误处理。
		if (compression === undefined) throw new Error("part: a deflated part this host did not inflate");
		// 只有真正调用同步 inflate 才计数。
		context.telemetry.metrics?.counter("chord.link.inflates").add(1);
		// 传入 decoded 上限，压缩器应在超限时返回 too_large 而不是无限解压。
		inflated = compression.inflate(part.bytes, limits.decoded);
	}
	// switch 对可辨识联合收窄：每个 case 里 inflated 的类型只剩对应分支。
	switch (inflated.kind) {
		case "bytes":
			return inflated.bytes;
		case "too_large":
			// 此时没有具体 size（解压中途停止），错误信息写成“a part”。
			throw tooLarge(undefined, limits.decoded, "decoded");
		case "corrupt":
			// 用 { cause } 保留底层错误，消息本身说明不是 raw deflate 流。
			throw new Error("part: no raw deflate stream", { cause: inflated.error });
	}
}

/**
 * Inflates `part` with the web `DecompressionStream` (a host without a synchronous compressor), counting output bytes
 * and stopping past `limit`; the outcome is kept on the part. `signal` (the link's close) cancels the stream at once,
 * leaving no outcome. Counts one inflate (`chord.link.inflates`).
 */
// 用浏览器/Node 的 DecompressionStream 异步解压 raw deflate，并把结果写回 part.inflated。
// 这是“host 没有同步压缩器”时的提前解压路径：Channel 在交付消息前等待它，owner 打开时直接读结果。
// signal 是链路关闭信号：一旦 abort，立即取消读取并返回，不写任何结果。
// 计数一次 inflate；不向调用方抛错，所有失败都记录在 part.inflated 的联合结果中。
export async function inflateAsync(
	part: DeflatedPart,
	limit: number,
	signal: AbortSignal,
	context: Context,
): Promise<void> {
	// 每次开始异步解压计一次；与同步路径共用同一个指标。
	context.telemetry.metrics?.counter("chord.link.inflates").add(1);
	// Blob 把字节包装成流；as Uint8Array<ArrayBuffer> 是类型断言，因为 BlobPart 不接受可能基于 SharedArrayBuffer 的视图。
	// pipeThrough 串接解压流，getReader 得到逐块读取句柄；整个链路是惰性的，read 才真正工作。
	const reader = new Blob([part.bytes as Uint8Array<ArrayBuffer>])
		.stream()
		.pipeThrough(new DecompressionStream("deflate-raw"))
		.getReader();
	// A pending read settles once cancelled: nothing of the stream outlives the link.
	// abort 时取消 reader；catch(() => {}) 吞掉取消引发的拒绝，避免未处理 Promise。
	// void 表示不等待结果，取消本身是尽力而为。
	const cancel = (): void => void reader.cancel().catch(() => {});
	// once:true 使监听器触发后自动移除；即使正常完成，finally 也会移除它。
	signal.addEventListener("abort", cancel, { once: true });
	// 先收集块，最后一次性合并，避免每次拼接都复制整个前缀。
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		// 无限循环直到流结束、取消或超限；for(;;) 在这里比 while(true) 更明确“由内部 break 退出”。
		for (;;) {
			// read 返回 { done, value }；done 为 true 时 value 无意义。
			const { done, value } = await reader.read();
			// 流结束或链路已关闭：停止读取。关闭后不再写结果，下面统一 return。
			if (done || signal.aborted) break;
			length += value.byteLength;
			// 超过 decoded 上限立即停止：取消流、记录 too_large、不保留已读块。
			if (length > limit) {
				cancel();
				part.inflated = { kind: "too_large" };
				return;
			}
			chunks.push(value);
		}
	} catch (error) {
		// 解压数据损坏会在这里抛错；若是链路关闭引起的取消，则不记为 corrupt。
		if (!signal.aborted) part.inflated = { kind: "corrupt", error };
		return;
	} finally {
		// 无论成功、失败还是提前 return，都解除 abort 监听，避免 signal 长期持有闭包。
		signal.removeEventListener("abort", cancel);
	}
	// 链路在读完最后一块后、合并前关闭：丢弃结果，不写 inflated。
	if (signal.aborted) return;
	// 预分配精确总长度，再逐块复制，避免数组增长和二次复制。
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	// 只有完整成功才写 bytes 结果；openPart 之后会直接返回它。
	part.inflated = { kind: "bytes", bytes };
}

/** A part's size on the wire: its UTF-8 bytes (counted for text, without encoding it). */
// 计算 Part 的线上字节数：
// - 字节/压缩 part 直接取 byteLength；
// - 字符串按 UTF-8 规则逐码元累加，不实际分配编码结果。
// 这样超大字符串不会为了检查而先编码出一份大缓冲区。
function sizeOf(part: Part): number {
	if (typeof part !== "string") return part instanceof DeflatedPart ? part.bytes.byteLength : part.byteLength;
	// 初始值按 UTF-16 长度计，ASCII 字符恰好 1 字节；非 ASCII 再补差额。
	let size = part.length;
	for (let index = 0; index < part.length; index++) {
		const unit = part.charCodeAt(index);
		// 1 字节 ASCII：已按 1 计过，继续。
		if (unit < 0x80) continue;
		// 2 字节 UTF-8：比 UTF-16 的 1 个码元多 1。
		if (unit < 0x800) size += 1;
		// 代理对：高代理 0xD800..0xDBFF，后随低代理 0xDC00..0xDFFF。位掩码 & 0xfc00 取高 6 位判断范围。
		// 一个代理对（2 个码元）编码为 4 字节，原已计 2，故再 +2，并跳过低代理。
		else if (unit >= 0xd800 && unit < 0xdc00 && (part.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
			// A surrogate pair: four bytes for two units.
			size += 2;
			index++;
			// 其余 3 字节字符（含孤立代理）：原已计 1，再 +2。
		} else size += 2;
	}
	return size;
}

/** The error of a part past a limit (`size` unknown while inflating). */
// 构造统一的大小超限错误。size 可能未知（解压中途超限），此时消息只写 "a part"；
// measure 区分是线上大小还是解压后大小。返回 ChordError 而不是抛出，由调用方决定时机。
function tooLarge(size: number | undefined, limit: number, measure: "wire" | "decoded"): ChordError {
	const what = size === undefined ? "a part" : `a part of ${size} bytes`;
	const message = `${what} is over the ${measure} limit of ${limit} bytes`;
	return new ChordError({ code: "too_large", reason: "part", message });
}
