// Hosts for Chord's layers: what the remote sides of links use of a host, its objects and references; what jobs use of
// a handler's ctx, the backoff and ids.

// 所属：packages/chord/src/host 的内部 barrel，仅供 Chord 其他层导入，应用代码不应依赖。
// 职责边界：只重导出协作层需要的宿主内部句柄，不定义运行时行为；export type 编译后擦除，值导出指向原实现。
// 上游：link、remote、jobs、registries 等 Chord 内部实现；下游：本文件列出的各实现文件。
// 能力清单：
// - PinnedKey：keyed 成员上被钉住（pin）的键句柄，供引用键与实例释放。
// - nextDelay：退避窗口的下一段延迟，由 Backoff 使用。
// - CallContext/Caller：调用上下文与调用者身份（principal + incarnation）。
// - AnyHost/ChordHost/Serving：宿主实现类型与 hold 落点结果。
// - ChordObject/Holder/Removal：宿主内对象、持有者接口、类型移除信息。
// - LIVE/LOADING/RefState：引用状态常量与联合，链接层据此编解码状态帧。
// - Attachable/Binding/CheckedParams/Followed/RetryWalk/retryWalk/Target：引用绑定、已检查参数、跟随结果与重试遍历。
// - UnboundRequest：尚未绑定、等待发布或提供者的请求。
// - uuidv7：时间有序 UUID，用于宿主 incarnation 与对象实例 id。
// 组合与典型顺序：远程层收到帧 -> 用 Caller/CallContext 还原调用 -> 找到 Host/ChordObject/Binding ->
// 读取或推进 RefState -> 通过 retryWalk 等工具重新放置。测试代码也通过该文件观察内部状态。
// 示例：import { LIVE, type RefState } from "./internal.ts";
//       const state: RefState = LIVE; // 只读快照，修改状态由 ReferenceState 完成
// 建议阅读顺序：先看 RefState 与 Binding，再看 ChordObject/Holder，最后按需查 uuidv7 与 retryWalk。

// keyed 成员上被钉住（pin）的键句柄。
export type { PinnedKey } from "./attempt.ts";
// 退避窗口的下一段延迟；由 Backoff 使用。
export { nextDelay } from "./backoff.ts";
// 调用上下文与调用者身份；jobs 和链接层用它构造调用。
export { CallContext, type Caller } from "./ctx.ts";
// 宿主实现类型（与对象终结类型）以及 hold 落点后的结果 Serving。
export type { AnyHost, ChordHost, Serving } from "./host.ts";
// 宿主内的对象、持有者接口，以及类型被移除后的 Removal 信息。
export type { ChordObject, Holder, Removal } from "./object.ts";
// 两个共享的状态常量与引用状态联合；链接层据此处理状态帧。
export { LIVE, LOADING, type RefState } from "./ref-state.ts";
// 引用绑定、已检查参数、跟随结果与重试遍历标记。
export {
	type Attachable,
	type Binding,
	type CheckedParams,
	type Followed,
	type RetryWalk,
	retryWalk,
	type Target,
} from "./reference.ts";
// 尚未绑定、等待发布或提供者的请求。
export type { UnboundRequest } from "./unbound.ts";
// 时间有序的 UUID，用于宿主 incarnation 和对象实例 id。
export { uuidv7 } from "./uuid.ts";
