#!/usr/bin/env node

// 文件导读：把当前工作区的公开 Pi 包打包并发布到 npm。
// 所属：仓库根 scripts/，通过根 package.json 的 `publish`（先跑 clean/build/check）或 CI
//   `.github/workflows/build-binaries.yml` 的 publish-npm 作业调用。
// 作用：要求所有公开包版本一致且已有 dist/ → 用 package-artifacts.mjs 生成 tarball → 查询 npm 上是否已存在同版本 →
//   对未发布的 tarball 执行 `npm publish <tarball> --access public --provenance --ignore-scripts`。
// 上游：`node scripts/publish.mjs [--dry-run]`；CI 在正式发布前先跑一次 --dry-run 验证 provenance。
// 下游：package-artifacts.mjs（打包与 manifest）、release-packages.mjs（公开包清单）、npm-command.mjs（跨平台 npm）。
// 高风险与失败状态：
//   - 不带 --dry-run 时这是真实发布：npm 版本一旦发布不可覆盖，会消耗版本号并进入公共 registry。
//   - 每个包发布前用 `npm view` 判断是否已存在；已存在则跳过，因此重跑是幂等的（不会重复发布）。
//   - --provenance 要求 CI 的 OIDC 环境；本地运行通常会失败，应使用 --dry-run 或本地产包流程。
//   - 全程 --ignore-scripts 禁止依赖生命周期脚本；缺失 dist/ 时在打包前直接报错。
//   - finally 会删除临时 artifact 目录（tarball 与 manifest），发布后不保留打包产物。
// 能力清单：
//   - isPublished(name, version)：查询 npm 是否已有该版本。
//   - 顶层流程：参数校验 → 工作区校验 → 生成 artifact set → 逐个发布/跳过 → 清理临时目录。
// 典型调用：
//   示例（不发布）`node scripts/publish.mjs --dry-run`；真实发布 `node scripts/publish.mjs`。
//   成功时逐包打印状态与 npm 输出，退出码 0；参数错误、版本不一致、缺 dist、npm 失败时抛错退出码 1。
// 阅读顺序：先看参数与版本/dist 校验，再看 isPublished 的 404 判定，最后看发布循环与 finally 清理。
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { produceArtifactSet } from "./package-artifacts.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";
import { execNpmSync } from "./npm-command.mjs";

// 是否演练模式：加上后仍会打包并逐包调用 npm publish，但 npm 参数里多 --dry-run，不真正上传。
const dryRun = process.argv.includes("--dry-run");
// 去掉已知开关后若还有参数，说明用法错误；在顶层抛错，Node 以非 0 退出。
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");
if (unknownArgs.length > 0) throw new Error("Usage: node scripts/publish.mjs [--dry-run]");

// 查询 name@version 是否已经发布：成功返回 true；registry 明确 404 返回 false；其他错误抛错。
// 副作用：启动 npm view 子进程并访问网络；不修改本地文件。
// 例：isPublished("@earendil-works/pi-ai","2.0.0") 在未发布时返回 false。
function isPublished(name, version) {
	try {
		// npm view 输出 JSON；stdio 保留 stdin 继承，stdout/stderr 捕获供错误判断。
		const output = execNpmSync(["view", `${name}@${version}`, "version", "--json"], {
			encoding: "utf8",
			stdio: ["inherit", "pipe", "pipe"],
		});
		// 有输出即认为已存在；空输出无法证明版本存在，按异常处理而不是误判为 false。
		if (!output.trim()) throw new Error(`npm returned no version for ${name}@${version}`);
		return true;
	} catch (error) {
		// 子进程错误对象在运行时可能带 stdout/stderr；先确认它是非 null 对象再读字段。
		// 这是 JS 运行时收窄，不是 TypeScript 类型保证，因为 catch 参数类型为 unknown。
		const output = error && typeof error === "object"
			? ["stdout", "stderr"].map((key) => key in error ? String(error[key] ?? "") : "").filter(Boolean).join("\n")
			: "";
		// npm 对不存在的包/版本返回 E404；只有这两种文本才表示“尚未发布”。
		if (output.includes("E404") || output.includes("404 Not Found")) return false;
		// 其他错误（网络、鉴权、registry 故障）不能当作未发布，否则可能误发布。
		throw new Error(`Failed to query ${name}@${version}${output ? `\n${output}` : ""}`, { cause: error });
	}
}

// 以调用者当前目录作为仓库根；npm script 与 CI 都从仓库根运行。
const repoRoot = process.cwd();
// 只发布非 private 的工作区包。
const packages = getPublicWorkspacePackages();
// 发布时 npm publish 的 cwd 需要该包目录；Map 提供按名查找。
const packageByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
// Set 去重版本值；仓库要求所有公开包 lockstep 同版本。
const versions = [...new Set(packages.map((pkg) => pkg.version))];
if (versions.length !== 1) throw new Error(`Publish packages are not lockstep versioned: ${versions.join(", ")}`);
// 发布前必须已有构建输出；这里只检查目录存在，不校验内容是否最新。
for (const pkg of packages) {
	if (!existsSync(join(pkg.directory, "dist"))) {
		throw new Error(`${pkg.directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

// 打印统一版本；dryRun 时追加标记，避免与真实发布日志混淆。
console.log(`Publishing pi packages at ${versions[0]}${dryRun ? " (dry run)" : ""}\n`);
// build:false 表示不再重新构建，直接复用已有 dist；返回 tarball 路径与临时 artifact 目录。
const artifactSet = produceArtifactSet({ build: false, repoRoot });
try {
	// 先用 npm view 查每个包的发布状态；map 回调是同步的，查询会逐个执行。
	// 展开 pkg 保留 name/version/tarballPath 等字段，再追加 published 布尔值。
	const packageStates = artifactSet.packages.map((pkg) => ({ ...pkg, published: isPublished(pkg.name, pkg.version) }));
	for (const pkg of packageStates) {
		console.log(`${pkg.name}@${pkg.version} ${pkg.published ? "is already published" : "is ready to publish"}: ${pkg.tarballPath}`);
	}
	console.log(dryRun ? "\nDry-running tarball publication with provenance.\n" : "\nAll packages packed; starting publication.\n");
	for (const pkg of packageStates) {
		if (pkg.published) {
			console.log(`Skipping ${pkg.name}@${pkg.version}: already published\n`);
			continue;
		}
		// 发布 tarball 而不是目录：确保上传的正是刚刚打包并计算 integrity 的内容。
		// --access public 让作用域包公开；--provenance 生成供应链证明；--ignore-scripts 不执行依赖脚本。
		const args = ["publish", pkg.tarballPath, "--access", "public", "--provenance", "--ignore-scripts"];
		// dry-run 仍走 npm 的发布校验与 provenance 生成，只差最后上传。
		if (dryRun) args.push("--dry-run");
		// cwd 设为包目录，使 npm 读取该包的 package.json；stdio inherit 把进度直接显示给用户。
		// 任一发布失败都会抛错，后续包不再发布，已发布的包不会回滚。
		execNpmSync(args, {
			cwd: packageByName.get(pkg.name).directory,
			stdio: "inherit",
		});
		console.log();
	}
} finally {
	// 即使某个包发布失败也删除临时目录；tarball 已上传到 npm，无需保留本地副本。
	rmSync(artifactSet.artifactDirectory, { force: true, recursive: true });
}
