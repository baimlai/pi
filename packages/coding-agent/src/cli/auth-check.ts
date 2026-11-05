// CLI 认证状态检查及凭证读取辅助：复用 ModelRuntime 与 CredentialStore，区分“有配置”“可解析认证”和“实际模型请求成功”。
// 只引入凭证存储接口的类型，调用方决定使用文件或内存实现；本文件不另建 auth.json。
import type { CredentialStore } from "@earendil-works/pi-ai";
// 把 --model 等文字解析成具体模型，再从模型得出供应商。
import { resolveCliModel } from "../core/model-resolver.ts";
// 认证与模型运行时负责查供应商、检查认证、解析请求凭证；本文件只组织 CLI 检查流程。
import { ModelRuntime } from "../core/model-runtime.ts";
// 认证检查使用内存模型目录存储，不需要为这条命令持久保存模型目录。
import { InMemoryCodingAgentModelsStore } from "../core/models-store.ts";
// 复用 CLI 参数解析结果的类型；字符串数组已经由上游解析成这个对象。
import type { Args } from "./args.ts";
// 共用认证命令的输入约束、错误类型和“解析认证 → 可输出凭证文字”的转换。
import { AuthCommandError, getAuthCredential, validateAuthCommandArgs } from "./auth-command.ts";

// 字面量联合：可用、未准备好、状态异常三种结果；ready 不是一次真实聊天请求成功的证明。
export type AuthCheckStatus = "ready" | "not_ready" | "invalid";
// 结果原因枚举用字符串联合描述；字段供程序/JSON 消费者判断，不依赖错误文案做分支。
export type AuthCheckReason =
	// 运行时没有对应供应商。
	| "provider_not_found"
	// 检查/解析没有拿到可用的认证配置。
	| "credentials_not_configured"
	// 类型预留的“凭证不可取得”原因；当前下方 checkProviderAuth 分支没有返回这一项。
	| "credential_not_available"
	// 运行时配置/可用性错误，或检查过程抛出异常。
	| "invalid_state";

// 只报告认证状态与类型的结构；通常不含实际 API Key 或 token。
export interface AuthCheckResult {
	// 必填状态，调用方根据它决定退出码或显示内容。
	status: AuthCheckStatus;
	// 最终识别出的供应商 id，可能由 --model 推导而来。
	provider: string;
	// 可选原因；ready 路径通常不填。
	reason?: AuthCheckReason;
	// 可选认证类型，不是实际秘密值。
	authType?: "api_key" | "oauth";
}

/**
 * 检查一组 CLI 认证参数对应的供应商是否准备好，返回 ready/not_ready/invalid 及原因，不打印凭证。
 * 流程：参数校验 → 可选模型解析 → 检查运行时/供应商 → checkAuth → 按 refresh 决定是否 getAuth。
 * 例：只查 provider 且 refresh:false 时查看状态；refresh:true 可能刷新 OAuth。参数错误抛给调用方，认证异常转 invalid。
 */
export async function checkProviderAuth(
	// 上游已经解析的 CLI 参数；仍需校验这条认证命令允许哪些输入组合。
	args: Args,
	// 当前模型/认证运行时，用它查目录和执行认证操作。
	modelRuntime: ModelRuntime,
	// 本函数单独调用时默认不刷新；CLI 是否默认刷新由调用方传入 options 决定，不可与帮助文字混为一谈。
	options: { refresh: boolean } = { refresh: false },
	// 异步返回结构化状态；参数解析错误在 try 外，仍会作为拒绝的 Promise 交给调用方。
): Promise<AuthCheckResult> {
	// 先检查输入并解构改名，区分用户传入的 provider/model 与后面确定的供应商。
	const { provider: cliProvider, model: cliModel } = validateAuthCommandArgs(args, "check");
	// 先用显式 --provider，后面如指定 --model 则以解析结果为准。
	let provider = cliProvider;
	// 有模型文字才进入模型解析；只给供应商无需随意选一个模型。
	if (cliModel) {
		// 结合供应商限制与当前模型目录，解析可能带 provider 前缀/模糊名字的模型引用。
		const resolved = resolveCliModel({ cliProvider, cliModel, modelRuntime });
		// 解析失败或没得到模型都不能继续拿不确定供应商检查。
		if (resolved.error || !resolved.model) {
			// 优先保留解析器的具体错误；?? 仅在缺少错误文字时才用通用文案。
			throw new AuthCommandError(resolved.error ?? `Unable to resolve model "${cliModel}"`);
		}
		// 模型元数据携带标准供应商 id，用它覆盖可能未规范化的 CLI 字符串。
		provider = resolved.model.provider;
	}
	// 两条解析路径都没有供应商时拒绝命令，不把空串送到认证层。
	if (!provider) throw new AuthCommandError("Unable to resolve an auth provider");
	// 运行时已有配置/组合/可用性错误时直接报告异常状态，不再继续认证。
	if (modelRuntime.getError()) {
		// 返回结构化 invalid，不在这类状态错误上向 UI 泄漏所有运行时内部细节。
		return { status: "invalid", provider, reason: "invalid_state" };
	}
	// 检查供应商在当前运行时注册目录里是否存在。
	if (!modelRuntime.getProvider(provider)) {
		// 未知供应商按未准备好报告，区别于配置损坏的 invalid。
		return { status: "not_ready", provider, reason: "provider_not_found" };
	}
	// 下面认证检查/刷新抛错时统一映射 invalid；前面的参数解析错误不在此 catch 范围。
	try {
		// 获取认证可用性及类型元数据；这一步不等于发一次真实模型请求。
		const auth = await modelRuntime.checkAuth(provider);
		// 没有认证检查结果就报告未配置，不能从“供应商存在”推断已登录。
		if (!auth) return { status: "not_ready", provider, reason: "credentials_not_configured" };
		// 明确要求 refresh 才解析真实请求认证；OAuth 可能触发刷新/保存，返回空则仍未准备好。
		if (options.refresh && !(await modelRuntime.getAuth(provider))) {
			// 认证解析没有得到结果，返回未准备好而不是 ready。
			return { status: "not_ready", provider, reason: "credentials_not_configured" };
		}
		// 检查通过时报告 ready 及此前查得的认证类型；不把秘密值放入状态结果。
		return { status: "ready", provider, authType: auth.type };
		// 认证过程的异常统一作为 invalid_state；具体错误文本没有附在这个结果里。
	} catch {
		// 返回结构化 invalid，不在这类状态错误上向 UI 泄漏所有运行时内部细节。
		return { status: "invalid", provider, reason: "invalid_state" };
	}
}

/**
 * 读取供应商的可输出凭证，返回字符串或 undefined，本函数不输出到终端。
 * refresh:false 遇到存储 OAuth 就直接返回 access；其余走运行时认证解析，可能刷新并保存。例：过期 token 在不刷新分支也原样返回。
 */
export async function getProviderCredential(
	// 要读取的供应商 id，不是某个具体模型 id。
	providerId: string,
	// 当前模型/认证运行时，用它查目录和执行认证操作。
	modelRuntime: ModelRuntime,
	// 调用方提供的凭证存储，read 可以返回已过期 OAuth 凭证。
	credentials: CredentialStore,
	// 这里没有缺省 options，调用方必须明确是否要求走刷新路径。
	options: { refresh: boolean },
	// 异步返回可输出的秘密文字或 undefined；函数本身不 console.log。
): Promise<string | undefined> {
	// 先读存储原值；存储读取不是认证有效性验证，也不会自动刷新。
	const credential = await credentials.read(providerId);
	// 明确不刷新且存储的是 OAuth 时直接返回现有 access；即便它过期，也不会在此偷做刷新。
	if (!options.refresh && credential?.type === "oauth") return credential.access;
	// 其余情况从运行时解析请求认证，再提取 apiKey 或 Bearer 文字；可能有刷新/存储副作用。
	return getAuthCredential(await modelRuntime.getAuth(providerId));
}

/**
 * 用既有凭证存储创建认证检查运行时，模型缓存使用内存，跳过创建时模型网络与可用性刷新。
 * 返回 ModelRuntime；不保证后续所有认证操作都离线。例：检查命令无需先联网更新模型目录，显式刷新 OAuth 仍可联网。
 */
export async function createAuthCheckModelRuntime(credentials: CredentialStore): Promise<ModelRuntime> {
	// 创建适合认证管理命令的轻量运行时，下面显式选择存储和初始化策略。
	return ModelRuntime.create({
		// 复用传入凭证存储，后续 OAuth 刷新结果仍由该存储管理。
		credentials,
		// 模型目录缓存仅放内存，不为此检查写一套新的模型目录文件。
		modelsStore: new InMemoryCodingAgentModelsStore(),
		// 禁止创建时联网刷新模型目录；这不表示之后 getAuth 的 OAuth 刷新也被禁止联网。
		allowModelNetwork: false,
		// 跳过创建时目录/可用性刷新，静态注册模型仍可用于参数解析。
		refreshOnCreate: false,
	});
}
