import { expect, test, vi } from "vitest";
import { createCodemodeExtension } from "../src/codemode/codemode.ts";

// The extension runs scripts in the sandbox the host passes, so loading it must not load the WASM VM (#11254).
// 给 quickjs-wasi 设置会立即抛错的模块工厂；Vitest 会提升 mock 注册，先于静态导入生效。
// 若加载扩展间接求值此模块，测试收集阶段即失败；只测此导入路径，没有启动沙箱。
vi.mock("quickjs-wasi", () => {
	// 这条故意的错误是警报，不是期望在测试体里捕获的错误。
	throw new Error("the Code Mode extension loaded quickjs-wasi");
});

// 验证导入得到函数；例如静态加载 createCodemodeExtension 时不应加载 WASM VM（#11254）。
// 回调同步结束，无业务输入/外部副作用；没有实际调用扩展或执行脚本。
test("the Code Mode extension loads without pi-codemode's WASM runtime", () => {
	// 运行时只断言 typeof 为 function；配合上方抛错 mock 检查模块加载边界。
	expect(createCodemodeExtension).toBeTypeOf("function");
});
