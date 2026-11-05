// Chord v1 的 Node 插件模块加载器：通过 URL 查询参数使每次加载拿到新模块；不提供隔离，也不释放旧模块缓存。
// Node facet loader: `createHost({ loader: nodeLoader })`. Kept out of index.ts so the core stays browser-safe.
//
// TODO(loader): replace with an isolating, evicting loader. Every reload imports fresh module copies under a new
// query and the old copies are never evicted (they leak until the process exits). TUI plugins need isolation, which
// this loader does not provide.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import type { Facet, FacetDefinition, FacetLoader } from "./host.ts";

// 参数名虽然含 chord2，仍是这个 v1 加载器原有的缓存区分键，不是协议版本。
const PARAM = "chord2-reload";

/** Directory URLs (trailing slash) of loaded facet modules; their files are re-imported on reload. */
// Set 去重已加载目录；hooked 保证仅注册一次全局钩子，generation 为每批加载产生递增的缓存标识。
const roots = new Set<string>();
let hooked = false;
let generation = 0;

/**
 * A query on the entry URL only re-imports the entry module: its relative imports would resolve to cached copies.
 * This hook carries the reload query from a re-imported parent to children inside a facet module's directory.
 * Modules outside (Chord itself, shared code) stay single instances.
 */
/**
 * 无参数，首次调用为 Node 安装同步模块解析钩子；后续调用直接返回。副作用影响本进程的模块解析。
 * 钩子先使用默认/下游解析，再把父模块的批次参数传给已登记目录内的 file URL，其他模块不变。
 * 例如入口 a.ts?chord2-reload=2 导入同目录 b.ts，b 也得到参数 2，避免沿用上一批缓存；注册/解析错误直接抛出。
 */
function hook(): void {
	// 已安装就不重复注册；标志在 registerHooks 前置为 true。
	if (hooked) return;
	hooked = true;
	// registerHooks 是 Node 内置 API；此处 resolve 回调是同步钩子，不进行异步解析。
	registerHooks({
		/** 按 specifier/context 解析一项导入并返回 URL；需要刷新时复制解析结果，只替换 url。 */
		resolve(specifier, context, nextResolve) {
			// 先交给下一层解析，保留 Node 对包、相对路径等的正常处理和其他返回字段。
			const result = nextResolve(specifier, context);
			// 没有父模块或父 URL 不带参数时，不传递批次号；URLSearchParams.get 无键时返回 null。
			const version = context.parentURL === undefined ? null : new URL(context.parentURL).searchParams.get(PARAM);
			// 内置模块等非 file URL 不参与缓存刷新。
			if (version === null || !result.url.startsWith("file:")) return result;
			const url = new URL(result.url);
			// 已带参数就尊重已有值；some 判断是否处于任何登记目录中，roots 中的目录 URL 都以 / 结尾。
			if (url.searchParams.has(PARAM) || ![...roots].some((root) => url.href.startsWith(root))) return result;
			// 只修改新 URL 对象，原 result 不变；展开保留 format 等解析元数据。
			url.searchParams.set(PARAM, version);
			return { ...result, url: url.href };
		},
	});
}

/** 将路径、file URL 字符串或 URL 转成独立 URL 对象，无共享对象修改；例如 ./facet.ts 经 pathToFileURL 成为绝对 file URL。无效输入会抛出。 */
const toUrl = (module: string | URL): URL =>
	// instanceof 区分入口参数的两个联合成员；URL 输入也复制，字符串仅 file: 直接当 URL，其余按文件路径处理。
	module instanceof URL
		? new URL(module.href)
		: new URL(module.startsWith("file:") ? module : pathToFileURL(module).href);

/** Imports fresh copies of facet modules (default export: a FacetDefinition); each facet is named by its URL. */
/**
 * 接收只读路径/URL 数组，顺序导入一批插件，返回 Promise<Facet[]>；会安装解析钩子并执行模块顶层代码。
 * 先清查询参数、登记全部目录，再给入口加统一批次号；default 必须存在且 setup 为函数，否则抛 TypeError。
 * 例如两次 nodeLoader(["./plugin.ts"]) 得到不同模块实例，但 Facet.name 使用不带批次参数的稳定 URL。导入失败原样拒绝。
 */
export const nodeLoader: FacetLoader = async (modules) => {
	// FacetLoader 的类型来自 host.ts：只接收 string | URL；此处未检查调用者任意传入其他值的情况。
	hook();
	// ++ 先增加批次，再转字符串，作为该批全部入口/子模块的 URL 参数。
	const version = String(++generation);
	const facets: Facet[] = [];
	// map 创建独立 URL 数组；清除原查询参数保证 name 和本次缓存号由加载器统一决定，hash 不在此清除。
	const urls = modules.map((module) => {
		const url = toUrl(module);
		url.search = "";
		return url;
	});
	// Every root first: a facet importing another facet's directory gets this load's copy, whatever the order.
	// new URL(".", url) 取所属目录；先全部加入，保证先加载的插件也能刷新它所导入的另一插件目录。
	for (const url of urls) roots.add(new URL(".", url).href);
	// 这里逐个 await，不并行；前面的模块副作用会先完成。
	for (const url of urls) {
		// 保存加批次号前的稳定名字；随后仅修改本地 URL 对象的 searchParams。
		const name = url.href;
		url.searchParams.set(PARAM, version);
		// Owner-approved exception to the no-dynamic-import rule; see TODO(loader) above.
		const loaded = (await import(url.href)) as { default?: FacetDefinition };
		// as 只是 TS 断言，不会验证模块；真正的运行时入口检查在下面。
		const definition = loaded.default;
		// 只检查 default 存在且 setup 可调用，uses 的内容并未在这里做结构验证。
		if (definition === undefined || typeof definition.setup !== "function") {
			throw new TypeError(`${name}: default export must be a facet (defineFacet)`);
		}
		// 创建带稳定名字的 Facet，保留模块声明的 setup 和 uses；这里不调用 setup。
		facets.push({ name, setup: definition.setup, uses: definition.uses });
	}
	// 空输入返回空数组，已产生一个批次号；任意入口失败都使整个返回 Promise 拒绝。
	return facets;
};
