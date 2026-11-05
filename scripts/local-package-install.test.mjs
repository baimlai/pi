// 文件导读
// 所属：仓库根 scripts/ 的脚本测试，被测对象是 local-package-install.mjs。
// 作用：构造三个最小假包（shared/target/second），经 package-artifacts.mjs 打成真实 tarball，
// 再验证 npm/pnpm 两种消费者的接线、隔离安装和冒烟测试失败路径。
// 测试夹具与假实现：
//   writePackage() 写 package.json 与文件；
//   createArtifactSet() 在系统临时目录（目录名含空格）建仓库结构并调用 produceArtifactSet；
//   source: null 让制品集跳过 git 命令，测试不需要临时仓库有提交；
//   npm/pnpm 是真实子进程：npm 测试会执行真实安装，pnpm 测试调用仓库 devDependency 里的 pnpm CLI。
// 覆盖分组：
//   1. npm：多个直接依赖都从 file: 解析，lockfile 指向本地制品；篡改 lockfile URL 或删除导出文件会失败；
//   2. installConsumer：拒绝 yarn；单独安装一个包时依赖分区正确；缺 main/lockfile/packages 对象会失败；
//   3. pnpm：overrides 写入 workspace 且保留原注释；离线安装后导入成功，lockfile 无 http(s) URL。
// 运行命令：node --test scripts/local-package-install.test.mjs
// 前置条件：npm 在 PATH；pnpm 测试需要仓库已安装 devDependencies（node_modules/pnpm/bin/pnpm.mjs）。
// 测试会访问本地临时目录并可能使用 npm 缓存，不修改仓库文件。
// 阅读顺序：先看 writePackage/createArtifactSet，再按 test 名称读三个场景。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// yaml.parse 用于读取 pnpm-workspace.yaml 的普通值；这里不需要保留注释的 Document API。
import { parse } from "yaml";
import { installConsumer, smokeTestNpmConsumer, wireConsumer } from "./local-package-install.mjs";
import { produceArtifactSet } from "./package-artifacts.mjs";

// 在指定目录写 package.json（Tab 缩进）和任意文件；测试包都只有 dist 内容。
function writePackage(directory, manifest, files) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	for (const [path, contents] of Object.entries(files)) {
		// 文件路径可能带子目录，先递归创建父目录。
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), contents);
	}
}

// 建立临时仓库与三个同名假包，返回可直接用于安装的 artifactSet。
function createArtifactSet(t) {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-local-package-install-test-"));
	// t.after 在测试结束后清理整个临时根，包括 tarball 和安装目录。
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	// 故意带空格，覆盖路径处理的边界。
	const root = join(temporaryRoot, "fixture with spaces");
	const repoRoot = join(root, "repo");
	mkdirSync(repoRoot, { recursive: true });
	// 根 manifest 让 npm 识别工作区；private 使它自己不会被打包。
	writeFileSync(join(repoRoot, "package.json"), '{"name":"fixture","private":true}\n');
	// shared：被 target 依赖的传递包，有 main/types/exports。
	writePackage(
		join(repoRoot, "packages", "shared"),
		{
			name: "@pi-package-test/shared",
			version: "1.0.0",
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
			files: ["dist"],
		},
		{
			"dist/index.js": 'export const marker = "local artifact";\n',
			"dist/index.d.ts": 'export declare const marker: "local artifact";\n',
		},
	);
	// target：直接依赖 shared，另有 ./feature 子路径和 bin，用于覆盖多路径校验。
	writePackage(
		join(repoRoot, "packages", "target"),
		{
			name: "@pi-package-test/target",
			version: "1.0.0",
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			exports: {
				".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
				"./feature": { types: "./dist/feature.d.ts", import: "./dist/feature.js" },
			},
			bin: { target: "./dist/cli.js" },
			files: ["dist"],
			dependencies: { "@pi-package-test/shared": "1.0.0" },
		},
		{
			"dist/index.js": 'import { marker } from "@pi-package-test/shared";\nexport { marker };\n',
			"dist/index.d.ts": 'export { marker } from "@pi-package-test/shared";\n',
			"dist/feature.js": "export const feature = true;\n",
			"dist/feature.d.ts": "export declare const feature: true;\n",
			"dist/cli.js": "#!/usr/bin/env node\n",
		},
	);
	// second：没有 exports 的包，验证 main/types 回退路径。
	writePackage(
		join(repoRoot, "packages", "second"),
		{
			name: "@pi-package-test/second",
			version: "1.0.0",
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			files: ["dist"],
		},
		{
			"dist/index.js": "export const second = true;\n",
			"dist/index.d.ts": "export declare const second: true;\n",
		},
	);
	return {
		// build:false 直接打包；source:null 跳过 git；输出目录在临时根下。
		artifactSet: produceArtifactSet({ build: false, outDir: join(root, "artifacts"), repoRoot, source: null }),
		root,
	};
}

// npm 场景：多个直接包都改写为 file:，冒烟测试通过；篡改 lockfile 或删除文件能触发失败。
test("wires multiple direct packages without registry fallbacks", (t) => {
	const { artifactSet, root } = createArtifactSet(t);
	const consumerDirectory = join(root, "consumer");
	mkdirSync(consumerDirectory);
	// 已有 dependencies 指向 1.0.0，wireConsumer 应把它们原地替换成 file: specifier。
	writeFileSync(
		join(consumerDirectory, "package.json"),
		'{"private":true,"type":"module","dependencies":{"@pi-package-test/target":"1.0.0","@pi-package-test/second":"1.0.0"}}\n',
	);
	// npm 模式下还会写根 overrides，保证 shared 的传递依赖也走本地 tarball。
	wireConsumer({
		artifactSet,
		consumerDirectory,
		packageNames: ["@pi-package-test/target", "@pi-package-test/second"],
	});
	// 真实执行 npm install；--ignore-scripts 禁止生命周期脚本。
	execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumerDirectory, stdio: "pipe" });

	const manifest = JSON.parse(readFileSync(join(consumerDirectory, "package.json"), "utf8"));
	// 正则只确认开头是 file:，具体路径由后续 lockfile 检查保证。
	assert.match(manifest.dependencies["@pi-package-test/target"], /^file:/);
	assert.match(manifest.dependencies["@pi-package-test/second"], /^file:/);
	// 两个直接包都做完整冒烟：入口、exports、bin、lockfile、真实 import。
	smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/target" });
	smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/second" });

	// 负向测试一：把 lockfile 的 resolved 改成 registry URL，模拟 npm 回退。
	const lockPath = join(consumerDirectory, "package-lock.json");
	const lockContents = readFileSync(lockPath, "utf8");
	const lock = JSON.parse(lockContents);
	const targetLockEntry = Object.values(lock.packages).find((entry) => entry.resolved?.includes("pi-package-test-target"));
	assert.ok(targetLockEntry);
	targetLockEntry.resolved = "https://registry.npmjs.org/@pi-package-test/target/-/target-1.0.0.tgz";
	writeFileSync(lockPath, JSON.stringify(lock));
	assert.throws(
		() => smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/target" }),
		/did not resolve from a local artifact/,
	);
	// 恢复 lockfile，避免影响后续断言。
	writeFileSync(lockPath, lockContents);

	// 负向测试二：删除 exports 声明的 ./feature 文件，冒烟测试必须发现缺失。
	rmSync(join(consumerDirectory, "node_modules", "@pi-package-test", "target", "dist", "feature.js"));
	assert.throws(
		() => smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/target" }),
		/export \.\/feature does not exist/,
	);
});

// installConsumer 场景：拒绝不支持的管理器；单包安装的依赖分区正确；破坏清单/lockfile 会失败。
test("installs a package as the only direct dependency", (t) => {
	const { artifactSet, root } = createArtifactSet(t);
	// 先验证 yarn 在创建目录前就被拒绝（避免留下半成品目录）。
	const unsupportedDirectory = join(root, "unsupported-consumer");
	assert.throws(
		() => installConsumer({ artifactSet, directory: unsupportedDirectory, packageManager: "yarn", packageNames: ["@pi-package-test/target"] }),
		/Unsupported package manager: yarn/,
	);
	assert.equal(existsSync(unsupportedDirectory), false);
	// 正常路径：新建目录，写入最小清单并安装 target（其传递依赖 shared 由 overrides 固定）。
	const consumerDirectory = join(root, "isolated-consumer");
	installConsumer({ artifactSet, directory: consumerDirectory, packageNames: ["@pi-package-test/target"] });
	const manifest = JSON.parse(readFileSync(join(consumerDirectory, "package.json"), "utf8"));
	// 只有直接请求的包出现在 dependencies；overrides 里可以另有 shared。
	assert.deepEqual(Object.keys(manifest.dependencies), ["@pi-package-test/target"]);
	smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/target" });
	// 负向测试：删除已安装包的 main 字段，冒烟测试应要求字符串 main。
	const installedManifestPath = join(consumerDirectory, "node_modules", "@pi-package-test", "target", "package.json");
	const installedManifestContents = readFileSync(installedManifestPath, "utf8");
	const installedManifest = JSON.parse(installedManifestContents);
	delete installedManifest.main;
	writeFileSync(installedManifestPath, JSON.stringify(installedManifest));
	assert.throws(
		() => smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/target" }),
		/Public Pi package @pi-package-test\/target must declare a string main field/,
	);
	// 恢复清单，继续测试 lockfile 缺失。
	writeFileSync(installedManifestPath, installedManifestContents);
	const lockPath = join(consumerDirectory, "package-lock.json");
	const lockContents = readFileSync(lockPath, "utf8");
	rmSync(lockPath);
	assert.throws(
		() => smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/target" }),
		/npm consumer smoke test requires package-lock\.json/,
	);
	// 恢复后再删掉 packages 字段，模拟旧版或损坏的 lockfile。
	writeFileSync(lockPath, lockContents);
	const lock = JSON.parse(lockContents);
	delete lock.packages;
	writeFileSync(lockPath, JSON.stringify(lock));
	assert.throws(
		() => smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/target" }),
		/Invalid npm lockfile/,
	);
});

// pnpm 场景：override 写进 pnpm-workspace.yaml，离线安装后真实 import 成功。
test("wires and installs a pnpm consumer without registry fallbacks", (t) => {
	const { artifactSet, root } = createArtifactSet(t);
	const consumerDirectory = join(root, "pnpm-consumer");
	mkdirSync(consumerDirectory);
	writeFileSync(join(consumerDirectory, "package.json"), '{"private":true,"type":"module"}\n');
	// 预先放一个带注释的 workspace 文件，验证写入 override 时原注释仍保留。
	writeFileSync(join(consumerDirectory, "pnpm-workspace.yaml"), "# existing workspace comment\npackages: []\noverrides:\n  existing: 1.2.3\n");
	wireConsumer({
		artifactSet,
		consumerDirectory,
		packageManager: "pnpm",
		packageNames: ["@pi-package-test/target"],
	});

	const manifest = JSON.parse(readFileSync(join(consumerDirectory, "package.json"), "utf8"));
	// pnpm 不把 overrides 放 package.json，因此这里只有 dependencies。
	assert.deepEqual(Object.keys(manifest.dependencies), ["@pi-package-test/target"]);
	assert.equal(manifest.overrides, undefined);
	const workspaceContents = readFileSync(join(consumerDirectory, "pnpm-workspace.yaml"), "utf8");
	// 注释在最前面，parseDocument 序列化后仍应保留。
	assert.match(workspaceContents, /^# existing workspace comment/m);
	const workspace = parse(workspaceContents);
	// 原有 override 值被 YAML 解析为字符串 "1.2.3"。
	assert.equal(workspace.overrides.existing, "1.2.3");
	for (const artifact of artifactSet.packages) {
		// 每个 Pi 包的 override 都以对应 tarball 文件名结尾，指向本地 file: 制品。
		assert.ok(workspace.overrides[artifact.name].endsWith(basename(artifact.tarballPath)), `${artifact.name} override must reference its artifact`);
	}

	// 使用仓库安装的 pnpm CLI，而不是依赖全局 pnpm；--offline 保证不会访问 registry。
	const pnpmCli = fileURLToPath(new URL("../node_modules/pnpm/bin/pnpm.mjs", import.meta.url));
	execFileSync(process.execPath, [pnpmCli, "install", "--prod", "--ignore-scripts", "--offline"], {
		cwd: consumerDirectory,
		stdio: "pipe",
		timeout: 300_000,
	});
	// 用子进程执行 ESM import，确认安装后的包可以解析并导出 marker；--input-type=module 让 --eval 按 ESM 解析。
	const marker = execFileSync(process.execPath, ["--input-type=module", "--eval", 'import("@pi-package-test/target").then(({ marker }) => console.log(marker))'], {
		cwd: consumerDirectory,
		encoding: "utf8",
	});
	assert.equal(marker.trim(), "local artifact");
	// pnpm lockfile 不应出现 http(s) URL，否则说明有包走了 registry。
	const lockContents = readFileSync(join(consumerDirectory, "pnpm-lock.yaml"), "utf8");
	assert.doesNotMatch(lockContents, /https?:\/\//);
	for (const packageName of ["@pi-package-test/target", "@pi-package-test/shared"]) {
		// 直接包和传递包都必须引用本地 tarball 文件名。
		assert.ok(lockContents.includes(basename(artifactSet.getPackage(packageName).tarballPath)), `${packageName} lock entry must reference its artifact`);
	}
});
