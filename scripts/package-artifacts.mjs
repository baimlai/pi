// 文件导读
// 所属：仓库根 scripts/，是发布/本地安装工具链的“制品集”核心库。
// 作用：按需构建整个仓库，然后把 packages/ 目录树下每个公开工作区包用 `npm pack --ignore-scripts` 打成 tarball，
// 计算内容哈希、写 manifest.json，并在读取时重新校验哈希与路径，供发布、本地安装、预览包等流程共用。
// 上游调用方：publish.mjs（正式发布）、local-release.mjs（本地发布演练）、pack-packages.mjs（手动打包）、
// check-package-install.mjs、preview 相关测试以及本组多个测试文件。
// 下游：release-packages.mjs 提供公开包清单、npm-command.mjs 执行 npm、node:crypto 做 sha512、
// node:fs/node:path 读写目录与文件、git 命令读取源提交。
// 能力清单：
//   produceArtifactSet({ repoRoot, outDir, build, offlineModelData, force, source })
//       - 准备输出目录、可选执行 clean/build、打包所有公开包、写 manifest，返回 readArtifactSet 结果。
//   readArtifactSet(manifestPath)
//       - 读取并校验 manifest，逐包核对 tarball 存在、位于制品目录内且 hash 匹配，返回带 getPackage 的对象。
// 关键副作用与风险：
//   - build=true 会运行 `npm run clean` 和 `npm run build`（或 build:offline），会删除各包 dist。
//   - 输出目录已存在时必须传 force，force 会递归删除该目录（prepareOutputDirectory 先校验位置）。
//   - 输出目录若在仓库内，只允许位于 <repo>/.artifacts 之下；仓库存根、祖先目录和文件系统根都被拒绝。
//   - npm pack 会完整读取包目录内容；不执行包的 lifecycle scripts。
// 退出码：本文件是库，不直接设置退出码；异常向上抛给 CLI 调用方。
// 示例（真实 API）：
//   const set = produceArtifactSet({ repoRoot: process.cwd(), outDir: ".artifacts/packages", build: false });
//   const pkg = set.getPackage("@earendil-works/pi-ai");
//   console.log(pkg.tarballPath, pkg.integrity);
// 阅读顺序：先看 produceArtifactSet/readArtifactSet 两个导出，再回到 isInsidePath、packPackages 等 helper。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
// 公开包清单来自 workspace 枚举；private 包不会被打包或发布。
import { getPublicWorkspacePackages } from "./release-packages.mjs";
// npm pack/install/run 在 Windows 的启动差异由这个 helper 统一处理。
import { execNpmSync } from "./npm-command.mjs";

// manifest 结构版本；读取旧/新结构时用它拒绝不兼容文件。
const manifestSchemaVersion = 1;

// 判断 child 是否等于 parent 或位于其内部；relative 后不以 .. 开头即视为内部。
function isInsidePath(child, parent) {
	// relative 返回 "" 表示同一路径；带 .. 或绝对路径表示在外部（Windows 跨盘符会返回绝对路径）。
	const relativePath = relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

// 读取当前 Git 提交与工作区是否脏；manifest 用它记录制品来源。
function getGitSource(repoRoot) {
	// rev-parse HEAD 在非 Git 目录或空仓库会抛错，错误交给调用方。
	const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
	// --porcelain 有任意输出就表示有未提交改动（包括未跟踪文件）。
	const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
	return { commit, dirty: status.length > 0 };
}

// 对每个公开包执行 npm pack，重命名成带内容哈希的文件并收集元数据。
function packPackages(packages, tarballDirectory) {
	// 递归创建 tarball 目录；已存在时保留里面旧的 tarball（produceArtifactSet 在 force 时已清空整个输出目录）。
	mkdirSync(tarballDirectory, { recursive: true });
	const packedPackages = [];
	// 串行打包，避免多个 npm 进程同时写 node_modules 或缓存。
	for (const pkg of packages) {
		// 读取包自己的清单，确认目录与 workspace 枚举出的名字一致，防止把错误目录打包。
		const packageJson = JSON.parse(readFileSync(join(pkg.directory, "package.json"), "utf8"));
		if (packageJson.name !== pkg.name) throw new Error(`Unexpected package name in ${pkg.directory}`);
		// --json 让 npm 把结果写到 stdout；--pack-destination 指定输出目录；--ignore-scripts 禁止包生命周期脚本。
		const output = execNpmSync(["pack", "--ignore-scripts", "--json", "--pack-destination", tarballDirectory], {
			cwd: pkg.directory,
			encoding: "utf8",
			// stdin 继承，stdout 捕获给 JSON.parse，stderr 直接显示给用户。
			stdio: ["inherit", "pipe", "inherit"],
		});
		// npm 10/11 返回数组，npm 12 返回以包名为键的对象；两种形态都兼容（参见 #10633）。
		const parsed = JSON.parse(output);
		const packed = Array.isArray(parsed) ? (parsed.length === 1 ? parsed[0] : undefined) : parsed?.[pkg.name];
		// 校验形状，避免 npm 输出格式变化时把 undefined 写进 manifest。
		if (packed?.name !== pkg.name || typeof packed.filename !== "string") {
			throw new Error(`npm pack returned an unexpected result for ${pkg.name}`);
		}

		// npm 生成的临时文件名；下一步要改成内容寻址名。
		const originalPath = join(tarballDirectory, packed.filename);
		const contents = readFileSync(originalPath);
		// sha512 覆盖完整 tarball 字节；digest 同时用于文件名短哈希和 manifest 的 SRI 完整性串。
		const digest = createHash("sha512").update(contents).digest();
		const hash = digest.toString("hex").slice(0, 12);
		// 在 .tgz 前插入 12 位哈希，例如 foo-1.0.0-abcdef123456.tgz。
		const tarballPath = originalPath.replace(/\.tgz$/, `-${hash}.tgz`);
		renameSync(originalPath, tarballPath);
		// 只打印统计信息，stdout 仍保持结构化输出之外的人类可读日志。
		console.log(
			`  ${pkg.name}@${pkg.version}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`,
		);
		packedPackages.push({
			name: pkg.name,
			version: pkg.version,
			tarballPath,
			// SRI 格式：算法-前缀 + base64；readArtifactSet 会用同样算法复核。
			integrity: `sha512-${digest.toString("base64")}`,
		});
	}
	return packedPackages;
}

// 校验并准备输出目录；返回最终使用的绝对路径。
function prepareOutputDirectory(outDir, options) {
	const repoRoot = resolve(options.repoRoot);
	// 未指定 outDir 时在系统临时目录建一个随机目录，调用方负责后续清理。
	if (!outDir) return mkdtempSync(join(tmpdir(), "pi-package-artifacts-"));
	const outputDirectory = resolve(outDir);
	// 拒绝文件系统根（dirname 等于自身）、仓库根和仓库祖先目录，避免 force 删除把源码删掉。
	if (dirname(outputDirectory) === outputDirectory || isInsidePath(repoRoot, outputDirectory)) {
		throw new Error(`Output directory must not be the repository, its ancestor, or a filesystem root: ${outputDirectory}`);
	}
	// 仓库内输出只允许落在 .artifacts 下，防止 --force 误删 packages/ 等目录。
	if (isInsidePath(outputDirectory, repoRoot) && !isInsidePath(outputDirectory, join(repoRoot, ".artifacts"))) {
		throw new Error(`Repository-local output directory must be inside ${join(repoRoot, ".artifacts")}: ${outputDirectory}`);
	}
	// 已存在的目录默认拒绝，要求显式 --force，降低误删风险。
	if (existsSync(outputDirectory)) {
		if (!options.force) throw new Error(`Output directory already exists. Use --force to replace it: ${outputDirectory}`);
		// force 是递归删除整个目录，不只是清空 tarball；前面的路径校验就是为此存在。
		rmSync(outputDirectory, { force: true, recursive: true });
	}
	mkdirSync(outputDirectory, { recursive: true });
	return outputDirectory;
}

/**
 * 构建可发布包集合：可选构建/清理、打包、写 manifest，并返回已校验的制品集。
 * 输入：repoRoot 仓库根；outDir 输出目录（省略则用临时目录）；build 是否运行构建；
 *       offlineModelData 选择 build:offline；force 是否允许替换已有目录；
 *       source 覆盖 Git 来源信息（测试传 null 表示不调用 git）。
 * 输出：readArtifactSet 的返回值，含 packages、source、manifestPath、artifactDirectory、getPackage。
 * 副作用：可能删除输出目录、运行 npm clean/build、写 tarball 与 manifest.json。
 * 错误：目录位置不合法、构建失败、npm pack 输出异常、包名不一致时抛出。
 * 例：produceArtifactSet({ repoRoot: "/repo", outDir: "/tmp/artifacts", build: false })。
 */
export function produceArtifactSet({ repoRoot, outDir, build = true, offlineModelData = false, force = false, source }) {
	const root = resolve(repoRoot);
	// 先准备目录：目录非法时不应先跑构建浪费时间，也不应在校验前执行删除。
	const artifactDirectory = prepareOutputDirectory(outDir, { force, repoRoot: root });
	if (build) {
		// clean 会删除各包 dist，确保打包的是本次构建结果而不是残留文件。
		execNpmSync(["run", "clean"], { cwd: root, stdio: "inherit" });
		// offline 变体复用已缓存的模型数据；两者由根 package.json 的脚本区分。
		execNpmSync(["run", offlineModelData ? "build:offline" : "build"], { cwd: root, stdio: "inherit" });
	}
	// source 为 undefined 时读取 Git；显式传 null/对象（测试）则跳过 git 命令。
	const artifactSource = source === undefined ? getGitSource(root) : source;
	// 只打包 packages/ 目录树下的非 private 包（不会扫描 apps/）；顺序由目录排序决定，后面 manifest 会再按包名排序。
	const packages = getPublicWorkspacePackages(join(root, "packages"));
	// tarball 放在输出目录的 tarballs/ 子目录。
	const packedPackages = packPackages(packages, join(artifactDirectory, "tarballs"));
	// manifest 的 tarball 字段使用相对制品目录的 POSIX 风格路径，便于整个目录搬移；
	// 包列表按 localeCompare 排序，保证输出稳定、便于 diff 和人工阅读。
	const manifest = {
		schemaVersion: manifestSchemaVersion,
		source: artifactSource,
		packages: packedPackages
			.map(({ name, version, tarballPath, integrity }) => ({
				name,
				version,
				tarball: relative(artifactDirectory, tarballPath).replaceAll("\\", "/"),
				integrity,
			}))
			.sort((left, right) => left.name.localeCompare(right.name)),
	};
	const manifestPath = join(artifactDirectory, "manifest.json");
	// 用 Tab 缩进并保留结尾换行，与仓库内其他 JSON 文件风格一致。
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	// 立即重新读取，让返回值经过与实际消费者相同的校验路径。
	return readArtifactSet(manifestPath);
}

/**
 * 读取并校验制品集 manifest，返回可供安装/发布使用的对象。
 * 输入：manifestPath，manifest.json 的路径（相对路径按当前工作目录解析）。
 * 输出：{ artifactDirectory, manifestPath, packages, source, getPackage(name) }。
 * 副作用：只读文件；会重新计算每个 tarball 的 sha512，不做写入。
 * 错误：schema 版本不支持、字段缺失/重复、tarball 越出制品目录、文件缺失、hash 不匹配时抛出。
 * 例：const set = readArtifactSet("/tmp/artifacts/manifest.json"); set.getPackage("pkg-name")。
 */
export function readArtifactSet(manifestPath) {
	const absoluteManifestPath = resolve(manifestPath);
	// 制品目录就是 manifest 所在目录；tarball 相对路径以它为基准。
	const artifactDirectory = dirname(absoluteManifestPath);
	const manifest = JSON.parse(readFileSync(absoluteManifestPath, "utf8"));
	// 只接受已知 schema 版本和数组形式的 packages；更复杂的迁移不在本函数处理。
	if (manifest.schemaVersion !== manifestSchemaVersion || !Array.isArray(manifest.packages)) {
		throw new Error(`Unsupported package artifact manifest: ${absoluteManifestPath}`);
	}
	const names = new Set();
	const packages = manifest.packages.map((pkg) => {
		// 运行时逐字段校验：manifest 来自磁盘，可能被手工修改或由旧版本生成。
		if (
			typeof pkg?.name !== "string" ||
			typeof pkg.version !== "string" ||
			typeof pkg.tarball !== "string" ||
			typeof pkg.integrity !== "string"
		) {
			throw new Error(`Invalid package entry in artifact manifest: ${absoluteManifestPath}`);
		}
		// 包名重复会让 getPackage 结果不确定，直接拒绝。
		if (names.has(pkg.name)) throw new Error(`Duplicate package in artifact manifest: ${pkg.name}`);
		names.add(pkg.name);
		const tarballPath = resolve(artifactDirectory, pkg.tarball);
		// 不允许通过 ../ 读到制品目录外的文件，并且文件必须真实存在。
		if (!isInsidePath(tarballPath, artifactDirectory) || !existsSync(tarballPath)) {
			throw new Error(`Missing package tarball for ${pkg.name}: ${tarballPath}`);
		}
		// 重新哈希与 manifest 记录的 SRI 比较；任何字节变化都会被发现。
		const integrity = `sha512-${createHash("sha512").update(readFileSync(tarballPath)).digest("base64")}`;
		if (integrity !== pkg.integrity) throw new Error(`Package tarball integrity mismatch for ${pkg.name}: ${tarballPath}`);
		return { ...pkg, tarballPath };
	});
	return {
		artifactDirectory,
		manifestPath: absoluteManifestPath,
		packages,
		source: manifest.source,
		// 按包名查制品；找不到时抛错，而不是返回 undefined 让调用方后续崩溃。
		getPackage(name) {
			const pkg = packages.find((candidate) => candidate.name === name);
			if (!pkg) throw new Error(`Package is not present in the artifact set: ${name}`);
			return pkg;
		},
	};
}
