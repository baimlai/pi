// 文件导读（Durable 测试工具层：契约套件共享类型）
//
// 所属模块：packages/durable/src/testing；对外经 "./testing" 导出。
// 上游：assertions.ts（实现断言接口）、storage-conformance.ts / env-conformance.ts（消费选项并返回
// 用例）、runner.ts（注册用例）、测试文件（提供 withStorage/withEnv 与能力开关）。
// 下游类型：Storage（src/types.ts）与 ExecutionEnv（src/env/index.ts）。
//
// 职责边界：只声明形状，不含运行时代码（编译后只剩空模块）。它不校验调用方实现，
// 也不定义测试语义；语义在对应的 create*Conformance 中。
//
// 能力清单：
// - StorageConformanceAssertions：契约套件可用的断言子集（ok/strictEqual/deepEqual/
//   partialDeepEqual/greaterThan/rejects）。
// - StorageConformanceProvider：为每个用例提供一个新 Storage 并负责清理。
// - StorageConformanceOptions：断言实现 + provider。
// - StorageConformanceCase：runner 无关的单条用例（name/run）。
// - EnvConformanceAssertions：等同 StorageConformanceAssertions 的别名。
// - EnvConformanceProvider：提供 cwd 为全新空可写目录的 ExecutionEnv。
// - EnvConformanceOptions：断言、provider 与可选能力开关（shell/symlinks/listFiles）。
// - EnvConformanceCase：带可选 timeoutMs 的单条用例。
//
// 组合关系：createStorageConformance(options) 返回 StorageConformanceCase[]；
// createEnvConformance(options) 返回 EnvConformanceCase[]；runner 再把它们注册到 it。
// 例子（类型层面）：
//   const provider: StorageConformanceProvider = (use) => use(new MemoryStorage());
//   const options: StorageConformanceOptions = { assertions: createExpectAssertions(expect), withStorage: provider };
//
// 建议阅读顺序：StorageConformanceAssertions → StorageConformanceProvider/Options/Case →
// EnvConformance*；可选字段的默认值在 env-conformance.ts 的 createEnvConformance 中。
// 仅类型导入：这些接口只用于声明，不会在运行时加载 env 或存储实现。
import type { ExecutionEnv } from "../env/index.ts";
import type { Storage } from "../types.ts";

// 契约套件能使用的断言子集。方法名刻意不等于 vitest 的 expect 链式 API，
// 以便 assertions.ts 统一适配不同 runner。
// ok：值为真值；strictEqual：严格同一；deepEqual：递归结构相等；
// partialDeepEqual：期望对象是实际值的子集；greaterThan：数值大小；
// rejects：operation 必须拒绝，且错误消息包含 messageIncludes。
// 接口方法没有 readonly 修饰，因为实现方可以自由选择对象方法；调用方只读使用。
export interface StorageConformanceAssertions {
	ok(value: unknown, message?: string): void;
	strictEqual(actual: unknown, expected: unknown): void;
	deepEqual(actual: unknown, expected: unknown): void;
	partialDeepEqual(actual: unknown, expected: unknown): void;
	greaterThan(actual: number, expected: number): void;
	rejects(operation: Promise<unknown>, messageIncludes: string): Promise<void>;
}

// 为一条用例准备 Storage。契约要求：对每次 use 调用恰好一次，传入一个全新存储；
// use 返回的 Promise 完成后才能清理（通常是 close + 删除临时目录）。
// 若 provider 调用 use 零次或多次，用例会挂起或重复执行——这是运行期契约，类型无法表达。
export type StorageConformanceProvider = (use: (storage: Storage) => Promise<void>) => Promise<void>;

// Storage 契约套件的输入：断言实现与存储 provider；两个字段都 readonly，避免套件运行中替换。
export interface StorageConformanceOptions {
	readonly assertions: StorageConformanceAssertions;
	readonly withStorage: StorageConformanceProvider;
}

// 单条契约用例：name 作为 it 的标题，run 是真正的测试体。
// run 返回 Promise<void>，失败通过 rejection 交给 runner。
export interface StorageConformanceCase {
	readonly name: string;
	run(): Promise<void>;
}

// 环境套件与存储套件使用同一组断言能力；别名让签名更贴近 Env 语义。
export type EnvConformanceAssertions = StorageConformanceAssertions;

// 为一条环境用例准备 ExecutionEnv。
// 运行期契约：cwd 必须是全新、空、可写的目录；use 返回后 provider 负责清理。
// 套件中的相对路径（如 data.txt、AGENTS.md）都相对于这个 cwd。
/** Calls `use` once with an environment whose `cwd` is a fresh, empty, writable directory, then cleans up. */
export type EnvConformanceProvider = (use: (env: ExecutionEnv) => Promise<void>) => Promise<void>;

// 环境套件的输入：断言实现、环境 provider，以及三个可选能力开关。
export interface EnvConformanceOptions {
	readonly assertions: EnvConformanceAssertions;
	readonly withEnv: EnvConformanceProvider;
	// shell 是"程序 + 参数"数组，用来启动 POSIX shell 执行脚本；默认 ["sh", "-c"]。
	// 例如 Windows 上调用方可以传 [gitBash, "-c"]。
	/** Program and flag that run a POSIX shell script from the next argument; default `["sh", "-c"]`. */
	readonly shell?: readonly string[];
	// symlinks 表示该环境的 shell 能否用 ln -s 创建真正的符号链接；默认 true。
	// 为 false 时套件跳过符号链接相关的 listFiles、reader 和 watch 用例。
	/** Whether the shell's `ln -s` creates symbolic links; default true. */
	readonly symlinks?: boolean;
	// listFiles 表示环境是否实现可选的 FileSystem.listFiles；默认 false。
	// 未实现时套件不注册 listFiles 用例，避免把可选能力当成必选能力。
	/** Whether the environment implements the optional `listFiles`, which the suite then checks; default false. */
	readonly listFiles?: boolean;
}

// 环境用例比存储用例多一个可选超时：watch 用例要等待文件系统通知，可能超过
// runner 的默认超时；run 仍然无参并返回 Promise。
export interface EnvConformanceCase {
	readonly name: string;
	// 只有 watch 类用例会设置 timeoutMs；其他用例省略该字段，使用 runner 默认值。
	/** Cases that wait for an environment's watch latency need longer than a test runner's default timeout. */
	readonly timeoutMs?: number;
	run(): Promise<void>;
}
