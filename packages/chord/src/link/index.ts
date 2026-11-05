// Links for apps: the link interface adapters implement, the in-memory pair, IPC and WebSocket links, the codecs a link
// may use, its limits per part and the compressor a host may bring.

// 文件导读
// 所属模块：packages/chord/src/link 的公开应用入口（barrel），把链路层稳定 API 汇总到一处。
// 职责与边界：只做再导出，不包含业务函数、不复制对象、不建立连接；应用不应依赖更深层文件路径，
// 而应从这里导入，以便内部重构时保持入口稳定。
// 上游入口：使用 Chord 的应用或 host 配置代码 import 本文件。
// 下游依赖：binary.ts、text.ts、link.ts、ipc.ts、websocket.ts、message.ts、part.ts。
// 结果与错误流向：导入本身无运行时副作用；各导出对象的行为与错误由其原模块决定。
// 能力清单（按导出项）：
// - binaryCodec：默认二进制 Codec，紧凑、不可读。
// - ipcLink / IpcPort：Node IPC 适配器及其结构化端口类型。
// - Link / memoryLinkPair：传输接口与同进程内存双端。
// - Codec / Message：编解码接口与协议消息联合类型（仅类型）。
// - Compression / Inflated / PartLimits：压缩器接口、解压结果与每 part 上限（仅类型）。
// - describeMessage / textCodec：文本 Codec 与消息的元组文本表示，主要用于调试。
// - WebSocketLike / webSocketLink：WebSocket 适配器及其结构化 socket 类型。
// 典型调用顺序：取 memoryLinkPair()/ipcLink()/webSocketLink() 得到 Link -> 交给 Channel（内部入口）-> 用 binaryCodec
// 或 textCodec 编解码；大小上限通过 PartLimits 传给 host 的 connect/accept 配置，而非本文件函数。
// 示例：import { memoryLinkPair, binaryCodec } from "./link/index.ts";
//       const [hostEnd, childEnd] = memoryLinkPair();
//       // 两个 Link 分别交给两个 Channel，双方 codec 都选 binaryCodec。
// 建议阅读顺序：Link/memoryLinkPair（link.ts）-> binaryCodec 或 textCodec -> ipcLink/webSocketLink 适配器
// -> Compression/PartLimits 等配置类型。
export { binaryCodec } from "./binary.ts";
export { type IpcPort, ipcLink } from "./ipc.ts";
export { type Link, memoryLinkPair } from "./link.ts";
export type { Codec, Message } from "./message.ts";
export type { Compression, Inflated, PartLimits } from "./part.ts";
export { describeMessage, textCodec } from "./text.ts";
export { type WebSocketLike, webSocketLink } from "./websocket.ts";
