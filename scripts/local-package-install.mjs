// 文件导读
// 所属：仓库根 scripts/，是本地发布工具链的“消费者接线 + 隔离安装 + 冒烟测试”库。
// 作用：拿到 package-artifacts.mjs 产出的 tarball 集合后，改写一个外部项目的 package.json，
// 让目标包及其传递的 Pi 包都从本地 file: tarball 解析；然后在隔离目录里真实执行 npm/bun install，
// 最后检查安装后的清单、入口文件、exports、bin 和 npm lockfile 确实指向本地制品。
// 上游调用方：local-release.mjs、check-package-install.mjs、use-local-packages.mjs、coding-agent-smoke.test.mjs、
// local-package-install.test.mjs。它们负责准备 artifactSet 和目录，本文件负责接线与验证。
// 下游：npm-command.mjs（Windows 下调用 npm）、yaml（解析 pnpm-workspace.yaml）、node:fs/path/url/child_process。
// 能力清单：
//   wireConsumer({ artifactSet, consumerDirectory, packageNames, packageManager })
//       把直接依赖和已有 Pi 依赖改写成 file: specifier；npm 写 overrides，pnpm 写 pnpm-workspace.yaml overrides；
//       返回改写后的 JSON manifest（同时写回 package.json）。
//   installConsumer({ artifactSet, directory, packageNames, packageManager })
//       创建最小私有 package.json，调用 wireConsumer，再执行 npm/bun install --ignore-scripts。
//   smokeTestNpmConsumer({ directory, artifactSet, packageName })
//       校验已安装包的版本、main/types、字面量 exports、bin、lockfile 的 file: 解析，并运行一次 Node 导入。
//   packageConsumerDirectoryName(packageName)
//       把 @scope/name 变成适合目录名的 scope-name。
// 环境与网络：本文件不读自定义环境变量；npm/bun 必须在 PATH 上，安装可能访问 registry（fixture 无外部依赖时可离线）。
// 副作用：wireConsumer 写 package.json（pnpm 还写 pnpm-workspace.yaml）；installConsumer 写目录并安装依赖；
// smokeTestNpmConsumer 临时写 artifact-smoke.mjs 后在 finally 删除。
// 错误与退出码：全部通过抛异常报告；本文件是库，不设置 process.exitCode，由 CLI 调用方决定退出码。
// 示例（真实签名）：
//   installConsumer({ artifactSet, directory: "/tmp/consumer", packageNames: ["@earendil-works/pi-ai"] });
//   smokeTestNpmConsumer({ artifactSet, directory: "/tmp/consumer", packageName: "@earendil-works/pi-ai" });
// 阅读顺序：先看 wireConsumer/installConsumer 的写入流程，再看 smokeTestNpmConsumer 的逐项校验和辅助函数。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// pathToFileURL 把本地路径转成 file: URL，用于比较 npm lockfile 里的 resolved 字段。
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
// 用 YAML Document API 而不是 JSON 往返，才能保留 pnpm-workspace.yaml 里的注释和格式。
import { parseDocument } from "yaml";
import { execNpmSync } from "./npm-command.mjs";

// npm/pnpm 清单里可能声明依赖的三个字段；改写时要在它们之间移动同名包，避免重复声明。
const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"];

// 生成 file: 形式的版本说明符；从消费者目录指向 tarball 的绝对路径。
function createFileSpecifier(fromDirectory, path) {
	// 先求相对路径；若跨盘符（Windows）relative 会返回绝对路径，此时改用 file: URL。
	const relativePath = relative(fromDirectory, path);
	// 统一把反斜杠换成正斜杠，保证写进 package.json 的 specifier 跨平台可读。
	return isAbsolute(relativePath) ? pathToFileURL(path).href : `file:./${relativePath.replaceAll("\\", "/")}`;
}

// 探测 package.json 用的是 Tab 还是空格缩进；拿不到时退回 Tab。
function detectIndentation(contents) {
	// 匹配第一个以引号开头、带缩进的键；?. 可选链避免没有匹配时访问 undefined。
	return contents.match(/\n([\t ]+)"/)?.[1] ?? "\t";
}

// 计算已安装包在 node_modules 下的目录；scoped 包要拆成 @scope/name 两级。
function packageDirectory(directory, packageName) {
	return join(directory, "node_modules", ...packageName.split("/"));
}

// 从 exports 条件对象里选出 Node ESM 实际使用的目标文件。
// Generic consumers run Node ESM, so other export conditions are outside this smoke test's scope.
function runtimeTarget(value) {
	// 字符串就是最终路径，直接返回。
	if (typeof value === "string") return value;
	// 数组表示多个候选目标；按顺序找到第一个可用路径。
	if (Array.isArray(value)) {
		for (const candidate of value) {
			const target = runtimeTarget(candidate);
			if (target) return target;
		}
		return undefined;
	}
	// 非对象（null/undefined/数字）没有可解析的目标。
	if (!value || typeof value !== "object") return undefined;
	// 按 Node ESM 的条件优先级查找：import > node > default；其他条件（如 browser）不检查。
	for (const condition of ["import", "node", "default"]) {
		const target = runtimeTarget(value[condition]);
		if (target) return target;
	}
	return undefined;
}

// 从 exports 条件对象里取 types 字段；只接受顶层对象，不做递归。
function typesTarget(value) {
	// 数组或非对象没有 types 字段；字符串形式也不在此处理。
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	// 只有字符串类型声明路径才算有效。
	return typeof value.types === "string" ? value.types : undefined;
}

// 把 exports 字段规范化成 [子路径, 值] 列表；只覆盖字面量导出。
// Generic validation covers literal exports only; wildcard exports need package-specific test inputs.
function literalExports(manifest) {
	// 没有 exports 的包仍会通过 main/types 和根导入检查，这里返回空数组。
	// Packages without an exports map are still checked through main, types, and the root import.
	if (manifest.exports === undefined) return [];
	// 字符串或数组是根导出的简写，等价于 { ".": value }。
	if (typeof manifest.exports === "string" || Array.isArray(manifest.exports)) return [[".", manifest.exports]];
	const keys = Object.keys(manifest.exports);
	// 没有任何以 "." 开头的键时，exports 本身就是条件对象（不是子路径映射），整体当作根导出。
	if (!keys.some((key) => key.startsWith("."))) return [[".", manifest.exports]];
	// 过滤含 * 的通配符子路径：仅凭清单无法枚举实际文件，交给包自己的测试覆盖。
	return Object.entries(manifest.exports).filter(([subpath]) => !subpath.includes("*"));
}

// 校验 target 是包内相对路径且文件存在；用于 main/types/exports/bin。
function assertPackageFile(directory, target, description) {
	// 非字符串（例如条件对象）无法直接检查，直接报错。
	if (typeof target !== "string") throw new Error(`${description} must be a package path, found ${String(target)}`);
	const path = resolve(directory, target);
	const relativePath = relative(directory, path);
	// resolve 后若跑到包目录外（.. 或绝对路径），拒绝，避免清单指向 node_modules 其他位置。
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error(`${description} must stay inside the package, found ${target}`);
	}
	// 清单声明了文件但 tarball 里没有，说明打包漏文件。
	if (!existsSync(path)) throw new Error(`${description} does not exist: ${path}`);
}

// 从 lockfile 的 packages 键（如 node_modules/@scope/a/node_modules/b）取最深一层的包名。
function lockfilePackageName(path) {
	const marker = "node_modules/";
	// lastIndexOf 处理嵌套 node_modules：取最后一次出现才能得到实际安装的包。
	const index = path.lastIndexOf(marker);
	return index === -1 ? undefined : path.slice(index + marker.length);
}

// 校验消费者 lockfile：所有制品包都必须从各自的本地 tarball 解析，且直接包确实出现。
function verifyLocalResolutions(directory, artifactSet, directPackageName) {
	const lockPath = join(directory, "package-lock.json");
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	// npm lockfile v2/v3 的 packages 必须是对象；数组或缺失都视为旧/损坏格式。
	if (!lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
		throw new Error(`Invalid npm lockfile: packages object is missing from ${lockPath}`);
	}
	// 按包名索引制品，后面用 lockfile 路径里的包名查找。
	const artifacts = new Map(artifactSet.packages.map((pkg) => [pkg.name, pkg]));
	const resolvedNames = new Set();
	for (const [path, installed] of Object.entries(lock.packages)) {
		// 根条目 path 为空字符串，lockfilePackageName 返回 undefined，自然跳过。
		const name = lockfilePackageName(path);
		const artifact = artifacts.get(name);
		// 只检查属于本次制品集的包；其他传递依赖不在此验证。
		if (!artifact) continue;
		// resolved 必须存在且以 file: 开头；否则说明 npm 回退到了 registry。
		if (typeof installed.resolved !== "string" || !installed.resolved.startsWith("file:")) {
			throw new Error(`${name} did not resolve from a local artifact: ${String(installed.resolved)}`);
		}
		// lockfile 里的相对 file: 路径以消费者目录为基准解析。
		const resolvedPath = new URL(installed.resolved, pathToFileURL(`${directory}/`));
		// 协议必须仍是 file:，且解析出的路径必须与 manifest 记录的 tarball 完全一致。
		if (resolvedPath.protocol !== "file:" || resolvedPath.pathname !== pathToFileURL(artifact.tarballPath).pathname) {
			throw new Error(`${name} resolved from the wrong local artifact: ${installed.resolved}`);
		}
		resolvedNames.add(name);
	}
	// 直接依赖如果根本没进 lockfile，说明安装没覆盖到它。
	if (!resolvedNames.has(directPackageName)) throw new Error(`${directPackageName} is missing from the consumer lockfile`);
}

// 读取或创建 pnpm-workspace.yaml，并写入每个 Pi 包的 override。
function preparePnpmWorkspace(consumerDirectory, specifiers) {
	const workspacePath = join(consumerDirectory, "pnpm-workspace.yaml");
	// 文件不存在时用空文档，稍后创建；存在时完整保留原有注释/字段。
	const contents = existsSync(workspacePath) ? readFileSync(workspacePath, "utf8") : "";
	// parseDocument 返回可编辑的 YAML AST；parse() 会丢注释，所以这里不用。
	const document = parseDocument(contents);
	// 语法错误在文档里累积；有错误时不能继续写入。
	if (document.errors.length > 0) {
		throw new Error(`Invalid pnpm workspace file ${workspacePath}: ${document.errors.map((error) => error.message).join("; ")}`);
	}
	const workspace = document.toJS();
	// 空文件 toJS() 返回 null；否则根必须是 mapping（普通对象），不能是数组或标量。
	if (workspace !== null && (typeof workspace !== "object" || Array.isArray(workspace))) {
		throw new Error(`Invalid pnpm workspace file ${workspacePath}: root must be a mapping`);
	}
	// overrides 若已存在，也必须是 mapping，否则 setIn 会产生非法结构。
	if (workspace?.overrides !== undefined && (typeof workspace.overrides !== "object" || workspace.overrides === null || Array.isArray(workspace.overrides))) {
		throw new Error(`Invalid pnpm workspace file ${workspacePath}: overrides must be a mapping`);
	}
	// 空文档没有根节点；createNode({}) 创建一个空 mapping 以便 setIn。
	if (document.contents === null) document.contents = document.createNode({});
	// setIn 会自动创建 overrides 子映射；每个包名映射到对应的 file: specifier。
	for (const [name, specifier] of Object.entries(specifiers)) document.setIn(["overrides", name], specifier);
	// String(document) 序列化回文本，保留未修改部分。
	return { contents: String(document), path: workspacePath };
}

/**
 * 把消费者的 package.json 改写成使用本地 tarball；npm 写 overrides，pnpm 写 workspace overrides。
 * 输入：artifactSet（readArtifactSet 结果）、consumerDirectory、需要作为直接依赖的 packageNames、
 *       packageManager（npm 或 pnpm，默认 npm）。
 * 输出：改写后的 manifest 对象（已写入磁盘）。
 * 副作用：覆盖 package.json；pnpm 还覆盖 pnpm-workspace.yaml。
 * 错误：包管理器不支持、packageNames 为空、package.json 不存在、请求的包不在制品集里时抛出。
 * 例：wireConsumer({ artifactSet, consumerDirectory: "/tmp/app", packageNames: ["pkg-a"] })。
 */
export function wireConsumer({ artifactSet, consumerDirectory, packageNames, packageManager = "npm" }) {
	// pnpm 通过 workspace overrides 实现传递依赖固定；bun 不在这里接线。
	if (packageManager !== "npm" && packageManager !== "pnpm") throw new Error(`Unsupported package manager: ${packageManager}`);
	if (packageNames.length === 0) throw new Error("At least one package is required");
	const packageJsonPath = join(consumerDirectory, "package.json");
	// 必须先有消费者清单；本函数只改写，不创建。
	if (!existsSync(packageJsonPath)) throw new Error(`Consumer package.json does not exist: ${packageJsonPath}`);
	const contents = readFileSync(packageJsonPath, "utf8");
	const manifest = JSON.parse(contents);
	// artifacts 用于识别清单里已有的 Pi 依赖；getPackage 用于校验请求的包确实存在。
	const artifacts = new Map(artifactSet.packages.map((pkg) => [pkg.name, pkg]));
	for (const packageName of packageNames) artifactSet.getPackage(packageName);
	// 为制品集里每个包生成 file: specifier（不只是直接依赖），供 overrides 固定传递依赖。
	const specifiers = Object.fromEntries(
		artifactSet.packages.map((pkg) => [pkg.name, createFileSpecifier(consumerDirectory, pkg.tarballPath)]),
	);

	// 直接包 = 显式请求的包 + 清单现有依赖中属于本制品集的包。
	const directPackages = new Set(packageNames);
	for (const section of dependencySections) {
		for (const name of Object.keys(manifest[section] ?? {})) {
			if (artifacts.has(name)) directPackages.add(name);
		}
	}
	for (const name of directPackages) {
		// 保留包原来的依赖分区；没有则放进 dependencies。
		const targetSection = dependencySections.find((section) => Object.hasOwn(manifest[section] ?? {}, name)) ?? "dependencies";
		for (const section of dependencySections) {
			// 从其他分区删除同名声明，防止同一包被声明两次。
			if (section !== targetSection && manifest[section]) delete manifest[section][name];
		}
		// 展开原分区对象再覆盖目标包，保留其他依赖；specifiers[name] 必存在（前面已校验）。
		manifest[targetSection] = { ...manifest[targetSection], [name]: specifiers[name] };
	}
	// npm 用根 overrides 强制所有层级的 Pi 包都指向本地 tarball；只覆盖同名键，保留其他 override。
	if (packageManager === "npm") manifest.overrides = { ...manifest.overrides, ...specifiers };
	// pnpm 的 override 不能放在 package.json，需写进 workspace 文件。
	const pnpmWorkspace = packageManager === "pnpm" ? preparePnpmWorkspace(consumerDirectory, specifiers) : undefined;
	// 用探测到的原缩进重写，末尾补换行；JSON.stringify 会丢掉注释和键顺序之外的信息。
	writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, detectIndentation(contents))}\n`);
	if (pnpmWorkspace) writeFileSync(pnpmWorkspace.path, pnpmWorkspace.contents);
	return manifest;
}

/**
 * 在一个（通常是新建的）目录里做隔离安装，可选 npm 或 bun。
 * 输入：artifactSet、directory、要安装的 packageNames、packageManager（npm 或 bun，默认 npm）。
 * 输出：无；安装结果留在 directory/node_modules。
 * 副作用：创建 directory、写私有 package.json、调用 wireConsumer、执行安装命令（可能访问 registry）。
 * 错误：包管理器不支持、包为空/不存在、安装失败（子进程非零退出）时抛出。
 * 例：installConsumer({ artifactSet, directory: "/tmp/isolated", packageManager: "bun", packageNames: ["pkg-a"] });
 */
export function installConsumer({ artifactSet, directory, packageNames, packageManager = "npm" }) {
	// 这里只支持 npm 和 bun；pnpm 的接线由 use-local-packages.mjs 单独处理。
	if (packageManager !== "npm" && packageManager !== "bun") throw new Error(`Unsupported package manager: ${packageManager}`);
	if (packageNames.length === 0) throw new Error("At least one package is required");
	// 先校验每个包都在制品集里，避免创建目录、写文件后才发现。
	for (const packageName of packageNames) artifactSet.getPackage(packageName);
	mkdirSync(directory, { recursive: true });
	// 私有清单避免 npm 把该目录当可发布包；type:module 让生成的冒烟脚本支持 ESM。
	writeFileSync(join(directory, "package.json"), '{"private":true,"type":"module"}\n');
	// 复用 npm 接线逻辑写 file: 依赖和 overrides；bun 安装时也使用 npm 风格的 overrides。
	wireConsumer({ artifactSet, consumerDirectory: directory, packageNames });
	// bun 用 --production；npm 用等价但更明确的 --omit=dev，并关闭审计和 fund 输出。
	const installArgs = packageManager === "bun" ? ["--production"] : ["--omit=dev", "--no-audit", "--no-fund"];
	// --ignore-scripts 禁止依赖的安装脚本执行，降低本地测试的风险。
	const args = ["install", "--ignore-scripts", ...installArgs];
	// 安装可能较慢，给 5 分钟超时；stdio inherit 让用户看到进度。
	const options = { cwd: directory, stdio: "inherit", timeout: 300_000 };
	// npm 走跨平台 helper；bun 直接按可执行名启动。
	if (packageManager === "npm") execNpmSync(args, options);
	else execFileSync(packageManager, args, options);
}

/**
 * 校验 npm 安装后的包确实可用、且来自本地制品。
 * 输入：directory（消费者目录）、artifactSet、packageName（必须是制品集里的直接包）。
 * 输出：无；全部通过时正常返回。
 * 副作用：在消费者目录临时写 artifact-smoke.mjs，运行后 finally 删除；启动 Node 子进程导入包。
 * 错误：版本不符、main/types 缺失或越界、字面量 exports/bin 文件缺失、lockfile 解析错误、
 *       生成脚本导入失败时抛出。
 * 例：smokeTestNpmConsumer({ artifactSet, directory: "/tmp/app", packageName: "pkg-a" });
 */
export function smokeTestNpmConsumer({ directory, artifactSet, packageName }) {
	// getPackage 同时校验包存在；artifact.version 是打包时的版本。
	const artifact = artifactSet.getPackage(packageName);
	const installedDirectory = packageDirectory(directory, packageName);
	const manifest = JSON.parse(readFileSync(join(installedDirectory, "package.json"), "utf8"));
	// npm 可能因缓存或 registry 回退装了别的版本，必须与 manifest 完全一致。
	if (manifest.version !== artifact.version) {
		throw new Error(`${packageName} version mismatch: expected ${artifact.version}, found ${manifest.version}`);
	}
	// 公开 Pi 包必须有字符串 main/types，这是发布约定，不只是可选字段。
	if (typeof manifest.main !== "string") throw new Error(`Public Pi package ${packageName} must declare a string main field`);
	if (typeof manifest.types !== "string") throw new Error(`Public Pi package ${packageName} must declare a string types field`);
	assertPackageFile(installedDirectory, manifest.main, `${packageName} main`);
	assertPackageFile(installedDirectory, manifest.types, `${packageName} types`);

	// 收集需要真实 import 的运行时子路径；类型导出只检查文件存在，不在此导入。
	const runtimeSpecifiers = [];
	for (const [subpath, value] of literalExports(manifest)) {
		const runtime = runtimeTarget(value);
		const types = typesTarget(value);
		if (runtime) {
			assertPackageFile(installedDirectory, runtime, `${packageName} export ${subpath}`);
			// "./feature" 转成 "pkg/feature"；"." 就是包名本身。
			runtimeSpecifiers.push(subpath === "." ? packageName : `${packageName}${subpath.slice(1)}`);
		}
		if (types) assertPackageFile(installedDirectory, types, `${packageName} types export ${subpath}`);
	}
	// bin 可以是字符串或对象；字符串时用包名最后一段作为命令名。
	for (const [name, target] of Object.entries(typeof manifest.bin === "string" ? { [packageName.split("/").at(-1)]: manifest.bin } : (manifest.bin ?? {}))) {
		// 统一补 ./ 前缀，assertPackageFile 才能按包内路径解析。
		assertPackageFile(installedDirectory, target.startsWith("./") ? target : `./${target}`, `${packageName} bin ${name}`);
	}

	// lockfile 是判断是否真的从本地 tarball 安装的依据；缺失时无法验证。
	if (!existsSync(join(directory, "package-lock.json"))) throw new Error(`npm consumer smoke test requires package-lock.json: ${directory}`);
	verifyLocalResolutions(directory, artifactSet, packageName);
	const smokePath = join(directory, "artifact-smoke.mjs");
	// 为每个运行时子路径生成 import.meta.resolve 断言；JSON.stringify 确保包名/子路径被正确转义。
	const resolveChecks = runtimeSpecifiers.map((specifier) => `assert.ok(existsSync(fileURLToPath(import.meta.resolve(${JSON.stringify(specifier)}))));`).join("\n");
	// 生成一次性 ESM 脚本：先真实 import 根包（会执行模块顶层代码），再解析每个子路径。
	writeFileSync(
		smokePath,
		`import assert from "node:assert/strict";\nimport { existsSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\nimport ${JSON.stringify(packageName)};\n${resolveChecks}\n`,
	);
	try {
		// 用当前 Node 运行脚本；cwd 设为消费者目录，模块解析从 package.json 的依赖开始。
		execFileSync(process.execPath, [smokePath], { cwd: directory, stdio: "inherit", timeout: 300_000 });
	} finally {
		// 无论成功失败都删除临时脚本；失败信息已由子进程输出。
		rmSync(smokePath, { force: true });
	}
}

// 把 scoped 包名转成单层目录名：@scope/name -> scope-name。
export function packageConsumerDirectoryName(packageName) {
	return packageName.replace(/^@/, "").replaceAll("/", "-");
}
