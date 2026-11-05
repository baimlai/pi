// `startServer` (slice 13 §1, §5; decisions "The app kit, point 1" to "point 5"): the server of an app built with the kit.
// It lays out the data directory, opens the server's store, creates the server host, the HTTP component and one
// workers component per worker kind, the plugins component over the app's required root and the user's root, loads
// the server's plugins with the kit's own facets (the start-data object, sessions, the owner link, pairing, files),
// and gives the app the controls it needs: the owner link, `applyChanges`, installs, export and import per address.

// 所属：packages/chord/src/node/app，Chord v2 的 app kit 服务器入口（slice 13 §1/§5）。
// 职责：startServer 把数据目录、服务器 store、服务器 host、HTTP、plugins、workers 和核心 facet 组装成可运行的 App；负责启动顺序、单实例锁、owner 链接和按地址的导入导出。
// 上游：应用启动脚本调用 startServer(options, context)；下游：layout/secrets/sessions/owner/pairing/files/plugins/workers/http/surfaces/archive/data 各模块。
// 结果：返回 App<P>（host/http/workers/plugins/ownerLink/applyChanges/exportData/importData/close）；失败时关闭已建资源并抛出 PluginError 或启动错误。
// 能力清单：Server 是服务器 host kind；AppApi/AppKind/AppWorkerKind 描述 API 与 worker 种类；AppError 是错误标签联合；AppOptions 是启动选项；AppLimits 是公开端点/导入上限；AppWeb/AppPlugins 是 web 与插件控制面；App 是运行中接口；KitStart 是发给 worker 的 kit 数据；startServer 是入口；RunningApp 是 App 的实现。
// 组合顺序：startServer → openServer（锁、目录、cookie secret、store）→ createHost → createHttp → createPlugins → workersOf → 核心 facet → surfacesOf → plugins.load → ownerTokenFile → started（renew owner link 并取得监听地址）。
// 示例：const app = await startServer({ name: 'acme', api, kinds: { server: { platform: 'node' } }, principal: { server: { kind: 'owner' }, worker: () => ({ kind: 'worker' }) }, onError }, ctx);
// 建议阅读顺序：先看 Server/AppApi/AppOptions/App 类型，再看 startServer 主流程，然后 openServer、workersOf、RunningApp 的 exportData/importData/close；其余模块按需跳转。
// 错误流向：onError 回调接收 host/http/workers/plugins 四类 AppError；startServer 自身的初始化失败会先 close 再抛出；单实例锁冲突明确提示另一个服务器正在运行。
import { join, resolve } from "node:path";
import { type Context, withAbortSignal } from "../../context/index.ts";
import { type Address, type HostKind, hostKind, type KindShape } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import { canonicalJson } from "../../data/principal.ts";
import { createHost, type Facet, type Host, type HostError, type PluginFacet } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import { openNodeSqliteDatabase } from "../../sqlite/node.ts";
import { openStore, type Store, sqliteBackend } from "../../store/index.ts";
import { themeChoiceFacet, themesFacet } from "../../surfaces/index.ts";
import type { Watchable } from "../../watch.ts";
import { createHttp, type HttpComponent, type HttpError, type ListenAddress } from "../http/index.ts";
import {
	createPlugins,
	type HostPackages,
	type InstallOptions,
	type PluginSource,
	type Plugins,
	type PluginsError,
	type PluginsState,
	type RolloutResult,
	type RolloutStep,
} from "../plugins/index.ts";
import { tuiSurface, WEB_PREFIX, type WebSurfaceOptions, webSurface } from "../surfaces/index.ts";
import { createWorkers, type ProcessLock, processLock, type Workers, type WorkersError } from "../workers/index.ts";
import { ARCHIVE_FORMAT, type ArchiveManifest, packData, unpackData } from "./archive.ts";
import { addressParam, HostData } from "./data.ts";
import { type FilesCaps, filesFacet } from "./files.ts";
import { appInfoFacet } from "./info.ts";
import { type AppLayout, createLayout, defaultDataDir, openDataDir, privateStore, workerDirectory } from "./layout.ts";
import { OWNER_PATH, OwnerLink, type OwnerPrincipal, ownerFacet, ownerTokenFile } from "./owner.ts";
import { Pairings, pairingFacet } from "./pairing.ts";
import { secretFile } from "./secrets.ts";
import { createSessions } from "./sessions.ts";

// 服务器地址只有 kind，没有参数；每次调用 Server() 都得到同一地址形状，实际对象由 host 持有。
/** The server's host kind: the kit's server host is `Server()`. */
export const Server = hostKind("server");

// AppApi 是应用对插件暴露的包：名称、版本列表（新到旧）和本进程可导入的模块表。
/**
 * The app's API (slice 12): its package name, the versions it provides (newest first) and this process's modules of
 * them by specifier (`@acme/app/v3`, `@acme/app/v3/server`).
 */
// name 用于默认数据目录和归档归属；versions[0] 是最新 API 版本；modules 的键是 import 说明符。
export type AppApi = {
	readonly name: string;
	readonly versions: readonly string[];
	readonly modules: HostPackages;
};

// AppKind 描述一类 facet 的运行平台和额外共享包；API 模块名按 <api>/<version> 与 <api>/<version>/<kind> 约定生成。
/**
 * A facet kind of the app: where its builds run, and the packages besides the API its plugins share (`react`). Its API
 * modules are named by convention: `<api>/<version>` and `<api>/<version>/<kind>` for every version.
 */
// platform 决定插件包能否在 node 或 browser 中构建；packages 是 API 之外的共享依赖（如 react）。
export type AppKind = { readonly platform: "node" | "browser"; readonly packages?: HostPackages };

// AppWorkerKind 描述一种 worker：host kind、入口模块、启动参数、facet 种类、start 数据、授权函数和空闲时间。
/** A worker kind: a host kind of the app and how its workers start (the workers component's options). */
export type AppWorkerKind<P extends Principal> = {
	/** The host kind (`hostKind("project", { id: str() })`). */
	// kind 是 worker 地址的 host kind；entry 指向调用 startWorker 的模块。
	readonly kind: KindShape;
	/** The worker's entry module (it calls `startWorker`), its Node flags and environment. */
	readonly entry: string;
	// execArgv/env 原样交给子进程；undefined 时不覆盖默认值。
	readonly execArgv?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	/** The facet kind its workers load: `worker` by default. */
	// facet 缺省为 worker；它决定 worker 加载哪类插件包。
	readonly facet?: string;
	/** The app's start data for the worker at `address` (JSON), before each start. */
	// start 为每个地址生成应用启动数据，可以是同步或异步；结果会成为 WorkerInfo.start 和 startWorker 的 app。
	readonly start: (address: Address, context: Context) => Promise<JsonValue> | JsonValue;
	/** Whether `principal` may reach the worker at `address` (synchronous). */
	// authorize 只做同步判断；服务器身份在 workersOf 中始终放行，不依赖此函数。
	readonly authorize: (principal: P, address: Address) => boolean;
	/** How long a worker idles before it stops: 5 minutes by default. */
	// idleMs 是函数，允许按运行时配置返回不同空闲时长；缺省由 workers 组件决定。
	readonly idleMs?: () => number;
};

// AppError 是标签联合：kind 区分来源，error 保留各组件自己的错误结构；onError 接收这个联合。
/** What the kit reports: from its host, its HTTP component, its workers or its plugins. */
export type AppError =
	| { readonly kind: "host"; readonly error: HostError }
	| { readonly kind: "http"; readonly error: HttpError }
	| { readonly kind: "workers"; readonly error: WorkersError }
	| { readonly kind: "plugins"; readonly error: PluginsError };

// AppOptions 是 startServer 的全部输入；最后一个交叉类型用条件类型强制应用 principal 联合包含 owner。
/** What `startServer` takes. `{ kind: "owner" }` must be one of the app's principals (the kit's owner). */
export type AppOptions<P extends Principal> = {
	// name 同时决定默认数据目录 ~/.<name>、归档 app 字段和进程锁前缀。
	/** The app's name: its default data directory is `~/.<name>`, its archives carry it. */
	readonly name: string;
	// dataDir 可由启动脚本显式指定；环境变量不参与决定。
	/** The data directory (the start script's to decide; no environment variables): `~/.<name>` by default. */
	readonly dataDir?: string;
	// root 是应用内置插件根，required: true；用户插件根在数据目录中。
	/** The app's built-in plugins root (required): `plugins/` of the working directory by default. */
	readonly root?: string;
	// listen 缺省绑定 127.0.0.1 的随机端口，适合本机应用和测试。
	/** Where the server listens: `127.0.0.1`, a free port by default. */
	readonly listen?: ListenAddress;
	// api 的模块表同时用于服务器插件和 worker 的模块解析。
	readonly api: AppApi;
	/** The app's facet kinds: `server` and each worker kind's facet kind among them. */
	// kinds 的键是 facet 种类名，服务器必须有一条 server 项。
	readonly kinds: Readonly<Record<string, AppKind>>;
	// principal.server 是服务器身份，principal.worker 按地址生成 worker 身份；两者都会写入链路。
	/** The server's principal and each worker's (stamped on its link). */
	readonly principal: { readonly server: P; readonly worker: (address: Address) => P };
	/** The worker kinds; none: a server with clients only. */
	// workers 可省略：只有客户端、没有 worker 的应用也能启动。
	readonly workers?: readonly AppWorkerKind<P>[];
	/** The caps of each host's files (the server's and every worker's). */
	// files 是服务器和所有 worker 共用的文件容量上限。
	readonly files?: FilesCaps;
	/** The bounds of what public endpoints and imports may cost. */
	// limits 限制公开登录、配对、上传和导入的资源消耗。
	readonly limits?: AppLimits;
	/** How installs run npm (slice 12's `InstallOptions`): `npm` on the `PATH` by default. */
	// install 控制 npm 安装行为；缺省使用 PATH 上的 npm。
	readonly install?: InstallOptions;
	// web 存在时加载 web surface 和 web facet kind；page/paths/public 交给 webSurface。
	/**
	 * The web surface (slice 11): the app's web entry (the base bundle's), its page template, the paths serving the
	 * page (`["/"]`), whether the page is public; the `web` facet kind. None: no web surface.
	 */
	readonly web?: AppWeb;
	// tui 存在时加载终端 surface；entry 是终端客户端入口模块。
	/** The terminal surface (slice 11): the app's terminal entry; the `tui` facet kind. None: no terminal clients. */
	readonly tui?: { readonly entry: string };
	// onError 是唯一的错误上报通道，必须在启动时提供。
	readonly onError: (error: AppError) => void;
	// 条件类型：OwnerPrincipal 已包含于 P 时交叉 unknown（无影响），否则要求一个带 never 值的额外属性，使调用处编译失败。
} & (OwnerPrincipal extends P ? unknown : { readonly "the app's principal type must have { kind: 'owner' }": never });

// AppLimits 是公开端点与导入的预算；每项都可省略，由各组件填默认值。
/**
 * The bounds of what public endpoints, clients and imports may cost: live ephemeral sessions (1,000; past it the
 * oldest ends, signed out), pairings under way that anonymous clients started (100 in all, 10 per client address; past
 * them 429; the owner's own are not counted), uploads under way per `Files` object (64; past it `unavailable`, `busy`),
 * an archive's unpacked bytes (4 GiB) and entries (100,000).
 */
export type AppLimits = {
	// uploads 是每个 Files 对象同时进行的上传数；ephemeralSessions 是内存临时会话上限。
	readonly uploads?: number;
	readonly ephemeralSessions?: number;
	// pendingPairings/pairingsPerAddress 限制匿名配对；owner 的配对不计入。
	readonly pendingPairings?: number;
	readonly pairingsPerAddress?: number;
	// importBytes/importEntries 限制解包归档的总字节和条目数。
	readonly importBytes?: number;
	readonly importEntries?: number;
};

// AppWeb 从 webSurface 选项里挑出应用可配置的字段；kind 固定为 web，插件由 kit 自动带上。
/** The kit's web surface options (`webSurface`'s, its kind `web` and plugins the kit's). */
export type AppWeb = Pick<WebSurfaceOptions, "entry" | "page" | "paths" | "public">;

// AppPlugins 暴露插件状态、安装函数和组件本身；应用按钮据此显示 dirty/install/base 等标记。
/** The plugins of a running app, for its "apply changes" control and its installs. */
export type AppPlugins = {
	/** The marks (`dirty`, `install`, `set`, `base`): what the app's button shows. */
	// state 是只读 watchable，界面可订阅；不要在应用侧直接修改。
	readonly state: Watchable<PluginsState>;
	// install 从 git/npm 安装到用户插件根，返回安装的插件名；错误通过 Promise 拒绝。
	/** Installs plugins from git or npm into the user's root (slice 12's `installPlugin`); their names. */
	install(source: PluginSource, context: Context): Promise<readonly string[]>;
	// component 是完整 Plugins 组件，供高级控制使用。
	/** The plugins component itself. */
	readonly component: Plugins;
};

// App 是运行中应用的接口：host/http/workers/plugins/surfaces/dataDir/ownerLink/ownerTokenFile/applyChanges/exportData/importData/close。
/** A running app. */
export interface App<P extends Principal> {
	// host 是服务器主机；http 已带路由和链路；workers 按 host kind 名索引。
	readonly host: Host<P>;
	readonly http: HttpComponent<P>;
	/** The workers components, by host kind name. */
	readonly workers: ReadonlyMap<string, Workers<HostKind>>;
	// plugins 是上面 AppPlugins 的控制面。
	readonly plugins: AppPlugins;
	// web/tui 的 base 只在对应 surface 启用时存在；base 是构建产物的哈希标识。
	/** The web surface's base bundle hash, when the app has one. */
	readonly web: { readonly base: string } | undefined;
	/** The terminal surface's base bundle hash, when the app has one. */
	readonly tui: { readonly base: string } | undefined;
	// dataDir 是解析后的真实路径，不是调用方传入的原始字符串。
	/** The data directory. */
	readonly dataDir: string;
	// ownerLink 每次启动变化，包含一次性 token；token 在 fragment 中，不进入 HTTP 请求行。
	/** The owner link of this start (single use, 10 minutes): `http://127.0.0.1:<port>/_chord/owner#<token>`. */
	ownerLink(): string;
	// ownerTokenFile 是命令行客户端使用的 0600 设备 token 文件路径。
	/** The owner token file's path (a device session of the owner, mode 0600). */
	readonly ownerTokenFile: string;
	// applyChanges 只构建 dirty 插件并按 server→workers→surfaces 顺序发布；不会自动调用。
	/** Builds the dirty plugins and rolls them out: the server, every worker kind, then the clients; never by itself. */
	applyChanges(context: Context): Promise<RolloutResult>;
	// exportData 不停 worker：运行中的 worker 自己打包；没有 worker 时服务器持锁打包。
	/**
	 * Writes the data the worker at `address` created (its store and finished files) as an archive at `path`, stopping
	 * nothing: a running worker packs its own store at one consistent point; without one the server packs it under the
	 * worker's lock (no worker starts meanwhile).
	 */
	exportData(address: Address, path: string, context: Context): Promise<void>;
	// importData 要求地址尚无数据；worker 正在运行说明已有数据，因此拒绝覆盖。
	/**
	 * Makes the data of `address` (which must have none yet: nothing is overwritten) from the archive at `archive`,
	 * under the worker's lock; its next hold starts it.
	 */
	importData(archive: string, address: Address, context: Context): Promise<void>;
	// close 按固定顺序释放资源，可重复调用；第二次返回同一 Promise。
	/** Closes the HTTP component, the workers, the host, the store, the watcher and the data directory's lock. */
	close(context: Context): Promise<void>;
}

// KitStart 是 startServer 放进 worker 启动数据的 kit 部分：目录、facet 种类、身份、服务器身份、文件上限和上传上限。
/** What `startWorker` reads from its start data besides the app's: the kit's part. */
export type KitStart = {
	// dir 是该 worker 地址专属的数据目录；facet 决定加载哪类插件。
	readonly dir: string;
	readonly facet: string;
	// principal/server 在 wire 上必须是 JSON；worker 用它们建立主机身份和服务器链路。
	readonly principal: JsonValue;
	readonly server: JsonValue;
	// files/uploads 由服务器统一配置，worker 不能自行放宽。
	readonly files: { readonly maxFile?: number; readonly maxTotal?: number };
	/** The cap of uploads under way per `Files` object (`limits.uploads`). */
	readonly uploads?: number;
};

// 启动应用服务器：解析参数、建立资源、加载核心 facet 与插件并开始监听；返回可关闭的 App。
// 输入 AppOptions 和 Context；输出 Promise<App<P>>。失败时关闭已建立的资源再抛出，避免泄漏锁和 store。
// 主流程：openServer → sessions/host/http/plugins → workers → core facets → surfaces → plugins.load → ownerTokenFile → started。
// 示例：await startServer({ name:'acme', api, kinds:{server:{platform:'node'}}, principal:{server:{kind:'owner'}, worker()...}, onError }, ctx)。
/**
 * Starts the app's server (§1): resolves once its plugins are loaded and it listens. A failing plugin of the app's
 * root (or a problem discovery reports there) rejects with the plugins component's `PluginError`, everything closed.
 */
export async function startServer<P extends Principal>(options: AppOptions<P>, context: Context): Promise<App<P>> {
	// openServer 返回布局、cookie 密钥、store 和进程锁；路径先 resolve，支持相对 dataDir。
	const { layout, cookieSecret, store, lock } = await openServer(
		resolve(options.dataDir ?? defaultDataDir(options.name)),
		context,
	);
	// 解构常用选项；limits 缺省为空对象，各组件再填默认值。
	const { onError, api, limits = {} } = options;
	// 创建会话子系统；maxEphemeral 来自 limits，缺省 1000。
	const sessions = createSessions<P>(cookieSecret, { maxEphemeral: limits.ephemeralSessions });
	// 建立服务器 host；地址是 Server()，身份是 principal.server。
	const host = createHost<P>({
		// host 错误包装成 AppError 的 host 分支。
		address: Server(),
		principal: options.principal.server,
		store,
		onError: (error) => onError({ kind: "host", error }),
	});
	// 创建 HTTP 组件；listen 缺省本机随机端口，链路路径为 /chord。
	const http = createHttp(
		host,
		{
			// links.opened 使用 sessions.opened，在每次链路打开时计数临时会话连接。
			listen: options.listen ?? { host: "127.0.0.1", port: 0 },
			// HTTP 错误包装成 AppError 的 http 分支。
			links: { path: "/chord", opened: sessions.opened },
			onError: (error) => onError({ kind: "http", error }),
		},
		context,
	);
	// 创建插件组件：应用根（必需）加用户插件根，API 名称/版本，facet 种类和安装选项。
	const plugins = createPlugins(
		{
			// roots 顺序固定：先内置根，后用户根；required 只对内置根生效。
			roots: [{ path: resolve(options.root ?? "plugins"), required: true }, layout.plugins],
			// api 只暴露名称和版本；模块表不交给插件发现，而是由各 kind 的 hostPackages 指定。
			api: { name: api.name, versions: api.versions },
			// Object.fromEntries 把 options.kinds 映射成插件组件的 kinds 表；hostPackagesOf 计算每个 kind 的模块清单。
			kinds: Object.fromEntries(
				Object.entries(options.kinds).map(([name, kind]) => [
					name,
					{ platform: kind.platform, hostPackages: hostPackagesOf(api, name, kind) },
				]),
			),
			// 安装选项原样传入；publicPath 是浏览器资源的公开前缀。
			install: options.install,
			publicPath: `${WEB_PREFIX}assets/`,
			// 插件错误包装成 AppError 的 plugins 分支。
			onError: (error) => onError({ kind: "plugins", error }),
		},
		context,
	);
	// workers 表按 host kind 名索引；没有 worker 时保持空表。
	const workers = new Map<string, Workers<HostKind>>();
	// 逐个创建 workers 组件；kind.kind.kind 是 host kind 的字符串名。
	for (const kind of options.workers ?? []) {
		workers.set(kind.kind.kind, workersOf(host, kind, options, layout.dataDir, plugins, context));
	}
	// owner 链接对象只保存当前 token 摘要；每次启动 renew 一次。
	const link = new OwnerLink();
	// core 是 kit 自带 facet 列表，加载前必须全部登记。
	const core: PluginFacet<P>[] = [
		// HTTP 组件作为 facet 暴露，插件可贡献路由或包装。
		{ name: "chord.http", facet: http.facet },
		{
			name: "chord.app.info",
			// AppInfo 的 version 取最新 API 版本，没有版本时为空字符串。
			facet: appInfoFacet({ dataDir: layout.dataDir, name: options.name, version: api.versions[0] ?? "" }),
		},
		// Sessions 提供签发/验证/撤销和认证器。
		{ name: "chord.app.sessions", facet: sessions.facet },
		// owner 路由使用上面的 OwnerLink。
		{ name: "chord.app.owner", facet: ownerFacet(link) },
		// pairing 使用 limits 构造内存 Pairings；owner 配对不受上限。
		{
			name: "chord.app.pairing",
			// Pairings 是每次 startServer 独立的内存表，不持久化。
			facet: pairingFacet(
				new Pairings({ maxPending: limits.pendingPairings, perAddress: limits.pairingsPerAddress }),
			),
		},
		// 服务器 Files 使用 server/files；worker 各自使用自己的目录。
		{ name: "chord.app.files", facet: filesFacet(join(layout.server, "files"), options.files, limits.uploads) },
		// 主题 facet 是 kit 提供的 UI 基础能力。
		{ name: "chord.themes", facet: themesFacet() },
		{ name: "chord.themes.choice", facet: themeChoiceFacet() },
	];
	// surfaces 数组在构造函数时为空，load 前由 surfacesOf 填充。
	const surfaces: Surface<P>[] = [];
	// 先构造 RunningApp：它持有资源引用和关闭顺序；此时尚未 started。
	const app = new RunningApp(host, http, workers, plugins, surfaces, { store, lock }, layout, options);
	// try/catch 包住后续所有启动步骤，任何失败都调用 close。
	try {
		// 依次构建启用的客户端 surface；构建失败会走 catch。
		for (const surface of await surfacesOf(host, options, plugins, context)) {
			// surface 加入数组，供 applyChanges 的 rollout 步骤使用。
			surfaces.push(surface);
			// surface facet 以 chord.<name> 加入 core，插件和 HTTP 才能使用。
			core.push({ name: `chord.${surface.name}`, facet: surface.facet });
		}
		// 加载服务器插件：kind 固定 server，core 是 kit facet，modules 是本进程可导入模块。
		await plugins.load(host, { kind: "server", core, modules: modulesOf(api, options.kinds.server) }, context);
		// 准备 owner token 文件：复用仍有效的设备会话，否则签发新的。
		await ownerTokenFile(layout.ownerToken, host, context);
		// 标记启动完成：生成新 owner link token，并取得实际监听地址。
		app.started(link.renew(), await http.listening(context));
		// 任何启动失败：先关闭已建资源，再重新抛出原始错误。
	} catch (error) {
		await app.close(context);
		throw error;
	}
	// 成功返回 RunningApp；调用方负责在退出时 close。
	return app;
}

// Surface 是 web/tui 客户端面的内部描述：名称、facet、rollout 步骤和 base 哈希。
/** A client surface of the app: its name (`web`, `tui`), its facet, its rollout step, its base bundle's hash. */
type Surface<P extends Principal> = {
	readonly name: "web" | "tui";
	// name 固定为 web 或 tui；step 生成该面的发布步骤；base 是构建产物标识。
	readonly facet: Facet<P>;
	step(name: string): RolloutStep;
	readonly base: string;
};

// 构建启用的客户端面：web 在前、tui 在后；输入 host/options/plugins/context，返回 Surface 数组。
// 任一 surface 构建失败会向上传播，startServer 的 catch 负责关闭资源。
/** The app's client surfaces, built (their base bundles) in order: the web's, the terminal's. */
async function surfacesOf<P extends Principal>(
	host: Host<P>,
	options: AppOptions<P>,
	plugins: Plugins,
	context: Context,
): Promise<Surface<P>[]> {
	// 局部数组收集结果；没有启用任何面时返回空数组。
	const surfaces: Surface<P>[] = [];
	// web 选项存在才构建；webSurface 返回 facet/step/base，展开进 Surface。
	if (options.web !== undefined)
		surfaces.push({ name: "web", ...(await webSurface(host, { ...options.web, plugins }, context)) });
	// tui 只接收 entry 和 plugins，其他选项由 tuiSurface 决定。
	if (options.tui !== undefined) {
		surfaces.push({ name: "tui", ...(await tuiSurface(host, { entry: options.tui.entry, plugins }, context)) });
	}
	// 顺序决定 applyChanges 的发布顺序：先 web 后 tui。
	return surfaces;
}

// 第二个服务器等待锁 1 秒；超时即认为已有实例在运行。
/** How long a second server waits for the data directory's lock before it is refused. */
const SERVER_LOCK_MS = 1000;

// 打开服务器独占部分：数据目录锁、私有布局、cookie 密钥和服务器 store；失败时释放锁。
// 锁按真实路径命名，符号链接无法绕过；返回 layout/cookieSecret/store/lock。
/**
 * The server's own part of the data directory `path`: its lock (one server per data directory, by its real path: a
 * second one, also through a symbolic link, would share its stores and secrets), the layout made private, the cookie
 * secret and the server's store; the lock released when the rest fails.
 */
async function openServer(
	path: string,
	context: Context,
): Promise<{ layout: AppLayout; cookieSecret: string; store: Store; lock: ProcessLock }> {
	// openDataDir 解析真实路径并拒绝主目录、根目录和他人目录。
	const dataDir = await openDataDir(path);
	// AbortSignal.timeout 在 1 秒后 abort；withAbortSignal 与调用方 context 合并。
	const waited = AbortSignal.timeout(SERVER_LOCK_MS);
	// processLock 的键包含真实 dataDir；超时错误被替换成明确的单实例提示。
	const lock = await processLock(`chord-app:${dataDir}`, withAbortSignal(waited, context)).catch((error: unknown) => {
		// 只有等待锁超时才替换消息；其他错误保持原样。
		throw waited.aborted ? new Error(`startServer: another server runs on ${dataDir}`) : error;
	});
	// 拿到锁后建立私有布局；失败要释放锁。
	try {
		// createLayout 创建 server/workers/plugins/logs 并设 0700。
		const layout = await createLayout(dataDir);
		// cookie 签名密钥首次创建后复用；文件 0600。
		const cookieSecret = await secretFile(layout.cookieSecret);
		// 服务器 store 打开前先创建并收紧为 0600。
		await privateStore(layout.serverStore);
		// 打开 SQLite store；失败会进入 catch 释放锁。
		const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(layout.serverStore)), context);
		// 返回四个资源；调用方负责后续关闭。
		return { layout, cookieSecret, store, lock };
	} catch (error) {
		// 初始化失败时释放进程锁，避免下一次启动被卡住。
		await lock.release();
		// 把原始错误抛给 startServer。
		throw error;
	}
}

// 计算一个 kind 的 host 模块清单：每个版本的核心模块和 kind 模块，再加 kind.packages 的键。
/** The host packages of kind `name`: the API's shared and per-kind module of every version, and its packages. */
// 返回值是模块说明符字符串数组，供插件构建器解析依赖。
function hostPackagesOf(api: AppApi, name: string, kind: AppKind): string[] {
	// flatMap 把每个版本展开成两项；版本顺序保持 API 给定的新到旧。
	const modules = api.versions.flatMap((version) => [`${api.name}/${version}`, `${api.name}/${version}/${name}`]);
	// 加上额外共享包；没有 packages 时为空对象。
	return [...modules, ...Object.keys(kind.packages ?? {})];
}

// 组合本进程的模块表：API 模块加某个 kind 的包；没有 kind 时只返回 API 模块。
/** This process's modules for a kind: the API's and the kind's packages. */
// kind 参数可为 undefined，因为服务器可能没有对应 kind 的额外包；返回新对象，不修改 api.modules。
function modulesOf(api: AppApi, kind: AppKind | undefined): HostPackages {
	return { ...api.modules, ...kind?.packages };
}

// 为一个 worker kind 创建 workers 组件：把应用的 start/autorize/principal 与 kit 数据包装起来。
// 返回 Workers<HostKind>；创建本身不启动进程，第一次持有地址时才启动。
/** The workers component of one worker kind: started with the kit's part of the start data beside the app's. */
function workersOf<P extends Principal>(
	host: Host<P>,
	kind: AppWorkerKind<P>,
	options: AppOptions<P>,
	dataDir: string,
	plugins: Plugins,
	context: Context,
): Workers<HostKind> {
	// facet 缺省 worker；决定 worker 加载哪类插件。
	const facet = kind.facet ?? "worker";
	// 服务器身份先规范化为 JSON 文本，避免对象键顺序影响比较。
	const serverKey = canonicalJson(options.principal.server as unknown as JsonValue, context);
	// isServer 用同一规范化比较 principal；服务器始终能访问 worker 的 kit 对象。
	const isServer = (principal: P): boolean => canonicalJson(principal as unknown as JsonValue, context) === serverKey;
	// createWorkers 接收服务器 host、host kind、组件选项和上下文。
	return createWorkers(
		host,
		// kind.kind 是 KindShape，断言为 HostKind；地址参数由应用路由负责。
		// A host kind of the app: any params; its addresses come back from its route as the kit hands them on.
		kind.kind as HostKind,
		// facet 是 worker 加载的插件种类。
		{
			// execArgv 可选；undefined 时不传，让 worker 组件用默认值。
			kind: facet,
			entry: kind.entry,
			// env 同理；展开只在有值时加入，避免覆盖默认环境。
			...(kind.execArgv === undefined ? {} : { execArgv: kind.execArgv }),
			...(kind.env === undefined ? {} : { env: kind.env }),
			// authorize 先放行服务器，再调用应用的判断；这样导出接口不会因应用策略被挡住。
			// The server reaches its workers' kit objects (`HostData`) whatever the app admits.
			authorize: (principal, address) => isServer(principal) || kind.authorize(principal, address),
			// principal 是函数：按地址生成 worker 身份，写入链路。
			principal: options.principal.worker,
			// start 返回 {kit, app}；worker 的 startWorker 从这里解构。
			start: async (address, ctx) => {
				// kit.dir 由 workerDirectory 按真实数据目录和地址计算。
				const kit: KitStart = {
					dir: workerDirectory(dataDir, address),
					facet,
					// Principals are JSON (they cross links).
					// facet 与身份一起发送；身份必须先转 JsonValue 才能过 wire。
					principal: options.principal.worker(address) as unknown as JsonValue,
					// server 身份也发送，worker 用它连接父链路。
					server: options.principal.server as unknown as JsonValue,
					// files 上限复制一份，避免 worker 侧修改影响服务器配置对象。
					files: { ...options.files },
					// 上传上限只在配置了 limits.uploads 时加入。
					...(options.limits?.uploads === undefined ? {} : { uploads: options.limits.uploads }),
				};
				// app 是应用自己的 start 数据；await 支持异步生成。
				// 返回启动数据；worker 进程收到后建立主机。
				return { kit, app: await kind.start(address, ctx) };
			},
			// lock 为每个地址提供进程锁键；导出/导入和 worker 运行共用它。
			lock: (address) => workerLock(options.name, dataDir, address),
			// idleMs 可选，直接传给 workers 组件。
			...(kind.idleMs === undefined ? {} : { idleMs: kind.idleMs }),
			// plugins 组件共享，worker 加载时使用同一套解析/安装规则。
			plugins,
			// worker 错误包装成 AppError 的 workers 分支。
			onError: (error) => options.onError({ kind: "workers", error }),
		},
		context,
	);
}

// 构造 worker 的进程锁键：应用名、真实数据目录和地址 key；同一键保证互斥。
/** The process lock of the worker at `address`: its worker holds it while it runs, an export or import meanwhile. */
// 返回字符串而不是获取锁；实际加锁在 #workerLock 或 worker 启动时。
function workerLock(name: string, dataDir: string, address: Address): string {
	return `${name}:${dataDir}:${address.key}`;
}

// 导出/导入等待 worker 锁最多 2 秒；超时说明 worker 正在运行或正在启动。
/** How long an export or import waits for a worker's lock: past it a worker holds it (it runs or starts). */
const ADDRESS_LOCK_MS = 2000;

// 把监听地址转成 owner 链接中的 host：通配地址映射到回环，IPv6 加方括号。
/** The host of the owner link for the address listened on: loopback for a wildcard, an IPv6 address in brackets. */
function linkHost(host: string): string {
	// 0.0.0.0 和空字符串都表示本机通配；返回 127.0.0.1。
	if (host === "0.0.0.0" || host === "") return "127.0.0.1";
	// IPv6 通配 :: 映射到 [::1]；浏览器需要方括号。
	if (host === "::") return "[::1]";
	// 其他含冒号的地址按 IPv6 处理；普通主机名或 IPv4 原样返回。
	return host.includes(":") ? `[${host}]` : host;
}

// RunningApp 实现 App<P>：保存组件引用并负责启动完成标记、插件发布、数据导入导出和有序关闭。
class RunningApp<P extends Principal> implements App<P> {
	// host/http/workers/plugins/dataDir/ownerTokenFile 是公开只读引用。
	readonly host: Host<P>;
	readonly http: HttpComponent<P>;
	readonly workers: ReadonlyMap<string, Workers<HostKind>>;
	readonly plugins: AppPlugins;
	readonly dataDir: string;
	readonly ownerTokenFile: string;
	// #component 是原始 Plugins；#surfaces 在启动前填充；#store/#lock 用于关闭。
	readonly #component: Plugins;
	/** The client surfaces, filled before the server's load. */
	readonly #surfaces: readonly Surface<P>[];
	readonly #store: Store;
	readonly #lock: ProcessLock;
	// #options 保留启动选项，导入导出和 manifest 需要 name/api/limits。
	readonly #options: AppOptions<P>;
	// #link 在 started 前为空字符串；#closing 缓存关闭 Promise，保证幂等。
	#link = "";
	#closing: Promise<void> | undefined;

	// 构造函数只保存引用和派生控制面，不做 I/O；plugins.install 绑定用户插件根。
	constructor(
		host: Host<P>,
		http: HttpComponent<P>,
		workers: ReadonlyMap<string, Workers<HostKind>>,
		plugins: Plugins,
		surfaces: readonly Surface<P>[],
		server: { readonly store: Store; readonly lock: ProcessLock },
		layout: { readonly dataDir: string; readonly plugins: string; readonly ownerToken: string },
		options: AppOptions<P>,
	) {
		// 逐个保存组件；字段声明为 readonly，但 #closing 和 #link 仍可变。
		this.host = host;
		this.http = http;
		this.workers = workers;
		this.#component = plugins;
		this.#surfaces = surfaces;
		this.#store = server.store;
		// 锁和 store 来自 openServer，关闭时最后释放。
		this.#lock = server.lock;
		this.#options = options;
		// dataDir 与 ownerTokenFile 来自布局，避免调用方重新拼接。
		this.dataDir = layout.dataDir;
		this.ownerTokenFile = layout.ownerToken;
		// AppPlugins 的 install 固定安装到 layout.plugins（用户根），不会写内置根。
		this.plugins = {
			state: plugins.state,
			install: (source, context) => plugins.installPlugin(source, layout.plugins, context),
			component: plugins,
		};
	}

	// 启动完成：保存 owner 链接和实际监听地址；token 来自 link.renew()。
	/** The start finished: the owner link's token and the address it names (the one listened on). */
	started(token: string, listening: ListenAddress): void {
		// URL 结构固定：http://<host>:<port>/_chord/owner#<token>；fragment 不会发送给服务器。
		this.#link = `http://${linkHost(listening.host)}:${listening.port}${OWNER_PATH}#${token}`;
	}

	// 返回当前 owner 链接；started 之前调用会得到空字符串。
	ownerLink(): string {
		return this.#link;
	}

	// web getter 从 surfaces 中查找 web；没有启用时返回 undefined。
	get web(): { readonly base: string } | undefined {
		return this.#surfaces.find(({ name }) => name === "web");
	}

	// tui getter 同理；类型只暴露 base 哈希。
	get tui(): { readonly base: string } | undefined {
		return this.#surfaces.find(({ name }) => name === "tui");
	}

	// 应用插件变更：只构建 dirty 集合，然后按 server、每个 worker kind、每个 surface 的顺序发布。
	async applyChanges(context: Context): Promise<RolloutResult> {
		// plugins.state.value.dirty 是本次需要构建的插件标记。
		const plugins = this.#component;
		// build 返回构建结果；失败不会开始 rollout。
		const built = await plugins.build(plugins.state.value.dirty, context);
		// 步骤数组顺序即发布顺序：服务器先，workers 次之，客户端最后。
		const steps = [
			plugins.step("server", this.host),
			// workers 表的迭代顺序是创建顺序；每个组件提供自己的 step。
			...[...this.workers].map(([name, each]) => each.step(name)),
			// surface.step 负责 web/tui 的发布。
			...this.#surfaces.map((surface) => surface.step(surface.name)),
		];
		// rollout 执行步骤并返回结果；任何一步失败由组件报告。
		return plugins.rollout(steps, built, context);
	}

	// 导出地址数据：运行中的 worker 自己打包；否则服务器持 worker 锁打包目录。
	// path 会 resolve 成绝对路径；manifest 由应用名/API 版本/地址生成。失败时锁一定释放。
	async exportData(address: Address, path: string, context: Context): Promise<void> {
		// 先确认地址的 kind 有对应 workers 组件；没有则抛配置错误。
		const workers = this.#workersOf(address);
		// 生成自描述 manifest，供导入端 accept 检查。
		const manifest = this.#manifest(address);
		// 目标路径规范化为绝对路径，供 worker 进程和服务器共同使用。
		const target = resolve(path);
		// Running: the worker packs its own store. Else the lock, unless a worker starts first: then ask it.
		// 最多重试 5 次：worker 状态可能在检查和加锁之间改变。
		for (let attempt = 1; ; attempt++) {
			// running 状态直接从 worker 取 HostData；这是不停机导出的路径。
			if (workers.state.value[address.key]?.status === "running") {
				// HostData 的参数是地址 JSON；host.get 返回远程对象句柄。
				const data = await this.host.get(HostData, { address: addressParam(address) }, context);
				// try/finally 保证释放远程句柄，即使 exportTo 失败。
				try {
					// exportTo 在 worker 进程内打包自己的 open store；manifest 以 JSON 文本传输。
					await data.exportTo({ path: target, manifest: JSON.stringify(manifest) }, context);
				} finally {
					data.release();
				}
				// 运行中的路径完成后直接返回。
				return;
			}
			// 没有运行中的 worker 时尝试获取地址锁；拿不到说明 worker 正在启动。
			const lock = await this.#workerLock(address, context);
			// 拿到锁：期间不会启动新 worker，可以安全读取目录。
			if (lock !== undefined) {
				try {
					// 打包 worker 目录的 store 和 files；这是不经过 worker 进程的路径。
					await packData(workerDirectory(this.dataDir, address), manifest, target, context);
				} finally {
					// 无论打包成败都释放锁。
					await lock.release();
				}
				// 持锁打包成功，返回。
				return;
			}
			// 连续 5 次都被启动过程抢走锁，放弃并提示重试。
			if (attempt === 5) throw new Error(`exportData: the worker at ${address.key} keeps starting; try again`);
		}
	}

	// 导入地址数据：先确认 kind 存在，再持 worker 锁解包到该地址目录。
	// worker 正在运行说明目录已有数据，导入会拒绝覆盖；失败时释放锁。
	async importData(archive: string, address: Address, context: Context): Promise<void> {
		// 确认 kind 有 workers 组件；这里不使用返回值，只做存在性检查。
		this.#workersOf(address);
		// 读取应用名和导入限制。
		const { name, limits = {} } = this.#options;
		// accept 是归档信任边界：检查格式版本和应用名，不通过就抛错。
		const accept = (manifest: ArchiveManifest): void => {
			// A trust boundary: an archive from anywhere.
			// 格式版本必须完全一致；错误信息说明期望格式。
			if (manifest?.format !== ARCHIVE_FORMAT) throw new Error(`importData: not a format ${ARCHIVE_FORMAT} archive`);
			// 归档必须属于同一应用；防止把别的应用数据导入。
			if (manifest.app !== name) throw new Error(`importData: an archive of "${manifest.app}", not "${name}"`);
		};
		// 尝试获取地址锁；拿不到说明 worker 正在运行或启动。
		const lock = await this.#workerLock(address, context);
		// worker 持锁意味着地址已有数据；导入只允许空地址。
		// A worker holds it: it runs, so the address has data, and nothing is overwritten.
		// 明确拒绝覆盖，不尝试停止 worker。
		if (lock === undefined) throw new Error(`importData: ${address.key} has data (its worker runs)`);
		// try/finally 保证解包后释放锁。
		try {
			// 把可选限制组装成 ImportLimits；undefined 由 unpackData 填默认值。
			const bounds = { bytes: limits.importBytes, entries: limits.importEntries };
			// unpackData 在 workerDirectory 旁暂存并在成功后 rename；目标目录必须不存在。
			await unpackData(resolve(archive), workerDirectory(this.dataDir, address), accept, bounds, context);
		} finally {
			// 释放锁；下一次持有地址时 worker 会从新目录启动。
			await lock.release();
		}
	}

	// 获取地址的进程锁：成功返回锁，2 秒内被 worker 持有则返回 undefined，其他错误抛出。
	/** The process lock of the worker at `address` (the one its worker takes at start), or `undefined` while held. */
	async #workerLock(address: Address, context: Context): Promise<ProcessLock | undefined> {
		// AbortSignal.timeout 限制等待；与调用方 context 合并。
		const waited = AbortSignal.timeout(ADDRESS_LOCK_MS);
		try {
			// processLock 的键与 worker 启动时一致；这是互斥的基础。
			return await processLock(
				workerLock(this.#options.name, this.dataDir, address),
				withAbortSignal(waited, context),
			);
			// 超时说明 worker 正在运行/启动；非超时错误（权限等）继续抛。
		} catch (error) {
			// waited.aborted 检查超时；返回 undefined 让调用方走运行中路径。
			if (waited.aborted) return undefined;
			throw error;
		}
	}

	// 关闭应用：#closing 缓存第一次调用的 Promise，后续调用复用。
	close(context: Context): Promise<void> {
		// ??= 只在未关闭时创建；并发 close 共享同一过程。
		this.#closing ??= this.#close(context);
		return this.#closing;
	}

	// 按地址 kind 查 workers 组件；未知 kind 是应用配置错误，直接抛错。
	/** The workers of `address`'s kind. */
	#workersOf(address: Address): Workers<HostKind> {
		// workers 表按 host kind 名索引。
		const workers = this.workers.get(address.kind);
		if (workers === undefined) throw new Error(`app: no worker kind "${address.kind}"`);
		return workers;
	}

	// 生成地址归档的 manifest：格式版本、应用名、最新 API 版本和地址 kind/key。
	/** The manifest of `address`'s archive. */
	#manifest(address: Address): ArchiveManifest {
		// 解构启动选项；只读取必要字段。
		const { name, api } = this.#options;
		// 返回对象；api.versions[0] 缺失时用空字符串，保持 manifest 形状稳定。
		return {
			format: ARCHIVE_FORMAT,
			app: name,
			api: api.versions[0] ?? "",
			address: { kind: address.kind, key: address.key },
		};
	}

	// 关闭顺序：先 HTTP 排空请求，再 workers、host、store、插件 watcher，最后数据目录锁。
	/**
	 * The close, in order: HTTP first (it drains requests the host's close would seal), workers, host, store, the
	 * plugins' watcher, then the data directory's lock.
	 */
	async #close(context: Context): Promise<void> {
		// HTTP 必须先关闭：host 关闭会封住新请求，但已有请求需要 HTTP 组件先排空。
		await this.http.close(context);
		// 逐个关闭 workers，等待子进程退出。
		for (const workers of this.workers.values()) await workers.close(context);
		// 关闭服务器主机，释放对象和链路。
		await this.host.close(context);
		// 关闭 store，提交/释放数据库句柄。
		await this.#store.close(context);
		// 关闭插件组件的 watcher；同步方法，不等待。
		this.#component.close();
		// 最后释放进程锁，允许下一次 startServer 使用同一数据目录。
		await this.#lock.release();
	}
}
