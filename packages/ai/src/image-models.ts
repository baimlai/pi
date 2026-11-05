// 图片静态目录的旧版读取接口：把生成的数据建成两层 Map，供 compat 按供应商和模型 ID 查询；不跟随 Models 的运行时刷新。
// 这里只读生成产物，目录内容应从生成器输入更新，不在本文件手改。
import { IMAGE_MODELS } from "./models.generated.ts";
// 类型导入用于描述目录项，不会创建模型实例或验证供应商响应。
import type { ImageApi, ImageModel } from "./types.ts";

/**
 * Compat reads of the generated catalog restricted to image models. New code
 * uses `Models.getModelOfType("image", ...)` or `getBuiltinImageModel()` from `providers/all`.
 */

// 类型位置的 typeof 提取生成对象的编译期形状，不是运行时 typeof 字符串。
type Catalog = typeof IMAGE_MODELS;
// keyof 取某供应商目录的模型键联合；空目录的键类型为 never。
type ImageModelIds<TProvider extends keyof Catalog> = keyof Catalog[TProvider];

/** Built-in providers with at least one image model in the generated catalog. */
// 映射类型逐个检查供应商：模型键不是 never 才留下供应商名，最后索引取所有结果的联合。
export type BuiltinImageProvider = {
	// 两边包成元组后整体判断是否 never，避免条件类型对联合分发；无图片模型的供应商被替换成 never。
	[TProvider in keyof Catalog]: [ImageModelIds<TProvider>] extends [never] ? never : TProvider;
}[keyof Catalog];

// 用供应商与模型键推导 API，再返回公共 ImageModel<TApi> 形状；不会保留生成条目的全部字面量属性类型。
type BuiltinImageModel<
	// 供应商限于静态目录中有图片模型的键。
	TProvider extends BuiltinImageProvider,
	// 模型键与该供应商关联，不能在正常类型检查下把别家的 ID 随意配进来。
	TModelId extends ImageModelIds<TProvider>,
	// infer 声明从目录项中提取的 API 类型；不满足图片模型形状则结果为 never。
> = Catalog[TProvider][TModelId] extends ImageModel<infer TApi extends ImageApi> ? ImageModel<TApi> : never;

// 两层索引：供应商名 -> 模型 ID -> 原目录对象；Map 结构新建，但模型对象没有深拷贝。
const imageModelsByProvider = new Map<string, Map<string, ImageModel<ImageApi>>>();
// 模块首次求值时遍历生成目录，不进行网络发现或凭证解析。
for (const [provider, models] of Object.entries(IMAGE_MODELS)) {
	// 给当前供应商建立模型索引。
	const imageModels = new Map<string, ImageModel<ImageApi>>();
	// 断言统一各供应商的目录类型；Object.values 取条目值，运行时不会按断言再校验一遍。
	for (const model of Object.values(models as Record<string, ImageModel<ImageApi>>)) {
		// 以对象内部 id 为键保存原引用；若出现重复 ID，最后一项覆盖此前值。
		imageModels.set(model.id, model);
	}
	// 只把有图片模型的供应商放入外层表，与 BuiltinImageProvider 的静态筛选对应。
	if (imageModels.size > 0) imageModelsByProvider.set(provider, imageModels);
}

/** @deprecated Static catalog read. Use `getBuiltinImageModel` from "@earendil-works/pi-ai/providers/all" or `Models.getModelOfType("image", ...)`. */
// 用途：给定静态供应商和对应模型键，返回生成目录中的原模型对象；例如对目录中的同一供应商/模型键重复查询，会得到同一个对象引用。
// 流程是两层 Map 查找，无请求或刷新。签名假定键合法，as 不提供运行时保障；绕过类型检查传错键仍可能得到 undefined，而非此处抛错。
export function getImageModel<TProvider extends BuiltinImageProvider, TModelId extends ImageModelIds<TProvider>>(
	// 泛型供应商参数决定下一参数允许的模型键。
	provider: TProvider,
	// 模型 ID 在编译期与 provider 绑定。
	modelId: TModelId,
): BuiltinImageModel<TProvider, TModelId> {
	// ?. 处理外层没命中；两处 as 只改变编译器看法，不转换键值或补出模型。
	return imageModelsByProvider.get(provider)?.get(modelId as string) as BuiltinImageModel<TProvider, TModelId>;
}

/** @deprecated Static catalog read. Use `Models.getProviders()`. */
// 用途：返回有静态图片模型的供应商名新数组，无外部副作用；例如用于填图片供应商下拉框。这里只反映生成目录，不能说明本机已有凭证或可发请求。
export function getImageProviders(): BuiltinImageProvider[] {
	// 将 Map 键迭代器物化成新数组；顺序是构表时供应商的首次插入顺序。
	return Array.from(imageModelsByProvider.keys()) as BuiltinImageProvider[];
}

/** @deprecated Static catalog read. Use `getBuiltinImageModels` from "@earendil-works/pi-ai/providers/all" or `Models.getModelsOfType("image")`. */
// 用途：输入静态图片供应商名，返回其图片模型新数组；例如 getImageProviders().map(p => getImageModels(p)) 可逐家枚举。
// 只读内存表；数组新建但内部模型对象仍共享。绕过静态约束传入不存在的供应商时，运行时返回空数组。
export function getImageModels<TProvider extends BuiltinImageProvider>(
	// 泛型让返回模型的 API 类型与指定供应商目录关联。
	provider: TProvider,
): BuiltinImageModel<TProvider, ImageModelIds<TProvider>>[] {
	// 取该供应商的内层模型 Map，可能在无效运行时输入下不存在。
	const models = imageModelsByProvider.get(provider);
	// 三元表达式分别处理命中与未命中；类型断言不克隆或验证模型。
	return models ? (Array.from(models.values()) as BuiltinImageModel<TProvider, ImageModelIds<TProvider>>[]) : [];
}
