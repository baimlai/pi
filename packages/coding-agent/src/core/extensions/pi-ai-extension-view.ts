// 给扩展提供 pi-ai 兼容导出视图，补回 TypeBox 入口及能放入 Type.Object 的 StringEnum；由 loader 别名/虚拟模块表选用。
/**
 * The `@earendil-works/pi-ai` module extensions import: pi-ai's compat entry point plus TypeBox's `Type`, `Static` and
 * `TSchema`, which pi-ai's main entry no longer re-exports, and a `StringEnum` built with TypeBox (`TUnsafe<T>`), so
 * extensions that use it inside `Type.Object` type-check and infer as before. The TypeBox is the coding agent's own,
 * the same one extensions get for `typebox`.
 */

// Type 为实际 schema 构造对象；type TUnsafe 只作泛型返回类型，编译后不保留这个导入名。
import { type TUnsafe, Type } from "typebox";

// 星号值重导出兼容入口的命名成员，不自动包含 default，也不在此调用其中模型请求函数。
export * from "@earendil-works/pi-ai/compat";
// 仅重导出 Static（schema 推导类型）与 TSchema（schema形状），二者不是可执行校验函数。
export type { Static, TSchema } from "typebox";
// 把宿主同一份 TypeBox Type 对象交给扩展，避免另造一份类型构造器。
export { Type };

/**
 * Creates a string enum schema compatible with Google's API and other providers that don't support anyOf/const
 * patterns: `{ type: "string", enum: [...] }`, typed for TypeBox's `Static`.
 */
// 构造字符串枚举 schema，输入允许值列表/可选说明及默认，返回 TypeBox TUnsafe，供后续对象 schema 和 Static 推导使用，无模型/文件操作。
// 例如 StringEnum(["read","write"] as const) 推导 "read"|"write"；这一步只建 schema，不验证某个入参，也不保证供应商接受所有值。
export function StringEnum<T extends readonly string[]>(
	// T extends readonly string[] 允许只读字符串元组，T[number] 之后可取所有元素类型的联合。
	values: T,
	// 可选对象内各字段也可缺省，default 在编译期必须属于 T[number]；数组若已被放宽为 string[]，默认值类型也会宽成 string。
	options?: { description?: string; default?: T[number] },
	// 返回 Unsafe schema 对应元素联合类型；Unsafe 表示作者提供静态类型，不等于禁用后续运行时 schema 校验。
): TUnsafe<T[number]> {
	// 调用宿主 Type.Unsafe 包装下面 JSON schema 并带上 TypeBox 元信息；不会对某个用户输入执行检查。
	return Type.Unsafe<T[number]>({
		// JSON schema 规定值是字符串。
		type: "string",
		// 枚举候选来自 values；双重 as 只绕过只读数组类型差异，不在这行复制/转换元素，TypeBox 内部如何处理对象由其实现决定。
		enum: values as unknown as T[number][],
		// 只有非空 description 才展开说明字段；可选链防 options 缺失，&& 也使空字符串被省略。
		...(options?.description && { description: options.description }),
		// 只有真值 default 才展开默认字段；即使枚举包含空字符串，default:"" 也会在这里被省略，不会填默认值到任何业务输入。
		...(options?.default && { default: options.default }),
	});
}
