// 把仓库内置的JSON Schema官方数据登记成Vitest用例：每个输入分别比规范预期、比errors与check是否一致。已知不支持项用it.fails要求仍失败，不是跳过；资源均从本地fixture读取。
// The official JSON-Schema-Test-Suite, drafts 2020-12 and 7: every test, including optional and format tests.
// A test listed in KNOWN_FAILURES must fail; when one starts passing, remove it from the list.

// Vitest提供分组、普通/预期失败用例及布尔断言，登记测试不等于此刻执行每个数据。
import { describe, expect, it } from "vitest";
// 标准格式检查函数表，只为下面特定格式测试显式启用，不改全局默认。
import { formats } from "../src/formats/index.ts";
// compile实际编译每组规则，check/errors走本库真实实现，不是比较预生成答案。
import { compile } from "../src/index.ts";
// suiteFiles读两版测试数据，suiteSchemas读它们引用的本地资源；函数名remote不代表会发HTTP。
import { suiteFiles, suiteSchemas } from "./suite.ts";

// Set存完整“文件 > 分组 > 输入描述”字符串，精确匹配已知失败；文案改动也会使原条目失配，不按关键词模糊略过。
const KNOWN_FAILURES = new Set([
	// Vocabularies switched off by a custom meta-schema are not supported.
	// 此项记录不支持自定义meta-schema关闭validation词汇的规范预期，断言失败属已知差异。
	"draft2020-12/vocabulary > schema that uses custom metaschema with with no validation vocabulary > no validation: invalid number, but it still validates",
	// 此项记录显式format-assertion:false的已知差异；它不在下方/optional/format/目录匹配范围。
	"draft2020-12/optional/format-assertion > schema that uses custom metaschema with format-assertion: false > format-assertion: false: invalid string",
	// format-assertion:true的已知差异单独列项，不是自动为全部格式测试关闭断言。
	"draft2020-12/optional/format-assertion > schema that uses custom metaschema with format-assertion: true > format-assertion: true: invalid string",
	// A $ref to a document of another draft is evaluated with the compile's draft.
	// 现代draft引用历史draft时当前仍用compile所选draft，本条指定一个因此失败的输入。
	"draft2020-12/optional/cross-draft > refs to historic drafts are processed as historic drafts > first item not a string is valid",
	// 反向跨draft的具体失败也按完整路径登记，不将整个cross-draft文件标失败。
	"draft7/optional/cross-draft > refs to future drafts are processed as future drafts > missing bar is invalid",
	// contentMediaType and contentEncoding are annotations.
	// 内容media/encoding当前作注解，因此某些规范要求检查内容的输入会出现已知差异。
	"draft7/optional/content > validation of string-encoded content based on media type > an invalid JSON document",
	// 非法base64的这一例是精确已知项，不代表所有base64行为都已实现。
	"draft7/optional/content > validation of binary string-encoding > an invalid base64 string (% is not a valid character)",
	// 另一个涉及媒体类型的解码后非法JSON实例。
	"draft7/optional/content > validation of binary-encoded media type documents > a validly-encoded invalid JSON document",
	// 同时涉及base64/JSON的最后一条已知项；后面errors一致性测试仍正常运行。
	"draft7/optional/content > validation of binary-encoded media type documents > an invalid base64 string that is valid JSON",
]);

// 登记阶段同步读一份资源表，本文件所有组选项共用；重复调用suiteSchemas才会得到新解析对象。
const schemas = suiteSchemas();

// for...of遍历两版所有测试数据文件，包含optional分组，但实际执行仍可被命令行名字过滤。
for (const file of suiteFiles()) {
	// Format tests assert formats; everywhere else `format` is an annotation, as draft 2020-12 specifies.
	// 每份文件新建编译选项，供这份文件所有group共用。
	const options = {
		// draft来自目录映射，不根据group.schema的$schema自动换版本。
		draft: file.draft,
		// schemas属性简写传前面本地预登记资源表，引用URL只作键查找。
		schemas,
		// 只有文件名含精确/optional/format/才传格式表；其他format为注解，不把format-assertion目录一概当此格式目录。
		formats: file.name.includes("/optional/format/") ? formats : undefined,
	};
	// 报告外层分组名取文件相对路径，方便按draft/关键字过滤。
	describe(file.name, () => {
		// 每份JSON可以包含多个规则组，同一组所有输入共享该schema数据。
		for (const group of file.groups) {
			// 第二层描述是group.description，已知失败键也含这段文字。
			describe(group.description, () => {
				// 逐条输入登记两项测试，不把valid:false当测试该失败或跳过的意思。
				for (const test of group.tests) {
					// 模板字符串组完整身份，Set.has只决定第一项用it还是it.fails；不会改validator结果。
					const known = KNOWN_FAILURES.has(`${file.name} > ${group.description} > ${test.description}`);
					// 已知项用it.fails：回调必须抛断言等异常才算通过，若今后实现修好使回调不抛，这项会失败提醒移出名单；不等于证明一定以预想原因失败。
					(known ? it.fails : it)(test.description, () => {
						// 每个用例独立编译group.schema，避免用上一输入的验证器运行状态当结果。
						const validator = compile(group.schema, options);
						// test.valid是官方输入应合法的布尔值，toBe比较真实check，不把非法输入一律当测试失败。
						expect(validator.check(test.data)).toBe(test.valid);
					});
					// 第二项始终是普通it，要求错误列表是否为空与本库自身check一致；它不再独立比较官方test.valid。
					it(`${test.description} (errors agree with check)`, () => {
						// 此项再建独立验证器，首次errors可能按需构建Explainer。
						const validator = compile(group.schema, options);
						// 读取实际解释结果，用户数据不在此执行转换。
						const errors = validator.errors(test.data);
						// 空错误数组应等价于check=true；即便第一项是已知规范差异，这个内部一致性条件仍须满足。
						expect(errors.length === 0).toBe(validator.check(test.data));
					});
				}
			});
		}
	});
}
