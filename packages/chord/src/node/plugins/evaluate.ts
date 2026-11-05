// Evaluating (slice 7c §3): a built script run with `vm.Script` in this context under a stable filename per (plugin,
// kind, digest), given the `require` that answers its external imports: the host packages (one instance per process),
// this component's `pluginFile` bound to the plugin's directory, and `chord.external` packages and Node builtins from
// the plugin's own `node_modules`. No module map and no cache: an old facet's closures are collected once nothing holds
// them.

// 本文件负责求值：把 build.ts 产出的脚本放进 Node 的 vm 执行，得到一个 Facet。
// 上游是 runtime.ts 的 prepare：构建成功后才调用 evaluateFacet；下游把 Facet 交给 LoadedFacets.load/reload，
// 由宿主运行 facet.setup。脚本里的 require 不是 Node 的普通 require，而是这里按插件规则构造的闭包，
// 因此宿主包、pluginFile、chord.external 包和内置模块的可见性都在本文件决定。
// 文件导读
// 所属模块：packages/chord/src/node/plugins 的求值层，把构建产物变成宿主可加载的 Facet。
// 职责边界：执行已构建脚本、按插件规则提供 require 与 pluginFile、校验默认导出形状；不发现文件、不构建、不调用
// facet.setup（那是宿主加载阶段的事），也不缓存模块。
// 上游入口：runtime.ts 的 prepare（生产路径）或 testing.ts 的 testPlugin（测试路径）调用 evaluateFacet。
// 下游依赖：build.ts 的 BuiltFacet、discover.ts 的 Plugin、stack.ts 的 registerScript、surfaces/registered.ts 的 interop；
// 执行环境是 Node 的 vm 与 createRequire。
// 结果与错误流向：成功返回 Facet；插件执行错误、无法回答的 require、非 facet 默认导出都抛给调用方，由 runtime
// 转成该插件的一条 PluginFailure，或由测试直接报错。
// 能力清单：
// - HostPackages：说明符到宿主模块实例的只读表。
// - EvaluateOptions：求值所需的宿主包和插件记录。
// - BuiltScript：BuiltFacet 中 kind 为 script 的分支，保证有 source/digest。
// - evaluateFacet(built, options)：执行脚本并返回 Facet。
// - pluginFile(path)：导出给插件代码的类型占位，实际由每次求值的 require 替换。
// - PLUGINS_SPECIFIER：本组件的说明符，构建时保持外部、求值时按 facet 回答。
// - packageName(specifier)：从裸说明符提取 npm 包名，供 external/chord 检查使用。
// 组合与顺序：evaluateFacet 内先建立包装函数，再用 requireFor 生成的 require 执行；requireFor 依次应用运行时 API
// 规则、宿主包、pluginFile、内置模块/chord.external；成功或抛错都以 facet/错误为 owner 登记堆栈映射。
// 示例：const facet = evaluateFacet(built, { hostPackages: { "@earendil-works/chord": chord }, plugin });
// 返回的对象满足 Facet<Principal>，随后由 LoadedFacets 交给宿主；示例不包含宿主创建过程。
// 建议阅读顺序：evaluateFacet -> requireFor/refusedAtRun（理解 require 规则）-> versionOf/packageName -> fileOf。
import { createRequire, isBuiltin } from "node:module";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Script } from "node:vm";
import type { Principal } from "../../data/index.ts";
import type { Facet } from "../../host/index.ts";
import { interop } from "../../surfaces/registered.ts";
import type { BuiltFacet } from "./build.ts";
import type { Plugin } from "./discover.ts";
import { registerScript } from "./stack.ts";

// 宿主包表：键是 import 说明符，值是本进程里已经加载的模块实例。多个插件拿到同一个实例，
// 所以插件之间用 instanceof 或模块级状态时不会因为重复加载而失效。Readonly<Record<...>> 只约束编译期。
/**
 * The host packages by specifier, each what Node's `require` would give: a CommonJS package's exports, an ESM
 * package's namespace (`import * as`), wrapped once so default and named imports both work.
 */
export type HostPackages = Readonly<Record<string, unknown>>;

// 求值选项：hostPackages 由调用方（服务器或 worker）提供；plugin 给出目录、布局、facet 文件名和 external 列表。
/** What `evaluateFacet` takes besides the script: the host packages and the plugin it was built from. */
export type EvaluateOptions = { readonly hostPackages: HostPackages; readonly plugin: Plugin };

// Extract<BuiltFacet, { kind: "script" }> 从可辨识联合中只取出构建成功的 script 分支；
// failed 分支没有 source，不能求值，类型系统在编译期就阻止把它传进来。
/** A built script, as evaluation takes it. */
export type BuiltScript = Extract<BuiltFacet, { readonly kind: "script" }>;

// 求值一个已构建的 facet 脚本。
// 输入：built（kind 为 script 的分支）和 options（宿主包与插件记录）。
// 输出：脚本默认导出的 Facet；副作用是执行插件代码，并把该脚本的 source map 登记到 stack.ts。
// 错误：脚本执行时抛出的任何值、require 无法回答的导入、默认导出不是 facet，都会向调用方抛出；
// 抛错前若值是对象，也登记脚本，使堆栈能映射回插件源码。
// 主要流程：生成稳定文件名 -> 编译并执行外层函数 -> 用 requireFor 提供的 require 调用包装函数 ->
// 读取 module.exports.default 并做运行时形状检查 -> 成功后以 facet 为存活凭证登记映射。
// 例子：evaluateFacet({ kind: "script", facet: "worker", source, digest, ... }, { plugin, hostPackages })
// 返回该 worker 的 facet；真实调用发生在宿主已存在、要加载或重载插件时。
/**
 * Evaluates `built` and returns its facet (its default export). Throws what the script throws while it is evaluated,
 * an import its `require` does not answer, or a declaration error when its default export is not a facet.
 */
export function evaluateFacet<P extends Principal = Principal>(built: BuiltScript, options: EvaluateOptions): Facet<P> {
	const { plugin, hostPackages } = options;
	// where 是错误前缀，包含插件名和种类，便于插件作者定位是哪个 facet 失败。
	const where = `plugin "${plugin.name}" (${built.facet})`;
	// 插件发现阶段记录了每种 facet 的文件；缺失时退回 `<kind>.js`，只是生成一个可读文件名，不影响执行。
	const file = plugin.facets[built.facet] ?? `${built.facet}.js`;
	// 文件名按“插件名/文件基名?摘要”生成：同一插件同一版本稳定，构建变化时摘要变化，堆栈里能区分新旧脚本。
	// 前面的 /chord-plugins/ 是虚拟路径，不对应磁盘文件。
	const filename = `/chord-plugins/${plugin.name}/${basename(file)}?${built.digest}`;
	// The script is one function expression: its value when run.
	// 构建产物是一个函数表达式（build.ts 的 banner/footer 包成 CommonJS 包装函数），runInThisContext 返回该函数。
	// as 只是告诉 TypeScript 三个参数的类型；插件代码此时还没有运行。runInThisContext 意味着插件与宿主同进程、
	// 可访问全局对象，并不是安全沙箱。
	const wrapper = new Script(built.source, { filename }).runInThisContext() as (
		require: (specifier: string) => unknown,
		module: { exports: unknown },
		exports: unknown,
	) => void;
	// 最小的 CommonJS module 对象；exports 的初始值同时作为第三个参数传给包装函数。
	const module = { exports: {} as unknown };
	let facet: unknown;
	try {
		// 执行插件模块体：require 的每次调用都经过 requireFor 的规则，module/exports 供 ESM 转换后的导出写入。
		wrapper(requireFor(plugin, built, hostPackages, where), module, module.exports);
		// 这里是信任边界：插件代码不受项目类型系统控制，默认导出必须做运行时检查；读取 getter 也可能抛错。
		// A trust boundary: plugin code; its default export is checked to be a facet (a getter of it may throw too).
		// 可选链 ?. 容忍 module.exports 为 null/undefined；断言只描述“可能有 default”的形状，不产生运行时转换。
		facet = (module.exports as { readonly default?: unknown } | null)?.default;
		// typeof 检查对象且非 null，并确认 setup 是函数；这不验证 setup 的签名或声明内容，那些由宿主加载阶段检查。
		if (typeof facet !== "object" || facet === null || typeof (facet as { setup?: unknown }).setup !== "function") {
			throw new Error(`${where}: its default export is not a facet (defineFacet)`);
		}
		// 执行期或形状检查的异常在这里捕获，为了登记堆栈映射后再原样抛出；不包装、不吞掉插件自己的错误。
	} catch (error) {
		// Its stack maps while the error lives (an import-time throw names the plugin's line).
		// 只有对象才能被 FinalizationRegistry 登记；原始值抛出时无法挂映射，直接重抛。
		// 把错误本身作为 owner：堆栈在错误对象存活期间都能映射。
		if (typeof error === "object" && error !== null) registerScript(filename, built.source, plugin.dir, error);
		throw error;
	}
	// 成功时以 facet 为 owner：映射随 facet 存活，facet 被卸载并由 GC 回收后自动从注册表删除。
	registerScript(filename, built.source, plugin.dir, facet);
	// 上面的运行时检查保证了形状；这里的 as Facet<P> 只是恢复泛型参数，没有运行时校验 Principal 类型。
	return facet as Facet<P>;
}

// 这个导出的 pluginFile 只是占位实现，供类型声明和直接导入时给出清晰错误；
// 真正的 pluginFile 由下面 requireFor 在求值每个 facet 时绑定到该插件目录。
// 输入：插件内相对路径；输出：绝对路径；错误：在 facet 之外调用总是抛错。
// 例子：插件代码里 pluginFile("schema.json")；未经过组件求值时这里会提示只能由 facet 脚本调用。
/**
 * Inside a facet script, the absolute path of `path`, a file of the facet's own plugin (`..` out of its directory
 * refused); evaluation gives each facet its own. Imported anywhere else, it throws.
 */
export function pluginFile(path: string): string {
	throw new Error(`pluginFile("${path}"): only a plugin's facet script, evaluated by the plugins component, has one`);
}

// 插件只允许从这一个说明符导入本组件的 pluginFile；build.ts 把它保持为外部依赖，运行时由 requireFor 回答。
/** The one specifier of this component a script imports (`pluginFile`): external always, answered per facet. */
export const PLUGINS_SPECIFIER = "@earendil-works/chord/plugins";

// 为某个插件的一次求值构造 require。
// 输入：plugin/built 决定规则与已声明的 API 版本；hostPackages 提供宿主实例；where 只用于错误文本。
// 输出：闭包 (specifier) => unknown；副作用是首次用到时创建 createRequire 和 pluginFile 对象并缓存。
// 错误：被运行时规则拒绝的说明符会抛错；底层包加载错误原样传播。
// 主要流程：先做运行时拒绝检查 -> 记录本次 require 暴露的 API 版本 -> 依次尝试宿主包、pluginFile、
// 单文件插件限制、内置模块/chord.external 包 -> 否则给出统一错误。
// 例子：require("@acme/app/v3/web") 可能返回宿主包；require("node:fs") 从插件目录的 require 加载；
// require("lodash") 若不在 dependencies 或 external 中则抛错（构建阶段通常已先拒绝静态导入）。
/**
 * The `require` a facet script of `plugin` takes (`where` names the facet in its errors). A computed `require(x)`
 * cannot be seen at build, so it refuses here what the build refuses to imports: another version of the app's API than
 * the script imports (or, when it imports none, than the first one it requires), Chord itself under an app's API, and
 * for a single-file plugin anything but host packages.
 */
function requireFor(
	plugin: Plugin,
	built: BuiltScript,
	hostPackages: HostPackages,
	where: string,
): (specifier: string) => unknown {
	// 两个缓存都用 ??= 惰性创建：只有真正 require 到相应类别时才建立 Node require 或 pluginFile 对象。
	// NodeJS.Require 是 @types/node 提供的 require 函数类型。
	let fromPlugin: NodeJS.Require | undefined;
	let plugins: { readonly pluginFile: (path: string) => string } | undefined;
	// The facet's API version: the one its build saw, else the first one required (one facet, one version).
	// built.api 是构建时记录的 API 名称与版本；没有应用 API 的插件为 undefined。
	let version = built.api?.version;
	return (specifier) => {
		// 计算出来的 require(x) 构建阶段看不到，因此在运行时再做一遍与构建相同的 API 拒绝规则。
		const refused = refusedAtRun(built, version, specifier);
		if (refused !== undefined) throw new Error(`${where}: "${specifier}": ${refused}`);
		// 第一次 require 到应用 API 时确定版本；??= 只在 version 仍是 undefined 时赋值，之后保持不变。
		version ??= versionOf(built, specifier);
		// Object.hasOwn 只看自有属性，避免 "toString" 之类原型链键被误当宿主包；interop 统一 ESM/CJS 的默认导入形状。
		if (Object.hasOwn(hostPackages, specifier)) return interop(hostPackages[specifier]);
		// 本组件的说明符不返回导出的占位函数，而是返回一个只含 pluginFile 的对象，闭包捕获当前 plugin。
		if (specifier === PLUGINS_SPECIFIER) {
			plugins ??= { pluginFile: (path) => fileOf(plugin, path) };
			return plugins;
		}
		// 单文件插件没有独立目录，除宿主包外不允许任何 require；这条也覆盖计算出来的 require。
		if (plugin.layout === "file") {
			throw new Error(`${where}: "${specifier}": a single-file plugin requires only host packages`);
		}
		// isBuiltin 运行时判断 Node 内置模块；packageName 把子路径归到包名，再查插件的 chord.external 列表。
		// createRequire 以插件的 package.json 为起点，因此依赖从插件自己的 node_modules 解析，而不是宿主的。
		if (isBuiltin(specifier) || plugin.external.includes(packageName(specifier))) {
			fromPlugin ??= createRequire(join(plugin.dir, "package.json"));
			return fromPlugin(specifier);
		}
		// 其余说明符一律拒绝；静态导入在构建期已有更详细的错误，这里是计算 require 的兜底。
		throw new Error(
			`${where}: "${specifier}" is not a host package, a Node builtin or one of its chord.external packages`,
		);
	};
}

// 运行时 API 规则，返回拒绝原因或 undefined。
// 规则一：有应用 API 的脚本不能再导入 Chord 本身；规则二：同一 facet 只能使用一个 API 版本。
// version 是此前已见到的版本，required 是本次说明符携带的版本；两者都存在且不同则拒绝。
/**
 * Why a script built against the app's API, using API `version` so far, may not require `specifier` (the build's API
 * rules), or `undefined`.
 */
function refusedAtRun(built: BuiltScript, version: string | undefined, specifier: string): string | undefined {
	const { api } = built;
	// 没有应用 API 的插件不受这些规则约束；pluginFile 是组件自己的外部说明符，单独放行。
	if (api === undefined || specifier === PLUGINS_SPECIFIER) return undefined;
	// 按包名比较，因此 @earendil-works/chord 的任意子路径都算导入 Chord。
	if (packageName(specifier) === "@earendil-works/chord") return "plugins import Chord through the app's API";
	const required = versionOf(built, specifier);
	// 说明符不是应用 API（required 为 undefined）或版本尚未确定时放行；版本相同也放行。
	if (required === undefined || version === undefined || required === version) return undefined;
	// 版本冲突的错误同时给出内置记录的版本和脚本实际 require 的说明符，方便定位两处导入。
	return `this script uses ${api.name}/${version}: one facet uses one version of the API`;
}

// 从说明符中取应用 API 的版本段：`@acme/app/v3/web` 先去掉 `@acme/app/`，再按 / 取第一段得到 v3。
// 说明符恰好等于 API 名称时返回空串，表示没有版本段；调用方只在构建记录了 api 时使用此函数。
/** The API version `specifier` names (`v3` of `@acme/app/v3/web`), when the script was built against an API. */
function versionOf(built: BuiltScript, specifier: string): string | undefined {
	const { api } = built;
	// 必须等于 API 名或以 `API名/` 开头，避免把名字前缀相同的其他包误认成应用 API。
	if (api === undefined || (specifier !== api.name && !specifier.startsWith(`${api.name}/`))) return undefined;
	return specifier.slice(api.name.length + 1).split("/")[0];
}

// 提取裸说明符的包名：作用域包取前两段，普通包取第一段，子路径被丢弃。
// 例："@scope/pkg/sub" -> "@scope/pkg"，"pkg/sub" -> "pkg"；`parts[0]!` 的非空断言只用于类型，
// 运行时并不检查数组是否为空。
/** The package a bare specifier names: `@scope/name` or `name`, without a subpath. */
export function packageName(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

// 把 pluginFile 的相对路径解析成插件目录内的绝对路径。
// 错误路径一：单文件插件没有目录，直接拒绝；错误路径二：解析后跑出插件目录（或以 .. 开头/变成绝对路径）也拒绝。
// resolve 会规范化 . 和 ..；relative 再从句法上检查结果是否仍在目录内。
/** The absolute path of `path` inside `plugin`'s directory; one out of it is refused, and so is every one of a single-file plugin. */
function fileOf(plugin: Plugin, path: string): string {
	if (plugin.layout === "file") {
		throw new Error(`pluginFile("${path}"): single-file plugin "${plugin.name}" has no directory of its own`);
	}
	const file = resolve(plugin.dir, path);
	const rest = relative(plugin.dir, file);
	if (rest.startsWith("..") || isAbsolute(rest)) {
		throw new Error(`pluginFile("${path}"): outside the directory of plugin "${plugin.name}"`);
	}
	return file;
}
