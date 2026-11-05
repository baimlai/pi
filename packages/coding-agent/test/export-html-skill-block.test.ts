// 技能显示的源码文本回归：只读查看器源码并搜索关键名字/调用文字；四用例均未执行技能解析/DOM或读取真实SKILL.md。
// 从Node内置fs导入同步读取，fs不带node:前缀也仍是内置模块。
import { readFileSync } from "fs";
// 导入测试分组、断言和用例注册函数。
import { describe, expect, it } from "vitest";

// 这组原英文描述期待的产品行为；实际断言仅证明某些源码子串/正则存在，注释文本也可能匹配。
describe("export HTML skill block rendering", () => {
	// 在分组回调中读实际template.js，模块相对URL避免依赖执行cwd，各用例复用该字符串。
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

	// 第一例保护技能包装解析与用户追加文字的代码线索，不构造包装输入验证真正输出。
	it("strips skill wrapper XML from user message rendering", () => {
		// Skill commands store a structural wrapper in the raw user message:
		//   <skill name="..." location="...">\n...\n</skill>\n\nactual prompt
		// The export renderer must detect that wrapper and render only the user-visible prompt,
		// not the Pi-generated <skill>...</skill> XML tags.
		// 查源码含parseSkillBlock名字；无法仅凭匹配判断该函数真的被调用或正确解析。
		expect(templateJs).toMatch(/parseSkillBlock/);
		// 转义点号匹配skillBlock.userMessage字段文字，意图保证用户追加内容有独立处理。
		expect(templateJs).toMatch(/skillBlock\.userMessage/);
	});

	// 第二例的意图是技能区与用户区同级显示；两个名字存在并不能完整证明HTML嵌套结构。
	it("renders skill invocation and user message as separate sibling blocks", () => {
		// The skill block and user message should render as separate entry-level elements,
		// matching the TUI layout where SkillInvocationMessageComponent and
		// UserMessageComponent are siblings, not nested.
		// 匹配skill-invocation类名字样，不启动页面或检查真实同级节点。
		expect(templateJs).toMatch(/skill-invocation/);

		// When a skill block has a userMessage, the user-message div must be emitted
		// as a separate block after the skill-invocation div, containing the user-authored text.
		// Verify the code checks hasUserContent so the user-message div is only omitted
		// when the skill block has no user prompt and no images.
		// 匹配hasUserContent变量名；实际实现还考虑图片，但本断言不直接验证无用户文字/有图的结果。
		expect(templateJs).toMatch(/hasUserContent/);
	});

	// 第三例找技能正文交Markdown解析的调用文字，不在此真的渲染一段Markdown。
	it("renders skill content as markdown, not raw text", () => {
		// The skill block body is markdown (from the SKILL.md file).
		// It should be rendered through safeMarkedParse, not escaped as raw text.
		// 括号和点转义成字面符号，要求safeMarkedParse(skillBlock.content)文字存在；不证明所有执行分支都到达它。
		expect(templateJs).toMatch(/safeMarkedParse\(skillBlock\.content\)/);
	});

	// 第四例想保护侧栏的技能角色显示线索，具体技能名/用户问题仍由实际树函数生成。
	it("shows skill name and user message in the sidebar tree", () => {
		// The sidebar tree should display both the skill name and the user prompt,
		// not just one or the other.
		// 只匹配tree-role-skill文字，没有分别断言技能名与用户文字值，也不检查浏览器显示。
		expect(templateJs).toMatch(/tree-role-skill/);
	});
});
