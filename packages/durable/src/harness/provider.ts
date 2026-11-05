// 所属：packages/durable/src/harness，Durable Harness 的 provider 会话身份模块。
// 解决的问题：模型提供商（例如 Codex）用 sessionId 做提示缓存与会话亲和；同一会话的连续请求必须拿到同一个身份，
// 而 fork 出来的新会话必须换新身份，不能继承父会话的缓存上下文。
// 职责边界：只持久化一个 { sessionId } 的会话级文档并读取它；不发起模型请求，不拼请求体，不处理网络重试。
// 上游：generation.ts、compaction.ts 在构造请求选项时调用 ensureProviderSessionId(runtime, context)。
// 下游：documents.ts 的 defineDoc，以及 Session 的 snapshot/commit（经 TaskRuntime 暴露）；uuidv7 生成时间有序的 UUID。
// 结果与错误：正常返回 string；存储读失败或事务失败按原错误向上传播；事务成功却没拿到值时显式抛错。
// 能力清单：
// - ProviderState：只含 sessionId 的文档数据形状，只是编译期类型，运行时不会校验字段。
// - ProviderDoc：会话作用域、latest 历史、fork 时重新执行 initial 的文档定义。
// - ensureProviderSessionId：先只读快照，缺失时在一个迁移事务里创建并返回身份。
// 组合关系：generation/compaction 调 ensureProviderSessionId → runtime.snapshot 读 ProviderDoc →
// 缺失则 runtime.commit → tx.doc 触发 initial → 返回身份并放进模型请求的 sessionId。
// 示例：const sessionId = await ensureProviderSessionId(runtime, context);
//   // 同一会话第二轮返回同一值；旧会话首次调用会多出一条创建提交。
// 建议阅读顺序：先看 ProviderState 与 ProviderDoc 各字段含义，再看 ensureProviderSessionId 的读取、迁移、返回三段。
// 测试：test/harness-compaction.test.ts 覆盖文档读写；test/provider-session-cache-e2e.test.ts 是需真实凭证的 e2e（通常跳过）。
// type 导入只取类型，编译后被抹除，运行时不加载该模块。
import type { Context } from "@earendil-works/chord/context";
// uuidv7 生成按时间递增的 UUID，适合做可排序的持久身份；导入的是函数值，不是类型。
import { uuidv7 } from "@earendil-works/pi-ai/utils/uuid";
// defineDoc 注册文档定义，返回带类型的文档令牌；它只校验版本号，不在创建时执行 initial。
import { defineDoc } from "../documents.ts";
// TaskRuntime 是任务处理函数拿到的运行时接口；这里只需它的 snapshot/commit 与 conversationId。
import type { TaskRuntime } from "../types.ts";

/** Stable provider-facing identity of one conversation. */
// 仅保存供提供商识别会话的字符串；这是 TypeScript 数据形状，不是运行时字符串校验器。
// 之所以单独成文档而不是塞进 pi.agent，是为了让身份独立于用户可配置的 agent 状态，fork 时也能整体重置。
export type ProviderState = {
	sessionId: string;
};

/** Built-in provider state; every fork starts with a fresh identity instead of copying its parent. */
// 会话级内置文档，只保留最新状态；fork: initial 使分叉调用 initial 创建新的 UUID，而非沿用父会话身份。
// defineDoc<ProviderState> 的泛型把文档值类型固定为 ProviderState；返回的 ProviderDoc 是令牌，供 snapshot/tx.doc 使用。
export const ProviderDoc = defineDoc<ProviderState>({
	// kind 是持久化文档类型名，写入存储后标识这份文档。
	kind: "pi.provider",
	// version 用于文档模式迁移；本定义只接受正整数版本。
	version: 1,
	// scope: "conversation" 表示每个会话一份，读写时必须再给 conversationId。
	scope: "conversation",
	// history: "latest" 只保留最新值，不积累可回放的增量历史。
	history: "latest",
	// fork: "initial" 让新分叉从 initial() 重新生成，而不是复制源会话的值。
	fork: "initial",
	// 首次创建文档时产生身份；不是每次 snapshot 都生成新值。
	initial: () => ({ sessionId: uuidv7() }),
	// 每次可检查点化，避免为这个小状态积累增量历史。
	checkpointWhen: () => true,
});

/**
 * Return the persisted identity without writing in the normal path. A legacy conversation without `pi.provider` gets
 * one migration commit whose `tx.doc()` runs `initial()` before the provider request starts.
 */
// 输入任务运行时和取消上下文，返回持久化会话身份；先只读，旧会话缺文档时再提交创建。
// 示例：同一会话连续请求返回同一个 sessionId；首次迁移会写存储。读写错误向上传播，提交未取得值时显式报错。
// 四个泛型与 TaskRuntime<I, S, R, H> 对应：I 输入、S 状态、R 结果、H 钩子；H 约束为 object 是运行时接口的要求。
// context 携带取消信号；这里的 await 在取消时按 Chord 的上下文规则拒绝。
export async function ensureProviderSessionId<I, S, R, H extends object>(
	runtime: TaskRuntime<I, S, R, H>,
	context: Context,
): Promise<string> {
	// snapshot 只读已存在文档，不为了查询而创建。
	const existing = await runtime.snapshot(ProviderDoc, runtime.conversationId, context);
	// 正常路径直接复用持久值，避免每轮请求额外提交。
	if (existing !== undefined) return existing.sessionId;
	// 回调跨 await 写入外层变量；联合类型表示提交前还没有结果。
	let created: string | undefined;
	// 文档缺失时在事务里访问 doc，触发 ProviderDoc.initial；提交成功后身份才可供请求使用。
	// commit 的回调必须返回 undefined（本调用不需要业务返回值），写入随事务一起成功或失败。
	await runtime.commit(async (tx) => {
		// tx.doc 返回事务草稿，此处只读取初始化后的 sessionId。
		created = (await tx.doc(ProviderDoc, runtime.conversationId)).sessionId;
		// 事务回调本身不返回业务值，结果通过 created 带出。
		return undefined;
	}, context);
	// 也让 TypeScript 将下一行 created 收窄为 string；这是未获得事务结果的错误路径。
	// 正常情况下提交成功必定赋值，因此这里只是把不可能状态变成显式错误，避免返回 undefined。
	if (created === undefined) throw new Error(`Conversation ${runtime.conversationId} has no provider session ID`);
	// 返回本次已成功提交的身份。
	return created;
}
