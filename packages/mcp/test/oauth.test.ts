// 检验MCP OAuth发现/注册/PKCE/刷新/增权及回调页面。多数it会启动127.0.0.1真实HTTP监听并用fetch请求本机，地址/令牌均是测试数据，不调用模型或外部授权服务；唯独凭据地址隔离一例只用内存。
// createHash在本机计算SHA-256来核对PKCE，不是发网络请求；导入/注册测试本身不执行各it内的listen。
import { createHash } from "node:crypto";
// afterEach是逐例清理hook，describe分组、it登记测试、expect断言；async用例通过返回Promise让框架等待，拒绝/断言失败会令该例失败。
import { afterEach, describe, expect, it } from "vitest";
// 使用实际McpClient与HTTP传输，未把协议层替换成假客户端；具体服务端由下方本机路由模拟。
import { McpClient, StreamableHttpTransport } from "../src/index.ts";
// 从OAuth公共子入口混合导入类型和运行时函数/类，逐项type在JS执行时擦除。
import {
	// 提供者到HTTP认证接口的适配器，同一返回对象共享恢复Promise。
	adaptOAuthProvider,
	// 单步骤授权入口：有code换码，否则刷新或准备重定向。
	authorizeMcp,
	// 发现授权服务器文档并按默认规则核对issuer。
	discoverAuthorizationServerMetadata,
	// 报告需要用户交互的异常，测试据此取已生成URL继续流程，不自动开浏览器。
	McpOAuthAuthorizationRequiredError,
	// 默认状态提供者，负责与store交换数据，本身不监听回调。
	McpOAuthProvider,
	// 读写structuredClone的内存store，不落真实凭据文件。
	MemoryOAuthStateStore,
	// 页面成功/失败标签联合，供记录renderPage参数。
	type OAuthCallbackPage,
	// 需要显式listen才能绑定回调端口的服务类。
	OAuthCallbackServer,
	// 精简或完整客户端身份信息联合。
	type OAuthClientInformationMixed,
	// 测试假提供者要实现的状态/交互方法接口。
	type OAuthClientProvider,
	// 可缓存的发现状态类型，不自带过期/信任检查。
	type OAuthDiscoveryState,
	// 凭据端点HTTPS或loopback策略拒绝的本地异常。
	OAuthInsecureEndpointError,
	// 发行方或回调iss不符的本地异常。
	OAuthIssuerMismatchError,
	// 令牌字段类型，不是实际OAuth签名/权限验证器。
	type OAuthTokens,
	// 动态注册函数，返回客户端信息，保存由provider接口负责。
	registerClient,
	// 只构造授权URL与PKCE配对，不调用平台URL处理器。
	startAuthorization,
} from "../src/oauth/index.ts";
// listen开真实loopback测试服务，readBody读完整请求，closeServers清本helper登记的服务；OAuthCallbackServer单独创建的服务仍需自己close。
import { closeServers, listen, readBody } from "./helpers.ts";

// 同步内存假提供者，方便用例直接设置/观察字段；implements仅TS检查，不提供默认provider的克隆、写队列、过期时间或精确地址隔离。
class TestOAuthProvider implements OAuthClientProvider {
	// 回调字符串只读引用，供注册与换码一致使用，不在构造时绑定端口。
	readonly redirectUrl: string;
	// 这里省略显式类型，由构造器赋值推导元信息对象形状；readonly不冻结其数组字段。
	readonly clientMetadata;
	// 测试可直接设置动态客户端身份，初始undefined。
	client: OAuthClientInformationMixed | undefined;
	// 测试令牌集合原引用，不在getter中过滤过期值。
	tokenSet: OAuthTokens | undefined;
	// 原始PKCE verifier，可先空，换码时读取。
	verifier: string | undefined;
	// 可缓存发现结果，便于只测换码/刷新而跳部分发现请求。
	discovery: OAuthDiscoveryState | undefined;
	// 最近交给宿主的授权URL，用例会手动fetch它；记录URL不等于开浏览器。
	authorizationUrl: URL | undefined;

	// 输入回调地址构建假提供者并补固定注册资料，无网络/存储副作用；例：new TestOAuthProvider(callback.redirectUrl)把已监听地址交授权流，不再新开监听。
	constructor(redirectUrl: string) {
		// 保存原回调字符串，不new URL归一化。
		this.redirectUrl = redirectUrl;
		// 创建元信息对象给注册/默认scope查询，和用户token分开。
		this.clientMetadata = {
			// 只声明这一条回调，稍后注册请求携带它。
			redirect_uris: [redirectUrl],
			// 固定客户端显示名，供模拟服务器返回。
			client_name: "pi-mcp-test",
			// 声明授权码和刷新grant，数组只是能力/注册元数据。
			grant_types: ["authorization_code", "refresh_token"],
			// 只请求code响应类型。
			response_types: ["code"],
			// 公开客户端不发secret，内建认证会在表单加client_id。
			token_endpoint_auth_method: "none",
		};
	}

	// 无参数返回固定state字符串，无随机/存储副作用；例：用例waitForCallback("expected-state")与授权URL配对。仅为可复现测试，不是默认provider随机state策略。
	state(): string {
		// 每次都同一值，不轮换或校验回调state。
		return "expected-state";
	}

	// 无参数返回当前client原引用或undefined；例：用例先设{client_id:"client"}就可跳动态注册。同步读，不作结构验证或复制。
	clientInformation(): OAuthClientInformationMixed | undefined {
		// 直接暴露内存字段，调用方可观察/改其中数据。
		return this.client;
	}

	// 输入客户端信息保存到字段，无返回/网络；例：flow注册成功会调用它。只替换引用，无克隆/持久化/队列。
	saveClientInformation(information: OAuthClientInformationMixed): void {
		// 原对象赋给client，不合并旧字段。
		this.client = information;
	}

	// 无参数读当前令牌或undefined，无网络；例：适配器token从此取access_token。不会自动刷新或检查JWT。
	tokens(): OAuthTokens | undefined {
		// 返回原集合引用，不复制。
		return this.tokenSet;
	}

	// 输入新令牌替换tokenSet，无返回；例：刷新后用例读此字段断言结果。没有expiresAt计算或落盘。
	saveTokens(tokens: OAuthTokens): void {
		// 保存原对象，旧集合整体被替换。
		this.tokenSet = tokens;
	}

	// 接收授权URL只记录字段，无返回/浏览器动作；例：流程REDIRECT后用例从authorizationUrl手动fetch。
	redirectToAuthorization(url: URL): void {
		// 保存可变URL原引用，不复制或验证方案。
		this.authorizationUrl = url;
	}

	// 输入PKCE原字符串保存，无返回；例：后续codeVerifier取回给换码。无格式检查或加密存储。
	saveCodeVerifier(verifier: string): void {
		// 替换内存verifier，未清其他字段。
		this.verifier = verifier;
	}

	// 无参数取真值verifier，返回字符串或同步抛错；例：授权流尚未调用saveCodeVerifier时抛Missing code verifier，不发请求。startAuthorization只生成配对，保存由上层runFlow执行。
	codeVerifier(): string {
		// 空串/undefined都拒绝，不检查长度或字符集。
		if (!this.verifier) throw new Error("Missing code verifier");
		// 原样返回，不删除，所以不保证一次性消费。
		return this.verifier;
	}

	// 按字符串联合kind清对应本地字段，无返回/远端撤销；例：invalid_grant后tokens被置undefined，client仍保留。与默认provider不同，这个假实现没有oauthState/tokensExpireAt可清。
	invalidateCredentials(kind: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		// all/client清身份引用，用赋undefined而不是delete字段。
		if (kind === "all" || kind === "client") this.client = undefined;
		// all/tokens清令牌，不触真实磁盘。
		if (kind === "all" || kind === "tokens") this.tokenSet = undefined;
		// all/verifier清PKCE校验串。
		if (kind === "all" || kind === "verifier") this.verifier = undefined;
		// all/discovery清发现缓存，下轮flow可重新发现。
		if (kind === "all" || kind === "discovery") this.discovery = undefined;
	}

	// 输入发现状态保存原引用，无返回/网络；例：首次发现后可供第二阶段沿用，不验证issuer或缓存年龄。
	saveDiscoveryState(state: OAuthDiscoveryState): void {
		// 整体替换发现字段，不克隆嵌套文档。
		this.discovery = state;
	}

	// 无参数返回可选发现缓存，供flow判断是否补发现；没有TTL检查/副作用。
	discoveryState(): OAuthDiscoveryState | undefined {
		// 直接返回原字段。
		return this.discovery;
	}
}

// 每个执行用例后清helper.listen登记的HTTP服务；hook只注册函数，此刻不监听。回调服务不是该数组的一员，仍由各例显式close；空数组清理只Promise.all([])。
afterEach(closeServers);

// 分组OAuth流程与提供者的10个用例，其中只有凭据URL隔离一例完全不监听/联网。
describe("MCP OAuth", () => {
	// 本机端到端路径：挑战→发现/注册→PKCE重定向→回调换码→带token握手/listTools→人为改成被拒绝访问token再触发刷新。断言scope/resource/刷新次数和沿用refresh token；真实loopback HTTP但无浏览器/外部授权。正常末尾关闭客户端/回调，helper服务由hook关，断言中途失败不都有独立finally。
	it("discovers, registers, authorizes with PKCE, and refreshes on 401", async () => {
		// 保存授权页收到的PKCE challenge，待/token由verifier重新算后比较。
		let expectedChallenge: string | undefined;
		// 刷新端点命中次数，不统计发现/注册等请求。
		let refreshes = 0;
		// 启动本机模拟授权与MCP服务，async handler按URL路径分派，不是真实第三方OAuth。
		const origin = await listen(async (request, response, serverOrigin) => {
			// 用实际serverOrigin解析相对request.url，缺URL时/；URL.pathname用于路由。
			const url = new URL(request.url ?? "/", serverOrigin);
			// 路径专门匹配带/mcp后缀的受保护资源well-known。
			if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
				// 声明返回JSON，默认成功状态200。
				response.setHeader("content-type", "application/json");
				// end发送下方序列化正文，不意味着客户端已处理完发现。
				response.end(
					// 构造资源元数据，不直接返回token。
					JSON.stringify({
						// resource绑定本机/mcp，与后续访问目标同origin/path。
						resource: `${serverOrigin}/mcp`,
						// 该资源指定同一个本机origin作为授权服务器。
						authorization_servers: [serverOrigin],
						// 资源建议scope为org:read，供挑战空scope时回退。
						scopes_supported: ["org:read"],
					}),
				);
				// 已回应当前路由就return，防止继续其他路径。
				return;
			}
			// 授权服务器根well-known路径，和受保护资源文档不同。
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				// 成功响应JSON类型。
				response.setHeader("content-type", "application/json");
				// 输出一份授权元数据正文。
				response.end(
					// 把元信息对象变JSON文字，非手工拼协议解析器。
					JSON.stringify({
						// 发行方是本机origin，符合本次默认发现的预期。
						issuer: serverOrigin,
						// 用户授权URL走本服务/authorize。
						authorization_endpoint: `${serverOrigin}/authorize`,
						// 换码/刷新走本服务/token。
						token_endpoint: `${serverOrigin}/token`,
						// 动态客户端注册走本服务/register。
						registration_endpoint: `${serverOrigin}/register`,
						// 声明支持code，startAuthorization会检查此列表。
						response_types_supported: ["code"],
						// 声明支持授权码和刷新；flow并未全面校验所有grant能力组合。
						grant_types_supported: ["authorization_code", "refresh_token"],
						// 声明none客户端认证，不需要测试secret。
						token_endpoint_auth_methods_supported: ["none"],
						// 声明PKCE S256，后面实际验证verifier哈希。
						code_challenge_methods_supported: ["S256"],
					}),
				);
				// 授权文档发送完即结束本次请求处理。
				return;
			}
			// 注册路径只模拟返回身份，不实现完整注册策略。
			if (url.pathname === "/register") {
				// 完整读请求再JSON.parse，as Record只改变TS视图，未知字段未做schema校验；JSON错误交helper的Promise catch。
				const metadata = JSON.parse(await readBody(request)) as Record<string, unknown>;
				// 注册成功HTTP201并声明JSON。
				response.writeHead(201, { "content-type": "application/json" });
				// Empty and null optional fields count as absent (#10266).
				// 浅保留提交元信息，赋test-client和显式空secret，测试解析器把可选空字段视为缺省。
				response.end(JSON.stringify({ ...metadata, client_id: "test-client", client_secret: "" }));
				// 注册响应完return，不继续授权路由。
				return;
			}
			// 本机授权路径模拟用户批准，不显示真实登录页面。
			if (url.pathname === "/authorize") {
				// 保存授权URL的challenge，缺参得undefined；值用于稍后/hash比较而非原verifier。
				expectedChallenge = url.searchParams.get("code_challenge") ?? undefined;
				// 解析查询redirect_uri为URL，缺省用空串会让new URL抛错；本测试正常由flow提供有效本机回调。
				const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
				// 在回调地址上加固定测试授权码，不调用真实授权系统。
				redirect.searchParams.set("code", "test-code");
				// 复制请求state到回调，缺省空串；真正state匹配由callback服务做。
				redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
				// 回302 Location到带码回调，end无正文；fetch的manual选项稍后会阻止自动跟随。
				response.writeHead(302, { location: redirect.href }).end();
				// 授权重定向写完就return。
				return;
			}
			// 同一个/token按grant_type区分刷新和换码。
			if (url.pathname === "/token") {
				// 完整读表单，用URLSearchParams解码，不按JSON解析。
				const params = new URLSearchParams(await readBody(request));
				// 精确refresh_token grant进入刷新分支，其他值都按本测试换码路径处理。
				if (params.get("grant_type") === "refresh_token") {
					// 累加刷新请求计数。
					refreshes++;
					// 刷新结果JSON响应。
					response.setHeader("content-type", "application/json");
					// 发送下方固定令牌对象。
					response.end(
						// 序列化结果，没有签名或JWT生成。
						JSON.stringify({
							// 新访问token固定refreshed-token，仅测试标记。
							access_token: "refreshed-token",
							// 类型字段Bearer，后续HTTP认证头实际使用Bearer。
							token_type: "Bearer",
							// 显式空refresh_token应被解析省掉，让refreshAuthorization沿用旧值。
							refresh_token: "",
							// null expires_in应视为缺省，不经Number(null)变0。
							expires_in: null,
						}),
					);
					// 刷新已应答，跳过后面授权码验证。
					return;
				}
				// 对授权码请求重新计算SHA-256，使用与PKCE算法相同的哈希名。
				const challenge = createHash("sha256")
					// 哈希输入是表单原verifier文字，缺参回退空串，不是直接哈希challenge。
					.update(params.get("code_verifier") ?? "")
					// 输出base64url与/authorize保存的challenge按文字比。
					.digest("base64url");
				// 授权码不是test-code或哈希不相等则模拟invalid_grant。
				if (params.get("code") !== "test-code" || challenge !== expectedChallenge) {
					// 失败HTTP400及JSON头。
					response.writeHead(400, { "content-type": "application/json" });
					// 返回OAuth error字段，让真实tokenRequest识别为OAuthError。
					response.end(JSON.stringify({ error: "invalid_grant" }));
					// 失败后return，不再发成功token。
					return;
				}
				// 正常换码成功的JSON头。
				response.setHeader("content-type", "application/json");
				// 发送下方固定初始令牌。
				response.end(
					// 将成功结果序列化。
					JSON.stringify({
						// 初次访问token用于后面/mcp判断。
						access_token: "first-token",
						// 发一个固定refresh-token供后续刷新。
						refresh_token: "refresh-token",
						// 标准类型文字，只是测试数据。
						token_type: "Bearer",
						// scope空串解析后按缺省处理，flow补回授权请求的org:read，而非把空串当新增权限。
						scope: "",
					}),
				);
				// 换码响应发完return。
				return;
			}
			// 以上OAuth路径外，只接受/mcp作为协议入口。
			if (url.pathname !== "/mcp") {
				// 未知路径404。
				response.statusCode = 404;
				// 结束空响应正文。
				response.end();
				// 不继续读协议消息。
				return;
			}
			// GET /mcp在本模拟器不支持SSE。
			if (request.method === "GET") {
				// 405表示方法不支持，不返回空JSONRPC成功包。
				response.statusCode = 405;
				// 结束无正文GET响应。
				response.end();
				// return跳过下方POST式协议解析。
				return;
			}
			// DELETE /mcp模拟会话关闭成功，不检查token或sessionid。
			if (request.method === "DELETE") {
				// 固定200，不代表测试了真实远端关闭策略。
				response.statusCode = 200;
				// 结束关闭响应。
				response.end();
				// 不再读JSON正文。
				return;
			}
			// 取Node已归一化的小写authorization头字段。
			const token = request.headers.authorization;
			// 只允许两个测试Bearer字串，配置的caller-supplied-stale-token会被拒绝。
			if (token !== "Bearer first-token" && token !== "Bearer refreshed-token") {
				// 先把失败请求正文读完，避免本机HTTP读写流程留下未读内容；不解析其JSON。
				await readBody(request);
				// 认证失败状态401附挑战头。
				response.writeHead(401, {
					// An empty scope falls through to the resource metadata's scopes_supported.
					// 挑战给资源发现URL和显式空scope；解析器把空scope省略后，flow从资源文档得到org:read。
					"www-authenticate": `Bearer resource_metadata="${serverOrigin}/.well-known/oauth-protected-resource/mcp", scope=""`,
				});
				// 固定Unauthorized正文，不是OAuth token错误JSON。
				response.end("Unauthorized");
				// 拒绝后return，不发送初始化/工具结果。
				return;
			}
			// 有允许token才完整读取并JSON.parse协议包；as只向TS声明键未知的对象，不是运行时消息guard。
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			// 没id按本模拟器通知处理，未全面校验jsonrpc/method。
			if (!("id" in message)) {
				// 通知回202，无JSON-RPC业务响应。
				response.statusCode = 202;
				// 结束空响应，兼容HTTP传输接受通知。
				response.end();
				// 通知不继续生成带id结果。
				return;
			}
			// 按方法选择固定业务结果，不运行真实工具。
			const result =
				// initialize是唯一特殊方法分支。
				message.method === "initialize"
					? // 初始化结果对象供客户端浅检查。
						{
							// 选择受本地支持清单接受的2025-06-18版本。
							protocolVersion: "2025-06-18",
							// 声明tools能力，不开启其他协议能力。
							capabilities: { tools: {} },
							// 模拟服务器名称/版本。
							serverInfo: { name: "oauth-test", version: "1.0.0" },
						}
					: // 其他带id方法都返回单个issues工具列表；本模拟器没严格限定只能tools/list。
						{ tools: [{ name: "issues", inputSchema: { type: "object" } }] };
			// 声明业务响应JSON类型。
			response.setHeader("content-type", "application/json");
			// 回JSON-RPC2.0、相同id及选定result，客户端据id结算请求。
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});

		// 另开真实loopback回调服务，它与前面的OAuth/MCP服务是两个监听器。
		const callback = await OAuthCallbackServer.listen();
		// 把回调服务生成的URI交假提供者，构造本身不再监听。
		const provider = new TestOAuthProvider(callback.redirectUrl);
		// 第一次客户端连接用于触发“需授权”流程，失败后connect内部会关闭它。
		const firstClient = new McpClient({ name: "oauth-test", version: "1.0.0" });
		// expect包住连接Promise，等待后面rejects判断。
		await expect(
			// 真正启动传输并尝试initialize，首个MCP POST因无有效token返回401。
			firstClient.connect(
				// 新建HTTP传输，此构造保存配置，start本身只设启动标记，send时才fetch。
				new StreamableHttpTransport({
					// MCP目标路径，非授权服务器/token地址。
					url: `${origin}/mcp`,
					// 显式给一个旧Authorization，测试取得provider有效token后会覆盖它。
					headers: { Authorization: "Bearer caller-supplied-stale-token" },
					// 适配器遇401调授权流，这次会记录authorizationUrl并要求用户交互。
					authProvider: adaptOAuthProvider(provider),
					// 禁用后台GET SSE，聚焦POST认证/握手。
					openGetStream: false,
				}),
			),
			// 期待交互要求异常，不是HTTP401简单作为通用连接错误返回。
		).rejects.toBeInstanceOf(McpOAuthAuthorizationRequiredError);
		// 断言生成URL的scope已用资源默认org:read；?.缺URL时得undefined也会让断言失败。
		expect(provider.authorizationUrl?.searchParams.get("scope")).toBe("org:read");
		// resource应与已匹配的本机MCP资源一致。
		expect(provider.authorizationUrl?.searchParams.get("resource")).toBe(`${origin}/mcp`);

		// 先登记预期state以免回调到达时还没等待者，会启动每state默认计时器。
		const callbackResult = callback.waitForCallback("expected-state");
		// 手动GET本机授权URL且redirect:manual，只拿302而不自动跟随；这里模拟浏览器而不是实际开浏览器。
		const authorizationResponse = await fetch(provider.authorizationUrl as URL, { redirect: "manual" });
		// 再手动fetch Location，把请求送到本机callback服务，触发state/code处理。
		await fetch(authorizationResponse.headers.get("location") as string);
		// await回调Promise并只取code，state已由callback检查；这次响应没iss。
		const { code } = await callbackResult;
		// 期望第二阶段通用授权调用最终返回成功标记。
		expect(
			// 显式带码调用authorizeMcp，使用同一个provider保存的客户端/verifier/发现。
			await authorizeMcp(provider, {
				// 仍是同一MCP服务器，资源选择保持一致。
				serverUrl: `${origin}/mcp`,
				// 带刚收到的授权码，进入换码而不是刷新/重定向。
				authorizationCode: code,
				// 显式用宿主fetch，流的HTTP都指向本机模拟端点。
				fetch,
			}),
			// AUTHORIZED表示保存新token完成，不是这个字符串本身做HTTP认证。
		).toBe("AUTHORIZED");

		// 创建新客户端建立授权后的MCP会话，不重用第一次已关闭实例。
		const client = new McpClient({ name: "oauth-test", version: "1.0.0" });
		// await第二次连接应能initialize成功。
		await client.connect(
			// 新HTTP传输使用同一提供者已有token。
			new StreamableHttpTransport({
				// 同一/mcp目标。
				url: `${origin}/mcp`,
				// 仍放旧配置头，用于验证有效provider token优先。
				headers: { Authorization: "Bearer caller-supplied-stale-token" },
				// 为该传输建新的适配器对象；共享令牌在provider，恢复Promise则各适配器独立。
				authProvider: adaptOAuthProvider(provider),
				// 仍禁后台GET。
				openGetStream: false,
			}),
		);
		// tools/list应返回本机固定issues定义，证明该授权token能通过模拟MCP入口。
		expect(await client.listTools()).toEqual([{ name: "issues", inputSchema: { type: "object" } }]);
		// 关闭正常连接；本模拟器没给Mcp-Session-Id，因此HTTP传输不必实际调用DELETE路由，不能把写有DELETE分支当成已覆盖它。
		await client.close();

		// 浅复制已有集合只把access_token改成拒绝值，!只是TS非空断言不做运行检查，refresh_token和scope保留。
		provider.tokenSet = { ...provider.tokenSet!, access_token: "stale-token" };
		// 再建一份客户端测试401恢复，不做真实token自然过期等待。
		const refreshedClient = new McpClient({ name: "oauth-test", version: "1.0.0" });
		// 连接时旧访问token被模拟服务拒绝，触发refresh grant。
		await refreshedClient.connect(
			// 传输构造本身不立即发HTTP。
			new StreamableHttpTransport({
				// 同一资源入口。
				url: `${origin}/mcp`,
				// 配置旧头仍在，实际header会用provider取值覆盖。
				headers: { Authorization: "Bearer caller-supplied-stale-token" },
				// 这份新适配器触发本次恢复，其inFlight标记/Promise独立，provider内的令牌/发现等状态仍与前面共用。
				authProvider: adaptOAuthProvider(provider),
				// 不建GET流。
				openGetStream: false,
			}),
		);
		// Neither token response names a scope, so the grant has the requested scope.
		// 深比较刷新后已保存的完整令牌集合，响应空scope/refresh_token已按缺省规则处理。
		expect(provider.tokenSet).toEqual({
			// 访问令牌应换成新字符串。
			access_token: "refreshed-token",
			// 刷新响应没有有效新refresh token，沿用原refresh-token。
			refresh_token: "refresh-token",
			// 类型继续Bearer。
			token_type: "Bearer",
			// 授权grant原scope org:read保留，空响应scope不是清空权限。
			scope: "org:read",
		});
		// 恰好命中刷新一次，未把每个新连接都当成必须刷新。
		expect(refreshes).toBe(1);
		// 关闭本次客户端连接。
		await refreshedClient.close();
		// 单独关闭callback服务及其未完成等待；正常helper服务随后由hook关。
		await callback.close();
	});

	// 本机模拟轮换刷新：两个并发401共用一次r1→a2/r2，迟到的a1失败不再刷新。断言只收到一次r1且新expiry已存；同一个auth实例内的并发保证，不证明跨进程锁或真实供应商刷新行为。
	it("shares one refresh between concurrent 401s when refresh tokens rotate", async () => {
		// 记录实际收到的refresh token表单值，用数组长度/值验证请求次数。
		const grants: string[] = [];
		// 启动独立loopback服务，正常流程只需发现和/token。
		const origin = await listen(async (request, response, serverOrigin) => {
			// 解析本次请求路径供路由。
			const url = new URL(request.url ?? "/", serverOrigin);
			// 受保护资源文档故意返回坏授权服务器URL。
			if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
				// Invalid resource metadata falls back to the server origin instead of failing discovery.
				// 声明常规JSON响应头；发现函数直接调用response.json，并没有在这里先校验Content-Type。
				response.setHeader("content-type", "application/json");
				// not a url导致资源解析抛普通Error，被组合发现忽略，再选本机根地址；resource整份文档因此未保留。
				response.end(JSON.stringify({ resource: `${serverOrigin}/mcp`, authorization_servers: ["not a url"] }));
				// 资源响应后return。
				return;
			}
			// 授权服务器发现响应的专门路由。
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				// 设置JSON头。
				response.setHeader("content-type", "application/json");
				// 回一份固定授权文档。
				response.end(
					// 把对象编码JSON正文。
					JSON.stringify({
						// Issuer without the trailing slash that URL parsing adds to the fallback server URL.
						// issuer用无尾斜杠origin，默认发现比较只各去一个尾斜杠后接受。
						issuer: serverOrigin,
						// 本机授权路径不会在成功刷新分支被访问。
						authorization_endpoint: `${serverOrigin}/authorize`,
						// 本机/token处理刷新。
						token_endpoint: `${serverOrigin}/token`,
						// 声明支持code，虽然该用例预期不走浏览器授权。
						response_types_supported: ["code"],
					}),
				);
				// 发现文档响应完return。
				return;
			}
			// 令牌路径读取旧刷新grant。
			if (url.pathname === "/token") {
				// 读完整表单后解析参数。
				const params = new URLSearchParams(await readBody(request));
				// 缺refresh_token用空字符串，便于后面统一拒绝。
				const refreshToken = params.get("refresh_token") ?? "";
				// 先记录每次请求值，连错误重复刷新也会留下记录。
				grants.push(refreshToken);
				// 令牌响应都声明JSON。
				response.setHeader("content-type", "application/json");
				// 只有r1可用，若误用轮换后旧值/其他值就拒绝。
				if (refreshToken !== "r1") {
					// 失败HTTP400。
					response.statusCode = 400;
					// 返回invalid_grant使错误重复刷新会影响流程而非伪成功。
					response.end(JSON.stringify({ error: "invalid_grant" }));
					// 错误响应后return。
					return;
				}
				// 真实等20ms扩大并发重叠窗口，不是虚拟时钟，也不证明任意时序都覆盖。
				await new Promise((resolve) => setTimeout(resolve, 20));
				// 正常令牌响应发送固定新集合。
				response.end(
					// 新访问a2/刷新r2及有效3600秒，默认provider保存时计算tokensExpireAt。
					JSON.stringify({ access_token: "a2", refresh_token: "r2", token_type: "Bearer", expires_in: 3600 }),
				);
				// 令牌回应完return。
				return;
			}
			// 其他路径全部404。
			response.statusCode = 404;
			// 结束未知路由响应。
			response.end();
		});
		// 创建内存store，不写用户凭据文件。
		const store = new MemoryOAuthStateStore();
		// 使用实际默认provider而非前面的简化假类，以测写入/过期时间。
		const provider = new McpOAuthProvider({
			// 提供者绑定本机/mcp地址。
			serverUrl: `${origin}/mcp`,
			// 仅登记回调文字，不调用CallbackServer.listen，不因此开第二个端口。
			redirectUrl: "http://127.0.0.1/callback",
			// 仅给客户端名，其余注册元信息由构造器补。
			clientMetadata: { client_name: "test" },
			// 配置client ID，避免动态注册。
			clientId: "client",
			// 复用本例内存store。
			store,
			// 重定向回调空函数；若意外需要登录也不会实际开浏览器，适配器仍会抛交互错误让测试失败。
			onRedirect: () => {},
		});
		// 预存访问a1和刷新r1，先不设置expiry秒数。
		await provider.saveTokens({ access_token: "a1", refresh_token: "r1", token_type: "Bearer" });
		// 同一个auth闭包供下面两次并发恢复共享inFlight。
		const auth = adaptOAuthProvider(provider);
		// 无参数构造失败上下文的新对象，无网络；例每次都带旧token a1，Response只作内存挑战输入。
		const unauthorized = () => ({
			// 构造本地401 Response，不来自一次真实MCP POST；后续授权发现/刷新仍会请求本机服务。
			response: new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } }),
			// 目标serverUrl转URL对象传给适配器。
			serverUrl: new URL(`${origin}/mcp`),
			// 适配器用真实宿主fetch访问本机发现/token。
			fetch,
			// 上下文token为被拒绝旧值，不是provider之后保存的新值。
			token: "a1",
		});
		// Promise.all同时等待两次恢复，可选链方法存在时调用；真实适配器有该方法，失败会令整体拒绝。
		await Promise.all([auth.onUnauthorized?.(unauthorized()), auth.onUnauthorized?.(unauthorized())]);
		// A late 401 for a request that still carried the old token must not refresh again.
		// 再送一次旧token上下文，当前a2不同，应提前返回而不再刷新。
		await auth.onUnauthorized?.(unauthorized());
		// 恰好只请求r1一次，数组深比较也确认无额外token请求值。
		expect(grants).toEqual(["r1"]);
		// token getter应给新访问a2，读取本身不会再自然刷新。
		expect(await auth.token()).toBe("a2");
		// 直接读内存store快照检查真实provider保存内容。
		const state = await store.load();
		// 刷新r2应已落到store快照，非仅局部返回值。
		expect(state?.tokens?.refresh_token).toBe("r2");
		// 到期时间应还远于当前时间3500秒，允许距3600秒有一定运行耗时；毫秒单位+3_500_000，不是恰好等于固定时刻。
		expect(state?.tokensExpireAt).toBeGreaterThan(Date.now() + 3_500_000);
	});

	// 本机模拟insufficient_scope：旧grant有repo/read:org，挑战repo/admin，适配器应要求新授权并生成合并scope，旧access token仍保存。此例不完成浏览器/换码，也没计数所有/token访问，主要断言URL与旧grant保留。
	it("asks for authorization instead of refreshing when the server needs more scope", async () => {
		// 假提供者只记录重定向，不启动回调服务。
		const provider = new TestOAuthProvider("http://127.0.0.1/callback");
		// 预设客户端身份避免注册。
		provider.client = { client_id: "client" };
		// 预设可刷新的旧grant及已授予权限，供增权合并。
		provider.tokenSet = { access_token: "a1", refresh_token: "r1", token_type: "Bearer", scope: "repo read:org" };
		// 启动本机发现服务，token路由故意失败以免刷新看似满足增权。
		const origin = await listen(async (request, response, serverOrigin) => {
			// 解析路径。
			const url = new URL(request.url ?? "/", serverOrigin);
			// 只给根授权发现提供成功文档，资源发现走404回退。
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				// JSON头。
				response.setHeader("content-type", "application/json");
				// 发送固定授权文档。
				response.end(
					// 序列化元信息对象。
					JSON.stringify({
						// issuer是当前本机origin。
						issuer: serverOrigin,
						// 授权页URL只生成，不在此例访问。
						authorization_endpoint: `${serverOrigin}/authorize`,
						// token端点列出但正常增权分支应跳过刷新。
						token_endpoint: `${serverOrigin}/token`,
						// code能力使startAuthorization可继续。
						response_types_supported: ["code"],
					}),
				);
				// 发现响应后return。
				return;
			}
			// /token回500，其他未知路径404；这是服务端后备，不是测试显式统计其命中次数。
			response.statusCode = url.pathname === "/token" ? 500 : 404;
			// 结束响应无正文。
			response.end();
		});
		// 适配当前已存grant提供者。
		const auth = adaptOAuthProvider(provider);
		// 等待恢复回调应拒绝为需要交互。
		await expect(
			// 直接调用auth的401/403恢复接口，不先构造真实MCP客户端请求。
			auth.onUnauthorized?.({
				// 内存Response模拟收到认证失败，不是该对象自动联网。
				response: new Response(null, {
					// 用403和insufficient_scope配对，代表增权挑战。
					status: 403,
					// 要求repo admin，重复repo应去重，原read:org应保留。
					headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="repo admin"' },
				}),
				// 实际发现/授权目标仍为本机/mcp。
				serverUrl: new URL(`${origin}/mcp`),
				// 后续发现使用宿主fetch。
				fetch,
				// 旧失败请求token快照为a1。
				token: "a1",
			}),
			// 流程已生成重定向后，适配器应抛交互要求标记，不把准备URL当成授权成功。
		).rejects.toBeInstanceOf(McpOAuthAuthorizationRequiredError);
		// The challenge may list only the missing scopes; the new grant keeps the old ones too.
		// 期望旧repo/read:org加挑战admin，按出现顺序去重得repo read:org admin。
		expect(provider.authorizationUrl?.searchParams.get("scope")).toBe("repo read:org admin");
		// The working grant is kept until the user authorizes the new scope.
		// 增权准备不删除/替换原grant，工作token仍a1；此断言不验证它在真实服务器长期有效。
		expect(provider.tokenSet?.access_token).toBe("a1");
	});

	// 纯内存验证同一个store里的状态按完整MCP URL隔离：one保存secret，two读取undefined。没有listen/fetch/authorize，回调也只是空函数；只覆盖两个不同主机样本，不代表加密store或检测所有URL等价形式。
	it("binds persisted credentials to the exact MCP server URL", async () => {
		// 两提供者共用一个内存store，故可验证第二个不会读出不属于它的token。
		const store = new MemoryOAuthStateStore();
		// 创建第一台服务器的实际provider，不用假类。
		const first = new McpOAuthProvider({
			// 地址只是内存状态归属标记，不进行DNS/HTTPS连接。
			serverUrl: "https://one.example/mcp",
			// 回调仅String保存，不会监听127.0.0.1。
			redirectUrl: "http://127.0.0.1/callback",
			// 注册元信息只在构造时补默认，不会发注册请求。
			clientMetadata: { client_name: "test" },
			// 属性简写传同一内存store。
			store,
			// 空onRedirect不做浏览器/UI动作，此例也没调用它。
			onRedirect: () => {},
		});
		// 保存固定测试字符串secret作为访问token，不是读取用户真实秘密。
		await first.saveTokens({ access_token: "secret", token_type: "Bearer" });
		// 同归属提供者应读回原访问字符串。
		expect((await first.tokens())?.access_token).toBe("secret");

		// 第二个provider绑定另一主机，但共享store。
		const second = new McpOAuthProvider({
			// 与one地址不同，own严格比较应忽略旧状态。
			serverUrl: "https://two.example/mcp",
			// 回调文字相同不会使MCP服务器身份相同。
			redirectUrl: "http://127.0.0.1/callback",
			// 客户端元信息相同也不会跨服务器共享token。
			clientMetadata: { client_name: "test" },
			// 仍同一个store，不是因为各自空store才读不到。
			store,
			// 空回调，无网络。
			onRedirect: () => {},
		});
		// 第二台读到undefined，原store并未被这次读主动删除或清空。
		expect(await second.tokens()).toBeUndefined();
	});

	// #10493
	// 本机注册测试按五种回调组合断言application_type推导/显式覆盖：IPv4/IPv6/custom scheme→native，公网HTTPS→web，显式web优先。HTTP只发注册端点，不访问这些回调或开浏览器，不验证全部非法URI边界。
	it("registers with an application_type derived from the redirect URIs unless one is set", async () => {
		// 记录提交的注册请求JSON对象，unknown字段需断言/检查才能具体使用。
		const bodies: Record<string, unknown>[] = [];
		// 启动本机注册接收器，没有按pathname细分其他路由。
		const origin = await listen(async (request, response) => {
			// 读完整body后JSON.parse，as不作字段校验。
			const metadata = JSON.parse(await readBody(request)) as Record<string, unknown>;
			// 保存每次实际提交body，供最后按顺序提取application_type。
			bodies.push(metadata);
			// 回注册成功201及JSON头。
			response.writeHead(201, { "content-type": "application/json" });
			// 保留元信息并加固定client ID，registerClient会局部解析结果。
			response.end(JSON.stringify({ ...metadata, client_id: "client" }));
		});
		// 局部helper输入回调数组/可选应用类型，返回registerClient Promise，无独立存储；例register(["com.example.app:/callback"])只提交JSON，不跟随custom URI。
		const register = (redirect_uris: string[], application_type?: string) =>
			// 注册函数没metadata时使用origin根/register默认端点。
			registerClient(origin, {
				// 条件展开只在application_type真值时把显式字段加入clientMetadata；空串不会由此helper传给底层，故本例不测显式空类型。
				clientMetadata: { redirect_uris, ...(application_type ? { application_type } : {}) },
			});
		// IPv4 loopback回调预期native，1234端口只是元数据。
		await register(["http://127.0.0.1:1234/callback"]);
		// IPv6 loopback回调预期native，不真实绑定该地址。
		await register(["http://[::1]/callback"]);
		// 自定义scheme回调预期native，不启动对应应用。
		await register(["com.example.app:/callback"]);
		// HTTPS非loopback回调预期web，不请求app.example。
		await register(["https://app.example/callback"]);
		// localhost回调本可推native，但显式web覆盖默认推导。
		await register(["http://localhost/callback"], "web");
		// 按请求顺序深比较五个应用类型，不断言整个注册body全字段。
		expect(bodies.map((body) => body.application_type)).toEqual(["native", "native", "native", "web", "web"]);
	});

	// 本机发现给错误issuer，断言专用发行方异常；例请求本机origin文档却声明attacker.example。只请求本机元数据，不访问该攻击者文字地址，不把文档结构通过当作issuer可信。
	it("rejects authorization metadata whose issuer does not match discovery", async () => {
		// 启动本机发现服务。
		const origin = await listen(async (request, response, serverOrigin) => {
			// 取请求pathname分支。
			const url = new URL(request.url ?? "/", serverOrigin);
			// 只有标准根well-known授权文档返回成功。
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				// 设置JSON头。
				response.setHeader("content-type", "application/json");
				// 发送故意不匹配的文档。
				response.end(
					// 对象编码为JSON。
					JSON.stringify({
						// issuer恶意样本与发现目标不同，但本身仍是可解析HTTPS URL。
						issuer: "https://attacker.example",
						// 授权端点仍在本机，聚焦issuer而非非法端点scheme。
						authorization_endpoint: `${serverOrigin}/authorize`,
						// token端点仍本机。
						token_endpoint: `${serverOrigin}/token`,
						// 给合法code能力，避免先在结构检查失败。
						response_types_supported: ["code"],
					}),
				);
				// 发现文档回完return。
				return;
			}
			// 其他候选路径404。
			response.statusCode = 404;
			// 结束未知路径响应。
			response.end();
		});
		// 调用默认issuer检查的真实发现函数，等待其拒绝为OAuthIssuerMismatchError。
		await expect(discoverAuthorizationServerMetadata(origin)).rejects.toBeInstanceOf(OAuthIssuerMismatchError);
	});

	// 遍历file/search-ms/ms-msdt三个非HTTP授权端点样本，分别验证发现解析及startAuthorization都拒绝。文档通过本机HTTP提供，但这些危险scheme从不打开/请求；不能从三例推完整平台协议清单。
	it("rejects non-HTTP authorization endpoints, which the platform URL handler would launch", async () => {
		// 样本字符串可能被平台URL处理器启动，所以应在构造授权URL前被检查拒绝；这里仅保存文字。
		const endpoints = ["file://attacker.example/share/x.exe", "search-ms:query=x", "ms-msdt:/id"];
		// 闭包可变端点，循环每轮先赋再请求，按顺序测三种值。
		let endpoint = "";
		// 本机服务对请求回同一形状元数据，_request命名表示未用，不改变参数类型。
		const origin = await listen(async (_request, response, serverOrigin) => {
			// 设置JSON类型。
			response.setHeader("content-type", "application/json");
			// 发送当前endpoint文档。
			response.end(
				// 把数据序列化。
				JSON.stringify({
					// issuer正确等于本机origin，避免走issuer不符分支。
					issuer: serverOrigin,
					// 授权端点用循环当前非HTTP值。
					authorization_endpoint: endpoint,
					// token端点仍合法本机地址，聚焦授权端点校验。
					token_endpoint: `${serverOrigin}/token`,
					// 给支持code的列表。
					response_types_supported: ["code"],
				}),
			);
		});
		// for...of逐样本执行，两种断言均完成才进入下一轮。
		for (const value of endpoints) {
			// 先更新服务闭包字段，所以此次GET会收到当前样本。
			endpoint = value;
			// 发现先解析授权端点字段，预期Invalid authorization endpoint；不会等到平台启动应用才拒绝。
			await expect(discoverAuthorizationServerMetadata(origin)).rejects.toThrow("Invalid authorization endpoint");
			// 再在内存直接构造文档，绕过发现解析器单独测startAuthorization自己的保护。
			const metadata = {
				// 直接文档issuer仍正确。
				issuer: origin,
				// 不安全授权端点直接放字段，TS string类型不会自动阻止。
				authorization_endpoint: value,
				// 合法token地址仅填文档结构；startAuthorization这个入口从不调用token端点，scheme检查失败也不会生成PKCE配对。
				token_endpoint: `${origin}/token`,
				// code声明合法。
				response_types_supported: ["code"],
			};
			// 对异步startAuthorization的拒绝作断言。
			await expect(
				// 只构造URL/PKCE的入口在scheme不合法时应提前拒绝，不开浏览器。
				startAuthorization(origin, {
					// 属性简写把内存文档传入。
					metadata,
					// 固定客户端身份，不涉及动态注册。
					clientInformation: { client_id: "client" },
					// 回调只是参数，不在这次调用开监听。
					redirectUrl: "http://127.0.0.1/callback",
				}),
				// 预期同一错误文字，证明直接调用构造器入口也有检查，而非只依赖发现层。
			).rejects.toThrow("Invalid authorization endpoint");
		}
	});

	// #10172
	// 本机资源文档指向无授权发现的MCP根地址，显式配置/idp/metadata.json覆盖它。断言生成URL使用配置文档端点/resource，并拒绝公网HTTP配置文档；不完成换码，也不证明配置地址/issuer同源，因为配置文档的issuer被信任。
	it("uses a configured authorization server metadata document as is", async () => {
		// 启动本机资源/显式授权文档两路服务。
		const origin = await listen(async (request, response, serverOrigin) => {
			// 解析请求路由。
			const url = new URL(request.url ?? "/", serverOrigin);
			// 所有响应先设JSON头，即使未知路径404也没JSON正文。
			response.setHeader("content-type", "application/json");
			// 资源文档仍可正常发现。
			if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
				// Names the MCP server itself, which serves no authorization server metadata.
				// 资源authorization_servers故意指MCP自己，本机默认well-known没有成功授权文档。
				response.end(JSON.stringify({ resource: `${serverOrigin}/mcp`, authorization_servers: [serverOrigin] }));
				// 显式配置的完整文档路径直接返回元数据，不按well-known推导。
			} else if (url.pathname === "/idp/metadata.json") {
				// 发送下方配置文档正文。
				response.end(
					// 编码JSON。
					JSON.stringify({
						// Not derivable from the document URL; a configured document is not checked.
						// issuer为idp.example，和本机文档origin不同；配置模式不作二者相等比较，也不自动请求此issuer。
						issuer: "https://idp.example",
						// authorization_endpoint仍明确指向本机/idp/authorize。
						authorization_endpoint: `${serverOrigin}/idp/authorize`,
						// token_endpoint仍明确指本机/idp/token，但此例不换token。
						token_endpoint: `${serverOrigin}/idp/token`,
						// 支持code使URL构造可成功。
						response_types_supported: ["code"],
					}),
				);
				// 其他路径没授权文档，走404而不是有效默认发现。
			} else {
				// 未知路径状态404。
				response.statusCode = 404;
				// 结束无正文响应。
				response.end();
			}
		});
		// 假提供者只记录授权URL，不开回调/浏览器。
		const provider = new TestOAuthProvider("http://127.0.0.1/callback");
		// 预配client ID避免注册路由。
		provider.client = { client_id: "client" };
		// 两次authorize共用的基础选项对象。
		const options = {
			// 目标MCP资源保持/mcp。
			serverUrl: `${origin}/mcp`,
			// 显式文档用URL对象传入，正常loopbackHTTP被secureEndpoint例外允许。
			authorizationServerMetadataUrl: new URL(`${origin}/idp/metadata.json`),
		};
		// 无旧refresh token，准备授权并返回REDIRECT，表示URL已交provider。
		expect(await authorizeMcp(provider, options)).toBe("REDIRECT");
		// as URL仅告诉TS此时应已赋值，不自动检查undefined；下面读属性会暴露错误。
		const authorizationUrl = provider.authorizationUrl as URL;
		// 只比origin+pathname，明确取配置文档的/idp/authorize，不包含查询参数整体比较。
		expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(`${origin}/idp/authorize`);
		// resource仍由资源文档匹配为本机/mcp，而不是配置文档issuer。
		expect(authorizationUrl.searchParams.get("resource")).toBe(`${origin}/mcp`);

		// 浅复制选项，替换显式文档URL为公网HTTP；new URL只解析不发请求。
		const insecure = { ...options, authorizationServerMetadataUrl: new URL("http://idp.example/metadata.json") };
		// flow起步的secureEndpoint应拒绝HTTP非loopback，专用异常；不进行该公网URL请求。
		await expect(authorizeMcp(provider, insecure)).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
	});

	// 组合六种code/iss/声明/无元数据路径，断言只有允许的码真正POST到/token并保存令牌；坏iss与承诺缺iss拒绝。无元数据仍可能先有发现GET，不能把codes缺失说成完全无网络；只收集成功允许换码的POST，未检验全部RFC情形。
	it("exchanges a code only when its iss parameter names the authorization server", async () => {
		// 记录服务收到的code，供最后排除不该泄漏到token端点的值。
		const codes: string[] = [];
		// 启动一个只接受POST的本机服务，兼作缺文档时的404发现端点。
		const origin = await listen(async (request, response) => {
			// 非POST一律404，使缺元数据的候选发现返回undefined。
			if (request.method !== "POST") {
				// 设置未找到状态。
				response.statusCode = 404;
				// 结束空正文。
				response.end();
				// GET等请求不加入codes。
				return;
			}
			// POST时完整读表单取code，缺字段空串也记下，不验证code/verifier真实有效。
			codes.push(new URLSearchParams(await readBody(request)).get("code") ?? "");
			// 响应声明JSON。
			response.setHeader("content-type", "application/json");
			// 固定token成功响应，安全判断由客户端发POST前做；这个模拟服务本身不校验iss。
			response.end(JSON.stringify({ access_token: "token", token_type: "Bearer" }));
		});
		// 局部helper按code/可选iss/是否承诺iss/是否缓存文档建新provider，再返回authorize Promise；例exchange("missing",undefined,true)应拒绝。metadata默认true，类型从缺省布尔推导，调用可触发本机HTTP。
		const exchange = (code: string, iss: string | undefined, issParameterSupported: boolean, metadata = true) => {
			// 每次新假提供者避免上一轮缓存/令牌影响下一轮。
			const provider = new TestOAuthProvider("http://127.0.0.1/callback");
			// 预配客户端身份，避免注册。
			provider.client = { client_id: "client" };
			// 预配任意测试verifier，本例token端点不验证PKCE，聚焦iss。
			provider.verifier = "verifier";
			// 先设置发现缓存，至少保留授权服务器URL。
			provider.discovery = {
				// 授权服务器是本机origin，缺文档时由它再尝试发现。
				authorizationServerUrl: origin,
				// 根据metadata布尔决定是否附已发现文档。
				authorizationServerMetadata: metadata
					? // 有文档分支构造固定元信息。
						{
							// 预期iss精确为本机origin。
							issuer: origin,
							// 合法授权端点占位，带code正常不进入授权URL准备。
							authorization_endpoint: `${origin}/authorize`,
							// 本机/token端点供实际码交换。
							token_endpoint: `${origin}/token`,
							// code能力声明。
							response_types_supported: ["code"],
							// 将helper参数作为授权响应iss支持标记，控制缺iss是否必须拒绝。
							authorization_response_iss_parameter_supported: issParameterSupported,
						}
					: // 无文档则undefined，不是空文档对象；runFlow会尝试该服务器发现，服务GET全404后仍可用默认/token。
						undefined,
			};
			// 同一MCP地址+本轮code/iss交真实流，属性简写不生成缺失iss字符串。
			return authorizeMcp(provider, { serverUrl: `${origin}/mcp`, authorizationCode: code, iss });
		};
		// 有iss但指另一个issuer，即使未承诺iss也应拒绝。
		await expect(exchange("other", "https://attacker.example", false)).rejects.toBeInstanceOf(
			// 断言异常类别，不只匹配message片段。
			OAuthIssuerMismatchError,
		);
		// 声明承诺iss却没给，必须拒绝。
		await expect(exchange("missing", undefined, true)).rejects.toBeInstanceOf(OAuthIssuerMismatchError);
		// iss精确匹配且声明支持时应成功AUTHORIZED。
		expect(await exchange("matching", origin, true)).toBe("AUTHORIZED");
		// Servers that do not promise the parameter may omit it.
		// 未承诺iss且实际省略可换码成功，不强制每台服务器都给iss。
		expect(await exchange("omitted", undefined, false)).toBe("AUTHORIZED");
		// Without metadata there is no issuer to compare with, so a server cannot skip the check by hiding it.
		// 既没文档又给无法验证的iss也拒绝，不能用隐瞒文档绕过比对。
		await expect(exchange("unverifiable", "https://attacker.example", false, false)).rejects.toBeInstanceOf(
			// 预期发行方异常。
			OAuthIssuerMismatchError,
		);
		// 既没文档也没iss且未承诺，仍按默认/token换码成功；标题不是“任何无iss都拒绝”。
		expect(await exchange("no-metadata", undefined, false, false)).toBe("AUTHORIZED");
		// 实际POST只含matching/omitted/no-metadata三个码，顺序与调用一致；其他分支可有发现GET但不能把那些code发出去。
		expect(codes).toEqual(["matching", "omitted", "no-metadata"]);
	});

	// #10565
	// 本机接受请求后故意不答，分别测发现阶段和刷新阶段abort：Promise结果应带AbortError且不生成授权URL。没有设整个套件自建总超时，也没证明任意fetch实现都会听signal；使用真实宿主fetch的loopback请求。
	it("stops when its signal aborts, without falling back to a redirect", async () => {
		// 记录服务实际收到但悬挂未回应的路径。
		const stalled: string[] = [];
		// Accepts every request and never answers.
		// 启动本机服务；handler本身很快兑现，但不调用response.end，连接等待到fetch取消/清理。
		const origin = await listen(async (request, _response, serverOrigin) => {
			// 记录每个请求pathname，_response表示有意不用响应对象。
			stalled.push(new URL(request.url ?? "/", serverOrigin).pathname);
		});
		// 局部run输入准备好的provider，发流→等本机确有新请求→abort→检查结果/无URL→返回最后路径；例refreshing返回/token。会真实发本机请求，不阻塞同步线程或启动浏览器。
		const run = async (provider: TestOAuthProvider) => {
			// 每次独立取消控制器，初始未abort。
			const controller = new AbortController();
			// 保存本轮前已收到请求数，以观察增加恰一条。
			const count = stalled.length;
			// 开始异步授权流并给signal，先不await以便等到请求后取消。
			const flow = authorizeMcp(provider, { serverUrl: `${origin}/mcp`, signal: controller.signal });
			// 给拒绝装catch，把未知错误当兑现值收集，避免等待期间出现未处理拒绝；这不是把底层操作变成功。
			const settled = flow.catch((error: unknown) => error);
			// expect.poll反复观察数组长度直到多一条或测试轮询超时，不是仅等固定毫秒。
			await expect.poll(() => stalled.length).toBe(count + 1);
			// 确认请求已到服务端再abort，默认reason由宿主产生。
			controller.abort();
			// await已装catch的结果，部分对象匹配name，验证收到AbortError而非REDIRECT字符串。
			expect(await settled).toMatchObject({ name: "AbortError" });
			// 假提供者没记录authorizationUrl，说明本轮未走通知重定向路径。
			expect(provider.authorizationUrl).toBeUndefined();
			// .at(-1)返回最后收录路径或undefined，后面精确断言区分场景。
			return stalled.at(-1);
		};

		// Discovery.
		// 初始无缓存/客户端/令牌，从资源发现开始取消。
		expect(await run(new TestOAuthProvider("http://127.0.0.1/callback"))).toBe(
			// 预期悬挂的是带/mcp资源well-known路径，而非注册或token端点。
			"/.well-known/oauth-protected-resource/mcp",
		);

		// A failed refresh otherwise falls back to a new authorization.
		// 第二个provider预置完整发现资料和可刷grant，直接到刷新请求。
		const refreshing = new TestOAuthProvider("http://127.0.0.1/callback");
		// 配客户端身份，避免动态注册。
		refreshing.client = { client_id: "client" };
		// 旧访问/刷新令牌只是测试字符串，驱动刷新分支。
		refreshing.tokenSet = { access_token: "a1", refresh_token: "r1", token_type: "Bearer" };
		// 设置缓存，使本次不用新资源发现。
		refreshing.discovery = {
			// 授权服务器本机origin。
			authorizationServerUrl: origin,
			// 缓存完整授权元数据，避免补文档请求。
			authorizationServerMetadata: {
				// issuer与origin一致。
				issuer: origin,
				// 授权端点不应在这轮取消后通知访问。
				authorization_endpoint: `${origin}/authorize`,
				// 刷新实际POST向本机/token。
				token_endpoint: `${origin}/token`,
				// 支持code声明占位。
				response_types_supported: ["code"],
			},
		};
		// 断言取消发生在/token，普通刷新失败本可准备重定向，但signal.aborted使该错误原样传播。
		expect(await run(refreshing)).toBe("/token");
	});
});

// 单独分组三个真实loopback回调页用例；各自listen，try/finally保证正常进入try后的关闭，不打开真实浏览器。
describe("OAuthCallbackServer pages", () => {
	// 默认回调服务成功页应是固定纯文本并兑现code，例s1/abc。会真实监听和fetch本机；finally关闭该回调实例，不由helper服务清单负责。
	it("renders plain text by default", async () => {
		// 默认127.0.0.1动态端口/callback，明确调用才开始监听。
		const callback = await OAuthCallbackServer.listen();
		// 启动成功后进入try，保证后面断言/请求失败也finally关服务。
		try {
			// 先登记state s1，生成每state计时器，再发回调。
			const pending = callback.waitForCallback("s1");
			// GET本机回调并携code/state，模拟浏览器回跳。
			const response = await fetch(`${callback.redirectUrl}?code=abc&state=s1`);
			// 确认默认MIME是纯文本UTF-8，不是HTML。
			expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
			// 完整读body精确比较成功文案，没有把code放进默认页面。
			expect(await response.text()).toBe("Authorization complete. You may close this window.");
			// 等待者应收到code abc；此处没额外断言回调对象的所有键。
			expect((await pending).code).toBe("abc");
			// 无论try成功/失败都进入清理。
		} finally {
			// await关闭服务并拒绝未完成等待；关闭失败仍可令用例失败。
			await callback.close();
		}
	});

	// #10302
	// 同时允许通用与服务器专有路径，但一次等待限定专有路径。s1错误走通用时HTTP400且Promise拒绝，另登记s2走正确路径200/code成功；这测路径绑定，不测试跨origin/Host验证，finally关真实服务。
	it("rejects a response on another path than the expected one", async () => {
		// extraPaths添加专有入口，默认/callback仍保留；只加允许路径本身不把所有等待限制为它。
		const callback = await OAuthCallbackServer.listen({ extraPaths: ["/callback/server-id"] });
		// 监听后进入清理保护块。
		try {
			// 从回调URL取origin用来拼两个不同路径，保留动态端口。
			const origin = new URL(callback.redirectUrl).origin;
			// 对state s1额外限定期望/callback/server-id。
			const mixedUp = callback.waitForCallback("s1", "/callback/server-id");
			// 提前装拒绝处理器避免fetch完成前Promise已拒绝造成未处理报告；不改原mixedUp Promise的拒绝状态。
			mixedUp.catch(() => undefined);
			// 用相同已知state却走另一个允许入口/callback，触发每等待路径检查。
			const wrong = await fetch(`${origin}/callback?code=abc&state=s1`);
			// 错误路径返回400，不表示state不存在，而是它已经被消费并拒绝。
			expect(wrong.status).toBe(400);
			// 原等待Promise应拒绝并含另一路径提示，不把HTTP成功与Promise成功混同。
			await expect(mixedUp).rejects.toThrow("arrived on another redirect URI");

			// 错误state已消费，新的s2另登记同专有路径，重新开始计时。
			const pending = callback.waitForCallback("s2", "/callback/server-id");
			// GET正确专有路径与s2。
			const right = await fetch(`${origin}/callback/server-id?code=abc&state=s2`);
			// 正确回调响应200。
			expect(right.status).toBe(200);
			// 该新等待应兑现abc。
			expect((await pending).code).toBe("abc");
			// 任何try内异常都进行关闭。
		} finally {
			// 关本实例及剩余计时器/等待。
			await callback.close();
		}
	});

	// 自定义HTML渲染：记录每次page参数，失败用s1/Denied、成功用s2/abc，断言失败MIME/等待拒绝与页面数据及成功HTML。渲染器仅示例直接插固定测试message，不提供通用HTML清洗/安全证明；真实loopback，finally关服务。
	it("renders pages through renderPage", async () => {
		// 页面参数记录数组，OAuthCallbackPage标签联合让ok分支缩窄类型。
		const pages: OAuthCallbackPage[] = [];
		// 实际监听回调服务并注入渲染函数，此处构造只在该it执行。
		const callback = await OAuthCallbackServer.listen({
			// 同步渲染回调输入page返回HTML字符串，无自身网络；例成功返回固定<p>ok</p>。
			renderPage: (page) => {
				// 记录原page引用供最后读取最新一份，不克隆。
				pages.push(page);
				// ok真分支固定成功HTML；失败分支TS可读message，模板直接插入，不在此做HTML转义。
				return page.ok ? "<p>ok</p>" : `<p>${page.message}</p>`;
			},
		});
		// 监听成功后try/finally保护后续步骤。
		try {
			// 先登记失败场景state s1。
			const denied = callback.waitForCallback("s1");
			// 提前接catch吸收可能先发生的拒绝，不让原Promise变兑现。
			denied.catch(() => undefined);
			// 发送本机OAuth拒绝回调，error优先于code路径，description为Denied。
			const failure = await fetch(`${callback.redirectUrl}?error=access_denied&error_description=Denied&state=s1`);
			// 自定义渲染应声明HTML UTF-8。
			expect(failure.headers.get("content-type")).toBe("text/html; charset=utf-8");
			// 等待者应拒绝并含Denied，不因HTTP页面返回200而认为授权成功。
			await expect(denied).rejects.toThrow("Denied");
			// 读取最近一次renderPage收到的数据对象，不是浏览器解析后的DOM。
			expect(pages.at(-1)).toEqual({
				// 失败标签false。
				ok: false,
				// 固定失败主文案。
				message: "Authorization failed. You may close this window.",
				// 原error_description作为details给渲染器，测试并未要求把details拼入HTML正文。
				details: "Denied",
			});

			// 另登记s2验证成功渲染，不复用已消费s1。
			const pending = callback.waitForCallback("s2");
			// GET正确code/state的本机回调。
			const success = await fetch(`${callback.redirectUrl}?code=abc&state=s2`);
			// 精确比较返回成功HTML，失败页面正文没有在这个用例中逐字断言。
			expect(await success.text()).toBe("<p>ok</p>");
			// 成功等待应兑现code abc。
			expect((await pending).code).toBe("abc");
			// 成功与异常都清理。
		} finally {
			// await关闭实际回调监听，未完成等待也随close拒绝。
			await callback.close();
		}
	});
});
