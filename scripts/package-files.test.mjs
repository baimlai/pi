// 文件导读
// 所属：仓库根 scripts/ 的脚本测试，被测对象是同目录的 package-files.mjs。
// 作用：在临时目录里真实调用 CLI，验证 clean/copy/executable 和错误处理，不触碰仓库构建产物。
// 测试夹具：workspace() 用 mkdtempSync 在系统临时目录建独立目录，t.after 负责递归清理；
// run() 用 spawnSync 启动一个新的 Node 进程运行被测脚本，因此测到的是真实参数解析与退出码。
// 覆盖分组：
//   1. clean 删除目录/文件并忽略缺失路径；
//   2. copy 展开 glob、创建目标目录、覆盖已有文件、拒绝零匹配；
//   3. copy 多来源与嵌套目录；
//   4. executable 追加执行位且保留原权限；
//   5. 无效命令/缺参数时输出 usage 并以非零码退出。
// 运行命令：node --test scripts/package-files.test.mjs
// 前置条件：无网络、无构建产物；Windows 上跳过权限位断言（chmod 语义不同）。
// 阅读顺序：先看 workspace/run 两个 helper，再按 test 名称读断言。
// Exercises the file operations used by package build scripts without touching build output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// 从测试文件 URL 转换成被测脚本的绝对路径；不依赖当前工作目录。
const script = fileURLToPath(new URL("./package-files.mjs", import.meta.url));

// 创建一个随机临时目录，并注册测试结束后的递归清理。
function workspace(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-package-files-"));
	// t.after 在测试（含失败）结束后执行；只删本次创建的目录。
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

// 在指定目录作为 cwd 启动被测脚本；encoding 让 stdout/stderr 以字符串返回，便于断言。
function run(directory, ...args) {
	return spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: "utf8" });
}

// clean：删除 dist 和 output.txt，同时传入不存在的 missing 也不应失败。
test("clean removes directories and files and ignores missing paths", (t) => {
	const directory = workspace(t);
	// 构造嵌套目录，验证 recursive 删除确实清掉整棵树。
	mkdirSync(join(directory, "dist", "nested"), { recursive: true });
	writeFileSync(join(directory, "dist", "nested", "file.js"), "output");
	writeFileSync(join(directory, "output.txt"), "output");
	// status 为 0 表示脚本正常退出；missing 不存在的路径被 force 静默忽略。
	assert.equal(run(directory, "clean", "dist", "output.txt", "missing").status, 0);
	assert.equal(existsSync(join(directory, "dist")), false);
	assert.equal(existsSync(join(directory, "output.txt")), false);
});

// copy：glob 只匹配 .json，目标目录自动创建，第二次运行覆盖旧内容。
test("copy expands patterns, creates directories, and overwrites existing assets", (t) => {
	const directory = workspace(t);
	// 目录名含空格，验证参数以数组传递时不依赖 shell 分词。
	mkdirSync(join(directory, "source assets"));
	writeFileSync(join(directory, "source assets", "dark.json"), "dark");
	writeFileSync(join(directory, "source assets", "light.json"), "light");
	writeFileSync(join(directory, "source assets", "ignored.txt"), "ignored");
	// 模式字符串原样交给 globSync；在这个进程里没有 shell 会展开 *。
	const args = ["copy", "source assets/*.json", "output/assets"];
	assert.equal(run(directory, ...args).status, 0);
	assert.equal(readFileSync(join(directory, "output/assets/dark.json"), "utf8"), "dark");
	assert.equal(readFileSync(join(directory, "output/assets/light.json"), "utf8"), "light");
	// .txt 不在 glob 中，不应被复制。
	assert.equal(existsSync(join(directory, "output/assets/ignored.txt")), false);
	// 修改来源后再次执行，验证 cpSync 默认覆盖已有目标文件。
	writeFileSync(join(directory, "source assets", "dark.json"), "updated");
	assert.equal(run(directory, ...args).status, 0);
	assert.equal(readFileSync(join(directory, "output/assets/dark.json"), "utf8"), "updated");
});

// copy：多个来源可以混合目录和文件；目录会递归复制并保留自己的名字。
test("copy accepts multiple files and preserves directory names and nested contents", (t) => {
	const directory = workspace(t);
	mkdirSync(join(directory, "docs", "nested"), { recursive: true });
	writeFileSync(join(directory, "docs", "nested", "guide.md"), "guide");
	writeFileSync(join(directory, "README.md"), "readme");
	assert.equal(run(directory, "copy", "docs", "README.md", "dist").status, 0);
	// 复制目录时 basename 是 docs，因此目标里是 dist/docs/... 而不是把内容摊平。
	assert.equal(readFileSync(join(directory, "dist", "docs", "nested", "guide.md"), "utf8"), "guide");
	assert.equal(readFileSync(join(directory, "dist", "README.md"), "utf8"), "readme");
});

// copy：模式匹配不到任何文件时必须失败，避免静默漏打包。
test("copy fails when an asset pattern matches nothing", (t) => {
	const result = run(workspace(t), "copy", "missing/*.json", "dist");
	// 未捕获异常让 Node 返回非零退出码，错误文本来自脚本里的 throw。
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /No files match missing/);
});

// executable：在原模式上按位或 0o111；0o640 会变成 0o751。
test("executable adds executable bits without removing existing permissions", (t) => {
	const directory = workspace(t);
	for (const name of ["cli.js", "rpc.js"]) writeFileSync(join(directory, name), "entry", { mode: 0o640 });
	// 先记录 cli.js 原始 mode，后面比较追加执行位后的结果。
	const mode = statSync(join(directory, "cli.js")).mode;
	assert.equal(run(directory, "executable", "cli.js", "rpc.js").status, 0);
	// Windows 没有 POSIX 权限位，chmod 只影响只读位，因此跳过精确断言。
	if (process.platform !== "win32") {
		// & 0o777 去掉文件类型位，只比较权限部分。
		assert.equal(statSync(join(directory, "cli.js")).mode & 0o777, (mode | 0o111) & 0o777);
		assert.equal(statSync(join(directory, "rpc.js")).mode & 0o111, 0o111);
	}
});

// 参数校验：空参数、未知命令、只有命令没有路径都必须打印 usage 并非零退出。
test("invalid commands and missing arguments fail", (t) => {
	const directory = workspace(t);
	for (const args of [[], ["unknown", "dist"], ["clean"], ["copy", "dist"], ["executable"]]) {
		const result = run(directory, ...args);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Usage: package-files/);
	}
});
