// 文件导读：模型目录发布脚本的计数测试。
// 所属：仓库根 scripts/ 目录的 node:test 单元测试，被测对象是 scripts/publish-model-catalog.mjs（不在本组）。
// 作用：在临时目录构造一套模型目录输入包，再以 --dry-run 运行发布脚本，检查它写入的 publication.json 计数是否正确：
//   modelCount/chatModelCount 是旧版 chat 投影数量，image/classifier 单独计数，totalModelCount 是三者之和。
// 上游：开发者本地执行，例如 `node --test scripts/publish-model-catalog.test.mjs`；不在 npm test 或 CI 的固定入口里。
// 下游：被测脚本读取 models.json、models.all.json、providers.json 与 providers/*.json；--dry-run 只写临时目录里的
//   publication.json，不访问网络、不上传对象存储。测试失败时 spawnSync 的 status 非 0 或断言抛错。
// 能力清单：
//   - writeJson(path, value)：把 JS 值序列化成 JSON 文件，补一个末尾换行。
//   - test("publishes explicit per-type and total model counts", ...)：唯一的测试，覆盖分类型计数与旧版总数。
// 运行方式与预期：
//   真实命令 `node --test scripts/publish-model-catalog.test.mjs`；成功时 1 个测试通过，无网络请求。
//   测试使用 500 个 chat 模型加 openrouter 的 1 个 image、1 个 classifier，因此断言 500/500/1/1/502。
// 阅读顺序：先看 writeJson，再看 test 中 anthropic/openai/openrouter 三个 provider 的“旧版映射 + 全量数组”结构，
//   最后看 5 条断言分别对应 publication.json 的哪个字段。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
// 同步读取、写文件、建临时目录和删除目录；测试夹具结束后由 rmSync 清理。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// tmpdir 给出操作系统临时目录，避免污染仓库。
import { tmpdir } from "node:os";
// join 拼接跨平台路径。
import { join } from "node:path";
// fileURLToPath 把 import.meta.url 的 file URL 转成本地路径，用来定位仓库根。
import { fileURLToPath } from "node:url";
// node:test 的 test 函数注册用例；t.after 注册用例级清理钩子。
import test from "node:test";

// new URL("..", import.meta.url) 表示本文件上一级目录（仓库根），再转成文件系统路径；
// 之后启动子进程时以 root 作为 cwd，使 `scripts/publish-model-catalog.mjs` 相对路径成立。
const root = fileURLToPath(new URL("..", import.meta.url));

// 把 value 写成 JSON 文件并补末尾换行：被测脚本按整文件读取，末尾换行不是必需，但保持仓库常见格式。
// 例：writeJson("/tmp/x/models.json", { anthropic: {} }) 生成 `{"anthropic":{}}\n`。
function writeJson(path, value) {
	// JSON.stringify 省略缩进参数，得到单行 JSON；模板字符串只负责追加换行，不影响 JSON 内容。
	writeFileSync(path, `${JSON.stringify(value)}\n`);
}

// 主测试：验证发布脚本对 chat/image/classifier 三类模型分别计数，并保留旧版 chat 总数。
// 输入是测试自造的输入目录；输出是子进程退出码与 publication.json 内容；失败标准是脚本非 0 退出或计数不符。
// 真实运行时子进程以 --dry-run 运行：只校验并写 publication.json，不访问 S3。
// 例：500 个 chat + 1 个 image + 1 个 classifier，断言 totalModelCount === 502。
test("publishes explicit per-type and total model counts", (t) => {
	// mkdtempSync 创建带随机后缀的临时目录；同一时间跑多个测试也不会互相覆盖。
	const input = mkdtempSync(join(tmpdir(), "pi-model-catalog-counts-"));
	// t.after 注册用例结束后的清理：recursive 删除整棵临时树，force 让不存在时也不报错。
	t.after(() => rmSync(input, { recursive: true, force: true }));
	// 被测脚本要求 providers 子目录存放每个 provider 的旧版/全量分片。
	const providersDir = join(input, "providers");
	// 先建目录，后面的 writeJson 不会自动创建父目录。
	mkdirSync(providersDir);

	// Array.from({ length: 500 }) 生成 500 项；回调第二参 index 依次为 0..499，用来生成唯一 id。
	// 三个字段模拟真实目录里 chat 模型的必要部分：type 决定计数归类，id 在 provider 内唯一，provider 必须与键一致。
	const chatModels = Array.from({ length: 500 }, (_, index) => ({
		type: "chat",
		id: `chat-${index}`,
		provider: "anthropic",
	}));
	// 全量目录：每个 provider 对应一个模型数组，元素必须显式带 type。
	// openai 为空数组也保留键，因为脚本要求三个必需 provider 都存在且三份清单的 provider 集合完全一致。
	const allModels = {
		anthropic: chatModels,
		openai: [],
		openrouter: [
			// image 与 classifier 故意使用相同 id：脚本按 `type:id` 判重，所以不同类型同 id 合法。
			{ type: "image", id: "shared", provider: "openrouter" },
			{ type: "classifier", id: "shared", provider: "openrouter" },
		],
	};
	// 旧版目录只包含 chat 模型的 id→模型映射，等价于全量目录的 chat 投影；
	// openrouter 没有 chat 模型，所以这里是空对象。
	const models = {
		// Object.fromEntries 把 [id, model] 二元组数组变成对象；类型是 Record<string, model>。
		anthropic: Object.fromEntries(chatModels.map((model) => [model.id, model])),
		openai: {},
		openrouter: {},
	};
	// 脚本要求 providers.json 与 models.all.json 的键按字符串排序后完全一致，因此这里先 sort。
	const providerIds = Object.keys(allModels).sort();
	// 三份顶层清单：旧版映射、全量数组、provider 索引。
	writeJson(join(input, "models.json"), models);
	writeJson(join(input, "models.all.json"), allModels);
	writeJson(join(input, "providers.json"), providerIds);
	// 每个 provider 再写两份分片：`<id>.json` 是旧版 chat 映射，`<id>.all.json` 是全量数组；
	// 脚本会逐字节比较分片与顶层清单，任何不一致都会让子进程失败。
	for (const providerId of providerIds) {
		writeJson(join(providersDir, `${providerId}.json`), models[providerId]);
		writeJson(join(providersDir, `${providerId}.all.json`), allModels[providerId]);
	}

	// spawnSync 同步启动子进程：process.execPath 是当前 Node 可执行文件，保证与被测环境同一版本。
	// 参数数组依次传入脚本路径和选项；--dry-run 让脚本校验后直接返回，不读取 S3 凭证。
	const result = spawnSync(
		process.execPath,
		[
			"scripts/publish-model-catalog.mjs",
			"--input",
			input,
			"--source-commit",
			"test-commit",
			"--dry-run",
		],
		// cwd 固定为仓库根，使脚本相对路径不依赖测试进程当前目录；encoding 让 stdout/stderr 直接是字符串。
		{ cwd: root, encoding: "utf8" },
	);
	// 第三个参数是断言失败时的诊断信息；先看脚本输出可区分“校验失败”和“计数不符”。
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	// 脚本把发布元数据写回输入目录的 publication.json；JSON.parse 在运行时解析，字段类型没有 schema 校验。
	const publication = JSON.parse(readFileSync(join(input, "publication.json"), "utf8"));
	// modelCount 是历史字段，仍表示旧版 chat 目录的模型数。
	assert.equal(publication.modelCount, 500);
	// 新字段 chatModelCount 与旧版计数相同；这里锁住“两者都只数 chat”的约定。
	assert.equal(publication.chatModelCount, 500);
	// image/classifier 分别统计，证明计数没有把所有类型混在一起。
	assert.equal(publication.imageModelCount, 1);
	assert.equal(publication.classifierModelCount, 1);
	// 总数是三类之和：500 + 1 + 1 = 502；openrouter 的两个模型各算一个，即使 id 相同。
	assert.equal(publication.totalModelCount, 502);
});
