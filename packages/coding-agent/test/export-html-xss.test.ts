// HTML导出转义的源码回归：九例只读查看器源码、匹配允许协议与转义调用的文字线索，不执行攻击样本或浏览器DOM。
// 同步读仓库内template.js；Node的fs内置模块省略node:前缀仍可导入。
import { readFileSync } from "fs";
// Vitest的describe/it注册分组和用例，expect提供正则/子串与否定断言。
import { describe, expect, it } from "vitest";

// 原分组名强调Markdown链接处理，但后面也检查图片、条目ID、树字段与页头模型名的转义线索。
describe("export HTML markdown link sanitization", () => {
	// new URL按本模块位置解析查看器文件，UTF8读为字符串，各用例复用；检查源码文本时注释也在匹配范围。
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

	// 第一例检查自定义链接方法、URL检查调用和允许协议正则的三个文字片段；它们同时存在不独立证明真实控制流一定相连。
	it("overrides the marked link renderer to use scheme allow-list sanitization", () => {
		// \s*允许link与括号/token间的零个或多个空白，转义括号按字面匹配方法头。
		expect(templateJs).toMatch(/link\s*\(\s*token\s*\)/);
		// 要求sanitizeMarkdownUrl(token.href)调用文字，转义点/括号避免按正则元字符解释。
		expect(templateJs).toMatch(/sanitizeMarkdownUrl\(token\.href\)/);
		// 这里的转义^、括号、?和竖线是在查另一段正则的源码文字，意图定位http/https/mailto/tel/ftp允许列表，不是在测试中访问这些协议。
		expect(templateJs).toMatch(/\^\(https\?\|mailto\|tel\|ftp\)/);
	});

	// 第二例检查图片renderer也有URL检查线索；相同sanitize调用可在其它位置命中，不能单凭这个正则证明属于image方法。
	it("overrides the marked image renderer to use scheme allow-list sanitization", () => {
		// 匹配image(token)方法头及可选空白，不创建真实图片元素。
		expect(templateJs).toMatch(/image\s*\(\s*token\s*\)/);
		// 再找URL检查调用的文字，未输入具体恶意src验证返回值。
		expect(templateJs).toMatch(/sanitizeMarkdownUrl\(token\.href\)/);
	});

	// 第三例寻找去控制字符的替换语句，并排除一段旧式协议拒绝模式；是源码约束，不做完整URL规范化测试。
	it("strips C0 controls before checking and emitting markdown URLs", () => {
		// 双层转义使JS字符串值包含反斜杠x00/x1f/x7f；toContain逐字查替换表达式，不在此把控制字符写进URL。
		expect(templateJs).toContain("replace(/[\\x00-\\x1f\\x7f]/g, '')");
		// not.toMatch断言指定旧黑名单模式的源码片段不存在，末尾i只让这次源码匹配忽略大小写，不证明任意危险协议都已拒绝。
		expect(templateJs).not.toMatch(/\^\\s\*\(javascript\|vbscript\|data\):/i);
	});

	// 第四例意图保护href属性转义，实际仅查escapeHtml(href)调用文字，不验证引号攻击的输出。
	it("escapes href attributes in the custom link renderer", () => {
		// The link renderer must escape href values to prevent attribute breakout
		// 存在转义调用并不单独证明所有href写入路径都经过该函数，或调用位于link方法。
		expect(templateJs).toMatch(/escapeHtml\(href\)/);
	});

	// 第五例同时排除裸MIME插值并寻找带转义的MIME使用，避免仅做肯定匹配。
	it("escapes image mimeType attributes", () => {
		// Image mimeType must be escaped to prevent attribute breakout
		// 转义美元/花括号，按字面找模板插值img.mimeType；not要求它不出现在整个源码文本。
		expect(templateJs).not.toMatch(/\$\{img\.mimeType\}/);
		// 查escapeHtml(img.mimeType这一调用开头，后面可继续有默认值等表达式；不等检查完整闭合调用。
		expect(templateJs).toMatch(/escapeHtml\(img\.mimeType/);
	});

	// 第六例检查图片Base64属性拼接的裸插值与转义插值两种特定写法，不对任意等价JS表达式做语义分析。
	it("escapes image data attributes", () => {
		// Image data is embedded in src attributes and must not allow attribute breakout.
		// 禁止在;base64,后直接插img.data再闭双引号的文字模式。
		expect(templateJs).not.toMatch(/;base64,\$\{img\.data\}"/);
		// 要求数据走escapeHtml，\|\|匹配字面或运算符，(?:''|"")允许两种空串引号；非捕获组只组织分支，不额外取结果。
		expect(templateJs).toMatch(/;base64,\$\{escapeHtml\(img\.data \|\| (?:''|"")\)\}"/);
	});

	// 第七例检查两类DOM属性的条目ID插值，分别排除裸值并要求对应转义模板。
	it("escapes entry IDs before inserting them into attributes", () => {
		// Session entry IDs are embedded in id and data-entry-id attributes.
		// 禁止id双引号属性直接插entryId的固定源码写法。
		expect(templateJs).not.toMatch(/id="\$\{entryId\}"/);
		// 同样禁止data-entry-id直接插裸entryId。
		expect(templateJs).not.toMatch(/data-entry-id="\$\{entryId\}"/);
		// 要求entry-前缀后使用escapeHtml(entry.id)的插值文字，字段id与上面局部entryId名字不同。
		expect(templateJs).toMatch(/entry-\$\{escapeHtml\(entry\.id\)\}/);
		// 要求data-entry-id属性使用escapeHtml(entryId)，不在此真的调用DOM查询或点链接。
		expect(templateJs).toMatch(/data-entry-id="\$\{escapeHtml\(entryId\)\}"/);
	});

	// 第八例对五种树动态字段各做否定/肯定文本匹配，不实际渲染包含恶意元数据的树。
	it("escapes tree metadata rendered from session fields", () => {
		// The tree renders session metadata via innerHTML, so dynamic fields must be escaped.
		// 排除方括号工具名里直接使用toolName或tool后备值的原写法；空白与单引号是这份模式的一部分。
		expect(templateJs).not.toMatch(/\[\$\{msg\.toolName \|\| 'tool'\}\]/);
		// 排除方括号角色文字直接插msg.role的写法。
		expect(templateJs).not.toMatch(/\[\$\{msg\.role\}\]/);
		// 排除model标签直接插entry.modelId的写法。
		expect(templateJs).not.toMatch(/\[model: \$\{entry\.modelId\}\]/);
		// 排除thinking标签直接插entry.thinkingLevel的写法。
		expect(templateJs).not.toMatch(/\[thinking: \$\{entry\.thinkingLevel\}\]/);
		// 排除方括号标签直接插entry.type的写法。
		expect(templateJs).not.toMatch(/\[\$\{entry\.type\}\]/);
		// 要求工具名或tool后备值整体先escapeHtml；并不验证默认值选择是否符合业务。
		expect(templateJs).toMatch(/\$\{escapeHtml\(msg\.toolName \|\| 'tool'\)\}/);
		// 要求msg.role的转义插值文字存在。
		expect(templateJs).toMatch(/\$\{escapeHtml\(msg\.role\)\}/);
		// 要求entry.modelId的转义插值文字存在。
		expect(templateJs).toMatch(/\$\{escapeHtml\(entry\.modelId\)\}/);
		// 要求entry.thinkingLevel的转义插值文字存在。
		expect(templateJs).toMatch(/\$\{escapeHtml\(entry\.thinkingLevel\)\}/);
		// 要求entry.type的转义插值文字存在；五个肯定匹配不独立枚举所有可能HTML输出位置。
		expect(templateJs).toMatch(/\$\{escapeHtml\(entry\.type\)\}/);
	});

	// 第九例保护页头模型汇总文字的转义线索；未运行统计函数、插innerHTML或证明整页对任意输入安全。
	it("escapes model names in the exported header", () => {
		// Assistant message provider/model values are collected from the session and rendered with innerHTML.
		// 排除models.join(', ')后取unknown后备值却未转义的指定模板片段。
		expect(templateJs).not.toMatch(/\$\{globalStats\.models\.join\(', '\) \|\| 'unknown'\}/);
		// 要求join/后备值的最终结果整体交escapeHtml再插值；这里只检查固定源码形式，没有把原模型名发送给浏览器。
		expect(templateJs).toMatch(/\$\{escapeHtml\(globalStats\.models\.join\(', '\) \|\| 'unknown'\)\}/);
	});
});
