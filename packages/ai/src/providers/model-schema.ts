// 模型配置共用的规则与类型：统一思考档位、输入模态、缓存寿命、费用档与图像/请求限制；只创建schema对象，不执行思考、计费、预热或图片处理。
// compat-schema复用费用规则，coding-agent的pi-ai-schemas再适配给TypeBox配置系统；Static导出的类型不代替运行时验证，description只说明语义。
import {
	// Annotations是可选说明元数据类型，default注解不会给缺失配置自动补值。
	type Annotations,
	// arr构造数组items规则，不遍历用户输入。
	arr,
	// int生成integer规则；Static类型仍为number，整数约束由验证器检查。
	int,
	// nul构造只接受null的规则，不等于字段可以缺失。
	nul,
	// num构造number规则，可另带minimum等约束，本行没有进行数字转换。
	num,
	// oneOf是pi-schema枚举构造器，实际输出enum，不是JSON Schema的oneOf分支关键字。
	oneOf,
	// opt先包装字段；object内部借obj识别并从required中排除。
	opt,
	// Static从schema泛型推导TS值类型，不是运行函数。
	type Static,
	// StaticObject从字段表推导必填/可选属性，供下面函数的options类型使用。
	type StaticObject,
	// str只构造字符串规则，不校验provider原生思考文字是否合法。
	str,
	// union把多规则组合为anyOf，静态值类型为各分支的联合。
	union,
} from "@earendil-works/pi-schema";
// import中的as给openObject起本地别名object，区别于值表达式中的类型断言；所有本文件对象schema均开放额外属性。
import { openObject as object } from "./schema-builders.ts";

// 有序思考档位列表不含off；as const保留只读字面量元组，既供enum也供类型推导，不执行Object.freeze。
export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
// 展开前一列表并在前面加off，得到模型可描述的完整统一档位；这不代表每款模型都支持全部。
export const MODEL_THINKING_LEVELS = ["off", ...THINKING_LEVELS] as const;
// 输入模态只列text/image；图片生成输出模态不是这个枚举的职责。
export const MODEL_INPUT_MODALITIES = ["text", "image"] as const;
// 缓存请求选项允许none关闭、short短保留、long长保留；本列表不创建服务端缓存。
export const CACHE_RETENTIONS = ["none", "short", "long"] as const;
// 模型寿命元数据只记short/long，不为关闭缓存none声明寿命。
export const MODEL_PROMPT_CACHE_RETENTIONS = ["short", "long"] as const;

// 枚举只接受六种非关闭档位文字，schema值静态关联对应字面量联合。
export const ThinkingLevelSchema = oneOf(THINKING_LEVELS);
// 模型档位schema还接受off，供配置选择时使用。
export const ModelThinkingLevelSchema = oneOf(MODEL_THINKING_LEVELS);
// 模态schema只接受text或image文字，不验证图片字节或编码。
export const ModelInputModalitySchema = oneOf(MODEL_INPUT_MODALITIES);
// 缓存保留schema包含none，不把none转换成0秒TTL。
export const CacheRetentionSchema = oneOf(CACHE_RETENTIONS);

// 映射项允许任意字符串或null：字符串给provider原生值，null按上层约定标不支持；未加字符串长度/白名单约束。
const ThinkingLevelMapValueSchema = union([str(), nul()]);
// 构造统一档位到原生值的开放对象；所有已列字段都可缺失，{}可符合这些字段规则，不强迫模型列全档位。
export const ThinkingLevelMapSchema = object(
	// 第一参数是字段表，每个opt共享上面的值schema引用。
	{
		// off项可省略；显式null与没写该键有不同业务含义。
		off: opt(ThinkingLevelMapValueSchema),
		// minimal可映射原生字符串或null，是否支持由模型能力处理。
		minimal: opt(ThinkingLevelMapValueSchema),
		// low同样可选，不在规则里生成默认原生值。
		low: opt(ThinkingLevelMapValueSchema),
		// medium可选，不检查与low/high的强弱关系。
		medium: opt(ThinkingLevelMapValueSchema),
		// high可选，缺省行为由provider默认映射处理。
		high: opt(ThinkingLevelMapValueSchema),
		// xhigh可选，但实际支持集合要求明确非undefined且非null映射，不因枚举有此名字就自动开放。
		xhigh: opt(ThinkingLevelMapValueSchema),
		// max也需具体模型明确映射才在支持集合中开放；此行仅构造可选字段规则。
		max: opt(ThinkingLevelMapValueSchema),
	},
	// 第二参数是schema元数据，不是额外待验证字段。
	{
		// description键保存给工具/文档看的说明文字。
		description:
			// 这段正文解释null与缺项约定；真正支持档位过滤在models的getSupportedThinkingLevels，不由说明字符串运行实现。
			"Provider value sent for each thinking level. null marks a level unsupported. Levels the model does not map use the provider's default value through high; xhigh and max are unsupported.",
	},
);

// 缓存寿命要求严格大于0的number，可为小数秒；不是integer，不在此启动计时器或检查真实缓存存活。
const PromptCacheLifetimeSchema = num({ exclusiveMinimum: 0 });
// 短/长寿命schema为开放对象，两档都可缺省，不因提供模型就保证有已知TTL。
export const ModelPromptCacheSchema = object(
	// 两个字段共用正数寿命规则，opt使其均不必填；例{short:300}只声明短档约300秒。
	{ short: opt(PromptCacheLifetimeSchema), long: opt(PromptCacheLifetimeSchema) },
	// 寿命规则的对象级元数据参数。
	{
		// description只记录单位与用途，不调用预热器。
		description:
			// 正文表达best-effort寿命；cache-warmer取对应字段再秒转毫秒，缺失时无已知预热TTL，不是服务端命中保证。
			"Best-effort prompt cache lifetime in seconds for the short and long retention tiers. Pi warms only tiers with a known lifetime.",
	},
);

// 四项费用字段表复用给基础价格与阶梯价格；这里未包opt，所以对象构造后四项都必填。
const ModelCostRatesProperties = {
	// 普通输入每百万token的美元单价；只有num无非负minimum，JSON负数并不被这个字段规则排除。
	input: num({ description: "Input cost in USD per million tokens." }),
	// 输出每百万token单价，不在这里用当前用量相乘。
	output: num({ description: "Output cost in USD per million tokens." }),
	// 缓存读每百万token单价，与普通输入字段分开。
	cacheRead: num({ description: "Cache-read cost in USD per million tokens." }),
	// 缓存写每百万token单价，不在此表达短写/长写具体计费公式。
	cacheWrite: num({ description: "Cache-write cost in USD per million tokens." }),
};

// 单独导出四费率的开放对象规则；例四项全0是完整费率，省output不是完整对象。
export const ModelCostRatesSchema = object(ModelCostRatesProperties);
// 阶梯价格加必填输入门槛及四费率字段；schema没有检查门槛排序、唯一性或非负。
export const ModelCostTierSchema = object({
	// 门槛仅约束为number，没有integer/minimum，因此静态number也不能证明它是合理token数量。
	inputTokensAbove: num({
		// 描述约定严格超过门槛才用该档，实际计价由calculateCost执行，不由这行文字自动切档。
		description: "Use this tier when total request input exceeds this token count.",
	}),
	// 对象展开把四项必填费率schema放入当前字段表，子schema仍共用引用。
	...ModelCostRatesProperties,
});
// 模型完整价格：基础四费率必填，tiers可缺省；不在此读取供应商账单。
export const ModelCostSchema = object({
	// 复用基础费率字段，不将它们包装成子对象cost.rates。
	...ModelCostRatesProperties,
	// tiers用opt标可选，缺少时不会自动补空数组。
	tiers: opt(
		// 若有tiers则须为各项符合完整阶梯规则的数组，未设minItems/uniqueItems，[]也允许。
		arr(ModelCostTierSchema, {
			// 正文约定用最高匹配门槛价格算整次请求，非把超出部分单独计价；schema只保存说明，不排序或选择tier。
			description: "Request-wide pricing tiers. The highest matching input threshold applies to the full request.",
		}),
	),
});

// 图像缩放选项字段表，所有项都可省略，实际缺省尺寸/品质在图像处理模块决定。
const ModelImageResizeProperties = {
	// 宽度上限若配置必须是至少1的整数；规则不读取原图宽度或立刻缩图。
	maxWidth: opt(int({ minimum: 1 })),
	// 高度上限同样至少1整数，不在此保持纵横比。
	maxHeight: opt(int({ minimum: 1 })),
	// maxBytes表示base64载荷大小的上限，至少1整数；不是原始文件字节上限，也不是整个HTTP请求大小。
	maxBytes: opt(int({ minimum: 1, description: "Maximum base64-encoded payload size in bytes." })),
	// JPEG品质范围为1到100的整数，不在这里把输入转换成JPEG。
	jpegQuality: opt(int({ minimum: 1, maximum: 100 })),
};

// 为同一缩放字段表构造可附不同描述的开放对象schema，输入可省略Annotations，返回推断的Schema类型，无I/O。
// 例modelImageResizeOptions({description:"缩放配置"})只给规则加说明，不处理图片；每次返回新对象/属性表，内部子schema引用可复用，属性读取异常不在此捕获。
function modelImageResizeOptions(options?: Annotations<StaticObject<typeof ModelImageResizeProperties>>) {
	// 把共享字段表和元数据交object；传undefined时其options默认空对象，optional参数的?不创建独立默认缩放数值。
	return object(ModelImageResizeProperties, options);
}

// 不带说明调用上面函数，导出通用缩放选项规则；此时尚未读取图像或运行worker。
export const ModelImageResizeOptionsSchema = modelImageResizeOptions();

// 图像输入限制的开放对象，包含可选预处理配置和数量限制，几项间无交叉大小检查。
export const ModelImageInputLimitsSchema = object({
	// resize字段本身可选，不等于每张图都必须缩放。
	resize: opt(
		// 复用同一字段表但为嵌套resize单独创建带描述的schema。
		modelImageResizeOptions({
			// 这段说明建议图片进入会话前处理，以稳定后续历史/缓存；仅导入规则不会改写会话图片。
			description: "Cache-safe resize profile applied before a new image enters conversation history.",
		}),
	),
	// 每条provider消息图片数上限须至少1整数，不在这里遍历消息数图片。
	maxPerMessage: opt(int({ minimum: 1, description: "Maximum images accepted in one provider message." })),
	// 每次provider请求图片数上限须至少1整数，未要求它一定大于等于maxPerMessage。
	maxPerRequest: opt(int({ minimum: 1, description: "Maximum images accepted across one provider request." })),
});

// 请求输入限制最外层开放对象，字段均可省略；{}不会被本规则自动填满默认限制。
export const ModelInputLimitsSchema = object({
	// maxRequestBytes为序列化provider请求大小限制，至少1整数，不是JS字符串length或对话token上限。
	maxRequestBytes: opt(int({ minimum: 1, description: "Maximum serialized provider request size in bytes." })),
	// images嵌套上面的图像限制规则；opt意味着可完全没有此对象，提供后才检查其已列字段。
	images: opt(ModelImageInputLimitsSchema),
});

// typeof在类型位置取schema变量类型，再由Static提取六档字面量联合；生成JS时此别名擦除。
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;
// 模型思考档位类型比ThinkingLevel多off，不等于当前模型支持集合。
export type ModelThinkingLevel = Static<typeof ModelThinkingLevelSchema>;
// 映射类型的已列属性均可选，值为string|null；开放额外JSON字段不自动给此TS类型加索引签名。
export type ThinkingLevelMap = Static<typeof ThinkingLevelMapSchema>;
// 输入模态类型是text|image，不是具体图片对象类型。
export type ModelInputModality = Static<typeof ModelInputModalitySchema>;
// 缓存保留类型是none|short|long，不携带TTL秒数。
export type CacheRetention = Static<typeof CacheRetentionSchema>;
// 缓存寿命值对象类型只描述可选short/long数字，不把数字静态限为正数。
export type ModelPromptCache = Static<typeof ModelPromptCacheSchema>;
// 费率类型四项都是number且必填，TS不能从schema单位推导美元或非负品牌类型。
export type ModelCostRates = Static<typeof ModelCostRatesSchema>;
// 阶梯类型包含输入门槛与四费率，不携带执行切档方法。
export type ModelCostTier = Static<typeof ModelCostTierSchema>;
// 完整价格类型为基础费率加可选tiers数组，不是当前请求已经计算出的cost.total。
export type ModelCost = Static<typeof ModelCostSchema>;
// 缩放类型的字段可选且均为number，整数/范围约束需运行校验。
export type ModelImageResizeOptions = Static<typeof ModelImageResizeOptionsSchema>;
// 图像限制类型含可选resize/每消息与每请求数量，类型不保证三者业务关系。
export type ModelImageInputLimits = Static<typeof ModelImageInputLimitsSchema>;
// 输入限制类型含可选请求字节与图像规则；别名不会在请求前自动执行限制检查。
export type ModelInputLimits = Static<typeof ModelInputLimitsSchema>;
