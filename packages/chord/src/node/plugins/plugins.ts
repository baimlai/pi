// The plugins component (slice 7c §4, §5; decision "Slice 7c's points"; slice 10 D11, D12; slice 12 §1, §5): discovery,
// builds checked against the app's API, installs and the watcher, and per kind the complete current set of scripts
// (built on first use, updated by every rollout that ships the kind), which its plugin runtime loads and reloads hosts
// with: unchanged plugins as the same facet objects, removed ones left out, a failed build or evaluation keeping the
// plugin's loaded facet. `rollout` runs the app's steps in order (one result per host) and clears the marks of plugins
// applied on every host of every step.

// 文件导读
// 所属模块：packages/chord/src/node/plugins 的组件层，把发现、构建、安装、监视、运行时和灰度发布组合成应用使用的
// Plugins 对象（slice 7c §4/§5、slice 10 D11/D12、slice 12 §1/§5）。
// 职责边界：本文件决定“现在哪些插件、每种 kind 的完整脚本集合是什么、一次构建如何发布到多个宿主”，但把具体工作
// 委托给 discover/build/runtime/watcher/install；它不直接执行插件代码，也不实现 esbuild 规则或文件监视。
// 上游入口：应用调用 createPlugins(options, context) 得到 Plugins，然后调用 build/rollout/load/scripts 等。
// 下游依赖：build.ts、discover.ts、runtime.ts、watcher.ts、install.ts、state/Batch（把监视事件合批）。
// 结果与错误流向：build 返回普通数据 Built（可克隆）；rollout 返回每个步骤/宿主的结果，步骤拒绝时提前停止；
// load/reload 返回宿主报告，必选插件失败抛 PluginError；监视错误和批监听错误经 options.onError 上报。
// 能力清单：
// - PluginsOptions：roots、api、kinds、base、publicPath、install、onError。
// - KindDefinition：每种 facet 的构建平台与宿主包说明符。
// - PluginsError：批错误或 watcher 失败。
// - Built：一次构建的全部 facet、参与插件记录和已移除插件名。
// - RolloutHost/RolloutStep/RolloutResult：发布步骤在每个宿主上的结果、步骤接口与整体结果。
// - Plugins：state、discovery、build、scripts、current、load、reload、step、rollout、installDependencies、
//   installPlugin、close 的公共接口。
// - createPlugins(options, context)：创建组件并启动 watcher；首次使用时才做发现。
// 组合与典型顺序：createPlugins -> build(names)（可先安装）-> rollout(steps, built) 或对单个宿主 load/scripts；
// 每个 rollout 步骤先 ship 本步骤 kinds 的新集合，再让步骤重载宿主；全部成功后才清除未失败插件的脏标记。
// 示例：const plugins = createPlugins({
//   roots: [{ path: "./plugins", required: true }],
//   kinds: { server: { platform: "node", hostPackages: ["@earendil-works/chord"] } },
//   onError: (error) => logger.error(error),
// }, context);
// const built = await plugins.build(["notes"], context);
// const result = await plugins.rollout([plugins.step("server", host)], built, context);
// 这是真实签名；host 必须已由同一个组件的 load 加载过，step 才能取得它的 kind。createPlugins 的 context 参数当前不参与
// 构造（参数名为 _context），发现和构建才使用调用方传入的 context。
// 建议阅读顺序：PluginsOptions/KindDefinition/Built/Rollout* 类型 -> Plugins 接口 -> createPlugins -> 组件字段与
// 构造函数 -> build/rollout -> load/reload/#set/#buildOne -> ship/builtOf 辅助函数。
import type { Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import type { Host, LoadReport, PluginFacet, ReloadReport } from "../../host/index.ts";
import { Batch, type BatchError } from "../../state/internal.ts";
import type { Watchable } from "../../watch.ts";
import { type AppApi, type BuiltFacet, buildFacet } from "./build.ts";
import { type Discovery, discoverPlugins, type Plugin, type PluginRoot, sameFiles } from "./discover.ts";
import type { HostPackages } from "./evaluate.ts";
import { type InstallOptions, installDependencies, installPlugin, type PluginSource } from "./install.ts";
import { createPluginRuntime, PluginError, type PluginRuntime, type PluginScript } from "./runtime.ts";
import { type MarkSnapshot, type PluginsState, PluginWatcher } from "./watcher.ts";

// 组件配置。它同时是构建、安装和监视的唯一配置来源；应用必须在创建前决定 kinds，之后不能通过接口修改。
/** What `createPlugins` takes. */
export type PluginsOptions = {
	/**
	 * The directories plugins are listed in, in order: the first root's plugin wins a duplicate name. A root marked
	 * `required` (`{ path, required: true }`, the app's own) makes `load` reject when one of its plugins fails.
	 */
	// 根目录按数组顺序扫描，同名插件先到者胜；required 根中的插件失败会让 load 拒绝。
	readonly roots: readonly PluginRoot[];
	/**
	 * The app's API (`{ name: "@acme/app", versions: ["v3", "v2"] }`, newest first): plugins import it at a listed
	 * version, its per-kind modules from their kind only, one version per facet, and never Chord directly. Without one,
	 * plugins import the host packages as listed.
	 */
	// 可选的应用 API：传入后构建会检查版本、每种类模块和 Chord 导入；不传则按 kinds 中的宿主包列表放行。
	readonly api?: AppApi;
	/**
	 * The app's facet kinds (one file per kind in a plugin), each with where its builds run and the host packages they
	 * keep external: `{ server: { platform: "node", hostPackages: ["@earendil-works/chord", "@app/core"] }, … }`.
	 */
	// kinds 的键是 facet 种类名，也是发现阶段识别的 facet 文件名；值给出该种类的构建平台和宿主包。
	readonly kinds: Readonly<Record<string, KindDefinition>>;
	/** The app's base code: a change sets `base` (the app restarts its hosts; Chord restarts nothing). */
	// 应用基础代码路径；这些文件变化只设置 base 标记，由应用自己重启宿主，Chord 不重启。
	readonly base?: readonly string[];
	/** Where the app serves browser builds' assets: the URL prefix their imports evaluate to. */
	// 浏览器构建资源 URL 前缀；传给 buildFacet 后落到输出代码里。
	readonly publicPath?: string;
	/** How `installDependencies` runs npm. */
	// 依赖安装选项（npm 命令）；组件不会自行安装，除非调用 installDependencies/installPlugin。
	readonly install?: InstallOptions;
	/** The watcher cannot watch (reported once), and the marks' watch listeners that threw. */
	// 错误出口：watcher 无法监视（只报告一次）和 Batch 监听器异常都会到这里；组件方法自身的 Promise 错误仍由调用方处理。
	readonly onError: (error: PluginsError) => void;
};

/** One facet kind: Node or browser builds, and the host packages (by specifier) its builds keep external. */
// 一种 facet 的构建定义：platform 决定 target/内置模块规则，hostPackages 是该种类构建时保持外部的说明符列表。
// 字段都是只读类型，但配置对象本身不会被运行时冻结。
export type KindDefinition = { readonly platform: "node" | "browser"; readonly hostPackages: readonly string[] };

/** What the component reports. */
// 组件对外的错误联合：BatchError 来自监视事件的分发（listener_error/delivery_failed），watch_failed 来自 watcher
// 无法建立监视；kind 标签让 onError 的接收方安全区分。
export type PluginsError = BatchError | { readonly kind: "watch_failed"; readonly error: unknown };

/**
 * A build of some plugins, plain data (a clone of it reloads the same): every facet of each, the plugins as its
 * discovery saw them by name (what a reload evaluates with), and the plugins no longer discovered.
 */
// 一次构建的普通数据。facets 包含被选中插件的全部 facet；plugins 只包含这次构建涉及的插件（按名字），
// reload/求值需要它们的目录和规则；removed 是自上次发现后消失的插件名。
// 它是可结构化克隆的值，所以可以运给 worker；克隆会丢失下面组件用 WeakMap 关联的标记快照。
export type Built = {
	readonly facets: readonly BuiltFacet[];
	readonly plugins: Readonly<Record<string, Plugin>>;
	readonly removed: readonly string[];
};

/**
 * What a rollout step did on one of its hosts (`host` named by the step): its reload's report; `stopped` when the host
 * stopped cleanly during the step (it gets the current set at its next start); `error` when it crashed or its reload
 * failed (every plugin of the step's kinds in the build counts as failed there).
 */
// 一个宿主在一次步骤中的三种结果：正常重载并带 ReloadReport；宿主干净停止（下次启动会用当前集合）；
// 崩溃或重载失败（错误会被算到该步骤 kinds 的所有插件上）。
export type RolloutHost =
	| { readonly host: string; readonly report: ReloadReport }
	| { readonly host: string; readonly stopped: true }
	| { readonly host: string; readonly error: unknown };

/** What a rollout step does: reloads its hosts with the facets of its kinds, one result per host (D12). */
// 一个发布步骤：名字只用于结果标识；kinds 决定发布哪些种类；reload 由应用实现，用 built 重载自己的宿主，
// 返回每个宿主的结果。组件不关心宿主是进程、worker 还是浏览器页面。
export type RolloutStep = {
	readonly name: string;
	readonly kinds: readonly string[];
	reload(built: Built, context: Context): Promise<{ readonly hosts: readonly RolloutHost[] }>;
};

/** What a rollout did: each step's hosts in order, and the step it stopped at (rejected), if it stopped. */
// 发布结果：每一步的宿主结果按执行顺序累积；stopped 非 undefined 表示某步骤在 ship 或 reload 时拒绝，
// 之后的步骤没有执行，标记也不会清除。
export type RolloutResult = {
	readonly steps: readonly { readonly name: string; readonly hosts: readonly RolloutHost[] }[];
	readonly stopped: { readonly step: string; readonly error: unknown } | undefined;
};

// 组件公共接口。方法文档保留英文契约，下面用中文说明各自职责与错误路径。
/** The plugins component. */
export interface Plugins {
	/** The marks: `{ dirty, install, set, base }`, a JSON watchable. */
	// state：watcher 以 JSON 可观察值暴露的标记（dirty/install/set/base），应用可 watch 它来驱动重启或构建。
	readonly state: Watchable<PluginsState>;
	/** The plugins of the last discovery. */
	// discovery：最近一次发现的快照；首次 build/load/install 之前是空列表，不是自动发现的结果。
	readonly discovery: Discovery;
	/**
	 * Builds every facet of `names` (and of plugins discovered since the last build; discovery runs again first when
	 * the plugin set changed): plain data. It changes no current set: a rollout ships it.
	 */
	// build：构建指定名字的插件，以及新发现或文件位置变化的插件；返回普通数据但不改变当前集合，发布由 rollout 完成。
	build(names: readonly string[], context: Context): Promise<Built>;
	/**
	 * The complete current set of `kind`: every discovered plugin's facet of it (built on first use), as the last
	 * rollout or reload shipping `kind` left it; what a worker starts with.
	 */
	// scripts：返回某 kind 的完整当前集合（首次调用时构建并创建），worker 用它启动；失败插件也在集合中以 failed 构建出现。
	scripts(kind: string, context: Context): Promise<readonly PluginScript[]>;
	/**
	 * `kind`'s current set now, synchronously (`undefined` before its first use): a rollout step reads it as the rollout
	 * applied its build, before another rollout can change it.
	 */
	// current：同步读取已建立的当前集合；首次使用前为 undefined。rollout 步骤用它读取“刚 ship 的”集合，避免被并发发布改变。
	current(kind: string): readonly PluginScript[] | undefined;
	/**
	 * Loads `host` with `kind`'s current set, evaluated with `modules` (the host packages, this process's instances, by
	 * specifier; kept for the host's reloads), and `core` (the app's own facets): a plugin whose build or evaluation
	 * fails is left out and reported with the host's report. A required root's plugin failing, and a problem discovery
	 * reported in a required root (missing, an invalid package, a name another root has), reject the load with a
	 * `PluginError` once the host's load settled.
	 */
	// load：用 kind 的当前集合加载宿主；core 是应用自己的 facet，modules 是宿主包实例。
	// 必选插件失败或必选根有发现问题时，在宿主 load 完成后以 PluginError 拒绝；非必选失败只记录在报告里。
	load<P extends Principal>(
		host: Host<P>,
		options: { readonly kind: string; readonly core: readonly PluginFacet<P>[]; readonly modules: HostPackages },
		context: Context,
	): Promise<LoadReport>;
	/**
	 * Applies `built` to the current set of `host`'s kind (loaded by `load`) and reloads `host` with that complete set,
	 * after its earlier reloads (`PluginRuntime.reload`). The host's report.
	 */
	// reload：把 built 应用到宿主的 kind 当前集合，再用完整集合重载宿主；宿主必须由本组件 load 过，否则抛错。
	reload<P extends Principal>(host: Host<P>, built: Built, context: Context): Promise<ReloadReport>;
	/** An in-process rollout step named `name`: `reload(host, built)`, one host named `name`. */
	// step：创建一个进程内发布步骤，只含一个宿主；名字用于结果，kind 在创建时固定。
	step<P extends Principal>(name: string, host: Host<P>): RolloutStep;
	/**
	 * Runs `steps` in order with `built`, applying it to the current set of each step's kinds right before that step,
	 * and stops at one that rejects; failed plugins and hosts do not stop it. Clears the dirty marks of the built
	 * plugins applied on every host of every step (not failed on any, every built kind of theirs shipped by a step)
	 * that did not change since the build.
	 */
	// rollout：按顺序执行步骤，每个步骤开始前 ship 它的 kinds；步骤抛错则停止并返回 stopped。
	// 所有步骤成功后，只清除“每个步骤的每个宿主都成功、且所有已构建 kind 都被发布”的插件的脏标记。
	rollout(steps: readonly RolloutStep[], built: Built, context: Context): Promise<RolloutResult>;
	/** Installs plugin `name`'s dependencies (`installDependencies`): its install mark clears, and it is dirty. */
	// installDependencies：对已发现插件运行 npm 安装，并清除其 install 标记、把它标脏，促使下次构建重读依赖。
	installDependencies(name: string, context: Context): Promise<void>;
	/**
	 * Installs new plugins from git or npm into `root`, one of the roots (`installPlugin`), and marks `set`: the next
	 * build discovers and builds them. Returns their names.
	 */
	// installPlugin：安装到已配置的某个根，成功后设置 set 标记；下一次 build 会重新发现并构建。
	installPlugin(source: PluginSource, root: string, context: Context): Promise<readonly string[]>;
	/** Stops the watcher. */
	// close：关闭 watcher；不会卸载已加载的宿主或清空当前集合。
	close(): void;
}

// 创建组件并启动 watcher，返回实现 Plugins 的实例。
// 输入：options（完整配置）和 context；当前实现不读取 context（参数名为 _context），发现/构建时才由调用方传入各自的 context。
// 输出：Plugins；副作用：创建插件运行时（可能关闭 V8 编译缓存）和 watcher。
// 错误：配置本身不校验；watcher 的监视错误通过 options.onError 异步报告。
// 例：const plugins = createPlugins(options, context); 之后调用 plugins.build([], context) 触发首次发现。
/** Creates the plugins component (and its plugin runtime) and starts the watcher. Discovery runs at first use. */
export function createPlugins(options: PluginsOptions, _context: Context): Plugins {
	return new PluginsComponent(options);
}

// 组件实现：配置、watcher、运行时和所有缓存都在实例上；应用通常只持有 Plugins 接口。
class PluginsComponent implements Plugins {
	readonly #options: PluginsOptions;
	readonly #watcher: PluginWatcher;
	readonly #runtime: PluginRuntime;
	// 最近一次发现结果，初始为空；#discovered 区分“还没发现”和“发现过但没有插件”。
	#discovery: Discovery = { plugins: [], problems: [] };
	#discovered = false;
	// 每个 (插件名, kind) 的最新构建，键用 NUL（\u0000）分隔，避免名字里含分隔符时冲突。值是 BuiltFacet（成功或失败）。
	/** The latest build of every (plugin, kind) built so far, by `plugin\u0000kind`. */
	readonly #built = new Map<string, BuiltFacet>();
	// 每种 kind 的当前集合：kind -> (插件名 -> 脚本+发现记录)。首次使用时建立，rollout 的 ship 更新。
	/** The current set of each kind used so far, by plugin name. */
	readonly #current = new Map<string, Map<string, PluginScript>>();
	// 宿主 -> 加载时使用的 kind；WeakMap 使宿主被回收后记录随之消失，reload/step 靠它找到集合。
	/** The kind each loaded host was loaded with, held as long as the host is. */
	readonly #kinds = new WeakMap<object, string>();
	// Built 对象 -> 构建开始时的 watcher 标记快照；用 WeakMap 以构建结果为键，调用方拿到克隆时查不到快照，
	// 因此克隆出来的构建不会清除任何标记。
	/** The marks each build started from, held as long as its result is (a rollout given a copy clears none). */
	readonly #snapshots = new WeakMap<Built, MarkSnapshot>();

	// 构造函数：保存配置，创建运行时，把 watcher 的错误接到 options.onError，并建立 Batch 合批对象。
	// Batch 的第二个参数是 undefined（由 watcher 提供上下文）；监听器异常会转成 BatchError 传给 onError。
	constructor(options: PluginsOptions) {
		this.#options = options;
		this.#runtime = createPluginRuntime();
		const batch = new Batch((error) => options.onError(error), undefined);
		this.#watcher = new PluginWatcher(
			{
				// watcher 只认根路径字符串；把对象形式统一取出 path，保持配置顺序。
				roots: options.roots.map((root) => (typeof root === "string" ? root : root.path)),
				base: options.base ?? [],
				// watcher 需要种类名集合来识别 facet 文件；Object.keys 的顺序不影响集合语义。
				kinds: Object.keys(options.kinds),
				// 监视失败单独包装成 watch_failed，与其他组件错误区分。
				failed: (error) => options.onError({ kind: "watch_failed", error }),
			},
			batch,
		);
	}

	// state 直接暴露 watcher；类型上 watcher 的 Watchable 值与 PluginsState 相同，
	// as unknown as 是因为 PluginWatcher 继承的泛型没有在这里写成 Watchable<PluginsState>。
	get state(): Watchable<PluginsState> {
		// Its value is a `PluginsState`.
		return this.#watcher as unknown as Watchable<PluginsState>;
	}

	// discovery 返回当前快照引用；快照对象在下次发现时整体替换，调用方不应改写它。
	get discovery(): Discovery {
		return this.#discovery;
	}

	// 构建一批插件。
	// 输入：names 是应用明确要求重建的插件名；context 传给发现与构建。
	// 输出：Built（facets、参与的插件记录、移除名单）。
	// 副作用：可能重新发现、并行运行 esbuild、更新 #built 缓存并通知 watcher 每个构建读了哪些文件；不改变当前集合。
	// 错误：发现或构建中的意外异常会拒绝；单个 facet 的构建错误通常被 buildFacet 转成 failed 结果，不抛出。
	// 主要流程：保存旧发现 -> 需要时重新发现 -> 计算移除和需要构建的插件 -> 记录标记快照 -> 并行构建所有种类 ->
	// 组装 Built 并用 WeakMap 关联快照。
	// 例：await plugins.build(["notes"], context) 会重新构建 notes 的所有 facet，并顺带构建新发现的插件；
	// 真实构建的 kinds 来自插件自己拥有的 facet 文件，而不是应用声明的全部 kind。
	async build(names: readonly string[], context: Context): Promise<Built> {
		// before 是重新发现前的名字 -> 记录映射，用于找出本次消失的插件。
		const before = new Map(this.#discovery.plugins.map((plugin) => [plugin.name, plugin]));
		// 首次使用或 watcher 报告需要发现时，先刷新 #discovery；否则直接使用缓存。
		if (!this.#discovered || this.#watcher.needsDiscovery) await this.#discover(context);
		const now = this.#discovery.plugins;
		// removed 只包含旧集合中有、新发现中没有的名字；some 是线性检查，插件数量小。
		const removed = [...before.keys()].filter((name) => !now.some((plugin) => plugin.name === name));
		// A plugin whose files moved (a single file became a directory, a facet file came or went) is built again too.
		// wanted 规则：显式点名、新发现的插件、或文件位置/布局变化（sameFiles 为 false）的插件。
		// 未变化且未被点名的插件沿用 #built 中的结果，不重新构建。
		const wanted = now.filter((plugin) => {
			const previous = before.get(plugin.name);
			return names.includes(plugin.name) || previous === undefined || !sameFiles(previous, plugin);
		});
		// 记录构建开始时的标记快照；名字集合包含 wanted 和 removed，因为移除也会改变插件状态。
		const snapshot = this.#watcher.snapshot([...wanted.map(({ name }) => name), ...removed]);
		// 并行构建每个 wanted 插件的每个 facet；flatMap 把“插件 -> 种类数组”展平成任务列表，Promise.all 保持结果顺序。
		const facets = await Promise.all(
			wanted.flatMap((plugin) => Object.keys(plugin.facets).map((kind) => this.#buildOne(plugin, kind, context))),
		);
		// 只把 wanted 插件写进 Built.plugins；未变化插件仍留在当前集合中，由 ship 保留。
		const plugins = Object.fromEntries(wanted.map((plugin) => [plugin.name, plugin]));
		const built: Built = { facets, plugins, removed };
		// WeakMap 关联快照：只有原始 Built 对象能清除标记；克隆或重新构造的对象不会命中。
		this.#snapshots.set(built, snapshot);
		return built;
	}

	// 返回某 kind 当前集合的脚本数组；#set 在首次调用时负责发现和构建。
	// Map 的 values 顺序是插入顺序，但调用方不应依赖插件顺序做协议约定。
	async scripts(kind: string, context: Context): Promise<readonly PluginScript[]> {
		return [...(await this.#set(kind, context)).values()];
	}

	// 同步读取当前集合；没有时返回 undefined，而不是触发构建。
	// 返回新数组但元素仍是共享的 PluginScript 对象。
	current(kind: string): readonly PluginScript[] | undefined {
		const set = this.#current.get(kind);
		return set === undefined ? undefined : [...set.values()];
	}

	// 加载宿主。
	// 输入：host、kind/core/modules、context；输出：LoadReport。
	// 错误：必选插件失败或必选根发现有问题时拒绝为 PluginError；其他运行时错误原样传播。
	// 副作用：可能触发首次发现和构建；在 WeakMap 中记录宿主的 kind；宿主状态由 runtime/LoadedFacets 管理。
	// 主要流程：先取得完整脚本集合 -> 记录宿主 kind -> 收集必选根问题 -> 调用 runtime.load -> 把必选问题合并进
	// PluginError，或在没有插件失败但有必选问题时单独抛出。
	async load<P extends Principal>(
		host: Host<P>,
		options: { readonly kind: string; readonly core: readonly PluginFacet<P>[]; readonly modules: HostPackages },
		context: Context,
	): Promise<LoadReport> {
		const { kind, core, modules } = options;
		// scripts 是完整集合，load 之前可能触发大量首次构建；必须 await 后再调用运行时。
		const scripts = await this.scripts(kind, context);
		// 先记录 kind，即使 runtime.load 失败，后续 reload 也能给出正确错误而不是“未加载”。
		this.#kinds.set(host, kind);
		// A required root guarantees its plugins: what discovery reported in one is as fatal as a plugin that failed.
		// 只保留必选根的问题；非必选根的格式问题仍在 discovery 中，但不会让 load 失败。
		const problems = this.#discovery.problems.filter(({ required }) => required);
		let report: LoadReport;
		// runtime.load 自己会处理必选插件的构建/求值失败；这里额外补上发现阶段的问题。
		try {
			report = await this.#runtime.load(host, { kind, core, scripts, modules }, context);
			// 只增强 PluginError：其他异常（编程错误、宿主内部错误）保持原样。
		} catch (error) {
			// 没有必选问题就没有可补充的内容，重抛原始错误以保留堆栈和类型。
			if (!(error instanceof PluginError) || problems.length === 0) throw error;
			throw new PluginError(error.required, error.failed, problems);
			// 用原始 required/failed 加上必选问题构造新错误；注意此时宿主的 load 已经完成（runtime 的语义）。
		}
		// runtime 没有因插件失败而抛错，但必选根有发现问题：仍以空 required 列表和完整 report.failed 拒绝。
		if (problems.length > 0) throw new PluginError([], report.failed, problems);
		return report;
	}

	// 重载宿主。
	// 输入：已 load 的宿主、一次构建结果、context；输出：ReloadReport。
	// 错误：宿主没有由本组件 load 时抛错；运行时重载错误原样传播。
	// 主要流程：从 WeakMap 取宿主 kind -> 取得该 kind 当前集合 -> 同步 ship 本次构建 -> 把集合交给运行时重载。
	// 例：await plugins.reload(host, built, context) 会把 built 中该宿主 kind 的新 facet 换进当前集合并应用到宿主。
	async reload<P extends Principal>(host: Host<P>, built: Built, context: Context): Promise<ReloadReport> {
		const kind = this.#kinds.get(host);
		if (kind === undefined) throw new Error("plugins.reload: the host was not loaded by this component");
		// #set 可能触发首次构建；await 后当前集合才是最新的。
		const set = await this.#set(kind, context);
		// Applied and read in one step: two reloads started together each pass the set their own build made.
		// ship 与读取集合在同一同步段完成：两个并发 reload 各自在 ship 后立即读取，避免交错时把别人的集合当自己的。
		// runtime.reload 用这个完整集合做闭包规则与提交。
		ship(set, kind, built);
		return this.#runtime.reload(host, [...set.values()], context);
	}

	// 创建一个进程内步骤。kind 在创建时固定，步骤执行时只发布这一种。
	// 错误：宿主未由本组件 load 时立即抛错。
	// 例：const step = plugins.step("server", host); 之后 rollout([step], built, context) 重载该宿主一次。
	step<P extends Principal>(name: string, host: Host<P>): RolloutStep {
		const kind = this.#kinds.get(host);
		if (kind === undefined) throw new Error("plugins.step: the host was not loaded by this component");
		return {
			name,
			kinds: [kind],
			// reload 回调实现 RolloutStep 接口：调用组件的 reload，并把结果包装成单个宿主的结果数组；
			// 宿主名字用步骤名，便于 rollout 结果定位。
			reload: async (built, context) => ({
				hosts: [{ host: name, report: await this.reload(host, built, context) }],
			}),
		};
	}

	// 执行完整的灰度发布。
	// 输入：按顺序执行的步骤、一次构建、context；输出：RolloutResult。
	// 副作用：更新各 kind 当前集合、重载宿主；只有全部成功后清除满足条件的标记。
	// 错误：步骤的 ship 或 reload 抛错时立即返回 stopped，后续步骤不执行、标记不清除。
	// 主要流程：逐步骤 ship 它的 kinds -> 调用 step.reload -> 收集失败插件/宿主 -> 记录结果 -> 全部步骤后把
	// “有已构建 kind 没被任何步骤发布”的插件也记为失败 -> 用构建快照清除其余插件的标记。
	// 例：rollout([serverStep, workerStep], built, context) 先服务端后 worker；任一宿主崩溃会让该步骤 kinds 的插件保持脏。
	async rollout(steps: readonly RolloutStep[], built: Built, context: Context): Promise<RolloutResult> {
		const done: { readonly name: string; readonly hosts: readonly RolloutHost[] }[] = [];
		// failed 收集在任何宿主上失败过的插件名；shipped 记录成功步骤发布过的 kind。
		const failed = new Set<string>();
		const shipped = new Set<string>();
		for (const step of steps) {
			let hosts: readonly RolloutHost[];
			try {
				// 步骤开始前把本次构建 ship 到它的每个 kind；#set 的 await 后集合是最新的。
				for (const kind of step.kinds) ship(await this.#set(kind, context), kind, built);
				// 步骤实现负责实际重载；它返回每个宿主的结果，而不是抛出单个宿主的失败。
				hosts = (await step.reload(built, context)).hosts;
				// ship 或步骤本身抛错：整个 rollout 停止，返回已经完成的步骤；不调用 watcher.applied。
			} catch (error) {
				return { steps: done, stopped: { step: step.name, error } };
			}
			// 只有成功返回的步骤才算发布过这些 kind，供最后判断“所有已构建 kind 是否都有宿主收到”。
			for (const kind of step.kinds) shipped.add(kind);
			for (const entry of hosts) {
				// report 分支：宿主报告里被跳过的插件就是失败插件。
				if ("report" in entry) for (const { plugin } of entry.report.failed) failed.add(plugin);
				// error 分支：宿主崩溃或重载失败，该步骤 kinds 的所有插件在这个宿主上都没有成功，全部记为失败。
				// stopped 分支（干净停止）不算失败，宿主下次启动会取当前集合。
				else if ("error" in entry) for (const plugin of builtOf(built, step.kinds)) failed.add(plugin);
			}
			done.push({ name: step.name, hosts });
		}
		// 若某插件有某个已构建 kind 从未被任何成功步骤 ship，它没有在所有运行处生效，保持脏。
		// A plugin with a built kind no step shipped is not applied everywhere it runs: it stays dirty.
		for (const { plugin, facet } of built.facets) if (!shipped.has(facet)) failed.add(plugin);
		// 克隆的 Built 查不到快照；此时仍返回发布结果，但无法安全清除标记。
		const snapshot = this.#snapshots.get(built);
		if (snapshot !== undefined) {
			// applied 接收快照中未被任意宿主判定失败的插件名，以及构建开始时的标记快照；watcher 只清除不晚于快照的标记。
			this.#watcher.applied(
				[...snapshot.plugins.keys()].filter((name) => !failed.has(name)),
				snapshot,
			);
		}
		// stopped 为 undefined 表示全部步骤成功。
		return { steps: done, stopped: undefined };
	}

	// 给指定插件安装依赖。
	// 输入：已发现插件名、context；输出：安装完成的 Promise<void>。
	// 错误：未发现该名字时抛错；npm 失败/中止由 installDependencies 拒绝。
	// 副作用：运行 npm、写插件 node_modules；成功后 watcher.installed 清除 install 标记并标脏。
	async installDependencies(name: string, context: Context): Promise<void> {
		// 首次调用可能还没发现；先发现才能把名字解析成目录和依赖。
		if (!this.#discovered) await this.#discover(context);
		const plugin = this.#discovery.plugins.find((each) => each.name === name);
		if (plugin === undefined) throw new Error(`plugins.installDependencies: no plugin "${name}"`);
		// 把组件的 npm 配置传下去；安装发生在插件的真实目录。
		await installDependencies(plugin, context, this.#options.install);
		this.#watcher.installed(name);
	}

	// 安装新插件到指定根。
	// 输入：来源、根路径、context；输出：插件名数组。
	// 错误：root 不在配置的 roots 中时立即抛错；底层安装错误原样传播。
	// 副作用：调用 install.installPlugin 完成暂存/检查/放入/依赖安装；成功后 watcher.added 设置 set 标记。
	async installPlugin(source: PluginSource, root: string, context: Context): Promise<readonly string[]> {
		// 配置中的根本身可以是对象形式；这里只取路径用于成员检查，传给 installPlugin 的仍是原始 roots。
		const roots = this.#options.roots.map((each) => (typeof each === "string" ? each : each.path));
		// 只接受配置里已有的根，防止把插件装到任意目录；比较是字符串相等，不做 realpath 归一化。
		if (!roots.includes(root)) throw new Error(`plugins.installPlugin: ${root} is not one of the roots`);
		// 展开 install 选项（可能为空），再附加 kinds 与 roots；两个后来字段覆盖同名键。
		const options = { ...this.#options.install, kinds: Object.keys(this.#options.kinds), roots: this.#options.roots };
		const names = await installPlugin(source, root, context, options);
		// added 让 watcher 设置 set 标记：下一次 build 会重新发现并构建新插件。
		this.#watcher.added();
		return names;
	}

	close(): void {
		this.#watcher.close();
	}

	/** Discovers the plugins again; the changes of the plugin set and of `package.json`s seen until now clear. */
	// 重新发现并更新缓存。
	// 输入：context；输出：无。
	// 副作用：替换 #discovery、标记已发现、删除已消失插件的构建缓存、把变化告诉 watcher。
	// 注意：#current 集合不在这里删除（rollout 的 ship 通过 built.removed 处理），但 #built 缓存会清掉。
	async #discover(context: Context): Promise<void> {
		// 先取 watcher 的发现快照；know 用它判断哪些变化在本次发现中已被包含。
		const seen = this.#watcher.discoverySnapshot();
		this.#discovery = await discoverPlugins(
			this.#options.roots,
			{ kinds: Object.keys(this.#options.kinds) },
			context,
		);
		// 即使发现结果为空也算完成发现，避免每次都重新扫描。
		this.#discovered = true;
		// 键格式是 name\u0000kind；indexOf 找到分隔位置，slice 取回插件名。
		// A plugin no longer discovered loses its builds: a name added again is built anew, never served an old build.
		for (const key of this.#built.keys()) {
			const name = key.slice(0, key.indexOf("\u0000"));
			if (!this.#discovery.plugins.some((plugin) => plugin.name === name)) this.#built.delete(key);
		}
		// 告诉 watcher 新的发现结果与旧快照；它会清理不再使用的文件监视和标记。
		this.#watcher.know(this.#discovery, seen);
	}

	/** `kind`'s current set, made at its first use from every discovered plugin's facet of it (built if needed). */
	// 取得某 kind 的当前集合；第一次调用时从所有拥有该 facet 的插件建立。
	// 输出：Map<插件名, PluginScript>；副作用：可能发现、构建，并写入 #current。
	// 并发首次调用可能重复构建，最后以先写入 #current 的集合为准。
	async #set(kind: string, context: Context): Promise<Map<string, PluginScript>> {
		let set = this.#current.get(kind);
		if (set !== undefined) return set;
		if (!this.#discovered) await this.#discover(context);
		// 只包含真正有该 kind facet 文件的插件；只含契约的插件不进入任何 kind 集合。
		const plugins = this.#discovery.plugins.filter((plugin) => plugin.facets[kind] !== undefined);
		const scripts = await Promise.all(
			// 每个插件要么复用 #built 中最新构建，要么现场构建；回调显式标注返回 Promise<PluginScript>，
			// 让 Promise.all 的结果类型可推断。
			plugins.map(async (plugin): Promise<PluginScript> => {
				const built =
					// ?? 只在缓存为 undefined 时构建；失败构建同样会被缓存并复用。
					this.#built.get(`${plugin.name}\u0000${kind}`) ?? (await this.#buildOne(plugin, kind, context));
				return { plugin, built };
			}),
		);
		// 构建期间另一个首次调用可能已经建立集合并写入 #current；优先采用它，避免后完成者覆盖。
		// Built concurrently: a set made meanwhile (by a concurrent first use) wins.
		set = this.#current.get(kind) ?? new Map(scripts.map((script) => [script.plugin.name, script]));
		// 无论采用哪份集合，最后都写回 #current；若已有集合，这里是同一个 Map。
		this.#current.set(kind, set);
		return set;
	}

	/** Builds `plugin`'s facet of `kind` and keeps it as the latest; the watcher learns what it read. */
	// 构建一个 facet 并缓存为最新，同时让 watcher 记录它读了哪些插件文件。
	// 输入：插件记录、kind、context；输出：BuiltFacet（失败也是值）。
	// 错误：buildFacet 的意外异常会传播；正常构建错误在结果中。
	async #buildOne(plugin: Plugin, kind: string, context: Context): Promise<BuiltFacet> {
		const { kinds, publicPath, api } = this.#options;
		// Discovery finds facet files of the app's kinds only.
		// kinds[kind]! 的非空断言假设调用方传入应用声明的 kind；发现阶段只会产生这些 kind 的 facet 文件。
		const { platform, hostPackages } = kinds[kind]!;
		// 组装 BuildOptions：kind 的平台与宿主包 + 应用 kinds 列表 + 完整发现结果；api/publicPath 只在存在时展开。
		// as const 让对象字面量保持字面量类型，便于匹配 BuildOptions 的联合字段。
		const options = {
			hostPackages,
			platform,
			kinds: Object.keys(kinds),
			plugins: this.#discovery.plugins,
			...(api === undefined ? {} : { api }),
			...(publicPath === undefined ? {} : { publicPath }),
		} as const;
		// buildFacet 从零构建，不读取 #built；缓存由下面统一写入。
		const built = await buildFacet(plugin, kind, options, context);
		this.#built.set(`${plugin.name}\u0000${kind}`, built);
		// used 接收本次构建结果数组，watcher 据此把输入文件关联到这个插件；失败构建没有 inputs，会跳过更新，保留上一次成功构建的关联。
		this.#watcher.used([built]);
		return built;
	}
}

/**
 * Applies `built` to `set`, `kind`'s current set: its removed plugins and those rebuilt without a facet of `kind` leave
 * it, its facets of `kind` replace theirs.
 */
// 把一次构建应用到某 kind 的当前集合。
// 规则：移除的插件删掉；本次构建的插件若已没有该 kind 的 facet 也删掉；本次构建的该 kind facet 替换/插入。
// 未在 built.plugins 中的插件不动，因为它们的构建没有重新产生。
function ship(set: Map<string, PluginScript>, kind: string, built: Built): void {
	// built.removed 来自发现差异，代表插件已从磁盘消失。
	for (const name of built.removed) set.delete(name);
	for (const [name, plugin] of Object.entries(built.plugins)) if (plugin.facets[kind] === undefined) set.delete(name);
	// 有 facet 才留在集合中；一个插件的新构建可能删除了某 kind 的文件。
	for (const facet of built.facets) {
		// Own properties only: a plugin may be named like one of `Object.prototype`'s (`constructor`).
		// 只接受 built.plugins 自有的插件名；Object.hasOwn 防止 constructor/toString 等原型键被误认为插件。
		// 第二个 ! 的非空断言由 hasOwn 保证。
		if (facet.facet === kind && Object.hasOwn(built.plugins, facet.plugin)) {
			set.set(facet.plugin, { plugin: built.plugins[facet.plugin]!, built: facet });
		}
	}
}

/** The plugins of `built` with a facet of one of `kinds`. */
// 收集 built 中拥有任一指定 kind 的插件名；可能重复，调用方用 Set 去重。
function builtOf(built: Built, kinds: readonly string[]): string[] {
	return built.facets.filter(({ facet }) => kinds.includes(facet)).map(({ plugin }) => plugin);
}
