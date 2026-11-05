/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/47-http-own-server/plugins/notes 的插件 facet（server kind）。
 * 同目录 package.json 是发现清单：name "@example/notes" 是插件身份，private 防止误发布，type: "module"
 * 让源码按 ES 模块解析；没有 dependencies/chord.external，因为只导入宿主包。JSON 不能写注释，说明放在这里。
 * 演示什么：同一个插件路由既能由 Chord 自带监听器服务，也能由应用自己的 Node server 通过 http.fetch 服务。
 * 上游/下游：47-http-own-server/main.ts 发现并构建本文件，提供 "@earendil-works/chord" 与
 * "@earendil-works/chord/http" 宿主包；本文件不访问网络或文件。
 * 能力清单：
 * - 默认导出的 facet：向 Http 注册表贡献 GET /notes；
 * - handler：返回 JSON 响应描述，包含固定 notes 列表和准入算出的 origin。
 * 典型运行顺序：plugins.load 时执行 setup，声明路由；请求到达时组件在 host.root 作用域中调用 handler。
 * 示例（真实签名）：
 *   self.contribute(Http, { routes: { "GET /notes": { public: true, handler: async (request) => ({ kind: "json", value: {} }) } } });
 * 建议阅读顺序：先看路由键的格式，再看 public 与 handler 的返回描述。
 * 前置条件：必须由 main.ts 加载；单独执行本文件不会做任何事。
 */
// The notes plugin's server facet: one route, the same whichever server runs it.

import { defineFacet } from "@earendil-works/chord";
import { Http } from "@earendil-works/chord/http";

// _host 未使用（下划线是“刻意不用”的命名约定）；self 收集本 facet 的声明。
// 箭头函数直接返回 self.contribute 的 void 结果，因此 setup 的返回值也是 void，符合 defineFacet 的签名。
export default defineFacet((_host, self) =>
	self.contribute(Http, {
		routes: {
			"GET /notes": {
				// 没有认证器或请求不带 principal 时，public 让路由仍然运行；否则组件在插件代码前回答 401。
				public: true,
				// 路由处理函数接收 HttpRequest；这里返回描述对象，由组件负责 JSON 序列化、Content-Type 和默认头。
				// request.origin 是准入得到的规范来源：回环为 http://<host>，允许主机为中继/域名对应的来源。
				handler: async (request) => ({ kind: "json", value: { notes: ["buy milk"], via: request.origin } }),
			},
		},
	}),
);
