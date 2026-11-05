// 文件导读
// 所属：仓库根 scripts/ 的 coding-agent 安装冒烟助手，被 check-package-install.mjs 和 coding-agent-smoke.test.mjs 复用。
// 职责：在一个已安装 coding-agent 的消费者目录里，(1) 用 Node 导入公开 SDK 并检查三个符号，(2) 运行 manifest.bin.pi
//   与 dist/cli.js 的 --version 并核对版本。它专门防止“CLI 能跑但公开 SDK 因漏声明依赖而导入失败”（#9132）。
// 上游：node scripts/check-package-install.mjs；测试命令 node --test scripts/coding-agent-smoke.test.mjs。
// 下游：读取已安装包的 package.json，写临时 ESM 入口并用 runtime（默认当前 Node）执行；会调用两个 CLI 入口。
// 输入：directory（消费者安装目录）与可选 runtime 可执行文件路径。输出：成功打印一行；失败抛错/非零退出。
// 副作用：在系统临时目录创建 HOME 与入口脚本，运行结束后删除；子进程环境只保留 PATH、HOME 等最小集合，
//   并设置 PI_OFFLINE=1、PI_TELEMETRY=0，避免访问网络或写用户真实配置。
// 超时：SDK 导入与每个 CLI 调用各自最多 30 秒。
// 示例：
//   import { codingAgentName, smokeTestCodingAgent } from "./coding-agent-smoke.mjs";
//   smokeTestCodingAgent("/tmp/consumer"); // 已通过 installConsumer 安装 codingAgentName
// 建议阅读顺序：先看导出的包名常量，再看环境构造，最后看 SDK 入口与 CLI 版本循环。
//
// 子进程同步执行，失败会抛错；stdio 的 stdout/stderr 用管道，错误输出会进入异常消息。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 被测包的 scoped 名称；调用方用它定位 node_modules/<scope>/<name>。
export const codingAgentName = "@earendil-works/pi-coding-agent";

// 输入：directory 为消费者根目录，runtime 为执行 Node 的可执行文件（测试可传入包装器）。
// 输出：无；全部断言/版本检查通过时打印一行。错误：导入失败、断言失败、CLI 非零退出、版本不匹配或超时都会抛出。
// 主要流程：读安装包清单 → 建隔离 HOME 与环境 → 写临时 SDK 入口并执行 → 对两个 CLI 入口跑 --version → 清理。
export function smokeTestCodingAgent(directory, runtime = process.execPath) {
	// join 会正确处理 scope 中的斜杠：node_modules/@earendil-works/pi-coding-agent。
	const packageDir = join(directory, "node_modules", codingAgentName);
	// 安装包清单是运行时输入边界；版本与 bin 映射都以它为准。
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	// 独立的临时 HOME，防止测试读取或写入当前用户真实的 ~/.pi 配置。
	const home = mkdtempSync(join(tmpdir(), "pi-coding-agent-smoke-home-"));
	// 临时入口放在消费者目录内，这样 ESM 能沿该目录解析 node_modules 中的包。
	const entry = join(directory, "coding-agent-smoke.mjs");
	// 只传最小环境变量：PATH 用于定位可执行文件，各 HOME/CACHE 变量覆盖 Unix 与 Windows 的配置位置。
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		APPDATA: home,
		LOCALAPPDATA: home,
		XDG_CONFIG_HOME: home,
		XDG_CACHE_HOME: home,
		PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
	};
	// Windows 子进程仍需要 SystemRoot/COMSPEC 等系统变量；存在时才复制，Unix 上不会多出空值。
	for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
		if (process.env[name]) env[name] = process.env[name];
	}
	try {
		// 生成的 ESM 脚本只用 assert 检查导出形状；字符串内的包名由常量插值。
		writeFileSync(entry, `import assert from "node:assert/strict";
import { createAgentSession, SessionManager, ModelRuntime } from "${codingAgentName}";
assert.equal(typeof createAgentSession, "function");
assert.equal(typeof SessionManager.inMemory, "function");
assert.equal(typeof ModelRuntime.create, "function");
`);
		// 执行 SDK 入口：若包漏声明依赖，Node 在这里报 Cannot find package，而不是等用户使用某个 API 才失败。
		execFileSync(runtime, [entry], { cwd: directory, env, stdio: ["inherit", "pipe", "pipe"], timeout: 30_000 });
		// 两个入口都检查：清单声明的 bin 和实际发布的 dist/cli.js，避免 manifest 指向的包装脚本掩盖真实入口问题。
		for (const cli of new Set([manifest.bin.pi, "dist/cli.js"])) {
			const output = execFileSync(runtime, [join(packageDir, cli), "--version"], {
				cwd: directory,
				encoding: "utf8",
				env,
				stdio: ["inherit", "pipe", "pipe"],
				timeout: 30_000,
			});
			// trim 去掉末尾换行；与安装包版本完全相等才算通过。
			if (output.trim() !== manifest.version) throw new Error(`Unexpected version from ${cli}: ${output}`);
		}
	} finally {
		// 临时入口与 HOME 在成功和失败时都删除；home 目录递归删除。
		rmSync(entry, { force: true });
		rmSync(home, { recursive: true, force: true });
	}
	console.log(`Coding-agent policy smoke tests passed (${runtime}).`);
}
