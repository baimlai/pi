import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { createHost } from "../../src/old/index.ts";

// 注册 Node 加载器集成测试：真正的 resolve hook 由独立进程运行，另验证没有配置加载器时的错误。
describe("node loader", () => {
	// 启动 fixtures/loader.ts 跑真实模块加载/重载断言，无业务返回值；输出和退出码用来判断子进程是否成功。
	it("loads facet modules and reloads them with fresh copies of their relative imports", () => {
		// 同步启动当前 Node 可执行文件，URL 转本地路径；不经 shell，不拼接命令字符串。
		const child = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/loader.ts", import.meta.url))], {
			// 将标准输出与标准错误解码为 UTF-8 字符串，供失败消息显示。
			encoding: "utf8",
			// 子进程最多运行 30 秒；该超时限制子进程，不代表加载器自身的就绪超时。
			timeout: 30_000,
		});
		// 启动失败或超时等 spawn 错误必须不存在；断言消息带 stderr。
		assert.equal(child.error, undefined, child.stderr);
		// 子进程退出码必须为 0；失败时同时显示 stdout 和 stderr，便于定位夹具断言。
		assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
	});

	// 构造未配置 loader 的主机，尝试按模块路径 load，验证清晰拒绝而不是静默跳过。
	it("needs a configured loader for modules", async () => {
		// 只创建内存主机；没有注入 nodeLoader，空 onError 在本测试忽略报告。
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		// 正则匹配拒绝错误里的配置提示；这个用例没有真的读取 ./facet.ts。
		await assert.rejects(host.load(["./facet.ts"]), /createHost\(\{ loader \}\)/);
	});
});
