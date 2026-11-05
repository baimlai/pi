// The plugin runtime (slice 10 §3, D11): loading and reloading hosts with shipped scripts, without building (no
// esbuild, no watcher), so a worker evaluates what the server built. Per host it keeps the facet loaded for every plugin
// and passes the host its complete set at each reload: unchanged plugins (the same digest) as the same facet objects,
// removed ones (loaded, not shipped) left out; a plugin whose build or evaluation failed keeps its loaded facet (left
// out at startup) and is reported with the host's report; at startup one of a required root (the app's own) rejects the
// load once the host's load settled. The plugins component (`createPlugins`) uses one.

// 本文件是“只有求值、没有构建”的插件运行时：服务器构建并发布脚本，worker 收到脚本后用同一套规则求值，
// 因此 worker 不需要 esbuild 或文件监视器。
// 上游是 plugins.ts 的组件：load 传入初始脚本，reload 传入完整的新集合。下游是 LoadedFacets：
// 它调用 prepare（构建失败则跳过，成功则 evaluateFacet），再把得到的 facet 交给宿主加载/重载。
// 每个宿主在 WeakMap 里记住自己的 LoadedFacets 和宿主包实例，使重载时未变化的插件仍是同一批 facet 对象。
// 文件导读
// 所属模块：packages/chord/src/node/plugins 的运行时层，对应 slice 10 的“只求值、不构建”部署形态。
// 职责边界：把一个种类的完整脚本集合加载/重载到宿主；判断必选插件失败是否致命；按宿主保存模块表与已加载集合。
// 不发现文件、不构建、不监视，也不决定 rollout 顺序。
// 上游入口：plugins.ts 的 createPlugins 在构造时调用 createPluginRuntime；组件的 load/reload 调用这里的方法。
// 下游依赖：surfaces/loaded.ts 的 LoadedFacets（暂存、闭包规则、提交）、evaluate.ts（新脚本求值）、host 的
// LoadReport/ReloadReport；节点侧还会关闭 V8 编译缓存。
// 结果与错误流向：load 返回 LoadReport，必选插件失败时在宿主加载完成后拒绝为 PluginError；reload 返回 ReloadReport，
// 未 load 的宿主直接抛错。单个插件的构建/求值失败不会让整次 load 抛错（除非必选），而是记录在报告里。
// 能力清单：
// - PluginScript：一个插件的构建结果加发现记录的普通数据。
// - PluginError：必选根目录失败或发现问题的聚合错误。
// - RuntimeLoad：load 需要的种类、核心 facet、脚本和宿主包。
// - PluginRuntime：load/reload 两个方法的接口。
// - createPluginRuntime()：关闭 V8 编译缓存（每进程一次）并返回运行时。
// 组合与顺序：createPluginRuntime -> load（首次）-> 多次 reload；load/reload 都把脚本映射成 SetEntry，交由同一个
// LoadedFacets 处理，因此未变化摘要的插件复用旧 facet。
// 示例：const runtime = createPluginRuntime();
// const report = await runtime.load(host, { kind: "worker", core, scripts, modules }, context);
// 这是真实签名；真正调用时 scripts 来自服务器构建后运来的数据，modules 是该进程内的宿主包实例。
// 建议阅读顺序：PluginScript/PluginError -> PluginRuntime 接口 -> createPluginRuntime -> Runtime.load/reload ->
// entryOf/prepare，看失败如何变成报告项。
import { setFlagsFromString } from "node:v8";
import type { Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import type { Host, LoadReport, PluginFacet, PluginFailure, ReloadReport } from "../../host/index.ts";
import { LoadedFacets, type Prepared, type SetEntry } from "../../surfaces/loaded.ts";
import type { BuiltFacet } from "./build.ts";
import type { DiscoveryProblem, Plugin } from "./discover.ts";
import { evaluateFacet, type HostPackages } from "./evaluate.ts";

// 运给宿主的一份普通数据：plugin 是发现记录（决定目录、布局、external），built 是构建结果（脚本或失败）。
// readonly 仅编译期；跨进程序列化后它仍是普通对象，测试会把结构化克隆后的值再传回来。
/** One plugin's facet of a kind as shipped to a host (plain data): its build and its plugin record. */
export type PluginScript = { readonly plugin: Plugin; readonly built: BuiltFacet };

// 必选根目录（应用自己的插件）加载失败时，load 用这个错误拒绝。
// required：其中失败的必选插件；failed：整次加载中所有被跳过的插件，包括非必选；problems：必选根目录里的发现问题。
// 宿主此时已经完成 load（成功的插件已加载），因此调用方需要在捕获后决定停止还是继续。
// 例：new PluginError([{ plugin: "@acme/notes", error }], [...], []) 会生成一句列出必选失败的错误消息。
/**
 * `load`'s rejection when a required root did not deliver its plugins: some failed (their build, evaluation or setup),
 * or discovery reported problems in it (a missing root, an invalid `package.json`, a name another root has). The host's
 * load settled (the others are loaded); the app decides what follows (stopping, mostly). `failed` is the whole
 * report's list.
 */
export class PluginError extends Error {
	/** The required plugins that failed, and why. */
	// 只读字段由构造函数赋值；声明为 readonly 后，TypeScript 在编译期禁止之后重新赋值，运行时不冻结对象。
	readonly required: readonly PluginFailure[];
	/** Every plugin the load left out, required or not. */
	// failed 保留整份报告，不只保留必选插件，便于应用记录全部加载结果。
	readonly failed: readonly PluginFailure[];
	/** What discovery reported in required roots. */
	// 发现问题是另一类失败（根目录缺失、package.json 非法、跨根目录重名），与插件执行失败分开保存。
	readonly problems: readonly DiscoveryProblem[];

	// 构造函数：把必选失败和发现问题拼成可读消息，并保存三份原始数据。
	// problems 的默认值 [] 让不需要发现问题的调用方少传一个参数。
	constructor(
		required: readonly PluginFailure[],
		failed: readonly PluginFailure[],
		problems: readonly DiscoveryProblem[] = [],
	) {
		// 先构造消息片段：必选插件用“名字: 错误消息”，发现问题用“路径: 错误”。
		const named = [
			// map 的回调解构 PluginFailure；error 的静态类型是 unknown，因此用 instanceof 做运行时收窄后再取 message。
			...required.map(
				({ plugin, error }) => `"${plugin}": ${error instanceof Error ? error.message : String(error)}`,
			),
			// DiscoveryProblem 的 error 已是字符串，直接插入消息。
			...problems.map(({ path, error }) => `${path}: ${error}`),
		];
		// 调用父类 Error 构造器设置 message；随后覆盖 name，使日志显示 PluginError 而不是 Error。
		super(`required plugin failed at load: ${named.join("; ")}`);
		this.name = "PluginError";
		// 保存引用而不是副本；调用方读取的是报告里的同一批失败记录。
		this.required = required;
		this.failed = failed;
		this.problems = problems;
	}
}

/** What `PluginRuntime.load` takes besides the host. */
// load 的参数：kind 是 facet 种类名；core 是应用自己的 facet；scripts 是该种类的完整脚本集合；
// modules 是宿主包实例表，运行时会在后续重载中一直复用它。
export type RuntimeLoad<P extends Principal> = {
	readonly kind: string;
	readonly core: readonly PluginFacet<P>[];
	readonly scripts: readonly PluginScript[];
	readonly modules: HostPackages;
};

/** The plugin runtime: loads and reloads hosts with complete sets of shipped scripts. */
export interface PluginRuntime {
	// load 的契约（中文概括）：对每个脚本调用 prepare，构建/求值失败者被跳过；成功后交给宿主加载。
	// 若失败者属于必选插件，在宿主 load 完成后以 PluginError 拒绝；参数中的 context 用于宿主内部上下文。
	/**
	 * Evaluates `scripts` (the complete set of `kind`) with `modules` (the host packages their `require` answers: this
	 * process's instances, kept for the host's reloads) and loads them on `host` with `core` (the app's own facets): a
	 * plugin whose build or evaluation failed is left out and reported with the host's report. When plugins of a
	 * required root are among the failed, it rejects with a `PluginError` naming them after the host's load settled.
	 */
	load<P extends Principal>(host: Host<P>, options: RuntimeLoad<P>, context: Context): Promise<LoadReport>;
	// reload 的契约（中文概括）：scripts 是现在的完整集合，不是增量。未变化（digest 相同）的插件传入同一 facet；
	// 失败的插件传入已加载的旧 facet（新增的失败插件不传），让宿主的闭包规则决定旧消费者是否保留；
	// 已加载但不在 scripts 中的插件被移除。宿主即使以 aborted 拒绝，只要它已经提交，提交结果仍是新的加载集合。
	/**
	 * Reloads `host` (loaded by `load`) with `scripts`, the complete set now, after its earlier reloads: its core facets
	 * and unchanged plugins (the same digest) as the same objects, new scripts evaluated, a plugin whose build or
	 * evaluation failed passed as its loaded facet (an added one left out; both given to the host's closure rule),
	 * loaded plugins not in `scripts` left out. What the host committed is the loaded set, also when the reload rejects
	 * `aborted` after its commit.
	 */
	reload<P extends Principal>(
		host: Host<P>,
		scripts: readonly PluginScript[],
		context: Context,
	): Promise<ReloadReport>;
}

/**
 * Creates a plugin runtime: turns V8's compilation cache off (once per process: each distinct evaluated script would
 * stay cached).
 */
// 创建一个插件运行时。V8 的编译缓存是进程级开关，只能关不能按脚本关；每次加载不同摘要的脚本都会占用缓存，
// 长期运行的服务器反复重载会不断积累，所以第一次创建运行时就关闭，并用模块级布尔量保证只设置一次。
// 输入：无；输出：新的 PluginRuntime；副作用：可能修改 V8 进程标志。
// 例：const runtime = createPluginRuntime(); 第二次调用不会再执行 setFlagsFromString。
export function createPluginRuntime(): PluginRuntime {
	// 已有别的运行时关过缓存就跳过；cacheOff 是模块级状态，多个组件共享同一个进程设置。
	if (!cacheOff) {
		// setFlagsFromString 修改的是当前进程的 V8 标志，属于有全局影响的操作；这也是它只在创建运行时执行一次的原因。
		setFlagsFromString("--no-compilation-cache");
		cacheOff = true;
	}
	return new Runtime();
}

/** Whether this process turned V8's compilation cache off already. */
// 放在使用它的函数之后声明：函数体在调用时才读取这个 let，因此初始化顺序没有影响。
let cacheOff = false;

// 运行时实现：一个实例可服务多个宿主，状态按宿主对象隔离。
class Runtime implements PluginRuntime {
	/** Each loaded host's plugins and modules, held as long as the host is. */
	// #hosts 是 ES 私有字段（编译后仍是私有存储，不是 TypeScript 的 private 修饰符）。
	// 键是宿主对象，值是它的 LoadedFacets 和模块表；宿主被回收后条目可一起回收。
	// 同一个宿主只能由本运行时 load 一次，reload 依赖这里保存的状态。
	readonly #hosts = new WeakMap<object, { readonly loaded: LoadedFacets; readonly modules: HostPackages }>();

	// 加载一个宿主的初始插件集合。
	// 输入：host、RuntimeLoad 和上下文；输出：宿主的 LoadReport。
	// 副作用：求值脚本、在宿主上加载 facet，并记住该宿主的状态。
	// 错误：LoadedFacets.load 自身的错误向外传播；必选插件失败时在加载完成后抛 PluginError。
	async load<P extends Principal>(host: Host<P>, options: RuntimeLoad<P>, context: Context): Promise<LoadReport> {
		// 解构出模块表和脚本；options 其余字段（kind、core）仍在后面直接使用。
		const { modules, scripts } = options;
		// 每个脚本先转成 SetEntry（名字、摘要、惰性 prepare），此时还没有求值。
		const entries = scripts.map((script) => entryOf(script, modules));
		// 把核心 facet 和插件条目一起交给 LoadedFacets；await 等宿主完成加载并拿到报告。
		const { loaded, report } = await LoadedFacets.load(host, options.core, entries, context);
		// 先保存状态再检查必选失败：宿主已经加载成功，后续重载需要这份 LoadedFacets 才能继续。
		this.#hosts.set(host, { loaded, modules });
		// 只把 required 为 true 的插件名放进 Set；报告里的插件名与 Plugin.name 相同。
		const required = new Set(scripts.filter(({ plugin }) => plugin.required).map(({ plugin }) => plugin.name));
		// filter 的回调解构 PluginFailure；required.has(plugin) 判断这个失败是否属于必选根目录。
		const fatal = report.failed.filter(({ plugin }) => required.has(plugin));
		// 有任何必选失败就拒绝：required 只含必选者，failed 保留整份报告。
		if (fatal.length > 0) throw new PluginError(fatal, report.failed);
		// 非必选失败不影响 Promise 的结果，报告照常返回给调用方记录。
		return report;
	}

	// 重载已加载的宿主。
	// 输入：宿主、新的完整脚本集合、上下文；输出：宿主的 ReloadReport。
	// 错误：宿主不是由本运行时加载时立刻抛错；其余错误由 LoadedFacets.reload 与宿主决定。
	// 注意：这里取的是 load 时保存的 modules，而不是调用方重新传入的模块表，保证宿主包实例跨重载一致。
	reload<P extends Principal>(
		host: Host<P>,
		scripts: readonly PluginScript[],
		context: Context,
	): Promise<ReloadReport> {
		// 反查该宿主的状态；undefined 说明调用顺序错误（未 load 就 reload）。
		const state = this.#hosts.get(host);
		// 这是编程错误，直接 throw 而不是返回被拒绝的 Promise；调用方应立即修复加载流程。
		if (state === undefined) throw new Error("plugins.reload: the host was not loaded by this runtime");
		// 用保存的模块表求值新脚本；未变化的摘要在 LoadedFacets 内会复用旧 facet，不会重新执行。
		const entries = scripts.map((script) => entryOf(script, state.modules));
		// LoadedFacets.reload 负责暂存、闭包规则和提交；本运行时只提供求值好的条目。
		return state.loaded.reload(host, entries, context);
	}
}

/** `script` as one plugin of a complete set: its digest, and its evaluation with `modules` when it is new. */
// 把一个 PluginScript 映射为 LoadedFacets 需要的 SetEntry；参数解构出 plugin 和 built 两个字段。
// digest 是判断“同一脚本”的依据：构建失败时没有摘要，设为 undefined，使宿主每次都把它当作失败重新准备。
function entryOf({ plugin, built }: PluginScript, modules: HostPackages): SetEntry {
	return {
		// 名字用于宿主报告和插件身份。
		name: plugin.name,
		// digest 只在构建成功时存在；条件表达式在这里做类型收窄。
		digest: built.kind === "script" ? built.digest : undefined,
		// prepare 是惰性函数：LoadedFacets 只在需要求值（新脚本或要报告失败）时调用它，未变化插件不会触发执行。
		prepare: () => prepare(plugin, built, modules),
	};
}

/** `built` evaluated for `plugin` with `modules`, or why not: its build failed, or its evaluation threw. */
// 求值一个构建结果，并把两类失败统一成 Prepared 的 failed 分支。
// 输入：插件记录、构建结果、宿主包；输出：{kind:"facet"} 或 {kind:"failed"}。
// 副作用：成功时执行插件代码；失败时只构造错误，不抛出。
// 例：构建失败会得到带原始 errors 列表的 Error；求值抛错则保留插件抛出的原值。
function prepare(plugin: Plugin, built: BuiltFacet, modules: HostPackages): Prepared {
	// 构建失败不是异常，而是 BuiltFacet 的一个分支；把它转成错误对象交给加载器统一报告。
	if (built.kind === "failed") {
		// 消息包含插件名、种类和构建错误的逐行文本；errors 是构建器收集的消息字符串数组。
		const message = `plugin "${plugin.name}": its ${built.facet} facet failed to build:\n${built.errors.join("\n")}`;
		return { kind: "failed", error: new Error(message) };
	}
	// 求值异常在这里被收住：宿主需要的是“哪个插件失败”，而不是让整次加载因一个插件崩溃。
	try {
		// 成功路径：得到 facet；built 已由上面的分支收窄为 script 类型，因此可以传给 evaluateFacet。
		const facet = evaluateFacet(built, { hostPackages: modules, plugin });
		// 摘要随 facet 一起返回，LoadedFacets 用它记录这个 facet 对应哪次构建。
		return { kind: "facet", facet, digest: built.digest };
		// catch 参数是 unknown；不检查形状，原样作为失败原因保存，后续报告会把它转成文本。
	} catch (error) {
		return { kind: "failed", error };
	}
}
