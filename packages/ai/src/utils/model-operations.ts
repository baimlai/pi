// Models 公共接口区分聊天、图片生成与分类模型，并把图片/分类失败整理成各自结果形状。
import type {
	AnyModel,
	Api,
	AssistantImages,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	ImageApi,
	ImageModel,
	Model,
	ModelType,
	ModelTypeMap,
} from "../types.ts";
import { ModelsError } from "./models-error.ts";

/** The type of a model. Models without `type` are chat models. */
// 用途：读模型种类，旧目录未写 type 时按聊天模型处理。例 {type:"image"} 得 image，无 type 得 chat；不修改目录对象。
export function getModelType(model: AnyModel): ModelType {
	// ?? 只为空缺字段补默认值，不改变明确提供的种类。
	return model.type ?? "chat";
}

/** Runtime-checked model type narrowing, including legacy chat models without `type`. */
// 用途：检查模型种类并收窄 TS 类型。例 if(isModelType(m,"image")) 内可按图片模型使用；TType 保留传入的具体字面量。
export function isModelType<TType extends ModelType>(model: AnyModel, type: TType): model is ModelTypeMap[TType] {
	// 真实运行时比较种类；返回类型中的“model is ...”把判断结果告诉 TS。
	return getModelType(model) === type;
}

// 用途：聊天请求边界确保选择的是聊天模型，否则抛 ModelsError。asserts 表示正常返回后 TS 可把 model 当聊天模型；不会把图片模型转换成聊天模型。
export function assertChatModel(model: AnyModel): asserts model is Model<Api> {
	// 利用上面的种类判断兼容没有 type 的旧聊天目录。
	if (!isModelType(model, "chat")) {
		// 明确报告供应商/模型 id 和种类不匹配，而非让错误请求继续进入网络。
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not a chat model`);
	}
}

// 用途：图片生成接口入口拒绝非图片模型。例把聊天模型传给 generateImages 时提前报 provider 类别错误；正常返回后类型收窄。
export function assertImageModel(model: AnyModel): asserts model is ImageModel<ImageApi> {
	// 请求的是图片能力，所以必须精确匹配 image 种类。
	if (!isModelType(model, "image")) {
		// 给调用方可定位的模型身份信息。
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not an image model`);
	}
}

// 用途：分类接口入口拒绝聊天/图片生成模型；例如 classify 必须接收 classifier 目录项。
export function assertClassifierModel(model: AnyModel): asserts model is ClassifierModel<ClassifierApi> {
	// 不把任何有文字输入的模型都视为分类模型，按明确种类判定。
	if (!isModelType(model, "classifier")) {
		// 错误仍由统一 ModelsError 表达，调用者可读取 code。
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not a classifier model`);
	}
}

/** Rejects classifier images for models whose catalog entry does not accept image input. */
// 用途：分类请求带图片时核对目录是否允许 image 输入。例纯文字分类模型收到 images 数组会在本地报错；此处不验证图片编码本身。
export function assertClassifierInputSupported(
	// 类型只说明是分类模型，具体支持哪些输入仍由目录 input 数据决定。
	model: ClassifierModel<ClassifierApi>,
	// 当前分类请求，images 可省略。
	context: ClassifierContext,
): void {
	// 有至少一张图片且模型声明不支持 image 才拒绝；无图片的文字请求不受此限制。
	if (context.images?.length && !model.input.includes("image")) {
		// 说明错误发生在输入能力不匹配，不冒充远端 HTTP 失败。
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} does not accept image input`);
	}
}

// 用途：将图片生成异常包装成结果。例网络错误时 output=[]、stopReason=error；取消时改为 aborted。只返回普通数据，不再次抛出该错误。
export function imageErrorResult(model: ImageModel<ImageApi>, error: unknown, aborted = false): AssistantImages {
	return {
		// 保留所用接口协议，便于识别结果来源。
		api: model.api,
		// 保留供应商身份，适用于图片和分类错误结果。
		provider: model.provider,
		// 结果里的 model 是模型 id 字符串，不是完整目录对象。
		model: model.id,
		// 失败时没有生成图片，使用空数组而非伪造图片内容。
		output: [],
		// 三元表达式区分用户取消与普通失败；默认参数 aborted=false。
		stopReason: aborted ? "aborted" : "error",
		// 外部抛出值可能不是 Error，在这个边界统一转换成可读说明。
		errorMessage: error instanceof Error ? error.message : String(error),
		// 记录整理结果的毫秒时间戳。
		timestamp: Date.now(),
	};
}

// 用途：分类异常的对应包装器。例取消时 answers={}、stopReason=aborted；与图片版相同地保留模型身份和错误文字，不发网络请求。
export function classifierErrorResult(
	// 类型只说明是分类模型，具体支持哪些输入仍由目录 input 数据决定。
	model: ClassifierModel<ClassifierApi>,
	// 保守接收任意异常，不假定它一定有 message 属性。
	error: unknown,
	// 可以省略的取消标志；默认按普通错误处理。
	aborted = false,
): ClassifierResult {
	return {
		// 保留所用接口协议，便于识别结果来源。
		api: model.api,
		// 保留供应商身份，适用于图片和分类错误结果。
		provider: model.provider,
		// 结果里的 model 是模型 id 字符串，不是完整目录对象。
		model: model.id,
		// 分类失败时没有有效答案集合，返回空对象。
		answers: {},
		// 三元表达式区分用户取消与普通失败；默认参数 aborted=false。
		stopReason: aborted ? "aborted" : "error",
		// 外部抛出值可能不是 Error，在这个边界统一转换成可读说明。
		errorMessage: error instanceof Error ? error.message : String(error),
		// 记录整理结果的毫秒时间戳。
		timestamp: Date.now(),
	};
}
