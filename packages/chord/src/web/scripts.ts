/// <reference lib="dom" />
// A page's plugin scripts (slice 11 §2, decision "Slice 11's points" (P2)): scripts that register themselves through
// `chordFacet`, loaded with `<script src>` (no `eval` under the page's CSP). The combined file's scripts ran before the
// base bundle and queued (the page's bootstrap); later ones are fetched one each and resolve the fetch that asked for
// them. The plugins' stylesheets follow the applied set.
// 所属：web 浏览器侧插件脚本加载器；处理 bootstrap 队列与后续 <script src> 加载。
// 职责：把 queued 三元组变成 RegisteredScript，替换全局 chordFacet，按 name+digest 等待加载，并同步插件 CSS。
// 边界：不使用 eval；加载失败/注册不符会 reject；CSS 只管理 prefix 下的插件 link，不动应用/基础样式。
// 上游：startPage 创建；下游：startClient 的 initial/fetchScript/applied、document DOM。
// 导出：PageBootstrap 类型；PageScripts 类；syncStylesheets 函数。
// 组合：new PageScripts(bootstrap) → initial；fetch(entry) 插入 script 等注册；applied 调 syncStylesheets。
// 示例：const scripts = new PageScripts(bootstrap); const loaded = await scripts.fetch(entry);
// 阅读顺序：PageBootstrap → PageScripts 字段/构造 → fetch → syncStylesheets。

import type { FacetFunction, RegisteredScript, ScriptEntry, ScriptSet } from "../surfaces/index.ts";
import { REGISTER } from "../surfaces/index.ts";

/** What the page's bootstrap left: the base bundle's hash and the scripts the combined file registered. */
// readonly 元组固定每项的顺序为插件名、内容摘要、函数；这些类型不会校验实际下载的 JS。
export type PageBootstrap = {
	// base：服务端基础包摘要，用于判断整页是否过期；queued：合并文件在基础脚本运行前登记的 [name,digest,run]。
	readonly base: string;
	readonly queued: readonly (readonly [string, string, FacetFunction])[];
};

/** The page's plugin scripts: those the page started with, and fetches of later ones. */
export class PageScripts {
	/** Fetches waiting for their script to register, by plugin and digest. */
	// #waiting 以“插件名 + NUL + digest”为键保存 resolve；initial/base 是启动时固定值，之后只读。
	readonly #waiting = new Map<string, (script: RegisteredScript) => void>();
	readonly initial: readonly RegisteredScript[];
	readonly base: string;

	/** 接收页面已执行的注册队列，保存初始脚本并替换全局注册函数；例如 queued 中一个插件会变成 initial 的一项。
	 * 这里只保存 run，不调用插件；后续注册按“插件名 + NUL + digest”寻找等待者，没有等待者就忽略。
	 */
	constructor(bootstrap: PageBootstrap) {
		// 基础代码摘要用于之后判断是否必须刷新整页。
		this.base = bootstrap.base;
		// 解构每个三元组，映射为共享客户端接受的 RegisteredScript 对象。
		this.initial = bootstrap.queued.map(([plugin, digest, run]) => ({ plugin, digest, run }));
		// From now on a script that registers resolves its fetch.
		(globalThis as Record<string, unknown>)[REGISTER] = (plugin: string, digest: string, run: FacetFunction) => {
			// 可选调用 ?. 只在同一键已有 fetch 等待时交付；这里不按名称匹配其他版本。
			this.#waiting.get(`${plugin}\0${digest}`)?.({ plugin, digest, run });
		};
	}

	/** Loads `entry`'s script with a `<script src>`; resolves once it registered, rejects when it does not load. */
	/** 按条目 URL 加载一个脚本，返回注册结果 Promise；会临时插入 DOM 并维护等待表。
	 * 例如 foo 的摘要 d1 必须调用注册函数带回 foo/d1；下载失败或 load 后没有该注册都会拒绝。
	 */
	fetch(entry: ScriptEntry): Promise<RegisteredScript> {
		// NUL 分隔名称和摘要；两个不同摘要的同名插件拥有不同键。
		const key = `${entry.name}\0${entry.digest}`;
		// Promise 执行器立即登记处理器，异步 script 事件稍后调用 resolve/reject。
		return new Promise<RegisteredScript>((resolve, reject) => {
			// 使用普通外部 script 元素，执行由浏览器加载机制完成。
			const element = document.createElement("script");
			// 任一终结路径都删等待项及元素；删除元素不会撤回已运行脚本的副作用。
			const done = (): void => {
				this.#waiting.delete(key);
				element.remove();
			};
			// 先登记等待再插入 DOM，脚本一旦注册即可清理并兑现 Promise。
			this.#waiting.set(key, (script) => {
				done();
				resolve(script);
			});
			// error 代表脚本未加载成功；错误中保留插件与 URL 以便定位。
			element.addEventListener("error", () => {
				done();
				reject(new Error(`plugin "${entry.name}": its script ${entry.url} did not load`));
			});
			// A script that loaded without registering (a wrong file) never resolves its own key: refused on load.
			element.addEventListener("load", () => {
				// 正常注册已删除键；此时无需再处理 load。
				if (!this.#waiting.has(key)) return;
				// 文件执行完成仍没回报预期键，属于错误文件或注册摘要不符。
				done();
				reject(new Error(`plugin "${entry.name}": ${entry.url} did not register ${entry.digest}`));
			});
			// 设置来源并插入 head 才会真正启动浏览器加载。
			element.src = entry.url;
			document.head.append(element);
		});
	}
}

/**
 * Makes the page's plugin stylesheets those of `set`: a new one added, one no longer in it removed (the base bundle's
 * and the app's own stylesheets untouched).
 */
/** 同步插件 CSS：set 指定所需 URL，prefix 限定本组件管理的 link；无返回值。
 * 例如旧集合含 a.css、新集合含 b.css，则删 a 的 link、增 b 的 link；保留 app/base 的 link，不等待 CSS 下载。
 */
export function syncStylesheets(set: ScriptSet, prefix: string): void {
	// flatMap 跳过没有 css 的插件；Set 同时去重，后面删除已存在的 URL。
	const wanted = new Set(set.plugins.flatMap(({ css }) => (css === undefined ? [] : [css])));
	// 泛型 HTMLLinkElement 只告诉 TypeScript 查询结果类型；选择器限定插件路径。
	const links = document.querySelectorAll<HTMLLinkElement>(`link[rel="stylesheet"][href^="${prefix}plugin/"]`);
	// 检查已挂载的插件样式：保留想要的，并从待新增集合中移除。
	for (const link of links) {
		const href = link.getAttribute("href") ?? "";
		if (wanted.has(href)) wanted.delete(href);
		// 只有本选择器选中的过期插件样式才会被移除。
		else link.remove();
	}
	// wanted 现在只剩尚未挂载的 URL，逐个创建样式链接。
	for (const href of wanted) {
		const link = document.createElement("link");
		// rel 指定资源用途；href 是原始条目 URL，不改写路径。
		link.rel = "stylesheet";
		link.href = href;
		document.head.append(link);
	}
}
