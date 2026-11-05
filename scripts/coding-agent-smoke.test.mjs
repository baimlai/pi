// 文件导读
// 所属：仓库根 scripts/ 的 Node 内置测试文件，测试同目录的 coding-agent-smoke.mjs。
// 被测模块：smokeTestCodingAgent(directory, runtime)——在已安装的 coding-agent 消费者里检查 SDK 导入与 CLI 版本。
// 测试夹具：在系统临时目录造一个带空格的假仓库与假包 @earendil-works/pi-coding-agent，用生产同款
//   produceArtifactSet/installConsumer 打包安装，但不编译真实仓库、不访问 Git（source: null）。
// 覆盖分组：1) 合法包通过；2) #9132 回归——CLI 可用但 SDK 导入未声明依赖时必须失败。
// 运行命令：node --test scripts/coding-agent-smoke.test.mjs（或从根目录用相同路径）。
// 副作用：创建/删除临时目录，并执行 npm install（本地 tarball 与包自身依赖）；每个用例后由 t.after 清理。
// 建议阅读顺序：先看 writePackage/createFixture 如何搭夹具，再看两个 test 用例。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// node:test 的默认导出是 test 函数；无需第三方测试框架。
import test from "node:test";
import { installConsumer } from "./local-package-install.mjs";
import { produceArtifactSet } from "./package-artifacts.mjs";
import { codingAgentName, smokeTestCodingAgent } from "./coding-agent-smoke.mjs";

// 输入：目录、package.json 对象、额外文件映射。输出：无。副作用：递归创建目录并写文件。
// files 的键是包内相对路径；value 是文件内容的字符串。
function writePackage(directory, manifest, files) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), content);
	}
}

// 输入：node:test 的 t（用于注册清理），可选 importUndeclared 控制 SDK 是否导入未声明包。
// 输出：消费者目录路径（已安装假 coding-agent 包）。
// 副作用：创建临时目录、打包本地 tarball、执行 npm install；t.after 在用例结束后删除临时根。
// 主流程：造假仓库 → 写假包 → produceArtifactSet 只打包不构建 → installConsumer 安装。
function createFixture(t, { importUndeclared = false } = {}) {
	// 每个用例一个随机临时根，避免并发/重复运行互相覆盖。
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-coding-agent-smoke-test-"));
	// t.after 注册的清理在用例结束（无论成功失败）时执行；force 容忍部分文件已被删除。
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	// 路径含空格：验证 installConsumer 与执行入口对空格路径的处理。
	const root = join(temporaryRoot, "fixture with spaces");
	const repoRoot = join(root, "repo");
	mkdirSync(repoRoot, { recursive: true });
	// 工作区根清单只需是合法 JSON；produceArtifactSet 用 getPublicWorkspacePackages 扫描 packages/ 子目录。
	writeFileSync(join(repoRoot, "package.json"), '{"name":"fixture","private":true}\n');
	// 目录名取 scope 后的部分（pi-coding-agent），与真实工作区布局一致。
	writePackage(
		join(repoRoot, "packages", codingAgentName.split("/")[1]),
		{
			name: codingAgentName,
			version: "1.0.0",
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			// exports 决定消费者 `import "@earendil-works/pi-coding-agent"` 解析到哪个文件。
			exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
			// npm pack 只收录 files 列出的目录，所以 dist 必须在内。
			files: ["dist"],
			bin: { pi: "dist/bundle/cli.js" },
		},
		{
			// 模板字符串按 importUndeclared 在首行插入未声明导入；其余三行模拟 SDK 公开符号。
			"dist/index.js": `${importUndeclared ? 'import "@earendil-works/undeclared";' : ""}
export function createAgentSession() {}
export class SessionManager { static inMemory() {} }
export class ModelRuntime { static create() {} }
`,
			"dist/index.d.ts": "export {};\n",
			// dist/cli.js 与 bundle/cli.js 都输出版本号，供 smokeTestCodingAgent 的两个 CLI 入口断言。
			"dist/cli.js": 'console.log("1.0.0");\n',
			"dist/bundle/cli.js": 'console.log("1.0.0");\n',
		},
	);
	// build: false 表示不编译；source: null 表示跳过所有 git 操作（测试夹具不是真实 Git 仓库）。
	const artifactSet = produceArtifactSet({ build: false, outDir: join(root, "artifacts"), repoRoot, source: null });
	const directory = join(root, "consumer");
	// 写消费者 package.json 安装本地 tarball；packageNames 限定只装被测包。
	installConsumer({ artifactSet, directory, packageNames: [codingAgentName] });
	return directory;
}

// 用例 1：合法安装包应静默通过（smokeTestCodingAgent 内部断言失败会抛错，从而让测试失败）。
test("accepts a valid coding-agent package", (t) => {
	smokeTestCodingAgent(createFixture(t));
});

// #9132: smoke-test the public SDK, not just a bundled CLI that hides missing imports.
// 用例 2：CLI 仍能输出版本，但 SDK 顶层 import 了未声明依赖；必须从导入阶段就失败。
// 期望正则转义了包名中的 /，匹配 Node 的 "Cannot find package ... imported from ..." 错误。
test("fails when the SDK imports an undeclared package despite a working CLI", (t) => {
	const directory = createFixture(t, { importUndeclared: true });
	assert.throws(() => smokeTestCodingAgent(directory), /Cannot find package '@earendil-works\/undeclared'/);
});
