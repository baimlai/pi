// 文件导读（Durable 测试工具层的对外入口）
//
// 所属模块：packages/durable/src/testing；package.json 的 "./testing" 子路径导出指向本文件。
// 上游：Durable 自身测试（packages/durable/test/*.test.ts）以及外部使用方；下游：同目录的断言
// 适配器、单批提交辅助、Storage 契约套件、ExecutionEnv 契约套件、runner 适配器和存储基准数据集。
//
// 职责边界：只做 re-export，不包含逻辑；不在此处注册测试、不创建存储、不执行 IO。
// 因此本文件可以被 Node、workerd 和浏览器测试代码共同导入，具体 runner 与后端由调用方提供。
//
// 能力清单（按导出分组）：
// - 断言：createExpectAssertions、ExpectLike —— 把 Vitest/Jest 风格的 expect 适配为契约套件断言。
// - 写入：commitWrites —— 用一次单批 Storage.commit 写入并取回序号。
// - 契约套件：createStorageConformance、createEnvConformance —— 生成 runner 无关的用例数组。
// - 注册器：registerStorageConformance、registerEnvConformance、StorageConformanceRunner ——
//   把用例注册到 describe/it/expect 风格的 runner。
// - 基准：STORAGE_MEMORY_SCALES、TIMING_SCALE、STORAGE_READ_BENCHMARKS、STORAGE_WRITE_BENCHMARKS、
//   seedStorageBenchmark、seedStorageWriteBenchmark、storageBenchmarkPrimaryRecordCount 及相关类型 ——
//   生成确定性数据并定义读写基准的期望值。
// - 类型：Storage/Env 契约用例、断言接口、基准数据集/规模/场景类型。
//
// 典型调用（Vitest）：
//   import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
//   registerStorageConformance({ describe, expect, it }, "MemoryStorage", (use) => use(new MemoryStorage()));
// 同一个入口也用于环境契约：
//   registerEnvConformance({ describe, expect, it }, "NodeExecutionEnv", (use) => use(new NodeExecutionEnv({ cwd })));
//
// 建议阅读顺序：types.ts（共享接口）→ assertions.ts / commit-writes.ts → storage-conformance.ts /
// env-conformance.ts → runner.ts → storage-benchmark.ts；本文件只是索引，可按分组跳转。
// 第 1 行：断言适配器与它的调用方 expect 类型；type 关键字让 ExpectLike 只存在于类型层。
export { createExpectAssertions, type ExpectLike } from "./assertions.ts";
// 单批提交辅助：把一条或多条写入作为一个批次提交，并返回回执序号。
export { commitWrites } from "./commit-writes.ts";
// 与环境无关的 ExecutionEnv 契约用例生成器；返回 name/run 列表，由 runner 注册。
export { createEnvConformance } from "./env-conformance.ts";
// runner 适配与用例提供者类型：把契约套件接入 describe/it/expect 风格的测试框架。
export { registerEnvConformance, registerStorageConformance, type StorageConformanceRunner } from "./runner.ts";
// 以下从 storage-benchmark.ts 导出基准规模、读写场景、seed 函数和类型；本文件只转发。
export {
	// STORAGE_MEMORY_SCALES：内存基准的两档规模（1k、10k 条目），任务和文档数量按比例缩放。
	STORAGE_MEMORY_SCALES,
	// STORAGE_READ_BENCHMARKS / STORAGE_WRITE_BENCHMARKS：读、写场景数组，每个场景自带期望值。
	// 基准脚本先验证 run() 等于 expected()，再交给 vitest bench 计时。
	STORAGE_READ_BENCHMARKS,
	STORAGE_WRITE_BENCHMARKS,
	// 基准数据集、规模、读场景、写场景的类型定义，供自定义场景或外部基准复用。
	type StorageBenchmarkDataset,
	type StorageBenchmarkScale,
	type StorageReadBenchmark,
	type StorageWriteBenchmark,
	// 两个 seed 函数分别准备读基准数据集和写基准的前置状态。
	seedStorageBenchmark,
	seedStorageWriteBenchmark,
	// storageBenchmarkPrimaryRecordCount：规模对应的主记录总数，便于报告或内存预算。
	storageBenchmarkPrimaryRecordCount,
	// TIMING_SCALE：未显式传规模时 seedStorageBenchmark 使用的 1k 条目/300 任务/300 文档规模。
	TIMING_SCALE,
} from "./storage-benchmark.ts";
// Storage 契约用例生成器；runner 适配器内部也使用它。
export { createStorageConformance } from "./storage-conformance.ts";
// 以下是纯类型导出，编译后从 JavaScript 中消失；它们描述断言接口、用例形状和 provider 契约。
// EnvConformanceAssertions 是 StorageConformanceAssertions 的别名，两种套件共用同一断言子集。
export type {
	EnvConformanceAssertions,
	EnvConformanceCase,
	EnvConformanceOptions,
	EnvConformanceProvider,
	StorageConformanceAssertions,
	StorageConformanceCase,
	StorageConformanceOptions,
	StorageConformanceProvider,
} from "./types.ts";
