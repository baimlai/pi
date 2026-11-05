/**
 * Cloudflare 两类提供商的认证装配：Workers AI 要 key+account，AI Gateway 还要 gateway，并改用网关认证头。
 * 每个字段单独从存储凭证/宿主环境合并；例只存 key 时，account 仍可从环境补齐，不要求所有字段同源。
 * 返回的是本地请求材料，未请求 Cloudflare 验证权限；login 只收集待保存数据，持久化由 Models/宿主负责。
 * 存储空串不是 undefined，会阻止该字段环境回退，随后使配置判为缺失；取消检查只位于实际读取环境的路径。
 */
// 纯类型约束认证回调、凭证及宿主能力，不自动创建登录 UI/取消机制。
import type { ApiKeyAuth, ApiKeyCredential, AuthContext } from "../auth/types.ts";
// 提供商作用域的字符串配置表，account/gateway id 不作为聊天消息传入。
import type { ProviderEnv } from "../types.ts";

// 固定配置名用于存储 env 字段及 ctx.env 查询，常量本身不含秘密值。
const CLOUDFLARE_API_KEY = "CLOUDFLARE_API_KEY";
const CLOUDFLARE_ACCOUNT_ID = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_GATEWAY_ID = "CLOUDFLARE_GATEWAY_ID";

// 字面量联合限定两种装配策略，运行时仍是字符串，不是枚举对象。
type CloudflareAuthKind = "workers-ai" | "ai-gateway";

/**
 * 取一个认证字段：先查凭证（key 或 env[name]），只有 undefined 才 await 宿主环境。
 * 输入字段名、宿主能力、可选 API key 凭证与信号，返回字符串/缺失；例只存 key 时 account 继续查 ctx.env。
 * 环境读取前后检查取消，宿主读取可有 I/O/异常；直接命中存储时不检查 signal，空串也直接返回，不做远端验证。
 */
async function resolveValue(
	// 内部使用上面三个常量，签名仍允许任意字符串。
	name: string,
	// 宿主提供异步 env，不在这里直接读 process.env。
	ctx: AuthContext,
	// 凭证及其 key/env 字段都可能缺省。
	credential: ApiKeyCredential | undefined,
	// 必需信号不等于每条分支都运行取消检查。
	signal: AbortSignal,
): Promise<string | undefined> {
	// Per-field merge: prefer the credential value, fall back to ambient env.
	// A credential carrying only the API key must still pick up the account /
	// gateway id from the environment.
	// 多层三元：有凭证时，API key 从 key 读，其他字段从 env[name] 读。
	const fromCredential = credential
		? name === CLOUDFLARE_API_KEY
			? credential.key
			: credential.env?.[name]
		: undefined;
	// 空串也直接返回，只有 undefined 回退环境；此 return 在取消检查之前。
	if (fromCredential !== undefined) return fromCredential;
	// 真要读取环境时，已取消就不启动该查询。
	signal.throwIfAborted();
	// 可异步且可失败；本文件不缓存多次环境查询结果。
	const value = await ctx.env(name);
	// 等待期间取消则不使用后来取得的值。
	signal.throwIfAborted();
	// 不 trim/编码/验证字段，原样返回字符串或 undefined。
	return value;
}

/**
 * 顺序取 key→account→必要时 gateway，必要字段都是真值才返回 {apiKey,env,source}，否则 undefined。
 * 例 Workers AI 不要求 gateway，Gateway 缺 gateway 就判未配置；前一字段缺失也仍会继续读取后面的字段。
 * 不联网校验，source 仅按凭证对象是否存在选标签，不精确追踪各值来源；全存储命中路径没有取消检查。
 */
async function resolveCloudflareEnv(
	// 控制是否额外查询/要求 gateway id。
	kind: CloudflareAuthKind,
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Promise<{ apiKey: string; env: ProviderEnv; source: string } | undefined> {
	// 各 await 逐个完成，非并发查询。
	const apiKey = await resolveValue(CLOUDFLARE_API_KEY, ctx, credential, signal);
	const accountId = await resolveValue(CLOUDFLARE_ACCOUNT_ID, ctx, credential, signal);
	// Workers AI 直接给 undefined，不读取其凭证/环境中的 gateway 字段。
	const gatewayId =
		kind === "ai-gateway" ? await resolveValue(CLOUDFLARE_GATEWAY_ID, ctx, credential, signal) : undefined;

	// 缺失/空串不算配置齐备，空白串仍是真值；不据此推断远端权限有效。
	if (!apiKey || !accountId || (kind === "ai-gateway" && !gatewayId)) return undefined;

	return {
		// key 由下层分别映射成普通 Bearer 或网关专有认证头。
		apiKey,
		env: {
			// 只发布所需配置，不复制凭证中的全部 env 键。
			CLOUDFLARE_ACCOUNT_ID: accountId,
			// gateway 真有值才添加；Workers AI 输出环境不带它。
			...(gatewayId ? { CLOUDFLARE_GATEWAY_ID: gatewayId } : {}),
		},
		// 存在 credential 对象就标 stored，即使部分/全部字段实际从环境补来；不把秘密值作为标签。
		source: credential ? "stored credential" : CLOUDFLARE_API_KEY,
	};
}

/**
 * 创建 Workers AI 认证器，无参数，返回展示名/login/resolve；构造时不查询环境、弹窗或发网络请求。
 * 例 login 收 key/account，产待存 {type:"api_key",key,env:{CLOUDFLARE_ACCOUNT_ID}}；resolve 齐备后返回请求 apiKey+env。
 * login 无显式 signal 检查，也没向单次 prompt 附 signal，取消依赖交互宿主契约；空输入不在登录时验证。
 */
export function cloudflareWorkersAIAuth(): ApiKeyAuth {
	return {
		// 供登录界面展示，不是密钥本身。
		name: "Cloudflare API key",
		// 实际登录才执行；异步返回凭证，持久化交外层。
		login: async (interaction) => {
			// 用秘密输入类别收 key；隐藏显示/取消由 prompt 实现负责。
			const key = await interaction.prompt({ type: "secret", message: "Enter Cloudflare API key" });
			// key 答完后再询问账户，不查远端账户关系。
			const accountId = await interaction.prompt({ type: "text", message: "Enter Cloudflare account ID" });
			// 返回普通对象，type 是凭证判别标签，env 不是 HTTP 头。
			return { type: "api_key", key, env: { CLOUDFLARE_ACCOUNT_ID: accountId } };
		},
		// 参数解构得到宿主/凭证/信号；async 使解析异常拒绝 Promise。
		resolve: async ({ ctx, credential, signal }) => {
			// 此 kind 仅要求 key/account。
			const resolved = await resolveCloudflareEnv("workers-ai", ctx, credential, signal);
			// 没配齐交上层处理未配置，不伪造空 key。
			if (!resolved) return undefined;
			return {
				// Workers AI 底层适配器将显式 apiKey 转成 Bearer 头。
				auth: { apiKey: resolved.apiKey },
				// account 供 endpoint wrapper 替换模型 URL 占位符。
				env: resolved.env,
				// 展示来源不等于远端 key 验证结果。
				source: resolved.source,
			};
		},
	};
}

/**
 * 创建 AI Gateway 认证器，比 Workers AI 多收 gateway id，并把 key 放在 cf-aig-authorization。
 * 例 key=k/account=a/gateway=g，解析出网关 Bearer 头及两个 null，让下游抑制普通供应商认证头。
 * 不把 Cloudflare token 当上游 OpenAI/Anthropic BYOK key；null 的实际消费在 Models/适配器/SDK 层，本工厂不发请求或剥 HTTP 头。
 */
export function cloudflareAIGatewayAuth(): ApiKeyAuth {
	return {
		// 与 Workers AI 共用展示名，但下面配置要求/请求认证形式不同。
		name: "Cloudflare API key",
		// 顺序收三个值，无自身取消/非空/权限验证，返回待存凭证。
		login: async (interaction) => {
			// key 仍按秘密输入类别收集。
			const key = await interaction.prompt({ type: "secret", message: "Enter Cloudflare API key" });
			// 账户 id 与 key 分开保存。
			const accountId = await interaction.prompt({ type: "text", message: "Enter Cloudflare account ID" });
			// 第三次提示属于网关，值将填入模型端点的 gateway 占位符。
			const gatewayId = await interaction.prompt({ type: "text", message: "Enter Cloudflare AI Gateway ID" });
			return {
				// 判别联合标签与凭证 key 字段。
				type: "api_key",
				key,
				// 两个 id 放提供商作用域环境，不串入一个秘密字符串。
				env: { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_GATEWAY_ID: gatewayId },
			};
		},
		resolve: async ({ ctx, credential, signal }) => {
			// 逐字段解析且强制要求第三个 gateway id。
			const resolved = await resolveCloudflareEnv("ai-gateway", ctx, credential, signal);
			// 缺任一必要真值都给未配置结果。
			if (!resolved) return undefined;
			return {
				auth: {
					// 本分支没有 auth.apiKey，直接声明网关专用认证头。
					headers: {
						"cf-aig-authorization": `Bearer ${resolved.apiKey}`,
						// null 是下游删除标记，不是发往服务器的字符串 "null"。
						Authorization: null,
						"x-api-key": null,
					},
				},
				// 两个 id 交给端点替换，不作为额外认证 token。
				env: resolved.env,
				// 复用来源标签，实际字段可能混合存储/环境来源。
				source: resolved.source,
			};
		},
	};
}
