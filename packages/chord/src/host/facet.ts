// Facets (§16): a plugin's setup for one host, typed by the app's principal type. A setup only declares: the types and
// registries it serves, its contributions to registries (slice 8) and the host's presence lists; it has no documents,
// routines or natives, so a facet cannot fail after `load`.
// 文件导读
// 所属：packages/chord/src/host（主机层），实现插件 facet 的声明与收集。
// 职责：给 setup 一个受限的 host/self，收集 serve 的类型/注册表与 contribute 的值；setup 结束后禁止再声明。
// 边界：不实例化对象、不组合注册表、不校验 accepts（由加载器/checkAccepts 负责）。
// 上游：插件用 defineFacet 定义；加载器调用 setUp(name, facet, references)。
// 下游：宿主消费 served/contributions；host.references 直接复用宿主的 presence 列表。
// 错误：setup 抛错原样上抛；重复 serve 注册表在 load 检查，重复 contribute 在 setUp 内抛错；setup 后调用声明抛 Error。
// 能力清单：
// - FacetHost<P>：serve 的契约/注册表重载与 references。
// - ServeOptions<C>：accepts 旧版本映射与 linger 保活时间。
// - FacetSelf：向注册表 contribute。
// - ServedEntry / FacetContribution：收集结果的两类条目。
// - Facet<P> / defineFacet：定义 facet 与幻影 principal 类型。
// - setUp：执行一次 setup 并返回按顺序收集的结果。
// 组合与顺序：defineFacet -> setUp -> assertOpen -> serve/contribute -> finally open=false -> 返回列表。
// 示例：const facet = defineFacet<AppPrincipal>((host, self) => {
//          host.serve(Counter, factory); self.contribute(Settings, { theme: "dark" });
//        });
//        const { served, contributions } = setUp("counter-plugin", facet, references);
// 建议阅读顺序：FacetHost/ServeOptions -> FacetSelf -> ServedEntry -> Facet/defineFacet -> setUp。

import type { AcceptsTable, Contract } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import type { Contribution, Registry, RegistryProvider } from "../registries/index.ts";
import type { Watchable } from "../watch.ts";
import type { Factory } from "./attempt.ts";
import type { Presence } from "./presence.ts";

/** What a setup serves types and registries with (valid only while the setup runs), and the host's presence lists. */
// setup 拿到的宿主接口，只在 setup 同步执行期间有效。P 是应用身份类型，默认 Principal。
// 泛型与重载都只在开发期约束；运行时由 setUp 里的 assertOpen 检查调用时机，并按 kind 分派。
export interface FacetHost<P extends Principal = Principal> {
	// 接口只有开发期类型约束，不生成运行时校验；下面两个 serve 签名是同名重载，setUp 中按 kind 分派。
	/**
	 * Serves a type on this host with `factory`; a remote type's factory gets the principal its object is for.
	 * `options.accepts` maps the older versions it still serves (checked here: a declaration error rejects the load or
	 * the reload).
	 */
	// 服务一个契约：factory 每次激活时执行，返回实现；远程契约的 factory 额外收到对象身份里的 principal。
	// options.accepts 声明仍兼容的旧版本及映射，加载时由 checkAccepts 检查，声明错误会让 load/reload 失败。
	// 例：host.serve(Counter, (params, self) => ({ methods: { ... } }));
	serve<C extends Contract>(Type: C, factory: Factory<C, P>, options?: ServeOptions<C>): void;
	/**
	 * Serves registry `R` on this host (its defining plugin's facet, the one provider, D1): `compose` builds the value
	 * from the table, `accepts` adapts older versions. A second serve of a registry is refused at `load`.
	 */
	// 服务一个注册表：只能由定义它的插件提供（唯一 provider）；compose 把贡献表组合成值，accepts 适配旧版本。
	// 同名注册表第二次 serve 会在 load 时被拒绝，而不是在这里抛错。
	// 例：host.serve(Settings, { compose: (rows) => ..., accepts: { ... } })。
	serve<C, V>(R: Registry<C, V>, provider: RegistryProvider<C, V>): void;
	/** `host.references(Type)`: the references to objects of `Type` on this host (§19), for factories to derive from. */
	// 读取本机上某类型的引用/presence 列表（只读 watchable）；工厂可把它作为 derive 源。
	// 它不按 principal 过滤，过滤由调用方的 derive 完成。
	references<C extends Contract>(Type: C): Watchable<readonly Presence<C, P>[]>;
}

/** What `host.serve` takes besides the type and the factory. */
// 对象服务的可选配置；两个字段都是声明数据，不做运行时形状检查（checkAccepts 会检查 accepts）。
export type ServeOptions<C extends Contract = Contract> = {
	/**
	 * The older versions of `C` this provider still binds, with the mappings their edits need (Q10, `checkAccepts`):
	 * an older consumer's state members mapped per binding, its calls' arguments and results mapped.
	 */
	// 仍兼容的旧版本及迁移映射：旧消费者的状态成员按绑定映射，调用参数与结果也映射。
	// 未列出的版本会在绑定时得到 contract_mismatch。
	readonly accepts?: AcceptsTable<C>;
	/**
	 * How long, in milliseconds, a live object with params stays live after its last reference is released (0 by
	 * default): a reference within that time reuses it, with its documents and dependencies.
	 */
	// 最后一个引用释放后，带参数对象继续保持 live 的毫秒数；默认 0 表示立即结束。
	// linger 期间对象仍占着文档和依赖，换来短期重连不重新激活。
	readonly linger?: number;
};

/** What a facet's setup declares with besides the host: its contributions to registries (R21). */
// setup 的第二个参数：只提供 contribute。与 host.serve 一样，只在 setup 期间可调用。
export interface FacetSelf {
	/**
	 * Contributes `value` to registry `R` while this plugin is loaded: a plain value, or a Chord watchable of one
	 * (followed: its change recomposes). At most one per registry.
	 */
	// 向注册表贡献一个值：普通 JSON 值，或 Chord watchable（其变化触发重新组合）。
	// 同一注册表最多贡献一次，重复按名字检查并抛错。
	// 例：self.contribute(Settings, { theme: "dark" })。
	contribute<C>(R: Registry<C, unknown>, value: Contribution<C>): void;
}

/** What a setup served, by kind: a type (its contract, factory and options), or a registry (its provider). */
// setup 期间收集到的一项服务，用 kind 区分两种形态。factory/options 与 provider 字段只在对应分支存在。
export type ServedEntry =
	// kind 是可辨认联合的标签：检查 kind 后 TypeScript 知道本项是对象工厂还是注册表提供者。
	| {
			readonly kind: "type";
			readonly contract: Contract;
			readonly factory: ServedFactory;
			readonly options: ServeOptions;
	  }
	| {
			readonly kind: "registry";
			readonly registry: Registry<unknown, unknown>;
			readonly provider: RegistryProvider<unknown, unknown>;
	  };

/** A contribution a setup declared. */
// 一项待写入注册表的贡献。registry 与 value 在声明时尚未组合或校验，由加载器稍后处理。
export type FacetContribution = { readonly registry: Registry<unknown, unknown>; readonly value: unknown };

/** A factory as a setup served it, of either kind (the host dispatches on its contract's kind). */
type ServedFactory = (params: never, principalOrSelf: never, self: never) => unknown;

// never 参数让未恢复具体契约的内部函数不能随意被调用；它不意味着实际工厂永远不接收参数。

/** A plugin's facet for hosts of the app's principal type `P` (type only: nothing is checked at runtime). */
// 一个插件针对身份类型 P 的 facet。setup 是同步声明函数；"~principal" 是幻影字段（phantom field）。
// 它从不出现在运行时对象里，只让 P 同时出现在参数与返回值位置，形成不变性（invariance），
// 使宿主不能把为别的 P 写的 facet 混用进来。
export type Facet<P extends Principal> = {
	readonly setup: (host: FacetHost<P>, self: FacetSelf) => void;
	/** Type only: the principal type, invariant, so a host takes only facets typed for exactly its `P`. */
	readonly "~principal"?: (principal: P) => P;
};

/** Defines a facet; base code binds `P` once, next to its principal type. */
// 定义一个插件在宿主上的声明函数；输入 setup，返回仅包含它的对象，不在这里执行 setup。
// P extends Principal 约束身份类型，具体应用可固定 P。例：defineFacet((host) => host.serve(Store, factory))。
// 例子只表示声明方式；真正登记发生在加载器稍后调用 setUp 时，无初始化资源的副作用。
export function defineFacet<P extends Principal>(setup: (host: FacetHost<P>, self: FacetSelf) => void): Facet<P> {
	// 对象简写 { setup } 等价于 { setup: setup }，保留原回调引用。
	return { setup };
}

/**
 * Runs a facet's setup and returns the types and registries it served and its contributions, in order; `references`
 * is the host's.
 */
// 执行一次 facet setup。输入：插件名（用于错误消息）、facet、宿主的 references 函数；
// 输出：按声明顺序排列的 served 与 contributions（只读类型，数组未冻结）。
// 主流程：建两个收集数组与 open 开关 -> 构造受限 host/self -> 同步调用 setup -> finally 关闭声明 -> 返回结果。
// 错误：setup 或声明检查抛错时原样向上抛，finally 仍执行；已收集项不回滚，由加载器整体丢弃。
// 例：setUp("notes", facet, references) 返回 { served: [{ kind: "type", ... }], contributions: [] }。
export function setUp<P extends Principal>(
	name: string,
	facet: Facet<P>,
	references: <C extends Contract>(Type: C) => Watchable<readonly Presence<C, P>[]>,
): { readonly served: readonly ServedEntry[]; readonly contributions: readonly FacetContribution[] } {
	// 执行一次同步 setup，按声明顺序收集服务与贡献；返回只读视图类型，但数组并未运行时冻结。
	// 例如先 serve 再 contribute 会分别进入两个列表，后续发布由宿主负责，本函数不创建被服务对象。
	// setup 或声明检查抛错时继续向外传播，finally 仍关闭声明入口。
	const served: ServedEntry[] = [];
	// 每次调用有独立列表，避免不同插件的声明混在一起。
	const contributions: FacetContribution[] = [];
	// 闭包共享此开关；setup 结束后，插件保存的 host/self 也不能继续声明。
	let open = true;
	const assertOpen = (what: string): void => {
		// 这是声明时机的运行时规则：类型系统不能阻止插件把函数保存到 setup 之后调用。
		if (!open) throw new Error(`${name}: ${what} is valid only in the facet's setup`);
	};
	// 结构化类型：对象只要满足 FacetHost 的成员即可，不需要显式 implements；两个 serve 共用一个实现。
	const host: FacetHost<P> = {
		serve: (Type: Contract | Registry<unknown, unknown>, implementation: unknown, options: ServeOptions = {}) => {
			// 默认空选项只用于对象服务；先校验调用仍位于 setup。
			assertOpen("host.serve");
			// Served types and registries are dispatched by their kind; a factory matches its own contract, a provider
			// its own registry.
			if (Type.kind === "registry") {
				// 记录注册表令牌与实现。as 只恢复上面重载承诺的配对类型，不校验 provider 内容。
				served.push({
					kind: "registry",
					registry: Type,
					provider: implementation as RegistryProvider<unknown, unknown>,
				});
			} else {
				// 对象契约保留工厂与选项，工厂尚未执行。
				served.push({ kind: "type", contract: Type, factory: implementation as ServedFactory, options });
			}
		},
		references,
	};
	const self: FacetSelf = {
		contribute: (registry, value) => {
			// 同一插件对同名注册表只能贡献一次，以名字比较而不是令牌对象身份。
			assertOpen("self.contribute");
			if (contributions.some((each) => each.registry.name === registry.name)) {
				// some 的回调只检查名字；发现重复立即抛错，中止本次 setup。
				throw new Error(`${name}: registry ${registry.name} is contributed to twice`);
			}
			contributions.push({ registry: registry as Registry<unknown, unknown>, value });
		},
	};
	try {
		// 把受限的声明接口交给插件，插件代码的同步异常不在此吞掉。
		facet.setup(host, self);
	} finally {
		// 无论成功还是抛错，都撤销声明权限；不回滚插件自己的其他外部副作用。
		open = false;
	}
	// 数组引用直接交出；返回值中的 readonly 只在开发期阻止调用方 push。
	return { served, contributions };
}
