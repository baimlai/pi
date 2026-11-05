// 用已安装TypeBox构造的schema检查pi-schema的Static类型映射。expectTypeOf依赖tsc，普通Vitest通过不单独证明静态断言；最后一例也运行coerce parse，但只在成功分支检查类型。
// Static for TypeBox-built schemas: the common kinds give TypeBox's own static type, without pi-schema importing
// TypeBox; other kinds give `unknown`. Type-level tests (they pass when this file type-checks), against TypeBox 1.3.27.

// 导入真实TypeBox构造器；type Static as TypeBoxOwn把其自带类型另起名字，避免与本库Static冲突，类型导入运行时擦除。
import { Type, type Static as TypeBoxOwn } from "typebox";
// 此文件主要用类型断言，不使用运行时expect；describe/it仍登记测试回调。
import { describe, expectTypeOf, it } from "vitest";
// compile是真实运行函数，type Static是本库按TypeBox标记形状进行的静态适配。
import { compile, type Static } from "../src/index.ts";

// 五例检查基本类型、四组对象修饰、嵌套组合、不支持种类的unknown回退和parse成功分支类型。
describe("Static of TypeBox schemas", () => {
	// 基本种类例子既用ReturnType取构造器返回类型，也创建Literal/Unsafe实际schema再用typeof；只有类型检查才验证这些断言。
	it("maps the primitive kinds, literals and Unsafe", () => {
		// typeof Type.String取函数类型，ReturnType取其返回schema，Static再映为string；没有在此实际调用Type.String。
		expectTypeOf<Static<ReturnType<typeof Type.String>>>().toEqualTypeOf<string>();
		// Number种类映为number，静态number不表达有限性或具体上下界。
		expectTypeOf<Static<ReturnType<typeof Type.Number>>>().toEqualTypeOf<number>();
		// Integer也映number，整数性只能由运行check表达。
		expectTypeOf<Static<ReturnType<typeof Type.Integer>>>().toEqualTypeOf<number>();
		// Boolean映boolean。
		expectTypeOf<Static<ReturnType<typeof Type.Boolean>>>().toEqualTypeOf<boolean>();
		// Null映null，和undefined不同。
		expectTypeOf<Static<ReturnType<typeof Type.Null>>>().toEqualTypeOf<null>();
		// Unknown保留unknown，使用前应收窄。
		expectTypeOf<Static<ReturnType<typeof Type.Unknown>>>().toEqualTypeOf<unknown>();
		// 此处any是变量名，实际调用Type.Any构造其schema；适配按TypeBox原种类保留any语义。
		const any = Type.Any();
		// toBeAny验证映射结果确实是any，不误降为unknown；本分支是对外兼容类型的明确语义。
		expectTypeOf<Static<typeof any>>().toBeAny();
		// Literal实际构造const:add，变量保存schema而非字符串本身。
		const literal = Type.Literal("add");
		// Static保留字面量add，不扩大成任意string。
		expectTypeOf<Static<typeof literal>>().toEqualTypeOf<"add">();
		// Unsafe显式携带作者指定的泛型"a"|"b"，同时给普通规则数据；此断言不证明任意传入数据都被运行校验。
		const unsafe = Type.Unsafe<"a" | "b">({ type: "string", enum: ["a", "b"] });
		// 本库读取Unsafe类型标记，结果沿作者指定的联合。
		expectTypeOf<Static<typeof unsafe>>().toEqualTypeOf<"a" | "b">();
	});

	// 对象例子覆盖必填可写、可选可写、必填只读、可选只读四组；readonly只是TS重赋限制，不冻结运行对象。
	it("maps objects with optional and readonly properties as TypeBox does", () => {
		// 实际构造TypeBox对象规则。
		const schema = Type.Object({
			// path是必填可写string。
			path: Type.String(),
			// offset用Optional标记可省略，Integer的静态值仍number。
			offset: Type.Optional(Type.Integer()),
			// id用Readonly标记，静态对象字段不可重赋。
			id: Type.Readonly(Type.String()),
			// tag既Readonly又Optional，字面量值只能x。
			tag: Type.Readonly(Type.Optional(Type.Literal("x"))),
		});
		// Expected明确写出四组形状；?和readonly可组合，既非null也非深冻结。
		type Expected = { path: string; offset?: number; readonly id: string; readonly tag?: "x" };
		// 检查本库Static与手写预期完全相同。
		expectTypeOf<Static<typeof schema>>().toEqualTypeOf<Expected>();
		// 再与TypeBox自己的Static对照，避免手写Expected碰巧与两边都不一致。
		expectTypeOf<Static<typeof schema>>().toEqualTypeOf<TypeBoxOwn<typeof schema>>();
		// 空属性TypeBox对象单独构造；本库按TypeBox惯例映为object，不是严格“只能空对象”。
		const empty = Type.Object({});
		// 空对象映射也应与TypeBox自身静态口径一致。
		expectTypeOf<Static<typeof empty>>().toEqualTypeOf<TypeBoxOwn<typeof empty>>();
	});

	// 嵌套例子检查数组对象、可辨字面量联合和字典；每个字段递归Static，而不是整个对象都退unknown。
	it("maps arrays, unions and records, nested", () => {
		// 外层TypeBox Object包含四个字段。
		const schema = Type.Object({
			// edits是对象数组，每项oldText/newText都是string。
			edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
			// mode是text/binary/null三种值联合，不是任意string。
			mode: Type.Union([Type.Literal("text"), Type.Literal("binary"), Type.Null()]),
			// env是字符串键且值string|number的字典。
			env: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()])),
			// counts用整数键schema，静态映为Record<number,boolean>；JS对象实际属性键仍按字符串存储，不因类型产生数字键容器。
			counts: Type.Record(Type.Integer(), Type.Boolean()),
		});
		// 用多行Expected展开说明嵌套结果，不构造这个形状的运行值。
		type Expected = {
			// edits是普通可变数组类型，条目字段类型保留。
			edits: { oldText: string; newText: string }[];
			// mode精确联合。
			mode: "text" | "binary" | null;
			// Record<string,T>用字符串索引签名表达字典值类型。
			env: Record<string, string | number>;
			// Record<number,boolean>描述数字索引的字典值类型，不负责运行时键名合法性检查；索引访问类型则是T[K]这样的写法。
			counts: Record<number, boolean>;
		};
		// 本库结果与展开的Expected相同。
		expectTypeOf<Static<typeof schema>>().toEqualTypeOf<Expected>();
		// 再对照TypeBox原生Static，验证当前支持组合的兼容性。
		expectTypeOf<Static<typeof schema>>().toEqualTypeOf<TypeBoxOwn<typeof schema>>();
	});

	// 未实现种类例子不是证明运行schema无效，而是本库静态映射保守回unknown；不会伪造更精确的TS承诺。
	it("gives unknown for kinds it does not map", () => {
		// Enum并不走已支持Literal/Union种类，本库未映射。
		const enumeration = Type.Enum(["a", "b"]);
		// Tuple也不等同已支持Array映射，当前结果unknown。
		const tuple = Type.Tuple([Type.String()]);
		// Intersect组合对象规则是有效构造，但此静态适配未实现它的值交叉推导。
		const intersect = Type.Intersect([Type.Object({ a: Type.String() }), Type.Object({ b: Type.String() })]);
		// Enum结果明确unknown，不是any任意放行。
		expectTypeOf<Static<typeof enumeration>>().toEqualTypeOf<unknown>();
		// Tuple结果也unknown，即使这个具体例子很简单。
		expectTypeOf<Static<typeof tuple>>().toEqualTypeOf<unknown>();
		// Intersect同样保守unknown。
		expectTypeOf<Static<typeof intersect>>().toEqualTypeOf<unknown>();
		// Inside a mapped kind, an unmapped kind is unknown only where it stands.
		// 把未映射Tuple放在已映射Object的pair字段，其他name字段仍可单独推导。
		const object = Type.Object({ pair: Type.Tuple([Type.String()]), name: Type.String() });
		// 只pair退unknown，name保留string，避免一个未知子种类使整个对象类型信息丢失。
		expectTypeOf<Static<typeof object>>().toEqualTypeOf<{ pair: unknown; name: string }>();
	});

	// parse例子开启coerce:true，运行把n:"1"尝试转数值；静态断言只在ok分支，不是这里另加运行时成功断言。
	it("types compile() and parse() for TypeBox schemas", () => {
		// n必需number，s可省string，作为TypeBox构造输入。
		const schema = Type.Object({ n: Type.Number(), s: Type.Optional(Type.String()) });
		// 字面true选中可转换的Validator重载，parse返回ok标签联合，并不只靠TS断言把字符串改数字。
		const result = compile(schema, { coerce: true }).parse({ n: "1" });
		// if(result.ok)以判别字段收窄成功结果，value类型为{n:number;s?:string}；如果parse失败，此expectTypeOf在运行时不会执行，行为成败由其他测试验证。
		if (result.ok) expectTypeOf(result.value).toEqualTypeOf<{ n: number; s?: string }>();
	});
});
