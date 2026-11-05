/**
 * 不依赖TypeBox运行代码的静态类型适配：按TypeBox 1.x的~kind/~unsafe/~optional/~readonly类型形状，推导工具参数类型。
 * 例TypeBox Object({name:String})在此推成{name:string}；未实现的类型种类退unknown，不代表运行时会自动验证。
 * 本文件只有type/interface，编译后无运行JS；它和builders.ts的类型循环不会变成运行时模块循环。
 */
// The static types of TypeBox-built schemas, read from the type shapes TypeBox 1.x declares (`'~kind'`, `'~optional'`,
// `'~readonly'`, `'~unsafe'`) without importing TypeBox, so `Static` also types tool arguments of TypeBox schemas.
// Only the common kinds are mapped; every other kind (Enum, Tuple, Intersect, Cyclic, Ref, ...) is `unknown`.

// 复用本库Static，递归兼容嵌套builder/TypeBox类型；type导入擦除。
import type { Static } from "./builders.ts";

/** The value type of a TypeBox schema type by its `'~kind'`, or its `Type.Unsafe` type; `unknown` for other kinds. */
/** 先用~kind分派，没kind再取~unsafe声明值；只是条件类型，不读取JSON或实例。 */
export type TypeBoxStatic<S> = S extends { readonly "~kind": infer K }
	? // infer K提取确切种类名，交KindStatic。
		KindStatic<S, K>
	: // Unsafe通过虚拟类型字段直接携带作者指定的T。
		S extends { readonly "~unsafe": infer T }
		? // 它是作者的类型断言，不证明任意运行值满足T。
			T
		: // 其余形状无法推导。
			unknown;

/** TypeBox种类名到TS基本类型的查表接口，大小写匹配种类名，不是JS构造函数调用。 */
interface Primitives {
	// String种类→string基础类型。
	String: string;
	// Number→number，不表达上下界/有限性。
	Number: number;
	// Integer仍只能推成number，整数性需运行验证。
	Integer: number;
	// Boolean→boolean。
	Boolean: boolean;
	// Null→null，不等于undefined。
	Null: null;
	// Unknown保留unknown，使用前需收窄。
	Unknown: unknown;
	// TypeBox Any的语义就是any，这份适配按原种类保留其静态放行行为。
	Any: any;
}

/** 按K逐种类推导；映射不足处unknown，不是JSON Schema任意结构的通用类型推导器。 */
type KindStatic<S, K> = K extends keyof Primitives
	? // K是基本种类键时，用索引访问类型取对应值。
		Primitives[K]
	: // 非基本种类先看Literal。
		K extends "Literal"
		? // 条件类型匹配const字段并infer其字面量类型。
			S extends { readonly const: infer V }
			? // 保留V，不泛化成string/number。
				V
			: // 缺const就unknown。
				unknown
		: // Array从items推元素类型。
			K extends "Array"
			? // infer I取元素schema类型。
				S extends { readonly items: infer I }
				? // Static<I>[]是普通可变数组，不自动附带JSON Schema长度约束。
					Static<I>[]
				: // 没items不能推导元素。
					unknown
			: // Object从properties推具名字段。
				K extends "Object"
				? // infer P取属性映射。
					S extends { readonly properties: infer P }
					? // 交下面四组映射保留可选/只读标记。
						ObjectStatic<P>
					: // 没properties则unknown。
						unknown
				: // Union读取anyOf候选，而非oneOf唯一匹配语义。
					K extends "Union"
					? // readonly (infer B)[]提取数组元素联合。
						S extends { readonly anyOf: readonly (infer B)[] }
						? // 递归Static会对联合分支分配，得到值联合。
							Static<B>
						: // 无anyOf则unknown。
							unknown
					: // Record从patternProperties推字典。
						K extends "Record"
						? // infer P得到模式→schema类型表。
							S extends { readonly patternProperties: infer P }
							? // keyof P按已知数值键模式映为number或string；P[keyof P]取候选值schema联合。
								Record<RecordKey<keyof P>, Static<P[keyof P]>>
							: // 缺模式表无法推导。
								unknown
						: // Enum/Tuple/Intersect/Ref等未列种类都unknown，不等于实际schema必然无效。
							unknown;

// 这是TypeBox类型标记，与builders.ts运行时Optional类不是同一种实现。
type Optional = { readonly "~optional": true };

// Readonly在这里只是本地别名，不是TS内置Readonly<T>工具类型。
type Readonly = { readonly "~readonly": true };

// As TypeBox: no properties is `object`; `'~optional'` properties may be omitted, `'~readonly'` ones are readonly.
/** 对象分四组：必填可写、可选可写、必填只读、可选只读；交叉后Simplify。TypeBox空属性结果按其惯例为object，不是“只允许空对象”。 */
type ObjectStatic<P> = keyof P extends never
	? // keyof P为never代表没有已知属性，返回宽TS object。
		object
	: // 多组交叉后重新映射为易显示的对象类型。
		Simplify<
			// 排除任一Optional/Readonly标记，剩必填可写键；as never是过滤键，-readonly去输入readonly。
			{ -readonly [K in keyof P as P[K] extends Optional | Readonly ? never : K]: Static<P[K]> } & {
				// 仅Optional且非Readonly的键，加?；字段值仍递归Static。
				-readonly [K in keyof P as P[K] extends Optional ? (P[K] extends Readonly ? never : K) : never]?: Static<
					// P[K]取对应属性schema类型。
					P[K]
				>;
				// &连接下一组必填只读字段。
			} & {
				// 仅Readonly且非Optional的键，明确readonly，不加?。
				readonly [K in keyof P as P[K] extends Readonly ? (P[K] extends Optional ? never : K) : never]: Static<
					// 只读约束是值对象字段层级，不自动深冻结嵌套对象。
					P[K]
				>;
				// 继续交叉可选只读组。
			} & {
				// 同时有两种标记才留下键，加readonly与?。
				readonly [K in keyof P as P[K] extends Optional ? (P[K] extends Readonly ? K : never) : never]?: Static<
					// 嵌套值类型由Static递归处理，不因optional丢掉原字面量类型。
					P[K]
				>;
			}
		>;

// 把交叉类型的键重映射成直观对象形状；没有运行时复制。
type Simplify<T> = { [K in keyof T]: T[K] } & {};

// TypeBox's key patterns for integer and number keys; every other pattern types its keys as strings.
/** 只对这两段精确TypeBox数字键模式映number，其余全部string；不是运行正则识别所有等价模式。 */
type RecordKey<Pattern> = Pattern extends "^-?(?:0|[1-9][0-9]*)$" | "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$"
	? // 命中整数/小数字符串键模式，静态字典键用number。
		number
	: // 其他模式一律宽string；模式内容仍由运行时schema validator检查。
		string;
