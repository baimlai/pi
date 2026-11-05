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
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
const root = await mkdtemp(join(tmpdir(), "chord-example-35-"));
await cp(fileURLToPath(new URL("./plugins/", import.meta.url)), root, { recursive: true });

/** Waits until `ready()` holds (the watcher's events arrive on their own time). */
// 输入是无参数、返回 boolean 的检查函数，结果是完成时无值的 Promise<void>。
// 每次先检查，不满足便用定时器让出事件循环；例如 until(() => label === "v2") 等待标签变化。
// 它没有超时或取消：条件一直不成立会一直等；ready 抛出的错误会使返回的 Promise 拒绝。
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
const server = createHost<P>({ principal: { kind: "server" }, onError: () => {} });
// 路由只在第一次需要该 worker 时解析；本例无条件授权，异步回调复用早已建立的 down 端。
server.route(
	Worker,
	{ authorize: () => true, resolve: async () => ({ link: down, principal: { kind: "worker" } }) },
	context,
);
// 每个主机只加载自己的 facet；core: [] 表示没有额外内置 facet，失败插件列在 failed 中。
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
await writeFile(join(root, "notes", "label.ts"), 'export const label = "v2";\n');
await until(() => plugins.state.value.dirty.includes("@example/notes"));
console.log("2. marks after the edit:", JSON.stringify(plugins.state.value));

// 4. The app builds the dirty plugins and rolls the build out: the server first, then the worker. Each step reloads its
//    host with the facets of its kind; the clock plugin was not built, so it keeps its facet and its object.
// as Host<P> 是编译期类型断言，不会转换主机；step 捕获 load 时记住的主机 kind。
const steps = [plugins.step("server", server as Host<P>), plugins.step("worker", worker as Host<P>)];
// build 只产生脚本数据；真正改变运行代码的是下面 rollout，按 steps 顺序先 server 后 worker。
const built = await plugins.build(plugins.state.value.dirty, context);
console.log(
	"3. built:",
	built.facets.map(({ plugin, facet, kind }) => `${plugin}/${facet}: ${kind}`),
);
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
console.log("4. notes:", notes.label.value, "count", notes.count.value, "| index:", index.label.value);
console.log("   clock untouched:", clock.evaluatedAt.value === evaluatedAt);
console.log("   marks after the rollout:", JSON.stringify(plugins.state.value));

// 按顺序停止观察、关闭主机和监听器，再删临时目录；此前任何语句抛错可能跳过这段清理。
await watch.stop();
await server.close(context);
await worker.close(context);
plugins.close();
await rm(root, { recursive: true, force: true });
