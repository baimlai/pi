// 在pi-ai的pi-schema规则与coding-agent的TypeBox类型系统之间适配，复用原JSON约束，不维护两份字段名单。
/**
 * pi-ai's configuration schemas (built with pi-schema) as TypeBox schemas, for the coding agent's own TypeBox-built
 * configuration schemas (models.json, settings.json): the same JSON, typed for TypeBox's `Static`.
 */

import {
	// ProviderCompat只是静态类型，下面对应JsonSchema才是运行时规则对象。
	type ProviderCompat,
	// as在导入位置是改局部变量名，避免和本模块包装后的同名导出冲突，不是类型断言。
	ProviderCompatSchema as ProviderCompatJsonSchema,
} from "@earendil-works/pi-ai/providers/compat-schema";
import {
	type ModelCost,
	ModelCostSchema as ModelCostJsonSchema,
	type ModelInputLimits,
	ModelInputLimitsSchema as ModelInputLimitsJsonSchema,
	type ModelInputModality,
	ModelInputModalitySchema as ModelInputModalityJsonSchema,
	type ModelPromptCache,
	ModelPromptCacheSchema as ModelPromptCacheJsonSchema,
	type ModelThinkingLevel,
	ModelThinkingLevelSchema as ModelThinkingLevelJsonSchema,
	type ThinkingLevelMap,
	ThinkingLevelMapSchema as ThinkingLevelMapJsonSchema,
} from "@earendil-works/pi-ai/providers/model-schema";
import { Type } from "typebox";

// Unsafe给外部JSON schema加TypeBox类型关联/内部标记，不运行认证或检查某个配置值；编译后的验证器仍使用JSON中的字段约束。
export const ProviderCompatSchema = Type.Unsafe<ProviderCompat>(ProviderCompatJsonSchema);
// 费用规则包含input/output/cache读写及可选tiers，静态类型从pi-ai原类型沿用，不在此换算价格。
export const ModelCostSchema = Type.Unsafe<ModelCost>(ModelCostJsonSchema);
// 输入体积/图片数量/缩放等限制沿用原规则，不在此执行图片缩放或请求截断。
export const ModelInputLimitsSchema = Type.Unsafe<ModelInputLimits>(ModelInputLimitsJsonSchema);
// 输入模态沿用text/image字面量规则，不代表当前输入已包含图片。
export const ModelInputModalitySchema = Type.Unsafe<ModelInputModality>(ModelInputModalityJsonSchema);
// 短/长缓存寿命规则复用，值单位秒；本行不创建服务端缓存或发预热请求。
export const ModelPromptCacheSchema = Type.Unsafe<ModelPromptCache>(ModelPromptCacheJsonSchema);
// 模型思考档位允许off和minimal到max，复用pi-ai统一名单，区别于某个具体模型可支持的子集。
export const ModelThinkingLevelSchema = Type.Unsafe<ModelThinkingLevel>(ModelThinkingLevelJsonSchema);
// 档位映射的值为字符串或null，null标记不支持；缺项的请求行为由provider层处理，不由这个包装决定。
export const ThinkingLevelMapSchema = Type.Unsafe<ThinkingLevelMap>(ThinkingLevelMapJsonSchema);

/** `ModelCostSchema` with every field optional, for model overrides that change some of the rates. */
// 模型覆盖可只改部分费用，例如{output:2}；Partial<ModelCost>是浅层可选，运行时也只移除顶层required。
export const PartialModelCostSchema = Type.Unsafe<Partial<ModelCost>>(withoutRequired(ModelCostJsonSchema));

// 输入schema对象，返回删除顶层required后的浅复制，不改原对象，不深遍历子schema，不做校验。
// 例如费用tiers本身变可选，但若提供某个tier，其inputTokensAbove等原先必填字段仍然必填；其余嵌套对象继续共享引用。
function withoutRequired(schema: object): object {
	// as只告诉TS可读required；解构把它存到忽略变量_required，其余可枚举自有字段收进rest。
	const { required: _required, ...rest } = schema as { required?: unknown };
	// 返回新外层对象；没有required就自然复制其余字段，不添加替代默认。
	return rest;
}
