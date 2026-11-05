// 生成供应商易接受的字符串枚举 schema；这里的 enum 是 JSON Schema 数据字段，不是 TypeScript enum 语法。
// 只导入 schema 的类型，让工具定义可同时保留运行时约束和开发期取值类型。
import type { Schema } from "@earendil-works/pi-schema";

/**
 * Creates a string enum schema compatible with Google's API and other providers
 * that don't support anyOf/const patterns: `{ type: "string", enum: [...] }`.
 *
 * @example
 * const OperationSchema = StringEnum(["add", "subtract", "multiply", "divide"], {
 *   description: "The operation to perform"
 * });
 *
 * type Operation = Static<typeof OperationSchema>; // "add" | "subtract" | "multiply" | "divide" (Static from @earendil-works/pi-schema)
 */
// 用途：从一组字符串生成 {type:"string",enum:[...]}。例 StringEnum(["add","remove"] as const) 让运行时 schema 限制取值，并让 TS 推导相应字面量联合类型。
export function StringEnum<T extends readonly string[]>(
	// 泛型 T 保存调用方传入的字符串数组类型；readonly 表示本函数不需要修改它。
	values: T,
	// T[number] 是数组元素类型；default 在 TS 中应属于给定枚举，description/default 都可省略。
	options?: { description?: string; default?: T[number] },
	// 返回 schema 的类型参数记录合法字符串取值；类型声明本身不运行校验。
): Schema<T[number]> {
	return {
		// 运行时 JSON Schema 明确要求输入值是字符串。
		type: "string",
		// enum 列出合法的精确字符串；这里只保留数组引用，不复制数组。
		enum: values,
		// 条件对象展开：说明文字为真值时才带该字段；空字符串会被省略。
		...(options?.description && { description: options.description }),
		// 同样按真值条件添加 default；因此空字符串默认值不会被加入这个返回对象。
		...(options?.default && { default: options.default }),
	};
}
