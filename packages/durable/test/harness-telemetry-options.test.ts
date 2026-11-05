// 验证 Harness 接受的遥测适配器类型；本文件不打开 Harness、不发请求，也不启动 span。
import { InMemoryTelemetryContext, NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { HarnessOptions } from "../src/harness/types.ts";

// describe 的回调只登记测试；类型断言还需 TypeScript 检查，Vitest 执行本身不代替类型检查。
describe("HarnessOptions.telemetry", () => {
	// 无参数用例：构造三种配置并检查引用/缺省值，再声明一个应被编译器拒绝的形状。
	// 例：{ telemetry: adapter } 可用，只有 counter 的对象缺少 startSpan；失败表现为断言或类型错误。
	it("accepts one adapter with optional propagation and metrics capabilities", () => {
		// 内存实现提供上下文、指标和传播能力；这里只实例化，不读取或上传遥测。
		const adapter = new InMemoryTelemetryContext();
		// Pick<T, K> 从 HarnessOptions 选出 telemetry 属性，仍保留该属性的可选性。
		const full: Pick<HarnessOptions, "telemetry"> = { telemetry: adapter };
		// 空实现也满足上下文契约；变量名强调调用方只依赖基础能力，并不证明此实例没有可选能力。
		const contextOnly: Pick<HarnessOptions, "telemetry"> = { telemetry: NOOP_TELEMETRY_CONTEXT };
		// telemetry 可省略；这是静态可赋值检查，不是在运行时验证任意外部对象。
		const omitted: Pick<HarnessOptions, "telemetry"> = {};
		// toBe 比较同一引用，证明配置没有在这里替换传入的实例。
		expect(full.telemetry).toBe(adapter);
		// 空实现同样原样保存在配置对象里。
		expect(contextOnly.telemetry).toBe(NOOP_TELEMETRY_CONTEXT);
		// 省略的属性读出来是 undefined；没有在这个配置对象上补默认值。
		expect(omitted.telemetry).toBeUndefined();
		// ?. 允许 telemetry 或 propagation 缺省；NonNullable 去掉 telemetry 类型中的 undefined。
		// toExtend 检查 inject 的函数签名或 undefined：返回 unknown 表示调用方不能假定载荷形状。
		expectTypeOf(full.telemetry?.propagation?.inject).toExtend<
			((context: NonNullable<HarnessOptions["telemetry"]>) => unknown) | undefined
		>();
		// 将非法示例放进不执行的函数，避免把它当成真正使用适配器的运行路径；返回值仅用于静态检查。
		const compileTimeFailures = () => {
			// bind 保留 counter 的 this，但这个对象仍没有必需的 startSpan；指令必须紧贴下一行。
			// @ts-expect-error telemetry requires the span-starting context capability
			const invalid: Pick<HarnessOptions, "telemetry"> = { telemetry: { counter: adapter.counter.bind(adapter) } };
			// 返回刻意不合法的配置；该函数不会被调用，因此没有运行时错误示范。
			return invalid;
		};
		// 这里只断言变量是函数，不调用它；@ts-expect-error 是否仍对应错误由统一类型检查确认。
		expectTypeOf(compileTimeFailures).toBeFunction();
	});
});
