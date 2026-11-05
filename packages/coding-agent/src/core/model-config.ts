/** Immutable, credential-blind models.json snapshot. */

// 把 models.json 读成一份固定配置快照，供 provider-composer 合成提供商；此处不读 auth.json，也不展开密钥或执行配置命令。
// Promise 版 readFile 异步取得文件文本，避免用同步读取阻塞整个读取等待期。
import { readFile } from "node:fs/promises";
// Type 创建运行时 schema；Static 从同一 schema 推导 TypeScript 类型，减少两套定义不一致。
import { type Static, Type } from "typebox";
// Compile 把 schema 编成可复用校验器；Check 只检查，不自动把 default 写进对象。
import { Compile } from "typebox/compile";
// 只导入验证错误类型，运行时不会加载这个类型名字。
import type { TLocalizedValidationError } from "typebox/error";
// 此辅助函数保留字符串内容，只去掉 // 行注释和尾逗号；不是支持全部 JSON5 语法。
import { stripJsonComments } from "../utils/json.ts";
// 统一处理 ~、file URL 等路径输入，不在这里猜安装目录。
import { normalizePath } from "../utils/paths.ts";
// JSON 开头的 BOM 不是业务字段，解析前先剥离。
import { stripBom } from "../utils/text.ts";
// 复用 ai 字段规则，避免配置层另写一套模型成本/能力格式。
import {
	// 完整成本结构，用于定义一份模型。
	ModelCostSchema,
	// 输入限制，例如图片数量和缩放约束。
	ModelInputLimitsSchema,
	// 允许的输入模态，例如 text 或 image。
	ModelInputModalitySchema,
	// 提示词缓存能力及相关目录元数据。
	ModelPromptCacheSchema,
	// 部分成本结构，用于只覆盖已有模型的几个成本项。
	PartialModelCostSchema,
	// 不同协议的兼容选项。
	ProviderCompatSchema,
	// 思考级别的映射规则，交给请求层选择具体配置。
	ThinkingLevelMapSchema,
} from "./pi-ai-schemas.ts";

// 字符串键、任意值的参数字典；Unknown 允许真实数据的多种 JSON 值，不等于跳过外层结构检查。
const SamplingParamsSchema = Type.Record(Type.String(), Type.Unknown());
// 每个思考级别可分别提供采样参数，后续再合并到通用采样参数上。
const SamplingParamsByThinkingLevelSchema = Type.Object(
	{
		// off 表示关闭思考时使用的采样覆盖；Optional 允许这一档不配置。
		off: Type.Optional(SamplingParamsSchema),
		// minimal 档位的参数字典。
		minimal: Type.Optional(SamplingParamsSchema),
		// low 档位的参数字典。
		low: Type.Optional(SamplingParamsSchema),
		// medium 档位的参数字典。
		medium: Type.Optional(SamplingParamsSchema),
		// high 档位的参数字典。
		high: Type.Optional(SamplingParamsSchema),
		// xhigh 档位的参数字典。
		xhigh: Type.Optional(SamplingParamsSchema),
		// max 档位的参数字典；这些是配置字段，不会在读取时触发模型思考。
		max: Type.Optional(SamplingParamsSchema),
	},
	// description 是 schema 文档元数据，不是发给模型的消息。
	{ description: "samplingParams per thinking level, merged over samplingParams." },
);

// 请求体附加字段仍用字符串键任意值；实际由支持它的 OpenAI 兼容 API 消费。
const SamplingParamsFieldSchema = Type.Record(Type.String(), Type.Unknown(), {
	// 保留原英文描述，文档生成器可以直接使用。
	description: "Fields merged into every request body. Applies only to OpenAI-compatible APIs.",
});
// 请求头配置要求键和值都是字符串；值之后可能按密钥同样的规则展开。
const HeadersSchema = Type.Record(Type.String(), Type.String(), {
	// 本文件只保存原字符串，例如 $TOKEN；不会因为声明了 header 就立即查环境或运行命令。
	description: "Request headers. Values resolve like apiKey.",
});

/** Model fields shared by models entries and modelOverrides entries. Defaults apply only to models entries. */
// 新模型定义和已有模型覆盖共用说明，但只有新模型在合成时补相应默认值。
const ModelFieldDescriptions = {
	// 显示名也用于 --model 模式匹配，不等于发送给 API 的 id。
	name: "Display name, also matched by --model patterns.",
	// reasoning 声明能力，不代表每次请求都必须启用思考。
	reasoning: "Whether the model supports thinking.",
	// contextWindow 表示上下文窗口大小，单位 token。
	contextWindow: "Context window in tokens.",
	// maxTokens 表示最大输出 token 数，不是整个会话的历史大小。
	maxTokens: "Maximum output tokens.",
	// as const 保留字面量及只读类型信息，不会在运行时冻结这个对象。
} as const;

// models 数组中新模型的字段规则：id 必填，其余可从提供商或合成器规则补齐。
const ModelDefinitionSchema = Type.Object({
	// minLength: 1 排除空 ID；Type.String 在运行时检查输入确实是字符串。
	id: Type.String({ minLength: 1, description: "Model ID sent to the API." }),
	// 名称可以省略，但提供时不能是空字符串。
	name: Type.Optional(Type.String({ minLength: 1, description: ModelFieldDescriptions.name })),
	// 单模型可指定与提供商不同的 API 协议。
	api: Type.Optional(Type.String({ minLength: 1, description: "Overrides the provider api." })),
	// 单模型可指定独立服务地址；这里仅验证非空字符串，不验证远端可达。
	baseUrl: Type.Optional(Type.String({ minLength: 1, description: "Overrides the provider baseUrl." })),
	// default 是 schema 的说明，Check 不会填值；provider-composer 会在构造模型时使用 false。
	reasoning: Type.Optional(Type.Boolean({ default: false, description: ModelFieldDescriptions.reasoning })),
	// 可按用户选择的思考级别映射到提供商支持的值。
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	// 未填写 input 时，合成模型默认只收 text；数组中每项也需满足模态规则。
	input: Type.Optional(Type.Array(ModelInputModalitySchema, { default: ["text"] })),
	// 可额外限制输入内容，不将有图片能力等同于无限制图片输入。
	inputLimits: Type.Optional(ModelInputLimitsSchema),
	// 新模型成本使用完整规则；未填写时合成器另有零成本默认值。
	cost: Type.Optional(ModelCostSchema),
	// 可选提示词缓存目录信息，不在配置读取时建立实际缓存。
	promptCache: Type.Optional(ModelPromptCacheSchema),
	// 上下文窗口可省略；一旦给出，下面要求大于零。
	contextWindow: Type.Optional(
		// exclusiveMinimum: 0 排除零和负数；128000 是之后合成时采用的默认值。
		Type.Number({ exclusiveMinimum: 0, default: 128000, description: ModelFieldDescriptions.contextWindow }),
	),
	// 最大输出也可省略，用同样的正数约束。
	maxTokens: Type.Optional(
		// 16384 是新模型输出默认上限，和上下文窗口是两个不同概念。
		Type.Number({ exclusiveMinimum: 0, default: 16384, description: ModelFieldDescriptions.maxTokens }),
	),
	// 每次请求共用的采样附加参数。
	samplingParams: Type.Optional(SamplingParamsFieldSchema),
	// 按思考档位进一步覆盖采样参数，不是替换整个模型配置。
	samplingParamsByThinkingLevel: Type.Optional(SamplingParamsByThinkingLevelSchema),
	// 单模型请求头，之后在请求认证阶段解析。
	headers: Type.Optional(HeadersSchema),
	// 模型级兼容配置，之后与提供商配置按指定规则合并。
	compat: Type.Optional(ProviderCompatSchema),
});

// modelOverrides 按已有模型 ID 局部覆盖；这里不补新模型的默认值，避免覆盖掉原目录值。
const ModelOverrideSchema = Type.Object({
	// 只修改显示名时不要求重写其他模型字段。
	name: Type.Optional(Type.String({ minLength: 1, description: ModelFieldDescriptions.name })),
	// 明确 false 仍是有效覆盖，后续应使用 ?? 而非 || 保留它。
	reasoning: Type.Optional(Type.Boolean({ description: ModelFieldDescriptions.reasoning })),
	// 覆盖思考级别映射。
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	// 覆盖输入模态，不在此数组上加新模型的默认 text。
	input: Type.Optional(Type.Array(ModelInputModalitySchema)),
	// 输入限制由合成器按嵌套层级合并。
	inputLimits: Type.Optional(ModelInputLimitsSchema),
	// PartialModelCostSchema 允许只改 output 等部分成本。
	cost: Type.Optional(PartialModelCostSchema),
	// 可覆盖提示词缓存相关配置。
	promptCache: Type.Optional(ModelPromptCacheSchema),
	// 覆盖窗口时仍必须是正数。
	contextWindow: Type.Optional(
		// 没有 default，没填写时保留模型原窗口。
		Type.Number({ exclusiveMinimum: 0, description: ModelFieldDescriptions.contextWindow }),
	),
	// 输出限制同理：正数覆盖，不填写就保留已有值。
	maxTokens: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: ModelFieldDescriptions.maxTokens })),
	// 通用采样字段的局部覆盖。
	samplingParams: Type.Optional(SamplingParamsFieldSchema),
	// 按思考档位的采样字段覆盖。
	samplingParamsByThinkingLevel: Type.Optional(SamplingParamsByThinkingLevelSchema),
	// 按模型 ID 添加请求头。
	headers: Type.Optional(HeadersSchema),
	// 按模型 ID 添加兼容选项。
	compat: Type.Optional(ProviderCompatSchema),
});

// 提供商级配置：默认地址、认证声明、模型定义与已有目录的覆盖。
const ProviderConfigSchema = Type.Object({
	// 菜单显示的提供商名称。
	name: Type.Optional(Type.String({ minLength: 1, description: "Display name." })),
	// 地址可以省略，用内置提供商或其他层的配置。
	baseUrl: Type.Optional(
		// 配置该地址可能同时影响内置模型；Radius 等特殊情况由合成器处理。
		Type.String({ minLength: 1, description: "API base URL. Also applies to the provider's built-in models." }),
	),
	// apiKey 保存配置表达式本身，不在这一步解析为真正秘密值。
	apiKey: Type.Optional(
		// 字段提供时必须是字符串。
		Type.String({
			// 空字符串不满足此文件 schema 的约束。
			minLength: 1,
			// 支持字面量、$NAME 环境模板、!command 命令输出；实际解释见 resolve-config-value。
			description: 'Literal key, "$NAME" environment interpolation, or "!command" output.',
		}),
	),
	// 提供商可指定供其聊天模型使用的默认 API 协议。
	api: Type.Optional(
		// 协议 ID 用字符串表示，可由扩展登记。
		Type.String({
			// 要求非空，但不是在这里查找该 API 的执行实现。
			minLength: 1,
			// 原描述列举常见协议，不把所有提供商都强行当成同一种请求格式。
			description:
				'API for the provider\'s models, such as "openai-completions", "openai-responses", "anthropic-messages", or "google-generative-ai".',
		}),
	),
	// 这里只接受 radius 这一文件配置值；需要 baseUrl 的跨字段关系在合成时进一步检查。
	oauth: Type.Optional(Type.Literal("radius", { description: "OAuth login flow. Requires baseUrl." })),
	// 提供商级请求头。
	headers: Type.Optional(HeadersSchema),
	// 提供商级兼容选项。
	compat: Type.Optional(ProviderCompatSchema),
	// 是否用解析后的 key 显式构造 Authorization: Bearer 请求头。
	authHeader: Type.Optional(
		// 默认关闭；并非关闭提供商自己的所有认证处理。
		Type.Boolean({ default: false, description: "Whether to send the resolved API key as Authorization: Bearer." }),
	),
	// models 用于定义/更新聊天模型条目。
	models: Type.Optional(Type.Array(ModelDefinitionSchema)),
	// modelOverrides 是模型 ID 到局部覆盖的字典，而不是另一个数组。
	modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema)),
});

// 单独抽出根字段，方便根 schema 继续添加 $schema 元数据。
const ModelsConfigProperties = {
	// providers 本身必填，允许空对象；键为提供商 ID，值逐个按上面的规则检查。
	providers: Type.Record(Type.String(), ProviderConfigSchema),
};

/** models.json 根 schema：校验磁盘输入，并供其他入口复用结构规则。 */
export const ModelsConfigSchema = Type.Object({
	// $schema 可让编辑器知道 JSON schema 地址；不在这里发网络请求下载它。
	$schema: Type.Optional(Type.String()),
	// 对象展开复制 providers 字段声明，不是展开用户数据。
	...ModelsConfigProperties,
});

/** Entry schemas rendered into docs/models-configuration.md. */
/** 把提供商、模型和覆盖三个规则交给文档生成器，保持文档字段说明与验证入口一致。 */
export const ModelsJsonSchemas = {
	// provider 条目的 schema。
	provider: ProviderConfigSchema,
	// 新模型定义的 schema。
	model: ModelDefinitionSchema,
	// 已有模型局部覆盖的 schema。
	modelOverride: ModelOverrideSchema,
};

// 在模块加载时编译一次，之后多次 load 复用 Check/Errors，不必每读一个文件重新编译。
const validateModelsConfig = Compile(ModelsConfigSchema);

// typeof 在类型位置取得 schema 的类型，Static 推导它对应的模型配置 TS 类型。
export type ModelsJsonModel = Static<typeof ModelDefinitionSchema>;
// 覆盖类型来自覆盖 schema，保留各字段可选性。
export type ModelsJsonModelOverride = Static<typeof ModelOverrideSchema>;
// 提供商配置类型同样从运行时规则导出。
export type ModelsJsonProvider = Static<typeof ProviderConfigSchema>;

/** 将错误位置变成可读字段路径；如缺少 providers.demo.models.0.id，便于找到 models.json 的问题。 */
function formatValidationPath(error: TLocalizedValidationError): string {
	// required 错误通常指向父对象，需要把缺少的子字段再拼上。
	if (error.keyword === "required") {
		// 错误参数随 keyword 变化；这里按 required 错误的参数约定读取字段列表。
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		// 可选链取第一个缺失字段；不存在时走下面普通路径。
		const requiredProperty = requiredProperties?.[0];
		// 确实有字段名才额外拼接。
		if (requiredProperty) {
			// 去掉开头 /，再将其余 / 换为点；这里不是完整的 JSON Pointer 转义解码器。
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			// 已有父路径就拼父.子，否则直接显示子字段名。
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	// 其他错误直接把校验器给的位置改成点分隔形式。
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	// 空路径表示根对象，因此给出 root 标签。
	return path || "root";
}

/** 递归冻结普通 JSON 配置对象；例：冻结后不能再改某提供商的 headers，返回类型仍保持 T。 */
function deepFreeze<T>(value: T): T {
	// 泛型 T 可以是原始值；跳过非对象、null 和已冻结对象，避免继续递归这些值。
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	// 先递归冻结子值，数组元素也包含在 Object.values 中；输入来自解析并复制的 JSON，不处理任意循环对象。
	for (const child of Object.values(value)) deepFreeze(child);
	// 再冻结当前层；这是运行时限制，和仅写 readonly 类型不同。
	return Object.freeze(value);
}

/** One immutable load of models.json. */
/** 单次加载的配置快照：提供商内容已深冻结，常见读取/解析/校验错误通过 getError 查询。 */
export class ModelConfig {
	// ReadonlyMap 只描述读取接口，Map 没有运行时 freeze；private 也只在 TS 检查期限制访问，不是 # 字段的运行时隔离。
	private readonly providers: ReadonlyMap<string, ModelsJsonProvider>;
	// 错误与空目录可以共存；没有错误时是 undefined。
	private readonly error: string | undefined;

	/** 私有构造器只保存快照和错误；外部应 await ModelConfig.load(path)，不会自行 new。 */
	private constructor(providers: ReadonlyMap<string, ModelsJsonProvider>, error?: string) {
		// 保留加载时创建的映射，不在构造器重新读取文件。
		this.providers = providers;
		// 保存一份可读错误说明，而不是在 getProvider 时重复报同一加载错误。
		this.error = error;
	}

	/** 异步读路径 → 去 BOM/注释/尾逗号 → 校验 → 深复制并冻结；例：await ModelConfig.load("/tmp/models.json")。 */
	static async load(modelsJsonPath: string | undefined): Promise<ModelConfig> {
		// 没有路径（包括空字符串）表示禁用文件配置，直接得到无错误的空目录。
		if (!modelsJsonPath) return new ModelConfig(new Map());
		// 先归一化输入；这一行在读取的 try 外，非法路径转换等异常没有被下面的读取 catch 包住。
		const path = normalizePath(modelsJsonPath);
		// let 声明之后赋值的文本，类型是 string，不靠 any 暂存。
		let content: string;
		try {
			// 只读磁盘文本，不解析环境、执行 !命令或发模型请求。
			content = await readFile(path, "utf-8");
		} catch (error) {
			// 文件不存在是正常的未配置状态；as 断言只帮助读取错误码，不执行校验。
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new ModelConfig(new Map());
			// 其他读取错误转成带错误的空快照，调用方通过 getError 展示。
			return new ModelConfig(
				// 读取失败时没有部分提供商数据可发布。
				new Map(),
				// 保留路径和具体原因，方便定位文件或权限问题。
				`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			);
		}

		// 磁盘 JSON 属于输入边界，先放 unknown，校验后再使用其字段。
		let parsed: unknown;
		try {
			// 先去 BOM，再剥行注释与尾逗号，最后 JSON.parse；字符串内部 // 不会被当注释。
			parsed = JSON.parse(stripJsonComments(stripBom(content)));
		} catch (error) {
			// 语法解析失败也转成带错误的空快照。
			return new ModelConfig(
				// 不发布半解析结果。
				new Map(),
				// 错误提示区分“读取失败”和“JSON 文本无法解析”。
				`Failed to parse models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			);
		}

		// 运行时检查不受信任的 parsed；TS 类型本身不能验证磁盘文件实际内容。
		if (!validateModelsConfig.Check(parsed)) {
			// 把多个字段错误组织成便于用户阅读的多行说明。
			const errors =
				// 复用同一个编译校验器。
				validateModelsConfig
					// 取得详细错误，而不仅是 Check 返回的布尔值。
					.Errors(parsed)
					// map 为每条错误加字段路径与缩进，再拼上校验器提供的说明。
					.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
					// join 合成多行；错误列表为空时提供兜底说明。
					.join("\n") || "Unknown schema error";
			// schema 失败不发布提供商，返回一份可查询错误的空配置。
			return new ModelConfig(new Map(), `Invalid models.json schema:\n${errors}\n\nFile: ${path}`);
		}

		// 校验通过后，创建按 providerId 查找的映射。
		const providers = new Map<string, ModelsJsonProvider>();
		// 数组解构同时取字典键与配置值；parsed 已由 Check 收窄为 schema 对应类型。
		for (const [providerId, provider] of Object.entries(parsed.providers)) {
			// 先深复制切断与解析对象的共享，再递归冻结，供后续组合层安全读取。
			providers.set(providerId, deepFreeze(structuredClone(provider)));
		}
		// 成功路径不传 error，getError 会得到 undefined。
		return new ModelConfig(providers);
	}

	/** 查一家原始配置，例如 getProvider("demo")；未配置就返回 undefined，不解析密钥或请求头。 */
	getProvider(providerId: string): ModelsJsonProvider | undefined {
		// 返回的是冻结的配置值，不是完成认证的 Provider 实例。
		return this.providers.get(providerId);
	}

	/** 列配置中声明的提供商 ID；例如 providers 有 a/b 就返回 ["a", "b"]，不包含所有内置提供商。 */
	getProviderIds(): readonly string[] {
		// keys 返回迭代器，... 展开为新数组；readonly 是返回类型上的限制。
		return [...this.providers.keys()];
	}

	/** 查询这次加载记录的错误，例如 JSON 语法错误；成功或未创建配置文件时为 undefined。 */
	getError(): string | undefined {
		// 只读保存的说明，不重新访问文件或再次运行校验器。
		return this.error;
	}
}
