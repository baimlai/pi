// 文件导读
// 所属：仓库根 scripts/ 的浏览器构建冒烟检查，是 npm run check:browser-smoke 的实现，也被 npm run check 和 pre-commit 钩子调用。
// 职责：用 esbuild 以 platform=browser 打包三个入口，检查模块图里没有 Node 专属适配器、没有多余供应商 SDK/目录。
// 上游：根 package.json → node scripts/check-browser-smoke.mjs。下游：esbuild、三个 scripts/*-smoke-entry.ts。
// 输入：无参数；读取工作区源码与 packages/ai/src/providers/data 下已水合的模型数据。
// 输出：成功时无输出并以 0 退出；失败时把详细错误写到 /tmp/pi-browser-smoke-errors.log，stderr 打印日志路径，以 1 退出。
// 副作用：第一次 build 会实际写 /tmp/pi-browser-smoke.js（其余两次 write:false）；不执行打包产物，不联网。
// 检查项：
//   1. browser-smoke-entry.ts 能在 browser 平台完成打包（打印式通用冒烟）。
//   2. Durable 浏览器包包含四个公共入口的源码，且不包含 env/jsonl/sqlite 的 node.ts 适配器。
//   3. 选择性供应商入口不包含 compat.ts、models.generated.ts、providers/all.ts。
//   4. 该入口只产生一份供应商目录 anthropic.json。
//   5. 只打包 @anthropic-ai/sdk，不含其他生成式 SDK。
// 前置：需要已经安装依赖；模型 JSON 缺失时插件用空对象替代，避免新 checkout 直接失败。
// 示例：npm run check:browser-smoke
// 建议阅读顺序：先看 generatedCatalogDataPlugin，再看三个 build 调用及其断言，最后看 catch 里的错误格式化。
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";

const outputPath = join(tmpdir(), "pi-browser-smoke.js");
const durableOutputPath = join(tmpdir(), "pi-durable-browser-smoke.js");
const agentTreeshakeOutputPath = join(tmpdir(), "pi-agent-treeshake-smoke.js");
const errorLogPath = join(tmpdir(), "pi-browser-smoke-errors.log");
// 供应商数据目录的绝对路径；插件只在这个目录内、且文件不存在时提供空 JSON。
const generatedCatalogDataDir = join(process.cwd(), "packages/ai/src/providers/data");

// Fresh checkouts do not materialize provider JSON until model data is hydrated.
// esbuild 插件：拦截 providers 源码里的 ./data/*.json；已生成的文件照常读取，缺失时用 {} 代替。
const generatedCatalogDataPlugin = {
	name: "generated-model-catalog",
	setup(build) {
		build.onResolve({ filter: /^\.\/data\/[^/]+\.json$/ }, (args) => {
			// importer 是发起导入的源文件；resolve 出目标 JSON 的绝对路径。
			const path = resolve(dirname(args.importer), args.path);
			// 只处理生成目录；已存在则返回 undefined 交给默认加载，避免覆盖真实数据。
			if (dirname(path) !== generatedCatalogDataDir || existsSync(path)) return;
			// 用私有命名空间标记“这是缺失数据的替身”，随后 onLoad 返回空对象。
			return { path, namespace: "empty-generated-model-catalog" };
		});
		build.onLoad({ filter: /.*/, namespace: "empty-generated-model-catalog" }, () => ({
			contents: "{}",
			loader: "json",
		}));
	},
};

// Windows metafile 使用反斜杠；统一成正斜杠后做后缀比较，避免平台相关误判。
function normalizePath(path) {
	return path.replaceAll("\\", "/");
}

// 输入：metafile.inputs 的键集合与目标后缀。输出：匹配的输入键或 undefined。
// 同时接受完全相等和 "/suffix" 结尾，因为 esbuild 可能给出相对仓库根或绝对路径。
function findInput(inputs, suffix) {
	return Object.keys(inputs).find((input) => {
		const normalized = normalizePath(input);
		return normalized === suffix || normalized.endsWith(`/${suffix}`);
	});
}

// 输入：inputs 与包名。输出：布尔值，表示模块图是否包含该 node_modules 包目录下的文件。
// 只按路径包含 node_modules/<name>/ 判断，不分析 package.json 依赖声明。
function includesNodePackage(inputs, packageName) {
	const marker = `node_modules/${packageName}/`;
	return Object.keys(inputs).some((input) => normalizePath(input).includes(marker));
}

try {
	// 第一项：通用入口只要能以 browser 平台打包成功即可；这里不检查 metafile，失败即 esbuild 抛错。
	await build({
		entryPoints: ["scripts/browser-smoke-entry.ts"],
		bundle: true,
		platform: "browser",
		format: "esm",
		// silent 把错误交给下面的 catch 统一格式化；outfile 是实际写入的临时文件。
		logLevel: "silent",
		outfile: outputPath,
		plugins: [generatedCatalogDataPlugin],
	});

	// 第二项：Durable 的浏览器安全入口。write:false 表示只在内存里产出，不会写 durableOutputPath。
	const durableBuild = await build({
		entryPoints: ["scripts/durable-browser-smoke-entry.ts"],
		bundle: true,
		platform: "browser",
		format: "esm",
		logLevel: "silent",
		metafile: true,
		outfile: durableOutputPath,
		write: false,
	});
	// metafile.inputs 记录所有参与打包的源文件；下面正向断言浏览器入口确实包含公共源码。
	const durableInputs = durableBuild.metafile.inputs;
	for (const expectedInput of [
		"packages/durable/src/index.ts",
		"packages/durable/src/env/index.ts",
		"packages/durable/src/storage/jsonl/index.ts",
		"packages/durable/src/storage/jsonl/storage.ts",
		"packages/durable/src/storage/memory.ts",
		"packages/durable/src/storage/sqlite/index.ts",
		"packages/durable/src/storage/sqlite/storage.ts",
	]) {
		if (!findInput(durableInputs, expectedInput)) {
			throw new Error(`Durable browser bundle does not include ${expectedInput}`);
		}
	}
	// 反向断言：这三个文件使用 Node 内置模块，浏览器包绝不能包含它们。
	for (const forbiddenInput of [
		"packages/durable/src/env/node.ts",
		"packages/durable/src/storage/jsonl/node.ts",
		"packages/durable/src/storage/sqlite/node.ts",
	]) {
		const nodeAdapter = findInput(durableInputs, forbiddenInput);
		if (nodeAdapter) throw new Error(`Durable browser bundle unexpectedly includes ${nodeAdapter}`);
	}

	// 第三项：选择性供应商入口，仍只打包到内存并保留 metafile。
	const agentTreeshakeBuild = await build({
		entryPoints: ["scripts/agent-treeshake-smoke-entry.ts"],
		bundle: true,
		platform: "browser",
		format: "esm",
		logLevel: "silent",
		metafile: true,
		outfile: agentTreeshakeOutputPath,
		plugins: [generatedCatalogDataPlugin],
		write: false,
	});
	const inputs = agentTreeshakeBuild.metafile.inputs;
	// 按需导入不应通过桶文件把所有供应商/全量目录带进来。
	for (const forbiddenInput of [
		"packages/ai/src/compat.ts",
		"packages/ai/src/models.generated.ts",
		"packages/ai/src/providers/all.ts",
	]) {
		const includedInput = findInput(inputs, forbiddenInput);
		if (includedInput) {
			throw new Error(`Agent selective-provider bundle unexpectedly includes ${includedInput}`);
		}
	}

	// output.inputs 的值含 bytesInOutput：只统计真正贡献了字节的输入，排除被 tree-shaking 完全删除的文件。
	const contributingInputs = new Set(
		Object.values(agentTreeshakeBuild.metafile.outputs).flatMap((output) =>
			Object.entries(output.inputs)
				.filter(([, contribution]) => contribution.bytesInOutput > 0)
				.map(([input]) => input),
		),
	);
	// 只允许 Anthropic 的目录 JSON 真正贡献字节；其他供应商目录出现就说明选择性导入失效。
	const catalogInputs = Array.from(contributingInputs).filter((input) =>
		normalizePath(input).includes("packages/ai/src/providers/data/"),
	);
	if (catalogInputs.length !== 1 || !normalizePath(catalogInputs[0]).endsWith("/anthropic.json")) {
		throw new Error(
			`Agent selective-provider bundle catalogs: expected only anthropic.json, found ${catalogInputs.join(", ") || "none"}`,
		);
	}

	// 生成式 SDK 是体积最大的依赖；选择性入口只应带入 Anthropic 一家。
	const aiSdkPackages = [
		"@anthropic-ai/sdk",
		"@aws-sdk/client-bedrock-runtime",
		"@google/genai",
		"@mistralai/mistralai",
		"openai",
	];
	const includedAiSdkPackages = aiSdkPackages.filter((packageName) => includesNodePackage(inputs, packageName));
	if (
		includedAiSdkPackages.length !== 1 ||
		includedAiSdkPackages[0] !== "@anthropic-ai/sdk"
	) {
		throw new Error(
			`Agent selective-provider bundle SDKs: expected only @anthropic-ai/sdk, found ${includedAiSdkPackages.join(", ") || "none"}`,
		);
	}

	// 显式 0 退出；try 中没有 finally，正常路径也无临时文件需要清理（输出在系统 tmp）。
	process.exit(0);
} catch (error) {
	// esbuild 的 BuildFailure 带 errors 数组；其他错误（含上面主动抛出的断言）只有 message/stack。
	let detailedErrors = "";
	if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
		detailedErrors = error.errors
			.map((entry) => {
				const location = entry.location
					? `${entry.location.file}:${entry.location.line}:${entry.location.column}`
					: "";
				return [location, entry.text].filter(Boolean).join(" ");
			})
			.join("\n");
	}

	// 非 Error 的抛出值（理论上 esbuild 不会这样）也要转成可读文字。
	const baseError = error instanceof Error ? (error.stack ?? error.message) : String(error);
	// 把结构化错误和堆栈一起写入固定路径，方便 CI 收集；stderr 只提示路径，避免日志过长。
	writeFileSync(errorLogPath, [detailedErrors, baseError].filter(Boolean).join("\n\n"), "utf-8");
	console.error(`Browser smoke check failed. See ${errorLogPath}`);
	process.exit(1);
}
