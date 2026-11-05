#!/usr/bin/env node
// 文件导读
// 所属：仓库根 scripts/ 的模型目录差异工具，npm run diff:model-catalog 的实现，供目录/模型元数据改动时人工审阅。
// 职责：在临时 git worktree 中按 HEAD 生成一份模型目录，再在当前工作区生成一份，逐 provider、逐 model 比较；
//   --thinking 时改用各自工作区的 getSupportedThinkingLevels 计算“生效思考级别”，比较 thinking 能力而不是原始目录。
// 上游：npm run diff:model-catalog [-- --thinking provider...]（直接 node scripts/diff-model-catalog.mjs 亦可）。
// 下游：git worktree add/remove、Node 运行 packages/ai/catalog/generate.ts（旧基线回退到 scripts/generate-models.ts）、
//   scripts/generate-thinking-capabilities.mjs、git diff --no-index；只读取本地仓库与 node_modules，不联网。
// 输入：可选 --thinking 与 provider 名称（省略时比较前后并集里的所有 provider）；--help 打印用法。
// 输出：stdout 打印每个变化模型的彩色 diff 行（只保留 +/- 行）和变化计数；无变化时打印提示。
// 退出码：0 成功（包括无变化）；1 用法错误（未知 - 选项/未知 provider）或任一步命令失败（异常未被捕获，Node 默认退出码 1）。
// 副作用：创建临时目录与 detached worktree，在基线 worktree 中覆盖 generate-thinking-capabilities.mjs、软链 node_modules；
//   结束时 finally 移除 worktree 并递归删除临时目录（git worktree remove 失败只记录错误）。
// 幂等性：每次运行都重建临时 worktree；不修改当前工作区受跟踪文件。
// 示例：
//   node scripts/diff-model-catalog.mjs github-copilot
//   npm run diff:model-catalog -- --thinking moonshotai kimi-coding
// 建议阅读顺序：参数与仓库定位 → 目录生成/格式化辅助 → thinking 级别排序与规范化 → 主流程比较与清理。

import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// 用法文本里的 npm 示例需要 -- 把 --thinking 传给脚本而不是 npm 本身。
function printUsage() {
	console.log(`Usage: node scripts/diff-model-catalog.mjs [--thinking] [provider ...]

Generates the model catalog at HEAD and in the current worktree, then shows
JSON differences. If providers are omitted, all providers are compared.

--thinking compares each worktree's effective thinking levels using that
worktree's getSupportedThinkingLevels() implementation.

Examples:
  node scripts/diff-model-catalog.mjs github-copilot
  npm run diff:model-catalog -- --thinking moonshotai kimi-coding
`);
}

// 输入：命令、参数、{cwd, capture}。输出：stdout 字符串。错误：spawn 失败或退出码非零时抛出，并合并 stdout/stderr。
// capture=false 时子进程直接继承 stdio，适合 git worktree 这类需要实时输出的命令。
function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.status !== 0) {
		const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(`Command failed: ${[command, ...args].join(" ")}\n${details}`);
	}
	return result.stdout ?? "";
}

// 输入：git diff 参数与工作目录。输出：完整的 spawnSync 结果。
// 不在这里抛错：--no-index 比较有差异时退出码是 1，调用方需要自己区分“有差异”和“真正失败”。
function runDiff(args, cwd) {
	return spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

const args = process.argv.slice(2);
// --help 优先：即使同时给了其他参数也打印用法并成功退出。
if (args.includes("--help")) {
	printUsage();
	process.exit(0);
}
const thinkingOnly = args.includes("--thinking");
// 其余参数都当作 provider 名；--thinking 可出现任意位置且只去掉一次。
const requestedProviders = args.filter((arg) => arg !== "--thinking");
// 残留的 - 开头参数视为未知选项，避免拼写错误被当成 provider 名去查目录。
if (requestedProviders.some((arg) => arg.startsWith("-"))) {
	printUsage();
	process.exit(1);
}

const repoRoot = run("git", ["rev-parse", "--show-toplevel"], { capture: true }).trim();
// 所有中间产物都在随机临时目录；无论成功失败最后都会删除。
const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-model-catalog-diff-"));
const baselineWorktree = join(temporaryRoot, "baseline-worktree");
const baselineOutput = join(temporaryRoot, "before");
const currentOutput = join(temporaryRoot, "after");
const baselineThinkingOutput = join(temporaryRoot, "before-thinking");
const currentThinkingOutput = join(temporaryRoot, "after-thinking");
// 只有 worktree add 成功后 finally 才执行 remove，避免删除不存在的 worktree。
let worktreeAdded = false;

// 输入：工作目录、输出目录、pretty 是否缩进。输出：无（写文件）。
// 生成器路径随代码演进变化：新目录用 catalog/generate.ts，旧基线回退到 scripts/generate-models.ts。
function generateCatalog(cwd, outputDir, pretty = false) {
	// Baselines from before the catalog moved still have the old generator.
	const generator = existsSync(join(cwd, "packages/ai/catalog/generate.ts"))
		? "packages/ai/catalog/generate.ts"
		: "packages/ai/scripts/generate-models.ts";
	// --strict 让生成器把不一致当错误；--json-only 只产出 JSON，不写 TypeScript。
	const args = [generator, "--strict", "--json-only", "--json-output", outputDir];
	// 当前工作区用 pretty 输出便于阅读；基线随后会被统一重新格式化，所以不需要。
	if (pretty) args.push("--pretty");
	run(process.execPath, args, { cwd, capture: true });
}

// 输入：生成器的输出目录。输出：无。副作用：把 providers/*.json 重写为 2 空格缩进 + 末尾换行。
// 两侧生成器格式可能不同，先统一格式，比较时才不会把纯格式差异当成模型变化。
function formatProviderCatalogs(outputDir) {
	const providersDir = join(outputDir, "providers");
	for (const entry of readdirSync(providersDir)) {
		if (!entry.endsWith(".json")) continue;
		const path = join(providersDir, entry);
		const value = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
	}
}

// 输入：输出目录与 provider 名。输出：该 provider 的 JSON 对象；文件不存在时返回 undefined（表示新增/删除）。
function readProviderCatalog(outputDir, provider) {
	const path = join(outputDir, "providers", `${provider}.json`);
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

// 输入：工作区目录、该工作区的目录 JSON、thinking 输出目录。输出：无（写文件）。
// 在各自工作区运行，确保使用该提交版本的思考级别实现，而不是当前代码。
function generateThinkingCatalog(cwd, catalogPath, outputDir) {
	run(process.execPath, ["scripts/generate-thinking-capabilities.mjs", catalogPath, outputDir], {
		cwd,
		capture: true,
	});
}

// 思考级别的稳定顺序；未知键（例如未来新增级别）排在最后，再按字典序。
const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_LEVEL_RANKS = new Map(THINKING_LEVEL_ORDER.map((key, index) => [key, index]));

// 输入：对象键数组与父键名。输出：排序后的键数组（原地 sort 后返回）。
// thinkingLevelMap 与 values 按语义级别排序，其余对象按键名字母序，保证两侧规范化结果可直接比较。
function sortJsonKeys(keys, parentKey) {
	if (parentKey !== "thinkingLevelMap" && parentKey !== "values") return keys.sort();
	return keys.sort((left, right) => {
		const leftRank = THINKING_LEVEL_RANKS.get(left) ?? Number.POSITIVE_INFINITY;
		const rightRank = THINKING_LEVEL_RANKS.get(right) ?? Number.POSITIVE_INFINITY;
		return leftRank - rightRank || left.localeCompare(right);
	});
}

// 输入：任意 JSON 值、父键名。输出：键顺序稳定的新对象/数组。
// 数组保持原顺序（顺序可能本身有语义）；只递归对象键。
function canonicalizeJson(value, parentKey) {
	if (Array.isArray(value)) return value.map((entry) => canonicalizeJson(entry));
	if (value === null || typeof value !== "object") return value;

	const result = {};
	for (const key of sortJsonKeys(Object.keys(value), parentKey)) {
		result[key] = canonicalizeJson(value[key], key);
	}
	return result;
}

// 输入：已规范化的值、缩进前缀。输出：多行 JSON-like 文本（每条后带逗号）。
// 用于写 before/after 快照；只追求可读和稳定，不要求是合法 JSON（数组/对象最后一项也有逗号）。
function formatJsonForDiff(value, indent = "") {
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		const childIndent = `${indent}  `;
		return `[\n${value.map((entry) => `${childIndent}${formatJsonForDiff(entry, childIndent)},`).join("\n")}\n${indent}]`;
	}
	if (value === null || typeof value !== "object") return JSON.stringify(value);

	const entries = Object.entries(value);
	if (entries.length === 0) return "{}";
	const childIndent = `${indent}  `;
	return `{\n${entries
		.map(([key, entry]) => `${childIndent}${JSON.stringify(key)}: ${formatJsonForDiff(entry, childIndent)},`)
		.join("\n")}\n${indent}}`;
}

// 输入：快照路径与模型值（可能 undefined 表示新增/删除）。输出：无。
// 写空字符串表示该侧不存在，git diff 会显示整段新增/删除。
function writeModelSnapshot(path, model) {
	writeFileSync(path, model === undefined ? "" : `${formatJsonForDiff(canonicalizeJson(model))}\n`);
}

// 输入：git diff 的彩色输出。输出：无。副作用：把 + / - 内容行写到 stdout。
// 先去掉 ANSI 颜色再判断行首，避免颜色码影响 startsWith；同时排除 +++/--- 文件头。
function writeChangedLines(output) {
	const changedLines = output.split("\n").filter((line) => {
		const withoutColor = line.replace(/\u001b\[[0-9;]*m/g, "");
		return (
			(withoutColor.startsWith("+") && !withoutColor.startsWith("+++")) ||
			(withoutColor.startsWith("-") && !withoutColor.startsWith("---"))
		);
	});
	if (changedLines.length > 0) process.stdout.write(`${changedLines.join("\n")}\n`);
}

try {
	// detached worktree 指向 HEAD；--detach 避免创建分支。
	run("git", ["worktree", "add", "--detach", baselineWorktree, "HEAD"], { cwd: repoRoot });
	worktreeAdded = true;
	// 基线 worktree 可能还没有本脚本（或旧版本），把当前的 thinking 生成器复制进去，保证两侧接口一致。
	copyFileSync(
		join(repoRoot, "scripts", "generate-thinking-capabilities.mjs"),
		join(baselineWorktree, "scripts", "generate-thinking-capabilities.mjs"),
	);

	// 复用当前 node_modules，避免在基线 worktree 重新安装；Windows 用 junction。
	const nodeModules = join(repoRoot, "node_modules");
	if (existsSync(nodeModules)) {
		symlinkSync(nodeModules, join(baselineWorktree, "node_modules"), process.platform === "win32" ? "junction" : "dir");
	}

	console.log("Generating catalog from HEAD...");
	generateCatalog(baselineWorktree, baselineOutput);
	formatProviderCatalogs(baselineOutput);
	console.log("Generating catalog from the current worktree...");
	generateCatalog(repoRoot, currentOutput, true);
	formatProviderCatalogs(currentOutput);

	// thinking 模式需要基于刚生成的目录 JSON 计算生效级别；两侧各用自己的实现。
	if (thinkingOnly) {
		console.log("Computing effective thinking capabilities...");
		generateThinkingCatalog(baselineWorktree, join(baselineOutput, "models.json"), baselineThinkingOutput);
		generateThinkingCatalog(repoRoot, join(currentOutput, "models.json"), currentThinkingOutput);
	}

	const beforeProviders = JSON.parse(readFileSync(join(baselineOutput, "providers.json"), "utf8"));
	const afterProviders = JSON.parse(readFileSync(join(currentOutput, "providers.json"), "utf8"));
	// 未指定 provider 时取前后并集，新增 provider 也会被比较。
	const providers =
		requestedProviders.length > 0 ? requestedProviders : [...new Set([...beforeProviders, ...afterProviders])].sort();
	// 数据源随 --thinking 切换；比较的仍是 providers/<name>.json（由 thinking 生成器写出）。
	const beforeCatalogOutput = thinkingOnly ? baselineThinkingOutput : baselineOutput;
	const currentCatalogOutput = thinkingOnly ? currentThinkingOutput : currentOutput;
	// 快照文件名固定，每次覆盖；git diff 的路径显示相对临时根。
	const beforeModelPath = "before-model.json";
	const afterModelPath = "after-model.json";
	const changedModels = [];
	let differences = 0;

	for (const provider of providers) {
		const beforeModels = readProviderCatalog(beforeCatalogOutput, provider);
		const afterModels = readProviderCatalog(currentCatalogOutput, provider);
		// 两侧都没有该 provider：请求了不存在的名字，直接报错而不是静默跳过。
		if (beforeModels === undefined && afterModels === undefined) {
			throw new Error(`Unknown provider: ${provider}`);
		}

		// 模型 id 的并集；新增/删除也会进入比较。
		const modelIds = [...new Set([...Object.keys(beforeModels ?? {}), ...Object.keys(afterModels ?? {})])].sort();
		for (const modelId of modelIds) {
			const beforeModel = beforeModels?.[modelId];
			const afterModel = afterModels?.[modelId];
			// 规范化后字符串相等即视为无变化；键顺序差异被忽略。
			if (JSON.stringify(canonicalizeJson(beforeModel)) === JSON.stringify(canonicalizeJson(afterModel))) continue;

			writeModelSnapshot(join(temporaryRoot, beforeModelPath), beforeModel);
			writeModelSnapshot(join(temporaryRoot, afterModelPath), afterModel);
			// --no-index 允许比较不受 git 跟踪的临时文件；--unified=0 只显示变化行。
			const result = runDiff(
				[
					"diff",
					"--no-index",
					"--no-ext-diff",
					"--color=always",
					"--unified=0",
					"--",
					beforeModelPath,
					afterModelPath,
				],
				temporaryRoot,
			);
			// 按 git diff 约定：1 = 有差异，0 = 无差异，其他 = 执行失败。
			if (result.status === 1) {
				const changedModel = `${provider}/${modelId}`;
				console.log(`\n${changedModel}`);
				writeChangedLines(result.stdout);
				changedModels.push(changedModel);
				differences++;
			} else if (result.status !== 0) {
				throw new Error(`Could not compare ${provider}/${modelId}: ${result.stderr || result.stdout}`);
			}
		}
	}

	if (differences === 0) {
		console.log(`No model catalog changes${requestedProviders.length === 1 ? ` for ${requestedProviders[0]}` : ""}.`);
	} else {
		// 末尾汇总便于在长输出中快速看到受影响模型。
		console.log(`\n${differences} model catalog entr${differences === 1 ? "y" : "ies"} changed.`);
		for (const changedModel of changedModels) {
			console.log(`- ${changedModel}`);
		}
	}
} finally {
	// 先移除 worktree（失败也继续清理临时目录，只打印错误）；rmSync 兜底删除残留内容。
	if (worktreeAdded) {
		try {
			run("git", ["worktree", "remove", "--force", baselineWorktree], { cwd: repoRoot });
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
		}
	}
	rmSync(temporaryRoot, { recursive: true, force: true });
}
