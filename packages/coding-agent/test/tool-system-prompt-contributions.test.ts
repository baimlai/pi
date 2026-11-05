import { describe, expect, test } from "vitest";
import { bashToolSystemPromptContribution, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition, editToolSystemPromptContribution } from "../src/core/tools/edit.ts";
import { createFindToolDefinition, findToolSystemPromptContribution } from "../src/core/tools/find.ts";
import { createGrepToolDefinition, grepToolSystemPromptContribution } from "../src/core/tools/grep.ts";
import { createLsToolDefinition, lsToolSystemPromptContribution } from "../src/core/tools/ls.ts";
import {
	createPowerShellToolDefinition,
	powershellToolSystemPromptContribution,
} from "../src/core/tools/powershell.ts";
import { createReadToolDefinition, readToolSystemPromptContribution } from "../src/core/tools/read.ts";
import { createWriteToolDefinition, writeToolSystemPromptContribution } from "../src/core/tools/write.ts";

// 表格每行存工具名、共享的提示词贡献、定义工厂；as const 保留元组顺序和具体函数类型。
// 这里只持有函数引用，尚未调用工具，更不会执行命令或读写 /workspace。
const cases = [
	["read", readToolSystemPromptContribution, createReadToolDefinition],
	["bash", bashToolSystemPromptContribution, createBashToolDefinition],
	["powershell", powershellToolSystemPromptContribution, createPowerShellToolDefinition],
	["edit", editToolSystemPromptContribution, createEditToolDefinition],
	["write", writeToolSystemPromptContribution, createWriteToolDefinition],
	["grep", grepToolSystemPromptContribution, createGrepToolDefinition],
	["find", findToolSystemPromptContribution, createFindToolDefinition],
	["ls", lsToolSystemPromptContribution, createLsToolDefinition],
] as const;

// 登记内置工具定义与公共提示词资料一致性的测试；提示文本本身保持生产代码原值。
describe("built-in tool system prompt contributions", () => {
	// test.each 用表格给下方回调逐行传参数，%s 在测试标题中显示工具名。
	test.each(cases)(
		"keeps the %s tool definition aligned with its contribution",
		// 输入一行资料，建定义并检查片段/规则，无返回；例如 read 定义应使用 read 的共享贡献。
		// _name 未参与断言，仅用于标题；本例不调用 definition.execute，因此不检验工具执行行为。
		(_name, contribution, createDefinition) => {
			// 工厂保存工作目录并组装对象；这个假路径只用作构造参数。
			const definition = createDefinition("/workspace");

			// 片段是字符串，用 toBe 严格比较值。
			expect(definition.promptSnippet).toBe(contribution.snippet);
			// ?? 把缺省规则当空数组；toEqual 深比较规则内容，允许实现复制数组。
			expect(definition.promptGuidelines ?? []).toEqual(contribution.guidelines);
		},
	);

	// 仅 shell 类工具有会话环境暴露开关，再登记两行独立用例。
	test.each([
		["bash", createBashToolDefinition],
		["powershell", createPowerShellToolDefinition],
	] as const)("keeps %s session-environment guidance conditional", (_name, createDefinition) => {
		// 输入工厂，关闭会话环境提示；只构造定义，不运行 shell，也不设置真实环境变量。
		const definition = createDefinition("/workspace", { exposeSessionEnvironment: false });

		// 关闭后规则字段应缺省，区别于字段存在但为空数组。
		expect(definition.promptGuidelines).toBeUndefined();
	});
});
