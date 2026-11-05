// A host's loaded plugins (slice 10 D11, slice 11 §2): the facet loaded for each plugin, and loads and reloads with
// complete sets, the same on a server or worker (the plugins runtime, scripts evaluated with `vm`) and in a page or a
// terminal (scripts that registered themselves). Unchanged plugins (the same digest) pass as the same facet objects,
// removed ones are left out; a plugin whose script failed (its build, its evaluation) keeps its loaded facet (left out
// at the first load) and is named to the host, so its closure rule and its report see it.

//
// 文件导读
// 所属：packages/chord 的 surfaces 层，管理一个宿主上的插件 facet 集合：首次加载、完整集合重载与失败保留。
// 职责边界：把 SetEntry（插件名、digest、延迟 prepare）整理成 PluginFacet 交给 Host.load/host.reload；
// 记录每个插件已加载的 facet 与 digest；串行化 reload；不执行脚本体（prepare 由调用方提供），也不解释宿主的
// 对象 fate，只采纳报告中的失败/保留信息。服务器、worker、页面和终端共用这套逻辑。
// 上游入口：client.ts 的 startClient 与 Updates。下游依赖：Host.load/host.reload、LoadReport/ReloadReport、
// PluginFailure、CommittedReload。
// 结果与错误：load 返回 LoadedFacets 和合并“prepare 失败 + 宿主拒绝”的 LoadReport；reload 返回宿主报告，
// 并在提交后以 aborted 拒绝时先采纳 committed 再原样抛出。单个插件失败不会让宿主关闭。
// 能力清单：
// - Prepared：一个插件准备好的 facet+digest，或求值失败。
// - SetEntry：完整集合中的一个插件；digest 为 undefined 表示其构建失败。
// - LoadedFacets：核心 facets、已加载插件 map、reload 串行链；静态 load、reload、#reload、#adopt。
// - LoadedFacet（私有）：宿主已接受的 facet 与 digest。
// - committedOf（私有）：从 aborted ChordError 的 details 中取出 CommittedReload。
// 组合与顺序：SetEntry.prepare → Prepared → load 把成功项与 core 交给 host.load，再按宿主 failed 过滤 map；
// reload 先按 digest 复用，再 prepare 新项，调用 host.reload({ failed })，最后 #adopt 采纳 kept-old/left-out。
// 示例：`const { loaded, report } = await LoadedFacets.load(host, core, entries, ctx);
// const reloadReport = await loaded.reload(host, nextEntries, ctx);`
// 阅读顺序：Prepared → SetEntry → LoadedFacets 字段 → load → reload/#reload → #adopt → committedOf。

import type { Context } from "../context/index.ts";
import { isChordError, type Principal } from "../data/index.ts";
import type {
	CommittedReload,
	Facet,
	Host,
	LoadReport,
	PluginFacet,
	PluginFailure,
	ReloadReport,
} from "../host/index.ts";

/** A plugin's facet for a host, or why there is none: its script failed. */
// 准备结果是一个判别联合：kind:"facet" 携带可交给宿主的 facet 和可比较的 digest；
// kind:"failed" 携带原始错误（构建失败、求值抛错或默认导出不是 facet）；load 会把它并入返回的报告，不关闭宿主。
export type Prepared =
	| { readonly kind: "facet"; readonly facet: Facet<Principal>; readonly digest: string }
	| { readonly kind: "failed"; readonly error: unknown };

/**
 * One plugin of a complete set: its name, its script's digest (`undefined` when its build failed: nothing to compare)
 * and how to get its facet (evaluated only when the digest is new).
 */
// 完整集合中的一个插件条目。digest 为 undefined 表示构建失败：没有可比对的版本，每次都会走 prepare。
// prepare 是函数而非现成 facet，让 LoadedFacets 能在 digest 未变时完全跳过脚本执行。
// 示例：{ name:"editor", digest:"d1", prepare: () => ({kind:"facet", facet, digest:"d1"}) }
export type SetEntry = { readonly name: string; readonly digest: string | undefined; prepare(): Prepared };

/** A plugin's facet as the host loaded it, with its script's digest. */
// 宿主已接受的插件记录：facet 是实际运行的实例，digest 用于判断下次是否可复用。
type LoadedFacet = { readonly facet: Facet<Principal>; readonly digest: string };

/** A host's loaded plugins: its core facets, each plugin's loaded facet, and its reloads, one after another. */
// 一个宿主的插件账本。核心 facets 单独保存（它们不参与 digest 比较，但每次 reload 都要连同插件一起提交）。
// 插件 map 只记录宿主实际接受的插件；重载串行化，避免并发 reload 基于过期的 map 计算集合。
export class LoadedFacets {
	// 应用自己的 facets；每次 reload 都原样放在集合前面。
	readonly #core: readonly PluginFacet<Principal>[];
	// 插件名 → 宿主已加载的 facet 与 digest；name 是插件名，不是 URL。
	readonly #loaded: Map<string, LoadedFacet>;
	// 最近一次 reload 的尾 Promise；新的 reload 链在它后面。尾链本身不保存报告，避免闭包泄漏。
	#reloading: Promise<void> = Promise.resolve();

	// 私有构造：账本必须经过静态 load 创建，保证核心 facets 和已加载 map 来自同一次宿主加载。
	private constructor(core: readonly PluginFacet<Principal>[], loaded: Map<string, LoadedFacet>) {
		this.#core = core;
		this.#loaded = loaded;
	}

	/**
	 * Prepares `entries` and loads them on `host` with `core` (the app's own facets): a plugin whose script failed is left
	 * out and reported in the report's `failed`, with the host's own. The host's loaded plugins, and the report.
	 */
	// 首次加载。输入：宿主、核心 facets、完整插件条目、上下文；输出：账本 + 加载报告。
	// 副作用：对每个条目调用 prepare（执行脚本），然后一次性 host.load；宿主成功/失败的插件决定账本内容。
	// 错误：prepare 的失败被记录为 failed；host.load 自身抛错则整个 Promise 拒绝（没有可返回的账本）。
	// 报告合并两组失败：先列脚本准备失败，再列宿主拒绝（声明冲突、setup 抛错等）；顺序稳定，便于诊断。
	// 示例：两个插件一个构建失败，host.load 又拒绝另一个，返回的 report.failed 同时包含两者；
	// 成功加载的那个进入 loaded，可在之后 reload 时复用。
	static async load<P extends Principal>(
		host: Host<P>,
		core: readonly PluginFacet<P>[],
		entries: readonly SetEntry[],
		context: Context,
	): Promise<{ readonly loaded: LoadedFacets; readonly report: LoadReport }> {
		// 先准备全部条目；as const 保留 [name, prepared] 的元组类型，后续解构无需断言。
		const prepared = entries.map((entry) => [entry.name, entry.prepare()] as const);
		// 脚本层面的失败；宿主层面的失败在 host.load 返回后合并。
		const failed: PluginFailure[] = [];
		// 核心 facets 先放入，插件按 entries 顺序追加；宿主看到的是一个完整集合。
		const facets: PluginFacet<P>[] = [...core];
		for (const [plugin, each] of prepared) {
			if (each.kind === "failed") failed.push({ plugin, error: each.error });
			// Evaluated for this host's principal type: the facets are the app's (`Facet<P>` is invariant in `P`).
			// Facet<Principal> 不能直接赋给 Facet<P>（P 不变）；这里断言的是“脚本就是为该 principal 类型构建的”这一决定。
			else facets.push({ name: plugin, facet: each.facet as unknown as Facet<P> });
		}
		// 一次性运行所有 setup 并发布；返回宿主拒绝的插件。
		const report = await host.load(facets, context);
		// 宿主拒绝的插件名集合，用于从账本中剔除；成功但被拒绝的条目不能留着，否则下次 digest 相同会误以为可复用。
		const left = new Set(report.failed.map(({ plugin }) => plugin));
		const loaded = new Map<string, LoadedFacet>();
		for (const [plugin, each] of prepared) {
			// 只记录“脚本成功且宿主接受”的插件；失败项不进入 map。
			if (each.kind === "facet" && !left.has(plugin)) loaded.set(plugin, each);
		}
		// The host's own facets, for its later reloads.
		// 核心 facets 在 reload 时也要原样提交；转成 Principal 宽类型仅用于内部存储，使用时再转回 P。
		const kept = new LoadedFacets(core as unknown as readonly PluginFacet<Principal>[], loaded);
		// 合并报告：脚本失败在前，宿主失败在后；两者都保留原始 error。
		return { loaded: kept, report: { failed: [...failed, ...report.failed] } };
	}

	/**
	 * Reloads `host` with `entries`, the complete set now, after its earlier reloads: core facets and unchanged plugins as
	 * the same objects, new scripts prepared, a plugin whose script failed passed as its loaded facet (an added one left
	 * out; both named to the host's closure rule), plugins not in `entries` left out. What the host committed becomes
	 * the loaded set, also when the reload rejects `aborted` after its commit.
	 */
	// 用新的完整集合重载宿主。输入：宿主、条目、上下文；输出：宿主的 ReloadReport。
	// 串行化：每次 reload 排在上一次之后，避免两个重载同时基于旧 map 计算集合，导致把插件回滚到旧 facet。
	// 返回的 Promise 是本次重载本身；内部尾链只用于排队，且吞掉成功/失败值，防止报告长期持有已拒绝 facet 的闭包。
	// 注意：即使本次重载在提交后以 aborted 拒绝，账本也会先采纳 committed，再原样抛出错误。
	reload<P extends Principal>(host: Host<P>, entries: readonly SetEntry[], context: Context): Promise<ReloadReport> {
		// One after another: a reload computing its set from a loaded map an earlier one is about to change would pass
		// that plugin's old facet and roll it back.
		// #reloading 初始已 resolve；then 保证 #reload 在前一次 settle 后才开始。
		const reload = this.#reloading.then(() => this.#reload(host, entries, context));
		// The tail settles to nothing: a report kept as its value would keep a rejected facet's closure (its error).
		// 两个空回调把尾链压成 Promise<void>；reload 本身的报告仍返回给调用方。
		this.#reloading = reload.then(
			() => {},
			() => {},
		);
		return reload;
	}

	/** One reload of `host` with the complete set `entries`. */
	// 单次重载的实际计算。先构建 next 集合：未变化插件复用旧 facet，新 digest 才 prepare；
	// 准备失败的插件记录到 failed；若它之前已加载，则把旧 facet 放回 next（宿主会保留旧代码），新增的则不放入。
	// 然后把 core + next 交给 host.reload，并把 failed 作为调用方已知失败传入，让宿主的闭包规则和报告看到它们。
	// 提交后即使收到 aborted，也根据 details.committed 采纳宿主实际提交的集合，再抛出。
	async #reload<P extends Principal>(
		host: Host<P>,
		entries: readonly SetEntry[],
		context: Context,
	): Promise<ReloadReport> {
		// 本次重载中脚本准备失败的插件（可能随后被旧 facet 替换，但报告仍保留失败）。
		const failed: PluginFailure[] = [];
		// 本次希望宿主运行的插件集合；Map 的插入顺序就是 entries 顺序。
		const next = new Map<string, LoadedFacet>();
		for (const entry of entries) {
			const loaded = this.#loaded.get(entry.name);
			// digest 必须存在且与旧记录相同才复用；undefined 表示构建失败，不能当作“未变化”。
			if (entry.digest !== undefined && entry.digest === loaded?.digest) {
				next.set(entry.name, loaded);
				continue;
			}
			// digest 变化或新增：现在才执行脚本。prepare 可能同步耗时，但已由 reload 队列串行化。
			const prepared = entry.prepare();
			if (prepared.kind === "facet") {
				next.set(entry.name, prepared);
				continue;
			}
			// 准备失败：记录错误；若旧 facet 存在，仍把它放进 next，宿主会保留旧代码。
			failed.push({ plugin: entry.name, error: prepared.error });
			if (loaded !== undefined) next.set(entry.name, loaded);
		}
		// 完整的新集合：核心 facets 在前，插件按 next 顺序展开为 { name, facet }。
		const facets = [...this.#core, ...[...next].map(([name, { facet }]) => ({ name, facet }))];
		let report: ReloadReport;
		try {
			// The host takes facets of its own principal type: they were loaded for it.
			// 内部存的是 Principal 宽类型，但来源就是该宿主；这个断言表达已经验证过的同一性。
			report = await host.reload(facets as unknown as readonly PluginFacet<P>[], context, { failed });
		} catch (error) {
			// Aborted after its commit: the commit stands, and is what the host runs now.
			// aborted 可能发生在提交之后：此时宿主已经切换，本账本必须同步，否则下次会基于错误状态计算。
			const committed = committedOf(error);
			if (committed !== undefined) this.#adopt(next, committed.failed);
			throw error;
		}
		// 正常报告：宿主 failed 名单里的插件是“保留旧代码”或“新增但被排除”；#adopt 据此修正 next。
		this.#adopt(
			next,
			report.failed.map(({ plugin }) => plugin),
		);
		return report;
	}

	/**
	 * Adopts the set `next` a reload committed: a plugin the host kept old (`failed`) stays loaded as it was, an added one
	 * it left out is not loaded.
	 */
	// 采纳宿主实际提交的集合。next 是本次计算的候选；failed 中的插件需要按“旧账本是否存在”修正：
	// - 旧账本有：宿主保留了旧 facet，next 里也放回旧记录；
	// - 旧账本没有：这是新增插件但被拒绝，必须从 next 删除，否则会被误记为已加载。
	// 最后原地替换 #loaded 内容，保持同一个 Map 引用（外部没有直接暴露它）。
	#adopt(next: Map<string, LoadedFacet>, failed: readonly string[]): void {
		for (const plugin of failed) {
			const loaded = this.#loaded.get(plugin);
			if (loaded === undefined) next.delete(plugin);
			else next.set(plugin, loaded);
		}
		this.#loaded.clear();
		for (const [name, each] of next) this.#loaded.set(name, each);
	}
}

/** What the commit of a reload that rejected applied: an `aborted` error after its commit says (`details.committed`). */
// 从 reload 的异常中提取“提交已生效”的快照。只有 ChordError 且 code 为 aborted 才可能有；
// details 是内核写入的附加数据，来自我们自己的错误构造，因此这里只做对象/null 的运行时检查，不深校验字段。
// 返回 undefined 表示没有可用的提交信息（错误发生在提交前，或 details 不含 committed）；不能据此断言宿主状态未变。
function committedOf(error: unknown): CommittedReload | undefined {
	if (!isChordError(error, "aborted")) return undefined;
	// details 在类型上是 JsonValue/unknown；断言为可能带 committed 的对象，随后做一次空值检查。
	const details = error.details as { readonly committed?: CommittedReload } | null | undefined;
	// The kernel's own error: its `committed` is a `CommittedReload`.
	return typeof details === "object" && details !== null ? details.committed : undefined;
}
