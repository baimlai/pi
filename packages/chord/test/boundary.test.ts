// 静态扫描 Chord 的包依赖和源码导入，防止可复用底层库反向依赖 Pi 上层包。
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// import.meta.url 是当前测试模块的文件 URL；转成本地路径后向上一级得到包根目录。
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 只扫描本包 src；测试、文档和外部 node_modules 不在本用例的检查范围。
const sourceDirectory = resolve(packageDirectory, "src");
// 捕获静态 import/export 的字符串来源；g 表示寻找所有匹配，u 启用 Unicode 正则语义。
// 这是文本检查而非 TypeScript 解析器，例如注释内长得像导入的文字也可能匹配。
const IMPORT_SPECIFIER = /(?:import|export)\s+(?:type\s+)?(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/gu;

// describe 回调只注册测试；例子：引入 pi-ai 应让下面的 violations 非空，从而使测试失败。
describe("package boundary", () => {
	// The allowed Pi packages are leaves without dependencies: pi-telemetry for Context.telemetry, pi-schema for schemas
	// (decision "A schema package beneath pi-ai and Chord").
	// Set 用名称精确查找两个允许的底层包；子路径稍后会先还原为包名。
	const ALLOWED = new Set(["@earendil-works/pi-telemetry", "@earendil-works/pi-schema"]);

	// 无测试参数；异步读取清单和全部 .ts 源文件，最后断言没有违规项，不改任何文件。
	// 例如 ../other.ts 解析到 src 外会被记录；测试不检查动态 import 或非 .ts 文件。
	test("does not depend on Pi packages other than pi-telemetry and pi-schema, or on files outside Chord", async () => {
		// JSON.parse 在运行时解析文本；as 只告诉 TS 所需字段的类型，不校验清单结构。
		const manifest = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		};
		// 缺省 dependencies 当作空对象；仅挑出 Pi 命名空间内且不在白名单中的直接依赖。
		expect(
			Object.keys(manifest.dependencies ?? {}).filter(
				(name) => name.startsWith("@earendil-works/pi-") && !ALLOWED.has(name),
			),
		).toEqual([]);

		// recursive 枚举子目录；filter 只留 TypeScript，sort 使错误报告顺序稳定。
		const paths = (await readdir(sourceDirectory, { recursive: true })).filter((path) => path.endsWith(".ts")).sort();
		// string[] 是编译期数组元素约束，后面逐条累积可读的“文件: 导入来源”。
		const violations: string[] = [];
		// 顺序读每个源文件；读取失败会让测试直接拒绝，而不会被当成没有违规。
		for (const path of paths) {
			// path 是相对 src 的路径，file 是传给文件系统的绝对路径。
			const file = resolve(sourceDirectory, path);
			// utf8 让 readFile 返回字符串，而非 Buffer。
			const source = await readFile(file, "utf8");
			// matchAll 逐个返回捕获组；同一文件有多个静态导入时都会检查。
			for (const match of source.matchAll(IMPORT_SPECIFIER)) {
				// [1] 取首个捕获组；! 仅消除 TS 的 undefined 推断，匹配规则保证有这组。
				const specifier = match[1]!;
				// 例如 @earendil-works/pi-schema/foo 截为 @earendil-works/pi-schema。
				const pkg = specifier.split("/").slice(0, 2).join("/");
				// Pi 包的子路径也按所属包查白名单；不相关第三方包不被这一规则拒绝。
				if (specifier.startsWith("@earendil-works/pi-") && !ALLOWED.has(pkg))
					violations.push(`${path}: ${specifier}`);
				// 相对导入从当前文件目录解析；用末尾 / 防止把 src-other 误当 src 内。
				if (specifier.startsWith(".") && !resolve(dirname(file), specifier).startsWith(`${sourceDirectory}/`)) {
					// 只记录，不立即抛错，因此最终一次展示所有命中的相对越界导入。
					violations.push(`${path}: ${specifier}`);
				}
			}
		}
		// 空数组表示当前扫描未发现违规，并不证明任意运行时加载都遵守这个边界。
		expect(violations).toEqual([]);
	});
});
