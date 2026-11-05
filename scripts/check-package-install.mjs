#!/usr/bin/env node
// 安装验证入口。例如一个公开包漏声明依赖时，独立消费者导入可能失败；脚本会真实打包/安装，不能当只读检查运行。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installConsumer, packageConsumerDirectoryName, smokeTestNpmConsumer } from "./local-package-install.mjs";
import { produceArtifactSet } from "./package-artifacts.mjs";
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
