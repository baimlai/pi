// The terminal surface's server side (slice 11 §4, decisions "Slice 11, P3" and "P8"): the terminal kind's base bundle
// (one ES module the sandbox evaluates) built from the app's terminal entry at start, the kind's plugin scripts
// published as registered scripts and one combined file, `TuiScripts` showing the current set, all served to the
// launcher, which signs in with a token. Routes and objects are `Http` contributions of the surface's facet.
// 所属：node/surfaces 的终端表面（服务器侧）；组合基础包、插件发布器和 HTTP 路由。
// 职责：构建沙箱基础脚本、启动 PublishedScripts、声明 TuiScripts 与 /_chord/tui/* 路由。
// 边界：不启动沙箱、不执行插件代码、不监听端口；所有文件来自内存，路由由 Http 组件认证与分发。
// 上游：应用在 host.load 前调用 tuiSurface；下游：buildBase、PublishedScripts、scriptsFacet、Http。
// 导出清单：TuiSurfaceOptions 配置；TuiStart 是 launcher 的启动 JSON；TuiSurface 是 facet/step/base；TUI_PREFIX；tuiSurface 入口。
// 组合：tuiSurface → buildBase → PublishedScripts.start → facet(scriptsFacet + Http) → launcher 请求 start/script/combined。
// 示例：const surface = await tuiSurface(server, { plugins, entry: "./src/tui.ts" }, context); await server.load([surface.facet]);
// 阅读顺序：TuiSurfaceOptions → TuiStart/TuiSurface → TUI_PREFIX → tuiSurface → facet 路由 → 返回值。

import type { Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet, type Host } from "../../host/index.ts";
import { Http, type HttpRequest, type HttpResponse } from "../http/index.ts";
import type { Plugins, RolloutStep } from "../plugins/index.ts";
import { buildBase } from "./bundle.ts";
import { scriptsFacet } from "./current.ts";
import { PublishedScripts } from "./published.ts";
import { type ServedFile, served } from "./served.ts";

/** What `tuiSurface` takes. */
// 创建终端表面的选项；kind 可省略，entry 必须是调用 startTerminalRuntime 的应用入口。
export type TuiSurfaceOptions = {
	/** The terminal facet kind: `tui` by default. */
	// kind：插件管理器中的终端脚本种类，默认 "tui"；发布器用它取 scripts/current。
	readonly kind?: string;
	// plugins：已配置的插件管理器；tuiSurface 会调用其 scripts 构建/取得当前集合。
	readonly plugins: Plugins;
	/** The app's terminal start code (it calls `startTerminalRuntime`): the base bundle's entry. */
	// entry：应用终端入口的源文件路径，交给 esbuild 打成沙箱可执行的 CommonJS。
	readonly entry: string;
};

/** What a launcher downloads at its start (`GET /_chord/tui/start`): the base bundle and the combined plugin file. */
// launcher 启动所需：base 是过期比较用的摘要，script 是基础包 URL，combined 是当前插件合并文件 URL。
export type TuiStart = { readonly base: string; readonly script: string; readonly combined: string };

/** The terminal surface: its facet (for the server's core facets), its rollout step, its base bundle's hash. */
// 返回给应用的表面句柄：facet 要加载；step 用于后续发布；base 是启动时摘要。
export type TuiSurface<P extends Principal> = {
	// facet：声明脚本对象与 HTTP 贡献；加载前没有路由/对象，加载后由 host 管理生命周期。
	readonly facet: Facet<P>;
	// step：生成名为 name 的 rollout 步骤，发布当前插件集合；不等待 launcher 下载。
	step(name: string): RolloutStep;
	// base：基础包摘要，可用于应用侧记录或与客户端上报比较。
	readonly base: string;
};

/** Where the terminal surface's files live. */
// 所有终端资源与端点共享此前缀；路由模式基于它构造，CSP/缓存策略也以此为单位。
export const TUI_PREFIX = "/_chord/tui/";

/** Builds the terminal's base bundle and takes the kind's current set, then returns the surface. */
// 准备终端客户端的基础脚本和插件集合，返回待服务器加载的facet、发布步骤和固定基础摘要。
// 输入服务器、入口/插件选项与context；会读源码构建CommonJS基础包，失败向外拒绝，不启动终端沙箱。
// 例如应用加载facet后，已认证launcher可取 /_chord/tui/start，再下载其中的 script 和 combined URL。
export async function tuiSurface<P extends Principal>(
	server: Host<P>,
	options: TuiSurfaceOptions,
	context: Context,
): Promise<TuiSurface<P>> {
	// sandbox 平台生成单个CommonJS基础脚本，交给终端子进程自己的require来执行。
	const base = await buildBase(options.entry, "sandbox", TUI_PREFIX);
	// 默认插件kind名为tui；发布器复用web同样的脚本包装、摘要与旧代文件保留机制。
	const published = new PublishedScripts("tui", options.kind ?? "tui", TUI_PREFIX, base.hash, options.plugins, server);
	await published.start(context);
	// 优先查基础包，再查插件文件；这个闭包在请求时读取发布器当前保留的文件。
	const file = (path: string): ServedFile | undefined => base.files.get(path) ?? published.file(path);
	const serve = async (request: HttpRequest): Promise<HttpResponse> => served(file(request.path));
	// 声明对象和HTTP路由，真正的服务生命周期仍由应用的server.load管理。
	const facet = defineFacet<P>((host, self) => {
		scriptsFacet<P>("tui", published).setup(host, self);
		// 未设置 public 的路由遵循Http默认认证规则；base摘要端点单独允许匿名检测过期。
		self.contribute(Http, {
			routes: {
				[`GET ${TUI_PREFIX}start`]: async () => {
					// TuiStart 是静态结构约束；这里读取最新合并脚本URL，不返回插件源码正文。
					const start: TuiStart = { base: base.hash, script: base.script, combined: published.set.combined };
					return { kind: "json", value: start, headers: { "Cache-Control": "no-store" } };
				},
				[`GET ${TUI_PREFIX}base`]: {
					public: true,
					handler: async () => ({ kind: "json", value: base.hash, headers: { "Cache-Control": "no-store" } }),
				},
				// 普通文件和插件脚本各用一个单段模式；这是实际声明的路径集合。
				[`GET ${TUI_PREFIX}:file`]: serve,
				[`GET ${TUI_PREFIX}plugin/:file`]: serve,
			},
		});
	});
	// step(name) 返回稍后执行的rollout步骤；不在创建surface时等待任何终端客户端。
	return { facet, step: (name) => published.step(name), base: base.hash };
}
