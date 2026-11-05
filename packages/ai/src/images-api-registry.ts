// 图片 API 注册表：把 API 名称映射到图片生成函数；同名注册覆盖旧项，与聊天注册表各自保存状态。
import type { AssistantImages, ImageApi, ImageModel, ImagesContext, ImagesFunction, ImagesOptions } from "./types.ts";

// 内部统一调用签名；箭头右侧是返回类型，所有实现都要交回 AssistantImages 的 Promise。
export type ImagesApiFunction = (
	// ImageModel<ImageApi> 接纳公共图片 API 范围内的模型；真正分发还要检查 api 是否匹配。
	model: ImageModel<ImageApi>,
	// 本次文字/参考图片输入。
	context: ImagesContext,
	// 可省略的公共图片请求选项。
	options?: ImagesOptions,
) => Promise<AssistantImages>;

// 注册时保留实现自己的 API 与选项类型；extends 是编译期约束，= 给调用方未指定泛型时的默认类型。
export interface ImagesApiProvider<TApi extends ImageApi = ImageApi, TOptions extends ImagesOptions = ImagesOptions> {
	// 作为注册表键的 API 名称。
	api: TApi;
	// 图片函数使用 TOptions；该字段类型本身不要求 model.api 在运行时等于上面的 api。
	generateImages: ImagesFunction<TOptions>;
}

// 存储层用公共签名隐藏各实现不同的选项类型，由包装器连接两端。
interface ImagesApiProviderInternal {
	// 包装后的实现所对应的 API 名称。
	api: ImageApi;
	// 带 API 一致性检查的调用函数。
	generateImages: ImagesApiFunction;
}

// 一条注册记录：实现和可选来源；本文件仅保存 sourceId，没有按来源注销的接口。
type RegisteredImagesApiProvider = {
	// 单独创建的内部对象，不直接保存调用方的整个 provider 对象。
	provider: ImagesApiProviderInternal;
	// ? 表示属性可以缺省；该标记不会自行触发卸载或恢复旧版本。
	sourceId?: string;
};

// 模块级 Map 强引用当前各 API 的条目；同 API 的后一次 set 取代先前值。
const imagesApiProviderRegistry = new Map<string, RegisteredImagesApiProvider>();

// 用途：把特定选项类型的图片实现包装为公共签名。输入 API 和函数，返回新函数；例如 API 为 A 时，传入 model.api=B 会同步抛错。
// 包装器只核对 API 字符串，随后透传模型、上下文、选项；as 只帮助编译器，不验证选项内容。包装阶段本身不发请求。
function wrapGenerateImages<TOptions extends ImagesOptions>(
	// 要求模型匹配的 API。
	api: ImageApi,
	// 捕获此时传入的函数引用，后续改原对象字段不会自动换掉它。
	generateImages: ImagesFunction<TOptions>,
): ImagesApiFunction {
	// 返回普通箭头函数；它返回 Promise，但函数自身并没有 async 异常转换。
	return (model, context, options) => {
		// 校验从公共注册表取出实现后，模型的 API 仍与此实现相符。
		if (model.api !== api) {
			// API 不一致时在调用实际实现之前同步抛出。
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		// 类型断言消除统一签名与实现签名的差异；返回下层原 Promise，不捕获其异常。
		return generateImages(model, context, options as TOptions);
	};
}

// 用途：注册或替换一个图片 API，输入实现与可选来源，无返回值；副作用是改模块注册表。例如同 API 先注册 A 再注册 B，后续查到 B。
// 流程：取 api 作键，创建包装对象并保存来源；不会调用图片函数，也不维护旧实现栈。
export function registerImagesApiProvider<TApi extends ImageApi, TOptions extends ImagesOptions>(
	// 泛型在调用处关联 API 字面量和实现选项。
	provider: ImagesApiProvider<TApi, TOptions>,
	// 来源仅作为记录数据保存；当前文件没有暴露按来源移除的函数。
	sourceId?: string,
): void {
	// Map.set 对同键直接覆盖，不保留旧值供回退。
	imagesApiProviderRegistry.set(provider.api, {
		// 保存当前字段值及包装函数，而非直接存入原 provider 引用。
		provider: {
			// 将 API 名称同时保留在实现对象中。
			api: provider.api,
			// 安装运行时 API 一致性检查。
			generateImages: wrapGenerateImages(provider.api, provider.generateImages),
		},
		// 属性简写等同于 sourceId: sourceId。
		sourceId,
	});
}

// 用途：输入 API 名称，返回当前内部实现或 undefined；例如注册 A 后查询 A 得到包装对象。只读查表，无加载、请求或复制副作用。
export function getImagesApiProvider(api: ImageApi): ImagesApiProviderInternal | undefined {
	// ?. 在键不存在时直接得到 undefined；命中则返回表中同一个 provider 对象引用。
	return imagesApiProviderRegistry.get(api)?.provider;
}
