// OpenAI Decisions分类适配：结构化问题/状态和图片转wire请求，按问题名解析答案，统一记录用量及失败结果。
// 只导入公共分类契约，运行时不创建OpenAI SDK客户端。
import type {
	// 公共choice/score/bool答案联合。
	ClassifierAnswer,
	// 请求state/questions/可选图片上下文。
	ClassifierContext,
	// 统一分类函数签名。
	ClassifierFunction,
	// 共用HTTP/认证/钩子及可选温度配置。
	ClassifierOptions,
	// 三种问题的可分辨联合。
	ClassifierQuestion,
	// 成功或失败分类结果形状。
	ClassifierResult,
} from "../types.ts";
// 未知异常规范化与格式化，不保证自动脱敏。
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
// 以下共享层处理HTTP信任边界、用量与字段验证。
import {
	// 带status/headers/body的Error扩展类型，type在编译后擦除。
	type ClassifierHttpError,
	// 只检查非null非数组object的基本形状。
	isRecord,
	// 从远端token字段生成统一用量及目录费用，不取实时账单。
	parseClassifierUsage,
	// POST共用实现要求显式key、按次超时和重试，最后成功JSON才通知onResponse。
	postClassifierRequest,
	// 验证字段为有限number，不自动限制概率0..1或总和。
	requiredNumber,
} from "./classifier-shared.ts";

/**
 * OpenAI's Decisions API: `POST /v1/decisions` with `{ model, input, questions }`.
 * https://developers.openai.com/api/docs/guides/decisions
 *
 * The state is sent as JSON text. With images, the input becomes one user message with the state
 * as `input_text` followed by `input_image` data URLs. Questions map to Decisions types:
 * `choice` to `choice`, `score` to `score`, and `bool` to `predicate`. Predicates have no
 * criteria field, so the meanings of true and false are appended to the instructions.
 *
 * Only OpenAI API keys work: Sign in with ChatGPT tokens are rejected on this route.
 */

// 服务显示名进入错误说明，不代替认证。
const LABEL = "OpenAI Decisions";

/** The endpoint accepts at most this many image parts per request. */
// 本地图片数上限128，请求构建时真实检查，不验证图片编码本身。
const MAX_IMAGES = 128;

// Decisions wire问题类型，interface只用于编译期。
interface DecisionQuestion {
	// wire布尔标签为predicate，不是公共bool。
	type: "predicate" | "choice" | "score";
	// name用于把返回答案与问题id配对。
	name: string;
	// 给模型的判断要求。
	instructions: string;
	// choice可选数组，值是候选键，说明可省；Array<T>等价T[]。
	choices?: Array<{ value: string; description?: string }>;
	// score可选有序级别数组，每项保存label，不是本地打分函数。
	levels?: Array<{ label: string }>;
}

/**
 * 把bool的true/false判据附到判断要求，输入已静态收窄的bool问题，返回新文字，无网络/原对象修改。
 * 例instructions=批准吗、true=已批准会附True means说明；空判据省略，纯空白仍真值保留，不自动转义/验证提示语义。
 */
// Extract从问题联合中静态挑type:bool，调用时无需重复检查整个shape。
function predicateInstructions(question: Extract<ClassifierQuestion, { type: "bool" }>): string {
	// 收集true/false有真值判据时的文字解释。
	const meanings = [
		// true判据非空则拼说明，空串省略；提示模板内容原样保留。
		question.criteria.true ? `True means: ${question.criteria.true}` : "",
		// false判据按同样规则处理。
		question.criteria.false ? `False means: ${question.criteria.false}` : "",
		// filter(Boolean)去空串，不trim判据空白。
	].filter(Boolean);
	// 有说明才以空行追加，否则直接返回原instructions，不改问题对象。
	return meanings.length > 0 ? `${question.instructions}\n\n${meanings.join("\n")}` : question.instructions;
}

/**
 * 公共问题转Decisions wire对象，输入问题名与联合问题，返回新对象/数组，无网络。
 * choice字典→choices数组，score描述→levels，bool→predicate并把判据附instructions；例空choice说明只发送value，不在此检查问题选项数量。
 */
// 把一个公共问题转wire形状，返回新对象，不发网络。
function wireQuestion(name: string, question: ClassifierQuestion): DecisionQuestion {
	// type判断让TS把criteria收窄为choice字典。
	if (question.type === "choice") {
		// 创建choice wire对象。
		return {
			// wire标签choice。
			type: "choice",
			// 问题id属性简写，保留原名。
			name,
			// 判断要求原字符串。
			instructions: question.instructions,
			// Object.entries按候选枚举顺序map到choices，回调解构value/description。
			choices: Object.entries(question.criteria).map(([value, description]) =>
				/**
				 * map回调把一个候选的value/description映成wire对象，返回新对象；例空description省字段，候选名原样保留，不改原criteria。
				 */
				// 说明真值才附description，空说明仅带value；不在此验证候选数量。
				description ? { value, description } : { value },
			),
		};
	}
	// score分支criteria已收窄为数组。
	if (question.type === "score") {
		// 新建wire score对象。
		return {
			// 标签score。
			type: "score",
			// 保留问题名。
			name,
			// 保留判断要求。
			instructions: question.instructions,
			/**
			 * map回调把评分级别文字包成{label}，返回新对象，保留数组顺序；不自行把label解析为数值。
			 */
			// map回调把每个评分描述包成{label}，保持原序，不查至少两个级别。
			levels: question.criteria.map((label) => ({ label })),
		};
	}
	// 剩余合法bool转predicate，true/false含义改写进instructions而非criteria字段。
	return { type: "predicate", name, instructions: predicateInstructions(question) };
}

/**
 * 构造Decisions input，输入结构化state与可选图片，输出JSON文字或user消息数组，无网络/输入修改。
 * 例无图直接'{"ok":true}'，有图先input_text再input_image数据URL；本地最多128张，不解码MIME/base64、不在这个原生入口检查模型image能力，Models外层另有能力检查。
 */
// 构造Decisions input，返回JSON文字或单条user消息数组，不改context。
function wireInput(context: ClassifierContext): unknown {
	// state先序列化为紧凑JSON；坏循环/BigInt等不合约输入可抛，不本地总结状态。
	const state = JSON.stringify(context.state);
	// 缺图片按空数组，未复制已有图片数组。
	const images = context.images ?? [];
	// 没图直接用JSON文字，不包聊天message。
	if (images.length === 0) return state;
	// 超128张在发HTTP前拒绝。
	if (images.length > MAX_IMAGES) {
		// 错误写本地上限与实际数，不猜测图片内容。
		throw new Error(`${LABEL} accepts at most ${MAX_IMAGES} images, got ${images.length}`);
	}
	// 有图返回只含一条user的数组。
	return [
		{
			// 角色user，输入形状不是本库完整聊天历史。
			role: "user",
			// 内容先state文字，再所有图片。
			content: [
				// input_text正文是上面JSON字符串。
				{ type: "input_text", text: state },
				/**
				 * map回调把一张Pi图片包成input_image和data URL，返回新对象，无图片解码/格式验证；例PNG仍复用原base64文字。
				 */
				// map回调逐图构造wire对象，...将所得块展开进content。
				...images.map((image) => ({
					// wire图片标签input_image。
					type: "input_image",
					// 原MIME/base64拼data URL，不解码/验证图像、不在此查model.input能力。
					image_url: `data:${image.mimeType};base64,${image.data}`,
				})),
			],
		},
	];
}

/**
 * 把未知choice概率数组变成候选→数字字典，验证每项value为string及probability有限，返回新对象，错误向上抛。
 * 例两个同value条目后项胜出，空数组可成{}；不查0..1、和为1、候选集合，Object.fromEntries保留特殊键为数据属性。
 */
// 解析choice概率列表为字典，失败抛错，无原响应修改。
function choiceProbabilities(value: unknown, id: string): Record<string, number> {
	// wire必须数组，不接受System One的概率对象形状。
	if (!Array.isArray(value)) throw new Error(`${LABEL} returned invalid probabilities for ${id}`);
	// fromEntries生成普通对象，特殊__proto__键也作为数据属性。
	return Object.fromEntries(
		/**
		 * map回调校验一条未知概率记录并产[value,probability]二元组，无输入修改；例非字符串value或非有限数字拒绝，不要求概率为正。
		 */
		// map逐个验证未知概率条目。
		value.map((entry) => {
			// 每项须基本对象且value为字符串，空串仍接受。
			if (!isRecord(entry) || typeof entry.value !== "string") {
				// 不合形状立即失败整项答案，不用默认概率补齐。
				throw new Error(`${LABEL} returned invalid probabilities for ${id}`);
			}
			// 数字只查有限性，重复value后项覆盖前项，不确认键在criteria中或概率和为1。
			return [entry.value, requiredNumber(LABEL, entry.probability, `probability for ${id}.${entry.value}`)];
		}),
	);
}

/**
 * 按请求问题种类映射一项答案，输入id/问题/基本对象，返回choice、score或bool公共结构，无输入修改。
 * 先拒绝refusal，再检查wire标签与必要字段；例predicate probability=0.8返回bool概率，不变成boolean。数值只查有限性，不验证概率/评分范围或choice一定在criteria内，错误抛给整批处理。
 */
// 按请求问题type验证并映射一项wire答案，返回公共答案，不修改请求。
function parseAnswer(id: string, question: ClassifierQuestion, answer: Record<string, unknown>): ClassifierAnswer {
	// refusal优先于任何类型分支，任一问题拒答会使整批结果失败。
	if (answer.type === "refusal") throw new Error(`${LABEL} refused to answer ${id}`);
	// choice问题要求对应wire choice形状。
	if (question.type === "choice") {
		// 必须标签choice和字符串choice，不验证它一定在请求候选中。
		if (answer.type !== "choice" || typeof answer.choice !== "string") {
			// 不合形状抛该问题错误。
			throw new Error(`${LABEL} did not return a choice answer for ${id}`);
		}
		// 新建公共choice答案。
		return {
			// 标签choice。
			type: "choice",
			// 选中值原样保留。
			choice: answer.choice,
			// wire概率数组转字典，未额外查候选集合完整性。
			probabilities: choiceProbabilities(answer.probabilities, id),
			// confidence也只要求有限number，不限制0..1。
			confidence: requiredNumber(LABEL, answer.confidence, `confidence for ${id}`),
		};
	}
	// score问题走对应分支。
	if (question.type === "score") {
		// wire标签必须score。
		if (answer.type !== "score") throw new Error(`${LABEL} did not return a score answer for ${id}`);
		// 新建公共评分答案。
		return {
			// 标签score。
			type: "score",
			// score只查有限性，允许小数，不在此限制criteria对应范围。
			score: requiredNumber(LABEL, answer.score, `score for ${id}`),
			// confidence同样只查有限性。
			confidence: requiredNumber(LABEL, answer.confidence, `confidence for ${id}`),
		};
	}
	// 剩余bool问题要求wire predicate，不接受其他标签。
	if (answer.type !== "predicate") throw new Error(`${LABEL} did not return a predicate answer for ${id}`);
	// predicate probability映回公共bool概率，不按阈值强行变true/false。
	return { type: "bool", probability: requiredNumber(LABEL, answer.probability, `probability for ${id}`) };
}

/**
 * 按name关联远端数组与请求questions，返回只含所问问题的新答案字典，无网络/原响应修改。
 * 先Map登记有效name项（重复后项覆盖），再按请求顺序解析；例远端顺序反过来也能匹配，缺任一答案抛错，额外答案忽略，不交付半批答案。
 */
// 按问题名解析整批答案，返回新字典，缺任一问题就抛。
function parseAnswers(value: unknown, context: ClassifierContext): Record<string, ClassifierAnswer> {
	// 答案根必须数组，不接受System One字典结构。
	if (!Array.isArray(value)) throw new Error(`${LABEL} returned an unexpected response`);
	// Map以name索引远端对象，原顺序可与问题顺序不同。
	const byName = new Map<string, Record<string, unknown>>();
	// 逐个读取远端数组项。
	for (const answer of value) {
		// 只登记基本对象且name字符串的项，重复name后项胜出，其他项忽略；不在此验证完整答案内容。
		if (isRecord(answer) && typeof answer.name === "string") byName.set(answer.name, answer);
	}
	// 根据本次问题生成答案字典，额外远端答案不返回。
	return Object.fromEntries(
		/**
		 * map回调为一个请求问题按id查远端name，再验证其答案，返回二元组；缺失或拒答抛错，fromEntries尚未返回最终对象。
		 */
		// map回调解构请求id/问题，逐项找远端对象。
		Object.entries(context.questions).map(([id, question]) => {
			// 按name查答案，不按数组位置猜测。
			const answer = byName.get(id);
			// 缺该问题答案直接失败，不保留已解析的一部分作为成功批次。
			if (!answer) throw new Error(`${LABEL} did not return an answer for ${id}`);
			// 返回二元组供fromEntries，特殊问题名保留为自有数据键。
			return [id, parseAnswer(id, question, answer)];
		}),
	);
}

/**
 * Cloudflare in front of api.openai.com answers 504 with an HTML page when a request runs longer
 * than about five seconds. Large inputs, currently above roughly 600K tokens, hit this limit, and
 * retrying the same input runs into it again, so 504 is not retried.
 */
// 将504排除共享重试，即使服务器x-should-retry=true也由排除规则终止，不对输入token量作本地检测。
const NO_RETRY_STATUSES = [504];

/**
 * 从异常生成本入口错误文案，输入unknown，返回string，无网络/原异常修改。
 * status===504时固定提示网关超时，其余共用规范化；例504 HTML不作为主要说明。as不校验非null，直接读取status可能因钩子抛null/undefined而再次失败，不保证所有抛出值都能格式化。
 */
// 把未知错误转本入口文案，返回string；格式化本身若抛没有本函数的catch。
function errorMessage(error: unknown): string {
	// as只允许读status，未验证error非null，外部钩子抛null/undefined时此属性访问本身仍可抛。
	if ((error as Partial<ClassifierHttpError>).status === 504) {
		// 504用固定网关提示，原英语是当前解释，不是在本地测得请求确已超约600K token。
		return `${LABEL} error (504): the request timed out at the gateway. Very large inputs (above roughly 600K tokens) currently exceed its time limit.`;
	}
	// 其他错误走通用格式化，保留可用HTTP正文/状态信息，不统一抹成网关超时。
	return formatProviderError(normalizeProviderError(error), `${LABEL} error`);
}

/** Classification through OpenAI's Decisions API. */
/**
 * 通过Decisions请求结构化分类，输入模型、state/questions/可选图片与HTTP选项，返回ClassifierResult Promise。
 * 先校验API并转换请求，共享HTTP显式Bearer key/钩子/超时/重试（504排除），成功后先保存可解析用量再按name解析全部答案；例某问题拒答时answers={}、stopReason=error，但usage保留。
 * 会联网和调用钩子；温度字段未自动发送，直接入口不解析环境认证，也不本地验证ChatGPT token是否可用。主try错误通常转结果，错误格式化再次抛仍会让Promise拒绝；用户总signal已取消才分类aborted。
 */
// async分类函数返回Promise，失败通常放结果中；泛型静态约束ClassifierOptions。
export const classify: ClassifierFunction<ClassifierOptions> = async (model, context, options) => {
	// 创建本轮结果，不是Pi聊天事件流。
	const output: ClassifierResult = {
		// 保留模型API标识。
		api: model.api,
		// 保留请求provider身份。
		provider: model.provider,
		// 保留模型id，不自动改用响应model字段。
		model: model.id,
		// 答案初始空，整批解析成功才赋值。
		answers: {},
		// 初始stop，catch改error/aborted，不因为Promise正常结算就证明成功。
		stopReason: "stop",
		// 本地开始毫秒时间。
		timestamp: Date.now(),
	};

	// 构建/HTTP/业务解析主try，前面的output初始化不在其中。
	try {
		// API必须精确openai-decisions，错误交下面结果路径。
		if (model.api !== "openai-decisions") throw new Error(`Unsupported classifier API: ${model.api}`);
		// 发送一次逻辑分类HTTP；共享层内部可按策略重试。
		const body = await postClassifierRequest(
			// 服务名称供错误说明使用。
			LABEL,
			// 去真实末尾斜线再以URL解析追加decisions，通常保留/v1路径，坏URL可抛。
			new URL("decisions", `${model.baseUrl.replace(/\/+$/u, "")}/`),
			// 模型给认证头、钩子和目录用量计价使用。
			model,
			{
				// 请求模型id。
				model: model.id,
				// 状态/图片转wire input，不是整个ClassifierContext照搬。
				input: wireInput(context),
				/**
				 * map回调把请求问题的[id,question]转Decisions wire项，保留问题名以便响应重排后配对，不修改原问题。
				 */
				// map回调逐问题保留id并转换wire问题；不发送公共temperature字段。
				questions: Object.entries(context.questions).map(([id, question]) => wireQuestion(id, question)),
			},
			// HTTP选项包括显式key、fetch、头、信号与钩子，不自行查环境key。
			options,
			// 504禁重试清单交共享层，其他错误仍按形状/预算/响应头规则判断。
			NO_RETRY_STATUSES,
		);
		// HTTP成功JSON仍需基本对象，不把任意2xx JSON当有效分类。
		if (!isRecord(body)) throw new Error(`${LABEL} returned an unexpected response`);
		// Set before parsing answers: a request with malformed or refused answers was still billed.
		// 先保存可解析用量，之后拒答/坏答案也可能已经产生费用。
		const usage = parseClassifierUsage(body.usage, model);
		// 有用量才写可选字段，不因缺usage拒绝有效答案。
		if (usage) output.usage = usage;
		// 全部问题解析成功才赋answers；右侧抛错时赋值不完成。
		output.answers = parseAnswers(body.answers, context);
		// 返回结果对象，未发额外模型请求。
		return output;
		// 捕获配置、HTTP、拒答和答案解析失败，不回滚已保存usage。
	} catch (error) {
		// 丢弃部分答案，不返回半批选择。
		output.answers = {};
		// 只看用户总signal分类aborted，单次超时通常error。
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		// 计算可读说明；该函数自身若抛，当前catch没有第二层保护，Promise仍可能拒绝。
		output.errorMessage = errorMessage(error);
		// 返回错误结果，调用者仍需检查stopReason。
		return output;
	}
};
