// The member check (Q14): an implementation is one variant with exactly that variant's members, methods being
// functions and state members JSON watchables; and the resolution of what Chord follows behind every derive's declared
// sources (JSON and native) and every contribution to a registry (slice 8).
//
// The rule for watches across attempts (decision "References are the only indirection"): consumers' watches and
// derives over another object's member follow it through their reference's member (`reference-source.ts`) and keys
// (`reference-keys.ts`), passed straight through to the instance's own document or derive. While the object points at
// nothing they keep their last values (one `failed` call for a failure); when a new instance goes live they move by
// name to its member (a key pinned there again), whether a document or a derive: one frame from the last value, and
// every derive downstream recovers (decision "self healing"). A re-exposed member is the re-exposing object's
// reference member: it holds with that object, its provider's source goes on. Holds over a link follow the live
// instance's members and take a snapshot at each binding.

// 所属：packages/chord/src/host 的成员检查与派生源解析模块。
// 职责边界：检查插件工厂返回值的运行时外形（不是类型层校验），并把声明中的状态/派生/贡献值转换成 Chord 可跟随的源。
// 上游：attempt.ts 激活时调用 checkImplementation 与 attachDerives；host.ts 发布插件时调用 contributionOf。
// 下游：Members 三张表供方法调用、状态跟随和 keyed 访问；解析后的源进入 derive 图；RegistryContribution 进入注册表。
// 结果与错误：检查失败抛普通 Error（由激活路径包装成对象失败原因）；诊断消息包含变体/成员名，不执行插件方法。
// 能力清单：
// - Members：检查通过后的 methods/state/keyed 三张表。
// - KeyedBinding：keyed 成员的两种来源 own（本对象 slot）与 reexposed（经引用重新暴露）。
// - Method：内部统一的方法签名 (args, context) => Promise<unknown>。
// - checkImplementation：按契约变体检查工厂返回值，返回 { variant, members }。
// - attachDerives：解析每个 derive 的声明源并挂接，报告函数按暴露成员名定位错误。
// - contributionOf：把注册表贡献值分类为 json/native/plain 并创建记录。
// 组合与典型顺序：工厂返回实现 -> checkImplementation（内部 checkMembers）建立三表 -> attachDerives 解析 derive ->
// 对象 live 后 contributionOf 在发布阶段建立贡献。成员检查与派生挂接都在首次激活的同一阶段发生。
// 示例：const { variant, members } = checkImplementation(Counter, { count: doc, bump() {} });
//       attachDerives(declaredDerives, members.state, (member) => (error) => report(error));
// 建议阅读顺序：Members/KeyedBinding/Method -> checkImplementation -> checkMembers -> attachDerives -> contributionOf/contentOf。

import type { Context } from "../context/index.ts";
import type { Contract } from "../contracts/index.ts";
import { currentVariants, LOCAL, takesNoArgs, type VariantData } from "../contracts/internal.ts";
import type { KeyedSlot } from "../documents/internal.ts";
import {
	type ContributionContent,
	type Contributor,
	RegistryContribution,
	type RegistryRecord,
} from "../registries/internal.ts";
import { type Derive, type DeriveInput, type DeriveSource, NativeSource } from "../state/internal.ts";
import { type Binding, resolveKeyed, resolveWatchable } from "./reference.ts";

/** A checked implementation, as Chord calls and follows it. */
// 检查通过后的实现视图。三张表都按成员名索引，但值的种类不同；这些字段是编译期类型，
// 表的内容由 checkMembers 在运行时建立。
export type Members = {
	/** The methods, each called with its arguments (`null` for none) and a context. */
	// 方法表：值是包装后的函数，统一接收 (args, context)；无参方法在包装里忽略 args。
	readonly methods: ReadonlyMap<string, Method>;
	/** The state members, resolved to what Chord follows. */
	// 状态成员表：值已解析为 Chord 可跟随的源（文档句柄、引用成员、Source/Constant），不是原始返回值。
	readonly state: ReadonlyMap<string, DeriveSource>;
	/** The keyed members (slice 6a §12): the object's own slot, or the provider's member it re-exposes. */
	// keyed 成员表：值是对象自己的 KeyedSlot，或通过引用重新暴露的成员绑定。
	readonly keyed: ReadonlyMap<string, KeyedBinding>;
};

/**
 * What a keyed member is: a keyed document handle's slot (`own`), or another object's keyed member re-exposed through
 * a reference (`reexposed`), which reads end at the ultimate provider's slot (rule 22) and pinned keys follow.
 */
// 可辨识联合：kind 为 own 时带本对象的 KeyedSlot；kind 为 reexposed 时带引用绑定与成员名，
// 读取会沿引用走到真正提供者的 slot。判别字段 kind 让 TypeScript 在分支内收窄可用字段。
export type KeyedBinding =
	| { readonly kind: "own"; readonly slot: KeyedSlot }
	| { readonly kind: "reexposed"; readonly binding: Binding; readonly member: string };

/** A method as Chord calls it. */
export type Method = (args: unknown, context: Context) => Promise<unknown>;
// unknown 表示内部未恢复具体契约的输入/输出；实际参数验证在调用路径的 checkArgs，不能靠这个别名完成。

/**
 * Checks what a factory returned (plugin code): a local contract's members, or a remote contract's `{ variant,
 * members }` naming one of its current variants. Errors name the variant or member (the failure cause adds the
 * object).
 */
// 检查插件工厂交回的实现，输入契约和 unknown 返回值，输出选定变体与规范化成员表；不执行成员方法。
// 本地类型直接检查成员，远程类型先选 variant。例：声明 count 却返回 extra，会抛出成员错误使激活失败。
// 这里只校验成员外形及 Chord 源的身份，不验证状态值的 JSON schema 或调用结果。
export function checkImplementation(
	contract: Contract,
	implementation: unknown,
): { readonly variant: string | undefined; readonly members: Members } {
	const variants = currentVariants(contract);
	// 契约内部当前版本提供预先声明的变体；本地类型只有内部 LOCAL 这一项。
	if (contract.kind === "local") {
		// The member check establishes the shape.
		return { variant: undefined, members: checkMembers(variants.get(LOCAL)!, implementation as Implementation) };
	}
	// Plugin code: a remote factory returns `{ variant, members }`, which the checks below establish.
	const { variant, members } = implementation as { readonly variant: string; readonly members: Implementation };
	// as 不做运行时转换；这里信任插件返回可解构值，未知变体仍由 Map 查找拒绝。
	const data = variants.get(variant);
	if (data === undefined) throw new Error(`variant ${JSON.stringify(variant)}: not a variant of ${contract.name}`);
	return { variant, members: checkMembers(data, members) };
}

type Implementation = { readonly [member: string]: unknown };
// 索引签名允许按成员名访问，readonly 只限制开发期写法，不冻结工厂对象。

/**
 * Checks members against a variant's (exactly its members, methods being functions, state members JSON watchables and
 * keyed members keyed document handles); a method without arguments is called with the context alone.
 */
// 按一个变体逐项检查：多余成员拒绝，缺失成员在各自检查中拒绝，返回三张 Map。
// 例如无参 bump 被适配成内部统一的 (args,context) 接口，但真正调用插件时仅传 context。
// 检查会创建包装回调和表，错误向上传播；不会复制或验证状态源里的值。
function checkMembers({ state, methods, keyed }: VariantData, implementation: Implementation): Members {
	// Object.keys 只枚举自身可枚举字符串属性；每个返回名都须在三类声明之一中。
	for (const member of Object.keys(implementation)) {
		if (!state.has(member) && !methods.has(member) && !keyed.has(member)) throw new Error(`${member}: not a member`);
	}
	// Own properties only: an inherited `toString` is no implementation of a member named so.
	const own = (member: string): unknown =>
		// 即便原型有同名属性也不能充当实现；缺失统一得到 undefined，由下方分类检查报错。
		Object.hasOwn(implementation, member) ? implementation[member] : undefined;
	const checked = {
		// Map 的类型参数约束登记值；三张表分别保留方法、普通状态源与 keyed 绑定。
		methods: new Map<string, Method>(),
		state: new Map<string, DeriveSource>(),
		keyed: new Map<string, KeyedBinding>(),
	};
	for (const [member, data] of methods) {
		// 逐个声明寻找实现，因此声明了但未返回的方法也会触发下面的函数检查。
		const method = own(member);
		if (typeof method !== "function") throw new Error(`${member}: a method is a function`);
		// 工厂返回值是插件边界 unknown，typeof 在这里承担真实运行时检查。
		// 有参方法保留参数与上下文；这里仅创建包装，不在检查阶段运行插件；无参方法只接收 context。
		const call: Method = takesNoArgs(data)
			? (_args, context) => method(context)
			: (args, context) => method(args, context);
		checked.methods.set(member, call);
	}
	for (const member of state.keys()) {
		// 解析 Chord 自己的文档句柄、引用成员、Source/Constant；NativeWatchable 不可作为 JSON 状态成员。
		const source = resolveWatchable(own(member));
		if (source === undefined) throw new Error(`${member}: a state member is a JSON watchable`);
		// 仅保存解析到的源，后续订阅由激活流程处理。
		checked.state.set(member, source);
	}
	for (const member of keyed.keys()) {
		// keyed 成员只接受 keyed 文档句柄或重新暴露的引用成员，不接受普通单值状态源。
		const resolved = resolveKeyed(own(member));
		if (resolved === undefined) throw new Error(`${member}: a keyed member is a keyed document handle`);
		checked.keyed.set(member, resolved);
	}
	return checked;
}

/**
 * Resolves every derive's sources; errors name a derive by the member exposing it, else by its position. `report`
 * makes each derive's failure report, with the member exposing it when there is one (`derive_failed`).
 */
// 把各 derive 的声明源解析成内部输入并挂接，输入还含公开状态表和报告函数工厂；无返回值。
// 例如 count 暴露一个 derive，源无效时报错会命名 count；未暴露的 derive 则用声明位置命名。
// attach 可能抛错使首次激活失败，运行中失败通过给定 report 回调报告。
export function attachDerives(
	derives: readonly Derive[],
	state: ReadonlyMap<string, DeriveSource>,
	report: (member: string | undefined) => (error: unknown) => void,
): void {
	const exposed = new Map<DeriveSource, string>([...state].map(([member, source]) => [source, member]));
	// 上行把“名字→源”反过来；同一源暴露多次时 Map 留最后一个名字，仅用于诊断。
	derives.forEach((derive, position) => {
		// position 从 0 起，展示给人的位置加 1；?? 只在没有公开名字时采用备用名。
		const member = exposed.get(derive);
		const name = member ?? `derive #${position + 1}`;
		const resolve = (source: unknown, index: number): DeriveInput => {
			// derive 允许 JSON 源，也允许进程内原生源，范围比状态成员更宽。
			const resolved = resolveWatchable(source) ?? (source instanceof NativeSource ? source : undefined);
			if (resolved === undefined) throw new Error(`${name}: source ${index} is not a Chord watchable`);
			// 成功后交回源，不复制其当前值。
			return resolved;
		};
		derive.attach(resolve, report(member));
	});
}

/**
 * A contribution of `contributor` at `version` to `record`, as Chord follows it: a Chord watchable (a source, a
 * constant, a document handle, a reference member, a native source: another registry's value too) is followed,
 * anything else is a plain value, whatever methods it has (registries carry natives).
 */
// 为指定注册表、贡献者和版本创建一条贡献记录；value 可以是普通值或 Chord 可观察源。
// 返回记录，尚未在此 follow 或发布。例：普通路由对象按 plain 保存，writable 则按 native 源保存。
export function contributionOf(
	record: RegistryRecord,
	contributor: Contributor,
	version: number,
	value: unknown,
): RegistryContribution {
	// contentOf 只识别自身源类型；构造器记录元数据，后续注册表表格读取贡献值。
	return new RegistryContribution(record, contributor, version, contentOf(value));
}

/** What Chord follows behind a contribution: its JSON or native source when it is a Chord watchable. */
// 把 unknown 贡献值分类，无外部副作用：原生源优先，其余尝试 JSON 源，否则原样作为 plain。
// 例如普通对象即便有 watch 方法也不会被当成 Chord 源，避免误调用其他库的接口。
function contentOf(value: unknown): ContributionContent {
	// instanceof 是此 unknown 插件输入边界上的类型识别，不是对已知内部参数的防御校验。
	if (value instanceof NativeSource) return { kind: "native", source: value };
	const source = resolveWatchable(value);
	// 三元表达式返回带 kind 标签的联合值，后续读取者依据标签选择取值方式。
	return source === undefined ? { kind: "plain", value } : { kind: "json", source };
}
