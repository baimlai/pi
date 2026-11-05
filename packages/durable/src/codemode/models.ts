// 所属：packages/durable/src/codemode，代码模式脚本的 `models.*` 能力（模型目录、分类、图片生成）。
// 作用：把宿主的 Models 暴露给沙箱脚本。目录查询是普通 host global，按 journal 重放；classify/generateImages
// 属于付费副作用，因此包装成内部工具（callers:["tools"]、pi.codemode. 前缀、对脚本隐藏），从而拥有嵌套任务、
// 实时行、取消、用量统计和重放策略。codemode.ts 会把脚本对全局函数的调用转换成对这些内部工具的调用。
// 职责边界：只做参数形状校验、可信模型解析、调用 provider 与包装结果；不实现 provider，不决定重试/重放，
// 也不把宿主的 headers/baseUrl 暴露给脚本。
// 上游：codemode.ts 的 createCodemodeExtension 安装 createModelTools()；callGlobal 对目录函数调用 catalogCall；
// 脚本调用 models.classify/generateImages 时经 asToolCall 变成内部工具调用，最终执行这里的 defineTool。
// 下游：pi-ai 的 Models/ClassifierContext/ImagesContext/Usage，pi-schema 的 obj/unknown，harness/define.ts。
// 能力清单（导出项）：
// - CODEMODE_INTERNAL_PREFIX/CLASSIFY_TOOL/GENERATE_IMAGES_TOOL：内部工具的保留名称。
// - MODEL_CALLS：脚本全局名到内部工具名的映射。
// - CATALOG_GLOBALS：三个目录查询全局名。
// - MAX_CONCURRENT_MODEL_CALLS：同时进行的付费模型调用上限（4）。
// - MODELS_DESCRIPTION：给模型的 models.* 说明文本。
// - catalogCall(name,args,models,context)：目录查询分发；结果删除 headers 后转成 JSON。
// - createModelTools()：返回两个内部 ToolRegistration；构造时不发起付费请求。
// 典型调用：`await models.getAvailableOfType("classifier")` 走 catalogCall；`await models.classify(model, ctx)`
// 变成内部工具调用，usage 由 Harness 计入，脚本拿到结构化结果。
// 建议阅读顺序：常量与 MODEL_CALLS → 校验辅助（isRecord/describeValue/toModelType/toProvider）→ catalogCall →
// checkClassifierContext/checkImagesContext → resolveModel → modelResult/createModelTools。
/**
 * `models.*` for code mode scripts, copied from the coding agent's code mode: the model catalog, and classifier and
 * image model calls.
 *
 * The catalog functions are host globals, journaled like any global. `models.classify()` and `models.generateImages()`
 * are paid effects, so each runs as an internal tool (`callers: ["tools"]`, a reserved name, hidden from scripts'
 * tool listings): a nested durable call with its own task, live row, abort, usage accounting, and replay policy. The
 * code mode tool turns a script's call of the global into a call of that tool.
 */
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type {
	AnyModel,
	ClassifierContext,
	ImagesContext,
	Models,
	ModelType,
	ModelTypeMap,
	Usage,
} from "@earendil-works/pi-ai";
import { obj, unknown } from "@earendil-works/pi-schema";
import { defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";

/** Reserved names of code mode's internal tools; they are never listed to scripts or the model. */
export const CODEMODE_INTERNAL_PREFIX = "pi.codemode.";
export const CLASSIFY_TOOL = `${CODEMODE_INTERNAL_PREFIX}models.classify`;
export const GENERATE_IMAGES_TOOL = `${CODEMODE_INTERNAL_PREFIX}models.generateImages`;

/** The global a script calls, by internal tool. */
export const MODEL_CALLS: Readonly<Record<string, string>> = {
	"models.classify": CLASSIFY_TOOL,
	"models.generateImages": GENERATE_IMAGES_TOOL,
};

/** The catalog functions, host globals of the `models` namespace. */
export const CATALOG_GLOBALS = [
	"models.getModelsOfType",
	"models.getAvailableOfType",
	"models.getModelOfType",
] as const;

/** `models.classify()` and `models.generateImages()` calls one script may have in flight; the rest wait. */
export const MAX_CONCURRENT_MODEL_CALLS = 4;

const MODEL_TYPES: ReadonlySet<string> = new Set<ModelType>(["chat", "image", "classifier"]);

export const MODELS_DESCRIPTION = [
	"`models` (all functions return promises):",
	'- `models.getModelsOfType(type, provider?)`, `models.getAvailableOfType(type, provider?)` (configured auth only), `models.getModelOfType(type, provider, id)`: the catalog; `type` is "chat", "image", or "classifier".',
	'- `models.classify(model, { state: { ... }, images?: [{ type: "image", data, mimeType }], questions: { <id>: { type: "choice", instructions, criteria: { <label>: <meaning> } } | { type: "score", instructions, criteria: [<lowest level>, ..., <highest level>] } | { type: "bool", instructions, criteria: { true: <meaning>, false: <meaning> } } } })` resolves to `{ answers: { <id>: ... }, stopReason, errorMessage?, usage? }`.',
	'- `models.generateImages(model, { input: [{ type: "text", text: <prompt> }, ...optional { type: "image", data, mimeType }] })` resolves to `{ output: [image blocks], stopReason, errorMessage?, usage? }`; show each image with `image(block)`.',
	`At most ${MAX_CONCURRENT_MODEL_CALLS} classify/generateImages calls run at once; more wait.`,
].join("\n");

/** 检查脚本传来的 unknown 是否为可按键访问的对象，例 [] 为假。纯判断，不验证对象各字段。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	// 类型谓词帮助 TS 收窄；脚本值跨 VM 边界，因此这里确有运行时判断。
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A script value in an error message: `undefined`, `a string`, `an array`, or its keys (`{ prompt }`). */
/** 将未知参数概括为错误提示文字；例 {prompt:"hi"}→"{ prompt }"。不递归内容，不修改输入。 */
function describeValue(value: unknown): string {
	// null/undefined 先处理，避免后续把 null 当作可枚举对象。
	if (value === undefined || value === null) return String(value);
	// 数组只说明是否为空，不泄出其中元素。
	if (Array.isArray(value)) return value.length === 0 ? "an empty array" : "an array";
	if (typeof value === "object") {
		// Object.keys 只取对象自身可枚举字符串键，最多展示前六个。
		const keys = Object.keys(value);
		if (keys.length === 0) return "{}";
		return `{ ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", ..." : ""} }`;
	}
	// 其余按 JS typeof 描述，不把实际字符串当成错误正文。
	return typeof value === "string" ? "a string" : `a ${typeof value}`;
}

/** `an image`, `a classifier`. */
/** 给内部英文类型名加冠词，例 image→an image；只按首字母元音判断，不做语音分析。 */
function withArticle(word: string): string {
	return `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
}

/** 校验脚本的模型类别，成功返回 chat/image/classifier；例 "other" 抛错，无外部副作用。 */
function toModelType(value: unknown): ModelType {
	// Set 是允许的类别表；as 只在已检查的分支把 string 收窄成联合类型。
	if (typeof value === "string" && MODEL_TYPES.has(value)) return value as ModelType;
	// 不支持的值会作为脚本全局调用失败返回，而不是发给 provider。
	throw new Error(`Unknown model type ${JSON.stringify(value)}. Use "chat", "image", or "classifier".`);
}

/** 解析可选 provider；null/undefined 表示不筛选，字符串原样返回，其他类型抛错。例 "openai" 保持原值。 */
function toProvider(value: unknown): string | undefined {
	// 这里不检查 provider 是否已注册，实际目录查询决定是否有结果。
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error("provider must be a string");
	return value;
}

/** Catalog entry for scripts. `headers` is dropped because configured headers can carry credentials. */
/** 将宿主模型变为可跨 VM 的 JSON，删除 headers 后返回拷贝。例自定义认证头不会进入脚本目录；JSON 编码失败会抛错。 */
function toModelInfo(model: AnyModel): JsonValue {
	// 浅拷贝顶层，让 delete 不修改 Models 中的原始注册。
	const info: Record<string, unknown> = { ...model };
	// 仅删除 headers 字段；不是任意字段的通用脱敏器。
	delete info.headers;
	// JSON round-trip 去掉 undefined 等非 JSON 内容；as 不增加运行时校验。
	return JSON.parse(JSON.stringify(info)) as JsonValue;
}

/** The catalog functions: what a script's call of `name` with `args` (the argument list) resolves to. */
/** 按全局函数名查询宿主目录；args 是 VM 参数列表，context 提供取消。返回 JSON 模型/列表或 undefined。
 * 例 getModelOfType("image",provider,id) 无匹配时不抛错；形状/类别错误抛错，可用性查询错误原样传播。
 */
export async function catalogCall(
	name: string,
	args: unknown,
	models: Models,
	context: Context,
): Promise<JsonValue | undefined> {
	// 参数不是数组时按空列表处理，后面的必要参数检查会给具体提示。
	const list = Array.isArray(args) ? args : [];
	// 数组解构按位置取参数；不足三项的变量为 undefined。
	const [type, provider, id] = list;
	// 全目录查询是同步的；每条模型都删除 headers 再交给脚本。
	if (name === "models.getModelsOfType")
		return models.getModelsOfType(toModelType(type), toProvider(provider)).map(toModelInfo);
	if (name === "models.getAvailableOfType") {
		// 可用目录由已配置认证筛选，转发取消 signal；此处不执行 classify/generateImages。
		const available = await models.getAvailableOfType(toModelType(type), toProvider(provider), {
			...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
		});
		// 等待目录筛选完成，再转为脚本可以接收的 JSON。
		return available.map(toModelInfo);
	}
	// 分发器只会传这三个已声明函数名，余下分支就是单模型查询。
	if (typeof provider !== "string" || typeof id !== "string") {
		// 将每个参数做形状摘要，说明 provider/id 需要分开传。
		throw new Error(
			`models.getModelOfType(type, provider, id) expects three strings, got (${list.map(describeValue).join(", ")}). The provider and the id are separate arguments, for example models.getModelOfType("classifier", "typesafe", "jev-latest").`,
		);
	}
	// 类型类别仍先校验，再精确按 provider + id 查宿主注册。
	const model = models.getModelOfType(toModelType(type), provider, id);
	return model === undefined ? undefined : toModelInfo(model);
}

const CLASSIFIER_CONTEXT_SHAPE =
	'{ state: { ... }, images?: [{ type: "image", data: <base64>, mimeType }], questions: { <id>: { type: "choice", instructions, criteria: { <label>: <meaning> } } | { type: "score", instructions, criteria: [<lowest level>, ..., <highest level>] } | { type: "bool", instructions, criteria: { true: <meaning>, false: <meaning> } } } }';

/** Check a script's classifier context, so mistakes fail with the expected shape instead of a provider error. */
/** 检查脚本分类请求的外层形状，返回同一对象的类型视图；失败抛带期望形状的 Error。
 * 例 choice 的 criteria 必须是非空字符串映射；不会校验 base64 是否有效，也不深查 state 的 JSON 内容。
 */
function checkClassifierContext(context: unknown): ClassifierContext {
	// 错误工厂补同样的调用名和预期形状，直到遇到首个问题才真正抛出。
	const fail = (problem: string) =>
		new Error(`models.classify() ${problem}. Expected context: ${CLASSIFIER_CONTEXT_SHAPE}.`);
	// VM 入口是 unknown，必须实际检查对象以及 state，而不是仅用 TS 断言。
	if (!isRecord(context)) throw fail(`expects a context object as its second argument, got ${describeValue(context)}`);
	if (!isRecord(context.state)) throw fail(`context.state must be an object, got ${describeValue(context.state)}`);
	// 图片可省略；提供时逐个检查 type/data/mimeType 的基础形状。
	const { images } = context;
	if (images !== undefined) {
		if (!Array.isArray(images)) throw fail(`context.images must be an array, got ${describeValue(images)}`);
		// forEach 的 index 进入错误路径，方便定位具体图片。
		images.forEach((image: unknown, index) => {
			if (
				!isRecord(image) ||
				image.type !== "image" ||
				typeof image.data !== "string" ||
				typeof image.mimeType !== "string"
			) {
				throw fail(`context.images[${index}] must be an image block, got ${describeValue(image)}`);
			}
		});
	}
	// 至少要有一道题；Object.keys 检查自身可枚举键，不要求特定题号。
	const { questions } = context;
	if (!isRecord(questions) || Object.keys(questions).length === 0) {
		throw fail(`context.questions must map question IDs to questions, got ${describeValue(questions)}`);
	}
	// 局部谓词同时要求非空与每项为字符串；不是禁止空字符串。
	const isStrings = (values: unknown[]) => values.length > 0 && values.every((value) => typeof value === "string");
	for (const [id, question] of Object.entries(questions)) {
		// 路径字符串只为报错说明当前位置。
		const at = `context.questions.${id}`;
		// 每道题必须有字符串 instructions，再按 type 选择 criteria 的结构。
		if (!isRecord(question)) throw fail(`${at} must be a question object, got ${describeValue(question)}`);
		if (typeof question.instructions !== "string") throw fail(`${at}.instructions must be a string`);
		const { criteria } = question;
		if (question.type === "choice") {
			// choice 是标签→说明对象，全部说明须为字符串且至少一项。
			if (!isRecord(criteria) || !isStrings(Object.values(criteria))) {
				throw fail(`${at} is a "choice" question, so criteria must map each label to its meaning`);
			}
		} else if (question.type === "score") {
			// score 按数组顺序解释低到高；此处只查形状，不判断分级语义。
			if (!Array.isArray(criteria) || !isStrings(criteria)) {
				throw fail(`${at} is a "score" question, so criteria must list the levels as strings, lowest first`);
			}
		} else if (question.type === "bool") {
			// bool 需 true/false 两个字符串字段；额外字段未在此拒绝。
			if (!isRecord(criteria) || typeof criteria.true !== "string" || typeof criteria.false !== "string") {
				throw fail(`${at} is a "bool" question, so criteria must be { true: string, false: string }`);
			}
		} else {
			// 未知类型不能交给模型适配层猜测。
			throw fail(`${at}.type must be "choice", "score", or "bool", got ${JSON.stringify(question.type)}`);
		}
	}
	// 双重 as 只作静态类型转换；真实运行时检查就是前面列出的条件。
	return context as unknown as ClassifierContext;
}

/** Check a script's image context, so mistakes such as `{ prompt }` fail with the expected shape. */
/** 检查图片请求 input 是非空文本/图片块数组；返回原对象，非法块抛错。例 {prompt:"hi"} 会失败，须用 input。 */
function checkImagesContext(context: unknown): ImagesContext {
	// 用统一后缀展示正确输入方式，错误仍是普通 Error。
	const fail = (problem: string) =>
		new Error(
			`models.generateImages() ${problem}. Expected context: { input: [{ type: "text", text: <prompt> }, ...optional { type: "image", data: <base64>, mimeType } references] }.`,
		);
	if (!isRecord(context)) throw fail(`expects a context object as its second argument, got ${describeValue(context)}`);
	// 非空数组是这个 VM 接口的必要条件。
	const { input } = context;
	if (!Array.isArray(input) || input.length === 0) {
		throw fail(`context.input must be a non-empty array of blocks, got ${describeValue(input)}`);
	}
	// 两种分支只检查标签与字符串字段，不验证真实图片编码或 mime 是否受 provider 支持。
	input.forEach((block: unknown, index) => {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") return;
		if (
			isRecord(block) &&
			block.type === "image" &&
			typeof block.data === "string" &&
			typeof block.mimeType === "string"
		)
			return;
		// 两种合法形状都不匹配时，指出块的数组下标。
		throw fail(`context.input[${index}] must be a text or image block, got ${describeValue(block)}`);
	});
	// TS 不会从循环自动证明整个对象类型，故在已做检查后显式断言。
	return context as unknown as ImagesContext;
}

/**
 * Resolve the script's model by provider and id only, so a script-supplied baseUrl or headers never receive the
 * credentials, with errors that say what to do.
 */
function resolveModel<TType extends "classifier" | "image">(
	name: string,
	type: TType,
	model: unknown,
	models: Models,
): ModelTypeMap[TType] {
	// 泛型 TType 将传入类别与返回模型类型关联，不是运行时模型验证器。
	// 从脚本对象只采用 provider/id；真实 baseUrl、headers 均从宿主目录重新取。
	// 例伪造相同 id 的 baseUrl 不会被采用；未注册或类别错误均抛具体错误。
	const listHint = `List the ${type} models you can use with models.getAvailableOfType("${type}").`;
	// 这是跨 VM 的 model 参数信任边界，不能相信脚本声明的类型。
	if (!isRecord(model) || typeof model.provider !== "string" || typeof model.id !== "string") {
		// 常见错误是未命中目录拿到 undefined，给这类情况补查询提示。
		const undefinedHint =
			model === undefined || model === null
				? " models.getModelOfType() returns undefined for an unknown provider or id."
				: "";
		throw new Error(
			`${name}() expects ${withArticle(type)} model as its first argument, got ${describeValue(model)}.${undefinedHint} ${listHint}`,
		);
	}
	// 精确查当前要求的类别；找到后直接使用宿主注册。
	const { provider, id } = model;
	const resolved = models.getModelOfType(type, provider, id);
	if (resolved !== undefined) return resolved;
	// 没找到时查其他类别，只为区分“未知模型”与“类别错了”。
	const actualType = [...MODEL_TYPES].find(
		(other) => other !== type && models.getModelOfType(other as ModelType, provider, id) !== undefined,
	);
	throw new Error(
		actualType
			? `"${provider}/${id}" is ${withArticle(actualType)} model, not ${withArticle(type)} model. ${listHint}`
			: `Unknown ${type} model "${provider}/${id}". ${listHint}`,
	);
}

// 外层 schema 要求两个键存在，其内容仍为 unknown，交给上面更易懂的检查报错。
const ModelCallParameters = obj({ model: unknown(), context: unknown() }, { open: true });

/** The result of a model call as the tool returns it: the whole result for the script, usage counted by the Harness. */
function modelResult(
	label: string,
	result: { stopReason: string; errorMessage?: string; usage?: Usage },
	value: unknown,
) {
	// 输入 provider 结果、脚本要接收的值和显示标签，返回 Durable 工具结果；无模型调用。
	// stopReason 非 stop 时仍保留 structuredOutput，例如分类失败也能让脚本检查 stopReason。
	const ok = result.stopReason === "stop";
	// output 给界面看，structuredOutput 给脚本，usage 给 Harness 计费汇总。
	return {
		output: [
			{
				type: "text" as const,
				text: ok ? `${label} done` : `${label} ${result.stopReason}: ${result.errorMessage ?? ""}`,
			},
		],
		// JSON round-trip 得到可持久化数据，不能编码的值会直接抛错。
		structuredOutput: JSON.parse(JSON.stringify(value)) as JsonValue,
		// 条件对象展开仅在失败或有 usage 时添加相应字段。
		...(ok ? {} : { isError: true }),
		...(result.usage === undefined ? {} : { usage: result.usage }),
	};
}

/** The internal tools behind `models.classify()` and `models.generateImages()`. */
/** 创建两个内部工具注册；构造时无付费请求。执行时校验脚本参数、取宿主模型、异步调用并返回含 usage 的结果。
 * 例如 models.classify 全局调用最终会走第一个工具，作为有持久化身份的嵌套任务；异常由工具任务转成失败。
 */
export function createModelTools(): ToolRegistration[] {
	// callers:["tools"] 表示只能被工具间调用，不直接向模型展示这两个内部名字。
	const classify = defineTool({
		name: CLASSIFY_TOOL,
		description: "models.classify() of code mode scripts.",
		parameters: ModelCallParameters,
		structuredOutputSchema: unknown(),
		callers: ["tools"],
		execute: async (args, api, context) => {
			// 先重取可信模型与检查分类上下文，再开始实际模型请求。
			const model = resolveModel("models.classify", "classifier", args.model, api.models);
			const checked = checkClassifierContext(args.context);
			const result = await api.models.classify(model, checked, {
				// 继承当前任务追踪和取消信号；取消能否及时停止由 provider 实现决定。
				telemetry: context.telemetry,
				...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
			});
			// 完整模型结果既是工具 structuredOutput，也是脚本拿到的值。
			return modelResult(`classify ${model.provider}/${model.id}`, result, result);
		},
	});
	// 图片工具沿用同样的持久化/计费通路，但使用图片专用输入检查。
	const generateImages = defineTool({
		name: GENERATE_IMAGES_TOOL,
		description: "models.generateImages() of code mode scripts.",
		parameters: ModelCallParameters,
		structuredOutputSchema: unknown(),
		callers: ["tools"],
		execute: async (args, api, context) => {
			// 脚本自带的 headers/baseUrl 不会进入这里的实际模型对象。
			const model = resolveModel("models.generateImages", "image", args.model, api.models);
			const checked = checkImagesContext(args.context);
			const result = await api.models.generateImages(model, checked, {
				telemetry: context.telemetry,
				...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
			});
			return modelResult(`generateImages ${model.provider}/${model.id}`, result, result);
		},
	});
	// 返回异构工具列表；双重断言抹去各自 schema 泛型，未做运行时转换。
	return [classify as unknown as ToolRegistration, generateImages as unknown as ToolRegistration];
}
