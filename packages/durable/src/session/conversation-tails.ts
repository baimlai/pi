// 文件导读：Durable Session 的会话尾部缓存
//
// 所属包与模块：packages/durable/src/session，Durable（@earendil-works/pi-durable）的 Session 内核。
// 本文件只维护每个会话的最新 entry ID 和最新 head 标记（上下文范围标记），让 Session 读取尾部时尽量不访问
// Storage；它不拥有会话、不提交批次，也不负责持久化。“可见的最新条目”可能是会话自己的最新条目，也可能是
// 分叉会话没有自己的条目时，父会话在分叉点的条目。
//
// 上游入口：Session（src/session/session.ts）在 Writer 的 stored 回调里调用 apply(writes)，把已经存入后端的
// 一批 StorageWrite 同步进缓存；读取尾部时调用 latest()/marker()，未命中则用传入的 read 回调访问 Storage。
// Session 会先 touch 相关键，等未发布的提交写入完成后才读取，因此缓存结果不会读到过期的后端状态。
// 下游依赖：只依赖 src/types.ts 的 ConversationId、EntryId、EntryRecord、StorageWrite 类型；不直接 import
// Storage，读操作由调用方以回调注入，时序控制留在 Session。
// 错误流向：read 回调拒绝时，latest()/marker() 的 Promise 原样拒绝且不写缓存；本地 Map 操作不产生业务错误。
//
// 能力清单：
//   - HeadMarker：EntryRecord 与“必有 head”的交叉类型，表示带上下文范围标记的条目。
//   - ConversationTails：缓存主体。latest() 查最新条目 ID；marker() 查截止点（含）前的最新 head 标记；
//     peek() 同步查看最新条目 ID 的三态值；apply() 在提交 stored 后更新缓存；size/markers 供测试观察缓存数量。
//   - LATEST_CAPACITY / MARKER_CAPACITY（文件私有）：两个 LRU 的容量上限（ID 缓存 4096 个会话，完整标记记录
//     缓存 256 个会话）。
//   - use/put（文件私有）：Map 的 LRU 读写辅助；freeze（文件私有）：递归冻结缓存记录。
//
// 典型用法（示例）：
//   const tails = new ConversationTails();
//   tails.apply([{ type: "entry", value: entry }]); // entry 是本批已写入的 EntryRecord
//   const newest = await tails.latest(entry.conversationId, () => Promise.resolve(undefined));
//   // 这次调用会命中 apply 刚缓存的 entry.id，传给 latest 的 read 不会执行。
//   const marker = await tails.marker(entry.conversationId, entry.id, () => Promise.resolve(undefined));
//   注意：缓存内部用 null 表示“已查询且不存在”，用 undefined 表示“尚未查询”；latest()/marker() 对调用方仍
//   返回 undefined，而不是 null。
//
// 建议阅读顺序：先读 HeadMarker 与两个容量常量，理解“ID 便宜、完整标记贵”的取舍；再读 ConversationTails
// 的字段与 latest()/marker() 的命中规则；随后读 apply() 看提交写入如何维护缓存；最后读文件底部的
// use/put/freeze 三个纯函数。
//
// ---------------------------------------------------------------------------
// The newest entry and newest head marker of each recently used conversation, kept current from the Session's commits.
import type { ConversationId, EntryId, EntryRecord, StorageWrite } from "../types.ts";

// `&` 是交叉类型：既要有完整 EntryRecord 字段，也保证 head 一定存在；它不会在运行时检查传入对象。
/** An entry that carries a `head`: the marker of a context range. */
export type HeadMarker = EntryRecord & { readonly head: EntryId };

// 每个会话只缓存一个 EntryId，容量按会话数而不是条目数计算；4096 个会话之外的旧项由 LRU 淘汰。
// 淘汰只影响缓存命中率：下次 latest() 会重新用 read 查 Storage，不会丢失数据。
/** Conversations whose newest entry ID is kept: IDs only, so many. */
const LATEST_CAPACITY = 4096;

// head 标记缓存的是整条 EntryRecord（可能包含 model 消息或 data 负载），比 ID 贵得多，因此容量只给 256。
// 压缩摘要等条目也可能成为标记；未命中时 marker() 会带截止条件重新查询 Storage。
/** Conversations whose newest head marker is kept: whole entries (a compaction summary is one), so fewer. */
const MARKER_CAPACITY = 256;

// 会话尾部缓存：Session 拥有自己的 Storage 时，本类让最新条目和最新 head 标记的读取尽量命中内存。
// 两个 Map 都以 ConversationId 为键；键不存在表示尚未查询，值为 null 表示已查询且确实没有。
// apply() 只在提交已存入后端后同步更新；latest()/marker() 只在缓存无法回答时才调用注入的 read。
// 所有写入都经过 put() 维护 LRU，保证内存有界；实例归单个 Session 所有，不做跨实例共享。
/**
 * The newest entry ID and newest head marker per conversation, for the Session that owns its Storage: every entry is
 * written by one of its commits, so `apply` keeps both current, and a value read from Storage stays valid until the
 * next entry of that conversation. Read only on the Session line after touching the conversation's appends, so no
 * commit that appends to it is unpublished and a value read from Storage can be kept. The newest entry visible from a conversation is its own newest, or for a fork without entries
 * of its own the parent's entry at the fork point: IDs grow, so a conversation's own new entry is always the newest.
 * Each map is bounded by a count, the least recently used conversation leaving first. Kept markers are frozen: entry
 * records are immutable (`Tx.appendEntry()`).
 */
export class ConversationTails {
	// Map 的 undefined 表示未缓存；显式存 null 表示已查过且没有，避免反复访问 Storage。
	/** Newest entry ID per conversation, `null` for none. */
	readonly #latest = new Map<ConversationId, EntryId | null>();
	/** Newest head marker per conversation, `null` for none. */
	readonly #markers = new Map<ConversationId, HeadMarker | null>();

	/** The newest entry ID visible from `conversationId`, read with `read` when not known. */
	// 按会话查最新条目ID；命中时刷新使用顺序，未命中才调用异步read并缓存结果。
	// 返回ID或undefined，不写Storage；read拒绝时原样向外拒绝且不缓存。例如首次读到7，第二次直接返回7。
	async latest(
		conversationId: ConversationId,
		read: () => Promise<EntryId | undefined>,
	): Promise<EntryId | undefined> {
		// use会把命中的会话移到Map末尾，作为最近使用项。
		const known = use(this.#latest, conversationId);
		// `??`只把null/undefined替换掉；这里null还原为公共API的undefined。
		if (known !== undefined) return known ?? undefined;
		// 等待调用方真正读存储；await失败会使本async方法的Promise拒绝。
		const latest = await read();
		// null是“没有条目”的缓存哨兵，并按会话数量限制缓存。
		put(this.#latest, conversationId, latest ?? null, LATEST_CAPACITY);
		// 向调用方保留read原来的可选ID结果。
		return latest;
	}

	/**
	 * The newest visible head marker at or before `atOrBefore` (any when `undefined`), read with `read` when not known.
	 * The newest marker answers every cutoff at or after it, and no marker answers every cutoff.
	 */
	// 查指定会话在截止ID（含）以前的最新head标记；read必须对应本次截止条件。
	// 只在读的是当前尾部时更新全局最新标记缓存，防止历史查询覆盖它；读取错误原样传播。
	// 例：已知标记ID为10，查询截止12直接返回它，截止8仍需读Storage。
	async marker(
		conversationId: ConversationId,
		atOrBefore: EntryId | undefined,
		read: () => Promise<HeadMarker | undefined>,
	): Promise<HeadMarker | undefined> {
		// 查询标记缓存并刷新其LRU顺序；null与undefined仍分别表示不存在和未知。
		const marker = use(this.#markers, conversationId);
		// 已知整个会话没有标记，则任意截止点都没有标记。
		if (marker === null) return undefined;
		// 最新标记落在请求范围内时即可回答；字符串/数字比较实际使用品牌ID的数字值。
		if (marker !== undefined && (atOrBefore === undefined || atOrBefore >= marker.id)) return marker;
		// 只peek最新条目，不改变它的使用顺序，用于判断本次历史读能否代表会话尾部。
		const latest = this.#latest.get(conversationId);
		// 缓存不能回答时由调用方执行匹配截止点的真实查询。
		const found = await read();
		// Only a read that no newer entry can change: no cutoff, or one at or after the newest entry.
		// 无截止点，或截止点已包含已知最新条目，查询才足以更新“最新标记”。
		if (atOrBefore === undefined || (latest !== undefined && (latest ?? 0) <= atOrBefore)) {
			// 已找到的条目递归冻结后共享；没找到以null缓存，容量按完整标记记录计。
			put(this.#markers, conversationId, found === undefined ? null : freeze(found), MARKER_CAPACITY);
		}
		// 即使是不能缓存的历史读，也将本次结果交给调用方。
		return found;
	}

	/** The newest entry ID of `conversationId` if known, without reading: `null` for none, `undefined` when unknown. */
	// 同步查看会话ID对应的三态值，不读Storage、不刷新LRU；例：未访问过的会话返回undefined。
	peek(conversationId: ConversationId): EntryId | null | undefined {
		// 直接返回Map中的ID/null，缺键时Map.get自然返回undefined。
		return this.#latest.get(conversationId);
	}

	/** At a commit's publication: apply a durable batch. */
	// 提交发布时按writes顺序更新尾部；只处理新根会话和entry，不执行存储IO，无返回值。
	// 例：同批先建根会话再append条目7，最终最新ID为7；分叉初值留待Storage按祖先关系查询。
	apply(writes: readonly StorageWrite[]): void {
		// readonly只限制此参数的TypeScript写法，不会自动冻结数组；这里只迭代不修改它。
		for (const write of writes) {
			// StorageWrite是由type区分的联合类型，此分支把value收窄成ConversationRecord。
			if (write.type === "conversation") {
				// A new root conversation sees no entries; a fork sees its parent's up to the fork point.
				// 分叉可继承父条目/标记，不能把它错记成空会话。
				if (write.value.parent !== undefined) continue;
				// 新根会话没有历史，分别记住“无条目”和“无head标记”。
				put(this.#latest, write.value.id, null, LATEST_CAPACITY);
				put(this.#markers, write.value.id, null, MARKER_CAPACITY);
				// entry分支中value被TypeScript收窄为不可变条目记录。
			} else if (write.type === "entry") {
				// 使用局部名字方便连续访问同一记录，不复制对象。
				const entry = write.value;
				// 新条目的ID递增，所以它成为该会话的最新条目。
				put(this.#latest, entry.conversationId, entry.id, LATEST_CAPACITY);
				// 只有携带head的条目才能更新上下文范围标记。
				if (entry.head !== undefined) {
					// 上方检查已证明head存在；as把这个事实补给TypeScript，不执行对象转换。
					put(this.#markers, entry.conversationId, freeze(entry as HeadMarker), MARKER_CAPACITY);
				}
			}
		}
	}

	/** How many conversations have their newest entry kept, for tests that bound memory. */
	// 属性访问器返回最新ID缓存的会话数；如tails.size，无IO和其他副作用。
	get size(): number {
		return this.#latest.size;
	}

	/** How many conversations have their newest head marker kept, for tests that bound memory. */
	// 返回标记缓存项数，null哨兵也占一项；供测试验证数量上限。
	get markers(): number {
		return this.#markers.size;
	}
}

/** `map`'s value for `key`, made the most recently used. */
// 从泛型Map读取key并刷新顺序；K/V在编译时关联键和值类型。缺键返回undefined。
// 例：原顺序A,B，use(A)后变为B,A；会修改传入Map，不读外部资源。
function use<K, V>(map: Map<K, V>, key: K): V | undefined {
	// get不改变Map插入顺序，故命中后还要删除再插入。
	const value = map.get(key);
	// 调用方的Map不以undefined作为有效缓存值；没有值就不改变Map。
	if (value === undefined) return undefined;
	// 先移除旧位置，再放到末尾，将此键标为最近使用。
	map.delete(key);
	map.set(key, value);
	// 返回原值引用，不克隆。
	return value;
}

/** Set `key` as the most recently used, dropping the least recently used beyond `capacity`. */
// 写入键值并维护数量上限；例：容量2、已有A/B，再写C会删A。原地修改Map，无返回值。
function put<K, V>(map: Map<K, V>, key: K, value: V, capacity: number): void {
	// 删除旧键保证覆盖现有值也会更新它的插入顺序。
	map.delete(key);
	// Map按插入顺序枚举，末尾就是本次最近使用的键。
	map.set(key, value);
	// 超容量时删除首键；!只消除TS的undefined可能性，非运行时检查。
	if (map.size > capacity) map.delete(map.keys().next().value!);
}

// 递归冻结缓存记录及其对象子值并返回原引用；例如含嵌套data的标记会连data一起冻结。
// 此处接收项目自己的无环JSON记录；不复制、不处理循环引用，Object.freeze的异常会向外抛出。
function freeze<T>(value: T): T {
	// 原始值/null无需冻结，已经冻结的对象也无需再次遍历。
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	// Object.values也能枚举数组元素，递归处理每个子对象。
	for (const child of Object.values(value)) freeze(child);
	// Object.freeze只冻结当前一层；上面的递归已覆盖可枚举子值。
	return Object.freeze(value);
}
