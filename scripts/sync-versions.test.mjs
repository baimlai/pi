// 文件导读：scripts/sync-versions.js 的端到端测试。
// 所属：仓库根 scripts/ 的 node:test 测试；被测脚本是 scripts/sync-versions.js（同目录，非本组注释对象）。
// 作用：在临时目录造一个最小工作区，运行真实脚本，验证：
//   - 三个依赖区（dependencies/devDependencies/optionalDependencies）会被改成精确工作区版本；
//   - npm: registry 别名保持不变，install-lock 生成清单不被改写；
//   - 可发布包版本不一致时脚本以 1 退出；
//   - pi-ai 的 version.ts 常量被同步。
// 上游：开发者本地运行 `node --test scripts/sync-versions.test.mjs`。
// 下游：spawnSync 启动 node scripts/sync-versions.js，参数是临时 packages 目录；测试只操作临时目录。
// 能力清单：
//   - writeManifest/readManifest：在临时根下写/读 package.json。
//   - runSyncVersions：以临时根为 cwd 运行被测脚本。
//   - 两个 test：lockstep 与依赖改写；pi-ai 版本常量。
// 典型运行与预期：
//   示例 `node --test scripts/sync-versions.test.mjs`，2 个测试通过；无网络、无仓库写入。
// 阅读顺序：先看夹具 helper，再看第一个测试的期望值，最后看版本常量测试。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
// fs/promises 版本提供 async/await 文件操作；测试用 await 顺序读写。
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// fileURLToPath 把相对本文件的 URL 转成被测脚本的绝对路径。
import { fileURLToPath } from "node:url";
import test from "node:test";

// new URL("./sync-versions.js", import.meta.url) 解析到同目录脚本；转成本地路径后供 spawnSync 使用。
const syncVersionsScript = fileURLToPath(new URL("./sync-versions.js", import.meta.url));

// 在 root/relativeDirectory 下建目录并写 package.json；制表符缩进模拟 npm 默认格式。
// 例：writeManifest(root, "packages/ai", {name:"@earendil-works/pi-ai", version:"2.0.0"})。
async function writeManifest(root, relativeDirectory, manifest) {
	// recursive 让多级 packages/xxx 目录一次创建；已存在不报错。
	const directory = join(root, relativeDirectory);
	await mkdir(directory, { recursive: true });
	// JSON.stringify 的第三个参数 "\t" 生成制表符缩进；末尾补换行。
	await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

// 读取并解析临时工作区的 package.json；测试断言前需要运行时 JSON 解析。
async function readManifest(root, relativeDirectory) {
	return JSON.parse(await readFile(join(root, relativeDirectory, "package.json"), "utf8"));
}

// 用当前 Node 运行 sync-versions.js，参数是临时 packages 根目录；cwd 设为临时根，
// 使脚本内部的相对路径（如果有）落在夹具中。返回 spawnSync 结果，含 status/stdout/stderr。
function runSyncVersions(root) {
	return spawnSync(process.execPath, [syncVersionsScript, join(root, "packages")], {
		cwd: root,
		encoding: "utf8",
	});
}

// #10865: caret ranges allowed older agents to install incompatible newer workspace dependencies.
// 验证三个依赖区都被固定到工作区精确版本；npm: 别名与 install-lock 生成清单保持原样；
// 第二次运行幂等；可发布包版本不一致时以 1 退出。
// 例：coding-agent 的 dependencies/devDependencies/optionalDependencies 中 pi-ai 都变成 "2.0.0"。
test("pins published and private dependencies without touching registry aliases, generated manifests, or published lockstep", async () => {
	// 每个测试独立临时目录，避免并发/残留污染；finally 中删除。
	const root = await mkdtemp(join(tmpdir(), "pi-sync-versions-"));
	try {
		// 被依赖的 ai 包，版本 2.0.0，是同步的目标值。
		await writeManifest(root, "packages/ai", {
			name: "@earendil-works/pi-ai",
			version: "2.0.0",
		});
		// coding-agent 在三个依赖区故意写不同的旧范围，验证都会被改成同一个精确版本。
		await writeManifest(root, "packages/coding-agent", {
			name: "@earendil-works/pi-coding-agent",
			version: "2.0.0",
			dependencies: {
				"@earendil-works/pi-ai": "^2.0.0",
			},
			devDependencies: {
				"@earendil-works/pi-ai": "~1.0.0",
			},
			optionalDependencies: {
				"@earendil-works/pi-ai": "1.0.0",
			},
		});
		// 私有包不参与“公开包版本一致”检查，但仍会被同步内部依赖。
		// 别名依赖 `npm:@earendil-works/pi-ai@1.0.0` 的键是别名，不是工作区包名，因此必须保持不变。
		await writeManifest(root, "packages/evals", {
			name: "@earendil-works/pi-evals",
			version: "9.9.9",
			private: true,
			dependencies: {
				"@earendil-works/pi-coding-agent": "^1.0.0",
				"@mariozechner/pi-ai": "npm:@earendil-works/pi-ai@1.0.0",
			},
		});
		// install-lock 是生成目录，脚本按后缀跳过，不重写它的依赖范围。
		await writeManifest(root, "packages/coding-agent/install-lock", {
			name: "generated-install-lock",
			version: "0.0.0",
			private: true,
			dependencies: {
				"@earendil-works/pi-coding-agent": "^1.0.0",
			},
		});

		const result = runSyncVersions(root);
		// 第三个参数是失败诊断；脚本应成功并打印同步日志。
		assert.equal(result.status, 0, result.stderr);

		// 三个依赖区逐一断言为精确版本 "2.0.0"，证明范围与波浪号都被替换。
		const agentManifest = await readManifest(root, "packages/coding-agent");
		for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
			assert.equal(agentManifest[section]["@earendil-works/pi-ai"], "2.0.0");
		}
		const evalsManifest = await readManifest(root, "packages/evals");
		// 私有包依赖 coding-agent 也被同步。
		assert.equal(evalsManifest.dependencies["@earendil-works/pi-coding-agent"], "2.0.0");
		// npm: 别名保持原字符串，不应被改成 2.0.0。
		assert.equal(evalsManifest.dependencies["@mariozechner/pi-ai"], "npm:@earendil-works/pi-ai@1.0.0");
		// 生成清单完全没变。
		const generatedManifest = await readManifest(root, "packages/coding-agent/install-lock");
		assert.equal(generatedManifest.dependencies["@earendil-works/pi-coding-agent"], "^1.0.0");

		// 第二次运行应幂等：没有依赖需要改，stdout 出现固定提示。
		const alreadySynced = runSyncVersions(root);
		assert.equal(alreadySynced.status, 0, alreadySynced.stderr);
		assert.match(alreadySynced.stdout, /All inter-package dependencies are already in sync/);

		// 把 ai 改成 3.0.0，使公开包版本不再一致；脚本应在写文件前以 1 退出。
		await writeManifest(root, "packages/ai", {
			name: "@earendil-works/pi-ai",
			version: "3.0.0",
		});
		const lockstepFailure = runSyncVersions(root);
		assert.equal(lockstepFailure.status, 1, lockstepFailure.stderr);
	} finally {
		// force 忽略不存在，recursive 删除整棵临时树。
		await rm(root, { recursive: true, force: true });
	}
});

// 验证 pi-ai 的 src/utils/version.ts 常量与 package.json 版本同步；文件内容用正则匹配末尾换行。
test("writes the pi-ai version constant", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-sync-versions-"));
	try {
		// 只有一个公开包，版本一致检查自然通过。
		await writeManifest(root, "packages/ai", {
			name: "@earendil-works/pi-ai",
			version: "2.0.0",
		});
		// 预置旧的版本常量 1.0.0，路径必须与 scripts/sync-versions.js 中的计算一致。
		const versionPath = join(root, "packages/ai/src/utils/version.ts");
		await mkdir(join(root, "packages/ai/src/utils"), { recursive: true });
		await writeFile(versionPath, 'export const PI_AI_VERSION = "1.0.0";\n');

		const result = runSyncVersions(root);
		assert.equal(result.status, 0, result.stderr);
		// 正则中的 \. 转义点号，$ 锚定文件末尾换行，确保生成内容格式完整。
		assert.match(await readFile(versionPath, "utf8"), /export const PI_AI_VERSION = "2\.0\.0";\n$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
