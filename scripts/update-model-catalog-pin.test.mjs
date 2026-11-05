// 文件导读：model catalog pin 更新逻辑的离线测试。
// 所属：仓库根 scripts/ 的 node:test 测试；被测模块是 scripts/update-model-catalog-pin.mjs（同组文件）。
// 作用：用 mock 替换 globalThis.fetch 与临时目录，覆盖 pin 更新的关键决策：
//   - 新目录可用时写入新 revision；
//   - --if-stale 在旧 pin 仍可 hydrate 且模型分组一致时保留；
//   - 旧 pin 缺少新模型类型、API 变化、无法 hydrate 时替换；
//   - 新目录无法 hydrate 时拒绝写入；
//   - 发现/下载/哈希失败时保留旧 pin。
// 上游：开发者本地 `node --test scripts/update-model-catalog-pin.test.mjs`；无真实网络。
// 下游：updateModelCatalogPin 内部调用 hydrateModelCatalog 与 readModelDataProviderIds；测试夹具用最小
//   models.generated.ts 让 hydrate 只依赖 test-provider 的分组。
// 能力清单：
//   - model/catalog/revisionOf/pinFile/pinned：构造模型条目、目录字节、revision 与 pin 文件。
//   - mockPiDev：替换 fetch，返回 discovery 与 revision 两个 URL 的假响应。
//   - 7 组 test：新 pin、保留、分类器缺失、API 切换、无法 hydrate、新目录不可 hydrate、各种失败。
// 典型运行与预期：
//   示例 `node --test scripts/update-model-catalog-pin.test.mjs`；全部通过，无网络请求。
// 阅读顺序：先看 bodies Map 里五种目录变体，再看 mockPiDev 的 URL 分流，最后逐个读 test 的断言。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// beforeEach/afterEach 建立和清理每个用例的临时仓库；mock.restoreAll 恢复被替换的 fetch/console。
import { afterEach, beforeEach, mock, test } from "node:test";
import { updateModelCatalogPin } from "./update-model-catalog-pin.mjs";

// 一个最小的 chat 模型；字段与 hydrate 读取的目录结构一致。
const model = {
	type: "chat",
	id: "model-a",
	name: "Model A",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};
// 把模型数组包成 provider→数组 的目录 JSON 字符串；末尾换行与真实发布文件一致。
const catalog = (models) => `${JSON.stringify({ "test-provider": models })}\n`;
// 计算与脚本相同的 revision 格式；输入是字符串，createHash 直接接受。
const revisionOf = (body) => `sha256-${createHash("sha256").update(body).digest("hex")}`;
// pin 文件用 2 空格缩进并补换行，与脚本写入格式完全一致，便于字符串比较。
const pinFile = (revision) => `${JSON.stringify({ revision }, null, 2)}\n`;
// 包装被测 promise：解构去掉 bytes，断言 bytes 与 revision 对应的目录字节一致，再返回其余字段。
// 这样测试既检查返回值结构，也验证下载内容没有被错误替换。
// 例：await pinned(updateModelCatalogPin(root)) 得到 {revision, updated}。
const pinned = async (promise) => {
	// 剩余属性收集到 result；bytes 是 Buffer，单独比较。
	const { bytes, ...result } = await promise;
	assert.equal(bytes.toString("utf8"), bodies.get(result.revision));
	return result;
};

// 五种目录变体：
// live：main 已发布的最新目录，多一个 model-b。
const liveBody = catalog([model, { ...model, id: "model-b" }]);
const liveRevision = revisionOf(liveBody);
// current：旧 pin 指向的目录，只有 model。
const currentBody = catalog([model]);
const currentRevision = revisionOf(currentBody);
// Hydration fails when a checkout provider is missing, e.g. after main adds one.
// stale：只有另一个 provider，无法为 checkout 的 test-provider 生成数据，hydrate 会失败。
const staleBody = `${JSON.stringify({ "other-provider": [model] })}\n`;
const staleRevision = revisionOf(staleBody);
// Hydrates, but lacks a model type the live catalog (generated from main) has.
// classifier：能 hydrate，但比 live 少 classifier 分组；复制 model 后改 type/id/name。
const classifier = { ...model, type: "classifier", id: "classifier-a", name: "Classifier A" };
// delete 删除对象属性；classifier 不需要 reasoning/maxTokens，模拟真实分类器模型字段。
delete classifier.reasoning;
delete classifier.maxTokens;
const classifierBody = catalog([model, classifier]);
const classifierRevision = revisionOf(classifierBody);
// Hydrates with the same model types, but main switched the provider's API (#10985).
// switched：分组类型相同但 API 不同，仍应被视为过期，因为生成的 Provider 泛型会不匹配。
const switchedBody = catalog([{ ...model, api: "anthropic-messages" }]);
const switchedRevision = revisionOf(switchedBody);
// revision→目录字节 的查找表；mock fetch 按 URL 中的 revision 取内容。
const bodies = new Map([
	[liveRevision, liveBody],
	[currentRevision, currentBody],
	[staleRevision, staleBody],
	[classifierRevision, classifierBody],
	[switchedRevision, switchedBody],
]);
// 测试请求使用的查询串；断言完整 URL 时复用同一常量，避免手写不一致。
const typed = "types=chat,image,classifier";

// root 在每个用例前重建，用例之间不共享文件状态。
let root;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-catalog-pin-"));
	// 目录结构必须与仓库一致：models.generated.ts、providers 子目录、nix pin。
	mkdirSync(join(root, "packages/ai/src/providers"), { recursive: true });
	mkdirSync(join(root, "nix"));
	// 这行 import 是 readModelDataProviderIds 的输入；它从生成的 wrapper 文件名推断 provider id。
	writeFileSync(
		join(root, "packages/ai/src/models.generated.ts"),
		'import { TEST_PROVIDER_CLASSIFIER_MODELS, TEST_PROVIDER_IMAGE_MODELS, TEST_PROVIDER_MODELS } from "./providers/test-provider.models.ts";\n',
	);
	// wrapper 文件本身内容不重要，只要存在；hydrate 会按目录内容重写它（validateOnly 时不写）。
	writeFileSync(join(root, "packages/ai/src/providers/test-provider.models.ts"), "");
	// 初始 pin 指向 currentRevision；多数用例从“旧 pin 仍可 hydrate”出发。
	writeFileSync(join(root, "nix/model-catalog.json"), pinFile(currentRevision));
});
afterEach(() => {
	// 恢复被 mock.method 替换的全局 fetch/console.error，避免影响后续用例。
	mock.restoreAll();
	rmSync(root, { recursive: true, force: true });
});

// 读取 pin 文件原文；断言保留旧 pin 时比较完整字符串，连格式也一起验证。
function readPin() {
	return readFileSync(join(root, "nix/model-catalog.json"), "utf8");
}

// 替换 globalThis.fetch，模拟 pi.dev 的发现与 revision 两个端点；返回记录请求 URL 的数组。
// live 参数决定发现端点返回哪个 revision；failure 指定一种故障模式。
// 例：mockPiDev({live: classifierRevision}) 让发现端点指向 classifier 目录。
// 真实运行时这些是 HTTPS 请求；测试中只构造内存 Response，不联网。
function mockPiDev({ live = liveRevision, failure } = {}) {
	const requests = [];
	// mock.method 替换对象方法并在 restoreAll 时恢复；回调形参 url 是字符串。
	mock.method(globalThis, "fetch", async (url) => {
		requests.push(url);
		// 正则提取 revision 路径段；`?.[1]` 在无匹配时返回 undefined。
		const revision = /\/revisions\/(sha256-[0-9a-f]+)\?/.exec(url)?.[1];
		if (revision) {
			// revision 端点故障：HTTP 503 或返回与 revision 不符的内容。
			if (failure === "revision-http") return new Response(null, { status: 503 });
			return new Response(failure === "revision-hash" ? "wrong" : bodies.get(revision));
		}
		// 非 revision URL 视为发现端点；同样支持 HTTP 与哈希故障。
		if (failure === "discovery-http") return new Response(null, { status: 503 });
		// discovery-revision 故障返回格式非法的头；否则返回 live revision。
		return new Response(failure === "discovery-hash" ? "wrong" : bodies.get(live), {
			headers: { "x-pi-model-catalog-revision": failure === "discovery-revision" ? "latest" : live },
		});
	});
	return requests;
}

// 正常路径：旧 pin 没有 ifStale 检查，直接发现并下载最新目录，验证两次请求 URL 顺序正确、pin 被更新。
// 例：初始 pin 为 current，发现 live 后写入 liveRevision。
test("pins the newest typed catalog after verifying its immutable URL", async () => {
	const requests = mockPiDev();
	// updated=true 表示 revision 从 current 变成 live；pinned 同时校验 bytes 内容。
	assert.deepEqual(await pinned(updateModelCatalogPin(root)), { revision: liveRevision, updated: true });
	// No pi-version: main's version is the last release, which pi.dev answers
	// with the catalog for released clients (#10985).
	// URL 里没有 pi-version 查询参数；顺序是先发现、再下载不可变 revision。
	assert.deepEqual(requests, [
		`https://pi.dev/api/models?${typed}`,
		`https://pi.dev/api/models/revisions/${liveRevision}?${typed}`,
	]);
	// 写入的 pin 文件格式与 pinFile 完全一致。
	assert.equal(readPin(), pinFile(liveRevision));
});

// ifStale 路径：先验证旧 pin（revision+hydrate），再发现 live；分组一致时保留旧 pin，不写文件。
// 例：旧 current 的 chat 分组与 live 相同，因此返回 updated:false 且 pin 仍为 currentRevision。
test("keeps a pin that still hydrates the checkout and has the live model groups", async () => {
	const requests = mockPiDev();
	// 返回旧 revision，且 updated=false；注意 bytes 也是旧目录的内容。
	assert.deepEqual(await pinned(updateModelCatalogPin(root, { ifStale: true })), {
		revision: currentRevision,
		updated: false,
	});
	// 三次请求：旧 revision → 发现 live → 下载 live 用于分组比较。
	assert.deepEqual(requests, [
		`https://pi.dev/api/models/revisions/${currentRevision}?${typed}`,
		`https://pi.dev/api/models?${typed}`,
		`https://pi.dev/api/models/revisions/${liveRevision}?${typed}`,
	]);
	assert.equal(readPin(), pinFile(currentRevision));
});

// 旧 pin 能 hydrate，但 live 多了 classifier 分组；应替换 pin 并在 stderr 说明缺失分组。
// 例：错误消息包含 missing test-provider/classifier/openai-completions。
test("replaces a pin that lacks a model type of the live catalog", async (t) => {
	// 捕获 console.error 的文本，验证诊断没有丢失；t.mock 是测试级 mock，用例结束自动恢复。
	const errors = [];
	t.mock.method(console, "error", (message) => errors.push(message));
	mockPiDev({ live: classifierRevision });
	// 新 pin 为 classifierRevision（live）。
	assert.deepEqual(await pinned(updateModelCatalogPin(root, { ifStale: true })), {
		revision: classifierRevision,
		updated: true,
	});
	assert.equal(readPin(), pinFile(classifierRevision));
	// 诊断按 missing 分组排序后拼接，精确匹配证明差集方向没有写反。
	assert.deepEqual(errors, [
		"Pinned model catalog is stale: model groups differ (missing test-provider/classifier/openai-completions)",
	]);
});

// #10985
// 旧 pin 与 live 的模型类型相同但 API 不同：仍必须替换，同时报告 missing/extra 两侧。
// 例：旧 pin 是 anthropic-messages，live 是 openai-completions。
test("replaces a pin whose provider uses a different API than the live catalog", async (t) => {
	const errors = [];
	t.mock.method(console, "error", (message) => errors.push(message));
	// 直接把初始 pin 覆盖为 switchedRevision，模拟 main 切换 API 后的旧 pin。
	writeFileSync(join(root, "nix/model-catalog.json"), pinFile(switchedRevision));
	mockPiDev();
	assert.deepEqual(await pinned(updateModelCatalogPin(root, { ifStale: true })), { revision: liveRevision, updated: true });
	assert.equal(readPin(), pinFile(liveRevision));
	// 分号分隔 missing 与 extra，且各自排序；精确匹配锁住消息格式。
	assert.deepEqual(errors, [
		"Pinned model catalog is stale: model groups differ (missing test-provider/chat/openai-completions; extra test-provider/chat/anthropic-messages)",
	]);
});

// 旧 pin 无法 hydrate（provider 缺失）时应替换；console.error 被静默捕获，只验证结果。
test("replaces a pin that no longer hydrates the checkout", async (t) => {
	t.mock.method(console, "error", () => {});
	writeFileSync(join(root, "nix/model-catalog.json"), pinFile(staleRevision));
	mockPiDev();
	assert.deepEqual(await pinned(updateModelCatalogPin(root, { ifStale: true })), { revision: liveRevision, updated: true });
	assert.equal(readPin(), pinFile(liveRevision));
});

// 最新目录本身无法 hydrate checkout：必须拒绝写 pin，旧 pin 原样保留。
// assert.rejects 等待 promise 拒绝，并用正则匹配错误消息。
test("refuses to pin a live catalog that cannot hydrate the checkout", async () => {
	mockPiDev({ live: staleRevision });
	await assert.rejects(updateModelCatalogPin(root), /cannot hydrate this checkout/);
	assert.equal(readPin(), pinFile(currentRevision));
});

// 参数化五类网络/哈希故障：无论发现还是下载失败，都不得改动旧 pin。
for (const failure of ["discovery-http", "discovery-revision", "discovery-hash", "revision-http", "revision-hash"]) {
	// 模板字符串生成用例名，失败时能直接看出是哪一种故障。
	test(`keeps the old pin on ${failure} failure`, async () => {
		mockPiDev({ failure });
		// 没有指定消息正则，只要求 promise 拒绝。
		await assert.rejects(updateModelCatalogPin(root));
		assert.equal(readPin(), pinFile(currentRevision));
	});
}

// ifStale 下旧 revision 本身不可达：不能把它当作“过期”而静默替换，应报错并保留 pin。
test("does not treat an unreachable pinned revision as stale", async () => {
	mockPiDev({ failure: "revision-http" });
	// 错误来自 fetchRevision 的 HTTP 503 消息，包含 unavailable。
	await assert.rejects(updateModelCatalogPin(root, { ifStale: true }), /unavailable/);
	assert.equal(readPin(), pinFile(currentRevision));
});
