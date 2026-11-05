#!/usr/bin/env node
// 文件导读
// 所属：仓库根 scripts/，是手动打包公开包的命令行入口（npm run pack:packages 会转发参数）。
// 作用：调用 produceArtifactSet 构建（或复用）所有公开工作区包，输出一组内容寻址的 tarball 和 manifest.json，
// 并打印 use-local-packages.mjs 的连接命令，供外部项目做本地联调。
// 能力：解析 --out/--force/--offline-model-data/--skip-build/--help；调用 produceArtifactSet 生成制品；
// 输出 manifest 路径和本地连接命令。
// 上游：开发者命令行，或根 package.json 的 "pack:packages": "node scripts/pack-packages.mjs"。
// 下游：package-artifacts.mjs（构建/打包/校验）、node:path、node:util.parseArgs。
// 参数：
//   --out <dir>            必填，输出目录；仓库内只允许 .artifacts/ 下。
//   --force                替换已存在的输出目录（会先递归删除）。
//   --offline-model-data   用已缓存的模型数据构建（build:offline）。
//   --skip-build           不重新构建，直接打包现有 dist；要求之前已构建。
//   --help                 打印用法并以 0 退出。
// 输出：stdout 打印制品目录、manifest 路径和后续连接命令；没有 JSON 输出到文件之外。
// 副作用：默认执行 npm run clean + npm run build，写 tarball 与 manifest，可能删除 --out 指向的目录。
// 退出码：正常 0；参数缺失、输出目录非法、构建或 npm pack 失败时抛异常，Node 以 1 退出并打印栈。
// 示例（真实命令行）：
//   node scripts/pack-packages.mjs --out .artifacts/packages
//   node scripts/pack-packages.mjs --out /tmp/pi-packages --skip-build
// 阅读顺序：先看 parseArgs 选项和必填校验，再看 produceArtifactSet 调用与最后的提示。

import { resolve } from "node:path";
import { parseArgs } from "node:util";
// 制品集的生产逻辑完全在库中，本文件只负责 CLI 参数和提示文本。
import { produceArtifactSet } from "./package-artifacts.mjs";

// 打印帮助；纯文本输出到 stdout，调用方紧接着以退出码 0 结束。
function printUsage() {
	console.log(`Usage: node scripts/pack-packages.mjs --out <dir> [options]

Builds every public package and writes one coherent local artifact set.

Options:
  --out <dir>            Output directory; .artifacts/ is ignored by Git
  --force                Replace an existing output directory
  --offline-model-data   Build with already-hydrated model data
  --skip-build           Pack existing build output without rebuilding
  --help                 Show this help
`);
}

// parseArgs 只做语法解析；布尔选项自动得到 false，字符串选项缺省为 undefined。
const { values } = parseArgs({
	options: {
		force: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
		"offline-model-data": { type: "boolean", default: false },
		// out 没有 default，因此缺失时是 undefined，下面单独报错。
		out: { type: "string" },
		"skip-build": { type: "boolean", default: false },
	},
});
// help 优先于其他校验：用户可能只想知道用法。
if (values.help) {
	printUsage();
	process.exit(0);
}
// 明确要求 --out，避免默认往仓库里写文件；输出目录的安全限制由 produceArtifactSet 再做。
if (!values.out) throw new Error("--out is required");

// build 取反 skip-build：默认重新构建，只有显式跳过才复用 dist。
// repoRoot 取当前工作目录，意味着必须在仓库根运行；produceArtifactSet 会再解析绝对路径。
const artifactSet = produceArtifactSet({
	build: !values["skip-build"],
	force: values.force,
	offlineModelData: values["offline-model-data"],
	outDir: values.out,
	repoRoot: process.cwd(),
});
// 打印结果：artifactDirectory 是绝对路径，manifestPath 指向可直接被 use-local-packages 读取的文件。
console.log(`\nLocal package artifacts created: ${artifactSet.artifactDirectory}`);
console.log(`Manifest: ${artifactSet.manifestPath}`);
console.log("\nConnect an external npm project with:");
// resolve 把相对脚本路径转成绝对路径，提示命令在任何 cwd 下都可用；<project>/<name> 是需要用户替换的占位符。
console.log(
	`  node ${resolve("scripts/use-local-packages.mjs")} --manifest ${artifactSet.manifestPath} --consumer <project> --package <name>`,
);
