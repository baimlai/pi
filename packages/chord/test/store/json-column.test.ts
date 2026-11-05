// `json(...)` columns (rule 8): their declaration, and a cell read and migrated on access.

import { describe, expect, it } from "vitest";
import { int, obj, str } from "../../src/contracts/index.ts";
import { JsonColumn, json } from "../../src/store/json-column.ts";
import { counted } from "../support.ts";

// 旧 schema 只有 tag；新 schema 把它改为 tags 并新增整数 n，以下迁移显式给出转换。
const MetaV1 = obj({ tag: str() });
const MetaV2 = obj({ tags: str(), n: int() });

// 这里只检查列定义元数据；json helper 包装 JsonColumn，并不序列化某个业务单元格。
describe("json(...)", () => {
	// 创建同结构/异结构列，核对版本、对象类别和指纹；结果为断言通过，无数据库副作用。
	// 例如 str() 与 str({}) 结构相同，指纹应相等。
	it("is a schema carrying its column: version and the fingerprint of the schema's normal form", () => {
		// 双重 as 让测试读取内部 json 字段；类型断言不会创建对象，实际 new JsonColumn 在 json 内发生。
		const column = (json(MetaV1, { version: 1 }) as unknown as { json: JsonColumn }).json;
		// 运行时确认 helper 确实携带 JsonColumn 实例。
		expect(column).toBeInstanceOf(JsonColumn);
		// 检查声明版本原样保留为 1。
		expect(column.version).toBe(1);
		// 用等价 schema 另建实例，避免把“同一个对象”误当结构等价。
		const again = (json(obj({ tag: str({}) }), { version: 1 }) as unknown as { json: JsonColumn }).json;
		// 在相同版本下换一种结构，随后只比较其指纹差异，并不测试激活阶段的拒绝。
		const other = (json(MetaV2, { version: 1 }) as unknown as { json: JsonColumn }).json;
		// 同结构元数据经规范化后得到相同指纹。
		expect(again.fingerprint).toBe(column.fingerprint);
		// 新字段结构应改变指纹，这个指纹不是安全签名。
		expect(other.fingerprint).not.toBe(column.fingerprint);
	});

	// 输入版本 0，预期声明同步失败；不涉及任何已有数据迁移。
	it("refuses a version that is not a positive integer", () => {
		// number 类型不能表达“正安全整数”约束，因此这个声明策略仍由运行时检查。
		expect(() => json(MetaV1, { version: 0 })).toThrow("version 0");
	});
});

// 单元格读取以 JSON 文本和已存版本为输入；只对迁移结果做 schema 校验，同版本仍要 JSON.parse。
describe("reading a cell", () => {
	// 迁移函数收到旧 JSON 与 from 版本，返回 tags/n；示例 tag="x", from=1 得 {tags:"x",n:1}。
	// as {tag:string} 只帮助编译器理解旧版本，不能验证实际旧 JSON 的形状；这里输入由测试固定。
	const v2 = new JsonColumn(MetaV2, 2, (old, from) => ({ tags: (old as { tag: string }).tag, n: from }));

	// 读取合法版本 2 文本，检查结果及校验计数；只使用内存 telemetry，无持久化副作用。
	it("parses a cell of the current version with no check", async () => {
		// counted 为同步回调提供计数 context，完成后返回本次累加值；async 测试等待其 Promise。
		// 为所有读取提供 telemetry context；本例不读取返回的计数。
		const counts = await counted((context) => {
			// 直接解析当前版本，what="t.meta" 只用于出错时定位。
			expect(v2.read('{"tags":"a","n":1}', 2, "t.meta", context)).toEqual({ tags: "a", n: 1 });
		});
		// 零次指的是 schema 校验计数，不能据此推断没有解析、没有分配对象。
		expect(counts.validations).toBe(0);
	});

	// 读取 v1 文本，运行上面的迁移并只校验产出一次；示例旧 tag="x" 变为新 tags="x"。
	it("migrates an older cell and checks the result once (R8)", async () => {
		// counted 为同步回调提供计数 context，完成后返回本次累加值；async 测试等待其 Promise。
		// 为所有读取提供 telemetry context；本例不读取返回的计数。
		const counts = await counted((context) => {
			// 存储版本 1 小于定义版本 2，read 将 from=1 传给迁移函数。
			expect(v2.read('{"tag":"x"}', 1, "t.meta", context)).toEqual({ tags: "x", n: 1 });
		});
		// 计数只证明此读操作调用了一次迁移结果校验，不表示读取会写回数据库。
		expect(counts.validations).toBe(1);
	});

	// 用四类输入验证无法安全读取时拒绝：未来版本、无迁移、迁移抛错、迁移结果错误。
	// 此处没有宿主对象，故只证明 read 抛错，不证明宿主随后进入哪种状态。
	it("refuses a newer cell, a missing or throwing migrate and an invalid result", async () => {
		// 为所有读取提供 telemetry context；本例不读取返回的计数。
		await counted((context) => {
			// 存储版本比代码新，不能调用旧代码迁移它。
			expect(() => v2.read("{}", 3, "t.meta", context)).toThrow("newer than 2");
			// 第三参 undefined 明确表示没提供迁移函数，旧版本读取应失败。
			expect(() => new JsonColumn(MetaV2, 2, undefined).read("{}", 1, "t.meta", context)).toThrow("no migrate");
			// 构造故障迁移：忽略参数，不返回值，始终抛 Error("no")。
			const throwing = new JsonColumn(MetaV2, 2, () => {
				// 故障在迁移回调内发生，由 JsonColumn.read 包装成定位到迁移的错误。
				throw new Error("no");
			});
			// 匹配包装后的消息，不要求原始异常直接穿透。
			expect(() => throwing.read("{}", 1, "t.meta", context)).toThrow("threw");
			// as never 故意压过迁移返回类型，制造 tags 为数字的错误数据；运行时 schema 校验仍会拒绝。
			const invalid = new JsonColumn(MetaV2, 2, () => ({ tags: 1, n: 1 }) as never);
			// 只匹配 Chord 错误 code=unavailable，不依赖完整消息或 cause。
			expect(() => invalid.read("{}", 1, "t.meta", context)).toThrow(
				expect.objectContaining({ code: "unavailable" }),
			);
		});
	});
});
