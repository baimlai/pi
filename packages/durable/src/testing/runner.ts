// 文件导读（Durable 测试工具层：测试 runner 适配）
//
// 所属模块：packages/durable/src/testing；对外经 "./testing" 导出。
// 上游：测试文件把 Vitest/Jest 风格的 { describe, expect, it } 传进来；下游：storage-conformance.ts
// 与 env-conformance.ts 生成用例，assertions.ts 适配 expect。
//
// 职责边界：只负责"注册"用例，不执行断言逻辑，也不创建存储/环境；withStorage/withEnv 由调用方
// 提供，负责为每个用例准备并清理资源。它不依赖 vitest 包本身，所以同一套契约可在其他 runner 复用。
//
// 能力清单：
// - StorageConformanceRunner：注册器需要的最小 runner 形状（describe/expect/it，it 支持可选超时）。
// - registerStorageConformance：生成并注册 Storage 契约用例。
// - registerEnvConformance：生成并注册 ExecutionEnv 契约用例，可传入 shell/symlinks/listFiles 能力开关。
//
// 组合关系：register* → create*Conformance（生成 name/run 列表）→ runner.describe(name, () => 逐个 it)。
// 例子：
//   registerStorageConformance({ describe, expect, it }, "MemoryStorage", (use) => use(new MemoryStorage()));
//   registerEnvConformance({ describe, expect, it }, "NodeExecutionEnv", async (use) => {
//     const cwd = mkdtempSync(join(tmpdir(), "env-"));
//     try { await use(new NodeExecutionEnv({ cwd })); } finally { rmSync(cwd, { recursive: true, force: true }); }
//   });
//
// 建议阅读顺序：先看 StorageConformanceRunner 接口 → registerStorageConformance → registerEnvConformance。
import { createExpectAssertions, type ExpectLike } from "./assertions.ts";
import { createEnvConformance } from "./env-conformance.ts";
import { createStorageConformance } from "./storage-conformance.ts";
import type { EnvConformanceOptions, EnvConformanceProvider, StorageConformanceProvider } from "./types.ts";

// runner 的最小接口：契约套件只依赖这三个成员，因此任何提供同名函数的测试框架都能接入。
// describe(name, suite) 负责分组；expect 用于生成断言；it(name, test, timeoutMs?) 注册单条用例。
// 返回类型写成 unknown，因为 vitest/jest 的 describe/it 返回对象各不相同，这里不需要消费。
export interface StorageConformanceRunner {
	// describe 接收同步回调；契约套件在回调里一次性注册全部 it。
	readonly describe: (name: string, suite: () => void) => unknown;
	// expect 的调用形状由 ExpectLike 约束，随后交给 createExpectAssertions 适配。
	readonly expect: ExpectLike;
	// it 的 test 回调返回 Promise；可选 timeoutMs 供 watch 等慢用例覆盖 runner 默认超时。
	readonly it: (name: string, test: () => Promise<void>, timeoutMs?: number) => unknown;
}

// 生成并注册 Storage 契约用例。
// 输入：runner（describe/expect/it）、name（describe 分组名）、withStorage（每个用例创建/清理存储）。
// 输出：无；副作用是向 runner 注册若干 it。
// 错误：createStorageConformance 只构造用例，不执行；每个用例的错误由 runner 捕获并报告。
// 主流程：适配 expect → 生成用例数组 → 在 describe 中逐条注册为 it。
// 例子：registerStorageConformance({ describe, expect, it }, "MemoryStorage", (use) => use(new MemoryStorage()));
/** Registers the runner-independent cases with a Vitest/Jest-compatible test runner. */
export function registerStorageConformance(
	runner: StorageConformanceRunner,
	name: string,
	withStorage: StorageConformanceProvider,
): void {
	// createStorageConformance 返回 runner 无关的 { name, run } 数组；
	// assertions 负责断言实现，withStorage 负责为每条用例提供全新的 Storage。
	const cases = createStorageConformance({
		assertions: createExpectAssertions(runner.expect),
		withStorage,
	});
	// describe 的回调是同步执行的；it 只登记回调，真正运行由 runner 决定。
	// testCase.run 是无参函数，直接作为 it 的测试体传入即可。
	runner.describe(name, () => {
		for (const testCase of cases) runner.it(testCase.name, testCase.run);
	});
}

// 生成并注册 ExecutionEnv 契约用例。
// 输入：runner、name、withEnv（提供 cwd 为全新空可写目录的环境并清理）、
// options 只暴露能力开关 shell/symlinks/listFiles。
// 输出：无；副作用是注册若干 it。
// 错误：用例运行时的断言错误由 runner 捕获；withEnv 自身的创建/清理错误会冒泡给 runner。
// 主流程：合并默认选项 → 生成用例 → 在 describe 中逐条注册（带可选 timeoutMs）。
// 例子：registerEnvConformance({ describe, expect, it }, "NodeExecutionEnv", provider, { symlinks: false });
/** Registers the runner-independent `ExecutionEnv` cases with a Vitest/Jest-compatible test runner. */
export function registerEnvConformance(
	runner: StorageConformanceRunner,
	name: string,
	withEnv: EnvConformanceProvider,
	// 默认参数 {}；Pick<EnvConformanceOptions, "shell" | "symlinks" | "listFiles"> 是编译期限制，
	// 调用方不能在这里传 assertions 或 withEnv——它们由本函数填充。
	// 三个字段都可省略，createEnvConformance 内部再给 shell/symlinks/listFiles 默认值。
	options: Pick<EnvConformanceOptions, "shell" | "symlinks" | "listFiles"> = {},
): void {
	// 对象展开把 shell/symlinks/listFiles 放进来，后面的 assertions/withEnv 覆盖同名键（本来也不允许传）。
	// 这样注册器只关心"能力开关"，断言适配和 provider 的连接统一在这里完成。
	const cases = createEnvConformance({ ...options, assertions: createExpectAssertions(runner.expect), withEnv });
	runner.describe(name, () => {
		// 把用例的可选超时继续传给 it；不支持第三参数的 runner 可以忽略它。
		for (const testCase of cases) runner.it(testCase.name, testCase.run, testCase.timeoutMs);
	});
}
