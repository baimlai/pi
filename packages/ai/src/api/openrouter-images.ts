/**
 * 通过 OpenRouter 的 Chat Completions 扩展生成图片：把文本/参考图包装成一个 user 消息，一次性取回文本和 data URL 图片。
 * 例输入“画一只狗”，模型 output 含 text 时请求 image+text，否则只请求 image；此入口不输出逐 token 事件。
 * 直接调用须显式 apiKey，Models 可先代为解析认证；SDK 发请求，统一重试器负责额外重试，失败整理成 AssistantImages。
 * 只读取第一 choice，图片只接收匹配本地 data:...;base64,... 格式的字符串，不下载 HTTP 图片或解码验证 base64。
 */
// 使用安装的 OpenAI SDK 作为兼容 HTTP 客户端，目标端点由模型 baseUrl 决定。
import OpenAI from "openai";
// SDK 没声明 OpenRouter 的图片生成扩展，下面通过组合类型补字段；这些类型不校验远端 JSON。
import type {
	// 完整非流式回答与用户消息多模态内容块。
	ChatCompletion,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	// SDK 原有非流式请求形状，后面会替换 modalities 字段。
	ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions.js";
// Pi 图片生成契约与内容/请求头类型，import type 运行时擦除。
import type {
	AssistantImages,
	ImageApi,
	ImageContent,
	ImageModel,
	ImagesContext,
	ImagesFunction,
	ImagesOptions,
	ProviderHeaders,
	TextContent,
} from "../types.ts";
// 从 SDK 错误里抽状态/正文并生成可读文字，不重新请求或承诺脱敏。
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
// 头名称忽略大小写，后来源覆盖前来源，null 删除前面来源。
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
// 应用 User-Agent/归因是请求身份说明，和 API key 认证分开。
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
// 统一可取消退避；本文件把 SDK 自带重试关掉，避免两个重试循环叠加。
import { retryProviderRequest } from "../utils/provider-retry.ts";
// 发文本前去掉不成对代理码元，保留有效代理对；不改图片数据。
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

/** OpenRouter 图片扩展的候选字段：image_url 可以直接是串，也可以包成 {url}；可选不表示内容已通过验证。 */
interface OpenRouterGeneratedImage {
	image_url?: string | { url?: string };
}

// 从 SDK 回答的 choices 元素再取 message 类型，与可选 images 扩展交叉；不是对 message 做实际对象合并。
type OpenRouterImageGenerationMessage = ChatCompletion["choices"][number]["message"] & {
	images?: OpenRouterGeneratedImage[];
};

// 单个 choice 原有字段仍保留，只把 message 关联到可带图片扩展的类型。
type OpenRouterImageGenerationChoice = ChatCompletion["choices"][number] & {
	message: OpenRouterImageGenerationMessage;
};

// 整份响应沿用 SDK 结构，同时声明扩展 choices；as 到此类型不会添加 JSON schema 校验。
type OpenRouterImageGenerationResponse = ChatCompletion & {
	choices: OpenRouterImageGenerationChoice[];
};

/** Image generation over OpenRouter's chat completions endpoint. */
/**
 * 图片生成主流程：建空结果→确认显式 key→组消息/载荷钩子→SDK 请求及可选重试→响应钩子→第一候选文字/图片/用量。
 * 输入 ImageModel、文字/图片 input 与通用参数，返回完整 AssistantImages 的 Promise；例文字说明与 PNG 可同时放在 output 数组。
 * onPayload 可整体替换请求；onResponse 在 SDK 已解析完整正文后运行，只观察最终成功请求，重试失败响应不在此逐个通知。
 * catch 会保留已经填好的响应 ID/用量/输出再标 error 或 aborted；空 output 也可能正常 stop，不保证一定生成一张图片。
 */
export const generateImages: ImagesFunction<ImagesOptions> = async (
	// ImageApi 为图片协议联合，不是聊天模型；本入口没有再次校验 model.api 的具体值。
	model: ImageModel<ImageApi>,
	// input 是有序 TextContent/ImageContent 数组，不是多轮 messages 历史。
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	// 先准备可在 catch 中继续返回的同一结果对象，字段随后逐步填充。
	const output: AssistantImages = {
		// 保存请求身份，不因远端 model 字段改变。
		api: model.api,
		provider: model.provider,
		model: model.id,
		// 文本与图片都按解析次序放入这个数组。
		output: [],
		// 乐观初值 stop，只有捕获异常才改失败；未找到图片不自动视错误。
		stopReason: "stop",
		// 本地调用开始附近的毫秒时间。
		timestamp: Date.now(),
	};

	// 请求、观察器和结果解析错误统一在此整理为图片结果。
	try {
		// 直接入口不读 OPENROUTER_API_KEY；需要调用方或 Models 预先提供。
		const apiKey = options?.apiKey;
		// 缺失或空串时在 SDK 请求前失败。
		if (!apiKey) {
			throw new Error(`No API key for provider: ${model.provider}`);
		}
		// 创建本次 SDK 客户端，组合身份/模型/请求头，注入自定义 fetch。
		const client = createClient(model, apiKey, options?.headers, options?.fetch, options?.identity);
		// 构造非流式单 user 消息，文本会做有限 Unicode 清理。
		let params = buildParams(model, context);
		// 载荷钩子可同步/异步观察和原地改参数，或返回替代值。
		const nextParams = await options?.onPayload?.(params, model);
		// 只有 undefined 保留原值；as 不验证替代载荷真的符合请求结构。
		if (nextParams !== undefined) {
			params = nextParams as typeof params;
		}
		// 这些是 SDK 每轮请求配置，不进入 JSON 载荷。
		const requestOptions = {
			// 信号存在才添加；实际取消由 SDK/fetch 合作处理。
			...(options?.signal ? { signal: options.signal } : {}),
			// 显式 timeoutMs 映射 SDK timeout；缺省沿 SDK 客户端超时，非全逻辑请求总预算。
			...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
			// 关闭 SDK 内层重试，由外面的 retryProviderRequest 决定是否再发。
			maxRetries: 0,
		};
		// 解构并重命名 data/raw Response；withResponse 会等待完整 JSON 解析。
		const { data: response, response: rawResponse } = await retryProviderRequest(
			// 传工厂而非已发请求 Promise，重试时才会真正重新调用 create。
			() =>
				client.chat.completions
					// 双断言跨过 SDK 未声明 image modalities 的类型差异，不改变发送的对象或做运行校验。
					.create(params as unknown as ChatCompletionCreateParamsNonStreaming, requestOptions)
					// 同时要解析数据和原 HTTP 响应头，不是 SSE 流。
					.withResponse(),
			{
				// helper 的额外重试缺省为 0，不能直接沿 SDK 默认 2 来解释这里。
				maxRetries: options?.maxRetries,
				// 只限制服务端要求的重试等待，缺省 60s；不是整体生成超时。
				maxRetryDelayMs: options?.maxRetryDelayMs,
				// 信号也用于中断重试退避等待。
				signal: options?.signal,
			},
		);
		// 在成功且正文已解析后通知，回调抛错会在结果填充之前进入 catch。
		await options?.onResponse?.({ status: rawResponse.status, headers: headersToRecord(rawResponse.headers) }, model);

		// 响应扩展是类型约定；没有逐字段验证 choices/message/images 的远端形状。
		const imageResponse = response as OpenRouterImageGenerationResponse;
		// 保存供应商响应 ID，不覆盖请求 model 身份。
		output.responseId = imageResponse.id;
		// 有 usage 才计算，缺失时 output.usage 保持未提供。
		if (imageResponse.usage) {
			output.usage = parseUsage(imageResponse.usage, model);
		}

		// 多 choice 只使用第一个，其他候选不合并。
		const choice = imageResponse.choices[0];
		if (choice) {
			// content 为非空字符串时才输出文字，null/空串跳过。
			const content = choice.message.content;
			if (typeof content === "string" && content.length > 0) {
				// satisfies 只让 TS 检查构造对象，不转换内容或生成额外运行验证。
				output.output.push({ type: "text", text: content } satisfies TextContent);
			}

			// images 缺失视空数组；其他错误形状并没有完整兜底检查。
			for (const image of choice.message.images ?? []) {
				// 兼容 image_url 直接字符串和 {url} 两种声明形式。
				const imageUrl = typeof image.image_url === "string" ? image.image_url : image.image_url?.url;
				// 只收 data:，普通 https 图片不会被下载，也不会变输出 URL 引用。
				if (!imageUrl?.startsWith("data:")) continue;
				// 精确匹配 MIME + ;base64, + 非空正文；无 s/m，正文不接收换行且末尾 LF 也不能忽略。未验证 base64 字符/解码结果。
				const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
				// 不符合这一个本地格式就跳过，不因缺图单独抛错。
				if (!matches) continue;
				// 只拆字段，base64 原文保留，不在本地解码或压缩图片。
				output.output.push({
					type: "image",
					// 第 1 捕获组为 MIME 字段，正则未核验是否 image/*。
					mimeType: matches[1],
					// 第 2 捕获组为非空 data 文本，satisfies 同样不做内容验证。
					data: matches[2],
				} satisfies ImageContent);
			}
		}

		// 没图片或没 choice 仍可能返回 stop，调用方需按 output 判断实际内容。
		return output;
	} catch (error) {
		// 以 catch 时信号状态归类取消；不通过错误文字识别，也不清掉此前已写字段。
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		// 规范化 SDK 状态/正文，可能截断正文；错误说明不提供统一脱敏保证。
		output.errorMessage = formatProviderError(normalizeProviderError(error));
		// 正常错误以 fulfilled Promise 返回结果，不在本 catch 中再次 throw 原异常。
		return output;
	}
};

/** 建本次 OpenAI 兼容客户端，输入模型/显式 key/请求覆盖，返回 SDK 实例；例 OpenRouter baseUrl 指向其 /api/v1。构造本身不发请求，配置可被 SDK 校验拒绝。 */
function createClient(
	model: ImageModel<ImageApi>,
	apiKey: string,
	// ProviderHeaders 允许 null 删除前来源头，但这里只把合并后的结果交 SDK defaultHeaders。
	optionsHeaders?: ProviderHeaders,
	// 可选请求专属 fetch，未给使用 SDK 的宿主默认。
	fetch?: typeof globalThis.fetch,
	// 可选应用身份，与密钥分开传入。
	identity?: ClientIdentity,
): OpenAI {
	return new OpenAI({
		// key 供 SDK 生成 Bearer 认证；不从宿主环境重新解析 OpenRouter key。
		apiKey,
		// 使用模型实际端点，不硬编码 OpenRouter 域名。
		baseURL: model.baseUrl,
		// 显式允许 SDK 在浏览器环境构造，意味着调用方负责其 key 的使用环境。
		dangerouslyAllowBrowser: true,
		fetch,
		// 身份→模型→本次请求头；null 只删除此合并层前值，不保证删除 SDK 后续自身生成的认证/格式头。
		defaultHeaders: providerHeadersToRecord(getIdentityHeaders(model, identity), model.headers, optionsHeaders),
	});
}

// Omit 去掉 SDK 原有 text/audio modalities，再声明 OpenRouter 的 image/text 扩展；不修改 SDK 或运行对象。
type OpenRouterImagesCreateParams = Omit<ChatCompletionCreateParamsNonStreaming, "modalities"> & {
	modalities: Array<"image" | "text">;
};

/** 组一个非流式 user 请求：按 input 次序映射文本/参考图，选 image 或 image+text。例文字加 PNG→text 与 data URL 两个 content 块；不检查图片编码、模型输入能力或 metadata。 */
function buildParams(model: ImageModel<ImageApi>, context: ImagesContext): OpenRouterImagesCreateParams {
	// map 生成新的内容数组，回调显式返回 SDK 联合类型以检查每个分支字段。
	const content: ChatCompletionContentPart[] = context.input.map((item): ChatCompletionContentPart => {
		// type 判别联合让 TS 在此知道 item.text 存在。
		if (item.type === "text") {
			return {
				type: "text",
				// 只删不成对 UTF-16 代理码元，不改正常中文或完整 emoji。
				text: sanitizeSurrogates(item.text),
			} satisfies ChatCompletionContentPartText;
		}
		// 合法联合剩下 ImageContent；拼 data URL，不读取文件或下载外部资源。
		return {
			type: "image_url",
			image_url: {
				url: `data:${item.mimeType};base64,${item.data}`,
			},
			// satisfies 保留推导类型并检查 SDK 形状，不是图像格式校验。
		} satisfies ChatCompletionContentPartImage;
	});

	return {
		// 使用请求目录模型 ID。
		model: model.id,
		// 全部输入合成单轮 user 消息，不把各 input 块当多轮历史。
		messages: [
			{
				// as const 保留 user 字面量，避免推成任意 string；不冻结对象。
				role: "user" as const,
				content,
			},
		],
		// SDK 一次性解析完整 JSON，不走聊天 SSE。
		stream: false,
		// 无论 output 是否声明 image 都请求 image；只有含 text 时额外请求文字。
		modalities: model.output.includes("text") ? ["image", "text"] : ["image"],
	};
}

/**
 * 把响应 token 统计拆成普通输入/输出/缓存读写，并用模型每百万 token 单价估算费用。
 * 例 prompt=100、cached=30、write=10，则读=20、写=10、普通输入=70；写为 0 时 cached 全记缓存读。
 * 输入不做完整数值校验，||0 会替换零/NaN 等假值；仅特定减法钳到非负。不采用 provider 报价、分档 tiers 或逐张图片收费。
 */
function parseUsage(
	// 所有项可缺省；这是结构化读取契约，不代表远端数字都合法/有限。
	rawUsage: {
		prompt_tokens?: number;
		completion_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
	},
	// 使用这一模型的四个基础单价，不按 response.model 再查目录。
	model: ImageModel<ImageApi>,
) {
	// ||0 沿用既有真值回退，不把它解释成严格数字解析。
	const promptTokens = rawUsage.prompt_tokens || 0;
	// 此 reported cached 在写缓存存在时按“含写入”方式拆开。
	const reportedCachedTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
	// 有正写入时从 cached 扣写入并钳零，否则原 cached 直接作为读取量。
	const cacheReadTokens =
		cacheWriteTokens > 0 ? Math.max(0, reportedCachedTokens - cacheWriteTokens) : reportedCachedTokens;
	// 普通输入扣掉缓存读写，避免这一分类重复计入；不保证远端全部统计自洽。
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	// 输出直接采用 completion_tokens 的真值回退，不额外拆 reasoning/image token。
	const output = rawUsage.completion_tokens || 0;
	const usage = {
		// 分别保留四类 token 计数。
		input,
		output,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		// 本地相加，不读取 rawUsage.total_tokens。
		totalTokens: input + output + cacheReadTokens + cacheWriteTokens,
		cost: {
			// 四类各以美元/百万 token 单价除 1e6 后乘实际分类数。
			input: (model.cost.input / 1000000) * input,
			output: (model.cost.output / 1000000) * output,
			cacheRead: (model.cost.cacheRead / 1000000) * cacheReadTokens,
			cacheWrite: (model.cost.cacheWrite / 1000000) * cacheWriteTokens,
			// 先占位，下面统一累加。
			total: 0,
			// 明确费用由本地估算，不是供应商回报的精确账单。
			totalFromProvider: false,
		},
	};
	// 原地补费用总和，不修改 model.cost 或远端原始 usage。
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	// 返回新用量对象给 AssistantImages.usage。
	return usage;
}
