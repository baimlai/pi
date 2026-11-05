// 文件导读：packages/ai 的模型兼容配置 schema（JSON Schema 规则 + 推导出的 TypeScript 类型）。
//
// 所属模块：AI provider 适配层。不同 OpenAI/Anthropic/Bedrock/Mistral 兼容服务在请求字段、工具、缓存、
// 路由和图像格式上存在差异；本文件把这些差异定义成可配置的 compat 字段，而不是在导入时探测服务或写死分支。
//
// 职责边界：本文件只定义“规则数据”和类型，不读取 models.json、不发请求、不执行 URL 自动检测、不修改请求。
// description/default/examples 是给文档和生成器看的元数据，不是运行时默认值或自动补值逻辑。字段通过规则只说明
// 配置形状合法，不保证服务器实际支持该能力。对象类规则（各 *CompatSchema、路由对象、ProviderCompatSchema 等）
// 通过 openObject 开放额外属性，未知字段可通过规则；标量与联合规则不适用这一说明。适配器未识别的字段不会因此生效。
//
// 上游入口：消费者通过包导出子路径 @earendil-works/pi-ai/providers/compat-schema 导入。
// packages/coding-agent/src/core/pi-ai-schemas.ts 把 ProviderCompatSchema 用 Type.Unsafe 转成 TypeBox 规则，供
// models.json 的运行时校验；packages/coding-agent/scripts/generate-schemas.ts 生成 JSON Schema 文件，
// generate-references.ts 生成字段参考文档。
// 下游结果：schema 常量、CompatSchemasByApi 映射和由 Static 推导的 TS 类型；本文件不会在运行时校验某个具体配置对象。
// 错误流向：mergeCompatProperties 在模块求值时同步抛 Error（重复字段缺通用覆盖，或覆盖项不对应重复字段），
// 导致导入失败；字段值本身的校验错误发生在消费方编译/校验配置时，而不是定义 schema 时。
//
// 能力清单（导出项）：
//   - SessionAffinityFormatSchema / ThinkingTokenBudgetFieldSchema / ChatTemplateKwargValueSchema：
//     分别约束会话亲和头格式、思考预算字段名、聊天模板参数值（标量或 {$var,...} 对象）。
//   - OpenRouterRoutingSchema / VercelGatewayRoutingSchema / AnthropicAllowedFallbackModelSchema：
//     分别约束 OpenRouter 路由偏好、Vercel 网关排序偏好、Anthropic 服务端拒答后的后备模型（含本地价格）。
//   - OpenAICompletionsCompatSchema / OpenAIResponsesCompatSchema / AnthropicMessagesCompatSchema /
//     BedrockCompatSchema / MistralConversationsCompatSchema / SystemOneCompatSchema：
//     六种 API 各自的字段表；同名能力在各表中的默认注解可能不同。
//   - CompatSchemasByApi：API 标识到对应规则的只读映射；未列出的 API 不会自动获得通用规则。
//   - ProviderCompatSchema：所有 API 字段的供应商级超集，用于不区分 API 的兼容覆盖。
//   - 类型 ChatTemplateKwargValue / ProviderCompat / ThinkingTokenBudgetField / SessionAffinityFormat：
//     由 Static 从规则推导的编译期值类型，编译后擦除。
//   - 接口 OpenRouterRouting / VercelGatewayRouting / AnthropicAllowedFallbackModel 与六个 *Compat 接口：
//     继承对应 Schema 的静态形状，供调用方标注配置；没有运行时类或校验行为。
//
// 组合与典型调用顺序：私有字段表（如 OpenAICompletionsCompatProperties）→ 各 openObject 生成 API 专用 schema →
// mergeCompatProperties 合并六组并检查重复覆盖 → ProviderCompatSchema；CompatSchemasByApi 直接引用各专用 schema。
// 消费方通常先导入 ProviderCompatSchema，转成运行时校验器后验证 models.json；或只导入 ProviderCompat 做编译期检查。
//
// 示例（真实签名，编译期）：
//   import type { ProviderCompat } from "@earendil-works/pi-ai/providers/compat-schema";
//   const compat: ProviderCompat = { supportsStore: false, sessionAffinityFormat: "openai" };
//   // 只是类型标注；示例中的值在运行时不会被本文件校验，也不会自动探测该服务是否真的支持。
//
// 建议阅读顺序：先看文件顶部的导入与 sessionAffinityFormat 等小型规则构造器，理解 Schema/Optional 的组合；
// 再按 API 读各 *CompatProperties 字段表；然后读 UnionToIntersection、MergedCompatProperties 和
// mergeCompatProperties 理解类型级与运行时的合并；最后看 CompatSchemasByApi、ProviderCompatSchema 和各类型别名。
import {
	// 描述元数据的泛型接口；例如 Annotations<boolean> 让 default 只能按布尔类型填写，但运行时不替用户配置赋值。
	type Annotations,
	// 构造数组的 items/长度规则；这里调用 arr 不会遍历用户数组。
	arr,
	// 构造布尔规则，实际检查时才区分 false 与字符串 "false"。
	bool,
	// 构造只接受 null 的分支；null 和对象属性省略是两回事。
	nul,
	// 构造 number 规则；没有 minimum/integer 等条件时不额外限制正负或整数。
	num,
	// 把对象字段包装成可选；openObject 内部拆包并从 required 排除，不等于给字段填默认值。
	opt,
	// 属性名到 Schema/Optional 的只读映射类型，用于字段表和合并泛型，不在运行时校验映射。
	type Properties,
	// 从规则携带的类型品牌提取 TS 值类型；type 导入会擦除，不会因此启动验证器。
	type Static,
	// 构造字符串规则；长度或具体候选还需显式给出，普通 str() 不代表有效 URL 或供应商名。
	str,
	// 构造 anyOf 联合规则：实际值只需满足一个分支，不要求同时满足全部。
	union,
} from "@earendil-works/pi-schema";
// 复用价格规则：基础四项费率必填，tiers 可省；这里不请求价格、计算账单或验证供应商授权。
import { ModelCostSchema } from "./model-schema.ts";
// 三个本地构造器分别表示开放对象、单个字符串值、字符串键参数表；它们返回规则数据，不执行验证。
import { openObject, stringLiteral, stringRecord } from "./schema-builders.ts";

// 创建会话亲和头格式的三选一规则；输入可选元数据，返回带字面量联合的 Schema，无 I/O。
// 例如传 description 只给规则附说明；"openai-nosession" 是一种头格式，不是取消整个会话功能。
function sessionAffinityFormat(options?: Annotations<"openai" | "openai-nosession" | "openrouter">) {
	// 三个 const 字符串分支只允许对应格式文字；options 转给 union，不在此发送任何请求头。
	return union([stringLiteral("openai"), stringLiteral("openai-nosession"), stringLiteral("openrouter")], options);
}

// 创建并导出通用格式规则；export const 公开的是运行时规则对象，下面的类型别名才是纯编译期内容。
export const SessionAffinityFormatSchema = sessionAffinityFormat({
	// 说明用途是让相关请求携带路由亲和信息；这是请求偏好，不保证网关选中同一实例或缓存命中。
	description: "Session-affinity header format used to route related requests consistently.",
});

// 创建顶层思考预算字段名的三选一规则，输入可选说明，返回规则；不会在这里计算预算。
// 例如值 "thinking_budget" 选择这个请求键名；实际 token 数还由请求选项和适配器计算。
function thinkingTokenBudgetField(
	// 可省略参数用 ?，泛型把 default/examples 限为三个字段名的联合，不是任意字符串。
	options?: Annotations<"thinking_token_budget" | "thinking_budget" | "thinking_budget_tokens">,
) {
	// 返回 anyOf 枚举规则；下面数组保留候选顺序，但选择字段时不是按顺序逐个发送。
	return union(
		[
			// 候选字段 thinking_token_budget，供采用这类顶层预算扩展的服务使用。
			stringLiteral("thinking_token_budget"),
			// 候选字段 thinking_budget；三个候选中选择一个键名，不是同义键自动同时输出。
			stringLiteral("thinking_budget"),
			// 候选字段 thinking_budget_tokens，供例如 llama.cpp 的对应协议扩展使用。
			stringLiteral("thinking_budget_tokens"),
		],
		// 把整份可选元数据交给联合规则，不把它当成第四个预算字段。
		options,
	);
}

// 给通用预算字段规则附公开说明；导入本常量不改变 max_tokens 或实际思考长度。
export const ThinkingTokenBudgetFieldSchema = thinkingTokenBudgetField({
	// 说明各服务采用的字段名差异；字段名匹配只约束配置文字，不检验服务实现版本或实际可用性。
	description:
		'Top-level request field name used by OpenAI-compatible endpoints to cap reasoning tokens. "thinking_token_budget" is used by vLLM, "thinking_budget" by Qwen, DashScope, or SGLang, and "thinking_budget_tokens" by llama.cpp.',
});

// 模板参数值可以是 JSON 标量或变量描述对象；例如 false 原样发出，{$var:"thinking.enabled"} 留待适配器按当前档位解析。
// 不接受普通数组作为参数值；开放变量对象的额外字段仍可保留，但不因此获得执行代码的能力。
export const ChatTemplateKwargValueSchema = union([
	// 字符串字面值分支；这里不解释它是不是模板表达式。
	str(),
	// 数字字面值分支，未加正数或整数约束。
	num(),
	// 布尔字面值分支，保留 false 而不是把它当缺省。
	bool(),
	// 显式 null 分支；它不会自动省略整个参数。
	nul(),
	// 变量描述对象分支：$var 必填，omitWhenOff 可选，额外键开放。
	openObject({
		// $var 是普通属性名，以三个固定字符串声明取值来源，不在此运行变量解析。
		$var: union([
			// 运行时变量表示本次是否请求思考，适配器解析为布尔值。
			stringLiteral("thinking.enabled"),
			// 运行时变量表示模型映射后的思考档位；映射缺失/null 等处理在适配器中。
			stringLiteral("thinking.effort"),
			// 运行时变量读取已计算的思考 token 预算；本规则不生成预算数值。
			stringLiteral("thinking.budget"),
		]),
		// 可选布尔标记：请求没开启思考时是否省略这个变量项；省略条件不是 schema 在这里执行的。
		omitWhenOff: opt(bool()),
	}),
]);

// 为一个指标创建 p50/p75/p90/p99 的开放对象规则；输入指标说明，返回新规则，无计算或 I/O。
// 例如 metric 为延迟时，p90:2 表达第 90 百分位阈值 2；本函数不采样请求，也不校验各分位是否单调。
function percentileCutoffs(metric: string) {
	// 返回开放对象，四个分位字段都可省，因此 {} 也是一个允许的阈值对象。
	return openObject({
		// p50 是可选 number；模板字符串把指标名插入说明文字，表示第 50 百分位，不执行统计。
		p50: opt(num({ description: `${metric} at the 50th percentile.` })),
		// p75 是可选 number；模板字符串把指标名插入说明文字，表示第 75 百分位，不执行统计。
		p75: opt(num({ description: `${metric} at the 75th percentile.` })),
		// p90 是可选 number；模板字符串把指标名插入说明文字，表示第 90 百分位，不执行统计。
		p90: opt(num({ description: `${metric} at the 90th percentile.` })),
		// p99 是可选 number；模板字符串把指标名插入说明文字，表示第 99 百分位，不执行统计。
		p99: opt(num({ description: `${metric} at the 99th percentile.` })),
	});
}

// 构造 OpenRouter 路由偏好的开放对象；例如 {only:["anthropic"]} 是候选配置，不在本地选择或验证可用上游。
// 所有已列路由字段可选，额外键也允许；下列描述中的服务端行为并不由本 schema 实现。
// 这些字段（以及本文件后续同类字段）的 default 只是文档/生成器元数据，opt 只把属性移出 required，不会在配置缺省时补值。
export const OpenRouterRoutingSchema = openObject(
	{
		// 可选布尔备援开关，值本身必须是 boolean。
		// 说明是否允许 OpenRouter 改用备援供应商；default:true 是规则元数据，不会给缺省配置补 true。
		allow_fallbacks: opt(
			bool({ description: "Whether to allow backup providers to serve requests.", default: true }),
		),
		// 可选布尔参数兼容筛选开关。
		require_parameters: opt(
			bool({
				// 声明是否只选支持全部请求参数的上游；本地验证不请求上游能力信息。
				description: "Whether to filter providers to only those that support all parameters in the request.",
				default: false,
			}),
		),
		// 可选的 deny/allow 二选一文字，普通 str 不足以表达这个限制。
		data_collection: opt(
			union([stringLiteral("deny"), stringLiteral("allow")], {
				// deny/allow 表达数据收集路由偏好；验证通过不等于已核验服务的数据处理事实。
				description:
					'Data collection setting. "allow": allow providers that may store or train on data. "deny": only use providers that do not collect user data.',
				default: "allow",
			}),
		),
		// 可选布尔 ZDR 路由偏好。
		// ZDR 指零数据保留；此字段请求限制上游范围，不是本地提供零保留保证。
		zdr: opt(bool({ description: "Whether to restrict routing to only ZDR (Zero Data Retention) endpoints." })),
		// 可选布尔蒸馏许可路由偏好。
		// 请求只路由到允许文本蒸馏的模型，不在这里判断授权条款。
		enforce_distillable_text: opt(
			bool({ description: "Whether to restrict routing to only models that allow text distillation." }),
		),
		// 可选字符串数组，数组元素顺序会保留。
		order: opt(
			arr(str(), {
				// 声明希望按顺序尝试的供应商名或 slug；未限制非空、唯一性或是否真实存在。
				description:
					"An ordered list of provider names or slugs to try in sequence, falling back to the next if unavailable.",
			}),
		),
		// 可选字符串允许列表，不要求至少有一项。
		only: opt(
			arr(str(), {
				// 声明仅允许的上游名称；空数组也符合这个数组规则，实际含义交服务端。
				description: "List of provider names or slugs to exclusively allow for this request.",
			}),
		),
		// 可选字符串忽略列表，允许 []。
		// 这些名字表达希望跳过的上游，不会在 schema 构造阶段删除任何模型。
		ignore: opt(arr(str(), { description: "List of provider names or slugs to skip for this request." })),
		// 可选字符串数组，而不是硬编码的量化等级枚举。
		quantizations: opt(
			arr(str(), {
				// 说明中列 fp16 等示例，但规则仍是 str()，不会把示例当成完整白名单。
				description:
					'A list of quantization levels to filter providers by, for example ["fp16", "bf16", "fp8", "fp6", "int8", "int4", "fp4", "fp32"].',
			}),
		),
		// 可选排序策略，可为任意字符串或开放对象。
		sort: opt(
			union(
				[
					// sort 的字符串分支不限候选；不只接受说明中提到的三种策略。
					str(),
					// sort 的对象分支也是开放对象；下面 by/partition 未声明必填。
					openObject({
						// 可选排序指标文字；没有 enum，因此其他文字也能通过这一字段规则。
						by: opt(str({ description: 'The sorting metric, such as "price", "throughput", or "latency".' })),
						// 可选分区策略，显式 null 也允许，与属性完全缺失不同。
						partition: opt(
							// 把字符串和 null 合为一个字段规则；说明中的 model/none 不是硬限制。
							union([str(), nul()], {
								// 这段说明给出服务端约定的两种常见分区策略，规则本身未把它们枚举化。
								description: 'Partitioning strategy: "model" or "none".',
								default: "model",
							}),
						),
					}),
				],
				{
					// 字符串可表达 price 等策略；对象中的 by 和 partition 都可缺，本地不执行排序。
					description:
						'Sorting strategy. Can be a string such as "price", "throughput", or "latency", or an object.',
				},
			),
		),
		// 可选开放价格对象，各价格字段也都可省。
		// 表达美元价格上限偏好，不计算总账单，也不保证所有字段使用同一计费单位。
		max_price: opt(
			openObject(
				{
					// prompt 可省，值可为 number 或任意字符串，描述单位是每百万输入 token；不在此解析数字字符串或拒绝负数。
					prompt: opt(union([num(), str()], { description: "Price per million prompt tokens." })),
					// completion 可省，值可为 number 或任意字符串，描述单位是每百万输出 token；不在此解析数字字符串或拒绝负数。
					completion: opt(union([num(), str()], { description: "Price per million completion tokens." })),
					// image 可省，值可为 number 或任意字符串，描述单位是每张图片；不在此解析数字字符串或拒绝负数。
					image: opt(union([num(), str()], { description: "Price per image." })),
					// audio 可省，值可为 number 或任意字符串，描述单位是每个音频计费单位；不在此解析数字字符串或拒绝负数。
					audio: opt(union([num(), str()], { description: "Price per audio unit." })),
					// request 可省，值可为 number 或任意字符串，描述单位是每次请求；不在此解析数字字符串或拒绝负数。
					request: opt(union([num(), str()], { description: "Price per request." })),
				},
				// 外层价格说明保留原文；内部 image/audio/request 各有自己的单位，不能据此一概按 token 计价。
				{ description: "Maximum price per million tokens in USD." },
			),
		),
		// 可选 number 或分位阈值对象，未加正数限制。
		preferred_min_throughput: opt(
			union([num(), percentileCutoffs("Minimum tokens per second")], {
				// 表达每秒 token 数的期望下限；数字按服务约定用于 p50，不在本地换算成各分位。
				description: "Preferred minimum throughput in tokens per second. A number applies to p50.",
			}),
		),
		// 可选 number 或延迟分位阈值对象。
		preferred_max_latency: opt(
			union([num(), percentileCutoffs("Maximum latency in seconds")], {
				// 表达延迟秒数的期望上限；该规则不增加请求超时，也不保证达到阈值。
				description: "Preferred maximum latency in seconds. A number applies to p50.",
			}),
		),
	},
	{
		// 对象级说明记路由偏好用途和参考链接；请求构造器才会把该配置放进 provider 字段。
		description:
			"OpenRouter provider routing preferences. Controls which upstream providers OpenRouter routes requests to. Sent as the provider field in the OpenRouter API request body. See https://openrouter.ai/docs/guides/routing/provider-selection.",
	},
);

// 构造 Vercel 网关路由偏好的开放对象；例如 {order:["anthropic","openai"]} 只描述希望的尝试顺序。
// 该规则不发网关请求、不补允许列表；已列的 only/order 都可省，未知字段仍开放。
export const VercelGatewayRoutingSchema = openObject(
	{
		// 可选字符串允许列表，未做去重或供应商存在性检查。
		only: opt(
			arr(str(), {
				// 只允许指定供应商 slug 是请求偏好，不是此规则替服务端做路由选择。
				description:
					'List of provider slugs to exclusively use for this request, for example ["bedrock", "anthropic"].',
			}),
		),
		// 可选字符串优先顺序数组。
		order: opt(
			arr(str(), {
				// 保存希望尝试的上游顺序；不比较它与 only 是否一致，也不验证可用性。
				description: 'List of provider slugs to try in order, for example ["anthropic", "openai"].',
			}),
		),
	},
	{
		// 对象元数据解释网关路由用途；参考 URL 只是文本，构造规则不会访问它。
		description:
			"Vercel AI Gateway routing preferences. Controls which upstream providers the gateway routes requests to. See https://vercel.com/docs/ai-gateway/models-and-providers/provider-options.",
	},
);

// 构造 Anthropic 服务端拒答后备目标的开放对象；provider、model、cost 三项都必填。
// 例如 provider="anthropic"、model="候选模型" 并给完整四费率；规则检查形状，不核验账户是否获准使用该后备模型。
export const AnthropicAllowedFallbackModelSchema = openObject(
	{
		// provider 是至少一个 Unicode 码点的字符串；空白字符串未被 trim，也未受供应商枚举限制。
		provider: str({ minLength: 1 }),
		// model 同样要求非空字符串，不要求本地目录里真实存在；这是服务端后备模型标识。
		model: str({ minLength: 1 }),
		// 复用完整价格规则，基础四费率必填；provider/cost 留本地匹配计价，实际请求只投影 model 字段。
		cost: ModelCostSchema,
	},
	// 对象级说明强调后备是在服务端拒答时使用，价格元数据供客户端处理返回结果，不在此发起重试。
	{ description: "An Anthropic server-side refusal fallback model with local pricing metadata." },
);

// 创建可选布尔字段包装，输入可选说明、返回 Optional<Schema<boolean>>，无验证或 I/O。
// 例如传 default:false 仍允许对象省略此字段；opt 只影响 required，不会自动补 false。
// 本文件所有布尔兼容字段的 default 注解都按同一规则处理：只影响文档/生成器元数据，运行时验证不会填入默认值。
function optionalCompatBoolean(options?: Annotations<boolean>) {
	// 先构造布尔 schema，再包装成可选字段；真正对象 schema 会在 openObject 内拆出原规则。
	return opt(bool(options));
}

// 创建可省略的三选一亲和格式字段，返回 Optional 包装，无请求副作用。
// 例如缺省时不要求此属性；显式给 "openrouter" 时才按三选一文字规则检查。
function optionalSessionAffinityFormat(options?: Annotations<"openai" | "openai-nosession" | "openrouter">) {
	// 复用格式候选再包 opt；? 参数和 opt 字段包装分别对应“参数可省”和“配置属性可省”。
	return opt(sessionAffinityFormat(options));
}

// Completions 专用属性表；字段先以 schema/Optional 形式保存，之后才交 openObject 生成真正的 properties/required。
// 每个开关描述适配器如何拼请求或处理返回，不是对供应商能力的现场探测；未设置时的逻辑由适配器决定。
const OpenAICompletionsCompatProperties = {
	// 可选布尔存储参数能力。
	supportsStore: opt(
		bool({
			// 控制是否发送 store；不配置时适配器可依据 URL 推断，不在 schema 里指定统一默认。
			description: "Whether the provider supports the store field. Default: auto-detected from URL.",
		}),
	),
	// 可选布尔指令角色能力，复用 optionalCompatBoolean。
	supportsDeveloperRole: optionalCompatBoolean({
		// 声明是否采用 developer 代替 system 角色；缺省由端点检测策略决定，不验证角色实际被服务接受。
		description:
			"Whether the provider supports the developer role instead of system. Default: auto-detected from URL.",
	}),
	// 可选布尔 reasoning_effort 能力。
	supportsReasoningEffort: opt(
		bool({
			// 控制支持条件下是否使用思考档位参数；具体协议格式还要看 thinkingFormat，而非只看这一项。
			description: "Whether the provider supports reasoning_effort. Default: auto-detected from URL.",
		}),
	),
	// 可选布尔流内用量能力。
	supportsUsageInStreaming: opt(
		bool({
			// 声明是否支持 stream_options.include_usage；不是要求每个流事件都必须携带 token 用量。
			description:
				"Whether the provider supports stream_options.include_usage for token usage in streaming responses.",
			default: true,
		}),
	),
	// 可选布尔流停止原因能力。
	supportsFinishReason: opt(
		bool({
			// 为 false 时适配器在结束后推断 stop/toolUse；规则不会在这里读取或补写任何流消息。
			description:
				"Whether streamed responses include finish_reason. When false, pi infers stop or toolUse when the stream ends.",
			default: true,
		}),
	),
	// 可选二选一字段名，只允许 max_completion_tokens/max_tokens。
	maxTokensField: opt(
		union([stringLiteral("max_completion_tokens"), stringLiteral("max_tokens")], {
			// 选择输出上限写到哪个请求键，缺省由适配器推断；这里配置的是键名，不是 token 数值。
			description: "Which field to use for max tokens. Default: auto-detected from URL.",
		}),
	),
	// 可选布尔工具结果名称要求。
	// 声明工具结果是否需补 name；适配器按此转换消息，schema 不执行工具或查找名称。
	requiresToolResultName: opt(
		bool({ description: "Whether tool results require the name field. Default: auto-detected from URL." }),
	),
	// 可选布尔消息衔接要求。
	requiresAssistantAfterToolResult: opt(
		bool({
			// 声明工具结果后接用户消息时是否需插入 assistant 消息；不会因为建立规则就更改历史。
			description:
				"Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL.",
		}),
	),
	// 可选布尔思考重放格式要求。
	requiresThinkingAsText: opt(
		bool({
			// 声明是否把思考块转成带 <thinking> 分隔的文本块，属于发送历史的兼容处理，不是让模型一定显示思考。
			description:
				"Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL.",
		}),
	),
	// 可选布尔 reasoning_content 补位要求。
	requiresReasoningContentOnAssistantMessages: opt(
		bool({
			// 思考启用时是否要求重放的 assistant 消息含 reasoning_content；适配器可补空串，规则只接受布尔配置。
			description:
				"Whether all replayed assistant messages must include an empty reasoning_content field when reasoning is enabled. Default: auto-detected from URL.",
		}),
	),
	// 可选思考参数格式枚举，下面逐项列出候选。
	thinkingFormat: opt(
		union(
			[
				// 普通 OpenAI 风格，使用顶层 reasoning_effort；是否实际发送仍受档位与能力条件限制。
				stringLiteral("openai"),
				// OpenRouter 风格，将档位放在 reasoning.effort。
				stringLiteral("openrouter"),
				// DeepSeek 风格，使用 thinking.type，并在支持时另给 reasoning_effort。
				stringLiteral("deepseek"),
				// Together 风格，使用 reasoning.enabled 和可选顶层 effort。
				stringLiteral("together"),
				// Baseten 风格，用配置的 chat_template_args，并按能力决定 effort。
				stringLiteral("baseten"),
				// Z.AI 风格，用 thinking.type 及相关兼容处理，不是普通字符串 thinking。
				stringLiteral("zai"),
				// Qwen 顶层 enable_thinking 布尔开关格式。
				stringLiteral("qwen"),
				// 通用模板格式，把配置字典解析为 chat_template_kwargs。
				stringLiteral("chat-template"),
				// Qwen 特定模板格式，使用 enable_thinking/preserve_thinking，不等于通用参数字典。
				stringLiteral("qwen-chat-template"),
				// 顶层 thinking 为字符串的格式，与 thinking:{type:...} 对象格式不同。
				stringLiteral("string-thinking"),
				// Ant Ling 格式，只有映射结果为字符串时才发送 reasoning.effort，不把缺映射自动当成原档位。
				stringLiteral("ant-ling"),
			],
			{
				// 选择 reasoning_effort、thinking 或模板参数等不同请求结构；具体开启条件还结合模型 reasoning、请求档位与能力开关。
				description:
					'Format for reasoning or thinking parameters. When omitted, Pi auto-detects the format from the provider URL. "openai" uses reasoning_effort, "openrouter" uses reasoning.effort, "deepseek" uses thinking.type plus reasoning_effort when supported, "together" uses reasoning.enabled plus reasoning_effort when supported, "baseten" uses configurable chat_template_args plus reasoning_effort when supported, "zai" uses thinking.type, "qwen" uses top-level enable_thinking, "qwen-chat-template" uses chat_template_kwargs.enable_thinking and preserve_thinking, "chat-template" uses configurable chat_template_kwargs, "string-thinking" uses top-level thinking, and "ant-ling" uses reasoning.effort only when the mapped effort is non-null.',
			},
		),
	),
	// 可选参数名字典，值复用标量/变量规则。
	chatTemplateKwargs: opt(
		// 字典用 patternProperties 的 ^.*$ 约束匹配键；无 s/m 时含换行的键不一定匹配，额外属性未关闭，不能当成所有 JS 键都已验证。
		stringRecord(ChatTemplateKwargValueSchema, {
			// 在 chat-template 分支生成 chat_template_kwargs；$var 由适配器解析，不执行任意模板代码。
			description:
				'Kwargs sent as chat_template_kwargs when thinkingFormat is "chat-template". Use $var with "thinking.enabled", "thinking.effort", or "thinking.budget" for pi-controlled values.',
		}),
	),
	// 可选的 Baseten 参数字典，和 kwargs 使用相同值规则。
	chatTemplateArgs: opt(
		// 字典用 patternProperties 的 ^.*$ 约束匹配键；无 s/m 时含换行的键不一定匹配，额外属性未关闭，不能当成所有 JS 键都已验证。
		stringRecord(ChatTemplateKwargValueSchema, {
			// 在 baseten 分支生成 chat_template_args；不会自动把字典里的键改名成 kwargs。
			description:
				'Arguments sent as chat_template_args when thinkingFormat is "baseten". Use $var with "thinking.enabled", "thinking.effort", or "thinking.budget" for pi-controlled values.',
		}),
	),
	// 可选 OpenRouter 路由对象，直接复用前面的开放规则。
	// 请求构造器把该对象放入 provider；这里只有规则关联，不在本地决定上游或路由成功。
	openRouterRouting: opt(OpenRouterRoutingSchema),
	// 可选 Vercel 网关路由对象。
	// 适配器提取 only/order 形成 providerOptions.gateway；额外字段允许存在，不代表适配器也会转发全部键。
	vercelGatewayRouting: opt(VercelGatewayRoutingSchema),
	// 可选布尔 Z.AI 工具流扩展开关。
	zaiToolStream: opt(
		bool({
			// 控制是否使用顶层 tool_stream 获取工具参数增量，和是否执行工具是两个步骤。
			description: "Whether z.ai supports top-level tool_stream for streaming tool call deltas.",
			default: false,
		}),
	),
	// 可选的顶层思考预算字段名，复用三选一构造器。
	thinkingTokenBudgetField: opt(
		thinkingTokenBudgetField({
			// 用于发送按请求档位算出的预算；思考与回答共享输出上限，字段声明本身不会限制实际生成 token。
			description:
				'Top-level request field used to cap reasoning tokens from thinkingBudgets. Reasoning and the answer share max_tokens on these endpoints. "thinking_token_budget" is vLLM, "thinking_budget" is Qwen, DashScope, or SGLang, and "thinking_budget_tokens" is llama.cpp. Off by default and not set on the generated catalog.',
		}),
	),
	// 可选布尔旧预算别名。
	supportsThinkingTokenBudget: opt(
		bool({
			// true 对应 thinking_token_budget；显式 thinkingTokenBudgetField 优先，不因别名 false 就覆盖已指定字段。
			description:
				'Alias for thinkingTokenBudgetField: "thinking_token_budget" (vLLM). Prefer thinkingTokenBudgetField.',
			default: false,
		}),
	),
	// 可选布尔语法约束工具能力。
	supportsOpenAIGrammarTools: optionalCompatBoolean({
		// 支持时可使用 Lark/regex custom 工具，不支持时走普通 function 工具回退；schema 不解析语法或执行工具。
		description:
			"Whether the provider supports OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. The generated catalog enables this for capable models.",
		default: false,
	}),
	// 可选布尔中途系统/开发者消息能力。
	supportsMidConvoSystemMessages: optionalCompatBoolean({
		// 为 false 时后续指令折叠到开头，以兼容不接受中途指令的模型；不是删除这些指令。
		description:
			"Whether the exact model accepts system or developer messages after the conversation has started. When false, later system messages are folded into the leading system message. The generated catalog enables this for verified models.",
		default: false,
	}),
	// 可选布尔中途工具新增能力。
	supportsMidConvoToolAdditions: opt(
		bool({
			// 请求级逻辑还要求 supportsMidConvoSystemMessages；本 schema 未建立两个开关必须一致的交叉约束。
			description:
				"Whether system messages can introduce additional tools mid-conversation. Requires supportsMidConvoSystemMessages. The generated catalog enables this for capable models.",
			default: false,
		}),
	),
	// 可选布尔严格工具参数能力。
	supportsStrictMode: optionalCompatBoolean({
		// 决定是否使用工具定义的 strict 字段；服务端严格 schema 与本文件验证兼容选项是不同层次。
		description:
			"Whether the provider supports the strict field in tool definitions. Generated capable models enable it explicitly.",
		default: false,
	}),
	// 可选缓存标记格式，目前只接受字面量 anthropic。
	cacheControlFormat: opt(
		stringLiteral("anthropic", {
			// 选用 Anthropic 风格 cache_control 标记；何时放到指令/工具/会话由适配器执行，不保证缓存命中。
			description:
				"Cache control convention for prompt caching. Anthropic applies cache_control markers to the system prompt, last tool definition, and last user, assistant, or tool-result text content.",
		}),
	),
	// 可选布尔亲和头发送开关。
	sendSessionAffinityHeaders: optionalCompatBoolean({
		// 按 options.sessionId 生成路由亲和信息；缺省对识别为 OpenRouter 的端点启用，其他端点由策略处理。
		description:
			"Whether to send session-affinity data from options.sessionId. Default: true for OpenRouter endpoints, false otherwise.",
	}),
	// 可选三选一亲和头格式，与发送开关分开。
	sessionAffinityFormat: optionalSessionAffinityFormat({
		// 决定 session_id/x-client-request-id/x-session-affinity 或 x-session-id 等头的组合；不控制 prompt_cache_key。
		description:
			"Session-affinity header format. openai sends session_id, x-client-request-id, and x-session-affinity; openai-nosession sends x-client-request-id and x-session-affinity; openrouter sends x-session-id. Does not affect prompt_cache_key. Default: auto-detected.",
	}),
	// 可选布尔长期缓存参数能力。
	supportsLongCacheRetention: optionalCompatBoolean({
		// 允许请求长期缓存保留参数，具体对应 24h 或 Anthropic 风格 1h；不是本地计时器或存活期保证。
		description:
			'Whether the provider supports long prompt cache retention (prompt_cache_retention: "24h" or Anthropic-style cache_control.ttl: "1h", depending on format). Default: auto-detected from provider and URL.',
	}),
	// 可选 number 调度优先级；未限制整数、正负或数值范围。
	vllmPriority: opt(
		num({
			// 适配器透传到顶层 priority；说明中越小越早和服务配置要求是远端约定，本规则不调度请求。
			description:
				"vLLM scheduler priority sent as the top-level priority request field. Lower values are handled earlier and the server default is 0. Only meaningful with --scheduling-policy priority. Off by default and not set on the generated catalog.",
		}),
	),
};

// 把整份字段表变成开放对象 schema；例如 {supportsStore:false} 合法，未知字段也不会自动被删除。
export const OpenAICompletionsCompatSchema = openObject(OpenAICompletionsCompatProperties, {
	// 对象级说明把用途定为覆盖自定义服务的 URL 自动检测；本规则不负责执行检测。
	description:
		"Compatibility settings for OpenAI-compatible completions APIs. Use this to override URL-based auto-detection for custom providers.",
	// 显式写出允许额外属性；与 openObject 缺省开放一致，不代表额外值也受到已列字段约束。
	additionalProperties: true,
});

// Responses 专用兼容字段表；有些名字与 Completions 相同，但各自的默认注解和业务描述独立。
const OpenAIResponsesCompatProperties = {
	// 可选布尔 developer 角色能力。
	supportsDeveloperRole: optionalCompatBoolean({
		// Responses 的默认注解为支持 developer；真正默认还由使用此 schema 的请求实现决定。
		description: "Whether the provider supports the developer role instead of system.",
		default: true,
	}),
	// 可选布尔中途指令能力。
	supportsMidConvoSystemMessages: optionalCompatBoolean({
		// 不支持时把中途 developer/system 消息折叠到开头；不在这里改变上下文数组。
		description:
			"Whether the exact model accepts developer or system messages after the conversation has started. When false, later system messages are folded into the leading system message. The generated catalog enables this for verified models.",
		default: false,
	}),
	// 可选三选一亲和格式。
	sessionAffinityFormat: optionalSessionAffinityFormat({
		// Responses 的格式说明涉及 session_id、x-client-request-id 和 OpenRouter 的 x-session-id；不要照搬 Completions 说明中的全部头。
		description:
			"Session-affinity header format. openai sends session_id and x-client-request-id; openai-nosession sends x-client-request-id; openrouter sends x-session-id. Does not affect prompt_cache_key. Default: auto-detected.",
	}),
	// 可选布尔长期缓存能力。
	supportsLongCacheRetention: optionalCompatBoolean({
		// 此协议的说明区分较新模型的 prompt_cache_options.ttl 和旧式 prompt_cache_retention；schema 不按模型版本切字段。
		description:
			'Whether the provider supports long prompt cache retention. This uses prompt_cache_options.ttl: "30m" on GPT-5.6+ and prompt_cache_retention: "24h" on earlier models.',
		default: true,
	}),
	// 可选布尔严格 JSON schema 工具能力。
	supportsStrictMode: optionalCompatBoolean({
		// 这个字段未给统一 default；适配器自身仍可能采用默认 false，生成模型可显式声明支持。
		description:
			"Whether the provider supports strict JSON-schema function tools. Defaults are API-specific; generated OpenAI models enable it explicitly.",
	}),
	// 可选布尔 custom 语法工具能力。
	supportsOpenAIGrammarTools: optionalCompatBoolean({
		// 控制发送 Lark/regex grammar custom 工具还是普通函数工具回退，不在此编译 grammar。
		description:
			"Whether to emit OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. The generated catalog enables this for capable models.",
		default: false,
	}),
	// 可选布尔 additional_tools 输入项能力。
	supportsAdditionalTools: opt(
		bool({
			// 声明是否能把工具新增绑定到历史消息位置，不是给当前请求自动追加工具。
			description: "Whether the model supports message-anchored additional_tools input items.",
			default: false,
		}),
	),
	// 可选布尔客户端工具搜索协议能力。
	supportsToolSearch: opt(
		bool({
			// 声明是否支持客户端执行工具搜索并将新增定义锚到历史；设置 true 不会在这里运行搜索。
			description: "Whether the model supports client-executed tool search for transcript-anchored additions.",
			default: false,
		}),
	),
	// 可选布尔显式缓存模式参数能力。
	supportsExplicitPromptCacheMode: opt(
		bool({
			// 声明是否接受 prompt_cache_options；旧模型可能拒绝该字段，schema 不尝试远端请求来确认。
			description: "Whether the model accepts prompt_cache_options. Older OpenAI models reject the parameter.",
			default: false,
		}),
	),
	// 可选布尔中途思考档位更新能力。
	supportsMidConvoEffort: opt(
		bool({
			// 允许以 configuration_update 历史项表达档位变化，目标是稳定请求前缀；openai 供应商的 ChatGPT 登录路径会忽略这项，不保证缓存命中。
			description:
				"Whether thinking level changes are sent as configuration_update input items instead of changing reasoning.effort, so a change keeps the prompt cache. Only used by the openai-responses API, and ignored with Sign in with ChatGPT on the openai provider.",
			default: false,
		}),
	),
	// 可选布尔输出上限参数能力。
	supportsMaxOutputTokens: opt(
		bool({
			// 控制是否发送 max_output_tokens；部分 Codex 协议网关不接受它，但该规则不按端点自动验证。
			description: "Whether the provider accepts max_output_tokens. Some Codex-protocol gateways reject it.",
			default: true,
		}),
	),
};

// 导出 Responses 专用开放对象规则；Azure/Codex 的映射稍后也会引用同一个规则对象。
export const OpenAIResponsesCompatSchema = openObject(OpenAIResponsesCompatProperties, {
	// 对象级元数据说明适用协议，不因为描述含 Responses 就注册任何 Provider。
	description: "Compatibility settings for OpenAI Responses APIs.",
	// 允许未列字段；不自动把未知兼容项识别成已实现能力。
	additionalProperties: true,
});

// Anthropic Messages 专用兼容字段：工具输入流、缓存断点、思考签名及中途变化等；全部已列属性可省。
const AnthropicMessagesCompatProperties = {
	// 可选布尔逐工具 eager 输入流能力。
	supportsEagerToolInputStreaming: opt(
		bool({
			// false 时不发 tools[].eager_input_streaming，适配器可改用旧细粒度工具流 beta 头；这不是关闭全部工具调用。
			description:
				"Whether the provider accepts per-tool eager_input_streaming. When false, the Anthropic provider omits tools[].eager_input_streaming and sends the legacy fine-grained-tool-streaming-2025-05-14 beta header for tool-enabled requests.",
			default: true,
		}),
	),
	// 可选布尔长期缓存保留能力。
	supportsLongCacheRetention: optionalCompatBoolean({
		// 控制 Anthropic 风格 cache_control.ttl 的长期值，不在此创建服务端缓存。
		description: "Whether the provider supports Anthropic long cache retention through cache_control.ttl.",
		default: true,
	}),
	// 可选布尔缓存路由亲和头开关。
	sendSessionAffinityHeaders: optionalCompatBoolean({
		// 缓存开启且有 sessionId 等条件时请求亲和路由；OpenRouter 默认启用的规则在适配器，不能把说明理解为命中保证。
		description:
			"Whether to send x-session-affinity from options.sessionId when caching is enabled. Required for providers like Fireworks that use session affinity for prompt cache routing; requests to the same replica maximize cache hits. Default: true for OpenRouter endpoints, false otherwise.",
	}),
	// 可选单值格式，本协议这里只允许 openrouter。
	sessionAffinityFormat: opt(
		stringLiteral("openrouter", {
			// openrouter 使用 x-session-id；未指定时适配器可采用 x-session-affinity，不接受本字段填 openai。
			description: "Session-affinity format. openrouter sends x-session-id; when unset, sends x-session-affinity.",
		}),
	),
	// 可选布尔工具声明缓存标记能力。
	supportsCacheControlOnTools: opt(
		bool({
			// false 时省工具定义上的 cache_control，但不必同时删除系统/会话上的缓存标记。
			description:
				"Whether the provider supports Anthropic-style cache_control markers on tool definitions. When false, cache_control is omitted from tool parameters. Some Anthropic-compatible providers, such as Fireworks, do not support this field on tools and may reject or ignore it.",
			default: true,
		}),
	),
	// 可选布尔温度参数能力。
	supportsTemperature: opt(
		bool({
			// 只声明是否支持 temperature；实际发出还受思考启用、管理档位模式及是否提供温度等条件限制。
			description:
				"Whether the model accepts the Anthropic temperature request field. Claude Opus 4.7+ rejects non-default values.",
			default: true,
		}),
	),
	// 可选布尔强制 adaptive 思考格式标记。
	forceAdaptiveThinking: opt(
		bool({
			// 显式 true 可让已启用思考路径用 adaptive 加 effort，而非按旧式固定预算；它本身不绕过关闭思考条件，也不保证所有模型支持。
			description:
				"Whether to force adaptive thinking (thinking.type: adaptive plus output_config.effort) regardless of model ID. Built-in models that require adaptive thinking set this in generated metadata. Custom Anthropic-compatible providers can set this to true for any model whose upstream requires the adaptive format. Set false to opt out on overridden built-in models.",
			default: false,
		}),
	),
	// 可选布尔空思考签名重放策略。
	allowEmptySignature: opt(
		bool({
			// 允许把空签名继续作为原生思考而非转文字；本地兼容选择不证明远端一定接受。
			description: "Whether to replay empty thinking signatures instead of converting thinking to text.",
			default: false,
		}),
	),
	// 可选布尔 Anthropic 严格工具 schema 能力。
	supportsStrictTools: opt(
		bool({
			// 与 Completions 的 supportsStrictMode 名字不同；这里不因支持 Messages 协议就自动启用严格工具。
			description:
				"Whether the provider supports Anthropic strict tool schemas. Generated Anthropic models enable it explicitly.",
			default: false,
		}),
	),
	// 可选布尔思考档位消息/绑定控制能力。
	supportsMidConvoEffort: opt(
		bool({
			// 声明传输是否支持 effort-only 系统消息及思考绑定；这是另一条管理 effort 路径，不等于 forceAdaptiveThinking 标志。
			description:
				"Whether the exact model transport supports effort-only system messages and thinking binding controls.",
			default: false,
		}),
	),
	// 可选布尔历史内 system 消息能力。
	supportsMidConvoSystemMessages: optionalCompatBoolean({
		// 不支持时把后续系统内容折叠进顶层 system；规则不在这里丢弃这些消息。
		description:
			"Whether the exact model accepts system-role messages inside the conversation. When false, later system messages are folded into the top-level system prompt.",
		default: false,
	}),
	// 可选布尔原生工具增删块能力。
	supportsMidConvoToolChanges: opt(
		bool({
			// 实际请求还要求中途系统消息支持和初始工具等条件；schema 没有用 if/then 强制这些字段联动。
			description:
				"Whether the exact model accepts mid-conversation tool_addition and tool_removal blocks. Requires supportsMidConvoSystemMessages.",
			default: false,
		}),
	),
	// 可选后备目标数组，元素复用必填身份/价格规则。
	allowedFallbackModels: opt(
		// 数组每项都按目标对象规则检查；没有 minItems，因此 [] 合法，也未要求候选唯一。
		arr(AnthropicAllowedFallbackModelSchema, {
			// 真正的运行时数组约束是至多 3 项；这里只生成 maxItems，实际验证时才拒绝更长数组。
			maxItems: 3,
			// 用于服务端拒答后备目标的本地允许列表；缺失或 [] 时适配器省 fallbacks，不在客户端逐个自动重试。
			description:
				"Models Anthropic accepts for server-side refusal fallback, with local pricing metadata for returned fallback responses. When absent or empty, callers must omit fallbacks; Anthropic rejects the field for models with no permitted fallback targets.",
		}),
	),
};

// 导出 Anthropic 专用开放对象规则；例如 allowedFallbackModels 给四项会违反上面的数量规则，但普通未知键仍开放。
export const AnthropicMessagesCompatSchema = openObject(AnthropicMessagesCompatProperties, {
	// 对象说明标明适用 Messages 兼容协议，不意味着任意兼容服务都接受所有声明能力。
	description: "Compatibility settings for Anthropic Messages-compatible APIs.",
	// 额外属性保持允许，不做删除未知字段的清洗。
	additionalProperties: true,
});

// Bedrock 专用字段表当前只有 strict 支持开关，不把所有 Completions 能力直接移植到 Converse。
const BedrockCompatProperties = {
	// 可选布尔 Bedrock 严格工具 schema 能力。
	supportsStrictMode: optionalCompatBoolean({
		// 声明模型是否支持 Bedrock 原生严格工具参数；false 注解不等于本地验证器关闭严格验证。
		description: "Whether the model supports Bedrock strict tool schemas.",
		default: false,
	}),
};

// 把 Bedrock 属性表构造成开放对象规则，未列字段仍允许进入数据。
export const BedrockCompatSchema = openObject(BedrockCompatProperties, {
	// 对象说明标明适用于 Bedrock 模型兼容配置，不访问 AWS。
	description: "Compatibility settings for Amazon Bedrock models.",
	// 显式开放额外键，不会验证 AWS 账号、IAM 权限或端点。
	additionalProperties: true,
});

// Mistral Conversations 当前只列中途 system 消息能力，专用协议使用自己的规则对象。
const MistralConversationsCompatProperties = {
	// 可选布尔 Mistral 中途系统消息能力。
	supportsMidConvoSystemMessages: optionalCompatBoolean({
		// 为 false 时后续系统指令折叠到首条指令；这只约束配置字段，消息折叠在请求转换器中执行。
		description:
			"Whether the exact model accepts system messages after the conversation has started. When false, later system messages are folded into the leading system message.",
		default: false,
	}),
};

// 构造 Mistral 专用开放兼容 schema；例如显式 false 是有效配置，而不是缺失值。
export const MistralConversationsCompatSchema = openObject(MistralConversationsCompatProperties, {
	// 对象说明记录 Mistral 聊天协议用途，不加载 SDK 或测试服务能力。
	description: "Compatibility settings for the Mistral chat API.",
	// 额外属性不拒绝，但未列项不会因此被 Mistral 请求构造器自动识别。
	additionalProperties: true,
});

// System One 分类协议的图像兼容字段表；图像输入协议与聊天模型的看图能力是两件事。
const SystemOneCompatProperties = {
	// 可选三选一图像传输格式：assets/images/state-image-urls。
	imageInput: opt(
		union([stringLiteral("assets"), stringLiteral("images"), stringLiteral("state-image-urls")], {
			// 描述资产映射、data URL 列表或状态前 image_url 部件；实际编码与数量检查由分类适配器执行，schema 不读取图片。
			description:
				'How the service takes classifier images. "assets" sends TypeSafe\'s assets map (PNG and JPEG) and references the images from the state, as TypeSafe and Jev on Workers AI expect. "images" sends Clef\'s images list of data URLs (PNG, JPEG, and WebP, at most four), as Clef on Workers AI expects. "state-image-urls" places image_url parts before the state, as OpenRouter expects; OpenRouter drops assets without an error. Auto-detected from the provider, baseUrl, and model ID. Classifier models read it from the provider-level compat; models and modelOverrides entries apply to chat models only.',
		}),
	),
	// 可选布尔图像实验能力确认头开关。
	sendImageOptInHeader: optionalCompatBoolean({
		// 有图像输入时是否附 TypeSafe-Danger-Zone-Images；默认随分类传输检测，false 仍需被保留，这个布尔配置不负责实际图像格式转换。
		description:
			"Whether requests with images send the TypeSafe-Danger-Zone-Images: true header, which TypeSafe's own API requires for its experimental image input. Defaults to true for the typesafe-system-one API unless the model is detected as OpenRouter.",
	}),
};

// 导出 System One 分类专用开放对象规则；同一规则稍后供两种分类 API 映射复用。
export const SystemOneCompatSchema = openObject(SystemOneCompatProperties, {
	// 对象说明界定分类兼容项，不意味着它能作为普通聊天协议选项发出。
	description: "Compatibility settings for System One classifier APIs.",
	// 允许额外属性；图像格式候选的硬限制只适用于 imageInput 这个已列字段。
	additionalProperties: true,
});

// 供应商级兼容配置不预先绑定 API，重复字段用这一组通用规则覆盖，避免继承某个 API 特有的默认说明。
// 例如 Responses 的 developer 默认 true 不能直接当成所有供应商的默认；这里保持可选并移除该专属 default。
const ProviderCompatPropertyOverrides = {
	// 重复的 developer 角色字段改用通用可选布尔规则。
	supportsDeveloperRole: optionalCompatBoolean({
		// 只声明角色能力，由各 API 决定实际默认；这里没有保留 Responses 专有的 default:true。
		description: "Whether the provider supports the developer role instead of system. Defaults are API-specific.",
	}),
	// 重复的中途指令字段，改用跨 API 的通用说明。
	supportsMidConvoSystemMessages: optionalCompatBoolean({
		// 声明支持历史内 system/developer 消息，未支持时由适配器折叠到前导指令；不在这里执行折叠。
		description:
			"Whether the exact model accepts system or developer messages after the conversation has started. When false, later system messages are folded into the leading system message.",
		default: false,
	}),
	// 重复的亲和格式字段，采用通用三选一规则。
	sessionAffinityFormat: optionalSessionAffinityFormat({
		// 不把 Anthropic 的单值格式限制套在所有 API 上；具体默认格式由 API 或检测策略决定。
		description: "Session-affinity header format. Defaults are API-specific or auto-detected.",
	}),
	// 重复的中途思考档位字段使用通用可选布尔规则。
	supportsMidConvoEffort: optionalCompatBoolean({
		// 用会话内变化替代顶层 effort 改动，适用于 Messages/Responses 的相关能力路径；目标是稳定前缀而非保证缓存命中。
		description:
			"Whether thinking level changes are sent inside the conversation instead of changing the request's effort, so a change keeps the prompt cache. Used by the anthropic-messages and openai-responses APIs.",
		default: false,
	}),
	// 重复的长期缓存字段不携带某 API 的特有默认值。
	supportsLongCacheRetention: optionalCompatBoolean({
		// 服务默认与检测策略依 API 而异；供应商级未写值时不能从这个超集推断恒 true。
		description:
			"Whether the provider supports long prompt cache retention. Defaults are API-specific or auto-detected.",
	}),
	// 重复的严格工具字段采用通用可选布尔规则。
	supportsStrictMode: optionalCompatBoolean({
		// 不沿用 Bedrock 的 false 等专属默认注解，后续实现按自己的协议决定缺省行为。
		description: "Whether the provider supports strict tool schemas. Defaults are API-specific.",
	}),
	// 重复的 grammar 工具字段使用一致的通用描述。
	supportsOpenAIGrammarTools: optionalCompatBoolean({
		// 声明 OpenAI custom 工具语法能力；不支持时由请求层回退 function 工具，本字段未启动语法解析。
		description:
			"Whether the provider supports OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools.",
		default: false,
	}),
	// 重复的亲和头开关保留为可选布尔，不统一补一个 API 的默认。
	sendSessionAffinityHeaders: optionalCompatBoolean({
		// 会话 ID 到请求头的具体发送条件仍依赖所用 API；schema 不因为字段存在就生成头。
		description: "Whether to send session-affinity data from options.sessionId. Defaults are API-specific.",
	}),
	// satisfies 检查字段表每项都符合 Properties，同时保留具体字段名和各值推断类型；它不是运行时校验或类型强制转换。
} satisfies Properties;

// 把联合类型转换为交叉类型，仅在编译期合并属性表形状；例如 {a:A}|{b:B} 对应 {a:A}&{b:B}。
// 第一段条件类型对裸泛型 Union 分发，先把每个成员放进函数参数位置；这不是创建或调用真实函数。
type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
	// 从联合函数的参数位置推断 Intersection，利用参数位置的逆变合并；value 只是类型中的形参名。
	value: infer Intersection,
	// 目标函数类型返回 void；这条类型匹配不会执行回调，也没有可观察返回值。
) => void
	? // 类型匹配成立时得到推断的交叉结果，不是 JavaScript 的运行时分支。
		Intersection
	: // 匹配不成立回退 never，表示这个分支没有可取的类型，不会在运行时抛错。
		never;

// 计算合并属性表的类型：先交叉各组，再去掉由 Overrides 接管的键，最后用覆盖组替换这些键。
// 例如 A/B 都有 flag，Overrides 的 flag 类型应成为最终类型；readonly 只约束参数类型，不会冻结运行时数组或规则。
type MergedCompatProperties<PropertyGroups extends readonly Properties[], Overrides extends Properties> = Omit<
	// PropertyGroups[number] 取元组/数组所有组类型的联合，再转成交叉，收集各组字段。
	UnionToIntersection<PropertyGroups[number]>,
	// keyof 取通用覆盖字段名；Omit 从前面的交叉结果移除这些键，避免让不同专用规则类型继续相互交叉。
	keyof Overrides
	// 交叉类型的 & 将去掉旧键后的属性表与新覆盖字段合并，和对象展开是不同层次。
> &
	// 最终保留覆盖组本身的字段类型；该类型公式不验证每个 override 真的对应运行时重复字段。
	Overrides;

/**
 * Provider-level models.json compatibility is API-agnostic, so it needs one superset. Every
 * duplicate property requires explicit generic metadata, while API-specific schemas retain their
 * own defaults and descriptions.
 */
// 合并多份兼容属性表并要求重名字段显式覆盖，输入属性组数组与通用覆盖表，返回新字段表；无文件或网络操作。
// 逐组记录字段与重复名，再检查覆盖表没多余键，最后让 overrides 后展开胜出；不深复制各 schema/Optional 对象。
// 例如两组都含 supportsStrictMode，必须给对应通用 override；缺覆盖或给未重复字段都抛 Error，模块导入也可能因此失败。
function mergeCompatProperties<const PropertyGroups extends readonly Properties[], const Overrides extends Properties>(
	// const 泛型尽量保留每组字段的精确类型；传入数组在运行时仍是原对象，不是只读副本。
	propertyGroups: PropertyGroups,
	// 通用覆盖表同时参与类型推断与运行合并；satisfies 之外还有下面的重复名检查。
	overrides: Overrides,
	// 返回类型反映“合并后替换重复键”的静态形状；真正值仍要由下面循环构造。
): MergedCompatProperties<PropertyGroups, Overrides> {
	// 新建普通对象暂存字段；Properties[string] 是索引访问类型，可为 Schema 或 Optional。不是无原型字典，属性查找仍可能读到继承成员。
	const merged: Record<string, Properties[string]> = {};
	// Set 只记录重复字段名一次，用于稍后检查覆盖是否确实消除了冲突，不保存 schema 副本。
	const duplicateNames = new Set<string>();

	// 按数组顺序遍历各专用属性组；同名项稍后会被后组暂时覆盖，最终仍需通用定义。
	for (const properties of propertyGroups) {
		// Object.entries 只列该组自有可枚举字符串键，并解构字段名与规则；不会枚举 symbol 键。
		for (const [name, schema] of Object.entries(properties)) {
			// 按普通对象属性读取是否已非 undefined 判断冲突；本调用的普通字段名可用，但它不是 Object.hasOwn 检查。
			if (merged[name] !== undefined) {
				// 把发生冲突的名字加入集合，多次出现同名字段仍只有一份记录。
				duplicateNames.add(name);
				// in 同时检查自有和继承属性；若覆盖表根本没有该名字就进入报错，不比较两份专用 schema 是否相等。
				if (!(name in overrides)) {
					// 缺少通用定义立即同步抛错，并在模板文字中附冲突字段名；不返回部分已合并结果。
					throw new Error(`Duplicate compatibility schema property requires an override: ${name}`);
				}
			}
			// 把当前组的规则引用写入暂存表；重复字段暂用后组值，不执行字段规则或复制内部 metadata。
			merged[name] = schema;
		}
	}

	// 再遍历覆盖表自己的可枚举字符串键，确认没有误写仅存在于单个 API 的字段。
	for (const name of Object.keys(overrides)) {
		// 覆盖项必须曾被记录为重复；只有一组具有的字段不需要也不允许通过此表另行覆盖。
		if (!duplicateNames.has(name)) {
			// 多余覆盖项同样抛错，帮助发现字段重命名或组拆分后遗留的通用定义；不是用户输入数据校验错误。
			throw new Error(`Compatibility schema override does not resolve a duplicate property: ${name}`);
		}
	}

	// 返回新的外层对象，overrides 后展开覆盖同名值；as 只让 TS 对应前面的类型计算，不再校验所有属性或做深拷贝。
	return { ...merged, ...overrides } as MergedCompatProperties<PropertyGroups, Overrides>;
}

/** Compatibility schema for each API whose models accept compat. Mirrors the compat type of Model. */
// 按 API 标识导出兼容规则映射；供规则选择/文档生成使用，不是聊天请求实现注册表。
// 例如 azure-openai-responses 与 openai-responses 指向同一个 Responses schema；没有列出的 API 不在这里自动回退到通用规则。
export const CompatSchemasByApi = {
	// Completions 协议使用自己的格式/工具/路由字段规则。
	"openai-completions": OpenAICompletionsCompatSchema,
	// Responses 协议关联其专用字段表，不复用 Completions 全部字段。
	"openai-responses": OpenAIResponsesCompatSchema,
	// Azure Responses 复用同一个 Responses 规则引用，不再克隆或改默认说明。
	"azure-openai-responses": OpenAIResponsesCompatSchema,
	// Codex Responses 同样引用 Responses 规则，不在映射处启动订阅认证。
	"openai-codex-responses": OpenAIResponsesCompatSchema,
	// 原生/兼容 Messages 对应 Anthropic 工具流、签名和缓存规则。
	"anthropic-messages": AnthropicMessagesCompatSchema,
	// Bedrock Converse 流协议关联自身的 strict 兼容规则。
	"bedrock-converse-stream": BedrockCompatSchema,
	// Mistral Conversations 使用自己的中途指令规则。
	"mistral-conversations": MistralConversationsCompatSchema,
	// TypeSafe System One 分类协议关联图像输入格式规则。
	"typesafe-system-one": SystemOneCompatSchema,
	// Workers AI System One 复用相同分类规则，实际默认图像格式仍可因服务/模型不同。
	"cloudflare-workers-ai-system-one": SystemOneCompatSchema,
	// as const 让 TS 保留键和值的只读精确类型；不是 Object.freeze，运行时规则对象仍按普通引用存在。
} as const;

// 在模块求值时真正合并六组属性并检查重复覆盖；不是等验证某个 models.json 时才执行这段合并。
const ProviderCompatProperties = mergeCompatProperties(
	[
		// 先收集 Completions 的字段名/规则，例如 store、thinkingFormat 和路由偏好。
		OpenAICompletionsCompatProperties,
		// 再合入 Responses 字段，重叠能力名必须有通用覆盖。
		OpenAIResponsesCompatProperties,
		// 合入 Messages 特有的签名、工具流和后备目标字段。
		AnthropicMessagesCompatProperties,
		// 合入 Bedrock strict 字段；同名 strict 不直接沿用其 false 默认。
		BedrockCompatProperties,
		// 合入 Mistral 中途系统消息能力，该重复名稍后由通用规则接管。
		MistralConversationsCompatProperties,
		// 合入分类图像配置，使供应商级超集覆盖分类 API 的兼容字段。
		SystemOneCompatProperties,
	],
	// 把显式通用覆盖表作为第二参数；合并函数会拒绝遗漏冲突名或多余 override。
	ProviderCompatPropertyOverrides,
);

// 导出 API 无关的供应商/模型兼容超集；例如同时配置 Responses 与分类字段也可通过这份形状规则。
// 超集校验不强制每个字段适用于当前 api，具体使用哪些项仍由对应模型和适配器决定。
export const ProviderCompatSchema = openObject(ProviderCompatProperties, {
	// 对象级说明只界定 provider/model 覆盖用途，不把字段值立即应用到所有模型。
	description: "Provider and model compatibility overrides.",
	// 开放额外兼容项，保留前向扩展空间；不等于任意错拼字段都会被提示或执行。
	additionalProperties: true,
});

// 从模板值 schema 提取 TS 联合：string/number/boolean/null 或带 $var 的对象；Static 不验证运行值，开放额外 JSON 字段不自动变 TS 索引签名。
export type ChatTemplateKwargValue = Static<typeof ChatTemplateKwargValueSchema>;
/** Provider and model compatibility overrides in models.json: every API's compat fields. */
// 供应商超集的值类型沿合并结果推导，已列字段保持可选；这个 type 别名不会生成对象或验证函数。
export type ProviderCompat = Static<typeof ProviderCompatSchema>;
/** Top-level request field used to cap reasoning tokens on OpenAI-compatible servers. */
// 预算字段名的三字符串字面量联合，描述的是键名而非预算数值；编译后别名擦除。
export type ThinkingTokenBudgetField = Static<typeof ThinkingTokenBudgetFieldSchema>;
// 亲和格式的三字符串联合，字段是否可选由使用它的对象属性另行决定。
export type SessionAffinityFormat = Static<typeof SessionAffinityFormatSchema>;
/** OpenRouter provider routing preferences. */
// 接口继承 OpenRouter 规则推导的可选字段形状；空接口体没有额外成员，运行时也不会校验路由、排序或数据保留。
export interface OpenRouterRouting extends Static<typeof OpenRouterRoutingSchema> {}
/** Vercel AI Gateway routing preferences. */
// 接口继承 Vercel only/order 的 TS 值形状；数组类型不保证名称存在或排序能被服务采用。
export interface VercelGatewayRouting extends Static<typeof VercelGatewayRoutingSchema> {}
/** An Anthropic server-side refusal fallback model with local pricing metadata. */
// 接口要求 provider/model/cost 的静态形状；string 类型自身表达不了 minLength，后备模型可用性也不由它保证。
export interface AnthropicAllowedFallbackModel extends Static<typeof AnthropicAllowedFallbackModelSchema> {}

/** Compatibility settings for OpenAI-compatible completions APIs. */
// Completions 专用 TS 兼容接口从规则生成；开发期能检查字段值类型，不自动执行 URL 检测或 schema 验证。
export interface OpenAICompletionsCompat extends Static<typeof OpenAICompletionsCompatSchema> {}
/** Compatibility settings for OpenAI Responses APIs. */
// Responses 专用值接口，沿自己的字段名单和字面量推导，不把 description/default 当运行默认。
export interface OpenAIResponsesCompat extends Static<typeof OpenAIResponsesCompatSchema> {}
/** Compatibility settings for Anthropic Messages-compatible APIs. */
// Messages 值接口继承签名/工具/缓存等可选字段；接口不存在于生成 JS 中，不会创建服务端缓存。
export interface AnthropicMessagesCompat extends Static<typeof AnthropicMessagesCompatSchema> {}
/** Compatibility settings for Amazon Bedrock models. */
// Bedrock 值接口描述可选 strict 能力；它不是 AWS 凭证或 SDK 配置对象。
export interface BedrockCompat extends Static<typeof BedrockCompatSchema> {}
/** Compatibility settings for the Mistral chat API. */
// Mistral 值接口保留可选中途系统消息能力；extends 在此是接口继承，不是运行时类继承。
export interface MistralConversationsCompat extends Static<typeof MistralConversationsCompatSchema> {}
/** Compatibility settings for System One classifier APIs. */
// System One 值接口保留图像格式联合与可选开关，供分类模型使用；不代表图片字节已被验证或编码。
export interface SystemOneCompat extends Static<typeof SystemOneCompatSchema> {}
