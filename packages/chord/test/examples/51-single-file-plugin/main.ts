// 文件导读
// 所属：packages/chord/test/examples/51-single-file-plugin，Chord v2 的单文件插件示例（slice 12 §4；
// 决策 "Single-file plugins"）。
// 演示什么：根目录顶层的 `<name>.<kind>.ts(x)` 文件是插件 `<name>` 的一个 facet，同名多个文件合成一个插件；它没有
// package.json，因此没有依赖，只能导入应用 API，契约内联声明，直接服务对象或向注册表贡献。需要更多文件时，改成同名
// 目录（带 package.json），watcher 把变化标记为同一插件的 dirty，build + reload 原位替换它。
// 上游：Node 直接运行本文件；它把 `plugins/` 复制到临时目录，用 createPlugins 发现其中 hello（server + web）、clock、
// bad 三个插件，再用 createHost 加载 server 种类。下游：插件组件的发现、构建、求值、监视，以及 host.serve 的对象。
// 副作用：只写系统临时目录（复制插件、创建 hello/ 目录和文件、删除单文件），结束时删除临时目录；不访问网络，
// 不运行 git 或 npm。若中途抛错，临时目录会保留。
// 运行（在 packages/chord 目录下）：
//   node --conditions=source --experimental-strip-types test/examples/51-single-file-plugin/main.ts
// 预期输出：`1.` 列出三个插件及布局与 facet 文件；随后 bad 的构建错误；`2.` 打印两个对象的文本；`3.` 打印 watcher
// 标记（set 为 true，dirty 含 hello）；`4.` 打印 reload 报告的 plugins.changed 和 hello 的新文本，最后一行说明
// hello 的布局已变为 directory。
// 能力清单（按步骤）：
// - 1：复制插件根 -> createPlugins（单个根、API v3、server/web 种类）-> load -> 打印发现与失败。
// - 2：把 hello 从单文件改造成目录插件，写 greeting.ts 与 server.ts，删除原 hello.*.ts。
// - 3：等待 watcher 标记 -> build(dirty) -> reload(host, built)，观察同一插件的原位替换。
// 示例（真实签名；配置对象省略了部分字段，完整配置见下方第 1 步）：
//   const plugins = createPlugins({ roots: [root], api: { name: "@acme/app", versions: ["v3"] }, kinds: { server: { platform: "node", hostPackages: ["@acme/app/v3"] } }, onError: (e) => console.log(e.kind) }, context);
//   const loaded = await plugins.load(host, { kind: "server", core: [], modules }, context);
// 建议阅读顺序：先读 `until` 与第 1 步（发现和构建失败），再读第 2 步的文件改写，最后读第 3 步的 build/reload 与
// `report.plugins`；单文件插件源码按 hello.server.ts -> hello.web.ts -> clock.server.ts -> bad.server.ts -> helper.ts 读。
// Single-file plugins (slice 12 §4, decision "Single-file plugins"). A file at a root's top named
// `<name>.<kind>.ts(x)` is a facet of the plugin `<name>`; files with one first name are one plugin. It has no
// `package.json`, so no dependencies: it imports the app's API only, defines its contracts inline, serves objects and
// contributes to registries. When it needs more, it becomes a directory with the same name, which a reload treats as
// the same plugin. Here (`plugins/`): `hello` (a server and a web file), `clock`, and `bad`, which imports another file
// and is refused; then `hello` becomes a directory with a helper file: the watcher marks the root, a build and a
// reload change the plugin `hello` in place.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/51-single-file-plugin/main.ts
// fs/promises：cp 复制目录，mkdir 创建目录，mkdtemp 建临时根，rm 删除文件/目录，writeFile 写文件。
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
// os.tmpdir 与 path.join 用来生成临时目录路径。
import { tmpdir } from "node:os";
import { join } from "node:path";
// 把 import.meta.url 的 file:// URL 转成本地路径。
import { fileURLToPath } from "node:url";
// 无取消信号的根上下文，示例全程复用。
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
// 契约构建器：local 定义本地对象，str 声明字符串成员。
import { local, str } from "../../../src/contracts/index.ts";
// 宿主：加载 facet、提供 get/close 等接口。
import { createHost } from "../../../src/host/index.ts";
// 插件组件：发现、构建、加载、重载和 watcher 标记。
import { createPlugins } from "../../../src/node/plugins/index.ts";
// 示例 49 的 app API；server 模块只给 server facet 用。
import * as v3server from "../49-plugin-api/app/v3/server.ts";
import * as v3 from "../49-plugin-api/app/v3.ts";

// 示例没有取消需求；同一个根上下文传给组件、宿主和 get。
const context = BACKGROUND_CONTEXT;

// The example turns a file into a directory: it works on a copy of `plugins/`, removed at the end.
// 在系统临时目录下创建唯一根目录；后续改写只发生在副本里，仓库中的源文件保持不变。
const root = await mkdtemp(join(tmpdir(), "chord-example-51-"));
// 把示例的 plugins/ 整个复制到临时根；recursive: true 表示复制目录树。
await cp(fileURLToPath(new URL("./plugins/", import.meta.url)), root, { recursive: true });

/** Waits until `ready()` holds (the watcher's events arrive on their own time). */
// 轮询等待：watcher 通过文件系统事件异步更新标记，没有事件可 await，所以每 10 毫秒检查一次条件。
// 参数 ready 是返回 boolean 的回调（函数类型）；Promise<void> 表示异步完成后不产生值。
async function until(ready: () => boolean): Promise<void> {
	// new Promise 接收 executor；setTimeout 到点后调用 resolve，await 才继续下一轮 while 检查。
	// 条件一开始就为真时，循环体一次也不执行。
	while (!ready()) await new Promise((resolve) => setTimeout(resolve, 10));
}

// 1. The component, the server loaded: discovery found three single-file plugins; `bad` fails its build.
// 根目录只给一个字符串（非必选）；createPlugins 在首次 build/load 时执行发现。
const plugins = createPlugins(
	{
		roots: [root],
		// 应用 API 名称与版本；插件只能从 @acme/app/v3 及其种类模块导入。
		api: { name: "@acme/app", versions: ["v3"] },
		kinds: {
			server: { platform: "node", hostPackages: ["@acme/app/v3", "@acme/app/v3/server"] },
			web: { platform: "browser", hostPackages: ["@acme/app/v3", "@acme/app/v3/web"] },
		},
		// 组件级错误出口；这里只打印联合标签 kind。
		onError: (error) => console.log("plugins:", error.kind),
	},
	context,
);
// 求值 server facet 时 require 的宿主包实例；键必须与 kinds.server.hostPackages 中的说明符一致。
const modules = { "@acme/app/v3": v3, "@acme/app/v3/server": v3server };
// 不传 store：示例只需要内存中的对象；onError 为空表示忽略后台错误。
const host = createHost({ onError: () => {} });
// load 返回 LoadReport；bad 的构建失败会进入 loaded.failed，但不会让非必选根拒绝整个加载。
const loaded = await plugins.load(host, { kind: "server", core: [], modules }, context);
// discovery.plugins 是上次发现结果，按插件名排序；facets 是“种类 -> facet 文件绝对路径”的 Record。
for (const plugin of plugins.discovery.plugins) {
	// Object.values 取出 Record 的所有值（文件路径）；slice 去掉临时根路径前缀，只显示相对路径。
	const files = Object.values(plugin.facets).map((file) => file.slice(root.length + 1));
	console.log(`1. ${plugin.name} (${plugin.layout}): ${files.join(", ")}`);
}
// loaded.failed 的元素是 { plugin, error }；error 的静态类型是 unknown，断言成 Error 只为读 message。
for (const { plugin, error } of loaded.failed) {
	console.log(`   ${plugin} refused: ${(error as Error).message.split("\n").slice(1).join("; ")}`);
}
// 本进程重新声明两个契约；名字、版本和 schema 与插件内联声明相同，因此能绑定。
const Hello = local("example.hello", { version: 1, params: {}, members: { text: str() } });
const Clock = local("example.clock", { version: 1, params: {}, members: { text: str() } });
// host.get 等到对象 live；hello.text 是状态成员 Watchable，.value 读当前文本。
const hello = await host.get(Hello, {}, context);
console.log("2. hello:", hello.text.value, "| clock:", (await host.get(Clock, {}, context)).text.value);

// 2. `hello` needs a second file: it becomes the directory `hello/` (a package.json named `hello`), its files removed.
// 先创建目录，再写清单和源码；这些写操作都发生在临时副本里。
await mkdir(join(root, "hello"));
// package.json 的 name 必须与单文件插件名一致（hello），这样 reload 把目录视为同一个插件。
// JSON.stringify 生成单行 JSON；清单没有依赖，因此装成目录后仍只导入应用 API 和本插件文件。
await writeFile(join(root, "hello", "package.json"), JSON.stringify({ name: "hello", type: "module" }));
// 普通插件文件：目录插件可以相对导入自己的文件，单文件插件不行。
await writeFile(join(root, "hello", "greeting.ts"), 'export const greeting = "hello from a directory";\n');
// server.ts 的源码用字符串数组拼成：最后 join("\n") 用换行连接。
// 这几行文本是真实写入磁盘的插件代码，不是本文件的注释或模板字符串插值。
await writeFile(
	join(root, "hello", "server.ts"),
	[
		'import { constant, defineFacet, local, str } from "@acme/app/v3";',
		'import { greeting } from "./greeting.ts";',
		'const Hello = local("example.hello", { version: 1, params: {}, members: { text: str() } });',
		"export default defineFacet((host) => host.serve(Hello, () => ({ text: constant(greeting) })));",
	].join("\n"),
);
// 删除原来的两个单文件 facet；watcher 会把“单文件消失 + 同名目录出现”标记成 set 和 hello 的 dirty。
await rm(join(root, "hello.server.ts"));
await rm(join(root, "hello.web.ts"));
// state 是 watchable；.value 读取最新的 PluginsState。set 表示需要重新发现，dirty 列出需要重建的插件名。
// 两个条件都满足才继续，避免在 watcher 事件到达前就构建。
await until(() => plugins.state.value.set && plugins.state.value.dirty.includes("hello"));
console.log("3. marks:", JSON.stringify(plugins.state.value));

// 3. A build discovers again; the reload changes `hello` in place (the same plugin, its object swapped), a holder
//    sees the new text.
// build 先重新发现（因为 set 为 true），再构建 dirty 名单里的插件；built 是普通数据，不改变宿主当前集合。
const built = await plugins.build(plugins.state.value.dirty, context);
// reload 把 built 应用到宿主的当前集合并提交；hello 的类型未变，现有对象走纯 swap，旧引用继续有效。
const report = await plugins.reload(host, built, context);
// report.plugins 按 added/changed/removed 分类；hello 应在 changed 中。hello.text.value 现在读到新值。
console.log("4. reload:", JSON.stringify(report.plugins), "| hello:", hello.text.value);
// find 返回第一个匹配的插件或 undefined；?.layout 是可选链，找不到时整个表达式为 undefined。
console.log("   hello is now:", plugins.discovery.plugins.find(({ name }) => name === "hello")?.layout);

// 释放引用、关闭宿主与 watcher，最后删除临时根目录。
hello.release();
await host.close(context);
plugins.close();
await rm(root, { recursive: true, force: true });
