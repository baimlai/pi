// One contributor's contribution to a registry (slice 8 §1): its table entry, made once per value (an older version's
// adapted once per value), followed when it is a Chord watchable, left out and reported when it fails or is refused.

// 文件导读
// 所属包与模块：packages/chord/src/registries 的贡献状态模块（slice 8 §1），属于 Chord 注册表层。
// 职责边界：代表单个贡献者的值，负责版本检查/旧版适配、表项缓存、跟随来源与失败/拒绝去重；
// 不维护整张表（RegistryRecord 负责），不调用 compose。
// 上游：RegistryRecord.add 创建；贡献来源变化时 Source.changed 调用 invalidate。
// 下游：record.#build 调用 entry(version, provider) 取得表项，表项进入 provider.compose；
// 失败/拒绝通过 record.reportContribution 上报到 host 的 onError。
// 错误流向：来源失败或适配器抛错不会穿透 entry，而是被捕获、上报一次并返回 undefined（该贡献暂时离表）。
// 能力清单：
// - Contributor（类型）：plugin + 可选 type 的来源标识。
// - ContributionContent（联合类型）：plain/json/native 三种贡献内容。
// - RegistryContribution（类）：实现 Dependent，提供 invalidate/sourceRetired/follow/unfollow/entry。
// 组合关系与典型调用顺序：new RegistryContribution(...) -> record.add -> follow() 登记依赖 ->
// 表变脏 -> entry() 读值/适配/缓存 -> 合成；来源变化 -> invalidate -> record.contributionChanged。
// 示例（真实签名）：const c = new RegistryContribution(record, { plugin: "routes" }, 2,
//   { kind: "json", source: routesSource }); const entry = c.entry(2, provider);
// 建议阅读顺序：先读 Contributor/ContributionContent，再看类字段与 invalidate/follow，然后 entry 的版本分支，
// 最后 #raw/#adapt 与两个上报方法。

import { type Dependent, type DeriveSource, handedOut, type NativeSource, Source } from "../state/internal.ts";
import type { RegistryRecord } from "./record.ts";
import type { RegistryEntry, RegistryProvider } from "./registry.ts";

/** Who contributes: a facet (by plugin) or a host-lifetime object (by plugin and type). */
// 贡献者来源：plugin 必有；type 仅当贡献来自某个对象（宿主生命周期对象）时存在，facet 没有类型。
export type Contributor = { readonly plugin: string; readonly type: string | undefined };

/**
 * What a contribution is: a plain value, a Chord JSON watchable (a source or a constant), or a native source; the
 * watchables followed for their value.
 */
// 判别联合：kind 是运行时标签。
// plain 直接持有值；json 是 JSON source/constant；native 是原生 source（writable、registry value 等）。
// 这里用 DeriveSource/NativeSource 而不是 Watchable，因为贡献处理需要访问 dependents/value 等内部能力。
export type ContributionContent =
	| { readonly kind: "plain"; readonly value: unknown }
	| { readonly kind: "json"; readonly source: DeriveSource }
	| { readonly kind: "native"; readonly source: NativeSource };

/**
 * One contributor's contribution to a registry: a plain value, or a Chord source it follows as a dependent (a change
 * marks the registry's table). Its table entry is made once per value (an older version's adapted once per value);
 * a failure or refusal leaves it out, reported once per episode.
 */
// 类职责：单份贡献的生命周期与缓存。实现 Dependent 以便挂在 source.dependents 上。
// 字段：#content 是不可变内容；#adapted 缓存旧版适配结果（来源值身份 + 适配函数 -> 结果）；
// #entry 缓存最近表项；#out 记录当前是否处于“被排除”状态，用于错误去重。
export class RegistryContribution implements Dependent {
	/** The registry it contributes to. */
	readonly record: RegistryRecord;
	readonly contributor: Contributor;
	/** The registry version its contributor was built against. */
	readonly version: number;
	readonly #content: ContributionContent;
	/** The last adaptation of an older contribution: the value and adapter it was made from, and its result. */
	#adapted: { readonly from: unknown; readonly adapter: (old: never) => unknown; readonly value: unknown } | undefined;
	#entry: RegistryEntry<unknown> | undefined;
	/** Left out since its last entry: failing (reported once), or refused (reported once). */
	#out: "none" | "failed" | "refused" = "none";

	// 构造：只保存引用与版本，不跟随 source、不生成表项。示例：
	// new RegistryContribution(record, {plugin:"routes", type:"http"}, 2, {kind:"plain", value: routes})。
	constructor(record: RegistryRecord, contributor: Contributor, version: number, content: ContributionContent) {
		this.record = record;
		this.contributor = contributor;
		this.version = version;
		this.#content = content;
	}

	/** Its source changed (inside a batch): the registry's table is marked. */
	// 被来源标脏：不在此重算，只让 registry 记录把表标脏（惰性重组）。
	// 示例：贡献来源 writable.set(...) 变化后，Source 在批次内调用 contribution.invalidate()。
	invalidate(): void {
		this.record.contributionChanged();
	}

	/** A retirement of its source's document changes nothing beyond the value. */
	// 文档退役对注册表贡献没有额外语义：值的变化已经通过 invalidate 传播，因此空实现。
	// 示例：来源文档被 retire 时调用；这里不改表，仍由后续 invalidate 通知变化。
	sourceRetired(): void {}

	/** Starts following its source, if it has one. */
	// 注册为来源依赖者；plain/constant 没有 dependents，可选链跳过。
	// 示例：record.add(contribution) 内调用 contribution.follow()，把它加入 source.dependents。
	follow(): void {
		const source = this.#followed();
		source?.dependents.add(this);
	}

	/** Stops following its source. */
	// 注销依赖；不存在 source 时无操作。
	// 示例：record.remove(contribution) 或 host.close() 时调用，避免依赖集合继续保留该贡献。
	unfollow(): void {
		this.#followed()?.dependents.delete(this);
	}

	/** Its source when it changes (a constant never does). */
	// 返回可跟随的来源：native 总是可跟随；json 中只有 Source（Constant 永不变化，不需要跟随）。
	// 返回类型必须带 undefined，调用方用可选链处理。
	// 示例：plain 内容返回 undefined；json 的 Constant 返回 undefined；json 的 Source 返回该 source。
	#followed(): Source | NativeSource | undefined {
		const content = this.#content;
		if (content.kind === "native") return content.source;
		return content.kind === "json" && content.source instanceof Source ? content.source : undefined;
	}

	/**
	 * Its entry in a table of the provider at `version`: the same object while its value is the same; `undefined` when
	 * left out (a refused version, a failing source, a throwing adapter).
	 */
	// 输入 provider 的当前版本；输出表项或 undefined（表示本次不进表）。
	// 版本规则：
	// - 贡献版本高于 provider 版本：无法理解，拒绝（contribution_refused）；
	// - 贡献版本低于 provider 版本：需要 accepts[贡献版本].contribution 适配；没有适配器同样拒绝；
	// - 版本相同：直接使用。
	// 失败（来源抛错或适配器抛错）记为 failed 并返回 undefined；恢复后 #out 复位。
	// 示例：贡献 v1、provider v2 且 accepts[1].contribution 存在时，表项 value 是适配后的结果。
	entry(version: number, provider: RegistryProvider<unknown, unknown>): RegistryEntry<unknown> | undefined {
		// 只有“旧贡献 + 有适配器”才需要适配；接受表按贡献版本索引。
		const adapter = this.version < version ? provider.accepts?.[this.version]?.contribution : undefined;
		if (this.version > version || (this.version < version && adapter === undefined)) {
			// 同一拒绝周期只上报一次，避免每次合成都刷屏。
			if (this.#out !== "refused") this.#refused();
			return undefined;
		}
		let value: unknown;
		try {
			// 每次合成都要重新读取来源当前值；plain 值恒定，json/native 可能失败。
			const raw = this.#raw();
			// adapter 为 undefined 表示版本相同；否则走缓存适配。
			value = adapter === undefined ? raw : this.#adapt(raw, adapter);
		} catch (error) {
			// 来源失败/适配失败：本贡献被排除；同一失败周期只上报一次。
			if (this.#out !== "failed") this.#failed(error);
			return undefined;
		}
		// 成功进入表：清除排除状态，下一轮失败会重新上报。
		this.#out = "none";
		const entry = this.#entry;
		// `undefined` is a value: the entry, not its field, says whether there was one.
		// 用 entry 对象是否为 undefined 判断“是否有缓存”，而不是用 value；因为 undefined 也可能是合法贡献值。
		if (entry !== undefined && entry.value === value) return entry;
		const { plugin, type } = this.contributor;
		// 条件展开：type 存在时才加字段，保持 facet 表项没有 type 键。
		// 新表项只在值身份变化时创建，保证同一值对应同一对象。
		this.#entry = { plugin, ...(type === undefined ? {} : { type }), version: this.version, value };
		return this.#entry;
	}

	/**
	 * The contributed value now: a JSON source's value throws while it is failed or ended; a native source that failed
	 * (a registry whose `compose` threw) keeps a last good value for its readers, but is left out here as failed.
	 */
	// 按内容类型取值：
	// - plain：直接返回值；
	// - json：Source.value 在失败/结束时抛错，让 entry 的 try/catch 处理；
	// - native：用 current() 而不是 value，使失败的来源在这里抛出，而不是贡献旧值。
	// 示例：native 来源处于失败态时 current() 抛错，entry 捕获后把贡献暂时移出表。
	#raw(): unknown {
		const content = this.#content;
		// switch 对 kind 做穷尽收窄；三个 case 覆盖联合所有成员。
		switch (content.kind) {
			case "plain":
				return content.value;
			case "json":
				return content.source.value;
			case "native":
				return content.source.current();
		}
	}

	// 旧版适配缓存：仅当来源值身份与适配函数都未变时复用结果。
	// record.adapt 负责遥测计数并执行适配；raw as never 是 RegistryAccepts 中 old: never 约定所需。
	// 示例：来源值引用未变时第二次 entry 直接复用 #adapted.value，不再调用适配器。
	#adapt(raw: unknown, adapter: (old: never) => unknown): unknown {
		const adapted = this.#adapted;
		if (adapted !== undefined && adapted.from === raw && adapted.adapter === adapter) return adapted.value;
		const value = this.record.adapt(() => adapter(raw as never));
		this.#adapted = { from: raw, adapter, value };
		return value;
	}

	// 上报“拒绝”：记录 #out 防止重复；带上 plugin、可选 type、registry 名与贡献版本。
	// where 的条件展开避免给 facet 贡献发送 type: undefined（线上 JSON 更干净）。
	// 示例：贡献 v3 遇到 provider v2 时上报 contribution_refused 并返回 undefined。
	#refused(): void {
		this.#out = "refused";
		const { plugin, type } = this.contributor;
		const registry = this.record.name;
		const where = type === undefined ? {} : { type };
		this.record.reportContribution({
			kind: "contribution_refused",
			registry,
			plugin,
			...where,
			version: this.version,
		});
	}

	// 上报“失败”：错误先经 handedOut 字符串化堆栈，再交给 host 的错误通道。
	// 示例：适配器抛错时上报 contribution_failed，错误堆栈在交接前已转为文本。
	#failed(error: unknown): void {
		this.#out = "failed";
		const { plugin, type } = this.contributor;
		const registry = this.record.name;
		const where = type === undefined ? {} : { type };
		this.record.reportContribution({
			kind: "contribution_failed",
			registry,
			plugin,
			...where,
			error: handedOut(error),
		});
	}
}
