import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

// 注册 #7269：双短横线结束选项扫描，但后续 @file 仍单独收集；不会在这里读取文件。
describe("issue #7269 CLI end-of-options delimiter", () => {
	// 变量可保存 Harness 或 undefined；类型约束仅在开发时检查。
	let harness: Harness | undefined;

	// 每例后释放可选会话并清空引用；即使测试断言失败，也由 Vitest 调用此回调。
	afterEach(() => {
		// ?. 只有变量已赋值时才调用，清理假供应商和临时目录。
		harness?.cleanup();
		// 避免后续用例引用已被清理的会话。
		harness = undefined;
	});

	// each 对两种以短横线开头的问题分别运行同一个回调；%j 将参数按 JSON 形式放进测试标题。
	it.each(["- summarize the following points for me", "--answer my question briefly"])(
		"passes %j as a prompt after --",
		// 输入是一条问题字符串；先解析含 -- 的参数再交给 faux 会话，断言问题原样保留，无业务返回值。
		// 例如 --answer 不应在分隔符之后再被识别为选项；异常由测试框架报告，afterEach 清理。
		async (prompt) => {
			// 纯解析器把前三个开关转成配置，-- 后面的整个 prompt 作为位置参数保留。
			const parsed = parseArgs(["-ne", "--no-session", "-p", "--", prompt]);
			// 数组深比较要求只得到一条原始问题。
			expect(parsed.messages).toEqual([prompt]);
			// 问题中的短横线不能被记成未知扩展开关。
			expect(parsed.unknownFlags.size).toBe(0);
			// 这些参数应无解析警告或错误。
			// 这些参数应无解析警告或错误。
			expect(parsed.diagnostics).toEqual([]);

			// 创建本地 faux 会话，保存引用供统一清理。
			harness = await createHarness();
			// 安排一条正常助手回复，不访问真实模型。
			harness.setResponses([fauxAssistantMessage("ok")]);
			// 等待解析后的首条问题走完整提问流程。
			await harness.session.prompt(parsed.messages[0]);
			// 读取会话用户消息文本，再确认没有丢掉开头短横线。
			expect(getUserTexts(harness)).toEqual([prompt]);
		},
	);

	// 同步用例无输入和资源副作用：解析混合开关/位置参数，断言 -- 后不设 provider/continue 但仍识别 @文件。
	// 例如 @prompt.md 只会形成路径 prompt.md，本测试不会打开该文件。
	it("stops parsing options while retaining @file handling", () => {
		// 分隔符前未知开关消费 value；之后三个普通词归入问题，@词归入文件列表。
		const parsed = parseArgs(["--unknown-flag", "value", "--", "--provider", "openai", "-c", "@prompt.md"]);

		// Map.get 按去掉 -- 的开关名查询其值。
		expect(parsed.unknownFlags.get("unknown-flag")).toBe("value");
		// 分隔符后的 --provider 不再设置供应商。
		expect(parsed.provider).toBeUndefined();
		// 分隔符后的 -c 不再触发续聊标记。
		expect(parsed.continue).toBeUndefined();
		// 这些词保留原顺序，各自是位置参数而不是合成一条字符串。
		expect(parsed.messages).toEqual(["--provider", "openai", "-c"]);
		// @ 前缀被去掉，但本层仅收集路径，不读文件内容。
		expect(parsed.fileArgs).toEqual(["prompt.md"]);
		// 这些参数应无解析警告或错误。
		expect(parsed.diagnostics).toEqual([]);
	});
});
