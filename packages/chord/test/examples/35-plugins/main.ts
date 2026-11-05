// 文件导读
// 所属：packages/chord/test/examples/35-plugins，Chord v2 示例 35，对应 slice 7c（插件目录：发现、构建、逐插件装载与发布）。
// 演示内容：plugins/ 是真实插件根：@example/clock 只有 server facet，@example/contracts 只有契约、没有 facet，
// @example/notes 同时有 server 和 worker facet，二者都展示同一份 label.ts。脚本把整个目录复制到系统临时目录，
// 在副本里改写 notes/label.ts，观察 watcher 的标记，再构建脏插件并按 server、worker 的顺序 rollout；
// 持有者看到标签 v2，计数保持不变，未被编辑的 clock 对象没有重新求值。
// 目录与清单：三个 plugins/*/package.json 只提供插件名（name 是宿主里的插件身份）、private 和 type:module；
// 它们决定发现与重名规则，本示例不修改。facet 文件与服务的关系见各插件目录下的 TS 文件头。
// 上游入口：命令行直接运行；所有宿主（server/worker）都在本进程内。
// 下游调用：createPlugins（discoverPlugins/buildFacet/evaluateFacet/PluginWatcher/rollout）、createHost/route/connect、
// plugins.load/state/build/step/rollout、Host.get、对象方法、watch。
// 文件与副作用：mkdtemp 建临时根，cp 递归复制 plugins/，writeFile 改写副本中的 label.ts，末尾 rm 删除；
// 构建只产生内存中的脚本数据，不写入插件目录。
// 失败行为：模块顶层的 await 一旦拒绝（I/O、构建、宿主调用），后续清理不会执行（文件末尾不是 finally）；
// onError 只打印 watcher/批处理错误 kind；两个 load 的 failed 数组本例都为空；构建/求值失败会以 failed 结果出现在报告里。
// 能力清单（按演示机制列出，本文件没有导出）：
// - modules/node：宿主包映射与 Node 构建规则；chord 命名空间导入保持为外部包。
// - plugins：完整插件组件；discovery 是最近一次发现，state 是 watcher 的 JSON watchable。
// - until：轮询等待条件，处理 watcher/远程状态的异步时序。
// - server/worker：两个内存宿主；route 把 Worker 地址解析到 worker，load 各自装载自己的 kind。
// - Notes/Index/Clock：远程与本地契约；notes 的 label/count、index 的 label、clock 的 evaluatedAt。
// - 主流程：发现 → load → 读取 v1 → 改文件 → 标脏 → build → rollout（server 后 worker）→ 读 v2 与未变对象 → 清理。
// 典型运行顺序：createPlugins → load(worker) → load(server) → get Notes/Index/Clock → notes.add(ctx) → watch label →
// writeFile(label.ts) → until(dirty 含 notes) → build(dirty) → step(server)/step(worker) → rollout → until(label==="v2") →
// 读结果 → stop watch/close hosts/plugins.close → rm 临时目录。
// 示例（真实签名）：
//   const plugins = createPlugins({ roots: [root], kinds: { server: node, worker: node }, onError }, context);
//   const loaded = await plugins.load(server, { kind: "server", core: [], modules }, context);
//   const built = await plugins.build(plugins.state.value.dirty, context);
//   const result = await plugins.rollout([plugins.step("server", server)], built, context);
// 以上是真实 API 形状；实际脚本按下面的代码使用这些返回值。
// 阅读顺序：先看 modules/node 与 createPlugins 的配置，再看两个宿主、load 与读取，然后看文件编辑/标脏，最后看 build/rollout。
// 前置条件：Node 支持 --experimental-strip-types，且本机可解析 esbuild（Chord 的可选 peer 依赖）。在 packages/chord 下运行：
//   node --conditions=source --experimental-strip-types test/examples/35-plugins/main.ts
// 预期输出（本机实测；rollout 帧与报告行的先后可能随调度变化）：
//   1. discovered: @example/clock [server], @example/contracts [], @example/notes [server,worker]
//      load failures: worker 0 | server 0
//      notes: v1 count 1 | index: v1
//   2. marks after the edit: {"dirty":["@example/clock","@example/notes"],"install":["@example/clock"],"set":true,"base":false}
//   3. built: [
//     '@example/clock/server: script',
//     '@example/notes/server: script',
//     '@example/notes/worker: script'
//   ]
//      a frame on the server's reference: "v2"
//      server: {"added":[],"changed":["@example/notes"],"removed":[]} objects [{"object":"example.index","kind":"swapped"}]
//      worker: {"added":[],"changed":["@example/notes"],"removed":[]} objects [{"object":"example.notes","kind":"swapped"}]
//   4. notes: v2 count 1 | index: v2
//      clock untouched: true
//      marks after the rollout: {"dirty":[],"install":["@example/clock"],"set":false,"base":false}
// 说明：watcher 的 dirty/install/set 是文件事件驱动的，精确集合随时序/平台变化；本机在首次 load 后就已经记录了
// clock 的 install/set 标记（watcher 收到了该插件目录/清单的文件事件），因此 dirty 额外含 clock。示例真正依赖的是：
// load 失败为 0、notes/index 变为 v2、count 仍为 1、clock 对象未重新求值；不要把上面某个 JSON 的精确集合当作协议。
// 相关文档：packages/chord/docs/slice-7c.md（§1 插件目录、§2 构建、§3 求值、§4 逐插件装载、§5 监视与 rollout）；
// 相关测试：test/node/plugins/ 的 discovery/build/evaluate/runtime/watcher/rollout 用例。
// 在临时副本中修改插件标签，演示“发现→构建→加载→标脏→分步重载”；所有主机都在本进程中。
// 顶层 await 会让模块等这一阶段完成再继续；I/O、构建或主机调用失败会直接拒绝模块执行，文件末尾不是 finally。
// Plugins (slice 7c): plugin directories turned into facets, loaded on their hosts, watched, rebuilt and rolled out.
// A plugin is a directory with a `package.json` (its name) and one file per facet kind (`server.ts`, `worker.ts`);
// `createPlugins` discovers them, builds each facet into a script with esbuild (host packages external) and evaluates
// it on Node. Here (`plugins/`): a contracts-only plugin, `@example/notes` with a server and a worker facet showing one
// label, and `@example/clock`, which the example never edits. A server and a worker load them; the notes' label is
// edited on disk, the watcher marks the plugin, the app builds it and rolls it out (server, then worker), a holder sees
// one frame, and the clock plugin is untouched (not in the reports, its object the same).
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/35-plugins/main.ts
// Node 内建模块：临时目录/复制/删除/写文件；ESM 下用 import 而不是 require。
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Chord 自身的导入：context、宿主、完整库命名空间（作为插件的宿主包）、内存链路、插件组件。
// `import * as chord` 得到的是本进程已加载的模块实例；构建时把 "@earendil-works/chord" 保持为外部，
// 求值时再把该实例交给插件，所以插件里的 defineFacet 与应用见到的是同一个模块（instanceof 也一致）。
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { createHost, type Host } from "../../../src/host/index.ts";
import * as chord from "../../../src/index.ts";
import { memoryLinkPair } from "../../../src/link/index.ts";
import { createPlugins } from "../../../src/node/plugins/index.ts";
import { Clock, Index, Notes, Worker } from "./plugins/contracts/contract.ts";

// 这里使用不会主动取消的基础上下文；异步 Chord 操作仍要求显式传入它。
const context = BACKGROUND_CONTEXT;

// The example edits files: it works on a copy of `plugins/`, removed at the end.
// mkdtemp 添加随机后缀避免改到真实样例；cp 递归复制插件文件，接下来的 writeFile 只改副本。
// new URL("./plugins/", import.meta.url) 相对 main.ts 定位源目录；fileURLToPath 把 file: URL 转成文件系统路径。
// 复制在 createPlugins 之前完成；按设计 watcher 只响应之后的变更，但本机仍收到复制/构建阶段延迟到达的文件事件，
// 所以步骤 2 的标记不只有这次编辑（见下方说明）。
const root = await mkdtemp(join(tmpdir(), "chord-example-35-"));
await cp(fileURLToPath(new URL("./plugins/", import.meta.url)), root, { recursive: true });

/** Waits until `ready()` holds (the watcher's events arrive on their own time). */
// 输入是无参数、返回 boolean 的检查函数，结果是完成时无值的 Promise<void>。
// 每次先检查，不满足便用定时器让出事件循环；例如 until(() => label === "v2") 等待标签变化。
// 它没有超时或取消：条件一直不成立会一直等；ready 抛出的错误会使返回的 Promise 拒绝。
// 主要流程：while 每轮同步求值 ready；假则 await 一个 10ms 定时器，把控制权还给 watcher/链路回调，再检查。
// 示例（真实签名）：await until(() => plugins.state.value.dirty.includes("@example/notes"));
async function until(ready: () => boolean): Promise<void> {
	// new Promise 把一次 10ms 定时器转成可 await 的等待；实际唤醒可能晚于 10ms。
	while (!ready()) await new Promise((resolve) => setTimeout(resolve, 10));
}

// 1. The component: the roots, and the facet kinds, each built for Node with Chord as a host package (kept external in
//    the builds). The hosts give the modules themselves when they load (this process's Chord: a plugin's
//    `import { defineFacet } from "@earendil-works/chord"` is the app's own instance).
// 模块映射把插件的外部 import 绑定到本进程的 Chord；Object.keys 得到构建时保留为外部依赖的名称。
const modules = { "@earendil-works/chord": chord };
// as const 只把 TS 推断收窄为字面量/只读类型，不会在运行时冻结对象。
const node = { platform: "node", hostPackages: Object.keys(modules) } as const;
// 创建组件立即启动监听器，目录发现和首次构建则在 load 等首次使用时发生。
const plugins = createPlugins(
	{
		// roots 按顺序发现插件；本例只有临时副本一个根目录。
		roots: [root],
		// 相同 Node 构建规则分别用于 server 和 worker 两种 facet 文件。
		kinds: { server: node, worker: node },
		// 后台监听/发布错误只打印 kind；这不是吞掉所有 load/build 错误的 catch。
		onError: (error) => console.log("plugins:", error.kind),
	},
	context,
);

// 2. A worker and a server joined by a memory link; each loads the plugins' facets of its kind (no core facets here).
// | 是联合类型，kind 可供 TypeScript 区分两种身份；readonly 仅约束编译期赋值。
type P = { readonly kind: "server" } | { readonly kind: "worker" };
// 解构取得内存链路两端；消息通过微任务投递，不会创建操作系统子进程。
const [up, down] = memoryLinkPair();
// Worker() 生成 worker 地址；<P> 指定本例的 principal 类型，空 onError 不显示主机后台诊断。
const worker = createHost<P>({ address: Worker(), principal: { kind: "worker" }, onError: () => {} });
// 先连接再加载；principal 指连接另一端的 server 身份。
worker.connect(up, { principal: { kind: "server" } }, context);
// server 是本地宿主（无 address）；它按需通过 route 解析 Worker 地址，供 Notes 的远程引用使用。
const server = createHost<P>({ principal: { kind: "server" }, onError: () => {} });
// 路由只在第一次需要该 worker 时解析；本例无条件授权，异步回调复用早已建立的 down 端。
server.route(
	Worker,
	{ authorize: () => true, resolve: async () => ({ link: down, principal: { kind: "worker" } }) },
	context,
);
// 每个主机只加载自己的 facet；core: [] 表示没有额外内置 facet，失败插件列在 failed 中。
// load 返回 LoadReport：失败插件的 build/evaluate/setup 错误在 failed 数组里，非必选插件的失败不会让 load 拒绝。
// kind 同时决定发现时读取哪些 facet 文件，以及当前集合（plugins.scripts(kind)）使用哪一份构建。
const workerLoad = await plugins.load(worker, { kind: "worker", core: [], modules }, context);
const serverLoad = await plugins.load(server, { kind: "server", core: [], modules }, context);
// map 从发现结果提取名称和 facet 名，join 仅把展示用字符串连接起来。
console.log(
	"1. discovered:",
	plugins.discovery.plugins.map(({ name, facets }) => `${name} [${Object.keys(facets)}]`).join(", "),
);
console.log("   load failures: worker", workerLoad.failed.length, "| server", serverLoad.failed.length);
// get 等到引用绑定且状态已就绪；Notes 地址在 worker 上，所以 server 会沿刚注册的路由取它。
// Index/Clock 是 server 上的 local 对象；空 params 不是方法参数，而是对象身份的一部分。
const notes = await server.get(Notes, {}, context);
const index = await server.get(Index, {}, context);
const clock = await server.get(Clock, {}, context);
// add 无业务参数，只传上下文；计数写入 worker 文档，提交后才返回。
await notes.add(context);
// 保存旧求值时间，用末尾的 === 对比说明 clock 插件本轮未重新求值。
const evaluatedAt = clock.evaluatedAt.value;
console.log("   notes:", notes.label.value, "count", notes.count.value, "| index:", index.label.value);
// watch 原子取得当前值并开始缓冲后续更新；start 安装监听函数，不额外打印 watch 的初值。
const watch = await notes.label.watch(context);
// 回调输入是 value/failed 联合；本例只输出 value，失败调用不会被打印，async 返回无值 Promise。
watch.start(async (call) => {
	// 先按 kind 收窄，才能访问 value；JSON.stringify 只用于控制台展示，不影响原状态。
	if (call.kind === "value") console.log("   a frame on the server's reference:", JSON.stringify(call.value));
});

// 3. An edit on disk (the app's editor, a git pull): the watcher marks the plugin dirty; nothing is applied yet.
// 写入的源码字符串保持原样；文件事件异步到达，所以接着轮询 dirty 标记，而非立即假设已监听到。
// join 按平台分隔符拼路径；写入内容是完整文件（覆盖），字符串里 \n 是换行转义，不改变插件 API。
await writeFile(join(root, "notes", "label.ts"), 'export const label = "v2";\n');
// until 只保证 notes 出现在 dirty；本机实测此时 dirty 还含 clock（首次 load 前后已产生该标记），
// 因此下一行 JSON 的集合不是“仅这次编辑”的精确结果。build 会按整个 dirty 列表重建，clock 也会被重新打包。
await until(() => plugins.state.value.dirty.includes("@example/notes"));
console.log("2. marks after the edit:", JSON.stringify(plugins.state.value));

// 4. The app builds the dirty plugins and rolls the build out: the server first, then the worker. Each step reloads its
//    host with the facets of its kind; the clock plugin was not built, so it keeps its facet and its object.
// 原始英文说 clock “没被构建”；本机 dirty 含 clock，所以它也被重新打包。关键不在是否调用 build，而在于源码/摘要
// 未变：runtime 复用同一 facet，宿主视其为 unchanged，因此报告里没有 clock，对象也不重新激活。
// as Host<P> 是编译期类型断言，不会转换主机；step 捕获 load 时记住的主机 kind。
const steps = [plugins.step("server", server as Host<P>), plugins.step("worker", worker as Host<P>)];
// build 只产生脚本数据；真正改变运行代码的是下面 rollout，按 steps 顺序先 server 后 worker。
// 名字来自整个 dirty 列表（本机含 clock），所以 built.facets 也会列出 clock/server；其源码和摘要未变。
// build 返回的 Built 是普通数据：facets 是 BuiltFacet 数组，plugins 是本次参与构建的发现记录，removed 是消失的插件名。
const built = await plugins.build(plugins.state.value.dirty, context);
console.log(
	"3. built:",
	built.facets.map(({ plugin, facet, kind }) => `${plugin}/${facet}: ${kind}`),
);
// rollout 对每个步骤先 ship 该 step.kinds 的构建到当前集合，再调用 step.reload；某步抛错会停止后续步骤。
// 本例两步都成功，因此 server 先换 notes/index，worker 再换 notes；clock 的摘要未变，重载时复用同一 facet。
const rolled = await plugins.rollout(steps, built, context);
// 两层 for…of 遍历步骤及各主机；解构直接取出步骤名称和主机结果列表。
for (const { name, hosts } of rolled.steps) {
	for (const host of hosts) {
		// in 检查联合结果中是否有 report；stopped/error 分支在本例不打印。
		if ("report" in host) {
			console.log(
				`   ${name}:`,
				JSON.stringify(host.report.plugins),
				"objects",
				JSON.stringify(host.report.objects),
			);
		}
	}
}
// reload 报告不保证所有对象此时已经 live，因此继续等待跨内存链路的标签实际变成 v2。
await until(() => notes.label.value === "v2");
// count 仍为 1：worker 上的 Notes 是纯对象，reload 原地 swap 代码，状态文档没有重建。
console.log("4. notes:", notes.label.value, "count", notes.count.value, "| index:", index.label.value);
// evaluatedAt 与保存值相同：clock 的构建摘要没变，runtime 复用同一 facet，宿主因此视为未变化，不重启对象。
console.log("   clock untouched:", clock.evaluatedAt.value === evaluatedAt);
// rollout 只清除“已成功发布且构建后未再变化”的 dirty 标记；clock 的 install 标记仍保留（脚本没有执行安装）。
console.log("   marks after the rollout:", JSON.stringify(plugins.state.value));

// 按顺序停止观察、关闭主机和监听器，再删临时目录；此前任何语句抛错可能跳过这段清理。
await watch.stop();
await server.close(context);
await worker.close(context);
plugins.close();
await rm(root, { recursive: true, force: true });
