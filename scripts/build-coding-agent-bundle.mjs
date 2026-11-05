#!/usr/bin/env node
// 文件导读
// 所属：仓库根 scripts/ 的 coding-agent 发布打包器，被 packages/coding-agent 的 `npm run build` 在 tsc 之后调用。
// 职责：用 esbuild 把已编译的 dist/*.js 打成 ESM bundle，并单独产出通过动态路径/worker URL 加载的实现文件。
//   主包保留三个入口（cli-runtime、index、rpc-entry）和共享 chunk；OAuth、Bedrock、图像缩放 worker、codemode worker
//   各有独立自包含文件，避免 esbuild 无法跟随变量说明符时在运行时找不到模块。
// 上游：packages/coding-agent `npm run build` → `build:unbundled`（tsc + copy-assets）→ 本脚本。
// 下游依赖：esbuild、packages/ai/dist、packages/coding-agent/dist 以及各包的 package.json。
// 输入：无命令行参数；只读工作区的 dist 产物和 packages/ai/src/auth/oauth/load.ts。输出：dist/bundle/ 下的 JS 文件，
//   成功时 stdout 打印文件数与 MiB。副作用：递归删除并重建 dist/bundle，给 cli.js/rpc-entry.js 设可执行位。
// 失败路径：必需入口缺失、意外外部依赖、OAuth 懒入口未登记、codemode worker 导入非内置模块或使用 import.meta 时抛错，
//   顶层 await 使进程以非零码退出；失败前可能已删除旧 bundle。
// 前置：先构建全部工作区包（尤其 packages/ai 的 dist）；脚本本身不运行 tsc、不联网、不执行打包产物。
// 示例：
//   npm --prefix packages/coding-agent run build
//   node scripts/build-coding-agent-bundle.mjs   # 需要 dist 已存在
// 建议阅读顺序：先看常量与两个 esbuild 插件，再看 commonBuildOptions/validateExternalImports，
//   然后按主包→懒入口→codemode worker 的顺序读顶层流程，最后看 launcher 与输出统计。

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// isBuiltin 判断 esbuild 标记为 external 的模块是否是 Node 内置模块（如 node:fs）。
import { isBuiltin } from "node:module";
// 路径工具：dirname/join/resolve 组合目录，relative 只用于日志中显示相对路径。
import { dirname, join, relative, resolve } from "node:path";
// import.meta.url 是当前 ESM 文件 URL；fileURLToPath 转成本机路径后才能 derive 仓库根。
import { fileURLToPath } from "node:url";
// esbuild 的 JS API；顶层 await build(...) 是异步构建调用。
import { build } from "esbuild";

// 所有路径都由脚本位置推出，不依赖调用者 cwd。
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
// 三个关键目录：coding-agent 源码包目录、pi-ai 的编译输出、coding-agent 的编译输出。
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const aiDistDir = join(repoRoot, "packages", "ai", "dist");
const codingAgentDistDir = join(codingAgentDir, "dist");
const bundleDir = join(codingAgentDistDir, "bundle");
// banner 插到每个 ESM 输出顶部：给依赖 CJS/动态 require 的代码补一个基于当前模块 URL 的 require。
// 注意不能用 __dirname；bundle 是 ESM，createRequire(import.meta.url) 才能正确解析相对包。
const banner = {
	js: 'import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);',
};
// 允许保持 external（不打包）的包：运行时由 Node 从 node_modules 解析，或属于可选原生加速器。
// 这个名单同时被 validateExternalImports 使用；新增依赖若被意外留下，构建会失败并要求明确决策。
const allowedExternalPackages = new Set([
	"@silvia-odwyer/photon-node",
	"jiti",
	// Optional native accelerators. Their callers fall back to JavaScript when absent.
	"bufferutil",
	"utf-8-validate",
	// Optional native proxy authentication. Its caller reports an install hint when absent.
	"kerberos",
	// Optional debug output coloring.
	"supports-color",
]);

// esbuild 插件对象：name 用于诊断；setup 在每次构建时注册 resolve/load 回调。
// 目标是把 `jiti/static` 替换成一个只在首次使用时才 require("jiti") 的薄包装，避免启动即加载 Babel。
const lazyJitiPlugin = {
	name: "lazy-jiti-transform",
	setup(build) {
		// onResolve 拦截说明符 jiti/static，给它一个私有命名空间，随后由 onLoad 提供虚拟内容。
		build.onResolve({ filter: /^jiti\/static$/ }, () => ({
			namespace: "lazy-jiti",
			path: "jiti/static",
		}));
		// onLoad 只在上述命名空间内匹配，返回 contents 字符串作为模块源码；这段字符串本身不能插注释。
		build.onLoad({ filter: /.*/, namespace: "lazy-jiti" }, () => ({
			contents: `
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let createJitiImpl;

export function createJiti(...args) {
	createJitiImpl ??= require("jiti").createJiti;
	return createJitiImpl(...args);
}
`,
			loader: "js",
		}));
	},
};

// 动态 import("https-proxy-agent") 在 ESM bundle 中没有命名导出，esbuild 无法静态分析；
// 这个插件把动态导入重定向到一个静态转出 HttpsProxyAgent 的虚拟模块，保证运行时命名导出存在。
const httpsProxyAgentNamedExportPlugin = {
	name: "https-proxy-agent-named-export",
	setup(build) {
		build.onResolve({ filter: /^https-proxy-agent$/ }, (args) => {
			// 只处理 dynamic-import 类型；普通 import 交给默认解析。
			if (args.kind !== "dynamic-import") return undefined;
			return {
				namespace: "https-proxy-agent-named-export",
				path: args.path,
			};
		});
		// 虚拟模块只做一件事：静态重导出 HttpsProxyAgent；resolveDir 让 esbuild 从仓库根解析真实包。
		build.onLoad(
			{
				filter: /^https-proxy-agent$/,
				namespace: "https-proxy-agent-named-export",
			},
			() => ({
				contents: 'export { HttpsProxyAgent } from "https-proxy-agent";',
				loader: "js",
				resolveDir: repoRoot,
			}),
		);
	},
};

// 返回三类构建共享的 esbuild 配置；调用方再用对象展开追加 entryPoints/outdir/splitting 等差异项。
// 输入：无参数。输出：普通配置对象（不启动构建）。错误：无。
// 示例：const options = { ...commonBuildOptions(), entryPoints: {...} }; await build(options);
function commonBuildOptions() {
	return {
		// 解析与插件工作目录固定为仓库根，避免受调用者 cwd 影响。
		absWorkingDir: repoRoot,
		banner,
		// bundle 让 esbuild 把可达依赖合入产物；define 在编译期替换全局常量。
		bundle: true,
		define: { PI_BUNDLED_NODE: "true" },
		// photon 是 wasm 包，保持外部依赖随安装分发，不尝试内联。
		external: ["@silvia-odwyer/photon-node"],
		format: "esm",
		// 不保留第三方版权注释；legalComments 只影响源码中的注释文本。
		legalComments: "none",
		// warning 级别让非致命告警可见，但不把 info 噪音刷满日志。
		logLevel: "warning",
		// metafile 记录输入/输出图，后面用来检查外部依赖、定位 chunk 和统计体积。
		metafile: true,
		minifySyntax: true,
		minifyWhitespace: true,
		platform: "node",
		// The source uses jiti/static so Bun embeds its Babel transform. The Node
		// package replaces it with a synchronous lazy require so jiti loads only
		// when importing an extension; Babel remains deferred until a cache miss
		// needs transformation.
		plugins: [lazyJitiPlugin, httpsProxyAgentNamedExportPlugin],
		// 发布产物不带 sourcemap；调试依赖未压缩的 unbundled dist。
		sourcemap: false,
		// 语法目标与仓库支持的 Node 版本一致；低于该版本不保证类型剥离等特性可用。
		target: "node22.19",
		// Do not apply the monorepo's source-oriented path aliases while bundling
		// compiled output. Release builds must resolve the same package entries as
		// an installed npm package.
		tsconfigRaw: { compilerOptions: {} },
	};
}

// 输入：三次构建的 metafile 数组。输出：无；发现未允许的外部依赖时抛错，使构建失败。
// 只拒绝“非内置、又不在 allowlist”的 external——也就是安装后可能缺失或未经审查的运行时依赖。
function validateExternalImports(metafiles) {
	// Set 自动去重，错误信息里每个包只出现一次。
	const unexpected = new Set();
	for (const metafile of metafiles) {
		// 旧版 esbuild 的 inputs 是对象；这里遍历每个输入模块记录的 imports 列表。
		for (const input of Object.values(metafile.inputs)) {
			for (const imported of input.imports) {
				// 非 external 的导入已被打包，不需要检查；内置模块与 allowlist 包也跳过。
				if (!imported.external || isBuiltin(imported.path) || allowedExternalPackages.has(imported.path)) {
					continue;
				}
				unexpected.add(imported.path);
			}
		}
	}
	if (unexpected.size > 0) {
		throw new Error(`Bundle left unexpected external imports: ${Array.from(unexpected).sort().join(", ")}`);
	}
}

// 输入：某次构建的 metafile 与一个源文件路径后缀。输出：包含该输入的输出文件绝对路径。
// 用途：懒加载代码会与主 bundle 落在同一个 chunk 目录，后续必须把懒入口写到该目录旁边。
function findContainingOutput(metafile, inputSuffix) {
	// Windows 路径用反斜杠；统一成正斜杠后再比较后缀。
	const normalizedSuffix = inputSuffix.replaceAll("\\", "/");
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		// output.inputs 的键是参与该输出的源文件（可能为相对仓库根路径）。
		if (Object.keys(output.inputs).some((inputPath) => inputPath.replaceAll("\\", "/").endsWith(normalizedSuffix))) {
			return resolve(repoRoot, outputPath);
		}
	}
	throw new Error(`Could not locate bundled output containing ${inputSuffix}`);
}

// 输入：metafile 数组。输出：所有输出文件字节数之和；用于日志中的体积统计，不影响构建决定。
function outputBytes(metafiles) {
	return metafiles.reduce(
		(total, metafile) => total + Object.values(metafile.outputs).reduce((subtotal, output) => subtotal + output.bytes, 0),
		0,
	);
}

// 在动任何输出之前先确认输入齐全；缺一个就给出相对路径并提示先构建工作区，避免删掉旧 bundle 后才失败。
for (const entry of [
	join(codingAgentDistDir, "cli.js"),
	join(codingAgentDistDir, "index.js"),
	join(codingAgentDistDir, "rpc-entry.js"),
	join(codingAgentDistDir, "utils", "image-resize-worker.js"),
	join(codingAgentDistDir, "extensions", "codemode", "worker.js"),
	join(aiDistDir, "api", "bedrock-converse-stream.js"),
	join(aiDistDir, "auth", "oauth", "anthropic.js"),
]) {
	if (!existsSync(entry)) {
		throw new Error(`Bundle input is missing: ${relative(repoRoot, entry)}. Build the workspace packages first.`);
	}
}

// force 让目录不存在时也不报错；这是唯一会删除已有输出的位置，失败后不会自动恢复旧 bundle。
rmSync(bundleDir, { force: true, recursive: true });
mkdirSync(bundleDir, { recursive: true });

// 主构建：三个公开入口共享 chunk。splitting 只有在多个入口时才有意义，chunkNames 决定共享代码文件名。
const mainResult = await build({
	...commonBuildOptions(),
	// entryNames 不含路径模板，入口文件名保持 cli-runtime.js/index.js/rpc-entry.js。
	entryNames: "[name]",
	entryPoints: {
		"cli-runtime": join(codingAgentDistDir, "cli.js"),
		index: join(codingAgentDistDir, "index.js"),
		"rpc-entry": join(codingAgentDistDir, "rpc-entry.js"),
	},
	outdir: bundleDir,
	// 共享代码放到 chunks/ 子目录并带内容哈希，避免不同构建之间缓存串用。
	chunkNames: "chunks/[name]-[hash]",
	splitting: true,
});

// 这四行从 metafile 反查主构建把对应源文件放进了哪个输出，随后懒入口必须写到同一目录。
const bedrockLoaderOutput = findContainingOutput(mainResult.metafile, "packages/ai/dist/api/bedrock-converse-stream.lazy.js");
const oauthLoaderOutput = findContainingOutput(mainResult.metafile, "packages/ai/dist/auth/oauth/load.js");
const imageResizeOutput = findContainingOutput(mainResult.metafile, "packages/coding-agent/dist/utils/image-resize.js");
const configOutput = findContainingOutput(mainResult.metafile, "packages/coding-agent/dist/config.js");
// 两个懒加载器由 config/认证代码按相对路径解析；若被拆到不同目录，运行时会找不到。
if (dirname(bedrockLoaderOutput) !== dirname(oauthLoaderOutput)) {
	throw new Error("Bedrock and OAuth lazy loaders were emitted into different directories");
}

// These implementations are reached through variable-specifier imports or a
// worker URL, so the main bundle cannot follow them. Emit one self-contained
// file per implementation beside the code that resolves it.
const lazyEntryPoints = {
	anthropic: join(aiDistDir, "auth", "oauth", "anthropic.js"),
	"bedrock-converse-stream": join(aiDistDir, "api", "bedrock-converse-stream.js"),
	"github-copilot": join(aiDistDir, "auth", "oauth", "github-copilot.js"),
	"image-resize-worker": join(codingAgentDistDir, "utils", "image-resize-worker.js"),
	"kimi-coding": join(aiDistDir, "auth", "oauth", "kimi-coding.js"),
	meta: join(aiDistDir, "auth", "oauth", "meta.js"),
	"openai-chatgpt": join(aiDistDir, "auth", "oauth", "openai-chatgpt.js"),
	"openai-codex": join(aiDistDir, "auth", "oauth", "openai-codex.js"),
	openrouter: join(aiDistDir, "auth", "oauth", "openrouter.js"),
	radius: join(aiDistDir, "auth", "oauth", "radius.js"),
	xai: join(aiDistDir, "auth", "oauth", "xai.js"),
};

// Every OAuth flow loaded through importOAuthModule() must have a lazy entry,
// otherwise the flow fails at runtime with a missing module error.
// 这里直接读源码文本而不是 import 类型：只要 load.ts 新增一个 importOAuthModule("./x.ts")，就要求同步补懒入口。
const oauthLoadSource = readFileSync(join(repoRoot, "packages", "ai", "src", "auth", "oauth", "load.ts"), "utf8");
// matchAll 要求全局正则；捕获组 1 是去掉 .ts 的流程名。
for (const match of oauthLoadSource.matchAll(/importOAuthModule\("\.\/([^"]+)\.ts"\)/g)) {
	// in 运算符检查对象自有/继承属性；漏登记就立刻失败，而不是等用户登录时才 404。
	if (!(match[1] in lazyEntryPoints)) {
		throw new Error(`OAuth flow "${match[1]}" is lazily imported but has no lazy bundle entry`);
	}
}

// 第二次构建：每个懒入口独立自包含（splitting=false），因为运行时按路径单独加载它们。
// 输出目录与主 bundle 的 loader chunk 相同，相对路径才能解析到这些文件。
const lazyResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: lazyEntryPoints,
	outdir: dirname(bedrockLoaderOutput),
	splitting: false,
});

// getCodemodeWorkerSpecifier() in config.ts spawns the codemode worker from an in-memory data: URL
// so codemode survives an update that replaces or deletes the install (#10439). A data: URL module
// has no file location, so the worker must not use the createRequire(import.meta.url) banner,
// require(), or imports other than Node builtins.
// 第三次构建：codemode worker 例外地不使用 banner，因为 data: URL 模块没有可用的 import.meta.url。
const codemodeWorkerResult = await build({
	...commonBuildOptions(),
	banner: undefined,
	entryNames: "[name]",
	entryPoints: { "codemode-worker": join(codingAgentDistDir, "extensions", "codemode", "worker.js") },
	outdir: dirname(bedrockLoaderOutput),
	splitting: false,
});
// 逐输出检查 worker 的静态 import：只允许 Node 内置模块，且必须是普通 import 语句。
for (const [outputPath, output] of Object.entries(codemodeWorkerResult.metafile.outputs)) {
	const invalid = output.imports.filter((imported) => imported.kind !== "import-statement" || !isBuiltin(imported.path));
	if (invalid.length > 0) {
		throw new Error(
			`Codemode worker must only import Node builtins: ${invalid.map((imported) => imported.path).join(", ")}`,
		);
	}
	// data: URL 没有模块 URL，任何 import.meta 访问都会在运行时抛错，因此按文本再查一遍。
	if (readFileSync(resolve(repoRoot, outputPath), "utf8").includes("import.meta")) {
		throw new Error("Codemode worker must not use import.meta");
	}
}

// 图像缩放实现与它的 worker 也必须落在同一目录，否则 config.ts 的相对 URL 解析不到。
const imageResizeWorkerOutput = resolve(dirname(bedrockLoaderOutput), "image-resize-worker.js");
if (dirname(imageResizeOutput) !== dirname(imageResizeWorkerOutput)) {
	throw new Error("Image resize implementation and worker were emitted into different directories");
}
// getCodemodeWorkerUrl() in config.ts resolves the worker next to its own chunk.
if (dirname(configOutput) !== dirname(bedrockLoaderOutput)) {
	throw new Error("config.ts and the codemode worker were emitted into different directories");
}

// 三次构建都完成后统一校验外部依赖，避免某次单独漏检。
const metafiles = [mainResult.metafile, lazyResult.metafile, codemodeWorkerResult.metafile];
validateExternalImports(metafiles);
// 真正的 bin 入口是一个极小的 launcher：先启用 Node 的编译缓存，再同步 require 主 bundle。
// 用绝对脚本路径的 createRequire 解析 ./cli-runtime.js，因此入口文件可以被 symlink 到 PATH。
const cliLauncher = `#!/usr/bin/env node
import { createRequire, enableCompileCache } from "node:module";

enableCompileCache();
createRequire(import.meta.url)("./cli-runtime.js");
`;
writeFileSync(join(bundleDir, "cli.js"), cliLauncher);
// 0o755 = 用户读写执行、组和其他人读执行；发布归档解压后可直接运行。
chmodSync(join(bundleDir, "cli.js"), 0o755);
chmodSync(join(bundleDir, "rpc-entry.js"), 0o755);

// Set 去重输出路径（共享 chunk 只算一次），+1 是手写的 cli.js launcher。
const files = new Set(metafiles.flatMap((metafile) => Object.keys(metafile.outputs))).size + 1;
// 体积按字节换算 MiB；toFixed(1) 只影响日志精度。
const mib = (outputBytes(metafiles) + cliLauncher.length) / (1024 * 1024);
console.log(`Built ${relative(repoRoot, bundleDir)} (${files} files, ${mib.toFixed(1)} MiB)`);
