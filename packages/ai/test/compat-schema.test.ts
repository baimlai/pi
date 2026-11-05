// 检查兼容schema的静态属性类型与default注解归属；不验证某个models.json、不调用API、不真正给配置补默认值。
// Static是类型导入，运行时不会因这行执行校验。
import type { Static } from "@earendil-works/pi-schema";
// Vitest注册/运行测试与值断言；expectTypeOf主要依靠TypeScript泛型检查，普通Vitest通过不等于类型检查通过。
import { describe, expect, expectTypeOf, it } from "vitest";
// 下面导入五份本地构造的规则对象，模块求值会合并兼容字段并检查重复字段的override声明，不加载模型SDK或发请求。
import {
	// Anthropic专有schema，含其自身默认元数据。
	AnthropicMessagesCompatSchema,
	// Bedrock专有schema，用来检查strict默认false注解。
	BedrockCompatSchema,
	// Completions专有规则，与Responses不共享所有缺省值。
	OpenAICompletionsCompatSchema,
	// Responses专有规则，用来检查developer role默认true。
	OpenAIResponsesCompatSchema,
	// Provider通用字段超集，重叠字段经显式通用定义覆盖，不应直接沿用某个API的独占默认。
	ProviderCompatSchema,
} from "../src/providers/compat-schema.ts";

// 从superset规则推导值类型，后面用索引访问类型检查两个字段；不是执行schema编译。
type ProviderCompat = Static<typeof ProviderCompatSchema>;

/** The `default` annotation of each property of an object schema. */
// 提取已构造schema.properties中有default的自有可枚举字段，返回名字→默认值新对象；例default:false应保留。无I/O，不改原schema/用户配置，不递归提取嵌套默认。
// 参数索引签名只保证值unknown，as假设properties可遍历而不验证；不合约输入或getter可以抛错，没有catch。
function defaults(schema: { readonly [keyword: string]: unknown }): Record<string, unknown> {
	// 把properties断言成属性schema字典，default可为任意值；这不是完整规则shape校验。
	const properties = schema.properties as Record<string, { default?: unknown }>;
	// Object.fromEntries把下面筛选/映射的键值对合成新普通对象，不给原配置赋值。
	return Object.fromEntries(
		// Object.entries只列properties自己的可枚举字符串键，回调不会处理继承键或Symbol字段。
		Object.entries(properties)
			// 解构跳过字段名，只按default严格不等undefined保留；false、0、null都留下，不按真值过滤。
			.filter(([, property]) => property.default !== undefined)
			// 把每项改成[name,property.default]二元组，嵌套default对象仍保留原引用。
			.map(([name, property]) => [name, property.default]),
	);
}

// 分组回调注册三例，主体只操作本地规则数据；没有实际provider请求。
describe("compatibility schemas", () => {
	// 静态检查通用超集保留可选字段及三个亲和格式字面量；例supportsStore可为boolean或undefined，不应丢成unknown。无运行对象验证/副作用。
	it("preserves property types in the provider superset", () => {
		// 用索引访问类型抽supportsStore，再要求精确boolean|undefined；expectTypeOf没有实际比较某个配置字段值。
		expectTypeOf<ProviderCompat["supportsStore"]>().toEqualTypeOf<boolean | undefined>();
		// 开始多行泛型类型断言，检查sessionAffinityFormat的联合。
		expectTypeOf<ProviderCompat["sessionAffinityFormat"]>().toEqualTypeOf<
			// 允许三种格式再加undefined，竖线是TS联合类型语法，不是运行时||逻辑。
			"openai" | "openai-nosession" | "openrouter" | undefined
			// 完成泛型调用，不提供值参数；运行空实现不验证远端是否识别这些格式。
		>();
	});

	// 比较各API自身属性default注解；例Responses的supportsDeveloperRole=true，而Completions无thinkingFormat默认。无外部输入，断言失败使同步用例抛错。
	it("preserves API-specific defaults", () => {
		// 提取Completions顶层属性默认表，不执行兼容选项自动侦测。
		const completionsDefaults = defaults(OpenAICompletionsCompatSchema);
		// 要求表没有thinkingFormat默认键，不等于schema根本没有这个可选属性。
		expect(completionsDefaults).not.toHaveProperty("thinkingFormat");
		// 同样要求无supportsLongCacheRetention默认，而不是要求此字段恒false。
		expect(completionsDefaults).not.toHaveProperty("supportsLongCacheRetention");
		// Responses默认表至少含developer role=true；toMatchObject是部分匹配，允许还有其它默认字段。
		expect(defaults(OpenAIResponsesCompatSchema)).toMatchObject({ supportsDeveloperRole: true });
		// 提取Anthropic专有属性默认表。
		const anthropicDefaults = defaults(AnthropicMessagesCompatSchema);
		// 要求不在schema元数据中强制session affinity默认，不测试实际URL自动侦测结果。
		expect(anthropicDefaults).not.toHaveProperty("sendSessionAffinityHeaders");
		// Anthropic默认表至少包含长缓存支持true，未实际创建1小时缓存。
		expect(anthropicDefaults).toMatchObject({ supportsLongCacheRetention: true });
		// Bedrock strict默认false也必须被defaults保留；可区分helper是否错误地过滤所有假值。
		expect(defaults(BedrockCompatSchema)).toMatchObject({ supportsStrictMode: false });
	});

	// 检查通用Provider超集的四个重复字段没有API专属default，例不能让Bedrock的strict=false污染通用配置；只测列出的四项，不断言所有字段都没有默认。
	it("does not assign API-specific defaults to the provider superset", () => {
		// 只提取Provider超集的property default，合并已在导入模块时完成。
		const providerDefaults = defaults(ProviderCompatSchema);
		// 通用developer role不带Responses特有true默认。
		expect(providerDefaults).not.toHaveProperty("supportsDeveloperRole");
		// 通用session affinity不带某API专属默认。
		expect(providerDefaults).not.toHaveProperty("sendSessionAffinityHeaders");
		// 通用长缓存支持不强制某API默认。
		expect(providerDefaults).not.toHaveProperty("supportsLongCacheRetention");
		// 通用strict不带Bedrock等API的默认false；后续请求策略不由本例执行。
		expect(providerDefaults).not.toHaveProperty("supportsStrictMode");
	});
});
