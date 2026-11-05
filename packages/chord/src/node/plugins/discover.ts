// Discovery (slice 7c §1, slice 12 §2, §4): the plugins under the app's roots, found by listing each root and reading
// only `package.json` files. Each directory at a root's top is a package: the plugins its `chord.plugins` manifest
// lists (decision "`chord.plugins` is a package's manifest of plugins"), else by convention itself when its top has
// facet files, else its subfolders with a `package.json` (a checkout of several), else itself (contracts only). Files
// named `<name>.<kind>.<ext>` at a root's top are single-file plugins grouped by name. Facet files are the ones named
// after the app's facet kinds. Nothing parses or runs plugin code.

// 本文件负责“磁盘上的插件长什么样”：扫描应用的插件根目录，读取 package.json 和 facet 文件名，产出普通数据
// Plugin 列表与发现阶段的问题。
// 上游是 Plugins 组件的 #discover（以及 installPlugin 在把包移入根目录前的检查）；下游是 build.ts（按 facets、
// dependencies、external 构建设置）、watcher（监视这些路径）和 runtime（这里不执行任何插件代码，只描述文件）。
// 发现规则：包可以显式用 chord.plugins 清单列插件，也可以按约定（顶层有 facet 文件则自身是插件，否则看子目录），
// 根目录顶部的 `<name>.<kind>.<ext>` 文件则组成单文件插件。
// 文件导读
// 所属模块：packages/chord/src/node/plugins 的发现层，对应 slice 7c §1 与 slice 12 的插件模型。
// 职责边界：只读文件系统和 package.json，产出插件描述与问题；不解析、不构建、不执行插件代码，也不安装依赖。
// 上游入口：Plugins 组件的 #discover、installPlugin 的 checkPackage，以及测试/工具对 discoverPlugins 的直接调用。
// 下游依赖：build.ts 使用 facets/dependencies/external，watch/rollout 使用 plugin 路径，runtime 使用 required 与 name；
// 名字合法性复用 host/staging.ts 的 isPluginName。
// 结果与错误流向：成功返回 Discovery（plugins 已排序、problems 收集）；格式问题通过 problems 返回，文件系统非 ENOENT
// 错误抛出；必选根的问题由上层升级为加载失败。
// 能力清单：
// - PluginRoot：字符串或带 required 的根配置。
// - Plugin：插件名、真实目录、根、required、布局、各 kind 的 facet 文件、dependencies、external。
// - DiscoveryProblem：路径、错误文本、所属根和是否必选。
// - Discovery：插件列表与问题列表。
// - DiscoveryOptions：应用声明的 facet kinds。
// - discoverPlugins(roots, options, context)：列出全部根并合并。
// - discoverPackage(dir, at, context)：发现单个包目录，安装前检查复用。
// - RootContext：根的真实路径、required、kinds。
// - sameFiles(before, after)：判断同一插件的代码位置是否变化。
// - FACET_EXTENSIONS：可识别的 facet 文件扩展名。
// 组合与顺序：discoverPlugins 逐根 listRoot -> 顶层目录按 packageAt 规则展开（chord.plugins、顶层 facet、子目录检出、
// 自身）-> 顶层文件按 singleFilePlugins 分组 -> 跨根按名字去重排序。安装器先在暂存目录 discoverPackage，通过后才移动。
// 示例：const { plugins, problems } = await discoverPlugins(
//   [{ path: "./plugins", required: true }], { kinds: ["server", "worker"] }, context);
// 真实签名如此；plugins 中每项的 facets 是绝对路径映射，problems 为空数组表示没有发现问题。
// 建议阅读顺序：Plugin/Discovery 等类型 -> discoverPlugins/listRoot -> packageAt 的约定 -> manifestPlugins/glob ->
// singleFilePlugins -> pluginAt 的字段校验。
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "../../context/index.ts";
import { isPluginName } from "../../host/staging.ts";

/** A root plugins are listed in: a path, or a path marked `required` (a plugin of it failing at `load` is fatal). */
// 一个插件根：字符串表示非必选；对象形式可标记 required。required 是业务规则：该根中任一插件在加载时失败，
// 应用的 load 就要拒绝。联合类型让调用方两种写法都可读，循环里再用 typeof 收窄。
export type PluginRoot = string | { readonly path: string; readonly required?: boolean };

/** A plugin on disk: its name, its real directory, its root, its facet files and npm packages. Plain data. */
export type Plugin = {
	// 插件名就是 package.json 的 name（单文件插件则是文件名前缀），必须是合法的 npm 包名；
	// 它是宿主里的插件身份，也是重名检测的键。
	readonly name: string;
	/** Its directory's real path (symlinks followed); a single-file plugin's is its root's. */
	// dir 已解析符号链接，是插件目录的真实路径；单文件插件没有自己的目录，记录成它所在的根目录。
	readonly dir: string;
	/** The real path of the root it was found in: relative imports between plugins stay within it. */
	// root 是发现它的根目录的真实路径；构建时只允许通过相对路径导入同一 root 内其他插件的文件。
	readonly root: string;
	/** Whether its root is required: its build, evaluation or setup failing at `load` rejects the load. */
	// 继承自所在根：供 runtime 判断失败是否致命，不需要再回查根配置。
	readonly required: boolean;
	/** A directory with a `package.json`, or files at a root's top (`hello.server.ts`): host packages only, no files. */
	// layout 决定求值规则：目录插件可以有本插件的相对文件和 chord.external 包；单文件插件只允许宿主包。
	readonly layout: "directory" | "file";
	/** Its facet files by kind, absolute paths; none for a contracts-only plugin. */
	// 种类名 -> facet 文件绝对路径。没有 facet 文件的“只含契约”插件也合法，build 时每个种类得到失败结果。
	// Record 的键在运行时没有枚举约束，实际键来自 DiscoveryOptions.kinds 与文件名匹配。
	readonly facets: Readonly<Record<string, string>>;
	/** The packages in its `dependencies`: bundled into the facets that import them. */
	// dependencies 只取键名：构建会把依赖内联，但只允许 package.json 声明过的包。
	readonly dependencies: readonly string[];
	/** The packages in its `chord.external`: kept external in Node builds, loaded from its `node_modules`. */
	// external 来自 chord.external：这些包在 Node 构建中保持外部，求值时从插件的 node_modules 加载。
	readonly external: readonly string[];
};

/**
 * A root, directory or file that is not a plugin, a plugin left out, or a required root missing, and why; with the
 * root it is in (a required root's problems make `plugins.load` reject).
 */
// 一条发现问题：path 是出错的文件或目录；error 是给人看的说明；root/required 说明它属于哪个根，
// 组件据此只把必选根的问题升级为加载失败。字段来自运行时读取的 JSON 和文件系统，不是类型保证的数据。
export type DiscoveryProblem = {
	readonly path: string;
	readonly error: string;
	readonly root: string;
	readonly required: boolean;
};

/** What discovery found: the plugins by name, and the paths it reported. */
// 发现结果：plugins 已按名字排序，problems 按扫描顺序累积；两者都是普通数组，readonly 只在编译期生效。
export type Discovery = { readonly plugins: readonly Plugin[]; readonly problems: readonly DiscoveryProblem[] };

/** What discovery takes besides the roots: the app's facet kinds (`["server", "worker", "web", "tui"]`). */
// 发现选项：kinds 是应用定义的 facet 种类名，例如 server/worker/web；它决定哪些文件算 facet 文件。
export type DiscoveryOptions = { readonly kinds: readonly string[] };

/**
 * Lists every root: its packages' plugins (by their manifests or by convention) and its single-file plugins. Reported,
 * not plugins: a directory without any `package.json`, an invalid one, name or manifest, two files of one facet kind,
 * a name an earlier root (or an earlier entry of the same root) has already; a single-file plugin named like a
 * directory plugin of its root loses to it; a required root that does not exist. A missing root that is not required
 * is empty. Plugins sorted by name.
 */
// 列出所有根目录下的插件。
// 输入：roots（字符串或 {path, required}）、options.kinds、context（用于中止检查）。
// 输出：Discovery，插件按名字排序，问题按发现顺序收集。
// 副作用：读取文件系统；不解析、不执行插件代码。
// 错误：文件系统的非 ENOENT 错误会抛出；格式问题通过 problems 返回，而不是异常。
// 主要流程：逐个根调用 listRoot -> 合并结果并按名字去重（先到者胜）-> 排序。
// 例子：discoverPlugins(["plugins", { path: "vendor/plugins", required: true }], { kinds: ["server"] }, context)
// 返回两个根下的插件；真实运行时由 createPlugins 在首次构建或安装后调用。
export async function discoverPlugins(
	roots: readonly PluginRoot[],
	options: DiscoveryOptions,
	context: Context,
): Promise<Discovery> {
	// 名字 -> 插件。Map 保留第一次插入的顺序，但最后显式排序，因此结果不受根顺序影响。
	const plugins = new Map<string, Plugin>();
	const problems: DiscoveryProblem[] = [];
	for (const each of roots) {
		// 联合类型收窄：字符串根没有 required 字段，对象根才有；对象形式里 required 仍是可选的，所以下面用 === true。
		const { path, required } = typeof each === "string" ? { path: each, required: false } : each;
		// 每个根独立发现，问题里的 root/required 由 RootContext 填好，合并时不需再猜。
		const listed = await listRoot(path, required === true, options.kinds, context);
		problems.push(...listed.problems);
		// 跨根重名：后面根的同名插件不加入，只报告；先发现的插件保留自己的目录和配置。
		for (const plugin of listed.plugins) {
			const other = plugins.get(plugin.name);
			if (other !== undefined) {
				// 错误文本包含已存在插件的真实目录，方便判断该删哪一个。
				const error = `plugin "${plugin.name}" is in ${other.dir} already`;
				// 问题的 path 用新插件的路径；root/required 用新插件所在的根，因为失败归因于这次扫描的配置。
				problems.push({ path: pathOf(plugin), error, root: plugin.root, required: plugin.required });
				continue;
			}
			plugins.set(plugin.name, plugin);
		}
	}
	// 显式按名字排序；比较函数返回 -1/1/0 而不是布尔值，符合 Array.sort 的约定。
	const sorted = [...plugins.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return { plugins: sorted, problems };
}

/**
 * The plugins of the package in `dir` (its manifest's folders, or by convention) and its problems, recorded as of
 * `at.root`: what `installPlugin` checks a package with before it moves it into a root.
 */
// 发现单个包目录内的插件，用于安装前检查：安装器把包解到临时目录后先调用它，确认里面有插件再移入根目录。
// 输入：dir 是包目录；at 提供根路径、required 和 kinds；context 可中止。
// 输出：与 discoverPlugins 相同形状的 Discovery；问题中的 root/required 一律取 at。
// 副作用：只读文件系统；context 已中止时抛 AbortError。
// 例：discoverPackage(tmpDir, { root, required: false, kinds }, context) 得到一个包自带的插件列表。
export async function discoverPackage(dir: string, at: RootContext, context: Context): Promise<Discovery> {
	// abortSignal 是可选链；存在时 throwIfAborted 在开始读盘前响应取消，避免安装被取消后还继续扫描。
	context.abortSignal?.throwIfAborted();
	const plugins: Plugin[] = [];
	const problems: DiscoveryProblem[] = [];
	// 先 realpath 再按包的约定展开；packageAt 返回 plugin/problem 的混合列表。
	for (const each of await packageAt(await realpath(dir), at)) {
		// Found 是可辨识联合，检查 kind 后 TypeScript 才知道 each 有 plugin 还是 error 字段。
		if (each.kind === "plugin") plugins.push(each.plugin);
		else problems.push({ path: each.path, error: each.error, root: at.root, required: at.required });
	}
	return { plugins, problems };
}

/** Where a root's plugins are listed from, and what each records: its root's real path, requiredness, the kinds. */
// 发现一个根时传给下层函数的上下文：root 已 realpath，required/kinds 原样携带；
// 下层创建 Plugin 时把 root 和 required 写进每条记录。
export type RootContext = { readonly root: string; readonly required: boolean; readonly kinds: readonly string[] };

/** Whether two records of one plugin name the same directory, layout and facet files (else its code moved). */
// 判断同一个插件名在两次发现中是否仍指向同一份代码。
// 输入：前后两个 Plugin；输出：目录、布局和 facet 文件映射都相同则为 true。
// 用途：watcher/组件用它识别“插件目录变了”，需要重新构建而不是只重读某一文件。
// 比较的是字符串化后的键值对，不比较文件内容或时间戳。
export function sameFiles(before: Plugin, after: Plugin): boolean {
	// Object.entries 只取自有可枚举属性；sort 让 JSON 文本不受属性插入顺序影响。
	const files = (plugin: Plugin) => JSON.stringify(Object.entries(plugin.facets).sort());
	// dir 用真实路径，layout 区分目录插件与单文件插件，facets 检查各 kind 的文件是否移动。
	return before.dir === after.dir && before.layout === after.layout && files(before) === files(after);
}

/** The facet files' extensions, in no order of preference: two files of one kind are reported. */
// facet 文件允许的扩展名；顺序不表示优先级——同一 kind 命中两个文件会报错，而不是选第一个。
export const FACET_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".mjs"];

/** The plugins of one root, directory plugins first, and its problems. */
// 列出一个根下的插件：先处理子目录里的包，再处理根顶部的单文件插件，最后合并两者。
// 输出中的 plugins 顺序是“目录插件在前、单文件插件在后”，最终 discoverPlugins 还会按名字排序。
async function listRoot(
	path: string,
	required: boolean,
	kinds: readonly string[],
	context: Context,
): Promise<Discovery> {
	// entriesOf 返回 undefined 表示根目录不存在；这里区分必选与非必选根。
	const entries = await entriesOf(path);
	if (entries === undefined) {
		// 非必选根缺失视为空，不产生问题；这是允许“可选插件目录”在部署中不存在的行为。
		if (!required) return { plugins: [], problems: [] };
		return { plugins: [], problems: [{ path, error: "the required root does not exist", root: path, required }] };
	}
	// 根存在后解析真实路径；后面所有 Plugin.root 和跨插件相对导入检查都基于这个值。
	const root = await realpath(path);
	const at = { root, required, kinds };
	const plugins: Plugin[] = [];
	const problems: DiscoveryProblem[] = [];
	// 每个顶层子目录按一个包处理；discoverPackage 内部决定它是自身、chord.plugins 列出的子目录，还是多插件检出。
	for (const dir of entries.dirs) {
		const found = await discoverPackage(dir, at, context);
		plugins.push(...found.plugins);
		problems.push(...found.problems);
	}
	// 根顶部的普通文件再按 `<name>.<kind>.<ext>` 分组为单文件插件；目录插件和文件插件在此分开收集。
	const files = singleFilePlugins(entries.files, at);
	problems.push(...files.problems);
	for (const plugin of files.plugins) {
		// 同名时目录插件胜出；单文件插件只报告问题，不替换已发现的目录插件。
		// find 是线性查找，插件数量通常很小，不值得额外建索引。
		const directory = plugins.find((each) => each.name === plugin.name);
		if (directory === undefined) plugins.push(plugin);
		else {
			const error = `plugin "${plugin.name}" is in ${directory.dir} already`;
			problems.push({ path: pathOf(plugin), error, root, required });
		}
	}
	return { plugins, problems };
}

/** A plugin found, or why a directory is none. */
// packageAt 和插件检查的内部结果：一个插件，或一条带 path/error 的问题；kind 标签让消费方安全收窄。
type Found =
	| { readonly kind: "plugin"; readonly plugin: Plugin }
	| { readonly kind: "problem"; readonly path: string; readonly error: string };

/** The plugin's path to report: its directory, or a single-file plugin's first facet file. */
// 报告问题时的路径：目录插件用目录；单文件插件用它的第一个 facet 文件（Object.values 的顺序来自对象插入顺序）。
// 末尾的非空断言只用于类型；单文件插件至少有一个 facet 文件，否则不会被分组创建。
function pathOf(plugin: Plugin): string {
	return plugin.layout === "directory" ? plugin.dir : Object.values(plugin.facets)[0]!;
}

/**
 * The directories (by real path) and plain files directly under `path`, in name order; `undefined` when it does not
 * exist. Hidden entries and `node_modules` are not plugins.
 */
// 列出一个目录的直接子项，按名字排序并区分目录与普通文件。
// 输入：绝对路径；输出：{dirs, files} 或 undefined（目录不存在）。
// 错误：ENOENT 转成 undefined；权限等其他错误继续抛出。
// 隐藏条目和 node_modules 被跳过；目录返回 realpath，文件只返回名字。
async function entriesOf(path: string): Promise<{ dirs: string[]; files: string[] } | undefined> {
	let names: string[];
	// let names 在 try 内赋值、try 外使用；readdir 不含路径，只给名字。
	try {
		names = (await readdir(path)).sort();
	} catch (error) {
		// 错误在 TypeScript 中是 unknown，断言成 NodeJS.ErrnoException 只是为了读 code；ENOENT 才当作“不存在”。
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const dirs: string[] = [];
	const files: string[] = [];
	for (const name of names) {
		// 以点开头的目录/文件和 node_modules 不参与发现，避免把依赖或隐藏工作目录当插件。
		if (name.startsWith(".") || name === "node_modules") continue;
		const entry = join(path, name);
		// `stat` follows a symlink: a linked plugin directory is listed by its real path.
		// stat 跟随符号链接；catch 把任何 stat 失败（例如扫描过程中文件被删）当作不可用条目，而不是让整个发现失败。
		const info = await stat(entry).catch(() => undefined);
		// 目录记录 realpath：符号链接指向哪里，插件就按哪里的真实路径工作；文件只需名字，后面与根目录拼接。
		if (info?.isDirectory() === true) dirs.push(await realpath(entry));
		else if (info?.isFile() === true) files.push(name);
	}
	return { dirs, files };
}

/** A package's `package.json`: missing, unreadable (why), or its value (a trust boundary, checked where it is read). */
// package.json 的读取结果：不存在、不可读/非法（带原因），或解析成功但值仍未知。
// JSON.parse 的结果在类型上是 any，这里故意保存为 unknown，迫使后续在使用点做运行时检查。
type Manifest =
	| { readonly kind: "missing" }
	| { readonly kind: "invalid"; readonly error: string }
	| { readonly kind: "read"; readonly value: unknown };

/** The `package.json` of `dir`. */
// 读取目录下的 package.json。
// 输入：目录绝对路径；输出：Manifest 联合；错误：ENOENT 归为 missing，其他读取/解析错误归为 invalid。
// JSON.parse 的异常消息被拼进 error，方便指出是语法问题还是权限问题。
async function manifestOf(dir: string): Promise<Manifest> {
	try {
		// join 生成路径；readFile 指定 utf8 得到字符串；JSON.parse 的返回值不校验形状。
		return { kind: "read", value: JSON.parse(await readFile(join(dir, "package.json"), "utf8")) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		// 用 Error 断言读取 message；运行时这里捕获的是 readFile 或 JSON.parse 的错误。
		return { kind: "invalid", error: `package.json: ${(error as Error).message}` };
	}
}

/**
 * The plugins of the package in `dir` (a real path): its manifest's folders; without a manifest itself when its top
 * has facet files, else its subfolders with a `package.json`, else itself; without a `package.json` its subfolders
 * with one (a checkout of several), else a problem.
 */
// 决定一个顶层目录里的插件从哪里来。
// 规则顺序：package.json 非法 -> 报错；有 chord.plugins -> 按清单列出的文件夹；顶层有 facet 文件 -> 目录自身；
// 否则看直接子目录中有 package.json 的（多插件检出）；若一个都没有且目录自身有 package.json -> 自身；
// 否则报“没有 package.json”。
// 例子：一个只含 contracts 的包会走“自身”分支，得到没有 facets 的插件。
async function packageAt(dir: string, at: RootContext): Promise<Found[]> {
	const manifest = await manifestOf(dir);
	// 非法清单直接短路：连名字都无法可靠读取，不再尝试约定。
	if (manifest.kind === "invalid") return [{ kind: "problem", path: dir, error: manifest.error }];
	// 只有成功读取才取 chord.plugins；as 只描述预期形状，chord.plugins 是否为数组由 manifestPlugins 在运行时校验。
	// `| null` 是因为 JSON 顶层可能是 null。
	const value = manifest.kind === "read" ? (manifest.value as { chord?: { plugins?: unknown } } | null) : null;
	// 可选链逐层容忍缺失；undefined 表示没有用清单，继续按约定判断。
	const listed = value?.chord?.plugins;
	// 显式清单优先于一切约定；listed 的类型仍是 unknown，交给清单解析函数检查。
	if (listed !== undefined) return manifestPlugins(dir, listed, at);
	// 约定一：顶层存在任一 kind 的 facet 文件，这个包本身就是插件。hasFacetFile 只看直接子文件。
	if (manifest.kind === "read" && (await hasFacetFile(dir, at.kinds))) return [await pluginAt(dir, manifest, at)];
	const inner: Found[] = [];
	// 约定二：把直接子目录当作多插件检出，只考虑带 package.json 的子目录；?? [] 处理目录不可读的情况。
	for (const sub of (await entriesOf(dir))?.dirs ?? []) {
		const found = await manifestOf(sub);
		// 子目录没有 package.json 就跳过（不是插件）；有则无论合法与否都交给 pluginAt，由它报告具体问题。
		if (found.kind !== "missing") inner.push(await pluginAt(sub, found, at));
	}
	// 只要发现至少一个子插件，就把这个目录当作“检出集合”，不再把外层目录自身当插件。
	if (inner.length > 0) return inner;
	// 约定三：没有子插件但自身有 package.json，则自身是只含契约（或缺少 facet）的插件。
	if (manifest.kind === "read") return [await pluginAt(dir, manifest, at)];
	// 既没有包清单也没有子包：报告“no package.json”，路径指向这个目录。
	return [{ kind: "problem", path: dir, error: "no package.json" }];
}

/** Whether `dir`'s top has a facet file of one of `kinds`. */
// 判断目录顶层是否有任一 `<kind><ext>` 文件。
// 输入：目录和 kinds；输出：Promise<boolean>；readdir 失败会抛出。
// 嵌套 some 依次尝试种类与扩展名；Set 让每次存在性检查为 O(1)。
async function hasFacetFile(dir: string, kinds: readonly string[]): Promise<boolean> {
	const files = new Set(await readdir(dir));
	return kinds.some((kind) => FACET_EXTENSIONS.some((extension) => files.has(`${kind}${extension}`)));
}

/**
 * The plugins `chord.plugins` (`listed`: folders of the package, as paths, globs and `!` exclusions, as pi's
 * `pi.extensions`) of the package in `dir` names: each a folder with a `package.json` (the package itself when listed
 * as `.`). A manifest that is no list of strings, an entry or a link leaving the package, a listed path that is no
 * directory, and a listing of nothing are problems.
 */
// 解析 package.json 的 chord.plugins 清单。
// 输入：包目录、unknown 的清单值、根上下文；输出：每个列出文件夹对应的 Found 列表。
// 规则：必须是字符串数组；`!pattern` 是排除项；普通项可含 * ? 通配，由 globFolders 展开；
// 每个结果必须是包内目录且不通过符号链接逃出包；不能把一个插件列在另一个插件目录内部；不能一个都不列。
// 示例：["plugins/*", "!plugins/legacy"] 列出 plugins 下一层的所有目录，但排除 legacy。
// 错误都转成 problems，而不是抛出（除文件系统的非预期错误外）。
async function manifestPlugins(dir: string, listed: unknown, at: RootContext): Promise<Found[]> {
	// 局部辅助函数统一加 package.json: chord.plugins 前缀，并固定问题路径为包目录。
	const problem = (error: string): Found[] => [
		{ kind: "problem", path: dir, error: `package.json: chord.plugins ${error}` },
	];
	// 运行时校验清单是字符串数组；Array.isArray 与 every 都是 JSON 信任边界上的检查。
	if (!Array.isArray(listed) || !listed.every((each) => typeof each === "string")) {
		return problem("is not a list of plugin folders");
	}
	// 上面已确认全是字符串，as 只是把 unknown[] 收窄成 readonly string[]，不会复制数组。
	const entries = listed as readonly string[];
	// 排除项去掉开头 !，再统一成 / 分隔、去掉 ./ 前缀；之后用 matchesGlob 与列出项的相对路径匹配。
	const excludes = entries.filter((each) => each.startsWith("!")).map((each) => posix(each.slice(1)));
	// Set 去重：多个通配符可能匹配同一目录，最终只列一次。
	const folders = new Set<string>();
	for (const entry of entries.filter((each) => !each.startsWith("!"))) {
		// 含 * 或 ? 的项走递归 glob，否则按普通路径 resolve；[resolve] 使两条路径得到同样形状。
		const matched = /[*?]/.test(entry) ? await globFolders(dir, posix(entry)) : [resolve(dir, entry)];
		for (const folder of matched) {
			// 相对包目录的路径用于两项检查：不能以 .. 开头/变成绝对路径，以及是否命中排除模式。
			const rest = relative(dir, folder);
			// 逃出包目录的普通项直接让整个清单失败；这包括 `../other` 这类写法。
			if (rest.startsWith("..") || isAbsolute(rest)) return problem(`"${entry}" leaves the package`);
			// 排除模式只影响命中的文件夹；`|| "."` 把“包自身”表示成点，便于匹配。
			if (!excludes.some((exclude) => matchesGlob(posix(rest) || ".", exclude))) folders.add(folder);
		}
	}
	// 若一个列出目录位于另一个列出目录内部，内层文件在构建外层插件时会被当作外层自己的文件，
	// 与外层源码冲突，因此这种清单整体报错。
	// One plugin inside another's directory would make the outer one's imports of it its own files, not copies.
	// 排序后按路径前缀检查，保证同一个清单多次扫描得到同样的第一个错误。
	const sorted = [...folders].sort();
	for (const inner of sorted) {
		// insideDir 对每个外层/内层组合判断包含关系；find 返回第一个外层即可生成错误。
		const outer = sorted.find((folder) => insideDir(folder, inner));
		if (outer !== undefined) {
			// 展示时用相对包目录的 / 路径；包自身显示为 "."。
			const listed = (folder: string) => posix(relative(dir, folder)) || ".";
			return problem(`lists "${listed(inner)}" inside the listed "${listed(outer)}"`);
		}
	}
	// 清单里全部是排除项或通配符什么都没匹配到，等于没有插件，报告而不是静默返回空。
	if (folders.size === 0) return problem("lists no plugin folder");
	const found: Found[] = [];
	// 逐个落实列出的目录：先 stat（跟随符号链接），再 realpath 检查真实位置仍在包内。
	for (const folder of sorted) {
		const info = await stat(folder).catch(() => undefined);
		// 不是目录（不存在或是文件）都报告，不中断其他项的检查。
		if (info?.isDirectory() !== true) {
			found.push({ kind: "problem", path: folder, error: "listed in chord.plugins, not a directory" });
			continue;
		}
		// 符号链接可能指向包外；realpath 后的相对路径再检查一次，和上面的普通路径检查呼应。
		const real = await realpath(folder);
		const rest = relative(dir, real);
		if (rest.startsWith("..") || isAbsolute(rest)) {
			found.push({ kind: "problem", path: folder, error: "listed in chord.plugins, links out of the package" });
			continue;
		}
		// 读取该文件夹自己的 package.json 并交给 pluginAt；插件清单只列出目录，不负责解析目录里的 facet。
		found.push(await pluginAt(real, await manifestOf(real), at));
	}
	return found;
}

/** `path` with `/` separators and no leading `./` (as manifests and globs write paths). */
// 把平台路径分隔符统一成 /，并去掉开头的 ./；glob 与清单都按 / 书写。
// 例：Windows 上的 plugins\\notes 变成 plugins/notes。
function posix(path: string): string {
	return path.split(sep).join("/").replace(/^\.\//, "");
}

/** Whether `path` lies inside directory `dir` (both absolute). */
// 判断 path 是否严格位于 dir 内部（不含 dir 自身）。
// relative 返回空串表示同一路径；以 .. 开头或变成绝对路径表示不在内部。
function insideDir(dir: string, path: string): boolean {
	const rest = relative(dir, path);
	return rest !== "" && !rest.startsWith("..") && !isAbsolute(rest);
}

/**
 * Whether the `/`-separated `path` matches the glob `pattern`: `*` and `?` within one segment, `**` across segments
 * (`node:path`'s `matchesGlob` is experimental in Node 22, Chord's floor); anything else literal.
 */
// 一个极简 glob 匹配器，只支持清单需要的语法。
// 输入：/ 分隔的路径与模式；输出：布尔值。
// `*` 匹配段内任意字符，`?` 匹配段内一个字符，`**/` 匹配零或多层目录，`**` 匹配任意字符。
// 其他字符按字面量转义。这里手写是因为 Node 22 的 path.matchesGlob 仍是实验 API。
// 例：matchesGlob("plugins/a", "plugins/**") 为 true；它不处理花括号、字符类等扩展语法。
function matchesGlob(path: string, pattern: string): boolean {
	let source = "";
	// source 逐步累积成正则表达式源码；at 是当前模式字符下标。
	for (let at = 0; at < pattern.length; at++) {
		// 非空断言：循环条件保证 at 在范围内。
		const char = pattern[at]!;
		// `**/` 整体匹配零或多段带斜杠的前缀，因此 a/**/b 也匹配 a/b。
		// at += 2 再配合循环末尾的 at++，共跳过三个字符。
		if (pattern.startsWith("**/", at)) {
			source += "(?:.*/)?";
			at += 2;
			// 单独的 `**`（后面不跟 /）匹配任意字符，包括斜杠；同样调整下标跳过两个字符。
		} else if (pattern.startsWith("**", at)) {
			source += ".*";
			at += 1;
			// 单个 * 不跨段；? 恰好一个非斜杠字符。
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		// 普通字符中属于正则元字符的先转义，避免用户模式意外变成正则语法。
		else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	// 全串锚定：模式必须覆盖整个路径，而不是任意子串。
	return new RegExp(`^${source}$`).test(path);
}

/** How deep a glob of `chord.plugins` looks for folders. */
// 限制 glob 的目录深度；没有这个上限，恶意或误写的清单会让扫描遍历很深的树。
const GLOB_DEPTH = 6;

/** The folders under `dir` (hidden ones and `node_modules` skipped, `GLOB_DEPTH` deep) whose path matches `pattern`. */
// 递归查找匹配 pattern 的文件夹。
// 输入：根目录与 / 分隔模式；输出：匹配的绝对路径数组（未 realpath）。
// 跳过隐藏目录和 node_modules；超过 GLOB_DEPTH 停止；readdir 失败的分支静默跳过。
// walk 用闭包累积 found，深度从 1 开始（根目录自身不算匹配）。
async function globFolders(dir: string, pattern: string): Promise<string[]> {
	const found: string[] = [];
	const walk = async (at: string, depth: number): Promise<void> => {
		// 深度超限直接返回；这限制的是递归层级，不是结果数量。
		if (depth > GLOB_DEPTH) return;
		let entries: Dirent[];
		try {
			// withFileTypes 直接得到 dirent，省去每个条目一次 stat；entry.isDirectory 不跟随符号链接。
			entries = await readdir(at, { withFileTypes: true });
			// 无法读取的目录（权限、扫描中删除）不终止整个 glob；这是发现阶段有意容忍的失败。
		} catch {
			return;
		}
		for (const entry of entries) {
			// 只递归目录；隐藏目录和 node_modules 与前面的发现规则保持一致。
			if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const path = join(at, entry.name);
			// 相对 dir 的 / 路径用于匹配；posix 处理平台分隔符。
			if (matchesGlob(posix(relative(dir, path)), pattern)) found.push(path);
			// 即使当前目录匹配，也继续向下找，因为更深层还可能有匹配项；await 保证顺序遍历。
			await walk(path, depth + 1);
		}
	};
	// 从根目录的下一层开始，深度 1。
	await walk(dir, 1);
	return found;
}

/** The plugin in `dir` (its real path) with its `package.json` read as `manifest`, or why it is none. */
// 把一个有 package.json 的目录读成 Plugin，或给出问题。
// 输入：dir（真实路径）、已读取的 manifest、根上下文；输出：Found 联合。
// 校验：name 必须是字符串且符合 npm 包名；chord.external 必须是字符串数组；每个 kind 至多一个 facet 文件。
// dependencies 只取键名，不检查版本或存在性；facet 文件只按名字识别，不解析内容。
async function pluginAt(dir: string, manifest: Manifest, at: RootContext): Promise<Found> {
	// 局部辅助函数让每个问题都带上当前目录。
	const problem = (error: string): Found => ({ kind: "problem", path: dir, error });
	// 没有 package.json 的目录不能成为目录插件（顶层检出逻辑会先过滤掉这种子目录）。
	if (manifest.kind === "missing") return problem("no package.json");
	if (manifest.kind === "invalid") return problem(manifest.error);
	// 这里是信任边界：package.json 的内容来自插件作者，下面的类型断言只描述预期形状，字段都还要运行时检查。
	// A trust boundary: a plugin's own `package.json`.
	// `manifest.value ?? {}` 容忍 JSON 顶层为 null；解构出 name/dependencies/chord 三个字段，
	// 类型标注把每个声明为 unknown，迫使后续逐个用 typeof/Array.isArray 验证。
	const { name, dependencies, chord } = (manifest.value ?? {}) as {
		readonly name?: unknown;
		readonly dependencies?: unknown;
		readonly chord?: { readonly external?: unknown };
	};
	// 名字既要是字符串，也要符合 npm 包名规则；JSON.stringify 让错误消息能显示 null、数字或对象等非法值。
	if (typeof name !== "string" || !isPluginName(name)) {
		return problem(`package.json: ${JSON.stringify(name)} is not a valid plugin name`);
	}
	// 未声明 chord.external 时默认空数组；chord 可能不是对象，可选链在运行时容忍这种情况。
	const external = chord?.external ?? [];
	// external 必须是字符串数组；与 name 一样，这是对插件清单的运行时校验。
	if (!Array.isArray(external) || !external.every((each) => typeof each === "string")) {
		return problem("package.json: chord.external is not a list of package names");
	}
	// 一次 readdir 得到目录顶层文件名集合，后面每个 kind 都在集合里查候选。
	const files = new Set(await readdir(dir));
	const facets: Record<string, string> = {};
	// 只识别应用声明的 kinds；其他名字的文件（例如 foo.test.ts）不会被当作 facet。
	for (const kind of at.kinds) {
		// 为每个扩展名生成 `<kind><ext>` 并过滤存在者；map/filter 链只处理名字，不读文件内容。
		const named = FACET_EXTENSIONS.map((extension) => `${kind}${extension}`).filter((file) => files.has(file));
		// 同一 kind 两个扩展名同时存在是歧义，报告并放弃整个包；不会按扩展名优先级猜一个。
		if (named.length > 1) return problem(`two ${kind} facets: ${named.join(", ")}`);
		// 恰好一个时记录绝对路径；named[0]! 的非空断言用于类型，长度已由上一行保证。
		if (named.length === 1) facets[kind] = join(dir, named[0]!);
	}
	// dependencies 的运行时形状检查：必须是对象且非 null 才取键；数组也会通过 object 检查，
	// 但发现阶段不做更细的依赖名验证。Object.keys 得到包名列表。
	const packages = typeof dependencies === "object" && dependencies !== null ? Object.keys(dependencies) : [];
	// 组装普通数据；root/required 来自根上下文，layout 固定为 directory。
	const plugin: Plugin = {
		name,
		dir,
		root: at.root,
		required: at.required,
		layout: "directory",
		facets,
		dependencies: packages,
		external,
	};
	return { kind: "plugin", plugin };
}

/**
 * The single-file plugins among a root's top files: `<name>.<kind>.<ext>` with `<kind>` one of the app's kinds and
 * `<ext>` a facet extension, grouped by `<name>` (an unscoped plugin name, else reported; two files of one kind
 * reported). Other files are not plugins.
 */
// 从根顶部的文件名中识别单文件插件。
// 输入：文件名字符串数组和根上下文；输出：插件与问题。
// 规则：`<name>.<kind>.<ext>`，name 必须是不带作用域的合法包名，一个 name 每个 kind 只能有一个文件。
// 分组结构是 Map<name, Map<kind, file[]>>；其他文件直接忽略。
// 例：hello.server.ts 与 hello.web.ts 合并成插件 hello，两个 facet 种类。
function singleFilePlugins(
	files: readonly string[],
	at: RootContext,
): { readonly plugins: readonly Plugin[]; readonly problems: readonly DiscoveryProblem[] } {
	// 外层键是插件名，内层键是种类，值是同名同种类的文件列表（用于发现重复）。
	const groups = new Map<string, Map<string, string[]>>();
	// 只扫描根顶部的普通文件；子目录已作为目录插件处理。
	for (const file of files) {
		const parsed = singleFileName(file, at.kinds);
		if (parsed === undefined) continue;
		// 第一次见到的插件名创建内层 Map；?? 提供默认值，再 set 回外层（即使已存在也安全）。
		const kinds = groups.get(parsed.name) ?? new Map<string, string[]>();
		groups.set(parsed.name, kinds);
		// 追加文件名：kinds.get 可能为 undefined，?? [] 提供空数组；展开创建新数组，避免修改旧值。
		kinds.set(parsed.kind, [...(kinds.get(parsed.kind) ?? []), file]);
	}
	const plugins: Plugin[] = [];
	const problems: DiscoveryProblem[] = [];
	// 每个插件名生成一条记录；kinds 是这个插件的种类到文件列表。
	for (const [name, kinds] of groups) {
		// 取第一个种类的第一个文件作为问题路径；两次非空断言只用于类型，前面已保证至少有一个文件。
		const first = join(at.root, [...kinds.values()][0]![0]!);
		// 单文件插件不允许作用域名：@scope/name 中的 / 无法出现在文件名里，因此也不接受 @ 开头；
		// 这里与目录插件共用 isPluginName 检查基本字符规则。
		if (!isPluginName(name) || name.startsWith("@")) {
			problems.push({ path: first, error: `"${name}" is not a valid unscoped plugin name`, ...rootOf(at) });
			continue;
		}
		// 找出任意一个超过一个文件的种类；find 的解构 `[, named]` 忽略键，只取文件数组。
		const twice = [...kinds].find(([, named]) => named.length > 1);
		if (twice !== undefined) {
			problems.push({ path: first, error: `two ${twice[0]} facets: ${twice[1].join(", ")}`, ...rootOf(at) });
			continue;
		}
		// 每个文件的绝对路径由根目录 + 文件名组成；嵌套解构 `[kind, [file]]` 取第一项，file! 用于类型。
		// Object.fromEntries 把 [kind, path] 对变成 facets 记录。
		const facets = Object.fromEntries([...kinds].map(([kind, [file]]) => [kind, join(at.root, file!)]));
		// 单文件插件没有 package.json 依赖和 external，所以两个列表都为空；root/required 仍来自根。
		const record = { root: at.root, required: at.required, dependencies: [], external: [] };
		// layout:"file" 让构建器只允许宿主包；dir 指向根目录（它没有自己的目录）；...record 展开共用字段。
		plugins.push({ name, dir: at.root, layout: "file", facets, ...record });
	}
	return { plugins, problems };
}

/** The plugin name and kind of a single-file plugin's file name (`hello.server.ts`), or `undefined` for another file. */
// 解析一个根顶部文件名：返回插件名和种类，或 undefined 表示不是单文件插件。
// 例：hello.server.ts -> {name:"hello", kind:"server"}；notes.md -> undefined。
// 只按后缀和点号切分，不读取文件。
function singleFileName(
	file: string,
	kinds: readonly string[],
): { readonly name: string; readonly kind: string } | undefined {
	// 找匹配的 facet 扩展名；find 返回第一个，顺序来自 FACET_EXTENSIONS。
	const extension = FACET_EXTENSIONS.find((each) => file.endsWith(each));
	if (extension === undefined) return undefined;
	// 去掉扩展名得到 stem，例如 hello.server。
	const stem = file.slice(0, -extension.length);
	// 最后一个点分隔名字与种类；名字里可以含点（hello.world.server.ts 的名字是 hello.world）。
	const dot = stem.lastIndexOf(".");
	// 没有点或点在最前面（.server.ts 这类隐藏文件）都不是插件；dot <= 0 同时排除两种情况。
	if (dot <= 0) return undefined;
	const kind = stem.slice(dot + 1);
	// 种类必须是应用声明的 kinds 之一，否则普通文件；返回新对象而不是复用中间字符串。
	return kinds.includes(kind) ? { name: stem.slice(0, dot), kind } : undefined;
}

/** A problem's root fields for a root's context. */
// 把根上下文中的两个字段复制进问题记录；单文件插件问题没有插件对象可读取 root/required。
function rootOf(at: RootContext): { readonly root: string; readonly required: boolean } {
	return { root: at.root, required: at.required };
}
