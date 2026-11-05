// Registry tokens (design §17, slice 8 D1): `defineRegistry`, shared by every plugin as a contract is (identity and
// types only), and what the defining plugin's facet serves it with (`compose`, `accepts`); the table `compose` gets and
// the composed value readers follow.

// 文件导读
// 所属包与模块：packages/chord/src/registries 的注册表契约模块（design §17，slice 8 D1），属于 Chord 注册表层。
// 职责边界：只定义 token、provider、表、合成上下文与读者值接口，以及唯一创建入口 defineRegistry；
// 不保存 host 状态（RegistryRecord 负责），不执行合成（provider.compose 负责）。
// 上游：定义者插件调用 defineRegistry 并从其 facet 通过 host.serve 提交 provider；贡献者把值交给 host。
// 下游：RegistryRecord 按 token 汇集贡献并调用 compose；读者拿到 RegistryValue 后 watch/observe。
// 错误流向：defineRegistry 对名称和版本做声明策略检查并抛普通 Error；其余类型无运行时校验，
// provider.compose 的抛错由 RegistryRecord 捕获并转为 registry_failed。
// 能力清单：
// - Registry<C,V>（类型）：跨插件共享的 token，含 name、version 与仅编译期的 ~types。
// - RegistryEntry<C>/RegistryTable<C>（类型）：表项与只读表。
// - RegistryConflict/ComposeContext（类型）：冲突描述与 compose 的 report 上下文。
// - RegistryAccepts<C,V>（类型）：旧版本 contribution/value 适配表。
// - RegistryProvider<C,V>（类型）：定义者插件提供的 compose 与可选 accepts。
// - Contribution<C>/RegistryValue<V>（类型）：可贡献的三种值，以及读者看到的原生 watchable。
// - defineRegistry（函数）：创建 token 的运行时入口。
// 组合关系与典型调用顺序：defineRegistry 建 token -> 定义者 serve(provider) -> 贡献者 add 贡献 ->
// 表变脏 -> 读取或跟随时 record 调用 provider.compose -> 读者通过 RegistryValue 拿到 V。
// 示例（真实签名）：type Route = { path: string };
// const R = defineRegistry<Route, readonly Route[]>("routes", { version: 1 });
// 建议阅读顺序：先读 Registry/RegistryEntry/RegistryTable 理解数据，再看 Provider/Accepts 理解兼容，
// 然后 Contribution/RegistryValue 与阅读路径，最后 defineRegistry 的检查。

import type { Context } from "../context/index.ts";
import { checkName } from "../contracts/names.ts";
import type { NativeObservation, NativeObserver } from "../state/index.ts";
import type { NativeWatchable, Watchable } from "../watch.ts";

/**
 * A registry token: its name (as type names, `[a-z0-9@/._~-]`), the version the bundling plugin was built against, the
 * contribution type `C` and the composed value type `V`. Shared: every contributor and reader bundles its own copy.
 */
// token 类型：C 是贡献类型，V 是合成后的值类型，都只存在于编译期。
// "~types" 是可选属性且没有运行时值，用来携带 C -> V 的类型关系（一种“幻影字段”），
// 使 token 在类型检查中同时约束提供者与读者，而不增加对象属性。
export type Registry<C, V> = {
	readonly kind: "registry";
	readonly name: string;
	readonly version: number;
	/** Type only: `C` in, `V` out. */
	readonly "~types"?: (contribution: C) => V;
};

/** One contribution in a registry's table: its plugin, its object type for an object contributor, its version. */
// 表项：value 是贡献值本身；plugin 是贡献者名称（冲突时用于排序/报告）；
// type 仅对象贡献者才有；version 是贡献者编译时使用的注册表版本（较旧值会被适配为 C）。
export type RegistryEntry<C> = {
	readonly plugin: string;
	/** The contributing object's type; absent for a facet. */
	readonly type?: string;
	/** The registry version its contributor was built against (an older one adapted to `C`). */
	readonly version: number;
	readonly value: C;
};

/** A registry's table: one entry per live contributor, sorted by plugin name, then type (a facet's first). */
// readonly 只约束类型层：运行时的数组仍可被写入，排序结果由 record.ts 保证。
export type RegistryTable<C> = readonly RegistryEntry<C>[];

/** A conflict `compose` resolved with its fallback: reported as `registry_conflict`, once per conflict episode. */
// 冲突描述：message 供日志阅读，plugins 列出参与的插件名（至少两个）。
// “once per conflict episode” 的去重由 RegistryRecord 负责，compose 只需调用 report。
export type RegistryConflict = { readonly message: string; readonly plugins: readonly string[] };

/** What `compose` gets besides the table. */
// compose 的上下文：目前只有 report；未来扩展也应加在这里，避免改 compose 签名。
export type ComposeContext = {
	/** Reports a conflict `compose` resolved (the first by plugin name wins, for example). */
	// 示例：context.report({ message: "duplicate path /a", plugins: ["a", "b"] });
	report(conflict: RegistryConflict): void;
};

/**
 * Adapters of older versions, by version, the provider's code: `contribution` maps an older contribution to `C` (once
 * per contribution value), `value` maps the composed value back for a reader of that version (once per composition).
 * A plugin annotates the old contribution's type (`(old: HttpV1) => upgrade(old)`).
 */
// 旧版本适配表：以版本号为键（数字索引签名）。
// contribution：把旧版贡献升到当前 C；old 参数类型声明为 never，要求调用方在自己的注解里写明实际旧类型。
// value：把当前合成值降级为旧读者能理解的形式；返回 unknown，调用方负责断言/收窄。
// 两个函数分别按“每个贡献值一次”和“每次合成一次”缓存，见 contribution.ts/value.ts。
export type RegistryAccepts<C, V> = {
	readonly [version: number]: {
		readonly contribution?: (old: never) => C;
		readonly value?: (current: V) => unknown;
	};
};

/** What the defining plugin's facet serves a registry with (`host.serve(R, provider)`). */
// provider 由定义者插件提交；compose 必须是纯同步函数并总是返回值（错误用 fallback 兜底）。
// accepts 可选，仅当存在旧版本贡献者/读者时需要。
export type RegistryProvider<C, V> = {
	/**
	 * Composes the table: pure and synchronous, always a value (a fallback built in), conflicts reported. Runs when the
	 * table changed and someone reads or follows the value; a throw is the owner's bug (`registry_failed`, the last
	 * good composition stays).
	 */
	// compose 的输入是当前表（已按 plugin/type 排序）与上下文；输出 V。
	// 副作用只能通过 context.report；抛错会被记录为 registry_failed，并保留上一次好合成值。
	readonly compose: (table: RegistryTable<C>, context: ComposeContext) => V;
	readonly accepts?: RegistryAccepts<C, V>;
};

/** What a contributor contributes: a plain value, or a Chord watchable of one (followed: its change recomposes). */
// 联合类型：直接值不会变化；Watchable/NativeWatchable 会被跟随，值变化时重新合成。
// 运行时通过 instanceof/形状判断区分（见 contribution.ts），类型层只给出三种可能。
export type Contribution<C> = C | Watchable<C> | NativeWatchable<C>;

/**
 * A registry's composed value as a reader of one version sees it (`self.registry`, `host.registry`): a native
 * watchable; `.value` is the last good composition (a later throwing `compose` keeps it), a watch gets each new one.
 */
// 读者看到的合成值接口：extends NativeWatchable<V> 提供 value/watch；
// 额外提供同步 observe（Durable 风格），便于注册表内部/链路立即拿到当前值。
export interface RegistryValue<V> extends NativeWatchable<V> {
	/**
	 * A synchronous observer of its compositions (as Durable's `observeXXX`): `advance` runs inside the batch that
	 * composed, so it only records; an attached observer counts as watching, so the composition runs for it.
	 */
	// observe 的输入是观察者与上下文，返回初值 + detach；观察者存在期间被视为“有人读取”，会触发惰性合成。
	// 示例：const seen = value.observe({ advance(call) { log(call); }, end(end) { log(end); } }, context);
	observe(observer: NativeObserver<V>, context: Context): NativeObservation<V>;
}

/** Declares a registry token: `name` and the `version` this plugin is built against. */
// 创建 token 的运行时函数。输入 name（会校验字符集）与 options.version（正整数）。
// 返回普通对象 {kind,name,version}；"~types" 字段不写入运行时。
// 示例：const R = defineRegistry<Route, RouteTable>("routes", { version: 2 })。
// 错误路径：名称非法或版本不是 >=1 的安全整数时抛普通 Error（声明策略，JS 调用方也会触发）。
export function defineRegistry<C, V>(name: string, options: { readonly version: number }): Registry<C, V> {
	// 名称规则与对象类型/表名共用：小写 npm 包名字符，保证拼进 SQL 标识时无歧义。
	checkName(name, "registry");
	const { version } = options;
	// Declaration policy: JavaScript callers reach this check.
	// 版本决定跨插件兼容：安全整数避免精度问题，>=1 保留 0 作为“无版本”的保留值。
	if (!Number.isSafeInteger(version) || version < 1) throw new Error(`${name}.version: expected a positive integer`);
	// 不冻结对象：token 是按约定只读的普通数据，身份由值（name/version）而非引用决定。
	return { kind: "registry", name, version };
}
