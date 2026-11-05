// 文件导读（Durable 测试工具层：单批提交包装）
//
// 所属模块：packages/durable/src/testing，从 "@earendil-works/pi-durable/testing" 导出。
// 上游：存储契约套件（storage-conformance.ts）、基准数据生成（storage-benchmark.ts）以及各后端
// 测试；下游：Storage.commit（packages/durable/src/types.ts 的存储边界）。
//
// 职责边界：Storage.commit 接收"多个批次"并返回 CommitResult；很多测试只想写一个批次。
// commitWrites 把一次写入包成一个批次，取回回执序号；若存储拒绝该批次则抛出拒绝原因。
// 它不发布、不重试、不检查记录语义——这些由 Storage 层负责。
//
// 能力清单：
// - commitWrites(storage, writes, context)：提交一个批次并返回其 Seq。
//
// 典型调用：
//   const seq = await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
// 失败时（例如 ID 已被占用）该调用抛错，而不是返回 stored=0。
//
// 建议阅读顺序：先看 Storage.commit 的契约（src/types.ts）→ 本函数 → 契约套件中的调用点。
// One batch through `Storage.commit()`, for tests and suites that seed or write a storage directly.

// 仅类型导入 Context：提交上下文负责取消信号与追踪传播，本函数只把它透传，不读取字段。
import type { Context } from "@earendil-works/chord/context";
// Seq 是带品牌的数字（编译期区分提交序号与实体 ID）；Storage 是存储接口；
// StorageWrite 是表记录与文档命令的判别联合。
import type { Seq, Storage, StorageWrite } from "../types.ts";

// 提交一个批次并等待其持久化。
// 输入：storage（目标存储）、writes（同一批次内的写入数组）、context（取消与追踪上下文）。
// 输出：该批次持久化后 Storage 分配/返回的提交序号 Seq。
// 副作用：向存储写入数据；不进行额外的发布或缓存更新。
// 错误：Storage 拒绝该批次时抛出 result.refused（通常是 Error）；存储本身抛错时原样向上抛。
// 主流程：构造只含一个批次的数组 → 在 receive 回调里记下序号 → 若 stored 为 0 抛出拒绝原因 → 返回序号。
// 例子：commitWrites(storage, [{ type: "entry", value: record }], BACKGROUND_CONTEXT) 返回新 Seq。
/** Commits `writes` as one batch and resolves with its seq; rejects with the refusal if the storage refused it. */
export async function commitWrites(storage: Storage, writes: readonly StorageWrite[], context: Context): Promise<Seq> {
	// receive 是 Storage 在批次持久化后同步调用的回执回调；序号先存到这里，
	// 因为 commit 的返回值只有批次数量，不直接包含 Seq。
	// 类型写成 Seq | undefined 是因为 TypeScript 无法从回调契约推断它一定被赋值；
	// 下面的非空断言依赖 Storage 的"成功批次必回调一次"保证。
	let stored: Seq | undefined;
	// commit 接收批次数组，因此这里用 [writes] 再包一层，表示"只有一个批次"。
	// await 之后所有已接收批次都已持久化；拒绝（stored === 0）不会抛异常，而是放在返回结果里。
	const result = await storage.commit(
		// 单个批次内部仍是普通 StorageWrite 数组；原子性由 Storage 对该批次保证。
		[writes],
		// 回调参数 index 是批次下标；单批次场景用不到，所以命名为 _index 表示有意忽略。
		(_index, seq) => {
			// 同步记录回执序号；Storage 契约保证在 commit 结算前完成所有 receive 调用。
			stored = seq;
		},
		context,
	);
	// stored 为 0 表示这个批次被 Durable 自身的检查拒绝（例如重复 ID、文档动作非法、
	// 复制源无法解析），写入没有生效。refused 的类型是 unknown，直接 throw 保留原始原因。
	if (result.stored === 0) throw result.refused;
	// ! 是非空断言：经过上面的 stored === 0 分支后，成功路径上 stored 必已由 receive 赋值。
	// 这只是编译期提示，不会在运行时检查；若存储违反契约，返回值会是 undefined。
	return stored!;
}
