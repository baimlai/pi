/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/46-allowed-hosts/plugins/tunnel 的插件 facet（server kind）。
 * 同目录 package.json 是 Chord 发现插件用的清单：name "@example/tunnel" 是插件身份（出现在报告和注册表排序里），
 * private 防止误发布，type: "module" 让源码按 ES 模块解析。它没有 dependencies 或 chord.external，
 * 因为本插件只导入宿主包；JSON 不能写注释，清单含义集中写在这里。
 * 演示什么：插件如何贡献一条路由，以及如何通过可写贡献（writable）在运行时改变 HTTP 的允许 Host 集合。
 * 上游/下游：test/examples/46-allowed-hosts/main.ts 用 createPlugins 发现并构建本文件，并传入
 * "@earendil-works/chord" 与 "@earendil-works/chord/http" 两个宿主包。本文件不读环境变量、不访问网络、不写文件。
 * 能力清单：
 * - Tunnel：与 main.ts 相同的本地契约，运行时按名称/版本/指纹匹配；
 * - 默认导出的 facet：setup 中贡献 GET /hello 公开路由，并服务 Tunnel 对象；
 * - Tunnel 工厂：创建 HttpContribution 类型的可写值，open() 写入允许主机，close() 清空。
 * 典型运行顺序：plugins.load -> 运行 setup（声明路由与对象）-> main.ts 调用 open/close -> 注册表重组 -> 路由器更新。
 * 示例（真实签名）：
 *   self.contribute(Http, { hosts: ["notes.example.net"] });
 *   这是插件 setup 中对 Http 注册表的普通值贡献；示例里的写法用 writable 让同一个贡献可以反复更新。
 * 建议阅读顺序：先看 facet setup 的 Http 路由贡献，再看 host.serve 工厂里的 writable 与 open/close 方法。
 * 前置条件：必须由 main.ts 加载；单独执行本文件不会做任何事。
 */
// The tunnel plugin: when its tunnel opens, it allows the tunnel's public host (requests through it are https); when
// it closes, it takes the host back. Its contribution is a writable, so the router follows each change.

// 这两个说明符是宿主包，由加载它的 main.ts 在 modules 表里提供。type 修饰符让 HttpContribution 只参与类型检查，
// 编译/剥离后从 import 列表消失，不会产生运行时导入。
import { defineFacet, local, method, str } from "@earendil-works/chord";
import { Http, type HttpContribution } from "@earendil-works/chord/http";

// 与 main.ts 相同的契约声明：本地契约、版本 1、无参数。main 端的 host.get 会按契约身份找到这个对象。
export const Tunnel = local("example.tunnel", {
	version: 1,
	params: {},
	members: { open: method(str()), close: method() },
});

// defineFacet 只是把 setup 函数包成声明对象；setup 在宿主 load 时同步执行，期间 host/self 提供收集声明的 API。
// 泛型参数省略时 P 取默认的 Principal，与 main.ts 里 createHost 的默认类型一致。
export default defineFacet((host, self) => {
	// self.contribute 为插件整体贡献 Http 注册表项。路由键必须是 "METHOD /path"；public: true 允许匿名访问，
	// 否则没有 principal 的请求会在路由代码运行前得到 401（本示例没有认证器，所以必须 public）。
	self.contribute(Http, {
		routes: {
			"GET /hello": {
				public: true,
				// handler 返回 HttpResponse 描述而不是自己写响应；kind: "json" 由组件序列化并附加默认安全头。
				// request.origin 是准入算出的规范来源，不是客户端可以随意伪造的 Origin 头。
				handler: async (request) => ({ kind: "json", value: { origin: request.origin } }),
			},
		},
	});
	// host.serve 只声明“宿主上存在 Tunnel 对象”和它的工厂；工厂在对象激活时执行。
	// _params 是空参数对象（下划线表示示例刻意不使用）；tunnel 是该对象的 self，可声明贡献和可写值。
	host.serve(Tunnel, (_params, tunnel) => {
		// writable 是该对象持有的可写值：初始值必须是合法的 HttpContribution。泛型参数只影响编译期类型，
		// 运行时不检查形状；写错形状会在注册表组合/router 构建时暴露。
		const allowed = tunnel.writable<HttpContribution>({ hosts: [] });
		// 把可写值本身贡献给 Http：注册表会跟随它，set() 后重新组合路由器。
		tunnel.contribute(Http, allowed);
		// 工厂返回契约方法的实现。方法实现收到的最后一个参数是调用上下文（Ctx），这里不需要，可以省略；
		// 实现可以是同步值或 Promise，类型上对应契约的 null 结果。
		return {
			open: async (name) => {
				// 写入新的贡献值：只允许这一个主机名，替换掉之前的列表。
				allowed.set({ hosts: [name] });
				// method(str()) 的结果 schema 是 null，运行时结果按快照校验，因此返回 null。
				return null;
			},
			close: async () => {
				// 清空后，路由器不再把该 Host 视为允许来源，新请求在准入阶段 403。
				allowed.set({ hosts: [] });
				return null;
			},
		};
	});
});
