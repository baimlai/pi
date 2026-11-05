// Testing a plugin alone (slice 12 §6, decision "Testing a plugin alone"): the plugin built as production builds it,
// evaluated with the app's real API modules, loaded on an in-memory host (a `:memory:` SQLite store) beside stub facets
// serving the contracts it uses. The registries it contributes to that nobody serves are served by the helper, which
// collects their entries for the test; the contracts its requests wait for unserved are listed, so a test knows what
// to stub. No test-only modes: the host, the build and the evaluation are the ones apps run.

import { readdir, realpath, stat } from "node:fs/promises";
// 文件导读
// 所属模块：packages/chord/src/node/plugins 的测试辅助层，对应 slice 12 §6“单独测试一个插件”。
// 职责边界：把插件按生产方式构建、求值，并加载到全新的内存宿主上；收集插件贡献到无人提供的注册表里的条目，列出
// 仍未被满足的契约；不提供测试专用构建/求值模式，也不启动文件监视或组件。
// 上游入口：插件作者的测试代码调用 testPlugin(dir, options, context)；下游依赖 build.ts、discover.ts、evaluate.ts、
// host（createHost/load/reload/root/close）、registries、store/sqlite（:memory:）。
// 结果与错误流向：成功返回 TestedPlugin（活宿主、发现记录、宿主错误、收集到的注册表值、未服务名称）；构建失败、
// 求值失败、插件或桩的 setup 失败、目录不是插件时以 Error 拒绝；失败时尝试关闭宿主和存储后重抛（关闭本身失败会取代原错误）。
// 能力清单：
// - TestPluginOptions：kind、modules、api、kinds、platform、stubs、principal、address。
// - TestedPlugin：host、plugin、errors、contributions、unserved、root、close 的测试结果接口。
// - testPlugin(dir, options, context)：构建/求值/加载/收集一步完成，返回 TestedPlugin。
// 内部能力：rootOf 推断发现根；kindsNamedIn 扫描代码里出现的 kind 名以启用生产同样的每种类检查；pluginIn 在根中
// 定位被测插件；collect/settle/olderAs 收集未声明注册表并等待激活；Tested 类实现 TestedPlugin 并负责关闭。
// 组合与顺序：testPlugin -> 校验版本化模块必须有 api -> rootOf -> kindsNamedIn/pluginIn -> buildFacet -> evaluateFacet ->
// openStore(:memory:) -> createHost -> host.load(stubs + 插件) -> collect（反复 settle/reload 直到无新注册表）-> Tested。
// 示例：const tested = await testPlugin("/app/plugins/notes", {
//   kind: "worker", modules: { "@earendil-works/chord": chord }, stubs: [storeFacet],
// }, context);
// try { await tested.root((ctx) => ctx.get(Notes, {}), context); } finally { await tested.close(context); }
// 真实签名如此；modules 是真实宿主包，stubs 用来提供插件请求的契约/注册表。
// 相关测试：packages/chord/test/node/plugins/testing.test.ts；可在 packages/chord 下运行
// node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/node/plugins/testing.test.ts。
// 建议阅读顺序：TestPluginOptions/TestedPlugin -> testPlugin 主流程 -> rootOf/kindsNamedIn/pluginIn（如何定位插件）->
// collect/settle/olderAs（注册表收集）-> Tested 类。
import { dirname, join } from "node:path";
import type { Context } from "../../context/index.ts";
import type { Address } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import {
	type Ctx,
	createHost,
	defineFacet,
	type Host,
	type HostError,
	type PluginFacet,
	type RootOptions,
} from "../../host/index.ts";
import type { ChordHost } from "../../host/internal.ts";
import {
	defineRegistry,
	type Registry,
	type RegistryAccepts,
	type RegistryTable,
	type RegistryValue,
} from "../../registries/index.ts";
import { openNodeSqliteDatabase } from "../../sqlite/node.ts";
import { openStore, type Store, sqliteBackend } from "../../store/index.ts";
import { type AppApi, buildFacet } from "./build.ts";
import { discoverPlugins, type Plugin } from "./discover.ts";
import { evaluateFacet, type HostPackages } from "./evaluate.ts";

// 测试配置：kind 与 modules 必填，其余按生产方式补齐。泛型 P 只是宿主 principal 的类型参数，运行时不做校验。
/** What `testPlugin` takes besides the plugin's directory. */
export type TestPluginOptions<P extends Principal = Principal> = {
	/** The facet kind to test (`"worker"`): the plugin's facet of it is built and loaded. */
	// 要测试的 facet 种类；测试只构建并加载这一种，而不是插件的全部 facet。
	readonly kind: string;
	/** The real host packages by specifier (the app's API modules: definitions only), as the kind's production host has. */
	// 真实宿主包（应用 API 的模块定义），按说明符传入；插件求值时拿到这些实例，不复制。
	readonly modules: HostPackages;
	/** The app's API, checked as production checks it; required when `modules` hold versioned API modules. */
	// 应用 API 配置。modules 中若含 `/vN` 版本化模块，必须同时提供 api，否则 testPlugin 直接拒绝。
	readonly api?: AppApi;
	/**
	 * The app's facet kinds, for the per-kind file check: by default `kind` and every kind the files of the plugin's root
	 * name (`contract.web.tsx`: `web`), so the check is active as in production.
	 */
	// 每种类检查所需的 kinds；默认是测试的 kind 加上插件根目录里文件名出现的其他 kind。
	readonly kinds?: readonly string[];
	/** Where the kind's builds run (`node` by default). */
	// 构建平台，默认 node；浏览器插件测试可传 browser，但宿主仍在 Node 进程里。
	readonly platform?: "node" | "browser";
	/** Facets serving what the plugin uses (other plugins' contracts, core objects, registries it reads), loaded beside it. */
	// 桩 facet：提供被测插件读取的契约、核心对象或注册表；它们与被测插件一起加载到同一宿主。
	readonly stubs?: readonly PluginFacet<P>[];
	/** The host's principal, as the kind's production host has one. */
	// 宿主 principal，可选；远程契约或需要身份的请求会用到。
	readonly principal?: P;
	/** The host's address, as the kind's production host has one. */
	// 宿主地址，可选；服务远程类型的宿主需要地址。
	readonly address?: Address;
};

/** A plugin loaded alone: its live host, the registries collected for it, and what it waits for. */
// 测试结果：宿主保持存活，测试可以获取对象、调用方法和观察状态；close 前不要丢弃。
export interface TestedPlugin<P extends Principal = Principal> {
	/** The host the plugin and the stubs are loaded on: get its objects, call them, watch their state. */
	// 加载了插件和桩的宿主；它使用独立的内存存储，不会影响生产数据。
	readonly host: Host<P>;
	/** The plugin as discovered. */
	// 被测插件在发现阶段的记录（名字、目录、root、facet 文件等）。
	readonly plugin: Plugin;
	/** What the host reported (`onError`), in order. */
	// 宿主 onError 收集到的错误，按发生顺序；数组是活的，测试期间新增的错误也会出现。
	readonly errors: readonly HostError[];
	/**
	 * The current entries of registry `R`, one the plugin contributes to that neither it nor a stub serves (the helper
	 * serves it, collecting). Throws for a registry it does not collect.
	 */
	// 读取辅助 facet 收集到的注册表条目。只有“插件贡献了但没人提供”的注册表会被收集；其他注册表抛错。
	// 返回类型 RegistryTable<C> 是编译期视图，运行时值由收集 provider 的 compose 直接给出。
	contributions<C>(R: Registry<C, unknown>): RegistryTable<C>;
	/** The names of the contracts (and registries) requests on the host wait for unbound because nobody serves them. */
	// 列出请求等待但无人服务的契约/注册表名称，测试据此决定还需要哪些桩。
	unserved(): readonly string[];
	/** `host.root`: runs `fn` as the host's principal or `options.principal`. */
	// 以宿主 principal（或 options.principal）身份运行函数，等价于 host.root。
	root<T>(fn: (ctx: Ctx<P>) => Promise<T>, context: Context, options?: RootOptions<P>): Promise<T>;
	/** Closes the host, then its store. */
	// 关闭宿主，再关闭内存存储；顺序保证宿主释放对存储的使用后再销毁它。
	close(context: Context): Promise<void>;
}

// 单独测试一个插件。
// 输入：dir 是插件目录或单文件插件的文件路径；options 提供 kind、模块、桩等；context 用于构建与宿主操作。
// 输出：Promise<TestedPlugin>；宿主已加载完成，注册表已收集。
// 副作用：读取插件、运行 esbuild、执行插件代码、创建并加载内存宿主；失败路径会关闭已创建的宿主和存储。
// 错误：版本化模块缺少 api、不是插件、构建/求值/setup 失败都会拒绝，消息带插件名或路径。
// 主要流程：校验 API 配置 -> 解析真实路径并推断根 -> 补齐 kinds 并定位插件 -> 生产式构建 -> 求值 -> 打开 :memory:
// 存储并创建宿主 -> 加载桩和插件 -> 收集注册表 -> 返回 Tested。
/**
 * Builds the plugin in `dir` as production does (`buildFacet` with the kind's options), evaluates its facet of
 * `options.kind` with `options.modules` and loads it on a new host with an in-memory store, the stubs beside it. Then
 * the registries it contributes to that nobody serves are served by a collecting facet. Rejects when the build, the
 * evaluation or a setup fails (naming it).
 */
export async function testPlugin<P extends Principal = Principal>(
	dir: string,
	options: TestPluginOptions<P>,
	context: Context,
): Promise<TestedPlugin<P>> {
	// 解构出最常用的两个选项；其余选项按需读取。
	const { kind, modules } = options;
	// 找到第一个形如 package/vN 的说明符；只要模块表里有版本化 API，就必须显式传 api，否则构建规则会与生产不一致。
	const versioned = Object.keys(modules).find((specifier) => VERSIONED.test(specifier));
	if (versioned !== undefined && options.api === undefined) {
		// 错误信息给出具体说明符，提示补上 api；这是调用方配置错误，发生在读盘和构建之前。
		throw new Error(
			`testPlugin: modules hold the app's versioned API ("${versioned}"): pass api, as production does`,
		);
	}
	// 目录或文件都先 realpath，后续发现比较也使用真实路径。
	const real = await realpath(dir);
	// rootOf 根据目录层级推断应用根，使 discoverPlugins 能像生产一样看到这个插件。
	const root = await rootOf(real);
	// 默认 kinds 包含当前 kind 和扫描到的其他 kind；?? 只在调用方显式提供时跳过扫描。
	// 展开生成的数组放在 [kind] 之后，顺序不影响集合语义。
	const kinds = options.kinds ?? [kind, ...(await kindsNamedIn(root))];
	// 用与生产相同的发现函数定位插件；返回被测记录和根中全部插件（构建时需要允许同根相对导入）。
	const plugin = await pluginIn(real, root, kinds, context);
	// 按生产方式构建测试 kind：宿主包来自 modules，平台/kinds/插件列表与应用一致；api 只在存在时展开。
	const built = await buildFacet(
		plugin.found,
		kind,
		{
			hostPackages: Object.keys(modules),
			platform: options.platform ?? "node",
			kinds,
			plugins: plugin.plugins,
			...(options.api === undefined ? {} : { api: options.api }),
		},
		context,
	);
	// 构建失败是 BuiltFacet 的 failed 分支；测试没有可加载的 facet，直接把构建错误拼进异常。
	if (built.kind === "failed") {
		throw new Error(`testPlugin: "${plugin.found.name}" failed to build:\n${built.errors.join("\n")}`);
	}
	// 求值成功脚本，得到 facet；求值异常（包括非 facet 默认导出）原样拒绝。
	const facet = evaluateFacet<P>(built, { hostPackages: modules, plugin: plugin.found });
	// 内存 SQLite：每个测试独立，不会写磁盘；openStore 初始化存储，context 可中止。
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	// 错误数组被 onError 闭包捕获；Tested.errors 暴露同一个数组。
	const errors: HostError[] = [];
	// 创建宿主：store 必填，principal/address 只在提供时展开，避免把 undefined 放进配置。
	const host = createHost<P>({
		store,
		onError: (error) => errors.push(error),
		...(options.principal === undefined ? {} : { principal: options.principal }),
		...(options.address === undefined ? {} : { address: options.address }),
	});
	// 宿主创建成功后才进入 try：之后任何失败都必须关闭宿主和存储，防止测试进程泄漏资源。
	try {
		// 桩在前、被测插件在后；名字必须唯一，宿主会在 load 时检查。
		const facets = [...(options.stubs ?? []), { name: plugin.found.name, facet }];
		// host.load 执行所有 facet.setup；throwFailed 把任一 setup 失败转成测试错误。
		throwFailed(await host.load(facets, context));
		// 收集插件贡献到无人提供注册表的条目；可能多次 reload 以处理收集过程中新产生的注册表。
		const collected = await collect(host, facets, context);
		// Tested 保存宿主、存储、插件记录、错误数组和收集结果；调用方负责最终 close。
		return new Tested(host, store, plugin.found, errors, collected);
		// 失败清理：先关闭宿主（停止激活、释放对象），再关闭存储；这里没有 try/finally，若关闭本身抛错，它会取代原始错误传播。
	} catch (error) {
		await host.close(context);
		await store.close(context);
		throw error;
	}
}

/** A host package named with a version of an API (`@acme/app/v3`, `@acme/app/v3/worker`). */
// 识别版本化 API 模块：路径中出现 /v<数字>，后面是 / 或结尾；例如 @acme/app/v3、@acme/app/v3/worker。
const VERSIONED = /\/v\d+(?:\/|$)/;

/**
 * The root the plugin at `real` (a directory, or a single-file plugin's file) is in, as production lists it: its
 * directory's parent, or, for a plugin in a checkout of several (a parent with its own `package.json` or `.git`), that
 * checkout's parent.
 */
// 推断被测插件在应用中的根目录。
// 输入：real 是插件目录或单文件插件文件的真实路径；输出：应传给 discoverPlugins 的根。
// 文件布局：根就是文件所在目录。目录布局：若其父目录有 package.json 或 .git，说明插件在多插件检出中，
// 根再上一层；否则父目录就是根。
// 例子：/app/plugins/notes（父目录 /app/plugins 只有 notes）-> /app/plugins；/app/checkout/notes（父目录 /app/checkout
// 有 package.json 或 .git）-> /app。
async function rootOf(real: string): Promise<string> {
	const parent = dirname(real);
	// stat 区分单文件插件与目录插件；读取失败会直接拒绝。
	if ((await stat(real)).isFile()) return parent;
	// exists 用 stat 的成功/失败得到布尔值；或运算先检查 package.json，不存在再查 .git。
	const checkout = (await exists(join(parent, "package.json"))) || (await exists(join(parent, ".git")));
	// 多插件检出的根是父目录的父目录，因为 discoverPlugins 会把检出目录当作包再向下找插件。
	return checkout ? dirname(parent) : parent;
}

/**
 * The kinds files under `root` name (`contract.web.tsx`: `web`; not `*.test.*`, `*.spec.*` or `*.d.ts`), `node_modules`
 * and hidden directories skipped; one walk per `testPlugin` call.
 */
// 扫描 root 下的文件名，收集点分文件名中出现的 kind。
// 输入：根目录；输出：kind 名数组（去重，不保证顺序）。
// 跳过隐藏目录和 node_modules；递归目录；排除 test/spec/d 段，避免把 *.test.ts、*.spec.ts、*.d.ts 当作 kind。
// 例：contract.web.tsx 加入 web；stats.test.ts 和 env.d.ts 不加入。
async function kindsNamedIn(root: string): Promise<string[]> {
	const kinds = new Set<string>();
	// 闭包内的递归函数共享 kinds 集合；readdir 使用 withFileTypes 避免额外 stat。
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			// 目录先递归；随后仍会计算 parts，但只有 entry.isFile() 时才可能加入 kind。
			if (entry.isDirectory()) await walk(join(dir, entry.name));
			const parts = entry.name.split(".");
			// 倒数第二段是潜在 kind；至少三段才符合 name.kind.ext。
			const segment = parts[parts.length - 2];
			// Tests and declaration files name no kind (`stats.test.ts`, `env.d.ts`).
			// 运行时过滤测试/声明文件；segment! 的非空断言只用于类型，parts.length>=3 保证存在。
			const named = parts.length >= 3 && segment !== "test" && segment !== "spec" && segment !== "d";
			if (entry.isFile() && named) kinds.add(segment!);
		}
	};
	await walk(root);
	return [...kinds];
}

/** Whether `path` exists. */
// 判断路径是否存在：stat 成功为 true，任何失败（ENOENT、权限等）都为 false；这里不区分原因。
async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

/** The plugin at `real` (its directory, or a single-file plugin's file), discovered with the others of `root`. */
// 在 root 中发现插件并找到对应 real 的那一个。
// 输入：real（真实路径）、root、kinds、context；输出：被测 Plugin 与根中全部 Plugin。
// 错误：找不到插件时抛出；若发现阶段对 real 报告了问题，把问题文本附在错误后。
// 目录插件比较 dir，单文件插件比较 facets 中的文件路径。
async function pluginIn(
	real: string,
	root: string,
	kinds: readonly string[],
	context: Context,
): Promise<{ readonly found: Plugin; readonly plugins: readonly Plugin[] }> {
	// 用与生产相同的发现规则列出整个根；单文件插件和目录插件都会出现。
	const { plugins, problems } = await discoverPlugins([root], { kinds }, context);
	// 条件表达式的两个分支分别在两种 layout 下比较身份；Object.values 的顺序不影响 includes。
	const found = plugins.find((each) =>
		each.layout === "directory" ? each.dir === real : Object.values(each.facets).includes(real),
	);
	if (found !== undefined) return { found, plugins };
	// 发现失败可能以 problem 而不是 plugin 出现；按路径匹配后把原因带给测试作者。
	const problem = problems.find(({ path }) => path === real);
	throw new Error(`testPlugin: ${real} is no plugin${problem === undefined ? "" : `: ${problem.error}`}`);
}

/** Throws the failures of a load: a test of a plugin whose setup (or a stub's) failed has nothing to test. */
// 把加载报告的失败转成异常：只要插件或任一桩的 setup 失败，测试就没有可继续的宿主状态。
// 输入：至少含 failed 数组的报告；输出：无（全部成功时返回）。
// 错误消息拼接每个失败原因，cause 保留第一个原始错误。
function throwFailed(report: {
	readonly failed: readonly { readonly plugin: string; readonly error: unknown }[];
}): void {
	// 只取第一条判断是否为空；后续消息仍使用完整 failed 列表。
	const [first] = report.failed;
	if (first === undefined) return;
	// The host's errors name their plugin.
	// 错误原因可能是任意抛出值，instanceof Error 是运行时检查；非 Error 用 String 转文本。
	const message = report.failed
		.map(({ error }) => (error instanceof Error ? error.message : String(error)))
		.join("; ");
	// 用 Error 的 cause 选项保留原始错误链；Node 的类型定义支持该选项。
	throw new Error(`testPlugin: setup failed: ${message}`, { cause: first.error });
}

/** The plugin name of the collecting facet, beside the plugin and its stubs. */
// 收集 facet 使用固定插件名，避免与被测插件或桩重名（重名会被宿主拒绝）。
const COLLECTOR = "chord.test-plugin-collector";

/**
 * Serves every registry with contributions on `host` and no provider with a collecting provider (its `compose` is the
 * table; every older version accepted as it is), through a reload adding it beside `facets`; returns each one's value.
 */
// 收集插件贡献到、但没有任何 facet 提供的注册表。
// 输入：宿主、原始 facets（桩 + 插件）、context；输出：注册表名 -> 当前值。
// 副作用：反复 reload 宿主，追加一个收集 facet；每次收集后重新等待激活。
// 错误：reload 失败由 throwFailed 转成异常；host.registry 的错误原样传播。
// 主要流程：不断询问宿主的未声明注册表，为新名字定义 token 并生成收集 facet，reload 后重复，直到固定点；
// 最后逐个读取注册表值。
async function collect<P extends Principal>(
	host: Host<P>,
	facets: readonly PluginFacet<P>[],
	context: Context,
): Promise<ReadonlyMap<string, RegistryValue<unknown>>> {
	// tokens 保存已定义的注册表 token；name 是宿主内部使用的注册表名。
	const tokens = new Map<string, Registry<unknown, RegistryTable<unknown>>>();
	// A fixed point: an object that goes live once a collected registry is served may contribute to another.
	// 固定点循环：收集动作可能让新对象激活并贡献新的注册表，因此一次收集不一定够。
	for (;;) {
		// 先等待宿主现有激活结束，才能看到它们声明/贡献的注册表。
		await settle(host);
		// The helper's own host: its internal view of the registries.
		// 强制转换为内部 ChordHost 视图以读取 undeclaredRegistries；这是测试辅助对内核状态的受控访问。
		// filter 去掉已经定义过的名字。
		const fresh = (host as unknown as ChordHost).undeclaredRegistries().filter(({ name }) => !tokens.has(name));
		// 没有新的未声明注册表，固定点到达。
		if (fresh.length === 0) break;
		// 为每个新名字创建注册表 token；版本来自宿主记录，保证收集 provider 接受该版本。
		for (const { name, version } of fresh) tokens.set(name, defineRegistry(name, { version }));
		const served = [...tokens.values()];
		// 收集 facet：对每个已收集 token 提供服务，provider 的 compose 原样返回表，accepts 接受所有更旧版本。
		const collector = defineFacet<P>((facetHost) => {
			for (const token of served) facetHost.serve(token, { compose: (table) => table, accepts: olderAs(token) });
		});
		// reload 把收集 facet 与原始 facets 一起加载；同名收集插件在后续轮次替换自己的 facet。
		throwFailed(await host.reload([...facets, { name: COLLECTOR, facet: collector }], context));
	}
	// 固定点后逐个读取值；host.registry 等待注册表可用并返回其当前值。
	const values = new Map<string, RegistryValue<unknown>>();
	for (const token of tokens.values()) values.set(token.name, await host.registry(token, context));
	return values;
}

/**
 * Waits until no activation on `host` is under way (as `load`'s barrier waits for first outcomes), bounded by the host's
 * `readyTimeout`: the objects a reload's publication woke reach their outcome, slow openers included.
 */
// 等待宿主没有正在进行的激活。
// 输入：宿主；输出：无，达到稳定或超过 ready 超时后返回。
// 注意：超时不会抛错，只是停止等待；这是有界的尽力等待，避免测试永久挂起。
// 每轮先让出 3 个 setImmediate 轮次，让请求的 promise/I/O 回调运行，再检查 activationsUnderWay。
async function settle<P extends Principal>(host: Host<P>): Promise<void> {
	// The helper's own host: its internal view of its objects and timeouts.
	const chord = host as unknown as ChordHost;
	// timeouts.ready 是宿主配置的就绪超时（毫秒）；deadline 用本地时钟计算。
	const deadline = Date.now() + chord.timeouts.ready;
	// The woken requests check again in promise jobs and I/O callbacks: let those run before counting.
	// do...while 保证至少检查一次；每轮先让出三个宏任务轮次，仍未稳定则短暂休眠后重试。
	do {
		// 三个宏任务轮次让微任务和已排队的 I/O 回调推进；setImmediate 的回调在 check 阶段执行。
		for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));
		if (chord.activationsUnderWay() === 0) return;
		// 仍有激活时短暂休眠再重试，避免忙等。
		await new Promise((resolve) => setTimeout(resolve, 5));
	} while (Date.now() < deadline);
}

/** Every older version's contributions and readers as they are: made per version looked up, not per version below. */
// 为任意旧版本提供“原样接受”的适配器。
// 输入：当前注册表 token；输出：RegistryAccepts 形状。
// 做法：用 Proxy 拦截属性读取，只有数字字符串且版本小于当前版本时返回同一个身份适配器；其他键返回 undefined。
// 这样不需要为每个旧版本预先创建适配器对象。
function olderAs(token: Registry<unknown, RegistryTable<unknown>>): RegistryAccepts<unknown, RegistryTable<unknown>> {
	// contribution 直接返回旧值，value 直接返回表；never 参数只用于满足适配器签名，运行时不做类型检查。
	const asItIs = { contribution: (old: never) => old, value: (table: unknown) => table };
	// The kernel only looks adapters up by version (`accepts[version]`).
	// 内核按版本号索引 accepts，所以只需实现数字键；Proxy 的 target 是空对象。
	return new Proxy(
		{},
		{
			get: (_target, key) =>
				// key 可能不是字符串（Symbol 等）；Number(key) < token.version 限制只接受更旧版本。
				// 最后 as 把 Proxy 断言成 RegistryAccepts，因为结构由 get 的返回值保证。
				typeof key === "string" && /^\d+$/.test(key) && Number(key) < token.version ? asItIs : undefined,
		},
	) as RegistryAccepts<unknown, RegistryTable<unknown>>;
}

// TestedPlugin 的实现：持有宿主、存储、插件记录、错误数组与收集结果。
// 构造后不再改变字段；close 是唯一释放资源的操作。
class Tested<P extends Principal> implements TestedPlugin<P> {
	readonly host: Host<P>;
	readonly plugin: Plugin;
	readonly errors: readonly HostError[];
	readonly #store: Store;
	readonly #collected: ReadonlyMap<string, RegistryValue<unknown>>;

	// 构造函数保存所有引用；errors 与调用方共享同一数组，因此测试能看到后续错误。
	constructor(
		host: Host<P>,
		store: Store,
		plugin: Plugin,
		errors: readonly HostError[],
		collected: ReadonlyMap<string, RegistryValue<unknown>>,
	) {
		this.host = host;
		this.#store = store;
		this.plugin = plugin;
		this.errors = errors;
		this.#collected = collected;
	}

	// 返回某注册表的收集表。
	// 输入：注册表 token；输出：RegistryTable<C>。
	// 错误：该注册表没有贡献或已被提供（未被收集）时抛出，避免返回空表掩盖测试配置问题。
	contributions<C>(R: Registry<C, unknown>): RegistryTable<C> {
		// 按注册表名查找；收集结果以名字为键，而不是 token 对象身份。
		const value = this.#collected.get(R.name);
		if (value === undefined) {
			throw new Error(
				`testPlugin: registry ${R.name} is not collected (nothing contributed to it unserved at load)`,
			);
		}
		// The collecting provider composes to its table.
		// 收集 provider 的 compose 是恒等函数，所以 RegistryValue 的 value 就是表；as 只恢复具体类型。
		return value.value as RegistryTable<C>;
	}

	// 列出未服务的契约/注册表名；使用内部 unservedNames，测试接口不暴露宿主内部结构。
	unserved(): readonly string[] {
		// The helper's own host: its internal view of the unbound index.
		return (this.host as unknown as ChordHost).unservedNames();
	}

	// 直接委托宿主的 root；Ctx<P> 由宿主的 principal 类型决定。
	root<T>(fn: (ctx: Ctx<P>) => Promise<T>, context: Context, options?: RootOptions<P>): Promise<T> {
		return this.host.root(fn, context, options);
	}

	// 先关闭宿主，再关闭存储；不吞掉任何一个错误，宿主关闭失败时存储不会被关闭。
	async close(context: Context): Promise<void> {
		await this.host.close(context);
		await this.#store.close(context);
	}
}
