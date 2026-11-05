/**
 * schema包公共入口：构造器先创建规则数据，compile把它编成闭包验证器，Static在编译期推导通过后的值类型。
 * 例const S=obj({path:str()}); const v=compile(S); v.check(input)才实际检查输入；仅导入不会校验任何值。
 * export重导出运行值，type条目只为TS服务并在JS中擦除；格式库单独从/formats导入，不在这里自动启用。
 */
// JSON Schema validation (drafts 2020-12 and 7) without eval: compile() builds a schema into plain closures once.
// The builders return plain JSON Schema objects typed with the values they accept.

export {
	// 构造器的title/description/default等元数据类型，不是已求值位置记录。
	type Annotations,
	// 同元素类型数组规则，例arr(str())。
	arr,
	// 布尔规则。
	bool,
	// Uint8Array内存值扩展，不是标准JSON二进制类型。
	bytes,
	// 整数规则，TS静态值类型仍number。
	int,
	// 字符串/bytes等长度上下界的选项类型。
	type LengthBounds,
	// 单一字面量规则，例lit("read")。
	lit,
	// 字符串键字典规则，例map(num())。
	map,
	// 数值上下界/倍数选项类型。
	type NumberBounds,
	// 只接受null的规则，与省略字段不同。
	nul,
	// 原规则与null的联合，例nullable(str())。
	nullable,
	// 数值规则，构造不转换/检查用户输入。
	num,
	// 可选字段包装类，obj会在运行时识别并拆包。
	Optional,
	// 对象规则，默认拒绝额外属性。
	obj,
	// 候选值枚举构造器，实际生成enum关键字，不是schema分支oneOf。
	oneOf,
	// 可选包装工厂，例obj({offset:opt(int())})。
	opt,
	// 对象字段schema/Optional映射类型。
	type Properties,
	// 带静态值品牌的普通schema数据类型。
	type Schema,
	// 从builder品牌/常见TypeBox种类推导值类型，不执行校验。
	type Static,
	// 将obj字段表映射为必填/可选值对象的类型。
	type StaticObject,
	// 字符串规则，正则/format实际检查需compile。
	str,
	// 定长元组规则，默认2020-12语义下逐位置限制。
	tuple,
	// 任意一份schema成立的联合规则，实际生成anyOf。
	union,
	// 不指定断言的宽规则构造器，函数名恰为unknown。
	unknown,
} from "./builders.ts";
// 全组只重导出类型：布尔check、编译选项、format回调、schema、转换结果与可读错误。
export type { Check, CompileOptions, FormatCheck, JsonSchema, ParseResult, ValidationError } from "./types.ts";
// 真正编译/运行校验的入口和两种验证器类；coerce:true才附加转换/parse，check不自动转换输入。
export { CoercingValidator, compile, Validator } from "./validator.ts";
