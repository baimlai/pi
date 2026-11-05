// 文件导读
// 所属：packages/chord/test/examples/53-app/plugins/notes，notes 插件的 server facet。
// 作用：在服务器上贡献首页区块和两条笔记路由；路由通过远程契约 Notes 连到项目 worker，实际读写发生在
// worker 进程。路由没有 public 标记，未登录请求在进入处理器前被 kit 以 401 拒绝。
// 上游：同目录 package.json（name @notes/notes、private、type module）把 contract.ts/server.ts/worker.ts
// 归为同一个插件；发现器按 server.ts 构建服务器 facet。start.ts 的 root 指向这些插件。
// 下游：@notes/app/v1 的 Sections、@notes/app/v1/server 的 Http、./contract.ts 的 Notes。
// 能力清单：
// - Sections 贡献：{ title: "Notes", path: "/notes/:id" }；
// - GET /notes/:id：读取 worker 的状态 text 与 start；
// - POST /notes/:id：把请求体作为新文本写入。
// 典型请求（示例）：
//   GET /notes/p1  → {"text":"milk, eggs","start":"{\"project\":\"project|p1\"}"}
//   POST /notes/p1 (JSON 字符串 "new") → "saved"
// 阅读顺序：先看两个 self.contribute，再看 GET/POST 处理器如何经 ctx.get 取得远程对象。
// 运行方式：不单独运行；由 startServer 在 server 宿主中加载。
// 副作用：GET 触发项目 worker 首次启动；POST 修改 worker 的持久状态。两者都会产生跨主机调用。
//
// The notes plugin's server facet: routes reading and writing a project's notes, and its section of the home page.
// No route is public: the kit refuses anyone without a session (401) before they run.

// defineFacet 声明 facet；Sections 是首页区块注册表。
import { defineFacet, Sections } from "@notes/app/v1";
// Http 只在 server 构建可用。
import { Http } from "@notes/app/v1/server";
// 与 worker 共享的远程契约；两端 import 同一文件，name/version/schema 一致。
import { Notes } from "./contract.ts";

// 本 facet 不提供新对象，只贡献两个注册表，所以 host 参数用 _host。
export default defineFacet((_host, self) => {
	// 贡献首页区块：home 插件的 compose 会把它们拼成 "Notes: /notes/:id"。
	self.contribute(Sections, { title: "Notes", path: "/notes/:id" });
	// 贡献路由表；Http 由 kit 合并，服务器按方法和路径分发。
	self.contribute(Http, {
		routes: {
			// request.params 是路由模式匹配出的参数（已百分号解码）；ctx 是本请求的上下文。
			// ctx.get(Notes, {id}) 解析到 Project({id}) 的 worker，必要时启动它，并返回该对象的 Reference。
			"GET /notes/:id": async (request, ctx) => {
				// params.id 的静态类型是 string；`?? ""` 只是防御性兜底，匹配成功时 id 必然存在。
				const notes = await ctx.get(Notes, { id: request.params.id ?? "" });
				// .value 是状态当前值：text 来自持久化文档，start 是 WorkerInfo.start 的 JSON 字符串。
				return { kind: "json", value: { text: notes.text.value, start: notes.start.value } };
			},
			"POST /notes/:id": async (request, ctx) => {
				// 每次请求都重新取引用；Reference 是轻量的，worker 可能因空闲已停止。
				const notes = await ctx.get(Notes, { id: request.params.id ?? "" });
				// request.json() 解析 JSON body，格式错误抛 400（由 kit 转成响应）；
				// 返回类型是 JsonValue，String(...) 是运行期转换（示例只接受字符串输入）。
				// write 的实参和 ctx 一起传给 worker 上的方法；等待它完成持久化后返回。
				await notes.write(String(await request.json()), ctx);
				// 固定返回 JSON 字符串 "saved"。
				return { kind: "json", value: "saved" };
			},
		},
	});
});
