// The web surface's server side (slice 11 §1, decisions "Slice 11's points" and "P3" to "P5"): the base bundle built
// from the app's entry at start, the plugins' web scripts published as registered scripts and one combined file,
// `WebScripts` showing the current set, and the page through the app's own template; everything as `Http`
// contributions of the surface's facet, which the app puts among the server's core facets. The app keeps its HTML,
// 所属：node/surfaces 的网页表面（服务器侧）；组合基础包、插件发布器、页面模板与 HTTP 路由。
// 职责：构建浏览器基础包、发布当前插件脚本、贡献 WebScripts 对象、文件/摘要/页面路由与 CSP 来源。
// 边界：不监听端口、不渲染 HTML（模板由应用提供）、不执行浏览器代码；HTTP 认证由 Http 组件负责。
// 上游：应用在服务器启动时调用 webSurface；下游：buildBase、PublishedScripts、scriptsFacet、Http。
// 导出清单：WebSurfaceOptions 配置；PageAssets 模板输入；WebSurface 句柄；WEB_PREFIX；webSurface 入口；pageScripts 标签生成。
// 组合：webSurface → buildBase → PublishedScripts.start → facet(scriptsFacet + Http) → 页面模板调用 pageScripts。
// 示例：const surface = await webSurface(server, { plugins, entry, page, paths: ["/"] }, context); await server.load([surface.facet]);
// 阅读顺序：WebSurfaceOptions → PageAssets → WebSurface → WEB_PREFIX → webSurface → webRoutes → pageAssets → bootstrap → pageScripts。
// CSS, components and themes.

import type { Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet, type Host } from "../../host/index.ts";
import { REGISTER, type ScriptSet } from "../../surfaces/index.ts";
import { Http, type HttpRequest, type HttpResponse, type HttpRouteOptions } from "../http/index.ts";
import type { Plugins, RolloutStep } from "../plugins/index.ts";
import { type BaseBundle, buildBase } from "./bundle.ts";
import { scriptsFacet } from "./current.ts";
import { PublishedScripts } from "./published.ts";
import { type ServedFile, served } from "./served.ts";

/** What `webSurface` takes. */
export type WebSurfaceOptions = {
	// ? 表示可省略的选项；类型不会在运行时验证调用者，默认值由实现的 ?? 提供。
	/** The web facet kind: `web` by default. */
	// kind：插件管理器中的网页脚本种类，默认 "web"；发布器据此选择构建结果。
	readonly kind?: string;
	// plugins：插件管理器；webSurface 调用 scripts/current 并生成发布文件。
	readonly plugins: Plugins;
	/** The app's web start code (it calls `startPage`): the base bundle's entry. */
	// entry：应用网页入口，必须调用 startPage；esbuild 从它打包浏览器基础脚本。
	readonly entry: string;
	/** The page's HTML: the app's template, given the request (its `nonce`) and the assets to include. */
	// page：应用自己的 HTML 模板；同步或异步返回完整页面，通常把 pageScripts(assets, request.nonce) 插入 head/body。
	readonly page: (request: HttpRequest, assets: PageAssets) => string | Promise<string>;
	/** The paths serving the page: `["/"]` by default (patterns, `/*` for a page with its own routing). */
	// paths：提供页面的路由模式，默认 ["/"]；可以是 "/notes/*" 等带自有路由的页面。
	readonly paths?: readonly string[];
	/** Whether the page and its scripts are served without a principal (a public app); signed in only by default. */
	// public：为 true 时页面及脚本允许匿名访问；默认需要 principal，文件路由沿用同一策略。
	readonly public?: boolean;
};

/**
 * What a page includes, in this order: `bootstrap` as an inline script with the response's nonce, then the scripts
 * `plugins` and `script` (deferred, in that order), and the stylesheets `styles` (the base bundle's first, then each
 * plugin's). `pageScripts` writes the script tags.
 */
// 页面模板要插入的资源：内联引导文本、两个脚本 URL 和样式 URL 列表；顺序由 pageScripts 保证。
export type PageAssets = {
	// 这是页面模板需要插入的字符串/URL；readonly 与 readonly string[] 都只在类型层面限制修改。
	// bootstrap：不含 <script> 标签的内联 JS 正文；模板必须用带 nonce 的标签包住它。
	readonly bootstrap: string;
	// script：基础包 URL；plugins 是当前合并插件 URL；styles 基础样式在前、插件样式在后。
	readonly script: string;
	readonly plugins: string;
	readonly styles: readonly string[];
};

/** The web surface: its facet (for the server's core facets), its rollout step, its base bundle's hash. */
// 返回给应用的网页表面句柄：加载 facet 后才有路由；step 用于发布新插件集合；base 是基础摘要。
export type WebSurface<P extends Principal> = {
	readonly facet: Facet<P>;
	/** The rollout step publishing the web kind's current set (after the server's step). */
	step(name: string): RolloutStep;
	readonly base: string;
};

/** Where the web surface's files live. */
// 所有网页资源与端点共享此前缀；webRoutes 基于它注册文件、插件、资产和 base 摘要路由。
export const WEB_PREFIX = "/_chord/web/";

/**
 * Builds the base bundle and takes the web kind's current set (its facets built on first use), then returns the
 * surface. Rejects with esbuild's failure when the base bundle does not build.
 */
// 为服务器准备网页资源及声明包。输入 host、入口/插件/页面模板与 context，返回 facet、rollout步骤和基础包摘要。
// 创建时读取源码构建基础包并取得插件脚本，失败会拒绝；返回 facet 仍须由应用加载到 server 才会有路由。
// 例如 paths:["/"] 时应用加载该 facet 后才能访问首页；step("web") 用于显式发布后续插件版本。
// 这里的 P 泛型把服务器和声明包绑定到同一身份类型，不决定实际 HTTP 授权。
export async function webSurface<P extends Principal>(
	server: Host<P>,
	options: WebSurfaceOptions,
	context: Context,
): Promise<WebSurface<P>> {
	// 浏览器基础包在此构建一次；buildBase 用 write:false 留在内存，错误直接向外传播。
	const base = await buildBase(options.entry, "browser", WEB_PREFIX);
	// ?? 仅在 kind 为 null/undefined 时回退；PublishedScripts 保存每次发布的脚本集合和旧文件。
	const published = new PublishedScripts("web", options.kind ?? "web", WEB_PREFIX, base.hash, options.plugins, server);
	await published.start(context);
	// 箭头函数作为查找回调：先查基础包，再查近几代插件文件；未找到返回 undefined。
	const file = (path: string): ServedFile | undefined => base.files.get(path) ?? published.file(path);
	// defineFacet 只包装 setup；下面注册和贡献在应用调用 host.load 时发生。
	const facet = defineFacet<P>((host, self) => {
		// 将脚本集合对象与本 facet 一起声明，远程客户端随后可订阅它。
		scriptsFacet<P>("web", published).setup(host, self);
		// 向 Http 注册表贡献路由和所需 CSP 来源；这不是直接创建监听端口。
		self.contribute(Http, {
			routes: webRoutes(options, base.hash, file, () => pageAssets(base, published)),
			// 页面使用自身样式/字体，图片另允许 data URL；其余基线由 HTTP 组件合并。
			csp: { "style-src": ["'self'"], "img-src": ["'self'", "data:"], "font-src": ["'self'"] },
			// Scripts from the surface's files only (and the page's nonce): no other same-origin response runs (Opus L8).
			scripts: [WEB_PREFIX],
		});
	});
	// step 闭包将发布操作留给 rollout；base 是启动时固定的摘要，用于客户端判断基础代码是否过期。
	return { facet, step: (name) => published.step(name), base: base.hash };
}

/** The surface's routes: its files (served forever), its current base hash (public), and the page. */
// 组装路由描述表，不接收真实请求；输入选项、基础摘要、文件查找和实时 assets 回调，返回字符串键的路由对象。
// 文件路由按 public 控制匿名访问，base摘要公开，页面由模板异步生成；例如 paths:["/notes/*"] 增加该页面路由。
// 回调抛错交由 HTTP 层处理；函数自身只创建对象，不写网络或修改插件集合。
function webRoutes(
	options: WebSurfaceOptions,
	base: string,
	file: (path: string) => ServedFile | undefined,
	assets: () => PageAssets,
): Record<string, HttpRouteOptions> {
	// as const 保留 true 字面量以符合路由类型；只有显式 true 才开放匿名访问。
	const access = options.public === true ? { public: true as const } : {};
	// request.path 来自 HTTP 匹配后的请求；served 只返回响应描述，缺文件时给404。
	const serve = async (request: HttpRequest): Promise<HttpResponse> => served(file(request.path));
	const routes: Record<string, HttpRouteOptions> = {
		// [表达式] 是计算属性名；...access 展开公共的访问策略，各前缀各匹配一段文件名。
		[`GET ${WEB_PREFIX}:file`]: { ...access, handler: serve },
		[`GET ${WEB_PREFIX}plugin/:file`]: { ...access, handler: serve },
		[`GET ${WEB_PREFIX}assets/:file`]: { ...access, handler: serve },
		// Asked by a page before it reconnects: another base means its code is outdated. Public: an outdated page whose
		// session ended still learns it should reload.
		[`GET ${WEB_PREFIX}base`]: {
			public: true,
			handler: async () => ({ kind: "json", value: base, headers: { "Cache-Control": "no-store" } }),
		},
	};
	// 默认仅首页；for...of 为每个配置路径设置页面描述，同名键后写覆盖前写。
	for (const path of options.paths ?? ["/"]) {
		routes[`GET ${path}`] = {
			...access,
			page: true,
			// assets() 在请求时读取最新插件集合；await 支持同步字符串模板和异步模板两种返回。
			handler: async (request) => ({ kind: "html", body: await options.page(request, assets()) }),
		};
	}
	// 返回描述表供 Http 的 compose 合成路由器；此处尚未调用页面模板。
	return routes;
}

/** What the page includes now: the bootstrap, the base script, the current combined file, the stylesheets. */
// 取得本次页面需要的资源列表，返回引导脚本、基础脚本、当前合并插件文件及 CSS URL，无外部副作用。
// base 固定，published.set 每次读取最新值；例如无基础CSS且两个插件中一个带CSS，styles只含那个插件的URL。
function pageAssets(base: BaseBundle, published: { readonly set: ScriptSet }): PageAssets {
	// 解构固定本次读取的集合，下面的脚本与样式都来自同一份 set。
	const { set } = published;
	const styles = [
		// 条件数组再展开：没有基础样式就不添加元素，存在时排在插件样式前面。
		...(base.style === undefined ? [] : [base.style]),
		// flatMap 将每个插件映射成零个或一个CSS URL，再摊平；参数解构只需要 css 字段。
		...set.plugins.flatMap(({ css }) => (css === undefined ? [] : [css])),
	];
	// bootstrap 创建注册队列，供基础脚本运行前的插件脚本把函数加入其中。
	return { bootstrap: bootstrap(base.hash), script: base.script, plugins: set.combined, styles };
}

/**
 * The page's inline bootstrap: the base hash for `startPage`, and the `chordFacet` the combined file's scripts call
 * before the base bundle runs (they queue; `startPage` takes them).
 */
// 生成页面内联启动代码；输入基础摘要，返回 JavaScript 字符串，不在服务器执行它。
// 运行时网页先建 chordPage 和 chordFacet，把插件的 [名称,摘要,工厂] 入队；示例摘要 abc 会被 JSON.stringify 安全引号化。
// 模板内容是要交给浏览器的程序文本，因此学习说明写在外面，不能插入改变其字节。
function bootstrap(hash: string): string {
	// REGISTER 来自共享约定，当前是 chordFacet；hash 序列化为JS可用的字符串字面量。
	return `globalThis.chordPage={base:${JSON.stringify(hash)},queued:[]};globalThis.${REGISTER}=function(p,d,f){chordPage.queued.push([p,d,f])};`;
}

/** The page's script tags for `assets`: the inline bootstrap with `nonce`, then the deferred scripts; the stylesheets. */
// 为应用模板生成标签字符串：先样式，再带nonce的内联引导，再依次 defer 加载插件和基础脚本。
// assets 与 nonce 由受信任的服务器资源路径/HTTP nonce 提供；这里直接插值，不做 HTML 转义或网络请求。
// 例如一个CSS会产生一条<link>和三条<script>；顺序确保注册函数先存在，插件先注册，应用基础入口后启动。
export function pageScripts(assets: PageAssets, nonce: string): string {
	return [
		// map 把每个样式URL转成一条link；... 把生成的数组并入最终标签数组。
		...assets.styles.map((href) => `<link rel="stylesheet" href="${href}">`),
		`<script nonce="${nonce}">${assets.bootstrap}</script>`,
		`<script defer src="${assets.plugins}"></script>`,
		`<script defer src="${assets.script}"></script>`,
		// join 用换行拼接，返回普通字符串，浏览器执行要等应用把它嵌入 HTML。
	].join("\n");
}
