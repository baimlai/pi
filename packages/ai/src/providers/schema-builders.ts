// 给模型元数据与兼容配置构造JSON Schema：开放对象、单一字符串、字符串键字典。这里返回规则数据，不验证某个配置、不补default，也不执行模型请求。
// model-schema/compat-schema等复用这些函数；实际校验必须由调用方交给pi-schema或配置验证器，Static只在编译期推导值类型。
// Builders for pi-ai's own configuration schemas (model metadata, compat settings): pi-schema's builders, shaped like the
// TypeBox schemas they replace, so models.json and the catalog validate exactly as before.

// 混合导入中type项会擦除，只有obj是本文件调用的运行函数。
import {
	// Annotations描述title/description/default/examples等元数据，泛型跟随值类型；default不是自动赋值指令。
	type Annotations,
	// obj会拆Optional属性、生成required，并按open决定是否拒绝额外键。
	obj,
	// Properties是属性名到Schema或Optional包装器的只读映射类型。
	type Properties,
	// Schema<T>把普通规则对象与静态值类型关联，不是验证器实例。
	type Schema,
	// Static从子schema品牌推导值类型，不在运行时读取用户值。
	type Static,
	// StaticObject把字段表分成必填与可选属性，开放对象也不会据此自动多出TS索引签名。
	type StaticObject,
} from "@earendil-works/pi-schema";

/** An object that allows other properties; `additionalProperties: true` says so explicitly. */
// 构造允许额外字段的对象规则，输入属性表/可选元数据，返回新schema，无I/O。例openObject({name:str()})要求name且允许额外age。
// 先拆additionalProperties，再以open:true调用obj；显式true才把该JSON关键字写出来。省略与true都开放，但静态结果仍只描述声明属性；属性与嵌套元数据不深复制，异常沿obj/属性访问传播。
export function openObject<const P extends Properties>(
	// const泛型P尽量保留字段名与每个schema精确类型；此参数仍是运行时原属性对象。
	properties: P,
	// 交叉类型合并对象元数据与只可为true的可选标志，readonly不冻结实参；={}在省略/undefined时提供空对象。
	options: Annotations<StaticObject<P>> & { readonly additionalProperties?: true } = {},
	// 返回Schema携带StaticObject<P>，不会因为返回注解就执行输入验证。
): Schema<StaticObject<P>> {
	// 对象剩余解构单独拿开放标志，把其他自有可枚举元数据收成新对象。
	const { additionalProperties, ...annotations } = options;
	// 把annotations浅展开后强制open:true；obj拆此内部开关，省掉默认additionalProperties:false并建立属性/required表。
	const schema = obj(properties, { ...annotations, open: true });
	// 传了真值true则浅复制schema并显式加additionalProperties:true，否则直接返回schema；false绕过TS传入也不会在这里使对象关闭。
	return additionalProperties ? { ...schema, additionalProperties } : schema;
}

/** One string: `{ type: "string", const: value }`. */
// 构造只接受一个字符串的规则，输入value及可选元数据，返回Schema<V>，无I/O或用户值检查；例stringLiteral("read")描述只能为read。
// const泛型保留字符串字面量，options后展开，常规类型只允许元数据，但绕过TS的同名字段仍可覆盖type/const，函数没有白名单清洗。
export function stringLiteral<const V extends string>(value: V, options: Annotations<V> = {}): Schema<V> {
	// 返回新外层对象，type限制字符串、const记录值，...options浅合并描述/default等，并不执行比较。
	return { type: "string", const: value, ...options };
}

/** An object with any string keys and values of `value`: `{ type: "object", patternProperties: { "^.*$": value } }`. */
// 构造字符串键字典规则，输入值schema与可选元数据，返回Record类型的schema，无I/O；例stringRecord(num())描述匹配键的值要为数字。
// 实现用patternProperties而不是additionalProperties:value；^.*$无s/m时不覆盖含换行符的键，这些未匹配键又未被额外属性规则关闭，不应把静态Record当所有任意JS键都已验证。
export function stringRecord<S extends Schema>(
	// S保存完整子schema类型，传入对象仍按引用放进结果，不复制或调用它。
	value: S,
	// Record<string,Static<S>>让default/examples中的字典值跟随子schema类型；省略选项用空对象。
	options: Annotations<Record<string, Static<S>>> = {},
	// 返回静态字符串键字典形状，不在此枚举任何待检查字典。
): Schema<Record<string, Static<S>>> {
	// 新建object规则及patternProperties表，正则源码映到原value引用；后展开options，规则的正则编译/属性验证留到真正compile/check。
	return { type: "object", patternProperties: { "^.*$": value }, ...options };
}
