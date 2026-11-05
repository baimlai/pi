// The launcher's credentials (slice 11 §4, decision "The app kit, point 3" (c)): a device token the launcher keeps,
// never the sandbox. It is given, read from a token file (the owner token file on the server's machine, slice 13), or
// got by device pairing: the launcher asks for a code, shows it, and polls until the owner approved it in a browser;
// a paired token may be saved to a file (mode 0600) for the next start.
//
// 文件导读
// 所属：packages/chord 的 Node 终端启动器模块（node/tui），是 launcher 的凭据子模块。
// 职责边界：只解决“启动终端客户端时，从哪里拿到访问服务器的 token”，不负责保存会话、不负责后续请求签名，
// 也不把 token 交给沙箱。上游是 launcher.ts 的 startTerminal；下游是服务器 app kit 的配对 HTTP 路由
// （`/_chord/pair`、`/_chord/pair/poll`）以及 app/secrets.ts 的安全写文件函数。成功结果是一段 token 字符串；
// 失败以 Promise 拒绝/throw 向上传播，由 startTerminal 的调用方处理。
// 能力清单：
// - TerminalCredentials：用 kind 区分的联合，描述 token 的直接值、文件路径或设备配对参数。
// - tokenOf：按凭据种类取得 token 的异步入口（三种来源互斥）。
// - pair（私有）：设备配对流程，申请设备码、展示、轮询、可选保存。
// - post（私有）：发送 JSON POST 的小型 fetch 封装。
// - POLL_MS：配对轮询间隔常量（2 秒）。
// 组合与顺序：tokenOf 用 switch 分派；pairing 分支进入 pair，pair 调 post 两次（申请与轮询），
// 批准后可选调用 writeSecret，最后返回 token。pair 的错误包括服务器拒绝、响应字段畸形、轮询失效和中止。
// 示例：`const token = await tokenOf({ kind: "file", path: "/home/u/.app/token" },
// new URL("http://127.0.0.1:8788"), console.log, signal);`
// 阅读顺序：先看 TerminalCredentials 与 tokenOf 的分支，再看 pair 的两次请求和轮询循环，最后看 post。
// 注意：这些网络请求会真实访问服务器，不是本地模拟；token 仅由受信任的启动器持有。

// 只导入需要的 fs/promises 函数；Node 内置模块在构建时被视为外部依赖。
import { readFile } from "node:fs/promises";
// writeSecret 以安全模式（如 0600）写文件，避免把 token 暴露给同机其他用户。
import { writeSecret } from "../app/secrets.ts";

/** Where the launcher's token comes from. */
// 凭据的三种来源，用 `kind` 区分的可辨识联合（tagged union）：
// - token：调用方已经拿到明文 token；
// - file：从磁盘文件读取（通常是服务器机器上的 owner token 文件）；
// - pairing：本机尚未获得授权，向服务器发起设备配对。
// 这些都是只读字段（readonly），只约束 TypeScript 调用方，运行时不冻结对象。
// 例如 `{ kind: "file", path: "/home/u/.app/token" }` 表示启动时读该文件。
export type TerminalCredentials =
	| { readonly kind: "token"; readonly token: string }
	| { readonly kind: "file"; readonly path: string }
	/** Pairing with the server, the device named `label`; the token saved to `save` (created, mode 0600) when given. */
	| { readonly kind: "pairing"; readonly label: string; readonly save?: string };

/** How often a pairing is polled. */
// 轮询间隔：每 2 秒问一次服务器“用户批准了吗”，避免请求过密又保证体验及时。
const POLL_MS = 2000;

/** The launcher's token for the server at `url`; pairing shows its code through `say`. */
// 根据凭据取得 token 的主入口：输入凭据、服务器 URL、显示提示行的回调、取消信号；返回 token 文本。
// 副作用：file 模式读取文件；pairing 模式发出 HTTP 请求并可能写 token 文件，还会通过 `say` 向终端输出。
// 错误路径：读取文件失败会拒绝；配对被拒、响应格式异常或轮询失败都会抛出 Error；signal 中止时 fetch 拒绝。
// 例如 `tokenOf({ kind: "token", token: "abc" }, url, console.log, signal)` 直接得到 "abc"，不会联网。
// 真实运行时行为就是下面的 switch：三种来源互斥，不可能同时读文件和配对。
export async function tokenOf(
	credentials: TerminalCredentials,
	url: URL,
	say: (line: string) => void,
	signal: AbortSignal,
): Promise<string> {
	// switch 对 kind 做穷尽匹配：每个分支里 TypeScript 会自动把 credentials 收窄成对应成员。
	switch (credentials.kind) {
		case "token":
			// 调用方已给明文 token，原样返回。
			return credentials.token;
		case "file":
			// 读取整个文件为 UTF-8，并去掉首尾空白（文件末尾通常有换行）。
			// 这里没有做权限检查：文件的安全性由创建者（如 writeSecret）负责。
			return (await readFile(credentials.path, "utf8")).trim();
		case "pairing":
			// 交给下方的 pair：它会请求设备码、展示、轮询，直到批准。
			return pair(credentials, url, say, signal);
	}
}

/** Pairs this device: a code shown, the approval polled for, the token returned (and saved when asked). */
// 设备配对流程：输入配对凭据、服务器 URL、提示回调和取消信号；返回服务器签发的 token。
// 流程：POST 请求设备码 → 校验并显示 → 每 2 秒轮询 → 批准后可选保存 → 返回 token。
// 副作用：两个网络请求、终端输出、可能写本地文件。错误：拒绝配对、响应畸形、轮询结束或中止都会抛错。
// 例子（示意，不是实际输出）：say("Pairing code ABCD-1234: approve it at …") 后，用户批准，函数返回 "tok_…"。
async function pair(
	credentials: Extract<TerminalCredentials, { kind: "pairing" }>,
	url: URL,
	say: (line: string) => void,
	signal: AbortSignal,
): Promise<string> {
	// 第一步：POST 申请配对，请求体只有设备标签（label 会显示给批准的用户）。
	const asked = await post(new URL("/_chord/pair", url), { label: credentials.label }, signal);
	// HTTP 状态非 2xx 表示服务器不接受配对；此时不应继续展示任何码。
	if (!asked.ok) throw new Error(`terminal: the server refused to pair (${asked.status})`);
	// `as` 只是编译期断言，运行时 JSON 可能任意；下一行才做真正的字段和格式校验。
	const { code, poll } = (await asked.json()) as { readonly code?: unknown; readonly poll?: unknown };
	// A trust boundary: the server's answer is shown on the terminal and sent back.
	// 信任边界：响应来自网络。code 必须匹配安全字符集才能显示到终端（防止终端转义注入），
	// poll 必须是字符串；否则直接拒绝，不尝试“尽量使用”。
	if (typeof code !== "string" || !/^[A-Za-z0-9-]{4,32}$/.test(code) || typeof poll !== "string") {
		throw new Error("terminal: the server's pairing answer is malformed");
	}
	// 告诉用户去哪里批准；URL 由已知服务器地址拼接，code 已通过字符集校验。
	say(`Pairing code ${code}: approve it at ${new URL(`/_chord/pair/${code}`, url)} (signed in as the owner).`);
	// 无限循环：服务器端批准前一直等待；只通过 return 或 throw 结束。
	for (;;) {
		// 先等待轮询间隔；Promise 不持有取消能力，但随后的 throwIfAborted 会在中止时结束流程。
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		// 如果启动器已被要求停止（用户 Ctrl-C/关闭），立即以中止原因拒绝，不再发请求。
		signal.throwIfAborted();
		// 用第一步返回的 poll 句柄查询状态；句柄不是明文 token。
		const polled = await post(new URL("/_chord/pair/poll", url), { poll }, signal);
		// 轮询端点返回非 2xx 表示配对失效（过期或取消），停止等待。
		if (!polled.ok) throw new Error("terminal: the pairing ended without approval");
		// 同样先断言 shape，再逐字段判断；`status` 是字符串，`token` 可缺省。
		const answer = (await polled.json()) as { readonly status: string; readonly token?: string };
		// 尚未批准就继续下一轮；approved 但没有 token 属于服务端异常，也继续等待。
		if (answer.status !== "approved" || answer.token === undefined) continue;
		// 调用方要求保存时，以安全权限创建文件；下一次启动可以改用 file 凭据。
		if (credentials.save !== undefined) await writeSecret(credentials.save, answer.token, "create");
		// 返回服务器签发的 token，后续请求把它放进 Bearer 头。
		return answer.token;
	}
}

/** A JSON post. */
// 小型 HTTP 辅助：把 `body` 序列化为 JSON，POST 到 `url`，并绑定取消信号。
// 返回原始 Response，由调用方检查状态码；fetch 自身的网络错误会以拒绝形式传播。
// 例如 `post(url, { label: "laptop" }, signal)` 实际发送 content-type: application/json 的请求。
function post(url: URL, body: unknown, signal: AbortSignal): Promise<Response> {
	// method 与 headers 是请求配置；body 必须已经能被 JSON.stringify 处理。
	// signal 让外部中止时 fetch 立即拒绝（AbortError），从而停止等待网络。
	return fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
}
