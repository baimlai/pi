/**
 * 独立/testing子路径：导出通用适配器用例生成器及夹具类型，不把Node断言依赖带进普通telemetry根入口。
 * 例createTelemetryAdapterConformance(factory)先得到用例列表，再由调用方测试框架逐条执行run。
 */
// 运行值重导出生成器；此子路径会加载conformance的Node断言模块，但导入并不自动运行列表里的测试。
export { createTelemetryAdapterConformance } from "./conformance.ts";
// 下面整组export type编译后擦除，不为接口生成JS构造器。
export type {
	// 带group/name/run的一条兼容测试类型。
	TelemetryAdapterConformanceCase,
	// 单用例新建的adapter能力、规范快照读器及异步释放资源。
	TelemetryAdapterFixture,
	// 异步创建独立fixture的函数类型。
	TelemetryAdapterFixtureFactory,
} from "./types.ts";
