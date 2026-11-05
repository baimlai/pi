// 把OAuth流程所需的客户端、令牌、PKCE校验串和发现结果存入可替换store。flow.ts调用这些方法，宿主可注入文件存储；默认只有内存，不联网、不判断令牌是否过期或自行打开浏览器。
// 这里只串行化本实例的update，既不是跨实例/进程锁，也不是存储事务；类型声明不会自动验证持久化数据。
import type { OAuthClientMetadataDocument, OAuthClientProvider } from "./flow.ts";
// 这些全是类型导入，运行时不加载flow来执行授权；声明OAuth文档/令牌/发现状态的TS形状。
import type {
	// 授权服务器元数据类型用于可选客户端文档选择回调。
	AuthorizationServerMetadata,
	// 客户端信息允许精简身份或完整注册元信息。
	OAuthClientInformationMixed,
	// 提交注册的客户端元信息，与客户端secret/用户token是不同数据。
	OAuthClientMetadata,
	// 缓存发现的服务器和资源文档。
	OAuthDiscoveryState,
	// 访问/刷新令牌的数据类型，不代表已验证有效性。
	OAuthTokens,
} from "./types.ts";

// 一台确切MCP服务器的状态包；除serverUrl外字段均可缺省，?是TS可选属性，不是运行时补值。
export interface McpOAuthState {
	// 存储状态所属地址文字，own会与本实例规范化后的完整URL作严格相等比较。
	serverUrl: string;
	// 动态注册得到的客户端资料；配置clientId另存于实例，优先于这个字段。
	clientInformation?: OAuthClientInformationMixed;
	// 令牌集合，读取它不会自动刷新或过滤过期token。
	tokens?: OAuthTokens;
	/** When the access token expires, in milliseconds since the epoch, from `expires_in` at the time it was saved. */
	// 保存令牌时按expires_in秒数计算的毫秒时间戳；本类只记录，宿主可据此安排预刷新。
	tokensExpireAt?: number;
	// 授权码交换时使用的PKCE原始随机串，不是发送给授权端点的哈希挑战。
	codeVerifier?: string;
	// 关联授权请求/回调的随机state，是否核对由宿主回调处理负责。
	oauthState?: string;
	// 可选发现缓存，不含自动失效时间。
	discovery?: OAuthDiscoveryState;
}

// 可注入同步或异步存储的接口；接口本身不保证加密、原子性、克隆或互斥。
export interface McpOAuthStateStore {
	// 无参数读出状态或undefined，可直接返回也可返回Promise；读失败可抛错/拒绝。
	load(): McpOAuthState | undefined | Promise<McpOAuthState | undefined>;
	// 输入完整状态并保存，void表示不返回业务值；具体落盘/持久性由实现承担。
	save(state: McpOAuthState): void | Promise<void>;
}

// 构造提供者的选项，包含地址、注册资料、配置身份、存储与重定向回调。
export interface McpOAuthProviderOptions {
	// MCP服务器地址，会通过new URL规范后作为状态隔离标记。
	serverUrl: string | URL;
	// 授权回调地址，字符串或URL；构造时String处理，不在此检查它是否允许注册/监听。
	redirectUrl: string | URL;
	// Omit先从元信息类型移除必需redirect_uris，再用&重新加成可选字段，允许构造器补默认列表；不改变运行时对象。
	clientMetadata: Omit<OAuthClientMetadata, "redirect_uris"> & { redirect_uris?: string[] };
	/** See `OAuthClientProvider.clientMetadataDocument`. */
	// 可选的同步文档选择函数；只有flow无客户端信息时才调用，不是构造时下载文档。
	clientMetadataDocument?: (
		// 输入已发现的元数据或undefined，供宿主检查文档能力。
		metadata: AuthorizationServerMetadata | undefined,
		// 返回客户端ID文档地址/回调，或undefined让流程考虑动态注册。
	) => OAuthClientMetadataDocument | undefined;
	// 可选预配置clientId，真值时优先使用，空字符串按未配置处理。
	clientId?: string;
	// 可选预配置secret，只有clientId真值时才形成configuredClient；空串不会加入该对象。
	clientSecret?: string;
	// 缺省用MemoryOAuthStateStore，不自动持久化到磁盘。
	store?: McpOAuthStateStore;
	// 宿主收到授权URL后做什么由此回调决定，既可只记录URL，也可自行开浏览器；抛错或Promise拒绝会传回授权流。
	onRedirect(url: URL): void | Promise<void>;
}

// 最简内存存储；implements只让TS检查方法契约，不创建文件或加锁。每次读写都structuredClone，隔开调用方和内部可克隆数据的引用。
export class MemoryOAuthStateStore implements McpOAuthStateStore {
	// TS private限制外部直接访问，不是#私有字段；初始值undefined表示还没保存。
	private value: McpOAuthState | undefined;

	// 无参数读取内存快照，返回undefined或深克隆状态；例：改load()结果的tokens不会改内部值。不可克隆值可使structuredClone抛错，不读取磁盘。
	load(): McpOAuthState | undefined {
		// 严格判断undefined，已有状态才克隆；不是JSON.stringify，保留规则依宿主structuredClone。
		return this.value === undefined ? undefined : structuredClone(this.value);
	}

	// 输入状态保存其克隆，无业务返回；例：save(state)后再改state不会影响存储。克隆失败在赋值前抛错，旧内部值仍保留。
	save(state: McpOAuthState): void {
		// 右侧克隆先完成再替换value，不把原对象引用存进去。
		this.value = structuredClone(state);
	}
}

/** Default stateful provider for one exact MCP server URL. Applications inject durable storage if needed. */
// OAuthClientProvider的默认有状态实现；同实例方法可被flow等待，但只靠这个类无法隔离共享store的其他实例或并发state()调用。
export class McpOAuthProvider implements OAuthClientProvider {
	// 公开只读回调字符串，readonly只限制TS重新赋值，不是运行时冻结。
	readonly redirectUrl: string;
	// 公开只读元信息引用；其数组等内部对象仍可变，构造时仅浅展开。
	readonly clientMetadata: OAuthClientMetadata;
	// 可选文档选择函数，按引用保存；readonly不限制该函数内部副作用。
	readonly clientMetadataDocument?: (
		// 参数可缺少发现文档，不在这里合成文档支持标记。
		metadata: AuthorizationServerMetadata | undefined,
		// 同步返回文档选择结果，或undefined。
	) => OAuthClientMetadataDocument | undefined;
	// 内部规范化MCP服务器URL，包含路径/查询/片段等，非仅origin。
	private serverUrl: string;
	// 预配置客户端身份；失效存储时不会删除这个实例字段。
	private configuredClient: OAuthClientInformationMixed | undefined;
	// 存储接口引用，可能是宿主持久存储，也可能是默认内存。
	private store: McpOAuthStateStore;
	// 输入URL、返回void或Promise的宿主回调；类内不直接调用平台URL处理器。
	private onRedirect: (url: URL) => void | Promise<void>;
	// 以已兑现Promise作为更新队列尾巴。后面只接then成功分支，某次写失败会让后续load/update继续拒绝，没有自动恢复。
	private writes: Promise<void> = Promise.resolve();

	// 输入选项构建实例，补注册默认值并选择存储，返回实例；不读store/联网。例：仅给client_name时自动补当前redirect和code/refresh grant列表；坏serverUrl会在构造时抛错。
	constructor(options: McpOAuthProviderOptions) {
		// new URL解析规范化再String序列化，非法地址抛TypeError；不会只截origin或去hash。
		this.serverUrl = String(new URL(options.serverUrl));
		// 回调只转文字，和serverUrl的规范化处理不同；不new URL校验字符串。
		this.redirectUrl = String(options.redirectUrl);
		// 创建新顶层元信息对象，后写的默认字段覆盖展开中的同名值。
		this.clientMetadata = {
			// 浅复制调用者自有可枚举字段，嵌套数组仍可共享。
			...options.clientMetadata,
			// ??只对null/undefined补列表，显式[]不会被替换。
			redirect_uris: options.clientMetadata.redirect_uris ?? [this.redirectUrl],
			// 未配grant_types才补authorization_code/refresh_token；空列表也保留，不检查服务器实际支持。
			grant_types: options.clientMetadata.grant_types ?? ["authorization_code", "refresh_token"],
			// 未配response_types才补code，不是执行授权或验证响应。
			response_types: options.clientMetadata.response_types ?? ["code"],
			// 令牌端点认证方式按下一行优先级决定。
			token_endpoint_auth_method:
				// 显式方法优先；否则secret真值选post，无secret选none。这是注册元信息默认值，配置身份对象本身没有复制这个提示字段。
				options.clientMetadata.token_endpoint_auth_method ?? (options.clientSecret ? "client_secret_post" : "none"),
		};
		// 只保存选择函数，不在构造器中执行。
		this.clientMetadataDocument = options.clientMetadataDocument;
		// 用clientId真值决定是否形成配置身份，和??仅判空不同。
		this.configuredClient = options.clientId
			? // 有ID时构造新对象，条件展开只在secret真值时加入密钥。
				{ client_id: options.clientId, ...(options.clientSecret ? { client_secret: options.clientSecret } : {}) }
			: // 无真值ID则undefined，后续可读取动态注册信息。
				undefined;
		// 有store引用则使用它，否则每实例创建自己的内存存储。
		this.store = options.store ?? new MemoryOAuthStateStore();
		// 保存宿主回调，稍后redirectToAuthorization才调用。
		this.onRedirect = options.onRedirect;
	}

	// 获取当前授权state，无参数返回字符串Promise；已有真值就复用，否则把32随机字节编码为64个十六进制字符并入队保存。例：同次串行登录重复调用得到同一state；本方法不验证回调，两个并发首次调用仍可能生成不同state。
	async state(): Promise<string> {
		// load先等待当前写队列，再读取属于本服务器的状态。
		const existing = (await this.load()).oauthState;
		// 真值旧state直接返回；空串视作缺失。
		if (existing) return existing;
		// Uint8Array(32)分配32字节，WebCrypto原地填随机数，Buffer再编码hex；这里的64字符不是64字节随机熵。
		const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
		// 箭头函数返回新顶层对象，覆盖oauthState，await保证本次保存完成；生成与前面的读取并非一个原子事务。
		await this.update((value) => ({ ...value, oauthState: state }));
		// 返回此次生成值，不重新读最终存储来处理并发覆盖。
		return state;
	}

	// 读取客户端信息，无参数返回可选信息Promise；例：配置clientId会盖过旧动态注册记录，并且短路不读store。存储失败在需要读取时传播。
	async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
		// ??优先配置身份，只有其undefined才await load，返回存储对象字段，不在这里重新解析/克隆。
		return this.configuredClient ?? (await this.load()).clientInformation;
	}

	// 保存动态客户端信息，输入身份对象返回void Promise；配置ID时忽略该保存。例：动态注册client-1后可由clientInformation读回；store失败会拒绝。
	async saveClientInformation(information: OAuthClientInformationMixed): Promise<void> {
		// 配置身份不可被这个方法替换，不因此删除磁盘已有动态记录。
		if (this.configuredClient) return;
		// 排队把新信息并入状态，保留其他字段；是否深克隆由store实现决定。
		await this.update((value) => ({ ...value, clientInformation: information }));
	}

	// 读取现有令牌，无参数返回集合或undefined的Promise；例：即使tokensExpireAt已过去也照样返回，由宿主决定刷新。store失败可拒绝。
	async tokens(): Promise<OAuthTokens | undefined> {
		// 等待load后取tokens，不作时间/JWT/权限检查；自定义store可能返回共享对象。
		return (await this.load()).tokens;
	}

	// 输入令牌并保存，同时更新或删除过期时间，返回void Promise；例：expires_in:60按本次调用时间加60000ms。没有正数/有限性检查、自动刷新或回滚，保存失败拒绝。
	async saveTokens(tokens: OAuthTokens): Promise<void> {
		// expires_in仅严格undefined才省略，其他number原样算秒转毫秒；时间在入队之前采集，不是实际落盘时刻。
		const expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
		// 把修改放入本实例串行队列，回调拿执行当时重新加载的状态。
		await this.update((value) => {
			// 浅复制状态并替换tokens，TS注解要求next形状满足McpOAuthState，不验证token内容。
			const next: McpOAuthState = { ...value, tokens };
			// 没有过期秒数就delete旧时间属性，避免上一令牌时间残留。
			if (expiresAt === undefined) delete next.tokensExpireAt;
			// 否则写计算出的时间，可为过去/非有限数（若直接传入这样的number）。
			else next.tokensExpireAt = expiresAt;
			// 返回新状态给update保存，不在回调里自行落盘。
			return next;
		});
	}

	// 把授权URL交给宿主回调，无业务返回；例：onRedirect只赋变量时不会打开浏览器。await等待其完成，抛错/拒绝向flow传播，不自动重试。
	async redirectToAuthorization(url: URL): Promise<void> {
		// 通过实例保存的函数引用调用，回调自身可做UI/浏览器等副作用；类只负责转交。
		await this.onRedirect(url);
	}

	// 输入PKCE verifier并排队保存，返回void Promise；例：先保存v，换码时codeVerifier可取回。没有校验长度/字符集或加密，store错误传播。
	async saveCodeVerifier(verifier: string): Promise<void> {
		// 浅复制状态，覆盖codeVerifier，await等待保存。
		await this.update((value) => ({ ...value, codeVerifier: verifier }));
	}

	// 读PKCE verifier，无参数返回非空真值字符串或拒绝；例：缺值/空串抛固定Error。读取后不删除，所以不是一次性消费保证。
	async codeVerifier(): Promise<string> {
		// 等待状态队列/存储后取原字段。
		const verifier = (await this.load()).codeVerifier;
		// 真值检查拒绝undefined及空串，不检查协议要求的长度或格式。
		if (!verifier) throw new Error("No OAuth PKCE code verifier is stored");
		// 返回原字符串，后续flow把它放进令牌请求表单。
		return verifier;
	}

	// 按kind删除本地状态字段并保存，返回void Promise；例：tokens仅删除tokens和tokensExpireAt，all再清客户端/verifier/discovery/state。不调用远端撤销，不删除配置clientId/secret，失败不自动恢复队列。
	async invalidateCredentials(kind: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		// 清理也走同一个update队列，避免本实例的并行写互相用旧快照覆盖。
		await this.update((value) => {
			// 仅复制顶层，后续delete不修改旧顶层对象，嵌套对象仍共享。
			const next = { ...value };
			// all/client删除存储的动态客户端，configuredClient仍保留并优先生效。
			if (kind === "all" || kind === "client") delete next.clientInformation;
			// all或tokens共同处理令牌及其到期时间。
			if (kind === "all" || kind === "tokens") {
				// delete移除属性，不是写undefined，也没有远端注销。
				delete next.tokens;
				// 同时删除旧令牌对应的时间戳。
				delete next.tokensExpireAt;
			}
			// all/verifier删除PKCE校验串，不删除oauthState，除非kind为all。
			if (kind === "all" || kind === "verifier") delete next.codeVerifier;
			// all/discovery删除发现缓存，不强制立即重新请求。
			if (kind === "all" || kind === "discovery") delete next.discovery;
			// 只有all删除state，下次state调用才生成新值。
			if (kind === "all") delete next.oauthState;
			// 返回清理后的新对象统一保存。
			return next;
		});
	}

	// 输入发现状态并保存，返回void Promise；例：缓存issuer和文档供下次flow复用。这里不验证URL/issuer，也不加TTL；存储失败传播。
	async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
		// 更新discovery字段，保留其他状态；是否克隆嵌套值依赖store。
		await this.update((value) => ({ ...value, discovery }));
	}

	// 无参数返回可选发现缓存Promise；例：有授权服务器URL但无元数据时flow只补发现该服务器文档。不检查缓存新鲜度，读失败拒绝。
	async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
		// 复用load的排队等待和地址筛选，再返回discovery字段。
		return (await this.load()).discovery;
	}

	// 内部读取流程：先等当前writes，再load并按服务器筛选，返回状态Promise；例：空store返回仅serverUrl的新对象。队列或store失败原样拒绝，不保证等待所有未来才加入的写。
	private async load(): Promise<McpOAuthState> {
		// await的是执行到此刻的队尾Promise；不建立跨对象读写锁。
		await this.writes;
		// 读取后交own决定接受/忽略，不解析字段schema；own不保存新空对象。
		return this.own(await this.store.load());
	}

	// 内部更新，输入同步state→state函数，排在队尾读取最新状态、变换再保存，返回void Promise；例：两次同实例update会依次执行。回调/读/写错误会让writes拒绝，之后没有catch恢复；无跨实例事务。
	private async update(update: (state: McpOAuthState) => McpOAuthState): Promise<void> {
		// then只在旧队尾成功时执行新回调，并立即把新Promise设为队尾；不是finally队列。
		this.writes = this.writes.then(async () => {
			// 按store.load→own→update回调→store.save顺序，await异步保存；自定义store是否原子/克隆由其实现决定，不调用会等待队尾的this.load。
			await this.store.save(update(this.own(await this.store.load())));
		});
		// 让调用者等待已安排的这次更新，拒绝不被吞掉。
		await this.writes;
	}

	/** Stored state for another server URL is ignored so credentials never leak across servers. */
	// 内部按完整地址严格筛状态，输入可选状态，返回原状态引用或新空状态；例：one.example保存的token不会交给two.example。只看serverUrl字段，不运行token/schema检查，也不提供store访问控制。
	private own(state: McpOAuthState | undefined): McpOAuthState {
		// ===比较存储原字符串和构造器规范化字符串；相等直接复用引用，否则仅保留本实例serverUrl，不修改/删除原存储。
		return state?.serverUrl === this.serverUrl ? state : { serverUrl: this.serverUrl };
	}
}
