// 验证 max 思考等级与旧主题回退，只用内存设置和自建临时主题，不调用模型。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isValidThinkingLevel } from "../src/cli/args.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { loadThemeFromPath } from "../src/modes/interactive/theme/theme.ts";

// string[] 保存本文件创建的临时目录，供每例结束清理。
const tempDirs: string[] = [];

// afterEach 在用例成功或失败后运行；只删除登记的测试目录，没有返回业务数据。
afterEach(() => {
	// splice(0) 取走全部项并清空原数组，for...of 逐目录清理。
	for (const dir of tempDirs.splice(0)) {
		// recursive 删除子文件，force 允许目录不存在；其他删除错误仍会向测试器传播。
		rmSync(dir, { recursive: true, force: true });
	}
});

// 把 max 相关 CLI/设置与主题行为归为一个测试组。
describe("max thinking level", () => {
	// 例：把默认等级设 max 后可原样读取；async 回调等待设置队列，不涉及持久文件。
	it("is accepted by CLI and settings", async () => {
		// isValidThinkingLevel 真正运行字符串成员判断；本例只证明 max 被接受。
		expect(isValidThinkingLevel("max")).toBe(true);

		// 工厂创建内存设置后端，避免读写真实用户设置。
		const settings = SettingsManager.inMemory();
		// setter 更新内存有效设置并排队保存到内存存储。
		settings.setDefaultThinkingLevel("max");
		// flush 等待先前排队写入，不额外发起保存，也不检查 drainErrors。
		await settings.flush();
		// 读取到 max 才通过，不验证每个模型都支持这个等级。
		expect(settings.getDefaultThinkingLevel()).toBe("max");
	});

	// 例：删旧主题的 thinkingMax 后，max 和 xhigh 对相同文字生成相同样式；写入仅在自建 tmp。
	it("falls back to thinkingXhigh for legacy themes", () => {
		// mkdtempSync 在系统临时根下创建唯一目录，返回真实路径。
		const testDir = mkdtempSync(join(tmpdir(), "pi-max-theme-"));
		// 先登记路径，后续读取/断言失败也能由 afterEach 清理。
		tempDirs.push(testDir);
		// 把当前 ESM 文件 URL 转本机路径，再取其目录以定位内置 dark.json。
		const currentDir = dirname(fileURLToPath(import.meta.url));
		// 读取并解析完整暗色主题作为测试副本；as 只声明期望形状，不做运行时 schema 校验。
		const darkTheme = JSON.parse(
			// readFileSync 用 utf8 返回文字而非 Buffer，join 组合测试文件的相对位置。
			readFileSync(join(currentDir, "../src/modes/interactive/theme/dark.json"), "utf8"),
		) as { name: string; colors: Record<string, unknown> };
		// 修改解析出的新对象名称，不改仓库原始 JSON。
		darkTheme.name = "legacy-theme";
		// delete 删除可选颜色槽，模拟尚无 max 专用颜色的旧主题。
		delete darkTheme.colors.thinkingMax;
		// 只在本例临时目录中设置新主题文件名。
		const themePath = join(testDir, "legacy-theme.json");
		// 序列化修改后的对象并同步写临时文件，读取/写入错误会让测试失败。
		writeFileSync(themePath, JSON.stringify(darkTheme));

		// 真实主题加载器读取该临时 JSON、解析颜色并应用 token 回退；不启动主题监视器。
		const legacyTheme = loadThemeFromPath(themePath);
		// getThinkingBorderColor 返回着色函数，再对 border 调用；比较最终样式串。
		expect(legacyTheme.getThinkingBorderColor("max")("border")).toBe(
			// xhigh 的同一段文字作为期望；没有直接断言色值或所有主题模式。
			legacyTheme.getThinkingBorderColor("xhigh")("border"),
		);
	});
});
