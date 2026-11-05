#!/usr/bin/env node
// 文件导读
// 所属：仓库根 scripts/ 的公开包安装验证，npm run check:package-install 的实现；不在默认 npm run check 中。
// 职责：把当前工作区已构建的包 npm pack 成 tarball，为每个公开包创建独立的临时消费者，真实 npm install，
//   再启动 Node 导入根入口；coding-agent 额外检查公开 SDK 导出和两个 CLI 的 --version。
// 上游：根 package.json → node scripts/check-package-install.mjs。下游：package-artifacts.mjs（打制品）、
//   local-package-install.mjs（写消费者并安装）、coding-agent-smoke.mjs（SDK/CLI 冒烟）。
// 输入：无参数；必须先用 npm run build 产出 dist。输出：成功打印验证的包数量，失败抛错并以非零码退出。
// 副作用与风险：在系统临时目录执行 npm pack/install，可能访问 registry 解析传递依赖；不修改仓库文件，
//   结束时递归删除临时根。它比只读检查重得多，不能当静态检查反复跑。
// 覆盖边界：只核对入口文件、本地制品版本和根导入，不等于验证所有通配符导出或全部功能。
// 示例：npm run build && npm run check:package-install
// 建议阅读顺序：先看 produceArtifactSet 的输入，再看每个包的 installConsumer/smokeTestNpmConsumer 循环，最后看 cleanup。
//
// 安装验证入口。例如一个公开包漏声明依赖时，独立消费者导入可能失败；脚本会真实打包/安装，不能当只读检查运行。

// mkdtempSync 生成不可预测的临时目录名；rmSync 在 finally 中清理。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// 消费者安装/冒烟助手：installConsumer 写 package.json 并执行安装，smokeTestNpmConsumer 导入根入口。
import { installConsumer, packageConsumerDirectoryName, smokeTestNpmConsumer } from "./local-package-install.mjs";
// 制品集：从现有构建输出 npm pack 每个公开包，并记录版本/依赖。
import { produceArtifactSet } from "./package-artifacts.mjs";
// coding-agent 有额外的 SDK/CLI 冒烟路径，单独处理。
import { codingAgentName, smokeTestCodingAgent } from "./coding-agent-smoke.mjs";

// 建立随机临时根目录隔离制品和消费者；只是临时路径，不是操作系统沙箱。
const root = mkdtempSync(join(tmpdir(), "pi-package-install-"));
// 正常验证与失败共用 finally 清理；任一步骤异常都会向调用者传播。
try {
	// 从当前仓库既有构建输出 npm pack 制品，不重新 build；因此使用前须先构建，仍会产生 tarball。
	const artifactSet = produceArtifactSet({ build: false, outDir: join(root, "artifacts"), repoRoot: process.cwd() });
	// 逐个公开包创建独立消费者，避免其他工作区包偶然掩盖遗漏依赖。
	for (const pkg of artifactSet.packages) {
		// 将 @scope/name 变成目录名，放在该临时根下。
		const directory = join(root, "consumers", packageConsumerDirectoryName(pkg.name));
		// 写消费者 package.json 并真实执行 npm install --ignore-scripts；传递依赖仍可能访问 registry。
		installConsumer({ artifactSet, directory, packageNames: [pkg.name] });
		// 核对入口文件/本地制品解析并启动 Node 导入根包；不等同检查全部通配符导出。
		smokeTestNpmConsumer({ artifactSet, directory, packageName: pkg.name });
		// coding-agent 另外检查公开 SDK 导出和两个 CLI 版本入口，使用临时 HOME/offline 设置。
		if (pkg.name === codingAgentName) smokeTestCodingAgent(directory);
	}
	// 只有全部消费者通过才报告数量，不能据此推出每个包所有功能均可用。
	console.log(`Verified ${artifactSet.packages.length} isolated package consumers.`);
} finally {
	// 无论成功或抛错都递归删除本次临时根；清理自身失败仍可抛错。
	rmSync(root, { force: true, recursive: true });
}
