// 文件导读
// 所属：packages/chord/test/examples/38-watch-and-rollout，Chord v2 插件组第 38 个示例，对应 slice 7c §5
// （监视标记与灰度发布）。插件源码在 plugins/，应用基础代码在 app/，运行中才复制进来的插件在 incoming/。
// 演示什么：watcher 只“标记”不“应用”。文件变化产生 dirty/install/set/base 四种标记；应用调用 build 重建插件，
// 再用 rollout 按步骤（这里是 server、worker）发布。示例覆盖：一次发布里新增插件、删除插件、移除某个插件的
// worker facet；某个步骤拒绝时发布提前停止且标记保留；构建失败的插件保持脏；构建开始之后的新编辑不会被这次
// 发布错误清除。
// 上游入口：直接运行本文件，它创建两个进程内 host（两者之间没有建立链接）和一个 plugins 组件，并只修改临时副本。
// 下游依赖：../../../src/context（BACKGROUND_CONTEXT）、../../../src/host（createHost 与报告类型）、
// ../../../src/index.ts（Chord 公共 API，作为宿主包传给插件）、../../../src/node/plugins（组件与发布类型）。
// 输出与副作用：stdout 打印步骤、构建结果和标记；会复制 plugins/ 与 app/ 到系统临时目录后编辑它们，结尾删除；
// 不访问网络；构建调用 esbuild；watcher 依赖操作系统的 fs.watch，事件到达时间不确定。
// 失败行为：顶层 await 让模块在任一 I/O、构建或主机错误时直接拒绝；结尾不是 finally，所以失败时临时目录可能残留。
// 能力清单（按文件内顺序）：
// - until/dirty/marks/line/print：等待 watcher 的异步标记，并把标记和报告格式化成一行输出。
// - 第 1 步：createPlugins 与两个 host 的 load，得到发现结果和初始标记。
// - 第 2 步：分别编辑 notes 的文件、共享契约、tags 的 package.json，增删插件目录与 facet，编辑 app/ 基础代码，
//   观察对应的 dirty/install/set/base 标记。
// - 第 3 步：build 所有脏/新增/布局变化的插件，再 rollout 到 server 和 worker，观察标记清除（base 除外）。
// - 第 4 步：一个会拒绝的 RolloutStep 让发布提前停止，标记保留；下一次发布清除。
// - 第 5 步：notes 的语法错误让它保持脏，tags 的成功修改照常发布。
// - 第 6 步：构建结束后的新编辑保留标记，再次构建并发布才清除。
// 运行（从 packages/chord 目录）：
//   node --conditions=source --experimental-strip-types test/examples/38-watch-and-rollout/main.ts
// 预期输出：以 "1. loaded:" 开头的多行文本；构建路径、发布报告和标记随平台与时序略有差异，示例只打印不断言。
// 示例（真实签名，展示组件的最小用法）：
//   const plugins = createPlugins({
//     roots: [root],
//     kinds: { server: { platform: "node", hostPackages: ["@earendil-works/chord"] } },
//     onError: (error) => console.log(error.kind),
//   }, context);
//   await plugins.load(host, { kind: "server", core: [], modules }, context);
//   const built = await plugins.build(plugins.state.value.dirty, context);
//   const result = await plugins.rollout([plugins.step("server", host)], built, context);
// 建议阅读顺序：先读 until/edit/dirty/marks/line/print，再按 1-6 步阅读；类型可对照
// src/node/plugins/plugins.ts 的 PluginsOptions/Built/RolloutStep/RolloutResult 和 watcher.ts 的 PluginsState。

// The watcher's marks and rollouts (slice 7c §5). The watcher marks what changed and never applies it: `dirty` for a
// plugin whose file changed (a contract file: every plugin that copies it), `install` for a changed `package.json`,
// `set` when a plugin directory or facet file is added or removed, `base` when the app's own code changes. The app
// builds the dirty plugins and rolls the build out over its hosts in order; a rollout clears the marks of the plugins
// it applied on every step. Here: a plugin added, one removed and one dropping its worker facet in one rollout; a
// rollout stopping at a step that rejects; a failed plugin staying dirty while the others clear; an edit during a build
// keeping its mark.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/38-watch-and-rollout/main.ts
// 文件系统 Promise API：cp 递归复制、mkdtemp 建唯一临时目录、readFile/writeFile 做文本替换、rm 清理。
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
// tmpdir 返回系统临时目录；join 拼路径，跨平台处理分隔符。
import { tmpdir } from "node:os";
// join 只做路径拼接，不创建目录；copy 是临时目录的绝对路径。
import { join } from "node:path";
// fileURLToPath 把 import.meta.url（file: URL）转成本机文件路径，供 cp 和 watcher 使用。
import { fileURLToPath } from "node:url";
// BACKGROUND_CONTEXT 是一个永不取消、没有 telemetry 的根上下文；Chord 的异步 API 要求显式传入 Context。
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
// createHost 建进程内 host；Host 是 host 接口类型（泛型默认 Principal）；ReloadReport 是 host.reload 的报告。
import { createHost, type Host, type ReloadReport } from "../../../src/host/index.ts";
// 把整个 Chord 包作为插件构建时的宿主包实例：插件里的 import 会得到和本进程相同的模块对象。
import * as chord from "../../../src/index.ts";
// createPlugins 创建组件；RolloutResult 是发布结果；RolloutStep 是应用自定义的发布步骤接口。
import { createPlugins, type RolloutResult, type RolloutStep } from "../../../src/node/plugins/index.ts";

// 本示例的异步操作都使用这个基础上下文；它不会因超时或用户取消而中止。
const context = BACKGROUND_CONTEXT;

// The example edits files: it works on a copy of `plugins/` and `app/`, removed at the end.
// 示例会改文件，所以先复制到随机临时目录；mkdtemp 的后缀避免并发运行互相覆盖。
const copy = await mkdtemp(join(tmpdir(), "chord-example-38-"));
// 逐个复制整个目录；recursive 让 cp 复制目录内容而不只是空目录。
for (const dir of ["plugins", "app"]) {
	await cp(fileURLToPath(new URL(`./${dir}/`, import.meta.url)), join(copy, dir), { recursive: true });
}
// watcher 的根是副本中的 plugins/；app/ 作为基础代码在下面通过 base 选项监视。
const root = join(copy, "plugins");

/** Waits until `ready()` holds (the watcher's events arrive on their own time). */
// 周期检查 ready()，直到它返回 true；输入是同步谓词，输出是完成时无值的 Promise<void>。
// 副作用：每 10ms 唤醒一次并让出事件循环，让 fs.watch 的回调有机会修改标记。没有超时或取消：
// 条件永不成立就一直等待；ready 抛出的错误会让返回的 Promise 拒绝。
// 例（真实签名）：await until(() => plugins.state.value.set)；示例中由 dirty 包装成更具体的等待。
async function until(ready: () => boolean): Promise<void> {
	// 先判断再等待；while 每次重新求值，不能把首次结果缓存下来。
	while (!ready()) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Replaces `from` with `to` in `file` (under the copy). */
// 在副本的某个文件里做一次字符串替换。输入是相对 copy 的文件路径和要替换的两段文本；输出是写入完成。
// 副作用是重写整个文件。String.replace 只替换第一个匹配，找不到时不报错而是原样写回；示例选择的字符串都只出现一次。
// 例：await edit("plugins/notes/label.ts", "notes v1", "notes v2")。
async function edit(file: string, from: string, to: string): Promise<void> {
	// utf8 明确按文本读取；替换后整体写回，watcher 会收到一次文件变化。
	const text = await readFile(join(copy, file), "utf8");
	await writeFile(join(copy, file), text.replace(from, to));
}

/** Waits until every plugin of `names` is marked dirty. */
// 接收若干插件名（剩余参数 names: string[]），等到它们全部出现在 state.dirty 中。
// 返回 Promise<void>；不检查 install/set/base 等其他标记。例：await dirty("@example/notes")。
// 它在定义时引用后面才初始化的 plugins；函数只在 plugins 赋值之后调用，所以不会触发暂时性死区。
const dirty = (...names: string[]) => until(() => names.every((name) => plugins.state.value.dirty.includes(name)));

/** The marks, in one line. */
// 把 PluginsState（dirty/install/set/base 四个字段）序列化成一行 JSON；纯读取，无副作用。
const marks = () => JSON.stringify(plugins.state.value);

/** What a step's report says, in one line. */
// 把一次重载报告压缩成一行：展开 report.plugins（added/changed/removed），再把 failed 里的错误对象映射成插件名。
// 报告还有 objects（每个对象的命运），这里刻意省略，输出更短；例：{"added":[],"changed":["@example/notes"],...}。
const line = (report: ReloadReport) =>
	JSON.stringify({ ...report.plugins, failed: report.failed.map(({ plugin }) => plugin) });

/** A rollout, step by step. */
// 打印发布结果：result.steps 是按执行顺序的步骤，每个步骤有若干宿主结果。
// "report" in host 是 TypeScript 的 in 收窄：host 联合有三种分支（report/stopped/error），只有 report 分支带 report；
// stopped 分支（宿主干净停止）和 error 分支在这里不打印。result.stopped 存在表示某步骤拒绝，打印步骤名和错误消息。
// error 的类型是 unknown，所以先断言成 Error 再读 message；这只描述示例预期，运行时若抛的不是 Error 会得到 undefined。
function print(result: RolloutResult): void {
	for (const { name, hosts } of result.steps) {
		for (const host of hosts) if ("report" in host) console.log(`   ${name}:`, line(host.report));
	}
	// stopped 是可选属性：显式比较 undefined 表示“没有停止”；存在时它是 { step, error } 对象。
	if (result.stopped !== undefined) {
		console.log(`   stopped at ${result.stopped.step}: ${(result.stopped.error as Error).message}`);
	}
}

// The host packages: this process's Chord, kept external in Node builds.
// 宿主包映射：键是插件 import 的说明符，值是本进程的模块实例。构建时这些说明符保持 external，求值时由这里提供。
const modules = { "@earendil-works/chord": chord };
// 两种 facet（server/worker）都用 Node 平台构建；as const 把类型收窄为字面量，不产生运行时冻结或复制。
const node = { platform: "node", hostPackages: Object.keys(modules) } as const;
// 创建组件：构造函数只建立 watcher 和运行时，发现/首次构建推迟到 load/build 等首次使用。
const plugins = createPlugins(
	{
		// 只扫描临时副本的 plugins/ 一个根；根内同名插件先出现者胜出。
		roots: [root],
		// kinds 的键同时也是发现阶段识别的 facet 文件名（server.ts、worker.ts）。
		kinds: { server: node, worker: node },
		// The app's own code: a change marks `base`.
		// base 是应用自己的代码目录；其中的变化只设置 base 标记，Chord 不会自动重启任何 host。
		base: [join(copy, "app")],
		// A stand-in for npm (no network; these plugins have no dependencies).
		// install.npmCommand 是 installDependencies 要执行的命令；这里用当前 Node 执行空脚本并立即成功，
		// 不访问网络。真实应用通常会换成 npm/pnpm 等可执行文件。
		install: { npmCommand: [process.execPath, "-e", ""] },
		// 组件后台错误出口：这里只打印错误的 kind；构建失败不会走这里，而是作为 build 结果返回。
		onError: (error) => console.log("plugins:", error.kind),
	},
	context,
);
// 两个 host 都没有 principal、address 或链接；它们只用来承载各自的 kind 并演示分别重载。
// onError 传空函数：示例不在 host 层报告错误，插件失败通过重载报告的 failed 字段观察。
const server = createHost({ onError: () => {} });
const worker = createHost({ onError: () => {} });
// load 会触发首次发现和构建，并把该 kind 的完整脚本集合加载到 host；core 为空表示没有应用自己的 facet。
await plugins.load(server, { kind: "server", core: [], modules }, context);
await plugins.load(worker, { kind: "worker", core: [], modules }, context);
// step 是组件提供的“进程内步骤”：名字用于结果标识，kind 在创建时从 host 的加载记录中取得。
// 这里的 as Host 只是显式写出导入的接口类型，运行时没有类型转换。
const steps = [plugins.step("server", server as Host), plugins.step("worker", worker as Host)];
// 此时 discoverPlugins 已按插件名排序；标记可能因 fs.watch 的异步事件出现额外的 dirty/set/base，示例不断言。
console.log("1. loaded:", plugins.discovery.plugins.map(({ name }) => name).join(", "), "| marks:", marks());

// 2. Each kind of change and its mark.
// 编辑 notes 的普通文件：只有使用过该文件的 notes 变脏。
await edit("plugins/notes/label.ts", "notes v1", "notes v2");
await dirty("@example/notes");
console.log("2. a file of notes edited:", marks());
// 编辑共享契约：每个复制过该文件的插件（notes/old/tags）以及文件所在的 @example/shared 都会变脏。
// notes 已脏，所以这里只等 shared 和 tags；等待条件用 every，必须两者都命中。
await edit("plugins/contracts/contract.ts", "one type per plugin", "one type per plugin (edited)");
await dirty("@example/shared", "@example/tags");
console.log("   the shared contract edited:", marks());
// 编辑 package.json：watcher 只设置 install，不运行 npm；插件名来自 package.json 的 name。
await edit("plugins/tags/package.json", '"private": true', '"private": true,\n\t"description": "tags"');
await until(() => plugins.state.value.install.includes("@example/tags"));
console.log("   tags' package.json edited:", marks());
// 应用显式安装依赖：这里执行配置的空命令；成功后 install 标记清除，插件变脏（依赖目录可能已改变）。
await plugins.installDependencies("@example/tags", context);
console.log("   tags installed:", marks());
// 一次制造三种布局变化：复制新插件 extra、删除整个 old 目录、删除 tags 的 worker facet 文件。
// cp 把 incoming/extra（在 plugins 根之外，正常发现看不到）复制成 plugins/extra。
await cp(fileURLToPath(new URL("./incoming/extra/", import.meta.url)), join(root, "extra"), { recursive: true });
// rm recursive 删除 old 的 package.json 和 server.ts；package.json 消失会先产生 install 标记。
await rm(join(root, "old"), { recursive: true });
// 删除 tags 的 worker.ts 后，tags 仍是插件（还有 server.ts），但不再有 worker facet。
await rm(join(root, "tags", "worker.ts"));
// 目录增删产生 set 标记；这里只等 set，不等待上面几条事件全部处理完。
await until(() => plugins.state.value.set);
// Deleting old's directory deleted its package.json too: an install mark, which goes with the next discovery.
// 删除 old 目录也删掉了它的 package.json，可能短暂出现 install 标记；下一次发现知道 old 已消失，会清掉它。
console.log("   extra added, old removed, tags' worker facet deleted:", marks());
// 修改 base 代码：本次编辑只设置 base 标记，watcher 不重启 host；应用需要自己重启（本示例不重启）。
// 打印时其他标记可能还没清（例如上一步删除 old 的 package.json 留下的 install），示例不主动等待它们。
await edit("app/config.ts", '"example"', '"example 2"');
await until(() => plugins.state.value.base);
console.log("   the app's own code edited:", marks());

// 3. One build of the dirty plugins (discovery runs again first: `set`), rolled out server then worker. The server adds
//    extra and removes old; the worker leaves tags out (it has no worker facet any more). The marks clear, but `base`:
//    that one is the app's to act on (it restarts its hosts).
// build 的输入是显式点名的插件；此外它还会重建新发现的和文件布局变化的插件（这里 tags 因 worker facet 消失而重建）。
// 返回 Built 是普通数据：facets（成功或失败的构建结果）、plugins（本次参与的插件记录）、removed（已消失的插件名）。
const built = await plugins.build(plugins.state.value.dirty, context);
// 逐项列出本次构建的 facet；失败构建同样出现在 facets 中，kind 为 "failed"。
console.log("3. built:", built.facets.map(({ plugin, facet }) => `${plugin}/${facet}`).join(", "));
// removed 来自重新发现前后的差异：old 的目录已删除，所以不在新发现中。
console.log("   removed:", JSON.stringify(built.removed));
// rollout 先按 server 步骤发布 server kind 的完整集合，再按 worker 步骤发布 worker kind 的集合。
// 每个步骤成功后才推进；插件在所有步骤的宿主上都没失败时，watcher 才清除它的 dirty 标记（base 永远不清）。
print(await plugins.rollout(steps, built, context));
console.log("   marks:", marks());

// 4. A rollout stops at a step that rejects (a host the app cannot reach): the steps after it do not run, and the marks
//    stay (the plugin was not applied everywhere). The next rollout clears them.
// 自定义一个步骤：kinds 决定发布前先 ship 哪个 kind 的集合；reload 抛错即表示该步骤拒绝。
// 因为没有真正的远端 host，这里用抛错来模拟“应用无法到达的 edge host”。
const unreachable: RolloutStep = {
	name: "edge",
	kinds: ["server"],
	reload: async () => {
		throw new Error("the edge host is unreachable");
	},
};
// 先做一次普通编辑并构建 notes，然后用 [server, edge, worker] 发布：edge 拒绝后 worker 步骤不会执行。
await edit("plugins/notes/label.ts", "notes v2", "notes v3");
await dirty("@example/notes");
const notes = await plugins.build(plugins.state.value.dirty, context);
console.log("4. rollout over server, edge, worker:");
// steps[0]! 与 steps[1]! 是非空断言：在 noUncheckedIndexedAccess 下数组下标类型含 undefined，
// 但这里数组长度固定为 2，运行时一定存在。
print(await plugins.rollout([steps[0]!, unreachable, steps[1]!], notes, context));
// notes 的 worker facet 没被任何成功步骤发布，所以它的标记保留；若删除 tags/worker.ts 的文件事件恰好晚到，
// 也可能出现额外的 tags 脏标记。这里的打印属于时序观察，不是断言。
console.log("   marks:", marks());
// 换回正常步骤再发布同一份构建：两个 kind 都发布成功，notes 的标记清除。
print(await plugins.rollout(steps, notes, context));
console.log("   marks after the next rollout:", marks());

// 5. A failed plugin stays dirty, the others clear: notes gets a syntax error, tags a good edit.
// 把 notes 的字符串改成不完整表达式（末尾的 + 没有右操作数），它的构建会返回 failed 而不是抛错。
await edit("plugins/notes/label.ts", '"notes v3"', '"notes v4" +');
// tags 的修改是合法的，因此两个插件都变脏，但构建结果一个是失败、一个是脚本。
await edit("plugins/tags/server.ts", "tags on the server", "tags v2 on the server");
await dirty("@example/notes", "@example/tags");
console.log("5. notes broken, tags edited:");
// 失败插件在宿主重载报告中进入 failed，不会阻止 rollout；它没有成功构建，因此保持脏，tags 则清除。
print(await plugins.rollout(steps, await plugins.build(plugins.state.value.dirty, context), context));
console.log("   marks:", marks());

// 6. An edit after the build started keeps its mark: the rollout applies the build, but the newer edit is not in it.
// 先修好 notes 并等待标脏，然后构建出一个包含 "notes v4" 的 early 结果。
await edit("plugins/notes/label.ts", '"notes v4" +', '"notes v4"');
await dirty("@example/notes");
const early = await plugins.build(plugins.state.value.dirty, context);
// 构建完成后再编辑成 v5；这条变化得到的代号比构建快照更新。
await edit("plugins/notes/label.ts", '"notes v4"', '"notes v5"');
// The edit's event arrives on its own time (the mark is set already, so no change shows it).
// 标记此刻仍然存在（notes 构建前就是脏的），所以 dirty 的布尔值看不出新事件；等待足够长时间让 watcher 记录新代号。
// 若 v5 的事件在 rollout 检查标记前还没到达，标记代号仍等于构建快照，发布可能把它当作已应用而清除，v5 就丢了。
await new Promise((resolve) => setTimeout(resolve, 200));
console.log("6. built before the second edit:");
// 发布 early：它能应用 v4，但 notes 的最新标记代号大于快照，applied 不会清除它。
print(await plugins.rollout(steps, early, context));
console.log("   marks:", marks());
// 再按当前脏标记构建（v5）并发布；没有更新的编辑，标记这次清除。
print(await plugins.rollout(steps, await plugins.build(plugins.state.value.dirty, context), context));
console.log("   marks after building again:", marks());

// 收尾顺序：先关 host（结束对象和宿主），再关 watcher（plugins.close 不卸载已加载的 host），最后删临时副本。
await server.close(context);
await worker.close(context);
plugins.close();
await rm(copy, { recursive: true, force: true });
