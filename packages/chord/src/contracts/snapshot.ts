// Schema snapshots: one schema-aware walk checks an app schema against Chord's vocabulary and produces a
// Chord-owned copy and its normal form (the fingerprint input).

// 文件导读
// 所属模块：packages/chord/src/contracts，schema 快照（声明期的 schema 边界）。
// 解决的问题：应用传入的是普通 JSON Schema；Chord 需要一份自己拥有、不可再被应用修改的深拷贝，
//   一份用于指纹的规范形式，并知道里面是否有 bytes 叶节点（跨链接时走原始字节段）。
// 职责边界：只校验 schema 的结构和关键字白名单，不校验业务值；快照按不可变约定使用但不冻结；
//   不做类型层检查（那是 schema.ts/TypeScript 的事），也不执行 schema。
// 上游：declare/readMethod/evolve 调 snapshotSchema/snapshotArguments；下游：fingerprint 用 normal，
//   链接编解码用 schema 和 bytes。错误以带路径的 Error 抛给声明方（未知关键字、循环、访问器、开放参数对象等）。
// 能力清单：
// - Snapshot：schema 副本、规范形式、是否含 bytes 叶三部分。
// - snapshotSchema()：state/result/params 的入口，对象可以开放（记录允许）。
// - snapshotArguments()：方法参数入口，要求所有对象 schema 闭合（additionalProperties: false），记录除外。
// - KEYWORD_GROUPS、KEYWORDS、TYPES、BYTES_KEYWORDS：支持的词汇表、类型集合和 bytes 专用关键字。
// - walk()/walkKeyword()/walkList()：递归复制与检查，检测循环并按关键字分组处理值。
// - data()/sortedCopy()/ownEntries()：JSON 数据的深拷贝、键排序与不安全属性拒绝。
// - isPlainObject()、isOpenObject()、checkBytesBounds()、compare()：形状与边界辅助判断。
// 组合关系：snapshotSchema -> walk(open) 或 snapshotArguments -> walk(closed) -> 复制 schema + normal；
//   normal 进入 fingerprint，bytes 标记进入链接编码。
// 示例：
//   const snap = snapshotSchema(obj({ title: str() }), "task");
//   // snap.schema 是独立副本，snap.normal 是键排序后的规范 JSON，snap.bytes === false
// 建议阅读顺序：先看 Snapshot 与两个入口，再看 walk 的主循环和错误路径，随后看 walkKeyword 的分组处理，
//   最后看 data/sortedCopy/ownEntries/isOpenObject/checkBytesBounds 等辅助函数。

import type { JsonSchema } from "@earendil-works/pi-schema";
import { isJsonValue, type JsonValue } from "../json.ts";

/**
 * A Chord-owned copy of an app schema, its normal form, and whether it has a `bytes()` leaf (values crossing a link
 * then carry raw byte segments); immutable by convention.
 */
// 三个字段都是只读：schema 是深拷贝，normal 是规范形式，bytes 表示子树中是否有 type: "bytes"。
// “拥有”指之后不再引用应用对象；代码不冻结对象，靠约定保证不被修改。
export type Snapshot = { readonly schema: JsonSchema; readonly normal: JsonValue; readonly bytes: boolean };

/** Snapshot of a state, result or params schema. Throws an Error naming `path` for anything outside the vocabulary. */
// 用途：为 state/result/params 生成快照。输入未知 schema 和错误路径，输出 Snapshot。
// 开放对象模式：普通对象 schema 可以不闭合；记录（只有 patternProperties）允许。错误以 Error 抛出。
// 例子：snapshotSchema(obj({ title: str() }), "task.title") 返回独立副本和规范形式。
export function snapshotSchema(source: unknown, path: string): Snapshot {
	return walk(source, path, "open", new Set());
}

/** Snapshot of a method's arguments: every object schema inside must also be closed (records allowed). */
// 用途：为方法参数生成快照。与 snapshotSchema 相同，但对象必须闭合（additionalProperties: false）；
// 只有 patternProperties 的记录是例外。输入未知 schema 和路径，输出 Snapshot。
export function snapshotArguments(source: unknown, path: string): Snapshot {
	return walk(source, path, "closed", new Set());
}

/** Whether object schemas must set `additionalProperties: false`. */
// 两种遍历模式：open 用于 state/result/params，closed 用于方法参数。
type Objects = "open" | "closed";

/** A copied keyword value, its normal form, and whether a schema inside it is a bytes leaf. */
// 每个关键字处理后的三件东西：副本、规范值、是否含 bytes 叶；父节点据此合并 bytes 标记。
type Copy = { readonly schema: unknown; readonly normal: JsonValue; readonly bytes: boolean };

/** Every supported keyword, grouped by how its value is walked. */
// 支持的关键字按“值怎么走”分组：schema/schemas/items/schemaMap 需要递归，type/required/enum/data 按数据处理，
// annotation 只在 schema 副本中保留、在规范形式中丢弃。白名单之外的关键字会被拒绝。
const KEYWORD_GROUPS = {
	schema: "additionalProperties additionalItems",
	schemas: "anyOf allOf prefixItems",
	items: "items",
	schemaMap: "properties patternProperties $defs",
	type: "type",
	required: "required",
	enum: "enum",
	data:
		"const default $ref $id pattern format minLength maxLength minimum maximum exclusiveMinimum exclusiveMaximum " +
		"multipleOf minItems maxItems uniqueItems minProperties maxProperties readOnly writeOnly",
	annotation: "title description examples $comment deprecated",
};

// keyof typeof KEYWORD_GROUPS 得到 "schema" | "schemas" | ... 的联合；它在运行时不存在，只用于 walkKeyword 的 switch 收窄。
type Keyword = keyof typeof KEYWORD_GROUPS;

// 把分组反向展开成“关键字 -> 分组”的 Map：例如 items -> "items"，properties -> "schemaMap"。
// Object.entries 遍历分组对象，flatMap 把空格分隔的名字拆开；每个条目变成 [name, keyword]。
const KEYWORDS = new Map(
	Object.entries(KEYWORD_GROUPS).flatMap(([keyword, names]) =>
		names.split(" ").map((name) => [name, keyword as Keyword]),
	),
);

// 支持的 type 值；bytes 是 pi-schema 扩展，不通过 JSON 传输。
const TYPES = new Set(["null", "boolean", "number", "integer", "string", "array", "object", "bytes"]);

// bytes 节点只允许这些关键字（再加上 annotation），避免在二进制叶上挂无意义的 schema 约束。
const BYTES_KEYWORDS = new Set(["type", "minLength", "maxLength"]);

// 用途：递归复制并检查一个 schema 节点。输入未知值、错误路径、对象闭合模式和祖先集合，输出 Snapshot。
// 流程：布尔 schema 直接复制 -> 必须是普通对象 -> 检测循环 -> 判断 bytes -> 遍历自有键并按分组处理 ->
//   合并 bytes 标记 -> 删除祖先记录 -> 检查参数对象闭合与 bytes 边界 -> 生成 schema/normal。
// 错误路径：非对象、循环、未知关键字、bytes 上的非法关键字、开放参数对象、非法 bytes 边界都会抛错。
function walk(source: unknown, path: string, objects: Objects, ancestors: Set<object>): Snapshot {
	// JSON Schema 允许布尔 schema（true 接受一切，false 拒绝一切）；它不是对象，单独处理。
	if (typeof source === "boolean") return { schema: source, normal: source, bytes: false };
	if (!isPlainObject(source)) throw new Error(`${path}: expected a schema`);
	// ancestors 记录当前递归路径上的对象；同一对象再次出现说明是循环，要求改用 $defs/$ref。
	if (ancestors.has(source)) throw new Error(`${path}: cyclic schema; use $defs and $ref for recursion`);
	const isBytes = source.type === "bytes";
	// 只在递归期间加入，处理完删除，因此兄弟节点共享同一对象不会被误判为循环。
	ancestors.add(source);
	const schema: [string, unknown][] = [];
	const normal: [string, JsonValue][] = [];
	let bytes = isBytes;
	for (const [key, value] of ownEntries(source, path)) {
		const keyword = KEYWORDS.get(key);
		// 白名单外拒绝；bytes 节点上只允许 annotation 和 BYTES_KEYWORDS，防止挂上不合适的约束。
		if (keyword === undefined || (isBytes && keyword !== "annotation" && !BYTES_KEYWORDS.has(key))) {
			throw new Error(`${path}: unsupported keyword "${key}"`);
		}
		const copy = walkKeyword(keyword, value, `${path}.${key}`, objects, ancestors);
		// 子树只要有一处 bytes，父节点也标记为 bytes，供链接决定整棵值是否走原始字节段。
		bytes ||= copy.bytes;
		schema.push([key, copy.schema]);
		// Annotations are dropped on schema nodes only; inside data they are ordinary keys.
		// 注解（title/description 等）只影响可读性，不应改变指纹，因此在规范形式中丢弃；data 里的同名键是普通数据，保留。
		if (keyword !== "annotation") normal.push([key, copy.normal]);
	}
	ancestors.delete(source);
	const node = Object.fromEntries(schema);
	// 方法参数里的对象必须闭合；记录只有 patternProperties，没有 properties，不算“开放对象”。
	if (objects === "closed" && isOpenObject(node)) {
		throw new Error(`${path}: argument objects must be closed (additionalProperties: false)`);
	}
	// bytes 的长度边界必须是安全非负整数；其他关键字已在上面过滤。
	if (isBytes) checkBytesBounds(node, path);
	return { schema: node, normal: Object.fromEntries(normal), bytes };
}

// 用途：按关键字分派处理一个值。输入分组名、原始值、路径、对象模式和祖先集合，输出 Copy。
// switch 覆盖所有 Keyword 分支，TS 因此知道每个 case 的语义；schema 递归、schemas/items 列表递归、
// schemaMap 逐键递归，type/required/enum/data/annotation 各自做类型检查或复制。
function walkKeyword(keyword: Keyword, value: unknown, path: string, objects: Objects, ancestors: Set<object>): Copy {
	switch (keyword) {
		case "schema":
			return walk(value, path, objects, ancestors);
		case "schemas":
			return walkList(value, path, objects, ancestors);
		case "items":
			// items 在旧版 JSON Schema 里可以是单个 schema，也可以是元组数组；两种都支持。
			return Array.isArray(value)
				? walkList(value, path, objects, ancestors)
				: walk(value, path, objects, ancestors);
		case "schemaMap": {
			if (!isPlainObject(value)) throw new Error(`${path}: expected an object of schemas`);
			// 每个键的值都是 schema；逐项 walk 后分别组装副本和规范形式。
			const entries = ownEntries(value, path).map(
				([key, item]) => [key, walk(item, `${path}.${key}`, objects, ancestors)] as const,
			);
			return {
				schema: Object.fromEntries(entries.map(([key, item]) => [key, item.schema])),
				normal: Object.fromEntries(entries.map(([key, item]) => [key, item.normal])),
				bytes: entries.some(([, item]) => item.bytes),
			};
		}
		case "type":
			// type 必须是支持的字符串；类型联合数组在这里不支持，因为契约词汇表只接受单一类型。
			if (typeof value !== "string" || !TYPES.has(value)) {
				throw new Error(`${path}: unsupported type ${JSON.stringify(value)}`);
			}
			return { schema: value, normal: value, bytes: false };
		case "required": {
			// required 必须是字符串数组；排序后再作为规范形式，避免声明顺序改变指纹。
			if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
				throw new Error(`${path}: expected an array of strings`);
			}
			const names = [...value].sort();
			return { schema: names, normal: names, bytes: false };
		}
		case "enum": {
			// enum 先按 JSON 数据规则复制和检查，再按 JSON 字符串排序，保证规范形式稳定。
			const values = data(value, path).normal;
			if (!Array.isArray(values)) throw new Error(`${path}: expected an array`);
			const sorted = [...values].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
			return { schema: sorted, normal: sorted, bytes: false };
		}
		case "data":
		case "annotation":
			return data(value, path);
	}
}

// 用途：处理 schema 数组（anyOf/allOf/prefixItems 或元组式 items）。输入未知值、路径、模式、祖先，输出 Copy。
// 每项递归 walk；数组顺序保留，因为联合/元组的语义依赖顺序。非数组直接报错。
function walkList(value: unknown, path: string, objects: Objects, ancestors: Set<object>): Copy {
	if (!Array.isArray(value)) throw new Error(`${path}: expected an array of schemas`);
	const items = Array.from(value, (item, index) => walk(item, `${path}[${index}]`, objects, ancestors));
	return {
		schema: items.map((item) => item.schema),
		normal: items.map((item) => item.normal),
		bytes: items.some((item) => item.bytes),
	};
}

/** A JSON value as a copy with sorted keys; the same copy serves as snapshot and normal form. */
// 用途：复制并检查 JSON 数据（const/default/examples 等）。输入未知值，输出 Copy。
// isJsonValue 作为运行时类型谓词，阻止函数、undefined、NaN/Infinity、类实例等进入快照；
// 数据既作为 schema 副本的一部分，也原样作为规范形式（键已排序）。
function data(value: unknown, path: string): Copy {
	if (!isJsonValue(value)) throw new Error(`${path}: expected JSON data (finite numbers, plain objects and arrays)`);
	const copy = sortedCopy(value);
	return { schema: copy, normal: copy, bytes: false };
}

// 递归复制 JSON：标量直接返回，数组逐项复制，对象按排序后的键重建；不修改输入。
function sortedCopy(value: JsonValue): JsonValue {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(sortedCopy);
	const keys = Object.keys(value).sort();
	return Object.fromEntries(keys.map((key) => [key, sortedCopy(value[key]!)]));
}

/** Data entries sorted by key; symbol keys, accessors and non-enumerable keys (not data) are refused. */
// 用途：读取对象的自有属性并排序。输入对象和路径，输出 [key, value][]。
// 用 Reflect.ownKeys 能看到 symbol 和非可枚举键；这些若混入会让序列化/复制行为不可预测，因此明确拒绝。
// 只接受数据属性（descriptor 含 value），getter/setter 会在复制时执行代码，也拒绝。
function ownEntries(source: object, path: string): [string, unknown][] {
	const entries: [string, unknown][] = [];
	for (const key of Reflect.ownKeys(source)) {
		if (typeof key === "symbol") throw new Error(`${path}: symbol keys are not supported`);
		const descriptor = Object.getOwnPropertyDescriptor(source, key)!;
		if (!("value" in descriptor)) throw new Error(`${path}.${key}: accessors are not supported`);
		if (!descriptor.enumerable) throw new Error(`${path}.${key}: non-enumerable keys are not supported`);
		entries.push([key, descriptor.value]);
	}
	return entries.sort(([a], [b]) => compare(a, b));
}

// 类型谓词：只接受原型为 Object.prototype 或 null 的普通对象；数组、null、类实例、Map 等都不算。
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** An object schema that admits unknown fields. A record (pattern properties only) is allowed. */
// 判断“开放对象”：有 patternProperties 且没有 properties 的记录不算；有 type: "object" 或 properties，
// 却没写 additionalProperties: false 的算开放，方法参数会拒绝。
function isOpenObject(node: Record<string, unknown>): boolean {
	const isRecord = "patternProperties" in node && !("properties" in node);
	const isObject = node.type === "object" || "properties" in node;
	return isObject && !isRecord && node.additionalProperties !== false;
}

// bytes 的 minLength/maxLength 必须是安全非负整数；undefined 表示未设置，允许。
function checkBytesBounds(node: Record<string, unknown>, path: string): void {
	for (const bound of [node.minLength, node.maxLength]) {
		if (bound !== undefined && !(Number.isSafeInteger(bound) && (bound as number) >= 0)) {
			throw new Error(`${path}: bytes bounds must be non-negative integers`);
		}
	}
}

// 稳定的字符串比较：按 UTF-16 码元，不依赖 locale，保证跨平台规范形式一致。
function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
