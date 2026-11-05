// Links for Chord's layers: a host's end of a link (handshake, codec, checks, heartbeat and in-order handling), the
// message type, parts with their limits and compression, and errors in messages.

// 文件导读
// 所属模块：packages/chord/src/link 的内部入口（barrel），仅供 Chord 自身的 host/remote 层使用，
// 不是应用 API（应用入口是 index.ts）。
// 职责与边界：再导出链路层的完整内部能力：Channel、消息类型、Part 处理、错误转换、两种 Codec。
// 不执行握手/编解码/解析；不隐藏任何实现逻辑，只是稳定内部依赖路径。
// 上游入口：host/remote 源码从这里导入；外部应用不应使用。
// 下游依赖：binary.ts、channel.ts、errors.ts、link.ts、message.ts、part.ts、text.ts、values.ts。
// 结果与错误流向：导入无副作用；函数行为与错误由原模块决定。
// 能力清单（按导出项）：
// - binaryCodec：默认二进制 Codec。
// - Channel / ChannelHandler：链路状态机与宿主回调接口。
// - errorFromWire / wireError：错误线格式的双向转换。
// - Link：链路接口（仅类型，用于 host 持有连接）。
// - BoundEntry / ConsumerMessage / FailedMember / Message / OriginMessage / ProviderMessage / StateEntry /
//   WireAddress / Codec：协议消息相关类型（仅类型）。
// - CHAIN / NO_RETIRED / RETRY_HOPS / checkMessage：协议常量与信封检查。
// - Compression / DeflatedPart / Limits / Part / PartLimits：Part 类型、上限与压缩器接口；
//   inflateAsync / linkLimits / openPart / originPart / oversized：压缩、上限合并与 owner 端打开。
// - describeMessage / textCodec：文本 Codec 与调试表示。
// - jsonPart / partText / parsePart / parsePayload / payloadPart：值与 Part 的转换辅助。
// 典型调用顺序：host 先从 index.ts 的适配器工厂（ipcLink/webSocketLink/memoryLinkPair）得到 Link
// -> new Channel(...).start() -> handler 收到 Message -> openPart 打开载荷 -> parsePayload 得到业务值；发送侧 payloadPart/originPart 反向。
// 注意：本文件只再导出传输抽象 Link，不导出上面这些具体适配器工厂。
// 示例：import { Channel, binaryCodec, openPart, linkLimits } from "./internal.ts";
//       const channel = new Channel(link, handler, { codec: binaryCodec, incarnation, calls: 256, trusted: false, report }, context);
//       const json = openPart(part, linkLimits(false), compression, context);
// 建议阅读顺序：Message/Codec -> Channel/ChannelHandler -> Part 相关类型与 openPart/linkLimits -> 错误转换
// -> values 辅助函数。
export { binaryCodec } from "./binary.ts";
export { Channel, type ChannelHandler } from "./channel.ts";
export { errorFromWire, wireError } from "./errors.ts";
export type { Link } from "./link.ts";
export {
	type BoundEntry,
	CHAIN,
	type Codec,
	type ConsumerMessage,
	checkMessage,
	type FailedMember,
	type Message,
	NO_RETIRED,
	type OriginMessage,
	type ProviderMessage,
	RETRY_HOPS,
	type StateEntry,
	type WireAddress,
} from "./message.ts";
export {
	type Compression,
	DeflatedPart,
	inflateAsync,
	type Limits,
	linkLimits,
	openPart,
	originPart,
	oversized,
	type Part,
	type PartLimits,
} from "./part.ts";
export { describeMessage, textCodec } from "./text.ts";
export { jsonPart, parsePart, parsePayload, payloadPart } from "./values.ts";
