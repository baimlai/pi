// 验证生成目录摊平后模型API/ID/provider的字面量类型，以及少量Copilot模型运行字段；不向供应商发现或请求模型。
// expect是运行断言；expectTypeOf的泛型断言要由TypeScript检查，普通Vitest运行通过本身不替代完整类型检查。
import { expect, expectTypeOf, it } from "vitest";
// 只读自动生成的Copilot目录入口，内部从本地JSON按type摊平；不手改生成文件，也不执行Copilot OAuth。
import { GITHUB_COPILOT_MODELS } from "../src/providers/github-copilot.models.ts";
// XAI同样是本地生成目录值，泛型目录从分组API键/模型键推导字面量，不现场向xAI查能力。
import { XAI_MODELS } from "../src/providers/xai.models.ts";

// 这例检查多款xAI模型的静态字面量，无异步输入/业务返回；例grok-4.5.api应窄为openai-responses而非任意string。
// 调用表达式仍会读取目录属性，但没有expect运行值断言；目录类型正确与远端路由可用是不同问题。
it("derives model API, ID, and provider literals from grouped model data", () => {
	// 要求4.5的api类型精确等于这个协议字面量，尖括号传的是类型参数，不是比较运行字符串。
	expectTypeOf(XAI_MODELS["grok-4.5"].api).toEqualTypeOf<"openai-responses">();
	// 要求id类型为grok-4.5字面量，避免摊平后宽化成string。
	expectTypeOf(XAI_MODELS["grok-4.5"].id).toEqualTypeOf<"grok-4.5">();
	// 要求provider类型为xai字面量，不是只验证它符合string。
	expectTypeOf(XAI_MODELS["grok-4.5"].provider).toEqualTypeOf<"xai">();
	// 4.6的协议类型也必须精确是Responses。
	expectTypeOf(XAI_MODELS["grok-4.6"].api).toEqualTypeOf<"openai-responses">();
	// 4.6的ID类型必须对应自己的目录键。
	expectTypeOf(XAI_MODELS["grok-4.6"].id).toEqualTypeOf<"grok-4.6">();
	// 4.7同样检查协议类型，不实际生成回复。
	expectTypeOf(XAI_MODELS["grok-4.7"].api).toEqualTypeOf<"openai-responses">();
	// 4.7的ID字面量应保留完整后缀。
	expectTypeOf(XAI_MODELS["grok-4.7"].id).toEqualTypeOf<"grok-4.7">();
	// 4.3只检查API类型，本例没有另检查它的ID/provider。
	expectTypeOf(XAI_MODELS["grok-4.3"].api).toEqualTypeOf<"openai-responses">();
});

// 同时检查Copilot的Grok4.5协议类型和真实目录字段，例运行值必须是openai-responses；这是目录配置断言，不启动真正路由调用。
it("routes GitHub Copilot Grok 4.5 through the Responses API", () => {
	// 编译期要求API为单一Responses字面量。
	expectTypeOf(GITHUB_COPILOT_MODELS["grok-4.5"].api).toEqualTypeOf<"openai-responses">();
	// toBe在运行时比较字段文字，补上与上一行类型约束不同的一层检查。
	expect(GITHUB_COPILOT_MODELS["grok-4.5"].api).toBe("openai-responses");
});

// Regression test for https://github.com/earendil-works/pi/issues/9209
// 针对原英语所列9209回归，要求当前目录所有gpt-前缀聊天模型都用Responses，且两指定GPT模型保留容量/思考映射。
// 遍历的是这次本地生成目录，不保证供应商未来新增目录或远端服务行为；用例同步完成，断言不通过就抛给Vitest。
it("routes all GitHub Copilot GPT models through the Responses API", () => {
	// Object.values取目录模型新数组，再filter只留id以小写gpt-开头者；不是正则或不分大小写匹配。
	const gptModels = Object.values(GITHUB_COPILOT_MODELS).filter((model) => model.id.startsWith("gpt-"));
	// 先断言至少一项，避免every对空数组为true造成无模型也通过。
	expect(gptModels.length).toBeGreaterThan(0);
	// 逐项比较运行API，所有当前GPT条目都为Responses才true；未要求其它非GPT模型用同协议。
	expect(gptModels.every((model) => model.api === "openai-responses")).toBe(true);
	// 单独检查gpt-6-astra的API字面量类型，后面循环没有覆盖它的容量字段。
	expectTypeOf(GITHUB_COPILOT_MODELS["gpt-6-astra"].api).toEqualTypeOf<"openai-responses">();
	// as const把两文字保留为只读字面量元组，使modelId推为两ID联合；不是运行时冻结数组。
	for (const modelId of ["gpt-6-sol", "gpt-6-luna"] as const) {
		// 用该ID联合安全索引目录，取得当前模型引用，不深复制模型数据。
		const model = GITHUB_COPILOT_MODELS[modelId];
		// 循环中每个model.api静态都应为Responses；类型联合必须满足同一精确字面量。
		expectTypeOf(model.api).toEqualTypeOf<"openai-responses">();
		// toMatchObject只检查列出的部分字段，允许模型还有其它字段；嵌套对象也是部分匹配，不代表thinkingLevelMap仅两项。
		expect(model).toMatchObject({
			// 运行API字段必须为Responses。
			api: "openai-responses",
			// 上下文容量精确为1000000，是目录声明值，不是现场塞满上下文验证。
			contextWindow: 1000000,
			// 最大输出精确为128000，未测实际服务限额。
			maxTokens: 128000,
			// 映射至少含off→none、max→max；这是通用思考级到协议文字的目录配置，不在此执行转换器。
			thinkingLevelMap: { off: "none", max: "max" },
		});
	}
});
