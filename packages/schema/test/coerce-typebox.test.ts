// biome-ignore-all lint/suspicious/noTemplateCurlyInString: TypeBox template literal syntax, as in the original tests.
// biome-ignore-all lint/correctness/noPrecisionLoss: the original tests' literal, kept as written.
// TypeBox 1.3.27's Value.Convert tests (test/typebox/runtime/value/convert, MIT, (c) Haydn Paterson), ported to the
// conversion pass of pi-schema's coercion. Schemas are still built with TypeBox: its schemas are JSON Schema, and the
// port reads only their JSON structure, never TypeBox's kind marks. Run with vitest.
// 这些迁移用例以本库第二轮Coercer.convertOnly替代TypeBox Value.Convert，并非运行时逐例对照两个实现；17个skip保持跳过，已改差异期望会单独解释。活跃用例仍含BigInt/undefined输入，不能概括成所有非JSON值都不支持。

// Type是真实TypeBox构造器，负责生成规则；没有从typebox/value导入原版Value.Convert。
import { Type } from "typebox";
// Vitest的describe/it登记用例，expect比较运行结果；skip回调本身不执行，测试通过也不包含这些跳过行为。
import { describe, expect, it } from "vitest";
// Coercer是本库转换器，本文件只调用convertOnly，不执行可选null清理和第三轮基础type转换。
import { Coercer } from "../src/coerce.ts";
// Compiler为候选规则提供实际check/Resolver，不在此生成字符串函数或连接任何服务。
import { Compiler } from "../src/compiler.ts";
// 本地格式回调显式交编译器，格式判断不访问网络。
import { formats } from "../src/formats/index.ts";
// 公开compile只用于下面Value.Check外观，与第二轮转换函数分开。
import { compile } from "../src/index.ts";

/** Pass 2 alone, as TypeBox's Value.Convert(schema, value). */
// 用途：输入unknown规则和值，返回本库第二轮转换结果unknown；例如number规则把字符串42转数字42。每次新建Compiler/Coercer，只转换不保证合法，无外部I/O；编译或转换异常由实际callee决定传播/捕获边界。
// 参数与返回值冒号后的unknown表示TS允许传入任何类型；读取具体成员或按某种基础类型运算前须收窄，它不是运行时验证。这里显式返回unknown，不把转换结果承诺成schema对应类型。
function convert(schema: unknown, value: unknown): unknown {
	// as object只是编译期把unknown规则交构造器，不校验或复制；{ formats }是同名属性简写，false关闭动态scope跟踪。Compiler尚未root编译，convertOnly按需借check验候选，结束清理单次memo/重入计数。
	return new Coercer(new Compiler(schema as object, { formats }, false), schema).convertOnly(value);
}

// 本地Value外观保留迁移用例原有写法：Convert与Check都指向pi-schema，不是TypeBox命名空间；创建对象不立即运行测试。
const Value = {
	// Convert保存上面函数引用，后续调用始终只跑第二轮。
	Convert: convert,
	// Check输入规则/unknown值，编译本库完整校验器后返回布尔值；箭头右边无花括号函数体时直接返回表达式。as object不验证schema形状，不运行coerce，编译/check异常未在此捕获。
	Check: (schema: unknown, value: unknown) => compile(schema as object, { formats }).check(value),
};
// 另一个直接别名，仍是本库convert函数；供后面保留原迁移代码使用，无新转换逻辑。
const Convert = convert;
// 断言外观只对Vitest转发，无状态或业务返回；例IsEqual(1,1)结构/值比较通过，失败则抛断言，不校验转换结果是否符合schema。
const Assert = {
	// IsEqual接两个unknown，用toEqual比较值/结构，不是引用身份或独立schema校验；失败使当前用例失败。
	IsEqual: (actual: unknown, expected: unknown) => expect(actual).toEqual(expected),
	// IsTrue接布尔值，严格期待true；如IsTrue(Value.Check(T, R))，先完成内部Check再传返回值，不比较精确输出结构。boolean限制TS调用类型，运行时由toBe比较。
	IsTrue: (value: boolean) => expect(value).toBe(true),
	// IsFalse严格期待false，表示转换后仍可被规则拒绝，并非转换函数必须抛错。
	IsFalse: (value: boolean) => expect(value).toBe(false),
};

// Any组不添加转换约束，比较null/undefined/基础值/普通容器原有内容；toEqual不证明对象身份，也不等于已验证所有任意值。Symbol示例单独跳过。
describe("Value.Convert.Any", () => {
	// 本例输入/预期：Value.Convert(T, null) 的预期为 null。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 1", () => {
		// 构造Any规则，无额外转换要求；类型名不是执行某个用户值检查。
		const T = Type.Any();
		// Any不提供具体转换约束，输入 null 保留为 null；若为容器，这里后续只比较内容。
		const R = Value.Convert(T, null);
		// 按值/结构核对结果为 null，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, null);
	});
	// 本例输入/预期：Value.Convert(T, undefined) 的预期为 undefined。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 2", () => {
		// 构造Any规则，无额外转换要求；类型名不是执行某个用户值检查。
		const T = Type.Any();
		// Any不提供具体转换约束，输入 undefined 保留为 undefined；若为容器，这里后续只比较内容。
		const R = Value.Convert(T, undefined);
		// 按值/结构核对结果为 undefined，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, undefined);
	});
	// 本例输入/预期：Value.Convert(T, "hello") 的预期为 "hello"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 3", () => {
		// 构造Any规则，无额外转换要求；类型名不是执行某个用户值检查。
		const T = Type.Any();
		// Any不提供具体转换约束，输入 "hello" 保留为 "hello"；若为容器，这里后续只比较内容。
		const R = Value.Convert(T, "hello");
		// 按值/结构核对结果为 "hello"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "hello");
	});
	// 本例输入/预期：Value.Convert(T, 42) 的预期为 42。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 4", () => {
		// 构造Any规则，无额外转换要求；类型名不是执行某个用户值检查。
		const T = Type.Any();
		// Any不提供具体转换约束，输入 42 保留为 42；若为容器，这里后续只比较内容。
		const R = Value.Convert(T, 42);
		// 按值/结构核对结果为 42，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 42);
	});
	// 本例输入/预期：Value.Convert(T, true) 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 5", () => {
		// 构造Any规则，无额外转换要求；类型名不是执行某个用户值检查。
		const T = Type.Any();
		// Any不提供具体转换约束，输入 true 保留为 true；若为容器，这里后续只比较内容。
		const R = Value.Convert(T, true);
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, true);
	});
	// 本例输入/预期：Value.Convert(T, { x: 1 }) 的预期为 { x: 1 }。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 6", () => {
		// 构造Any规则，无额外转换要求；类型名不是执行某个用户值检查。
		const T = Type.Any();
		// Any不提供具体转换约束，输入 { x: 1 } 保留为 { x: 1 }；若为容器，这里后续只比较内容。
		const R = Value.Convert(T, { x: 1 });
		// 按值/结构核对结果为 { x: 1 }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, { x: 1 });
	});
	// 本例输入/预期：Value.Convert(T, [1, 2, 3]) 的预期为 [1, 2, 3]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 7", () => {
		// 构造Any规则，无额外转换要求；类型名不是执行某个用户值检查。
		const T = Type.Any();
		// Any不提供具体转换约束，输入 [1, 2, 3] 保留为 [1, 2, 3]；若为容器，这里后续只比较内容。
		const R = Value.Convert(T, [1, 2, 3]);
		// 按值/结构核对结果为 [1, 2, 3]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [1, 2, 3]);
	});
	// Skipped: the schema or the value has no JSON form.
	// 跳过示例：Value.Convert(T, S) 的预期为 S。it.skip不执行回调，保留的预期不构成本库支持证明。
	it.skip("Should Convert 8", () => {
		// 未执行的回调正文：创建Symbol输入 Symbol("x-symbol")；当前跳过回调不会执行它，不是字符串数据或已验证JSON能力。
		const S = Symbol("x-symbol");
		// 未执行的回调正文：构造Symbol规则；当前所在it.skip不执行，不能当作本库已验证的非JSON类型支持。
		const T = Type.Symbol();
		// 未执行的回调正文：执行第二轮转换，输入 Symbol("x-symbol") 的预期结果为 S；类型不在此提供运行时校验保证。
		const R = Value.Convert(T, S);
		// 跳过的预期断言：按值/结构核对结果为 S，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, S);
	});
});

// Array组先按普通数组规则包单值，再递归转换元素；含嵌套/联合/交叉例子，部分只断言结果通过本库Check，不比较精确形状。BigInt数组schema的跳过例不算支持证明。
describe("Value.Convert.Array", () => {
	// 本例输入/预期：Value.Convert(T, [1, 3.14, "1", "3.14", true, false, "true", "false", "hello"]) 的预期为 [1, 3.14, 1, 3.14, 1, 0, 1, 0, "hello"]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 1", () => {
		// 构造数组规则 Type.Array(Type.Number())；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Number());
		// 按数组层处理输入 [1, 3.14, "1", "3.14", true, false, "true", "false", "hello"]：已有数组逐项转换，普通单值先包一项再递归；本例结构期望 [1, 3.14, 1, 3.14, 1, 0, 1, 0, "hello"]。
		const R = Value.Convert(T, [1, 3.14, "1", "3.14", true, false, "true", "false", "hello"]);
		// 按值/结构核对结果为 [1, 3.14, 1, 3.14, 1, 0, 1, 0, "hello"]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [1, 3.14, 1, 3.14, 1, 0, 1, 0, "hello"]);
	});
	// 本例输入/预期：Value.Convert(T, [1, 3.14, "1", "3.14", true, false, "true", "false", "hello"]) 的预期为 [true, 3.14, true, "3.14", true, false, true, false, "hello"]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 2", () => {
		// 构造数组规则 Type.Array(Type.Boolean())；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Boolean());
		// 按数组层处理输入 [1, 3.14, "1", "3.14", true, false, "true", "false", "hello"]：已有数组逐项转换，普通单值先包一项再递归；本例结构期望 [true, 3.14, true, "3.14", true, false, true, false, "hello"]。
		const R = Value.Convert(T, [1, 3.14, "1", "3.14", true, false, "true", "false", "hello"]);
		// 按值/结构核对结果为 [true, 3.14, true, "3.14", true, false, true, false, "hello"]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [true, 3.14, true, "3.14", true, false, true, false, "hello"]);
	});
	// 本例输入/预期：Value.Convert(T, [1, 3.14, "1", "3.14", true, false, "true", "false", "hello"]) 的预期为 ["1", "3.14", "1", "3.14", "true", "false", "true", "false", "hello"]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 3", () => {
		// 构造数组规则 Type.Array(Type.String())；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.String());
		// 按数组层处理输入 [1, 3.14, "1", "3.14", true, false, "true", "false", "hello"]：已有数组逐项转换，普通单值先包一项再递归；本例结构期望 ["1", "3.14", "1", "3.14", "true", "false", "true", "false", "hello"]。
		const R = Value.Convert(T, [1, 3.14, "1", "3.14", true, false, "true", "false", "hello"]);
		// 按值/结构核对结果为 ["1", "3.14", "1", "3.14", "true", "false", "true", "false", "hello"]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, ["1", "3.14", "1", "3.14", "true", "false", "true", "false", "hello"]);
	});
	// ------------------------------------------------------------------
	// Added support for Array coercion
	//
	// https://github.com/sinclairzx81/typebox/issues/1469
	// ------------------------------------------------------------------
	// 本例输入/预期：Value.Convert(T, "1") 的预期为 [1]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 4", () => {
		// 构造数组规则 Type.Array(Type.Number())；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Number());
		// 按数组层处理输入 "1"：已有数组逐项转换，普通单值先包一项再递归；本例结构期望 [1]。
		const R = Value.Convert(T, "1");
		// 按值/结构核对结果为 [1]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [1]);
	});
	// 本例输入/预期：Value.Convert(T, []) 的预期为 []。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 5", () => {
		// 构造数组规则 Type.Array(Type.Number())；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Number());
		// 按数组层处理输入 []：已有数组逐项转换，普通单值先包一项再递归；本例结构期望 []。
		const R = Value.Convert(T, []);
		// 按值/结构核对结果为 []，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, []);
	});
	// 本例输入/预期：Value.Convert(T, 42) 的预期为 [42]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 6", () => {
		// 构造数组规则 Type.Array(Type.Number())；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Number());
		// 按数组层处理输入 42：已有数组逐项转换，普通单值先包一项再递归；本例结构期望 [42]。
		const R = Value.Convert(T, 42);
		// 按值/结构核对结果为 [42]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [42]);
	});
	// 本例输入/预期：Value.Convert(T, true) 的预期为 [true]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 7", () => {
		// 构造数组规则 Type.Array(Type.Boolean())；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Boolean());
		// 按数组层处理输入 true：已有数组逐项转换，普通单值先包一项再递归；本例结构期望 [true]。
		const R = Value.Convert(T, true);
		// 按值/结构核对结果为 [true]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [true]);
	});
	// 本例输入/预期：Value.Convert(T, null) 的预期为 [null]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 8", () => {
		// 构造数组规则 Type.Array(Type.Null())；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Null());
		// 按数组层处理输入 null：已有数组逐项转换，普通单值先包一项再递归；本例结构期望 [null]。
		const R = Value.Convert(T, null);
		// 按值/结构核对结果为 [null]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [null]);
	});
	// 本例输入/预期：Value.Convert(T, undefined) 的预期为 [undefined]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 9", () => {
		// 构造数组规则 Type.Array(Type.Unknown())；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Unknown());
		// 按数组层处理输入 undefined：已有数组逐项转换，普通单值先包一项再递归；本例结构期望 [undefined]。
		const R = Value.Convert(T, undefined);
		// 按值/结构核对结果为 [undefined]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [undefined]);
	});
	// Skipped: the schema or the value has no JSON form.
	// 跳过示例：Value.Convert(T, 1n) 的预期为 [1n]。it.skip不执行回调，保留的预期不构成本库支持证明。
	it.skip("Should Convert 10", () => {
		// 未执行的回调正文：构造数组规则 Type.Array(Type.BigInt())；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.BigInt());
		// 未执行的回调正文：按数组层处理输入 1n：已有数组逐项转换，普通单值先包一项再递归；本例结构期望 [1n]。
		const R = Value.Convert(T, 1n);
		// 跳过的预期断言：按值/结构核对结果为 [1n]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [1n]);
	});
	// 本例输入/预期：Value.Convert(T, {}) 的预期为 [{}]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 11", () => {
		// 构造数组规则 Type.Array(Type.Object({}))；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Object({}));
		// 按数组层处理输入 {}：已有数组逐项转换，普通单值先包一项再递归；本例结构期望 [{}]。
		const R = Value.Convert(T, {});
		// 按值/结构核对结果为 [{}]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [{}]);
	});
	// 本例输入/预期：Value.Convert(T, { x: 1 }) 的预期为 [{ x: 1 }]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 12", () => {
		// 构造数组规则 Type.Array(Type.Object({ x: Type.Number() }))；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Object({ x: Type.Number() }));
		// 按数组层处理输入 { x: 1 }：已有数组逐项转换，普通单值先包一项再递归；本例结构期望 [{ x: 1 }]。
		const R = Value.Convert(T, { x: 1 });
		// 按值/结构核对结果为 [{ x: 1 }]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [{ x: 1 }]);
	});
	// 本例输入/预期：Value.Convert(T, "42") 的预期为 [42]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 13", () => {
		// 构造数组规则 Type.Array(Type.Number())；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Number());
		// 按数组层处理输入 "42"：已有数组逐项转换，普通单值先包一项再递归；本例结构期望 [42]。
		const R = Value.Convert(T, "42");
		// 按值/结构核对结果为 [42]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [42]);
	});
	// 本例输入/预期：Value.Convert(T, "true") 的预期为 [true]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 14", () => {
		// 构造数组规则 Type.Array(Type.Boolean())；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Boolean());
		// 按数组层处理输入 "true"：已有数组逐项转换，普通单值先包一项再递归；本例结构期望 [true]。
		const R = Value.Convert(T, "true");
		// 按值/结构核对结果为 [true]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [true]);
	});
	// 本例输入/预期：Value.Convert(T, 0) 的预期为 [false]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 15", () => {
		// 构造数组规则 Type.Array(Type.Boolean())；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Boolean());
		// 按数组层处理输入 0：已有数组逐项转换，普通单值先包一项再递归；本例结构期望 [false]。
		const R = Value.Convert(T, 0);
		// 按值/结构核对结果为 [false]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [false]);
	});
	// 本例输入/预期：Value.Convert(T, "hello") 的预期为 ["hello"]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 16", () => {
		// 构造数组规则 Type.Array(Type.Number())；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Number());
		// 按数组层处理输入 "hello"：已有数组逐项转换，普通单值先包一项再递归；本例结构期望 ["hello"]。
		const R = Value.Convert(T, "hello");
		// 按值/结构核对结果为 ["hello"]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, ["hello"]);
	});
	// 本例输入/预期：Value.Convert(T, [1]) 的预期为 [1]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 17", () => {
		// 构造数组规则 Type.Array(Type.Number())；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Number());
		// 按数组层处理输入 [1]：已有数组逐项转换，普通单值先包一项再递归；本例结构期望 [1]。
		const R = Value.Convert(T, [1]);
		// 按值/结构核对结果为 [1]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [1]);
	});
	// 本例输入/预期：Value.Check(T, R) 应为true，只检查合法性布尔结果，不比较精确结构。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 18", () => {
		// 构造数组规则 Type.Array(Type.Array(Type.Number()))；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Array(Type.Number()));
		// 按数组层处理输入 [1, 2, 3]：已有数组逐项转换，普通单值先包一项再递归；本例只在后面检查合法性。
		const R = Value.Convert(T, [1, 2, 3]);
		// 单独运行本库Value.Check并期待true，说明这个结果符合规则；不从这一断言推导精确值或与原TypeBox完全一致。
		Assert.IsTrue(Value.Check(T, R));
	});
	// 本例输入/预期：Value.Convert(T, { 0: 1, length: 1 }) 的预期为 [{ 0: 1, length: 1 }]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 19", () => {
		// 构造数组规则 Type.Array(Type.Number())；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Number());
		// 按数组层处理输入 { 0: 1, length: 1 }：已有数组逐项转换，普通单值先包一项再递归；本例结构期望 [{ 0: 1, length: 1 }]。
		const R = Value.Convert(T, { 0: 1, length: 1 });
		// 按值/结构核对结果为 [{ 0: 1, length: 1 }]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [{ 0: 1, length: 1 }]);
	});
	// 本例输入/预期：Value.Check(T, R) 应为true，只检查合法性布尔结果，不比较精确结构。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 20", () => {
		// 构造数组规则 Type.Array(Type.Array(Type.Number()))；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Array(Type.Number()));
		// 按数组层处理输入 42：已有数组逐项转换，普通单值先包一项再递归；本例只在后面检查合法性。
		const R = Value.Convert(T, 42);
		// 单独运行本库Value.Check并期待true，说明这个结果符合规则；不从这一断言推导精确值或与原TypeBox完全一致。
		Assert.IsTrue(Value.Check(T, R));
	});
	// ------------------------------------------------------------------
	// Union
	// ------------------------------------------------------------------
	// 本例输入/预期：Value.Check(T, R) 应为true，只检查合法性布尔结果，不比较精确结构。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 21", () => {
		// 构造数组规则 Type.Array(Type.Union([Type.Number(), Type.String()]))；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Union([Type.Number(), Type.String()]));
		// 按数组层处理输入 1：已有数组逐项转换，普通单值先包一项再递归；本例只在后面检查合法性。
		const R = Value.Convert(T, 1);
		// 单独运行本库Value.Check并期待true，说明这个结果符合规则；不从这一断言推导精确值或与原TypeBox完全一致。
		Assert.IsTrue(Value.Check(T, R));
	});
	// 本例输入/预期：Value.Check(T, R) 应为true，只检查合法性布尔结果，不比较精确结构。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 22", () => {
		// 构造数组规则 Type.Array(Type.Union([Type.Number(), Type.String()]))；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Union([Type.Number(), Type.String()]));
		// 按数组层处理输入 "hello"：已有数组逐项转换，普通单值先包一项再递归；本例只在后面检查合法性。
		const R = Value.Convert(T, "hello");
		// 单独运行本库Value.Check并期待true，说明这个结果符合规则；不从这一断言推导精确值或与原TypeBox完全一致。
		Assert.IsTrue(Value.Check(T, R));
	});
	// 本例输入/预期：Value.Check(T, R) 应为true，只检查合法性布尔结果，不比较精确结构。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 23", () => {
		// 构造数组规则 Type.Array(Type.Union([Type.Number(), Type.String()]))；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Union([Type.Number(), Type.String()]));
		// 按数组层处理输入 [1, "hello", true, "3.14"]：已有数组逐项转换，普通单值先包一项再递归；本例只在后面检查合法性。
		const R = Value.Convert(T, [1, "hello", true, "3.14"]);
		// 单独运行本库Value.Check并期待true，说明这个结果符合规则；不从这一断言推导精确值或与原TypeBox完全一致。
		Assert.IsTrue(Value.Check(T, R));
	});
	// 本例输入/预期：Value.Check(T, R) 应为true，只检查合法性布尔结果，不比较精确结构。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 24", () => {
		// 构造有序联合规则 Type.Union([Type.Array(Type.Number()), Type.String()])；候选顺序会影响需要转换的值，不强改本来已合法的值。
		const T = Type.Union([Type.Array(Type.Number()), Type.String()]);
		// 输入 "1" 先查有没有原样可接受支，否则依序试转换并验整体联合；本例随后只核对Check，不比较具体结构，顺序不是最小修改评分。
		const R = Value.Convert(T, "1");
		// 单独运行本库Value.Check并期待true，说明这个结果符合规则；不从这一断言推导精确值或与原TypeBox完全一致。
		Assert.IsTrue(Value.Check(T, R));
	});
	// 本例输入/预期：Value.Check(T, R) 应为true，只检查合法性布尔结果，不比较精确结构。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 25", () => {
		// 构造数组规则 Type.Array(Type.Union([Type.Array(Type.Number()), Type.String()]))；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Union([Type.Array(Type.Number()), Type.String()]));
		// 按数组层处理输入 42：已有数组逐项转换，普通单值先包一项再递归；本例只在后面检查合法性。
		const R = Value.Convert(T, 42);
		// 单独运行本库Value.Check并期待true，说明这个结果符合规则；不从这一断言推导精确值或与原TypeBox完全一致。
		Assert.IsTrue(Value.Check(T, R));
	});
	// ------------------------------------------------------------------
	// Embedded Intersect
	// ------------------------------------------------------------------
	// 本例输入/预期：Value.Check(T, R) 应为true，只检查合法性布尔结果，不比较精确结构。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 26", () => {
		// 构造数组规则 Type.Array(Type.Intersect([Type.Object({ x: Type.Number() }), Type.Object({ y: Type.Number() })]))；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Intersect([Type.Object({ x: Type.Number() }), Type.Object({ y: Type.Number() })]));
		// 按数组层处理输入 { x: 1, y: 2 }：已有数组逐项转换，普通单值先包一项再递归；本例只在后面检查合法性。
		const R = Value.Convert(T, { x: 1, y: 2 });
		// 单独运行本库Value.Check并期待true，说明这个结果符合规则；不从这一断言推导精确值或与原TypeBox完全一致。
		Assert.IsTrue(Value.Check(T, R));
	});
	// 本例输入/预期：Value.Check(T, R) 应为true，只检查合法性布尔结果，不比较精确结构。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 27", () => {
		// 构造数组规则 Type.Array(Type.Intersect([Type.Object({ x: Type.Number() }), Type.Object({ y: Type.Number() })]))；普通单值可包一项，再按子规则递归，本行只构造规则数据。
		const T = Type.Array(Type.Intersect([Type.Object({ x: Type.Number() }), Type.Object({ y: Type.Number() })]));
		// 按数组层处理输入 [ { x: "1", y: "2" }, { x: "3", y: "4" }, ]：已有数组逐项转换，普通单值先包一项再递归；本例只在后面检查合法性。
		const R = Value.Convert(T, [
			// 这一数组输入项的x/y原本是字符串，交叉对象子规则将分别尝试转数值；此行是输入数据，不是schema。
			{ x: "1", y: "2" },
			// 这一数组输入项的x/y原本是字符串，交叉对象子规则将分别尝试转数值；此行是输入数据，不是schema。
			{ x: "3", y: "4" },
		]);
		// 单独运行本库Value.Check并期待true，说明这个结果符合规则；不从这一断言推导精确值或与原TypeBox完全一致。
		Assert.IsTrue(Value.Check(T, R));
	});
	// 本例输入/预期：Value.Check(T, R) 应为true，只检查合法性布尔结果，不比较精确结构。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 28", () => {
		// 构造交叉规则；本库按生成allOf成员逐个接力转换，不运行原TypeBox Evaluate合并。
		const T = Type.Intersect([Type.Array(Type.Number()), Type.Array(Type.Number())]);
		// 输入 42 按生成allOf成员先后接力转换；本例随后只核对Check，不比较具体结构，不是原TypeBox先Evaluate合并后的行为承诺。
		const R = Value.Convert(T, 42);
		// 单独运行本库Value.Check并期待true，说明这个结果符合规则；不从这一断言推导精确值或与原TypeBox完全一致。
		Assert.IsTrue(Value.Check(T, R));
	});
	// 本例输入/预期：Value.Check(T, R) 应为false，只检查合法性布尔结果，不比较精确结构。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 29", () => {
		// 构造交叉规则；本库按生成allOf成员逐个接力转换，不运行原TypeBox Evaluate合并。
		const T = Type.Intersect([Type.Array(Type.Number()), Type.Object({ x: Type.Number() })]);
		// 输入 42 按生成allOf成员先后接力转换；本例随后只核对Check，不比较具体结构，不是原TypeBox先Evaluate合并后的行为承诺。
		const R = Value.Convert(T, 42);
		// 单独运行本库Value.Check并期待false，说明转换结果仍不符合规则；不从这一断言推导精确值或与原TypeBox完全一致。
		Assert.IsFalse(Value.Check(T, R));
	});
});

// Boolean组按本库第二轮的明确映射处理0/1、大小写true/false文字及null/undefined；3.14、2或普通对象等不可转换时保留，不能套用JS Boolean(value)真值规则。default只作注解，不代替坏值。
describe("Value.Convert.Boolean", () => {
	// 本例输入/预期：Value.Convert(T, "1") 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 1", () => {
		// 构造boolean规则，按0/1和明确文字映射，不按任意非空值真值转换；default不作为转换失败兜底。
		const T = Type.Boolean();
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 "1"，本例结果 true；没有可用映射的原值保持，不读default兜底。
		const R = Value.Convert(T, "1");
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, true);
	});
	// 本例输入/预期：Value.Convert(T, "3.14") 的预期为 "3.14"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 2", () => {
		// 构造boolean规则，按0/1和明确文字映射，不按任意非空值真值转换；default不作为转换失败兜底。
		const T = Type.Boolean();
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 "3.14"，本例结果 "3.14"；没有可用映射的原值保持，不读default兜底。
		const R = Value.Convert(T, "3.14");
		// 按值/结构核对结果为 "3.14"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "3.14");
	});
	// 本例输入/预期：Value.Convert(T, "true") 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 3", () => {
		// 构造boolean规则，按0/1和明确文字映射，不按任意非空值真值转换；default不作为转换失败兜底。
		const T = Type.Boolean();
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 "true"，本例结果 true；没有可用映射的原值保持，不读default兜底。
		const R = Value.Convert(T, "true");
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, true);
	});
	// 本例输入/预期：Value.Convert(T, "false") 的预期为 false。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 4", () => {
		// 构造boolean规则，按0/1和明确文字映射，不按任意非空值真值转换；default不作为转换失败兜底。
		const T = Type.Boolean();
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 "false"，本例结果 false；没有可用映射的原值保持，不读default兜底。
		const R = Value.Convert(T, "false");
		// 按值/结构核对结果为 false，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, false);
	});
	// 本例输入/预期：Value.Convert(T, 1) 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 5", () => {
		// 构造boolean规则，按0/1和明确文字映射，不按任意非空值真值转换；default不作为转换失败兜底。
		const T = Type.Boolean();
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 1，本例结果 true；没有可用映射的原值保持，不读default兜底。
		const R = Value.Convert(T, 1);
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, true);
	});
	// 本例输入/预期：Value.Convert(T, 3.14) 的预期为 3.14。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 6", () => {
		// 构造boolean规则，按0/1和明确文字映射，不按任意非空值真值转换；default不作为转换失败兜底。
		const T = Type.Boolean();
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 3.14，本例结果 3.14；没有可用映射的原值保持，不读default兜底。
		const R = Value.Convert(T, 3.14);
		// 按值/结构核对结果为 3.14，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 3.14);
	});
	// 本例输入/预期：Value.Convert(T, 1.1) 的预期为 1.1。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 7", () => {
		// 构造boolean规则，按0/1和明确文字映射，不按任意非空值真值转换；default不作为转换失败兜底。
		const T = Type.Boolean();
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 1.1，本例结果 1.1；没有可用映射的原值保持，不读default兜底。
		const R = Value.Convert(T, 1.1);
		// 按值/结构核对结果为 1.1，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 1.1);
	});
	// 本例输入/预期：Value.Convert(T, true) 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 8", () => {
		// 构造boolean规则，按0/1和明确文字映射，不按任意非空值真值转换；default不作为转换失败兜底。
		const T = Type.Boolean();
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 true，本例结果 true；没有可用映射的原值保持，不读default兜底。
		const R = Value.Convert(T, true);
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, true);
	});
	// 本例输入/预期：Value.Convert(T, false) 的预期为 false。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 9", () => {
		// 构造boolean规则，按0/1和明确文字映射，不按任意非空值真值转换；default不作为转换失败兜底。
		const T = Type.Boolean();
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 false，本例结果 false；没有可用映射的原值保持，不读default兜底。
		const R = Value.Convert(T, false);
		// 按值/结构核对结果为 false，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, false);
	});
	// ----------------------------------------------------------
	// Casts
	// ----------------------------------------------------------
	// 本例输入/预期：Value.Convert(Type.Boolean(), value) 的预期为 "hello"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 10", () => {
		// 保存本次原始输入 "hello"，与转换结果分开命名，便于检查它是否被保留。
		const value = "hello";
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 "hello"，本例结果 "hello"；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean(), value);
		// 按值/结构核对结果为 "hello"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, "hello");
	});
	// 本例输入/预期：Value.Convert(Type.Boolean(), value) 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 11", () => {
		// 保存本次原始输入 "true"，与转换结果分开命名，便于检查它是否被保留。
		const value = "true";
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 "true"，本例结果 true；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean(), value);
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, true);
	});
	// 本例输入/预期：Value.Convert(Type.Boolean(), value) 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 12", () => {
		// 保存本次原始输入 "TRUE"，与转换结果分开命名，便于检查它是否被保留。
		const value = "TRUE";
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 "TRUE"，本例结果 true；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean(), value);
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, true);
	});
	// 本例输入/预期：Value.Convert(Type.Boolean(), value) 的预期为 false。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 13", () => {
		// 保存本次原始输入 "false"，与转换结果分开命名，便于检查它是否被保留。
		const value = "false";
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 "false"，本例结果 false；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean(), value);
		// 按值/结构核对结果为 false，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, false);
	});
	// 本例输入/预期：Value.Convert(Type.Boolean(), value) 的预期为 false。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 14", () => {
		// 保存本次原始输入 "0"，与转换结果分开命名，便于检查它是否被保留。
		const value = "0";
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 "0"，本例结果 false；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean(), value);
		// 按值/结构核对结果为 false，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, false);
	});
	// 本例输入/预期：Value.Convert(Type.Boolean(), value) 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 15", () => {
		// 保存本次原始输入 "1"，与转换结果分开命名，便于检查它是否被保留。
		const value = "1";
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 "1"，本例结果 true；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean(), value);
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, true);
	});
	// 本例输入/预期：Value.Convert(Type.Boolean({ default: true }), value) 的预期为 false。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 16", () => {
		// 保存本次原始输入 "0"，与转换结果分开命名，便于检查它是否被保留。
		const value = "0";
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 "0"，本例结果 false；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean({ default: true }), value);
		// 按值/结构核对结果为 false，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, false);
	});
	// 本例输入/预期：Value.Convert(Type.Boolean({ default: false }), value) 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 17", () => {
		// 保存本次原始输入 "1"，与转换结果分开命名，便于检查它是否被保留。
		const value = "1";
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 "1"，本例结果 true；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean({ default: false }), value);
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, true);
	});
	// 本例输入/预期：Value.Convert(Type.Boolean({ default: true }), value) 的预期为 "2"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 18", () => {
		// 保存本次原始输入 "2"，与转换结果分开命名，便于检查它是否被保留。
		const value = "2";
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 "2"，本例结果 "2"；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean({ default: true }), value);
		// 按值/结构核对结果为 "2"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, "2");
	});
	// 本例输入/预期：Value.Convert(Type.Boolean(), value) 的预期为 false。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 19", () => {
		// 保存本次原始输入 0，与转换结果分开命名，便于检查它是否被保留。
		const value = 0;
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 0，本例结果 false；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean(), value);
		// 按值/结构核对结果为 false，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, false);
	});
	// 本例输入/预期：Value.Convert(Type.Boolean(), value) 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 20", () => {
		// 保存本次原始输入 1n，与转换结果分开命名，便于检查它是否被保留。
		const value = 1n;
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 1n，本例结果 true；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean(), value);
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, true);
	});
	// 本例输入/预期：Value.Convert(Type.Boolean(), value) 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 21", () => {
		// 保存本次原始输入 1，与转换结果分开命名，便于检查它是否被保留。
		const value = 1;
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 1，本例结果 true；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean(), value);
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, true);
	});
	// 本例输入/预期：Value.Convert(Type.Boolean(), value) 的预期为 2。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 22", () => {
		// 保存本次原始输入 2，与转换结果分开命名，便于检查它是否被保留。
		const value = 2;
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 2，本例结果 2；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean(), value);
		// 按值/结构核对结果为 2，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, 2);
	});
	// 本例输入/预期：Value.Convert(Type.Boolean({ default: true }), value) 的预期为 false。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 23", () => {
		// 保存本次原始输入 0，与转换结果分开命名，便于检查它是否被保留。
		const value = 0;
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 0，本例结果 false；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean({ default: true }), value);
		// 按值/结构核对结果为 false，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, false);
	});
	// 本例输入/预期：Value.Convert(Type.Boolean({ default: false }), value) 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 24", () => {
		// 保存本次原始输入 1，与转换结果分开命名，便于检查它是否被保留。
		const value = 1;
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 1，本例结果 true；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean({ default: false }), value);
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, true);
	});
	// 本例输入/预期：Value.Convert(Type.Boolean({ default: true }), value) 的预期为 2。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 25", () => {
		// 保存本次原始输入 2，与转换结果分开命名，便于检查它是否被保留。
		const value = 2;
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 2，本例结果 2；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean({ default: true }), value);
		// 按值/结构核对结果为 2，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, 2);
	});
	// 本例输入/预期：Value.Convert(Type.Boolean(), value) 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 26", () => {
		// 保存本次原始输入 true，与转换结果分开命名，便于检查它是否被保留。
		const value = true;
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 true，本例结果 true；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean(), value);
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, true);
	});
	// 本例输入/预期：Value.Convert(Type.Boolean(), value) 的预期为 false。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 27", () => {
		// 保存本次原始输入 false，与转换结果分开命名，便于检查它是否被保留。
		const value = false;
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 false，本例结果 false；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean(), value);
		// 按值/结构核对结果为 false，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, false);
	});
	// 本例输入/预期：Value.Convert(Type.Boolean(), value) 的预期为 {}。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 28", () => {
		// 保存本次原始输入 {}，与转换结果分开命名，便于检查它是否被保留。
		const value = {};
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 {}，本例结果 {}；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean(), value);
		// 按值/结构核对结果为 {}，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, {});
	});
	// 本例输入/预期：Value.Convert(Type.Boolean(), value) 的预期为 []。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 29", () => {
		// 保存空数组输入；as any[]只改变TS视图，不改变数组或验证其成员，原迁移用例的any声明保留。
		const value = [] as any[];
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 [] as any[]，本例结果 []；没有可用映射的原值保持，不读default兜底。
		const result = Value.Convert(Type.Boolean(), value);
		// 按值/结构核对结果为 []，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, []);
	});
	// ------------------------------------------------------------------
	// Coverage
	// ------------------------------------------------------------------
	// 本例输入/预期：Value.Convert(T, BigInt(0)) 的预期为 false。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 17", () => {
		// 构造boolean规则，按0/1和明确文字映射，不按任意非空值真值转换；default不作为转换失败兜底。
		const T = Type.Boolean();
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 BigInt(0)，本例结果 false；没有可用映射的原值保持，不读default兜底。
		const R = Value.Convert(T, BigInt(0));
		// 按值/结构核对结果为 false，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, false);
	});
	// 本例输入/预期：Value.Convert(T, BigInt(1)) 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 18", () => {
		// 构造boolean规则，按0/1和明确文字映射，不按任意非空值真值转换；default不作为转换失败兜底。
		const T = Type.Boolean();
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 BigInt(1)，本例结果 true；没有可用映射的原值保持，不读default兜底。
		const R = Value.Convert(T, BigInt(1));
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, true);
	});
	// 本例输入/预期：Value.Convert(T, BigInt(2)) 的预期为 BigInt(2)。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 19", () => {
		// 构造boolean规则，按0/1和明确文字映射，不按任意非空值真值转换；default不作为转换失败兜底。
		const T = Type.Boolean();
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 BigInt(2)，本例结果 BigInt(2)；没有可用映射的原值保持，不读default兜底。
		const R = Value.Convert(T, BigInt(2));
		// 按值/结构核对结果为 BigInt(2)，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, BigInt(2));
	});
	// 本例输入/预期：Value.Convert(T, true) 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 20", () => {
		// 构造boolean规则，按0/1和明确文字映射，不按任意非空值真值转换；default不作为转换失败兜底。
		const T = Type.Boolean();
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 true，本例结果 true；没有可用映射的原值保持，不读default兜底。
		const R = Value.Convert(T, true);
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, true);
	});
	// 本例输入/预期：Value.Convert(T, false) 的预期为 false。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 21", () => {
		// 构造boolean规则，按0/1和明确文字映射，不按任意非空值真值转换；default不作为转换失败兜底。
		const T = Type.Boolean();
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 false，本例结果 false；没有可用映射的原值保持，不读default兜底。
		const R = Value.Convert(T, false);
		// 按值/结构核对结果为 false，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, false);
	});
	// 本例输入/预期：Value.Convert(T, null) 的预期为 false。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 22", () => {
		// 构造boolean规则，按0/1和明确文字映射，不按任意非空值真值转换；default不作为转换失败兜底。
		const T = Type.Boolean();
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 null，本例结果 false；没有可用映射的原值保持，不读default兜底。
		const R = Value.Convert(T, null);
		// 按值/结构核对结果为 false，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, false);
	});
	// 本例输入/预期：Value.Convert(T, undefined) 的预期为 false。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 23", () => {
		// 构造boolean规则，按0/1和明确文字映射，不按任意非空值真值转换；default不作为转换失败兜底。
		const T = Type.Boolean();
		// 按布尔的0/1、真假文字及null/undefined映射尝试输入 undefined，本例结果 false；没有可用映射的原值保持，不读default兜底。
		const R = Value.Convert(T, undefined);
		// 按值/结构核对结果为 false，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, false);
	});
});

// Enum组按生成enum成员试转换：数字字符串可变成允许的数字成员，已有hello保留，world不能变合法时也保留供后续检查拒绝。
describe("Value.Convert.Enum", () => {
	// 本例输入/预期：Value.Convert(T, { x: "1" }) 的预期为 { x: 1 }；Value.Convert(T, { x: "2" }) 的预期为 { x: 2 }；Value.Convert(T, { x: "hello" }) 的预期为 { x: "hello" }；Value.Convert(T, { x: "world" }) 的预期为 { x: "world" }。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 1", () => {
		// 构造对象规则；具名属性默认必填，Optional除外，本行创建schema而非创建已验证用户对象。
		const T = Type.Object({
			// x字段使用这里的子规则；属性规则与用户值分开，Type.Object中未标Optional的具名字段默认必填。
			x: Type.Enum([1, 2, "hello"]),
		});
		// 按实际已有对象键转换输入 { x: "1" }，不补缺字段或删除未声明键；本例结果 { x: 1 }，保留的坏字段需另外check才能拒绝。
		const R0 = Value.Convert(T, { x: "1" });
		// 按实际已有对象键转换输入 { x: "2" }，不补缺字段或删除未声明键；本例结果 { x: 2 }，保留的坏字段需另外check才能拒绝。
		const R1 = Value.Convert(T, { x: "2" });
		// 按实际已有对象键转换输入 { x: "hello" }，不补缺字段或删除未声明键；本例结果 { x: "hello" }，保留的坏字段需另外check才能拒绝。
		const R2 = Value.Convert(T, { x: "hello" });
		// 按实际已有对象键转换输入 { x: "world" }，不补缺字段或删除未声明键；本例结果 { x: "world" }，保留的坏字段需另外check才能拒绝。
		const R3 = Value.Convert(T, { x: "world" });
		// 按值/结构核对结果为 { x: 1 }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R0, { x: 1 });
		// 按值/结构核对结果为 { x: 2 }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R1, { x: 2 });
		// 按值/结构核对结果为 { x: "hello" }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R2, { x: "hello" });
		// 按值/结构核对结果为 { x: "world" }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R3, { x: "world" });
	});
});

// Integer组先按第二轮数值规则转换，再Math.trunc向0截小数；静态类型仍number，不等同四舍五入或验证所有整数界限，原有精度字面量保留。
describe("Value.Convert.Integer", () => {
	// 本例输入/预期：Value.Convert(T, "3.14") 的预期为 3。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 1", () => {
		// 构造integer规则，第二轮可截去小数，TS本身没有整数基础类型。
		const T = Type.Integer();
		// 先按数值规则处理 "3.14"，成功再Math.trunc向0截小数，本例结果 3；无转换候选时仍保留原输入。
		const R = Value.Convert(T, "3.14");
		// 按值/结构核对结果为 3，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 3);
	});
	// 本例输入/预期：Value.Convert(T, "42") 的预期为 42。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 2", () => {
		// 构造integer规则，第二轮可截去小数，TS本身没有整数基础类型。
		const T = Type.Integer();
		// 先按数值规则处理 "42"，成功再Math.trunc向0截小数，本例结果 42；无转换候选时仍保留原输入。
		const R = Value.Convert(T, "42");
		// 按值/结构核对结果为 42，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 42);
	});
	// 本例输入/预期：Value.Convert(T, true) 的预期为 1。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 3", () => {
		// 构造integer规则，第二轮可截去小数，TS本身没有整数基础类型。
		const T = Type.Integer();
		// 先按数值规则处理 true，成功再Math.trunc向0截小数，本例结果 1；无转换候选时仍保留原输入。
		const R = Value.Convert(T, true);
		// 按值/结构核对结果为 1，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 1);
	});
	// 本例输入/预期：Value.Convert(T, false) 的预期为 0。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 4", () => {
		// 构造integer规则，第二轮可截去小数，TS本身没有整数基础类型。
		const T = Type.Integer();
		// 先按数值规则处理 false，成功再Math.trunc向0截小数，本例结果 0；无转换候选时仍保留原输入。
		const R = Value.Convert(T, false);
		// 按值/结构核对结果为 0，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 0);
	});
	// 本例输入/预期：Value.Convert(T, 3.14) 的预期为 3。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 5", () => {
		// 构造integer规则，第二轮可截去小数，TS本身没有整数基础类型。
		const T = Type.Integer();
		// 先按数值规则处理 3.14，成功再Math.trunc向0截小数，本例结果 3；无转换候选时仍保留原输入。
		const R = Value.Convert(T, 3.14);
		// 按值/结构核对结果为 3，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 3);
	});
	// ----------------------------------------------------------
	// Casts
	// ----------------------------------------------------------
	// 本例输入/预期：Value.Convert(Type.Integer(), value) 的预期为 "hello"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 6", () => {
		// 保存本次原始输入 "hello"，与转换结果分开命名，便于检查它是否被保留。
		const value = "hello";
		// 先按数值规则处理 "hello"，成功再Math.trunc向0截小数，本例结果 "hello"；无转换候选时仍保留原输入。
		const result = Value.Convert(Type.Integer(), value);
		// 按值/结构核对结果为 "hello"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, "hello");
	});
	// 本例输入/预期：Value.Convert(Type.Integer(), value) 的预期为 3。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 7", () => {
		// 保存本次原始输入 "3.14"，与转换结果分开命名，便于检查它是否被保留。
		const value = "3.14";
		// 先按数值规则处理 "3.14"，成功再Math.trunc向0截小数，本例结果 3；无转换候选时仍保留原输入。
		const result = Value.Convert(Type.Integer(), value);
		// 按值/结构核对结果为 3，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, 3);
	});
	// 本例输入/预期：Value.Convert(Type.Integer(), value) 的预期为 -0。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 8", () => {
		// 保存本次原始输入 "-0"，与转换结果分开命名，便于检查它是否被保留。
		const value = "-0";
		// 先按数值规则处理 "-0"，成功再Math.trunc向0截小数，本例结果 -0；无转换候选时仍保留原输入。
		const result = Value.Convert(Type.Integer(), value);
		// 按值/结构核对结果为 -0，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, -0);
	});
	// 本例输入/预期：Value.Convert(Type.Integer(), value) 的预期为 -100。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 9", () => {
		// 保存本次原始输入 "-100"，与转换结果分开命名，便于检查它是否被保留。
		const value = "-100";
		// 先按数值规则处理 "-100"，成功再Math.trunc向0截小数，本例结果 -100；无转换候选时仍保留原输入。
		const result = Value.Convert(Type.Integer(), value);
		// 按值/结构核对结果为 -100，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, -100);
	});
	// 本例输入/预期：Value.Convert(Type.Integer(), value) 的预期为 42。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 10", () => {
		// 保存本次原始输入 42，与转换结果分开命名，便于检查它是否被保留。
		const value = 42;
		// 先按数值规则处理 42，成功再Math.trunc向0截小数，本例结果 42；无转换候选时仍保留原输入。
		const result = Value.Convert(Type.Integer(), value);
		// 按值/结构核对结果为 42，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, 42);
	});
	// 本例输入/预期：Value.Convert(Type.Integer(), value) 的预期为 1。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 11", () => {
		// 保存本次原始输入 true，与转换结果分开命名，便于检查它是否被保留。
		const value = true;
		// 先按数值规则处理 true，成功再Math.trunc向0截小数，本例结果 1；无转换候选时仍保留原输入。
		const result = Value.Convert(Type.Integer(), value);
		// 按值/结构核对结果为 1，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, 1);
	});
	// 本例输入/预期：Value.Convert(Type.Integer(), value) 的预期为 0。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 12", () => {
		// 保存本次原始输入 false，与转换结果分开命名，便于检查它是否被保留。
		const value = false;
		// 先按数值规则处理 false，成功再Math.trunc向0截小数，本例结果 0；无转换候选时仍保留原输入。
		const result = Value.Convert(Type.Integer(), value);
		// 按值/结构核对结果为 0，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, 0);
	});
	// 本例输入/预期：Value.Convert(Type.Integer(), value) 的预期为 {}。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 13", () => {
		// 保存本次原始输入 {}，与转换结果分开命名，便于检查它是否被保留。
		const value = {};
		// 先按数值规则处理 {}，成功再Math.trunc向0截小数，本例结果 {}；无转换候选时仍保留原输入。
		const result = Value.Convert(Type.Integer(), value);
		// 按值/结构核对结果为 {}，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, {});
	});
	// 本例输入/预期：Value.Convert(Type.Integer(), value) 的预期为 []。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 14", () => {
		// 保存空数组输入；as any[]只改变TS视图，不改变数组或验证其成员，原迁移用例的any声明保留。
		const value = [] as any[];
		// 先按数值规则处理 [] as any[]，成功再Math.trunc向0截小数，本例结果 []；无转换候选时仍保留原输入。
		const result = Value.Convert(Type.Integer(), value);
		// 按值/结构核对结果为 []，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(result, []);
	});
	// ----------------------------------------------------------
	// https://github.com/sinclairzx81/typebox/issues/1147
	// ----------------------------------------------------------
	// 本例输入/预期：Value.Convert(Type.Integer(), N) 的预期为 N。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 15", () => {
		// N保存本次数值输入 1738213389080；number的表示受IEEE-754精度约束，不由integer规则恢复丢失精度。
		const N = 1738213389080;
		// 先按数值规则处理 1738213389080，成功再Math.trunc向0截小数，本例结果 N；无转换候选时仍保留原输入。
		const R = Value.Convert(Type.Integer(), N);
		// 按值/结构核对结果为 N，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, N);
	});
	// 本例输入/预期：Value.Convert(Type.Integer(), N) 的预期为 1738213389080。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 16", () => {
		// N保存本次数值输入 1738213389080.5555；number的表示受IEEE-754精度约束，不由integer规则恢复丢失精度。
		const N = 1738213389080.5555;
		// 先按数值规则处理 1738213389080.5555，成功再Math.trunc向0截小数，本例结果 1738213389080；无转换候选时仍保留原输入。
		const R = Value.Convert(Type.Integer(), N);
		// 按值/结构核对结果为 1738213389080，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 1738213389080);
	});
	// 本例输入/预期：Value.Convert(Type.Integer(), N) 的预期为 1738213389080。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 17", () => {
		// N保存数值文字输入 "1738213389080"，此时仍是字符串；转成number后受IEEE-754精度约束，不由integer规则恢复丢失精度。
		const N = "1738213389080";
		// 先按数值规则处理 "1738213389080"，成功再Math.trunc向0截小数，本例结果 1738213389080；无转换候选时仍保留原输入。
		const R = Value.Convert(Type.Integer(), N);
		// 按值/结构核对结果为 1738213389080，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 1738213389080);
	});
	// 本例输入/预期：Value.Convert(Type.Integer(), N) 的预期为 1738213389080。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 18", () => {
		// N保存数值文字输入 "1738213389080.555"，此时仍是字符串；转成number后受IEEE-754精度约束，不由integer规则恢复丢失精度。
		const N = "1738213389080.555";
		// 先按数值规则处理 "1738213389080.555"，成功再Math.trunc向0截小数，本例结果 1738213389080；无转换候选时仍保留原输入。
		const R = Value.Convert(Type.Integer(), N);
		// 按值/结构核对结果为 1738213389080，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 1738213389080);
	});
});

// Intersect组在本库按allOf成员顺序接力转换，不先将交叉规则求值合并；最后一个数字/对象冲突例的预期已刻意区别原TypeBox，转换结果也不保证满足整个交叉。
describe("Value.Convert.Intersect", () => {
	// 本例输入/预期：Value.Convert(T, { x: "1", y: "2" }) 的预期为 { x: 1, y: 2 }。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert intersected objects", () => {
		// 构造交叉规则；本库按生成allOf成员逐个接力转换，不运行原TypeBox Evaluate合并。
		const T = Type.Intersect([Type.Object({ x: Type.Number() }), Type.Object({ y: Type.Number() })]);
		// 输入 { x: "1", y: "2" } 按生成allOf成员先后接力转换；本例期望 { x: 1, y: 2 }，不是原TypeBox先Evaluate合并后的行为承诺。
		const R = Value.Convert(T, { x: "1", y: "2" });
		// 按值/结构核对结果为 { x: 1, y: 2 }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, { x: 1, y: 2 });
	});
	// ----------------------------------------------------------------
	// Intersection Complex
	// ----------------------------------------------------------------
	// 本例输入/预期：Value.Convert(T, { x: "1", y: "2" }) 的预期为 { x: 1, y: 2 }。无参回调只运行本地转换与断言，无业务返回。
	it("Should complex intersect 1", () => {
		// 构造交叉规则；本库按生成allOf成员逐个接力转换，不运行原TypeBox Evaluate合并。
		const T = Type.Intersect([Type.Number(), Type.Object({ x: Type.Number() }), Type.Object({ y: Type.Number() })]);
		// 输入 { x: "1", y: "2" } 按生成allOf成员先后接力转换；本例期望 { x: 1, y: 2 }，不是原TypeBox先Evaluate合并后的行为承诺。
		const R = Value.Convert(T, { x: "1", y: "2" });
		// 按值/结构核对结果为 { x: 1, y: 2 }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, { x: 1, y: 2 });
	});
	// 本例输入/预期：Value.Convert(T, { x: "3", y: "4" }) 的预期为 { x: 3, y: 4 }。无参回调只运行本地转换与断言，无业务返回。
	it("Should complex intersect 2", () => {
		// 构造交叉规则；本库按生成allOf成员逐个接力转换，不运行原TypeBox Evaluate合并。
		const T = Type.Intersect([Type.Object({ x: Type.Number() }), Type.Object({ y: Type.Number() }), Type.Number()]);
		// 输入 { x: "3", y: "4" } 按生成allOf成员先后接力转换；本例期望 { x: 3, y: 4 }，不是原TypeBox先Evaluate合并后的行为承诺。
		const R = Value.Convert(T, { x: "3", y: "4" });
		// 按值/结构核对结果为 { x: 3, y: 4 }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, { x: 3, y: 4 });
	});
	// Differs from TypeBox: allOf converts with each member in turn; TypeBox first merges an intersection into one object and drops the number.
	// 本例输入/预期：Value.Convert(T, "123") 的预期为 123。无参回调只运行本地转换与断言，无业务返回。
	it("Should complex intersect 3", () => {
		// 构造交叉规则；本库按生成allOf成员逐个接力转换，不运行原TypeBox Evaluate合并。
		const T = Type.Intersect([
			// 这一成员按原数组顺序参与联合/交叉规则；本库转换顺序保留，不先按原TypeBox Evaluate合并或给它重新排序。
			Type.Number(), // lost in Evaluate
			// 这一成员按原数组顺序参与联合/交叉规则；本库转换顺序保留，不先按原TypeBox Evaluate合并或给它重新排序。
			Type.Object({ x: Type.Number() }),
			// 这一成员按原数组顺序参与联合/交叉规则；本库转换顺序保留，不先按原TypeBox Evaluate合并或给它重新排序。
			Type.Object({ y: Type.Number() }),
		]);
		// 输入 "123" 按生成allOf成员先后接力转换；本例期望 123，不是原TypeBox先Evaluate合并后的行为承诺。
		const R = Value.Convert(T, "123");
		// 按值/结构核对结果为 123，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 123);
	});
});

// Literal组只在转换候选严格等于指定const时采用，否则保留原值。后面两组重复BigInt literal示例均跳过，不改英文重名，也不据此声称本库已经支持BigInt常量schema。
describe("Value.Convert.Literal", () => {
	// 本例输入/预期：Value.Convert(T, 1) 的预期为 "1"。无参回调只运行本地转换与断言，无业务返回。
	it("LiteralString: Should convert 1", () => {
		// 构造单值常量规则 Type.Literal("1")；只采用精确到该常量的转换，不自动校验所有后续结果。
		const T = Type.Literal("1");
		// 目标 Type.Literal("1") 对输入 1 尝试对应基础类型转换，只有严格等于const才采用；本例期望 "1"，否则可保留原值。
		const R = Value.Convert(T, 1);
		// 按值/结构核对结果为 "1"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "1");
	});
	// 本例输入/预期：Value.Convert(T, 2) 的预期为 2。无参回调只运行本地转换与断言，无业务返回。
	it("LiteralString: Should convert 2", () => {
		// 构造单值常量规则 Type.Literal("1")；只采用精确到该常量的转换，不自动校验所有后续结果。
		const T = Type.Literal("1");
		// 目标 Type.Literal("1") 对输入 2 尝试对应基础类型转换，只有严格等于const才采用；本例期望 2，否则可保留原值。
		const R = Value.Convert(T, 2);
		// 按值/结构核对结果为 2，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 2);
	});
	// 本例输入/预期：Value.Convert(T, true) 的预期为 "true"。无参回调只运行本地转换与断言，无业务返回。
	it("LiteralString: Should convert 3", () => {
		// 构造单值常量规则 Type.Literal("true")；只采用精确到该常量的转换，不自动校验所有后续结果。
		const T = Type.Literal("true");
		// 目标 Type.Literal("true") 对输入 true 尝试对应基础类型转换，只有严格等于const才采用；本例期望 "true"，否则可保留原值。
		const R = Value.Convert(T, true);
		// 按值/结构核对结果为 "true"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "true");
	});
	// ------------------------------------------------------------------
	// LiteralNumber
	// ------------------------------------------------------------------
	// 本例输入/预期：Value.Convert(T, "3.14") 的预期为 3.14。无参回调只运行本地转换与断言，无业务返回。
	it("LiteralNumber: Should convert 1", () => {
		// 构造单值常量规则 Type.Literal(3.14)；只采用精确到该常量的转换，不自动校验所有后续结果。
		const T = Type.Literal(3.14);
		// 目标 Type.Literal(3.14) 对输入 "3.14" 尝试对应基础类型转换，只有严格等于const才采用；本例期望 3.14，否则可保留原值。
		const R = Value.Convert(T, "3.14");
		// 按值/结构核对结果为 3.14，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 3.14);
	});
	// 本例输入/预期：Value.Convert(T, "3.15") 的预期为 "3.15"。无参回调只运行本地转换与断言，无业务返回。
	it("LiteralNumber: Should convert 2", () => {
		// 构造单值常量规则 Type.Literal(3.14)；只采用精确到该常量的转换，不自动校验所有后续结果。
		const T = Type.Literal(3.14);
		// 目标 Type.Literal(3.14) 对输入 "3.15" 尝试对应基础类型转换，只有严格等于const才采用；本例期望 "3.15"，否则可保留原值。
		const R = Value.Convert(T, "3.15");
		// 按值/结构核对结果为 "3.15"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "3.15");
	});
	// 本例输入/预期：Value.Convert(T, true) 的预期为 1。无参回调只运行本地转换与断言，无业务返回。
	it("LiteralNumber: Should convert 3", () => {
		// 构造单值常量规则 Type.Literal(1)；只采用精确到该常量的转换，不自动校验所有后续结果。
		const T = Type.Literal(1);
		// 目标 Type.Literal(1) 对输入 true 尝试对应基础类型转换，只有严格等于const才采用；本例期望 1，否则可保留原值。
		const R = Value.Convert(T, true);
		// 按值/结构核对结果为 1，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 1);
	});
	// 本例输入/预期：Value.Convert(T, false) 的预期为 0。无参回调只运行本地转换与断言，无业务返回。
	it("LiteralNumber: Should convert 4", () => {
		// 构造单值常量规则 Type.Literal(0)；只采用精确到该常量的转换，不自动校验所有后续结果。
		const T = Type.Literal(0);
		// 目标 Type.Literal(0) 对输入 false 尝试对应基础类型转换，只有严格等于const才采用；本例期望 0，否则可保留原值。
		const R = Value.Convert(T, false);
		// 按值/结构核对结果为 0，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 0);
	});
	// 本例输入/预期：Value.Convert(T, true) 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("LiteralNumber: Should convert 5", () => {
		// 构造单值常量规则 Type.Literal(2)；只采用精确到该常量的转换，不自动校验所有后续结果。
		const T = Type.Literal(2);
		// 目标 Type.Literal(2) 对输入 true 尝试对应基础类型转换，只有严格等于const才采用；本例期望 true，否则可保留原值。
		const R = Value.Convert(T, true);
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, true);
	});
	// ------------------------------------------------------------------
	// LiteralBoolean
	// ------------------------------------------------------------------
	// 本例输入/预期：Value.Convert(T, 3.14) 的预期为 3.14。无参回调只运行本地转换与断言，无业务返回。
	it("LiteralBoolean: Should convert 1", () => {
		// 构造单值常量规则 Type.Literal(true)；只采用精确到该常量的转换，不自动校验所有后续结果。
		const T = Type.Literal(true);
		// 目标 Type.Literal(true) 对输入 3.14 尝试对应基础类型转换，只有严格等于const才采用；本例期望 3.14，否则可保留原值。
		const R = Value.Convert(T, 3.14);
		// 按值/结构核对结果为 3.14，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 3.14);
	});
	// 本例输入/预期：Value.Convert(T, 1) 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("LiteralBoolean: Should convert 2", () => {
		// 构造单值常量规则 Type.Literal(true)；只采用精确到该常量的转换，不自动校验所有后续结果。
		const T = Type.Literal(true);
		// 目标 Type.Literal(true) 对输入 1 尝试对应基础类型转换，只有严格等于const才采用；本例期望 true，否则可保留原值。
		const R = Value.Convert(T, 1);
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, true);
	});
	// 本例输入/预期：Value.Convert(T, "true") 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("LiteralBoolean: Should convert 3", () => {
		// 构造单值常量规则 Type.Literal(true)；只采用精确到该常量的转换，不自动校验所有后续结果。
		const T = Type.Literal(true);
		// 目标 Type.Literal(true) 对输入 "true" 尝试对应基础类型转换，只有严格等于const才采用；本例期望 true，否则可保留原值。
		const R = Value.Convert(T, "true");
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, true);
	});
	// 本例输入/预期：Value.Convert(T, "false") 的预期为 false。无参回调只运行本地转换与断言，无业务返回。
	it("LiteralBoolean: Should convert 4", () => {
		// 构造单值常量规则 Type.Literal(false)；只采用精确到该常量的转换，不自动校验所有后续结果。
		const T = Type.Literal(false);
		// 目标 Type.Literal(false) 对输入 "false" 尝试对应基础类型转换，只有严格等于const才采用；本例期望 false，否则可保留原值。
		const R = Value.Convert(T, "false");
		// 按值/结构核对结果为 false，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, false);
	});
	// 本例输入/预期：Value.Convert(T, "1") 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("LiteralBoolean: Should convert 5", () => {
		// 构造单值常量规则 Type.Literal(true)；只采用精确到该常量的转换，不自动校验所有后续结果。
		const T = Type.Literal(true);
		// 目标 Type.Literal(true) 对输入 "1" 尝试对应基础类型转换，只有严格等于const才采用；本例期望 true，否则可保留原值。
		const R = Value.Convert(T, "1");
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, true);
	});
	// 本例输入/预期：Value.Convert(T, "0") 的预期为 false。无参回调只运行本地转换与断言，无业务返回。
	it("LiteralBoolean: Should convert 6", () => {
		// 构造单值常量规则 Type.Literal(false)；只采用精确到该常量的转换，不自动校验所有后续结果。
		const T = Type.Literal(false);
		// 目标 Type.Literal(false) 对输入 "0" 尝试对应基础类型转换，只有严格等于const才采用；本例期望 false，否则可保留原值。
		const R = Value.Convert(T, "0");
		// 按值/结构核对结果为 false，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, false);
	});
	// 本例输入/预期：Value.Convert(T, "2") 的预期为 "2"。无参回调只运行本地转换与断言，无业务返回。
	it("LiteralBoolean: Should convert 7", () => {
		// 构造单值常量规则 Type.Literal(false)；只采用精确到该常量的转换，不自动校验所有后续结果。
		const T = Type.Literal(false);
		// 目标 Type.Literal(false) 对输入 "2" 尝试对应基础类型转换，只有严格等于const才采用；本例期望 "2"，否则可保留原值。
		const R = Value.Convert(T, "2");
		// 按值/结构核对结果为 "2"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "2");
	});
	// ------------------------------------------------------------------
	// LiteralBigInt
	// ------------------------------------------------------------------
	// Skipped: the schema or the value has no JSON form.
	// 跳过示例：Value.Convert(T, 100n) 的预期为 100n。it.skip不执行回调，保留的预期不构成本库支持证明。
	it.skip("LiteralBigInt: Should convert 1", () => {
		// 未执行的回调正文：构造BigInt单值规则 Type.Literal(100n)；TypeBox能构造该schema，但本库没有BigInt目标类型转换分支，当前skip不验证其支持。
		const T = Type.Literal(100n);
		// 未执行的回调正文：保留上游对BigInt目标 Type.Literal(100n) 和输入 100n 的历史预期 100n；本库没有对应BigInt目标转换分支，此跳过回调不执行或证明这些转换。
		const R = Value.Convert(T, 100n);
		// 跳过的预期断言：按值/结构核对结果为 100n，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 100n);
	});
	// Skipped: the schema or the value has no JSON form.
	// 跳过示例：Value.Convert(T, 100) 的预期为 100n。it.skip不执行回调，保留的预期不构成本库支持证明。
	it.skip("LiteralBigInt: Should convert 2", () => {
		// 未执行的回调正文：构造BigInt单值规则 Type.Literal(100n)；TypeBox能构造该schema，但本库没有BigInt目标类型转换分支，当前skip不验证其支持。
		const T = Type.Literal(100n);
		// 未执行的回调正文：保留上游对BigInt目标 Type.Literal(100n) 和输入 100 的历史预期 100n；本库没有对应BigInt目标转换分支，此跳过回调不执行或证明这些转换。
		const R = Value.Convert(T, 100);
		// 跳过的预期断言：按值/结构核对结果为 100n，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 100n);
	});
	// Skipped: the schema or the value has no JSON form.
	// 跳过示例：Value.Convert(T, "true") 的预期为 1n。it.skip不执行回调，保留的预期不构成本库支持证明。
	it.skip("LiteralBigInt: Should convert 3", () => {
		// 未执行的回调正文：构造BigInt单值规则 Type.Literal(1n)；TypeBox能构造该schema，但本库没有BigInt目标类型转换分支，当前skip不验证其支持。
		const T = Type.Literal(1n);
		// 未执行的回调正文：保留上游对BigInt目标 Type.Literal(1n) 和输入 "true" 的历史预期 1n；本库没有对应BigInt目标转换分支，此跳过回调不执行或证明这些转换。
		const R = Value.Convert(T, "true");
		// 跳过的预期断言：按值/结构核对结果为 1n，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 1n);
	});
	// Skipped: the schema or the value has no JSON form.
	// 跳过示例：Value.Convert(T, "false") 的预期为 0n。it.skip不执行回调，保留的预期不构成本库支持证明。
	it.skip("LiteralBigInt: Should convert 4", () => {
		// 未执行的回调正文：构造BigInt单值规则 Type.Literal(0n)；TypeBox能构造该schema，但本库没有BigInt目标类型转换分支，当前skip不验证其支持。
		const T = Type.Literal(0n);
		// 未执行的回调正文：保留上游对BigInt目标 Type.Literal(0n) 和输入 "false" 的历史预期 0n；本库没有对应BigInt目标转换分支，此跳过回调不执行或证明这些转换。
		const R = Value.Convert(T, "false");
		// 跳过的预期断言：按值/结构核对结果为 0n，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 0n);
	});
	// Skipped: the schema or the value has no JSON form.
	// 跳过示例：Value.Convert(T, "1") 的预期为 1n。it.skip不执行回调，保留的预期不构成本库支持证明。
	it.skip("LiteralBigInt: Should convert 5", () => {
		// 未执行的回调正文：构造BigInt单值规则 Type.Literal(1n)；TypeBox能构造该schema，但本库没有BigInt目标类型转换分支，当前skip不验证其支持。
		const T = Type.Literal(1n);
		// 未执行的回调正文：保留上游对BigInt目标 Type.Literal(1n) 和输入 "1" 的历史预期 1n；本库没有对应BigInt目标转换分支，此跳过回调不执行或证明这些转换。
		const R = Value.Convert(T, "1");
		// 跳过的预期断言：按值/结构核对结果为 1n，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 1n);
	});
	// Skipped: the schema or the value has no JSON form.
	// 跳过示例：Value.Convert(T, "0") 的预期为 0n。it.skip不执行回调，保留的预期不构成本库支持证明。
	it.skip("LiteralBigInt: Should convert 6", () => {
		// 未执行的回调正文：构造BigInt单值规则 Type.Literal(0n)；TypeBox能构造该schema，但本库没有BigInt目标类型转换分支，当前skip不验证其支持。
		const T = Type.Literal(0n);
		// 未执行的回调正文：保留上游对BigInt目标 Type.Literal(0n) 和输入 "0" 的历史预期 0n；本库没有对应BigInt目标转换分支，此跳过回调不执行或证明这些转换。
		const R = Value.Convert(T, "0");
		// 跳过的预期断言：按值/结构核对结果为 0n，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 0n);
	});
	// Skipped: the schema or the value has no JSON form.
	// 跳过示例：Value.Convert(T, "2") 的预期为 "2"。it.skip不执行回调，保留的预期不构成本库支持证明。
	it.skip("LiteralBigInt: Should convert 7", () => {
		// 未执行的回调正文：构造BigInt单值规则 Type.Literal(100n)；TypeBox能构造该schema，但本库没有BigInt目标类型转换分支，当前skip不验证其支持。
		const T = Type.Literal(100n);
		// 未执行的回调正文：保留上游对BigInt目标 Type.Literal(100n) 和输入 "2" 的历史预期 "2"；本库没有对应BigInt目标转换分支，此跳过回调不执行或证明这些转换。
		const R = Value.Convert(T, "2");
		// 跳过的预期断言：按值/结构核对结果为 "2"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "2");
	});
	// ------------------------------------------------------------------
	// LiteralBigInt
	// ------------------------------------------------------------------
	// Skipped: the schema or the value has no JSON form.
	// 跳过示例：Value.Convert(T, 100n) 的预期为 100n。it.skip不执行回调，保留的预期不构成本库支持证明。
	it.skip("LiteralBigInt: Should convert 1", () => {
		// 未执行的回调正文：构造BigInt单值规则 Type.Literal(100n)；TypeBox能构造该schema，但本库没有BigInt目标类型转换分支，当前skip不验证其支持。
		const T = Type.Literal(100n);
		// 未执行的回调正文：保留上游对BigInt目标 Type.Literal(100n) 和输入 100n 的历史预期 100n；本库没有对应BigInt目标转换分支，此跳过回调不执行或证明这些转换。
		const R = Value.Convert(T, 100n);
		// 跳过的预期断言：按值/结构核对结果为 100n，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 100n);
	});
	// Skipped: the schema or the value has no JSON form.
	// 跳过示例：Value.Convert(T, 100) 的预期为 100n。it.skip不执行回调，保留的预期不构成本库支持证明。
	it.skip("LiteralBigInt: Should convert 2", () => {
		// 未执行的回调正文：构造BigInt单值规则 Type.Literal(100n)；TypeBox能构造该schema，但本库没有BigInt目标类型转换分支，当前skip不验证其支持。
		const T = Type.Literal(100n);
		// 未执行的回调正文：保留上游对BigInt目标 Type.Literal(100n) 和输入 100 的历史预期 100n；本库没有对应BigInt目标转换分支，此跳过回调不执行或证明这些转换。
		const R = Value.Convert(T, 100);
		// 跳过的预期断言：按值/结构核对结果为 100n，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 100n);
	});
	// Skipped: the schema or the value has no JSON form.
	// 跳过示例：Value.Convert(T, "true") 的预期为 1n。it.skip不执行回调，保留的预期不构成本库支持证明。
	it.skip("LiteralBigInt: Should convert 3", () => {
		// 未执行的回调正文：构造BigInt单值规则 Type.Literal(1n)；TypeBox能构造该schema，但本库没有BigInt目标类型转换分支，当前skip不验证其支持。
		const T = Type.Literal(1n);
		// 未执行的回调正文：保留上游对BigInt目标 Type.Literal(1n) 和输入 "true" 的历史预期 1n；本库没有对应BigInt目标转换分支，此跳过回调不执行或证明这些转换。
		const R = Value.Convert(T, "true");
		// 跳过的预期断言：按值/结构核对结果为 1n，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 1n);
	});
	// Skipped: the schema or the value has no JSON form.
	// 跳过示例：Value.Convert(T, "false") 的预期为 0n。it.skip不执行回调，保留的预期不构成本库支持证明。
	it.skip("LiteralBigInt: Should convert 4", () => {
		// 未执行的回调正文：构造BigInt单值规则 Type.Literal(0n)；TypeBox能构造该schema，但本库没有BigInt目标类型转换分支，当前skip不验证其支持。
		const T = Type.Literal(0n);
		// 未执行的回调正文：保留上游对BigInt目标 Type.Literal(0n) 和输入 "false" 的历史预期 0n；本库没有对应BigInt目标转换分支，此跳过回调不执行或证明这些转换。
		const R = Value.Convert(T, "false");
		// 跳过的预期断言：按值/结构核对结果为 0n，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 0n);
	});
	// Skipped: the schema or the value has no JSON form.
	// 跳过示例：Value.Convert(T, "1") 的预期为 1n。it.skip不执行回调，保留的预期不构成本库支持证明。
	it.skip("LiteralBigInt: Should convert 5", () => {
		// 未执行的回调正文：构造BigInt单值规则 Type.Literal(1n)；TypeBox能构造该schema，但本库没有BigInt目标类型转换分支，当前skip不验证其支持。
		const T = Type.Literal(1n);
		// 未执行的回调正文：保留上游对BigInt目标 Type.Literal(1n) 和输入 "1" 的历史预期 1n；本库没有对应BigInt目标转换分支，此跳过回调不执行或证明这些转换。
		const R = Value.Convert(T, "1");
		// 跳过的预期断言：按值/结构核对结果为 1n，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 1n);
	});
	// Skipped: the schema or the value has no JSON form.
	// 跳过示例：Value.Convert(T, "0") 的预期为 0n。it.skip不执行回调，保留的预期不构成本库支持证明。
	it.skip("LiteralBigInt: Should convert 6", () => {
		// 未执行的回调正文：构造BigInt单值规则 Type.Literal(0n)；TypeBox能构造该schema，但本库没有BigInt目标类型转换分支，当前skip不验证其支持。
		const T = Type.Literal(0n);
		// 未执行的回调正文：保留上游对BigInt目标 Type.Literal(0n) 和输入 "0" 的历史预期 0n；本库没有对应BigInt目标转换分支，此跳过回调不执行或证明这些转换。
		const R = Value.Convert(T, "0");
		// 跳过的预期断言：按值/结构核对结果为 0n，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 0n);
	});
	// Skipped: the schema or the value has no JSON form.
	// 跳过示例：Value.Convert(T, "2") 的预期为 "2"。it.skip不执行回调，保留的预期不构成本库支持证明。
	it.skip("LiteralBigInt: Should convert 7", () => {
		// 未执行的回调正文：构造BigInt单值规则 Type.Literal(100n)；TypeBox能构造该schema，但本库没有BigInt目标类型转换分支，当前skip不验证其支持。
		const T = Type.Literal(100n);
		// 未执行的回调正文：保留上游对BigInt目标 Type.Literal(100n) 和输入 "2" 的历史预期 "2"；本库没有对应BigInt目标转换分支，此跳过回调不执行或证明这些转换。
		const R = Value.Convert(T, "2");
		// 跳过的预期断言：按值/结构核对结果为 "2"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "2");
	});
});

// Never组只比较转换保留输入，不代表never规则验证通过；转换没有替任何值创造一个“合法never”。这里没有另调Check。
describe("Value.Convert.Never", () => {
	// 本例输入/预期：Value.Convert(T, true) 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("Should not 1", () => {
		// 构造Never规则，转换不改值不表示验证器会接受值。
		const T = Type.Never();
		// 输入 true 转换后仍为 true；Never没有可生成的合法值，保留输入不能理解为check会通过。
		const R = Value.Convert(T, true);
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, true);
	});
	// 本例输入/预期：Value.Convert(T, 42) 的预期为 42。无参回调只运行本地转换与断言，无业务返回。
	it("Should not 2", () => {
		// 构造Never规则，转换不改值不表示验证器会接受值。
		const T = Type.Never();
		// 输入 42 转换后仍为 42；Never没有可生成的合法值，保留输入不能理解为check会通过。
		const R = Value.Convert(T, 42);
		// 按值/结构核对结果为 42，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 42);
	});
	// 本例输入/预期：Value.Convert(T, "true") 的预期为 "true"。无参回调只运行本地转换与断言，无业务返回。
	it("Should not 3", () => {
		// 构造Never规则，转换不改值不表示验证器会接受值。
		const T = Type.Never();
		// 输入 "true" 转换后仍为 "true"；Never没有可生成的合法值，保留输入不能理解为check会通过。
		const R = Value.Convert(T, "true");
		// 按值/结构核对结果为 "true"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "true");
	});
});

// Null组列出null、零、false、空串及部分大小写文字到null的映射；nil/hello/true/非零值不能靠该规则转换时原样保留。Symbol例跳过，不是执行成功。
describe("Value.Convert.Null", () => {
	// 本例输入/预期：Value.Convert(T, "null") 的预期为 null。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 1", () => {
		// 构造null规则，转换零/false等明确候选，其他输入仍可能不合法。
		const T = Type.Null();
		// 按第二轮null映射处理 "null"，本例结果 null；只认规定的零/false/空值与文字，不把任意值都抹成null。
		const R = Value.Convert(T, "null");
		// 按值/结构核对结果为 null，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, null);
	});
	// 本例输入/预期：Value.Convert(T, "NULL") 的预期为 null。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 2", () => {
		// 构造null规则，转换零/false等明确候选，其他输入仍可能不合法。
		const T = Type.Null();
		// 按第二轮null映射处理 "NULL"，本例结果 null；只认规定的零/false/空值与文字，不把任意值都抹成null。
		const R = Value.Convert(T, "NULL");
		// 按值/结构核对结果为 null，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, null);
	});
	// 本例输入/预期：Value.Convert(T, "nil") 的预期为 "nil"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 3", () => {
		// 构造null规则，转换零/false等明确候选，其他输入仍可能不合法。
		const T = Type.Null();
		// 按第二轮null映射处理 "nil"，本例结果 "nil"；只认规定的零/false/空值与文字，不把任意值都抹成null。
		const R = Value.Convert(T, "nil");
		// 按值/结构核对结果为 "nil"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "nil");
	});
	// 本例输入/预期：Value.Convert(T, "undefined") 的预期为 null。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 4", () => {
		// 构造null规则，转换零/false等明确候选，其他输入仍可能不合法。
		const T = Type.Null();
		// 按第二轮null映射处理 "undefined"，本例结果 null；只认规定的零/false/空值与文字，不把任意值都抹成null。
		const R = Value.Convert(T, "undefined");
		// 按值/结构核对结果为 null，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, null);
	});
	// 本例输入/预期：Value.Convert(T, "hello") 的预期为 "hello"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 5", () => {
		// 构造null规则，转换零/false等明确候选，其他输入仍可能不合法。
		const T = Type.Null();
		// 按第二轮null映射处理 "hello"，本例结果 "hello"；只认规定的零/false/空值与文字，不把任意值都抹成null。
		const R = Value.Convert(T, "hello");
		// 按值/结构核对结果为 "hello"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "hello");
	});
	// 本例输入/预期：Value.Convert(T, null) 的预期为 null。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 6", () => {
		// 构造null规则，转换零/false等明确候选，其他输入仍可能不合法。
		const T = Type.Null();
		// 按第二轮null映射处理 null，本例结果 null；只认规定的零/false/空值与文字，不把任意值都抹成null。
		const R = Value.Convert(T, null);
		// 按值/结构核对结果为 null，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, null);
	});
	// 本例输入/预期：Value.Convert(T, 0) 的预期为 null。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 7", () => {
		// 构造null规则，转换零/false等明确候选，其他输入仍可能不合法。
		const T = Type.Null();
		// 按第二轮null映射处理 0，本例结果 null；只认规定的零/false/空值与文字，不把任意值都抹成null。
		const R = Value.Convert(T, 0);
		// 按值/结构核对结果为 null，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, null);
	});
	// 本例输入/预期：Value.Convert(T, false) 的预期为 null。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 8", () => {
		// 构造null规则，转换零/false等明确候选，其他输入仍可能不合法。
		const T = Type.Null();
		// 按第二轮null映射处理 false，本例结果 null；只认规定的零/false/空值与文字，不把任意值都抹成null。
		const R = Value.Convert(T, false);
		// 按值/结构核对结果为 null，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, null);
	});
	// 本例输入/预期：Value.Convert(T, "") 的预期为 null。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 9", () => {
		// 构造null规则，转换零/false等明确候选，其他输入仍可能不合法。
		const T = Type.Null();
		// 按第二轮null映射处理 ""，本例结果 null；只认规定的零/false/空值与文字，不把任意值都抹成null。
		const R = Value.Convert(T, "");
		// 按值/结构核对结果为 null，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, null);
	});
	// ------------------------------------------------------------------
	// Coverage
	// ------------------------------------------------------------------
	// 本例输入/预期：Value.Convert(T, BigInt(0)) 的预期为 null。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 10", () => {
		// 构造null规则，转换零/false等明确候选，其他输入仍可能不合法。
		const T = Type.Null();
		// 按第二轮null映射处理 BigInt(0)，本例结果 null；只认规定的零/false/空值与文字，不把任意值都抹成null。
		const R = Value.Convert(T, BigInt(0));
		// 按值/结构核对结果为 null，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, null);
	});
	// 本例输入/预期：Value.Convert(T, BigInt(1)) 的预期为 BigInt(1)。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 11", () => {
		// 构造null规则，转换零/false等明确候选，其他输入仍可能不合法。
		const T = Type.Null();
		// 按第二轮null映射处理 BigInt(1)，本例结果 BigInt(1)；只认规定的零/false/空值与文字，不把任意值都抹成null。
		const R = Value.Convert(T, BigInt(1));
		// 按值/结构核对结果为 BigInt(1)，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, BigInt(1));
	});
	// 本例输入/预期：Value.Convert(T, false) 的预期为 null。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 12", () => {
		// 构造null规则，转换零/false等明确候选，其他输入仍可能不合法。
		const T = Type.Null();
		// 按第二轮null映射处理 false，本例结果 null；只认规定的零/false/空值与文字，不把任意值都抹成null。
		const R = Value.Convert(T, false);
		// 按值/结构核对结果为 null，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, null);
	});
	// 本例输入/预期：Value.Convert(T, true) 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 13", () => {
		// 构造null规则，转换零/false等明确候选，其他输入仍可能不合法。
		const T = Type.Null();
		// 按第二轮null映射处理 true，本例结果 true；只认规定的零/false/空值与文字，不把任意值都抹成null。
		const R = Value.Convert(T, true);
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, true);
	});
	// 本例输入/预期：Value.Convert(T, 0) 的预期为 null。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 14", () => {
		// 构造null规则，转换零/false等明确候选，其他输入仍可能不合法。
		const T = Type.Null();
		// 按第二轮null映射处理 0，本例结果 null；只认规定的零/false/空值与文字，不把任意值都抹成null。
		const R = Value.Convert(T, 0);
		// 按值/结构核对结果为 null，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, null);
	});
	// 本例输入/预期：Value.Convert(T, 1) 的预期为 1。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 15", () => {
		// 构造null规则，转换零/false等明确候选，其他输入仍可能不合法。
		const T = Type.Null();
		// 按第二轮null映射处理 1，本例结果 1；只认规定的零/false/空值与文字，不把任意值都抹成null。
		const R = Value.Convert(T, 1);
		// 按值/结构核对结果为 1，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 1);
	});
	// 本例输入/预期：Value.Convert(T, null) 的预期为 null。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 16", () => {
		// 构造null规则，转换零/false等明确候选，其他输入仍可能不合法。
		const T = Type.Null();
		// 按第二轮null映射处理 null，本例结果 null；只认规定的零/false/空值与文字，不把任意值都抹成null。
		const R = Value.Convert(T, null);
		// 按值/结构核对结果为 null，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, null);
	});
	// 本例输入/预期：Value.Convert(T, undefined) 的预期为 null。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 17", () => {
		// 构造null规则，转换零/false等明确候选，其他输入仍可能不合法。
		const T = Type.Null();
		// 按第二轮null映射处理 undefined，本例结果 null；只认规定的零/false/空值与文字，不把任意值都抹成null。
		const R = Value.Convert(T, undefined);
		// 按值/结构核对结果为 null，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, null);
	});
	// Skipped: the schema or the value has no JSON form.
	// 跳过示例：Value.Convert(T, S) 的预期为 S。it.skip不执行回调，保留的预期不构成本库支持证明。
	it.skip("Should Convert 18", () => {
		// 未执行的回调正文：构造null规则，转换零/false等明确候选，其他输入仍可能不合法。
		const T = Type.Null();
		// 未执行的回调正文：创建Symbol输入 Symbol("hello")；当前跳过回调不会执行它，不是字符串数据或已验证JSON能力。
		const S = Symbol("hello");
		// 未执行的回调正文：按第二轮null映射处理 Symbol("hello")，本例结果 S；只认规定的零/false/空值与文字，不把任意值都抹成null。
		const R = Value.Convert(T, S);
		// 跳过的预期断言：按值/结构核对结果为 S，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, S);
	});
});

// Number组展示有限数值转换、true/false与null/undefined到数值、安全范围内BigInt及n后缀文字；无候选保持原值。它不证明任意十进制精度保真，也不自动补default。
describe("Value.Convert.Number", () => {
	// 本例输入/预期：Value.Convert(T, "3.14") 的预期为 3.14。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 1", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 "3.14"，本例结果 3.14；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, "3.14");
		// 按值/结构核对结果为 3.14，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 3.14);
	});
	// 本例输入/预期：Value.Convert(T, "42") 的预期为 42。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 2", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 "42"，本例结果 42；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, "42");
		// 按值/结构核对结果为 42，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 42);
	});
	// 本例输入/预期：Value.Convert(T, true) 的预期为 1。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 3", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 true，本例结果 1；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, true);
		// 按值/结构核对结果为 1，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 1);
	});
	// 本例输入/预期：Value.Convert(T, false) 的预期为 0。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 4", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 false，本例结果 0；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, false);
		// 按值/结构核对结果为 0，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 0);
	});
	// 本例输入/预期：Value.Convert(T, 3.14) 的预期为 3.14。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 5", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 3.14，本例结果 3.14；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, 3.14);
		// 按值/结构核对结果为 3.14，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 3.14);
	});
	// ----------------------------------------------------------
	// Casts
	// ----------------------------------------------------------
	// 本例输入/预期：Value.Convert(T, "hello") 的预期为 "hello"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 6", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 "hello"，本例结果 "hello"；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, "hello");
		// 按值/结构核对结果为 "hello"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "hello");
	});
	// 本例输入/预期：Value.Convert(T, "3.14") 的预期为 3.14。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 7", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 "3.14"，本例结果 3.14；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, "3.14");
		// 按值/结构核对结果为 3.14，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 3.14);
	});
	// 本例输入/预期：Value.Convert(T, "-0") 的预期为 -0。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 8", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 "-0"，本例结果 -0；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, "-0");
		// 按值/结构核对结果为 -0，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, -0);
	});
	// 本例输入/预期：Value.Convert(T, "-100") 的预期为 -100。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 9", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 "-100"，本例结果 -100；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, "-100");
		// 按值/结构核对结果为 -100，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, -100);
	});
	// 本例输入/预期：Value.Convert(T, 42) 的预期为 42。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 10", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 42，本例结果 42；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, 42);
		// 按值/结构核对结果为 42，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 42);
	});
	// 本例输入/预期：Value.Convert(T, true) 的预期为 1。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 11", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 true，本例结果 1；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, true);
		// 按值/结构核对结果为 1，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 1);
	});
	// 本例输入/预期：Value.Convert(T, false) 的预期为 0。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 12", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 false，本例结果 0；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, false);
		// 按值/结构核对结果为 0，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 0);
	});
	// 本例输入/预期：Value.Convert(T, {}) 的预期为 {}。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 13", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 {}，本例结果 {}；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, {});
		// 按值/结构核对结果为 {}，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, {});
	});
	// 本例输入/预期：Value.Convert(T, []) 的预期为 []。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 14", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 []，本例结果 []；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, []);
		// 按值/结构核对结果为 []，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, []);
	});
	// ------------------------------------------------------------------
	// Coverage
	// ------------------------------------------------------------------
	// 本例输入/预期：Value.Convert(T, BigInt(0)) 的预期为 0。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 10", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 BigInt(0)，本例结果 0；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, BigInt(0));
		// 按值/结构核对结果为 0，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 0);
	});
	// 本例输入/预期：Value.Convert(T, BigInt(10000000000000000000000000000000000000000000000000000)) 的预期为 BigInt(10000000000000000000000000000000000000000000000000000)。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 11", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 BigInt(10000000000000000000000000000000000000000000000000000)，本例结果 BigInt(10000000000000000000000000000000000000000000000000000)；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。 此处BigInt接收的是先求值的number字面量，不能把保留此表达式的结果说成原十进制任意精度验证。
		const R = Value.Convert(T, BigInt(10000000000000000000000000000000000000000000000000000));
		// 按值/结构核对结果为 BigInt(10000000000000000000000000000000000000000000000000000)，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, BigInt(10000000000000000000000000000000000000000000000000000));
	});
	// 本例输入/预期：Value.Convert(T, null) 的预期为 0。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 12", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 null，本例结果 0；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, null);
		// 按值/结构核对结果为 0，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 0);
	});
	// 本例输入/预期：Value.Convert(T, "false") 的预期为 0。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 13", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 "false"，本例结果 0；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, "false");
		// 按值/结构核对结果为 0，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 0);
	});
	// 本例输入/预期：Value.Convert(T, "true") 的预期为 1。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 14", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 "true"，本例结果 1；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, "true");
		// 按值/结构核对结果为 1，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 1);
	});
	// 本例输入/预期：Value.Convert(T, "123") 的预期为 123。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 15", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 "123"，本例结果 123；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, "123");
		// 按值/结构核对结果为 123，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 123);
	});
	// 本例输入/预期：Value.Convert(T, "123.456") 的预期为 123.456。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 16", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 "123.456"，本例结果 123.456；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, "123.456");
		// 按值/结构核对结果为 123.456，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 123.456);
	});
	// 本例输入/预期：Value.Convert(T, "123.456") 的预期为 123.456。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 17", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 "123.456"，本例结果 123.456；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, "123.456");
		// 按值/结构核对结果为 123.456，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 123.456);
	});
	// 本例输入/预期：Value.Convert(T, "123n") 的预期为 123。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 18", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 "123n"，本例结果 123；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, "123n");
		// 按值/结构核对结果为 123，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 123);
	});
	// 本例输入/预期：Value.Convert(T, undefined) 的预期为 0。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 19", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 undefined，本例结果 0；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, undefined);
		// 按值/结构核对结果为 0，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 0);
	});
	// 本例输入/预期：Value.Convert(T, `90071992547409910n`) 的预期为 "90071992547409910n"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 20", () => {
		// 构造number规则，允许有限数值转换；最终有效性仍需独立Check。
		const T = Type.Number();
		// 按第二轮数值规则处理 `90071992547409910n`，本例结果 "90071992547409910n"；可接真假文字/空值等明确映射，无法形成有限数值或超安全范围BigInt时保留。
		const R = Value.Convert(T, `90071992547409910n`); // trailing 0 too large
		// 按值/结构核对结果为 "90071992547409910n"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "90071992547409910n");
	});
});

// Object组递归实际已有的具名/额外字段，不自动创建缺失必填字段；可选undefined在这里保留。与上游可原地修改的转换API不同，本库变化路径复制；本组结构相等断言本身不逐例验证引用隔离。
describe("Value.Convert.Object", () => {
	// 本例输入/预期：Value.Convert(T, { x: "42", y: "true", z: "hello" }) 的预期为 { x: 42, y: true, z: "hello" }。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 1", () => {
		// 构造对象规则；具名属性默认必填，Optional除外，本行创建schema而非创建已验证用户对象。
		const T = Type.Object({
			// x字段使用这里的子规则；属性规则与用户值分开，Type.Object中未标Optional的具名字段默认必填。
			x: Type.Number(),
			// y字段使用这里的子规则；属性规则与用户值分开，Type.Object中未标Optional的具名字段默认必填。
			y: Type.Boolean(),
			// z字段使用这里的子规则；属性规则与用户值分开，Type.Object中未标Optional的具名字段默认必填。
			z: Type.Boolean(),
		});
		// 按实际已有对象键转换输入 { x: "42", y: "true", z: "hello" }，不补缺字段或删除未声明键；本例结果 { x: 42, y: true, z: "hello" }，保留的坏字段需另外check才能拒绝。
		const R = Value.Convert(T, { x: "42", y: "true", z: "hello" });
		// 按值/结构核对结果为 { x: 42, y: true, z: "hello" }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, { x: 42, y: true, z: "hello" });
	});
	// 本例输入/预期：Value.Convert(T, { x: "42", y: "true", z: "hello" }) 的预期为 { x: 42, y: true, z: "hello" }。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 2", () => {
		// 构造对象规则；具名属性默认必填，Optional除外，本行创建schema而非创建已验证用户对象。
		const T = Type.Object({
			// x字段使用这里的子规则；属性规则与用户值分开，Type.Object中未标Optional的具名字段默认必填。
			x: Type.Number(),
			// y字段使用这里的子规则；属性规则与用户值分开，Type.Object中未标Optional的具名字段默认必填。
			y: Type.Boolean(),
		});
		// 按实际已有对象键转换输入 { x: "42", y: "true", z: "hello" }，不补缺字段或删除未声明键；本例结果 { x: 42, y: true, z: "hello" }，保留的坏字段需另外check才能拒绝。
		const R = Value.Convert(T, { x: "42", y: "true", z: "hello" });
		// 按值/结构核对结果为 { x: 42, y: true, z: "hello" }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, { x: 42, y: true, z: "hello" });
	});
	// 本例输入/预期：Value.Convert(T, {}) 的预期为 {}。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 3", () => {
		// 构造对象规则；具名属性默认必填，Optional除外，本行创建schema而非创建已验证用户对象。
		const T = Type.Object({ x: Type.Number() });
		// 按实际已有对象键转换输入 {}，不补缺字段或删除未声明键；本例结果 {}，保留的坏字段需另外check才能拒绝。
		const R = Value.Convert(T, {});
		// 按值/结构核对结果为 {}，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, {});
	});
	// 本例输入/预期：Value.Convert(T, { x: "1", y: 0 }) 的预期为 { x: 1, y: null }。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 4", () => {
		// 构造对象规则；具名属性默认必填，Optional除外，本行创建schema而非创建已验证用户对象。
		const T = Type.Object(
			// Type.Object的第一个参数声明x为必填数值字段；这是规则表，后面另一个参数才配置额外字段规则。
			{ x: Type.Number() },
			{
				// 对未被具名/模式规则匹配的额外键应用此子规则，不自动删除这些键。
				additionalProperties: Type.Null(),
			},
		);
		// 按实际已有对象键转换输入 { x: "1", y: 0 }，不补缺字段或删除未声明键；本例结果 { x: 1, y: null }，保留的坏字段需另外check才能拒绝。
		const R = Value.Convert(T, { x: "1", y: 0 });
		// 按值/结构核对结果为 { x: 1, y: null }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, { x: 1, y: null });
	});
	// ------------------------------------------------------------------
	// IsOptionalUndefined
	//
	// https://github.com/sinclairzx81/typebox/issues/1336#issuecomment-3312808962
	// ------------------------------------------------------------------
	// 本例输入/预期：Value.Convert(T, { x: 1 }) 的预期为 { x: 1 }。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 5", () => {
		// 构造对象规则；具名属性默认必填，Optional除外，本行创建schema而非创建已验证用户对象。
		const T = Type.Object({ x: Type.Optional(Type.Number()) });
		// 按实际已有对象键转换输入 { x: 1 }，不补缺字段或删除未声明键；本例结果 { x: 1 }，保留的坏字段需另外check才能拒绝。
		const R = Value.Convert(T, { x: 1 });
		// 按值/结构核对结果为 { x: 1 }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, { x: 1 });
	});
	// 本例输入/预期：Value.Convert(T, { x: "1" }) 的预期为 { x: 1 }。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 6", () => {
		// 构造对象规则；具名属性默认必填，Optional除外，本行创建schema而非创建已验证用户对象。
		const T = Type.Object({ x: Type.Optional(Type.Number()) });
		// 按实际已有对象键转换输入 { x: "1" }，不补缺字段或删除未声明键；本例结果 { x: 1 }，保留的坏字段需另外check才能拒绝。
		const R = Value.Convert(T, { x: "1" });
		// 按值/结构核对结果为 { x: 1 }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, { x: 1 });
	});
	// 本例输入/预期：Value.Convert(T, { x: undefined }) 的预期为 { x: undefined }。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 7", () => {
		// 构造对象规则；具名属性默认必填，Optional除外，本行创建schema而非创建已验证用户对象。
		const T = Type.Object({ x: Type.Optional(Type.Number()) });
		// 按实际已有对象键转换输入 { x: undefined }，不补缺字段或删除未声明键；本例结果 { x: undefined }，保留的坏字段需另外check才能拒绝。
		const R = Value.Convert(T, { x: undefined });
		// 按值/结构核对结果为 { x: undefined }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, { x: undefined });
	});
});

// Record组按TypeBox生成的patternProperties转换字典值，未命中模式才交额外规则；与null联合时先保留本来可接受的值，不把数组误作对象字典。
describe("Value.Convert.Record", () => {
	// 本例输入/预期：Value.Convert(T, { x: "42", y: "24", z: "hello" }) 的预期为 { x: 42, y: 24, z: "hello" }。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 1", () => {
		// 构造字典规则 Type.Record(Type.String(), Type.Number())；生成键名模式与值规则，匹配模式的键不走additionalProperties。
		const T = Type.Record(Type.String(), Type.Number());
		// 按生成的键模式/额外规则处理 { x: "42", y: "24", z: "hello" }，字典值分别转换；本例结果 { x: 42, y: 24, z: "hello" }，不将数组当普通字典逐键改写。
		const R = Value.Convert(T, { x: "42", y: "24", z: "hello" });
		// 按值/结构核对结果为 { x: 42, y: 24, z: "hello" }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, { x: 42, y: 24, z: "hello" });
	});
	// ----------------------------------------------------------------
	// https://github.com/sinclairzx81/typebox/issues/930
	// ----------------------------------------------------------------
	// 本例输入/预期：Value.Convert(T, {}) 的预期为 {}。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 2", () => {
		// 构造有序联合规则 Type.Union([Type.Null(), Type.Record(Type.Number(), Type.Any())])；候选顺序会影响需要转换的值，不强改本来已合法的值。
		const T = Type.Union([Type.Null(), Type.Record(Type.Number(), Type.Any())]);
		// 输入 {} 先查有没有原样可接受支，否则依序试转换并验整体联合；本例结果 {}，顺序不是最小修改评分。
		const R = Value.Convert(T, {});
		// 按值/结构核对结果为 {}，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, {});
	});
	// 本例输入/预期：Value.Convert(T, {}) 的预期为 {}。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 3", () => {
		// 构造有序联合规则 Type.Union([Type.Record(Type.Number(), Type.Any()), Type.Null()])；候选顺序会影响需要转换的值，不强改本来已合法的值。
		const T = Type.Union([Type.Record(Type.Number(), Type.Any()), Type.Null()]);
		// 输入 {} 先查有没有原样可接受支，否则依序试转换并验整体联合；本例结果 {}，顺序不是最小修改评分。
		const R = Value.Convert(T, {});
		// 按值/结构核对结果为 {}，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, {});
	});
	// 本例输入/预期：Value.Convert(T, null) 的预期为 null。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 4", () => {
		// 构造有序联合规则 Type.Union([Type.Null(), Type.Record(Type.Number(), Type.Any())])；候选顺序会影响需要转换的值，不强改本来已合法的值。
		const T = Type.Union([Type.Null(), Type.Record(Type.Number(), Type.Any())]);
		// 输入 null 先查有没有原样可接受支，否则依序试转换并验整体联合；本例结果 null，顺序不是最小修改评分。
		const R = Value.Convert(T, null);
		// 按值/结构核对结果为 null，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, null);
	});
	// 本例输入/预期：Value.Convert(T, null) 的预期为 null。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 5", () => {
		// 构造有序联合规则 Type.Union([Type.Record(Type.Number(), Type.Any()), Type.Null()])；候选顺序会影响需要转换的值，不强改本来已合法的值。
		const T = Type.Union([Type.Record(Type.Number(), Type.Any()), Type.Null()]);
		// 输入 null 先查有没有原样可接受支，否则依序试转换并验整体联合；本例结果 null，顺序不是最小修改评分。
		const R = Value.Convert(T, null);
		// 按值/结构核对结果为 null，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, null);
	});
	// 本例输入/预期：Value.Convert(T, "NULL") 的预期为 null。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 6", () => {
		// 构造有序联合规则 Type.Union([Type.Null(), Type.Record(Type.Number(), Type.Any())])；候选顺序会影响需要转换的值，不强改本来已合法的值。
		const T = Type.Union([Type.Null(), Type.Record(Type.Number(), Type.Any())]);
		// 输入 "NULL" 先查有没有原样可接受支，否则依序试转换并验整体联合；本例结果 null，顺序不是最小修改评分。
		const R = Value.Convert(T, "NULL");
		// 按值/结构核对结果为 null，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, null);
	});
	// 本例输入/预期：Value.Convert(T, "NULL") 的预期为 null。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 7", () => {
		// 构造有序联合规则 Type.Union([Type.Record(Type.Number(), Type.Any()), Type.Null()])；候选顺序会影响需要转换的值，不强改本来已合法的值。
		const T = Type.Union([Type.Record(Type.Number(), Type.Any()), Type.Null()]);
		// 输入 "NULL" 先查有没有原样可接受支，否则依序试转换并验整体联合；本例结果 null，顺序不是最小修改评分。
		const R = Value.Convert(T, "NULL");
		// 按值/结构核对结果为 null，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, null);
	});
	// 本例输入/预期：Value.Convert(T, { "0": "1", x: 0 }) 的预期为 { "0": 1, x: null }。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 8", () => {
		// 构造字典规则 Type.Record(Type.Number(), Type.Number(), { additionalProperties: Type.Null(), })；生成键名模式与值规则，匹配模式的键不走additionalProperties。
		const T = Type.Record(Type.Number(), Type.Number(), {
			// 对未被具名/模式规则匹配的额外键应用此子规则，不自动删除这些键。
			additionalProperties: Type.Null(),
		});
		// 按生成的键模式/额外规则处理 { "0": "1", x: 0 }，字典值分别转换；本例结果 { "0": 1, x: null }，不将数组当普通字典逐键改写。
		const R = Value.Convert(T, { "0": "1", x: 0 });
		// 按值/结构核对结果为 { "0": 1, x: null }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, { "0": 1, x: null });
	});
});

// String组把允许的数值、BigInt、布尔、null/undefined转成规定文字；null为四字符null，undefined为空串。普通对象/数组不被任意String强转。
describe("Value.Convert.String", () => {
	// 本例输入/预期：Value.Convert(T, 3.14) 的预期为 "3.14"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 1", () => {
		// 构造string规则，按允许的基础值生成文字，不随意调用对象toString。
		const T = Type.String();
		// 按第二轮字符串规则处理 3.14，结果 "3.14"；只转换允许的基础值，null文字和undefined空串分开，容器不任意String强转。
		const R = Value.Convert(T, 3.14);
		// 按值/结构核对结果为 "3.14"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "3.14");
	});
	// 本例输入/预期：Value.Convert(T, 3) 的预期为 "3"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 2", () => {
		// 构造string规则，按允许的基础值生成文字，不随意调用对象toString。
		const T = Type.String();
		// 按第二轮字符串规则处理 3，结果 "3"；只转换允许的基础值，null文字和undefined空串分开，容器不任意String强转。
		const R = Value.Convert(T, 3);
		// 按值/结构核对结果为 "3"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "3");
	});
	// 本例输入/预期：Value.Convert(T, true) 的预期为 "true"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 3", () => {
		// 构造string规则，按允许的基础值生成文字，不随意调用对象toString。
		const T = Type.String();
		// 按第二轮字符串规则处理 true，结果 "true"；只转换允许的基础值，null文字和undefined空串分开，容器不任意String强转。
		const R = Value.Convert(T, true);
		// 按值/结构核对结果为 "true"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "true");
	});
	// 本例输入/预期：Value.Convert(T, false) 的预期为 "false"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 4", () => {
		// 构造string规则，按允许的基础值生成文字，不随意调用对象toString。
		const T = Type.String();
		// 按第二轮字符串规则处理 false，结果 "false"；只转换允许的基础值，null文字和undefined空串分开，容器不任意String强转。
		const R = Value.Convert(T, false);
		// 按值/结构核对结果为 "false"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "false");
	});
	// 本例输入/预期：Value.Convert(T, BigInt(12345)) 的预期为 "12345"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 5", () => {
		// 构造string规则，按允许的基础值生成文字，不随意调用对象toString。
		const T = Type.String();
		// 按第二轮字符串规则处理 BigInt(12345)，结果 "12345"；只转换允许的基础值，null文字和undefined空串分开，容器不任意String强转。
		const R = Value.Convert(T, BigInt(12345));
		// 按值/结构核对结果为 "12345"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "12345");
	});
	// ----------------------------------------------------------
	// Casts
	// ----------------------------------------------------------
	// 本例输入/预期：Value.Convert(T, "hello") 的预期为 "hello"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 6", () => {
		// 构造string规则，按允许的基础值生成文字，不随意调用对象toString。
		const T = Type.String();
		// 按第二轮字符串规则处理 "hello"，结果 "hello"；只转换允许的基础值，null文字和undefined空串分开，容器不任意String强转。
		const R = Value.Convert(T, "hello");
		// 按值/结构核对结果为 "hello"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "hello");
	});
	// 本例输入/预期：Value.Convert(T, 42) 的预期为 "42"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 7", () => {
		// 构造string规则，按允许的基础值生成文字，不随意调用对象toString。
		const T = Type.String();
		// 按第二轮字符串规则处理 42，结果 "42"；只转换允许的基础值，null文字和undefined空串分开，容器不任意String强转。
		const R = Value.Convert(T, 42);
		// 按值/结构核对结果为 "42"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "42");
	});
	// 本例输入/预期：Value.Convert(T, 42n) 的预期为 "42"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 8", () => {
		// 构造string规则，按允许的基础值生成文字，不随意调用对象toString。
		const T = Type.String();
		// 按第二轮字符串规则处理 42n，结果 "42"；只转换允许的基础值，null文字和undefined空串分开，容器不任意String强转。
		const R = Value.Convert(T, 42n);
		// 按值/结构核对结果为 "42"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "42");
	});
	// 本例输入/预期：Value.Convert(T, true) 的预期为 "true"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 9", () => {
		// 构造string规则，按允许的基础值生成文字，不随意调用对象toString。
		const T = Type.String();
		// 按第二轮字符串规则处理 true，结果 "true"；只转换允许的基础值，null文字和undefined空串分开，容器不任意String强转。
		const R = Value.Convert(T, true);
		// 按值/结构核对结果为 "true"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "true");
	});
	// 本例输入/预期：Value.Convert(T, false) 的预期为 "false"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 10", () => {
		// 构造string规则，按允许的基础值生成文字，不随意调用对象toString。
		const T = Type.String();
		// 按第二轮字符串规则处理 false，结果 "false"；只转换允许的基础值，null文字和undefined空串分开，容器不任意String强转。
		const R = Value.Convert(T, false);
		// 按值/结构核对结果为 "false"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "false");
	});
	// 本例输入/预期：Value.Convert(T, {}) 的预期为 {}。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 11", () => {
		// 构造string规则，按允许的基础值生成文字，不随意调用对象toString。
		const T = Type.String();
		// 按第二轮字符串规则处理 {}，结果 {}；只转换允许的基础值，null文字和undefined空串分开，容器不任意String强转。
		const R = Value.Convert(T, {});
		// 按值/结构核对结果为 {}，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, {});
	});
	// 本例输入/预期：Value.Convert(T, []) 的预期为 []。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 12", () => {
		// 构造string规则，按允许的基础值生成文字，不随意调用对象toString。
		const T = Type.String();
		// 按第二轮字符串规则处理 []，结果 []；只转换允许的基础值，null文字和undefined空串分开，容器不任意String强转。
		const R = Value.Convert(T, []);
		// 按值/结构核对结果为 []，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, []);
	});
	// ------------------------------------------------------------------
	// Coverage
	// ------------------------------------------------------------------
	// 本例输入/预期：Value.Convert(T, null) 的预期为 "null"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 13", () => {
		// 构造string规则，按允许的基础值生成文字，不随意调用对象toString。
		const T = Type.String();
		// 按第二轮字符串规则处理 null，结果 "null"；只转换允许的基础值，null文字和undefined空串分开，容器不任意String强转。
		const R = Value.Convert(T, null);
		// 按值/结构核对结果为 "null"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "null");
	});
	// 本例输入/预期：Value.Convert(T, undefined) 的预期为 ""。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 14", () => {
		// 构造string规则，按允许的基础值生成文字，不随意调用对象toString。
		const T = Type.String();
		// 按第二轮字符串规则处理 undefined，结果 ""；只转换允许的基础值，null文字和undefined空串分开，容器不任意String强转。
		const R = Value.Convert(T, undefined);
		// 按值/结构核对结果为 ""，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "");
	});
});

// TemplateLiteral在本库只看生成的string+pattern结构进行第二轮string转换，不运行原TypeBox对有限模板的字面量联合求值；所以数字4也先转成字符串4，不能据此认为它已通过模式校验。
describe("Value.Convert.TemplateLiteral", () => {
	// Differs from TypeBox: a template literal is a string with a pattern in JSON Schema; TypeBox converts a finite one as a union of literals.
	// 本例输入/预期：Value.Convert(T, 1) 的预期为 "1"；Value.Convert(T, 2) 的预期为 "2"；Value.Convert(T, 3) 的预期为 "3"；Value.Convert(T, 4) 的预期为 "4"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 1", () => {
		// 构造模板规则 Type.TemplateLiteral("${1 | 2 | 3}")；文字中的${...}是TypeBox自己的模板语法，不是本文件JS插值。
		const T = Type.TemplateLiteral("${1 | 2 | 3}");
		// 输入 1 按生成string结构处理，本例得到 "1"；没有在转换时要求pattern已通过，有限模板不先Evaluate成字面量联合。
		const R0 = Value.Convert(T, 1);
		// 输入 2 按生成string结构处理，本例得到 "2"；没有在转换时要求pattern已通过，有限模板不先Evaluate成字面量联合。
		const R1 = Value.Convert(T, 2);
		// 输入 3 按生成string结构处理，本例得到 "3"；没有在转换时要求pattern已通过，有限模板不先Evaluate成字面量联合。
		const R2 = Value.Convert(T, 3);
		// 输入 4 按生成string结构处理，本例得到 "4"；没有在转换时要求pattern已通过，有限模板不先Evaluate成字面量联合。
		const R3 = Value.Convert(T, 4);
		// 按值/结构核对结果为 "1"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R0, "1");
		// 按值/结构核对结果为 "2"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R1, "2");
		// 按值/结构核对结果为 "3"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R2, "3");
		// 按值/结构核对结果为 "4"，不把转换输出相等混同为schema校验成功。 本例得到字符串4，仍不匹配只允许1/2/3的模板pattern。
		Assert.IsEqual(R3, "4");
	});
	// ------------------------------------------------------------------
	// https://github.com/sinclairzx81/typebox/issues/1510
	// ------------------------------------------------------------------
	// 本例输入/预期：Value.Convert(T, { test: "123b" }) 的预期为 { test: "123b" }。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 2", () => {
		// 构造对象规则；具名属性默认必填，Optional除外，本行创建schema而非创建已验证用户对象。
		const T = Type.Object({
			// test字段使用这里的子规则；属性规则与用户值分开，Type.Object中未标Optional的具名字段默认必填。
			test: Type.TemplateLiteral('${number}${"a"|"b"|"c"}'),
		});
		// 按实际已有对象键转换输入 { test: "123b" }，不补缺字段或删除未声明键；本例结果 { test: "123b" }，保留的坏字段需另外check才能拒绝。
		const R0 = Value.Convert(T, { test: "123b" });
		// 按值/结构核对结果为 { test: "123b" }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R0, { test: "123b" });
	});
});

// Tuple组只转换现有数组的指定位置，不包标量、不补缺项，也不删除多余项；少项/多项例只测转换输出，不能当作最终tuple校验通过。
describe("Value.Convert.Tuple", () => {
	// 本例输入/预期：Value.Convert(T, ["1", "true"]) 的预期为 [1, 1]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 1", () => {
		// 构造位置元组规则 Type.Tuple([Type.Number(), Type.Number()])；只转换已有数组项，不自动包标量、补项或裁多项。
		const T = Type.Tuple([Type.Number(), Type.Number()]);
		// 处理输入 ["1", "true"] 时仅转换实际数组的元组前缀位置，少项不补、多项不裁、非数组不包装；本例结果 [1, 1]。
		const R = Value.Convert(T, ["1", "true"]);
		// 按值/结构核对结果为 [1, 1]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [1, 1]);
	});
	// 本例输入/预期：Value.Convert(T, ["1"]) 的预期为 [1]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 2", () => {
		// 构造位置元组规则 Type.Tuple([Type.Number(), Type.Number()])；只转换已有数组项，不自动包标量、补项或裁多项。
		const T = Type.Tuple([Type.Number(), Type.Number()]);
		// 处理输入 ["1"] 时仅转换实际数组的元组前缀位置，少项不补、多项不裁、非数组不包装；本例结果 [1]。
		const R = Value.Convert(T, ["1"]);
		// 按值/结构核对结果为 [1]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [1]);
	});
	// 本例输入/预期：Value.Convert(T, ["1", "2", "3"]) 的预期为 [1, 2, "3"]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 3", () => {
		// 构造位置元组规则 Type.Tuple([Type.Number(), Type.Number()])；只转换已有数组项，不自动包标量、补项或裁多项。
		const T = Type.Tuple([Type.Number(), Type.Number()]);
		// 处理输入 ["1", "2", "3"] 时仅转换实际数组的元组前缀位置，少项不补、多项不裁、非数组不包装；本例结果 [1, 2, "3"]。
		const R = Value.Convert(T, ["1", "2", "3"]);
		// 按值/结构核对结果为 [1, 2, "3"]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [1, 2, "3"]);
	});
	// 本例输入/预期：Value.Convert(T, "not an array") 的预期为 "not an array"。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 4", () => {
		// 构造位置元组规则 Type.Tuple([Type.Number(), Type.Number()])；只转换已有数组项，不自动包标量、补项或裁多项。
		const T = Type.Tuple([Type.Number(), Type.Number()]);
		// 处理输入 "not an array" 时仅转换实际数组的元组前缀位置，少项不补、多项不裁、非数组不包装；本例结果 "not an array"。
		const R = Value.Convert(T, "not an array");
		// 按值/结构核对结果为 "not an array"，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, "not an array");
	});
	// 本例输入/预期：Value.Convert(T, 42) 的预期为 42。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 5", () => {
		// 构造位置元组规则 Type.Tuple([Type.Number(), Type.Number()])；只转换已有数组项，不自动包标量、补项或裁多项。
		const T = Type.Tuple([Type.Number(), Type.Number()]);
		// 处理输入 42 时仅转换实际数组的元组前缀位置，少项不补、多项不裁、非数组不包装；本例结果 42。
		const R = Value.Convert(T, 42);
		// 按值/结构核对结果为 42，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, 42);
	});
	// 本例输入/预期：Value.Convert(T, null) 的预期为 null。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 6", () => {
		// 构造位置元组规则 Type.Tuple([Type.Number(), Type.Number()])；只转换已有数组项，不自动包标量、补项或裁多项。
		const T = Type.Tuple([Type.Number(), Type.Number()]);
		// 处理输入 null 时仅转换实际数组的元组前缀位置，少项不补、多项不裁、非数组不包装；本例结果 null。
		const R = Value.Convert(T, null);
		// 按值/结构核对结果为 null，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, null);
	});
	// 本例输入/预期：Value.Convert(T, { 0: "1", 1: "2" }) 的预期为 { 0: "1", 1: "2" }。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 7", () => {
		// 构造位置元组规则 Type.Tuple([Type.Number(), Type.Number()])；只转换已有数组项，不自动包标量、补项或裁多项。
		const T = Type.Tuple([Type.Number(), Type.Number()]);
		// 处理输入 { 0: "1", 1: "2" } 时仅转换实际数组的元组前缀位置，少项不补、多项不裁、非数组不包装；本例结果 { 0: "1", 1: "2" }。
		const R = Value.Convert(T, { 0: "1", 1: "2" });
		// 按值/结构核对结果为 { 0: "1", 1: "2" }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, { 0: "1", 1: "2" });
	});
});

// Union组先保留已有任一支接受的值，否则按分支顺序试转换；本库候选还需通过整联合检查。已有合法字段可保持原类型，第一成功支不强制转换其他未声明字段。
describe("Value.Convert.Union", () => {
	// 本例输入/预期：Value.Convert(T, { x: "42" }) 的预期为 { x: 42 }；Value.Convert(T, { x: "null" }) 的预期为 { x: null }；Value.Convert(T, { x: "hello" }) 的预期为 { x: "hello" }。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 1", () => {
		// 构造对象规则；具名属性默认必填，Optional除外，本行创建schema而非创建已验证用户对象。
		const T = Type.Object({
			// x字段使用这里的子规则；属性规则与用户值分开，Type.Object中未标Optional的具名字段默认必填。
			x: Type.Union([Type.Number(), Type.Null()]),
		});
		// 按实际已有对象键转换输入 { x: "42" }，不补缺字段或删除未声明键；本例结果 { x: 42 }，保留的坏字段需另外check才能拒绝。
		const R0 = Value.Convert(T, { x: "42" });
		// 按实际已有对象键转换输入 { x: "null" }，不补缺字段或删除未声明键；本例结果 { x: null }，保留的坏字段需另外check才能拒绝。
		const R1 = Value.Convert(T, { x: "null" });
		// 按实际已有对象键转换输入 { x: "hello" }，不补缺字段或删除未声明键；本例结果 { x: "hello" }，保留的坏字段需另外check才能拒绝。
		const R2 = Value.Convert(T, { x: "hello" });
		// 按值/结构核对结果为 { x: 42 }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R0, { x: 42 });
		// 按值/结构核对结果为 { x: null }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R1, { x: null });
		// 按值/结构核对结果为 { x: "hello" }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R2, { x: "hello" });
	});
	// 本例输入/预期：Value.Convert(T, { x: "1" }) 的预期为 { x: true }。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 2", () => {
		// 构造对象规则；具名属性默认必填，Optional除外，本行创建schema而非创建已验证用户对象。
		const T = Type.Object({
			// x字段使用这里的子规则；属性规则与用户值分开，Type.Object中未标Optional的具名字段默认必填。
			x: Type.Union([Type.Boolean(), Type.Number()]),
		});
		// 按实际已有对象键转换输入 { x: "1" }，不补缺字段或删除未声明键；本例结果 { x: true }，保留的坏字段需另外check才能拒绝。
		const R = Value.Convert(T, { x: "1" });
		// 按值/结构核对结果为 { x: true }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, { x: true });
	});

	// ----------------------------------------------------------------
	// https://github.com/sinclairzx81/typebox/issues/787
	// ----------------------------------------------------------------
	// 本例输入/预期：Convert(T, { a: "1", c: "2" }) 的预期为 { a: 1, c: 2 }；Convert(T, { b: "1", c: "2" }) 的预期为 { b: 1, c: 2 }；Convert(T, { a: "1", b: "2", c: "3" }) 的预期为 { a: 1, b: "2", c: 3 }。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 3", () => {
		// 构造交叉规则；本库按生成allOf成员逐个接力转换，不运行原TypeBox Evaluate合并。
		const T = Type.Intersect([
			// 这一成员按原数组顺序参与联合/交叉规则；本库转换顺序保留，不先按原TypeBox Evaluate合并或给它重新排序。
			Type.Union([Type.Object({ a: Type.Number() }), Type.Object({ b: Type.Number() })]),
			// 这一成员按原数组顺序参与联合/交叉规则；本库转换顺序保留，不先按原TypeBox Evaluate合并或给它重新排序。
			Type.Object({ c: Type.Number() }),
		]);
		// 输入 { a: "1", c: "2" } 按生成allOf成员先后接力转换；本例期望 { a: 1, c: 2 }，不是原TypeBox先Evaluate合并后的行为承诺。
		const R0 = Convert(T, { a: "1", c: "2" });
		// 输入 { b: "1", c: "2" } 按生成allOf成员先后接力转换；本例期望 { b: 1, c: 2 }，不是原TypeBox先Evaluate合并后的行为承诺。
		const R1 = Convert(T, { b: "1", c: "2" });
		// 输入 { a: "1", b: "2", c: "3" } 按生成allOf成员先后接力转换；本例期望 { a: 1, b: "2", c: 3 }，不是原TypeBox先Evaluate合并后的行为承诺。
		const R2 = Convert(T, { a: "1", b: "2", c: "3" });
		// 按值/结构核对结果为 { a: 1, c: 2 }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R0, { a: 1, c: 2 });
		// 按值/结构核对结果为 { b: 1, c: 2 }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R1, { b: 1, c: 2 });
		// 按值/结构核对结果为 { a: 1, b: "2", c: 3 }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R2, { a: 1, b: "2", c: 3 }); // note: matching on first
	});
	// ----------------------------------------------------------------
	// https://github.com/sinclairzx81/typebox/issues/1295
	// ----------------------------------------------------------------
	// 本例输入/预期：Value.Convert(T, [{ type: "A", values: 1 }]) 的预期为 [{ type: "A", values: 1 }]。无参回调只运行本地转换与断言，无业务返回。
	it("Should guard against Array conversion in Object", () => {
		// 构造有序联合规则 Type.Union([ Type.Object({ type: Type.Literal("A"), values: Type.Union([Type.String(), Type.Number()]), }), Type.Object({ type: Type.Literal("B"), values: Type.String(), }), ])；候选顺序会影响需要转换的值，不强改本来已合法的值。
		const T = Type.Union([
			// 这一成员按原数组顺序参与联合/交叉规则；本库转换顺序保留，不先按原TypeBox Evaluate合并或给它重新排序。
			Type.Object({
				// type字段使用这里的子规则；属性规则与用户值分开，Type.Object中未标Optional的具名字段默认必填。
				type: Type.Literal("A"),
				// values字段使用这里的子规则；属性规则与用户值分开，Type.Object中未标Optional的具名字段默认必填。
				values: Type.Union([Type.String(), Type.Number()]),
			}),
			// 这一成员按原数组顺序参与联合/交叉规则；本库转换顺序保留，不先按原TypeBox Evaluate合并或给它重新排序。
			Type.Object({
				// type字段使用这里的子规则；属性规则与用户值分开，Type.Object中未标Optional的具名字段默认必填。
				type: Type.Literal("B"),
				// values字段使用这里的子规则；属性规则与用户值分开，Type.Object中未标Optional的具名字段默认必填。
				values: Type.String(),
			}),
		]);
		// 输入 [{ type: "A", values: 1 }] 先查有没有原样可接受支，否则依序试转换并验整体联合；本例结果 [{ type: "A", values: 1 }]，顺序不是最小修改评分。
		const converted = Value.Convert(T, [{ type: "A", values: 1 }]);
		// 按值/结构核对结果为 [{ type: "A", values: 1 }]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(converted, [{ type: "A", values: 1 }]);
	});
	// 本例输入/预期：Value.Convert(T, [{ type: "A", values: 1 }]) 的预期为 [{ type: "A", values: 1 }]。无参回调只运行本地转换与断言，无业务返回。
	it("Should guard against Array conversion in Record", () => {
		// 构造有序联合规则 Type.Union([ Type.Record(Type.String({ pattern: "^values$" }), Type.Union([Type.String(), Type.Number()])), Type.Record(Type.String({ pattern: "^type$" }), Type.Union([Type.String(), Type.Number()])), ])；候选顺序会影响需要转换的值，不强改本来已合法的值。
		const T = Type.Union([
			// 这一成员按原数组顺序参与联合/交叉规则；本库转换顺序保留，不先按原TypeBox Evaluate合并或给它重新排序。
			Type.Record(Type.String({ pattern: "^values$" }), Type.Union([Type.String(), Type.Number()])),
			// 这一成员按原数组顺序参与联合/交叉规则；本库转换顺序保留，不先按原TypeBox Evaluate合并或给它重新排序。
			Type.Record(Type.String({ pattern: "^type$" }), Type.Union([Type.String(), Type.Number()])),
		]);
		// 输入 [{ type: "A", values: 1 }] 先查有没有原样可接受支，否则依序试转换并验整体联合；本例结果 [{ type: "A", values: 1 }]，顺序不是最小修改评分。
		const converted = Value.Convert(T, [{ type: "A", values: 1 }]);
		// 按值/结构核对结果为 [{ type: "A", values: 1 }]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(converted, [{ type: "A", values: 1 }]);
	});
});

// Unknown组保留原输入内容，不添加类型转换；toEqual比较内容，不证明原对象引用、所有JS值支持范围或后续业务可直接访问unknown。
describe("Value.Convert.Unknown", () => {
	// 本例输入/预期：Value.Convert(T, V) 的预期为 V。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 1", () => {
		// 保存本次原始输入 null，与转换结果分开命名，便于检查它是否被保留。
		const V = null;
		// 构造Unknown规则，转换保留输入，unknown后续使用仍需收窄。
		const T = Type.Unknown();
		// Unknown不提供具体转换约束，输入 null 保留为 V；若为容器，这里后续只比较内容。
		const R = Value.Convert(T, V);
		// 按值/结构核对结果为 V，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, V);
	});
	// 本例输入/预期：Value.Convert(T, V) 的预期为 V。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 2", () => {
		// 保存本次原始输入 undefined，与转换结果分开命名，便于检查它是否被保留。
		const V = undefined;
		// 构造Unknown规则，转换保留输入，unknown后续使用仍需收窄。
		const T = Type.Unknown();
		// Unknown不提供具体转换约束，输入 undefined 保留为 V；若为容器，这里后续只比较内容。
		const R = Value.Convert(T, V);
		// 按值/结构核对结果为 V，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, V);
	});
	// 本例输入/预期：Value.Convert(T, V) 的预期为 V。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 3", () => {
		// 保存本次原始输入 "hello"，与转换结果分开命名，便于检查它是否被保留。
		const V = "hello";
		// 构造Unknown规则，转换保留输入，unknown后续使用仍需收窄。
		const T = Type.Unknown();
		// Unknown不提供具体转换约束，输入 "hello" 保留为 V；若为容器，这里后续只比较内容。
		const R = Value.Convert(T, V);
		// 按值/结构核对结果为 V，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, V);
	});
	// 本例输入/预期：Value.Convert(T, V) 的预期为 V。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 4", () => {
		// 保存本次原始输入 42，与转换结果分开命名，便于检查它是否被保留。
		const V = 42;
		// 构造Unknown规则，转换保留输入，unknown后续使用仍需收窄。
		const T = Type.Unknown();
		// Unknown不提供具体转换约束，输入 42 保留为 V；若为容器，这里后续只比较内容。
		const R = Value.Convert(T, V);
		// 按值/结构核对结果为 V，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, V);
	});
	// 本例输入/预期：Value.Convert(T, true) 的预期为 true。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 5", () => {
		// 构造Unknown规则，转换保留输入，unknown后续使用仍需收窄。
		const T = Type.Unknown();
		// Unknown不提供具体转换约束，输入 true 保留为 true；若为容器，这里后续只比较内容。
		const R = Value.Convert(T, true);
		// 按值/结构核对结果为 true，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, true);
	});
	// 本例输入/预期：Value.Convert(T, { x: 1 }) 的预期为 { x: 1 }。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 6", () => {
		// 构造Unknown规则，转换保留输入，unknown后续使用仍需收窄。
		const T = Type.Unknown();
		// Unknown不提供具体转换约束，输入 { x: 1 } 保留为 { x: 1 }；若为容器，这里后续只比较内容。
		const R = Value.Convert(T, { x: 1 });
		// 按值/结构核对结果为 { x: 1 }，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, { x: 1 });
	});
	// 本例输入/预期：Value.Convert(T, [1, 2, 3]) 的预期为 [1, 2, 3]。无参回调只运行本地转换与断言，无业务返回。
	it("Should Convert 7", () => {
		// 构造Unknown规则，转换保留输入，unknown后续使用仍需收窄。
		const T = Type.Unknown();
		// Unknown不提供具体转换约束，输入 [1, 2, 3] 保留为 [1, 2, 3]；若为容器，这里后续只比较内容。
		const R = Value.Convert(T, [1, 2, 3]);
		// 按值/结构核对结果为 [1, 2, 3]，不把转换输出相等混同为schema校验成功。
		Assert.IsEqual(R, [1, 2, 3]);
	});
});
