// CSS modules in plugin builds (slice 11 §4b, decision "Looks and themes"; fix round 1, Opus L1): a plugin's
// `*.module.css` has its class names made unique to the file, the import giving the mapping, so twenty plugins'
// `.card` never collide. esbuild's `local-css` loader names classes uniquely within one build only (and a minified
// build names them `.a`, `.b`), while each facet is a build of its own; so each CSS module is scoped by a small build of
// its own whose names start with a prefix of the plugin and the file, and the facet's build gets the scoped stylesheet
// and the mapping. The mapping is esbuild's own (`composes` and escaped names as esbuild gives them); `url()` and
// `@import` stay as written and resolve in the facet's build, relative to the module (an `@import`ed file is plain CSS,
// its classes not scoped).

// 本文件只做一件事：把单个 CSS module 先单独“作用域化”，再把 css 文本和类名映射交给 facet 的构建。
// 上游是 build.ts 的导入规则：遇到 *.module.css 时先处理依赖文件里的 url()/@import，再调用 scopeCssModule；
// 下游是 build.ts 把返回的 css 收集进构建产物、把 classes 变成 JS 模块的默认导出。
// 这里使用 esbuild 的内存构建（write:false）和 node:vm 执行映射模块，不落地临时文件。
// 文件导读
// 所属模块：packages/chord/src/node/plugins 的构建辅助，处理插件里的 CSS modules。
// 职责边界：只负责给一个 *.module.css 生成唯一类名和“原类名 -> 新类名”的映射；不决定 facet 如何收集 CSS、
// 不处理普通 CSS 的 url()/@import（这些留给 facet 构建按模块位置解析）。
// 上游入口：build.ts 的导入规则遇到 CSS module 时调用 scopeCssModule；下游结果是 css 文本进入该 facet 的样式表，
// classes 映射变成虚拟 JS 模块的默认导出，再被插件代码作为对象使用。
// 下游依赖：esbuild（内存构建、local-css loader）、node:crypto 的 sha256、node:vm 执行映射模块。
// 结果与错误流向：成功返回 Promise<ScopedCss>；esbuild 的 CSS 语法错误以拒绝的 Promise 返回，由 build.ts 记录为
// facet 构建失败；本文件不写磁盘，也不吞掉构建错误。
// 能力清单：
// - ScopedCss：css 文本与 classes 映射的只读形状。
// - SCOPED_CSS：facet 构建识别已作用域化样式表的虚拟命名空间常量。
// - scopeCssModule(plugin, dir, file, contents)：运行一次小构建，返回作用域化 CSS 和映射。
// 组合关系：每个 CSS module 独立作用域化，再由 facet 构建把多个结果合并；前缀含插件名和相对路径，所以不同插件的
// 同名类不会冲突，同一文件在不同机器/检出目录得到相同前缀。
// 示例：const { css, classes } = await scopeCssModule("@acme/notes", "/app/notes", "/app/notes/card.module.css", ".card { color: red }");
// 真实运行时 classes 的键是 card，值是带哈希前缀的类名；示例不保证具体哈希值。
// 建议阅读顺序：先看 ScopedCss/SCOPED_CSS，再读 scopeCssModule 的前缀计算，最后看内部 esbuild 插件的三个钩子。
import { createHash } from "node:crypto";
import { basename, relative } from "node:path";
import { Script } from "node:vm";
import { build } from "esbuild";

// 作用域化结果：css 是重命名后的样式表文本，classes 是原类名到生成类名的映射。
// Readonly<Record<string, string>> 只是编译期的只读视图；运行时返回的是普通对象，调用方在类型层面不应改写它。
/** A CSS module scoped: its stylesheet with unique class names, and the mapping its import gives. */
export type ScopedCss = { readonly css: string; readonly classes: Readonly<Record<string, string>> };

// 虚拟命名空间标记。build.ts 看到 `chord-css-module:<name>` 形式的模块请求时，会到已收集的 scoped 结果里取，
// 而不是再去读磁盘，因此这个常量是两次构建之间的约定。
/** The namespace of a scoped stylesheet the facet's build imports. */
export const SCOPED_CSS = "chord-css-module";

/**
 * Scopes the CSS module `file` of the plugin `plugin` (its directory `dir`) with `contents`: every class renamed
 * `chord_<hash of plugin and path>_<file>_<class>`. Throws esbuild's failure (a syntax error) for the build to report.
 */
// 作用域化一个 CSS module。
// 输入：plugin 是插件包名；dir 是插件真实目录；file 是该 CSS 文件的绝对路径；contents 是文件当前内容。
// 输出：Promise<ScopedCss>，包含带唯一类名的 CSS 和 import 得到的映射。
// 副作用：在内存中运行一次 esbuild 构建，并用 vm 执行 esbuild 生成的映射模块；不写文件。
// 错误：CSS 语法错误等由 esbuild 以 BuildFailure 拒绝 Promise，由上层构建转成 facet 的失败消息。
// 主要流程：由插件名和相对路径算前缀 -> 构造一个导入虚拟 scoped 模块的 JS 入口 -> 用 local-css loader
// 让 esbuild 生成映射 -> 从输出文件里取 css 和 js -> 执行 js 读出 classes。
// 例子：scopeCssModule("@acme/notes", "/app/notes", "/app/notes/card.module.css", ".card{}")
// 会得到形如 `.chord_1a2b3c4d_card{...}` 的 CSS 和 { card: "chord_1a2b3c4d_card" } 的映射；
// 真实类名前缀取决于插件名和相对路径的哈希，示例数值不是固定值。
export async function scopeCssModule(plugin: string, dir: string, file: string, contents: string): Promise<ScopedCss> {
	// 前缀包含插件名和“相对插件目录的路径”，因此同名文件在不同插件里不会撞车，同一插件换检出目录也不变。
	// NUL 分隔两个字段，避免插件名与路径拼接时产生歧义；取 sha256 前 8 个十六进制字符足以区分且保持名字可读。
	const scope = createHash("sha256")
		.update(`${plugin}\0${relative(dir, file)}`)
		.digest("hex")
		.slice(0, 8);
	// esbuild names a local class `<file name>_<class>`: the file name carries the prefix.
	// esbuild 的 local-css 会把类名变成 `<文件名>_<类名>`，所以把哈希前缀放进文件名。
	// basename(file, ".module.css") 去掉固定后缀；replace 把文件名里 esbuild 标识符不接受的字符换成下划线。
	const name = `chord_${scope}_${basename(file, ".module.css").replace(/[^\w-]/g, "_")}`;
	// stdin 提供一个最小的 JS 入口，它默认转出虚拟模块 `scoped:<name>.module.css`；真正的 CSS 内容在 onLoad 里给。
	const result = await build({
		// loader: "js" 表示 stdin 的 contents 是 JavaScript；`export { default } from ...` 让映射模块的默认导出就是类名表。
		stdin: { contents: `export { default } from "scoped:${name}.module.css";`, loader: "js" },
		// bundle 把虚拟模块打进同一输出；write:false 只在内存返回 outputFiles；outdir "/" 是虚拟输出目录。
		// format:"cjs" 让产物用 module.exports 暴露映射，便于下面的 vm 直接读取；minifyWhitespace 压缩 CSS 空白。
		// logLevel:"silent" 避免内部试构建把警告直接打印到宿主日志，错误仍会以异常返回给调用方。
		bundle: true,
		write: false,
		outdir: "/",
		format: "cjs",
		minifyWhitespace: true,
		logLevel: "silent",
		// 内部插件只服务这次试构建；setup 注册解析与加载钩子：先拦截 scoped: 虚拟模块，再把 CSS 的 url()/@import 标成外部，最后提供内容。
		plugins: [
			{
				name: "chord-css-module",
				// 回调参数 builder 是本次构建的插件 API；这三个 onResolve/onLoad 都只在这个作用域内生效。
				setup: (builder) => {
					// args.path 形如 `scoped:card.module.css`，slice(7) 去掉 `scoped:` 前缀；namespace 把它和磁盘文件区分开。
					builder.onResolve({ filter: /^scoped:/ }, (args) => ({
						path: `/${args.path.slice(7)}`,
						namespace: "scoped",
					}));
					// Kept as written: the facet's build resolves them relative to the module file.
					// url-token（url(...)）和 import-rule（@import）不在这里打包，标成 external 后由 facet 构建按原 CSS 模块位置解析。
					// 其他类型返回 undefined，表示交回 esbuild 的默认解析流程。
					builder.onResolve({ filter: /.*/ }, (args) =>
						args.kind === "url-token" || args.kind === "import-rule"
							? { path: args.path, external: true }
							: undefined,
					);
					// 虚拟命名空间里的模块只有这一份内容，loader:"local-css" 负责重命名类名并生成映射。
					builder.onLoad({ filter: /.*/, namespace: "scoped" }, () => ({ contents, loader: "local-css" }));
				},
			},
		],
	});
	// esbuild 每次构建会同时产出 CSS 和供导入方使用的 JS；?? "" 是找不到时的兜底，正常情况下两者都存在。
	const css = result.outputFiles.find((output) => output.path.endsWith(".css"))?.text ?? "";
	const js = result.outputFiles.find((output) => output.path.endsWith(".js"))?.text ?? "";
	// esbuild's mapping module (an object of strings it wrote), run alone to read the mapping.
	// 用一个最小的 CommonJS 环境执行映射模块：module.exports 会收到 { default: { 原类名: 生成类名 } }。
	// 类型断言只描述预期结构，运行时若 esbuild 改变产物格式，这里并不会校验。
	const module = { exports: {} as { default?: Record<string, string> } };
	// runInNewContext 创建全新的全局环境，映射模块看不到宿主的全局变量。
	new Script(js).runInNewContext({ module, exports: module.exports });
	// 展开成普通对象，避免把 vm 里的默认导出对象直接泄漏给调用方；classes 的值的类型仍由上面的断言假定。
	return { css, classes: { ...module.exports.default } };
}
