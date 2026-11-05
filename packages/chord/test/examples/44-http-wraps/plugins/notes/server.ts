// The notes plugin: a route, and its own wrap (around its own routes only) adding a header.

// 文件导读
// 所属：packages/chord/test/examples/44-http-wraps/plugins/notes/server.ts，插件 @example/notes 的 server facet；
//   discoverPlugins 把插件目录里的 server.ts 识别为 kind "server" 的入口。
// 演示什么：同一个 facet 同时贡献一条路由和一个包装器。路由 "GET /notes" 标记 public，匿名可访问；包装器
//   phase 为 "headers"，不写 scope 时默认 "own"，只包住本插件的路由，在路由响应之后覆盖 Cache-Control。
// 上游/下游：上游是 createPlugins 的构建与 plugins.load（core facet chord.http 提供 Http 注册表）；下游是
//   defineFacet、Http 注册表与 router.ts 的 composeRouter。没有 I/O。
// 能力清单：
// - default export：defineFacet 创建的 Facet，插件运行时要求默认导出。
// - routes：键为 "METHOD /pattern" 的映射；handler 返回 HttpResponse 描述对象。
// - wraps：name 用于报告，phase 决定顺序，scope 决定作用范围，route 可再限定一个模式。
// 组合关系：请求 GET /notes 依次经过 audit 的 observe wrap（最外层）-> 本文件的 headers wrap -> 路由 handler；
//   handler 返回 json 描述，本 wrap 把默认 Cache-Control: no-store 覆盖为 max-age=60 后返回。没有匹配路由的
//   请求（例如 /missing）不运行任何 wrap，因此 audit 也看不到它。
// 示例（示例，不是本文件的额外运行代码）：
//   self.contribute(Http, {
//     routes: { "GET /notes": { public: true, handler: async () => ({ kind: "json", value: [] }) } },
//     wraps: [{ name: "cache", phase: "headers", wrap: async (req, next) => ({ ...(await next(req)), headers: { "Cache-Control": "max-age=60" } }) }],
//   });
// 同目录 package.json（JSON，不能加注释）提供插件名 @example/notes 与 ESM 类型；插件名用于报告与冲突定位。
// 建议阅读顺序：先看 HttpContribution/HttpRouteOptions/HttpWrap（src/node/http/router.ts），再看本文件的
//   路由与 wrap；随后读 audit/server.ts 的 "all" wrap，最后回到 main.ts 的装配与两个请求。

import { defineFacet } from "@earendil-works/chord";
import { Http } from "@earendil-works/chord/http";

// defineFacet 的回调只做声明；host 未使用，self.contribute 把值写进 Http 注册表。一个贡献对象可以同时带
// routes 与 wraps，加载时一起组合。
export default defineFacet((_host, self) =>
	self.contribute(Http, {
		// routes 是模式到选项的映射。模式在组合时解析：精确段优先于 :name，最后是结尾的 *；非法模式作为冲突报告。
		// 同一个模式被多个插件声明时，先贡献者获胜，后者的声明被报告。handler 必须是函数。
		routes: {
			// "GET /notes" 只承载 GET；其他方法即使路径匹配也是 404。public: true 允许没有 principal 的请求；
			// 不写 public 时，认证器都没认出的请求在 handler 之前得到 401（默认拒绝）。
			// handler 是 async 函数，忽略传入的 request 与 ctx，直接返回 json 描述：value 必须是 JsonValue。
			"GET /notes": { public: true, handler: async () => ({ kind: "json", value: ["buy milk", "call mom"] }) },
		},
		wraps: [
			{
				// name 出现在冲突与错误报告里；同一阶段内 wrap 按贡献顺序从外到内。
				name: "cache",
				// phase 决定它相对于其他 wrap 的位置：observe 最外，headers 居中，transform 最靠近路由。
				phase: "headers",
				// 未写 scope 与 route：scope 取默认 "own"，即只包本插件贡献的路由；route 缺省表示本插件的全部路由。
				wrap: async (request, next) => {
					// next 调用内层（更接近路由的 wrap 或 handler）；必须 await，否则拿不到最终响应描述。
					const response = await next(request);
					// response 是 HttpResponse 可辨识联合；headers 在所有分支都是可选字段。对象展开 undefined 是空操作，
					// 因此 {...response.headers} 在无自定义头时得到空对象。同名头覆盖组件写入的默认 no-store。
					// 这些是编译期类型保证；运行时组件只读取描述对象，不做 schema 校验，JSON 序列化失败时回答 500。
					return { ...response, headers: { ...response.headers, "Cache-Control": "max-age=60" } };
				},
			},
		],
	}),
);
