// 文件导读
// 所属：仓库根 scripts/ 的脚本测试，被测对象是 package-artifacts.mjs。
// 作用：在临时 Git 仓库里创建两个假包，验证制品集的内容寻址、manifest 校验与输出目录防护。
// 测试夹具与假实现：
//   writePackage() 生成最小 package.json 和 dist 文件；
//   git init/config/add/commit 构造真实提交，使 source.commit/dirty 有确定值；
//   所有临时内容都在 mkdtempSync 得到的根目录下，t.after 负责删除。
// 覆盖行为：
//   1. 包名排序、tarball 名带 12 位哈希、integrity 为 sha512 前缀；
//   2. 干净仓库的 source.dirty 为 false，manifest 可被 readArtifactSet 重新读取；
//   3. 源文件变化后 tarball 哈希变化（内容寻址）；
//   4. 篡改 tarball 后读取失败（integrity mismatch）；
//   5. 拒绝把仓库内任意目录、仓库根、仓库祖先/文件系统根当输出目录。
// 运行命令：node --test scripts/package-artifacts.test.mjs
// 前置条件：需要 git 和 npm 在 PATH；不访问 registry（fixture 没有外部依赖）。
// 阅读顺序：先看 writePackage 与 fixture 的构建，再看每个断言对应的失败路径。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test from "node:test";
// produceArtifactSet 是真实实现；测试不 mock npm pack 或哈希。
import { produceArtifactSet, readArtifactSet } from "./package-artifacts.mjs";

// 在目录里写 package.json（Tab 缩进）以及若干文件；自动创建父目录。
function writePackage(directory, manifest, files) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	// 逐个写文件；contents 已是字符串，不做类型校验（测试夹具自己保证）。
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), contents);
	}
}

// #10633: Covers npm 12's package-keyed `npm pack --json` output only when npm 12 is on PATH.
test("produces a verified, content-addressed artifact set", (t) => {
	// 每个测试独立临时根，避免并行测试互相干扰。
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-package-artifacts-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	// 目录名故意含空格，验证路径参数不经过 shell 拆分。
	const repoRoot = join(temporaryRoot, "repo with spaces");
	mkdirSync(repoRoot);
	// 根 package.json 让 npm pack 能识别工作区；private 不参与打包。
	writeFileSync(join(repoRoot, "package.json"), '{"name":"fixture","private":true}\n');
	writePackage(
		join(repoRoot, "packages", "shared"),
		{ name: "@pi-package-test/shared", version: "1.0.0", files: ["dist"] },
		{ "dist/index.js": 'export const marker = "artifact";\n' },
	);
	writePackage(
		join(repoRoot, "packages", "target"),
		{ name: "@pi-package-test/target", version: "1.0.0", files: ["dist"] },
		{ "dist/index.js": 'export const target = true;\n' },
	);
	// 建真实 Git 仓库并提交，让 getGitSource 能读到 HEAD 和干净的 status。
	execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
	execFileSync("git", ["add", "."], { cwd: repoRoot });
	execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repoRoot });

	// build:false 跳过 npm clean/build，只运行 npm pack；输出目录位于 .artifacts 下，符合安全规则。
	const artifactSet = produceArtifactSet({ build: false, outDir: join(repoRoot, ".artifacts", "package set"), repoRoot });
	// getPublicWorkspacePackages 按目录排序，manifest 再按包名排序，因此 shared 在 target 前。
	assert.deepEqual(artifactSet.packages.map((pkg) => pkg.name), ["@pi-package-test/shared", "@pi-package-test/target"]);
	for (const pkg of artifactSet.packages) {
		// 文件名必须以 -12位十六进制.tgz 结尾，说明启用了内容寻址。
		assert.match(pkg.tarball, /-[0-9a-f]{12}\.tgz$/);
		// integrity 是 SRI 字符串，算法前缀为 sha512。
		assert.match(pkg.integrity, /^sha512-/);
	}
	// 刚提交完且没有新改动，dirty 应为 false。
	assert.equal(artifactSet.source.dirty, false);
	// 重新读取 manifest 走完整校验路径，包数仍为 2。
	assert.equal(readArtifactSet(artifactSet.manifestPath).packages.length, 2);

	// 修改源文件后重新打包：tarball 名里的哈希应变化，证明 revision 由内容决定。
	writeFileSync(join(repoRoot, "packages/shared/dist/index.js"), 'export const marker = "changed";\n');
	const changedArtifactSet = produceArtifactSet({ build: false, outDir: join(repoRoot, ".artifacts", "changed package set"), repoRoot });
	assert.notEqual(
		changedArtifactSet.getPackage("@pi-package-test/shared").tarball,
		artifactSet.getPackage("@pi-package-test/shared").tarball,
	);

	// 向 tarball 追加字节，模拟下载损坏或被篡改；读取时必须发现 hash 不匹配。
	appendFileSync(artifactSet.packages[0].tarballPath, "corrupt");
	assert.throws(() => readArtifactSet(artifactSet.manifestPath), /integrity mismatch/);
	// 仓库内的普通包目录不是 .artifacts 子目录，即使 force 也必须拒绝，避免删掉源码。
	const packageJsonPath = join(repoRoot, "packages", "shared", "package.json");
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: join(repoRoot, "packages", "shared"), repoRoot }),
		/Repository-local output directory must be inside.*\.artifacts/,
	);
	// 失败路径不能真的删除或改写包目录：package.json 仍在。
	assert.equal(existsSync(packageJsonPath), true);
	// 仓库根、仓库祖先（临时根）和文件系统根都被同一规则拒绝。
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: repoRoot, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: temporaryRoot, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: parse(repoRoot).root, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
});
