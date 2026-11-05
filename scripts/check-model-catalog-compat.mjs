#!/usr/bin/env node

// 文件导读
// 所属：仓库根 scripts/ 的模型目录兼容性检查，npm run check:model-catalog-compat 的实现，发布模型目录的 CI 会运行。
// 职责：用 npm 上最新已发布 pi-ai 的源码与内置模型数据，叠加本次待发布目录，再跑该版本的 TypeScript 类型检查。
//   若新目录用到了旧代码不支持的 api/字段，类型错误会让发布前检查失败，避免已发布客户端拿到无法处理的模型。
// 上游：package.json → node scripts/check-model-catalog-compat.mjs [--catalog <file>]；
//   .github/workflows/publish-model-catalog.yml 在发布前调用。
// 下游：会执行 git archive、npm view/pack/ci/run build、Node 脚本 hydrate-model-catalog.ts、tsc；
//   需要网络与 npm registry，且依赖本地 git 中存在 v<release> 标签。
// 输入：--catalog 指定的目录 JSON，默认 .artifacts/model-catalog/models.all.json（由 npm run generate:model-catalog 生成）。
// 输出：stdout 打印检查进度/跳过原因/成功信息；失败时 stderr 打印命令输出与修复建议，退出码 1。
// 副作用：在系统临时目录解包发布源码、下载并安装依赖、构建工作区包、临时运行 tsc；结束时递归删除临时目录。
// 跳过条件：最新 npm 版本小于 MINIMUM_PI_VERSION 时，没有任何已发布 pi 会接收该目录，直接成功返回。
// 示例：
//   node scripts/check-model-catalog-compat.mjs
//   node scripts/check-model-catalog-compat.mjs --catalog /tmp/models.all.json
// 建议阅读顺序：先看文件头部的现象说明，再看 mergeReleaseCatalog 的合并规则，最后看 main 的发布源码准备与类型检查。
//
// Checks that released pi versions can use the model catalog we are about to publish.
//
// Problem: pi.dev serves each published catalog to every released pi at or above
// MINIMUM_PI_VERSION. Released clients use it right away, without updating pi.
// If the catalog needs code they don't have, they break.
//
// Example: a catalog moved the kimi-coding models from anthropic-messages to
// openai-completions. pi 1.2.0's kimi-coding provider only implements
// anthropic-messages, so 1.2.0 sent requests to the wrong API and they failed.
//
// Check: build the model list a released client would end up with (its built-in
// models, overlaid by the new catalog), and compile the release's pi-ai source
// against it. pi-ai's types tie each provider to the APIs it implements, so a
// model with an API its provider lacks is a type error.
//
// Only the latest release on npm is checked. If it is older than
// MINIMUM_PI_VERSION, no released pi receives the catalog, and the check is skipped.
//
// Usage: node scripts/check-model-catalog-compat.mjs [--catalog <file>]
//   --catalog <file>  catalog to check (default: .artifacts/model-catalog/models.all.json,
//                     written by `npm run generate:model-catalog`)

// spawnSync 同步运行外部命令，便于顺序执行并在失败时立即抛出。
import { spawnSync } from "node:child_process";
// 临时目录、目录遍历、JSON 读写；rmSync recursive 负责清理。
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Node 内置参数解析器；--catalog 是唯一选项。
import { parseArgs } from "node:util";
// 发布最低版本水位，决定是否需要检查。
import { MINIMUM_PI_VERSION } from "./model-catalog-minimum-version.mjs";
// 从 .mjs 直接 import .ts 依赖 Node 的类型剥离；这里只用到版本比较函数。
import { compareModelCatalogPiVersions } from "./model-catalog-protocol.ts";

const PI_AI_PACKAGE = "@earendil-works/pi-ai";

/** Read a release's built-in model data (`dist/providers/data`) as model lists by provider. */
// 输入：发布包解包后的 dist/providers/data 目录。输出：{ provider: Model[] }。
// 每个 JSON 的结构是 provider → 分组 → 模型；这里把分组拍平为模型数组。跳过 .manifest.json。
function readBuiltinModels(dataDir) {
	const builtin = {};
	for (const file of readdirSync(dataDir)) {
		if (!file.endsWith(".json") || file === ".manifest.json") continue;
		const groups = JSON.parse(readFileSync(join(dataDir, file), "utf8"));
		// 文件名去掉 .json 就是供应商名；flatMap 把每个分组的模型对象合并成一层数组。
		builtin[file.slice(0, -".json".length)] = Object.values(groups).flatMap((group) => Object.values(group));
	}
	return builtin;
}

/**
 * Return the models a released client ends up with for each provider it ships:
 * its built-in models, overlaid by the catalog's models with the same type and
 * id. Like mergeModels() in remote-catalog-provider.ts, models missing from the
 * catalog keep their built-in data, and providers the release does not ship are
 * ignored.
 */
// 输入：发布版内置模型与待发布目录。输出：合并后的 provider→模型数组。
// 键为 `${type}:${id}`：同一 id 但不同 type 视为不同模型；目录中的条目覆盖内置条目。
// 只遍历发布版已有的供应商：新供应商不会出现在旧客户端里，检查它没有意义。
function mergeReleaseCatalog(builtin, catalog) {
	const merged = {};
	for (const [provider, builtinModels] of Object.entries(builtin)) {
		// Map 保持插入顺序；后 set 的同键目录模型替换内置值。
		const models = new Map(builtinModels.map((model) => [`${model.type}:${model.id}`, model]));
		for (const model of catalog[provider] ?? []) models.set(`${model.type}:${model.id}`, model);
		merged[provider] = [...models.values()];
	}
	return merged;
}

// 输入：命令、参数数组、cwd。输出：stdout 字符串。错误：进程无法启动或退出码非零时抛错，并附上合并后的输出。
// 不使用 shell，参数中的路径不会触发解释器元字符。
function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		throw new Error(`Command failed: ${[command, ...args].join(" ")}\n${output}`);
	}
	return result.stdout;
}

// 主流程：确定目录 → 查最新发布版本 → 跳过或准备发布源码 → 合并模型 → 安装依赖/构建 → hydrate + tsc。
// 输入：无（从 process.argv 解析）。输出：无返回值；进度写 stdout，失败抛错由文件底部统一转成退出码 1。
function main() {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	const { values } = parseArgs({ options: { catalog: { type: "string" } } });
	// 相对 --catalog 路径按当前 cwd 解析；默认路径指向 generate:model-catalog 的产物。
	const catalogPath = resolve(values.catalog ?? join(root, ".artifacts/model-catalog/models.all.json"));

	// npm view 访问 registry；输出版本号前后可能有空白，trim 后才能比较。
	const release = run("npm", ["view", PI_AI_PACKAGE, "version"], root).trim();
	// 版本比较小于 0 表示最新发布低于最低水位；此时目录不会发给任何已发布客户端。
	if (compareModelCatalogPiVersions(release, MINIMUM_PI_VERSION) < 0) {
		console.log(
			`Skipped: the latest release ${release} is older than MINIMUM_PI_VERSION ${MINIMUM_PI_VERSION}, so no released pi receives this catalog.`,
		);
		return;
	}

	// 所有下载/安装都放在这个随机临时目录，finally 保证成功失败都会删除。
	const temporaryDir = mkdtempSync(join(tmpdir(), "pi-model-catalog-compat-"));
	const releaseDir = join(temporaryDir, "release");
	try {
		console.log(`Checking the model catalog against pi ${release}...`);
		// The release's source code.
		// git archive 从本地 v<version> 标签导出源码；没有该标签会失败，这是检查的前置条件。
		const archive = join(temporaryDir, "release.tar");
		run("git", ["archive", "--prefix=release/", "--output", archive, `v${release}`], root);
		run("tar", ["xf", archive, "-C", temporaryDir], root);

		// The built-in models users have: the data shipped in the published package.
		// npm pack --json 输出数组；取第一个制品的 filename，再只解包 dist/providers/data。
		const [{ filename }] = JSON.parse(
			run("npm", ["pack", `${PI_AI_PACKAGE}@${release}`, "--pack-destination", temporaryDir, "--json"], root),
		);
		run("tar", ["xzf", join(temporaryDir, filename), "-C", temporaryDir, "package/dist/providers/data"], root);
		const builtin = readBuiltinModels(join(temporaryDir, "package/dist/providers/data"));
		const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
		// 把合并结果写成 hydrate 脚本要求的输入文件；它位于临时目录，不会污染工作区。
		const mergedPath = join(temporaryDir, "models.all.json");
		writeFileSync(mergedPath, JSON.stringify(mergeReleaseCatalog(builtin, catalog)));

		console.log("Installing the release's dependencies...");
		// --ignore-scripts 避免发布源码里的安装脚本被执行；--no-audit/--no-fund 减少无关网络请求。
		run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], releaseDir);
		// pi-ai's types depend on the declarations of its workspace dependencies.
		// 只构建 @earendil-works/* 工作区依赖；外部依赖已由 npm ci 安装。
		const { dependencies } = JSON.parse(readFileSync(join(releaseDir, "packages/ai/package.json"), "utf8"));
		for (const name of Object.keys(dependencies).filter((name) => name.startsWith("@earendil-works/"))) {
			run("npm", ["run", "build", "--workspace", name], releaseDir);
		}

		console.log("Type-checking the release's pi-ai with the merged models...");
		// hydrate 把合并目录写进包的模型数据/生成文件，随后 tsc 才会检查新模型与旧代码的类型是否一致。
		run(process.execPath, ["packages/ai/scripts/hydrate-model-catalog.ts", mergedPath], releaseDir);
		try {
			// --noEmit 只做类型检查，不产生构建输出。
			run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "packages/ai/tsconfig.build.json", "--noEmit"], releaseDir);
		} catch (error) {
			// tsc 失败时补充业务解释和修复动作，而不是只留下编译日志。
			throw new Error(
				[
					error.message,
					"",
					`The model catalog does not type-check against pi ${release}'s pi-ai (errors above).`,
					`pi.dev serves it to released pi >= ${MINIMUM_PI_VERSION}, so those clients would receive models`,
					"their code cannot handle, e.g. a model whose api its provider does not implement.",
					"If the change is intended, set MINIMUM_PI_VERSION in scripts/model-catalog-minimum-version.mjs",
					"to the next release in the same commit.",
				].join("\n"),
			);
		}
		console.log(`The model catalog is compatible with pi ${release}.`);
	} finally {
		// 无论成功或异常都清理源码、tarball、node_modules 与临时模型文件。
		rmSync(temporaryDir, { recursive: true, force: true });
	}
}

// 顶层兜底：所有异常只打印消息并以 1 退出；process.exitCode 允许 stdout 正常刷新后再结束进程。
try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
