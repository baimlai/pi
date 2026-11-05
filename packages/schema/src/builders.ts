/**
 * schema构造器：str/obj/arr等只创建普通JSON Schema数据，同时用泛型记下“通过验证后应是什么TS类型”。
 * 例const Read=obj({path:str(),offset:opt(int())})，Static<typeof Read>为{path:string;offset?:number}。
 * 创建规则不等于检查用户输入；必须把规则交compile，再调check/parse等验证。此模块无IO，不自动填default。
 * 选项最终用对象展开原样合并，不做运行时白名单；TS选项类型不能阻止运行时额外字段覆盖已有规则。
 */
// Schema builders: short functions that return plain JSON Schema objects and carry the static type of the values
// they accept, so `Static<typeof schema>` is the TypeScript type a valid value has. The objects are ordinary data:
// they serialize with JSON.stringify and compile with compile() like any other schema.

// TypeBox兼容是纯类型运算，import type擦除，不在运行时加载TypeBox。
import type { TypeBoxStatic } from "./typebox-static.ts";

// declare只声明编译期常量，不调用Symbol、不生成运行变量；unique symbol给类型一个专属键。
declare const STATIC: unique symbol;
// 可选包装也有独立的编译期键，避免两个品牌意外混同。
declare const OPTIONAL_TYPE: unique symbol;

/** A JSON Schema object whose valid values have type `T` (a type-level brand; nothing extra exists at run time). */
// &交叉类型同时带“任意只读schema键”和可选T品牌；[STATIC]只在类型里出现，构造结果没有这个真实属性。
export type Schema<T = unknown> = { readonly [keyword: string]: unknown } & { readonly [STATIC]?: T };

// TypeBox is tested first and in its own branch: a builder brand's fallback through TypeBoxStatic would leave
// `Static<S>` of a generic `S` (constrained to builder schemas) unresolvable to its constraint's types.
/**
 * The type of the values `S` accepts: the type a builder recorded; for a TypeBox schema (`'~kind'` or `'~unsafe'`),
 * TypeBox's static type for the common kinds (see `TypeBoxStatic`); else `unknown`.
 */
/** 从schema类型S取值类型；先匹配TypeBox标记，再取本模块品牌，否则unknown。它不读取运行对象，也不从任意{type:"string"}字面量完整推断JSON Schema语义。 */
export type Static<S> = S extends { readonly "~kind": unknown } | { readonly "~unsafe": unknown }
	? // 检到TypeBox的~kind或~unsafe类型形状，交专门条件类型处理。
		TypeBoxStatic<S>
	: // infer T从Schema<T>的虚拟品牌推断T；这里只是编译期匹配。
		S extends { readonly [STATIC]?: infer T }
		? // unknown extends T判断推断是否太宽；含any/unknown等无法可靠约束时按这里规则退unknown。
			unknown extends T
			? // 宽泛类型保守返回unknown，而非让调用方随意访问字段。
				unknown
			: // 品牌携带明确T时直接取它。
				T
		: // 无可识别品牌/TypeBox类型形状时无法推断，返回unknown。
			unknown;

/** Annotations every builder accepts: they describe the schema and never change what it accepts. */
/** 构造器可选描述信息，与annotations.ts的“已求值位置记录”是不同概念；泛型T让examples/default跟随值类型。 */
export interface Annotations<T = unknown> {
	// schema标题；readonly只是TS禁止重赋，不会冻结JSON对象。
	readonly title?: string;
	// 可读描述，校验器不把它当断言。
	readonly description?: string;
	// 示例列表是只读T数组，不会自动拿示例去运行验证。
	readonly examples?: readonly T[];
	// 弃用提示，只是元数据。
	readonly deprecated?: boolean;
	/** A default value, an annotation for tools and forms; validation never inserts it. */
	// 默认值也只作说明，构造/验证都不自动插入到用户数据。
	readonly default?: T;
}

/** Length bounds of a string, an array or bytes. */
/** 长度约束字段容器；字符串按码点、bytes按字节数组长度，具体含义由schema type和验证器决定。 */
export interface LengthBounds {
	// 可选下界；此处不检查非负/整数或与上界关系。
	readonly minLength?: number;
	// 可选上界，不是JS字符串slice的截断指令。
	readonly maxLength?: number;
}

/** A string, with optional length bounds (in code points), pattern and format. */
/** 构造字符串规则；例str({minLength:1})得到{type:"string",minLength:1}。只返回数据，不验证某个输入，pattern/format由compile路径处理。 */
export function str(
	// &把描述、长度和pattern/format三份字段合在一个选项类型里；={}使参数可省略。
	options: Annotations<string> & LengthBounds & { readonly pattern?: string; readonly format?: string } = {},
): Schema<string> {
	// 先写type再展开options；不复制options内部嵌套值，也不运行正则。
	return { type: "string", ...options };
}

/** Bounds of a number. */
/** 数值界限；number类型本身不保证这些值有限、合法或互相一致。 */
export interface NumberBounds {
	// 含端点最小值。
	readonly minimum?: number;
	// 含端点最大值。
	readonly maximum?: number;
	// 不含端点最小值。
	readonly exclusiveMinimum?: number;
	// 不含端点最大值。
	readonly exclusiveMaximum?: number;
	// 要求是此值的倍数，浮点小数规则由验证器实现。
	readonly multipleOf?: number;
}

/** A number within optional bounds. */
/** 构造number规则；例num({minimum:0})描述非负数。不会把字符串"1"转数字，也不检查当前值，转换需另用coercing validator。 */
export function num(options: Annotations<number> & NumberBounds = {}): Schema<number> {
	// 普通对象字面量，options后展开可覆盖运行时同名字段。
	return { type: "number", ...options };
}

/** An integer within optional bounds. */
/** 构造integer规则；例int({maximum:10})。TS值类型仍是number，是否整数要运行check才能判断；不在这里取整。 */
export function int(options: Annotations<number> & NumberBounds = {}): Schema<number> {
	// JSON Schema type是integer，但静态类型不能表达所有整数限制。
	return { type: "integer", ...options };
}

/** A boolean. */
/** 构造布尔规则，例bool({default:false})只带默认说明，不会替缺失输入补false。无IO。 */
export function bool(options: Annotations<boolean> = {}): Schema<boolean> {
	// 返回boolean类型的规则数据，不返回布尔校验结果。
	return { type: "boolean", ...options };
}

/** `null`. */
/** 构造仅接受null的规则；例nul()，它与可选/undefined不同。只创建数据，不修改输入。 */
export function nul(options: Annotations<null> = {}): Schema<null> {
	// 字符串"null"是schema里的类型名，而非要检查的用户数据。
	return { type: "null", ...options };
}

/** Any value. */
/** 构造无类型断言的规则，例unknown({description:"任意值"})。unknown在此是函数名，也用于返回泛型；不会等同any的静态放行。 */
export function unknown(options: Annotations = {}): Schema<unknown> {
	// 没默认type，只复制选项为新对象，{}规则可接受任意值。
	return { ...options };
}

/** Exactly `value` (a string, number, boolean or null). */
/** 构造单值规则；例lit("read")保留静态字面量"read"而非泛化string。const泛型帮助保留字面量，实际验证由compile处理。 */
export function lit<const V extends string | number | boolean | null>(
	// V限定为字符串/数值/布尔/null之一，不在函数内再验证受静态约束的value。
	value: V,
	// 描述/示例/default也使用同一个V类型。
	options: Annotations<V> = {},
): Schema<V> {
	// 返回const关键字数据，原始value是基础值无需深复制。
	return { const: value, ...options };
}

/** One of the given values. */
/** 构造枚举值规则；例oneOf(["read","write"])→enum与静态"read"|"write"。函数名oneOf在这里不是JSON Schema的oneOf分支关键字。 */
export function oneOf<const V extends readonly (string | number | boolean | null)[]>(
	// const泛型保留只读元组候选及每个字面量。
	values: V,
	// V[number]取所有数组元素类型的联合，而不是特定下标。
	options: Annotations<V[number]> = {},
): Schema<V[number]> {
	// 保存同一values数组引用，没有去重、冻结或拷贝；空列表最终不接受任何值。
	return { enum: values, ...options };
}

/**
 * Any of the given schemas. A union of objects tagged by a `lit()` property (`{ kind: lit("text"), ... }`) is checked
 * by the tag: only the branch it selects runs, and its errors are the ones reported.
 */
/** 构造schema联合；例union([str(),num()])→anyOf与静态string|number。带必填const标签的对象联合可由Compiler优化选分支，此函数只组织数据。 */
export function union<const S extends readonly Schema[]>(
	// S为各个schema的只读数组/元组。
	schemas: S,
	// 先取元素联合S[number]，再用Static取得值联合。
	options: Annotations<Static<S[number]>> = {},
): Schema<Static<S[number]>> {
	// 不调用每个schema，也不在这里选择最佳分支；数组仍原引用。
	return { anyOf: schemas, ...options };
}

/** `schema` or `null`. */
/** 构造可为null的联合，例nullable(str())接受string|null；不等于省略对象字段，后者要用opt。只创建anyOf数据。 */
export function nullable<T>(schema: Schema<T>, options: Annotations<T | null> = {}): Schema<T | null> {
	// 包一个新分支数组，原schema对象仍共用。
	return { anyOf: [schema, { type: "null" }], ...options };
}

/** An array of `items`, with optional length bounds and unique items. */
/** 构造同元素类型数组，例arr(str(),{maxItems:2})是string[]的长度规则；不会遍历或验证输入数组。 */
export function arr<T>(
	// items描述每项，泛型T沿schema品牌推断。
	items: Schema<T>,
	// 描述的值类型是T[]，再合入数组专属限制字段。
	options: Annotations<T[]> & {
		// 最少项目数，与字符串minLength不是同一关键字。
		readonly minItems?: number;
		// 最多项目数。
		readonly maxItems?: number;
		// 是否要求项目深比较唯一，不是在构造器里自动去重。
		readonly uniqueItems?: boolean;
		// 整个options可省略，字段类型不替运行数据做验证。
	} = {},
): Schema<T[]> {
	// 新数组schema对象，items仍同一个schema引用。
	return { type: "array", items, ...options };
}

/** A fixed-length array whose items match `items` in order. */
/** 构造定长元组，例tuple([str(),num()])静态为[string,number]。2020-12中prefixItems限制各位置、items:false拒绝多余项、minItems要求不少项。 */
export function tuple<const S extends readonly Schema[]>(
	// S保留每个位置各自的schema类型，不能当所有元素相同的普通数组。
	items: S,
	// 映射类型逐下标取Static；-readonly把只读输入元组映成可变的值元组。
	options: Annotations<{ -readonly [K in keyof S]: Static<S[K]> }> = {},
	// 返回Schema的值泛型同样是逐位置推导的元组。
): Schema<{ -readonly [K in keyof S]: Static<S[K]> }> {
	// 最少长度+禁止额外项目共同固定长度；这里没有再写maxItems，draft7对prefixItems语义不同，需按compile所选draft理解。
	return { type: "array", prefixItems: items, items: false, minItems: items.length, ...options };
}

/** An object with string keys and values of `value` (a record). */
/** 构造字符串键字典，例map(num())为Record<string,number>。每个额外字段按value规则验证，构造时不枚举用户对象。 */
export function map<T>(value: Schema<T>, options: Annotations<Record<string, T>> = {}): Schema<Record<string, T>> {
	// additionalProperties接schema，不是只允许true/false；只新建外层对象。
	return { type: "object", additionalProperties: value, ...options };
}

/** A Uint8Array with optional length bounds (an extension of JSON Schema for values that never pass through JSON). */
/** 构造Uint8Array规则，例bytes({maxLength:8})。这是本库扩展，适合内存二进制，不是标准JSON传输后的普通对象/数组。 */
export function bytes(options: Annotations<Uint8Array> & LengthBounds = {}): Schema<Uint8Array> {
	// type:bytes由本库check支持，不在此编码base64或复制字节。
	return { type: "bytes", ...options };
}

/** An optional property of obj(): `{ name: opt(str()) }` may omit `name` or set it to undefined. */
/** obj属性的可选包装；例opt(str())包装字符串schema，obj会拆包。实例自身不是最终JSON Schema片段，别把包装器直接当已构造属性数据。 */
export class Optional<S extends Schema = Schema> {
	// declare字段只携带S类型，运行对象没有OPTIONAL_TYPE符号字段。
	declare readonly [OPTIONAL_TYPE]?: S;
	// 真实保存的schema引用；readonly不使内部schema深只读。
	readonly schema: S;

	/** 保存被包装schema，例new Optional(str())；不克隆、不验证、不执行IO。 */
	constructor(schema: S) {
		// 显式字段赋值是可擦除TS写法，没有参数属性语法。
		this.schema = schema;
	}
}

/** Marks an obj() property as optional. */
/** 给obj标记一个可选字段，例obj({name:opt(str())})。返回本模块Optional实例，仍不校验用户name。 */
export function opt<S extends Schema>(schema: S): Optional<S> {
	// 每次新建包装对象；obj稍后通过instanceof Optional识别本构造器实例。
	return new Optional(schema);
}

/** The properties of obj(): a schema or an opt() schema per name. */
// 索引签名表示任意字段名的值要么schema，要么Optional包装；readonly约束字段重赋。
export type Properties = { readonly [name: string]: Schema | Optional };

/** The value type of an obj() schema. */
/** 把obj字段表变值类型：必填属性与可选属性分两组映射再交叉；例{a:str(),b:opt(num())}→{a:string;b?:number}。全是编译期运算。 */
export type StaticObject<P extends Properties> = Simplify<
	// keyof P枚举键；as ... never过滤可选键，-readonly去掉输入只读，Static取每项值类型。
	{ -readonly [K in keyof P as P[K] extends Optional ? never : K]: Static<P[K]> } & {
		// 第二组只留下Optional键，加?表示可省略；infer S提取包装内部schema类型。
		-readonly [K in keyof P as P[K] extends Optional ? K : never]?: P[K] extends Optional<infer S>
			? // 可选字段值取被包装schema的Static，而非Optional实例类型。
				Static<S>
			: // 理论上本分支由Optional筛选保证；不匹配回退never，不生成运行时错误。
				never;
	}
>;

// 重新映射交叉类型的所有字段，帮助IDE展示合并后的形状；不复制真实对象。
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * A closed object: the given properties (required unless opt()) and no others. `open: true` allows other
 * properties, as tool schemas from other systems often do.
 */
/**
 * 构造对象规则：拆open→建立属性schema表→拆Optional并收集required→默认关额外字段→合并描述。
 * 例obj({path:str(),offset:opt(int())})必填path；{open:true}允许额外属性，但StaticObject不会凭此添加索引签名。
 * 无IO、不验证当前用户对象；props是普通对象赋值，不专门隔离__proto__等特殊键。选项/字段对象均未深冻结。
 */
export function obj<const P extends Properties>(
	// const P保留字段名、字面量schema及可选包装的精确类型。
	properties: P,
	// 元数据跟对象值类型走，open只控制生成额外字段规则。
	options: Annotations<StaticObject<P>> & { readonly open?: boolean } = {},
): Schema<StaticObject<P>> {
	// 对象剩余解构把open从其余元数据里拆掉，避免把open作为JSON Schema关键字输出。
	const { open, ...annotations } = options;
	// 新建属性字典，不是无原型对象；记录仍引用输入的子schema。
	const props: Record<string, Schema> = {};
	// 只把未包装字段名列为required。
	const required: string[] = [];
	// Object.entries遍历自有可枚举字符串字段，符号字段不进入JSON属性表。
	for (const [name, property] of Object.entries(properties)) {
		// 运行时要识别真实Optional实例；只长得像{schema}的普通对象不走拆包。
		if (property instanceof Optional) props[name] = property.schema;
		// 未标可选就是必填。
		else {
			// 保存子schema原引用。
			props[name] = property;
			// required按输入枚举顺序追加。
			required.push(name);
		}
	}
	// 返回最终对象schema，不返回验证器实例。
	return {
		// 明确约束为对象，非对象值由后续check拒绝。
		type: "object",
		// 最终字段表，Optional已去掉包装。
		properties: props,
		// 没必填字段就省略required关键字，不写空数组。
		...(required.length > 0 ? { required } : {}),
		// 只有open严格true才省additionalProperties:false，否则默认关闭额外字段。
		...(open === true ? {} : { additionalProperties: false }),
		// 元数据后展开，运行时额外字段仍可覆盖前面规则，类型约束不是白名单过滤。
		...annotations,
	};
}
