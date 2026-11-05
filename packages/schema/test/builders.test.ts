// 用短schema构造器示范“规则数据、静态类型、运行检查”三层；比如opt(int())允许省略字段，但int的整数性仍要实际check。纯内存，不访问文件或模型。
// The builders: the JSON Schema they produce, the static types they carry, and how they compile.

// expect检查运行值；expectTypeOf由tsc验证类型，普通Vitest执行不会代替完整类型检查。
import { describe, expect, expectTypeOf, it } from "vitest";
// 下面从公开入口取构造器/编译器；type Static只存在于TS类型空间。
import {
	// arr把子规则变同元素类型数组规则。
	arr,
	// bool生成boolean规则。
	bool,
	// bytes生成本库Uint8Array扩展规则，不是普通JSON数组。
	bytes,
	// compile生成带check/errors等方法的验证器。
	compile,
	// int生成integer规则，静态值类型仍是number。
	int,
	// lit生成const单值规则，保留字面量类型。
	lit,
	// map构造任意字符串键的同类型值字典，不是Array.map。
	map,
	// nul生成只允许null的规则，不等同undefined。
	nul,
	// nullable给某规则加null分支，不是使对象字段可省略。
	nullable,
	// num生成number规则。
	num,
	// obj收集字段、必填名并默认拒绝多余属性。
	obj,
	// oneOf在此API是枚举构造器，输出enum，不是JSON Schema的oneOf分支关键字。
	oneOf,
	// opt把字段规则包成Optional供obj拆解，不直接验证值。
	opt,
	// Static从构造器携带的类型信息取出通过检查后的值类型；type导入运行时擦除。
	type Static,
	// str生成string规则，可传长度等约束。
	str,
	// tuple按位置构造定长数组规则。
	tuple,
	// union生成anyOf联合规则，至少符合一支。
	union,
	// unknown在此是函数名，输出无额外断言的{}规则；静态类型unknown也不是any。
	unknown,
} from "../src/index.ts";

// 五例覆盖可序列化规则、各构造器结果、Static推导、check收窄和真实错误解释。
describe("builders", () => {
	// 第一例把三字段构造结果JSON往返后逐字段比较，检查Optional包装已被obj拆掉，不混进最终JSON。
	it("produce plain JSON Schema", () => {
		// obj声明默认封闭对象。
		const schema = obj({
			// 必填path字符串且码点长度至少1；description只是说明。
			path: str({ description: "File path", minLength: 1 }),
			// offset可省略，存在时要整数且>=1；opt不把数据自动补成1。
			offset: opt(int({ minimum: 1 })),
			// mode必填，运行规则enum允许read/write。
			mode: oneOf(["read", "write"]),
		});
		// JSON.stringify再parse检查可传输的普通规则形状；不是对用户输入跑校验。
		expect(JSON.parse(JSON.stringify(schema))).toEqual({
			// 最终schema约束object。
			type: "object",
			// properties里放拆包后的规则，而不是各字段当前值。
			properties: {
				// path保留type、描述和长度。
				path: { type: "string", description: "File path", minLength: 1 },
				// offset输出integer/minimum，不输出Optional对象。
				offset: { type: "integer", minimum: 1 },
				// oneOf函数实际输出enum，例中不会输出oneOf数组。
				mode: { enum: ["read", "write"] },
			},
			// 未包装字段path/mode进required，offset不进。
			required: ["path", "mode"],
			// 默认关额外属性，输入other应被拒绝。
			additionalProperties: false,
		});
	});

	// 第二例直接比较叶/复合构造器输出，不在此测每种规则所有有效或非法输入。
	it("produce every leaf", () => {
		// 先按固定次序调用八个叶构造器，右边数组对应八份普通schema。
		expect([str(), num(), int(), bool(), nul(), unknown(), lit(3), bytes({ maxLength: 8 })]).toEqual([
			// str输出string规则。
			{ type: "string" },
			// num输出number规则。
			{ type: "number" },
			// int输出integer规则，但TS中没有专属整数基础类型。
			{ type: "integer" },
			// bool输出boolean规则。
			{ type: "boolean" },
			// nul的type字符串是null，不是把schema本身变成null。
			{ type: "null" },
			// unknown输出{}，不附加type。
			{},
			// lit(3)输出const:3。
			{ const: 3 },
			// bytes保留maxLength:8，校验时按字节数组长度。
			{ type: "bytes", maxLength: 8 },
		]);
		// arr(str(),{maxItems:2})让所有项目为string且数组最多两项，不是此刻创建string[]值。
		expect(arr(str(), { maxItems: 2 })).toEqual({ type: "array", items: { type: "string" }, maxItems: 2 });
		// map(num())用additionalProperties子规则，任意自有键值都需number。
		expect(map(num())).toEqual({ type: "object", additionalProperties: { type: "number" } });
		// tuple组合string/number两位置，右侧解释固定长度如何实现。
		expect(tuple([str(), num()])).toEqual({
			// 整体仍是array类型规则。
			type: "array",
			// prefixItems逐个位置对应规则，不是全部项目都同时过两条。
			prefixItems: [{ type: "string" }, { type: "number" }],
			// items:false拒绝第三项及以后。
			items: false,
			// minItems:2拒绝少项，与禁止多余项合成恰好2项。
			minItems: 2,
		});
		// nullable输出string或null的anyOf，不会加入undefined。
		expect(nullable(str())).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
		// open:true只让obj省略额外属性禁止项，生成schema不会含open关键字。
		expect(obj({ a: str() }, { open: true })).toEqual({
			// 开放对象仍限制输入类型为object。
			type: "object",
			// a仍有string字段规则。
			properties: { a: { type: "string" } },
			// a仍必填，开放额外字段不意味着所有字段可省略。
			required: ["a"],
		});
	});

	// 静态类型例子借助品牌从schema推联合/元组，tsc检查结果；这些断言不决定某个运行输入合法。
	it("carry the static type of valid values", () => {
		// 构造两类带kind常量的对象联合。
		const message = union([
			// text分支必填text字符串，kind恰为text。
			obj({ kind: lit("text"), text: str() }),
			// image分支必填url，alt用opt标可省略。
			obj({ kind: lit("image"), url: str(), alt: opt(str()) }),
		]);
		// typeof message在类型位置取变量类型，Static取值联合，toEqualTypeOf检查精确类型。
		expectTypeOf<Static<typeof message>>().toEqualTypeOf<
			// 竖线|把两个对象类型联合，alt?表示image分支可省alt，而不是text分支也有alt。
			{ kind: "text"; text: string } | { kind: "image"; url: string; alt?: string }
			// 完成泛型断言调用，类型参数擦除不创建对应运行对象。
		>();
		// 元组首项string，第二项为整数数组；静态整数数组仍是number[]。
		const pair = tuple([str(), arr(int())]);
		// Static结果是定长[string,number[]]，与所有元素可混用的普通联合数组不同。
		expectTypeOf<Static<typeof pair>>().toEqualTypeOf<[string, number[]]>();
		// typeof nullable<string>在类型中选定泛型函数签名，ReturnType取返回schema类型，再Static取string|null；没有实际调用nullable。
		expectTypeOf<Static<ReturnType<typeof nullable<string>>>>().toEqualTypeOf<string | null>();
		// 随手写普通{type:"string"}类型没有本库品牌或TypeBox标记，Static保守unknown，不尝试任意JSON Schema完整推导。
		expectTypeOf<Static<{ type: "string" }>>().toEqualTypeOf<unknown>();
	});

	// 收窄例子将unknown输入交check，失败分支throw后，TS凭类型谓词在后续知道字段形状；运行与类型检查共同配合。
	it("narrow values through a compiled check", () => {
		// 点规则要求x/y数值，label可选。
		const point = obj({ x: num(), y: num(), label: opt(str()) });
		// 显式unknown不因初始对象字面量就允许直接访问x；先验证才能按声明类型用。
		const value: unknown = { x: 1, y: 2 };
		// 对象解构取得可脱离实例调用的check，不用额外bind(this)。
		const { check } = compile(point);
		// 不通过就抛错终止本例；通过路径使用编译器声明的类型谓词进行控制流收窄。
		if (!check(value)) throw new Error("expected a point");
		// tsc检查此时value已是所需点类型，不再unknown。
		expectTypeOf(value).toEqualTypeOf<{ x: number; y: number; label?: string }>();
		// 运行时可以相加x/y，结果3；本例不只检查类型形式。
		expect(value.x + value.y).toBe(3);
	});

	// 最后一例实际编译嵌套规则，先测合法值，再一次造三种错误检查路径/关键字/文案顺序。
	it("compile into checks with the declared semantics", () => {
		// name必填非空，tags可选字符串数组且内容唯一，对象默认禁止other。
		const validator = compile(obj({ name: str({ minLength: 1 }), tags: opt(arr(str(), { uniqueItems: true })) }));
		// 只给合法name且省tags应通过。
		expect(validator.check({ name: "a" })).toBe(true);
		// 有两项不同字符串tags也应通过。
		expect(validator.check({ name: "a", tags: ["x", "y"] })).toBe(true);
		// 空name、重复tags和额外other同时输入，应返回下面三条错误而非转换数据。
		expect(validator.errors({ name: "", tags: ["x", "x"], other: 1 })).toEqual([
			// name按minLength报错，路径/name。
			{ path: "/name", keyword: "minLength", message: "expected at least 1 characters" },
			// tags按uniqueItems报错，不自动删除重复x。
			{ path: "/tags", keyword: "uniqueItems", message: "expected unique items" },
			// other按additionalProperties报未知字段，不静默忽略或删掉它。
			{ path: "/other", keyword: "additionalProperties", message: "unknown field" },
		]);
	});
});
