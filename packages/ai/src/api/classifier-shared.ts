// 分类API共用HTTP与JSON边界：合并认证头、运行钩子、按尝试设超时及重试，并把可用token用量换算为目录费用。
// 费用计算helper会就地填usage.cost，按模型目录单价而非供应商账单查询。
import { calculateCost } from "../models.ts";
// 仅导入分类模型、选项、请求头和用量契约。
import type { ClassifierApi, ClassifierModel, ClassifierOptions, ProviderHeaders, Usage } from "../types.ts";
// 响应Headers转对象，以及支持null删除的请求头合并。
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
// ClientIdentity为类型，getIdentityHeaders生成默认User-Agent/归因头。
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
// 共用供应商请求重试策略，区分于Agent整轮回答重试。
import { retryProviderRequest } from "../utils/provider-retry.ts";

/** An HTTP failure in the shape `retryProviderRequest` and `normalizeProviderError` understand. */
// 接口扩展标准Error形状，额外字段由下面构造器实际赋值。
export interface ClassifierHttpError extends Error {
	// HTTP状态可缺省，连接/超时错误没有响应状态。
	status: number | undefined;
	// 响应Headers可缺省，服务端重试头由此读取。
	headers: Headers | undefined;
	// 保留已读取的原错误正文。
	body: string;
}

/**
 * 构造兼容共享重试/错误规范化的HTTP Error，返回对象而不throw。
 * 输入服务显示名、Response及已读取正文；例：429会附status/headers供重试器判断，body保留诊断文字；只改新Error，不改变Response。
 */
function httpError(label: string, response: Response, body: string): ClassifierHttpError {
	// 先建普通Error再断言扩展类型；as不实际添加字段。
	const error = new Error(`${label} returned ${response.status}`) as ClassifierHttpError;
	// 实际写入HTTP状态。
	error.status = response.status;
	// 保留Response.headers引用供重试解析。
	error.headers = response.headers;
	// 写入调用方已读取的正文。
	error.body = body;
	// 返回Error，调用方决定throw。
	return error;
}

/**
 * 创建超时Error并补齐分类HTTP错误字段，返回对象，无网络。
 * 例：name=TimeoutError、status/headers=undefined符合重试器的连接类形状，是否重试仍由外层次数/取消规则决定。
 */
function timeoutError(timeoutMs: number): ClassifierHttpError {
	// 构造带时长的可读超时说明。
	const error = new Error(`Request timed out after ${timeoutMs}ms`) as ClassifierHttpError;
	// 按约定设置name，错误规范化可据此区分超时。
	error.name = "TimeoutError";
	// 没有真实HTTP状态，但显式建立status字段以满足重试器形状。
	error.status = undefined;
	// 同样显式建立headers字段。
	error.headers = undefined;
	// 无响应正文用空串。
	error.body = "";
	// 返回对象，不在本helper内抛出。
	return error;
}

/**
 * 对unknown进行非null非数组object检查，返回类型谓词结果，无副作用。
 * 例：{}通过，[]/null不通过；只检查容器形状，不验证对象每个字段或原型。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	// typeof/非null/非数组检查用于未知JSON边界，value is告知TS成功分支可按字典访问。
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 验证未知响应字段为有限number，返回该值，失败抛带label/field的Error。
 * 例：0、负数、1.5均接受，NaN/Infinity/字符串拒绝；用于概率/置信度时也不会额外限制0..1。
 */
export function requiredNumber(label: string, value: unknown, field: string): number {
	// 只验证number和有限性，不验证取值范围或整数。
	if (typeof value !== "number" || !Number.isFinite(value)) {
		// 异常指出远端label和字段名，不附整个正文。
		throw new Error(`${label} returned an invalid ${field}`);
	}
	// 条件后value收窄为number，原样返回。
	return value;
}

/**
 * 按身份头→默认Bearer/JSON→模型头→本次头合并，返回新字符串字典，无发送。
 * 同名忽略大小写，后值覆盖，null删除；例：本次Authorization:null可删除默认Bearer。这里不验证认证凭证，空结果用{}。
 */
function requestHeaders(
	// 分类模型提供provider/baseUrl身份目标及可选模型头。
	model: ClassifierModel<ClassifierApi>,
	// 已解析的key值，下面构造Bearer文本。
	apiKey: string,
	// 可选本次覆盖头，值可为null表示删除。
	optionsHeaders?: ProviderHeaders,
	// 可选客户端身份配置。
	identity?: ClientIdentity,
	// 结果是纯字符串字典，不含null。
): Record<string, string> {
	// 返回括号内合并结果。
	return (
		// helper按传入顺序、忽略大小写地覆盖/删除。
		providerHeadersToRecord(
			// 最低优先级为User-Agent/供应商归因。
			getIdentityHeaders(model, identity),
			// 再加默认Bearer与JSON Content-Type。
			{ authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			// 模型级头可覆盖/删除默认项。
			model.headers,
			// 本次请求头优先级最高。
			optionsHeaders,
			// 合并结果为空时??补新空对象。
		) ?? {}
	);
}

/**
 * Posts one JSON classifier request with bearer auth, `onPayload`/`onResponse` hooks, a fresh
 * timeout per attempt, and provider retries. Returns the parsed response body; throws on failure.
 * `noRetryStatuses` lists HTTP statuses that fail at once although they are normally retried.
 */
/**
 * 发送一个JSON分类请求，返回解析后的unknown响应Promise，错误向外拒绝。
 * 要求options.apiKey，onPayload只执行一次并可替正文；每次尝试新设超时/合并signal、POST并读JSON，共享重试默认额外2次，最终成功后onResponse只执行一次。
 * 例：500带retry-after可重试，onPayload/onResponse抛错在重试范围外；普通网络TypeError不一定符合共享重试器错误形状，不能概括为所有网络失败必重试。超时仍依赖fetch/正文读取响应signal。
 */
export async function postClassifierRequest(
	// 错误里的服务显示名，不是网络目标。
	label: string,
	// 目标已是URL对象，来自transport，仍由fetch实际请求。
	url: URL,
	// 模型给钩子、请求头和错误说明提供元数据。
	model: ClassifierModel<ClassifierApi>,
	// 待序列化正文可以未知结构。
	body: unknown,
	// 类型允许undefined，但函数运行时要求其中有apiKey。
	options: ClassifierOptions | undefined,
	// 只读排除状态列表可让某些默认可重试HTTP状态立即失败。
	noRetryStatuses?: readonly number[],
	// 异步返回未知JSON，业务字段验证在调用方。
): Promise<unknown> {
	// 没有真值key时在钩子/请求前拒绝，不自行读取环境认证。
	if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	// 检查后options/key已收窄，保存key用于每次尝试。
	const apiKey = options.apiKey;
	// 先采用调用方正文引用，不复制嵌套数据。
	let payload = body;
	// 可选onPayload可同步/异步，执行一次；钩子也可就地修改正文。
	const transformed = await options.onPayload?.(payload, model);
	// 返回值非undefined才整体替换，null/false也可成为新正文。
	if (transformed !== undefined) payload = transformed;
	// 优先本次fetch，缺省用全局实现。
	const requestFetch = options.fetch ?? globalThis.fetch;
	// 共享重试器返回最终成功尝试的Response和JSON。
	const { response, json } = await retryProviderRequest(
		/**
		 * 发起一轮全新分类HTTP尝试，返回含Response与解析JSON值的对象Promise。
		 * 例：每次重试重新创建timeoutSignal；非2xx包装为含status/headers/body的Error，用户取消时此回调保留原错误而非转换超时，外层重试器仍可统一成AbortError。
		 */
		async () => {
			// 每次回调新建独立超时signal；显式0也创建，缺省不设本层timer。
			const timeoutSignal = options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined;
			// 计算本次实际fetch使用的signal。
			const signal =
				// 同时有用户与超时信号才需要any。
				options.signal && timeoutSignal
					? // 任一取消使合并信号中止。
						AbortSignal.any([options.signal, timeoutSignal])
					: // 否则选唯一已有信号，两个都没给则undefined。
						(options.signal ?? timeoutSignal);
			// try覆盖fetch和完整JSON/错误正文读取。
			try {
				// 实际发送本次请求。
				const next = await requestFetch(url, {
					// 固定JSON POST。
					method: "POST",
					// 每轮重新合并身份、认证和覆盖头。
					headers: requestHeaders(model, apiKey, options.headers, options.identity),
					// 序列化选定payload；循环对象等错误在本try里抛出。
					body: JSON.stringify(payload),
					// 使用合并后的signal，超时不覆盖用户取消来源。
					signal,
				});
				// 非2xx先读正文并抛带状态的Error；读正文自身失败也会进入catch。
				if (!next.ok) throw httpError(label, next, await next.text());
				// 2xx再读JSON，as unknown不校验业务形状。
				return { response: next, json: (await next.json()) as unknown };
				// 捕获当前尝试fetch/正文/序列化等异常。
			} catch (error) {
				// 只有本次超时已触发且用户未取消才转换超时Error；!仅协调编译期可选timeout类型。
				if (timeoutSignal?.aborted && !options.signal?.aborted) throw timeoutError(options.timeoutMs!);
				// 其他错误保留原值供共享重试器判断。
				throw error;
			}
		},
		// 共享重试配置对象，不改变供应商响应内容。
		{
			// 缺省最多额外2次，首次不算重试；显式0保留。
			maxRetries: options.maxRetries ?? 2,
			// 允许服务端Retry-After的等待上限。
			maxRetryDelayMs: options.maxRetryDelayMs,
			// 退避取消只观察用户总signal，不复用已结束尝试的timeoutSignal。
			signal: options.signal,
			// 调用方指定的立即失败状态列表。
			noRetryStatuses,
		},
	);
	// 最终请求成功且JSON解析完才运行一次onResponse；头转普通对象，钩子异常仍向外拒绝。
	await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
	// 返回已解析的未知JSON，不把业务错误自动当成功分类。
	return json;
}

/**
 * 把未知token字段归一化为有限正数，其他情况返回0，无I/O。
 * 例：缺失、"10"、负数与Infinity均变0；正小数保留，未取整或验证token计数必须整数。
 */
function tokenCount(value: unknown): number {
	// 有限正数保留，其他归0，未做取整。
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Usage from a `{ input_tokens, output_tokens }` object, priced from the model catalog like chat
 * usage. A missing or malformed usage object leaves the result without usage instead of failing it.
 */
/**
 * 从可选远端usage读取输入/输出token，生成统一Usage并按模型目录计算费用，返回对象或undefined。
 * 对象缺失或两字段都undefined就不报告usage；例：input_tokens="bad"但output_tokens=3仍得到input=0/output=3，不因一个坏字段丢整份用量；不采用远端cost字段。
 */
export function parseClassifierUsage(value: unknown, model: ClassifierModel<ClassifierApi>): Usage | undefined {
	// 没对象或两token字段全缺失才返回undefined；仅cost字段不构造usage。
	if (!isRecord(value) || (value.input_tokens === undefined && value.output_tokens === undefined)) return undefined;
	// 坏/缺input计0。
	const input = tokenCount(value.input_tokens);
	// 坏/缺output计0。
	const output = tokenCount(value.output_tokens);
	// 创建统一Usage，缓存用量当前协议未提供。
	const usage: Usage = {
		// 输入token属性简写。
		input,
		// 输出token属性简写。
		output,
		// 缓存读记0。
		cacheRead: 0,
		// 缓存写记0。
		cacheWrite: 0,
		// 总token由输入加输出，不读其他总数字段。
		totalTokens: input + output,
		// 费用初始化0，下一helper按目录写入。
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	// 就地计算并更新cost分项/总额，不请求账单。
	calculateCost(model, usage);
	// 返回带目录估价的Usage对象。
	return usage;
}
