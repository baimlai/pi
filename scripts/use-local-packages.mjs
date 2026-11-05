#!/usr/bin/env node

// 文件导读：把某个外部消费项目的 package.json 指向本地打包产物（tarball），用于离线验证发布包。
// 所属：仓库根 scripts/，通常由 `scripts/pack-packages.mjs` 在输出 artifact manifest 后打印这条命令。
// 作用：读取 artifact set 的 manifest（由 package-artifacts.mjs 生成），把消费者项目里指定的 Pi 包及其已声明的
//   传递 Pi 包改成 `file:./...tgz` 本地依赖；只改消费项目的 package.json，不安装依赖、不联网。
// 上游：`node scripts/use-local-packages.mjs --manifest <path> --consumer <dir> --package <name> [--package <name> ...]
//   [--package-manager npm|pnpm]`；--help 打印用法并以 0 退出。
// 下游：readArtifactSet 读取并校验 tarball 与 integrity；wireConsumer 改写 package.json（保留缩进风格）。
// 副作用与失败状态：写消费项目的 package.json；不运行 npm/pnpm 安装，最后提示用户手动执行
//   `<pm> install --ignore-scripts`。参数缺失、manifest/tarball 无效、消费者缺少 package.json 时抛错，退出码 1。
// 幂等性：重复运行会把相同的 file: 说明符再写一次；wireConsumer 可能重写文件，但不改变语义。
// 能力清单：
//   - printUsage：输出完整用法与默认包管理器说明。
//   - 顶层流程：parseArgs → 必填校验 → readArtifactSet → wireConsumer → 打印后续安装命令。
// 典型调用（示例，路径按实际 artifact 目录替换）：
//   node scripts/use-local-packages.mjs --manifest .artifacts/packages/manifest.json \
//     --consumer ../my-app --package @earendil-works/pi-coding-agent
//   预期输出两行：Updated <consumer>/package.json ... 和 Run npm install --ignore-scripts ...。
// 阅读顺序：先看 parseArgs 选项定义与校验，再看两个调用的输入输出约定。
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { wireConsumer } from "./local-package-install.mjs";
import { readArtifactSet } from "./package-artifacts.mjs";

// 打印用法；不读取环境变量，也不检查参数。真实调用时由 --help 分支以退出码 0 结束。
function printUsage() {
	console.log(`Usage: node scripts/use-local-packages.mjs --manifest <path> --consumer <dir> --package <name> [--package <name> ...] [--package-manager npm|pnpm]

Updates an external project's package configuration to use direct packages and
all transitive Pi packages from a local package artifact set. Defaults to npm.
`);
}

// node:util 的 parseArgs 把 --flag value 解析为 values；multiple 允许 --package 重复。
const { values } = parseArgs({
	options: {
		// 消费项目目录（相对于调用者 cwd，后面 resolve 成绝对路径）。
		consumer: { type: "string" },
		// 布尔开关；默认 false，出现即 true。
		help: { type: "boolean", default: false },
		// artifact set 的 manifest.json 路径。
		manifest: { type: "string" },
		// 可重复的直接依赖名；默认空数组，因此必须显式提供。
		package: { type: "string", multiple: true, default: [] },
		// 只影响之后打印的安装命令与 wireConsumer 的说明符格式；不影响本脚本安装。
		"package-manager": { type: "string", default: "npm" },
	},
});
if (values.help) {
	// 帮助是成功路径，显式以 0 退出。
	printUsage();
	process.exit(0);
}
// 必填项在运行时校验；缺少时在顶层抛错，Node 打印堆栈并以 1 退出。
if (!values.manifest) throw new Error("--manifest is required");
if (!values.consumer) throw new Error("--consumer is required");
if (values.package.length === 0) throw new Error("At least one --package is required");
// 只支持两种包管理器；其他值没有对应的安装命令提示。
if (values["package-manager"] !== "npm" && values["package-manager"] !== "pnpm") {
	throw new Error(`Unsupported package manager: ${values["package-manager"]}`);
}

// manifest 是外部输入：readArtifactSet 会校验 tarball 存在且 integrity 匹配，不满足就抛错。
const artifactSet = readArtifactSet(resolve(values.manifest));
const consumerDirectory = resolve(values.consumer);
// wireConsumer 写消费者的 package.json：直接包与已声明的传递 Pi 包都会指向本地 tarball。
wireConsumer({ artifactSet, consumerDirectory, packageManager: values["package-manager"], packageNames: values.package });

// 打印实际写入的文件与 manifest 来源，便于确认没有改错项目。
console.log(`Updated ${consumerDirectory}/package.json from ${artifactSet.manifestPath}`);
// 脚本不自动安装；提示用户手动运行并禁用生命周期脚本。
console.log(`Run ${values["package-manager"]} install --ignore-scripts in the consumer project.`);
