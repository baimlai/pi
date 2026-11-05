// What a facet may import (slice 7c §2, slice 12 §2). The build inlines a plugin's own files, files of other plugins of
// its root by relative path (a copied contract) and its npm `dependencies`; it leaves host packages (the app's
// instances: an ES module's default and named exports, a CommonJS module), `chord.external` packages and Node builtins
// external, answered when the script runs; a plugin's own files are read through `pluginFile`. Here (`plugins/`): the report plugin uses each of these; its
// dependencies are installed first (`installDependencies`; `fake-npm.mjs` stands in for npm: no network). The ruler
// plugin copies a file that imports a package, the refused plugin imports what a script may not, and the paths plugin
// uses `__dirname` and `__filename`: they are left out with their build errors.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/37-plugin-imports/main.ts

// 文件导读
// 所属：Chord 示例 37（packages/chord/test/examples/37-plugin-imports），对应 slice-7c.md §2 的导入规则；
// slice-12.md §2 记录了其后的跨仓库导入模型，本示例未配置应用 API，仍按 7c 的宿主包/相对路径行为构建。
// 它是目录示例的入口 main.ts，不是单元测试：按步骤打印过程和结果，未捕获的异常会让进程以非零状态退出。
// 演示什么：一个 server facet 可以有哪些导入，以及每类导入在“构建”和“求值”两个阶段被如何处理：
// - 插件自己的文件：内联进脚本；运行时用 pluginFile(path) 读取自己的磁盘文件。
// - 同一 root 内另一插件的文件：按相对路径复制进脚本（built.copied 记录）。
// - npm dependencies：安装进插件目录后，由 esbuild 内联。
// - 宿主包（应用传入的模块实例）：保持 external，求值时拿到应用自己的 ES 模块或 CommonJS 对象。
// - chord.external 包：保持 external，求值时从插件自己的 node_modules 加载。
// - Node 内置模块：保持 external。
// 反面示例（全部变成带文件/行/列的构建错误，而不是异常）：跨出 root 的相对路径、import.meta、__dirname、
// __filename、字面量动态 import()、复制文件里导入普通包。失败的 facet 在启动时被排除，重载时仍被报告。
// 上游/下游：main.ts 把仓库源码（src/）、示例应用（app/）和插件目录当作输入；插件代码从 @earendil-works/chord
// 导入 API，应用模块通过 modules 表以宿主包注入；Report 插件服务 shapes 契约声明的 local 对象，主程序用
// host.get(Report, ...) 读取它的 text 成员。
// 能力清单（按执行顺序）：
// 1. 把 plugins/、app/、deps/ 复制到临时目录，使插件里的 file: 依赖指向副本而不是仓库。
// 2. createPlugins：配置根目录、server 种类、宿主包、假 npm 命令和 onError。
// 3. plugins.load：打印启动时被排除的插件及构建错误（paths、refused、缺依赖的 report、复制违规的 ruler）。
// 4. plugins.installDependencies + fake-npm：把 example-greeting、example-native 装进 report/node_modules。
// 5. plugins.build：重新构建 report，打印它读到的输入文件和复制文件数。
// 6. plugins.reload：把 report 加入宿主；报告仍是 added，其余失败插件仍被报告。
// 7. host.get(Report)：读取 facet 服务的 text；最后依次关闭宿主、组件并删除临时目录。
// 典型运行（从 packages/chord 目录，离线、无需安装依赖）：
//   node --conditions=source --experimental-strip-types test/examples/37-plugin-imports/main.ts
// 预期输出（示意；构建错误的行号随源码注释变化）：
//   1. left out at startup:
//      @example/paths: ... (import.meta.url, __dirname and __filename are not available ...)
//      @example/refused: ... (outside the plugin's root / no dynamic import)
//      @example/report: ... (Could not resolve "example-greeting")
//      @example/ruler: ... (@earendil-works/pi-schema: a file copied from plugin "@example/shapes" ...)
//   2. installed: example-greeting, example-native
//      built @example/report/server: read plugins/report/server.ts, plugins/shapes/contract.ts; copied 1 file
//      reload: {"added":["@example/report"],"changed":[],"removed":[]} | still refused: @example/paths, @example/refused, @example/ruler
//   3. the report: example app v3 | EUR 12.50 | ...vat | 20% | hello, plugins | node_modules/example-native/index.js
// 副作用：创建并删除系统临时目录；启动子进程（假 npm）写 node_modules；不发起网络请求。
// 相关文档与测试：packages/chord/docs/slice-7c.md §2/§3、slice-12.md §2、src/node/plugins/README.md；
// plugins/report/server.ts 是核心被加载插件，fake-npm.mjs 是本文件调用的本地安装器。
// 示例（真实签名，摘自本文件，省略配置细节）：
//   const plugins = createPlugins({ roots, kinds, install, onError }, context);
//   const loaded = await plugins.load(host, { kind: "server", core: [], modules }, context);
//   loaded.failed  // PluginFailure[]：{ plugin, error }，错误来自构建/求值/声明
//   const built = await plugins.build(["@example/report"], context);  // Built 普通数据
//   const report = await plugins.reload(host, built, context);        // ReloadReport
// 建议阅读顺序：先看 modules 与 createPlugins 配置，再看 load 的错误输出，然后 install/build/reload，最后读
// report/server.ts 如何用每种导入拼出 text。

// Node 的 ESM 内置模块：cp/mkdtemp/readdir/rm 来自 fs/promises（返回 Promise），createRequire 用来加载 CJS，
// tmpdir/join 处理临时路径，fileURLToPath 把 import.meta.url 转成文件系统路径。
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Chord 的源码入口（--conditions=source 让包导出指向 src/ 而不是 dist/）：上下文、宿主、根 API 与插件组件。
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { createHost } from "../../../src/host/index.ts";
import * as chord from "../../../src/index.ts";
import { createPlugins } from "../../../src/node/plugins/index.ts";
// 示例自己的应用基础代码（作为宿主包 @example/app 传入）和 shapes 的契约（用于请求对象）。
import * as app from "./app/index.ts";
import { Report } from "./plugins/shapes/contract.ts";

// 后台根上下文：没有 abort signal，telemetry 是 no-op。示例里的所有调用共享它；这不是生产模式的唯一选择，
// 真实应用通常会为每次请求派生带取消信号的 context。
const context = BACKGROUND_CONTEXT;

// The example installs packages into a plugin: it works on a copy of `plugins/`, `app/` and `deps/` (the plugins'
// `file:` dependencies point there), removed at the end.
// 顶层 await：本文件是 ES 模块，Node 会等待这些 Promise 完成后再继续；示例靠这种顺序执行。
// mkdtemp 以前缀创建一个唯一的临时目录（路径形如 /tmp/chord-example-37-XXXXXX），返回其绝对路径。
// 使用副本的原因：installDependencies 会写插件目录的 node_modules，不能污染仓库；file: 依赖的相对关系在副本内保持不变。
const copy = await mkdtemp(join(tmpdir(), "chord-example-37-"));
// 逐个复制三个目录。cp 的 recursive: true 允许复制目录树；源路径由 import.meta.url（本文件的 file URL）解析。
for (const dir of ["plugins", "app", "deps"]) {
	// new URL("./plugins/", import.meta.url) 基于本文件位置拼出相对 URL；fileURLToPath 再转成平台路径。
	// 目标路径不存在时 cp 会创建它（父目录 copy 已由 mkdtemp 创建）。
	await cp(fileURLToPath(new URL(`./${dir}/`, import.meta.url)), join(copy, dir), { recursive: true });
}
// root 是插件根：之后 createPlugins 扫描它，假 npm 也只会在这个副本里写文件。
const root = join(copy, "plugins");

// 1. The component. Its host packages: Chord, the app's ES module and a CommonJS module of the app (their names kept
//    external in the server kind's builds, the modules given at load). Its npm command (here a stand-in): what
//    `installDependencies` runs in a plugin's directory.
// 宿主包表：键是构建时保持 external 的说明符，值是应用进程里真实的模块实例。`import * as chord` 和 `import * as app`
// 得到 ES 模块命名空间对象（Chord 求值时会把它们包装成带 __esModule 的对象）；createRequire 加载 .cjs 得到普通 CJS 对象。
const modules = {
	"@earendil-works/chord": chord,
	"@example/app": app,
	// createRequire(import.meta.url) 以本模块为基准创建一个 CommonJS require；相对路径 "./app/legacy.cjs" 因此能解析。
	// 同理，任何宿主包都是“应用已有的实例”，插件拿到的是同一个对象，而不是每个插件各加载一份。
	"@example/legacy": createRequire(import.meta.url)("./app/legacy.cjs"),
};
// 创建插件组件。第一个参数是配置对象，第二个是 context；返回的 Plugins 提供 load/build/reload/installDependencies 等。
const plugins = createPlugins(
	{
		// roots 是按顺序扫描的插件根；这里直接传字符串，等价于非 required 根（插件失败只报告，不让 load 拒绝）。
		roots: [root],
		// 只声明 server 一种 facet：每种 kind 指定构建平台与保持 external 的宿主包说明符。
		// Object.keys(modules) 在运行时得到三个键；与 modules 表保持同一来源，避免两处名单漂移。
		kinds: { server: { platform: "node", hostPackages: Object.keys(modules) } },
		// 覆盖 npm 命令：第一项是可执行文件（当前 Node），其余是前缀参数（假 npm 脚本）。
		// installDependencies 会在插件目录执行它并追加 install --omit=dev ... 等固定参数；fake-npm.mjs 忽略这些参数。
		install: { npmCommand: [process.execPath, fileURLToPath(new URL("./fake-npm.mjs", import.meta.url))] },
		// 组件后台错误出口：只打印错误标签（watch_failed 或 BatchError 的 kind）。真实应用应记录完整错误。
		onError: (error) => console.log("plugins:", error.kind),
	},
	context,
);

// 2. Startup: every plugin whose build fails is left out with its errors (one per line: file, line, column, why). The
//    report plugin's dependency is not installed yet.
// 创建一个本地宿主。没有 address/principal：本例只服务 local 契约，不需要跨主机寻址；onError 是必填项，
// 这里的空函数表示后台错误不影响示例（真实应用必须处理，否则失败会被静默）。
const host = createHost({ onError: () => {} });
// load 的三部分：kind 是加载哪种 facet；core 是应用自己的 facet（本例没有，传空数组）；modules 是宿主包实例表，
// 运行时还会保留它供后续 reload 使用。返回 LoadReport：failed 列出被排除的插件与原因。
// 注意：load 不会因普通插件失败而拒绝；只有 required 根中的失败才会抛出 PluginError。
const loaded = await plugins.load(host, { kind: "server", core: [], modules }, context);
console.log("1. left out at startup:");
// for...of 解构每个 PluginFailure 的 plugin 与 error；error 的类型是 unknown，因为失败可能来自任意代码。
for (const { plugin, error } of loaded.failed) {
	// (error as Error) 是类型断言，只在编译期把 unknown 当作 Error；运行时若它不是 Error，访问 message 会出错。
	// 这里所有失败都来自构建器，消息以第一行摘要开头，后续行是每条文件/行/列错误。
	const [first, ...errors] = (error as Error).message.split("\n");
	console.log(`   ${plugin}: ${first}`);
	for (const line of errors) console.log(`      ${line}`);
}

// 3. The report plugin's dependencies, installed into its own node_modules; then it builds, and a reload adds it.
// 按名字定位已发现的插件，并在它自己的目录运行 npm（这里是假 npm）；成功后清除 install 标记并把插件标脏，
// 下一次 build 因此重读依赖。它是 async 的：等待子进程结束，失败会以包含命令输出的错误拒绝。
await plugins.installDependencies("@example/report", context);
// readdir 列出安装结果；join 拼出插件副本内的 node_modules。输出顺序取决于文件系统，示例只展示内容。
console.log("2. installed:", (await readdir(join(root, "report", "node_modules"))).join(", "));
// build 返回普通数据 Built（可结构化克隆）：facets 是每个被构建插件的每种 facet，plugins 是本次涉及的插件记录，
// removed 是自上次发现后消失的插件。build 不改变当前集合；真正应用要等 reload 或 rollout。
const built = await plugins.build(["@example/report"], context);
for (const facet of built.facets) {
	// BuiltFacet 是可辨识联合：kind === "script" 时才有 source/digest/inputs/copied；kind === "failed" 时有 errors。
	// 这里只看成功构建的结果，失败项用 continue 跳过。
	if (facet.kind !== "script") continue;
	// inputs 是实际读到的插件文件（本插件与复制的文件，不含依赖包）的绝对路径；map 的回调参数用解构取出 file。
	// slice(root.length + 1) 去掉根路径和分隔符，得到相对路径，便于阅读。
	const files = facet.inputs.map(({ file }) => file.slice(root.length + 1));
	console.log(`   built ${facet.plugin}/${facet.facet}: read ${files.join(", ")}; copied ${facet.copied.length} file`);
}
// reload 把本次构建应用到宿主 kind 的当前集合，再用完整集合重载宿主。它需要 host 先由同一个组件 load 过。
const report = await plugins.reload(host, built, context);
// The reload passes the complete set: the refused plugins fail again and stay out.
// report.plugins 按变化分类（added/changed/removed），report.failed 是构建/求值/声明失败而保留旧代码或未加入的插件。
// 这里的 map 用解构参数取出 plugin 名，再用 join 拼成一行。
const stillRefused = report.failed.map(({ plugin }) => plugin).join(", ");
console.log("   reload:", JSON.stringify(report.plugins), "| still refused:", stillRefused);
// host.get 请求 local 契约 Report（空参数）并等待对象可用；返回的引用上，state 成员 text 是 Watchable，
// .value 读取当前值。constant 创建的 Watchable 永不变化，所以这里直接得到 facet 服务时拼接的字符串。
const text = (await host.get(Report, {}, context)).text.value;
console.log("3. the report:", text);

// 收尾：先关闭宿主（释放对象与后台工作），再关闭插件组件（停止 watcher 与运行时），最后删除临时副本。
// host.close 是异步的；plugins.close 是同步的；rm 的 force: true 在目录已不存在时也不报错。
await host.close(context);
plugins.close();
await rm(copy, { recursive: true, force: true });
