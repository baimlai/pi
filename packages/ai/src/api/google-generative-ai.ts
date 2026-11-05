// Google Generative AI 适配器：把 Pi 会话与配置交给 Google SDK，再把首个候选的生成流转换成统一消息事件。
// Google SDK 的类型只用于编译检查；GoogleGenAI 是运行时创建客户端的类。
import {
	// 单次生成配置：温度、输出上限、系统提示、思考和取消等。
	type GenerateContentConfig,
	// 完整请求对象类型，包含 model、contents 和 config。
	type GenerateContentParameters,
	// 实际 SDK 构造器，负责 HTTP、认证与底层流解析。
	GoogleGenAI,
	// 思考专用配置类型，不会因导入而开启思考。
	type ThinkingConfig,
} from "@google/genai";
// 用模型价格计算估算费用；把请求思考档位钳制到模型声明的能力。
import { calculateCost, clampThinkingLevel } from "../models.ts";
// import type 整组只保留静态类型，不生成运行时依赖值。
import type {
	// API 协议标识联合。
	Api,
	// 统一 assistant 消息，承载部分输出、用量和终态。
	AssistantMessage,
	// Model 泛型把模型绑定到某个 API 协议。
	Model,
	// 请求头配置可用 null 删除较早来源的同名头。
	ProviderHeaders,
	// 简化配置用统一 reasoning 档位而非 Google 原生 thinking 对象。
	SimpleStreamOptions,
	// 流函数类型把 API、配置与事件流返回值关联起来。
	StreamFunction,
	// 各供应商共用的信号、钩子、采样等配置。
	StreamOptions,
	// 普通文字内容块类型。
	TextContent,
	// 四档思考 token 预算的可选覆盖表。
	ThinkingBudgets,
	// 思考文字块及其可选重放签名类型。
	ThinkingContent,
	// 统一工具调用数据，不是本地工具执行函数。
	ToolCall,
	// 规范化会话历史，系统规则和工具变化都在 messages 内。
	TranscriptContext,
} from "../types.ts";
// 把 SDK/HTTP 错误提取成统一诊断文字，不在本文件只显示 error.message。
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
// 创建 Pi 的异步事件通道，与 Google SDK 的原始生成器是两层流。
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
// 按大小写不敏感规则合并请求头，后来源覆盖或删除前来源。
import { providerHeadersToRecord } from "../utils/headers.ts";
// 身份配置只是类型；getIdentityHeaders 实际生成 User-Agent/适用的归因头。
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
// 清除孤立 UTF-16 代理码元，保留合法成对字符。
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
// 把一条 system 的正文和当前 sections 拼成提示文字。
import { getSystemMessageText } from "../utils/text.ts";
// 系统变更折叠、当前工具重放、首条 system 读取由统一历史辅助函数负责。
import { collapseSystemMessages, getCurrentTools, getInitialSystemMessage } from "../utils/transcript.ts";
// 原生大写档位与解析后小写档位是两个不同的静态联合类型。
import type { GoogleApiThinkingLevel, ResolvedGoogleThinkingLevel } from "./google-shared.ts";
// 本组共享辅助函数处理 Google 协议差异；本文件仍自行组装流事件。
import {
	// Pi 历史转换为 Google Content/Part，处理角色、图片、工具结果和重放签名。
	convertMessages,
	// 工具声明转换为 functionDeclarations，不执行工具。
	convertTools,
	// 生成“尽量关闭”的配置；某些离散档位模型会退到最低可用档。
	getDisabledGoogleThinkingConfig,
	// 只有 thought === true 才把 Part 认作思考，签名存在本身不够。
	isThinkingPart,
	// SDK finishReason 转统一停止原因，未知枚举值可抛错。
	mapStopReason,
	// 结合严格采样声明与 toolChoice 选择 AUTO/NONE/ANY/VALIDATED 等模式。
	resolveGoogleFunctionCallingMode,
	// 按模型映射解析 Google 四档思考值，不支持的映射抛错。
	resolveGoogleThinkingLevel,
	// 同一合并内容块里保留最近非空签名，不把缺省签名当作清空。
	retainThoughtSignature,
	// 重试请求工厂取得生成器的阶段，不自动重放消费中的流。
	retryGoogleRequest,
	// 以模型名中的 Gemini 主版本判断本地 strict 能力，不请求远端探测。
	supportsGoogleStrictToolSampling,
	// 把大写 Google 档位转成 SDK 的 ThinkingLevel 值。
	toGoogleSdkThinkingLevel,
	// 把解析后小写档位转为协议大写档位。
	toGoogleThinkingLevel,
	// 以模型名规则选择离散 thinkingLevel 或数值 thinkingBudget。
	usesGoogleThinkingLevel,
} from "./google-shared.ts";
// 把简化选项转换为共用配置，并估算上下文可留的输出上限。
import { buildBaseOptions } from "./simple-options.ts";

// 继承共用流配置，再增加 Google 原生工具/思考字段；interface 只在编译期存在。
export interface GoogleOptions extends StreamOptions {
	// ? 表示可省略；三个字符串分别让模型自行决定、禁工具、要求工具调用。
	toolChoice?: "auto" | "none" | "any";
	// 可选嵌套配置；不传 thinking 与明确 enabled:false 是不同的原生请求输入。
	thinking?: {
		// 对象存在时 enabled 必须是布尔值；还要 model.reasoning 才会生成原生思考配置。
		enabled: boolean;
		// 可选 token 预算原样传 SDK，不在此验证正负/范围；-1 表示动态，0 表示关闭预算。
		budgetTokens?: number; // -1 for dynamic, 0 to disable
		// 原生离散档位可选；同时给 level/budgetTokens 时构建器优先 level。
		level?: GoogleApiThinkingLevel;
	};
}

// Counter for generating unique tool call IDs
// 模块内可变计数器只在需要补造工具 id 时递增，不写磁盘、不跨进程共享。
let toolCallCounter = 0;

/**
 * 发起一轮 Google Generative AI 生成，同步返回 Pi 事件流；输入模型、完整历史与原生选项。
 * 先折叠系统/工具状态，再建客户端/参数、等待 payload 钩子、获取 SDK 生成器并消费首个候选，组装文字、思考、工具和用量，最后发 done/error。
 * 会发网络、调用钩子和修改本轮共享消息，不执行工具；例 text A→thought B→functionCall read 会按顺序结束/开启对应 Pi 块。
 * 缺 key 在内部任务中转失败流；前置历史折叠仍可能同步抛错。onResponse/timeoutMs/cacheRetention 等公共字段在本适配器没有独立处理，payload 钩子可自行改 SDK config。
 */
// 泛型将本函数静态绑定到 Generative AI API 与 GoogleOptions；运行时仍由 SDK 发请求。
export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (
	// 模型提供 id、端点、价格和能力声明，不在此自动发现模型。
	model: Model<"google-generative-ai">,
	// 输入完整规范化历史，允许包含多次 system 变更。
	context: TranscriptContext,
	// 配置整体可缺省，后续 ?. 对缺省配置安全取值。
	options?: GoogleOptions,
	// 箭头函数同步返回 Pi 事件流，内部异步任务继续推进。
): AssistantMessageEventStream => {
	// 创建事件流；push 通知消费者，end 才结束本地通道。
	const stream = new AssistantMessageEventStream();
	// 把全部 system/工具增删折叠为当前首条 system；此同步步骤在内部 try 之外，可同步抛错。
	const normalizedContext = collapseSystemMessages(context);

	/**
	 * 立即运行本轮异步生成任务，闭包读取模型/配置/通道，不把 Promise 返回给外层调用者。
	 * 成功发 done 并结束，失败通常发 error 并保留已收部分内容；例第 2 个 SDK chunk 出错不会重放第 1 个已发布 chunk。错误格式化自身再次失败时没有第二层 catch。
	 */
	// 立即执行 async 闭包；它的 Promise 不作为外层返回值，结果通常通过流发出。
	(async () => {
		// 本轮只创建一个可变 output，partial 事件复用其引用而非自动生成历史快照。
		const output: AssistantMessage = {
			// 统一消息角色为 assistant。
			role: "assistant",
			// 先用空数组，收到文字/思考/工具调用时依次追加。
			content: [],
			// 记录本入口 API；as Api 只影响类型，不把字符串转换成另一协议。
			api: "google-generative-ai" as Api,
			// 记录请求模型的供应商标识。
			provider: model.provider,
			// 记录请求模型 id，本文件不按响应 modelVersion 重选价格或改模型身份。
			model: model.id,
			// 初始化用量；后续 usageMetadata 整体替换这份用量对象。
			usage: {
				// 非缓存输入 token 初始为零。
				input: 0,
				// 输出（后续含 thoughts）token 初始为零。
				output: 0,
				// 缓存读取 token 初始为零。
				cacheRead: 0,
				// 本适配器没有记录缓存写入 token，保持零。
				cacheWrite: 0,
				// 总数先置零，后面优先采用服务器 totalTokenCount。
				totalTokens: 0,
				// 初始分项与总费用全零，拿到使用量再按本地模型价格计算。
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			// pending 表示还没收到有效 finishReason，不作为成功终态。
			stopReason: "pending",
			// 记录本地开始组装消息的毫秒时间，不是服务端返回时间。
			timestamp: Date.now(),
		};

		// 捕获客户端创建、参数钩子、请求、流消费和成功收尾中的失败。
		try {
			// 只拒绝与当前 globalThis.fetch 不同的自定义函数；显式传当前全局 fetch 仍允许。
			if (options?.fetch && options.fetch !== globalThis.fetch) {
				// 不支持单次自定义 fetch 时转统一失败消息，避免悄悄绕过调用者的网络设置。
				throw new Error("Custom fetch is not supported by the Google Generative AI adapter");
			}
			// 本入口只从 options 读取 key，不在这里查环境变量或凭证库，也不 trim。
			const apiKey = options?.apiKey;
			// 空串/undefined 被当作无 key；非空纯空格仍会交给 SDK。
			if (!apiKey) {
				// 在异步任务的 try 内抛错，通常由下面 catch 写入 error 事件。
				throw new Error(`No API key for provider: ${model.provider}`);
			}
			// 构造 SDK 客户端并合并身份、模型和本次请求头，此处还没调用生成接口。
			const client = createClient(model, apiKey, options?.headers, options?.identity);
			// 先按原始配置生成请求；let 允许正文钩子替换整个参数对象。
			let params = buildParams(model, normalizedContext, options);
			// 可选钩子拿到同一参数引用；await 等其异步完成，钩子可修改对象或抛错中止。
			const nextParams = await options?.onPayload?.(params, model);
			// 只有返回非 undefined 才采用替换值；返回 undefined 仍保留钩子的原地修改。
			if (nextParams !== undefined) {
				// as 只是静态断言，不做运行时校验，也不重新补齐 model/config/信号等字段。
				params = nextParams as GenerateContentParameters;
			}
			/**
			 * 请求工厂在每次共享重试时重新调用同一个 SDK 方法与 params，返回原始生成器 Promise，不再执行 onPayload。
			 * 普通本地工具仅是声明，SDK 不会自动执行它们；若钩子主动换成 CallableTool/自定义 SDK 配置，具体行为仍受 SDK 影响。
			 */
			// 工厂每次重试调用 SDK，预算来自 maxRetries 等选项；仅包获取生成器的 Promise，后面迭代错误不重试。
			const googleStream = await retryGoogleRequest(() => client.models.generateContentStream(params), options);

			// 取得 SDK 生成器后才发 start；这不保证模型正文已出现，也不表示之后不会失败。
			stream.push({ type: "start", partial: output });
			// 联合类型允许文字块、思考块或没有打开块；同类连续 Part 会合并到当前块。
			let currentBlock: TextContent | ThinkingContent | null = null;
			// blocks 与 output.content 指向同一数组，追加工具/文字都会改变其长度。
			const blocks = output.content;
			/**
			 * 读取当前内容数组末项的下标，返回 number，无修改；例追加第二块后从 0 变 1。
			 * 箭头闭包读取实时 blocks.length，因此不保存初始化时空数组的 -1。
			 */
			// 每次调用才读取当前末项下标；闭包不固定最初的 -1。
			const blockIndex = () => blocks.length - 1;
			// for await 依次等待 SDK 解析后的 chunk；本文件不自行解析 SSE 原始字节。
			for await (const chunk of googleStream) {
				// 在任何本 chunk 的 Pi 转换前等待观察钩子；钩子抛错终止本轮，不在这里单独吞掉。
				await options?.onProviderStreamEvent?.(chunk, model);
				// @google/genai documents GenerateContentResponse.responseId as an output-only field
				// used to identify each response. Keep the first non-empty one from the stream.
				// ||= 仅在旧值是假值时采用本 chunk 的 responseId，保留首个真值 id。
				output.responseId ||= chunk.responseId;
				// 只消费第一个候选，忽略其他 candidates；可选链允许候选数组缺省。
				const candidate = chunk.candidates?.[0];
				// 只在第一候选有 parts 时扫描正文；即使没正文，下面仍可处理停止原因和用量。
				if (candidate?.content?.parts) {
					// 按 Part 原顺序处理，保留文字/思考/工具调用的排列。
					for (const part of candidate.content.parts) {
						// text 只排除 undefined，空字符串仍会创建块/保留其可能的签名。
						if (part.text !== undefined) {
							// 只看 thought === true；普通文字也可能有 thoughtSignature。
							const isThinking = isThinkingPart(part);
							// 三种情况任一成立就要换块：没当前块，或思考/普通文字类别变了。
							if (
								// 没有打开块时建立首个块。
								!currentBlock ||
								// 新 Part 是思考、旧块不是思考时切换。
								(isThinking && currentBlock.type !== "thinking") ||
								// 新 Part 是普通文字、旧块不是文字时切换。
								(!isThinking && currentBlock.type !== "text")
							) {
								// 若此前有打开块，先发其 end，再创建新类别块。
								if (currentBlock) {
									// type 标签将联合类型收窄到 TextContent，可安全读 text。
									if (currentBlock.type === "text") {
										// 把已经积累的文字块完整正文作为 end 事件发布。
										stream.push({
											// 事件名标记文字块结束，不是整个回答结束。
											type: "text_end",
											// 当前打开块始终是内容数组末项，因此这里直接取 length-1。
											contentIndex: blocks.length - 1,
											// end 携带本块累积的完整文字。
											content: currentBlock.text,
											// partial 仍是本轮共享 output 引用。
											partial: output,
										});
										// 另一合法类别是 ThinkingContent，结束思考块。
									} else {
										// 发送思考结束事件，不额外调用模型。
										stream.push({
											// 思考块结束标签。
											type: "thinking_end",
											// 用闭包取得当前末项下标。
											contentIndex: blockIndex(),
											// 带上已累计思考正文。
											content: currentBlock.thinking,
											// 同时给出共享部分消息。
											partial: output,
										});
									}
								}
								// 根据新 Part 的 thought 标记建立对应类别。
								if (isThinking) {
									// 新思考块正文为空，签名先缺省；下一步写入本 Part 的正文/签名。
									currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
									// 先把块对象放入 output，再发开始事件，消费者可按下标找到它。
									output.content.push(currentBlock);
									// thinking_start 只标记新块开始，不意味着已拿到完整推理。
									stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
									// 非思考 Part 开始一个普通文字块。
								} else {
									// 新建空文字块；后面 += 才加入当前片段。
									currentBlock = { type: "text", text: "" };
									// 向内容数组追加同一 currentBlock 对象。
									output.content.push(currentBlock);
									// 发文字开始事件，使用追加后的末项下标。
									stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
								}
							}
							// 当前块已按新 Part 类别准备好，用 type 再收窄联合。
							if (currentBlock.type === "thinking") {
								// += 把本 Part 文字附到本块末尾，不按每个 SDK Part 各建一块。
								currentBlock.thinking += part.text;
								// 计算本合并思考块应保留的签名，不拼接签名字串。
								currentBlock.thinkingSignature = retainThoughtSignature(
									// 旧签名作为缺省回退。
									currentBlock.thinkingSignature,
									// 本 Part 有非空新签名才替换旧签名；仅签名且 text 缺省的 Part 不走此分支。
									part.thoughtSignature,
								);
								// 发思考增量事件，output 已更新。
								stream.push({
									// 事件类别为 thinking_delta。
									type: "thinking_delta",
									// 指向当前思考块位置。
									contentIndex: blockIndex(),
									// delta 只含本 Part 的文字，end 才含累计全文。
									delta: part.text,
									// partial 同样不是不可变快照。
									partial: output,
								});
								// 其余合法分支是普通文字块。
							} else {
								// 累加普通文字，不在响应路径做 sanitizeSurrogates。
								currentBlock.text += part.text;
								// 普通文字也保留重放签名，与思考标记分开存放。
								currentBlock.textSignature = retainThoughtSignature(
									// 传入已有普通文字签名作回退。
									currentBlock.textSignature,
									// 新非空签名覆盖旧值，缺省/空串不会清空。
									part.thoughtSignature,
								);
								// 发本次普通文字增量。
								stream.push({
									// 普通文字增量事件标签。
									type: "text_delta",
									// 块位置是内容数组末项。
									contentIndex: blockIndex(),
									// 增量值是当前 Part.text，空串也可以发送。
									delta: part.text,
									// 共享 output 包含当前累积内容。
									partial: output,
								});
							}
						}

						// 独立 if 检查工具调用；同一 Part 同时有 text/functionCall 时先处理文字，再处理工具。
						if (part.functionCall) {
							// 工具块之前必须先结束当前文字/思考块，避免事件交错成一个块。
							if (currentBlock) {
								// 标签分支选择文字块的结束事件。
								if (currentBlock.type === "text") {
									// 发布完整文字结束事件。
									stream.push({
										// text_end 不代表工具执行完毕。
										type: "text_end",
										// 当前块的末项索引。
										contentIndex: blockIndex(),
										// 截至工具调用出现时已累计的文字。
										content: currentBlock.text,
										// 同一部分消息引用。
										partial: output,
									});
									// 否则当前块是思考类别。
								} else {
									// 发布完整思考结束事件。
									stream.push({
										// thinking_end 表示这个思考块告一段落。
										type: "thinking_end",
										// 指向原思考末块。
										contentIndex: blockIndex(),
										// 发送该块累计思考正文。
										content: currentBlock.thinking,
										// 带当前 output，工具块还没追加。
										partial: output,
									});
								}
								// 清掉打开块引用；下一段文字即使类别相同也新建块，不跨工具合并。
								currentBlock = null;
							}

							// Generate unique ID if not provided or if it's a duplicate
							// SDK 可提供调用 id；缺省或空串需要本地补造。
							const providedId = part.functionCall.id;
							// 保存本次是否要补 id 的布尔结果。
							const needsNewId =
								/**
								 * some 的回调判断已有块是否为工具调用且 id 相同，输入 b，返回布尔值，无修改。
								 * 例本轮已出现 call-1，再来 call-1 时补造另一 id；b.type 的标签检查使 TS 在右侧允许读取 b.id。
								 */
								// some 只在当前回答里查同名 id，遇第一个匹配即停止；不跨历史去重。
								!providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
							// 三元表达式选择本地补造值或服务器原值。
							const toolCallId = needsNewId
								? // 模板插入工具名、本地毫秒时间和先自增的模块计数；不是密码学随机/跨进程唯一保证。
									`${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
								: // 非空且本轮未重复的服务端 id 原样保留。
									providedId;

							// 新建统一工具调用对象；只记录请求，真正执行由上层 Agent 负责。
							const toolCall: ToolCall = {
								// type 标签让下游识别 ToolCall。
								type: "toolCall",
								// 保存刚选定的 id，后续结果用它关联。
								id: toolCallId,
								// 工具名缺省/空串时用空串，没有在这里验证已注册或非空。
								name: part.functionCall.name || "",
								// 原有 any 断言只影响 TS；args 空值回退 {}，这里不按工具 schema 验证，也不复制已有 args 对象。
								arguments: (part.functionCall.args as Record<string, any>) ?? {},
								// 真值签名才附上 thoughtSignature；只搬运，不校验 base64 或真实性。
								...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
							};

							// 把完整工具数据追加到最终内容数组。
							output.content.push(toolCall);
							// 立即发工具开始事件，即使参数此时已经完整。
							stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
							// 接着把当前参数整体当作一个增量发布，并非逐 token JSON 解析。
							stream.push({
								// 工具参数增量事件标签。
								type: "toolcall_delta",
								// 指向刚追加的工具块。
								contentIndex: blockIndex(),
								// JSON 序列化整个 arguments 作 delta；序列化失败会进入外层 catch。
								delta: JSON.stringify(toolCall.arguments),
								// partial 与开始/结束事件共享同一个 output。
								partial: output,
							});
							// 立即发工具结束事件；本适配器不处理 partialArgs/willContinue 的跨 Part 合并，重复 id 会当另一调用补造 id。
							stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
						}
					}
				}

				// 若候选给了真值停止原因，就更新终态；本循环不会在这里 break，仍可消费后续用量等 chunk。
				if (candidate?.finishReason) {
					// 保留原始供应商原因用于错误展示。
					output.rawStopReason = candidate.finishReason;
					// 调共享枚举映射；未知值可能抛错，MAX_TOKENS 保留 length。
					output.stopReason = mapStopReason(candidate.finishReason);
					/**
					 * 在本轮内容里查找任一工具调用，无修改；some 命中后停止。
					 * 例先有工具调用、最后 STOP，就让外层改为 toolUse；MAX_TOKENS 仍保持 length。
					 */
					// 只有映射结果为 stop 且整份回答有工具块时才改 toolUse，不把 length/error 改成工具成功。
					if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
						// 表示模型请求执行工具，不代表工具已经执行。
						output.stopReason = "toolUse";
					}
				}

				// 本 chunk 带用量对象时整体覆盖，而不是把每个 chunk 的计数累加。
				if (chunk.usageMetadata) {
					// 新建用量记录；这次缺失的字段按下方规则归零，不保留上个 usageMetadata 值。
					output.usage = {
						// input 要算非缓存输入，避免与 cacheRead 重复计费。
						input:
							// prompt 总输入减缓存读取；未再做 Math.max(0)，异常统计可能得到负数。
							(chunk.usageMetadata.promptTokenCount || 0) - (chunk.usageMetadata.cachedContentTokenCount || 0),
						// output 按本适配口径包含候选正文与思考 token。
						output:
							// 普通候选 token 加 thoughts token，缺省/零用 || 回退零。
							(chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0),
						// 缓存读取单列，来自 cachedContentTokenCount。
						cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0,
						// 本文件不统计缓存写入，固定零。
						cacheWrite: 0,
						// reasoning 是 output 内思考部分的辅助统计，不应再额外加进总数。
						reasoning: chunk.usageMetadata.thoughtsTokenCount || 0,
						// 总数直接采用服务器值，缺省零；不本地用输入/输出重算。
						totalTokens: chunk.usageMetadata.totalTokenCount || 0,
						// 新建费用对象，随后 calculateCost 原地填值。
						cost: {
							// 输入费用先归零。
							input: 0,
							// 含思考的输出费用先归零。
							output: 0,
							// 缓存读取费用先归零。
							cacheRead: 0,
							// 缓存写入费用先归零。
							cacheWrite: 0,
							// 总费用先归零。
							total: 0,
						},
					};
					// 按请求 model 的每百万 token 价格更新分项与总价，属于本地估算，不是账单查询。
					calculateCost(model, output.usage);
				}
			}

			// 正常结束 SDK 迭代后，若还打开文字/思考块就补其 end。
			if (currentBlock) {
				// 用标签分支区分普通文字结束。
				if (currentBlock.type === "text") {
					// 发布末文字块的完整正文。
					stream.push({
						// text_end 标签。
						type: "text_end",
						// 末块下标。
						contentIndex: blockIndex(),
						// 累计普通文字。
						content: currentBlock.text,
						// 当前共享消息。
						partial: output,
					});
					// 末块为思考时发布另一种 end。
				} else {
					// 发思考结束事件。
					stream.push({
						// thinking_end 标签。
						type: "thinking_end",
						// 末思考块下标。
						contentIndex: blockIndex(),
						// 累计思考正文。
						content: currentBlock.thinking,
						// 共享消息引用。
						partial: output,
					});
				}
			}

			// 流耗尽后再检查信号；SDK 请求还通过 config.abortSignal 接收同一信号。
			if (options?.signal?.aborted) {
				// 已取消就进入失败路径，即使此前收到了 finishReason；这不承诺服务端停止计费。
				throw new Error("Request was aborted");
			}

			// 从未得到有效停止原因时拒绝把 EOF 当作正常成功。
			if (output.stopReason === "pending") {
				// 有正文却无 finishReason 仍报错，已有部分正文保留。
				throw new Error("Google stream ended without a finish reason");
			}
			// 错误或取消状态不发送 done。
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				// 根据是否记录了供应商原因选择错误说明。
				const errorMessage = output.rawStopReason
					? // 有原始原因就明确显示它，便于区分 SAFETY/MALFORMED_FUNCTION_CALL 等。
						`Provider stopped with: ${output.rawStopReason}`
					: // 没有原始原因才用固定未知错误文字。
						"An unknown error occurred";
				// 抛错交外层统一错误格式化与事件收尾。
				throw new Error(errorMessage);
			}

			// 通过检查才发 done，reason 可为 stop/length/toolUse；不代表整个 Agent 任务结束。
			stream.push({ type: "done", reason: output.stopReason, message: output });
			// 关闭本地事件通道，使消费者结束遍历并取得最终消息。
			stream.end();
			// 捕获 try 内异常，不为出错时尚打开的块机械补 end。
		} catch (error) {
			// 根据捕获时 signal.aborted 归类；取消与业务错误可能同时发生，信号状态优先。
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			// 从已知 SDK 形状提取/格式化错误，不在本文件自动脱敏；格式化函数自身遇异常对象也并非绝对不抛。
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			// 发统一 error 事件，仍携带已收到正文、工具和用量。
			stream.push({ type: "error", reason: output.stopReason, error: output });
			// 关闭失败通道；若上面错误处理自身再次抛错，这里不会执行。
			stream.end();
		}
		// 调用闭包启动异步工作；没有把 Promise 交外层等待。
	})();

	// 返回事件通道，调用者可 for await 观察并 await result() 取最终消息。
	return stream;
};

/**
 * 将统一简化选项转换成 Google 思考配置后调用原生 stream，返回同一 Pi 事件流。
 * 输入模型/历史/公共选项；先同步要求 key、构造基础配置，再按模型能力解析 reasoning，选择关闭/离散 level/数值预算路径。
 * 例 Gemini 2.5 Flash 的 high 默认 budgetTokens=24576；Gemini 3 Flash 的 high 走 level=HIGH。配置/映射错误可同步抛出，网络与消息事件由 stream 负责。
 */
// 简化入口把统一 reasoning 转为 Google 原生 thinking，最终仍调用本文件 stream。
export const streamSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
	// 模型 API 泛型保持 Generative AI 协议约束。
	model: Model<"google-generative-ai">,
	// 传入同一份规范历史，内部 stream 再折叠系统状态。
	context: TranscriptContext,
	// 公共简化选项没有 GoogleOptions.thinking 字段，用 reasoning/thinkingBudgets 表达。
	options?: SimpleStreamOptions,
	// 整个入口是同步函数，配置解析出错会直接抛而不是返回失败流。
): AssistantMessageEventStream => {
	// 简化入口也只读显式 key，不调用凭证解析器。
	const apiKey = options?.apiKey;
	// 缺 key 的检查在调用 stream 之前，属于同步错误。
	if (!apiKey) {
		// 调用者应捕获该同步抛错；此时尚未创建本入口的事件流。
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	// 新建公共基础配置，稍后按思考路径附加字段。
	const base = {
		// 公共构建器合并采样参数、按上下文估值限制输出上限，并透传钩子等选定字段。
		...buildBaseOptions(model, context, options, apiKey),
		// toolChoice 单独复制；buildBaseOptions 不包含该供应商选择字段。
		toolChoice: options?.toolChoice,
		// satisfies 检查静态兼容性，不在运行时转换/验证对象。
	} satisfies GoogleOptions;
	// 没有请求 reasoning 时明确表达 enabled:false，不省略 thinking。
	if (!options?.reasoning) {
		// 交 stream 生成关闭配置；离散模型若不支持 off，辅助函数可能选择最低可用档，并非保证真的不思考。
		return stream(model, context, { ...base, thinking: { enabled: false } } satisfies GoogleOptions);
	}

	// 将统一档位按模型能力向可用档钳制，reasoning 类型本身不含 off，结果仍可能 off。
	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	// 模型能力解析后若是 off，走与省略 reasoning 一样的显式关闭路径。
	if (clampedReasoning === "off") {
		// 交原生入口关闭，具体 wire 配置由 buildParams 决定。
		return stream(model, context, { ...base, thinking: { enabled: false } } satisfies GoogleOptions);
	}
	// 解析模型特定映射，例如 xhigh→high；无有效 Google 映射可同步抛错。
	const resolvedLevel = resolveGoogleThinkingLevel(model, clampedReasoning);

	// 以模型名判断 wire 格式，不在线探测支持哪些档位。
	if (usesGoogleThinkingLevel(model)) {
		// 离散档位模型使用 level 分支。
		return stream(model, context, {
			// 先复制公共配置，后面的 thinking 覆盖同名字段。
			...base,
			// 构建原生思考对象。
			thinking: {
				// 请求思考，并要求支持模型返回可见 thoughts。
				enabled: true,
				// 解析后小写档位转为大写 Google 协议值。
				level: toGoogleThinkingLevel(resolvedLevel),
			},
			// 仅编译期检查 GoogleOptions，不修改对象或增加校验。
		} satisfies GoogleOptions);
	}

	// 其他模型走 token 预算协议。
	return stream(model, context, {
		// 复用前面选定的公共配置。
		...base,
		// 新建思考对象而不是复用调用者嵌套对象。
		thinking: {
			// 标记思考开启；原生构建器还会检查 model.reasoning。
			enabled: true,
			// 先取自定义预算，否则按模型名与四档表取值；这里不加到 maxTokens 或再留回答余量。
			budgetTokens: getGoogleBudget(model, resolvedLevel, options.thinkingBudgets),
		},
		// satisfies 只核对类型，实际预算是否合法交 SDK/服务端判断。
	} satisfies GoogleOptions);
};

/**
 * 按模型端点、显式 key 和合并头创建新 GoogleGenAI 客户端，返回 SDK 实例，不启动生成请求。
 * 输入可选头/身份，无持久化；自定义 baseUrl 一律配 apiVersion:""，例 https://proxy/v1beta 不再追加 SDK 默认版本。
 * 这里没有强制 vertexai:false，Node SDK 仍会读其 process.env 云后端开关/端点配置；不能把本入口名称当作环境隔离保证。SDK 初始化错误向上抛出。
 */
// 构造 SDK 客户端的内部入口，返回新实例，不缓存跨调用客户端。
function createClient(
	// 模型提供自定义端点及默认请求头。
	model: Model<"google-generative-ai">,
	// 参数静态可省略，但公开 stream 已要求提供真值 key。
	apiKey?: string,
	// 本次请求头可覆盖模型/身份头，null 删除本地合并项。
	optionsHeaders?: ProviderHeaders,
	// 可选身份参数决定 User-Agent/适用归因头。
	identity?: ClientIdentity,
	// 返回 Google SDK 实例，不返回已开始的模型流。
): GoogleGenAI {
	// 内联对象类型列出本构建器需要的三个可选字段，初值空对象。
	const httpOptions: { baseUrl?: string; apiVersion?: string; headers?: Record<string, string> } = {};
	// 模型端点真值时视为调用方提供的完整基础路径，不 trim/检测版本。
	if (model.baseUrl) {
		// 原样设置 baseUrl；是否有效 URL 留到 SDK 请求阶段。
		httpOptions.baseUrl = model.baseUrl;
		// 无条件用空 apiVersion 阻止 SDK 再追加版本；即使 baseUrl 没版本，这里也不补。
		httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
	}
	// 按身份→模型→请求顺序合并头，同名比较忽略大小写，后者优先且可删除。
	const headers = providerHeadersToRecord(getIdentityHeaders(model, identity), model.headers, optionsHeaders);
	// 合并结果非空才挂 headers；空结果不会要求 SDK 禁用自己的默认头。
	if (headers) {
		// 给 HTTP 选项赋本地合并后的新对象。
		httpOptions.headers = headers;
	}

	// 每次生成新客户端，SDK 构造可抛错；未显式设置 vertexai:false，Node SDK 的云后端环境开关仍可能影响实际后端。
	return new GoogleGenAI({
		// 将显式 key 交 SDK，不在这里读取/交换 OAuth token。
		apiKey,
		// 无字段才省略 httpOptions；SDK 自己仍有默认头、版本和端点，也会直接读相关 process.env。
		httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
	});
}

/**
 * 把模型、已规范化历史与原生选项转换为 SDK 参数，返回新顶层对象，不发网络/不执行工具。
 * 流程是历史/系统/工具转换→显式温度与上限→strict 模式与工具声明→思考→信号；例 temperature:0 会保留，只有 toolChoice 且无工具时不发 toolConfig。
 * 转换、require 严格采样限制、已取消信号可能抛错；没有执行通用 samplingParams 展开、自动缓存配置或请求超时配置，后续 onPayload 仍可改 SDK 参数。
 */
// 为一轮请求构造 SDK 参数，无网络；转换/严格工具检查/已取消信号都可能在这里抛错。
function buildParams(
	// 模型用于历史身份、能力与原始模型 id。
	model: Model<"google-generative-ai">,
	// 正常由 stream 传入已折叠的上下文。
	context: TranscriptContext,
	// 默认空对象只在参数 undefined 时生效，不修改调用方配置。
	options: GoogleOptions = {},
	// 返回 GenerateContentParameters 普通对象，TS 不替服务器验证请求约束。
): GenerateContentParameters {
	// 共享转换器生成 contents；它自身也折叠 system，再处理历史角色、工具、图片和可重放签名。
	const contents = convertMessages(model, context);
	// 只取输入首条 system；公开入口已把中途 system 折叠到这里。
	const initialSystemMessage = getInitialSystemMessage(context.messages);
	// 按 system 的增删顺序求最终活动工具，不把被移除的历史工具都发出去。
	const currentTools = getCurrentTools(context.messages);

	// 先收这两个显式生成参数，其他通用 samplingParams 在本构建器没有展开。
	const generationConfig: GenerateContentConfig = {};
	// 仅排除 undefined，所以 temperature:0 会保留。
	if (options.temperature !== undefined) {
		// 温度原样写入，不本地限制数值范围。
		generationConfig.temperature = options.temperature;
	}
	// maxTokens:0 也会保留；原生入口不在此按模型/上下文再钳制。
	if (options.maxTokens !== undefined) {
		// 转成 SDK 的 maxOutputTokens 字段名。
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	// 基于 Gemini 主版本>=3 的本地规则判断 strict 能力，非远端保证。
	const supportsStrictMode = supportsGoogleStrictToolSampling(model.id);
	// 准备可省略的函数调用模式。
	const functionCallingMode =
		// 至少有一项当前工具才解析模式。
		currentTools.length > 0
			? // 严格工具先解析，none/any 可覆盖模式；不支持 require 时仍可能先抛错。
				resolveGoogleFunctionCallingMode(currentTools, options.toolChoice, supportsStrictMode)
			: // 没有当前工具时忽略 toolChoice，不生成 toolConfig。
				undefined;
	// 把首条系统正文与有效 sections 拼成文字；没有首条则空串。
	const systemInstruction = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	// 新建单次请求 config，条件展开只加入实际选择的字段。
	const config: GenerateContentConfig = {
		// 有显式温度/上限字段才展开 generationConfig；&& 为假时不增加字段。
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		// 非空系统文字先清孤立代理码元再作为 systemInstruction，原始历史不修改。
		...(systemInstruction && { systemInstruction: sanitizeSurrogates(systemInstruction) }),
		// 当前工具非空才创建 tools 字段。
		...(currentTools.length > 0 && {
			// false 选择 parametersJsonSchema 路径，转换 const 等规则；只发声明，不传本地执行回调。
			tools: convertTools(currentTools, false, supportsStrictMode),
		}),
		// 模式不是 undefined 才附工具配置，合法 AUTO/NONE 等字符串都保留。
		...(functionCallingMode !== undefined && {
			// 按 SDK 所需层级嵌套 functionCallingConfig.mode。
			toolConfig: { functionCallingConfig: { mode: functionCallingMode } },
		}),
	};

	// 要求配置 enabled 真值且模型声明 reasoning，才进入开启分支。
	if (options.thinking?.enabled && model.reasoning) {
		// includeThoughts:true 请求返回可见思考，但是否返回仍由模型/服务端决定。
		const thinkingConfig: ThinkingConfig = { includeThoughts: true };
		// 离散 level 明确提供时优先，不再使用同时给出的 budgetTokens。
		if (options.thinking.level !== undefined) {
			// 把协议大写值映射为 SDK ThinkingLevel；不验证当前远端模型支持该档位。
			thinkingConfig.thinkingLevel = toGoogleSdkThinkingLevel(options.thinking.level);
			// 没 level 才检查预算；0/-1 都不是 undefined，所以可原样进入。
		} else if (options.thinking.budgetTokens !== undefined) {
			// 预算数值直接赋值，无本地上限/有效范围检查。
			thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
		// 把刚构造的思考配置放入请求。
		config.thinkingConfig = thinkingConfig;
		// 模型有 reasoning 且显式传了关闭对象时，调用共享关闭策略；完全省略 thinking 不进这里。
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		// 预算模型通常 budget:0；不支持 off 的离散模型退最低档，不能保证无思考输出。
		config.thinkingConfig = getDisabledGoogleThinkingConfig(model);
	}

	// 有 signal 才把它绑定进 SDK config。
	if (options.signal) {
		// 已取消时尽早失败，不先发请求。
		if (options.signal.aborted) {
			// 这里抛错会被公开 stream 的异步 catch 接住。
			throw new Error("Request aborted");
		}
		// 将同一信号交 SDK 取消客户端请求/流；不保证远端计算或计费立即停止。
		config.abortSignal = options.signal;
	}

	// 构造 SDK 顶层参数，而非直接 HTTP wire body，SDK 后续还会转换/序列化。
	const params: GenerateContentParameters = {
		// 模型 id 原样传 SDK，由 SDK 补相应模型资源路径。
		model: model.id,
		// 属性简写复用转换出的 contents 数组。
		contents,
		// 属性简写附本轮 config，包括信号（若有）。
		config,
	};

	// 返回新参数；正文钩子仍有机会修改/替换它们。
	return params;
}

/**
 * 为预算型 Google 模型选择某档思考 token 数，返回 number，无外部修改或 I/O。
 * 先用该档自定义值，再按区分大小写的模型名子串选 Pro/Lite/Flash 表，未知名返回 -1（动态）。例 2.5-flash-lite 的 minimal=512，普通 Flash=128。
 * 不会校验/钳制自定义值，也不把预算与 maxTokens 协调；是否符合模型允许范围仍由 SDK/远端决定。
 */
// 根据已解析四档取思考预算，纯计算，不在此调整输出上限。
function getGoogleBudget(
	// 模型名参与本地子串判断，区分预算表。
	model: Model<"google-generative-ai">,
	// level 已由共享函数解析为四种小写档位之一。
	level: ResolvedGoogleThinkingLevel,
	// 可选覆盖表可只提供部分档位，不需要复制整张默认表。
	customBudgets?: ThinkingBudgets,
	// 返回预算数字；-1 是允许交给 SDK 的动态预算标记。
): number {
	// 自定义该档位只要不是 undefined 就优先，0、-1、负数也不会被本地改掉。
	if (customBudgets?.[level] !== undefined) {
		// ! 只消除 TS 的可空推断，不增加运行时检查或替换值。
		return customBudgets[level]!;
	}

	// 名字包含 2.5-pro 则用 Pro 表；此 includes 区分大小写，不要求精确模型名。
	if (model.id.includes("2.5-pro")) {
		// Record 要求四个解析档位各有一个 number，编译期检查不验证服务器上限。
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			// Pro minimal 预算 128。
			minimal: 128,
			// Pro low 预算 2048。
			low: 2048,
			// Pro medium 预算 8192。
			medium: 8192,
			// Pro high 预算 32768。
			high: 32768,
		};
		// 按选定档位索引对应数值，不分配额外请求对象。
		return budgets[level];
	}

	// 必须先匹配 flash-lite，再匹配宽泛 flash，避免 Lite 被后面的表抢先命中。
	if (model.id.includes("2.5-flash-lite")) {
		// Lite 的本地四档表。
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			// Lite minimal 预算 512，与普通 Flash 的 128 不同。
			minimal: 512,
			// Lite low 预算 2048。
			low: 2048,
			// Lite medium 预算 8192。
			medium: 8192,
			// Lite high 预算 24576。
			high: 24576,
		};
		// 返回 Lite 当前档位预算。
		return budgets[level];
	}

	// 其他含 2.5-flash 的名字用普通 Flash 表。
	if (model.id.includes("2.5-flash")) {
		// Flash 四档表与 Pro 的 high 档预算不同，不是查询到的模型官方上限。
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			// Flash minimal 预算 128。
			minimal: 128,
			// Flash low 预算 2048。
			low: 2048,
			// Flash medium 预算 8192。
			medium: 8192,
			// Flash high 预算 24576。
			high: 24576,
		};
		// 返回 Flash 档位预算，不再与 maxTokens 比较。
		return budgets[level];
	}

	// 未命名匹配时返回 -1 让后端动态决定；不因为未知模型就猜一个固定预算。
	return -1;
}
