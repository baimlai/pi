// 从会话用量估算提示词缓存未命中的额外token/费用，供提示和统计展示；这是相邻请求用量启发式，不读取供应商真实缓存内容。
// 压缩/分支摘要重置比较基准，模型切换仍可计入；这里不会执行压缩或发起预热。
// 只使用assistant消息的类型、用量、模型和时间字段，不导入网络客户端。
import type { AssistantMessage } from "@earendil-works/pi-ai";
// 条目type/role决定如何处理摘要边界、预热用量和assistant。
import type { SessionEntry } from "./session-manager.ts";

/**
 * Prompt-cache TTL: idle gaps longer than this are worth mentioning as the
 * likely cause of a miss. Anthropic's default cache TTL is 5 minutes.
 */
// 五分钟是当前代码用于提示的固定阈值；不是向所有供应商配置真实TTL，本文件计算未命中时也不据它直接判定。
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** Per-turn misses at or below this are cache breakpoint granularity noise. */
// 仅超过1024 token才计一次miss；等于1024也忽略。
const NOISE_FLOOR_TOKENS = 1024;

/** A counted cache miss on a single assistant message. */
// 一次被计入的缓存未命中说明。
export interface CacheMiss {
	/** Prompt tokens that were in the previous turn's prompt but not read from cache. */
	// 按相邻prompt大小与本次cacheRead差值估算的token量，不是逐token文本比对结果。
	missedTokens: number;
	/** Extra dollars paid vs. a full cache hit; 0 when pricing is unknown. */
	// 估计相比按缓存读收费多花的费用，差价下限截为0。
	missedCost: number;
	/** Milliseconds since the previous request (which last refreshed the cache). */
	// 有效时间戳下取当前消息与上次基准的非负差；无效日期可能得到NaN，不是精确网络空闲测量。
	idleMs: number;
	/** True when the model changed relative to the previous request. */
	// provider/model身份是否变化，用来解释可能原因，不直接决定是否计费。
	modelChanged: boolean;
}

// 整个扫描区间累加结果。
export interface CacheWasteTotals {
	// 所有被计入miss的估算token之和。
	missedTokens: number;
	// 所有miss估算额外费用之和。
	missedCost: number;
	/** Number of counted misses (turns above the noise floor). */
	// 超过噪声门槛的消息次数，不是所有请求次数。
	missCount: number;
}

/** Minimal pricing lookup, satisfied by ModelRuntime. Cost is $/million tokens. */
// 只需要缓存读价格的最小结构接口，调用者可用ModelRuntime满足它。
export interface ModelPriceSource {
	// 查不到模型可返回undefined；费用单位是每百万token，下面转换成每token。
	getModel(provider: string, modelId: string): { cost: { cacheRead: number } } | undefined;
}

/** The last request seen by the scan; everything in its prompt should be cached. */
// 当前扫描最后一个可作基准的请求，不是缓存本身。
interface PreviousRequest {
	// 普通输入+缓存读+缓存写，不包含输出。
	promptTokens: number;
	// provider/model复合键。
	modelKey: string;
	// 该消息或预热条目的时间戳毫秒数。
	timestamp: number;
	/**
	 * Sticky: some earlier request in this scan segment reported cache activity.
	 * Distinguishes a total miss on a cache-read-only provider (OpenAI-style,
	 * writes unreported) from a provider that never reports caching at all.
	 */
	// 黏住此前是否见过缓存活动，直到摘要边界重置；不能简单把本轮cacheRead=0解释成不支持缓存。
	reportedCache: boolean;
}

/**
 * Compute the cache miss for one assistant message relative to the previous
 * request. Returns undefined when nothing is counted: first turn, after a
 * reset, no cache activity ever reported (provider without cache support), or
 * miss below the noise floor.
 */
/**
 * 与前一个基准比较，计算单条assistant的估算缓存miss或undefined；不改消息/模型目录。
 * 例：前一prompt有100k、本轮110k、cacheRead=0，且已有缓存活动证据，则估算miss=100k；少于等于1024不计。
 * 成本使用消息记录的目录分项估算值；即使cost.total来自供应商账单，这里也没有读取total，只以分项估算成本反推单价。
 */
function detectMiss(
	prev: PreviousRequest | undefined,
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	// 复用消息已记录的用量，不发请求重新取得。
	const usage = message.usage;
	// 本次prompt总量只加三个输入桶。
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	// A zero-cache turn only counts when cache activity was reported before:
	// on cache-read-only providers that is a total miss, while on providers
	// that never report caching it means nothing.
	// 无前基准、当前prompt非正，或从未有缓存活动且本轮也没缓存数据，都不计miss。
	if (!prev || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) {
		// 返回undefined表示不计入，而不是构造一个missedTokens=0的事件。
		return undefined;
	}

	// 以两轮prompt较小值近似应复用内容，再扣本轮实际缓存读取量；并未比较文本前缀。
	const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
	// 包括负数/零/1024都跳过，避免缓存粒度造成提示噪声。
	if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

	// Extra cost = missed tokens billed at the actual paid rate (input/cacheWrite,
	// incl. write premium) instead of the cache-read rate. Missed tokens can only
	// land in the input or cacheWrite buckets, so the paid rate comes straight
	// from this message's own cost breakdown.
	// 普通输入和缓存写被视为这次按非缓存读方式支付的token。
	const paidTokens = usage.input + usage.cacheWrite;
	// 按这两桶记录的分项估算成本算加权每token费用；paidTokens<=0时为0，避免除零。
	const paidPerToken = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
	// 缓存读单价优先用本条分项估算成本除以读token反推，没有读取量才借当前模型标价。
	const readPerToken =
		// 有缓存读token才能从本条cacheRead分项估算成本反推单价。
		usage.cacheRead > 0
			? // 用记录的缓存读估算成本除读token，不使用供应商实报总费用。
				usage.cost.cacheRead / usage.cacheRead
			: // 没有本次读数据则查当前目录标价；缺模型按0，最后除百万换算单位。
				(models.getModel(message.provider, message.model)?.cost.cacheRead ?? 0) / 1_000_000;

	// 返回一条可展示的估算说明。
	return {
		// 保留算出的超门槛token数。
		missedTokens,
		// 只计非负估算差价；即使分项推算价低于缓存读价也不报告负额外费用。
		missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
		// 有效时间倒退时截0；不验证可信/单调，也不消除Date.parse可能产生的NaN。
		idleMs: Math.max(0, message.timestamp - prev.timestamp),
		// 比较provider/model字符串，本处不使用responseModel字段。
		modelChanged: `${message.provider}/${message.model}` !== prev.modelKey,
	};
}

/**
 * 把assistant用量转成下轮比较基准，prompt非正时返回undefined；不修改消息。
 * 例：本轮没有缓存读写但传入reportedCache=true，结果仍保持true，支持下一轮识别全miss。
 */
function asPreviousRequest(message: AssistantMessage, reportedCache: boolean): PreviousRequest | undefined {
	// 读取该消息用量。
	const usage = message.usage;
	// 构造输入总token。
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	// 空prompt不建立新基准。
	if (promptTokens <= 0) return undefined;
	// 返回新的基准对象。
	return {
		// 保留prompt规模。
		promptTokens,
		// 模型身份在此也用消息model，不用物理路由补充字段。
		modelKey: `${message.provider}/${message.model}`,
		// 消息timestamp作为下一轮时间基准。
		timestamp: message.timestamp,
		// ||使历史true保持；本轮cacheRead或cacheWrite任一为正也开启缓存活动证据。
		reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0,
	};
}

/**
 * 顺序扫描给定entries，返回最后基准、累计结果和按assistant对象引用索引的miss表。
 * 例：压缩后第一条回复没有旧基准，不计因新摘要产生的miss；模型切换不重置。只读输入，新建Map与累计对象；调用者负责选取要扫描的分支。
 */
function scan(
	entries: SessionEntry[],
	models: ModelPriceSource,
): { prev: PreviousRequest | undefined; totals: CacheWasteTotals; misses: Map<AssistantMessage, CacheMiss> } {
	// 前基准初始undefined，首轮因此不报告miss。
	let prev: PreviousRequest | undefined;
	// 创建全零累计器。
	const totals: CacheWasteTotals = { missedTokens: 0, missedCost: 0, missCount: 0 };
	// Map以消息对象身份作键，相同内容的另一对象不是同一个键。
	const misses = new Map<AssistantMessage, CacheMiss>();

	// 按调用方给定顺序扫描，不在这里排序时间或展开会话树。
	for (const entry of entries) {
		// 压缩和分支摘要表示上下文结构变化，不把摘要后的新prompt算作旧内容重新收费。
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			// The context legitimately changed; the next turn's prompt is new content,
			// not re-billed content. Model switches are NOT exempt: they re-bill the
			// full prompt and should be counted.
			// 清除先前比较基准及其黏住的缓存活动证据。
			prev = undefined;
			// 边界条目本身不当作assistant请求处理。
			continue;
		}
		// 仅kind=cache_warm的独立usage作为刷新缓存的请求基准；其他usage不在此参与。
		if (entry.type === "usage" && entry.kind === "cache_warm") {
			// 预热输入总量也使用三个主输入桶。
			const promptTokens = entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
			// 正prompt预热才更新基准，零用量不覆盖旧基准。
			if (promptTokens > 0) {
				// 预热基准不直接调用detectMiss，因此不累计其自身miss。
				prev = {
					// 记录预热prompt规模。
					promptTokens,
					// 预热条目的供应商与模型键。
					modelKey: `${entry.provider}/${entry.model}`,
					// 独立条目是ISO时间文字，用Date.parse转毫秒；这里不验证无效日期。
					timestamp: Date.parse(entry.timestamp),
					// 预热本身视为缓存活动证据，即使该条主桶没报告读写细分。
					reportedCache: true,
				};
			}
			// 普通assistant消息走检测路径，工具结果/用户消息不更新比较基准。
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			// 与当前prev比较得到本条miss或undefined。
			const miss = detectMiss(prev, entry.message, models);
			// 只有实际计入的miss才累计。
			if (miss) {
				// 累计估算漏读token。
				totals.missedTokens += miss.missedTokens;
				// 累计估算额外费用。
				totals.missedCost += miss.missedCost;
				// 次数加一，不按token数增加。
				totals.missCount += 1;
				// 以本条消息对象引用保存miss，方便重建界面时找到对应提示。
				misses.set(entry.message, miss);
			}
			// 有正prompt才替换prev，空prompt保留旧基准；传递已有reportedCache证据。
			prev = asPreviousRequest(entry.message, prev?.reportedCache ?? false) ?? prev;
		}
	}
	// 返回三个结果；公共包装器各取需要的一部分。
	return { prev, totals, misses };
}

/**
 * Cumulative cache waste across a session: prompt tokens that should have been
 * cache reads (they were in the previous turn's prompt) but were re-billed.
 */
/**
 * 计算给定条目的累计缓存miss估算，返回新统计对象；不改变entries，不输出提示。
 * 例：健康连续命中时三项均0；它仍完整扫描并构建内部miss Map，非增量缓存。
 */
export function computeCacheWaste(entries: SessionEntry[], models: ModelPriceSource): CacheWasteTotals {
	// 复用扫描逻辑，仅取totals。
	return scan(entries, models).totals;
}

/**
 * All counted cache misses across a session, keyed by the assistant message
 * (by reference) that paid for them. Used to re-derive transcript notices when
 * rebuilding the chat from entries (resume, post-compaction rebuild).
 */
/**
 * 返回每条被计入assistant对应的miss表，键是原消息引用，供恢复/重建聊天提示使用。
 * 例：map.get(entries中的同一message对象)可以命中，深拷贝对象则不会；每次调用重新扫描。
 */
export function collectCacheMisses(
	entries: SessionEntry[],
	models: ModelPriceSource,
): Map<AssistantMessage, CacheMiss> {
	// 返回此次扫描新建的misses Map，不持久缓存到模块全局。
	return scan(entries, models).misses;
}

/**
 * Detect a cache miss on a just-completed assistant message.
 * `entries` must not yet contain `message` (message_end fires before persistence).
 */
/**
 * 检测刚结束、尚未存进entries的一条assistant消息是否miss；返回说明或undefined。
 * 先扫描既有条目取得prev，再比较新message；调用者若把message预先包含进entries，基准会错误变成它自己。无真实缓存探测或网络副作用。
 */
export function detectCacheMiss(
	entries: SessionEntry[],
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	// 先取旧历史最后基准，再调用同一单消息检测函数。
	return detectMiss(scan(entries, models).prev, message, models);
}
