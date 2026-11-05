// Table columns (decisions "Flat columns", "Nullable columns and the `set` form"): descriptors and row types.

import { describe, expect, it } from "vitest";
import { arr, bool, int, num, obj, opt, str } from "../../src/contracts/index.ts";
import { type Columns, columnRecord, describeColumns, type PutRowOf, type RowOf } from "../../src/store/columns.ts";
import { json } from "../../src/store/json-column.ts";
import type { Equal } from "../support.ts";

// 登记列描述符测试：只处理声明元数据，不建表、不访问数据库。
describe("column descriptors", () => {
	// 输入六种列声明，核对顺序、可空性和持久化元数据；回调返回 void。
	// 例如 opt(json(...)) 同时记录 optional 和 JSON 自身的 version/fingerprint。
	it("describes the helpers in declaration order", () => {
		// 将 schema helper 转成内部 Column 数组；"t" 只是错误消息中的表名。
		const columns = describeColumns(
			{
				// id 为必填文本，n 有默认值；num 对应有限数字，bool 对应布尔值。
				id: str(),
				n: int({ default: 0 }),
				x: num(),
				b: bool(),
				// opt 让该列允许缺省；meta 的 JSON 内容是空对象 schema，列版本显式设为 2。
				note: opt(str()),
				meta: opt(json(obj({}), { version: 2 })),
			},
			"t",
		);
		// map 回调用解构挑出三个字段，再组成数组，避免把其他元数据混进本断言。
		expect(columns.map(({ name, type, optional }) => [name, type, optional])).toEqual([
			["id", "str", false],
			["n", "int", false],
			["x", "num", false],
			["b", "bool", false],
			["note", "str", true],
			["meta", "json", true],
		]);
		// columnRecord 只保留复制数据库结构所需的数据；expect.any(String) 不固定指纹内容。
		expect(columns.map(columnRecord)).toEqual([
			{ type: "str" },
			{ type: "int", default: 0 },
			{ type: "num" },
			{ type: "bool" },
			{ type: "str", optional: true },
			{ type: "json", optional: true, version: 2, fingerprint: expect.any(String) },
		]);
	});

	// 分别输入非法连字符、保留的 $、大小写冲突及合法名字；预期抛错或得到两列，无外部副作用。
	it("checks names: the pattern, no two equal ignoring case, no $", () => {
		// 带连字符的字段不满足列名规则；箭头函数延迟执行，交由 toThrow 捕获同步错误。
		expect(() => describeColumns({ "a-b": str() }, "t")).toThrow("[A-Za-z_][A-Za-z0-9_]*");
		// 隐藏版本字段使用 $，因此业务列不能使用它。
		expect(() => describeColumns({ a$v: str() }, "t")).toThrow('column "a$v"');
		// SQLite 列名不区分 ASCII 大小写，path/Path 不能同时存在。
		expect(() => describeColumns({ path: str(), Path: str() }, "t")).toThrow("only in case");
		// 驼峰和下划线开头合法；长度 2 只断言两项都被接受。
		expect(describeColumns({ camelCase: str(), _x1: int() }, "t")).toHaveLength(2);
	});

	// 故意绕过静态类型检查，把不支持的 schema 和默认值交到声明边界；每个例子应同步拒绝。
	// 例如 str({max:3}) 在普通 schema 可用，在表列声明不允许。
	it("refuses other schemas, bounds, patterns, opt defaults and defaults of another type", () => {
		// 这个局部包装函数输入 unknown、返回强制断言的 Columns，只为构造非法测试数据。
		// as unknown as Columns 是编译期强制断言，不会把数据转成合法列或跳过 describeColumns 的运行时检查。
		const columns = (value: unknown) => ({ c: value }) as unknown as Columns;
		// 数组 schema 不能作为平铺标量列。
		expect(() => describeColumns(columns(arr(str())), "t")).toThrow("expected str()");
		// 对象必须走 json(...) 列，直接 obj 不被接受。
		expect(() => describeColumns(columns(obj({})), "t")).toThrow("expected str()");
		// 表列不支持 maxLength 约束，本例核对具体不支持的关键字。
		expect(() => describeColumns(columns(str({ max: 3 })), "t")).toThrow('"maxLength" is not supported');
		// pattern 正则约束也不属于表列支持的声明。
		expect(() => describeColumns(columns(str({ pattern: "a" })), "t")).toThrow('"pattern" is not supported');
		// optional 列和默认值不可叠加，缺省值以 SQL NULL 表示。
		expect(() => describeColumns(columns(opt(int({ default: 1 }))), "t")).toThrow("no default");
		// 整数列的默认值也必须是安全整数，不能是 1.5。
		expect(() => describeColumns(columns(int({ default: 1.5 })), "t")).toThrow("not a int value");
		// 文本默认值包含 NUL 时在声明阶段就拒绝。
		expect(() => describeColumns(columns(str({ default: "a\0" })), "t")).toThrow("NUL");
	});
});

// 这一组主要由 TypeScript 编译器证明；运行 Vitest 只会看到下面两个 true。
describe("row types", () => {
	// 以 id/hits/note 三列比较读取行与写入行类型；返回 void，不实际写入。
	// 示例 put 可省略有默认值的 hits，读取行则必须有 hits。
	it("types rows with optional opt(...) fields and puts with optional defaulted fields", () => {
		// id 为必填文本，n 有默认值；num 对应有限数字，bool 对应布尔值。
		// 用 helper 的返回类型构造静态列形状；note? 的可选性由 opt 推导。
		const shape = { id: str(), hits: int({ default: 0 }), note: opt(str()) };
		// typeof 出现在类型位置，取得 shape 的类型，不是运行时 typeof 检查。
		type S = typeof shape;
		// Equal 是条件类型；两种类型不相等时赋 true 会在类型检查时失败。& 将必填字段与可选字段合并。
		const row: Equal<RowOf<S>, { id: string; hits: number } & { note?: string }> = true;
		// PutRowOf 将 hits 默认列改为可选；? 表示属性可省略，不表示任何值都可传入。
		const put: Equal<PutRowOf<S>, { id: string } & { hits?: number; note?: string }> = true;
		// 运行期只比较两个布尔常量；完整类型证明需要统一的 TypeScript 检查。
		expect([row, put]).toEqual([true, true]);
	});
});
