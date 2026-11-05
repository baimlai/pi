// Node端OAuth回调共用设施；各flow提供端口/state和兑换动作，宿主负责展示授权URL及最终关闭服务。
/**
 * Loopback OAuth redirect handler shared by the browser sign-in flows.
 *
 * NOTE: This module uses node:http. It is only reachable through the lazily
 * loaded OAuth flow modules, never from browser-facing entry points.
 */

// createServer是运行时函数，ServerResponse仅为类型；此模块本身需要Node HTTP能力。
import { createServer, type ServerResponse } from "node:http";
// 页面生成器会转义动态文字再嵌入固定HTML，发送响应在本模块。
import { oauthErrorHtml, oauthSuccessHtml } from "../../utils/oauth-page.ts";
// 规范交互保证有总登录signal，但单独prompt还有自己的取消信号。
import type { ProviderAuthInteraction } from "../types.ts";

// T把complete成功值、wait结果和flow需要的类型关联起来。
export interface OAuthCallbackServerOptions<T> {
	/** Provider name used on the browser page, for example `OpenAI`. */
	// 用于成功/失败页面的供应商展示名。
	providerName: string;
	/** Address to listen on. */
	// 实际绑定地址，调用方通常传127.0.0.1，接口本身允许其他主机。
	host: string;
	/** Port to listen on; `0` picks a free port. */
	// 监听端口，0表示让系统选择；不是所有flow都允许自动换端口。
	port: number;
	// 唯一接受回调的URL路径，必须精确匹配pathname。
	path: string;
	/** Host in `redirectUri` when it differs from `host`, for example `localhost`. */
	// 展示给授权服务的主机名可不同于监听地址，如监听127.0.0.1而redirect用localhost。
	redirectHost?: string;
	/** Expected `state` parameter. Omit when the provider does not send one. */
	// 有值时严格比较state，缺省则不做state匹配；没有自动增加其他域名验证。
	state?: string;
	/**
	 * Finishes the sign-in with the received code before the browser page is sent, so the page can
	 * show exchange failures. Pass `async (code) => code` to exchange the code later.
	 */
	// 收到有效code后先执行的异步动作；返回值成为wait的T，失败会展示错误页。
	complete: (code: string) => Promise<T>;
	// 可选总取消信号，约束等待结算，不自动转交complete。
	signal?: AbortSignal;
	// 可选等待超时毫秒，未传则不安装该计时器。
	timeoutMs?: number;
}

// 已启动服务的操作外观，接口不等于服务已经兑换成功。
export interface OAuthCallbackServer<T> {
	// 含实际端口的HTTP回调URL，供授权请求redirect参数使用。
	redirectUri: string;
	/**
	 * Resolves with the result of `complete`, or `undefined` after `cancel()`. Rejects when the provider
	 * redirects with an error, `complete` fails, the signal aborts, or the timeout elapses.
	 */
	// 只取得同一个等待Promise，undefined仅表示未认领时cancel成功等无值结果。
	wait(): Promise<T | undefined>;
	/** Stop waiting for the browser unless a callback is already being completed. */
	// 只取消尚未claimed的等待，不关闭监听；具体实现见返回对象。
	cancel(): void;
	// 关闭服务并使未结算等待失败，调用方应在finally执行。
	close(): void;
}

/**
 * 给单次HTTP响应写状态、HTML类型和禁止缓存头，再发送页面正文，无返回。
 * 输入Node响应对象与已生成HTML，不在这里转义页面或结算登录；例：无效state返回400及错误页，登录仍可继续等正确回调。
 */
function sendPage(response: ServerResponse, status: number, html: string): void {
	// 设置HTML编码及no-store响应头，写状态不代表授权成功。
	response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	// 发送正文并结束本次HTTP响应，不结束整个server。
	response.end(html);
}

/**
 * 绑定本地HTTP回调服务，输入地址/路径/state/兑换函数等，异步返回redirectUri及等待/取消/关闭接口。
 * 检查GET和路径→可选state→是否重复→错误/授权码→有效code认领→await complete→发页面并结算；监听失败拒绝，端口0由系统选空闲端口。
 * 例：complete异步兑换失败会让浏览器看502，wait也拒绝；complete可只返回code，把兑换留到flow下一步。
 * timeout/abort只结算等待，不自动关闭服务或强制终止已运行complete；宿主应finally close。任意host参数不会在此强制限制为loopback。
 */
export async function startOAuthCallbackServer<T>(
	// 泛型配置约束complete与最终wait的数据形状，不执行运行时schema检查。
	options: OAuthCallbackServerOptions<T>,
	// await监听完成才交出服务外观，端口占用等错误使这个Promise拒绝。
): Promise<OAuthCallbackServer<T>> {
	// 解构展示名和外部信号，其他配置仍从options读取。
	const { providerName, signal } = options;
	// 启动之前已取消就拒绝，不绑定端口。
	if (signal?.aborted) throw new Error("Login cancelled");

	// 先给resolve一个占位函数，Promise构造器同步执行时再换成真实结算器。
	let resolveWait: (value: T | undefined) => void = () => {};
	// reject同样保存到外层闭包，回调请求到来时才使用。
	let rejectWait: (error: Error) => void = () => {};
	// 构造一次共享等待Promise；T可为凭证对象或简单授权码。
	const waitPromise = new Promise<T | undefined>((resolve, reject) => {
		// 捕获Promise提供的真实成功结算函数。
		resolveWait = resolve;
		// 捕获失败结算函数，后面不另建第二个登录Promise。
		rejectWait = reject;
	});
	// A cancelled or closed wait may never be observed.
	// 提前附拒绝观察，避免取消/close后无人调用wait导致未处理拒绝；原waitPromise仍会拒绝。
	waitPromise.catch(() => undefined);

	// claimed表示已有有效code进入complete，即使尚未结算也不允许第二个兑换。
	let claimed = false;
	// settled表示wait已成功/失败/取消结算，与claimed分开记录。
	let settled = false;
	// ReturnType复用平台setTimeout句柄类型，可尚未创建计时器。
	let timer: ReturnType<typeof setTimeout> | undefined;
	// 外部取消回调只调用finish，不在此server.close或取消complete。
	const onAbort = () => finish({ error: new Error("Login cancelled") });
	/**
	 * 结算本次登录等待一次，输入成功value或Error，清理计时与信号监听，无返回。
	 * 例：兑换结束后调用finish({value})，之后重复回调不能改Promise结果；它不关闭HTTP服务器，也不取消complete自己的异步工作。
	 */
	const finish = (result: { value: T | undefined } | { error: Error }): void => {
		// Promise及清理逻辑只结算一次，迟到的结果不能覆盖旧结果。
		if (settled) return;
		// 先标记完成，避免后面清理/回调重入再次结算。
		settled = true;
		// 存在计时器才清除，取消/成功后不再触发超时。
		if (timer) clearTimeout(timer);
		// 完成后解除总取消监听，不保留多余闭包。
		signal?.removeEventListener("abort", onAbort);
		// 用in区分错误联合分支，TS此时允许读取error。
		if ("error" in result) rejectWait(result.error);
		// 成功联合携带value，也可以是明确undefined取消结果。
		else resolveWait(result.value);
	};

	// 创建HTTP请求回调，每次访问都取得独立request/response。
	const server = createServer((request, response) => {
		// 立即启动async请求处理；void不把Promise错误自动吞掉，只有下面明确try里的失败被处理。
		void (async () => {
			// 相对请求地址以固定localhost基址解析，只用于读path/query，不是远端网络请求。
			const url = new URL(request.url ?? "/", "http://localhost");
			// 只接受GET且pathname精确匹配，其他路径不参与授权。
			if (request.method !== "GET" || url.pathname !== options.path) {
				// 返回404错误页，但不使wait失败，允许随后正确请求。
				sendPage(response, 404, oauthErrorHtml("Callback route not found."));
				// 结束这次请求处理，服务器仍监听。
				return;
			}
			// 只在调用者配置state时验证；查询缺值null也与具体state不同。
			if (options.state !== undefined && url.searchParams.get("state") !== options.state) {
				// 错误state给400，不认领本次授权。
				sendPage(response, 400, oauthErrorHtml("State mismatch."));
				// 返回后可继续等正确state的请求。
				return;
			}
			// 已经进入兑换或已经结算都不再受理第二个回调。
			if (claimed || settled) {
				// 409报告重复处理，不启动新的complete。
				sendPage(response, 409, oauthErrorHtml("This sign-in has already been handled."));
				// 终止本次重复请求处理。
				return;
			}
			// 授权服务可能通过error参数返回拒绝等状态。
			const error = url.searchParams.get("error");
			// 非空error表示授权失败，不再要求有code。
			if (error) {
				// 描述缺省时用error码；??会保留显式空描述。
				const description = url.searchParams.get("error_description") ?? error;
				// 发送可读错误页；HTML辅助函数会转义动态providerName/description。
				sendPage(response, 400, oauthErrorHtml(`${providerName} authorization failed.`, description));
				// wait也以同一业务原因失败，不只给浏览器显示错误。
				finish({ error: new Error(`${providerName} authorization failed: ${description}`) });
				// 已处理错误后不进入code逻辑。
				return;
			}
			// 取得查询授权码文字，没有在此解码token或验证远端授权。
			const code = url.searchParams.get("code");
			// 空/缺code都不够启动兑换。
			if (!code) {
				// 给400并继续允许以后正确code请求，不结算wait。
				sendPage(response, 400, oauthErrorHtml("Missing authorization code."));
				// 结束本次缺码请求。
				return;
			}
			// 在await兑换前认领，避免并发HTTP回调重复调用complete。
			claimed = true;
			// 只有完成兑换/发成功页附近这段明确捕获异常。
			try {
				// 等待调用方动作；可为token兑换，也可仅把code原样返回。
				const value = await options.complete(code);
				// 动作成功后才显示200成功页；该页不等同宿主已持久保存凭证。
				sendPage(response, 200, oauthSuccessHtml(`Signed in to ${providerName}. You may now close this page.`));
				// 尝试用value结算wait，若已因取消/超时结算则保持旧结果。
				finish({ value });
				// complete或此try内步骤失败进入页面/等待失败路径。
			} catch (error) {
				// 外部可抛非Error，统一转成Error以读取message。
				const failure = error instanceof Error ? error : new Error(String(error));
				// 失败页用502区分于参数错误400，服务端详情先由页面helper转义。
				sendPage(response, 502, oauthErrorHtml(`${providerName} sign-in failed.`, failure.message));
				// 令wait失败；不自动重新兑换同一code。
				finish({ error: failure });
			}
		})();
	});

	// 等待TCP监听实际建立，bind错误使启动拒绝。
	await new Promise<void>((resolve, reject) => {
		// 仅观察启动阶段的第一个error事件。
		server.once("error", reject);
		// 按配置端口/主机监听，成功回调后才继续构造redirectUri。
		server.listen(options.port, options.host, () => {
			// 成功绑定后移除启动reject监听，后续另设运行期错误处理。
			server.off("error", reject);
			// 只表示监听已建立，不表示OAuth已授权。
			resolve();
		});
	});
	// 读取系统分配的真实地址，port=0时尤其需要它。
	const address = server.address();
	// Node地址也可能为字符串/缺省，运行边界确认TCP地址再取port。
	if (!address || typeof address === "string") {
		// 非TCP结果先请求关闭，避免留一个不适用监听。
		server.close();
		// 启动失败明确拒绝，不返回假redirectUri。
		throw new Error("OAuth callback server did not bind to TCP");
	}

	// 运行阶段server错误令wait失败，不再拒绝已经完成的启动Promise。
	server.on("error", (error) => finish({ error }));
	// 监听建立后才安装外部取消事件；代码没有在此再做第二次aborted检查，不概括为封闭所有绑定期间取消竞态。
	signal?.addEventListener("abort", onAbort, { once: true });
	// 只在timeoutMs明确存在时安装计时器，0也会进入。
	if (options.timeoutMs !== undefined) {
		// 计时到期仅finish错误，端口清理仍由调用者close负责。
		timer = setTimeout(() => finish({ error: new Error(`${providerName} sign-in timed out`) }), options.timeoutMs);
	}
	// 展示主机优先可选redirectHost，否则用实际监听host；??保留空字符串。
	const redirectHost = options.redirectHost ?? options.host;
	// 返回围绕同一server/Promise的操作外观。
	return {
		// 主机含冒号时加IPv6方括号，再用实际端口与配置path拼HTTP URL。
		redirectUri: `http://${redirectHost.includes(":") ? `[${redirectHost}]` : redirectHost}:${address.port}${options.path}`,
		// 每次wait调用拿到同一Promise，不重新监听或兑换。
		wait: () => waitPromise,
		/**
		 * 取消尚未认领的浏览器等待，wait成功返回undefined，不停止已认领的兑换。
		 * 例：用户贴码先完成且浏览器还没发有效code时让手工路径接管；已claimed则继续等兑换结果，不是无条件最快者获胜。
		 */
		cancel: () => {
			// 只有尚未认领时才能用undefined成功结算，已开始的complete继续掌握结果。
			if (!claimed) finish({ value: undefined });
		},
		/**
		 * 结算未完成等待为关闭错误，并请求HTTP服务器停止接受新连接，无返回。
		 * 若此前已成功/取消，finish不改旧结果；server.close不在此await所有活动连接结束，也不强制终止兑换回调。
		 */
		close: () => {
			// 未结算时以关闭错误终止等待，已settled则无效。
			finish({ error: new Error("OAuth callback server closed") });
			// 停止接受新连接的请求；不await连接全部关闭，不使用closeAllConnections。
			server.close();
		},
	};
}

/**
 * Wait for the browser callback, or for the user to paste the code or redirect URL when the browser
 * cannot reach the loopback server (for example over SSH). Without a callback server only the manual
 * prompt is used.
 */
/**
 * 同时启动手动输入并等待可选回调服务，返回带callback/manual标签的结果；协调等待阶段失败传播，finally取消手动提示。
 * 输入交互、可缺省服务及提示文案；手动完成会请求callback.cancel，未claimed时让服务wait返回undefined，已claimed则仍等complete。
 * 例：SSH贴完整URL得到manual原文字，浏览器有效回调已被处理则优先返回它的T；此helper不解析授权码，也不自行关闭callback服务器。
 * 没有服务只等手动输入；手动Promise错误经记录后传播。prompt若同步抛错发生在try之前；交互实现需遵守取消契约，这里不强制终止非合作UI。
 */
export async function waitForCallbackOrManualInput<T>(
	// 宿主prompt/notify与总信号由flow提供，本函数只给手工提示另装一个signal。
	interaction: ProviderAuthInteraction,
	// 服务可不存在，此时直接靠手工输入完成。
	callback: OAuthCallbackServer<T> | undefined,
	// 展示文字和占位URL，不在这个形状里接受任意交互类型。
	prompt: { message: string; placeholder: string },
	// 返回可分辨联合，callback.value是T，manual.input仍是未解析文字。
): Promise<{ type: "callback"; value: T } | { type: "manual"; input: string }> {
	// 独立控制手工提示寿命，不代表取消整个登录流程。
	const manualAbort = new AbortController();
	// 记录手工失败，避免把错误当undefined正常输入。
	let manualError: Error | undefined;
	// 现在就启动prompt，之后才等callback，不是先等浏览器失败再询问。
	const manual = interaction
		// 构造manual_code提示；此处只传manualAbort，整体取消还依赖宿主交互契约/flow信号处理。
		.prompt({ type: "manual_code", ...prompt, signal: manualAbort.signal })
		// 用户给出文字时执行这一成功回调。
		.then((input) => {
			// 尝试停止未claimed的浏览器等待，已经claimed则取消无效。
			callback?.cancel();
			// 保留用户原输入，授权码/URL解析由各flow完成。
			return input;
		})
		// 把手工提示的拒绝变成可检查状态，保证该Promise被观察。
		.catch((error: unknown) => {
			// 统一外部抛出值为Error，稍后按顺序抛出。
			manualError = error instanceof Error ? error : new Error(String(error));
			// 手工失败也尝试解除未认领浏览器等待，避免无意义继续等。
			callback?.cancel();
			// 此catch的undefined只是内部占位，不等同最后成功返回manual空串。
			return undefined;
		});
	// 进入协调等待阶段后，无论哪条路径成功失败都在finally取消手工提示；前面prompt同步抛错不在这个try里。
	try {
		// 先等callback.wait；无服务时可选调用产生undefined，await立即继续。
		const value = await callback?.wait();
		// 浏览器结束时已记录手工错误则优先抛它，不把它吞成成功。
		if (manualError) throw manualError;
		// 非undefined回调结果被采用；T本身若使用undefined则无法在此当作有值回调成功。
		if (value !== undefined) return { type: "callback", value };
		// 无回调结果时再等待已启动的manual Promise。
		const input = await manual;
		// 手工完成后再检查其记录的异常。
		if (manualError) throw manualError;
		// 成功以manual标签返回输入，内部缺省才回退空串。
		return { type: "manual", input: input ?? "" };
		// finally在callback拒绝、manual拒绝或成功时都运行。
	} finally {
		// 通知UI结束手工提示，不在此关闭callback服务器。
		manualAbort.abort();
	}
}
