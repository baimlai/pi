// A rollout across the server and its workers (slice 10): an edit of a plugin is built once by the server and rolled
// out step by step, the server first, then every running worker; each host reports what changed.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/43-rollout/main.ts
// 文件导读
// 所属：packages/chord/test/examples/43-rollout，Chord slice 10 的 rollout（灰度发布）示例。
// 演示什么：插件文件被修改后，watcher 把插件标为 dirty；服务器只构建一次（server 与 worker 两种 facet 都在
//   这次构建里），然后按步骤发布：先在服务器进程内 reload，再把完整脚本集合发给每个运行中的 worker 并重载。
//   发布结果逐宿主列出，引用在重载后继续指向同一个对象身份，状态值更新为新代码产生的值。
// 上游/下游：由下一行命令启动；上游是 Node 文件系统（示例把 ./plugins 复制到临时目录再编辑，避免改动仓库）
//   与 plugins/notes 的契约；下游调用 createPlugins（发现/构建/监视/rollout）、createWorkers、createHost 和
//   宿主引用。脚本会创建并删除一个临时目录（mkdtemp 前缀 chord-example-43-），不联网。
// 能力清单（按演示步骤）：
// - waitUntil：轮询条件辅助。
// - describe：把 RolloutHost 的三种结果转成一行文字。
// - 临时目录复制：cp 递归复制 ./plugins，编辑其中的 label.ts。
// - createPlugins：同时声明 server 与 worker 两种 facet 的构建配置。
// - createHost/createWorkers：服务器与两个会话 worker。
// - server.get(Banner/Label)：服务器本地对象与两个远程对象。
// - plugins.build/rollout/step：一次构建、两步发布。
// 典型运行顺序：复制插件 -> 装配 -> load 服务器 -> 读取 v1 -> 改文件 -> 等 dirty -> build ->
//   rollout（server 步、workers 步）-> 等远程状态更新 -> 打印 -> 释放/关闭/删除临时目录。
// 预期输出（示例，本机运行形状；worker 名与 pid 每次可能不同）：
//   1. server: v1 | S1: v1 | S2: v1
//   2. server: server changed @example/notes
//   2. workers: session|S1 changed @example/notes
//   2. workers: session|S2 changed @example/notes
//   3. server: v2 | S1: v2 | S2: v2
//   4. still dirty: ["@example/notes"]
// 第 4 行是当前脏标记的快照。rollout 只清除“构建快照之前没有再次变化”的标记；文件系统可能在构建开始后
//   又送来事件（尤其 macOS 的 FSEvents），所以这里仍看到该插件。它表示可以再构建一次，不是发布失败。
// 注意：脚本没有 try/finally；中途抛错会留下临时目录。示例为了保持流程简短省略了清理保护。
// 建议阅读顺序：先读 plugins/notes 下的 contract.ts、label.ts 与两个 facet，再回到本文件的 build/rollout 两步。
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
// cp 递归复制目录；mkdtemp 创建唯一临时目录；rm 删除；writeFile 覆写插件源文件。都是 Promise API。
import { tmpdir } from "node:os";
import { join } from "node:path";
// join 拼接平台相关的路径；tmpdir() 返回系统临时目录。
import { fileURLToPath } from "node:url";
// 把 file: URL 转成文件系统路径（cp 的源、临时根目录的建立、子进程 entry 都需要路径）。
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { hostKind } from "../../../src/contracts/index.ts";
import { createHost } from "../../../src/host/index.ts";
import * as chord from "../../../src/index.ts";
// 命名空间导入整个 Chord 公开入口，作为插件求值时的宿主包实例（modules 映射的值）。
import { createPlugins, type RolloutHost } from "../../../src/node/plugins/index.ts";
// `type RolloutHost` 是内联类型导入：只导入类型，编译后被擦除；它描述 rollout 在一个宿主上的三种结果。
import { createWorkers } from "../../../src/node/workers/index.ts";
import { Banner, Label, Session } from "./plugins/notes/contract.ts";

/** Waits until `done()` holds (a watcher's mark, a frame from a worker), checking every 10 ms. */
// 轮询辅助：每 10ms 调用一次 done()，直到它返回 true。返回 Promise<void>，调用方 await 它。
// 没有超时或取消参数：条件永远不成立时会无限等待；示例依赖条件最终成立。
// 示例（示例）：await waitUntil(() => s2.text.value === "S2: v2") 等待远程状态更新。
async function waitUntil(done: () => boolean): Promise<void> {
	while (!done()) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** One line for what a rollout step did on one of its hosts. */
// 输入 RolloutHost（联合类型），输出一行文字：
// - 有 report 字段：宿主正常重载，report.plugins.changed 是变化的插件名；
// - 有 stopped 字段：宿主在步骤中干净停止（下次启动会拿当前脚本集合）；
// - 其余：宿主崩溃或重载失败，只有 error 字段。
// `"report" in host` 是运行时属性检查，TypeScript 用 in 收窄联合类型，之后才能访问 host.report。
function describe(host: RolloutHost): string {
	if ("report" in host) return `changed ${host.report.plugins.changed.join(", ")}`;
	if ("stopped" in host) return "stopped";
	return "failed";
}

// The example edits a plugin: it works on a copy of `plugins/`.
// mkdtemp 在系统临时目录下创建唯一目录，前缀便于识别；cp 递归复制示例插件。后续编辑只作用于副本，
// 不修改仓库里的源文件。注意：失败路径没有删除临时目录（见文件导读）。
const root = await mkdtemp(join(tmpdir(), "chord-example-43-"));
await cp(fileURLToPath(new URL("./plugins/", import.meta.url)), root, { recursive: true });

// 两种 facet 共用同一个构建配置。`as const` 让 platform 保持字面量 "node"、hostPackages 保持只读元组类型，
// 从而满足 KindDefinition 的 "node" | "browser" 与 readonly string[]；若不加 as const，platform 会被推断为
// string，赋值时报类型错误。hostPackages 中的说明符在构建产物里保持外部，由宿主在求值时提供。
const node = { platform: "node", hostPackages: ["@earendil-works/chord"] } as const;
// roots 指向刚才的临时副本，因此 watcher 监视的是副本；kinds 同时声明 server 与 worker，
// 使 notes 插件目录里的 server.ts 与 worker.ts 都被发现和构建。
const plugins = createPlugins(
	{ roots: [root], kinds: { server: node, worker: node }, onError: console.error },
	context,
);
// 服务器宿主：地址 server（无参数），principal 是 server；onError 打印内部错误。
const server = createHost({ address: hostKind("server")(), principal: { kind: "server" }, onError: console.error });
// 两个会话的 worker 与 41 相同：按需 fork，空闲默认 5 分钟停止；onError 打印 workers 组件错误。
const workers = createWorkers(
	server,
	Session,
	{
		kind: "worker",
		entry: fileURLToPath(new URL("./worker.ts", import.meta.url)),
		execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
		authorize: () => true,
		principal: (address) => ({ kind: "worker", session: address.params.id }),
		start: () => ({}),
		lock: (address) => `example-43:${process.pid}:${address.key}`,
		plugins,
		onError: console.error,
	},
	context,
);
// 加载服务器：kind "server" 的当前脚本集合 + 空 core；modules 提供插件 import "@earendil-works/chord" 时
// 使用的本进程模块实例。load 之后 notes 的 server facet 开始服务 Banner。
await plugins.load(server, { kind: "server", core: [], modules: { "@earendil-works/chord": chord } }, context);

// 1. The server's banner and two running sessions.
// Banner 是本地契约（params 为空，服务器上只有一个实例）；Label 是远程契约，hostAddress 指向各自的
// Session 地址，所以两次 get 会启动两个 worker。此时三个对象都显示 label.ts 的 v1。
const banner = await server.get(Banner, {}, context);
const s1 = await server.get(Label, { id: "S1" }, context);
const s2 = await server.get(Label, { id: "S2" }, context);
console.log(`1. ${banner.text.value} | ${s1.text.value} | ${s2.text.value}`);

// 2. An edit: the watcher marks the plugin; one build serves both kinds.
// 覆写副本中的 label.ts。两个 facet 都 import 它，构建时它的字符串会被打进脚本，所以必须重新构建。
await writeFile(join(root, "notes", "label.ts"), 'export const label = "v2";\n');
// 等 watcher 把插件标脏。插件名来自 plugins/notes/package.json 的 name（@example/notes）。
// 文件事件的到达是异步的，不能写完立刻 build。
await waitUntil(() => plugins.state.value.dirty.includes("@example/notes"));
// build 为 dirty 中的插件构建所有 facet（server 与 worker 两种），返回普通数据 Built：包含脚本与发现记录，
// 但还不改变任何宿主；真正的应用由 rollout 完成。Built 还关联了构建开始时的标记快照，供之后清除 dirty。
const built = await plugins.build(plugins.state.value.dirty, context);

// 3. The rollout: the server, then the workers (each running one reloads in parallel).
// 两步按数组顺序执行：
// - plugins.step("server", server)：进程内步骤，调用组件的 reload(server, built)，只重载服务器；
// - workers.step("workers")：把 worker kind 的完整集合 ship 给所有运行中/启动中的 worker，并并行重载它们。
// 每一步拿到 built 中属于自己的那些 facet；失败或崩溃的宿主不会中断整个 rollout，而是记录在结果里。
const result = await plugins.rollout([plugins.step("server", server), workers.step("workers")], built, context);
// result.steps 按执行顺序保存每个步骤；hosts 是该步骤每个宿主的结果（RolloutHost 联合）。
for (const step of result.steps) {
	for (const host of step.hosts) console.log(`2. ${step.name}: ${host.host} ${describe(host)}`);
}

// 4. Every host shows the new label (the workers' frames arrive over their links).
// 远程对象的更新经链路异步到达，所以轮询等待 S2 的状态变成 "S2: v2"，再一次性打印三个对象。
await waitUntil(() => s2.text.value === "S2: v2");
console.log(`3. ${banner.text.value} | ${s1.text.value} | ${s2.text.value}`);
// 打印当前 dirty 标记。rollout 只清除不晚于构建快照的标记；构建后又到达的文件事件会保留标记，
// 因此这里可能仍看到 @example/notes（本机运行时确实如此），表示可以再构建一轮。
console.log(`4. still dirty: ${JSON.stringify(plugins.state.value.dirty)}`);

// 释放三个引用（不再使用时必须释放），依次停止 workers、服务器与 watcher，最后删除临时目录。
// rm 的 recursive 与 force 让目录不存在时也不报错。
banner.release();
s1.release();
s2.release();
await workers.close(context);
await server.close(context);
plugins.close();
await rm(root, { recursive: true, force: true });
