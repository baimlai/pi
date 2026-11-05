// Evolution: `evolve(previous, (e) => e...)` appends the next version of a history with structured edits.

// 文件导读
// 所属模块：packages/chord/src/contracts，契约演进（evolution）层。
// 解决的问题：契约需要在不破坏旧消费者的前提下增加版本；每次演进必须精确记录改了哪个变体的哪个成员哪一侧，
//   供 accepts 映射检查使用，同时保证旧契约对象不被修改。
// 职责边界：不负责声明基础契约（declare.ts）、不计算指纹（fingerprint.ts 的 materialize）、不保存句柄
//   （contract.ts 的 createContract）；本文件只操作草稿副本、校验成员并生成下一版 ContractData。
// 上游：应用调用 evolve(previous, edit)；下游：materialize、checkMembers、createContract。结果流向新 Contract；
//   错误以带路径的 Error 抛给调用方，旧契约保持不变。
// 能力清单：
// - MethodEditor、RemoteEditor、LocalEditor：三种编辑器接口，方法编辑对两种契约通用，remote/local 各有额外操作。
// - Put、Drop、PutKeyed、DropKeyed、EditedSide、Evolved、Editor、EditorOf：类型层计算新变体形状和历史元组。
// - evolve()：公开入口，复制当前版本、执行编辑回调、生成新句柄。
// - editWith()：执行回调并强制返回同一个编辑器引用，防止回调另造对象。
// - Draft：运行时草稿，提供 state/addState/removeState、args/result/method/addMethod/removeMethod、
//   keyed/addKeyed/removeKeyed，并在每次编辑后调用 #checked()。
// - localEditor()：把 Draft 包装成不带变体参数的 local 编辑器。
// 组合关系：evolve -> new Draft(contractData(previous)) -> localEditor 或 Draft 本身 -> editWith 执行链式编辑
//   -> 每个编辑写副本并记录 Change -> #checked 校验 -> next() -> materialize -> createContract。
// 示例：
//   const v2 = evolve(notes, (e) => e
//     .addState("editor", "count", int())
//     .addMethod("editor", "inc", nul(), int()));
// 建议阅读顺序：先看 evolve/editWith 的入口流程，再看 Draft 的编辑方法与 #checked/#changeMethod，
//   然后看 localEditor，最后按需理解 Put/Drop/PutKeyed/Evolved 等纯类型计算。

import {
	type Contract,
	type ContractData,
	type ContractShape,
	type CurrentVariants,
	contractData,
	createContract,
	type Kind,
	LOCAL,
	type MemberKind,
	type MethodData,
	type ShapeOf,
} from "./contract.ts";
import { checkMembers, memberPath, readMethod } from "./declare.ts";
import { materialize } from "./fingerprint.ts";
import type { Change, CurrentStep, Increment, MemberNames, MethodAt, Variants, VariantsWith } from "./history.ts";
import { Method, type Schema } from "./schema.ts";
import { type Snapshot, snapshotArguments, snapshotSchema } from "./snapshot.ts";

/** Method edits, the same for both kinds: each changes the method in every variant that has it. */
// 方法编辑对 remote/local 通用：按成员名在所有拥有它的变体上同时修改。
// 泛型 K 是契约种类，V 是“目前编辑后的变体形状”，C 是“目前累积的编辑”。
interface MethodEditor<K extends Kind, V extends Variants, C extends Change> {
	/** Type only: the variants after the edits so far. */
	// 只存在于类型层，运行时没有这两个属性；它们把链式调用的中间类型一路带下去。
	readonly "~variants"?: V;
	/** Type only: the changes made by the edits so far. */
	readonly "~changes"?: C;
	// 返回的 Editor 带上了新的成员类型和新增的 Change 联合；链式调用因此逐次收窄。
	args<M extends MemberNames<V, "methods">, A extends Schema>(
		member: M,
		args: A,
	): Editor<
		K,
		Put<V, VariantsWith<V, M>, "methods", M, Method<A, MethodAt<V, M>["result"]>>,
		C | [VariantsWith<V, M>, M, "args"]
	>;
	result<M extends MemberNames<V, "methods">, R extends Schema>(
		member: M,
		result: R,
	): Editor<
		K,
		Put<V, VariantsWith<V, M>, "methods", M, Method<MethodAt<V, M>["args"], R>>,
		C | [VariantsWith<V, M>, M, "result"]
	>;
	method<M extends MemberNames<V, "methods">, A extends Schema, R extends Schema>(
		member: M,
		args: A,
		result: R,
	): Editor<K, Put<V, VariantsWith<V, M>, "methods", M, Method<A, R>>, C | [VariantsWith<V, M>, M, "args" | "result"]>;
	removeMethod<M extends MemberNames<V, "methods">>(member: M): Editor<K, Drop<V, keyof V, "methods", M>, C>;
}

/** Edits of a remote contract. */
// remote 的编辑需要额外指定变体；addState/addMethod 使用 const M 保留新成员名的字面量类型。
interface RemoteEditor<V extends Variants, C extends Change> extends MethodEditor<"remote", V, C> {
	state<X extends keyof V & string, M extends keyof V[X]["state"] & string, S extends Schema>(
		variant: X,
		member: M,
		schema: S,
	): RemoteEditor<Put<V, X, "state", M, S>, C | [X, M, "state"]>;
	addState<X extends keyof V & string, const M extends string, S extends Schema>(
		variant: X,
		member: M,
		schema: S,
	): RemoteEditor<Put<V, X, "state", M, S>, C | [X, M, "state"]>;
	removeState<X extends keyof V & string, M extends keyof V[X]["state"] & string>(
		variant: X,
		member: M,
	): RemoteEditor<Drop<V, X, "state", M>, C>;
	addMethod<X extends keyof V & string, const M extends string, A extends Schema, R extends Schema>(
		variant: X,
		member: M,
		args: A,
		result: R,
	): RemoteEditor<Put<V, X, "methods", M, Method<A, R>>, C | [X, M, "args" | "result"]>;
}

/** Edits of a local contract: like remote ones, without a variant. */
// local 的编辑省略变体参数，内部固定使用 members；另外提供 keyed 成员的增删改。
interface LocalEditor<V extends Variants, C extends Change> extends MethodEditor<"local", V, C> {
	state<M extends keyof V[Local]["state"] & string, S extends Schema>(
		member: M,
		schema: S,
	): LocalEditor<Put<V, Local, "state", M, S>, C | [Local, M, "state"]>;
	addState<const M extends string, S extends Schema>(
		member: M,
		schema: S,
	): LocalEditor<Put<V, Local, "state", M, S>, C | [Local, M, "state"]>;
	removeState<M extends keyof V[Local]["state"] & string>(member: M): LocalEditor<Drop<V, Local, "state", M>, C>;
	addMethod<const M extends string, A extends Schema, R extends Schema>(
		member: M,
		args: A,
		result: R,
	): LocalEditor<Put<V, Local, "methods", M, Method<A, R>>, C | [Local, M, "args" | "result"]>;
	/** Changes keyed member `member`'s schema (slice 7b: an older consumer reads each key mapped, or is refused). */
	keyed<M extends KeyedNames<V> & string, S extends Schema>(
		member: M,
		schema: S,
	): LocalEditor<PutKeyed<V, M, S>, C | [Local, M, "keyed"]>;
	addKeyed<const M extends string, S extends Schema>(
		member: M,
		schema: S,
	): LocalEditor<PutKeyed<V, M, S>, C | [Local, M, "keyed"]>;
	removeKeyed<M extends KeyedNames<V> & string>(member: M): LocalEditor<DropKeyed<V, M>, C>;
}

/** The local variant's keyed member names. */
// NonNullable 去掉 keyed 可选带来的 undefined；keyof 得到成员名联合。
type KeyedNames<V extends Variants> = keyof NonNullable<V[Local]["keyed"]>;

/** The local variant with keyed member `M` set to `T`. */
// 只改 members 变体的 keyed 段：保留旧 keyed 的其余键，并让 M 对应 T；其他变体原样保留。
type PutKeyed<V extends Variants, M extends string, T> = {
	[Y in keyof V]: Y extends Local
		? {
				[S in keyof V[Y] | "keyed"]: S extends "keyed"
					? {
							[K in keyof NonNullable<V[Y]["keyed"]> | M]: K extends M ? T : NonNullable<V[Y]["keyed"]>[K];
						}
					: V[Y][S & keyof V[Y]];
			}
		: V[Y];
};

/** The local variant without keyed member `M`. */
// Omit 在类型层删除一个键；同样只作用于 members 变体。
type DropKeyed<V extends Variants, M extends string> = {
	[Y in keyof V]: Y extends Local
		? { [S in keyof V[Y]]: S extends "keyed" ? Omit<NonNullable<V[Y]["keyed"]>, M> : V[Y][S] }
		: V[Y];
};

// local 契约唯一 variant 名的类型别名，用于 PutKeyed/DropKeyed/KeyedNames 的索引。
type Local = typeof LOCAL;

// 按契约种类选择编辑器接口：remote 多一个变体参数，local 多 keyed 操作。
type Editor<K extends Kind, V extends Variants, C extends Change> = K extends "remote"
	? RemoteEditor<V, C>
	: LocalEditor<V, C>;

// evolve 入口给应用看到的编辑器类型：当前变体形状 + 尚无编辑（never）。
type EditorOf<C extends Contract> = Editor<ShapeOf<C>["kind"], CurrentVariants<C>, never>;

/** Variants `X` with member `M` of `Side` set to `T`. */
// 类型层的“写入”：只改 X 指定的变体，在该变体的 Side 段里把 M 设为 T，其余键原样保留。
// 映射类型会遍历所有变体和段，条件类型挑出目标；这是纯类型计算，运行时没有对应操作。
type Put<V extends Variants, X, Side extends EditedSide, M extends string, T> = {
	[Y in keyof V]: Y extends X
		? {
				[S in keyof V[Y]]: S extends Side ? { [K in keyof V[Y][S] | M]: K extends M ? T : V[Y][S][K] } : V[Y][S];
			}
		: V[Y];
};

/** Variants `X` without member `M` of `Side`. */
// 类型层的“删除”：用 Omit 去掉目标变体 Side 段的 M。
type Drop<V extends Variants, X, Side extends EditedSide, M extends string> = {
	[Y in keyof V]: Y extends X ? { [S in keyof V[Y]]: S extends Side ? Omit<V[Y][S], M> : V[Y][S] } : V[Y];
};

/** The sides of a variant that `Put` and `Drop` edit (keyed members have their own, `PutKeyed` and `DropKeyed`). */
// Put/Drop 只处理 state 和 methods；keyed 的形状不同，单独用 PutKeyed/DropKeyed。
type EditedSide = "state" | "methods";

// 演进后的类型形状：kind/name/params 不变，history 在元组末尾追加一个版本。
// Increment 在类型层做十进制加一；变体来自编辑器的 ~variants，changes 来自 ~changes。
// NonNullable 用来去掉可选“~”属性带来的 undefined。
type Evolved<S extends ContractShape, E extends MethodEditor<S["kind"], Variants, Change>> = {
	kind: S["kind"];
	name: S["name"];
	params: S["params"];
	history: [
		...S["history"],
		{
			version: Increment<CurrentStep<S["history"]>["version"]>;
			variants: NonNullable<E["~variants"]>;
			changes: NonNullable<E["~changes"]>;
		},
	];
};

/**
 * Appends the next version (`previous.version + 1`) with the edits `edit` makes; `edit` must return the editor it was
 * given. Params and the variant set never change: a change to either is a new history base.
 */
// 用途：演进一个契约。输入上一个契约句柄和编辑回调，输出带新历史的新契约。
// 错误路径：回调返回的不是收到的编辑器、成员不存在、同名换种类、方法跨变体签名不同都会抛错；
// 中间失败时旧契约不变，因为所有修改都发生在 Draft 的副本上。
// 流程：复制当前版本为草稿 -> 按种类选编辑器 -> 执行回调并检查返回值 -> materialize 新版本 -> 创建新句柄。
// 例子：const v2 = evolve(v1, (e) => e.addState("editor", "count", int()).addMethod("editor", "inc", nul(), int()));
export function evolve<C extends Contract, E extends MethodEditor<ShapeOf<C>["kind"], Variants, Change>>(
	previous: C,
	edit: (editor: EditorOf<C>) => E,
): Contract<Evolved<ShapeOf<C>, E>> {
	// Draft 构造时复制当前变体表和 kinds；旧契约的数据不会被改动。
	const draft = new Draft(contractData(previous));
	// local 需要把变体参数固定成 members，所以包一层 localEditor；remote 直接把 Draft 当编辑器。
	const editor = draft.kind === "local" ? localEditor(draft) : draft;
	// The editor interfaces track the edits in the types; at runtime every edit returns the same editor.
	// 类型层的链式返回值只是接口形状；运行时 Draft 的方法都返回同一个对象（或 localEditor 包装对象），
	// 因此这里把类型断言成 EditorOf<C>，editWith 再用恒等比较验证回调没有另造对象。
	editWith(editor as unknown as EditorOf<C>, edit, `${draft.path}: evolve`);
	return createContract(draft.next());
}

/**
 * Runs `edit` on `editor` (contracts' and tables' rule): an edit returning anything but the editor it was given throws
 * (`what` names the call).
 */
// 用途：执行编辑回调并强制“返回收到的编辑器”。输入编辑器、回调和用于错误信息的名称；无返回值。
// 副作用：回调本身会修改编辑器（草稿）。错误路径：返回值不是同一引用时抛错。
// 例子：editWith(draft, (e) => e.addState(...), "notes.v2: evolve")；若回调写成 e => ({ ...e })，这里会拒绝。
export function editWith<E>(editor: E, edit: (editor: E) => unknown, what: string): void {
	if (edit(editor) !== editor) throw new Error(`${what} must return the editor it was given`);
}

/** A variant under construction. */
// 草稿中的一个变体：三张 Map 都可在演进过程中增删改，快照对象本身仍按不可变约定共享。
type DraftVariant = {
	readonly state: Map<string, Snapshot>;
	readonly methods: Map<string, MethodData>;
	readonly keyed: Map<string, Snapshot>;
};

/** The next version under construction, and the remote editor. Every edit is checked as it is made. */
// 草稿类：同时充当 remote 编辑器；local 由 localEditor() 包一层，把变体固定为 members。
// 所有编辑先改副本，再调用 #checked() 验证成员一致性；失败时抛错，不会生成不合法版本。
// 字段前的 # 是真正的运行时私有字段（不是 TS 的 private 修饰符），类外无法访问，也不会出现在 JSON 中。
class Draft {
	readonly kind: Kind;
	readonly path: string;
	/** What edits return: the draft itself, or the local editor wrapping it. */
	// 编辑方法统一返回 editor：remote 是 this，local 是包装对象；editWith 用它做恒等检查。
	editor: object = this;
	readonly #data: ContractData;
	readonly #version: number;
	readonly #variants: Map<string, DraftVariant>;
	readonly #kinds: Map<string, MemberKind>;
	readonly #changes: Change[] = [];

	constructor(data: ContractData) {
		const current = data.versions.at(-1)!;
		this.kind = data.kind;
		this.#data = data;
		// 新版本号严格加一；params 和变体集合不在这里改，改变它们意味着另起一段历史。
		this.#version = current.version + 1;
		this.path = `${data.name} v${this.#version}`;
		// 每个变体复制三张 Map；快照对象本身是不可变约定，可以安全共享。
		this.#variants = new Map(
			[...current.variants].map(([name, { state, methods, keyed }]) => [
				name,
				{ state: new Map(state), methods: new Map(methods), keyed: new Map(keyed) },
			]),
		);
		// kinds 是历史累积的成员种类，同样复制一份，校验时继续往里登记。
		this.#kinds = new Map(data.kinds);
	}

	// 修改已存在的 state 成员；若名字不存在则报错（新增必须用 addState，避免拼写错误静默生效）。
	state(variant: string, member: string, schema: Schema): object {
		if (!this.#variant(variant).state.has(member)) {
			throw new Error(`${this.#path(variant, member, "state")}: no such state member`);
		}
		return this.#putState(variant, member, schema);
	}

	// 新增 state 成员；已存在同名成员（不论哪种种类）会被拒绝。
	addState(variant: string, member: string, schema: Schema): object {
		this.#refuseDeclared(variant, member, "state");
		return this.#putState(variant, member, schema);
	}

	// 删除 state 成员；Map.delete 返回 false 表示本来就没有，据此报错。成功时返回 editor 以支持链式调用。
	removeState(variant: string, member: string): object {
		if (!this.#variant(variant).state.delete(member)) {
			throw new Error(`${this.#path(variant, member, "state")}: no such state member`);
		}
		return this.editor;
	}

	// 只改参数或只改结果时，未提供的另一侧传 undefined，由 #changeMethod 保留旧快照。
	args(member: string, args: Schema): object {
		return this.#changeMethod(member, args, undefined);
	}

	result(member: string, result: Schema): object {
		return this.#changeMethod(member, undefined, result);
	}

	// 同时替换参数和结果；两侧都会记录 Change。
	method(member: string, args: Schema, result: Schema): object {
		return this.#changeMethod(member, args, result);
	}

	// 在指定变体新增方法。参数侧要求闭合；新增会同时记录 args 和 result 两处编辑。
	addMethod(variant: string, member: string, args: Schema, result: Schema): object {
		this.#refuseDeclared(variant, member, "method");
		this.#variant(variant).methods.set(
			member,
			readMethod(new Method(args, result), this.#path(variant, member, "method")),
		);
		this.#changes.push([variant, member, "args"], [variant, member, "result"]);
		return this.#checked();
	}

	// keyed 成员同样区分“改已有的”和“新增”：改不存在的名字会报错。
	keyed(variant: string, member: string, schema: Schema): object {
		if (!this.#variant(variant).keyed.has(member)) {
			throw new Error(`${this.#path(variant, member, "keyed")}: no such keyed member`);
		}
		return this.#putKeyed(variant, member, schema);
	}

	addKeyed(variant: string, member: string, schema: Schema): object {
		this.#refuseDeclared(variant, member, "keyed");
		return this.#putKeyed(variant, member, schema);
	}

	removeKeyed(variant: string, member: string): object {
		if (!this.#variant(variant).keyed.delete(member)) {
			throw new Error(`${this.#path(variant, member, "keyed")}: no such keyed member`);
		}
		return this.editor;
	}

	// 方法在声明时保证“所有拥有它的变体”同签名，所以删除也覆盖所有拥有它的变体。
	removeMethod(member: string): object {
		for (const variant of this.#variantsWith(member)) this.#variant(variant).methods.delete(member);
		return this.editor;
	}

	/** The contract data with this version appended. */
	// 用途：生成最终版本数据。输入无，输出新的 ContractData；不修改旧数据。
	// materialize 会用当前变体表计算指纹；展开旧数据后只替换 versions 和 kinds，其余字段（params、hostAddress）沿用。
	next(): ContractData {
		const { kind, params, versions } = this.#data;
		const version = materialize(kind, params, this.#version, this.#variants, this.#changes);
		return { ...this.#data, versions: [...versions, version], kinds: this.#kinds };
	}

	// 写入 state 快照并记录 Change，然后做一致性检查；返回 editor 供链式调用。
	#putState(variant: string, member: string, schema: Schema): object {
		this.#variant(variant).state.set(member, snapshotSchema(schema, this.#path(variant, member, "state")));
		this.#changes.push([variant, member, "state"]);
		return this.#checked();
	}

	// 写入 keyed 快照并记录 [变体, 成员, "keyed"]；与 state 使用同样的检查。
	#putKeyed(variant: string, member: string, schema: Schema): object {
		this.#variant(variant).keyed.set(member, snapshotSchema(schema, this.#path(variant, member, "keyed")));
		this.#changes.push([variant, member, "keyed"]);
		return this.#checked();
	}

	/** Changes the given sides of a method in every variant that has it. */
	// 用途：在所有拥有该方法的变体上改参数/结果。输入成员名和可选的两种 schema；输出 editor。
	// 流程：先确认至少一个变体拥有它 -> 每个新 schema 只做一次快照 -> 逐变体替换仍缺省的一侧 -> 记录实际改动的侧。
	#changeMethod(member: string, args: Schema | undefined, result: Schema | undefined): object {
		const variants = this.#variantsWith(member);
		const path = this.#path(variants[0]!, member, "method");
		const newArgs = args === undefined ? undefined : snapshotArguments(args, `${path}.args`);
		const newResult = result === undefined ? undefined : snapshotSchema(result, `${path}.result`);
		for (const variant of variants) {
			const { methods } = this.#variant(variant);
			const old = methods.get(member)!;
			methods.set(member, { args: newArgs ?? old.args, result: newResult ?? old.result });
			if (newArgs !== undefined) this.#changes.push([variant, member, "args"]);
			if (newResult !== undefined) this.#changes.push([variant, member, "result"]);
		}
		return this.#checked();
	}

	// 按名字取草稿变体；不存在说明调用方给了错误变体名，而变体集合是声明后不可变的。
	#variant(variant: string): DraftVariant {
		const found = this.#variants.get(variant);
		if (found === undefined) {
			throw new Error(`${this.path}.${variant}: unknown variant (the variant set never changes)`);
		}
		return found;
	}

	// 找出所有拥有该方法的变体；一个都没有时抛错，说明成员名拼错或该契约没有这个方法。
	#variantsWith(member: string): string[] {
		const variants = [...this.#variants].filter(([, { methods }]) => methods.has(member)).map(([variant]) => variant);
		if (variants.length === 0) throw new Error(`${this.path}: no method "${member}"`);
		return variants;
	}

	// 新增成员前确认该名字在三种成员里都未出现；种类一旦确定不能改变，所以不能靠 add 覆盖旧成员。
	#refuseDeclared(variant: string, member: string, kind: MemberKind): void {
		const { state, methods, keyed } = this.#variant(variant);
		if (state.has(member) || methods.has(member) || keyed.has(member)) {
			throw new Error(`${this.#path(variant, member, kind)}: already declared`);
		}
	}

	// 复用 memberPath，使声明期和演进期的错误路径格式一致。
	#path(variant: string, member: string, kind: MemberKind): string {
		return memberPath(this.path, this.kind, variant, member, kind);
	}

	/** A member's kind never changes, also not after a removal; a method keeps one signature across variants. */
	// 每次编辑后都跑一遍全量成员检查：kinds 会被继续写入（包括已删除成员），方法签名也必须跨变体一致。
	// 检查失败立即抛错，草稿不会再被使用。返回 editor 保持链式接口。
	#checked(): object {
		checkMembers(this.#variants, this.#kinds, (variant, member, kind) => this.#path(variant, member, kind));
		return this.editor;
	}
}

/** The local editor: the draft's edits with the variant filled in. */
// 用途：为 local 契约生成编辑器包装。输入 Draft，输出对象；副作用：把包装对象写回 draft.editor。
// 每个方法都把成员操作转发到 members 变体；state/addState 等在 Draft 中需要 variant 参数，这里补上 LOCAL。
// 返回的包装对象与 draft 不同，但 Draft 也会把 editor 指向它，因此 editWith 的恒等检查仍然成立。
function localEditor(draft: Draft): object {
	draft.editor = {
		state: (member: string, schema: Schema) => draft.state(LOCAL, member, schema),
		addState: (member: string, schema: Schema) => draft.addState(LOCAL, member, schema),
		removeState: (member: string) => draft.removeState(LOCAL, member),
		addMethod: (member: string, args: Schema, result: Schema) => draft.addMethod(LOCAL, member, args, result),
		args: (member: string, args: Schema) => draft.args(member, args),
		result: (member: string, result: Schema) => draft.result(member, result),
		method: (member: string, args: Schema, result: Schema) => draft.method(member, args, result),
		removeMethod: (member: string) => draft.removeMethod(member),
		keyed: (member: string, schema: Schema) => draft.keyed(LOCAL, member, schema),
		addKeyed: (member: string, schema: Schema) => draft.addKeyed(LOCAL, member, schema),
		removeKeyed: (member: string) => draft.removeKeyed(LOCAL, member),
	};
	return draft.editor;
}
