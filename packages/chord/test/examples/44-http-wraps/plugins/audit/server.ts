// The audit plugin: no routes of its own, one wrap around every route (`scope: "all"`), outermost (`observe`).

// 文件导读
// 所属：packages/chord/test/examples/44-http-wraps/plugins/audit/server.ts，插件 @example/audit 的 server facet。
// 演示什么：只贡献 wrap、不贡献路由的插件。wrap 的 scope 为 "all"，因此包住所有插件贡献的路由；phase 为
//   "observe"（最外层），在调用 next 前先进入、在 next 返回后打印方法、路径、身份与状态。没有匹配路由的请求
//   不会运行 wrap，所以这个插件对 404 完全不可见。
// 上游/下游：上游是 createPlugins 的发现与求值、plugins.load 的 core+插件加载；下游是 Http 注册表与
//   defineFacet。运行时错误（例如这里抛错）会被组件报告为 wrap_failed，并让该请求得到 500（不暴露消息）。
// 能力清单：
// - default export：defineFacet 创建的 Facet。
// - 贡献：self.contribute(Http, { wraps: [ { name, phase, scope, wrap } ] })。
// 组合关系：一个匹配路由的请求依次经过 observe（本插件）-> headers（notes 插件）-> transform -> 路由，
//   返回时反向退出；同一阶段内按贡献顺序执行。
// 示例（示例，不是本文件的额外运行代码）：
//   self.contribute(Http, { wraps: [{ name: "log", phase: "observe", wrap: async (req, next) => next(req) }] });
// 同目录 package.json（JSON，不能加注释）提供插件名 @example/audit 与 ESM 类型；插件名会出现在错误报告里，
//   本示例的 logs 也能看到它的效果。
// 建议阅读顺序：先看 HttpWrap 类型（src/node/http/router.ts），再看本文件的 wrap 回调，最后看 notes 插件的
//   headers 阶段 wrap，比较两个阶段的进入/退出顺序。
import { defineFacet } from "@earendil-works/chord";
import { Http } from "@earendil-works/chord/http";

// defineFacet 的回调只做声明；第一个参数 host 未使用（下划线前缀表示有意忽略），第二个参数 self 提供
// contribute。Http 是 "chord.http" 注册表令牌，贡献值可以是一个普通对象或 writable。
export default defineFacet((_host, self) =>
	self.contribute(Http, {
		wraps: [
			{
				// name 用于错误报告与冲突定位，不参与排序。
				name: "log",
				// phase 决定顺序：observe 最外层，headers 次之，transform 最靠近路由。
				phase: "observe",
				// scope: "all" 表示包住每个插件的路由；默认 "own" 只包本插件贡献的路由。
				scope: "all",
				// wrap 的签名是 (request, next, ctx) => Promise<HttpResponse>。next 调用内层包装器/路由；
				// 必须把 response 返回，否则响应会丢失。ctx 是该请求作用域，principal 可能为 undefined（匿名）。
				wrap: async (request, next, ctx) => {
					// 先调用内层，拿到路由（或内层 wrap）产生的响应描述；await 让路由完成。
					const response = await next(request);
					// 响应是 HttpResponse 可辨识联合，status 是可选字段（error 分支必填）。`"status" in response`
					// 是运行时属性检查：只有该字段存在时才取它，否则视为默认 200。TypeScript 用 in 收窄联合。
					const status = "status" in response ? response.status : 200;
					// 打印一行审计日志。ctx.principal 为 undefined 表示认证器没有认出身份（public 路由允许匿名）。
					// 这行日志发生在内层 wrap 与路由完成之后、响应写出之前。
					console.log(
						`   audit: ${ctx.principal === undefined ? "anonymous" : "someone"} ${request.method} ${request.path} ${status}`,
					);
					// 原样返回响应；本 wrap 只观察，不修改任何头或 body。
					return response;
				},
			},
		],
	}),
);
