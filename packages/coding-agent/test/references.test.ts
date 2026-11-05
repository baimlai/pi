// 将源码 schema 在内存渲染出的参考文档与已提交文件逐字比较；此测试只读，不运行生成器写盘入口。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderReferences } from "../scripts/generate-references.ts";

// describe回调登记文档同步性检查。
describe("generated reference pages", () => {
	// Regression for #10790: models.json fields lost their reference documentation.
	// 无输入；取得 path→Markdown 映射，检查文件集合并逐项读取比较。例如 schema 字段说明改变而文档未再生成时失败；读盘错误直接失败。
	it("matches the committed pages", () => {
		// renderReferences只构造ReadonlyMap；readonly是类型约束，不运行Object.freeze。
		const rendered = renderReferences();
		// ...把键迭代器展开成数组；目前只应生成这一张页面，顺序也参与比较。
		expect([...rendered.keys()]).toEqual(["docs/models-configuration.md"]);
		// 数组解构分别取得相对路径和期望正文。
		for (const [relativePath, expected] of rendered) {
			// expect的第二参数仅作失败提示；toBe比较完整字符串，包含空白与末尾换行。
			expect(
				// import.meta.url定位本测试模块；URL按模块位置解析，而不是依赖进程cwd。
				readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf-8"),
				// 这里的npm命令只是提示文字，测试不会执行它。
				`${relativePath} is stale; run npm run generate:references`,
			).toBe(expected);
		}
	});
});
