// 文件导读
// 所属：仓库根 scripts/ 的脚本测试，被测对象是 model-catalog-protocol.ts。
// 作用：用固定索引和请求样例验证存储键、semver 比较、目录选择、请求解析和索引校验。
// 测试夹具：两个 sha256 revision（legacyRevision/mixedApiRevision）加一个最小 ModelCatalogIndex；
// 不访问网络、不读写文件，全部是纯函数断言。测试直接 import .ts，依赖 Node 的类型擦除运行。
// 覆盖分组：
//   1. revision 作用域的存储键（完整目录与 provider 分片）；
//   2. semver 优先级（正式版 > 预发布、数字段数值比较、v 前缀/构建元数据、非法版本抛错）；
//   3. 按版本选择目录，含 #9099 回归：0.85.0 之前的客户端拿不到 mixed-API 目录；
//   4. 从 User-Agent 推断版本，以及显式 pi-version 优先、无版本走默认目录；
//   5. 非法参数返回 invalid；
//   6. 索引校验并剥离发布元数据。
// 运行命令：node --test scripts/model-catalog-protocol.test.ts
// 阅读顺序：先看顶部 fixture index，再按 test 名称读断言。
import assert from "node:assert/strict";
import test from "node:test";
// type ModelCatalogIndex 是仅编译期使用的类型导入；运行时会被擦除。
import {
	compareModelCatalogPiVersions,
	getModelCatalogArtifactKey,
	getModelCatalogProviderKey,
	type ModelCatalogIndex,
	parseModelCatalogIndex,
	parseModelCatalogRepresentation,
	parseModelCatalogRequest,
	selectModelCatalog,
} from "./model-catalog-protocol.ts";

// 固定 revision：用重复字符构造合法的 sha256-64 位十六进制格式。
const legacyRevision = `sha256-${"a".repeat(64)}`;
const mixedApiRevision = `sha256-${"b".repeat(64)}`;
// 两条目录线：0.80.7 起提供 legacy，0.85.0 起提供 mixed API；默认指向 mixed。
const index: ModelCatalogIndex = {
	schemaVersion: 1,
	defaultRevision: mixedApiRevision,
	catalogs: [
		{ minimumPiVersion: "0.80.7", revision: legacyRevision },
		{ minimumPiVersion: "0.85.0", revision: mixedApiRevision },
	],
};

// 存储键：完整目录文件以及 legacy/typed 两种 provider 分片的后缀。
test("builds revision scoped storage keys", () => {
	assert.equal(
		getModelCatalogArtifactKey(legacyRevision, "models.json"),
		`models/v1/revisions/${legacyRevision}/models.json`,
	);
	assert.equal(
		getModelCatalogProviderKey(legacyRevision, "openrouter", "legacy"),
		`models/v1/revisions/${legacyRevision}/providers/openrouter.json`,
	);
	assert.equal(
		getModelCatalogProviderKey(legacyRevision, "openrouter", "typed"),
		`models/v1/revisions/${legacyRevision}/providers/openrouter.all.json`,
	);
});

// semver 比较：预发布低于正式版；rc.2 < rc.10 说明数字段按数值而非字符串比较。
test("orders Pi versions with semver precedence", () => {
	// assert.ok 只要求真值；比较函数返回正数表示 left 更新。
	assert.ok(compareModelCatalogPiVersions("0.85.0", "0.84.4") > 0);
	assert.ok(compareModelCatalogPiVersions("0.85.0-rc.1", "0.85.0") < 0);
	// 字符串比较会得到 "rc.2" > "rc.10"，这里验证实现按数字 2 < 10。
	assert.ok(compareModelCatalogPiVersions("0.85.0-rc.2", "0.85.0-rc.10") < 0);
	// v 前缀和 +build 构建元数据不影响优先级。
	assert.equal(compareModelCatalogPiVersions("v1.0.0", "1.0.0+build"), 0);
	// 只有两段的版本非法，比较函数按文档抛错。
	assert.throws(() => compareModelCatalogPiVersions("0.85", "0.85.0"), /Invalid Pi version/);
});

// 目录选择：取不超过请求版本的最高最低版本；低于最小值或无版本时走默认/undefined。
test("selects the newest catalog a Pi version supports", () => {
	// Regression test for #9099: released clients before 0.85.0 cannot use the mixed-API catalog.
	assert.equal(selectModelCatalog(index, "0.84.4")?.revision, legacyRevision);
	// 预发布 0.85.0-rc.1 仍低于 0.85.0，因此拿 legacy。
	assert.equal(selectModelCatalog(index, "0.85.0-rc.1")?.revision, legacyRevision);
	assert.equal(selectModelCatalog(index, "0.85.0")?.revision, mixedApiRevision);
	// 更高版本继续使用最高的一条。
	assert.equal(selectModelCatalog(index, "1.0.0")?.revision, mixedApiRevision);
	// 低于所有最低版本时没有兼容目录。
	assert.equal(selectModelCatalog(index, "0.80.6"), undefined);
	// 无版本请求返回索引的 defaultRevision。
	assert.equal(selectModelCatalog(index, undefined)?.revision, mixedApiRevision);
});

// 请求解析：已发布客户端只在 User-Agent 里带版本；带括号的环境信息应被忽略。
test("serves Pi user agents the catalog for their version", () => {
	// Regression test for #9099: released clients identify themselves only by User-Agent.
	// types=chat%2Cimage 解码后是 "chat,image"，表示 typed 表示。
	assert.deepEqual(
		parseModelCatalogRequest(
			"https://pi.dev/api/models/providers/openrouter?types=chat%2Cimage",
			"pi/0.84.4 (linux; node/v22.0.0; x64)",
		),
		{ kind: "catalog", piVersion: "0.84.4", representation: "typed" },
	);
	// 没有 types 参数时是 legacy；UA 只有 pi/版本，没有括号。
	assert.deepEqual(parseModelCatalogRequest("https://pi.dev/api/models", "pi/0.84.4"), {
		kind: "catalog",
		piVersion: "0.84.4",
		representation: "legacy",
	});
});

// 显式参数与无 Pi UA 的情况：显式版本覆盖 UA；curl 等无版本请求走默认目录。
test("serves explicit and unversioned catalog requests", () => {
	// 显式 pi-version=0.83.0 优先于 UA 中的 0.85.1。
	assert.deepEqual(
		parseModelCatalogRequest("https://pi.dev/api/models?pi-version=0.83.0", "pi/0.85.1 (linux; node/v22.0.0; x64)"),
		{ kind: "catalog", piVersion: "0.83.0", representation: "legacy" },
	);
	// 非 Pi UA（curl）没有版本信息，但 types 合法，仍返回 typed catalog。
	assert.deepEqual(parseModelCatalogRequest("https://pi.dev/api/models?types=chat", "curl/8.0.0"), {
		kind: "catalog",
		piVersion: undefined,
		representation: "typed",
	});
	// UA 版本 "latest" 不合法：不报错，退回无版本请求。
	assert.deepEqual(parseModelCatalogRequest("https://pi.dev/api/models", "pi/latest"), {
		kind: "catalog",
		piVersion: undefined,
		representation: "legacy",
	});
});

// 非法参数：显式 pi-version 不合法或 types 为空/含非法字符时返回 invalid。
test("rejects invalid catalog request parameters", () => {
	assert.deepEqual(parseModelCatalogRequest("https://pi.dev/api/models?pi-version=latest", undefined), {
		kind: "invalid",
		error: "Invalid Pi version.",
	});
	assert.deepEqual(parseModelCatalogRequest("https://pi.dev/api/models?types=", "pi/0.84.4"), {
		kind: "invalid",
		error: "Invalid model types.",
	});
	// 以 - 开头的类型名不匹配 MODEL_TYPE_RE。
	assert.equal(parseModelCatalogRepresentation("chat,-image"), undefined);
	// null 表示参数缺失，等价于老客户端。
	assert.equal(parseModelCatalogRepresentation(null), "legacy");
});

// 索引校验：额外发布元数据被剥离；schema/defaultRevision/最低版本非法时抛错。
test("validates stored indexes and drops publication metadata", () => {
	// 构造带 sourceCommit/modelCount 的条目，解析结果应严格等于纯协议 fixture。
	assert.deepEqual(
		parseModelCatalogIndex({
			...index,
			catalogs: index.catalogs.map((catalog) => ({ ...catalog, sourceCommit: "abc", modelCount: 1 })),
		}),
		index,
	);
	// schemaVersion 不匹配。
	assert.throws(() => parseModelCatalogIndex({ ...index, schemaVersion: 2 }), /index is invalid/);
	// defaultRevision 格式不合法（虽然 64 位，但 revision 不在 catalogs 里）。
	assert.throws(() => parseModelCatalogIndex({ ...index, defaultRevision: `sha256-${"c".repeat(64)}` }), /invalid/);
	// 条目里的 minimumPiVersion 不是合法版本。
	assert.throws(
		() => parseModelCatalogIndex({ ...index, catalogs: [{ minimumPiVersion: "latest", revision: legacyRevision }] }),
		/invalid/,
	);
});
