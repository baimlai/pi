#!/usr/bin/env node

// 文件导读：Pi 的本地发布总控脚本，串起版本号、变更日志、构建、检查、测试、提交、打 tag 与推送。
// 所属：仓库根 scripts/；入口是 package.json 的 release:patch/minor/major，需在 main 分支的干净工作区运行。
// 作用（按执行顺序）：
//   1. 拒绝有未提交改动的仓库。
//   2. 确认所有公开工作区包已在 npm 注册；无条件 pin 最新模型目录并用它离线构建（失败则恢复旧 pin）。
//   3. 通过 npm run version:* 或显式版本号 bump，并重新生成 lockfile/安装依赖。
//   4. 把各 CHANGELOG 的 `## [Unreleased]` 改成 `## [version] - date`。
//   5. 重新生成模型数据、检查模型数据、生成 coding-agent install-lock。
//   6. 运行 npm run check、build:offline、测试（可用 PI_RELEASE_SKIP_TESTS=1 跳过）与打包消费检查。
//   7. 暂存所有变更，提交 `Release vX.Y.Z`，打 tag `vX.Y.Z`。
//   8. 给 CHANGELOG 加回 `## [Unreleased]` 并再提交一次。
//   9. push main 与 tag，触发 CI 发布 npm、GitHub Release 与 pi.dev 公告。
// 上游：`node scripts/release.mjs <major|minor|patch|x.y.z>`；参数缺失/非法时打印用法并以 1 退出。
// 下游：git、npm、./test.sh 子进程；update-model-catalog-pin.mjs 与 hydrate-model-catalog 的导入。
// 高风险与失败状态：
//   - 脚本会直接改写 package.json、lockfile、CHANGELOG、模型数据并创建提交与 tag，然后推送远端；没有 --dry-run。
//   - 工作区不干净、npm 包未注册、模型目录构建失败时，脚本在修改版本前退出。
//   - bump 之后任何步骤失败都会留下已修改的工作区（不回滚），需要人工检查/清理；已创建的提交/tag 也不会自动撤销。
//   - 推送后 CI 才真正发布 npm 与公告，脚本本身不上传包。
// 环境变量：PI_RELEASE_SKIP_TESTS=1 只跳过 ./test.sh；其他检查仍需通过。无其他必需变量。
// 能力清单：
//   - run：执行命令并打印；可 silent/ignoreError。
//   - assertPackagesAreRegisteredWithNpm：查询 npm 注册状态。
//   - pinAndBuildWithNewestModelCatalog：pin + hydrate + build:offline，失败恢复 pin。
//   - bumpOrSetVersion / removeStaleWorkspaceLockEntries：版本与锁文件处理。
//   - updateChangelogsForRelease / addUnreleasedSection：CHANGELOG 两阶段修改。
//   - stageChangedFiles：用 git ls-files 暂存全部变更。
// 典型调用：
//   示例 `node scripts/release.mjs patch` 或 `node scripts/release.mjs 0.85.0`；成功最后打印
//   `=== Prepared release vX.Y.Z; CI publication and pi.dev announcement start after the tag push ===`。
// 阅读顺序：先读顶部英文步骤，再看 run 与各 assert/失败退出，然后按“Main flow”顺序读到底。
/**
 * Release script for pi-mono
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Verify every public workspace package is registered on npm,
 *    pin the newest model catalog for Nix, and build with it
 * 3. Bump version via npm run version:xxx or set an explicit version
 * 4. Update CHANGELOG.md files: [Unreleased] -> [version] - date
 * 5. Regenerate release artifacts
 * 6. Run checks and tests
 * 7. Commit and tag the release
 * 8. Add new [Unreleased] section to changelogs
 * 9. Commit next-cycle changelog updates
 * 10. Push main and the tag to trigger CI publication and verified pi.dev announcement
 */

// execSync 执行需要 shell 的 npm script 命令；spawnSync 用于参数化、不需要 shell 的 npm 调用。
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";
import { hydrateModelCatalogBytes, updateModelCatalogPin } from "./update-model-catalog-pin.mjs";

// 第一个位置参数是 bump 类型或显式版本；其余参数被忽略（没有解析器）。
const RELEASE_TARGET = process.argv[2];
// 三个允许的 bump 关键字。
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
// 显式版本必须是稳定的 x.y.z；预发布版本不能走这条路。
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

// 参数校验失败直接以 1 退出，不进入任何写操作。
if (!RELEASE_TARGET || (!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET))) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z>");
	process.exit(1);
}

// 执行 shell 命令并打印 `$ cmd`；默认继承 stdio，silent 时捕获输出。
// 失败时：ignoreError=true 返回 null，否则打印错误并 process.exit(1)。
// 副作用：命令本身可能修改工作区/远端；本函数不重试。
// 例：run("git status --porcelain", { silent: true }) 返回输出字符串。
function run(cmd, options = {}) {
	// 先打印将要执行的命令，让发布日志可复现。
	console.log(`$ ${cmd}`);
	try {
		// encoding 让返回值是字符串；silent 时 pipe 捕获，否则 inherit 直接显示。
		// ...options 放在最后会覆盖前面的同名键，允许调用方微调 stdio/encoding。
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (!options.ignoreError) {
			// 不打印 e 的完整堆栈，只给命令摘要；调用方需要输出时用 silent 自己处理。
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

// 读取 packages/ai/package.json 的 version，作为所有公开包的当前版本。
// 只读；文件缺失或 JSON 非法会抛错。
function getVersion() {
	const pkg = JSON.parse(readFileSync("packages/ai/package.json", "utf-8"));
	return pkg.version;
}

// 确认每个公开工作区包都能在 npm 上解析到版本；未注册的包汇总后一次报错。
// 副作用：逐个执行 npm view；网络/鉴权错误与 404 区分处理。
// 必须在修改版本前调用，避免 bump 后才发现无法发布。
function assertPackagesAreRegisteredWithNpm() {
	// 只要名字，不需要目录或版本。
	const packageNames = getPublicWorkspacePackages().map((pkg) => pkg.name);
	// 收集 404 的包，循环结束后一次性报告；其他错误立即抛出。
	const unregisteredPackages = [];

	console.log("Checking npm package registration...");
	for (const packageName of packageNames) {
		// Windows 上 npm 是 npm.cmd；stdio 捕获输出，stdin 不需要。
		const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["view", packageName, "version", "--json"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});

		// 成功且有输出即认为已注册；空输出不能证明存在。
		if (result.status === 0 && result.stdout.trim()) {
			console.log(`  ${packageName}`);
			continue;
		}

		// result.error 可能为 undefined；可选链取 message，再过滤空值。
		const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
		// npm 对未注册包返回 E404；这是唯一归入“待注册”列表的情况。
		if (output.includes("E404") || output.includes("404 Not Found")) {
			unregisteredPackages.push(packageName);
			continue;
		}

		// 网络/鉴权等错误不能误判为未注册，直接失败。
		throw new Error(output ? `Failed to query npm registration for ${packageName}\n${output}` : `Failed to query npm registration for ${packageName}`);
	}

	// 任何未注册包都阻止发布；错误消息带缩进列表。
	if (unregisteredPackages.length > 0) {
		throw new Error(`The following public workspace packages are not registered on npm:\n${unregisteredPackages.map((packageName) => `  ${packageName}`).join("\n")}\nRegister them before running a release.`);
	}

	console.log("  All public workspace packages are registered on npm\n");
}

// 模型目录 pin 的相对路径；发布提交必须包含一个可离线构建的 pin。
const MODEL_CATALOG_PIN = "nix/model-catalog.json";

// Release tags are immutable, so the tagged Nix pin must already build the
// release. Pin the newest catalog unconditionally (`--if-stale` only avoids pin
// churn on main), then run the Nix build's steps: hydrate the checkout's model
// data from it and build offline. This catches e.g. source that references a
// model the catalog lacks. On failure, restore the committed pin so the
// worktree is clean for a rerun.
// 无条件 pin 最新目录，再按 Nix 构建的步骤 hydrate + build:offline；失败时把 pin 文件恢复成提交版本，
// 让重跑从干净状态开始（但已生成的模型数据需要 `npm run generate:models` 恢复）。
// 成功返回 undefined；失败会打印原因并 process.exit(1)。
async function pinAndBuildWithNewestModelCatalog() {
	const root = process.cwd();
	// 先备份已提交的 pin 原文；恢复时逐字节写回。
	const committedPin = readFileSync(MODEL_CATALOG_PIN, "utf8");
	// 失败提示里包含恢复后的补救步骤。
	const restored = `${MODEL_CATALOG_PIN} was restored. Run \`npm run generate:models\` to restore local model data, then rerun the release.`;
	let revision;
	let result;
	try {
		// 不传 ifStale：始终取最新目录，保证 tag 上的 pin 能构建发布。
		const pin = await updateModelCatalogPin(root);
		revision = pin.revision;
		console.log(`  Pinned model catalog ${revision}`);
		// 用刚下载的目录字节写 checkout 的模型数据（模拟 Nix 构建）。
		hydrateModelCatalogBytes(root, pin.bytes);
		console.log("$ npm run build:offline");
		const npm = process.platform === "win32" ? "npm.cmd" : "npm";
		// spawnSync 返回 {status, error, signal}；这里只关心完成状态。
		result = spawnSync(npm, ["run", "build:offline"], { stdio: "inherit" });
	} finally {
		// 未正常以 0 退出（包括抛错）时恢复 pin；result 可能是 undefined，用可选链。
		if (result?.status !== 0) writeFileSync(MODEL_CATALOG_PIN, committedPin);
	}
	// Only a build that ran and exited non-zero says anything about the catalog.
	// 进程未启动（error）或被信号终止（signal）不是目录问题，单独报错。
	if (result.error || result.signal) {
		const cause = result.error ? result.error.message : `it was stopped by ${result.signal}`;
		console.error(`Error: npm run build:offline did not complete: ${cause}.\n${restored}`);
		process.exit(1);
	}
	// 构建真正失败：报告“发布 tag 的 Nix 构建也会失败”，并区分目录过旧与本地环境问题。
	if (result.status !== 0) {
		console.error(
			`Error: the build with the newest published model catalog ${revision} failed; the Nix build of the release tag would fail too.\n` +
				"If the errors concern model IDs, types, or APIs, the catalog predates main: publish one from main (Publish Model Catalog workflow).\n" +
				"Otherwise fix the build (e.g. run `npm ci --ignore-scripts` if node_modules is out of date).\n" +
				restored,
		);
		process.exit(1);
	}
}

// 比较两个 x.y.z 版本的三段数字，返回负数/0/正数；缺失段按 0。
// 例：compareVersions("0.84.10","0.84.9") > 0。
function compareVersions(a, b) {
	// 点分字符串转数字数组；只比较前三段。
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

// 用单引号包裹 shell 参数，并把内部的 ' 转义为 '\''；用于把文件路径安全拼进命令字符串。
// 例：shellQuote("a b") → "'a b'"。
function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

// 删除 package-lock.json 中指向旧工作区版本、且不是 link 的嵌套 node_modules 条目。
// 背景：npm version 可能先生成旧版本的 workspace 依赖条目，sync-versions 之后它们已过期。
// 副作用：必要时重写 package-lock.json；只处理 packages/ 下非 link 条目。
function removeStaleWorkspaceLockEntries() {
	// 包名→当前版本；用于识别路径末尾的包名。
	const workspaceVersions = new Map(
		getPublicWorkspacePackages().map((pkg) => [pkg.name, pkg.version]),
	);
	const lockPath = "package-lock.json";
	// lockfile v3 的 packages 是 路径→条目 的对象；这里信任其结构。
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	let removed = 0;

	// 遍历 lockfile 中的每个包条目；path 是相对仓库根的安装路径。
	for (const [path, pkg] of Object.entries(lock.packages)) {
		// 只处理 packages/ 下的嵌套条目；link:true 是 workspace 链接，不是真实安装版本。
		if (!path.startsWith("packages/") || pkg.link === true) {
			continue;
		}
		for (const [name, version] of workspaceVersions) {
			// 路径以 /node_modules/<name> 结尾说明是某个包内嵌安装的工作区副本；
			// 版本与当前工作区不一致即为过期条目，删除后 break 避免重复计数。
			if (path.endsWith(`/node_modules/${name}`) && pkg.version !== version) {
				delete lock.packages[path];
				removed++;
				break;
			}
		}
	}

	// 只有确实删除条目才重写文件，保持制表符缩进与末尾换行。
	if (removed > 0) {
		writeFileSync(lockPath, `${JSON.stringify(lock, null, "\t")}\n`);
		console.log(`Removed ${removed} stale workspace package lock ${removed === 1 ? "entry" : "entries"}.`);
	}
}

// 暂存工作区所有已修改、未跟踪、已删除的文件（遵守 .gitignore）。
// 使用 git ls-files 而不是 `git add -A`，但仍会暂存整个仓库的变更；因此发布前必须确保工作区原本干净。
// 没有变更时直接返回；路径逐个用 shellQuote 包住再拼进命令。
function stageChangedFiles() {
	// -m 修改、-o 未跟踪、-d 删除；--exclude-standard 应用 gitignore。
	const output = run("git ls-files -m -o -d --exclude-standard", { silent: true });
	// split 后 trim/filter，再用 Set 去重，避免同一路径重复出现在命令行。
	const paths = [...new Set((output || "").split("\n").map((line) => line.trim()).filter(Boolean))];
	if (paths.length === 0) {
		return;
	}

	// `--` 明确分隔路径与选项，防止以 - 开头的文件名被当成参数；每个路径单独引用。
	run(`git add -- ${paths.map(shellQuote).join(" ")}`);
}

// 根据 target 是关键字还是显式版本，执行 bump 或设置版本；随后刷新 lockfile 并 npm ci。
// 返回 bump 后的版本号。失败通过 run/process.exit 终止。
// 例：bumpOrSetVersion("patch") 调用 npm run version:patch；显式 "0.85.0" 则检查大于当前版本。
function bumpOrSetVersion(target) {
	// 当前版本来自 ai 包；所有公开包 lockstep，因此可代表全部。
	const currentVersion = getVersion();

	if (BUMP_TYPES.has(target)) {
		// 关键字走仓库定义的 npm script，script 内部已包含 sync-versions 与 lockfile 刷新。
		console.log(`Bumping version (${target})...`);
		run(`npm run version:${target}`);
	} else {
		// 显式版本必须严格大于当前版本，防止误降级或原地重发。
		if (compareVersions(target, currentVersion) <= 0) {
			console.error(`Error: explicit version ${target} must be greater than current version ${currentVersion}.`);
			process.exit(1);
		}

		// --no-git-tag-version 让 npm 不自行提交/打 tag；--no-workspaces-update 避免 npm 处理工作区范围。
		// 随后 sync-versions 固定内部依赖，再只更新 lockfile（--package-lock-only，不安装）。
		console.log(`Setting explicit version (${target})...`);
		run(`npm version ${target} --workspaces --no-git-tag-version --no-workspaces-update && node scripts/sync-versions.js && npm install --package-lock-only --ignore-scripts`);
	}

	// npm version can temporarily install the previous workspace versions before
	// sync-versions updates inter-package ranges. Remove those stale lock entries,
	// refresh the lockfile, then hydrate from the final dependency graph.
	// 清理旧 workspace 锁条目 → 刷新 lockfile → 按最终依赖图重新安装 node_modules。
	removeStaleWorkspaceLockEntries();
	run("npm install --package-lock-only --ignore-scripts");
	run("npm ci --ignore-scripts");
	return getVersion();
}

// 枚举所有包含 CHANGELOG.md 的包目录；只读路径，不解析内容。
function getChangelogs() {
	// join 出候选路径，existsSync 过滤掉没有 changelog 的包。
	return findPackageDirectories()
		.map((directory) => join(directory, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

// 把所有 changelog 的 `## [Unreleased]` 标题替换为 `## [version] - YYYY-MM-DD`。
// 没有 Unreleased 段的文件跳过并打印；副作用：原地写文件。
// 例：version="0.85.0" 时标题变成 `## [0.85.0] - 2026-11-06`。
function updateChangelogsForRelease(version) {
	// toISOString() 是 UTC；split("T")[0] 取日期部分，不使用时区本地日期。
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		// 没有 Unreleased 标题说明该包不需要发布条目，跳过而不创建新段。
		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		// String.replace 只替换第一个匹配；每个 changelog 应只有一个 Unreleased。
		const updated = content.replace(
			"## [Unreleased]",
			`## [${version}] - ${date}`
		);
		writeFileSync(changelog, updated);
		console.log(`  Updated ${changelog}`);
	}
}

// 在所有 changelog 的 `# Changelog` 标题后插入新的 `## [Unreleased]` 空段，供下一周期使用。
// 副作用：原地写文件；如果文件头不匹配该模式则静默不插入（replace 无匹配不报错）。
function addUnreleasedSection() {
	const changelogs = getChangelogs();
	// 空段固定为标题加一个空行；后续维护者在其下追加条目。
	const unreleasedSection = "## [Unreleased]\n\n";

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		// Insert after "# Changelog\n\n"
		// 正则用 ^ 锚定文件开头（无 m 标志），只匹配标题恰好位于第一行的文件；
		// $1 保留原标题，替换字符串中的 ${unreleasedSection} 插在其后。
		const updated = content.replace(
			/^(# Changelog\n\n)/,
			`$1${unreleasedSection}`
		);
		// 无匹配时 updated === content，仍然写回同一内容并打印 Added；这是幂等但会误报的日志。
		writeFileSync(changelog, updated);
		console.log(`  Added [Unreleased] to ${changelog}`);
	}
}

// Main flow
// 从这里开始执行写操作；前面定义的都是函数与常量。
console.log("\n=== Release Script ===\n");

// 1. Check for uncommitted changes
// 干净的起点非常重要：后面的 stageChangedFiles 会把仓库内所有变更一起提交。
console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	// porcelain 输出直接展示给维护者；不做自动 stash/清理（会破坏其他并行会话）。
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// 2. Verify npm package registration before modifying the worktree.
// 先验证 npm 注册，再动版本文件；失败时工作区仍干净。
assertPackagesAreRegisteredWithNpm();

// Pin and verify the Nix model catalog before modifying versions, so the pin
// lands in the release commit and a failure leaves the worktree clean.
// 同样在 bump 前完成 pin 与离线构建验证；成功后 pin 变更会进入发布提交。
console.log("Pinning and building with the newest model catalog for Nix...");
await pinAndBuildWithNewestModelCatalog();
console.log();

// 3. Bump or set version
// 返回值是 bump 后的实际版本，后续提交/tag 都使用它。
const version = bumpOrSetVersion(RELEASE_TARGET);
console.log(`  New version: ${version}\n`);

// 4. Update changelogs
// 把 Unreleased 段定版；这一步在发布提交里。
console.log("Updating CHANGELOG.md files...");
updateChangelogsForRelease(version);
console.log();

// 5. Regenerate release artifacts
// 版本变化后重新生成模型数据与 install-lock，并用检查脚本确认生成物一致。
console.log("Regenerating release artifacts...");
run("npm run generate:models");
run("npm run check:model-data");
run("npm run install-lock:coding-agent");
console.log();

// 6. Run checks and tests
console.log("Running checks...");
run("npm run check");
console.log();

// 测试需要构建产物（dist/）；build:offline 使用本地已 pin 的模型数据，不联网。
console.log("Building packages for tests...");
run("npm run build:offline");
console.log();

// PI_RELEASE_SKIP_TESTS=1 skips the test suite, e.g. when it already passed in `npm run release:local`
// and an overloaded machine makes timing-sensitive tests fail. Checks and the install check still run.
// 只跳过 ./test.sh；check 与 package-install 检查仍执行，不能用于跳过其他失败步骤。
if (process.env.PI_RELEASE_SKIP_TESTS === "1") {
	console.log("Skipping tests (PI_RELEASE_SKIP_TESTS=1)\n");
} else {
	console.log("Running tests...");
	run("./test.sh");
	console.log();
}

// 用发布 tarball 模拟外部消费者安装，验证 exports/files 等打包配置。
console.log("Checking the packed coding-agent consumer install...");
run("npm run check:package-install");
console.log();

// 7. Commit and tag
// 第一条提交包含版本、lockfile、changelog 定版、模型数据；tag 指向该提交。
console.log("Committing and tagging...");
stageChangedFiles();
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);
console.log();

// 8. Add new [Unreleased] sections
// 定版之后再为下一周期插入空 Unreleased 段。
console.log("Adding [Unreleased] sections for next cycle...");
addUnreleasedSection();
console.log();

// 9. Commit
// 第二个提交只包含 changelog 的新空段，保持发布提交与下一周期准备分离。
console.log("Committing changelog updates...");
stageChangedFiles();
run(`git commit -m "Add [Unreleased] section for next cycle"`);
console.log();

// 10. Push
// 先推 main 再推 tag；tag push 触发 CI 的 npm 发布、GitHub Release 与 pi.dev 公告。
// 推送失败不会自动回滚本地提交/tag。
console.log("Pushing to remote...");
run("git push origin main");
run(`git push origin v${version}`);
console.log();

// 脚本到此结束；真正的制品发布发生在 CI，不在此进程内。
console.log(`=== Prepared release v${version}; CI publication and pi.dev announcement start after the tag push ===`);
