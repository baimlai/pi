// 核对三种发布模式的 worker 入口选择；只构造字符串或 URL，不启动 worker。
import { describe, expect, test } from "vitest";
import { resolveCodemodeWorkerSpecifier } from "../src/config.ts";

// 运行时参数是字面量联合类型，以下测试各覆盖一个受支持分支，不尝试无效枚举值。
describe("resolveCodemodeWorkerSpecifier", () => {
	// Regression test for #10204.
	// 输入 Bun 的虚拟 Windows 模块地址，期望源码相对入口；返回字符串可避免绝对虚拟 URL 映射问题。
	test("uses a relative source entrypoint in Bun binaries", () => {
		// 这个分支不读取传入 URL 的文件，也不验证 Bun 打包器能实际启动它。
		expect(resolveCodemodeWorkerSpecifier("bun-binary", "file:///B:/~BUN/root/config.js")).toBe(
			"./src/extensions/codemode/worker.ts",
		);
	});

	// 输入 Node bundle 模块地址，返回同一目录下编译后的 worker URL。
	test("uses the emitted worker beside the bundled Node module", () => {
		// toEqual 比较 URL 值；new URL 只解析文字，不访问 /app 文件系统。
		expect(resolveCodemodeWorkerSpecifier("bundled-node", "file:///app/chunks/config.js")).toEqual(
			new URL("file:///app/chunks/codemode-worker.js"),
		);
	});

	// 普通未打包模式返回 undefined，由调用方沿用依赖包默认 worker；本例不验证依赖默认行为。
	test("uses the pi-codemode worker when unbundled", () => {
		// import.meta.url 是当前测试模块 URL，此分支实际不使用该基址。
		expect(resolveCodemodeWorkerSpecifier("unbundled", import.meta.url)).toBeUndefined();
	});
});
