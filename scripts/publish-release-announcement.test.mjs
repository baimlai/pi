// 文件导读：发布公告脚本的版本比较与 latest 指针更新测试。
// 所属：仓库根 scripts/ 的 node:test 单元测试，被测模块是 scripts/publish-release-announcement.mjs（同组文件）。
// 作用：只覆盖两个纯逻辑导出，不访问 S3、不查询 npm registry：
//   - compareReleaseVersions：按数字比较三段稳定版本。
//   - advanceLatestRelease：在并发发布时用 ETag/if-none-match 条件写推进 latest.json，
//     不把较新公告回退成旧版本。
// 上游：开发者本地执行 `node --test scripts/publish-release-announcement.test.mjs`，也可作为 CI 前置信号。
// 下游：被测模块在这些测试里只接收注入的 readLatest/writeLatest 异步函数，真正 AWS 调用留在 main 中不执行。
// 能力清单（测试分组）：
//   - 稳定版本数值比较与预发布版本拒绝。
//   - 已存在更新标记时不写入。
//   - 条件写失败后重读、保留竞争者的更新版本。
//   - 标记缺失时用 if-none-match 创建。
// 典型运行与预期：
//   示例 `node --test scripts/publish-release-announcement.test.mjs`，4 个测试通过；无网络、无临时文件。
// 阅读顺序：先看两个导入的导出，再看每个 test 注入的假 read/write 行为与断言结果。
import assert from "node:assert/strict";
// node:test 提供 test；这些用例不使用夹具或 mock。
import test from "node:test";
// 从被测模块导入两个纯函数；导入模块本身不会执行 main（脚本用 import.meta.url 判断是否为主模块）。
import { advanceLatestRelease, compareReleaseVersions } from "./publish-release-announcement.mjs";

// 验证版本比较按数字而非字符串：0.84.10 大于 0.84.9，且稳定版本相等返回 0。
// 预发布后缀不符合 STABLE_SEMVER_RE，函数应抛错而不是猜测排序。
// 例：compareReleaseVersions("0.84.10", "0.84.9") 返回 1。
test("compares stable release versions numerically", () => {
	// 主版本号大者胜出；assert.ok 只要求条件为真。
	assert.ok(compareReleaseVersions("0.85.0", "0.84.9") > 0);
	// 若按字符串比较 "0.84.10" < "0.84.9"，这里会失败；按数字比较则通过。
	assert.ok(compareReleaseVersions("0.84.10", "0.84.9") > 0);
	// 完全相同返回 0。
	assert.equal(compareReleaseVersions("0.84.0", "0.84.0"), 0);
	// 预发布后缀不是稳定三段版本，函数必须抛错；assert.throws 只要求抛出任意 Error。
	assert.throws(() => compareReleaseVersions("0.85.0-beta.1", "0.84.0"));
});

// 场景：S3 中已有 0.85.0 的 latest 标记，本次尝试“推进”到更旧的 0.84.0。
// 期望：直接返回已有版本且 advanced=false，不调用写入函数，从而不回退线上公告。
// 例：readLatest 返回 {etag:'"newer"', version:'0.85.0'}，writeCount 保持 0。
test("does not regress an existing newer release marker", async () => {
	// 计数写入次数，用来证明没有发生条件写。
	let writeCount = 0;
	// 第二个参数是注入的 readLatest；第三个是 writeLatest，本用例不应被执行。
	const result = await advanceLatestRelease(
		"0.84.0",
		async () => ({ etag: '"newer"', version: "0.85.0" }),
		async () => {
			writeCount++;
			return true;
		},
	);

	// deepEqual 比较对象结构；返回的是当前标记的版本，不是传入的目标版本。
	assert.deepEqual(result, { advanced: false, version: "0.85.0" });
	assert.equal(writeCount, 0);
});

// 场景：第一次读到 0.83.0，条件写因 ETag 过期失败（返回 false）；重读发现竞争者已写 0.85.0。
// 期望：函数停止重试，返回 0.85.0 且 advanced=false，不覆盖竞争者的更新。
// 例：writeLatest 收到 {etag:'"previous"'} 并返回 false，仅调用一次。
test("retries a lost conditional update and preserves a racing newer marker", async () => {
	// readCount 区分第一次与重试后的读取结果。
	let readCount = 0;
	let writeCount = 0;
	const result = await advanceLatestRelease(
		"0.84.0",
		// 第一次返回旧标记，后续返回竞争者写入的新标记；async 函数自动包装为 Promise。
		async () => {
			readCount++;
			// 三元表达式按读取次数切换返回对象，模拟并发更新。
			return readCount === 1
				? { etag: '"previous"', version: "0.83.0" }
				: { etag: '"newer"', version: "0.85.0" };
		},
		// writeLatest 的输入是条件对象；这里断言它基于第一次读到的 ETag，然后模拟 412 失败。
		async (condition) => {
			writeCount++;
			assert.deepEqual(condition, { etag: '"previous"' });
			return false;
		},
	);

	// 重读后目标 0.84.0 仍然小于 0.85.0，因此不再尝试写入。
	assert.deepEqual(result, { advanced: false, version: "0.85.0" });
	assert.equal(writeCount, 1);
});

// 场景：latest 标记尚不存在，需要创建而不是覆盖。
// 期望：writeLatest 收到 {missing:true}（对应 S3 的 if-none-match: *），成功后返回目标版本。
// 例：readLatest 返回 undefined，writeLatest 收到 {missing:true} 并返回 true。
test("creates a missing marker with an if-none-match condition", async () => {
	// 用外部变量捕获 writeLatest 实际收到的条件对象。
	let condition;
	const result = await advanceLatestRelease(
		"0.84.0",
		async () => undefined,
		async (value) => {
			condition = value;
			return true;
		},
	);

	// 没有旧标记时 0.84.0 可以推进，advanced 为 true。
	assert.deepEqual(result, { advanced: true, version: "0.84.0" });
	// missing 标志让上层上传使用“仅当对象不存在时创建”的条件，避免与其他发布并发覆盖。
	assert.deepEqual(condition, { missing: true });
});
