// 供Google Generative AI/Vertex共用的协议适配：思考档位与签名、消息/图片/工具schema转换、结束状态和请求重试；不在此直接创建SDK客户端。
/**
 * Shared utilities for Google Generative AI and Google Vertex providers.
 */

// SDK中Content/Part/ThinkingConfig仅用作类型，结束原因/模式/思考枚举则是实际运行值。
import {
	// 整条Google消息的结构类型，含可选role/parts。
	type Content,
	// 结束原因枚举供switch比较。
	FinishReason,
	// AUTO/ANY/NONE/VALIDATED等工具调用模式。
	FunctionCallingConfigMode,
	// as在import中是重命名，避免与Pi自己的ThinkingLevel同名，不是类型断言。
	ThinkingLevel as GoogleSdkThinkingLevel,
	// SDK单个文字/图片/函数调用等内容块。
	type Part,
	// 思考预算/档位的SDK请求字段类型。
	type ThinkingConfig,
} from "@google/genai";
// 根据模型可用档位把off请求调整为实际候选，不直接保证关闭思考。
import { clampThinkingLevel } from "../models.ts";
// 以下均为Pi内部类型，运行时不会因import type加载对应值。
import type {
	// 工具结果中用于filter收窄的图片块。
	ImageContent,
	// 带具体API泛型的模型元数据。
	Model,
	// 统一回答停止原因联合。
	StopReason,
	// 这里只挑出请求重试/取消相关选项。
	StreamOptions,
	// 工具文字结果的类型谓词目标。
	TextContent,
	// Pi逻辑思考档位，包括xhigh/max。
	ThinkingLevel,
	// 工具声明包含schema与约束，不要求执行函数。
	Tool,
	// 已经规范化成system轨迹的上下文。
	TranscriptContext,
} from "../types.ts";
// 复用带预算、退避和取消的SDK请求重试器。
import { retryProviderRequest } from "../utils/provider-retry.ts";
// 发送文字前去掉不成对UTF-16代理码元，不做正文脱敏。
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
// Google不支持中途system，此处先重放折叠，再移出首条交调用方单独发送。
import { collapseSystemMessages, withoutInitialSystemMessage } from "../utils/transcript.ts";
// 严格schema的协商和参数转换共用同一规则。
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";
// 统一处理跨模型历史、工具调用/结果配对与缺失结果。
import { transformMessages } from "./transform-messages.ts";

// 字符串字面量联合限制这组辅助函数接受的两个Google聊天API。
type GoogleApiType = "google-generative-ai" | "google-vertex";

/**
 * Thinking level for Gemini 3 models.
 * Mirrors Google's ThinkingLevel enum values.
 */
// 对应Google线协议字符串；类型别名不会创建枚举对象。
export type GoogleApiThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
// Exclude从逻辑档位联合删掉xhigh/max，保留minimal等四档。
export type ResolvedGoogleThinkingLevel = Exclude<ThinkingLevel, "xhigh" | "max">;

// Record要求每个Google字符串键都映射到SDK枚举值；对象本身未冻结。
const GOOGLE_SDK_THINKING_LEVEL_MAP: Record<GoogleApiThinkingLevel, GoogleSdkThinkingLevel> = {
	// 未指定档位也有显式SDK枚举，不等于off。
	THINKING_LEVEL_UNSPECIFIED: GoogleSdkThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
	// 最小档位的SDK值。
	MINIMAL: GoogleSdkThinkingLevel.MINIMAL,
	// 低档位的SDK值。
	LOW: GoogleSdkThinkingLevel.LOW,
	// 中档位的SDK值。
	MEDIUM: GoogleSdkThinkingLevel.MEDIUM,
	// 高档位的SDK值。
	HIGH: GoogleSdkThinkingLevel.HIGH,
};

/** Resolve a supported pi level or model-specific Google mapping to a standard Google level. */
/**
 * 把Pi逻辑思考档位按模型映射解析成Google可用的小写档位，无I/O、不修改模型；不支持的映射抛错。
 * 输入model保留具体Google API类型T，level允许xhigh/max，但返回值只能minimal/low/medium/high。例：映射max="HIGH"得到high；缺映射的max报错，null不是“关闭”指令。
 */
export function resolveGoogleThinkingLevel<T extends GoogleApiType>(
	// T extends GoogleApiType把模型API限制在本组，保留调用者具体类型。
	model: Model<T>,
	// 请求的逻辑档位，可能需要模型专属映射。
	level: ThinkingLevel,
): ResolvedGoogleThinkingLevel {
	// 可选链+索引访问；没有映射表/条目可得undefined，明确null也保留在mapped中。
	const mapped = model.thinkingLevelMap?.[level];
	// 只有字符串映射才转小写；null/undefined回退原level，不表示直接关闭。
	const resolvedLevel = typeof mapped === "string" ? mapped.toLowerCase() : level;
	// 对解析后候选做真实运行时白名单分支。
	switch (resolvedLevel) {
		// minimal允许直接使用。
		case "minimal":
		// low允许直接使用。
		case "low":
		// medium允许直接使用。
		case "medium":
		// high允许直接使用；连续case共享下一条return。
		case "high":
			// switch已把返回值收窄为四种支持档位。
			return resolvedLevel;
		// 其他字符串或未映射xhigh/max都进错误路径。
		default:
			// 错误向调用方抛出，不悄悄改成high。
			throw new Error(
				// 说明供应商/模型、原档位和映射值，便于区分映射缺失与非法值。
				`Unsupported Google thinking level mapping for ${model.provider}/${model.id}: ${level} -> ${String(mapped)}`,
			);
	}
}

/**
 * Whether this model uses Gemini's discrete `thinkingLevel` control instead of
 * the token-based `thinkingBudget` control. Supported levels come from the
 * model's `thinkingLevelMap`; this only selects the Google wire format.
 */
/**
 * 按模型id的字符串规则选择thinkingLevel还是thinkingBudget协议，返回布尔值，不探测远端能力。
 * 例：gemini-3.1-pro-preview命中离散档位；是否支持high仍由模型映射/调用方决定。正则未统一锚定结尾，命中是本地命名启发式。
 */
export function usesGoogleThinkingLevel<T extends GoogleApiType>(model: Model<T>): boolean {
	// 先统一小写，只在局部变量上处理模型名。
	const id = model.id.toLowerCase();
	// 多个名称条件用||连接，任意命中即true。
	return (
		// Match Gemini 3 Pro/Flash IDs with or without a minor version, such as
		// gemini-3-flash-preview, gemini-3.1-pro-preview, and gemini-3.8-flash.
		// 非捕获分组(?:)允许可选小版本；这个test没有^/$限制整串。
		/gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id) ||
		// Match Gemini 4 and later, such as gemini-4-argon (#10890).
		// 按字符组/两位数字识别4及后续命名形式，不解析完整版本规范。
		/gemini-(?:[4-9]|[1-9]\d)/.test(id) ||
		// 滚动别名flash-latest明确走离散档位。
		id === "gemini-flash-latest" ||
		// flash-lite-latest别名也走离散档位。
		id === "gemini-flash-lite-latest" ||
		// Match both hosted Gemma 4 naming forms: gemma-4-* and gemma4-*.
		// ?使Gemma与数字间横线可有可无，仍是字符串匹配。
		/gemma-?4/.test(id)
	);
}

/**
 * 把已解析的小写档位转成Google大写字符串，无副作用；例：medium→MEDIUM。
 * 参数联合让TS穷尽四种输入，运行时并无default校验，任意JS传错值仍可能得到undefined。
 */
export function toGoogleThinkingLevel(level: ResolvedGoogleThinkingLevel): GoogleApiThinkingLevel {
	// 按窄联合选择四个大写线协议值。
	switch (level) {
		// 最小档位分支。
		case "minimal":
			// 返回大写MINIMAL，不修改输入。
			return "MINIMAL";
		// 低档位分支。
		case "low":
			// 返回大写LOW。
			return "LOW";
		// 中档位分支。
		case "medium":
			// 返回大写MEDIUM。
			return "MEDIUM";
		// 高档位分支。
		case "high":
			// 返回大写HIGH。
			return "HIGH";
	}
}

/**
 * 用完整映射表取得SDK枚举值，不请求模型；例："LOW"→GoogleSdkThinkingLevel.LOW。
 * Record约束表的键值只是编译期检查，不会检查来自任意JS的越界键。
 */
export function toGoogleSdkThinkingLevel(level: GoogleApiThinkingLevel): GoogleSdkThinkingLevel {
	// 以合法键读映射表，保留SDK类型，不新建配置。
	return GOOGLE_SDK_THINKING_LEVEL_MAP[level];
}

/**
 * 生成调用方未要求思考时的Google配置，不发送请求；先判协议，再尝试把off钳制到模型可用档位。
 * 例：预算模型得到{thinkingBudget:0}；模型不支持off而最低为low时得到thinkingLevel:LOW，因此函数名不保证推理真正关闭。映射非法仍可抛错。
 */
export function getDisabledGoogleThinkingConfig<T extends GoogleApiType>(model: Model<T>): ThinkingConfig {
	// 预算协议直接用0，不再查离散档位表。
	if (!usesGoogleThinkingLevel(model)) return { thinkingBudget: 0 };

	// 对离散协议先尝试off；模型禁止off时兼容层选最近可用档。
	const fallback = clampThinkingLevel(model, "off");
	// off确实支持时仍用预算0表达关闭。
	if (fallback === "off") return { thinkingBudget: 0 };

	// 回退是非off档位，再按模型映射解析；非法映射可抛。
	const resolvedLevel = resolveGoogleThinkingLevel(model, fallback);
	// 小写逻辑档转大写Google字符串。
	const apiLevel = toGoogleThinkingLevel(resolvedLevel);
	// 再转SDK枚举，返回只含thinkingLevel的新对象。
	return { thinkingLevel: toGoogleSdkThinkingLevel(apiLevel) };
}

/**
 * Determines whether a streamed Gemini `Part` should be treated as "thinking".
 *
 * Protocol note (Gemini / Vertex AI thought signatures):
 * - `thought: true` is the definitive marker for thinking content (thought summaries).
 * - `thoughtSignature` is an encrypted representation of the model's internal thought process
 *   used to preserve reasoning context across multi-turn interactions.
 * - `thoughtSignature` can appear on ANY part type (text, functionCall, etc.) - it does NOT
 *   indicate the part itself is thinking content.
 * - For non-functionCall responses, the signature appears on the last part for context replay.
 * - When persisting/replaying model outputs, signature-bearing parts must be preserved as-is;
 *   do not merge/move signatures across parts.
 *
 * See: https://ai.google.dev/gemini-api/docs/thought-signatures
 */
/**
 * 判断一个SDK Part是否明确标记为思考，返回boolean，不改内容。
 * Pick只选取thought/签名两个字段参与类型契约；例：只有thoughtSignature而thought未设，结果false，签名并不等于思考正文。
 */
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	// 严格等于true才判为思考，签名存在与否不影响此布尔结果。
	return part.thought === true;
}

/**
 * Retain thought signatures during streaming.
 *
 * Some backends only send `thoughtSignature` on the first delta for a given part/block; later deltas may omit it.
 * This helper preserves the last non-empty signature for the current block.
 *
 * Note: this does NOT merge or move signatures across distinct response parts. It only prevents
 * a signature from being overwritten with `undefined` within the same streamed block.
 */
/**
 * 在同一内容块的增量间保留最近非空签名，返回新签名或旧值，不存全局状态。
 * 例：已有sig-A、后续incoming=undefined或空串，仍返回sig-A；有sig-B就替换。本函数不检查base64，也不判断两次调用是否属于同一块。
 */
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	// 新签名必须是非空字符串才覆盖旧值；这里不trim，纯空格也算非空。
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	// 没有有效新值就保留原值，包括undefined。
	return existing;
}

// Thought signatures must be base64 for Google APIs (TYPE_BYTES).
// 本正则无m标志，^/$要求匹配整串，末尾换行也不能忽略；只检查字符模式，后面另检查长度，不实际解码base64。
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * 检查候选签名是否非空、长度为4的倍数且字符符合这里的base64正则，无解码/远端验证。
 * 例：AAAA通过、AAA不通过；通过仅表示本地格式检查，不证明签名真实或属于当前模型。
 */
function isValidThoughtSignature(signature: string | undefined): boolean {
	// undefined/空串直接失败。
	if (!signature) return false;
	// 长度按字符串码元计，模4非零失败，不实际解码字节。
	if (signature.length % 4 !== 0) return false;
	// 最后验证字符和等号位置，不验证签名真实性。
	return base64SignaturePattern.test(signature);
}

/**
 * Only keep signatures from the same provider/model and with valid base64.
 */
/**
 * 仅在调用方认定同供应商/模型且格式检查通过时返回原签名，否则undefined，不修改输入。
 * 例：同模型签名AAAA可回放，跨模型则丢弃；身份布尔值来自外层比较，不由本函数重新验证。
 */
function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	// &&短路避免不匹配身份时无谓校验；三元式决定原值或undefined。
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * Models via Google APIs that require explicit tool call IDs in function calls/responses.
 */
/**
 * 按模型名决定函数调用及结果是否携带显式id，无I/O。
 * 例：gemini-3.6-flash、claude-*、gpt-oss-*为true；Gemini主版本解析忽略大小写，但前两个startsWith本身区分大小写。
 */
export function requiresToolCallId(modelId: string): boolean {
	// 先尝试提取Gemini主版本。
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	// 三个条件任一个满足就要求工具id。
	return (
		// claude-前缀区分大小写。
		modelId.startsWith("claude-") ||
		// gpt-oss-前缀同样直接比较。
		modelId.startsWith("gpt-oss-") ||
		// Gemini版本有值且>=3才命中，不能把undefined参与大小比较。
		(geminiMajorVersion !== undefined && geminiMajorVersion >= 3)
	);
}

/**
 * 从模型名开头的gemini[-live]-数字提取主版本，不匹配返回undefined。
 * 例：gemini-live-3.1-flash→3；路径前缀后的gemini不匹配，且不验证整个后缀是否合法。
 */
function getGeminiMajorVersion(modelId: string): number | undefined {
	// ^要求从开头匹配，(?:-live)?可选，(\d+)捕获连续主版本数字。
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	// 无匹配就不用猜版本。
	if (!match) return undefined;
	// 取捕获组按十进制转number，不把3.1当成小数版本。
	return Number.parseInt(match[1], 10);
}

/**
 * 决定工具结果的图片放functionResponse.parts还是另建user图片消息，不访问网络。
 * 识别为Gemini时主版本>=3才嵌套；无法识别成Gemini的名字默认true。例：gemini-2.5→false，claude-*按当前实现为true；后面工具结果分支的英语说明不完全等同于这个实际判断。
 */
function supportsMultimodalFunctionResponse(modelId: string): boolean {
	// 图片嵌套规则也使用同一Gemini版本提取器。
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	// 明确识别的Gemini才按版本分支。
	if (geminiMajorVersion !== undefined) {
		// Gemini3及以后放functionResponse.parts。
		return geminiMajorVersion >= 3;
	}
	// 非Gemini/未知命名默认支持嵌套，这与上方历史英语描述有区别。
	return true;
}

/**
 * Convert internal messages to Gemini Content[] format.
 */
/**
 * 把规范消息轨迹转换为Google Content[]：折叠并移出system，统一历史/工具id，再按user、assistant、toolResult转换；返回新外层结构，不发请求。
 * 例：工具调用后连续两条纯文字结果可合并到同一user回合；Gemini2图片另起一回合，可能打断这次合并。首条systemInstruction由API调用方另行构造。
 * transformMessages先剔除跨模型thinking；本函数同供应商/模型判断不再比较api，两个层次不可混为一条规则。签名仅做格式检查，图片/MIME不在这里验证。
 */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: TranscriptContext): Content[] {
	// Gemini has no mid-conversation system messages; the leading prompt is sent as systemInstruction.
	// 重放全部system成当前状态后去首条system，得到仅对话的数组；不把中途规则当user补丁。
	const conversation = withoutInitialSystemMessage(collapseSystemMessages(context).messages);
	// 本函数累计的新SDK Content数组。
	const contents: Content[] = [];
	/**
	 * 为需要id的目标把外部工具id改成允许字符并截到64个UTF-16码元，其他目标原样返回。
	 * 例：a.b→a_b；不同原id可能碰撞。本回调由transformMessages仅用于跨模型历史，不能声称同模型id也一律清洗。
	 */
	const normalizeToolCallId = (id: string): string => {
		// 不要求id的模型不更改候选id。
		if (!requiresToolCallId(model.id)) return id;
		// 全局替换非法字符再截64位，没有防碰撞/非空保证。
		return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	};

	// 修正历史并按跨模型规则处理签名/工具id；同模型回放不会统一调用上方清洗。
	const transformedMessages = transformMessages(conversation, model, normalizeToolCallId);

	// 依原顺序转换处理后的每条消息。
	for (const msg of transformedMessages) {
		// user分支支持字符串与文字/图片块数组。
		if (msg.role === "user") {
			// typeof在这里分流合法的content联合类型。
			if (typeof msg.content === "string") {
				// 字符串消息直接追加一个user内容。
				contents.push({
					// Google角色名仍为user。
					role: "user",
					// 文字先清孤立代理码元，包装为单个text Part。
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
				// 非字符串时为结构化文字/图片数组。
			} else {
				/**
				 * 把一条用户消息的每个文字/图片块映射成SDK Part，按原顺序返回新数组。
				 * 例：文字后图片仍保持该顺序；图片仅搬运声明MIME/base64，不在这里解码验证或缩放。
				 */
				const parts: Part[] = msg.content.map((item) => {
					// type标签识别文字块，TS随分支收窄字段。
					if (item.type === "text") {
						// 文字块只传清理后的text。
						return { text: sanitizeSurrogates(item.text) };
						// 其余合法用户块为image。
					} else {
						// 为图片新建Part对象，不复用原图片对象作SDK形状。
						return {
							// inlineData承载内嵌媒体。
							inlineData: {
								// 沿用声明的MIME类型，未探测文件内容。
								mimeType: item.mimeType,
								// 沿用base64数据，不解码。
								data: item.data,
							},
						};
					}
				});
				// 空块数组跳过整条user消息，字符串空串却不会在上个分支跳过。
				if (parts.length === 0) continue;
				// 有块才追加这条user消息。
				contents.push({
					// 角色为user。
					role: "user",
					// 属性简写复用转换出的parts数组。
					parts,
				});
			}
			// assistant在Google中使用model角色。
		} else if (msg.role === "assistant") {
			// 每条assistant独立收集内容块。
			const parts: Part[] = [];
			// Check if message is from same provider and model - only then keep thinking blocks
			// 这一层只比provider和model，不比api；外层transformMessages已按更严格身份处理过历史。
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;

			// 逐块保留相对顺序，不把所有text或thinking合并。
			for (const block of msg.content) {
				// 普通文字可带自己的重放签名。
				if (block.type === "text") {
					// 同供应商/模型且本地base64格式通过，才保留textSignature。
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
					// Skip empty text blocks — unless they carry a thought signature. Gemini can attach
					// the signature to a part whose visible text is empty and requires it echoed back;
					// dropping it breaks the reasoning chain and the model intermittently ends mid-task
					// turns with a thought-only STOP (empty completion, no tool call).
					// 文字为空/纯空白时，只有可用签名存在才仍保留该块。
					if ((!block.text || block.text.trim() === "") && !thoughtSignature) continue;
					// 为保留的文字块追加SDK Part。
					parts.push({
						// 文字清孤立代理码元，空白本身不trim删除。
						text: sanitizeSurrogates(block.text),
						// 条件展开：只有真值签名才附加thoughtSignature字段。
						...(thoughtSignature && { thoughtSignature }),
					});
					// thinking块采用不同thought标记。
				} else if (block.type === "thinking") {
					// Only keep as thinking block if same provider AND same model
					// Otherwise convert to plain text (no tags to avoid model mimicking them)
					// 同provider/model时允许作为thinking回放；跨模型thinking通常已被transformMessages移除。
					if (isSameProviderAndModel) {
						// 对thinkingSignature复用同样身份/格式规则。
						const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
						// Same rule as text blocks: an empty thinking block is dropped only when it
						// carries no signature (mirrors the anthropic converter's handling).
						// 空thinking但有可用签名仍保留，避免丢失重放信息。
						if ((!block.thinking || block.thinking.trim() === "") && !thoughtSignature) continue;
						// 追加新的思考Part。
						parts.push({
							// thought:true才是此块为思考的标记。
							thought: true,
							// 清理思考文字的孤立代理码元。
							text: sanitizeSurrogates(block.thinking),
							// 签名仍留在原所属块，不移到其他内容块。
							...(thoughtSignature && { thoughtSignature }),
						});
						// 为到达此处的非同身份thinking保留普通文字降级逻辑，不把它说成主跨模型转换规则。
					} else {
						// Cross-provider/model: the signature is unusable, empty blocks stay dropped.
						// 降级文字为空时跳过，即使原有签名也不使用。
						if (!block.thinking || block.thinking.trim() === "") continue;
						// 将可见思考文字当普通Part。
						parts.push({
							// 没有thought:true，也没有签名。
							text: sanitizeSurrogates(block.thinking),
						});
					}
					// 工具调用转functionCall，不执行工具。
				} else if (block.type === "toolCall") {
					// 仅本地可用的同身份工具签名才附加到该Part。
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					// Part类型检查内部构造，但不做线协议校验。
					const part: Part = {
						// functionCall放工具名、参数及可选id。
						functionCall: {
							// 沿用工具调用名。
							name: block.name,
							// null/undefined参数回退空对象，其他值保持原样。
							args: block.arguments ?? {},
							// 按模型命名规则决定是否发送已经处理过的block.id。
							...(requiresToolCallId(model.id) ? { id: block.id } : {}),
						},
						// 工具签名属于Part而非functionCall内部。
						...(thoughtSignature && { thoughtSignature }),
					};
					// 保留工具块在本条assistant中的顺序。
					parts.push(part);
				}
			}

			// 转换后没有任何Part就跳过整条assistant。
			if (parts.length === 0) continue;
			// 有内容时追加一条model回合。
			contents.push({
				// Google把assistant称为model。
				role: "model",
				// 复用刚收集的parts。
				parts,
			});
			// 工具结果属于user回合中的functionResponse。
		} else if (msg.role === "toolResult") {
			// Extract text and image content
			// 过滤回调c is TextContent是类型谓词，真分支数组可读.text。
			const textContent = msg.content.filter((c): c is TextContent => c.type === "text");
			// 多个文字块以单个换行拼接，随后用trim只判断是否有实际正文。
			const textResult = textContent.map((c) => c.text).join("\n");
			// 模型声明支持image时才保留结果图片。
			const imageContent = model.input.includes("image")
				? // 图片过滤也显式以类型谓词收窄。
					msg.content.filter((c): c is ImageContent => c.type === "image")
				: // 不支持图片时得到空数组，图片不会偷偷作为普通文字发出。
					[];

			// 空白文字视为无正文，但非空正文发送时不trim。
			const hasText = textResult.trim().length > 0;
			// 是否有可发送图片，以过滤后的数组为准。
			const hasImages = imageContent.length > 0;

			// Gemini 3+ models support multimodal function responses with images nested inside
			// functionResponse.parts. Claude and other non-Gemini models behind Cloud Code Assist /
			// Gemini < 3 still needs a separate user image turn.
			// 实际helper对非Gemini名字默认true；这里不按英语注释扩充另一条规则。
			const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);

			// Use "output" key for success, "error" key for errors as per SDK documentation
			// 有文字先取文字，否则有图片用占位提示，两者都无则空串。
			const responseValue = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";

			// 把每张结果图片映射成SDK Part。
			const imageParts: Part[] = imageContent.map((imageBlock) => ({
				// 图片base64包装到inlineData。
				inlineData: {
					// 沿用图片MIME，不验证支持范围。
					mimeType: imageBlock.mimeType,
					// 沿用base64字串。
					data: imageBlock.data,
				},
			}));

			// 函数结果id采用与函数调用相同的目标模型规则。
			const includeId = requiresToolCallId(model.id);
			// 构造一个functionResponse Part。
			const functionResponsePart: Part = {
				// 结果字段在functionResponse内。
				functionResponse: {
					// 按工具名说明是哪种工具的结果。
					name: msg.toolName,
					// isError决定用error键还是output键，不靠exitCode重新判断。
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					// 有图片且支持嵌套才附加parts；&&短路条件展开。
					...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
					// 需要id才发送对应toolCallId，调用/结果配对由前面的统一历史转换维持。
					...(includeId ? { id: msg.toolCallId } : {}),
				},
			};

			// Cloud Code Assist API requires all function responses to be in a single user turn.
			// Check if the last content is already a user turn with function responses and merge.
			// 只看当前输出数组末条，不搜索所有历史user回合。
			const lastContent = contents[contents.length - 1];
			// 末条必须是user且其中已有functionResponse，才合并本条结果。
			if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
				// 原地追加到本函数新建的末条SDK parts数组。
				lastContent.parts.push(functionResponsePart);
				// 条件不满足就建立新的user回合。
			} else {
				// 追加函数结果消息。
				contents.push({
					// 工具结果沿用user角色。
					role: "user",
					// 先放这一条函数结果，之后其他连续结果可能合并。
					parts: [functionResponsePart],
				});
			}

			// For Gemini < 3, add images in a separate user message
			// 只在有图片且不能嵌套时额外建图片消息。
			if (hasImages && !modelSupportsMultimodalFunctionResponse) {
				// 图片消息排在本条functionResponse后，可能阻止下一结果与前一结果继续合并。
				contents.push({
					// 单独图片仍属于user回合。
					role: "user",
					// 先给固定图片说明，再用...展开全部图片Part；不修改提示字符串。
					parts: [{ text: "Tool result image:" }, ...imageParts],
				});
			}
		}
	}

	// 返回完成的数组，不进行SDK请求。
	return contents;
}

// 旧parameters分支需要剔除的元声明名集合，Set.has用于逐键检查。
const JSON_SCHEMA_META_DECLARATIONS = new Set([
	// 声明schema方言的键。
	"$schema",
	// schema标识URI。
	"$id",
	// 命名锚点。
	"$anchor",
	// 动态锚点。
	"$dynamicAnchor",
	// 使用的词汇表声明。
	"$vocabulary",
	// schema注释字段。
	"$comment",
	// 现代schema定义容器。
	"$defs",
	// 旧版定义容器，保留原英语说明。
	"definitions", // pre-draft-2019-09 equivalent of $defs
]);

/**
 * Strip meta-declarations from a schema obj
 */
/**
 * 为旧parameters字段递归删除指定元声明，返回新普通对象；标量、null和整个数组原样返回。
 * 例：properties内嵌对象的$schema被删，allOf数组里的对象不会递归清理；不解析$ref，删除$defs也不自动展开引用。普通键赋值并不提供特殊键的完整保留保证。
 */
function sanitizeForOpenApi(schema: unknown): unknown {
	// unknown边界分流：标量/null/数组都不继续递归。
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		// 数组会按原引用返回，数组里的对象也不被此函数清洗。
		return schema;
	}

	// 新对象保存剩余键，Record允许未知值而不假定schema合法。
	const result: Record<string, unknown> = {};
	// Object.entries只取可枚举自有字符串键，解构得到键和值。
	for (const [key, value] of Object.entries(schema)) {
		// 命中的元声明整项跳过，不解析其中的引用。
		if (JSON_SCHEMA_META_DECLARATIONS.has(key)) continue;
		// 其他对象值递归；这里是普通赋值，未对__proto__单独定义属性。
		result[key] = sanitizeForOpenApi(value);
	}
	// 返回新对象，未修改原对象但可能共享标量/数组引用。
	return result;
}

/** Schema keywords whose values map names to subschemas, so their keys are not schema keywords. */
// 这些关键字的子对象以用户属性名/定义名为键，键名不能当作schema关键字删除。
const JSON_SCHEMA_NAME_MAPS = new Set([
	// 普通属性名到schema。
	"properties",
	// 属性正则到schema。
	"patternProperties",
	// 新式定义名到schema。
	"$defs",
	// 旧式定义名到schema。
	"definitions",
	// 依赖schema映射。
	"dependentSchemas",
	// 旧依赖字段可能同时含名字列表，递归时标量原样保留。
	"dependencies",
]);

/** Keywords containing a subschema or an array of subschemas, not literal data. */
// 这些键的值按schema或schema数组处理，不把任意对象字面量当schema。
const JSON_SCHEMA_SUBSCHEMAS = new Set([
	// 未声明属性的schema。
	"additionalProperties",
	// 未被其他规则处理的属性schema。
	"unevaluatedProperties",
	// 属性名自身的约束schema。
	"propertyNames",
	// 数组元素schema或旧式schema列表。
	"items",
	// 前缀元素schema列表。
	"prefixItems",
	// 旧式额外元素schema。
	"additionalItems",
	// 未处理元素schema。
	"unevaluatedItems",
	// 数组应包含元素的schema。
	"contains",
	// 所有子schema都满足。
	"allOf",
	// 任一子schema满足。
	"anyOf",
	// 恰有一项子schema满足。
	"oneOf",
	// 否定子schema。
	"not",
	// 条件判断schema。
	"if",
	// 条件为真时的schema。
	"then",
	// 条件为假时的schema。
	"else",
	// 字符串内容对应的schema。
	"contentSchema",
]);

/**
 * Rewrite string and number `const` values to single-value `enum`s.
 * Gemini ignores `const` in `parametersJsonSchema` but honors `enum`.
 */
/**
 * 把schema位置的字符串/数字const改为单项enum，保留已有enum，返回重建对象/数组，原输入不改。
 * isNameMap表示当前对象的键是属性名而非关键字；仅沿列出的schema关键字递归，default/examples等字面数据不改。例：properties.const={const:"x"}保留属性名const，子schema变enum:["x"]。
 * 这不是完整JSON Schema解释器；布尔/null/对象const保留，旧parameters分支也不调用此改写。
 */
function rewriteConstAsEnum(schema: unknown, isNameMap = false): unknown {
	// 数组逐项重写，map建立新数组；这里递归使用默认非名称映射模式。
	if (Array.isArray(schema)) return schema.map((item) => rewriteConstAsEnum(item));
	// 标量和null直接返回，不把true/false误当对象。
	if (typeof schema !== "object" || schema === null) return schema;

	// fromEntries preserves names such as __proto__ as own properties.
	// fromEntries建立普通对象且把__proto__保留为自有数据键，不触发赋值setter。
	const result: Record<string, unknown> = Object.fromEntries(
		// 遍历键值，分别判断下一层应该怎样解释。
		Object.entries(schema).map(([key, value]) => {
			// 名称映射中的值都是schema；列出的schema关键字也沿值递归。
			if (isNameMap || JSON_SCHEMA_SUBSCHEMAS.has(key)) return [key, rewriteConstAsEnum(value)];
			// 名称映射关键字的下一层以属性名/定义名为键，传true避免把名为const的字段误改。
			if (JSON_SCHEMA_NAME_MAPS.has(key)) return [key, rewriteConstAsEnum(value, true)];
			// 其他数据保持原值；default/examples/enum等对象字面量不会乱改。
			return [key, value];
		}),
	);
	// 只有schema对象且有const、没有显式非undefined的enum时才考虑替换。
	if (!isNameMap && "const" in result && result.enum === undefined) {
		// 保留const原值以决定是否支持改写。
		const value = result.const;
		// 仅字符串或数字改写，布尔/null/数组/对象const不改。
		if (typeof value === "string" || typeof value === "number") {
			// 从新对象删const，不删原schema中的字段。
			delete result.const;
			// 加单元素enum表达固定值。
			result.enum = [value];
		}
	}
	// 返回新对象；未递归的数据子对象可继续共享原引用。
	return result;
}

/**
 * Convert tools to Gemini function declarations format.
 *
 * By default uses `parametersJsonSchema` which supports full JSON Schema (including
 * anyOf, oneOf, etc.). Gemini ignores `const` there, so string and number `const`
 * values are sent as single-value `enum`s. Set `useParameters` to true to use the legacy `parameters`
 * field instead (OpenAPI 3.03 Schema). This is needed for Cloud Code Assist with Claude
 * models, where the API translates `parameters` into Anthropic's `input_schema`.
 */
/**
 * 把工具数组转换为一个包含functionDeclarations的Google工具组；空数组返回undefined，不执行工具。
 * 每个工具先解析严格采样并取得相应schema，再选旧parameters去元声明或parametersJsonSchema改const；require不支持时可抛错。例：const:"fast"在默认分支变enum:["fast"]。
 * supportsStrictMode默认true是本函数参数默认，实际API调用方会按模型能力传值；真正参数生成约束由服务器执行，不是此处验证工具调用结果。
 */
export function convertTools(
	// 输入是工具声明数组，非运行中的工具执行结果。
	tools: Tool[],
	// 默认走parametersJsonSchema，true才切旧parameters。
	useParameters = false,
	// 本辅助函数默认允许严格模式，实际调用方可按模型传false。
	supportsStrictMode = true,
	// 返回工具组数组或undefined；内层Record不提供字段级的SDK运行验证。
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	// 没有工具就省略整个工具字段，不发空functionDeclarations。
	if (tools.length === 0) return undefined;
	// 有工具时只建立一个组。
	return [
		{
			/**
			 * 逐个转换工具的名称/描述/参数，返回新声明；例：read工具得到对应functionDeclarations项，约束不支持时当前map可抛错并中断整个转换。
			 */
			functionDeclarations: tools.map((tool) => {
				// 按工具声明决定是否启用strict，require与不支持可抛错。
				const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
				// strict=true时取收窄后的schema，否则取原schema；不是执行时参数校验。
				const parameters = getJsonSchemaToolParameters(tool, strict);
				// 为当前工具生成新声明。
				return {
					// 工具名原样发给模型。
					name: tool.name,
					// 用途描述原样保留。
					description: tool.description,
					// 条件展开选择两种互斥参数字段。
					...(useParameters
						? // 旧字段递归去元声明；as unknown不转换值。
							{ parameters: sanitizeForOpenApi(parameters as unknown) }
						: // 默认字段沿schema位置把支持的const改enum。
							{ parametersJsonSchema: rewriteConstAsEnum(parameters) }),
				};
			}),
		},
	];
}

/** Gemini 3+ enforces required function parameters in validated tool-calling modes. */
/**
 * 以Gemini主版本>=3作为支持严格工具采样的本地能力判断，返回布尔值，无远端探测。
 * 例：gemini-3.1→true、无法识别的claude名字→false，与图片支持的默认true是两套不同规则。
 */
export function supportsGoogleStrictToolSampling(modelId: string): boolean {
	// 复用大小写不敏感的Gemini主版本解析。
	const majorVersion = getGeminiMajorVersion(modelId);
	// 必须确实识别Gemini且版本>=3；不根据模型reasoning字段判断。
	return majorVersion !== undefined && majorVersion >= 3;
}

/** Map tool choice string to Gemini FunctionCallingConfigMode. */
/**
 * 把toolChoice字符串映射为SDK调用模式，未识别值回AUTO，无副作用。
 * 例：any→ANY要求工具调用；本函数不支持按单个工具名强制调用，也不抛未知choice错误。
 */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	// 按输入选择SDK枚举。
	switch (choice) {
		// auto让模型自行选择。
		case "auto":
			// 返回AUTO。
			return FunctionCallingConfigMode.AUTO;
		// none禁用函数调用。
		case "none":
			// 返回NONE。
			return FunctionCallingConfigMode.NONE;
		// any要求工具调用，但未在此限定工具名。
		case "any":
			// 返回ANY。
			return FunctionCallingConfigMode.ANY;
		// 其他字符串不视为工具名，统一后备。
		default:
			// 返回AUTO而非抛错。
			return FunctionCallingConfigMode.AUTO;
	}
}

/**
 * 结合工具严格约束与显式toolChoice选Google调用模式，无I/O。
 * 先some解析严格要求，再让none/any优先，否则严格工具用VALIDATED；最后普通选择映射，缺选择返回undefined。例：严格工具+auto→VALIDATED。
 * some会短路：只遍历到首个true，但遇到不支持的require可先抛错，不能说none一定绕过约束解析。
 */
export function resolveGoogleFunctionCallingMode(
	// 工具列表用于判断是否至少一个声明严格采样。
	tools: Tool[],
	// 可缺省的工具选择字串。
	toolChoice: string | undefined,
	// 调用方提供模型是否支持严格采样。
	supportsStrictMode: boolean,
): FunctionCallingConfigMode | undefined {
	// some遇首个true短路；此前遇到不支持的require仍可抛错，不能认为一定检查全部工具。
	const useStrictMode = tools.some((tool) => resolveJsonSchemaStrictSampling(tool, supportsStrictMode) === true);
	// 显式none/any优先于已算出的strict模式。
	if (toolChoice === "none" || toolChoice === "any") {
		// 复用普通选择映射。
		return mapToolChoice(toolChoice);
	}
	// 没有none/any覆盖且存在严格工具时使用验证模式。
	if (useStrictMode) {
		// VALIDATED允许自然语言或受约束函数调用，不同于ANY强制工具。
		return FunctionCallingConfigMode.VALIDATED;
	}
	// 普通非空选择走映射；undefined或空串时不设置模式字段。
	return toolChoice ? mapToolChoice(toolChoice) : undefined;
}

/**
 * Map Gemini FinishReason to our StopReason.
 */
/**
 * 把SDK FinishReason映射为Pi stop/length/error，无状态修改；未覆盖的新枚举值通过never检查并在运行时抛错。
 * 例：MAX_TOKENS→length，SAFETY→error；这里不因是否含工具调用自动改toolUse，该判断由外层流适配器完成。
 */
export function mapStopReason(reason: FinishReason): StopReason {
	// SDK枚举switch分支由编译器辅助检查遗漏。
	switch (reason) {
		// 正常停止。
		case FinishReason.STOP:
			// Pi正常完成状态。
			return "stop";
		// 达到输出token上限。
		case FinishReason.MAX_TOKENS:
			// Pi长度截断状态。
			return "length";
		// 命中黑名单。
		case FinishReason.BLOCKLIST:
		// 禁止内容。
		case FinishReason.PROHIBITED_CONTENT:
		// 敏感个人信息。
		case FinishReason.SPII:
		// 内容安全拦截。
		case FinishReason.SAFETY:
		// 图片安全拦截。
		case FinishReason.IMAGE_SAFETY:
		// 图片禁止内容。
		case FinishReason.IMAGE_PROHIBITED_CONTENT:
		// 图片复现已有内容。
		case FinishReason.IMAGE_RECITATION:
		// 其他图片结束原因。
		case FinishReason.IMAGE_OTHER:
		// 文字复现已有内容。
		case FinishReason.RECITATION:
		// 未说明原因。
		case FinishReason.FINISH_REASON_UNSPECIFIED:
		// 其他原因。
		case FinishReason.OTHER:
		// 不支持的语言。
		case FinishReason.LANGUAGE:
		// 函数调用格式错误。
		case FinishReason.MALFORMED_FUNCTION_CALL:
		// 未预期的工具调用。
		case FinishReason.UNEXPECTED_TOOL_CALL:
		// 连续工具调用过多。
		case FinishReason.TOO_MANY_TOOL_CALLS:
		// 预期有图片但未生成。
		case FinishReason.NO_IMAGE:
			// 以上多个case共用统一error，不伪装正常完成。
			return "error";
		// 有新枚举未覆盖时进入后备块。
		default: {
			// never让TS在枚举新增而本switch未更新时报告类型不匹配；运行时不自动校验。
			const _exhaustive: never = reason;
			// 任意JS未知值到此明确抛错。
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}

/**
 * Map string finish reason to our StopReason (for raw API responses).
 */
/**
 * 把原始字符串结束原因映射为Pi状态，只有STOP与MAX_TOKENS特殊处理，其他一律error。
 * 例：未知NEW_REASON返回error，与SDK枚举版本的未知值抛错不同；不修改原响应。
 */
export function mapStopReasonString(reason: string): StopReason {
	// 原始字符串可能来自非SDK通道，按较宽松规则处理未知值。
	switch (reason) {
		// 精确匹配大写STOP。
		case "STOP":
			// 正常停止。
			return "stop";
		// 精确匹配MAX_TOKENS。
		case "MAX_TOKENS":
			// 输出上限截断。
			return "length";
		// 其余值包括小写stop都走默认。
		default:
			// 返回error，不抛未知枚举错误。
			return "error";
	}
}

/**
 * Run a Google GenAI SDK request with the shared provider retry policy
 * (408/409/429/5xx with backoff, honoring retry-after), mirroring how the
 * Anthropic and OpenAI adapters wrap their initial request in
 * retryProviderRequest. The SDK's ApiError has a `status` property but no
 * `headers` property, and retryProviderRequest only retries errors that carry
 * both, so normalize the error by adding the missing `headers` before
 * rethrowing.
 */
/**
 * 按共享供应商策略与预算重试Google请求工厂，返回成功T或拒绝；不是自动重放已经开始消费的流。
 * 工厂失败若是带status但缺headers的Error，就原地补headers=undefined使重试器识别；maxRetries缺省0。例：429+maxRetries:1可再调用一次工厂。
 * signal主要交给共享错误后/退避取消逻辑，不会在这里自动注入request内部；已取消时首次工厂仍可能被调用，真实网络取消取决于调用方SDK配置。
 */
export function retryGoogleRequest<T>(
	// 每次调用才重新发请求的Promise工厂；T保留成功结果类型。
	request: () => Promise<T>,
	// Pick只暴露StreamOptions中的重试预算/等待上限/信号，问号允许整个options缺省。
	options?: Pick<StreamOptions, "maxRetries" | "maxRetryDelayMs" | "signal">,
): Promise<T> {
	// 返回共享重试器的Promise，本层没有独立循环或第二套重试预算。
	return retryProviderRequest(
		/**
		 * 每轮新调用请求工厂并等待结果；只为满足共享错误形状而修改捕获的SDK Error，随后重抛原对象供外层按预算/状态决策。
		 */
		async () => {
			// 只捕获本轮工厂的同步/异步错误。
			try {
				// await确保工厂Promise拒绝进入下面catch，成功返回T。
				return await request();
				// 捕获值由TS按unknown处理，下面在外部SDK异常边界识别形状。
			} catch (error) {
				// 必须是Error、存在status且完全缺少headers键，才补这个属性；已有无效headers不会在此替换。
				if (error instanceof Error && "status" in error && !("headers" in error)) {
					// as只允许写可选属性，实际修改捕获的原Error；值undefined但键存在，供共享识别器使用。
					(error as { headers?: Headers }).headers = undefined;
				}
				// 重抛同一异常，是否重试由外层判断，不在这里一律吞错。
				throw error;
			}
		},
		// 显式组装共享重试选项，不转发所有StreamOptions。
		{
			// 预算缺省undefined，共享层实际按0处理。
			maxRetries: options?.maxRetries,
			// 服务器指定重试等待的上限，缺省由共享层决定，非整个请求超时。
			maxRetryDelayMs: options?.maxRetryDelayMs,
			// 信号用于共享退避取消；SDK请求是否取消由request闭包自己处理。
			signal: options?.signal,
		},
	);
}
