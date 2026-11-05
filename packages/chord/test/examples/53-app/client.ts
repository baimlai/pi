// 文件导读
// 所属：packages/chord/test/examples/53-app，示例 53、54、55 共用的最小 HTTP 客户端。
// 作用：代替浏览器与命令行客户端，向回环地址上的 notes 服务器发一次请求，返回状态码、Set-Cookie
// （只保留 name=value）和 JSON 或文本响应体。
// 上游：main.ts 的登录、会话、笔记请求都用 call；54 的配对流程、55 的导出流程也一样。
// 下游：Node 内建 node:http 的 request；不使用 fetch，因为示例要直接观察 Set-Cookie 响应头。
// 能力清单：
// - Answer：一次响应的形状（status/cookie/body）；
// - call：按方法、路径、请求头和 JSON 体发请求。
// 典型调用（示例）：
//   const answer = await call(app.port, "GET", "/", { authorization: `Bearer ${token}` });
//   console.log(answer.status, answer.body);
// 阅读顺序：先看 Answer 的三个字段，再看 call 的请求选项和 end 回调。
// 运行方式：不单独运行；由示例入口 import。
// 限制（有意保持简单）：不跟随重定向、不维护 cookie jar、不处理 HTTPS；请求错误只会以连接级错误拒绝，
// 业务状态码（如 401/403）正常 resolve，由调用方检查 Answer.status。
//
// A small HTTP client for examples 53 to 55, standing in for a browser and a command-line client: a request to the
// app on loopback, its status, `Set-Cookie` and JSON body.

import { request } from "node:http";

// 类型别名：status 是 HTTP 状态码；cookie 可能不存在（不是每个响应都 Set-Cookie），所以是 string | undefined；
// body 的静态类型只能是 unknown，因为响应内容要到运行时按 content-type 解析。
/** An answer: status, the cookie it set (name=value), JSON body (or text). */
export type Answer = { readonly status: number; readonly cookie: string | undefined; readonly body: unknown };

// 函数说明：call 向 127.0.0.1:port 发一个 HTTP 请求。
// 输入：port 端口；method 方法（GET/POST…）；path 以 / 开头的路径；headers 请求头（默认空）；body 可选，
// 存在时按 JSON 序列化并自动加 content-type。
// 输出：Promise<Answer>；连接错误时 reject。
// 副作用：建立 TCP 连接、发送请求。错误：底层请求的 "error" 事件会 reject；不自动处理非 2xx。
// 流程：构造 request → 在响应回调里收集 Buffer → 拼接并按 content-type 解析 → resolve。
// 示例：await call(port, "POST", "/_chord/owner", {}, { token }) 返回 { status: 200, cookie: "chord=…", body: … }。
// 说明：body 参数是 unknown，所以调用方传错结构不会被 TypeScript 拦下；服务器仍会按自己的 schema 校验。
/** `method path` on the app at `port`, with `headers` and a JSON `body`. */
export function call(
	port: number,
	method: string,
	path: string,
	headers: Readonly<Record<string, string>> = {},
	body?: unknown,
): Promise<Answer> {
	// new Promise 的执行器同步运行；网络回调在稍后的事件循环中被调用。
	return new Promise((resolve, reject) => {
		// request 返回 ClientRequest；第二个参数是响应到达时的回调（此时只有响应头）。
		const sent = request(
			{
				// 回环地址：示例只面向本机临时服务器。
				host: "127.0.0.1",
				port,
				method,
				path,
				// 先展开调用方的 headers，再按需补 content-type；对象展开从左到右，后者覆盖同名键。
				// `body === undefined ? {} : {...}` 的三元表达式保证 GET 请求不会被误加 content-type。
				headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
			},
			(response) => {
				// 响应体可能分多个 chunk；Buffer[] 收集后一次性拼接（示例响应都很小）。
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				// "end" 表示响应体读完；这里才解析并 resolve。
				response.on("end", () => {
					// Buffer.concat 合并分片后按 UTF-8 解码；toString() 默认就是 utf8。
					const text = Buffer.concat(chunks).toString();
					// content-type 头在类型上是 string | undefined，`?? ""` 提供运行时兜底。
					const type = response.headers["content-type"] ?? "";
					// set-cookie 在 Node 类型里是 string[] | undefined；只取第一条（服务器只设置一个 cookie），
					// split(";")[0] 去掉 Path/HttpOnly 等属性，只留 name=value。
					const cookie = response.headers["set-cookie"]?.[0]?.split(";")[0];
					resolve({
						// statusCode 类型为 number | undefined；正常情况下总有值，`?? 0` 只是类型兜底。
						status: response.statusCode ?? 0,
						cookie,
						// 文本响应（例如 owner 登录页 HTML）原样返回；JSON 响应才解析。
						// 注意：JSON.parse 抛错发生在事件回调里，不会被 Promise 捕获为 reject。
						body: type.includes("json") ? JSON.parse(text) : text,
					});
				});
			},
		);
		// 连接失败、DNS 错误等由请求对象发出 "error"；转成 Promise 拒绝。
		sent.on("error", reject);
		// 发送请求体：没有 body 时 end() 不带数据；有 body 时写 JSON 文本，相关请求头由 Node 补齐。
		sent.end(body === undefined ? undefined : JSON.stringify(body));
	});
}
