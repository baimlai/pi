// Building (slice 7c §2, slice 12 §1-§4): one facet of one plugin as one script, by esbuild from cold. Its own files,
// files of other plugins of its root imported by relative path (copies; decision "Contracts come from where the
// plugin's code came from") and its npm `dependencies` (through their `exports`) are inlined; host packages, this
// component, `chord.external` packages and Node builtins stay external, answered at evaluation by the `require` the
// script takes. Every import is checked by the file it resolves to: a per-kind file only for its kind, the app's API
// only at a listed version the kind provides, one version per facet, never Chord directly. The result is plain data,
// the same value a worker or a page evaluates where it runs; a failed build is a result, never a throw.

// 文件导读
// 所属模块：packages/chord/src/node/plugins 的构建层，对应 slice 7c §2 与 slice 12 §1-§4，是插件组件里唯一直接依赖
// esbuild 的地方之一（另一个是 css-modules.ts）。
// 职责边界：把一个插件的某一个 facet 从磁盘构建成一段自包含的 CommonJS 脚本，并检查所有导入是否符合应用的 API、
// 种类、依赖和 external 规则；它不发现插件（调用方传入 Plugin）、不执行脚本、不写文件、不加载宿主。
// 上游入口：Plugins 组件的 #buildOne 和 testing.ts 的 testPlugin 调用 buildFacet；输入是 discover.ts 的 Plugin、应用
// 种类配置和 BuildOptions。下游：BuiltFacet 作为普通数据交给 evaluate.ts 求值、watcher 记录 inputs、rollout 传输给
// worker/浏览器；失败的构建也是返回值，不是异常。
// 结果与错误流向：成功返回 {kind:"script", source, digest, inputs, copied, css?, assets, api?}；无法构建时返回
// {kind:"failed", errors}，每条错误带插件内文件、行、列。只有文件系统读取失败等意外异常才会从函数抛出。
// 能力清单：
// - AppApi：应用 API 的包名与版本列表（新版本在前），其模块同时必须是宿主包。
// - BuildOptions：宿主包说明符、node/browser 平台、应用 API、facet kinds、根内其他插件、公共资源路径。
// - BuildInput：构建实际读到的插件文件及其内容哈希，供 watcher 判断变化。
// - BuiltFacet：构建成功的脚本/样式/资源/API 记录，或失败消息列表的可辨识联合。
// - buildFacet(plugin, kind, options, context)：从零运行一次 esbuild，返回 BuiltFacet。
// - inside(dir, path)：判断路径是否严格位于目录内，构建规则和调用方共用。
// 内部主要概念：ImportRules 是挂在 esbuild 上的导入规则；Place 描述文件属于本插件、根内另一插件、依赖包还是外部；
// Resolution 是规则对说明符给出的结论。GLOBAL_MARKERS/LOADERS/BROWSER_ONLY/CHORD_PACKAGE 是规则使用的常量。
// 组合与调用顺序：buildFacet 先校验 facet 入口 -> 构造 ImportRules -> esbuild 在 onResolve/onLoad 中逐文件检查、哈希、
// 作用域化 CSS module -> 输出脚本后再扫描自由 __dirname/__filename、混合 API 版本，最后生成摘要和输入清单。
// 示例：const built = await buildFacet(plugin, "server", {
//   hostPackages: ["@earendil-works/chord", "@acme/app/v3"], platform: "node",
//   api: { name: "@acme/app", versions: ["v3", "v2"] }, kinds: ["server", "worker", "web"],
//   plugins: discovery.plugins, publicPath: "/",
// }, context);
// 真实签名如此；built.kind 为 "script" 时可以交给 evaluateFacet，为 "failed" 时应记录 built.errors。
// 建议阅读顺序：AppApi/BuildOptions/BuiltFacet -> buildFacet 主流程 -> freeGlobals -> ImportRules 的构造与 onResolve /
// onLoad -> #resolve/#apiImport/#checkFile/#pluginCode 等规则 -> describe 与辅助函数。
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import {
	type BuildFailure,
	build,
	type Plugin as EsbuildPlugin,
	type Loader,
	type Message,
	type OnLoadResult,
} from "esbuild";
import type { Context } from "../../context/index.ts";
import { SCOPED_CSS, scopeCssModule } from "./css-modules.ts";
import { discoverPackage, type Plugin } from "./discover.ts";
import { PLUGINS_SPECIFIER, packageName } from "./evaluate.ts";
import { inlineSourceMap } from "./stack.ts";

// 应用 API：name 是插件导入的包名（如 @acme/app），versions 是它提供的版本，按新到旧排列。
// 这些版本的模块本身还必须出现在 BuildOptions.hostPackages 中；例如 @acme/app/v3 与 @acme/app/v3/web。
// 类型只约束编译期，应用配置错误（空数组、版本重名）不会在这里被运行时检查。
/**
 * The app's API (slice 12 §1): the package plugins import it as and the versions it provides, newest first
 * (`{ name: "@acme/app", versions: ["v3", "v2"] }`). Its modules are host packages (`@acme/app/v3`, `@acme/app/v3/web`).
 */
export type AppApi = { readonly name: string; readonly versions: readonly string[] };

// 构建选项：除插件和种类外，构建行为完全由这些字段决定。字段含义见下方逐项注释；对象是普通数据，不做运行时冻结。
/** What `buildFacet` takes besides the plugin and the kind. */
export type BuildOptions = {
	// 宿主包说明符保持 external，由求值时的 require 回答；这里只拿说明符字符串，不加载模块。
	/** The host packages' specifiers (`@acme/app/v3`, `@acme/app/v3/web`, `react`, `react/jsx-runtime`): external. */
	readonly hostPackages: readonly string[];
	// 运行平台决定 target、内置模块、CSS/资源是否允许以及 chord.external 的处理；node 与 browser 是类型层面的二选一。
	/** Where the script runs: Node (a server, a worker, a TUI) or a browser (a page). */
	readonly platform: "node" | "browser";
	// 有 api 时，导入 @app/vN 会按版本与种类检查，并禁止直接导入 Chord；没有 api 时按 hostPackages 原样放行。
	// 这是可选字段，因此调用方必须处理 undefined。
	/** The app's API: its imports checked by version and kind, Chord refused. Without one, host packages as listed. */
	readonly api?: AppApi;
	// kinds 用于识别每种类专属文件名 `<name>.<kind>.<ext>` 和顶层 facet 文件；默认空数组表示不做种类检查。
	/** The app's facet kinds: a file named `<name>.<kind>.<ext>` is one of that kind, refused in a facet of another. */
	readonly kinds?: readonly string[];
	// plugins 是同一应用的完整发现结果，用于允许通过相对路径导入同一 root 内其他目录插件的文件（复制进来）；
	// 其他 root 的插件和单文件插件不能以这种方式复制。
	/** The discovered plugins: a file of a directory plugin of the same root may be imported by relative path (a copy). */
	readonly plugins?: readonly Plugin[];
	// 浏览器构建里资源 URL 的前缀，默认 "/"；只影响生成代码中的路径，不影响本次内存构建的落盘（构建不写文件）。
	/** Where the app serves a browser build's assets: the URL prefix their imports evaluate to (`/` by default). */
	readonly publicPath?: string;
};

// 一条构建输入：file 是插件文件的绝对真实路径，hash 是交给 esbuild 的那份字节的 sha256。
// watcher 用 file 建立“哪些插件读过这个路径”，用 hash 判断内容是否真的变化。
/** A file a build read, with the hash of the bytes it handed esbuild (the watcher's inputs). */
export type BuildInput = { readonly file: string; readonly hash: string };

// 构建结果的两种形状。script 分支是普通数据，可结构化克隆后送到 worker/浏览器；failed 分支同样返回而不抛出，
// 使一个插件的构建失败不会中止整批构建（组件会单独报告并保留旧 facet）。
/** A built facet: its script and what it used, or the build's errors. Plain data. */
export type BuiltFacet =
	| {
			// plugin/facet 标识这是哪个插件的哪种 facet，报告和错误消息都用它定位。
			readonly kind: "script";
			readonly plugin: string;
			readonly facet: string;
			// source 是 banner/footer 包好的 CommonJS 函数表达式，已压缩；source map 内联，sources 相对插件目录，
			// 所以不同机器/检出路径得到相同摘要。
			/** The wrapped CommonJS script, minified, with an inline source map whose sources are relative to the plugin. */
			readonly source: string;
			// digest 只对 source 做 sha256，是“脚本是否变化”的身份；相同文件在不同机器上摘要一致。
			/** A hash of `source`: the same on every machine and checkout for the same files. */
			readonly digest: string;
			// inputs 是实际读到的插件文件（本插件和复制文件，不含依赖包），带内容哈希；构建失败时不会产生这个列表。
			/** Every plugin file it read (its own and copied ones; not packages), absolute paths, with their hashes. */
			readonly inputs: readonly BuildInput[];
			// copied 记录被内联的其他插件文件，供诊断和 watcher 关联；它们是复制，不是外部引用。
			/** The files of other plugins inlined into it, absolute paths. */
			readonly copied: readonly string[];
			// css 只在浏览器构建导入 CSS 时出现；name 是内容哈希文件名，text 是合并后的样式表。
			/** A browser build's stylesheet, when it imports CSS. */
			readonly css?: { readonly name: string; readonly text: string };
			// assets 是浏览器构建的其他输出（如图片/wasm），按内容哈希命名；bytes 是内存中的内容。
			/** A browser build's assets, by content-hashed file name. */
			readonly assets: readonly { readonly name: string; readonly bytes: Uint8Array }[];
			// api 记录构建检查所依据的应用 API 和脚本实际导入的版本；version 为 undefined 表示脚本没有导入 API。
			// 求值器用它拒绝运行时计算出的其他版本导入。
			/**
			 * The app's API the build checked against and the version the script imports (when it imports one):
			 * evaluation refuses other versions and Chord to a computed `require` as the build did to imports.
			 */
			readonly api?: { readonly name: string; readonly version: string | undefined };
	  }
	// 失败结果保留插件和种类，errors 是逐条格式化后的消息；这里没有 source/digest，因此求值器不会执行它。
	| { readonly kind: "failed"; readonly plugin: string; readonly facet: string; readonly errors: readonly string[] };

// 插件脚本没有模块身份：构建时把自由的 __dirname/__filename 替换成两个特殊标识符，输出后再扫描这些标识符，
// 以便借助 source map 报告准确的文件、行、列。标识符本身不是合法可用的全局变量。
/** What a free `__dirname` and `__filename` become in a build: names no script has, found again by `freeGlobals`. */
const GLOBAL_MARKERS = { __dirname: "__chord_plugin_dirname", __filename: "__chord_plugin_filename" };

// 构建一个 facet。
// 输入：plugin（发现记录）、kind（应用的种类名）、options（平台/API/kinds/其他插件等）、context（可中止）。
// 输出：BuiltFacet；成功时脚本可直接求值，失败时 errors 说明每个拒绝原因。
// 副作用：读取插件及其依赖的文件、运行 esbuild（内存输出，不写磁盘）、缓存本次读取的 manifests。
// 错误路径：没有该种类的 facet、入口链接逃出插件、esbuild 构建失败、出现自由模块全局变量、同一 facet 导入两个
// API 版本，都会转成 failed。文件系统读取失败等意外异常仍会抛出。
// 主要流程：构造失败辅助函数 -> 检查 facet 文件存在 -> 解析入口真实路径 -> 建立导入规则并检查入口 -> 运行 esbuild ->
// 取出 JS/CSS/资源 -> 扫描自由全局 -> 检查混合版本 -> 生成摘要与输入清单。
// 例子：const built = await buildFacet(plugin, "worker", options, context);
// 若 built.kind === "script"，其 source 是一个 (function (require, module, exports) { ... }) 表达式。
// 真实构建还会读取依赖的 exports 映射；示例未展示依赖安装过程。
/**
 * Builds `plugin`'s facet of `kind` (one esbuild build from cold): a script wrapped as `(function (require, module,
 * exports) { … })`, or the errors that refuse it (an import the rules do not admit, a syntax error, `import.meta`,
 * `__dirname`, `__filename`, a literal dynamic `import("x")`, a top-level `await`), each naming its file and line. A
 * computed `import(x)` becomes a call of the script's `require`.
 */
export async function buildFacet(
	plugin: Plugin,
	kind: string,
	options: BuildOptions,
	context: Context,
): Promise<BuiltFacet> {
	// 局部构造失败结果的辅助函数：三处失败路径共用同一形状，避免重复字段。
	const failed = (errors: readonly string[]): BuiltFacet => ({
		kind: "failed",
		plugin: plugin.name,
		facet: kind,
		errors,
	});
	// facets 只包含发现阶段识别到的种类；没有该种类就没有可构建的入口。
	const named = plugin.facets[kind];
	if (named === undefined) return failed([`plugin "${plugin.name}" has no ${kind} facet`]);
	// 构建开始前响应取消；可选链表示 Context 可能没有 abortSignal。
	context.abortSignal?.throwIfAborted();
	// A facet file may be a link: its real file must be the plugin's, and of no other kind.
	// facet 文件可能是符号链接；真实路径才是 esbuild 的入口，也用于检查链接是否逃出插件。
	const entry = await realpath(named);
	// 导入规则是本次构建的 esbuild 插件，同时累积输入哈希、复制文件、API 版本等结果。
	const rules = new ImportRules(plugin, kind, entry, options, context);
	// 入口检查独立于 esbuild：链接可能指向插件外或另一种类的文件，这类错误要指回用户写的 facet 文件名。
	const wrongEntry = rules.checkEntry(named, entry);
	if (wrongEntry !== undefined) return failed([wrongEntry]);
	// 平台分支在后续规则和 target 选择中反复使用。
	const browser = options.platform === "browser";
	// Awaited<ReturnType<typeof build>> 取出异步 build 函数解析后的结果类型，避免手写 esbuild 的复杂返回类型。
	let result: Awaited<ReturnType<typeof build>>;
	try {
		// 以下是 esbuild 的关键配置，按用途分组解释：
		result = await build({
			// 只构建真实入口；absWorkingDir 让相对路径与 source map 以插件目录为基准。
			entryPoints: [entry],
			absWorkingDir: plugin.dir,
			// outdir 并不写盘（write:false），它只决定输出路径和 source map 中的相对位置，因此可以安全地指向插件目录。
			// Nothing is written: the directory only makes the source map's paths relative to the plugin.
			outdir: plugin.dir,
			// 入口和资源都使用内容哈希命名，供浏览器缓存与 CSS/资源引用；entryNames 的文字不影响脚本内容。
			entryNames: "[name]-[hash]",
			// publicPath 决定浏览器资源 URL 的前缀；默认 "/"。
			assetNames: "[name]-[hash]",
			// 构建在内存完成，outputFiles 直接返回，插件目录不会被写入半成品。
			publicPath: options.publicPath ?? "/",
			// bundle 把本插件文件、同根其他插件文件和 npm 依赖内联；format cjs 与下面的 banner/footer 配套。
			write: false,
			bundle: true,
			// platform/target 决定可用的全局对象与语法：浏览器用 es2022，Node 用 node22；minify 压缩脚本。
			format: "cjs",
			platform: options.platform,
			target: browser ? "es2022" : "node22",
			// 不保留法律注释；内联 source map 让错误可映射，但不带 sourcesContent，避免把源码文本放进脚本。
			minify: true,
			legalComments: "none",
			sourcemap: "inline",
			// Positions only: a stack is mapped to files and lines, never shown their text.
			sourcesContent: false,
			// tsconfigRaw:{} 表示忽略项目 tsconfig，只做类型擦除；JSX 使用 automatic 运行时，不要求插件显式导入 React。
			// Ignore any tsconfig.json: TypeScript is stripped, JSX compiled with the automatic React runtime.
			tsconfigRaw: "{}",
			jsx: "automatic",
			// banner/footer 把模块代码包成 (function (require, module, exports) { ... })，求值器执行后得到这个函数。
			banner: { js: "(function (require, module, exports) {" },
			footer: { js: "})" },
			// define 把自由的 __dirname/__filename 替换为标记；empty-import-meta 提升为 error，防止 import.meta 悄悄变成空对象。
			// esbuild 不会报告它自己替换掉的 import.meta，所以还要在输出后扫描标记。
			// `import.meta` is refused here; a free `__dirname` or `__filename` becomes a marker found in the output below
			// (esbuild reports no `import.meta` it substituted itself).
			define: GLOBAL_MARKERS,
			logOverride: { "empty-import-meta": "error" },
			// 关闭对真实 dynamic import 的支持：字面量 import("x") 在规则里直接拒绝，计算出的 import(x) 被降级为 require 调用，
			// 由求值器的 require 规则回答；vm.Script 没有模块加载器可用。
			// A computed `import(x)` (a literal one is refused below) goes through the facet's `require`, which names the
			// facet when it does not answer; `vm.Script` has no loader for a real one.
			supported: { "dynamic-import": false },
			// silent 避免 esbuild 直接打印警告；错误通过 plugin 返回或抛出，再由下面的 describe 统一格式化。
			logLevel: "silent",
			plugins: [rules.plugin],
		});
		// esbuild 的 BuildFailure 携带 errors 数组；若不是该形状，用 String(error) 造一条消息，保证仍是 failed 结果。
	} catch (error) {
		return failed(
			((error as BuildFailure).errors ?? [{ text: String(error) }]).map((each) => describe(plugin, each)),
		);
	}
	// Never written: esbuild hands the outputs back.
	// write:false 保证 outputFiles 存在；非空断言表达这个 esbuild 契约，而不是运行时检查。
	const files = result.outputFiles!;
	// 输出中恰好有一个 JS 入口（banner/footer 包装后的脚本）和一个可选 CSS；find 的 ! 表示构建契约保证存在。
	const script = files.find((file) => file.path.endsWith(".js"))!;
	const css = files.find((file) => file.path.endsWith(".css"));
	const source = script.text;
	// 扫描输出中的 __chord_plugin_dirname/filename 标记；自由模块全局在打包后仍会以这些名字出现。
	const globals = freeGlobals(source);
	if (globals.length > 0) return failed(globals);
	// 同一 facet 导入两个 API 版本在 esbuild 阶段都可能是外部依赖，必须构建后统一拒绝。
	const mixed = rules.mixedVersions();
	if (mixed !== undefined) return failed([mixed]);
	// 没有应用 API 时 api 字段整体省略；有则记录名称与脚本实际导入的版本（可能 undefined）。
	const api = options.api === undefined ? undefined : { name: options.api.name, version: rules.version() };
	return {
		kind: "script",
		plugin: plugin.name,
		facet: kind,
		source,
		// 摘要只看脚本文本；source map 使用相对路径，因此相同源码在不同机器上摘要一致。
		digest: createHash("sha256").update(source).digest("hex"),
		inputs: rules.inputs(),
		copied: rules.copied(),
		// 条件展开：没有 CSS 时对象里根本没有 css 字段，而不是 css: undefined。
		...(css === undefined ? {} : { css: { name: basename(css.path), text: css.text } }),
		// 其他输出都作为资源；relative(plugin.dir, file.path) 让名称相对于插件目录，bytes 保持 Uint8Array。
		assets: files
			.filter((file) => file !== script && file !== css)
			.map((file) => ({ name: relative(plugin.dir, file.path), bytes: file.contents })),
		// 同上，api 为 undefined 时省略字段，便于结构化克隆和稳定比较。
		...(api === undefined ? {} : { api }),
	};
}

// 所有“插件脚本不能拥有模块身份”的错误共用的提示：通过 pluginFile 读插件文件。
/** Where a build error points for what a plugin script cannot have. */
const PLUGIN_FILE_HINT = `a file of the plugin is read through pluginFile(path) from "${PLUGINS_SPECIFIER}"`;

// import.meta、__dirname、__filename 的统一错误文本；具体位置由调用方拼上。
/** The error of a script using `import.meta`, `__dirname` or `__filename`. */
const NO_MODULE_IDENTITY = `import.meta.url, __dirname and __filename are not available in a plugin script (${PLUGIN_FILE_HINT})`;

// 找出构建产物里所有自由 __dirname/__filename 标记，并映射回源码位置。
// 输入：内联 source map 的脚本；输出：错误字符串数组（每个标记一条）。
// 没有标记或没有映射时返回空数组；findEntry 的行列从 0 开始。
// 例：源码里一处 __dirname 会得到 `worker.ts:3:5: import.meta.url, __dirname ...`。
/**
 * The errors for every free `__dirname` and `__filename` in the built `source` (their markers), each at its file, line
 * and column through the script's source map.
 */
function freeGlobals(source: string): string[] {
	// Most scripts have none: no map parsed for them.
	// 绝大多数脚本不使用这些全局变量；先做字符串包含检查，避免为它们解析 source map。
	if (!source.includes("__chord_plugin_")) return [];
	const map = inlineSourceMap(source);
	if (map === undefined) return [];
	const errors: string[] = [];
	// entries() 给出 0 基行号与行文本；matchAll 要求正则带 g，逐个给出每个标记的列号。
	for (const [line, text] of source.split("\n").entries()) {
		for (const match of text.matchAll(/__chord_plugin_(?:dirname|filename)/g)) {
			// findEntry 用 0 基行列查映射；返回条目可能没有 originalSource，下面用 in 收窄。
			const entry = map.findEntry(line, match.index);
			if (!("originalSource" in entry)) continue;
			errors.push(
				// 输出位置转回 1 基，并沿用 describe 的 file:line:column 格式。
				`${entry.originalSource}:${entry.originalLine + 1}:${entry.originalColumn + 1}: ${NO_MODULE_IDENTITY}`,
			);
		}
	}
	return errors;
}

// 文件位置分类：本插件源码/包、同根另一目录插件的文件（复制）、插件自己的 node_modules 包、其他根的插件、外部。
// 它由真实路径计算，是导入规则判断“能不能读”的依据。
/**
 * Where a resolved file lies (a real path), from the plugin being built: its own source, another plugin's of its root (a
 * copy), a package of its own `node_modules`, a plugin of another root, or no plugin.
 */
type Place =
	| { readonly kind: "own" }
	| { readonly kind: "copied"; readonly plugin: Plugin }
	| { readonly kind: "package" }
	| { readonly kind: "other-root"; readonly plugin: Plugin }
	| { readonly kind: "outside" };

// 规则解析说明符后的结论：保持外部、交给 esbuild 解析包、得到一个需要检查的路径（可能作为资源），或直接报错。
/** What an import resolves to before the rules check the file: external, refused, a package, or a plugin file. */
type Resolution =
	| { readonly kind: "external" }
	| { readonly kind: "package" }
	| { readonly kind: "path"; readonly path: string; readonly asset: boolean }
	| { readonly kind: "error"; readonly text: string };

// 只有浏览器构建能导入样式表和 wasm；Node 构建在 onResolve 中用扩展名拒绝。
/** What only a browser build imports: stylesheets and wasm assets. */
const BROWSER_ONLY = new Set([".css", ".wasm"]);

// 规则自己调用 builder.resolve 时传入的 pluginData 标记；再次进入 onResolve 时据此跳过判断，避免递归与重复检查。
/** Marks esbuild's resolution the rules ask for themselves, so they do not judge it again. */
const RESOLVING = Symbol("chord.plugins.resolving");

// 插件源码扩展名到 esbuild loader 的映射；包内文件不使用这张表，由 esbuild 按包的规则加载。
/** How the source files a build reads are loaded, by extension (packages load as esbuild decides). */
const LOADERS: Readonly<Record<string, Loader>> = {
	".ts": "ts",
	".mts": "ts",
	".cts": "ts",
	".tsx": "tsx",
	".js": "js",
	".mjs": "js",
	".cjs": "js",
	".jsx": "jsx",
	".json": "json",
	".css": "css",
	".wasm": "file",
};

// 资源导入的 pluginData 标记：让 onLoad 知道必须用 file loader，而不是按扩展名加载源码。
/** What an asset import's resolution carries to its load (the `file` loader whatever its extension). */
const ASSET = Symbol("chord.plugins.asset");

// Chord 自身的包名；有应用 API 时插件只能经 API 使用它，唯一例外是 /plugins 的 pluginFile。
/** Chord's package: never imported by plugins of an app with an API (only its `/plugins` for `pluginFile`). */
const CHORD_PACKAGE = "@earendil-works/chord";

// 一次构建的导入规则，同时是 esbuild 插件和结果收集器。
// 职责：解析每个说明符、检查目标文件、读取并哈希插件源码、作用域化 CSS module、记录复制文件与 API 版本。
// 生命周期只覆盖一次 buildFacet；#manifests/#listed 缓存避免同一 package.json 被重复读取。
/**
 * The import rules of one build (§2's table, slice 12 §1-§4) as an esbuild plugin, and what the build read: every file
 * of a plugin hashed as it is handed to esbuild (the exact bytes built, not a later read racing a save), the copied
 * files, the importer of each file (for the chain a per-kind refusal names) and the API versions imported.
 */
class ImportRules {
	// 暴露给 esbuild 的插件对象；其他字段都是私有状态。
	readonly plugin: EsbuildPlugin;
	readonly #own: Plugin;
	// 被构建的插件记录；facet 入口、依赖列表、external 和根目录都来自它。
	readonly #kind: string;
	/** The facet file's real path. */
	// 当前构建的种类；用于每种类文件检查和错误文本。
	readonly #entry: string;
	/** The plugin's own packages' directory: every package file inlined lies in it. */
	// 入口的真实路径；onResolve 对 entry-point 直接返回它，避免 esbuild 再次按路径解析。
	readonly #modules: string;
	/** The other directory plugins: a single-file plugin's files are no one's to import. */
	// 插件自己的 node_modules 绝对路径；判断“包文件”和向上查找 package.json 都以它为边界。
	readonly #others: readonly Plugin[];
	readonly #options: BuildOptions;
	// 同一 root 内其他目录插件；单文件插件被排除，因为它们的文件不能按相对路径复制。
	readonly #hostPackages: ReadonlySet<string>;
	readonly #inputs = new Map<string, string>();
	// 宿主包说明符集合；external 检查与 API kind 可用性都查它。
	readonly #copied = new Set<string>();
	// 实际读取的插件文件 -> 内容哈希；onLoad 里填充，inputs() 输出排序后的数组。
	/** The scoped stylesheet of every CSS module read, by its file. */
	// 被复制的其他插件文件集合；用于 built.copied 和复制的导入限制。
	readonly #scoped = new Map<string, string>();
	/** The first importer of every file resolved, by file. */
	// CSS module 文件 -> 作用域化后的 CSS 文本；虚拟命名空间的 onLoad 从这里取内容。
	readonly #importers = new Map<string, string>();
	/** The API versions imported, each with its first importer. */
	// 每个已解析文件的首个导入者；种类错误需要沿导入链回溯，这里保存边。
	readonly #versions = new Map<string, string>();
	/** Whether a directory of a package has a `package.json`, and whether it has a `chord` field, by directory. */
	// 已导入的 API 版本 -> 首个导入者；用于 mixedVersions 的错误消息。
	readonly #manifests = new Map<string, Promise<"chord" | "plain" | "none">>();
	/** The plugin folders a `chord` package lists, by its directory. */
	// package.json 读取缓存：目录 -> Promise<chord/plain/none>，避免同一目录在多个文件解析时重复读盘。
	readonly #listed = new Map<string, Promise<ReadonlySet<string>>>();
	readonly #context: Context;
	// chord.plugins 清单缓存：目录 -> 该包列出的插件真实目录集合；由 discoverPackage 负责解释清单。

	// 构建上下文；缓存里的异步发现需要它来响应中止。
	// 构造函数只保存配置并创建 esbuild 插件对象，不读盘；真正的解析发生在 build 运行时。
	constructor(own: Plugin, kind: string, entry: string, options: BuildOptions, context: Context) {
		this.#context = context;
		this.#own = own;
		this.#kind = kind;
		this.#entry = entry;
		this.#modules = join(own.dir, "node_modules");
		// 排除自身和单文件插件：同根复制只针对其他有目录的插件；dir 已由发现阶段 realpath。
		this.#others = (options.plugins ?? []).filter((each) => each.dir !== own.dir && each.layout === "directory");
		this.#options = options;
		// 用 Set 加速宿主包判断，同时保留原数组用于其他用途。
		this.#hostPackages = new Set(options.hostPackages);
		// esbuild 插件名只用于调试；setup 注册两个钩子，下面分别解释。
		this.plugin = {
			name: "chord-plugin-imports",
			setup: (builder) => {
				builder.onResolve({ filter: /.*/ }, async (args) => {
					// CSS module 的虚拟模块请求形如 chord-css-module:<绝对文件>；把它转到独立命名空间，path 去掉前缀。
					if (args.path.startsWith(`${SCOPED_CSS}:`)) {
						return { path: args.path.slice(SCOPED_CSS.length + 1), namespace: SCOPED_CSS };
					}
					// The plugin's files are resolved here, the entry too: esbuild then gives them no Node module type
					// (`"type": "module"`), whose interop would read a whole host package for a default import instead
					// of honouring the `__esModule` an ESM namespace is wrapped with (§3).
					// 入口直接返回已检查的真实路径；这样 esbuild 不会按包的 "type":"module" 赋予模块类型，避免默认导入的 interop
					// 误读整个宿主包，而忽略 ESM 命名空间包装上的 __esModule。
					if (args.kind === "entry-point") return { path: this.#entry };
					// 规则自己调用 builder.resolve 时 pluginData 为 RESOLVING；此时返回 undefined，交回 esbuild 的默认解析器。
					if (args.pluginData === RESOLVING) return undefined;
					// 先由纯规则判断这个说明符；返回值不是 Promise，便于在钩子里同步短路。
					const resolved = this.#resolve(args.path, args.importer, args.kind);
					// 规则拒绝时直接返回 esbuild 错误对象，错误文本已经包含插件文件位置。
					if (resolved.kind === "error") return { errors: [{ text: resolved.text }] };
					// 外部依赖保留原说明符；求值器的 require 负责加载。
					if (resolved.kind === "external") return { path: args.path, external: true };
					// 需要 esbuild 解析时调用 builder.resolve；对包使用原说明符，对路径使用规则给出的路径。
					// pluginData 防止再次进入本钩子；resolveDir/importer 保持导入方的解析基准。
					const found = await builder.resolve(resolved.kind === "path" ? resolved.path : args.path, {
						kind: args.kind,
						importer: args.importer,
						resolveDir: args.resolveDir,
						pluginData: RESOLVING,
					});
					// 解析失败（包不存在、exports 不允许该子路径等）原样交给 esbuild 报告。
					if (found.errors.length > 0) return { errors: found.errors };
					// A module a package's `browser` field disables: as esbuild resolved it.
					// 非 file 命名空间可能是包 browser 字段映射到的空模块等，规则不介入，直接采用 esbuild 的结果。
					if (found.namespace !== "file") return found;
					// esbuild resolves links: `found.path` is the real file.
					// 包导入（node_modules 内）需要额外检查：解析结果必须仍在插件自己的 node_modules 内。
					if (resolved.kind === "package") {
						// #place 基于真实路径；不在 package 区域说明包通过符号链接等方式指向了插件外部。
						if (this.#place(found.path).kind !== "package") {
							const at = this.#shown(found.path);
							return {
								errors: [{ text: `"${args.path}": resolves outside the plugin's node_modules (${at})` }],
							};
						}
						// 如果这个包本身是插件代码（有 chord 字段或被上层清单列出），它的文件仍受种类规则约束；
						// 普通库可以随意命名文件（例如 pdf.worker.mjs），不能按种类名误判。
						// A package that is plugin code (a `chord` field: a plugin, or a repository of several) keeps
						// the per-kind rule; an ordinary library names its files as it likes (`pdf.worker.mjs`).
						const code = await this.#pluginCode(found.path);
						if (code !== undefined) {
							// 记录插件包文件的首个导入者，供 #checkKind 构造导入链。
							if (!this.#importers.has(found.path)) this.#importers.set(found.path, args.importer);
							// code.top 是包的顶层目录（若文件就在那里），用于识别顶层 facet 文件名。
							const refused = this.#checkKind(found.path, args.path, code.top);
							if (refused !== undefined) return { errors: [{ text: refused }] };
						}
						// 原样返回 esbuild 的路径/sideEffects/suffix，保留它的 tree-shaking 与 ?query 信息。
						return { path: found.path, sideEffects: found.sideEffects, suffix: found.suffix };
					}
					// 非包文件：记录首个导入者（入口自身除外），用于错误链；然后检查种类、平台与归属。
					if (found.path !== this.#entry && !this.#importers.has(found.path)) {
						this.#importers.set(found.path, args.importer);
					}
					const refused = this.#checkKind(found.path, args.path);
					if (refused !== undefined) return { errors: [{ text: refused }] };
					// 样式表和 wasm 只允许浏览器构建；这里用扩展名而不是 loader 判断，避免依赖包内文件。
					if (options.platform === "node" && BROWSER_ONLY.has(extname(found.path))) {
						return { errors: [{ text: `"${args.path}": stylesheets and assets are for browser builds` }] };
					}
					// #checkFile 判断文件是否在允许的插件范围内，并把同根其他插件的文件记为 copied。
					const checked = this.#checkFile(found.path, args.importer, args.path);
					if (checked !== undefined) return { errors: [{ text: checked }] };
					// 资源导入带上 ASSET 标记，onLoad 据此强制 file loader。
					return { path: found.path, pluginData: resolved.asset ? ASSET : undefined };
				});
				// onLoad 负责提供内容：虚拟 CSS 命名空间、插件源码、资源，或交回 esbuild（包内文件）。
				builder.onLoad({ filter: /.*/ }, async (args) => {
					// 已作用域化 CSS 以普通 css loader 加载；resolveDir 指向原 module 文件，使 url()/@import 相对它解析。
					if (args.namespace === SCOPED_CSS) {
						// Its `url()` and `@import` resolve relative to the module file.
						return { contents: this.#scoped.get(args.path) ?? "", loader: "css", resolveDir: dirname(args.path) };
					}
					// 其他命名空间（包括包内文件）不在这里加载，返回 undefined 使用 esbuild 默认行为。
					if (args.namespace !== "file") return undefined;
					// 资源标记与扩展名共同决定 loader；资源一律 file，源码按 LOADERS 查表。
					const asset = args.pluginData === ASSET;
					const loader = asset ? "file" : LOADERS[extname(args.path)];
					// 未知扩展名或包内文件交回默认 loader；插件文件中的未知扩展名最终由 esbuild 的默认行为决定。
					if (loader === undefined || this.#place(args.path).kind === "package") return undefined;
					// 读取原始字节而不是文本：哈希必须对应 esbuild 实际拿到的内容，二进制资源也能保持原样。
					const contents = await readFile(args.path);
					// 在交给 esbuild 的同一时刻计算哈希，避免“构建后再读一次”与编辑器保存竞争导致 watcher 记录错内容。
					this.#inputs.set(args.path, createHash("sha256").update(contents).digest("hex"));
					// CSS module 走独立作用域化流程；普通 CSS 直接以 css loader 返回。
					if (!asset && args.path.endsWith(".module.css")) return this.#cssModule(args.path, contents);
					// resolveDir 让相对 url()/@import 以当前文件为基准。
					return { contents, loader, resolveDir: dirname(args.path) };
				});
			},
		};
	}

	/**
// 把一个 CSS module 变成 facet 可导入的 JS 模块。
// 输入：文件绝对路径与读取到的字节；输出：OnLoadResult，内容是 import 作用域化 CSS 并默认导出类名映射。
// 副作用：运行一次独立 esbuild 构建（scopeCssModule），并把 CSS 文本存入 #scoped 供虚拟命名空间加载。
// 错误：CSS 语法错误会使 scopeCssModule 拒绝，esbuild 会把该 onLoad 错误并入构建失败。
	 * The CSS module `file` with `contents` as the facet imports it: a module whose default export is the class mapping,
	 * importing the scoped stylesheet (`scopeCssModule`), which the build collects with the facet's other CSS.
	 */
	async #cssModule(file: string, contents: Uint8Array): Promise<OnLoadResult> {
		// 文本解码后作用域化；前缀包含插件名与相对路径，所以每个文件得到稳定的唯一类名。
		const scoped = await scopeCssModule(this.#own.name, this.#own.dir, file, new TextDecoder().decode(contents));
		this.#scoped.set(file, scoped.css);
		// 生成的 JS 同时导入样式表（副作用收集 CSS）并默认导出映射对象；JSON.stringify 保证路径和值被正确转义。
		// 这是模板字符串，内容按普通 JS 文本处理，不在这里插入注释。
		const module = `import ${JSON.stringify(`${SCOPED_CSS}:${file}`)};export default ${JSON.stringify(scoped.classes)};`;
		// resolveDir 指向模块文件，使生成模块中的相对解析与源文件一致。
		return { contents: module, loader: "js", resolveDir: dirname(file) };
	}

	/** Every plugin file read, sorted by path. */
	// 输出本次构建读取的插件文件并按路径排序；排序保证 watcher 与测试得到稳定的数组。
	inputs(): BuildInput[] {
		return [...this.#inputs].map(([file, hash]) => ({ file, hash })).sort((a, b) => (a.file < b.file ? -1 : 1));
	}

	/** The other plugins' files inlined, sorted. */
	// 输出被复制的其他插件文件（排序）；集合去重，因为一个文件可能被多处导入。
	copied(): string[] {
		return [...this.#copied].sort();
	}

	/** The API version the script imports, if it imports one (one version: `mixedVersions` refuses two). */
	// 返回实际导入的唯一 API 版本；混合版本会被 mixedVersions 拒绝，因此正常构建最多一个。
	version(): string | undefined {
		return [...this.#versions.keys()][0];
	}

	/**
	 * Why the facet file `named` (its real path `entry`) may not be built: a link out of the plugin (a single-file
	 * plugin's out of its root's top), or to a file of another kind; `undefined` when it may.
	 */
	// 检查 facet 入口本身：真实文件必须属于本插件（单文件插件则必须在根顶层），且不能链接到另一各种类的文件。
	// 返回错误文本或 undefined；命名使用用户写的 facet 文件名，而不是链接目标。
	checkEntry(named: string, entry: string): string | undefined {
		// 目录插件的入口必须在插件目录内部；单文件插件的 dir 是根目录，入口只需与根目录同级。
		const own = this.#own.layout === "file" ? dirname(entry) === this.#own.dir : inside(this.#own.dir, entry);
		if (!own) return `${basename(named)}: the facet file links out of its plugin (${entry})`;
		// #kindOf 根据文件基名判断每种类文件；未知种类或与当前 kind 相同都允许（后者是正常 facet）。
		const fileKind = this.#kindOf(entry);
		if (fileKind === undefined || sameKind(fileKind, this.#kind)) return undefined;
		return `${basename(named)}: links to a ${fileKind} file (${this.#shown(entry)}), not a ${this.#kind} facet`;
	}

	/** The error of a facet importing two API versions (both named with an importer), or `undefined`. */
	// 同一 facet 导入多个 API 版本时生成错误。
	// options.api! 的非空断言成立：版本只在 #apiImport 见到 api 时记录，因此有版本就一定有 api。
	mixedVersions(): string | undefined {
		if (this.#versions.size < 2) return undefined;
		const name = this.#options.api!.name;
		// 按版本名排序，让错误文本稳定；每个版本附上首个导入者路径。
		const seen = [...this.#versions]
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([version, importer]) => `${name}/${version} (${this.#shown(importer)})`);
		// 错误明确列出所有被导入的版本及导入它们的文件，便于找到两处冲突 import。
		return `one facet imports one version of ${name}: this one imports ${seen.join(" and ")}`;
	}

	/**
	 * What an import of `specifier` from `importer` becomes: external, refused, a package esbuild resolves (one of the
	 * plugin's `dependencies`, or anything a package imports) or a path esbuild resolves and the rules check.
	 */
	// 纯解析规则：给定说明符、导入方和导入种类，决定外部、包、待检查路径或错误。
	// 这个函数不读盘、不调用 esbuild；只有包的最终位置和路径检查发生在 onResolve 的后续步骤。
	#resolve(specifier: string, importer: string, kind: string): Resolution {
		const browser = this.#options.platform === "browser";
		// 字面量或计算出的 dynamic-import 若仍以这个 kind 到达，直接拒绝；计算形式的降级与运行时处理见上面的 supported。
		if (kind === "dynamic-import") {
			return {
				kind: "error",
				text: `import("${specifier}"): a plugin script has no dynamic import (${PLUGIN_FILE_HINT})`,
			};
		}
		// 本组件的 pluginFile 是唯一允许的 Chord 导入，保持外部，由求值器按 facet 回答。
		if (specifier === PLUGINS_SPECIFIER) return { kind: "external" };
		// 先做应用 API 检查；命中时返回 external 或错误，未命中返回 undefined 继续普通规则。
		const api = this.#apiImport(specifier, importer);
		if (api !== undefined) return api;
		// 普通宿主包保持外部。
		if (this.#hostPackages.has(specifier)) return { kind: "external" };
		// 单文件插件只允许宿主包（和应用 API），不能有自己的文件、包或内置模块；错误提示改成目录插件的名字。
		if (this.#own.layout === "file") {
			const directory = `${this.#own.name}/`;
			return {
				kind: "error",
				text: `"${specifier}": a single-file plugin imports only host packages (the app's API); make it a directory "${directory}" with a package.json`,
			};
		}
		// 导入方所在位置：本插件、复制文件、包或外部；复制文件有更严格的导入规则。
		const from = this.#place(importer);
		// A copied file (another plugin's) imports host packages and its own plugin's files only: no builtins either.
		// 宿主包已在上面放行；这里拒绝复制文件导入的其余裸说明符（包括 Node 内置模块、依赖包和 chord.external），
		// 只允许它继续用相对或绝对路径导入自己插件的文件。
		if (from.kind === "copied" && !specifier.startsWith(".") && !isAbsolute(specifier)) {
			return { kind: "error", text: `"${specifier}": ${copiedRule(from.plugin)}` };
		}
		// Node 构建允许内置模块并保持外部；浏览器构建拒绝。isBuiltin 是运行时检查。
		if (isBuiltin(specifier)) {
			if (!browser) return { kind: "external" };
			return { kind: "error", text: `"${specifier}": a Node builtin in a browser build` };
		}
		// ?url 只在浏览器构建中表示资源；Node 构建给出带 pluginFile 提示的错误。
		if (specifier.endsWith("?url")) {
			if (browser) return { kind: "path", path: specifier.slice(0, -"?url".length), asset: true };
			return { kind: "error", text: `"${specifier}": assets by URL are for browser builds (${PLUGIN_FILE_HINT})` };
		}
		// 包内文件的导入不重新套用插件依赖规则；它已经属于被允许的包。
		if (from.kind === "package") return { kind: "package" };
		// A stylesheet's `url()` names an asset of the plugin (served under `publicPath`).
		// CSS 的 url() 在浏览器构建中要作为资源处理；其他相对导入按路径检查。
		const asset = kind === "url-token" && browser;
		// 相对或绝对路径返回 path，交给 esbuild 解析后再检查归属；asset 决定 loader。
		if (specifier.startsWith(".") || isAbsolute(specifier)) return { kind: "path", path: specifier, asset };
		// 裸说明符提取包名（含子路径时只看包名），用于 external/dependencies 判断。
		const name = packageName(specifier);
		// chord.external 包在 Node 构建保持外部、运行时从插件 node_modules 加载；浏览器构建不允许。
		if (this.#own.external.includes(name)) {
			if (!browser) return { kind: "external" };
			return { kind: "error", text: `"${specifier}": chord.external packages are for Node builds` };
		}
		// 只有 package.json dependencies 中声明的包才允许导入并内联。
		if (this.#own.dependencies.includes(name)) return { kind: "package" };
		// 其余说明符给出同时指出宿主包与 dependencies 的拒绝信息。
		return {
			kind: "error",
			text: `"${specifier}": neither a host package nor in the dependencies of plugin "${this.#own.name}"`,
		};
	}

	/**
	 * An import of the app's API or of Chord when the app has an API (slice 12 §1): a listed version the kind provides
	 * is external (its version recorded); an unlisted version, a module the kind lacks and Chord itself are refused.
	 * `undefined` for any other specifier.
	 */
	// 应用 API 专用规则：只处理与 api.name 相同或以它开头的说明符。
	// 允许情况：版本在 api.versions 中，且该具体模块说明符在 hostPackages 中（即当前 kind 提供它），保持外部并记录版本。
	// 拒绝情况：直接导入 Chord、没有版本段、版本未列出、当前 kind 不提供该模块。
	#apiImport(specifier: string, importer: string): Resolution | undefined {
		const api = this.#options.api;
		// 没有配置应用 API 时，这条规则不生效，普通 hostPackages 规则接管。
		if (api === undefined) return undefined;
		// 错误文本展示最新版本，提示插件应通过 API 而不是 Chord 直接交互。
		const newest = `${api.name}/${api.versions[0]}`;
		// packageName 让 @earendil-works/chord 的子路径也命中；唯一例外已在本函数之前由 PLUGINS_SPECIFIER 返回。
		if (packageName(specifier) === CHORD_PACKAGE) {
			return {
				kind: "error",
				text: `"${specifier}": plugins import Chord through the app's API ("${newest}"), never directly`,
			};
		}
		// 只处理应用 API 包及子路径；其他包（包括名字前缀相似者）返回 undefined。
		if (specifier !== api.name && !specifier.startsWith(`${api.name}/`)) return undefined;
		const provided = `this app provides ${api.versions.join(", ")}`;
		// 取出第一个路径段作为版本；非空断言用于类型，空串在下一行显式拒绝。
		const version = specifier.slice(api.name.length + 1).split("/")[0]!;
		if (version === "") {
			return { kind: "error", text: `"${specifier}": import a version of the app's API (${provided})` };
		}
		// 版本必须列在 api.versions 中；includes 是运行时数组检查。
		if (!api.versions.includes(version)) {
			return { kind: "error", text: `"${specifier}": ${api.name}/${version} is not available: ${provided}` };
		}
		// 版本存在还不够，当前 facet 种类必须真的提供这个模块；hostPackages 是本次构建（当前 kind）可用的
		// 宿主包说明符列表，因此这里检查的是该 kind 的模块是否在列。
		if (!this.#hostPackages.has(specifier)) {
			return { kind: "error", text: `"${specifier}": not available to ${this.#kind} facets` };
		}
		// 只记录每个版本的首个导入者，供 mixedVersions 错误显示。
		if (!this.#versions.has(version)) this.#versions.set(version, importer);
		return { kind: "external" };
	}

	/**
	 * Why the plugin file `path` (not a package's: npm packages name files as they like, `pdf.worker.mjs`) may not be
	 * in a facet of this kind: a per-kind file (`contract.web.tsx`) or a facet file (`web.tsx`) of another kind, named
	 * with the chain of imports that reached it; `undefined` when it may.
	 */
	// 检查插件文件是否属于其他种类。
	// 只对插件文件调用：普通 npm 包可以命名为 pdf.worker.mjs，不能按“点分种类”误判。
	// 错误文本包含从入口到该文件的导入链，帮助定位。
	#checkKind(path: string, specifier: string, packageTop?: string): string | undefined {
		const fileKind = this.#kindOf(path, packageTop);
		// 未知种类或与当前种类相同则允许；种类比较忽略大小写。
		if (fileKind === undefined || sameKind(fileKind, this.#kind)) return undefined;
		// #chainOf 返回从入口到该文件的路径数组（可能因环而截断），#shown 转成相对插件目录的显示路径。
		const chain = this.#chainOf(path)
			.map((file) => this.#shown(file))
			.join(" → ");
		return `"${specifier}": a ${fileKind} file, imported into a ${this.#kind} facet (${chain})`;
	}

	/**
	 * The kind of the plugin file `path`, one of the app's kinds (compared without case): a name `<name>.<kind>.<ext>`,
	 * or a facet file `<kind>.<ext>` at the top of a directory plugin (or of the plugin package `packageTop`).
	 */
	// 推导插件文件的种类：
	// 1) 文件名至少三段且倒数第二段是 kind（contract.web.tsx -> web）；
	// 2) 文件名两段且位于目录插件（或插件包顶层）的顶层（web.tsx -> web）。
	// 包内普通文件由调用方跳过，因此“pdf.worker.mjs”不会被当作 worker 文件。
	#kindOf(path: string, packageTop?: string): string | undefined {
		// 按点拆分基名；扩展名也占一段，所以 `<name>.<kind>.<ext>` 至少三段。
		const parts = basename(path).split(".");
		const kinds = this.#options.kinds ?? [];
		// 倒数第二段才是种类；parts[len-2]! 的非空断言只用于类型，长度已检查。
		if (parts.length >= 3) return kinds.find((kind) => sameKind(kind, parts[parts.length - 2]!));
		// 顶层 facet 文件（两段）只认插件目录顶层或插件包顶层；packageTop 由 #pluginCode 提供。
		const top =
			dirname(path) === packageTop ||
			[this.#own, ...this.#others].some((each) => each.layout === "directory" && dirname(path) === each.dir);
		// 恰好两段且位于顶层才可能是 `<kind>.<ext>`；some 检查本插件和所有同根目录插件。
		return parts.length === 2 && top ? kinds.find((kind) => sameKind(kind, parts[0]!)) : undefined;
	}

	/** The files from the entry to `file`, by their first importers; an import cycle ends the walk. */
	// 沿 #importers 从文件回溯到入口，返回从入口到文件的链。
	// 用 seen 防止导入环导致死循环；环上的链在重复文件处停止。
	#chainOf(file: string): string[] {
		const chain = [file];
		const seen = new Set(chain);
		// for 的初始化取首个导入者，每轮跳到它的导入者；条件同时检查 undefined 与已见，避免重复。
		for (let at = this.#importers.get(file); at !== undefined && !seen.has(at); at = this.#importers.get(at)) {
			seen.add(at);
			chain.unshift(at);
			// 每回溯一步把导入者放到链首，最终顺序是入口 -> ... -> file。
		}
		return chain;
	}

	/** `file` as an error names it: relative to the plugin's directory. */
	// 将绝对路径显示为相对插件目录的 / 路径，跨平台错误文本一致。
	#shown(file: string): string {
		return relative(this.#own.dir, file).split(sep).join("/");
	}

	/**
	 * Why the plugin file `path` (resolved from `importer`'s import of `specifier`) may not be inlined: outside the
	 * plugin's root, in no plugin of it, or, from a copied file, outside that file's own plugin; `undefined` when it may
	 * (another plugin's file of the root is recorded as copied).
	 */
	// 检查解析后的文件能否内联，并记录复制文件。
	// 允许：本插件自己的文件；同根另一插件的文件（记为 copied）。
	// 拒绝：复制文件再导入其他插件、根内但不属于任何插件、其他根/外部文件；错误会提示应通过宿主包或依赖访问。
	#checkFile(path: string, importer: string, specifier: string): string | undefined {
		const from = this.#place(importer);
		const to = this.#place(path);
		// 本插件到本插件：正常源码，允许。
		if (to.kind === "own" && from.kind === "own") return undefined;
		// 复制文件只能来自本插件；多个同根插件互相导入时，每个文件的复制身份不能跨插件传递。
		// 记录 copied 供 built.copied 与后续规则使用。
		if (to.kind === "copied" && (from.kind === "own" || (from.kind === "copied" && from.plugin === to.plugin))) {
			this.#copied.add(path);
			return undefined;
		}
		if (from.kind === "copied") return `"${specifier}": ${copiedRule(from.plugin)}`;
		// 根内但不是任何插件目录的文件（例如根下的共享脚本）不允许直接导入；共享契约应通过插件/依赖提供。
		if (to.kind === "outside" && inside(this.#own.root, path)) {
			return `"${specifier}": not a file of a plugin in this root`;
		}
		// 其他根和外部文件的错误区分是否有应用 API：有 API 时提示通过最新 API 版本，否则提示宿主包。
		const api = this.#options.api;
		const base = api === undefined ? "a host package" : `the app's API ("${api.name}/${api.versions[0]}")`;
		return `"${specifier}": outside the plugin's root (base code is reached through ${base}, other repositories' plugins through dependencies)`;
	}

	/**
	 * Whether the package file `path` is plugin code: its nearest `package.json` (walking up to the plugin's
	 * `node_modules`) has a `chord` field, or is a plugin folder the next `package.json` above lists in its
	 * `chord.plugins` (a plugin of a repository of several, reached as a dependency); a library (even one nested in a
	 * plugin package) is not. `top` the file's own directory when that is the package's (a facet file there is of its
	 * kind). `undefined` for a library.
	 */
	// 判断 node_modules 内的文件是否属于“插件代码”，从而决定是否套用每种类文件规则。
	// 做法：从文件目录向上走到插件 node_modules 边界，找到最近的两个 package.json：
	// - 最近的是 chord 包 -> 插件代码；
	// - 最近的是普通包，再上一层的 chord.plugins 清单列出它 -> 多插件仓库中的插件，也是插件代码；
	// - 否则是普通库（即使嵌在插件包内）。
	// 返回 top：文件所在目录正好是包的顶层时给出该目录，用于识别顶层 facet 文件名；普通库返回 undefined。
	async #pluginCode(path: string): Promise<{ readonly top: string | undefined } | undefined> {
		let nearest: string | undefined;
		// 只向上走到 node_modules 边界内；dir 每轮变成父目录，最终会离开 modules 而结束。
		for (let dir = dirname(path); inside(this.#modules, dir); dir = dirname(dir)) {
			// 读缓存后的 manifest 分类；none 表示该层没有 package.json，继续向上。
			const manifest = await this.#manifestIn(dir);
			if (manifest === "none") continue;
			// 最近一个 manifest 是 chord 包：直接是插件代码；top 只在文件位于包顶层时设置。
			if (nearest === undefined && manifest === "chord") return { top: dir === dirname(path) ? dir : undefined };
			// 最近的是普通包：先记住它，继续找上一层清单，看它是否被列为插件文件夹。
			if (nearest === undefined) {
				nearest = dir;
				continue;
			}
			// 第二层 manifest 必须是 chord 包，且其 chord.plugins 列出的真实目录包含最近包；否则整个文件属于普通库。
			if (manifest === "plain" || !(await this.#listedIn(dir)).has(nearest)) return undefined;
			// 确认是仓库中的插件；top 同样只在文件位于该插件包顶层时设置。
			return { top: nearest === dirname(path) ? nearest : undefined };
		}
		return undefined;
	}

	/** The plugin folders the package in `dir` lists in `chord.plugins` (discovery's reading of it; once per build). */
	// 读取并缓存一个包的 chord.plugins 所列插件目录集合。
	// 复用 discoverPackage（与运行时相同的解释），把结果转成真实目录 Set；每目录只计算一次。
	#listedIn(dir: string): Promise<ReadonlySet<string>> {
		let listed = this.#listed.get(dir);
		if (listed === undefined) {
			// 发现时把该包自己当作根；required 为 false，只关心列出的插件目录。
			const at = { root: dir, required: false, kinds: this.#options.kinds ?? [] };
			listed = discoverPackage(dir, at, this.#context).then(({ plugins }) => new Set(plugins.map(({ dir }) => dir)));
			this.#listed.set(dir, listed);
		}
		return listed;
	}

	/** What `dir`'s `package.json` is: absent, without a `chord` field, or with one (read once per build). */
	// 读取并缓存目录下 package.json 的 chord 字段分类。
	// 文件不存在 -> none；JSON 解析失败 -> plain（库）；有 chord 字段 -> chord。
	// 只关心字段是否存在，不在这里验证 chord 的内容。
	#manifestIn(dir: string): Promise<"chord" | "plain" | "none"> {
		let read = this.#manifests.get(dir);
		if (read === undefined) {
			// readFile 的 Promise 链：成功分支解析 JSON，失败分支统一成 none；缓存的是 Promise，并发调用共享同一次读取。
			read = readFile(join(dir, "package.json"), "utf8").then(
				(text) => {
					try {
						// A trust boundary: a package's manifest, read only for its `chord` field.
						// JSON 顶层可能为 null；?.chord 容忍这种情况。任何解析错误都按普通库处理。
						return (JSON.parse(text) as { chord?: unknown } | null)?.chord !== undefined ? "chord" : "plain";
					} catch {
						return "plain";
					}
				},
				() => "none",
			);
			this.#manifests.set(dir, read);
		}
		return read;
	}

	/** Where `path` (a real path) lies; a package is one of the plugin's own `node_modules`, any other is outside. */
	// 按真实路径判断文件位置。
	// 顺序很重要：先看插件自己的 node_modules（包），再看本插件目录，再看其他插件目录并排除它们各自的 node_modules。
	// 应用本身可能安装在 node_modules 下，所以不能简单地说“路径含 node_modules 就是包”。
	#place(path: string): Place {
		// 插件自己的依赖包：允许导入并内联，但不套用插件每种类规则。
		if (inside(this.#modules, path)) return { kind: "package" };
		// 本插件目录内的文件：正常源码。
		if (inside(this.#own.dir, path)) return { kind: "own" };
		// Another plugin's own packages are no one's to import; a root may itself lie under a `node_modules` (an app
		// installed from npm with its plugins), so only the part below a plugin's directory counts.
		// 其他目录插件：必须在它的目录内，且不在它的 node_modules 内；后者属于那个插件自己的依赖，不是可复制的源码。
		const other = this.#others.find(
			(each) => inside(each.dir, path) && !inside(join(each.dir, "node_modules"), path),
		);
		if (other === undefined) return { kind: "outside" };
		// 同一 root 的文件可作为 copied 导入；其他 root 的插件文件被标记 other-root，随后由 #checkFile 拒绝。
		return other.root === this.#own.root ? { kind: "copied", plugin: other } : { kind: "other-root", plugin: other };
	}
}

/** Whether two kind names are the same kind: compared without case (`contract.Web.ts` is a web file). */
// 种类名比较忽略大小写，因此 Web.ts 与 web 被视为同一种类。
function sameKind(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

/** The rule a copied file broke. */
// 复制文件违反导入限制时的统一说明。
function copiedRule(plugin: Plugin): string {
	return `a file copied from plugin "${plugin.name}" may import only host packages and files of its own plugin`;
}

/** Whether `path` lies inside directory `dir` (both absolute). */
// 判断 path 是否严格位于 dir 内部（不包含 dir 本身）。
// 输入：绝对目录与路径；输出：布尔值；不读盘，只做路径运算。
// relative 返回空串表示同一路径，.. 开头或绝对路径表示不在内部；Windows 跨盘符会得到绝对路径。
export function inside(dir: string, path: string): boolean {
	const rest = relative(dir, path);
	return rest !== "" && !rest.startsWith("..") && !isAbsolute(rest);
}

/** One build error as `file:line:column: text`, its file relative to the plugin, with the hint where it applies. */
// 把 esbuild 的一条 Message 格式化成 `file:line:column: text`。
// 输入：被构建插件（用于相对路径）和 esbuild 消息；输出：错误字符串。
// 特别改写 empty-import-meta 与顶层 await 的默认文本；没有位置时只返回文本。
// 列号加一是因为 esbuild 的 column 从 0 开始；line 已是 1 基。
function describe(plugin: Plugin, message: Message): string {
	let text = message.text;
	// esbuild 用 id 标记已知错误类别；empty-import-meta 需要换成插件自己的完整提示。
	if (message.id === "empty-import-meta") {
		text = NO_MODULE_IDENTITY;
	} else if (text.startsWith("Top-level await")) {
		text = "a plugin script has no top-level await (a facet declares synchronously)";
	}
	// location 在 esbuild 类型中可能为 null 或 undefined；两者都表示没有源码位置。
	const location = message.location;
	if (location === null || location === undefined) return text;
	// 绝对路径转成相对插件目录；已经相对的路径（虚拟/生成的）保持原样。
	const file = isAbsolute(location.file) ? relative(plugin.dir, location.file) : location.file;
	return `${file}:${location.line}:${location.column + 1}: ${text}`;
}
