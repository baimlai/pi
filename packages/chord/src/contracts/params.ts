// Params declarations: the policy for params fields and the closed object schema checked on every get.

// 文件导读
// 所属模块：packages/chord/src/contracts，契约与 host 种类的 params 策略。
// 解决的问题：params 参与对象身份、地址 key 和每次请求的检查，因此只允许扁平、必填的标量字段
//   （str/int/bool/字符串字面量联合），并生成一个闭合对象 schema 供路由和 get 校验。
// 职责边界：只读取声明的 schema 并检查其规范形式；不校验实际参数值（那是 validator/checkParams 的事），
//   不做默认值填充（params 字段禁止 default）。
// 上游：remote/local 与 hostKind 调用 readParams；下游：路由用 schema 检查 params，addressKey 用 joinKey
//   拼 key，fingerprint 用 ParamsData.normal。错误以带路径的 Error 抛给声明方。
// 能力清单：
// - ParamSchema：允许的参数字段类型（标量或字符串字面量联合，且不能有 default）。
// - Params、RequiredFields：参数表类型，RequiredFields 在编译期拒绝可选字段。
// - ParamsData：运行时结果，含字段顺序、闭合对象 schema 和规范形式。
// - readParams()：唯一入口，逐字段快照并做白名单检查。
// - joinKey()：用 | 拼接并转义 key 组成，供地址 key 使用。
// - isParamSchema()、PARAM_KEYWORDS、isStringLiteral()：规范形式白名单的内部实现。
// 组合关系：readParams -> 每个字段 snapshotSchema -> isParamSchema 检查 normal -> 组装 schema/fields/normal；
//   host-kind.addressKey 调 joinKey，路由用 ParamsData.schema 校验取值。
// 示例：
//   const data = readParams([["owner", str()], ["limit", int({ min: 0 })]], "notes.params");
//   // data.fields === ["owner", "limit"]
//   // data.schema 是 { type: "object", properties: {...}, required: [...], additionalProperties: false }
// 建议阅读顺序：先看 ParamSchema/Params/ParamsData 的约束和字段含义，再看 readParams 的检查流程，
//   随后看 isParamSchema/PARAM_KEYWORDS 的白名单，最后看 joinKey 的转义规则。

import type { JsonValue } from "../json.ts";
import {
	type BooleanSchema,
	type IntegerSchema,
	isOptional,
	type LiteralsSchema,
	type Optional,
	type Schema,
	type StringSchema,
} from "./schema.ts";
import { snapshotSchema } from "./snapshot.ts";

/** A params field: a string, an integer, a boolean or a union of string literals; constraints allowed, no default. */
// 允许的参数字段类型。`& { readonly default?: never }` 在类型层禁止 default 属性；
// 运行时 readParams 还会按规范形式再检查一次，因为 JS 调用方不受此约束。
type ParamSchema = (StringSchema | IntegerSchema | BooleanSchema | LiteralsSchema<string>) & {
	readonly default?: never;
};

/** Params: a flat record of required fields, in identity order. */
// 参数表必须是扁平对象；键的插入顺序就是身份顺序，会影响 joinKey 拼出的地址 key。
export type Params = { readonly [field: string]: ParamSchema };

/** Refuses optional params fields, which the field types alone admit. */
// 映射类型：如果某字段是 Optional，就把它的类型映射成 never，使 P & RequiredFields<P> 无法成立。
// 这是纯编译期约束；运行时靠 isOptional 检查。
export type RequiredFields<P extends Params> = {
	[F in keyof P]: P[F] extends Optional ? never : P[F];
};

// readParams 的结果：fields 保持声明顺序；schema 是可供 validator 使用的闭合对象 schema；
// normal 是 [字段名, 规范形式] 数组，参与指纹，顺序同样固定。
export type ParamsData = {
	/** Field names in identity order. */
	readonly fields: readonly string[];
	/** The closed object schema of all fields. */
	readonly schema: Schema;
	/** `[field, normal form]` pairs in identity order. */
	readonly normal: JsonValue;
};

/** Reads declared params fields: each a required str(), int(), bool() or oneOf(...) of strings, constraints allowed. */
// 用途：读取并校验声明的 params。输入 [字段名, 未知 schema] 数组和错误路径前缀，输出 ParamsData。
// 副作用：无（只做快照）。错误路径：可选字段、带默认值、非标量、非字符串字面量联合、非法约束都会抛错；
// 错误信息带上 `path.field` 便于定位。
// 流程：逐字段排除 Optional -> snapshotSchema 校验 vocabulary -> isParamSchema 按规范形式做白名单检查 ->
// 组装 schema/fields/normal。
// 例子：readParams([["owner", str()]], "notes.params") 返回 fields=["owner"] 和闭合对象 schema。
export function readParams(declared: readonly [string, unknown][], path: string): ParamsData {
	const fields = declared.map(([field, schema]) => {
		const fieldPath = `${path}.${field}`;
		const refused = new Error(`${fieldPath}: a param is a required str(), int(), bool() or oneOf(...) of strings`);
		// Optional 是 pi-schema 的运行时标记对象；params 不允许可选字段。
		if (isOptional(schema)) throw refused;
		// snapshotSchema 先做通用 schema 校验并生成规范形式；下面再用 params 专用白名单收紧。
		const snapshot = snapshotSchema(schema, fieldPath);
		if (!isParamSchema(snapshot.normal)) throw refused;
		return [field, snapshot] as const;
	});
	// 闭合对象 schema：properties 保留声明顺序，required 列出全部字段，additionalProperties: false 拒绝多余键。
	const schema = {
		type: "object",
		properties: Object.fromEntries(fields.map(([field, snapshot]) => [field, snapshot.schema])),
		required: fields.map(([field]) => field),
		additionalProperties: false,
	};
	return {
		fields: fields.map(([field]) => field),
		schema,
		normal: fields.map(([field, snapshot]) => [field, snapshot.normal]),
	};
}

/** Joins key parts with `|`, each escaped (`\\` and `|`), so two different part lists never join to one key. */
// 用途：安全拼接 key。输入字符串数组，输出用 | 连接的字符串。
// 先把反斜杠转义成 \\，再把 | 转义成 \|；这样 "a|b" 与 ["a","b"] 不会拼成同一个 key。无副作用。
// 例子：joinKey(["session", "S1"]) === "session|S1"。
export function joinKey(parts: readonly string[]): string {
	return parts.map((part) => part.replaceAll("\\", "\\\\").replaceAll("|", "\\|")).join("|");
}

// 规范形式中的一个 schema 节点；键是 JSON Schema 关键字，值是 JSON 数据。
type SchemaNode = { readonly [keyword: string]: JsonValue };

// 用途：判断规范形式是否属于 params 允许的子集。输入 JsonValue，输出布尔。
// oneOf 分支只允许纯字符串字面量；其他类型按 PARAM_KEYWORDS 白名单逐键检查，出现多余关键字即拒绝。
function isParamSchema(normal: JsonValue): boolean {
	const node = normal as SchemaNode;
	if (node.anyOf !== undefined) {
		// 只允许 anyOf 一个键，且每个分支都是 { type: "string", const: "..." } 形态。
		return Object.keys(node).length === 1 && Array.isArray(node.anyOf) && node.anyOf.every(isStringLiteral);
	}
	const allowed = PARAM_KEYWORDS.get(node.type);
	return allowed !== undefined && Object.keys(node).every((key) => allowed.has(key));
}

/** Keywords a params field may use, by type. */
// 每种标量类型允许的约束关键字。Map 的键是规范形式里的 type 值，值是关键字集合。
const PARAM_KEYWORDS = new Map<unknown, ReadonlySet<string>>([
	["string", new Set(["type", "minLength", "maxLength", "pattern", "format"])],
	["integer", new Set(["type", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"])],
	["boolean", new Set(["type"])],
]);

// 判断一个 oneOf 分支是否为字符串字面量：type === "string"、const 是字符串，且恰好两个键。
function isStringLiteral(branch: JsonValue): boolean {
	const node = branch as SchemaNode;
	return node.type === "string" && typeof node.const === "string" && Object.keys(node).length === 2;
}
