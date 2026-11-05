#!/usr/bin/env node

// 文件导读
// 所属：仓库根 scripts/ 的提交前锁文件守卫，由 .husky/pre-commit 直接 node 执行。
// 职责：若本次提交暂存了 package-lock.json，检查是否获得显式授权（PI_ALLOW_LOCKFILE_CHANGE）或只改了工作区包元数据；
//   否则打印依赖变化摘要和允许提交的方法，阻止提交。
// 上游：git commit → .husky/pre-commit → node scripts/check-lockfile-commit.mjs。
// 下游：调用只读 git 子进程（diff/show），不联网、不执行 npm、不写工作区。
// 输入：Git 暂存区（git diff --cached）与环境变量 PI_ALLOW_LOCKFILE_CHANGE（1/true/yes 视为授权）。
// 输出：允许时向 stderr 打印原因并以 0 退出；阻止时打印审查提示、版本变化摘要和授权命令，以 1 退出。
// 幂等性：只读检查，可重复运行。注意：只比较 HEAD 与索引中的 lockfile；工作区未暂存改动不参与。
// 示例：
//   git add package-lock.json && git commit ...                       # 默认被拦截
//   PI_ALLOW_LOCKFILE_CHANGE=1 git commit ...                         # 明确授权后放行
// 建议阅读顺序：先看 allowValue 与 git/readJsonFromGit，再看变化比较与分类，最后看三个放行/拦截分支。
import { execFileSync } from "node:child_process";

// 只有明确写成 1/true/yes 才授权；空串、0、false 等一律视为未授权。
const allowValue = process.env.PI_ALLOW_LOCKFILE_CHANGE;
const allowed = allowValue === "1" || allowValue === "true" || allowValue === "yes";

// 输入：git 参数数组。输出：stdout 文本。错误：git 非零退出时 execFileSync 抛错（由调用点决定是否捕获）。
// 不经 shell，参数中的路径/ref 不会触发命令注入。
function git(args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// 输入：形如 HEAD:package-lock.json 或 :package-lock.json 的 Git ref。
// 输出：解析后的 JSON 对象；对象不存在（首次提交）或 JSON 无效时返回 undefined，而不是让钩子崩溃。
function readJsonFromGit(ref) {
	try {
		return JSON.parse(git(["show", ref]));
	} catch {
		return undefined;
	}
}

// 输入：lockfile 中的 packages 键，如 node_modules/@scope/name 或 packages/ai。
// 输出：包名（含 scope）或原始键；用于错误信息中的可读标签。
function packageNameFromLockPath(lockPath) {
	const marker = "node_modules/";
	const index = lockPath.lastIndexOf(marker);
	if (index === -1) return lockPath || "<root>";
	const parts = lockPath.slice(index + marker.length).split("/");
	return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

// 输入：lockfile 路径与对应条目。输出：name@version 标签，缺字段时退回从路径推包名。
function packageLabel(lockPath, entry) {
	const name = entry?.name ?? packageNameFromLockPath(lockPath);
	return entry?.version ? `${name}@${entry.version}` : name;
}

// 比较 HEAD 提交里的 lockfile 与当前暂存区（: 前缀表示索引）里的 lockfile。
// 输出：每个 packages 条目的 oldEntry/newEntry 变化数组；任一侧不是 lockfileVersion 3 结构时返回 undefined。
function getLockfilePackageChanges() {
	const before = readJsonFromGit("HEAD:package-lock.json");
	const after = readJsonFromGit(":package-lock.json");
	if (!before?.packages || !after?.packages) return undefined;

	const changes = [];
	// 两侧键的并集：新增、删除、修改都能被发现。
	const paths = new Set([...Object.keys(before.packages), ...Object.keys(after.packages)]);
	// 排序只为让摘要输出稳定，不影响判定。
	for (const lockPath of [...paths].sort()) {
		const oldEntry = before.packages[lockPath];
		const newEntry = after.packages[lockPath];
		// JSON.stringify 比较整条记录，包含 resolved/integrity/依赖元数据；键顺序由 npm 生成，通常稳定。
		if (JSON.stringify(oldEntry) !== JSON.stringify(newEntry)) {
			changes.push({ lockPath, oldEntry, newEntry });
		}
	}
	return changes;
}

// 工作区包在 lockfile 中的键以 packages/ 开头（如 packages/ai），不是 node_modules/...
function isWorkspacePackagePath(lockPath) {
	return lockPath.startsWith("packages/");
}

// 只有“至少一处变化且全部是工作区路径”才自动放行；空变化集合不会走到这里（staged 已包含 lockfile）。
function hasOnlyWorkspacePackageChanges(changes) {
	return changes.length > 0 && changes.every((change) => isWorkspacePackagePath(change.lockPath));
}

// 输入：变化数组。输出：人类可读的 node_modules 变化摘要（新增/删除/版本变化/其他字段变化）。
function summarizeLockfileChange(changes) {
	const nodeModuleChanges = changes.filter((change) => change.lockPath.includes("node_modules/"));
	const summary = [];
	for (const { lockPath, oldEntry, newEntry } of nodeModuleChanges) {
		if (!oldEntry && newEntry) {
			summary.push(`added ${packageLabel(lockPath, newEntry)}`);
		} else if (oldEntry && !newEntry) {
			summary.push(`removed ${packageLabel(lockPath, oldEntry)}`);
		} else if (oldEntry?.version !== newEntry?.version) {
			summary.push(
				`changed ${packageNameFromLockPath(lockPath)} ${oldEntry?.version ?? "<none>"} -> ${newEntry?.version ?? "<none>"}`,
			);
		} else {
			summary.push(`changed ${packageLabel(lockPath, newEntry)}`);
		}
	}
	return summary;
}

// --cached 只看暂存区；--name-only 每行一个路径。trim + filter(Boolean) 去掉空行。
const stagedFiles = git(["diff", "--cached", "--name-only"])
	.split("\n")
	.map((line) => line.trim())
	.filter(Boolean);

// 未暂存 lockfile 时钩子什么都不做，正常放行。
if (!stagedFiles.includes("package-lock.json")) {
	process.exit(0);
}

// 显式授权优先；提示写到 stderr，不干扰可能被脚本消费的 stdout。
if (allowed) {
	console.error("package-lock.json is staged; PI_ALLOW_LOCKFILE_CHANGE is set, allowing commit.");
	process.exit(0);
}

const changes = getLockfilePackageChanges();
// 版本同步脚本通常只改工作区包的 version/resolved；这类变化不需要依赖审查。
if (changes && hasOnlyWorkspacePackageChanges(changes)) {
	console.error("package-lock.json only updates workspace package metadata; allowing commit.");
	process.exit(0);
}

console.error("package-lock.json is staged.");
console.error("");
console.error("Review lockfile changes before committing:");
console.error("  - confirm every new/updated package is intentional");
console.error("  - confirm npm age gates were active for resolution");
console.error("  - review any new lifecycle scripts in the dependency tree");
console.error("  - regenerate/check coding-agent install lock if release deps changed");

// 没有可解析的 lockfile 结构时 summary 为空，仍按“未授权”拦截。
const summary = changes ? summarizeLockfileChange(changes) : [];
if (summary.length > 0) {
	console.error("");
	console.error("Detected package version changes:");
	for (const change of summary.slice(0, 40)) {
		console.error(`  - ${change}`);
	}
	if (summary.length > 40) {
		console.error(`  ... ${summary.length - 40} more`);
	}
}

console.error("");
console.error("If this lockfile change is intentional, commit with:");
console.error("  PI_ALLOW_LOCKFILE_CHANGE=1 git commit ...");
process.exit(1);
