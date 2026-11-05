// Plugin scripts that register themselves (slice 11 §1, §2, decision "Slice 11's points" (P2)): a facet's built script
// served as `chordFacet("<plugin>", "<digest>", function (require, module, exports) { … })`, loaded with `<script src>`
// (a page under a `'self'` CSP: no `eval`, no `new Function`) or run by the terminal's runtime; the client evaluates the
// registered function with a `require` that answers only its host packages.

//
// 文件导读
// 所属：packages/chord 的 surfaces 层，定义插件脚本的“自注册”格式与客户端求值逻辑。
// 职责边界：只负责把构建产物包装成 chordFacet(...) 调用、提供受限 require、把默认导出校验为 facet；
// 不负责下载脚本、不执行 CSP 策略、不管理已加载集合（后者在 loaded.ts）。上游：构建/服务器生成注册脚本，
// 客户端（页面或终端）加载后调用 evaluateRegistered；下游：插件 facet 的 setup。错误：未知模块、脚本抛出、
// 默认导出不是 facet 都会抛出，并带上插件名；本文件不吞错。
// 能力清单：
// - REGISTER：全局注册函数名 "chordFacet"。
// - FacetFunction：注册脚本函数签名（require/module/exports）。
// - RegisteredScript：plugin + digest + run 的条目。
// - ClientModules：客户端可用模块表（specifier → 模块命名空间）。
// - registeredSource：把 facet 源码包装为可被 <script> 执行的文本。
// - evaluateRegistered：用受限 require 运行脚本并返回校验过的 Facet。
// - interop：把 ESM 命名空间包装成 CommonJS 友好的对象（WeakMap 缓存）。
// 组合与顺序：构建产物 source → registeredSource 生成文本 → 页面/终端执行 → REGISTER 记录 →
// evaluateRegistered 用 modules 解析 require → 取 module.exports.default → 校验 setup 后返回。
// 示例：`const script = { plugin: "editor", digest: "d1", run };
// const facet = evaluateRegistered(script, { "chord/web": api, react });`
// 阅读顺序：先看 REGISTER/FacetFunction/RegisteredScript，再看 registeredSource，然后 evaluateRegistered，最后 interop。
import type { Principal } from "../data/index.ts";
import type { Facet } from "../host/index.ts";

/** The global function a registered script calls: defined by the client before any plugin script runs. */
export const REGISTER = "chordFacet";

/** A built facet's function, as its script registers it. */
export type FacetFunction = (
	require: (specifier: string) => unknown,
	module: { exports: unknown },
	exports: unknown,
) => void;

/** One registered script: its plugin, its digest and its function. */
export type RegisteredScript = { readonly plugin: string; readonly digest: string; readonly run: FacetFunction };

/** The modules a client's plugin scripts import, by specifier (the app's API modules for the kind, React, ...). */
export type ClientModules = Readonly<Record<string, unknown>>;

/**
 * The text of a registered script for `plugin`'s facet built as `source` (one function expression, the build's
 * wrapped CommonJS script) with `digest`. Its source map comment stays on its own line, before the closing call.
 */
export function registeredSource(plugin: string, digest: string, source: string): string {
	return `${REGISTER}(${JSON.stringify(plugin)},${JSON.stringify(digest)},${source}\n);\n`;
}

/**
 * Runs `script`'s function and returns its facet (its default export). Its `require` answers `modules` only (the build
 * kept nothing else external for a client kind); anything else throws naming the plugin. Throws what the script throws,
 * and when its default export is no facet.
 */
export function evaluateRegistered<P extends Principal = Principal>(
	script: RegisteredScript,
	modules: ClientModules,
): Facet<P> {
	const where = `plugin "${script.plugin}"`;
	const module = { exports: {} as unknown };
	script.run(
		(specifier) => {
			if (Object.hasOwn(modules, specifier)) return interop(modules[specifier]);
			throw new Error(`${where}: "${specifier}" is not one of this client's host packages`);
		},
		module,
		module.exports,
	);
	// A trust boundary: plugin code; its default export is checked to be a facet.
	const facet = (module.exports as { readonly default?: unknown } | null)?.default;
	if (typeof facet !== "object" || facet === null || typeof (facet as { setup?: unknown }).setup !== "function") {
		throw new Error(`${where}: its default export is not a facet (defineFacet)`);
	}
	return facet as Facet<P>;
}

/** ESM namespaces wrapped for a CommonJS script, by namespace: one wrapper per namespace, held as long as it is. */
const wrapped = new WeakMap<object, object>();

/**
 * A host package as a CommonJS script imports it: an ESM namespace wrapped once with `__esModule` (so esbuild's interop
 * reads its `default` for a default import, its names for named ones), any other value as it is.
 */
export function interop(value: unknown): unknown {
	if (typeof value !== "object" || value === null || Object.prototype.toString.call(value) !== "[object Module]") {
		return value;
	}
	let made = wrapped.get(value);
	if (made === undefined) {
		made = { ...value, __esModule: true };
		wrapped.set(value, made);
	}
	return made;
}
