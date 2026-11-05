// System One分类协议共用流程：把公共问题/图片转请求格式，经transport封装发送，再校验并映射答案；TypeSafe和Cloudflare共用。
// type导入本文件开发期协议/结果形状，编译后擦除。
import type {
	// 公共三种答案联合。
	ClassifierAnswer,
	// 分类API协议标识。
	ClassifierApi,
	// 输入state/图片/questions结构。
	ClassifierContext,
	// 分类模型元数据，非聊天Model。
	ClassifierModel,
	// HTTP认证/取消/回调等请求选项。
	ClassifierOptions,
	// 返回成功或错误的统一结果结构。
	ClassifierResult,
	// base64图片内容块类型。
	ImageContent,
	// 模型System One兼容字段。
	SystemOneCompat,
} from "../types.ts";
// 把未知错误规范化并转可读文字，不在这里重新抛业务错误。
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
// 共用HTTP/用量解析及未知JSON对象/有限数校验。
import { isRecord, parseClassifierUsage, postClassifierRequest, requiredNumber } from "./classifier-shared.ts";

/** A System One image asset: base64 file bytes, referenced by its name from the state. */
// assets模式中的单张图片数据形状，不是宿主文件路径。
interface SystemOneImageAsset {
	// 固定image分辨字段。
	type: "image";
	// assets协议此处仅支持png/jpeg。
	format: "png" | "jpeg";
	// 直接保存base64文字，不在类型层验证图片数据。
	data_base64: string;
}

/** An image in the state, OpenRouter's form. */
// state-image-urls模式用的图片内容块。
interface SystemOneImageUrlPart {
	// 固定image_url标签。
	type: "image_url";
	// 嵌套url字段保存完整data URL。
	image_url: { url: string };
}

/** TypeSafe System One request body without the transport-specific envelope. */
// 只描述System One正文，transport还可加model/input等外壳。
export interface SystemOneWireRequest {
	/** The context state, or with images a list of the images or their asset names followed by the state. */
	// state可为原对象或图片前缀加原state数组，所以声明unknown。
	state: unknown;
	// 按问题id索引wire问题，字段细节交具体转换。
	questions: Record<string, unknown>;
	/** Images as System One assets, keyed by the names the state references. */
	// 可选assets字典，以state引用的名字为键。
	assets?: Record<string, SystemOneImageAsset>;
	/** Images as data URLs, Clef's extension to System One. */
	// 可选data URL列表，区别assets模式。
	images?: string[];
}

/**
 * How a service takes images (`SystemOneCompat.imageInput`):
 * - `assets`: TypeSafe's `assets` map, `{ "<image-1>": { type: "image", format, data_base64 } }`,
 *   with the names placed before the state: `state: ["<image-1>", state]`. PNG and JPEG only.
 * - `images`: Clef's `images` list of data URLs, which the model reads before the state.
 *   PNG, JPEG, and WebP, at most four.
 * - `state-image-urls`: OpenRouter's form, data URL parts placed before the state:
 *   `state: [{ type: "image_url", image_url: { url } }, state]`. OpenRouter accepts this for every
 *   model, and drops `assets` silently.
 */
// 索引访问取compat字段类型，NonNullable在编译期去null/undefined，不填运行时默认。
export type SystemOneImageInput = NonNullable<SystemOneCompat["imageInput"]>;

/** System One compatibility settings with every field resolved. */
// Required把所有兼容字段变为必需，仅是类型要求；detectCompat负责实际给值。
export type ResolvedSystemOneCompat = Required<SystemOneCompat>;

/** TypeSafe's opt-in header for its experimental image input. */
// 图片实验功能请求头值为字符串true，不是布尔值。
const IMAGE_OPT_IN_HEADERS = { "TypeSafe-Danger-Zone-Images": "true" };

/** Differences between services that serve System One models. */
// transport是不同服务提供的操作集合，不在本接口里实现网络。
export interface SystemOneTransport {
	/** Classifier API implemented by this transport. */
	// 本transport允许的分类API标识。
	api: ClassifierApi;
	/** Service name used in error messages. */
	// 错误说明用的服务名称。
	label: string;
	/** Compatibility settings for models that do not set them in `compat`. */
	// 调用方根据模型推导必填兼容值，模型compat之后仍可逐字段覆盖。
	detectCompat(model: ClassifierModel<ClassifierApi>): ResolvedSystemOneCompat;
	/** Absolute request URL. */
	// 根据模型返回绝对请求URL，可抛配置错误。
	url(model: ClassifierModel<ClassifierApi>): URL;
	/** Wraps the System One request in the service's request envelope. */
	// 把内部正文包装为服务需要的外壳，结果仍unknown。
	payload(model: ClassifierModel<ClassifierApi>, request: SystemOneWireRequest): unknown;
	/** Extracts the System One output (`{ answers, usage }`) from the service's response envelope. */
	// 检查并剥服务响应外壳，返回含answers/usage的未知字段字典。
	output(body: unknown): Record<string, unknown>;
}

/**
 * 把未知概率对象逐字段验证为有限number，返回新字典，错误含服务/问题/候选id。
 * 例：{yes:0.8,no:0.2}保留；不限制0..1、不检查概率和为1、不确认键与问题criteria完全一致，空字典也可通过。
 */
function probabilities(label: string, value: unknown, id: string): Record<string, number> {
	// 远端概率必须先为非null非数组object。
	if (!isRecord(value)) throw new Error(`${label} returned invalid probabilities for ${id}`);
	// 二元组数组转新普通对象，不就地改远端对象。
	return Object.fromEntries(
		// 遍历远端所有概率字段，并解构候选名/未知数值。
		Object.entries(value).map(([key, probability]) => [
			// 保留候选键名，不限制criteria集合。
			key,
			// 只验证有限number，字段路径进入错误说明。
			requiredNumber(label, probability, `probability for ${id}.${key}`),
		]),
	);
}

/**
 * 按请求questions逐一读取和验证远端答案，返回公共ClassifierAnswer字典，不改context。
 * choice保留选择/概率/置信度，score保留数值/置信度，bool把wire noul映射probability；例：缺任一请求答案就抛错，远端额外答案不返回。
 * 只检查规定形状与有限数字，不校验choice属于criteria、score区间或概率归一化；先累积二元组再fromEntries，使__proto__等id也是自有数据属性。
 */
function parseAnswers(label: string, value: unknown, context: ClassifierContext): Record<string, ClassifierAnswer> {
	// 答案总容器也要求为非null非数组object。
	if (!isRecord(value)) throw new Error(`${label} returned an unexpected response`);
	// Array<[string,ClassifierAnswer]>声明键值二元组列表，避免用动态键赋值造成特殊原型键含义。
	const answers: Array<[string, ClassifierAnswer]> = [];
	// 只按本次问题列表和顺序解析，不枚举远端额外答案。
	for (const [id, question] of Object.entries(context.questions)) {
		// 按问题id读取原始远端答案。
		const answer = value[id];
		// 缺答案或非对象立即拒绝，不生成默认选择。
		if (!isRecord(answer)) throw new Error(`${label} did not return an answer for ${id}`);
		// 问题type收窄为choice，决定预期答案形状。
		if (question.type === "choice") {
			// 远端答案必须choice标签及字符串choice，空字符串未额外排除。
			if (answer.type !== "choice" || typeof answer.choice !== "string") {
				// 不合形状即抛该问题错误。
				throw new Error(`${label} did not return a choice answer for ${id}`);
			}
			// 把完整choice答案加入临时键值对列表。
			answers.push([
				// 使用原请求问题id。
				id,
				// 建立公共choice答案对象。
				{
					// 公共分辨字段为choice。
					type: "choice",
					// 保留服务选择文字，不查它是否是criteria中的一个键。
					choice: answer.choice,
					// 概率字典逐项查有限数，不验证和/范围。
					probabilities: probabilities(label, answer.probabilities, id),
					// confidence也只查有限数，不限制0..1。
					confidence: requiredNumber(label, answer.confidence, `confidence for ${id}`),
				},
			]);
			// 第二类公共问题为score。
		} else if (question.type === "score") {
			// 远端标签必须同为score。
			if (answer.type !== "score") throw new Error(`${label} did not return a score answer for ${id}`);
			// 加入评分答案键值对。
			answers.push([
				// 保留请求问题id。
				id,
				// 创建公共score结构。
				{
					// 标签为score。
					type: "score",
					// 评分必须有限number，不校验criteria长度对应的区间。
					score: requiredNumber(label, answer.score, `score for ${id}`),
					// 置信度必须有限number。
					confidence: requiredNumber(label, answer.confidence, `confidence for ${id}`),
				},
			]);
			// 问题联合的剩余合法分支为bool。
		} else {
			// wire协议bool用noul标签，不直接接受bool标签。
			if (answer.type !== "noul") throw new Error(`${label} did not return a bool answer for ${id}`);
			// 加入公共布尔概率答案。
			answers.push([
				// 保留问题id。
				id,
				// 创建公共结构而非原样透传wire对象。
				{
					// 公共标签恢复bool。
					type: "bool",
					// wire noul数值映射为probability，只查有限性。
					probability: requiredNumber(label, answer.noul, `probability for ${id}`),
				},
			]);
		}
	}
	// 全部问题都解析成功才返回对象，fromEntries保留特殊id为数据键。
	return Object.fromEntries(answers);
}

// MIME到assets format的查表；索引访问类型保持format只有png/jpeg。
const ASSET_FORMATS: Record<string, SystemOneImageAsset["format"]> = { "image/png": "png", "image/jpeg": "jpeg" };
// images模式允许三种MIME，Set用于精确匹配。
const DATA_URL_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** Clef accepts at most this many images per request. */
// images模式数量上限4，其他两种模式本函数未用此上限。
const MAX_DATA_URL_IMAGES = 4;

/** Adds the context images to `request` in the service's form. */
/**
 * 按选定图片输入方式就地填request，不返回值、不读取图片字节或发请求。
 * images模式最多4张且用Set检查PNG/JPEG/WebP；state-image-urls把data URL块前置到state且此处不查格式/数量；其余assets按预设PNG/JPEG映射查格式，并把名称前置到state。
 * 例：两张assets生成<image-1>/<image-2>并引用它们；这些是本次新request的修改，原context.state对象不就地展开或深复制。assets查普通对象后仅判真值，不应把这一步概括为任意字符串MIME的完整白名单验证。
 */
function addImages(
	// 显示在错误里的服务名。
	label: string,
	// 模型id用于诊断，能力检查在上层。
	model: ClassifierModel<ClassifierApi>,
	// 已决定的三种图片传输方式之一。
	input: SystemOneImageInput,
	// 输入图片块，base64文字原样使用。
	images: ImageContent[],
	// 将被就地补字段/替state的新请求对象。
	request: SystemOneWireRequest,
	// void表示仅修改request，无业务返回值。
): void {
	// Clef风格data URL列表分支。
	if (input === "images") {
		// 此模式超过4张即在发HTTP前失败。
		if (images.length > MAX_DATA_URL_IMAGES) {
			// 构造图片数量错误。
			throw new Error(
				// 错误附服务、模型、上限与实际数量。
				`${label} accepts at most ${MAX_DATA_URL_IMAGES} images for ${model.id}, got ${images.length}`,
			);
		}
		// 先把全部图片映成data URL；map抛错则该赋值不会完成。
		request.images = images.map((image) => {
			// 仅精确接受PNG/JPEG/WebP MIME，不转换图片格式。
			if (!DATA_URL_TYPES.has(image.mimeType)) {
				// 非法MIME抛错，不尝试自动转码。
				throw new Error(`${label} accepts PNG, JPEG, and WebP images for ${model.id}, got ${image.mimeType}`);
			}
			// 拼data URL，既不解码base64也不验证像素/内容匹配MIME。
			return `data:${image.mimeType};base64,${image.data}`;
		});
		// images模式完成，不继续创建state前缀/assets。
		return;
	}
	// OpenRouter的state内容块模式。
	if (input === "state-image-urls") {
		// OpenRouter validates the images against the model that serves the request.
		// 构造图片块数组，此分支未加数量/MIME过滤。
		const parts = images.map(
			// 回调返回类型声明SystemOneImageUrlPart，编译期检查字段。
			(image): SystemOneImageUrlPart => ({
				// 协议标签image_url。
				type: "image_url",
				// 原MIME/base64拼成data URL嵌套在url中。
				image_url: { url: `data:${image.mimeType};base64,${image.data}` },
			}),
		);
		// 新数组按图片块在前、原state作为最后一项；不是把原state内容展开。
		request.state = [...parts, request.state];
		// 此分支不再创建assets。
		return;
	}
	// 其余合法模式为assets，先建名字到图片对象的字典。
	const assets: Record<string, SystemOneImageAsset> = {};
	// forEach按索引给图片编号。
	images.forEach((image, index) => {
		// 用MIME查对应png/jpeg格式。
		const format = ASSET_FORMATS[image.mimeType];
		// 查表结果为假值就拒绝；普通对象索引未做自有键检查，Record类型也不会在运行时排除继承属性名。
		if (!format) throw new Error(`${label} accepts PNG and JPEG images for ${model.id}, got ${image.mimeType}`);
		// 从1编号的引用名，值为原base64及映射format。
		assets[`<image-${index + 1}>`] = { type: "image", format, data_base64: image.data };
	});
	// 把完整assets字典写入新request。
	request.assets = assets;
	// Every asset must be referenced from the request. The names go before the state, where Clef
	// also places its images.
	// state前面列出所有资产名，最后一项是原state，保证这些资产在正文中有引用。
	request.state = [...Object.keys(assets), request.state];
}

/** Maps public `bool` questions to TypeSafe's wire-level `noul` type. */
/**
 * 建立System One内部请求，返回新顶层对象/问题字典，公共bool改为wire noul。
 * 例：问题{type:"bool",...}变{type:"noul",...}，choice/score仍复用问题引用，state也复用原引用；不会复制完整context或发送HTTP。
 */
function wireRequest(context: ClassifierContext): SystemOneWireRequest {
	// 返回新内部请求，不修改context的顶层属性。
	return {
		// 原state对象引用复用，之后addImages仅替request.state。
		state: context.state,
		// 建立新问题字典。
		questions: Object.fromEntries(
			// 每个问题映射为[id,wireQuestion]二元组。
			Object.entries(context.questions).map(([id, question]) => [
				// 保留原问题id，包括__proto__等名字。
				id,
				// 只复制bool问题并改type为noul，其余问题复用原对象。
				question.type === "bool" ? { ...question, type: "noul" } : question,
			]),
		),
	};
}

/** Runs one System One classification over the given transport. */
/**
 * 通过指定transport完成一次System One分类，返回ClassifierResult Promise；try内失败转换为error/aborted结果。
 * 校验API与图片能力、按compat逐字段覆盖检测值、处理图片/opt-in头，封装HTTP请求，先保存可读usage再解析全部答案。
 * 例：返回答案缺字段时stopReason=error、answers={}，已解析usage仍保留；取消按原options.signal判断，单次超时通常是error。无真实分类之前不创建合成答案；transport/钩子错误也走同一结果路径。
 */
export async function classifySystemOne(
	// 服务差异接口，负责URL、外壳及输出提取。
	transport: SystemOneTransport,
	// 分类模型元数据，须与transport.api匹配。
	model: ClassifierModel<ClassifierApi>,
	// 本次结构化状态、问题和可选图片。
	context: ClassifierContext,
	// 可缺省选项；下层仍要求apiKey。
	options: ClassifierOptions | undefined,
	// 返回统一结果对象的Promise，业务错误一般放stopReason/errorMessage。
): Promise<ClassifierResult> {
	// 先建立返回对象，后续成功/失败都复用它。
	const output: ClassifierResult = {
		// 结果报告原模型协议。
		api: model.api,
		// 报告原供应商标识。
		provider: model.provider,
		// 报告目录模型id。
		model: model.id,
		// 答案先为空，只有整批解析成功才替换。
		answers: {},
		// 初始按stop成功，catch会改error/aborted。
		stopReason: "stop",
		// 记录本次流程开始时毫秒时间，不是响应完成时刻。
		timestamp: Date.now(),
	};

	// 捕获API/图片/transport/HTTP/业务解析等阶段异常。
	try {
		// 不匹配transport.api则发请求前拒绝。
		if (model.api !== transport.api) throw new Error(`Unsupported classifier API: ${model.api}`);
		// 转换bool为wire noul，得到本次新请求对象。
		const request = wireRequest(context);
		// 默认复用原options，只有补图片头时建副本。
		let requestOptions = options;
		// 只有非空图片列表才读取兼容配置/加图片头。
		if (context.images?.length) {
			// 模型input必须包含image，否则不发含图请求。
			if (!model.input.includes("image")) {
				// 错误附服务与模型id。
				throw new Error(`${transport.label} does not support image input for ${model.id}`);
			}
			// 先调用transport检测，明确compat也不会阻止这次detect执行。
			const detected = transport.detectCompat(model);
			// imageInput逐字段优先模型compat，缺省用检测值。
			const imageInput = model.compat?.imageInput ?? detected.imageInput;
			// 按所选方式就地更新本次request。
			addImages(transport.label, model, imageInput, context.images, request);
			// 是否加实验头也独立优先compat；??保留显式false。
			if (model.compat?.sendImageOptInHeader ?? detected.sendImageOptInHeader) {
				// 新建options/headers，实验头先写，本次options头可覆盖/用null抑制，随后共享helper再处理大小写。
				requestOptions = { ...options, headers: { ...IMAGE_OPT_IN_HEADERS, ...options?.headers } };
			}
		}
		// 把服务差异和本次正文交共用HTTP路径。
		const body = await postClassifierRequest(
			// 服务显示名供HTTP错误说明。
			transport.label,
			// 由transport生成真实URL，生成失败也被catch。
			transport.url(model),
			// 模型给请求头/钩子使用。
			model,
			// 先由transport加model/input等外壳，所得结构再交HTTP序列化。
			transport.payload(model, request),
			// 传可能含图片头的新选项。
			requestOptions,
		);
		// 从服务外壳取System One结果，字段仍待验证。
		const result = transport.output(body);
		// Set before parsing answers: a request with malformed answers was still billed.
		// 先解析usage以便后面坏答案仍保留已发生的费用记录。
		const usage = parseClassifierUsage(result.usage, model);
		// 有可解析usage才写入output，否则该可选字段缺省。
		if (usage) output.usage = usage;
		// 整批答案解析成功才赋值，失败时仍为空对象。
		output.answers = parseAnswers(transport.label, result.answers, context);
		// 返回成功结果，不额外发第二次分类。
		return output;
		// 失败转统一结果，不向外重新抛原错误。
	} catch (error) {
		// 只有原调用方总signal已取消标aborted，其他错误/单次超时标error。
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		// 按共用规范化/格式化算法生成文案，不在此保证脱敏。
		output.errorMessage = formatProviderError(normalizeProviderError(error), `${transport.label} error`);
		// 返回错误对象，之前已存usage仍可存在。
		return output;
	}
}
