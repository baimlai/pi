// Base bundles (slice 11 §1, decision "Slice 11, P3"): a client kind's base code built on the server at start by
// esbuild from the app's entry (its start code, its API with the kind's module, Chord, React: inlined once), named by
// the hash of everything it is made of, served forever. A page's is a browser script with its stylesheet and assets;
// a terminal's one CommonJS script the sandbox evaluates with its own `require` (its allowed builtins only).
// 所属：node/surfaces 的服务器侧基础包构建；依赖 esbuild、node:crypto/node:path 与 served 的资源类型。
// 职责：把应用入口打包成内容寻址的 JS（浏览器 IIFE 或沙箱 CommonJS），并收集 CSS/资源到内存 Map。
// 边界：不写磁盘、不发布 URL、不启动服务器；esbuild 构建失败直接向 webSurface/tuiSurface 传播。
// 上游：webSurface/tuiSurface 在服务器启动时调用 buildBase；下游：esbuild 读取入口及依赖，ServedFile 交给 served 响应。
// 导出清单：BaseBundle 是 hash/script/style/files；BasePlatform 是 "browser" | "sandbox"；buildBase 是唯一函数。
// 组合：buildBase → BaseBundle.files → 路由 serve；hash 用于 start 端点和客户端判断基础代码是否过期。
// 示例：const base = await buildBase("./src/web.ts", "browser", WEB_PREFIX);
// 阅读顺序：BaseBundle → BasePlatform → buildBase 的选项 → 哈希 → 文件分类 → 返回对象。

import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { build } from "esbuild";
import { CSS, JAVASCRIPT, mimeOf, type ServedFile } from "./served.ts";

/**
 * A built base bundle: its hash, its script's and stylesheet's paths (under the surface's prefix), and every file by
 * path.
 */
export type BaseBundle = {
	// readonly 只限制 TypeScript 调用方赋值，不会冻结 Map 或字节；这些资源按约定不再修改。
	readonly hash: string;
	// script/style：入口脚本与可选样式表的内容寻址 URL；浏览器页面必须插入 script，样式可为空。
	readonly script: string;
	// style：入口导入 CSS 时存在；沙箱平台通常没有样式，因此类型允许 undefined。
	readonly style: string | undefined;
	// files：路径 → MIME/字节的只读视图；键是完整发布 URL，值为内存文件，后续路由按路径查找。
	readonly files: ReadonlyMap<string, ServedFile>;
};

/** Where a base bundle runs: a page (a script, its CSS and assets), or a terminal's sandbox (one CommonJS script). */
// 平台决定输出格式和目标：browser 生成 IIFE（页面直接执行），sandbox 生成 CommonJS（启动器在沙箱求值）。
export type BasePlatform = "browser" | "sandbox";

/**
 * Builds the base bundle of `entry` for `platform`, its files under `prefix` (`/_chord/web/`): the script
 * `base.<hash>.js`, the stylesheet `base.<hash>.css` when it imports CSS, assets under `assets/` by their own hashes.
 * Throws esbuild's failure: the server does not start with a broken base.
 */
// 把应用入口 entry 连同依赖打成客户端基础包，返回内容摘要、脚本/CSS URL 与内存文件表。
// platform 决定浏览器 IIFE 或沙箱 CommonJS，prefix 是发布 URL 前缀；会读源码并调用 esbuild，
// 但 write:false 不落盘。构建错误向上抛出。例如浏览器入口可得到 /_chord/web/base.<摘要>.js；
// 这是路径形状示例，实际摘要由全部输出的路径和字节决定。Promise<BaseBundle> 表示异步结果的类型，非运行时校验。
export async function buildBase(entry: string, platform: BasePlatform, prefix: string): Promise<BaseBundle> {
	// 字符串字面量联合类型允许两个平台；这里比较实际值，供下方成组选项选择。
	const browser = platform === "browser";
	// await 等待一次真实构建；返回的 outputFiles 是 write:false 时保留在内存的产物。
	const result = await build({
		// 单入口，虚拟输出目录为根目录；这里只借路径命名，并不会写入该目录。
		// 单入口打包，应用入口会静态导入其 API/组件/Chord；这些依赖被内联进基础包。
		entryPoints: [entry],
		outdir: "/",
		entryNames: "base",
		assetNames: "assets/[name]-[hash]",
		publicPath: prefix,
		// 禁止写盘，并把静态依赖合并到基础包；基础包与逐插件脚本有不同的构建入口。
		write: false,
		bundle: true,
		// 三元表达式 condition ? a : b 按平台选择格式、可用平台模块和目标语法版本。
		format: browser ? "iife" : "cjs",
		platform: browser ? "browser" : "node",
		target: browser ? "es2022" : "node22",
		// 压缩输出减小下载体积；源码映射未开启，因此插件脚本的内联 map 与基础包无关。
		minify: true,
		// 去掉 legal comment；原源码的学习注释不会成为基础包中的运行逻辑。
		legalComments: "none",
		// Ignore any tsconfig.json: TypeScript is stripped, JSX compiled with the automatic React runtime.
		tsconfigRaw: "{}",
		jsx: "automatic",
		// 将这个环境表达式替成字符串字面量，构建器据此裁掉开发分支；没有改宿主的 process.env。
		define: { "process.env.NODE_ENV": '"production"' },
		// 构建诊断由抛出的异常携带，不直接打印到服务器 stderr；失败由启动流程决定如何报告。
		logLevel: "silent",
	});
	// SHA-256 增量吸收所有输出。摘要包含 CSS 和资源，因此任一产物变化都可改变基础包版本。
	const hash = createHash("sha256");
	// [...] 复制数组以便排序而不改 result；排序回调按路径比较，稳定构造同一组输出的输入顺序。
	for (const output of [...result.outputFiles].sort((a, b) => (a.path < b.path ? -1 : 1))) {
		// update 返回同一 Hash，可链式调用；先路径、再原始字节。
		hash.update(output.path).update(output.contents);
	}
	// 转十六进制并取前16字符作为资源名，不是完整 SHA-256 或安全认证凭据。
	const digest = hash.digest("hex").slice(0, 16);
	// Map<string, ServedFile> 将 URL 映射到 MIME 与字节；泛型只在开发时约束键值类型。
	const files = new Map<string, ServedFile>();
	// 在遍历时记住主脚本 URL；没有样式时 style 保持 undefined，联合类型用 | 表示。
	let script = "";
	let style: string | undefined;
	for (const output of result.outputFiles) {
		// extname 包含点，如 .js；basename 去掉目录。base.js/base.css 是入口产物。
		const extension = extname(output.path);
		if (basename(output.path) === `base${extension}`) {
			// 模板字符串把公共前缀、整包摘要、扩展名拼成发布路径。
			const path = `${prefix}base.${digest}${extension}`;
			// 脚本单独记 script；其余匹配 base 的产物记 style。这里依赖构建产物形状。
			if (extension === ".js") script = path;
			else style = path;
			// 同一批构建输出字节直接留在 Map 中，没有额外复制。
			files.set(path, { mime: extension === ".js" ? JAVASCRIPT : CSS, bytes: output.contents });
		} else {
			// 其他产物沿用 esbuild 自己的内容散列文件名，并按扩展名选择 MIME。
			files.set(`${prefix}assets/${basename(output.path)}`, { mime: mimeOf(output.path), bytes: output.contents });
		}
	}
	// 对象属性简写把同名变量装入返回值；style 即便为空也作为 undefined 属性返回。
	return { hash: digest, script, style, files };
}
