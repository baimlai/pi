// 文件导读
// 所属：packages/chord/test/examples，Chord v2 示例 29，对应 slice 8（注册表）。
// 演示内容：defineRegistry 建立跨插件 token；定义者插件用 host.serve(Registry, { compose }) 提供合成函数，
// 其他插件通过 self.contribute 贡献值（普通值，或 self.writable 产生的 watchable）；读者在对象内用 self.registry、
// 对象外用 host.registry。compose 拿到按插件名（同名再按类型，facet 在前）排序的贡献表，与加载顺序无关；
// keyedEntries 按键合并，重复键由名字更小的插件保留，并以 registry_conflict 上报；每个被调用的贡献在使用点用
// try/catch 包裹，因为它是别的插件的代码。
// 上游入口：命令行直接运行；纯内存 host，不写文件、不需要 store。
// 下游调用：defineRegistry、keyedEntries/TableItem、createHost/defineFacet、self.registry/self.contribute/self.writable、
// host.registry、Reference 的 watch。后台错误经 createHost 的 onError 打印。
// 失败行为：load 前读取注册表立即抛 not_ready；冲突只上报不抛错，合成继续（先到者胜）；
// 贡献回调抛错被 Server.request 捕获并回 "500"；host.close 结束对象与 watch。
// 能力清单（按演示机制列出，本文件没有导出）：
// - Http：注册表 token，贡献类型 Routes（路由表），合成值 Router（路径到 TableItem<Handler> 的只读 Map）。
// - Server：请求对象；request(path) 从当前组合值取路由并调用，缺路由回 "404"，抛错回 "500"。
// - Mounts：宿主期对象；mount(path) 通过 self.writable 增加一条路由。
// - httpPlugin：定义者；serve(Http, {compose}) 并实现 Server。
// - notesPlugin/searchPlugin：facet 级普通值贡献；两者都提供 "/notes"，用于展示冲突。
// - mountsPlugin：对象级 watchable 贡献；routes.set 触发重新合成。
// - 主流程：load 前读注册表失败 → load（发布时合成并上报冲突）→ 打印路由表 → 请求 /notes、/broken →
//   观察组合值 → 挂载 /files → 再请求。
// 典型运行顺序：createHost → host.registry（预期拒绝）→ load 四个插件 → host.registry 取 Router →
// get Server → request → router.watch → get Mounts → mount → 等一个宏任务 → request /files → stop watch → close。
// 示例（真实签名）：
//   const Http = defineRegistry<Routes, Router>("example.http", { version: 1 });
//   host.serve(Http, { compose: (table, { report }) => keyedEntries(table, (entry) => entry.routes, report) });
//   const router = await host.registry(Http, context);   // Promise<RegistryValue<Router>>
// 阅读顺序：先看 Handler/Routes/Router 与两个契约，再看 httpPlugin 的 compose 与受保护的调用，
// 然后看三个贡献插件，最后看主流程的 load、冲突输出、watch 与 mount。
// 前置条件：Node 支持 --experimental-strip-types。在 packages/chord 下运行：
//   node --conditions=source --experimental-strip-types test/examples/29-registries.ts
// 预期输出（本机实测；Node 按宽度换行打印数组，JSON.parse 的报错文本随 Node 版本可能不同）：
//   before load: registry example.http: the host has not loaded; call host.load first (a host with nothing to load calls load([]))
//   conflict: "/notes" is contributed twice [ '@example/notes', '@example/search' ]
//   routes: [
//     '/notes (@example/notes)',
//     '/broken (@example/notes)',
//     '/search (@example/search)'
//   ]
//   /notes -> notes
//   route /broken of @example/notes threw: Expected property name or '}' in JSON at position 1 (line 1 column 2)
//   /broken -> 500
//   router now has: [ '/files', '/notes', '/broken', '/search' ]
//   /files -> mounted /files
// 相关文档：packages/chord/docs/slice-8.md 与 design.md §17（注册表）；相关测试：test/registries/ 与 test/host/ 的注册表用例。
// Registries: an extension point between plugins. The defining plugin shares a token (`defineRegistry`: a name, a
// version, the contribution and value types) and serves it with `compose`, a pure function from the table of
// contributions (sorted by plugin name, never load order) to one value, conflicts resolved by a fallback and reported
// (`registry_conflict`). Facets and host-lifetime objects contribute one value each: a plain value, or a watchable
// (`self.writable`) whose changes recompose. Readers follow the composed value (`self.registry`, a dependency like
// `self.get`; `host.registry` outside objects) and guard each contribution where they call it.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/29-registries.ts
// 四组 import：上下文、契约构造器（local/method/obj/str）、host 入口、注册表工具。
// 没有 store：注册表是纯内存机制，贡献随插件加载进入、随插件卸载离开。
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { local, method, obj, str } from "../../src/contracts/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { defineRegistry, keyedEntries, type TableItem } from "../../src/registries/index.ts";

const context = BACKGROUND_CONTEXT;

// 1. The token, shared by every plugin (bundled like a contract): routes in, a router out.
// 下面三个类型都只在编译期存在：Handler 是路由处理函数，Routes 是贡献者提交的形状，
// Router 是合成后读者的视图（Map 的值带 TableItem 包装，因此能知道某条路由来自哪个插件）。
type Handler = (path: string) => string;
// 只读属性 + Readonly<Record<...>>：类型层禁止修改；运行时并不冻结，这是同宿主代码的约定。
type Routes = { readonly routes: Readonly<Record<string, Handler>> };
type Router = ReadonlyMap<string, TableItem<Handler>>;
// 泛型两个参数分别是贡献类型 C 与合成值类型 V；token 的身份是 name + version，不是对象引用。
// 每个插件打包自己的一份 token，只要 name/version 相同就指向同一个注册表。
// 运行期检查只看声明：名称符合字符集且版本为 >=1 的安全整数，否则抛普通 Error。
// 例：defineRegistry<Routes, Router>("example.http", { version: 1 }) 返回 {kind:"registry", name, version}。
const Http = defineRegistry<Routes, Router>("example.http", { version: 1 });

/** The HTTP server: it reads the router at each request and guards the contribution it calls. */
// 普通 local 契约：空 params 意味着宿主里只有一个实例，load 阶段激活。
// request 的参数是 {path}，结果声明为 str()；结果 schema 只参与类型/文档，不做运行期校验。
// 例：server.request({ path: "/notes" }, context) 返回 Promise<string>。
const Server = local("example.server", {
	version: 1,
	params: {},
	members: { request: method(obj({ path: str() }), str()) },
});

/** A plugin whose routes are known only at runtime: it contributes a writable it sets. */
// 这个对象的贡献不是常量：mount 在运行期修改路由集合，所以它贡献一个 watchable（见 mountsPlugin）。
// 对象本身仍是空 params 的单例；mount 的参数只有 path，结果无 schema（返回 null）。
// 例：mounts.mount({ path: "/files" }, context) 把 "/files" 加进注册表。
const Mounts = local("example.mounts", { version: 1, params: {}, members: { mount: method(obj({ path: str() })) } });

// 2. The defining plugin serves the registry: the first route by plugin name wins, a duplicate is reported.
// defineFacet 的回调在 setup 阶段同步执行：这里只登记 provider 与对象工厂，不激活对象。
const httpPlugin = defineFacet((host) => {
	// host.serve 对注册表 token 的重载：第二个参数是 provider，compose 必须同步且总有返回值。
	// table 已按插件名、再按类型（facet 在前）排序；compose 不应依赖加载顺序。
	// keyedEntries 把每个贡献的 routes 记录合并成一个 Map：重复键调用 report 后保留先到项，
	// 因此 "/notes" 由 @example/notes 胜出，@example/search 的同名路由被丢弃。
	// compose 抛错会被记录为 registry_failed 并保留上一次好合成值；这里不抛错，只上报冲突。
	host.serve(Http, { compose: (table, { report }) => keyedEntries(table, (entry) => entry.routes, report) });
	host.serve(Server, (_, self) => {
		// self.registry 声明对 Http 的依赖并返回 RegistryValue<Router>；它可能让对象停放，直到组合可用。
		// router.value 同步读取最近一次成功合成值（类型是 Router），后续变更需要 watch 才会看到。
		const router = self.registry(Http);
		return {
			// 方法参数在运行期按 obj({path: str()}) 校验；返回字符串不校验。
			request: async ({ path }) => {
				// Map.get 缺键返回 undefined；TableItem 的 value 才是处理函数。
				const route = router.value.get(path);
				if (route === undefined) return "404";
				// A contribution is another plugin's code: catch, report its plugin, go on.
				// 贡献是别的插件的代码，信任边界在调用点：同步 try/catch 捕获它抛出的任何值。
				// catch 参数在 TS 里是 unknown/any，`(error as Error).message` 是断言，不做运行期检查；
				// 若对方抛出非 Error，message 会是 undefined。route.plugin 标明来源，便于日志定位。
				try {
					return route.value(path);
				} catch (error) {
					console.log(`route ${path} of ${route.plugin} threw:`, (error as Error).message);
					return "500";
				}
			},
		};
	});
});

// 3. Two plugins contribute from their facets: plain values, in the table while the plugin is loaded.
// facet 回调的第一个参数是 host，这里用 `_` 表示不用；第二个参数 self 是 setup 上下文，贡献在此登记。
// 普通值贡献不跟随变化：插件加载期间一直在表里，插件卸载/重载时撤销。
// 每个插件对同一个注册表最多贡献一次（重复会抛错）。
// "/broken" 故意抛错：JSON.parse("{") 在请求时同步抛出，由 Server.request 的 catch 兜住。
const notesPlugin = defineFacet((_, self) => {
	self.contribute(Http, { routes: { "/notes": () => "notes", "/broken": () => JSON.parse("{") } });
});
// 与 notes 冲突的 "/notes"：插件名 @example/search 大于 @example/notes，排序后到，因此被丢弃并上报。
// 冲突不影响其他键："/search" 仍进入路由表。
const searchPlugin = defineFacet((_, self) => {
	self.contribute(Http, { routes: { "/search": () => "results", "/notes": () => "search's notes" } });
});

// 4. A host-lifetime object contributes a writable: its changes recompose the router.
// 对象级贡献：对象 live 期间贡献存在，对象结束/失败/重启时撤销或替换（与 facet 级贡献的寿命不同）。
// 这里用 host.serve(Mounts, factory)：Mounts 是空 params 单例，load 时激活。
const mountsPlugin = defineFacet((host) => {
	host.serve(Mounts, (_, self) => {
		// self.writable 创建一个进程内 watchable（不持久化、不同步）；set 按对象身份比较是否变化。
		// 显式类型参数 <Routes> 让 value/set 都受 Routes 约束；不写也能从初值推断，但这里写出来更清楚。
		// 初值 routes 为空对象：对象存在但还没挂载任何路径。
		const routes = self.writable<Routes>({ routes: {} });
		// 把 watchable 本身作为贡献：Chord 会跟随它，每次 set 都重新调用 compose。
		// 若贡献普通值，则不会产生后续变化。
		self.contribute(Http, routes);
		return {
			// mount 是运行期修改路由的入口；结果无 schema，返回 null。
			mount: async ({ path }) => {
				// 展开旧 routes 再写计算属性 [path]：生成新对象而不是原地修改，确保身份变化触发通知。
				// 计算属性名 `[path]` 是 ES2015 语法，键来自变量；处理函数闭包捕获 path。
				// set 在宿主批次中登记变更；compose 在读取/跟随者需要时执行。
				routes.set({ routes: { ...routes.value.routes, [path]: () => `mounted ${path}` } });
				return null;
			},
		};
	});
});

// 无 store 的宿主：注册表与贡献全在内存里。
// onError 接收后台/上报错误。error 是可辨识联合，按 kind 收窄：
// registry_conflict 分支额外有 message 与 plugins（至少两个插件名），其他错误只打印 kind。
// 冲突上报发生在 load 发布时的主动合成（composeServed），因此这一行会出现在 load 期间。
const host = createHost({
	onError: (error) => {
		if (error.kind === "registry_conflict") console.log("conflict:", error.message, error.plugins);
		else console.log("onError:", error.kind);
	},
});

// 5. A reader before `load` throws at once ("call host.load first"); `load` composes every registry before any object.
// host.registry 在从未 load 的宿主上立即拒绝（not_ready），避免无限等待一个不会发生的发布。
// 用 .catch 而不是 try/catch：这里只演示拒绝，不中断脚本。catch 回调参数的注解 `(error: Error)` 是断言，
// 运行期错误对象来自 ChordError；message 原样打印。
await host.registry(Http, context).catch((error: Error) => console.log("before load:", error.message));
// load 接收插件描述数组：name 是贡献者的身份（也是排序与错误报告里的名字），facet 是插件实现。
// 数组顺序不影响 compose 看到的表顺序——表按 name 排序；这里按定义顺序书写只是为了可读。
// 发布时：先设置 provider 与服务，再对每个已服务的注册表主动合成一次（composeServed），最后激活对象。
// 因此冲突在此处上报，Server 激活时 self.registry 立即可用。
await host.load(
	[
		{ name: "@example/http", facet: httpPlugin },
		{ name: "@example/notes", facet: notesPlugin },
		{ name: "@example/search", facet: searchPlugin },
		{ name: "@example/mounts", facet: mountsPlugin },
	],
	context,
);
// load 之后读取：等待发布完成，并等到该版本的组合可用（有值或曾有 last 好值）。
const router = await host.registry(Http, context);
// router.value 是 ReadonlyMap<string, TableItem<Handler>>。展开 Map 迭代器得到 [key, value] 对，
// 再用解构 `{ plugin }` 只取表项的 plugin 字段；map 生成 "路径 (插件名)" 字符串数组。
// 表的迭代顺序即插入顺序，而插入顺序来自按插件名排序的表：mounts、notes、search。
// 本轮 mounts 贡献为空对象，所以只看到 notes 的两条与 search 的一条；多行参数列表由格式化产生。
console.log(
	"routes:",
	[...router.value].map(([path, { plugin }]) => `${path} (${plugin})`),
);

// 6. Requests: a duplicate went to the first plugin by name; a throwing contribution is guarded at the use site.
// 取 Server 引用（空 params 传 {}）；它在 load 时已激活。
const server = await host.get(Server, {}, context);
// "/notes" 由 @example/notes 提供（插件名更小），输出 notes 而不是 search's notes。
// 参数在运行期按 schema 校验；方法结果直接用作字符串。
console.log("/notes ->", await server.request({ path: "/notes" }, context));
// "/broken" 的处理函数抛错：request 内部捕获、打印来源插件与错误消息，然后返回 "500"。
console.log("/broken ->", await server.request({ path: "/broken" }, context));

// 7. A watch of the composed value gets each new router; mounting recomposes it.
// router 是 RegistryValue<Router>，其 watch 只投递后续合成帧，不补发当前值（当前值在 router.value）。
const watch = await router.watch(context);
// 监听器必须 async，且不会在 start 内同步调用；call 是可辨识联合，kind === "value" 时才有 value。
// call.value 是新的 Router；keys() 返回键的迭代器，展开成数组后打印。
watch.start(async (call) => {
	if (call.kind === "value") console.log("router now has:", [...call.value.keys()]);
});
// 取 Mounts 单例并挂载 "/files"：set 标记注册表为脏，合成在新的批次中发生。
const mounts = await host.get(Mounts, {}, context);
await mounts.mount({ path: "/files" }, context);
// 等待一个宏任务（setTimeout 0）：让 watch 的异步投递先执行，保证下一行之前打印 router now has。
// 请求本身不依赖这个等待——它同步读取 router.value，而 mount 的 Promise resolve 时新值已被采用。
await new Promise((resolve) => setTimeout(resolve, 0));
console.log("/files ->", await server.request({ path: "/files" }, context));

// 停止 watch（结束监听器），再关闭宿主：结束对象、撤销贡献与它持有的 writable。
await watch.stop();
await host.close(context);
