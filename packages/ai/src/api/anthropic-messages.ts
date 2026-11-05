// Anthropic Messages 的真实请求适配：选择认证/缓存/思考/工具协议，用 SDK 取得 HTTP 响应后自行解析 SSE，输出统一消息事件。
// 默认导入是实际 SDK 类，ClientOptions 是同一导入语句中的纯类型，运行时擦除。
import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
// 这组 beta 协议类型直接取自已安装 SDK；as 起本地别名，不改变网络字段名。
import type {
	BetaInputTransformation,
	BetaStopReason,
	BetaTool,
	BetaCacheControlEphemeral as CacheControlEphemeral,
	BetaContentBlockParam as ContentBlockParam,
	MessageCreateParamsStreaming,
	BetaMessageParam as MessageParam,
	BetaRawMessageStreamEvent as RawMessageStreamEvent,
	BetaRefusalStopDetails as RefusalStopDetails,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
// 联邦认证环境变量名来自公共常量，避免此处重复手写名字。
import {
	ANTHROPIC_FEDERATION_RULE_ID_ENV,
	ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
	ANTHROPIC_ORGANIZATION_ID_ENV,
	ANTHROPIC_SERVICE_ACCOUNT_ID_ENV,
	ANTHROPIC_WORKSPACE_ID_ENV,
} from "../env-api-keys.ts";
// 按目录价格和用量原地计算估算费用，不请求实时账单。
import { calculateCost } from "../models.ts";
// 统一消息、模型和请求选项只参与静态检查，远端 SSE 仍是运行时输入。
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	ImageContent,
	Message,
	Model,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
} from "../types.ts";
// 诊断追加进当前 assistant 消息，供外层保存/展示，不单独打印或写磁盘。
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
// 事件通道供 for await 订阅，result() 可取最终消息。
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
// HTTP 响应头转为观察回调需要的普通记录。
import { headersToRecord } from "../utils/headers.ts";
// 身份类型只用于检查，helper 实际按供应商产生身份头。
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
// SSE JSON 可有限修复控制字符/无效转义；泛型不验证事件 schema。
import { parseJsonWithRepair } from "../utils/json-parse.ts";
// OpenRouter 有完整有效报告时可覆盖费用总额；费用分项仍可能是目录估算。
import {
	applyOpenRouterReportedCost,
	isOpenRouterModel,
	type OpenRouterUsageAccounting,
} from "../utils/openrouter-cost.ts";
// 读本次环境覆盖及进程环境，具体优先级由 helper 决定。
import { getProviderEnvValue } from "../utils/provider-env.ts";
// 只对建立 HTTP 请求做可取消退避重试，不回放已经开始消费的响应流。
import { retryProviderRequest } from "../utils/provider-retry.ts";
// 清理孤立 UTF-16 代理码元，不摘要/翻译原文字。
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
// 工具 JSON 分片用增量容错预览，块结束后另做完整对象解析。
import { ToolCallArgumentsStream } from "../utils/streaming-json.ts";
// 初始系统正文和后续系统更新有不同渲染规则。
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
// 历史系统消息有工具声明/变更，这组 helper 规范化并计算当前活动工具。
import {
	getCurrentTools,
	getInitialSystemMessage,
	resolveTranscript,
	type TranscriptContext,
} from "../utils/transcript.ts";

// strict schema 转换及限额识别共用约束工具；prefer 可降级而 require 不能被此次降级关闭。
import {
	getJsonSchemaToolParameters,
	isStrictToolLimitErrorMessage,
	prefersJsonSchemaStrictSampling,
	resolveJsonSchemaStrictSampling,
	type UnsupportedStrictSchemaKeywordCheck,
} from "./constrained-sampling.ts";
// Copilot 的图像和发起方动态头根据会话推导。
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
// 简单选项适配会调整思考预算和回答上限，但不是精确 tokenizer 计数器。
import { adjustMaxTokensForThinking, buildBaseOptions, clampMaxTokensToContext } from "./simple-options.ts";
// 跨模型历史先处理思考/调用 id；错误工具结果的图片另拆到结果之后。
import { splitErrorToolResultImages, transformMessages } from "./transform-messages.ts";

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
/**
 * 解析逻辑缓存偏好，返回 none/short/long，无状态修改或网络。
 * 显式值优先→环境精确 long→默认 short；例显式 none 覆盖 PI_CACHE_RETENTION=long。
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	// 显式 none/short/long 均优先，都是非空字符串。
	if (cacheRetention) {
		// 直接返回显式偏好，不再被环境覆盖。
		return cacheRetention;
	}
	// 只有环境字符串精确为 long 才改变缺省偏好。
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		// 返回逻辑长期偏好，具体 ttl 还看供应商能力。
		return "long";
	}
	// 其余情况默认 short。
	return "short";
}

/**
 * 把缓存偏好和模型能力转成断点配置，返回 {retention,cacheControl?}，不创建真实缓存。
 * none 只返回偏好，其他 ephemeral，long 且支持长期时加 ttl:1h；例不支持长期时 long 仍保留，但标记不带 ttl。
 */
function getCacheControl(
	// 模型决定长期缓存兼容能力，不在此访问服务端。
	model: Model<"anthropic-messages">,
	// 可选缓存偏好，? 允许调用省略参数。
	cacheRetention?: CacheRetention,
	// 可选请求环境覆盖，缺省由共享环境 helper 回退。
	env?: ProviderEnv,
	// 返回对象始终带 retention，可选 cacheControl；这是配置，不是真缓存实例。
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
	// 先统一解析显式选项/环境/default。
	const retention = resolveCacheRetention(cacheRetention, env);
	// none 不创建缓存断点配置。
	if (retention === "none") {
		// 仅返回逻辑选择，不带 cacheControl 属性。
		return { retention };
	}
	// 只有 long 且允许长期缓存时加 1h，否则不写 ttl 使用服务端默认。
	const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
	// 创建本次缓存选项结果对象。
	return {
		// 属性简写保留解析后的偏好。
		retention,
		// 条件对象展开只在 ttl 真值时带该字段，标记固定 ephemeral；不保证缓存命中。
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

// Stealth mode: Mimic Claude Code's tool naming exactly
// OAuth 请求分支固定使用这个兼容身份版本字符串，不检测本机 Claude Code 版本。
const claudeCodeVersion = "2.1.280";

// Claude Code 2.x tool names (canonical casing)
// Source: https://cchistory.mariozechner.at/data/prompts-2.1.11.md
// To update: https://github.com/badlogic/cchistory
// 这些是名称大小写的兼容映射表，不是在这里注册/实现对应工具。
const claudeCodeTools = [
	// read 映射为 Read。
	"Read",
	// write 映射为 Write。
	"Write",
	// edit 映射为 Edit。
	"Edit",
	// bash 映射为 Bash。
	"Bash",
	// grep 映射为 Grep。
	"Grep",
	// glob 映射为 Glob。
	"Glob",
	// 交互提问工具名的规范大小写。
	"AskUserQuestion",
	// 进入计划模式工具名。
	"EnterPlanMode",
	// 退出计划模式工具名。
	"ExitPlanMode",
	// 结束 shell 工具名。
	"KillShell",
	// Notebook 编辑工具名。
	"NotebookEdit",
	// 技能工具名。
	"Skill",
	// 任务工具名。
	"Task",
	// 任务输出工具名。
	"TaskOutput",
	// 待办写入工具名。
	"TodoWrite",
	// 网页获取工具名。
	"WebFetch",
	// 网页搜索工具名；存在映射不代表本次模型一定可用该工具。
	"WebSearch",
];

// map 生成 [小写名,规范名] 二元项，再构造 Map；相同键后写覆盖。
const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

// Convert tool name to CC canonical casing if it matches (case-insensitive)
/**
 * 将已知工具名转为 Claude Code 规范拼写，返回字符串，不注册/执行工具。
 * 查小写键，不命中原样保留；例 read→Read，自定义 inspect_repo 保持 inspect_repo。
 */
// ?? 仅查不到时回退原名，未知自定义工具不会强行首字母大写。
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
/**
 * 把模型返回名恢复为当前工具声明里的拼写，返回字符串，不改声明。
 * 当前工具按不区分大小写 find 首个匹配；例返回 Read、声明 read 则返回 read，已移除/不存在时保留 Read。
 */
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	// 仅有非空当前工具集合才尝试恢复调用方原始拼写。
	if (tools && tools.length > 0) {
		// 把返回工具名小写作比较，不改名称值本身。
		const lowerName = name.toLowerCase();
		// find 命中第一个不区分大小写同名工具，不处理同名歧义。
		const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
		// 找到就采用用户声明的原始名称。
		if (matchedTool) return matchedTool.name;
	}
	// 未找到则保留返回名，包括已经移除工具的历史名字。
	return name;
};

/**
 * 把统一图片块转 Anthropic base64 图片段，返回新对象，不改输入、不解码图片。
 * 使用 mimeType/data，MIME 以断言适配 SDK 联合；例 image/png 的 base64 原样进入 source，断言不会转格式。
 */
function convertImageBlock(image: ImageContent) {
	// 新建协议图片对象，不改输入图片块。
	return {
		// as const 把标签静态限定为 image，不冻结对象。
		type: "image" as const,
		// 图片通过 source 对象表达。
		source: {
			// 数据来源固定 base64；不是发一个外部 URL。
			type: "base64" as const,
			// as 把 MIME 声称为 SDK 允许的四种之一，实际不校验/转换图片格式。
			media_type: image.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
			// 复用已有 base64 字符串，不下载、解码或压缩。
			data: image.data,
		},
	};
}

/**
 * Convert content blocks to Anthropic API format
 */
/**
 * 把工具结果的文字/图片块转为 Anthropic 正文，返回字符串或新段数组，不发请求。
 * 无图片时单换行连接文字；有图片时逐块转换，完全没有文字段才在最前加占位。例 [图,图]→[说明,图,图]，空文字段也算已有文字。
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]): // 返回联合的一支是合并后的纯文字字符串。
	| string
	// 有图时返回正文段数组。
	| Array<
			// 数组元素可以是文字段。
			| { type: "text"; text: string }
			// 或是下面结构的图片段。
			| {
					// 图片判别标签。
					type: "image";
					// 图片数据源嵌套结构。
					source: {
						// 数据源标签只能是 base64。
						type: "base64";
						// 静态 MIME 字面量联合，不表示运行时已验证。
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						// base64 数据用字符串表示。
						data: string;
					};
			  }
	  > {
	// If only text blocks, return as concatenated string for simplicity
	// 只要任一块是 image，就选择数组协议形式。
	const hasImages = content.some((c) => c.type === "image");
	// 没有图片时按类型约定全部是文字。
	if (!hasImages) {
		// 文字用单换行连接并清理孤立代理码元；空数组得到空串，不自动加占位。
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// If we have images, convert to content block array
	/**
	 * 转换一个工具结果正文块为协议文字/图片段，返回新对象，无外部修改。
	 * 例文字先清理孤立代理码元，图片交 convertImageBlock 直接包装已有 base64。
	 */
	// 有图片时逐块转新协议对象，保持相对顺序。
	const blocks = content.map((block) => {
		// type 字段让 TS 缩窄为文字块。
		if (block.type === "text") {
			// 创建 SDK 文字段。
			return {
				// as const 保持 text 字面量类型。
				type: "text" as const,
				// 清理孤立代理码元，空文字也保留。
				text: sanitizeSurrogates(block.text),
			};
		}
		// 其余按联合约定是图片，复用统一图片转换。
		return convertImageBlock(block);
	});

	// If only images (no text), add placeholder text block
	// 只看是否存在文字段，不检查其正文是否为空/纯空白。
	const hasText = blocks.some((b) => b.type === "text");
	// 纯图片集合才加说明段。
	if (!hasText) {
		// unshift 将新说明插在所有图片之前。
		blocks.unshift({
			// 说明段类型 text。
			type: "text" as const,
			// 固定占位说明，不把它当真实工具输出。
			text: "(see attached image)",
		});
	}

	// 返回新数组；已有图片数据字符串仍复用，不做深层数据重编码。
	return blocks;
}

// 原生 effort 联合不含 off/minimal；统一层另作映射，映射字符串的 as 不是远端校验。
export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

// 本公开配置只暴露两种展示方式，安装 SDK 的其他字面量不因此自动开放。
export type AnthropicThinkingDisplay = "summarized" | "omitted";

// 旧服务的细粒度工具输入流 beta 标识，按能力条件发送。
const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
// 非 adaptive 思考交错流 beta 标识，是否请求由选项/模型条件决定。
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
// 有允许后备模型列表时请求服务器 fallback beta。
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";
// 历史 system.output_config 思考档位更新协议标识。
const MID_CONVERSATION_OUTPUT_CONFIG_BETA = "mid-conversation-output-config-2026-07-01";
// 允许请求思考块前缀绑定失败处理的协议标识。
const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";
// 按值在历史新增工具定义的协议标识。
const INLINE_TOOLS_BETA = "inline-tools-2026-09-15";

/**
 * Stable deferred tool declared whenever native tool changes are in use. Anthropic adds
 * hidden prompt scaffolding for mid-conversation tool changes; declaring this placeholder
 * from the first request keeps that scaffolding in the cached prefix, so the first tool
 * change does not invalidate the cache (measured: full miss without it). It is never
 * activated and the model cannot see it.
 */
// 固定 deferred 占位声明用于稳定原生工具变更的请求前缀；本文件不主动激活它，实际隐藏/缓存行为依远端协议。
const DEFERRED_TOOL_PLACEHOLDER: BetaTool = {
	// 占位工具名固定，不从用户工具动态生成。
	name: "__pi_deferred_placeholder__",
	// 描述保留原文，提示模型不要调用；文案本身不是本地授权检查。
	description: "Reserved placeholder. Never available. Never call this.",
	// 空对象参数 schema，无业务处理实现。
	input_schema: { type: "object", properties: {}, required: [] },
	// 声明延迟加载，初始工具列表仍需至少一个真实活动工具来启用这条路径。
	defer_loading: true,
};

/**
 * 判断是否请求 server-side fallback beta，返回 boolean，无副作用。
 * 仅看 allowedFallbackModels 是否非空；例列表有一项即 true，不检验后备模型能否访问。
 */
function shouldUseServerSideFallbackBeta(model: Model<"anthropic-messages">): boolean {
	// 只看列表长度是否大于 0，不验证后备模型存在、权限或可用性。
	return (model.compat?.allowedFallbackModels?.length ?? 0) > 0;
}

/**
 * 按模型显式兼容字段补本地默认能力，返回新对象，不探测服务器。
 * ?? 保留 false，OpenRouter 由供应商名/URL 子串判断；例 strict 默认 false，而 eager 工具输入默认 true。
 */
function getAnthropicCompat(model: Model<"anthropic-messages">) {
	// 供应商名或 URL 子串识别 OpenRouter，不解析 hostname 或验证域名归属。
	const isOpenRouter = model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");
	// 返回新的顶层能力对象，各字段保留显式 false；不是远端能力探测。
	return {
		// 默认对每个工具启用 eager_input_streaming。
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
		// 默认允许长期缓存 ttl 请求。
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		// 自动亲和头默认只对识别到的 OpenRouter 启用。
		sendSessionAffinityHeaders: model.compat?.sendSessionAffinityHeaders ?? isOpenRouter,
		// 默认 OpenRouter 用专属格式，其他服务未指定格式；发送开关与格式分开。
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? (isOpenRouter ? "openrouter" : undefined),
		// 默认可给最后工具声明加 cache_control。
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? true,
		// 默认允许温度字段，但后面思考/管理档位条件还会限制它。
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		// 默认不把缺签名思考保留为原生 thinking，可能转普通文字。
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
		// strict 工具默认关闭，兼容 Anthropic 并不自动推定支持 strict。
		supportsStrictTools: model.compat?.supportsStrictTools ?? false,
		// 默认不保留中途系统消息协议能力，规范化层会折叠。
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		// 原生工具新增/移除能力也默认关闭，须另与系统支持/初始工具组合。
		supportsMidConvoToolChanges: model.compat?.supportsMidConvoToolChanges ?? false,
	};
}

// 接口扩展公共流选项，仅作开发期类型检查，不创建运行时类。
export interface AnthropicOptions extends StreamOptions {
	/**
	 * Enable extended thinking.
	 * For adaptive thinking models: the model decides when/how much to think.
	 * For older models: uses budget-based thinking with thinkingBudgetTokens.
	 * Default: undefined (thinking is omitted unless `streamSimple()` maps
	 * a simple reasoning level to this option, or callers set it explicitly).
	 */
	// true 请求开启、false 可显式关闭、undefined 允许省略；管理档位路径有独立开关，不能一概说 undefined 总省略。
	thinkingEnabled?: boolean;
	/**
	 * Token budget for extended thinking (older models only).
	 * Ignored for adaptive thinking models.
	 * Default: 1024 when `thinkingEnabled` is true and no budget is provided.
	 */
	// 预算仅用于 enabled 旧式思考；原生构建用 || 1024，0 也会回退 1024，不在此保证始终小于 max_tokens。
	thinkingBudgetTokens?: number;
	/**
	 * Effort level for adaptive thinking models.
	 * Controls how much thinking Claude allocates:
	 * - "max": Always thinks with no constraints (Opus 4.6 only)
	 * - "xhigh": Highest reasoning level (Opus 4.7+, Fable 5)
	 * - "high": Always thinks, deep reasoning
	 * - "medium": Moderate thinking, may skip for simple queries
	 * - "low": Minimal thinking, skips for simple tasks
	 * Ignored for older models.
	 * Default: omitted unless `streamSimple()` maps a simple reasoning
	 * level to this option.
	 */
	// adaptive effort 可省略；管理档位模式当前档位未设默认 high，与普通 adaptive 直接省略不同。
	effort?: AnthropicEffort;
	/**
	 * Controls how thinking content is returned in API responses.
	 * - "summarized": Thinking blocks contain summarized thinking text.
	 * - "omitted": Thinking blocks return an empty thinking field; the encrypted
	 *   signature still travels back for multi-turn continuity. Use for faster
	 *   time-to-first-text-token when your UI does not surface thinking.
	 *
	 * Note: Anthropic's API default for Claude Opus 4.7 and Claude Mythos Preview
	 * is "omitted". We default to "summarized" here to keep behavior consistent
	 * with older Claude 4 models. Set this explicitly to "omitted" to opt in.
	 * Default: "summarized" when thinking is enabled.
	 */
	// 展示偏好不决定是否启用思考；启用相关路径缺省用 summarized，签名仍用于回放。
	thinkingDisplay?: AnthropicThinkingDisplay;
	/**
	 * Whether to request the interleaved thinking beta header for non-adaptive
	 * thinking models. Adaptive thinking models have interleaved thinking built in,
	 * so the header is skipped for them regardless of this setting.
	 * Default: true.
	 */
	// 默认 true 请求旧 interleaved beta；forceAdaptiveThinking=true 时不自动加这个 beta。
	interleavedThinking?: boolean;
	/**
	 * Anthropic tool choice behavior. String values map to Anthropic's built-in
	 * choices; `{ type: "tool", name }` forces a specific tool.
	 * Default: omitted (Anthropic default behavior, currently equivalent to auto).
	 */
	// 字符串稍后转 {type:...}，对象原样透传；此字段不在这里决定本地工具权限。
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/**
	 * Pre-built Anthropic client instance. When provided, skips internal client
	 * construction entirely. Use this to inject alternative SDK clients such as
	 * `AnthropicVertex` that shares the same messaging API.
	 */
	// 直接注入客户端会跳过本文件内部认证/头/亲和构造，并固定 isOAuth=false；但仍构建 payload 和执行钩子/解析流。
	client?: Anthropic;
}

/**
 * 按顺序浅合并若干可选请求头记录，返回新对象，不改来源对象。
 * 后写同名 JS 属性覆盖、null 也保留；例 {A:"x"} 后接 {A:null} 得 A:null，最终 HTTP 头归一化由 SDK 处理。
 */
function mergeHeaders(...headerSources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	// rest 参数收集多个候选头对象，先新建结果，避免改输入顶层。
	const merged: ProviderHeaders = {};
	// 按入参顺序遍历来源。
	for (const headers of headerSources) {
		// undefined 来源跳过，空对象真值仍可合并。
		if (headers) {
			// 同名属性后写覆盖，保留 null 删除标记；本层按 JS 键大小写区分，不进行 HTTP 名称规范化。
			Object.assign(merged, headers);
		}
	}
	// 返回合并记录，SDK 后面再按其头规则处理。
	return merged;
}

/**
 * 检查给定头对象是否有指定非空头，返回 boolean，无副作用。
 * 忽略名字大小写，排除 null 和纯空白值；例 Authorization:"Bearer x" 命中，不验证 token 有效性。
 */
function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	// 参数类型允许 undefined，未提供候选就返回 false。
	if (!headers) return false;
	// 比较目标名转小写。
	const expected = name.toLowerCase();
	// 迭代自有可枚举头属性并解构键值。
	for (const [key, value] of Object.entries(headers)) {
		// 名字匹配且值非 null、trim 后非空即存在，不验证 token。
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	// 没找到则 false。
	return false;
}

/**
 * 检查请求是否已有本适配认可的认证来源，返回 boolean，不读取凭证文件/模型头。
 * 非空 key 或 Authorization/X-Api-Key/CF 网关头任一存在即 true；例只有显式 Bearer 头也能通过本地前置检查。
 */
function hasRequestAuth(apiKey: string | undefined, headers: ProviderHeaders | undefined): boolean {
	// 任一来源存在即可；|| 会短路后续检查。
	return (
		// 非空 key 即视作有认证来源，空白串仍是真值。
		!!apiKey ||
		// 普通 Bearer 授权头。
		hasHeader(headers, "authorization") ||
		// Anthropic 原生 API key 头。
		hasHeader(headers, "x-api-key") ||
		// Cloudflare 网关授权头；检查它存在不保证安装 SDK 的其他头验证一定通过。
		hasHeader(headers, "cf-aig-authorization")
	);
}

/**
 * 要求请求提供一种认证来源，正常返回 void，否则同步抛缺 key 错误，无网络。
 * 例 apiKey 未给但 headers.x-api-key 非空可通过；这里只是存在性检查，不代表 SDK/服务器必然接受。
 */
function assertRequestAuth(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): void {
	// 缺少本函数识别的认证来源才抛；不查 model.headers/凭证存储，也不验证有效期。
	if (!hasRequestAuth(apiKey, headers)) throw new Error(`No API key for provider: ${provider}`);
}

/**
 * Anthropic SDK client that never runs the SDK's own credential chain
 * (ANTHROPIC_PROFILE config files, federation env vars). Without this, every
 * client built with `apiKey: null, authToken: null` for header-owned auth would
 * also resolve and exchange SDK credentials behind pi's auth resolver.
 */
// 继承 SDK 并仅覆盖默认凭证发现钩子；显式 config 联邦认证仍可由 SDK 处理。
class PiAnthropic extends Anthropic {
	/**
	 * 覆盖 SDK 默认凭证发现选择，始终返回 false，无状态修改。
	 * 例仅由显式 Authorization 管认证时不再自动启动 SDK 默认凭证链；显式 config 分支不受该返回值禁止。
	 */
	// protected 仅限制 TS 访问范围，override 检查基类确有同名方法；不是 # 字段的运行时隔离。
	protected override _shouldResolveDefaultCredentials(): boolean {
		// 告诉 SDK 不启用默认 profile/环境凭证链，调用方显式传 null 的 key/token 不会触发该默认链。
		return false;
	}
}

// 索引访问取 SDK config 类型，NonNullable 去掉 null/undefined；不在运行时校验配置对象。
type AnthropicFederationConfig = NonNullable<ClientOptions["config"]>;

/**
 * Workload identity federation config from the ANTHROPIC_* variables the
 * Anthropic SDK documents; the SDK performs the token exchange and refresh.
 * Only for the anthropic provider, since the exchange is an Anthropic API
 * endpoint, and only when no key or auth header was resolved.
 */
/**
 * 根据模型/显式认证/环境决定是否构造联邦认证配置，返回对象或 undefined，不读令牌文件、不交换 token。
 * 只对 anthropic 且无现有认证；要求规则 id、组织 id、令牌文件路径，工作区/服务账户可选。例提供三项环境后交 SDK 后续读取文件并认证。
 */
function getAnthropicFederation(
	// 只针对 provider 精确 anthropic 的模型选择联邦配置。
	model: Model<"anthropic-messages">,
	// 显式 key 来源优先于联邦环境。
	apiKey: string | undefined,
	// 同样识别显式授权头，不检查模型默认头。
	headers: ProviderHeaders | undefined,
	// 请求环境可覆盖联邦变量；可传 undefined 回退共享环境读取。
	env: ProviderEnv | undefined,
	// 缺少前提时返回 undefined，不创建 SDK 或读取令牌文件。
): AnthropicFederationConfig | undefined {
	// 其他供应商或已有认证来源都不自动使用联邦配置。
	if (model.provider !== "anthropic" || hasRequestAuth(apiKey, headers)) return undefined;
	// 读取联邦规则 id 文字。
	const federationRuleId = getProviderEnvValue(ANTHROPIC_FEDERATION_RULE_ID_ENV, env);
	// 读取组织 id 文字。
	const organizationId = getProviderEnvValue(ANTHROPIC_ORGANIZATION_ID_ENV, env);
	// 这里只读取身份令牌文件路径字符串，尚未打开该文件。
	const identityTokenFile = getProviderEnvValue(ANTHROPIC_IDENTITY_TOKEN_FILE_ENV, env);
	// 三项都需真值；空白文字也是真值，不额外 trim/验证文件存在。
	if (!federationRuleId || !organizationId || !identityTokenFile) return undefined;
	// 创建 SDK 显式配置，实际交换与刷新由 SDK 在使用时处理。
	return {
		// 组织字段使用已选值。
		organization_id: organizationId,
		// 工作区可缺省，不是此函数的必需前提。
		workspace_id: getProviderEnvValue(ANTHROPIC_WORKSPACE_ID_ENV, env),
		// 嵌套认证配置容器。
		authentication: {
			// 判别类型选 oidc_federation。
			type: "oidc_federation",
			// 传联邦规则 id，不验证对应规则已存在。
			federation_rule_id: federationRuleId,
			// 服务账户字段可省略，读取环境候选。
			service_account_id: getProviderEnvValue(ANTHROPIC_SERVICE_ACCOUNT_ID_ENV, env),
			// 文件来源描述由 SDK 后续读取；本函数不保证路径可信/可访问。
			identity_token: { source: "file", path: identityTokenFile },
		},
	};
}

/**
 * The SDK caches the federated access token per client, but pi creates a client
 * per request. Keep one client for the current federation config and fetch, and
 * clone it per request with `withOptions()`, which shares the token cache.
 */
// 模块只保留最近一组 key/fetch/client；切换配置会替换这一个条目，不是无限多用户缓存表。
let federationClient: { key: string; fetch: typeof globalThis.fetch | undefined; client: Anthropic } | undefined;

// 本地解码出的一个 SSE 事件，不是已验证的 Anthropic 业务事件。
interface ServerSentEvent {
	// event 字段可不存在，用 null 表示未指定名字。
	event: string | null;
	// 多个 data 行用换行连接后的文字，之后才尝试 JSON 解析。
	data: string;
	// 保存原始非空行便于解析失败诊断，不做内容脱敏。
	raw: string[];
}

// 跨行累积的 SSE 工作状态，会在有效事件 flush 后重置。
interface SseDecoderState {
	// 同一个事件里后来的 event 行覆盖先前名字。
	event: string | null;
	// 保留各 data 行，不立即 JSON.parse。
	data: string[];
	// 原始行数组可能包含 SSE 注释/未知字段，便于诊断。
	raw: string[];
}

// ReadonlySet 仅限制静态接口，运行时未冻结 Set；仅这些 SSE 名称会进入 JSON 事件解析。
const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	// 消息开始 SSE 名称。
	"message_start",
	// 消息状态/用量更新名称。
	"message_delta",
	// 消息结束名称；真正完整性检查还看 JSON 的 type。
	"message_stop",
	// 内容块开始名称。
	"content_block_start",
	// 内容块增量名称。
	"content_block_delta",
	// 内容块结束名称；ping 等未知名称跳过，error 在前面独立失败处理。
	"content_block_stop",
]);

/**
 * 从 SSE 工作状态提取一个事件并在有效输出时清空状态，返回事件或 null，会修改 state。
 * 数据行以单换行合并，raw 浅复制；例 event:text+两条 data 得一个合并正文，无 event/data 时不输出且不清 raw。
 */
function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	// 没有真值事件名、也没有 data 行时，不产生事件；只有 raw 行仍会被保留到后续有效 flush。
	if (!state.event && state.data.length === 0) {
		// 返回 null 表示当前无可输出事件，不清空此分支状态。
		return null;
	}

	// 创建已经分组好的 SSE 事件对象，还没有解析 JSON。
	const event: ServerSentEvent = {
		// 保留最后看到的事件名，可为 null。
		event: state.event,
		// 同事件多条 data 行按 SSE 规则用真实换行连接。
		data: state.data.join("\n"),
		// 数组展开浅复制 raw，后面清状态不影响此数组。
		raw: [...state.raw],
	};
	// 清事件名，准备下一事件。
	state.event = null;
	// 换新的 data 数组，不清空已经返回的正文字符串。
	state.data = [];
	// 换新的 raw 数组，旧 raw 副本已交结果。
	state.raw = [];
	// 返回本次事件对象。
	return event;
}

/**
 * 消费一条不含行尾的 SSE 行，返回事件或 null，会累积/清空给定状态，不解析业务 JSON。
 * 空行 flush；冒号注释仅记 raw；event 覆盖、data 累积，其他字段只保留 raw。例 data: a:b 保留 a:b，值只去一个前导空格。
 */
function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	// 空行是事件边界；行内仅有空格不会按空行处理。
	if (line === "") {
		// 委托 flush，可能返回事件或 null。
		return flushSseEvent(state);
	}

	// 每条非空原始行都保存，包含注释及不识别字段。
	state.raw.push(line);
	// 冒号开头是 SSE 注释，不贡献 event/data。
	if (line.startsWith(":")) {
		// 只保留 raw，不向上产出事件。
		return null;
	}

	// 只找首个冒号，后续冒号仍属于字段值。
	const delimiterIndex = line.indexOf(":");
	// 没有冒号时整行当字段名，值按下面规则为空。
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	// let 因后面可能去掉恰好一个前导空格；没有冒号则空串。
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	// SSE 字段值最多去一个普通空格，不 trim 两端。
	if (value.startsWith(" ")) {
		// slice(1) 只去第一个空格，其他空白保留。
		value = value.slice(1);
	}

	// event 字段后值覆盖本事件前一个名字。
	if (fieldName === "event") {
		// 即使值为空串也写入，flush 按真值判断名字是否有效。
		state.event = value;
		// data 字段可多行累积。
	} else if (fieldName === "data") {
		// push 保留空 data 行，其存在使 state.data.length>0。
		state.data.push(value);
	}

	// 普通字段行只累积，等空行或 EOF 才产出事件；id/retry 不在这里实现。
	return null;
}

/**
 * 找文字中最早 CR 或 LF 索引，返回数字或 -1，纯函数不修改输入。
 * 例 a\r\nb 返回 1；这里只找第一个行尾字符，CRLF 合并由 consumeLine 处理。
 */
function nextLineBreakIndex(text: string): number {
	// 分别查 CR 和 LF 的最早索引，找不到时为 -1。
	const carriageReturnIndex = text.indexOf("\r");
	// LF 单独查找以兼容单字符换行。
	const newlineIndex = text.indexOf("\n");
	// 没有 CR 时结果由 LF 决定。
	if (carriageReturnIndex === -1) {
		// 可能返回 -1，表示都没有行分隔符。
		return newlineIndex;
	}
	// 有 CR 没 LF 时用 CR。
	if (newlineIndex === -1) {
		// 返回 CR 索引。
		return carriageReturnIndex;
	}
	// 两者都有取更前者，不把整个 CRLF 当两次完整搜索。
	return Math.min(carriageReturnIndex, newlineIndex);
}

/**
 * 切出当前文字的一行和余串，返回 {line,rest} 或 null，无副作用。
 * 优先最早 CR/LF，若同一缓冲内是 CRLF 则一起消费；例 a\r\nb→a/b。末尾 CR 会立即消费，不额外等待跨字节块的 LF。
 */
function consumeLine(text: string): { line: string; rest: string } | null {
	// 复用统一查行尾逻辑，不改输入字符串。
	const lineBreakIndex = nextLineBreakIndex(text);
	// 没有任何完整行分隔符时等待更多字节。
	if (lineBreakIndex === -1) {
		// 返回 null，不把半行提前当完整字段。
		return null;
	}

	// 默认跨过一个 CR 或 LF。
	let nextIndex = lineBreakIndex + 1;
	// 只有当前文本里相邻 CRLF 都已到达才合并消费。
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		// 多跨过 LF；若 CR 在本字节块末尾则不会等待下一块的 LF，保留当前实现边界。
		nextIndex += 1;
	}

	// 返回切出的行及剩余文字，不在这里改变 SSE 状态。
	return {
		// 正文不含行结束符。
		line: text.slice(0, lineBreakIndex),
		// 余下内容从行尾之后继续。
		rest: text.slice(nextIndex),
	};
}

/**
 * 把响应字节流变成 SSE 事件异步生成器，输入 body 和可选信号，会读流、持有 reader 锁，正常/错误/提前结束时释放锁。
 * 按 UTF-8 流解码→逐行累积→空行出事件→EOF 刷尾；例 data 跨字节块会先留文本尾部，缺最终空行也可 flush。
 * 只在 read 前检查取消，不能独立打断已经等待中的 read；finally 只 releaseLock，不承诺取消底层传输。
 */
async function* iterateSseMessages(
	// 标准 Web ReadableStream，字节块大小与文本行边界不必对应。
	body: ReadableStream<Uint8Array>,
	// 可选信号仅在每次 reader.read 前检查；没有在此注册 abort 监听。
	signal?: AbortSignal,
	// AsyncGenerator 允许 for await 逐个取得 SSE 事件，不会一次读完整响应。
): AsyncGenerator<ServerSentEvent> {
	// 独占响应体的 reader 锁；并不是复制一份响应流。
	const reader = body.getReader();
	// 默认 UTF-8 TextDecoder，stream 模式可跨字节块保留未完成字符。
	const decoder = new TextDecoder();
	// 本次迭代独立 SSE 工作状态，不跨请求复用。
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	// 累积尚未处理的文本尾部；let 允许每次改为剩余部分。
	let buffer = "";

	// 正常、失败或消费者结束迭代时都进入 finally 释放锁。
	try {
		// 无限循环由流 done 或异常退出。
		while (true) {
			// 读前检查已取消，不能仅靠此检查打断一个已经挂起的 read。
			if (signal?.aborted) {
				// 固定取消文字，真正输出分类由外层 signal.aborted 决定。
				throw new Error("Request was aborted");
			}

			// await 等待下一字节块；解构出内容和 EOF 标志。
			const { value, done } = await reader.read();
			// done 说明底层字节流结束，随后仍需处理 decoder/文本尾部。
			if (done) {
				// 退出读循环，不提前跳过尾部 flush。
				break;
			}

			// 只解码这次字节并追加；stream:true 保留未完整 UTF-8 字符。
			buffer += decoder.decode(value, { stream: true });
			// 尝试从累积文本取出一行。
			let consumed = consumeLine(buffer);
			// 一字节块可能含多行，所以反复消费到没有完整行。
			while (consumed) {
				// 用剩余文字替换缓冲，不重复扫描已消费正文。
				buffer = consumed.rest;
				// 一行送入 SSE 状态机，可能在空行时产出事件。
				const event = decodeSseLine(consumed.line, state);
				// 有事件才向消费者输出，null 表示继续累积。
				if (event) {
					// yield 暂停生成器，等消费者要下一项再推进。
					yield event;
				}
				// 尝试当前剩余缓冲中的下一行。
				consumed = consumeLine(buffer);
			}
		}

		// EOF 时无参数 decode() 刷出 decoder 内部尾部；默认非 fatal，坏 UTF-8 可成为替换字符。
		buffer += decoder.decode();
		// 解码尾部后再提取完整行。
		let consumed = consumeLine(buffer);
		// 逐行耗尽最后一段完整行内容。
		while (consumed) {
			// 更新尚未处理的尾部字符串。
			buffer = consumed.rest;
			// 最后阶段仍使用同一 SSE 字段规则。
			const event = decodeSseLine(consumed.line, state);
			// 只有实际事件才 yield。
			if (event) {
				// 交最后解码阶段形成的事件。
				yield event;
			}
			// 继续提取剩余行。
			consumed = consumeLine(buffer);
		}

		// 没有行尾但有剩余文字时也按最后一行处理。
		if (buffer.length > 0) {
			// 末行可能是 data/event/注释等，不必以空行结尾。
			const event = decodeSseLine(buffer, state);
			// 若末行本身产出事件则输出；普通非空字段通常只累积。
			if (event) {
				// 交出该事件。
				yield event;
			}
		}

		// 最后强制 flush，接受缺最后空行的事件，不要求严格 SSE 终止分隔。
		const trailingEvent = flushSseEvent(state);
		// 确有事件再输出。
		if (trailingEvent) {
			// 最后一项之后迭代自然结束。
			yield trailingEvent;
		}
		// finally 包含失败/正常完成/消费者 return 路径。
	} finally {
		// 只释放 reader 锁，没有调用 reader.cancel/body.cancel；传输取消还要依 SDK/fetch 的 signal。
		reader.releaseLock();
	}
}

/**
 * 从原始 Response 读取本地解码的 Anthropic 事件，返回异步生成器，不发新请求。
 * 要求有 body；error SSE 立即失败，未知名称忽略，已知名称解析/有限修复 JSON 并跟踪 start/stop。例 ping 不进入业务回调。
 * 泛型不是 schema 校验，SSE event 名与 JSON type 未核对；只见 start 无 stop 才在 EOF 拒绝，外层另检查 stopReason。
 */
async function* iterateAnthropicEvents(
	// 输入是 SDK asResponse 给出的原始 Response，体还未按 SDK 流解析。
	response: Response,
	// 同一取消信号交字节读取 helper。
	signal?: AbortSignal,
	// 返回声明为 SDK 事件的异步生成器；该静态类型不是 schema 校验器。
): AsyncGenerator<RawMessageStreamEvent> {
	// HTTP 响应可能没有 body，先给明确错误。
	if (!response.body) {
		// 此错误由外层真实请求入口转换成失败事件。
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	// 标记是否见过 JSON type=message_start。
	let sawMessageStart = false;
	// 标记是否见过 JSON type=message_stop，不记录严格的事件状态顺序。
	let sawMessageEnd = false;

	// 逐个消费本地 SSE 解码器输出，未知协议事件可被跳过。
	for await (const sse of iterateSseMessages(response.body, signal)) {
		// SSE 名称恰为 error 时立即失败，不把正文作为普通消息处理。
		if (sse.event === "error") {
			// 原样 data 变成错误文字，不在此解析 error 对象/脱敏。
			throw new Error(sse.data);
		}

		// 先按 SSE event 名白名单过滤，缺名字按空串处理。
		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			// ping、done、代理统计等未知名称忽略，不尝试 JSON.parse。
			continue;
		}

		// JSON 解析及此 try 内的处理错误附上下文后重抛。
		try {
			// 先标准 JSON 后有限字符串修复；泛型只声明类型，不验证对象字段或 SSE 名与 JSON type 相符。
			const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
			// 开始/结束判定依据 JSON type，而非仅依 SSE 名。
			if (event.type === "message_start") {
				// 见过开始之后，EOF 才会额外要求有结束标志。
				sawMessageStart = true;
				// message_stop 只置标志，不立即 break，后续白名单事件仍可继续产出。
			} else if (event.type === "message_stop") {
				// 只记存在结束，不校验每个内容块都已 close。
				sawMessageEnd = true;
			}
			// 把解析值交外层，外层逐字段处理；此处没有完整业务 schema 验证。
			yield event;
			// 捕获此 try 范围内的异常，不把未知事件忽略当失败。
		} catch (error) {
			// Error 取 message，其他值用 String 转文字。
			const message = error instanceof Error ? error.message : String(error);
			// 重新创建错误加入事件名及原始文本，外层可显示诊断。
			throw new Error(
				// raw 用字面反斜杠+n 连接，不是每行真正换行；包含完整原数据，未承诺去敏。
				`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
			);
		}
	}

	// 仅见过 start 却没见 stop 才在这里认定截断；没见 start 不由此条件拒绝。
	if (sawMessageStart && !sawMessageEnd) {
		// 真正外层还会独立要求 stopReason，两个检查不等于严格验证全部协议顺序。
		throw new Error("Anthropic stream ended before message_stop");
	}
}

/**
 * 发起一轮 Anthropic Messages 请求，同步返回统一事件流；输入模型、完整会话及选项，可注入已有 SDK client。
 * 流程：规范化/工具→认证/客户端→参数与钩子→网络重试及至多一次 prefer strict 降级重建→取 HTTP 响应→自有 SSE/块处理→done/error。
 * 会发网络、调用钩子、更新本轮 output；例两片 input_json_delta 先给预览，在 content_block_stop 完整解析工具参数，上层才负责执行工具/下一轮。
 * 同步历史处理在 try 之外；通常在 catch 中保留已知用量/部分内容并转 error，不补齐所有未结束块或重放 SSE；非 Error 抛出值的序列化仍可能再次失败。
 */
export const stream: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	// 泛型限定模型为 Anthropic Messages API，静态检查不探测服务器。
	model: Model<"anthropic-messages">,
	// 输入完整会话，包含系统/工具变更而不只是当前 query。
	context: TranscriptContext,
	// 专用配置可以包括直接注入 SDK client。
	options?: AnthropicOptions,
	// 函数同步返回事件流，网络任务由内部 async 闭包推进。
): AssistantMessageEventStream => {
	// 先建立本地事件通道，消费者不用等 HTTP 返回。
	const stream = new AssistantMessageEventStream();
	// 按兼容能力规范化/折叠中途系统消息；这个同步调用在下方 try/catch 之外。
	const normalizedContext = resolveTranscript(context, getAnthropicCompat(model).supportsMidConvoSystemMessages);
	// 当前最终工具集合供 OAuth 返回名恢复；不包含所有已经移除的旧工具。
	const currentTools = getCurrentTools(normalizedContext.messages);

	/**
	 * 立即推进本轮异步请求，闭包读取模型/历史/通道，不把任务 Promise 返回给调用方。
	 * 成功写 done，try 内异常通常写 error，但错误文字处理自身仍可能抛错；例 HTTP 成功但 SSE 截断仍得到失败消息，已有 partial 不会回滚。
	 */
	// 立即执行异步闭包，它的 Promise 不向外返回；结果走事件流。
	(async () => {
		// 本轮共享一个可变消息对象，各 partial 引用此对象而非自动快照。
		const output: AssistantMessage = {
			// 统一角色 assistant。
			role: "assistant",
			// 内容块随收到的 block_start 逐项加入，保留首次创建顺序。
			content: [],
			// as Api 仅调整静态类型，运行时仍是模型 API 字符串。
			api: model.api as Api,
			// 保留请求供应商。
			provider: model.provider,
			// 保留目录模型 id，服务器实际模型另记 responseModel。
			model: model.id,
			// 先用零初始化用量，收到 message_start 就可提前计数。
			usage: {
				// 普通输入 token 初值，不包含缓存读写分项。
				input: 0,
				// 输出 token 初值，思考后续作为输出子集另记录。
				output: 0,
				// 缓存读取量初值。
				cacheRead: 0,
				// 缓存写入总量初值。
				cacheWrite: 0,
				// 总量初值，之后从四类累加，不额外再加 reasoning。
				totalTokens: 0,
				// 费用初值，后续按目录价估算或采用有效 OpenRouter 报告。
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			// pending 表示还没得到可接受结束原因。
			stopReason: "pending",
			// 本地毫秒时间，不是服务器的 creation 时间。
			timestamp: Date.now(),
		};

		// 请求构造、请求钩子、流解析和收尾异常统一进入失败处理。
		try {
			// client 延后赋值；两条分支分别采用注入对象或内部构造。
			let client: Anthropic;
			// 该布尔只决定兼容请求形状，不证明实际凭证是某种认证类型。
			let isOAuth: boolean;
			// 计价默认用请求模型；已声明后备模型且返回名匹配时可换计价副本。
			let usageModel = model;
			// 服务器输入绑定检查/处理诊断只保留最近收到的数组，不累加所有事件数组。
			let inputTransformations: BetaInputTransformation[] | undefined;

			// 有注入 client 时跳过本文件内部认证、端点和默认头构造。
			if (options?.client) {
				// 直接复用该客户端实例，不克隆，不把 options.fetch/header 写入其配置。
				client = options.client;
				// 注入客户端固定不启用 OAuth 的工具重命名/Claude Code 身份形状。
				isOAuth = false;
				// 没有注入客户端才走内部认证选择。
			} else {
				// 只从显式 apiKey 取值，本函数不自动读取普通 API key 环境变量。
				const apiKey = options?.apiKey;
				// 无现有认证且三项环境满足时构造 SDK 联邦配置。
				const federation = getAnthropicFederation(model, apiKey, options?.headers, options?.env);
				// 有联邦配置则无需 key，否则本地只检查 key/显式授权头存在。
				if (!federation) assertRequestAuth(model.provider, apiKey, options?.headers);

				// 默认没有 Copilot 动态头，其他供应商不生成它。
				let copilotDynamicHeaders: Record<string, string> | undefined;
				// 供应商名精确 github-copilot 才使用专用头。
				if (model.provider === "github-copilot") {
					// 扫描规范化历史中的图像，不只看最后一条用户消息。
					const hasImages = hasCopilotVisionInput(normalizedContext.messages);
					// 根据完整历史和图像标记推导发起方/vision 等头。
					copilotDynamicHeaders = buildCopilotDynamicHeaders({
						// 传完整规范化会话。
						messages: normalizedContext.messages,
						// 图像标志属性简写。
						hasImages,
					});
				}

				// 缓存 none 时自动亲和头不应使用 sessionId。
				const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
				// 这是对自动头的筛选，不禁止调用方手写同名请求头。
				const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;

				// 创建客户端并同时取得是否用 OAuth 请求形状的标记。
				const created = createClient(
					// 模型提供端点、供应商与默认头。
					model,
					// 可能没有 key，例如显式授权头或联邦配置场景。
					apiKey,
					// 本次显式头优先级通常最高，具体路径见 createClient。
					options?.headers,
					// 可替换 fetch，普通请求及 SDK 联邦交换可使用它。
					options?.fetch,
					// Copilot 的动态头只在 Copilot 构造路径采用。
					copilotDynamicHeaders,
					// 按缓存偏好筛选后的自动亲和标识。
					cacheSessionId,
					// SDK 显式联邦认证配置，可省略。
					federation,
					// 身份配置在普通/Copilot 路径使用，OAuth 使用固定兼容身份头。
					options?.identity,
				);
				// 解开 createClient 返回结果取得实例。
				client = created.client;
				// 采用本地 key 字符串启发式选出的 OAuth 标记。
				isOAuth = created.isOAuthToken;
			}
			// 请求控制选项独立于消息请求体。
			const requestOptions = {
				// 有 signal 才透传给 SDK 请求。
				...(options?.signal ? { signal: options.signal } : {}),
				// 显式 timeoutMs=0 也传；本适配不定义两轮 strict 重建/重试合计期限。
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				// 关 SDK 内建重试，避免与可取消 provider 重试叠加。
				maxRetries: 0,
			};
			// 本轮初始允许 prefer strict；仅特定服务器拒绝后置 true，下一次模型调用会重新 false。
			let disablePreferredStrictTools = false;
			// 声明稍后由成功请求赋值的原始 HTTP 响应。
			let response: Response;
			// 循环最多一次 prefer 降级重建；每次建立请求内部仍可有独立重试预算。
			for (;;) {
				// 每次构建前检查取消，若已取消立即抛；未在所有同步行间重复检查。
				options?.signal?.throwIfAborted();
				// 初次或 strict 降级后重新生成参数，require 工具不会因该标志关闭。
				const built = buildParams(model, normalizedContext, isOAuth, options, disablePreferredStrictTools);
				// 有管理档位才记在统一回复上；即使随后 payload 钩子失败也已写入。
				if (built.providerThinkingLevel) output.providerThinkingLevel = built.providerThinkingLevel;
				// 局部 let 参数允许 payload 钩子返回替代结构。
				let params = built.params;
				// 每次外层重建都调用并等待钩子；普通 provider 重试工厂不重复执行它。
				const nextParams = await options?.onPayload?.(params, model);
				// 返回 undefined 表示不替换，此时钩子仍可能原地修改参数。
				if (nextParams !== undefined) {
					// 替换结果浅展开后强制 stream:true；as 不验证协议形状。原地改后返回 undefined 不经过这行强制。
					params = { ...(nextParams as MessageCreateParamsStreaming), stream: true };
				}
				// 只捕获建立 HTTP 请求的失败来判断是否 strict 降级；buildParams/onPayload 在这个内层 try 之外。
				try {
					// 外层可取消重试围住这次请求建立，默认额外重试数为 0。
					response = await retryProviderRequest(
						// 每次工厂新建 SDK 请求，asResponse 只取得原始响应，不用 SDK 的 SSE 消费器。
						() => client.beta.messages.create(params, requestOptions).asResponse(),
						// 以下是本地重试策略，不发入请求体。
						{
							// 额外重试预算，初始请求不算一次重试。
							maxRetries: options?.maxRetries,
							// 服务器要求退避超过上限就失败，helper 缺省 60 秒。
							maxRetryDelayMs: options?.maxRetryDelayMs,
							// 同一取消信号可打断退避。
							signal: options?.signal,
						},
					);
					// 拿到成功 HTTP 响应就离开构建循环，后续 SSE 错误不会回来降级/重试。
					break;
					// SDK 初始请求失败才在这里分析。
				} catch (error) {
					// Only downgrade a rejected request, never an already-started stream.
					// 下面任一排除条件成立都不允许降级。
					if (
						// 用户取消不触发新请求。
						options?.signal?.aborted ||
						// 已经降级过就不做第二次降级，避免无限循环。
						disablePreferredStrictTools ||
						// 构建器未记录生成过 prefer strict 工具时不降级；payload 钩子修改工具后不会重新检测资格。
						!built.hasPreferredStrictTools ||
						// 必须是安装 SDK 的 APIError 实例，普通长得像的 Error 不通过。
						!(error instanceof Anthropic.APIError) ||
						// 必须是 HTTP 400，其他状态交原错误路径。
						error.status !== 400 ||
						// 必须是 invalid_request_error，不把所有 400 都归因 schema。
						error.type !== "invalid_request_error" ||
						// 还需错误文字符合已知 strict 工具限额模式，字符串启发式不是通用根因分析。
						!isStrictToolLimitErrorMessage(error.message)
					) {
						// 原错误交外层统一 catch，保留已积累的诊断/部分内容。
						throw error;
					}
					// 本轮后续构建关闭 prefer strict，原始 schema/require 规则保留。
					disablePreferredStrictTools = true;
					// 向当前消息追加一条诊断记录，不发送单独文本事件。
					appendAssistantMessageDiagnostic(output, {
						// 诊断分类固定为 strict 降级。
						type: "anthropic_strict_tools_fallback",
						// 记本地降级时刻。
						timestamp: Date.now(),
						// 仅记录此错误文字，没有在此附完整堆栈或脱敏。
						error: { message: error.message },
						// 用稳定原因字段供外层识别，不修改模型永久能力配置。
						details: { reason: "strict_tool_limits_exceeded" },
					});
				}
			}
			// 建立成功后等待 HTTP 观察回调；失败会进外层 catch，此时未发 start。
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			// 表示可以开始消费 HTTP 响应，不是完整回答完成。
			stream.push({ type: "start", partial: output });

			// Stream state per Anthropic block index, kept off the content blocks so it never reaches partials.
			// 远端块索引→公开内容位置及可选 JSON 解析器；私有解析器不写进公开 partial。
			const openBlocks = new Map<number, { contentIndex: number; arguments?: ToolCallArgumentsStream }>();
			/**
			 * 按 Anthropic 块索引取得公开块与私有解析器包装，返回新包装或 undefined，无状态修改。
			 * 例远端 index=3 可对应 output.content[1]；包装是浅复制，block/arguments 仍是原对象引用。
			 */
			const openBlock = (anthropicIndex: number) => {
				// 按 Anthropic 远端 index 查仍未结束块，不按 output.content 下标直接查。
				const open = openBlocks.get(anthropicIndex);
				// 不存在返回 undefined；存在则新建状态包装但复用实际块/解析器引用，! 不增加运行时校验。
				return open === undefined ? undefined : { ...open, block: output.content[open.contentIndex]! };
			};

			// 按本文件自有 SSE 解析结果逐事件处理，不使用 SDK 事件流 parse。
			for await (const event of iterateAnthropicEvents(response, options?.signal)) {
				// 每个已解析事件先交观察器并等待，观察器异常会终止本轮。
				await options?.onProviderStreamEvent?.(event, model);
				// message_start 可包含初始用量和实际路由模型。
				if (event.type === "message_start") {
					// 采用远端 id，重复 start 会覆盖，不在此校验唯一性。
					output.responseId = event.message.id;
					// 读取服务器报告的输入变换数组候选。
					const transformations = event.message.input_transformations;
					// 只检查是不是数组，不逐项验证结构，后面新数组会覆盖旧数组。
					if (Array.isArray(transformations)) inputTransformations = transformations;
					// 实际服务模型可以与请求 id 不同，类型声明不验证远端值。
					const responseModel = event.message.model;
					// 不同就另存 responseModel，不改变 output.model 的历史身份。
					if (responseModel !== model.id) output.responseModel = responseModel;
					// 计价只从模型声明的同供应商后备条目取候选价格。
					const fallbackCost =
						// 返回模型名等于请求 id 时无须后备价。
						responseModel === model.id
							? // 此分支保持原模型计价。
								undefined
							: // 否则查允许后备列表，不查询全局模型目录或实时价格。
								model.compat?.allowedFallbackModels?.find(
									// provider 和 model 两项都精确匹配才采用该条目。
									(fallback) => fallback.provider === model.provider && fallback.model === responseModel,
									// 没找到就 undefined，沿用原模型价。
								)?.cost;
					// 有后备价格才建带新 id/cost 的计价副本，不修改模型与 output.model。
					usageModel = fallbackCost ? { ...model, id: responseModel, cost: fallbackCost } : model;
					// Capture initial token usage from message_start event
					// This ensures we have input token counts even if the stream is aborted early
					// 开始事件的普通输入量，缺省/假值回退 0；不减去缓存读写，因为该协议分别报告。
					output.usage.input = event.message.usage.input_tokens || 0;
					// 开始事件的输出累计量，可在流结束前先记录。
					output.usage.output = event.message.usage.output_tokens || 0;
					// 缓存命中输入量单列。
					output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
					// 缓存创建输入总量单列。
					output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
					// 其中 1h 写入子集另记，用于共享成本函数区分时长，不额外计入总 token。
					output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
					// Anthropic doesn't provide total_tokens, compute from components
					// 总 token 没有直接远端字段，按下面四项重算。
					output.usage.totalTokens =
						// 普通输入+输出+缓存读+缓存写，思考/1h 子集不再另加。
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					// 按当前选定计价模型估算已知费用，开始后立即中断也保留已知数。
					calculateCost(usageModel, output.usage);
					// 块开始事件会为认识的类型建立公开内容块。
				} else if (event.type === "content_block_start") {
					// fallback 是供应商事件类型，本适配不把它作为可见文字块。
					if (event.content_block.type === "fallback") {
						// 已有任何内容块就视为不支持的输出中途换模型，即使该块正文为空。
						if (output.content.length > 0) {
							// 抛失败，不尝试合并两模型已输出内容或重发请求。
							throw new Error("Anthropic performed an unsupported mid-output model fallback");
						}
						// 尚无内容时忽略 fallback 块；不在这行直接更新 usageModel/responseModel。
						continue;
					}
					// 文字开始允许携带初始非空正文。
					if (event.content_block.type === "text") {
						// 保留 start 内正文，不强制从空串开始；?? 仅在空值时兜底。
						output.content.push({ type: "text", text: event.content_block.text ?? "" });
						// 记录远端索引对应的新公开块位置，同索引重复会覆盖映射但不删除旧公开块。
						openBlocks.set(event.index, { contentIndex: output.content.length - 1 });
						// 发送 text_start，已有初始正文可从 partial 看到，不另补一个 text_delta。
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
						// 思考开始也可带初始文字和签名。
					} else if (event.content_block.type === "thinking") {
						// 新建统一思考块。
						output.content.push({
							// 统一标签 thinking。
							type: "thinking",
							// 初始思考文字保留，未给时空串。
							thinking: event.content_block.thinking ?? "",
							// 初始签名保留，后面 signature_delta 继续拼接。
							thinkingSignature: event.content_block.signature ?? "",
						});
						// 记录该远端索引映射。
						openBlocks.set(event.index, { contentIndex: output.content.length - 1 });
						// 发思考开始，正文/签名均可在 partial 中读取。
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
						// 被隐藏的思考用不透明 data 回放，不尝试解密。
					} else if (event.content_block.type === "redacted_thinking") {
						// 统一层仍用 thinking 块，但加 redacted 标志区别普通原文。
						output.content.push({
							// 统一标签 thinking。
							type: "thinking",
							// 固定可见占位，不冒充实际思考正文。
							thinking: "[Reasoning redacted]",
							// 不透明 data 存在统一 thinkingSignature 字段。
							thinkingSignature: event.content_block.data,
							// redacted=true 让后续转回 redacted_thinking，而不转成普通签名原文。
							redacted: true,
						});
						// 同样登记远端索引映射。
						openBlocks.set(event.index, { contentIndex: output.content.length - 1 });
						// 仍发 thinking_start，不新设额外 redacted 事件类型。
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
						// tool_use 是模型提出调用，不在这里执行工具。
					} else if (event.content_block.type === "tool_use") {
						// 创建统一公开调用对象。
						output.content.push({
							// 标签映射为 toolCall。
							type: "toolCall",
							// 采用供应商调用 id，后续结果靠它配对。
							id: event.content_block.id,
							// OAuth 请求形状启用时，返回名按当前工具集合恢复用户声明拼写。
							name: isOAuth
								? // 找不到当前声明则保留返回名，不能保证已移除工具也总能恢复原拼写。
									fromClaudeCodeName(event.content_block.name, currentTools)
								: // 非 OAuth 原样保留模型工具名。
									event.content_block.name,
							// 初始 input 先用于公开参数；as Record<string,any> 不验证对象/字段，空值回退 {}。
							arguments: (event.content_block.input as Record<string, any>) ?? {},
						});
						// 为该索引保存私有参数流状态。
						openBlocks.set(event.index, {
							// 公开内容位置区别远端 index。
							contentIndex: output.content.length - 1,
							// 新解析器从空原文开始，不把 start.input 喂入它；结束时其结果可覆盖初始 input。
							arguments: new ToolCallArgumentsStream(),
						});
						// 发 toolcall_start，调用方可显示最初参数而非直接执行。
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
					// 后续增量按远端块索引定位已打开块。
				} else if (event.type === "content_block_delta") {
					// 未知/已关闭索引返回 undefined，后续类型条件会跳过该片。
					const open = openBlock(event.index);
					// 正文增量类型。
					if (event.delta.type === "text_delta") {
						// 只有对应公开块确实 text 才追加，类型不匹配片段忽略。
						if (open?.block.type === "text") {
							// 原地拼新增正文，不插换行。
							open.block.text += event.delta.text;
							// 构造统一文字增量事件。
							stream.push({
								// 标签 text_delta。
								type: "text_delta",
								// 使用公开内容下标。
								contentIndex: open.contentIndex,
								// 只给本次新增文字。
								delta: event.delta.text,
								// partial 引用当前可变整条消息。
								partial: output,
							});
						}
						// 思考文字增量与签名增量分别处理。
					} else if (event.delta.type === "thinking_delta") {
						// 只向 thinking 类型块追加。
						if (open?.block.type === "thinking") {
							// 拼接可见思考文字，不将签名当正文。
							open.block.thinking += event.delta.thinking;
							// 发送思考增量事件。
							stream.push({
								// 标签 thinking_delta。
								type: "thinking_delta",
								// 对应公开块位置。
								contentIndex: open.contentIndex,
								// 本次思考文字片段。
								delta: event.delta.thinking,
								// 同一 output 引用。
								partial: output,
							});
						}
						// 工具输入 JSON 片段可尚未闭合，仅供中途预览。
					} else if (event.delta.type === "input_json_delta") {
						// 必须是调用块且有登记解析器才处理，未知/不配套索引忽略。
						if (open?.block.type === "toolCall" && open.arguments !== undefined) {
							// append 返回当前对象预览，可能为旧稳定快照，不代表最终参数/工具 schema 已合法。
							open.block.arguments = open.arguments.append(event.delta.partial_json);
							// 发工具参数增量事件。
							stream.push({
								// 标签 toolcall_delta，不是执行结果事件。
								type: "toolcall_delta",
								// 公开调用位置。
								contentIndex: open.contentIndex,
								// 保留供应商原始 JSON 片段。
								delta: event.delta.partial_json,
								// 消费者可同时从 partial 读取容错参数对象。
								partial: output,
							});
						}
						// 签名增量只更新回放元数据，不发可见思考文字事件。
					} else if (event.delta.type === "signature_delta") {
						// thinking 包括普通/隐藏块，该条件不另外区分 redacted。
						if (open?.block.type === "thinking") {
							// 先确保签名有可拼接字符串，空值回退空串。
							open.block.thinkingSignature = open.block.thinkingSignature || "";
							// 原地追加签名片段，不验签、不解密。
							open.block.thinkingSignature += event.delta.signature;
						}
					}
					// 块结束时才发块级 end 并完成工具参数解析。
				} else if (event.type === "content_block_stop") {
					// 先查私有状态和公开块引用。
					const open = openBlock(event.index);
					// 无论状态是否存在都移除索引登记，重复 stop 因查不到将忽略。
					openBlocks.delete(event.index);
					// 实际找到对应开放块才发 end。
					if (open) {
						// 对象解构同时将 contentIndex 改本地名 index，避免重复长字段名。
						const { block, contentIndex: index } = open;
						// 文字块直接报告累计正文。
						if (block.type === "text") {
							// 创建文字结束事件。
							stream.push({
								// text_end 只是块结束，不是整条消息 done。
								type: "text_end",
								// 公开数组下标。
								contentIndex: index,
								// 完整累计文字，而非最后 delta。
								content: block.text,
								// 本轮 output 引用。
								partial: output,
							});
							// 普通/隐藏思考块都走 thinking 收尾。
						} else if (block.type === "thinking") {
							// 发思考结束事件，不在此新增/验证签名。
							stream.push({
								// 标签 thinking_end。
								type: "thinking_end",
								// 公开块下标，不是服务器 index。
								contentIndex: index,
								// 累计可见思考正文，隐藏块可能是固定占位。
								content: block.thinking,
								// 同一个 output 引用。
								partial: output,
							});
							// 调用块且有登记解析器才做最终参数解析。
						} else if (block.type === "toolCall" && open.arguments !== undefined) {
							// 完整原文解析后覆盖 arguments/argumentsError；非法完整对象记错误字段，不在此执行工具。
							Object.assign(block, open.arguments.finish());
							// 参数接收结束事件对象。
							stream.push({
								// toolcall_end 表示参数流结束，不表示工具执行成功。
								type: "toolcall_end",
								// 公开调用位置。
								contentIndex: index,
								// 最终调用块可能含 argumentsError，执行前还需上层 schema 校验。
								toolCall: block,
								// 附当前统一消息。
								partial: output,
							});
						}
					}
					// message_delta 更新终态、用量与服务器输入绑定检查/处理诊断，不一定含正文。
				} else if (event.type === "message_delta") {
					// 读取此事件的输入变换候选。
					const transformations = event.input_transformations;
					// 只检查数组，新的数组覆盖旧数组，空数组也会覆盖。
					if (Array.isArray(transformations)) inputTransformations = transformations;
					// 真值停止原因才映射，null/空值不改变 pending。
					if (event.delta.stop_reason) {
						// 保留供应商原始停止码。
						output.rawStopReason = event.delta.stop_reason;
						// 传可选拒绝详情，refusal 可用其 explanation。
						const stopReasonResult = mapStopReason(event.delta.stop_reason, event.delta.stop_details);
						// 更新统一终态，仍继续消费后续事件到字节 EOF。
						output.stopReason = stopReasonResult.stopReason;
						// 有真值错误文字才写，不在此清旧错误。
						if (stopReasonResult.errorMessage) {
							// 记录映射给出的拒绝/敏感内容原因。
							output.errorMessage = stopReasonResult.errorMessage;
						}
					}
					// Only update usage fields if present (not null).
					// Preserves input_tokens from message_start when proxies omit it in message_delta.
					// 有 usage 才逐项更新，不把缺省 usage 当一份零值覆盖。
					if (event.usage) {
						// != null 同时排除 null/undefined，明确 0 保留。
						if (event.usage.input_tokens != null) {
							// 覆盖累计普通输入量，不对每个 delta 求和。
							output.usage.input = event.usage.input_tokens;
						}
						// 输出量同样只在字段给出时覆盖。
						if (event.usage.output_tokens != null) {
							// 保留最新累计输出数。
							output.usage.output = event.usage.output_tokens;
						}
						// 缓存读取量给出时更新。
						if (event.usage.cache_read_input_tokens != null) {
							// 覆盖缓存命中累计数。
							output.usage.cacheRead = event.usage.cache_read_input_tokens;
						}
						// 缓存创建总量给出时更新。
						if (event.usage.cache_creation_input_tokens != null) {
							// 覆盖写入总数，1h 部分是它的子集。
							output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
						}
						// Vercel AI Gateway includes the TTL breakdown in deltas, though the SDK only types it on message_start.
						// 读取网关额外提供的 TTL 拆分，SDK 静态类型在该位置可能没有它。
						const cacheCreation =
							// 交叉断言添加 cache_creation，可选字段不等于运行时验证。
							(
								event.usage as typeof event.usage & { cache_creation?: { ephemeral_1h_input_tokens?: number } }
								// 括号包断言表达式后再取属性，不是创建新对象。
							).cache_creation;
						// 有明确 1h 子集数才更新，缺省不清以前已知值。
						if (cacheCreation?.ephemeral_1h_input_tokens != null) {
							// 保存供 calculateCost 区分 1h 写入价。
							output.usage.cacheWrite1h = cacheCreation.ephemeral_1h_input_tokens;
						}
						// Anthropic reports reasoning tokens as a subset of output tokens.
						// 思考 token 是输出明细，不应再加到输出总量。
						const thinkingTokens = event.usage.output_tokens_details?.thinking_tokens;
						// 0 是已报告值，应保留；null/undefined 代表没提供。
						if (thinkingTokens != null) {
							// 记录最新 reasoning 明细。
							output.usage.reasoning = thinkingTokens;
						}
					}
					// Anthropic doesn't provide total_tokens, compute from components
					// 即使本 delta 没 usage，也用已经保存的分项重算总量。
					output.usage.totalTokens =
						// 四个计费类别相加，reasoning/cacheWrite1h 都不重复算。
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					// 用请求或已声明后备模型的价格更新目录估算。
					calculateCost(usageModel, output.usage);
					// 识别 OpenRouter 且该片确有 usage 才尝试报告账务覆盖。
					if (isOpenRouterModel(model) && event.usage) {
						// OpenRouter adds billing fields to streamed message_delta usage at runtime,
						// although its OpenAPI schema and the Anthropic SDK do not type those fields.
						// helper 会对自己使用的总费用字段做数值验证，不对整个事件做 schema 验证。
						applyOpenRouterReportedCost(
							// 原地更新当前统一用量费用。
							output.usage,
							// 断言查看 SDK 没声明的 OpenRouter 账务扩展；有效报告可只替换总价。
							event.usage as typeof event.usage & OpenRouterUsageAccounting,
						);
					}
				}
			}

			// 流处理完后再检查信号，避免取消后误报 done。
			if (options?.signal?.aborted) {
				// 进入外层失败路径，不撤回已有 partial/块结束事件。
				throw new Error("Request was aborted");
			}

			// pending 表示没得到停止原因，即使有正文也不能直接算成功。
			if (output.stopReason === "pending") {
				// 缺少统一终态报不完整流；不在此重新发模型请求。
				throw new Error("Anthropic stream ended without a stop reason");
			}
			// 错误/取消状态不走成功 done。
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				// 已有原因优先，空值用固定回退文字。
				throw new Error(output.errorMessage || "An unknown error occurred");
			}
			// 仅成功路径且最后保留的变换数组非空时附诊断；失败路径不会执行这块。
			if (inputTransformations && inputTransformations.length > 0) {
				// 追加服务器报告的输入绑定检查/处理诊断，既可能丢块，也可能报告不匹配但保留；此处不修改持久历史。
				appendAssistantMessageDiagnostic(output, {
					// 固定诊断类型。
					type: "anthropic_input_transformations",
					// 本地记录诊断时刻。
					timestamp: Date.now(),
					// 只选下列变换字段作为详情。
					details: {
						// map 新建简化对象，不保留每项任意额外键。
						transformations: inputTransformations.map((transformation) => ({
							// null 归 undefined，字符串保留；这里未额外验证字段类型。
							type: transformation.type ?? undefined,
							// 记录服务端所指历史路径，不在本地按该路径删消息。
							path: transformation.path ?? undefined,
							// 记录处理原因文字，不自动修复/重发历史。
							reason: transformation.reason ?? undefined,
						})),
					},
				});
			}

			// 成功时发最终统一消息，stop/length/toolUse 等不代表 Agent 总任务都已结束。
			stream.push({ type: "done", reason: output.stopReason, message: output });
			// 关闭本地事件通道。
			stream.end();
			// 接住上述 try 内失败；不会为仍开放块自动补 end 或最终参数解析。
		} catch (error) {
			// 仅按捕获时 signal.aborted 分类，其他失败归 error。
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			// Error 取 message；其他值 JSON.stringify，字符串会带引号，undefined 可得 undefined，循环对象/BigInt 仍可能在此抛错，无二次 catch。
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			// 错误格式化正常完成时发 error，保留已接收内容和用量。
			stream.push({ type: "error", reason: output.stopReason, error: output });
			// 错误文字处理和发事件正常完成后关闭失败通道；前面再次抛错时执行不到这里。
			stream.end();
		}
		// 立即调用异步闭包，外层不等待其任务 Promise。
	})();

	// 同步返回可迭代/等待结果的事件通道。
	return stream;
};

/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 * Note: effort "max" is available on all adaptive-thinking Claude models, while native
 * "xhigh" is only available on Opus 4.7/4.8, Sonnet 5, and Fable 5.
 */
/**
 * 将统一逻辑思考档位转 Anthropic effort，返回字符串联合，无网络/状态修改。
 * 字符串映射优先，否则 minimal/low→low，medium/high 原样，其余 high；例 max 只有目录显式字符串映射时才保留 max。
 * 映射只用 as 适配静态联合，不验证该字符串确被服务端支持；本 helper 不负责开启/关闭思考。
 */
function mapThinkingLevelToEffort(
	// 模型提供逻辑档位到原生字符串的映射。
	model: Model<"anthropic-messages">,
	// 索引访问复用简单选项档位类型，可为 undefined；ThinkingLevel 本身不含 off。
	level: SimpleStreamOptions["reasoning"],
	// 声明返回 AnthropicEffort，但映射字符串通过断言可能超出这个联合，运行时不校验。
): AnthropicEffort {
	// 有逻辑档位才查映射，未给时不查 off。
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	// 任何字符串映射直接采用，包括未知字符串；as 仅绕静态类型限制。
	if (typeof mapped === "string") return mapped as AnthropicEffort;

	// 无字符串映射时使用下面本地回退，不联网判断模型支持什么。
	switch (level) {
		// minimal 与 low 合并为原生 low。
		case "minimal":
		// low 同上。
		case "low":
			// 返回 low。
			return "low";
		// medium 原样映射。
		case "medium":
			// 返回 medium。
			return "medium";
		// high 原样映射。
		case "high":
			// 返回 high。
			return "high";
		// xhigh/max/undefined 若没有显式字符串映射，均走 high 回退。
		default:
			// 不在这里自动把 max 直接透传；目录映射决定是否保留它。
			return "high";
	}
}

/**
 * 把跨供应商简单配置转为原生思考参数并启动真实请求，返回事件流；前置认证失败可同步抛错。
 * 先联邦/显式认证检查→公共选项→无 reasoning 传关闭意图；有档位且强制 adaptive 用 effort，否则调整预算/总输出并估算上下文余量。
 * 例旧式 medium 可增加思考预算，再给正文尽量留 1024；这不是任意输入都满足服务端预算下限的保证，原生构建还有 ||1024 回退。
 */
export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	// 模型静态限定为 Anthropic Messages。
	model: Model<"anthropic-messages">,
	// 统一会话供默认选项估算和真实入口转换。
	context: TranscriptContext,
	// 简单请求没有注入 client 字段；注入功能只在专用 stream 选项开放。
	options?: SimpleStreamOptions,
	// 函数是同步包装，前置检查可在返回事件流前直接抛错。
): AssistantMessageEventStream => {
	// 先看是否有可用联邦配置，不创建客户端或读取身份文件。
	if (!getAnthropicFederation(model, options?.apiKey, options?.headers, options?.env)) {
		// 没有联邦配置就同步要求 key/显式授权头存在。
		assertRequestAuth(model.provider, options?.apiKey, options?.headers);
	}

	// 组装供原生入口使用的公共配置对象。
	const base = {
		// 复制公共选项并应用 token/采样默认，单独传显式 key。
		...buildBaseOptions(model, context, options, options?.apiKey),
		// 统一工具选择 none/auto 继续传入，专用入口再转协议对象。
		toolChoice: options?.toolChoice,
		// satisfies 静态检查不改变对象，不进行运行时验证。
	} satisfies AnthropicOptions;
	// 没请求逻辑档位时显式传 thinkingEnabled:false；这不等于所有模型都能实际关闭思考。
	if (!options?.reasoning) {
		// 委托同一真实网络入口。
		return stream(model, context, {
			// 展开通用配置。
			...base,
			// 原生关闭意图，buildParams 会结合 off 映射与管理档位能力决定最终字段。
			thinkingEnabled: false,
			// 只检查配置满足接口。
		} satisfies AnthropicOptions);
	}

	// For models with adaptive thinking: use an effort level.
	// For older models: use budget-based thinking.
	// 仅显式 forceAdaptiveThinking===true 才选这条简单入口的 adaptive 路径，不猜模型名。
	if (model.compat?.forceAdaptiveThinking === true) {
		// 先按目录映射/回退转 Anthropic effort，不调用通用 clampThinkingLevel。
		const effort = mapThinkingLevelToEffort(model, options.reasoning);
		// 交原生入口构造完整请求。
		return stream(model, context, {
			// 保留公共默认。
			...base,
			// 明确请求开启思考。
			thinkingEnabled: true,
			// 传已映射 effort，不使用旧预算字段。
			effort,
			// 静态检查专用选项。
		} satisfies AnthropicOptions);
	}

	// Undefined means the caller did not request an output cap; let the helper use the model cap.
	// Do not coerce to 0 here, or the thinking budget would become the entire max_tokens value.
	// 非上述 adaptive 分支按档位预算调整总输出上限。
	const adjusted = adjustMaxTokensForThinking(
		// base.maxTokens 可能仍 undefined，不能先强制为 0。
		base.maxTokens,
		// 模型输出总上限作兜底/封顶候选。
		model.maxTokens,
		// 逻辑档位决定候选思考预算。
		options.reasoning,
		// 调用方可覆盖部分预算档位。
		options.thinkingBudgets,
	);

	// 再按上下文占用估值留余量；不是实际 tokenizer 的必不溢出保证。
	const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);

	// 把调整后的上限和预算传真实入口。
	return stream(model, context, {
		// 先复制公共配置。
		...base,
		// 再覆盖最大输出量。
		maxTokens,
		// 标记要开启旧式思考；若模型还支持管理 effort，buildParams 可能走其独立 adaptive 分支。
		thinkingEnabled: true,
		// 预算最多取 maxTokens-1024，且该余量至少 0；若算到 0，原生构建的 ||1024 仍会回退，不能保证所有输入都满足 SDK 预算约束。
		thinkingBudgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
		// 仅静态检查选项兼容。
	} satisfies AnthropicOptions);
};

/**
 * 按 key 是否包含 sk-ant-oat 子串选择 OAuth 请求形状，返回 boolean，无副作用。
 * 例 abc-sk-ant-oat-xyz 也匹配；不是前缀/签名/有效期校验，且 Copilot 构造分支优先于此判断。
 */
function isOAuthToken(apiKey: string): boolean {
	// 仅用 includes 子串检测，不要求前缀、供应商名或有效签名；不是实际 OAuth 令牌验证。
	return apiKey.includes("sk-ant-oat");
}

/**
 * 选择并创建 Anthropic SDK 客户端，返回 {client,isOAuthToken}；构造可解析认证配置，但不在本函数显式发消息请求。
 * 顺序：Copilot Bearer→key 子串命中 OAuth 形状→普通 key/头/联邦；各分支合并默认头，普通路径才自动加亲和头。
 * 例同联邦配置+根 URL+fetch 引用复用一个基础 client，再用 withOptions 只换头并共享 SDK 认证状态；换配置替换模块唯一缓存项。
 * 显式 null 防 SDK 普通 key/token 环境回退，子类关默认凭证链；显式 config 仍由 SDK 解析/使用，配置/构造异常向外抛。
 */
function createClient(
	// 模型提供根 URL、默认头和协议兼容能力。
	model: Model<"anthropic-messages">,
	// key 可缺省，显式头或 federation 可承担认证。
	apiKey: string | undefined,
	// 本次显式头，JS 合并保留大小写不同键，SDK 后面规范化。
	optionsHeaders?: ProviderHeaders,
	// 自定义 fetch 函数签名取全局 fetch 类型，不调用它。
	fetch?: typeof globalThis.fetch,
	// Copilot 动态头仅在第一条分支合并。
	dynamicHeaders?: Record<string, string>,
	// 自动亲和标识，只在普通/API key/联邦路径使用。
	sessionId?: string,
	// 显式联邦配置，可用于共享 SDK token cache。
	federation?: AnthropicFederationConfig,
	// 身份配置在普通/Copilot 路径使用，OAuth 路径用固定兼容身份。
	identity?: ClientIdentity,
	// 返回 SDK 客户端以及本地请求形状标志，不等同凭证校验结果。
): { client: Anthropic; isOAuthToken: boolean } {
	// Copilot: Bearer auth.
	// Copilot 最先匹配，优先于 key 字符串是否看起来是 Anthropic OAuth。
	if (model.provider === "github-copilot") {
		// 子类关闭默认凭证发现，仍正常使用显式认证配置。
		const client = new PiAnthropic({
			// 显式 null 避免 SDK 从环境自动采用 API key。
			apiKey: null,
			// key 用作 Bearer token，缺值传 null 避免 SDK 环境回退。
			authToken: apiKey ?? null,
			// 供应商模型声明的根 URL，SDK 追加 messages 路径。
			baseURL: model.baseUrl,
			// 允许浏览器构造，不代表该处能隐藏凭证。
			dangerouslyAllowBrowser: true,
			// 传入自定义传输实现。
			fetch,
			// 按以下顺序合并默认头；SDK 还有自己的自动/请求体头层。
			defaultHeaders: mergeHeaders(
				// 首先客户端身份头。
				getIdentityHeaders(model, identity),
				// 然后固定兼容头对象。
				{
					// 声明接受 JSON，实际本次流以 SSE 返回。
					accept: "application/json",
					// 固定浏览器直连标记文字。
					"anthropic-dangerous-direct-browser-access": "true",
				},
				// 模型默认头覆盖此前同名属性。
				model.headers,
				// Copilot 动态发起方/图片头再覆盖。
				dynamicHeaders,
				// 本次显式头最后覆盖。
				optionsHeaders,
			),
		});

		// Copilot 即使用 Bearer，也不启用 Claude Code 工具重命名/system 身份分支。
		return { client, isOAuthToken: false };
	}

	// OAuth: Bearer auth, Claude Code identity headers instead of the client identity.
	// 非 Copilot 且 key 子串检测命中时启用 OAuth 兼容请求形状，不限制 provider 名。
	if (apiKey && isOAuthToken(apiKey)) {
		// 构造同一子类，避免默认凭证链额外介入。
		const client = new PiAnthropic({
			// 禁用 API key 环境回退及对应 X-Api-Key 认证。
			apiKey: null,
			// 使用该 key 作为 SDK Bearer token。
			authToken: apiKey,
			// 仍保留模型根 URL，不强制换成官方地址。
			baseURL: model.baseUrl,
			// 允许浏览器构造。
			dangerouslyAllowBrowser: true,
			// 自定义传输透传。
			fetch,
			// OAuth 不使用 getIdentityHeaders，而采用固定兼容身份头。
			defaultHeaders: mergeHeaders(
				// 构造固定兼容头记录。
				{
					// 固定接受类型。
					accept: "application/json",
					// 固定直连浏览器标记。
					"anthropic-dangerous-direct-browser-access": "true",
					// 本地常量版本拼 claude-cli 身份，不检查实际安装的客户端。
					"user-agent": `claude-cli/${claudeCodeVersion}`,
					// 固定 x-app=cli。
					"x-app": "cli",
				},
				// 模型头可覆盖固定身份的同名 JS 属性。
				model.headers,
				// 请求显式头最后覆盖。
				optionsHeaders,
			),
		});

		// 标记 true，让请求 system/工具名字/返回名走 OAuth 兼容路径；此分支不加自动亲和头。
		return { client, isOAuthToken: true };
	}

	// API key, header-owned auth, or workload identity federation.
	// 其余 API key、自定义头和联邦共用普通构造路径。
	const compat = getAnthropicCompat(model);
	// 亲和头单独建对象，方便按指定优先级合并。
	const sessionAffinityHeaders: ProviderHeaders = {};
	// 会话 id 真值且发送开关允许才自动加头。
	if (sessionId && compat.sendSessionAffinityHeaders) {
		// 格式精确 openrouter 用 x-session-id，其他任何值（含 none/undefined）用 x-session-affinity。
		const header = compat.sessionAffinityFormat === "openrouter" ? "x-session-id" : "x-session-affinity";
		// 动态计算键名写该会话值，不加入模型文字。
		sessionAffinityHeaders[header] = sessionId;
	}
	// 普通路径头按以下顺序合并。
	const defaultHeaders = mergeHeaders(
		// 身份头最先。
		getIdentityHeaders(model, identity),
		// 固定兼容头其次。
		{
			// 接受类型 application/json。
			accept: "application/json",
			// 固定浏览器标记。
			"anthropic-dangerous-direct-browser-access": "true",
		},
		// 自动亲和头在模型头之前，因此可被模型/本次显式头覆盖。
		sessionAffinityHeaders,
		// 模型默认头。
		model.headers,
		// 本次显式头最后；SDK 的 bodyHeaders 中 beta 头等还可能另有优先级。
		optionsHeaders,
	);
	// 有显式联邦配置时复用最近配置对应的基础客户端。
	if (federation) {
		// 序列化根 URL 和配置作比较键，不包含默认头，也不比较文件当前内容。
		const key = JSON.stringify([model.baseUrl, federation]);
		// 配置键不同或 fetch 函数引用不同就创建新基础客户端；短路让缓存不存在时不读其 fetch。
		if (federationClient?.key !== key || federationClient.fetch !== fetch) {
			// 新的联邦基础 SDK client，不在此直接交换 token。
			const client = new PiAnthropic({
				// 显式禁用 key 环境回退。
				apiKey: null,
				// 显式禁用普通 Bearer 环境回退。
				authToken: null,
				// 显式 config 由 SDK 解析成联邦 provider，不受默认发现钩子 false 禁止。
				config: federation,
				// 固定模型根 URL。
				baseURL: model.baseUrl,
				// 允许浏览器构造，但文件联邦认证实际能力依 SDK/环境。
				dangerouslyAllowBrowser: true,
				// 此 fetch 也用于 SDK 认证交换传输，由 SDK 控制读取/刷新。
				fetch,
			});
			// 替换模块唯一缓存项，未在这里主动 dispose 旧实例。
			federationClient = { key, fetch, client };
		}
		// 只覆盖默认头的 withOptions 克隆共享 SDK authState/tokenCache；这不是深复制认证或每请求独立缓存。
		return { client: federationClient.client.withOptions({ defaultHeaders }), isOAuthToken: false };
	}

	// 没有联邦配置时每次新建普通客户端。
	const client = new PiAnthropic({
		// key 不存在时明确 null，避免 SDK 自己从环境找 API key。
		apiKey: apiKey ?? null,
		// 明确关闭 authToken 环境回退；授权头仍可由 defaultHeaders 管理。
		authToken: null,
		// 模型根 URL。
		baseURL: model.baseUrl,
		// 允许浏览器构造。
		dangerouslyAllowBrowser: true,
		// 可选自定义传输。
		fetch,
		// 采用已经合并的普通路径默认头，SDK 最终按 HTTP 头规则合并/验证。
		defaultHeaders,
	});

	// 返回实例并明确不走 OAuth 请求形状。
	return { client, isOAuthToken: false };
}

/**
 * 计算本次 params.betas 列表，返回数组，不发请求、不改头输入。
 * 先扫描模型头再请求头：null→全关，字符串→逗号拆分/trim/去空/去重并完全替代；无覆盖才按 OAuth、工具、思考、fallback、原生变更自动组装。
 * 例显式 anthropic-beta="custom" 后不会再自动补 oauth beta；安装 SDK 将 betas 转 HTTP 头，注入客户端也收到这份参数。
 */
function getBetaFeatures(
	// 模型提供兼容开关和默认 anthropic-beta 头。
	model: Model<"anthropic-messages">,
	// 会话用于判断当前工具是否需要旧流式 beta。
	context: TranscriptContext,
	// 本地 OAuth 请求形状标记。
	isOAuthToken: boolean,
	// 原生工具变更组合条件已由 buildParams 计算。
	nativeToolChanges: boolean,
	// 本次选项/头可替换全部自动 beta 列表。
	options?: AnthropicOptions,
	// 取 SDK betas 类型再 NonNullable，返回始终是数组而非 undefined/null。
): NonNullable<MessageCreateParamsStreaming["betas"]> {
	// 三态：undefined 未配置、null 显式关闭、字符串完全替换。
	let configuredFeatures: string | null | undefined;
	// 先模型头后请求头，后面的匹配值优先。
	for (const headers of [model.headers, options?.headers]) {
		// 即使头来源缺省也按空记录遍历。
		for (const [name, value] of Object.entries(headers ?? {})) {
			// 名字不区分大小写；同记录有多个大小写变体时按枚举顺序最后匹配者胜出。
			if (name.toLowerCase() === "anthropic-beta") configuredFeatures = value;
		}
	}
	// null 返回空列表，后面所有自动 beta 都跳过。
	if (configuredFeatures === null) return [];
	// 任何字符串（含空串）都走完整替换模式，不再自动补 OAuth/工具/思考 beta。
	if (configuredFeatures !== undefined) {
		// 数组展开把 Set 变回数组。
		return [
			// Set 去掉重复 beta 字符串，保持首次出现顺序。
			...new Set(
				// 从配置字符串开始分割。
				configuredFeatures
					// 逗号是唯一分隔符，不处理引号转义语法。
					.split(",")
					// 去每项两端空白。
					.map((feature) => feature.trim())
					// 空项丢弃。
					.filter((feature) => feature.length > 0),
			),
		];
	}

	// 没有覆盖配置时才开始组自动列表。
	const features: NonNullable<MessageCreateParamsStreaming["betas"]> = [];
	// OAuth 兼容路径加入两个固定身份/认证 beta。
	if (isOAuthToken) features.push("claude-code-20250219", "oauth-2025-04-20");
	// 有当前工具且不支持 eager 时加旧细粒度流 beta。
	if (shouldUseFineGrainedToolStreamingBeta(model, context)) features.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	// 旧 interleaved beta 需要下列四个条件同时成立。
	if (
		// 目录模型声明 reasoning。
		model.reasoning &&
		// 原生选项必须精确 thinkingEnabled=true。
		options?.thinkingEnabled === true &&
		// 交错选项缺省 true，显式 false 阻止。
		(options.interleavedThinking ?? true) &&
		// 不是 forceAdaptiveThinking=true；此条件不直接检查后面的管理 effort 模式。
		model.compat?.forceAdaptiveThinking !== true
	) {
		// 条件满足才加 interleaved 标识。
		features.push(INTERLEAVED_THINKING_BETA);
	}
	// 非空允许后备模型列表加 fallback beta。
	if (shouldUseServerSideFallbackBeta(model)) features.push(SERVER_SIDE_FALLBACK_BETA);
	// 管理 effort 能力精确开启就加两个 beta，不要求此次实际启用 effortMessages。
	if (model.compat?.supportsMidConvoEffort === true) {
		// 分别支持中途输出配置和思考块绑定控制。
		features.push(MID_CONVERSATION_OUTPUT_CONFIG_BETA, THINKING_BINDING_CONTROLS_BETA);
	}
	// 原生工具变更模式才加 inline-tools 标识。
	if (nativeToolChanges) features.push(INLINE_TOOLS_BETA);
	// 最后去重；只构造 params.betas，SDK 会把它移到 HTTP 头而非 JSON body。
	return [...new Set(features)];
}

/**
 * 将完整规范化历史、OAuth 形状和原生选项转换为请求及附加状态，不发网络；历史/工具 schema 转换可能抛错。
 * 流程：缓存/首系统/跨模型历史→工具策略和 strict 资格→消息+档位→系统身份/温度/工具→思考/元数据/选择/fallback。
 * 例初始 read 后追加 write，支持原生变更且初始有工具时顶层保持初始工具+占位，write 按值写历史 tool_addition，减少前缀重写。
 * 缓存只是请求断点配置，不保证全部前缀命中；管理 effort 与 forceAdaptiveThinking 是不同能力条件，disabled 也需 off 映射允许。
 */
function buildParams(
	// 模型决定协议能力、成本身份与默认上限。
	model: Model<"anthropic-messages">,
	// 传入已规范化完整会话，开头 system 作为独立 params.system。
	context: TranscriptContext,
	// OAuth 形状影响系统身份/工具名字，不是重新验证 token。
	isOAuthToken: boolean,
	// 原生请求选项可省略。
	options?: AnthropicOptions,
	// 默认 false；一次特定服务器拒绝后 true 用于重建 prefer 工具 schema。
	disablePreferredStrictTools = false,
	// 返回多项构建信息，调用方据此记录档位/决定是否可降级。
): {
	// 实际 SDK 请求体/头选项的组合对象。
	params: MessageCreateParamsStreaming;
	// 构建阶段实际生成过 prefer strict 工具才为 true；外部 payload 钩子修改后不重新检测。
	hasPreferredStrictTools: boolean;
	/** Effort of the final effort marker, recorded on the reply so later requests can replay it. */
	// 管理 effort 模式当前标记档位供后续历史回放，其他情况 undefined。
	providerThinkingLevel: AnthropicEffort | undefined;
} {
	// 只使用 cacheControl 标记，不用返回的逻辑 retention 字段。
	const { cacheControl } = getCacheControl(model, options?.cacheRetention, options?.env);
	// 统一取得本地兼容默认。
	const compat = getAnthropicCompat(model);
	// 只有会话首项是 system 才视作初始系统消息，不搜索后续第一条 system。
	const initialSystemMessage = getInitialSystemMessage(context.messages);
	// 初始文字含内容和命名区段，缺初始 system 时空串。
	const initialSystemText = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	// 转换跨模型思考/工具 id、图片能力并补缺结果；normalizeToolCallId 仅对跨模型调用执行。
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	// 已有初始 system 时从转换历史去首项，因为它稍后放 params.system；其他系统更新仍在会话中处理。
	const conversationMessages = initialSystemMessage ? transformedMessages.slice(1) : transformedMessages;
	// Native tool changes keep the request-level tool list fixed and define every later tool
	// by value in a `tool_addition` block, which also expresses same-name redefinitions.
	// Anthropic rejects a tool list where every tool is deferred, so there must be an initial
	// active tool to anchor the placeholder. Otherwise the current tool list is sent.
	// 记录此构建过程中曾否产生可降级的 strict 工具；闭包调用会更新它。
	let hasPreferredStrictTools = false;
	/**
	 * 转换一批工具并累计是否存在真正输出 strict 的 prefer 工具，返回 beta 声明数组，修改闭包 hasPreferredStrictTools。
	 * 供顶层和历史 inline 新增共用；例 prefer 因本地关键词不支持已降级，则不会让该请求获得服务器限额自动降级资格；require 不计该资格。
	 */
	const convertToolDefinitions = (tools: Tool[], toolCacheControl?: CacheControlEphemeral): BetaTool[] => {
		// 把一批声明转换为 beta 工具，内部可能对 require 不支持抛错。
		const definitions = convertTools(
			// 本批工具按相同顺序转换，后面索引回查原声明。
			tools,
			// 按 OAuth 模式转兼容工具拼写。
			isOAuthToken,
			// 是否为每工具写 eager_input_streaming。
			compat.supportsEagerToolInputStreaming,
			// strict 支持能力默认 false。
			compat.supportsStrictTools,
			// 仅顶层最后工具可用该缓存标记，历史 inline 转换通常不传它。
			toolCacheControl,
			// 本轮是否已降级 prefer；require 仍保持约束。
			disablePreferredStrictTools,
		);
		// 检查本次转换出的声明中是否真正有 prefer strict。
		if (
			// some 找到第一项就短路。
			definitions.some(
				// 须输出 strict===true 且对应原声明为 prefer；仅 require 不触发自动降级资格。
				(definition, index) => definition.strict === true && prefersJsonSchemaStrictSampling(tools[index]),
			)
		) {
			// 闭包累计置 true，不因后续批次无 prefer 而重置。
			hasPreferredStrictTools = true;
		}
		// 返回本批新声明，schema 内部值可按 helper 约定复用，不承诺深复制。
		return definitions;
	};
	// 仅初始 system 的 toolsAdded 作为前缀固定工具，不自动替换成最终集合。
	const initialTools = initialSystemMessage?.toolsAdded ?? [];
	// 原生工具变更依三个条件组合，不只看某一个支持开关。
	const nativeToolChanges =
		// 系统消息支持、工具变化支持和初始至少一工具都要满足，避免只有 deferred 占位工具。
		compat.supportsMidConvoSystemMessages && compat.supportsMidConvoToolChanges && initialTools.length > 0;
	// 计算是否可以在本次明确禁用思考。
	const thinkingDisabled =
		// reasoning 模型、明确 false、且 off 映射不是 null 才算可关闭；undefined 也满足非 null。
		model.reasoning && options?.thinkingEnabled === false && model.thinkingLevelMap?.off !== null;
	// Effort cannot change between messages while thinking is disabled, so "off" sends no effort markers.
	// 管理 effort 能力开启且没有被确定关闭时保留/追加档位消息；此条件不再额外检查 model.reasoning。
	const effortMessages = model.compat?.supportsMidConvoEffort === true && !thinkingDisabled;
	// 把不含初始系统的对话转协议消息与历史档位索引。
	const converted = convertMessages(
		// 已经经跨模型转换的消息序列。
		conversationMessages,
		// 控制工具名字兼容。
		isOAuthToken,
		// 会话末项缓存断点配置。
		cacheControl,
		// 是否允许空签名仍作为 thinking，而不是转普通文字。
		compat.allowEmptySignature,
		// 仅管理 effort 时启用同供应商历史档位记录；并非按模型 id 筛档位。
		effortMessages ? model.provider : undefined,
		// 仅原生工具变更模式给 converter 处理 inline 定义的闭包。
		nativeToolChanges ? convertToolDefinitions : undefined,
	);
	// 原生 effort 未指定就取 high；管理模式也会用它生成当前标记。
	const activeEffort = options?.effort ?? "high";
	// 头显式覆盖优先，否则计算自动 beta 列表。
	const betaFeatures = getBetaFeatures(model, context, isOAuthToken, nativeToolChanges, options);
	// 组装新的 SDK streaming 参数对象，没有在此发请求。
	const params: MessageCreateParamsStreaming = {
		// 请求用目录 id，后备模型链另加 fallbacks。
		model: model.id,
		// 管理模式在历史对应 assistant 前插档位，最后再追加当前档位；否则直接转换后消息。
		messages: effortMessages ? insertThinkingLevelMessages(converted, activeEffort) : converted.messages,
		// ?? 保留 0，未给时用模型上限；原生入口不在此钳制到上下文空间。
		max_tokens: options?.maxTokens ?? model.maxTokens,
		// 默认要求流式响应，payload 回调仍可以原地改它。
		stream: true,
		// 非空 beta 列表才带 betas，安装 SDK 会把该属性转成 HTTP 头。
		...(betaFeatures.length > 0 ? { betas: betaFeatures } : {}),
	};

	// For OAuth tokens, we MUST include Claude Code identity
	// OAuth 兼容模式要给 params.system 固定身份段。
	if (isOAuthToken) {
		// 新建独立系统段数组，不插在普通会话 messages 首项。
		params.system = [
			// 先放固定身份段。
			{
				// 协议文本段标签。
				type: "text",
				// 保留原始身份提示文字，不代表本地真的变成另一客户端实现。
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				// 有缓存标记则连身份段也标记，none 时省略。
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		// 用户初始系统文字非空时再附第二段。
		if (initialSystemText) {
			// 追加初始系统内容，不覆盖身份段。
			params.system.push({
				// 段标签 text。
				type: "text",
				// 清理孤立代理码元，不翻译/摘要用户系统提示。
				text: sanitizeSurrogates(initialSystemText),
				// 这段也可带缓存标记。
				...(cacheControl ? { cache_control: cacheControl } : {}),
			});
		}
		// 非 OAuth 且初始文字非空才写独立 system 字段。
	} else if (initialSystemText) {
		// Add cache control to system prompt for non-OAuth tokens
		// 新建普通系统段数组。
		params.system = [
			// 单个文本段对象。
			{
				// 段标签 text。
				type: "text",
				// 用户初始系统正文先清理 Unicode。
				text: sanitizeSurrogates(initialSystemText),
				// 普通系统段也在有缓存配置时加断点。
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	// Temperature is incompatible with extended thinking and unsupported on Claude Opus 4.7+.
	// 以下温度条件必须全部成立，不只看 temperature 是否定义。
	if (
		// 0 温度也算明确提供，undefined 才省略。
		options?.temperature !== undefined &&
		// thinkingEnabled 为真时不发温度；undefined/false 可继续检查。
		!options?.thinkingEnabled &&
		// 只要声明 supportsMidConvoEffort=true 就省温度，即使本次 thinkingDisabled。
		model.compat?.supportsMidConvoEffort !== true &&
		// 最后还需模型声明支持温度字段。
		compat.supportsTemperature
	) {
		// 按原数值发送，不在这里检查数值区间。
		params.temperature = options.temperature;
	}

	// 工具缓存能力关闭时只禁工具声明断点，系统/会话断点仍可存在。
	const toolCacheControl = compat.supportsCacheControlOnTools ? cacheControl : undefined;
	// 原生工具变更模式的顶层工具表保持初始声明。
	if (nativeToolChanges) {
		// Initial tools stay active with the cache breakpoint on the last one, followed by the
		// placeholder. The list never changes afterwards: later tools are defined by value in
		// `tool_addition` blocks and withdrawn by `tool_removal`, so the cached prefix survives
		// every tool change.
		// 最后真实初始工具可带缓存标记，再附无缓存标记的 deferred 占位；后续变化放历史，不保证任意请求都会命中缓存。
		params.tools = [...convertToolDefinitions(initialTools, toolCacheControl), DEFERRED_TOOL_PLACEHOLDER];
		// 不满足原生变更条件时发最终活动工具集合。
	} else {
		// 按历史增删/重定义折叠出当前工具。
		const tools = getCurrentTools(context.messages);
		// 没有当前工具就省略 params.tools，不额外为旧工具历史补空数组。
		if (tools.length > 0) {
			// 转换当前集合并在允许时给最后一项加缓存标记。
			params.tools = convertToolDefinitions(tools, toolCacheControl);
		}
	}

	// 关闭思考优先于后面的管理 effort/adaptive/预算路径。
	if (thinkingDisabled) {
		// No effort is sent, so the model default applies. Anthropic rejects `block_binding`
		// with disabled thinking.
		// 明确发 disabled，不附 output_config 或 block_binding。
		params.thinking = { type: "disabled" };
		// 管理 effort 是另一条独立路径，不要求 forceAdaptiveThinking 标志。
	} else if (effortMessages) {
		// Managed effort models use adaptive thinking so prefix mismatches can
		// be dropped instead of surfacing as persistent 400 responses.
		// 开启 adaptive 并请求前缀不匹配时的远端处理。
		params.thinking = {
			// 固定 adaptive 类型。
			type: "adaptive",
			// 展示方式缺省 summarized，保留用户明确 omitted。
			display: options?.thinkingDisplay ?? "summarized",
			// 请求服务端丢不匹配思考块，并可由 input_transformations 报告；本地不在此做绑定校验/删除。
			block_binding: { prefix_mismatch_behavior: "drop_block" },
		};
		// Effort markers set the level for every reply. The top-level effort is part of the cached
		// prompt, so it stays fixed. It is "low" because organizations can cap effort and reject
		// requests containing any level above the cap.
		// 请求顶层 output_config.effort 固定 low，实际每轮档位由消息中的标记提供，旨在稳定缓存前缀。
		params.output_config = { effort: "low" };
		// 无管理 effort 时，目录 reasoning 且调用方请求开启才进入普通思考路径。
	} else if (model.reasoning && options?.thinkingEnabled) {
		// Default to "summarized" so Opus 4.7 and Mythos Preview behave like
		// older Claude 4 models (whose API default is also "summarized").
		// 此适配统一默认 summarized，不直接依赖各模型服务端默认。
		const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? "summarized";
		// forceAdaptiveThinking 必须精确 true，不按名称猜。
		if (model.compat?.forceAdaptiveThinking === true) {
			// Adaptive thinking: Claude decides when and how much to think.
			// adaptive 不发送固定 token 预算。
			params.thinking = { type: "adaptive", display };
			// 只有 effort 真值时才发送请求级 output_config。
			if (options.effort) {
				// 使用用户/简单入口映射后的原生档位，不在这里再次校验支持范围。
				params.output_config = { effort: options.effort };
			}
			// 其余按旧式预算思考格式。
		} else {
			// Budget-based thinking for older models
			// 新建 enabled 配置对象。
			params.thinking = {
				// 固定类型 enabled。
				type: "enabled",
				// || 使未给/0/NaN 回退 1024，负数仍会保留；本行未验证预算>=1024 且小于 max_tokens。
				budget_tokens: options.thinkingBudgetTokens || 1024,
				// 对象属性简写，采用前面解析的展示方式。
				display,
			};
		}
	}

	// 只提取理解的元数据字段，其他通用 metadata 键忽略。
	if (options?.metadata) {
		// metadata 的值是 unknown，user_id 仍需边界类型检查。
		const userId = options.metadata.user_id;
		// 只有字符串才发，空串也通过，不 trim。
		if (typeof userId === "string") {
			// 新建仅含 user_id 的对象，不透传任意 metadata。
			params.metadata = { user_id: userId };
		}
	}

	// 有工具选择才构造协议字段。
	if (options?.toolChoice) {
		// 联合类型用 typeof 区分字符串与指定工具对象。
		if (typeof options.toolChoice === "string") {
			// auto/any/none 字符串包装为 {type:...}。
			params.tool_choice = { type: options.toolChoice };
			// 指定工具对象走透传路径。
		} else {
			// 原样采用对象，包括名称，不在这里做 OAuth 工具名规范化。
			params.tool_choice = options.toolChoice;
		}
	}

	// 读取模型允许的后备模型链。
	const allowedFallbackModels = model.compat?.allowedFallbackModels;
	// 只有非空链才发送 fallbacks。
	if (allowedFallbackModels && allowedFallbackModels.length > 0) {
		// 发请求只投影 model 名，provider/cost 留本地用于计价匹配，不在请求里透传。
		params.fallbacks = allowedFallbackModels.map((fallback) => ({ model: fallback.model }));
	}

	// 返回请求、实际 prefer strict 资格和管理档位；无管理模式不记录 providerThinkingLevel。
	return { params, hasPreferredStrictTools, providerThinkingLevel: effortMessages ? activeEffort : undefined };
}

// Normalize tool call IDs to match Anthropic's required pattern and length
/**
 * 清理跨模型工具调用 id，返回新字符串，无状态修改。
 * 非法字符替下划线后截 64；例 call|x→call_x。transformMessages 仅在跨模型工具调用时使用，不保证清理/截断后无碰撞或非空。
 */
function normalizeToolCallId(id: string): string {
	// 全局替换非法字符为下划线再取前 64 个 UTF-16 单元；可能为空/碰撞，不保证 id 唯一。
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/**
 * 把统一工具结果转 Anthropic tool_result 内容块，返回新对象，不执行工具。
 * 输入消息及可选正文覆盖，省略/undefined 正文回退 msg.content；例错误图片拆分后以纯文字覆盖，并仍保持原调用 id/is_error。
 */
function convertToolResult(msg: ToolResultMessage, content = msg.content): ContentBlockParam {
	// 构造协议工具结果对象，不调用真实工具。
	return {
		// 统一结果角色通过内容块 tool_result 表达，外层消息角色是 user。
		type: "tool_result",
		// 使用已按目标需要转换的调用 id 配对。
		tool_use_id: msg.toolCallId,
		// 正文可用拆图后的覆盖数组，未传/undefined 默认参数会回退 msg.content。
		content: convertContentBlocks(content),
		// 保留结果错误标志，用于服务端识别失败工具输出。
		is_error: msg.isError,
	};
}

// 消息转换同时返回可供历史 effort 插入使用的位置索引。
interface ConvertedAnthropicMessages {
	// 已经转换好的 Anthropic 消息数组。
	messages: MessageParam[];
	// 键是转换后 assistant 在 messages 中的位置，不是原始历史下标。
	assistantLevels: Map<number, AnthropicEffort>;
}

/**
 * 把去掉首条系统后的统一历史转为 Anthropic 消息及 assistant 档位索引，不发网络。
 * 逐角色转换：后续 system 暂存到下个有效 assistant 前/末尾，用户过滤空白，assistant 保留可用思考/调用，连续工具结果合一条 user，错误图片放所有结果后。
 * 例 system 更新夹在调用与结果之间不会直接插入配对中间；纯空白 assistant 被跳过时，system 继续等到后面的有效回复或末尾。
 * 会建协议对象、收集档位并给最后 user/system 的末个合格块加缓存标记；只看末项，不向前搜索。参数对象/图片字符串等可复用引用，不改持久会话。
 */
function convertMessages(
	// 已做跨模型/图片/工具配对转换，并去掉首条初始系统的消息列表。
	transformedMessages: Message[],
	// 控制工具名是否使用 Claude Code 规范拼写。
	isOAuthToken: boolean,
	// 可选缓存断点配置，不直接操作服务端缓存。
	cacheControl?: CacheControlEphemeral,
	// 默认不接受空签名作为原生思考块，但可降级为文本。
	allowEmptySignature = false,
	// 只有指定此供应商名才记录其有效历史档位；没有目标模型 id 参数。
	managedProvider?: string,
	/** Converts tool definitions for native `tool_addition` blocks; undefined when tool changes are not native. */
	// 可选函数类型：输入工具数组返回声明数组，未传时不发原生新增/移除块。
	convertToolDefinitions?: (tools: Tool[]) => BetaTool[],
	// 返回协议消息与档位 Map，新建顶层容器，内容参数仍可复用引用。
): ConvertedAnthropicMessages {
	// 新协议消息输出数组。
	const params: MessageParam[] = [];
	// 记录历史 assistant 档位的转换后位置。
	const assistantLevels = new Map<number, AnthropicEffort>();
	// Later system messages are held back and emitted directly before the next assistant
	// message that is sent (or at the end of the transcript). Assistant messages that convert to
	// no blocks are dropped, so holding past them keeps an update from landing before a user
	// message (#11091). Anthropic requires `tool_result` blocks to
	// immediately follow their `tool_use`, so a system message between them is rejected; this
	// also mirrors where the managed-effort system messages are inserted. As a result an
	// update placed before a user message in the transcript lands after it on the wire.
	// 后续 system 暂存，直到下一个实际发出的非空 assistant 前或会话末尾才释放。
	const pendingSystemMessages: MessageParam[] = [];
	/**
	 * 把暂存系统消息按顺序追加到结果并清队列，返回 void，会修改闭包中的 params/pendingSystemMessages。
	 * 例两个更新等到下条有效 assistant 前一次释放；每个更新本身的相对顺序保留。
	 */
	const flushPendingSystemMessages = (): void => {
		// 数组展开按原顺序追加待发送系统更新。
		params.push(...pendingSystemMessages);
		// 原地清同一待发送队列，防重复输出。
		pendingSystemMessages.length = 0;
	};

	// 按转换后输入顺序扫描；连续工具结果分支会推进外层 i。
	for (let i = 0; i < transformedMessages.length; i++) {
		// role 判别联合决定后续正文形状。
		const msg = transformedMessages[i];

		// 这里只处理后续系统更新，初始 system 已在上游单独去掉。
		if (msg.role === "system") {
			// Later system messages only reach this point when the model accepts them natively;
			// otherwise the transcript was collapsed into the leading message before conversion.
			// 渲染正文、区段变更及工具移除说明，文字提示并不等于本地工具执行权限。
			const text = renderSystemMessageUpdate(msg);
			// 每条系统更新创建自己的协议内容块列表。
			const blocks: ContentBlockParam[] = [];
			// 非空渲染文字加一个清理 Unicode 后的 text 段。
			if (text.length > 0) blocks.push({ type: "text", text: sanitizeSurrogates(text) });
			// 有原生转换函数才发工具变化块；否则即使有增删也只按文字/顶层当前列表处理。
			if (convertToolDefinitions) {
				// 本条新增工具默认空数组，不代表全量活动工具。
				const added = msg.toolsAdded ?? [];
				// 新增名称集合用于识别同消息内的同名重定义，比较区分大小写。
				const redefined = new Set(added.map((tool) => tool.name));
				// 按 toolsRemoved 列表顺序处理撤销项。
				for (const tool of msg.toolsRemoved ?? []) {
					// A new definition under the same name replaces the old one, so no removal is needed.
					// 同条同时重新定义的原名字不另发 removal；原生 addition 按值替换旧定义。
					if (redefined.has(tool.name)) continue;
					// 其他撤销项建立协议块。
					blocks.push({
						// 标签 tool_removal，不执行磁盘/应用工具删除动作。
						type: "tool_removal",
						// 按名称引用旧工具，OAuth 时才规范拼写，服务端可据协议撤销后续可见声明。
						tool: { type: "tool_reference", name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name },
					});
				}
				// 新增工具按值转换，仍共享 strict/eager 规则及本轮 prefer 降级状态。
				for (const definition of convertToolDefinitions(added)) {
					// tool_definition 包完整工具定义，而非仅引用顶层同名声明。
					blocks.push({ type: "tool_addition", tool: { type: "tool_definition", definition } });
				}
			}
			// 有文字/工具块才暂存系统消息，不立刻发到可能夹在调用与结果的位置。
			if (blocks.length > 0) pendingSystemMessages.push({ role: "system", content: blocks });
			// 用户消息直接转换，不在这里冲刷待发 system。
		} else if (msg.role === "user") {
			// 原有 typeof 区分字符串与块数组，非额外外部 schema 检查。
			if (typeof msg.content === "string") {
				// 完全空/纯空白用户字符串跳过，非空正文的实际空白不 trim。
				if (msg.content.trim().length > 0) {
					// 把原字符串变成一条协议用户消息。
					params.push({
						// 角色 user。
						role: "user",
						// 清理孤立代理码元，不改正文结构。
						content: sanitizeSurrogates(msg.content),
					});
				}
				// 块数组路径逐项转文字/图片。
			} else {
				/**
				 * 将一项用户文字/图片转换为新协议块，无网络/输入修改。
				 * 文字清理孤立代理码元，图片包装已有 base64；例纯图片用户消息无需在此强制添加文字占位。
				 */
				// map 为每项建立协议内容块，不修改原输入块。
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					// 文字判别分支。
					if (item.type === "text") {
						// 返回新文本段。
						return {
							// 标签 text。
							type: "text",
							// 保留文字值，仅做 Unicode 清理。
							text: sanitizeSurrogates(item.text),
						};
						// 剩余联合项为图片。
					} else {
						// 图片通过 MIME 断言与 base64 源包装，不实际验证图像。
						return convertImageBlock(item);
					}
				});
				/**
				 * 判断用户协议块是否值得保留，返回 boolean，无修改。
				 * 文字去空白后非空才保留，图片保留；例 "   " 被筛掉，而其相邻图片仍在。
				 */
				// 转完后再去空白文字段，图片无论有无说明都保留。
				const filteredBlocks = blocks.filter((b) => {
					// 只有 text 段需要空白检查。
					if (b.type === "text") {
						// trim 只作筛选，不替换保留文字正文。
						return b.text.trim().length > 0;
					}
					// 图片等非 text 段保留。
					return true;
				});
				// 过滤后为空则跳过整条用户消息，仍不冲刷 system 队列。
				if (filteredBlocks.length === 0) continue;
				// 把保留块作为同一 user 消息正文。
				params.push({
					// 角色 user。
					role: "user",
					// 使用过滤结果数组。
					content: filteredBlocks,
				});
			}
			// assistant 需要按内容类型处理文字、思考签名与工具调用。
		} else if (msg.role === "assistant") {
			// 每条 assistant 新建一个块数组，保留有效块的相对顺序。
			const blocks: ContentBlockParam[] = [];

			// 逐原始块处理，不把所有同类型文字强制合并成一块。
			for (const block of msg.content) {
				// 普通文字回放。
				if (block.type === "text") {
					// 全空白段丢弃，不发送 API 易拒绝的空文字。
					if (block.text.trim().length === 0) continue;
					// 有效文字转成新协议段。
					blocks.push({
						// 标签 text。
						type: "text",
						// 仅清理孤立代理码元，不 trim 保留正文。
						text: sanitizeSurrogates(block.text),
					});
					// 思考块是否原生回放取决于隐藏标记和签名。
				} else if (block.type === "thinking") {
					// Redacted thinking: pass the opaque payload back as redacted_thinking
					// 隐藏思考优先，不读取可见占位当真实原文。
					if (block.redacted) {
						// 构造不透明隐藏思考段。
						blocks.push({
							// 标签 redacted_thinking。
							type: "redacted_thinking",
							// ! 只是非空断言，依赖 redacted 块应携带签名的内部约定，不做运行时验证。
							data: block.thinkingSignature!,
						});
						// 已处理隐藏块，不落进普通签名分支。
						continue;
					}
					// 取普通思考签名，可能缺省。
					const thinkingSignature = block.thinkingSignature;
					// 有真值且 trim 后非空才视为可回放签名，实际发送原始未 trim 字符串。
					const hasThinkingSignature = !!thinkingSignature && thinkingSignature.trim().length > 0;
					// 原文也空且无有效签名就丢块；有签名的空原文仍可保留。
					if (block.thinking.trim().length === 0 && !hasThinkingSignature) continue;
					// If thinking signature is missing/empty (e.g., from aborted stream),
					// convert to plain text for Anthropic. Some compatible providers emit
					// and accept empty signatures, so let marked models preserve the block.
					// 缺/空白签名时根据兼容配置决定保留 thinking 还是改 text。
					if (!hasThinkingSignature) {
						// 按条件把一个新段加入数组。
						blocks.push(
							// allowEmptySignature 只是本地兼容策略，不证明远端一定接受。
							allowEmptySignature
								? // 开启兼容时构造原生思考块。
									{
										// 标签 thinking。
										type: "thinking",
										// 可读思考文字先清理 Unicode。
										thinking: sanitizeSurrogates(block.thinking),
										// 签名明确为空串，原来的纯空白签名不会保留。
										signature: "",
									}
								: // 默认路径把无签名思考作为普通文字。
									{
										// 标签 text，所以模型能把它当可见历史正文。
										type: "text",
										// 同样清理孤立代理码元。
										text: sanitizeSurrogates(block.thinking),
									},
						);
						// 有有效签名时保留原生 thinking 结构。
					} else {
						// 创建原生思考段。
						blocks.push({
							// 标签 thinking。
							type: "thinking",
							// 清理思考文字后回放；此处不对远端签名做本地验签/重新签名。
							thinking: sanitizeSurrogates(block.thinking),
							// 签名原样传，不 trim，不解密。
							signature: thinkingSignature,
						});
					}
					// 历史工具调用转 tool_use，不在这里执行。
				} else if (block.type === "toolCall") {
					// 创建调用协议段。
					blocks.push({
						// 标签 tool_use。
						type: "tool_use",
						// 采用 transformMessages 按需要转换后的 id。
						id: block.id,
						// OAuth 时已知名字转规范拼写，未知名保留。
						name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
						// 参数对象按引用使用，空值回退 {}；不把 argumentsError 当作重新执行指令。
						input: block.arguments ?? {},
					});
				}
			}
			// 整条 assistant 没有效块就跳过，待发 system 继续保留到下一条有效 assistant/末尾。
			if (blocks.length === 0) continue;
			// 真正发送 assistant 前才冲刷所有待发系统更新，不夹在它后面的工具结果之间。
			flushPendingSystemMessages();
			// 先取该 assistant 将占据的协议下标，包含刚冲刷 system 对位置的影响。
			const messageIndex = params.length;
			// 追加实际 assistant 消息。
			params.push({
				// 角色 assistant。
				role: "assistant",
				// 正文是已筛/转的块数组。
				content: blocks,
			});
			// 满足下面条件才为这条历史记录档位。
			if (
				// 调用方已启用管理供应商档位模式。
				managedProvider !== undefined &&
				// 历史 API 必须精确 anthropic-messages。
				msg.api === "anthropic-messages" &&
				// 供应商必须匹配，但这里不要求 msg.model 与当前模型 id 相同。
				msg.provider === managedProvider &&
				// 运行时精确检查五种 effort 字符串，未知/缺省值不生成标记。
				isAnthropicEffort(msg.providerThinkingLevel)
			) {
				// 以转换后 assistant 位置记录档位，供后面插 system.output_config。
				assistantLevels.set(messageIndex, msg.providerThinkingLevel);
			}
			// 把一批连续工具结果合并到同一个 user 内容数组。
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint.
			// 先收所有工具结果块，确保配对结果在图片说明前。
			const toolResults: ContentBlockParam[] = [];
			// Anthropic rejects error tool results that contain anything but text, so their images follow
			// all tool results of the turn, which must come first in the user message (#10794).
			// 错误结果拆出的图片单独收集；正常工具结果图仍可留在各自 tool_result 里。
			const errorImages: ContentBlockParam[] = [];
			// j 作为批次扫描索引，从当前外层位置开始。
			let j = i;
			// 只收相邻 toolResult，不越过其他角色消息。
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				// 条件已按 role 确认，as 不增加运行时验证。
				const toolMsg = transformedMessages[j] as ToolResultMessage;
				// 只有含图错误结果才拆纯文字结果+图片，其他返回 undefined。
				const split = splitErrorToolResultImages(toolMsg);
				// split?.content 为 undefined 时默认参数回到原内容；否则用拆图后的文字结果。
				toolResults.push(convertToolResult(toolMsg, split?.content));
				// 确有拆图才追加后置图片说明。
				if (split) {
					// 每组先带指明调用 id/name 的 caption，再按原顺序转图片；全部在工具结果之后发送。
					errorImages.push({ type: "text", text: split.caption }, ...split.images.map(convertImageBlock));
				}
				// 推进扫描下标。
				j++;
			}

			// Skip the messages we've already processed.
			// 设 i=j-1，外层自增后恰好跳过已处理批次。
			i = j - 1;

			// 新建一条承载全部结果的用户消息。
			params.push({
				// Anthropic 工具结果放 user 角色，不单独用 tool 角色。
				role: "user",
				// 先展开所有 tool_result，再展开错误结果图片/说明，不改它们批次内相对顺序。
				content: [...toolResults, ...errorImages],
			});
		}
	}

	// 会话结束也释放待发 system；没有后续有效 assistant 时落到全部历史末尾。
	flushPendingSystemMessages();

	// Add cache_control to the last user or system message to cache conversation history
	// 有缓存配置且至少一条协议消息才考虑会话断点。
	if (cacheControl && params.length > 0) {
		// 只看整个结果数组最后一条，不向前搜索最近 user/system。
		const lastMessage = params[params.length - 1];
		// 末条必须 user 或 system，末条 assistant 时这里完全不加会话断点。
		if (lastMessage.role === "user" || lastMessage.role === "system") {
			// 正文数组只看其末块，不倒序搜索最后可标记块。
			if (Array.isArray(lastMessage.content)) {
				// 取末块；空数组会得到 undefined。
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				// 同时要求末块存在且属于下面五种支持类型。
				if (
					// 空块数组不写标记。
					lastBlock &&
					// 文字末块可标记。
					(lastBlock.type === "text" ||
						// 图片末块也可标记，区别只许文字的某些兼容路径。
						lastBlock.type === "image" ||
						// 工具结果末块可标记。
						lastBlock.type === "tool_result" ||
						// 原生工具新增末块可标记，标在 addition 块而非 inline definition 上。
						lastBlock.type === "tool_addition" ||
						// 原生工具移除末块也可标记。
						lastBlock.type === "tool_removal")
				) {
					// 原有 any 允许兼容字段原地写入协议块，没有建立真实本地缓存。
					(lastBlock as any).cache_control = cacheControl;
				}
				// 末条正文为字符串时改成单一文字段数组以挂标记。
			} else if (typeof lastMessage.content === "string") {
				// 替换这条新协议消息的 content，不改用户原始消息 content。
				lastMessage.content = [
					// 创建新段对象。
					{
						// 标签 text。
						type: "text",
						// 保留末条原字符串值。
						text: lastMessage.content,
						// 附同一缓存配置引用。
						cache_control: cacheControl,
					},
					// 原有 any 只绕 SDK 类型限制，不验证服务器是否支持该标记。
				] as any;
			}
		}
	}

	// 返回协议数组和历史档位索引，无网络请求。
	return { messages: params, assistantLevels };
}

/**
 * 验证未知历史值是否为本地允许的五种 Anthropic effort，返回类型谓词，无修改。
 * 例 xhigh/max 通过，minimal/任意别名不通过；不代表这些档位对所有远端模型都可用。
 */
function isAnthropicEffort(value: unknown): value is AnthropicEffort {
	// unknown 边界用五个精确字符串比较，类型谓词通过后可当 AnthropicEffort。
	return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

/**
 * 在转换好的消息前插历史思考档位、末尾加当前档位，返回新数组，无网络，不改原数组/Map。
 * 只在 assistantLevels 记录的位置前插空正文 system.output_config；例旧 low 回复前放 low，最后再放当前 high，不去重相邻相同档位。
 */
function insertThinkingLevelMessages(
	// 转换后的消息与 assistant 位置→档位表。
	converted: ConvertedAnthropicMessages,
	// 本次希望使用的当前原生档位，不在这里重新映射。
	activeEffort: AnthropicEffort,
	// 返回新数组；原消息对象仍复用，不做深复制。
): MessageParam[] {
	// 新建最终带档位标记的消息序列。
	const messages: MessageParam[] = [];
	// 按转换后消息位置扫描，索引对应 assistantLevels 的键。
	for (let index = 0; index < converted.messages.length; index++) {
		// 查该位置是否有合法历史档位。
		const historicalEffort = converted.assistantLevels.get(index);
		// 未记录则不为旧消息发明一个档位。
		if (historicalEffort !== undefined) {
			// 有记录就先插无正文的 system.output_config 标记，再跟其历史 assistant。
			messages.push({ role: "system", content: [], output_config: { effort: historicalEffort } });
		}
		// 复用原转换消息对象加入新数组。
		messages.push(converted.messages[index]);
	}
	// 最后始终追加当前档位标记，即使与最后历史档位相同或没有普通消息。
	messages.push({ role: "system", content: [], output_config: { effort: activeEffort } });
	// 返回包含插入项的新数组，不修改 converted.messages/Map。
	return messages;
}

/**
 * 决定是否请求旧 fine-grained 工具输入 beta，返回 boolean，无副作用。
 * 当前工具非空且 eager 能力关闭才 true；例历史 read 已被移除且最终工具为空时 false，不因为曾有 read 而加 beta。
 */
function shouldUseFineGrainedToolStreamingBeta(
	// 模型提供 eager 流兼容默认。
	model: Model<"anthropic-messages">,
	// 会话用来计算最终当前工具，不看初始工具是否曾存在。
	context: TranscriptContext,
	// 返回 boolean 决定是否请求旧 beta 标识。
): boolean {
	// 必须有当前活动工具且 eager 支持为 false 才走旧 beta，历史曾有工具不够。
	return getCurrentTools(context.messages).length > 0 && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}

// Keywords Anthropic strict tool use rejects with a 400 for the whole request.
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations
// 本地维护的 strict 不支持关键词集，不在线同步官方限制，也不作一般工具参数验证。
const ANTHROPIC_STRICT_UNSUPPORTED_KEYWORDS = new Set([
	// 数值包含下限约束。
	"minimum",
	// 数值包含上限约束。
	"maximum",
	// 数值排他下限约束。
	"exclusiveMinimum",
	// 数值排他上限约束。
	"exclusiveMaximum",
	// 数值整倍数约束。
	"multipleOf",
	// 数组最大项数约束。
	"maxItems",
	// 数组唯一项约束。
	"uniqueItems",
	// contains 匹配项最少数量约束。
	"minContains",
	// contains 匹配项最多数量约束。
	"maxContains",
	// 对象最少属性数约束。
	"minProperties",
	// 对象最多属性数约束；minItems/format 另有按值检查。
	"maxProperties",
]);
// strict 路径只允许这些字符串 format 名，不自行校验用户数据真符合格式。
const ANTHROPIC_STRICT_STRING_FORMATS = new Set([
	// 日期加时间格式名。
	"date-time",
	// 时间格式名。
	"time",
	// 日期格式名。
	"date",
	// 持续时长格式名。
	"duration",
	// 电子邮件格式名。
	"email",
	// 主机名格式名。
	"hostname",
	// URI 格式名。
	"uri",
	// IPv4 格式名。
	"ipv4",
	// IPv6 格式名。
	"ipv6",
	// UUID 格式名；不在列表的 regex 等会被本地 strict 支持检查拒绝。
	"uuid",
]);

/**
 * 为共享 strict schema 遍历提供 Anthropic 专有限制判断，输入键/值，返回是否不支持，无副作用。
 * 集合键一律拒绝，minItems 只接受数值 0/1，format 只接受固定名单字符串；例 minItems=2 或 format=regex 使 prefer 可本地降级，require 由 resolver 报错。
 */
const isAnthropicStrictUnsupportedKeyword: UnsupportedStrictSchemaKeywordCheck = (key, value) => {
	// 集合中的键不管取值如何都视为 strict 不支持。
	if (ANTHROPIC_STRICT_UNSUPPORTED_KEYWORDS.has(key)) return true;
	// minItems 只允许数值恰为 0 或 1；字符串 "1" 不等于数字 1。
	if (key === "minItems") return value !== 0 && value !== 1;
	// format 必须是允许列表内字符串，其他值都视为不支持。
	if (key === "format") return typeof value !== "string" || !ANTHROPIC_STRICT_STRING_FORMATS.has(value);
	// 只表示此键值未被本地专有检查排除，不保证整个 schema 或服务器一定接受。
	return false;
};

/**
 * 将工具声明转 beta 工具，返回新数组，无网络/工具执行；不支持 require 约束可抛错。
 * 先本轮 prefer 降级/strict 检查→选择 strict 或原 schema→构造根对象→名称/说明/eager/strict/末工具缓存标记。
 * 例普通工具只保留根 type/properties/required/$defs/definitions，strict 工具先展开完整转换 schema，再用本地根字段覆盖；嵌套 schema 可复用引用。
 */
function convertTools(
	// 统一工具声明数组，类型要求存在；下方保留既有无值兜底行为。
	tools: Tool[],
	// OAuth 模式影响工具名规范拼写。
	isOAuthToken: boolean,
	// 控制 per-tool eager_input_streaming，false 时省略字段而不是显式发送 false。
	supportsEagerToolInputStreaming: boolean,
	// 是否允许 strict JSON schema 工具路径。
	supportsStrictTools: boolean,
	// 可给最后一项挂缓存控制，本批其他项不加。
	cacheControl?: CacheControlEphemeral,
	// 只关闭 prefer 的 strict，require 仍按能力/关键词检查。
	disablePreferredStrictTools = false,
	// 返回新 SDK 工具声明数组，不运行工具。
): BetaTool[] {
	// 保留原有无值分支；TypeScript 合约中 tools 是必需数组，正常类型调用无需它兜底。
	if (!tools) return [];

	/**
	 * 转换一项工具并按本批索引决定是否附缓存断点，返回新声明，无外部顶层修改。
	 * 例第 2/2 个工具有 cacheControl 才带标记，strict=prefer 因服务器限额已降级时使用原 schema，require 不自动关闭。
	 */
	// 逐项转换并取得本批位置，以给最后工具加断点。
	return tools.map((tool, index) => {
		// 先确定本工具本轮 strict 策略。
		const strict =
			// 已经服务器降级且声明是 prefer 才在这里直接关 strict。
			disablePreferredStrictTools && prefersJsonSchemaStrictSampling(tool)
				? // undefined 表示按普通 schema 路径，不发送 strict:false。
					undefined
				: // 其余（含 require）走共享 resolver，能力/专有关键词不可满足时可能抛错或 prefer 降级。
					resolveJsonSchemaStrictSampling(tool, supportsStrictTools, isAnthropicStrictUnsupportedKeyword);
		// strict=true 时取/转换适合 strict 的 schema，否则使用原参数 schema。
		const parameters = getJsonSchemaToolParameters(tool, strict);
		// 静态只声明本分支要读的字段，不构建新 schema 或验证原始对象结构。
		const schema = parameters as {
			// properties 可缺省，保留 unknown 形状供协议原样表达。
			properties?: unknown;
			// required 静态约定字符串数组。
			required?: string[];
			// 新版共享定义容器。
			$defs?: unknown;
			// 旧版共享定义容器，供已有 $ref 引用。
			definitions?: unknown;
		};
		// Keep shared definitions so property $refs still resolve. Other root keywords stay out:
		// Anthropic rejects root anyOf/oneOf/allOf with a 400.
		// 普通 schema 只选根 type/properties/required/两类定义，不带其他根关键字。
		const legacyInputSchema = {
			// 强制根是 object 的协议形状，不在此把非对象实际参数自动转对象。
			type: "object" as const,
			// 空值 properties 回退新空对象。
			properties: schema.properties ?? {},
			// 空值 required 回退空数组；已有数组保持原引用。
			required: schema.required ?? [],
			// $defs 只在 undefined 时省略，其他值原样保留，避免丢掉属性引用依赖。
			...(schema.$defs === undefined ? {} : { $defs: schema.$defs }),
			// definitions 同样保留，使旧 #/definitions 引用还能随声明发送。
			...(schema.definitions === undefined ? {} : { definitions: schema.definitions }),
		};
		// strict 与普通路径选择不同的根字段保留策略。
		const inputSchema =
			// 仅精确 true 才保留完整 strict 参数根结构。
			strict === true
				? // strict 路径新建合并对象。
					{
						// 先展开完整参数 schema，包括标题、附加属性限制等根键。
						...(parameters as Record<string, unknown>),
						// 再覆盖本地规范根 type/properties/required/定义，不等于一概删除 root anyOf 等额外键。
						...legacyInputSchema,
					}
				: // 非 strict 仅使用精简 legacyInputSchema。
					legacyInputSchema;

		// 创建新的 beta 工具顶层声明。
		return {
			// OAuth 模式按已知表规范工具名；自定义工具名不强制改。
			name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
			// 描述原样保留，不改模型提示词。
			description: tool.description,
			// 支持 eager 才写 true，否则省略，不默认写 false。
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			// strict=true 才附 strict:true，其余完全省略。
			...(strict === true ? { strict: true } : {}),
			// 采用上面选好的 schema，可有内部引用复用。
			input_schema: inputSchema,
			// 传了缓存标记且这是最后工具才加；inline 批次未传配置就不加定义内断点。
			...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
		};
	});
}

/**
 * 映射 Anthropic 停止原因，返回统一状态/错误或对未知原因抛错，纯函数不发新请求。
 * end_turn/pause_turn/stop_sequence→stop，max_tokens→length，tool_use→toolUse，refusal/sensitive→error。
 * 例 refusal 的 explanation 非空时作为错误文字；pause_turn 只映射 stop，重新提交必须由上层另做。
 */
function mapStopReason(
	// SDK 原因联合加 string，兼容尚未被 SDK 收录的供应商原因。
	reason: BetaStopReason | string,
	// 可选拒绝详情允许 null，用其 explanation 提供更具体错误。
	stopDetails?: RefusalStopDetails | null,
	// 返回统一原因及可选错误文字，未知原因会抛，不默认宽松 stop。
): { stopReason: StopReason; errorMessage?: string } {
	// 逐原始停止码分支映射。
	switch (reason) {
		// end_turn 是自然结束。
		case "end_turn":
			// 映射 stop，不代表 Agent 后续绝不继续处理队列。
			return { stopReason: "stop" };
		// 达到最大 token 上限。
		case "max_tokens":
			// 映射 length，保留被截断语义。
			return { stopReason: "length" };
		// 模型提出工具调用。
		case "tool_use":
			// 映射 toolUse，真实执行不在这里。
			return { stopReason: "toolUse" };
		// 拒绝请求视作错误，不作为成功回答。
		case "refusal":
			// 返回拒绝错误结构。
			return {
				// 统一 error。
				stopReason: "error",
				// 非空 explanation 优先，否则固定拒绝文字；不在本地重新判断拒绝原因。
				errorMessage: stopDetails?.explanation || `The model refused to complete the request`,
			};
		// pause_turn 用 stop 表达，实际是否重新提交由上层决定，本函数不发下一请求。
		case "pause_turn": // Stop is good enough -> resubmit
			// 返回 stop。
			return { stopReason: "stop" };
		// 服务端停止序列匹配。
		case "stop_sequence":
			// 同样映射 stop；即使本适配没主动配置停止序列，也保留兼容处理。
			return { stopReason: "stop" }; // We don't supply stop sequences, so this should never happen
		// 供应商敏感内容过滤扩展原因。
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			// 统一 error 并附描述，不做流级自动重试。
			return { stopReason: "error", errorMessage: "Provider stopped with: sensitive" };
		// 未识别原因不静默通过。
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			// 抛明确错误交外层 catch，因此原始原因可在 errorMessage 中显示。
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}
