// Test support for the plugins component (slice 7c, slice 12): fixture plugins copied into temporary roots, plugins, npm
// packages and local bare git repositories written there (no network), and the host packages the fixtures import.

import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import * as chord from "../../../src/index.ts";
import type { HostPackages, KindDefinition } from "../../../src/node/plugins/index.ts";

/** The fixture plugins' directory. */
// import.meta.url 是当前模块文件的 URL；new URL 的相对路径再由 fileURLToPath 转成操作系统路径。
export const FIXTURES = fileURLToPath(new URL("../fixtures/plugins/", import.meta.url));

/** The host packages the fixtures import: this process's Chord. */
// HostPackages 是包名到实际模块对象的映射；测试插件拿到同一份 Chord，因此 instanceof 不会因重复模块失效。
export const HOST_PACKAGES: HostPackages = { "@earendil-works/chord": chord };

/** The facet kinds of the fixtures' app. */
// as const 保留每项的字符串字面量和只读元组类型；它只影响类型检查，不在运行时冻结数组。
export const KINDS = ["server", "worker", "web"] as const;

/** The fixtures' app's kinds as the component takes them: Node servers and workers, a browser web, `modules`' names. */
// 根据 modules 的包名构造三类 facet 的构建配置；不加载模块、不安装依赖。
// 例如 {react: React} 会让 server、worker、web 都允许导入 react；web 使用 browser 平台，其余为 node。
// Readonly<Record<string, KindDefinition>> 表示按字符串查配置且调用方不应通过这个类型改写属性。
export function kindsOf(modules: HostPackages): Readonly<Record<string, KindDefinition>> {
	// Object.keys 只取自身可枚举键；三个配置共享这一个包名数组。
	const hostPackages = Object.keys(modules);
	// 返回每个种类的平台与允许的宿主包名；真正的模块对象在后续求值时传入。
	return {
		server: { platform: "node", hostPackages },
		worker: { platform: "node", hostPackages },
		web: { platform: "browser", hostPackages },
	};
}

// 保存本模块创建的临时目录；string[] 是字符串数组类型，不包含业务插件目录。
const made: string[] = [];

// 每个测试结束后取走全部登记目录并递归删除；splice(0) 同时清空登记表，rm 的失败会使清理钩子失败。
afterEach(async () => {
	// for...of 顺序等待删除；force 忽略不存在的目录，不会忽略所有其他文件系统错误。
	for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A temporary directory removed after the test; `fixtures` (names of fixture plugins) copied into it. */
// 创建并登记临时插件根，按 fixtures 名称复制仓库夹具，返回目录路径。
// 例如 tempRoot(["notes"]) 创建一个只含 notes 副本的根；后续编辑副本不会改夹具原文件。
// 默认参数 [] 表示不复制，readonly string[] 只限制调用方经此参数写数组；文件错误以拒绝的 Promise 传播。
export async function tempRoot(fixtures: readonly string[] = []): Promise<string> {
	// mkdtemp 为带前缀的路径补随机后缀，避免并行测试共用目录；await 等待真实目录创建。
	const root = await mkdtemp(join(tmpdir(), "chord-plugins-"));
	// 先登记清理责任，复制失败时 afterEach 仍能移除此目录。
	made.push(root);
	// 每个名称复制到根内同名目录；recursive 复制完整子树，逐个 await 避免返回未完成副本。
	for (const name of fixtures) await cp(join(FIXTURES, name), join(root, name), { recursive: true });
	// 把已创建的目录交给测试使用；删除由本模块 afterEach 负责。
	return root;
}

/** Writes `files` (relative path to text) into `dir`, creating directories. */
// 把相对路径到文本的映射写入 dir；先递归建父目录，再覆盖文件，无额外返回数据。
// 例如 writeFiles(root,{"notes/label.ts":"..."}) 会创建 notes 后写文件；这里信任测试给出的相对路径，并不做越界校验。
export async function writeFiles(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
	// Object.entries 返回键值对；const [path,text] 是数组解构，一轮对应一个文件。
	for (const [path, text] of Object.entries(files)) {
		// join 组成目标路径，dirname 取父目录；recursive 允许父目录已经存在。
		await mkdir(dirname(join(dir, path)), { recursive: true });
		// 等待文本写入；任一错误向调用方传播，不自动回滚之前写过的文件。
		await writeFile(join(dir, path), text);
	}
}

/** Writes a plugin named `name` into `root/dir`: its `package.json` (with `manifest`'s fields) and `files`. */
// 在 root/dir 创建测试插件并返回路径：写入默认 ESM manifest 和 files。
// 例如 writePlugin(root,"n","@test/n",{"worker.ts":"..."}) 可被发现器作为插件读取。
// manifest 的展开在默认字段后，能覆盖 name/type；files 又能覆盖生成的 package.json，本函数不验证插件是否合法。
export async function writePlugin(
	root: string,
	dir: string,
	name: string,
	files: Readonly<Record<string, string>>,
	manifest: Readonly<Record<string, unknown>> = {},
): Promise<string> {
	// 构造插件目录；path 是本函数局部变量，不是导入的 path 模块。
	const path = join(root, dir);
	// 把默认 manifest 转成严格 JSON 文本，再与待写文件映射合并；这里只写临时文件，不执行 npm。
	await writeFiles(path, { "package.json": JSON.stringify({ name, type: "module", ...manifest }), ...files });
	// 返回实际写入目录，便于后续构建或放入本地依赖。
	return path;
}

/** Writes an npm package `name` into `dir`'s `node_modules`: its `package.json` (CommonJS unless `type`) and files. */
// 在插件自己的 node_modules/name 手写一个测试包；不联系 npm、不运行安装脚本。
// 默认 main 是 files 的首个键，版本固定为 1.0.0；manifest 可覆盖版本、入口和模块类型。
// 例如 {"index.js":"module.exports=1"} 形成 CommonJS 包；Promise<void> 只表示完成，不返回包对象。
export async function writePackage(
	dir: string,
	name: string,
	files: Readonly<Record<string, string>>,
	manifest: Readonly<Record<string, unknown>> = {},
): Promise<void> {
	// 非空断言 ! 只告诉 TypeScript 首个键存在；运行时不检查 files 是否为空。
	const main = Object.keys(files)[0]!;
	// 把默认字段与 manifest 合并序列化；后面的展开字段优先。
	const json = JSON.stringify({ name, version: "1.0.0", main, ...manifest });
	// 把包文件和 manifest 写到临时 node_modules 内，模拟已安装依赖。
	await writeFiles(join(dir, "node_modules", name), { "package.json": json, ...files });
}

/**
 * A local bare git repository `<name>.git` in a temporary directory with `files` committed (one commit), tagged `tag`:
 * its `file://` URL and the commit. A call with `previous` adds another commit on top of that repository.
 */
// 为测试创建本地工作仓库和 bare 裸仓库，提交 files、打 tag，返回 file:// URL 与提交号。
// 传 previous 时复用两个目录、追加提交并推送到本地 bare；例如测试两个 tag 对应不同合同文件。
// 所有 Git 命令的 cwd 都是临时目录，不操作本项目 Git；命令失败会抛错，没有远程网络。
export async function gitRepository(
	name: string,
	files: Readonly<Record<string, string>>,
	tag: string,
	previous?: { readonly work: string; readonly bare: string },
): Promise<{ readonly url: string; readonly commit: string; readonly work: string; readonly bare: string }> {
	// 局部 git 辅助函数收 cwd 和可变参数 ...args，执行一次同步 Git 命令并返回去掉首尾空白的输出。
	const git = (cwd: string, ...args: string[]) =>
		// execFileSync 直接传参数数组，不经 shell；-c 只为该命令设置测试作者，避免依赖用户 Git 身份。
		execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], {
			// 在调用方指定的临时仓库运行；encoding 让返回值是 UTF-8 字符串而非 Buffer。
			cwd,
			encoding: "utf8",
		}).trim();
	// 可选链 ?. 在 previous 不存在时得到 undefined；?? 只在空值时新建临时目录。
	const work = previous?.work ?? (await tempRoot());
	// 只有首次调用才初始化仓库；续写时保留已有提交历史。
	if (previous === undefined) git(work, "init", "--quiet");
	// 把本次版本的文件覆盖写到工作仓库。
	await writeFiles(work, files);
	// 此处 --all 只作用于测试专用临时仓库，收录它的全部变化。
	git(work, "add", "--all");
	// 创建名称为 tag 的提交；若文件没变化，Git 会失败而不是制造空提交。
	git(work, "commit", "--quiet", "--message", tag);
	// 把传入标签指向本次 HEAD。
	git(work, "tag", tag);
	// 续写复用 bare 路径；首次在另一个登记的临时目录内创建 name.git。
	const bare = previous?.bare ?? join(await tempRoot(), `${name}.git`);
	// 首次复制成无工作区的 bare 仓库；这里 clone 的来源是本机路径。
	if (previous === undefined) git(work, "clone", "--quiet", "--bare", work, bare);
	// 续写时只向该临时 bare 推送标签和 master 引用，不会访问 origin。
	else git(work, "push", "--quiet", "--tags", bare, "HEAD:refs/heads/master");
	// 返回本地仓库 URL、当前 commit 和两个目录，供安装测试与下一次续写使用。
	return { url: `file://${bare}`, commit: git(work, "rev-parse", "HEAD"), work, bare };
}
