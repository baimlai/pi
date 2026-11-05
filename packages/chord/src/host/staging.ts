// Staging (slice 7b §2; per plugin, decision "Per plugin at startup and reload"): each plugin's setup runs into a table of
// its own (the types it serves with their providers, the registries it serves, its facet contributions) with `load`'s
// checks, merged into the staged table beside the live one, where a type or registry another plugin serves already
// fails the plugin; and an object's new factory run against a recording `self`, which keeps what the factory declares
// (natives, documents, tables, jobs, contributions, requests with their contract versions) and activates, binds and
// opens nothing, so a reload decides each object's fate, and which plugins keep their old code, before its commit.
// `load` stages its facets the same way and publishes them.
// 所属模块：packages/chord/src/host 的激活/重载暂存层（slice 7b，“按插件启动与重载”）。
// 上下游：Host.load 对每个插件调用 stagePlugin 并用 addStaged 合并；reload 用 recordFactory 在不动真实对象的情况下
//   运行工厂、收集声明；下游依赖 facet.setUp、contracts/data 校验、registries、store 的 claims 与表目录。
// 结果：返回纯内存的 StagedPlugin/Staged/Recorded，不发布、不激活、不写库；错误是带插件/对象标签的普通 Error。
// 能力清单：
// - PluginFacet / StagedRegistry / StagedPlugin / Staged：暂存输入与合并结果的数据形状。
// - StagingHost：暂存期间所需的宿主能力（身份、地址、presence 引用）。
// - isPluginName / checkPluginNames：npm 包名规则的检查。
// - emptyStaged / stagePlugin / addStaged：初始空表、运行单个插件 setup、合并并检测重名。
// - Recorded / Request：记录工厂声明所需的数据形状。
// - recordFactory：用 recording self 运行工厂并收集声明。
// - migratesTables：判断记录的表定义是否要求对象重启后再激活。
// 组合关系：emptyStaged -> 对每个插件 stagePlugin -> addStaged（冲突即停）-> 发布；
//   重载时 recordFactory -> 依据 Recorded 决定对象的命运。
// 示例：const staged = emptyStaged(); const plugin = stagePlugin({ name: "@acme/notes", facet }, host);
//   const error = addStaged(staged, plugin); // undefined 表示合并成功
// 阅读顺序：先五个数据形状与 StagingHost，再 stagePlugin/stageEntry 的校验，随后 addStaged；
//   最后读 recordFactory/RecordingSelf 与 migratesTables，理解“只记录、不激活”。

import type { Context } from "../context/index.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import { contractData } from "../contracts/internal.ts";
import type { Principal } from "../data/index.ts";
import { bindProvider, checkParams } from "../data/internal.ts";
import type { AnyDefinition } from "../documents/internal.ts";
import type { JobDefinition } from "../jobs/index.ts";
import type { Registry, RegistryProvider } from "../registries/index.ts";
import { checkProvider, type RegistryValueSource } from "../registries/internal.ts";
import { tableSqlName } from "../store/sql.ts";
import type { ChordStore } from "../store/store.ts";
import type { TableDefinition } from "../store/table.ts";
import type { Watchable } from "../watch.ts";
import type { StoreSelf } from "./attempt.ts";
import { type Facet, type FacetContribution, type ServedEntry, setUp } from "./facet.ts";
import type { ChordObject, LocalContract, RemoteContract, Served } from "./object.ts";
import type { Presence } from "./presence.ts";
import { retrySource } from "./retry-on.ts";

/** A plugin's facet as `load` and `reload` take it: its name (its `package.json` name) and its facet. */
// 输入形状：插件名用于错误定位与重名报告，facet 是插件导出的类型/注册表/贡献声明。
// readonly 只约束编译期；运行时不会冻结 facet。
export type PluginFacet<P extends Principal = Principal> = { readonly name: string; readonly facet: Facet<P> };

/** A registry a staged plugin serves: the defining plugin, the token and its provider. */
// 注册表服务项：plugin 记录谁定义它，registry 是令牌，provider 必须在 stageEntry 中通过 checkProvider。
export type StagedRegistry = {
	readonly plugin: string;
	readonly registry: Registry<unknown, unknown>;
	readonly provider: RegistryProvider<unknown, unknown>;
};

/** One plugin's setup, run and checked: what it serves and contributes, nothing published yet. */
// 单插件暂存结果：types/registries 以名称为键，contributions 保持 setup 声明顺序（顺序影响合成结果）。
// 这里没有任何链接、对象实例或已发布状态，只是可合并的数据。
export type StagedPlugin = {
	readonly name: string;
	/** The served types by name, each with its plugin, factory, provider (its `accepts` checked) and `linger`. */
	readonly types: ReadonlyMap<string, Served>;
	/** The served registries by name. */
	readonly registries: ReadonlyMap<string, StagedRegistry>;
	/** The facet contributions, in the setup's order. */
	readonly contributions: readonly FacetContribution[];
};

/** A plugin set's staged plugins, merged: what they serve, by name, and each plugin's own table. */
// 合并后的暂存表：types/registries 是跨插件去重后的视图，plugins 保留每个插件自己的声明以便重载时复用旧代码。
export type Staged = {
	readonly types: Map<string, Served>;
	readonly registries: Map<string, StagedRegistry>;
	readonly plugins: Map<string, StagedPlugin>;
};

/** What staging needs of its host: whom it acts as, where it lives, and its presence lists for setups. */
// 暂存只依赖宿主的三项能力：身份、地址和 presence 引用；不直接持有 Host，便于测试替换。
// references 的泛型 C 让 setup 得到的 Watchable 具体到被请求的契约类型。
export type StagingHost = {
	readonly principal: Principal | undefined;
	readonly address: unknown;
	references<C extends Contract>(Type: C): Watchable<readonly Presence<C, Principal>[]>;
};

/** An npm package name, scoped or not. */
// 只接受小写 npm 包名；@scope/name 的作用域可选。它是运行时正则，isPluginName 是真正的边界检查。
const PLUGIN_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

/** Whether `name` is a valid plugin name: an npm package name, scoped or not (the plugins component checks it too). */
// 返回布尔值，无副作用；例如 "@acme/notes" 为 true，"Notes" 为 false。
export function isPluginName(name: string): boolean {
	return PLUGIN_NAME.test(name);
}

/**
 * Throws for the first plugin of `facets` whose name is no npm package name: a programming error, so `load` and
 * `reload` throw before they change anything (decision "Mistakes that wait are reported at once" (d)).
 */
// 在任何状态改变前同步拒绝非法插件名；无返回值，失败抛普通 Error（这是编程错误，不是运行时输入错误）。
// 只读取 name 字段，泛型形状让 callers 可传任意带 name 的数组。
export function checkPluginNames(facets: readonly { readonly name: string }[]): void {
	for (const { name } of facets) if (!isPluginName(name)) throw new Error(`"${name}" is not a valid plugin name`);
}

/** A staged table with nothing in it. */
// 返回三个空 Map 的新对象；每次 load 从空表开始，避免复用上一次的暂存状态。
export function emptyStaged(): Staged {
	return { types: new Map(), registries: new Map(), plugins: new Map() };
}

/**
 * Runs one plugin's setup (its name checked by `checkPluginNames` before) and checks what it declared: a type or
 * registry it serves twice, a remote type on a host without a principal or address, every provider's `accepts`
 * (`checkAccepts`) and every registry provider's shape. Throws the first error, naming the plugin.
 */
// 运行单个插件的 setup 并暂存其声明。输入插件名/facet 与暂存宿主；返回 StagedPlugin，不发布任何东西。
// 副作用：执行插件 setup 代码（可能创建对象、读注册表值），但不写库、不建立链接；错误统一加插件名前缀。
// 示例：const staged = stagePlugin({ name: "@acme/notes", facet: notesFacet }, host);
export function stagePlugin<P extends Principal>({ name, facet }: PluginFacet<P>, host: StagingHost): StagedPlugin {
	// The host's presence lists are typed for its `P`.
	// 类型断言把宿主泛型对齐到 P；这是编译期转换，运行时对象不变。
	const references = host.references as <C extends Contract>(Type: C) => Watchable<readonly Presence<C, P>[]>;
	// 两个 Map 只属于本插件，合并前可安全丢弃；setup 抛错时不会返回半成品。
	const types = new Map<string, Served>();
	const registries = new Map<string, StagedRegistry>();
	try {
		// setUp 展开 facet，逐个声明交给 stageEntry；contributions 原样保留顺序。
		const { served, contributions } = setUp(name, facet, references);
		for (const entry of served) stageEntry(name, entry, types, registries, host);
		return { name, types, registries, contributions };
	} catch (error) {
		// named 只改消息并保留 cause；调用方拿到的仍是普通 Error。
		throw named(error, `plugin "${name}"`);
	}
}

/**
 * Merges `plugin` into `staged`; a type or registry another plugin serves there already refuses it (its error
 * returned, nothing merged).
 */
// 把一个插件合并进暂存表。返回 undefined 表示成功；重名时返回 Error 且不做任何改动（先检查，后写入）。
export function addStaged(staged: Staged, plugin: StagedPlugin): Error | undefined {
	// 两个独立的前置检查都基于现有 staged；只有两者都通过才写入，避免部分合并。
	for (const name of plugin.types.keys()) {
		const other = staged.types.get(name);
		if (other !== undefined)
			return new Error(`plugin "${plugin.name}": ${name} is served twice (plugin "${other.plugin}")`);
	}
	for (const name of plugin.registries.keys()) {
		const other = staged.registries.get(name);
		if (other !== undefined) {
			return new Error(`plugin "${plugin.name}": registry ${name} is served twice (plugin "${other.plugin}")`);
		}
	}
	for (const [name, served] of plugin.types) staged.types.set(name, served);
	// 注册表与类型分别合并；同名在各自命名空间内检查，类型名和注册表名可以相同。
	for (const [name, registry] of plugin.registries) staged.registries.set(name, registry);
	staged.plugins.set(plugin.name, plugin);
	return undefined;
}

/** Stages one served entry of `plugin` into its tables: a registry's provider, or a type as `Served`. */
// 根据 entry.kind 把一条声明放入 types 或 registries。无返回；重复服务、provider 形状非法或远程类型条件不满足时抛错。
// host.principal/address 检查是“这台宿主能否承担该类型”的运行时判定，静态类型无法表达。
function stageEntry(
	plugin: string,
	entry: ServedEntry,
	types: Map<string, Served>,
	registries: Map<string, StagedRegistry>,
	host: StagingHost,
): void {
	if (entry.kind === "registry") {
		const { registry, provider } = entry;
		// 同一插件内重复服务同名注册表立即失败；跨插件重名留给 addStaged 报告。
		if (registries.has(registry.name)) throw new Error(`registry ${registry.name} is served twice`);
		// provider 的形状由 registries 内部规则校验，失败直接抛出。
		checkProvider(registry.name, provider);
		registries.set(registry.name, { plugin, registry, provider });
		return;
	}
	const { contract, factory, options } = entry;
	if (types.has(contract.name)) throw new Error(`${contract.name} is served twice`);
	// A client serves only local types (§3): a remote object is owned by a principal of the host serving it.
	if (contract.kind === "remote" && host.principal === undefined) {
		throw new Error(`${contract.name}: a host without a principal serves only local types`);
	}
	// A remote object lives on the host its `hostAddress` names: only a host with an address can be that host.
	if (contract.kind === "remote" && host.address === undefined) {
		throw new Error(`${contract.name}: a host without an address serves only local types`);
	}
	const provider = bindProvider(contract, options.accepts ?? {});
	// ?? 只把 undefined/null 替换为默认值；linger=0 表示对象结束即可回收。
	const common = { plugin, provider, linger: options.linger ?? 0 };
	// The contract's kind decides the factory's signature and the contract's shape.
	// 三元表达式按 kind 收窄 contract；as 断言把宽泛的 Contract 具体到对应分支，运行时不做检查。
	const served: Served =
		contract.kind === "local"
			? {
					...common,
					kind: "local",
					contract: contract as LocalContract,
					factory: factory as Extract<Served, { kind: "local" }>["factory"],
					hostLifetime: contractData(contract).params.fields.length === 0,
				}
			: {
					...common,
					kind: "remote",
					contract: contract as RemoteContract,
					factory: factory as Extract<Served, { kind: "remote" }>["factory"],
				};
	types.set(contract.name, served);
}

/** What a recorded factory declared: what a reload's fate and checks need, nothing activated. */
// 工厂声明的快照。natives 只是打开次数；documents/tables/jobs/contributions 去重后的定义；requests 保留声明顺序。
// 它不包含值、句柄或打开的资源，因此重载可在提交前安全比较旧对象与新工厂。
export type Recorded = {
	/** How many natives it opens (`self.open`). */
	readonly natives: number;
	readonly documents: readonly AnyDefinition[];
	readonly tables: readonly TableDefinition[];
	readonly jobs: readonly JobDefinition<unknown, unknown, unknown>[];
	readonly contributions: readonly Registry<unknown, unknown>[];
	/** Its requests: the types it gets (`self.get`, with their checked params) and the registries it reads (`self.registry`). */
	readonly requests: readonly Request[];
};

/** A recorded request, with the contract version it was made at: a type and its params, or a registry. */
// 可辨识联合：kind 决定携带 contract+params 还是 registry。
// params 已通过 checkParams，是运行时校验后的数据；类型上的 ParamsOf<Contract> 只描述其编译期形状。
export type Request =
	| { readonly kind: "type"; readonly contract: Contract; readonly params: ParamsOf<Contract> }
	| { readonly kind: "registry"; readonly registry: Registry<unknown, unknown> };

/**
 * Runs `served`'s factory for `object` (its params and principal) against a recording `self` and returns what it
 * declared. Every declaration check an attempt makes runs, without effects (declared twice; persisted data in a type
 * without a stable identity, on a host without a store, or claimed by another owner; contributions outside
 * host-lifetime objects, or twice; `retryOn` sources that do not outlive the attempt; params; a document or job
 * declared at an older version than the object's, or at its version with another schema); a throw is the factory's.
 * Handles it hands out are inert, except registry values (the host's own, which `retryOn` checks by kind).
 */
// 在对象位置运行一次工厂并记录声明，供重载判定。输入对象、其服务项和上下文；返回 Recorded，不激活任何东西。
// 副作用：执行插件工厂代码并做与真实尝试相同的声明校验；句柄除注册表值外都是惰性的。错误加上插件与对象标签。
// 示例：const recorded = recordFactory(object, served, ctx); recorded.tables.map((t) => t.name);
export function recordFactory(object: ChordObject, served: Served, context: Context): Recorded {
	const recording = new RecordingSelf(object, served, context);
	// A recording `self` takes every declaration a factory makes, its handles inert.
	// 双重断言是必要的：RecordingSelf 与 StoreSelf 形状不同，但工厂只按 StoreSelf 调用；运行时仍是同一个对象。
	const self = recording as unknown as StoreSelf;
	try {
		// local 工厂接收 (params, self)；remote 还先接收 principal，! 依赖远程对象的身份必然存在。
		if (served.kind === "local") served.factory(object.params, self);
		// A remote object's identity has its principal.
		else served.factory(object.params, object.principal!, self);
	} catch (error) {
		throw named(error, `plugin "${served.plugin}", ${object.label}`);
	} finally {
		// 无论工厂成功还是抛错，离开工厂后都关闭“可声明”窗口，防止异步回调继续声明。
		recording.declaring = false;
	}
	return recording.recorded;
}

/** A staging error naming where it happened (`what`): its message prefixed, the error itself its cause. */
// 包装错误：返回新 Error，message 加位置前缀，原错误放入 { cause }。非 Error 的值用 String 转文本。
// cause 选项让调用方仍能检查原始错误；这里不改变错误类型分类（始终是普通 Error）。
function named(error: unknown, what: string): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`${what}: ${message}`, { cause: error });
}

/**
 * The value of every handle a recording `self` hands out: any property or call gives it again, and it is never a
 * thenable. Typed `never` (a cast: it stands for every handle type, and nothing reads it as one).
 */
// 惰性句柄：Proxy 让任意属性访问/调用都返回自身。then 必须返回 undefined，否则 await 会把它当作 Promise 而挂起。
// 类型是 never（可赋给任何句柄类型），最后的 as never 只是让 Proxy 的结果满足断言。
const INERT: never = new Proxy(() => {}, {
	get: (_target, property) => (property === "then" ? undefined : INERT),
	apply: () => INERT,
}) as never;

/** A factory's `self` during staging: it records declarations and checks them; it activates nothing. */
// 记录型 self。除 registry 返回宿主真实值外，其余声明只入表并返回 INERT。
// declaring 在工厂返回后由 recordFactory 置 false；之后任何声明调用都报“只能在工厂内使用”。
class RecordingSelf {
	declaring = true;
	readonly #object: ChordObject;
	readonly #served: Served;
	readonly #context: Context;
	#natives = 0;
	readonly #documents = new Map<string, AnyDefinition>();
	readonly #tables = new Map<string, TableDefinition>();
	readonly #jobs = new Map<string, JobDefinition<unknown, unknown, unknown>>();
	readonly #contributions = new Map<string, Registry<unknown, unknown>>();
	readonly #requests: Request[] = [];

	constructor(object: ChordObject, served: Served, context: Context) {
		// 保存对象（标签、host、documents 校验器）、服务项（kind/hostLifetime）和上下文（参数校验）。
		this.#object = object;
		this.#served = served;
		this.#context = context;
	}

	get recorded(): Recorded {
		// Map 只用于按名去重；返回值转换成数组，调用方不再受后续声明影响。
		// requests 本身就是数组，直接返回；它已由 checkParams 校验过。
		return {
			natives: this.#natives,
			documents: [...this.#documents.values()],
			tables: [...this.#tables.values()],
			jobs: [...this.#jobs.values()],
			contributions: [...this.#contributions.values()],
			requests: this.#requests,
		};
	}

	/** Declares a document definition; returns an inert handle. Repetition, persistence and schema are checked. */
	// 记录 state 声明。输入定义；返回 never（实际是 INERT，可当任意句柄）。重复名、持久化条件或 schema 非法时抛错。
	// persist 的定义必须使用 chord 命名空间且不被其他 owner 占用，这与真实激活时的检查一致。
	state(definition: AnyDefinition): never {
		// 所有声明入口先确认仍在工厂执行窗口内。
		this.#assertDeclaring("state");
		const what = `state "${definition.name}"`;
		if (this.#documents.has(definition.name)) throw new Error(`${this.#object.label}: ${what} is declared twice`);
		// persist 为真时做 owner 占用检查；非持久定义不需要 store，也不检查 claims。
		if (definition.persist) this.#assertClaimable(what, ["chord"]);
		// documents 校验器检查定义本身（名称、版本、schema 等）；这里不写入任何存储。
		this.#object.documents.check(definition);
		this.#documents.set(definition.name, definition);
		return INERT;
	}

	/** Declares a table; returns an inert handle. Persistence, repetition and the SQL-name claim are checked. */
	// 记录 table 声明。输入定义；返回 inert 句柄。要求本地稳定身份且有 store，表名按对象契约名声明占用。
	table(definition: TableDefinition): never {
		this.#assertDeclaring("table");
		// #assertPersistable 同时保证 host.store 存在，并把 store 返回给 claims 检查。
		const store = this.#assertPersistable(`table "${definition.name}"`);
		if (this.#tables.has(definition.name)) {
			throw new Error(`${this.#object.label}: table "${definition.name}" is declared twice`);
		}
		const object = this.#object;
		// 真实激活时也一样：表名 "对象类型:表名" 由 claims 独占，防止两个对象写同一张 SQL 表。
		store.claims.assertTable(tableSqlName(object.served.contract.name, definition.name), object);
		this.#tables.set(definition.name, definition);
		return INERT;
	}

	derive(): never {
		this.#assertDeclaring("derive");
		return INERT;
	}

	get(Type: Contract, params: unknown): never {
		// get 只记录请求，不进行实际绑定；params 是信任边界，checkParams 返回规范化后的参数。
		this.#assertDeclaring("get");
		const checked = checkParams(Type, params, this.#context);
		// 保存契约与已校验参数，reload 用它判断请求是否仍可满足。
		this.#requests.push({ kind: "type", contract: Type, params: checked.params });
		return INERT;
	}

	registry(R: Registry<unknown, unknown>): RegistryValueSource {
		// 注册表读取与其他声明不同：返回值必须是真实值，retryOn 依赖它的类型；这里取宿主已有的记录。
		this.#assertDeclaring("registry");
		this.#requests.push({ kind: "registry", registry: R });
		// The host's own value (an attempt declares the same one): `retryOn` checks its kind.
		return this.#object.host.registryRecord(R.name).value(R.version);
	}

	writable(): never {
		// 可写视图在工厂里没有实际写入能力；记录阶段只返回惰性句柄。
		this.#assertDeclaring("writable");
		return INERT;
	}

	retryOn(...sources: readonly unknown[]): void {
		// 用与真实安装相同的 retrySource 校验每个源；不订阅、不保存，因为对象尚未激活。
		this.#assertDeclaring("retryOn");
		for (const source of sources) retrySource(source, this.#object.label);
	}

	contribute(R: Registry<unknown, unknown>): void {
		// 贡献只允许本地、空参数（host 生命周期）对象，且同一注册表只能声明一次；记录注册表令牌供重载比较。
		this.#assertDeclaring("contribute");
		const served = this.#served;
		const { label } = this.#object;
		// R21: plugin code is bundled without type checks.
		if (served.kind !== "local" || !served.hostLifetime) {
			throw new Error(`${label}: self.contribute is valid only in a local type with empty params`);
		}
		if (this.#contributions.has(R.name)) throw new Error(`${label}: registry ${R.name} is contributed to twice`);
		this.#contributions.set(R.name, R);
	}

	open(): never {
		// natives 只计数，不真正打开原生资源；重载据此判断是否需要重启。
		this.#assertDeclaring("open");
		this.#natives++;
		return INERT;
	}

	tx(): never {
		// 事务只能在实际调用期间开启；工厂阶段没有调用上下文，因此无条件拒绝。
		throw new Error(`${this.#object.label}: self.tx runs in calls, not in a factory`);
	}

	follow(): never {
		// 跟随请求同样只记录惰性句柄；真正订阅发生在激活后的调用作用域。
		this.#assertDeclaring("follow");
		return INERT;
	}

	on(): void {
		// 事件订阅在工厂中声明但不注册；这里只检查声明窗口。
		this.#assertDeclaring("on");
	}

	onLive(): void {
		// onLive 回调注册延迟到对象激活；暂存阶段只做窗口检查。
		this.#assertDeclaring("onLive");
	}

	job(definition: JobDefinition<unknown, unknown, unknown>): never {
		// 记录 job 声明；重复名、持久化 claims 与定义合法性都在提交前检查，和真实激活一致。
		this.#assertDeclaring("job");
		const object = this.#object;
		if (this.#jobs.has(definition.name))
			throw new Error(`${object.label}: job "${definition.name}" is declared twice`);
		if (definition.persist !== undefined) {
			this.#assertClaimable(`job "${definition.name}"`, ["chord.jobs", "chord.job-states"]);
		}
		object.checkJob(definition);
		this.#jobs.set(definition.name, definition);
		return INERT;
	}

	/** Persisted data needs a stable identity (P3) and the host's store, as an attempt checks; returns the store. */
	// 返回宿主 store 或抛错：持久化只允许本地、参数为空的类型（稳定身份），且宿主必须配置了 store。
	// 该检查与实际激活共享同一规则，避免暂存通过而运行期失败。
	#assertPersistable(what: string): ChordStore {
		const served = this.#served;
		const { host, label } = this.#object;
		if (served.kind !== "local" || contractData(served.contract).params.fields.length > 0) {
			throw new Error(`${label}: ${what}: persist needs a stable identity (a local type with empty params)`);
		}
		if (host.store === undefined) throw new Error(`${label}: ${what}: persist needs a store`);
		return host.store;
	}

	/** Persisted documents in `namespaces`: as `#assertPersistable`, and not claimed by another owner. */
	// 在 #assertPersistable 之上检查每个命名空间的文档 claim；无返回，被其他 owner 占用时抛错。
	// 例如持久文档命名空间 chord 被本对象占用后，另一个对象再声明同一命名空间会在暂存阶段失败。
	#assertClaimable(what: string, namespaces: readonly string[]): void {
		const store = this.#assertPersistable(what);
		const object = this.#object;
		for (const namespace of namespaces) store.claims.assertDocuments(object.served.contract.name, namespace, object);
	}

	#assertDeclaring(declaration: string): void {
		// 只允许同步工厂执行期间声明；异步回调在 declaring=false 后调用会得到明确错误。
		if (!this.declaring) throw new Error(`${this.#object.label}: self.${declaration} is valid only in the factory`);
	}
}

/**
 * Whether `recorded`'s tables are at a version newer than `object`'s store has them: their eager migration runs at an
 * activation, so the object restarts instead of swapping (§4).
 */
// 判断记录中的表是否需要先迁移。输入对象与工厂声明；返回布尔值，无副作用。
// 没有 store 时永远 false（对象本来就不能持久化）；只比较已存在且版本更旧的表，新表可直接创建。
// 示例：已存 notes:items 版本 1，工厂声明版本 2 -> true，重载将选择 restarted 而非 swapped。
export function migratesTables(object: ChordObject, recorded: Recorded): boolean {
	const { store } = object.host;
	if (store === undefined) return false;
	const owner = object.served.contract.name;
	// some 短路：只要有一张表需要迁移就返回 true；stored 不存在表示全新表，不触发重启。
	return recorded.tables.some((table) => {
		const stored = store.table(tableSqlName(owner, table.name));
		return stored !== undefined && stored.version < table.version;
	});
}
