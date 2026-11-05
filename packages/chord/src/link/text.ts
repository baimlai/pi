// The text codec (2b): one JSON tuple per message, Delta style (a short kind tag, positional fields, no field names),
// and `describeMessage`, which prints any message in that form. A part's JSON text is spliced into the tuple as it is;
// decoding parses the tuple and writes each part back as text (one parse per part per hop: a debugging codec). Byte
// segments of a payload marked as carrying bytes follow the tuple after a newline (JSON text never contains a raw
// one), their lengths the tuple's last field. A message with an origin is wrapped: `["@", origin, tuple]`. Every part
// is tagged with its codec, so no JSON value is reserved: `[0, json]`, or `[1, base64]` for a part its origin deflated
// (the text codec itself never compresses).

// 文件导读
// 所属模块：packages/chord/src/link 的文本 Codec 实现，定位是调试/可读性优先（比二进制多一次 JSON 解析）。
// 职责与边界：把 Message 编成一行 JSON 元组，再解码回来；负责标签与参数个数检查、Part 包装、字节段拼接。
// 不压缩、不做 schema 范围校验、不解析 Part 内部值。
// 上游入口：Channel 的 send 调 textCodec.encode；收到帧后调 textCodec.decode，再调 checkMessage。
// 下游依赖：message.ts 的类型/常量、part.ts 的 Part、values.ts 的 partText/textPart/parseJson。
// 结果与错误流向：encode 返回 UTF-8 字节（无段时就是纯 JSON）；decode 返回 Message，遇到非元组、未知标签、
// 参数个数错误、畸形段长度时抛普通 Error，Channel 视为协议错误并关闭链路。
// 能力清单：
// - textCodec：公开 Codec 对象，name 为 "text"，实现 encode/decode。
// - describeMessage：把任意 Message 打印成同样的元组文本，供日志和测试使用。
// - ownTuple：每种消息的短标签与位置字段布局。
// - boundEntry/stateEntry/failedField/withPayload：复合条目的拼接辅助。
// - fromTuple/fromFields：元组还原消息，检查标签、arity、列表与段。
// - payload：payload 字段与字节段的还原。
// - list/pairs/failures：运行时形状检查辅助。
// 其中 textCodec 与 describeMessage 对外导出；其余均为内部辅助函数。
// 格式：["短标签", 位置参数...]；有 origin 时包成 ["@", origin, tuple]；
// payload 的字节段放在元组后的换行之后，元组最后字段记录各段长度；Part 写成 [0, json] 或 [1, base64]。
// 典型调用顺序：encode -> tuple -> ownTuple -> partText/withPayload -> UTF8.encode -> 拼接换行与段；
// decode -> parseJson -> fromTuple -> fromFields -> payload（随后由 Channel 调 checkMessage）。
// 示例：textCodec.decode(new TextEncoder().encode('["R",300]')) 返回 { kind: "release", hold: 300 }；
//       describeMessage({ kind: "ping" }) 返回 '["p"]'。
// 建议阅读顺序：textCodec 的 encode/decode -> tuple/ownTuple 的标签表 -> boundEntry/stateEntry/withPayload
// -> fromTuple/fromFields -> payload/list/pairs/failures。

import {
	type BoundEntry,
	CAUSE_KINDS,
	type Codec,
	type FailedMember,
	type Message,
	NO_RETIRED,
	type StateEntry,
} from "./message.ts";
import type { Part } from "./part.ts";
import { parseJson, partText, textPart } from "./values.ts";

// 文本编码器：元组字符串 -> UTF-8 字节。
const UTF8 = new TextEncoder();

/** Messages as JSON tuples: readable on the wire, for debugging links. */
// 文本 Codec 实现。encode 先得到 JSON 文本，再把字节段拼到换行之后；
// decode 按第一个换行切成“元组 JSON”和“字节段”两部分。
export const textCodec: Codec = {
	name: "text",
	encode(message) {
		// tuple 返回完整 JSON 文本（含 origin 包装与 part 拼接），这里统一编码成 UTF-8。
		const json = UTF8.encode(tuple(message));
		// 只有 call/result 可能带 segments；其他消息忽略该字段（类型上也只有它们有）。
		const segments = segmentsOf(message);
		if (segments === undefined) return json;
		// 预计算总长度：JSON + 1 个换行 + 所有段字节，一次分配。
		let length = json.byteLength + 1;
		for (const segment of segments) length += segment.byteLength;
		const bytes = new Uint8Array(length);
		bytes.set(json, 0);
		// 换行是元组与二进制段的分界；JSON 字符串中的换行会被转义，因此不会混淆。
		bytes[json.byteLength] = NEWLINE;
		let offset = json.byteLength + 1;
		for (const segment of segments) {
			bytes.set(segment, offset);
			offset += segment.byteLength;
		}
		return bytes;
	},
	decode(bytes) {
		// indexOf 找第一个换行；-1 表示没有段。
		const newline = bytes.indexOf(NEWLINE);
		const json = newline === -1 ? bytes : bytes.subarray(0, newline);
		// 没有换行时用空视图（同一缓冲区末尾），避免额外分配。
		const rest = newline === -1 ? bytes.subarray(bytes.byteLength) : bytes.subarray(newline + 1);
		// parseJson 做严格 UTF-8 + JSON 解析；结果 unknown。
		const fields = parseJson(json);
		// 顶层必须是数组元组；Array.isArray 同时收窄类型。
		if (!Array.isArray(fields)) throw new Error("text: a message is a tuple");
		return fromTuple(fields, rest);
	},
};

/** A message in the text codec's tuple form, for logs and tests (byte segments show as `{"$bytes": i}`). */
// 调试辅助：返回消息的文本元组形式（不编码成字节）。字节段在 JSON 中以 {"$bytes":i} 出现。
export function describeMessage(message: Message): string {
	return tuple(message);
}

// 换行字节（LF）；作为 JSON 与二进制段的分隔符。
const NEWLINE = 0x0a;

/** The segments following a payload's tuple; `undefined` without a payload marked as carrying bytes. */
// 只有 call（args）和 result（value）的 schema 带 segments 字段。
// 用 kind 判断收窄联合类型；其他分支返回 undefined，encode 因此走纯 JSON 路径。
function segmentsOf(message: Message): readonly Uint8Array[] | undefined {
	return message.kind === "call" || message.kind === "result" ? message.segments : undefined;
}

/** The tuple's JSON text, parts spliced in; wrapped with its origin when it has one. */
// 生成消息的最终 JSON 文本：有 origin 时包成 ["@",origin,tuple]，否则直接用自身元组。
// `"origin" in message` 是运行时存在性检查（联合中部分 kind 没有该字段）。
function tuple(message: Message): string {
	const origin = "origin" in message ? message.origin : undefined;
	return origin === undefined ? ownTuple(message) : `["@",${origin},${ownTuple(message)}]`;
}

/** The tuple of a message's own fields. */
// 每种消息一个短标签，字段按位置排列（无字段名），以减小体积并便于肉眼阅读。
// 标签表：h=hello, H=hold, R=release, c=call, x=abort, b=bound, s=state, f=failed,
// r=result, e=error, g=gone, V=revoke, T=retry, l=loading, a=ack, C=closed, p=ping, P=pong。
// 除 hold/bound/state/payload 这些需要拼接 Part 的情况外，其余都直接用 JSON.stringify。
function ownTuple(message: Message): string {
	switch (message.kind) {
		case "hello":
			// ["h", protocol, incarnation, calls]
			return json(["h", message.protocol, message.incarnation, message.calls]);
		case "hold": {
			// hold 必须先拼接 params 的 JSON 文本，不能整体 stringify（Part 是预编码片段）。
			const { address, principal, incarnation, chain, limit } = message;
			// 先序列化前五个字段，再 slice(0,-1) 去掉结尾的 "]"，
			// 以便在关闭括号前继续拼接 params 和 address。
			const head = json(["H", message.hold, message.type, message.version, message.fingerprint]).slice(0, -1);
			// Optional trailing fields: an absent one in the middle is null, absent ones at the end are left out.
			// 可选字段用 null 占位；连续位于末尾的 null 被 pop 掉，使常见的“全缺省”保持短元组。
			// ?? 把 undefined 转成 null，以便与“显式 null”统一处理。
			const optional = [principal ?? null, incarnation ?? null, chain ?? null, limit ?? null];
			// at(-1) 取最后一个元素（ES2022）；末尾为 null 时不断弹出。
			while (optional.length > 0 && optional.at(-1) === null) optional.pop();
			// 每个剩余可选字段前加逗号再序列化；join("") 拼成一个字符串。
			const rest = optional.map((field) => `,${json(field)}`).join("");
			// params 用 partText 拼接（带 [0/1,...] 包装），address 作为二元组 JSON。
			return `${head},${partText(message.params)},${json([address.kind, address.params])}${rest}]`;
		}
		case "release":
			return json(["R", message.hold]);
		case "call":
			// withPayload 负责拼接可缺省的 args 和可选 segments 长度。
			return withPayload(json(["c", message.call, message.hold, message.method]), message.args, message.segments);
		case "abort":
			return json(["x", message.call]);
		case "bound":
			// 外层 ["b",[entries...]]；每个 entry 由 boundEntry 生成。
			return `["b",[${message.holds.map(boundEntry).join(",")}]]`;
		case "state":
			return `["s",[${message.holds.map(stateEntry).join(",")}]]`;
		case "failed": {
			// 失败原因只用首字母（t/b/w），与 CAUSE_KINDS 的三值一一对应。
			const kind = message.cause.kind[0];
			// retryIn 缺省时不追加字段；存在时作为第 4 个位置参数。
			const retryIn = message.retryIn === undefined ? [] : [message.retryIn];
			return json(["f", message.hold, kind, message.cause.error, ...retryIn]);
		}
		case "result":
			return withPayload(json(["r", message.call]), message.value, message.segments);
		case "error":
			return json(["e", message.call, message.error]);
		case "gone":
			return json(["g", message.hold, message.error]);
		case "revoke":
			return json(["V", message.revocation]);
		case "retry":
			return json(["T", message.hold, message.hops]);
		case "loading":
			return json(["l", message.hold]);
		// 无字段消息：只有标签。
		case "ack":
			return json(["a"]);
		case "closed":
			return json(["C"]);
		case "ping":
			return json(["p"]);
		case "pong":
			return json(["P"]);
	}
}

// 简单 JSON 序列化封装；参数是 unknown，返回 string。
// 注意：JSON.stringify(undefined) 的类型是 string | undefined，但这里调用点都传入对象/数组/标量，不会得到 undefined；
// 若未来传入 undefined，函数签名会掩盖这个问题（运行时会返回 undefined）。
function json(value: unknown): string {
	return JSON.stringify(value);
}

/** `[hold, variant, [[member, value]…], failed?]`. */
// 生成一个 bound hold 条目。members 是 [member, value] 对，value 用 partText 拼接；
// failed 为可选末位字段，空时完全省略。
// 示例：{hold:1, variant:0, members:[{member:0,value:'[]'}], failed:[]} -> `[1,0,[[0,[0,[]]]]]`。
function boundEntry({ hold, variant, members, failed }: BoundEntry): string {
	const pairs = members.map(({ member, value }) => `[${member},${partText(value)}]`).join(",");
	return `[${hold},${variant},[${pairs}]${failedField(failed)}]`;
}

/** `[hold, [[member, ops]…], failed?, retired?]`; `failed` is `[]` when only `retired` follows. */
// 生成一个 state 条目。缺少退役列表时保持三元形状；有退役时必须写出 failed（即使为空），
// 这样 retired 才能占据第 4 个位置，解码端按位置判断。
function stateEntry({ hold, members, failed, retired }: StateEntry): string {
	const pairs = members.map(({ member, ops }) => `[${member},${partText(ops)}]`).join(",");
	// 无退役：failed 作为可选末位字段。
	if (retired.length === 0) return `[${hold},[${pairs}]${failedField(failed)}]`;
	// 有退役：失败列表显式写成 [member,error] 对（空数组也写 []），再写退役下标数组。
	return `[${hold},[${pairs}],${json(failed.map(({ member, error }) => [member, error]))},${json(retired)}]`;
}

/** The failures as an entry's optional last field: left out when there are none. */
// 失败列表的可选片段：没有失败时返回空串（不占位），有失败时返回带前导逗号的 JSON 数组。
// 返回片段而不是完整字段，是为了让调用方直接拼在已有关闭括号之前。
function failedField(failed: readonly FailedMember[]): string {
	return failed.length === 0 ? "" : `,${json(failed.map(({ member, error }) => [member, error]))}`;
}

/**
 * A tuple (its closed JSON `head`) ending in a payload part; one marked as carrying bytes adds the segments' lengths
 * as the last field.
 */
// 把 payload 拼到已有关闭括号的元组上：
// - 无 part：直接返回原元组（无参数/无返回值）；
// - 有 part：删掉原 "]" 后追加 partText(part)；
// - 有 segments：再追加段长度数组，解码端按这些长度从换行后切分。
// head 已经包含开头的 "[" 和标签；slice(0,-1) 只去掉最后一个字符。
function withPayload(head: string, part: Part | undefined, segments: readonly Uint8Array[] | undefined): string {
	if (part === undefined) return head;
	const prefix = `${head.slice(0, -1)},${partText(part)}`;
	if (segments === undefined) return `${prefix}]`;
	return `${prefix},${json(segments.map((segment) => segment.byteLength))}]`;
}

/**
 * A message from its tuple: the tag and arity checked, lists of pairs checked as lists, parts written back as text;
 * the field types are the message schema's to check. `rest` holds the segments, which only a payload marked as
 * carrying bytes may have.
 */
// 顶层分派：普通元组直接解析；首元素是 "@" 时按 origin 包装解析，
// 要求字段数恰为 3 且内部仍是元组、内部不能再是 "@"。
// 注意：fields 来自 JSON.parse，元素类型是 unknown，因此每一步都要运行时检查。
function fromTuple(fields: unknown[], rest: Uint8Array): Message {
	// 不是包装：按普通消息字段处理。
	if (fields[0] !== "@") return fromFields(fields, rest);
	// 长度不是 3 时 inner=[]，随后统一报“一个 origin 只包一条消息”。
	const inner = fields.length === 3 ? list(fields[2]) : [];
	if (inner[0] === "@" || inner.length === 0) throw new Error("text: an origin wraps one message");
	const message = fromFields(inner, rest);
	// A fresh object; the message schema checks the origin and refuses one on a kind without it.
	// origin 的合法性（正整数、kind 是否允许）交给 checkMessage；这里只补字段。
	(message as { origin?: unknown }).origin = fields[1];
	return message;
}

/** A message from its own fields' tuple (see `fromTuple`). */
// 解析消息自身元组（外层 origin 已剥离）。返回 Message，不做字段类型检查。
// 结构：fields[0] 是标签，其余 f 是位置参数；rest 是换行后的字节段。
function fromFields(fields: unknown[], rest: Uint8Array): Message {
	// 解构：tag 是首项，f 是剩余参数组成的数组（注意与函数参数 rest 区分，后者是换行后的字节段）。
	const [tag, ...f] = fields;
	// 局部箭头函数检查参数个数；...allowed 是剩余参数，编译成数组。
	// 用闭包捕获 tag/f，调用处只写 arity(3) 等。
	const arity = (...allowed: number[]): void => {
		if (!allowed.includes(f.length)) throw new Error(`text: a "${String(tag)}" message with ${f.length} fields`);
	};
	// 只有 call("c") 和 result("r") 允许携带字节段；其他消息后有字节说明帧内容不对应。
	if (tag !== "c" && tag !== "r" && rest.byteLength > 0) {
		throw new Error("text: byte segments without a payload that carries them");
	}
	// The message schema establishes the types of the fields taken here.
	// 通用取值助手：索引 + 泛型返回类型，实际是 as 断言；调用方声明期望类型，schema 稍后负责验证。
	// 例：field<number>(0) 告诉 TS 第 0 项是 number，但运行时若为字符串不会被这里发现。
	const field = <T>(index: number): T => f[index] as T;
	switch (tag) {
		case "h":
			// ["h", protocol, incarnation, calls]；必须恰好 3 个位置参数。
			arity(3);
			return { kind: "hello", protocol: field(0), incarnation: field(1), calls: field(2) };
		case "H": {
			// hold 允许 6/7/8/9/10：5 个必填且固定 + params + address + 最多 4 个可选，共 6..10。
			arity(6, 7, 8, 9, 10);
			// address 固定是 [kind, params] 二元组。
			const address = list(f[5]);
			if (address.length !== 2) throw new Error("text: an address is a pair");
			// 可选字段从下标 6 开始；?? null 把缺失（undefined）统一成 null。
			const [principal, incarnation, chain, limit] = [6, 7, 8, 9].map((index) => f[index] ?? null);
			// params 用 textPart 反向还原；断言只用于 TS，形状由 schema 检查。
			return {
				kind: "hold",
				hold: field(0),
				type: field(1),
				version: field(2),
				fingerprint: field(3),
				params: textPart(f[4]),
				address: { kind: address[0] as string, params: address[1] },
				...(principal === null ? {} : { principal: principal as { kind: string } }),
				...(incarnation === null ? {} : { incarnation: incarnation as string }),
				...(chain === null ? {} : { chain: chain as string[] }),
				...(limit === null ? {} : { limit: limit as number }),
			};
		}
		case "R":
			arity(1);
			return { kind: "release", hold: field(0) };
		case "c":
			// call 允许 3（无 args）、4（args）、5（args + 段长度）。
			arity(3, 4, 5);
			// f.slice(3) 是 args 及其后的段长度字段，交给 payload 统一解析。
			return {
				kind: "call",
				call: field(0),
				hold: field(1),
				method: field(2),
				...payload("args", f.slice(3), rest),
			};
		case "x":
			arity(1);
			return { kind: "abort", call: field(0) };
		case "b":
			// 外层只有一个字段：holds 数组。
			arity(1);
			return {
				kind: "bound",
				holds: list(f[0]).map((entry): BoundEntry => {
					// 每个条目是 3 或 4 元组：hold, variant, members, failed?
					const fields = list(entry);
					if (fields.length !== 3 && fields.length !== 4) {
						throw new Error(`text: a bound entry with ${fields.length} fields`);
					}
					const [hold, variant, members, failed] = fields;
					// 回调显式标注返回 BoundEntry；成员对由 pairs 检查为二元组，value 经 textPart 还原。
					// 数值断言 as number 不在运行时校验，schema 检查会兜底。
					return {
						hold: hold as number,
						variant: variant as number,
						members: pairs(members).map(([member, value]) => ({
							member: member as number,
							value: textPart(value),
						})),
						failed: failures(failed),
					};
				}),
			};
		case "s":
			arity(1);
			return {
				kind: "state",
				holds: list(f[0]).map((entry): StateEntry => {
					// 每个 state 条目 2..4 元组：hold, members, failed?, retired?
					const fields = list(entry);
					if (fields.length < 2 || fields.length > 4) {
						throw new Error(`text: a state entry with ${fields.length} fields`);
					}
					const [hold, members, failed, retired] = fields;
					return {
						hold: hold as number,
						members: pairs(members).map(([member, ops]) => ({ member: member as number, ops: textPart(ops) })),
						failed: failures(failed),
						// The message schema checks each index.
						// 没有 retired 字段时复用共享空数组；有则用 list 检查后断言成 number[]。
						retired: retired === undefined ? NO_RETIRED : (list(retired) as number[]),
					};
				}),
			};
		case "f": {
			// failed 允许 3（无 retryIn）或 4（有 retryIn）。
			arity(3, 4);
			// 线上原因只有一个首字母；find 在 CAUSE_KINDS 中按首字母匹配，找回完整单词。
			const causeKind = CAUSE_KINDS.find((each) => each[0] === f[1]);
			if (causeKind === undefined) throw new Error("text: an unknown failure kind");
			// The schema check after decoding establishes the wire error.
			// 断言成 WireError 供 TS 使用；实际形状由 schema 检查。
			const error = f[2] as Extract<Message, { kind: "error" }>["error"];
			const cause = { kind: causeKind, error };
			// 只有第 4 个字段存在时才展开 retryIn；否则对象里完全没有该键。
			return { kind: "failed", hold: field(0), cause, ...(f.length === 4 ? { retryIn: field<number>(3) } : {}) };
		}
		case "r":
			// result 允许 1（无 value）、2（value）、3（value + 段长度）。
			arity(1, 2, 3);
			return { kind: "result", call: field(0), ...payload("value", f.slice(1), rest) };
		case "e":
			arity(2);
			return { kind: "error", call: field(0), error: field(1) };
		case "g":
			arity(2);
			return { kind: "gone", hold: field(0), error: field(1) };
		case "V":
			arity(1);
			return { kind: "revoke", revocation: f[0] };
		case "T":
			arity(2);
			return { kind: "retry", hold: field(0), hops: field(1) };
		case "l":
			arity(1);
			return { kind: "loading", hold: field(0) };
		// 无字段消息：arity(0) 保证没有多余位置参数。
		case "a":
			arity(0);
			return { kind: "ack" };
		case "C":
			arity(0);
			// Its origin is the wrapper's; 0 without one, which the message schema refuses.
			// 与 binary 一致：先放占位 0，外层若有 origin 会覆盖；没有 origin 时 schema 拒绝。
			return { kind: "closed", origin: 0 };
		case "p":
			arity(0);
			return { kind: "ping" };
		case "P":
			arity(0);
			return { kind: "pong" };
		// 标签不在已知表中：协议错误。
		default:
			throw new Error("text: an unknown kind");
	}
}

/**
 * A payload part from its fields: none, the value, or the value and its segments' lengths (marked as carrying bytes,
 * the segments views of `rest`).
 */
// 从 call/result 的剩余字段解析 payload：
// fields 是 [part?] 或 [part, lengths]；rest 是换行后的全部字节段。
// 返回 { args|value, segments? }，键名由泛型 K 决定。
// 若没有段长度字段但 rest 非空，说明有字节却没声明，属于协议错误；
// 若有长度，则按顺序切出段视图，并要求正好用尽 rest。
function payload<K extends string>(
	key: K,
	fields: unknown[],
	rest: Uint8Array,
): { [P in K]?: Part } & { segments?: Uint8Array[] } {
	// 少于 2 个字段：没有长度数组，因此不允许有字节段。
	if (fields.length < 2) {
		if (rest.byteLength > 0) throw new Error("text: byte segments without a payload that carries them");
		// 0 个字段 => 无 part；1 个字段 => 还原该 part。as 只为映射类型断言。
		return (fields.length === 0 ? {} : { [key]: textPart(fields[0]) }) as { [P in K]?: Part };
	}
	// 第二个字段必须是长度数组；list 运行时检查它确实是数组。
	const lengths = list(fields[1]);
	let offset = 0;
	const segments = lengths.map((length) => {
		// 长度必须是安全非负整数：防止负数导致 subarray 反向、或小数/NaN 产生怪异视图。
		if (!Number.isSafeInteger(length) || (length as number) < 0) throw new Error("text: a segment length");
		// subarray 不复制；越界会被自动截短，因此最后还要检查总长度是否精确匹配。
		const segment = rest.subarray(offset, offset + (length as number));
		offset += length as number;
		return segment;
	});
	// 段长度之和必须恰好等于换行后字节数；多或少都意味着帧损坏。
	if (offset !== rest.byteLength) throw new Error("text: the segments do not fill the message");
	return { [key]: textPart(fields[0]), segments } as { [P in K]?: Part } & { segments: Uint8Array[] };
}

// 把 unknown 检查成数组并返回；Array.isArray 的收窄在自定义函数中不会自动传播，
// 因此返回类型显式是 unknown[]，由调用方继续逐项检查。
function list(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("text: expected a list");
	return value;
}

/** A list of `[index, value]` pairs. */
// 把列表检查成二元组列表：[member, value] 或 [member, error]。
// 返回类型 [unknown, unknown][] 让解构后两项仍是 unknown，避免误用。
function pairs(value: unknown): [unknown, unknown][] {
	return list(value).map((pair) => {
		const entry = list(pair);
		if (entry.length !== 2) throw new Error("text: expected a pair");
		// 长度检查后断言成元组类型，便于调用方解构。
		return entry as [unknown, unknown];
	});
}

/** The optional failures field; absent means none. */
// 可选失败字段：缺省（undefined）表示没有失败，返回新空数组；
// 存在时必须是 [member,error] 对列表，映射成 FailedMember。
// 错误对象形状不在这里检查，留给 message schema。
function failures(value: unknown): FailedMember[] {
	if (value === undefined) return [];
	// The message schema checks each error's shape.
	return pairs(value).map(([member, error]) => ({ member, error }) as FailedMember);
}
