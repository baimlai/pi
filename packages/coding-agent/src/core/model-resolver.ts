// 解析模型名字、循环范围、CLI 选择和会话恢复；main/SDK/会话用这里的结果决定选谁，真正请求和认证由 ModelRuntime 负责。
// 重点区分模型 id 内部的斜杠/冒号与 provider/id、:high 语法；候选身份和认证配置快照不能等同于云端实际可调用。
/**
 * Model resolution, scoping, and initial selection
 */

// 仅导入思考档位类型；它与下面模型字符串末尾的 :high 等后缀对应。
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
// 从 ai 包导入模型/API 等类型，以及实际运行的 modelsAreEqual 比较函数。
import {
	type Api,
	type AuthOperationOptions,
	type KnownProvider,
	type Model,
	modelsAreEqual,
} from "@earendil-works/pi-ai";
// chalk 为 CLI 警告/状态文字加颜色；核心纯匹配函数不依赖终端输出。
import chalk from "chalk";
// minimatch 做通配符匹配；nocase:true 使这里的通配模式不区分大小写。
import { minimatch } from "minimatch";
// 复用 CLI 对合法思考档位的类型谓词，避免自行维护第二份字符串名单。
import { isValidThinkingLevel } from "../cli/args.ts";
// 读取共享默认思考档位，解析失败或没有专门配置时使用。
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
// import type 仅约束模型目录/认证快照接口，不在这行构造运行时实例。
import type { ModelRuntime } from "./model-runtime.ts";

/** Default chat model IDs for providers with built-in chat models. */
/**
 * 供应商→首选模型 id 的本地候选表；不是动态云端目录，也不表示这些模型已配置认证。
 * Partial<Record<KnownProvider,string>>：KnownProvider 的每个键都可以省略。后面按表的插入顺序寻找当前可用的默认候选。
 */
export const defaultModelPerProvider: Partial<Record<KnownProvider, string>> = {
	// Bedrock 的候选 id 带区域/版本前缀，匹配时整个字符串必须相等。
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	// ant-ling 的本地默认候选。
	"ant-ling": "Ring-2.6-1T",
	// Anthropic 的本地默认候选。
	anthropic: "claude-opus-4-8",
	// OpenAI 的本地默认候选；不在此发请求确认模型是否可用。
	openai: "gpt-6.1-sol",
	// Azure 供应商自己的候选，不与 openai 的表项共用键。
	azure: "gpt-5.4",
	// openai-codex 是独立供应商键，即使模型 id 与 openai 相同也不能当作同一个模型。
	"openai-codex": "gpt-6.1-sol",
	// Radius balanced 是候选 id；是否虚拟/如何路由由模型运行时处理。
	radius: "balanced",
	// NVIDIA 候选包含命名空间斜杠，斜杠不一定是用户输入的供应商分隔符。
	nvidia: "nvidia/nemotron-3.5-super-vl-120b-a12b",
	// DeepSeek 的默认候选字符串。
	deepseek: "deepseek-v4-pro",
	// Google 的候选包含 preview 后缀，本表不负责解释云端版本生命周期。
	google: "gemini-3.1-pro-preview",
	// google-vertex 与 google 使用不同供应商键，各自在可用快照中匹配。
	"google-vertex": "gemini-3.1-pro-preview",
	// GitHub Copilot 的候选；认证来源由运行时快照决定。
	"github-copilot": "gpt-6.1-sol",
	// OpenRouter 模型 id 自带组织前缀，因此输入解析必须考虑完整裸 id。
	openrouter: "moonshotai/kimi-k2.6",
	// Vercel 网关的候选 id 也含供应商命名空间。
	"vercel-ai-gateway": "zai/glm-5.1",
	// xAI 的本地默认候选。
	xai: "grok-4.7",
	// Groq 的候选在模型 id 内含 openai/，不等于选择 openai 供应商。
	groq: "openai/gpt-oss-120b",
	// Cerebras 使用同名家族候选，但 provider 与 Groq 不同。
	cerebras: "gpt-oss-120b",
	// zai 的本地默认候选。
	zai: "glm-5.3",
	// zai-coding-cn 的独立候选。
	"zai-coding-cn": "glm-5.3",
	// Mistral 候选以 latest 结尾；这里仅保存字符串，不联网查它当前指向哪一版。
	mistral: "devstral-medium-latest",
	// MiniMax 的默认候选。
	minimax: "MiniMax-M2.7",
	// MiniMax 中国入口是另一个供应商键。
	"minimax-cn": "MiniMax-M2.7",
	// Moonshot 的本地默认候选。
	moonshotai: "kimi-k2.6",
	// Moonshot 中国入口单独配置候选。
	"moonshotai-cn": "kimi-k2.6",
	// Hugging Face 模型 id 保留其命名空间与大小写；后续不同匹配步骤有自己的大小写规则。
	huggingface: "moonshotai/Kimi-K2.6",
	// Fireworks 完整模型 id 包含多层斜杠，不能简单按第一个斜杠拆模型名。
	fireworks: "accounts/fireworks/models/kimi-k3",
	// Together 的完整候选 id。
	together: "moonshotai/Kimi-K3",
	// Baseten 的完整候选 id。
	baseten: "zai-org/GLM-5.2",
	// OpenCode 的本地默认候选。
	opencode: "kimi-k2.6",
	// opencode-go 单独保存候选，不从 opencode 表项自动继承。
	"opencode-go": "kimi-k3",
	// Kimi Coding 使用本地目录中的专用模型 id。
	"kimi-coding": "kimi-for-coding",
	// Meta 的本地默认候选。
	meta: "muse-spark-1.3",
	// Cloudflare Workers AI 候选保留 @cf/ 前缀。
	"cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
	// Cloudflare AI Gateway 候选保留 workers-ai/ 这一层路由前缀。
	"cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
	// Qwen token plan 的默认候选。
	"qwen-token-plan": "qwen3.7-max",
	// Qwen 中国计划入口单独列键。
	"qwen-token-plan-cn": "qwen3.7-max",
	// Qwen individual 计划可以使用与其他计划不同的模型 id。
	"qwen-token-plan-individual": "qwen3.8-max",
	// Xiaomi 的本地默认候选。
	xiaomi: "mimo-v2.6-pro",
	// Xiaomi 中国 token plan 候选。
	"xiaomi-token-plan-cn": "mimo-v2.6-pro",
	// Xiaomi ams token plan 候选，键本身参与供应商选择。
	"xiaomi-token-plan-ams": "mimo-v2.6-pro",
	// Xiaomi sgp token plan 候选；重复 id 不意味着不同供应商身份相同。
	"xiaomi-token-plan-sgp": "mimo-v2.6-pro",
};

// 范围选择的一项：模型对象和可选的显式思考档位；不是已经发出的请求。
export interface ScopedModel {
	// Model<Api> 泛型表示具体模型使用某种聊天 API，保留模型元数据。
	model: Model<Api>;
	/** Thinking level if explicitly specified in pattern (e.g., "model:high"), undefined otherwise */
	// ? 允许没有单项档位，此时后续启动/切换代码再使用每模型或全局默认。
	thinkingLevel?: ThinkingLevel;
}

/*
 * Model reference resolution. Candidates are collected before a provider is chosen, so catalog order
 * never decides the provider and an ambiguous match is reported instead of falling through to a
 * weaker one.
 */

// 一次引用解析的规则和原文字；解析器只读 models，利用 usable 回调消除供应商歧义。
export interface ModelReferenceRequest {
	/** Bare model id or `provider/id`, optionally followed by `:<thinking>`. */
	// 待匹配的裸 id、provider/id 或带思考后缀的引用；入口会 trim 两端空白。
	text: string;
	/** Only consider models from this provider. */
	// 可选供应商约束，只在这个供应商的候选池内找。
	provider?: string;
	/**
	 * A trailing `:<suffix>` is only considered when the full text matches no model, since ids such as
	 * OpenRouter's `qwen/qwen3-coder:exacto` contain colons.
	 * - `none`: the suffix stays part of the id
	 * - `strict`: a valid thinking level is parsed; any other suffix stays part of the id
	 * - `lenient`: like `strict`, but an invalid suffix is dropped with a warning
	 */
	// none 不拆后缀；strict 只拆合法档位；lenient 可丢弃非法后缀并报告 warning。先尝试原文字匹配，以免把模型 id 自带的冒号误拆。
	thinkingSuffix: "none" | "strict" | "lenient";
	/** Match id and name substrings when no exact match exists. */
	// true 允许 id/name 子串匹配；false 只尝试完整引用及规则允许的后缀。
	fuzzy: boolean;
}

// 带 status 标签的联合类型：调用方检查 status 后，TS 就能收窄到对应字段。
export type ModelReferenceResult =
	// resolved 带唯一选定模型；可附思考档位与文字警告。
	| { status: "resolved"; model: Model<Api>; thinkingLevel?: ThinkingLevel; warning?: string }
	// ambiguous 分支表示候选供应商仍无法唯一决定，不能悄悄取目录第一项。
	| {
			// 固定字面量 status 是收窄判别字段。
			status: "ambiguous";
			// 完整歧义候选列表，不是所有目录模型。
			candidates: Model<Api>[];
			// 参与当前歧义判断的可用候选计数，用来生成认证提示，不代表远程服务验证通过。
			usableCount: number;
			// 后缀解析仍可给歧义结果附思考档位。
			thinkingLevel?: ThinkingLevel;
			// 宽松解析时可携带非法后缀的警告。
			warning?: string;
	  }
	// 没有匹配模型的分支；有时仍能确定该为哪个供应商构造自定义 id。
	| {
			// 未找到不直接抛异常，而作为正常结果交给 CLI/范围选择处理。
			status: "not-found";
			/** Set when a provider is explicit or named by a `provider/` prefix, for building a custom model id. */
			// 目标可选：仅在能够定位已有供应商时附上，供自定义模型回退。
			target?: ModelReferenceTarget;
	  };

// 找不到 id 但已确定供应商时的回退依据。
export interface ModelReferenceTarget {
	// 使用目录中的供应商原始名称，避免只保留用户输入的不同大小写。
	provider: string;
	// 非空元组：[至少一个 Model，再接零个或多个 Model]；buildFallbackModel 因此可安全取第 0 项。
	providerModels: [Model<Api>, ...Model<Api>[]];
	/** Text after the provider prefix as typed, including any `:<suffix>`. */
	// 保留用户模型部分的原文字，可能仍包含 :high。
	modelText: string;
	/** `modelText` without a valid thinking suffix (unless `thinkingSuffix` is `none`). */
	// 已去掉合法思考后缀的 id；none 模式下保留原文字。
	modelId: string;
	// 成功识别的思考档位；不代表已经写入会话配置。
	thinkingLevel?: ThinkingLevel;
}

// Exclude 从联合中排除 not-found 分支，辅助函数因此只能返回已解析或有歧义两类。
type ResolvedOrAmbiguous = Exclude<ModelReferenceResult, { status: "not-found" }>;

/**
 * 从最后一个冒号提取合法思考档位，返回剩余文字和档位；不合法则 undefined，不改输入。
 * 例：demo:high→{base:"demo",thinkingLevel:"high"}；demo:exacto 不拆。base 是否真能匹配模型由调用方继续判断。
 */
function splitThinkingSuffix(text: string): { base: string; thinkingLevel: ThinkingLevel } | undefined {
	// lastIndexOf 找最后一处冒号；找不到为 -1。
	const colonIndex = text.lastIndexOf(":");
	// substring 从冒号后一位取后缀；没有冒号时先得到整个字符串，下一行仍会拒绝。
	const suffix = text.substring(colonIndex + 1);
	// || 短路：没有冒号或后缀不合法都直接返回 undefined；类型谓词同时把 suffix 收窄为 ThinkingLevel。
	if (colonIndex === -1 || !isValidThinkingLevel(suffix)) return undefined;
	// 返回新对象，原文字通过 substring 取得冒号前部分。
	return { base: text.substring(0, colonIndex), thinkingLevel: suffix };
}

/**
 * 在已知目录中寻找供应商前缀，允许供应商名本身含斜杠；返回最长匹配名称和剩余模型文字。
 * 例：目录有 a 和 a/b 时，a/b/model 优先识别供应商 a/b。只接受非空模型部分，不凭空创造未知供应商。readonly 限制通过此参数修改数组。
 */
function splitProviderPrefix(
	text: string,
	models: readonly Model<Api>[],
): { provider: string; modelText: string } | undefined {
	// Provider ids may contain "/" themselves (e.g. URL-derived ids), so match known ids, longest first
	// 比较用小写副本，不修改原输入。
	const lowerText = text.toLowerCase();
	// best 初始 undefined，找到更长有效前缀才赋值。
	let best: { provider: string; modelText: string } | undefined;
	// for...of 遍历模型，解构取其 provider；同供应商多模型会重复经过，但长度规则会跳过已选项。
	for (const { provider } of models) {
		// trim 去供应商名两端空白，小写用于大小写不敏感比较。
		const prefix = provider.trim().toLowerCase();
		// 空供应商或已有至少同长结果则跳过；长度比较用原 provider.length。
		if (!prefix || (best && best.provider.length >= provider.length)) continue;
		// 从已知前缀长度之后找斜杠，允许前缀本身已经含有斜杠。
		const slashIndex = lowerText.indexOf("/", prefix.length);
		// 只有斜杠前 trim 后恰好等于候选前缀才接受，不做任意子串前缀猜测。
		if (slashIndex === -1 || lowerText.substring(0, slashIndex).trim() !== prefix) continue;
		// 保留原文字大小写，只去模型部分两端空白。
		const modelText = text.substring(slashIndex + 1).trim();
		// 模型文字非空才更新 best；返回的 provider 保留目录原名称。
		if (modelText) best = { provider, modelText };
	}
	// 无匹配返回 undefined，有匹配返回最长候选对象。
	return best;
}

/**
 * `usable` only breaks ties between providers, so a unique match resolves even without credentials
 * (`--api-key` first-time setup).
 */
/**
 * 解析一个模型引用，返回 resolved/ambiguous/not-found；不请求模型，不改目录或全局选择。
 * 先裁空白并按可选 provider 过滤，再先完整引用、后模糊、后思考后缀递归；未命中时尽可能构造自定义 id 的目标信息。
 * 例：相同裸 id 出现在 p/q 两供应商且均可用，返回 ambiguous；只有一个匹配供应商时，即使未配置凭证仍可 resolved，方便首次 --api-key 设置。usable 只是调用者策略回调，其异常会传出。
 */
export function resolveModelReference(
	request: ModelReferenceRequest,
	models: readonly Model<Api>[],
	usable: (provider: string) => boolean,
): ModelReferenceResult {
	// trim 不删除模型 id 内部字符，只裁两端。
	const text = request.text.trim();
	// 空输入直接返回未找到，不调用 usable。
	if (!text) return { status: "not-found" };
	// 可选链在 provider 省略时得到 undefined；这里只转小写，没有 trim。
	const constraint = request.provider?.toLowerCase();
	// 有非空约束才 filter；否则直接复用 models 引用，不额外拷贝。
	const pool = constraint ? models.filter((model) => model.provider.toLowerCase() === constraint) : models;
	// 真正匹配交给 resolveText，携带同一策略和可用性回调。
	const result = resolveText(text, request, pool, usable);
	// resolved 或 ambiguous 都直接返回，不因为歧义就换更弱匹配继续猜。
	if (result.status !== "not-found") return result;

	// 只有未找到后，才再次解析已知供应商前缀以准备自定义模型回退。
	const split = splitProviderPrefix(text, pool);
	// 显式约束时用该池首项定位供应商；否则查前缀对应的目录项。
	const anchor = constraint ? pool[0] : pool.find((model) => model.provider === split?.provider);
	// 没有目录锚点就无法安全构造回退目标，保留原 not-found。
	if (!anchor) return result;
	// 有供应商前缀则取其模型部分，否则保留整段输入。
	const modelText = split?.modelText ?? text;
	// none 模式不拆后缀；其他模式仅在合法档位时拆分目标 id。
	const suffix = request.thinkingSuffix === "none" ? undefined : splitThinkingSuffix(modelText);
	// 仍返回 not-found，target 不是“目录已经存在这个模型”。
	return {
		// 用标签表明实际 id 未命中。
		status: "not-found",
		// 附上供上层决定是否构造自定义模型的信息。
		target: {
			// 以目录锚点的供应商作为目标。
			provider: anchor.provider,
			// 锚点放首位并展开同供应商的其他模型，非空元组由构造方式保证。
			providerModels: [anchor, ...pool.filter((model) => model.provider === anchor.provider && model !== anchor)],
			// 属性简写保留带后缀的原模型文字。
			modelText,
			// ?. 和 ?? 组合：存在合法 base 用 base，否则用原 modelText。
			modelId: suffix?.base ?? modelText,
			// 没有合法后缀时 thinkingLevel 可为 undefined。
			thinkingLevel: suffix?.thinkingLevel,
		},
	};
}

/** Exact `provider/id` or bare id lookup without thinking suffixes or fuzzy matching. */
/**
 * 只做精确引用解析，成功返回模型，有歧义或无匹配统一 undefined；不报错、不打印。
 * 例：p/demo 精确命中则返回；demo:high 在这里整体当 id，不把 high 当档位。() => true 将所有供应商视为可用，因此不会用认证状态悄悄消歧。
 */
export function findExactModelReferenceMatch(
	modelReference: string,
	models: readonly Model<Api>[],
): Model<Api> | undefined {
	// 复用公共解析器，避免精确查找与 CLI 的前缀规则分叉。
	const result = resolveModelReference(
		// none+fuzzy:false 明确关闭后缀拆分和模糊匹配。
		{ text: modelReference, thinkingSuffix: "none", fuzzy: false },
		// 使用调用者给定的完整候选数组。
		models,
		// 无参箭头函数总返回 true：精确匹配身份不依赖凭证。
		() => true,
	);
	// 通过 status 收窄后才能取 model；歧义不取第一项。
	return result.status === "resolved" ? result.model : undefined;
}

/**
 * 按完整引用→可选模糊→可选思考后缀的顺序解析文字，递归时每次去掉最后一段后缀。
 * 例：demo:high 若本来就是精确 id，直接返回该模型；否则再尝试 demo 并附 high。strict 不丢非法后缀，lenient 可回退并产生警告；无文件或网络副作用。
 */
function resolveText(
	text: string,
	request: ModelReferenceRequest,
	pool: readonly Model<Api>[],
	usable: (provider: string) => boolean,
): ModelReferenceResult {
	// 先处理裸 id 与已知供应商前缀之间的优先规则。
	const reference = selectReference(text, pool, request.fuzzy, usable);
	// 有结果即返回，包括 ambiguous，避免靠弱匹配掩盖歧义。
	if (reference) return reference;

	// 仅 fuzzy:true 才搜索 id/name 的子串。
	if (request.fuzzy) {
		// 先收集子串命中，再用可用性和别名排序选择。
		const fuzzy = selectFuzzy(fuzzyMatches(text, pool), usable);
		// 模糊歧义也立即返回，不继续尝试拆后缀。
		if (fuzzy) return fuzzy;
	}

	// none 明确禁止把冒号解释为思考档位，到此就未找到。
	if (request.thinkingSuffix === "none") return { status: "not-found" };
	// 尝试拆最后一个合法档位后缀。
	const thinking = splitThinkingSuffix(text);
	// 合法后缀才进入递归，base 可仍带有更早的冒号。
	if (thinking) {
		// 用较短 base 重新走同一匹配规则，保留所有请求选项。
		const inner = resolveText(thinking.base, request, pool, usable);
		// 去后缀后也未找到，就不构造一个假成功。
		if (inner.status === "not-found") return inner;
		// Only use this thinking level if no warning from inner recursion
		// 展开 inner 后附档位；若内层已有非法后缀警告，则当前档位也不采用，保持默认语义。
		return { ...inner, thinkingLevel: inner.warning ? undefined : thinking.thinkingLevel };
	}
	// Keep an invalid suffix as part of the id and fail, rather than resolve a different model
	// strict 遇非法后缀仍按 id 字符处理，不能偷偷改用其他模型。
	if (request.thinkingSuffix === "strict") return { status: "not-found" };
	// 此时是 lenient，准备去掉最后一个非法后缀再试。
	const colonIndex = text.lastIndexOf(":");
	// 没有冒号就没有可进一步缩短的后缀，结束为未找到。
	if (colonIndex === -1) return { status: "not-found" };

	// 记录非法后缀，稍后用于准确提示。
	const suffix = text.substring(colonIndex + 1);
	// 递归查冒号前的文字，允许去掉多层后缀。
	const inner = resolveText(text.substring(0, colonIndex), request, pool, usable);
	// 连短文字都没找到时保留未找到，不凭空附警告成功。
	if (inner.status === "not-found") return inner;
	// 内层找到模型或歧义后，覆盖其档位/警告字段。
	return {
		// 保留内层 status、model/candidates 等字段。
		...inner,
		// 非法后缀使本结果采用默认档位，而非保留某个内层档位。
		thinkingLevel: undefined,
		// 警告写入原模式与非法片段，供上层显示，函数不直接 console。
		warning: `Invalid thinking level "${suffix}" in pattern "${text}". Using default instead.`,
	};
}

/**
 * `provider/rest` is only a hint: the whole text may also be a model id on another provider, such as
 * gateway id `zai/glm-5` or commandcode id `xiaomi/mimo-v2.6-pro`. The named provider wins when usable,
 * since that is what the syntax usually means; otherwise a sole usable raw match wins, since the named
 * provider could not serve the request. An unusable named match is still preferred over unusable raw
 * matches, so `--api-key` can set up the named provider.
 */
/**
 * 比较完整裸 id 和 provider/id 两种含义，返回已解析、歧义或 undefined。
 * 例：p/demo 同时是供应商 p 的 demo 和另一个网关的完整 id 时，已配置可用的 p 命名候选优先；否则可用的唯一裸匹配可能胜出。只有一个供应商时无需先有认证。
 */
function selectReference(
	text: string,
	pool: readonly Model<Api>[],
	fuzzy: boolean,
	usable: (provider: string) => boolean,
): ResolvedOrAmbiguous | undefined {
	// 完整 id 比较统一转小写。
	const lowerText = text.toLowerCase();
	// raw 收集模型 id 与整个 text 完全相同的项；id 里可自带斜杠。
	const raw = pool.filter((model) => model.id.toLowerCase() === lowerText);
	// 同时尝试从已知供应商名识别前缀。
	const split = splitProviderPrefix(text, pool);
	// named 表示前缀明确指向的一个模型，初始没有。
	let named: Model<Api> | undefined;
	// 只有识别到已知供应商前缀，才在那个供应商内部找 named。
	if (split) {
		// 先把模型池限制到目录中的原供应商名称。
		const providerModels = pool.filter((model) => model.provider === split.provider);
		// 模型部分另转小写，供精确 id 比较。
		const lowerModelText = split.modelText.toLowerCase();
		// The provider's own literal id (OpenRouter's `openrouter/free`) beats its fuzzy matches
		// ?? 链依次寻找下列候选；前一项存在就不计算后项。
		named =
			// 首先优先匹配去掉供应商前缀后的完整模型 id。
			providerModels.find((model) => model.id.toLowerCase() === lowerModelText) ??
			// 其次允许本供应商的 id 本身就等于整段引用，如 openrouter/free。
			raw.find((model) => model.provider === split.provider) ??
			// 最后只在 fuzzy 开启时，在命名供应商内部选择最佳子串命中。
			(fuzzy ? bestFuzzyMatch(fuzzyMatches(split.modelText, providerModels)) : undefined);
	}

	// 从完整裸 id 候选中去掉同一个 named 对象，避免重复计数。
	const others = raw.filter((model) => model !== named);
	// 有 named 就放首项，其余裸匹配随后；无 named 则只用裸匹配。
	const candidates = named ? [named, ...others] : others;
	// 没有任何候选时用 undefined 表示这一层没有结果。
	if (candidates.length === 0) return undefined;
	// Set 对供应商名去重；即使多条候选，只来自同一供应商就无需跨供应商消歧。
	if (new Set(candidates.map((model) => model.provider)).size === 1)
		// 在单供应商情况下选其首个候选，named 如存在会排首位。
		return { status: "resolved", model: candidates[0] };
	// 已命名且 usable 的供应商优先，哪怕另有可用裸 id 候选。
	if (named && usable(named.provider)) return { status: "resolved", model: named };
	// 只统计其他裸匹配中可用的项，不把 named 再算一次。
	const usableOthers = others.filter((model) => usable(model.provider));
	// named 不可用/不存在时，唯一可用的其他候选可胜出。
	if (usableOthers.length === 1) return { status: "resolved", model: usableOthers[0] };
	// 其他候选全不可用而存在 named，仍优先命名候选，支持新密钥首次设置。
	if (usableOthers.length === 0 && named) return { status: "resolved", model: named };
	// 剩余情况返回歧义及可用其他项数量；不按目录顺序随便选供应商。
	return { status: "ambiguous", candidates, usableCount: usableOthers.length };
}

/**
 * 收集 id 或显示名包含 text 的模型，大小写不敏感；返回新数组，不排序、不判断认证。
 * 例：text="sonnet" 会匹配含 sonnet 的 id/name；?. 使没有 name 时不调用其字符串方法。
 */
function fuzzyMatches(text: string, models: readonly Model<Api>[]): Model<Api>[] {
	// 比较文字只计算一次小写形式。
	const lowerText = text.toLowerCase();
	// filter 按原目录顺序保留匹配项。
	return models.filter(
		// id 命中即短路，不再查 name；显示名缺省时该半项是 undefined，在 filter 中当假值。
		(model) => model.id.toLowerCase().includes(lowerText) || model.name?.toLowerCase().includes(lowerText),
	);
}

/**
 * 在子串命中里选择最佳别名/版本；同一最佳 id 仍跨供应商时返回歧义。
 * 有多个供应商才用 usable 过滤，且至少一个可用才缩小候选；没有可用项仍允许保留未认证候选。例：p/demo 与 q/demo 均可用，不能凭目录顺序选 p。
 */
function selectFuzzy(matches: Model<Api>[], usable: (provider: string) => boolean): ResolvedOrAmbiguous | undefined {
	// 空列表直接无结果。
	if (matches.length === 0) return undefined;
	// Set.size 判断是否真的跨供应商，不按命中条数判断。
	const multipleProviders = new Set(matches.map((model) => model.provider)).size > 1;
	// 同供应商无需用认证过滤；跨供应商才逐项调用 usable。
	const usableMatches = multipleProviders ? matches.filter((model) => usable(model.provider)) : [];
	// 有可用候选就只在其中排序，否则保留所有原候选。
	const pool = usableMatches.length > 0 ? usableMatches : matches;
	// 挑选最佳别名或按字符串顺序选候选版本。
	const best = bestFuzzyMatch(pool);
	// 排序没有得到项就返回 undefined。
	if (!best) return undefined;
	// The same id on several providers would otherwise be decided by catalog order
	// 按最佳 id 的严格相等收集并列项；这里不同于前面的不区分大小写子串比较。
	const tied = pool.filter((model) => model.id === best.id);
	// 并列 id 只属于一个供应商，返回最佳模型。
	if (new Set(tied.map((model) => model.provider)).size === 1) return { status: "resolved", model: best };
	// 同一最佳 id 仍跨供应商，形成歧义。
	return {
		// 判别字段方便调用者收窄类型。
		status: "ambiguous",
		// 只返回与最佳 id 相同的并列项，而非全部模糊命中。
		candidates: tied,
		// 确实使用了可用池时并列项都可用，否则可用数为 0。
		usableCount: usableMatches.length > 0 ? tied.length : 0,
	};
}

/** Prefer aliases (`claude-sonnet-4-5`) over dated versions (`claude-sonnet-4-5-20250929`), then the latest. */
/**
 * 在候选中优先无八位日期尾缀的别名，然后按 id 字符串降序取首项；不修改原数组。
 * 例：demo 与 demo-20260101 同时存在时优先 demo。这里不是查询云端更新时间，也不是语义版本排序，原英语 latest 对应本地命名排序规则。
 */
function bestFuzzyMatch(matches: readonly Model<Api>[]): Model<Api> | undefined {
	// filter 建立别名子集；isAlias 使用命名启发式，不查服务端元数据。
	const aliases = matches.filter((model) => isAlias(model.id));
	// 展开复制后才原地 sort，避免修改 matches；[0] 对空数组得到 undefined。
	return [...(aliases.length > 0 ? aliases : matches)].sort((a, b) => b.id.localeCompare(a.id))[0];
}

/**
 * 按名字判断是否视为别名：-latest 结尾，或没有 -八位数字尾缀。
 * 例：demo-20260101 为 false，demo-v2 为 true；正则仅看命名形式，不验证日期是否真实。
 */
function isAlias(id: string): boolean {
	// endsWith 或正则否定任一为真就算别名；$ 限制数字必须在字符串末尾。
	return id.endsWith("-latest") || !/-\d{8}$/.test(id);
}

/**
 * 为已知供应商的未知 id 合成临时模型：优先借该供应商默认模型元数据，否则借第一项，再改 id/name。
 * 非空元组保证至少有基础项；例：p/new 未在目录时，可借 p/default 的成本/限制和 API。只浅复制元数据，不验证新 id 真存在，也不保存进目录。
 */
function buildFallbackModel(providerModels: [Model<Api>, ...Model<Api>[]], modelId: string): Model<Api> {
	// KnownProvider 类型断言只帮助索引；运行时仍可能得 undefined，不会把自定义供应商变成内置供应商。
	const defaultId = defaultModelPerProvider[providerModels[0].provider as KnownProvider];
	// 有本地默认候选 id 时尝试在当前供应商目录找对应模型。
	const baseModel = defaultId
		? // 找不到默认 id 则 ?? 回退首项。
			(providerModels.find((m) => m.id === defaultId) ?? providerModels[0])
		: // 供应商没有默认表项也直接用首项。
			providerModels[0];

	// 构造新模型对象，不改 baseModel 本身。
	return {
		// 对象展开是浅复制，嵌套成本/能力对象仍可复用引用。
		...baseModel,
		// 覆盖 id 为用户请求的自定义 id。
		id: modelId,
		// 显示名也使用这个自定义 id，不沿用基础模型名称。
		name: modelId,
	};
}

// 范围解析的可展示诊断；当前都是 warning，不以异常阻断所有其他模式。
export interface ModelScopeDiagnostic {
	// type 固定 warning 字面量。
	type: "warning";
	// 机器可判断的三种原因：无匹配、非法档位、供应商歧义。
	code: "no-match" | "invalid-thinking-level" | "ambiguous";
	// 用户可读的实际诊断文字。
	message: string;
	// 触发这条诊断的原模式，用于定位配置。
	pattern: string;
}

// 一次范围解析同时返回选中项与诊断，避免解析核心直接写终端。
export interface ResolveModelScopeResult {
	// 去重后的模型范围，保留首次加入的顺序和档位。
	scopedModels: ScopedModel[];
	// 按解析过程产生的诊断列表，可能与成功项并存。
	diagnostics: ModelScopeDiagnostic[];
}

/**
 * Resolve scope patterns (`--models`, `enabledModels`) to models with optional thinking levels.
 *
 * Every model in `models` is usable, so credentials cannot choose between providers offering the same
 * id. All of them are added, with a warning so the user can pick one with `provider/id`.
 */
/**
 * 把多个 --models/enabledModels 模式解析成模型范围及警告，不访问文件/网络，不改变运行时状态。
 * 含 *、?、[ 的模式先试完整字面量 id，再试通配；普通模式允许模糊/宽松思考后缀。重复模型按身份只留第一次，所以后面的模式不覆盖其档位。
 * 例：["p/*:high","p/demo:low"] 若先已加入 p/demo，最终仍保留 high；同 id 跨供应商可全部加入并提示歧义。输入 models 被视为可用池。
 */
export function resolveModelScopeFromModels(
	patterns: string[],
	models: readonly Model<Api>[],
): ResolveModelScopeResult {
	// 创建结果数组，只在本函数中按模式顺序逐步添加。
	const scopedModels: ScopedModel[] = [];
	// 诊断单独收集，匹配失败不会使其他模式中断。
	const diagnostics: ModelScopeDiagnostic[] = [];
	/**
	 * 局部 add 回调接收模型与可空档位，闭包访问 scopedModels。
	 * 先按 modelsAreEqual 检查身份，再 push；返回 void。例：第二次添加同一 p/demo 不覆盖第一次档位。
	 */
	const add = (model: Model<Api>, thinkingLevel: ThinkingLevel | undefined) => {
		// some 判断是否已有相同模型；底层 modelsAreEqual 使用 kind/provider/id 语义，不只比较对象引用。
		if (!scopedModels.some((scoped) => modelsAreEqual(scoped.model, model))) {
			// 对象属性简写把模型和档位追加为一项。
			scopedModels.push({ model, thinkingLevel });
		}
	};
	// 局部 noMatch 回调把无命中信息追加到诊断数组；表达式箭头隐式返回 push 的长度，调用方不使用它。
	const noMatch = (pattern: string) =>
		// 记录 warning、原因、带模式的文案与原模式，不在这里打印。
		diagnostics.push({ type: "warning", code: "no-match", message: `No models match pattern "${pattern}"`, pattern });
	// 局部 ambiguous 回调汇总候选供应商并添加提示；不负责替用户选一个。
	const ambiguous = (pattern: string, candidates: readonly Model<Api>[]) => {
		// map 取供应商→Set 去重→展开回数组→按名称排序，保持提示稳定。
		const providers = [...new Set(candidates.map((m) => m.provider))].sort((a, b) => a.localeCompare(b));
		// 追加一条结构化歧义警告。
		diagnostics.push({
			// 固定 warning 分类。
			type: "warning",
			// 原因标记为 ambiguous。
			code: "ambiguous",
			// 将供应商名合并到文案，提示可用 provider/id 消除歧义。
			message: `Pattern "${pattern}" matches several providers: ${providers.join(", ")}. Use provider/id to choose one.`,
			// 保存原输入模式，非排序后的候选名。
			pattern,
		});
	};

	// 按用户给定顺序处理，因此首次去重项的档位具有优先权。
	for (const pattern of patterns) {
		// Check if pattern contains glob characters
		// 仅把出现这三个字符的输入送入通配路径；包含 [ 也可能其实是合法字面量 id。
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			// Extract optional thinking level suffix (e.g., "provider/*:high")
			// 通配模式允许尾随合法思考后缀，非法后缀不会由此函数移除。
			const thinking = splitThinkingSuffix(pattern);
			// 合法后缀拆出的 base 作为实际通配字符串，否则保留原模式。
			const globPattern = thinking?.base ?? pattern;
			// ?. 在没有合法后缀时得到 undefined，后续档位继续由默认配置决定。
			const thinkingLevel = thinking?.thinkingLevel;

			// Ids such as `bracketed-model[1m]` are not globs
			// 先试完整字面量，防止把模型 id 自带 [1m] 误当 glob 字符类。
			const exact = resolveModelReference(
				// 对已拆后缀的文字关闭后缀/模糊，专门做完整引用匹配。
				{ text: globPattern, thinkingSuffix: "none", fuzzy: false },
				// 使用调用方给的模型池。
				models,
				// 全部按可用处理，范围选择不在这里用认证挑单一供应商。
				() => true,
			);
			// readonly 限制通过 matches 修改候选数组；变量本身仍可重新赋值。
			let matches: readonly Model<Api>[] = [];
			// 字面量解析唯一命中，直接形成单项列表，不再做通配。
			if (exact.status === "resolved") matches = [exact.model];
			// 字面量解析有供应商歧义，保留所有候选。
			else if (exact.status === "ambiguous") {
				// 复用歧义候选数组，仅读它。
				matches = exact.candidates;
				// 记录警告，让用户知道为什么同一个模式加入多个供应商。
				ambiguous(pattern, matches);
			} else {
				// Match against "provider/modelId" format OR just model ID
				// This allows "*sonnet*" to match without requiring "anthropic/*sonnet*"
				// 字面量没有命中才对整个池做 glob filter。
				matches = models.filter(
					// 箭头回调每次接收一个模型 m。
					(m) =>
						// 先尝试完整 provider/id 形式，nocase:true 不区分大小写。
						minimatch(`${m.provider}/${m.id}`, globPattern, { nocase: true }) ||
						// 或直接匹配模型 id，让 *sonnet* 不需要强写 provider/。
						minimatch(m.id, globPattern, { nocase: true }),
				);
			}
			// 空结果只记录诊断，不抛错。
			if (matches.length === 0) noMatch(pattern);
			// 所有命中项以本模式档位尝试加入，已有身份会由 add 跳过。
			for (const model of matches) add(model, thinkingLevel);
			// 当前通配模式处理完，continue 下一个模式。
			continue;
		}

		// 没有通配触发字符的模式交给通用解析器。
		const result = resolveModelReference(
			// lenient 允许非法思考后缀回退并警告，fuzzy 允许子串。
			{ text: pattern, thinkingSuffix: "lenient", fuzzy: true },
			// 再次使用当前可用模型池。
			models,
			// 所有候选视为可用，跨供应商同名会保留歧义。
			() => true,
		);
		// 未找到时不尝试构造自定义模型；那是 resolveCliModel 的功能。
		if (result.status === "not-found") {
			// 记录未命中原模式。
			noMatch(pattern);
			// 不让失败模式进入下面需要 model/candidates 的分支。
			continue;
		}
		// 宽松递归可能找到模型但携带警告。
		if (result.warning) {
			// 把非法思考档位诊断单独记录。
			diagnostics.push({ type: "warning", code: "invalid-thinking-level", message: result.warning, pattern });
		}
		// 歧义仍作为警告保留，并不拒绝把候选加入范围。
		if (result.status === "ambiguous") ambiguous(pattern, result.candidates);
		// 三元表达式根据 status 收窄可读 model 或 candidates 字段。
		const matches = result.status === "resolved" ? [result.model] : result.candidates;
		// 按返回档位加入每个候选；同一模型只保留首次。
		for (const model of matches) add(model, result.thinkingLevel);
	}

	// 同时返回数据与诊断，纯解析层不做 console 输出。
	return { scopedModels, diagnostics };
}

/**
 * 从运行时异步取得可用模型，再返回范围和诊断；options 可带取消等认证操作选项。
 * 例：等待配置认证/可用性快照刷新后匹配 p/*；不会发聊天请求，但可用性查询不等于纯字符串处理，可能涉及认证配置读取及相应辅助 I/O，错误向外传播。
 */
export async function resolveModelScopeWithDiagnostics(
	patterns: string[],
	modelRuntime: ModelRuntime,
	options?: AuthOperationOptions,
): Promise<ResolveModelScopeResult> {
	// undefined 第一个参数表示所有供应商；await 结果后才调用纯解析函数，异常不会被当成空列表。
	return resolveModelScopeFromModels(patterns, await modelRuntime.getAvailable(undefined, options));
}

/**
 * 可直接用于 CLI 的范围解析包装：打印所有诊断，只返回选中模型数组。
 * 例：某个模式无匹配则 console.warn 黄色提示，同时仍返回其他模式成功项。与 WithDiagnostics 版本相比增加终端输出副作用。
 */
export async function resolveModelScope(
	patterns: string[],
	modelRuntime: ModelRuntime,
	options?: AuthOperationOptions,
): Promise<ScopedModel[]> {
	// 对象解构取两部分；await 等异步可用性查询和解析完成。
	const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(patterns, modelRuntime, options);
	// 按诊断顺序逐条打印，不因第一条警告中断。
	for (const diagnostic of diagnostics) {
		// chalk.yellow 只装饰展示文字，console.warn 通常写 stderr。
		console.warn(chalk.yellow(`Warning: ${diagnostic.message}`));
	}
	// 不再把 diagnostics 作为返回值，调用方只拿选中范围。
	return scopedModels;
}

// CLI 单模型解析结果，错误以 error 字段表示；该接口没有用 status 联合约束所有字段组合。
export interface ResolveCliModelResult {
	// 成功或自定义回退有模型，无输入/错误时可以 undefined。
	model: Model<Api> | undefined;
	// 仅返回解析出来的档位，调用方另行应用显式 --thinking 等优先级。
	thinkingLevel?: ThinkingLevel;
	// 可展示但不阻止继续的警告，常用于未知 id 的自定义回退。
	warning: string | undefined;
	/**
	 * Error message suitable for CLI display.
	 * When set, model will be undefined.
	 */
	// CLI 可展示的错误文字；当前函数出错分支同步把 model 设 undefined，不直接 process.exit。
	error: string | undefined;
}

/**
 * Resolve a single model from CLI flags.
 *
 * Supports:
 * - --provider <provider> --model <pattern>
 * - --model <provider>/<pattern>
 * - Fuzzy matching (same rules as model scoping: exact id, then partial id/name)
 *
 * Note: This does not apply the thinking level by itself, but it may *parse* and
 * return a thinking level from "<pattern>:<thinking>" so the caller can apply it.
 */
/**
 * 根据 CLI 参数同步选择一个模型，返回结果/警告/错误，不向模型发请求，不修改全局模型选择。
 * 先从完整目录匹配，认证快照仅用于跨供应商消歧；有 --api-key 时不能让旧凭证代替用户决定供应商。未找到 id 但目标供应商存在时借元数据合成自定义模型。
 * 例：--model p/new:high 且无显式 --thinking，可回退 id=new 并返回 high；显式 --thinking=low 时，自定义 id 仍保留 new:high，low 由上层应用。
 */
export function resolveCliModel(options: {
	// 可选 --provider 供应商约束，后面匹配规范目录名称。
	cliProvider?: string;
	// 可选 --model 的原模式；没有则此函数不做自动默认选择。
	cliModel?: string;
	// 已解析的显式 --thinking；只影响自定义回退后缀处理，普通命中档位仍由上层合并。
	cliThinking?: ThinkingLevel;
	/** `--api-key` was supplied for the selected provider. */
	// 是否传了内联 key 的标志；这里没有保存或读取 key 的内容。
	inlineApiKey?: boolean;
	// 模型运行时提供完整目录和最近认证配置快照。
	modelRuntime: ModelRuntime;
}): ResolveCliModelResult {
	// 解构 options 得局部变量，均不改写 options。
	const { cliProvider, cliModel, cliThinking, inlineApiKey, modelRuntime } = options;

	// 空缺/空字符串都按没有 --model 处理。
	if (!cliModel) {
		// 没有模型参数不是错误，返回三项 undefined，交默认选择流程处理。
		return { model: undefined, warning: undefined, error: undefined };
	}

	// Important: use *all* models here, not just models with pre-configured auth.
	// This allows "--api-key" to be used for first-time setup.
	// 展开复制完整聊天目录；不先过滤为已配置认证列表，以支持新 key 首次选择。
	const models = [...modelRuntime.getModels()];
	// 目录本身为空，无法匹配或借用元数据。
	if (models.length === 0) {
		// 以结构化结果返回错误，不在解析器中输出/退出。
		return {
			// 错误路径不选模型。
			model: undefined,
			// 此分支没有另外警告。
			warning: undefined,
			// 提示检查安装或 models.json，而非在这里创建模型配置。
			error: "No models available. Check your installation or add models to models.json.",
		};
	}

	// 有 --provider 才尝试规范化它的大小写名称。
	const provider = cliProvider
		? // find 在完整目录中找供应商，?.provider 在没有找到时为 undefined。
			models.find((m) => m.provider.toLowerCase() === cliProvider.toLowerCase())?.provider
		: // 没有显式供应商约束时，留给引用前缀/候选规则判断。
			undefined;
	// 用户明确写了供应商但目录没有该键，不能静默忽略这个约束。
	if (cliProvider && !provider) {
		// 返回未知供应商错误对象。
		return {
			// 不回退其他供应商模型。
			model: undefined,
			// 没有次要 warning。
			warning: undefined,
			// 错误包含用户原供应商文字，方便修正输入。
			error: `Unknown provider "${cliProvider}". Use --list-models to see available providers/models.`,
		};
	}

	// 实际模型模式匹配复用公共引用规则。
	const result = resolveModelReference(
		// strict 不丢非法思考后缀；fuzzy 允许 id/name 子串。
		{ text: cliModel, provider, thinkingSuffix: "strict", fuzzy: true },
		// 传完整目录，让暂未配置认证的唯一目标仍可选。
		models,
		// An inline key goes to whichever provider is selected, so stored credentials must not choose it
		// 有内联 key 时 usable 总 false，旧凭证不参与消歧；否则只查最近 configuredProviders 快照，不联网验证。
		inlineApiKey ? () => false : (providerId) => modelRuntime.hasConfiguredAuth(providerId),
	);
	// status 标签将结果收窄到带 model 的分支。
	if (result.status === "resolved") {
		// 正常匹配直接转成 CLI 结果；没有在此改变模型 reasoning 或实际请求选项。
		return { model: result.model, thinkingLevel: result.thinkingLevel, warning: result.warning, error: undefined };
	}
	// 歧义时不取第一项，不用未知 id 回退绕过这个问题。
	if (result.status === "ambiguous") {
		// 把候选转换成稳定、可展示的完整引用列表。
		const matches = result.candidates
			// map 使用模板字面量拼 provider/id，不丢模型 id 内部斜杠。
			.map((m) => `${m.provider}/${m.id}`)
			// 排序只作用于 map 新数组，不改变源目录。
			.sort((a, b) => a.localeCompare(b))
			// 逗号连接成一段候选文字。
			.join(", ");
		// 根据内联 key 和可用候选数量选择更具体的错误提示。
		const authHint = inlineApiKey
			? // 内联 key 只是凭证，不替用户选供应商。
				"--api-key does not choose a provider."
			: // 没有内联 key 时看快照筛选计数。
				result.usableCount === 0
				? // 计数为零时提示没有已认证匹配；实际只做配置快照判断，不是发了认证探测。
					"No matching provider is authenticated."
				: // 多个可用项时提示需明确供应商；不自动选择目录顺序靠前者。
					"More than one matching provider is authenticated.";
		// 把歧义作为 error 返回。
		return {
			// 错误时 model 明确 undefined。
			model: undefined,
			// 不把阻塞性歧义伪装成普通 warning。
			warning: undefined,
			// 包含模式、候选、认证提示和消歧方式。
			error: `Model "${cliModel}" is ambiguous across providers: ${matches}. ${authHint} Use --provider or provider/model.`,
		};
	}

	// 到这里 result 已是 not-found；解构其可选 target。
	const { target } = result;
	// 没有供应商目标，无法借用配置构造自定义 id。
	if (!target) {
		// 返回普通未找到错误。
		return {
			// 无选定模型。
			model: undefined,
			// 无附加警告。
			warning: undefined,
			// 提示查模型列表，保留原 CLI 文字。
			error: `Model "${cliModel}" not found. Use --list-models to see available models.`,
		};
	}

	// Use the thinking level suffix only when --thinking is not explicitly provided; otherwise it
	// stays part of the custom model id.
	// e.g. "zai-org/GLM-5.1-FP8:high" → modelId="zai-org/GLM-5.1-FP8", fallbackThinking="high"
	// 自定义回退特例：显式 cliThinking 为真值时保留原 modelText；包括字符串 off，也会保留 :后缀。
	const modelId = cliThinking ? target.modelText : target.modelId;
	// 有显式 --thinking 就不再把模型后缀档位作为 fallbackThinking 返回。
	const fallbackThinking = cliThinking ? undefined : target.thinkingLevel;
	// 借目标供应商非空模型集构造新的 id/name，其他元数据来自基础模型。
	const fallbackModel = buildFallbackModel(target.providerModels, modelId);
	// 显式档位优先；否则用成功解析的后缀档位。
	const requestedThinking = cliThinking ?? fallbackThinking;
	// 返回可继续使用的自定义模型及 warning，不把它宣称成目录已有模型。
	return {
		// 请求了非 off 的档位就浅复制设 reasoning:true；只是本地兼容元数据，不能保证云端真的支持该能力。
		model: requestedThinking && requestedThinking !== "off" ? { ...fallbackModel, reasoning: true } : fallbackModel,
		// 返回后缀回退档位；显式 cliThinking 由调用方另行持有，不在此字段重复返回。
		thinkingLevel: fallbackThinking,
		// 告知用户 id 未在该供应商目录命中，当前使用自定义 id。
		warning: `Model "${modelId}" not found for provider "${target.provider}". Using custom model id.`,
		// 自定义回退允许继续，因此 error 是 undefined。
		error: undefined,
	};
}

// 启动默认选择的结果：可缺模型，但 thinkingLevel 总有默认值。
export interface InitialModelResult {
	// 没有合适候选时 undefined，由上层决定如何提示/配置。
	model: Model<Api> | undefined;
	// 最终建议的思考档位，不代表已发送请求。
	thinkingLevel: ThinkingLevel;
	// 回退提示字段；当前 findInitialModel 各分支均设 undefined。
	fallbackMessage: string | undefined;
}

/**
 * Find the initial model to use based on priority:
 * 1. First model from scoped models (if not continuing/resuming)
 * 2. Saved default from settings
 * 3. First available model with valid API key
 */
/**
 * 为新会话/启动选择初始模型：非恢复时范围首项→有认证配置的已存默认→可用快照中的本地默认候选→可用首项。
 * 输入目录/范围/默认配置，返回 Promise<InitialModelResult>；虽是 async，函数体没有 await，不主动刷新目录或验证远端 key。
 * 例：范围首项 demo:high 在新会话直接优先；恢复会话跳过范围首项，真正恢复旧选择由 restoreModelFromSession 处理。最后可用列表回退使用共享默认档位，不沿用未命中的默认模型档位。
 */
export async function findInitialModel(options: {
	// 已解析的模型循环范围，首项仅在非继续/恢复模式优先。
	scopedModels: ScopedModel[];
	// 是否继续旧会话的标志，控制是否跳过范围第一项。
	isContinuing: boolean;
	// 设置保存的默认供应商。
	defaultProvider?: string;
	// 设置保存的默认模型 id，和 provider 一起定位。
	defaultModelId?: string;
	// 可选全局默认思考档位，主要用于范围首项或命中的已存默认。
	defaultThinkingLevel?: ThinkingLevel;
	// 按完整 provider/id 保存的档位字典；Record 只是编译期键值类型。
	modelThinkingLevels?: Record<string, ThinkingLevel>;
	// 同步目录与可用性快照来源，不在本函数调用 getAuth。
	modelRuntime: ModelRuntime;
}): Promise<InitialModelResult> {
	// 从 options 对象解构需要的字段，后续均使用这些局部值。
	const {
		// 模型范围数组。
		scopedModels,
		// 旧会话继续标志。
		isContinuing,
		// 已存供应商默认。
		defaultProvider,
		// 已存模型默认。
		defaultModelId,
		// 已存全局思考档位。
		defaultThinkingLevel,
		// 逐模型档位覆盖表。
		modelThinkingLevels,
		// 运行时对象引用，不创建新运行时。
		modelRuntime,
	} = options;

	// let 模型结果可暂缺，稍后默认命中时赋值。
	let model: Model<Api> | undefined;
	// 档位先使用共享默认值，而非假设每次都有全局设置。
	let thinkingLevel: ThinkingLevel = DEFAULT_THINKING_LEVEL;

	// 1. Use first model from scoped models (skip if continuing/resuming)
	// 非继续模式且范围非空，按用户范围顺序选择首项。
	if (scopedModels.length > 0 && !isContinuing) {
		// 通过非空条件后可以读取索引 0。
		const scopedModel = scopedModels[0];
		// 可选链索引从逐模型表读取该 provider/id 的专门档位。
		const perModel = modelThinkingLevels?.[`${scopedModel.model.provider}/${scopedModel.model.id}`];
		// 本分支立即返回，后续已存默认不再参与。
		return {
			// 直接复用范围中的模型对象。
			model: scopedModel.model,
			// ?? 优先单项显式档位→逐模型档位→全局默认→共享默认；off 是非空字符串，不会丢失。
			thinkingLevel: scopedModel.thinkingLevel ?? perModel ?? defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
			// 成功按范围选择，无回退提示。
			fallbackMessage: undefined,
		};
	}

	// 2. Try saved default from settings if auth is configured.
	// 保存的 provider 和 id 都存在才尝试已存默认。
	if (defaultProvider && defaultModelId) {
		// 从当前目录精确读取模型，不使用模糊匹配。
		const found = modelRuntime.getModel(defaultProvider, defaultModelId);
		// 模型存在且该供应商在最近快照有认证配置才采用；并非远端校验成功。
		if (found && modelRuntime.hasConfiguredAuth(found.provider)) {
			// 把找到的模型赋给局部结果。
			model = found;
			// 查这个已存默认模型的专门档位。
			const perModel = modelThinkingLevels?.[`${defaultProvider}/${defaultModelId}`];
			// 合法档位均是非空字符串，包括 off，因此这里 if 能保留 off。
			if (perModel) {
				// 逐模型档位优先。
				thinkingLevel = perModel;
				// 没有专门档位才看全局默认。
			} else if (defaultThinkingLevel) {
				// 使用全局设置，否则保留一开始的共享默认。
				thinkingLevel = defaultThinkingLevel;
			}
			// 命中已存默认，立即返回。
			return { model, thinkingLevel, fallbackMessage: undefined };
		}
	}

	// 3. Try first available model with valid API key
	// 只读已有 available 快照并复制数组，不在这里读取凭证/刷新 token；原英语 valid API key 在当前实现不代表实时验证。
	const availableModels = [...modelRuntime.getAvailableSnapshot()];

	// 快照非空才可寻找候选。
	if (availableModels.length > 0) {
		// Try to find a default model from known providers
		// Object.keys 保留对象键顺序；as KnownProvider[] 是类型断言，不在运行时验证。
		for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
			// 拿当前供应商的本地默认候选 id，可能 undefined。
			const defaultId = defaultModelPerProvider[provider];
			// 同时精确匹配 provider/id，避免同 id 跨供应商误选。
			const match = availableModels.find((m) => m.provider === provider && m.id === defaultId);
			// 候选确实在可用快照中才采用。
			if (match) {
				// 这条回退路径用共享默认档位，并不查逐模型或全局思考配置。
				return { model: match, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
			}
		}

		// If no default found, use first available
		// 没有本地默认表命中就用可用快照首项，顺序由快照生成过程决定。
		return { model: availableModels[0], thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
	}

	// 4. No model found
	// 整个快照无可用候选，返回缺模型和共享默认档位，不抛“必须有模型”的异常。
	return { model: undefined, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
}

/**
 * Restore model from session, with fallback to available models
 */
/**
 * 尝试恢复会话保存的模型；不存在或没认证配置时，优先 currentModel，再查可用快照的默认候选/首项。
 * 输入保存的 provider/id、可选当前模型、是否打印和运行时；返回模型与可选回退文字，不修改会话或目录。
 * 例：旧 p/removed 消失但 currentModel=q/demo 时返回 q/demo 并附原因；currentModel 仅因由调用方传入而采用，此处不会再次验证它是否仍可用。async 体没有 await，不刷新认证/目录。
 */
export async function restoreModelFromSession(
	savedProvider: string,
	savedModelId: string,
	currentModel: Model<Api> | undefined,
	shouldPrintMessages: boolean,
	modelRuntime: ModelRuntime,
): Promise<{ model: Model<Api> | undefined; fallbackMessage: string | undefined }> {
	// 按保存的精确身份查询当前目录，不做模糊替代。
	const restoredModel = modelRuntime.getModel(savedProvider, savedModelId);

	// Check if restored model exists and still has auth configured
	// 存在模型才读配置认证快照；不是尝试真实请求或刷新 token。
	const hasConfiguredAuth = restoredModel ? modelRuntime.hasConfiguredAuth(restoredModel.provider) : false;

	// 模型和认证配置都存在，允许恢复原选择。
	if (restoredModel && hasConfiguredAuth) {
		// 布尔标志只控制打印副作用，不改变模型选择结果。
		if (shouldPrintMessages) {
			// dim 状态文字通过 console.log 输出恢复目标。
			console.log(chalk.dim(`Restored model: ${savedProvider}/${savedModelId}`));
		}
		// 成功恢复，无需回退说明。
		return { model: restoredModel, fallbackMessage: undefined };
	}

	// Model not found or no API key - fall back
	// 根据是“模型消失”还是“未配认证”选择原因；两种都不是本函数发请求探测得到的。
	const reason = !restoredModel ? "model no longer exists" : "no auth configured";

	// 调用方要求显示时才输出警告。
	if (shouldPrintMessages) {
		// console.error 通常写 stderr，黄色文字不影响返回结果。
		console.error(chalk.yellow(`Warning: Could not restore model ${savedProvider}/${savedModelId} (${reason}).`));
	}

	// If we already have a model, use it as fallback
	// 已存在 currentModel 就优先返回它，不再查其他默认候选。
	if (currentModel) {
		// 同一打印标志控制回退目标提示。
		if (shouldPrintMessages) {
			// 输出将采用的当前模型身份。
			console.log(chalk.dim(`Falling back to: ${currentModel.provider}/${currentModel.id}`));
		}
		// 把回退实际结果和可供上层展示的说明一起返回。
		return {
			// 原样采用调用方 currentModel 对象。
			model: currentModel,
			// 即使 shouldPrintMessages:false，也返回这个提示字段，供 UI 自行展示。
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${currentModel.provider}/${currentModel.id}.`,
		};
	}

	// Try to find any available model
	// 没有当前模型才读可用快照，仍不主动刷新。
	const availableModels = [...modelRuntime.getAvailableSnapshot()];

	// 快照非空才进入默认候选查找。
	if (availableModels.length > 0) {
		// Try to find a default model from known providers
		// 局部 fallbackModel 先 undefined，找到后赋值。
		let fallbackModel: Model<Api> | undefined;
		// 按本地默认表键顺序遍历供应商。
		for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
			// 读取当前供应商的默认 id。
			const defaultId = defaultModelPerProvider[provider];
			// 在快照中找完整身份对应候选。
			const match = availableModels.find((m) => m.provider === provider && m.id === defaultId);
			// 只接受实际命中的候选。
			if (match) {
				// 记录该回退模型。
				fallbackModel = match;
				// break 只退出 for 循环，接着走共同打印/返回路径。
				break;
			}
		}

		// If no default found, use first available
		// 所有本地默认候选都没命中时，才使用快照首项。
		if (!fallbackModel) {
			// 数组已知非空，所以这里有一个可用项。
			fallbackModel = availableModels[0];
		}

		// 按调用方要求打印回退目标。
		if (shouldPrintMessages) {
			// 文字输出与返回对象分开，打印关闭仍可返回说明。
			console.log(chalk.dim(`Falling back to: ${fallbackModel.provider}/${fallbackModel.id}`));
		}

		// 返回最终回退模型和完整原因。
		return {
			// 模型对象来自当前可用快照。
			model: fallbackModel,
			// 提示包含旧身份、失败原因和实际采用的新身份。
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${fallbackModel.provider}/${fallbackModel.id}.`,
		};
	}

	// No models available
	// 既不能恢复、没有当前模型又无可用快照时，返回两个 undefined；之前的警告只在打印标志开启时显示。
	return { model: undefined, fallbackMessage: undefined };
}
