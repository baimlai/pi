// 把 Durable 的环境契约测试分别注册到 RemoteExecutionEnv 与 LocalExecutionEnv，本机 daemon 是必要前置条件。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, describe, expect, it } from "vitest";
import { Connection } from "../src/connection.ts";
import { LocalExecutionEnv } from "../src/list-files.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";
import { daemon } from "./daemon.ts";

// 创建共享惰性连接；首次请求才启动本机 daemon，虽然名为 Remote，传输只是本机 pipe。
const connection = new Connection({ command: [daemon] });
// 所有一致性测试后关闭共享连接，回调返回 void；测试临时目录由各用例的 finally 处理。
afterAll(() => connection.close());

// 布尔值记录当前 Node 平台，用来选择测试 shell 和是否测试原生符号链接。
const windows = process.platform === "win32";
// Windows 使用 Git Bash 执行 shell 例子；?? 只对未设置 ProgramFiles 使用默认目录，不探测文件存在。
const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");

// 向 Durable 共用测试注册器提供测试 API、名称和环境工厂；注册本身不等于每项断言已运行。
registerEnvConformance(
	// 把 Vitest 的三个入口交给独立于测试框架的共用测试代码。
	{ describe, expect, it },
	"RemoteExecutionEnv over a pipe",
	// 环境工厂接 use 回调，创建临时 cwd 后 await 测试主体，finally 删除目录；返回 Promise<void>，例如一次文件读写在隔离 cwd 内完成。
	async (use) => {
		// mkdtempSync 在系统临时目录创建唯一目录；这里只隔离工作目录，不构成进程权限沙箱。
		const cwd = mkdtempSync(join(tmpdir(), "pi-env-conformance-"));
		// 把测试主体放入 try，正常完成或抛错都进入下面 finally。
		try {
			// 交付经 pipe 操作 daemon 的环境；watch 降级轮询间隔为 100ms，await 等本组用例结束。
			await use(new RemoteExecutionEnv({ connection, id: "pi-env:test", cwd, watch: { pollIntervalMs: 100 } }));
			// 即使用例失败也删除自己创建的 cwd，不吞掉测试异常。
		} finally {
			// On Windows a killed command's processes can hold the directory for a moment.
			// 递归强制删除，失败最多重试 50 次、间隔 100ms，照顾 Windows 进程刚退出仍占用目录的情况。
			rmSync(cwd, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
		}
	},
	// Git Bash's `ln -s` copies instead of linking unless native symlinks are enabled.
	// Windows 换 Git Bash 且跳过符号链接约定；所有平台启用 listFiles 契约测试，这不是对系统能力的动态证明。
	windows ? { shell: [gitBash, "-c"], symlinks: false, listFiles: true } : { listFiles: true },
);

// 向 Durable 共用测试注册器提供测试 API、名称和环境工厂；注册本身不等于每项断言已运行。
registerEnvConformance(
	// 把 Vitest 的三个入口交给独立于测试框架的共用测试代码。
	{ describe, expect, it },
	"LocalExecutionEnv",
	// 环境工厂接 use 回调，创建临时 cwd 后 await 测试主体，finally 删除目录；返回 Promise<void>，例如一次文件读写在隔离 cwd 内完成。
	async (use) => {
		// mkdtempSync 在系统临时目录创建唯一目录；这里只隔离工作目录，不构成进程权限沙箱。
		const cwd = mkdtempSync(join(tmpdir(), "pi-env-local-conformance-"));
		// 把测试主体放入 try，正常完成或抛错都进入下面 finally。
		try {
			// 交付在 NodeExecutionEnv 基础上增加 daemon listFiles/watch 的本地环境；共用 connection 不代表所有文件 API 都远程执行。
			await use(new LocalExecutionEnv({ connection, cwd, watch: { pollIntervalMs: 100 } }));
			// 即使用例失败也删除自己创建的 cwd，不吞掉测试异常。
		} finally {
			// 递归强制删除，失败最多重试 50 次、间隔 100ms，照顾 Windows 进程刚退出仍占用目录的情况。
			rmSync(cwd, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
		}
	},
	// Windows 换 Git Bash 且跳过符号链接约定；所有平台启用 listFiles 契约测试，这不是对系统能力的动态证明。
	windows ? { shell: [gitBash, "-c"], symlinks: false, listFiles: true } : { listFiles: true },
);
