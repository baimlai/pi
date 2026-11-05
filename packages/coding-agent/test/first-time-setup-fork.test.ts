// 模拟派生发行版的包名，核对官方首次设置流程被跳过；临时目录不触及用户已有设置。
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 模块 mock 工厂先取真实配置再覆盖包名；只改变测试模块视图，不改 package.json。
// async 回调无显式返回类型，TS 从对象推断；失败的导入会拒绝，未在这里吞异常。
vi.mock("../src/config.ts", async (importOriginal) => {
	// await 获取原导出，避免其他启动 UI 依赖的配置函数也被无意抹掉。
	const actual = await importOriginal();
	// Record<string, unknown> 是字符串键字典断言，仅允许展开未知模块对象，不验证其运行时形状。
	return {
		...(actual as Record<string, unknown>),
		// 同名后写字段覆盖原值，使 isOfficialDistribution 的包名条件不成立。
		PACKAGE_NAME: "@example/pi-coding-agent",
	};
});

// Vitest 会提升 vi.mock，因此静态 import 实际看到的是上面覆盖后的配置。
import { shouldRunFirstTimeSetup } from "../src/cli/startup-ui.ts";

// 注册准备/清理钩子和一个判断测试；不会真正显示设置对话框或执行认证。
describe("shouldRunFirstTimeSetup in forked distributions", () => {
	// 保存原开关，保持测试结束后进程环境可恢复。
	const originalPiExperimental = process.env.PI_EXPERIMENTAL;
	// let 允许 beforeEach 给这两个字符串重新赋值，冒号是开发期类型注解。
	let tempDir: string;
	let settingsPath: string;

	// 每例创建独立空目录并开启实验特性；settingsPath 只计算路径，尚未创建 settings.json。
	beforeEach(() => {
		// mkdtempSync 在系统临时目录下附加随机后缀，创建真实但隔离的测试目录。
		tempDir = mkdtempSync(join(tmpdir(), "pi-first-time-setup-fork-"));
		// join 使用宿主平台的路径分隔符。
		settingsPath = join(tempDir, "settings.json");
		// 排除“实验特性未开”这个原因，聚焦派生包判断。
		process.env.PI_EXPERIMENTAL = "1";
	});

	// 删除本例临时目录并恢复开关；这里按顺序执行，rmSync 若异常则后续恢复不会自动继续。
	afterEach(() => {
		// recursive 删除自建目录树，force 允许路径已经不存在。
		rmSync(tempDir, { recursive: true, force: true });
		// 原本没有此变量时恢复为缺失，而非赋 undefined 字符串。
		if (originalPiExperimental === undefined) {
			// 删除测试写入的值。
			delete process.env.PI_EXPERIMENTAL;
		} else {
			// 原来存在就恢复原字符串。
			process.env.PI_EXPERIMENTAL = originalPiExperimental;
		}
	});

	// 传入不存在的设置路径仍应 false；实现先判断官方发行配置，未测试文件存在性分支。
	it("returns false for a forked package", () => {
		// 此断言只验证布尔结果，没有直接断言 existsSync 的调用次数。
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});
});
