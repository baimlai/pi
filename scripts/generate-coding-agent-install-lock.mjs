#!/usr/bin/env node
// 文件导读
// 所属：仓库根 scripts/ 的 coding-agent 安装锁生成器，npm run install-lock:coding-agent 的实现，
//   npm run check:install-lock:coding-agent（即 npm run check）用 --check 只校验不写。
// 职责：从仓库根 package-lock.json 出发，为 coding-agent 的安装器/更新器生成一份“生产依赖闭包”锁文件：
//   内部工作区包（@earendil-works/pi-* 与 chord）按工作区版本改写为 registry tarball，外部包保留 resolved/integrity，
//   过滤 dev/extraneous/link 条目，并校验安装脚本白名单与依赖可解析性。
// 上游：仓库根 package-lock.json（lockfileVersion 3）、packages/coding-agent/package.json 及各工作区 package.json。
// 下游：写 packages/coding-agent/install-lock/package.json 与 package-lock.json；更新器据此安装固定版本依赖。
// 输入：命令行仅接受 --check；无参数即生成并覆盖输出文件。
// 输出：生成模式打印写入的包数量；--check 模式打印是否最新。失败时 stderr 打印原因。
// 退出码：0 成功/已最新；1 未知参数、根锁版本不符、依赖无法解析、校验失败或 --check 发现文件缺失/过期。
// 副作用：生成模式创建 install-lock 目录并写两个文件；--check 只读并比较内容。不联网、不执行 npm。
// 幂等性：相同输入产生完全相同的排序输出；重复运行无额外变化。
// 示例：
//   npm run install-lock:coding-agent          # 重新生成
//   npm run check:install-lock:coding-agent    # CI/本地校验
// 建议阅读顺序：常量与白名单 → 读 JSON/排序/复制辅助 → 依赖解析（resolveExternalDependency）→
//   BFS 生成（generateInstallLock）→ 校验（validateGeneratedFiles）→ 顶层写入/--check。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 以脚本自身位置定位仓库根，保证从任意 cwd 调用都读写正确目录。
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages/coding-agent");
const outputDir = join(codingAgentDir, "install-lock");
const rootLockfilePath = join(repoRoot, "package-lock.json");
const outputPackageJsonPath = join(outputDir, "package.json");
const outputLockfilePath = join(outputDir, "package-lock.json");
// 内部包判定：pi-* 前缀，加上名字不带 pi- 前缀的 chord。
const internalPackagePrefix = "@earendil-works/pi-";
const internalPackageNames = new Set(["@earendil-works/chord"]);
const installPackageName = "@earendil-works/pi-coding-agent-install";
// 允许保留 hasInstallScript 的包；键为 name@version，值为人工审查理由。
// 新增条目必须经过审查：安装脚本会在用户机器上执行，锁文件生成不能静默放行。
const allowedInstallScriptPackages = new Map([
	["@google/genai@2.21.0", "preinstall is a no-op in the published package"],
	["protobufjs@7.6.6", "postinstall only warns about protobufjs version scheme mismatches"],
]);

// Set 去重；只接受 --check，其他参数打印后退出 1。
const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

for (const arg of args) {
	if (arg !== "--check") {
		console.error(`Unknown argument: ${arg}`);
		process.exit(1);
	}
}

// 同步读取并解析 JSON；文件缺失/格式错误会直接抛错，由顶层 catch 转成退出码 1。
function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

// 输入：lockfile 条目或 package.json。输出：合并后的依赖映射。
// optionalDependencies 放在后面覆盖同名 dependencies，与 npm 的“可选优先”语义一致。
function packageDependencies(entry) {
	return {
		...(entry.dependencies ?? {}),
		...(entry.optionalDependencies ?? {}),
	};
}

// 按 key 字典序重建对象，保证输出稳定（JSON.stringify 保留插入顺序）。
function sortedObject(object) {
	return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

// 输入：一条锁条目。输出：字段顺序固定、其余字段按字母序追加的新对象。
// 固定顺序让生成文件 diff 可读；未知字段仍保留，避免丢信息。
function sortedPackageEntry(entry) {
	const fieldOrder = [
		"name",
		"version",
		"resolved",
		"integrity",
		"license",
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
		"bin",
		"engines",
		"os",
		"cpu",
		"libc",
		"optional",
		"hasInstallScript",
		"deprecated",
		"funding",
	];
	const sorted = {};

	for (const field of fieldOrder) {
		if (entry[field] !== undefined) {
			sorted[field] = entry[field];
		}
	}
	for (const [field, value] of Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) {
		if (sorted[field] === undefined) {
			sorted[field] = value;
		}
	}
	return sorted;
}

// 复制外部包条目并去掉开发/链接元数据：安装器只需要生产依赖。
function copyLockEntry(entry) {
	const copied = { ...entry };
	delete copied.dev;
	delete copied.devOptional;
	delete copied.extraneous;
	delete copied.link;
	return sortedPackageEntry(copied);
}

// 输入：工作区 package.json 与 {includeName}。输出：只含发布相关字段的锁条目。
// 内部包以 registry tarball 形式出现在安装锁里，因此不写 name（锁路径已含包名）。
function copyPackageJsonEntry(packageJson, options) {
	const entry = options.includeName
		? { name: packageJson.name, version: packageJson.version }
		: { version: packageJson.version };

	for (const field of [
		"license",
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
		"bin",
		"engines",
		"os",
		"cpu",
		"libc",
	]) {
		if (packageJson[field] !== undefined) {
			entry[field] = packageJson[field];
		}
	}

	return sortedPackageEntry(entry);
}

// 输入：node_modules/... 或 packages/... 锁路径。输出：包名；根条目（""）或非 node_modules 路径返回 undefined。
// 用 lastIndexOf 处理嵌套 node_modules；scoped 包取 @scope/name 两段。
function packageNameFromLockPath(lockPath) {
	const marker = "node_modules/";
	const index = lockPath.lastIndexOf(marker);
	if (index === -1) {
		return undefined;
	}

	const parts = lockPath.slice(index + marker.length).split("/");
	if (parts[0]?.startsWith("@")) {
		return `${parts[0]}/${parts[1]}`;
	}
	return parts[0];
}

// 输入：包名与版本。输出：npm registry 的标准 tarball URL。
// scoped 包的 tarball 文件名不含 scope，例如 @scope/pkg → pkg-1.0.0.tgz。
function registryTarballUrl(packageName, version) {
	const tarballName = packageName.startsWith("@") ? packageName.split("/")[1] : packageName;
	return `https://registry.npmjs.org/${packageName}/-/${tarballName}-${version}.tgz`;
}

// 判断依赖 spec 是否为精确版本（可带 prerelease/build 后缀）；^、~、* 等范围不参与版本一致性校验。
function isExactVersionSpec(spec) {
	return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(spec);
}

// 输入：根锁的 packages 映射。输出：Map<包名, {lockPath, packageJson}>，仅限内部工作区包。
// packages/ 下的条目是工作区；带 /node_modules/ 的嵌套路径与缺少 name/version 的条目不在此列。
function getInternalWorkspaces(lockPackages) {
	const workspaces = new Map();

	for (const [lockPath, entry] of Object.entries(lockPackages)) {
		if (!lockPath.startsWith("packages/") || lockPath.includes("/node_modules/") || !entry.name || !entry.version) {
			continue;
		}
		if (!entry.name.startsWith(internalPackagePrefix) && !internalPackageNames.has(entry.name)) {
			continue;
		}

		workspaces.set(entry.name, {
			lockPath,
			// 同时读取工作区真实清单，因为锁条目可能不含 bin/engines 等发布字段。
			packageJson: readJson(join(repoRoot, lockPath, "package.json")),
		});
	}

	return workspaces;
}

// 输入：锁 packages、依赖名、依赖方所在锁路径。输出：依赖在锁中的路径。
// 解析规则模拟 Node：从依赖方目录逐级向上找 <dir>/node_modules/<name>，最后再尝试根路径。
function resolveExternalDependency(lockPackages, packageName, fromLockPath) {
	const candidateDirs = [];
	let current = fromLockPath;

	while (current) {
		candidateDirs.push(current);
		const parent = posix.dirname(current);
		// "." 或不再变化表示已到根；循环结束条件防止无限循环。
		if (parent === "." || parent === current) {
			break;
		}
		current = parent;
	}
	// 根目录也作为一个候选目录（拼出 node_modules/<name>）。
	candidateDirs.push("");

	const tried = new Set();
	for (const directory of candidateDirs) {
		const candidate = directory ? `${directory}/node_modules/${packageName}` : `node_modules/${packageName}`;
		// 同一候选可能因路径规范化重复出现，用 Set 去重。
		if (tried.has(candidate)) {
			continue;
		}
		tried.add(candidate);

		const entry = lockPackages[candidate];
		// link 条目指向工作区，不复制进安装锁。
		if (entry && !entry.link) {
			return candidate;
		}
	}

	// 回退：npm 可能把依赖提升到任意层级；若全仓库只有一个匹配路径，可以唯一确定。
	const suffix = `node_modules/${packageName}`;
	const matches = Object.entries(lockPackages)
		.filter(([lockPath, entry]) => !entry.link && (lockPath === suffix || lockPath.endsWith(`/${suffix}`)))
		.map(([lockPath]) => lockPath);

	if (matches.length === 1) {
		return matches[0];
	}

	// 0 个或多个匹配都是歧义/缺失：报错并附上候选，避免生成错误的锁文件。
	throw new Error(
		`Cannot resolve ${packageName} from ${fromLockPath || "root"}. ` +
			(matches.length > 1 ? `Matches: ${matches.join(", ")}` : "No matching lockfile entry found."),
	);
}


// 输入：安装锁 packages、已添加路径、BFS 队列、包名、工作区信息。输出：无。
// 把内部工作区写成 node_modules/<name> 条目，resolved 指向 registry（发布后可用），并把其依赖入队。
function addInternalWorkspace(installLockPackages, addedPaths, queue, name, workspace) {
	const packageJson = workspace.packageJson;
	const outputPath = `node_modules/${name}`;
	// 内部包在安装锁中扁平放在根 node_modules；不写 name，锁路径本身已表达包名。
	const entry = copyPackageJsonEntry(packageJson, { includeName: false });
	entry.resolved = registryTarballUrl(name, packageJson.version);

	installLockPackages[outputPath] = sortedPackageEntry(entry);
	addedPaths.add(outputPath);

	for (const dependencyName of Object.keys(packageDependencies(packageJson))) {
		// sourceBase/outputBase 用于把工作区内的嵌套 node_modules 路径映射到安装锁的扁平结构。
		queue.push({
			name: dependencyName,
			sourceFrom: workspace.lockPath,
			sourceBase: workspace.lockPath,
			outputBase: outputPath,
		});
	}
}

// 输入：根锁 packages、安装锁 packages、已添加路径、BFS 队列、待处理依赖项。输出：无。
// 从根锁复制外部条目；若依赖位于某个内部工作区的 node_modules 下，输出路径会重映射到该工作区的安装路径。
function addExternalPackage(lockPackages, installLockPackages, addedPaths, queue, item) {
	const sourceLockPath = resolveExternalDependency(lockPackages, item.name, item.sourceFrom);
	// sourceBase 存在且路径属于其下时，把前缀替换成 outputBase，保持嵌套关系；否则沿用原路径。
	const outputLockPath =
		item.sourceBase && sourceLockPath.startsWith(`${item.sourceBase}/`)
			? [item.outputBase, sourceLockPath.slice(item.sourceBase.length + 1)].filter(Boolean).join("/")
			: sourceLockPath;
	// 同一路径可能被多个依赖方引用；只添加一次，但依赖边已在各自条目中。
	if (addedPaths.has(outputLockPath)) {
		return;
	}

	const entry = lockPackages[sourceLockPath];
	installLockPackages[outputLockPath] = copyLockEntry(entry);
	addedPaths.add(outputLockPath);

	for (const dependencyName of Object.keys(packageDependencies(entry))) {
		// sourceFrom 跟着 sourceLockPath 走，保证从该包位置解析其依赖；base 继承当前映射。
		queue.push({
			name: dependencyName,
			sourceFrom: sourceLockPath,
			sourceBase: item.sourceBase,
			outputBase: item.outputBase,
		});
	}
}

// 输入：coding-agent 的 package.json。输出：安装器根 package.json 对象。
// 根依赖只指向 coding-agent 自身精确版本；overrides/engines 透传，保证安装解析一致。
function createInstallerPackageJson(codingAgentPackage) {
	const packageJson = {
		name: installPackageName,
		version: codingAgentPackage.version,
		private: true,
		description: "Lockfile root used by the Pi installer and updater.",
		dependencies: {
			[codingAgentPackage.name]: codingAgentPackage.version,
		},
	};
	if (codingAgentPackage.overrides) {
		packageJson.overrides = codingAgentPackage.overrides;
	}
	if (codingAgentPackage.engines) {
		packageJson.engines = codingAgentPackage.engines;
	}
	return packageJson;
}

// 锁文件根条目（packages[""]）：name/version/dependencies，可选 engines；字段顺序固定。
function createRootLockEntry(installerPackageJson) {
	const entry = {
		name: installerPackageJson.name,
		version: installerPackageJson.version,
		dependencies: installerPackageJson.dependencies,
	};
	if (installerPackageJson.engines) {
		entry.engines = installerPackageJson.engines;
	}
	return sortedPackageEntry(entry);
}

// 输入：安装器 package.json、生成的锁、实际用到的内部包名集合。输出：无；发现任一问题即汇总抛错。
// 校验目标：结构版本、根元数据一致、无 link/local/dev 条目、内部包版本一致、
//   安装脚本只出现在白名单（且白名单不能残留过期项）、内部依赖齐全、精确版本依赖解析一致。
function validateGeneratedFiles(installerPackageJson, installLock, internalNames) {
	const errors = [];
	const rootEntry = installLock.packages[""];
	const includedPackageNames = new Set();
	const seenAllowedInstallScriptPackages = new Set();

	if (installLock.lockfileVersion !== 3) {
		errors.push("package-lock.json must use lockfileVersion 3");
	}
	if (installLock.name !== installerPackageJson.name) {
		errors.push(`lockfile name ${installLock.name} does not match package.json name ${installerPackageJson.name}`);
	}
	if (installLock.version !== installerPackageJson.version) {
		errors.push(
			`lockfile version ${installLock.version} does not match package.json version ${installerPackageJson.version}`,
		);
	}
	// 根依赖必须与根 package.json 完全一致（键值都一致，JSON 顺序也由同一构造函数保证）。
	if (JSON.stringify(rootEntry?.dependencies ?? {}) !== JSON.stringify(installerPackageJson.dependencies)) {
		errors.push("lockfile root dependencies do not match package.json dependencies");
	}

	for (const [lockPath, entry] of Object.entries(installLock.packages)) {
		const packageName = packageNameFromLockPath(lockPath);
		if (packageName) {
			includedPackageNames.add(packageName);
		}
		// 安装锁必须自包含：link 指向工作区，装到用户机器上会失效。
		if (entry.link) {
			errors.push(`${lockPath} is a link entry`);
		}
		// resolved 只能是 registry URL；file:/workspace:/绝对路径/相对路径都不可发布。
		if (typeof entry.resolved === "string" && /^(file:|link:|workspace:|\.\.?\/|\/)/.test(entry.resolved)) {
			errors.push(`${lockPath} has a local resolved value: ${entry.resolved}`);
		}
		// dev/devOptional/extraneous 说明把开发依赖带进了生产闭包。
		if (entry.dev || entry.devOptional || entry.extraneous) {
			errors.push(`${lockPath || "root"} contains dev/extraneous metadata`);
		}
		// 内部包必须与 coding-agent 同版本发布，否则安装器会混用版本。
		if (
			packageName !== undefined &&
			(packageName.startsWith(internalPackagePrefix) || internalPackageNames.has(packageName)) &&
			entry.version !== installerPackageJson.version
		) {
			errors.push(`${lockPath} internal package version ${entry.version} does not match ${installerPackageJson.version}`);
		}
		if (entry.hasInstallScript) {
			if (!packageName || !entry.version) {
				errors.push(`${lockPath || "root"} has install scripts but no package name/version`);
			} else {
				const packageId = `${packageName}@${entry.version}`;
				if (allowedInstallScriptPackages.has(packageId)) {
					// 记录实际出现，供下面的“白名单过期”反向检查。
					seenAllowedInstallScriptPackages.add(packageId);
				} else {
					errors.push(
						`${lockPath} has install scripts (${packageId}). Review it and add it to allowedInstallScriptPackages if intentional.`,
					);
				}
			}
		}
	}

	// 白名单条目不再出现时也要报错，防止依赖移除后留下无人审查的放行项。
	for (const packageId of allowedInstallScriptPackages.keys()) {
		if (!seenAllowedInstallScriptPackages.has(packageId)) {
			errors.push(`allowed install-script package ${packageId} is no longer present; remove it from the allowlist`);
		}
	}

	// BFS 过程中记录实际加入的内部包；缺一个说明依赖图不完整。
	for (const name of internalNames) {
		if (!includedPackageNames.has(name)) {
			errors.push(`internal dependency ${name} is missing`);
		}
	}

	// 逐个条目校验依赖可解析；精确版本 spec 还必须与解析到的条目版本一致。
	for (const [lockPath, entry] of Object.entries(installLock.packages)) {
		for (const [dependencyName, dependencySpec] of Object.entries(packageDependencies(entry))) {
			let dependencyLockPath;
			try {
				dependencyLockPath = resolveExternalDependency(installLock.packages, dependencyName, lockPath);
			} catch {
				errors.push(`${lockPath || "root"} dependency ${dependencyName} is missing`);
				continue;
			}

			const dependencyEntry = installLock.packages[dependencyLockPath];
			if (isExactVersionSpec(dependencySpec) && dependencyEntry.version !== dependencySpec) {
				errors.push(
					`${lockPath || "root"} dependency ${dependencyName}@${dependencySpec} resolves to ${dependencyEntry.version}`,
				);
			}
		}
	}

	if (errors.length > 0) {
		throw new Error(`Generated installer lock failed validation:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
	}
}

// 主生成流程：读根锁与 coding-agent 清单 → 建安装器根清单 → 以根依赖为种子 BFS →
//   内部包走 addInternalWorkspace，外部包走 addExternalPackage → 排序 → 校验 → 返回两个输出对象。
// 纯计算 + 读取本地文件；不写输出（由顶层决定写入或比较）。
function generateInstallLock() {
	const rootLock = readJson(rootLockfilePath);
	if (rootLock.lockfileVersion !== 3 || !rootLock.packages) {
		throw new Error("package-lock.json must be lockfileVersion 3 and contain a packages map");
	}

	const lockPackages = rootLock.packages;
	const codingAgentPackage = readJson(join(codingAgentDir, "package.json"));
	const installerPackageJson = createInstallerPackageJson(codingAgentPackage);
	const internalWorkspaces = getInternalWorkspaces(lockPackages);
	const installLockPackages = {
		"": createRootLockEntry(installerPackageJson),
	};
	// addedPaths 以锁路径为单位去重；根路径 "" 预先占位。
	const addedPaths = new Set([""]);
	const internalNames = new Set();
	// BFS 种子：安装器根清单的依赖（即 coding-agent）。
	const queue = Object.keys(packageDependencies(installerPackageJson)).map((name) => ({
		name,
		sourceFrom: "",
	}));

	while (queue.length > 0) {
		const item = queue.shift();
		if (!item) {
			break;
		}

		const workspace = internalWorkspaces.get(item.name);
		if (workspace) {
			const outputPath = `node_modules/${item.name}`;
			internalNames.add(item.name);
			// 内部包也可能被多个包依赖；outputPath 已存在时不再重复处理。
			if (!addedPaths.has(outputPath)) {
				addInternalWorkspace(installLockPackages, addedPaths, queue, item.name, workspace);
			}
			continue;
		}

		addExternalPackage(lockPackages, installLockPackages, addedPaths, queue, item);
	}

	const installLock = {
		name: installerPackageJson.name,
		version: installerPackageJson.version,
		lockfileVersion: 3,
		requires: true,
		// packages 键排序后输出，保证生成文件稳定。
		packages: sortedObject(installLockPackages),
	};

	validateGeneratedFiles(installerPackageJson, installLock, internalNames);
	return { installerPackageJson, installLock };
}

try {
	const { installerPackageJson, installLock } = generateInstallLock();
	// 与仓库现有格式一致：tab 缩进 + 末尾换行。
	const packageJsonContent = `${JSON.stringify(installerPackageJson, null, "\t")}\n`;
	const lockfileContent = `${JSON.stringify(installLock, null, "\t")}\n`;

	if (checkOnly) {
		// --check 不写文件；缺失或内容不同都视为失败，并提示生成命令。
		if (!existsSync(outputPackageJsonPath) || !existsSync(outputLockfilePath)) {
			console.error("packages/coding-agent/install-lock is missing generated files.");
			console.error("Run: npm run install-lock:coding-agent");
			process.exit(1);
		}
		const currentPackageJson = readFileSync(outputPackageJsonPath, "utf8");
		const currentLockfile = readFileSync(outputLockfilePath, "utf8");
		if (currentPackageJson !== packageJsonContent || currentLockfile !== lockfileContent) {
			console.error("packages/coding-agent/install-lock is out of date.");
			console.error("Run: npm run install-lock:coding-agent");
			process.exit(1);
		}
		console.log("packages/coding-agent/install-lock is up to date.");
	} else {
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(outputPackageJsonPath, packageJsonContent);
		writeFileSync(outputLockfilePath, lockfileContent);
		// 减去根条目；平台包指带 os/cpu/libc 约束的可选依赖。
		const packageCount = Object.keys(installLock.packages).length - 1;
		const platformPackageCount = Object.values(installLock.packages).filter((entry) => entry.os || entry.cpu || entry.libc)
			.length;
		console.log(
			`Wrote packages/coding-agent/install-lock/package.json and package-lock.json (${packageCount} packages, ${platformPackageCount} platform-specific).`,
		);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
