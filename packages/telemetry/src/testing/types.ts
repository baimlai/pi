/**
 * 遥测适配器兼容性测试的夹具/用例接口，供不同测试框架复用；类型不会自动启动记录器或运行测试。
 * 例factory每次创建独立InMemoryTelemetryContext，getSpans取规范快照，await using退出时调用异步清理。
 */
// 三种可选/必需运行能力的类型，导入擦除，不建立全局current-span。
import type { TelemetryContext, TelemetryMetrics, TelemetryPropagation } from "../index.ts";
// 测试比较的规范记录快照类型，不要求适配器使用同一内部存储结构。
import type { RecordedTelemetryMeasurement, RecordedTelemetrySpan } from "../memory.ts";

/** A fresh adapter instance and normalized snapshot reader owned by one conformance case. */
// fixture是单用例拥有的新adapter资源；extends AsyncDisposable要求Symbol.asyncDispose，await using在作用域结束异步释放，TS接口本身不执行清理。
export interface TelemetryAdapterFixture extends AsyncDisposable {
	// 必需的span启动上下文。
	readonly context: TelemetryContext;
	// 可选传播测试能力；不提供时相关兼容用例可跳过该能力检查。
	readonly propagation?: TelemetryPropagation;
	// 可选指标测试能力。
	readonly metrics?: TelemetryMetrics;
	// 提供metrics时用例要求此快照读取器，Promise允许后端先flush；仅类型上仍可选，不代表每种组合都符合测试政策。
	getMetrics?(): Promise<readonly RecordedTelemetryMeasurement[]>;
	// 必需的规范span快照读取器，允许异步导出后再读，不把真实backend结构泄露给通用比较器。
	getSpans(): Promise<readonly RecordedTelemetrySpan[]>;
}

/** Creates an isolated adapter fixture for one conformance case. */
// 工厂无参数、每次返回Promise夹具，例()=>Promise.resolve(fixture)；独立性由实现负责，不由类型自动证明。
export type TelemetryAdapterFixtureFactory = () => Promise<TelemetryAdapterFixture>;

/** A runner-independent conformance case that can be registered with any test framework. */
// 一条框架无关测试，只提供分组、名字与可执行run，调用者把它注册到vitest/node:test等；尚未调用run时不执行测试。
export interface TelemetryAdapterConformanceCase {
	// 分组名供describe等组织。
	readonly group: string;
	// 用例可读名称。
	readonly name: string;
	// run异步返回void，断言失败/adapter错误以拒绝传播，不是返回布尔通过标志。
	run(): Promise<void>;
}
