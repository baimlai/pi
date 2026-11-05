// 为模型请求生成应用身份请求头；Models/各API适配器复用，控制User-Agent和供应商归因，不保存聊天记忆。
// Models是查询/请求接口，MutableModels额外允许增删供应商；只导入开发期类型。
import type { Models, MutableModels } from "../models.ts";
// 详细User-Agent默认使用包版本；该常量由版本同步脚本维护。
import { PI_AI_VERSION } from "./version.ts";

/**
 * The `User-Agent` sent to providers:
 * - `"detailed"`: `pi/<version> (<platform>; <runtime>/<runtime version>; <arch>)`, or `pi/<version> (browser)`
 *   outside Node.js and Bun.
 * - `"short"`: `pi`.
 * - `{ custom }`: the given value.
 */
// 联合类型允许短名字、详细运行时说明，或提供自定义字符串；后面按字符串/对象收窄。
export type UserAgentMode = "short" | "detailed" | { custom: string };

/** Who requests are attributed to. `getAttributionHeaders()` maps the fields to each provider's headers. */
// 应用归因信息，不是认证凭证；不同供应商把这些字段映射到自己的请求头。
export interface ClientAttribution {
	/** App name: OpenRouter app title, NVIDIA invoke origin (first letter upper-cased), OpenCode client. */
	// 调用应用名，例如pi；影响供应商排行榜/来源说明等元数据。
	name: string;
	/** App URL: OpenRouter `HTTP-Referer`, the app's identity in OpenRouter's rankings, grouped by origin. */
	// 应用URL，OpenRouter以其作为HTTP-Referer等身份来源。
	url: string;
	/** App categories, e.g. `["cli-agent"]`: OpenRouter `X-OpenRouter-Categories`, comma-separated. */
	// 可选类别数组，例如cli-agent；没提供则不发送类别头。
	categories?: string[];
}

/** pi's attribution, used by pi-agent-core, pi-durable, and the coding agent. */
// Pi默认归因的普通对象，可被上层Agent组合进identity；pi-ai本身默认不强制启用归因。
export const PI_ATTRIBUTION: ClientAttribution = { name: "pi", url: "https://pi.dev", categories: ["cli-agent"] };

/**
 * How pi-ai identifies the calling app to providers. Every field is optional; absent fields use pi-ai's defaults:
 * a detailed `User-Agent` with pi-ai's version and no attribution headers. Plain JSON, so it can be persisted.
 */
// 整个请求身份配置，可JSON保存；每项可省略，由下方默认规则补齐。
export interface ClientIdentity {
	/** Default: `"detailed"`. */
	// 决定User-Agent具体形态；不提供时使用detailed。
	userAgent?: UserAgentMode;
	/** Provider attribution headers. Absent or `null`: none; `null` also turns off attribution set by a merged identity. */
	// 归因可为对象、缺失或null；合并时null能明确关闭此前设置，而undefined表示不覆盖。
	attribution?: ClientAttribution | null;
	/** Version in the detailed `User-Agent`. Default: the pi-ai version. */
	// 允许应用指定详细User-Agent里的版本，省略则采用PI_AI_VERSION。
	version?: string;
}

/** The provider and endpoint a request goes to. */
// 只读请求目标：目标供应商和URL共同决定应添加哪些专有请求头。
export interface ClientIdentityTarget {
	// 供应商注册标识；readonly限制TS调用方赋值，不冻结运行时对象。
	readonly provider: string;
	// 实际服务地址，自定义供应商也可能指向已知网关。
	readonly baseUrl: string;
}

// NVIDIA识别用精确主机名，避免随便给无关目标发专用头。
const NVIDIA_NIM_HOST = "integrate.api.nvidia.com";
// OpenCode识别用主机名，兼容自定义供应商名称。
const OPENCODE_HOST = "opencode.ai";

/** Merge identities field by field; later sources win and undefined fields are skipped. */
// 用途：按来源顺序逐字段合并身份，后值覆盖前值、undefined跳过。例默认attribution对象再加{attribution:null}会关闭归因；没有来源则返回undefined，不改输入对象。
export function mergeClientIdentity(...sources: (ClientIdentity | undefined)[]): ClientIdentity | undefined {
	// 尚未遇到有效来源时不创建对象。
	let merged: ClientIdentity | undefined;
	// 剩余参数sources按调用顺序处理，形成默认→应用→请求的覆盖层次。
	for (const source of sources) {
		// 跳过没有提供的来源。
		if (!source) continue;
		// 每次遇到来源先创建结果副本，不直接修改任何来源对象。
		merged = { ...merged };
		// 只有明确给值才覆盖；短/详细/自定义三种形状都能保留。
		if (source.userAgent !== undefined) merged.userAgent = source.userAgent;
		// null属于明确值，会被写入，从而关闭早先归因。
		if (source.attribution !== undefined) merged.attribution = source.attribution;
		// 版本字段也只在明确提供时覆盖。
		if (source.version !== undefined) merged.version = source.version;
	}
	// 返回合并对象或完全没有来源时的undefined。
	return merged;
}

/** The version in the detailed `User-Agent`. */
// 用途：取身份版本。例{version:"2.0"}返回2.0，未提供则包版本；不解析版本号格式。
export function getClientVersion(identity?: ClientIdentity): string {
	// ?.允许省略identity，??只为空缺版本补默认值。
	return identity?.version ?? PI_AI_VERSION;
}

// 用途：识别Node/Bun运行时供User-Agent展示。例Bun优先显示bun版本，普通Node显示process.version，浏览器返回undefined。
function runtimeDescription(): string | undefined {
	// 运行环境边界：浏览器没有Node全局process，不能直接访问。
	if (typeof process === "undefined") return undefined;
	// 读取运行时版本能力表，不向外发请求。
	const versions = process.versions;
	// Bun兼容Node也可能提供node版本，因此先判断bun。
	if (versions?.bun) return `bun/${versions.bun}`;
	// Node字符串包含其实际版本标识，使用process.version保留常见v前缀。
	if (versions?.node) return `node/${process.version}`;
	// 没有可识别运行时就不给出运行时描述，交由调用者采用浏览器样式或缺省结果。
	return undefined;
}

/** The `User-Agent` value of an identity. */
// 用途：按配置生成User-Agent。例short得到pi，自定义对象原样用custom，detailed形如pi/版本(platform;node/版本;arch)；只生成文字。
export function formatUserAgent(identity?: ClientIdentity): string {
	// 缺省详细模式，读取可选嵌套字段。
	const mode = identity?.userAgent ?? "detailed";
	// 联合类型的对象分支就是自定义值，TS由此知道有custom字段。
	if (typeof mode === "object") return mode.custom;
	// 短模式不泄露版本/运行平台信息。
	if (mode === "short") return "pi";
	// 详细模式的产品部分，版本可被identity覆盖。
	const product = `pi/${getClientVersion(identity)}`;
	// 取得刚才的Bun/Node描述，浏览器可能没有。
	const runtime = runtimeDescription();
	// 有运行时才访问对应process平台/架构；否则采用browser标记。
	return runtime ? `${product} (${process.platform}; ${runtime}; ${process.arch})` : `${product} (browser)`;
}

// 用途：比较URL实际hostname，解析失败返回false。例https://opencode.ai/v1匹配opencode.ai，其他域名路径里含同样文字不算匹配。
function matchesHost(baseUrl: string, expectedHost: string): boolean {
	// URL解析接受来自调用配置的字符串，可能有格式错误。
	try {
		// 用标准URL解析得到hostname，排除端口、路径和查询参数的干扰。
		return new URL(baseUrl).hostname === expectedHost;
		// 无法解析的地址不应让身份头生成再抛一个新错。
	} catch {
		// 当前身份识别条件不成立，不添加相应专有信息。
		return false;
	}
}

// 用途：识别OpenRouter目标。按注册名或URL子串判断，例自定义名但URL含openrouter.ai也匹配；这不是严格主机白名单。
function isOpenRouter(target: ClientIdentityTarget): boolean {
	// 此供应商识别沿用兼容规则，注意它与下方matchesHost精确主机比较不同。
	return target.provider === "openrouter" || target.baseUrl.includes("openrouter.ai");
}

// 用途：识别NVIDIA注册项或其已知NIM主机，决定是否发NVIDIA归因头。
function isNvidiaNim(target: ClientIdentityTarget): boolean {
	// 任一条件满足即使用NVIDIA头名。
	return target.provider === "nvidia" || matchesHost(target.baseUrl, NVIDIA_NIM_HOST);
}

// 用途：识别OpenCode/Go注册项或指向官方主机的自定义供应商，用于归因和会话路由头。
function isOpenCode(target: ClientIdentityTarget): boolean {
	return (
		// 支持两个供应商名，也支持同主机的自定义注册名称。
		target.provider === "opencode" || target.provider === "opencode-go" || matchesHost(target.baseUrl, OPENCODE_HOST)
	);
}

/** Provider attribution headers of an identity for a request target. Empty when attribution is off. */
// 用途：把应用归因映射成目标供应商专有头。例OpenRouter映射HTTP-Referer与标题；关闭/未知目标返回空对象，不发送认证信息。
export function getAttributionHeaders(target: ClientIdentityTarget, identity?: ClientIdentity): Record<string, string> {
	// 先看是否启用归因，而非总把Pi默认归因强塞给所有请求。
	const attribution = identity?.attribution;
	// undefined和显式null都表示不加归因头。
	if (!attribution) return {};
	// 解构取出普通字段，便于下方按供应商映射。
	const { name, url, categories } = attribution;
	// OpenRouter有应用标题、URL和类别三项专有头。
	if (isOpenRouter(target)) {
		return {
			// 应用URL作为OpenRouter归因来源。
			"HTTP-Referer": url,
			// 显示调用应用名，不是聊天会话标题。
			"X-OpenRouter-Title": name,
			// 类别没提供或为空时，下面展开空对象，不生成空类别头。
			...(categories === undefined || categories.length === 0
				? // 没有可用类别时不添加任何字段。
					{}
				: // 有类别时将数组按逗号合成单个请求头字符串。
					{ "X-OpenRouter-Categories": categories.join(",") }),
		};
	}
	// NVIDIA expects a capitalized origin, such as `Pi`.
	// NVIDIA要求来源名字首字母大写；只处理第一个字符，其余保持原样。
	if (isNvidiaNim(target)) return { "X-BILLING-INVOKE-ORIGIN": name.charAt(0).toUpperCase() + name.slice(1) };
	// OpenCode仅需要应用名字段。
	if (isOpenCode(target)) return { "x-opencode-client": name };
	// 未知目标或无需额外字段时返回空对象，方便调用者对象展开合并。
	return {};
}

/**
 * OpenCode's per-conversation routing header for requests to OpenCode, including custom providers pointing at it.
 * Undefined without a session or for other targets.
 */
// 用途：只给OpenCode目标带每会话路由id。例sessionId="s1"且目标是OpenCode，返回x-opencode-session；其他供应商或无id返回undefined。
export function getOpenCodeSessionHeaders(
	// 请求实际目标，不能仅因会话有id就发给所有供应商。
	target: ClientIdentityTarget,
	// 会话id由调用方提供；undefined表示没有会话信息。
	sessionId: string | undefined,
): Record<string, string> | undefined {
	// &&要求非空id和匹配目标同时成立；三元表达式决定返回头对象还是缺省。
	return sessionId && isOpenCode(target) ? { "x-opencode-session": sessionId } : undefined;
}

/**
 * Default headers an identity adds to a request: `User-Agent` and provider attribution. APIs apply them below model,
 * provider, and request headers, so configured headers override them and `null` request headers remove them.
 */
// 用途：生成基础身份头。例一份User-Agent加目标供应商归因；模型/供应商/请求的显式头在更外层可覆盖或删除这些默认项。
export function getIdentityHeaders(target: ClientIdentityTarget, identity?: ClientIdentity): Record<string, string> {
	// 先写通用User-Agent，再展开归因头；这些都只是普通键值数据。
	return { "User-Agent": formatUserAgent(identity), ...getAttributionHeaders(target, identity) };
}

// 用途：识别Models接口是否还支持供应商增删。例有setProvider/deleteProvider/clearProviders就继续保留可变能力；类型谓词让后面的转发可调用这些成员。
function isMutableModels(models: Models): models is MutableModels {
	// 基于接口能力收窄合法联合使用场景，不复制Models内部状态。
	return "setProvider" in models && "deleteProvider" in models && "clearProviders" in models;
}

/**
 * `models` with `identity` as the default identity of its requests: a request's `identity` overrides it field by
 * field, and it overrides the identity `models` was created with. Everything else is delegated unchanged; a
 * `MutableModels` stays mutable.
 */
// 重载声明：传可变Models就返回可变接口；只有类型签名，没有独立函数体。
export function withClientIdentity(models: MutableModels, identity: ClientIdentity): MutableModels;
// 第二重载：普通只读Models返回同类接口。
export function withClientIdentity(models: Models, identity: ClientIdentity): Models;
// 用途：给现有Models创建身份默认值包装器，其他调用原样转发。例应用默认名A、本次请求显式版本B会逐字段合并；不改原Models，Mutable能力也保留。
export function withClientIdentity(models: Models, identity: ClientIdentity): Models {
	// 泛型辅助函数保留原options类型，只在其中合成identity；箭头函数直到请求转发时才执行。
	const withIdentity = <T extends { identity?: ClientIdentity }>(options: T | undefined): T =>
		// 先复制请求选项，再把包装器默认与请求显式身份合并；请求值优先，as不会运行校验。
		({ ...options, identity: mergeClientIdentity(identity, options?.identity) }) as T;
	// 构造“方法转发对象”，不是复制整个Models实例或目录。
	const wrapped: Models = {
		// 查询供应商列表直接委托原对象，不改返回值。
		getProviders: () => models.getProviders(),
		// 按id取供应商仍调用原实现。
		getProvider: (id) => models.getProvider(id),
		// 聊天模型目录查询不涉及请求身份。
		getModels: (provider) => models.getModels(provider),
		// 单模型查询保留原provider/id查找规则。
		getModel: (provider, id) => models.getModel(provider, id),
		// 按模型种类过滤的目录查询直接转发。
		getModelsOfType: (type, provider) => models.getModelsOfType(type, provider),
		// 按种类查单个模型同样不改行为。
		getModelOfType: (type, provider, id) => models.getModelOfType(type, provider, id),
		// 包含各模型种类的查询复用原对象。
		getAllModels: (provider) => models.getAllModels(provider),
		// 刷新目录操作不被身份包装器接管。
		refresh: (options) => models.refresh(options),
		// 认证检查照原选项执行，不把归因头当认证凭证。
		checkAuth: (providerId, options) => models.checkAuth(providerId, options),
		// 可用聊天模型查询原样转发。
		getAvailable: (providerId, options) => models.getAvailable(providerId, options),
		// 指定种类的可用模型查询原样转发。
		getAvailableOfType: (type, providerId, options) => models.getAvailableOfType(type, providerId, options),
		// 所有种类的可用模型查询原样转发。
		getAllAvailable: (providerId, options) => models.getAllAvailable(providerId, options),
		// bind固定this为原Models，避免直接取方法后丢失实例上下文，并保留原重载行为。
		getAuth: models.getAuth.bind(models),
		// 登录仍调用原供应商认证流程和交互回调。
		login: (providerId, type, interaction, options) => models.login(providerId, type, interaction, options),
		// 登出不增加请求身份包装副作用。
		logout: (providerId, options) => models.logout(providerId, options),
		// 实际模型流请求先合并身份，再委托原stream。
		stream: (model, context, options) => models.stream(model, context, withIdentity(options)),
		// 等待完整回答的请求也应用同一身份默认规则。
		complete: (model, context, options) => models.complete(model, context, withIdentity(options)),
		// 简化请求流入口同样合并identity，保留模型和上下文。
		streamSimple: (model, context, options) => models.streamSimple(model, context, withIdentity(options)),
		// 简化完整回答入口继续复用原实现。
		completeSimple: (model, context, options) => models.completeSimple(model, context, withIdentity(options)),
		// 读取延后任务的流时也附上身份；handle不做修改。
		streamDeferred: (model, handle, options) => models.streamDeferred(model, handle, withIdentity(options)),
		// 获取延后任务完整结果同样应用身份。
		fetchDeferred: (model, handle, options) => models.fetchDeferred(model, handle, withIdentity(options)),
		// 取消延后任务是远端操作，也要带一致身份信息。
		cancelDeferred: (model, handle, options) => models.cancelDeferred(model, handle, withIdentity(options)),
		// 图片生成请求按相同规则合并身份。
		generateImages: (model, context, options) => models.generateImages(model, context, withIdentity(options)),
		// 分类请求也不会遗漏包装器默认身份。
		classify: (model, context, options) => models.classify(model, context, withIdentity(options)),
	};
	// 原对象不支持修改供应商时，普通包装接口已足够。
	if (!isMutableModels(models)) return wrapped;
	// 原对象可变，则在普通包装基础上继续暴露三个管理方法。
	const mutable: MutableModels = {
		// 对象展开带上上面全部查询和请求转发函数。
		...wrapped,
		// 设置供应商仍修改原Models，而不是在包装器另建一份目录。
		setProvider: (provider) => models.setProvider(provider),
		// 删除操作同样转发到原管理对象。
		deleteProvider: (id) => models.deleteProvider(id),
		// 清空操作保留原实现的行为和返回值。
		clearProviders: () => models.clearProviders(),
	};
	// 返回能力与输入匹配的包装器。
	return mutable;
}
