#!/usr/bin/env node
// 检查可发布包是否使用同一版本，再同步工作区内部依赖的精确版本和 pi-ai 的版本常量。
// 输入：可选的 packages 根目录参数；输出：日志。执行会写 package.json 和版本文件，不能当只读查询命令运行。
// 流程：发现工作区 → 检查版本一致 → 更新内部依赖 → 写有变化的包 → 同步 version.ts。

/**
 * Validates lockstep versions for published packages, then synchronizes
 * exact internal dependency versions in all workspace packages, including private ones.
 */

// 同步文件 API 用于这个一次性维护脚本；写入动作集中在后面的显式更新阶段。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
// dirname 找父目录，join 按操作系统规则组合路径。
import { dirname, join } from "node:path";
// 复用工作区发现逻辑，避免手动硬编码每个包所在位置。
import { findPackageDirectories } from "./package-workspaces.mjs";

// install-lock 是独立生成的安装元数据，版本同步不直接重写它。
const GENERATED_PACKAGE_SUFFIXES = [join("coding-agent", "install-lock")];

// argv 前两项是 Node 和脚本路径；未给第三项时扫描 packages。
const packageRoot = process.argv[2] ?? "packages";
// 连续调用 filter/map，将目录列表转换为带解析结果及原路径的包记录。
const workspacePackages = findPackageDirectories(packageRoot)
	// 排除生成目录；some 表示后缀列表里有任意一项匹配就跳过。
	.filter((directory) => !GENERATED_PACKAGE_SUFFIXES.some((suffix) => directory.endsWith(suffix)))
	// 每个目录读取一次 package.json，保留 path 供真正有变更时写回。
	.map((directory) => {
		// 得到该工作区自己的 manifest 路径。
		const path = join(directory, "package.json");
		// JSON.parse 在运行时解析；此 JS 脚本按仓库自己维护的 manifest 结构使用结果。
		return { data: JSON.parse(readFileSync(path, "utf8")), path };
	});
// private=true 的包不参加“全部可发布包版本一致”检查，仍参加内部依赖同步。
const publishedPackages = workspacePackages.filter((pkg) => pkg.data.private !== true);
// Map 按包名查精确版本，例如工作区 pi-ai 的版本值，而不是模糊的 ^ 范围。
const versionMap = new Map(workspacePackages.map((pkg) => [pkg.data.name, pkg.data.version]));

// 先展示扫描结果，便于维护者确认脚本正在处理哪个版本批次。
console.log("Current versions:");
// 先浅复制数组再 sort，不改变 publishedPackages 的原顺序。
for (const pkg of [...publishedPackages].sort((a, b) => a.data.name.localeCompare(b.data.name))) {
	// 模板字符串将名字和版本插入日志，不直接改变文件。
	console.log(`  ${pkg.data.name}: ${pkg.data.version}`);
}

// Set 去重：多个不同版本值说明可发布包尚未按仓库的同步版本规则更新。
const versions = new Set(publishedPackages.map((pkg) => pkg.data.version));
// 不替维护者猜哪个版本正确，先中止，避免生成相互矛盾的内部依赖。
if (versions.size > 1) {
	// 错误日志走 stderr，退出码告诉调用脚本本轮同步失败。
	console.error("\nERROR: Not all non-private packages have the same version.");
	// 提供仓库已有的统一版本操作入口，而不是在这里自动 bump。
	console.error("Expected lockstep versioning. Run one of:");
	// patch 通常用于补丁版本更新。
	console.error("  npm run version:patch");
	// minor 通常用于次版本更新。
	console.error("  npm run version:minor");
	// major 通常用于主版本更新。
	console.error("  npm run version:major");
	// 非零退出，不继续执行下面写入逻辑。
	process.exit(1);
}

// 只有前面的检查通过，才进入依赖同步阶段。
console.log("\nAll non-private packages are at the same version (lockstep).");

// 计数的是被更新的依赖条目数量，不是包数量。
let totalUpdates = 0;
// Set 按包记录对象去重；同一包变了多项依赖也只写回一次。
const updatedPackages = new Set();
// 私有包也可能依赖其他工作区包，因此这里遍历全部工作区。
for (const pkg of workspacePackages) {
	// 三类依赖分别处理，避免只同步运行依赖而漏掉开发或可选依赖。
	for (const dependencyType of ["dependencies", "devDependencies", "optionalDependencies"]) {
		// 方括号按变量中的属性名取值，例如 pkg.data.devDependencies。
		const dependencies = pkg.data[dependencyType];
		// 没声明这一类依赖时直接进入下一类，不自动创建空对象。
		if (!dependencies) {
			// continue 作用于最近这一层依赖类型循环。
			continue;
		}

		// Object.entries 把字典变成 [依赖名, 当前版本表达式]；数组解构同时取两项。
		for (const [dependencyName, currentSpecifier] of Object.entries(dependencies)) {
			// Registry aliases such as `npm:@earendil-works/pi-ai@0.1.2` are never workspace-linked,
			// so lockstep bumping them would point at a version that is not published yet.
			// 只对名字确实对应本仓库工作区的依赖查新版本，普通外部依赖没有这个映射。
			const newSpecifier = versionMap.get(dependencyName);
			// 外部依赖或已是正确精确版本的条目不变，避免无意义写文件。
			if (!newSpecifier || currentSpecifier === newSpecifier) {
				// 进入同类中的下一个依赖条目。
				continue;
			}

			// 每条实际变化都先记录所属包。
			console.log(`\n${pkg.data.name}:`);
			// 运行依赖省略类别后缀，其他类别附上名字，方便检查日志。
			console.log(
				`  ${dependencyName}: ${currentSpecifier} → ${newSpecifier}${dependencyType === "dependencies" ? "" : ` (${dependencyType})`}`,
			);
			// 原地更新内存里的 manifest；此时还没有写到磁盘。
			dependencies[dependencyName] = newSpecifier;
			// 标记所属包需要写回，同一对象重复 add 不会出现多份。
			updatedPackages.add(pkg);
			// 记录本次变化的一项依赖。
			totalUpdates++;
		}
	}
}

// 只有确有变化的包才写回，其他 package.json 保持原样。
for (const pkg of updatedPackages) {
	// JSON.stringify 使用制表符缩进，再补文件末尾换行，符合仓库 manifest 格式。
	writeFileSync(pkg.path, `${JSON.stringify(pkg.data, null, "\t")}\n`);
}

// 分别报告无需更新和确实更新了多少条依赖。
if (totalUpdates === 0) {
	// 可以安全重复运行；版本已一致时不会为了同步而重写这些文件。
	console.log("\nAll inter-package dependencies are already in sync.");
} else {
	// 数量来自前面的条目级计数。
	console.log(`\nUpdated ${totalUpdates} dependency version(s).`);
}

// pi-ai reports its version in the User-Agent without reading package.json, which browsers cannot do.
// 找到 ai 工作区包；它的 version 是 User-Agent 中版本常量的来源。
const aiPackage = workspacePackages.find((pkg) => pkg.data.name === "@earendil-works/pi-ai");
// && 短路：找不到包时不继续拼路径，避免读取不存在对象的 path。
const aiVersionPath = aiPackage && join(dirname(aiPackage.path), "src", "utils", "version.ts");
// 只有源码版本入口实际存在时才同步它，避免在无关目录中创建新结构。
if (aiVersionPath && existsSync(aiVersionPath)) {
	// 这段模板是要生成的 TypeScript 正文，保持既有内容；JSON.stringify 为版本字符串加合法引号。
	const content = `// The @earendil-works/pi-ai package version. scripts/sync-versions.js keeps it in sync with package.json.\nexport const PI_AI_VERSION = ${JSON.stringify(aiPackage.data.version)};\n`;
	// 字节文字完全相同时不写文件，避免不必要的变更时间/差异。
	if (readFileSync(aiVersionPath, "utf8") !== content) {
		// 由生成入口写 version.ts，普通注释维护不应直接编辑那个产物。
		writeFileSync(aiVersionPath, content);
		// 明确输出同步到的版本及目标路径。
		console.log(`\nUpdated ${aiVersionPath} to ${aiPackage.data.version}.`);
	}
}
