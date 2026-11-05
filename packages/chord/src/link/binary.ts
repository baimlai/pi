// The binary codec (2b): a kind byte (its high bit set when an origin follows as a varint), then the kind's fields as
// unsigned varints, length-prefixed UTF-8 strings, raw incarnation (16 bytes) and fingerprint (8 bytes), parts as
// length-prefixed bytes whose prefix also says whether the part is deflated (decoded as views of the message, never
// parsed or inflated here), and byte segments only beside payloads marked as carrying bytes. No outer length: links
// deliver whole messages.

// 文件导读
// 所属模块：packages/chord/src/link 的默认二进制 Codec 实现（Chord v2 链路层）。
// 职责与边界：把 Message 编码成紧凑字节，把字节解回 Message。只做结构与边界检查（kind/flags/长度/varint 上限），
// 不校验字段业务范围（交给 message.ts 的 checkMessage），不解析 JSON 以外的 Part，不解压。
// 上游入口：Channel 的 send 调 binaryCodec.encode；收到帧后调 binaryCodec.decode，再调 checkMessage。
// 下游依赖：message.ts 的类型与常量、part.ts 的 Part/DeflatedPart、values.ts 的严格 UTF-8/JSON 解码。
// 结果与错误流向：encode 返回完整消息字节（无外层长度）；decode 返回 Message 或抛普通 Error（未知 kind、
// flags、越界、尾随字节），Channel 将其视为协议错误并关闭链路。
// 能力清单：
// - binaryCodec：公开的 Codec 对象，name 为 "binary"，实现 encode/decode。
// - KINDS/KIND_BYTES：消息 kind 与线上字节的双向映射。
// - ORIGIN/PRESENT/SEGMENTS/PRINCIPAL/INCARNATION/CHAIN/LIMIT/DEFLATED：位标志常量。
// - encodeFields/decodeFields：按 kind 读写字段的 switch。
// - Writer：增长缓冲写入器（varint、字符串、Part、payload、失败列表）。
// - Reader：带边界检查的读取器（返回消息缓冲上的视图）。
// - hex/hexText/uuid：uuid 与指纹的文本/字节转换。
// 其中仅 binaryCodec 对外导出；KINDS/Writer/Reader 等其余项均为本文件内部实现。
// 线格式：[kind 字节(高位=有 origin)][可选 origin varint][按 kind 固定顺序的字段]；整数为无符号 LEB128 varint；
// 字符串/JSON 带长度前缀；uuid/指纹写 16/8 字节裸数据；Part 前缀为“长度×2 + 压缩位”；payload 先标志再 Part 和 segments。
// 典型调用顺序：encode -> Writer.byte/varint/字段 -> finish；decode -> Reader.byte -> decodeFields -> reader.end。
// 示例：binaryCodec.encode({ kind: "release", hold: 300 }) 返回 Uint8Array [2, 0xac, 0x02]；
//       binaryCodec.decode(new Uint8Array([2, 0xac, 0x02])) 返回 { kind: "release", hold: 300 }。
// 建议阅读顺序：KINDS 与位常量 -> binaryCodec 的 encode/decode -> encodeFields/decodeFields 对照阅读
// -> Writer 的 #text/part/payload -> Reader 的 varint/part/payload -> 十六进制辅助函数。

import {
	type BoundEntry,
	CAUSE_KINDS,
	type Codec,
	type FailedMember,
	type Message,
	NO_RETIRED,
	type StateEntry,
} from "./message.ts";
import { DeflatedPart, type Part } from "./part.ts";
import { parseJson, readUtf8 } from "./values.ts";

// 共享编码器，供字符串/JSON 写入使用；与 values.ts 的严格解码器配对。
const UTF8 = new TextEncoder();

/** Kinds by their byte. */
// 消息 kind 与字节值的映射表：下标就是线上字节。新增 kind 只能追加到末尾，
// 不能重排，否则新旧版本之间字节含义会错位（协议兼容性由测试保证）。
// `as const` 让数组元素成为字面量联合类型，供 decodeFields 的参数类型使用。
const KINDS = [
	"hello",
	"hold",
	"release",
	"call",
	"abort",
	"bound",
	"state",
	"failed",
	"result",
	"error",
	"gone",
	"retry",
	"loading",
	"ack",
	"closed",
	"ping",
	"pong",
	"revoke",
] as const;

// 反向索引：kind 名称 -> 字节，避免编码时每次 indexOf 线性查找。
// KINDS.map 生成 [kind, byte] 元组数组，Map 构造器直接接受。
const KIND_BYTES = new Map<string, number>(KINDS.map((kind, byte) => [kind, byte]));

/** The kind byte's flag for an origin. */
// kind 字节最高位表示“后面还有一个 origin varint”；低 7 位仍能表示 0..127 种消息。
const ORIGIN = 0x80;

/** A payload's flags: present, and carrying byte segments. */
// payload 标志按位组合：1=有 part（args/value 存在），2=后面还有 segments。
// 0 表示字段缺省（无参数方法 / 返回 null）。
const PRESENT = 1;

const SEGMENTS = 2;

/** A hold's optional fields, one bit each. */
// hold 的四个可选字段各占一位；读端先读 flags 字节，再按位决定是否读对应字段。
// 这样缺省字段不占空间，且顺序固定。
const PRINCIPAL = 1;

const INCARNATION = 2;

const CHAIN = 4;

const LIMIT = 8;

/** A part's length prefix is its length doubled, plus one when the part is deflated. */
// Part 前缀 = 字节长度 × 2 + 压缩标志。乘 2 后最低位空出来放 deflate 标志，
// 因此一个 varint 同时表达长度和形态。
const DEFLATED = 1;

/** Messages as bytes; the default codec of every link. */
// 二进制编解码器对象，实现 Codec 接口。对象字面量的方法简写（encode(message) {...}）
// 让 this 指向该对象，但这里不依赖 this，因此可安全解构调用。
export const binaryCodec: Codec = {
	name: "binary",
	// 编码：先写 kind 字节，再按该 kind 写字段。origin 的存在通过 `"origin" in message` 判断：
	// 这是运行时属性检查，用来区分“没有该字段”和“字段值为 undefined”；联合类型中并非所有分支都有 origin。
	encode(message) {
		const writer = new Writer();
		const origin = "origin" in message ? message.origin : undefined;
		if (origin === undefined) {
			// KIND_BYTES.get 的 ! 是非空断言：message.kind 一定在表中（类型来自同一常量）。
			writer.byte(KIND_BYTES.get(message.kind)!);
		} else {
			// 有 origin：kind 字节置高位，紧跟一个 origin varint。
			writer.byte(KIND_BYTES.get(message.kind)! | ORIGIN);
			writer.varint(origin);
		}
		// 字段顺序完全由 encodeFields 的 switch 决定；编码/解码必须同步修改。
		encodeFields(message, writer);
		// finish 返回精确长度的视图或裁剪副本，避免长期保留 256 字节的初始缓冲。
		return writer.finish();
	},
	// 解码：Reader 每次读取都做边界检查；任何格式错误抛普通 Error，由 Channel 当作协议错误关闭链路。
	decode(bytes) {
		const reader = new Reader(bytes);
		const byte = reader.byte();
		// byte & ORIGIN 是位掩码测试；~ORIGIN 清除最高位（在 JS 中是 32 位运算，但字节只有 8 位，结果 0..127）。
		const origin = byte & ORIGIN ? reader.varint() : undefined;
		const kind = KINDS[byte & ~ORIGIN];
		// 越界下标得到 undefined（TS 类型是 string | undefined），必须显式检查。
		if (kind === undefined) throw new Error("binary: an unknown kind");
		const message = decodeFields(kind, reader);
		// 要求正好消费完：尾部多余字节说明帧格式不对。
		reader.end();
		// A fresh object; the message schema refuses an origin on a kind without one.
		// decodeFields 返回新对象（未冻结）；这里补上 origin。断言只用于写可选属性，
		// 真正的合法性由后续 checkMessage 的 schema 判定（如 hello 不允许 origin）。
		if (origin !== undefined) (message as { origin?: number }).origin = origin;
		return message;
	},
};

// 按 kind 写各字段。switch 对可辨识联合收窄：每个 case 里 message 只剩对应分支类型。
// 每个 case 末尾 return；没有 default。返回类型是 void，所以新增 kind 却漏写 case 时
// TS 不会报穷尽错误，只会静默不写字段；编解码往返测试负责兜底。
function encodeFields(message: Message, writer: Writer): void {
	switch (message.kind) {
		case "hello":
			// hello 固定顺序：协议版本、16 字节 incarnation、调用窗口 calls。
			// uuid 文本去掉 "-" 后按 16 字节十六进制写入，省掉 4 个分隔符的开销。
			writer.varint(message.protocol);
			writer.raw(hex(message.incarnation.replaceAll("-", ""), 16));
			writer.varint(message.calls);
			return;
		case "hold": {
			// hold 的必填部分：编号、契约类型名、版本、8 字节指纹、参数 Part、地址（kind + JSON params）。
			writer.varint(message.hold);
			writer.string(message.type);
			writer.varint(message.version);
			writer.raw(hex(message.fingerprint, 8));
			writer.part(message.params);
			// 解构出后续需要的字段；`address` 是必填对象，其余四个可选。
			const { address, principal, incarnation, chain, limit } = message;
			writer.string(address.kind);
			writer.json(address.params);
			// 用位或把四个“存在则置位”的表达式合成一个 flags 字节；
			// 三元表达式返回 0 或对应位常量，任何字段缺失时对应位为 0。
			writer.byte(
				(principal === undefined ? 0 : PRINCIPAL) |
					(incarnation === undefined ? 0 : INCARNATION) |
					(chain === undefined ? 0 : CHAIN) |
					(limit === undefined ? 0 : LIMIT),
			);
			// 可选字段按固定顺序紧跟 flags，只有置位才写；读端按同样顺序消费。
			if (principal !== undefined) writer.json(principal);
			if (incarnation !== undefined) writer.raw(hex(incarnation.replaceAll("-", ""), 16));
			if (chain !== undefined) {
				// 激活链：先写长度，再逐个写 16 字节实例 id。
				writer.varint(chain.length);
				for (const instance of chain) writer.raw(hex(instance.replaceAll("-", ""), 16));
			}
			if (limit !== undefined) writer.varint(limit);
			return;
		}
		// release 与 loading 线上形状相同：只有一个 hold 编号。共用 case 贯穿（fallthrough）。
		case "release":
		case "loading":
			writer.varint(message.hold);
			return;
		case "retry":
			// retry：hold 编号 + 剩余跳数。
			writer.varint(message.hold);
			writer.varint(message.hops);
			return;
		case "call":
			// call：调用编号、hold 编号、方法下标，然后 payload（args + 可选 segments）。
			writer.varint(message.call);
			writer.varint(message.hold);
			writer.varint(message.method);
			writer.payload(message.args, message.segments);
			return;
		case "abort":
			writer.varint(message.call);
			return;
		case "bound":
			// 批量绑定：先写 hold 条数，再逐条写 hold、variant、成员数、每个成员（下标 + Part），最后失败列表。
			// 每个长度都由读端用于分配/循环，因此顺序必须与 decodeFields 完全一致。
			writer.varint(message.holds.length);
			for (const { hold, variant, members, failed } of message.holds) {
				writer.varint(hold);
				writer.varint(variant);
				writer.varint(members.length);
				for (const { member, value } of members) {
					writer.varint(member);
					writer.part(value);
				}
				writer.failed(failed);
			}
			return;
		case "state":
			// state 与 bound 类似，但没有 variant；失败与退役合并写入 failedAndRetired。
			writer.varint(message.holds.length);
			for (const { hold, members, failed, retired } of message.holds) {
				writer.varint(hold);
				writer.varint(members.length);
				for (const { member, ops } of members) {
					writer.varint(member);
					writer.part(ops);
				}
				writer.failedAndRetired(failed, retired);
			}
			return;
		case "failed":
			// 失败原因用 CAUSE_KINDS 的下标做单字节；协议保证 indexOf 不会返回 -1（类型已限定三个值）。
			writer.varint(message.hold);
			writer.byte(CAUSE_KINDS.indexOf(message.cause.kind));
			writer.json(message.cause.error);
			// 0 when absent, else one more than the delay.
			// retryIn 需要区分“缺省”和数值 0，因此编码为 0=缺省、n+1=延迟 n 毫秒。
			writer.varint(message.retryIn === undefined ? 0 : message.retryIn + 1);
			return;
		case "result":
			// result：调用编号 + payload（value 可缺省；segments 只在返回值含 bytes 时出现）。
			writer.varint(message.call);
			writer.payload(message.value, message.segments);
			return;
		case "error":
			writer.varint(message.call);
			writer.json(message.error);
			return;
		case "gone":
			writer.varint(message.hold);
			writer.json(message.error);
			return;
		case "revoke":
			// 撤销数据整体是 JSON，具体形状由上层校验；这里只当不透明值传输。
			writer.json(message.revocation);
			return;
		// 这四种消息没有字段；origin（closed 必带，ack 可选）已由外层 kind 字节处理。
		case "ack":
		case "closed":
		case "ping":
		case "pong":
			return;
	}
}

/** The kind's fields, read structurally; the envelope's types are checked by the message schema afterwards. */
// 按 kind 逆向读取字段，返回 Message 的普通对象。
// 这里只做结构读取和必要的格式检查（未知 kind/flags、越界），不做完整类型/schema 校验；
// Channel 随后调用 checkMessage，用同一份 schema 检查字段值和范围。
// 参数类型 `(typeof KINDS)[number]` 是数组元素类型，即所有 kind 字面量的联合。
function decodeFields(kind: (typeof KINDS)[number], reader: Reader): Message {
	// The message schema establishes the types of what is read here (JSON fields are checked by it).
	// 每个 case 返回带 kind 的新对象；TS 通过 switch 收窄 kind，但对象字面量最终仍靠 schema 验证。
	switch (kind) {
		case "hello":
			// 顺序与 encode 一致：protocol、16 字节 raw -> uuid 文本、calls。
			return { kind, protocol: reader.varint(), incarnation: uuid(reader.raw(16)), calls: reader.varint() };
		case "hold": {
			// 依次读必填字段；params 是 Part（这里是字节视图，不解析）。
			const hold = reader.varint();
			const type = reader.string();
			const version = reader.varint();
			const fingerprint = hexText(reader.raw(8));
			const params = reader.part();
			// address.params 是内联 JSON，在这里立即解析；其 schema 由 host 路由层按 kind 校验。
			const address = { kind: reader.string(), params: reader.json() };
			// flags 只允许四个已知位；出现其他位说明对端使用了本版本不认识的字段，属于协议错误。
			const flags = reader.byte();
			if (flags > (PRINCIPAL | INCARNATION | CHAIN | LIMIT)) throw new Error("binary: unknown hold flags");
			// 每个可选字段按位读取；条件为真时构造一个只含该字段的小对象，否则用空对象。
			// `as { kind: string }` 是类型断言：principal 的完整校验留给 schema 与父链路。
			const principal = flags & PRINCIPAL ? { principal: reader.json() as { kind: string } } : {};
			const incarnation = flags & INCARNATION ? { incarnation: uuid(reader.raw(16)) } : {};
			const chain = flags & CHAIN ? { chain: reader.list(() => uuid(reader.raw(16))) } : {};
			const limit = flags & LIMIT ? { limit: reader.varint() } : {};
			// 对象展开把可选字段合并进最终对象：没有的字段不会出现（而不是值为 undefined）。
			// 这与 encode 前用 `"origin" in message` 判断存在性的约定一致。
			return {
				kind,
				hold,
				type,
				version,
				fingerprint,
				params,
				address,
				...principal,
				...incarnation,
				...chain,
				...limit,
			};
		}
		case "release":
		case "loading":
			// 与 encode 共用形状：只有 hold。
			return { kind, hold: reader.varint() };
		case "retry":
			return { kind, hold: reader.varint(), hops: reader.varint() };
		case "call": {
			// 数组解构按从左到右求值：三个 varint 依次读取，顺序必须与写入一致。
			const [call, hold, method] = [reader.varint(), reader.varint(), reader.varint()];
			// payload("args") 返回 {} 或 {args, segments?}，展开合并进消息对象。
			return { kind, call, hold, method, ...reader.payload("args") };
		}
		case "abort":
			return { kind, call: reader.varint() };
		case "bound": {
			// list 先读元素个数并做边界合理性检查，再用回调逐项读取。
			// 回调显式标注返回 BoundEntry，让 TS 检查字段与 Message 类型一致。
			const holds = reader.list((): BoundEntry => {
				const [hold, variant] = [reader.varint(), reader.varint()];
				const members = reader.list(() => ({ member: reader.varint(), value: reader.part() }));
				return { hold, variant, members, failed: reader.failed() };
			});
			return { kind, holds };
		}
		case "state": {
			const holds = reader.list((): StateEntry => {
				const hold = reader.varint();
				const members = reader.list(() => ({ member: reader.varint(), ops: reader.part() }));
				// The failure count times two, plus one when retirements follow.
				// 一个 varint 同时编码失败数与“是否有退役列表”：失败数 = floor(flags/2)，最低位是退役标志。
				const flags = reader.varint();
				const failed = reader.failedEntries(Math.floor(flags / 2));
				// 没有退役时复用 NO_RETIRED 单例，避免每条 state 都分配空数组。
				const retired = flags % 2 === 0 ? NO_RETIRED : reader.list(() => reader.varint());
				return { hold, members, failed, retired };
			});
			return { kind, holds };
		}
		case "failed": {
			const hold = reader.varint();
			// 原因字节是 CAUSE_KINDS 下标；越界得到 undefined，显式拒绝。
			const cause = CAUSE_KINDS[reader.byte()];
			if (cause === undefined) throw new Error("binary: an unknown failure kind");
			// The schema check after decoding establishes the wire error.
			// JSON 解析只保证是合法 JSON；断言成 WireError 供 TS 使用，真正形状由 checkMessage 检查。
			const error = reader.json() as Extract<Message, { kind: "error" }>["error"];
			const retryIn = reader.varint();
			// 0 表示没有 retryIn；否则线上值 = 延迟 + 1，这里减回去。
			// 条件展开 `...(cond ? {} : {retryIn})` 让缺省字段完全不出现。
			return {
				kind,
				hold,
				cause: { kind: cause, error },
				...(retryIn === 0 ? {} : { retryIn: retryIn - 1 }),
			};
		}
		case "result":
			return { kind, call: reader.varint(), ...reader.payload("value") };
		case "error":
			return { kind, call: reader.varint(), error: reader.json() as Extract<Message, { kind: "error" }>["error"] };
		case "gone":
			return { kind, hold: reader.varint(), error: reader.json() as Extract<Message, { kind: "error" }>["error"] };
		case "revoke":
			return { kind, revocation: reader.json() };
		// ack/ping/pong 没有字段；ack 的 origin 若存在已由外层读取。
		case "ack":
		case "ping":
		case "pong":
			return { kind };
		case "closed":
			// Its origin is the kind byte's; 0 without one, which the message schema refuses.
			// 这里先放占位 0，真正的 origin 在 decode 外层读到后覆盖。
			// 若线上没有 origin，schema 的 min:1 会拒绝该消息，因此占位值不会被当作合法值使用。
			return { kind, origin: 0 };
	}
}

/** Up to this many UTF-16 units a string takes at most 126 bytes, so its length is one varint byte. */
// 短字符串阈值：scale=1 时最多 42 个 UTF-16 码元，编码后最多 126 字节；
// scale=2 时实际比较 42/scale=21 个码元，长度×scale 仍最多 126，因此前缀恰好占一个 varint 字节。
const SHORT = 42;

/** From this many UTF-16 units a string is encoded in place (below it, encoding on its own and copying is cheaper). */
// 长字符串阈值：≥4096 码元才值得“先占 5 字节长度槽、原地 encodeInto、最后回填”，
// 否则单独编码再复制更简单且通常更快。
const LONG = 4096;

/** The fixed length prefix of a long string: five varint bytes, up to 32 GiB (16 GiB for a part). */
// 长字符串使用固定 5 字节的“填充 varint”作为长度槽：前 4 字节带继续位，第 5 字节最高位为 0，
// 读端按普通 varint 解析，会在第 5 字节停止；填充的零高位不改变数值。
// 5×7=35 位，理论上限 32 GiB；这远低于 JS 安全整数，但已超过默认 Part 上限。
const LENGTH_SLOT = 5;

/** The room left after a large chunk for the fields that follow it. */
// 扩容时额外预留的空间，避免大块写入后紧接着的小字段触发多次扩容。
const SPARE = 4096;

/** Writes a message into one growing buffer, right-sized at the end. */
// 写入器：维护一个可增长的 Uint8Array 和当前写入位置。所有方法都可能触发扩容；
// 它不检查消息 schema，调用方保证字段顺序与类型正确。
class Writer {
	/** Large enough for most small messages (a state change, a call), small enough to zero cheaply. */
	// 初始 256 字节覆盖大多数消息；# 前缀是真正的私有字段，外部无法访问。
	#buffer = new Uint8Array(256);
	// 已写入的字节数，始终指向下一个可写位置。
	#length = 0;

	// 写单字节；#reserve(1) 确保容量，然后先取下标再自增。
	byte(byte: number): void {
		this.#reserve(1);
		this.#buffer[this.#length++] = byte;
	}

	/** An unsigned LEB128 varint of a safe integer. */
	// 无符号 LEB128：每字节低 7 位存数据，最高位 1 表示还有后续；
	// 小于 0x80 的值只占一字节。先预留 8 字节（安全整数的最大 varint 长度），循环内不再检查容量。
	varint(value: number): void {
		this.#reserve(8);
		let rest = value;
		while (rest >= 0x80) {
			// 取最低 7 位并置继续位；Math.floor 相当于无符号右移，避免 32 位位运算截断大数。
			this.#buffer[this.#length++] = (rest % 0x80) | 0x80;
			rest = Math.floor(rest / 0x80);
		}
		// 最后一字节不置继续位；rest 此时小于 0x80。
		this.#buffer[this.#length++] = rest;
	}

	// 原样复制一段字节（uuid、指纹、已编码 part、segment）；set 带偏移量，不产生中间数组。
	raw(bytes: Uint8Array): void {
		this.#reserve(bytes.byteLength);
		this.#buffer.set(bytes, this.#length);
		this.#length += bytes.byteLength;
	}

	/** A length-prefixed UTF-8 string (`#text`). */
	// 普通字符串：长度前缀 scale=1（长度单位就是字节）。
	string(text: string): void {
		this.#text(text, 1);
	}

	// JSON 字段先序列化成文本，再按普通字符串写；undefined 统一写成 "null"。
	json(value: unknown): void {
		this.string(JSON.stringify(value) ?? "null");
	}

	/**
	 * A part: its text encoded in place, or its bytes (a part received) copied as they are, behind its length doubled,
	 * plus one when deflated.
	 */
	// 写一个 Part：
	// - 字符串（origin 的 JSON 文本）：走 #text，scale=2，使长度前缀最低位可为压缩标志；
	// - 字节或 DeflatedPart：前缀 = 长度×2 + 压缩位，再原样写字节。
	// 注意：收到并转发的 part 是 Uint8Array/DeflatedPart，因此中继不会重新编码 JSON，也不解压。
	part(part: Part): void {
		if (typeof part === "string") {
			this.#text(part, 2);
			return;
		}
		// 三元表达式先判断类型；instanceof 是运行时检查，区分压缩包装与裸字节。
		const bytes = part instanceof DeflatedPart ? part.bytes : part;
		// scale=2：压缩时 +1。
		this.varint(bytes.byteLength * 2 + (part instanceof DeflatedPart ? DEFLATED : 0));
		this.raw(bytes);
	}

	/**
	 * Text behind its UTF-8 length times `scale` (2 for a part's prefix), encoded straight into the buffer where the
	 * prefix is known in advance: a short text (its prefix fits one byte: at most 126 bytes, 42 UTF-16 units, divided
	 * by `scale`) and a long one (a snapshot's JSON, behind a fixed five-byte prefix, a padded varint, which readers
	 * accept). Others are encoded on their own and copied in. No text is encoded twice, and the largest value of a
	 * message is never copied.
	 */
	// 把文本的 UTF-8 字节写在“长度×scale”前缀之后。三条路径针对不同长度：
	// 1) 短文本：前缀必为 1 字节，直接先留 1 字节，再 encodeInto 到其后；
	// 2) 中等文本：单独 encode 成数组，写 varint 前缀，再复制；
	// 3) 长文本：先占固定 5 字节槽，原地 encodeInto（必要时扩容），最后回填长度。
	// 目标是不重复编码、尽量不复制最大的字段。
	#text(text: string, scale: 1 | 2): void {
		// SHORT/scale：保证“UTF-8 字节数 × scale”仍 <128，前缀只占一字节。
		if (text.length <= SHORT / scale) {
			// 最坏情况每码元 3 字节，再加 1 字节前缀；reserve 保证子数组足够长。
			this.#reserve(1 + text.length * 3);
			// encodeInto 直接写进目标缓冲，返回读了多少码元、写了多少字节；
			// 这里从 #length+1 开始写，把首字节留给长度前缀。
			const { written } = UTF8.encodeInto(text, this.#buffer.subarray(this.#length + 1));
			// 前缀是实际写入字节数 × scale（part 时最低位留给压缩标志，此处未压缩故为偶数）。
			this.#buffer[this.#length] = written * scale;
			// 前进 1 字节前缀 + 实际正文；不是预分配的 text.length*3。
			this.#length += 1 + written;
			return;
		}
		// 中等长度：先得到完整 UTF-8 数组，再写前缀并复制。实现简单，复制成本可接受。
		if (text.length < LONG) {
			const bytes = UTF8.encode(text);
			this.varint(bytes.byteLength * scale);
			this.raw(bytes);
			return;
		}
		// 长文本：记录长度槽的起始位置，稍后回填。
		const slot = this.#length;
		// At least one byte per UTF-16 unit; more room is made when the text is not all ASCII.
		// 先假设至少每码元 1 字节，预留长度槽 + 这么多正文空间；非 ASCII 会在循环中追加。
		this.#reserve(LENGTH_SLOT + text.length);
		this.#length += LENGTH_SLOT;
		let read = 0;
		// 循环编码直到所有码元处理完：encodeInto 可能因目标空间不足而只写一部分。
		while (read < text.length) {
			// 第一次直接用原字符串；之后切掉已读前缀再继续，切片只改变读取起点，不改变编码结果。
			const rest = read === 0 ? text : text.slice(read);
			const done = UTF8.encodeInto(rest, this.#buffer.subarray(this.#length));
			read += done.read;
			this.#length += done.written;
			// 没写完说明剩余空间不足，按剩余码元数×2（最坏 3 字节，保守取 2）追加，至少 4 字节。
			if (read < text.length) this.#reserve(Math.max((text.length - read) * 2, 4));
		}
		// 实际正文长度 = 当前写入位置 - 槽起点 - 槽长度；再乘 scale 得到前缀值。
		let length = (this.#length - slot - LENGTH_SLOT) * scale;
		// 把长度写成固定 5 字节 varint：前 4 字节都带继续位，第 5 字节结束。
		// 即使数值很小也会占满 5 字节，这就是“填充 varint”；读端仍能正确解析。
		for (let index = 0; index < LENGTH_SLOT; index++) {
			this.#buffer[slot + index] = (length % 0x80) | (index < LENGTH_SLOT - 1 ? 0x80 : 0);
			length = Math.floor(length / 0x80);
		}
	}

	/** A payload: its flags, then its part and, when marked, its segments (count, lengths, raw bytes). */
	// payload 用于 call.args 和 result.value：
	// - undefined：写 flags=0，表示字段缺省（无参数 / 无返回值）；
	// - 有 Part：flags 置 PRESENT，按需再置 SEGMENTS；
	// - 有 segments：先写段数，再写每段长度，最后写所有原始字节。
	// 先集中写所有段长度再写原始字节，读端可以先拿到长度数组，再逐段取视图。
	payload(part: Part | undefined, segments: readonly Uint8Array[] | undefined): void {
		if (part === undefined) {
			this.varint(0);
			return;
		}
		// 位或组合两个标志；segments 为空数组也算“存在”，仍会写段数 0。
		this.varint(segments === undefined ? PRESENT : PRESENT | SEGMENTS);
		this.part(part);
		if (segments === undefined) return;
		this.varint(segments.length);
		for (const segment of segments) this.varint(segment.byteLength);
		for (const segment of segments) this.raw(segment);
	}

	// 普通失败列表：先写个数，再写每项（成员下标 + JSON 错误）。
	failed(failed: readonly FailedMember[]): void {
		this.varint(failed.length);
		this.#failedEntries(failed);
	}

	/**
	 * A state entry's failures and retirements: the failure count times two, plus one when retirements follow, so an
	 * entry without retirements costs no byte more than its failures.
	 */
	// state 条目的合并计数：flags = 失败数×2 + (有退役 ? 1 : 0)。
	// 这样没有退役时，开销与只写失败数完全相同（一个 varint）；有退役才多写列表。
	failedAndRetired(failed: readonly FailedMember[], retired: readonly number[]): void {
		this.varint(failed.length * 2 + (retired.length > 0 ? 1 : 0));
		this.#failedEntries(failed);
		if (retired.length === 0) return;
		this.varint(retired.length);
		for (const member of retired) this.varint(member);
	}

	// 只写失败项本身，不写个数；调用方已经写过计数（或合并计数）。
	// 解构 { member, error } 后分别写 varint 和 JSON。
	#failedEntries(failed: readonly FailedMember[]): void {
		for (const { member, error } of failed) {
			this.varint(member);
			this.json(error);
		}
	}

	/**
	 * The message: a view of the buffer, or a right-sized copy when the spare room is meaningful (at least 64 bytes and
	 * more than an eighth of the message), so a kept message keeps at most that much beyond itself. A large message
	 * ends within its 4 KiB of room and is not copied.
	 */
	// 结束写入并返回消息字节：subarray 是原缓冲上的视图，不复制；
	// 若剩余空间较多（≥64 且超过消息长度 1/8），用 slice() 复制出精确大小，
	// 避免小消息长期持有大缓冲。大消息剩余空间通常小于 1/8，保持零复制视图。
	finish(): Uint8Array {
		const message = this.#buffer.subarray(0, this.#length);
		const spare = this.#buffer.byteLength - this.#length;
		return spare >= 64 && spare * 8 > this.#length ? message.slice() : message;
	}

	/** Grows the buffer to fit `bytes` more: doubled, or for a large chunk to its end plus room for the small fields after it. */
	// 扩容策略：取“当前容量×2”和“所需长度 + SPARE”的较大者，兼顾小步增长与大块写入；
	// 然后把已有数据复制到新缓冲。所有写入方法先调用它，因此写入循环内无需再检查容量。
	#reserve(bytes: number): void {
		if (this.#length + bytes <= this.#buffer.byteLength) return;
		const grown = new Uint8Array(Math.max(this.#buffer.byteLength * 2, this.#length + bytes + SPARE));
		grown.set(this.#buffer.subarray(0, this.#length));
		this.#buffer = grown;
	}
}

/** Reads a message's bytes; every read is bounds-checked, segments are views of the message. */
// 读取器：持有整帧字节和偏移量。所有读取都检查边界，越界即抛协议错误；
// 返回的字节（raw/part/segments）是原帧上的 subarray 视图，不复制。
class Reader {
	// readonly 私有字段：构造后引用不变；运行时不冻结底层数组。
	readonly #bytes: Uint8Array;
	// 下一个待读位置；由各读取方法推进。
	#offset = 0;

	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
	}

	// 读一字节。JS 数组越界返回 undefined 而不是抛错，因此必须显式检查；
	// 检查通过后 TS 把 byte 收窄为 number。
	byte(): number {
		const byte = this.#bytes[this.#offset];
		if (byte === undefined) throw new Error("binary: the message ends early");
		this.#offset++;
		return byte;
	}

	/** An unsigned LEB128 varint of at most 8 bytes, at most a safe integer. */
	// 解析 varint：每字节低 7 位，乘以 0x80 的幂累加；最高位为 0 时结束。
	// 最多 8 字节（8×7=56 位），且结果不得超过 Number.MAX_SAFE_INTEGER，防止精度丢失。
	varint(): number {
		let value = 0;
		let scale = 1;
		// for(;;) 无终止条件，由内部 return 或 throw 退出；read 从 1 计当前是第几字节。
		for (let read = 1; ; read++) {
			if (read > 8) throw new Error("binary: a varint does not fit");
			const byte = this.byte();
			value += (byte & 0x7f) * scale;
			if (value > Number.MAX_SAFE_INTEGER) throw new Error("binary: a varint does not fit");
			if (byte < 0x80) return value;
			// 继续位存在：下一字节权重乘 128。用乘法而不是左移，避免 32 位截断。
			scale *= 0x80;
		}
	}

	// 读取固定长度字节视图：剩余不足则报错。用减法比较可避免 offset+length 溢出（JS 数字安全，但语义更直接）。
	raw(length: number): Uint8Array {
		if (length > this.#bytes.byteLength - this.#offset) throw new Error("binary: the message ends early");
		const bytes = this.#bytes.subarray(this.#offset, this.#offset + length);
		this.#offset += length;
		return bytes;
	}

	// 先读 varint 字节长度，再严格 UTF-8 解码；非法 UTF-8 抛错。
	string(): string {
		return readUtf8(this.raw(this.varint()));
	}

	// JSON 字段：先读字节，再严格解码 + JSON.parse；结果声明为 unknown，交由 schema 检查。
	json(): unknown {
		return parseJson(this.raw(this.varint()));
	}

	/** A part as a view of the message, unparsed and not inflated. */
	// 读 Part：前缀 /2 得长度，%2 得压缩标志。返回视图而非副本；
	// DeflatedPart 只包装字节，不解压（解压发生在 openPart）。
	part(): Uint8Array | DeflatedPart {
		const prefix = this.varint();
		const bytes = this.raw(Math.floor(prefix / 2));
		return prefix % 2 === DEFLATED ? new DeflatedPart(bytes) : bytes;
	}

	/** A list: its count (each element takes at least a byte, so it cannot pass the message's end), then its elements. */
	// 通用列表读取：先读个数，再调用回调逐个读取。
	// 个数上限用“剩余字节数”做粗略保护：每项至少占 1 字节，超过剩余字节的个数必然非法，
	// 可防止恶意 count 触发巨大数组分配。
	// 泛型 T 由回调返回类型推断；Array.from({length}, read) 逐个调用 read（注意 read 接收 (value, index)，这里忽略参数）。
	list<T>(read: () => T): T[] {
		const count = this.varint();
		if (count > this.#bytes.byteLength - this.#offset) throw new Error("binary: a count does not fit");
		return Array.from({ length: count }, read);
	}

	/** A payload part under `key`, absent when not present, with its segments when marked as carrying them. */
	// 读 payload，键名由调用方给（"args" 或 "value"）。返回类型用映射类型
	// { [P in K]?: Part } 表示“以 K 为键、可选”的对象，& 交叉上可选的 segments。
	// flags 0 => 空对象；1 => { [key]: part }；3 => 再读 segments。
	// 其他组合都是未知标志，直接拒绝。
	payload<K extends string>(key: K): { [P in K]?: Part } & { segments?: Uint8Array[] } {
		const flags = this.varint();
		if (flags === 0) return {};
		if (flags !== PRESENT && flags !== (PRESENT | SEGMENTS)) throw new Error("binary: unknown payload flags");
		const part = this.part();
		if (flags === PRESENT) return { [key]: part } as { [P in K]?: Part };
		// 先读所有段长度，再按长度逐一取视图；长度总和不显式检查，raw 会逐段检查边界。
		const lengths = this.list(() => this.varint());
		const segments = lengths.map((length) => this.raw(length));
		// 计算属性名 [key] 让返回对象的字段名由泛型决定；
		// as 断言是因为 TS 无法从计算属性推断出精确映射类型。
		return { [key]: part, segments } as { [P in K]?: Part } & { segments: Uint8Array[] };
	}

	// 读普通失败列表：先读个数，再复用 failedEntries。
	failed(): FailedMember[] {
		return this.failedEntries(this.varint());
	}

	/** `count` failed members, as `Writer.failed` writes them after their count. */
	// 读 count 个失败项；同样用剩余字节数限制 count。
	// 每项先读成员下标，再读 JSON 错误；断言成 WireError 只为 TS，schema 会再检查。
	failedEntries(count: number): FailedMember[] {
		if (count > this.#bytes.byteLength - this.#offset) throw new Error("binary: a count does not fit");
		// The message schema checks each error's shape.
		return Array.from({ length: count }, () => ({
			member: this.varint(),
			error: this.json() as Extract<Message, { kind: "error" }>["error"],
		}));
	}

	/** The message is consumed exactly. */
	// 解码结束时要求偏移量正好等于总长度；有尾随字节说明格式/帧边界错误。
	end(): void {
		if (this.#offset !== this.#bytes.byteLength) throw new Error("binary: bytes after the message");
	}
}

/** Lowercase hex of 8 and 16 bytes: a fingerprint, an incarnation without its dashes. */
// 允许的十六进制长度：8 字节指纹 = 16 个字符，16 字节 uuid = 32 个字符。
// Map 的 get 对未知长度返回 undefined，配合 ! 断言表示“调用方只传 8/16”。
const HEX = new Map([
	[8, /^[0-9a-f]{16}$/],
	[16, /^[0-9a-f]{32}$/],
]);

/** `length` bytes from lowercase hex (an incarnation without dashes, a fingerprint). */
// 十六进制文本 -> 字节。先按长度选择正则做严格校验（只允许小写、精确长度），
// 再用 Uint8Array.from 的映射回调每两位 parse 成一个字节。
// 例：hex("00ff", 2) -> Uint8Array [0, 255]。
function hex(text: string, length: number): Uint8Array {
	if (!HEX.get(length)!.test(text)) throw new Error(`binary: not ${length} bytes of hex`);
	return Uint8Array.from({ length }, (_, index) => Number.parseInt(text.slice(index * 2, index * 2 + 2), 16));
}

// 字节 -> 小写十六进制文本：每字节转 16 进制并补足 2 位，再拼接。
// Array.from 的映射回调接收 (byte, index)，这里忽略 index。
function hexText(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 16 bytes as a UUID's text. */
// 把 16 字节先转成 32 位十六进制，再按 8-4-4-4-12 插入连字符。
// 模板字符串只是拼接；slice 参数是字符下标。
function uuid(bytes: Uint8Array): string {
	const text = hexText(bytes);
	return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
