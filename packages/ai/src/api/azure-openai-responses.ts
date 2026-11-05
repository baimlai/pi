// Azure Responses 真实请求适配：把统一会话转 SDK 请求并解析流，端点/部署用 Azure 配置，共享 Responses 的块级解析。
// AzureOpenAI 是 SDK 的 Azure 专用客户端，认证头与普通 OpenAI 客户端不同。
import { AzureOpenAI } from "openai";
// import type 只引入流式请求的静态形状，运行时不会加载这个类型。
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
// 把统一思考档位限制到模型目录实际声明支持的档位。
import { clampThinkingLevel } from "../models.ts";
// 这些类型把模型 API、输入会话和输出事件关联起来；泛型限制发生在开发期。
import type { Api, AssistantMessage, Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
// 异常先提取结构化信息，再格式化为可显示的文字。
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
// 事件流既支持 for await 消费过程，也支持 result() 取最终消息。
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
// 把标准 Headers 转成响应观察回调需要的普通记录。
import { headersToRecord } from "../utils/headers.ts";
// 生成适合当前模型的客户端身份头。
import { getIdentityHeaders } from "../utils/identity.ts";
// 只包装建立 SDK 请求的重试；流已开始后的解析不在这个重试范围。
import { retryProviderRequest } from "../utils/provider-retry.ts";
// 会话规范化与工具声明折叠共用同一套历史规则。
import { getDeclaredTools, resolveTranscript, resolveTranscriptTools } from "../utils/transcript.ts";
// Azure 根地址、API 版本与部署名按选项/环境/模型配置分别解析。
import { type AzureEndpointOptions, resolveAzureConfig, resolveDeploymentName } from "./azure-openai-config.ts";
// 语法工具需要知道原始文本应放入参数对象的哪个字符串属性。
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
// 缓存路由键按共享规则限制长度，不保证一定缓存命中。
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
// 消息/工具转协议及响应事件解析复用普通 Responses 的共享实现。
import {
	convertResponsesMessages,
	convertResponsesTools,
	getResponsesToolSupport,
	processResponsesStream,
} from "./openai-responses-shared.ts";
// 统一选项负责默认 token 上限等；采样参数最后可以覆盖已命名字段。
import { buildBaseOptions, resolveSamplingParams } from "./simple-options.ts";

// 目标供应商名在此集合中时，共享转换器跨模型回放可保留复合工具 ID 形式；不是凭证或可信域名白名单。
const AZURE_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode", "azure"]);
// OpenAI Responses rejects max_output_tokens below 16: https://github.com/earendil-works/pi/issues/6265
// 请求显式给出较小输出上限时，后面把它至少提到 16。
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

/**
 * 把任意异常整理成 Azure 错误文字，输入 unknown，返回 string，无网络与状态修改。
 * 流程：标准化错误→格式化，缺少细节时用 Azure OpenAI API error；例普通 Error("bad") 会保留 bad 的信息。
 */
function formatAzureOpenAIError(error: unknown): string {
	// unknown 允许任何抛出值；提取错误后以 Azure 文案作为无具体错误时的回退。
	return formatProviderError(normalizeProviderError(error), "Azure OpenAI API error");
}

// Azure OpenAI Responses-specific options
// 接口继承 AzureEndpointOptions，包含通用请求选项和 Azure 地址/部署覆盖项。
export interface AzureOpenAIResponsesOptions extends AzureEndpointOptions {
	// ? 表示可省略；字符串联合列出可传档位，不含统一层的 off。
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	// 索引访问类型直接沿用安装 SDK 的 tool_choice 类型，避免再手写一份。
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
	// 摘要风格可省略或为 null；下面实际有请求思考时会用 auto 兜底。
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
}

/**
 * Generate function for Azure OpenAI Responses API
 */
/**
 * 发起一轮 Azure Responses 模型调用并同步返回事件流；输入模型、整段会话、可选请求配置，最终消息由流提供。
 * 流程：规范化历史→解析部署/端点→组装参数与钩子→建立请求并可选重试→消费块事件→done/error 并结束；会发网络请求并修改本轮 output。
 * 例用户问“读 README”，模型可返回 read 工具调用；本函数只解析参数，执行工具和下一轮调用由 Agent 负责。
 * try 内失败转为 error 事件；规范化或 try 前部署解析不受该 catch 保护，取消与服务端停止并不是同一保证。
 */
export const stream: StreamFunction<"azure-openai-responses", AzureOpenAIResponsesOptions> = (
	// 泛型把模型约束为 Azure Responses；不在运行时验证服务端能力。
	model: Model<"azure-openai-responses">,
	// 输入是已经用系统消息表达工具变更等信息的会话记录。
	context: TranscriptContext,
	// 可省略请求配置；此入口只从该配置读取 apiKey，不自行查询凭证存储。
	options?: AzureOpenAIResponsesOptions,
	// 箭头函数立即返回事件流对象，网络及解析工作由下面异步闭包推进。
): AssistantMessageEventStream => {
	// 先创建输出通道，调用方不用等待连接建立就能拿到它。
	const stream = new AssistantMessageEventStream();
	// 按兼容开关折叠或保留中途系统消息；此同步调用在异步 try/catch 外。
	const normalizedContext = resolveTranscript(context, model.compat?.supportsMidConvoSystemMessages);

	// Start async processing
	/**
	 * 推进本轮异步网络任务，闭包读取外部模型/配置/通道，不向外返回任务 Promise。
	 * 正常时写块事件和 done；try 内异常写 error；例拿到 HTTP 200 之后仍可能在消费流时失败。
	 */
	// 立即执行异步闭包；主体首个 await 前同步推进，返回的 Promise 没有交给调用方。
	(async () => {
		// 部署名可以不同于 model.id；此解析也在下面 try 之前，不受那个 catch 保护。
		const deploymentName = resolveDeploymentName(model, options);

		// 本次回答共享一个可变消息对象；各 partial 事件引用的是该对象。
		const output: AssistantMessage = {
			// 统一消息角色固定为 assistant，区别服务器内部事件类型。
			role: "assistant",
			// 文本、思考与工具调用块会在流式解析时依次加入这里。
			content: [],
			// as Api 仅告诉 TS 使用共同 API 类型，不改变运行时字符串。
			api: "azure-openai-responses" as Api,
			// 保留调用时选择的供应商名，不从返回事件猜供应商。
			provider: model.provider,
			// 统一历史仍记目录模型 id；真正发给 Azure 的部署名稍后放请求体。
			model: model.id,
			// 用量从零开始，只有收到相应用量信息才会更新。
			usage: {
				// 普通输入 token 初始为零，缓存输入另计。
				input: 0,
				// 输出 token 初始为零，思考 token 若有由共享解析器另记录。
				output: 0,
				// 缓存命中的 token 初始为零。
				cacheRead: 0,
				// 写入缓存的 token 初始为零。
				cacheWrite: 0,
				// 总量初始为零，不表示服务器尚未消耗任何资源。
				totalTokens: 0,
				// 费用分项初始为零，后续用目录价格估算，不能当作账单保证。
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			// pending 表示还没获得可接受的结束原因。
			stopReason: "pending",
			// Date.now() 记录本地毫秒时间，不是服务器响应创建时间。
			timestamp: Date.now(),
		};

		// 下面建立请求、回调与消费响应中的异常统一转成 error 事件。
		try {
			// Create Azure OpenAI client
			// 可选链使 options 未提供时得到 undefined。
			const apiKey = options?.apiKey;
			// 空串也视为缺少 key；与普通 OpenAI 适配的自定义授权头兜底不同。
			if (!apiKey) {
				// 在 try 内抛出，随后作为流的失败消息返回。
				throw new Error(`No API key for provider: ${model.provider}`);
			}
			// 解析端点并构造 SDK 客户端；构造本身不执行本次 Responses 请求。
			const client = createClient(model, apiKey, options);
			// 从历史声明中创建“工具名→原始输入属性名”映射。
			const grammarToolInputProperties = createGrammarToolInputProperties(
				// 使用会话中出现过的声明供历史工具调用转换，而非只看最终活动工具。
				getDeclaredTools(normalizedContext.messages),
				// ?? 仅在 null/undefined 时兜底；未声明支持 grammar 时默认关闭。
				model.compat?.supportsOpenAIGrammarTools ?? false,
			);
			// 生成基础请求参数，let 允许 payload 回调替换整个对象。
			let params = buildParams(model, normalizedContext, options, deploymentName, grammarToolInputProperties);
			// 发请求前等待可选观察/替换回调；它只运行一次，不随下面重试重复。
			const nextParams = await options?.onPayload?.(params, model);
			// 只有 undefined 表示保留当前对象；回调也可以直接原地改 params。
			if (nextParams !== undefined) {
				// as 是编译期断言，不会验证回调返回值的协议结构。
				params = nextParams as ResponseCreateParamsStreaming;
			}
			// 另建 SDK 请求控制选项，与模型请求体 params 分开。
			const requestOptions = {
				// 条件对象展开：有信号才传入 SDK，用于尝试取消实际请求。
				...(options?.signal ? { signal: options.signal } : {}),
				// 显式 0 也会传给 SDK；本层不校验 timeout 合法性或定义整轮重试总期限。
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				// 关闭 SDK 内建重试，避免和外面的可取消重试层叠加。
				maxRetries: 0,
			};
			// 等待建立请求及 SDK 流包装，同时取得原始 HTTP 响应；不是等待全部流内容。
			const { data: openaiStream, response } = await retryProviderRequest(
				// 工厂每次调用都创建新请求，withResponse() 返回 data 流和 response。
				() => client.responses.create(params, requestOptions).withResponse(),
				// 以下是共享重试器的策略选项，不会作为请求体发给 Azure。
				{
					// 额外重试次数默认由 helper 取 0，初始尝试不算一次重试。
					maxRetries: options?.maxRetries,
					// 限制服务器要求的退避时长；未配置时 helper 默认 60 秒。
					maxRetryDelayMs: options?.maxRetryDelayMs,
					// 同一信号也可打断重试等待，已经失败/已消费的响应流不在这里重放。
					signal: options?.signal,
				},
			);
			// 成功拿到 HTTP 响应后先等回调；回调抛错会进入 catch，尚未发 start。
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			// 表示已建立可消费响应；不表示回答已完成或工具已执行。
			stream.push({ type: "start", partial: output });

			// 消费 SDK 异步事件，原地积累消息内容并推送块级事件，最终 done 由本函数发送。
			await processResponsesStream(openaiStream, output, stream, model, {
				// 共享解析器逐个等待这个原始事件回调；其异常也会中断正常处理。
				onProviderStreamEvent: options?.onProviderStreamEvent,
				// 传入同一 grammar 映射，使返回的原始文本恢复为统一参数对象。
				grammarToolInputProperties,
			});

			// 消费结束后再检查信号，避免已取消仍报告 done；不保证远端已停止计费。
			if (options?.signal?.aborted) {
				// 用普通 Error 进入统一 catch，catch 再依据当前信号分类。
				throw new Error("Request was aborted");
			}

			// 若解析后仍是 pending，就不能把没有结束原因的流视为成功。
			if (output.stopReason === "pending") {
				// 给出 Azure 入口的缺结束原因错误，保留此前已收到的部分内容。
				throw new Error("Azure OpenAI Responses stream ended without a stop reason");
			}
			// 错误或取消结束不能走下面成功事件分支。
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				// || 用非空错误文字，否则采用通用回退文字。
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			// 把完整统一消息发为 done；工具调用在这里只是模型产物，不会执行。
			stream.push({ type: "done", reason: output.stopReason, message: output });
			// 关闭本地事件通道，让消费者的异步迭代结束。
			stream.end();
			// 捕获上述 try 范围内的异常；不会回滚已经发出的 partial 事件。
		} catch (error) {
			// 以捕获时信号是否已取消分类，其他异常统一为 error。
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			// 格式化未知抛出值，不在此执行额外请求。
			output.errorMessage = formatAzureOpenAIError(error);
			// 即使还没发 start，失败也会通过 error 事件携带当前消息。
			stream.push({ type: "error", reason: output.stopReason, error: output });
			// 结束失败通道；result() 的具体结果行为由事件流类定义。
			stream.end();
		}
		// 调用异步闭包开始工作；没有 await 这份 Promise，外层仍同步返回。
	})();

	// 返回同一事件流，让调用方选择订阅事件或等待最终消息。
	return stream;
};

/**
 * 把统一的 SimpleStreamOptions 转为 Azure 原生配置并返回相同事件流，会发起模型请求。
 * 先同步检查显式 key→构建公共默认值→钳制思考档位并把 off 转 undefined→委托 stream。
 * 例 reasoning:"high" 先按模型能力选择档位；缺 key 则在返回流之前同步抛错，不是流内 error。
 */
export const streamSimple: StreamFunction<"azure-openai-responses", SimpleStreamOptions> = (
	// 输入模型仍限定 Azure API，防止混用不同协议的静态类型。
	model: Model<"azure-openai-responses">,
	// 统一会话在实际 stream 内再规范化。
	context: TranscriptContext,
	// 调用方使用跨供应商的 SimpleStreamOptions，而不是原生 reasoningEffort。
	options?: SimpleStreamOptions,
	// 本适配包装函数是同步函数，下面的校验异常会直接抛给调用方。
): AssistantMessageEventStream => {
	// 只读取显式 key，不在这里做登录刷新或环境认证发现。
	const apiKey = options?.apiKey;
	// 缺 key 或空串时直接拒绝，尚未返回事件流。
	if (!apiKey) {
		// 这是同步 throw，区别 stream 内部 try 转成 error 事件。
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	// 把跨供应商选项组装成 Azure 专用选项对象。
	const base = {
		// 对象展开复制标准字段和默认值；后写字段可以覆盖展开结果。
		...buildBaseOptions(model, context, options, apiKey),
		// 显式继续传递工具选择策略，包括字符串 none/required 等。
		toolChoice: options?.toolChoice,
		// satisfies 让 TS 检查对象兼容接口，运行时不会转换或校验对象。
	} satisfies AzureOpenAIResponsesOptions;
	// 请求有档位才按模型能力钳制；模型可能把 off 钳制到最低可用档位。
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	// 统一 off 转成原生选项的缺省值，其他钳制结果保留。
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	// 复用真实流入口，避免维护第二套网络/异常处理流程。
	return stream(model, context, {
		// 先展开公共配置。
		...base,
		// 再写转换后的思考档位，优先于先前展开内容。
		reasoningEffort,
		// 再次只做静态接口检查，不增加运行时保护。
	} satisfies AzureOpenAIResponsesOptions);
};

/**
 * 创建 Azure SDK 客户端，输入模型、非空 key 与可选配置，返回新客户端；构造时不发送本次 Responses 请求。
 * 按身份头→模型头→请求头合并，然后解析根 URL/API 版本，交 AzureOpenAI；解析/构造失败向外抛。
 * 例 azureBaseUrl 指向代理时按共享规则保留代理路径，azureDeploymentName 由请求构建另行处理。
 */
function createClient(model: Model<"azure-openai-responses">, apiKey: string, options?: AzureOpenAIResponsesOptions) {
	// 身份头先写、模型头后写，同名属性由模型头覆盖；这是本地对象合并。
	const headers = { ...getIdentityHeaders(model, options?.identity), ...model.headers };

	// 有本次显式头配置时再应用。
	if (options?.headers) {
		// 请求头最后覆盖默认值；ProviderHeaders 中 null 可交 SDK 表达删除头。
		Object.assign(headers, options.headers);
	}

	// 解构取规范化根 URL 和 API 版本；配置错误会沿调用栈抛出。
	const { baseUrl, apiVersion } = resolveAzureConfig(model, options);

	// 创建 Azure 专用 SDK 实例，不发送响应请求。
	return new AzureOpenAI({
		// SDK 对静态 key 使用 api-key 认证头，而非普通 Bearer 头。
		apiKey,
		// SDK 会把版本加入请求查询；本层不查询服务端版本是否有效。
		apiVersion,
		// 明确允许 SDK 在浏览器环境构造；不代表这里承诺 key 的保密性。
		dangerouslyAllowBrowser: true,
		// 可替换 fetch，测试可完全用内存响应，不需真实联网。
		fetch: options?.fetch,
		// 这些默认头在安装 SDK 中可覆盖自动认证头；SDK 后续仍有自己的合并过程。
		defaultHeaders: headers,
		// 使用已规范化的 Azure 或代理根路径，由 SDK 追加 responses 路径。
		baseURL: baseUrl,
	});
}

/**
 * 把整段会话、部署名、配置和 grammar 映射转成 SDK 流式请求对象，不发网络请求。
 * 流程：解析历史工具→转换输入→基础/上限/工具/思考字段→最后合并自定义采样参数；转换或约束配置可能抛错。
 * 例 model.id 是 gpt-x 而部署名为 prod，则请求 model=prod，但统一回答仍记 gpt-x；maxTokens=5 在本层写为 16。
 */
function buildParams(
	// 模型带输入能力、兼容标记、价格和目录 id。
	model: Model<"azure-openai-responses">,
	// 输入会话用于转换历史与解析当前请求工具。
	context: TranscriptContext,
	// 参数位置必传，但值允许 undefined；这与 options? 的调用省略语法不同。
	options: AzureOpenAIResponsesOptions | undefined,
	// 已经解析好的部署名，直接发入请求体的 model 字段。
	deploymentName: string,
	// ReadonlyMap 仅限制 TS 调用方通过该类型写表，不冻结底层 Map；省略时现场构建。
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		// 默认映射扫描历史声明，支持回放已移除工具的调用。
		getDeclaredTools(context.messages),
		// grammar 支持未声明时默认 false。
		model.compat?.supportsOpenAIGrammarTools ?? false,
	),
) {
	// 默认不启用会话内追加工具的专用协议能力。
	const supportsAdditionalTools = model.compat?.supportsAdditionalTools ?? false;
	// 默认不启用工具搜索扩展。
	const supportsToolSearch = model.compat?.supportsToolSearch ?? false;
	// 根据实际兼容开关决定哪些工具放请求体顶层 tools、哪些变更保留在历史中。
	const transcriptTools = resolveTranscriptTools(
		// 工具变更来源是有序系统消息，不是单独的 context.tools 字段。
		context.messages,
		// 共享决策函数选择 changes/additions/none 等支持模式。
		getResponsesToolSupport({
			// 只在明确支持时保留中途系统消息协议行为。
			supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
			// 传递是否支持 additional_tools。
			supportsAdditionalTools,
			// 传递是否支持工具搜索带来的声明行为。
			supportsToolSearch,
		}),
	);
	// 转成 Responses 输入项；集合指导跨来源工具 ID 处理，不验证凭证。
	const messages = convertResponsesMessages(model, context, AZURE_TOOL_CALL_PROVIDERS, {
		// 历史 grammar 调用按此映射输出 custom 输入字符串。
		grammarToolInputProperties,
		// 消息转换与请求工具折叠必须使用同一中途系统能力。
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		// 把追加工具能力用于历史声明转换。
		supportsAdditionalTools,
		// 把工具搜索能力用于声明选择。
		supportsToolSearch,
		// 历史附带的新工具定义也复用这些约束选项。
		toolOptions: {
			// Azure 此处缺省允许 strict，区别普通 Responses 适配的默认 false。
			supportsStrictMode: model.compat?.supportsStrictMode ?? true,
			// grammar 默认关闭，不因 strict 开启就自动打开。
			supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		},
	});

	// 类型标注限定 SDK 流式请求形状，运行时只是普通对象。
	const params: ResponseCreateParamsStreaming = {
		// Azure 用部署名作为 model，可能与 output.model 的目录 id 不同。
		model: deploymentName,
		// 发送完整转换后的输入历史；不是只发最后一个用户问题。
		input: messages,
		// 要求服务端流式响应，SDK 返回异步可迭代对象。
		stream: true,
		// 会话 id 最长取 64 个 UTF-16 单元；此 Azure 路径未按 cacheRetention=none 省略它。
		prompt_cache_key: clampOpenAIPromptCacheKey(options?.sessionId),
		// 请求不持久化服务器 Responses 对象；不等于禁止日志、缓存或其他服务端处理。
		store: false,
	};

	// 真值判断使 0/NaN 不在此设置，负数会进入后面的最小值钳制。
	if (options?.maxTokens) {
		// 显式输出上限至少为 16；这只是本地请求值，不保证实际输出那么多。
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	// undefined 才省略，0 温度会保留。
	if (options?.temperature !== undefined) {
		// 赋值具体温度，不在此验证供应商支持或数值区间。
		params.temperature = options?.temperature;
	}

	// 当前需要顶层发送的工具非空时才加入 tools。
	if (transcriptTools.requestTools.length > 0) {
		// 转换 JSON schema 工具或 grammar custom 工具，可能抛约束不支持错误。
		params.tools = convertResponsesTools(transcriptTools.requestTools, {
			// 同样使用 Azure 的默认 strict=true 策略。
			supportsStrictMode: model.compat?.supportsStrictMode ?? true,
			// grammar 仍需明确兼容支持。
			supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		});
	}
	// toolChoice 只要不是 undefined 就传递，不要求工具数组非空。
	if (options?.toolChoice !== undefined) {
		// 使用调用方原生工具选择配置，不在这里执行工具。
		params.tool_choice = options.toolChoice;
	}

	// 显式档位优先；只指定真值摘要风格也会默认开启 medium，null 不触发默认。
	const reasoningEffort = options?.reasoningEffort ?? (options?.reasoningSummary ? "medium" : undefined);
	// 仅对目录声明 reasoning=true 的模型加入下面思考字段。
	if (model.reasoning) {
		// 有非空档位才走开启分支。
		if (reasoningEffort) {
			// 显式档位需要按模型的档位映射转换。
			const effort = options?.reasoningEffort
				? // ?? 使映射为 null 时也回退请求档位，而不是把 null 直接发给服务器。
					(model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: // 只由摘要风格推导出的 medium 直接使用，不查对应映射。
					reasoningEffort;
			// 写 Responses 的嵌套 reasoning 对象。
			params.reasoning = {
				// NonNullable 去掉静态空类型，再取 effort 字段；as 不验证映射字符串是否被远端接受。
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				// || 使 null/空值回退 auto，因此这里不会发送 null 摘要选项。
				summary: options?.reasoningSummary || "auto",
			};
			// 要求返回可回放的加密思考元数据；不表示本地能解密它。
			params.include = ["reasoning.encrypted_content"];
			// 没有请求档位时，off 映射为 null 才完全省略关闭字段。
		} else if (model.thinkingLevelMap?.off !== null) {
			// 显式请求关闭/最低思考档位，而不是一定省略 reasoning。
			params.reasoning = {
				// 有 off 映射用该值，否则发送 none；类型断言不检查服务端行为。
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
	}

	// Last so model and request sampling parameters override named request fields.
	// 合并模型/请求采样配置；选择逻辑档位用 reasoningEffort，缺省 off。
	const samplingParams = resolveSamplingParams(model, reasoningEffort ?? "off", options?.samplingParams);
	// 存在采样对象才应用，空对象也是真值。
	if (samplingParams) {
		// 最后写入，能覆盖上面 model、tools、token 上限等同名字段；前面的省略策略不是绝对闸门。
		Object.assign(params, samplingParams);
	}

	// 返回新请求对象；未在这里发网络请求或修改原始会话。
	return params;
}
