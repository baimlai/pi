// Values in messages (§3 values, §22): JSON text, and for payloads marked as carrying bytes raw byte segments, a
// `Uint8Array` leaf written as `{"$bytes": i}` and read back as a view of the received message (no copy, never
// base64); a part as the text codec splices it. Shared by the codecs.

// 文件导读
// 所属模块：packages/chord/src/link 的值编码辅助层，被 binary.ts 与 text.ts 两个 Codec 共用。
// 职责与边界：在 JS 值与 Part 之间转换。负责 JSON 序列化、bytes() 叶子的段拆分/还原、文本元组中的 Part 包装、
// 严格 UTF-8 与 base64；不负责大小上限、压缩、流控或 schema 校验。
// 上游入口：编解码器编码时调用 jsonPart/payloadPart/partText；解码时调用 parsePart/parsePayload/textPart。
// 下游依赖：data/internal.ts 的 invalid（参数错误）与 part.ts 的 DeflatedPart 类。
// 结果与错误流向：序列化错误（如 $bytes 冲突）以 invalid/args 抛给调用方；解析错误（非法 UTF-8、非法 JSON、
// 畸形段引用）抛普通 Error，Channel 将其视为协议错误并关闭链路。
// 能力清单：
// - jsonPart：把 JSON 值序列化为文本，undefined 记为 "null"。
// - payloadPart：序列化参数/返回值，并把 Uint8Array 叶子拆成 segments 与 {"$bytes":i} 引用。
// - parsePart：在 owner 处解析 Part 的 JSON。
// - parsePayload：解析 payload 并还原 segments 引用。
// - partText / textPart：文本编解码器中 Part 的 [codec, payload] 包装与还原。
// - parseJson / readUtf8：严格 UTF-8 解码（非法字节抛错）。
// - resolveSegments：原地把引用替换为接收缓冲区上的字节视图。
// 典型调用顺序：origin 侧 jsonPart/payloadPart -> codec.encode -> 网络 -> codec.decode -> openPart -> parsePayload。
// 示例：payloadPart({ buf: new Uint8Array([1, 2]) }, true) 返回
//       { json: '{"buf":{"$bytes":0}}', segments: [Uint8Array([1,2])] }；
//       parsePayload(json, segments) 再把 buf 还原成 Uint8Array。
// 建议阅读顺序：jsonPart/payloadPart（写入）-> parsePart/parsePayload/resolveSegments（读取）-> partText/textPart（文本包装）
// -> parseJson/readUtf8/base64（底层编解码）。

import { invalid } from "../data/internal.ts";
import { DeflatedPart, type Part } from "./part.ts";

/** Strict, and a leading U+FEFF is data, not a byte order mark to strip. */
// TextDecoder 的运行时选项：fatal 让非法 UTF-8 抛错而不是替换成 U+FFFD；
// ignoreBOM 为 true 表示保留开头的 U+FEFF 字符，不把它当 BOM 吞掉。这样任何非 UTF-8 输入都成为协议错误。
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A JSON part at its origin: the value's JSON text (state and params are JSON only). */
// 把任意 JSON 可表示的值序列化成文本。JSON.stringify(undefined) 返回 undefined，
// 这里用 ?? 统一成 "null"：协议规定缺省/无值在线上表示为 JSON null。
// 注意：此函数不做 schema 检查；调用方负责保证 value 是契约允许的结构。
export function jsonPart(value: unknown): string {
	return JSON.stringify(value) ?? "null";
}

/**
 * A payload part at its origin (arguments, a result): its JSON and, when `bytes` (its method's schema has a `bytes()`
 * leaf), its byte segments: each `Uint8Array` leaf becomes a segment, and an own key `$bytes`, reserved there, fails
 * `invalid/args`; otherwise plain JSON, where `$bytes` is ordinary data. `undefined` (a handler returning nothing) is
 * `null`.
 */
// 生成 payload（方法参数/返回值）的 Part 内容：
// - bytes=false：普通 JSON，segments 为 undefined；
// - bytes=true：方法 schema 含 bytes() 叶子，需要把 Uint8Array 拆成独立段。
// 返回值是普通对象 { json, segments }，不复制字节；segments 中的数组与输入共享底层内存。
// 例子：payloadPart({a:new Uint8Array([1,2])}, true) -> { json:'{"a":{"$bytes":0}}', segments:[Uint8Array(2)] }。
export function payloadPart(
	value: unknown,
	bytes: boolean,
): { readonly json: string; readonly segments: Uint8Array[] | undefined } {
	// 没有字节叶子时走快路径，只序列化一次，不做 replacer 遍历。
	if (!bytes) return { json: jsonPart(value), segments: undefined };
	// 收集遇到的字节段；数组下标就是 JSON 中 $bytes 的值。
	const segments: Uint8Array[] = [];
	// JSON.stringify 的第二个参数是 replacer 函数：每个键值对都会经过它，可返回替换值。
	// 这里的 function 需要自己的 this（持有当前对象的父对象），所以不用箭头函数；
	// `this: Record<string, unknown>` 是 TS 的假 this 参数，只用于类型检查，运行时由 JSON.stringify 提供。
	const json = JSON.stringify(value, function (this: Record<string, unknown>, key: string, leaf: unknown) {
		// 只有对象才可能含 bytes 叶子；原始值和 null 原样返回。
		if (typeof leaf !== "object" || leaf === null) return leaf;
		// The holder's own value: a `Uint8Array` subclass with a `toJSON` (Node's `Buffer`) reaches the replacer as
		// what its `toJSON` made (a Buffer pays that copy: 3.6 ms per MiB; a plain `Uint8Array` none).
		// replacer 拿到的 leaf 可能已被 toJSON 转换（Buffer -> {type:"Buffer",data:[...]}），
		// 所以从父对象 this[key] 取原始值来判断。普通 Uint8Array 没有 toJSON，不产生额外复制。
		const original = this[key];
		if (original instanceof Uint8Array) {
			// 原始字节入段，并在 JSON 中放一个引用；segment 下标从 0 开始。
			segments.push(original);
			return { $bytes: segments.length - 1 };
		}
		// The replacer does not see the markers it returns, only their fields.
		// 防止用户 JSON 自己带 $bytes 键与引用混淆；普通对象里出现即抛 invalid/args（业务参数错误，非协议错误）。
		// 刚生成的标记对象不会被再次遍历，所以这里只检查真实输入对象。
		if (Object.hasOwn(leaf, "$bytes")) throw invalid("args", '"$bytes" is reserved in values crossing a link');
		return leaf;
	});
	// JSON.stringify 对 undefined 仍可能返回 undefined，统一成 "null"。
	return { json: json ?? "null", segments };
}

/**
 * Parses a part's JSON where it is owned, once opened (`openPart`). Throws on a part that is no strict UTF-8 JSON (a
 * protocol error).
 */
// 在 owner 处解析 part 的 JSON：文本直接 JSON.parse，字节先按严格 UTF-8 解码再解析。
// `string | Uint8Array` 是联合类型；typeof 收窄后两个分支的类型都明确。
// 失败会抛 SyntaxError 或 TextDecoder 错误，由 Channel 当作协议错误处理；这里不包装。
export function parsePart(json: string | Uint8Array): unknown {
	return typeof json === "string" ? JSON.parse(json) : parseJson(json);
}

/**
 * Parses a payload part's JSON where it is owned, once opened, its `{"$bytes": i}` references resolved to views of
 * `segments` when it has them. Throws on a malformed part (a protocol error).
 */
// 解析 payload：先得到 JSON 值，若消息带 segments 再把 {"$bytes":i} 替换成对应字节视图。
// 无 segments 时直接返回，避免无意义的树遍历；有 segments 时 resolveSegments 会原地修改新解析出的对象。
export function parsePayload(json: string | Uint8Array, segments: readonly Uint8Array[] | undefined): unknown {
	const value = parsePart(json);
	return segments === undefined ? value : resolveSegments(value, segments);
}

/**
 * A part as the text codec splices it into its tuple, tagged so that no JSON value is reserved: `[0, json]` for a plain
 * part, `[1, base64]` for a deflated one. Throws on invalid UTF-8.
 */
// 把 part 拼进文本 codec 的 JSON 元组：
// - 普通 part 写成 [0, json]，json 必须是合法 JSON 文本（字符串）或能转成严格 UTF-8 的字节；
// - 压缩 part 写成 [1, "base64"]，因为二进制不能直接嵌入 JSON 文本。
// 标签 0/1 保证 Part 与任意用户 JSON 值不会冲突；返回值是可直接拼接的字符串片段。
export function partText(part: Part): string {
	// instanceof 是运行时判断，区分 DeflatedPart 类实例；压缩内容用 base64 安全嵌入。
	if (part instanceof DeflatedPart) return `[1,"${base64(part.bytes)}"]`;
	// 字符串原样放入（JS 模板会做字符串拼接，不额外加引号）；字节先严格解码，非法 UTF-8 会抛错。
	return `[0,${typeof part === "string" ? part : readUtf8(part)}]`;
}

/** A part from its place in a text tuple (`partText` reversed). Throws on anything else (a protocol error). */
// 反向解析文本元组里的 part。输入来自 JSON.parse，所以声明为 unknown。
// 这里是信任边界：形状不对或 codec 未知都抛普通 Error（协议错误），由上层关闭链路。
export function textPart(value: unknown): Part {
	// Trust boundary: fresh JSON from the text decoder.
	// Array.isArray + 长度检查是运行时校验；满足后才允许按二元组解构。
	if (!Array.isArray(value) || value.length !== 2) throw new Error("text: a part is no [codec, payload] pair");
	// 解构后元素仍是 unknown；最后的 as 只是告诉 TS 元组形状，不改变值。
	const [codec, payload] = value as [unknown, unknown];
	// codec 0：payload 是 JSON 文本。这里用 JSON.stringify 规范化为字符串，
	// 因为文本 codec 拼接时 payload 已经是 JSON 片段，解析后可能变成对象/数字等。
	if (codec === 0) return JSON.stringify(payload);
	// codec 1：payload 必须是非空字符串形式的 base64；解码失败由 atob 抛出。
	if (codec === 1 && typeof payload === "string") return new DeflatedPart(fromBase64(payload));
	// 其他 codec 编号或错误载荷类型一律拒绝。
	throw new Error("text: a part of an unknown codec");
}

/** Strict UTF-8 JSON. Throws on anything else (a protocol error). */
// 严格 UTF-8 解码后 JSON.parse；decode 遇到非法字节抛 TypeError，JSON 非法抛 SyntaxError。
// 两者都不在这里吞掉，保持“协议错误向上传播”的统一策略。
export function parseJson(bytes: Uint8Array): unknown {
	return JSON.parse(STRICT_UTF8.decode(bytes));
}

/** Strict UTF-8 text. Throws on invalid UTF-8 (a protocol error). */
// 仅解码为文本，不解析 JSON；供需要原文字符串的 part 使用。
// 共享同一个 TextDecoder 实例是安全的：decode 不保留跨调用状态。
export function readUtf8(bytes: Uint8Array): string {
	return STRICT_UTF8.decode(bytes);
}

/**
 * Replaces every `{"$bytes": i}` in a freshly decoded payload with segment `i`, in place. Throws on a malformed
 * reference (a protocol error).
 */
// 递归把新解析 payload 中的 {"$bytes": i} 引用替换为 segments[i]（接收字节的视图）。
// 输入 value 来自刚刚 JSON.parse 的对象树，归本次解码所有，因此可以原地修改；
// 返回替换后的根值（根节点本身可能就是引用，所以必须使用返回值，不能只依赖副作用）。
export function resolveSegments(value: unknown, segments: readonly Uint8Array[]): unknown {
	// 原始值（字符串/数字/布尔/null）没有可替换的内容，直接返回。
	if (typeof value !== "object" || value === null) return value;
	// Trust boundary: fresh JSON from the link, owned by this decode.
	// 断言成索引签名对象，便于按 key 遍历；数组也是 object，下面用 Array.isArray 区分。
	const node = value as Record<string, unknown>;
	// 引用标记必须是普通对象而不是数组，且自身拥有 $bytes 键（Object.hasOwn 不看原型链）。
	if (!Array.isArray(node) && Object.hasOwn(node, "$bytes")) {
		const index = node.$bytes;
		// 标记必须恰好只有一个键、索引是数字、目标段存在，否则是畸形引用（协议错误）。
		// segments[index] === undefined 同时处理越界和负下标（数组负下标不是 own 属性）。
		if (Object.keys(node).length !== 1 || typeof index !== "number" || segments[index] === undefined) {
			throw new Error("payload: a malformed byte segment reference");
		}
		// 返回字节视图本身，不复制；调用方得到的是接收缓冲区上的 Uint8Array。
		return segments[index];
	}
	// 数组或普通对象都要遍历自有可枚举键；Object.keys 不会包含原型链字段。
	for (const key of Object.keys(node)) {
		const child = node[key];
		const resolved = resolveSegments(child, segments);
		// Defined, not assigned: a key `__proto__` is an own property of parsed JSON.
		// 用 defineProperty 而非 node[key]=...：JSON.parse 生成的 "__proto__" 是自有属性，
		// 直接赋值会走 setter 改原型；defineProperty 保留为普通数据属性。
		// 只有子值确实变化时才写回，降低无谓的属性写入。
		if (resolved !== child)
			Object.defineProperty(node, key, { value: resolved, writable: true, enumerable: true, configurable: true });
	}
	return node;
}

/** Bytes as base64 (the text codec's deflated parts; portable: `btoa` over a binary string, in chunks). */
// 分块把字节转成 base64：String.fromCharCode(...chunk) 用展开参数，块过大会超过引擎参数上限，
// 所以每 0x8000（32768）字节一块。btoa 接受“二进制字符串”，每个字符码 0..255。
// 例：base64(new Uint8Array([104,105])) -> "aGk="。
function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

/** Bytes from base64. Throws on text that is no base64 (a protocol error). */
// atob 对非法 base64 抛 DOMException；Uint8Array.from 的映射回调把每字符码转回字节。
// 第二个参数 (char) => char.charCodeAt(0) 是映射函数，不是类型断言。
function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
