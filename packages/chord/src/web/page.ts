/// <reference lib="dom" />
// `startPage` (slice 11 §2, decisions "Slice 11, P4" to "P6"): a page's client host, in the app's web entry (the base
// bundle). It takes the plugin scripts the page's combined file registered, loads them with the app's core facets and
// the kit's themes, keeps its link to the server (the connection loop), follows `WebScripts` to apply new plugin
// scripts in place, reloads the page when the server's base bundle changed, and hands the host to the app's render.
// 所属：web 浏览器侧启动入口；组合 startClient、脚本加载、主题跟随与 DOM 环境。
// 职责：读取 bootstrap、接管注册队列、建立 host、连接 /chord、加载插件、跟随主题、调用 render。
// 边界：不打包插件、不写服务端；缺 bootstrap 或初始加载失败会 reject；运行时错误交给 onError/console。
// 上游：应用 web 入口；下游：PageScripts/PageBootstrap、startClient、pageEnvironment、followThemes、WebScripts。
// 导出：PageOptions 配置；startPage 入口；serverBase 是内部函数。
// 组合：bootstrap → new PageScripts → core facets → startClient → followThemes → options.render。
// 示例：const client = await startPage({ connect: () => new WebSocket(url), modules, render: (host) => mount(host) });
// 阅读顺序：PageOptions → startPage → serverBase。

import { BACKGROUND_CONTEXT } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import type { PluginFacet } from "../host/index.ts";
import { type WebSocketLike, webSocketLink } from "../link/index.ts";
import {
	type Client,
	type ClientError,
	type ClientModules,
	type ConnectionState,
	startClient,
	themesFacet,
	WebScripts,
} from "../surfaces/index.ts";
import { pageEnvironment } from "./environment.ts";
import { type PageBootstrap, PageScripts, syncStylesheets } from "./scripts.ts";
import { followThemes } from "./themes.ts";

/** What `startPage` takes. */
// P extends Principal 限定应用的身份类型；readonly/可选属性只约束开发时写法，不校验服务器数据。
export type PageOptions<P extends Principal> = {
	/** Opens the page's socket to the server's links endpoint (`/chord`). */
	// connect：每次建链由连接循环调用；返回 WebSocketLike，startPage 监听 open/message 并包装成 LinkEnd。
	readonly connect: () => WebSocketLike;
	/** The modules the web plugins import, by specifier: the app's API modules for the web kind, React, ... */
	// modules：插件 import 的模块表，按说明符映射到应用 API/组件；插件注册函数的 require 从这里取。
	readonly modules: ClientModules;
	/** The app's own web facets. */
	// core：应用自带 web facets，和主题 facet 一起在插件脚本之前加载；可选，缺省只装主题。
	readonly core?: readonly PluginFacet<P>[];
	/** Asked before each reconnect; `false` stops reconnecting (a guest's ended share). */
	// canRetry：每次重连前询问应用；返回 false 会停止重连（例如访客的分享已结束）。
	readonly canRetry?: () => Promise<boolean>;
	// onConnection：连接状态变化回调，用于界面提示；不改变循环行为。
	readonly onConnection?: (state: ConnectionState) => void;
	/** Renders the app with its host, once the plugins are loaded. */
	// render：插件加载且主题跟随开始后调用一次，接收 host；同步调用，其抛错使 startPage 拒绝。
	readonly render: (host: Client<P>["host"]) => void;
	/** Plugins left out or kept old, a failed update, the host's errors: the console by default. */
	// onError：插件被排除/保留旧版、更新失败等客户端错误；默认 console.error，因为浏览器没有启动器 stderr。
	readonly onError?: (error: ClientError) => void;
};

/** Where the web surface's files live (the server's `WEB_PREFIX`). */
const PREFIX = "/_chord/web/";

/** Starts the page; resolves with its client once rendered. */
/**
 * 从页面 bootstrap 启动客户端，装载插件、建立连接、跟随主题，再把 host 交给 render。
 * options 给出模块和浏览器连接等能力；返回已渲染的 Client，可通过 stop 结束其连接、更新监听和 host。
 * 会写全局脚本注册入口、样式和 DOM；缺 bootstrap 会抛错，启动/主题等待失败会拒绝 Promise。
 * 例如应用传 render: host => mount(host)，这里在插件加载和主题跟随准备好后调用 mount 一次。
 */
export async function startPage<P extends Principal>(options: PageOptions<P>): Promise<Client<P>> {
	// Written by the page's inline bootstrap (the server's `PageAssets.bootstrap`).
	const bootstrap = (globalThis as { readonly chordPage?: PageBootstrap }).chordPage;
	// 这是页面启动边界的存在性检查；类型断言不会在运行时验证 bootstrap 的所有字段。
	if (bootstrap === undefined) throw new Error("startPage: the page has no Chord bootstrap (PageAssets.bootstrap)");
	// 接管已排队的插件注册，并准备后续按 URL 加载脚本。
	const scripts = new PageScripts(bootstrap);
	// 数组展开 ... 合并主题提供者与应用自带 facet；?? 在没有 core 时使用空数组。
	const core: PluginFacet<P>[] = [{ name: "chord.themes", facet: themesFacet<P>() }, ...(options.core ?? [])];
	// 等待共享客户端启动；对象里的回调把通用逻辑适配到浏览器。
	const client = await startClient<P>({
		// 脚本对象指向服务端的 web 插件集；base 用于识别基础代码是否已过期。
		scripts: WebScripts,
		base: scripts.base,
		initial: scripts.initial,
		modules: options.modules,
		core,
		// 每次连接尝试创建一个 socket；普通消息和心跳消息都更新循环的最近收帧时间。
		open: (events) => {
			const socket = options.connect();
			socket.addEventListener("open", () => events.opened());
			socket.addEventListener("message", () => events.received());
			// webSocketLink 只适配字节与关闭事件，协议处理仍由 host 执行。
			return webSocketLink(socket);
		},
		// 变化的插件按单个 script 元素加载；基础 bundle 的哈希另经 HTTP 查询。
		fetchScript: (entry) => scripts.fetch(entry),
		serverBase,
		// 基础代码变更必须重新加载整页，普通插件变更由 startClient 原地 reload。
		outdated: () => location.reload(),
		// 条件展开只在用户实际提供回调时加入属性，保持 optional 的含义。
		...(options.canRetry === undefined ? {} : { canRetry: options.canRetry }),
		...(options.onConnection === undefined ? {} : { onConnection: options.onConnection }),
		// 每次应用插件集之后同步 CSS；页面环境提供时钟与唤醒事件。
		applied: (set) => syncStylesheets(set, PREFIX),
		environment: pageEnvironment(),
		// 应用未提供错误处理时才使用控制台；?? 不会替换一个已提供的函数。
		onError: options.onError ?? ((error) => console.error("chord page:", error)),
	});
	// 开始监听主题；这里没有保存返回的清理函数，页面整体生命周期负责承载它。
	await followThemes(client.host, BACKGROUND_CONTEXT);
	// 调用应用的渲染入口，然后把同一 client 返回调用方。
	options.render(client.host);
	return client;
}

/** The server's current base bundle hash (`undefined` when it cannot be asked: offline, restarting). */
/** 查询服务端当前 base 哈希；无参数，HTTP 失败或请求/JSON 解析异常都返回 undefined，供重连继续尝试。
 * 例如服务端重启时 fetch 拒绝不会在这里终止循环；as string 是开发时断言，并不校验响应 JSON 类型。
 */
async function serverBase(): Promise<string | undefined> {
	// 网络和解析都可能抛错，统一由下方 catch 转成“暂时未知”。
	try {
		// 不读 HTTP 缓存，并仅携带同源凭据，以获得当前服务端版本。
		const response = await fetch(`${PREFIX}base`, { cache: "no-store", credentials: "same-origin" });
		// 只有成功状态才读取 JSON；条件运算符只执行选中的一边。
		return response.ok ? ((await response.json()) as string) : undefined;
	} catch {
		// 未知哈希不同于确认过期；调用方不会据此立即刷新页面。
		return undefined;
	}
}
