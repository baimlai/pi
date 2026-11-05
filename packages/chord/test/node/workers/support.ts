// Test support for the workers component (slice 10 §3, §4): a server routing `Session` to forked fixture workers, the
// fixture plugins copied into a temporary root, each address's start data (its behaviour) chosen by the test.

import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { hostKind, remote, str } from "../../../src/contracts/index.ts";
import { createHost, type Host, type HostError } from "../../../src/host/index.ts";
import * as chord from "../../../src/index.ts";
import type { JsonValue } from "../../../src/json.ts";
import { createPlugins, type Plugins } from "../../../src/node/plugins/index.ts";
import { createWorkers, type Workers, type WorkersError } from "../../../src/node/workers/index.ts";
import { Session, type WorkerBehaviour } from "../fixtures/workers/control.ts";

/** The server's own kind. */
// server 是测试宿主种类的合同令牌；此行声明种类，不创建服务器或监听端口。
export const Server = hostKind("server");

/** The fixture plugin's notes at a worker. */
// 声明 worker 暴露的 Notes 合同：id 选定 session 地址，main 变体只读一个字符串 label。
export const Notes = remote("test.notes", {
	version: 1,
	params: { id: str() },
	// 参数解构取 id，再生成同 id 的 worker 地址；例如 id="s1" 的请求路由到 Session({id:"s1"})。
	hostAddress: ({ id }) => Session({ id }),
	variants: { main: { state: { label: str() } } },
});

/** The principals of these tests. */
// 用 kind 区分服务器、worker 和访客；readonly 是开发期写入限制，不会在运行时冻结或校验 IPC 数据。
export type TestPrincipal =
	| { readonly kind: "server" }
	| { readonly kind: "worker"; readonly id: string }
	| { readonly kind: "guest"; readonly id: string };

// 把夹具 worker 的模块 URL 变成绝对路径，用作 fork 的 Node 入口。
const ENTRY = fileURLToPath(new URL("../fixtures/workers/worker.ts", import.meta.url));

// 定位随仓库保存的夹具插件，稍后复制进临时根再编辑。
const PLUGINS = fileURLToPath(new URL("../fixtures/workers/plugins/", import.meta.url));

// 每个测试资源记录包含临时根与异步关闭函数；函数类型 () => Promise<void> 表示不带参数、等待清理完成。
const made: { readonly root: string; readonly close: () => Promise<void> }[] = [];

// 测试结束逐个关闭进程/宿主/插件组件，再删除其临时根；splice 同时清空登记表。关闭失败会中断此钩子。
afterEach(async () => {
	// 对象解构取出当前资源；先 close 是为了避免仍运行的 worker 使用已删除目录。
	for (const { root, close } of made.splice(0)) {
		// 等待组件关闭；这是实际进程清理，不是单纯清空 JavaScript 变量。
		await close();
		// 递归删除本测试创建的目录，force 允许目录已不存在。
		await rm(root, { recursive: true, force: true });
	}
});

/** A server with workers; closed after the test. */
// Fleet 是返回给测试的一组资源及观测记录；数组/Map 可由测试读取，behaviours 可在启动前设置行为。
// 例如 behaviours.set("s1",{hang:true}) 会让下一次 s1 worker 永不完成加载。类型本身不会启动任何进程。
export type Fleet = {
	readonly server: Host<TestPrincipal>;
	readonly workers: Workers<typeof Session>;
	readonly plugins: Plugins;
	/** The copy of the fixture plugins. */
	readonly root: string;
	readonly errors: WorkersError[];
	readonly hostErrors: HostError[];
	/** The addresses `start` ran for, in order. */
	readonly starts: string[];
	/** The workers' stdout lines, each with its address key. */
	readonly output: string[];
	/** Each address's behaviour (its start data); none: a plain worker. */
	readonly behaviours: Map<string, WorkerBehaviour>;
	/** Writes `label` into the copy's notes plugin. */
	label(label: string): Promise<void>;
};

/** Starts a server routing `Session` to fixture workers; `options` override the workers' defaults. */
// 搭建可按地址启动 fixture worker 的服务器，返回 Fleet；默认暂不 fork，首次远端 hold 才启动。
// options 可替换空闲时间、心跳和 start/principal/authorize 钩子；省略即使用测试默认值。
// 函数会复制插件、创建 watcher 并构建 worker 脚本；注册 afterEach 清理。文件/构建错误以 Promise 拒绝传播。
export async function fleet(
	options: {
		readonly idleMs?: number;
		readonly heartbeat?: { readonly ping?: number; readonly close?: number };
		readonly start?: (address: { readonly key: string }, context: Context) => Promise<JsonValue>;
		readonly principal?: () => TestPrincipal;
		readonly authorize?: () => boolean;
	} = {},
): Promise<Fleet> {
	// mkdtemp 使用随机后缀隔离并行测试的插件副本与锁名。
	const root = await mkdtemp(join(tmpdir(), "chord-workers-"));
	// 递归复制所有 worker 夹具插件，后面的 label 编辑仅影响副本。
	await cp(PLUGINS, root, { recursive: true });
	// 分开收集 worker 组件错误与内核 HostError；这些数组不自动断言，具体测试决定检查哪些错误。
	const errors: WorkersError[] = [];
	// 保存宿主报告的后台错误，避免它们只出现在控制台。
	const hostErrors: HostError[] = [];
	// 记录 start 钩子每次被调用的地址 key，用来识别是否发生意外重启。
	const starts: string[] = [];
	// 按 session id 保存启动行为；Map 的值是 WorkerBehaviour，而不是从外部自动验证过的输入。
	const behaviours = new Map<string, WorkerBehaviour>();
	// 保存 stdout 文本块，后面加地址前缀；一个块不保证恰好一行。
	const output: string[] = [];
	// 把本进程的 Chord 模块映射给插件构建/求值使用。
	const modules = { "@earendil-works/chord": chord };
	// 创建仅有 worker kind 的插件组件；根是临时副本，Node 平台允许宿主包映射中的名字。
	const plugins = createPlugins(
		{ roots: [root], kinds: { worker: { platform: "node", hostPackages: Object.keys(modules) } }, onError: () => {} },
		context,
	);
	// 创建有地址和 server principal 的 Chord 宿主；泛型 TestPrincipal 在开发期约束身份形状。
	const server = createHost<TestPrincipal>({
		// 服务器地址由种类令牌生成；principal 是本宿主在本地调用时的身份。
		address: Server(),
		principal: { kind: "server" },
		// 后台宿主错误回调把错误保存到 hostErrors；这里不把所有错误都当成测试失败。
		onError: (error) => hostErrors.push(error),
		// 条件对象展开：未传 heartbeat 时保留内核默认值，传入时才覆盖，不能用空对象改变其存在语义。
		...(options.heartbeat === undefined ? {} : { heartbeat: options.heartbeat }),
	});
	// 把 Session 路由交给 worker 组件；它持有 fork、控制消息与停止策略，宿主负责对象通信。
	const workers = createWorkers(
		server,
		Session,
		{
			// 脚本取 worker facet；entry 是夹具入口，execArgv 让子进程按 source 条件读取 TS 源文件并擦除类型。
			kind: "worker",
			entry: ENTRY,
			execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
			// ?? 只在钩子为空值时回退为允许所有；principal 默认用地址中的 id 生成 worker 身份。
			authorize: options.authorize ?? (() => true),
			principal: options.principal ?? ((address) => ({ kind: "worker", id: address.params.id }) as const),
			// 每次启动先记录地址，再调用可选 start 钩子；未替换时读取 behaviours 的当前值作为 JSON 启动数据。
			start: async (address, startContext) => {
				// push 会改变 starts，供调用测试按顺序断言。
				starts.push(address.key);
				// 调用方钩子得到启动专用上下文，可通过它的 abortSignal 配合取消。
				if (options.start !== undefined) return options.start(address, startContext);
				// 缺少行为则发送空对象；as JsonValue 仅用于类型适配，不会在运行时转化或校验对象。
				return (behaviours.get(address.params.id) ?? {}) as JsonValue;
			},
			// 把随机临时根和地址放入锁名，测试之间互不争同一把锁。
			lock: (address) => `chord-test:${root}:${address.key}`,
			// 每次需要时取 options.idleMs；未配置为一分钟，这与正式组件默认五分钟无关。
			idleMs: () => options.idleMs ?? 60_000,
			plugins,
			// 输出回调只收 stdout，忽略 stderr；Buffer.from(chunk).toString() 解码后 trim 去块两端空白。
			onOutput: (address, stream, chunk) => {
				// 给每个 stdout 块加地址 key，便于多 worker 同时输出时区分来源。
				if (stream === "stdout") output.push(`${address.key} ${Buffer.from(chunk).toString().trim()}`);
			},
			// 组件后台错误保存到 errors，不在此回调中抛出。
			onError: (error) => errors.push(error),
		},
		context,
	);
	// 先完成空插件集的初次发布，之后 server.get/hold 才可合法使用。
	await server.load([], context);
	// The worker kind's set made now (discovery, builds): the watcher marks edits from then on.
	// 提前完成发现与脚本构建，并建立 watcher 的输入依赖；此时仍未启动 worker 子进程。
	await plugins.scripts("worker", context);
	// 清理函数依次停 workers、关闭 server、关闭插件 watcher；没有吞异常，前一步失败会向 afterEach 传播。
	const close = async () => {
		// 先停子进程，防止关闭宿主后留下仍运行的 worker。
		await workers.close(context);
		// 再结束服务器对象与链接。
		await server.close(context);
		// 同步关闭文件 watcher；插件目录随后才能删除。
		plugins.close();
	};
	// 把本次资源登记给 afterEach；返回前的构建若失败，本函数尚未执行此登记。
	made.push({ root, close });
	// 对象属性简写把局部资源与观测数组返回给测试；引用相同，后续回调写入会被测试看到。
	return {
		server,
		workers,
		plugins,
		root,
		errors,
		hostErrors,
		starts,
		output,
		behaviours,
		// label 方法覆盖副本中的 label.ts；JSON.stringify 转义字符串为合法 JS 字面量，不直接拼裸用户文本。
		label: (label) => writeFile(join(root, "notes", "label.ts"), `export const label = ${JSON.stringify(label)};\n`),
	};
}

/** Waits until `ready()` holds, polling every 10 ms, for at most `ms`. */
// 每 10 ms 检查 ready，成功返回 void，超过 ms 抛错；例如等待 workers.state 出现 running。
// 默认 10 秒是轮询预算，不是精确执行时间；ready 抛出的异常也直接传播，本函数不创建后台永久轮询。
export async function until(ready: () => boolean, ms = 10_000): Promise<void> {
	// 根据调用时的墙钟计算绝对截止时刻。
	const deadline = Date.now() + ms;
	// 每轮先调用断言条件；已满足时不等待任何定时器。
	while (!ready()) {
		// 只有超过而非恰好等于截止时刻才抛超时错误。
		if (Date.now() > deadline) throw new Error("until: timed out");
		// 把 setTimeout 包成 Promise，让出事件循环；resolve 由定时器调用。
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

// 重导出背景上下文与 session kind，测试可从同一个支撑模块取得相同合同令牌。
export { context, Session };
