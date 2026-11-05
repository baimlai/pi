// 验证 ChordError 的类型约束、链接 JSON 外壳及本地错误辅助函数；不发送任何网络消息。
import { describe, expect, expectTypeOf, it } from "vitest";
import { ChordError, type ChordErrorReason, isChordError, PluginError } from "../../src/data/index.ts";
import {
	asChordError,
	CHORD_ERROR_REASONS,
	chordErrorFromJson,
	invalid,
	PROTOCOL_VERSION,
} from "../../src/data/internal.ts";

// 分组只登记测试；expectTypeOf 的结论来自 TypeScript，expect 的结论来自测试运行时，两者不可互换。
describe("ChordError", () => {
	// 无参回调列出合法与非法构造示例；@ts-expect-error 要求下一行在类型检查时确实报错。
	// 构造器不会在运行时重验 code/reason 配对，因此下面故意错误的示例也能被测试执行。
	it("is a tagged union: a wrong pairing is a type error", () => {
		// invalid 必须附带允许的 reason；这里 args 合法。
		new ChordError({ code: "invalid", reason: "args", message: "m" });
		// unavailable 可以省略 reason。
		new ChordError({ code: "unavailable", message: "m" });
		// locked 是 unavailable 的合法可选原因。
		new ChordError({ code: "unavailable", reason: "locked", message: "m" });
		// 这三行只测试编译器拒绝的组合；指令必须紧邻原表达式。
		// @ts-expect-error: invalid requires a reason
		new ChordError({ code: "invalid", message: "m" });
		// @ts-expect-error: gone carries no reason
		new ChordError({ code: "gone", reason: "args", message: "m" });
		// @ts-expect-error: part belongs to too_large
		new ChordError({ code: "unavailable", reason: "part", message: "m" });
	});

	// 无参回调以 code 分支检查联合类型收窄，同时检查运行时继承与 name；例子运行时为 too_large/part。
	it("narrowing on code narrows reason", () => {
		// as ChordError 把构造器推断的结果视为整个联合，允许后面展示其他 code 的类型分支。
		const error = new ChordError({ code: "too_large", reason: "part", message: "m" }) as ChordError;
		// 判断 code 后 reason 应只剩 invalid 允许的值；此分支在当前固定输入下不会运行。
		if (error.code === "invalid") expectTypeOf(error.reason).toEqualTypeOf<ChordErrorReason<"invalid">>();
		// unavailable 的原因包括列出的五种字面量或 undefined，而不是任意字符串。
		if (error.code === "unavailable")
			expectTypeOf(error.reason).toEqualTypeOf<
				"locked" | "park_timeout" | "busy" | "storage_failed" | "undeclared" | undefined
			>();
		// gone 不允许 reason，因此收窄后的类型只能是 undefined。
		if (error.code === "gone") expectTypeOf(error.reason).toEqualTypeOf<undefined>();
		// 这两条才是实际运行的 Error 继承和名称检查。
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("ChordError");
	});

	// 构造带 details/cause 的错误，经 JSON 文本往返后重建；预期仅协议字段保留，函数无外部副作用。
	it("round-trips through JSON without stack or cause", () => {
		// details 是可传递的 JSON 数据，不是 Error 的 cause。
		const details = { path: "/text" };
		// 构造器第一参是协议字段，第二参沿用 ErrorOptions 保存本地 cause。
		const error = new ChordError(
			{ code: "invalid", reason: "args", message: "args/text: bad", details },
			{ cause: new Error("x") },
		);
		// JSON.stringify 会调用 toJSON，再由 parse 得到普通对象而不是 Error 实例。
		const json = JSON.parse(JSON.stringify(error));
		// 完整比较外壳，排除 stack、cause 等字段泄入 JSON。
		expect(json).toEqual({ code: "invalid", reason: "args", message: "args/text: bad", details });
		// 这是 unknown JSON 的运行时校验边界，合法外壳才重建 ChordError。
		const back = chordErrorFromJson(json);
		// 重建后恢复类实例，但不会恢复丢弃的堆栈与 cause。
		expect(back).toBeInstanceOf(ChordError);
		// 可见协议内容应与解析所得对象一致。
		expect(back.toJSON()).toEqual(json);
		// 没有可选字段时，toJSON 应直接省略字段，避免输出 undefined 属性。
		expect(new ChordError({ code: "gone", message: "m" }).toJSON()).toEqual({ code: "gone", message: "m" });
	});

	// 直接重建一个带数组 details 的错误，预期保留对象身份；这不经过 JSON.stringify，所以没有文本解析复制。
	it("keeps details by reference", () => {
		// 样本代表可能很大的详情数据；此处只需小数组即可检测身份。
		const details = { large: [1, 2, 3] };
		// toBe 比较引用，区别于只比较内容的 toEqual。
		expect(chordErrorFromJson({ code: "gone", message: "m", details }).details).toBe(details);
	});

	// it.each 为每一行登记一例；三列依次是显示名称、边界输入 raw、预期错误文字。
	// 回调只调用解码校验并检查抛错；例如额外 stack 字段必须被拒绝，不能静默删除。
	it.each([
		["not an object", "x", "not an object"],
		["null", null, "not an object"],
		["an array", [], "not an object"],
		["unknown key", { code: "gone", message: "m", stack: "s" }, 'unknown key "stack"'],
		["unknown code", { code: "teapot", message: "m" }, "unknown code"],
		["inherited name as code", { code: "toString", message: "m" }, "unknown code"],
		["code not a string", { code: 1, message: "m" }, "unknown code"],
		["invalid without reason", { code: "invalid", message: "m" }, "reason not allowed for invalid"],
		["reason not allowed", { code: "gone", reason: "args", message: "m" }, "reason not allowed for gone"],
		[
			"reason of another code",
			{ code: "unavailable", reason: "part", message: "m" },
			"reason not allowed for unavailable",
		],
		["message not a string", { code: "gone", message: 1 }, "message is not a string"],
	])("chordErrorFromJson refuses %s", (_case, raw, problem) => {
		// 把调用包成函数交给 toThrow，Vitest 才能捕获同步异常；_case 只用于上面的测试名称。
		expect(() => chordErrorFromJson(raw)).toThrow(`Invalid ChordError JSON: ${problem}`);
	});
});

// 协议表的快照测试同时锁定版本与原因顺序；它提醒维护者同步修改，不自行升级协议。
describe("protocol table", () => {
	// 无参回调把当前导出与手写基线比较，任何不同都失败；本例固定协议版本 1，不建立链接。
	it("is pinned together with PROTOCOL_VERSION", () => {
		// pinned 是独立的预期副本，避免拿同一对象和自己比较。
		const pinned = {
			version: 1,
			reasons: {
				invalid: ["args", "params", "member", "host_address", "reentrant", "read_after_bulk", "cycle"],
				contract_mismatch: ["updating"],
				forbidden: ["revoked"],
				gone: [],
				not_ready: [],
				released: ["ended", "closed", "settled", "version", "discarded"],
				too_large: ["part"],
				unavailable: ["locked", "park_timeout", "busy", "storage_failed", "undeclared"],
				aborted: [],
			},
		};
		// || 任何一侧不符即表示变化；JSON 比较同时检查字段和值的顺序。
		const changed =
			PROTOCOL_VERSION !== pinned.version || JSON.stringify(CHORD_ERROR_REASONS) !== JSON.stringify(pinned.reasons);
		// 第二参是失败时显示的说明，正常预期必须是 false。
		expect(changed, "the error table changed: bump PROTOCOL_VERSION and update this pin").toBe(false);
	});
});

// 辅助函数测试只构造错误，不包含资源打开、参数验证或 host 逻辑。
describe("helpers", () => {
	// 检查类实例和可选 code 条件；普通 Error 与长得相同的普通对象都应返回 false，无参无返回值。
	it("isChordError checks the class and optionally the code", () => {
		// invalid 创建真正的 ChordError，reason 为 member。
		const error = invalid("member", "no method");
		// 省略 code 只检查实例归属。
		expect(isChordError(error)).toBe(true);
		// 指定匹配的 code 才仍为 true。
		expect(isChordError(error, "invalid")).toBe(true);
		// 真 ChordError 也可能因 code 不匹配返回 false。
		expect(isChordError(error, "gone")).toBe(false);
		// 普通错误没有 ChordError 类身份。
		expect(isChordError(new Error("x"))).toBe(false);
		// 字段形状相同并不足以冒充类实例。
		expect(isChordError({ code: "invalid", reason: "member", message: "m" })).toBe(false);
	});

	// 用 params/a 缺失的固定例子检查便捷构造器和字面量类型；不会真正执行参数校验。
	it("invalid builds an invalid error with its reason and details", () => {
		// 将 reason、消息、JSON 详情交给辅助构造器。
		const error = invalid("params", "params/a: missing", { path: "/a" });
		// 运行时检查所有协议字段原样保留。
		expect(error.toJSON()).toEqual({
			code: "invalid",
			reason: "params",
			message: "params/a: missing",
			details: { path: "/a" },
		});
		// 静态检查返回值 code 仍是 "invalid" 字面量，未扩大为所有错误码。
		expectTypeOf(error.code).toEqualTypeOf<"invalid">();
	});

	// 将已有 ChordError、TypeError 和字符串分别归一化；预期前者原样返回，后两者加标签包装为 unavailable。
	it("asChordError keeps a ChordError and wraps anything else as unavailable", () => {
		// 已有的结构化错误不应丢掉其 invalid/cycle 分类。
		const chord = invalid("cycle", "c");
		// 身份断言证明没有重新包装。
		expect(asChordError(chord, "open")).toBe(chord);
		// 准备普通错误作为未知异常样本。
		const foreign = new TypeError("boom");
		// 包装用标签说明发生位置，并保留原错误为 cause。
		const wrapped = asChordError(foreign, "open notes");
		// 对外错误只有统一 code 和带标签的 message。
		expect(wrapped.toJSON()).toEqual({ code: "unavailable", message: "open notes: boom" });
		// 原始错误仍可在同一进程通过 cause 查看。
		expect(wrapped.cause).toBe(foreign);
		// 非 Error 的抛出值走 String 转换，再附上位置标签。
		expect(asChordError("text", "open").message).toBe("open: text");
	});
});

// PluginError 让插件使用自己的业务错误码，与 Chord 的协议错误原因表分开。
describe("PluginError", () => {
	// 用 quota 超额示例检查继承与字段，另检查不传详情时为 undefined；无参回调只分配内存对象。
	it("carries a plugin's code, message and JSON details", () => {
		// 三个参数分别为业务 code、消息和可选 JSON 详情。
		const error = new PluginError("quota", "too many", { limit: 3 });
		// 插件错误也必须能按普通 Error 处理。
		expect(error).toBeInstanceOf(Error);
		// toMatchObject 只比较列出的字段，不限制 Error 自带的其他属性。
		expect(error).toMatchObject({ name: "PluginError", code: "quota", message: "too many", details: { limit: 3 } });
		// 省略第三参时没有自动生成详情。
		expect(new PluginError("c", "m").details).toBeUndefined();
	});
});
