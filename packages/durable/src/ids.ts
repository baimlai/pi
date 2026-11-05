// 文件导读
// 所属：packages/durable（包名 @earendil-works/pi-durable）根级辅助模块，被 storage/、session/、harness/ 共同使用。
// 作用：把“已经由 ID 分配器或存储解码确认可信”的普通 number 在编译期打上品牌（brand），得到 Id<...> 或 Seq。
// 职责边界：只做类型断言，不分配编号、不检查整数/范围/来源、不访问存储；运行时返回的就是传入的同一个 number。
// 上游：storage/memory.ts、indexeddb.ts、sqlite 等在 mintId 或读取行后调用；session/session.ts 在解码后调用。
// 下游：仅依赖 types.ts 的 Id/Seq 品牌类型，没有其它内部依赖；错误路径不存在（不会抛错）。
// 能力清单：
// - idFromNumber<I extends Id<string>>(value): I：把可信数字标记为某种实体 ID（ConversationId/EntryId/TaskId 等）。
// - seqFromNumber(value): Seq：把可信存储序号标记为 Seq，避免开发时把实体 ID 误传到提交历史位置。
// 组合与典型顺序：Storage.mintId() 直接返回带品牌的 ID；从后端读出的裸数字先经 idFromNumber，再进入 Session/Tx；
// Storage.commit() 的 receive(index, seq) 回调给出已存储批次序号，测试/适配器用 seqFromNumber 标记它。
// 示例（类型示例；运行时只是普通数字）：
//   const id = idFromNumber<ConversationId>(7); // 类型为 ConversationId，运行时 id === 7
//   const seq = seqFromNumber(3);               // 类型为 Seq，运行时 seq === 3
// 阅读顺序：先看 types.ts 中 Id/Seq 的声明，再看这两个函数以及各自注释说明的调用边界。
import type { Id, Seq } from "./types.ts";

// ID 是带类型标记的普通 number：泛型 I 区分会话、条目、任务等编号，运行时没有包装对象。
// 输入应已由分配器或解码器确认可信；这里仅做类型断言，不分配编号、不检查整数，也不写存储。
// 例：idFromNumber<ConversationId>(7) 的运行时结果仍是数字 7；不可信数字应先在调用处校验。
// 给可信数字套上 ID 品牌。
// 输入：value 是调用方已经确认安全的普通 number（通常来自 mintId、存储行或测试常量）；泛型 I 由返回类型或显式类型参数决定。
// 输出：同一个 number，类型变成 I；没有副作用，不会抛错。
// 边界：这里不做 Number.isSafeInteger 等检查，因为“可信”由调用方保证；不可信输入应先在自己的解码边界校验。
// 示例：idFromNumber<ConversationId>(7) 在运行时仍是 7；把它传给需要 ConversationId 的 API 通过类型检查。
/** Apply an erased ID brand at a trusted numeric allocation or decoding boundary. */
export function idFromNumber<I extends Id<string>>(value: number): I {
	// as I 告诉 TypeScript 采用品牌类型，编译后这层断言被擦除。
	return value as I;
}

// 把可信存储序号标为 Seq，避免开发时把实体 ID 误传到提交历史位置；不校验、不递增、不产生副作用。
// 例：seqFromNumber(3) 返回运行时数字 3，品牌只帮助 TypeScript 检查后续调用。
// 给可信提交序号套上 Seq 品牌。
// 输入：来自 Storage.commit 的批次序号（本文件不验证来源）；输出：同一 number，类型为 Seq；无副作用、不抛错。
// 示例：seqFromNumber(12) 运行时返回 12；类型系统据此阻止把 EntryId 当作序号或反过来使用。
/** Apply the erased commit-sequence brand at a trusted storage boundary. */
export function seqFromNumber(value: number): Seq {
	// Seq 同样只有类型意义；调用者负责确保数字来自合法的存储序号。
	return value as Seq;
}
