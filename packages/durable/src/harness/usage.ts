// 会话用量账本：按模型/工具累计计数，随对应结果一起提交。
// 所属：packages/durable/src/harness，Durable 的会话用量账本。
// 上游：generation.ts 在记录模型回复的事务里按 `provider/model` 记录；tool.ts 在写工具结果时按工具名记录；
// compaction.ts 记录没有模型身份的摘要尝试；harness.usage 把所有已拥有会话的账本相加后返回。
// 下游：UsageDoc 是 conversation 作用域、latest 历史的文档，ConversationView 把它作为挂载文档读取。
// 累计本身在调用方事务内完成；本文件不提交事务，也不参与调度或重试；打开文档或复制 JSON 的异常向上抛。
// 能力清单：
// - UsageState：models/tools 两桶的严格 JSON 用量账本类型。
// - UsageDoc：`pi.usage` 文档令牌，每会话一份、只留最新、fork 从空账本开始。
// - recordUsage：在调用方事务内把一次 Usage 累加到指定桶。
// - addUsage：把一个 Usage 的计数与费用原地加到 Draft 或普通对象。
// - addUsageState：把一份账本的两桶合并进汇总账本。
// 组合与顺序：generation/tool/compaction 在写各自结果的同一事务里调 recordUsage；
// Harness.usage 用 initial() 造空汇总，再对每个已拥有会话的快照调 addUsageState；读取方从 UsageDoc 挂载拿到账本。
// 示例：await recordUsage(tx, conversationId, "models", "anthropic/claude", message.usage);
// 建议阅读顺序：先看 UsageState 与 UsageDoc 的作用域语义，再看 recordUsage 的“首见复制、再见相加”，
// 最后看 addUsage 与 addUsageState。
import type { Draft } from "@earendil-works/chord/delta";
import { copyJson, type JsonRepresentation } from "@earendil-works/chord/json";
import type { Usage } from "@earendil-works/pi-ai";
import { defineDoc } from "../documents.ts";
import type { ConversationId, Tx } from "../types.ts";

/** Ledger of one conversation's own spend: its entries, and compaction summarization attempts, which have none. */
// 账本只记“本会话自己花掉的”用量：助手回复、工具结果，以及没有模型归属的摘要尝试。
// 两桶的值都写成严格 JSON 形式的 Usage；编译期 JsonRepresentation 把字段递归映射为 JSON 形状，运行时没有形状校验。
export type UsageState = {
	// Record 是字符串键对象；JsonRepresentation 让可选值适配严格 JSON 文档。
	/** Assistant entries and summarization attempts, keyed `provider/modelId`. */
	models: Record<string, JsonRepresentation<Usage>>;
	/** Tool results, keyed by tool name; their usage has no model identity. */
	tools: Record<string, JsonRepresentation<Usage>>;
};

// defineDoc 只创建带类型的文档令牌，不立即访问存储。
// 定义会交给 validateDefinition：目前只检查 version 是正整数；kind/scope 的合法性由类型与后续地址解析约束。
export const UsageDoc = defineDoc<UsageState>({
	kind: "pi.usage",
	version: 1,
	// 每会话一份，只留最新账本；fork 从 initial 开始，不继承原会话支出。
	scope: "conversation",
	history: "latest",
	fork: "initial",
	// 初始化回调返回两个新空桶；checkpoint 回调允许每次变更保存完整值。
	initial: () => ({ models: {}, tools: {} }),
	checkpointWhen: () => true,
});

/** Add `usage` to one bucket of the conversation's `pi.usage`, in the commit that records the response. */
/**
 * 在 tx 内累计 conversationId 的某个用量桶；bucket 的 keyof 类型只允许 models/tools，key 是桶内身份。
 * 首次复制为严格 JSON，已有记录原地相加；不自行提交，tx.doc 或复制的异常向上传播。
 * 例：同模型 input 先为 3，再记录 4，事务内累计为 7，其他模型不变。
 */
export async function recordUsage(
	tx: Tx,
	conversationId: ConversationId,
	bucket: keyof UsageState,
	key: string,
	usage: Usage,
): Promise<void> {
	// await 打开可变草稿，然后按 bucket 取目标桶。
	// bucket 的类型是 keyof UsageState（"models" | "tools"），因此 [bucket] 在编译期就收窄为对应 Record。
	const totals = (await tx.doc(UsageDoc, conversationId))[bucket];
	// Own keys only: a tool may be called `toString`.
	// 只认自有属性，避免把原型上的 toString 当已有用量。
	const total = Object.hasOwn(totals, key) ? totals[key] : undefined;
	// Providers may leave optional counters `undefined`; drafts take strict JSON.
	// 首次复制时去掉 undefined；as 是类型断言，实际 JSON 复制/校验由 copyJson 做。
	if (total === undefined)
		totals[key] = copyJson(usage, { omitUndefinedProperties: true }) as JsonRepresentation<Usage>;
	// 已有桶的草稿原地累计，由外部事务跟踪修改。
	else addUsage(total, usage);
}

/** Add every counter of `usage` to `total`; optional counters are added once either side reports them. */
/**
 * 将 usage 的计数与费用原地加到 total，返回 void；目标可以是文档 Draft 或普通 Usage。
 * 不校验数值或计算价格；例：output 为 2 再加 5 得 7。可选计数仅在本次提供时相加。
 */
export function addUsage(total: Draft<Usage> | Usage, usage: Usage): void {
	// 联合类型 Draft<Usage> | Usage：前者是事务草稿，后者是调用方自备的累计对象；这里只用两者的共同形状。
	// 这里假定 usage.cost 及其子字段存在：Usage 类型在编译期要求它们，运行时不再逐项检查。
	// += 读旧值再写回和；这五项分别累计输入、输出、缓存读写和总 token。
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	// undefined 是未报告，不能强制补零；一旦本次有值，目标缺省值按 0 参与相加。
	if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	// cost 是独立的费用明细，按提供者给出的数值累计，不重新根据 token 单价推算。
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
}

/** Add every bucket of `state` into `sum`. */
/**
 * 将 state 的两桶合并进 sum：已有键相加，首次键克隆用量；修改 sum 而不修改输入 state。
 * 例：两个会话的 read 工具用量合到 sum.tools.read；结构克隆失败会直接抛出。
 */
// 典型调用：Harness.usage 先用 UsageDoc.definition.initial() 造出空 sum，再逐个已拥有会话合并。
// Readonly<UsageState> 是浅只读：禁止通过该参数替换两个桶，但桶内记录本函数也不会改动。
export function addUsageState(sum: UsageState, state: Readonly<UsageState>): void {
	// as const 保留 models/tools 字面量类型，bucket 因此可安全索引 UsageState。
	for (const bucket of ["models", "tools"] as const) {
		// entries 遍历自有可枚举属性，解构为键与其用量。
		for (const [key, usage] of Object.entries(state[bucket])) {
			// 原型上的同名属性不算已存在记录。
			const total = Object.hasOwn(sum[bucket], key) ? sum[bucket][key] : undefined;
			// Define rather than assign: assigning a tool named `__proto__` would set the prototype.
			if (total !== undefined) addUsage(total, usage);
			// 显式定义数据键可安全保存 __proto__；克隆防止之后累加 sum 时改动 state。
			else
				Object.defineProperty(sum[bucket], key, {
					value: structuredClone(usage),
					enumerable: true,
					writable: true,
				});
		}
	}
}
