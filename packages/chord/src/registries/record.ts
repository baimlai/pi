// A registry on a host (slice 8 §1): its provider (replaced or removed by a reload, slice 7b §3), its contributions in table order (`contribution.ts`), the table
// and its lazy composition (marked when the table changes, composed when read or followed, in the batch's
// deliveries), the reports of conflicts and failures (once per episode) and of contributions nobody serves, and the
// values its readers follow by version.

// 文件导读
// 所属包与模块：packages/chord/src/registries 的注册表记录模块（slice 8 §1），属于 Chord 注册表层。
// 职责边界：一个 host 上某 token 的全部运行时状态：provider、贡献表、惰性合成、冲突/失败上报去重、
// 按读者版本的值源与未绑定等待时钟。不定义 token 形状（registry.ts），不实现单份贡献（contribution.ts）。
// 上游：host 在 setup 发布/reload 提交时调用 serve/unserve/add/remove/composeServed/reportUndeclared；
// 贡献来源变化经 RegistryContribution.invalidate 调用 contributionChanged。下游：RegistryValueSource 通过
// start() 拉取合成值；provider.compose 通过 ComposeContext.report 上报冲突；错误交给构造时的 report。
// 错误流向：compose/适配器抛错 -> registry_failed（每个失败周期一次，保留仍有效的旧合成）；
// 贡献问题 -> contribution_failed/refused（由贡献对象去重）；无 provider -> 读者得到 unavailable/undeclared。
// 能力清单：
// - RegistryError（联合类型）：五种上报形状。
// - checkProvider（函数）：声明策略的 provider 形状检查。
// - RegistryRecord（类）：记录本身，含版本查询、serve/unserve、贡献增删、start/composedFrom/inTable、
//   valueAdapter/adapt、reportContribution/failed、close 与惰性重组。
// 组合关系与典型调用顺序：serve -> add 贡献 -> 读取 value(version) -> start -> #recompose -> #build ->
// contribution.entry -> provider.compose -> 值源投递；reload 时 serve 新 provider 或 unserve。
// 示例（真实签名）：const record = new RegistryRecord("routes", batch, onError, clock);
// record.serve(2, provider); const source = record.value(2); const now = source.value;
// 建议阅读顺序：先读 RegistryError/Provider/Composition 类型，再看字段，然后 start 与 #recompose/#build，
// 接着 add/remove/#invalidate，最后版本查询、inTable、close 等辅助方法。

import { ChordError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import type { UnboundClock } from "../host/unbound-clock.ts";
import { type Batch, handedOut, type NativeStart } from "../state/internal.ts";
import type { RegistryContribution } from "./contribution.ts";
import type { ComposeContext, RegistryConflict, RegistryEntry, RegistryProvider, RegistryTable } from "./registry.ts";
import { RegistryValueSource } from "./value.ts";

/** What a registry reports to its host's `onError`, by kind; each once per episode. */
// 上报联合的五个 kind：
// - registry_conflict：compose 解决了一个冲突（例如同名键）；
// - registry_failed：compose 或旧版 value 适配器抛错；
// - contribution_failed：贡献的来源失败/结束，或其 contribution 适配器抛错；
// - contribution_refused：贡献版本不被 provider 接受；
// - registry_undeclared：有贡献但本 host 没有插件服务该注册表。
// “once per episode” 的去重字段分别保存在贡献对象、记录对象和冲突集合中。
export type RegistryError =
	/** `compose` reported a conflict it resolved. */
	| {
			readonly kind: "registry_conflict";
			readonly registry: string;
			readonly message: string;
			readonly plugins: readonly string[];
	  }
	/** `compose` (or an older version's `value` adapter) threw: the last good composition stays. */
	| { readonly kind: "registry_failed"; readonly registry: string; readonly error: unknown }
	/** A watchable contribution failed or ended, or its `contribution` adapter threw: it is left out until it heals. */
	| {
			readonly kind: "contribution_failed";
			readonly registry: string;
			readonly plugin: string;
			readonly type?: string;
			readonly error: unknown;
	  }
	/** A contribution of a version the provider does not accept (newer, or older without an adapter) is left out. */
	| {
			readonly kind: "contribution_refused";
			readonly registry: string;
			readonly plugin: string;
			readonly type?: string;
			readonly version: number;
	  }
	/**
	 * At a publication, or when a host-lifetime object's contributions enter, the registry has contributions and no
	 * plugin here serves it (`unavailable/undeclared` for its readers): its contributing plugins in table order; again
	 * only once they change.
	 */
	| { readonly kind: "registry_undeclared"; readonly registry: string; readonly plugins: readonly string[] };

/** The provider as served: the defining plugin's version, `compose` and adapters. */
// version 与 provider 绑定保存，使记录能按“提供者版本”适配旧贡献。
type Provider = { readonly version: number; readonly provider: RegistryProvider<unknown, unknown> };

/**
 * Where a composition stands: never composed, its last good value (with the contributions it was built from), and its
 * failure while `compose` throws.
 */
// good 保存值与其来源贡献列表（决策 5 的依据）；failure 保存最近一次 compose 抛错。
// 两者可同时存在：compose 失败时仍保留上一次好值给读者。
type Composition = {
	readonly good: { readonly value: unknown; readonly from: readonly RegistryContribution[] } | undefined;
	readonly failure: { readonly error: unknown } | undefined;
};

// 初始“从未合成”状态，可安全共享（对象被约定为只读）。
const NEVER: Composition = { good: undefined, failure: undefined };

/**
 * Checks a registry provider as a setup served it (declaration policy: plugin code is bundled without type checks):
 * `compose` is a function.
 */
// 信任边界：插件打包后没有类型检查，setup 可能传入任意对象，因此这里做运行时形状检查。
// 只检查 compose 是否为函数；accepts 的可选结构在首次使用时按需读取，不做完整校验。
// 示例：checkProvider("routes", { compose: routes }) 通过；缺 compose 时抛普通 Error。
export function checkProvider(name: string, provider: RegistryProvider<unknown, unknown>): void {
	if (typeof provider?.compose !== "function") throw new Error(`registry ${name}: compose is a function`);
}

/** One registry of a host. */
// 类职责见文件头。字段全部由记录自己维护，外部只能通过方法交互。
export class RegistryRecord {
	readonly name: string;
	readonly #batch: Batch;
	readonly #report: (error: RegistryError) => void;
	#provider: Provider | undefined;
	/** The contributions of live contributors, sorted by plugin, then type (a facet's first). */
	// 排序由 add 时插入维护，保证 compose 看到的表顺序稳定且与加载顺序无关。
	#contributions: readonly RegistryContribution[] = [];
	/** The last table composed, kept so an unchanged table composes nothing. */
	#table: RegistryTable<unknown> | undefined;
	#dirty = true;
	#composition: Composition = NEVER;
	/** Set while its table is built and composed: a read then is a cycle of registries. */
	// 重入保护：compose 中读取本注册表（直接或经由其他注册表）会形成循环，start() 检测到后抛 invalid/cycle。
	#composing = false;
	/** The conflicts the last good composition reported, by key: a conflict is reported once per episode. */
	// 键由 message 与 plugins 拼接而成，用于跨合成去重；合成成功时整体替换。
	#conflicts = new Set<string>();
	/** The values readers follow, by version; made by the first reader of a version. */
	// 每个读者版本一个值源；版本表来自 accepts 的键或当前版本。
	readonly #values = new Map<number, RegistryValueSource>();
	/** The host's clock of unbound waits: a value of it waited for while it has none is on it. */
	// 未绑定等待时钟：读者在注册表尚无值时 wait 会登记到这里，由 host 统一唤醒/超时。
	readonly clock: UnboundClock;
	/** The contributing plugins `registry_undeclared` named last (joined); `undefined` since a provider served it. */
	#undeclared: string | undefined;

	// 构造：绑定名称、批次、上报函数和时钟；不创建 provider/贡献/值源。
	// 示例：new RegistryRecord("routes", batch, (e) => onError(e), clock)。
	constructor(name: string, batch: Batch, report: (error: RegistryError) => void, clock: UnboundClock) {
		this.name = name;
		this.#batch = batch;
		this.#report = report;
		this.clock = clock;
	}

	/** The newest registry version its contributions were built against; `undefined` without contributions. */
	// 只读 getter：把所有贡献版本展开后取 Math.max。空表必须提前返回，否则 Math.max() 得 -Infinity。
	// 新加入的贡献者通常使用更高版本，host 据此提升 registry 的读者版本。
	// 示例：贡献版本为 1、2 时返回 2；尚无贡献返回 undefined。
	get newestContribution(): number | undefined {
		if (this.#contributions.length === 0) return undefined;
		return Math.max(...this.#contributions.map(({ version }) => version));
	}

	/** The provider's version; `undefined` while none serves it. */
	// 可选链读取保存的 provider 版本。
	// 示例：record.serve(3, provider) 后得到 3；record.unserve() 后得到 undefined。
	get providedVersion(): number | undefined {
		return this.#provider?.version;
	}

	/** The value readers of `version` follow. */
	// 输入读者版本；返回该版本的值源，首次访问时创建并缓存。
	// 值源是原生 source（FollowedSource 子类），负责把合成值投递给 watch/observer。
	// 示例：const source = record.value(2); const start = source.start(); 同一版本再次 value(2) 得到同一对象。
	value(version: number): RegistryValueSource {
		let value = this.#values.get(version);
		if (value === undefined) {
			value = new RegistryValueSource(this, version, this.#batch);
			this.#values.set(version, value);
		}
		return value;
	}

	/**
	 * Serves the registry with `provider` at `version` (the defining plugin's facet, checked by `checkProvider` when
	 * its setup ran), replacing the provider a reload changed, inside a batch: the table composes again (lazily).
	 */
	// 输入提供者版本与对象；副作用：替换 provider、丢弃旧表缓存、把记录标脏。
	// 不立即 compose：等读取/跟随时再算。reload 换 provider 也走这里。
	// 示例：record.serve(2, { compose: routes })；此时尚未计算，下一次 record.start() 才合成。
	serve(version: number, provider: RegistryProvider<unknown, unknown>): void {
		this.#provider = { version, provider };
		this.#table = undefined;
		// 丢弃旧表，确保 #build 不会误判“表未变化”而沿用旧 provider 的合成。
		this.#invalidate();
	}

	/**
	 * A reload removed the defining plugin, inside a batch: no provider serves it; its readers' values fail
	 * `unavailable/undeclared` (a reader parked on it waits `not_served`), its contributions stay in the table.
	 */
	// 撤销服务：provider 置空、旧表与旧合成清空、标脏。贡献仍保留，便于重新服务时复用。
	// 示例：定义注册表的插件被 reload 移除时调用 record.unserve()，读者随后得到 unavailable/undeclared。
	unserve(): void {
		this.#provider = undefined;
		this.#table = undefined;
		this.#composition = NEVER;
		this.#invalidate();
	}

	/** The first composition of a served registry, at `load`'s publication or a reload's commit, inside its batch. */
	// 在发布/reload 提交时主动触发一次合成（仍受惰性机制保护：start 内部会检查脏标记）。
	// 没有 provider 时直接返回，由 reportUndeclared 负责上报。
	// 示例：record.composeServed(); record.start() 随后的读取直接返回已合成的值。
	composeServed(): void {
		if (this.#provider === undefined) return;
		this.start();
	}

	/**
	 * After a publication's batch, or a batch where an object's contributions entered: with contributions and no
	 * provider, reports `registry_undeclared` naming the contributing plugins, unless the same ones were reported since
	 * a provider last served it.
	 */
	// 去重策略：把插件名去重后按表序拼成键；与上次上报相同则跳过。
	// 一旦有 provider，清除键，使未来 provider 再次消失时能重新上报。
	// 贡献为空时不上报（没有实际需求）。
	// 示例：插件 a、b 贡献了无人服务的注册表时上报一次；发布批次再次调用不重复上报。
	reportUndeclared(): void {
		if (this.#provider !== undefined) {
			this.#undeclared = undefined;
			return;
		}
		if (this.#contributions.length === 0) return;
		// Set 去重，展开回数组；表已按 plugin 排序，所以 plugins 顺序稳定。
		const plugins = [...new Set(this.#contributions.map(({ contributor }) => contributor.plugin))];
		// \u0000 不会出现在校验过的插件名中，作为分隔符避免歧义。
		const key = plugins.join("\u0000");
		if (key === this.#undeclared) return;
		this.#undeclared = key;
		this.#report({ kind: "registry_undeclared", registry: this.name, plugins });
	}

	/** Adds a live contributor's contribution, inside a batch: the table changes. */
	// 插入排序：找第一个“比新贡献大”的位置；找不到则追加。
	// toSpliced 返回新数组而不是原地修改：正在进行的合成持有旧数组，不能被改写。
	// 示例：先加插件 b 的贡献，再加插件 a 的贡献，表中顺序仍是 a、b。
	add(contribution: RegistryContribution): void {
		const at = this.#contributions.findIndex((other) => compareContributors(contribution, other) < 0);
		// A new list per change (contributors come and go rarely): a composition keeps the one it was built from.
		// at < 0 时插入位置为末尾；第二个参数 0 表示不删除元素。
		this.#contributions = this.#contributions.toSpliced(at < 0 ? this.#contributions.length : at, 0, contribution);
		// 开始跟随贡献的来源（若有）。
		contribution.follow();
		this.#invalidate();
	}

	/** Removes an ending contributor's contribution, inside a batch: the table changes. */
	// 先定位；不存在时直接返回（重复 remove 安全）。
	// 同样使用 toSpliced 生成新数组，然后停止跟随并标脏。
	// 示例：插件 attempt 结束时 record.remove(itsContribution)；再次 remove 同一对象无副作用。
	remove(contribution: RegistryContribution): void {
		const at = this.#contributions.indexOf(contribution);
		if (at < 0) return;
		this.#contributions = this.#contributions.toSpliced(at, 1);
		contribution.unfollow();
		this.#invalidate();
	}

	/** A followed contribution changed, inside a batch: the table is marked, composed when read or followed. */
	// 由 RegistryContribution.invalidate 调用；只标脏，不立即合成。
	// 示例：贡献依赖的 writable.set(...) 变化后，RegistryContribution 调用 record.contributionChanged()。
	contributionChanged(): void {
		this.#invalidate();
	}

	/**
	 * The current composition, composed now when the table changed: the value, or `compose`'s failure with the last
	 * good one; `unavailable/undeclared` while no provider serves it. A read while it composes is a cycle.
	 */
	// 读者/值源的拉取入口。返回 NativeStart<unknown>：
	// - 无 provider：failed，错误为 unavailable/undeclared，last 为 undefined（读者无法从旧值启动）；
	// - compose 失败：failed，last 为上一次好值（若仍有效）；
	// - 正常：value。
	// 重入检测必须最先做：compose 中读取同一注册表会形成无限递归。
	// 示例：clean 状态下 record.start() 返回 { kind: "value", value }；compose 抛错后返回带 last 的 failed。
	start(): NativeStart<unknown> {
		if (this.#composing) throw invalid("cycle", `registry ${this.name} is read while it composes`);
		if (this.#provider === undefined) {
			const error = new ChordError({
				code: "unavailable",
				reason: "undeclared",
				message: `registry ${this.name}: no plugin serves it here`,
			});
			return { kind: "failed", error, last: undefined };
		}
		// 只有脏时才真正构建/合成；干净时直接复用缓存。
		if (this.#dirty) this.#recompose(this.#provider);
		const { good, failure } = this.#composition;
		if (failure !== undefined) return { kind: "failed", error: failure.error, last: good };
		// A composition without a failure has a value.
		// ! 断言：没有 failure 且已完成一次合成，必有 good；这是记录内部的不变量。
		return { kind: "value", value: good!.value };
	}

	/** The contributions the current good composition was built from; `undefined` while there is none. */
	// 暴露给值源做决策 5 检查：旧合成是否仍对应表中现存贡献。
	// 示例：const from = record.composedFrom; from !== undefined && record.inTable(from) 表示旧值仍可复用。
	get composedFrom(): readonly RegistryContribution[] | undefined {
		return this.#composition.good?.from;
	}

	/**
	 * Whether every contribution of `from` (what a composition, or a mapping of it, was built from) is still in the
	 * table (decision 5: one that left may have closed the native its entry held).
	 */
	// 决策 5：贡献离开表后，它提供的原生值可能已关闭，旧合成值不能再安全复用。
	// 先做引用相等快速路径：表未变化时直接为真；否则逐个 includes 检查。
	// 示例：旧合成的 from 含贡献 c，但 c 已被 remove，则 inTable(from) 为 false。
	inTable(from: readonly RegistryContribution[]): boolean {
		const current = this.#contributions;
		return from === current || from.every((each) => current.includes(each));
	}

	/** The adapter mapping the composed value back for readers of `version`; `undefined` when there is none. */
	// 返回 accepts[version].value；never 参数类型迫使调用方在自己的代码中注明旧版本类型。
	// 示例：provider 为 v2 且 accepts[1].value 给出映射时，record.valueAdapter(1) 返回该函数。
	valueAdapter(version: number): ((current: never) => unknown) | undefined {
		return this.#provider?.provider.accepts?.[version]?.value;
	}

	/** Runs an adapter of the provider as a pure compute, counted. */
	// 适配器在批次 compute 中运行：期间禁止改 source，并按 chord.registry.adapts 计数。
	// 示例：const old = record.adapt(() => adapter(currentValue)); 适配器抛错时异常原样传出。
	adapt<T>(adapter: () => T): T {
		this.#batch.count("chord.registry.adapts");
		return this.#batch.compute(adapter);
	}

	/** Reports a contribution left out (`contribution_failed`, `contribution_refused`; the caller keeps the episode). */
	// 透传上报；去重状态由调用方（RegistryContribution.#out）维护。
	// 示例：record.reportContribution({ kind: "contribution_refused", ... }) 交给 host 的 onError。
	reportContribution(error: RegistryError): void {
		this.#report(error);
	}

	/** Reports a throw of `compose` or of a value adapter (`registry_failed`; the caller keeps the episode). */
	// 透传上报；错误先字符串化堆栈。去重由 #recompose 检查 composition.failure 完成。
	// 示例：compose 抛 new Error("bad table") 时 record.failed(error) 上报一次 registry_failed。
	failed(error: unknown): void {
		this.#report({ kind: "registry_failed", registry: this.name, error: handedOut(error) });
	}

	/**
	 * The host closed: the contributions stop following their sources, the values end (a value kept by a reader still
	 * reads the last composition).
	 */
	// 关闭：停止跟随、清空贡献与表缓存、重置脏标记、关闭并清空所有版本值源。
	// 注意不清空 #composition：已持有值源的读者仍能读到最后一次合成值。
	// 示例：await host.close(context) 时每个记录收到 close()，之后 value(1).start() 不会再合成。
	close(): void {
		for (const contribution of this.#contributions) contribution.unfollow();
		this.#contributions = [];
		this.#table = undefined;
		this.#dirty = false;
		for (const value of this.#values.values()) value.close();
		this.#values.clear();
	}

	/**
	 * The table changed: every version's value is marked and listed (each lists itself once per batch); while it is
	 * not composed since an earlier change, only listed (its dependents are marked already).
	 */
	// 标脏分两条路径：
	// - 已经 dirty：依赖者早已标脏，只需让值源重新排进本批帧（relisted）；
	// - 从 clean 变 dirty：先置脏，再让值源 recomposed（标脏依赖者并排帧）。
	// 示例：本批第二次 add 时走 relisted 分支，不会重复触发依赖者的重算。
	#invalidate(): void {
		if (this.#dirty) {
			for (const value of this.#values.values()) value.relisted();
			return;
		}
		this.#dirty = true;
		for (const value of this.#values.values()) value.recomposed();
	}

	/**
	 * Builds the table and composes it, unless it is the last one composed, entry for entry (`compose` is pure). A
	 * throw is a failure episode: reported once, the last good composition kept while every contribution it was built
	 * from is still in the table (decision 5: one whose contributor ended may hold a closed native); conflicts are
	 * reported once per episode, as their message and plugins.
	 */
	// 合成主流程：
	// 1) 先清 dirty（本次失败也视为已处理，直到下一次表变化）；
	// 2) 建表；表未变化且已有合成则直接返回（compose 纯函数，跳过多余计算）；
	// 3) 在 batch.compute 中调用 provider.compose；
	// 4) 失败：同一失败周期只上报一次，旧好值仅在 inTable 通过时保留；
	// 5) 成功：记录新值及其来源贡献，只上报新出现的冲突，替换冲突集合；
	// 6) finally 清除 composing，保证抛错后不会永久锁死。
	// 示例：首次 start 触发 #recompose；表未变化时第二次 start 直接复用，不再调用 provider.compose。
	#recompose({ version, provider }: Provider): void {
		this.#dirty = false;
		this.#composing = true;
		try {
			const table = this.#build(version, provider);
			// 引用相等表示表项对象逐个相同；NEVER 表示从未成功合成过，仍需执行 compose。
			if (table === this.#table && this.#composition !== NEVER) return;
			this.#table = table;
			// 本次 compose 内上报的冲突先收集；键包含 message 与 plugins，避免同文案不同插件被误去重。
			const conflicts = new Map<string, RegistryConflict>();
			const context: ComposeContext = {
				report: (conflict) =>
					conflicts.set(`${conflict.message}\u0000${conflict.plugins.join("\u0000")}`, conflict),
			};
			let value: unknown;
			try {
				this.#batch.count("chord.registry.composes");
				// compute 期间禁止改动 source；compose 必须同步返回。
				value = this.#batch.compute(() => provider.compose(table, context));
			} catch (error) {
				// 失败周期内只上报第一次；旧 good 仍需通过决策 5 检查才保留。
				if (this.#composition.failure === undefined) this.failed(error);
				const { good } = this.#composition;
				this.#composition = {
					good: good !== undefined && this.inTable(good.from) ? good : undefined,
					failure: { error },
				};
				return;
			}
			// 成功：新好值记录为“由当前贡献数组构建”，failure 清空。
			this.#composition = { good: { value, from: this.#contributions }, failure: undefined };
			for (const [key, conflict] of conflicts) {
				// 上次合成已报告过的冲突不重复上报。
				if (this.#conflicts.has(key)) continue;
				this.#report({ kind: "registry_conflict", registry: this.name, ...conflict });
			}
			this.#conflicts = new Set(conflicts.keys());
		} finally {
			// 无论成功/抛错都退出合成态，否则后续读取都会误判为循环。
			this.#composing = false;
		}
	}

	/** The table of the live contributions now; the last one itself when every entry is the same object. */
	// 建表：逐贡献调用 entry（可能被拒绝/失败而跳过），同时判断新表是否与上一表逐项同一对象。
	// same 初始要求存在上一表；一旦发现某位置对象不同或长度不同，就返回新数组。
	// previous! 的非空断言由 same 的初值条件保证。
	// 示例：两个贡献都未被拒绝且 entry 对象未变时返回同一个 table 引用，合成被跳过。
	#build(version: number, provider: RegistryProvider<unknown, unknown>): RegistryTable<unknown> {
		const previous = this.#table;
		const table: RegistryEntry<unknown>[] = [];
		let same = previous !== undefined;
		for (const contribution of this.#contributions) {
			const entry = contribution.entry(version, provider);
			// undefined 表示该贡献本次不进表（拒绝/失败）。
			if (entry === undefined) continue;
			// 逐位置比较对象身份；表长度由最后的 length 检查兜底。
			if (same && previous![table.length] !== entry) same = false;
			table.push(entry);
		}
		// 长度相同且逐项相同才复用旧数组，让下游的引用比较保持有效。
		return same && previous!.length === table.length ? previous! : table;
	}
}

/** Table order: by plugin name, then type, a facet (no type) first; code point order, never load order. */
// 比较函数：返回负数表示 a 应排在 b 前，正数反之，0 相等。
// 先比较插件名（字符串 < 比较）；名相同再比较类型，facet 的 undefined 用 "" 表示，因此排在有类型者之前。
// 示例：compareContributors(a(plugin "a"), b(plugin "b")) 返回负数，a 排在 b 前。
function compareContributors(a: RegistryContribution, b: RegistryContribution): number {
	const left = a.contributor;
	const right = b.contributor;
	if (left.plugin !== right.plugin) return left.plugin < right.plugin ? -1 : 1;
	const leftType = left.type ?? "";
	const rightType = right.type ?? "";
	if (leftType === rightType) return 0;
	return leftType < rightType ? -1 : 1;
}
