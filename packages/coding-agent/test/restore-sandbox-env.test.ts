// 验证Bun空环境修复的三个分支，mock文件读取并临时替换versions/env，不读真实/proc记录。
// 这些环境变化只在测试进程中；原用例在正常末尾恢复而非finally，断言/调用异常会跳过后续还原。
import { describe, expect, it, vi } from "vitest";

// vi.fn造可观察的readFileSync假函数，默认不真正接触文件系统。
const readFileSync = vi.fn();

// 注册node:fs模块mock，返回下面最小接口；实际restore模块导入会取这个假读取。
vi.mock("node:fs", () => ({
	// 对象属性简写，等价readFileSync:readFileSync，不在建表时执行它。
	readFileSync,
}));

// 保留原动态import：先安装mock再加载待测函数；顶层await等待模块求值，解构取函数但尚未调用。
const { restoreSandboxEnv } = await import("../src/bun/restore-sandbox-env.ts");

// 三例只覆盖非Bun/已有env/空env成功恢复，不覆盖/proc读取异常或部分赋值失败。
describe("restoreSandboxEnv", () => {
	// 无bun标识时环境完全不变；构造Node版本视图，不真的切换运行时。
	it("does nothing when not running under bun", () => {
		// 保存process.versions属性完整描述符，以便恢复value/可配置等属性。
		const originalVersions = Object.getOwnPropertyDescriptor(process, "versions");
		// 临时换versions属性的值，原描述符若不可配置会抛，测试没有catch。
		Object.defineProperty(process, "versions", {
			// 仅有node字段，待测函数应在bun判断早返。
			value: { node: "20.0.0" },
		});
		// 浅拷贝当前env作内容比较，不输出或持久化其中的值。
		const envBefore = { ...process.env };

		// 调用真实恢复函数，此分支应不进入文件读取。
		restoreSandboxEnv();

		// 只断言env内容相等，未另外断言mock的调用次数为0。
		expect(process.env).toEqual(envBefore);

		// 只有成功取到旧描述符才恢复；不是finally路径。
		if (originalVersions) {
			// 恢复原描述符，避免影响后例Bun识别。
			Object.defineProperty(process, "versions", originalVersions);
		}
	});

	// 伪造Bun但故意保留至少一个环境键，验证整个恢复被跳过。
	it("does nothing when process.env already has entries", () => {
		// 另存本例开始时versions描述符。
		const originalVersions = Object.getOwnPropertyDescriptor(process, "versions");
		// 将版本视图改成含bun。
		Object.defineProperty(process, "versions", {
			// 字符串1.2.0只供真值识别，不实际运行该Bun版本。
			value: { bun: "1.2.0", node: "20.0.0" },
		});
		// 明确放一个自用环境键，使Object.keys(env).length>0。
		process.env.RESTORE_SANDBOX_ENV_TEST = "1";
		// 含自用键的环境快照，用于确认调用没改变内容。
		const envBefore = { ...process.env };

		// 真实函数应在已有env检查处早返。
		restoreSandboxEnv();

		// 比较内容，不单独验证fs假函数未调用。
		expect(process.env).toEqual(envBefore);
		// 删除本例自用键；若它原来已有值也不恢复该旧值，原测试假设此专用名未占用。
		delete process.env.RESTORE_SANDBOX_ENV_TEST;

		// 有旧描述符才正常尾部恢复。
		if (originalVersions) {
			// 重新放回原versions对象与属性特征。
			Object.defineProperty(process, "versions", originalVersions);
		}
	});

	// 模拟完全空env，再给假/proc两条NUL分隔记录；验证解析写回，不读操作系统原始环境。
	it("restores environment from /proc/self/environ when bun env is empty", () => {
		// 先保存versions便于正常结尾恢复。
		const originalVersions = Object.getOwnPropertyDescriptor(process, "versions");
		// 把process.versions换成含Bun的值。
		Object.defineProperty(process, "versions", {
			// bun字段非空就足够进入恢复条件，node字段仅样本背景。
			value: { bun: "1.2.0", node: "20.0.0" },
		});

		// Clear env to simulate the bun sandbox bug.
		// 内存保存完整env，后面还原；不把备份印出或写文件。
		const envBackup = { ...process.env };
		// Object.keys给当前自有环境键快照，for...of逐项清。
		for (const key of Object.keys(process.env)) {
			// delete真删除键，不能赋undefined替代，否则process.env可能存字符串。
			delete process.env[key];
		}

		// 假读返回FOO/BAZ与NUL分隔；不是用换行分隔，也未覆盖值含=等其他样本。
		readFileSync.mockReturnValue("FOO=bar\0BAZ=qux\0");

		// 真实解析函数见Bun+空env，使用上面mock字符串写env。
		restoreSandboxEnv();

		// 断言曾用精确路径/UTF-8参数调用假读取，不验证真实文件权限或内容。
		expect(readFileSync).toHaveBeenCalledWith("/proc/self/environ", "utf-8");
		// 解析第一条得到FOO=bar。
		expect(process.env.FOO).toBe("bar");
		// 解析第二条得到BAZ=qux；末尾空项应忽略。
		expect(process.env.BAZ).toBe("qux");

		// Restore.
		// 正常结尾先清掉此次恢复出的键，没有finally保证断言失败后仍执行。
		for (const key of Object.keys(process.env)) {
			// 逐个删本例当前env条目。
			delete process.env[key];
		}
		// Object.assign把原备份写回现有process.env对象，不替换对象引用。
		Object.assign(process.env, envBackup);

		// 恢复开始前的版本属性描述符。
		if (originalVersions) {
			// defineProperty还原原值与属性特征。
			Object.defineProperty(process, "versions", originalVersions);
		}
		// 清假读取调用记录/实现；前两例的mock是否完全独立不能仅靠此尾部reset推断。
		readFileSync.mockReset();
	});
});
