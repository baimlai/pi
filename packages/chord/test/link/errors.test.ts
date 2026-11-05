// 验证异常跨链路时保留的字段，以及接收端恢复的异常类型；全部使用内存数据。
import { describe, expect, it } from "vitest";
import { ChordError, PluginError } from "../../src/data/index.ts";
import { errorFromWire, wireError } from "../../src/link/internal.ts";

// 这组同步测试比较序列化前后的异常；describe 的回调只登记下面各用例。
describe("errors on the wire", () => {
	// 用带 cause 的参数异常验证出站投影和 JSON 往返。无参数、无返回数据；失败由断言抛出。
	// 本例实际预期只剩 invalid/args/bad 三字段，不把本地堆栈和 cause 发给另一端。
	it("carry a ChordError as its JSON, without stack or cause", () => {
		// 构造本地 ChordError，同时挂一个只用于本机诊断的 cause。
		const error = new ChordError({ code: "invalid", reason: "args", message: "bad" }, { cause: new Error("x") });
		// 把异常投影成可发送的联合类型；kind 决定接收端走哪种还原分支。
		const wire = wireError(error);
		// 深度比较完整外壳，额外的 stack 或 cause 字段也会使测试失败。
		expect(wire).toEqual({ kind: "chord", error: { code: "invalid", reason: "args", message: "bad" } });
		// 先 stringify 再 parse 模拟 JSON 传输，再还原异常；不是真的开启链路。
		const back = errorFromWire(JSON.parse(JSON.stringify(wire)));
		// 检查运行时原型确实恢复成 ChordError，不能只返回同形普通对象。
		expect(back).toBeInstanceOf(ChordError);
		// 部分字段匹配还原后的业务信息；不要求本地堆栈等字段完全相同。
		expect(back).toMatchObject({ code: "invalid", reason: "args", message: "bad" });
	});

	// 用 quota 插件错误验证 code/message/details 原样传递并恢复类实例。
	// 同步回调无输入和返回值，只创建内存异常；例如 limit:3 应在往返后仍为 3。
	it("carry a PluginError's code, message and details only; the consumer rethrows a PluginError", () => {
		// 构造业务错误，第三个实参是可以跨链路携带的 JSON 详情。
		const error = new PluginError("quota", "too many notes", { limit: 3 });
		// 把异常投影成可发送的联合类型；kind 决定接收端走哪种还原分支。
		const wire = wireError(error);
		// 确认插件错误外壳只包含协议允许的四项。
		expect(wire).toEqual({ kind: "plugin", code: "quota", message: "too many notes", details: { limit: 3 } });
		// 直接调用入站转换，不经过真实网络；此处检验转换函数本身。
		const back = errorFromWire(wire);
		// 要求还原为可按类识别的 PluginError。
		expect(back).toBeInstanceOf(PluginError);
		// 确认业务错误码、消息和详情不在还原时丢失。
		expect(back).toMatchObject({ code: "quota", message: "too many notes", details: { limit: 3 } });
		// 另测未提供 details 的情况：出站对象省略该键，而不是塞入 undefined。
		expect(wireError(new PluginError("c", "m"))).toEqual({ kind: "plugin", code: "c", message: "m" });
	});

	// 验证非专用异常的兜底映射；普通 Error 取 message，字符串取字符串本身。
	// 无外部副作用，例如 TypeError("boom") 应成为 internal/boom；断言不证明全部可抛值。
	it("carry anything else as the plugin code internal with its message", () => {
		// TypeError 不保留类型名称，按普通插件内部错误跨链路。
		expect(wireError(new TypeError("boom"))).toEqual({ kind: "plugin", code: "internal", message: "boom" });
		// JavaScript 可以抛字符串；wireError 的 unknown 入参也覆盖这种情况。
		expect(wireError("plain")).toEqual({ kind: "plugin", code: "internal", message: "plain" });
	});

	// 给入站还原器传一个非法错误码，验证运行时拒绝，而不是依赖 TypeScript。
	// 本例输入 nope，期望同步抛 Invalid ChordError JSON；不在这里检查链路关闭。
	it("throw on a malformed ChordError envelope (a protocol error)", () => {
		// 把调用包成零参数回调，toThrow 才能捕捉调用期间抛出的异常。
		expect(() => errorFromWire({ kind: "chord", error: { code: "nope", message: "m" } })).toThrow(
			// 匹配异常消息中的文本，明确本例观察到的拒绝原因。
			"Invalid ChordError JSON",
		);
	});
});
