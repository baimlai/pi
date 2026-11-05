import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	setRegisteredThemes,
} from "../src/modes/interactive/theme/theme.ts";

// 测试所用 JSON 的静态外形；Record 表示任意字符串键映射到颜色串或索引，vars? 可缺省。
// JSON.parse 后的 as 只告诉 TypeScript 按此类型使用，不执行 schema 校验；实际加载主题时另有校验。
type ThemeFile = {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
};

// 登记主题名称枚举测试；只在自建临时目录读写 JSON，不连接终端。
describe("theme picker", () => {
	// beforeEach 赋值后供测试与 afterEach 共用；: string 是静态类型标注。
	let tempRoot: string;

	// 每例创建独立主题根并清空注册表，返回 void；例如 foo.json 只写到本次 mkdtemp 目录。
	beforeEach(() => {
		// 系统临时目录下生成唯一目录，避免改写用户主题文件。
		tempRoot = mkdtempSync(join(tmpdir(), "pi-theme-picker-"));
		// 组合本次隔离的 agent 配置目录。
		const agentDir = join(tempRoot, "agent");
		// 配置 helper 会读取这个环境变量，从而把主题枚举指向临时根。
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		// recursive 允许顺带建立 agent 父目录。
		mkdirSync(join(agentDir, "themes"), { recursive: true });
		// 排除扩展已注册主题造成的同名结果；该操作会修改全局 Map。
		setRegisteredThemes([]);
	});

	// 每例后清理注册表、临时文件和 stub 环境；同步删除失败会使清理失败。
	afterEach(() => {
		// 清空本测试可能使用的主题注册状态，不恢复任意旧注册列表。
		setRegisteredThemes([]);
		// 递归删除自己创建的根，force 允许路径已经不存在。
		rmSync(tempRoot, { recursive: true, force: true });
		// 恢复 vi.stubEnv 记录的原环境变量。
		vi.unstubAllEnvs();
	});

	// 读内置 dark 作为有效模板，把内容名改成 bar 却存为 foo.json；期待列表按内容名出现。
	// 无参数、无返回；只有本地 JSON I/O，不启动主题监听或渲染完整选择器。
	it("uses custom theme content names instead of file names", () => {
		// import.meta.url 定位测试文件；new URL 的相对路径定位仓库内置资源，readFileSync 同步解码后解析。
		const darkTheme = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
		) as ThemeFile;
		// 浅展开保留有效配色，仅覆盖 name；嵌套 colors/vars 仍是模板对象的原引用。
		const customTheme: ThemeFile = {
			...darkTheme,
			name: "bar",
		};

		// ! 是非空断言，依据 beforeEach 已设变量；运行时不会自动验证该值。
		const themePath = join(process.env.PI_CODING_AGENT_DIR!, "themes", "foo.json");
		// 把对象格式化成 JSON 字符串写到 foo.json，实际内容名仍为 bar。
		writeFileSync(themePath, JSON.stringify(customTheme, null, 2));

		// 名称列表包含 JSON.name。
		expect(getAvailableThemes()).toContain("bar");
		// 文件基名不应变成主题名称。
		expect(getAvailableThemes()).not.toContain("foo");
		// 带路径列表还应把 bar 关联到实际 foo.json 路径，深比较只查其中一项。
		expect(getAvailableThemesWithPaths()).toContainEqual({ name: "bar", path: themePath });
		// some 箭头回调遍历每项，只要存在 foo 就返回 true；本例要求不存在。
		expect(getAvailableThemesWithPaths().some((theme) => theme.name === "foo")).toBe(false);
	});
});
