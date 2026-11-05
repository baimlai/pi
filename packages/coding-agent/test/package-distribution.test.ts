// 读取仓库 package.json 的入口字段作静态回归检查，不加载入口或证明 dist 已构建。
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// interface 只描述本例读取的字段，JSON.parse 后的 as 断言不会运行时校验清单。
interface CodingAgentPackageJson {
	// bin.pi 是 CLI 文件，main 是库默认入口，exports 控制模块导入的子路径。
	bin: { pi: string };
	main: string;
	exports: {
		// 带引号的 . 和 ./rpc-entry 是字面属性名，可用下标读取。
		".": { import: string; types: string };
		"./rpc-entry": { import: string };
	};
}

// 模块加载时同步读取并解析清单；文件或 JSON 错误会使测试模块直接失败。
const packageJson = JSON.parse(
	// import.meta.url 指当前测试文件 URL；new URL 按它解析相邻 package.json。
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as CodingAgentPackageJson;

// as 仅告诉 TS 按上面形状访问，不转换或检查实际 JSON 内容。

describe("package distribution entrypoints", () => {
	// 注册入口字段测试；describe/ test 的无参箭头回调由 Vitest 调用。
	test("uses the bundle for executables and modular output for libraries", () => {
		// 例：CLI 指向 bundle，库指向模块输出；只比较配置字符串，不执行这些文件。
		expect(packageJson.bin.pi).toBe("dist/bundle/cli.js");
		// 要求可执行命令 pi 的路径是构建后的 CLI bundle。
		expect(packageJson.main).toBe("./dist/index.js");
		// 要求旧式 main 字段指向模块化库入口。
		expect(packageJson.exports["."].import).toBe("./dist/index.js");
		// 通过 exports 的根路径导入也必须走模块化入口。
		expect(packageJson.exports["./rpc-entry"].import).toBe("./dist/bundle/rpc-entry.js");
		// RPC 子路径应导向独立 RPC bundle，未断言 types 字段。
	});
});
