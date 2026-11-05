/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/49-plugin-api，Chord v2 的插件模型示例（slice 12 §1-§4）。
 * 演示什么：应用给插件提供“带版本的 API”。插件只能 import 应用的 API 模块，版本写在路径里
 * （@acme/app/v3 及按 kind 拆分的 @acme/app/v3/server、/web）；应用声明仍提供的版本和每种 facet 可用的模块。
 * 构建时强制执行规则：未列出的版本、直接 import Chord、同一 facet 混用两个版本、server facet 导入 web 模块，
 * 都会得到指出规则的构建错误（多数还带文件位置），并且只有失败的插件被排除，其他插件照常加载。
 * 上游/下游：main.ts 调用 createPlugins 配置 api/versions/kinds，用 app/ 下的模块作为宿主包实例；
 * plugins/ 下每个目录是一个插件（package.json 提供名字，server.ts/web.ts 是对应 kind 的 facet 文件）。
 * 示例还会单独构建 panel 插件，并用 evaluateFacet 在另一个宿主（模拟页面）上求值它的 web facet。
 * 能力清单：
 * - createPlugins({ roots, api, kinds, onError })：带 API 检查的发现/构建/加载组件；
 * - createHost + core facet：服务 Greetings 注册表，按插件名顺序组合问候语；
 * - plugins.load：返回 LoadReport，其中 failed 列出构建失败的插件；
 * - plugins.build(["@acme/panel"])：返回 Built（facets、plugins、removed），不改变当前集合；
 * - evaluateFacet(script, { hostPackages, plugin })：把已构建脚本执行成 Facet；
 * - page 宿主 + Panels 注册表：证明 web facet 能贡献页面可见的数据。
 * 典型运行顺序：配置组件 -> 加载 server kind -> 打印成功问候与失败原因 -> 构建/求值 panel 的 web facet -> 关闭。
 * 示例（真实签名）：
 *   const plugins = createPlugins({
 *     roots: [{ path: "./plugins", required: false }],
 *     api: { name: "@acme/app", versions: ["v3", "v2"] },
 *     kinds: { server: { platform: "node", hostPackages: ["@acme/app/v3", "@acme/app/v3/server", "@acme/app/v2"] } },
 *     onError: (error) => console.log(error.kind),
 *   }, context);
 * 建议阅读顺序：先看 createPlugins 的 api/versions/kinds，再看 app/v3.ts 与 app/v2.ts 的 API 形状，
 * 然后读 plugins 下各 server.ts 的 import 说明，最后看 main.ts 如何打印失败原因并求值 web facet。
 * 前置条件与运行方式：从 packages/chord 执行
 *   node --conditions=source --experimental-strip-types test/examples/49-plugin-api/main.ts
 * 预期输出：成功问候两行（v3 与 v2 插件各一）；四行构建拒绝（ancient/direct/panel 的错误带
 * server.ts:<行>:<列>，mixed 的混版本错误只列出两个导入文件；行号会随源文件注释增删变化，规则文本不变）；
 * "server failed, web script"；最后 "panels on the page: word count"。示例没有断言。
 */
// The app's versioned API (slice 12 §1, decision "Plugins import only the app's versioned API"). Plugins import their
// host only through the app's API modules, a version in the path: `@acme/app/v3` (shared by every kind) and its
// per-kind modules (`@acme/app/v3/server`, `/v3/web`); the app lists the versions it still provides (`api.versions`)
// and each kind's modules (`kinds.<kind>.hostPackages`). Here (`plugins/`, the API in `app/`): a v3 plugin and a v2
// plugin both load (v2 is a thin layer over v3); refused at build, each with its error: a v1 plugin (no longer
// provided), a facet mixing v2 and v3, a direct import of Chord, a server facet importing the web's module.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/49-plugin-api/main.ts
// fileURLToPath 把 import.meta.url（file: URL）转成本机路径，供 createPlugins 的 roots 使用。
import { fileURLToPath } from "node:url";
// 后台上下文：示例没有外部取消来源，用共享的后台 context 即可。
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
// defineFacet 定义本进程的 facet（core 问候服务和页面），createHost 创建宿主。
import { createHost, defineFacet } from "../../../src/host/index.ts";
// createPlugins 负责发现/构建/加载插件；evaluateFacet 单独执行一个已构建脚本得到 Facet。
import { createPlugins, evaluateFacet } from "../../../src/node/plugins/index.ts";
// 应用的 API 模块实例：命名空间导入让整个模块对象作为插件可 import 的宿主包。
// v2.ts 是 v3 的薄封装；v3.ts 是共享 API；v3/server.ts 与 v3/web.ts 是按 kind 拆分的 API。
import * as v2 from "./app/v2.ts";
import * as v3server from "./app/v3/server.ts";
import * as v3web from "./app/v3/web.ts";
import * as v3 from "./app/v3.ts";

// 共享 context：所有 load/build/evaluate 调用都带同一个取消与后台作用域。
const context = BACKGROUND_CONTEXT;
// new URL("./plugins/", import.meta.url) 解析出本文件同目录下的 plugins/；fileURLToPath 转成本机绝对路径。
const root = fileURLToPath(new URL("./plugins/", import.meta.url));

// 1. The component with the app's API: its name and versions (newest first), and per kind the modules its facets may
//    import. Chord is no host package of plugins: the API re-exports what Acme supports of it.
// createPlugins 的第一个参数是组件选项；第二个参数是 context。返回值提供 load/build/close。
const plugins = createPlugins(
	{
		// roots 说明去哪发现插件目录；required: false 表示该根缺失时视为空，且其中插件加载失败不会让 load 拒绝，
		// 而是进入返回报告的 failed 列表（必选根的同类失败则会让 load 拒绝）。
		roots: [{ path: root, required: false }],
		// api.name 是应用包名，插件 import 的 "@acme/app/v3" 等说明符以它开头；versions 从新到旧列出仍提供的版本。
		// 构建时依据这份清单检查 import：请求未列出的版本（如 v1）会得到构建错误。
		api: { name: "@acme/app", versions: ["v3", "v2"] },
		// kinds 为每种 facet 声明平台和“可以 import 的宿主包”白名单。
		// server facet 可以拿到共享 v3、v3/server、v2；web facet 拿到的是 v3/web 而不是 v3/server。
		kinds: {
			server: { platform: "node", hostPackages: ["@acme/app/v3", "@acme/app/v3/server", "@acme/app/v2"] },
			web: { platform: "browser", hostPackages: ["@acme/app/v3", "@acme/app/v3/web", "@acme/app/v2"] },
		},
		// onError 只用于观察组件内部报告的错误（error.kind 是错误类别）；它不能把失败变成成功。
		onError: (error) => console.log("plugins:", error.kind),
	},
	context,
);

// 2. The server's modules (this process's instances) and its own start-data facet, base code: it serves the
//    `Greetings` registry, composing the lines in plugin-name order.
// 本进程为 server kind 提供的模块实例。键必须与 options.kinds.server.hostPackages 一一对应：
// 插件 import "@acme/app/v3" 时，evaluateFacet 从这里取出 v3 命名空间对象注入。
const modules = { "@acme/app/v3": v3, "@acme/app/v3/server": v3server, "@acme/app/v2": v2 };
// core facet 只声明“由我提供 Greetings 注册表”：host.serve 在 setup 中登记 provider，defineFacet 返回 Facet。
// compose 收到按插件名排序的表，每行 { value }；这里按表顺序取出问候语组成数组。
const core = defineFacet((host) => host.serve(v3.Greetings, { compose: (table) => table.map(({ value }) => value) }));
// 示例宿主没有固定 principal 泛型（默认宽泛的 Principal）；onError 留空，因为本示例只关注报告里的失败。
const host = createHost({ onError: () => {} });
// load 按顺序先装 core facet（服务 Greetings），再发现/构建/评估 server kind 的插件并装入同一宿主。
// options.core 的 name 是 facet 名；modules 只为插件 import 提供实例；返回的 LoadReport 只含 failed 列表。
const loaded = await plugins.load(
	host,
	{ kind: "server", core: [{ name: "@acme/core", facet: core }], modules },
	context,
);

// 3. Who loaded, and who was refused (each build error names the file, line and rule).
// host.registry 返回 Promise<RegistryValue<readonly string[]>>；.value 是 compose 的结果，表已按插件名排序。
// 成功加载的 hello（v3）与 legacy（v2）各贡献一条问候，因此这里打印两行。
console.log("1. greetings:");
for (const line of (await host.registry(v3.Greetings, context)).value) console.log(`   ${line}`);
// loaded.failed 的元素是 PluginFailure：plugin 是失败插件名，error 是 unknown（插件可抛出任意值）。
// 本示例里的构建失败是 Error，消息首行是 "plugin ...: its server facet failed to build:"，后续行是具体规则。
console.log("2. refused at build:");
for (const { plugin, error } of loaded.failed) {
	// 数组解构加 rest：丢弃首行标题，把剩余错误行收进 errors（类型 string[]）。
	// as Error 是读取 message 所需的类型断言；运行时并未检查，非 Error 值会得到 undefined 并在 split 处抛错。
	const [, ...errors] = (error as Error).message.split("\n");
	// 同一插件的多条编译错误合成一行输出；规则文本（未列出的版本、直接导入 Chord 等）是稳定部分。
	console.log(`   ${plugin}: ${errors.join("; ")}`);
}

// 4. The web kind provides `/v3/web`: the panel plugin's web facet builds, and a page (here a host in this process,
//    given the web's modules) evaluates and loads it.
// build(names, context) 只构建指定插件的全部 facet，不改动已加载集合；返回的 Built 是可克隆的普通数据。
// panel 的 server facet 因为导入了 web 模块而失败，web facet 成功：输出顺序为 "server failed, web script"。
const built = await plugins.build(["@acme/panel"], context);
console.log("3. the panel plugin:", built.facets.map((facet) => `${facet.facet} ${facet.kind}`).join(", "));
// BuiltFacet 是可辨识联合：kind 为 "script" 表示构建成功，为 "failed" 时只有 errors。
// find 找出 web 构建成功的那个；找不到时返回 undefined，类型因此带 | undefined。
const web = built.facets.find((facet) => facet.facet === "web" && facet.kind === "script");
// 可选链先排除 undefined；与 "script" 比较的同时收窄 web 为 BuiltScript（evaluateFacet 要求的输入）。
if (web?.kind === "script") {
	// 页面环境提供的模块表：包含 web kind 的 "@acme/app/v3/web"，但不提供 server 模块。
	const webModules = { "@acme/app/v3": v3, "@acme/app/v3/web": v3web, "@acme/app/v2": v2 };
	// 页面侧的服务端 facet：服务 web API 的 Panels 注册表，把贡献的 { title } 组合成标题数组。
	const panels = defineFacet((h) =>
		h.serve(v3web.Panels, { compose: (table) => table.map(({ value }) => value.title) }),
	);
	// 模拟页面的新宿主；与 server 宿主彼此独立。
	const page = createHost({ onError: () => {} });
	// 在 page 进程中求值 panel 的 web 脚本：import 的宿主包解析到 v3/v3web/v2 实例，plugin 提供插件目录信息。
	// built.plugins 按名字记录本次构建涉及的全部插件；! 只表达“build 刚构建过它”的约定，无运行时检查。
	const facet = evaluateFacet(web, { hostPackages: webModules, plugin: built.plugins["@acme/panel"]! });
	// 先加载页面自身 facet（Panels 的 provider），再加载 panel 的 web facet（贡献者）。
	await page.load(
		[
			{ name: "@acme/page", facet: panels },
			{ name: "@acme/panel", facet },
		],
		context,
	);
	// panel 的 web facet 已贡献一个标题，compose 结果只有一个元素，因此输出 "word count"。
	console.log("   panels on the page:", (await page.registry(v3web.Panels, context)).value.join(", "));
	// 先关页面宿主（它的对象都属于这个宿主），之后脚本映射等资源才可回收。
	await page.close(context);
}

// 关闭顺序：先关业务宿主（等待其对象结束），再同步关闭插件组件（停止 watcher、释放构建缓存）。
await host.close(context);
plugins.close();
