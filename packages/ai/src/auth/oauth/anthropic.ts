// Anthropic CLI OAuth实现：浏览器/复制码登录、token兑换、刷新及请求认证派生；通过lazy加载，不负责会话或凭证持久化。
/**
 * Anthropic OAuth flow (Claude Pro/Max)
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

// 供应商环境入口还处理Bun沙箱环境回退，回调监听主机在模块初始化时读取一次。
import { getProviderEnvValue } from "../../utils/provider-env.ts";
// 只导入认证接口/数据类型，OAuthAuth对象在文件末尾提供实现。
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
// 共用本机回调与手动输入协调器，真正建立HTTP监听在登录时。
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
// 共用PKCE材料，verifier须贯穿本次授权与兑换。
import { generatePKCE } from "./pkce.ts";

/**
 * 把固定Base64文本解码为客户端标识，返回字符串，不访问网络。
 * 例：CLIENT_ID加载时由这层编码还原；Base64只是表示方式，不是把公共OAuth客户端id加密成秘密。
 */
const decode = (s: string) => atob(s);
// 模块加载时还原固定公共客户端id，不从用户凭证生成它。
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
// 浏览器授权页面地址，与换token的API端点不同。
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
// 授权码兑换与refresh共同使用此端点。
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// 环境允许覆盖监听host，空值回退127.0.0.1；这不是在此验证所有覆盖都为loopback。
const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
// Preferred so the port can be forwarded into containers or over SSH. Anthropic accepts any loopback port,
// so login falls back to a free port when this one cannot be bound (#10571).
// 首选本地回调端口，方便转发；占用时登录逻辑还会试0。
const CALLBACK_PORT = 53692;
// 只受理的回调路径。
const CALLBACK_PATH = "/callback";
// 本地服务完全不可用时仍用这个固定redirect进行手工回退；实际绑定到空闲端口时采用服务返回URI。
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
// 复制码流程的服务端回调地址，不需要本机监听它。
const COPY_CODE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
// 浏览器选项的稳定id，区别于展示label。
const ANTHROPIC_BROWSER_LOGIN_METHOD = "browser";
// 复制码选项的稳定id。
const ANTHROPIC_COPY_CODE_LOGIN_METHOD = "copy_code";
// 这一组权限scope交授权服务解释，不是在本地创建API key或开通功能。
const SCOPES =
	// 权限文字的续行，按原值发送，不在其中插入注释。
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

/**
 * 解析用户贴入的授权材料，返回可缺省code/state，无HTTP或存储操作。
 * 依次试URL查询、code#state、查询串、裸码；例：abc#xyz得到code=abc/state=xyz。URL分支只抽query，不校验域名/回调路径，state一致性由登录方法另判。
 */
function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	// 仅去掉输入首尾空白，内部授权材料不改写。
	const value = input.trim();
	// 空输入返回空对象，后面登录层再报缺码。
	if (!value) return {};

	// 先尝试完整URL解析，失败才考虑其他格式。
	try {
		// URL构造不发送请求，也不在此限制协议/主机。
		const url = new URL(value);
		// 成功按query读取，不从URL片段读取code。
		return {
			// 缺少code的null转换成undefined，保留空串由后面判断。
			code: url.searchParams.get("code") ?? undefined,
			// state同样可缺省；本函数只提取不核对。
			state: url.searchParams.get("state") ?? undefined,
		};
		// URL解析失败属于允许的输入格式回退，不是最终登录失败。
	} catch {
		// not a URL
	}

	// 非URL但含#时按code#state解释。
	if (value.includes("#")) {
		// 数组解构取最多两段，后续更多#片段不会全保留。
		const [code, state] = value.split("#", 2);
		// 把拆出的两段直接返回，不trim各字段或校验一致性。
		return { code, state };
	}

	// 非URL又含code=则尝试查询串解析。
	if (value.includes("code=")) {
		// URLSearchParams解析转义/键值，不需要前面有完整URL。
		const params = new URLSearchParams(value);
		// 构造查询串解析结果。
		return {
			// 取第一个code参数或undefined。
			code: params.get("code") ?? undefined,
			// 取第一个state参数或undefined。
			state: params.get("state") ?? undefined,
		};
	}

	// 其他非空文字全部当裸code，不要求必须带state。
	return { code: value };
}

/**
 * 把任意异常整理成诊断文字，返回字符串，不写日志或请求网络。
 * Error包含名字、消息、可选code/errno、递归cause及stack；例：网络错误的底层cause会并入请求失败说明。
 * 它不作敏感信息脱敏，也没有循环cause检测；不能把结果保证为适合公开分享的安全日志。
 */
function formatErrorDetails(error: unknown): string {
	// 外部异常边界确认Error，其他值走最后String转换。
	if (error instanceof Error) {
		// 先用名字和消息组成诊断数组，不立即打印。
		const details: string[] = [`${error.name}: ${error.message}`];
		// 交叉类型声明可能带errno/code等扩展，as不验证值类型。
		const errorWithCode = error as Error & { code?: string; errno?: number | string; cause?: unknown };
		// 非空code才追加；没有自动做脱敏。
		if (errorWithCode.code) details.push(`code=${errorWithCode.code}`);
		// errno只要非undefined就转文字，0也会记录。
		if (typeof errorWithCode.errno !== "undefined") details.push(`errno=${String(errorWithCode.errno)}`);
		// cause存在就递归格式化，不要求它也是Error。
		if (typeof error.cause !== "undefined") {
			// 递归展开底层原因；此实现没有检测自引用cause。
			details.push(`cause=${formatErrorDetails(error.cause)}`);
		}
		// 有stack文字也收进诊断，可能包含本机路径。
		if (error.stack) {
			// 保留stack原文，不压缩为一行调用位置。
			details.push(`stack=${error.stack}`);
		}
		// 各诊断项用分号拼接，函数只返回文字。
		return details.join("; ");
	}
	// 字符串/对象等非Error抛出值按String表示。
	return String(error);
}

/**
 * 向给定URL POST JSON，返回完整响应文字；会发网络请求，失败/取消/三十秒信号触发可拒绝。
 * 先fetch再读text，非2xx把状态/URL/正文写入错误；例：token端点400会抛错，不返回JSON对象，也不自动重试。
 */
async function postJson(url: string, body: Record<string, string | number>, signal: AbortSignal): Promise<string> {
	// 真正开始网络POST，不在函数内设置额外重试。
	const response = await fetch(url, {
		// 使用POST方法发送兑换/刷新请求。
		method: "POST",
		// 声明请求与期望响应的数据格式。
		headers: {
			// 请求正文为JSON。
			"Content-Type": "application/json",
			// 期望服务端返回JSON，成功后仍先读为文字。
			Accept: "application/json",
		},
		// 序列化字符串/数字字典，不包含可执行代码。
		body: JSON.stringify(body),
		// 调用者取消或30秒任一信号触发都可取消fetch；需要底层合作，不是强制终止任意实现。
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
	});

	// 先读完响应正文，错误信息才可包含服务返回说明。
	const responseBody = await response.text();

	// 非2xx状态统一失败，不只检查某个业务error字段。
	if (!response.ok) {
		// 错误含完整响应正文和URL；此层没有过滤秘密信息。
		throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`);
	}

	// 成功返回原响应文字，JSON语法检查留给上层。
	return responseBody;
}

/**
 * 用code/state/同次verifier/redirectUri向token端点兑换OAuth凭证，返回新对象，不持久化。
 * 请求失败与JSON语法失败分别加诊断；JSON.parse后的as只声明字段，没有逐字段运行时校验。
 * 例：expires_in=3600先换毫秒并扣五分钟，外层Models之后还可能按自己的五分钟窗口提前刷新；两层余量不要混为一次。
 */
async function exchangeAuthorizationCode(
	// 本次授权收到的code。
	code: string,
	// 本次state也作为token JSON字段发送。
	state: string,
	// 与授权challenge配套的verifier。
	verifier: string,
	// 兑换的redirect必须与授权时使用的一致。
	redirectUri: string,
	// 传递登录/刷新操作的取消信号。
	signal: AbortSignal,
): Promise<OAuthCredential> {
	// let先声明后赋值，保存成功响应文字供独立解析错误边界使用。
	let responseBody: string;
	// 只为网络/非成功HTTP等请求失败加兑换诊断。
	try {
		// await POST helper，调用期间可能取消或失败。
		responseBody = await postJson(
			// 固定token API端点，不把手工输入当请求地址。
			TOKEN_URL,
			// 组授权码grant的JSON参数。
			{
				// 授权码兑换类别，与refresh_token grant区分。
				grant_type: "authorization_code",
				// 公共客户端标识。
				client_id: CLIENT_ID,
				// 属性简写提交code。
				code,
				// 提交这次state文字，不在此再次验证一致性。
				state,
				// 字段名redirect_uri与TS局部变量redirectUri不同。
				redirect_uri: redirectUri,
				// 提交同次PKCE verifier，不提交challenge作为兑换证明。
				code_verifier: verifier,
			},
			// 把同一操作信号转交请求helper。
			signal,
		);
		// 网络/HTTP失败归入这一catch，尚未开始JSON解析。
	} catch (error) {
		// 创建可读上下文错误，不使用ModelsError分类；上层resolve再包装。
		throw new Error(
			// 诊断同时保留端点、redirect及底层错误详情；不作脱敏保证。
			`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
		);
	}

	// 声明预期token结构只是静态类型，不证明响应已具备所有字段。
	let tokenData: { access_token: string; refresh_token: string; expires_in: number };
	// 单独捕获JSON语法问题，使错误与HTTP失败区分。
	try {
		// JSON.parse真的校验语法，as不逐字段校验access_token/refresh_token/expires_in。
		tokenData = JSON.parse(responseBody) as { access_token: string; refresh_token: string; expires_in: number };
		// 语法解析失败在这里加原响应说明。
	} catch (error) {
		// 以新Error报告无法解析JSON。
		throw new Error(
			// 包含原响应文字与格式化异常，适合排查但不保证可公开分享。
			`Token exchange returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	// 构造新凭证对象，交上层保存而不是这里写磁盘。
	return {
		// 规范存储标签oauth。
		type: "oauth",
		// 新refresh材料原样来自响应字段。
		refresh: tokenData.refresh_token,
		// 新请求token原样来自响应字段。
		access: tokenData.access_token,
		// 秒换毫秒加当前时间，再提前扣五分钟；不是改变服务端真实到期时间。
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
	};
}

/**
 * 执行浏览器回调或手动贴码登录，输入交互，返回OAuth凭证；会生成PKCE、绑定端口、通知/提示并请求token。
 * 优先53692，失败再试空闲端口，两次失败仍可手工输入；授权和兑换都使用同一redirectUri，finally关闭已建立服务。
 * 例：远程机器浏览器回不到本机时可贴URL；手工state有真值才比对，允许裸码，没有在此要求完整可信回调URL。
 */
async function loginAnthropic(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	// 为本次登录生成独立verifier/challenge，不复用旧登录状态。
	const { verifier, challenge } = await generatePKCE();
	/**
	 * 按指定端口启动本次Anthropic回调服务，返回服务Promise；闭包捕获同次verifier和交互信号。
	 * 例：端口0取系统空闲端口，回调complete只返回code，实际token兑换稍后执行，因此浏览器成功页先于token兑换/保存。
	 */
	const startCallbackServer = (port: number) =>
		// 调用共用服务，用参数port便于首选失败后改空闲端口。
		startOAuthCallbackServer({
			// 页面展示Anthropic身份。
			providerName: "Anthropic",
			// 实际监听host来自模块常量。
			host: CALLBACK_HOST,
			// 属性简写采用工厂入参端口。
			port,
			// 配置精确回调路径。
			path: CALLBACK_PATH,
			// 授权服务看到的redirect主机始终用localhost，与监听IP可不同。
			redirectHost: "localhost",
			// 用同次verifier充当state，回调helper严格比较。
			state: verifier,
			// 回调完成动作只返回code；HTTP成功页不代表后面的token交换已经成功。
			complete: async (code) => code,
			// 总登录信号让回调wait可以取消。
			signal: interaction.signal,
		});
	// Without a callback server, login continues with the pasted redirect URL.
	// 优先绑定固定端口。
	const callback = await startCallbackServer(CALLBACK_PORT)
		// 任意启动失败都试端口0，不仅仅EADDRINUSE；不保证必能回退成功。
		.catch(() => startCallbackServer(0))
		// 第二次启动失败被降级为无服务，仍允许后面手动输入。
		.catch(() => undefined);
	// 有真实服务用其实际端口URI，否则采用固定手工回退URI。
	const redirectUri = callback?.redirectUri ?? REDIRECT_URI;

	// 从构造授权参数到兑换都处于finally关闭服务的范围。
	try {
		// URLSearchParams负责编码查询值，不手工拼未经编码的code/state。
		const authParams = new URLSearchParams({
			// 供应商要求的授权参数code="true"，不是用户授权码。
			code: "true",
			// 固定公共客户端id。
			client_id: CLIENT_ID,
			// 请求授权码响应。
			response_type: "code",
			// 浏览器回跳使用当前选定URI。
			redirect_uri: redirectUri,
			// 发送固定scope文字。
			scope: SCOPES,
			// 只在授权阶段发送challenge。
			code_challenge: challenge,
			// 声明PKCE摘要方式S256。
			code_challenge_method: "S256",
			// 同次verifier作为state参与往返核对。
			state: verifier,
		});
		// 同步通知宿主展示/尝试打开授权页面，不在这里直接调用系统浏览器。
		interaction.notify({
			// auth_url让UI识别这是授权链接。
			type: "auth_url",
			// 把已编码参数加到授权地址，保留原英文提示内容。
			url: `${AUTHORIZE_URL}?${authParams.toString()}`,
			// 后续字符串行是操作说明，供远程机器用户选择手工回退。
			instructions:
				// 提示说明文字，不由本模块执行。
				"Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		// 手工输入与回调共同等待；具体claimed优先规则由helper管理。
		const result = await waitForCallbackOrManualInput(interaction, callback, {
			// 传给手工提示的文案。
			message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
			// 占位显示本次redirect，便于用户识别该贴哪个URL。
			placeholder: redirectUri,
		});
		// 两条路径都会给code，先声明可缺省，后面统一检查。
		let code: string | undefined;
		// 默认state用本地verifier；手工提供非undefined值时可替换它。
		let state = verifier;
		// 按可分辨联合收窄callback.value类型。
		if (result.type === "callback") {
			// 回调helper已经核对state，这里仅取code。
			code = result.value;
			// 其余分支是未解析的手工文字。
		} else {
			// 允许完整URL、code#state、查询串或裸码。
			const parsed = parseAuthorizationInput(result.input);
			// 只有手工state为真值时才要求一致，缺失/空串不走这项拒绝条件。
			if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
			// 提取可能仍缺省的code。
			code = parsed.code;
			// ??只对缺省回退；明确空state会保留为空串发送。
			state = parsed.state ?? verifier;
		}

		// 没有非空授权码就拒绝，不发token请求。
		if (!code) throw new Error("Missing authorization code");
		// 通知兑换进度，尚未把凭证发布到存储。
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		// await兑换确保finally在兑换结算后才close已建立回调服务。
		return await exchangeAuthorizationCode(code, state, verifier, redirectUri, interaction.signal);
		// 成功、错误或取消都尝试关闭监听。
	} finally {
		// 无服务时可选调用不做操作，有服务时关闭未结算等待/监听。
		callback?.close();
	}
}

/**
 * 执行不建本机回调服务的复制码登录，返回凭证；生成PKCE、通知授权URL、等手工码再兑换。
 * 固定使用服务端code回调URL，接受code#state等格式；例：用户贴abc#同次state，先检查state再请求token，失败拒绝，不持久化。
 */
async function loginAnthropicCopyCode(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	// 复制码同样使用新的PKCE材料。
	const { verifier, challenge } = await generatePKCE();
	// 构造复制码授权URL参数，与浏览器回调大部分相同。
	const authParams = new URLSearchParams({
		// 供应商要求的固定code参数。
		code: "true",
		// 公共客户端id。
		client_id: CLIENT_ID,
		// 授权码响应类型。
		response_type: "code",
		// 使用服务端显示授权码的回调地址，不绑定本机端口。
		redirect_uri: COPY_CODE_REDIRECT_URI,
		// scope仍采用同一组权限。
		scope: SCOPES,
		// 对应本次verifier的challenge。
		code_challenge: challenge,
		// PKCE方式为S256。
		code_challenge_method: "S256",
		// state仍为本次verifier，便于手工返回时核对。
		state: verifier,
	});
	// 把授权页面发给宿主展示。
	interaction.notify({
		// 通知类别为授权URL。
		type: "auth_url",
		// 编码后的完整授权地址。
		url: `${AUTHORIZE_URL}?${authParams.toString()}`,
		// 说明用户应复制服务端显示的码，而不是等待本机回调。
		instructions: "Complete login in your browser, then copy the code Anthropic shows and paste it here.",
	});

	// 只启动手动码提示，没有调用回调服务器helper。
	const input = await interaction.prompt({
		// UI类别manual_code。
		type: "manual_code",
		// 提示复制授权码。
		message: "Paste the code Anthropic shows after you sign in:",
		// 展示code#state示例格式，不是强制唯一可接受格式。
		placeholder: "code#state",
		// 提示直接使用总登录信号，取消策略由宿主交互实现。
		signal: interaction.signal,
	});
	// 复用多格式解析器。
	const parsed = parseAuthorizationInput(input);
	// 非空state若不一致立即拒绝。
	if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
	// 缺码立即拒绝，不发送兑换请求。
	if (!parsed.code) throw new Error("Missing authorization code");
	// 通知token交换阶段。
	interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
	// 使用同一兑换辅助处理HTTP/JSON错误并构造凭证。
	return await exchangeAuthorizationCode(
		// 提交手工解析的code。
		parsed.code,
		// state缺省用本地verifier，空字符串仍会保留。
		parsed.state ?? verifier,
		// PKCE原verifier不能换成输入state或challenge。
		verifier,
		// 兑换redirect与复制码授权时一致。
		COPY_CODE_REDIRECT_URI,
		// 总登录信号传给网络请求。
		interaction.signal,
	);
}

/**
 * Refresh Anthropic OAuth token
 */
/**
 * 用现有refresh token请求新凭证，返回access/refresh/到期对象，不写CredentialStore。
 * POST不附scope，分别整理请求与JSON语法失败；例：供应商轮换refresh_token后返回新值，由Models持锁保存。
 * 网络JSON字段仍依赖类型断言，缺字段不在本函数全面验证；原凭证是否保留/写回由上层决定。
 */
async function refreshAnthropicToken(refreshToken: string, signal: AbortSignal): Promise<OAuthCredential> {
	// 保存响应原文，后面单独解析。
	let responseBody: string;
	// 请求失败加刷新上下文，区别于首次授权交换。
	try {
		// 同一个JSON helper带三十秒信号并检查HTTP状态。
		responseBody = await postJson(
			// 仍访问固定token端点。
			TOKEN_URL,
			// 刷新grant的JSON参数对象。
			{
				// grant_type为refresh_token，不再发送授权码。
				grant_type: "refresh_token",
				// 公共客户端id仍需提交。
				client_id: CLIENT_ID,
				// 使用参数refreshToken，不从本模块全局缓存读取。
				refresh_token: refreshToken,
			},
			// Provider传入的刷新信号，通常由外层调度设置独立超时。
			signal,
		);
		// 请求级错误在这里整理为可读说明。
	} catch (error) {
		// 保留token端点与底层详情，不在此自动删除旧存储。
		throw new Error(`Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`);
	}

	// 响应预期形状声明；scope可选但返回凭证并未复制它。
	let data: { access_token: string; refresh_token: string; expires_in: number; scope?: string };
	// 单独处理JSON语法错误。
	try {
		// as断言不替代字段检查，下列各行只是类型成员。
		data = JSON.parse(responseBody) as {
			// 预期服务给出的access token文字。
			access_token: string;
			// 预期新refresh token；此函数没有缺省沿用旧值的逻辑。
			refresh_token: string;
			// 预期寿命秒数。
			expires_in: number;
			// 可能的scope字段，没有参与后面凭证构造。
			scope?: string;
		};
		// JSON无法解析才进入此catch，不会因缺某个字段自动进入。
	} catch (error) {
		// 抛新诊断错误，不返回伪成功凭证。
		throw new Error(
			// 失败说明包含响应原文，未自动脱敏。
			`Anthropic token refresh returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	// 返回新对象，由外层store决定持久化。
	return {
		// 规范oauth标签。
		type: "oauth",
		// 新refresh原样读取，不自动回退调用者旧refresh。
		refresh: data.refresh_token,
		// 新的请求access token。
		access: data.access_token,
		// 继续扣五分钟本地调度余量，真实远端寿命没有被修改。
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

// 导出的OAuth方法对象，Provider的lazy外观最终加载它；定义对象本身不开始登录。
export const anthropicOAuth: OAuthAuth = {
	// 认证方式展示名。
	name: "Anthropic (Claude Pro/Max)",
	// 标记订阅认证类别，不核实用户是否已购买套餐。
	isSubscription: true,

	/**
	 * 询问两种登录方式并分派，返回所选flow凭证Promise，选择取消/未知id会拒绝。
	 * 浏览器项排第一不等于自动确认，宿主应返回选项id；例：copy_code明确进入无需本地回调的复制码方式。
	 */
	async login(interaction) {
		// 等待宿主返回登录选项id，可能因用户取消拒绝。
		const method = await interaction.prompt({
			// 选择提示类型。
			type: "select",
			// 选择页面标题，保留英文UI文案。
			message: "Select Anthropic login method:",
			// 数组顺序使浏览器项先展示，是否预选仍由UI决定。
			options: [
				// browser是返回id，label是展示文字。
				{ id: ANTHROPIC_BROWSER_LOGIN_METHOD, label: "Browser login (default)" },
				// copy_code选择无需回调服务器的流程。
				{ id: ANTHROPIC_COPY_CODE_LOGIN_METHOD, label: "Copy code login (headless)" },
			],
		});

		// 明确选择复制码时只走该流程。
		if (method === ANTHROPIC_COPY_CODE_LOGIN_METHOD) {
			// 返回复制码的异步结果/拒绝，不再执行浏览器路径。
			return loginAnthropicCopyCode(interaction);
		}
		// 既非复制码又非浏览器的id一律拒绝，不把未知输入当默认选择。
		if (method !== ANTHROPIC_BROWSER_LOGIN_METHOD) {
			// 错误列出未知id，便于定位宿主交互问题。
			throw new Error(`Unknown Anthropic login method: ${method}`);
		}

		// 只有browser才进入本地回调/手工URL流程。
		return loginAnthropic(interaction);
	},

	// 刷新适配取完整凭证的refresh字段，保持同一信号，不自行持锁。
	refresh: (credential, signal) => refreshAnthropicToken(credential.refresh, signal),

	/**
	 * 把已存OAuth access转换成请求apiKey，异步返回新认证对象，无网络兑换/存储。
	 * 例：{access:"token"}对应{apiKey:"token"}，是否仍有效由外层刷新调度负责，本方法不现场校验token。
	 */
	async toAuth(credential) {
		// 请求适配器把此apiKey按Anthropic协议使用，转换本身不访问网络。
		return { apiKey: credential.access };
	},
};
