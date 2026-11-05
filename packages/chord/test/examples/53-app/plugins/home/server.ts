// 文件导读
// 所属：packages/chord/test/examples/53-app/plugins/home，home 插件的 server facet。
// 作用：一个插件同时做三件事——成为 Sections 注册表的 provider（把各插件的 {title,path} 合成 "标题: 路径"），
// 提供读取合并结果的 Home 对象，并向 Http 贡献 GET /：告诉调用者应用名/版本、当前 principal 和区块列表。
// 上游：插件发现器读取同目录 package.json（name 为 @notes/home，private，type: module），把本文件作为
// server facet 构建；start.ts 的 root 指向 packages/chord/test/examples/53-app/plugins。
// 下游：@notes/app/v1 的 schema 与契约；@notes/app/v1/server 的 Http；kit 核心 facet 提供的 AppInfo。
// 能力清单：
// - Home：本地契约 notes.home，members.sections 为 string[]；
// - Sections provider：host.serve(Sections, { compose })；
// - GET / 路由：返回 {app, you, sections} 的 JSON。
// 典型调用（示例）：
//   import { Http } from "@notes/app/v1/server";
//   self.contribute(Http, { routes: { "GET /": handler } });
// 阅读顺序：先看两个 host.serve，再看 self.contribute 的 GET / 处理器。
// 运行方式：不单独运行；由 startServer 在 server 宿主中加载。
// 副作用：只读 AppInfo/Home 并返回响应；不写文件、不启动子进程。
// 前置条件：请求必须带有效会话；没有 cookie/Bearer 时服务器在处理路由前返回 401。
//
// The home plugin's server facet: it serves the app's `Sections` registry (the provider of a core registry is a plugin
// of the app's required root, so it reloads like any plugin) and an object reading it, and `GET /` says who is signed
// in to which app (the kit's `AppInfo`, the start data every server plugin can read) with the sections plugins
// contributed.

// 同目录 package.json 是插件清单：name "@notes/home" 决定插件名（也是贡献排序的依据），
// private 防止误发布，type "module" 让发现器按 ESM 构建本文件。
// 从应用 API 导入；这些说明符由 start.ts 的 api.modules 提供，而不是 node_modules。
// AppInfo 是 kit 核心契约；arr/str 是 schema 构造器；defineFacet/local 声明 facet 与本地契约；
// Sections 是本应用声明的注册表。
import { AppInfo, arr, defineFacet, local, Sections, str } from "@notes/app/v1";
// Http 只在 server 构建中可用。
import { Http } from "@notes/app/v1/server";

// 本地契约：参数为空（每个服务器一份），成员 sections 是字符串数组，每次合并后由 Home 对象暴露。
/** The home page's data: the composed sections. */
const Home = local("notes.home", { version: 1, params: {}, members: { sections: arr(str()) } });

// defineFacet 的回调拿到 host（注册服务）与 self（插件自身）。一个 facet 可以提供多个契约并贡献注册表。
export default defineFacet((host, self) => {
	// 成为 Sections 的 provider：注册表只能有一个 provider，且必须来自应用必需根中的插件。
	// compose 接收所有贡献的表项数组（已按插件名排序）；每项有 value（贡献值）。
	// 这里把 {title,path} 拼成 "Notes: /notes/:id" 形式的字符串数组。
	host.serve(Sections, { compose: (table) => table.map(({ value }) => `${value.title}: ${value.path}`) });
	// 提供 Home 对象：home.registry(Sections) 声明对注册表的依赖并拿到合并结果，
	// home.derive 从该来源派生 sections 成员；注册表变化时 Home 的值随之更新。
	host.serve(Home, (_params, home) => ({
		sections: home.derive([home.registry(Sections)], ([sections]) => sections),
	}));
	// 向 Http 注册表贡献路由。Http 的合并由 kit 完成，插件只给 routes 对象。
	self.contribute(Http, {
		routes: {
			// 处理器签名是 (request, ctx) => 响应；这里不使用请求内容，故参数名以 _ 开头。
			// ctx.get 取得其他契约的对象引用；`{}` 是空参数。
			"GET /": async (_request, ctx) => {
				// AppInfo 是 kit 在服务器宿主上的启动数据：name/version/dataDir。
				const info = await ctx.get(AppInfo, {});
				// Home 是本 facet 刚提供的对象；读取它当前的合并值。
				const page = await ctx.get(Home, {});
				// 例如 "notes v1"：name 是应用名，version 是 API 版本（不是契约版本号 1）。
				const app = `${info.name.value} ${info.version.value}`;
				// ctx.principal 是本次请求已认证的身份；未认证的请求到不了这里，
				// `?? null` 只是把可选的 undefined 转成 JSON 的 null。
				// 响应 kind "json" 会设置 content-type 并序列化 value。
				return { kind: "json", value: { app, you: ctx.principal ?? null, sections: page.sections.value } };
			},
		},
	});
});
