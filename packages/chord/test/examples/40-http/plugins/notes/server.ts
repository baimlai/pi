// 文件导读
// 所属：packages/chord/test/examples/40-http/plugins/notes，示例 40 的 notes 插件（包名来自同目录 package.json），
// 这是它的 server facet（server.ts）。
// 演示什么：插件不通过 host.serve 提供对象，而是用 self.contribute 向 HTTP 组件的 Http 注册表贡献三条路由：一个
// HTML 页面、一个 JSON 接口和一个文件下载。组件负责准入、认证、CSP nonce、安全基线头与 Range；路由只返回响应
// 描述。没有 host.serve 或对象生命周期，贡献在 setup 期间登记，插件加载后参与路由组合。
// 上游：插件组件的 discover/build/evaluate/load；下游依赖：@earendil-works/chord/http 的 Http 注册表与
// fileResponse、@earendil-works/chord/plugins 的 pluginFile（求值时绑定到本插件目录）。
// 输出与副作用：setup 本身不做 I/O；每个处理器在请求到达时运行。下载路由调用 fileResponse 时立即 stat 文件，
// 文件内容在响应被拉取时才读取；文件不存在时它会抛 HttpFailure(404)，由组件回答 404。
// 能力清单：
// - default export：defineFacet((_host, self) => self.contribute(Http, { routes }))。
// - "GET /"：public + page 的 HTML 页面，内联脚本携带 request.nonce。
// - "GET /notes/:name"：public 的 JSON 路由，返回 { note: request.params.name }。
// - "GET /notes/:name/download"：public 的文件下载，支持 Range，保存名为 <name>.md。
// 示例（真实签名）：
//   defineFacet((_host, self) => self.contribute(Http, {
//     routes: { "GET /notes/:name": { public: true, handler: async (request) => ({ kind: "json", value: { note: request.params.name } }) } },
//   }));
// 运行：由 test/examples/40-http/main.ts 加载本插件并发起请求（命令见该文件的文件导读）。
// 建议阅读顺序：先读 import 与 self.contribute 的形状，再依次读三条路由，最后看 main.ts 第 3 步的请求顺序。

// The notes plugin's server facet: a page, a JSON route and a file download, contributed to the HTTP component's
// registry.

import { defineFacet } from "@earendil-works/chord";
// Http 是 "chord.http" 注册表令牌（版本 1）；fileResponse 把文件变成 bytes 响应描述。
import { fileResponse, Http } from "@earendil-works/chord/http";
// pluginFile 在求值该 facet 时绑定到本插件目录，返回插件内文件的绝对路径；越出目录的 ../ 会被拒绝。
import { pluginFile } from "@earendil-works/chord/plugins";

// _host 不使用，下划线表示有意忽略；self 只在 setup 期间可用，setup 结束后再调用会抛错。
// 同一注册表最多贡献一次；Http 的组合逻辑会把各插件的 routes 合并成路由器，冲突按贡献者顺序报告。
export default defineFacet((_host, self) =>
	self.contribute(Http, {
		// 键必须是 "METHOD /pattern"；模式段支持精确文本、:name（一个解码后的路径段）和末尾 /*。
		routes: {
			// A page: a link from another site may open it. Its inline script carries the server's nonce (the CSP).
			// public 允许没有 principal 的请求；page 允许外站顶层导航携带认证打开（本路由同时是 public，所以匿名）。
			// handler 是 async：返回 { kind: "html", body }，组件据此设置 text/html、状态 200 和默认安全头。
			"GET /": {
				public: true,
				page: true,
				handler: async (request) => ({
					kind: "html",
					// nonce 由组件为每个响应生成，并写进 CSP；内联 script 必须带同一个 nonce 才会执行。
					body: `<h1>Notes</h1><script nonce="${request.nonce}">console.log("hi")</script>`,
				}),
			},
			// `:name` is one path segment, decoded.
			// 路由器匹配后把解码值放进 request.params；返回 json 描述，组件用 JSON.stringify 写出并设置 application/json。
			"GET /notes/:name": {
				public: true,
				handler: async (request) => ({ kind: "json", value: { note: request.params.name } }),
			},
			// A file of this plugin, saved under its name, with ranges.
			// pluginFile 在请求时解析 files/<name>.md；路由器保证 :name 不含 /、\ 或 NUL 且不是 . 或 ..，
			// pluginFile 还会拒绝越出插件目录的路径（这里是第二道边界）。
			// fileResponse 立即 stat（缺失即 HttpFailure 404），并返回惰性读取的 bytes 描述；download 设置附件名，
			// ranges: true 配合 stat 得到的 size 支持单段 Range（请求 Range 时回答 206）；MIME 按 .md 推断。
			"GET /notes/:name/download": {
				public: true,
				handler: async (request) =>
					fileResponse(pluginFile(`files/${request.params.name}.md`), {
						download: `${request.params.name}.md`,
						ranges: true,
					}),
			},
		},
	}),
);
