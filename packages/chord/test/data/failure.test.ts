// 验证对象失败的分类和依赖等待消息；只构造错误值，不启动 host、网络或自动重试。
import { describe, expect, it } from "vitest";
import { broken, ChordError } from "../../src/data/index.ts";
import { invalid, openFailure, sameCause, waitingFor } from "../../src/data/internal.ts";

// describe 的无参回调登记一组测试；it 的回调由 Vitest 运行，断言不符就使该用例失败。
describe("failure causes", () => {
	// 把普通 Error 作为 open 的抛出值交给分类器，预期得到 transient；例如网络断开只表示可重试的效果失败。
	// 回调无参数、无返回值；只创建错误和检查结果，不执行真正的资源打开动作。
	it("a value thrown by an open is transient unless marked broken", () => {
		// 原始 Error 留在 cause 中，面向调用者的消息另加资源名。
		const error = new Error("network down");
		// openFailure 返回带 kind 的联合类型；分类来自失败阶段及 broken 标记。
		const transient = openFailure(error, "open notes");
		// 此路径没有 broken 标记，因此分类应是 transient。
		expect(transient.kind).toBe("transient");
		// toJSON 只保留可跨链接传递的字段，不包含 Error 的堆栈和 cause。
		expect(transient.error.toJSON()).toEqual({ code: "unavailable", message: "open notes: network down" });
		// toBe 比较对象身份，证明包装错误仍引用最初的错误。
		expect(transient.error.cause).toBe(error);
	});

	// 将 bad config 显式标记为 broken，再分类并检查消息；这是固定输入示例，不是配置检查器。
	// 无参回调只产生内存对象，任一断言不符会由 Vitest 报错。
	it("broken() marks an open's failure as broken; its message is the cause's", () => {
		// broken 创建专用包装错误，沿用原错误的 message。
		const marked = broken(new Error("bad config"));
		// 验证包装本身未把错误消息改写为另一段文本。
		expect(marked.message).toBe("bad config");
		// 分类器识别该包装，随后用 open notes 作为位置说明。
		const cause = openFailure(marked, "open notes");
		// broken 表示需要显式重试或新代码等触发，而不是普通效果失败的分类。
		expect(cause.kind).toBe("broken");
		// 检查位置标签和原消息都出现在最终错误中。
		expect(cause.error.message).toBe("open notes: bad config");
	});

	// 同一个 invalid 错误分别直接传入和经 broken 包装，预期分类不同且 error 身份相同。
	// 无参、无返回；例子说明 invalid 这个错误码本身并不决定重试类别。
	it("the kind comes from the stage, never from the error code", () => {
		// invalid 的首参是原因；host_address 属于 invalid 允许的原因集合。
		const chord = invalid("host_address", "wrong host");
		// 已是 ChordError 时不会再包装；未带 broken 标记的 open 失败仍为 transient。
		expect(openFailure(chord, "open")).toEqual({ kind: "transient", error: chord });
		// 专用标记改变分类，却不会改变底层 ChordError。
		expect(openFailure(broken(chord), "open")).toEqual({ kind: "broken", error: chord });
	});
});

// 登记等待依赖的测试；共享 root 只是不可变错误样本，每个用例自行构造新的等待原因。
describe("a dependent's waiting cause (dependency model §3)", () => {
	// 这是最终缺失的提供者，后面的 waiting 包装需要保留它的消息。
	const root = new ChordError({ code: "unavailable", message: "app.catalog is not served here" });

	// 用 app.chat(S1) 等待 catalog 的固定例子检查最近阻塞者、根消息和 cause；无外部副作用。
	it("names the nearest blocker and the root cause, its blocker's error as the cause", () => {
		// waitingFor 返回 { kind, error }，不会在这里发起等待或安装监听器。
		const cause = waitingFor("app.chat(S1)", root);
		// 等待别人恢复与对象自身的 transient/broken 失败分开表示。
		expect(cause.kind).toBe("waiting");
		// 对外消息同时点名最近阻塞者和最终根因。
		expect(cause.error.toJSON()).toEqual({
			code: "unavailable",
			message: "waiting for app.chat(S1): app.catalog is not served here",
		});
		// cause 保留直接阻塞者的错误对象，便于本地查看错误链。
		expect(cause.error.cause).toBe(root);
		// A chain names its nearest blocker and its root only (fix round 1, Opus F1).
		// 再套 app.panel 时剥去旧 waiting 前缀，避免在文本里重复整条链。
		const chain = waitingFor("app.panel", cause.error);
		// 示例链 panel → chat → catalog 的文本只留下 panel 与 catalog。
		expect(chain.error.message).toBe("waiting for app.panel: app.catalog is not served here");
	});

	// 模拟 A/B 环重复传递等待原因，检查消息最多一轮便稳定；无参回调最多循环 10 次，不创建真实依赖环。
	it("reaches a fixed point when a ring of waiting attempts passes its causes round (Opus F1)", () => {
		// let 允许每轮把当前错误替换为下一条错误，起点是缺少 X。
		let b = waitingFor("X", new ChordError({ code: "unavailable", message: "X is not served here" })).error;
		// rounds 记录首次出现相同消息之前走了几轮。
		let rounds = 0;
		// 有界模拟：即使实现退化，测试也不会无限循环。
		for (; rounds < 10; rounds++) {
			// 内层先包装 B，外层再包装 A；两层都应只保留最初的根消息。
			const next = waitingFor("A", waitingFor("B", b).error).error;
			// 消息已稳定便提前退出，不要求错误对象身份相同。
			if (next.message === b.message) break;
			// 尚未稳定时，用本轮结果作为下一轮输入。
			b = next;
		}
		// 此断言限制消息传播的轮数，未证明任意运行时依赖图一定能激活。
		expect(rounds).toBeLessThanOrEqual(1);
		// 稳定文本应保留最近的 A 和缺少 X 的最终根因。
		expect(b.message).toBe("waiting for A: X is not served here");
	});

	// 用 600 个 x 组成过长对象标签，检查 500 字符预算优先保留短根因；只测试字符串处理。
	it("keeps the root cause within 500 characters: a long label is clipped first (Sol 8)", () => {
		// 根因长度较短，应完整保留。
		const original = new ChordError({ code: "unavailable", message: "ORIGINAL: missing provider" });
		// 模板字符串在运行时把重复文本放入标签；这里没有修改实际错误生成规则。
		const message = waitingFor(`sol.item(${"x".repeat(600)})`, original).error.message;
		// JavaScript length 统计 UTF-16 代码单元；此样本主要为 ASCII 字符。
		expect(message.length).toBeLessThanOrEqual(500);
		// 预算截断标签，不应把这个较短的根因截掉。
		expect(message).toContain(original.message);
		// 检查开头仍能辨认等待的对象标签。
		expect(message.startsWith("waiting for sol.item(xxx")).toBe(true);
	});

	// 连续包装 2,000 层，预期文本只有最后一层标签和原根因；无参同步回调不启动重试。
	it("keeps a long chain's root cause, never repeated ellipses (Sol 8)", () => {
		// 准备不会超出预算的根消息。
		const original = new ChordError({ code: "unavailable", message: "ORIGINAL: missing provider" });
		// error 在每次循环后指向新包装，original 仍保留起点。
		let error = original;
		// i 从 0 到 1999，每次把上轮消息作为下一层的错误输入。
		for (let i = 0; i < 2000; i++) error = waitingFor(`level-${i}`, error).error;
		// 不应出现重复的 waiting for 或因逐层累积而产生的省略号。
		expect(error.message).toBe("waiting for level-1999: ORIGINAL: missing provider");
	});

	// 分别测试长根因、长根因加长标签，预期刚好用满 500 字符且末尾以省略号标记；仅生成字符串。
	it("clips a long root past its share, and both when both are long", () => {
		// 单个根因已经超过整个消息预算。
		const long = new ChordError({ code: "unavailable", message: "y".repeat(600) });
		// 标签短时，把其余空间交给根因。
		const short = waitingFor("app.a", long).error.message;
		// toHaveLength 直接比较 length 属性。
		expect(short).toHaveLength(500);
		// 短标签和根因开头都应保留。
		expect(short.startsWith("waiting for app.a: yyy")).toBe(true);
		// 标签也变长时，两段都要在各自预算内裁剪。
		const both = waitingFor("z".repeat(600), long).error.message;
		// 总长度仍然不能越过统一预算。
		expect(both).toHaveLength(500);
		// 根因截断要显式带上省略号，而不是悄悄丢掉尾部。
		expect(both.endsWith("y…")).toBe(true);
	});

	// 比较内容相等和标签、kind、reason 不同的原因；无参回调返回 void，不依赖对象身份或真实唤醒流程。
	it("is compared by value: kind, code, reason and message", () => {
		// 两次构造的不同对象，只要关键字段相等就视作相同原因。
		expect(sameCause(waitingFor("a", root), waitingFor("a", root))).toBe(true);
		// 最近阻塞者不同会改变 message，因此比较结果不同。
		expect(sameCause(waitingFor("a", root), waitingFor("b", root))).toBe(false);
		// 同一个 error 不能掩盖 transient 与 broken 的分类差异。
		expect(sameCause({ kind: "broken", error: root }, { kind: "transient", error: root })).toBe(false);
		// 相同 code/message 加上不同 reason，仍属于不同的原因。
		const other = new ChordError({ code: "unavailable", reason: "undeclared", message: root.message });
		// root 没有 reason，other 有 undeclared，故不能合并成同一原因。
		expect(sameCause({ kind: "waiting", error: root }, { kind: "waiting", error: other })).toBe(false);
	});
});
