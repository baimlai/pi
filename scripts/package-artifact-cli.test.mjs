// 文件导读
// 所属：仓库根 scripts/ 的脚本测试，覆盖三个 CLI 入口的参数校验：
//   local-release.mjs、pack-packages.mjs、use-local-packages.mjs。
// 作用：确认缺少选项值或使用不支持的包管理器时，脚本在开始昂贵/破坏性工作之前就失败。
// 测试夹具：runScript() 用 spawnSync 启动新的 Node 进程，cwd 固定为仓库根；
// assertFailsBeforeWork() 同时检查非零退出、stderr 文案，以及 stdout 没有构建输出。
// 覆盖行为：
//   1. --out/--manifest 缺少值时不进入 generate:models 或 npm run clean；
//   2. --package-manager yarn 在读取缺失 manifest 之前就被拒绝。
// 运行命令：node --test scripts/package-artifact-cli.test.mjs
// 前置条件：只需要 Node；测试使用不存在的路径，不会真的构建、安装或修改文件。
// 阅读顺序：先看两个断言 helper，再看两个 test。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 从当前测试文件定位 scripts/ 目录，避免依赖进程 cwd。
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDirectory, "..");

// 用当前 Node 运行同目录脚本；encoding:utf8 让断言能直接匹配文本。
function runScript(name, args) {
	return spawnSync(process.execPath, [join(scriptsDirectory, name), ...args], { cwd: repoRoot, encoding: "utf8" });
}

// 断言：非零退出、stderr 匹配预期错误，并且 stdout 没有后续构建阶段的标识。
function assertFailsBeforeWork(result, message) {
	// result.status 是退出码；被信号终止时为 null，也会与 0 不等。
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, message);
	// generate:models 是 local-release 的第一步，npm run clean 是 produceArtifactSet 的第一步；
	// 两者都没出现，说明参数校验发生在任何实际工作之前。
	assert.doesNotMatch(result.stdout, /generate:models|npm run clean/);
}

// 缺少选项值时，parseArgs 或显式检查应立刻报错；--force 不能顶替 --out 的值。
test("rejects missing option values before doing work", () => {
	assertFailsBeforeWork(runScript("local-release.mjs", ["--out"]), /--out/);
	assertFailsBeforeWork(runScript("pack-packages.mjs", ["--out", "--force"]), /--out/);
	assertFailsBeforeWork(runScript("use-local-packages.mjs", ["--manifest", "--consumer", "target"]), /--manifest/);
});

// 不支持的包管理器在检查 manifest 是否存在之前就应被拒绝，因此传 missing.json 也不会读到文件。
test("rejects an unsupported package manager before doing work", () => {
	assertFailsBeforeWork(
		runScript("use-local-packages.mjs", ["--manifest", "missing.json", "--consumer", "target", "--package", "example", "--package-manager", "yarn"]),
		/Unsupported package manager: yarn/,
	);
});
