// A client host with its plugins (slice 11 §2, §4, decisions "Slice 11, P4" to "P6"): what a page and a terminal's
// sandbox both run. A client host (no address) loads the plugin scripts it started with beside the app's core facets,
// keeps its link to the server with the connection loop, and holds the kind's scripts object: a new set fetches the
// changed scripts and reloads the host in place (a failed plugin keeps its old facet); a new base bundle means this
// client's code is outdated, which the app answers by starting over (a page reloads). The surface specifics (how a
// socket opens, how a script is fetched, what is outdated) are given.

//
// 文件导读
// 所属：packages/chord 的 surfaces 层，负责“客户端宿主”的启动与插件更新生命周期；页面和终端沙箱共用同一实现。
// 职责边界：创建一个没有地址的 client host，加载应用核心 facets 与初始插件脚本，保持到服务器的父连接，并持有该
// 客户端类型的 scripts 远程对象；集合变化时增量抓取脚本并原地 reload 宿主。它不实现 socket、脚本下载或页面重载，
// 这些平台差异由调用方通过 open/fetchScript/serverBase/outdated 注入。
// 上游入口：startClient(options)。下游依赖：createHost/host.connect/host.hold、keepConnected（connection.ts）、
// LoadedFacets（loaded.ts）、evaluateRegistered（registered.ts）与 ScriptsContract/ScriptSet 类型。
// 结果与错误流：成功返回 { host, stop }；插件加载失败、宿主内部错误、更新失败经 onError 的 ClientError 报告。
// 若服务器 base 与本地 base 不同，调用 outdated（页面重载、终端重启），连接循环随即停止。startClient 在正常
// 插件错误下不会拒绝（错误进入报告）；只有 host.load 本身 reject，或宿主接口被误用（例如已有父链接）时才抛出。
// 能力清单：
// - ClientError：三类错误联合（host / plugins / update_failed）。
// - ClientOptions<P>：启动参数，包含平台注入点（open、fetchScript、serverBase、outdated、canRetry、environment）。
// - Client<P>：运行中的客户端，暴露 host 与异步 stop。
// - startClient：完成首次加载、连接循环、脚本跟随并返回 Client。
// - connect（私有）：把 keepConnected 与 base/canRetry 检查组合成父链接循环。
// - SharedClose（私有）：Link 包装器，允许 host 与连接循环各自注册关闭监听。
// - entryOf（私有）：把 RegisteredScript 转为 LoadedFacets 的 SetEntry（延迟求值）。
// - Updates（私有）：持有 scripts 对象，按顺序应用 ScriptSet，增量 fetch 并 reload 宿主。
// 组合与典型调用顺序：startClient → createHost → LoadedFacets.load(初始脚本) → connect(keepConnected) →
// Updates.follow（hold scripts → watch → #apply）→ stop 时依次 loop.stop、updates.stop、host.close。
// 示例：`const client = await startClient({
//   scripts: WebScripts, base: "b1", initial: registeredScripts, modules: { react },
//   core: [themesFacet()], open: (events) => webSocketLink(url, events),
//   fetchScript: fetchRegistered, serverBase: () => fetchBase(), outdated: () => location.reload(),
//   environment: browserLoopEnvironment(), onError: console.error });`
// 阅读顺序：ClientError/ClientOptions/Client → startClient → connect/SharedClose → entryOf → Updates.follow/#apply。

import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import { createHost, type Host, type HostError, type PluginFacet, type PluginFailure } from "../host/index.ts";
import type { Link } from "../link/index.ts";
import { type ConnectionState, keepConnected, type LoopEnvironment, type SocketEvents } from "./connection.ts";
import { LoadedFacets, type SetEntry } from "./loaded.ts";
import { type ClientModules, evaluateRegistered, type RegisteredScript } from "./registered.ts";
import type { ScriptEntry, ScriptSet, ScriptsContract } from "./scripts.ts";

/** What a client reports: its host's errors, plugins left out at a load or kept old at a reload, a failed update. */
// 应用统一从 onError 收到这个联合，按 kind 区分：
// - host：宿主内部错误（HostError），通常是对象生命周期或协议问题；
// - plugins：一次加载/重载中失败或被保留旧代码的插件列表（PluginFailure）；
// - update_failed：应用脚本集合时 fetch 或 reload 抛出的任意错误（unknown，因为可能来自平台代码）。
// 判别联合（discriminated union）让 switch(error.kind) 在编译期收窄字段类型。
export type ClientError =
	| { readonly kind: "host"; readonly error: HostError }
	| { readonly kind: "plugins"; readonly failed: readonly PluginFailure[] }
	| { readonly kind: "update_failed"; readonly error: unknown };

/** What `startClient` takes. */
// 启动参数。P 是应用的 principal 类型：core facets 和插件求值出的 facet 都必须服务同一 principal 类型。
export type ClientOptions<P extends Principal> = {
	/** The kind's scripts object (`WebScripts`, `TuiScripts`). */
	// 客户端类型的脚本远程对象契约；Updates 会 hold 它并 watch 其 state.set。
	readonly scripts: ScriptsContract;
	/** The hash of the base bundle this client runs. */
	// 本地正在运行的基础 bundle 哈希；与服务器发布的 base 不同即表示协议可能已不兼容。
	readonly base: string;
	/** The plugin scripts it started with (the combined file's), in any order. */
	// 启动时已随合并文件加载的插件脚本；顺序无关，内部按 plugin 名建索引。
	readonly initial: readonly RegisteredScript[];
	/** The modules its plugin scripts import, by specifier. */
	// 插件脚本可 require 的宿主模块表；由平台提供（例如 React、应用 API）。
	readonly modules: ClientModules;
	/** The app's own facets, loaded with the plugins. */
	// 应用自己的 facets，与插件一起交给 host.load；插件失败不会影响它们。
	readonly core: readonly PluginFacet<P>[];
	/** Opens one socket to the server and its link; the socket reports to `events`. */
	// 平台注入：建立一条到服务器的链路，并把 open/message 事件报告给循环。
	readonly open: (events: SocketEvents) => Link;
	/** Fetches a plugin's script of a set (at its `url`), which registers itself. */
	// 平台注入：下载并执行一个注册脚本，返回 { plugin, digest, run }；对应页面 <script src> 或终端求值。
	readonly fetchScript: (entry: ScriptEntry) => Promise<RegisteredScript>;
	/**
	 * The server's current base bundle hash, asked before each reconnect (`undefined`: unknown, try again): another one
	 * means this client is outdated (a new protocol comes with a new base bundle).
	 */
	// 每次重连前询问服务器当前 base；undefined 表示暂时未知，允许继续重试。
	readonly serverBase: () => Promise<string | undefined>;
	/** This client's code is outdated: the app starts it over (a page reloads); the loop has stopped. */
	// base 不匹配时调用；页面通常 location.reload()，终端则由应用重启客户端。
	readonly outdated: () => void;
	/** Asked before each reconnect; `false` stops the loop (a guest's ended share). */
	// 可选的重连闸门；返回 false 表示永久停止（例如访客的分享已结束）。
	readonly canRetry?: () => Promise<boolean>;
	// 连接状态变化回调，用于界面显示 connecting/connected/waiting。
	readonly onConnection?: (state: ConnectionState) => void;
	/** A new set was applied (its scripts loaded or kept old): the page swaps the plugins' stylesheets. */
	// 一次集合适用完成（包括没有变化但确认过的集合）；页面据此替换插件样式表。
	readonly applied?: (set: ScriptSet) => void;
	// 注入的时钟、定时器、在线状态与唤醒源；浏览器与终端沙箱各有一套实现。
	readonly environment: LoopEnvironment;
	// 所有可报告错误都从这里出去，不会被静默吞掉。
	readonly onError: (error: ClientError) => void;
};

/** A running client: its host, once its plugins are loaded, and its stop. */
// 运行中的客户端句柄。host 已加载核心 facets 与成功的插件；stop 是异步的，因为要等宿主排空对象。
// stop 的 context 由调用方提供，宿主关闭的取消与遥测走这个上下文。
export type Client<P extends Principal> = { readonly host: Host<P>; stop(context: Context): Promise<void> };

/** Starts a client: its host loaded with the initial scripts, its link kept, its plugins kept current. */
// 启动客户端宿主。输入 ClientOptions<P>；输出 Client<P>。副作用：创建宿主、运行所有 core/插件 setup、
// 建立父连接循环、hold scripts 对象并 watch。错误：插件失败进入 report 并通过 onError 报告；宿主内部失败由
// createHost 的 onError 转成 ClientError；只有 host.load 本身 reject（或宿主接口被误用）时这个 Promise 才会拒绝。
// 流程：先用后台上下文 → 建宿主 → 把初始脚本包装成 SetEntry → 一次性加载核心和插件 → 启动连接 → 启动更新跟随。
// 示例：见文件头的 startClient 调用；返回后可以 `client.host.get(...)`，退出时 `await client.stop(ctx)`。
export async function startClient<P extends Principal>(options: ClientOptions<P>): Promise<Client<P>> {
	// 后台上下文：客户端生命周期跨越调用方请求，因此不继承任何请求的取消信号。
	const context = BACKGROUND_CONTEXT;
	// 宿主自己的 onError 统一加 kind:"host"，与插件/更新错误区分。
	const host = createHost<P>({ onError: (error) => options.onError({ kind: "host", error }) });
	// 初始脚本延迟求值：这里只建立条目，真正的 evaluateRegistered 在 LoadedFacets.load 中按顺序调用。
	const entries = options.initial.map((script) => entryOf(script, options.modules));
	// 核心 facets 与插件一起发布；返回的 loaded 保存成功加载的插件和核心列表，供后续 reload 复用。
	const { loaded, report } = await LoadedFacets.load(host, options.core, entries, context);
	// 首次加载中失败（构建失败或宿主拒绝）的插件一次报告；宿主仍可用。
	if (report.failed.length > 0) options.onError({ kind: "plugins", failed: report.failed });
	// 连接循环立即开始；它自己负责重连和状态回调。
	const loop = connect(host, options);
	// Updates 从 options.initial 建立“已知脚本”索引；它包括加载失败的脚本，而 loaded 只含宿主接受的插件。
	const updates = new Updates(host, loaded, options);
	// follow 只建立 hold/watch，不等待第一批 fetch/reload 完成；首个 set 会异步到达回调。
	await updates.follow(context);
	return {
		host,
		// 停止顺序：先断开服务器（循环停止，不再产生新状态），再停止脚本跟随，最后关闭宿主（排空对象）。
		stop: async (ctx) => {
			loop.stop();
			await updates.stop();
			await host.close(ctx);
		},
	};
}

/** Keeps `host`'s parent link to the server, asking `serverBase` and `canRetry` before every reconnect. */
// 把宿主的父连接交给连接循环。输入 host 与启动参数；返回 { stop }，由 Client.stop 调用。
// 每次 open 都新建一条链路（旧的已关闭），并把它同时交给 host.connect（作为父链接）和 Loop。
// 重连前先比较服务器 base：不同说明客户端代码已过期，调用 outdated 并停止；相同才继续问 canRetry。
// 示例：连接断开后，keepConnected 先等待退避，再调用这里的 canRetry；base 变化时不会建立新 socket。
function connect<P extends Principal>(host: Host<P>, options: ClientOptions<P>): { stop(): void } {
	return keepConnected({
		open: (events) => {
			// The loop and the host both follow the link's close; a link has one close listener.
			// 底层 Link 只允许一个 onClose；SharedClose 让连接循环和宿主各自订阅，避免后注册者覆盖先注册者。
			const link = new SharedClose(options.open(events));
			// A client's parent is the server; the principal only labels the link (a client serves no remote types).
			// 客户端不对外服务远程类型，所以这里的 principal 只是链路的标签；类型断言表达这个已决定的不变量。
			host.connect(link, { principal: { kind: "server" } as unknown as P }, BACKGROUND_CONTEXT);
			return link;
		},
		// 状态原样转发给应用，应用可据此显示“连接中/已连接/等待重试”。
		onState: (state) => options.onConnection?.(state),
		canRetry: async () => {
			// 先问服务器 base；undefined 表示查询失败或暂时未知，此时不判定过期，允许重试。
			const base = await options.serverBase();
			if (base !== undefined && base !== options.base) {
				// base 不同通常意味着协议已升级：继续重连没有意义，由应用重启整个客户端。
				options.outdated();
				return false;
			}
			// 没有提供 canRetry 时默认允许；user 的 false 会永久停止循环。
			return (await options.canRetry?.()) ?? true;
		},
		environment: options.environment,
	});
}

/** A link whose close several follow (the host and the connection loop): each listener added runs once it closes. */
// Link 适配器：包装底层链路，把唯一的关闭通知分发给多个监听者。
// 语义与 Link 一致：关闭前注册的监听器在关闭时各执行一次；关闭后注册的立即执行一次；监听器不会被重复调用。
// 它不复制消息、不缓冲发送，只是透明转发 send/onMessage/close。
class SharedClose implements Link {
	// 被包装的真实链路。
	readonly #link: Link;
	// 尚未触发的关闭监听器；触发时用 splice(0) 一次取走，保证只执行一次。
	readonly #listeners: (() => void)[] = [];
	// 底层是否已经关闭；关闭后 onClose 走同步立即执行分支。
	#closed = false;

	constructor(link: Link) {
		this.#link = link;
		// 只向底层注册一次关闭回调；#closed 先置位，再清空并调用所有等待者。
		link.onClose(() => {
			this.#closed = true;
			for (const listener of this.#listeners.splice(0)) listener();
		});
	}

	// 发送字节：完全透传，返回类型 void；底层错误由底层决定是否抛出。
	send(message: Uint8Array): void {
		this.#link.send(message);
	}

	// 接收监听：底层 Link 同样只接受一个监听器；这里不复制消息，真正的消费者是 host.connect 建立的通道。
	onMessage(listener: (message: Uint8Array) => void): void {
		this.#link.onMessage(listener);
	}

	// 主动关闭：通知底层，随后由底层触发上面注册的回调，再分发给宿主和循环。
	close(): void {
		this.#link.close();
	}

	// 注册关闭通知；若底层已经关闭，同步调用一次，不保存闭包。
	onClose(listener: () => void): void {
		if (this.#closed) listener();
		else this.#listeners.push(listener);
	}
}

/** `script` as one plugin of a complete set: its digest, and its evaluation with `modules` when it is new. */
// 把已注册脚本转成 LoadedFacets 的条目。name 用插件名（不是文件名），digest 用于跳过未变化插件。
// prepare 是延迟执行的：只有首次加载或 digest 变化时，LoadedFacets 才会调用它并运行脚本。
// 脚本抛错被捕获为 kind:"failed"，交给宿主报告；这样单个插件不会中断整个客户端启动。
// 示例：prepare() 成功返回 { kind:"facet", facet, digest }，失败返回 { kind:"failed", error }。
function entryOf(script: RegisteredScript, modules: ClientModules): SetEntry {
	return {
		name: script.plugin,
		digest: script.digest,
		prepare: () => {
			try {
				// 用客户端模块表运行脚本，返回其默认导出的 facet；digest 随结果一起保存，供下次比较。
				return { kind: "facet", facet: evaluateRegistered(script, modules), digest: script.digest };
			} catch (error) {
				// 求值失败（require 了未知模块、脚本抛错、默认导出不是 facet）不向调用方冒泡。
				return { kind: "failed", error };
			}
		},
	};
}

/**
 * The client's plugin updates: it holds the scripts object and applies each new set in order (fetching the changed
 * scripts, reloading the host with the complete set); a new base calls `outdated` instead.
 */
// 客户端插件更新器。它把“服务器发布的脚本集合”转换成宿主中的实际 facet：
// 1. hold 该客户端类型的 scripts 远程对象（WebScripts 或 TuiScripts）；
// 2. watch 它的 state.set，每个 value 都按到达顺序处理；
// 3. 对比 digest，只下载变化的脚本，再以完整集合 reload 宿主；
// 4. base 不一致时不再更新，直接让应用重启客户端。
// 失败会以 update_failed 报告；单个插件求值失败仍由 LoadedFacets/report 处理。
class Updates<P extends Principal> {
	// 要 reload 的宿主。
	readonly #host: Host<P>;
	// 与启动时相同的加载器，保存插件 facet 与 digest，保证 reload 串行且复用未变化插件。
	readonly #loaded: LoadedFacets;
	// 平台注入点与回调。
	readonly #options: ClientOptions<P>;
	/** The scripts this client has, by plugin: its initial ones, then what each applied set fetched. */
	// 当前客户端已知的脚本，按插件名索引；初始值来自 options.initial，之后只在 reload 成功后整体替换。
	readonly #scripts = new Map<string, RegisteredScript>();
	// 控制 watch 生命周期的取消源；stop 时 abort 会结束 watch 并拒绝仍在等待的调用。
	readonly #abort = new AbortController();
	// hold 的释放函数；可能尚未建立（follow 是异步的），因此可选。
	#release: (() => void) | undefined;

	constructor(host: Host<P>, loaded: LoadedFacets, options: ClientOptions<P>) {
		this.#host = host;
		this.#loaded = loaded;
		this.#options = options;
		// 初始脚本已经由 startClient 加载；这里建立索引，首个集合到达时可直接比较 digest。
		for (const script of options.initial) this.#scripts.set(script.plugin, script);
	}

	/** Holds the scripts object and applies every set it shows, the first included (a reconnect's snapshot too). */
	// 开始跟随：hold 远程对象（空参数 {}），保存 release 以便 stop 释放。
	// watch 绑定外部 context 与内部 abort：任一取消都会结束监听。
	// start 注册异步回调；只有 kind:"value" 是完整集合，其余调用事件（如错误）被忽略。
	// 注意 follow 返回时首个集合可能尚未处理，fetch/reload 在 watch 的异步投递中继续。
	async follow(context: Context): Promise<void> {
		// hold 同步返回句柄；{ } 是该契约的空参数对象。
		const held = this.#host.hold(this.#options.scripts, {}, context);
		// 保存成箭头函数，避免 stop 需要知道 held 的具体类型。
		this.#release = () => held.release();
		// withAbortSignal 把内部 AbortSignal 与外部 context 的取消合并；watch 的初始值会尽快投递。
		const watch = await held.set.watch(withAbortSignal(this.#abort.signal, context));
		// call.value 的类型是 unknown，因为远程 state 在编译期是宽泛的；这里按契约断言为 ScriptSet。
		watch.start(async (call, ctx) => {
			if (call.kind === "value") await this.#apply(call.value as ScriptSet, ctx);
		});
	}

	/** Stops following: the watch ends, the hold is released. */
	// 停止跟随：先 abort（结束 watch、拒绝未决调用），再释放 hold；已开始的 #apply 仍按自己的上下文收尾。
	// 不关闭宿主；宿主由 Client.stop 在最后关闭。
	async stop(): Promise<void> {
		this.#abort.abort();
		this.#release?.();
	}

	/** Applies `set`: a new base calls `outdated`; else the changed scripts fetched and the host reloaded with all. */
	// 应用一个服务器集合。输入：契约 state 的 ScriptSet 与当前上下文；无返回值。
	// 流程：base 检查 → 无变化快速路径 → 顺序抓取变化脚本 → 转成条目 → reload 完整集合 → 更新本地索引 → 报告。
	// 错误：fetch/reload 抛出的任何错误都转成 update_failed；若 reload 在提交后以 aborted 拒绝，LoadedFacets 已采纳
	// 提交结果，但本方法不会执行后面的 #scripts 更新和 applied 回调，下一次集合到达时会重新比较。
	async #apply(set: ScriptSet, context: Context): Promise<void> {
		const options = this.#options;
		// base 是协议/构建标识；不同表示当前客户端代码无法安全继续，交给应用重启，而不是尝试局部更新。
		if (set.base !== options.base) {
			options.outdated();
			return;
		}
		// The first frame (and a reconnect's snapshot) usually shows what this client runs already: nothing to reload.
		// 快速路径：插件数量相同且每个 name 的 digest 都一致，说明集合没有变化。
		// 用长度先排除增删，再逐个比较；known.get(...)? 的可选链让缺失插件自然得到 undefined。
		const known = this.#scripts;
		if (
			set.plugins.length === known.size &&
			set.plugins.every((entry) => known.get(entry.name)?.digest === entry.digest)
		) {
			// 即使不 reload 也通知应用，让页面有机会同步样式表等外部资源。
			options.applied?.(set);
			return;
		}
		try {
			// 按集合顺序抓取；未变化的脚本直接复用已知对象，避免重复下载和执行。
			const scripts: RegisteredScript[] = [];
			for (const entry of set.plugins) {
				const known = this.#scripts.get(entry.name);
				scripts.push(known?.digest === entry.digest ? known : await options.fetchScript(entry));
			}
			// 全部脚本就绪后才建立条目；evaluateRegistered 仍延迟到 reload 需要新 facet 时调用。
			const entries = scripts.map((script) => entryOf(script, options.modules));
			// complete set：不在 set.plugins 中的旧插件会由 host.reload 移除。
			const report = await this.#loaded.reload(this.#host, entries, context);
			// reload 成功后才替换索引；先 clear 再 set，保持 Map 中条目顺序与集合一致。
			this.#scripts.clear();
			for (const script of scripts) this.#scripts.set(script.plugin, script);
			// 插件级失败（旧代码保留或新增插件被排除）单独报告；宿主仍运行。
			if (report.failed.length > 0) options.onError({ kind: "plugins", failed: report.failed });
			// 全部处理完成（包括保留旧 facet 的插件），通知应用替换样式表。
			options.applied?.(set);
		} catch (error) {
			// 网络、脚本执行或宿主 reload 的异常都在这里收口。索引只在 reload 成功后执行到下面那段时才整体替换；
			// 若错误发生在替换之前，它仍指向上一次成功的集合。
			options.onError({ kind: "update_failed", error });
		}
	}
}
