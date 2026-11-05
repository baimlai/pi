// 文件导读
// 所属：packages/chord/test/examples/52-test-plugin，Chord v2 的插件单测示例（slice 12 §6；决策 "Testing a plugin
// alone"）。
// 演示什么：testPlugin(dir, options, ctx) 按生产方式构建一个插件（同一个 buildFacet、同一套 API 检查），用应用真实的
// API 模块求值，再加载到一个独立的内存宿主（:memory: 存储）上；stubs 是与它并列的普通 facet，用假数据提供它读取的契约。
// 插件贡献给“无人提供”的注册表的条目会被辅助 facet 收集，可用 t.contributions(R) 读取；请求等待但无人服务的契约由
// t.unserved() 列出，提示测试还需要哪些桩。本例还演示 principal：worker 宿主的身份，以及 t.root 以宿主身份或另一个
// 用户身份运行代码。
// 上下游：Node 直接运行本文件；testPlugin 内部调用 discoverPlugins、buildFacet、evaluateFacet、openStore 和 createHost，
// 最后返回 TestedPlugin（host/plugin/errors/contributions/unserved/root/close）。
// 副作用：读取插件文件、运行 esbuild、执行插件代码、创建内存 SQLite 存储；不访问网络、不写工作区。结束前必须调用
// t.close(context)，否则宿主和存储会保持打开。
// 运行（在 packages/chord 目录下；需要 Node 的内存 SQLite 支持）：
//   node --conditions=source --experimental-strip-types test/examples/52-test-plugin/main.ts
// 预期输出：`1. words in p1: 7`（notes 文本按空白分词）；`2. indexers:` 列出 word count 及其插件名；
// `3. waiting for:` 含 acme.tags，tag line 的引用状态为 failed（等待未绑定依赖）；`4. root as ...` 打印两种 principal。
// 能力清单（按步骤）：
// - 1：用 API 的构建器重新声明测试要用的三个契约（契约是数据，同名同版本同 schema 即可绑定）。
// - 2：定义 Principal 联合类型和 notes 桩 facet。
// - 3：testPlugin 构建并加载 stats 插件，读取对象状态。
// - 4：读取 helper 收集的 Indexers 贡献。
// - 5：hold 一个等待 Tags 的对象，观察 unserved 列表和引用状态。
// - 6：t.root 以宿主/用户身份运行代码。
// 示例（真实签名；options 省略 kinds/api 等字段，完整配置见下方的 testPlugin 调用）：
//   const t = await testPlugin<Principal>(dir, { kind: "worker", modules: { "@acme/app/v3": v3 }, stubs: [{ name: "@acme/notes", facet: notesStub }], principal: { kind: "worker", project: "p1" } }, context);
//   const stats = await t.host.get(Stats, { project: "p1" }, context);
//   t.contributions(v3worker.Indexers); t.unserved(); await t.close(context);
// 建议阅读顺序：先读三个契约声明和 Principal 类型，再读 notesStub 与 testPlugin 配置，最后读 get/contributions/unserved/
// root 四段观察；需要实现细节时读 src/node/plugins/testing.ts。
// Testing a plugin alone (slice 12 §6, decision "Testing a plugin alone"). `testPlugin(dir, options, ctx)` builds the
// plugin as production does (the same build, the app's API checked), evaluates it with the app's real API modules and
// loads it on an in-memory host (a `:memory:` store) beside stubs: ordinary facets serving the contracts it uses with
// fake data. Registries it contributes to that nobody serves are served by the helper, which collects the entries;
// contracts its requests wait for unserved are listed. Here (`plugins/`): the stats plugin, with a stub for the notes
// plugin, its indexer read from the collected `Indexers`, and the `Tags` contract it waits for listed.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/52-test-plugin/main.ts
// fileURLToPath 把 import.meta.url 转成本地路径，testPlugin 需要目录路径。
import { fileURLToPath } from "node:url";
// 无取消信号的根上下文。
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
// 插件单测入口；它复用生产构建与求值，但换成为测试准备的内存宿主。
import { testPlugin } from "../../../src/node/plugins/index.ts";
// 示例 49 的 worker API 模块（含 Indexers 注册表）与共享 API 模块。
import * as v3worker from "../49-plugin-api/app/v3/worker.ts";
import * as v3 from "../49-plugin-api/app/v3.ts";

// 构建、加载和宿主操作共用一个上下文。
const context = BACKGROUND_CONTEXT;

// The contracts the test uses, declared again with the API's builders (contracts are data: the same name, version and
// schema bind). The plugins' own files import `@acme/app/v3`, a host package this process has no module path for.
// 本进程没有 @acme/app/v3 的模块解析路径，所以测试用 v3 上的构建器重新声明契约；只要名字、版本和 schema 与插件里
// 的声明一致，宿主就把它们视为同一契约。params 使用 str()，成员也按插件源码里的类型声明。
const Notes = v3.local("acme.notes", { version: 1, params: { project: v3.str() }, members: { text: v3.str() } });
const Stats = v3.local("acme.stats", { version: 1, params: { project: v3.str() }, members: { words: v3.int() } });
const TagLine = v3.local("acme.tag-line", { version: 1, params: { project: v3.str() }, members: { text: v3.str() } });

/** The worker host's principal type, and a user's. */
// 可辨识联合：kind 是标签，收窄后可读取各自字段。所有字段 readonly 只在编译期约束。
// worker 身份带 project，user 身份带 id；t.root 可以临时切换成其中任意一种。
type Principal = { readonly kind: "worker"; readonly project: string } | { readonly kind: "user"; readonly id: string };

// 1. A stub of the notes plugin: an ordinary facet serving `Notes` with a fixed text for every project.
// defineFacet<Principal> 显式指定身份类型 P，使桩与测试宿主使用同一个 principal 类型。
// host.serve 的工厂解构出 project 参数，返回固定格式的文本；constant 表示该成员不变化。
const notesStub = v3.defineFacet<Principal>((host) =>
	host.serve(Notes, ({ project }) => ({ text: v3.constant(`${project}: buy milk, call bob, ship it`) })),
);

// 2. The plugin on a worker host of its own, acting as the worker's principal; the app's API as production has it.
// testPlugin<Principal> 的第一个参数是插件目录；第二个参数与生产构建对齐：种类、API、宿主包模块、桩和 principal。
// 目录末尾的 / 让 URL 解析明确指向目录；带 kinds 列表是为了让“按种类文件”的构建设置生效。
const t = await testPlugin<Principal>(
	fileURLToPath(new URL("./plugins/stats/", import.meta.url)),
	{
		// 只构建并加载 worker facet。
		kind: "worker",
		// 应用声明的全部种类；用于识别 contract.web.ts 之类的按种类文件和跨种类导入。
		kinds: ["server", "worker", "web"],
		// API 版本必须与 modules 中的版本化说明符一致。
		api: { name: "@acme/app", versions: ["v3"] },
		// 真实 API 模块：求值时插件的 require("@acme/app/v3") 和 require("@acme/app/v3/worker") 得到这些实例。
		modules: { "@acme/app/v3": v3, "@acme/app/v3/worker": v3worker },
		// 桩列表：name 是它在宿主里的插件名，facet 是上面定义的普通 facet。
		stubs: [{ name: "@acme/notes", facet: notesStub }],
		// 测试宿主的身份；Stats/TagLine 的参数包含 project，激活时会用到该 principal。
		principal: { kind: "worker", project: "p1" },
	},
	context,
);

// 3. Its objects are live: get them, read their state.
// host.get 等到对象 live 才返回引用；Stats 的 words 是对 Notes.text 的 derive，读取 .value 得到当前词数。
const stats = await t.host.get(Stats, { project: "p1" }, context);
console.log("1. words in p1:", stats.words.value);

// 4. What it contributed to `Indexers`, a registry of the app no stub serves: collected by the helper.
// contributions 只接受“插件贡献了、但插件自己和桩都不提供”的注册表；返回条目数组，逐项解构出贡献插件名和值。
// map 的回调返回字符串，console.log 会打印整个数组。
console.log(
	"2. indexers:",
	t.contributions(v3worker.Indexers).map(({ plugin, value }) => `${value.name} (${plugin})`),
);

// 5. A contract nobody serves: its requests wait, and the helper names it, so the test knows what to stub next.
// hold 立即返回引用，不等待对象激活；参数在同步阶段校验。
const tags = t.host.hold(TagLine, { project: "p1" }, context);
// 给激活一个宏任务周期，让 TagLine 的工厂遇到未绑定的 Tags 依赖并进入等待。
await new Promise((resolve) => setTimeout(resolve, 10));
// unserved() 返回无人服务的契约/注册表名（这里应有 acme.tags）；state.value 是带 kind 标签的 RefState。
console.log("3. waiting for:", t.unserved(), "| tag line:", tags.state.value.kind);

// 6. Code outside objects as another principal (a user), and as the host's own.
// who 的参数是 Principal | undefined；三元表达式把 undefined 显示为 "nobody"，否则序列化成 JSON。
const who = (principal: Principal | undefined) => (principal === undefined ? "nobody" : JSON.stringify(principal));
// t.root 在根作用域里运行异步函数；不传 options 时使用宿主自己的 principal（worker/project p1）。
console.log("4. root as the host:", who(await t.root(async (ctx) => ctx.principal, context)));
// as const 让对象字面量保持只读字面量类型，匹配 Principal 的 user 分支。
const user = { kind: "user", id: "u1" } as const;
// 第三个参数是 RootOptions，principal 明确指定以用户身份运行。
console.log("   root as a user:", who(await t.root(async (ctx) => ctx.principal, context, { principal: user })));

// 先释放两个引用，再关闭测试宿主和内存存储；t.close 之后宿主不能再使用。
stats.release();
tags.release();
await t.close(context);
