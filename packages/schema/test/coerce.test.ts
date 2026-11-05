// 围绕coerce/parse的三轮转换给出真实输入输出，区别可选null清理、TypeBox式适配与基础type转换；所有helper都跑完整流程，组名不代表隔离某一轮。测试只用本地规则/纯内存与临时全局替身。
// compile(schema, { coerce: true }): coerce() and parse(), the three coercion passes (optional nulls, TypeBox's
// conversion rules, primitive coercion by type), their order where they conflict, and the guarantees around them.
// Ports pi-ai's tool argument coercion tests.

// TypeBox只用于部分外来/递归规则构造；实际转换仍由pi-schema的Coercer执行，不是这里调用TypeBox Value.Convert。
import Type from "typebox";
// expect检查运行结果，expectTypeOf由tsc检查推导；it分组名称描述关注点，不改变helper总是跑三轮的事实。
import { describe, expect, expectTypeOf, it } from "vitest";
// 给转换中候选检查提供本地格式回调，不做邮箱/URL网络确认。
import { formats } from "../src/formats/index.ts";
// 公开入口同时导入规则builder、compile及只存在于TS的结果/验证器类型。
import {
	// arr构造同元素类型数组规则，转换可把普通单值包成数组。
	arr,
	// compile按coerce:true选择具有coerce/parse方法的子类。
	compile,
	// int运行规则要求整数，但静态值类型仍number。
	int,
	// map是字符串键字典规则，不是Array.map遍历函数。
	map,
	// nullable允许值为null，与opt允许省略字段分开。
	nullable,
	// num构造number规则。
	num,
	// obj默认封闭对象并收集必填键。
	obj,
	// opt给obj的字段加可省略包装，不自动设置默认值。
	opt,
	// str构造string规则。
	str,
	// tuple构造定长位置数组，不能把普通标量盲目当元组包一层。
	tuple,
	// ValidationError用来写parse失败分支静态类型，type导入运行时擦除。
	type ValidationError,
	// Validator是未开coerce的静态类型，不意味着每份schema都有parse。
	type Validator,
} from "../src/index.ts";

// 本地helper接规则/unknown输入，立即编译并跑全部三轮转换，返回unknown；例number规则将"42"转42。转换本身不保证合法，异常不在这里吞掉，无IO。
function coerce(schema: object, value: unknown): unknown {
	// 显式传格式表与字面true，然后只调coerce，不调parse/check来要求最终有效；每次调用新建validator。
	return compile(schema, { formats, coerce: true }).coerce(value);
}

/** The coerced `value` property of `{ value }` under an object schema with one required property `value`. */
// 把单值规则放进必填value字段后转换再取值，便于测试标量/数组差异；例coerceValue({type:"integer"},"3.5")得到3。schema/输入保留unknown，helper不另校验规则。
function coerceValue(schema: unknown, value: unknown): unknown {
	// 外层对象的value必填，因此null不因“可选字段清理”被删除；schema简写保存传入规则引用。
	const root = { type: "object", properties: { value: schema }, required: ["value"] };
	// 转换对象后as声明其仍有value字段便于读取；只是TS断言，不复制/校验，也不保证返回值已经合法。
	return (coerce(root, { value }) as { value: unknown }).value;
}

// 选项组把运行方法是否存在与TS返回类型分开验证。
describe("compile options", () => {
	// 同一number对象规则比较默认Validator和coerce:true子类；只给后者增加转换API，基础check仍是实际验证。
	it("adds coerce and parse only with coerce: true", () => {
		// 未开启转换的普通验证器。
		const plain = compile(obj({ n: num() }));
		// tsc检查plain类型恰为Validator<{n:number}>，不靠运行时typeof猜泛型。
		expectTypeOf(plain).toEqualTypeOf<Validator<{ n: number }>>();
		// in操作符检查coerce属性在对象/原型链是否存在，预期普通实例没有。
		expect("coerce" in plain).toBe(false);
		// 同样检查普通实例没有parse方法。
		expect("parse" in plain).toBe(false);
		// 字面量true选择CoercingValidator重载，运行构造子类而不是给输入做类型断言。
		const coercing = compile(obj({ n: num() }), { coerce: true });
		// returns取得函数返回类型做静态断言，不在这里实际调用parse。
		expectTypeOf(coercing.parse).returns.toEqualTypeOf<
			// 成功分支ok:true携带经过验证的{n:number}值。
			| { readonly ok: true; readonly value: { n: number } }
			// 失败分支ok:false带错误数组而没有value；readonly是类型视图，不自动冻结对象。
			| { readonly ok: false; readonly errors: ValidationError[] }
			// 完成联合结果类型断言；这些类型参数运行时擦除。
		>();
		// 转换子类继承的check仍能验证已是number的输入。
		expect(coercing.check({ n: 1 })).toBe(true);
	});
});

// 基础转换组用具体普通对象检查不改输入、无变化保引用、变化路径复制、冻结规则与受限代码生成入口。
describe("coerce", () => {
	// 不修改例子比较转换结果与原输入，两者数值/数组形状不同；只用此例不证明任意Proxy/getter的副作用都会回滚。
	it("never modifies the value", () => {
		// 原数据count是字符串、tags是标量，稍后应只在结果中改变。
		const value = { count: "42", tags: "a" };
		// 规则count要number，tags要string[]。
		const schema = obj({ count: num(), tags: arr(str()) });
		// 转换结果把42转数字、a包数组，toEqual比较结构。
		expect(coerce(schema, value)).toEqual({ count: 42, tags: ["a"] });
		// 原对象仍保留字符串/标量，转换不是直接原地写回它。
		expect(value).toEqual({ count: "42", tags: "a" });
	});

	// 无变化例子验证对象身份：合法嵌套输入无需转换时，返回同一引用，不总深复制。
	it("returns the value itself when nothing changes", () => {
		// 数值数组和字符串已符合目标规则。
		const value = { a: { b: [1, 2] }, c: "x" };
		// 规则与现成嵌套形状吻合。
		const schema = obj({ a: obj({ b: arr(num()) }), c: str() });
		// toBe比较同一对象引用，比仅toEqual结构相等更强。
		expect(coerce(schema, value)).toBe(value);
	});

	// 按变化路径复制例子只需改c.d，期待根变新而a子树仍同引用，原c不被修改。
	it("copies only the changed paths", () => {
		// 把不变子树单独存引用，后面用于身份断言。
		const unchanged = { b: [1, 2] };
		// 根a引用unchanged，c.d则需从"1"转换成1。
		const value = { a: unchanged, c: { d: "1" } };
		// 规则只要求a/b数值数组和c/d数值，没有额外输入字段变化。
		const schema = obj({ a: obj({ b: arr(num()) }), c: obj({ d: num() }) });
		// as typeof value只方便按原形状访问a，不证明转换后d仍是string；下一运行断言明确期待number。
		const coerced = coerce(schema, value) as typeof value;
		// 结果结构c.d为1，a内容保持。
		expect(coerced).toEqual({ a: { b: [1, 2] }, c: { d: 1 } });
		// 根对象应是新引用，因为至少一条后代路径变化。
		expect(coerced).not.toBe(value);
		// a无需复制，应仍是原unchanged引用。
		expect(coerced.a).toBe(unchanged);
		// 原c仍d:"1"，与返回值分离。
		expect(value.c).toEqual({ d: "1" });
	});

	// 冻结规则例子冻结根、properties和n子规则，再转换输入；验证不靠往schema对象写入字段工作。
	it("works on frozen schemas", () => {
		// Object.freeze实际浅冻结根，下面另冻每层才覆盖本例整个规则树。
		const schema = Object.freeze({
			// 根只接受object。
			type: "object",
			// n的integer子规则与properties表也被冻结；没有required所以n可省，但给出时应转换。
			properties: Object.freeze({ n: Object.freeze({ type: "integer" }) }),
		});
		// 现有n:"7"仍应变7，规则冻结不等于输入也被冻结或不允许转换结果。
		expect(coerce(schema, { n: "7" })).toEqual({ n: 7 });
	});

	// 受限入口例子临时替换全局Function再跑普通转换，验证这条路径不依赖该构造器；不是证明所有JS动态能力都被禁止或已形成沙箱。
	it("still coerces when the Function constructor is unavailable", () => {
		// 先保存原构造器，finally无论断言成功/抛错都会恢复。
		const original = globalThis.Function;
		// 替换成不可正常作Function构造器使用的箭头函数；双重as只是满足测试赋值类型。
		globalThis.Function = (() => {
			// 若以普通函数调用替身会抛EvalError；作为new目标时箭头本身也不可构造，不把失败原因限定成这一条消息。
			throw new EvalError("Code generation from strings disallowed for this context");
			// unknown中转允许故意越过结构不相容的类型限制，不应把它当正常业务API用法。
		}) as unknown as FunctionConstructor;
		// 把转换/断言放try内，给全局恢复建立确定finally路径。
		try {
			// 即便替换入口，本例对象count仍可由字符串42转数字42。
			expect(coerce(obj({ count: num() }), { count: "42" })).toEqual({ count: 42 });
			// finally表示成功或抛错都清理，不是catch吞断言失败。
		} finally {
			// 恢复真实globalThis.Function，避免污染同进程后续测试。
			globalThis.Function = original;
		}
	});

	// 无法转换例子给many这种非数值，coerce可原样返回，但check仍false；转换和验证不能合并理解。
	it("leaves values it cannot coerce for the check to report", () => {
		// 启用转换但规则仍要求count:number。
		const validator = compile(obj({ count: num() }), { coerce: true });
		// coerce只尽力变形，返回类型仍unknown。
		const coerced = validator.coerce({ count: "many" });
		// many未被猜成NaN/0或空值，结果保留原字符串。
		expect(coerced).toEqual({ count: "many" });
		// check决定它仍不合法，不因coerce已经执行就默认通过。
		expect(validator.check(coerced)).toBe(false);
	});
});

// parse组演示“先转换再检查”的标签结果，不是JSON.parse解析文本。
describe("parse", () => {
	// 成功例子同时改数字和数组，运行断言实际ok:true，再检查成功分支类型。
	it("returns the coerced value when it is valid", () => {
		// 构造count:number与tags:string[]的转换验证器。
		const validator = compile(obj({ count: num(), tags: arr(str()) }), { coerce: true });
		// 输入字符串42与标量a，parse运行三轮再check。
		const result = validator.parse({ count: "42", tags: "a" });
		// 期待成功标签及转换后值，而非只得到true。
		expect(result).toEqual({ ok: true, value: { count: 42, tags: ["a"] } });
		// ok判别字段让TS在if内知道value存在且count:number/tags:string[]；这次前一断言也真实验证了成功。
		if (result.ok) expectTypeOf(result.value).toEqualTypeOf<{ count: number; tags: string[] }>();
	});

	// 失败例子name可转成string，但count:many仍坏，错误应该基于转换后的数据，只报count。
	it("returns the errors of the coerced value when it is invalid", () => {
		// count和name都必填，前者number后者string。
		const validator = compile(obj({ count: num(), name: str() }), { coerce: true });
		// name:7会先变"7"而通过，many不变，所以错误不应再包含/name。
		expect(validator.parse({ count: "many", name: 7 })).toEqual({
			// ok:false正常返回错误分支，不是直接抛出业务异常。
			ok: false,
			// /count错误描述转换后仍是string，结果不附失败的value字段。
			errors: [{ path: "/count", keyword: "type", message: "expected number, got string" }],
		});
	});
});

// 第一轮关注可选非nullable字段的null清理；所有helper调用仍跑完整三轮，不是直接调用某个私有pass1方法。
describe("pass 1: optional nulls", () => {
	// 复合例子同时给必需path、可选offset、允许null的可选字段与嵌套enabled；只删不允许null的可选项。
	it("drops null in optional non-nullable properties, also nested", () => {
		// obj的两个参数分别是字段表和open选项。
		const schema = obj(
			{
				// path必填string，不是当前文件实际读取路径。
				path: str(),
				// offset可省number，null在第一轮可删。
				offset: opt(num()),
				// nullable字段可省且允许null，应保留null值而非删键。
				nullable: opt(nullable(str())),
				// metadata必填对象，内部enabled可省boolean，所以嵌套null也需清理。
				metadata: obj({ enabled: opt({ type: "boolean" }) }),
			},
			// 根允许额外字段，不影响已声明字段的null清理语义。
			{ open: true },
		);
		// 输入同时填这几种null，检查结果哪些键保留。
		expect(coerce(schema, { path: "file.txt", offset: null, nullable: null, metadata: { enabled: null } })).toEqual({
			// path原字符串不变。
			path: "file.txt",
			// 允许null的nullable键仍在。
			nullable: null,
			// metadata对象仍存在，仅其enabled被删除而成为{}。
			metadata: {},
		});
	});

	// 引用例子避免在第一轮凭当前$ref表面缺type误删null；引用目标可能允许它，后续按目标规则决定。
	it("keeps a null whose property is a $ref (the reference may allow it)", () => {
		// 构造一个可选value字段引用。
		const schema = {
			// 根是object。
			type: "object",
			// value子规则只给$ref，目标放本地$defs。
			properties: { value: { $ref: "#/$defs/value" } },
			// 目标允许number或null，所以输入null本来合法。
			$defs: { value: { anyOf: [{ type: "number" }, { type: "null" }] } },
		};
		// 完整三轮后仍保留value:null，不被清理成空对象。
		expect(coerce(schema, { value: null })).toEqual({ value: null });
	});

	// 数组例子检查清理也进入item对象，不只处理根字段。
	it("walks array items", () => {
		// 每项a必填string，b可省integer。
		const schema = { type: "array", items: obj({ a: str(), b: opt(int()) }) };
		// 单个item里的b:null被删，a:x保留，数组长度不变。
		expect(coerce(schema, [{ a: "x", b: null }])).toEqual([{ a: "x" }]);
	});
});

// 第二轮关注TypeBox式转换规则，实际是本库手写适配，不调用Value.Convert；组内仍由公开helper跑三轮组合。
describe("pass 2: TypeBox's conversion rules on JSON Schema", () => {
	// 基础转换例子逐项列出字符串/数值/boolean/null规则，展示实际约定而非JS任意隐式相等。
	it("converts primitives by type", () => {
		// number规则把数值字符串42转数字42。
		expect(coerceValue({ type: "number" }, "42")).toBe(42);
		// 第二轮按其规则把空串转0，与第三轮单独策略有差别。
		expect(coerceValue({ type: "number" }, "")).toBe(0);
		// 字符串true在此number规则中映1，不等于JS Number("true")的NaN结果。
		expect(coerceValue({ type: "number" }, "true")).toBe(1);
		// integer规则可把字符串3.5截成3，不保证保留小数或只接受本来整数的字符串。
		expect(coerceValue({ type: "integer" }, "3.5")).toBe(3);
		// 数字1.5也截成1，不是四舍五入。
		expect(coerceValue({ type: "integer" }, 1.5)).toBe(1);
		// boolean规则接受字符串1为true。
		expect(coerceValue({ type: "boolean" }, "1")).toBe(true);
		// FALSE大小写形式也转false，按此轮约定而非Boolean("FALSE")真值。
		expect(coerceValue({ type: "boolean" }, "FALSE")).toBe(false);
		// null规则可把字符串null转真正null。
		expect(coerceValue({ type: "null" }, "null")).toBe(null);
		// number值42可转string "42"。
		expect(coerceValue({ type: "string" }, 42)).toBe("42");
	});

	// 普通数组例子先包单值再逐项转换，与tuple不包标量的分支分开。
	it("wraps a single value into an array and converts the items", () => {
		// "1"先包成["1"]再按items:number得到[1]。
		expect(coerceValue({ type: "array", items: { type: "number" } }, "1")).toEqual([1]);
		// null也可包数组并按items:string转换成["null"]，不是当可选字段丢掉。
		expect(coerceValue({ type: "array", items: { type: "string" } }, null)).toEqual(["null"]);
	});

	// 元组例子只在已有数组相应位置转换，不把标量包成元组；英文in place指位置语义，本库仍按变化路径复制，不原地改调用者数组。
	it("converts tuple items in place and never wraps for a tuple", () => {
		// prefixItems指定两个位置，items:false拒绝额外项；这里没写minItems，不声称规则一定要求两项齐全。
		const tuple = { type: "array", prefixItems: [{ type: "number" }, { type: "boolean" }], items: false };
		// 已有数组两项分别从字符串转number/boolean。
		expect(coerceValue(tuple, ["1", "true"])).toEqual([1, true]);
		// 标量"1"不会被盲目包成一元素元组，保持原值供后续check拒绝。
		expect(coerceValue(tuple, "1")).toBe("1");
	});

	// 常量/枚举例子只采用落入允许成员的转换，失败不把原值改成另一个仍非法候选。
	it("converts const and enum values only when the result is a member", () => {
		// 常量1允许"1"变1。
		expect(coerceValue({ const: 1 }, "1")).toBe(1);
		// 常量1不接收2，"2"保持字符串，不因能转数字就强制改它。
		expect(coerceValue({ const: 1 }, "2")).toBe("2");
		// 枚举允许数字2，因此字符串2可变数字成员2。
		expect(coerceValue({ enum: [1, 2, "hello"] }, "2")).toBe(2);
		// world无可接受候选，保持原字符串。
		expect(coerceValue({ enum: [1, 2, "hello"] }, "world")).toBe("world");
	});

	// 联合例子先保留某支已经接受的值，否则按分支顺序尝试候选，并检查候选能否被联合接受；顺序会影响结果。
	it("keeps a value one union branch accepts, else takes the first branch whose conversion the union accepts", () => {
		// number/null两支的anyOf联合。
		const union = { anyOf: [{ type: "number" }, { type: "null" }] };
		// 真正null已有合法分支，不优先转成数字0。
		expect(coerceValue(union, null)).toBe(null);
		// "42"可由number支转成42。
		expect(coerceValue(union, "42")).toBe(42);
		// "null"可由null支转成null。
		expect(coerceValue(union, "null")).toBe(null);
		// oneOf先boolean后number，"1"先得到true且满足联合，故最终true，不继续选数字1；这不把oneOf误当anyOf。
		expect(coerceValue({ oneOf: [{ type: "boolean" }, { type: "number" }] }, "1")).toBe(true);
	});

	// allOf例子按成员先后转换不同字段，最终还需整体check才保证全部约束；此处只比较转换结构。
	it("converts allOf with each member in turn", () => {
		// 两成员都open，避免一支把另一支字段当额外字段；一支转换a:number，另一支转换b:boolean。
		const schema = { allOf: [obj({ a: num() }, { open: true }), obj({ b: { type: "boolean" } }, { open: true })] };
		// 输入a:1/b:true的字符串形式都被转成相应基础值。
		expect(coerce(schema, { a: "1", b: "true" })).toEqual({ a: 1, b: true });
	});

	// 引用转换例子从item沿本地$ref进入嵌套对象，转换id整数，不访问URI网络。
	it("follows $ref", () => {
		// 根规则对象。
		const schema = {
			// 根类型object。
			type: "object",
			// item子规则引用本地定义。
			properties: { item: { $ref: "#/$defs/item" } },
			// 定义要求item对象中若有id则integer，未写required:id。
			$defs: { item: { type: "object", properties: { id: { type: "integer" } } } },
		};
		// 嵌套字符串7变number7，外层对象结构保留。
		expect(coerce(schema, { item: { id: "7" } })).toEqual({ item: { id: 7 } });
	});

	// 属性关键词例子把声明a、匹配n_前缀和剩余字段分三种规则转换，不把所有键都按additionalProperties处理。
	it("converts patternProperties and additionalProperties", () => {
		// 建立对象属性分派规则。
		const schema = {
			// 根需object。
			type: "object",
			// a精确声明为number。
			properties: { a: { type: "number" } },
			// n_开头的键按number子规则处理，正则不改键名。
			patternProperties: { "^n_": { type: "number" } },
			// 未声明且未命中模式的键按boolean转换。
			additionalProperties: { type: "boolean" },
		};
		// 结果a/n_x为数字1/2，other为true，说明三种字段入口均生效。
		expect(coerce(schema, { a: "1", n_x: "2", other: "true" })).toEqual({ a: 1, n_x: 2, other: true });
	});
});

// 第三轮关注按type的基础转换；这里没有单独隔离前两轮，部分案例可能已在早前轮完成，源码阅读才说明具体落点。
describe("pass 3: primitive coercion by type", () => {
	// 表格列若干与Ajv coerceTypes相似结果，只比较此库实际输出，不在测试里运行或完全等价验证Ajv。
	it("coerces like Ajv's coerceTypes", () => {
		// Array<[unknown,unknown,unknown]>是三元素元组数组，每行依次schema/输入/期望；固定位置角色由解构取出。
		const cases: Array<[unknown, unknown, unknown]> = [
			// true转number1。
			[{ type: "number" }, true, 1],
			// null转number0。
			[{ type: "number" }, null, 0],
			// 数字字符串42转integer42。
			[{ type: "integer" }, "42", 42],
			// 字符串true转boolean true。
			[{ type: "boolean" }, "true", true],
			// 数字0转boolean false。
			[{ type: "boolean" }, 0, false],
			// boolean true转字符串true。
			[{ type: "string" }, true, "true"],
			// null规则把空串转null。
			[{ type: "null" }, "", null],
			// 数字0也可按null规则变null。
			[{ type: "null" }, 0, null],
			// boolean false也可变null，不用JS真值直接替代规则判断。
			[{ type: "null" }, false, null],
		];
		// for解构每行参数，运行helper后结构比较；任一断言失败会使本it失败，不为每表格行单独登记it。
		for (const [schema, input, expected] of cases) expect(coerceValue(schema, input)).toEqual(expected);
	});

	// type数组例子保持已经匹配任一类型的原值，否则尝试允许类型；与anyOf的完整子规则联合不是同一种数据形状。
	it("leaves a value that matches one of a type array's types, else takes the first coercible type", () => {
		// "1"本来是string，number/string允许它，所以保留字符串而非强转1。
		expect(coerceValue({ type: ["number", "string"] }, "1")).toBe("1");
		// "1"原本不属boolean/number，按实际三轮规则最终为数字1，不把boolean位置在前理解成必定返回true。
		expect(coerceValue({ type: ["boolean", "number"] }, "1")).toBe(1);
		// integer/null对数字字符串5得到数字5。
		expect(coerceValue({ type: ["integer", "null"] }, "5")).toBe(5);
	});

	// nullable数组例子同时写items也不应强制把合法null包成数组。
	it("accepts null for nullable array schemas with items", () => {
		// type允许array或null，真正null保持原值。
		expect(coerceValue({ type: ["array", "null"], items: { type: "string" } }, null)).toBe(null);
	});

	// 联合可空例子重新核对无分支可接受时转换，已有合法null时保留，关注类型数组与anyOf/oneOf不同入口仍可组合。
	it("coerces nullable unions when the value matches no branch", () => {
		// anyOf number/null把字符串42转42。
		expect(coerceValue({ anyOf: [{ type: "number" }, { type: "null" }] }, "42")).toBe(42);
		// oneOf number/null本来恰有null分支接受，保留null。
		expect(coerceValue({ oneOf: [{ type: "number" }, { type: "null" }] }, null)).toBe(null);
	});

	// 不可转换组把几种坏输入包进必填integer字段，验证coerce之后仍由check拒绝，不强行填0或取数组首项。
	it("leaves values no rule coerces", () => {
		// 明确配置必填value的转换验证器。
		const validator = compile(
			// value必须integer，不能省略。
			{ type: "object", properties: { value: { type: "integer" } }, required: ["value"] },
			// 启用转换API，仍不让所有输入自动合法。
			{ coerce: true },
		);
		// 遍历非数字文字、带尾字符、对象及多元素数组四种坏输入。
		for (const input of ["abc", "4x", {}, ["1", "2"]]) {
			// 逐个包成{value:input}，防止根标量处理差异影响测试。
			const coerced = validator.coerce({ value: input });
			// 每个结果check都应false，测试不要求坏值统一变成某个错误哨兵。
			expect(validator.check(coerced)).toBe(false);
		}
	});
});

// 冲突组演示三轮顺序：先清可选null，再TypeBox式规则，最后基础type转换；后轮看到的是前轮结果，不能把每轮规则独立结果简单套到原值。
describe("where the passes conflict, the conversion rules win", () => {
	// 必填string接null的例子第二轮先成字符串null，第三轮不再把原null当输入转空串。
	it("turns null into 'null' for a required string (pass 3 alone would give '')", () => {
		// 期望实际四字符"null"，不是空字符串。
		expect(coerceValue({ type: "string" }, null)).toBe("null");
	});

	// 空串number例子第二轮先成0，不能根据第三轮单独策略认为最终仍空串。
	it("turns '' into 0 for a number (pass 3 leaves an empty string)", () => {
		// 结果是数字0。
		expect(coerceValue({ type: "number" }, "")).toBe(0);
	});

	// boolean冲突例子关注字符串0/1也被前轮支持，第三轮单独限制不能推翻已合法布尔结果。
	it("turns '1' and '0' into booleans (pass 3 takes only 'true', 'false', 1 and 0)", () => {
		// 字符串0最终为false，不等于Boolean("0")的true。
		expect(coerceValue({ type: "boolean" }, "0")).toBe(false);
	});

	// integer冲突例子第二轮先截小数，后轮不会恢复原字符串或拒绝这个已得到的整数。
	it("truncates '42.1' for an integer (pass 3 rejects it)", () => {
		// 字符串42.1最终42，不是42.1也不是四舍五入。
		expect(coerceValue({ type: "integer" }, "42.1")).toBe(42);
	});

	// 可选string的null先删除，再也没有这个字段交第二轮转成字符串null。
	it("drops an optional null before converting it (pass 2 alone would give 'null')", () => {
		// 结果空对象，区别于前面必填value包装的string:null情况。
		expect(coerce(obj({ name: opt(str()) }), { name: null })).toEqual({});
	});
});

// 递归组使用有限输入和递归规则，验证转换/状态重置与重复分支memo；不保证任意循环JS用户数据都能终止。
describe("recursive schemas", () => {
	// tree规则允许t为字符串或任意层嵌套数组。
	const tree = {
		// 根object。
		type: "object",
		// t引用本地Tree定义，可省t。
		properties: { t: { $ref: "#/$defs/Tree" } },
		// Tree的array项再次引用Tree，形成规则递归而非这个对象直接自引用。
		$defs: { Tree: { anyOf: [{ type: "string" }, { type: "array", items: { $ref: "#/$defs/Tree" } }] } },
	};
	// 另一个json规则允许字符串/数值/布尔/递归数组/递归对象；这里刻意没有null分支，不是完整JSON值全集。
	const json = {
		// 根同样object。
		type: "object",
		// data引用Json定义。
		properties: { data: { $ref: "#/$defs/Json" } },
		// data必填。
		required: ["data"],
		// 本地定义表。
		$defs: {
			// Json名字只是当前定义名，不自动有标准JSON所有类型。
			Json: {
				// 候选按以下次序处理，转换有歧义时顺序重要。
				anyOf: [
					// string分支排最先，部分标量可先转字符串。
					{ type: "string" },
					// number分支接受已为数字的值。
					{ type: "number" },
					// boolean分支接受已为布尔的值。
					{ type: "boolean" },
					// 数组每项递归Json。
					{ type: "array", items: { $ref: "#/$defs/Json" } },
					// 对象任意字段值递归Json。
					{ type: "object", additionalProperties: { $ref: "#/$defs/Json" } },
				],
			},
		},
	};

	// 递归联合例子既保留已合法的嵌套字符串，又把不匹配标量先转string；json示例中的null也要转换，因为无null分支。
	it("convert through a recursive union by its first accepting branch", () => {
		// 编译可递归转换验证器。
		const validator = compile(tree, { coerce: true });
		// 全是字符串叶子的嵌套数组本来合法，parse结构不改。
		expect(validator.parse({ t: ["a", ["b"]] })).toEqual({ ok: true, value: { t: ["a", ["b"]] } });
		// 数字5不符Tree的string/array，按首个可接受转换变"5"。
		expect(validator.parse({ t: 5 })).toEqual({ ok: true, value: { t: "5" } });
		// 数组里的数字叶子同样递归变字符串。
		expect(validator.parse({ t: [5] })).toEqual({ ok: true, value: { t: ["5"] } });
		// Json候选无null，嵌套数组中的null须转换才可能通过。
		expect(compile(json, { coerce: true }).parse({ data: { a: [1, null] } })).toEqual({
			// 预期parse成功。
			ok: true,
			// 数字1本来符合number保留，null转字符串null，不能因为string分支先就把所有合法数值也转string。
			value: { data: { a: [1, "null"] } },
		});
	});

	// 递归拒绝例子给Tree对象值，任何分支都不能接受/转换时coerce可原样留下，parse仍拒绝。
	it("leave a value a recursive schema cannot convert as it is, for the check to report", () => {
		// 复用tree转换器的新实例。
		const validator = compile(tree, { coerce: true });
		// t:{}不是字符串或可接受数组，parse失败。
		const result = validator.parse({ t: {} });
		// 只检查ok标签false，不在此精确比较所有错误文本。
		expect(result.ok).toBe(false);
		// t:{a:1}也保持结构原样供check拒绝，不把任意对象String成[object Object]。
		expect(validator.coerce({ t: { a: 1 } })).toEqual({ t: { a: 1 } });
	});

	// 直接自引用子schema例子以#/properties/value递归，让value为数字或嵌套数组；不是仅能递归到$defs。
	it("convert a scalar-or-array schema that refers to itself", () => {
		// 普通schema对象。
		const schema = {
			// 根是object。
			type: "object",
			// value字段表。
			properties: {
				// value允许number或数组，items通过Pointer回同一字段规则。
				value: { anyOf: [{ type: "number" }, { type: "array", items: { $ref: "#/properties/value" } }] },
			},
			// value必填，不能用删掉坏值让整体通过。
			required: ["value"],
		};
		// 编译带三轮转换的验证器。
		const validator = compile(schema, { coerce: true });
		// 标量数字字符串42变number42。
		expect(validator.parse({ value: "42" })).toEqual({ ok: true, value: { value: 42 } });
		// 嵌套数组叶子1/2也逐层转数字。
		expect(validator.parse({ value: ["1", ["2"]] })).toEqual({ ok: true, value: { value: [1, [2]] } });
		// 对象叶子无法转换，ok:false。
		expect(validator.parse({ value: {} }).ok).toBe(false);
	});

	// JS规则对象成环例子故意不用$ref而让items指回node；输入仍是有限树，验证规则重入处理，不把它说成循环用户数据测试。
	it("stop at a schema that cycles through shared JS objects instead of $ref", () => {
		// node类型先显式允许anyOf的unknown[]，便于后面追加含自引用分支。
		const node: { anyOf: unknown[] } = { anyOf: [{ type: "number" }] };
		// push把items设为node本身，形成真实JS对象引用环；不需要JSON.stringify该schema。
		node.anyOf.push({ type: "array", items: node });
		// 编译能处理此规则图，不等于它可作为JSON传输。
		const validator = compile(node, { coerce: true });
		// 标量字符串42可转number42。
		expect(validator.parse("42")).toEqual({ ok: true, value: 42 });
		// 递归嵌套数组逐层数字转换成功。
		expect(validator.parse(["1", ["2"]])).toEqual({ ok: true, value: [1, [2]] });
		// 空对象不是合法分支，parse仍失败，不因防重入而直接放行。
		expect(validator.parse({}).ok).toBe(false);
	});

	// 状态重置例子同一validator交替失败/成功20轮，检查单次memo/reentry不会污染下一次，输入内容不被转换写回。
	it("reset the re-entry state between calls and leave the input unchanged", () => {
		// 只构造一次，后续复用其coercer/check。
		const validator = compile(
			// 根可为number或递归数组。
			{ anyOf: [{ type: "number" }, { type: "array", items: { $ref: "#" } }] },
			// 开启转换。
			{ coerce: true },
		);
		// for重复20轮，一轮含坏对象、标量和嵌套数组三次parse。
		for (let i = 0; i < 20; i++) {
			// 每轮空对象都应失败，不能因上一成功memo直接放行。
			expect(validator.parse({}).ok).toBe(false);
			// 每轮数字字符串都应成功变42。
			expect(validator.parse("42")).toEqual({ ok: true, value: 42 });
			// 每轮新建数组，有已有number与待转string混合。
			const input = [1, "2", ["3"]];
			// 输出保留1并把2/3变number。
			expect(validator.parse(input)).toEqual({ ok: true, value: [1, 2, [3]] });
			// 原input仍含字符串2/3，不能因为复用coercer而原地覆盖它。
			expect(input).toEqual([1, "2", ["3"]]);
		}
	});

	// 深递归例子造40层输入给两条都失败的对象分支，检查能完成并给预期错误；虽然标题说linear time，本例没做计时/工作量断言，复杂度须结合memo实现，不冒充基准测量。
	it("convert and explain a deep value that every branch of a recursive union rejects, in linear time", () => {
		// Each object branch converts and explains every child: without memoizing per call this is 2^depth work.
		// S定义两个类似递归对象候选，所需键不同。
		const S = {
			// anyOf至少一支满足才成功，此输入会两支都缺各自必填键。
			anyOf: [
				// 第一支递归每个额外字段值并必需a。
				{ type: "object", additionalProperties: { $ref: "#/$defs/S" }, required: ["a"] },
				// 第二支也递归同一子值但必需b，无memo会反复解释共享子任务。
				{ type: "object", additionalProperties: { $ref: "#/$defs/S" }, required: ["b"] },
			],
		};
		// 外层把输入s指向本地S定义。
		const validator = compile(
			// 属性简写$defs:{S}保存同一S对象，不复制两份规则树。
			{ type: "object", properties: { s: { $ref: "#/$defs/S" } }, $defs: { S } },
			// 开启转换后parse还需check并解释失败。
			{ coerce: true },
		);
		// 叶子{x:1}先保存为unknown，后面可以反复包更外一层。
		let value: unknown = { x: 1 };
		// 40次赋新{c:value}形成40层c链，不是把value.c设为自己。
		for (let i = 0; i < 40; i++) value = { c: value };
		// 把深值放s字段，执行转换+校验+错误解释。
		const result = validator.parse({ s: value });
		// 所有对象节点缺a/b，最终必须失败。
		expect(result.ok).toBe(false);
		// 构造41条缺a预期，覆盖根S和40层c；同分失败候选保留第一支a。
		const missing = Array.from({ length: 41 }, (_, i) => ({
			// repeat(i)构造当前层Pointer路径，层数0时为/s/a。
			path: `/s${"/c".repeat(i)}/a`,
			// 缺字段错误keyword为required。
			keyword: "required",
			// 消息missing保持固定英文。
			message: "missing",
		}));
		// 最深x=1不是递归规则所需object，因此另有一条type错误。
		const leaf = { path: `/s${"/c".repeat(40)}/x`, keyword: "type", message: "expected object, got integer" };
		// 展开missing后追加leaf，比较完整失败结果，既检查错误条数也检查路径/顺序。
		expect(result).toEqual({ ok: false, errors: [...missing, leaf] });
	});

	// TypeBox Cyclic例子用其构造器产递归规则，测试本库可直接处理，不只是接受手写$ref图。
	it("convert a TypeBox Cyclic union", () => {
		// Cyclic定义Tree为string或Tree数组，并选择Tree作为入口；构造定义不执行用户数据转换。
		const Tree = Type.Cyclic({ Tree: Type.Union([Type.String(), Type.Array(Type.Ref("Tree"))]) }, "Tree");
		// 外层必填t使用TypeBox产生的Tree规则。
		const validator = compile(Type.Object({ t: Tree }), { coerce: true });
		// t:[5]递归得到["5"]并成功。
		expect(validator.parse({ t: [5] })).toEqual({ ok: true, value: { t: ["5"] } });
		// 对象t:{a:1}不能变合法Tree，ok:false。
		expect(validator.parse({ t: { a: 1 } }).ok).toBe(false);
	});
});

// 成员关键词组验证三轮都会走声明/模式/额外键与tuple，联合自身属性也不能被分支转换跳过。
describe("member keywords across the passes", () => {
	// 模式优先例子让匹配键按patternProperties处理，不再被additionalProperties的string规则覆盖成字符串。
	it("keep a pattern-matched property from additionalProperties in every pass", () => {
		// TypeBox Record字符串键→number；额外string规则仍在输出schema，模式匹配的键不走它。
		const record = Type.Record(Type.String(), Type.Number(), { additionalProperties: Type.String() });
		// n1命中Record模式，因此字符串1转number1，而不是作为额外键保持字符串。
		expect(compile(record, { coerce: true }).parse({ n1: "1" })).toEqual({ ok: true, value: { n1: 1 } });
		// 再造普通JSON Schema验证同一分派原则。
		const plain = {
			// 根object。
			type: "object",
			// n_开头的键允许integer或null，不能再按额外string转换。
			patternProperties: { "^n_": { type: ["integer", "null"] } },
			// 只有未命中模式的键按string处理。
			additionalProperties: { type: "string" },
		};
		// n_a成为数字5，other数字7变字符串，键归属分派不同。
		expect(coerce(plain, { n_a: "5", other: 7 })).toEqual({ n_a: 5, other: "7" });
	});

	// 三种属性入口都应继续进入内部item，删除item内可选n:null；外层键是否由模式/额外规则管理不改变里面已声明n的可选性。
	it("drop optional nulls inside declared, pattern and additional property values alike", () => {
		// item对象n可省且为>=1整数，null第一轮可删而不改成0。
		const item = obj({ n: opt(int({ minimum: 1 })) });
		// 下面数组放三份外层规则，逐个跑同一输入，不是把三规则同时allOf。
		const schemas = [
			// 第一份明确声明entry:item且entry必填。
			obj({ entry: item }),
			// 第二份map让任意entry值都按item处理。
			map(item),
			// 第三份只允许名为entry的模式键，额外字段拒绝。
			{ type: "object", patternProperties: { "^entry$": item }, additionalProperties: false },
		];
		// 逐份schema独立编译/parse。
		for (const schema of schemas) {
			// 每次新建input，避免上一份转换结果影响下一次。
			const input = { entry: { n: null } };
			// 结果仍有entry对象，但可选n被删。
			expect(compile(schema, { coerce: true }).parse(input)).toEqual({ ok: true, value: { entry: {} } });
			// 原input保留n:null，再次确认转换不原地覆盖这个普通对象。
			expect(input).toEqual({ entry: { n: null } });
		}
	});

	// 额外键的null例子区分“未列required的已声明字段”与“每个动态字典键”；动态键不能因未列required就随意删。
	it("keep a null under pattern and additional properties: their keys are not optional properties", () => {
		// additionalProperties允许integer/null，动态键名不在properties声明表。
		const schema = { type: "object", additionalProperties: { type: ["integer", "null"] } };
		// 动态n:null本来合法，应保留，不作为可选非nullable声明键清理。
		expect(compile(schema, { coerce: true }).parse({ n: null })).toEqual({ ok: true, value: { n: null } });
	});

	// tuple/array清理例子都让元素为同一item，验证第一轮递归不限于普通items。
	it("drop optional nulls in tuple items as in array items", () => {
		// item.n可省integer。
		const item = obj({ n: opt(int()) });
		// 普通数组内n:null删除，保留一个空item。
		expect(compile(arr(item), { coerce: true }).coerce([{ n: null }])).toEqual([{}]);
		// 固定单元素tuple同样清理，不能跳过prefixItems。
		expect(compile(tuple([item]), { coerce: true }).coerce([{ n: null }])).toEqual([{}]);
	});

	// 元组基础type例子给每位置type数组，检验第三轮处理prefixItems入口；helper仍执行全部三轮。
	it("coerce tuple items by type in pass 3", () => {
		// 首位置integer/null，第二位置boolean/null，没有items:false所以不在此声明固定2长度。
		const schema = { type: "array", prefixItems: [{ type: ["integer", "null"] }, { type: ["boolean", "null"] }] };
		// 已有两项字符串5/true转成number/boolean。
		expect(coerce(schema, ["5", "true"])).toEqual([5, true]);
	});

	// 联合同层属性例子既要遍历anyOf分支，也要处理联合节点自己声明的a/b，不能只有分支有类型才转换。
	it("convert the properties a union node declares besides its branches", () => {
		// schema同时有type/properties和anyOf兄弟关键词。
		const schema = {
			// 根object。
			type: "object",
			// a/b均可省integer，实际哪个存在由anyOf必填候选决定。
			properties: { a: { type: "integer" }, b: { type: "integer" } },
			// 至少提供a或b，但各分支不单独写字段type，数值规则在同层properties。
			anyOf: [{ required: ["a"] }, { required: ["b"] }],
		};
		// a:"3.5"先截为3，满足a必填支及同层整数要求，parse成功。
		expect(compile(schema, { coerce: true }).parse({ a: "3.5" })).toEqual({ ok: true, value: { a: 3 } });
	});

	// 循环为anyOf和oneOf分别登记一例，保证两种联合候选都与同层c属性转换配合。
	for (const keyword of ["anyOf", "oneOf"]) {
		// 模板字符串把当前keyword写进测试名，不改变它的JSON Schema语义。
		it(`check ${keyword} candidates after the node's own properties convert`, () => {
			// 本例schema在运行登记回调中按keyword构造。
			const schema = {
				// 根object。
				type: "object",
				// 计算属性[keyword]动态选择联合关键字，方括号不是数组下标赋值。
				[keyword]: [
					// a候选要求数组整数，标量3需包数组再转元素。
					{ type: "object", properties: { a: { type: "array", items: { type: "integer" } } }, required: ["a"] },
					// b候选要求boolean且必填，这次输入没有b。
					{ type: "object", properties: { b: { type: "boolean" } }, required: ["b"] },
				],
				// 联合节点自身还要求c为integer，两候选之外仍要处理它。
				properties: { c: { type: "integer" } },
				// c必填，不能只看分支就漏它。
				required: ["c"],
			};
			// 输入a/c都是数字字符串，但a目标为数组，c目标为标量。
			const input = { a: "3", c: "2" };
			// 期望a:[3]和c:2，同时满足整体联合与同层规则。
			expect(compile(schema, { coerce: true }).parse(input)).toEqual({ ok: true, value: { a: [3], c: 2 } });
			// 原input仍是两个字符串，没有被就地变更。
			expect(input).toEqual({ a: "3", c: "2" });
		});
	}
});
