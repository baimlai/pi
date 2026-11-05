// 文件导读
// 所属包与目录：packages/chord/test/examples/36-plugin-failures，Chord v2（slice 7c）的“插件失败”示例；
// main.ts 是应用侧入口，plugins/ 下每个子目录是一个真实插件（package.json 加该插件的 server facet 文件）。
// 演示什么：按插件隔离的四类失败与一个提交后取消场景。
//   1) 启动时 setup 抛错：weather 被排除，其他插件照常服务，消费者 forecast 停在 failed/waiting。
//   2) 重载时四种坏代码：构建失败（greeter 的语法错误）、求值抛错（boot 模块顶层 throw）、工厂抛错（counter 在
//      staging 阶段失败）、provider 契约升版但自身构建失败（prices）；闭包规则把依赖新契约的 summary 也保留在旧代码。
//   3) 修复后一次应用全部更新，summary 等新 Price 就绪后才可用。
//   4) 重载在提交后取消：reload 以 aborted 拒绝，但提交已生效，组件记住提交结果，后续重载不会回滚 cache。
// 上游入口：本文件是可直接运行的示例，不是被测试导入的模块。从 packages/chord 目录执行：
//   node --conditions=source --experimental-strip-types test/examples/36-plugin-failures/main.ts
// 顶层 await 顺序执行全部阶段；任一无预期异常会终止进程，末尾清理不会执行。
// 下游依赖：node:fs/promises、node:os、node:path、node:url；Chord 的 context、contracts、data、host、根导出与
// node/plugins（createPlugins、mapStack）；plugins/ 下的契约与 facet 文件。插件构建时把 "@earendil-works/chord"
// 当作宿主包保持 external，运行时的 modules 映射把它指向本进程加载的 Chord 实例。
// 输出与副作用：只在 stdout 打印各阶段结果；先把 plugins/ 复制到系统临时目录，所有 edit 只改副本，末尾关闭宿主与
// watcher 后递归删除副本。示例不访问网络、不读取真实 API key、不调用模型，也不启动真实天气服务。
// 插件清单（plugins/<dir>/package.json，本示例不修改这些 JSON 文件）：
// - @example/boot、@example/cache、@example/counter、@example/forecast、@example/greeter、@example/prices、
//   @example/summary、@example/weather：name 是插件身份（不是目录名），private 防止误发布，type: module 声明 ESM；
//   discoverPlugins 只读这些清单来发现插件，清单变化会让 watcher 请求重新安装或重新发现。
// 能力清单（本文件不导出任何符号）：
// - until(ready)：轮询等待 watcher 事件反映到状态。
// - edit(file, from, to)：在临时副本里替换插件源码片段。
// - buildDirty(names)：等指定插件被标脏后构建当前全部 dirty 插件。
// - print(report)：打印重载报告中的插件变化、对象 fate 和失败插件的映射堆栈。
// - 六个 local 契约：Forecast、Greeting、Boot、Counter、Summary、Status（供应用侧读取对象）。
// - createPlugins/createHost 与四幕演示：启动失败、坏编辑加闭包规则、修复、提交后取消。
// 典型运行顺序与预期（节选）：启动打印 "1. left out @example/weather: ..."；第 2 幕 built 中 greeter、prices 为
// failed，reload 后 running 仍是旧值且 still dirty 列出五个插件；第 3 幕 fixed 后 running 变为 "hi" "v2" 2 ...，
// 最后 then 行出现 "price v2: 300 cents"；第 4 幕打印状态引用 loading、rejected aborted 与
// committed.changed ["@example/cache"]，最终 status 为 "cache v2"。
// 示例（真实签名，单独调用组件的最小片段）：
//   const built = await plugins.build(["@example/greeter"], context);
//   const report: ReloadReport = await plugins.reload(host, built, context);
//   这里省略了创建 host、load 与关闭；真实运行时 host 必须由同一个组件先 load 过。
// 建议阅读顺序：先看插件目录里的 contract/server 文件（或本文件下方六个契约），再看 until/edit/buildDirty/print，
// 然后按 1-4 幕读 main；组件内部见 src/node/plugins/plugins.ts、runtime.ts 与 docs/slice-7c.md §4/§5。
// 相关文档与测试：packages/chord/docs/slice-7c.md §4、§7；node/plugins 的 load/reload 与失败报告测试。
// 用临时插件副本演示构建、求值、声明失败及提交后取消；故意破坏的是字符串写出的临时文件。
// 顶层顺序执行，许多错误是示例的预期输入；末尾清理没有 finally，意外抛错可能留下临时目录。
// Plugin failures (slice 7c): every failure is per plugin. At startup a plugin whose setup throws is left out and the
// others run (a consumer of what it would serve waits). At a reload a plugin whose new code fails keeps its old code and
// is listed in the report's `failed`: a syntax error (its build failed), a module that throws while it is evaluated
// (`mapStack` names the plugin's file and line), a factory that throws while the host stages it. The closure rule: a
// provider and its consumer edited together, the provider broken, the consumer kept on its old code too (its new code
// needs the provider's new version) and still working; the next good edit applies both. Last, a reload whose context
// aborts after its commit: the commit stands, and the component keeps what was committed.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/36-plugin-failures/main.ts
// 导入分组：Node 的异步文件系统、临时目录、路径与 URL 工具；Chord 的 context、contracts、data、host、根导出和
// node/plugins；最后是 weather 的契约文件。type ReloadReport 只存在于编译期，运行时会被擦除。
// import * as chord 取得命名空间对象，作为宿主包 "@earendil-works/chord" 在该插件构建/求值时对应的实例。
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../../../src/context/index.ts";
import { int, local, str } from "../../../src/contracts/index.ts";
import { isChordError } from "../../../src/data/index.ts";
import { createHost, type ReloadReport } from "../../../src/host/index.ts";
import * as chord from "../../../src/index.ts";
import { createPlugins, mapStack } from "../../../src/node/plugins/index.ts";
import { Weather } from "./plugins/weather/contract.ts";

// 不主动取消的基础上下文；最后一组单独派生可取消上下文来演示取消边界。
const context = BACKGROUND_CONTEXT;

// The example edits files: it works on a copy of `plugins/`, removed at the end.
// 先建随机临时目录，再复制插件；本仓库中的样例文件不被 edit 改写。
// mkdtemp 与 cp 都返回 Promise；顶层 await 让模块在这里暂停，失败会直接拒绝模块执行。
// new URL("./plugins/", import.meta.url) 以本文件 URL 为基准定位样例目录，fileURLToPath 再转成本地路径。
// recursive: true 表示连子目录和文件一起复制，而不是只复制空目录。
const root = await mkdtemp(join(tmpdir(), "chord-example-36-"));
await cp(fileURLToPath(new URL("./plugins/", import.meta.url)), root, { recursive: true });

/** Waits until `ready()` holds (the watcher's events arrive on their own time). */
// 输入同步布尔检查函数，异步等它为真后返回 void；每次失败等约10ms，不提供超时/取消。
// 例如等待 dirty 包含插件名；检查函数抛错会拒绝此 Promise，永不满足则会一直等待。
// 返回类型 Promise<void> 表示调用方只关心“何时完成”，不接收值；async 函数自动把返回值包成 Promise。
async function until(ready: () => boolean): Promise<void> {
	// await 让出事件循环，文件监听器才有机会处理事件；resolve 作为定时器回调完成这次等待。
	// new Promise 的执行器同步运行，setTimeout 在 10ms 后调用 resolve；实际唤醒可能更晚。
	while (!ready()) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Replaces `from` with `to` in the plugin file `file` (the copy). */
// 输入副本内相对文件名、旧片段和新片段；读取 UTF-8 文本，替换第一个命中并写回，成功返回 void。
// 例如把标签旧值换成新值；找不到片段不会报错，文件读写错误则向调用方传播。
async function edit(file: string, from: string, to: string): Promise<void> {
	// join 拼出临时目录内路径；本例的 file 是源码中固定可信路径，函数本身没有路径边界检查。
	const text = await readFile(join(root, file), "utf8");
	// 字符串 replace 只改第一次命中；所以学习注释也不能提前包含下文 edit 搜索的源码片段。
	await writeFile(join(root, file), text.replace(from, to));
}

/** Waits until the watcher marks every plugin in `names` dirty, then builds the dirty plugins. */
// 输入只读插件名数组；等每个名字被标脏后构建当时全部 dirty，返回组件的 Built 结果 Promise。
// 只读是 TS 约束，不冻结数组；构建结果可能含 failed facet，等待无超时，文件系统异常可直接拒绝。
// 返回类型没有显式标注，TypeScript 从 plugins.build 的返回推断出 Promise<Built>。
async function buildDirty(names: readonly string[]) {
	// every 对每个目标做 includes；箭头函数捕获组件，每次轮询都重读最新 state.value。
	await until(() => names.every((name) => plugins.state.value.dirty.includes(name)));
	// 直接返回 Promise，async 会接续它的完成/失败；这里没有应用构建结果。
	// 传入的是整个 dirty 列表而不是 names：复制契约等间接变化也会让别的插件进入这次构建。
	return plugins.build(plugins.state.value.dirty, context);
}

/** A reload's report: what changed, its objects' fates, and each failed plugin with its error's mapped stack. */
// 输入强类型重载报告，只向 stdout 打印，不修改报告；例如输出某插件 kept 及映射后的首个栈帧。
// void 表示无返回结果；打印/栈映射异常不在这里捕获，报告本身也不是在这里做运行时校验。
function print(report: ReloadReport): void {
	// plugins 列 added/changed/removed；对象列表另外展示每个对象采取的重载命运。
	// JSON.stringify 只用于让嵌套的 readonly 数组在一行里可读，不改变报告对象。
	console.log("   plugins:", JSON.stringify(report.plugins));
	// report.objects 中每项是“对象标签 + fate”；模板字符串只拼接展示文本。
	const objects = report.objects.map((each) => `${each.object} ${each.kind}`);
	// 空列表省略这一行；join 只拼接展示文字。
	if (objects.length > 0) console.log("   objects:", objects.join(", "));
	// 解构失败条目；失败插件仍可能在运行其旧代码。
	for (const { plugin, error } of report.failed) {
		// The first line, and the second where it names the plugin's code: a build error, or a mapped stack frame.
		// 解构第二行默认空串；mapStack 尝试用插件脚本的 source map 还原文件/行号。
		const [message, next = ""] = mapStack(error).split("\n");
		// 只保留构建说明或插件 server 文件帧；三元表达式决定附加文本，不改原 error。
		const detail = !next.trimStart().startsWith("at ") || next.includes("/server.ts:") ? ` ${next.trim()}` : "";
		console.log(`   failed ${plugin}: ${message}${detail}`);
	}
}

// The contracts the app reads (the plugins declare the same ones).
// 各 local 契约只在本主机可见；空 params 使对象活到主机关闭，schema 描述状态形状。
// 应用和脚本里的 token 是不同对象，但同名、同版本、同指纹才能绑定，不要求 token 引用相等。
// local(...) 的 const 泛型从参数字面量推断名称/版本/成员类型；这里声明的是契约身份，不创建对象。
// members 中的 str()/int() 是 schema 描述而不是初值；示例的读取路径不会每次按 schema 校验状态值。
// Forecast 用于启动时观察等待中的消费者；Status 用于第 4 幕观察 cache 插件的状态对象。
const Forecast = local("example.forecast", { version: 1, params: {}, members: { text: str() } });
const Greeting = local("example.greeting", { version: 1, params: {}, members: { text: str() } });
const Boot = local("example.boot", { version: 1, params: {}, members: { mode: str() } });
const Counter = local("example.counter", { version: 1, params: {}, members: { start: int() } });
const Summary = local("example.summary", { version: 1, params: {}, members: { text: str() } });
const Status = local("example.status", { version: 1, params: {}, members: { text: str() } });

// The host packages: this process's Chord.
// 本进程模块提供插件的 external import，组件只构建 server facet，并从临时 root 监听变化。
// 对象字面量的键是构建时保持 external 的说明符，值是求值时 require/import 得到的真实模块。
const modules = { "@earendil-works/chord": chord };
// createPlugins 立即创建 watcher，但首次发现/构建延迟到 load/build 等首次使用。
// roots 里是字符串或 { path, required }；这里用临时副本路径，非必选根，所以插件失败不会让 load 整体拒绝。
const plugins = createPlugins(
	{
		roots: [root],
		// kinds 的键同时是 facet 文件名（server.ts）和重载时使用的种类名；Object.keys(modules) 得到宿主包列表。
		kinds: { server: { platform: "node", hostPackages: Object.keys(modules) } },
		// 组件后台错误只打印 kind；主机后台错误下面由空函数忽略，load 报告仍显式检查。
		onError: (error) => console.log("plugins:", error.kind),
	},
	context,
);
// 主机自身没有插件加载，只作为四幕演示的容器；onError 忽略宿主后台错误，失败插件通过 load/reload 报告返回。
const host = createHost({ onError: () => {} });

// 1. Startup: the weather plugin's setup throws; it is left out and reported, the other plugins run. A reference to
//    what it would serve waits (`failed`, cause `waiting`: not served here), and so does its consumer's object.
// load 仍完成，失败插件列在报告；断言 Error 只是 TS 提示，不会把任意运行时错误转换成 Error。
// load 的参数：kind 选择 server facet 集合，core 是应用自己的 facet（本例为空），modules 是宿主包实例表。
// 宿主逐个运行 setup 并等待空参数对象的首次结局；weather 的 setup 抛错只让该插件进入 failed。
const loaded = await plugins.load(host, { kind: "server", core: [], modules }, context);
// 解构 PluginFailure；error 的静态类型是 unknown，`error as Error` 不改变运行时值。
for (const { plugin, error } of loaded.failed) console.log(`1. left out ${plugin}: ${(error as Error).message}`);
// hold 立即给引用，即便缺 provider；get 则等待 live。消费者 forecast 会停在等待失败依赖的状态。
// hold 返回 Held<C>，其 .state 是 NativeWatchable<RefState>，读取 .value 可同步得到当前状态。
const weather = host.hold(Weather, {}, context);
const forecast = host.hold(Forecast, {}, context);
// 引用状态是判别联合：先等 forecast 离开 loading，变成 failed（原因 waiting：provider 未被服务）。
await until(() => forecast.state.value.kind === "failed");
// weather 没有被服务，状态同样是 failed；它的 cause.error 是 Chord 的 unavailable 错误。
console.log("   weather:", JSON.stringify(weather.state.value));
console.log("   forecast:", JSON.stringify(forecast.state.value));
// 这些未失败的插件照常取到就绪引用；await 不会修复 weather 插件。
// host.get 等到对象 live 才返回 Reference<C>；失败或超时会拒绝，而不是返回未就绪引用。
const greeting = await host.get(Greeting, {}, context);
const boot = await host.get(Boot, {}, context);
const counter = await host.get(Counter, {}, context);
const summary = await host.get(Summary, {}, context);
const status = await host.get(Status, {}, context);
// 无参数的展示函数每次重读四个状态并返回一行字符串，无状态写入；未就绪的读取仍可能抛错。
// 四个成员都是 local 对象的状态值，读取 .value 得到当前 JSON 值，不需要 await。
const values = () =>
	[greeting.text.value, boot.mode.value, counter.start.value, summary.text.value]
		.map((v) => JSON.stringify(v))
		.join(" ");
console.log("   running:", values());

// 2. Four bad edits at once. The greeter's label gets a syntax error; the boot module throws while it is evaluated;
//    the counter's factory throws; the prices plugin moves its contract to version 2 and breaks its facet in the same
//    edit, while the summary plugin (its copy of the contract now at version 2) builds fine.
// 依次制造语法错误、模块顶层抛错、工厂抛错与 provider 版本变化；原源码字符串不要翻译或改写。
// 每个 edit 的 from 片段必须在副本中恰好先出现于目标代码之前；学习注释不能提前包含这些片段。
await edit("greeter/label.ts", '"hello"', '"hello" +');
await edit("boot/server.ts", "const Boot", 'throw new Error("boot: config missing");\n\nconst Boot');
await edit("counter/server.ts", "() => ({ start: constant(1) })", '() => {\n\tthrow new Error("counter: no seed");\n}');
await edit("prices/contract.ts", "version: 1", "version: 2");
await edit("prices/server.ts", "constant(250)", "constant(250");
// 前三次 edit 依次制造：标签字符串语法错误、模块求值期顶层 throw、工厂执行期 throw。
// 第四次把价格契约副本的版本升到 2；summary 内联了同一份契约副本，因此也被标脏。
// 第五次删掉 prices 工厂调用的右括号，使 prices 构建失败；其旧代码继续服务。
// 这里不点名 prices 也会构建它：buildDirty 构建的是当前全部 dirty 插件。
const bad = await buildDirty(["@example/greeter", "@example/boot", "@example/counter", "@example/summary"]);
// bad.facets 是 BuiltFacet 数组；构建失败的插件以 kind: "failed" 出现，成功的以 kind: "script" 出现。
// 标签里的 facet 才是 facet 种类名（本例都是 server），不要与构建结果标签 kind 混淆。
console.log("2. built:", bad.facets.map(({ plugin, kind }) => `${plugin}: ${kind}`).join(", "));
// Each failed plugin keeps its old code; the summary's new code would ask for `Price` v2, which only the prices
// plugin's new (failed) code serves: the closure rule keeps the summary on its old code too.
// 重载只更新可接受的新代码；失败 provider 使依赖其新契约的 summary 也保留旧代码。
// reload 内部先逐个 staging：构建/求值失败的插件以旧 facet 参与，新代码失败的插件被记录，
// 然后按闭包规则再排除无法绑定新依赖的消费者，最后一次性提交其余插件。
print(await plugins.reload(host, bad, context));
// 旧代码仍在服务，所以 running 与第 1 幕相同。
console.log("   running:", values());
// reload 不会清除 dirty 标记；清除由 rollout 在所有宿主都应用后完成，本例直接调用 reload。
console.log("   still dirty:", JSON.stringify(plugins.state.value.dirty));

// 3. The fixes: the next build and reload apply every plugin, the prices provider and its consumer together.
// 把上述坏片段逐个换回合法源码，同时让成功的新一代值与旧值不同以便观察。
// 第一行去掉刚才多加的加号并把问候文本改掉；第二、三行恢复 boot 的合法模块与新标签。
await edit("greeter/label.ts", '"hello" +', '"hi"');
await edit("boot/server.ts", 'throw new Error("boot: config missing");\n\n', "");
await edit("boot/server.ts", 'constant("v1")', 'constant("v2")');
// 工厂恢复为返回 start 常量的箭头函数；prices 恢复右括号并把金额改成 300。
await edit("counter/server.ts", '() => {\n\tthrow new Error("counter: no seed");\n}', "() => ({ start: constant(2) })");
await edit("prices/server.ts", "constant(250", "constant(300)");
// 这次显式点名 prices；buildDirty 仍会构建所有 dirty 插件（包括 summary 的最新契约副本）。
const good = await buildDirty(["@example/greeter", "@example/boot", "@example/counter", "@example/prices"]);
console.log("3. fixed:");
// 这次 reload 应把五个插件一起应用；Price 对象被替换/重服务，summary 的新代码先停在 parked。
print(await plugins.reload(host, good, context));
console.log("   running:", values());
// The summary's new code waited for the new `Price` object (parked at the report): it runs once that one is live.
// reload 报告可在依赖还 parked 时返回；等实际摘要读到新版本，才说明它这次已经可用。
await until(() => summary.text.value.startsWith("price v2"));
console.log("   then:", values());

// 4. A reload whose context aborts after its commit, while it waits for its report: here the app shuts down the moment
//    it sees the status object leave `live` (its new code waits for a new `Cache`, which takes 200 ms to open). The
//    reload rejects `aborted`, but its commit stands: `details.committed` says what it applied, and the component's
//    loaded set is what was committed (a later reload does not roll the cache plugin back).
// 先记录当前 cache 状态；随后只改副本中的 generation 常量，Cache 获得新身份，Status 的新代码会请求它。
console.log("4. status:", status.text.value);
await edit("cache/server.ts", 'const generation = "v1"', 'const generation = "v2"');
const cache = await buildDirty(["@example/cache"]);
// 状态观察者发现引用离开 live 时取消重载等待；取消发生在提交之后，不撤销已提交代码。
// AbortController 提供可手动触发的 signal；abort 的 reason 会作为 signal.reason 传给等待方。
const abort = new AbortController();
const watchStatus = await status.state.watch(context);
// 回调接收 value/failed 联合，只有 value 才有引用生命周期状态；返回 Promise<void>。
// start 是异步投递，不会在注册时同步调用回调；stop 之后的帧不再到达。
watchStatus.start(async (call) => {
	// 非值调用直接返回，避免把失败通知当状态对象使用。
	// call.kind 是判别字段：收窄后 TypeScript 才允许读取 call.value。
	if (call.kind !== "value") return;
	console.log("   the status reference:", call.value.kind);
	// AbortController.abort 同步置位并通知信号监听者；Error 是本例指定的取消原因。
	// 新代码换入时引用短暂离开 live（loading），这里立刻取消 reload 的等待。
	if (call.value.kind !== "live") abort.abort(new Error("the app shuts down"));
});
try {
	// 派生上下文沿用基础上下文的其他字段，只附加这次控制器的 signal。
	// 宿主在提交后仍要等依赖检查；状态对象的检查等新 Cache 的 native 打开，给了这里取消的窗口。
	await plugins.reload(host, cache, withAbortSignal(abort.signal, context));
} catch (error) {
	// catch 默认 unknown；运行时 isChordError 同时识别 Chord 错误及指定代码，其余异常必须重新抛出。
	// aborted 错误的 details 含 committed，描述已经提交的插件变化。
	if (!isChordError(error, "aborted")) throw error;
	console.log("   rejected:", error.code, error.message, JSON.stringify(error.details));
}
// 新 cache 继续激活；等待状态证实提交仍生效，再触发另一插件重载检查组件记住了该代代码。
// 如果提交没有生效，status 会停在旧代码的 "cache v1"，这个等待就一直不会满足。
await until(() => status.text.value === "cache v2");
console.log("   status:", status.text.value);
// 只重载 greeter；组件仍把 cache 的新摘要作为已加载 facet 传入，所以 status 不会被回滚。
await edit("greeter/label.ts", '"hi"', '"hey"');
print(await plugins.reload(host, await buildDirty(["@example/greeter"]), context));
console.log("   after another reload:", status.text.value, "| greeting:", greeting.text.value);

// 停观察、关主机、关文件监听器，最后递归删除临时副本；不执行真实天气服务或认证。
// 顺序重要：先停 status 的状态观察，再关闭宿主对象，最后停 watcher 并删除 root，避免 watcher 继续报告已删路径。
// rm 的 force 让目录不存在时也不抛错；清理没有放在 finally，前面的意外异常会留下临时目录。
await watchStatus.stop();
await host.close(context);
plugins.close();
await rm(root, { recursive: true, force: true });
