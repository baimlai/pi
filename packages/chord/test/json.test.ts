// 验证严格 JSON 检查与复制：既看值，也看别名、原型和属性描述符。
import { describe, expect, test } from "vitest";
import { copyJson, isJsonValue } from "../src/json.ts";

// 注册检查函数的运行时用例；输入故意包含 TS 能表示、严格 JSON 却不接受的值。
describe("isJsonValue", () => {
	// 无参数、不写外部状态；逐个传入合法/非法值。例如对象中的 undefined 不会自动被忽略。
	test("checks strict JSON without normalizing it", () => {
		// 嵌套数组中的有限数字、布尔和 null 都属于严格 JSON。
		expect(isJsonValue({ nested: [1, true, null] })).toBe(true);
		// 检查不采用 JSON.stringify 的“忽略 undefined 字段”规则。
		expect(isJsonValue({ omitted: undefined })).toBe(false);
		// 字节数组是对象，但不属于这里的普通 JSON 数组。
		expect(isJsonValue(new Uint8Array([1]))).toBe(false);
		// number 的 TS 类型也包含 Infinity，有限性必须由运行时判断。
		expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
		// self? 允许此字段暂时缺省；unknown 允许赋任意值，但不能直接当某种具体类型使用。
		const cyclic: { self?: unknown } = {};
		// 把自身塞回字段，构造真正的循环引用；普通 JSON 文本不能表达它。
		cyclic.self = cyclic;
		// 检查返回 false，不靠无限递归或溢出报错来处理循环。
		expect(isJsonValue(cyclic)).toBe(false);
	});
});

// 注册复制函数用例；所有改动仅发生在本例局部对象，失败由 Vitest 断言抛出。
describe("copyJson", () => {
	// 传入带共享子对象的树，比较深层值及对象身份；例如 left/right 原先指向同一个 shared。
	test("copies strict JSON without retaining aliases", () => {
		// 一个原始子对象，稍后被两个字段共同引用。
		const shared = { value: 1 };
		// 这是共享引用而非循环，copyJson 可以接受。
		const input = { left: shared, right: shared };
		// as typeof input 只恢复本例所知的字段类型，不额外执行校验；copyJson 自身做运行时检查。
		const copied = copyJson(input) as typeof input;
		// toEqual 比较内容；toBe/not.toBe 比较引用身份，二者验证不同性质。
		expect(copied).toEqual(input);
		// 根对象也是新对象。
		expect(copied).not.toBe(input);
		// 左右子对象均不能继续引用输入子对象。
		expect(copied.left).not.toBe(shared);
		expect(copied.right).not.toBe(shared);
		// 即使输入有别名，输出两处也独立复制。
		expect(copied.left).not.toBe(copied.right);
	});

	// 只启用对象字段的 undefined 省略；例如数组 [undefined] 仍抛错，不被转成 [null]。
	test("optionally omits undefined object properties without normalizing arrays", () => {
		// 外层和嵌套对象都放一个缺省值字段，覆盖递归路径。
		const input = { kept: 1, omitted: undefined, nested: { omitted: undefined, kept: true } };
		// 箭头函数把调用延迟到断言内，toThrow 才能捕获同步异常。
		expect(() => copyJson(input)).toThrow(/strict JSON/);
		// 显式开启选项后，两层 undefined 字段都省略，其余字段内容保留。
		expect(copyJson(input, { omitUndefinedProperties: true })).toEqual({ kept: 1, nested: { kept: true } });
		// 同一选项不会放宽数组元素的严格 JSON 约束。
		expect(() => copyJson([undefined], { omitUndefinedProperties: true })).toThrow(/strict JSON/);
	});

	// 复制无原型字典，确认特殊键仍是自有数据字段。例如 __proto__ 不应触发原型 setter。
	test("preserves null prototypes and own __proto__ data properties", () => {
		// Record<string, unknown> 是 TS 的字符串键字典；Object.create(null) 真正在运行时去掉原型。
		const input = Object.create(null) as Record<string, unknown>;
		// defineProperty 绕过普通赋值语义，明确创建可枚举、可写、可配置的数据属性。
		Object.defineProperty(input, "__proto__", {
			value: { safe: true },
			enumerable: true,
			writable: true,
			configurable: true,
		});
		// 返回值断言成字典便于读取特殊键；不改变返回对象。
		const copied = copyJson(input) as Record<string, unknown>;
		// 复制保留 null 原型，不引入 Object.prototype。
		expect(Object.getPrototypeOf(copied)).toBeNull();
		// 键必须真正属于 copied，而不是从某个原型继承。
		expect(Object.hasOwn(copied, "__proto__")).toBe(true);
		// 特殊字段的内容按普通 JSON 数据复制。
		expect(copied.__proto__).toEqual({ safe: true });
	});

	// 构造七种不满足严格容器规则的输入；两种 API 对同一输入分别返回 false 和抛 TypeError。
	// 例如 sparse[1] = 1 留下索引0的空洞，它不同于值为 null 的密集数组。
	test("rejects cycles and non-strict container properties", () => {
		// 自引用对象覆盖祖先集合的循环检测。
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		// unknown[] 允许填各种值；空洞本身仍须运行时检查。
		const sparse: unknown[] = [];
		sparse[1] = 1;
		// 数组只能有索引和 length，额外命名属性会使它不再严格。
		const extra = Object.assign([1], { extra: 2 });
		// 派生类改变数组原型；即使 Array.isArray 为 true，也不是普通数组。
		class ArraySubclass extends Array<unknown> {}
		const subclass = new ArraySubclass(1);
		// getter 属性不属于数据属性；检查看描述符，不需要调用 getter 取值。
		const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
		// 不可枚举字段以及 Symbol 键也不能悄悄被复制时忽略。
		const hidden = Object.defineProperty({}, "value", { enumerable: false, value: 1 });
		const symbol = { [Symbol("value")]: 1 };
		// for...of 按值遍历输入；本例只证明这些具体反例，不穷举所有 JavaScript 对象。
		for (const invalid of [cyclic, sparse, extra, subclass, accessor, hidden, symbol]) {
			// 检查接口只报告布尔结果。
			expect(isJsonValue(invalid)).toBe(false);
			// 复制接口拒绝同一输入，错误文本应包含 strict JSON。
			expect(() => copyJson(invalid)).toThrow(/strict JSON/);
		}
	});
});
