// Schemas with the exact JSON TypeBox's `Type.Literal` and `Type.Record` built, so contracts declared with them keep
// the fingerprints they had under TypeBox (see the migration notes in CHANGELOG.md).

import type { Schema } from "@earendil-works/pi-schema";

/** `Type.Literal(value)`: the literal with its JSON type (pi-schema's `lit` has no `type`). */
// 构造保留旧 TypeBox JSON 形状的字面量 schema；只返回描述，不校验数据。
// const 泛型保留具体字面量，如 typedLit("a") 的 V 是 "a"，extends 限制三类原始值。
export function typedLit<const V extends string | number | boolean>(value: V): Schema<V> {
	// typeof 在这里产生 JSON schema 的 type，const 限定实际取值；例如 1 生成 {type:"number",const:1}。
	return { type: typeof value, const: value };
}

/** `Type.Record(Type.String(), value)`: one pattern property for every key (pi-schema's `map` uses `additionalProperties`). */
// 接收值的 schema，返回字符串键字典的 schema；无外部副作用。
// 例如 record(typedLit(1)) 描述每个匹配键的值只能是 1；Record<string,T> 只是 TypeScript 字典类型。
export function record<T>(value: Schema<T>): Schema<Record<string, T>> {
	// 正则 ^.*$ 匹配普通字符串键；保留旧 patternProperties 表达，不能改成 map 的 additionalProperties。
	return { type: "object", patternProperties: { "^.*$": value } };
}
