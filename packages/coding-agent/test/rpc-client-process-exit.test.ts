// 启动一个自己生成的本地 Node 脚本，检查 RPC 请求等待期间子进程退出会拒绝 Promise；不启动模型或真实 CLI。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

// string[]记录本文件创建的目录，清理钩子会移除它们；const 只固定数组引用。
const tempDirs: string[] = [];

// 输入完整脚本文字，写到唯一临时目录并返回路径；文件系统错误直接抛出。例如写入退出码43的脚本，不在此执行。
function writeChildScript(contents: string): string {
	// mkdtempSync 在前缀后加随机部分，避免并行测试目录冲突。
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-exit-"));
	// 先登记目录，后面的写入失败时 afterEach 仍可清理已建目录。
	tempDirs.push(dir);
	// .mjs让 Node 将夹具作为 ES 模块执行。
	const path = join(dir, "child.mjs");
	// 同步写下原样脚本内容，不对模板正文插入注释。
	writeFileSync(path, contents);
	// 返回磁盘路径，交 RpcClient 的 cliPath 使用。
	return path;
}

// 每例后取走当前登记的目录并删除；splice(0)同时清空数组，清理异常仍会使测试失败。
afterEach(() => {
	// for...of迭代 splice 返回的旧目录列表。
	for (const dir of tempDirs.splice(0)) {
		// recursive 删除子文件，force 容忍目标已经不存在。
		rmSync(dir, { recursive: true, force: true });
	}
});

// 登记进程故障这一机制的用例。
describe("RpcClient child process failures", () => {
	// 无输入；启动假CLI，发送 get_commands 等待响应，并期待退出码43。只验证等待中请求失败，不检查所有事件等待器或进程重启。
	test("rejects an in-flight request when the child process exits", async () => {
		// cliPath 覆盖默认入口；模板脚本收到首块 stdin 数据才 exit(43)，resume 让流持续读取。
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => {
	process.exit(43);
});
process.stdin.resume();
`),
		});

		// start 启动 Node 并等待短暂初始化；这里无网络、模型或认证。
		await client.start();

		// rejects 等待 Promise 拒绝；正则同时检查错误包含 code=43 和无信号。子脚本已自行退出，测试未调用 stop。
		await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
	});
});
