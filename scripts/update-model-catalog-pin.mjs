#!/usr/bin/env node

// 文件导读：更新 Nix 构建使用的模型目录 pin（`nix/model-catalog.json`）。
// 所属：仓库根 scripts/；入口有 `npm run update:model-catalog-pin`，release.mjs 也会直接调用导出的函数。
// 作用：从 pi.dev 获取最新已发布目录，验证其不可变 revision URL 的内容哈希与 API 分组，再确认它能 hydrate
//   当前 checkout 的模型数据；只有全部通过才把 revision 写入 pin。失败时保留旧 pin。
// 上游：`node scripts/update-model-catalog-pin.mjs [--if-stale]`；`--if-stale` 允许在旧 pin 仍可 hydrate
//   且模型分组一致时保留旧 pin，减少 main 上的无意义 churn。
// 下游：fetch pi.dev 的 `/api/models`（发现最新 revision）与 `/api/models/revisions/<revision>`（不可变内容）；
//   `packages/ai/scripts/hydrate-model-catalog.ts` 与 `model-data.ts` 验证并生成模型数据。
// 副作用：网络访问；成功时覆盖写 `nix/model-catalog.json`（只有 revision 字段）；hydrate 时在临时目录写文件后删除。
// 高风险：pin 决定 Nix 构建从哪份目录生成模型包装器；写错会让发布标签无法离线构建。因此先验证再写，
//   任何网络/哈希/hydrate 失败都抛错，CLI 以 1 退出且旧 pin 不变。
// 能力清单：
//   - sha256(bytes)：计算 `sha256-<hex>` 摘要。
//   - fetchRevision(revision)：下载并校验不可变目录内容。
//   - fetchLiveCatalog()：发现最新 revision（不发送 pi-version）。
//   - modelApiGroups(root, bytes)：计算 provider/type/api 分组集合。
//   - hydrateModelCatalogBytes(root, bytes, options)：用目录字节在临时目录 hydrate checkout。
//   - hydrationProblem(root, bytes)：把 hydrate 异常转成说明字符串。
//   - updateModelCatalogPin(root, {ifStale})：主逻辑，返回 {revision, updated, bytes}，导出供 release 使用。
// 典型调用与预期：
//   示例 `node scripts/update-model-catalog-pin.mjs --if-stale`；成功打印 `Kept|Pinned model catalog sha256-...`。
//   无网络或 pi.dev 返回 503 时抛错，退出码 1，pin 文件保持原样。
// 阅读顺序：先看常量与 fetch 校验，再看 modelApiGroups/hydrate 验证，最后看 updateModelCatalogPin 的决策顺序。
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hydrateModelCatalog } from "../packages/ai/scripts/hydrate-model-catalog.ts";
import { readModelDataProviderIds } from "../packages/ai/scripts/model-data.ts";

// Request the typed catalog; its bytes are what a revision hashes.
// 请求 chat/image/classifier 三类目录；查询串固定后，revision 哈希的是同一份字节内容。
const MODEL_TYPES = "types=chat,image,classifier";
// revision 格式是 `sha256-` 加 64 位小写十六进制；任何其他字符串都视为无效。
const REVISION_RE = /^sha256-[0-9a-f]{64}$/;

// 计算内容的 sha256 摘要并加上 `sha256-` 前缀；输入是 Buffer/字符串，输出与 revision 同格式的字符串。
// 例：sha256(Buffer.from("")) 得到 sha256-e3b0c442...（空内容的摘要）。
function sha256(bytes) {
	// createHash 流式接收 bytes；digest("hex") 输出十六进制字符串。
	return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
}

// 从 pi.dev 下载指定 revision 的目录字节，并验证内容哈希与 revision 一致。
// 输入 revision（已通过 REVISION_RE）；输出 Buffer；HTTP 非 2xx 或哈希不符抛错。
// 副作用：网络 GET；不写文件。哈希校验保证不可变 URL 返回的正是 pin 指向的内容。
async function fetchRevision(revision) {
	// revision 拼进路径；查询串仍要求三类模型，保证哈希对象与发现阶段一致。
	const response = await fetch(`https://pi.dev/api/models/revisions/${revision}?${MODEL_TYPES}`);
	if (!response.ok) throw new Error(`Catalog revision ${revision} is unavailable: HTTP ${response.status}`);
	// arrayBuffer 按原始字节读取，避免文本解码改变内容；Buffer.from 再包装成 Node Buffer。
	const bytes = Buffer.from(await response.arrayBuffer());
	// 内容寻址校验：URL 中的 revision 必须等于内容哈希，否则拒绝使用。
	if (sha256(bytes) !== revision) throw new Error(`Catalog revision ${revision} does not match its content`);
	return bytes;
}

/**
 * Discover the newest published catalog. It is generated from main, which is
 * what this checkout builds. Do not send `pi-version`: on main it is the last
 * released version, and pi.dev answers it with the catalog for released
 * clients, which predates any `MINIMUM_PI_VERSION` bump main depends on.
 */
// 发现最新目录 revision：GET /api/models，从响应头读取 revision 并校验响应体哈希。
// 输出 revision 字符串；HTTP 失败、头缺失/格式错、体哈希不符都抛错。
// 特意不发送 pi-version：main 的版本号是上一个已发布版本，pi.dev 会据此返回旧客户端目录。
async function fetchLiveCatalog() {
	const response = await fetch(`https://pi.dev/api/models?${MODEL_TYPES}`);
	if (!response.ok) throw new Error(`Catalog discovery failed: HTTP ${response.status}`);
	// Headers.get 的名字大小写不敏感；缺失时返回 null。
	const revision = response.headers.get("x-pi-model-catalog-revision");
	if (typeof revision !== "string" || !REVISION_RE.test(revision)) {
		throw new Error("Catalog discovery returned an invalid or missing revision");
	}
	// 先读体再哈希；同一个响应体只能读一次，所以这里同时承担内容校验。
	if (sha256(Buffer.from(await response.arrayBuffer())) !== revision) {
		throw new Error("Catalog discovery body does not match its revision");
	}
	return revision;
}

/**
 * Return the `provider/type/api` model groups the catalog provides for this
 * checkout's providers. The generated `*.models.ts` types are derived from the
 * data, which is grouped by API, so code only type-checks when the catalog has
 * the same groups as main: e.g. OPENCODE_CLASSIFIER_MODELS needs opencode
 * classifier models, and a provider factory returning
 * `Provider<"openai-completions">` fails when its models use another API.
 */
// 计算目录为当前 checkout 的 provider 提供了哪些 `provider/type/api` 分组。
// 输入 root 与目录 JSON 字节；输出 Set<string>。只读，不写文件。
// 运行时校验边界：远程 JSON 视为外部输入，但这里不逐字段校验，只按结构访问；
// 缺失 provider 用 `?? []` 兜底，缺失 type/api 会得到 "undefined" 字符串并参与比较。
function modelApiGroups(root, bytes) {
	const catalog = JSON.parse(bytes.toString("utf8"));
	const groups = new Set();
	// checkout 的 provider 列表来自生成的模型数据文件，而不是目录本身；这样只比较当前代码关心的分组。
	for (const provider of readModelDataProviderIds(join(root, "packages/ai"))) {
		// 可迭代对象缺失时回退空数组；模板字符串把三个字段拼成稳定键。
		for (const model of catalog[provider] ?? []) groups.add(`${provider}/${model.type}/${model.api}`);
	}
	return groups;
}

/** Hydrate the checkout's model data from catalog bytes, as the Nix build does. */
// 用给定目录字节在临时目录 hydrate checkout，模拟 Nix 构建步骤。
// 输入 root、bytes、options（如 validateOnly）；输出为 hydrateModelCatalog 的返回值（此处未使用）。
// 副作用：在系统临时目录写 models.all.json，hydrate 可能写 checkout 的模型数据；finally 删除临时文件。
// 例：hydrateModelCatalogBytes(root, bytes, {validateOnly:true}) 只验证不落盘模型数据。
export function hydrateModelCatalogBytes(root, bytes, options = {}) {
	// mkdtempSync 保证目录唯一；hydrate 期望一个 models.all.json 文件路径。
	const directory = mkdtempSync(join(tmpdir(), "pi-model-catalog-pin-"));
	try {
		const catalogPath = join(directory, "models.all.json");
		writeFileSync(catalogPath, bytes);
		// 第二个参数是 ai 包根目录；options 原样传入，validateOnly 时只校验。
		hydrateModelCatalog(join(root, "packages/ai"), catalogPath, options);
	} finally {
		// 即使 hydrate 抛错也清理临时目录，避免残留大文件。
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Return why the catalog cannot hydrate this checkout, or undefined if it can. */
// 尝试只校验模式 hydrate；成功返回 undefined，失败返回错误消息字符串。
// 不抛出：调用方用返回值判断 pin 是否过期，同时保留错误原因用于日志。
// 错误可能是任意值；instanceof Error 收窄后取 message，否则 String 转换。
function hydrationProblem(root, bytes) {
	try {
		hydrateModelCatalogBytes(root, bytes, { validateOnly: true });
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * Pin the live model catalog for Nix builds. With `ifStale`, keep the current
 * pin while it still hydrates this checkout and has the same model groups as
 * the live catalog for the checkout's providers. Returns the pinned revision
 * and its catalog bytes.
 */
// 主逻辑：读取当前 pin，按 ifStale 决定是否先验证旧 pin，再发现/下载新目录并决定是否写入。
// 输入 root（仓库根）与 {ifStale}；输出 {revision, updated, bytes}；成功写 pin 文件时 updated 可能仍为 false
// （新 revision 与旧值相同）。网络、哈希、hydrate 失败都抛错，不写 pin。
// 例：updateModelCatalogPin(repoRoot, {ifStale:true}) 在旧 pin 仍可用时返回 updated:false 且保留旧 revision。
export async function updateModelCatalogPin(root, { ifStale = false } = {}) {
	// pin 文件只包含 {revision}；JSON.parse 失败会直接抛错。
	const pinPath = join(root, "nix/model-catalog.json");
	const current = JSON.parse(readFileSync(pinPath, "utf8")).revision;
	// currentBytes 只在 ifStale 且旧 pin 验证通过时存在；它代表“可以继续使用的旧目录”。
	let currentBytes;
	if (ifStale) {
		// 旧 pin 若格式非法，无法安全比较，直接报错而不是静默替换。
		if (typeof current !== "string" || !REVISION_RE.test(current)) throw new Error(`Invalid pin in ${pinPath}`);
		// 下载旧 revision 并校验哈希；不可达会抛错，不把“读不到”当成“过期”。
		currentBytes = await fetchRevision(current);
		// 只做 validateOnly hydrate，确认当前 checkout 能构建；失败则丢弃旧目录，后面替换。
		const problem = hydrationProblem(root, currentBytes);
		if (problem) {
			console.error(`Pinned model catalog is stale: ${problem}`);
			currentBytes = undefined;
		}
	}

	// 发现最新 revision；即便旧 pin 可用也要发现，因为要比较模型分组是否落后。
	const revision = await fetchLiveCatalog();
	// Do not record a pin until its immutable URL serves a catalog this checkout can build with.
	// 先下载并校验新目录；后续所有检查都基于这份已验证的字节。
	const bytes = await fetchRevision(revision);
	if (currentBytes) {
		// The live catalog is generated from main. Main's code may depend on a model
		// group the pin lacks, e.g. after a provider gained classifier models or
		// switched APIs.
		// 只有分组集合完全相等才保留旧 pin：多出分组说明旧 pin 落后于 main。
		const pinned = modelApiGroups(root, currentBytes);
		const live = modelApiGroups(root, bytes);
		// 展开 Set 成数组后用 filter 做差集；sort 让诊断输出顺序稳定。
		const missing = [...live].filter((group) => !pinned.has(group)).sort();
		const extra = [...pinned].filter((group) => !live.has(group)).sort();
		if (missing.length === 0 && extra.length === 0) return { revision: current, updated: false, bytes: currentBytes };
		// 只为日志构造方向性描述；空字符串由 filter(Boolean) 去掉。
		const differences = [
			missing.length > 0 ? `missing ${missing.join(", ")}` : "",
			extra.length > 0 ? `extra ${extra.join(", ")}` : "",
		].filter(Boolean);
		console.error(`Pinned model catalog is stale: model groups differ (${differences.join("; ")})`);
	}
	// 新目录还必须能 hydrate 当前 checkout；否则写入 pin 会让 Nix 构建失败，因此直接抛错不写。
	const problem = hydrationProblem(root, bytes);
	if (problem) throw new Error(`Live model catalog ${revision} cannot hydrate this checkout: ${problem}`);
	// 只有全部检查通过才写 pin；2 空格缩进 + 末尾换行是 Nix 侧读取的格式约定。
	writeFileSync(pinPath, `${JSON.stringify({ revision }, null, 2)}\n`);
	// updated 表示 revision 是否变化，而 pin 文件总会被重写；调用方用它决定日志。
	return { revision, updated: revision !== current, bytes };
}

// 直接运行判断：import.meta.url 转成文件 URL 后与 argv[1] 比较；被测试 import 时不执行 CLI。
// resolve 先消掉相对路径中的 . 与 ..，避免同一个文件因路径拼写不同而误判。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	// 只允许零个或一个 --if-stale；其他组合视为用法错误。
	if (args.length > 1 || (args.length === 1 && args[0] !== "--if-stale")) {
		throw new Error("Usage: node scripts/update-model-catalog-pin.mjs [--if-stale]");
	}
	// 仓库根是脚本所在目录的上一级，不依赖调用者 cwd。
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	// 顶层 await 在该 ESM 模块中合法；失败会作为未捕获错误退出码 1。
	const { revision, updated } = await updateModelCatalogPin(root, { ifStale: args[0] === "--if-stale" });
	// 输出最终状态：Pinned 表示 revision 变化，Kept 表示保留旧 pin。
	console.log(`${updated ? "Pinned" : "Kept"} model catalog ${revision}`);
}
