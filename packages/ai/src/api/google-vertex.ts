// Google Vertex AI 适配器：选择 API key 或 ADC 项目/地区认证，委托 Google SDK 请求，并组装统一文字、思考、工具与用量事件。
// Google SDK 的类型只用于编译检查；GoogleGenAI 是运行时创建客户端的类。
import {
	// 单次生成配置：温度、输出上限、系统提示、思考和取消等。
	type GenerateContentConfig,
	// 完整请求对象类型，包含 model、contents 和 config。
	type GenerateContentParameters,
	// 实际 SDK 构造器，负责 HTTP、认证与底层流解析。
	GoogleGenAI,
	// HttpOptions 描述 SDK 的端点、版本、headers、超时和重试等配置；本构建器只设置其中一部分。
	type HttpOptions,
	// SDK 运行时枚举值控制自定义端点的资源路径拼接，不是本项目新定义的 TS enum。
	ResourceScope,
	// 思考配置仅用于静态字段检查。
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
	// ProviderEnv 是本次请求的部分环境覆盖表，并非对 SDK 的 process.env 完整替代。
	ProviderEnv,
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
// 统一读取请求环境覆盖、进程环境与特定 Bun 回退；空串按无值继续回退。
import { getProviderEnvValue } from "../utils/provider-env.ts";
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

// Vertex 继承共用配置并扩展原生思考/工具/项目地区字段；interface 只在编译期存在。
export interface GoogleVertexOptions extends StreamOptions {
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
	// ADC 分支可显式提供项目 id，优先于相应环境变量；key 分支不使用此字段。
	project?: string;
	// ADC 分支可显式提供地区，优先于 GOOGLE_CLOUD_LOCATION；本地没有默认地区。
	location?: string;
}

// 本客户端默认请求 v1；自定义基础路径已含版本时，可通过 httpOptions.apiVersion="" 覆盖。
const API_VERSION = "v1";
// 此字符串只是旧认证占位标记，不能当作真正 API key 发送。
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

// Counter for generating unique tool call IDs
// 模块内可变计数器只在需要补造工具 id 时递增，不写磁盘、不跨进程共享。
let toolCallCounter = 0;

/**
 * 发起一轮 Vertex AI 生成，同步返回 Pi 事件流；输入模型、完整历史和 Vertex 原生选项。
 * 先折叠系统/工具变更，再选择显式 key 的 Express 路径或要求项目/地区的 ADC 路径，创建参数/运行钩子、取得 SDK 生成器并组装首候选事件。
 * 会发网络、调用钩子并原地累计本轮消息，不执行声明工具；例 read 调用得到 start/delta/end，真正 read 与下一轮交上层 Agent。
 * 前置历史折叠可同步抛错；内部失败通常转 error。onResponse/timeoutMs/cacheRetention 等公共字段没有在本适配器独立实现，payload 钩子可修改 SDK config。
 */
// 泛型约束本入口处理 google-vertex 协议与 GoogleVertexOptions，运行时仍由 Google SDK 请求。
export const stream: StreamFunction<"google-vertex", GoogleVertexOptions> = (
	// 模型声明提供 id、端点、价格和能力，不等于已验证的 Google 资源。
	model: Model<"google-vertex">,
	// 输入完整规范化历史，允许包含多次 system 变更。
	context: TranscriptContext,
	// Vertex 原生配置还可给 project/location 和 env；可整体省略。
	options?: GoogleVertexOptions,
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
			// 记录本入口 API 字符串；as Api 不做协议转换或运行时验证。
			api: "google-vertex" as Api,
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
				// 在异步任务里抛错，统一转为失败流；不偷偷使用另一个 fetch。
				throw new Error("Custom fetch is not supported by the Google Vertex adapter");
			}
			// trim 显式 key，并过滤空值/旧认证标记/尖括号占位符；不在这里直接读 GOOGLE_CLOUD_API_KEY。
			const apiKey = resolveApiKey(options);
			// Create the client using either a Vertex API key, if provided, or ADC with project and location
			// 以清理后的真值 key 决定认证分支；SDK 认证是否成功仍要等真实请求。
			const client = apiKey
				? // 有实际 key 走 Vertex Express 客户端，不在本分支要求 project/location。
					createClientWithApiKey(model, apiKey, options?.headers, options?.identity)
				: // 无 key 时走 ADC 客户端，按下面顺序先解析项目和地区。
					createClient(
						// 传模型用于端点与默认请求头。
						model,
						// 本地先解析项目，缺失会在构造客户端前抛错。
						resolveProject(options),
						// 再解析地区；即使 SDK 自己有 global 默认，这一入口仍明确要求地区。
						resolveLocation(options),
						// 本次请求头传入 ADC 客户端，后于身份/模型头合并。
						options?.headers,
						// env 只供本地解析凭证文件路径等；SDK/GoogleAuth 自身仍可能直接读进程环境。
						options?.env,
						// 身份信息决定 User-Agent/适用归因头，不充当认证凭证。
						options?.identity,
					);
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
				// Vertex uses the same @google/genai GenerateContentResponse type as Gemini.
				// responseId is documented there as an output-only identifier for each response.
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
				// 即使已有部分正文也报错，不能因 SDK 迭代结束就凭空补一个 STOP。
				throw new Error("Google Vertex stream ended without a finish reason");
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
 * 把公共简化选项与统一思考档位转换为 Vertex 原生选项，调用 stream 启动生成并返回它的事件通道。
 * 流程是公共配置→未请求/钳制关闭→离散 level 或 token budget；例 Gemini 3 Flash high→level:HIGH，2.5 Flash high→budgetTokens:24576。
 * 不在这里要求显式 key，允许后续 ADC；buildBaseOptions 只拷选定公共字段，扩展输入里的 project/location 不会自动保留，应使用原生 stream 或 env。映射/基础配置错误仍可同步抛。
 */
// 简化入口把公共 reasoning 转换成 Vertex 原生思考选项，再交 stream 选择认证并生成。
export const streamSimple: StreamFunction<"google-vertex", SimpleStreamOptions> = (
	// 模型静态绑定 google-vertex API。
	model: Model<"google-vertex">,
	// 传入同一份规范历史，内部 stream 再折叠系统状态。
	context: TranscriptContext,
	// 公共简化选项不包含原生 project/location 字段；本函数没有从扩展输入逐项复制它们。
	options?: SimpleStreamOptions,
	// 整个入口是同步函数，配置解析出错会直接抛而不是返回失败流。
): AssistantMessageEventStream => {
	// 新建基础配置，不在简化入口同步要求 key；允许后续 ADC 认证。
	const base = {
		// 不额外提供解析好的 key，但 buildBaseOptions 仍保留 options.apiKey；env 也由其透传。
		...buildBaseOptions(model, context, options, undefined),
		// toolChoice 单独复制；buildBaseOptions 不包含该供应商选择字段。
		toolChoice: options?.toolChoice,
		// satisfies 只检查对象与 Vertex 选项静态兼容。
	} satisfies GoogleVertexOptions;
	// 没有请求 reasoning 时明确表达 enabled:false，不省略 thinking。
	if (!options?.reasoning) {
		// 没请求 reasoning 时明确交原生入口关闭，而不是完全省略 thinking。
		return stream(model, context, {
			// 展开公共选定字段，project/location 不在这份对象中，ADC 通常需要通过 env/进程环境解析。
			...base,
			// 表达关闭意图；离散模型最低可用档仍可能需要思考。
			thinking: { enabled: false },
			// 静态检查配置，实际 wire 由 buildParams 决定。
		} satisfies GoogleVertexOptions);
	}

	// 将统一档位按模型能力向可用档钳制，reasoning 类型本身不含 off，结果仍可能 off。
	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	// 模型能力解析后若是 off，走与省略 reasoning 一样的显式关闭路径。
	if (clampedReasoning === "off") {
		// 有请求档位但钳制结果为 off 时，也调用关闭路径。
		return stream(model, context, {
			// 复制同一公共配置。
			...base,
			// 明确给 thinking.enabled=false，而非省略该对象。
			thinking: { enabled: false },
			// satisfies 只检查结构，不增加运行时保证。
		} satisfies GoogleVertexOptions);
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
			// 配置静态兼容 GoogleVertexOptions，不复制/验证对象。
		} satisfies GoogleVertexOptions);
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
		// 原生构建器仍要同时检查 model.reasoning；预算没有在这里与最大输出量协调。
	} satisfies GoogleVertexOptions);
};

/**
 * 构造 Vertex ADC SDK 客户端，输入模型、已解析项目/地区、请求头/环境/身份，返回新实例。
 * 先把凭证文件环境值变成 keyFilename，再设 vertexai:true/v1 和 HTTP 选项；例 env 提供服务账号路径时由 GoogleAuth 延后打开该文件。
 * 本函数不自行读文件、缓存客户端或核验权限；无显式文件时 SDK 默认凭证链可查环境、gcloud 文件或云元数据，认证读取/换 token 在后续 SDK 请求发生，可失败或发网络。
 */
// 创建启用 Vertex 后端的 ADC 客户端，返回新 SDK 实例；认证文件/元数据实际由 SDK 延后读取。
function createClient(
	// 模型用于自定义端点与头，不用于推断项目或地区。
	model: Model<"google-vertex">,
	// 调用方已解析好的项目，静态必需字符串。
	project: string,
	// 调用方已解析好的地区，静态必需字符串。
	location: string,
	// 本次额外头在身份/模型头之后合并。
	optionsHeaders?: ProviderHeaders,
	// 可选环境覆盖用于确定显式凭证文件；不注入整个 SDK 运行环境。
	env?: ProviderEnv,
	// 身份配置不包含 Google OAuth token。
	identity?: ClientIdentity,
	// 返回 SDK 实例，初始化本身也可能抛错。
): GoogleGenAI {
	// 读取显式/环境 GOOGLE_APPLICATION_CREDENTIALS 为 keyFilename；没有则让 GoogleAuth 自行走 ADC 搜索。
	const googleAuthOptions = buildGoogleAuthOptions(env);
	// 创建客户端；后续生成请求才真正获取认证头、发起 HTTP。
	return new GoogleGenAI({
		// 显式 true 固定 Vertex 后端，优先于 SDK 云后端环境开关。
		vertexai: true,
		// 属性简写提供项目，使 SDK 构造相应资源路径。
		project,
		// 提供地区，global 可走全局端点，其他具体主机由 SDK 规则决定。
		location,
		// 默认使用 v1；HTTP 选项中的版本字段可再次覆盖。
		apiVersion: API_VERSION,
		// 有 keyFilename 才展开 googleAuthOptions，缺省时 SDK 查默认凭证链；此处不读/验证文件内容。
		...(googleAuthOptions ? { googleAuthOptions } : {}),
		// 同一端点/头构建器也用于 API key 分支。
		httpOptions: buildHttpOptions(model, optionsHeaders, identity),
	});
}

/**
 * 构造显式 API key 的 Vertex Express 客户端，输入清理后的 key 与端点/头/身份，返回新 SDK 实例。
 * 固定 vertexai:true 与默认 v1，不传项目/地区/GoogleAuth 文件选项；例有效候选 key 存在时，无项目也能到 SDK 请求阶段，但不保证认证成功。
 * SDK 在 Node 中仍读取自己的进程环境、初始化默认头/端点；本次实例不跨调用缓存，构造错误向上抛出。
 */
// 创建有 API key 的 Vertex Express 客户端，返回新 SDK 实例，不读取本地 ADC 文件。
function createClientWithApiKey(
	// 模型仍提供端点和默认头。
	model: Model<"google-vertex">,
	// key 已经由 resolveApiKey 去首尾空白并排除了占位符。
	apiKey: string,
	// 请求级头可覆盖或删除较早来源的本地合并项。
	optionsHeaders?: ProviderHeaders,
	// 身份配置用于 User-Agent/归因头。
	identity?: ClientIdentity,
	// 返回实例而非认证结果或最终回复。
): GoogleGenAI {
	// 实际调用 SDK 构造器，配置错误可抛错。
	return new GoogleGenAI({
		// 明确指定 Vertex 后端，不让环境开关把它变为 Gemini Developer API。
		vertexai: true,
		// 提供显式 key，SDK NodeAuth 采用 x-goog-api-key；自定义同名头可影响实际 HTTP 认证。
		apiKey,
		// 请求默认 v1，并可被 buildHttpOptions 的空版本覆盖。
		apiVersion: API_VERSION,
		// 与 ADC 路径共用端点及头策略，不额外传项目/地区。
		httpOptions: buildHttpOptions(model, optionsHeaders, identity),
	});
}

/**
 * 构造 Vertex 两种认证路径共用的 HTTP 配置，返回对象或 undefined，无网络、不修改模型。
 * 先过滤模板/空基础路径，再设自定义 URL 的 COLLECTION scope，检测版本路径后按需关闭 SDK 版本追加，最后合并身份→模型→请求头。
 * 例 https://proxy/v1/projects/p/locations/global 不再补 v1 或项目地区前缀，但仍按 SDK 追加模型资源名；https://proxy 则保留默认 v1。不是通用 URL 校验或完整 wire 头控制器。
 */
// 生成两种 Vertex 客户端共用的 HTTP 选项，不发请求。
function buildHttpOptions(
	// 模型可能带含 {location} 的生成模板或用户自定义实际基础 URL。
	model: Model<"google-vertex">,
	// 请求头允许 null 删除本地较早来源；不能保证去除 SDK 自己后来添加的默认头。
	optionsHeaders?: ProviderHeaders,
	// 可选身份配置决定基础身份头。
	identity?: ClientIdentity,
	// 空配置时返回 undefined，由 SDK 采用默认 HTTP 配置。
): HttpOptions | undefined {
	// 用 SDK HttpOptions 类型静态核对字段，初始不启用 timeout/retryOptions。
	const httpOptions: HttpOptions = {};
	// 去空白并过滤带 {location} 的模板；不把占位符替换成实际地区。
	const baseUrl = resolveCustomBaseUrl(model.baseUrl);
	// 有可用自定义基础路径才覆盖 SDK 默认端点。
	if (baseUrl) {
		// 使用 trim 后的原字符串，不对 host/path 做安全白名单检查。
		httpOptions.baseUrl = baseUrl;
		// COLLECTION 使 SDK 不再自动前插 projects/.../locations/...；仍会按下面版本规则和模型资源名拼接。
		httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;
		// 只有路径中已包含匹配版本段才取消 SDK 默认版本追加。
		if (baseUrlIncludesApiVersion(baseUrl)) {
			// 空串关闭版本后缀；与只设置 COLLECTION 是两个不同动作。
			httpOptions.apiVersion = "";
		}
	}

	// 按身份→模型→请求顺序合并头，同名比较忽略大小写，后者优先且可删除。
	const headers = providerHeadersToRecord(getIdentityHeaders(model, identity), model.headers, optionsHeaders);
	// 合并结果非空才挂 headers；空结果不会要求 SDK 禁用自己的默认头。
	if (headers) {
		// 给 HTTP 选项赋本地合并后的新对象。
		httpOptions.headers = headers;
	}

	// 有任何本地字段就返回对象；全空才返回 undefined，不表示远端请求没有默认头。
	return Object.keys(httpOptions).length > 0 ? httpOptions : undefined;
}

/**
 * 选择可传 SDK 的自定义基础 URL，输入字符串，返回 trim 后值或 undefined，无副作用。
 * 例生成模板 https://{location}-aiplatform... 被忽略而交 SDK 选主机；普通 https://proxy/v1 原样保留。不验证协议/主机，也不替换模板。
 */
// 判断模型基础 URL 是否应覆盖 SDK 默认，输入字符串，输出 trim 后值或 undefined。
function resolveCustomBaseUrl(baseUrl: string): string | undefined {
	// trim 只去首尾空白，不规范化 URL 内部路径/主机。
	const trimmed = baseUrl.trim();
	// 空串或任意位置包含精确 {location} 都视为模板/缺省；包括查询串中出现也会过滤。
	if (!trimmed || trimmed.includes("{location}")) {
		// 不自作主张替换模板，让 SDK 自己按项目/地区选默认地址。
		return undefined;
	}
	// 其他字符串原样（仅去首尾空白）返回，不保证是合法绝对 URL。
	return trimmed;
}

/**
 * 检查自定义 URL 的路径是否已含 v1/v1beta/v1beta2 等版本段，返回 boolean，无修改。
 * 先绝对 URL 的 pathname，再在解析失败时用原串正则回退；例 https://proxy/v1 返回 true，合法 URL 只有 query 含 v1 不算。
 * 这是字符串启发式，不证明端点能用；版本形式不包括 alpha，正则未启用多行模式。
 */
// 判断基础路径是否已经含版本段，返回布尔值，不发请求也不修改输入。
function baseUrlIncludesApiVersion(baseUrl: string): boolean {
	// 先按绝对 URL 解析，正常路径只检查 pathname，不检查 query/hash。
	try {
		// URL 构造可抛；这里不提供相对地址的 base。
		const url = new URL(baseUrl);
		/**
		 * 对每个 slash 分隔的 pathname 段做完整正则匹配，返回该段是否像版本，无修改。
		 * 例 v1beta2 通过，v1alpha 不通过；some 在首个通过段停止。
		 */
		// 逐路径段匹配 v+数字，再可选 beta+零或多个数字；不接受 v1alpha，大小写敏感，$ 在无 m 模式下不忽略末尾 LF。
		return url.pathname.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part));
		// 绝对 URL 解析失败时才回退原字符串正则，不验证合法 URL。
	} catch {
		// 以开头/斜线和斜线/结尾为边界匹配版本；回退还可能匹配非法 URL 的查询样式文本。
		return /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(baseUrl);
	}
}

/**
 * 把请求/进程环境中的 GOOGLE_APPLICATION_CREDENTIALS 路径变成 GoogleAuth 配置，返回 {keyFilename} 或 undefined。
 * 只读取字符串，不打开文件、展开 ~ 或验证其内容；例 /tmp/account.json 后续由 GoogleAuth.getClient 读取，不意味着本函数已完成认证。无显式值时 SDK 可走默认 ADC 链。
 */
// 只组装 GoogleAuth 的显式凭证文件选项，不在此认证、打开文件或展开 ~。
function buildGoogleAuthOptions(env?: ProviderEnv): { keyFilename: string } | undefined {
	// 请求 env 真值优先，然后进程/特殊 Bun 回退；空值继续回退，未 trim 路径。
	const keyFilename = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);
	// 有真值路径返回 {keyFilename}，否则 undefined 让 SDK 走默认凭证；文件存在性/内容由下游处理。
	return keyFilename ? { keyFilename } : undefined;
}

/**
 * 选取显式 Vertex API key，返回 trim 后候选字符串或 undefined，无 I/O、不改配置。
 * 先 trim，再排除空串、gcp-vertex-credentials 和尖括号占位；例 <authenticated> 走 ADC，普通 key 走 Express。
 * 这里只识别本地约定标记，不验证 key 真实性，也不直接读取 GOOGLE_CLOUD_API_KEY；上层供应商认证层负责把环境 key 放进选项。
 */
// 从 Vertex 原生选项解析真正要使用的显式 key，返回字符串或 undefined，不修改 options。
function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
	// ?. 允许缺配置/缺 key；trim 去掉首尾空白，避免空白 key 被送到服务器。
	const apiKey = options?.apiKey?.trim();
	// 缺值、精确旧标记或整串尖括号占位符都走 ADC，不在本函数核验 key 真伪。
	if (!apiKey || apiKey === GCP_VERTEX_CREDENTIALS_MARKER || isPlaceholderApiKey(apiKey)) {
		// 用 undefined 告知上层没有可直接发送的 key。
		return undefined;
	}
	// 返回清理后的候选 key；不保证服务端接受或有权限。
	return apiKey;
}

/**
 * 判断整串是否为非空尖括号占位符，返回布尔值，无修改；例 <authenticated> 为 true，<> 为 false。
 * 字符组只排除 >，因此中间仍允许 < 或换行；这不是完整凭证格式校验。
 */
// 识别旧的尖括号认证占位符，返回 boolean；不进行一般 API key 格式校验。
function isPlaceholderApiKey(apiKey: string): boolean {
	// 整串必须以 < 开头、> 结尾且中间至少一个非 > 字符；中间可有 < 或换行，<> 不匹配，末尾 LF 不被 $ 忽略。
	return /^<[^>]+>$/.test(apiKey);
}

/**
 * 为 ADC 分支解析项目 id，返回首个真值或抛配置错误，不修改配置/进程环境。
 * 顺序为显式 project→GOOGLE_CLOUD_PROJECT→GCLOUD_PROJECT，每个环境名内部再按请求 env→进程→特殊 Bun 回退；例前一环境名的进程值会先于后一名的请求覆盖。
 * 不 trim/验证真实项目，纯空格也通过真值检查；特殊 Bun 回退可能同步读 /proc，普通路径只是读取字典。
 */
// 按显式项目→GOOGLE_CLOUD_PROJECT→GCLOUD_PROJECT 解析，缺失抛错，无 I/O（特殊 Bun 回退除外）。
function resolveProject(options?: GoogleVertexOptions): string {
	// 用 || 选首个真值，空串回退；项目字符串本身不 trim，纯空格仍可通过。
	const project =
		// options.project 优先级最高，只有原生 stream 才逐项使用这个字段。
		options?.project ||
		// 第一环境名使用 getProviderEnvValue 的覆盖/进程/回退顺序。
		getProviderEnvValue("GOOGLE_CLOUD_PROJECT", options?.env) ||
		// 仅首个环境名无真值时尝试 GCLOUD_PROJECT；后者的请求覆盖不压过前者已有的进程值。
		getProviderEnvValue("GCLOUD_PROJECT", options?.env);
	// 所有来源无真值就失败，不调用 SDK 猜项目。
	if (!project) {
		// 抛明确配置错误交公开 stream 的 catch。
		throw new Error(
			// 错误说明列出两种环境名与原生 options.project。
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
		);
	}
	// 返回首个真值字符串，不检查项目是否存在或调用者有权限。
	return project;
}

/**
 * 为 ADC 分支解析地区，输入可选原生选项，输出真值字符串或抛配置错误。
 * 优先显式 location，再从请求/进程等读取 GOOGLE_CLOUD_LOCATION；例 global 原样传 SDK，本地没有隐式 us-central1/global 默认。
 * 不会核验地区、去空白或验证部署；异常在公开 stream 的异步任务内转失败消息。
 */
// 按显式地区或 GOOGLE_CLOUD_LOCATION 取值，无本地默认，缺失抛错。
function resolveLocation(options?: GoogleVertexOptions): string {
	// || 会跳过空串但不会 trim；显式纯空格也被视为已提供。
	const location = options?.location || getProviderEnvValue("GOOGLE_CLOUD_LOCATION", options?.env);
	// 无地区直接拒绝，即使已安装 SDK 自身在部分场景能默认 global。
	if (!location) {
		// 配置错误变为失败流，尚未请求模型。
		throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
	}
	// 返回未修剪的地区字符串，不核验支持区域或部署可用性。
	return location;
}

/**
 * 把 Vertex 模型、已折叠会话与原生选项变为 SDK 生成参数，返回新对象，不发网络或执行工具。
 * 先转历史/系统与最终工具，再设置显式温度/输出上限、strict 调用模式、思考与信号；例无工具时即使 any 也不发 toolConfig，temperature:0 会保留。
 * 转换/require 严格约束/已取消信号可抛错；通用 samplingParams、缓存和超时未在此独立展开，onPayload 后续仍可改或替换结果。
 */
// 构建 Vertex 的 Google SDK 生成参数，普通工具仅传声明，由本文件消费返回流。
function buildParams(
	// 模型身份和能力来自调用者的元数据。
	model: Model<"google-vertex">,
	// 正常由 stream 传入已折叠的上下文。
	context: TranscriptContext,
	// 缺省原生选项为空对象；不修改输入对象。
	options: GoogleVertexOptions = {},
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
 * 给预算型 Vertex 模型选择四档思考 token 数，返回 number，无副作用。
 * 先用当前档自定义值，再按模型名子串选 2.5-pro 或宽泛 2.5-flash 表，未知名返回 -1 动态；例此处 2.5-flash-lite minimal=128，Generative 入口另设 Lite 表为 512。
 * 不验证自定义数值、不限制到 maxTokens，也不保证预留回答预算；SDK/服务端可拒绝不合模型范围的值。
 */
// 预算型 Vertex 模型取四档 token 数，自定义优先，不做网络请求。
function getGoogleBudget(
	// 模型 id 用于子串选表，静态绑定 Vertex。
	model: Model<"google-vertex">,
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

	// 宽泛 2.5-flash 子串也命中 2.5-flash-lite；本入口没有 Generative 入口单独的 Lite 表。
	if (model.id.includes("2.5-flash")) {
		// Vertex Flash 共用四档表。
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			// 包括 flash-lite 在此也用 minimal=128，不是另一入口的 512。
			minimal: 128,
			// Vertex Flash low 预算 2048。
			low: 2048,
			// Vertex Flash medium 预算 8192。
			medium: 8192,
			// Vertex Flash high 预算 24576。
			high: 24576,
		};
		// 返回当前档位数值，不与输出 token 上限再协调。
		return budgets[level];
	}

	// 未命名匹配时返回 -1 让后端动态决定；不因为未知模型就猜一个固定预算。
	return -1;
}
