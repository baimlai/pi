// 认证模块的共享数据与接口契约，供 Models、Provider 和宿主存储使用；import type 不产生运行时值。
import type { ProviderEnv, ProviderHeaders } from "../types.ts";

/**
 * Request auth for a single model request. If a value cannot be expressed as
 * `apiKey`, `headers`, or `baseUrl`, it is provider config, not auth.
 */
// 一次请求所需的认证材料，不是持久凭证或全部 Provider 配置；接口不执行网络验证。
export interface ModelAuth {
	// 可选请求 key，可能由 API key 或 OAuth access 派生，具体适配器解释。
	apiKey?: string;
	// 请求头可含 null 抑制标记，后续合并/HTTP构建才消费。
	headers?: ProviderHeaders;
	// 认证可提供账户专属端点，供请求装配覆盖模型地址。
	baseUrl?: string;
}

/**
 * Stored api-key credential. `env` holds provider-scoped environment/config
 * values such as Cloudflare account/gateway ids.
 */
// 持久 API key 凭证形状，env 可存账户/网关 id 等供应商字段。
export interface ApiKeyCredential {
	// 字面量 type 是可分辨联合的标签，不是 TypeScript 的类型查询语法。
	type: "api_key";
	// key 可省略，允许只有环境配置或环境型认证来源的条目。
	key?: string;
	// 供应商作用域环境配置，区别于直接传 HTTP 头。
	env?: ProviderEnv;
}

/** OAuth token data returned by extension compatibility flows. */
// 旧扩展 OAuth 数据共用形状，access/refresh 的具体含义由各flow约定，不必都是标准token对。
export interface OAuthCredentials {
	// 刷新材料；如Copilot可保存GitHub token、Meta可保存身份token，OpenRouter可为空串。
	refresh: string;
	// 实际请求认证材料；可能是access token，也可能是铸造的API key。
	access: string;
	// 绝对到期时间，单位Unix毫秒；各flow可能先扣安全余量，不是expires_in秒数。
	expires: number;
	// 索引签名允许账户id等额外字段；unknown要求读取者确认结构，不能当作任意类型直接操作。
	[key: string]: unknown;
}

/** Stored canonical OAuth credential. */
// extends 继承上述三字段及扩展字段，再加持久格式标签。
export interface OAuthCredential extends OAuthCredentials {
	// type="oauth" 让存储和解析器能与 api_key 分支区分。
	type: "oauth";
}

/** One type-tagged credential per provider — the shape of today's auth.json. */
// 联合类型表示每个供应商当前保存两类之一，不能凭联合声明自动校验磁盘JSON。
export type Credential = ApiKeyCredential | OAuthCredential;

/** Non-secret credential metadata for account/status enumeration. */
// 只包含枚举所需的非秘密身份字段，适合状态列表。
export interface CredentialInfo {
	// 供应商id，与存储键一致，不是模型id。
	providerId: string;
	// 索引访问类型复用 Credential 中允许的两个type值，避免另写一份不一致联合。
	type: Credential["type"];
}

/** Optional cancellation for public auth and credential operations. */
// 公共认证/凭证操作的可选取消选项。
export interface AuthOperationOptions {
	// 信号是否及时停止底层工作仍需要实现配合，类型不提供强制中止能力。
	signal?: AbortSignal;
}

/**
 * App-owned credential storage, keyed by `Provider.id`, one credential per
 * provider. `modify` is the only write path, so every mutation is a
 * serialized read-modify-write; `Models.getAuth()` runs OAuth refresh inside
 * `modify` so concurrent requests cannot double-refresh a rotated token. The
 * app persists a credential after login via
 * `modify(provider.id, async () => credential)`. Login/logout orchestration
 * is app-owned.
 *
 * Error semantics: `read` resolves `undefined` for missing entries. Methods
 * reject only on storage failure; `Models` wraps such rejections in
 * `ModelsError` with code "auth". Best-effort stores that serve an in-memory
 * view and record persistence errors internally (like coding-agent's
 * AuthStorage) are valid implementations.
 */
// 宿主实现的凭证存储契约，互斥/持久化/失败报告需要具体实现遵守，不由interface自动建立锁。
export interface CredentialStore {
	/**
	 * Read the stored credential, possibly expired. Display/status use;
	 * resolved request auth comes from `Models.getAuth()`.
	 */
	// 读原始可能过期的凭证，不做OAuth刷新；例：read("demo")正常缺省返回undefined，错误/取消可拒绝。
	read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined>;

	/**
	 * List stored credential metadata without resolving or exposing secrets.
	 * Implementations must not execute configured API-key commands while listing.
	 */
	// 列provider/type元数据，不应执行配置命令或返回秘密；readonly仅限制编译期数组修改。
	list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]>;

	/**
	 * Serialized write — the only write path. `fn` sees the current credential
	 * because correct writes (refresh, login-during-refresh) depend on it;
	 * return the new credential, or undefined to leave the entry unchanged.
	 * Mutual exclusion per provider id, cross-process too where the backing
	 * store supports it (e.g. a file lock). Resolves with the post-write
	 * credential. Rejections from `fn` propagate.
	 */
	// 互斥读改写方法，例：modify("demo",async current=>新凭证)；undefined表示保持原值，回调失败传播，跨进程锁取决于后端能力。
	modify(
		// 一次修改的供应商键，作用域不是某个具体模型。
		providerId: string,
		// 回调在互斥区读取最新条目，异步给出新值或undefined；本方法声明不自动拦截回调副作用。
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		// 取消可影响排队/等待，开始后行为由具体后端约定。
		options?: AuthOperationOptions,
		// 结果应为写后条目；Promise拒绝也可能来自回调或取消，并非只会有磁盘错误。
	): Promise<Credential | undefined>;

	/** Remove a credential (logout). Implementations serialize this against `modify`. */
	// 与modify串行的删除入口；例：delete("demo")表示注销存储条目，不直接取消已发送的模型请求。
	delete(providerId: string, options?: AuthOperationOptions): Promise<void>;
}

/** Environment access for auth resolution. Injectable for tests and browsers. */
// 可注入的宿主环境能力，便于Node、浏览器和测试替换来源。
export interface AuthContext {
	// 按名异步取环境值，缺失返回undefined；具体空串策略由实现规定，不查询远端key有效性。
	env(name: string): Promise<string | undefined>;
	/** Check whether a file exists. Supports a leading `~`. Always false in browsers. */
	// 按路径探测存在/可访问；默认上下文支持简单~替换，浏览器缺Node模块时false，自定义实现可有不同能力。
	fileExists(path: string): Promise<boolean>;
}

/** Result of resolving auth for a model. */
// 一次解析结果，得到它不等于供应商已经接受后续模型请求。
export interface AuthResult {
	// 本次模型请求认证材料。
	auth: ModelAuth;
	/** Provider-scoped environment/config values resolved from credentials and ambient context. */
	// 同时解析出的供应商环境配置，可能供SDK端点/工作负载身份等处理。
	env?: ProviderEnv;
	/** Human-readable label for status UI: "ANTHROPIC_API_KEY", "OAuth", "~/.aws/credentials". */
	// 给界面读的来源说明，如变量名或OAuth，不应把秘密本身当标签。
	source?: string;
}

// 轻量配置可用性信息；没有token材料，不等同已完成实际请求认证或现场验证。
export interface AuthCheck {
	// 可选来源标签。
	source?: string;
	// 标记当前可用配置属于API key还是OAuth。
	type: "api_key" | "oauth";
}

// 操作可选择的两种认证类别，不包含具体供应商名字。
export type AuthType = "api_key" | "oauth";

/**
 * Prompt shown to the user during login. `signal` lets the flow cancel a
 * pending prompt when an out-of-band event resolves the step, e.g. a
 * `manual_code` prompt raced against a callback server, aborted when the
 * callback wins.
 */
// 交叉类型 & 使每种提示都可带独立signal；括号中的联合用type区分各自字段。
export type AuthPrompt = {
	signal?: AbortSignal;
} & ( // 普通文字输入：message为提示，placeholder只作占位，返回用户输入文字。
	| { type: "text"; message: string; placeholder?: string }
	// 秘密输入提示；secret只是交互类别，实际隐藏/保存策略由宿主UI实现。
	| { type: "secret"; message: string; placeholder?: string }
	// 选择输入的options只读数组；每项id是回传值、label是展示文字，description可缺省，readonly不是运行时冻结。
	| { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
	// 手动贴授权码/回调URL；是否接受完整URL要看各flow自己的解析器。
	| { type: "manual_code"; message: string; placeholder?: string }
);

// 通知可附的链接数据，接口声明本身不验证协议或打开浏览器。
export interface AuthInfoLink {
	// 完整URL文字。
	url: string;
	// 可选展示名，不要求与URL相同。
	label?: string;
}

// 通知事件的可分辨联合；宿主按type选择如何展示，不在类型定义中执行交互。
export type AuthEvent =
	// 普通说明和可选链接列表，readonly仅为编译期数组约束。
	| { type: "info"; message: string; links?: readonly AuthInfoLink[] }
	// 授权URL通知，instructions可告诉用户浏览器/远程机器操作方式。
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			// 设备码事件标签，不是实际轮询请求。
			type: "device_code";
			// 给用户在浏览器输入的短码，区别于设备端持有的device_code。
			userCode: string;
			// 用户访问的验证URL，可由flow标准化；本字段类型string不执行安全检查。
			verificationUri: string;
			/** Offer best-effort browser opening on user confirmation. Defaults to true; clients may ignore it. */
			// 是否提供确认后尝试打开浏览器的选项，默认策略由客户端执行，可被忽略。
			openBrowserOnConfirm?: boolean;
			/** Offer copying of userCode on user confirmation, replacing the clipboard. Defaults to true. */
			// 是否提供确认后复制短码的选项，实际会替换剪贴板，通知本身不自动复制。
			copyCodeOnConfirm?: boolean;
			// 建议轮询间隔秒数，不是毫秒；真正计时由设备轮询helper负责。
			intervalSeconds?: number;
			// 设备授权有效期秒数，缺省时helper可能没有整体deadline。
			expiresInSeconds?: number;
	  }
	// 进度文字通知，无输入返回通道。
	| { type: "progress"; message: string };

/**
 * Login interaction callbacks serving both api-key and OAuth flows.
 *
 * `prompt()` returns the entered/selected string (`select` returns the option
 * id). Rejects on cancel/abort. `signal` aborts the whole login flow;
 * per-prompt cancellation uses `AuthPrompt.signal`.
 */
// 宿主实现的登录交互，Provider调用它来询问/通知；构造interface不弹窗。
export interface AuthInteraction {
	// 整个登录流程的可选外部信号，与单个prompt.signal区分。
	signal?: AbortSignal;

	// 异步等待文字/选择id，取消契约为拒绝；例：select选择id="browser"返回"browser"，不是整项对象。
	prompt(prompt: AuthPrompt): Promise<string>;
	// 同步通知，不返回用户答案；void签名也不表示实现抛错会被自动吞掉。
	notify(event: AuthEvent): void;
}

/** Normalized interaction passed to provider login implementations. */
// 交叉类型把原可选signal变为必需，Models在传给Provider前规范它；不是运行时自动填值。
export type ProviderAuthInteraction = AuthInteraction & { signal: AbortSignal };

/**
 * Api-key auth: stored key/provider env plus ambient sources (env vars, AWS
 * profiles, ADC files). Ambient-only providers omit `login`.
 */
// API key类认证，也包含环境profile/免key服务等环境来源；有无login决定是否提供交互设置入口。
export interface ApiKeyAuth {
	/** Display name, e.g. "Anthropic API key". */
	// 登录方式展示名。
	name: string;

	/** Interactive setup (prompt for key/provider env). Absent = ambient-only. */
	// 可选交互方法返回待存凭证，例：询问key后返回api_key对象；持久化由Models/宿主完成，不是此签名自动保存。
	login?(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential>;

	/**
	 * Optional side-effect-free availability check. Use this when `resolve()` may
	 * execute commands or perform other request-time work. Missing means Models
	 * checks availability by resolving auth.
	 */
	// 可选轻量配置检查；契约应避免请求时副作用，缺少时Models会回退resolve，不能据此保证所有枚举绝无I/O。
	check?(input: {
		// 检查使用的宿主环境/文件能力。
		ctx: AuthContext;
		// 可选已存API key凭证，不能把OAuth条目混进该方法。
		credential?: ApiKeyCredential;
		// 已规范为具体信号，检查实现需合作响应。
		signal: AbortSignal;
		// 异步返回配置元数据或undefined，不暴露请求key；实现异常仍可拒绝。
	}): Promise<AuthCheck | undefined>;

	/**
	 * Resolve auth from the stored credential and/or ambient sources, merging
	 * per field (`credential.key ?? env("...")`, `credential.env?.NAME ?? env("...")`).
	 * undefined = not configured. Resolution is provider-scoped; model-specific
	 * endpoint preparation happens after auth has been resolved.
	 */
	// 实际请求认证解析方法，可逐字段合并存储和环境；例：credential.env缺账户id时向ctx.env查，不是强制所有字段整份替换。
	resolve(input: {
		// 可注入的环境来源。
		ctx: AuthContext;
		// 可选原凭证或请求级临时凭证。
		credential?: ApiKeyCredential;
		// 本次解析取消信号。
		signal: AbortSignal;
		// 异步返回AuthResult/未配置；方法可能执行配置命令等请求时工作，类型本身不验证远端认证。
	}): Promise<AuthResult | undefined>;
}

/** App-supplied context for `Models.login`. */
// 宿主额外登录身份配置，只有需要它的flow才读取。
export interface LoginOptions {
	/**
	 * Returns the stable ID of this app installation, e.g. sent to OpenAI as its
	 * agent host ID. Called only by login flows that need it, so apps can create
	 * the ID on first use and must return the same ID on every later call.
	 */
	// 可选同步回调按需提供安装稳定id；应用负责后续调用返回相同值，类型不自动持久化它。
	getDeviceId?: () => string;
	/**
	 * Name this app introduces itself with during login, e.g. OpenAI's agent name hint and
	 * Codex originator. Defaults to pi's own name.
	 */
	// 应用自报名称，如Pi或自定义宿主名，不是用户账户名。
	agentName?: string;
}

/**
 * OAuth auth. The `refresh`/`toAuth` split lets `Models` own the locked
 * refresh pattern: `refresh` produces a credential, `toAuth` derives request
 * auth from whatever credential ends up stored.
 */
// OAuth能力拆成登录/刷新/转换，Models负责调度与存储互斥，flow只产出凭证或请求材料。
export interface OAuthAuth {
	/** Display name, e.g. "Anthropic (Claude Pro/Max)". */
	// 认证方式的展示名字。
	name: string;

	/** Whether access through this auth method is backed by a provider subscription. */
	// 是否按提供商订阅模式使用的元数据，不现场确认账号套餐有效性。
	isSubscription?: boolean;

	/** Selector label for the OAuth login option, e.g. "Sign in with SuperGrok or X Premium". */
	// 登录选择器专用文字，可与name不同。
	loginLabel?: string;

	// 交互登录返回新OAuth凭证，输入必需信号和可选安装身份；例：浏览器确认后换token，但此方法不替宿主持久保存。
	login(interaction: ProviderAuthInteraction, options?: LoginOptions): Promise<OAuthCredential>;

	/**
	 * Exchange the refresh token. Network call; throws on failure
	 * (invalid_grant etc.). `Models` runs this under the store lock.
	 */
	// 输入当前OAuth凭证与刷新信号，返回新凭证，失败拒绝；通常兑换网络token，OpenRouter等可按自身语义原样返回。
	refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;

	/**
	 * Side-effect-free derivation of request auth from a valid credential.
	 * Covers per-credential baseUrl (GitHub Copilot). Async so lazy wrappers
	 * can load the implementation on first use.
	 */
	// 从最终凭证派生key/headers/baseUrl，例：Copilot派生账户端点；常规实现无网络兑换，lazy外观仍可能首次加载模块。
	toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}

/**
 * Provider auth. At least one of `apiKey`/`oauth` must be present: even
 * ambient-credential providers and keyless local servers provide `apiKey`
 * auth whose `resolve()` reports whether the provider is configured.
 */
// Provider必须按契约提供至少一种方法；两字段都可选的接口本身没有用联合强制此条件，createProvider会另作运行时检查。
export interface ProviderAuth {
	// API key/环境类认证能力，可与OAuth同时存在。
	apiKey?: ApiKeyAuth;
	// OAuth能力，可缺省；已存OAuth条目遇缺handler不会自动换环境认证。
	oauth?: OAuthAuth;
}
