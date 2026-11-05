#!/usr/bin/env node
// 文件导读
// 所属：仓库根 scripts/，是模型目录发布 CLI（不是服务端代码）。
// 作用：校验 `npm run generate:model-catalog` 生成的 JSON 套件，计算内容哈希 revision，写 publication.json；
// 非 dry-run 时把不可变的目录对象上传到 S3 兼容存储（生产为 Cloudflare R2），最后更新 index.json。
// 上游：根 package.json 的 "check:model-catalog"（--dry-run）与 .github/workflows/publish-model-catalog.yml。
// 下游：model-catalog-protocol.ts 提供键格式/索引校验/版本比较，model-catalog-minimum-version.mjs 提供最低版本，
//       aws CLI 负责 S3 上传，git rev-parse 提供 sourceCommit。
// 能力清单：
//   parseArgs              - 解析 --input/--bucket/--endpoint/--source-commit/--dry-run。
//   validateBundle         - 交叉校验 models.json、models.all.json、providers.json 与 provider 分片，算 revision。
//   buildIndex             - 用现有索引生成新索引，替换同一最低版本条目并保留其他发布元数据。
//   downloadIndex/uploadJson - 通过 aws s3 cp 读写对象，并设置 Content-Type 与 Cache-Control。
//   main                   - 校验、写 publication.json、dry-run 退出或上传。
// 输入/输出与副作用：
//   输入目录必须含 models.json、models.all.json、providers.json 和 providers/<id>[.all].json。
//   始终在输入目录写 publication.json（覆盖旧文件）；dry-run 不访问网络/存储，退出码 0。
//   发布模式会创建临时目录、下载 index.json、上传所有目录对象与索引；临时目录在 finally 删除。
// 高风险步骤与失败状态：
//   目录对象先于索引上传，且使用 immutable 缓存；若中途失败，已上传对象可被后续重试复用，但索引保持旧值。
//   索引上传是提交点；索引使用 no-store，客户端每次重新获取。重试幂等：同 revision 已是最新时直接退出。
//   错误只设置 process.exitCode=1（不立即退出），已完成的网络请求不会回滚。
// 环境变量：aws CLI 需要 AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY；本脚本为 AWS_DEFAULT_REGION 提供默认值
//   "auto" 并禁用 EC2 元数据查询，避免在 CI 外意外探测实例元数据。
// 示例（真实命令行）：
//   node scripts/publish-model-catalog.mjs --input .artifacts/model-catalog --dry-run
//   node scripts/publish-model-catalog.mjs --input .artifacts/model-catalog --bucket pi-artifacts \
//     --endpoint "$R2_ENDPOINT" --source-commit "$(git rev-parse HEAD)"
// 阅读顺序：先看 validateBundle 的校验链，再看 main 的上传顺序与 buildIndex 的索引合并。

import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
// isDeepStrictEqual 做结构相等比较；对象键顺序不影响结果。
import { isDeepStrictEqual } from "node:util";
// 协议模块同时被 pi.dev 使用；本脚本只依赖它的键生成和索引校验。
import {
	compareModelCatalogPiVersions,
	getModelCatalogArtifactKey,
	getModelCatalogProviderKey,
	MODEL_CATALOG_INDEX_KEY,
	MODEL_CATALOG_PREFIX,
	MODEL_CATALOG_SCHEMA_VERSION,
	parseModelCatalogIndex,
} from "./model-catalog-protocol.ts";
import { MINIMUM_PI_VERSION } from "./model-catalog-minimum-version.mjs";

// The storage layout, index format, and version ordering are defined in
// model-catalog-protocol.ts, which pi.dev shares to serve these artifacts.
// 所有对象都以 JSON 提供，显式带 charset，避免客户端按 Latin-1 解码。
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
// revision 下的对象不可变，可以长期缓存；重试或重复下载不会看到不同内容。
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
// 索引会随每次发布变化，必须每次重新验证，不能缓存。
const INDEX_CACHE_CONTROL = "no-store";
// 至少要有这三个核心 provider，防止生成器配置错误导致目录缺失主要模型。
const REQUIRED_PROVIDERS = ["anthropic", "openai", "openrouter"];
// 最小 chat 模型数量；低于它通常说明抓取/生成失败，拒绝发布残缺目录。
const MINIMUM_MODEL_COUNT = 500;
// 当前协议认识的模型类型；分片里的 type 必须在此集合内。
const MODEL_TYPES = ["chat", "image", "classifier"];

// 解析 CLI 参数；不支持的参数立即抛错，避免拼写错误被静默忽略。
function parseArgs(args) {
	const options = {
		input: undefined,
		bucket: undefined,
		endpoint: undefined,
		sourceCommit: undefined,
		dryRun: false,
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		// 四个带值选项共享同一段解析逻辑；args[++index] 先自增再取值，跳过选项值。
		if (arg === "--input" || arg === "--bucket" || arg === "--endpoint" || arg === "--source-commit") {
			const value = args[++index];
			// 缺少值（undefined 或空串）时报错，并指出是哪个选项。
			if (!value) throw new Error(`${arg} requires a value`);
			// 用内联映射把 CLI 名称转换成 options 字段；计算属性 [arg] 取出对应字段名。
			options[
				{
					"--input": "input",
					"--bucket": "bucket",
					"--endpoint": "endpoint",
					"--source-commit": "sourceCommit",
				}[arg]
			] = value;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	// 输入目录必填；发布模式还必须有 bucket 和 endpoint，dry-run 只需要本地校验。
	if (!options.input) throw new Error("--input is required");
	if (!options.dryRun && !options.bucket) throw new Error("--bucket is required when publishing");
	if (!options.dryRun && !options.endpoint) throw new Error("--endpoint is required when publishing");
	return options;
}

// 读取并解析 JSON；解析失败的错误包含文件路径由调用栈提供，不额外包装。
function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

// 判断值是否为普通对象（排除 null 和数组），用于运行时清单校验。
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 旧版 chat 目录的文件结构：provider -> (model id -> model)，只保留 type 为 chat 的模型。
function chatProjection(providerModels) {
	// filter+map 生成 [id, model] 对，Object.fromEntries 转成对象；后出现的同 id 会覆盖前者（上面已保证唯一）。
	return Object.fromEntries(providerModels.filter((model) => model.type === "chat").map((model) => [model.id, model]));
}

// 交叉校验输入目录并计算 revision；返回发布所需的路径与统计。
function validateBundle(inputDir) {
	const modelsPath = join(inputDir, "models.json");
	const allModelsPath = join(inputDir, "models.all.json");
	const providerIndexPath = join(inputDir, "providers.json");
	const providersDir = join(inputDir, "providers");
	// 先读原始字节：revision 必须基于实际发布的 models.all.json 字节，而不是重新序列化的结果。
	const modelsBytes = readFileSync(modelsPath);
	const allModelsBytes = readFileSync(allModelsPath);
	const models = JSON.parse(modelsBytes.toString("utf8"));
	const allModels = JSON.parse(allModelsBytes.toString("utf8"));
	const providerIds = readJson(providerIndexPath);

	// 顶层必须是 provider 映射，而不能是数组或标量。
	if (!isObject(models)) throw new Error("models.json must contain an object");
	if (!isObject(allModels)) throw new Error("models.all.json must contain an object");
	// providers.json 是字符串数组，顺序必须与排序后的 provider id 一致。
	if (!Array.isArray(providerIds) || !providerIds.every((value) => typeof value === "string")) {
		throw new Error("providers.json must contain an array of provider IDs");
	}

	const expectedProviderIds = Object.keys(allModels).sort();
	// 索引文件与完整目录必须逐一相等；少一个 provider 会让客户端缺模型。
	if (!isDeepStrictEqual(providerIds, expectedProviderIds)) {
		throw new Error("providers.json does not match the sorted providers in models.all.json");
	}
	// chat 目录与完整目录必须覆盖同一组 provider。
	if (!isDeepStrictEqual(Object.keys(models).sort(), expectedProviderIds)) {
		throw new Error("models.json and models.all.json list different providers");
	}
	for (const providerId of REQUIRED_PROVIDERS) {
		if (!Object.hasOwn(models, providerId)) throw new Error(`Required provider is missing: ${providerId}`);
	}

	// modelCount remains the legacy chat-catalog count for existing consumers.
	// 分别统计三种类型；modelCount 继续表示旧 chat 目录的数量，供已有消费者读取。
	let modelCount = 0;
	let imageModelCount = 0;
	let classifierModelCount = 0;
	for (const providerId of providerIds) {
		const providerModels = allModels[providerId];
		// 完整目录里每个 provider 必须是数组。
		if (!Array.isArray(providerModels)) throw new Error(`Full provider catalog must be an array: ${providerId}`);
		// 单 provider 分片必须与完整目录中的同名数组完全一致。
		const providerFile = readJson(join(providersDir, `${providerId}.all.json`));
		if (!isDeepStrictEqual(providerFile, providerModels)) {
			throw new Error(`Provider shard does not match models.all.json: ${providerId}`);
		}
		// 用 type:id 识别重复模型；同一 id 可以同时以 chat 和 image 存在。
		const identities = new Set();
		for (const model of providerModels) {
			if (!isObject(model) || typeof model.id !== "string" || model.provider !== providerId) {
				throw new Error(`Invalid model entry in provider catalog: ${providerId}`);
			}
			// 未知类型无法被客户端渲染/调用，拒绝发布。
			if (!MODEL_TYPES.includes(model.type)) {
				throw new Error(`Model entry has an unknown type: ${providerId}/${model.id} (${JSON.stringify(model.type)})`);
			}
			const identity = `${model.type}:${model.id}`;
			if (identities.has(identity)) throw new Error(`Duplicate model entry: ${providerId}/${identity}`);
			identities.add(identity);
			// 按类型累加计数；缺少 type 的情况已在上面拒绝。
			if (model.type === "chat") modelCount++;
			else if (model.type === "image") imageModelCount++;
			else classifierModelCount++;
		}

		// The legacy variant must be exactly the chat projection of the full catalog.
		// 旧目录必须恰好是完整目录的 chat 投影，不能多也不能少。
		const chatModels = chatProjection(providerModels);
		if (!isDeepStrictEqual(models[providerId], chatModels)) {
			throw new Error(`models.json is not the chat projection of models.all.json: ${providerId}`);
		}
		// legacy provider 分片也必须等于同一投影。
		if (!isDeepStrictEqual(readJson(join(providersDir, `${providerId}.json`)), chatModels)) {
			throw new Error(`Provider shard does not match models.json: ${providerId}`);
		}
	}

	// providers/ 目录里不能有多余分片，也不能缺少某个 provider 的任一后缀。
	const shardFiles = readdirSync(providersDir).filter((name) => name.endsWith(".json")).sort();
	const expectedShardFiles = providerIds.flatMap((providerId) => [`${providerId}.json`, `${providerId}.all.json`]).sort();
	if (!isDeepStrictEqual(shardFiles, expectedShardFiles)) {
		throw new Error("Provider shard files do not match providers.json");
	}
	// 模型数量骤降通常意味着上游抓取失败，直接阻止发布。
	if (modelCount < MINIMUM_MODEL_COUNT) {
		throw new Error(`Refusing to publish only ${modelCount} models; expected at least ${MINIMUM_MODEL_COUNT}`);
	}

	// The full catalog is a superset of the chat catalog, so hashing it alone
	// changes the revision for chat-only and image-only updates alike.
	// 只哈希完整目录字节；它包含 chat，因此任何类型变化都会产生新 revision。
	const digest = createHash("sha256").update(allModelsBytes).digest("hex");
	return {
		modelsPath,
		allModelsPath,
		providerIndexPath,
		providersDir,
		providerIds,
		providerCount: providerIds.length,
		modelCount,
		chatModelCount: modelCount,
		imageModelCount,
		classifierModelCount,
		totalModelCount: modelCount + imageModelCount + classifierModelCount,
		// revision 是内容寻址标识；同一字节内容永远得到同一名称。
		revision: `sha256-${digest}`,
	};
}

// 读取当前 Git HEAD；在 CI 的 checkout 中可用，非 Git 目录会失败。
function gitSourceCommit() {
	const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Unable to determine source commit: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

// 同步执行 aws CLI；allowNotFound 时把 404/NoSuchKey 转成 false，而不是抛错。
function aws(args, { allowNotFound = false } = {}) {
	const result = spawnSync("aws", args, {
		encoding: "utf8",
		env: {
			...process.env,
			// R2 使用 auto 区域；未设置时补默认值。
			AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || "auto",
			// 禁止 SDK 探测 EC2 实例元数据，避免在非 EC2 环境卡住或访问内网地址。
			AWS_EC2_METADATA_DISABLED: "true",
		},
	});
	// spawn 失败（例如找不到 aws）时 result.error 存在。
	if (result.error) throw result.error;
	// 0 表示成功；下载索引时用 true 表示文件已取得。
	if (result.status === 0) return true;
	// 把 stdout/stderr 合并，兼容 aws 不同版本的错误输出位置。
	const message = `${result.stdout}\n${result.stderr}`.trim();
	// 首次发布时索引不存在，允许把 404/NoSuchKey/Not Found 当成“没有旧索引”。
	if (allowNotFound && /(?:404|NoSuchKey|Not Found)/i.test(message)) return false;
	throw new Error(`aws ${args.slice(0, 2).join(" ")} failed:\n${message}`);
}

// 下载现有索引；返回 false 表示对象不存在（首次发布）。
function downloadIndex(bucket, endpoint, outputPath) {
	return aws(
		[
			"s3",
			"cp",
			`s3://${bucket}/${MODEL_CATALOG_INDEX_KEY}`,
			outputPath,
			"--endpoint-url",
			endpoint,
			"--only-show-errors",
		],
		{ allowNotFound: true },
	);
}

// 上传一个 JSON 文件到指定键，显式设置 Content-Type 和 Cache-Control。
function uploadJson(bucket, endpoint, sourcePath, key, cacheControl) {
	aws([
		"s3",
		"cp",
		sourcePath,
		`s3://${bucket}/${key}`,
		"--endpoint-url",
		endpoint,
		"--content-type",
		JSON_CONTENT_TYPE,
		"--cache-control",
		cacheControl,
		"--only-show-errors",
	]);
}

// Validate with the same parser pi.dev uses, but keep the stored entries so
// the publication metadata of existing revisions is preserved.
// 用协议解析器校验索引，但返回原对象而不是剥离后的副本，以保留 sourceCommit 等发布元数据。
function validateIndex(index) {
	parseModelCatalogIndex(index);
	return index;
}

// 合并现有索引与新发布：同一最低版本的旧条目被替换，其他版本线保留。
function buildIndex(existingIndex, publication) {
	const entry = {
		minimumPiVersion: MINIMUM_PI_VERSION,
		revision: publication.revision,
		// 以下字段不属于协议必需字段，但会原样保存到存储中供审计。
		sourceCommit: publication.sourceCommit,
		publishedAt: new Date().toISOString(),
		providerCount: publication.providerCount,
		modelCount: publication.modelCount,
		chatModelCount: publication.chatModelCount,
		imageModelCount: publication.imageModelCount,
		classifierModelCount: publication.classifierModelCount,
		totalModelCount: publication.totalModelCount,
		modelTypes: publication.modelTypes,
	};
	// 先删掉同一最低版本下的旧 revision，再追加新条目；sort 按 semver 升序排列。
	const catalogs = (existingIndex?.catalogs || [])
		.filter((catalog) => catalog.minimumPiVersion !== MINIMUM_PI_VERSION)
		.concat(entry)
		.sort((left, right) => compareModelCatalogPiVersions(left.minimumPiVersion, right.minimumPiVersion));
	// 新发布的 revision 同时成为默认目录；旧客户端仍按各自版本线选择。
	return validateIndex({
		schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
		defaultRevision: publication.revision,
		catalogs,
	});
}

// 主流程：校验本地输入；dry-run 到此为止，否则与远端索引比较并上传。
async function main() {
	const options = parseArgs(process.argv.slice(2));
	const inputDir = resolve(options.input);
	const bundle = validateBundle(inputDir);
	const publication = {
		schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
		minimumPiVersion: MINIMUM_PI_VERSION,
		revision: bundle.revision,
		// --source-commit 可覆盖（测试/手动发布）；否则读取当前 HEAD。
		sourceCommit: options.sourceCommit || gitSourceCommit(),
		providerCount: bundle.providerCount,
		/** Legacy count for the chat-only `models.json` catalog. */
		modelCount: bundle.modelCount,
		chatModelCount: bundle.chatModelCount,
		imageModelCount: bundle.imageModelCount,
		classifierModelCount: bundle.classifierModelCount,
		totalModelCount: bundle.totalModelCount,
		/** Types present in the `.all` variant of this revision. */
		modelTypes: MODEL_TYPES,
	};
	// publication.json 是本地审计记录，也会进入 CI artifact；始终覆盖写入输入目录。
	writeFileSync(join(inputDir, "publication.json"), `${JSON.stringify(publication, null, 2)}\n`);

	console.log(JSON.stringify(publication, null, 2));
	if (options.dryRun) {
		console.log(`Validated model catalog at ${inputDir}; no objects uploaded.`);
		return;
	}

	// 临时目录只存放下载的旧索引和新索引，finally 中递归删除。
	const temporaryDir = mkdtempSync(join(tmpdir(), "pi-model-catalog-"));
	try {
		const currentIndexPath = join(temporaryDir, "index-current.json");
		// 首次发布没有索引时返回 false，currentIndex 保持 undefined。
		const hasCurrentIndex = downloadIndex(options.bucket, options.endpoint, currentIndexPath);
		const currentIndex = hasCurrentIndex ? validateIndex(readJson(currentIndexPath)) : undefined;
		// 查找当前最低版本对应的条目，用于判断是否已是最新。
		const currentEntry = currentIndex?.catalogs.find(
			(catalog) => catalog.minimumPiVersion === MINIMUM_PI_VERSION,
		);
		// 默认 revision 与本版本线条目都等于本次 revision 时，无需重复上传。
		if (currentIndex?.defaultRevision === bundle.revision && currentEntry?.revision === bundle.revision) {
			console.log(`Model catalog ${bundle.revision} is already current; no objects uploaded.`);
			return;
		}

		const revision = bundle.revision;
		// 上传清单：完整目录、完整全类型目录、provider 索引，以及每个 provider 的 legacy/typed 分片。
		const uploads = [
			[bundle.modelsPath, getModelCatalogArtifactKey(revision, "models.json")],
			[bundle.allModelsPath, getModelCatalogArtifactKey(revision, "models.all.json")],
			[bundle.providerIndexPath, getModelCatalogArtifactKey(revision, "providers.json")],
			...bundle.providerIds.flatMap((providerId) => [
				[join(bundle.providersDir, `${providerId}.json`), getModelCatalogProviderKey(revision, providerId, "legacy")],
				[join(bundle.providersDir, `${providerId}.all.json`), getModelCatalogProviderKey(revision, providerId, "typed")],
			]),
		];
		// revision 对象不可变，逐个上传；重复上传同键内容幂等。
		for (const [sourcePath, key] of uploads) {
			uploadJson(options.bucket, options.endpoint, sourcePath, key, IMMUTABLE_CACHE_CONTROL);
		}

		// 所有目录对象上传成功后才更新索引；索引是客户端看到新 revision 的提交点。
		const nextIndex = buildIndex(currentIndex, publication);
		const nextIndexPath = join(temporaryDir, "index-next.json");
		writeFileSync(nextIndexPath, `${JSON.stringify(nextIndex, null, 2)}\n`);
		uploadJson(options.bucket, options.endpoint, nextIndexPath, MODEL_CATALOG_INDEX_KEY, INDEX_CACHE_CONTROL);
		console.log(`Published ${revision} to s3://${options.bucket}/${MODEL_CATALOG_PREFIX}/revisions/${revision}`);
	} finally {
		// 删除临时索引文件；即使上传失败也不留敏感/过期数据。
		rmSync(temporaryDir, { recursive: true, force: true });
	}
}

// 顶层错误处理：不立即 process.exit，先设置 exitCode，让已注册的清理逻辑有机会完成。
main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
