// 汇总生成的静态聊天/图片/分类目录，并提供构造、注册全部内置Provider的入口；静态读目录与实例动态刷新是两条链。
// 三张表从本地生成模块取得，模型对象仍共享；此文件是手写入口，生成表及data目录由生成器维护。
import { CLASSIFIER_MODELS, IMAGE_MODELS, MODELS } from "../models.generated.ts";
// createModels是真实集合构造器；type项仅编译期描述注入配置、可变注册接口和Provider，不调用认证或刷新。
import { type CreateModelsOptions, createModels, type MutableModels, type Provider } from "../models.ts";
// 只导入三种模型与协议联合类型，AnyModel是种类联合；这些类型会擦除，不能替代数据校验。
import type { AnyModel, Api, ClassifierApi, ClassifierModel, ImageApi, ImageModel, Model } from "../types.ts";
// 下面导入各手写工厂供builtinProviders组装；ESM会先求值依赖模块，取函数引用不等于调用登录、刷新或流方法。
// Bedrock接AWS Converse Stream协议，认证兼容bearer、profile及AWS环境凭证条件。
import { amazonBedrockProvider } from "./amazon-bedrock.ts";
// Ant Ling使用Completions聊天协议，目录中的Ling/Ring兼容字段仍由模型携带。
import { antLingProvider } from "./ant-ling.ts";
// Anthropic使用原生Messages协议，同时提供key/环境策略与Claude订阅OAuth。
import { anthropicProvider } from "./anthropic.ts";
// Azure同时装配专用Responses及带端点/部署名准备的Completions实现。
import { azureProvider } from "./azure.ts";
// Baseten以Completions协议接入其独立聊天目录。
import { basetenProvider } from "./baseten.ts";
// Cerebras聊天采用Completions兼容实现，保留自己的模型目录。
import { cerebrasProvider } from "./cerebras.ts";
// Cloudflare AI Gateway按模型分派Messages、Completions、Responses三种聊天协议。
import { cloudflareAIGatewayProvider } from "./cloudflare-ai-gateway.ts";
// Workers AI组合Completions聊天与独立System One分类，并按account填端点。
import { cloudflareWorkersAIProvider } from "./cloudflare-workers-ai.ts";
// 导入本地JSON清单，with指定JSON模块类型；下面只读generatedAt，不在这里下载、重算哈希或写清单。
import modelDataManifest from "./data/.manifest.json" with { type: "json" };
// DeepSeek复用Completions协议，思考等兼容差异保存在其模型目录。
import { deepseekProvider } from "./deepseek.ts";
// Fireworks为聊天目录同时提供Messages和Completions两套实现。
import { fireworksProvider } from "./fireworks.ts";
// Copilot有三种聊天协议及独立分类；OAuth可用ID元数据能筛聊天列表。
import { githubCopilotProvider } from "./github-copilot.ts";
// Google直连Gemini的Generative AI协议，与Vertex的云认证入口分开。
import { googleProvider } from "./google.ts";
// Vertex使用google-vertex协议，认证可选择显式key或ADC文件/项目/地区配置。
import { googleVertexProvider } from "./google-vertex.ts";
// Groq的聊天目录接Completions兼容协议。
import { groqProvider } from "./groq.ts";
// Hugging Face聊天目录接路由器上的Completions协议。
import { huggingfaceProvider } from "./huggingface.ts";
// Kimi Coding使用Completions聊天，支持key或Kimi Code订阅OAuth。
import { kimiCodingProvider } from "./kimi-coding.ts";
// Meta聊天使用Responses兼容协议，提供API key及Muse订阅OAuth。
import { metaProvider } from "./meta.ts";
// MiniMax国际入口使用Messages聊天协议，和CN入口分开注册。
import { minimaxProvider } from "./minimax.ts";
// MiniMax CN也使用Messages协议，但有自己的中国区目录和key变量。
import { minimaxCnProvider } from "./minimax-cn.ts";
// Mistral聊天使用专用Conversations协议，不能当作Completions映射。
import { mistralProvider } from "./mistral.ts";
// Moonshot国际入口使用Completions聊天，与Kimi Coding供应商分开。
import { moonshotaiProvider } from "./moonshotai.ts";
// Moonshot CN使用中国区聊天目录和Completions实现。
import { moonshotaiCnProvider } from "./moonshotai-cn.ts";
// NVIDIA聊天目录通过Completions兼容实现接入，模型仍保留其compat元数据。
import { nvidiaProvider } from "./nvidia.ts";
// OpenAI组合Responses聊天和Decisions分类，并提供key/ChatGPT订阅OAuth。
import { openaiProvider } from "./openai.ts";
// 独立Codex入口使用专用Codex Responses协议，只声明ChatGPT订阅OAuth。
import { openaiCodexProvider } from "./openai-codex.ts";
// OpenCode Zen支持四聊天协议与System One分类，聊天会补会话头。
import { opencodeProvider } from "./opencode.ts";
// OpenCode Go同样包装四种聊天协议的会话头，但此工厂只装聊天目录。
import { opencodeGoProvider } from "./opencode-go.ts";
// OpenRouter组合双协议聊天、图片生成及System One分类，并提供key/OAuth。
import { openrouterProvider } from "./openrouter.ts";
// Qwen国际Token Plan使用Completions协议与独立套餐聊天目录。
import { qwenTokenPlanProvider } from "./qwen-token-plan.ts";
// Qwen CN套餐采用Completions聊天，但北京端点与key变量均独立。
import { qwenTokenPlanCnProvider } from "./qwen-token-plan-cn.ts";
// Qwen Individual有独立聊天表，协议仍为Completions。
import { qwenTokenPlanIndividualProvider } from "./qwen-token-plan-individual.ts";
// Radius使用Pi Messages聊天，账户动态目录整体替换公开基线。
import { radiusProvider } from "./radius.ts";
// Together的Completions聊天保留目录中每个模型的思考格式等兼容差异。
import { togetherProvider } from "./together.ts";
// TypeSafe工厂仅装分类目录和System One能力，没有聊天API实现。
import { typesafeProvider } from "./typesafe.ts";
// Vercel网关组合Messages聊天与System One分类，采用网关自己的key。
import { vercelAIGatewayProvider } from "./vercel-ai-gateway.ts";
// xAI聊天使用Responses兼容协议，提供key与Grok/X订阅OAuth。
import { xaiProvider } from "./xai.ts";
// Xiaomi普通API使用Completions聊天，与三个Token Plan入口分开。
import { xiaomiProvider } from "./xiaomi.ts";
// Xiaomi AMS套餐使用Completions聊天及AMS专用模型表。
import { xiaomiTokenPlanAmsProvider } from "./xiaomi-token-plan-ams.ts";
// Xiaomi CN套餐使用Completions聊天及CN专用模型表。
import { xiaomiTokenPlanCnProvider } from "./xiaomi-token-plan-cn.ts";
// Xiaomi SGP套餐使用Completions聊天及SGP专用模型表。
import { xiaomiTokenPlanSgpProvider } from "./xiaomi-token-plan-sgp.ts";
// Z.AI国际入口接Completions聊天，基础路径已明确选用Coding接口。
import { zaiProvider } from "./zai.ts";
// Z.AI中国Coding入口有独立聊天表和认证变量，协议仍为Completions。
import { zaiCodingCnProvider } from "./zai-coding-cn.ts";

// 把已导入的Radius工厂再次公开导出，同一函数引用，不在这行创建实例。
export { radiusProvider };

/** Providers present in the generated catalog. `KnownProvider` additionally
 * includes purely dynamic providers (e.g. "radius") that have no static
 * catalog entry. */
// keyof typeof先取生成MODELS值的静态类型，再抽供应商键联合，实际名单由当前生成表决定。
// 保留上方原英语，但其radius无静态目录的旧举例已过时：当前三张表均含radius，Radius另能动态刷新账户目录。KnownProvider声明也不是自动扫描动态实现。
export type BuiltinProvider = keyof typeof MODELS;

// 泛型TProvider限为内置键；先索引对应聊天子表，再keyof得该供应商模型ID联合，编译期限制传参，不运行查找。
type BuiltinChatModelId<TProvider extends BuiltinProvider> = keyof (typeof MODELS)[TProvider];
// 对图片表作相同索引计算；若该供应商图片子表类型无键，得到never，不能凭聊天支持image输入就选图片ID。
type BuiltinImageModelId<TProvider extends BuiltinProvider> = keyof (typeof IMAGE_MODELS)[TProvider];
// 对分类表取ID键联合，保持分类ID与指定供应商关联；它不调用分类器。
type BuiltinClassifierModelId<TProvider extends BuiltinProvider> = keyof (typeof CLASSIFIER_MODELS)[TProvider];
/** API ids of catalog entries. Built-in getters return `Model<Api>` shapes, not literal entry types. */
// 条件类型：TEntry有字符串api时infer提取其API类型，否则never；infer TApi extends string同时限制推断值，联合输入按分支分发，仅开发期计算。
type CatalogApi<TEntry> = TEntry extends { api: infer TApi extends string } ? TApi : never;

/** Typed read of one generated built-in chat model. */
// 按供应商与ID直接读静态聊天条目，返回保留API类型的Model视图；例getBuiltinModel("radius","balanced")读本地基线，不是账户刷新后的列表。
// 不复制、不联网、不校验参数或字段；正常TS调用限制键，但JS/类型断言可传坏键，实际可返回undefined。普通对象索引也没hasOwn隔离继承成员。
// 双重索引类型取得条目API并组成Model；返回接口未承诺id/provider仍保留具体字面量，不是完整原条目类型。
export function getBuiltinModel<TProvider extends BuiltinProvider, TModelId extends BuiltinChatModelId<TProvider>>(
	// 第一个泛型参数推断供应商键，用来限制第二个参数的可选ID。
	provider: TProvider,
	// 第二个参数是该供应商聊天子表的键，字符串ID不能凭名称自动跨表搜索。
	modelId: TModelId,
): Model<CatalogApi<(typeof MODELS)[TProvider][TModelId]>> {
	// as把表临时视为字符串字典；?.在供应商值为空时返回undefined，modelId as string只改类型，最后as Model也不会制造缺失对象。
	// CatalogApi从双重索引的条目类型提取api，运行值仍是索引结果；as Model只提供静态视图。
	return (MODELS as Record<string, Record<string, Model<Api>> | undefined>)[provider]?.[modelId as string] as Model<
		CatalogApi<(typeof MODELS)[TProvider][TModelId]>
	>;
}

/** Typed read of one generated built-in image model. */
// 按内置供应商和专用图片ID读静态图片模型，返回ImageModel视图且共享对象；例getBuiltinImageModel("openrouter","openai/gpt-image-1")。
// 枚举结果的id类型已宽化为string，不能直接满足有限ID联合，需另行收窄；这里不执行图像生成。越过TS键约束可得到undefined或普通对象继承成员，返回as不作运行时非空保证，缺键不主动抛业务错误。
// provider/modelId为普通参数，返回泛型从图片条目api推导；函数本身同步，不创建Promise。
export function getBuiltinImageModel<
	// 供应商泛型仍取当前MODELS键联合，当前图片聚合也为这些供应商提供子表。
	TProvider extends BuiltinProvider,
	// 图片模型ID限为当前供应商IMAGE_MODELS子表的键，不是其聊天表所有键。
	TModelId extends BuiltinImageModelId<TProvider>,
>(provider: TProvider, modelId: TModelId): ImageModel<CatalogApi<(typeof IMAGE_MODELS)[TProvider][TModelId]>> {
	// 将图片聚合断言成宽字典，再通过可选链索引目标子表；不检查Object.hasOwn或每项type字段。
	// 最终类型断言收窄ImageModel视图，但实际undefined不因as被填值；不复制或冻结模型。
	return (IMAGE_MODELS as Record<string, Record<string, ImageModel<ImageApi>> | undefined>)[provider]?.[
		// 把modelId静态视为string用于运行索引，as不对文字编码或规范化。
		modelId as string
	] as ImageModel<CatalogApi<(typeof IMAGE_MODELS)[TProvider][TModelId]>>;
}

/** Typed read of one generated built-in classifier model. */
// 读取一个静态分类模型，返回其协议对应ClassifierModel视图；例getBuiltinClassifierModel("typesafe","jev-latest")，不运行分类。
// 分类枚举项的id类型为string，直接传这里未必通过有限ID联合约束，要先收窄。流程同前两getter，运行缺键可undefined、继承键未隔离，错误或不合约数据不由TS断言自动修复。
// 返回模型类型用分类子表中该条目API计算，而不是聊天协议联合。
export function getBuiltinClassifierModel<
	// 供应商TProvider限为内置键，保留它与分类子表的类型关联。
	TProvider extends BuiltinProvider,
	// TModelId限为对应分类表键联合；空表时为never。
	TModelId extends BuiltinClassifierModelId<TProvider>,
>(
	// 传供应商键，不在此创建Provider或解析凭据。
	provider: TProvider,
	// 传分类模型ID原值，运行代码不trim或补前缀。
	modelId: TModelId,
): ClassifierModel<CatalogApi<(typeof CLASSIFIER_MODELS)[TProvider][TModelId]>> {
	// 把分类表视为可缺供应商的字典并可选索引，只有静态视图改变，没有运行校验。
	// 断言返回ClassifierModel，不能排除实际缺失或继承成员；模型引用原样交出。
	return (CLASSIFIER_MODELS as Record<string, Record<string, ClassifierModel<ClassifierApi>> | undefined>)[provider]?.[
		// modelId as string仅供TS索引，真实属性名原样使用。
		modelId as string
	] as ClassifierModel<CatalogApi<(typeof CLASSIFIER_MODELS)[TProvider][TModelId]>>;
}

// 枚举静态聊天聚合的供应商自有可枚举键，返回新字符串数组；例包含radius，但不是查询实际认证可用的供应商，顺序沿Object.keys。
export function getBuiltinProviders(): BuiltinProvider[] {
	// Object.keys真实生成数组，as把string[]视为键联合数组；未构造各Provider，也不冻结返回数组。
	return Object.keys(MODELS) as BuiltinProvider[];
}

/** Generation timestamp shared by all built-in provider catalogs. */
// 读本地清单生成时间，返回Date.parse的毫秒时间戳或undefined；例坏日期得到undefined，不是当前时间或每个动态目录的checkedAt，无I/O调用。
export function getBuiltinModelDataGeneratedAt(): number | undefined {
	// 解析已导入generatedAt文字，Date.parse规则由JS运行时决定，不在此验证ISO格式或远端版本新旧。
	const generatedAt = Date.parse(modelDataManifest.generatedAt);
	// 只有NaN才回undefined，否则原数字返回；三元不会把0这种有效时间当缺省。
	return Number.isNaN(generatedAt) ? undefined : generatedAt;
}

// 列一个供应商的静态聊天模型，返回新数组、内部模型仍原引用，API类型由该子表所有ID联合推导。
// 例getBuiltinModels("radius")读公开基线，账户动态目录应读注册实例/Models；未知普通键越过TS约束时通常得[]，继承键访问未额外隔离。
// 先用所有聊天ID联合索引子表，CatalogApi取得协议联合，再声明Model数组；不保留每一项全部字面量字段。
export function getBuiltinModels<TProvider extends BuiltinProvider>(
	// 传入供应商泛型键，没有网络或认证选项。
	provider: TProvider,
): Model<CatalogApi<(typeof MODELS)[TProvider][BuiltinChatModelId<TProvider>]>>[] {
	// 只读目标子表引用，Record断言允许缺键但不运行检查。
	const models = (MODELS as Record<string, Record<string, Model<Api>> | undefined>)[provider];
	// 子表为空值时用{}并取其values得[]，存在则取自有可枚举值的新数组；as不复制每个模型或验证type。
	return Object.values(models ?? {}) as Model<CatalogApi<(typeof MODELS)[TProvider][BuiltinChatModelId<TProvider>]>>[];
}

// 列指定供应商的静态专用图片模型，返回新数组及共享条目；例图片子表空则[]，不会从聊天模型input推导图像生成能力。
// 流程是索引子表、空值回退、Object.values；坏JS参数/继承键没有额外边界校验，不执行生成请求。
// API类型从该供应商所有图片ID对应条目推导，[]是数组类型，不创建运行数组。
export function getBuiltinImageModels<TProvider extends BuiltinProvider>(
	// 供应商参数限为内置键；泛型保留用于后续返回类型。
	provider: TProvider,
): ImageModel<CatalogApi<(typeof IMAGE_MODELS)[TProvider][BuiltinImageModelId<TProvider>]>>[] {
	// 读取宽字典中的子表，断言不改变模型表或过滤数据。
	const models = (IMAGE_MODELS as Record<string, Record<string, ImageModel<ImageApi>> | undefined>)[provider];
	// Object.values返回子表自有可枚举模型值，缺子表回{}；随后as只提供类型视图。
	// 返回断言为ImageModel数组，API类型取该图片子表的联合；结果仍是Object.values新数组、元素共享。
	return Object.values(models ?? {}) as ImageModel<
		CatalogApi<(typeof IMAGE_MODELS)[TProvider][BuiltinImageModelId<TProvider>]>
	>[];
}

// 列指定供应商静态分类模型，新数组保留条目引用；空表返回[]，例后续可按每项api选实际分类器，但此函数不执行它。
// 不校验类型断言外的坏键或字段，也不返回动态实例刷新后的分类目录。
// 返回ClassifierModel数组，CatalogApi从该子表所有分类ID计算，不是从运行时逐项验证获得。
export function getBuiltinClassifierModels<TProvider extends BuiltinProvider>(
	// 供应商泛型键决定分类子表和返回协议联合。
	provider: TProvider,
): ClassifierModel<CatalogApi<(typeof CLASSIFIER_MODELS)[TProvider][BuiltinClassifierModelId<TProvider>]>>[] {
	// 将分类聚合表断言为可缺供应商的宽字典，再按provider读取整个子表；as不校验实际值。
	const models = (CLASSIFIER_MODELS as Record<string, Record<string, ClassifierModel<ClassifierApi>> | undefined>)[
		provider
	];
	// 对子表或空{}取values，新建结果数组，不改聚合表。
	// 返回断言为ClassifierModel数组，API类型取该分类子表的联合；不额外复制或转换模型。
	return Object.values(models ?? {}) as ClassifierModel<
		CatalogApi<(typeof CLASSIFIER_MODELS)[TProvider][BuiltinClassifierModelId<TProvider>]>
	>[];
}

// 把同一供应商的静态聊天、图片、分类数组依此顺序拼成AnyModel[]，不跨种类去重；例相同id的聊天与图片项仍各保留，无I/O。
export function getAllBuiltinModels<TProvider extends BuiltinProvider>(provider: TProvider): AnyModel[] {
	// 三个函数各新建数组，再...展开到最终新数组；元素仍共享原模型对象，调用异常自然传播。
	return [...getBuiltinModels(provider), ...getBuiltinImageModels(provider), ...getBuiltinClassifierModels(provider)];
}

/** All built-in providers, freshly constructed. */
// 每次按下面固定顺序调用所有内置工厂，返回新的Provider实例数组；它与getBuiltinProviders只返回字符串键不同。
// 例两次调用有各自Radius动态闭包；生成模型引用等仍可共享。这里只装配工厂，不调用refresh/login/stream；任一工厂同步抛错会中断，不自动回滚先前构造。
export function builtinProviders(): Provider[] {
	// 数组元素表达式按顺序立即求值，不是保存尚未调用的函数引用，也不是从静态表自动反射所有工厂。
	return [
		// 装入Bedrock聊天目录与AWS认证策略，区别于普通OpenAI key入口。
		amazonBedrockProvider(),
		// 登记api.ant-ling.com/v1与ANT_LING_API_KEY认证来源。
		antLingProvider(),
		// 装入Anthropic聊天目录；认证策略还支持Bearer头和工作负载联邦配置。
		anthropicProvider(),
		// 构造Azure双协议聊天入口，API key来源为AZURE_OPENAI_API_KEY。
		azureProvider(),
		// 登记inference.baseten.co/v1与BASETEN_API_KEY。
		basetenProvider(),
		// 登记api.cerebras.ai/v1及CEREBRAS_API_KEY策略。
		cerebrasProvider(),
		// 构造带account/gateway路由包装及网关认证的聊天入口。
		cloudflareAIGatewayProvider(),
		// 合入Workers聊天/分类两张表，认证需key与账户配置。
		cloudflareWorkersAIProvider(),
		// 登记不带/v1的api.deepseek.com基础地址和DEEPSEEK_API_KEY。
		deepseekProvider(),
		// 建立Fireworks双协议入口，认证来源为FIREWORKS_API_KEY。
		fireworksProvider(),
		// 登记token/订阅OAuth双认证，并给System One分类端点套/v1包装。
		githubCopilotProvider(),
		// 装入Gemini聊天目录，key来源为GEMINI_API_KEY。
		googleProvider(),
		// 装入Vertex聊天目录与Cloud认证策略，区别于Gemini API key入口。
		googleVertexProvider(),
		// 登记api.groq.com/openai/v1与GROQ_API_KEY。
		groqProvider(),
		// 装入HF本地聊天表，认证候选为HF_TOKEN。
		huggingfaceProvider(),
		// 登记api.kimi.com/coding/v1与独立kimi-coding凭证归属。
		kimiCodingProvider(),
		// 登记api.meta.ai/v1与META_API_KEY/Meta登录两条认证路径。
		metaProvider(),
		// 登记api.minimax.io/anthropic与MINIMAX_API_KEY。
		minimaxProvider(),
		// 登记api.minimaxi.com/anthropic与MINIMAX_CN_API_KEY。
		minimaxCnProvider(),
		// 装入Mistral聊天表及MISTRAL_API_KEY策略。
		mistralProvider(),
		// 登记api.moonshot.ai/v1；环境候选MOONSHOT_API_KEY与CN共用。
		moonshotaiProvider(),
		// 登记api.moonshot.cn/v1；独立注册ID但沿用MOONSHOT_API_KEY变量。
		moonshotaiCnProvider(),
		// 登记integrate.api.nvidia.com/v1及NVIDIA_API_KEY。
		nvidiaProvider(),
		// 合入聊天与分类表；OAuth可用列表会排除分类项，不删除静态目录。
		openaiProvider(),
		// 登记独立openai-codex归属及chatgpt.com/backend-api基础地址。
		openaiCodexProvider(),
		// 合入Zen聊天/分类两表，key来源为OPENCODE_API_KEY。
		opencodeProvider(),
		// 以opencode-go独立注册，认证变量与Zen共用OPENCODE_API_KEY。
		opencodeGoProvider(),
		// 合入三种目录；这个工厂不主动执行另行导出的账户目录个性化函数。
		openrouterProvider(),
		// 登记ap-southeast-1套餐端点及QWEN_TOKEN_PLAN_API_KEY。
		qwenTokenPlanProvider(),
		// 登记cn-beijing套餐端点及QWEN_TOKEN_PLAN_CN_API_KEY。
		qwenTokenPlanCnProvider(),
		// 单独注册Individual，复用国际套餐端点及QWEN_TOKEN_PLAN_API_KEY。
		qwenTokenPlanIndividualProvider(),
		// 构造Radius闭包、默认基线及key/OAuth能力；之后refresh可恢复或获取账户目录。
		radiusProvider(),
		// 登记api.together.ai/v1与TOGETHER_API_KEY。
		togetherProvider(),
		// 登记TYPESAFE_API_KEY及分类表；普通getModels只筛聊天，因此返回空列表。
		typesafeProvider(),
		// 合入两种目录并登记AI_GATEWAY_API_KEY，不改用代理模型原厂商的key。
		vercelAIGatewayProvider(),
		// 登记api.x.ai/v1及XAI_API_KEY/订阅登录能力。
		xaiProvider(),
		// 登记api.xiaomimimo.com/v1与普通XIAOMI_API_KEY。
		xiaomiProvider(),
		// 登记token-plan-ams端点与XIAOMI_TOKEN_PLAN_AMS_API_KEY。
		xiaomiTokenPlanAmsProvider(),
		// 登记token-plan-cn端点与XIAOMI_TOKEN_PLAN_CN_API_KEY。
		xiaomiTokenPlanCnProvider(),
		// 登记token-plan-sgp端点与XIAOMI_TOKEN_PLAN_SGP_API_KEY。
		xiaomiTokenPlanSgpProvider(),
		// 登记api.z.ai/api/coding/paas/v4与ZAI_API_KEY。
		zaiProvider(),
		// 登记open.bigmodel.cn的Coding路径与ZAI_CODING_CN_API_KEY。
		zaiCodingCnProvider(),
	];
}

/** A `Models` collection with every built-in provider registered. */
// 创建可修改的Models集合并注册每个内置Provider，接可选凭据/目录存储/认证宿主/默认身份配置，返回集合；不自动refresh或登录。
// 例builtinModels().getModels()读当前本地目录；想恢复动态缓存需另显式refresh。默认存储内存，注入存储的副作用由真正使用它的操作决定，注册失败可同步抛出。
export function builtinModels(options?: CreateModelsOptions): MutableModels {
	// createModels保存注入依赖或默认内存存储/认证能力，起初供应商表为空，不读认证文件或网络目录。
	const models = createModels(options);
	// 先求值builtinProviders构造整组实例，再for...of逐一注册；不是异步循环，也不await请求。
	for (const provider of builtinProviders()) {
		// 按provider.id写入集合Map并作废该id旧刷新代次；相同id会替换，不在这里调用其getAuth或refreshModels。
		models.setProvider(provider);
	}
	// 返回已注册集合引用，不是快照或模型数组；后续调用者可增删供应商和显式刷新。
	return models;
}
