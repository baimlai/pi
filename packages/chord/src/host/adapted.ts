// Adapted members (Q10, §22, slice 7b §7; decision "References are the only indirection" (5)): one object instance's
// shared mapping for the consumers of one older version its provider accepts. Per state member one derive of the
// instance's member through `(current) => old` (a changed member), of its variant's whole state through `(state) => old`
// (a removed member), or the member itself (unchanged), made on first use; per key of a keyed member one derive of the
// key's document through the member's mapping, shared by the references holding it. One map and one diff per commit
// per version, whatever the number of old references. Dropped when no reference of the version is left, gone with the
// instance; references move to a new instance's mappings as to any new instance. A version the provider does not
// accept, or a refused member, gives no member (`contract_mismatch`): its consumers wait unbound.
// 文件导读
// 所属：packages/chord/src/host（主机层），实现旧版本消费者的成员映射。
// 职责：按 provider.accepts 为每个旧版本、每个实例建立惰性 Derive 映射，并共享键控文档映射。
// 边界：不校验映射结果形状、不修改对象状态；未接受或被拒绝的成员在读取时抛 contract_mismatch。
// 上游：Attempt.memberAt/keyMapping/pinKey 调用；绑定阶段用 refusal 提前拒绝。
// 下游：Derive/Source 把映射值交给旧引用；键控映射用 holders 计数在最后一个引用离开时 detach。
// 错误：版本未接受、成员被拒绝、实例成员不存在都会抛错；映射函数自身抛错由 derive 上报/传给读者。
// 能力清单：
// - AdaptedInstance：映射需要的实例能力（成员、批次、上报）。
// - refusal：版本与成员可接受性检查。
// - AdaptedMembers：member/key/keyed/detach，缓存并共享映射。
// 组合与顺序：绑定 -> refusal -> AdaptedMembers.member -> #make -> Derive；
// 键控 pin -> key -> holders++，release -> holders-- -> detach。
// 示例：const view = new AdaptedMembers(instance, 1); const count = view.member("count");
// 建议阅读顺序：StateMapping/VersionMappings -> AdaptedInstance -> refusal -> AdaptedMembers.member/key
// -> #make/#keyed -> detach -> mappingsOf/stateMapping。

import type { Contract } from "../contracts/index.ts";
import { currentVariants, LOCAL, variantsAt } from "../contracts/internal.ts";
import { ChordError } from "../data/index.ts";
import type { JsonValue } from "../json.ts";
import type { Batch } from "../state/batch.ts";
import { Derive, type DeriveSource } from "../state/internal.ts";
import type { Served } from "./object.ts";

/** A state mapping as an accepts table holds it (checked by `checkAccepts`). */
// accepts 表里的一项：要么是把当前值映射成旧形状的函数，要么是字符串 "refuse"。
// 参数类型 never 让“任意具体类型的映射函数”都能赋给它；调用方必须自行 as 恢复类型。
type StateMapping = ((current: never) => unknown) | "refuse";

/** One older version's mappings, as `checkAccepts` checked them: remote state by variant, local state flat. */
// 一个旧版本的映射表。state 的两种形状由契约 kind 决定：远程契约按 variant 分组，本地契约直接按成员名。
// keyed 按成员名给键控文档的映射。字段都可选：没写表示该部分不变。
type VersionMappings = {
	readonly state?: { readonly [key: string]: StateMapping | { readonly [member: string]: StateMapping } };
	readonly keyed?: { readonly [member: string]: StateMapping };
};

/** What the mappings of one instance read: its provider, its variant, its own members, its host's batch and reports. */
// AdaptedMembers 的只读依赖。member() 读取实例自己的状态成员；report() 上报映射 derive 的失败。
// served 提供契约、variant 与 accepts 表；batch 用于计数和 derive 排程。
export type AdaptedInstance = {
	readonly served: Served;
	readonly variant: string | undefined;
	readonly label: string;
	readonly batch: Batch;
	/** The instance's state member `member` (`invalid/member` when its variant has none). */
	member(member: string): DeriveSource;
	/** Reports a mapping derive's failure (`derive_failed`). */
	report(member: string, error: unknown): void;
};

/** A key's mapping derive, shared by the references holding the key at this version. */
// 键控文档的共享映射：derive 是实际计算节点，holders 是当前引用数；最后一个持有者释放时 detach。
type MappedKey = { readonly derive: Derive; holders: number };

/**
 * Why consumers of the older `version` cannot bind to `served`'s `variant`: a version it does not accept, or a member
 * of it the provider refuses (`contract_mismatch`); `undefined` when they can.
 */
// 绑定前的整体检查：版本是否在 accepts 表中，以及旧版本 variant 的哪些状态/键控成员被显式拒绝。
// 输入 served、版本号、variant（本地契约为 undefined）；输出第一个拒绝原因或 undefined。
// 例：provider.accepts = { 1: { state: { count: "refuse" } } }，消费者 v1 绑定到 variant 时返回 contract_mismatch。
export function refusal(served: Served, version: number, variant: string | undefined): ChordError | undefined {
	const { contract, provider } = served;
	// 逐项比较版本号；accepted 列表是 checkAccepts 校验过的声明数据。
	if (!provider.accepted.some((accepted) => accepted.version === version)) {
		return new ChordError({ code: "contract_mismatch", message: `${contract.name} v${version} is not served here` });
	}
	const mappings = mappingsOf(served, version);
	// 旧版本身份下的契约视图；本地契约用 LOCAL 作为 variant 键。
	const old = variantsAt(contract, version).get(variant ?? LOCAL);
	// 旧版本没有该 variant 时无成员可拒绝，map 为空。
	for (const member of old?.state.keys() ?? []) {
		if (stateMapping(served, mappings, variant, member) === "refuse") return refused(contract, version, member);
	}
	for (const member of old?.keyed.keys() ?? []) {
		if (mappings?.keyed?.[member] === "refuse") return refused(contract, version, member);
	}
	return undefined;
}

/** One instance's members as the consumers of one older version read them. */
// 某个实例针对某个旧版本的共享映射表。构造时不创建 Derive，所有映射惰性到第一次读取；version 公开只读。
// 例：new AdaptedMembers(instance, 1) 后，member("count") 首次调用才建立 count 的映射 derive。
export class AdaptedMembers {
	readonly version: number;
	readonly #instance: AdaptedInstance;
	/** The members read so far: a mapping derive, or the instance's member itself (unchanged). */
	// 成员名 -> 已构造的 Derive 或实例原成员；缓存避免同一成员重复建 derive。
	readonly #members = new Map<string, DeriveSource>();
	/** The mapping derives it made (an unchanged member is the instance's own: it never detaches that one). */
	// 只收集“本类创建的”映射 derive；未变化的实例成员不在此集合，detach 时不能误关别人的源。
	readonly #derives = new Set<Derive>();
	/** The keys held so far, by the instance's key document. */
	// 两层 Map：成员名 -> (文档源 -> 共享映射)。同一文档可被多个引用以同一版本持有。
	#keys: Map<string, Map<DeriveSource, MappedKey>> | undefined;

	// 保存实例与版本，不建立资源；公开 version 供调用方选择映射。
	constructor(instance: AdaptedInstance, version: number) {
		this.#instance = instance;
		this.version = version;
	}

	/**
	 * State member `member` as this version reads it, made by the first use; `contract_mismatch` when the provider
	 * refuses it or does not accept this version.
	 */
	// 返回某状态成员在该旧版本下的读取源。输入成员名，输出 DeriveSource；首次调用建立并缓存。
	// 错误由 #make 抛出（未接受的版本或被拒绝的成员）；抛错时不缓存，后续调用会再试并再次失败。
	member(member: string): DeriveSource {
		const made = this.#members.get(member);
		if (made !== undefined) return made;
		// 先构造再写入缓存；构造抛错则什么都不写。
		const source = this.#make(member);
		this.#members.set(member, source);
		return source;
	}

	/**
	 * The document `document` at a key of keyed member `member` as this version reads it: the document itself when
	 * unchanged, else a derive of it through the mapping, shared by its holders; `release` (once per call) lets the last
	 * holder's go. `contract_mismatch` when the provider refuses the member.
	 */
	// 返回某键控成员在某文档上的映射源与释放函数。输入成员名、文档源；输出 { source, release }。
	// 未变化时直接返回原文档，release 为空；有映射时按“成员 + 文档”共享一个 Derive，并增加持有计数。
	// release 幂等：同一调用释放两次只有第一次生效；最后一个持有者离开才 detach derive 并清理表项。
	// 例：两个旧版本引用都 pin 同一个 key，拿到同一个 mapped.source；各自 release 后 derive 才结束。
	key(member: string, document: DeriveSource): { readonly source: DeriveSource; release(): void } {
		const mapping = this.#keyed(member);
		// 映射未定义 = 文档形状没变：无需 derive，也不需要计数。
		if (mapping === undefined) return { source: document, release: () => {} };
		this.#keys ??= new Map();
		const keys = this.#keys;
		// By member, then document: two keyed members over one handle map the same document differently (Astra).
		// 先按成员分组，避免同一底层文档在不同键控成员上被错误共用。
		let found = keys.get(member);
		if (found === undefined) {
			found = new Map();
			keys.set(member, found);
		}
		const byDocument = found;
		let held = byDocument.get(document);
		if (held === undefined) {
			const { batch } = this.#instance;
			// 单源 derive：把文档当前值经 mapping 转成旧形状。
			const derive = new Derive([document], ([value]) => mapping(value as JsonValue), batch);
			// A failure of the mapping is the reader's (its watch gets it); nothing to report for the provider.
			// resolve 直接把声明源原样交回；report 空操作，因为失败属于读取者的 watch，不是提供方故障。
			derive.attach(
				(declared) => declared as DeriveSource,
				() => {},
			);
			held = { derive, holders: 0 };
			byDocument.set(document, held);
		}
		// 共享计数：每个调用方都需要各自的 release 调用。
		held.holders++;
		const key = held;
		let released = false;
		return {
			source: key.derive,
			release: () => {
				// 同一 release 重复调用不重复减计数。
				if (released) return;
				released = true;
				// 还有持有者，或表项已被更新的 derive 替换：只减计数/不清理。
				if (--key.holders > 0 || byDocument.get(document) !== key) return;
				byDocument.delete(document);
				// 该成员下已无文档，且成员表仍是这张（未被 detach 清空）：一起删除。
				if (byDocument.size === 0 && keys.get(member) === byDocument) keys.delete(member);
				// 最后一个持有者离开：结束 derive，watch 会收到 released/ended。
				key.derive.detach(ended(this.#instance.label));
			},
		};
	}

	/**
	 * The provider's mapping of keyed member `member`'s documents to this version's shape (`undefined`: unchanged),
	 * counted; throws `contract_mismatch` when the provider refuses it.
	 */
	// 公开查询键控映射，供 host/attempt.ts 的 keyMapping 使用；返回 undefined 表示文档不变。
	keyed(member: string): ((current: JsonValue) => JsonValue) | undefined {
		return this.#keyed(member);
	}

	/** Its instance ended, or the version's last reference left: its derives go (their watches end with `error`). */
	// 结束整套映射：detach 本类创建的 derive，清空成员缓存与键表。
	// 注意先清空 #derives 再清 #members，避免重复 detach；实例自己的未变化成员不在集合中，不会被动到。
	detach(error: Error): void {
		for (const derive of this.#derives) derive.detach(error);
		this.#derives.clear();
		this.#members.clear();
		for (const byDocument of this.#keys?.values() ?? []) {
			for (const { derive } of byDocument.values()) derive.detach(error);
		}
		this.#keys = undefined;
	}

	/** The mapping of keyed member `member`, counted; `contract_mismatch` when refused. */
	// 内部实现：先确认版本被接受，再取 accepts.keyed[member]。
	// undefined 表示不变；"refuse" 抛错；函数则包一层计数后返回。
	#keyed(member: string): ((current: JsonValue) => JsonValue) | undefined {
		this.#assertAccepted();
		const mapping = this.#mappings?.keyed?.[member];
		if (mapping === undefined) return undefined;
		if (mapping === "refuse") throw refused(this.#contract, this.version, member);
		const { batch } = this.#instance;
		return (current) => {
			// 每次真正映射计数一次，便于遥测观察旧版本兼容成本。
			batch.count("chord.contract.adapts");
			// The provider's mapping, typed by its contract; its result is the old shape (not validated).
			// 参数类型 never 需要 as 恢复；返回值不做形状校验，信任提供方声明。
			return mapping(current as never) as JsonValue;
		};
	}

	/**
	 * What `member` is at this version: the instance's member itself (unchanged), or a derive through the mapping, of the
	 * member when the current variant has it, else of the variant's whole current state (a removed member).
	 */
	// 构造一个状态成员的旧版本视图。输入成员名，输出可订阅源；会新建并登记 Derive（未变化除外）。
	// 分支：映射未定义 -> 原成员；映射为 refuse -> contract_mismatch；否则按“当前 variant 是否仍有该成员”
	// 决定 derive 的输入：单个成员，或整个 variant 的状态对象。
	#make(member: string): DeriveSource {
		this.#assertAccepted();
		const instance = this.#instance;
		const { variant, batch } = instance;
		const mapping = stateMapping(instance.served, this.#mappings, variant, member);
		// 未写映射：形状不变，直接读实例自己的成员，不创建 derive、不计入 #derives。
		if (mapping === undefined) return instance.member(member);
		if (mapping === "refuse") throw refused(this.#contract, this.version, member);
		// 包装映射：每次计算计数；结果按旧成员形状使用，不做运行校验。
		const map = (value: unknown): JsonValue => {
			batch.count("chord.contract.adapts");
			// The provider's mapping, typed by its contract; its result is the old member's shape (not validated).
			return mapping(value as never) as JsonValue;
		};
		// 当前（新）版本的契约视图；! 成立，因为 variant 必须存在于当前契约。
		const current = currentVariants(this.#contract).get(variant ?? LOCAL)!;
		// The member when the current variant has it, else the variant's whole current state (a removed member).
		// 新版本仍保留该成员时只依赖它；成员被删除时依赖整个状态，映射函数负责从中算出旧成员值。
		const kept = current.state.has(member);
		const names = kept ? [member] : [...current.state.keys()];
		const sources = names.map((name) => instance.member(name));
		// 三元表达式按 kept 分支：保留成员时只依赖该成员；删除成员时依赖整个状态并重组对象。
		// 单成员时 values 元组只有一项；删除成员时把按 names 排列的值重新组装成对象，再交给映射函数。
		const derive = kept
			? new Derive(sources, ([value]) => map(value), batch)
			: new Derive(
					sources,
					(values) => map(Object.fromEntries(names.map((name, index) => [name, values[index]]))),
					batch,
				);
		this.#derives.add(derive);
		// The sources are the instance's members already.
		// 输入源已是 DeriveSource，无需转换；失败上报为本成员的 derive_failed。
		derive.attach(
			(source) => source as DeriveSource,
			(error) => instance.report(member, error),
		);
		return derive;
	}

	/** Throws `contract_mismatch` unless the provider accepts this version. */
	// 运行时检查：provider.accepted 是声明数据，这里逐项比较版本号。不通过则抛契约不匹配。
	#assertAccepted(): void {
		const { contract, provider } = this.#instance.served;
		if (provider.accepted.some(({ version }) => version === this.version)) return;
		throw new ChordError({
			code: "contract_mismatch",
			message: `${contract.name} v${this.version} is not served here`,
		});
	}

	// 当前实例的契约；getter 每次读取 served 上的引用，不缓存快照。
	get #contract(): Contract {
		return this.#instance.served.contract;
	}

	/** This version's mappings in the provider's accepts table. */
	// 读取 accepts 表中本版本的映射；可能 undefined（版本被接受但没写映射，表示都不变）。
	get #mappings(): VersionMappings | undefined {
		return mappingsOf(this.#instance.served, this.version);
	}
}

/** `version`'s mappings in `served`'s accepts table. */
// provider.accepts 的形状已由 checkAccepts 在加载时检查；这里断言成版本号索引的映射表。
// JS 对象键是字符串，但以数字索引读取仍正常工作。
function mappingsOf(served: Served, version: number): VersionMappings | undefined {
	// `checkAccepts` established the table's shape.
	const accepts = served.provider.accepts as { readonly [version: number]: VersionMappings };
	return accepts[version];
}

/** The mapping of state member `member` of `variant` in `mappings`; `undefined` when it is unchanged. */
// 按契约种类读取状态映射：本地契约是扁平的 state[member]；远程契约先按 variant 分组。
// 本地契约会在上面的分支提前返回；远程契约的 variant 正常情况下必有值，undefined 时这里回退到空键。
function stateMapping(
	served: Served,
	mappings: VersionMappings | undefined,
	variant: string | undefined,
	member: string,
): StateMapping | undefined {
	const state = mappings?.state;
	if (state === undefined) return undefined;
	if (served.contract.kind === "local") return state[member] as StateMapping | undefined;
	// 先取 variant 小节，再取成员；两层都可能缺失，所以用可选链。
	const section = state[variant ?? ""] as { readonly [member: string]: StateMapping } | undefined;
	return section?.[member];
}

/** The `contract_mismatch` of a member of `version` the provider refuses. */
// 构造“成员被拒绝”的错误；只在检查或首次使用时创建，不产生其他副作用。
function refused(contract: Contract, version: number, member: string): ChordError {
	return new ChordError({
		code: "contract_mismatch",
		message: `${contract.name} v${version}: member "${member}" is refused by its provider`,
	});
}

/** The `released` error its derives end with when its instance or version goes. */
// 映射 derive 被回收时传给 watch 的结束原因：released/ended，说明不是数据故障，而是读取方已离开。
function ended(label: string): ChordError {
	return new ChordError({ code: "released", reason: "ended", message: `${label}: ended` });
}
