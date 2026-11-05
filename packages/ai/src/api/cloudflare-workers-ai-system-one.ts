// Cloudflare Workers AI System One分类入口：包装run请求、识别Clef/Jev响应外壳，分类HTTP及答案处理复用共享层。
// 分类函数/配置仅类型导入，不引入Cloudflare SDK。
import type { ClassifierFunction, ClassifierOptions } from "../types.ts";
// 基本对象形状helper用来检查未知wire响应。
import { isRecord } from "./classifier-shared.ts";
// 共用System One流程与transport接口，避免本入口重复实现HTTP/图片/答案转换。
import { classifySystemOne, type SystemOneTransport } from "./system-one-shared.ts";

// 服务显示名用于错误信息，不是请求域名或认证标记。
const LABEL = "Cloudflare Workers AI";

/**
 * 从unknown errors提可用message，返回服务前缀文字，不修改原错误或发请求。
 * 数组元素仅需基本对象+string message，例[{message:"No such model"}]拼成服务错误；空字符串也保留，未提到项用通用request failed，不自动脱敏/裁剪。
 */
// 将未知Cloudflare errors列表提成可读文字，返回string，无网络/输入修改。
function cloudflareErrorMessage(errors: unknown): string {
	// 只在真实数组时逐项提说明，非数组走通用后备。
	if (Array.isArray(errors)) {
		// 构建可用错误文字数组，未限制总长度。
		const messages = errors
			/**
			 * map回调检查单个未知错误的基本对象形状及message类型，返回string或undefined；例message=0被忽略，空串仍保留，不修改原项。
			 */
			// map回调仅取基本对象中的string message，空串也保留，其他返回undefined。
			.map((error) => (isRecord(error) && typeof error.message === "string" ? error.message : undefined))
			/**
			 * filter回调只去undefined，返回类型谓词，TS于是得到string[]；例空串通过，运行时不会因为类型谓词自动增加其他校验。
			 */
			// filter类型谓词去undefined并让TS收窄string[]，不去空串、不trim。
			.filter((message): message is string => message !== undefined);
		// 至少一项就用分号连接；即使列表仅含空串也不会走通用后备。
		if (messages.length > 0) return `${LABEL} error: ${messages.join("; ")}`;
	}
	// 非数组或无string message时返回固定请求失败说明。
	return `${LABEL} request failed`;
}

/**
 * System One models on the Workers AI REST endpoint:
 * `POST /accounts/{account}/ai/run` with `{ model, input }`. The REST API wraps the model
 * output in Cloudflare's API envelope. Third-party models such as `typesafe/jev` add a run record:
 * `{ success, result: { state: "Completed", result: { answers, usage } } }`.
 * https://developers.cloudflare.com/ai/models/typesafe/jev/
 * Cloudflare-hosted models such as `@cf/cloudflare/clef` return the output directly:
 * `{ success, result: { model, answers, usage } }`.
 * https://developers.cloudflare.com/workers-ai/models/clef/
 *
 * Clef models take images as an `images` list of data URLs. TypeSafe's models take them as
 * System One `assets`, without TypeSafe's opt-in header. The catalog sets `compat.imageInput`;
 * the model ID check only covers models without it.
 */
// 服务差异对象只登记函数/配置，模块加载本身不发请求。
const transport: SystemOneTransport = {
	// 仅接受此API标识，实际检查在共享入口。
	api: "cloudflare-workers-ai-system-one",
	// 对象属性值复用服务显示名。
	label: LABEL,
	/**
	 * 从模型id前缀推导默认图片传输方式并默认关闭TypeSafe opt-in头，返回新compat，无网络。
	 * 例@cf/cloudflare/clef-flash走images，其余走assets；共享层仅有图片时调用，之后明确model.compat逐字段优先，不在这里验证id真实存在。
	 */
	// 检测默认图片兼容值，返回新对象，不修改模型。
	detectCompat: (model) => ({
		// 模型id精确以@cf/cloudflare/clef开头时选data URL images，其他选assets；它是前缀启发式，不探测服务能力。
		imageInput: model.id.startsWith("@cf/cloudflare/clef") ? "images" : "assets",
		// 默认不加TypeSafe实验头，但共享层允许model.compat逐字段覆盖为true。
		sendImageOptInHeader: false,
	}),
	/**
	 * 构造Cloudflare run的URL，无网络；例.../accounts/a/ai变.../accounts/a/ai/run。
	 * baseUrl中的账号占位符应由外层Cloudflare provider包装处理，这里只做URL拼接，坏URL可抛，query/hash自定义形式按标准解析。
	 */
	// 从baseUrl去末尾斜线后相对解析run，URL构造可抛；本函数不替换account/gateway占位符。
	url: (model) => new URL("run", `${model.baseUrl.replace(/\/+$/u, "")}/`),
	/**
	 * 将内部System One请求包为Cloudflare{model,input}对象，返回新顶层值，无输入修改；例questions位于input.questions而非请求顶层。
	 * input复用原request引用，不证明后端已经接收或开始任务。
	 */
	// Cloudflare外壳为{model,input:request}，request作为同一嵌套引用，不深复制。
	payload: (model, request) => ({ model: model.id, input: request }),
	/**
	 * 提取Cloudflare响应中的System One输出，接unknown，返回原结果字典，无网络/轮询。
	 * 先检查根对象、success===false和result对象；有answers键先当直接输出，否则要求run.state=Completed并取内层result。
	 * 例Queued直接失败，不自动等待；存在answers就先返回，答案内容是否有效仍由共享层校验，且此处不要求success字段必须true。
	 */
	// 回调从未知响应剥Cloudflare/任务两层外壳，返回字典或抛错，不轮询任务。
	output: (body) => {
		// 响应根必须基本对象，未检查每个Cloudflare公共字段。
		if (!isRecord(body)) throw new Error(`${LABEL} returned an unexpected response`);
		// 仅success精确false才在这里拒绝；缺失、0等不是该条件，并不要求success===true。
		if (body.success === false) throw new Error(cloudflareErrorMessage(body.errors));
		// 取第一层result，尚未判断它是直接输出还是任务记录。
		const result = body.result;
		// result也必须基本对象。
		if (!isRecord(result)) throw new Error(`${LABEL} returned an unexpected response`);
		// 只要存在answers键（含原型链）就直接返回，未在此验证answers内容，也先于state检查。
		if ("answers" in result) return result;
		// 否则把它当run记录，state必须精确Completed。
		if (result.state !== "Completed") {
			// 其他状态立刻抛，不自动等待Queued/Running或再次查询。
			throw new Error(`${LABEL} run did not complete (state: ${String(result.state)})`);
		}
		// 完成run的内层result仍需基本对象，答案内容留共享层解析。
		if (!isRecord(result.result)) throw new Error(`${LABEL} returned an unexpected response`);
		// 返回内层对象引用，无额外复制或计价；共享层再读usage/answers。
		return result.result;
	},
};

/** Cloudflare Workers AI System One classification with public `bool` values mapped to wire-level `noul`. */
/**
 * 通过Cloudflare Workers AI REST System One做结构化分类，输入分类模型/state/questions/选项，返回ClassifierResult Promise。
 * 共享层校验API与图片能力、bool转noul，transport包装{model,input}并剥直接/完成任务外壳；例Clef图片默认images，Jev默认assets，明确compat还能覆盖。
 * 会发HTTP/调用钩子，失败通常写error/aborted结果；本入口不解析账号占位符或登录，provider外层可处理账号env，直接HTTP层仍要求apiKey。
 */
// 分类函数泛型约束签名，表达式直接返回共享层Promise。
export const classify: ClassifierFunction<ClassifierOptions> = (model, context, options) =>
	// 用此transport委托共享分类，bool/noul映射、图像限制、HTTP与失败结果由共享层执行。
	classifySystemOne(transport, model, context, options);
