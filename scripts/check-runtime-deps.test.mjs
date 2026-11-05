// 在自建临时包中运行真实依赖检查器，验证声明/类型擦除/构建可达边界；不执行夹具TS里的import。
// strict版本的equal按严格相等断言，match检查stderr是否匹配正则。
import assert from "node:assert/strict";
// 用当前Node同步启动检查脚本并收集退出状态/stdout/stderr；不是启动模型或发布任务。
import { spawnSync } from "node:child_process";
// Promise版文件API负责创建夹具及测试结束时删除自己建的目录。
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
// 获取操作系统临时目录，不假定所有平台都使用/tmp。
import { tmpdir } from "node:os";
// 使用本机路径规则构造测试路径。
import { join } from "node:path";
// 将import.meta.url相邻文件的URL正确转成本地路径，包括转义字符处理。
import { fileURLToPath } from "node:url";
// Node内置测试运行器；异步回调返回的Promise会被等待。
import test from "node:test";

// 锁定真实仓库脚本的绝对位置，子进程即使换cwd也仍运行它。
const script = fileURLToPath(new URL("./check-runtime-deps.mjs", import.meta.url));

/**
 * 建一个example包并补充extraFiles，运行检查器，返回包含status/stderr等的结果。
 * manifest浅覆盖默认包名/版本，source成为src/index.ts；如空清单加import "dev"可检查漏声明。
 * 写入自己的临时夹具，注册结束清理；子进程cwd指向夹具，但这不构成文件系统沙箱。
 * 文件操作失败会reject；spawnSync的启动失败信息在返回对象中，调用者不能只看stderr猜成功。
 */
async function check(t, manifest, source, extraFiles = {}) {
	// mkdtemp在前缀后补随机字符，每次调用取得独立目录。
	const root = await mkdtemp(join(tmpdir(), "pi-runtime-deps-"));
	// after钩子返回删除Promise供运行器等待，正常断言失败也会清理；不保证强制杀进程后执行。
	t.after(() => rm(root, { recursive: true, force: true }));
	// 文件名到内容的普通对象；没有把这些文本当JS导入执行。
	const files = {
		// 对象展开靠后，manifest可覆盖name/version；JSON.stringify生成合法JSON文本或抛错。
		"packages/example/package.json": JSON.stringify({ name: "example", version: "1.0.0", ...manifest }),
		// source直接成为检查器读取的TS源码，不在此编译运行。
		"packages/example/src/index.ts": source,
		// 后展开的额外路径也能覆盖默认文件，测试实际只传各自需要的夹具。
		...extraFiles,
	};
	// entries得到[相对路径,内容]二元组，for...of逐份写入，await使写入按次序完成。
	for (const [path, contents] of Object.entries(files)) {
		// 把约定的夹具相对路径拼到临时根；这个helper没有对任意不可信路径做逃逸检查。
		const fullPath = join(root, path);
		// join(文件路径,"..")得到父目录，recursive允许多级创建及已存在目录。
		await mkdir(join(fullPath, ".."), { recursive: true });
		// 当前内容是字符串，writeFile默认UTF-8并覆盖同路径文件。
		await writeFile(fullPath, contents);
	}
	// argv数组不经shell解释；encoding使stdout/stderr为字符串，cwd只改变工作目录。
	return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

// #9132: workspace resolution and installing every release package masked a missing runtime dependency.
// #9132回归：别的workspace包存在，不代表example发布后已声明它。期望非零状态且具体指出漏声明。
test("rejects undeclared imports even when the workspace package exists", async (t) => {
	// 空运行时依赖表，入口重导出另一个包子路径；检查语法，不调用createUnixServer。
	const result = await check(t, {}, 'export { createUnixServer } from "@earendil-works/pi-server/unix";', {
		// 补一个真实存在的workspace清单，防测试仅因“包完全不存在”而失败。
		"packages/server/package.json": JSON.stringify({ name: "@earendil-works/pi-server", version: "1.0.0" }),
	});
	// status1本身不说明原因，后一个stderr断言把失败定位到预期诊断。
	assert.equal(result.status, 1);
	// [\\/]同时接受两类路径分隔符；:1定位入口第一行，\/匹配包名中的斜杠。
	assert.match(result.stderr, /src[\\/]index\.ts:1: @earendil-works\/pi-server\/unix is not declared/);
});

// 正例同时覆盖声明区、Node内建、自导入、相对导入和纯type形状；不是实际执行这些模块。
// 下面模板逐行：node:fs与fs/promises为内建；./local.ts为相对路径；example/subpath为自身。
// 混合value/type仍需@scope/runtime；optional和peer分别在对应声明区；其余四种纯类型形式免运行时依赖要求。
// import type整句擦除；import {type T}/export {type T}按成员标记；export type整句亦无值导出。
test("accepts runtime declarations, builtins, self imports, relative imports, and erased types", async (t) => {
	// 把运行时依赖分别放进三种合法声明区，使用固定版本；模板内容保持为被检查源码。
	const result = await check(t, {
		// scope包允许其任意子路径说明符，不在这里验证该子路径确实存在。
		dependencies: { "@scope/runtime": "1.0.0" },
		// 可选依赖虽可能未安装，检查器仍只验证“有声明”。
		optionalDependencies: { optional: "1.0.0" },
		// peer由使用方提供，同样计入允许集合。
		peerDependencies: { peer: "1.0.0" },
	}, `
import "node:fs";
import "fs/promises";
import "./local.ts";
import "example/subpath";
import { value, type T } from "@scope/runtime/subpath";
import optional from "optional";
export * from "peer";
import type { Type } from "type-only";
import { type OtherType } from "inline-type-only";
export type { Type } from "export-type-only";
export { type OtherType } from "export-inline-type-only";
`);
	// status0才算检查通过，失败时把stderr作为断言信息展示；不等同夹具可成功类型检查/运行。
	assert.equal(result.status, 0, result.stderr);
});

// 反例模板逐行：dev只在开发依赖；空import/空export仍算运行时；混合export含value不能全擦除。
// lazy箭头里的固定import也会被AST遍历发现；require和require.resolve各检查第一个字面量参数。
// 这些语句只是源码文本，测试不真正require包，也不调用lazy函数。
test("rejects dev-only dependencies, side-effect imports, mixed exports, and literal runtime loads", async (t) => {
	// devDependencies不属于允许的运行时声明区，下面七种固定加载都应报告。
	const result = await check(t, { devDependencies: { dev: "1.0.0" } }, `
import "dev";
import {} from "empty-import";
export {} from "empty-export";
export { type T, value } from "mixed-export";
const lazy = () => import("lazy/subpath");
const required = require("required");
const resolved = require.resolve("resolved/subpath");
`);
	// 非零状态配合逐名字诊断，避免其他启动错误误算预期失败。
	assert.equal(result.status, 1);
	// 字符串数组列出七种应报说明符；for...of逐个验证，没有要求诊断排序或刚好七行。
	for (const name of ["dev", "empty-import", "empty-export", "mixed-export", "lazy/subpath", "required", "resolved/subpath"]) {
		// includes只要求包含该段文字，第二参数在失败时展示完整stderr。
		assert.ok(result.stderr.includes(`${name} is not declared`), result.stderr);
	}
});

// JSON资产通过import进入program，即使不匹配.ts include，也不该被当成非法发布TS源码。
test("allows imported JSON assets outside the TypeScript include pattern", async (t) => {
	// JSON.parse等由检查器/编译器读取配置，测试本身不执行入口的data导入。
	const result = await check(t, {}, 'import data from "./data.json";', {
		// 只把.ts设为根文件，resolveJsonModule允许编译器跟随JSON导入。
		"packages/example/tsconfig.build.json": JSON.stringify({ include: ["src/**/*.ts"], compilerOptions: { resolveJsonModule: true } }),
		// 用最小合法JSON对象作为实际资产文件。
		"packages/example/src/data.json": "{}",
	});
	// 断言依赖检查通过，不比较data运行时值。
	assert.equal(result.status, 0, result.stderr);
});

// 排除且无人导入的实验源码不进入发布program，因此其中开发依赖不影响本包检查。
test("permits dev-only dependencies in sources excluded from the published build", async (t) => {
	// 公开入口为空，避免它意外把实验文件重新引入。
	const result = await check(t, { devDependencies: { server: "1.0.0" } }, "", {
		// exclude仅筛根文件，不表示永远不能通过import被带回；后面的回归专测区别。
		"packages/example/tsconfig.build.json": JSON.stringify({ include: ["src/**/*.ts"], exclude: ["src/experimental"] }),
		// 文件确实存在并含开发依赖，但本例没有从根入口引用它。
		"packages/example/src/experimental/server.ts": 'import "server";',
	});
	// 证明当前夹具不报错，并非允许发布入口任意依赖开发包。
	assert.equal(result.status, 0, result.stderr);
});

// #9132: an experimental flag cannot prevent module resolution through a public entrypoint.
// #9132：分别用值重导出和纯类型导入进入实验文件；运行时type免依赖，不代表构建图不可达。
for (const statement of ['export * from "./experimental/server";', 'import type { Options } from "./experimental/server";']) {
	// 模板插值只把当前statement放进测试名；循环注册两个独立异步用例，各有自己的临时目录。
	test(`rejects excluded code reachable through ${statement}`, async (t) => {
		// 当前语句成为公开入口，实验文件自身仍有真正的server运行时导入。
		const result = await check(t, { devDependencies: { server: "1.0.0" } }, statement, {
			// 根配置仍明确exclude实验目录，不能误以为它原本被include当根。
			"packages/example/tsconfig.build.json": JSON.stringify({ include: ["src/**/*.ts"], exclude: ["src/experimental"] }),
			// 同一文本先副作用导入server，再声明可供类型导入使用的空接口Options。
			"packages/example/src/experimental/server.ts": 'import "server"; export interface Options {}',
		});
		// 先查失败状态，随后分别查可达边界与漏运行时依赖两类原因。
		assert.equal(result.status, 1);
		// exclude只筛根文件；从公开入口可达后仍入program，检查器明确拒绝。
		assert.match(result.stderr, /is excluded from example's build but imported by it/);
		// 即使走纯类型入口路径，也继续检查被带回文件内部的值导入。
		assert.match(result.stderr, /server is not declared/);
	});
}

// 最后一个正例分别放入测试目录、声明文件、private包，验证这些范围不误报。
test("ignores tests, declarations, and private packages", async (t) => {
	// 公开src入口为空，让下面三处仅由各自边界决定是否被查。
	const result = await check(t, {}, "", {
		// 不在默认src/**/*下，且未被入口导入，本例不会成为待查发布源码。
		"packages/example/test/test.ts": 'import "test-only";',
		// d.ts声明即使出现于program，也由检查器明确跳过。
		"packages/example/src/index.d.ts": 'import "declaration-only";',
		// private布尔true让整个包不进入公开包列表；不是按包名"private"特殊判断。
		"packages/private/package.json": JSON.stringify({ name: "private", private: true }),
		// 私有包内的值导入不属于此次公开包检查范围。
		"packages/private/src/index.ts": 'import "private-only";',
	});
	// 仅证明这份夹具成功，不意味着任意位置/被入口导入的测试文件都自动免检。
	assert.equal(result.status, 0, result.stderr);
});
