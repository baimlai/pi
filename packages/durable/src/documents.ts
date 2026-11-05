// 文件导读
// 所属：packages/durable 的文档定义层，连接应用声明（defineDoc/defineDocFamily）与 Session/Storage 的持久化表示。
// 作用：在定义时校验版本；把重载的方法参数解析成逻辑地址（kind + scope + key）；生成存储创建记录；
// 类型访问时核对持久记录的 scope/history/fork 与版本，并把旧版本值迁移、复制成当前定义可用的值。
// 职责边界：不读存储、不分配 ID（ID 由 Storage.mintId 提供）、不写文档、不执行 checkpointWhen、不调度迁移；
// 只做“定义 ↔ 记录”的纯转换与边界校验。上游：应用调用 defineDoc 建立 token；Session/Tx 在 snapshot/doc/watch/retire
// 时用 resolveAddress 解析参数，再用 materialize* 校验和装载值。下游：types.ts 的文档类型、chord 的 Op/JsonValue/copyJson、ids.ts。
// 能力清单：
// - defineDoc 的四个重载：按 scope/history/fork 返回 Session、Conversation、RewindableConversation 或 Task 单例 token。
// - defineDocFamily 的四个重载：带 key 与 seed 的文档族 token；initial(seed) 仅在该成员不存在时调用。
// - AnyDocDefinition / AnyDocToken：擦除泛型后的内部形状，供 Session 的剩余参数实现使用。
// - ResolvedAddress：逻辑地址、字符串身份 id、消费完 owner/key 后的下一个参数下标 nextArgument。
// - resolveAddress：按 scope 消费 owner 参数，再按 family 消费 key 参数。
// - addressId：逻辑地址的稳定字符串身份，用作 Session 缓存键与 watch 键。
// - documentCreate：构造 Storage 的 document.create 写入记录。
// - checkRecordScope / checkRecordVersion / materializeDocument / materializeDocumentValue：类型访问前的校验、迁移与复制。
// 组合与典型顺序（Tx.doc）：resolveAddress(token, args) → 查缓存或 Storage.findDocument → checkRecordScope →
// checkRecordVersion → materializeDocument（版本不同则 copyJson(migrate(...))）→ 返回 Chord Draft 供修改。
// 示例（真实运行时结果）：
//   const Counter = defineDoc<{ n: number }>({
//     kind: "app.counter", version: 1, scope: "session", initial: () => ({ n: 0 }), checkpointWhen: () => false,
//   });
//   resolveAddress(Counter.definition, []) 返回
//   { address: { kind: "app.counter", scope: { kind: "session" } }, id: '["app.counter","session",null,null]', nextArgument: 0 }
// 注意：defineDoc 定义时只校验 version 是正安全整数；kind 非空、scope 与 initial 的配合等没有额外运行时校验。
// 阅读顺序：先看文档 token 与 AnyDocDefinition，再看 resolveAddress/addressId，最后看 documentCreate 与 materialize 的校验流程。
import type { Op } from "@earendil-works/chord/delta";
import { copyJson, type JsonValue } from "@earendil-works/chord/json";
import { idFromNumber } from "./ids.ts";
import type {
	CheckpointInfo,
	CommonDocDefinition,
	ConversationDocFamilyToken,
	ConversationDocToken,
	ConversationId,
	DocDefinition,
	DocFamilyDefinition,
	DocFamilyToken,
	DocToken,
	DocumentAddress,
	DocumentCreate,
	DocumentId,
	DocumentRecord,
	DocumentSemantics,
	Id,
	JsonObject,
	LatestConversationSemantics,
	RewindableConversationDocFamilyToken,
	RewindableConversationDocToken,
	RewindableConversationSemantics,
	SessionDocFamilyToken,
	SessionDocToken,
	StoredDocument,
	TaskDocFamilyToken,
	TaskDocToken,
	TaskId,
} from "./types.ts";

// 文档族定义的输入形状。
// 在 CommonDocDefinition 的基础上去掉无参 initial（Omit<..., "initial">），换成接收 seed 的 initial(seed: I)，
// 并加上字面量 family: true 以便 resolveAddress 区分钟表文档与带 key 的族成员。
// 这些约束只在编译期生效；运行时 defineDocFamily 不会重新检查 family 字段或 seed 类型。
type FamilyInput<T extends JsonObject, I extends JsonValue> = Omit<CommonDocDefinition<T>, "initial"> & {
	readonly family: true;
	initial(seed: I): T;
};

// 定义单例文档 token。这里用重载把三种“归属语义”写进返回类型：
// - scope: "session"：整个 Session 一份；
// - 带 history/fork 的会话文档：每个 conversation 一份，latest 只保留当前值，rewindable 保留可按 EntryId 回看的历史；
// - scope: "task"：每个 task 一份。
// 输入是定义对象，输出是 { definition } token；不创建文档、不调用 initial。
/** Define a Session-scoped singleton document. */
export function defineDoc<T extends JsonObject>(
	definition: CommonDocDefinition<T> & { readonly scope: "session" },
): SessionDocToken<T>;
/** Define a latest-only conversation singleton document. */
export function defineDoc<T extends JsonObject>(
	definition: CommonDocDefinition<T> & LatestConversationSemantics,
): ConversationDocToken<T>;
/** Define a rewindable conversation singleton document. */
export function defineDoc<T extends JsonObject>(
	definition: CommonDocDefinition<T> & RewindableConversationSemantics,
): RewindableConversationDocToken<T>;
/** Define a task-scoped singleton document. */
export function defineDoc<T extends JsonObject>(
	definition: CommonDocDefinition<T> & { readonly scope: "task" },
): TaskDocToken<T>;
// 重载的实现签名：接受擦除后的 DocDefinition<T>，返回 { definition }。
// 主要流程：validateDefinition 做唯一的定义期运行时校验（version），然后原样保存引用。
// 错误：version 不是正安全整数时抛 TypeError；其余字段不检查。
export function defineDoc<T extends JsonObject>(definition: DocDefinition<T>): DocToken<T, DocDefinition<T>> {
	// 只校验版本号，避免持久化后无法判断迁移方向。
	validateDefinition(definition);
	// 属性简写；不复制定义，调用方之后修改同一对象会同时改变 token 看到的内容。
	return { definition };
}

// 定义文档族 token。族成员共享 kind/scope/version，用字符串 key 区分；initial(seed) 只在成员不存在时调用。
// 与 defineDoc 相同，重载只影响 TypeScript 推断；运行时只校验 version。
/** Define a Session-scoped document family. */
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
	definition: FamilyInput<T, I> & { readonly scope: "session" },
): SessionDocFamilyToken<T, I>;
/** Define a latest-only conversation document family. */
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
	definition: FamilyInput<T, I> & LatestConversationSemantics,
): ConversationDocFamilyToken<T, I>;
/** Define a rewindable conversation document family. */
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
	definition: FamilyInput<T, I> & RewindableConversationSemantics,
): RewindableConversationDocFamilyToken<T, I>;
/** Define a task-scoped document family. */
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
	definition: FamilyInput<T, I> & { readonly scope: "task" },
): TaskDocFamilyToken<T, I>;
// defineDocFamily 的实现签名：保存定义引用，只做版本校验。
// 输入：DocFamilyDefinition<T, I>；输出：{ definition }；副作用/错误同 defineDoc（version 非正安全整数时 TypeError）。
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
	definition: DocFamilyDefinition<T, I>,
): DocFamilyToken<T, I, DocFamilyDefinition<T, I>> {
	// 与单例文档共用同一版本校验。
	validateDefinition(definition);
	// 原样保存，不复制 initial 或其它函数。
	return { definition };
}

// 擦除泛型后的定义形状：Session 的实现只用 ...args 接收重载参数，无法在内部保留具体 T，因此用这个统一形状操作。
// 交叉类型 DocumentSemantics 带来 scope（以及会话文档的 history/fork）；其余字段与 CommonDocDefinition 对应。
// initial(seed?) 把单例的无参形式与族的有参形式合并；运行时由 definition.family 决定是否传 seed。
/** Erased definition shape used by the Session after overload resolution. */
export type AnyDocDefinition = DocumentSemantics & {
	// 持久化的文档种类名，与 scope/key 一起构成逻辑地址。
	readonly kind: string;
	// 正值整数；用于判断存储版本是当前、可迁移还是过新。
	readonly version: number;
	// true 表示文档族；resolveAddress 据此消费 key 参数。
	readonly family?: true;
	// 创建初始值；族成员接收 seed。可能抛错，由调用方决定如何处理。
	initial(seed?: JsonValue): JsonObject;
	// 可选迁移函数：仅在存储版本低于定义版本时调用。
	migrate?(value: JsonObject, fromVersion: number): JsonObject;
	// 必填检查点策略：返回 true 时把本次普通变更存成完整 base 而不是 delta。
	checkpointWhen(value: Readonly<JsonObject>, ops: readonly Op[], info: CheckpointInfo): boolean;
};

// 擦除后的 token：只是定义引用。Session 的公开重载会把具体 token 类型收窄，内部实现则用这个形状。
/** Erased singleton or family token. */
export type AnyDocToken = { readonly definition: AnyDocDefinition };

// 定义期唯一的运行时校验。
// 输入：任意定义；输出：无；错误：version 不是正安全整数时抛 TypeError。
// 边界：信任边界是“应用提供的定义对象”，所以这里可以校验；但不检查 kind 是否为空、family 是否为布尔、initial
// 是否存在或 checkpointWhen 是否真的返回布尔，这些由 TypeScript 与文档约定保证。
// 例子：version 为 0、NaN、1.5 或 2**53 都会抛错；version 1 通过。
function validateDefinition(definition: AnyDocDefinition): void {
	// Number.isSafeInteger 同时排除 NaN、Infinity、小数和超过 2^53-1 的整数；再要求至少为 1。
	if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
		// 消息包含 kind，便于定位是哪一个定义写错了。
		throw new TypeError(`Document ${definition.kind} version must be a positive integer`);
	}
}

// resolveAddress 的结果。
// address 是逻辑地址（可含 owner 与 key）；id 是它的稳定字符串形式；nextArgument 指向家族 seed 的下标
// （单例文档等于消费掉的 owner 参数个数），调用方据此读取 seed，避免重复解析重载参数。
/** Logical address plus its string identity for maps. */
export type ResolvedAddress = {
	readonly address: DocumentAddress;
	readonly id: string;
	readonly nextArgument: number;
};

// 把重载方法的“剩余参数数组”解析成逻辑地址。
// 输入：definition（scope/family/kind）与 args（Session 公开方法收到的参数，未区分类型地放进数组）。
// 输出：ResolvedAddress；副作用：无；错误：会话/任务 owner 不是安全整数时抛 TypeError（见 ownerId）。
// 主要流程：
//   1. session 作用域不消费参数；
//   2. conversation/task 先消费一个 owner ID；
//   3. family 再消费一个 key；
//   4. 用 kind/scope/key 组成地址，并计算字符串身份；nextArgument 留给调用方读取 seed。
// 信任边界：args 来自公开 API；编译期由重载保证类型，但 JS 调用者可以传错。这里只对 owner 做了运行时校验，
// key 用 `as string` 直接断言，没有检查它是否真的是字符串。
// 例子：resolveAddress(ConversationFamily.definition, [cid, "main", seed]) → nextArgument 2、address.key "main"；
//   resolveAddress(SessionDoc.definition, []) → nextArgument 0、无 key。
/** Resolve an overloaded argument list and return the index after the owner and family key. */
export function resolveAddress(definition: AnyDocDefinition, args: readonly unknown[]): ResolvedAddress {
	// index 记录已经消费到 args 的第几个参数；每读一个参数就后移。
	let index = 0;
	// scope 的类型来自 DocumentAddress；三个分支之后它一定被赋值（DocumentSemantics 的 scope 只有这三种值）。
	let scope: DocumentAddress["scope"];
	switch (definition.scope) {
		case "session":
			// Session 文档没有 owner 参数。
			scope = { kind: "session" };
			break;
		case "conversation":
			// 先读 owner 会话 ID；index++ 在读取后自增，所以下一个参数是 family key 或 seed。
			scope = { kind: "conversation", conversationId: ownerId<ConversationId>(args[index++], definition) };
			break;
		case "task":
			// 任务文档同理，owner 是 TaskId。
			scope = { kind: "task", taskId: ownerId<TaskId>(args[index++], definition) };
			break;
	}
	// 只有 family 才消费 key；单例文档的 key 为 undefined。`as string` 仅是编译期断言。
	const key = definition.family === true ? (args[index++] as string) : undefined;
	// 有 key 才是族成员地址；key 为 undefined（包括调用者漏传 key）会退化成单例地址。
	const address: DocumentAddress =
		key === undefined ? { kind: definition.kind, scope } : { kind: definition.kind, scope, key };
	// id 供 Session 缓存与 watch 键使用；nextArgument 让调用方接着读 seed，而不必重新实现一套参数规则。
	return { address, id: addressId(address), nextArgument: index };
}

// 校验并标记文档 owner ID。
// 输入：value 是 args 中对应位置的未知值；definition 只用于错误消息里的 scope。
// 输出：带品牌 I 的 number；错误：不是安全整数时抛 TypeError；副作用：无。
// 这是 resolveAddress 的信任边界检查：TypeScript 重载只约束 TS 调用者，JS 或 as any 调用仍可能传字符串、undefined、小数。
// 例子：ownerId<ConversationId>(7, def) 返回 7；ownerId<ConversationId>("7", def) 抛 TypeError。
function ownerId<I extends Id<string>>(value: unknown, definition: AnyDocDefinition): I {
	// typeof 排除字符串/对象；isSafeInteger 排除 NaN、Infinity、小数和超范围整数。
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		// 消息使用 definition.scope（"conversation" 或 "task"），帮助定位是哪个参数错了。
		throw new TypeError(`Document ${definition.kind} requires a ${definition.scope} ID`);
	}
	// 通过检查后只加类型品牌；运行时仍是同一个数字。
	return idFromNumber<I>(value);
}

// 计算逻辑地址的稳定字符串身份。
// 输入：DocumentAddress；输出：JSON 数组编码的字符串；副作用/错误：无（只包含字符串、数字、null）。
// 用途：Session 的文档缓存键（documentKey 再包一层前缀）与 watch 去重；相同 kind/scope/owner/key 必得同一字符串。
// 设计：用 JSON.stringify 数组避免字段拼接歧义（例如 key 里含分隔符）；owner 和 key 缺失时用 null，与合法值区分。
// 例子：addressId({kind:"a", scope:{kind:"session"}}) === '["a","session",null,null]'；
//   会话 7 的族成员 "x" → '["a","conversation",7,"x"]'；key 为空字符串时保留 ""（`??` 只把 undefined/null 变成 null）。
/** Stable string identity of one logical address. */
export function addressId(address: DocumentAddress): string {
	// 用条件表达式从可辨识联合中取 owner；session 没有 owner，因此是 null。
	const owner =
		address.scope.kind === "session"
			? null
			: address.scope.kind === "conversation"
				? address.scope.conversationId
				: address.scope.taskId;
	// 数组元素顺序固定为 [kind, scope kind, owner, key]，null 表示“该维度不适用”。
	return JSON.stringify([address.kind, address.scope.kind, owner, address.key ?? null]);
}

// 为地址上的新 incarnation 构造存储创建记录。
// 输入：definition（会话文档需要它的 history/fork）、address、Storage.mintId 得到的 DocumentId。
// 输出：DocumentCreate（不含 createdAt/retiredAt，由 Storage 在提交时盖章）；副作用/错误：无。
// 主要流程：key 存在时用展开运算放入 { key }；再按 scope 组装。会话文档额外带 history/fork，任务/Session 文档不带。
// 注意：`definition.history!` 与 `as DocumentCreate` 都是编译期断言；defineDoc 的重载保证会话定义有这两个字段，
// 但如果 JS 调用者绕过类型传了不一致的定义，运行时会得到 undefined 字段而不是在这里报错。
// 例子：documentCreate(Counter.definition, {kind:"app.counter",scope:{kind:"session"}}, id)
//   返回 { id, kind:"app.counter", scope:{kind:"session"} }。
/** Build the storage create record for a new incarnation at an address. */
export function documentCreate(definition: AnyDocDefinition, address: DocumentAddress, id: DocumentId): DocumentCreate {
	// 没有 key 时展开空对象，等价于不写 key 属性；有 key 时写入字符串 key。
	const key = address.key === undefined ? {} : { key: address.key };
	switch (address.scope.kind) {
		case "session":
			// Session 文档只有 kind/scope，可选的 key 来自文档族。
			return { id, kind: address.kind, ...key, scope: address.scope };
		case "task":
			// 任务文档同样只需要 scope 中的 taskId。
			return { id, kind: address.kind, ...key, scope: address.scope };
		case "conversation":
			// 会话文档还持久化 history/fork 语义，后续访问时 checkRecordScope 会用它们核对定义。
			return {
				id,
				kind: address.kind,
				...key,
				scope: address.scope,
				history: definition.history!,
				fork: definition.fork!,
			} as DocumentCreate;
	}
}

// 校验“持久记录”与“调用方 token”的归属语义一致。
// 输入：definition（当前 token 的定义）与 record（已持久化或待创建记录）；输出：无；错误：不一致时抛 TypeError。
// 核对内容：scope.kind 必须相同；会话文档还必须 history/fork 相同（最新值 vs 可回看，以及 fork 初始化方式）。
// 为什么需要：kind 是公开协议字符串，同名 kind 可能被另一个应用定义成不同语义；直接读取会把数据当错类型解释。
// 运行时代码只做这个检查；record 的其它字段（kind/key/version）由调用方在地址解析与 checkRecordVersion 中处理。
// 例子：用 history:"rewindable" 的 token 读取以 "latest" 创建的记录 → TypeError。
/** Reject typed access whose token disagrees with the persisted scope, history, or fork semantics. */
export function checkRecordScope(definition: AnyDocDefinition, record: DocumentCreate | DocumentRecord): void {
	// 先比 scope；会话文档再比 history/fork。条件里的 record.scope.kind === "conversation" 同时完成类型收窄，
	// 使后续的 record.history/record.fork 在联合类型上可访问。
	if (
		record.scope.kind !== definition.scope ||
		(record.scope.kind === "conversation" &&
			(record.history !== definition.history || record.fork !== definition.fork))
	) {
		// 错误消息带记录 id 与 kind，便于定位冲突的持久化数据。
		throw new TypeError(`Document ${record.id} (${record.kind}) does not match the supplied definition semantics`);
	}
}

// 校验存储版本能否被当前定义使用。
// 输入：definition、记录（仅用于错误消息）、version（存储中的定义版本）；输出：无；副作用：无。
// 错误：存储版本比定义新 → Error（不支持降级读取）；存储版本更旧且定义没有 migrate → Error（无法转换）。
// 通过条件：版本相等；或更旧但提供了 migrate（真正迁移在 materializeDocumentValue 中执行）。
// 例子：定义 version 2、存储 version 1 且有 migrate → 通过；没有 migrate → 抛 "requires migration from version 1"。
/** Reject typed access to a stored version the supplied definition cannot use. */
export function checkRecordVersion(
	definition: AnyDocDefinition,
	record: DocumentCreate | DocumentRecord,
	version: number,
): void {
	// 存储版本更高说明持久化数据来自更新版本的应用；当前代码不能安全解释它。
	if (version > definition.version) {
		throw new Error(`Document ${record.id} (${record.kind}) has newer version ${version} than ${definition.version}`);
	}
	// 存储版本更低时必须能迁移；migrate 是否存在是决定“可读/不可读”的唯一条件。
	if (version < definition.version && definition.migrate === undefined) {
		throw new Error(`Document ${record.id} (${record.kind}) requires migration from version ${version}`);
	}
}

// 从 Storage 返回的 StoredDocument 得到当前定义可用的值。
// 输入：definition、stored（record/version/value/deltasSinceBase）；输出：JsonObject 值；错误：scope 或版本不兼容时抛错。
// 副作用：版本不同时分配迁移后的新树；版本相同时直接返回传入的 value（调用方按“已脱离存储、可拥有”处理）。
// 主要流程：委托 materializeDocumentValue，使用 stored.record/stored.version/stored.value。
// 例子：const value = materializeDocument(definition, await storage.document(id, "current", context)!);
/** Validate and materialize a detached stored value for typed access. */
export function materializeDocument(definition: AnyDocDefinition, stored: StoredDocument): JsonObject {
	// StoredDocument 已把记录与值打包；这里只负责转发到通用实现。
	return materializeDocumentValue(definition, stored.record, stored.version, stored.value);
}

/** Validate and materialize one detached value before its first persisted incarnation. */
// 校验并物化一个尚未持久化（或已从存储读出）的值。
// 输入：definition、record（校验 scope 用）、version（该值的存储版本）、value（JSON 对象）。
// 输出：当前定义版本的可拥有 JsonObject；副作用：迁移时分配新树；错误：scope 不符、版本过新或缺少 migrate。
// 主要流程：先 checkRecordScope，再 checkRecordVersion；版本相同直接返回 value，否则调用 migrate 并用 copyJson
// 复制成严格 JSON。copyJson 同时会拒绝迁移函数返回的非 JSON 值（如 NaN、undefined 属性）。
// 信任边界：value 来自 Storage 或迁移函数；版本相同时不再做 JSON 校验，因为 Storage 契约要求返回脱离的合法值。
// 例子：定义 v2、migrate:(v)=> ({ n: (v as {n:number}).n + 1 })、存储 v1 的 {n:1} → 返回新对象 {n:2}。
export function materializeDocumentValue(
	definition: AnyDocDefinition,
	record: DocumentCreate | DocumentRecord,
	version: number,
	value: JsonObject,
): JsonObject {
	// 先确认持久记录确实是这种 scope/history/fork，避免按错误形状读取。
	checkRecordScope(definition, record);
	// 再确认版本方向：过新拒绝；过旧且无 migrate 拒绝。
	checkRecordVersion(definition, record, version);
	// 版本一致：存储值已经是当前形状，直接返回（不做复制）。
	if (version === definition.version) return value;
	// 版本更旧：checkRecordVersion 已保证 migrate 存在，因此这里用 `!` 断言；迁移结果经 copyJson 校验并脱离原树。
	return copyJson(definition.migrate!(value, version)) as JsonObject;
}
