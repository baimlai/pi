/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/48-http-baseline/plugins/notes 的插件 facet（server kind）。
 * 同目录 package.json 是发现清单：name "@example/notes" 是插件身份，private 防止误发布，type: "module"
 * 让源码按 ES 模块解析；没有 dependencies/chord.external。JSON 不能写注释，清单说明集中写在这里。
 * 演示什么：同一条插件路由在不同安全选项下的行为——page 路由允许外站顶层导航携带认证，默认路由要求
 * principal，crossSite 路由总是匿名运行（webhook）。
 * 上游/下游：48-http-baseline/main.ts 发现并构建本文件，提供 "@earendil-works/chord" 与
 * "@earendil-works/chord/http" 宿主包；本文件不访问网络或文件，notes 数组只存在于插件模块内。
 * 能力清单：
 * - GET /：page 路由，返回 HTML 页面，显示当前 principal；
 * - GET /notes：受保护路由，返回 JSON 列表和当前 principal；
 * - POST /notes：受保护路由，把请求体中的 JSON 值追加到列表；
 * - POST /hooks/build：crossSite 路由，永远匿名，模拟其他站点调用的 webhook；
 * - who(principal)：把 principal（或 undefined）转成可打印文本。
 * 典型运行顺序：setup 声明四条路由；请求到达时组件先做准入/Origin/认证，再决定是否调用 handler。
 * 示例（真实签名）：
 *   "GET /": { page: true, handler: async (_request, ctx) => ({ kind: "html", body: `hi ${who(ctx.principal)}` }) }
 * 建议阅读顺序：先看四条路由的选项差异，再看 who 对 undefined 的处理。
 * 前置条件：必须由 main.ts 加载；单独执行本文件不会做任何事。
 */
// The notes plugin's server facet: the notes page (a link from another site may open it), the notes as JSON, adding
// a note, and a webhook another site calls (cross-site: it always runs anonymous, so it is public). Nothing else is
// public: a request nobody signed in gets 401 before this code runs (deny by default).

import { defineFacet } from "@earendil-works/chord";
import { Http } from "@earendil-works/chord/http";

// 模块级可变数组：同一个插件实例共享；示例重启会重置。真实插件应把状态放进 Chord 对象或存储。
const notes = ["buy milk"];

// 路由表的值有两种形状：HttpRouteOptions 对象，或直接一个处理函数（等价于只有 handler 的选项）。
export default defineFacet((_host, self) =>
	self.contribute(Http, {
		routes: {
			"GET /": {
				// page: true 允许“其他站点的顶层导航”也运行认证器；没有它，外来请求一律匿名。
				page: true,
				// 第二个参数 ctx 是调用作用域；ctx.principal 由组件在认证后填入，可能是 undefined。
				handler: async (_request, ctx) => ({ kind: "html", body: `hi ${who(ctx.principal)}` }),
			},
			// 这条路由没有选项：默认拒绝匿名请求，只有认证器给出 principal 才会执行。
			"GET /notes": async (_request, ctx) => ({ kind: "json", value: { notes, as: who(ctx.principal) } }),
			// POST 请求体是 JSON；json() 校验失败会抛 HttpFailure，由组件回答 400/413，不会进入返回值。
			"POST /notes": async (request) => {
				notes.push(String(await request.json()));
				return { kind: "json", value: notes };
			},
			"POST /hooks/build": {
				// crossSite: true 跳过外来 Origin 检查，并且永远不运行认证器；组合 router 会把它视为 public。
				crossSite: true,
				handler: async (_request, ctx) => ({ kind: "json", value: who(ctx.principal) }),
			},
		},
	}),
);

// 用途：把 principal 转成输出文本；输入 unknown（插件没有固定 principal 泛型）时也能安全处理。
// 输出：undefined 得 "anonymous"，其余用 JSON.stringify；副作用无，错误路径只有循环引用等 stringify 异常。
// 例子：who({ kind: "user", name: "ada" }) 返回 '{"kind":"user","name":"ada"}'。
/** Who a principal is, for the answers. */
function who(principal: unknown): string {
	// 这里不是信任边界上的形状校验：组件只会传 principal 或 undefined；unknown 只是让函数不依赖 P。
	return principal === undefined ? "anonymous" : JSON.stringify(principal);
}
