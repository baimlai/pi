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
const root = await mkdtemp(join(tmpdir(), "chord-example-36-"));
await cp(fileURLToPath(new URL("./plugins/", import.meta.url)), root, { recursive: true });

/** Waits until `ready()` holds (the watcher's events arrive on their own time). */
// 输入同步布尔检查函数，异步等它为真后返回 void；每次失败等约10ms，不提供超时/取消。
// 例如等待 dirty 包含插件名；检查函数抛错会拒绝此 Promise，永不满足则会一直等待。
async function until(ready: () => boolean): Promise<void> {
	// await 让出事件循环，文件监听器才有机会处理事件；resolve 作为定时器回调完成这次等待。
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
async function buildDirty(names: readonly string[]) {
	// every 对每个目标做 includes；箭头函数捕获组件，每次轮询都重读最新 state.value。
	await until(() => names.every((name) => plugins.state.value.dirty.includes(name)));
	// 直接返回 Promise，async 会接续它的完成/失败；这里没有应用构建结果。
	return plugins.build(plugins.state.value.dirty, context);
}

/** A reload's report: what changed, its objects' fates, and each failed plugin with its error's mapped stack. */
// 输入强类型重载报告，只向 stdout 打印，不修改报告；例如输出某插件 kept 及映射后的首个栈帧。
// void 表示无返回结果；打印/栈映射异常不在这里捕获，报告本身也不是在这里做运行时校验。
function print(report: ReloadReport): void {
	// plugins 列 added/changed/removed；对象列表另外展示每个对象采取的重载命运。
	console.log("   plugins:", JSON.stringify(report.plugins));
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
const Forecast = local("example.forecast", { version: 1, params: {}, members: { text: str() } });
const Greeting = local("example.greeting", { version: 1, params: {}, members: { text: str() } });
const Boot = local("example.boot", { version: 1, params: {}, members: { mode: str() } });
const Counter = local("example.counter", { version: 1, params: {}, members: { start: int() } });
const Summary = local("example.summary", { version: 1, params: {}, members: { text: str() } });
const Status = local("example.status", { version: 1, params: {}, members: { text: str() } });

// The host packages: this process's Chord.
// 本进程模块提供插件的 external import，组件只构建 server facet，并从临时 root 监听变化。
const modules = { "@earendil-works/chord": chord };
const plugins = createPlugins(
	{
		roots: [root],
		kinds: { server: { platform: "node", hostPackages: Object.keys(modules) } },
		// 组件后台错误只打印 kind；主机后台错误下面由空函数忽略，load 报告仍显式检查。
		onError: (error) => console.log("plugins:", error.kind),
	},
	context,
);
const host = createHost({ onError: () => {} });

// 1. Startup: the weather plugin's setup throws; it is left out and reported, the other plugins run. A reference to
//    what it would serve waits (`failed`, cause `waiting`: not served here), and so does its consumer's object.
// load 仍完成，失败插件列在报告；断言 Error 只是 TS 提示，不会把任意运行时错误转换成 Error。
const loaded = await plugins.load(host, { kind: "server", core: [], modules }, context);
for (const { plugin, error } of loaded.failed) console.log(`1. left out ${plugin}: ${(error as Error).message}`);
// hold 立即给引用，即便缺 provider；get 则等待 live。消费者 forecast 会停在等待失败依赖的状态。
const weather = host.hold(Weather, {}, context);
const forecast = host.hold(Forecast, {}, context);
await until(() => forecast.state.value.kind === "failed");
console.log("   weather:", JSON.stringify(weather.state.value));
console.log("   forecast:", JSON.stringify(forecast.state.value));
// 这些未失败的插件照常取到就绪引用；await 不会修复 weather 插件。
const greeting = await host.get(Greeting, {}, context);
const boot = await host.get(Boot, {}, context);
const counter = await host.get(Counter, {}, context);
const summary = await host.get(Summary, {}, context);
const status = await host.get(Status, {}, context);
// 无参数的展示函数每次重读四个状态并返回一行字符串，无状态写入；未就绪的读取仍可能抛错。
const values = () =>
	[greeting.text.value, boot.mode.value, counter.start.value, summary.text.value]
		.map((v) => JSON.stringify(v))
		.join(" ");
console.log("   running:", values());

// 2. Four bad edits at once. The greeter's label gets a syntax error; the boot module throws while it is evaluated;
//    the counter's factory throws; the prices plugin moves its contract to version 2 and breaks its facet in the same
//    edit, while the summary plugin (its copy of the contract now at version 2) builds fine.
// 依次制造语法错误、模块顶层抛错、工厂抛错与 provider 版本变化；原源码字符串不要翻译或改写。
await edit("greeter/label.ts", '"hello"', '"hello" +');
await edit("boot/server.ts", "const Boot", 'throw new Error("boot: config missing");\n\nconst Boot');
await edit("counter/server.ts", "() => ({ start: constant(1) })", '() => {\n\tthrow new Error("counter: no seed");\n}');
await edit("prices/contract.ts", "version: 1", "version: 2");
await edit("prices/server.ts", "constant(250)", "constant(250");
// summary 使用 copied 的契约文件，因此 prices 契约变化也会使它被标脏。
const bad = await buildDirty(["@example/greeter", "@example/boot", "@example/counter", "@example/summary"]);
console.log("2. built:", bad.facets.map(({ plugin, kind }) => `${plugin}: ${kind}`).join(", "));
// Each failed plugin keeps its old code; the summary's new code would ask for `Price` v2, which only the prices
// plugin's new (failed) code serves: the closure rule keeps the summary on its old code too.
// 重载只更新可接受的新代码；失败 provider 使依赖其新契约的 summary 也保留旧代码。
print(await plugins.reload(host, bad, context));
console.log("   running:", values());
console.log("   still dirty:", JSON.stringify(plugins.state.value.dirty));

// 3. The fixes: the next build and reload apply every plugin, the prices provider and its consumer together.
// 把上述坏片段逐个换回合法源码，同时让成功的新一代值与旧值不同以便观察。
await edit("greeter/label.ts", '"hello" +', '"hi"');
await edit("boot/server.ts", 'throw new Error("boot: config missing");\n\n', "");
await edit("boot/server.ts", 'constant("v1")', 'constant("v2")');
await edit("counter/server.ts", '() => {\n\tthrow new Error("counter: no seed");\n}', "() => ({ start: constant(2) })");
await edit("prices/server.ts", "constant(250", "constant(300)");
const good = await buildDirty(["@example/greeter", "@example/boot", "@example/counter", "@example/prices"]);
console.log("3. fixed:");
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
console.log("4. status:", status.text.value);
await edit("cache/server.ts", 'const generation = "v1"', 'const generation = "v2"');
const cache = await buildDirty(["@example/cache"]);
// 状态观察者发现引用离开 live 时取消重载等待；取消发生在提交之后，不撤销已提交代码。
const abort = new AbortController();
const watchStatus = await status.state.watch(context);
// 回调接收 value/failed 联合，只有 value 才有引用生命周期状态；返回 Promise<void>。
watchStatus.start(async (call) => {
	// 非值调用直接返回，避免把失败通知当状态对象使用。
	if (call.kind !== "value") return;
	console.log("   the status reference:", call.value.kind);
	// AbortController.abort 同步置位并通知信号监听者；Error 是本例指定的取消原因。
	if (call.value.kind !== "live") abort.abort(new Error("the app shuts down"));
});
try {
	// 派生上下文沿用基础上下文的其他字段，只附加这次控制器的 signal。
	await plugins.reload(host, cache, withAbortSignal(abort.signal, context));
} catch (error) {
	// catch 默认 unknown；运行时 isChordError 同时识别 Chord 错误及指定代码，其余异常必须重新抛出。
	if (!isChordError(error, "aborted")) throw error;
	console.log("   rejected:", error.code, error.message, JSON.stringify(error.details));
}
// 新 cache 继续激活；等待状态证实提交仍生效，再触发另一插件重载检查组件记住了该代代码。
await until(() => status.text.value === "cache v2");
console.log("   status:", status.text.value);
await edit("greeter/label.ts", '"hi"', '"hey"');
print(await plugins.reload(host, await buildDirty(["@example/greeter"]), context));
console.log("   after another reload:", status.text.value, "| greeting:", greeting.text.value);

// 停观察、关主机、关文件监听器，最后递归删除临时副本；不执行真实天气服务或认证。
await watchStatus.stop();
await host.close(context);
plugins.close();
await rm(root, { recursive: true, force: true });
