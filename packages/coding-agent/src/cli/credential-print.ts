// 为 auth print-api-key / print-bearer-token 选择并返回唯一秘密值。区分存储凭证类型、模型匹配与请求认证解析，不把状态检查当作实际远端调用验证。
// 只导入模型协议及凭证元数据类型；CredentialInfo 的 type 表示存储的是 api_key 还是 oauth。
import type { Api, CredentialInfo, Model } from "@earendil-works/pi-ai";
// 分别处理明确供应商下的模型选择，以及跨已有凭证供应商逐一匹配模型引用。
import { resolveCliModel, resolveModelReference } from "../core/model-resolver.ts";
// 运行时接口负责查模型/供应商与认证解析；这里只使用传入实例，不另创建它。
import type { ModelRuntime } from "../core/model-runtime.ts";
// 通用 CLI 参数的类型，认证专用选项已由 parseAuthCommand 拿出。
import type { Args } from "./args.ts";
// 共用命令错误、合法种类、输入校验及请求认证的秘密文字提取。
import { AuthCommandError, type AuthCommandKind, getAuthCredential, validateAuthCommandArgs } from "./auth-command.ts";

// 本打印入口默认要求 OAuth 至少剩 30 分钟；不能与 getAuth 通用缺省的 5 分钟刷新窗口混淆。
const DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS = 30 * 60_000;

// Exclude 去掉状态检查种类，静态上只允许打印 api_key 或 bearer_token 两种操作。
type CredentialPrintKind = Exclude<AuthCommandKind, "check">;

/**
 * Resolve one configured provider credential.
 *
 * This intentionally calls ModelRuntime.getAuth(), which refreshes and persists
 * OAuth credentials with less than five minutes remaining through the normal request-auth path.
 */
/**
 * 选择唯一供应商凭证并返回秘密字符串，供上层显式输出；没有/多个候选或类型不匹配时抛 AuthCommandError。
 * 流程：验证 provider/model → 枚举存储类型 → 确定候选供应商/模型 → 按 key/OAuth 类别筛选 → getAuth → 提取 → 唯一性判断。
 * 副作用可能包括 OAuth 刷新网络和凭证保存，本函数本身不打印。例：打印某家 OAuth Bearer 时，未传 --min-expiry 默认要求剩 30 分钟。
 * 上方旧英语说明描述 getAuth 通用的 5 分钟窗口；本入口 Bearer 会显式传 minOAuthValidityMs。底层取它与 5 分钟的较大值，刷新后仍不足显式要求会报错。
 */
export async function resolveCredentialForPrint(
	// 包含 provider/model 的上游解析结果，下面先验证合法输入组合。
	args: Args,
	// 模型目录、凭证元数据和认证操作的统一来源。
	modelRuntime: ModelRuntime,
	// 决定导出 API Key 还是 OAuth Bearer；结果都是秘密字符串，认证类别不能只看返回字段名猜测。
	kind: CredentialPrintKind,
	// 可选显式 OAuth 最小剩余时长，单位毫秒，仅 Bearer 分支设置到 getAuth 选项。
	minExpiryMs?: number,
	// 可选取消信号，沿凭证元数据读取及认证解析传递；不会由这个类型声明自动终止工作。
	signal?: AbortSignal,
	// 异步返回唯一匹配的凭证；没有或有多个候选会抛错，函数不直接把秘密打印到 stdout。
): Promise<string> {
	// 检查参数，再通过解构改名保留用户显式指定的目标。
	const { provider: cliProvider, model: cliModel } = validateAuthCommandArgs(args, kind);
	// 建立供应商 id 到凭证存储类型的 Map；索引访问类型复用 CredentialInfo 的 type 联合。
	const credentialTypes = new Map<string, CredentialInfo["type"]>(
		// 只枚举非秘密元数据来筛选类别；这里不读取每个 token 值，也不发聊天请求。
		(await modelRuntime.listCredentials({ signal })).map((credential) => [credential.providerId, credential.type]),
	);
	// 候选列表可只含供应商 id，也可携带具体模型；模型用于解析模型级配置的请求认证。
	const providers: Array<{ id: string; model?: Model<Api> }> = [];
	// 用户明确供应商时先锁定它，避免按模型名在多个登录账户间猜测。
	if (cliProvider) {
		// 从当前注册目录拿供应商对象；无对象就无法知道它的认证实现。
		const provider = modelRuntime.getProvider(cliProvider);
		// 未知供应商属于命令选择错误，不是可忽略的空凭证。
		if (!provider) {
			// 给出可操作的目标错误，不在这里尝试任意供应商。
			throw new AuthCommandError(`Unknown provider "${cliProvider}". Use --list-models to see available providers.`);
		}
		// 同样指定了模型时，在这家供应商中解析具体模型。
		if (cliModel) {
			// 模型解析器会处理模型引用和歧义，使用规范供应商 id 作为限制。
			const resolved = resolveCliModel({ cliProvider: provider.id, cliModel, modelRuntime });
			// 解析器报错或没给模型，都不能继续导出一个不确定目标。
			if (resolved.error || !resolved.model) {
				// 优先传播具体解析原因。
				throw new AuthCommandError(resolved.error ?? "Unable to resolve the requested provider/model");
			}
			// 保留供应商与模型，以便稍后应用模型级认证配置。
			providers.push({ id: provider.id, model: resolved.model });
		} else {
			// 只给供应商时不随意挑模型，直接走供应商认证解析。
			providers.push({ id: provider.id });
		}
	} else {
		// 没有显式供应商时拿全部聊天模型目录，逐个供应商匹配给定模型引用。
		const models = modelRuntime.getModels();
		// 遍历注册供应商，不假定相同模型 id 只由一家提供。
		for (const provider of modelRuntime.getProviders()) {
			// 跨供应商模式只考虑存储里有凭证元数据的供应商；这里不把环境认证候选一概自动加入。
			if (!credentialTypes.has(provider.id)) continue;
			// 在当前供应商范围内匹配模型文字，支持模糊引用并严格处理思考后缀。
			const resolved = resolveModelReference(
				// ! 是非空断言；之前参数校验保证没给 provider 时必须有 model，断言本身不会在运行时补值。
				{ text: cliModel!, provider: provider.id, thinkingSuffix: "strict", fuzzy: true },
				// 传给解析器完整模型目录，再由 provider 限制选取范围。
				models,
				// 可用性回调恒真，因为这一轮已按存储凭证筛过供应商；它不是验证 token 可用于远端请求。
				() => true,
			);
			// 只保留唯一解析成功的模型；not-found/ambiguous 不在这里冒充成功。
			if (resolved.status === "resolved") providers.push({ id: provider.id, model: resolved.model });
		}
		// 所有已有凭证供应商都没有匹配到模型时，直接报模型未找到。
		if (providers.length === 0) {
			// 这个阶段还没有可导出的目标，因此不是直接返回空秘密字符串。
			throw new AuthCommandError(`Model "${cliModel}" not found. Use --list-models to see available models.`);
		}
	}

	// 后续存实际秘密值，只保留真正解析出了可用字符串的候选；本函数不日志打印这个数组。
	const credentials: Array<{ providerId: string; value: string }> = [];
	// 对候选逐个认证解析，可能触发 OAuth 网络刷新及凭证持久化。
	for (const provider of providers) {
		// 用存储元数据区分 OAuth 与 API Key，不能仅凭 getAuth 返回的 apiKey 字段分类。
		const type = credentialTypes.get(provider.id);
		// 打印 API Key 时跳过存储 OAuth 的供应商，避免把 access token 当普通 key 导出。
		if (kind === "api_key" && type === "oauth") continue;
		// 打印 Bearer token 必须是已存 OAuth；普通 key 或没有此元数据都跳过。
		if (kind === "bearer_token" && type !== "oauth") continue;
		// 为这一候选建立认证选项；最小有效期只在 Bearer 分支明确传入。
		const authOptions = {
			// 条件对象展开：Bearer 使用显式时长或本入口默认 30 分钟；API Key 分支展开空对象，不改变其认证策略。
			...(kind === "bearer_token" ? { minOAuthValidityMs: minExpiryMs ?? DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS } : {}),
			// 把同一取消信号继续传入认证层。
			signal,
		};
		// 候选带具体模型时让运行时也处理模型级请求配置；没有模型就只按供应商解析。
		const auth = provider.model
			? // 模型版本 getAuth 会在基础认证后合并相应模型/供应商配置的请求头等。
				await modelRuntime.getAuth(provider.model, authOptions)
			: // 供应商版本直接解析这家供应商的请求认证。
				await modelRuntime.getAuth(provider.id, authOptions);
		// 提取非空 apiKey 或 Bearer header 的文字；不是重新登录或验证远端 API 能否成功。
		const value = getAuthCredential(auth);
		// 只有成功取得文字值才加入可导出列表，保留 id 便于歧义错误定位。
		if (value) credentials.push({ providerId: provider.id, value });
	}

	// 只找到一个实际凭证时才能返回，避免默认选列表第一个。
	if (credentials.length === 1) return credentials[0].value;
	// 没有可导出的秘密时区分类型不匹配与一般未配置。
	if (credentials.length === 0) {
		// 取首个已匹配目标辅助生成错误；?. 允许列表不存在首项。
		const providerId = providers[0]?.id;
		// 只有明确目标才取存储凭证种类。
		const type = providerId ? credentialTypes.get(providerId) : undefined;
		// 用户点名的供应商只有 OAuth，但要求 API Key，给出明确类型错误。
		if (cliProvider && kind === "api_key" && type === "oauth") {
			// 不把 OAuth 令牌伪装成 API Key 以满足错误的命令种类。
			throw new AuthCommandError(`Provider "${providerId}" is configured with OAuth, not an API key`);
		}
		// 要求 OAuth token 而这家不是存储 OAuth 时，给对应类型提示。
		if (cliProvider && kind === "bearer_token" && type !== "oauth") {
			// 此处依据的是本地存储类型，不是对远端账户资格的完整判断。
			throw new AuthCommandError(`Provider "${providerId}" is not configured with an OAuth bearer token`);
		}
		// 其他无结果情况用通用未配置错误结束。
		throw new AuthCommandError(`No usable ${kind === "api_key" ? "API key" : "OAuth bearer token"} is configured`);
	}
	// 有多个可导出凭证时拒绝歧义，要求用户用 --provider 缩小目标。
	throw new AuthCommandError(
		`Multiple configured providers matched (${credentials.map(({ providerId }) => providerId).join(", ")}). Specify --provider.`,
	);
}
