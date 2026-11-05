// 接收浏览器跳回的OAuth结果：listen显式启动HTTP监听，waitForCallback按state登记等待，handle核对允许路径/state并返回code/iss，close拒绝剩余等待。宿主再把code交flow换令牌；本文件不打开浏览器、不请求令牌或核验iss。
// 默认监听127.0.0.1但允许配置其他host；匹配state/路径不等于完整校验请求来源、HTTP方法或授权服务器身份。只导入模块不会执行listen。
// createServer是实际运行时函数，逐项type导入的Server/ServerResponse只用于TS检查，不在JS里增加对应变量。
import { createServer, type Server, type ServerResponse } from "node:http";

// 成功回调的数据形状，interface只让TS检查使用方式，不是输入URL的自动验证器。
export interface OAuthCallback {
	// 授权码字符串，handle要求真值，但不检查格式/有效期或自行换token。
	code: string;
	// 回调带来的state文字，必须对应pending里的真值键才接受。
	state: string;
	// 可选发行方文字；handle只在真值时返回它，真正与issuer比较在flow.runFlow。
	iss?: string;
}

/** Outcome shown on the browser page after the redirect. */
// 以ok字面量作标签联合：成功只有ok:true，失败才有message及可选details；if(page.ok)后TS能区分两支，不是运行时渲染函数。
export type OAuthCallbackPage = { ok: true } | { ok: false; message: string; details?: string };

// 监听/回调展示选项，?表示可省略，具体默认值在listen执行时补。
export interface OAuthCallbackServerOptions {
	/** Address to listen on. Default: `127.0.0.1`. */
	// 实际绑定的host，缺省127.0.0.1；本类没有强制只能loopback或自己解析DNS。
	host?: string;
	/**
	 * Host name in `redirectUrl`, for example `localhost` for a client registered with it while
	 * listening on `127.0.0.1`. Default: `host`.
	 */
	// 拼进公开redirectUrl的主机，可与绑定host不同；不是自动绑定第二个监听地址，也不验证其是否可达。
	redirectHost?: string;
	// 可选TCP端口，缺省0由系统分配；类型number不保证范围，非法值由Node监听API处理。
	port?: number;
	// 主回调路径，默认/callback；此字符串没有预先规范成URL.pathname。
	path?: string;
	/** More paths that receive the callback, for example a server-specific path of a redirect URI. */
	// 额外允许的路径；它们只扩大入口列表，单次waitForCallback仍可限定本次期望路径。
	extraPaths?: string[];
	// 每个state等待的超时毫秒数，默认5分钟；不是整个授权/浏览器会话的总时限，没有取消信号参数。
	timeoutMs?: number;
	/** Render the browser page as HTML. Default: a plain-text message. */
	// 可选同步页面渲染函数，输入成功/失败描述返回HTML文字；内容转义与安全由宿主实现负责，本类不清洗HTML。
	renderPage?: (page: OAuthCallbackPage) => string;
}

// 把页面结果转默认纯文本，输入标签联合返回字符串，无I/O；例：失败message和真值details用两个换行连接。成功文案固定，不输出授权code/token，空details被省略。
function plainText(page: OAuthCallbackPage): string {
	// 成功分支直接返回固定英文文案；此判断也把失败联合排除。
	if (page.ok) return "Authorization complete. You may close this window.";
	// 失败分支才可读message/details，三元只在details真值时拼接；没有HTML转义，因为默认回应声明纯文本。
	return page.details ? `${page.message}\n\n${page.details}` : page.message;
}

// 管理一个已监听的Node服务及多份按state分开的等待；private构造器引导TS调用方使用static listen，不等于运行时#私有或浏览器服务自动启动。
export class OAuthCallbackServer {
	// 主回调URL只读字符串，readonly限制TS赋值，不负责实际绑定/权限控制。
	readonly redirectUrl: string;
	// 内部Node HTTP服务引用，真正监听与关闭由其API完成。
	private server: Server;
	// 允许回调的pathname列表，精确includes比较，不按前缀放行子路径。
	private paths: string[];
	// 为每次wait建立计时器的毫秒参数，不记录统一全局截止时间。
	private timeoutMs: number;
	// 可选HTML渲染器引用，缺省走plainText；函数可抛错，这里没有统一catch。
	private renderPage: ((page: OAuthCallbackPage) => string) | undefined;
	// Map保存每个state对应的Promise结算器/计时器/可选路径，new Map初始为空；不是持久化状态store。
	private pending = new Map<
		// Map键是原state字符串，大小写和空白都按原文字比较。
		string,
		// Map值的内联对象类型，以下字段一起代表一份待处理回调。
		{
			// 成功结算函数接收OAuthCallback，本身不验证code内容。
			resolve: (callback: OAuthCallback) => void;
			// 失败结算函数接收Error，让调用者的Promise拒绝；调用者仍须处理拒绝。
			reject: (error: Error) => void;
			// ReturnType<typeof setTimeout>提取当前环境计时器返回类型，在Node通常是Timeout对象，不硬写成浏览器数字ID。
			timer: ReturnType<typeof setTimeout>;
			// 字段位置必有，但值可undefined；undefined不额外限制本次路径，仍须在paths允许列表中。
			path: string | undefined;
		}
	>();

	// 内部构造器输入已创建server/URL/允许路径/时限/渲染器，保存引用后返回实例；例：listen绑定成功才构造。此处不启动监听/计时，也不克隆或校验这些参数。
	private constructor(
		// 服务实例交给close使用，不在构造器中调用listen。
		server: Server,
		// 主回调URL既公开给宿主，也作为解析相对request.url的base。
		redirectUrl: string,
		// 路径数组按引用保存，不过正常listen路径会先创建新数组。
		paths: string[],
		// 记录每个等待的超时参数。
		timeoutMs: number,
		// 渲染函数或undefined直接传入，不包装异常。
		renderPage: ((page: OAuthCallbackPage) => string) | undefined,
	) {
		// 显式给普通TS private字段赋值，不是参数属性语法。
		this.server = server;
		// 保存公开回调地址字符串。
		this.redirectUrl = redirectUrl;
		// 保存允许入口的原数组引用。
		this.paths = paths;
		// 保存超时配置，不立即启动倒计时。
		this.timeoutMs = timeoutMs;
		// 保存HTML渲染器，稍后reply才调用。
		this.renderPage = renderPage;
	}

	// 静态异步工厂：输入可省选项，创建HTTP服务、等待绑定、取得实际端口，再构造并返回实例。例：默认生成http://127.0.0.1:系统端口/callback；会真实监听，绑定/构造失败可拒绝，不自动开浏览器，也没有通用失败后的关闭finally。
	static async listen(options: OAuthCallbackServerOptions = {}): Promise<OAuthCallbackServer> {
		// ??只缺省null/undefined才用127.0.0.1，显式其他主机原样交Node。
		const host = options.host ?? "127.0.0.1";
		// 展示用主机优先配置，否则用绑定host，不对它单独监听。
		const redirectHost = options.redirectHost ?? host;
		// 主路径缺省/callback，空字符串若传入则保留，不自动补斜杠。
		const path = options.path ?? "/callback";
		// 先声明可选实例，供创建服务时的请求闭包稍后引用。
		let instance: OAuthCallbackServer | undefined;
		// 创建服务并登记请求监听器，不是这行就监听；instance尚未赋值时?.跳过handle也不回应。request.url缺省才用/，处理器只传URL/response，未传method供后续检查。
		const server = createServer((request, response) => instance?.handle(request.url ?? "/", response));
		// Promise<void>把Node监听回调/错误事件接到await，成功不携带业务值。
		await new Promise<void>((resolve, reject) => {
			// 临时一次error监听器让绑定错误拒绝；listen同步抛错也由Promise执行器捕获。
			server.once("error", reject);
			// port缺省0让系统分配，绑定host后成功才调用箭头回调；这一步有真实端口副作用。
			server.listen(options.port ?? 0, host, () => {
				// 绑定成功后移除此临时error拒绝器，不代表以后所有server错误都有本类处理器。
				server.off("error", reject);
				// 兑现监听Promise，后续await才继续构造公开实例。
				resolve();
			});
		});
		// 查询实际绑定地址，TCP返回含port的对象；没监听/关闭后可null，IPC可字符串。
		const address = server.address();
		// 只接受非空非字符串地址作为TCP，失败抛Error；这里没有catch自动关已创建server。
		if (!address || typeof address === "string") throw new Error("OAuth callback server did not bind to TCP");
		// 绑定完成后才创建包装实例，并让闭包从此能转交请求。
		instance = new OAuthCallbackServer(
			// 传同一已绑定HTTP服务，不新建第二个。
			server,
			// 拼HTTP回调文本，主机含冒号就额外包方括号供IPv6使用；不是通用主机校验/去重括号工具，port用实际分配值，path原样拼接。
			`http://${redirectHost.includes(":") ? `[${redirectHost}]` : redirectHost}:${address.port}${path}`,
			// 新建允许路径数组，主路径在前，再展开额外路径；不去重/规范化或保证其和每次期望路径一致。
			[path, ...(options.extraPaths ?? [])],
			// 默认5*60000即300000毫秒；数字分隔符_只改善可读性，没有校验负数/非有限数等，setTimeout仍按Node规则处理。
			options.timeoutMs ?? 5 * 60_000,
			// 传原渲染器引用，不调用它。
			options.renderPage,
		);
		// 返回已包装的实例，宿主稍后登记state等待并负责关闭。
		return instance;
	}

	/**
	 * Wait for the authorization response with `state`. With `path`, a response on another path fails, so
	 * a server-specific redirect URI can tell authorization servers apart (RFC 9700 section 4.4.2.2).
	 */
	// 按state登记等待，输入state与可选期望路径，返回回调Promise。例：waitForCallback(s,"/callback/id")只接受该state且路径正确的结果；重复待等state在返回Promise前同步throw。登记才开始计时，成功/错误/超时都移除记录；没有已关闭标记，close后再调用也能新建等待。
	waitForCallback(state: string, path?: string): Promise<OAuthCallback> {
		// 已有相同键直接同步抛Error；这个方法不是async，所以调用者不能假定所有失败都是Promise拒绝。
		if (this.pending.has(state)) throw new Error("OAuth state is already pending");
		// 新Promise执行器同步登记计时器/Map，resolve/reject保存在下面记录里。
		return new Promise((resolve, reject) => {
			// setTimeout到期才执行回调，不是同步阻塞等待；没unref，正常Node计时器可维持进程存活。
			const timer = setTimeout(() => {
				// 超时先移除对应state，不因此停止HTTP监听或其他state等待。
				this.pending.delete(state);
				// 再以固定Error拒绝这份Promise，不合成回调结果。
				reject(new Error("OAuth callback timed out"));
				// 每份等待使用同一个配置时长，各自在登记时开始，不共用一次总倒计时。
			}, this.timeoutMs);
			// Map.set保存这次Promise的结算器/计时器/原path；path即使不在允许列表也不提前报错，可能一直等到超时。
			this.pending.set(state, { resolve, reject, timer, path });
		});
	}

	// 关闭服务并拒绝所有当前待等回调，无业务返回Promise；例：取消登录后close让等待者收到server closed。先清本地等待再await Node关闭，可能等待活跃连接结束；无关闭标记/共享Promise，重复close是否拒绝由Node状态决定，也不阻止未来waitForCallback。
	async close(): Promise<void> {
		// 遍历当前Map的value，每个等待分别清理，不发浏览器页面或远端撤销。
		for (const pending of this.pending.values()) {
			// 清对应计时器，避免close后再触发超时报错。
			clearTimeout(pending.timer);
			// 拒绝待等Promise，调用者仍需catch；这里没有await其处理逻辑。
			pending.reject(new Error("OAuth callback server closed"));
		}
		// 清所有Map记录，不保留已经结束的state防重放历史集合。
		this.pending.clear();
		// 另建Promise等待HTTP server.close的完成回调。
		await new Promise<void>((resolve, reject) => {
			// 调用Node close停止接新连接并等待其关闭完成，回调有error则拒绝（如已不监听）；不调用closeAllConnections强制摧毁所有连接。
			this.server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	// 写一份浏览器响应，输入response/HTTP状态/页面结果，无返回值；例：有renderPage时返回HTML并no-store，默认只纯文本。写头/渲染/结束响应都可能同步抛错，没有统一捕获或保证客户端已收完。
	private reply(response: ServerResponse, status: number, page: OAuthCallbackPage): void {
		// 渲染器真值时走HTML分支，函数在写头之后调用。
		if (this.renderPage) {
			// HTML分支写状态、UTF-8类型及no-store，和下面纯文本分支的头不完全相同。
			response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			// 同步生成HTML后end；不自动HTML转义，渲染器抛错时可能已写头而没有end。
			response.end(this.renderPage(page));
			// 没自定义渲染器才用默认纯文案。
		} else {
			// writeHead返回同一response所以能链end，默认分支没设置cache-control；end是结束写入，不等于等待浏览器读取确认。
			response.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(plainText(page));
		}
	}

	// 处理一次原始请求URL，输入URL文字和response，无返回值：先允许路径→state→消费等待→本次路径→OAuth error/code，再结算并回应。例：已登记s的/callback?state=s&code=c成功；坏state不消费其他等待。只核pathname/查询，不检查请求方法、origin/Host或code/iss真实性，URL解析/渲染错误可同步逸出Node监听器。
	private handle(rawUrl: string, response: ServerResponse): void {
		// 用主redirectUrl解析相对请求URL，绝对URL也能解析；URL会按其规则规范路径，未额外比较origin。
		const url = new URL(rawUrl, this.redirectUrl);
		// pathname必须精确出现在允许数组；查询不参与入口比较，编码路径不主动decode成另一种文字。
		if (!this.paths.includes(url.pathname)) {
			// 不允许路径回404页面，不触碰pending，因此即使带已知state也继续等待。
			this.reply(response, 404, { ok: false, message: "Not found" });
			// 提前结束本次处理，避免进入state消费。
			return;
		}
		// get取首个state查询值，没有时null，重复参数不逐一检查。
		const state = url.searchParams.get("state");
		// 只有真值state才查Map，空串即使被wait登记也不会被这里接受。
		const pending = state ? this.pending.get(state) : undefined;
		// 没真值state或无相应pending都拒绝此请求，可能是未知/已过期/已消费，不区分具体原因。
		if (!state || !pending) {
			// 回400失败页，不在此终止任何其他合法等待。
			this.reply(response, 400, { ok: false, message: "Invalid or expired OAuth state" });
			// 返回保持未命中的Map/计时器不变。
			return;
		}
		// 找到合法pending后立刻清timer，后面路径/错误/缺code失败都不再等待重试。
		clearTimeout(pending.timer);
		// 消费state记录在内容验证之前，后续相同state无新登记时只能得到400。
		this.pending.delete(state);
		// 本次传path不是undefined就精确比pathname；只有已在允许入口列表中的其他路径才会到此分支，空path也会参与比较。
		if (pending.path !== undefined && url.pathname !== pending.path) {
			// 路径不符则拒绝这份Promise，即使code存在也不用；state/timer此前已经移除。
			pending.reject(new Error("The authorization response arrived on another redirect URI"));
			// 回400路径错误页，页面说明不暴露预期路径细节。
			this.reply(response, 400, { ok: false, message: "Unexpected redirect URI" });
			// 返回不继续检查OAuth错误或code。
			return;
		}
		// 读取首个error参数，不在此枚举标准OAuth错误码。
		const error = url.searchParams.get("error");
		// 只要error真值就优先处理，哪怕同URL也带code；空error会继续往code分支。
		if (error) {
			// description缺省null才回退error，显式空description保留空串，和plainText的details真值判断不同。
			const description = url.searchParams.get("error_description") ?? error;
			// 拒绝等待者，Error.message用原description，不验证/脱敏这些服务器文字。
			pending.reject(new Error(description));
			// OAuth失败也回HTTP200页面，HTTP200不表示授权成功，结果看ok:false及等待Promise拒绝。
			this.reply(response, 200, {
				// 传标签false使渲染器进入失败分支。
				ok: false,
				// 固定失败主文案，不把查询error码直接当主标题。
				message: "Authorization failed. You may close this window.",
				// 原description作为details交渲染器，宿主HTML渲染器应负责转义。
				details: description,
			});
			// 错误回应完成后返回，不检查/接受同一URL里的code。
			return;
		}
		// 没有真值error才取首个授权码参数。
		const code = url.searchParams.get("code");
		// code缺省或空串都不接受，空白串仍真值，不在这里去空白或验证授权码。
		if (!code) {
			// 缺code拒绝原等待，此时state已消费，不再等待浏览器补码。
			pending.reject(new Error("OAuth callback did not include an authorization code"));
			// 回400缺码页。
			this.reply(response, 400, { ok: false, message: "Missing authorization code" });
			// 返回不执行成功结算。
			return;
		}
		// 取iss原文字，没有时null；不在此与发现文档issuer比较。
		const iss = url.searchParams.get("iss");
		// resolve以code/state和真值iss的新对象结算；先结算再发页面，后面的reply若抛错不会把已兑现Promise改为拒绝。
		pending.resolve({ code, state, ...(iss ? { iss } : {}) });
		// 最后回HTTP200成功页，没有把code/state/token写入默认页面。
		this.reply(response, 200, { ok: true });
	}
}
