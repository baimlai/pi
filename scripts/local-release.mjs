#!/usr/bin/env node
// 文件导读
// 所属：仓库根 scripts/，是本地发布演练 CLI（npm run release:local 直接运行它）。
// 作用：模拟正式发布前的完整链路：生成模型、跑检查/测试、构建并打包所有公开包、编译当前平台的 Bun 二进制、
// 建隔离的 npm/bun 安装目录并做冒烟测试，最后打印可手动执行的命令。不发布到 npm、不写 Git。
// 能力：解析发布选项与 --help；生成模型并运行检查/测试；构建并打包公开包；编译 Bun 二进制；隔离安装并冒烟测试；
// 打印制品目录与后续手动命令。
// 上游：开发者命令行或根 package.json 的 "release:local"；CI 不使用本脚本。
// 下游：npm-command.mjs、package-artifacts.mjs、local-package-install.mjs、coding-agent-smoke.mjs、
// scripts/build-binaries.sh（bash + bun）、npm run generate:models、npm run check、./test.sh。
// 参数（node:util.parseArgs）：
//   --out <dir>          输出目录；默认在系统临时目录新建。
//   --force              先递归删除已存在的 --out 目录。
//   --skip-check         不运行 npm run check。
//   --skip-test          不运行 ./test.sh。
//   --skip-install       只生成制品集，不编译 Bun 二进制、不做隔离安装。
//   --skip-bun-install   跳过 Bun 安装（仍做 npm 隔离安装和 Bun 二进制）。
//   --help               打印用法并以 0 退出。
// 输出：stdout 打印制品目录、manifest、每个 tarball 路径，以及二进制/npm/bun 安装目录和运行提示。
// 副作用：运行构建与测试、写 --out、写系统临时目录、下载/安装依赖；不修改 Git、不发布。
// 幂等性：--out 已存在且未给 --force 时失败；其他步骤每次重新构建/安装，可重复运行但耗时。
// 退出码：正常 0；参数缺失、目录已存在、构建/测试/安装失败时抛异常，Node 以 1 退出。
// 示例（真实命令行）：
//   npm run release:local -- --out /tmp/pi-release --force
//   node scripts/local-release.mjs --skip-check --skip-test --skip-install
// 阅读顺序：先看顶部 usage 与 options 解析，再按 main 流程读 build/install 辅助函数。
import { execFileSync } from "node:child_process";

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { installConsumer, packageConsumerDirectoryName, smokeTestNpmConsumer } from "./local-package-install.mjs";
import { produceArtifactSet } from "./package-artifacts.mjs";
import { codingAgentName, smokeTestCodingAgent } from "./coding-agent-smoke.mjs";
import { execNpmSync } from "./npm-command.mjs";

// 打印帮助文本；只写 stdout，调用方随后 process.exit(0)。
function printUsage() {
	console.log(`Usage: node scripts/local-release.mjs [options]

Builds and packs the publishable packages, then installs the tarballs into
isolated directories outside the repository for local release testing.

Options:
  --out <dir>          Output directory. Defaults to a new directory under ${tmpdir()}
  --force              Remove --out first if it already exists
  --skip-check         Do not run npm run check before building
  --skip-test          Do not run ./test.sh after building
  --skip-install       Only create the artifact set; do not create isolated installs
  --skip-bun-install   Do not create the isolated Bun install
  --help               Show this help
`);
}

// 把 Node 的 platform/arch 映射到 build-binaries.sh 支持的平台名；其他组合直接报错。
function currentBinaryPlatform() {
	// win32 的 arm64 与 x64 使用不同二进制目标。
	if (process.platform === "win32") return process.arch === "arm64" ? "windows-arm64" : "windows-x64";
	if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	if (process.platform === "linux") return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
	throw new Error(`Unsupported binary platform: ${process.platform} ${process.arch}`);
}

// 调用 build-binaries.sh 生成当前平台二进制，并把二进制和归档复制到发布输出目录。
function buildBunBinaryRelease(targetDirectory, archiveDirectory) {
	const platform = currentBinaryPlatform();
	// 二进制中间产物放在输出目录的 binary-build/，便于失败后检查。
	const binaryBuildDirectory = join(archiveDirectory, "binary-build");
	// --skip-install/--skip-build 复用前面 npm 安装和构建的结果，避免重复耗时。
	execFileSync("bash", ["./scripts/build-binaries.sh",
		"--skip-install",
		"--skip-build",
		"--platform",
		platform,
		"--out",
		binaryBuildDirectory,
	], { stdio: "inherit" });
	// 先清掉旧目标再复制，避免残留旧文件混入本地发布目录。
	rmSync(targetDirectory, { force: true, recursive: true });
	cpSync(join(binaryBuildDirectory, platform), targetDirectory, { recursive: true });
	// Windows 使用 zip，其余平台 tar.gz；名字与正式发布归档一致。
	const archiveName = platform.startsWith("windows-") ? `pi-${platform}.zip` : `pi-${platform}.tar.gz`;
	cpSync(join(binaryBuildDirectory, archiveName), join(archiveDirectory, archiveName));
	return platform;
}

// 在安装目录根下创建 pi 命令入口，支持 Windows cmd/PowerShell 与 Unix 符号链接。
function createPiShim(installDirectory) {
	const binDirectory = join(installDirectory, "node_modules", ".bin");
	if (process.platform === "win32") {
		// npm 安装通常会生成 pi.cmd；存在时用 cmd 转发，另外生成 PowerShell 包装。
		if (existsSync(join(binDirectory, "pi.cmd"))) {
			writeFileSync(join(installDirectory, "pi.cmd"), '@ECHO off\r\n"%~dp0node_modules\\.bin\\pi.cmd" %*\r\n');
			writeFileSync(join(installDirectory, "pi.ps1"), '& "$PSScriptRoot/node_modules/.bin/pi.ps1" @args\n');
			return;
		}
		// bun 安装可能只有 pi.exe；同样在根目录放包装脚本。
		writeFileSync(join(installDirectory, "pi.cmd"), '@ECHO off\r\n"%~dp0node_modules\\.bin\\pi.exe" %*\r\n');
		writeFileSync(join(installDirectory, "pi.ps1"), '& "$PSScriptRoot/node_modules/.bin/pi.exe" @args\n');
		return;
	}
	// Unix 用相对符号链接，整个安装目录可以搬移。
	symlinkSync(join("node_modules", ".bin", "pi"), join(installDirectory, "pi"));
}

// 解析布尔/字符串选项；布尔项都有默认值，因此 values 里不会出现 undefined。
const { values } = parseArgs({
	options: {
		force: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
		out: { type: "string" },
		"skip-bun-install": { type: "boolean", default: false },
		"skip-check": { type: "boolean", default: false },
		"skip-install": { type: "boolean", default: false },
		"skip-test": { type: "boolean", default: false },
	},
});
if (values.help) {
	printUsage();
	process.exit(0);
}
// 把带连字符的 CLI 名称映射成内部 camelCase 字段，后续代码更好读。
const options = {
	force: values.force,
	outDir: values.out,
	skipBunInstall: values["skip-bun-install"],
	skipCheck: values["skip-check"],
	skipInstall: values["skip-install"],
	skipTest: values["skip-test"],
};
// 所有相对路径都与仓库根为基准；先确认当前目录确实是 pi monorepo，避免在错误目录执行破坏性构建。
const repoRoot = process.cwd();
const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
if (rootPackageJson.name !== "pi-monorepo") throw new Error("Run this script from the repository root");

// 模型目录/生成数据是构建输入，先刷新；即使 --skip-check 也仍生成，保证后续构建一致。
execNpmSync(["run", "generate:models"], { cwd: repoRoot, stdio: "inherit" });
// 默认跑全仓检查；--skip-check 只跳过检查，不跳过构建。
if (!options.skipCheck) execNpmSync(["run", "check"], { cwd: repoRoot, stdio: "inherit" });

// build:true 会先 clean 再 build；offlineModelData 使用刚生成/已缓存的数据；outDir 省略时用临时目录。
const artifactSet = produceArtifactSet({
	build: true,
	force: options.force,
	offlineModelData: true,
	outDir: options.outDir,
	repoRoot,
});
// 产物目录结构：bun/ 放二进制，node/ 放 npm 隔离安装，bun-install/ 放 Bun 隔离安装。
const outDir = artifactSet.artifactDirectory;
const binaryDirectory = join(outDir, "bun");
const nodeInstallDirectory = join(outDir, "node");
const bunInstallDirectory = join(outDir, "bun-install");

// 测试放在构建之后：构建已确认可编译，再跑 ./test.sh 验证行为；--skip-test 可跳过。
if (!options.skipTest) execFileSync("bash", ["./test.sh"], { cwd: repoRoot, stdio: "inherit" });

let binaryPlatform;
if (!options.skipInstall) {
	// 先编译当前平台二进制；--skip-install 时整段跳过，只留下 tarball。
	binaryPlatform = buildBunBinaryRelease(binaryDirectory, outDir);
	// 非 coding-agent 包的隔离安装放在仓库外的临时根，避免污染发布目录；finally 中清理。
	const validationRoot = mkdtempSync(join(tmpdir(), "pi-local-release-consumers-"));
	try {
		for (const pkg of artifactSet.packages) {
			// coding-agent 的安装目录要保留给用户使用；其他包只做一次性验证。
			const directory = pkg.name === codingAgentName
				? nodeInstallDirectory
				: join(validationRoot, "npm", packageConsumerDirectoryName(pkg.name));
			// 每个包单独建消费者，避免其他包恰好提供遗漏依赖而掩盖问题。
			installConsumer({ artifactSet, directory, packageNames: [pkg.name] });
			// smokeTestNpmConsumer 校验清单/入口/exports/bin/lockfile 并真实导入。
			smokeTestNpmConsumer({ artifactSet, directory, packageName: pkg.name });
			// coding-agent 额外检查 SDK 导出和 CLI 版本。
			if (pkg.name === codingAgentName) smokeTestCodingAgent(directory);
		}
		// 给 coding-agent 安装目录加根级 pi 入口，方便直接运行。
		createPiShim(nodeInstallDirectory);

		if (!options.skipBunInstall) {
			// Bun 安装只覆盖 coding-agent；--production + --ignore-scripts 由 installConsumer 处理。
			installConsumer({ artifactSet, directory: bunInstallDirectory, packageManager: "bun", packageNames: [codingAgentName] });
			smokeTestCodingAgent(bunInstallDirectory, "bun");
			createPiShim(bunInstallDirectory);
		}
	} finally {
		// 无论成功失败都删除临时验证目录；用户需要的 node/ 与 bun-install/ 不受影响。
		rmSync(validationRoot, { force: true, recursive: true });
	}
}

// 最后打印结果；所有路径都是绝对路径，可直接复制运行。
console.log(`\nLocal release artifacts created: ${outDir}`);
console.log(`Manifest: ${artifactSet.manifestPath}`);
console.log("\nTarballs:");
for (const pkg of artifactSet.packages) console.log(`  ${pkg.tarballPath}`);

if (!options.skipInstall) {
	console.log("\nLocal Bun binary release:");
	console.log(`  ${binaryDirectory}`);
	// binaryPlatform 在 !skipInstall 分支赋值，此处一定存在；Windows 用 zip，其余 tar.gz。
	console.log(`  ${join(outDir, `pi-${binaryPlatform}.${String(binaryPlatform).startsWith("windows-") ? "zip" : "tar.gz"}`)}`);
	console.log("\nRun the local Bun binary release from outside the repository:");
	console.log(`  ${join(binaryDirectory, String(binaryPlatform).startsWith("windows-") ? "pi.exe" : "pi")} --help`);

	console.log("\nIsolated npm install:");
	console.log(`  ${nodeInstallDirectory}`);
	console.log("\nRun the locally packed npm CLI from outside the repository:");
	console.log(`  ${join(nodeInstallDirectory, process.platform === "win32" ? "pi.cmd" : "pi")} --help`);

	if (!options.skipBunInstall) {
		console.log("\nIsolated Bun package install:");
		console.log(`  ${bunInstallDirectory}`);
		console.log("\nRun the locally packed Bun package CLI from outside the repository:");
		console.log(`  ${join(bunInstallDirectory, process.platform === "win32" ? "pi.cmd" : "pi")} --help`);
	}
}
